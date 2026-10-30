import type { AICharacter } from '../types/character';
import type { Message, MessageMetadata, MediaGenerationDecision } from '../types/message';
import type { UserGuidanceIntent } from './userGuidanceIntent';

export type GuidanceExecutionReason = NonNullable<NonNullable<NonNullable<MessageMetadata['runtimeDecision']>['guidanceExecution']>['finalReason']>;
export type GuidanceRejectionReason = NonNullable<NonNullable<NonNullable<MessageMetadata['runtimeDecision']>['guidanceExecution']>['rejectedReasons']>[number];

export interface GuidanceExecutionEvaluation {
  matched: boolean;
  reason: GuidanceExecutionReason;
}

export interface GuidanceExecutionOptions {
  mediaCapabilities?: {
    image?: boolean;
    video?: boolean;
    audio?: boolean;
  };
  /** Structured media decisions returned for individual message segments. */
  mediaDecisions?: MediaGenerationDecision[];
}

export interface GuidanceProgressSnapshot {
  matchedMessages: Message[];
  completedActorIds: Set<string>;
  consumedTurns: number;
}

function hasImageAttachment(message: Pick<Message, 'metadata'>) {
  return Boolean(
    message.metadata?.generationDecision?.image?.shouldGenerate
    || message.metadata?.attachments?.some((attachment) => attachment.kind === 'image' && attachment.status !== 'deleted' && attachment.status !== 'failed'),
  );
}

function getMessageRuntimeGuidance(message: Pick<Message, 'metadata'>): UserGuidanceIntent | null {
  const guidance = message.metadata?.runtimeDecision?.directorIntent?.userGuidance;
  if (!guidance || typeof guidance.kind !== 'string') return null;
  return guidance as UserGuidanceIntent;
}

function getMessageGuidanceExecutionStatus(message: Pick<Message, 'metadata'>) {
  return message.metadata?.runtimeDecision?.guidanceExecution || null;
}

function isSameGuidance(left: UserGuidanceIntent | null | undefined, right: UserGuidanceIntent | null | undefined) {
  if (!left || !right) return false;
  return left.kind === right.kind && left.rawText === right.rawText;
}

export function isGuidanceSatisfiedByMessage(message: Message, guidance: UserGuidanceIntent, characters?: AICharacter[]) {
  if (message.type !== 'ai' || message.isDeleted) return false;
  const execution = getMessageGuidanceExecutionStatus(message);
  if (execution?.status === 'accepted' && execution.validated && isSameGuidance(getMessageRuntimeGuidance(message), guidance)) {
    return true;
  }
  return evaluateGuidanceMessage(message, guidance, characters).matched;
}

export function collectGuidanceProgressAfterTimestamp(
  messages: Message[],
  timestamp: number,
  guidance: UserGuidanceIntent,
  characters?: AICharacter[],
): GuidanceProgressSnapshot {
  const matchedMessages = messages
    .filter((message) => message.timestamp > timestamp && isGuidanceSatisfiedByMessage(message, guidance, characters))
    .sort((left, right) => left.timestamp - right.timestamp);
  return {
    matchedMessages,
    completedActorIds: new Set(matchedMessages.map((message) => message.senderId)),
    consumedTurns: matchedMessages.length,
  };
}

function imageAttachmentMatchesGuidance(message: Pick<Message, 'metadata'>, guidance: UserGuidanceIntent) {
  if (!hasImageAttachment(message)) return false;
  if (isSameGuidance(getMessageRuntimeGuidance(message), guidance)) return true;
  return true;
}

function evaluateMediaGuidanceContent(guidance: UserGuidanceIntent, options?: GuidanceExecutionOptions): GuidanceExecutionReason {
  const request = guidance.mediaRequest;
  if (!request) return 'matched';
  const hasStructuredImageDecision = options?.mediaDecisions?.some((decision) => (
    decision.images?.some((image) => image.shouldGenerate === true)
    || decision.image?.shouldGenerate === true
  ));
  if (hasStructuredImageDecision) return 'matched';
  if (request.kind === 'image' && options?.mediaCapabilities?.image === false) return 'matched';
  if (request.kind === 'video' && options?.mediaCapabilities?.video === false) return 'matched';
  return request.kind === 'video' ? 'missing_requested_video' : 'missing_requested_image';
}

export function evaluateGuidanceGeneratedContent(
  content: string,
  guidance: UserGuidanceIntent | null | undefined,
  speaker: Pick<AICharacter, 'id'> | string | null | undefined,
  _characters?: AICharacter[],
  options?: GuidanceExecutionOptions,
): GuidanceExecutionEvaluation {
  if (!guidance) return { matched: true, reason: 'matched' };
  if (!content.trim()) return { matched: false, reason: 'empty_content' };
  const speakerId = typeof speaker === 'string' ? speaker : speaker?.id;
  if (guidance.actorIds.length && (!speakerId || !guidance.actorIds.includes(speakerId))) {
    if (speakerId && (
      guidance.suppressedActorIds?.includes(speakerId)
      || guidance.deferredActorIds?.includes(speakerId)
    )) return { matched: false, reason: 'suppression_handoff_required' };
    // The scheduler may deliberately choose a third-party guardian after the
    // requested actor has had the floor. Whether that line protects or hijacks
    // the floor is semantic; do not pretend a local string validator can judge
    // it. The prompt and model-authored runtime guidance remain authoritative.
    if (guidance.suppressedActorIds?.length || guidance.deferredActorIds?.length) {
      return { matched: true, reason: 'matched' };
    }
    return { matched: false, reason: 'wrong_speaker' };
  }
  if (guidance.kind === 'media_request') {
    const reason = evaluateMediaGuidanceContent(guidance, options);
    return { matched: reason === 'matched', reason };
  }
  return { matched: true, reason: 'matched' };
}

export function evaluateGuidanceMessage(message: Message, guidance: UserGuidanceIntent, characters?: AICharacter[]): GuidanceExecutionEvaluation {
  if (message.type !== 'ai' || message.isDeleted) return { matched: false, reason: 'empty_content' };
  if (guidance.actorIds.length && !guidance.actorIds.includes(message.senderId)) return { matched: false, reason: 'wrong_speaker' };
  if (guidance.kind === 'media_request' && imageAttachmentMatchesGuidance(message, guidance)) {
    return { matched: true, reason: 'matched' };
  }
  return evaluateGuidanceGeneratedContent(message.content || '', guidance, message.senderId, characters);
}
