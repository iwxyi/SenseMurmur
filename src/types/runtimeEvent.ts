export type RuntimeEventKind =
  | 'message_generated'
  | 'interaction'
  | 'relationship_delta'
  | 'room_shift'
  | 'memory_candidate'
  | 'artifact'
  | 'event_candidate'
  | 'director_intervention'
  | 'decision_trace'
  | 'phase_transition'
  | 'action_resolution'
  | 'calendar_item_patch'
  | 'attention_candidate'
  | 'initial_relationship_inference'
  | 'board_state'
  | 'score_update';

export type ActorRef =
  | { kind: 'ai_character'; id: string }
  | { kind: 'user_persona'; id: string }
  | {
    kind: 'system_agent';
    id: string;
    subtype?: 'topic_guide' | 'host' | 'game_master' | 'narrator' | 'director' | 'moderator' | 'orchestrator';
  };

export type InteractionKind =
  | 'support'
  | 'challenge'
  | 'mock'
  | 'dismiss'
  | 'defend'
  | 'evade'
  | 'probe'
  | 'pile_on'
  | 'redirect'
  | 'apologize'
  | 'concede'
  | 'take_responsibility'
  | 'include'
  | 'exclude'
  | 'boundary'
  | 'side_comment';

/**
 * These interaction kinds create a plausible reply obligation in a live
 * conversation. This is a structured model signal, not a text/keyword guess.
 */
const REPLY_WORTHY_INTERACTION_KINDS: ReadonlySet<string> = new Set(['challenge', 'probe', 'mock', 'dismiss', 'boundary', 'apologize']);

export function isReplyWorthyInteractionKind(kind: InteractionKind | string | null | undefined) {
  return REPLY_WORTHY_INTERACTION_KINDS.has(String(kind || ''));
}

export interface ModelRelationshipAssessment {
  delta: {
    warmth: number;
    competence: number;
    trust: number;
    threat: number;
    attachment?: number;
    deference?: number;
  };
  labels?: string[];
  stance?: string;
}

export interface ModelImmediateImpact {
  speakerEmotionDelta?: Partial<Record<'irritation' | 'affection' | 'insecurity' | 'excitement' | 'embarrassment', number>>;
  targetEmotionDelta?: Partial<Record<'irritation' | 'affection' | 'insecurity' | 'excitement' | 'embarrassment', number>>;
  roomDelta?: Partial<Record<'heat' | 'cohesion' | 'topicDrift', number>>;
}

export interface InteractionEventPayload {
  kind: InteractionKind;
  actorId: string;
  targetId?: string | null;
  intensity: number;
  tone: 'warm' | 'annoyed' | 'defensive' | 'excited' | 'sarcastic' | 'cold';
  evidenceText: string;
  confidence: number;
  relationship?: ModelRelationshipAssessment;
  immediateImpact?: ModelImmediateImpact;
}

export interface InteractionHintEnvelope {
  targetId?: string | null;
  targetIds?: string[] | null;
  kind?: InteractionKind;
  tone?: InteractionEventPayload['tone'];
  intensity?: number;
  confidence?: number;
  reason?: string;
  evidenceText?: string;
  relationship?: ModelRelationshipAssessment;
  immediateImpact?: ModelImmediateImpact;
}

export interface AddressedTargetHintEnvelope {
  targetIds?: string[] | null;
  primaryTargetId?: string | null;
  confidence?: number;
  reason?: string;
}

/** A separate channel for a new, explicit expectation of a next reply. */
export interface ReplyDebtTargetHintEnvelope {
  targetIds?: string[] | null;
  primaryTargetId?: string | null;
  confidence?: number;
  reason?: string;
}

export interface AddressedTargetHint {
  actorId: string;
  targetIds: string[];
  primaryTargetId?: string | null;
  confidence: number;
  evidenceText: string;
}

export interface InteractionHintCollection {
  primary?: InteractionHintEnvelope | null;
  secondary?: InteractionHintEnvelope[] | null;
}

