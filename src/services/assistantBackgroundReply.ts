import type { Message } from '../types/message';
import type { MessageBranchState } from '../types/chat';
import { projectCurrentChatMessages, projectMergedChatMessages } from './currentChatMessages';
import { buildBranchStateWithHead } from './messageBranching';
import { getWorkspaceSignal } from './workspaceLifecycle';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { createWorkflowRunRuntime, indexedDbWorkflowRepository, summarizeWorkflowRun, workflowRunLockName, WorkflowPreflightError, type WorkflowTask, type WorkflowSnapshot } from './workflowRunRuntime';
import { currentWorkflowScope } from './workflowRunRuntime';
import { scheduleBackgroundExecution } from './backgroundExecutionScheduler';
import { runWithConversationExecutionLock } from './conversationExecutionLock';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';

interface AssistantReplyInput {
  chatId: string;
  userMessageId: string;
  replyRunId?: string;
  selectedArtifactId?: string | null;
  expectedBranchLeafNodeId?: string | null;
  replyTimestamp?: number;
  revisionOfNodeId?: string;
  replySender?: { id: string; name: string };
  branchRegeneration?: {
    branchName: string;
    expectedActiveLeafNodeId: string | null;
    rewoundState: MessageBranchState;
  };
}

function isAssistantReplyInput(value: unknown): value is AssistantReplyInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as AssistantReplyInput;
  return typeof input.chatId === 'string' && typeof input.userMessageId === 'string'
    && (input.expectedBranchLeafNodeId === undefined || input.expectedBranchLeafNodeId === null || typeof input.expectedBranchLeafNodeId === 'string')
    && (input.replyTimestamp === undefined || (typeof input.replyTimestamp === 'number' && Number.isFinite(input.replyTimestamp)))
    && (input.revisionOfNodeId === undefined || typeof input.revisionOfNodeId === 'string')
    && (input.replySender === undefined || (typeof input.replySender.id === 'string' && typeof input.replySender.name === 'string'))
    && (input.branchRegeneration === undefined || (typeof input.branchRegeneration.branchName === 'string'
      && (input.branchRegeneration.expectedActiveLeafNodeId === null || typeof input.branchRegeneration.expectedActiveLeafNodeId === 'string')
      && typeof input.branchRegeneration.rewoundState === 'object' && input.branchRegeneration.rewoundState !== null));
}

function messagesForChat(chatId: string) {
  const state = useMessageStore.getState();
  const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
  if (!chat) throw new Error('助手会话不存在');
  return projectCurrentChatMessages({
    chatId,
    chat,
    activeMessages: state.messages.filter((message) => message.chatId === chatId),
    cachedWindow: state.messageWindowsByChatId[chatId],
  });
}

function committedAssistantReply(chatId: string, userMessageId: string, replyRunId?: string) {
  const state = useMessageStore.getState();
  return projectMergedChatMessages({
    chatId,
    activeMessages: state.messages.filter((message) => message.chatId === chatId),
    cachedWindow: state.messageWindowsByChatId[chatId]
      ? { ...state.messageWindowsByChatId[chatId], preserveBranchContext: true } : undefined,
  }).find((message) => message.type === 'ai' && !message.isDeleted && !message.isStreaming
    && message.metadata?.assistantReplyToUserMessageId === userMessageId
    && (!replyRunId || message.metadata?.assistantReplyRunId === replyRunId));
}

