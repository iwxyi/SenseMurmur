import type { AICharacter } from '../types/character';
import type { ConversationPhase, GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';
import type { SessionActionExecutionResult } from '../types/sessionEngine';
import type { APIConfig } from '../types/settings';
import type { CompanionshipMomentReflectionEventPayload } from '../types/companionship';
import { createDefaultConversationFrameworkPatch, mergeSessionChatPatch } from '../types/sessionEngine';
import { DEFAULT_CONVERSATION_WORLD_STATE } from '../types/chat';
import { retainRuntimeEvents } from './runtimeEventRetention';
import { accumulateChatRuntime } from './chatRuntime';
import { getRelationshipLedgerEntry } from './relationshipLedger';
import { calculateRoomShift } from './roomStateSynthesizer';
import { projectWorldAttentionStates, projectWorldCalendar } from './worldRuntimeProjection';
import { resolveSessionEngine } from './sessionEngineRegistry';
import { buildThreadRef, getVisibilityChannelId } from './sessionTopology';
import { reportUnresolvedDisplayEntity } from './diagnostics';
import { isCharacterFeatureEnabled } from './characterGenerationPolicy';
import { buildMomentPostText } from './momentTextBuilder';
import { buildCompanionshipArtifactSeeds, buildCompanionshipStatusSignature, buildUserCompanionshipProjection, shouldBlockUserProactiveContactByCompanionshipPolicy } from './companionshipProjection';
import { readDueCompanionshipCareTopicsFromEvents, readStaleCompanionshipCareTopicsFromEvents } from './directCompanionshipCare';
import { buildCompanionshipPrivateThreadScheduleEvent, getCompanionshipPrivateThreadCooldownMs, getRecentCompanionshipPrivateThreadSchedule } from './companionshipPrivateThreadSchedule';
import { isNightOwlPersona, resolvePostMomentPublishGuard } from './postMomentPublishPolicy';

function withFrameworkPatch(chat: GroupChat, patch: Partial<GroupChat>) {
  const engine = resolveSessionEngine(chat);
  return mergeSessionChatPatch(engine, chat, patch);
}

function createConversationThreadFrameworkPatch(sourceChat: GroupChat, memberIds: string[]) {
  const conversation = {
    ...sourceChat,
    type: 'ai_direct' as const,
    memberIds,
    sessionKind: { topology: 'thread' as const, family: 'conversation' as const, scenarioId: 'ai-private-thread', surfaceProfile: 'text' as const },
    channels: [{ channelId: 'public', visibility: 'pair_private' as const, label: 'Private Thread', actorIds: memberIds }],
  } as GroupChat;
  return createDefaultConversationFrameworkPatch(conversation);
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

function createRuntimeEventV2(params: {
  conversationId: string;
  kind: RuntimeEventV2['kind'];
  summary: string;
  payload: RuntimeEventV2['payload'];
  actorIds?: string[];
  targetIds?: string[];
  visibility?: RuntimeEventV2['visibility'];
  channelId?: string;
  causedByIntentId?: string;
  threadRef?: string;
  eventClass?: RuntimeEventV2['eventClass'];
  createdAt?: number;
}) {
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
    summary: params.summary,
    channelId: params.channelId || getVisibilityChannelId(params.visibility),
    causedByIntentId: params.causedByIntentId,
    threadRef: params.threadRef || buildThreadRef(undefined, params.conversationId),
    eventClass: params.eventClass || (params.kind === 'artifact' ? 'artifact' : params.kind === 'room_shift' ? 'phase' : 'message'),
    visibility: params.visibility || 'public',
    payload: params.payload,
  } satisfies RuntimeEventV2;
}

function buildPostMomentExpectedArtifactsForWorldCandidate(chat: GroupChat, actorId: string, now: number, hasImageModel: boolean) {
  if (!hasImageModel) return ['moment_text'];
  const seed = stableEventSeed([chat.id, actorId, Math.floor(now / (60 * 60_000)), 'world-post-moment']);
  const score = seed.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 100;
  if (score < 35) return ['moment_text']; // 可发图，但不强制
  if (score < 60) return ['moment_text', 'moment_selfie'];
  if (score < 80) return ['moment_text', 'moment_group_photo'];
  return ['moment_text', 'moment_scene_photo'];
}

function appendStructuredRuntimeEvent(chat: GroupChat, event: RuntimeEventV2) {
  return retainRuntimeEvents([...(chat.runtimeEventsV2 || []), event], 160);
}

function appendStructuredRuntimeEvents(chat: GroupChat, events: RuntimeEventV2[]) {
  return events.reduce((acc, event) => appendStructuredRuntimeEvent({ ...chat, runtimeEventsV2: acc }, event), chat.runtimeEventsV2 || []);
}

function compactCompanionshipMomentText(text: string | undefined | null, max = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function classifyMomentCompanionshipSeed(seed: string): CompanionshipMomentReflectionEventPayload['reflectionType'] | null {
  if (/(共同话语|专属称呼|约定话语|安慰话语|心意话语|秘密暗号|“[^”]{1,36}”|「[^」]{1,36}」)/.test(seed)) return 'shared_phrase';
  if (/(未完成约定|约定|承诺|答应|说好|下次一起|以后一起|等你)/.test(seed)) return 'promise';
  if (/(共同秘密|小秘密|保密|只有.*知道|不能告诉|公开遮罩)/.test(seed)) return 'shared_secret';
  if (/(共同梗|仪式|暗号|只有.*懂|玩笑)/.test(seed)) return 'ritual';
  if (/(第一次|心意确认|冲突|修复|和好|里程碑|纪念日)/.test(seed)) return 'shared_anchor';
  return null;
}

function cleanMomentCompanionshipSeed(seed: string) {
  return compactCompanionshipMomentText(seed
    .replace(/^(公开动态|关系余味线索|关系余波|共同梗\/约定|未完成约定|小秘密|共同秘密)\s*[:：]/, '')
    .replace(/^(可以|只能|不要|把|写成|公开动态可以|公开动态只能使用)/, '')
    .replace(/不点名用户/g, '不点名')
    .replace(/用户/g, '对方')
    .trim(), 180);
}

function inferMomentCompanionshipParticipants(seed: string, payload: SocialEventCandidatePayload) {
  const ids = [payload.initiatorId];
  if (/(用户|对方|某个人|有人懂)/.test(seed) || (payload.targetIds || []).includes('user')) ids.push('user');
  (payload.participantIds || []).forEach((id) => {
    if (id && id !== payload.initiatorId) ids.push(id);
  });
  (payload.targetIds || []).forEach((id) => {
    if (id && id !== payload.initiatorId) ids.push(id);
  });
  if (ids.length === 1) ids.push(...(payload.targetIds || []).filter(Boolean));
  return Array.from(new Set(ids.filter(Boolean))).slice(0, 6);
}

function buildPostMomentCompanionshipReflectionEvents(
  sourceChat: GroupChat,
  payload: SocialEventCandidatePayload,
  momentText: string,
  createdAt?: number,
): RuntimeEventV2[] {
  const baseCreatedAt = resolveEventTimestamp(createdAt);
  const seen = new Set<string>();
  return (payload.companionshipSeeds || [])
    .map((seed) => ({ seed, reflectionType: classifyMomentCompanionshipSeed(seed) }))
    .filter((item): item is { seed: string; reflectionType: CompanionshipMomentReflectionEventPayload['reflectionType'] } => Boolean(item.reflectionType))
    .filter((item) => {
      const key = `${item.reflectionType}:${compactCompanionshipMomentText(item.seed, 80).replace(/\s+/g, '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2)
    .map((item, index) => {
      const participantIds = inferMomentCompanionshipParticipants(item.seed, payload);
      const userId = participantIds.includes('user') ? 'user' : undefined;
      const reflectionId = `moment-${payload.dedupeKey || stableEventSeed([sourceChat.id, payload.initiatorId, momentText])}-${index}`;
      const cleanText = cleanMomentCompanionshipSeed(item.seed) || compactCompanionshipMomentText(item.seed, 180);
      const reflectionPayload: CompanionshipMomentReflectionEventPayload = {
        eventType: 'companionship_moment_reflection',
        characterId: payload.initiatorId,
        userId,
        reflectionId,
        momentDedupeKey: payload.dedupeKey || undefined,
        reflectionType: item.reflectionType,
        participantIds,
        text: cleanText,
        sourceSeed: compactCompanionshipMomentText(item.seed, 220),
        momentText: compactCompanionshipMomentText(momentText, 180),
        confidence: 0.58,
        decisionSource: 'local_fallback',
      };
      return createRuntimeEventV2({
        conversationId: sourceChat.id,
        kind: 'artifact',
        summary: '朋友圈发布留下了一条陪伴余波',
        actorIds: [payload.initiatorId],
        targetIds: participantIds.filter((id) => id !== payload.initiatorId),
        visibility: userId ? 'pair_private' : 'role_private',
        payload: reflectionPayload as unknown as Record<string, unknown>,
        createdAt: baseCreatedAt + index + 4,
      });
    });
}

function hasRecentWorldSuppressionEvent(chat: GroupChat, actorId: string | null, reasonType: string, windowMs: number, now = Date.now()) {
  return (chat.runtimeEventsV2 || []).some((event) => {
    if (event.kind !== 'artifact') return false;
    if (now - event.createdAt > windowMs) return false;
    const payload = event.payload as {
      eventType?: string;
      reasonType?: string;
    };
    if (payload.eventType !== 'event_candidate_suppressed' || payload.reasonType !== reasonType) return false;
    if (!actorId) return true;
    return (event.actorIds || [])[0] === actorId;
  });
}

function readPendingMomentDelayWindow(chat: GroupChat, actorId: string | null, now = Date.now()) {
  let latest: number | null = null;
  (chat.runtimeEventsV2 || []).forEach((event) => {
    if (event.kind !== 'artifact') return;
    if (actorId && (event.actorIds || [])[0] !== actorId) return;
    const payload = event.payload as { eventType?: string; reasonType?: string; nextSuggestedAt?: number };
    if (payload.eventType !== 'event_candidate_suppressed' || payload.reasonType !== 'world_attention_moment_delay_window') return;
    if (typeof payload.nextSuggestedAt !== 'number' || !Number.isFinite(payload.nextSuggestedAt)) return;
    if (payload.nextSuggestedAt <= now) return;
    if (latest == null || payload.nextSuggestedAt > latest) latest = payload.nextSuggestedAt;
  });
  return latest;
}

function resolveWorldDrivenCandidateCreatedAt(chat: GroupChat, actorId: string, now: number) {
  const updatedAt = typeof chat.updatedAt === 'number' && Number.isFinite(chat.updatedAt) ? chat.updatedAt : now;
  const idleMs = Math.max(0, now - updatedAt);
  const offlineWindowMs = 2 * 60 * 60_000;
  if (idleMs < offlineWindowMs) return now;
  const seed = parseInt(stableEventSeed([chat.id, actorId, updatedAt]), 36);
  const offsetMs = 8 * 60_000 + (Number.isFinite(seed) ? seed % (42 * 60_000) : 0);
  return Math.max(updatedAt, Math.min(now - 5 * 60_000, updatedAt + offlineWindowMs + offsetMs));
}

function readWorldInfluenceBias(chat: GroupChat, actorId: string, now = Date.now()) {
  const latest = (chat.runtimeEventsV2 || [])
    .slice()
    .reverse()
    .find((event) => {
      if (event.kind !== 'action_resolution') return false;
      if ((event.actorIds || [])[0] !== actorId) return false;
      if (now - event.createdAt > 2 * 60 * 60_000) return false;
      const payload = event.payload as { eventType?: string };
      return payload.eventType === 'world_influence_rule_evaluated';
    });
  if (!latest) {
    return {
      comfortBoost: 0,
      scheduleBoost: 0,
      restraintPenalty: 0,
    };
  }
  const payload = latest.payload as {
    matchedRuleIds?: string[];
    unmetRuleIds?: string[];
  };
  const matched = new Set(payload.matchedRuleIds || []);
  const unmet = new Set(payload.unmetRuleIds || []);
  return {
    comfortBoost: matched.has('comfort_first') ? 0.05 : 0,
    scheduleBoost: matched.has('urgent_calendar_first') || matched.has('calendar_conflict_clarify_first') ? 0.06 : 0,
    restraintPenalty: unmet.has('low_pressure_restraint') ? 0.04 : 0,
  };
}

function readActionCooldownNextSuggestedAt(
  chat: GroupChat,
  actorId: string,
  eventKind: 'check_in' | 'react_to_moment' | 'social_outing',
  windowMs: number,
  now = Date.now(),
) {
  const artifactTypeByKind: Record<typeof eventKind, string> = {
    check_in: 'check_in_note',
    react_to_moment: 'moment_reaction_note',
    social_outing: 'outing_summary',
  };
  const artifactType = artifactTypeByKind[eventKind];
  const lastAt = (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact' && (event.actorIds || [])[0] === actorId)
    .filter((event) => {
      const payload = event.payload as { artifactType?: string; eventKind?: string };
      return payload.artifactType === artifactType && payload.eventKind === eventKind;
    })
    .map((event) => event.createdAt)
    .sort((a, b) => b - a)[0];
  if (typeof lastAt !== 'number') return null;
  const nextAt = lastAt + windowMs;
  return nextAt > now ? nextAt : null;
}

function buildWorldSuppressionEvent(params: {
  chat: GroupChat;
  actorId: string | null;
  actorName?: string;
  reasonType: string;
  reasonLabel: string;
  reasonDetail: string;
  candidateEventKind?: SocialEventCandidatePayload['eventKind'];
  nextSuggestedAt?: number;
}) {
  return createRuntimeEventV2({
    conversationId: params.chat.id,
    kind: 'artifact',
    actorIds: params.actorId ? [params.actorId] : undefined,
    targetIds: params.actorId ? ['user'] : undefined,
    visibility: 'derived_public',
    summary: `${params.actorName || '世界驱动'}候选已抑制：${params.reasonLabel}`,
    payload: {
      eventType: 'event_candidate_suppressed',
      candidateEventKind: params.candidateEventKind,
      reasonType: params.reasonType,
      reasonLabel: params.reasonLabel,
      reasonDetail: params.reasonDetail,
      nextSuggestedAt: params.nextSuggestedAt,
    },
  });
}

function buildWorldDecisionEvent(params: {
  chat: GroupChat;
  actorId: string | null;
  actorName?: string;
  decisionType: 'trigger' | 'suppressed' | 'fallback';
  decisionSource?: 'local' | 'model';
  reasonType: string;
  reasonLabel: string;
  reasonDetail: string;
  fromEventKind?: SocialEventCandidatePayload['eventKind'];
  toEventKind?: SocialEventCandidatePayload['eventKind'];
  nextSuggestedAt?: number;
  selectedId?: string;
  confidenceDelta?: number;
  candidateCount?: number;
}) {
  const fromLabel = params.fromEventKind ? `${params.fromEventKind} -> ` : '';
  const selectedKind = params.toEventKind || params.fromEventKind || 'status_update';
  return createRuntimeEventV2({
    conversationId: params.chat.id,
    kind: 'artifact',
    actorIds: params.actorId ? [params.actorId] : undefined,
    targetIds: params.actorId ? ['user'] : undefined,
    visibility: 'derived_public',
    summary: `${params.actorName || '世界驱动'}决策：${fromLabel}${params.toEventKind || 'none'} (${params.decisionType})`,
    payload: {
      eventType: 'world_decision_v2',
      domain: 'proactive_care',
      selectedId: params.selectedId || `${params.actorId || 'world'}:${params.decisionType}:${selectedKind}:${params.reasonType}`,
      selectedKind,
      selectedReasonType: params.reasonType,
      decisionSource: params.decisionSource || 'local',
      modelReason: params.reasonDetail,
      confidenceDelta: typeof params.confidenceDelta === 'number' ? params.confidenceDelta : undefined,
      candidateCount: typeof params.candidateCount === 'number' ? params.candidateCount : undefined,
      decisionType: params.decisionType,
      reasonType: params.reasonType,
      reasonLabel: params.reasonLabel,
      reasonDetail: params.reasonDetail,
      fromEventKind: params.fromEventKind,
      toEventKind: params.toEventKind,
      nextSuggestedAt: params.nextSuggestedAt,
    },
  });
}

function mergeRuntimeSeedWithSummary(chat: GroupChat, summary: string) {
  return {
    notes: [...(chat.runtimeSeed?.notes || []), summary].slice(-24),
    artifacts: chat.runtimeSeed?.artifacts || [],
  };
}



function buildPostMomentSummary(actorName: string, payload: SocialEventCandidatePayload) {
  const source = (payload.sourceText || '').trim();
  const sourceHint = source ? source.replace(/\s+/g, ' ').slice(0, 22) : '';
  const addHint = (text: string) => sourceHint ? `${text}（${sourceHint}${source.length > 22 ? '…' : ''}）` : text;
  const expectedArtifacts = payload.expectedArtifacts || [];
  const hasImageSignal = expectedArtifacts.some((item) => item !== 'moment_text');
  if (payload.reasonType === 'world_attention_share_moment_event') {
    return addHint(`${actorName} 发了一条动态，记录了刚发生的片段。`);
  }
  if (payload.reasonType === 'world_attention_share_moment_inner') {
    return addHint(`${actorName} 发了一条动态，写下了当下的内心感受。`);
  }
  if (payload.reasonType === 'celebration') {
    return addHint(`${actorName} 发了一条动态，记录了刚才的开心时刻。`);
  }
  if (hasImageSignal) {
    return addHint(`${actorName} 发了一条动态，配了一张随手图分享近况。`);
  }
  return addHint(`${actorName} 发了一条动态，表达了刚才的情绪。`);
}

function buildPostMomentEffectEvents(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorName: string, createdAt?: number) {
  const baseCreatedAt = resolveEventTimestamp(createdAt);
  const summary = buildPostMomentSummary(actorName, payload);
  const momentText = buildMomentPostText(actorName, payload);
  const companionshipReflectionEvents = buildPostMomentCompanionshipReflectionEvents(sourceChat, payload, momentText, baseCreatedAt);
  const shiftedRoom = calculateRoomShift(sourceChat.worldState.structuredRoomState || null, {
    kind: payload.reasonType === 'celebration' ? 'support' : 'side_comment',
    actorId: payload.initiatorId,
    targetId: payload.targetIds?.[0] || null,
    intensity: payload.reasonType === 'celebration' ? 2 : 1,
    tone: payload.reasonType === 'celebration' ? 'warm' : 'cold',
    evidenceText: (payload.sourceText || summary).slice(0, 120),
    confidence: payload.confidence,
  });
  return {
    effectEvent: createRuntimeEventV2({
      conversationId: sourceChat.id,
      kind: 'relationship_delta',
      summary: `动态回流：${summary}`,
      actorIds: [payload.initiatorId],
      targetIds: payload.targetIds,
      visibility: 'derived_public',
      payload: {
        eventKind: 'post_moment',
        effectType: 'artifact',
        summary: `动态回流：${summary}`,
        confidence: payload.confidence,
      },
      createdAt: baseCreatedAt,
    }),
    memoryEvent: createRuntimeEventV2({
      conversationId: sourceChat.id,
      kind: 'memory_candidate',
      summary,
      actorIds: [payload.initiatorId],
      targetIds: payload.targetIds,
      visibility: 'derived_public',
      payload: {
        kind: payload.reasonType === 'celebration' ? 'topic' : 'preference',
        text: summary,
        salience: payload.reasonType === 'celebration' ? 0.72 : 0.64,
        confidence: payload.confidence,
      },
      createdAt: baseCreatedAt + 1,
    }),
    artifactEvent: createRuntimeEventV2({
      conversationId: sourceChat.id,
      kind: 'artifact',
      summary,
      actorIds: [payload.initiatorId],
      targetIds: payload.targetIds,
      visibility: 'derived_public',
      payload: {
        artifactType: 'moment_text',
        eventKind: 'post_moment',
        text: momentText,
        publicSummary: summary,
        expectedArtifacts: payload.expectedArtifacts || [],
        dedupeKey: payload.dedupeKey,
        title: payload.title,
        activityType: payload.activityType,
        targetIds: payload.targetIds,
      },
      createdAt: baseCreatedAt + 2,
    }),
    roomShiftEvent: createRuntimeEventV2({
      conversationId: sourceChat.id,
      kind: 'room_shift',
      summary: `动态回流后房间态势微调：热度 ${shiftedRoom.nextState.heat} / 凝聚 ${shiftedRoom.nextState.cohesion}`,
      actorIds: [payload.initiatorId],
      targetIds: payload.targetIds,
      visibility: 'derived_public',
      payload: shiftedRoom.shift,
      createdAt: baseCreatedAt + 3,
    }),
    companionshipReflectionEvents,
    nextStructuredRoomState: shiftedRoom.nextState,
    publicSummary: summary,
  };
}

export function updateSourceChatAfterPostMoment(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorName: string, options: { createdAt?: number } = {}) {
  const { effectEvent, memoryEvent, artifactEvent, roomShiftEvent, companionshipReflectionEvents, nextStructuredRoomState, publicSummary } = buildPostMomentEffectEvents(sourceChat, payload, actorName, options.createdAt);
  return withFrameworkPatch(sourceChat, {
    lastMessageAt: Date.now(),
    runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [effectEvent, memoryEvent, artifactEvent, roomShiftEvent, ...companionshipReflectionEvents]),
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      ...(sourceChat.worldState || {}),
      structuredRoomState: nextStructuredRoomState,
      recentEvent: publicSummary.slice(0, 120),
    },
    ...accumulateChatRuntime(sourceChat, { type: 'event', content: publicSummary }),
    runtimeSeed: mergeRuntimeSeedWithSummary(sourceChat, publicSummary),
  });
}

export function buildSocialOutingEffectEvents(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorNames: string[]) {
  const activityLabel = payload.title || payload.activityType || '线下活动';
  const summary = `${actorNames.join('、')} 的待定活动安排：${activityLabel}。`;
  return {
    artifactEvent: createRuntimeEventV2({
      conversationId: sourceChat.id,
      kind: 'artifact',
      summary,
      actorIds: [payload.initiatorId],
      targetIds: payload.participantIds,
      visibility: 'derived_public',
      payload: {
        artifactType: 'outing_summary',
        eventKind: 'social_outing',
        status: 'tentative',
        text: summary,
        expectedArtifacts: payload.expectedArtifacts || [],
        dedupeKey: payload.dedupeKey,
        title: payload.title,
        activityType: payload.activityType,
        participantIds: payload.participantIds,
        participantStates: payload.participantStates,
        targetIds: payload.targetIds,
        timeHint: payload.timeHint,
        locationHint: payload.locationHint,
      },
    }),
    publicSummary: summary,
  };
}

export function updateSourceChatAfterSocialOuting(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorNames: string[]) {
  const { artifactEvent, publicSummary } = buildSocialOutingEffectEvents(sourceChat, payload, actorNames);
  return withFrameworkPatch(sourceChat, {
    lastMessageAt: Date.now(),
    runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [artifactEvent]),
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      ...(sourceChat.worldState || {}),
      recentEvent: publicSummary.slice(0, 120),
    },
    ...accumulateChatRuntime(sourceChat, { type: 'event', content: publicSummary }),
    runtimeSeed: mergeRuntimeSeedWithSummary(sourceChat, publicSummary),
  });
}

function isPrivateThreadOpenedArtifact(event: RuntimeEventV2) {
  return event.kind === 'artifact' && typeof (event.payload as { artifactType?: string }).artifactType === 'string' && (event.payload as { artifactType?: string }).artifactType === 'private_thread_opened';
}

function extractOpenedPairKey(event: RuntimeEventV2) {
  return [...(event.targetIds || [])].sort().join('::');
}

function extractCandidatePairKey(payload: SocialEventCandidatePayload) {
  return [...payload.participantIds].sort().join('::');
}

function extractCandidatePair(payload: SocialEventCandidatePayload) {
  return payload.participantIds.length === 2 ? payload.participantIds as [string, string] : null;
}

function hasOpenedThreadForCandidate(chat: GroupChat, payload: SocialEventCandidatePayload) {
  const pairKey = extractCandidatePairKey(payload);
  return (chat.runtimeEventsV2 || []).some((event) => isPrivateThreadOpenedArtifact(event) && extractOpenedPairKey(event) === pairKey);
}

function getLatestPrivateThreadOpenedAt(chat: GroupChat, payload: SocialEventCandidatePayload) {
  const pairKey = extractCandidatePairKey(payload);
  return (chat.runtimeEventsV2 || [])
    .filter((event) => isPrivateThreadOpenedArtifact(event) && extractOpenedPairKey(event) === pairKey)
    .map((event) => event.createdAt)
    .sort((a, b) => b - a)[0] || null;
}

function withinPrivateThreadCooldown(createdAt: number, latestOpenedAt: number | null) {
  return typeof latestOpenedAt === 'number' && createdAt - latestOpenedAt < 1000 * 60 * 30;
}

function shouldCandidateAutoOpen(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  if (payload.eventKind !== 'pair_private_thread') return false;
  if (payload.participantIds.length !== 2) return false;
  if (payload.confidence < 0.8) return false;
  if (hasOpenedThreadForCandidate(chat, payload) && withinPrivateThreadCooldown(createdAt, getLatestPrivateThreadOpenedAt(chat, payload))) return false;
  if (isCompanionshipPrivateThreadPayload(payload) && getRecentCompanionshipPrivateThreadSchedule({
    chat,
    participantIds: payload.participantIds,
    now: Date.now(),
  })) return false;
  return true;
}

function getAutoOpenPairFromCandidate(chat: GroupChat, event: RuntimeEventV2) {
  if (event.kind !== 'event_candidate') return null;
  const payload = event.payload as SocialEventCandidatePayload;
  if (!shouldCandidateAutoOpen(chat, payload, event.createdAt)) return null;
  return extractCandidatePair(payload);
}

function isAutoOpenEligible(chat: GroupChat, event: RuntimeEventV2) {
  return Boolean(getAutoOpenPairFromCandidate(chat, event));
}

function findLatestAutoOpenCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'pair_private_thread', 0.8, (event) => isAutoOpenEligible(chat, event));
}

function findLatestPendingSocialCandidate(
  chat: GroupChat,
  eventKind: SocialEventCandidatePayload['eventKind'],
  minimumConfidence: number,
  isEligible?: (event: RuntimeEventV2) => boolean,
) {
  return (chat.runtimeEventsV2 || []).slice().reverse().find((event) => {
    if (event.kind !== 'event_candidate' || hasHandledSocialEvent(chat, event.id)) return false;
    const payload = event.payload as SocialEventCandidatePayload;
    return payload.eventKind === eventKind && payload.confidence >= minimumConfidence
      && (!isEligible || isEligible(event));
  }) || null;
}

export function findLatestAutoPostMomentCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'post_moment', 0.8);
}

export function findLatestAutoStatusUpdateCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'status_update', 0.8);
}

function findLatestAutoCheckInCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'check_in', 0.75);
}

function findLatestAutoReactToMomentCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'react_to_moment', 0.75);
}

export function updateSourceChatAfterStatusUpdate(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorName: string) {
  const summary = `${actorName} 在群里同步了自己的近况。`;
  const shiftedRoom = calculateRoomShift(sourceChat.worldState.structuredRoomState || null, {
    kind: 'side_comment',
    actorId: payload.initiatorId,
    targetId: payload.targetIds?.[0] || null,
    intensity: 1,
    tone: 'warm',
    evidenceText: (payload.sourceText || summary).slice(0, 120),
    confidence: payload.confidence,
  });
  const effectEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'relationship_delta',
    summary: `状态回流：${summary}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      eventKind: 'status_update',
      effectType: 'artifact',
      summary: `状态回流：${summary}`,
      confidence: payload.confidence,
    },
  });
  const memoryEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'memory_candidate',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      kind: 'fact',
      text: summary,
      salience: 0.62,
      confidence: payload.confidence,
    },
  });
  const artifactEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'artifact',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      artifactType: 'status_note',
      eventKind: 'status_update',
      text: summary,
      title: payload.title,
      activityType: payload.activityType,
      expectedArtifacts: payload.expectedArtifacts || [],
      dedupeKey: payload.dedupeKey,
    },
  });
  const roomShiftEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'room_shift',
    summary: `状态更新后房间态势微调：热度 ${shiftedRoom.nextState.heat} / 凝聚 ${shiftedRoom.nextState.cohesion}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: shiftedRoom.shift,
  });
  return withFrameworkPatch(sourceChat, {
    lastMessageAt: Date.now(),
    runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [effectEvent, memoryEvent, artifactEvent, roomShiftEvent]),
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      ...(sourceChat.worldState || {}),
      structuredRoomState: shiftedRoom.nextState,
      recentEvent: summary.slice(0, 120),
    },
    ...accumulateChatRuntime(sourceChat, { type: 'event', content: summary }),
    runtimeSeed: mergeRuntimeSeedWithSummary(sourceChat, summary),
  });
}

export function updateSourceChatAfterCheckIn(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorName: string) {
  const summary = `${actorName} 主动问候了用户近况。`;
  const shiftedRoom = calculateRoomShift(sourceChat.worldState.structuredRoomState || null, {
    kind: 'support',
    actorId: payload.initiatorId,
    targetId: payload.targetIds?.[0] || null,
    intensity: 1,
    tone: 'warm',
    evidenceText: (payload.sourceText || summary).slice(0, 120),
    confidence: payload.confidence,
  });
  const effectEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'relationship_delta',
    summary: `问候回流：${summary}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      eventKind: 'check_in',
      effectType: 'artifact',
      summary: `问候回流：${summary}`,
      confidence: payload.confidence,
    },
  });
  const memoryEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'memory_candidate',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      kind: 'relationship',
      text: summary,
      salience: 0.64,
      confidence: payload.confidence,
    },
  });
  const artifactEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'artifact',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      artifactType: 'check_in_note',
      eventKind: 'check_in',
      text: summary,
      title: payload.title,
      activityType: payload.activityType,
      expectedArtifacts: payload.expectedArtifacts || [],
      dedupeKey: payload.dedupeKey,
    },
  });
  const roomShiftEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'room_shift',
    summary: `问候后房间态势微调：热度 ${shiftedRoom.nextState.heat} / 凝聚 ${shiftedRoom.nextState.cohesion}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: shiftedRoom.shift,
  });
  return withFrameworkPatch(sourceChat, {
    lastMessageAt: Date.now(),
    runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [effectEvent, memoryEvent, artifactEvent, roomShiftEvent]),
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      ...(sourceChat.worldState || {}),
      structuredRoomState: shiftedRoom.nextState,
      recentEvent: summary.slice(0, 120),
    },
    ...accumulateChatRuntime(sourceChat, { type: 'event', content: summary }),
    runtimeSeed: mergeRuntimeSeedWithSummary(sourceChat, summary),
  });
}

export function updateSourceChatAfterReactToMoment(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorName: string) {
  const summary = `${actorName} 回应了用户最近的动态。`;
  const shiftedRoom = calculateRoomShift(sourceChat.worldState.structuredRoomState || null, {
    kind: 'support',
    actorId: payload.initiatorId,
    targetId: payload.targetIds?.[0] || null,
    intensity: 1,
    tone: 'warm',
    evidenceText: (payload.sourceText || summary).slice(0, 120),
    confidence: payload.confidence,
  });
  const effectEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'relationship_delta',
    summary: `动态回应回流：${summary}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      eventKind: 'react_to_moment',
      effectType: 'artifact',
      summary: `动态回应回流：${summary}`,
      confidence: payload.confidence,
    },
  });
  const memoryEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'memory_candidate',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      kind: 'relationship',
      text: summary,
      salience: 0.66,
      confidence: payload.confidence,
    },
  });
  const artifactEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'artifact',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      artifactType: 'moment_reaction_note',
      eventKind: 'react_to_moment',
      text: summary,
      title: payload.title,
      activityType: payload.activityType,
      expectedArtifacts: payload.expectedArtifacts || [],
      dedupeKey: payload.dedupeKey,
    },
  });
  const roomShiftEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'room_shift',
    summary: `动态回应后房间态势微调：热度 ${shiftedRoom.nextState.heat} / 凝聚 ${shiftedRoom.nextState.cohesion}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: shiftedRoom.shift,
  });
  return withFrameworkPatch(sourceChat, {
    lastMessageAt: Date.now(),
    runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [effectEvent, memoryEvent, artifactEvent, roomShiftEvent]),
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      ...(sourceChat.worldState || {}),
      structuredRoomState: shiftedRoom.nextState,
      recentEvent: summary.slice(0, 120),
    },
    ...accumulateChatRuntime(sourceChat, { type: 'event', content: summary }),
    runtimeSeed: mergeRuntimeSeedWithSummary(sourceChat, summary),
  });
}

function findLatestAutoSocialOutingCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'social_outing', 0.8);
}

function findLatestAutoGiftExchangeCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'gift_exchange', 0.8, (event) => (
    shouldConsumeCandidateWithRestraint(chat, event.payload as SocialEventCandidatePayload, event.createdAt)
  ));
}

function findLatestAutoConflictExpressionCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'conflict_expression', 0.8, (event) => (
    shouldConsumeCandidateWithRestraint(chat, event.payload as SocialEventCandidatePayload, event.createdAt)
  ));
}

export function updateSourceChatAfterGiftExchange(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorName: string) {
  const summary = `${actorName} 刚刚送出了一个小礼物或心意。`;
  const shiftedRoom = calculateRoomShift(sourceChat.worldState.structuredRoomState || null, {
    kind: 'support',
    actorId: payload.initiatorId,
    targetId: payload.targetIds?.[0] || null,
    intensity: 2,
    tone: 'warm',
    evidenceText: (payload.sourceText || summary).slice(0, 120),
    confidence: payload.confidence,
  });
  const effectEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'relationship_delta',
    summary: `礼物回流：${summary}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      eventKind: 'gift_exchange',
      effectType: 'artifact',
      summary: `礼物回流：${summary}`,
      confidence: payload.confidence,
    },
  });
  const memoryEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'memory_candidate',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      kind: 'preference',
      text: summary,
      salience: 0.7,
      confidence: payload.confidence,
    },
  });
  const artifactEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'artifact',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      artifactType: 'gift_note',
      eventKind: 'gift_exchange',
      text: summary,
      title: payload.title,
      activityType: payload.activityType,
      expectedArtifacts: payload.expectedArtifacts || [],
      dedupeKey: payload.dedupeKey,
    },
  });
  const roomShiftEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'room_shift',
    summary: `礼物互动后房间态势微调：热度 ${shiftedRoom.nextState.heat} / 凝聚 ${shiftedRoom.nextState.cohesion}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: shiftedRoom.shift,
  });
  return withFrameworkPatch(sourceChat, {
    lastMessageAt: Date.now(),
    runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [effectEvent, memoryEvent, artifactEvent, roomShiftEvent]),
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      ...(sourceChat.worldState || {}),
      structuredRoomState: shiftedRoom.nextState,
      recentEvent: summary.slice(0, 120),
    },
    ...accumulateChatRuntime(sourceChat, { type: 'event', content: summary }),
    runtimeSeed: mergeRuntimeSeedWithSummary(sourceChat, summary),
  });
}

export function updateSourceChatAfterConflictExpression(sourceChat: GroupChat, payload: SocialEventCandidatePayload, actorName: string) {
  const summary = `${actorName} 把刚才的不满直接摊开说了。`;
  const shiftedRoom = calculateRoomShift(sourceChat.worldState.structuredRoomState || null, {
    kind: 'challenge',
    actorId: payload.initiatorId,
    targetId: payload.targetIds?.[0] || null,
    intensity: 2,
    tone: 'annoyed',
    evidenceText: (payload.sourceText || summary).slice(0, 120),
    confidence: payload.confidence,
  });
  const effectEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'relationship_delta',
    summary: `冲突回流：${summary}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      eventKind: 'conflict_expression',
      effectType: 'artifact',
      summary: `冲突回流：${summary}`,
      confidence: payload.confidence,
    },
  });
  const memoryEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'memory_candidate',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      kind: 'relationship',
      text: summary,
      salience: 0.74,
      confidence: payload.confidence,
    },
  });
  const artifactEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'artifact',
    summary,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: {
      artifactType: 'conflict_note',
      eventKind: 'conflict_expression',
      text: summary,
      title: payload.title,
      activityType: payload.activityType,
      expectedArtifacts: payload.expectedArtifacts || [],
      dedupeKey: payload.dedupeKey,
    },
  });
  const roomShiftEvent = createRuntimeEventV2({
    conversationId: sourceChat.id,
    kind: 'room_shift',
    summary: `冲突表达后房间态势微调：热度 ${shiftedRoom.nextState.heat} / 凝聚 ${shiftedRoom.nextState.cohesion}`,
    actorIds: [payload.initiatorId],
    targetIds: payload.targetIds,
    visibility: 'derived_public',
    payload: shiftedRoom.shift,
  });
  return withFrameworkPatch(sourceChat, {
    lastMessageAt: Date.now(),
    runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [effectEvent, memoryEvent, artifactEvent, roomShiftEvent]),
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      ...(sourceChat.worldState || {}),
      structuredRoomState: shiftedRoom.nextState,
      recentEvent: summary.slice(0, 120),
    },
    ...accumulateChatRuntime(sourceChat, { type: 'event', content: summary }),
    runtimeSeed: mergeRuntimeSeedWithSummary(sourceChat, summary),
  });
}


