import type { AICharacter, CharacterVisualIdentity } from './character';
import type { Message } from './message';
import type { MemoryItem } from '../services/memoryTypes';
import type { ConflictRuntimeState } from './runtimeEvent';
import type { ParticipantPrivateState, ParticipantPublicState } from './participantRole';
import type { RelationshipLedgerEntry, RoomStateSnapshotV2, RuntimeEventV2 } from './runtimeEvent';
import type { APIConfig } from './settings';

export type ChatStyle = 'free' | 'debate' | 'brainstorm' | 'roleplay';
export type ConversationType = 'assistant' | 'group' | 'direct' | 'ai_direct';
export type ConversationMode = 'open_chat' | 'interview' | 'group_discussion' | 'roundtable' | 'classroom' | 'agent_workflow' | 'bargaining' | 'service_roleplay' | 'board_game' | 'scripted_play' | 'werewolf' | 'murder_mystery';
export type ConversationPhase = 'idle' | 'warming' | 'debating' | 'aligned' | 'chaotic';
export type RuntimeEvolutionIntensity = 'slow' | 'balanced' | 'fast';
export type SessionFamily = 'assistant' | 'conversation' | 'interview' | 'deduction' | 'mystery' | 'study' | 'analysis' | 'board_game' | 'agent' | 'simulation';
export type SessionSurfaceProfile = 'text' | 'form' | 'board' | 'hybrid' | 'timeline' | 'dashboard';
export type SessionTopology = 'group' | 'direct' | 'thread' | 'team' | 'table';

export interface SessionKind {
  topology: SessionTopology;
  family: SessionFamily;
  scenarioId: string;
  surfaceProfile: SessionSurfaceProfile;
}

export interface PersistentCharacterCore {
  characterId: string;
  summary?: string;
}

export interface ConversationCharacterState {
  characterId: string;
  summary?: string;
  growthNotes?: string[];
}

export interface ScenarioSeat {
  seatId: string;
  seatIndex: number;
  actorId?: string | null;
  roleId?: string | null;
  teamId?: string | null;
  displayName?: string;
  muted?: boolean;
  canSpeak?: boolean;
}

export interface ScenarioRoleAssignment {
  actorId: string;
  roleId: string;
  factionId?: string | null;
  summary?: string;
}

export interface SessionBoardSchema {
  kind: string;
  columns?: number;
  rows?: number;
  nodes?: Array<{ id: string; x: number; y: number }>;
  edges?: Array<{ from: string; to: string }>;
}

export interface SessionBoardPiece {
  id: string;
  type: string;
  actorId?: string;
  teamId?: string;
  position: string;
}

export interface SessionBoardState {
  schema: SessionBoardSchema;
  pieces?: SessionBoardPiece[];
}

export interface ScenarioGoalState {
  goalId: string;
  label: string;
  description?: string;
  status?: 'not_started' | 'active' | 'blocked' | 'completed';
  progress?: number;
}

export interface ScenarioProgressState {
  key: string;
  label: string;
  value: number;
  target?: number;
}

export type DiscussionMode = 'open' | 'roundtable' | 'debate' | 'courtroom' | 'expert_review' | 'public_inquiry' | 'brainstorm' | 'retrospective';

export interface ScenarioDeliberationClaimState {
  id: string;
  actorId?: string | null;
  stance?: 'support' | 'oppose' | 'neutral' | 'review' | 'inquiry';
  text: string;
  reason?: string;
  confidence?: number;
  sourceMessageId?: string;
  createdAt?: number;
}

export interface ScenarioDeliberationEvidenceState {
  id: string;
  actorId?: string | null;
  text: string;
  reason?: string;
  confidence?: number;
  sourceMessageId?: string;
  createdAt?: number;
}

export interface ScenarioDeliberationIssueState {
  id: string;
  targetActorId?: string | null;
  text: string;
  status?: 'open' | 'answered' | 'deferred';
  reason?: string;
  confidence?: number;
  sourceMessageId?: string;
  createdAt?: number;
}

export interface ScenarioDeliberationVerdictState {
  id: string;
  actorId?: string | null;
  text: string;
  tendency?: 'support' | 'oppose' | 'mixed' | 'undecided';
  reason?: string;
  confidence?: number;
  sourceMessageId?: string;
  createdAt?: number;
}

export interface ScenarioDeliberationMomentumState {
  support: number;
  oppose: number;
  inquiry: number;
  review: number;
  label?: string;
}

export interface ScenarioBranchState {
  branchId: string;
  label: string;
  status?: 'available' | 'locked' | 'chosen' | 'completed';
  description?: string;
  prompt?: string;
  intent?: string;
  risk?: string;
  reward?: string;
  source?: 'suggested' | 'custom' | 'system';
  choiceEpoch?: number;
}

