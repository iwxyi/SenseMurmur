import { assertWorkspaceActive, getWorkspaceSignal, isWorkspaceActive, onWorkspaceShutdown } from './workspaceLifecycle';

export type CharacterCompletionKind = 'text' | 'image';
export type CharacterCompletionStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface CharacterCompletionTask {
  id: string;
  kind: CharacterCompletionKind;
  characterId: string;
  characterName: string;
  field: string;
  label: string;
  status: CharacterCompletionStatus;
  error?: string;
  warning?: string;
}

export interface CharacterCompletionSummary {
  text: { total: number; completed: number; failed: number; warnings: number; active: number; current?: string };
  image: { total: number; completed: number; failed: number; warnings: number; active: number; current?: string };
  recentErrors: CharacterCompletionRecentError[];
}

export interface CharacterCompletionRecentError {
  id: string;
  title: string;
  message: string;
  createdAt: number;
}

type Runner = () => Promise<void | { warning?: string }>;
const queues: Record<CharacterCompletionKind, Array<{ task: CharacterCompletionTask; run: Runner }>> = { text: [], image: [] };
const running: Record<CharacterCompletionKind, boolean> = { text: false, image: false };
const allTasks = new Map<string, CharacterCompletionTask>();
const dismissedErrorIds = new Set<string>();
const listeners = new Set<(summary: CharacterCompletionSummary) => void>();

function summaryFor(kind: CharacterCompletionKind) {
  const tasks = [...allTasks.values()].filter((task) => task.kind === kind);
  const active = tasks.find((task) => task.status === 'running');
  return {
    total: tasks.length,
    completed: tasks.filter((task) => task.status === 'succeeded').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    warnings: tasks.filter((task) => Boolean(task.warning)).length,
    active: tasks.filter((task) => task.status === 'queued' || task.status === 'running').length,
    current: active ? `${active.characterName} · ${active.label}` : undefined,
  };
}

export function getCharacterCompletionSummary(): CharacterCompletionSummary {
  return {
    text: summaryFor('text'),
    image: summaryFor('image'),
    recentErrors: [...allTasks.values()]
      .filter((task) => task.status === 'failed' && task.error && !dismissedErrorIds.has(task.id))
      .map((task) => ({ id: task.id, title: `${task.characterName || '未命名角色'} · ${task.label}`, message: task.error || '生成失败', createdAt: Number(task.id.match(/character-completion-(\d+)/)?.[1] || 0) }))
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

export function dismissCharacterCompletionError(id: string) {
  dismissedErrorIds.add(id);
  publish();
}

export function dismissAllCharacterCompletionErrors() {
  [...allTasks.values()].forEach((task) => {
    if (task.status === 'failed') dismissedErrorIds.add(task.id);
  });
  publish();
}

export function getCharacterCompletionTaskStatus(characterId: string, field: string): CharacterCompletionStatus | null {
  const task = [...allTasks.values()]
    .reverse()
    .find((item) => item.characterId === characterId && item.field === field && (item.status === 'queued' || item.status === 'running'));
  return task?.status || null;
}

export function subscribeCharacterCompletionQueue(listener: (summary: CharacterCompletionSummary) => void) {
  listeners.add(listener);
  listener(getCharacterCompletionSummary());
  return () => listeners.delete(listener);
}

function publish() {
  const summary = getCharacterCompletionSummary();
  listeners.forEach((listener) => listener(summary));
}

async function pump(kind: CharacterCompletionKind) {
  if (!isWorkspaceActive()) return;
  if (running[kind]) return;
  const entry = queues[kind].shift();
  if (!entry) return;
  running[kind] = true;
  const signal = getWorkspaceSignal();
  entry.task.status = 'running';
  publish();
  try {
    const result = await entry.run();
    signal.throwIfAborted();
    if (result?.warning) entry.task.warning = result.warning;
    entry.task.status = 'succeeded';
  } catch (error) {
    entry.task.status = 'failed';
    entry.task.error = error instanceof Error ? error.message : String(error);
  } finally {
    running[kind] = false;
    publish();
    void pump(kind);
  }
}

export function enqueueCharacterCompletionTask(input: Omit<CharacterCompletionTask, 'id' | 'status'> & { run: Runner }) {
  assertWorkspaceActive();
  const task: CharacterCompletionTask = { ...input, id: `character-completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'queued' };
  allTasks.set(task.id, task);
  queues[task.kind].push({ task, run: input.run });
  publish();
  void pump(task.kind);
  return task.id;
}

export function clearCompletedCharacterCompletionTasks() {
  [...allTasks.entries()].forEach(([id, task]) => { if (task.status === 'succeeded' || task.status === 'failed') allTasks.delete(id); });
  publish();
}

onWorkspaceShutdown(() => {
  queues.text = [];
  queues.image = [];
  allTasks.clear();
  dismissedErrorIds.clear();
  publish();
});
