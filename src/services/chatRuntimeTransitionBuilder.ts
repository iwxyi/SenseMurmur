import type { AICharacter } from '../types/character';
import type { ConversationConflictAxis, DriverCharacterPatch, DriverEventPayload, GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { updateCharacterRelationshipFromDelta } from './relationshipEngine';
import {
  canApplyRelationshipInteraction,
  createBaselineRelationshipCurrent,
  getRelationshipLedgerEntry,
  inferRelationshipDelta,
  reduceRelationshipLedger,
  resolveEffectiveRelationshipAxes,
} from './relationshipLedger';
import type { ConflictFocusPayload, ConflictFocusState, ConflictRuntimeState, RuntimeEventV2 } from '../types/runtimeEvent';
import { applyInteractionEmotions, decayEmotionalState, getEmotionalBaseline, getRuntimeAffectEventDriftLine, getRuntimeAffectEventEmotionLines } from './personalityDrift';
import { accumulateChatRuntime } from './chatRuntime';
import { accumulateCharacterRuntime } from './characterRuntime';
import { createDefaultConflictAxes, summarizeConflictAxes } from './conflictAxisEngine';
import { appendMemoryCandidateEvents, buildMemoryCandidateEvents, updateLayeredMemoriesWithEvents } from './layeredMemoryEngine';
import { consolidateMemoryCandidates } from './memoryConsolidation';
import { createMemoryDistillationRuntimeEvent, debugCharacterMemoryDistillation, debugChatMemoryDistillation, distillChatMemoryCandidates, distillCharacterMemoryCandidates, getLocalDistillationPolicy, localizeDistillationEventInfo, shouldDistillChatMemories, shouldDistillCharacterMemories } from './memoryDistillation';
import { normalizeRuntimeEvent } from './runtimeEventFactory';
import { updateCharacterLayeredMemories } from './characterLayeredMemory';
import type { RuntimeEvolutionConfig } from './runtimeEvolutionConfig';
import { resolveRuntimeEvolutionConfig } from './runtimeEvolutionConfig';
import { projectInnerLife } from './innerLifeEngine';
import { buildRitualEventsFromRelationshipRuntimeEvents, buildRitualEventsFromSharedAnchorEvents, buildSharedAnchorEventsFromCompanionshipEvents } from './companionshipSharedAnchorBackflow';
import { buildSharedPhraseEventsFromCompanionshipEvents } from './companionshipSharedPhraseBackflow';
import { usesConversationContinuity } from './conversationContinuity';

const { chatGap: CHAT_DISTILLATION_TURN_COUNT, characterGap: CHARACTER_DISTILLATION_TURN_COUNT } = getLocalDistillationPolicy();
const PRIMARY_CONFLICT_DECAY_STEP = 0.06;
const SECONDARY_CONFLICT_DECAY_STEP = 0.04;

function resolveMessageTimestamp(message: { timestamp?: number }, fallback: number) {
  return typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? Math.round(message.timestamp)
    : fallback;
}

function areRuntimeValuesEqual(left: unknown, right: unknown) {
  if (left === right) return true;
  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  } catch {
    return false;
  }
}

function pruneUnchangedChatRuntimePatch(conversation: GroupChat, patch: Partial<GroupChat>) {
  const keys: Array<keyof GroupChat> = [
    'runtimeTimeline',
    'runtimeSeed',
    'worldState',
    'layeredMemories',
    'runtimeEventsV2',
    'relationshipLedger',
  ];
  for (const key of keys) {
    if (!(key in patch)) continue;
    if (areRuntimeValuesEqual(patch[key], conversation[key])) {
      delete patch[key];
    }
  }
  return patch;
}