export type StoryBeatKind = 'establish' | 'pressure' | 'decision' | 'consequence' | 'new_pressure';
export type StoryChoicePolicy = 'forbid' | 'allow' | 'require';

export interface StoryChapterRecapState {
  title: string;
  summary: string;
  discoveredClues: string[];
  unresolvedQuestions: string[];
  changedRelationships: string[];
  stakes: string[];
  lastChoiceLabels: string[];
  choiceImpacts?: string[];
  updatedAt: number;
  beatCount: number;
}

export interface StoryCurrentSceneState {
  location?: string;
  time?: string;
  presentActorIds?: string[];
  visibleThreat?: string;
  summary?: string;
  updatedAt?: number;
}

export type StoryReaderRole = 'participant' | 'director';

export interface StoryProtocolDiagnostic {
  code:
    | 'choice_forbidden'
    | 'choice_required_missing'
    | 'choice_subject_mismatch'
    | 'choice_consequence_unresolved'
    | 'choice_gate_mismatch'
    | 'empty_story_events'
    | 'chapter_title_missing'
    | 'chapter_recap_missing';
  message: string;
  level: 'warn' | 'error';
  beatKind?: StoryBeatKind;
  choicePolicy?: StoryChoicePolicy;
  choiceEpoch?: number;
  sourceMessageId?: string;
  createdAt: number;
}

export interface StoryChapterState {
  id: string;
  index: number;
  title: string;
  status: 'active' | 'completed';
  startMessageId: string;
  endMessageId?: string;
  startBeatId: string;
  endBeatId?: string;
  summary?: string;
  keyChoices?: string[];
  openedAt: number;
  closedAt?: number;
}

export interface ScenarioState {
  seats?: ScenarioSeat[];
  roleAssignments?: ScenarioRoleAssignment[];
  turnOrder?: string[];
  currentTurnActorId?: string | null;
  board?: SessionBoardState | null;
  factions?: Array<{ factionId: string; label: string }>;
  phase?: string;
  discussionMode?: DiscussionMode;
  summaryText?: string;
  deliberationClaims?: ScenarioDeliberationClaimState[];
  deliberationEvidence?: ScenarioDeliberationEvidenceState[];
  deliberationIssues?: ScenarioDeliberationIssueState[];
  deliberationVerdicts?: ScenarioDeliberationVerdictState[];
  deliberationMomentum?: ScenarioDeliberationMomentumState;
  goals?: ScenarioGoalState[];
  progress?: ScenarioProgressState[];
  branches?: ScenarioBranchState[];
  sceneId?: string;
  storyBackground?: string;
  storyDirection?: string;
  storySituation?: string;
  currentScene?: StoryCurrentSceneState | null;
  storyGoal?: string;
  storyOutline?: string;
  storyBeatKind?: StoryBeatKind;
  storyChoicePolicy?: StoryChoicePolicy;
  storyBeatReason?: string;
  readerRole?: StoryReaderRole;
  storyProtocolDiagnostics?: StoryProtocolDiagnostic[];
  openQuestions?: string[];
  clues?: string[];
  stakes?: string[];
  relationshipShifts?: string[];
  choiceHistory?: Array<{
    branchId?: string;
    label: string;
    prompt?: string;
    intent?: string;
    risk?: string;
    reward?: string;
    outcome?: string;
    impact?: string;
    choiceEpoch?: number;
    chosenAt?: number;
  }>;
  selectedChoice?: {
    branchId?: string;
    label: string;
    prompt?: string;
    intent?: string;
    risk?: string;
    reward?: string;
    choiceEpoch?: number;
    chosenAt?: number;
  } | null;
  chapterMemory?: string;
  chapterRecap?: StoryChapterRecapState | null;
  storyChapters?: StoryChapterState[];
  sceneBeatCount?: number;
  choiceEpoch?: number;
  selectedChoiceEpoch?: number;
  werewolfRoleConfig?: string;
  werewolfPostGameMode?: string;
  mysteryScript?: string;
  mysteryRoleMappingMode?: string;
  learning?: LearningScenarioState;
}

export type LearningKnowledgeStatus = 'unknown' | 'exposed' | 'learning' | 'practicing' | 'usable' | 'verified' | 'stale';
export interface LearningKnowledgeItem {
  id: string;
  title: string;
  description?: string;
  status: LearningKnowledgeStatus;
  confidence?: number;
  evidenceCount?: number;
  lastReviewedAt?: number;
  nextReviewAt?: number;
  sourceArtifactIds?: string[];
  notes?: string;
}

export type LearningEvidenceKind = 'answer' | 'code' | 'writing' | 'conversation' | 'self_report' | 'artifact';

