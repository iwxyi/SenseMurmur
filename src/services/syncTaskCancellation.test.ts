import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { bindSyncTaskCancellation, cancelSyncTasks, filterCancelledSyncTasks } from './syncTaskCancellation';
import { createScopedIndexedDbBufferedJsonStorage, flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { clearPersistenceFailures, readPersistenceHealth } from './persistenceHealth';

function createStorageMock() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

describe('sync task cancellation across tabs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', createStorageMock());
    vi.stubGlobal('indexedDB', undefined);
  });
  afterEach(() => {
    clearPersistenceFailures();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not let a stale tab reintroduce cleared tasks through delayed writes or hydration', async () => {
    type State = { pendingOperations: { id: string }[]; title: string };
    const storage = () => createScopedIndexedDbBufferedJsonStorage<State>({
      getScopedKey: () => 'chats-account-a', storageName: 'chats', syncTaskField: 'pendingOperations',
    });
    const tabA = storage();
    const tabB = storage();
    const old = { state: { pendingOperations: [{ id: 'week-old' }], title: 'Keep local content' } };
    tabA.setItem('chats', old);
    flushBufferedPersistenceWrites();
    await vi.advanceTimersByTimeAsync(0);
    expect(await tabB.getItem('chats')).toEqual(old);

    // Tab B captured its snapshot before tab A cleared the queue.
    tabB.setItem('chats', old);
    cancelSyncTasks('chats-account-a', ['week-old']);
    tabA.setItem('chats', { state: { ...old.state, pendingOperations: [] } });
    flushBufferedPersistenceWrites();
    await vi.advanceTimersByTimeAsync(0);
    expect(await storage().getItem('chats')).toEqual({ state: { ...old.state, pendingOperations: [] } });

    // Even an older application tab can still write an unfiltered snapshot.
    localStorage.setItem('chats-account-a', JSON.stringify(old));
    expect(await storage().getItem('chats')).toEqual({ state: { ...old.state, pendingOperations: [] } });
    expect(filterCancelledSyncTasks('chats-account-b', old.state.pendingOperations)).toEqual(old.state.pendingOperations);
  });

  it('prunes another tab on notification and rejects late callbacks that restore the old queue', () => {
    const windowEvents = new EventTarget();
    vi.stubGlobal('window', windowEvents);
    const old = [{ id: 'old' }];
    const tab = createStore(() => ({ pendingOperations: old, draft: 'Keep this' }));
    const unsubscribe = bindSyncTaskCancellation(tab, {
      getStorageKey: () => 'account-a', getQueue: (state) => state.pendingOperations,
      applyQueue: (_state, pendingOperations) => ({ pendingOperations }),
    });
    try {
      cancelSyncTasks('account-a', ['old']);
      windowEvents.dispatchEvent(Object.assign(new Event('storage'), { key: 'account-a:cancelled-task:old' }));
      expect(tab.getState()).toEqual({ pendingOperations: [], draft: 'Keep this' });
      tab.setState({ pendingOperations: [...old, { id: 'new' }] });
      expect(tab.getState().pendingOperations).toEqual([{ id: 'new' }]);
      cancelSyncTasks('account-a', ['new']);
      // Focus also checks the durable marker if storage notifications were missed.
      windowEvents.dispatchEvent(new Event('focus'));
      expect(tab.getState().pendingOperations).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('keeps simultaneous removals independent and surfaces persistence failures', () => {
    cancelSyncTasks('account-a', ['first']);
    cancelSyncTasks('account-a', ['second']);
    expect(filterCancelledSyncTasks('account-a', [{ id: 'first' }, { id: 'second' }, { id: 'new' }])).toEqual([{ id: 'new' }]);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage is full'); });
    expect(() => cancelSyncTasks('account-a', ['new'])).toThrow('Storage is full');
    expect(readPersistenceHealth().latestFailure?.reason).toBe('write_failed');
  });
});
