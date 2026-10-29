import type { AICharacter } from './character';
import type { GroupChat, ParticipantInstance, RuntimeAction, RuntimePanelDefinition } from './chat';
import type { CharacterMention, Message, MessageAttachment, NarrativeBlock } from './message';
import type { APIConfig } from './settings';
import { buildDirectorInterventionFields } from './directorInterventionAction';
import { canUseDirectorIntervention, canUseMute, canUsePrivateThreads } from '../services/conversationCapabilities';

export type SessionFamily = 'assistant' | 'conversation' | 'interview' | 'deduction' | 'mystery' | 'study' | 'analysis' | 'board_game' | 'agent' | 'simulation';
export type SessionSurfaceProfile = 'text' | 'form' | 'board' | 'hybrid' | 'timeline' | 'dashboard';
export type SessionTopology = 'group' | 'direct' | 'thread' | 'team' | 'table';
export type SessionActorKind = 'ai_agent' | 'human_user' | 'system_agent' | 'moderator_agent' | 'observer';
export type SessionViewerCapability = 'speak' | 'guide' | 'moderate' | 'judge' | 'observe' | 'speak_as';
export type SessionIntentType = 'message_intent' | 'action_intent' | 'board_intent' | 'form_intent' | 'system_intent';
export type SessionInputSurfaceType = 'text' | 'form' | 'board' | 'hybrid';
export type VisibilityScope = 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';

export interface SessionKind {
  topology: SessionTopology;
  family: SessionFamily;
  scenarioId: string;
  surfaceProfile: SessionSurfaceProfile;
}

export interface SessionActor {
  actorId: string;
  kind: SessionActorKind;
  entityRefId?: string | null;
  seatId?: string | null;
  roleId?: string | null;
  teamId?: string | null;
  displayName?: string;
}

export interface SessionInputFieldOption {
  label: string;
  value: string;
}

export interface SessionInputField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'single_select' | 'number' | 'multi_select';
  required?: boolean;
  options?: SessionInputFieldOption[];
  placeholder?: string;
}

export interface SessionInputSurfaceDefinition {
  key: string;
  type: SessionInputSurfaceType;
  label?: string;
  actorId?: string;
  capability?: SessionViewerCapability;
  placeholder?: string;
  mode?: 'guide' | 'speakAs' | 'memberSpeak';
  fields?: SessionInputField[];
}

export interface SessionIntent {
  type: SessionIntentType;
  actorId?: string;
  channelId?: string;
  targetIds?: string[];
  payload: Record<string, unknown>;
}

export interface SessionComposerContext {
  conversation: GroupChat;
  participants: ParticipantInstance[];
  viewerId?: string | null;
  viewerRole?: string | null;
}

export interface SessionNormalizedIntentResult {
  intent: SessionIntent;
}

export interface SessionFamilyDefinition {
  key: SessionFamily;
  label: string;
  supportsThreads?: boolean;
  supportsPrivateRoles?: boolean;
  defaultActionChance?: number;
}

export interface SessionFamilyRegistryEntry {
  definition: SessionFamilyDefinition;
  defaultSurfaceProfile: SessionSurfaceProfile;
}

export interface SessionRuntimeLoopDecision {
  canRun: boolean;
  runChat: boolean;
  runAction: boolean;
  actionFirst: boolean;
}

export interface SessionScenarioResolution {
  scenarioId: string;
  label: string;
  family: SessionFamily;
  surfaceProfile?: SessionSurfaceProfile;
}

export interface SessionFrameworkRegistry {
  families: Record<SessionFamily, SessionFamilyRegistryEntry>;
  scenarios: Record<string, SessionScenarioResolution>;
}

export interface ScenarioSeat {
  seatId: string;
  seatIndex: number;
  roleId?: string | null;
  teamId?: string | null;
  actorId?: string | null;
  displayName?: string;
  muted?: boolean;
  canSpeak?: boolean;
}

export interface PersistentCharacterCore {
  characterId: string;
  summary?: string;
}

export interface ConversationCharacterState {
  characterId: string;
  summary?: string;
}

export interface SessionScenarioDefinition {
  scenarioId: string;
  label: string;
}

export interface SessionResolvedDefinition {
  kind: SessionKind;
  family: SessionFamilyDefinition;
  scenario: SessionScenarioDefinition;
}

export interface SessionTopologySummary {
  topology: SessionTopology;
  description: string;
}

export interface SessionChannelDefinition {
  channelId: string;
  visibility: VisibilityScope;
  label?: string;
  actorIds?: string[];
  roleIds?: string[];
}

export interface SessionBoardSchema {
  kind: string;
  columns?: number;
  rows?: number;
  nodes?: Array<{ id: string; x: number; y: number }>;
  edges?: Array<{ from: string; to: string }>;
}

export interface SessionBoardState {
  schema: SessionBoardSchema;
  pieces?: Array<{ id: string; type: string; actorId?: string; teamId?: string; position: string }>;
}

export interface SessionBoardRendererDefinition {
  kind: string;
  schema: SessionBoardSchema;
}

export interface SessionJudgeAgentDefinition {
  actorId?: string;
  enabled: boolean;
  style?: 'strict' | 'assistive';
}

export interface SessionScenarioPackage {
  scenarioId: string;
  label: string;
  seats?: ScenarioSeat[];
  channels?: SessionChannelDefinition[];
  board?: SessionBoardSchema | null;
}

export interface SessionMemoryLayerSummary {
  characterCore: boolean;
  relationship: boolean;
  conversation: boolean;
  scenario: boolean;
}

export interface SessionTurnOrderState {
  actorIds: string[];
  currentIndex: number;
}

export interface SessionFactionDefinition {
  factionId: string;
  label: string;
}

export interface SessionLayoutSlot {
  slotId: string;
  x: number;
  y: number;
  actorId?: string | null;
}

export interface SessionRefereeDecision {
  allowed: boolean;
  reason?: string;
}

export interface SessionFamilyRuntimeSummary {
  family: SessionFamily;
  scenarioId: string;
}

export interface SessionGrowthSnapshot {
  actorId: string;
  conversationSummary?: string;
  persistentSummary?: string;
}

export interface SessionRoleMemorySummary {
  actorId: string;
  roleId?: string | null;
  summary?: string;
}

export interface SessionScenarioMemorySummary {
  conversationId: string;
  summary?: string;
}

export interface SessionBoardIntentPayload {
  position?: string;
  pieceId?: string;
  move?: string;
}

export interface SessionFormIntentPayload {
  fields: Record<string, unknown>;
}

export interface SessionTextComposerSubmission {
  content: string;
  mentions?: CharacterMention[];
  actorId?: string;
  attachments?: MessageAttachment[];
}

export interface SessionFormComposerSubmission {
  fields: Record<string, unknown>;
  actorId?: string;
}

export interface SessionBoardComposerSubmission {
  position?: string;
  pieceId?: string;
  move?: string;
  actorId?: string;
}

export interface SessionSurfaceProjection {
  surfaces: SessionInputSurfaceDefinition[];
}

export const DEFAULT_SESSION_FAMILY_REGISTRY: SessionFrameworkRegistry = {
  families: {
    assistant: { definition: { key: 'assistant', label: 'assistant', defaultActionChance: 0 }, defaultSurfaceProfile: 'text' },
    conversation: { definition: { key: 'conversation', label: 'conversation', supportsThreads: true, defaultActionChance: 0.08 }, defaultSurfaceProfile: 'text' },
    interview: { definition: { key: 'interview', label: 'interview', defaultActionChance: 0.18 }, defaultSurfaceProfile: 'form' },
    deduction: { definition: { key: 'deduction', label: 'deduction', supportsPrivateRoles: true, defaultActionChance: 0.16 }, defaultSurfaceProfile: 'hybrid' },
    mystery: { definition: { key: 'mystery', label: 'mystery', supportsPrivateRoles: true, defaultActionChance: 0.14 }, defaultSurfaceProfile: 'hybrid' },
    study: { definition: { key: 'study', label: 'study', defaultActionChance: 0.12 }, defaultSurfaceProfile: 'form' },
    analysis: { definition: { key: 'analysis', label: 'analysis', defaultActionChance: 0.1 }, defaultSurfaceProfile: 'text' },
    board_game: { definition: { key: 'board_game', label: 'board_game', defaultActionChance: 0.22 }, defaultSurfaceProfile: 'board' },
    agent: { definition: { key: 'agent', label: 'agent', defaultActionChance: 0.2 }, defaultSurfaceProfile: 'dashboard' },
    simulation: { definition: { key: 'simulation', label: 'simulation', defaultActionChance: 0.1 }, defaultSurfaceProfile: 'timeline' },
  },
  scenarios: {
    'general-assistant': { scenarioId: 'general-assistant', label: 'general-assistant', family: 'assistant', surfaceProfile: 'text' },
    'open-chat': { scenarioId: 'open-chat', label: 'open-chat', family: 'conversation', surfaceProfile: 'text' },
    'direct-chat': { scenarioId: 'direct-chat', label: 'direct-chat', family: 'conversation', surfaceProfile: 'text' },
    'ai-private-thread': { scenarioId: 'ai-private-thread', label: 'ai-private-thread', family: 'conversation', surfaceProfile: 'text' },
    'opinion-review': { scenarioId: 'opinion-review', label: 'opinion-review', family: 'analysis', surfaceProfile: 'text' },
    'roundtable-review': { scenarioId: 'roundtable-review', label: 'roundtable-review', family: 'analysis', surfaceProfile: 'text' },
    'role-debate': { scenarioId: 'role-debate', label: 'role-debate', family: 'analysis', surfaceProfile: 'text' },
    'courtroom-deliberation': { scenarioId: 'courtroom-deliberation', label: 'courtroom-deliberation', family: 'analysis', surfaceProfile: 'text' },
    'expert-review': { scenarioId: 'expert-review', label: 'expert-review', family: 'analysis', surfaceProfile: 'text' },
    'public-inquiry': { scenarioId: 'public-inquiry', label: 'public-inquiry', family: 'analysis', surfaceProfile: 'text' },
    'brainstorm-workshop': { scenarioId: 'brainstorm-workshop', label: 'brainstorm-workshop', family: 'analysis', surfaceProfile: 'text' },
    'task-retrospective': { scenarioId: 'task-retrospective', label: 'task-retrospective', family: 'analysis', surfaceProfile: 'text' },
    'story-reader': { scenarioId: 'story-reader', label: 'story-reader', family: 'conversation', surfaceProfile: 'hybrid' },
    'ielts-coach': { scenarioId: 'ielts-coach', label: 'ielts-coach', family: 'study', surfaceProfile: 'form' },
    'learning-progress': { scenarioId: 'learning-progress', label: 'learning-progress', family: 'study', surfaceProfile: 'hybrid' },
    'single-agent-workflow': { scenarioId: 'single-agent-workflow', label: 'single-agent-workflow', family: 'agent', surfaceProfile: 'dashboard' },
    'multi-agent-workflow': { scenarioId: 'multi-agent-workflow', label: 'multi-agent-workflow', family: 'agent', surfaceProfile: 'dashboard' },
    'panel-interview': { scenarioId: 'panel-interview', label: 'panel-interview', family: 'interview', surfaceProfile: 'form' },
    'werewolf-classic': { scenarioId: 'werewolf-classic', label: 'werewolf-classic', family: 'deduction', surfaceProfile: 'hybrid' },
    'murder-mystery': { scenarioId: 'murder-mystery', label: 'murder-mystery', family: 'mystery', surfaceProfile: 'hybrid' },
    'board-game': { scenarioId: 'board-game', label: 'board-game', family: 'board_game', surfaceProfile: 'board' },
  },
};

