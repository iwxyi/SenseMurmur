import type { DriverMessageCommitResult, GroupChat } from '../../types/chat';
import { createDefaultConversationEngineDefinition } from '../../types/sessionEngine';
import type { SessionEngineDefinition, SessionRuntimeContextBundle } from '../../types/sessionEngine';
import type { AICharacter } from '../../types/character';
import type { Message } from '../../types/message';
import type {
  InteractionEventPayload,
  DirectorInterventionPayload,
  MemoryCandidatePayload,
  RuntimeEventV2,
  SocialEventCandidatePayload,
  SocialEventHintEnvelope,
} from '../../types/runtimeEvent';
import { normalizeSocialEventHints } from '../../types/runtimeEvent';
import { DEFAULT_OPEN_CHAT_MODE_CONFIG, DEFAULT_OPEN_CHAT_MODE_STATE } from '../../types/chat';
import { buildChatPatch, buildNextWorldState, buildRelationshipTransition, buildWorldRuntimeEvents } from '../chatRuntimeTransitionBuilder';
import { applyInteractionEmotions, getEmotionalBaseline } from '../personalityDrift';
import { projectInnerLife } from '../innerLifeEngine';
import { canApplyRelationshipInteraction, getRelationshipLedgerEntry, inferRelationshipDelta, reduceRelationshipLedger, summarizeRelationshipDelta } from '../relationshipLedger';
import { calculateRoomShift, hasRoomShiftSignal, selectDominantInteraction } from '../roomStateSynthesizer';
import { resolveRuntimeEvolutionConfig } from '../runtimeEvolutionConfig';
import type { APIConfig } from '../../types/settings';
import { getGuidanceTargetActorIds } from '../userGuidanceIntent';
import { assessUserGuidance } from '../userGuidanceAssessment';
import { orchestrateWorldDecision } from '../worldDecisionOrchestrator';
import { buildMomentPostText } from '../momentTextBuilder';
import { isCharacterFeatureEnabled } from '../characterGenerationPolicy';
import { isPostMomentDelaySourceEventKind, resolvePostMomentPublishGuard } from '../postMomentPublishPolicy';
import { applyConversationUpdate } from '../conversationContinuity';
import { retainRuntimeEvents } from '../runtimeEventRetention';
import { buildSocialIntentArtifact, buildSocialIntentOutcomes } from '../socialIntentArtifact';

const MAX_OPEN_CHAT_RUNTIME_EVENTS = 120;

function buildRuntimeContextBundle(params: { conversation: GroupChat; speaker: { id: string } }): SessionRuntimeContextBundle {
  return {
    turnPlan: {
      speakerId: params.speaker.id,
      obligation: params.conversation.type === 'group' ? 'can' : 'should',
      moveClass: params.conversation.type === 'group' ? 'advance' : 'respond',
      targetScope: params.conversation.type === 'group' ? 'room' : 'person',
      depth: 'normal',
      channelId: 'public',
      reason: `open_chat:${params.conversation.type}`,
    },
    expressionPlan: {
      surface: params.conversation.type === 'direct' || params.conversation.type === 'ai_direct' ? 'companion' : 'casual',
      texture: 'ordinary',
      rhythm: params.conversation.type === 'group' ? 'back_and_forth' : 'one_shot',
      allowMarkdown: true,
    },
    realizationPlan: {
      moveClass: params.conversation.type === 'group' ? 'advance' : 'respond',
      targetScope: params.conversation.type === 'group' ? 'room' : 'person',
      noveltyGoal: params.conversation.type === 'group' ? 'new_angle' : 'none',
      surfaceDepth: 'normal',
      emotionalPosture: params.conversation.type === 'group' ? 'playful' : 'warm',
    },
    trace: {
      policyHits: [`open_chat:${params.conversation.type}`],
    },
  };
}

type OpenChatCommittedMessage = Pick<Message, 'content' | 'type' | 'senderId' | 'metadata'> & Partial<Pick<Message, 'id' | 'timestamp'>> & {
  interactionHint?: InteractionEventPayload | null;
  interactionHints?: InteractionEventPayload[] | null;
  incomingInteractionHint?: InteractionEventPayload | null;
  socialEventHints?: SocialEventHintEnvelope[] | null;
  conflictFocus?: import('../../types/runtimeEvent').ConflictFocusPayload | null;
};

function areRuntimeValuesEqual(left: unknown, right: unknown) {
  if (left === right) return true;
  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  } catch {
    return false;
  }
}

function setChangedChatPatchField<K extends keyof GroupChat>(patch: Partial<GroupChat>, conversation: GroupChat, key: K, value: GroupChat[K]) {
  if (!areRuntimeValuesEqual(value, conversation[key])) {
    patch[key] = value;
  } else {
    delete patch[key];
  }
}

function resolveEventTimestamp(createdAt?: number) {
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? Math.round(createdAt) : Date.now();
}

function stableEventSeed(parts: Array<string | number | undefined>) {
  const joined = parts.filter((item) => item !== undefined && item !== null && String(item).length > 0).join('|');
  let hash = 0;
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 31 + joined.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function buildRuntimeEventsDelta(conversation: GroupChat, nextEvents: RuntimeEventV2[]) {
  const previousById = new Map((conversation.runtimeEventsV2 || []).map((event) => [event.id, event] as const));
  const upserts = nextEvents.filter((event) => !areRuntimeValuesEqual(previousById.get(event.id), event));
  if (!upserts.length && nextEvents.length === (conversation.runtimeEventsV2 || []).length) return undefined;
  return {
    baseIds: (conversation.runtimeEventsV2 || []).map((event) => event.id),
    orderedIds: nextEvents.map((event) => event.id),
    upserts,
  };
}

function buildRelationshipLedgerDelta(conversation: GroupChat, nextLedger: NonNullable<GroupChat['relationshipLedger']>) {
  const previousByKey = new Map((conversation.relationshipLedger || []).map((entry) => [entry.pairKey, entry] as const));
  const upserts = nextLedger.filter((entry) => !areRuntimeValuesEqual(previousByKey.get(entry.pairKey), entry));
  if (!upserts.length && nextLedger.length === (conversation.relationshipLedger || []).length) return undefined;
  return {
    basePairKeys: (conversation.relationshipLedger || []).map((entry) => entry.pairKey),
    orderedPairKeys: nextLedger.map((entry) => entry.pairKey),
    upserts,
  };
}

function createRuntimeEventV2(params: {
  conversationId: string;
  kind: RuntimeEventV2['kind'];
  summary: string;
  payload: RuntimeEventV2['payload'];
  actorIds?: string[];
  targetIds?: string[];
  evidenceMessageIds?: string[];
  visibility?: RuntimeEventV2['visibility'];
  visibleToIds?: string[];
  visibleToRoles?: string[];
  createdAt?: number;
}): RuntimeEventV2 {
  const createdAt = resolveEventTimestamp(params.createdAt);
  const seed = stableEventSeed([
    params.conversationId,
    params.kind,
    createdAt,
    params.summary.slice(0, 80),
    (params.actorIds || []).join(','),
    (params.targetIds || []).join(','),
  ]);
  return {
    id: `evt_${createdAt}_${seed}`,
    conversationId: params.conversationId,
    kind: params.kind,
    createdAt,
    actorIds: params.actorIds,
    targetIds: params.targetIds,
    evidenceMessageIds: params.evidenceMessageIds,
    summary: params.summary,
    channelId: params.visibility === 'pair_private' ? 'pair-private' : params.visibility === 'moderator_only' ? 'moderator' : 'public',
    eventClass: params.kind === 'artifact' ? 'artifact' : params.kind === 'room_shift' ? 'phase' : params.kind === 'event_candidate' ? 'action' : 'message',
    visibility: params.visibility || 'public',
    visibleToIds: params.visibleToIds,
    visibleToRoles: params.visibleToRoles,
    payload: params.payload,
  };
}

async function resolveInteraction(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'type' | 'senderId'> & { interactionHint?: InteractionEventPayload | null; interactionHints?: InteractionEventPayload[] | null; socialEventHints?: SocialEventHintEnvelope[] | null; conflictFocus?: import('../../types/runtimeEvent').ConflictFocusPayload | null };
  characters: AICharacter[];
  recentMessages?: Message[];
  apiConfig?: APIConfig;
}) {
  void params.conversation;
  void params.characters;
  void params.recentMessages;
  void params.apiConfig;
  const hints = params.message.interactionHints?.length
    ? params.message.interactionHints
    : params.message.interactionHint ? [params.message.interactionHint] : [];
  return selectDominantInteraction(hints.filter((hint): hint is InteractionEventPayload => Boolean(hint)));
}

function buildMemoryCandidateFromStructuredEvent(event: RuntimeEventV2): RuntimeEventV2 | null {
  if (event.kind === 'interaction') {
    const payload = event.payload as InteractionEventPayload;
    if (!payload.targetId) return null;
    const memoryPayload: MemoryCandidatePayload = {
      kind: 'relationship',
      text: event.summary.slice(0, 128),
      salience: Math.min(1, 0.45 + (payload.intensity * 0.1)),
      confidence: payload.confidence,
    };
    return createRuntimeEventV2({
      conversationId: event.conversationId,
      kind: 'memory_candidate',
      summary: memoryPayload.text,
      actorIds: event.actorIds,
      targetIds: event.targetIds,
      payload: memoryPayload,
    });
  }
  if (event.kind === 'room_shift') {
    const memoryPayload: MemoryCandidatePayload = {
      kind: 'topic',
      text: event.summary.slice(0, 128),
      salience: 0.58,
      confidence: 0.78,
    };
    return createRuntimeEventV2({
      conversationId: event.conversationId,
      kind: 'memory_candidate',
      summary: memoryPayload.text,
      actorIds: event.actorIds,
      targetIds: event.targetIds,
      payload: memoryPayload,
    });
  }
  return null;
}

function buildArtifactEvent(params: { conversation: GroupChat; message: Pick<Message, 'content' | 'senderId'> }): RuntimeEventV2 | null {
  if (!/(总结|共识|方案|清单|计划|summary|plan|checklist)/i.test(params.message.content)) return null;
  return createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'artifact',
    summary: params.message.content.trim().slice(0, 128),
    actorIds: [params.message.senderId],
    payload: { text: params.message.content.trim().slice(0, 128) },
  });
}

function buildPairPrivateThreadCandidateFromHint(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  const hint = normalizeSocialEventHints(params.message.socialEventHints).find((item) => item.eventKind === 'pair_private_thread');
  if (!hint || (hint.confidence || 0) < 0.8) return null;
  const participantIds = (hint.participantIds || []).filter((id) => params.conversation.memberIds.includes(id));
  if (participantIds.length !== 2) return null;
  const payload: SocialEventCandidatePayload = {
    eventKind: 'pair_private_thread',
    initiatorId: params.message.senderId,
    participantIds,
    targetIds: hint.targetIds?.filter((id) => params.conversation.memberIds.includes(id)),
    reasonType: hint.reasonType || 'unresolved_question',
    confidence: Math.max(0.8, hint.confidence || 0),
    urgency: hint.urgency || 'soon',
    seedIntent: hint.seedIntent || '想私下继续聊刚才的话题。',
    visibilityPlan: hint.visibilityPlan || 'conversation_private',
    expectedArtifacts: hint.expectedArtifacts || ['private_thread_summary'],
    sourceText: params.message.content.trim().slice(0, 128),
    triggerReason: hint.triggerReason || hint.seedIntent || '当前群聊出现了适合转入双人私聊的未尽话题。',
    openingMessage: hint.openingMessage,
    title: hint.title,
    activityType: hint.activityType,
    timeHint: hint.timeHint ?? null,
    locationHint: hint.locationHint ?? null,
    dedupeKey: hint.dedupeKey ?? null,
  };
  return createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'event_candidate',
    summary: `${params.message.senderId} 提议与 ${participantIds.find((id) => id !== params.message.senderId) || participantIds[1]} 发起双人私聊候选`,
    actorIds: [params.message.senderId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload,
  });
}

function buildPostMomentCandidateFromHint(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  const hint = normalizeSocialEventHints(params.message.socialEventHints).find((item) => item.eventKind === 'post_moment');
  if (!hint || (hint.confidence || 0) < 0.8) return null;
  const payload: SocialEventCandidatePayload = {
    eventKind: 'post_moment',
    initiatorId: params.message.senderId,
    participantIds: [params.message.senderId],
    targetIds: hint.targetIds?.filter((id) => params.conversation.memberIds.includes(id)),
    reasonType: hint.reasonType || 'emotion_release',
    confidence: Math.max(0.8, hint.confidence || 0),
    urgency: hint.urgency || 'soon',
    seedIntent: hint.seedIntent || '想发一条和刚才气氛有关的朋友圈或动态。',
    visibilityPlan: hint.visibilityPlan || 'public',
    expectedArtifacts: hint.expectedArtifacts || ['moment_text'],
    sourceText: params.message.content.trim().slice(0, 128),
    title: hint.title,
    activityType: hint.activityType,
    timeHint: hint.timeHint ?? null,
    locationHint: hint.locationHint ?? null,
    dedupeKey: hint.dedupeKey ?? null,
  };
  return createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'event_candidate',
    summary: `${params.message.senderId} 提议发布一条 post_moment 动态`,
    actorIds: [params.message.senderId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload,
  });
}

