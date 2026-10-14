import type { AICharacter } from '../types/character';
import type { GroupChat, DriverMessageCommitResult } from '../types/chat';
import type { Message } from '../types/message';
import type { APIConfig } from '../types/settings';
import { persistStreamingMessage } from './chatCommitMessage';
import { buildChatCommitContext } from './chatCommitContext';
import { finalizeChatCommitRuntime } from './chatCommitRuntime';
import { applyChatCommitRuntime } from './chatCommitApply';
import { createRuntimeMemoryTimer } from './runtimeMemoryTimer';
import { isLocalOnlyMediaMode, processRichMessageMedia } from './richMessageMedia';
import { parseRuntimeEvent } from './runtimeEventFactory';
import { attachMessageToActiveBranch, buildBranchStateWithHead, isMessageBranchingEnabled } from './messageBranching';
import { applyPresenceUpdateToTransition } from './characterPresence';
import { useSettingsStore } from '../stores/useSettingsStore';
import { logDeveloperDiagnostic } from './developerDiagnostics';
import { isGenerationCancelledError } from './generationCancellation';

export interface ChatCommitPipelineResult {
  persistedMessage: Message;
  transition: DriverMessageCommitResult;
}

function isLocalInterceptionMessage(message: Message) {
  return message.type === 'event' && parseRuntimeEvent(message.content)?.eventType === 'local_interception';
}