export function getSessionFamilyDefinition(family: SessionFamily): SessionFamilyDefinition {
  return DEFAULT_SESSION_FAMILY_REGISTRY.families[family]?.definition || { key: family, label: family };
}

export function getSessionScenarioResolution(scenarioId: string): SessionScenarioResolution {
  return DEFAULT_SESSION_FAMILY_REGISTRY.scenarios[scenarioId] || { scenarioId, label: scenarioId, family: 'conversation' };
}

export function deriveLoopDecisionFromTurnPolicy(policy: SessionTurnPolicy): SessionRuntimeLoopDecision {
  return {
    canRun: Boolean(policy.runChat || policy.runAction),
    runChat: Boolean(policy.runChat),
    runAction: Boolean(policy.runAction),
    actionFirst: Boolean(policy.interleaveAction && policy.runAction),
  };
}

export function createDefaultTurnPolicyForFamily(family: SessionFamily, canSpeak: boolean, canAct: boolean): SessionTurnPolicy {
  if (family === 'interview') return { runChat: canSpeak, runAction: canAct, interleaveAction: canAct };
  if (family === 'deduction' || family === 'mystery') return { runChat: canSpeak, runAction: canAct, interleaveAction: true };
  if (family === 'board_game') return { runChat: canSpeak, runAction: true, interleaveAction: true };
  return { runChat: canSpeak, runAction: canAct, interleaveAction: canSpeak && canAct };
}