function truncateWithEllipsis(text: string, maxLength: number) {
  const normalized = text.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function countAiTurnsFromLayeredMemories(items: { sourceEventIds?: string[] }[] | undefined) {
  const turnIds = new Set<string>();
  for (const item of items || []) {
    for (const sourceEventId of item.sourceEventIds || []) {
      if (!sourceEventId) continue;
      turnIds.add(sourceEventId);
    }
  }
  return turnIds.size;
}

function resolveCharacterDistillationTurnCount(layeredMemories: AICharacter['layeredMemories']) {
  return Math.max(CHARACTER_DISTILLATION_TURN_COUNT, countAiTurnsFromLayeredMemories(layeredMemories));
}

function resolveChatDistillationTurnCount(layeredMemories: GroupChat['layeredMemories']) {
  return Math.max(CHAT_DISTILLATION_TURN_COUNT, countAiTurnsFromLayeredMemories(layeredMemories));
}

function maybeDistillCharacterLayeredMemories(character: AICharacter, layeredMemories: AICharacter['layeredMemories'], participants: Array<{ id: string; name: string }> = []) {
  if (!layeredMemories?.length) return { layeredMemories, debugInfo: null };
  const candidateCharacter = { ...character, layeredMemories };
  const turnCount = resolveCharacterDistillationTurnCount(layeredMemories);
  const debugInfo = debugCharacterMemoryDistillation(candidateCharacter, turnCount, participants);
  if (!shouldDistillCharacterMemories(candidateCharacter, turnCount)) return { layeredMemories, debugInfo: null };
  const distilled = distillCharacterMemoryCandidates(candidateCharacter, participants);
  if (!distilled.length) return { layeredMemories, debugInfo: null };
  return {
    layeredMemories: consolidateMemoryCandidates(layeredMemories, distilled),
    debugInfo: {
      ...debugInfo,
      triggered: true,
      reason: 'distilled',
      candidateTexts: distilled.map((item) => item.text),
    },
  };
}

function maybeDistillChatLayeredMemories(chat: GroupChat, layeredMemories: GroupChat['layeredMemories'], participants: Array<{ id: string; name: string }> = []) {
  if (!layeredMemories?.length) return { layeredMemories, debugInfo: null };
  const candidateChat = { ...chat, layeredMemories };
  const turnCount = resolveChatDistillationTurnCount(layeredMemories);
  const debugInfo = debugChatMemoryDistillation(candidateChat, turnCount, participants);
  if (!shouldDistillChatMemories(candidateChat, turnCount)) return { layeredMemories, debugInfo: null };
  const distilled = distillChatMemoryCandidates(candidateChat, participants);
  if (!distilled.length) return { layeredMemories, debugInfo: null };
  return {
    layeredMemories: consolidateMemoryCandidates(layeredMemories, distilled),
    debugInfo: {
      ...debugInfo,
      triggered: true,
      reason: 'distilled',
      candidateTexts: distilled.map((item) => item.text),
    },
  };
}

function appendDistilledMemoryEvents(conversation: GroupChat, existingEvents: RuntimeEventV2[], nextLayeredMemories: GroupChat['layeredMemories']) {
  const distilled = (nextLayeredMemories || []).filter((item) => item.origin === 'distilled');
  const knownTexts = new Set(existingEvents.filter((event) => event.kind === 'memory_candidate').map((event) => String((event.payload as Record<string, unknown>).text || '')));
  const newEvents = distilled
    .filter((item) => !knownTexts.has(item.text))
    .map<RuntimeEventV2>((item) => ({
      id: `distilled-${item.id}`,
      conversationId: conversation.id,
      createdAt: item.distilledAt || item.updatedAt,
      kind: 'memory_candidate',
      actorIds: [],
      targetIds: item.subjectIds,
      evidenceMessageIds: [],
      summary: item.text,
      eventClass: 'artifact',
      visibility: 'public',
      visibleToIds: [],
      visibleToRoles: [],
      payload: {
        kind: item.kind,
        text: item.text,
        salience: item.salience,
        confidence: item.confidence,
        origin: 'distilled',
        sharedPhrase: item.sharedPhrase,
      },
    }));
  return [...existingEvents, ...newEvents];
}

function normalizeConflictFocus(
  payload: ConflictFocusPayload | null | undefined,
  conversation: GroupChat,
  message: Pick<Message, 'content' | 'senderId'> & Partial<Pick<Message, 'metadata' | 'isDeleted'>>,
  referenceTimestamp: number,
): ConflictFocusState | null {
  if (!payload?.present || !payload.type || !payload.summary) return null;
  if (usesConversationContinuity(conversation)) {
    if (!conversation.memberIds.includes(message.senderId) || message.isDeleted || message.metadata?.withdrawal?.withdrawn
      || (message.metadata?.visibility && message.metadata.visibility !== 'public')) return null;
    const evidence = typeof payload.evidenceText === 'string' ? payload.evidenceText.trim() : '';
    if (!evidence || evidence.length > 240 || !message.content.includes(evidence)) return null;
    if ([...(payload.participantIds || []), ...(payload.primaryTargetIds || [])]
      .some((id) => !conversation.memberIds.includes(id))) return null;
  }
  const known = [conversation.worldState.conflictState?.primaryConflict, ...(conversation.worldState.conflictState?.activeConflicts || [])]
    .find((conflict) => conflict && conflict.id === payload.conflictId);
  if (payload.conflictId && !known) return null;
  const summary = payload.summary.trim();
  if (summary.length < 8) return null;
  const severity = typeof payload.severity === 'number' && Number.isFinite(payload.severity) ? Math.max(0, Math.min(1, payload.severity)) : 0;
  if (severity < 0.55 && !known) return null;
  const whyText = typeof payload.why === 'string' ? payload.why.trim() : '';
  if (severity >= 0.75 && whyText.length < 6) return null;
  const participantIds = (payload.participantIds || [message.senderId]).filter((id) => conversation.memberIds.includes(id));
  if (!participantIds.length) return null;
  const targetIds = (payload.primaryTargetIds || []).filter((id) => conversation.memberIds.includes(id));
  return {
    id: known?.id || `conflict-${referenceTimestamp}-${message.senderId}-${payload.type}`,
    scope: conversation.type,
    type: known?.type || payload.type,
    severity,
    stage: payload.stage || (severity >= 0.85 ? 'escalating' : severity >= 0.7 ? 'open' : 'emerging'),
    summary,
    participantIds: participantIds.length ? participantIds : [message.senderId],
    targetIds,
    nextPressure: payload.nextPressure || 'stabilize',
    developmentHooks: payload.developmentHooks || [],
    sourceEventIds: known?.sourceEventIds || [],
    updatedAt: referenceTimestamp,
  };
}

function normalizeIdList(ids: string[] | undefined) {
  return Array.from(new Set((ids || []).filter(Boolean))).sort();
}

function buildConflictIdentity(conflict: ConflictFocusState | null | undefined) {
  if (!conflict) return null;
  return {
    type: conflict.type,
    stage: conflict.stage,
    severityBand: Math.round(conflict.severity * 10) / 10,
    summary: conflict.summary.trim(),
    nextPressure: conflict.nextPressure,
    participantIds: normalizeIdList(conflict.participantIds),
    targetIds: normalizeIdList(conflict.targetIds),
  };
}

function hasMeaningfulConflictChange(previous: ConflictFocusState | null | undefined, next: ConflictFocusState | null) {
  if (!next) return false;
  const previousIdentity = buildConflictIdentity(previous);
  const nextIdentity = buildConflictIdentity(next);
  if (!previousIdentity) return true;
  return JSON.stringify(previousIdentity) !== JSON.stringify(nextIdentity);
}

function sameConflictBranch(left: ConflictFocusState | null | undefined, right: ConflictFocusState | null | undefined) {
  if (left && right && left.id === right.id) return true;
  const leftIdentity = buildConflictIdentity(left);
  const rightIdentity = buildConflictIdentity(right);
  return Boolean(leftIdentity && rightIdentity && JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity));
}