export function pickAutoPairPrivateThreadCandidate(chat: GroupChat) {
  return findLatestAutoOpenCandidate(chat);
}

function findLatestCoolingCompanionshipPairCandidate(chat: GroupChat) {
  return findLatestPendingSocialCandidate(chat, 'pair_private_thread', 0.8, (event) => {
    const payload = event.payload as SocialEventCandidatePayload;
    return isCompanionshipPrivateThreadPayload(payload)
      && payload.participantIds.length === 2
      && payload.confidence >= 0.8
      && Boolean(getRecentCompanionshipPrivateThreadSchedule({
        chat,
        participantIds: payload.participantIds,
        now: Date.now(),
      }));
  });
}

export function buildPrivateThreadOpenedEvent(chat: GroupChat, candidateEvent: RuntimeEventV2): RuntimeEventV2 {
  const payload = candidateEvent.payload as SocialEventCandidatePayload;
  return createRuntimeEventV2({
    conversationId: chat.id,
    kind: 'artifact',
    summary: '已自动派生双人私聊',
    actorIds: [payload.initiatorId],
    targetIds: payload.participantIds,
    visibility: 'derived_public',
    payload: {
      artifactType: 'private_thread_opened',
      candidateId: candidateEvent.id,
      eventKind: payload.eventKind,
      participantIds: payload.participantIds,
      reasonType: payload.reasonType,
      triggerReason: payload.triggerReason,
      openingMessage: payload.openingMessage,
    },
  });
}

