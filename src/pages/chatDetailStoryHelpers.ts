import { useMessageStore } from '../stores/useMessageStore';
import type { GroupChat, StoryReaderRole } from '../types/chat';
import type { Message } from '../types/message';
import type { NarrativeStoryChoiceOption } from '../components/chat/messageBubblePresentation';
import { messagesShareIdentity } from '../services/messageIdentity';
import { buildStoryBranchOptions, normalizeStoryChoiceSuggestions } from '../services/storyChoices';

export function buildStoryChoicePendingKey(params: {
  chatId: string;
  choiceEpoch?: number | null;
  sourceMessageId?: string | null;
}) {
  return `${params.chatId}:${params.choiceEpoch || 0}:${params.sourceMessageId || ''}`;
}

export function isStoryChoicePending(params: {
  pendingKey: string | null;
  chatId: string | null | undefined;
  choiceEpoch?: number | null;
  sourceMessageId?: string | null;
}) {
  if (!params.pendingKey || !params.chatId) return false;
  return params.pendingKey === buildStoryChoicePendingKey({
    chatId: params.chatId,
    choiceEpoch: params.choiceEpoch,
    sourceMessageId: params.sourceMessageId,
  });
}

export function getStoryTailStatus(params: {
  hasRunLoopStatus: boolean;
  isStoryChoiceSubmitting: boolean;
  isGeneratingStoryNode?: boolean;
  isWaitingForReaderTail?: boolean;
  isGenerationCancelled?: boolean;
}) {
  if (params.hasRunLoopStatus) return 'status' as const;
  if (params.isStoryChoiceSubmitting) return 'submitting_choice' as const;
  if (params.isGeneratingStoryNode) return 'generating_node' as const;
  if (params.isGenerationCancelled) return 'generation_cancelled' as const;
  if (params.isWaitingForReaderTail) return 'waiting_reader_tail' as const;
  return null;
}

export function shouldAutoStartStoryRoom(params: {
  hasChat: boolean;
  hasChatId: boolean;
  canAutoRunConversation: boolean;
  isStoryRoom: boolean;
  isStoryReaderAtTail: boolean;
  isRunning: boolean;
  isPaused: boolean;
  isStoryWaitingForChoice: boolean;
  isStoryChoiceSubmitting: boolean;
  hasUserDraft?: boolean;
  hasRunLoopError: boolean;
  canAutoContinueFromTail?: boolean;
  hasAcknowledgedNewTail?: boolean;
}) {
  return params.hasChat
    && params.hasChatId
    && params.canAutoRunConversation
    && params.isStoryRoom
    && params.isStoryReaderAtTail
    && !params.isRunning
    && !params.isPaused
    && !params.isStoryWaitingForChoice
    && !params.isStoryChoiceSubmitting
    && !params.hasUserDraft
    && !params.hasRunLoopError
    && params.hasAcknowledgedNewTail !== false
    && params.canAutoContinueFromTail !== false;
}

export function resolveEffectiveStoryReaderAtTail(params: {
  isStoryReaderAtTail: boolean;
  hasSavedNonTailStoryReadingPosition: boolean;
  hasStoryReaderReachedTailIntent: boolean;
}) {
  if (params.hasSavedNonTailStoryReadingPosition && !params.hasStoryReaderReachedTailIntent) return false;
  return params.isStoryReaderAtTail;
}

export function canAcknowledgeNewStoryTail(params: {
  awaitingNewTail: boolean;
  isRunning: boolean;
  latestMessageId: string | null;
  sourceMessageId: string | null;
}) {
  return params.awaitingNewTail && !params.isRunning
    && Boolean(params.latestMessageId && params.latestMessageId !== params.sourceMessageId);
}

export function getNarrativeRevealIdentityKeys(message: Message) {
  if (message.type !== 'ai' || !message.metadata?.narrativeTurn) return [];
  return [message.id, message.clientKey, message.serverId].filter((key): key is string => Boolean(key));
}

export function shouldRegisterLiveNarrativeReveal(message: Message) {
  const revealKeys = getNarrativeRevealIdentityKeys(message);
  if (!revealKeys.length) return false;
  const state = useMessageStore.getState();
  const currentMessages = state.messageWindowsByChatId[message.chatId]?.messages || state.messages.filter((item) => item.chatId === message.chatId);
  const existing = currentMessages.find((item) => messagesShareIdentity(item, message));
  if (existing?.isStreaming) return true;
  if (existing) return false;
  const latestHistoricalTimestamp = currentMessages
    .reduce((latest, item) => Math.max(latest, Number(item.timestamp || 0)), 0);
  return Number(message.timestamp || 0) > latestHistoricalTimestamp;
}

export function findVisibleStoryChoiceSourceMessage(params: {
  isStoryRoom: boolean;
  phase?: string | null;
  messages: Message[];
}) {
  if (!params.isStoryRoom || params.phase !== 'choice') return null;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (normalizeStoryChoiceSuggestions(message.metadata?.storyChoices).length < 2) continue;
    return message;
  }
  return null;
}

export function buildVisibleStoryBranchOptions(params: {
  isStoryRoom: boolean;
  chat?: GroupChat | null;
  sourceMessage?: Message | null;
}): NarrativeStoryChoiceOption[] {
  const sourceMessage = params.sourceMessage;
  if (!params.isStoryRoom || params.chat?.scenarioState?.phase !== 'choice' || !sourceMessage) return [];
  const storyChoices = normalizeStoryChoiceSuggestions(sourceMessage.metadata?.storyChoices);
  if (storyChoices.length < 2) return [];
  return buildStoryBranchOptions({
    storyChoices,
    branches: params.chat.scenarioState?.branches,
    choiceEpoch: params.chat.scenarioState?.choiceEpoch,
    sourceId: sourceMessage.id,
  });
}

export function shouldRouteTextAsStoryCustomDirection(params: {
  isStoryRoom: boolean;
  hasSpeakAsCharacter: boolean;
  hasGuideTargetMember: boolean;
  content: string;
}) {
  return params.isStoryRoom
    && !params.hasSpeakAsCharacter
    && !params.hasGuideTargetMember
    && Boolean(params.content.trim());
}

export function getStoryReaderComposerPlaceholder(readerRole: StoryReaderRole = 'director') {
  return readerRole === 'participant' ? '写我的行动' : '安排剧情';
}

export function buildStoryReaderTextInputCapabilities<T extends { imageInput?: boolean; multiImageInput?: boolean; fileInput?: boolean }>(capabilities: T): T {
  return {
    ...capabilities,
    imageInput: false,
    multiImageInput: false,
    fileInput: false,
  };
}