function decayConflictFocus(conflict: ConflictFocusState, step: number): ConflictFocusState | null {
  if (conflict.stage === 'resolved') return null;
  const severity = Math.max(0, Number((conflict.severity - step).toFixed(2)));
  return {
    ...conflict,
    severity,
  };
}

function updateConflictRuntimeState(previous: ConflictRuntimeState | null | undefined, nextConflict: ConflictFocusState | null, now: number): ConflictRuntimeState | null {
  if (!nextConflict) {
    const decayedActiveConflicts = [...new Map([previous?.primaryConflict, ...(previous?.activeConflicts || [])]
      .filter((item): item is ConflictFocusState => Boolean(item)).map((item) => [item.id, item])).values()]
      .map((item) => decayConflictFocus(item, PRIMARY_CONFLICT_DECAY_STEP))
      .filter((item): item is ConflictFocusState => Boolean(item))
      .slice(0, 6);
    if (!decayedActiveConflicts.length) return null;
    const primaryConflict = decayedActiveConflicts[0] || null;
    return {
      primaryConflict,
      activeConflicts: decayedActiveConflicts,
      developmentHooks: primaryConflict?.developmentHooks || [],
      volatility: Math.max(0, Number(((previous?.volatility || 0) - 0.12).toFixed(2))),
      cooling: Math.min(1, Number(((previous?.cooling || 0) + 0.18).toFixed(2))),
      updatedAt: now,
    };
  }

  const decayedPreviousConflicts = [...new Map([previous?.primaryConflict, ...(previous?.activeConflicts || [])]
    .filter((item): item is ConflictFocusState => Boolean(item)).map((item) => [item.id, item])).values()]
    .filter((item) => !sameConflictBranch(item, nextConflict))
    .map((item) => decayConflictFocus(item, SECONDARY_CONFLICT_DECAY_STEP))
    .filter((item): item is ConflictFocusState => Boolean(item));
  const activeConflicts = [...(nextConflict.stage === 'resolved' ? [] : [nextConflict]), ...decayedPreviousConflicts].slice(0, 6);
  const primaryConflict = activeConflicts[0] || null;
  return {
    primaryConflict,
    activeConflicts,
    developmentHooks: primaryConflict?.developmentHooks || [],
    volatility: Math.max(nextConflict.severity, Math.max(0, Number(((previous?.volatility || 0) - 0.06).toFixed(2)))),
    cooling: nextConflict.nextPressure === 'cool' ? Math.min(1, (previous?.cooling || 0) + 0.2) : Math.max(0, (previous?.cooling || 0) - 0.1),
    updatedAt: now,
  };
}

function buildConflictAxesSummary(axes: ConversationConflictAxis[]) {
  return summarizeConflictAxes(axes).trim();
}

function shouldEmitConflictAxisShift(previousAxes: ConversationConflictAxis[] | undefined, nextAxes: ConversationConflictAxis[], messageType: Message['type'], config: RuntimeEvolutionConfig) {
  if (messageType !== 'ai' || !nextAxes.length || config.worldMultiplier < 0.7) return false;
  return buildConflictAxesSummary(previousAxes || []) !== buildConflictAxesSummary(nextAxes);
}

function buildWorldStateShiftSummary(worldState: GroupChat['worldState']) {
  return [worldState.focus, worldState.recentEvent].filter(Boolean).join(' / ').slice(0, 90);
}

function pickMentionedTargetIds(content: string, participants: Array<{ id: string; name: string }>) {
  const text = content.trim();
  if (!text) return [];
  return participants
    .filter((participant) => participant.id !== 'user' && participant.name && text.includes(participant.name))
    .map((participant) => participant.id)
    .slice(0, 3);
}

function buildAttentionCandidateEvent(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'type' | 'senderId'> & { timestamp?: number };
  participants: Array<{ id: string; name: string }>;
}): RuntimeEventV2 | null {
  if (params.conversation.type !== 'group') return null;
  if (params.message.type !== 'user' || params.message.senderId !== 'user') return null;
  const targetIds = pickMentionedTargetIds(params.message.content, params.participants);
  if (!targetIds.length) return null;
  const createdAt = resolveMessageTimestamp(params.message, params.conversation.updatedAt || Date.now());
  const summary = `用户点名 ${targetIds.map((id) => params.participants.find((item) => item.id === id)?.name || id).join('、')}，等待回应`;
  return {
    id: `att-${params.conversation.id}-${targetIds.join('-')}-${createdAt}`,
    conversationId: params.conversation.id,
    kind: 'attention_candidate',
    createdAt,
    actorIds: ['user'],
    targetIds,
    evidenceMessageIds: [],
    summary,
    eventClass: 'action',
    visibility: 'derived_public',
    visibleToIds: [],
    visibleToRoles: [],
    payload: {
      source: 'user_group_message',
      reason: summary,
      confidence: 0.82,
      targetIds,
    },
  };
}

