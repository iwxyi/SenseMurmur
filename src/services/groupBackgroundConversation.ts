import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSchedulerStore } from '../stores/useSchedulerStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { persistLocalFirstMessage, persistLocalFirstMessages } from './chatCommitMessage';
import { projectCurrentChatMessages, projectMergedChatMessages } from './currentChatMessages';
import { normalizeRuntimeEvent, buildRuntimeEventMessageContent } from './runtimeEventFactory';
import { loadSessionEngine } from './sessionEngineLoader';
import { runSessionLoop } from './sessionRunner';
import { readSessionLoopContinuation, writeSessionLoopContinuation } from './sessionLoopContinuationStore';
import { scheduleBackgroundExecution } from './backgroundExecutionScheduler';
import { runWithConversationExecutionLock } from './conversationExecutionLock';
import { getWorkspaceSignal } from './workspaceLifecycle';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { createWorkflowRunRuntime, currentWorkflowScope, indexedDbWorkflowRepository, workflowRunLockName, WorkflowPreflightError, type WorkflowSnapshot, type WorkflowTask } from './workflowRunRuntime';
import { getStoryChoiceGateState } from './storyChoices';
import { resolveSessionFamilyKey } from './sessionEngineKeys';

const active = new Map<string, Promise<void>>();
const starting = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let revision = 0;
function publish() { revision += 1; listeners.forEach((listener) => listener()); }