export function createDefaultSessionKind(type: GroupChat['type'], mode: GroupChat['mode']): SessionKind {
  if (type === 'assistant') return { topology: 'direct', family: 'assistant', scenarioId: 'general-assistant', surfaceProfile: 'text' };
  if (mode === 'board_game') return { topology: type === 'group' ? 'table' : 'direct', family: 'board_game', scenarioId: 'board-game', surfaceProfile: 'board' };
  if (mode === 'interview') return { topology: type === 'group' ? 'group' : 'direct', family: 'interview', scenarioId: 'panel-interview', surfaceProfile: 'form' };
  if (mode === 'group_discussion' || mode === 'roundtable') return { topology: type === 'group' ? 'group' : 'team', family: 'analysis', scenarioId: mode === 'roundtable' ? 'roundtable-review' : 'opinion-review', surfaceProfile: 'text' };
  if (mode === 'classroom') return { topology: type === 'group' ? 'group' : 'direct', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' };
  if (mode === 'scripted_play') return { topology: type === 'group' ? 'group' : 'direct', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' };
  if (mode === 'werewolf') return { topology: 'table', family: 'deduction', scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid' };
  if (mode === 'murder_mystery') return { topology: 'table', family: 'mystery', scenarioId: 'murder-mystery', surfaceProfile: 'hybrid' };
  return {
    topology: type === 'group' ? 'group' : type === 'ai_direct' ? 'thread' : 'direct',
    family: 'conversation',
    scenarioId: type === 'group' ? 'open-chat' : type === 'ai_direct' ? 'ai-private-thread' : 'direct-chat',
    surfaceProfile: 'text',
  };
}

export function createDefaultSessionFamilyDefinition(kind: SessionKind): SessionFamilyDefinition {
  return getSessionFamilyDefinition(kind.family);
}

export function createDefaultSessionScenarioDefinition(kind: SessionKind): SessionScenarioDefinition {
  const scenario = getSessionScenarioResolution(kind.scenarioId);
  return { scenarioId: scenario.scenarioId, label: scenario.label };
}

export function resolveSessionDefinition(conversation: GroupChat): SessionResolvedDefinition {
  const kind = conversation.sessionKind || createDefaultSessionKind(conversation.type, conversation.mode);
  return {
    kind,
    family: createDefaultSessionFamilyDefinition(kind),
    scenario: createDefaultSessionScenarioDefinition(kind),
  };
}

export function createDefaultTextInputSurface(params: { key?: string; label?: string; mode?: 'guide' | 'speakAs' | 'memberSpeak'; actorId?: string; placeholder?: string; capability?: SessionViewerCapability } = {}): SessionInputSurfaceDefinition {
  return {
    key: params.key || 'main-text',
    type: 'text',
    label: params.label,
    mode: params.mode || 'guide',
    actorId: params.actorId,
    placeholder: params.placeholder,
    capability: params.capability || 'guide',
  };
}

export function normalizeTextSurfaceSubmission(surface: SessionInputSurfaceDefinition, submission: SessionTextComposerSubmission): SessionNormalizedIntentResult {
  return {
    intent: {
      type: 'message_intent',
      actorId: submission.actorId || surface.actorId,
      payload: {
        content: submission.content,
        attachments: submission.attachments || [],
        mentions: submission.mentions || [],
        surfaceKey: surface.key,
        mode: surface.mode || 'guide',
      },
    },
  };
}

export function normalizeFormSurfaceSubmission(surface: SessionInputSurfaceDefinition, submission: SessionFormComposerSubmission): SessionNormalizedIntentResult {
  return {
    intent: {
      type: surface.type === 'hybrid' ? 'action_intent' : 'form_intent',
      actorId: submission.actorId || surface.actorId,
      payload: {
        fields: submission.fields,
        surfaceKey: surface.key,
      },
    },
  };
}

export function normalizeBoardSurfaceSubmission(surface: SessionInputSurfaceDefinition, submission: SessionBoardComposerSubmission): SessionNormalizedIntentResult {
  return {
    intent: {
      type: 'board_intent',
      actorId: submission.actorId || surface.actorId,
      payload: {
        position: submission.position,
        pieceId: submission.pieceId,
        move: submission.move,
        surfaceKey: surface.key,
      },
    },
  };
}

export function normalizeSurfaceSubmission(surface: SessionInputSurfaceDefinition, submission: SessionTextComposerSubmission | SessionFormComposerSubmission | SessionBoardComposerSubmission): SessionNormalizedIntentResult {
  if (surface.type === 'form' || surface.type === 'hybrid') {
    return normalizeFormSurfaceSubmission(surface, submission as SessionFormComposerSubmission);
  }
  if (surface.type === 'board') {
    return normalizeBoardSurfaceSubmission(surface, submission as SessionBoardComposerSubmission);
  }
  return normalizeTextSurfaceSubmission(surface, submission as SessionTextComposerSubmission);
}

function resolveIntentNow(now?: number) {
  return typeof now === 'number' && Number.isFinite(now) ? Math.round(now) : Date.now();
}

function resolveIntentRandom(random?: () => number) {
  const value = random ? random() : Math.random();
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function createIntentId(options: { now?: number; random?: () => number } = {}) {
  const now = resolveIntentNow(options.now);
  const randomSuffix = resolveIntentRandom(options.random).toString(36).slice(2, 8).padEnd(6, '0');
  return `intent_${now}_${randomSuffix}`;
}

export function attachIntentMetadata(
  result: SessionNormalizedIntentResult,
  surface: SessionInputSurfaceDefinition,
  options: { now?: number; random?: () => number } = {},
) {
  return {
    intent: {
      ...result.intent,
      payload: {
        ...result.intent.payload,
        intentId: createIntentId(options),
        surfaceType: surface.type,
      },
    },
  } satisfies SessionNormalizedIntentResult;
}

export function normalizeSurfaceSubmissionWithMetadata(
  surface: SessionInputSurfaceDefinition,
  submission: SessionTextComposerSubmission | SessionFormComposerSubmission | SessionBoardComposerSubmission,
  options: { now?: number; random?: () => number } = {},
) {
  return attachIntentMetadata(normalizeSurfaceSubmission(surface, submission), surface, options);
}

export function buildDefaultFormSurface(actionType: string, fields: SessionInputField[], label = 'Action Form'): SessionInputSurfaceDefinition {
  return {
    key: `${actionType}-form`,
    type: 'form',
    label,
    fields,
  };
}

export function buildDefaultBoardSurface(label = 'Board'): SessionInputSurfaceDefinition {
  return {
    key: 'board-surface',
    type: 'board',
    label,
  };
}

export function buildHybridSurface(label = 'Hybrid', fields: SessionInputField[] = []): SessionInputSurfaceDefinition {
  return {
    key: 'hybrid-surface',
    type: 'hybrid',
    label,
    fields,
  };
}

export function deriveSurfaceProfileSurfaces(profile: SessionSurfaceProfile): SessionInputSurfaceDefinition[] {
  if (profile === 'form') return [buildDefaultFormSurface('default', [], 'Form')];
  if (profile === 'board') return [buildDefaultBoardSurface(), createDefaultTextInputSurface({ key: 'board-chat', label: 'Chat' })];
  if (profile === 'hybrid') return [createDefaultTextInputSurface({ key: 'hybrid-text', label: 'Chat' }), buildHybridSurface('Actions')];
  if (profile === 'timeline') return [createDefaultTextInputSurface({ key: 'timeline-text', label: 'Story' }), buildHybridSurface('Branches')];
  if (profile === 'dashboard') return [createDefaultTextInputSurface({ key: 'dashboard-text', label: 'Workflow' }), buildDefaultFormSurface('dashboard-action', [], 'Tasks')];
  return [createDefaultTextInputSurface()];
}

export function coerceSurfaceProfileSurfaces(conversation: GroupChat) {
  return deriveSurfaceProfileSurfaces(resolveSessionDefinition(conversation).kind.surfaceProfile);
}

export function buildIntentMetadataPatch(intent: SessionIntent, channelId = 'public') {
  return {
    causedByIntentId: typeof intent.payload.intentId === 'string' ? intent.payload.intentId : undefined,
    channelId,
  };
}

export function inferIntentChannelId(conversation: GroupChat, intent: SessionIntent) {
  if (intent.channelId) return intent.channelId;
  if (conversation.type === 'ai_direct') return 'pair-private';
  if (conversation.type === 'direct') return 'user-private';
  if (resolveSessionDefinition(conversation).kind.family === 'interview' && intent.type !== 'message_intent') return 'moderator';
  return 'public';
}

export function inferIntentEventClass(intent: SessionIntent): 'message' | 'action' | 'board' | 'phase' | 'score' | 'artifact' {
  if (intent.type === 'board_intent') return 'board';
  if (intent.type === 'form_intent' || intent.type === 'action_intent') return 'action';
  if (intent.type === 'system_intent') return 'phase';
  return 'message';
}

export function buildIntentRuntimeMetadata(conversation: GroupChat, intent: SessionIntent) {
  return {
    channelId: inferIntentChannelId(conversation, intent),
    causedByIntentId: typeof intent.payload.intentId === 'string' ? intent.payload.intentId : undefined,
    eventClass: inferIntentEventClass(intent),
  };
}

export function buildDefaultActionIntent(actionType: string, fields: Record<string, unknown>, actorId?: string): SessionIntent {
  return {
    type: 'action_intent',
    actorId,
    payload: {
      actionType,
      fields,
      intentId: createIntentId(),
    },
  };
}

export function buildDefaultBoardIntent(payload: SessionBoardComposerSubmission): SessionIntent {
  return {
    type: 'board_intent',
    actorId: payload.actorId,
    payload: {
      ...payload,
      intentId: createIntentId(),
    },
  };
}

export function buildDefaultMessageIntent(content: string, actorId?: string): SessionIntent {
  return {
    type: 'message_intent',
    actorId,
    payload: {
      content,
      intentId: createIntentId(),
    },
  };
}

export function buildDefaultSystemIntent(reason: string, actorId?: string): SessionIntent {
  return {
    type: 'system_intent',
    actorId,
    payload: {
      reason,
      intentId: createIntentId(),
    },
  };
}

export function buildActionFieldsFromSchema(fields: SessionActionField[] = []): SessionInputField[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    placeholder: field.placeholder,
  }));
}

export function buildSurfaceFromAction(action: SessionActionDefinition): SessionInputSurfaceDefinition {
  return buildDefaultFormSurface(action.type, buildActionFieldsFromSchema(action.fields || []), action.label || action.type);
}

export function buildSurfacesFromActionSchema(schema: SessionActionSchema | null): SessionInputSurfaceDefinition[] {
  if (!schema) return [];
  return schema.actions.map((action) => buildSurfaceFromAction(action));
}

export function mergeSessionSurfaces(primary: SessionInputSurfaceDefinition[], secondary: SessionInputSurfaceDefinition[]) {
  const merged = [...primary];
  for (const surface of secondary) {
    if (!merged.find((item) => item.key === surface.key)) merged.push(surface);
  }
  return merged;
}

export function resolveSessionComposerSurfaces(conversation: GroupChat, schema: SessionActionSchema | null): SessionInputSurfaceDefinition[] {
  const base = defaultInputSurfacesForConversation(conversation);
  const actionSurfaces = buildSurfacesFromActionSchema(schema).filter((surface) => {
    if (conversation.type !== 'group') return true;
    return surface.key !== 'start_private_thread-form';
  });
  return mergeSessionSurfaces(base, actionSurfaces);
}

export function buildSurfaceProjectionFromSchema(conversation: GroupChat, schema: SessionActionSchema | null): SessionSurfaceProjection {
  return {
    surfaces: resolveSessionComposerSurfaces(conversation, schema),
  };
}

export function hasInteractiveSurface(surface: SessionInputSurfaceDefinition) {
  return surface.type === 'form' || surface.type === 'board' || surface.type === 'hybrid';
}

export function splitPrimaryAndSecondarySurfaces(surfaces: SessionInputSurfaceDefinition[]) {
  return {
    primary: surfaces.filter((surface) => surface.type === 'text'),
    secondary: surfaces.filter((surface) => hasInteractiveSurface(surface)),
  };
}

export function resolvePrimarySurface(surfaces: SessionInputSurfaceDefinition[]) {
  return surfaces.find((surface) => surface.type === 'text') || surfaces[0] || null;
}

export function resolveSecondarySurfaces(surfaces: SessionInputSurfaceDefinition[]) {
  return surfaces.filter((surface) => surface !== resolvePrimarySurface(surfaces));
}

export function buildActionPayloadFromIntent(intent: SessionIntent) {
  return typeof intent.payload.fields === 'object' && intent.payload.fields ? intent.payload.fields as Record<string, unknown> : {};
}

export function buildMessageContentFromIntent(intent: SessionIntent) {
  return typeof intent.payload.content === 'string' ? intent.payload.content : '';
}

export function buildBoardPayloadFromIntent(intent: SessionIntent): SessionBoardComposerSubmission {
  return {
    position: typeof intent.payload.position === 'string' ? intent.payload.position : undefined,
    pieceId: typeof intent.payload.pieceId === 'string' ? intent.payload.pieceId : undefined,
    move: typeof intent.payload.move === 'string' ? intent.payload.move : undefined,
    actorId: intent.actorId,
  };
}

export function buildActionTypeFromIntent(intent: SessionIntent) {
  return typeof intent.payload.actionType === 'string' ? intent.payload.actionType : undefined;
}

export function buildSurfaceKeyFromIntent(intent: SessionIntent) {
  return typeof intent.payload.surfaceKey === 'string' ? intent.payload.surfaceKey : undefined;
}

export function isMessageIntent(intent: SessionIntent) {
  return intent.type === 'message_intent';
}

export function isActionIntent(intent: SessionIntent) {
  return intent.type === 'action_intent' || intent.type === 'form_intent';
}

export function isBoardIntent(intent: SessionIntent) {
  return intent.type === 'board_intent';
}

export function isSystemIntent(intent: SessionIntent) {
  return intent.type === 'system_intent';
}

export function resolveIntentActionDefinition(schema: SessionActionSchema | null, intent: SessionIntent) {
  const actionType = buildActionTypeFromIntent(intent) || buildSurfaceKeyFromIntent(intent)?.replace(/-form$/, '');
  return schema?.actions.find((action) => action.type === actionType) || null;
}

export function buildActionFromIntent(schema: SessionActionSchema | null, intent: SessionIntent): SessionActionDefinition | null {
  const matched = resolveIntentActionDefinition(schema, intent);
  if (!matched) return null;
  return {
    ...matched,
    actorId: intent.actorId || matched.actorId,
    payload: buildActionPayloadFromIntent(intent),
  };
}

export function createBoardStateArtifactSummary(payload: SessionBoardComposerSubmission) {
  return payload.move || payload.position || payload.pieceId || 'board update';
}

export function buildBoardArtifactEventSummary(intent: SessionIntent) {
  return createBoardStateArtifactSummary(buildBoardPayloadFromIntent(intent));
}

export function buildSystemIntentSummary(intent: SessionIntent) {
  return typeof intent.payload.reason === 'string' ? intent.payload.reason : 'system update';
}

export function buildIntentSummary(intent: SessionIntent) {
  if (isMessageIntent(intent)) return buildMessageContentFromIntent(intent);
  if (isBoardIntent(intent)) return buildBoardArtifactEventSummary(intent);
  if (isSystemIntent(intent)) return buildSystemIntentSummary(intent);
  return buildActionTypeFromIntent(intent) || 'action';
}

export function buildSurfaceCapabilityLabel(surface: SessionInputSurfaceDefinition) {
  return surface.capability || (surface.type === 'text' ? 'guide' : 'moderate');
}

export function buildIntentCapability(surface: SessionInputSurfaceDefinition) {
  return buildSurfaceCapabilityLabel(surface);
}

export function deriveActionTypeFromSurface(surface: SessionInputSurfaceDefinition) {
  return surface.key.replace(/-form$/, '');
}

export function ensureSurfaceActionType(surface: SessionInputSurfaceDefinition, intent: SessionIntent) {
  if (!isActionIntent(intent)) return intent;
  return {
    ...intent,
    payload: {
      ...intent.payload,
      actionType: buildActionTypeFromIntent(intent) || deriveActionTypeFromSurface(surface),
    },
  };
}

export function normalizeSurfaceSubmissionToIntent(surface: SessionInputSurfaceDefinition, submission: SessionTextComposerSubmission | SessionFormComposerSubmission | SessionBoardComposerSubmission) {
  return ensureSurfaceActionType(surface, normalizeSurfaceSubmissionWithMetadata(surface, submission).intent);
}

export function buildNormalizedIntentResult(surface: SessionInputSurfaceDefinition, submission: SessionTextComposerSubmission | SessionFormComposerSubmission | SessionBoardComposerSubmission): SessionNormalizedIntentResult {
  return {
    intent: normalizeSurfaceSubmissionToIntent(surface, submission),
  };
}

export function buildSessionSurfaceProjectionFromSchema(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSurfaceProjectionFromSchema(conversation, schema);
}

export function buildIntentMetadataForEvent(conversation: GroupChat, intent: SessionIntent) {
  return buildIntentRuntimeMetadata(conversation, intent);
}

export function buildIntentMetadataForPatch(conversation: GroupChat, intent: SessionIntent) {
  return buildIntentRuntimeMetadata(conversation, intent);
}

export function deriveBoardChannelId(conversation: GroupChat) {
  return conversation.type === 'ai_direct' ? 'pair-private' : 'public';
}

export function buildBoardIntentRuntimeMetadata(conversation: GroupChat, intent: SessionIntent) {
  return {
    ...buildIntentRuntimeMetadata(conversation, intent),
    channelId: deriveBoardChannelId(conversation),
  };
}

export function buildFormIntentRuntimeMetadata(conversation: GroupChat, intent: SessionIntent) {
  return buildIntentRuntimeMetadata(conversation, intent);
}

export function buildMessageIntentRuntimeMetadata(conversation: GroupChat, intent: SessionIntent) {
  return buildIntentRuntimeMetadata(conversation, intent);
}

export function buildSystemIntentRuntimeMetadata(conversation: GroupChat, intent: SessionIntent) {
  return buildIntentRuntimeMetadata(conversation, intent);
}

export function buildIntentRuntimeMetadataByType(conversation: GroupChat, intent: SessionIntent) {
  if (isBoardIntent(intent)) return buildBoardIntentRuntimeMetadata(conversation, intent);
  if (isActionIntent(intent)) return buildFormIntentRuntimeMetadata(conversation, intent);
  if (isSystemIntent(intent)) return buildSystemIntentRuntimeMetadata(conversation, intent);
  return buildMessageIntentRuntimeMetadata(conversation, intent);
}

export function buildIntentDrivenActionSchema(schema: SessionActionSchema | null) {
  return schema;
}

export function buildIntentDrivenSurfaceProjection(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSurfaceProjectionFromSchema(conversation, buildIntentDrivenActionSchema(schema));
}

export function buildIntentDrivenSurfaces(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildIntentDrivenSurfaceProjection(conversation, schema).surfaces;
}

export function buildDefaultInteractiveSurfaces(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildIntentDrivenSurfaces(conversation, schema);
}

export function buildDefaultComposerSurface(conversation: GroupChat, schema: SessionActionSchema | null) {
  return resolvePrimarySurface(buildDefaultInteractiveSurfaces(conversation, schema));
}

export function buildDefaultSecondarySurfaces(conversation: GroupChat, schema: SessionActionSchema | null) {
  return resolveSecondarySurfaces(buildDefaultInteractiveSurfaces(conversation, schema));
}

export function hasBoardSurface(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildDefaultInteractiveSurfaces(conversation, schema).some((surface) => surface.type === 'board');
}

export function hasFormSurface(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildDefaultInteractiveSurfaces(conversation, schema).some((surface) => surface.type === 'form' || surface.type === 'hybrid');
}

export function buildActionIntentForSurface(surface: SessionInputSurfaceDefinition, fields: Record<string, unknown>, actorId?: string) {
  return normalizeSurfaceSubmissionToIntent(surface, { fields, actorId } satisfies SessionFormComposerSubmission);
}

export function buildBoardIntentForSurface(surface: SessionInputSurfaceDefinition, payload: SessionBoardComposerSubmission) {
  return normalizeSurfaceSubmissionToIntent(surface, payload);
}

export function buildMessageIntentForSurface(surface: SessionInputSurfaceDefinition, content: string, actorId?: string) {
  return normalizeSurfaceSubmissionToIntent(surface, { content, actorId } satisfies SessionTextComposerSubmission);
}

export function buildSessionIntentSummary(intent: SessionIntent) {
  return buildIntentSummary(intent);
}

export function buildSessionIntentMetadata(conversation: GroupChat, intent: SessionIntent) {
  return buildIntentRuntimeMetadataByType(conversation, intent);
}

export function createIntentEventPayload(conversation: GroupChat, intent: SessionIntent) {
  return {
    ...buildSessionIntentMetadata(conversation, intent),
    summary: buildSessionIntentSummary(intent),
  };
}

export function createIntentPatchPayload(conversation: GroupChat, intent: SessionIntent) {
  return buildSessionIntentMetadata(conversation, intent);
}

export function canIntentDriveAction(intent: SessionIntent) {
  return isActionIntent(intent) || isBoardIntent(intent) || isSystemIntent(intent);
}

export function canIntentDriveMessage(intent: SessionIntent) {
  return isMessageIntent(intent);
}

export function buildIntentSourceFields(intent: SessionIntent) {
  return typeof intent.payload.fields === 'object' && intent.payload.fields ? intent.payload.fields as Record<string, unknown> : {};
}

export function buildIntentSourceContent(intent: SessionIntent) {
  return buildMessageContentFromIntent(intent);
}

export function buildIntentSourceBoard(intent: SessionIntent) {
  return buildBoardPayloadFromIntent(intent);
}

export function buildIntentDriver(intent: SessionIntent) {
  return {
    actionType: buildActionTypeFromIntent(intent),
    content: buildIntentSourceContent(intent),
    board: buildIntentSourceBoard(intent),
    fields: buildIntentSourceFields(intent),
  };
}

export function buildIntentProjectionSummary(intent: SessionIntent) {
  return buildIntentSummary(intent);
}

export function buildSurfaceProjectionSummary(surface: SessionInputSurfaceDefinition) {
  return `${surface.key}:${surface.type}`;
}

export function buildSurfaceProjectionSummaries(surfaces: SessionInputSurfaceDefinition[]) {
  return surfaces.map((surface) => buildSurfaceProjectionSummary(surface));
}

export function buildSurfaceProjectionLabel(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSurfaceProjectionSummaries(buildDefaultInteractiveSurfaces(conversation, schema)).join(' / ');
}

export function buildIntentProjectionLabel(conversation: GroupChat, intent: SessionIntent) {
  return `${conversation.id}:${buildIntentSummary(intent)}`;
}

export function buildIntentSurfaceKey(intent: SessionIntent) {
  return buildSurfaceKeyFromIntent(intent) || 'unknown-surface';
}

export function buildIntentSurfaceType(intent: SessionIntent) {
  if (isBoardIntent(intent)) return 'board';
  if (isActionIntent(intent)) return 'form';
  return 'text';
}

export function buildIntentProjectionDescriptor(intent: SessionIntent) {
  return `${buildIntentSurfaceKey(intent)}:${buildIntentSurfaceType(intent)}`;
}

export function buildIntentProjectionDescriptors(intents: SessionIntent[]) {
  return intents.map((intent) => buildIntentProjectionDescriptor(intent));
}

export function buildIntentProjectionState(intents: SessionIntent[]) {
  return buildIntentProjectionDescriptors(intents);
}

export function buildIntentProjectionRows(intents: SessionIntent[]) {
  return buildIntentProjectionState(intents);
}

export function buildIntentProjectionText(intents: SessionIntent[]) {
  return buildIntentProjectionRows(intents).join(' / ');
}

export function buildSessionSurfaceText(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSurfaceProjectionLabel(conversation, schema);
}

export function buildSessionIntentText(intents: SessionIntent[]) {
  return buildIntentProjectionText(intents);
}

export function buildIntentTrace(conversation: GroupChat, intent: SessionIntent) {
  return `${conversation.id}:${buildIntentProjectionDescriptor(intent)}:${buildIntentSummary(intent)}`;
}

export function buildIntentTraces(conversation: GroupChat, intents: SessionIntent[]) {
  return intents.map((intent) => buildIntentTrace(conversation, intent));
}

export function buildIntentTraceText(conversation: GroupChat, intents: SessionIntent[]) {
  return buildIntentTraces(conversation, intents).join(' / ');
}

export function buildRuntimeIntentDescriptor(conversation: GroupChat, intent: SessionIntent) {
  return {
    trace: buildIntentTrace(conversation, intent),
    metadata: buildSessionIntentMetadata(conversation, intent),
  };
}

export function buildRuntimeIntentDescriptors(conversation: GroupChat, intents: SessionIntent[]) {
  return intents.map((intent) => buildRuntimeIntentDescriptor(conversation, intent));
}

export function buildRuntimeIntentTraceText(conversation: GroupChat, intents: SessionIntent[]) {
  return buildRuntimeIntentDescriptors(conversation, intents).map((item) => item.trace).join(' / ');
}

export function buildSessionSurfaceCapabilitySummary(surfaces: SessionInputSurfaceDefinition[]) {
  return surfaces.map((surface) => `${surface.key}:${buildSurfaceCapabilityLabel(surface)}`).join(' / ');
}

export function buildSessionIntentCapabilitySummary(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSessionSurfaceCapabilitySummary(buildDefaultInteractiveSurfaces(conversation, schema));
}

export function buildSurfaceProjectionStateLabel(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSessionIntentCapabilitySummary(conversation, schema);
}

export function buildSurfaceProjectionDisplayRows(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildDefaultInteractiveSurfaces(conversation, schema).map((surface) => ({ key: surface.key, label: surface.label || surface.key, value: `${surface.type}:${buildSurfaceCapabilityLabel(surface)}` }));
}

export function buildSurfaceProjectionDisplayText(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSurfaceProjectionDisplayRows(conversation, schema).map((row) => `${row.label} ${row.value}`).join(' / ');
}

export function buildComposerHostSurfaces(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildDefaultInteractiveSurfaces(conversation, schema);
}

export function buildComposerHostPrimarySurface(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildDefaultComposerSurface(conversation, schema);
}

export function buildComposerHostSecondarySurfaces(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildDefaultSecondarySurfaces(conversation, schema);
}

export function buildActionSurfaceFields(action: SessionActionDefinition) {
  return buildActionFieldsFromSchema(action.fields || []);
}

export function buildActionSurfaceDefinition(action: SessionActionDefinition) {
  return buildDefaultFormSurface(action.type, buildActionSurfaceFields(action), action.label || action.type);
}

export function buildActionSurfaceDefinitions(actions: SessionActionDefinition[]) {
  return actions.map((action) => buildActionSurfaceDefinition(action));
}

export function mergeActionSurfaceDefinitions(conversation: GroupChat, actions: SessionActionDefinition[]) {
  return mergeSessionSurfaces(defaultInputSurfacesForConversation(conversation), buildActionSurfaceDefinitions(actions));
}

export function buildSurfaceProjectionWithActions(conversation: GroupChat, actions: SessionActionDefinition[]) {
  return {
    surfaces: mergeActionSurfaceDefinitions(conversation, actions),
  };
}

export function buildActionSurfaceProjection(schema: SessionActionSchema | null) {
  return buildSurfacesFromActionSchema(schema);
}

export function buildConversationSurfaceProjection(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSurfaceProjectionWithActions(conversation, schema?.actions || []);
}

export function buildResolvedSurfaceProjection(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildConversationSurfaceProjection(conversation, schema);
}

export function buildResolvedSurfaceList(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildResolvedSurfaceProjection(conversation, schema).surfaces;
}

export function buildResolvedPrimarySurface(conversation: GroupChat, schema: SessionActionSchema | null) {
  return resolvePrimarySurface(buildResolvedSurfaceList(conversation, schema));
}

export function buildResolvedSecondarySurfaces(conversation: GroupChat, schema: SessionActionSchema | null) {
  return resolveSecondarySurfaces(buildResolvedSurfaceList(conversation, schema));
}

export function buildActionSurfaceSummary(actions: SessionActionDefinition[]) {
  return actions.map((action) => `${action.type}:${action.fields?.length || 0}`).join(' / ');
}

export function buildActionSchemaSummary(schema: SessionActionSchema | null) {
  return schema ? buildActionSurfaceSummary(schema.actions) : '';
}

export function buildResolvedSurfaceSummary(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSurfaceProjectionDisplayText(conversation, schema);
}

export function buildResolvedIntentSummary(conversation: GroupChat, intent: SessionIntent) {
  return buildIntentProjectionLabel(conversation, intent);
}

export function buildResolvedIntentMetadata(conversation: GroupChat, intent: SessionIntent) {
  return buildSessionIntentMetadata(conversation, intent);
}

export function buildResolvedIntentRuntime(conversation: GroupChat, intent: SessionIntent) {
  return {
    summary: buildResolvedIntentSummary(conversation, intent),
    metadata: buildResolvedIntentMetadata(conversation, intent),
  };
}

export function buildResolvedIntentRuntimeTrace(conversation: GroupChat, intent: SessionIntent) {
  return `${buildResolvedIntentSummary(conversation, intent)}:${JSON.stringify(buildResolvedIntentMetadata(conversation, intent))}`;
}

export function buildResolvedIntentRuntimeTraces(conversation: GroupChat, intents: SessionIntent[]) {
  return intents.map((intent) => buildResolvedIntentRuntimeTrace(conversation, intent));
}

export function buildResolvedIntentRuntimeText(conversation: GroupChat, intents: SessionIntent[]) {
  return buildResolvedIntentRuntimeTraces(conversation, intents).join(' / ');
}

export function buildResolvedSurfaceRuntimeText(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildResolvedSurfaceSummary(conversation, schema);
}

export function buildResolvedProjectionText(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return `${buildResolvedSurfaceRuntimeText(conversation, schema)} | ${buildResolvedIntentRuntimeText(conversation, intents)}`;
}

export function buildResolvedProjectionState(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return {
    surfaces: buildResolvedSurfaceList(conversation, schema),
    intents,
    text: buildResolvedProjectionText(conversation, schema, intents),
  };
}

export function buildResolvedProjectionStateText(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionState(conversation, schema, intents).text;
}

export function buildResolvedProjectionRows(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return {
    surfaces: buildResolvedSurfaceDisplayRows(conversation, schema),
    intents: intents.map((intent) => ({ key: buildIntentSurfaceKey(intent), label: buildIntentSurfaceType(intent), value: buildIntentSummary(intent) })),
  };
}

export function buildResolvedSurfaceDisplayRows(conversation: GroupChat, schema: SessionActionSchema | null) {
  return buildSurfaceProjectionDisplayRows(conversation, schema);
}

export function buildResolvedIntentDisplayRows(intents: SessionIntent[]) {
  return intents.map((intent, index) => ({ key: `${buildIntentSurfaceKey(intent)}-${index}`, label: buildIntentSurfaceType(intent), value: buildIntentSummary(intent) }));
}

export function buildResolvedProjectionDisplayRows(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return {
    surfaces: buildResolvedSurfaceDisplayRows(conversation, schema),
    intents: buildResolvedIntentDisplayRows(intents),
  };
}

export function buildResolvedProjectionDisplayText(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  const rows = buildResolvedProjectionDisplayRows(conversation, schema, intents);
  return [...rows.surfaces, ...rows.intents].map((row) => `${row.label} ${row.value}`).join(' / ');
}

export function buildResolvedProjectionRuntimeLabel(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionDisplayText(conversation, schema, intents);
}

export function buildResolvedProjectionRuntimeState(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return {
    label: buildResolvedProjectionRuntimeLabel(conversation, schema, intents),
    surfaces: buildResolvedSurfaceList(conversation, schema),
    intents,
  };
}

export function buildResolvedProjectionRuntimeStateText(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeState(conversation, schema, intents).label;
}

export function buildResolvedProjectionRuntimeRows(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionDisplayRows(conversation, schema, intents);
}

export function buildResolvedProjectionRuntimeSummary(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeStateText(conversation, schema, intents);
}

export function buildResolvedProjectionRuntimeDescriptor(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return {
    summary: buildResolvedProjectionRuntimeSummary(conversation, schema, intents),
    rows: buildResolvedProjectionRuntimeRows(conversation, schema, intents),
  };
}

export function buildResolvedProjectionRuntimeDescriptors(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeDescriptor(conversation, schema, intents);
}

export function buildResolvedProjectionRuntimeDisplay(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeDescriptors(conversation, schema, intents);
}

export function buildResolvedProjectionRuntimeDisplayText(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeDisplay(conversation, schema, intents).summary;
}

export function buildResolvedProjectionRuntimeDisplayRows(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeDisplay(conversation, schema, intents).rows;
}

export function buildResolvedProjectionRuntimeCard(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return {
    title: 'Projection',
    summary: buildResolvedProjectionRuntimeDisplayText(conversation, schema, intents),
    rows: buildResolvedProjectionRuntimeDisplayRows(conversation, schema, intents),
  };
}

export function buildResolvedProjectionRuntimeCardText(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeCard(conversation, schema, intents).summary;
}

export function buildResolvedProjectionRuntimeCardRows(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeCard(conversation, schema, intents).rows;
}

export function buildResolvedProjectionRuntimeCardTitle() {
  return 'Projection';
}

export function buildResolvedProjectionRuntimeCardDescriptor(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return {
    title: buildResolvedProjectionRuntimeCardTitle(),
    summary: buildResolvedProjectionRuntimeCardText(conversation, schema, intents),
    rows: buildResolvedProjectionRuntimeCardRows(conversation, schema, intents),
  };
}

export function buildResolvedProjectionRuntimeCardDescriptors(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeCardDescriptor(conversation, schema, intents);
}

export function buildResolvedProjectionRuntimeCardDisplay(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeCardDescriptors(conversation, schema, intents);
}

export function buildResolvedProjectionRuntimeCardDisplayText(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeCardDisplay(conversation, schema, intents).summary;
}

export function buildResolvedProjectionRuntimeCardDisplayRows(conversation: GroupChat, schema: SessionActionSchema | null, intents: SessionIntent[]) {
  return buildResolvedProjectionRuntimeCardDisplay(conversation, schema, intents).rows;
}

export function buildResolvedProjectionRuntimeCardDisplayTitle() {
  return 'Projection';
}

export function defaultInputSurfacesForConversation(conversation: GroupChat): SessionInputSurfaceDefinition[] {
  const definition = resolveSessionDefinition(conversation);
  const userIsMember = conversation.memberIds.includes('user');
  const textCapability: SessionViewerCapability = conversation.type === 'assistant' || conversation.type === 'direct' || conversation.type === 'ai_direct' || userIsMember ? 'speak' : 'guide';
  const textMode: SessionInputSurfaceDefinition['mode'] = textCapability === 'speak' ? 'memberSpeak' : 'guide';
  if (definition.kind.surfaceProfile === 'form') {
    return [createDefaultTextInputSurface({ key: 'fallback-text', label: 'Text fallback', capability: textCapability, mode: textMode })];
  }
  if (definition.kind.surfaceProfile === 'hybrid') {
    return [
      createDefaultTextInputSurface({ key: 'hybrid-text', label: 'Chat', capability: textCapability, mode: textMode }),
      { key: 'hybrid-actions', type: 'form', label: 'Actions' },
    ];
  }
  if (definition.kind.surfaceProfile === 'board') {
    return [
      { key: 'board-surface', type: 'board', label: 'Board' },
      createDefaultTextInputSurface({ key: 'board-chat', label: 'Chat', capability: textCapability, mode: textMode }),
    ];
  }
  return [createDefaultTextInputSurface({ capability: textCapability, mode: textMode })];
}

export function defaultTopologySummary(conversation: GroupChat): SessionTopologySummary {
  const definition = resolveSessionDefinition(conversation);
  return {
    topology: definition.kind.topology,
    description: `${definition.kind.topology}:${definition.kind.family}:${definition.kind.scenarioId}`,
  };
}

export function supportsBoardSurface(conversation: GroupChat) {
  return resolveSessionDefinition(conversation).kind.surfaceProfile === 'board';
}

export function supportsHybridSurface(conversation: GroupChat) {
  return resolveSessionDefinition(conversation).kind.surfaceProfile === 'hybrid';
}

export function deriveSessionMemoryLayerSummary(conversation: GroupChat): SessionMemoryLayerSummary {
  return {
    characterCore: true,
    relationship: true,
    conversation: true,
    scenario: conversation.mode !== 'open_chat',
  };
}

export function buildDefaultScenarioPackage(conversation: GroupChat): SessionScenarioPackage {
  const definition = resolveSessionDefinition(conversation);
  return {
    scenarioId: definition.kind.scenarioId,
    label: definition.scenario.label,
    board: definition.kind.family === 'board_game' ? { kind: 'grid', columns: 8, rows: 8 } : null,
  };
}

export function buildDefaultSessionSurfaceProjection(conversation: GroupChat): SessionSurfaceProjection {
  return {
    surfaces: defaultInputSurfacesForConversation(conversation),
  };
}

export function deriveDefaultTurnOrder(actorIds: string[]): SessionTurnOrderState {
  return { actorIds, currentIndex: 0 };
}

export function createBoardIntentPayload(position: string, pieceId?: string): SessionBoardIntentPayload {
  return { position, pieceId };
}

export function createFormIntentPayload(fields: Record<string, unknown>): SessionFormIntentPayload {
  return { fields };
}

export function defaultJudgeAgent(enabled = false): SessionJudgeAgentDefinition {
  return { enabled, style: 'assistive' };
}

export function allowRefereeDecision(): SessionRefereeDecision {
  return { allowed: true };
}

export function denyRefereeDecision(reason: string): SessionRefereeDecision {
  return { allowed: false, reason };
}

export function buildSessionGrowthSnapshot(actorId: string, conversationSummary?: string, persistentSummary?: string): SessionGrowthSnapshot {
  return { actorId, conversationSummary, persistentSummary };
}

export function buildSessionRoleMemorySummary(actorId: string, roleId?: string | null, summary?: string): SessionRoleMemorySummary {
  return { actorId, roleId, summary };
}

export function buildSessionScenarioMemorySummary(conversationId: string, summary?: string): SessionScenarioMemorySummary {
  return { conversationId, summary };
}

export function buildSessionFactionDefinition(factionId: string, label: string): SessionFactionDefinition {
  return { factionId, label };
}

export function buildSessionLayoutSlot(slotId: string, x: number, y: number, actorId?: string | null): SessionLayoutSlot {
  return { slotId, x, y, actorId };
}

export interface SessionPhaseDefinition {
  key: string;
  label: string;
  allowedActions: string[];
  hiddenInfo?: boolean;
}

export interface SessionActionField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'single_select' | 'number' | 'multi_select';
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  targetSource?: 'participants';
}

