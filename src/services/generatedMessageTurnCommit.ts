import type { AICharacter } from '../types/character';
import type { DriverMessageCommitResult, GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { APIConfig, AIModelProfile } from '../types/settings';
import type { GeneratedRoundMessage } from './chatEngine';
import { splitGeneratedRoundMessage } from './generatedMessageSegmenter';
import { runSessionCommitPipeline, type SessionCommitPipelineResult } from './sessionCommitPipeline';
import { useSettingsStore } from '../stores/useSettingsStore';
import { createStreamingLocalMessage, revealMessageInPlace } from './chatCommitMessage';
import { attachMessageToActiveBranch } from './messageBranching';
import { GenerationCancelledError } from './generationCancellation';

export async function commitGeneratedMessageTurn(params: {
  api: APIConfig;
  chatId: string;
  chat: GroupChat;
  characters: AICharacter[];
  message: GeneratedRoundMessage;
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
  aiProfiles?: AIModelProfile[];
  getCurrentChat?: (id: string) => GroupChat | undefined;
  getCurrentCharacters?: () => AICharacter[];
  shouldContinue?: () => boolean;
}) {
  const segments = splitGeneratedRoundMessage(params.message);
  let workingChat = params.chat;
  let workingCharacters = params.characters;
  let workingMessages = [...params.currentMessages];
  const results: SessionCommitPipelineResult[] = [];
  const animateLocalReveal = useSettingsStore.getState().enableStreamingDisplayAnimation;
  const turnIdentitySalt = `turn:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

  for (let index = 0; index < segments.length; index += 1) {
    if (params.shouldContinue?.() === false) throw new GenerationCancelledError();
    const segmentMessage = segments[index];
    const streamingMessage = (index === 0 ? params.streamingMessage : null)
      || createStreamingLocalMessage(attachMessageToActiveBranch(workingChat, workingMessages, {
        ...segmentMessage,
        content: '',
      }), { identitySalt: `${turnIdentitySalt}:${index}` });
    let locallyCommitted = false;
    try {
      if (animateLocalReveal) {
        await revealMessageInPlace({
          message: streamingMessage,
          content: segmentMessage.content,
          initialContent: streamingMessage.content,
          keepStreaming: true,
          upsertMessage: params.upsertMessage,
          shouldContinue: params.shouldContinue,
        });
      }
      if (params.shouldContinue?.() === false) throw new GenerationCancelledError();
      const result = await runSessionCommitPipeline({
        api: params.api,
        chatId: params.chatId,
        chat: workingChat,
        characters: workingCharacters,
        message: segmentMessage,
        streamingMessage,
        // All entry points reveal here; persistence must not start another animation.
        localReveal: false,
        localRevealStartDelayMs: undefined,
        localMessageIdentitySalt: `${turnIdentitySalt}:${index}`,
        currentMessages: workingMessages,
        onCommit: params.onCommit,
        upsertMessage: (message) => {
          if (message.id === streamingMessage.id && !message.isStreaming && !message.isDeleted) locallyCommitted = true;
          params.upsertMessage(message);
        },
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
        shouldContinue: params.shouldContinue,
      });
      results.push(result);
      workingChat = result.nextChat;
      workingCharacters = result.nextCharacters;
      workingMessages = workingMessages.concat(result.persistedMessage);
      if (result.persistedMessage.metadata?.withdrawal?.withdrawn) break;
    } catch (error) {
      // Runtime work can fail after the bubble has been saved. Only remove
      // the uncommitted preview, leaving saved history intact.
      if (!locallyCommitted) {
        const cancelled = error instanceof GenerationCancelledError;
        const report = cancelled ? console.info : console.error;
        report('[chat-run:stream-preview-discarded]', {
          chatId: params.chatId,
          speakerId: segmentMessage.senderId,
          reason: cancelled ? 'segment_cancelled' : 'segment_commit_failed',
          segmentIndex: index,
          committedSegmentCount: results.length,
          previewContentLength: streamingMessage.content.length,
          generatedContentLength: segmentMessage.content.length,
          errorName: error instanceof Error ? error.name : null,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        params.upsertMessage({ ...streamingMessage, isDeleted: true, isStreaming: true });
      }
      throw error;
    }
  }

  return {
    segments,
    results,
  };
}
