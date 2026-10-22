import type { AICharacter } from '../types/character';
import type { GroupChat, DriverMessageCommitResult, DriverMessageCommitTransition } from '../types/chat';
import type { Message } from '../types/message';
import type { APIConfig, AIModelProfile } from '../types/settings';
import { mergeSessionChatPatch } from '../types/sessionEngine';
import { runChatCommitPipeline } from './chatCommitPipeline';
import { applyChatCommitRuntime } from './chatCommitApply';
import { finalizeChatCommitRuntime } from './chatCommitRuntime';
import { loadSessionEngine } from './sessionEngineLoader';
import { __flushDeferredMemoryAnalysisForTests, __resetDeferredMemoryAnalysisStateForTests, getDeferredMemoryAnalysisDebugState, scheduleAsyncMemoryAnalysis } from './asyncMemoryAnalysis';
import { applyRecalledMemoryActivation } from './memoryRecallActivation';
import { parseRuntimeEvent } from './runtimeEventFactory';
import { reportRecoverableError } from './diagnostics';
import { applyCalendarAutoPatchForChat, buildCalendarAutoPatchRuntimeEventPayloads, shouldRunCalendarAutoPatchForTransition } from './worldCalendarAutoPatchRuntime';
import { applyPresenceUpdateToTransition } from './characterPresence';
import { buildBranchStateWithHead, isMessageBranchingEnabled } from './messageBranching';
import { buildChatRuntimeDeltaPatch } from './chatRuntimeDelta';
import { scheduleFactRecording } from './factualMemory';

export const __resetDeferredLlmDistillationStateForTests = __resetDeferredMemoryAnalysisStateForTests;
export const __flushDeferredLlmDistillationForTests = __flushDeferredMemoryAnalysisForTests;
export const getDeferredLlmDistillationDebugState = getDeferredMemoryAnalysisDebugState;

const deferredCalendarAutoPatchTasks = new Set<Promise<void>>();

export function __resetDeferredCalendarAutoPatchStateForTests() {
  deferredCalendarAutoPatchTasks.clear();
}

export async function __flushDeferredCalendarAutoPatchForTests() {
  await Promise.allSettled(Array.from(deferredCalendarAutoPatchTasks));
}

export interface SessionCommitPipelineResult {
  persistedMessage: Message;
  transition: DriverMessageCommitResult;
  nextChat: GroupChat;
  nextCharacters: AICharacter[];
}

type SessionCommitHandler = Parameters<typeof runChatCommitPipeline>[0]['onCommit'];

function isLocalInterceptionMessage(message: Message) {
  return message.type === 'event' && parseRuntimeEvent(message.content)?.eventType === 'local_interception';
}

function withFrameworkChatPatch(onCommit: SessionCommitHandler): SessionCommitHandler {
  return async (args) => {
    const transition = await onCommit(args);
    const engine = await loadSessionEngine(args.conversation);
    return {
      ...transition,
      chatPatch: mergeSessionChatPatch(engine, args.conversation, transition.chatPatch),
    };
  };
}

function wrapCommitWithFrameworkPatch(params: Parameters<typeof runChatCommitPipeline>[0]): SessionCommitHandler {
  return withFrameworkChatPatch(params.onCommit);
}

function applyTransitionToChat(chat: GroupChat, transition: DriverMessageCommitTransition) {
  return {
    ...chat,
    ...transition.chatPatch,
    ...(transition.chatRuntimeDelta ? buildChatRuntimeDeltaPatch(chat, transition.chatRuntimeDelta) : {}),
  } as GroupChat;
}

function applyTransitionToCharacters(characters: AICharacter[], transition: DriverMessageCommitTransition) {
  const patchMap = new Map(transition.characterPatches.map((item) => [item.characterId, item.patch] as const));
  return characters.map((character) => {
    const patch = patchMap.get(character.id);
    return patch ? { ...character, ...patch } : character;
  });
}