function appendAttentionCandidateEvent(existingEvents: RuntimeEventV2[], candidate: RuntimeEventV2 | null) {
  if (!candidate) return existingEvents;
  const hasRecentDuplicate = existingEvents
    .slice()
    .reverse()
    .slice(0, 12)
    .some((event) => {
      if (event.kind !== 'attention_candidate') return false;
      if (Math.abs(event.createdAt - candidate.createdAt) > 10 * 60_000) return false;
      const left = (event.targetIds || []).slice().sort().join(',');
      const right = (candidate.targetIds || []).slice().sort().join(',');
      return left === right;
    });
  if (hasRecentDuplicate) return existingEvents;
  return [...existingEvents, candidate];
}

function shouldEmitWorldStateShift(previousWorldState: GroupChat['worldState'], nextWorldState: GroupChat['worldState'], messageType: Message['type'], config: RuntimeEvolutionConfig) {
  if (messageType !== 'ai' || config.worldMultiplier < 0.9) return false;
  const nextSummary = buildWorldStateShiftSummary(nextWorldState);
  if (!nextSummary) return false;
  return buildWorldStateShiftSummary(previousWorldState) !== nextSummary;
}

export function buildNextWorldState(
  conversation: GroupChat,
  message: Pick<Message, 'content' | 'type' | 'senderId'> & Partial<Pick<Message, 'metadata' | 'isDeleted'>> & { conflictFocus?: ConflictFocusPayload | null; timestamp?: number },
) {
  const now = resolveMessageTimestamp(message, conversation.updatedAt || Date.now());
  const existingAxes = (conversation.worldState.conflictAxes || []).length ? (conversation.worldState.conflictAxes || []) : createDefaultConflictAxes(conversation);
  const normalizedConflict = message.type === 'ai' ? normalizeConflictFocus(message.conflictFocus || null, conversation, message, now) : null;
  const nextConflictAxes = existingAxes;
  const nextConflictState = updateConflictRuntimeState(conversation.worldState.conflictState || null, normalizedConflict, now);
  return {
    worldState: {
      ...conversation.worldState,
      conflictAxes: nextConflictAxes,
      conflictState: nextConflictState,
      recentEvent: normalizedConflict?.summary || conversation.worldState.recentEvent,
    },
    nextConflictAxes,
    nextConflictState,
  };
}

function buildSeededRelationshipLedger(conversation: GroupChat, characters: AICharacter[]) {
  if ((conversation.relationshipLedger || []).length > 0) {
    const characterById = new Map(characters.map((character) => [character.id, character] as const));
    return (conversation.relationshipLedger || []).map((entry) => {
      const authored = characterById.get(entry.actorId)?.relationships.find((relation) => relation.characterId === entry.targetId);
      if (!authored) return entry;
      const baseline = {
        warmth: authored.warmth,
        competence: authored.competence,
        trust: authored.trust,
        threat: authored.threat,
        attachment: authored.attachment || 0,
        deference: authored.deference || 0,
      };
      // Character relationships are the global source of truth. The room
      // entry is retained for event history, but must not add a second layer
      // of numeric state on top of the character relationship.
      const adjustment = createBaselineRelationshipCurrent();
      return {
        ...entry,
        baseline,
        adjustment,
        current: resolveEffectiveRelationshipAxes(baseline, adjustment),
      };
    });
  }
  return characters.flatMap((character) => character.relationships
    .filter((relation) => !/^draft-\d+$/i.test(relation.characterId))
    .map((relation) => ({
      pairKey: `${character.id}->${relation.characterId}`,
      actorId: character.id,
      targetId: relation.characterId,
      baseline: {
        warmth: relation.warmth ?? createBaselineRelationshipCurrent().warmth,
        competence: relation.competence ?? createBaselineRelationshipCurrent().competence,
        trust: relation.trust ?? createBaselineRelationshipCurrent().trust,
        threat: relation.threat ?? createBaselineRelationshipCurrent().threat,
        attachment: relation.attachment ?? createBaselineRelationshipCurrent().attachment,
        deference: relation.deference ?? createBaselineRelationshipCurrent().deference,
      },
      adjustment: createBaselineRelationshipCurrent(),
      current: {
        warmth: relation.warmth ?? createBaselineRelationshipCurrent().warmth,
        competence: relation.competence ?? createBaselineRelationshipCurrent().competence,
        trust: relation.trust ?? createBaselineRelationshipCurrent().trust,
        threat: relation.threat ?? createBaselineRelationshipCurrent().threat,
        attachment: relation.attachment ?? createBaselineRelationshipCurrent().attachment,
        deference: relation.deference ?? createBaselineRelationshipCurrent().deference,
      },
      derived: {},
      axisReasons: {},
      trend: 'flat' as const,
      recentEvents: [],
      lastUpdatedAt: relation.updatedAt || conversation.updatedAt || Date.now(),
    })));
}

