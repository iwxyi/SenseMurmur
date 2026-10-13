import { useCallback, useRef, useState } from 'react';
import type { AICharacter } from '../types/character';
import type { DriverMessageCommitResult, GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { APIConfig, AIModelProfile } from '../types/settings';
import { createStreamingLocalMessage } from '../services/chatCommitMessage';
import type { LocalInterceptionEvent } from '../services/chatEngine';
import { projectCurrentChatMessages } from '../services/currentChatMessages';
import { logDeveloperDiagnostic } from '../services/developerDiagnostics';
import { attachMessageToActiveBranch } from '../services/messageBranching';
import { hasRenderableStreamingContent } from '../services/streamingContentGuard';
import { getStoryChoiceGateState } from '../services/storyChoices';
import type { UserDraftActivity } from '../services/userInputBuffer';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSchedulerStore } from '../stores/useSchedulerStore';
import { isGenerationCancelledError } from '../services/generationCancellation';
import { runSessionLoop as runChatLoop } from '../services/sessionRunner';

export type ConversationLoopStartBlockReason = 'direct_chat' | 'waiting_story_choice' | 'already_active';
type ConversationLoopStartOptions = { ignoreReaderPositionOnce?: boolean; immediate?: boolean; allowDirect?: boolean };
const DEFAULT_CONVERSATION_LOOP_START_DELAY_MS = 100;

export function getConversationLoopStartBlockReason(params: {
  conversationType?: GroupChat['type'] | null;
  isRunning: boolean;
  isPaused: boolean;
  isStoryChoiceBlocked: boolean;
  hasActiveLoop: boolean;
  allowDirect?: boolean;
}): ConversationLoopStartBlockReason | null {
  if ((params.conversationType === 'direct' || params.conversationType === 'ai_direct') && !params.allowDirect) return 'direct_chat';
  if (params.isStoryChoiceBlocked) return 'waiting_story_choice';
  if (params.isRunning && !params.isPaused && params.hasActiveLoop) return 'already_active';
  return null;
}

export function shouldSkipConversationLoopStart(params: {
  isRunning: boolean;
  isPaused: boolean;
  isStoryChoiceBlocked: boolean;
  hasActiveLoop: boolean;
}) {
  return getConversationLoopStartBlockReason({ ...params, conversationType: 'group' }) === 'already_active';
}

export function shouldStartConversationLoop(params: {
  conversationType?: GroupChat['type'] | null;
  isRunning: boolean;
  isPaused: boolean;
  isStoryChoiceBlocked: boolean;
  hasActiveLoop: boolean;
  allowDirect?: boolean;
}) {
  return getConversationLoopStartBlockReason(params) === null;
}

export function shouldCreateSpeakerStreamingPlaceholder(chat?: Pick<GroupChat, 'sessionKind'> | null) {
  return chat?.sessionKind?.scenarioId !== 'story-reader';
}

export function resolveConversationLoopStartDelayMs(options: ConversationLoopStartOptions = {}) {
  return options.immediate ? 0 : DEFAULT_CONVERSATION_LOOP_START_DELAY_MS;
}

export function shouldTreatActiveLoopAsSuccessfulStart(params: {
  blockReason: ConversationLoopStartBlockReason | null;
  hasActiveLoop: boolean;
}) {
  return params.blockReason === 'already_active' && params.hasActiveLoop;
}

