import { onWorkspaceShutdown } from './workspaceLifecycle';
import { getBackgroundExecutionPreferences, subscribeBackgroundExecutionPreferences } from './backgroundExecutionPreferences';

interface QueuedWork<T> {
  chatId: string;
  workId?: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const queue: QueuedWork<unknown>[] = [];
const activeChats = new Set<string>();
const activeWorkIds = new Set<string>();
const listeners = new Set<() => void>();
let activeCount = 0;
let dispatchSequence = 0;
const lastDispatchByChat = new Map<string, number>();

function publish() { listeners.forEach((listener) => listener()); }

export function subscribeBackgroundExecution(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getBackgroundExecutionSummary() {
  return { active: activeCount, queued: queue.length, activeChatIds: [...activeChats], activeWorkIds: [...activeWorkIds] };
}

function pump() {
  while (activeCount < getBackgroundExecutionPreferences().maxActiveConversations) {
    let index = -1;
    let oldestDispatch = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < queue.length; candidate += 1) {
      const item = queue[candidate];
      if (activeChats.has(item.chatId)) continue;
      const lastDispatch = lastDispatchByChat.get(item.chatId) || 0;
      if (lastDispatch < oldestDispatch) {
        index = candidate;
        oldestDispatch = lastDispatch;
      }
    }
    if (index < 0) break;
    const item = queue.splice(index, 1)[0];
    if (item.onAbort) item.signal?.removeEventListener('abort', item.onAbort);
    if (item.signal?.aborted) {
      item.reject(item.signal.reason || new Error('任务已取消'));
      continue;
    }
    activeChats.add(item.chatId);
    lastDispatchByChat.delete(item.chatId);
    lastDispatchByChat.set(item.chatId, ++dispatchSequence);
    if (lastDispatchByChat.size > 256) {
      for (const chatId of lastDispatchByChat.keys()) {
        if (activeChats.has(chatId)) continue;
        lastDispatchByChat.delete(chatId);
        if (lastDispatchByChat.size <= 192) break;
      }
    }
    if (item.workId) activeWorkIds.add(item.workId);
    activeCount += 1;
    publish();
    void Promise.resolve().then(() => {
      if (item.signal?.aborted) throw item.signal.reason || new Error('任务已取消');
      return item.run();
    }).then(item.resolve, item.reject).finally(() => {
      activeChats.delete(item.chatId);
      if (item.workId) activeWorkIds.delete(item.workId);
      activeCount -= 1;
      publish();
      pump();
    });
  }
  publish();
}

export function scheduleBackgroundExecution<T>(chatId: string, run: () => Promise<T>, signal?: AbortSignal, workId?: string): Promise<T> {
  if (!chatId) return Promise.reject(new Error('后台任务缺少会话'));
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('任务已取消'));
  return new Promise<T>((resolve, reject) => {
    const item: QueuedWork<T> = { chatId, workId, run, resolve, reject, signal };
    item.onAbort = () => {
      const index = queue.indexOf(item as QueuedWork<unknown>);
      if (index < 0) return;
      queue.splice(index, 1);
      reject(signal?.reason || new Error('任务已取消'));
      publish();
    };
    signal?.addEventListener('abort', item.onAbort, { once: true });
    queue.push(item as QueuedWork<unknown>);
    pump();
  });
}

onWorkspaceShutdown(() => {
  const pending = queue.splice(0);
  for (const item of pending) {
    if (item.onAbort) item.signal?.removeEventListener('abort', item.onAbort);
    item.reject(new Error('账号已切换，排队任务已暂停'));
  }
  publish();
});

subscribeBackgroundExecutionPreferences(pump);