export function buildRelationshipTransition(params: {
  conversation: GroupChat;
  characters: AICharacter[];
  message: Pick<Message, 'content' | 'type' | 'senderId'> & Partial<Pick<Message, 'metadata' | 'isDeleted'>> & { interactionHint?: import('../types/runtimeEvent').InteractionEventPayload | null; interactionHints?: import('../types/runtimeEvent').InteractionEventPayload[] | null; incomingInteractionHint?: import('../types/runtimeEvent').InteractionEventPayload | null; conflictFocus?: ConflictFocusPayload | null; timestamp?: number };
  previousAiMessage?: Pick<Message, 'senderId'> | null;
  recentMessages?: Message[];
  config?: RuntimeEvolutionConfig;
}) {
  const runtimeEvents: DriverEventPayload[] = [];
  const characterPatches: DriverCharacterPatch[] = [];
  let relationshipLedger = buildSeededRelationshipLedger(params.conversation, params.characters);
  const baseTimestamp = resolveMessageTimestamp(params.message, params.conversation.updatedAt || Date.now());
  let eventOffset = 0;
  const nextEventTimestamp = () => baseTimestamp + eventOffset++;
  void params.previousAiMessage;
  const config = params.config || resolveRuntimeEvolutionConfig(params.conversation.runtimeEvolutionIntensity);
  const distillationParticipants = params.characters.map((item) => ({ id: item.id, name: item.name }));
  const speaker = params.characters.find((item) => item.id === params.message.senderId);
  const isCharacterAuthoredMessage = Boolean(speaker && (params.message.type === 'ai' || params.message.type === 'user'));
  const providedHints = params.message.interactionHints?.length
    ? params.message.interactionHints
    : (params.message.interactionHint ? [params.message.interactionHint] : []);
  const explicitHints = providedHints;
  const uniqueHints = explicitHints.filter((hint, index, array) => {
    if (!hint?.targetId) return false;
    return array.findIndex((candidate) => candidate.targetId === hint.targetId && candidate.kind === hint.kind) === index;
  });
  const hintedTargets = uniqueHints
    .map((hint) => ({ hint, target: params.characters.find((item) => item.id === hint.targetId) }))
    .filter((item): item is { hint: NonNullable<typeof uniqueHints[number]>; target: AICharacter } => Boolean(item.target));
  const targetEntries = hintedTargets;
  const targetGroups = Array.from(hintedTargets.reduce((groups, entry) => {
    const current = groups.get(entry.target.id);
    if (current) current.hints.push(entry.hint);
    else groups.set(entry.target.id, { target: entry.target, hints: [entry.hint] });
    return groups;
  }, new Map<string, { target: AICharacter; hints: Array<NonNullable<typeof uniqueHints[number]>> }>()).values());
  const incomingInteraction = params.message.incomingInteractionHint && speaker
    && params.message.incomingInteractionHint.targetId === speaker.id
    && params.message.incomingInteractionHint.actorId !== speaker.id
    ? params.message.incomingInteractionHint
    : null;

  if (isCharacterAuthoredMessage && speaker && targetEntries.length) {
    const summary = truncateWithEllipsis(params.message.content, 48);
    const speakerDrift = speaker.personalityDrift || {};
    const speakerEmotion = applyInteractionEmotions(
      speaker,
      [
        ...(incomingInteraction?.immediateImpact?.targetEmotionDelta ? [{
          ...incomingInteraction,
          immediateImpact: { speakerEmotionDelta: incomingInteraction.immediateImpact.targetEmotionDelta },
        }] : []),
        ...targetEntries.map(({ hint }) => hint),
      ],
      'speaker',
      speaker.emotionalState || getEmotionalBaseline(),
      'model',
    );
    const localizedDriftSummary = getRuntimeAffectEventDriftLine(speaker.name, speakerDrift, 'zh');
    const driftEntries = localizedDriftSummary ? [{ type: 'drift' as const, text: localizedDriftSummary, createdAt: nextEventTimestamp() }] : [];

    const updatedSpeakerRelationships = targetEntries.reduce((relationships, { target, hint }) => {
      const explicitDelta = inferRelationshipDelta(hint)?.delta;
      if (!explicitDelta) return relationships;
      return updateCharacterRelationshipFromDelta({ ...speaker, relationships }, target.id, explicitDelta, config.relationshipMultiplier).relationships;
    }, speaker.relationships);
    const projectedSpeakerSoul = projectInnerLife({
      chat: params.conversation,
      character: { ...speaker, relationships: updatedSpeakerRelationships, emotionalState: speakerEmotion },
      messages: params.recentMessages || [],
    }).state;

    const speakerLayeredResult = maybeDistillCharacterLayeredMemories({
      ...speaker,
      relationships: updatedSpeakerRelationships,
      emotionalState: speakerEmotion,
      soulState: projectedSpeakerSoul,
    }, updateCharacterLayeredMemories({
      character: {
        ...speaker,
        relationships: updatedSpeakerRelationships,
        emotionalState: speakerEmotion,
        soulState: projectedSpeakerSoul,
      },
      targetId: targetEntries[0].target.id,
      targetName: targetEntries.map(({ target }) => target.name).join('、'),
      content: params.message.content,
      personalityDrift: speakerDrift,
    }), distillationParticipants);

    characterPatches.push({
      characterId: speaker.id,
      patch: {
        relationships: updatedSpeakerRelationships,
        personalityDrift: speakerDrift,
        emotionalState: speakerEmotion,
        soulState: projectedSpeakerSoul,
        layeredMemories: speakerLayeredResult.layeredMemories,
        runtimeTimeline: accumulateCharacterRuntime(speaker, {
          type: 'relationship',
          text: `对 ${targetEntries.map(({ target }) => target.name).join('、')} 的态度发生变化：${summary}`,
        }).concat(driftEntries).slice(-Math.max(20, config.maxTimeline)),
      },
    });
    if (speakerLayeredResult.debugInfo) {
      runtimeEvents.push(createMemoryDistillationRuntimeEvent(localizeDistillationEventInfo(speakerLayeredResult.debugInfo, distillationParticipants)));
    }

    const relationshipLines: string[] = [];

    const targetEmotionById = new Map<string, ReturnType<typeof applyInteractionEmotions>>();
    for (const { target, hints } of targetGroups) {
      const targetEmotion = applyInteractionEmotions(
        target,
        hints,
        'target',
        target.emotionalState || getEmotionalBaseline(),
        'model',
      );
      targetEmotionById.set(target.id, targetEmotion);
      const projectedTargetSoul = projectInnerLife({
        chat: params.conversation,
        character: { ...target, emotionalState: targetEmotion },
        messages: params.recentMessages || [],
      }).state;
      const targetLayeredResult = maybeDistillCharacterLayeredMemories({
        ...target,
        emotionalState: targetEmotion,
        soulState: projectedTargetSoul,
      }, updateCharacterLayeredMemories({
        character: {
          ...target,
          emotionalState: targetEmotion,
          soulState: projectedTargetSoul,
        },
        targetId: speaker.id,
        targetName: speaker.name,
        content: params.message.content,
        personalityDrift: {},
      }), distillationParticipants);

      characterPatches.push({
        characterId: target.id,
        patch: {
          emotionalState: targetEmotion,
          soulState: projectedTargetSoul,
          layeredMemories: targetLayeredResult.layeredMemories,
          runtimeTimeline: accumulateCharacterRuntime(target, {
            type: 'relationship',
            text: `${speaker.name} 的发言影响了对 TA 的态度：${truncateWithEllipsis(params.message.content, 36)}`,
          }).slice(-Math.max(16, config.maxTimeline - 4)),
        },
      });
      if (targetLayeredResult.debugInfo) {
        runtimeEvents.push(createMemoryDistillationRuntimeEvent(localizeDistillationEventInfo(targetLayeredResult.debugInfo, distillationParticipants)));
      }
    }

    for (const { target, hint } of targetEntries) {
      const relationshipDelta = inferRelationshipDelta(hint);
      if (!relationshipDelta) continue;
      if (!canApplyRelationshipInteraction(hint, relationshipDelta)) continue;
      const deltaParts = [
        relationshipDelta.delta.warmth ? `亲和${relationshipDelta.delta.warmth > 0 ? '+' : ''}${relationshipDelta.delta.warmth}` : '',
        relationshipDelta.delta.competence ? `能力${relationshipDelta.delta.competence > 0 ? '+' : ''}${relationshipDelta.delta.competence}` : '',
        relationshipDelta.delta.trust ? `信任${relationshipDelta.delta.trust > 0 ? '+' : ''}${relationshipDelta.delta.trust}` : '',
        relationshipDelta.delta.threat ? `威胁${relationshipDelta.delta.threat > 0 ? '+' : ''}${relationshipDelta.delta.threat}` : '',
      ].filter(Boolean);
      if (!deltaParts.length) continue;

      const confidenceLabel = `${Math.round((hint.confidence || 0) * 100)}%`;
      const relationshipSummary = `${speaker.name}→${target.name}：${deltaParts.join('，')}｜${confidenceLabel}`;
      const relationshipEventCreatedAt = nextEventTimestamp();
      const relationshipEvent: RuntimeEventV2 = {
        id: `relationship-${params.conversation.id}-${speaker.id}-${target.id}-${relationshipEventCreatedAt}`,
        conversationId: params.conversation.id,
        createdAt: relationshipEventCreatedAt,
        kind: 'relationship_delta',
        actorIds: [speaker.id],
        targetIds: [target.id],
        summary: relationshipSummary,
        eventClass: 'action',
        visibility: 'public',
        visibleToIds: [],
        visibleToRoles: [],
        payload: relationshipDelta,
      };
      const previousLedgerEntry = getRelationshipLedgerEntry(relationshipLedger, speaker.id, target.id);
      const nextRelationshipLedger = reduceRelationshipLedger(relationshipLedger, hint, relationshipEvent);
      const nextLedgerEntry = getRelationshipLedgerEntry(nextRelationshipLedger, speaker.id, target.id);
      const applied = Boolean(
        nextLedgerEntry
        && nextLedgerEntry.lastUpdatedAt === relationshipEvent.createdAt
        && (previousLedgerEntry?.lastUpdatedAt !== nextLedgerEntry.lastUpdatedAt),
      );
      relationshipLedger = nextRelationshipLedger;
      if (!applied) continue;
      relationshipLines.push(relationshipSummary);
    }

    if (relationshipLines.length) {
      runtimeEvents.push(normalizeRuntimeEvent({
        eventType: 'group_relationship_shift',
        title: `${speaker.name} 触发关系变化`,
        summary: relationshipLines.join('\n'),
        pair: [speaker.name, targetEntries[0].target.name],
        metrics: null,
        timelineType: 'relationship',
        eventClass: 'action',
        visibilityScope: 'public',
        createdAt: nextEventTimestamp(),
      }));
    }

    const normalizedConflict = normalizeConflictFocus(params.message.conflictFocus || null, params.conversation, params.message, baseTimestamp);
    if (hasMeaningfulConflictChange(params.conversation.worldState.conflictState?.primaryConflict || null, normalizedConflict)) {
      runtimeEvents.push(normalizeRuntimeEvent({
        eventType: 'conflict_focus_shift',
        title: `${speaker.name} 抓住了一个矛盾点`,
        summary: normalizedConflict?.summary || '',
        metrics: {
          type: normalizedConflict?.type,
          stage: normalizedConflict?.stage,
          severity: normalizedConflict?.severity,
          nextPressure: normalizedConflict?.nextPressure,
          developmentHooks: normalizedConflict?.developmentHooks,
        },
        timelineType: 'note',
        eventClass: 'action',
        visibilityScope: 'public',
        createdAt: nextEventTimestamp(),
      }));
    }

    if (localizedDriftSummary) {
      runtimeEvents.push(normalizeRuntimeEvent({
        eventType: 'speaker_drift_shift',
        title: `${speaker.name} 出现人格偏移`,
        summary: localizedDriftSummary,
        timelineType: 'note',
        eventClass: 'action',
        visibilityScope: 'public',
        createdAt: nextEventTimestamp(),
      }));
    }

    const speakerEmotionLines = getRuntimeAffectEventEmotionLines([{ name: speaker.name, emotion: speakerEmotion }], 'zh');
    if (speakerEmotionLines.length) {
      runtimeEvents.push(normalizeRuntimeEvent({
        eventType: 'speaker_emotion_shift',
        title: `${speaker.name} 出现情绪变化`,
        summary: speakerEmotionLines.join('\n'),
        timelineType: 'note',
        eventClass: 'action',
        visibilityScope: 'public',
        createdAt: nextEventTimestamp(),
      }));
    }

    const targetEmotionLines = getRuntimeAffectEventEmotionLines(
      targetGroups.map(({ target }) => ({
        target,
        emotion: targetEmotionById.get(target.id) || target.emotionalState || getEmotionalBaseline(),
        name: target.name,
      })),
      'zh',
    );

    if (targetEmotionLines.length) {
      runtimeEvents.push(normalizeRuntimeEvent({
        eventType: 'target_emotion_shift',
        title: '目标角色出现情绪变化',
        summary: targetEmotionLines.join('\n'),
        timelineType: 'note',
        eventClass: 'action',
        visibilityScope: 'public',
        createdAt: nextEventTimestamp(),
      }));
    }
  }

  if (isCharacterAuthoredMessage && speaker && !targetEntries.length) {
    const speakerDrift = speaker.personalityDrift || {};
    // No directed model hint means there is no justified semantic stimulus.
    // Speaking still releases fast affect, but local word matching must not
    // invent irritation, affection, or embarrassment.
    const speakerEmotion = incomingInteraction
      ? applyInteractionEmotions(speaker, [incomingInteraction], 'target', speaker.emotionalState || getEmotionalBaseline(), 'model')
      : decayEmotionalState(speaker.emotionalState || getEmotionalBaseline(), 'speaker');
    const localizedDriftSummary = getRuntimeAffectEventDriftLine(speaker.name, speakerDrift, 'zh');
    const projectedSpeakerSoul = projectInnerLife({
      chat: params.conversation,
      character: { ...speaker, emotionalState: speakerEmotion },
      messages: params.recentMessages || [],
    }).state;
    const speakerLayeredResult = maybeDistillCharacterLayeredMemories({
      ...speaker,
      emotionalState: speakerEmotion,
      soulState: projectedSpeakerSoul,
    }, updateCharacterLayeredMemories({
      character: { ...speaker, emotionalState: speakerEmotion, soulState: projectedSpeakerSoul },
      content: params.message.content,
      personalityDrift: speakerDrift,
      sourceEventTag: params.conversation.type === 'ai_direct' ? 'ai_direct_self_message' : params.conversation.type === 'direct' ? 'direct_ai_message' : 'interaction',
    }), distillationParticipants);
    const driftEntries = localizedDriftSummary ? [{ type: 'drift' as const, text: localizedDriftSummary, createdAt: nextEventTimestamp() }] : [];

    characterPatches.push({
      characterId: speaker.id,
      patch: {
        personalityDrift: speakerDrift,
        emotionalState: speakerEmotion,
        soulState: projectedSpeakerSoul,
        layeredMemories: speakerLayeredResult.layeredMemories,
        runtimeTimeline: accumulateCharacterRuntime(speaker, {
          type: 'memory',
          text: `在${params.conversation.type === 'group' ? '群聊' : params.conversation.type === 'ai_direct' ? 'AI私聊' : '单聊'}中表达了新状态：${truncateWithEllipsis(params.message.content, 48)}`,
        }).concat(driftEntries).slice(-Math.max(20, config.maxTimeline)),
      },
    });
    if (speakerLayeredResult.debugInfo) {
      runtimeEvents.push(createMemoryDistillationRuntimeEvent(localizeDistillationEventInfo(speakerLayeredResult.debugInfo, distillationParticipants)));
    }

    if (localizedDriftSummary) {
      runtimeEvents.push(normalizeRuntimeEvent({
        eventType: 'speaker_drift_shift',
        title: `${speaker.name} 出现人格偏移`,
        summary: localizedDriftSummary,
        timelineType: 'note',
        eventClass: 'action',
        visibilityScope: 'public',
        createdAt: nextEventTimestamp(),
      }));
    }

    const speakerEmotionLines = getRuntimeAffectEventEmotionLines([{ name: speaker.name, emotion: speakerEmotion }], 'zh');
    if (speakerEmotionLines.length) {
      runtimeEvents.push(normalizeRuntimeEvent({
        eventType: 'speaker_emotion_shift',
        title: `${speaker.name} 出现情绪变化`,
        summary: speakerEmotionLines.join('\n'),
        timelineType: 'note',
        eventClass: 'action',
        visibilityScope: 'public',
        createdAt: nextEventTimestamp(),
      }));
    }
  }

  return { runtimeEvents, characterPatches, relationshipLedger };
}