export function useChatRunLoop(params: {
  chat: GroupChat | undefined;
  chatId: string | undefined;
  activeMembers: AICharacter[];
  api: APIConfig | AIModelProfile[];
  aiProfiles: AIModelProfile[];
  isRunningRef: React.MutableRefObject<boolean>;
  isPausedRef: React.MutableRefObject<boolean>;
  loopTokenRef: React.MutableRefObject<string | null>;
  activeChatIdRef: React.MutableRefObject<string | null>;
  streamingMessageRef: React.MutableRefObject<Message | null>;
  getDisplayedStreamingMessage: () => Message | null;
  freezeStreamingDisplay: () => void;
  updateStreamingMessage: (updater: (current: Message | null) => Message | null, options?: { immediate?: boolean }) => void;
  onLocalInterception?: (event: LocalInterceptionEvent) => void | Promise<void>;
  discardStreamingMessage: () => void;
  clearStreamingMessageRef: () => void;
  isManualInputPending: () => boolean;
  isStoryReaderAtTail?: () => boolean;
  setCurrentSpeaker: (characterId: string | null) => void;
  resetAllCooldowns: () => void;
  start: (loopToken: string) => void;
  stop: () => void;
  pause: () => void;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  showErrorToast: (message: string) => void;
  t: (key: string) => string;
  upsertMessage: (message: Message) => void;
  updateCharacter: (id: string, patch: Partial<AICharacter>) => Promise<void>;
  updateCharacters: (patches: Array<{ id: string; updates: Partial<AICharacter> }>) => Promise<void>;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number]) => Promise<void>;
  appendEventMessages?: (chatId: string, payloads: DriverMessageCommitResult['runtimeEvents'], sourceMessageId?: string) => Promise<void>;
  applyChatRuntimeDelta?: (id: string, delta: NonNullable<DriverMessageCommitResult['chatRuntimeDelta']>, patch?: Partial<GroupChat>) => Promise<void>;
  recordSpeak: (characterId: string) => void;
  getUserDraftActivity?: () => UserDraftActivity | null;
}) {
  const [thinkingId, setThinkingId] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [runLoopError, setRunLoopError] = useState<string | null>(null);
  const paramsRef = useRef(params);
  const activeRunLoopTokenRef = useRef<string | null>(null);
  const pendingCommitCountRef = useRef(0);
  const pendingTurnWorkCountRef = useRef(0);
  const runLoopRef = useRef<((loopId: string) => Promise<void>) | null>(null);
  const lastPauseGateLogKeyRef = useRef<string | null>(null);
  const ignoreReaderPositionLoopTokenRef = useRef<string | null>(null);
  const pendingStartChatByLoopTokenRef = useRef<Map<string, GroupChat>>(new Map());
  const pendingStartTimerByLoopTokenRef = useRef<Map<string, number>>(new Map());
  const activeAbortControllerRef = useRef<AbortController | null>(null);

  paramsRef.current = params;
  const isCommitSettled = useCallback(() => pendingCommitCountRef.current === 0, []);
  const hasPendingTurnWork = useCallback(() => Boolean(
    paramsRef.current.streamingMessageRef.current
    || pendingCommitCountRef.current > 0
    || pendingTurnWorkCountRef.current > 0,
  ), []);

  const runLoop = useCallback(async (loopId: string) => {
    const current = paramsRef.current;
    const startedChat = pendingStartChatByLoopTokenRef.current.get(loopId);
    const loopChat = startedChat || current.chat;
    const pendingTimer = pendingStartTimerByLoopTokenRef.current.get(loopId);
    if (pendingTimer) pendingStartTimerByLoopTokenRef.current.delete(loopId);
    if (!loopChat || !current.chatId) {
      pendingStartChatByLoopTokenRef.current.delete(loopId);
      return;
    }
    if (activeRunLoopTokenRef.current === loopId) {
      pendingStartChatByLoopTokenRef.current.delete(loopId);
      return;
    }
    activeRunLoopTokenRef.current = loopId;
    const moduleLoadStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const [{ loadSessionEngine }] = await Promise.all([
      import('../services/sessionEngineLoader'),
    ]);
    const sessionEngine = await loadSessionEngine(loopChat);
    logDeveloperDiagnostic('chat-run:modules-ready', {
      chatId: current.chatId,
      loopId,
      engineKey: sessionEngine.key,
      elapsedMs: Number(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - moduleLoadStartedAt).toFixed(2)),
    }, 'debug', 'chat-run');
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;
    try {
      await runChatLoop({
        loopId,
        chatId: current.chatId,
        chat: loopChat,
        characters: current.activeMembers,
        api: current.aiProfiles,
        getCurrentMessages: () => projectCurrentChatMessages({
          chatId: current.chatId!,
          chat: useChatStore.getState().chats.find((item) => item.id === current.chatId) || loopChat,
          activeMessages: useMessageStore.getState().messages,
          cachedWindow: useMessageStore.getState().messageWindowsByChatId[current.chatId!],
        }),
        getUserDraftActivity: current.getUserDraftActivity,
        getStreamingMessage: () => current.streamingMessageRef.current,
        getDisplayedStreamingMessage: current.getDisplayedStreamingMessage,
        getCurrentChat: () => useChatStore.getState().chats.find((item) => item.id === current.chatId),
        getCurrentCharacters: () => useCharacterStore.getState().characters,
        ensureCharacterDetail: (characterId) => useCharacterStore.getState().loadCharacter(characterId),
        isRunning: () => current.isRunningRef.current,
        isPaused: () => {
          const latestChat = useChatStore.getState().chats.find((item) => item.id === current.chatId);
          const latestMessages = projectCurrentChatMessages({
            chatId: current.chatId!,
            chat: latestChat || loopChat,
            activeMessages: useMessageStore.getState().messages,
            cachedWindow: useMessageStore.getState().messageWindowsByChatId[current.chatId!],
          });
          const storyChoiceGate = getStoryChoiceGateState(latestChat, latestMessages);
          const manualInputPending = current.isManualInputPending() && !current.streamingMessageRef.current && pendingCommitCountRef.current === 0;
          const storyReadPositionPaused = latestChat?.sessionKind?.scenarioId === 'story-reader'
            && !storyChoiceGate.waiting
            && ignoreReaderPositionLoopTokenRef.current !== loopId
            && Boolean(current.isStoryReaderAtTail && !current.isStoryReaderAtTail())
            && !current.streamingMessageRef.current
            && pendingCommitCountRef.current === 0
            && pendingTurnWorkCountRef.current === 0;
          const paused = current.isPausedRef.current || storyChoiceGate.waiting || manualInputPending || storyReadPositionPaused;
          if (paused) {
            const logKey = [
              current.chatId,
              current.isPausedRef.current ? 'manual' : '',
              storyChoiceGate.waiting ? `choice:${storyChoiceGate.choiceEpoch}:${storyChoiceGate.sourceMessageId}:${storyChoiceGate.mismatch}` : '',
              manualInputPending ? 'manual-input' : '',
              storyReadPositionPaused ? 'story-read-position' : '',
            ].filter(Boolean).join('|');
            if (logKey && lastPauseGateLogKeyRef.current !== logKey) {
              lastPauseGateLogKeyRef.current = logKey;
              logDeveloperDiagnostic('story-run:pause-gate', {
                chatId: current.chatId,
                loopId,
                manualPaused: current.isPausedRef.current,
                manualInputPending,
                storyReadPositionPaused,
                storyChoiceGate,
                pendingCommitCount: pendingCommitCountRef.current,
                pendingTurnWorkCount: pendingTurnWorkCountRef.current,
              }, storyChoiceGate.mismatch === 'none' ? 'info' : 'warn');
            }
          }
          return paused;
        },
        isActiveLoop: (currentLoopId) => current.activeChatIdRef.current === current.chatId && current.loopTokenRef.current === currentLoopId,
        onCommitSettled: isCommitSettled,
        onCommitStarted: () => {
          pendingCommitCountRef.current += 1;
        },
        onCommitFinished: () => {
          pendingCommitCountRef.current = Math.max(0, pendingCommitCountRef.current - 1);
        },
        pauseLoop: () => {
          current.isPausedRef.current = true;
          current.pause();
          void current.updateChat(current.chatId!, { isActive: false });
        },
        onTurnWorkStarted: () => {
          pendingTurnWorkCountRef.current += 1;
        },
        onTurnWorkFinished: () => {
          pendingTurnWorkCountRef.current = Math.max(0, pendingTurnWorkCountRef.current - 1);
        },
        onSpeakerSelected: (charId: string, speaker?: AICharacter) => {
          if (!shouldCreateSpeakerStreamingPlaceholder(loopChat)) {
            setRunLoopError(null);
            setThinkingId(null);
            current.setCurrentSpeaker(null);
            logDeveloperDiagnostic('story-run:generation-pending', {
              chatId: current.chatId,
              loopId,
              speakerId: charId,
              speakerName: speaker?.name || null,
              phase: loopChat.scenarioState?.phase || null,
            }, 'info');
            return;
          }
          current.discardStreamingMessage();
          const activeSpeaker = speaker || current.activeMembers.find((member) => member.id === charId);
          const latestChat = useChatStore.getState().chats.find((item) => item.id === current.chatId) || loopChat;
          const latestMessages = projectCurrentChatMessages({
            chatId: current.chatId!,
            chat: latestChat,
            activeMessages: useMessageStore.getState().messages,
            cachedWindow: useMessageStore.getState().messageWindowsByChatId[current.chatId!],
          });
          const streamingMessage = createStreamingLocalMessage(attachMessageToActiveBranch(latestChat, latestMessages, {
            chatId: current.chatId!,
            type: 'ai',
            senderId: charId,
            senderName: activeSpeaker?.name || '',
            content: '',
            emotion: 0,
          }));
          const nextStreamingMessage = { ...streamingMessage, isStreaming: true };
          current.updateStreamingMessage(() => nextStreamingMessage, { immediate: true });
          setRunLoopError(null);
          setThinkingId(charId);
          current.setCurrentSpeaker(charId);
        },
        onMessageChunk: (content) => {
          if (!hasRenderableStreamingContent(content)) return;
          current.updateStreamingMessage((message) => message ? { ...message, content, isStreaming: true } : message);
          setChatError(null);
        },
        onStreamingComplete: current.freezeStreamingDisplay,
        onLocalInterception: current.onLocalInterception,
        onIdle: (reason) => {
          current.discardStreamingMessage();
          setThinkingId(null);
          current.setCurrentSpeaker(null);
          setRunLoopError(reason);
        },
        onQuiet: () => {
          current.discardStreamingMessage();
          setThinkingId(null);
          current.setCurrentSpeaker(null);
          setRunLoopError(null);
        },
        onClearStreamingState: () => {
          current.clearStreamingMessageRef();
          setThinkingId(null);
          current.setCurrentSpeaker(null);
        },
        onEngineError: async (error) => {
          logDeveloperDiagnostic('story-run:engine-error', {
            error,
            chatId: current.chatId,
            loopId,
            activeChatId: current.activeChatIdRef.current,
            activeLoopToken: current.loopTokenRef.current,
            paused: current.isPausedRef.current,
            running: current.isRunningRef.current,
            streamingMessage: current.streamingMessageRef.current,
          }, 'error');
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[chat-run-loop:engine-error]', {
              error,
              chatId: current.chatId,
              loopId,
              activeChatId: current.activeChatIdRef.current,
              activeLoopToken: current.loopTokenRef.current,
              paused: current.isPausedRef.current,
              running: current.isRunningRef.current,
              streamingMessage: current.streamingMessageRef.current,
            });
          }
          current.discardStreamingMessage();
          setThinkingId(null);
          current.setCurrentSpeaker(null);
          current.isPausedRef.current = true;
          current.pause();
          const message = error.message || current.t('common.error');
          setChatError(message);
          setRunLoopError(message);
          current.showErrorToast(message);
          await current.updateChat(current.chatId!, { isActive: false });
        },
        onLoopError: (error) => {
          logDeveloperDiagnostic('story-run:loop-error', {
            error,
            chatId: current.chatId,
            loopId,
            activeChatId: current.activeChatIdRef.current,
            activeLoopToken: current.loopTokenRef.current,
            paused: current.isPausedRef.current,
            running: current.isRunningRef.current,
            streamingMessage: current.streamingMessageRef.current,
          }, 'error');
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[chat-run-loop:loop-error]', {
              error,
              chatId: current.chatId,
              loopId,
              activeChatId: current.activeChatIdRef.current,
              activeLoopToken: current.loopTokenRef.current,
              paused: current.isPausedRef.current,
              running: current.isRunningRef.current,
              streamingMessage: current.streamingMessageRef.current,
            });
          }
          const message = error instanceof Error ? error.message : String(error);
          const safeMessage = message || current.t('common.error');
          setRunLoopError(safeMessage);
        },
        onCommit: async (args) => {
          return await (sessionEngine.onMessageCommitted as (commitArgs: {
            conversation: GroupChat;
            characters: AICharacter[];
            message: Pick<Message, 'content' | 'type' | 'senderId' | 'metadata'>;
            previousAiMessage: Pick<Message, 'senderId'> | null;
            recentMessages?: Message[];
            apiConfig?: APIConfig;
          }) => DriverMessageCommitResult | Promise<DriverMessageCommitResult>)(args);
        },
        upsertMessage: current.upsertMessage,
        updateCharacter: current.updateCharacter,
        updateCharacters: async (patches) => current.updateCharacters(patches.map((patch) => ({ id: patch.id, updates: patch.patch }))),
        appendEventMessage: current.appendEventMessage,
        appendEventMessages: current.appendEventMessages,
        updateChat: current.updateChat,
        applyChatRuntimeDelta: current.applyChatRuntimeDelta,
        recordSpeak: current.recordSpeak,
        getCooldownMap: () => useSchedulerStore.getState().lastSpeakTimestamps,
        resolveSessionEngine: loadSessionEngine,
        signal: abortController.signal,
      });
    } finally {
      if (activeAbortControllerRef.current === abortController) activeAbortControllerRef.current = null;
      if (ignoreReaderPositionLoopTokenRef.current === loopId) ignoreReaderPositionLoopTokenRef.current = null;
      pendingStartChatByLoopTokenRef.current.delete(loopId);
      if (activeRunLoopTokenRef.current === loopId) activeRunLoopTokenRef.current = null;
    }
  }, [isCommitSettled]);
  runLoopRef.current = runLoop;

  const startConversationLoopIfNeeded = useCallback((conversationChat: GroupChat, options: ConversationLoopStartOptions = {}) => {
    const current = paramsRef.current;
    const latestMessages = projectCurrentChatMessages({
      chatId: conversationChat.id,
      chat: useChatStore.getState().chats.find((item) => item.id === conversationChat.id) || conversationChat,
      activeMessages: useMessageStore.getState().messages,
      cachedWindow: useMessageStore.getState().messageWindowsByChatId[conversationChat.id],
    });
    const storyChoiceGate = getStoryChoiceGateState(conversationChat, latestMessages);
    const isStoryChoiceBlocked = storyChoiceGate.waiting;
    const hasActiveLoop = Boolean(activeRunLoopTokenRef.current)
      && current.loopTokenRef.current === activeRunLoopTokenRef.current;
    const blockReason = getConversationLoopStartBlockReason({
      conversationType: conversationChat.type,
      isRunning: current.isRunningRef.current,
      isPaused: current.isPausedRef.current,
      isStoryChoiceBlocked,
      hasActiveLoop,
      allowDirect: options.allowDirect,
    });
    logDeveloperDiagnostic('story-run:start-gate', {
      chatId: conversationChat.id,
      phase: conversationChat.scenarioState?.phase || null,
      isRunning: current.isRunningRef.current,
      isPaused: current.isPausedRef.current,
      hasActiveLoop,
      activeRunLoopToken: activeRunLoopTokenRef.current,
      loopToken: current.loopTokenRef.current,
      blockReason,
      storyChoiceGate,
    }, blockReason ? 'warn' : 'info');
    if (shouldTreatActiveLoopAsSuccessfulStart({ blockReason, hasActiveLoop })) {
      if (options.ignoreReaderPositionOnce && activeRunLoopTokenRef.current) {
        ignoreReaderPositionLoopTokenRef.current = activeRunLoopTokenRef.current;
      }
      logDeveloperDiagnostic('story-run:reuse-active-loop', {
        chatId: conversationChat.id,
        phase: conversationChat.scenarioState?.phase || null,
        activeRunLoopToken: activeRunLoopTokenRef.current,
        ignoreReaderPositionOnce: Boolean(options.ignoreReaderPositionOnce),
      }, 'info');
      return null;
    }
    if (blockReason) return blockReason;
    const run = runLoopRef.current;
    if (!run) return null;
    current.resetAllCooldowns();
    const newLoopToken = `${conversationChat.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (options.ignoreReaderPositionOnce) ignoreReaderPositionLoopTokenRef.current = newLoopToken;
    pendingStartChatByLoopTokenRef.current.set(newLoopToken, conversationChat);
    current.loopTokenRef.current = newLoopToken;
    current.activeChatIdRef.current = conversationChat.id;
    current.isRunningRef.current = true;
    current.isPausedRef.current = false;
    current.start(newLoopToken);
    current.updateChat(conversationChat.id, { isActive: true });
    logDeveloperDiagnostic('story-run:started', {
      chatId: conversationChat.id,
      loopToken: newLoopToken,
      phase: conversationChat.scenarioState?.phase || null,
      ignoreReaderPositionOnce: Boolean(options.ignoreReaderPositionOnce),
    }, 'info');
    const startDelayMs = resolveConversationLoopStartDelayMs(options);
    const launchRun = () => {
      void run(newLoopToken).catch((error: unknown) => {
        // Navigation/unmount intentionally aborts the active generation. The
        // runner handles cancellation during a turn, but startup/module-load
        // failures can reject before that handler exists.
        if (isGenerationCancelledError(error) || activeAbortControllerRef.current?.signal.aborted) return;
        logDeveloperDiagnostic('chat-run:unhandled-start-error', {
          chatId: conversationChat.id,
          loopId: newLoopToken,
          error: error instanceof Error ? error.message : String(error),
        }, 'error', 'chat-run');
        setRunLoopError(error instanceof Error ? error.message : String(error));
      });
    };
    if (startDelayMs <= 0) {
      launchRun();
    } else {
      const timer = window.setTimeout(() => {
        pendingStartTimerByLoopTokenRef.current.delete(newLoopToken);
        launchRun();
      }, startDelayMs);
      pendingStartTimerByLoopTokenRef.current.set(newLoopToken, timer);
    }
    return null;
  }, []);

  const cancelActiveConversationLoop = useCallback((reason = 'user_cancelled') => {
    const current = paramsRef.current;
    const loopToken = current.loopTokenRef.current;
    logDeveloperDiagnostic('chat-run:cancel', {
      chatId: current.chatId,
      loopToken,
      reason,
      hasAbortController: Boolean(activeAbortControllerRef.current),
      hasStreamingMessage: Boolean(current.streamingMessageRef.current),
      pendingCommitCount: pendingCommitCountRef.current,
      pendingTurnWorkCount: pendingTurnWorkCountRef.current,
    }, 'info');
    activeAbortControllerRef.current?.abort();
    activeRunLoopTokenRef.current = null;
    if (loopToken) {
      const pendingTimer = pendingStartTimerByLoopTokenRef.current.get(loopToken);
      if (pendingTimer) window.clearTimeout(pendingTimer);
      pendingStartTimerByLoopTokenRef.current.delete(loopToken);
      pendingStartChatByLoopTokenRef.current.delete(loopToken);
    }
    current.loopTokenRef.current = null;
    current.isRunningRef.current = false;
    current.isPausedRef.current = true;
    current.discardStreamingMessage();
    current.clearStreamingMessageRef();
    // The cancelled loop may still be unwinding an async commit. It no longer
    // belongs to the active conversation branch, so manual input must not wait
    // for its bookkeeping callbacks; the commit itself is guarded by the
    // shouldContinue token passed through the persistence pipeline.
    pendingCommitCountRef.current = 0;
    pendingTurnWorkCountRef.current = 0;
    setThinkingId(null);
    current.setCurrentSpeaker(null);
    current.stop();
    if (current.chatId) void current.updateChat(current.chatId, { isActive: false });
  }, []);

  const resetRunLoopUiState = useCallback(() => {
    activeAbortControllerRef.current?.abort();
    activeAbortControllerRef.current = null;
    activeRunLoopTokenRef.current = null;
    pendingStartTimerByLoopTokenRef.current.forEach((timer) => window.clearTimeout(timer));
    pendingStartTimerByLoopTokenRef.current.clear();
    pendingStartChatByLoopTokenRef.current.clear();
    setThinkingId(null);
    setChatError(null);
    setRunLoopError(null);
  }, []);

  return {
    thinkingId,
    chatError,
    runLoopError,
    hasPendingTurnWork,
    startConversationLoopIfNeeded,
    cancelActiveConversationLoop,
    resetRunLoopUiState,
  };
}
