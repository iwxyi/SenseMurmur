import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useSchedulerStore } from '../stores/useSchedulerStore';
import { buildPrivateSessionEvent } from './directSessionHelpers';
import { persistLocalFirstMessage, persistLocalFirstMessages } from './chatCommitMessage';
import { projectCurrentChatMessages, projectMergedChatMessages } from './currentChatMessages';
import { normalizeRuntimeEvent, buildRuntimeEventMessageContent } from './runtimeEventFactory';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { loadSessionEngine } from './sessionEngineLoader';
import { runSessionLoop } from './sessionRunner';
import { scheduleBackgroundExecution } from './backgroundExecutionScheduler';
import { runWithConversationExecutionLock } from './conversationExecutionLock';
import { getWorkspaceSignal } from './workspaceLifecycle';
import { createWorkflowRunRuntime, currentWorkflowScope, indexedDbWorkflowRepository, workflowRunLockName, WorkflowPreflightError, type WorkflowSnapshot, type WorkflowTask } from './workflowRunRuntime';

function messagesForChat(chatId: string, chat: GroupChat) {
  const state = useMessageStore.getState();
  return projectCurrentChatMessages({ chatId, chat,
    activeMessages: state.messages.filter((message) => message.chatId === chatId),
    cachedWindow: state.messageWindowsByChatId[chatId] });
}

function committedReply(chatId: string, userMessageId: string) {
  const state = useMessageStore.getState();
  return projectMergedChatMessages({ chatId,
    activeMessages: state.messages.filter((message) => message.chatId === chatId),
    cachedWindow: state.messageWindowsByChatId[chatId]
      ? { ...state.messageWindowsByChatId[chatId], preserveBranchContext: true } : undefined,
  }).find((item) => item.type === 'ai' && !item.isDeleted && !item.isStreaming
    && item.metadata?.directReplyToUserMessageId === userMessageId
    && (!item.metadata?.turnSegment || item.metadata.turnSegment.index === item.metadata.turnSegment.count - 1));
}

async function appendEvent(chatId: string, payload: Parameters<Parameters<typeof runSessionLoop>[0]['appendEventMessage']>[1], sourceMessageId?: string) {
  const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
  const event = normalizeRuntimeEvent(chat ? buildPrivateSessionEvent(chat, payload) : payload);
  await persistLocalFirstMessage({
    message: { chatId, type: 'event', senderId: 'system', senderName: 'System',
      content: buildRuntimeEventMessageContent({ ...event, sourceMessageId: event.sourceMessageId || sourceMessageId }), emotion: 0 },
    timestamp: event.createdAt,
    upsertMessage: (message) => useMessageStore.getState().upsertMessage(message),
  });
}

