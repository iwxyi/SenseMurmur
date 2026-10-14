import type { AICharacter } from '../types/character';
import type { DriverMessageCommitResult, GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { APIConfig, AIModelProfile } from '../types/settings';
import type { SessionGenerationPromptContext } from '../types/sessionEngine';
import { createStreamingLocalMessage } from './chatCommitMessage';
import { commitGeneratedMessageTurn } from './generatedMessageTurnCommit';
import { EmptyGeneratedResponseError, generateSpeakerMessage, type LocalInterceptionEvent } from './chatEngine';
import { attachMessageToActiveBranch } from './messageBranching';
import { GenerationCancelledError, isGenerationCancelledError } from './generationCancellation';
import { hasRenderableStreamingContent } from './streamingContentGuard';
import { createStreamingMessageDisplay } from './streamingMessageDisplay';
import { useSettingsStore } from '../stores/useSettingsStore';

function ensureGenerationStillCurrent(params: { signal?: AbortSignal; shouldContinue?: () => boolean }) {
  if (params.signal?.aborted) throw new GenerationCancelledError();
  if (params.shouldContinue && !params.shouldContinue()) throw new GenerationCancelledError('生成所属分支已切换');
}

export async function generateAndCommitAiMessage(params: {
  api: APIConfig;
  aiProfiles: AIModelProfile[];
  chatId: string;
  chat: GroupChat;
  speaker: AICharacter;
  characters: AICharacter[];
  currentMessages: Message[];
  timestamp?: number;
  streamingMessage?: Message | null;
  onChunk?: (content: string) => void;
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
  onLocalInterception?: (event: LocalInterceptionEvent) => void | Promise<void>;
  generationContext?: {
    knownConversations?: GroupChat[];
    promptContext?: SessionGenerationPromptContext | null;
    buildPromptContext?: (speaker: AICharacter) => SessionGenerationPromptContext | null | undefined;
  };
  onCommit: (args: {
    conversation: GroupChat;
    characters: AICharacter[];
    message: Pick<Message, 'content' | 'type' | 'senderId' | 'metadata'>;
    previousAiMessage: Pick<Message, 'senderId'> | null;
    recentMessages?: Message[];
    apiConfig?: APIConfig;
  }) => DriverMessageCommitResult | Promise<DriverMessageCommitResult>;
  upsertMessage: (message: Message) => void;
  updateCharacter: (id: string, patch: Partial<AICharacter>) => Promise<void>;
  updateCharacters?: (patches: Array<{ id: string; patch: Partial<AICharacter> }>) => Promise<void>;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number], sourceMessageId?: string) => Promise<void>;
  appendEventMessages?: (chatId: string, payloads: DriverMessageCommitResult['runtimeEvents'], sourceMessageId?: string) => Promise<void>;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  applyChatRuntimeDelta?: (id: string, delta: NonNullable<DriverMessageCommitResult['chatRuntimeDelta']>, patch?: Partial<GroupChat>) => Promise<void>;
  recordSpeak: (characterId: string) => void;
  getCurrentChat?: (id: string) => GroupChat | undefined;
  getCurrentCharacters?: () => AICharacter[];
}) {
  ensureGenerationStillCurrent(params);
  const placeholder = params.streamingMessage || createStreamingLocalMessage(attachMessageToActiveBranch(params.chat, params.currentMessages, {
    chatId: params.chatId,
    type: 'ai',
    senderId: params.speaker.id,
    senderName: params.speaker.name,
    content: '',
    emotion: 0,
  }), { timestamp: params.timestamp });
  let streamingMessage = { ...placeholder, isStreaming: true };
  const display = createStreamingMessageDisplay({
    upsertMessage: params.upsertMessage,
    isAnimationEnabled: () => useSettingsStore.getState().enableStreamingDisplayAnimation,
  });
  display.update(streamingMessage, { immediate: true });
  let commitStarted = false;

  try {
    const message = await generateSpeakerMessage({
      chat: params.chat,
      speaker: params.speaker,
      characters: params.characters,
      messages: params.currentMessages,
      apiConfig: params.aiProfiles.length ? params.aiProfiles : params.api,
      profiles: params.aiProfiles,
      generationContext: params.generationContext,
      onLocalInterception: params.onLocalInterception,
      signal: params.signal,
      onChunk: (content) => {
        ensureGenerationStillCurrent(params);
        if (!hasRenderableStreamingContent(content)) return;
        streamingMessage = { ...streamingMessage, content, isStreaming: true };
        display.update(streamingMessage);
        params.onChunk?.(content);
      },
    });

    ensureGenerationStillCurrent(params);
    display.freeze();
    commitStarted = true;
    return await commitGeneratedMessageTurn({
      api: params.api,
      chatId: params.chatId,
      chat: params.chat,
      characters: params.characters,
      message,
      streamingMessage: display.getDisplayed(),
      currentMessages: params.currentMessages,
      onCommit: params.onCommit,
      upsertMessage: params.upsertMessage,
      updateCharacter: params.updateCharacter,
      updateCharacters: params.updateCharacters,
      appendEventMessage: params.appendEventMessage,
      appendEventMessages: params.appendEventMessages,
      updateChat: params.updateChat,
      applyChatRuntimeDelta: params.applyChatRuntimeDelta,
      recordSpeak: params.recordSpeak,
      aiProfiles: params.aiProfiles,
      getCurrentChat: params.getCurrentChat,
      getCurrentCharacters: params.getCurrentCharacters,
      shouldContinue: () => !params.signal?.aborted && (params.shouldContinue?.() ?? true),
    });
  } catch (error) {
    display.freeze();
    if (!commitStarted && (isGenerationCancelledError(error) || error instanceof EmptyGeneratedResponseError)) {
      params.upsertMessage({ ...(display.getDisplayed() || streamingMessage), content: '', isDeleted: true, isStreaming: true });
    }
    throw error;
  }
}
