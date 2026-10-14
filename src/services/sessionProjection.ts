import type { AICharacter } from '../types/character';
import type { GroupChat, ParticipantInstance, RuntimePanelDefinition, SessionSurfaceProjection } from '../types/chat';
import type { MemoryCandidatePayload, RuntimeEventKind, RuntimeEventV2, SocialEventCandidatePayload, SocialEventEffectPayload, RelationshipAxisReason } from '../types/runtimeEvent';
import type { SessionActionDefinition, SessionActionSchema, SessionEngineDefinition, SessionProjectionContext, SessionViewProjection } from '../types/sessionEngine';
import { buildDefaultSessionSurfaceProjection, resolveSessionDefinitionForConversation } from '../types/chat';
import { buildSessionSurfaceProjectionFromSchema } from '../types/sessionEngine';
import { canProjectScope } from '../types/sessionVisibility';
import { projectSessionRecentEvent } from './directSessionHelpers';
import { buildRolePrivateParticipantStates, buildRolePrivatePayloads, projectPrivateParticipantPayloads } from './privateRuntimePayloads';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';
import { reportUnresolvedDisplayEntity } from './diagnostics';
import { formatRuntimeEventKindLabel } from './runtimeEventPresentation';
import { formatActorRefKindLabel, formatSystemAgentSubtypeLabel, inferSystemAgentSubtypeFromId, toActorRef, type ActorRefKind } from './actorRefPresentation';
import { projectWorldAttentionStates } from './worldRuntimeProjection';
import { canUsePrivateThreads } from './conversationCapabilities';
import { getCurrentRetentionLimits } from './retentionLimits';

export interface ProjectedRuntimeTimelineItem {
  type: 'note' | 'artifact' | 'relationship';
  text: string;
  createdAt: number;
  label: string;
  event?: RuntimeEventV2 | null;
  actorNames?: string[];
  targetNames?: string[];
  meta?: {
    memoryCandidate?: MemoryCandidatePayload;
    socialEventCandidate?: SocialEventCandidatePayload;
    socialEventArtifact?: {
      eventKind?: string;
      artifactType?: string;
      title?: string;
      activityType?: string;
      dedupeKey?: string | null;
      participantIds?: string[];
      targetIds?: string[];
      expectedArtifacts?: string[];
      timeHint?: string | null;
      locationHint?: string | null;
      candidateId?: string;
      reasonType?: string;
    };
    socialEventEffect?: SocialEventEffectPayload;
    socialEventCluster?: {
      eventKind?: string;
      dedupeKey?: string | null;
      candidateId?: string | null;
      stage: 'candidate' | 'artifact' | 'effect' | 'opened';
    };
    relationshipDelta?: {
      reason: string;
      delta: { warmth?: number; competence?: number; trust?: number; threat?: number };
      axisReasons?: Partial<Record<'warmth' | 'competence' | 'trust' | 'threat', RelationshipAxisReason[]>>;
      spikeType?: 'normal' | 'turning_point' | 'rupture' | 'bonding';
    };
    roomShift?: {
      heat?: number;
      cohesion?: number;
      topicDrift?: number;
      delta?: { heat?: number; cohesion?: number; topicDrift?: number };
    };
    memoryDistillation?: Record<string, unknown>;
    projectionInfo?: {
      projectionKind?: string;
      topicSnippet?: string;
      participantNames?: string[];
    };
    guidanceInfo?: {
      kind?: string;
      actorNames?: string[];
      subjectNames?: string[];
      subjectText?: string;
    };
    actorAudit?: {
      actorId?: string | null;
      actorName?: string;
      origin?: string;
      isOperator?: boolean;
    };
    attentionInfo?: {
      scoreLabel: string;
      restraintLabel: string;
      reasons: string[];
      actorKindLabel?: string;
      targetKindLabels?: string[];
      actorSubtypeLabel?: string;
      targetSubtypeLabels?: string[];
    };
    attentionSource?: {
      source?: string;
      mode: 'manual' | 'auto' | 'unknown';
      label: string;
    };
    attentionFollowup?: {
      kind: 'user' | 'member';
      actorId: string;
      actorName: string;
      targetId?: string;
      targetName?: string;
      focus?: string;
      status: 'issued' | 'pending_response' | 'completed';
      issuedAt: number;
      completedAt?: number;
    };
    calendarPatch?: {
      isAuto: boolean;
      calendarItemId?: string;
      basedOnItemId?: string;
      idempotencyKey?: string;
      startAt?: number;
      endAt?: number;
      durationMinutes?: number;
      reason?: string;
      source?: string;
      summary?: string;
      status?: string;
      timeHint?: string;
      locationHint?: string;
      addParticipantIds?: string[];
      removeParticipantIds?: string[];
      addParticipantStates?: Record<string, string>;
    };
    candidateSuppression?: {
      eventType: 'event_candidate_suppressed';
      candidateEventKind?: string;
      reasonType?: string;
      reasonLabel?: string;
      reasonDetail?: string;
      dedupeKey?: string | null;
      confidence?: number;
      suppressedConfidence?: number;
      preferredConfidence?: number;
      preferredCandidateId?: string;
      suppressedCandidateId?: string;
      hitEventId?: string;
      hitWindow?: string;
      nextSuggestedAt?: number;
    };
    worldAttentionDecision?: {
      eventType: 'world_attention_decision';
      decisionType?: 'trigger' | 'suppressed' | 'fallback';
      reasonType?: string;
      reasonLabel?: string;
      reasonDetail?: string;
      fromEventKind?: string;
      toEventKind?: string;
      nextSuggestedAt?: number;
    };
    worldDecisionV2?: {
      eventType: 'world_decision_v2';
      domain?: 'proactive_care' | 'open_chat' | 'calendar_patch_queue';
      selectedId?: string;
      selectedKind?: string;
      selectedReasonType?: string;
      decisionSource?: 'local' | 'model';
      modelReason?: string;
      confidenceDelta?: number;
      candidateCount?: number;
    };
    calendarPatchApplyResult?: {
      eventType: 'calendar_patch_apply_result';
      appliedCount: number;
      skippedCount: number;
      failedCount: number;
      queueCount?: number;
      persistedCount?: number;
      skippedReasonCounts?: Partial<Record<'missing_target_conversation' | 'target_chat_not_found' | 'duplicate_idempotency' | 'chain_group_blocked', number>>;
      modelArbitration?: {
        attempted: boolean;
        applied: boolean;
        selectedIndependentCount: number;
      };
    };
  };
}

export type ProjectedRuntimeMeta = NonNullable<ProjectedRuntimeTimelineItem['meta']>;
export type ProjectedProjectionInfoMeta = NonNullable<ProjectedRuntimeMeta['projectionInfo']>;
export type ProjectedGuidanceInfoMeta = NonNullable<ProjectedRuntimeMeta['guidanceInfo']>;
export type ProjectedAttentionInfoMeta = NonNullable<ProjectedRuntimeMeta['attentionInfo']>;
export type ProjectedMemoryDistillationMeta = NonNullable<ProjectedRuntimeMeta['memoryDistillation']>;
export type ProjectedCalendarPatchMeta = NonNullable<ProjectedRuntimeMeta['calendarPatch']>;

export interface ProjectedRuntimeState {
  worldState: GroupChat['worldState'];
  runtimeTimeline: ProjectedRuntimeTimelineItem[];
  runtimeSeed: { notes: string[]; artifacts: string[] };
  runtimeEventsV2: RuntimeEventV2[];
  relationshipLedger: NonNullable<GroupChat['relationshipLedger']>;
  primaryRecentEvent: string;
  latestEvent: RuntimeEventV2 | null;
  timelineCount: number;
}