async function executeAssistantReplyUnlocked(task: WorkflowTask, signal: AbortSignal) {
  if (!isAssistantReplyInput(task.input)) throw new WorkflowPreflightError('助手任务输入无效');
  const input = task.input;
  const chatId = input.chatId;
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  let chat = useChatStore.getState().chats.find((item) => item.id === chatId);
  if (!chat || chat.type !== 'assistant') throw new WorkflowPreflightError('助手会话已不存在');
  if (chat.deletedAt != null) throw new WorkflowPreflightError('助手会话已删除');
  const expectedBranchLeafNodeId = input.branchRegeneration
    ? input.branchRegeneration.expectedActiveLeafNodeId
    : input.expectedBranchLeafNodeId;
  if (expectedBranchLeafNodeId !== undefined && chat.messageBranchState?.activeLeafNodeId !== expectedBranchLeafNodeId) {
    throw new WorkflowPreflightError('消息分支已切换，已停止这条助手回复');
  }
  if (input.branchRegeneration) {
    await useChatStore.getState().updateChat(chatId, { messageBranchState: input.branchRegeneration.rewoundState });
    flushBufferedPersistenceWrites();
    chat = { ...chat, messageBranchState: input.branchRegeneration.rewoundState };
  }
  const allMessages = messagesForChat(chatId);
  const userMessage = allMessages.find((message) => message.id === input.userMessageId);
  if (!userMessage || userMessage.isDeleted) throw new WorkflowPreflightError('原始用户消息已不存在');
  const committed = committedAssistantReply(chatId, input.userMessageId, input.replyRunId);
  if (committed) return { output: committed.id };
  const messages = allMessages.filter((message) => message.timestamp <= userMessage.timestamp);
  const settings = useSettingsStore.getState();
  const { runAssistantChatReplyFlow } = await import('./assistantChatFlow');
  const result = await runAssistantChatReplyFlow({
    api: settings.api,
    aiProfiles: settings.aiProfiles,
    chat,
    chatId,
    currentMessages: messages,
    replyRunId: input.replyRunId,
    selectedArtifactId: input.selectedArtifactId,
    timestamp: input.replyTimestamp ?? userMessage.timestamp + 1,
    upsertMessage: upsertAssistantBackgroundMessage,
    updateChat: (id, patch) => useChatStore.getState().updateChat(id, patch),
    revisionOfNodeId: input.revisionOfNodeId,
    replySender: input.replySender,
    signal,
    shouldContinue: () => !signal.aborted && useChatStore.getState().chats.some((item) => item.id === chatId && item.deletedAt == null
      && (!input.branchRegeneration || item.messageBranchState?.activeLeafNodeId === input.branchRegeneration.rewoundState.activeLeafNodeId)),
  });
  if (input.branchRegeneration && result) {
    const latestChat = useChatStore.getState().chats.find((item) => item.id === chatId);
    const regeneratedNodeId = result.metadata?.branching?.nodeId || result.clientKey || result.id;
    if (latestChat?.type === 'assistant' && latestChat.deletedAt == null
      && latestChat.messageBranchState?.activeLeafNodeId === input.branchRegeneration.rewoundState.activeLeafNodeId) {
      const messageBranchState = buildBranchStateWithHead(latestChat.messageBranchState, regeneratedNodeId, input.branchRegeneration.branchName);
      await useChatStore.getState().updateChat(chatId, { messageBranchState, lastMessageAt: result.timestamp, latestMessage: result });
    }
  }
  flushBufferedPersistenceWrites();
  return { output: result?.id || null };
}

async function executeAssistantReply(task: WorkflowTask, signal: AbortSignal) {
  if (!isAssistantReplyInput(task.input)) throw new WorkflowPreflightError('助手任务输入无效');
  if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new WorkflowPreflightError('此设备不支持安全的会话串行执行');
  const lockName = `pneumata-assistant-chat-${currentWorkflowScope()}-${task.input.chatId}`;
  return navigator.locks.request(lockName, async () => executeAssistantReplyUnlocked(task, signal));
}

const assistantRuntime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: executeAssistantReply });
const activeChatCounts = new Map<string, number>();
const activeRunIds = new Set<string>();
const startingReplies = new Map<string, Promise<{ snapshot: WorkflowSnapshot; summary: ReturnType<typeof summarizeWorkflowRun> }>>();
const activeListeners = new Set<() => void>();
const publishActive = () => activeListeners.forEach((listener) => listener());
const runListeners = new Set<() => void>();
let runRevision = 0;
const publishRun = () => { runRevision += 1; runListeners.forEach((listener) => listener()); };

export function subscribeAssistantBackgroundRunChanges(listener: () => void) {
  runListeners.add(listener);
  return () => { runListeners.delete(listener); };
}

export function getAssistantBackgroundRunRevision() {
  return runRevision;
}
const streamingMessages = new Map<string, Message>();
const streamingListeners = new Set<() => void>();
const publishStreaming = () => streamingListeners.forEach((listener) => listener());
let streamingSnapshot: Message[] = [];

export function subscribeAssistantBackgroundStreaming(listener: () => void) {
  streamingListeners.add(listener);
  return () => { streamingListeners.delete(listener); };
}

export function getAssistantBackgroundStreamingSnapshot() {
  return streamingSnapshot;
}

function upsertAssistantBackgroundMessage(message: Message) {
  if (message.isStreaming) {
    if (message.isDeleted) streamingMessages.delete(message.chatId);
    else streamingMessages.set(message.chatId, message);
    streamingSnapshot = [...streamingMessages.values()];
    publishStreaming();
    return;
  }
  streamingMessages.delete(message.chatId);
  streamingSnapshot = [...streamingMessages.values()];
  publishStreaming();
  useMessageStore.getState().upsertMessage(message);
}

