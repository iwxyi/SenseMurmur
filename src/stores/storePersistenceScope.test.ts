import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { persist } from 'zustand/middleware';
import {
  createBufferedJsonStorage,
  createScopedBufferedJsonStorage,
  createScopedIndexedDbBufferedJsonStorage,
  createScopedIndexedDbStorage,
  flushBufferedPersistenceWrites,
  migrateLocalStorageFallbacksToIndexedDb,
  readIndexedDbStorageDiagnostics,
} from './storePersistenceScope';
import { clearPersistenceFailures, readPersistenceHealth } from '../services/persistenceHealth';

function createStorageMock() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe('storePersistenceScope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearPersistenceFailures();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('coalesces repeated buffered writes and flushes only the latest snapshot', () => {
    const rawStorage = createStorageMock();
    const storage = createBufferedJsonStorage<{ value: number }>(rawStorage, { flushDelayMs: 20 });

    storage.setItem('scope-key', { state: { value: 1 }, version: 2 });
    storage.setItem('scope-key', { state: { value: 2 }, version: 2 });

    expect(rawStorage.getItem('scope-key')).toBeNull();
    expect(storage.getItem('scope-key')).toEqual({ state: { value: 2 }, version: 2 });

    vi.advanceTimersByTime(20);

    expect(rawStorage.getItem('scope-key')).toBe(JSON.stringify({ state: { value: 2 }, version: 2 }));
  });

  it('bounds slow async writes and persists the newest snapshot after commit', async () => {
    const commits: Array<() => void> = [];
    const saved: string[] = [];
    const raw = {
      getItem: () => null,
      setItem: vi.fn((_name: string, value: string) => new Promise<void>((resolve) => {
        commits.push(() => { saved.push(value); resolve(); });
      })),
      removeItem: vi.fn(),
    };
    const storage = createBufferedJsonStorage<{ value: number }>(raw, { flushDelayMs: 20 });
    storage.setItem('slow', { state: { value: 0 } });
    await vi.advanceTimersByTimeAsync(20);
    for (let value = 1; value <= 100; value += 1) {
      storage.setItem('slow', { state: { value } });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(raw.setItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem('slow')).toEqual({ state: { value: 100 } });
    commits.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(raw.setItem).toHaveBeenCalledTimes(2);
    commits.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.map((value) => JSON.parse(value).state.value)).toEqual([0, 100]);
  });

  it('preserves a newer delete while an async snapshot is being written', async () => {
    let commit!: () => void;
    const raw = { getItem: () => null, setItem: vi.fn(() => new Promise<void>((resolve) => { commit = resolve; })), removeItem: vi.fn() };
    const storage = createBufferedJsonStorage<{ value: number }>(raw, { flushDelayMs: 20 });
    storage.setItem('delete-after-write', { state: { value: 1 } });
    await vi.advanceTimersByTimeAsync(20);
    storage.removeItem('delete-after-write');
    await vi.advanceTimersByTimeAsync(20);
    expect(raw.removeItem).not.toHaveBeenCalled();
    commit();
    await vi.advanceTimersByTimeAsync(0);
    expect(raw.removeItem).toHaveBeenCalledWith('delete-after-write');
  });

  it('reports a failed async write and still persists a newer pending snapshot', async () => {
    let rejectWrite!: (error: Error) => void;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = { getItem: () => null, removeItem: vi.fn(), setItem: vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectWrite = reject; }))
      .mockResolvedValue(undefined) };
    const storage = createBufferedJsonStorage<{ value: number }>(raw, { flushDelayMs: 20 });
    storage.setItem('failed-write', { state: { value: 1 } });
    await vi.advanceTimersByTimeAsync(20);
    storage.setItem('failed-write', { state: { value: 2 } });
    rejectWrite(new Error('transaction aborted'));
    await vi.advanceTimersByTimeAsync(0);
    expect(readPersistenceHealth().latestFailure).toMatchObject({ name: 'failed-write', reason: 'write_failed' });
    expect(raw.setItem).toHaveBeenLastCalledWith('failed-write', JSON.stringify({ state: { value: 2 } }));
    warnSpy.mockRestore();
  });

  it('waits for transaction commit and rejects a write aborted after request success', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createStorageMock());
    const request = {} as IDBRequest;
    const transaction = { objectStore: () => ({ put: () => request }) } as unknown as IDBTransaction;
    const database = { transaction: () => transaction, close: vi.fn() };
    vi.stubGlobal('indexedDB', { open: () => {
      const open = {} as IDBOpenDBRequest;
      Object.defineProperty(open, 'result', { value: database });
      queueMicrotask(() => open.onsuccess?.(new Event('success')));
      return open;
    } });
    const { createScopedIndexedDbStorage: createStorage } = await import('./storePersistenceScope');
    const storage = createStorage({ storageName: 'durable', getScopedKey: () => 'durable' });
    let completed = false;
    const write = Promise.resolve(storage.setItem('durable', 'snapshot')).then(() => { completed = true; });
    const rejected = expect(write).rejects.toThrow('transaction aborted');
    await vi.advanceTimersByTimeAsync(0);
    request.onsuccess?.(new Event('success'));
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    transaction.onabort?.call(transaction, new Event('abort'));
    await rejected;
    const nextWrite = Promise.resolve(storage.setItem('durable', 'next')).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    transaction.oncomplete?.call(transaction, new Event('complete'));
    await nextWrite;
    expect(completed).toBe(true);
  });

  it('accepts a healthy read queued beyond the old 1.2 second deadline', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createStorageMock());
    const { createScopedIndexedDbStorage: createStorage } = await import('./storePersistenceScope');
    const delayedGet = vi.fn(() => {
      const request = {} as IDBRequest<string>;
      setTimeout(() => {
        Object.defineProperty(request, 'result', { value: 'original' });
        request.onsuccess?.(new Event('success'));
      }, 2500);
      return request;
    });
    const database = { close: vi.fn(), transaction: () => ({ objectStore: () => ({ get: delayedGet }), abort: vi.fn() }) };
    vi.stubGlobal('indexedDB', { open: () => {
      const request = {} as IDBOpenDBRequest;
      Object.defineProperty(request, 'result', { value: database });
      queueMicrotask(() => request.onsuccess?.(new Event('success')));
      return request;
    } });
    const storage = createStorage({ getScopedKey: () => 'slow-read', storageName: 'slow-read' });
    const result = storage.getItem('slow-read');
    await vi.advanceTimersByTimeAsync(2500);
    await expect(result).resolves.toBe('original');
    database.close();
  });

  it('aborts timed-out transactions before retrying and releases obsolete connections', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createStorageMock());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const abort = vi.fn();
    const database = { close: vi.fn(), transaction: () => ({ objectStore: () => ({ get: () => ({}) }), abort }) };
    const open = vi.fn(() => {
      const request = {} as IDBOpenDBRequest;
      Object.defineProperty(request, 'result', { value: database });
      queueMicrotask(() => request.onsuccess?.(new Event('success')));
      return request;
    });
    vi.stubGlobal('indexedDB', { open });
    const { createScopedIndexedDbStorage: createStorage } = await import('./storePersistenceScope');
    const storage = createStorage({ storageName: 'stalled', getScopedKey: () => 'stalled' });
    const read = storage.getItem('stalled');
    const rejected = expect(read).rejects.toThrow('IndexedDB read timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(abort).toHaveBeenCalledTimes(2);
    expect(database.close).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(2);
    await expect(storage.setItem('stalled', 'unsafe')).rejects.toThrow('write blocked');
    warnSpy.mockRestore();
  });

  it('flushes buffered persistence immediately for manual retry', () => {
    const rawStorage = createStorageMock();
    const storage = createBufferedJsonStorage<{ value: number }>(rawStorage, { flushDelayMs: 10_000 });

    storage.setItem('retry-scope', { state: { value: 7 }, version: 2 });
    expect(rawStorage.getItem('retry-scope')).toBeNull();

    flushBufferedPersistenceWrites();

    expect(rawStorage.getItem('retry-scope')).toBe(JSON.stringify({ state: { value: 7 }, version: 2 }));
  });

  it('isolates buffered writes by scoped storage key while accounts switch', () => {
    const rawStorage = createStorageMock();
    vi.stubGlobal('localStorage', rawStorage);
    let currentScope = 'scoped-chats-user-a';
    const storage = createScopedBufferedJsonStorage<{ value: string }>({
      getScopedKey: () => currentScope,
      storageName: 'scoped-chats',
      flushDelayMs: 10_000,
    });

    storage.setItem('scoped-chats', { state: { value: 'user-a' }, version: 2 });
    currentScope = 'scoped-chats-user-b';
    storage.setItem('scoped-chats', { state: { value: 'user-b' }, version: 2 });

    expect(storage.getItem('scoped-chats')).toEqual({ state: { value: 'user-b' }, version: 2 });
    currentScope = 'scoped-chats-user-a';
    expect(storage.getItem('scoped-chats')).toEqual({ state: { value: 'user-a' }, version: 2 });

    flushBufferedPersistenceWrites();

    expect(rawStorage.getItem('scoped-chats-user-a')).toBe(JSON.stringify({ state: { value: 'user-a' }, version: 2 }));
    expect(rawStorage.getItem('scoped-chats-user-b')).toBe(JSON.stringify({ state: { value: 'user-b' }, version: 2 }));
  });

  it('records quota failures instead of hiding local persistence loss', () => {
    const rawStorage = createStorageMock();
    rawStorage.setItem = vi.fn(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = createBufferedJsonStorage<{ value: string }>(rawStorage, { flushDelayMs: 20 });

    storage.setItem('large-scope', { state: { value: 'x'.repeat(256) }, version: 2 });
    vi.advanceTimersByTime(20);

    const health = readPersistenceHealth();
    expect(health.latestFailure).toMatchObject({
      name: 'large-scope',
      reason: 'quota_exceeded',
    });
    expect(health.latestFailure?.sizeBytes).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it('keeps localStorage fallback when IndexedDB is unavailable', async () => {
    const rawStorage = createStorageMock();
    vi.stubGlobal('localStorage', rawStorage);
    vi.stubGlobal('indexedDB', undefined);
    rawStorage.setItem('scoped-messages-user-1', 'legacy-cache');
    const storage = createScopedIndexedDbStorage({
      getScopedKey: () => 'scoped-messages-user-1',
      storageName: 'scoped-messages',
    });

    await expect(storage.getItem('scoped-messages')).resolves.toBe('legacy-cache');
    await storage.setItem('scoped-messages', 'next-cache');

    expect(rawStorage.getItem('scoped-messages-user-1')).toBe('next-cache');
  });

  it('prefers localStorage fallback for buffered IndexedDB storage hydration', async () => {
    const rawStorage = createStorageMock();
    vi.stubGlobal('localStorage', rawStorage);
    const indexedOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: indexedOpen });
    rawStorage.setItem('scoped-chats-user-1', JSON.stringify({ state: { value: 'local' }, version: 5 }));
    const storage = createScopedIndexedDbBufferedJsonStorage<{ value: string }>({
      getScopedKey: () => 'scoped-chats-user-1',
      storageName: 'scoped-chats',
    });

    await expect(storage.getItem('scoped-chats')).resolves.toEqual({ state: { value: 'local' }, version: 5 });
    expect(indexedOpen).not.toHaveBeenCalled();
  });

  it('times out blocked IndexedDB reads so store hydration cannot hang forever', async () => {
    const rawStorage = createStorageMock();
    vi.stubGlobal('localStorage', rawStorage);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('indexedDB', {
      open: vi.fn(() => ({})),
    });
    const storage = createScopedIndexedDbBufferedJsonStorage<{ value: string }>({
      getScopedKey: () => 'blocked-chats-user-1',
      storageName: 'blocked-chats',
    });

    const resultPromise = storage.getItem('blocked-chats');
    const rejected = expect(resultPromise).rejects.toThrow('IndexedDB open timed out');
    await vi.advanceTimersByTimeAsync(30_000);

    await rejected;
    expect(readPersistenceHealth().latestFailure).toMatchObject({
      name: 'blocked-chats-user-1',
      reason: 'read_failed',
    });
    warnSpy.mockRestore();
  });

  it.each(['direct', 'buffered'] as const)('protects %s storage after a failed read until a successful reread', async (kind) => {
    const rawStorage = createStorageMock();
    vi.stubGlobal('localStorage', rawStorage);
    vi.stubGlobal('indexedDB', { open: vi.fn(() => ({})) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const key = `protected-${kind}`;
    const params = { getScopedKey: () => key, storageName: key };
    const storage = kind === 'direct' ? createScopedIndexedDbStorage(params)
      : createScopedIndexedDbBufferedJsonStorage<{ value: string }>(params);
    const write = () => kind === 'direct'
      ? (storage as ReturnType<typeof createScopedIndexedDbStorage>).setItem(key, 'replacement')
      : (storage as ReturnType<typeof createScopedIndexedDbBufferedJsonStorage<{ value: string }>>).setItem(key, { state: { value: 'replacement' } });
    const read = storage.getItem(key);
    const rejected = expect(read).rejects.toThrow('IndexedDB open timed out');
    if (kind === 'direct') await expect(write()).rejects.toThrow('write blocked');
    else expect(write).toThrow('write blocked');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    if (kind === 'direct') {
      await expect(write()).rejects.toThrow('write blocked');
      await expect(storage.removeItem(key)).rejects.toThrow('write blocked');
    } else {
      expect(write).toThrow('write blocked');
      expect(() => storage.removeItem(key)).toThrow('write blocked');
    }
    const saved = JSON.stringify({ state: { value: 'original' }, version: 1 });
    rawStorage.setItem(key, saved);
    await expect(storage.getItem(key)).resolves.toEqual(kind === 'direct' ? saved : JSON.parse(saved));
    expect(rawStorage.getItem(key)).toBe(saved);
    vi.stubGlobal('indexedDB', undefined);
    await write();
    flushBufferedPersistenceWrites();
    await vi.advanceTimersByTimeAsync(0);
    expect(rawStorage.getItem(key)).not.toBe(saved);
    warnSpy.mockRestore();
  });

  it('keeps failed hydration retryable and restores the saved snapshot on retry', async () => {
    const rawStorage = createStorageMock();
    vi.stubGlobal('localStorage', rawStorage);
    vi.stubGlobal('indexedDB', { open: vi.fn(() => ({})) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const key = 'hydrate-failure-retry';
    const onHydrated = vi.fn();
    const store = createStore(persist(() => ({ value: 'empty' }), {
      name: key, skipHydration: true,
      storage: createScopedIndexedDbBufferedJsonStorage<{ value: string }>({ getScopedKey: () => key, storageName: key }),
      onRehydrateStorage: () => onHydrated,
    }));
    const hydration = store.persist.rehydrate();
    await vi.advanceTimersByTimeAsync(30_000);
    await hydration;
    expect(store.persist.hasHydrated()).toBe(false);
    expect(onHydrated).toHaveBeenCalledWith(undefined, expect.any(Error));
    expect(() => store.setState({ value: 'unsafe replacement' })).toThrow('write blocked');
    rawStorage.setItem(key, JSON.stringify({ state: { value: 'saved history' }, version: 0 }));
    await store.persist.rehydrate();
    expect(store.persist.hasHydrated()).toBe(true);
    expect(store.getState().value).toBe('saved history');
    expect(JSON.parse(rawStorage.getItem(key)!).state.value).toBe('saved history');
    warnSpy.mockRestore();
  });

  it('shares the reopened connection when concurrent stale reads time out', async () => {
    const rawStorage = createStorageMock();
    vi.stubGlobal('localStorage', rawStorage);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let openCount = 0;
    let readCount = 0;
    const database = {
      close: vi.fn(),
      transaction: () => ({
        abort: vi.fn(),
        objectStore: () => ({
          get: () => {
            const request = {} as IDBRequest<string>;
            readCount += 1;
            if (readCount > 2) {
              queueMicrotask(() => {
                Object.defineProperty(request, 'result', { value: JSON.stringify({ state: 'retried-value', version: 5 }) });
                request.onsuccess?.(new Event('success'));
              });
            }
            return request;
          },
        }),
      }),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: vi.fn(() => {
        openCount += 1;
        const request = {} as IDBOpenDBRequest;
        Object.defineProperty(request, 'result', { value: database });
        queueMicrotask(() => request.onsuccess?.(new Event('success')));
        return request;
      }),
    });
    const storage = createScopedIndexedDbBufferedJsonStorage<string>({
      getScopedKey: () => 'retry-messages-user-1',
      storageName: 'retry-messages',
    });

    const otherStorage = createScopedIndexedDbStorage({
      getScopedKey: () => 'retry-characters-user-1',
      storageName: 'retry-characters',
    });
    const resultPromise = storage.getItem('retry-messages');
    const otherResultPromise = otherStorage.getItem('retry-characters');
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).resolves.toEqual({ state: 'retried-value', version: 5 });
    await expect(otherResultPromise).resolves.toBe(JSON.stringify({ state: 'retried-value', version: 5 }));
    expect(openCount).toBe(2);
    expect(database.close).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('returns explicit IndexedDB diagnostics when storage is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(readIndexedDbStorageDiagnostics()).resolves.toMatchObject({
      available: false,
      databaseName: 'pneumata-local-store',
      objectStoreName: 'kv',
      totalBytes: 0,
      largest: [],
    });
  });

  it('does not remove localStorage fallback when IndexedDB migration cannot run', async () => {
    const rawStorage = createStorageMock();
    vi.stubGlobal('localStorage', rawStorage);
    vi.stubGlobal('indexedDB', undefined);
    rawStorage.setItem('scoped-chats-user-1', 'legacy-cache');

    await expect(migrateLocalStorageFallbacksToIndexedDb(['scoped-chats-user-1'])).resolves.toMatchObject({
      migrated: 0,
      removed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(rawStorage.getItem('scoped-chats-user-1')).toBe('legacy-cache');
  });
});