export interface ProjectedSessionFrameworkState {
  definition: ReturnType<typeof resolveSessionDefinitionForConversation>;
  surfaces: SessionSurfaceProjection;
  familyLabel: string;
  scenarioLabel: string;
  topologyLabel: string;
}

export interface ProjectedSidebarChat {
  chat: GroupChat & { primaryRecentEvent?: string };
  privatePayloads: Array<{ key: string; title: string; text: string }>;
}

export interface ProjectedChatDetailState {
  memberPanel?: RuntimePanelDefinition;
  runtimePanel?: RuntimePanelDefinition;
  showMemberTab: boolean;
  showRuntimeTab: boolean;
  showActionTab: boolean;
  activeSidebarTab: string;
  sidebarTitle: string;
  memberTabTitle: string;
  runtimeTabTitle: string;
  privatePayloadTitle: string;
  sidebarChat: ProjectedSidebarChat;
  actionPanel: { title: string; actions: SessionActionDefinition[] };
  composerSurfaces: SessionSurfaceProjection['surfaces'];
  compactCharacterMemorySummary?: string;
  speakAsSummary?: string | null;
}

function isSocialEventArtifactPayload(payload: RuntimeEventV2['payload']): payload is { eventKind?: string; artifactType?: string; title?: string; activityType?: string; dedupeKey?: string | null; participantIds?: string[]; targetIds?: string[]; expectedArtifacts?: string[]; timeHint?: string | null; locationHint?: string | null; candidateId?: string; reasonType?: string } {
  return typeof payload === 'object' && payload !== null && ('eventKind' in payload || 'artifactType' in payload);
}

function isMemoryCandidatePayload(payload: RuntimeEventV2['payload']): payload is MemoryCandidatePayload {
  return typeof payload === 'object' && payload !== null && 'kind' in payload && 'text' in payload && 'salience' in payload && 'confidence' in payload;
}

function isRelationshipDeltaPayload(payload: RuntimeEventV2['payload']): payload is { reason: string; delta: { warmth?: number; competence?: number; trust?: number; threat?: number }; axisReasons?: Partial<Record<'warmth' | 'competence' | 'trust' | 'threat', RelationshipAxisReason[]>>; spikeType?: 'normal' | 'turning_point' | 'rupture' | 'bonding' } {
  return typeof payload === 'object' && payload !== null && 'reason' in payload && 'delta' in payload;
}

function isSocialEventCandidatePayload(payload: RuntimeEventV2['payload']): payload is SocialEventCandidatePayload {
  return typeof payload === 'object' && payload !== null && 'eventKind' in payload && 'initiatorId' in payload && 'participantIds' in payload && 'seedIntent' in payload;
}

function isRoomShiftPayload(payload: RuntimeEventV2['payload']): payload is { heat?: number; cohesion?: number; topicDrift?: number; delta?: { heat?: number; cohesion?: number; topicDrift?: number } } {
  return typeof payload === 'object' && payload !== null && ('heat' in payload || 'cohesion' in payload || 'topicDrift' in payload || 'delta' in payload);
}

function isSocialEventEffectPayload(payload: RuntimeEventV2['payload']): payload is SocialEventEffectPayload {
  return typeof payload === 'object' && payload !== null && 'eventKind' in payload && 'effectType' in payload && 'summary' in payload && 'confidence' in payload;
}

