import { assertWorkspaceActive, getWorkspaceSignal, isWorkspaceActive, onWorkspaceShutdown } from './workspaceLifecycle';

export type ChatCompletionKind = 'text' | 'image';
export type ChatCompletionStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ChatCompletionTask {
  id: string;
  kind: ChatCompletionKind;
  chatId: string;
  chatName: string;
  field: string;
  label: string;
  status: ChatCompletionStatus;
  error?: string;
  warning?: string;
}

export interface ChatCompletionRecentError { id: string; title: string; message: string; createdAt: number }
export interface ChatCompletionSummary {
  text: { total: number; completed: number; failed: number; warnings: number; active: number; current?: string };
  image: { total: number; completed: number; failed: number; warnings: number; active: number; current?: string };
  recentErrors: ChatCompletionRecentError[];
}

type Runner = () => Promise<void | { warning?: string }>;
const queues: Record<ChatCompletionKind, Array<{ task: ChatCompletionTask; run: Runner }>> = { text: [], image: [] };
const running: Record<ChatCompletionKind, boolean> = { text: false, image: false };
const tasks = new Map<string, ChatCompletionTask>();
const dismissed = new Set<string>();
const listeners = new Set<(summary: ChatCompletionSummary) => void>();

function buildSummary(kind: ChatCompletionKind) {
  const entries = [...tasks.values()].filter((item) => item.kind === kind);
  const current = entries.find((item) => item.status === 'running');
  return {
    total: entries.length,
    completed: entries.filter((item) => item.status === 'succeeded').length,
    failed: entries.filter((item) => item.status === 'failed').length,
    warnings: entries.filter((item) => item.warning).length,
    active: entries.filter((item) => item.status === 'queued' || item.status === 'running').length,
    current: current ? `${current.chatName} · ${current.label}` : undefined,
  };
}

export function getChatCompletionSummary(): ChatCompletionSummary {
  return {
    text: buildSummary('text'), image: buildSummary('image'),
    recentErrors: [...tasks.values()]
      .filter((item) => item.status === 'failed' && item.error && !dismissed.has(item.id))
      .map((item) => ({ id: item.id, title: `${item.chatName || '未命名群聊'} · ${item.label}`, message: item.error || '生成失败', createdAt: Number(item.id.match(/chat-completion-(\d+)/)?.[1] || 0) }))
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

function publish() { const summary = getChatCompletionSummary(); listeners.forEach((listener) => listener(summary)); }

async function pump(kind: ChatCompletionKind) {
  if (!isWorkspaceActive()) return;
  if (running[kind]) return;
  const entry = queues[kind].shift();
  if (!entry) return;
  running[kind] = true;
  const signal = getWorkspaceSignal();
  entry.task.status = 'running'; publish();
  try {
    const result = await entry.run();
    signal.throwIfAborted();
    if (result?.warning) entry.task.warning = result.warning;
    entry.task.status = 'succeeded';
  } catch (error) {
    entry.task.status = 'failed';
    entry.task.error = error instanceof Error ? error.message : String(error);
  } finally {
    running[kind] = false; publish(); void pump(kind);
  }
}

export function enqueueChatCompletionTask(input: Omit<ChatCompletionTask, 'id' | 'status'> & { run: Runner }) {
  assertWorkspaceActive();
  const task: ChatCompletionTask = { ...input, id: `chat-completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'queued' };
  tasks.set(task.id, task); queues[task.kind].push({ task, run: input.run }); publish(); void pump(task.kind);
  return task.id;
}

export function getChatCompletionTaskStatus(chatId: string, field: string) {
  return [...tasks.values()].reverse().find((item) => item.chatId === chatId && item.field === field && (item.status === 'queued' || item.status === 'running'))?.status || null;
}
export function subscribeChatCompletionQueue(listener: (summary: ChatCompletionSummary) => void) { listeners.add(listener); listener(getChatCompletionSummary()); return () => listeners.delete(listener); }
export function dismissChatCompletionError(id: string) { dismissed.add(id); publish(); }
export function dismissAllChatCompletionErrors() { [...tasks.values()].filter((item) => item.status === 'failed').forEach((item) => dismissed.add(item.id)); publish(); }

onWorkspaceShutdown(() => {
  queues.text = [];
  queues.image = [];
  tasks.clear();
  dismissed.clear();
  publish();
});