function isCompanionshipPrivateThreadPayload(payload: SocialEventCandidatePayload) {
  return payload.eventKind === 'pair_private_thread' && payload.reasonType?.startsWith('companionship_');
}

function buildCompanionshipPrivateThreadOpenedScheduleEvent(chat: GroupChat, candidateEvent: RuntimeEventV2, privateChatId?: string | null): RuntimeEventV2 | null {
  const payload = candidateEvent.payload as SocialEventCandidatePayload;
  if (!isCompanionshipPrivateThreadPayload(payload)) return null;
  const createdAt = Date.now();
  return buildCompanionshipPrivateThreadScheduleEvent({
    chat,
    candidateEvent,
    payload,
    action: 'opened',
    privateChatId: privateChatId || undefined,
    nextAvailableAt: createdAt + getCompanionshipPrivateThreadCooldownMs(),
    createdAt,
  });
}

type SocialRuntimeMessageInput = {
  chatId: string;
  type: 'ai' | 'system';
  senderId: string;
  senderName: string;
  content: string;
  emotion: number;
};

export interface SocialEventRuntimeOps {
  chats: GroupChat[];
  characters: AICharacter[];
  messages?: Message[];
  imageModelEnabled?: boolean;
  textApiConfig?: APIConfig | null;
  allowWorldFallback?: boolean;
  updateChat: (chatId: string, patch: Partial<GroupChat>) => Promise<unknown>;
  addChat: (input: Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'>) => Promise<GroupChat>;
  addMessage: (message: SocialRuntimeMessageInput) => Promise<unknown>;
  appendEventMessage: (chatId: string, payload: { eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown; visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public'; visibleToIds?: string[]; visibleToRoles?: string[] }) => Promise<void>;
}

function buildHandledSocialEventMarker(eventId: string) {
  return `handled_social_event:${eventId}`;
}

function hasHandledSocialEvent(chat: GroupChat, eventId: string) {
  return (chat.runtimeEventsV2 || []).some((event) => event.kind === 'artifact' && event.summary === buildHandledSocialEventMarker(eventId));
}

function buildHandledSocialEventRuntimeEvent(chat: GroupChat, eventId: string, actorId?: string | null) {
  return createRuntimeEventV2({
    conversationId: chat.id,
    kind: 'artifact',
    summary: buildHandledSocialEventMarker(eventId),
    actorIds: actorId ? [actorId] : [],
    visibility: 'derived_public',
    payload: {
      artifactType: 'handled_social_event',
      eventId,
    },
  });
}

function appendHandledSocialEvent(chat: GroupChat, patch: Partial<GroupChat>, eventId: string, actorId?: string | null) {
  const baseEvents = patch.runtimeEventsV2 || chat.runtimeEventsV2 || [];
  return {
    ...patch,
    runtimeEventsV2: appendStructuredRuntimeEvents({ ...chat, runtimeEventsV2: baseEvents } as GroupChat, [buildHandledSocialEventRuntimeEvent(chat, eventId, actorId)]),
  };
}

function hasRecentWorldArtifact(
  chat: GroupChat,
  actorId: string,
  eventKind: 'status_update' | 'post_moment' | 'check_in' | 'react_to_moment' | 'social_outing',
  withinMs: number,
) {
  const now = Date.now();
  return (chat.runtimeEventsV2 || []).some((event) => {
    if (event.kind !== 'artifact') return false;
    const payload = event.payload as { eventKind?: string };
    return payload.eventKind === eventKind && event.actorIds?.[0] === actorId && now - event.createdAt <= withinMs;
  });
}

function hasRecentMomentSignal(chat: GroupChat, withinMs: number) {
  const now = Date.now();
  return (chat.runtimeEventsV2 || []).some((event) => {
    const payload = event.payload as { eventKind?: string; artifactType?: string };
    if (event.kind === 'artifact' && payload.eventKind === 'post_moment' && payload.artifactType === 'moment_text') {
      return now - event.createdAt <= withinMs;
    }
    if (event.kind === 'event_candidate' && payload.eventKind === 'post_moment') {
      return now - event.createdAt <= withinMs;
    }
    return false;
  });
}

function hasRecentAttentionFollowup(chat: GroupChat, actorId: string, withinMs: number) {
  const now = Date.now();
  return (chat.runtimeEventsV2 || []).some((event) => {
    if (now - event.createdAt > withinMs) return false;
    const payload = event.payload as { eventKind?: string };
    if (event.kind === 'artifact' && event.actorIds?.[0] === actorId) {
      return payload.eventKind === 'check_in' || payload.eventKind === 'react_to_moment';
    }
    if (event.kind === 'event_candidate' && event.actorIds?.[0] === actorId) {
      return payload.eventKind === 'check_in' || payload.eventKind === 'react_to_moment';
    }
    return false;
  });
}

function isQuietHours(timestamp: number) {
  const hour = new Date(timestamp).getHours();
  return hour >= 23 || hour < 7;
}

function hasRecentUserPrivateAction(chat: GroupChat, actorId: string, targetId: string, createdAt: number, cooldownMs: number) {
  return (chat.runtimeEventsV2 || []).some((event) => {
    if (event.createdAt >= createdAt || createdAt - event.createdAt > cooldownMs) return false;
    const payload = event.payload as Partial<SocialEventCandidatePayload> & { eventKind?: string; visibilityPlan?: string };
    if (event.kind !== 'event_candidate' && event.kind !== 'artifact') return false;
    if (payload.visibilityPlan !== 'user_private' && payload.eventKind !== 'check_in' && payload.eventKind !== 'pair_private_thread') return false;
    const sameActor = (event.actorIds || [])[0] === actorId;
    const sameTarget = (event.targetIds || []).includes(targetId);
    return sameActor && sameTarget;
  });
}

export function passesWorldAttentionRestraintPolicy(
  chat: GroupChat,
  actorId: string,
  targetId: string,
  createdAt: number,
  eventKind: SocialEventCandidatePayload['eventKind'],
  reasonType: SocialEventCandidatePayload['reasonType'],
  actor?: AICharacter | null,
  options: { attentionScore?: number } = {},
) {
  if (!actorId || actorId === 'user' || targetId !== 'user') return true;
  if (eventKind === 'check_in' || eventKind === 'react_to_moment' || eventKind === 'social_outing' || eventKind === 'status_update') {
    const companionshipBlock = shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: actor,
      chat,
      eventKind,
      reasonType,
      attentionScore: options.attentionScore,
      now: createdAt,
    });
    if (companionshipBlock.blocked) return false;
  }
  const relation = getRelationshipLedgerEntry(chat.relationshipLedger || [], actorId, targetId);
  const warmth = relation?.current.warmth || 0;
  const trust = relation?.current.trust || 0;
  const threat = relation?.current.threat || 0;
  const relationSignal = warmth + trust;
  const worldAttentionInvite = reasonType === 'world_attention_invite_activity';
  const worldAttentionReminder = reasonType === 'world_attention_calendar_reminder';
  if (worldAttentionInvite || worldAttentionReminder) {
    if (threat >= 8) return false;
  }
  if (worldAttentionInvite) {
    if (relationSignal < 8) return false;
    if (isQuietHours(createdAt)) return false;
    if (hasRecentUserPrivateAction(chat, actorId, targetId, createdAt, 3 * 60 * 60_000)) return false;
  }
  if (worldAttentionReminder) {
    if (relationSignal < 6) return false;
    if (isQuietHours(createdAt) && relationSignal < 10) return false;
    if (hasRecentUserPrivateAction(chat, actorId, targetId, createdAt, 2 * 60 * 60_000)) return false;
  }
  if (eventKind === 'check_in') {
    if (threat >= 8) return false;
    if (relation && warmth + trust < 3) return false;
    if (isQuietHours(createdAt) && (relation ? warmth + trust < 9 : true)) return false;
    if (hasRecentUserPrivateAction(chat, actorId, targetId, createdAt, 90 * 60_000)) return false;
  }
  if (eventKind === 'react_to_moment') {
    if (isQuietHours(createdAt)) return false;
    const recentReactionCount = (chat.runtimeEventsV2 || []).filter((event) => {
      if (event.createdAt >= createdAt || createdAt - event.createdAt > 2 * 60 * 60_000) return false;
      if (event.kind !== 'artifact') return false;
      const artifactPayload = event.payload as { artifactType?: string; eventKind?: string };
      return artifactPayload.artifactType === 'moment_reaction_note'
        && artifactPayload.eventKind === 'react_to_moment'
        && (event.actorIds || [])[0] === actorId;
    }).length;
    if (recentReactionCount >= 2) return false;
  }
  return true;
}

function shouldConsumeCandidateWithRestraint(chat: GroupChat, payload: SocialEventCandidatePayload, createdAt: number) {
  const recentDedupeArtifactExists = (() => {
    const dedupeKey = payload.dedupeKey;
    if (!dedupeKey) return false;
    const configByEventKind: Record<SocialEventCandidatePayload['eventKind'], { artifactType: string; windowMs: number } | null> = {
      post_moment: { artifactType: 'moment_text', windowMs: 6 * 60 * 60_000 },
      status_update: { artifactType: 'status_note', windowMs: 3 * 60 * 60_000 },
      check_in: { artifactType: 'check_in_note', windowMs: 2 * 60 * 60_000 },
      react_to_moment: { artifactType: 'moment_reaction_note', windowMs: 2 * 60 * 60_000 },
      gift_exchange: { artifactType: 'gift_note', windowMs: 6 * 60 * 60_000 },
      conflict_expression: { artifactType: 'conflict_note', windowMs: 6 * 60 * 60_000 },
      social_outing: { artifactType: 'outing_summary', windowMs: 6 * 60 * 60_000 },
      pair_private_thread: { artifactType: 'private_thread_opened', windowMs: 30 * 60_000 },
      custom: null,
    };
    const config = configByEventKind[payload.eventKind];
    if (!config) return false;
    return (chat.runtimeEventsV2 || []).some((event) => {
      if (event.kind !== 'artifact') return false;
      const artifactPayload = event.payload as { artifactType?: string; dedupeKey?: string };
      if (artifactPayload.artifactType !== config.artifactType) return false;
      if (artifactPayload.dedupeKey !== dedupeKey) return false;
      const sameActor = (event.actorIds || [])[0] === payload.initiatorId;
      if (!sameActor) return false;
      return Math.abs(createdAt - event.createdAt) <= config.windowMs;
    });
  })();
  if (recentDedupeArtifactExists) return false;
  if (!['check_in', 'react_to_moment', 'social_outing', 'status_update'].includes(payload.eventKind)) return true;
  const actorId = payload.initiatorId;
  const targetId = payload.targetIds?.[0] || 'user';
  const reasonType = payload.reasonType || 'world_attention_followup';
  return passesWorldAttentionRestraintPolicy(chat, actorId, targetId, createdAt, payload.eventKind, reasonType);
}

function isValidAutoFlowCandidate(chat: GroupChat, payload: SocialEventCandidatePayload) {
  const memberIds = new Set(chat.memberIds || []);
  const userInChat = memberIds.has('user') || chat.type === 'direct';
  const initiatorId = payload.initiatorId;
  if (!initiatorId || !memberIds.has(initiatorId)) return false;

  const participantIds = Array.isArray(payload.participantIds) ? payload.participantIds.filter(Boolean) : [];
  const targetIds = Array.isArray(payload.targetIds) ? payload.targetIds.filter(Boolean) : [];
  if (!participantIds.includes(initiatorId)) return false;
  const allIds = Array.from(new Set([...participantIds, ...targetIds]));
  const nonUserUnknown = allIds.filter((id) => id !== 'user' && !memberIds.has(id));
  if (nonUserUnknown.length) return false;
  const referencesUser = participantIds.includes('user') || targetIds.includes('user');
  if (referencesUser && !userInChat) return false;

  if (payload.eventKind === 'pair_private_thread') {
    if (participantIds.length !== 2) return false;
    if (participantIds.includes('user')) return false;
  }

  if (payload.eventKind === 'check_in' || payload.eventKind === 'react_to_moment' || payload.eventKind === 'status_update') {
    const firstTarget = targetIds[0] || 'user';
    if (firstTarget !== 'user') return false;
  }

  const visibilityPlan = payload.visibilityPlan;
  const visibilityAllowedByKind: Record<SocialEventCandidatePayload['eventKind'], ReadonlyArray<SocialEventCandidatePayload['visibilityPlan']>> = {
    pair_private_thread: ['conversation_private'],
    check_in: ['user_private'],
    react_to_moment: ['user_private'],
    status_update: ['public'],
    post_moment: ['public'],
    social_outing: ['mixed', 'public'],
    gift_exchange: ['public', 'mixed'],
    conflict_expression: ['public', 'mixed'],
    custom: ['public', 'conversation_private', 'user_private', 'mixed'],
  };
  if (!visibilityAllowedByKind[payload.eventKind].includes(visibilityPlan)) return false;

  const expectedArtifacts = Array.isArray(payload.expectedArtifacts) ? payload.expectedArtifacts.filter(Boolean) : [];
  const canonicalArtifactByKind: Record<SocialEventCandidatePayload['eventKind'], string | null> = {
    pair_private_thread: 'private_thread_summary',
    check_in: 'check_in_note',
    react_to_moment: 'moment_reaction_note',
    status_update: 'status_note',
    post_moment: 'moment_text',
    social_outing: 'outing_summary',
    gift_exchange: 'gift_note',
    conflict_expression: 'conflict_note',
    custom: null,
  };
  const canonical = canonicalArtifactByKind[payload.eventKind];
  const strictArtifactContract = (payload.reasonType || '').startsWith('world_attention_');
  if (strictArtifactContract && canonical && expectedArtifacts.length > 0 && !expectedArtifacts.includes(canonical)) return false;

  return true;
}

function buildDueCompanionshipCareCandidate(
  chat: GroupChat,
  characters: AICharacter[],
  now: number,
): RuntimeEventV2 | null {
  const actor = characters.find((character) => chat.memberIds.includes(character.id));
  if (!actor) return null;
  const topic = readDueCompanionshipCareTopicsFromEvents(chat, actor.id, now)[0];
  if (!topic) return null;
  const reasonType = 'companionship_pending_care_due';
  if (hasRecentWorldArtifact(chat, actor.id, 'check_in', 90 * 60_000)) return null;
  if (!passesWorldAttentionRestraintPolicy(chat, actor.id, 'user', now, 'check_in', reasonType, actor, { attentionScore: topic.urgency === 'high' ? 0.86 : 0.74 })) return null;
  const confidence = topic.urgency === 'high' ? 0.88 : topic.urgency === 'medium' ? 0.84 : 0.78;
  return createRuntimeEventV2({
    conversationId: chat.id,
    kind: 'event_candidate',
    actorIds: [actor.id],
    targetIds: ['user'],
    visibility: 'derived_public',
    summary: `${actor.name} 触发到期关心事项问候候选`,
    payload: {
      eventKind: 'check_in',
      initiatorId: actor.id,
      participantIds: [actor.id],
      targetIds: ['user'],
      reasonType,
      confidence,
      urgency: topic.urgency === 'high' ? 'immediate' : 'soon',
      seedIntent: `用户之前提到“${topic.text}”，现在适合低压力地关心后续。这个主动关怀意图只约束语气和时机，不限制用户若继续提出任务时的回答完整度。`,
      triggerReason: `PendingCareTopic due: ${topic.text}`,
      visibilityPlan: 'user_private',
      expectedArtifacts: ['check_in_note'],
      sourceText: topic.evidence || topic.text,
      decisionSource: 'local_fallback',
      title: '关心追问',
      activityType: '关心事项追问',
      dedupeKey: `companionship-care-due-${chat.id}-${actor.id}-${topic.id}`,
    } satisfies SocialEventCandidatePayload,
  });
}

function buildDueCompanionshipPromiseCandidate(
  chat: GroupChat,
  characters: AICharacter[],
  now: number,
): RuntimeEventV2 | null {
  if (chat.type !== 'direct') return null;
  const actor = characters.find((character) => chat.memberIds.includes(character.id));
  if (!actor) return null;
  const projection = buildUserCompanionshipProjection({
    chat,
    character: actor,
    messages: [],
    now,
  });
  const promise = projection.userBond?.pendingPromises
    .filter((item) => item.reminderPolicy.shouldRemind && typeof item.dueAt === 'number' && item.dueAt <= now)
    .filter((item) => item.reminderPolicy.maxFollowUps > 0)
    .sort((left, right) => (left.dueAt || left.updatedAt) - (right.dueAt || right.updatedAt))[0];
  if (!promise) return null;
  const reasonType = 'companionship_pending_promise_due';
  if (hasRecentWorldArtifact(chat, actor.id, 'check_in', 12 * 60 * 60_000)) return null;
  if (!passesWorldAttentionRestraintPolicy(chat, actor.id, 'user', now, 'check_in', reasonType, actor, { attentionScore: 0.76 })) return null;
  return createRuntimeEventV2({
    conversationId: chat.id,
    kind: 'event_candidate',
    actorIds: [actor.id],
    targetIds: ['user'],
    visibility: 'derived_public',
    summary: `${actor.name} 触发到期未完成约定问候候选`,
    payload: {
      eventKind: 'check_in',
      initiatorId: actor.id,
      participantIds: [actor.id],
      targetIds: ['user'],
      reasonType,
      confidence: 0.8,
      urgency: 'soon',
      seedIntent: promise.reminderPolicy.seedIntent || `用户和${actor.name}之前有个约定“${promise.text}”，现在适合自然提一下，不要催促。`,
      triggerReason: `PendingPromise due: ${promise.text}; kind=${promise.kind}; tone=${promise.reminderPolicy.tone}`,
      visibilityPlan: 'user_private',
      expectedArtifacts: ['check_in_note'],
      sourceText: promise.evidence || promise.text,
      decisionSource: 'local_fallback',
      title: '约定追问',
      activityType: promise.kind === 'shared_activity' ? '共同约定追问' : promise.kind === 'user_followup' ? '用户事项回访' : '未完成约定追问',
      dedupeKey: `companionship-promise-due-${chat.id}-${actor.id}-${promise.id}`,
    } satisfies SocialEventCandidatePayload,
  });
}

function buildOnlineReturnCompanionshipGreetingCandidate(
  chat: GroupChat,
  characters: AICharacter[],
  messages: Message[],
  now: number,
): RuntimeEventV2 | null {
  if (chat.type !== 'direct') return null;
  const actor = characters.find((character) => chat.memberIds.includes(character.id));
  if (!actor) return null;
  if (hasRecentWorldArtifact(chat, actor.id, 'check_in', 6 * 60 * 60_000)) return null;
  const signature = buildCompanionshipStatusSignature({
    chat,
    character: actor,
    messages,
    now,
  });
  const onlineReturn = signature?.onlineReturn?.trim();
  if (!onlineReturn) return null;
  const onlineReturnIntent = signature?.onlineReturnIntent?.trim()
    || '用户长时间离开后回到会话。角色可以低打扰地欢迎回来，顺着当前对话自然接上，不要催促或质问离开原因。';
  const reasonType = 'companionship_online_return_greeting';
  const attentionScore = signature?.debugLines.some((line) => line.includes('pendingCareTopics=') && !line.endsWith('=0')) ? 0.82 : 0.76;
  if (!passesWorldAttentionRestraintPolicy(chat, actor.id, 'user', now, 'check_in', reasonType, actor, { attentionScore })) return null;
  return createRuntimeEventV2({
    conversationId: chat.id,
    kind: 'event_candidate',
    actorIds: [actor.id],
    targetIds: ['user'],
    visibility: 'derived_public',
    summary: `${actor.name} 触发上线回归问候候选`,
    payload: {
      eventKind: 'check_in',
      initiatorId: actor.id,
      participantIds: [actor.id],
      targetIds: ['user'],
      reasonType,
      confidence: attentionScore,
      urgency: 'soon',
      seedIntent: `${onlineReturnIntent} 这个主动问候意图只约束语气和时机，不限制用户若继续提出任务时的回答完整度。`,
      triggerReason: `Online return: ${onlineReturn}`,
      visibilityPlan: 'user_private',
      expectedArtifacts: ['check_in_note'],
      sourceText: onlineReturn,
      decisionSource: 'local_fallback',
      title: '上线问候',
      activityType: '上线回归问候',
      dedupeKey: `companionship-online-return-${chat.id}-${actor.id}`,
    } satisfies SocialEventCandidatePayload,
  });
}

function buildStaleCompanionshipCareEvents(
  chat: GroupChat,
  characters: AICharacter[],
  now: number,
): RuntimeEventV2[] {
  return characters
    .filter((character) => chat.memberIds.includes(character.id))
    .flatMap((character) => readStaleCompanionshipCareTopicsFromEvents(chat, character.id, now).map((topic) => createRuntimeEventV2({
      conversationId: chat.id,
      kind: 'artifact',
      actorIds: ['user'],
      targetIds: [character.id],
      visibility: 'pair_private',
      summary: `${character.name} 将过期关心事项标记为不再主动追问`,
      payload: {
        eventType: 'companionship_care_topic',
        characterId: character.id,
        userId: 'user',
        topicId: topic.id,
        topicText: topic.text,
        action: 'stale',
        urgency: topic.urgency,
        reason: topic.restraintReason || 'care topic is past its useful follow-up window',
        evidence: topic.evidence,
        sourceMessageIds: topic.sourceMessageIds,
        decisionSource: 'local_fallback',
        confidence: 0.8,
      },
    })))
    .slice(0, 4);
}

async function buildWorldDrivenCandidate(
  chat: GroupChat,
  characters: AICharacter[],
  messages: Message[] = [],
  imageModelEnabled = false,
): Promise<{
  candidate: RuntimeEventV2 | null;
}> {
  const now = Date.now();
  const dueCareCandidate = buildDueCompanionshipCareCandidate(chat, characters, now);
  if (dueCareCandidate) return { candidate: dueCareCandidate };
  const duePromiseCandidate = buildDueCompanionshipPromiseCandidate(chat, characters, now);
  if (duePromiseCandidate) return { candidate: duePromiseCandidate };
  const onlineReturnCandidate = buildOnlineReturnCompanionshipGreetingCandidate(chat, characters, messages, now);
  if (onlineReturnCandidate) return { candidate: onlineReturnCandidate };
  const attention = projectWorldAttentionStates([chat], characters).find((item) => item.targetId === 'user' && item.actorId !== 'user');
  if (!attention) return { candidate: null };
  const actor = characters.find((item) => item.id === attention.actorId) || null;
  if (attention.attentionScore < 0.58 || attention.restraint > 0.72) return { candidate: null };
  const upcomingCalendarItem = projectWorldCalendar([chat], characters, { now }).items
    .filter((item) => item.status !== 'cancelled' && item.status !== 'completed')
    .find((item) => {
      if (!item.participantIds.includes(attention.actorId) || !item.participantIds.includes('user')) return false;
      const startAt = typeof item.startAt === 'number' ? item.startAt : null;
      if (!startAt) return false;
      return startAt >= now && startAt - now <= 6 * 60 * 60_000;
    });
  const hasRecentFollowup = hasRecentAttentionFollowup(chat, attention.actorId, 120 * 60_000);
  const inviteReasonType: SocialEventCandidatePayload['reasonType'] = 'world_attention_invite_activity';
  const reminderReasonType: SocialEventCandidatePayload['reasonType'] = 'world_attention_calendar_reminder';
  const privateMessageReasonType: SocialEventCandidatePayload['reasonType'] = 'world_attention_private_message';
  const followupQuestionReasonType: SocialEventCandidatePayload['reasonType'] = 'world_attention_followup_question';
  const followupReasonType: SocialEventCandidatePayload['reasonType'] = 'world_attention_followup';
  const canPrivateMessage = attention.suggestedActions.includes('private_message')
    && !hasRecentFollowup
    && !hasRecentWorldArtifact(chat, attention.actorId, 'check_in', 120 * 60_000)
    && passesWorldAttentionRestraintPolicy(chat, attention.actorId, 'user', now, 'check_in', privateMessageReasonType, actor, { attentionScore: attention.attentionScore });
  const canAskFollowup = attention.suggestedActions.includes('ask_followup')
    && !hasRecentFollowup
    && !hasRecentWorldArtifact(chat, attention.actorId, 'check_in', 120 * 60_000)
    && passesWorldAttentionRestraintPolicy(chat, attention.actorId, 'user', now, 'check_in', followupQuestionReasonType, actor, { attentionScore: attention.attentionScore });
  const canCheckIn = attention.suggestedActions.includes('check_in')
    && !hasRecentWorldArtifact(chat, attention.actorId, 'check_in', 90 * 60_000)
    && passesWorldAttentionRestraintPolicy(chat, attention.actorId, 'user', now, 'check_in', followupReasonType, actor, { attentionScore: attention.attentionScore });
  const canReactMoment = attention.suggestedActions.includes('react_to_moment')
    && hasRecentMomentSignal(chat, 7 * 24 * 60 * 60_000)
    && !hasRecentWorldArtifact(chat, attention.actorId, 'react_to_moment', 120 * 60_000)
    && passesWorldAttentionRestraintPolicy(chat, attention.actorId, 'user', now, 'react_to_moment', followupReasonType, actor, { attentionScore: attention.attentionScore });
  const canInviteActivity = false;
  const canCalendarReminder = attention.suggestedActions.includes('calendar_reminder')
    && !hasRecentWorldArtifact(chat, attention.actorId, 'status_update', 120 * 60_000)
    && passesWorldAttentionRestraintPolicy(chat, attention.actorId, 'user', now, 'status_update', reminderReasonType, actor, { attentionScore: attention.attentionScore });
  const canStatus = !hasRecentWorldArtifact(chat, attention.actorId, 'status_update', 90 * 60_000)
    && passesWorldAttentionRestraintPolicy(chat, attention.actorId, 'user', now, 'status_update', 'world_attention_followup', actor, { attentionScore: attention.attentionScore });
  const isLateNight = (() => {
    const hour = new Date(now).getHours();
    return hour >= 23 || hour < 7;
  })();
  const actorNightOwl = isNightOwlPersona(actor);
  const lastSocialArtifactAt = (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact' && ['social_outing', 'check_in', 'react_to_moment', 'status_update', 'gift_exchange'].includes((event.payload as { eventKind?: string }).eventKind || ''))
    .map((event) => event.createdAt)
    .sort((a, b) => b - a)[0];
  const pendingDelayWindowUntil = readPendingMomentDelayWindow(chat, attention.actorId, now);
  const postMomentDelayBlocked = pendingDelayWindowUntil != null || (typeof lastSocialArtifactAt === 'number' && now - lastSocialArtifactAt < 18 * 60_000);
  const canPostMoment = isCharacterFeatureEnabled(actor, 'moments')
    && !(isLateNight && !actorNightOwl)
    && !postMomentDelayBlocked
    && !hasRecentWorldArtifact(chat, attention.actorId, 'post_moment', 180 * 60_000);
  const shouldPrioritizeCalendarReminder = Boolean(upcomingCalendarItem) && canCalendarReminder;
  const minutesUntil = upcomingCalendarItem?.startAt ? Math.max(0, Math.round((upcomingCalendarItem.startAt - now) / 60_000)) : null;
  const buildCandidateChoice = (
    eventKind: SocialEventCandidatePayload['eventKind'],
    reasonType: SocialEventCandidatePayload['reasonType'],
    mode: 'calendar' | 'invite' | 'private' | 'followup' | 'checkin' | 'react' | 'moment' | 'status',
  ) => {
    const seedIntent = mode === 'calendar'
      ? `${upcomingCalendarItem?.summary || upcomingCalendarItem?.title || '临近日程提醒'}${minutesUntil !== null ? `（${minutesUntil} 分钟后）` : ''}`
      : mode === 'invite'
        ? (attention.reasons[0] || '关注状态触发一次线下邀约。')
        : mode === 'private'
          ? (attention.reasons[0] || '关注状态触发一次私域问候。')
          : mode === 'followup'
            ? (attention.reasons[0] || '关注状态触发一次追问式关心。')
            : mode === 'checkin'
              ? (attention.reasons[0] || '关注状态触发一次自然近况同步。')
              : mode === 'react'
                ? (attention.reasons[0] || '关注状态触发一次动态回应。')
                : mode === 'moment'
                  ? (attention.reasons[0] || '关注状态触发一次动态分享。')
                  : (attention.reasons[0] || '关注状态触发一次状态更新。');
    const postMomentExpectedArtifacts = eventKind === 'post_moment'
      ? buildPostMomentExpectedArtifactsForWorldCandidate(chat, attention.actorId, now, imageModelEnabled)
      : null;
    const postMomentActivityType = eventKind === 'post_moment'
      ? (postMomentExpectedArtifacts?.includes('moment_selfie')
        ? '自拍动态'
        : postMomentExpectedArtifacts?.includes('moment_group_photo')
          ? '合影动态'
          : postMomentExpectedArtifacts?.includes('moment_scene_photo')
            ? '场景动态'
            : '日常动态')
      : null;
    const postMomentTitle = eventKind === 'post_moment'
      ? (postMomentExpectedArtifacts?.includes('moment_selfie')
        ? '随手自拍'
        : postMomentExpectedArtifacts?.includes('moment_group_photo')
          ? '合影记录'
          : postMomentExpectedArtifacts?.includes('moment_scene_photo')
            ? '场景碎片'
            : '朋友圈')
      : null;
    return {
      eventKind,
      reasonType,
      mode,
      seedIntent,
      expectedArtifacts: eventKind === 'post_moment'
        ? (postMomentExpectedArtifacts || ['moment_text'])
        : eventKind === 'check_in'
          ? ['check_in_note']
          : eventKind === 'react_to_moment'
            ? ['moment_reaction_note']
            : eventKind === 'social_outing'
              ? ['outing_summary']
              : ['status_note'],
      title: eventKind === 'post_moment'
        ? (postMomentTitle || '朋友圈')
        : eventKind === 'social_outing'
          ? '活动邀约'
          : eventKind === 'check_in'
            ? (mode === 'private' ? '私聊问候' : mode === 'followup' ? '追问跟进' : mode === 'checkin' ? '问候跟进' : '关怀问候')
            : eventKind === 'react_to_moment'
              ? '动态回应'
              : '状态更新',
      activityType: eventKind === 'post_moment'
        ? (postMomentActivityType || '日常动态')
        : eventKind === 'social_outing'
          ? '活动邀约'
          : eventKind === 'check_in'
            ? (mode === 'private' ? '私聊问候' : mode === 'followup' ? '追问关心' : mode === 'checkin' ? '问候' : '安抚关怀')
            : eventKind === 'react_to_moment'
              ? '动态互动'
              : mode === 'calendar'
                ? '日程提醒'
                : '近况同步',
      visibilityPlan: eventKind === 'post_moment' || eventKind === 'status_update'
        ? 'public'
        : eventKind === 'social_outing'
          ? 'mixed'
          : 'user_private' as SocialEventCandidatePayload['visibilityPlan'],
      dedupeKey: mode === 'calendar'
        ? `calendar-upcoming-reminder-${chat.id}-${attention.actorId}-${upcomingCalendarItem?.id || 'item'}`
        : `world-attention-${eventKind}-${chat.id}-${attention.actorId}`,
    };
  };
  const choices: Array<ReturnType<typeof buildCandidateChoice>> = [];
  if (shouldPrioritizeCalendarReminder) choices.push(buildCandidateChoice('status_update', 'world_calendar_upcoming_reminder', 'calendar'));
  if (canInviteActivity) choices.push(buildCandidateChoice('social_outing', inviteReasonType, 'invite'));
  if (canCalendarReminder) choices.push(buildCandidateChoice('status_update', reminderReasonType, 'calendar'));
  if (canPrivateMessage) choices.push(buildCandidateChoice('check_in', privateMessageReasonType, 'private'));
  if (canAskFollowup) choices.push(buildCandidateChoice('check_in', followupQuestionReasonType, 'followup'));
  if (canCheckIn) choices.push(buildCandidateChoice('check_in', followupReasonType, 'checkin'));
  if (attention.suggestedActions.includes('comfort') && canCheckIn) choices.push(buildCandidateChoice('check_in', 'world_attention_comfort', 'checkin'));
  if (canReactMoment) choices.push(buildCandidateChoice('react_to_moment', followupReasonType, 'react'));
  if (canPostMoment) {
    const momentDefault = buildCandidateChoice('post_moment', 'world_attention_share_moment', 'moment');
    choices.push(momentDefault);
    choices.push({
      ...momentDefault,
      reasonType: 'world_attention_share_moment_event',
      title: '事件记录',
      activityType: '事件纪实',
      seedIntent: `${attention.reasons[0] || '刚经历了一个值得记录的片段。'}适合发一条事件纪实动态。`,
      dedupeKey: `world-attention-post_moment_event-${chat.id}-${attention.actorId}`,
    });
    choices.push({
      ...momentDefault,
      reasonType: 'world_attention_share_moment_inner',
      title: '内心小记',
      activityType: '心情随笔',
      seedIntent: `${attention.reasons[0] || '情绪还在回响。'}适合发一条偏内心感受的动态。`,
      dedupeKey: `world-attention-post_moment_inner-${chat.id}-${attention.actorId}`,
    });
  }
  if (canStatus) choices.push(buildCandidateChoice('status_update', 'world_attention_followup', 'status'));
  if (choices.length === 0) return { candidate: null };
  const chosen = choices[0];
  const actorName = characters.find((item) => item.id === attention.actorId)?.name || attention.actorId;
  const eventKind: SocialEventCandidatePayload['eventKind'] = chosen.eventKind;
  if (!canPrivateMessage && !canAskFollowup && !canCheckIn && !canReactMoment && !canPostMoment && !canStatus && !canInviteActivity && !canCalendarReminder) {
    return { candidate: null };
  }
  const bias = readWorldInfluenceBias(chat, attention.actorId, now);
  const baseConfidence = attention.attentionScore * (1 - attention.restraint * 0.35);
  const confidence = Math.max(
    0.72,
    Math.min(
      0.95,
      baseConfidence
        + (eventKind === 'check_in' ? bias.comfortBoost : 0)
        + (eventKind === 'status_update' ? bias.scheduleBoost : 0)
        - (eventKind === 'social_outing' ? bias.scheduleBoost * 0.5 : 0)
        - (eventKind === 'post_moment' ? bias.scheduleBoost * 0.45 : 0)
        - ((eventKind === 'check_in' || eventKind === 'social_outing' || eventKind === 'post_moment') ? bias.restraintPenalty : bias.restraintPenalty * 0.5)
    ),
  );
  const relatedCharacters = characters.filter((item) => item.id !== attention.actorId && chat.memberIds.includes(item.id));
  const companionshipSeeds = eventKind === 'post_moment' && actor
    ? buildCompanionshipArtifactSeeds({
      character: actor,
      relatedCharacters,
      surface: 'public_moment',
      includeUserMemory: false,
      max: 4,
      now,
    })
    : [];
  const candidate = createRuntimeEventV2({
    conversationId: chat.id,
    kind: 'event_candidate',
    actorIds: [attention.actorId],
    targetIds: ['user'],
    visibility: 'derived_public',
    createdAt: resolveWorldDrivenCandidateCreatedAt(chat, attention.actorId, now),
    summary: `${actorName} 触发世界驱动${eventKind === 'post_moment'
      ? '动态候选'
      : eventKind === 'social_outing'
        ? '活动邀约候选'
        : eventKind === 'check_in'
          ? '问候跟进候选'
          : eventKind === 'react_to_moment'
            ? '动态回应候选'
            : '状态更新候选'}`,
    payload: {
      eventKind,
      initiatorId: attention.actorId,
      participantIds: eventKind === 'social_outing' ? [attention.actorId, 'user'] : [attention.actorId],
      targetIds: ['user'],
      reasonType: chosen.reasonType,
      confidence,
      urgency: 'soon',
      seedIntent: chosen.seedIntent,
      visibilityPlan: chosen.visibilityPlan,
      expectedArtifacts: chosen.expectedArtifacts,
      companionshipSeeds: eventKind === 'post_moment' ? companionshipSeeds : undefined,
      decisionSource: 'local_fallback',
      title: chosen.title,
      activityType: chosen.activityType,
      dedupeKey: chosen.dedupeKey,
    } satisfies SocialEventCandidatePayload,
  });
  return {
    candidate,
  };
}

async function evaluateWorldDrivenDecision(
  chat: GroupChat,
  characters: AICharacter[],
  messages: Message[] = [],
  imageModelEnabled = false,
) {
  const now = Date.now();
  const staleCareEvents = buildStaleCompanionshipCareEvents(chat, characters, now);
  if (staleCareEvents.length) {
    return {
      candidate: null as RuntimeEventV2 | null,
      suppressionEvents: staleCareEvents,
      decisionEvents: [] as RuntimeEventV2[],
    };
  }
  const dueCareCandidate = buildDueCompanionshipCareCandidate(chat, characters, now);
  if (dueCareCandidate) {
    const payload = dueCareCandidate.payload as SocialEventCandidatePayload;
    const actorName = characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
    return {
      candidate: dueCareCandidate,
      suppressionEvents: [] as RuntimeEventV2[],
      decisionEvents: [buildWorldDecisionEvent({
        chat,
        actorId: payload.initiatorId,
        actorName,
        decisionType: 'trigger',
        reasonType: 'companionship_pending_care_due',
        reasonLabel: '关心事项到期',
        reasonDetail: payload.triggerReason || payload.seedIntent,
        toEventKind: 'check_in',
      })],
    };
  }
  const duePromiseCandidate = buildDueCompanionshipPromiseCandidate(chat, characters, now);
  if (duePromiseCandidate) {
    const payload = duePromiseCandidate.payload as SocialEventCandidatePayload;
    const actorName = characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
    return {
      candidate: duePromiseCandidate,
      suppressionEvents: [] as RuntimeEventV2[],
      decisionEvents: [buildWorldDecisionEvent({
        chat,
        actorId: payload.initiatorId,
        actorName,
        decisionType: 'trigger',
        reasonType: 'companionship_pending_promise_due',
        reasonLabel: '未完成约定到期',
        reasonDetail: payload.triggerReason || payload.seedIntent,
        toEventKind: 'check_in',
      })],
    };
  }
  const onlineReturnCandidate = buildOnlineReturnCompanionshipGreetingCandidate(chat, characters, messages, now);
  if (onlineReturnCandidate) {
    const payload = onlineReturnCandidate.payload as SocialEventCandidatePayload;
    const actorName = characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
    return {
      candidate: onlineReturnCandidate,
      suppressionEvents: [] as RuntimeEventV2[],
      decisionEvents: [buildWorldDecisionEvent({
        chat,
        actorId: payload.initiatorId,
        actorName,
        decisionType: 'trigger',
        reasonType: 'companionship_online_return_greeting',
        reasonLabel: '上线回归问候',
        reasonDetail: payload.triggerReason || payload.seedIntent,
        toEventKind: 'check_in',
      })],
    };
  }
  const attention = projectWorldAttentionStates([chat], characters).find((item) => item.targetId === 'user' && item.actorId !== 'user');
  if (!attention) return { candidate: null as RuntimeEventV2 | null, suppressionEvents: [] as RuntimeEventV2[], decisionEvents: [] as RuntimeEventV2[] };
  const actor = characters.find((item) => item.id === attention.actorId) || null;
  const actorName = actor?.name || attention.actorId;
  const suppressionEvents: RuntimeEventV2[] = [];
  const decisionEvents: RuntimeEventV2[] = [];

  if (attention.attentionScore < 0.58 && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'world_attention_low_score', 20 * 60_000, now)) {
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'world_attention_low_score',
      reasonLabel: '关注分不足',
      reasonDetail: `关注分 ${attention.attentionScore.toFixed(2)} 低于触发阈值 0.58`,
      candidateEventKind: 'status_update',
    }));
    decisionEvents.push(buildWorldDecisionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      decisionType: 'suppressed',
      reasonType: 'world_attention_low_score',
      reasonLabel: '关注分不足',
      reasonDetail: `关注分 ${attention.attentionScore.toFixed(2)} 低于触发阈值 0.58`,
      toEventKind: 'status_update',
    }));
  }

  if (attention.restraint > 0.72 && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'world_attention_high_restraint', 20 * 60_000, now)) {
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'world_attention_high_restraint',
      reasonLabel: '关注克制过高',
      reasonDetail: `克制值 ${attention.restraint.toFixed(2)} 超过限制阈值 0.72`,
      candidateEventKind: 'check_in',
    }));
    decisionEvents.push(buildWorldDecisionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      decisionType: 'suppressed',
      reasonType: 'world_attention_high_restraint',
      reasonLabel: '关注克制过高',
      reasonDetail: `克制值 ${attention.restraint.toFixed(2)} 超过限制阈值 0.72`,
      toEventKind: 'check_in',
    }));
  }

  const shareMomentSuggested = attention.suggestedActions.includes('share_moment');
  const checkInCooldownNextAt = readActionCooldownNextSuggestedAt(chat, attention.actorId, 'check_in', 90 * 60_000, now);
  const reactCooldownNextAt = readActionCooldownNextSuggestedAt(chat, attention.actorId, 'react_to_moment', 120 * 60_000, now);
  const inviteCooldownNextAt = readActionCooldownNextSuggestedAt(chat, attention.actorId, 'social_outing', 6 * 60 * 60_000, now);
  const momentsEnabled = isCharacterFeatureEnabled(actor, 'moments');
  const isLateNight = (() => {
    const hour = new Date(now).getHours();
    return hour >= 23 || hour < 7;
  })();
  const actorNightOwl = isNightOwlPersona(actor);
  const lastSocialArtifactAt = (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact' && ['social_outing', 'check_in', 'react_to_moment', 'status_update', 'gift_exchange'].includes((event.payload as { eventKind?: string }).eventKind || ''))
    .map((event) => event.createdAt)
    .sort((a, b) => b - a)[0];
  const pendingDelayWindowUntil = readPendingMomentDelayWindow(chat, attention.actorId, now);
  const postMomentDelayBlocked = pendingDelayWindowUntil != null || (typeof lastSocialArtifactAt === 'number' && now - lastSocialArtifactAt < 18 * 60_000);
  const postMomentNextSuggestedAt = pendingDelayWindowUntil != null
    ? pendingDelayWindowUntil
    : (postMomentDelayBlocked ? ((lastSocialArtifactAt as number) + 18 * 60_000) : null);
  const boundaryCandidateKind: SocialEventCandidatePayload['eventKind'] | null = attention.suggestedActions.includes('private_message')
    || attention.suggestedActions.includes('ask_followup')
    || attention.suggestedActions.includes('check_in')
    || attention.suggestedActions.includes('comfort')
    ? 'check_in'
    : attention.suggestedActions.includes('react_to_moment')
        ? 'react_to_moment'
        : attention.suggestedActions.includes('calendar_reminder')
          ? 'status_update'
          : null;
  const boundaryReasonType = boundaryCandidateKind === 'status_update'
      ? 'world_attention_calendar_reminder'
      : boundaryCandidateKind === 'check_in'
        ? 'world_attention_private_message'
        : 'world_attention_followup';
  const companionshipBoundary = boundaryCandidateKind
    ? shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: actor,
      chat,
      eventKind: boundaryCandidateKind,
      reasonType: boundaryReasonType,
      attentionScore: attention.attentionScore,
      now,
    })
    : { blocked: false as const };
  if (companionshipBoundary.blocked && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'companionship_boundary', 20 * 60_000, now)) {
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'companionship_boundary',
      reasonLabel: '陪伴边界抑制',
      reasonDetail: `用户边界限制主动联系：${companionshipBoundary.reason || 'companionship care policy blocked proactive contact'}`,
      candidateEventKind: boundaryCandidateKind || 'check_in',
    }));
    decisionEvents.push(buildWorldDecisionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      decisionType: 'suppressed',
      reasonType: 'companionship_boundary',
      reasonLabel: '陪伴边界抑制',
      reasonDetail: `用户边界限制主动联系：${companionshipBoundary.reason || 'companionship care policy blocked proactive contact'}`,
      toEventKind: boundaryCandidateKind || 'check_in',
    }));
  }
  if (shareMomentSuggested && !momentsEnabled && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'world_attention_moment_disabled', 20 * 60_000, now)) {
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'world_attention_moment_disabled',
      reasonLabel: '朋友圈功能关闭',
      reasonDetail: '该角色当前不允许自动发朋友圈，已改走其它世界驱动动作。',
      candidateEventKind: 'post_moment',
    }));
  }
  if (shareMomentSuggested && isLateNight && !actorNightOwl && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'world_attention_moment_quiet_hours', 20 * 60_000, now)) {
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'world_attention_moment_quiet_hours',
      reasonLabel: '夜间发圈抑制',
      reasonDetail: '当前处于夜间时段，且角色并非夜猫人设，暂不触发朋友圈。',
      candidateEventKind: 'post_moment',
    }));
  }
  if (shareMomentSuggested && postMomentDelayBlocked && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'world_attention_moment_delay_window', 20 * 60_000, now)) {
    const waitMinutes = Math.max(1, Math.ceil(((postMomentNextSuggestedAt as number) - now) / 60_000));
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'world_attention_moment_delay_window',
      reasonLabel: '发圈延迟窗口',
      reasonDetail: `距离最近社交产物时间过近，发圈候选延后以避免机械刷屏（建议 ${waitMinutes} 分钟后再触发）。`,
      candidateEventKind: 'post_moment',
      nextSuggestedAt: postMomentNextSuggestedAt as number,
    }));
  }
  if (attention.suggestedActions.includes('check_in') && checkInCooldownNextAt && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'world_attention_check_in_cooldown', 20 * 60_000, now)) {
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'world_attention_check_in_cooldown',
      reasonLabel: '问候冷却中',
      reasonDetail: '近期已执行问候动作，暂缓重复触发。',
      candidateEventKind: 'check_in',
      nextSuggestedAt: checkInCooldownNextAt,
    }));
  }
  if (attention.suggestedActions.includes('react_to_moment') && reactCooldownNextAt && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'world_attention_react_cooldown', 20 * 60_000, now)) {
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'world_attention_react_cooldown',
      reasonLabel: '回应冷却中',
      reasonDetail: '近期已执行动态回应，暂缓重复触发。',
      candidateEventKind: 'react_to_moment',
      nextSuggestedAt: reactCooldownNextAt,
    }));
  }
  if (attention.suggestedActions.includes('invite_activity') && inviteCooldownNextAt && !hasRecentWorldSuppressionEvent(chat, attention.actorId, 'world_attention_invite_cooldown', 20 * 60_000, now)) {
    suppressionEvents.push(buildWorldSuppressionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      reasonType: 'world_attention_invite_cooldown',
      reasonLabel: '邀约冷却中',
      reasonDetail: '近期已发起活动邀约，暂缓重复触发。',
      candidateEventKind: 'social_outing',
      nextSuggestedAt: inviteCooldownNextAt,
    }));
  }

  const candidateResult = await buildWorldDrivenCandidate(chat, characters, messages, imageModelEnabled);
  const candidate = candidateResult.candidate;
  const candidatePayload = candidate?.payload as SocialEventCandidatePayload | undefined;
  const fallbackIntent = attention.suggestedActions.includes('share_moment')
    ? 'post_moment'
    : attention.suggestedActions.includes('private_message')
      ? 'check_in'
      : attention.suggestedActions.includes('ask_followup')
        ? 'check_in'
        : attention.suggestedActions.includes('check_in')
          ? 'check_in'
          : attention.suggestedActions.includes('react_to_moment')
              ? 'react_to_moment'
              : null;
  if (shareMomentSuggested && !momentsEnabled && candidatePayload?.eventKind && candidatePayload.eventKind !== 'post_moment') {
    decisionEvents.push(buildWorldDecisionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      decisionType: 'fallback',
      reasonType: 'world_attention_moment_disabled',
      reasonLabel: '朋友圈功能关闭，改走替代动作',
      reasonDetail: `share_moment 被关闭，已改为 ${candidatePayload.eventKind}`,
      fromEventKind: 'post_moment',
      toEventKind: candidatePayload.eventKind,
    }));
  } else if (
    fallbackIntent
    && candidatePayload?.eventKind === 'status_update'
  ) {
    const cooldownFallbackNextAt = fallbackIntent === 'check_in'
      ? checkInCooldownNextAt
      : fallbackIntent === 'react_to_moment'
        ? reactCooldownNextAt
        : null;
    const fallbackReasonType = fallbackIntent === 'post_moment' && postMomentDelayBlocked
      ? 'world_attention_moment_delay_window'
      : cooldownFallbackNextAt
        ? 'world_attention_cooldown_window'
      : 'world_attention_restrained_fallback';
    const fallbackReasonLabel = fallbackIntent === 'post_moment' && postMomentDelayBlocked
      ? '朋友圈进入延迟窗口，先走状态更新'
      : '主动关怀动作改道为状态更新';
    const fallbackReasonDetail = fallbackIntent === 'post_moment' && postMomentDelayBlocked
      ? `原倾向 post_moment，当前处于延迟窗口，先改为 status_update，建议时间 ${new Date(postMomentNextSuggestedAt as number).toISOString()}`
      : cooldownFallbackNextAt
        ? `原倾向 ${fallbackIntent}，当前处于冷却窗口，先改为 status_update，建议时间 ${new Date(cooldownFallbackNextAt).toISOString()}`
        : `原倾向 ${fallbackIntent}，因冷却/克制/边界限制改为 status_update`;
    decisionEvents.push(buildWorldDecisionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      decisionType: 'fallback',
      reasonType: fallbackReasonType,
      reasonLabel: fallbackReasonLabel,
      reasonDetail: fallbackReasonDetail,
      fromEventKind: fallbackIntent,
      toEventKind: 'status_update',
      nextSuggestedAt: fallbackIntent === 'post_moment' && postMomentDelayBlocked
        ? (postMomentNextSuggestedAt as number)
        : (cooldownFallbackNextAt || undefined),
    }));
  } else if (candidatePayload?.eventKind) {
    decisionEvents.push(buildWorldDecisionEvent({
      chat,
      actorId: attention.actorId,
      actorName,
      decisionType: 'trigger',
      reasonType: 'world_attention_triggered',
      reasonLabel: '世界驱动触发',
      reasonDetail: `根据关注状态触发 ${candidatePayload.eventKind}`,
      toEventKind: candidatePayload.eventKind,
    }));
  }
  return { candidate, suppressionEvents, decisionEvents };
}