function toCalendarPatchMeta(event: RuntimeEventV2) {
  if (event.kind !== 'calendar_item_patch') return undefined;
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
  const readString = (value: unknown) => typeof value === 'string' ? value : '';
  const readNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const readStringArray = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
  const readStringRecord = (value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  const source = readString(payload.source);
  return {
    isAuto: source === 'world_calendar_patch_executor',
    calendarItemId: readString(payload.calendarItemId) || undefined,
    basedOnItemId: readString(payload.basedOnItemId) || undefined,
    idempotencyKey: readString(payload.idempotencyKey) || undefined,
    startAt: readNumber(payload.startAt),
    endAt: readNumber(payload.endAt),
    durationMinutes: readNumber(payload.durationMinutes),
    reason: readString(payload.reason) || undefined,
    source: source || undefined,
    summary: readString(payload.summary) || undefined,
    status: readString(payload.status) || undefined,
    timeHint: readString(payload.timeHint) || undefined,
    locationHint: readString(payload.locationHint) || undefined,
    addParticipantIds: readStringArray(payload.addParticipantIds),
    removeParticipantIds: readStringArray(payload.removeParticipantIds),
    addParticipantStates: readStringRecord(payload.addParticipantStates),
  };
}

function buildSocialEventCluster(event: RuntimeEventV2) {
  if (event.kind === 'event_candidate' && isSocialEventCandidatePayload(event.payload)) return { eventKind: event.payload.eventKind, dedupeKey: event.payload.dedupeKey ?? null, stage: 'candidate' as const };
  if (event.kind === 'artifact' && isSocialEventArtifactPayload(event.payload)) return { eventKind: event.payload.eventKind, dedupeKey: event.payload.dedupeKey ?? null, candidateId: event.payload.candidateId ?? null, stage: event.payload.artifactType === 'private_thread_opened' ? 'opened' as const : 'artifact' as const };
  if (isSocialEventEffectPayload(event.payload)) return { eventKind: event.payload.eventKind, dedupeKey: null, stage: 'effect' as const };
  return undefined;
}

function buildEventMeta(event: RuntimeEventV2) {
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : null) as Record<string, unknown> | null;
  const isMemoryDistillation = event.kind === 'artifact' && payload?.eventType === 'memory_distillation';
  const projectionInfo = payload && (
    typeof payload.projectionKind === 'string'
    || typeof payload.topicSnippet === 'string'
    || typeof payload.summarySnippet === 'string'
    || Array.isArray(payload.participantNames)
  ) ? {
    projectionKind: typeof payload.projectionKind === 'string' ? payload.projectionKind : undefined,
    topicSnippet: typeof payload.topicSnippet === 'string'
      ? payload.topicSnippet
      : (typeof payload.summarySnippet === 'string' ? payload.summarySnippet : undefined),
    participantNames: Array.isArray(payload.participantNames)
      ? payload.participantNames.filter((value): value is string => typeof value === 'string')
      : undefined,
  } : undefined;
  const userGuidance = payload && typeof payload.userGuidance === 'object' && payload.userGuidance ? payload.userGuidance as Record<string, unknown> : null;
  const mediaRequest = userGuidance && typeof userGuidance.mediaRequest === 'object' && userGuidance.mediaRequest ? userGuidance.mediaRequest as Record<string, unknown> : null;
  const guidanceInfo = userGuidance ? {
    kind: typeof userGuidance.kind === 'string' ? userGuidance.kind : undefined,
    actorNames: Array.isArray(userGuidance.actorIds) ? userGuidance.actorIds.filter((value): value is string => typeof value === 'string') : undefined,
    subjectNames: mediaRequest && Array.isArray(mediaRequest.subjectActorIds) ? mediaRequest.subjectActorIds.filter((value): value is string => typeof value === 'string') : undefined,
    subjectText: mediaRequest && typeof mediaRequest.subjectText === 'string' ? mediaRequest.subjectText : undefined,
  } : undefined;
  const rawActorAudit = payload && typeof payload._actorAudit === 'object' && payload._actorAudit ? payload._actorAudit as Record<string, unknown> : null;
  const actorAudit = rawActorAudit ? {
    actorId: typeof rawActorAudit.actorId === 'string' ? rawActorAudit.actorId : null,
    origin: typeof rawActorAudit.origin === 'string' ? rawActorAudit.origin : undefined,
    isOperator: typeof rawActorAudit.isOperator === 'boolean' ? rawActorAudit.isOperator : undefined,
  } : undefined;
  const candidateSuppression = payload && payload.eventType === 'event_candidate_suppressed' ? {
    eventType: 'event_candidate_suppressed' as const,
    candidateEventKind: typeof payload.candidateEventKind === 'string' ? payload.candidateEventKind : undefined,
    reasonType: typeof payload.reasonType === 'string' ? payload.reasonType : undefined,
    reasonLabel: typeof payload.reasonLabel === 'string' ? payload.reasonLabel : undefined,
    reasonDetail: typeof payload.reasonDetail === 'string' ? payload.reasonDetail : undefined,
    dedupeKey: typeof payload.dedupeKey === 'string' ? payload.dedupeKey : null,
    confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
    suppressedConfidence: typeof payload.suppressedConfidence === 'number' ? payload.suppressedConfidence : undefined,
    preferredConfidence: typeof payload.preferredConfidence === 'number' ? payload.preferredConfidence : undefined,
    preferredCandidateId: typeof payload.preferredCandidateId === 'string' ? payload.preferredCandidateId : undefined,
    suppressedCandidateId: typeof payload.suppressedCandidateId === 'string' ? payload.suppressedCandidateId : undefined,
    hitEventId: typeof payload.hitEventId === 'string' ? payload.hitEventId : undefined,
    hitWindow: typeof payload.hitWindow === 'string' ? payload.hitWindow : undefined,
    nextSuggestedAt: typeof payload.nextSuggestedAt === 'number' ? payload.nextSuggestedAt : undefined,
  } : undefined;
  const worldAttentionDecision: NonNullable<NonNullable<ProjectedRuntimeTimelineItem['meta']>['worldAttentionDecision']> | undefined = payload && payload.eventType === 'world_attention_decision' ? {
    eventType: 'world_attention_decision' as const,
    decisionType: payload.decisionType === 'trigger' || payload.decisionType === 'suppressed' || payload.decisionType === 'fallback'
      ? payload.decisionType
      : undefined,
    reasonType: typeof payload.reasonType === 'string' ? payload.reasonType : undefined,
    reasonLabel: typeof payload.reasonLabel === 'string' ? payload.reasonLabel : undefined,
    reasonDetail: typeof payload.reasonDetail === 'string' ? payload.reasonDetail : undefined,
    fromEventKind: typeof payload.fromEventKind === 'string' ? payload.fromEventKind : undefined,
    toEventKind: typeof payload.toEventKind === 'string' ? payload.toEventKind : undefined,
    nextSuggestedAt: typeof payload.nextSuggestedAt === 'number' ? payload.nextSuggestedAt : undefined,
  } : undefined;
  const calendarPatchApplyResult = payload && payload.eventType === 'calendar_patch_apply_result' ? {
    eventType: 'calendar_patch_apply_result' as const,
    appliedCount: typeof payload.appliedCount === 'number' ? payload.appliedCount : 0,
    skippedCount: typeof payload.skippedCount === 'number' ? payload.skippedCount : 0,
    failedCount: typeof payload.failedCount === 'number' ? payload.failedCount : 0,
    queueCount: typeof payload.queueCount === 'number' ? payload.queueCount : undefined,
    persistedCount: typeof payload.persistedCount === 'number' ? payload.persistedCount : undefined,
    skippedReasonCounts: (typeof payload.skippedReasonCounts === 'object' && payload.skippedReasonCounts && !Array.isArray(payload.skippedReasonCounts))
      ? {
        missing_target_conversation: typeof (payload.skippedReasonCounts as Record<string, unknown>).missing_target_conversation === 'number'
          ? (payload.skippedReasonCounts as Record<string, number>).missing_target_conversation
          : undefined,
        target_chat_not_found: typeof (payload.skippedReasonCounts as Record<string, unknown>).target_chat_not_found === 'number'
          ? (payload.skippedReasonCounts as Record<string, number>).target_chat_not_found
          : undefined,
        duplicate_idempotency: typeof (payload.skippedReasonCounts as Record<string, unknown>).duplicate_idempotency === 'number'
          ? (payload.skippedReasonCounts as Record<string, number>).duplicate_idempotency
          : undefined,
        chain_group_blocked: typeof (payload.skippedReasonCounts as Record<string, unknown>).chain_group_blocked === 'number'
          ? (payload.skippedReasonCounts as Record<string, number>).chain_group_blocked
          : undefined,
      }
      : undefined,
    modelArbitration: (typeof payload.modelArbitration === 'object' && payload.modelArbitration && !Array.isArray(payload.modelArbitration))
      ? {
        attempted: Boolean((payload.modelArbitration as Record<string, unknown>).attempted),
        applied: Boolean((payload.modelArbitration as Record<string, unknown>).applied),
        selectedIndependentCount: typeof (payload.modelArbitration as Record<string, unknown>).selectedIndependentCount === 'number'
          ? (payload.modelArbitration as Record<string, number>).selectedIndependentCount
          : 0,
      }
      : undefined,
  } : undefined;
  const worldDecisionV2: NonNullable<NonNullable<ProjectedRuntimeTimelineItem['meta']>['worldDecisionV2']> | undefined = payload && payload.eventType === 'world_decision_v2' ? {
    eventType: 'world_decision_v2' as const,
    domain: payload.domain === 'proactive_care' || payload.domain === 'open_chat' || payload.domain === 'calendar_patch_queue'
      ? payload.domain
      : undefined,
    selectedId: typeof payload.selectedId === 'string' ? payload.selectedId : undefined,
    selectedKind: typeof payload.selectedKind === 'string' ? payload.selectedKind : undefined,
    selectedReasonType: typeof payload.selectedReasonType === 'string' ? payload.selectedReasonType : undefined,
    decisionSource: payload.decisionSource === 'local' || payload.decisionSource === 'model'
      ? payload.decisionSource
      : undefined,
    modelReason: typeof payload.modelReason === 'string' ? payload.modelReason : undefined,
    confidenceDelta: typeof payload.confidenceDelta === 'number' ? payload.confidenceDelta : undefined,
    candidateCount: typeof payload.candidateCount === 'number' ? payload.candidateCount : undefined,
  } : undefined;
  return {
    memoryCandidate: event.kind === 'memory_candidate' && isMemoryCandidatePayload(event.payload) ? event.payload : undefined,
    socialEventCandidate: event.kind === 'event_candidate' && isSocialEventCandidatePayload(event.payload) ? event.payload : undefined,
    socialEventArtifact: event.kind === 'artifact' && isSocialEventArtifactPayload(event.payload) ? event.payload : undefined,
    socialEventEffect: isSocialEventEffectPayload(event.payload) ? event.payload : undefined,
    socialEventCluster: buildSocialEventCluster(event),
    relationshipDelta: event.kind === 'relationship_delta' && isRelationshipDeltaPayload(event.payload) ? event.payload : undefined,
    roomShift: event.kind === 'room_shift' && isRoomShiftPayload(event.payload) ? event.payload : undefined,
    memoryDistillation: isMemoryDistillation ? payload : undefined,
    projectionInfo,
    guidanceInfo,
    actorAudit,
    calendarPatch: toCalendarPatchMeta(event),
    candidateSuppression,
    worldAttentionDecision,
    worldDecisionV2,
    calendarPatchApplyResult,
  };
}

function projectActorAuditMeta(
  meta: NonNullable<ReturnType<typeof buildEventMeta>['actorAudit']>,
  participantNameMap: Map<string, string>,
) {
  if (!meta.actorId) return meta;
  return {
    ...meta,
    actorName: participantNameMap.get(meta.actorId) || meta.actorId,
  };
}