export function isInteractionPayloadMeaningful(payload: Pick<InteractionEventPayload, 'targetId' | 'kind'> | null | undefined) {
  return Boolean(payload?.targetId && payload?.kind && payload.kind !== 'side_comment');
}

export function normalizeInteractionHintPayload(hint: InteractionHintEnvelope | null | undefined, actorId: string, content: string): InteractionEventPayload | null {
  const resolvedTargetId = hint?.targetId || hint?.targetIds?.[0] || null;
  if (!resolvedTargetId || !hint?.kind || hint.kind === 'side_comment') return null;
  const evidence = typeof hint.evidenceText === 'string' ? hint.evidenceText.trim() : '';
  if (!evidence || !content.replace(/\s+/gu, '').includes(evidence.replace(/\s+/gu, ''))) return null;
  const rawIntensity = Number(hint.intensity || 0);
  const rawConfidence = Number(hint.confidence || 0);
  const intensity = Math.max(1, Math.min(5, rawIntensity > 5 ? Math.round(rawIntensity / 20) : rawIntensity));
  const confidence = Math.max(0, Math.min(1, rawConfidence > 1 ? rawConfidence / 100 : rawConfidence));
  const relationship = hint.relationship && typeof hint.relationship === 'object'
    ? {
      delta: {
        warmth: Math.max(-8, Math.min(8, Number(hint.relationship.delta?.warmth || 0))),
        competence: Math.max(-8, Math.min(8, Number(hint.relationship.delta?.competence || 0))),
        trust: Math.max(-8, Math.min(8, Number(hint.relationship.delta?.trust || 0))),
        threat: Math.max(-8, Math.min(8, Number(hint.relationship.delta?.threat || 0))),
        attachment: Math.max(-2, Math.min(2, Number(hint.relationship.delta?.attachment || 0))),
        deference: Math.max(-2, Math.min(2, Number(hint.relationship.delta?.deference || 0))),
      },
      labels: Array.isArray(hint.relationship.labels) ? hint.relationship.labels.filter((item): item is string => typeof item === 'string').slice(0, 5) : [],
      stance: typeof hint.relationship.stance === 'string' ? hint.relationship.stance.slice(0, 160) : undefined,
    }
    : undefined;
  const normalizedRelationship = relationship && Object.values(relationship.delta).some((value) => value !== 0) ? relationship : undefined;
  const normalizeDelta = <T extends string>(
    source: Partial<Record<T, number>> | null | undefined,
    keys: readonly T[],
    limit: number,
  ) => Object.fromEntries(keys.flatMap((key) => {
    const value = Number(source?.[key]);
    if (!Number.isFinite(value) || value === 0) return [];
    return [[key, Math.round(Math.max(-limit, Math.min(limit, value)))]];
  })) as Partial<Record<T, number>>;
  const speakerEmotionDelta = normalizeDelta(hint.immediateImpact?.speakerEmotionDelta, ['irritation', 'affection', 'insecurity', 'excitement', 'embarrassment'] as const, 40);
  const targetEmotionDelta = normalizeDelta(hint.immediateImpact?.targetEmotionDelta, ['irritation', 'affection', 'insecurity', 'excitement', 'embarrassment'] as const, 40);
  const roomDelta = normalizeDelta(hint.immediateImpact?.roomDelta, ['heat', 'cohesion', 'topicDrift'] as const, 20);
  const immediateImpact = Object.keys(speakerEmotionDelta).length || Object.keys(targetEmotionDelta).length || Object.keys(roomDelta).length
    ? { speakerEmotionDelta, targetEmotionDelta, roomDelta }
    : undefined;
  return {
    actorId,
    targetId: resolvedTargetId,
    kind: hint.kind,
    tone: hint.tone || 'cold',
    intensity,
    confidence,
    evidenceText: evidence.slice(0, 120),
    // A directed social event can create a strong short-lived emotion without
    // changing the long-lived relationship. Keep the event while leaving its
    // relationship assessment absent in that case.
    relationship: normalizedRelationship,
    immediateImpact,
  };
}