export interface SessionActionDefinition {
  type: string;
  label?: string;
  description?: string;
  actorId?: string;
  targetIds?: string[];
  payload?: Record<string, unknown>;
  visibility?: VisibilityScope;
  fields?: SessionActionField[];
  autoRun?: boolean;
}

export interface SessionActionSchema {
  title: string;
  actions: SessionActionDefinition[];
}

export interface SessionActionExecutionResult {
  chatPatch?: Partial<GroupChat>;
  runtimeEvents?: Array<{
    eventType: string;
    title: string;
    summary: string;
    pair?: [string, string];
    metrics?: unknown;
    channelId?: string;
    causedByIntentId?: string;
    threadRef?: string;
    eventClass?: 'message' | 'action' | 'board' | 'phase' | 'score' | 'artifact';
    visibilityScope?: VisibilityScope;
    visibleToIds?: string[];
    visibleToRoles?: string[];
  }>;
}

export interface SessionProjectionContext {
  conversation: GroupChat;
  participants: ParticipantInstance[];
  viewerId?: string | null;
  viewerRole?: string | null;
  conversationType?: GroupChat['type'];
}

export interface SessionViewProjection {
  visiblePanels: RuntimePanelDefinition[];
  availableActions: RuntimeAction[];
}

export interface SessionCommitContext {
  conversation: GroupChat;
  characters: AICharacter[];
  message: import('./chat').OpenChatCommittedMessage;
  previousAiMessage?: Pick<Message, 'senderId'> | null;
  recentMessages?: Message[];
  apiConfig?: APIConfig;
}

