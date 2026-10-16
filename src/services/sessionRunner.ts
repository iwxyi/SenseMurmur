import type { AICharacter } from '../types/character';
import type { GroupChat, DriverMessageCommitResult } from '../types/chat';
import type { SessionEngineDefinition, SessionGenerationContext, SessionTurnPolicy } from '../types/sessionEngine';
import type { Message } from '../types/message';
import type { APIConfig, AIModelProfile } from '../types/settings';
import { runOneRound, type LocalInterceptionEvent } from './chatEngine';
import { commitGeneratedMessageTurn } from './generatedMessageTurnCommit';
import { createSessionRuntimeContext } from './sessionEngineKernel';
import { getAllowedSessionActions } from './sessionActionBus';
import { resolveSessionFamilyKey } from './sessionEngineKeys';
import { getCurrentSessionPhase } from './sessionStateMachine';
import { getPreferredAIProfile } from '../types/settings';
import { resolveUserInputHold, type UserDraftActivity } from './userInputBuffer';
import { isGenerationCancelledError } from './generationCancellation';
import { logDeveloperDiagnostic } from './developerDiagnostics';
import { isAutoRunnableSessionAction } from './conversationCapabilities';
import { applyAnalysisRunPolicy, buildAnalysisRunPolicyEvent, type SessionLoopDecision } from './analysisRunPolicy';
import { resolvePendingReplyContext } from './scheduler';
import { getEffectiveCharacterPresence } from './characterPresence';

// An autonomous group burst is scoped by external input. AI messages and the
// runtime facts they write back belong to the burst itself; treating them as a
// new context gives every member another turn after every send.
export function buildNoSendContextKey(chat: GroupChat, messages: Message[]) {
  const branchName = chat.messageBranchState?.activeBranchName;
  return JSON.stringify({
    branch: branchName,
    messages: messages.filter((message) => !message.isDeleted && !message.isStreaming
      && (message.type === 'user' || message.type === 'god')).map((message) => [
      message.id, message.type, message.senderId, message.content,
      message.addressedTargetIds, message.replyDebtTargetIds, message.metadata?.withdrawal,
    ]),
    room: [chat.topic, chat.runtimeSeed],
  });
}

function isAutonomousConversation(chat: GroupChat) {
  return chat.type === 'group' && chat.sessionKind?.scenarioId !== 'story-reader'
    && resolveSessionFamilyKey(chat) === 'conversation';
}

function refreshMemberOpportunityState(
  chat: GroupChat,
  characters: AICharacter[],
  consumedSpeakerIds: Set<string>,
  consumedReplyDebtSpeakerIds: Set<string>,
  presenceByMemberId: Map<string, string>,
) {
  const memberIds = new Set(chat.memberIds);
  for (const memberId of presenceByMemberId.keys()) {
    if (!memberIds.has(memberId)) {
      presenceByMemberId.delete(memberId);
      consumedSpeakerIds.delete(memberId);
      consumedReplyDebtSpeakerIds.delete(memberId);
    }
  }

  for (const character of characters) {
    if (!memberIds.has(character.id)) continue;
    const status = getEffectiveCharacterPresence(character).status;
    if (presenceByMemberId.get(character.id) === 'away' && status === 'online') {
      consumedSpeakerIds.delete(character.id);
      consumedReplyDebtSpeakerIds.delete(character.id);
    }
    presenceByMemberId.set(character.id, status);
  }
}