export function subscribeAssistantBackgroundReplies(listener: () => void) {
  activeListeners.add(listener);
  return () => { activeListeners.delete(listener); };
}

export function getActiveAssistantBackgroundChats() {
  return [...activeChatCounts.keys()].sort().join('\n');
}

export function assistantReplyRunId(chatId: string, userMessageId: string) {
  return `${chatId}\n${userMessageId}`;
}

export function startAssistantBackgroundReply(params: {
  chatId: string;
  userMessageId: string;
  selectedArtifactId?: string | null;
  expectedBranchLeafNodeId?: string | null;
  runId?: string;
  replyRunId?: string;
  replyTimestamp?: number;
  revisionOfNodeId?: string;
  replySender?: { id: string; name: string };
  branchRegeneration?: AssistantReplyInput['branchRegeneration'];
}) {
  const runId = params.runId || assistantReplyRunId(params.chatId, params.userMessageId);
  const pending = startingReplies.get(runId);
  if (pending) return pending;
  const operation = (async () => {
    const now = Date.now();
    const snapshot: WorkflowSnapshot = {
        run: { id: runId, chatId: params.chatId, goal: params.branchRegeneration ? '重新回答助手消息' : '回复用户消息', status: 'active', generation: 0, planVersion: 1, updatedAt: now },
      tasks: [{ id: params.userMessageId, runId, kind: 'assistant_reply', input: { chatId: params.chatId, userMessageId: params.userMessageId,
        replyRunId: params.replyRunId || runId, selectedArtifactId: params.selectedArtifactId, expectedBranchLeafNodeId: params.expectedBranchLeafNodeId,
        replyTimestamp: params.replyTimestamp, revisionOfNodeId: params.revisionOfNodeId, replySender: params.replySender,
        branchRegeneration: params.branchRegeneration }, dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }],
    };
    const created = await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, (existing) => ({
      snapshot: existing || snapshot, value: !existing,
    }));
    if (created) publishRun();
    return runAssistantBackgroundReply(runId, params.chatId, `start-${params.userMessageId}`);
  })();
  startingReplies.set(runId, operation);
  void operation.finally(() => {
    if (startingReplies.get(runId) === operation) startingReplies.delete(runId);
  }).catch(() => undefined);
  return operation;
}

async function runAssistantBackgroundReply(runId: string, chatId: string, commandId: string) {
  activeRunIds.add(runId);
  activeChatCounts.set(chatId, (activeChatCounts.get(chatId) || 0) + 1);
  publishActive();
  try {
    const scope = currentWorkflowScope();
    const workspaceSignal = getWorkspaceSignal();
    const result = await scheduleBackgroundExecution(chatId, () => runWithConversationExecutionLock(scope, chatId,
      (signal) => assistantRuntime.resume(runId, signal, commandId), workspaceSignal), workspaceSignal, runId);
    publishRun();
    return { snapshot: result, summary: summarizeWorkflowRun(result) };
  } finally {
    activeRunIds.delete(runId);
    const remaining = (activeChatCounts.get(chatId) || 1) - 1;
    if (remaining) activeChatCounts.set(chatId, remaining);
    else activeChatCounts.delete(chatId);
    publishActive();
    publishRun();
  }
}

export async function recoverAssistantBackgroundReplies() {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new Error('此设备不支持安全的工作流恢复');
  const runs = await listAssistantBackgroundReplies();
  const recovered: WorkflowSnapshot[] = [];
  for (const item of runs) {
    if (activeRunIds.has(item.run.id)) continue;
    if (await reconcileCommittedAssistantReply(item.run.id)) continue;
    if (item.run.status !== 'active') continue;
    const storageScope = currentWorkflowScope();
    const interrupted = await navigator.locks.request(workflowRunLockName(storageScope, item.run.id), { ifAvailable: true }, async (lock) => {
      if (!lock) return null;
      if (currentWorkflowScope() !== storageScope) return null;
      return indexedDbWorkflowRepository.transact(storageScope, item.run.id, (current) => {
        if (!current || current.run.status !== 'active') return { snapshot: current || item, value: current || item };
        const snapshot: WorkflowSnapshot = {
          ...current,
          run: { ...current.run, status: 'paused', generation: current.run.generation + 1, updatedAt: Date.now() },
          tasks: current.tasks.map((task) => task.status === 'running'
            ? { ...task, status: 'result_unknown', error: '程序关闭前的请求结果暂时无法确认', updatedAt: Date.now() }
            : task),
        };
        return { snapshot, value: snapshot };
      });
    });
    if (interrupted) recovered.push(interrupted);
  }
  if (recovered.length) publishRun();
  return recovered.map((item) => ({ ...item, summary: summarizeWorkflowRun(item) }));
}