export function subscribeGroupBackgroundConversations(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getGroupBackgroundRevision() { return revision; }
export function groupConversationRunId(chatId: string) { return `group-conversation-${chatId}`; }
export function isGroupBackgroundActive(chatId: string) { return active.has(groupConversationRunId(chatId)); }

function chatMessages(chatId: string, chat: GroupChat) {
  const state = useMessageStore.getState();
  return projectCurrentChatMessages({ chatId, chat,
    activeMessages: state.messages.filter((item) => item.chatId === chatId),
    cachedWindow: state.messageWindowsByChatId[chatId] });
}

function committedTurn(chatId: string, taskId: string) {
  const state = useMessageStore.getState();
  return projectMergedChatMessages({ chatId,
    activeMessages: state.messages.filter((item) => item.chatId === chatId),
    cachedWindow: state.messageWindowsByChatId[chatId]
      ? { ...state.messageWindowsByChatId[chatId], preserveBranchContext: true } : undefined,
  }).find((item) => item.type === 'ai' && !item.isDeleted && !item.isStreaming
    && item.metadata?.groupTurnTaskId === taskId
    && (!item.metadata?.turnSegment || item.metadata.turnSegment.index === item.metadata.turnSegment.count - 1));
}

export function isGroupBackgroundTurnBlocked(chat: GroupChat, messages: Message[]) {
  return chat.sessionKind?.scenarioId === 'story-reader'
    && getStoryChoiceGateState(chat, messages).waiting;
}

async function appendEvents(chatId: string, payloads: Parameters<Parameters<typeof runSessionLoop>[0]['appendEventMessage']>[1][], sourceMessageId?: string) {
  const messages = payloads.map((payload) => {
    const event = normalizeRuntimeEvent(payload);
    return { message: { chatId, type: 'event' as const, senderId: 'system', senderName: 'System',
      content: buildRuntimeEventMessageContent({ ...event, sourceMessageId: event.sourceMessageId || sourceMessageId }), emotion: 0 }, timestamp: event.createdAt };
  });
  if (messages.length === 1) {
    await persistLocalFirstMessage({ ...messages[0], upsertMessage: (message) => useMessageStore.getState().upsertMessage(message) });
  } else if (messages.length) {
    await persistLocalFirstMessages({ messages, upsertMessages: (items) => useMessageStore.getState().upsertMessages(items) });
  }
}

async function executeTurn(task: WorkflowTask, signal: AbortSignal) {
  if (task.kind !== 'group_conversation_turn' || !task.input || typeof task.input !== 'object') throw new WorkflowPreflightError('群聊任务输入无效');
  const { chatId } = task.input as { chatId?: unknown };
  if (typeof chatId !== 'string') throw new WorkflowPreflightError('群聊任务输入无效');
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useCharacterStore.persist.hasHydrated() ? Promise.resolve() : useCharacterStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
  if (!chat || chat.type !== 'group' || chat.deletedAt != null || !chat.isActive) throw new WorkflowPreflightError('群聊已停止或不可用');
  const members = await Promise.all(chat.memberIds.filter((id) => id !== 'user').map(async (id) => useCharacterStore.getState().characters.find((item) => item.id === id)
    || useCharacterStore.getState().loadCharacter(id)));
  if (members.some((item) => !item)) throw new WorkflowPreflightError('群聊角色已不存在');
  const previous = committedTurn(chatId, task.id);
  if (previous) return { output: { outcome: 'committed', messageId: previous.id } };
  if (isGroupBackgroundTurnBlocked(chat, chatMessages(chatId, chat))) {
    return { output: { outcome: 'stopped', reason: 'waiting_story_choice' } };
  }
  const scope = currentWorkflowScope();
  const engine = await loadSessionEngine(chat);
  let running = true;
  let stopped = false;
  let declined = false;
  let committed: Message | null = null;
  let failure: Error | null = null;
  const currentChat = () => useChatStore.getState().chats.find((item) => item.id === chatId);
  const continuation = await readSessionLoopContinuation(chatId, scope);
  await runSessionLoop({
    loopId: task.id, executionMode: 'single_turn', groupTurnTaskId: task.id,
    continuation: continuation || undefined,
    onContinuation: (next) => writeSessionLoopContinuation(chatId, next, scope),
    chatId, chat, characters: members.filter((item): item is NonNullable<typeof item> => Boolean(item)),
    api: useSettingsStore.getState().aiProfiles,
    getCurrentMessages: () => chatMessages(chatId, currentChat() || chat),
    getCurrentChat: currentChat,
    getKnownConversations: () => useChatStore.getState().chats,
    getCurrentCharacters: () => useCharacterStore.getState().characters,
    ensureCharacterDetail: (id) => useCharacterStore.getState().loadCharacter(id),
    isRunning: () => running && !signal.aborted,
    isPaused: () => !running || signal.aborted,
    isActiveLoop: () => running && !signal.aborted && currentChat()?.type === 'group' && currentChat()?.deletedAt == null,
    pauseLoop: () => { running = false; stopped = true; },
    onSpeakerSelected: () => undefined,
    onMessageChunk: () => undefined,
    onDiscardStreamingMessage: () => undefined,
    onNoSendDecision: () => { declined = true; },
    onQuiet: () => { declined = true; },
    onIdle: () => { stopped = true; },
    onWaitingForInput: () => { stopped = true; declined = true; },
    onClearStreamingState: () => undefined,
    onEngineError: (error) => { failure = error; running = false; },
    onLoopError: (error) => { failure = error instanceof Error ? error : new Error(String(error)); running = false; },
    onCommittedMessage: (message) => { committed = message; },
    onCommit: (args) => engine.onMessageCommitted(args),
    upsertMessage: (message) => useMessageStore.getState().upsertMessage(message),
    updateCharacter: (id, patch) => useCharacterStore.getState().updateCharacter(id, patch),
    updateCharacters: (patches) => useCharacterStore.getState().updateCharacters(patches.map((item) => ({ id: item.id, updates: item.patch }))),
    appendEventMessage: (id, payload) => appendEvents(id, [payload]),
    appendEventMessages: (id, payloads, sourceMessageId) => appendEvents(id, payloads, sourceMessageId),
    updateChat: (id, patch) => useChatStore.getState().updateChat(id, patch),
    applyChatRuntimeDelta: (id, delta, patch) => useChatStore.getState().applyChatRuntimeDelta(id, delta, patch),
    recordSpeak: (id) => useSchedulerStore.getState().recordSpeak(id),
    getCooldownMap: () => useSchedulerStore.getState().lastSpeakTimestamps,
    resolveSessionEngine: loadSessionEngine,
    signal,
  });
  if (failure) throw failure;
  const reply = committed || committedTurn(chatId, task.id);
  if (!reply && !declined && !stopped && !signal.aborted) throw new Error('群聊回合未确认提交，结果需要核对');
  flushBufferedPersistenceWrites();
  return { output: reply ? { outcome: 'committed', messageId: reply.id } : { outcome: stopped ? 'stopped' : 'no_reply' } };
}

const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: executeTurn });

