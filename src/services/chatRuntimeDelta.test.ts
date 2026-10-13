import { describe, expect, it } from 'vitest';
import type { RuntimeEventV2, RelationshipLedgerEntry } from '../types/runtimeEvent';
import { applyRuntimeEventsDelta, applyRelationshipLedgerDelta } from './chatRuntimeDelta';

function event(id: string, createdAt: number): RuntimeEventV2 {
  return { id, createdAt, conversationId: 'room', kind: 'message_generated', summary: id, payload: {}, visibility: 'public' };
}

function pair(pairKey: string): RelationshipLedgerEntry {
  return {
    pairKey, actorId: 'a', targetId: pairKey,
    current: { warmth: 0, competence: 0, trust: 0, threat: 0 }, derived: {}, axisReasons: {},
    trend: 'stable', recentEvents: [], lastUpdatedAt: 1,
  };
}

describe('chat runtime delta', () => {
  it('prunes baseline history while preserving concurrent additions in chronological order', () => {
    const old = event('old', 1);
    const kept = event('kept', 2);
    const social = event('social', 3);
    const generated = event('generated', 4);
    expect(applyRuntimeEventsDelta([old, kept, social], {
      baseIds: ['old', 'kept'], orderedIds: ['kept', 'generated'], upserts: [generated],
    })).toEqual([kept, social, generated]);
  });

  it('does not revive a deleted baseline event when it has no upsert', () => {
    const generated = event('generated', 4);
    expect(applyRuntimeEventsDelta([], {
      baseIds: ['removed'], orderedIds: ['removed', 'generated'], upserts: [generated],
    })).toEqual([generated]);
  });

  it('preserves a newer current version of an unchanged baseline event', () => {
    const current = { ...event('kept', 2), summary: 'updated by another writer' };
    const generated = event('generated', 4);
    expect(applyRuntimeEventsDelta([current], {
      baseIds: ['kept'], orderedIds: ['kept', 'generated'], upserts: [generated],
    })).toEqual([current, generated]);
  });

  it('keeps the replacement and ordering contract of legacy deltas', () => {
    const first = event('first', 1);
    const second = event('second', 2);
    expect(applyRuntimeEventsDelta([first, second, event('other', 3)], {
      orderedIds: ['second', 'first'], upserts: [],
    })).toEqual([second, first]);
    expect(applyRuntimeEventsDelta([first], { orderedIds: [], upserts: [] })).toEqual([]);
    expect(applyRelationshipLedgerDelta([pair('a->b')], { orderedPairKeys: [], upserts: [] })).toEqual([]);
  });

  it('applies intentional ledger removals while preserving newly added pairs', () => {
    const kept = pair('a->b');
    const removed = pair('a->c');
    const concurrent = pair('b->c');
    expect(applyRelationshipLedgerDelta([kept, removed, concurrent], {
      basePairKeys: [kept.pairKey, removed.pairKey], orderedPairKeys: [kept.pairKey], upserts: [],
    })).toEqual([kept, concurrent]);
  });
});