function projectAttentionFollowupMeta(
  event: RuntimeEventV2,
  events: RuntimeEventV2[],
  eventIndex: number,
  participantNameMap: Map<string, string>,
) {
  const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload as Record<string, unknown> : null;
  if (!payload) return undefined;
  const eventType = typeof payload.eventType === 'string' ? payload.eventType : '';
  if (eventType !== 'attention_followup_user' && eventType !== 'attention_followup_member') return undefined;
  const actorId = typeof payload.actorId === 'string' ? payload.actorId : '';
  if (!actorId) return undefined;
  const targetId = eventType === 'attention_followup_member' && typeof payload.targetId === 'string' ? payload.targetId : undefined;
  const actorName = participantNameMap.get(actorId) || actorId;
  const targetName = targetId ? (participantNameMap.get(targetId) || targetId) : undefined;
  const focus = typeof payload.focus === 'string' && payload.focus.trim() ? cleanProjectionText(payload.focus, participantNameMap) : undefined;
  const issuedAt = event.createdAt;
  const actorMessages = events
    .slice(eventIndex + 1)
    .filter((candidate) => candidate.kind === 'message_generated' && candidate.actorIds?.[0] === actorId);
  if (!actorMessages.length) {
    return {
      kind: eventType === 'attention_followup_member' ? 'member' as const : 'user' as const,
      actorId,
      actorName,
      targetId,
      targetName,
      focus,
      status: 'issued' as const,
      issuedAt,
    };
  }
  // This projection records a subsequent response, not semantic fulfillment of the focus.
  const completionEvent = actorMessages.find((candidate) => {
    const candidatePayload = typeof candidate.payload === 'object' && candidate.payload !== null ? candidate.payload as Record<string, unknown> : null;
    const text = cleanProjectionText(
      typeof candidatePayload?.text === 'string' ? candidatePayload.text : (candidate.summary || ''),
      participantNameMap,
    );
    return Boolean(text.trim());
  });
  if (!completionEvent) {
    return {
      kind: eventType === 'attention_followup_member' ? 'member' as const : 'user' as const,
      actorId,
      actorName,
      targetId,
      targetName,
      focus,
      status: 'pending_response' as const,
      issuedAt,
    };
  }
  return {
    kind: eventType === 'attention_followup_member' ? 'member' as const : 'user' as const,
    actorId,
    actorName,
    targetId,
    targetName,
    focus,
    status: 'completed' as const,
    issuedAt,
    completedAt: completionEvent.createdAt,
  };
}

function mapRuntimeEventKindToTimelineType(kind: RuntimeEventKind): 'note' | 'artifact' | 'relationship' {
  if (kind === 'interaction' || kind === 'relationship_delta') return 'relationship';
  if (kind === 'artifact') return 'artifact';
  return 'note';
}

function formatRuntimeEventLabel(kind: RuntimeEventKind) {
  return formatRuntimeEventKindLabel(kind, 'zh');
}

function formatMemoryCandidateKind(kind: MemoryCandidatePayload['kind']) {
  const labels: Record<MemoryCandidatePayload['kind'], string> = { fact: '事实', topic: '话题', preference: '偏好', secret: '秘密', relationship: '关系' };
  return labels[kind] || kind;
}

function formatRelationshipReason(reason: string) {
  const labels: Record<string, string> = { support: '支持', defend: '维护', challenge: '挑战', mock: '嘲讽', dismiss: '轻视', pile_on: '围攻', probe: '追问' };
  return labels[reason] || reason;
}

function buildParticipantNameMap(participants: Array<AICharacter | ParticipantInstance>) {
  const entries = participants.flatMap((participant) => {
    if ('participantId' in participant) {
      const fallback = participant.displayName || (participant.entityRefId === 'user' ? '我' : participant.entityRefId) || '成员';
      if (!participant.displayName && !participant.entityRefId) {
        reportUnresolvedDisplayEntity({
          id: participant.participantId,
          kind: 'participant',
          location: 'sessionProjection.buildParticipantNameMap',
          fallback,
          extra: { entityRefId: participant.entityRefId },
        });
      }
      return [
        [participant.participantId, fallback] as const,
        participant.entityRefId ? [participant.entityRefId, fallback] as const : null,
      ].filter(Boolean) as Array<readonly [string, string]>;
    }
    return [[participant.id, participant.name] as const];
  });
  return new Map(entries);
}

function buildParticipantKindMap(participants: Array<AICharacter | ParticipantInstance>) {
  const map = new Map<string, ActorRefKind>();
  participants.forEach((participant) => {
    if ('participantId' in participant) {
      const flagKind = typeof participant.flags?.actorRefKind === 'string' ? participant.flags.actorRefKind : '';
      const kind: ActorRefKind = flagKind === 'user_persona' || flagKind === 'system_agent' || flagKind === 'ai_character'
        ? flagKind
        : participant.entityType === 'user'
          ? 'user_persona'
          : participant.entityType === 'system_agent'
            ? 'system_agent'
            : 'ai_character';
      if (participant.participantId) map.set(participant.participantId, kind);
      if (participant.entityRefId) map.set(participant.entityRefId, kind);
      return;
    }
    map.set(participant.id, 'ai_character');
  });
  return map;
}

function resolveActorTargetNames(
  ids: string[] | undefined,
  participantNameMap: Map<string, string>,
  participantKindMap: Map<string, ActorRefKind>,
) {
  return (ids || []).map((id) => {
    if (id === 'user') return '我';
    const name = participantNameMap.get(id);
    if (name) return name;
    const actorRef = toActorRef(id, { actorKinds: participantKindMap });
    if (actorRef?.kind === 'system_agent') {
      if (actorRef.subtype) return formatSystemAgentSubtypeLabel(actorRef.subtype);
      return formatActorRefKindLabel(actorRef.kind);
    }
    reportUnresolvedDisplayEntity({ id, kind: 'member', location: 'sessionProjection.resolveActorTargetNames', fallback: '成员' });
    return '成员';
  });
}

function displayMembersFromNameMap(participantNameMap: Map<string, string>): DisplayTextMember[] {
  return Array.from(participantNameMap.entries()).map(([id, name]) => ({ id, name }));
}

function cleanProjectionText(text: string | undefined | null, participantNameMap: Map<string, string>) {
  const sanitized = sanitizeUserFacingText(
    text || '',
    displayMembersFromNameMap(participantNameMap),
  );
  return sanitized.replace(/\buser\b/g, '我');
}

function cleanOptionalProjectionText<T extends string | null | undefined>(text: T, participantNameMap: Map<string, string>): T {
  if (typeof text !== 'string') return text;
  return cleanProjectionText(text, participantNameMap) as T;
}

function projectSocialEventCandidatePayload(payload: SocialEventCandidatePayload, participantNameMap: Map<string, string>): SocialEventCandidatePayload {
  return {
    ...payload,
    seedIntent: cleanProjectionText(payload.seedIntent, participantNameMap),
    sourceText: cleanOptionalProjectionText(payload.sourceText, participantNameMap),
    title: cleanOptionalProjectionText(payload.title, participantNameMap),
    activityType: cleanOptionalProjectionText(payload.activityType, participantNameMap),
    timeHint: cleanOptionalProjectionText(payload.timeHint, participantNameMap),
    locationHint: cleanOptionalProjectionText(payload.locationHint, participantNameMap),
    attentionTrace: payload.attentionTrace
      ? {
        ...payload.attentionTrace,
        reasons: (payload.attentionTrace.reasons || []).map((reason) => cleanProjectionText(reason, participantNameMap)),
      }
      : undefined,
  };
}

function projectSocialEventArtifactPayload(payload: NonNullable<ReturnType<typeof buildEventMeta>['socialEventArtifact']>, participantNameMap: Map<string, string>) {
  return {
    ...payload,
    title: cleanOptionalProjectionText(payload.title, participantNameMap),
    activityType: cleanOptionalProjectionText(payload.activityType, participantNameMap),
    timeHint: cleanOptionalProjectionText(payload.timeHint, participantNameMap),
    locationHint: cleanOptionalProjectionText(payload.locationHint, participantNameMap),
  };
}