function buildStatusUpdateCandidateFromHint(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  const hint = normalizeSocialEventHints(params.message.socialEventHints).find((item) => item.eventKind === 'status_update');
  if (!hint || (hint.confidence || 0) < 0.8) return null;
  const payload: SocialEventCandidatePayload = {
    eventKind: 'status_update',
    initiatorId: params.message.senderId,
    participantIds: [params.message.senderId],
    targetIds: hint.targetIds?.filter((id) => params.conversation.memberIds.includes(id)),
    reasonType: hint.reasonType || 'self_disclosure',
    confidence: Math.max(0.8, hint.confidence || 0),
    urgency: hint.urgency || 'soon',
    seedIntent: hint.seedIntent || '想同步一下自己当前的状态或近况。',
    visibilityPlan: hint.visibilityPlan || 'public',
    expectedArtifacts: hint.expectedArtifacts || ['status_note'],
    sourceText: params.message.content.trim().slice(0, 128),
    title: hint.title || '状态更新',
    activityType: hint.activityType,
    timeHint: hint.timeHint ?? null,
    locationHint: hint.locationHint ?? null,
    dedupeKey: hint.dedupeKey ?? null,
  };
  return createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'event_candidate',
    summary: `${params.message.senderId} 提议发布一条状态更新`,
    actorIds: [params.message.senderId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload,
  });
}

function buildStatusUpdateCandidate(params: {
  conversation: GroupChat;
  interaction: InteractionEventPayload | null;
  structuredRoomState: GroupChat['worldState']['structuredRoomState'];
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  void params.interaction;
  void params.structuredRoomState;
  return buildStatusUpdateCandidateFromHint(params);
}

function buildSocialIntentArtifactEvents(params: {
  conversation: GroupChat;
  socialEventCandidates: RuntimeEventV2[];
  characters: AICharacter[];
}, eventKind: SocialEventCandidatePayload['eventKind']): RuntimeEventV2[] {
  return params.socialEventCandidates
    .filter((event) => (event.payload as SocialEventCandidatePayload).eventKind === eventKind)
    .map((event) => {
      const payload = event.payload as SocialEventCandidatePayload;
      const actorName = params.characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
      const intent = buildSocialIntentArtifact(payload, actorName, event.id);
      if (!intent) throw new Error(`Unsupported social intent: ${eventKind}`);
      return createRuntimeEventV2({
        conversationId: params.conversation.id,
        kind: 'artifact',
        actorIds: [payload.initiatorId],
        targetIds: payload.targetIds,
        ...intent,
      });
    });
}

function buildStatusUpdateArtifactEvents(params: Parameters<typeof buildSocialIntentArtifactEvents>[0]): RuntimeEventV2[] {
  return buildSocialIntentArtifactEvents(params, 'status_update');
}

function buildCheckInArtifactEvents(params: Parameters<typeof buildSocialIntentArtifactEvents>[0]): RuntimeEventV2[] {
  return buildSocialIntentArtifactEvents(params, 'check_in');
}

function buildReactToMomentArtifactEvents(params: Parameters<typeof buildSocialIntentArtifactEvents>[0]): RuntimeEventV2[] {
  return buildSocialIntentArtifactEvents(params, 'react_to_moment');
}

function buildGiftExchangeCandidateFromHint(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  const hint = normalizeSocialEventHints(params.message.socialEventHints).find((item) => item.eventKind === 'gift_exchange');
  if (!hint || (hint.confidence || 0) < 0.8) return null;
  const payload: SocialEventCandidatePayload = {
    eventKind: 'gift_exchange',
    initiatorId: params.message.senderId,
    participantIds: (hint.participantIds || [params.message.senderId]).filter((id) => params.conversation.memberIds.includes(id)),
    targetIds: hint.targetIds?.filter((id) => params.conversation.memberIds.includes(id)),
    reasonType: hint.reasonType || 'care_gesture',
    confidence: Math.max(0.8, hint.confidence || 0),
    urgency: hint.urgency || 'soon',
    seedIntent: hint.seedIntent || '想送出一个小礼物或心意。',
    visibilityPlan: hint.visibilityPlan || 'public',
    expectedArtifacts: hint.expectedArtifacts || ['gift_note'],
    sourceText: params.message.content.trim().slice(0, 128),
    title: hint.title || '礼物互动',
    activityType: hint.activityType,
    timeHint: hint.timeHint ?? null,
    locationHint: hint.locationHint ?? null,
    dedupeKey: hint.dedupeKey ?? null,
  };
  return createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'event_candidate',
    summary: `${params.message.senderId} 提议触发一次礼物互动`,
    actorIds: [params.message.senderId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload,
  });
}

function buildGiftExchangeCandidate(params: {
  conversation: GroupChat;
  interaction: InteractionEventPayload | null;
  structuredRoomState: GroupChat['worldState']['structuredRoomState'];
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  void params.interaction;
  void params.structuredRoomState;
  return buildGiftExchangeCandidateFromHint(params);
}

function buildGiftExchangeArtifactEvents(params: Parameters<typeof buildSocialIntentArtifactEvents>[0]): RuntimeEventV2[] {
  return buildSocialIntentArtifactEvents(params, 'gift_exchange');
}

function shouldAutoBackflowGiftExchange(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  return !(chat.runtimeEventsV2 || []).some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string; eventKind?: string }).artifactType === 'gift_note' && (event.payload as { eventKind?: string }).eventKind === 'gift_exchange' && buildCandidateClusterKey(event.payload as SocialEventCandidatePayload) === buildCandidateClusterKey(payload) && event.createdAt >= createdAt);
}

function findRecentGiftExchangeBackflowEventId(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  const matched = (chat.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
    && (event.payload as { artifactType?: string; eventKind?: string }).artifactType === 'gift_note'
    && (event.payload as { eventKind?: string }).eventKind === 'gift_exchange'
    && buildCandidateClusterKey(event.payload as SocialEventCandidatePayload) === buildCandidateClusterKey(payload)
    && event.createdAt >= createdAt);
  return matched?.id || null;
}

function buildConflictExpressionCandidateFromHint(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  const hint = normalizeSocialEventHints(params.message.socialEventHints).find((item) => item.eventKind === 'conflict_expression');
  if (!hint || (hint.confidence || 0) < 0.8) return null;
  const payload: SocialEventCandidatePayload = {
    eventKind: 'conflict_expression',
    initiatorId: params.message.senderId,
    participantIds: (hint.participantIds || [params.message.senderId]).filter((id) => params.conversation.memberIds.includes(id)),
    targetIds: hint.targetIds?.filter((id) => params.conversation.memberIds.includes(id)),
    reasonType: hint.reasonType || 'frustration',
    confidence: Math.max(0.8, hint.confidence || 0),
    urgency: hint.urgency || 'soon',
    seedIntent: hint.seedIntent || '想把刚才的不满直接表达出来。',
    visibilityPlan: hint.visibilityPlan || 'public',
    expectedArtifacts: hint.expectedArtifacts || ['conflict_note'],
    sourceText: params.message.content.trim().slice(0, 128),
    title: hint.title || '冲突表达',
    activityType: hint.activityType,
    timeHint: hint.timeHint ?? null,
    locationHint: hint.locationHint ?? null,
    dedupeKey: hint.dedupeKey ?? null,
  };
  return createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'event_candidate',
    summary: `${params.message.senderId} 提议触发一次冲突表达`,
    actorIds: [params.message.senderId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload,
  });
}

function buildConflictExpressionArtifactEvents(params: Parameters<typeof buildSocialIntentArtifactEvents>[0]): RuntimeEventV2[] {
  return buildSocialIntentArtifactEvents(params, 'conflict_expression');
}

function shouldAutoBackflowStatusUpdate(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  return !(chat.runtimeEventsV2 || []).some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string; eventKind?: string }).artifactType === 'status_note' && (event.payload as { eventKind?: string }).eventKind === 'status_update' && buildCandidateClusterKey(event.payload as SocialEventCandidatePayload) === buildCandidateClusterKey(payload) && event.createdAt >= createdAt);
}

function findRecentStatusUpdateBackflowEventId(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  const matched = (chat.runtimeEventsV2 || []).find((event) => {
    if (event.kind !== 'artifact') return false;
    const artifactPayload = event.payload as { artifactType?: string; eventKind?: string };
    return artifactPayload.artifactType === 'status_note'
      && artifactPayload.eventKind === 'status_update'
      && buildCandidateClusterKey(event.payload as SocialEventCandidatePayload) === buildCandidateClusterKey(payload)
      && event.createdAt >= createdAt;
  });
  return matched?.id || null;
}

function shouldAutoBackflowCheckIn(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  const targetId = payload.targetIds?.[0] || 'user';
  return !(chat.runtimeEventsV2 || []).some((event) => {
    if (event.kind !== 'artifact') return false;
    const artifactPayload = event.payload as { artifactType?: string; eventKind?: string };
    if (artifactPayload.artifactType !== 'check_in_note' || artifactPayload.eventKind !== 'check_in') return false;
    const sameTarget = (event.targetIds || []).includes(targetId);
    const withinCooldown = createdAt - event.createdAt < 30 * 60_000;
    return sameTarget && withinCooldown;
  });
}

function findRecentCheckInBackflowEventId(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  const targetId = payload.targetIds?.[0] || 'user';
  const matched = (chat.runtimeEventsV2 || []).find((event) => {
    if (event.kind !== 'artifact') return false;
    const artifactPayload = event.payload as { artifactType?: string; eventKind?: string };
    if (artifactPayload.artifactType !== 'check_in_note' || artifactPayload.eventKind !== 'check_in') return false;
    const sameTarget = (event.targetIds || []).includes(targetId);
    const withinCooldown = createdAt - event.createdAt < 30 * 60_000;
    return sameTarget && withinCooldown;
  });
  return matched?.id || null;
}

function shouldAutoBackflowReactToMoment(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  return !(chat.runtimeEventsV2 || []).some((event) => {
    if (event.kind !== 'artifact') return false;
    const artifactPayload = event.payload as { artifactType?: string; eventKind?: string };
    if (artifactPayload.artifactType !== 'moment_reaction_note' || artifactPayload.eventKind !== 'react_to_moment') return false;
    const sameActor = (event.actorIds || [])[0] === payload.initiatorId;
    const withinCooldown = createdAt - event.createdAt < 45 * 60_000;
    return sameActor && withinCooldown;
  });
}

function findRecentReactToMomentBackflowEventId(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  const matched = (chat.runtimeEventsV2 || []).find((event) => {
    if (event.kind !== 'artifact') return false;
    const artifactPayload = event.payload as { artifactType?: string; eventKind?: string };
    if (artifactPayload.artifactType !== 'moment_reaction_note' || artifactPayload.eventKind !== 'react_to_moment') return false;
    const sameActor = (event.actorIds || [])[0] === payload.initiatorId;
    const withinCooldown = createdAt - event.createdAt < 45 * 60_000;
    return sameActor && withinCooldown;
  });
  return matched?.id || null;
}

function isQuietHours(timestamp: number) {
  const hour = new Date(timestamp).getHours();
  return hour >= 23 || hour < 7;
}

function findRecentUserPrivateActionEventId(chat: GroupChat, actorId: string, targetId: string, createdAt: number, cooldownMs: number) {
  const matched = (chat.runtimeEventsV2 || []).find((event) => {
    if (event.createdAt >= createdAt || createdAt - event.createdAt > cooldownMs) return false;
    const payload = event.payload as Partial<SocialEventCandidatePayload> & { eventKind?: string; visibilityPlan?: string };
    if (event.kind !== 'event_candidate' && event.kind !== 'artifact') return false;
    if (payload.visibilityPlan !== 'user_private' && payload.eventKind !== 'check_in' && payload.eventKind !== 'pair_private_thread') return false;
    const sameActor = (event.actorIds || [])[0] === actorId;
    const sameTarget = (event.targetIds || []).includes(targetId);
    return sameActor && sameTarget;
  });
  return matched?.id || null;
}

function findRecentReactMomentArtifacts(chat: GroupChat, actorId: string, createdAt: number, cooldownMs: number) {
  return (chat.runtimeEventsV2 || []).filter((event) => {
    if (event.createdAt >= createdAt || createdAt - event.createdAt > cooldownMs) return false;
    if (event.kind !== 'artifact') return false;
    const artifactPayload = event.payload as { artifactType?: string; eventKind?: string };
    return artifactPayload.artifactType === 'moment_reaction_note'
      && artifactPayload.eventKind === 'react_to_moment'
      && (event.actorIds || [])[0] === actorId;
  });
}

function findLatestActorSocialArtifact(chat: GroupChat, actorId: string, createdAt: number) {
  return (chat.runtimeEventsV2 || [])
    .filter((event) => {
      if (event.kind !== 'artifact') return false;
      if (event.createdAt >= createdAt) return false;
      if ((event.actorIds || [])[0] !== actorId) return false;
      const eventKind = (event.payload as { eventKind?: string }).eventKind || '';
      return ['social_outing', 'status_update', 'check_in', 'react_to_moment', 'gift_exchange', 'conflict_expression'].includes(eventKind);
    })
    .sort((left, right) => right.createdAt - left.createdAt)[0];
}