export async function runChatCommitPipeline(params: {
  api: APIConfig;
  chatId: string;
  chat: GroupChat;
  characters: AICharacter[];
  message: Omit<Message, 'id' | 'timestamp' | 'isDeleted'>;
  streamingMessage?: Message | null;
  currentMessages: Message[];
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
  aiProfiles?: import('../types/settings').AIModelProfile[];
  shouldContinue?: () => boolean;
  localReveal?: boolean;
  localRevealStartDelayMs?: number;
  localMessageIdentitySalt?: string;
  getCurrentChat?: (id: string) => GroupChat | undefined;
}): Promise<ChatCommitPipelineResult> {
  const startedAt = Date.now();
  let phase = 'persist-message';
  let locallyPersisted = false;
  const enterPhase = (next: string) => {
    phase = next;
    logDeveloperDiagnostic('chat-run:commit-stage', {
      chatId: params.chatId,
      phase,
      elapsedMs: Date.now() - startedAt,
      locallyPersisted,
      node: params.streamingMessage?.metadata?.branching?.nodeId?.slice(-12) || null,
      parent: params.streamingMessage?.metadata?.branching?.parentNodeId?.slice(-12) || null,
      loadedMessages: params.currentMessages.length,
    }, 'debug', 'chat-run');
  };
  const timer = createRuntimeMemoryTimer('chat-commit', {
    chatId: params.chatId,
    speakerId: params.message.senderId,
    chat: params.chat,
    characters: params.characters,
    messages: params.currentMessages,
  });

  try {
    enterPhase('persist-message');
    const nextMessages = params.currentMessages.filter((message) => !message.isDeleted && message.id !== params.streamingMessage?.id && !isLocalInterceptionMessage(message));
    let mediaProcessingStarted = false;
    const startMediaProcessing = (message: Message) => {
      if (!params.aiProfiles?.length) return;
      if (mediaProcessingStarted) return;
      if (!message.metadata?.attachments?.some((item) => item.status === 'queued')) return;
      mediaProcessingStarted = true;
      const speaker = params.characters.find((character) => character.id === message.senderId);
      void processRichMessageMedia({
        message,
        character: speaker,
        characters: params.characters,
        messages: params.currentMessages,
        aiProfiles: params.aiProfiles || [],
        upsertMessage: params.upsertMessage,
      });
    };
    const streamingAnimationEnabled = useSettingsStore.getState().enableStreamingDisplayAnimation;
    const localReveal = params.localReveal ?? Boolean(params.streamingMessage && streamingAnimationEnabled);
    const localRevealStartDelayMs = params.localRevealStartDelayMs ?? (localReveal ? 260 : undefined);
    const persistedMessage = await persistStreamingMessage({
      message: attachMessageToActiveBranch(params.chat, nextMessages, {
        ...params.message,
        metadata: {
          ...params.message.metadata,
          ...(params.streamingMessage?.metadata?.branching
            ? { branching: params.streamingMessage.metadata.branching }
            : {}),
        },
      }),
      upsertMessage: params.upsertMessage,
      existingLocalMessage: params.streamingMessage,
      shouldContinue: params.shouldContinue,
      deferLocalUpsert: false,
      localReveal,
      localRevealStartDelayMs,
      localMessageIdentitySalt: params.localMessageIdentitySalt,
      onPersisted: (message) => {
        if (!isLocalOnlyMediaMode()) startMediaProcessing(message);
      },
    });
    locallyPersisted = true;
    enterPhase('advance-branch-head');
    if (isMessageBranchingEnabled(params.chat)) {
      const nodeId = persistedMessage.metadata?.branching?.nodeId || persistedMessage.clientKey || persistedMessage.id;
      await params.updateChat(params.chatId, {
        messageBranchState: buildBranchStateWithHead(
          (params.getCurrentChat?.(params.chatId) || params.chat).messageBranchState, nodeId,
        ),
      });
    }
    if (params.aiProfiles?.length && persistedMessage.metadata?.attachments?.some((item) => item.status === 'queued')) {
      if (isLocalOnlyMediaMode() || persistedMessage.serverId) {
        startMediaProcessing(persistedMessage);
      } else {
        params.upsertMessage({
          ...persistedMessage,
          metadata: {
            ...(persistedMessage.metadata || {}),
            generation: {
              ...(persistedMessage.metadata?.generation || {}),
              status: 'queued',
              updatedAt: Date.now(),
            },
          },
        });
      }
    }
    timer.mark('after-persist-message', {
      messages: nextMessages.concat(persistedMessage),
      extra: {
        persistedMessageId: persistedMessage.id,
        reusedStreamingMessage: Boolean(params.streamingMessage?.id && params.streamingMessage.id === persistedMessage.id),
      },
    });

    const commitContext = buildChatCommitContext(nextMessages);
    enterPhase('finalize-runtime');
    const transition = applyPresenceUpdateToTransition({
      message: persistedMessage,
      chat: params.chat,
      characters: params.characters,
      transition: await finalizeChatCommitRuntime({
        api: params.api,
        chat: params.chat,
        characters: params.characters,
        message: persistedMessage,
        previousAiMessage: commitContext.previousAiMessage,
        recentMessages: nextMessages,
        onCommit: params.onCommit,
      }),
    });
    timer.mark('after-finalize-runtime', { transition });

    enterPhase('apply-runtime');
    await applyChatCommitRuntime({
      chatId: params.chatId,
      transition,
      updateCharacter: params.updateCharacter,
      updateCharacters: params.updateCharacters,
      appendEventMessage: params.appendEventMessage,
      appendEventMessages: params.appendEventMessages,
      updateChat: params.updateChat,
      applyChatRuntimeDelta: params.applyChatRuntimeDelta,
      recordSpeak: params.recordSpeak,
      speakerId: params.message.senderId,
      sourceMessageId: persistedMessage.id,
    });
    timer.mark('after-apply-runtime', { transition });

    timer.finish({ transition });
    enterPhase('finished');
    return {
      persistedMessage,
      transition,
    };
  } catch (error) {
    if (!isGenerationCancelledError(error)) {
      console.error('[chat-commit:failed]', {
        phase,
        elapsedMs: Date.now() - startedAt,
        locallyPersisted,
        loadedMessages: params.currentMessages.length,
        error,
      });
    }
    timer.mark('error', {
      extra: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