export interface SessionGenerationContext {
  conversation: GroupChat;
  characters: AICharacter[];
  messages: Message[];
}

export type SessionMoveClass = 'respond' | 'advance' | 'expand' | 'deepen' | 'challenge' | 'repair' | 'stabilize' | 'resolve' | 'perform';
export type SessionTargetScope = 'person' | 'topic' | 'room' | 'scene' | 'task';
export type SessionDepth = 'brief' | 'normal' | 'deep';
export type SessionSurface = 'casual' | 'analytical' | 'companion' | 'dramatic' | 'task';
export type SessionHumanAppraisalMoveBias = 'none' | 'ask_followup' | 'repair' | 'protect' | 'insist' | 'withdraw' | 'soften' | 'challenge' | 'let_pass';

export interface SessionHumanAppraisalPatch {
  moveBias: SessionHumanAppraisalMoveBias;
  expressionBias?: {
    warmth?: 'up' | 'down';
    directness?: 'up' | 'down';
    restraint?: 'up' | 'down';
    length?: 'shorter' | 'normal';
  };
  strength: 'none' | 'low' | 'medium';
  publicSafe: boolean;
  reasonTags: string[];
  sourceEventIds: string[];
  hiddenHint?: string | null;
}

export interface SessionTurnPlan {
  speakerId: string;
  obligation: 'must' | 'should' | 'can' | 'skip';
  moveClass: SessionMoveClass;
  targetScope: SessionTargetScope;
  targetIds?: string[];
  depth: SessionDepth;
  channelId?: string | null;
  reason: string;
}