export async function listGroupBackgroundConversations(chatId?: string) {
  return (await runtime.list()).filter((item) => item.tasks[0]?.kind === 'group_conversation_turn' && (!chatId || item.run.chatId === chatId));
}

function nextTask(snapshot: WorkflowSnapshot): WorkflowTask {
  const id = `${snapshot.run.id}:turn:${snapshot.tasks.length + 1}`;
  return { id, runId: snapshot.run.id, kind: 'group_conversation_turn', input: { chatId: snapshot.run.chatId },
    dependsOn: snapshot.tasks.length ? [snapshot.tasks.at(-1)!.id] : [], status: 'queued', attempt: 0, updatedAt: Date.now() };
}

function waitsForReaderOrLearner(chat: GroupChat) {
  return chat.sessionKind?.scenarioId === 'story-reader' || resolveSessionFamilyKey(chat) === 'study';
}

async function startGroupBackgroundConversationOnce(chatId: string) {
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的群聊后台运行');
  const running = active.get(groupConversationRunId(chatId));
  if (running) {
    if (useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive) return running;
    await running;
  }
  const chat = useChatStore.getState().chats.find((item) => item.id === chatId && item.type === 'group' && item.deletedAt == null);
  if (!chat) throw new Error('群聊不可用');
  const runId = groupConversationRunId(chatId);
  const now = Date.now();
  const initial: WorkflowSnapshot = { run: { id: runId, chatId, goal: '群聊自动运行', status: 'active', planOpen: true, generation: 0, planVersion: 1, updatedAt: now }, tasks: [] };
  initial.tasks = [nextTask(initial)];
  const created = await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, (existing) => ({
    snapshot: existing || initial, value: !existing,
  }));
  if (!created) {
    const snapshot = await runtime.read(runId);
    if (!snapshot) throw new Error('群聊后台任务不存在');
    if (snapshot.tasks.some((task) => task.status === 'result_unknown' || task.status === 'failed')) throw new Error('群聊上次请求结果需要核对');
    if (snapshot.tasks.length && snapshot.tasks.every((task) => task.status === 'completed')
      && ((snapshot.tasks.at(-1)?.output as { outcome?: string } | undefined)?.outcome === 'stopped'
        || waitsForReaderOrLearner(chat))) {
      await runtime.addTasksOnce(runId, snapshot.run.planVersion, [nextTask(snapshot)]);
    }
  }
  await useChatStore.getState().updateChat(chatId, { isActive: true });
  return resumeGroupBackgroundConversation(chatId);
}

export function startGroupBackgroundConversation(chatId: string) {
  const runId = groupConversationRunId(chatId);
  const pending = starting.get(runId);
  if (pending) return pending;
  const operation = startGroupBackgroundConversationOnce(chatId);
  starting.set(runId, operation);
  void operation.finally(() => {
    if (starting.get(runId) === operation) starting.delete(runId);
  }).catch(() => undefined);
  return operation;
}