function resolveAttentionRestraintFailureDetail(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number): {
  detail: string;
  hitEventId?: string;
  hitWindow?: string;
} | undefined {
  const actorId = payload.initiatorId;
  if (!actorId || actorId === 'user') return undefined;
  if (payload.reasonType === 'world_attention_share_moment') {
    const latestSocialArtifact = findLatestActorSocialArtifact(chat, actorId, createdAt);
    if (!latestSocialArtifact) return { detail: '缺少近期可投射为动态的事件触发，不生成发圈候选' };
    const ageMs = createdAt - latestSocialArtifact.createdAt;
    if (ageMs < 15 * 60_000) {
      return {
        detail: `事件结束后间隔过短（${Math.round(ageMs / 60_000)}min < 15min），避免立刻发圈`,
        hitEventId: latestSocialArtifact.id,
        hitWindow: '15min',
      };
    }
    if (ageMs > 6 * 60 * 60_000) {
      return {
        detail: `事件已过久（${Math.round(ageMs / 60_000)}min > 360min），避免机械补发`,
        hitEventId: latestSocialArtifact.id,
        hitWindow: '6h',
      };
    }
  }
  const targetId = payload.targetIds?.[0] || 'user';
  if (targetId !== 'user') return undefined;
  const relation = getRelationshipLedgerEntry(chat.relationshipLedger || [], actorId, targetId);
  const warmth = relation?.current.warmth || 0;
  const trust = relation?.current.trust || 0;
  const threat = relation?.current.threat || 0;
  const relationSignal = warmth + trust;
  const worldAttentionInvite = payload.reasonType === 'world_attention_invite_activity';
  const worldAttentionReminder = payload.reasonType === 'world_attention_calendar_reminder';
  if (worldAttentionInvite || worldAttentionReminder) {
    if (threat >= 8) return { detail: `威胁值过高（threat=${threat}），不适合世界关注动作` };
  }
  if (worldAttentionInvite) {
    if (relationSignal < 8) return { detail: `关系信号不足（warmth+trust=${relationSignal} < 8），不触发邀约` };
    if (isQuietHours(createdAt)) return { detail: '夜间时段不触发世界关注邀约' };
    const recentPrivateActionId = findRecentUserPrivateActionEventId(chat, actorId, targetId, createdAt, 3 * 60 * 60_000);
    if (recentPrivateActionId) {
      return {
        detail: `近期已存在用户私域动作（3h），不重复邀约（hit=${recentPrivateActionId}）`,
        hitEventId: recentPrivateActionId,
        hitWindow: '3h',
      };
    }
  }
  if (worldAttentionReminder) {
    if (relationSignal < 6) return { detail: `关系信号不足（warmth+trust=${relationSignal} < 6），不触发提醒` };
    if (isQuietHours(createdAt) && relationSignal < 10) return { detail: `夜间且关系信号不足（${relationSignal} < 10），不触发提醒` };
    const recentPrivateActionId = findRecentUserPrivateActionEventId(chat, actorId, targetId, createdAt, 2 * 60 * 60_000);
    if (recentPrivateActionId) {
      return {
        detail: `近期已存在用户私域动作（2h），不重复提醒（hit=${recentPrivateActionId}）`,
        hitEventId: recentPrivateActionId,
        hitWindow: '2h',
      };
    }
  }
  if (payload.eventKind === 'check_in') {
    if (threat >= 8) return { detail: `威胁值过高（threat=${threat}），不触发问候` };
    if (relation && warmth + trust < 3) return { detail: `关系信号过弱（warmth+trust=${warmth + trust} < 3），不触发问候` };
    if (isQuietHours(createdAt) && (relation ? warmth + trust < 9 : true)) return { detail: `夜间且关系信号不足（${relation ? warmth + trust : 0} < 9），不触发问候` };
    const recentPrivateActionId = findRecentUserPrivateActionEventId(chat, actorId, targetId, createdAt, 90 * 60_000);
    if (recentPrivateActionId) {
      return {
        detail: `近期已存在用户私域动作（90min），不重复问候（hit=${recentPrivateActionId}）`,
        hitEventId: recentPrivateActionId,
        hitWindow: '90min',
      };
    }
  }
  if (payload.eventKind === 'react_to_moment') {
    if (isQuietHours(createdAt)) return { detail: '夜间时段不触发动态回应' };
    const recentReactions = findRecentReactMomentArtifacts(chat, actorId, createdAt, 2 * 60 * 60_000);
    const recentReactionCount = recentReactions.length;
    if (recentReactionCount >= 2) {
      return {
        detail: `近期动态回应过多（${recentReactionCount} 次/2h），不重复回应`,
        hitEventId: recentReactions[0]?.id,
        hitWindow: '2h',
      };
    }
  }
  return undefined;
}

function passesAttentionRestraintPolicy(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  return !resolveAttentionRestraintFailureDetail(chat, payload, createdAt)?.detail;
}

void buildGiftExchangeCandidate;
void buildGiftExchangeCandidateFromHint;
void buildGiftExchangeArtifactEvents;
void buildStatusUpdateCandidate;
void buildStatusUpdateCandidateFromHint;
void buildStatusUpdateArtifactEvents;

async function resolveSocialEventHints(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'type' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
  characters: AICharacter[];
  recentMessages?: Message[];
  apiConfig?: APIConfig;
}) {
  void params.conversation;
  void params.characters;
  void params.recentMessages;
  void params.apiConfig;
  const hints = normalizeSocialEventHints(params.message.socialEventHints)
    .filter((hint) => !hint.evidenceText || params.message.content.includes(hint.evidenceText));
  return hints.length ? hints : null;
}

function buildPostMomentCandidate(params: {
  conversation: GroupChat;
  characters: AICharacter[];
  interaction: InteractionEventPayload | null;
  structuredRoomState: GroupChat['worldState']['structuredRoomState'];
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  void params.interaction;
  void params.structuredRoomState;
  const actor = params.characters.find((item) => item.id === params.message.senderId) || null;
  if (actor && !isCharacterFeatureEnabled(actor, 'moments')) return null;
  const hinted = buildPostMomentCandidateFromHint(params);
  if (!hinted) return null;
  const now = Date.now();
  const lastSocialArtifactAt = (params.conversation.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact' && ['social_outing', 'check_in', 'react_to_moment', 'status_update', 'gift_exchange'].includes((event.payload as { eventKind?: string }).eventKind || ''))
    .map((event) => event.createdAt)
    .sort((a, b) => b - a)[0];
  if (typeof lastSocialArtifactAt === 'number' && now - lastSocialArtifactAt < 18 * 60 * 60_000) return null;
  const payload = hinted.payload as SocialEventCandidatePayload;
  const modeSeed = Math.abs(stableEventSeed([params.conversation.id, params.message.senderId, Math.floor(now / (60 * 60_000))]).split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0));
  const modeVariant = modeSeed % 3;
  const expectedArtifacts = payload.expectedArtifacts?.length
    ? payload.expectedArtifacts
    : (modeVariant === 0 ? ['moment_text', 'moment_group_photo'] : modeVariant === 1 ? ['moment_text', 'moment_selfie'] : ['moment_text']);
  const activityType = payload.activityType
    || (modeVariant === 0 ? '关系互动' : modeVariant === 1 ? '随拍' : '情绪碎片');
  const title = payload.title
    || (modeVariant === 0 ? '朋友圈动态' : modeVariant === 1 ? '随手一拍' : '今日碎片');
  return {
    ...hinted,
    payload: {
      ...payload,
      title,
      activityType,
      expectedArtifacts,
      confidence: payload.confidence,
      reasonType: payload.reasonType || 'emotion_release',
      urgency: payload.urgency === 'immediate' ? 'soon' : payload.urgency,
    },
  } satisfies RuntimeEventV2;
}

function buildSocialOutingCandidateFromHint(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  const hint = normalizeSocialEventHints(params.message.socialEventHints).find((item) => item.eventKind === 'social_outing');
  if (!hint) return null;
  const confidence = hint.confidence ?? 0.84;
  if (confidence < 0.72) return null;
  const memberIds = new Set(params.conversation.memberIds);
  const existingOuting = findExistingSocialOutingPayload(params.conversation, hint.dedupeKey);
  const validStateParticipantIds = Object.keys(hint.participantStates || {}).filter((id) => memberIds.has(id));
  const validParticipantIds = (hint.participantIds || []).filter((id) => memberIds.has(id));
  const validTargetIds = (hint.targetIds || []).filter((id) => memberIds.has(id));
  const participantIds = Array.from(new Set([
    ...validParticipantIds,
    ...validStateParticipantIds,
    ...(memberIds.has(params.message.senderId) ? [params.message.senderId] : []),
    ...validTargetIds,
  ]));
  const counterpartIds = participantIds.filter((id) => id !== params.message.senderId);
  const isExistingActivityUpdate = Boolean(existingOuting);
  if (!counterpartIds.length && !isExistingActivityUpdate) return null;
  const participantStates = Object.fromEntries(
    participantIds.map((id) => [
      id,
      hint.participantStates?.[id] || (id === params.message.senderId ? 'interested' : 'invited'),
    ]),
  ) as SocialEventCandidatePayload['participantStates'];
  const fallbackTargetIds = isExistingActivityUpdate
    ? (existingOuting?.targetIds || existingOuting?.participantIds || []).filter((id) => memberIds.has(id) && id !== params.message.senderId)
    : counterpartIds;
  const payload: SocialEventCandidatePayload = {
    eventKind: 'social_outing',
    initiatorId: params.message.senderId,
    organizerId: existingOuting?.organizerId || existingOuting?.initiatorId || params.message.senderId,
    participantIds,
    targetIds: validTargetIds.length ? validTargetIds : fallbackTargetIds,
    reasonType: hint.reasonType || 'celebration',
    confidence: Math.max(0.72, confidence),
    urgency: hint.urgency || 'soon',
    seedIntent: hint.seedIntent || '想把刚才群里的热络气氛延续成一次线下活动。',
    visibilityPlan: hint.visibilityPlan || 'public',
    expectedArtifacts: hint.expectedArtifacts || ['outing_summary', 'group_photo', 'food_photo'],
    sourceText: params.message.content.trim().slice(0, 128),
    title: hint.title || '线下活动',
    activityType: hint.activityType || undefined,
    timeHint: hint.timeHint ?? null,
    locationHint: hint.locationHint ?? null,
    dedupeKey: hint.dedupeKey ?? null,
    participantStates,
  };
  return createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'event_candidate',
    summary: `${params.message.senderId} 提议触发${payload.title || '线下活动'}`,
    actorIds: [params.message.senderId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload,
  });
}

function findExistingSocialOutingPayload(conversation: GroupChat, dedupeKey: string | null | undefined) {
  if (!dedupeKey) return null;
  const matched = [...(conversation.runtimeEventsV2 || [])].reverse().find((event) => {
    if (event.kind !== 'event_candidate' && event.kind !== 'artifact') return false;
    const payload = event.payload as Partial<SocialEventCandidatePayload>;
    return payload.eventKind === 'social_outing' && payload.dedupeKey === dedupeKey;
  });
  return matched ? matched.payload as Partial<SocialEventCandidatePayload> : null;
}

function buildRejectedSocialOutingHintDiagnostic(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}): RuntimeEventV2 | null {
  const hint = normalizeSocialEventHints(params.message.socialEventHints).find((item) => item.eventKind === 'social_outing');
  if (!hint) return null;
  if ((hint.confidence ?? 0.84) < 0.72) {
    return createRuntimeEventV2({
      conversationId: params.conversation.id,
      kind: 'action_resolution',
      summary: '活动结构化字段已拒绝：置信度过低',
      actorIds: [params.message.senderId],
      targetIds: [],
      visibility: 'moderator_only',
      payload: {
        eventType: 'structured_social_event_hint_rejected',
        candidateEventKind: 'social_outing',
        reasonType: 'low_confidence',
        reasonLabel: 'social_outing 置信度低于活动候选阈值',
        confidence: hint.confidence ?? null,
        threshold: 0.72,
        source: 'model_structured_output',
      },
    });
  }
  if (buildSocialOutingCandidateFromHint(params)) return null;
  const memberIds = new Set(params.conversation.memberIds);
  const rawParticipantIds = hint.participantIds || [];
  const rawTargetIds = hint.targetIds || [];
  const invalidParticipantIds = rawParticipantIds.filter((id) => !memberIds.has(id));
  const invalidTargetIds = rawTargetIds.filter((id) => !memberIds.has(id));
  return createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'action_resolution',
    summary: '活动结构化字段已拒绝：缺少有效参与者或目标成员',
    actorIds: [params.message.senderId],
    targetIds: [],
    visibility: 'moderator_only',
    payload: {
      eventType: 'structured_social_event_hint_rejected',
      candidateEventKind: 'social_outing',
      reasonType: 'invalid_participants',
      reasonLabel: 'social_outing 缺少发起者之外的有效会话成员',
      confidence: hint.confidence || null,
      rawParticipantIds,
      rawTargetIds,
      invalidParticipantIds,
      invalidTargetIds,
      validMemberIds: params.conversation.memberIds,
      source: 'model_structured_output',
    },
  });
}