export function normalizeInteractionHintCollection(hints: InteractionHintCollection | null | undefined, actorId: string, content: string) {
  const primary = normalizeInteractionHintPayload(hints?.primary || null, actorId, content);
  const secondary = (hints?.secondary || []).map((hint) => normalizeInteractionHintPayload(hint, actorId, content)).filter(Boolean) as InteractionEventPayload[];
  return [primary, ...secondary].filter(Boolean) as InteractionEventPayload[];
}

export function summarizeCompactRelationshipDeltaLines(lines: Array<{ actorName: string; targetName: string; delta: Partial<Record<'warmth' | 'competence' | 'trust' | 'threat', number>> }>) {
  return lines.map((line) => {
    const parts = [
      line.delta.warmth ? `亲和${line.delta.warmth > 0 ? '+' : ''}${line.delta.warmth}` : '',
      line.delta.competence ? `能力${line.delta.competence > 0 ? '+' : ''}${line.delta.competence}` : '',
      line.delta.trust ? `信任${line.delta.trust > 0 ? '+' : ''}${line.delta.trust}` : '',
      line.delta.threat ? `威胁${line.delta.threat > 0 ? '+' : ''}${line.delta.threat}` : '',
    ].filter(Boolean).join('，');
    return `${line.actorName}→${line.targetName}：${parts || '无变化'}`;
  }).join('\n');
}

export interface RelationshipAxisReason {
  axis: 'warmth' | 'competence' | 'trust' | 'threat';
  value: number;
  reason: string;
  evidence: string;
  createdAt?: number;
}

export interface RelationshipDeltaPayload {
  actorId: string;
  targetId: string;
  delta: {
    warmth?: number;
    competence?: number;
    trust?: number;
    threat?: number;
    attachment?: number;
    deference?: number;
  };
  reason: string;
  semanticLabels?: string[];
  semanticStance?: string;
  axisReasons?: Partial<Record<'warmth' | 'competence' | 'trust' | 'threat', RelationshipAxisReason[]>>;
  spikeType?: 'normal' | 'turning_point' | 'rupture' | 'bonding';
}

export interface RoomShiftPayload {
  heat?: number;
  cohesion?: number;
  topicDrift?: number;
  dominantThread?: [string, string] | null;
  pileOnTarget?: string | null;
  delta?: {
    heat?: number;
    cohesion?: number;
    topicDrift?: number;
  };
}

export interface MemoryCandidatePayload {
  kind: 'fact' | 'topic' | 'preference' | 'secret' | 'relationship';
  text: string;
  salience: number;
  confidence: number;
  origin?: 'runtime' | 'distilled' | 'seeded';
  sharedPhrase?: {
    text: string;
    kind: 'pet_name' | 'inside_joke' | 'promise_line' | 'comfort_line' | 'confession_line' | 'secret_code' | 'other';
    visibility: 'private' | 'between_actors' | 'public_hint';
  };
}

export interface DirectorInterventionPayload {
  intent: 'force_reply' | 'escalate' | 'cool_down' | 'inject_event' | 'summarize' | 'reveal' | 'redirect';
  targetActorIds?: string[];
  targetLineId?: string;
  pressure: number;
  text: string;
  maxTurns?: number;
  expiresAt?: number;
  userGuidance?: Record<string, unknown>;
}

export interface DecisionTracePayload {
  directorIntent?: Record<string, unknown>;
  activeLineIds?: string[];
  speakerScores?: Array<Record<string, unknown>>;
  selectedActorId?: string;
  reason?: string;
}

export type SocialEventKind = 'pair_private_thread' | 'social_outing' | 'post_moment' | 'status_update' | 'gift_exchange' | 'conflict_expression' | 'check_in' | 'react_to_moment' | 'custom';