export async function resumeGroupBackgroundConversation(chatId: string) {
  const runId = groupConversationRunId(chatId);
  const existing = active.get(runId);
  if (existing) return existing;
  const run = await runtime.read(runId);
  if (!run) throw new Error('群聊后台任务不存在');
  if (run.tasks.some((task) => task.status === 'result_unknown' || task.status === 'failed')) throw new Error('群聊上次请求结果需要核对');
  const scope = currentWorkflowScope();
  const operation = navigator.locks.request(`${workflowRunLockName(scope, runId)}:driver`, { ifAvailable: true }, async (driver) => {
    if (!driver || currentWorkflowScope() !== scope) return;
    await indexedDbWorkflowRepository.transact(scope, runId, (current) => {
      if (!current) throw new Error('群聊后台任务不存在');
      return { snapshot: { ...current, run: { ...current.run, pauseRequested: false, updatedAt: Date.now() } }, value: undefined };
    });
    while (!getWorkspaceSignal().aborted && currentWorkflowScope() === scope) {
      const current = await runtime.read(runId);
      const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
      if (!current || !chat?.isActive || chat.deletedAt != null || current.run.status === 'cancelled') break;
      let next = current;
      if (current.tasks.every((task) => task.status === 'completed')) {
        if ((current.tasks.at(-1)?.output as { outcome?: string } | undefined)?.outcome === 'stopped') break;
        next = await runtime.addTasksOnce(runId, current.run.planVersion, [nextTask(current)]);
      }
      if (next.tasks.some((task) => task.status === 'result_unknown' || task.status === 'failed')) break;
      try {
        await scheduleBackgroundExecution(chatId, () => runWithConversationExecutionLock(scope, chatId,
          () => runtime.resume(runId, getWorkspaceSignal())), getWorkspaceSignal(), runId);
      } catch (error) {
        await useChatStore.getState().updateChat(chatId, { isActive: false });
        throw error;
      }
      publish();
      const latest = await runtime.read(runId);
      if (!latest || latest.run.status === 'paused' || latest.tasks.some((task) => task.status === 'result_unknown' || task.status === 'failed')) {
        await useChatStore.getState().updateChat(chatId, { isActive: false });
        break;
      }
      if ((latest.tasks.at(-1)?.output as { outcome?: string } | undefined)?.outcome === 'stopped'
        || waitsForReaderOrLearner(chat)) {
        await useChatStore.getState().updateChat(chatId, { isActive: false });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(300, 900 / (chat.speed || 1))));
    }
    const final = await runtime.read(runId);
    if (final?.run.status === 'active' && !useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive) {
      await runtime.pause(runId);
    }
  }).finally(() => { active.delete(runId); publish(); });
  active.set(runId, operation);
  publish();
  return operation;
}

export async function pauseGroupBackgroundConversation(chatId: string) {
  await useChatStore.getState().updateChat(chatId, { isActive: false });
  const runId = groupConversationRunId(chatId);
  if (await runtime.read(runId)) await runtime.requestPauseAfterCurrentBatch(runId);
  publish();
}

export async function recoverGroupBackgroundConversations() {
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的群聊后台恢复');
  const scope = currentWorkflowScope();
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
  ]);
  for (const item of await listGroupBackgroundConversations()) {
    if (active.has(item.run.id) || item.run.status === 'completed' || item.run.status === 'cancelled') continue;
    await navigator.locks.request(`${workflowRunLockName(scope, item.run.id)}:driver`, { ifAvailable: true }, async (driver) => {
      if (!driver || currentWorkflowScope() !== scope) return;
      await navigator.locks.request(workflowRunLockName(scope, item.run.id), { ifAvailable: true }, async (lock) => {
        if (!lock || currentWorkflowScope() !== scope) return;
        await indexedDbWorkflowRepository.transact(scope, item.run.id, (current) => {
          if (!current || current.run.status === 'completed' || current.run.status === 'cancelled') return { snapshot: current || item, value: undefined };
          const now = Date.now();
          const snapshot: WorkflowSnapshot = { ...current,
            run: { ...current.run, status: current.run.status === 'active' ? 'paused' : current.run.status, generation: current.run.generation + 1, updatedAt: now },
            tasks: current.tasks.map((task) => {
              if (task.status !== 'running' && task.status !== 'result_unknown') return task;
              const reply = task.attempt > 0 ? committedTurn(current.run.chatId, task.id) : null;
              return reply ? { ...task, status: 'completed', output: { outcome: 'committed', messageId: reply.id }, updatedAt: now }
                : task.status === 'result_unknown' ? task
                  : { ...task, status: 'result_unknown', error: '程序关闭前的群聊回合结果无法确认', updatedAt: now };
            }) };
          return { snapshot, value: undefined };
        });
        const chat = useChatStore.getState().chats.find((entry) => entry.id === item.run.chatId);
        if (chat?.isActive) await useChatStore.getState().updateChat(chat.id, { isActive: false });
      });
    });
  }
  publish();
}