export function buildWorldRuntimeEvents(
  message: Pick<Message, 'content' | 'type'> & { timestamp?: number },
  previousWorldState: GroupChat['worldState'],
  worldState: GroupChat['worldState'],
  nextConflictAxes: ConversationConflictAxis[],
  config: RuntimeEvolutionConfig,
) {
  const runtimeEvents: DriverEventPayload[] = [];
  const baseTimestamp = resolveMessageTimestamp(message, Date.now());
  let eventOffset = 0;
  const nextEventTimestamp = () => baseTimestamp + eventOffset++;

  if (shouldEmitConflictAxisShift(previousWorldState.conflictAxes || [], nextConflictAxes, message.type, config)) {
    runtimeEvents.push(normalizeRuntimeEvent({
      eventType: 'conflict_axis_shift',
      title: '会话冲突轴发生偏移',
      summary: buildConflictAxesSummary(nextConflictAxes),
      timelineType: 'note',
      eventClass: 'phase',
      visibilityScope: 'public',
      createdAt: nextEventTimestamp(),
    }));
  }

  if (shouldEmitWorldStateShift(previousWorldState, worldState, message.type, config)) {
    runtimeEvents.push(normalizeRuntimeEvent({
      eventType: 'world_state_shift',
      title: '会话状态发生变化',
      summary: buildWorldStateShiftSummary(worldState),
      timelineType: 'note',
      eventClass: 'phase',
      visibilityScope: 'public',
      createdAt: nextEventTimestamp(),
    }));
  }

  return runtimeEvents;
}