function projectMemoryDistillationPayload(payload: Record<string, unknown>, participantNameMap: Map<string, string>) {
  const candidateTexts = Array.isArray(payload.candidateTexts)
    ? payload.candidateTexts.map((item) => typeof item === 'string' ? cleanProjectionText(item, participantNameMap) : item)
    : payload.candidateTexts;
  return {
    ...payload,
    candidateTexts,
  };
}

function projectProjectionInfoMeta(meta: NonNullable<ReturnType<typeof buildEventMeta>['projectionInfo']>, participantNameMap: Map<string, string>) {
  return {
    projectionKind: meta.projectionKind,
    topicSnippet: cleanOptionalProjectionText(meta.topicSnippet, participantNameMap),
    participantNames: (meta.participantNames || []).map((name) => cleanProjectionText(name, participantNameMap)),
  };
}

function projectGuidanceInfoMeta(meta: NonNullable<ReturnType<typeof buildEventMeta>['guidanceInfo']>, participantNameMap: Map<string, string>) {
  return {
    kind: meta.kind,
    actorNames: (meta.actorNames || []).map((id) => participantNameMap.get(id) || id),
    subjectNames: (meta.subjectNames || []).map((id) => participantNameMap.get(id) || id),
    subjectText: cleanOptionalProjectionText(meta.subjectText, participantNameMap),
  };
}

function projectAttentionInfoMeta(
  candidate: SocialEventCandidatePayload | undefined,
  participantNameMap: Map<string, string>,
  participantKindMap: Map<string, ActorRefKind>,
) {
  const trace = candidate?.attentionTrace;
  if (!trace) return undefined;
  const scoreLabel = Number.isFinite(trace.score) ? `${Math.round(trace.score * 100)}%` : '-';
  const restraintLabel = Number.isFinite(trace.restraint) ? `${Math.round(trace.restraint * 100)}%` : '-';
  const reasons = (trace.reasons || []).map((reason) => cleanProjectionText(reason, participantNameMap));
  const actorRef = candidate?.initiatorId
    ? toActorRef(candidate.initiatorId, { actorKinds: participantKindMap })
    : undefined;
  const targetRefs = (candidate?.targetIds || []).map((id) => toActorRef(id, { actorKinds: participantKindMap }))
    .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));
  return {
    scoreLabel,
    restraintLabel,
    reasons,
    actorKindLabel: actorRef ? formatActorRefKindLabel(actorRef.kind) : undefined,
    targetKindLabels: targetRefs.length ? targetRefs.map((ref) => formatActorRefKindLabel(ref.kind)) : undefined,
    actorSubtypeLabel: actorRef?.kind === 'system_agent' && actorRef.subtype ? formatSystemAgentSubtypeLabel(actorRef.subtype) : undefined,
    targetSubtypeLabels: targetRefs.length
      ? targetRefs.map((ref) => ref.kind === 'system_agent' && ref.subtype ? formatSystemAgentSubtypeLabel(ref.subtype) : '').filter(Boolean)
      : undefined,
  };
}

function projectAttentionSourceMeta(event: RuntimeEventV2, candidate: SocialEventCandidatePayload | undefined) {
  const readMode = (source: string | undefined): 'manual' | 'auto' | 'unknown' => {
    if (!source) return 'unknown';
    if (source.startsWith('manual_')) return 'manual';
    if (source.startsWith('world_') || source.startsWith('attention_') || source.startsWith('ai_response_') || source.startsWith('user_')) return 'auto';
    return 'unknown';
  };
  const source = (() => {
    if (event.kind === 'attention_candidate') {
      const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
      return typeof payload.source === 'string' ? payload.source : undefined;
    }
    return candidate?.reasonType;
  })();
  const mode = readMode(source);
  const label = mode === 'manual'
    ? '手动跟进'
    : mode === 'auto'
      ? '自动推导'
      : '未知来源';
  return { source, mode, label };
}

function projectRuntimeTimelineItems(events: RuntimeEventV2[], legacyTimeline: NonNullable<GroupChat['runtimeTimeline']>, participants: Array<AICharacter | ParticipantInstance> = []) {
  const participantNameMap = buildParticipantNameMap(participants);
  const participantKindMap = buildParticipantKindMap(participants);
  if (events.length) {
    return events.map<ProjectedRuntimeTimelineItem>((event, index) => ({
      type: mapRuntimeEventKindToTimelineType(event.kind),
      text: cleanProjectionText(event.summary, participantNameMap),
      createdAt: event.createdAt,
      label: formatRuntimeEventLabel(event.kind),
      event,
      actorNames: resolveActorTargetNames(event.actorIds, participantNameMap, participantKindMap),
      targetNames: resolveActorTargetNames(event.targetIds, participantNameMap, participantKindMap),
      meta: (() => {
        const baseMeta = buildEventMeta(event);
        return {
          memoryCandidate: baseMeta.memoryCandidate ? { ...baseMeta.memoryCandidate, kind: formatMemoryCandidateKind(baseMeta.memoryCandidate.kind) as MemoryCandidatePayload['kind'], text: cleanProjectionText(baseMeta.memoryCandidate.text, participantNameMap) } : undefined,
          socialEventCandidate: baseMeta.socialEventCandidate ? projectSocialEventCandidatePayload(baseMeta.socialEventCandidate, participantNameMap) : undefined,
          socialEventArtifact: baseMeta.socialEventArtifact ? projectSocialEventArtifactPayload(baseMeta.socialEventArtifact, participantNameMap) : undefined,
          socialEventEffect: baseMeta.socialEventEffect ? { ...baseMeta.socialEventEffect, summary: cleanProjectionText(baseMeta.socialEventEffect.summary, participantNameMap) } : undefined,
          socialEventCluster: baseMeta.socialEventCluster,
          relationshipDelta: baseMeta.relationshipDelta ? {
            reason: cleanProjectionText(formatRelationshipReason(baseMeta.relationshipDelta.reason), participantNameMap),
            delta: baseMeta.relationshipDelta.delta || {},
            axisReasons: baseMeta.relationshipDelta.axisReasons || {},
            spikeType: baseMeta.relationshipDelta.spikeType,
          } : undefined,
          roomShift: baseMeta.roomShift,
          memoryDistillation: baseMeta.memoryDistillation ? projectMemoryDistillationPayload(baseMeta.memoryDistillation, participantNameMap) : undefined,
          projectionInfo: baseMeta.projectionInfo ? projectProjectionInfoMeta(baseMeta.projectionInfo, participantNameMap) : undefined,
          guidanceInfo: baseMeta.guidanceInfo ? projectGuidanceInfoMeta(baseMeta.guidanceInfo, participantNameMap) : undefined,
          actorAudit: baseMeta.actorAudit ? projectActorAuditMeta(baseMeta.actorAudit, participantNameMap) : undefined,
          attentionInfo: projectAttentionInfoMeta(baseMeta.socialEventCandidate, participantNameMap, participantKindMap),
          attentionSource: projectAttentionSourceMeta(event, baseMeta.socialEventCandidate),
          attentionFollowup: projectAttentionFollowupMeta(event, events, index, participantNameMap),
          calendarPatch: baseMeta.calendarPatch,
          candidateSuppression: baseMeta.candidateSuppression,
          worldAttentionDecision: baseMeta.worldAttentionDecision,
          worldDecisionV2: baseMeta.worldDecisionV2,
          calendarPatchApplyResult: baseMeta.calendarPatchApplyResult,
        };
      })(),
    }));
  }

  return legacyTimeline.map<ProjectedRuntimeTimelineItem>((item) => ({ type: item.type, text: cleanProjectionText(item.text, participantNameMap), createdAt: item.createdAt, label: item.type, event: null, actorNames: [], targetNames: [] }));
}