export interface SocialEventCandidatePayload {
  eventKind: SocialEventKind;
  initiatorId: string;
  participantIds: string[];
  targetIds?: string[];
  reasonType: string;
  confidence: number;
  urgency: 'immediate' | 'soon' | 'defer';
  seedIntent: string;
  visibilityPlan: 'public' | 'conversation_private' | 'user_private' | 'mixed';
  expectedArtifacts?: string[];
  sourceText?: string;
  triggerReason?: string;
  openingMessage?: string;
  momentText?: string;
  companionshipSeeds?: string[];
  decisionSource?: 'model' | 'local_fallback';
  title?: string;
  activityType?: string;
  timeHint?: string | null;
  locationHint?: string | null;
  dedupeKey?: string | null;
  participantStates?: Partial<Record<string, 'mentioned' | 'invited' | 'interested' | 'maybe' | 'going' | 'declined' | 'withdrawn'>>;
  attentionTrace?: {
    score: number;
    restraint: number;
    suggestedActions: Array<'check_in' | 'ask_followup' | 'private_message' | 'react_to_moment' | 'invite_activity' | 'calendar_reminder' | 'comfort' | 'share_moment'>;
    reasons: string[];
    latestEvidenceAt: number;
  };
}

export interface SocialEventHintEnvelope {
  eventKind: SocialEventKind;
  targetIds?: string[];
  participantIds?: string[];
  reasonType?: string;
  confidence?: number;
  urgency?: 'immediate' | 'soon' | 'defer';
  seedIntent?: string;
  visibilityPlan?: 'public' | 'conversation_private' | 'user_private' | 'mixed';
  expectedArtifacts?: string[];
  triggerReason?: string;
  openingMessage?: string;
  title?: string;
  activityType?: string;
  timeHint?: string | null;
  locationHint?: string | null;
  dedupeKey?: string | null;
  participantStates?: Partial<Record<string, 'mentioned' | 'invited' | 'interested' | 'maybe' | 'going' | 'declined' | 'withdrawn'>>;
}

const SOCIAL_EVENT_KINDS: SocialEventKind[] = [
  'pair_private_thread',
  'social_outing',
  'post_moment',
  'status_update',
  'gift_exchange',
  'conflict_expression',
  'check_in',
  'react_to_moment',
  'custom',
];

function isSocialEventKind(value: unknown): value is SocialEventKind {
  return typeof value === 'string' && SOCIAL_EVENT_KINDS.includes(value as SocialEventKind);
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : undefined;
}

const SOCIAL_EVENT_PARTICIPANT_STATES = ['mentioned', 'invited', 'interested', 'maybe', 'going', 'declined', 'withdrawn'] as const;

function normalizeParticipantStates(value: unknown): SocialEventHintEnvelope['participantStates'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, typeof SOCIAL_EVENT_PARTICIPANT_STATES[number]] => (
      Boolean(entry[0].trim())
      && typeof entry[1] === 'string'
      && SOCIAL_EVENT_PARTICIPANT_STATES.includes(entry[1] as typeof SOCIAL_EVENT_PARTICIPANT_STATES[number])
    ));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeSocialEventHint(value: unknown): SocialEventHintEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isSocialEventKind(raw.eventKind)) return null;
  const rawConfidence = typeof raw.confidence === 'number' ? raw.confidence : undefined;
  const confidence = rawConfidence == null
    ? undefined
    : Math.max(0, Math.min(1, rawConfidence > 1 ? rawConfidence / 100 : rawConfidence));
  return {
    eventKind: raw.eventKind,
    targetIds: normalizeStringArray(raw.targetIds),
    participantIds: normalizeStringArray(raw.participantIds),
    reasonType: typeof raw.reasonType === 'string' ? raw.reasonType : undefined,
    confidence,
    urgency: raw.urgency === 'immediate' || raw.urgency === 'soon' || raw.urgency === 'defer' ? raw.urgency : undefined,
    seedIntent: typeof raw.seedIntent === 'string' ? raw.seedIntent : undefined,
    visibilityPlan: raw.visibilityPlan === 'public' || raw.visibilityPlan === 'conversation_private' || raw.visibilityPlan === 'user_private' || raw.visibilityPlan === 'mixed' ? raw.visibilityPlan : undefined,
    expectedArtifacts: normalizeStringArray(raw.expectedArtifacts),
    triggerReason: typeof raw.triggerReason === 'string' ? raw.triggerReason : undefined,
    openingMessage: typeof raw.openingMessage === 'string' ? raw.openingMessage : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    activityType: typeof raw.activityType === 'string' ? raw.activityType : undefined,
    timeHint: typeof raw.timeHint === 'string' || raw.timeHint === null ? raw.timeHint : undefined,
    locationHint: typeof raw.locationHint === 'string' || raw.locationHint === null ? raw.locationHint : undefined,
    dedupeKey: typeof raw.dedupeKey === 'string' || raw.dedupeKey === null ? raw.dedupeKey : undefined,
    participantStates: normalizeParticipantStates(raw.participantStates),
  };
}