export function shouldPauseSettledConversation(runStart: GroupChat, after: GroupChat, characters: AICharacter[], messages: Message[]) {
  const settledAt = after.worldState.conversationContinuity?.settledAt;
  return after.type === 'group' && resolveSessionFamilyKey(after) === 'conversation'
    && Boolean(settledAt && settledAt !== runStart.worldState.conversationContinuity?.settledAt)
    && !resolvePendingReplyContext(characters, messages, after);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SessionLoopPhase = 'starting' | 'paused' | 'waiting_commit' | 'waiting_context' | 'selecting' | 'running_round' | 'sleeping' | 'error_sleeping';

const activeSessionLoops = new Map<string, {
  chatId: string;
  startedAt: number;
  updatedAt: number;
  iterationCount: number;
  phase: SessionLoopPhase;
}>();

function markSessionLoop(loopId: string, patch: Partial<Omit<NonNullable<ReturnType<typeof activeSessionLoops.get>>, 'chatId' | 'startedAt'>>) {
  const current = activeSessionLoops.get(loopId);
  if (!current) return;
  activeSessionLoops.set(loopId, {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  });
}

export function getSessionLoopDebugState() {
  const now = Date.now();
  const loops = Array.from(activeSessionLoops.entries()).map(([loopId, item]) => ({
    loopId,
    chatId: item.chatId,
    ageMs: now - item.startedAt,
    idleMs: now - item.updatedAt,
    iterationCount: item.iterationCount,
    phase: item.phase,
  }));
  return {
    count: loops.length,
    loops,
  };
}

function buildEngineGenerationContext(chat: GroupChat, characters: AICharacter[], messages: Message[]): SessionGenerationContext {
  return {
    conversation: chat,
    characters,
    messages,
  };
}

type SessionEngineResolver = (chat: Pick<GroupChat, 'mode' | 'sessionKind'>) => SessionEngineDefinition | Promise<SessionEngineDefinition>;

async function defaultResolveSessionEngine(chat: Pick<GroupChat, 'mode' | 'sessionKind'>) {
  const { loadSessionEngine } = await import('./sessionEngineLoader');
  return loadSessionEngine(chat);
}

async function getSessionEngine(chat: Pick<GroupChat, 'mode' | 'sessionKind'>, resolver?: SessionEngineResolver) {
  return resolver ? await resolver(chat) : await defaultResolveSessionEngine(chat);
}

function createFallbackTurnPolicy(engine: SessionEngineDefinition, chat: GroupChat) {
  const context = createSessionRuntimeContext(engine, chat);
  const phase = getCurrentSessionPhase(engine, chat);
  const actions = getAllowedSessionActions(engine, context);
  const canSpeak = phase.allowedActions.includes('send_message')
    || phase.allowedActions.includes('speak')
    || phase.allowedActions.includes('all')
    || actions.some((action) => action.type === 'send_message' || action.type === 'speak');
  const canAct = actions.some((action) => action.type !== 'send_message' && action.type !== 'speak');
  const family = resolveSessionFamilyKey(chat);
  if (family === 'interview') return { runChat: canSpeak, runAction: canAct, interleaveAction: canAct };
  if (family === 'deduction' || family === 'mystery') return { runChat: canSpeak, runAction: canAct, interleaveAction: true };
  if (family === 'board_game') return { runChat: canSpeak, runAction: true, interleaveAction: true };
  if (family === 'study' || family === 'analysis' || family === 'agent' || family === 'simulation') {
    return { runChat: canSpeak, runAction: canAct, interleaveAction: canAct };
  }
  return { runChat: canSpeak, runAction: canAct, interleaveAction: canSpeak && canAct };
}

function deriveLoopDecision(policy: SessionTurnPolicy): SessionLoopDecision {
  return {
    canRun: Boolean(policy.runChat || policy.runAction),
    runAction: Boolean(policy.runAction),
    runChat: Boolean(policy.runChat),
    actionFirst: Boolean(policy.interleaveAction && policy.runAction),
  };
}

function getFallbackActionChance(chat: Pick<GroupChat, 'sessionKind' | 'type' | 'mode'>) {
  const family = resolveSessionFamilyKey(chat);
  if (family === 'board_game') return 0.22;
  if (family === 'interview') return 1;
  if (family === 'deduction' || family === 'mystery') return 0.16;
  if (family === 'study') return 0.12;
  if (family === 'analysis' || family === 'simulation') return 0.1;
  if (family === 'agent') return 0.2;
  return 0.08;
}

function resolveEngineTurnPolicy(engine: SessionEngineDefinition, chat: GroupChat, characters: AICharacter[], messages: Message[]) {
  const context = buildEngineGenerationContext(chat, characters, messages);
  return engine.resolveTurnPolicy?.(context) || createFallbackTurnPolicy(engine, chat);
}

function resolveEngineLoopDecision(engine: SessionEngineDefinition, chat: GroupChat, characters: AICharacter[], messages: Message[]) {
  const policy = resolveEngineTurnPolicy(engine, chat, characters, messages);
  return deriveLoopDecision(policy);
}

async function maybeRunNonChatAction(
  engine: SessionEngineDefinition,
  chat: GroupChat,
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>,
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number]) => Promise<void>,
  random: () => number = Math.random,
) {
  const context = createSessionRuntimeContext(engine, chat);
  const actionSchema = engine.getActionSchema?.({ conversation: chat, participants: context.participants }) || null;
  const nonChatAction = actionSchema?.actions.find((action) => action.type !== 'send_message' && action.type !== 'speak' && isAutoRunnableSessionAction(action)) || null;
  if (!nonChatAction) return false;

  const actionChance = getFallbackActionChance(chat);
  if (random() > actionChance) return false;

  const { runSessionActionExecutor } = await import('./sessionActionExecutors/sessionActionExecutorRegistry');
  const result = runSessionActionExecutor(chat, nonChatAction);
  if (!result) return false;
  if (result.chatPatch) await updateChat(chat.id, result.chatPatch);
  for (const event of result.runtimeEvents || []) {
    await appendEventMessage(chat.id, event);
  }
  return true;
}