async function execute(task: WorkflowTask, signal: AbortSignal) {
  if (task.kind !== 'ai_direct_reply' || typeof task.input !== 'object' || !task.input) throw new WorkflowPreflightError('AI 私聊任务输入无效');
  const input = task.input as { chatId?: unknown; userMessageId?: unknown };
  if (typeof input.chatId !== 'string' || typeof input.userMessageId !== 'string') throw new WorkflowPreflightError('AI 私聊任务输入无效');
  const { chatId, userMessageId } = input as { chatId: string; userMessageId: string };
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useCharacterStore.persist.hasHydrated() ? Promise.resolve() : useCharacterStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
  if (!chat || chat.type !== 'ai_direct' || chat.deletedAt != null) throw new WorkflowPreflightError('AI 私聊会话不可用');
  const members = await Promise.all(chat.memberIds.map(async (id) => useCharacterStore.getState().characters.find((item) => item.id === id)
    || useCharacterStore.getState().loadCharacter(id)));
  if (members.some((member) => !member)) throw new WorkflowPreflightError('AI 私聊角色已不存在');
  const source = messagesForChat(chatId, chat).find((item) => item.id === userMessageId && item.type === 'user' && !item.isDeleted);
  if (!source) throw new WorkflowPreflightError('原始用户消息已不存在');
  const existingReply = committedReply(chatId, userMessageId);
  if (existingReply) return { output: existingReply.id };
  const settings = useSettingsStore.getState();
  const engine = await loadSessionEngine(chat);
  let running = true;
  let declined = false;
  let generationError: Error | null = null;
  let committed: Message | null = null;
  const currentChat = () => useChatStore.getState().chats.find((item) => item.id === chatId);
  await runSessionLoop({
    loopId: `ai-direct-${task.runId}`,
    executionMode: 'single_turn', replyToUserMessageId: userMessageId,
    chatId, chat, characters: members.filter((member): member is NonNullable<typeof member> => Boolean(member)),
    api: settings.aiProfiles,
    getCurrentMessages: () => messagesForChat(chatId, currentChat() || chat).filter((message) =>
      message.timestamp <= source.timestamp || message.metadata?.directReplyToUserMessageId === userMessageId),
    getCurrentChat: currentChat,
    getKnownConversations: () => useChatStore.getState().chats,
    getCurrentCharacters: () => useCharacterStore.getState().characters,
    ensureCharacterDetail: (id) => useCharacterStore.getState().loadCharacter(id),
    isRunning: () => running && !signal.aborted,
    isPaused: () => !running || signal.aborted,
    isActiveLoop: () => running && !signal.aborted && currentChat()?.type === 'ai_direct' && currentChat()?.deletedAt == null,
    pauseLoop: () => { running = false; },
    onSpeakerSelected: () => undefined,
    onMessageChunk: () => undefined,
    onDiscardStreamingMessage: () => undefined,
    onNoSendDecision: () => { declined = true; },
    onQuiet: () => { declined = true; },
    onIdle: () => { declined = true; },
    onWaitingForInput: () => { declined = true; },
    onClearStreamingState: () => undefined,
    onEngineError: (error) => { generationError = error; running = false; },
    onLoopError: (error) => { generationError = error instanceof Error ? error : new Error(String(error)); running = false; },
    onCommittedMessage: (message) => { committed = message; },
    onCommit: (args) => engine.onMessageCommitted(args),
    upsertMessage: (message) => useMessageStore.getState().upsertMessage(message),
    updateCharacter: (id, patch) => useCharacterStore.getState().updateCharacter(id, patch),
    updateCharacters: (patches) => useCharacterStore.getState().updateCharacters(patches.map((item) => ({ id: item.id, updates: item.patch }))),
    appendEventMessage: (id, payload) => appendEvent(id, payload),
    appendEventMessages: async (id, payloads, sourceMessageId) => {
      const target = currentChat();
      await persistLocalFirstMessages({
        messages: payloads.map((payload) => {
          const event = normalizeRuntimeEvent(target ? buildPrivateSessionEvent(target, payload) : payload);
          return { message: { chatId: id, type: 'event' as const, senderId: 'system', senderName: 'System',
            content: buildRuntimeEventMessageContent({ ...event, sourceMessageId: event.sourceMessageId || sourceMessageId }), emotion: 0 }, timestamp: event.createdAt };
        }),
        upsertMessages: (messages) => useMessageStore.getState().upsertMessages(messages),
      });
    },
    updateChat: (id, patch) => useChatStore.getState().updateChat(id, patch),
    applyChatRuntimeDelta: (id, delta, patch) => useChatStore.getState().applyChatRuntimeDelta(id, delta, patch),
    recordSpeak: (id) => useSchedulerStore.getState().recordSpeak(id),
    getCooldownMap: () => useSchedulerStore.getState().lastSpeakTimestamps,
    resolveSessionEngine: loadSessionEngine,
    signal,
  });
  if (generationError) throw generationError;
  const reply = committed || committedReply(chatId, userMessageId);
  if (!reply && declined) return { output: { outcome: 'no_reply' } };
  if (!reply) throw new Error('AI 私聊未提交回复，结果需要核对');
  flushBufferedPersistenceWrites();
  return { output: reply.id };
}