export async function runSocialEventAutoFlow(sourceChat: GroupChat, ops: SocialEventRuntimeOps): Promise<{ privateChatId?: string | null; handledEventId?: string | null }> {
  const coolingPairCandidate = findLatestCoolingCompanionshipPairCandidate(sourceChat);
  if (coolingPairCandidate && !hasHandledSocialEvent(sourceChat, coolingPairCandidate.id)) {
    const payload = coolingPairCandidate.payload as SocialEventCandidatePayload;
    const latestSchedule = getRecentCompanionshipPrivateThreadSchedule({
      chat: sourceChat,
      participantIds: payload.participantIds,
      now: Date.now(),
    });
    const nextAvailableAt = (latestSchedule?.payload as { nextAvailableAt?: number } | undefined)?.nextAvailableAt;
    const skippedEvent = buildCompanionshipPrivateThreadScheduleEvent({
      chat: sourceChat,
      candidateEvent: coolingPairCandidate,
      payload,
      action: 'skipped',
      nextAvailableAt,
    });
    await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, withFrameworkPatch(sourceChat, {
      runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [skippedEvent]),
    }), coolingPairCandidate.id, payload.initiatorId));
    return { privateChatId: null, handledEventId: coolingPairCandidate.id };
  }

  const pairCandidate = pickAutoPairPrivateThreadCandidate(sourceChat);
  if (pairCandidate && hasHandledSocialEvent(sourceChat, pairCandidate.id)) return { privateChatId: null, handledEventId: pairCandidate.id };
  if (pairCandidate) {
    const payload = pairCandidate.payload as SocialEventCandidatePayload;
    if (!isValidAutoFlowCandidate(sourceChat, payload)) return { privateChatId: null, handledEventId: null };
    const [actorId, targetId] = payload.participantIds;
    const privateChat = await createAiPrivateThread({
      sourceChat,
      chats: ops.chats,
      characters: ops.characters,
      starterId: actorId,
      targetId,
      triggerReason: payload.triggerReason || payload.seedIntent,
      openingMessage: payload.openingMessage || payload.seedIntent,
      addChat: ops.addChat,
      addMessage: ops.addMessage,
      appendEventMessage: ops.appendEventMessage,
    });
    if (privateChat) {
      const openedEvent = buildPrivateThreadOpenedEvent(sourceChat, pairCandidate);
      const scheduleEvent = buildCompanionshipPrivateThreadOpenedScheduleEvent(sourceChat, pairCandidate, privateChat.id);
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, withFrameworkPatch(sourceChat, {
        runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [openedEvent, ...(scheduleEvent ? [scheduleEvent] : [])]),
      }), pairCandidate.id, payload.initiatorId));
      return { privateChatId: privateChat.id, handledEventId: pairCandidate.id };
    }
  }

  const momentCandidate = findLatestAutoPostMomentCandidate(sourceChat);
  if (momentCandidate) {
    const payload = momentCandidate.payload as SocialEventCandidatePayload;
    if (!isValidAutoFlowCandidate(sourceChat, payload)) return { handledEventId: null };
    if (hasHandledSocialEvent(sourceChat, momentCandidate.id)) return { handledEventId: momentCandidate.id };
    const actor = ops.characters.find((item) => item.id === payload.initiatorId) || null;
    const actorName = actor?.name || payload.initiatorId;
    const publishGuard = resolvePostMomentPublishGuard({
      chat: sourceChat,
      payload,
      actor,
    });
    if (!publishGuard.allow) {
      const suppression = buildWorldSuppressionEvent({
        chat: sourceChat,
        actorId: payload.initiatorId,
        actorName,
        reasonType: publishGuard.reasonType,
        reasonLabel: publishGuard.reasonLabel,
        reasonDetail: publishGuard.reasonDetail,
        candidateEventKind: 'post_moment',
        nextSuggestedAt: publishGuard.nextSuggestedAt,
      });
      const decision = buildWorldDecisionEvent({
        chat: sourceChat,
        actorId: payload.initiatorId,
        actorName,
        decisionType: 'suppressed',
        reasonType: publishGuard.reasonType,
        reasonLabel: publishGuard.reasonLabel,
        reasonDetail: publishGuard.reasonDetail,
        fromEventKind: 'post_moment',
        nextSuggestedAt: publishGuard.nextSuggestedAt,
      });
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, withFrameworkPatch(sourceChat, {
        runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [suppression, decision]),
      }), momentCandidate.id, payload.initiatorId));
      return { handledEventId: momentCandidate.id };
    }
    await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, updateSourceChatAfterPostMoment(sourceChat, payload, actorName, { createdAt: momentCandidate.createdAt }), momentCandidate.id, payload.initiatorId));
    return { handledEventId: momentCandidate.id };
  }

  const outingCandidate = findLatestAutoSocialOutingCandidate(sourceChat);
  if (outingCandidate) {
    const payload = outingCandidate.payload as SocialEventCandidatePayload;
    if (!isValidAutoFlowCandidate(sourceChat, payload)) return { handledEventId: null };
    if (hasHandledSocialEvent(sourceChat, outingCandidate.id)) return { handledEventId: outingCandidate.id };
    if (shouldConsumeCandidateWithRestraint(sourceChat, payload, outingCandidate.createdAt)) {
      const actorNames = payload.participantIds.map((id) => ops.characters.find((item) => item.id === id)?.name || id);
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, updateSourceChatAfterSocialOuting(sourceChat, payload, actorNames), outingCandidate.id, payload.initiatorId));
      return { handledEventId: outingCandidate.id };
    }
  }

  const statusCandidate = findLatestAutoStatusUpdateCandidate(sourceChat);
  if (statusCandidate) {
    const payload = statusCandidate.payload as SocialEventCandidatePayload;
    if (!isValidAutoFlowCandidate(sourceChat, payload)) return { handledEventId: null };
    if (hasHandledSocialEvent(sourceChat, statusCandidate.id)) return { handledEventId: statusCandidate.id };
    if (shouldConsumeCandidateWithRestraint(sourceChat, payload, statusCandidate.createdAt)) {
      const actorName = ops.characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, updateSourceChatAfterStatusUpdate(sourceChat, payload, actorName), statusCandidate.id, payload.initiatorId));
      return { handledEventId: statusCandidate.id };
    }
  }

  const checkInCandidate = findLatestAutoCheckInCandidate(sourceChat);
  if (checkInCandidate) {
    const payload = checkInCandidate.payload as SocialEventCandidatePayload;
    if (!isValidAutoFlowCandidate(sourceChat, payload)) return { handledEventId: null };
    if (hasHandledSocialEvent(sourceChat, checkInCandidate.id)) return { handledEventId: checkInCandidate.id };
    if (shouldConsumeCandidateWithRestraint(sourceChat, payload, checkInCandidate.createdAt)) {
      const actorName = ops.characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, updateSourceChatAfterCheckIn(sourceChat, payload, actorName), checkInCandidate.id, payload.initiatorId));
      return { handledEventId: checkInCandidate.id };
    }
  }

  const reactMomentCandidate = findLatestAutoReactToMomentCandidate(sourceChat);
  if (reactMomentCandidate) {
    const payload = reactMomentCandidate.payload as SocialEventCandidatePayload;
    if (!isValidAutoFlowCandidate(sourceChat, payload)) return { handledEventId: null };
    if (hasHandledSocialEvent(sourceChat, reactMomentCandidate.id)) return { handledEventId: reactMomentCandidate.id };
    if (shouldConsumeCandidateWithRestraint(sourceChat, payload, reactMomentCandidate.createdAt)) {
      const actorName = ops.characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, updateSourceChatAfterReactToMoment(sourceChat, payload, actorName), reactMomentCandidate.id, payload.initiatorId));
      return { handledEventId: reactMomentCandidate.id };
    }
  }

  const giftCandidate = findLatestAutoGiftExchangeCandidate(sourceChat);
  if (giftCandidate) {
    const payload = giftCandidate.payload as SocialEventCandidatePayload;
    if (!isValidAutoFlowCandidate(sourceChat, payload)) return { handledEventId: null };
    if (hasHandledSocialEvent(sourceChat, giftCandidate.id)) return { handledEventId: giftCandidate.id };
    const actorName = ops.characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
    await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, updateSourceChatAfterGiftExchange(sourceChat, payload, actorName), giftCandidate.id, payload.initiatorId));
    return { handledEventId: giftCandidate.id };
  }

  const conflictCandidate = findLatestAutoConflictExpressionCandidate(sourceChat);
  if (conflictCandidate) {
    const payload = conflictCandidate.payload as SocialEventCandidatePayload;
    if (!isValidAutoFlowCandidate(sourceChat, payload)) return { handledEventId: null };
    if (hasHandledSocialEvent(sourceChat, conflictCandidate.id)) return { handledEventId: conflictCandidate.id };
    const actorName = ops.characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
    await ops.updateChat(sourceChat.id, appendHandledSocialEvent(sourceChat, updateSourceChatAfterConflictExpression(sourceChat, payload, actorName), conflictCandidate.id, payload.initiatorId));
    return { handledEventId: conflictCandidate.id };
  }

  if (ops.allowWorldFallback === false) return { handledEventId: null };

  const worldDrivenDecision = await evaluateWorldDrivenDecision(
    sourceChat,
    ops.characters,
    ops.messages || [],
    Boolean(ops.imageModelEnabled),
  );
  const worldDrivenCandidate = worldDrivenDecision.candidate;
  if (worldDrivenCandidate) {
    const payload = worldDrivenCandidate.payload as SocialEventCandidatePayload;
    const seededChat = {
      ...sourceChat,
      runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [...worldDrivenDecision.suppressionEvents, ...worldDrivenDecision.decisionEvents, worldDrivenCandidate]),
    } as GroupChat;
    const actorName = ops.characters.find((item) => item.id === payload.initiatorId)?.name || payload.initiatorId;
    if (payload.eventKind === 'post_moment') {
      const actor = ops.characters.find((item) => item.id === payload.initiatorId) || null;
      const publishGuard = resolvePostMomentPublishGuard({
        chat: seededChat,
        payload,
        actor,
      });
      if (!publishGuard.allow) {
        const suppression = buildWorldSuppressionEvent({
          chat: seededChat,
          actorId: payload.initiatorId,
          actorName,
          reasonType: publishGuard.reasonType,
          reasonLabel: publishGuard.reasonLabel,
          reasonDetail: publishGuard.reasonDetail,
          candidateEventKind: 'post_moment',
          nextSuggestedAt: publishGuard.nextSuggestedAt,
        });
        const decision = buildWorldDecisionEvent({
          chat: seededChat,
          actorId: payload.initiatorId,
          actorName,
          decisionType: 'suppressed',
          reasonType: publishGuard.reasonType,
          reasonLabel: publishGuard.reasonLabel,
          reasonDetail: publishGuard.reasonDetail,
          fromEventKind: 'post_moment',
          nextSuggestedAt: publishGuard.nextSuggestedAt,
        });
        const blockedPatch = withFrameworkPatch(seededChat, {
          runtimeEventsV2: appendStructuredRuntimeEvents(seededChat, [suppression, decision]),
        });
        await ops.updateChat(sourceChat.id, appendHandledSocialEvent(seededChat, blockedPatch, worldDrivenCandidate.id, payload.initiatorId));
        return { handledEventId: worldDrivenCandidate.id };
      }
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(seededChat, updateSourceChatAfterPostMoment(seededChat, payload, actorName, { createdAt: worldDrivenCandidate.createdAt }), worldDrivenCandidate.id, payload.initiatorId));
      return { handledEventId: worldDrivenCandidate.id };
    }
    if (payload.eventKind === 'check_in') {
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(seededChat, updateSourceChatAfterCheckIn(seededChat, payload, actorName), worldDrivenCandidate.id, payload.initiatorId));
      return { handledEventId: worldDrivenCandidate.id };
    }
    if (payload.eventKind === 'social_outing') {
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(seededChat, updateSourceChatAfterSocialOuting(seededChat, payload, [actorName]), worldDrivenCandidate.id, payload.initiatorId));
      return { handledEventId: worldDrivenCandidate.id };
    }
    if (payload.eventKind === 'react_to_moment') {
      await ops.updateChat(sourceChat.id, appendHandledSocialEvent(seededChat, updateSourceChatAfterReactToMoment(seededChat, payload, actorName), worldDrivenCandidate.id, payload.initiatorId));
      return { handledEventId: worldDrivenCandidate.id };
    }
    await ops.updateChat(sourceChat.id, appendHandledSocialEvent(seededChat, updateSourceChatAfterStatusUpdate(seededChat, payload, actorName), worldDrivenCandidate.id, payload.initiatorId));
    return { handledEventId: worldDrivenCandidate.id };
  }

  if (worldDrivenDecision.suppressionEvents.length || worldDrivenDecision.decisionEvents.length) {
    await ops.updateChat(sourceChat.id, withFrameworkPatch(sourceChat, {
      runtimeEventsV2: appendStructuredRuntimeEvents(sourceChat, [...worldDrivenDecision.suppressionEvents, ...worldDrivenDecision.decisionEvents]),
    }));
  }

  return { privateChatId: null, handledEventId: null };
}

