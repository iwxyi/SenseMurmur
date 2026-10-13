import type { CompanionshipRuntimeTrace } from './companionship';
import type { InteractionEventPayload } from './runtimeEvent';

export type MessageType = 'ai' | 'user' | 'system' | 'god' | 'event';

export type MessageAttachmentKind = 'image' | 'audio' | 'sticker' | 'file';
export type ChatFileSource = 'message_upload' | 'chat_artifact' | 'workspace_file' | 'generated_file';

export interface ChatFileAttachment {
  id: string;
  source: ChatFileSource;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  textContent?: string;
  workspaceId?: string;
  relativePath?: string;
  artifactId?: string;
  createdAt: number;
}
export type MessageAttachmentStatus = 'placeholder' | 'queued' | 'generating' | 'ready' | 'failed' | 'deleted';

export interface MessageAttachment {
  id: string;
  kind: MessageAttachmentKind;
  status: MessageAttachmentStatus;
  altText: string;
  fileName?: string;
  textContent?: string;
  caption?: string;
  slotId?: string;
  assetId?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  generationJobId?: string;
  promptText?: string;
  /** Distinguishes generated learning audio from ordinary character voice messages. */
  audioPurpose?: 'chat_voice' | 'listening_exercise';
  /** Per-attachment transcript policy; learning listening audio can override global settings. */
  transcriptVisibility?: 'default' | 'visible' | 'hidden';
  ttsVoice?: string;
  ttsLanguage?: string;
  ttsSpeed?: number;
  ttsPitch?: number;
  ttsStyle?: string;
  semanticSummary?: string;
  aspectRatio?: string;
  imageSize?: string;
  targetArtifactId?: string;
  targetImageIds?: string[];
  referenceImageIds?: string[];
  styleImageIds?: string[];
  referenceCharacterIds?: string[];
  referenceImages?: Array<{
    url: string;
    mimeType?: string;
    label?: string;
  }>;
  thumbnailAssetId?: string;
  checksum?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MediaGenerationDecision {
  images?: Array<{
    shouldGenerate: boolean;
    reason?: string;
    prompt?: string;
    altText?: string;
    aspectRatio?: string;
    imageSize?: string;
    referenceCharacterIds?: string[];
    targetImageIds?: string[];
    referenceImageIds?: string[];
    styleImageIds?: string[];
  }> | null;
  image?: {
    shouldGenerate: boolean;
    reason?: string;
    prompt?: string;
    altText?: string;
    aspectRatio?: string;
    imageSize?: string;
    referenceCharacterIds?: string[];
    targetImageIds?: string[];
    referenceImageIds?: string[];
    styleImageIds?: string[];
  } | null;
  audio?: {
    shouldGenerate: boolean;
    reason?: string;
    text?: string;
    voiceProfileId?: string;
    audioPurpose?: 'chat_voice' | 'listening_exercise';
    transcriptVisibility?: 'default' | 'visible' | 'hidden';
    voice?: string;
    language?: string;
    speed?: number;
    pitch?: number;
    style?: string;
  } | null;
  sticker?: {
    shouldSend: boolean;
    keyword?: string;
    altText?: string;
  } | null;
}

export interface MessagePresenceUpdate {
  status: 'online' | 'away';
  activity?: string;
  reason?: string;
  durationMinutes?: number;
  evidenceText?: string;
}

export interface MessageActivityUpdate {
  calendarItemId?: string;
  title: string;
  kind: 'activity' | 'travel' | 'rest' | 'preparation' | 'blocked_time' | 'reminder';
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled';
  participantIds?: string[];
  startAt?: number;
  startsNow?: boolean;
  durationMinutes?: number;
  timeHint?: string;
  locationHint?: string;
  availability?: 'online' | 'away';
  evidenceText: string;
}

export type NarrativeActorKind = 'narrator' | 'character' | 'director' | 'system';
export type NarrativeBlockKind = 'prose' | 'dialogue' | 'action' | 'inner_thought' | 'choice' | 'system_note';
export type NarrativeDisplayMode = 'paragraph' | 'bubble' | 'choice_card' | 'system_panel' | 'hidden';
export type NarrativeTurnKind = 'narrative_beat' | 'character_reaction' | 'choice_prompt' | 'reveal';

export interface NarrativeChoice {
  id: string;
  label: string;
  prompt?: string;
  intent?: string | null;
  risk?: string | null;
  reward?: string | null;
}

export interface StoryChoiceSuggestion {
  label: string;
  prompt?: string | null;
  intent?: string | null;
  risk?: string | null;
  reward?: string | null;
}

export interface StudyTurnUpdate {
  phase?: 'mapping' | 'learning' | 'review' | null;
  knowledgeObservations?: Array<{
    knowledgeItemId?: string | null;
    title: string;
    status: 'unknown' | 'exposed' | 'learning' | 'practicing' | 'usable' | 'verified' | 'stale';
    evidenceSummary?: string | null;
    confidence?: number | null;
  }> | null;
}

export type StoryEventType = 'narration' | 'speech' | 'choice_point' | 'chapter_update';

export interface StoryEventChoice {
  label: string;
  prompt?: string | null;
  intent?: string | null;
  risk?: string | null;
  reward?: string | null;
}

export interface StoryEvent {
  type: StoryEventType;
  text?: string;
  speakerName?: string;
  characterId?: string;
  choices?: StoryEventChoice[];
  title?: string;
  summary?: string;
  status?: 'active' | 'completed';
  startNewChapter?: boolean;
  keyChoices?: string[];
}

export interface StoryQualityTrace {
  score: number;
  labels: string[];
  gaps: string[];
}

export interface StoryChoiceSelection {
  branchId?: string;
  sourceMessageId?: string;
  label: string;
  prompt?: string | null;
  intent?: string | null;
  risk?: string | null;
  reward?: string | null;
  choiceEpoch?: number;
}

export interface NarrativeBlock {
  id: string;
  actorId: string;
  actorKind: NarrativeActorKind;
  kind: NarrativeBlockKind;
  displayMode: NarrativeDisplayMode;
  text: string;
  actorName?: string;
  characterId?: string;
  choices?: NarrativeChoice[];
}

export interface NarrativeTurnMetadata {
  turnId: string;
  turnKind: NarrativeTurnKind;
  sceneId?: string;
  phase?: string;
  povActorId?: string;
  blocks: NarrativeBlock[];
}

export interface StoryAssetMetadata {
  currentScene?: {
    location?: string;
    time?: string;
    presentActorIds?: string[];
    visibleThreat?: string;
    summary?: string;
  } | null;
  openQuestions?: string[];
  clues?: string[];
  stakes?: string[];
  relationshipShifts?: string[];
  chapterMemory?: string;
  storyGoal?: string;
  storySituation?: string;
}

export interface MessageMetadata {
  conversationUpdate?: import('./conversationContinuity').ConversationUpdate;
  voice?: {
    url: string;
    mimeType?: string;
    text?: string;
    provider?: string;
    createdAt: number;
  };
  format?: 'plain' | 'markdown';
  contextText?: string;
  renderText?: string;
  assistant?: {
    mode?: 'general';
    artifacts?: Array<{
      id: string;
      kind: string;
      title: string;
      versionId?: string;
      presentation?: 'link' | 'inline_html' | 'fullscreen_html';
      interactionId?: string;
    }>;
  };
  assistantHtmlSubmission?: {
    artifactId: string;
    baseVersionId: string;
    interactionId: string;
    submissionId: string;
    resultType: 'form' | 'quiz' | 'selection' | 'custom';
    payload: Record<string, unknown>;
    submittedAt: number;
  };
  assistantHtmlRuntimeError?: {
    artifactId: string;
    versionId: string;
    message: string;
    kind: 'runtime' | 'unhandledrejection' | 'console' | 'resource' | 'page_state';
    stack?: string;
    source?: string;
    line?: number;
    column?: number;
    reportedAt: number;
  };
  workspaceMutationPlan?: {
    id: string;
    directoryId: string;
    mutations: Array<{ kind: 'write' | 'delete' | 'move' | 'copy'; path: string; destinationPath?: string; content?: string; conflictPolicy?: 'rename' | 'skip' | 'overwrite'; recursive?: boolean }>;
    createdAt: number;
    expiresAt: number;
    status: 'pending' | 'confirmed' | 'expired' | 'rejected';
    result?: { applied: number; failed: number; error?: string };
  };
  branching?: {
    nodeId?: string;
    parentNodeId?: string | null;
    rootNodeId?: string | null;
    sequence?: number;
    revisionOfNodeId?: string | null;
    speakerRef?: { characterInstanceId: string; displayName?: string } | null;
    revisionRootId?: string | null;
    revisionOfMessageId?: string | null;
    createdFromMessageId?: string | null;
  };
  storyEvents?: StoryEvent[];
  storyAssets?: StoryAssetMetadata;
  storyQuality?: StoryQualityTrace;
  narrativeTurn?: NarrativeTurnMetadata;
  storyChoices?: StoryChoiceSuggestion[];
  storyChoiceSelection?: StoryChoiceSelection;
  studyUpdate?: StudyTurnUpdate;
  manualSpeaker?: {
    actorId: string;
    actorName: string;
    avatar?: string;
  };
  withdrawal?: {
    withdrawn: boolean;
    originalContent?: string;
    reason?: string;
    withdrawnAt?: number;
    visiblePending?: boolean;
  };
  attachments?: MessageAttachment[];
  presenceUpdate?: MessagePresenceUpdate;
  activityUpdate?: MessageActivityUpdate;
  generationDecision?: MediaGenerationDecision;
  generation?: {
    status?: 'queued' | 'generating' | 'ready' | 'failed';
    updatedAt?: number;
    error?: string;
  };
  runtimeDecision?: {
    directorIntent?: {
      source: string;
      beatType: string;
      targetLineId?: string;
      targetActorIds?: string[];
      pressure?: number;
      reason?: string;
      userGuidance?: {
        kind: string;
        rawText: string;
        actorIds?: string[];
        mentionedActorIds?: string[];
        hardConstraintActorIds?: string[];
        suppressedActorIds?: string[];
        deferredActorIds?: string[];
        hasHardConstraints?: boolean;
        voiceRequest?: boolean;
        stickerRequest?: boolean;
        focusText?: string;
        beatType?: string;
        pressure?: number;
        maxTurns?: number;
        minTargetTurns?: number;
        reason?: string;
        mediaRequest?: {
          kind: string;
          subjectActorIds?: string[];
          subjectText?: string;
          actionText?: string;
        } | null;
      } | null;
    };
    narrativeLines?: Array<{
      id: string;
      type: string;
      title: string;
      salience: number;
      tension: number;
      status: string;
      participantIds?: string[];
    }>;
    speakerSelection?: {
      speakerId?: string | null;
      reason?: string | null;
      bypassNotice?: string | null;
      policy?: Record<string, unknown>;
    };
    speakerScore?: Record<string, unknown>;
    innerLife?: {
      impulse: string;
      tone: string;
      reason: string;
      pressure: number;
      evidence?: string[];
      state?: {
        energy?: number;
        attention?: number;
        loneliness?: number;
        repression?: number;
        shame?: number;
        envy?: number;
        trustInRoom?: number;
        ignoredStreak?: number;
      };
      expressionPlan?: {
        length?: string;
        suggestedMessageCount?: number;
        messageCount?: number;
        typoLevel?: number;
        delayMs?: number;
        allowWithdraw?: boolean;
      };
    };
    responseSurface?: {
      kind: 'chat' | 'professional' | 'creative' | 'longform';
      allowMarkdown: boolean;
      preserveParagraphs: boolean;
      roleFit: 'limited' | 'ordinary' | 'capable';
      basis: string[];
    };
    turnPlan?: {
      rhythm: 'micro_ack' | 'short_reply' | 'full_reply' | 'multi_bubble' | 'defer_or_wait';
      maxBubbleCount: number;
      actualBubbleCount?: number;
      lengthBand: 'micro' | 'short' | 'medium' | 'long' | 'extended';
      allowExtraMessages: boolean;
      waitSensitive: boolean;
      reasons: string[];
    };
    personaActivation?: {
      level: 'low' | 'medium' | 'high' | 'masked';
      reasons: string[];
    };
    intentionalRepeat?: boolean;
    memoryContext?: {
      injectedIds?: string[];
      targetActorId?: string;
      targetActorName?: string;
      targetReason?: string;
      sharedSecretGuards?: string[];
      recalledArchives?: Array<{
        id: string;
        scope: string;
        kind: string;
        layer: string;
        summary: string;
        recallReason?: string;
        recallTokens?: string[];
        recallScore?: number;
      }>;
    };
    characterMind?: {
      visibility: 'public' | 'private';
      visibleMemoryRecall: 'off' | 'implicit' | 'natural';
      memorySource?: 'assembly_candidates' | 'fallback_retrieval';
      targetActorId?: string;
      targetActorName?: string;
      omittedPrivateContinuity?: boolean;
      omittedRawRoomLines?: boolean;
      coreLineCount?: number;
      roomLineCount?: number;
      recallCueCount?: number;
      hasUserContinuity?: boolean;
      hasRelationshipContinuity?: boolean;
      hasSharedHistory?: boolean;
      hasWorldContext?: boolean;
    };
    companionshipContext?: CompanionshipRuntimeTrace;
    guidanceExecution?: {
      status: 'accepted' | 'accepted_after_retry' | 'failed_after_retry';
      validated: boolean;
      retryCount: number;
      rejectedDraftCount: number;
      rejectedReasons?: Array<'wrong_speaker' | 'missing_requested_image' | 'missing_requested_subject' | 'missing_topic_focus' | 'missing_question_answer' | 'missing_direct_reply_focus' | 'suppression_handoff_required' | 'empty_content'>;
      finalReason?: 'matched' | 'wrong_speaker' | 'missing_requested_image' | 'missing_requested_subject' | 'missing_topic_focus' | 'missing_question_answer' | 'missing_direct_reply_focus' | 'suppression_handoff_required' | 'empty_content';
      forcedMediaQueued?: boolean;
    };
    worldInfluence?: {
      attentionScore?: number;
      attentionRestraint?: number;
      activeRuleIds?: string[];
      activeRuleTexts?: string[];
    };
    generationRuntime?: {
      turnPlan?: unknown;
      expressionPlan?: unknown;
      realizationPlan?: unknown;
      trace?: unknown;
    };
    expressionFeedback?: Array<{
      id: string;
      label: string;
      text: string;
      evidence?: string;
      kind?: string;
      layer?: string;
      confidence?: number;
      count?: number;
      positiveCount?: number;
      applied?: boolean;
      effects?: string[];
    }>;
  };
  /** Small, developer-only snapshot of inputs before generation and targets returned by the model. */
  turnParameters?: {
    version: 1;
    emotion: {
      mood: { pleasure: number; arousal: number; dominance: number };
      tone: string;
      impulse: string;
      pressure: number;
      dominant?: { kind: string; value: number };
      directed?: { counterpart: string; kind: string; role: string; pressure: number };
    };
    relationships: Array<{
      target: string;
      warmth: number;
      competence: number;
      trust: number;
      threat: number;
      attachment: number;
      deference: number;
    }>;
    room?: { heat?: number; cohesion?: number; topicDrift?: number; hotspot?: string };
    plan: { move: string; target?: string; addressedBefore: boolean; intendedRecipients: string[] };
    delivery: { addressedRecipients: string[]; primaryRecipient?: string; bubbleCount: number };
  };
  deliberationArtifacts?: {
    claims?: Array<{
      text: string;
      stance?: 'support' | 'oppose' | 'neutral' | 'review' | 'inquiry';
      reason?: string;
      confidence?: number;
    }>;
    evidence?: Array<{
      text: string;
      reason?: string;
      confidence?: number;
    }>;
    issues?: Array<{
      text: string;
      targetActorId?: string | null;
      reason?: string;
      confidence?: number;
    }>;
    verdicts?: Array<{
      text: string;
      tendency?: 'support' | 'oppose' | 'mixed' | 'undecided';
      reason?: string;
      confidence?: number;
    }>;
    summary?: {
      text: string;
      reason?: string;
      confidence?: number;
    } | null;
    overallReason?: string | null;
  };
  turnSegment?: {
    index: number;
    count: number;
  };
  visibility?: string;
  cachePolicy?: Record<string, unknown>;
}

export interface Message {
  id: string;
  clientKey?: string;
  serverId?: string;
  chatId: string;
  type: MessageType;
  senderId: string;         // AI character ID, 'user', or 'system'
  senderName: string;
  content: string;
  metadata?: MessageMetadata;
  interactionHint?: InteractionEventPayload | null;
  interactionHints?: InteractionEventPayload[] | null;
  incomingInteractionHint?: InteractionEventPayload | null;
  /** Who the visible turn is speaking to; this is not necessarily a request for another turn. */
  addressedTargetIds?: string[] | null;
  primaryAddressedTargetId?: string | null;
  /** Who the speaker explicitly leaves an unanswered next-reply obligation for. */
  replyDebtTargetIds?: string[] | null;
  primaryReplyDebtTargetId?: string | null;
  emotion: number;           // -1 to 1
  timestamp: number;
  isDeleted: boolean;
  isOptimistic?: boolean;
  isStreaming?: boolean;
}