export interface SessionExpressionPlan {
  surface: SessionSurface;
  emotionalPosture?: 'warm' | 'defensive' | 'cold' | 'playful' | 'tense';
  texture?: 'terse' | 'ordinary' | 'rich';
  rhythm?: 'one_shot' | 'back_and_forth' | 'branching' | 'scene_beat';
  allowMarkdown?: boolean;
}

export interface SessionExecutionTrace {
  policyHits?: string[];
  memoryInfluence?: string[];
  scenarioChecks?: string[];
  duplicateDecision?: string | null;
  guidanceValidation?: string | null;
  mediaDecisionReason?: string | null;
  functionTag?: string | null;
  roleConstraint?: string | null;
  hotspotState?: 'clear' | 'warm' | 'hot' | null;
  humanAppraisal?: SessionHumanAppraisalPatch | null;
}

export interface SessionGenerationPromptContext {
  promptPrefix?: string;
  promptSuffix?: string;
  additionalConstraints?: string[];
  responseStyle?: 'chat' | 'professional' | 'creative' | 'longform';
  allowMarkdown?: boolean;
  styleProfile?: string;
}

export interface SessionRealizationPlan {
  moveClass: SessionMoveClass;
  targetScope: SessionTargetScope;
  targetIds?: string[];
  noveltyGoal?: 'none' | 'new_example' | 'new_angle' | 'new_evidence' | 'repair' | 'resolve';
  emotionalPosture?: 'warm' | 'defensive' | 'cold' | 'playful' | 'tense';
  surfaceDepth?: SessionDepth;
  functionTag?: 'answer' | 'add_angle' | 'comfort' | 'challenge' | 'summarize' | 'advance';
  roleConstraint?: string;
}

export interface SessionValidationDecision {
  allowed: boolean;
  reason?: string | null;
}

export interface SessionGenerationRuntimeBundle {
  turnPlan?: SessionTurnPlan;
  expressionPlan?: SessionExpressionPlan;
  realizationPlan?: SessionRealizationPlan;
  validationDecision?: SessionValidationDecision;
  trace?: SessionExecutionTrace;
}

export interface SessionDuplicateValidationContext {
  content: string;
  speakerId: string;
  recentMessages: Message[];
  styleProfile?: string | null;
  scenarioId?: string | null;
  channelType?: GroupChat['type'];
}

export interface SessionDuplicateValidator {
  key: string;
  validate: (context: SessionDuplicateValidationContext) => SessionValidationDecision;
}

export interface SessionRuntimeContextBundle {
  turnPlan?: SessionTurnPlan;
  expressionPlan?: SessionExpressionPlan;
  realizationPlan?: SessionRealizationPlan;
  trace?: SessionExecutionTrace;
}

export interface SessionEngineDefinition {
  key: string;
  createInitialConfig: () => unknown;
  createInitialState: (config: unknown) => unknown;
  buildParticipants: (conversation: GroupChat) => ParticipantInstance[];
  buildChatPatch?: (conversation: GroupChat) => Partial<GroupChat>;
  getPhaseDefinitions?: (conversation: GroupChat) => SessionPhaseDefinition[];
  getVisiblePanels: (context: SessionProjectionContext) => RuntimePanelDefinition[];
  getAvailableActions: (context: SessionProjectionContext) => RuntimeAction[];
  getActionSchema?: (context: SessionEngineActionContext) => SessionActionSchema | null;
  buildGenerationPromptContext?: (context: SessionGenerationContext & { speaker: AICharacter }) => SessionGenerationPromptContext;
  resolveTurnPolicy?: (context: SessionGenerationContext) => SessionTurnPolicy;
  buildRuntimeContextBundle?: (context: SessionGenerationContext & { speaker: AICharacter }) => SessionRuntimeContextBundle | null;
  buildNarrativeTurnMetadata?: (context: SessionGenerationContext & { speaker: AICharacter; content: string; blocks?: NarrativeBlock[] | null }) => NonNullable<Message['metadata']>['narrativeTurn'] | null;
  onMessageCommitted: (context: SessionCommitContext) => Promise<{
  chatPatch: Partial<GroupChat>;
  characterPatches: Array<{ characterId: string; patch: Partial<AICharacter> }>;
  runtimeEvents: Array<{ eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown }>;
}> | {
  chatPatch: Partial<GroupChat>;
  characterPatches: Array<{ characterId: string; patch: Partial<AICharacter> }>;
  runtimeEvents: Array<{ eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown }>;
};
}