function buildInteractionPairKey(item: ProjectedRuntimeTimelineItem) {
  const actor = item.event?.actorIds?.[0] || item.actorNames?.[0] || '';
  const target = item.event?.targetIds?.[0] || item.targetNames?.[0] || '';
  return `${actor}->${target}`;
}

function isSameInteractionWindow(left: ProjectedRuntimeTimelineItem, right: ProjectedRuntimeTimelineItem) {
  return (
    buildInteractionPairKey(left) === buildInteractionPairKey(right)
    && Math.abs((left.createdAt || 0) - (right.createdAt || 0)) < 5000
  );
}

function isDuplicateRelationshipDelta(item: ProjectedRuntimeTimelineItem, selected: ProjectedRuntimeTimelineItem[], candidates: ProjectedRuntimeTimelineItem[]) {
  const key = buildInteractionPairKey(item);
  return selected.some((candidate) => candidate.event?.kind === 'interaction' && isSameInteractionWindow(candidate, item))
    || candidates.some((candidate) => candidate.event?.kind === 'interaction' && buildInteractionPairKey(candidate) === key && isSameInteractionWindow(candidate, item));
}

export function projectRecentInteractionItems(
  chat: GroupChat,
  participants: Array<AICharacter | ParticipantInstance> = [],
  limit = 2,
) {
  const selected: ProjectedRuntimeTimelineItem[] = [];
  const candidates = projectRuntimeTimeline(chat, participants)
    .filter((item) => item.event?.kind === 'interaction' || item.event?.kind === 'relationship_delta')
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  for (const item of candidates) {
    if (item.event?.kind === 'relationship_delta' && isDuplicateRelationshipDelta(item, selected, candidates)) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }

  return selected;
}

function latestStructuredEvent(events: RuntimeEventV2[]) {
  return events.length ? events[events.length - 1] : null;
}

function summarizePrimaryRecentEvent(chat: GroupChat) {
  const room = chat.worldState.structuredRoomState;
  return room ? `热度 ${room.heat} / 凝聚 ${room.cohesion}` : chat.worldState.recentEvent;
}

function countProjectedTimeline(chat: GroupChat) {
  return chat.runtimeEventsV2?.length || chat.runtimeTimeline?.length || 0;
}

export function projectRuntimeTimeline(chat: GroupChat, participants: Array<AICharacter | ParticipantInstance> = []) {
  return projectRuntimeTimelineItems(chat.runtimeEventsV2 || [], chat.runtimeTimeline || [], participants);
}

export function readProjectedRuntimeMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta || null;
}

export function readProjectionInfoMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.projectionInfo || null;
}

export function readGuidanceInfoMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.guidanceInfo || null;
}

export function readActorAuditMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.actorAudit || null;
}

export function readAttentionInfoMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.attentionInfo || null;
}

export function readAttentionSourceMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.attentionSource || null;
}

export function readAttentionFollowupMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.attentionFollowup || null;
}

export function readMemoryDistillationMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.memoryDistillation || null;
}

export function readCalendarPatchMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.calendarPatch || null;
}

export function readSocialEventCandidateMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.socialEventCandidate || null;
}

export function readSocialEventArtifactMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.socialEventArtifact || null;
}

export function readSocialEventEffectMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.socialEventEffect || null;
}

export function readSocialEventClusterMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.socialEventCluster || null;
}

export function readRelationshipDeltaMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.relationshipDelta || null;
}

export function readRoomShiftMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.roomShift || null;
}

export function readMemoryCandidateMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.memoryCandidate || null;
}

export function readCandidateSuppressionMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.candidateSuppression || null;
}

export function readWorldAttentionDecisionMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.worldAttentionDecision || null;
}

export function readWorldDecisionV2Meta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.worldDecisionV2 || null;
}

export function readUnifiedWorldDecisionMeta(item: ProjectedRuntimeTimelineItem) {
  const v2 = readWorldDecisionV2Meta(item);
  if (v2) {
    return {
      version: 'v2' as const,
      eventType: 'world_decision_v2' as const,
      domain: v2.domain,
      decisionSource: v2.decisionSource,
      selectedKind: v2.selectedKind,
      selectedReasonType: v2.selectedReasonType,
      candidateCount: v2.candidateCount,
      confidenceDelta: v2.confidenceDelta,
      reason: v2.modelReason || v2.selectedReasonType,
    };
  }
  const legacy = readWorldAttentionDecisionMeta(item);
  if (!legacy) return null;
  return {
    version: 'legacy' as const,
    eventType: 'world_attention_decision' as const,
    domain: 'proactive_care' as const,
    decisionSource: undefined,
    selectedKind: legacy.toEventKind,
    selectedReasonType: legacy.reasonType,
    candidateCount: undefined,
    confidenceDelta: undefined,
    reason: legacy.reasonDetail || legacy.reasonLabel,
  };
}

export function readCalendarPatchApplyResultMeta(item: ProjectedRuntimeTimelineItem) {
  return item.meta?.calendarPatchApplyResult || null;
}

export function projectPrimaryRecentEvent(chat: GroupChat) {
  return summarizePrimaryRecentEvent(chat);
}

export function projectLatestRuntimeEvent(chat: GroupChat) {
  return latestStructuredEvent(chat.runtimeEventsV2 || []);
}

export function projectTimelineCount(chat: GroupChat) {
  return countProjectedTimeline(chat);
}

export function projectSessionFrameworkState(chat: GroupChat, actionSchema: SessionActionSchema | null = null): ProjectedSessionFrameworkState {
  const definition = resolveSessionDefinitionForConversation(chat);
  return {
    definition,
    surfaces: actionSchema?.actions.length ? buildSessionSurfaceProjectionFromSchema(chat, actionSchema) : buildDefaultSessionSurfaceProjection(chat),
    familyLabel: definition.kind.family,
    scenarioLabel: definition.scenario.label,
    topologyLabel: definition.kind.topology,
  };
}

function buildProjectedParticipants(chat: GroupChat, context: SessionProjectionContext) {
  return buildRolePrivateParticipantStates(chat, context.participants);
}

function buildPrivatePanelPayloads(chat: GroupChat, context: SessionProjectionContext) {
  const scopedPayloads = buildRolePrivatePayloads(chat)
    .filter((payload) => canProjectScope({ scope: payload.visibilityScope, visibleToIds: payload.visibleToIds, visibleToRoles: payload.visibleToRoles }, { viewerId: context.viewerId, viewerRole: context.viewerRole }))
    .map((payload) => ({ key: payload.key, title: payload.title, text: payload.text }));
  const participantPayloads = projectPrivateParticipantPayloads(buildProjectedParticipants(chat, context), context.viewerRole);
  return [...scopedPayloads, ...participantPayloads];
}

export function projectPrivatePayloads(chat: GroupChat, context: SessionProjectionContext) {
  return buildPrivatePanelPayloads(chat, context);
}

function buildVisiblePanels(engine: SessionEngineDefinition, context: SessionProjectionContext) {
  const privatePayloads = buildPrivatePanelPayloads(context.conversation, context);
  const visiblePanels = engine.getVisiblePanels(context).filter((panel) => panel.type !== 'custom' || context.viewerRole !== 'viewer');
  const privateTitle = context.conversation.type === 'direct' ? '单聊信息' : '私有信息';
  return privatePayloads.length ? [...visiblePanels, { key: 'private_payloads', title: privateTitle, type: 'custom' as const }] : visiblePanels;
}

function filterVisibleRuntimeEvents(events: RuntimeEventV2[], context: SessionProjectionContext) {
  return events.filter((event) => canProjectScope({ scope: event.visibility || 'public', visibleToIds: event.visibleToIds, visibleToRoles: event.visibleToRoles }, { viewerId: context.viewerId, viewerRole: context.viewerRole }));
}

