import type { StoreApi } from 'zustand';
import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from './authStorageScope';
import type { LocalOutboxScopeType } from './localOutboxProjection';
import { recordPersistenceFailure } from './persistenceHealth';

type QueueEntry = { id: string };
export type SyncTaskQueueField = 'pendingOperations' | 'jobs';

export function syncTaskQueueStorageKey(scope: LocalOutboxScopeType) {
  const names = { character: 'characters', chat: 'chats', message: 'messages', artifact: 'character-artifacts' };
  return scopedStorageKey(`${names[scope]}-${getLocalDataUserId()}`);
}

function cancellationPrefix(queueStorageKey: string) {
  return `${queueStorageKey}:cancelled-task:`;
}

// Each operation has its own marker so simultaneous removals in different tabs
// cannot overwrite one another. These markers contain no task content.
export function cancelSyncTasks(queueStorageKey: string, ids: string[]) {
  if (!ids.length) return;
  try {
    if (typeof localStorage === 'undefined') throw new Error('Local storage is unavailable');
    for (const id of new Set(ids)) {
      localStorage.setItem(`${cancellationPrefix(queueStorageKey)}${encodeURIComponent(id)}`, '1');
    }
  } catch (error) {
    recordPersistenceFailure({ name: queueStorageKey, reason: 'write_failed', error });
    throw error;
  }
}

export function filterCancelledSyncTasks<T extends QueueEntry>(queueStorageKey: string, queue: T[]): T[] {
  if (typeof localStorage === 'undefined' || !queue.length) return queue;
  const prefix = cancellationPrefix(queueStorageKey);
  const filtered = queue.filter((entry) => localStorage.getItem(`${prefix}${encodeURIComponent(entry.id)}`) === null);
  return filtered.length === queue.length ? queue : filtered;
}

export function filterCancelledSyncTaskState(queueStorageKey: string, state: unknown, field: SyncTaskQueueField) {
  if (!state || typeof state !== 'object') return state;
  const record = state as Record<string, unknown>;
  const queue = record[field];
  if (!Array.isArray(queue) || !queue.every((entry): entry is QueueEntry => Boolean(entry && typeof entry.id === 'string'))) return state;
  const filtered = filterCancelledSyncTasks(queueStorageKey, queue);
  return filtered === queue ? state : { ...record, [field]: filtered };
}

export function bindSyncTaskCancellation<TState, TEntry extends QueueEntry>(
  store: StoreApi<TState>,
  options: {
    getStorageKey: () => string;
    getQueue: (state: TState) => TEntry[];
    applyQueue: (state: TState, queue: TEntry[]) => Partial<TState>;
  },
) {
  const prune = () => {
    const state = store.getState();
    const queue = options.getQueue(state);
    const filtered = filterCancelledSyncTasks(options.getStorageKey(), queue);
    if (filtered !== queue) store.setState(options.applyQueue(state, filtered));
  };
  const unsubscribe = store.subscribe(prune);
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(cancellationPrefix(options.getStorageKey()))) prune();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', prune);
    window.addEventListener('pageshow', prune);
  }
  return () => {
    unsubscribe();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', prune);
      window.removeEventListener('pageshow', prune);
    }
  };
}