export interface LearningEvidenceRecord {
  id: string;
  kind: LearningEvidenceKind;
  summary: string;
  sourceMessageId?: string;
  sourceArtifactId?: string;
  knowledgeItemIds?: string[];
  score?: number;
  maxScore?: number;
  feedback?: string;
  createdAt: number;
}

export interface LearningAttemptRecord {
  id: string;
  artifactId?: string;
  interactionId?: string;
  submissionId?: string;
  status: 'submitted' | 'graded' | 'needs_review';
  score?: number;
  maxScore?: number;
  questionCount?: number;
  answeredCount?: number;
  feedback?: string;
  createdAt: number;
  gradedAt?: number;
}
export interface LearningScenarioState {
  goal: string;
  domain?: string;
  teachingMode?: 'entertainment' | 'casual' | 'serious';
  teacherExpertise?: string;
  assessmentPolicy?: 'evidence_only' | 'guided_estimate' | 'strict';
  teacherIds?: string[];
  studentIds?: string[];
  knowledgeItems: LearningKnowledgeItem[];
  evidence?: LearningEvidenceRecord[];
  attempts?: LearningAttemptRecord[];
  lastStudyAction?: 'map' | 'practice' | 'review' | 'plan' | 'note';
  lastStudyActionAt?: number;
  nextStepSuggestion?: LearningNextStepSuggestion;
}

export interface LearningNextStepSuggestion {
  action: 'map' | 'practice' | 'review' | 'record';
  title: string;
  reason: string;
  prompt: string;
  generatedAt: number;
}

export interface LayeredGrowthState {
  persistentCharacterCores?: PersistentCharacterCore[];
  conversationCharacterStates?: ConversationCharacterState[];
}

export interface SessionChannel {
  channelId: string;
  visibility: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';
  actorIds?: string[];
  roleIds?: string[];
  label?: string;
}

export interface SessionLayoutSlot {
  slotId: string;
  x: number;
  y: number;
  actorId?: string | null;
}

export interface SessionLayoutState {
  slots: SessionLayoutSlot[];
}

export interface SessionScenarioPackageRef {
  scenarioId: string;
  label?: string;
}

export interface SessionJudgeAgentState {
  actorId?: string;
  enabled: boolean;
  style?: 'strict' | 'assistive';
}