function resolvePrivateThreadParticipantName(characters: AICharacter[] | undefined, id: string, fallback: string) {
  const name = characters?.find((character) => character.id === id)?.name;
  if (!name) {
    reportUnresolvedDisplayEntity({ id, kind: 'character', location: 'directSessionRuntime.privateThreadParticipant', fallback });
  }
  return name || fallback;
}

export function buildStartPrivateThreadExecutionResult(chat: GroupChat, actorId: string, targetId: string, prompt = '', characters: AICharacter[] = []): SessionActionExecutionResult {
  const actorName = resolvePrivateThreadParticipantName(characters, actorId, '发起者');
  const targetName = resolvePrivateThreadParticipantName(characters, targetId, '对象');
  const summary = `发起AI私聊：${actorName} → ${targetName}${prompt ? ` · ${prompt.slice(0, 32)}` : ''}`;
  return {
    chatPatch: withFrameworkPatch(chat, {
      worldState: {
        ...chat.worldState,
        recentEvent: summary,
      },
    }),
    runtimeEvents: [{
      eventType: 'start_private_thread',
      title: '执行了AI私聊派生动作',
      summary,
      metrics: { actorId, targetId, actorName, targetName, prompt },
    }],
  };
}

function normalizePrivateThreadOpeningMessage(openingMessage: string | null | undefined, targetName: string, triggerReason?: string | null) {
  const trimmed = (openingMessage || '').trim();
  if (trimmed && !/^系统[:：]/.test(trimmed)) return trimmed.slice(0, 1200);
  const reason = (triggerReason || '').trim();
  if (reason) return `${targetName}，刚才那件事我还是想单独和你接着聊一下。${reason.length > 36 ? `我在意的是：${reason.slice(0, 80)}` : reason}`;
  return `${targetName}，刚才在群里我没完全说完，想单独和你接着聊一下。`;
}