function normalizeSemanticText(value: string | null | undefined) {
  return (value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?:;：；“”"'‘’（）()【】[\]-]/g, '');
}

function normalizeSemanticParticipantSet(ids: string[] | undefined) {
  return [...new Set((ids || []).filter(Boolean))].sort().join(',');
}

function buildCandidateClusterKey(payload: SocialEventCandidatePayload) {
  return payload.dedupeKey || `${payload.eventKind}::${payload.title || ''}::${payload.activityType || ''}::${payload.timeHint || ''}::${payload.locationHint || ''}::${[...(payload.participantIds || [])].sort().join(',')}::${[...(payload.targetIds || [])].sort().join(',')}`;
}

function buildSemanticCandidateKey(payload: SocialEventCandidatePayload) {
  return [
    payload.eventKind,
    normalizeSemanticText(payload.title),
    normalizeSemanticText(payload.activityType),
    normalizeSemanticText(payload.timeHint),
    normalizeSemanticText(payload.locationHint),
    normalizeSemanticParticipantSet(payload.participantIds),
    normalizeSemanticParticipantSet(payload.targetIds),
  ].join('::');
}

function areCandidatesSemanticallySimilar(left: SocialEventCandidatePayload, right: SocialEventCandidatePayload) {
  if (left.eventKind !== right.eventKind) return false;
  if (buildSemanticCandidateKey(left) === buildSemanticCandidateKey(right)) return true;
  if (left.eventKind === 'social_outing') {
    const sameParticipants = normalizeSemanticParticipantSet(left.participantIds) === normalizeSemanticParticipantSet(right.participantIds);
    const sameActivity = normalizeSemanticText(left.activityType || left.title) === normalizeSemanticText(right.activityType || right.title);
    const sameTime = normalizeSemanticText(left.timeHint) === normalizeSemanticText(right.timeHint);
    return sameParticipants && sameActivity && Boolean(sameActivity) && sameTime;
  }
  if (left.eventKind === 'post_moment') {
    const sameInitiator = left.initiatorId === right.initiatorId;
    const sameTopic = normalizeSemanticText(left.activityType || left.title || left.seedIntent) === normalizeSemanticText(right.activityType || right.title || right.seedIntent);
    return sameInitiator && sameTopic && Boolean(sameTopic);
  }
  if (left.eventKind === 'pair_private_thread') {
    return normalizeSemanticParticipantSet(left.participantIds) === normalizeSemanticParticipantSet(right.participantIds);
  }
  return false;
}

function choosePreferredText(current: string | undefined | null, incoming: string | undefined | null) {
  return (incoming && incoming.trim().length > (current || '').trim().length ? incoming : current) || current || incoming || undefined;
}

function choosePreferredConfidence(current: number | undefined, incoming: number | undefined) {
  return Math.max(current || 0, incoming || 0);
}

function mergeCandidatePayloads(existing: SocialEventCandidatePayload, incoming: SocialEventCandidatePayload, fallbackKey: string): SocialEventCandidatePayload {
  return {
    ...existing,
    ...incoming,
    ...(existing.eventKind === 'social_outing' ? { organizerId: existing.organizerId || existing.initiatorId } : {}),
    dedupeKey: existing.dedupeKey || incoming.dedupeKey || fallbackKey,
    title: choosePreferredText(existing.title, incoming.title),
    activityType: choosePreferredText(existing.activityType, incoming.activityType),
    timeHint: choosePreferredText(existing.timeHint || undefined, incoming.timeHint || undefined) ?? null,
    locationHint: choosePreferredText(existing.locationHint || undefined, incoming.locationHint || undefined) ?? null,
    seedIntent: choosePreferredText(existing.seedIntent, incoming.seedIntent) || incoming.seedIntent,
    triggerReason: choosePreferredText(existing.triggerReason, incoming.triggerReason),
    openingMessage: choosePreferredText(existing.openingMessage, incoming.openingMessage),
    sourceText: choosePreferredText(existing.sourceText, incoming.sourceText),
    confidence: choosePreferredConfidence(existing.confidence, incoming.confidence),
    participantIds: Array.from(new Set([...(existing.participantIds || []), ...(incoming.participantIds || [])])),
    targetIds: Array.from(new Set([...(existing.targetIds || []), ...(incoming.targetIds || [])])),
    expectedArtifacts: Array.from(new Set([...(existing.expectedArtifacts || []), ...(incoming.expectedArtifacts || [])])),
  };
}

function mergeCandidateEvents(existing: RuntimeEventV2, incoming: RuntimeEventV2) {
  const existingPayload = existing.payload as SocialEventCandidatePayload;
  const incomingPayload = incoming.payload as SocialEventCandidatePayload;
  const fallbackKey = existingPayload.dedupeKey || incomingPayload.dedupeKey || buildSemanticCandidateKey(existingPayload);
  const mergedPayload = mergeCandidatePayloads(existingPayload, incomingPayload, fallbackKey);
  return {
    ...incoming,
    summary: existing.summary.length >= incoming.summary.length ? existing.summary : incoming.summary,
    targetIds: Array.from(new Set([...(existing.targetIds || []), ...(incoming.targetIds || [])])),
    payload: mergedPayload,
  } satisfies RuntimeEventV2;
}

function findSemanticallySimilarExisting(chat: GroupChat, payload: SocialEventCandidatePayload) {
  return (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'event_candidate')
    .find((event) => areCandidatesSemanticallySimilar(event.payload as SocialEventCandidatePayload, payload)) || null;
}

function mergeCandidatesWithinBatch(events: RuntimeEventV2[]) {
  const merged: RuntimeEventV2[] = [];
  for (const event of events) {
    const payload = event.payload as SocialEventCandidatePayload;
    const index = merged.findIndex((item) => areCandidatesSemanticallySimilar(item.payload as SocialEventCandidatePayload, payload));
    if (index === -1) {
      merged.push(event);
      continue;
    }
    merged[index] = mergeCandidateEvents(merged[index], event);
  }
  return merged;
}

type CandidateSuppressionReason =
  | 'restraint_policy'
  | 'world_attention_moment_disabled'
  | 'world_attention_moment_quiet_hours'
  | 'world_attention_moment_spam_window'
  | 'world_attention_moment_delay_window'
  | 'dedupe_backflow_post_moment'
  | 'dedupe_backflow_social_outing'
  | 'dedupe_backflow_status_update'
  | 'dedupe_backflow_check_in'
  | 'dedupe_backflow_react_to_moment'
  | 'dedupe_backflow_gift_exchange'
  | 'dedupe_semantic_existing_newer'
  | 'dedupe_key_duplicate';

type CandidateSuppressionRecord = {
  event: RuntimeEventV2;
  reason: CandidateSuppressionReason;
  detail?: string;
  suppressedConfidence?: number;
  preferredConfidence?: number;
  preferredCandidateId?: string;
  suppressedCandidateId?: string;
  hitEventId?: string;
  hitWindow?: string;
  nextSuggestedAt?: number;
};

function dedupeSemanticCandidates(chat: GroupChat, candidates: RuntimeEventV2[]) {
  const merged = mergeCandidatesWithinBatch(candidates);
  const kept: RuntimeEventV2[] = [];
  const suppressed: CandidateSuppressionRecord[] = [];
  merged.forEach((event) => {
    const payload = event.payload as SocialEventCandidatePayload;
    const existing = findSemanticallySimilarExisting(chat, payload);
    if (!existing) {
      kept.push(event);
      return;
    }
    if (existing.createdAt >= event.createdAt) {
      const incomingConfidence = (payload.confidence || 0);
      const existingPayload = existing.payload as SocialEventCandidatePayload;
      const existingConfidence = (existingPayload.confidence || 0);
      suppressed.push({
        event,
        reason: 'dedupe_semantic_existing_newer',
        detail: `语义重复且已有候选更新（existing=${existing.createdAt}, incoming=${event.createdAt}）`,
        suppressedConfidence: incomingConfidence,
        preferredConfidence: existingConfidence,
        preferredCandidateId: existing.id,
        suppressedCandidateId: event.id,
      });
      return;
    }
    kept.push({
      ...mergeCandidateEvents(existing, event),
      id: existing.id,
      createdAt: existing.createdAt,
    } satisfies RuntimeEventV2);
  });
  return { candidates: kept, suppressed };
}

function buildCandidateDedupeKey(payload: SocialEventCandidatePayload) {
  return payload.dedupeKey || buildCandidateClusterKey(payload) || buildSemanticCandidateKey(payload);
}

function dedupeByKey(candidates: RuntimeEventV2[]) {
  const seen = new Map<string, { index: number; event: RuntimeEventV2 }>();
  const kept: RuntimeEventV2[] = [];
  const suppressed: CandidateSuppressionRecord[] = [];
  candidates.forEach((event) => {
    const payload = event.payload as SocialEventCandidatePayload;
    const dedupeKey = buildCandidateDedupeKey(payload);
    const previous = seen.get(dedupeKey);
    if (previous) {
      const merged = mergeCandidateEvents(previous.event, event);
      const preferIncoming = (payload.confidence || 0) > (((previous.event.payload as SocialEventCandidatePayload).confidence) || 0);
      const winner = preferIncoming ? merged : { ...merged, id: previous.event.id, createdAt: previous.event.createdAt } as RuntimeEventV2;
      kept[previous.index] = winner;
      seen.set(dedupeKey, { index: previous.index, event: winner });
      const suppressedEvent = preferIncoming ? previous.event : event;
      const suppressedConfidence = ((suppressedEvent.payload as SocialEventCandidatePayload).confidence) || 0;
      const preferredConfidence = (((winner.payload as SocialEventCandidatePayload).confidence) || 0);
      const detail = preferIncoming
        ? `同 key 候选中保留更高置信度候选（${preferredConfidence.toFixed(2)} > ${suppressedConfidence.toFixed(2)}）`
        : `同 key 候选中保留先前更高置信度候选（${preferredConfidence.toFixed(2)} >= ${suppressedConfidence.toFixed(2)}）`;
      suppressed.push({
        event: suppressedEvent,
        reason: 'dedupe_key_duplicate',
        detail,
        suppressedConfidence,
        preferredConfidence,
        preferredCandidateId: winner.id,
        suppressedCandidateId: suppressedEvent.id,
      });
      return;
    }
    seen.set(dedupeKey, { index: kept.length, event });
    kept.push(event);
  });
  return { candidates: kept, suppressed };
}

function dedupeSocialEventCandidates(chat: GroupChat, candidates: RuntimeEventV2[]) {
  const semantic = dedupeSemanticCandidates(chat, candidates);
  const keyed = dedupeByKey(semantic.candidates);
  return {
    candidates: keyed.candidates,
    suppressed: [...semantic.suppressed, ...keyed.suppressed],
  };
}

function legacyBuildExistingCandidateClusterMap() {
  return new Map<string, RuntimeEventV2>();
}

void legacyBuildExistingCandidateClusterMap;


function shouldAutoBackflowMoment(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  return !(chat.runtimeEventsV2 || []).some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string; eventKind?: string }).artifactType === 'moment_text' && (event.payload as { eventKind?: string }).eventKind === 'post_moment' && buildCandidateClusterKey(event.payload as SocialEventCandidatePayload) === buildCandidateClusterKey(payload) && event.createdAt >= createdAt);
}

function findRecentMomentBackflowEventId(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  const matched = (chat.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
    && (event.payload as { artifactType?: string; eventKind?: string }).artifactType === 'moment_text'
    && (event.payload as { eventKind?: string }).eventKind === 'post_moment'
    && buildCandidateClusterKey(event.payload as SocialEventCandidatePayload) === buildCandidateClusterKey(payload)
    && event.createdAt >= createdAt);
  return matched?.id || null;
}

function findRecentOutingBackflowEventId(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  const matched = (chat.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
    && (event.payload as { artifactType?: string; eventKind?: string }).artifactType === 'outing_summary'
    && (event.payload as { eventKind?: string }).eventKind === 'social_outing'
    && buildCandidateClusterKey(event.payload as SocialEventCandidatePayload) === buildCandidateClusterKey(payload)
    && event.createdAt >= createdAt);
  return matched?.id || null;
}

function candidateSuppressionReasonLabel(reason: CandidateSuppressionReason) {
  if (reason === 'restraint_policy') return '触发关注克制策略（冷却/夜间/关系边界）';
  if (reason === 'world_attention_moment_quiet_hours') return '夜间发圈抑制';
  if (reason === 'world_attention_moment_spam_window') return '发圈冷却中';
  if (reason === 'world_attention_moment_delay_window') return '发圈延迟窗口';
  if (reason === 'dedupe_backflow_post_moment') return '动态候选已被近期同簇产物覆盖';
  if (reason === 'dedupe_backflow_social_outing') return '活动候选已被近期同簇产物覆盖';
  if (reason === 'dedupe_backflow_status_update') return '状态候选已被近期同簇产物覆盖';
  if (reason === 'dedupe_backflow_check_in') return '问候候选已被近期同簇产物覆盖';
  if (reason === 'dedupe_backflow_react_to_moment') return '动态回应候选已被近期同簇产物覆盖';
  if (reason === 'dedupe_semantic_existing_newer') return '候选与已有候选语义重复且时间更旧';
  if (reason === 'dedupe_key_duplicate') return '候选去重键重复，已被同批候选覆盖';
  return '礼物候选已被近期同簇产物覆盖';
}

function parseSuppressionWindowMs(hitWindow: string | undefined) {
  if (!hitWindow) return null;
  if (/^\d+min$/i.test(hitWindow)) return Number(hitWindow.replace(/min/i, '')) * 60_000;
  if (/^\d+h$/i.test(hitWindow)) return Number(hitWindow.replace(/h/i, '')) * 60 * 60_000;
  return null;
}

function inferNextSuggestedAtFromSuppression(
  chat: GroupChat,
  event: RuntimeEventV2,
  hitEventId: string | undefined,
  hitWindow: string | undefined,
) {
  const windowMs = parseSuppressionWindowMs(hitWindow);
  if (!windowMs) return undefined;
  const hitEvent = hitEventId
    ? (chat.runtimeEventsV2 || []).find((item) => item.id === hitEventId)
    : null;
  const baseAt = hitEvent?.createdAt || event.createdAt;
  const nextAt = baseAt + windowMs;
  return nextAt > event.createdAt ? nextAt : undefined;
}