function buildProjectedRuntimeState(chat: GroupChat, context: SessionProjectionContext): ProjectedRuntimeState {
  const canSeePrivate = chat.type === 'group' || context.viewerRole === 'pair_private' || context.viewerRole === 'user_private' || !context.viewerRole;
  const runtimeEventsV2 = filterVisibleRuntimeEvents(chat.runtimeEventsV2 || [], context);
  const runtimeTimeline = projectRuntimeTimelineItems(runtimeEventsV2, chat.runtimeTimeline || [], context.participants);
  return {
    worldState: { ...chat.worldState, recentEvent: projectSessionRecentEvent(chat, context.viewerRole) },
    runtimeTimeline,
    runtimeSeed: { notes: canSeePrivate ? (chat.runtimeSeed?.notes || []) : [], artifacts: canSeePrivate ? (chat.runtimeSeed?.artifacts || []) : [] },
    runtimeEventsV2,
    relationshipLedger: canSeePrivate ? [...(chat.relationshipLedger || [])] : [],
    primaryRecentEvent: projectPrimaryRecentEvent(chat),
    latestEvent: runtimeEventsV2.length ? runtimeEventsV2[runtimeEventsV2.length - 1] : null,
    timelineCount: runtimeTimeline.length,
  };
}

export function projectRuntimeState(chat: GroupChat, context: SessionProjectionContext) {
  return buildProjectedRuntimeState(chat, context);
}

export function projectSessionView(engine: SessionEngineDefinition, context: SessionProjectionContext): SessionViewProjection {
  const visiblePanels = buildVisiblePanels(engine, context);
  const actionSchema = projectActionSchema(engine, context);
  const availableActions = actionSchema ? actionSchema.actions.map((action) => ({ type: action.type })) : engine.getAvailableActions(context);
  return { visiblePanels, availableActions };
}

function filterActionsByVisibility(actions: SessionActionDefinition[], context: SessionProjectionContext) {
  return actions.filter((action) => {
    const visibility = action.visibility || (context.conversationType === 'ai_direct' ? 'pair_private' : context.conversationType === 'direct' ? 'pair_private' : 'public');
    return canProjectScope({ scope: visibility, visibleToIds: action.targetIds, visibleToRoles: visibility === 'moderator_only' ? ['moderator', 'interviewer'] : visibility === 'pair_private' ? ['pair_private', 'user_private', 'participant'] : undefined }, { viewerId: context.viewerId, viewerRole: context.viewerRole });
  });
}

function resolveProjectionNow(now?: number) {
  return typeof now === 'number' && Number.isFinite(now) ? Math.round(now) : Date.now();
}

export function projectActionSchema(engine: SessionEngineDefinition, context: SessionProjectionContext) {
  const schema = engine.getActionSchema?.({ conversation: context.conversation, participants: context.participants }) || null;
  if (!schema) return null;
  return { ...schema, actions: filterActionsByVisibility(schema.actions, context) };
}

export function createViewerRoleForConversation(conversation: GroupChat, viewerId?: string | null) {
  if (!viewerId) return null;
  const definition = resolveSessionDefinitionForConversation(conversation);
  if (definition.kind.family === 'interview' && conversation.memberIds[0] === viewerId) return 'interviewer';
  if (definition.kind.scenarioId === 'werewolf-classic' || definition.kind.family === 'deduction') {
    const seatIndex = conversation.memberIds.indexOf(viewerId);
    if (seatIndex === 0 && conversation.memberIds.length >= 4) return 'seer';
    if (seatIndex >= 0 && seatIndex >= conversation.memberIds.length - Math.max(1, Math.floor(conversation.memberIds.length / 4))) return 'werewolf';
    if (seatIndex >= 0) return 'villager';
  }
  if (conversation.type === 'direct') return 'user_private';
  if (conversation.type === 'ai_direct') return 'pair_private';
  if (conversation.memberIds.includes(viewerId)) return 'participant';
  if ((conversation.operatorIds || []).includes(viewerId)) {
    const subtype = inferSystemAgentSubtypeFromId(viewerId);
    if (subtype === 'host' || subtype === 'moderator' || subtype === 'director') return 'moderator';
    if (subtype === 'game_master') return 'moderator';
    if (subtype === 'topic_guide') return 'moderator';
  }
  return 'viewer';
}

export function createProjectionContext(conversation: GroupChat, participants: SessionProjectionContext['participants'], viewerId?: string | null, viewerRole?: string | null): SessionProjectionContext {
  return { conversation, participants, viewerId, viewerRole: viewerRole || createViewerRoleForConversation(conversation, viewerId), conversationType: conversation.type };
}

export function buildProjectedSidebarChat(chat: GroupChat, runtimeState: ProjectedRuntimeState | null, privatePayloads: Array<{ key: string; title: string; text: string }>): ProjectedSidebarChat {
  return {
    chat: {
      ...chat,
      worldState: runtimeState?.worldState || chat.worldState,
      runtimeTimeline: runtimeState?.runtimeTimeline || chat.runtimeTimeline,
      runtimeSeed: runtimeState?.runtimeSeed || chat.runtimeSeed,
      runtimeEventsV2: runtimeState?.runtimeEventsV2 || chat.runtimeEventsV2,
      relationshipLedger: runtimeState?.relationshipLedger?.length ? runtimeState.relationshipLedger : (chat.relationshipLedger || []),
      primaryRecentEvent: runtimeState?.primaryRecentEvent,
    },
    privatePayloads,
  };
}

export function buildProjectedActionPanel(actions: SessionActionDefinition[], title: string) {
  return { title, actions };
}

function buildAttentionFollowupActions(chat: GroupChat, members: AICharacter[], now?: number): SessionActionDefinition[] {
  const effectiveNow = resolveProjectionNow(now);
  if (chat.type !== 'group') return [];
  const memberSet = new Set(chat.memberIds);
  const aiMemberSet = new Set(members.map((member) => member.id).filter((id) => memberSet.has(id)));
  const hasUserMember = memberSet.has('user');
  const labelMap: Record<string, string> = {
    private_message: '私聊问候',
    ask_followup: '追问跟进',
    check_in: '近况问候',
    react_to_moment: '动态回应',
    invite_activity: '活动邀约',
    calendar_reminder: '日程提醒',
    comfort: '安慰陪伴',
    share_moment: '分享动态',
  };
  const displayMembers: DisplayTextMember[] = [
    { id: 'user', name: '我' },
    ...members.map((member) => ({ id: member.id, name: member.name })),
  ];
  const cleanActionText = (text: string) => sanitizeUserFacingText(text, displayMembers);
  const rankedStates = projectWorldAttentionStates([chat], members, { now: effectiveNow })
    .filter((state) => state.attentionScore > state.restraint)
    .sort((left, right) => (right.attentionScore - right.restraint) - (left.attentionScore - left.restraint));

  const userFollowups = hasUserMember
    ? rankedStates
      .filter((state) => state.targetId === 'user' && aiMemberSet.has(state.actorId))
      .slice(0, 3)
      .map((state) => ({
        type: 'attention_followup_user',
        actorId: state.actorId,
        label: `${state.actorName} 跟进用户`,
        description: cleanActionText(`关注${Math.round(state.attentionScore * 100)}% / 克制${Math.round(state.restraint * 100)}%，优先动作：${state.suggestedActions.slice(0, 3).map((item) => labelMap[item] || item).join('、')}。${state.reasons[0] ? ` 触发原因：${state.reasons[0]}` : ''}`),
        visibility: 'moderator_only' as const,
        fields: [
          {
            key: 'focus',
            label: '跟进内容',
            type: 'text' as const,
            required: false,
            placeholder: '例如：先回应用户刚才的问题，再追问细节',
          },
        ],
      }))
    : [];

  const memberFollowups = rankedStates
    .filter((state) => state.targetId !== 'user' && aiMemberSet.has(state.actorId) && aiMemberSet.has(state.targetId))
    .slice(0, 3)
    .map((state) => ({
      type: 'attention_followup_member',
      actorId: state.actorId,
      label: `${state.actorName} 跟进 ${state.targetName}`,
      description: cleanActionText(`关注${Math.round(state.attentionScore * 100)}% / 克制${Math.round(state.restraint * 100)}%，优先动作：${state.suggestedActions.slice(0, 3).map((item) => labelMap[item] || item).join('、')}。${state.reasons[0] ? ` 触发原因：${state.reasons[0]}` : ''}`),
      visibility: 'moderator_only' as const,
      fields: [
        {
          key: 'targetId',
          label: '跟进对象',
          type: 'single_select' as const,
          required: true,
          options: [{ value: state.targetId, label: state.targetName }],
        },
        {
          key: 'focus',
          label: '跟进内容',
          type: 'text' as const,
          required: false,
          placeholder: '例如：先接住对方刚才的观点，再追问关键细节',
        },
      ],
    }));

  return [...userFollowups, ...memberFollowups];
}