export function mergeSessionChatPatch(engine: SessionEngineDefinition, conversation: GroupChat, patch: Partial<GroupChat> = {}): Partial<GroupChat> {
  const basePatch = engine.buildChatPatch?.(conversation) || {};
  const mergedPatch: Partial<GroupChat> = { ...patch };
  const frameworkKeys: Array<keyof GroupChat> = [
    'sessionKind',
    'scenarioPackage',
    'scenarioState',
    'channels',
    'layoutState',
    'judgeAgent',
    'modeStateSummary',
    'memoryLayerSummary',
    'growthSnapshots',
    'roleMemorySummaries',
    'scenarioMemorySummary',
    'topologySummary',
  ];

  frameworkKeys.forEach((key) => {
    if (key in mergedPatch) return;
    if (conversation[key] !== undefined && conversation[key] !== null) return;
    const value = basePatch[key];
    if (value !== undefined && value !== null) {
      (mergedPatch as Record<string, unknown>)[key] = value;
    }
  });

  return mergedPatch;
}

export function createDefaultConversationFrameworkPatch(conversation: GroupChat): Partial<GroupChat> {
  const kind = resolveSessionDefinition(conversation).kind;
  return {
    sessionKind: kind,
    scenarioPackage: { scenarioId: kind.scenarioId, label: conversation.scenarioPackage?.label || kind.scenarioId },
    scenarioState: conversation.scenarioState || {
      turnOrder: conversation.memberIds,
      currentTurnActorId: null,
      board: kind.surfaceProfile === 'board' ? { schema: { kind: 'grid', columns: 8, rows: 8 }, pieces: [] } : null,
      factions: [],
      seats: conversation.memberIds.map((memberId, index) => ({ seatId: `seat-${index + 1}`, seatIndex: index, actorId: memberId })),
      roleAssignments: [],
    },
    channels: conversation.channels || [{ channelId: 'public', visibility: 'public', label: 'Public' }],
    layoutState: conversation.layoutState || { slots: conversation.memberIds.map((memberId, index) => ({ slotId: `slot-${index + 1}`, x: index, y: 0, actorId: memberId })) },
    judgeAgent: conversation.judgeAgent || { enabled: false, style: 'assistive' },
    modeStateSummary: conversation.modeStateSummary || { family: kind.family, scenarioId: kind.scenarioId },
    memoryLayerSummary: conversation.memoryLayerSummary || deriveSessionMemoryLayerSummary(conversation),
    growthSnapshots: conversation.growthSnapshots || conversation.memberIds.map((memberId) => ({ actorId: memberId, conversationSummary: '参与当前会话' })),
    roleMemorySummaries: conversation.roleMemorySummaries || [],
    scenarioMemorySummary: conversation.scenarioMemorySummary || { conversationId: conversation.id, summary: kind.family === 'conversation' ? '当前会话按通用对话场景运行。' : '' },
    topologySummary: conversation.topologySummary || defaultTopologySummary(conversation),
  };
}

export function buildConversationParticipantLabel(conversation: GroupChat['type']) {
  return conversation === 'group' ? 'participant' : conversation === 'ai_direct' ? 'pair_private' : 'user_private';
}

type InferredSystemAgentSubtype = 'topic_guide' | 'host' | 'game_master' | 'narrator' | 'director' | 'moderator' | 'orchestrator';

function inferSystemAgentSubtypeFromMemberId(id: string): InferredSystemAgentSubtype | null {
  const normalized = id.trim().toLowerCase();
  if (!normalized) return null;
  if (/(^|[_:-])(gm|game|game_master|judge|referee)($|[_:-])/.test(normalized)) return 'game_master';
  if (/(^|[_:-])(host|mc|主持)($|[_:-])/.test(normalized)) return 'host';
  if (/(^|[_:-])(guide|guidance|topic|facilitator|引导)($|[_:-])/.test(normalized)) return 'topic_guide';
  if (/(^|[_:-])(narrator|旁白)($|[_:-])/.test(normalized)) return 'narrator';
  if (/(^|[_:-])(director|god|上帝|导演)($|[_:-])/.test(normalized)) return 'director';
  if (/(^|[_:-])(moderator|mod|管理)($|[_:-])/.test(normalized)) return 'moderator';
  if (/(^|[_:-])(system|orchestrator|scheduler|runtime)($|[_:-])/.test(normalized)) return 'orchestrator';
  return null;
}

function inferParticipantEntityType(memberId: string): 'ai' | 'user' | 'system_agent' {
  if (memberId === 'user') return 'user';
  if (inferSystemAgentSubtypeFromMemberId(memberId)) return 'system_agent';
  return 'ai';
}

function buildSystemAgentDisplayName(subtype: InferredSystemAgentSubtype | null) {
  if (subtype === 'topic_guide') return '引导者';
  if (subtype === 'host') return '主持人';
  if (subtype === 'game_master') return '裁判/GM';
  if (subtype === 'narrator') return '旁白';
  if (subtype === 'director') return '导演/上帝';
  if (subtype === 'moderator') return '管理者';
  if (subtype === 'orchestrator') return '系统编排';
  return '系统';
}

function buildParticipantCapabilities(entityType: 'ai' | 'user' | 'system_agent', subtype: InferredSystemAgentSubtype | null) {
  if (entityType === 'ai' || entityType === 'user') return ['speak'];
  if (subtype === 'topic_guide') return ['guide'];
  if (subtype === 'host' || subtype === 'moderator') return ['moderate'];
  if (subtype === 'game_master') return ['judge', 'moderate'];
  if (subtype === 'narrator') return ['observe'];
  if (subtype === 'director') return ['guide', 'moderate'];
  return ['observe'];
}

export function createDefaultConversationParticipants(conversation: GroupChat): ParticipantInstance[] {
  const orderedIds = Array.from(new Set([...(conversation.memberIds || []), ...(conversation.operatorIds || [])]));
  return orderedIds.map((memberId, index) => {
    const entityType = inferParticipantEntityType(memberId);
    const systemAgentSubtype = entityType === 'system_agent' ? inferSystemAgentSubtypeFromMemberId(memberId) : null;
    const capabilities = buildParticipantCapabilities(entityType, systemAgentSubtype);
    const isMember = conversation.memberIds.includes(memberId);
    const seat = isMember ? conversation.scenarioState?.seats?.find((item) => item.actorId === memberId) : undefined;
    const roleKey = entityType === 'user'
      ? 'user_persona'
      : entityType === 'system_agent'
        ? systemAgentSubtype || 'system_agent'
        : conversation.type === 'ai_direct'
          ? 'private_party'
          : conversation.type === 'direct'
            ? 'direct_partner'
            : 'participant';
    return {
      participantId: `${conversation.id}:${memberId}`,
      conversationId: conversation.id,
      entityType,
      entityRefId: memberId,
      seatIndex: isMember
        ? (seat?.seatIndex ?? index)
        : undefined,
      displayName: entityType === 'user' ? '我' : entityType === 'system_agent' ? buildSystemAgentDisplayName(systemAgentSubtype) : undefined,
      muted: canUseMute(conversation) ? seat?.muted === true : false,
      canSpeak: canUseMute(conversation) && (seat?.muted === true || seat?.canSpeak === false)
        ? false
        : capabilities.includes('speak') || capabilities.includes('guide') || capabilities.includes('moderate') || capabilities.includes('judge'),
      canAct: true,
      roleKey,
      faction: null,
      flags: {
        channelRole: entityType === 'system_agent' && !isMember ? 'operator' : buildConversationParticipantLabel(conversation.type),
        actorRefKind: entityType === 'user' ? 'user_persona' : entityType === 'system_agent' ? 'system_agent' : 'ai_character',
        systemAgentSubtype: systemAgentSubtype || null,
        actorCapabilities: capabilities.join(','),
        isOperator: entityType === 'system_agent' && !isMember,
      },
    };
  });
}

function readParticipantCapabilities(participant: ParticipantInstance) {
  const encoded = typeof participant.flags?.actorCapabilities === 'string' ? participant.flags.actorCapabilities : '';
  return encoded.split(',').map((item) => item.trim()).filter(Boolean);
}

function hasParticipantCapability(participant: ParticipantInstance, capability: 'speak' | 'guide' | 'moderate' | 'judge') {
  return readParticipantCapabilities(participant).includes(capability);
}

export function getConversationSeat(conversation: GroupChat, memberId: string) {
  return conversation.scenarioState?.seats?.find((item) => item.actorId === memberId);
}

export function applyGovernanceToParticipant(conversation: GroupChat, participant: ParticipantInstance): ParticipantInstance {
  const memberId = participant.entityRefId || '';
  const seat = memberId ? getConversationSeat(conversation, memberId) : undefined;
  if (!canUseMute(conversation) || !seat) {
    return { ...participant, muted: false };
  }
  const blocked = seat.muted === true || seat.canSpeak === false;
  return {
    ...participant,
    muted: seat.muted === true,
    canSpeak: blocked ? false : participant.canSpeak,
  };
}

export function createDefaultConversationPanels(context: SessionProjectionContext): RuntimePanelDefinition[] {
  return [
    { key: 'members', title: context.conversation.type === 'group' ? '成员' : '角色', type: 'members', tabKey: 'members' },
    { key: 'runtime', title: '运行态', type: 'runtime', tabKey: 'world' },
  ];
}

export function createDefaultConversationActions(context: SessionProjectionContext): RuntimeAction[] {
  const actions: RuntimeAction[] = [{ type: 'speak' }];
  const hasDirectorCapability = context.participants.some((participant) => hasParticipantCapability(participant, 'guide') || hasParticipantCapability(participant, 'moderate') || hasParticipantCapability(participant, 'judge'));
  const hasSystemAgent = context.participants.some((participant) => participant.entityType === 'system_agent');
  const aiParticipantCount = context.participants.filter((participant) => participant.entityType === 'ai').length;
  if (canUseDirectorIntervention(context.conversation) && (hasDirectorCapability || !hasSystemAgent)) actions.push({ type: 'director_intervention' });
  if (canUsePrivateThreads(context.conversation) && aiParticipantCount >= 2) actions.push({ type: 'start_private_thread' });
  if (canUseMute(context.conversation) && aiParticipantCount >= 1) {
    actions.push({ type: 'mute_member' }, { type: 'unmute_member' });
  }
  return actions;
}