function resolveCandidateSuppression(chat: GroupChat, event: RuntimeEventV2, characters: AICharacter[], batchCandidates: RuntimeEventV2[]): Omit<CandidateSuppressionRecord, 'event'> | null {
  const payload = event.payload as SocialEventCandidatePayload;
  if (payload.eventKind === 'post_moment') {
    if (!shouldAutoBackflowMoment(chat, payload, event.createdAt)) return { reason: 'dedupe_backflow_post_moment' };
    const actor = characters.find((item) => item.id === payload.initiatorId) || null;
    const additionalSocialEventCreatedAts = batchCandidates
      .filter((candidate) => candidate.id !== event.id)
      .filter((candidate) => {
        const candidatePayload = candidate.payload as SocialEventCandidatePayload;
        return candidatePayload.initiatorId === payload.initiatorId
          && isPostMomentDelaySourceEventKind(candidatePayload.eventKind);
      })
      .map((candidate) => candidate.createdAt);
    const publishGuard = resolvePostMomentPublishGuard({
      chat,
      payload,
      actor,
      now: event.createdAt,
      additionalSocialEventCreatedAts,
    });
    if (!publishGuard.allow) {
      return {
        reason: publishGuard.reasonType,
        detail: publishGuard.reasonDetail,
        nextSuggestedAt: publishGuard.nextSuggestedAt,
      };
    }
  }
  if (!passesAttentionRestraintPolicy(chat, payload, event.createdAt)) return { reason: 'restraint_policy' };
  if (payload.eventKind === 'status_update' && !shouldAutoBackflowStatusUpdate(chat, payload, event.createdAt)) return { reason: 'dedupe_backflow_status_update' };
  if (payload.eventKind === 'check_in' && !shouldAutoBackflowCheckIn(chat, payload, event.createdAt)) return { reason: 'dedupe_backflow_check_in' };
  if (payload.eventKind === 'react_to_moment' && !shouldAutoBackflowReactToMoment(chat, payload, event.createdAt)) return { reason: 'dedupe_backflow_react_to_moment' };
  if (payload.eventKind === 'gift_exchange' && !shouldAutoBackflowGiftExchange(chat, payload, event.createdAt)) return { reason: 'dedupe_backflow_gift_exchange' };
  return null;
}