export function buildProjectedSessionActions(chat: GroupChat, actions: SessionActionDefinition[], members: AICharacter[] = [], now?: number) {
  const effectiveNow = resolveProjectionNow(now);
  const injected = actions.find((action) => action.type === 'start_private_thread');
  if (chat.type !== 'group') return actions;
  const chatMemberSet = new Set(chat.memberIds);
  const scopedMembers = members.filter((member) => chatMemberSet.has(member.id));
  const followupActions = buildAttentionFollowupActions(chat, members, effectiveNow);
  const dedupedFollowupActions = followupActions.filter((candidate) => !actions.some((action) => {
    if (action.type !== candidate.type || action.actorId !== candidate.actorId) return false;
    const actionTargetId = action.fields?.find((field) => field.key === 'targetId')?.options?.[0]?.value;
    const candidateTargetId = candidate.fields?.find((field) => field.key === 'targetId')?.options?.[0]?.value;
    if (!actionTargetId && !candidateTargetId) return true;
    return actionTargetId === candidateTargetId;
  }));
  if (injected?.fields?.length) {
    return [injected, ...dedupedFollowupActions, ...actions.filter((action) => action !== injected && action.type !== 'start_private_thread')];
  }
  const startPrivateThread: SessionActionDefinition = {
    type: 'start_private_thread',
    label: '发起 AI 私聊',
    description: '从群聊中手动选择两名成员，派生一条独立 AI 私聊。',
    fields: [
      { key: 'actorId', label: '发起者', type: 'single_select', required: true, options: scopedMembers.map((member) => ({ value: member.id, label: member.name })) },
      { key: 'targetId', label: '对象', type: 'single_select', required: true, options: scopedMembers.map((member) => ({ value: member.id, label: member.name })) },
    ],
    visibility: 'public',
  };
  const canInjectPrivateThread = canUsePrivateThreads(chat) && scopedMembers.length >= 2;
  return [
    ...(canInjectPrivateThread ? [startPrivateThread] : []),
    ...dedupedFollowupActions,
    ...actions.filter((action) => action.type !== 'start_private_thread'),
  ];
}

export function buildProjectedActionPanelTitle(chat: GroupChat, schemaTitle?: string) {
  return chat.type === 'group' ? '动作与派生' : schemaTitle;
}

export function buildProjectedComposerSurfaces(chat: GroupChat, frameworkState: ProjectedSessionFrameworkState) {
  return frameworkState.surfaces.surfaces.length ? frameworkState.surfaces.surfaces : buildDefaultSessionSurfaceProjection(chat).surfaces;
}

export function buildProjectedCompactMemorySummary(speakAsChar?: { layeredMemories?: Array<{ text: string }> } | null) {
  return speakAsChar?.layeredMemories?.slice(-getCurrentRetentionLimits().characterLayeredMemories.recall).map((item) => item.text).join(' / ');
}

export function buildProjectedSpeakAsSummary(speakAsChar?: { name?: string; layeredMemories?: Array<{ text: string }> } | null) {
  if (!speakAsChar) return null;
  const summary = buildProjectedCompactMemorySummary(speakAsChar);
  return summary ? `${speakAsChar.name}：${summary}` : null;
}

export function buildProjectedChatDetailState(params: {
  chat: GroupChat;
  members?: AICharacter[];
  runtimeState: ProjectedRuntimeState | null;
  privatePayloads: Array<{ key: string; title: string; text: string }>;
  visiblePanels: RuntimePanelDefinition[];
  schemaActions: SessionActionDefinition[] | undefined;
  schemaTitle?: string;
  rightPanelTab: string;
  frameworkState: ProjectedSessionFrameworkState;
  speakAsChar?: { name?: string; layeredMemories?: Array<{ text: string }> } | null;
  now?: number;
}): ProjectedChatDetailState {
  const memberPanel = params.visiblePanels.find((panel) => panel.tabKey === 'members');
  const runtimePanel = params.visiblePanels.find((panel) => panel.tabKey === 'world');
  const showMemberTab = Boolean(memberPanel);
  const showRuntimeTab = Boolean(runtimePanel);
  const actionList = params.schemaActions || [];
  const isStoryReader = params.chat.sessionKind?.scenarioId === 'story-reader';
  const showChapterTab = isStoryReader && showRuntimeTab;
  const showActionTab = isStoryReader ? false : params.chat.type === 'group' || Boolean(actionList.length);
  const activeSidebarTab = (showMemberTab && params.rightPanelTab === 'members')
    ? 'members'
    : (showRuntimeTab && params.rightPanelTab === 'narrative')
      ? 'narrative'
      : (showChapterTab && params.rightPanelTab === 'chapters')
        ? 'chapters'
        : (showRuntimeTab && params.rightPanelTab === 'world')
          ? 'world'
          : (showActionTab && (params.rightPanelTab === 'activities' || params.rightPanelTab === 'actions'))
            ? 'activities'
            : (params.rightPanelTab === 'session')
              ? 'session'
              : showActionTab ? 'actions' : showRuntimeTab ? 'world' : 'members';
  return {
    memberPanel,
    runtimePanel,
    showMemberTab,
    showRuntimeTab,
    showActionTab,
    activeSidebarTab,
    sidebarTitle: activeSidebarTab === 'members'
      ? (memberPanel?.title || (params.chat.type === 'group' ? '成员' : '角色'))
      : activeSidebarTab === 'actions'
        ? '动作'
        : activeSidebarTab === 'chapters'
          ? '章节'
          : activeSidebarTab === 'narrative'
            ? '叙事流'
            : (runtimePanel?.title || '运行态'),
    memberTabTitle: memberPanel?.title || (params.chat.type === 'group' ? '成员' : '角色'),
    runtimeTabTitle: runtimePanel?.title || '运行态',
    privatePayloadTitle: params.chat.type === 'direct' ? '单聊信息' : '私有信息',
    sidebarChat: buildProjectedSidebarChat(params.chat, params.runtimeState, params.privatePayloads),
    actionPanel: buildProjectedActionPanel(buildProjectedSessionActions(params.chat, actionList, params.members || [], params.now), buildProjectedActionPanelTitle(params.chat, params.schemaTitle) || '动作'),
    composerSurfaces: buildProjectedComposerSurfaces(params.chat, params.frameworkState),
    compactCharacterMemorySummary: buildProjectedCompactMemorySummary(params.speakAsChar),
    speakAsSummary: buildProjectedSpeakAsSummary(params.speakAsChar),
  };
}