const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute });
const active = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
function publish() { revision += 1; listeners.forEach((listener) => listener()); }
export function subscribeAiDirectBackgroundReplies(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getAiDirectBackgroundRevision() { return revision; }
export function aiDirectReplyRunId(chatId: string, userMessageId: string) { return `ai-direct-reply-${chatId}\n${userMessageId}`; }
export function isAiDirectBackgroundActive(chatId: string) { return [...active].some((id) => id.startsWith(`ai-direct-reply-${chatId}\n`)); }
export async function listAiDirectBackgroundReplies(chatId?: string) {
  return (await runtime.list()).filter((item) => item.tasks[0]?.kind === 'ai_direct_reply' && (!chatId || item.run.chatId === chatId));
}
async function reconcileCommittedAiDirectReply(runId: string) {
  const scope = currentWorkflowScope();
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
  ]);
  const reconciled = await navigator.locks.request(workflowRunLockName(scope, runId), { ifAvailable: true }, async (lock) => {
    if (!lock || currentWorkflowScope() !== scope) return false;
    const run = await indexedDbWorkflowRepository.read(scope, runId);
    const task = run?.tasks[0];
    if (!run || !task || run.tasks.length !== 1 || task.kind !== 'ai_direct_reply' || task.attempt < 1 || run.run.status === 'completed') return false;
    const chat = useChatStore.getState().chats.find((item) => item.id === run.run.chatId && item.type === 'ai_direct' && item.deletedAt == null);
    const reply = chat ? committedReply(chat.id, task.id) : null;
    if (!reply) return false;
    return indexedDbWorkflowRepository.transact(scope, runId, (current) => {
      if (!current || current.run.status === 'completed' || current.tasks[0]?.id !== task.id) return { snapshot: current || run, value: false };
      const snapshot: WorkflowSnapshot = { ...current,
        run: { ...current.run, status: 'completed', generation: current.run.generation + 1, updatedAt: Date.now() },
        tasks: [{ ...current.tasks[0], status: 'completed', output: reply.id, error: undefined, updatedAt: Date.now() }] };
      return { snapshot, value: true };
    });
  });
  if (reconciled) publish();
  return reconciled;
}
export async function startAiDirectBackgroundReply(chatId: string, userMessageId: string) {
  const runId = aiDirectReplyRunId(chatId, userMessageId);
  if (!await runtime.read(runId)) {
    const now = Date.now();
    const snapshot: WorkflowSnapshot = { run: { id: runId, chatId, goal: 'AI 私聊回复', status: 'active', generation: 0, planVersion: 1, updatedAt: now },
      tasks: [{ id: userMessageId, runId, kind: 'ai_direct_reply', input: { chatId, userMessageId }, dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }] };
    await runtime.create(snapshot);
    publish();
  }
  return resumeAiDirectBackgroundReply(runId);
}
export async function resumeAiDirectBackgroundReply(runId: string) {
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的 AI 私聊任务恢复');
  if (!active.has(runId)) await reconcileCommittedAiDirectReply(runId);
  const run = await runtime.read(runId);
  if (!run) throw new Error('AI 私聊任务不存在');
  if (run.run.status === 'completed' || run.tasks.some((task) => task.status === 'result_unknown')) return run;
  const scope = currentWorkflowScope();
  active.add(runId);
  publish();
  try {
    const result = await scheduleBackgroundExecution(run.run.chatId, () => runWithConversationExecutionLock(scope, run.run.chatId,
      () => runtime.resume(runId, getWorkspaceSignal())), getWorkspaceSignal(), runId);
    publish();
    return result;
  } finally { active.delete(runId); publish(); }
}
export async function recoverAiDirectBackgroundReplies() {
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的 AI 私聊任务恢复');
  const scope = currentWorkflowScope();
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
  ]);
  for (const item of await listAiDirectBackgroundReplies()) {
    if (item.run.status === 'completed' || active.has(item.run.id)) continue;
    if (await reconcileCommittedAiDirectReply(item.run.id)) continue;
    if (item.run.status !== 'active') continue;
    await navigator.locks.request(workflowRunLockName(scope, item.run.id), { ifAvailable: true }, async (lock) => {
      if (!lock || currentWorkflowScope() !== scope) return;
      await indexedDbWorkflowRepository.transact(scope, item.run.id, (current) => {
        if (!current || current.run.status !== 'active') return { snapshot: current || item, value: undefined };
        const snapshot: WorkflowSnapshot = { ...current,
          run: { ...current.run, status: 'paused', generation: current.run.generation + 1, updatedAt: Date.now() },
          tasks: current.tasks.map((task) => task.status === 'running'
            ? { ...task, status: 'result_unknown', error: '程序关闭前的回复结果无法确认', updatedAt: Date.now() } : task) };
        return { snapshot, value: undefined };
      });
    });
  }
  publish();
}