function buildCandidateSuppressionEvent(chat: GroupChat, event: RuntimeEventV2, reason: CandidateSuppressionReason, metadata?: {
  detail?: string;
  suppressedConfidence?: number;
  preferredConfidence?: number;
  preferredCandidateId?: string;
  suppressedCandidateId?: string;
  hitEventId?: string;
  hitWindow?: string;
  nextSuggestedAt?: number;
}) {
  const payload = event.payload as SocialEventCandidatePayload;
  const traceReasons = payload.attentionTrace?.reasons || [];
  return createRuntimeEventV2({
    conversationId: chat.id,
    kind: 'action_resolution',
    summary: `候选已抑制：${payload.eventKind} · ${candidateSuppressionReasonLabel(reason)}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds || payload.participantIds,
    visibility: 'moderator_only',
    createdAt: event.createdAt,
    payload: {
      eventType: 'event_candidate_suppressed',
      candidateEventKind: payload.eventKind,
      reasonType: reason,
      reasonLabel: candidateSuppressionReasonLabel(reason),
      dedupeKey: payload.dedupeKey || null,
      participantIds: payload.participantIds,
      targetIds: payload.targetIds || [],
      confidence: payload.confidence,
      reasonDetail: metadata?.detail,
      suppressedConfidence: metadata?.suppressedConfidence,
      preferredConfidence: metadata?.preferredConfidence,
      preferredCandidateId: metadata?.preferredCandidateId,
      suppressedCandidateId: metadata?.suppressedCandidateId,
      hitEventId: metadata?.hitEventId,
      hitWindow: metadata?.hitWindow,
      nextSuggestedAt: metadata?.nextSuggestedAt,
      attentionReasons: traceReasons.slice(0, 4),
    },
  });
}

function dedupeAgainstRecentRuntime(chat: GroupChat, candidates: RuntimeEventV2[], characters: AICharacter[]) {
  const deduped = dedupeSocialEventCandidates(chat, candidates);
  const kept: RuntimeEventV2[] = [];
  const suppressed: RuntimeEventV2[] = [];
  deduped.suppressed.forEach((item) => {
    suppressed.push(buildCandidateSuppressionEvent(chat, item.event, item.reason, {
      detail: item.detail,
      suppressedConfidence: item.suppressedConfidence,
      preferredConfidence: item.preferredConfidence,
      preferredCandidateId: item.preferredCandidateId,
      suppressedCandidateId: item.suppressedCandidateId,
    }));
  });
  deduped.candidates.forEach((event) => {
    const suppression = resolveCandidateSuppression(chat, event, characters, deduped.candidates);
    if (!suppression) {
      kept.push(event);
      return;
    }
    const payload = event.payload as SocialEventCandidatePayload;
    const reason = suppression.reason;
    const restraintFailure = reason === 'restraint_policy'
      ? resolveAttentionRestraintFailureDetail(chat, payload, event.createdAt)
      : undefined;
    const reactBackflowHitEventId = reason === 'dedupe_backflow_react_to_moment'
      ? findRecentReactToMomentBackflowEventId(chat, payload, event.createdAt)
      : null;
    const checkInBackflowHitEventId = reason === 'dedupe_backflow_check_in'
      ? findRecentCheckInBackflowEventId(chat, payload, event.createdAt)
      : null;
    const statusBackflowHitEventId = reason === 'dedupe_backflow_status_update'
      ? findRecentStatusUpdateBackflowEventId(chat, payload, event.createdAt)
      : null;
    const momentBackflowHitEventId = reason === 'dedupe_backflow_post_moment'
      ? findRecentMomentBackflowEventId(chat, payload, event.createdAt)
      : null;
    const outingBackflowHitEventId = reason === 'dedupe_backflow_social_outing'
      ? findRecentOutingBackflowEventId(chat, payload, event.createdAt)
      : null;
    const giftBackflowHitEventId = reason === 'dedupe_backflow_gift_exchange'
      ? findRecentGiftExchangeBackflowEventId(chat, payload, event.createdAt)
      : null;
    suppressed.push(buildCandidateSuppressionEvent(chat, event, reason, {
      detail: suppression.detail || restraintFailure?.detail,
      hitEventId: suppression.hitEventId || restraintFailure?.hitEventId,
      hitWindow: suppression.hitWindow || restraintFailure?.hitWindow,
      nextSuggestedAt: suppression.nextSuggestedAt || inferNextSuggestedAtFromSuppression(chat, event, restraintFailure?.hitEventId, restraintFailure?.hitWindow),
      ...(reactBackflowHitEventId ? {
        detail: `动态回应候选已被近期产物覆盖（hit=${reactBackflowHitEventId})`,
        hitEventId: reactBackflowHitEventId,
        hitWindow: '45min',
      } : {}),
      ...(checkInBackflowHitEventId ? {
        detail: `问候候选已被近期产物覆盖（hit=${checkInBackflowHitEventId})`,
        hitEventId: checkInBackflowHitEventId,
        hitWindow: '30min',
      } : {}),
      ...(statusBackflowHitEventId ? {
        detail: `状态候选已被近期产物覆盖（hit=${statusBackflowHitEventId})`,
        hitEventId: statusBackflowHitEventId,
        hitWindow: 'cluster',
      } : {}),
      ...(momentBackflowHitEventId ? {
        detail: `动态候选已被近期产物覆盖（hit=${momentBackflowHitEventId})`,
        hitEventId: momentBackflowHitEventId,
        hitWindow: 'cluster',
      } : {}),
      ...(outingBackflowHitEventId ? {
        detail: `活动候选已被近期产物覆盖（hit=${outingBackflowHitEventId})`,
        hitEventId: outingBackflowHitEventId,
        hitWindow: 'cluster',
      } : {}),
      ...(giftBackflowHitEventId ? {
        detail: `礼物候选已被近期产物覆盖（hit=${giftBackflowHitEventId})`,
        hitEventId: giftBackflowHitEventId,
        hitWindow: 'cluster',
      } : {}),
    }));
  });
  return { candidates: kept, suppressedEvents: suppressed };
}

function replaceCompactedExistingCandidates(existingEvents: RuntimeEventV2[], compactedCandidates: RuntimeEventV2[]) {
  const replacements = new Map(compactedCandidates.map((event) => [event.id, event]));
  const replacedIds = new Set(replacements.keys());
  return existingEvents.map((event) => replacements.get(event.id) || event).filter((event) => !(event.kind === 'event_candidate' && replacedIds.has(event.id) && !replacements.has(event.id)));
}

function mergeRuntimeEventsWithCompaction(existingEvents: RuntimeEventV2[], compactedCandidates: RuntimeEventV2[], additions: RuntimeEventV2[]) {
  const base = replaceCompactedExistingCandidates(existingEvents, compactedCandidates);
  const existingIds = new Set(base.map((event) => event.id));
  const newCandidates = compactedCandidates.filter((event) => !existingIds.has(event.id));
  return retainRuntimeEvents([...base, ...newCandidates, ...additions], MAX_OPEN_CHAT_RUNTIME_EVENTS);
}

function buildNonCandidateAdditions(params: { messageGeneratedEvent: RuntimeEventV2; interactionEvent?: RuntimeEventV2 | null; relationshipDeltaEvent?: RuntimeEventV2 | null; roomShiftEvent?: RuntimeEventV2 | null; attentionEvent?: RuntimeEventV2 | null; memoryCandidateEvents?: RuntimeEventV2[]; momentArtifactEvents?: RuntimeEventV2[]; artifactEvent?: RuntimeEventV2 | null }) {
  return [
    params.messageGeneratedEvent,
    ...(params.interactionEvent ? [params.interactionEvent] : []),
    ...(params.relationshipDeltaEvent ? [params.relationshipDeltaEvent] : []),
    ...(params.roomShiftEvent ? [params.roomShiftEvent] : []),
    ...(params.attentionEvent ? [params.attentionEvent] : []),
    ...(params.memoryCandidateEvents || []),
    ...(params.momentArtifactEvents || []),
    ...(params.artifactEvent ? [params.artifactEvent] : []),
  ];
}

function compactEventCandidateHistory(existingEvents: RuntimeEventV2[], compactedCandidates: RuntimeEventV2[]) {
  const compactedIds = new Set(compactedCandidates.map((event) => event.id));
  const compactedPayloads = compactedCandidates.map((event) => event.payload as SocialEventCandidatePayload);
  return existingEvents.filter((event) => {
    if (event.kind !== 'event_candidate') return true;
    if (compactedIds.has(event.id)) return false;
    const payload = event.payload as SocialEventCandidatePayload;
    return !compactedPayloads.some((compacted) => areCandidatesSemanticallySimilar(compacted, payload));
  });
}

function mergeCompactedRuntimeEvents(existingEvents: RuntimeEventV2[], compactedCandidates: RuntimeEventV2[], additions: RuntimeEventV2[]) {
  const compactedBase = compactEventCandidateHistory(existingEvents, compactedCandidates);
  return retainRuntimeEvents([...compactedBase, ...compactedCandidates, ...additions], MAX_OPEN_CHAT_RUNTIME_EVENTS);
}

void replaceCompactedExistingCandidates;
void mergeRuntimeEventsWithCompaction;
void buildNonCandidateAdditions;
void mergeCompactedRuntimeEvents;

function buildSocialEventCandidates(params: {
  conversation: GroupChat;
  characters: AICharacter[];
  interaction: InteractionEventPayload | null;
  relationshipLedger: GroupChat['relationshipLedger'];
  structuredRoomState: GroupChat['worldState']['structuredRoomState'];
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
}) {
  void params.interaction;
  void params.relationshipLedger;
  void params.structuredRoomState;
  const selection = dedupeAgainstRecentRuntime(params.conversation, [
    buildPairPrivateThreadCandidateFromHint(params),
    buildPostMomentCandidate(params),
    buildSocialOutingCandidateFromHint(params),
    buildStatusUpdateCandidateFromHint(params),
    buildGiftExchangeCandidateFromHint(params),
    buildConflictExpressionCandidateFromHint(params),
  ].filter(Boolean) as RuntimeEventV2[], params.characters);
  return {
    candidates: selection.candidates,
    suppressedEvents: [
      ...selection.suppressedEvents,
      buildRejectedSocialOutingHintDiagnostic(params),
    ].filter(Boolean) as RuntimeEventV2[],
  };
}

async function buildSocialEventCandidateEvents(params: {
  conversation: GroupChat;
  characters: AICharacter[];
  interaction: InteractionEventPayload | null;
  relationshipLedger: GroupChat['relationshipLedger'];
  structuredRoomState: GroupChat['worldState']['structuredRoomState'];
  message: Pick<Message, 'content' | 'senderId'> & { socialEventHints?: SocialEventHintEnvelope[] | null };
  apiConfig?: APIConfig;
}) {
  const selection = buildSocialEventCandidates({
    ...params,
    message: { ...params.message, socialEventHints: params.message.socialEventHints?.filter((hint) => !hint.intentId && !hint.outcome) },
  });
  if (!selection.candidates.length) return selection;
  const decision = await orchestrateWorldDecision({
    domain: 'open_chat',
    candidates: selection.candidates.map((event, index) => {
      const payload = event.payload as SocialEventCandidatePayload;
      return {
        id: event.id,
        kind: payload.eventKind,
        reasonType: payload.reasonType,
        localScore: (payload.confidence || 0.7) - index * 0.001,
        summary: `${payload.title || ''}/${payload.activityType || ''}/${payload.seedIntent || ''}`,
      };
    }),
  });
  if (!decision) return selection;
  const picked = selection.candidates.find((event) => event.id === decision.selected.id);
  if (!picked) return selection;
  return {
    candidates: [picked, ...selection.candidates.filter((event) => event.id !== picked.id)],
    suppressedEvents: selection.suppressedEvents,
  };
}

function buildMomentArtifactEvents(params: {
  conversation: GroupChat;
  socialEventCandidates: RuntimeEventV2[];
  characters: AICharacter[];
}): RuntimeEventV2[] {
  return params.socialEventCandidates
    .filter((event) => (event.payload as SocialEventCandidatePayload).eventKind === 'post_moment')
    .flatMap((event) => {
      const payload = event.payload as SocialEventCandidatePayload;
      const actor = params.characters.find((item) => item.id === payload.initiatorId) || null;
      const actorName = actor?.name || payload.initiatorId;
      const publishGuard = resolvePostMomentPublishGuard({
        chat: params.conversation,
        payload,
        actor,
        now: event.createdAt,
      });
      if (!publishGuard.allow) {
        return [buildCandidateSuppressionEvent(params.conversation, event, publishGuard.reasonType, {
          detail: publishGuard.reasonDetail,
          nextSuggestedAt: publishGuard.nextSuggestedAt,
        })];
      }
      const text = buildMomentPostText(actorName, payload);
      return [createRuntimeEventV2({
        conversationId: params.conversation.id,
        kind: 'artifact',
        summary: text,
        actorIds: [payload.initiatorId],
        targetIds: payload.targetIds,
        visibility: 'derived_public',
        payload: {
          artifactType: 'moment_text',
          eventKind: 'post_moment',
          text,
          candidateId: event.id,
          expectedArtifacts: payload.expectedArtifacts || [],
          dedupeKey: payload.dedupeKey,
          title: payload.title,
          activityType: payload.activityType,
          targetIds: payload.targetIds,
        },
      })];
    });
}

function buildMomentArtifactEventsAndOuting(params: {
  conversation: GroupChat;
  socialEventCandidates: RuntimeEventV2[];
  characters: AICharacter[];
}) {
  return [
    ...buildMomentArtifactEvents(params),
    ...buildStatusUpdateArtifactEvents(params),
    ...buildCheckInArtifactEvents(params),
    ...buildReactToMomentArtifactEvents(params),
    ...buildGiftExchangeArtifactEvents(params),
    ...buildConflictExpressionArtifactEvents(params),
  ];
}

async function buildStructuredRuntime(params: {
  conversation: GroupChat;
  message: Pick<Message, 'content' | 'type' | 'senderId'> & { interactionHint?: InteractionEventPayload | null; interactionHints?: InteractionEventPayload[] | null; socialEventHints?: SocialEventHintEnvelope[] | null; conflictFocus?: import('../../types/runtimeEvent').ConflictFocusPayload | null };
  characters: AICharacter[];
  recentMessages?: Message[];
  apiConfig?: APIConfig;
}) {
  const existingEvents = params.conversation.runtimeEventsV2 || [];
  const speaker = params.characters.find((character) => character.id === params.message.senderId);
  const isCharacterAuthoredMessage = params.message.type === 'ai' || Boolean(speaker);
  if ((params.message.type === 'user' || params.message.type === 'god') && !speaker) {
    const senderIsMember = params.conversation.memberIds.includes(params.message.senderId);
    const isUserPersonaMessage = params.message.type === 'user' && params.message.senderId === 'user';
    const treatAsGuidance = params.message.type === 'god' || !senderIsMember;
    const summary = params.message.content.trim().slice(0, 128);
    const guidance = (treatAsGuidance || isUserPersonaMessage) ? await assessUserGuidance({
      config: params.apiConfig,
      chat: params.conversation,
      characters: params.characters,
      message: params.message,
      recentMessages: params.recentMessages,
    }) : null;
    const targetActorIds = getGuidanceTargetActorIds(guidance);
    const mentionedActorIds = guidance?.mentionedActorIds || [];
    const directorTargetActorIds = targetActorIds;
    const shouldCreateGuidanceEvent = Boolean(
      guidance
      && summary
      && (treatAsGuidance
        || guidance.kind !== 'topic_shift'
        || targetActorIds.length
        || guidance.hasHardConstraints
        || guidance.suppressedActorIds?.length
        || guidance.deferredActorIds?.length),
    );
    const cueEvent = summary && isUserPersonaMessage ? createRuntimeEventV2({
      conversationId: params.conversation.id,
      kind: 'memory_candidate',
      summary: `${treatAsGuidance ? '用户引导' : '用户发言'}：${summary}`,
      actorIds: [params.message.senderId],
      payload: {
        kind: 'topic',
        text: `${treatAsGuidance ? '用户引导' : '用户发言'}：${summary}`,
        salience: 0.62,
        confidence: 0.74,
      } satisfies MemoryCandidatePayload,
    }) : null;
    const userInteractionEvent: RuntimeEventV2 | null = null;
    const userRelationshipLedger = params.conversation.relationshipLedger || [];
    const userStructuredRoomState = params.conversation.worldState.structuredRoomState || null;
    const userRoomShiftEvent: RuntimeEventV2 | null = null;
    const userRelationshipDeltaEvent: RuntimeEventV2 | null = null;
    const userMemoryFromInteraction = userInteractionEvent ? buildMemoryCandidateFromStructuredEvent(userInteractionEvent) : null;
    const directorEvent = shouldCreateGuidanceEvent && guidance ? createRuntimeEventV2({
      conversationId: params.conversation.id,
      kind: 'director_intervention',
      summary: guidance?.reason || `主持人指令：${summary}`,
      actorIds: [params.message.senderId],
      targetIds: directorTargetActorIds,
      visibility: 'moderator_only',
      payload: {
        intent: guidance?.beatType === 'summarize'
          ? 'summarize'
          : guidance?.beatType === 'cool_down'
            ? 'cool_down'
          : guidance?.beatType === 'reveal'
            ? 'reveal'
          : guidance?.beatType === 'deflect'
            ? 'redirect'
          : guidance?.beatType === 'escalate' || guidance?.beatType === 'challenge'
            ? 'escalate'
          : guidance?.beatType === 'invite'
            ? 'inject_event'
          : 'force_reply',
        targetActorIds: directorTargetActorIds,
        pressure: guidance?.pressure || 0.7,
        text: guidance?.rawText || summary,
        maxTurns: guidance?.maxTurns || 1,
        expiresAt: Date.now() + 10 * 60_000,
        userGuidance: guidance as unknown as Record<string, unknown>,
      } satisfies DirectorInterventionPayload,
    }) : null;
    const attentionTargetIds = isUserPersonaMessage ? targetActorIds : [];
    const attentionEvent = isUserPersonaMessage && attentionTargetIds.length ? createRuntimeEventV2({
      conversationId: params.conversation.id,
      kind: 'attention_candidate',
      summary: `${treatAsGuidance ? '用户点名' : '用户发言提及'} ${attentionTargetIds.join('、')}，等待回应`,
      actorIds: ['user'],
      targetIds: attentionTargetIds,
      visibility: 'derived_public',
      payload: {
        source: mentionedActorIds.length ? 'user_group_message' : 'user_followup_message',
        reason: mentionedActorIds.length
          ? '用户在群聊中点名，形成关注候选。'
          : '用户继续接住最近角色发言，形成关注候选。',
        confidence: mentionedActorIds.length ? 0.8 : 0.74,
        targetIds: attentionTargetIds,
      },
    }) : null;
    const additions = [
      cueEvent,
      userInteractionEvent,
      userRelationshipDeltaEvent,
      userRoomShiftEvent,
      userMemoryFromInteraction,
      attentionEvent,
      directorEvent,
    ].filter(Boolean) as RuntimeEventV2[];
    return {
      interaction: null,
      runtimeEventsV2: additions.length ? mergeCompactedRuntimeEvents(existingEvents, [], additions) : existingEvents,
      relationshipLedger: userRelationshipLedger,
      structuredRoomState: userStructuredRoomState,
    };
  }

  if (!isCharacterAuthoredMessage) {
    return {
      interaction: null,
      runtimeEventsV2: existingEvents,
      relationshipLedger: params.conversation.relationshipLedger || [],
      structuredRoomState: params.conversation.worldState.structuredRoomState || null,
    };
  }

  const resolvedSocialEventHints = await resolveSocialEventHints({
    conversation: params.conversation,
    message: params.message,
    characters: params.characters,
    recentMessages: params.recentMessages,
    apiConfig: params.apiConfig,
  });
  const enrichedMessage = {
    ...params.message,
    socialEventHints: resolvedSocialEventHints,
    conflictFocus: params.message.conflictFocus || null,
  };
  const socialIntentOutcomes = buildSocialIntentOutcomes(params.conversation, enrichedMessage);

  const messageGeneratedEvent = createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'message_generated',
    summary: params.message.content.trim().slice(0, 128),
    actorIds: [params.message.senderId],
    payload: { text: params.message.content.trim().slice(0, 128), messageType: params.message.type },
  });

  const interaction = await resolveInteraction({
    ...params,
    message: enrichedMessage,
  });
  if (!interaction) {
    const artifactEvent = buildArtifactEvent(params);
    const socialEventCandidateSelection = await buildSocialEventCandidateEvents({
      conversation: params.conversation,
      characters: params.characters,
      interaction: null,
      relationshipLedger: params.conversation.relationshipLedger || [],
      structuredRoomState: params.conversation.worldState.structuredRoomState || null,
      message: enrichedMessage,
      apiConfig: params.apiConfig,
    });
    const socialEventCandidateEvents = socialEventCandidateSelection.candidates;
    const socialArtifacts = buildMomentArtifactEventsAndOuting({
      conversation: params.conversation,
      socialEventCandidates: socialEventCandidateEvents,
      characters: params.characters,
    });
    return {
      interaction: null,
      runtimeEventsV2: mergeCompactedRuntimeEvents(
        existingEvents,
        socialEventCandidateEvents,
        buildNonCandidateAdditions({
          messageGeneratedEvent,
          momentArtifactEvents: socialArtifacts,
          artifactEvent,
        }).concat(socialEventCandidateSelection.suppressedEvents, socialIntentOutcomes),
      ),
      relationshipLedger: params.conversation.relationshipLedger || [],
      structuredRoomState: params.conversation.worldState.structuredRoomState || null,
    };
  }

  // Keep every model-judged directed interaction in the structured runtime.
  // The primary interaction drives the room shift below; secondary targets
  // still need their own emotional/relationship evidence and must not vanish
  // merely because the visible reply mentions more than one person.
  const allInteractions = (enrichedMessage.interactionHints?.length
    ? enrichedMessage.interactionHints
    : interaction ? [interaction] : [])
    .filter((item, index, items) => (item?.targetId || item?.immediateImpact?.roomDelta)
      && items.findIndex((candidate) => candidate.targetId === item.targetId && candidate.kind === item.kind && candidate.evidenceText === item.evidenceText) === index);
  const secondaryInteractionEvents = allInteractions
    .filter((item) => item !== interaction && item.targetId)
    .map((item) => {
      const secondaryActorName = params.characters.find((character) => character.id === item.actorId)?.name || item.actorId;
      const secondaryTargetName = params.characters.find((character) => character.id === item.targetId)?.name || item.targetId || '';
      return createRuntimeEventV2({
        conversationId: params.conversation.id,
        kind: 'interaction',
        summary: `${secondaryActorName} → ${secondaryTargetName} · ${item.evidenceText}`,
        actorIds: [item.actorId],
        targetIds: item.targetId ? [item.targetId] : undefined,
        payload: item,
      });
    });

  const actorName = params.characters.find((item) => item.id === interaction.actorId)?.name || interaction.actorId;
  const targetName = interaction.targetId ? (params.characters.find((item) => item.id === interaction.targetId)?.name || interaction.targetId) : null;

  const interactionEvent = createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'interaction',
    summary: targetName ? `${actorName} → ${targetName} · ${interaction.evidenceText}` : `${actorName} · ${interaction.evidenceText}`,
    actorIds: [interaction.actorId],
    targetIds: interaction.targetId ? [interaction.targetId] : undefined,
    payload: interaction,
  });

  let relationshipLedger = reduceRelationshipLedger(
    params.conversation.relationshipLedger || [],
    interaction,
    interactionEvent,
  );

  const secondaryRelationshipEvents = allInteractions
    .filter((item) => item !== interaction)
    .map((item) => {
      const delta = inferRelationshipDelta(item);
      if (!delta || !canApplyRelationshipInteraction(item, delta)) return null;
      const actorLabel = params.characters.find((character) => character.id === item.actorId)?.name || item.actorId;
      const targetLabel = item.targetId ? (params.characters.find((character) => character.id === item.targetId)?.name || item.targetId) : '';
      const event = createRuntimeEventV2({
        conversationId: params.conversation.id,
        kind: 'relationship_delta',
        summary: `${actorLabel}→${targetLabel} · ${item.evidenceText}`,
        actorIds: [item.actorId],
        targetIds: item.targetId ? [item.targetId] : undefined,
        payload: delta,
      });
      relationshipLedger = reduceRelationshipLedger(relationshipLedger, item, event);
      return event;
    })
    .filter((event): event is RuntimeEventV2 => Boolean(event));

  const { nextState: structuredRoomState, shift: roomShift } = calculateRoomShift(
    params.conversation.worldState.structuredRoomState || null,
    allInteractions,
    { semanticSource: 'model' },
  );

  const relationshipDelta = inferRelationshipDelta(interaction);
  const relationshipTargetId = relationshipDelta?.targetId || null;
  const relationshipTargetName = relationshipTargetId
    ? (params.characters.find((character) => character.id === relationshipTargetId)?.name || relationshipTargetId)
    : null;
  const latestLedgerEntry = relationshipTargetId
    ? getRelationshipLedgerEntry(relationshipLedger, interaction.actorId, relationshipTargetId)
    : null;

  const relationshipDeltaEvent = relationshipDelta && latestLedgerEntry && relationshipTargetName
    ? createRuntimeEventV2({
        conversationId: params.conversation.id,
        kind: 'relationship_delta',
        summary: `${actorName}→${relationshipTargetName} ${summarizeRelationshipDelta(relationshipDelta)}`,
        actorIds: [interaction.actorId],
        targetIds: relationshipTargetId ? [relationshipTargetId] : undefined,
        payload: relationshipDelta,
      })
    : null;

  const roomShiftEvent = hasRoomShiftSignal(roomShift)
    ? createRuntimeEventV2({
        conversationId: params.conversation.id,
        kind: 'room_shift',
        summary: `房间态势更新：热度 ${structuredRoomState.heat} (${roomShift.delta?.heat && roomShift.delta.heat > 0 ? '+' : ''}${roomShift.delta?.heat || 0}) / 凝聚 ${structuredRoomState.cohesion} (${roomShift.delta?.cohesion && roomShift.delta.cohesion > 0 ? '+' : ''}${roomShift.delta?.cohesion || 0})`,
        actorIds: [interaction.actorId],
        targetIds: interaction.targetId ? [interaction.targetId] : undefined,
        payload: roomShift,
      })
    : null;

  const artifactEvent = buildArtifactEvent(params);
  const socialEventCandidateSelection = await buildSocialEventCandidateEvents({
    conversation: params.conversation,
    characters: params.characters,
    interaction,
    relationshipLedger,
    structuredRoomState,
    message: enrichedMessage,
    apiConfig: params.apiConfig,
  });
  const socialEventCandidateEvents = socialEventCandidateSelection.candidates;
  const momentArtifactEvents = buildMomentArtifactEventsAndOuting({
    conversation: params.conversation,
    socialEventCandidates: socialEventCandidateEvents,
    characters: params.characters,
  });
  const allInteractionEvents = [interactionEvent, ...secondaryInteractionEvents];
  const memoryCandidateEvents = [...allInteractionEvents, ...(roomShiftEvent ? [roomShiftEvent] : [])]
    .map(buildMemoryCandidateFromStructuredEvent)
    .filter(Boolean) as RuntimeEventV2[];
  const actorIsChatMember = params.conversation.memberIds.includes(interaction.actorId);
  const targetIsChatMember = Boolean(interaction.targetId && params.conversation.memberIds.includes(interaction.targetId));
  const attentionTargetId = interaction.targetId || null;
  const shouldCreateAttentionEvent = Boolean(
    attentionTargetId
    && interaction.actorId !== attentionTargetId
    && actorIsChatMember
    && targetIsChatMember
    && interaction.confidence >= 0.72,
  );
  const attentionEvent = shouldCreateAttentionEvent
    ? createRuntimeEventV2({
        conversationId: params.conversation.id,
        kind: 'attention_candidate',
        summary: `${interaction.actorId} 对 ${attentionTargetId} 形成关注候选`,
        actorIds: [interaction.actorId],
        targetIds: [attentionTargetId as string],
        visibility: 'derived_public',
        payload: {
          source: attentionTargetId === 'user' ? 'ai_response_to_user' : 'ai_response_to_member',
          reason: interaction.evidenceText,
          confidence: Math.max(0.72, interaction.confidence),
          targetIds: [attentionTargetId as string],
        },
      })
    : null;
  const secondaryAttentionEvents = allInteractions
    .filter((item) => item !== interaction)
    .filter((item) => Boolean(
      item.targetId
      && item.actorId !== item.targetId
      && params.conversation.memberIds.includes(item.actorId)
      && params.conversation.memberIds.includes(item.targetId)
      && item.confidence >= 0.72,
    ))
    .map((item) => createRuntimeEventV2({
      conversationId: params.conversation.id,
      kind: 'attention_candidate',
      summary: `${item.actorId} 对 ${item.targetId} 形成关注候选`,
      actorIds: [item.actorId],
      targetIds: [item.targetId as string],
      visibility: 'derived_public',
      payload: {
        source: item.targetId === 'user' ? 'ai_response_to_user' : 'ai_response_to_member',
        reason: item.evidenceText,
        confidence: Math.max(0.72, item.confidence),
        targetIds: [item.targetId as string],
      },
    }));

  return {
    interaction,
    runtimeEventsV2: mergeCompactedRuntimeEvents(
      existingEvents,
      socialEventCandidateEvents,
      buildNonCandidateAdditions({
        messageGeneratedEvent,
        interactionEvent,
        relationshipDeltaEvent,
        roomShiftEvent,
        attentionEvent,
        memoryCandidateEvents,
        momentArtifactEvents,
        artifactEvent,
      }).concat(
        secondaryInteractionEvents,
        secondaryRelationshipEvents,
        secondaryAttentionEvents,
        socialEventCandidateSelection.suppressedEvents,
        socialIntentOutcomes,
      ),
    ),
    relationshipLedger,
    structuredRoomState,
  };
}

function toLegacyMetrics(interaction: InteractionEventPayload, relationshipLedger: GroupChat['relationshipLedger']) {
  if (!interaction.targetId) return null;
  return relationshipLedger?.find((entry) => entry.actorId === interaction.actorId && entry.targetId === interaction.targetId)?.current || null;
}

type StructuredLegacyEvent = { eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown };

function buildActivityDebugLabel(id: string, characters: AICharacter[]) {
  if (id === 'user') return '我';
  return characters.find((item) => item.id === id)?.name || id;
}

function buildActivityParticipantStateText(value: unknown, characters: AICharacter[]) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([id, state]) => typeof state === 'string' ? `${buildActivityDebugLabel(id, characters)}:${state}` : '')
    .filter(Boolean)
    .join('、');
}

function buildCalendarActivityLegacyEvents(runtimeEventsV2: RuntimeEventV2[], characters: AICharacter[]): StructuredLegacyEvent[] {
  return runtimeEventsV2.flatMap((event) => {
    if (event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing') {
      const payload = event.payload as SocialEventCandidatePayload & { participantStates?: Record<string, string> };
      const label = payload.title || payload.activityType || '线下活动';
      const participants = (payload.participantIds || []).map((id) => buildActivityDebugLabel(id, characters)).join('、') || '未定';
      const participantStates = buildActivityParticipantStateText(payload.participantStates, characters);
      const detail = [
        `候选 ${label}`,
        payload.timeHint ? `时间 ${payload.timeHint}` : '',
        payload.locationHint ? `地点 ${payload.locationHint}` : '',
        `参与 ${participants}`,
        participantStates ? `状态 ${participantStates}` : '',
        `置信 ${payload.confidence.toFixed(2)}`,
        payload.dedupeKey ? `key ${payload.dedupeKey}` : '',
      ].filter(Boolean).join(' · ');
      const debugEvents: StructuredLegacyEvent[] = [{
        eventType: 'calendar_activity_candidate',
        title: '活动候选进入日历',
        summary: detail,
        metrics: {
          eventId: event.id,
          calendarItemId: payload.dedupeKey || null,
          reasonType: payload.reasonType,
          confidence: payload.confidence,
          participantIds: payload.participantIds,
          participantStates: payload.participantStates || null,
          sourceText: payload.sourceText || null,
        },
      }, {
        eventType: 'calendar_activity_invite',
        title: payload.reasonType === 'chat_activity_invite' ? '聊天邀约识别' : '活动邀约候选',
        summary: [
          payload.seedIntent,
          payload.sourceText ? `原文 ${payload.sourceText}` : '',
          payload.expectedArtifacts?.length ? `后续产物 ${payload.expectedArtifacts.join('、')}` : '',
        ].filter(Boolean).join(' · '),
        metrics: {
          eventId: event.id,
          reasonType: payload.reasonType,
          expectedArtifacts: payload.expectedArtifacts || [],
          visibilityPlan: payload.visibilityPlan,
          urgency: payload.urgency,
        },
      }];
      return debugEvents;
    }
    if (event.kind === 'calendar_item_patch') {
      const payload = event.payload as Record<string, unknown>;
      if (payload.source !== 'chat_activity_followup') return [];
      const participantStates = buildActivityParticipantStateText(payload.addParticipantStates, characters);
      const debugEvents: StructuredLegacyEvent[] = [{
        eventType: 'calendar_activity_patch',
        title: '活动候选更新',
        summary: [
          typeof payload.timeHint === 'string' ? `时间 ${payload.timeHint}` : '',
          typeof payload.locationHint === 'string' ? `地点 ${payload.locationHint}` : '',
          typeof payload.status === 'string' ? `状态 ${payload.status}` : '',
          participantStates ? `参与 ${participantStates}` : '',
          typeof payload.summary === 'string' ? `依据 ${payload.summary}` : '',
          typeof payload.calendarItemId === 'string' ? `item ${payload.calendarItemId}` : '',
        ].filter(Boolean).join(' · ') || event.summary,
        metrics: {
          eventId: event.id,
          calendarItemId: typeof payload.calendarItemId === 'string' ? payload.calendarItemId : null,
          addParticipantIds: Array.isArray(payload.addParticipantIds) ? payload.addParticipantIds : [],
          addParticipantStates: payload.addParticipantStates || null,
          timeHint: typeof payload.timeHint === 'string' ? payload.timeHint : null,
          locationHint: typeof payload.locationHint === 'string' ? payload.locationHint : null,
          status: typeof payload.status === 'string' ? payload.status : null,
        },
      }];
      return debugEvents;
    }
    return [];
  });
}

function buildStructuredLegacyEvents(runtimeEventsV2: RuntimeEventV2[], relationshipLedger: GroupChat['relationshipLedger'], structuredRoomState: GroupChat['worldState']['structuredRoomState'], characters: AICharacter[]): StructuredLegacyEvent[] {
  const events: StructuredLegacyEvent[] = [];
  const latestInteraction = runtimeEventsV2.slice().reverse().find((event) => event.kind === 'interaction');
  if (latestInteraction) {
    const payload = latestInteraction.payload as InteractionEventPayload;
    events.push({
      eventType: `interaction_${payload.kind}`,
      title: `结构化互动：${payload.kind}`,
      summary: payload.evidenceText,
      pair: payload.targetId ? [payload.actorId, payload.targetId] as [string, string] : undefined,
      metrics: toLegacyMetrics(payload, relationshipLedger),
    });
  }
  if (runtimeEventsV2.some((event) => event.kind === 'artifact')) {
    const artifact = runtimeEventsV2.slice().reverse().find((event) => event.kind === 'artifact');
    if (artifact) {
      events.push({
        eventType: 'structured_artifact',
        title: '结构化产物',
        summary: artifact.summary,
      });
    }
  }
  // A snapshot is a compatibility projection of a real room change.  Do not
  // emit one merely because the chat now has a normalized baseline state.
  if (structuredRoomState && runtimeEventsV2.some((event) => event.kind === 'room_shift')) {
    events.push({
      eventType: 'room_state_snapshot_v2',
      title: '房间态势更新',
      summary: `热度 ${structuredRoomState.heat} / 凝聚 ${structuredRoomState.cohesion} / 话题漂移 ${structuredRoomState.topicDrift}`,
      metrics: structuredRoomState,
    });
  }
  events.push(...buildCalendarActivityLegacyEvents(runtimeEventsV2, characters));
  return events;
}

function buildStructuredSummary(interaction: InteractionEventPayload | null, characters: AICharacter[]) {
  if (!interaction) return null;
  const actor = characters.find((item) => item.id === interaction.actorId)?.name || interaction.actorId;
  const target = interaction.targetId
    ? (characters.find((item) => item.id === interaction.targetId)?.name || interaction.targetId)
    : null;
  const kindLabelMap: Record<InteractionEventPayload['kind'], string> = {
    support: '表达支持',
    challenge: '发起挑战',
    mock: '进行了嘲讽',
    dismiss: '表示不屑',
    defend: '出面维护',
    evade: '回避问题',
    probe: '进行了追问',
    pile_on: '加入围攻',
    redirect: '试图转移话题',
    apologize: '作出道歉',
    concede: '作出让步',
    take_responsibility: '承担责任',
    include: '主动纳入对方',
    exclude: '将对方排除在外',
    boundary: '划出边界',
    side_comment: '插入侧面评论',
  };
  return target ? `${actor}${kindLabelMap[interaction.kind]}，对象是 ${target}` : `${actor}${kindLabelMap[interaction.kind]}`;
}

function mergeRecentEvent(baseRecentEvent: string, structuredSummary: string | null) {
  if (!structuredSummary) return baseRecentEvent;
  return baseRecentEvent ? `${baseRecentEvent} / ${structuredSummary}`.slice(0, 120) : structuredSummary;
}

function normalizeRuleEvalText(content: string) {
  return content
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?:;：；“”"'‘’（）()【】[\]-]/g, '');
}

function evaluateWorldInfluenceRulesFromMessage(input: {
  content: string;
  activeRuleIds: string[];
}) {
  const normalized = normalizeRuleEvalText(input.content || '');
  const caringSignal = /(还好吗|没事吧|别急|辛苦了|注意休息|先缓缓|慢慢说|我在这|抱抱|areyouok|takeyourtime|norush|imhere|i'mhere)/.test(normalized);
  const scheduleSignal = /(提醒|别忘|时间|几点|改期|冲突|确认时间|行程|schedule|remind|time|conflict|reschedule|confirm)/.test(normalized);
  const forcefulSignal = /(必须|马上|立刻|赶紧|闭嘴|stoparguing|justdoit|must|immediately|shutup)/.test(normalized);
  const lowPressureSignal = /(可以|要不|如果方便|不着急|慢慢来|先看看|先别急|别急|或许|也许|建议|maybe|perhaps|ifyouwant|whenever|takeitasyoucan)/.test(normalized);
  const matchedRuleIds = input.activeRuleIds.filter((ruleId) => {
    if (ruleId === 'comfort_first') return caringSignal;
    if (ruleId === 'urgent_calendar_first' || ruleId === 'calendar_conflict_clarify_first') return scheduleSignal;
    if (ruleId === 'low_pressure_restraint') return lowPressureSignal && !forcefulSignal;
    return false;
  });
  const unmetRuleIds = input.activeRuleIds.filter((ruleId) => !matchedRuleIds.includes(ruleId));
  return { matchedRuleIds, unmetRuleIds };
}


async function onMessageCommitted(params: {
  conversation: GroupChat;
  characters: AICharacter[];
  message: OpenChatCommittedMessage;
  previousAiMessage?: Pick<Message, 'senderId'> | null;
  recentMessages?: Message[];
  apiConfig?: APIConfig;
}): Promise<DriverMessageCommitResult> {
  const config = resolveRuntimeEvolutionConfig(params.conversation.runtimeEvolutionIntensity);
  const publicMessage = params.message.metadata?.withdrawal?.withdrawn
    ? {
        ...params.message,
        interactionHint: null,
        interactionHints: null,
        incomingInteractionHint: null,
        socialEventHints: null,
        conflictFocus: null,
      }
    : params.message;
  const nextWorldStateResult = buildNextWorldState(params.conversation, publicMessage);
  const senderIsCharacter = params.characters.some((character) => character.id === publicMessage.senderId);
  const senderIsMember = params.conversation.memberIds.includes(publicMessage.senderId);
  const isPlainUserGuidance = publicMessage.type === 'god'
    || ((publicMessage.type === 'user') && !senderIsCharacter && !senderIsMember);
  const userGuidanceSummary = isPlainUserGuidance ? publicMessage.content.trim().slice(0, 96) : '';
  const nextWorldState = isPlainUserGuidance && userGuidanceSummary
    ? {
        ...nextWorldStateResult.worldState,
        focus: userGuidanceSummary,
        recentEvent: `用户引导：${userGuidanceSummary}`,
      }
    : nextWorldStateResult.worldState;
  const relationshipTransition = buildRelationshipTransition({
    conversation: params.conversation,
    characters: params.characters,
    message: publicMessage,
    previousAiMessage: params.previousAiMessage || null,
    recentMessages: params.recentMessages,
    config,
  });
  const worldRuntimeEvents = buildWorldRuntimeEvents(
    publicMessage,
    params.conversation.worldState,
    nextWorldState,
    nextWorldStateResult.nextConflictAxes,
    config,
  );
  const { interaction, runtimeEventsV2, relationshipLedger, structuredRoomState } = await buildStructuredRuntime({
    conversation: params.conversation,
    message: publicMessage,
    characters: params.characters,
    recentMessages: params.recentMessages,
    apiConfig: params.apiConfig,
  });
  const continuityResult = applyConversationUpdate(params.conversation, publicMessage, structuredRoomState);
  const continuityEvents = continuityResult.changedItems.map((item) => createRuntimeEventV2({
    conversationId: params.conversation.id, kind: 'action_resolution', visibility: 'public',
    actorIds: [publicMessage.senderId], targetIds: item.participantIds,
    evidenceMessageIds: publicMessage.id ? [publicMessage.id] : [],
    summary: item.summary,
    payload: { eventType: 'conversation_item_updated', decisionSource: 'model', ...item },
  }));
  if (continuityResult.room && !areRuntimeValuesEqual(continuityResult.room, structuredRoomState)) {
    continuityEvents.push(createRuntimeEventV2({
      conversationId: params.conversation.id, kind: 'room_shift', visibility: 'public',
      actorIds: [publicMessage.senderId], evidenceMessageIds: publicMessage.id ? [publicMessage.id] : [],
      summary: '已发送的发言更新了房间关系态势。',
      payload: { eventType: 'conversation_room_updated', decisionSource: 'model', roomState: continuityResult.room },
    }));
  }
  const incoming = publicMessage.type === 'ai' && publicMessage.incomingInteractionHint?.targetId === publicMessage.senderId
    && publicMessage.incomingInteractionHint.actorId !== publicMessage.senderId
    ? publicMessage.incomingInteractionHint : null;
  const incomingActor = incoming && params.recentMessages?.findLast((message) =>
    !message.isDeleted && message.senderId === incoming.actorId && (message.type === 'user' || message.type === 'god'));
  const incomingEvent = incoming && incomingActor ? createRuntimeEventV2({
    conversationId: params.conversation.id,
    kind: 'interaction',
    summary: `${incomingActor.senderName} → ${params.characters.find((item) => item.id === incoming.targetId)?.name || '成员'} · ${incoming.evidenceText}`,
    actorIds: [incoming.actorId],
    targetIds: [incoming.targetId as string],
    payload: { ...incoming, relationship: undefined },
  }) : null;
  const mergedWorldState = {
    ...nextWorldState,
    structuredRoomState: continuityResult.room,
    ...(continuityResult.continuity ? { conversationContinuity: continuityResult.continuity } : {}),
    recentEvent: mergeRecentEvent(nextWorldState.recentEvent, buildStructuredSummary(interaction, params.characters)),
  };
  const nextStructuredEvents = runtimeEventsV2.slice((params.conversation.runtimeEventsV2 || []).length);
  const fallbackRelationshipLedger = relationshipTransition.relationshipLedger;
  const effectiveRelationshipLedger = relationshipLedger.length ? relationshipLedger : fallbackRelationshipLedger;
  const commitRuntimeEvents = [
    ...relationshipTransition.runtimeEvents,
    ...(params.message.metadata?.withdrawal?.withdrawn ? [{
      eventType: 'message_withdrawn',
      title: `${params.characters.find((item) => item.id === params.message.senderId)?.name || '成员'} 撤回了一条消息`,
      summary: '这次撤回留下了一点迟疑、尴尬或关系余波，但原文不进入公开运行态。',
      metrics: {
        actorId: params.message.senderId,
        reason: params.message.metadata.withdrawal.reason,
      },
      timelineType: 'note',
      eventClass: 'message' as const,
      visibilityScope: 'public' as const,
      createdAt: Date.now(),
    }] : []),
    ...worldRuntimeEvents,
    ...buildStructuredLegacyEvents([...nextStructuredEvents, ...continuityEvents], effectiveRelationshipLedger, continuityResult.room, params.characters),
  ];
  const withdrawalRuntimeEventsV2: RuntimeEventV2[] = publicMessage.metadata?.withdrawal?.withdrawn ? [
    createRuntimeEventV2({
      conversationId: params.conversation.id,
      kind: 'memory_candidate',
      summary: `${params.characters.find((item) => item.id === publicMessage.senderId)?.name || '成员'} 撤回了一条消息：撤回本身成为公开可见的余波，原文不进入公开记忆。`,
      actorIds: [publicMessage.senderId],
      payload: {
        kind: 'topic',
        text: `${params.characters.find((item) => item.id === publicMessage.senderId)?.name || '成员'} 撤回了一条消息：撤回本身成为公开可见的余波，原文不进入公开记忆。`,
        salience: 0.59,
        confidence: 0.7,
      },
      visibility: 'public',
    }),
  ] : [];

  const chatPatch = buildChatPatch(
    params.conversation,
    publicMessage,
    mergedWorldState,
    commitRuntimeEvents,
    config,
    params.characters.map((item) => ({ id: item.id, name: item.name })),
  ) as Partial<GroupChat> & { localDistillationEvent?: DriverMessageCommitResult['runtimeEvents'][number] | null };
  const localDistillationEvent = chatPatch.localDistillationEvent || null;
  delete chatPatch.localDistillationEvent;
  const worldInfluence = publicMessage.metadata?.runtimeDecision?.worldInfluence;
  const worldInfluenceRuleEvalEvent = worldInfluence?.activeRuleIds?.length
    ? (() => {
        const { matchedRuleIds, unmetRuleIds } = evaluateWorldInfluenceRulesFromMessage({
          content: publicMessage.content,
          activeRuleIds: worldInfluence.activeRuleIds,
        });
        return createRuntimeEventV2({
          conversationId: params.conversation.id,
          kind: 'action_resolution',
          summary: `世界影响规则词面诊断：命中 ${matchedRuleIds.length}/${worldInfluence.activeRuleIds.length}`,
          actorIds: [publicMessage.senderId],
          visibility: 'derived_public',
          payload: {
            eventType: 'world_influence_rule_evaluated',
            activeRuleIds: worldInfluence.activeRuleIds,
            matchedRuleIds,
            unmetRuleIds,
            attentionScore: worldInfluence.attentionScore,
            attentionRestraint: worldInfluence.attentionRestraint,
          },
        });
      })()
    : null;
  const previousEventIds = new Set((params.conversation.runtimeEventsV2 || []).map((event) => event.id));
  const structuredEventIds = new Set(runtimeEventsV2.map((event) => event.id));
  // Preserve memory/backflow additions without reviving legacy name-based attention.
  const memoryBackflowEvents = (chatPatch.runtimeEventsV2 || []).filter((event) =>
    !previousEventIds.has(event.id) && !structuredEventIds.has(event.id)
      && (event.kind === 'memory_candidate' || event.kind === 'artifact'));
  const nextRuntimeEventsV2 = retainRuntimeEvents([...new Map([
    ...runtimeEventsV2, ...memoryBackflowEvents, ...continuityEvents,
    ...(incomingEvent ? [incomingEvent] : []), ...withdrawalRuntimeEventsV2,
  ].map((event) => [event.id, event])).values()], MAX_OPEN_CHAT_RUNTIME_EVENTS);
  const runtimeEventsWithRuleEval = worldInfluenceRuleEvalEvent
    ? mergeCompactedRuntimeEvents(nextRuntimeEventsV2, [], [worldInfluenceRuleEvalEvent])
    : nextRuntimeEventsV2;
  setChangedChatPatchField(chatPatch, params.conversation, 'runtimeEventsV2', runtimeEventsWithRuleEval);
  setChangedChatPatchField(chatPatch, params.conversation, 'relationshipLedger', effectiveRelationshipLedger);
  const chatRuntimeDelta = {
    runtimeEventsV2: buildRuntimeEventsDelta(params.conversation, runtimeEventsWithRuleEval),
    relationshipLedger: buildRelationshipLedgerDelta(params.conversation, effectiveRelationshipLedger),
  };
  delete chatPatch.runtimeEventsV2;
  delete chatPatch.relationshipLedger;
  const incomingTargetId = incomingEvent && incoming?.targetId ? incoming.targetId : null;
  const characterPatches = incomingTargetId && !relationshipTransition.characterPatches.some((entry) => entry.characterId === incomingTargetId)
    ? [...relationshipTransition.characterPatches, { characterId: incomingTargetId, patch: {} }]
    : relationshipTransition.characterPatches;
  return {
    chatPatch,
    chatRuntimeDelta: Object.values(chatRuntimeDelta).some(Boolean) ? chatRuntimeDelta : undefined,
    characterPatches: characterPatches.map((entry) => {
      if (!incoming || !incomingTargetId || entry.characterId !== incomingTargetId) return entry;
      const speaker = params.characters.find((item) => item.id === entry.characterId);
      if (!speaker) return entry;
      const spike = applyInteractionEmotions(speaker, [incoming], 'target', speaker.emotionalState || getEmotionalBaseline());
      const outgoing = (publicMessage.interactionHints?.length ? publicMessage.interactionHints : publicMessage.interactionHint ? [publicMessage.interactionHint] : []);
      const emotionalState = applyInteractionEmotions(speaker, outgoing, 'speaker', spike);
      const soulState = projectInnerLife({
        chat: { ...params.conversation, runtimeEventsV2: runtimeEventsWithRuleEval },
        character: { ...speaker, ...entry.patch, emotionalState },
        messages: params.recentMessages || [],
      }).state;
      return { ...entry, patch: { ...entry.patch, emotionalState, soulState } };
    }),
    runtimeEvents: localDistillationEvent ? [...commitRuntimeEvents, localDistillationEvent] : commitRuntimeEvents,
  };
}

export const openChatEngine: SessionEngineDefinition = createDefaultConversationEngineDefinition({
  key: 'open_chat',
  createInitialConfig: () => ({ ...DEFAULT_OPEN_CHAT_MODE_CONFIG, sessionFamily: 'conversation', scenarioId: 'open-chat' }),
  createInitialState: () => DEFAULT_OPEN_CHAT_MODE_STATE,
  buildRuntimeContextBundle,
  onMessageCommitted,
});

export const OPEN_CHAT_ENGINE = openChatEngine;