export function createDefaultConversationActionSchema(context: SessionEngineActionContext): SessionActionSchema | null {
  if (context.conversation.type !== 'group') return null;
  const targetParticipants = context.participants.filter((participant) => participant.entityType === 'ai');
  const hasDirectorCapability = context.participants.some((participant) => hasParticipantCapability(participant, 'guide') || hasParticipantCapability(participant, 'moderate') || hasParticipantCapability(participant, 'judge'));
  const hasSystemAgent = context.participants.some((participant) => participant.entityType === 'system_agent');
  const options = targetParticipants
    .map((participant, index) => ({ label: participant.displayName || `成员 ${index + 1}`, value: participant.entityRefId || '' }))
    .filter((option) => option.value);
  const actions: SessionActionDefinition[] = [];
  if (canUseDirectorIntervention(context.conversation) && (hasDirectorCapability || !hasSystemAgent)) {
    actions.push({
      type: 'director_intervention',
      label: '导演干预',
      description: '临时影响下一轮自由发言的走向。',
      visibility: 'moderator_only',
      fields: buildDirectorInterventionFields({
        preset: 'conversation',
        targetLabel: '影响成员',
        targetOptions: options,
        promptPlaceholder: '例如：先让甲回应乙的质疑，暂时不要换话题',
      }),
    });
  }
  if (canUsePrivateThreads(context.conversation) && options.length >= 2) {
    actions.push({
      type: 'start_private_thread',
      label: '发起角色私聊',
      description: '从主群中开启一段仅双方可见的角色私聊。',
      fields: [
        { key: 'actorId', label: '发起者', type: 'single_select', required: true, options, targetSource: 'participants' },
        { key: 'targetId', label: '对象', type: 'single_select', required: true, options, targetSource: 'participants' },
        { key: 'prompt', label: '私聊起因', type: 'textarea', placeholder: '例如：继续私下追问刚才的话题' },
      ],
    });
  }
  actions.push(...(createGovernanceActionSchema(context)?.actions || []));
  if (!actions.length) return null;
  return {
    title: '开放聊天动作',
    actions,
  };
}

export function createGovernanceActionSchema(context: SessionEngineActionContext): SessionActionSchema | null {
  if (!canUseMute(context.conversation)) return null;
  const targetParticipants = context.participants.filter((participant) => participant.entityType === 'ai');
  const muteOptions = targetParticipants
    .filter((participant) => !participant.muted && participant.canSpeak !== false)
    .map((participant, index) => ({ label: participant.displayName || `成员 ${index + 1}`, value: participant.entityRefId || '' }))
    .filter((option) => option.value);
  const unmuteOptions = targetParticipants
    .filter((participant) => participant.muted || participant.canSpeak === false)
    .map((participant, index) => ({ label: participant.displayName || `成员 ${index + 1}`, value: participant.entityRefId || '' }))
    .filter((option) => option.value);
  const actions: SessionActionDefinition[] = [];
  if (muteOptions.length) {
    actions.push({
      type: 'mute_member',
      label: '禁言成员',
      description: '让指定成员暂时不能被自动调度发言。',
      visibility: 'moderator_only',
      fields: [
        { key: 'targetId', label: '禁言对象', type: 'single_select', required: true, options: muteOptions, targetSource: 'participants' },
        { key: 'prompt', label: '原因', type: 'textarea', placeholder: '例如：本轮先听其他成员发言' },
      ],
    });
  }
  if (unmuteOptions.length) {
    actions.push({
      type: 'unmute_member',
      label: '解除禁言',
      description: '恢复指定成员的自动发言资格。',
      visibility: 'moderator_only',
      fields: [
        { key: 'targetId', label: '解除对象', type: 'single_select', required: true, options: unmuteOptions, targetSource: 'participants' },
        { key: 'prompt', label: '原因', type: 'textarea', placeholder: '例如：恢复参与讨论' },
      ],
    });
  }
  if (!actions.length) return null;
  return { title: '成员治理', actions };
}

export function mergeGovernanceActionSchema(baseSchema: SessionActionSchema | null, context: SessionEngineActionContext): SessionActionSchema | null {
  const governanceSchema = createGovernanceActionSchema(context);
  if (!governanceSchema) return baseSchema;
  if (!baseSchema) return governanceSchema;
  const existingTypes = new Set(baseSchema.actions.map((action) => action.type));
  const governanceActions = governanceSchema.actions.filter((action) => !existingTypes.has(action.type));
  if (!governanceActions.length) return baseSchema;
  return {
    ...baseSchema,
    actions: [...baseSchema.actions, ...governanceActions],
  };
}

export function createDefaultConversationPhases(): SessionPhaseDefinition[] {
  return [{ key: 'idle', label: 'Idle', allowedActions: ['speak', 'all'] }];
}

export function createDefaultConversationPromptContext(params: SessionGenerationContext & { speaker: AICharacter }): SessionGenerationPromptContext {
  return {
    promptPrefix: params.conversation.type === 'ai_direct'
      ? 'This is a private side-thread derived from a larger conversation. Keep the line confidential, intimate, and responsive to the private counterpart.'
      : undefined,
    additionalConstraints: [
      params.conversation.type === 'group'
        ? 'Assume there are multiple simultaneous conversational threads and react to one thread sharply.'
        : 'Treat this as a focused two-party exchange. The latest User line is input to answer, not a script for you to repeat; respond to its question, doubt, or emotion in your own character voice.',
      params.speaker.group ? `Maintain ${params.speaker.group} social stance and continuity.` : 'Maintain speaker-specific social continuity.',
    ],
  };
}

export function createDefaultConversationTurnPolicy(params: SessionGenerationContext): SessionTurnPolicy {
  const hasMembers = params.characters.some((character) => params.conversation.memberIds.includes(character.id));
  return {
    runChat: hasMembers,
    runAction: false,
    interleaveAction: false,
  };
}

export interface SessionCommitContext {
  conversation: GroupChat;
  characters: AICharacter[];
  message: import('./chat').OpenChatCommittedMessage;
  previousAiMessage?: Pick<Message, 'senderId'> | null;
  recentMessages?: Message[];
  apiConfig?: APIConfig;
}

export interface SessionGenerationContext {
  conversation: GroupChat;
  characters: AICharacter[];
  messages: Message[];
}

export interface SessionGenerationPromptContext {
  promptPrefix?: string;
  promptSuffix?: string;
  additionalConstraints?: string[];
  responseStyle?: 'chat' | 'professional' | 'creative' | 'longform';
  allowMarkdown?: boolean;
  styleProfile?: string;
}

export interface SessionTurnPolicy {
  runChat: boolean;
  runAction: boolean;
  interleaveAction?: boolean;
}

export interface SessionEngineActionContext {
  conversation: GroupChat;
  participants: ParticipantInstance[];
  characters?: AICharacter[];
}

export interface SessionEngineDefinition {
  key: string;
  createInitialConfig: () => unknown;
  createInitialState: (config: unknown) => unknown;
  buildParticipants: (conversation: GroupChat) => ParticipantInstance[];
  buildChatPatch?: (conversation: GroupChat) => Partial<GroupChat>;
  getPhaseDefinitions?: (conversation: GroupChat) => SessionPhaseDefinition[];
  getVisiblePanels: (context: SessionProjectionContext) => RuntimePanelDefinition[];
  getAvailableActions: (context: SessionProjectionContext) => RuntimeAction[];
  getActionSchema?: (context: SessionEngineActionContext) => SessionActionSchema | null;
  buildGenerationPromptContext?: (context: SessionGenerationContext & { speaker: AICharacter }) => SessionGenerationPromptContext;
  resolveTurnPolicy?: (context: SessionGenerationContext) => SessionTurnPolicy;
  buildRuntimeContextBundle?: (context: SessionGenerationContext & { speaker: AICharacter }) => SessionRuntimeContextBundle | null;
  buildNarrativeTurnMetadata?: (context: SessionGenerationContext & { speaker: AICharacter; content: string; blocks?: NarrativeBlock[] | null }) => NonNullable<Message['metadata']>['narrativeTurn'] | null;
  onMessageCommitted: (context: SessionCommitContext) => Promise<{
  chatPatch: Partial<GroupChat>;
  characterPatches: Array<{ characterId: string; patch: Partial<AICharacter> }>;
  runtimeEvents: Array<{ eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown }>;
}> | {
  chatPatch: Partial<GroupChat>;
  characterPatches: Array<{ characterId: string; patch: Partial<AICharacter> }>;
  runtimeEvents: Array<{ eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown }>;
};
}

export function createDefaultConversationChatPatch(conversation: GroupChat): Partial<GroupChat> {
  return createDefaultConversationFrameworkPatch(conversation);
}

export function createDefaultConversationEngineDefinition(params: {
  key: string;
  createInitialConfig: () => unknown;
  createInitialState: (config: unknown) => unknown;
  buildRuntimeContextBundle?: SessionEngineDefinition['buildRuntimeContextBundle'];
  onMessageCommitted: SessionEngineDefinition['onMessageCommitted'];
}): SessionEngineDefinition {
  return {
    key: params.key,
    createInitialConfig: params.createInitialConfig,
    createInitialState: params.createInitialState,
    buildParticipants: createDefaultConversationParticipants,
    buildChatPatch: createDefaultConversationChatPatch,
    getPhaseDefinitions: createDefaultConversationPhases,
    getVisiblePanels: createDefaultConversationPanels,
    getAvailableActions: createDefaultConversationActions,
    getActionSchema: createDefaultConversationActionSchema,
    buildGenerationPromptContext: createDefaultConversationPromptContext,
    resolveTurnPolicy: createDefaultConversationTurnPolicy,
    buildRuntimeContextBundle: params.buildRuntimeContextBundle,
    onMessageCommitted: params.onMessageCommitted,
  };
}
