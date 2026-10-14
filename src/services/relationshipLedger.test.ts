import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractionEventPayload, RelationshipLedgerEntry, RuntimeEventV2 } from '../types/runtimeEvent';
import type { AICharacter } from '../types/character';
import { RELATIONSHIP_BASELINE, normalizeRelationshipLedgerEntry, refreshRelationshipLedgerBaselines, reduceRelationshipLedger, reduceRelationshipLedgerWithDelta, replayRelationshipLedger } from './relationshipLedger';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

function buildEvent(interaction: InteractionEventPayload): RuntimeEventV2 {
  return {
    id: `evt-${interaction.actorId}-${interaction.targetId}`,
    conversationId: 'chat-1',
    kind: 'interaction',
    createdAt: Date.now(),
    actorIds: [interaction.actorId],
    targetIds: interaction.targetId ? [interaction.targetId] : undefined,
    summary: interaction.evidenceText,
    visibility: 'public',
    payload: interaction,
  };
}

describe('relationshipLedger', () => {
  it('rebases room baselines onto global defaults while preserving runtime adjustments', () => {
    const ledger = [{
      pairKey: 'a->b', actorId: 'a', targetId: 'b',
      baseline: { warmth: 1, competence: 0, trust: 1, threat: 0, attachment: 0, deference: 0 },
      adjustment: { warmth: 3, competence: 0, trust: -1, threat: 0, attachment: 0, deference: 0 },
      current: { warmth: 4, competence: 0, trust: 0, threat: 0, attachment: 0, deference: 0 },
      trend: 'up' as const, recentEvents: [], lastUpdatedAt: 1,
    }];
    const characters = [{ id: 'a', relationships: [{ characterId: 'b', warmth: 42, competence: 18, trust: 24, threat: 5, attachment: 12, deference: 8 }] }, { id: 'b', relationships: [] }] as unknown as AICharacter[];
    const refreshed = refreshRelationshipLedgerBaselines(ledger, characters, ['a', 'b'], 10);
    expect(refreshed[0]).toMatchObject({ baseline: { warmth: 42, competence: 18, trust: 24 }, adjustment: { warmth: 0, trust: 0 }, current: { warmth: 42, trust: 24 }, lastUpdatedAt: 10 });
  });

  it('tracks trust and tension for meaningful interactions', () => {
    const interaction: InteractionEventPayload = {
      kind: 'support',
      actorId: 'a',
      targetId: 'b',
      intensity: 4,
      tone: 'warm',
      evidenceText: '我支持你刚才那个更具体的方案。',
      confidence: 0.92,
      relationship: { delta: { warmth: 5, competence: 1, trust: 5, threat: 0 }, stance: '明确支持' },
    };

    const result = reduceRelationshipLedger([], interaction, buildEvent(interaction));
    expect(result).toHaveLength(1);
    expect(result[0].current.warmth).toBe(5);
    expect(result[0].current.competence).toBe(1);
    expect(result[0].current.trust).toBeGreaterThanOrEqual(5);
    expect(result[0].current.threat).toBe(0);
  });

  it('uses a model-authored relationship assessment instead of the interaction-kind score mapping', () => {
    const interaction: InteractionEventPayload = {
      kind: 'support',
      actorId: 'a',
      targetId: 'b',
      intensity: 4,
      tone: 'warm',
      evidenceText: '我愿意帮你，但这件事得先把界限说清楚。',
      confidence: 0.94,
      relationship: {
        delta: { warmth: 1, competence: 2, trust: -2, threat: 3 },
        labels: ['愿意协助但保持戒备'],
        stance: '提供帮助，同时收紧信任边界',
      },
    };

    const result = reduceRelationshipLedger([], interaction, buildEvent(interaction));
    expect(result[0].current).toEqual({ warmth: 1, competence: 2, trust: -2, threat: 3, attachment: 0, deference: 0 });
    expect(result[0].baseline).toEqual({ warmth: 0, competence: 0, trust: 0, threat: 0, attachment: 0, deference: 0 });
    expect(result[0].adjustment).toEqual({ warmth: 1, competence: 2, trust: -2, threat: 3, attachment: 0, deference: 0 });
    expect(result[0].derived?.semantic?.labels).toEqual(['愿意协助但保持戒备']);
    expect(result[0].derived?.semantic?.summary).toBe('提供帮助，同时收紧信任边界');
  });

  it('starts new runtime ledger entries from the shared neutral baseline', () => {
    const interaction: InteractionEventPayload = {
      kind: 'challenge',
      actorId: 'a',
      targetId: 'b',
      intensity: 3,
      tone: 'cold',
      evidenceText: '这个推断我不同意，证据还不够。',
      confidence: 0.9,
      relationship: { delta: { warmth: 0, competence: 1, trust: -1, threat: 4 }, stance: '质疑证据' },
    };

    const result = reduceRelationshipLedger([], interaction, buildEvent(interaction));
    expect(result[0].current.warmth).toBe(0);
    expect(result[0].current.competence).toBe(1);
    expect(result[0].current.threat).toBe(4);
    expect(result[0].current.trust).toBe(-1);
  });

  it('preserves room adjustment when the relationship baseline is replaced', () => {
    const event = buildEvent({ actorId: 'a', targetId: 'b' } as InteractionEventPayload);
    const initial = reduceRelationshipLedgerWithDelta([{
      pairKey: 'a->b', actorId: 'a', targetId: 'b',
      baseline: { warmth: 30, competence: 0, trust: 20, threat: 0, attachment: 10, deference: 0 },
      adjustment: { warmth: 5, competence: 0, trust: -2, threat: 0, attachment: 0, deference: 0 },
      current: { warmth: 35, competence: 0, trust: 18, threat: 0, attachment: 10, deference: 0 },
      derived: {}, axisReasons: {}, trend: 'flat', recentEvents: [], lastUpdatedAt: 1,
    }], { actorId: 'a', targetId: 'b', delta: { warmth: 0 }, reason: 'keep' }, event)[0];

    expect(initial.adjustment?.warmth).toBe(5);
    expect(initial.current.warmth).toBe(35);
  });

  it('normalizes legacy zero-based runtime entries before applying new deltas', () => {
    const interaction: InteractionEventPayload = {
      kind: 'support',
      actorId: 'a',
      targetId: 'b',
      intensity: 3,
      tone: 'warm',
      evidenceText: '这个方向我支持，继续往下拆。',
      confidence: 0.94,
      relationship: { delta: { warmth: 4, competence: 1, trust: 4, threat: 0 }, stance: '支持推进' },
    };

    const result = reduceRelationshipLedger([{
      pairKey: 'a->b',
      actorId: 'a',
      targetId: 'b',
      current: { warmth: 0, competence: 0, trust: 0, threat: 0 },
      trend: 'flat',
      recentEvents: [],
      lastUpdatedAt: 1,
    }], interaction, buildEvent(interaction));

    expect(result[0].current.warmth).toBe(4);
    expect(result[0].current.competence).toBe(1);
    expect(result[0].current.trust).toBe(4);
  });

  it('rejects weak or low-confidence interactions', () => {
    const interaction: InteractionEventPayload = {
      kind: 'support',
      actorId: 'a',
      targetId: 'b',
      intensity: 1,
      tone: 'warm',
      evidenceText: '行。',
      confidence: 0.4,
    };

    const result = reduceRelationshipLedger([], interaction, buildEvent(interaction));
    expect(result).toEqual([]);
  });

  it('replays ledger deterministically from interaction history', () => {
    const first: InteractionEventPayload = {
      kind: 'support', actorId: 'a', targetId: 'b', intensity: 4, tone: 'warm', evidenceText: '这个点我站你。', confidence: 0.93, relationship: { delta: { warmth: 3, trust: 3, competence: 0, threat: 0 }, stance: '站在对方一边' },
    };
    const second: InteractionEventPayload = {
      kind: 'challenge', actorId: 'a', targetId: 'b', intensity: 4, tone: 'annoyed', evidenceText: '但你后面这句我不同意。', confidence: 0.91, relationship: { delta: { warmth: 0, competence: 0, trust: -2, threat: 3 }, stance: '提出反对' },
    };

    const replayed = replayRelationshipLedger([
      { interaction: first, event: buildEvent(first) },
      { interaction: second, event: buildEvent(second) },
    ]);

    expect(replayed).toHaveLength(1);
    expect(replayed[0].current.threat).toBeGreaterThan(0);
    expect(['down', 'volatile']).toContain(replayed[0].trend);
  });

  it('stores only lightweight recent event snapshots in relationship ledger', () => {
    const interaction: InteractionEventPayload = {
      kind: 'challenge',
      actorId: 'a',
      targetId: 'b',
      intensity: 4,
      tone: 'annoyed',
      evidenceText: '你这句我不同意，而且理由站不住。',
      confidence: 0.93,
      relationship: { delta: { warmth: 0, competence: 0, trust: -2, threat: 4 }, stance: '认为理由站不住' },
    };

    const heavyEvent: RuntimeEventV2 = {
      ...buildEvent(interaction),
      payload: {
        ...interaction,
        giant: 'x'.repeat(50_000),
      },
    };

    const result = reduceRelationshipLedger([], interaction, heavyEvent);
    const recentEvent = result[0]?.recentEvents[0];
    expect(recentEvent).toEqual({
      id: heavyEvent.id,
      kind: heavyEvent.kind,
      createdAt: heavyEvent.createdAt,
      summary: heavyEvent.summary,
      actorIds: heavyEvent.actorIds,
      targetIds: heavyEvent.targetIds,
    });
    expect(JSON.stringify(recentEvent).length).toBeLessThan(500);
  });

  it('dedupes repeated evidence events with the same event id', () => {
    const interaction: InteractionEventPayload = {
      kind: 'challenge',
      actorId: 'a',
      targetId: 'b',
      intensity: 4,
      tone: 'annoyed',
      evidenceText: '你这句我不同意，而且理由站不住。',
      confidence: 0.93,
      relationship: { delta: { warmth: 0, competence: 0, trust: -2, threat: 4 }, stance: '认为理由站不住' },
    };
    const event = buildEvent(interaction);
    const first = reduceRelationshipLedger([], interaction, event);
    const second = reduceRelationshipLedger(first, interaction, event);
    expect(second).toHaveLength(1);
    expect(second[0].recentEvents).toHaveLength(1);
    expect(second[0].current).toEqual(first[0].current);
  });

  it('derives human-readable relationship semantics from relationship axes', () => {
    const normalized = normalizeRelationshipLedgerEntry({
      pairKey: 'a->b',
      actorId: 'a',
      targetId: 'b',
      current: { warmth: 48, competence: 12, trust: 42, threat: 8 },
      trend: 'up',
      recentEvents: [],
      lastUpdatedAt: 1,
    });

    expect(normalized.derived?.semantic?.stage).toBe('深度绑定');
    expect(normalized.derived?.semantic?.labels).toEqual(expect.arrayContaining(['亲密', '喜欢']));
  });

  it('fills collection and metadata fields missing from legacy ledger entries', () => {
    const normalized = normalizeRelationshipLedgerEntry({
      pairKey: 'a->b',
      actorId: 'a',
      targetId: 'b',
      current: { warmth: 12, competence: 8, trust: 6, threat: 2 },
    } as unknown as RelationshipLedgerEntry);

    expect(normalized.recentEvents).toEqual([]);
    expect(normalized.axisReasons).toEqual({});
    expect(normalized.trend).toBe('flat');
    expect(normalized.lastUpdatedAt).toBe(0);
  });

  it('marks tense mixed relationships as complex instead of only negative numbers', () => {
    const normalized = normalizeRelationshipLedgerEntry({
      pairKey: 'a->b',
      actorId: 'a',
      targetId: 'b',
      current: { warmth: 30, competence: 28, trust: 8, threat: 42 },
      trend: 'volatile',
      recentEvents: [],
      lastUpdatedAt: 1,
    });

    expect(normalized.derived?.semantic?.stage).toBe('复杂拉扯');
    expect(normalized.derived?.semantic?.labels).toEqual(expect.arrayContaining(['竞争心', '又在意又防备']));
  });
});