export async function createAiPrivateThread(params: {
  sourceChat: GroupChat;
  chats: GroupChat[];
  characters: AICharacter[];
  starterId: string;
  targetId: string;
  triggerReason?: string | null;
  openingMessage?: string | null;
  addChat: (input: Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'>) => Promise<GroupChat>;
  addMessage: (message: SocialRuntimeMessageInput) => Promise<unknown>;
  appendEventMessage: (chatId: string, payload: { eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown; visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public'; visibleToIds?: string[]; visibleToRoles?: string[] }) => Promise<void>;
}) {
  const memberSet = new Set(params.sourceChat.memberIds);
  if (!memberSet.has(params.starterId) || !memberSet.has(params.targetId)) return null;
  const initiator = params.characters.find((item) => item.id === params.starterId);
  const target = params.characters.find((item) => item.id === params.targetId);
  if (!initiator || !target || params.starterId === params.targetId) return null;

  const existing = params.chats.find((item) => item.type === 'ai_direct' && item.sourceChatId === params.sourceChat.id && item.memberIds.includes(params.starterId) && item.memberIds.includes(params.targetId));
  if (existing) return existing;

  const privateChat = await params.addChat(buildAiPrivateChatDraft(params.sourceChat, initiator, target));

  await params.addMessage({
    chatId: privateChat.id,
    type: 'system',
    senderId: 'system',
    senderName: 'System',
    content: `${initiator.name} 和 ${target.name} 从群聊 ${params.sourceChat.name} 派生出一个AI私聊。`,
    emotion: 0,
  });

  const openingMessage = normalizePrivateThreadOpeningMessage(params.openingMessage, target.name, params.triggerReason);
  if (openingMessage) {
    await params.addMessage({
      chatId: privateChat.id,
      type: 'ai',
      senderId: initiator.id,
      senderName: initiator.name,
      content: openingMessage,
      emotion: 0.25,
    });
  }

  await params.appendEventMessage(params.sourceChat.id, {
    eventType: 'private_chat_started',
    title: `${initiator.name} 与 ${target.name} 开启了AI私聊`,
    summary: params.triggerReason || '群聊将跟踪这段私下互动带来的关系变化。',
    pair: [initiator.name, target.name],
    metrics: {
      starterId: initiator.id,
      targetId: target.id,
      triggerReason: params.triggerReason || null,
      openingMessage: openingMessage || null,
    },
    visibilityScope: 'derived_public',
  });

  return privateChat;
}

export function buildAiPrivateChatDraft(sourceChat: GroupChat, starter: AICharacter, target: AICharacter): Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'> {
  const phase: ConversationPhase = 'warming';
  const frameworkPatch = createConversationThreadFrameworkPatch(sourceChat, [starter.id, target.id]);
  return {
    type: 'ai_direct' as const,
    mode: 'open_chat' as const,
    sessionKind: frameworkPatch.sessionKind,
    modeConfig: sourceChat.modeConfig,
    modeState: sourceChat.modeState,
    scenarioPackage: frameworkPatch.scenarioPackage,
    scenarioState: frameworkPatch.scenarioState,
    channels: frameworkPatch.channels,
    layoutState: frameworkPatch.layoutState,
    judgeAgent: frameworkPatch.judgeAgent,
    modeStateSummary: frameworkPatch.modeStateSummary,
    memoryLayerSummary: frameworkPatch.memoryLayerSummary,
    growthSnapshots: frameworkPatch.growthSnapshots,
    roleMemorySummaries: frameworkPatch.roleMemorySummaries,
    scenarioMemorySummary: frameworkPatch.scenarioMemorySummary,
    topologySummary: frameworkPatch.topologySummary,
    name: `${starter.name} × ${target.name}`,
    topic: `${starter.name} 和 ${target.name} 的AI私聊`,
    style: 'free' as const,
    runtimeEvolutionIntensity: sourceChat.runtimeEvolutionIntensity,
    memberIds: [starter.id, target.id],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    showRoleActions: true,
    topicSeed: '',
    sourceChatId: sourceChat.id,
    sourceMemberIds: [starter.id, target.id],
    governance: { ownerCharacterId: starter.id, adminCharacterIds: [], autoModeration: false, allowMute: false, allowPrivateThreads: false },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase, mood: 'private', focus: sourceChat.topic || '', recentEvent: `派生自 ${sourceChat.name}` },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: false, allowForcedReply: true },
  };
}