function scheduleCalendarAutoPatch(params: {
  api: APIConfig;
  chatId: string;
  chat: GroupChat;
  characters: AICharacter[];
  sourceMessageId: string;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number], sourceMessageId?: string) => Promise<void>;
  appendEventMessages?: (chatId: string, payloads: DriverMessageCommitResult['runtimeEvents'], sourceMessageId?: string) => Promise<void>;
}) {
  const task = (async () => {
    try {
      const autoPatch = await applyCalendarAutoPatchForChat({
        chat: params.chat,
        characters: params.characters,
        textApiConfig: params.api,
        updateChat: params.updateChat,
      });
      const autoPatchRuntimeEvents = buildCalendarAutoPatchRuntimeEventPayloads(autoPatch.appendedRuntimeEvents);
      if (!autoPatchRuntimeEvents.length) return;
      if (params.appendEventMessages) {
        await params.appendEventMessages(params.chatId, autoPatchRuntimeEvents, params.sourceMessageId);
        return;
      }
      for (const eventPayload of autoPatchRuntimeEvents) {
        await params.appendEventMessage(params.chatId, eventPayload, params.sourceMessageId);
      }
    } catch (error) {
      reportRecoverableError({
        location: 'runtime:auto-calendar-patch',
        error,
        userMessage: '日历冲突自动修正失败，可在日历页手动应用草案。',
      });
    }
  })().finally(() => {
    deferredCalendarAutoPatchTasks.delete(task);
  });
  deferredCalendarAutoPatchTasks.add(task);
  void task;
}

async function finishAppliedSessionTransition(params: {
  api: APIConfig;
  chatId: string;
  chat: GroupChat;
  characters: AICharacter[];
  persistedMessage: Message;
  currentMessages: Message[];
  transition: DriverMessageCommitTransition;
  updateCharacter: (id: string, patch: Partial<AICharacter>) => Promise<void>;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number], sourceMessageId?: string) => Promise<void>;
  appendEventMessages?: (chatId: string, payloads: DriverMessageCommitResult['runtimeEvents'], sourceMessageId?: string) => Promise<void>;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  getCurrentChat?: (id: string) => GroupChat | undefined;
  getCurrentCharacters?: () => AICharacter[];
  shouldContinue?: () => boolean;
}) {
  const transitionWithRecall = applyRecalledMemoryActivation({
    chat: params.chat,
    characters: params.characters,
    message: params.persistedMessage,
    recentMessages: params.currentMessages,
    transition: params.transition,
  });
  if (transitionWithRecall !== params.transition) {
    const recallPatch = transitionWithRecall.characterPatches.find((item) => item.characterId === params.persistedMessage.senderId)?.patch;
    if (recallPatch) {
      await params.updateCharacter(params.persistedMessage.senderId, recallPatch);
    }
    const recallEvents = transitionWithRecall.runtimeEvents.slice(params.transition.runtimeEvents.length);
    if (recallEvents.length) {
      if (params.appendEventMessages) {
        await params.appendEventMessages(params.chatId, recallEvents, params.persistedMessage.id);
      } else {
        for (const event of recallEvents) {
          await params.appendEventMessage(params.chatId, event, params.persistedMessage.id);
        }
      }
    }
  }
  const nextCharacters = applyTransitionToCharacters(params.characters, transitionWithRecall);
  const nextChat = applyTransitionToChat(params.chat, transitionWithRecall);
  scheduleFactRecording({ api: params.api, chat: params.getCurrentChat?.(params.chatId) || nextChat,
    messages: params.currentMessages, message: params.persistedMessage, appendEventMessage: params.appendEventMessage });
  if (shouldRunCalendarAutoPatchForTransition(transitionWithRecall)) {
    scheduleCalendarAutoPatch({
      api: params.api,
      chatId: params.chatId,
      chat: nextChat,
      characters: nextCharacters,
      sourceMessageId: params.persistedMessage.id,
      updateChat: params.updateChat,
      appendEventMessage: params.appendEventMessage,
      appendEventMessages: params.appendEventMessages,
    });
  }
  const characterIdsToCheck = transitionWithRecall.characterPatches
    .filter((item) => Array.isArray(item.patch.layeredMemories))
    .map((item) => item.characterId);
  void scheduleAsyncMemoryAnalysis({
    api: params.api,
    chat: nextChat,
    characters: nextCharacters,
    characterIdsToCheck,
    updateChat: params.updateChat,
    updateCharacter: params.updateCharacter,
    appendEventMessage: params.appendEventMessage,
    sourceMessageId: params.persistedMessage.id,
    getCurrentChat: params.getCurrentChat,
    getCurrentCharacters: params.getCurrentCharacters,
  });
  return {
    transition: transitionWithRecall,
    nextChat,
    nextCharacters,
  };
}