export interface SessionMemoryLayerSummary {
  characterCore: boolean;
  relationship: boolean;
  conversation: boolean;
  scenario: boolean;
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

export interface SessionTopologySummary {
  topology: SessionTopology;
  description: string;
}

export interface MessageBranchState {
  enabled?: boolean;
  /** v2: the name of the ref currently shown in the chat. */
  activeBranchName?: string;
  /** v2: immutable-node graph refs. */
  refs?: Record<string, {
    name: string;
    headNodeId: string | null;
    createdAt: number;
    updatedAt: number;
    version: number;
  }>;
  stateVersion?: number;
  activeLeafNodeId?: string | null;
  activeChildByParentNodeId?: Record<string, string>;
  selectedRevisionByRootId?: Record<string, string>;
  updatedAt?: number;
}

export interface SessionFamilyRuntimeSummary {
  family: SessionFamily;
  scenarioId: string;
}

export interface SessionRefereeDecision {
  allowed: boolean;
  reason?: string;
}

export interface SessionBoardIntentPayload {
  position?: string;
  pieceId?: string;
  move?: string;
}

export interface SessionFormIntentPayload {
  fields: Record<string, unknown>;
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
  type: 'text' | 'form' | 'board' | 'hybrid';
  label?: string;
  actorId?: string;
  placeholder?: string;
  mode?: 'guide' | 'speakAs' | 'memberSpeak';
  capability?: 'speak' | 'guide' | 'moderate' | 'judge' | 'observe' | 'speak_as';
  fields?: SessionInputField[];
}

export interface SessionSurfaceProjection {
  surfaces: SessionInputSurfaceDefinition[];
}

export interface SessionTextComposerSubmission {
  content: string;
  actorId?: string;
}

export interface SessionScenarioDefinition {
  scenarioId: string;
  label: string;
}

export interface SessionResolvedDefinition {
  kind: SessionKind;
  scenario: SessionScenarioDefinition;
}

export interface SessionScenarioPackage {
  scenarioId: string;
  label: string;
  seats?: ScenarioSeat[];
  channels?: SessionChannel[];
  board?: SessionBoardSchema | null;
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

export function createDefaultSessionKind(type: ConversationType, mode: ConversationMode): SessionKind {
  if (type === 'assistant') {
    return { topology: 'direct', family: 'assistant', scenarioId: 'general-assistant', surfaceProfile: 'text' };
  }
  if (mode === 'board_game') {
    return { topology: type === 'group' ? 'table' : 'direct', family: 'board_game', scenarioId: 'board-game', surfaceProfile: 'board' };
  }
  if (mode === 'interview') {
    return { topology: type === 'group' ? 'group' : 'direct', family: 'interview', scenarioId: 'panel-interview', surfaceProfile: 'form' };
  }
  if (mode === 'group_discussion' || mode === 'roundtable') {
    return { topology: type === 'group' ? 'group' : 'team', family: 'analysis', scenarioId: mode === 'roundtable' ? 'roundtable-review' : 'opinion-review', surfaceProfile: 'text' };
  }
  if (mode === 'classroom') {
    return { topology: type === 'group' ? 'group' : 'direct', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' };
  }
  if (mode === 'werewolf') {
    return { topology: 'table', family: 'deduction', scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid' };
  }
  if (mode === 'murder_mystery') {
    return { topology: 'table', family: 'mystery', scenarioId: 'murder-mystery', surfaceProfile: 'hybrid' };
  }
  return {
    topology: type === 'group' ? 'group' : type === 'ai_direct' ? 'thread' : 'direct',
    family: 'conversation',
    scenarioId: type === 'group' ? 'open-chat' : type === 'ai_direct' ? 'ai-private-thread' : 'direct-chat',
    surfaceProfile: 'text',
  };
}

function isValidSessionKind(value: unknown): value is SessionKind {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionKind>;
  return Boolean(candidate.topology && candidate.family && candidate.scenarioId && candidate.surfaceProfile);
}

function resolveNormalizedSessionKind(input: Pick<GroupChat, 'type' | 'mode'> & Partial<Pick<GroupChat, 'sessionKind'>>) {
  return isValidSessionKind(input.sessionKind)
    ? input.sessionKind
    : createDefaultSessionKind(input.type || 'group', input.mode || 'open_chat');
}

export function resolveSessionDefinitionForConversation(conversation: Pick<GroupChat, 'type' | 'mode' | 'sessionKind'>): SessionResolvedDefinition {
  const kind = resolveNormalizedSessionKind(conversation);
  return {
    kind,
    scenario: {
      scenarioId: kind.scenarioId,
      label: kind.scenarioId,
    },
  };
}

export function createDefaultTextInputSurface(params: { key?: string; label?: string; mode?: 'guide' | 'speakAs' | 'memberSpeak'; actorId?: string; placeholder?: string; capability?: SessionInputSurfaceDefinition['capability'] } = {}): SessionInputSurfaceDefinition {
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

export function defaultInputSurfacesForConversation(conversation: Pick<GroupChat, 'type' | 'mode' | 'sessionKind'>): SessionInputSurfaceDefinition[] {
  const definition = resolveSessionDefinitionForConversation(conversation);
  const directTextSurface = conversation.type === 'assistant' || conversation.type === 'direct' || conversation.type === 'ai_direct'
    ? createDefaultTextInputSurface({ mode: 'memberSpeak', capability: 'speak' })
    : createDefaultTextInputSurface();
  if (definition.kind.scenarioId === 'story-reader') {
    return [createDefaultTextInputSurface()];
  }
  if (definition.kind.surfaceProfile === 'hybrid') {
    return [
      createDefaultTextInputSurface({ key: 'hybrid-text', label: 'Chat' }),
      { key: 'hybrid-actions', type: 'form', label: 'Actions' },
    ];
  }
  if (definition.kind.surfaceProfile === 'board') {
    return [
      { key: 'board-surface', type: 'board', label: 'Board' },
      createDefaultTextInputSurface({ key: 'board-chat', label: 'Chat' }),
    ];
  }
  if (definition.kind.surfaceProfile === 'form') {
    return [{ ...directTextSurface, key: 'fallback-text', label: 'Text fallback' }];
  }
  if (definition.kind.surfaceProfile === 'timeline') {
    return [
      createDefaultTextInputSurface({ key: 'timeline-text', label: 'Narration', placeholder: '输入推进剧情、分支或事件的说明' }),
      { key: 'timeline-actions', type: 'form', label: 'Timeline actions' },
    ];
  }
  if (definition.kind.surfaceProfile === 'dashboard') {
    return [
      createDefaultTextInputSurface({ key: 'dashboard-text', label: 'Notes', placeholder: '输入补充说明、任务要求或协作备注' }),
      { key: 'dashboard-actions', type: 'form', label: 'Workflow actions' },
    ];
  }
  return [directTextSurface];
}

export function defaultTopologySummaryForConversation(conversation: Pick<GroupChat, 'type' | 'mode' | 'sessionKind'>): SessionTopologySummary {
  const definition = resolveSessionDefinitionForConversation(conversation);
  return {
    topology: definition.kind.topology,
    description: `${definition.kind.topology}:${definition.kind.family}:${definition.kind.scenarioId}`,
  };
}

export function deriveSessionMemoryLayerSummary(conversation: Pick<GroupChat, 'mode'>): SessionMemoryLayerSummary {
  return {
    characterCore: true,
    relationship: true,
    conversation: true,
    scenario: conversation.mode !== 'open_chat',
  };
}

export function buildDefaultScenarioPackage(conversation: Pick<GroupChat, 'type' | 'mode' | 'sessionKind'>): SessionScenarioPackage {
  const definition = resolveSessionDefinitionForConversation(conversation);
  return {
    scenarioId: definition.kind.scenarioId,
    label: definition.scenario.label,
    board: definition.kind.family === 'board_game' ? { kind: 'grid', columns: 8, rows: 8 } : null,
  };
}

export function buildDefaultSessionSurfaceProjection(conversation: Pick<GroupChat, 'type' | 'mode' | 'sessionKind'>): SessionSurfaceProjection {
  return {
    surfaces: defaultInputSurfacesForConversation(conversation),
  };
}

export interface OpenChatModeConfig {
  freeSpeaking: boolean;
  allowInterruptions: boolean;
  allowPrivateThreads: boolean;
  allowDirectorInterventions: boolean;
  showRoleActions: boolean;
}

export interface ConversationInitializationState {
  /** Versioned so future room initialization steps can evolve without reusing stale completion records. */
  version: 3;
  status: 'running' | 'completed' | 'failed';
  memberFingerprint: string;
  attemptedAt?: number;
  completedAt?: number;
  forceRelationshipRefresh?: boolean;
}

export interface OpenChatModeState {
  phase: 'free';
  currentSpeakerId?: string | null;
  currentTopicFocus?: string;
  lastRelationshipEventAt?: number | null;
  /** Persisted room-entry initialization, currently including AI relationship analysis. */
  initialization?: ConversationInitializationState;
  assistantTitle?: {
    source?: 'ai' | 'user';
    updatedAt?: number;
    basisMessageCount?: number;
  };
  assistantCapabilities?: {
    agent?: boolean;
    artifacts?: boolean;
    webSearch?: boolean;
    webSearchUserDisabled?: boolean;
    updatedAt?: number;
  };
  agentCapabilities?: {
    enabled?: boolean;
    chatArtifactRead?: boolean;
    chatArtifactWrite?: boolean;
    fileUpload?: boolean;
    fileDownload?: boolean;
    workspaceRead?: boolean;
    workspaceWrite?: boolean;
    officeTransform?: boolean;
    commandExecution?: boolean;
    systemActions?: boolean;
    webSearch?: boolean;
    updatedAt?: number;
  };
}

export interface ParticipantInstance {
  participantId: string;
  conversationId: string;
  entityType: 'ai' | 'user' | 'system_agent';
  entityRefId: string;
  seatIndex?: number;
  displayName?: string;
  title?: string;
  roleKey?: string | null;
  faction?: string | null;
  muted?: boolean;
  canSpeak?: boolean;
  canAct?: boolean;
  flags: Record<string, boolean | number | string | null>;
  privateState?: ParticipantPrivateState;
  publicState?: ParticipantPublicState;
}

export interface RuntimeAction {
  type: string;
  actorId?: string;
  targetIds?: string[];
  payload?: Record<string, unknown>;
}

export interface RuntimePanelDefinition {
  key: string;
  title: string;
  type: 'members' | 'runtime' | 'actions' | 'custom';
  tabKey?: 'members' | 'world';
}

export interface RuntimeContext {
  conversation: GroupChat;
  participants: ParticipantInstance[];
}

export interface RuntimeTransition {
  nextConversationState?: Partial<GroupChat>;
  participantPatches?: Array<{ participantId: string; patch: Partial<ParticipantInstance> }>;
}

export interface DriverCharacterPatch {
  characterId: string;
  patch: Partial<AICharacter>;
}

export interface DriverEventPayload {
  eventType: string;
  title: string;
  summary: string;
  pair?: [string, string];
  metrics?: unknown;
  createdAt?: number;
  channelId?: string;
  causedByIntentId?: string;
  threadRef?: string;
  sourceMessageId?: string;
  eventClass?: 'message' | 'action' | 'board' | 'phase' | 'score' | 'artifact';
  visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';
  visibleToIds?: string[];
  visibleToRoles?: string[];
}

export interface DriverMessageCommitTransition {
  chatPatch: Partial<GroupChat>;
  chatRuntimeDelta?: {
    runtimeEventsV2?: {
      // Omitted by legacy producers whose ordered list replaces the entire window.
      baseIds?: string[];
      orderedIds: string[];
      upserts: RuntimeEventV2[];
    };
    relationshipLedger?: {
      // Only baseline pairs may be removed; concurrently added pairs are retained.
      basePairKeys?: string[];
      orderedPairKeys: string[];
      upserts: RelationshipLedgerEntry[];
    };
  };
  characterPatches: DriverCharacterPatch[];
  runtimeEvents: DriverEventPayload[];
}

export type DriverMessageCommitResult = DriverMessageCommitTransition;

export type OpenChatCommittedMessage = Pick<Message, 'content' | 'type' | 'senderId' | 'metadata'> & Partial<Pick<Message, 'id' | 'timestamp'>> & {
  interactionHint?: import('./runtimeEvent').InteractionEventPayload | null;
  interactionHints?: import('./runtimeEvent').InteractionEventPayload[] | null;
  incomingInteractionHint?: import('./runtimeEvent').InteractionEventPayload | null;
  socialEventHints?: import('./runtimeEvent').SocialEventHintEnvelope[] | null;
  conflictFocus?: import('./runtimeEvent').ConflictFocusPayload | null;
};

export interface OpenChatModeDriver {
  key: ConversationMode;
  createInitialConfig: () => OpenChatModeConfig;
  createInitialState: (config: OpenChatModeConfig) => OpenChatModeState;
  buildParticipants: (conversation: GroupChat) => ParticipantInstance[];
  getAvailableActions: (context: RuntimeContext) => RuntimeAction[];
  getVisiblePanels: (context: RuntimeContext) => RuntimePanelDefinition[];
  onMessageCommitted: (params: {
    conversation: GroupChat;
    characters: AICharacter[];
    message: OpenChatCommittedMessage;
    previousAiMessage?: Pick<Message, 'senderId'> | null;
    recentMessages?: Message[];
    apiConfig?: APIConfig;
  }) => DriverMessageCommitResult | Promise<DriverMessageCommitResult>;
}

export interface SessionKernelCompatibility {
  buildParticipants: (conversation: GroupChat) => ParticipantInstance[];
  getAvailableActions: (context: RuntimeContext) => RuntimeAction[];
  getVisiblePanels: (context: RuntimeContext) => RuntimePanelDefinition[];
}

export const DEFAULT_OPEN_CHAT_MODE_CONFIG: OpenChatModeConfig = {
  freeSpeaking: true,
  allowInterruptions: true,
  allowPrivateThreads: true,
  allowDirectorInterventions: true,
  showRoleActions: true,
};

export const DEFAULT_OPEN_CHAT_MODE_STATE: OpenChatModeState = {
  phase: 'free',
  currentSpeakerId: null,
  currentTopicFocus: '',
  lastRelationshipEventAt: null,
};

export function resolveShowRoleActions(input: Pick<Partial<GroupChat>, 'showRoleActions' | 'modeConfig'>) {
  if (typeof input.showRoleActions === 'boolean') return input.showRoleActions;
  if (typeof input.modeConfig?.showRoleActions === 'boolean') return input.modeConfig.showRoleActions;
  return DEFAULT_OPEN_CHAT_MODE_CONFIG.showRoleActions;
}

export interface ConversationGovernance {
  ownerCharacterId: string | null;
  adminCharacterIds: string[];
  autoModeration: boolean;
  allowMute: boolean;
  allowPrivateThreads: boolean;
}

export interface ConversationDramaRules {
  allowCliques: boolean;
  allowMockery: boolean;
  allowAlliances: boolean;
  allowContempt: boolean;
}

export interface ConversationConflictAxis {
  title: string;
  poles: [string, string];
  currentTilt?: number;
}

export interface ConversationWorldState {
  conversationContinuity?: import('./conversationContinuity').ConversationContinuityState;
  phase: ConversationPhase;
  mood: string;
  focus: string;
  recentEvent: string;
  conflictAxes?: ConversationConflictAxis[];
  structuredRoomState?: RoomStateSnapshotV2 | null;
  conflictState?: ConflictRuntimeState | null;
}

export interface ConversationDirectorControls {
  allowSpeakAs: boolean;
  allowDirectorMode: boolean;
  allowEventInjection: boolean;
  allowForcedReply: boolean;
}

export interface ChatMemberCharacterSummary {
  id: string;
  name: string;
  avatar: string;
  personality: AICharacter['personality'];
  expertise: string[];
  speakingStyle: string;
  background: string;
  visualIdentity?: CharacterVisualIdentity | null;
  speechProfile?: AICharacter['speechProfile'];
  bubbleStyle?: AICharacter['bubbleStyle'];
  bubbleStyleId?: string | null;
  isPreset: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Long-lived visual resources for a group conversation. Generation prompts and candidate metadata are never stored here. */
export interface GroupVisualIdentity {
  avatarUrl?: string | null;
  backgroundUrl?: string | null;
  /** Background image opacity over the page surface, from 0.05 to 1 (fully opaque). */
  backgroundOpacity?: number | null;
}

export type RelationshipStructureKind = 'authority' | 'duty' | 'kinship' | 'affiliation' | 'rivalry' | 'obligation';

export interface RoomRelationshipStructureEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: RelationshipStructureKind;
  statement: string;
  confidence: number;
  evidence: string;
  updatedAt: number;
}

/** A relationship fact jointly held by two or more members, not an attitude in one direction. */
export interface RoomRelationshipSharedFact {
  id: string;
  memberIds: string[];
  /** Multiple public relationship layers may share one concise description. */
  kinds?: RelationshipStructureKind[];
  kind: RelationshipStructureKind;
  statement: string;
  confidence: number;
  evidence: string;
  updatedAt: number;
}

export interface RoomRelationshipStructure {
  version: 1;
  edges: RoomRelationshipStructureEdge[];
  sharedFacts?: RoomRelationshipSharedFact[];
  updatedAt: number;
}

export interface GroupChat {
  id: string;
  type: ConversationType;
  mode: ConversationMode;
  sessionKind?: SessionKind;
  modeConfig: OpenChatModeConfig;
  modeState: OpenChatModeState;
  scenarioState?: ScenarioState;
  channels?: SessionChannel[];
  layoutState?: SessionLayoutState;
  scenarioPackage?: SessionScenarioPackageRef | null;
  judgeAgent?: SessionJudgeAgentState | null;
  layeredGrowth?: LayeredGrowthState;
  modeStateSummary?: SessionFamilyRuntimeSummary;
  memoryLayerSummary?: SessionMemoryLayerSummary;
  growthSnapshots?: SessionGrowthSnapshot[];
  roleMemorySummaries?: SessionRoleMemorySummary[];
  scenarioMemorySummary?: SessionScenarioMemorySummary | null;
  topologySummary?: SessionTopologySummary | null;
  name: string;
  topic: string;
  style: ChatStyle;
  runtimeEvolutionIntensity: RuntimeEvolutionIntensity;
  memberIds: string[];
  operatorIds?: string[];
  speed: number;
  isActive: boolean;
  allowIntervention: boolean;
  showRoleActions?: boolean;
  shareEnabled?: boolean;
  shareToken?: string | null;
  shareViewerCount?: number;
  topicSeed: string;
  sourceChatId?: string | null;
  sourceMemberIds?: string[];
  sourceMarketItemId?: string | null;
  sourceMarketItemVersion?: number | null;
  sourceMarketKind?: 'character_template' | 'chat_template' | 'bundle_template' | string | null;
  groupVisual?: GroupVisualIdentity | null;
  memberCharacterSummaries?: ChatMemberCharacterSummary[];
  layeredMemories?: MemoryItem[];
  runtimeSeed?: {
    notes?: string[];
    artifacts?: string[];
  };
  runtimeTimeline?: Array<{ type: 'note' | 'artifact' | 'relationship'; text: string; createdAt: number }>;
  runtimeEventsV2?: RuntimeEventV2[];
  relationshipLedger?: RelationshipLedgerEntry[];
  /** Group-level authority, duty, kinship, affiliation, and rivalry facts. */
  relationshipStructure?: RoomRelationshipStructure | null;
  governance: ConversationGovernance;
  dramaRules: ConversationDramaRules;
  worldState: ConversationWorldState;
  directorControls: ConversationDirectorControls;
  deletedAt?: number | null;
  fieldVersions?: Record<string, number>;
  latestMessage?: Message | null;
  runtimeDetailLoaded?: boolean;
  /** Client cache marker: distinguishes a real detail fetch from legacy summary records. */
  runtimeDetailHydratedAt?: number;
  worldRuntimeLoaded?: boolean;
  messageBranchState?: MessageBranchState | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
}

export const DEFAULT_CONVERSATION_GOVERNANCE: ConversationGovernance = {
  ownerCharacterId: null,
  adminCharacterIds: [],
  autoModeration: false,
  allowMute: true,
  allowPrivateThreads: true,
};

export const DEFAULT_CONVERSATION_DRAMA_RULES: ConversationDramaRules = {
  allowCliques: false,
  allowMockery: false,
  allowAlliances: true,
  allowContempt: false,
};

export const DEFAULT_CONVERSATION_WORLD_STATE: ConversationWorldState = {
  phase: 'idle',
  mood: '',
  focus: '',
  recentEvent: '',
  conflictAxes: [],
};

export const DEFAULT_CONVERSATION_DIRECTOR_CONTROLS: ConversationDirectorControls = {
  allowSpeakAs: true,
  allowDirectorMode: true,
  allowEventInjection: true,
  allowForcedReply: true,
};

export const DEFAULT_RUNTIME_EVOLUTION_INTENSITY: RuntimeEvolutionIntensity = 'balanced';

export function normalizeConversation(input: (Omit<GroupChat, 'type' | 'governance' | 'dramaRules' | 'worldState' | 'directorControls' | 'runtimeEvolutionIntensity'> & Partial<Pick<GroupChat, 'type' | 'governance' | 'dramaRules' | 'worldState' | 'directorControls' | 'runtimeEvolutionIntensity'>>) & { runtimeNotes?: string[]; runtimeArtifacts?: string[] }): GroupChat {
  const showRoleActions = resolveShowRoleActions(input);
  const sessionKind = resolveNormalizedSessionKind({
    type: input.type || 'group',
    mode: input.mode || 'open_chat',
    sessionKind: input.sessionKind,
  });
  const modeConfig = {
    ...DEFAULT_OPEN_CHAT_MODE_CONFIG,
    ...(input.modeConfig || {}),
    showRoleActions,
  };
  return {
    ...input,
    type: input.type || 'group',
    mode: input.mode || 'open_chat',
    sessionKind,
    modeConfig,
    modeState: input.modeState || DEFAULT_OPEN_CHAT_MODE_STATE,
    showRoleActions,
    scenarioState: input.scenarioState || {
      turnOrder: input.memberIds || [],
      currentTurnActorId: null,
      board: sessionKind.surfaceProfile === 'board'
        ? { schema: { kind: 'grid', columns: 8, rows: 8 }, pieces: [] }
        : null,
      factions: [],
      phase: sessionKind.family === 'analysis'
        ? 'discussion'
        : sessionKind.family === 'study'
          ? 'learning'
          : undefined,
      goals: [],
      progress: [],
      branches: [],
      seats: (input.memberIds || []).map((memberId, index) => ({ seatId: `seat-${index + 1}`, seatIndex: index, actorId: memberId })),
      roleAssignments: [],
    },
    channels: input.channels || [{ channelId: 'public', visibility: 'public', label: 'Public' }],
    layoutState: input.layoutState || { slots: (input.memberIds || []).map((memberId, index) => ({ slotId: `slot-${index + 1}`, x: index, y: 0, actorId: memberId })) },
    scenarioPackage: input.scenarioPackage || { scenarioId: sessionKind.scenarioId, label: sessionKind.scenarioId },
    judgeAgent: input.judgeAgent || { enabled: sessionKind.family === 'board_game', style: 'assistive' },
    layeredGrowth: input.layeredGrowth || { persistentCharacterCores: [], conversationCharacterStates: [] },
    modeStateSummary: input.modeStateSummary || { family: sessionKind.family, scenarioId: sessionKind.scenarioId },
    memoryLayerSummary: input.memoryLayerSummary || deriveSessionMemoryLayerSummary({ mode: input.mode || 'open_chat' }),
    growthSnapshots: input.growthSnapshots || [],
    roleMemorySummaries: input.roleMemorySummaries || [],
    scenarioMemorySummary: input.scenarioMemorySummary || { conversationId: input.id, summary: '' },
    topologySummary: input.topologySummary || defaultTopologySummaryForConversation({ type: input.type || 'group', mode: input.mode || 'open_chat', sessionKind }),
    runtimeEvolutionIntensity: input.runtimeEvolutionIntensity || DEFAULT_RUNTIME_EVOLUTION_INTENSITY,
    sourceChatId: input.sourceChatId || null,
    sourceMemberIds: input.sourceMemberIds || [],
    sourceMarketItemId: input.sourceMarketItemId || null,
    sourceMarketItemVersion: input.sourceMarketItemVersion || null,
    sourceMarketKind: input.sourceMarketKind || null,
    operatorIds: input.operatorIds || [],
    layeredMemories: input.layeredMemories || [],
    runtimeSeed: {
      notes: input.runtimeSeed?.notes || input.runtimeNotes || [],
      artifacts: input.runtimeSeed?.artifacts || input.runtimeArtifacts || [],
    },
    runtimeTimeline: input.runtimeTimeline || [],
    runtimeEventsV2: input.runtimeEventsV2 || [],
    relationshipLedger: input.relationshipLedger || [],
    relationshipStructure: input.relationshipStructure || null,
    governance: {
      ...DEFAULT_CONVERSATION_GOVERNANCE,
      ...(input.governance || {}),
      adminCharacterIds: input.governance?.adminCharacterIds || [],
    },
    dramaRules: {
      ...DEFAULT_CONVERSATION_DRAMA_RULES,
      ...(input.dramaRules || {}),
    },
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      ...(input.worldState || {}),
      conflictAxes: input.worldState?.conflictAxes || [],
      structuredRoomState: input.worldState?.structuredRoomState || null,
    },
    directorControls: {
      ...DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
      ...(input.directorControls || {}),
    },
  };
}