export function normalizeSocialEventHints(value: unknown): SocialEventHintEnvelope[] {
  const values = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return values
    .map((item) => normalizeSocialEventHint(item))
    .filter((item): item is SocialEventHintEnvelope => Boolean(item));
}

export interface RecentSocialEventSummary {
  eventKind: SocialEventKind;
  title?: string;
  activityType?: string;
  participantIds?: string[];
  targetIds?: string[];
  createdAt: number;
  summary: string;
}

export interface SocialOutingAnalysisResult {
  shouldCreate: boolean;
  title?: string;
  activityType?: string;
  timeHint?: string | null;
  locationHint?: string | null;
  participantIds?: string[];
  confidence?: number;
  reasonType?: string;
  dedupeKey?: string | null;
  seedIntent?: string;
}

export interface PostMomentAnalysisResult {
  shouldCreate: boolean;
  title?: string;
  activityType?: string;
  targetIds?: string[];
  confidence?: number;
  reasonType?: string;
  dedupeKey?: string | null;
  seedIntent?: string;
}

export interface PairPrivateThreadAnalysisResult {
  shouldCreate: boolean;
  participantIds?: string[];
  targetIds?: string[];
  confidence?: number;
  reasonType?: string;
  dedupeKey?: string | null;
  seedIntent?: string;
  triggerReason?: string;
  openingMessage?: string;
}

export interface SocialEventEffectPayload {
  eventKind: SocialEventKind;
  effectType: 'memory' | 'relationship' | 'room' | 'artifact';
  summary: string;
  confidence: number;
}

export interface SocialEventArtifactPayload {
  artifactType: string;
  eventKind: SocialEventKind;
  text: string;
  expectedArtifacts?: string[];
  media?: Array<{
    assetId?: string;
    thumbnailAssetId?: string;
    url: string;
    thumbnailUrl?: string;
    fullUrl?: string;
    mimeType?: string;
    sizeBytes?: number;
    alt?: string;
    storage?: 'cloud_asset' | 'local_indexeddb' | 'inline';
  }>;
}

export type ConflictType =
  | 'identity_ownership'
  | 'authority_challenge'
  | 'status_competition'
  | 'alliance_boundary'
  | 'care_jealousy'
  | 'value_conflict'
  | 'goal_conflict'
  | 'resource_conflict'
  | 'fairness_conflict'
  | 'contradiction_exposure'
  | 'tone_escalation'
  | 'misrecognition';

export type ConflictStage = 'latent' | 'emerging' | 'open' | 'escalating' | 'fragmented' | 'cooling' | 'resolved';
export type ConflictNextPressure = 'escalate' | 'spread' | 'stabilize' | 'divert' | 'cool';
export type ConflictDevelopmentHook =
  | 'invite_target_response'
  | 'force_side_taking'
  | 'expose_contradiction'
  | 'raise_stakes'
  | 'shift_public_private'
  | 'cool_down_with_residue'
  | 'redirect_topic'
  | 'trigger_memory_recall';

