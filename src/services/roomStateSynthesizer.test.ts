import { describe, expect, it } from 'vitest';
import type { InteractionEventPayload } from '../types/runtimeEvent';
import { calculateRoomShift, hasRoomShiftSignal } from './roomStateSynthesizer';

function buildInteraction(overrides: Partial<InteractionEventPayload> = {}): InteractionEventPayload {
  return {
    kind: 'challenge',
    actorId: 'a',
    targetId: 'b',
    intensity: 4,
    tone: 'annoyed',
    evidenceText: '你刚才那个判断前后矛盾。',
    confidence: 0.9,
    ...overrides,
  };
}

describe('roomStateSynthesizer', () => {
  it('does not treat an all-zero model delta as a room event', () => {
    const { shift } = calculateRoomShift(null, buildInteraction({
      kind: 'support',
      immediateImpact: { roomDelta: { heat: 0, cohesion: 0, topicDrift: 0 } },
    }), { semanticSource: 'model' });
    expect(hasRoomShiftSignal(shift)).toBe(false);
  });

  it('keeps a non-zero model delta as a room event', () => {
    const { shift } = calculateRoomShift(null, buildInteraction({
      immediateImpact: { roomDelta: { heat: 2, cohesion: 0, topicDrift: 0 } },
    }), { semanticSource: 'model' });
    expect(hasRoomShiftSignal(shift)).toBe(true);
  });

  it('does not passively decay model-authored state without a reported delta', () => {
    const current = {
      heat: 22,
      cohesion: 18,
      topicDrift: 9,
      dominantThread: null,
      alliances: [],
      conflictPairs: [],
      pileOnTarget: null,
      silencedActors: [],
    };
    const { nextState, shift } = calculateRoomShift(current, buildInteraction({
      immediateImpact: { roomDelta: { heat: 0, cohesion: 0, topicDrift: 0 } },
    }), { semanticSource: 'model' });
    expect(nextState).toMatchObject({ heat: 22, cohesion: 18, topicDrift: 9,
      alliances: [], conflictPairs: [], pileOnTarget: null, silencedActors: [] });
    expect(shift.delta).toEqual({ heat: 0, cohesion: 0, topicDrift: 0 });
  });

  it('tracks the dominant thread without treating every challenge as silencing', () => {
    const { nextState } = calculateRoomShift(null, buildInteraction());
    expect(nextState.dominantThread).toEqual(['a', 'b']);
    expect(nextState.silencedActors).not.toContain('b');
    expect(nextState.conflictPairs).toContainEqual(['a', 'b']);
  });

  it('reserves silenced actors for explicit dismissal, exclusion, or pile-on', () => {
    const dismissed = calculateRoomShift(null, buildInteraction({ kind: 'dismiss' })).nextState;
    expect(dismissed.silencedActors).toContain('b');

    const included = calculateRoomShift(dismissed, buildInteraction({ actorId: 'c', kind: 'include', tone: 'warm' })).nextState;
    expect(included.silencedActors).not.toContain('b');
  });

  it('tracks alliances for supportive interactions', () => {
    const { nextState } = calculateRoomShift(null, buildInteraction({ kind: 'support', tone: 'warm' }));
    expect(nextState.alliances).toContainEqual(['a', 'b']);
    expect(nextState.cohesion).toBeGreaterThan(0);
  });

  it('keeps pile-on target when conflicts continue', () => {
    const first = calculateRoomShift(null, buildInteraction({ kind: 'pile_on' })).nextState;
    const second = calculateRoomShift(first, buildInteraction({ actorId: 'c', kind: 'challenge' })).nextState;
    expect(second.pileOnTarget).toBe('b');
  });

  it('cools accumulated heat instead of pinning the room at 100 forever', () => {
    const calmTurn = calculateRoomShift({
      heat: 100,
      cohesion: 0,
      topicDrift: 0,
      dominantThread: null,
      alliances: [],
      conflictPairs: [],
      pileOnTarget: null,
      silencedActors: [],
    }, buildInteraction({ kind: 'side_comment', intensity: 1, targetId: undefined })).nextState;

    expect(calmTurn.heat).toBeLessThan(100);
  });

  it('lets topic drift rise on side comments and relax when the thread is engaged again', () => {
    const drifted = calculateRoomShift(null, buildInteraction({ kind: 'side_comment', targetId: undefined })).nextState;
    const engaged = calculateRoomShift(drifted, buildInteraction({ kind: 'support' })).nextState;

    expect(drifted.topicDrift).toBeGreaterThan(0);
    expect(engaged.topicDrift).toBeLessThan(drifted.topicDrift);
  });

  it('supports negative cohesion for divisive room states', () => {
    const { nextState } = calculateRoomShift(null, buildInteraction({ kind: 'challenge' }));
    expect(nextState.cohesion).toBeLessThan(0);
  });

  it('cools the room and restores cohesion after an apology', () => {
    const { nextState, shift } = calculateRoomShift({
      heat: 42,
      cohesion: -12,
      topicDrift: 0,
      dominantThread: ['a', 'b'],
      alliances: [],
      conflictPairs: [['a', 'b']],
      pileOnTarget: null,
      silencedActors: [],
    }, buildInteraction({ kind: 'apologize', tone: 'warm', intensity: 4 }));

    expect(nextState.heat).toBeLessThan(42);
    expect(nextState.cohesion).toBeGreaterThan(-12);
    expect(shift.delta?.heat).toBeLessThan(0);
    expect(shift.delta?.cohesion).toBeGreaterThan(0);
  });

  it('treats exclusion and boundaries as distinct room pressure', () => {
    const excluded = calculateRoomShift(null, buildInteraction({ kind: 'exclude', intensity: 4, tone: 'cold' }));
    const bounded = calculateRoomShift(null, buildInteraction({ kind: 'boundary', intensity: 4, tone: 'defensive' }));

    expect(excluded.nextState.heat).toBeGreaterThan(bounded.nextState.heat);
    expect(excluded.nextState.cohesion).toBeLessThan(bounded.nextState.cohesion);
    expect(excluded.nextState.conflictPairs).toContainEqual(['a', 'b']);
  });

  it('aggregates every directed interaction in one visible reply while cooling only once', () => {
    const { nextState, shift } = calculateRoomShift(null, [
      buildInteraction({ targetId: 'b', kind: 'boundary', intensity: 4, tone: 'defensive' }),
      buildInteraction({ targetId: 'c', kind: 'take_responsibility', intensity: 3, tone: 'warm' }),
    ]);

    expect(nextState.conflictPairs).toContainEqual(['a', 'b']);
    expect(nextState.alliances).toContainEqual(['a', 'c']);
    expect(shift.delta?.heat).toBeLessThanOrEqual(0);
    expect(shift.delta?.cohesion).toBeGreaterThan(0);
  });

  it('uses a later targeted interaction when the first interaction has no target', () => {
    const { nextState } = calculateRoomShift(null, [
      buildInteraction({ targetId: undefined, kind: 'side_comment', immediateImpact: { roomDelta: { heat: 3 } } }),
      buildInteraction({ actorId: 'c', targetId: 'd', kind: 'support', confidence: 0.8 }),
    ], { semanticSource: 'model' });

    expect(nextState.dominantThread).toEqual(['c', 'd']);
    expect(nextState.heat).toBe(3);
  });

  it('prefers the clearer targeted interaction over an earlier weaker target', () => {
    const { nextState } = calculateRoomShift(null, [
      buildInteraction({ actorId: 'a', targetId: 'b', confidence: 0.72, intensity: 2 }),
      buildInteraction({ actorId: 'c', targetId: 'd', confidence: 0.94, intensity: 4 }),
    ], { semanticSource: 'model' });

    expect(nextState.dominantThread).toEqual(['c', 'd']);
  });

  it('deduplicates reciprocal room pairs and lets repair clear stale conflict', () => {
    const challenged = calculateRoomShift({
      heat: 20,
      cohesion: -8,
      topicDrift: 0,
      dominantThread: ['b', 'a'],
      alliances: [['b', 'a'], ['a', 'b']],
      conflictPairs: [['b', 'a'], ['a', 'b']],
      pileOnTarget: null,
      silencedActors: [],
    }, buildInteraction({ actorId: 'b', targetId: 'a', kind: 'challenge' })).nextState;

    expect(challenged.alliances).toEqual([['a', 'b']]);
    expect(challenged.conflictPairs).toEqual([['a', 'b']]);

    const repaired = calculateRoomShift(challenged, buildInteraction({ kind: 'apologize', tone: 'warm' })).nextState;
    expect(repaired.conflictPairs).toEqual([]);
    expect(repaired.alliances).toEqual([['a', 'b']]);
  });

  it('uses model-authored room deltas without deriving pair labels from the interaction kind', () => {
    const { nextState, shift } = calculateRoomShift({
      heat: 20,
      cohesion: -4,
      topicDrift: 3,
      dominantThread: null,
      alliances: [],
      conflictPairs: [],
      pileOnTarget: null,
      silencedActors: [],
    }, buildInteraction({
      kind: 'support',
      tone: 'warm',
      immediateImpact: { roomDelta: { heat: 7, cohesion: -3, topicDrift: 2 } },
    }), { semanticSource: 'model' });

    expect(shift.delta).toEqual({ heat: 7, cohesion: -3, topicDrift: 2 });
    expect(nextState.heat).toBe(27);
    expect(nextState.cohesion).toBe(-7);
    expect(nextState.alliances).toEqual([]);
    expect(nextState.conflictPairs).toEqual([]);
  });
});