function getLoopWaitTime(chat: GroupChat, random: () => number = Math.random) {
  return (900 / (chat.speed || 1)) + random() * 600;
}

function getLoopErrorWaitTime() {
  return 5000;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function buildRuntimeErrorEvent(error: unknown, title: string): DriverMessageCommitResult['runtimeEvents'][number] {
  return {
    eventType: 'runtime_error',
    title,
    summary: formatErrorMessage(error),
    eventClass: 'phase',
    visibilityScope: 'public',
    channelId: 'public',
  };
}

async function appendRecoverableRuntimeError(params: {
  chatId: string;
  error: unknown;
  title: string;
  sourceMessageId?: string;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number], sourceMessageId?: string) => Promise<void>;
  onLoopError: (error: unknown) => void;
}) {
  try {
    await params.appendEventMessage(params.chatId, buildRuntimeErrorEvent(params.error, params.title), params.sourceMessageId);
  } catch (appendError) {
    params.onLoopError(appendError);
  }
}

function shouldContinueLoop(params: { isRunning: () => boolean }) {
  return params.isRunning();
}

function isActiveLoop(params: { isActiveLoop: (loopId: string) => boolean; loopId: string }) {
  return params.isActiveLoop(params.loopId);
}

function getSessionMessages(getCurrentMessages: () => Message[]) {
  return getCurrentMessages();
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function shouldWaitAfterSessionTick() {
  return true;
}

function resolveCommitApiConfig(api: APIConfig | AIModelProfile[]): APIConfig {
  if (!Array.isArray(api)) return api;
  const profile = getPreferredAIProfile(api, 'text') || api.find((item) => (item.type || 'text') === 'text') || api[0];
  return {
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
  };
}

export async function runSessionLoop(params: {
  loopId: string;
  chatId: string;
  chat: GroupChat;
  characters: AICharacter[];
  api: APIConfig | AIModelProfile[];
  getCurrentMessages: () => Message[];
  getUserDraftActivity?: () => UserDraftActivity | null;
  getStreamingMessage?: () => Message | null;
  getDisplayedStreamingMessage?: () => Message | null;
  getCurrentChat?: () => GroupChat | undefined;
  getKnownConversations?: () => GroupChat[];
  getCurrentCharacters?: () => AICharacter[];
  ensureCharacterDetail?: (characterId: string) => Promise<AICharacter | null>;
  isRunning: () => boolean;
  isPaused: () => boolean;
  isActiveLoop: (loopId: string) => boolean;
  onSpeakerSelected: (characterId: string, speaker?: AICharacter) => void;
  onCommitSettled?: () => boolean;
  onCommitStarted?: () => void;
  onCommitFinished?: () => void;
  pauseLoop?: () => void;
  onTurnWorkStarted?: () => void;
  onTurnWorkFinished?: () => void;
  onIdle?: (reason: string) => void;
  onQuiet?: () => void;
  onMessageChunk: (content: string) => void;
  onStreamingComplete?: () => void;
  onDiscardStreamingMessage: () => void;
  onLocalInterception?: (event: LocalInterceptionEvent) => void | Promise<void>;
  onClearStreamingState: () => void;
  onEngineError: (error: Error) => void;
  onLoopError: (error: unknown) => void;
  onCommit: (args: {
    conversation: GroupChat;
    characters: AICharacter[];
    message: Pick<Message, 'content' | 'type' | 'senderId' | 'metadata'> & { interactionHint?: import('../types/runtimeEvent').InteractionEventPayload | null };
    previousAiMessage: Pick<Message, 'senderId'> | null;
    recentMessages?: Message[];
    apiConfig?: APIConfig;
  }) => DriverMessageCommitResult | Promise<DriverMessageCommitResult>;
  upsertMessage: (message: Message) => void;
  updateCharacter: (id: string, patch: Partial<AICharacter>) => Promise<void>;
  updateCharacters?: (patches: Array<{ id: string; patch: Partial<AICharacter> }>) => Promise<void>;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number]) => Promise<void>;
  appendEventMessages?: (chatId: string, payloads: DriverMessageCommitResult['runtimeEvents'], sourceMessageId?: string) => Promise<void>;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  applyChatRuntimeDelta?: (id: string, delta: NonNullable<DriverMessageCommitResult['chatRuntimeDelta']>, patch?: Partial<GroupChat>) => Promise<void>;
  recordSpeak: (characterId: string) => void;
  getCooldownMap?: () => Record<string, number>;
  resolveSessionEngine?: SessionEngineResolver;
  random?: () => number;
  signal?: AbortSignal;
}) {
  const random = params.random || Math.random;
  let conversationRunStart: GroupChat | null = null;
  let noSendContextKey: string | null = null;
  const consumedSpeakerIds = new Set<string>();
  const consumedReplyDebtSpeakerIds = new Set<string>();
  const presenceByMemberId = new Map<string, string>();
  activeSessionLoops.set(params.loopId, {
    chatId: params.chatId,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    iterationCount: 0,
    phase: 'starting',
  });
  try {
    while (shouldContinueLoop(params)) {
      if (params.signal?.aborted) return;
      if (!isActiveLoop(params)) return;
      if (params.isPaused()) {
        conversationRunStart = null;
        markSessionLoop(params.loopId, { phase: 'paused' });
        await sleep(120);
        continue;
      }
      if (params.onCommitSettled && !params.onCommitSettled()) {
        markSessionLoop(params.loopId, { phase: 'waiting_commit' });
        await sleep(80);
        continue;
      }

      if (consumedSpeakerIds.size) {
        const waitingChat = params.getCurrentChat?.() || params.chat;
        const waitingCharacters = params.getCurrentCharacters?.() || params.characters;
        const waitingMessages = params.getCurrentMessages();
        if (isAutonomousConversation(waitingChat)) {
          refreshMemberOpportunityState(waitingChat, waitingCharacters, consumedSpeakerIds, consumedReplyDebtSpeakerIds, presenceByMemberId);
          const pendingReply = resolvePendingReplyContext(waitingCharacters, waitingMessages, waitingChat);
          const hasPendingReply = Boolean(pendingReply?.targetIds.some((id) => !consumedReplyDebtSpeakerIds.has(id)));
          if (buildNoSendContextKey(waitingChat, waitingMessages) === noSendContextKey
            && !hasPendingReply
            && waitingCharacters.filter((character) => waitingChat.memberIds.includes(character.id))
              .every((character) => getEffectiveCharacterPresence(character).status === 'away' || consumedSpeakerIds.has(character.id))) {
            markSessionLoop(params.loopId, { phase: 'waiting_context' });
            await sleep(250);
            continue;
          }
        }
      }

      try {
      const turnStartedAt = nowMs();
      let roundStreamingMessage: Message | null = null;
      let turnWorkActive = true;
      params.onTurnWorkStarted?.();
      try {
        const nextIterationCount = (activeSessionLoops.get(params.loopId)?.iterationCount || 0) + 1;
        markSessionLoop(params.loopId, {
          phase: 'selecting',
          iterationCount: nextIterationCount,
        });
      const currentMessages = getSessionMessages(params.getCurrentMessages);
      const currentChat = params.getCurrentChat?.() || params.chat;
      conversationRunStart ??= currentChat;
      const currentCharacters = params.getCurrentCharacters?.() || params.characters;
      const inputHold = resolveUserInputHold({
        messages: currentMessages,
        draft: params.getUserDraftActivity?.() || null,
      });
      if (inputHold.shouldHold) {
        logDeveloperDiagnostic('chat-run:input-hold', {
          chatId: params.chatId,
          loopId: params.loopId,
          reason: inputHold.reason,
          delayMs: inputHold.delayMs,
          elapsedMs: Number((nowMs() - turnStartedAt).toFixed(2)),
        }, 'info', 'chat-run');
        turnWorkActive = false;
        params.onTurnWorkFinished?.();
        markSessionLoop(params.loopId, { phase: 'sleeping' });
        await new Promise((resolve) => setTimeout(resolve, inputHold.delayMs));
        continue;
      }
      if (currentChat.memberIds.length && currentCharacters.length === 0) {
        turnWorkActive = false;
        params.onTurnWorkFinished?.();
        params.onLoopError(new Error('No active character records available for this chat loop'));
        await new Promise((resolve) => setTimeout(resolve, getLoopErrorWaitTime()));
        continue;
      }

      const loopCharacters = currentCharacters.filter((character) => currentChat.memberIds.includes(character.id));
      if (currentChat.memberIds.length && loopCharacters.length === 0) {
        turnWorkActive = false;
        params.onTurnWorkFinished?.();
        params.onLoopError(new Error('All selected members are missing from the active character set'));
        await new Promise((resolve) => setTimeout(resolve, getLoopErrorWaitTime()));
        continue;
      }

      const effectiveCharacters = loopCharacters.length ? loopCharacters : currentCharacters;
      const roundContextKey = buildNoSendContextKey(currentChat, currentMessages);
      if (roundContextKey !== noSendContextKey) {
        consumedSpeakerIds.clear();
        consumedReplyDebtSpeakerIds.clear();
        noSendContextKey = roundContextKey;
      }
      if (isAutonomousConversation(currentChat)) {
        refreshMemberOpportunityState(currentChat, effectiveCharacters, consumedSpeakerIds, consumedReplyDebtSpeakerIds, presenceByMemberId);
      }
      const engine = await getSessionEngine(currentChat, params.resolveSessionEngine);
      const generationContext = buildEngineGenerationContext(currentChat, effectiveCharacters, currentMessages);
      const rawLoopDecision = resolveEngineLoopDecision(engine, currentChat, effectiveCharacters, currentMessages);
      const analysisRunPolicy = applyAnalysisRunPolicy({
        chat: currentChat,
        messages: currentMessages,
        iterationCount: nextIterationCount,
        rawDecision: rawLoopDecision,
      });
      const loopDecision = analysisRunPolicy.decision;
      logDeveloperDiagnostic('chat-run:turn-selected', {
        chatId: params.chatId,
        loopId: params.loopId,
        messageCount: currentMessages.length,
        characterCount: effectiveCharacters.length,
        phase: currentChat.scenarioState?.phase || null,
        loopDecision,
        rawLoopDecision,
        analysisRunPolicy: analysisRunPolicy.trace,
        elapsedMs: Number((nowMs() - turnStartedAt).toFixed(2)),
      }, 'debug', 'chat-run');
      if (!loopDecision.canRun || !loopDecision.runChat) {
        console.warn('[chat-run:turn-blocked-reason]', JSON.stringify({
          chatId: params.chatId,
          canRun: loopDecision.canRun,
          runChat: loopDecision.runChat,
          actionFirst: loopDecision.actionFirst,
          rawRunChat: rawLoopDecision.runChat,
          rawRunAction: rawLoopDecision.runAction,
          latestType: currentMessages.at(-1)?.type || null,
          latestSenderId: currentMessages.at(-1)?.senderId || null,
          phase: currentChat.scenarioState?.phase || null,
        }));
        logDeveloperDiagnostic('chat-run:turn-blocked', {
          chatId: params.chatId,
          loopId: params.loopId,
          messageCount: currentMessages.length,
          latestMessage: currentMessages.at(-1) ? {
            type: currentMessages.at(-1)?.type,
            senderId: currentMessages.at(-1)?.senderId,
          } : null,
          canRun: loopDecision.canRun,
          runChat: loopDecision.runChat,
          actionFirst: loopDecision.actionFirst,
          rawRunChat: rawLoopDecision.runChat,
          rawRunAction: rawLoopDecision.runAction,
          analysisStopReason: analysisRunPolicy.trace?.reason || null,
          rawDecision: rawLoopDecision,
          loopDecision,
          phase: currentChat.scenarioState?.phase || null,
        }, 'warn', 'chat-run');
      }

      if (loopDecision.canRun && loopDecision.actionFirst) {
        const handled = await maybeRunNonChatAction(engine, currentChat, params.updateChat, params.appendEventMessage, random);
        if (handled) {
          turnWorkActive = false;
          params.onTurnWorkFinished?.();
          if (params.isRunning() && !params.isPaused() && shouldWaitAfterSessionTick()) {
            await new Promise((resolve) => setTimeout(resolve, getLoopWaitTime(currentChat, random)));
          }
          continue;
        }
      }

      if (!loopDecision.canRun) {
        turnWorkActive = false;
        params.onTurnWorkFinished?.();
        const analysisStopEvent = buildAnalysisRunPolicyEvent(analysisRunPolicy.trace);
        if (analysisStopEvent) await params.appendEventMessage(params.chatId, analysisStopEvent);
        const sessionFamily = resolveSessionFamilyKey(currentChat);
        if (sessionFamily !== 'analysis' && sessionFamily !== 'study') params.onIdle?.('当前阶段没有需要自动执行的回合');
        params.pauseLoop?.();
        await new Promise((resolve) => setTimeout(resolve, getLoopWaitTime(currentChat, random)));
        continue;
      }

      if (!loopDecision.runChat) {
        turnWorkActive = false;
        params.onTurnWorkFinished?.();
        const analysisStopEvent = buildAnalysisRunPolicyEvent(analysisRunPolicy.trace);
        if (analysisStopEvent) await params.appendEventMessage(params.chatId, analysisStopEvent);
        const sessionFamily = resolveSessionFamilyKey(currentChat);
        if (sessionFamily !== 'analysis' && sessionFamily !== 'study') params.onIdle?.('当前阶段没有需要自动发言的角色');
        params.pauseLoop?.();
        await new Promise((resolve) => setTimeout(resolve, getLoopWaitTime(currentChat, random)));
        continue;
      }

      markSessionLoop(params.loopId, { phase: 'running_round' });
      logDeveloperDiagnostic('chat-run:request-dispatch', {
        chatId: params.chatId,
        loopId: params.loopId,
        messageCount: currentMessages.length,
        characterCount: effectiveCharacters.length,
        speakerIds: effectiveCharacters.map((character) => character.id),
      }, 'info', 'chat-run');
      const roundStartedAt = nowMs();
      logDeveloperDiagnostic('chat-run:round-start', {
        chatId: params.chatId,
        loopId: params.loopId,
        messageCount: currentMessages.length,
        characterCount: effectiveCharacters.length,
        elapsedMs: Number((roundStartedAt - turnStartedAt).toFixed(2)),
      }, 'info', 'chat-run');
      const pendingReplyTargetIdsForRound = new Set(
        (isAutonomousConversation(currentChat)
          ? resolvePendingReplyContext(effectiveCharacters, currentMessages, currentChat)?.targetIds
          : []) || [],
      );
      let firstChunkLogged = false;
      await runOneRound(
        currentChat,
        effectiveCharacters,
        currentMessages,
        params.api,
        {
          onSpeakerSelected: (charId, speaker) => {
            if (!isActiveLoop(params)) return;
            logDeveloperDiagnostic('chat-run:speaker-selected', {
              chatId: params.chatId,
              loopId: params.loopId,
              speakerId: charId,
              speakerName: speaker?.name || null,
              elapsedMs: Number((nowMs() - roundStartedAt).toFixed(2)),
            }, 'debug', 'chat-run');
            params.onSpeakerSelected(charId, speaker);
            roundStreamingMessage = params.getStreamingMessage?.() || null;
          },
          ensureSpeakerDetail: (charId) => params.ensureCharacterDetail?.(charId) || Promise.resolve(undefined),
          onMessageChunk: (content) => {
            if (!isActiveLoop(params)) return;
            if (!firstChunkLogged) {
              firstChunkLogged = true;
              logDeveloperDiagnostic('chat-run:first-chunk', {
                chatId: params.chatId,
                loopId: params.loopId,
                speakerId: roundStreamingMessage?.senderId || null,
                contentLength: content.length,
                elapsedMs: Number((nowMs() - roundStartedAt).toFixed(2)),
              }, 'info', 'chat-run');
            }
            params.onMessageChunk(content);
          },
          onLocalInterception: async (event) => {
            if (!isActiveLoop(params)) return;
            await params.onLocalInterception?.(event);
          },
          onIdle: (reason) => {
            if (!isActiveLoop(params)) return;
            params.onIdle?.(reason);
          },
          onQuiet: () => {
            if (!isActiveLoop(params)) return;
            params.onQuiet?.();
          },
          onNoSend: ({ speakerId }) => {
            if (!isActiveLoop(params) || params.signal?.aborted) return;
            const latestChat = params.getCurrentChat?.() || currentChat;
            const latestKey = buildNoSendContextKey(latestChat, params.getCurrentMessages());
            if (latestKey === roundContextKey && isAutonomousConversation(latestChat)) consumedSpeakerIds.add(speakerId);
            if (latestKey === roundContextKey && isAutonomousConversation(latestChat)
              && pendingReplyTargetIdsForRound.has(speakerId)) consumedReplyDebtSpeakerIds.add(speakerId);
            logDeveloperDiagnostic('chat-run:no-send', {
              chatId: params.chatId, loopId: params.loopId, speakerId,
              contextChanged: latestKey !== roundContextKey,
              consumedSpeakerCount: consumedSpeakerIds.size,
            }, 'info', 'chat-run');
            params.onDiscardStreamingMessage();
          },
          onMessageComplete: async (message) => {
            if (!isActiveLoop(params)) return;
            logDeveloperDiagnostic('chat-run:message-complete', {
              chatId: params.chatId,
              loopId: params.loopId,
              speakerId: message.senderId,
              contentLength: message.content.length,
              elapsedMs: Number((nowMs() - roundStartedAt).toFixed(2)),
            }, 'info', 'chat-run');
            // From here the commit pipeline owns the visual reveal. Leaving
            // the model-stream timer alive lets it overwrite later bubbles.
            params.onStreamingComplete?.();
            params.onCommitStarted?.();
            const commitStartedAt = nowMs();
            try {
              await commitGeneratedMessageTurn({
                api: resolveCommitApiConfig(params.api),
                chatId: params.chatId,
                chat: currentChat,
                characters: currentCharacters,
                message,
                streamingMessage: params.getDisplayedStreamingMessage?.() || roundStreamingMessage || params.getStreamingMessage?.() || null,
                currentMessages: params.getCurrentMessages(),
                onCommit: params.onCommit,
                upsertMessage: params.upsertMessage,
                updateCharacter: params.updateCharacter,
                updateCharacters: params.updateCharacters,
                appendEventMessage: params.appendEventMessage,
                appendEventMessages: params.appendEventMessages,
                updateChat: params.updateChat,
                applyChatRuntimeDelta: params.applyChatRuntimeDelta,
                recordSpeak: params.recordSpeak,
                aiProfiles: Array.isArray(params.api) ? params.api : undefined,
                getCurrentChat: params.getCurrentChat,
                getCurrentCharacters: params.getCurrentCharacters,
                shouldContinue: () => isActiveLoop(params),
              });
              const latestChat = params.getCurrentChat?.() || currentChat;
              const latestKey = buildNoSendContextKey(latestChat, params.getCurrentMessages());
              if (latestKey === roundContextKey && isAutonomousConversation(latestChat)) {
                consumedSpeakerIds.add(message.senderId);
                if (pendingReplyTargetIdsForRound.has(message.senderId)) consumedReplyDebtSpeakerIds.add(message.senderId);
              }
            } catch (error) {
              if (isGenerationCancelledError(error) || !isActiveLoop(params)) return;
              params.onLoopError(error);
              if (isActiveLoop(params)) {
                await appendRecoverableRuntimeError({
                  chatId: params.chatId,
                  error,
                  title: '提交失败',
                  sourceMessageId: roundStreamingMessage?.id,
                  appendEventMessage: params.appendEventMessage,
                  onLoopError: params.onLoopError,
                });
                if (isActiveLoop(params)) params.pauseLoop?.();
              }
            } finally {
              logDeveloperDiagnostic('chat-run:commit-finished', {
                chatId: params.chatId,
                loopId: params.loopId,
                speakerId: message.senderId,
                elapsedMs: Number((nowMs() - commitStartedAt).toFixed(2)),
              }, 'info', 'chat-run');
              params.onCommitFinished?.();
              if (isActiveLoop(params)) {
                params.onClearStreamingState();
              }
            }
          },
          onError: (error) => {
            if (!isActiveLoop(params)) return;
            params.onEngineError(error);
          },
          signal: params.signal,
        },
        undefined,
        engine.buildGenerationPromptContext
          ? {
              sessionEngine: engine,
              allowNoSend: true,
              consumedSpeakerIds,
              consumedReplyDebtSpeakerIds,
              knownConversations: params.getKnownConversations?.(),
              buildPromptContext: (speaker) => engine.buildGenerationPromptContext?.({
                ...generationContext,
                speaker,
              }) || null,
            }
          : { sessionEngine: engine, knownConversations: params.getKnownConversations?.(), allowNoSend: true, consumedSpeakerIds, consumedReplyDebtSpeakerIds },
        params.getCooldownMap?.()
      );

      turnWorkActive = false;
      params.onTurnWorkFinished?.();
      logDeveloperDiagnostic('chat-run:turn-finished', {
        chatId: params.chatId,
        loopId: params.loopId,
        elapsedMs: Number((nowMs() - turnStartedAt).toFixed(2)),
      }, 'info', 'chat-run');

      // Study rooms are strictly learner-triggered: one user message unlocks
      // one teacher turn. Pause immediately after the turn so a stale message
      // snapshot cannot launch a duplicate second generation.
      if (resolveSessionFamilyKey(currentChat) === 'study' || currentChat.type === 'direct' || currentChat.type === 'ai_direct') {
        params.pauseLoop?.();
      }
      const committedChat = params.getCurrentChat?.();
      const latestCharacters = params.getCurrentCharacters?.() || params.characters;
      const latestMessages = getSessionMessages(params.getCurrentMessages);
      const shouldPauseSettled = Boolean(committedChat && shouldPauseSettledConversation(
        conversationRunStart, committedChat, latestCharacters, latestMessages));
      if (shouldPauseSettled && committedChat) {
        const continuity = committedChat.worldState.conversationContinuity;
        const pendingReply = resolvePendingReplyContext(latestCharacters, latestMessages, committedChat);
        logDeveloperDiagnostic('chat-run:settled-pause-evaluated', {
          chatId: params.chatId,
          loopId: params.loopId,
          settledAt: continuity?.settledAt || null,
          previousSettledAt: conversationRunStart?.worldState.conversationContinuity?.settledAt || null,
          pendingReplyTargetIds: pendingReply?.targetIds || [],
          pendingReplySourceMessageId: pendingReply?.sourceMessageId || null,
          lastAiSpeakerId: [...latestMessages].reverse().find((message) => message.type === 'ai' && !message.isDeleted)?.senderId || null,
          activeContinuityItemCount: continuity?.items?.length || 0,
        }, 'info', 'chat-run');
        params.pauseLoop?.();
        conversationRunStart = null;
      }

      if (params.isRunning() && !params.isPaused() && shouldWaitAfterSessionTick()) {
        markSessionLoop(params.loopId, { phase: 'sleeping' });
        await new Promise((resolve) => setTimeout(resolve, getLoopWaitTime(currentChat, random)));
      }
      } finally {
        if (turnWorkActive) params.onTurnWorkFinished?.();
      }
      } catch (error) {
        if (isGenerationCancelledError(error) || params.signal?.aborted) {
          if (isActiveLoop(params)) {
            params.onClearStreamingState();
            params.pauseLoop?.();
          }
          return;
        }
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[session-runner:loop-error]', {
            error,
            chatId: params.chatId,
            loopId: params.loopId,
            phase: activeSessionLoops.get(params.loopId)?.phase,
            running: params.isRunning(),
            paused: params.isPaused(),
            streamingMessage: params.getStreamingMessage?.() || null,
          });
        }
        params.onLoopError(error);
        if (!isActiveLoop(params)) return;
        await appendRecoverableRuntimeError({
          chatId: params.chatId,
          error,
          title: '运行异常',
          sourceMessageId: params.getStreamingMessage?.()?.id,
          appendEventMessage: params.appendEventMessage,
          onLoopError: params.onLoopError,
        });
        if (isActiveLoop(params)) params.pauseLoop?.();
        return;
      }
    }
  } finally {
    activeSessionLoops.delete(params.loopId);
  }
}