export async function listAssistantBackgroundReplies(chatId?: string) {
  const runs = await assistantRuntime.list();
  return runs.filter((item) => item.tasks[0]?.kind === 'assistant_reply' && (!chatId || item.run.chatId === chatId));
}

async function reconcileCommittedAssistantReply(runId: string) {
  const scope = currentWorkflowScope();
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
  ]);
  const reconciled = await navigator.locks.request(workflowRunLockName(scope, runId), { ifAvailable: true }, async (lock) => {
    if (!lock || currentWorkflowScope() !== scope) return false;
    const run = await indexedDbWorkflowRepository.read(scope, runId);
    const task = run?.tasks[0];
    if (!run || !task || run.tasks.length !== 1 || task.kind !== 'assistant_reply'
      || task.attempt < 1 || run.run.status === 'completed') return false;
    const chat = useChatStore.getState().chats.find((item) => item.id === run.run.chatId && item.type === 'assistant' && item.deletedAt == null);
    if (!chat) return false;
    const input = task.input as AssistantReplyInput;
    const reply = committedAssistantReply(chat.id, task.id, input.replyRunId);
    if (!reply) return false;
    if (input.branchRegeneration && chat.messageBranchState?.activeLeafNodeId === input.branchRegeneration.rewoundState.activeLeafNodeId) {
      const nodeId = reply.metadata?.branching?.nodeId || reply.clientKey || reply.id;
      const messageBranchState = buildBranchStateWithHead(chat.messageBranchState, nodeId, input.branchRegeneration.branchName);
      await useChatStore.getState().updateChat(chat.id, { messageBranchState, lastMessageAt: reply.timestamp, latestMessage: reply });
      flushBufferedPersistenceWrites();
    }
    return indexedDbWorkflowRepository.transact(scope, runId, (current) => {
      if (!current || current.run.status === 'completed' || current.tasks[0]?.id !== task.id) return { snapshot: current || run, value: false };
      const snapshot: WorkflowSnapshot = {
        ...current,
        run: { ...current.run, status: 'completed', generation: current.run.generation + 1, updatedAt: Date.now() },
        tasks: [{ ...current.tasks[0], status: 'completed', output: reply.id, error: undefined, updatedAt: Date.now() }],
      };
      return { snapshot, value: true };
    });
  });
  if (reconciled) publishRun();
  return reconciled;
}

export async function resumeAssistantBackgroundReply(runId: string, commandId: string) {
  if (!activeRunIds.has(runId)) await reconcileCommittedAssistantReply(runId);
  const run = await assistantRuntime.read(runId);
  if (!run) throw new Error('助手任务不存在');
  if (run.run.status === 'cancelled' || run.run.status === 'completed') return { snapshot: run, summary: summarizeWorkflowRun(run) };
  if (run.tasks.some((task) => task.status === 'result_unknown')) {
    return { snapshot: run, summary: summarizeWorkflowRun(run) };
  }
  return runAssistantBackgroundReply(runId, run.run.chatId, commandId);
}

export async function retryAssistantBackgroundReply(runId: string, commandId: string, confirmUncertain = false) {
  const source = await assistantRuntime.read(runId);
  if (!source || source.tasks.length !== 1 || source.tasks[0].kind !== 'assistant_reply') throw new Error('助手任务不存在或无法重试');
  const task = source.tasks[0];
  if (task.status === 'result_unknown' && !confirmUncertain) throw new Error('请求结果未知，必须确认可能重复调用后才能重试');
  if (task.status !== 'failed' && task.status !== 'result_unknown') throw new Error('只有失败或结果未知的助手任务可以重试');
  if (!isAssistantReplyInput(task.input)) throw new Error('助手任务输入无效，无法安全重试');
  const nextRunId = `${runId}\nretry\n${commandId}`;
  const input: AssistantReplyInput = { ...task.input, replyRunId: nextRunId };
  const now = Date.now();
  const snapshot: WorkflowSnapshot = {
    run: { id: nextRunId, chatId: source.run.chatId, goal: source.run.goal, status: 'active', generation: 0, planVersion: 1, updatedAt: now },
    tasks: [{ ...task, id: `${task.id}\n${commandId}`, runId: nextRunId, input, output: undefined, error: undefined, status: 'queued', attempt: 0, updatedAt: now }],
  };
  await indexedDbWorkflowRepository.transact(currentWorkflowScope(), nextRunId, (existing) => ({ snapshot: existing || snapshot, value: !existing }));
  publishRun();
  return runAssistantBackgroundReply(nextRunId, source.run.chatId, `retry-${commandId}`);
}