export interface ConflictFocusPayload {
  conflictId?: string | null;
  evidenceText?: string;
  present: boolean;
  type?: ConflictType;
  severity?: number;
  stage?: ConflictStage;
  summary?: string;
  primaryTargetIds?: string[];
  participantIds?: string[];
  nextPressure?: ConflictNextPressure;
  developmentHooks?: ConflictDevelopmentHook[];
  why?: string;
}

export interface ConflictFocusState {
  id: string;
  scope: 'assistant' | 'group' | 'direct' | 'ai_direct';
  type: ConflictType;
  severity: number;
  stage: ConflictStage;
  summary: string;
  participantIds: string[];
  targetIds?: string[];
  triggerMessageId?: string;
  nextPressure: ConflictNextPressure;
  developmentHooks: ConflictDevelopmentHook[];
  sourceEventIds: string[];
  updatedAt: number;
}

export interface ConflictRuntimeState {
  primaryConflict?: ConflictFocusState | null;
  activeConflicts: ConflictFocusState[];
  developmentHooks: ConflictDevelopmentHook[];
  volatility: number;
  cooling: number;
  updatedAt: number;
}

export interface RuntimeEventV2 {
  id: string;
  conversationId: string;
  kind: RuntimeEventKind;
  createdAt: number;
  actorIds?: string[];
  targetIds?: string[];
  evidenceMessageIds?: string[];
  summary: string;
  channelId?: string;
  causedByIntentId?: string;
  threadRef?: string;
  eventClass?: 'message' | 'action' | 'board' | 'phase' | 'score' | 'artifact';
  visibility?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';
  visibleToIds?: string[];
  visibleToRoles?: string[];
  payload: InteractionEventPayload | RelationshipDeltaPayload | RoomShiftPayload | MemoryCandidatePayload | DirectorInterventionPayload | DecisionTracePayload | SocialEventCandidatePayload | SocialEventEffectPayload | SocialEventArtifactPayload | ConflictFocusPayload | Record<string, unknown>;
}

export interface RelationshipLedgerRecentEvent {
  id: string;
  kind: RuntimeEventKind;
  createdAt: number;
  summary: string;
  actorIds?: string[];
  targetIds?: string[];
}

export function toRelationshipLedgerRecentEvent(event: Pick<RuntimeEventV2, 'id' | 'kind' | 'createdAt' | 'summary' | 'actorIds' | 'targetIds'>): RelationshipLedgerRecentEvent {
  return {
    id: event.id,
    kind: event.kind,
    createdAt: event.createdAt,
    summary: event.summary,
    actorIds: event.actorIds,
    targetIds: event.targetIds,
  };
}

export interface RelationshipAxes {
  warmth: number;
  competence: number;
  trust: number;
  threat: number;
  attachment?: number;
  deference?: number;
}

export interface RelationshipLedgerEntry {
  pairKey: string;
  actorId: string;
  targetId: string;
  /** Room baseline derived from the current relationship default; absent on legacy entries. */
  baseline?: RelationshipAxes;
  /** Room-local evolution; effective current is baseline plus adjustment. */
  adjustment?: RelationshipAxes;
  /** Compatibility cache of the effective relationship; never independently mutated. */
  current: RelationshipAxes;
  derived?: {
    stability?: number;
    reciprocity?: number;
    salience?: number;
    semantic?: {
      stage: string;
      labels: string[];
      summary: string;
      intensity: number;
    };
  };
  axisReasons?: Partial<Record<'warmth' | 'competence' | 'trust' | 'threat', RelationshipAxisReason[]>>;
  trend: 'up' | 'down' | 'volatile' | 'flat';
  recentEvents: RelationshipLedgerRecentEvent[];
  lastUpdatedAt: number;
}

export interface RoomStateSnapshotV2 {
  heat: number;
  cohesion: number;
  topicDrift: number;
  dominantThread: [string, string] | null;
  alliances: Array<[string, string]>;
  conflictPairs: Array<[string, string]>;
  pileOnTarget: string | null;
  silencedActors: string[];
}