function getPreviousAiMessage(messages: Message[]) {
  return [...messages].reverse().find((message) => !message.isDeleted && message.type === 'ai') || null;
}

export async function runSessionCommitPipeline(params: {
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
  aiProfiles?: AIModelProfile[];
  getCurrentChat?: (id: string) => GroupChat | undefined;
  getCurrentCharacters?: () => AICharacter[];
  shouldContinue?: () => boolean;
  localReveal?: boolean;
  localRevealStartDelayMs?: number;
  localMessageIdentitySalt?: string;
}): Promise<SessionCommitPipelineResult> {
  const { persistedMessage, transition } = await runChatCommitPipeline({
    ...params,
    onCommit: wrapCommitWithFrameworkPatch(params),
  });
  const completed = await finishAppliedSessionTransition({
    ...params,
    persistedMessage,
    transition,
  });
  // A generated turn may contain several separately committed bubbles. Each
  // following segment must inherit the head created by the previous one;
  // otherwise all segments become sibling nodes and active-branch projection
  // correctly (but unexpectedly) hides every sibling except the last.
  const nextChat = isMessageBranchingEnabled(params.chat)
    ? {
        ...completed.nextChat,
        messageBranchState: buildBranchStateWithHead(
          completed.nextChat.messageBranchState || params.chat.messageBranchState,
          persistedMessage.metadata?.branching?.nodeId || persistedMessage.clientKey || persistedMessage.id,
        ),
      }
    : completed.nextChat;
  return {
    persistedMessage,
    transition: completed.transition,
    nextChat,
    nextCharacters: completed.nextCharacters,
  };
}

export async function runPersistedSessionCommitRuntime(params: {
  api: APIConfig;
  chatId: string;
  chat: GroupChat;
  characters: AICharacter[];
  message: Message;
  currentMessages: Message[];
  onCommit: SessionCommitHandler;
  updateCharacter: (id: string, patch: Partial<AICharacter>) => Promise<void>;
  updateCharacters?: (patches: Array<{ id: string; patch: Partial<AICharacter> }>) => Promise<void>;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number], sourceMessageId?: string) => Promise<void>;
  appendEventMessages?: (chatId: string, payloads: DriverMessageCommitResult['runtimeEvents'], sourceMessageId?: string) => Promise<void>;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  applyChatRuntimeDelta?: (id: string, delta: NonNullable<DriverMessageCommitResult['chatRuntimeDelta']>, patch?: Partial<GroupChat>) => Promise<void>;
  recordSpeak: (characterId: string) => void;
  getCurrentChat?: (id: string) => GroupChat | undefined;
  getCurrentCharacters?: () => AICharacter[];
}): Promise<SessionCommitPipelineResult> {
  const recentMessages = params.currentMessages.filter((message) => !message.isDeleted && message.id !== params.message.id && !isLocalInterceptionMessage(message));
  const transition = applyPresenceUpdateToTransition({
    message: params.message,
    chat: params.chat,
    characters: params.characters,
    transition: await finalizeChatCommitRuntime({
      api: params.api,
      chat: params.chat,
      characters: params.characters,
      message: params.message,
      previousAiMessage: getPreviousAiMessage(recentMessages),
      recentMessages,
      onCommit: withFrameworkChatPatch(params.onCommit),
    }),
  });
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
    sourceMessageId: params.message.id,
  });
  const completed = await finishAppliedSessionTransition({
    ...params,
    persistedMessage: params.message,
    currentMessages: recentMessages,
    transition,
  });
  return {
    persistedMessage: params.message,
    transition: completed.transition,
    nextChat: completed.nextChat,
    nextCharacters: completed.nextCharacters,
  };
}