export function buildChatPatch(
  conversation: GroupChat,
  message: Pick<Message, 'content' | 'type' | 'senderId'> & { timestamp?: number },
  worldState: GroupChat['worldState'],
  runtimeEvents: DriverEventPayload[],
  config: RuntimeEvolutionConfig = resolveRuntimeEvolutionConfig(conversation.runtimeEvolutionIntensity),
  participants: Array<{ id: string; name: string }> = [],
) {
  const chatPatch: Partial<GroupChat> = {
    ...accumulateChatRuntime(
      conversation,
      message,
      runtimeEvents,
      { maxTimeline: config.maxTimeline }
    ),
    runtimeSeed: {
      notes: conversation.runtimeSeed?.notes || [],
      artifacts: conversation.runtimeSeed?.artifacts || [],
    },
    worldState,
  };

  const chatDistillationResult = maybeDistillChatLayeredMemories(
    { ...conversation, ...chatPatch, worldState } as GroupChat,
    updateLayeredMemoriesWithEvents(
      conversation.layeredMemories || [],
      {
        ...conversation,
        ...chatPatch,
        worldState,
      } as GroupChat,
      message,
      runtimeEvents,
    ),
    participants,
  );

  const nextLayeredMemories = chatDistillationResult.layeredMemories;

  const memoryCandidateEvents = buildMemoryCandidateEvents({
    chat: conversation,
    message,
    existingMemories: conversation.layeredMemories || [],
    nextMemories: nextLayeredMemories,
  });

  chatPatch.layeredMemories = nextLayeredMemories;
  const runtimeEventsV2WithCandidates = appendDistilledMemoryEvents(
    conversation,
    appendMemoryCandidateEvents(conversation.runtimeEventsV2 || [], memoryCandidateEvents),
    nextLayeredMemories,
  );
  const companionshipBackflowEvents = participants.flatMap((participant) => [
    ...buildSharedAnchorEventsFromCompanionshipEvents({
      chat: conversation,
      character: participant,
      events: runtimeEventsV2WithCandidates,
    }),
    ...buildSharedPhraseEventsFromCompanionshipEvents({
      chat: conversation,
      character: participant,
      events: runtimeEventsV2WithCandidates,
    }),
  ]);
  const runtimeEventsV2WithCompanionshipBackflow = [
    ...runtimeEventsV2WithCandidates,
    ...companionshipBackflowEvents,
    ...participants.flatMap((participant) => buildRitualEventsFromSharedAnchorEvents({
        chat: conversation,
        character: participant,
        events: [...runtimeEventsV2WithCandidates, ...companionshipBackflowEvents],
      })),
    ...participants.flatMap((participant) => buildRitualEventsFromRelationshipRuntimeEvents({
        chat: conversation,
        character: participant,
        events: [...runtimeEventsV2WithCandidates, ...companionshipBackflowEvents],
      })),
  ];
  chatPatch.runtimeEventsV2 = appendAttentionCandidateEvent(
    runtimeEventsV2WithCompanionshipBackflow,
    buildAttentionCandidateEvent({ conversation, message, participants }),
  );

  return {
    ...pruneUnchangedChatRuntimePatch(conversation, chatPatch),
    localDistillationEvent: chatDistillationResult.debugInfo
      ? createMemoryDistillationRuntimeEvent(localizeDistillationEventInfo(chatDistillationResult.debugInfo, participants))
      : null,
  } as Partial<GroupChat> & { localDistillationEvent?: DriverEventPayload | null };
}
