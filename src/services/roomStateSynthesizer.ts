import type { InteractionEventPayload, RoomShiftPayload, RoomStateSnapshotV2 } from '../types/runtimeEvent';

function createBaseRoomState(): RoomStateSnapshotV2 {
  return {
    heat: 0,
    cohesion: 0,
    topicDrift: 0,
    dominantThread: null,
    alliances: [],
    conflictPairs: [],
    pileOnTarget: null,
    silencedActors: [],
  };
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

function clampSigned(value: number) {
  return Math.max(-100, Math.min(100, value));
}

function normalizeCohesion(value: number | undefined) {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return safeValue > 50 ? safeValue - 50 : safeValue;
}

function coolHeat(value: number) {
  if (value <= 0) return 0;
  return Math.max(0, value - Math.max(2, Math.round(value * 0.08)));
}

function relaxCohesion(value: number) {
  if (value === 0) return 0;
  const direction = value > 0 ? -1 : 1;
  return clampSigned(value + direction * Math.max(1, Math.round(Math.abs(value) * 0.06)));
}

function relaxTopicDrift(value: number) {
  if (value <= 0) return 0;
  return Math.max(0, value - Math.max(1, Math.round(value * 0.12)));
}

function pairKey(pair: [string, string]) {
  return [...pair].sort().join('<->');
}

function normalizePairs(list: Array<[string, string]>) {
  const byKey = new Map<string, [string, string]>();
  list.forEach((pair) => byKey.set(pairKey(pair), [...pair].sort() as [string, string]));
  return [...byKey.values()].slice(-6);
}

function pushUniquePair(list: Array<[string, string]>, pair: [string, string]) {
  const key = pairKey(pair);
  const normalizedPair = [...pair].sort() as [string, string];
  const next = [...list.filter((item) => pairKey(item) !== key), normalizedPair];
  return next.slice(-6);
}

function removePairs(list: Array<[string, string]>, interactions: InteractionEventPayload[]) {
  const keys = new Set(interactions
    .filter((item) => item.targetId)
    .map((item) => pairKey([item.actorId, item.targetId as string])));
  return list.filter((pair) => !keys.has(pairKey(pair)));
}

type RoomDelta = Required<NonNullable<RoomShiftPayload['delta']>>;

function interactionRoomDeltaMagnitude(interaction: InteractionEventPayload) {
  const delta = interaction.immediateImpact?.roomDelta;
  if (!delta) return 0;
  return Math.abs(delta.heat || 0) + Math.abs(delta.cohesion || 0) + Math.abs(delta.topicDrift || 0);
}

/** Select the visible thread without relying on the model's array order alone. */
export function selectDominantInteraction(interactions: InteractionEventPayload[]) {
  return interactions
    .map((interaction, index) => ({ interaction, index }))
    .filter(({ interaction }) => Boolean(interaction.targetId))
    .sort((left, right) => {
      const targetRank = Number(Boolean(right.interaction.targetId)) - Number(Boolean(left.interaction.targetId));
      if (targetRank !== 0) return targetRank;
      const confidenceRank = (right.interaction.confidence || 0) - (left.interaction.confidence || 0);
      if (Math.abs(confidenceRank) > 0.001) return confidenceRank;
      const intensityRank = (right.interaction.intensity || 0) - (left.interaction.intensity || 0);
      if (intensityRank !== 0) return intensityRank;
      const roomRank = interactionRoomDeltaMagnitude(right.interaction) - interactionRoomDeltaMagnitude(left.interaction);
      return roomRank || left.index - right.index;
    })[0]?.interaction || null;
}

function scale(intensity: number, multiplier: number) {
  return Math.round(Math.max(1, Math.min(5, intensity)) * multiplier);
}

function calculateInteractionDelta(interaction: InteractionEventPayload): RoomDelta {
  const intensity = Math.max(1, Math.min(5, interaction.intensity));
  let delta: RoomDelta;

  switch (interaction.kind) {
    case 'challenge':
      delta = { heat: scale(intensity, 3), cohesion: -scale(intensity, 1.25), topicDrift: -2 };
      break;
    case 'mock':
    case 'dismiss':
      delta = { heat: scale(intensity, 3.5), cohesion: -scale(intensity, 1.5), topicDrift: 0 };
      break;
    case 'pile_on':
      delta = { heat: scale(intensity, 4), cohesion: -scale(intensity, 2), topicDrift: 0 };
      break;
    case 'exclude':
      delta = { heat: scale(intensity, 3), cohesion: -scale(intensity, 2), topicDrift: 0 };
      break;
    case 'boundary':
      delta = { heat: scale(intensity, 1.5), cohesion: -scale(intensity, 0.75), topicDrift: 0 };
      break;
    case 'probe':
      delta = { heat: scale(intensity, 0.75), cohesion: intensity >= 4 ? -1 : 0, topicDrift: -1 };
      break;
    case 'evade':
      delta = { heat: scale(intensity, 0.75), cohesion: -scale(intensity, 0.5), topicDrift: 2 };
      break;
    case 'support':
    case 'include':
      delta = { heat: 0, cohesion: scale(intensity, 1.25), topicDrift: -2 };
      break;
    case 'defend':
      delta = { heat: scale(intensity, 0.75), cohesion: scale(intensity, 1.25), topicDrift: -2 };
      break;
    case 'apologize':
    case 'take_responsibility':
      delta = { heat: -scale(intensity, 2), cohesion: scale(intensity, 1.5), topicDrift: -2 };
      break;
    case 'concede':
      delta = { heat: -scale(intensity, 1.25), cohesion: scale(intensity, 1), topicDrift: -2 };
      break;
    case 'redirect':
      delta = { heat: -scale(intensity, 0.5), cohesion: 0, topicDrift: 6 };
      break;
    case 'side_comment':
      delta = { heat: 0, cohesion: 0, topicDrift: 10 };
      break;
  }

  if (interaction.tone === 'annoyed') {
    delta.heat += Math.ceil(intensity / 2);
    delta.cohesion -= 1;
  } else if (interaction.tone === 'sarcastic') {
    delta.heat += intensity;
    delta.cohesion -= 1;
  } else if (interaction.tone === 'warm') {
    delta.heat -= 1;
    delta.cohesion += 1;
  } else if (interaction.tone === 'excited') {
    delta.heat += 1;
  }

  return delta;
}

function isConflictInteraction(interaction: InteractionEventPayload) {
  return interaction.kind === 'challenge'
    || interaction.kind === 'mock'
    || interaction.kind === 'dismiss'
    || interaction.kind === 'pile_on'
    || interaction.kind === 'exclude'
    || interaction.kind === 'boundary';
}

function isAllianceInteraction(interaction: InteractionEventPayload) {
  return interaction.kind === 'support'
    || interaction.kind === 'defend'
    || interaction.kind === 'include'
    || interaction.kind === 'apologize'
    || interaction.kind === 'take_responsibility';
}

export function calculateRoomShift(
  current: RoomStateSnapshotV2 | null,
  input: InteractionEventPayload | InteractionEventPayload[],
  options: { semanticSource?: 'model' | 'legacy' } = {},
): { nextState: RoomStateSnapshotV2; shift: RoomShiftPayload } {
  const interactions = Array.isArray(input) ? input : [input];
  const interaction = selectDominantInteraction(interactions);
  const base = current
    ? {
        ...current,
        cohesion: normalizeCohesion(current.cohesion),
        alliances: normalizePairs(current.alliances || []),
        conflictPairs: normalizePairs(current.conflictPairs || []),
      }
    : createBaseRoomState();
  const modelAuthored = options.semanticSource === 'model';
  const cooledBase = {
    ...base,
    // A model-authored turn owns its explicit room delta. Passive decay here
    // would change state without evidence and make the submitted delta lie.
    heat: modelAuthored ? base.heat : coolHeat(base.heat),
    cohesion: modelAuthored ? base.cohesion : relaxCohesion(base.cohesion),
    topicDrift: modelAuthored ? base.topicDrift : relaxTopicDrift(base.topicDrift),
  };
  const delta = interactions
    .map((item) => modelAuthored
      ? {
          heat: Math.round(item.immediateImpact?.roomDelta?.heat || 0),
          cohesion: Math.round(item.immediateImpact?.roomDelta?.cohesion || 0),
          topicDrift: Math.round(item.immediateImpact?.roomDelta?.topicDrift || 0),
        }
      : calculateInteractionDelta(item))
    .reduce<RoomDelta>((total, item) => ({
      heat: total.heat + item.heat,
      cohesion: total.cohesion + item.cohesion,
      topicDrift: total.topicDrift + item.topicDrift,
    }), { heat: 0, cohesion: 0, topicDrift: 0 });
  const conflictInteractions = modelAuthored ? [] : interactions.filter(isConflictInteraction);
  const allianceInteractions = modelAuthored ? [] : interactions.filter(isAllianceInteraction);
  const repairInteractions = modelAuthored ? [] : interactions.filter((item) => item.kind === 'apologize'
    || item.kind === 'concede'
    || item.kind === 'take_responsibility'
    || item.kind === 'include');
  const allianceBreakingInteractions = modelAuthored ? [] : interactions.filter((item) => item.kind === 'mock'
    || item.kind === 'dismiss'
    || item.kind === 'pile_on'
    || item.kind === 'exclude');
  const pileOn = modelAuthored ? undefined : interactions.find((item) => item.kind === 'pile_on' && item.targetId);
  const dominantThread = interaction?.targetId ? [interaction.actorId, interaction.targetId] as [string, string] : base.dominantThread;
  const alliances = allianceInteractions.reduce(
    (list, item) => item.targetId ? pushUniquePair(list, [item.actorId, item.targetId]) : list,
    removePairs(base.alliances, allianceBreakingInteractions),
  );
  const conflictPairs = conflictInteractions.reduce(
    (list, item) => item.targetId ? pushUniquePair(list, [item.actorId, item.targetId]) : list,
    removePairs(base.conflictPairs, repairInteractions),
  );
  const newlySilencedActors = conflictInteractions
    .filter((item) => item.targetId && (item.kind === 'dismiss' || item.kind === 'pile_on' || item.kind === 'exclude'))
    .map((item) => item.targetId as string);
  const releasedActors = new Set((modelAuthored ? [] : interactions)
    .filter((item) => item.targetId && (isAllianceInteraction(item) || item.kind === 'concede'))
    .map((item) => item.targetId as string));
  const nextState: RoomStateSnapshotV2 = {
    ...base,
    heat: clamp(cooledBase.heat + delta.heat),
    cohesion: clampSigned(cooledBase.cohesion + delta.cohesion),
    topicDrift: clamp(cooledBase.topicDrift + delta.topicDrift),
    dominantThread,
    alliances,
    conflictPairs,
    pileOnTarget: modelAuthored ? base.pileOnTarget : pileOn?.targetId || (conflictInteractions.some((item) => item.targetId === base.pileOnTarget) ? base.pileOnTarget : null),
    silencedActors: newlySilencedActors.length
      ? Array.from(new Set([...base.silencedActors.filter((actorId) => !releasedActors.has(actorId)), ...newlySilencedActors])).slice(-6)
      : base.silencedActors.filter((actorId) => !releasedActors.has(actorId) && !interactions.some((item) => item.actorId === actorId)).slice(-6),
  };

  return {
    nextState,
    shift: {
      heat: nextState.heat,
      cohesion: nextState.cohesion,
      topicDrift: nextState.topicDrift,
      dominantThread: nextState.dominantThread,
      pileOnTarget: nextState.pileOnTarget,
      delta,
    },
  };
}

export function synthesizeRoomState(current: RoomStateSnapshotV2 | null, interaction: InteractionEventPayload): RoomStateSnapshotV2 {
  return calculateRoomShift(current, interaction).nextState;
}

/**
 * A room snapshot is not itself a room event.  Callers should only publish a
 * shift when the model supplied an actual semantic change; otherwise an
 * initial zero snapshot becomes a stream of fake "room updated" events.
 */
export function hasRoomShiftSignal(shift: RoomShiftPayload): boolean {
  const delta = shift.delta;
  return Boolean(delta && (delta.heat !== 0 || delta.cohesion !== 0 || delta.topicDrift !== 0));
}

export function createInitialRoomState() {
  return createBaseRoomState();
}

void createInitialRoomState;
