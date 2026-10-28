import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';
import { recordPersistenceFailure } from '../services/persistenceHealth';
import { isWorkspaceActive } from '../services/workspaceLifecycle';
import { filterCancelledSyncTaskState, type SyncTaskQueueField } from '../services/syncTaskCancellation';

interface ScopedStorageParams {
  getScopedKey: () => string;
  storageName: string;
  syncTaskField?: SyncTaskQueueField;
}

interface BufferedJsonStorageOptions {
  flushDelayMs?: number;
  replacer?: (key: string, value: unknown) => unknown;
  reviver?: (key: string, value: unknown) => unknown;
  resolveStorageTarget?: (name: string) => BufferedStorageTarget;
}

type BufferedFlushHandle = ReturnType<typeof globalThis.setTimeout> | number;

interface PendingBufferedWrite<T> {
  name: string;
  target: BufferedStorageTarget;
  value: StorageValue<T> | null;
  handle: BufferedFlushHandle | null;
}

interface BufferedStorageTarget {
  key: string;
  assertWritable?: () => void;
  canReadPending?: () => boolean;
  transformState?: (state: unknown) => unknown;
  getItem: () => string | Promise<string | null> | null;
  setItem: (value: string) => void | Promise<void> | unknown;
  removeItem: () => void | Promise<void> | unknown;
}

export interface IndexedDbStorageEntryDiagnostic {
  key: string;
  sizeBytes: number;
}

export interface IndexedDbStorageDiagnostics {
  available: boolean;
  databaseName: string;
  objectStoreName: string;
  totalBytes: number;
  entries: IndexedDbStorageEntryDiagnostic[];
  largest: IndexedDbStorageEntryDiagnostic[];
  error?: string;
}

export interface LocalStorageFallbackMigrationResult {
  migrated: number;
  removed: number;
  skipped: number;
  failed: number;
  errors: Array<{ key: string; message: string }>;
}

const bufferedFlushers = new Set<() => void>();
let bufferedLifecycleRegistered = false;
const INDEXED_DB_NAME = 'pneumata-local-store';
const INDEXED_DB_VERSION = 1;
const INDEXED_DB_OBJECT_STORE = 'kv';
// Transactions can legitimately queue behind another tab's snapshot write.
// These are stall watchdogs, not interactive response deadlines.
const INDEXED_DB_OPEN_TIMEOUT_MS = 15_000;
const INDEXED_DB_READ_TIMEOUT_MS = 15_000;
let indexedDbOpenPromise: Promise<IDBDatabase | null> | null = null;
let indexedDbLastOpenFailure: Error | null = null;
let indexedDbConnection: IDBDatabase | null = null;
const protectedIndexedDbKeys = new Set<string>();
const scopedIndexedDbReads = new Map<string, Promise<string | null>>();

function assertIndexedDbWritable(key: string) {
  if (!protectedIndexedDbKeys.has(key)) return;
  const error = new Error(`IndexedDB write blocked until storage is successfully read: ${key}`);
  recordPersistenceFailure({ name: key, reason: 'write_failed', error });
  throw error;
}

function readScopedIndexedDbItem(key: string) {
  const pending = scopedIndexedDbReads.get(key);
  if (pending) return pending;
  protectedIndexedDbKeys.add(key);
  const read = (async () => {
    try {
      const localValue = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
      const value = localValue ?? await readIndexedDbItem(key);
      protectedIndexedDbKeys.delete(key);
      return value;
    } catch (error) {
      recordPersistenceFailure({ name: key, reason: 'read_failed', error });
      console.warn('[storage] indexeddb read failed; writes blocked', { name: key, error });
      throw error;
    }
  })().finally(() => scopedIndexedDbReads.delete(key));
  scopedIndexedDbReads.set(key, read);
  return read;
}

function scheduleBufferedFlush(flush: () => void, delayMs: number) {
  const scheduler = (globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof scheduler === 'function') {
    return scheduler(flush, { timeout: delayMs });
  }
  return globalThis.setTimeout(flush, delayMs);
}

function cancelBufferedFlush(handle: BufferedFlushHandle | null) {
  if (handle == null) return;
  const canceller = (globalThis as typeof globalThis & {
    cancelIdleCallback?: (id: number) => void;
  }).cancelIdleCallback;
  if (typeof canceller === 'function' && typeof handle === 'number') {
    canceller(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}

function ensureBufferedStorageLifecycle() {
  if (bufferedLifecycleRegistered || typeof window === 'undefined') return;
  const flushAll = () => {
    for (const flush of bufferedFlushers) flush();
  };
  window.addEventListener('pagehide', flushAll);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAll();
    });
  }
  bufferedLifecycleRegistered = true;
}

export function flushBufferedPersistenceWrites() {
  for (const flush of bufferedFlushers) flush();
}

function parsePersistedValue<T>(raw: string | null, reviver?: BufferedJsonStorageOptions['reviver']) {
  if (raw == null) return null;
  return JSON.parse(raw, reviver) as StorageValue<T>;
}

function textSizeBytes(value: string) {
  if (typeof Blob !== 'undefined') return new Blob([value]).size;
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
}

function openIndexedDb() {
  if (typeof indexedDB === 'undefined') {
    indexedDbOpenPromise = null;
    indexedDbLastOpenFailure = null;
    return Promise.resolve(null);
  }
  if (indexedDbOpenPromise) return indexedDbOpenPromise;
  indexedDbOpenPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutHandle);
      indexedDbConnection = database;
      resolve(database);
    };
    const timeoutHandle = globalThis.setTimeout(() => {
      console.warn('[storage] indexeddb open timed out');
      indexedDbLastOpenFailure = new Error('IndexedDB open timed out');
      finish(null);
    }, INDEXED_DB_OPEN_TIMEOUT_MS);
    const request = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INDEXED_DB_OBJECT_STORE)) {
        database.createObjectStore(INDEXED_DB_OBJECT_STORE);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      const database = request.result;
      database.onversionchange = () => {
        if (indexedDbConnection === database) resetIndexedDbConnection();
        else database.close();
      };
      database.onclose = () => {
        if (indexedDbConnection === database) resetIndexedDbConnection();
      };
      indexedDbLastOpenFailure = null;
      finish(database);
    };
    request.onerror = () => {
      console.warn('[storage] indexeddb open failed', request.error);
      indexedDbLastOpenFailure = request.error || new Error('IndexedDB open failed');
      finish(null);
    };
    request.onblocked = () => {
      console.warn('[storage] indexeddb open blocked');
    };
  });
  return indexedDbOpenPromise;
}

function resetIndexedDbConnection() {
  const database = indexedDbConnection;
  indexedDbConnection = null;
  indexedDbOpenPromise = null;
  indexedDbLastOpenFailure = null;
  try {
    database?.close();
  } catch {
    // The connection may already be closed by the browser.
  }
}

function shouldRetryIndexedDbRead(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|database is closed|transaction is inactive|invalidstateerror/i.test(message);
}

async function readIndexedDbItemOnce(key: string, connection: Promise<IDBDatabase | null>) {
  const database = await connection;
  if (!database && indexedDbLastOpenFailure) throw indexedDbLastOpenFailure;
  if (!database) return null;
  return new Promise<string | null>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutHandle);
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutHandle);
      reject(error);
    };
    const transaction = database.transaction(INDEXED_DB_OBJECT_STORE, 'readonly');
    const timeoutHandle = globalThis.setTimeout(() => {
      fail(Object.assign(new Error(`IndexedDB read timed out for ${key}`), {
        key, stage: 'read', timeoutMs: INDEXED_DB_READ_TIMEOUT_MS, elapsedMs: Date.now() - startedAt,
      }));
      try {
        transaction.abort();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
          console.warn('[storage] timed-out read abort failed', { key, error });
        }
      }
    }, INDEXED_DB_READ_TIMEOUT_MS);
    const request = transaction.objectStore(INDEXED_DB_OBJECT_STORE).get(key);
    request.onsuccess = () => finish(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => fail(request.error || new Error('IndexedDB read failed'));
    transaction.onabort = () => fail(transaction.error || new Error('IndexedDB read transaction aborted'));
  });
}

async function readIndexedDbItem(key: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const connection = openIndexedDb();
    try {
      return await readIndexedDbItemOnce(key, connection);
    } catch (error) {
      lastError = error;
      const retryable = shouldRetryIndexedDbRead(error);
      // A different reader may already have replaced the stalled connection.
      if (retryable && indexedDbOpenPromise === connection) resetIndexedDbConnection();
      if (!retryable || attempt === 1) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`IndexedDB read failed for ${key}`);
}

export async function readIndexedDbStorageEntryValue(key: string) {
  return readIndexedDbItem(key);
}

async function writeIndexedDbItem(key: string, value: string) {
  const database = await openIndexedDb();
  if (!database) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
    return 'localStorage' as const;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(INDEXED_DB_OBJECT_STORE, 'readwrite');
    const request = transaction.objectStore(INDEXED_DB_OBJECT_STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write transaction aborted'));
    request.onerror = () => reject(request.error || new Error('IndexedDB write failed'));
  });
  return 'indexedDb' as const;
}

async function removeIndexedDbItem(key: string) {
  const database = await openIndexedDb();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(INDEXED_DB_OBJECT_STORE, 'readwrite');
    const request = transaction.objectStore(INDEXED_DB_OBJECT_STORE).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB remove transaction aborted'));
    request.onerror = () => reject(request.error || new Error('IndexedDB remove failed'));
  });
}

export async function readIndexedDbStorageDiagnostics(limit = 20): Promise<IndexedDbStorageDiagnostics> {
  const unavailable = {
    available: false,
    databaseName: INDEXED_DB_NAME,
    objectStoreName: INDEXED_DB_OBJECT_STORE,
    totalBytes: 0,
    entries: [],
    largest: [],
  };
  try {
    const database = await openIndexedDb();
    if (!database) return unavailable;
    const entries = await new Promise<IndexedDbStorageEntryDiagnostic[]>((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_OBJECT_STORE, 'readonly');
      const store = transaction.objectStore(INDEXED_DB_OBJECT_STORE);
      const request = store.openCursor();
      const result: IndexedDbStorageEntryDiagnostic[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(result);
          return;
        }
        const key = String(cursor.key);
        const value = typeof cursor.value === 'string' ? cursor.value : JSON.stringify(cursor.value ?? null);
        result.push({ key, sizeBytes: textSizeBytes(value) });
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB diagnostics failed'));
    });
    const sortedEntries = entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return {
      available: true,
      databaseName: INDEXED_DB_NAME,
      objectStoreName: INDEXED_DB_OBJECT_STORE,
      totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      entries,
      largest: sortedEntries.slice(0, limit),
    };
  } catch (error) {
    return {
      ...unavailable,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function migrateLocalStorageFallbacksToIndexedDb(keys: string[]): Promise<LocalStorageFallbackMigrationResult> {
  const result: LocalStorageFallbackMigrationResult = {
    migrated: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  if (typeof localStorage === 'undefined') return result;

  for (const key of Array.from(new Set(keys.filter(Boolean)))) {
    const localValue = localStorage.getItem(key);
    if (localValue == null) {
      result.skipped += 1;
      continue;
    }
    try {
      const indexedValue = await readIndexedDbItem(key);
      if (indexedValue != null) {
        localStorage.removeItem(key);
        result.removed += 1;
        continue;
      }
      const storageBackend = await writeIndexedDbItem(key, localValue);
      if (storageBackend === 'indexedDb') {
        localStorage.removeItem(key);
        result.migrated += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.errors.push({ key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function createScopedStorage(params: ScopedStorageParams): StateStorage {
  return {
    getItem: (name: string) => {
      if (typeof localStorage === 'undefined') return null;
      const scopedName = params.getScopedKey();
      const storageName = params.storageName;
      if (name !== storageName) return localStorage.getItem(name);
      return localStorage.getItem(scopedName);
    },
    setItem: (name: string, value: string) => {
      if (!isWorkspaceActive()) return;
      if (typeof localStorage === 'undefined') return;
      const scopedName = params.getScopedKey();
      const storageName = params.storageName;
      if (name !== storageName) {
        localStorage.setItem(name, value);
        return;
      }
      localStorage.setItem(scopedName, value);
    },
    removeItem: (name: string) => {
      if (!isWorkspaceActive()) return;
      if (typeof localStorage === 'undefined') return;
      const scopedName = params.getScopedKey();
      const storageName = params.storageName;
      if (name !== storageName) {
        localStorage.removeItem(name);
        return;
      }
      localStorage.removeItem(scopedName);
    },
  };
}

export function createScopedIndexedDbStorage(params: ScopedStorageParams): StateStorage {
  return {
    getItem: async (name: string) => {
      const scopedName = params.getScopedKey();
      const storageName = params.storageName;
      if (name !== storageName) {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(name);
      }
      return readScopedIndexedDbItem(scopedName);
    },
    setItem: async (name: string, value: string) => {
      if (!isWorkspaceActive()) return;
      const scopedName = params.getScopedKey();
      const storageName = params.storageName;
      if (name !== storageName) {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(name, value);
        return;
      }
      assertIndexedDbWritable(scopedName);
      const storageBackend = await writeIndexedDbItem(scopedName, value);
      if (storageBackend === 'indexedDb' && typeof localStorage !== 'undefined') localStorage.removeItem(scopedName);
    },
    removeItem: async (name: string) => {
      if (!isWorkspaceActive()) return;
      const scopedName = params.getScopedKey();
      const storageName = params.storageName;
      if (name !== storageName) {
        if (typeof localStorage === 'undefined') return;
        localStorage.removeItem(name);
        return;
      }
      assertIndexedDbWritable(scopedName);
      await removeIndexedDbItem(scopedName);
      if (typeof localStorage !== 'undefined') localStorage.removeItem(scopedName);
    },
  };
}

export function createBufferedJsonStorage<T>(
  storage: StateStorage,
  options: BufferedJsonStorageOptions = {},
): PersistStorage<T, void> {
  const pendingWrites = new Map<string, PendingBufferedWrite<T>>();
  const inFlightWrites = new Map<string, PendingBufferedWrite<T>>();
  const flushDelayMs = options.flushDelayMs ?? 96;

  const resolveStorageTarget = (name: string): BufferedStorageTarget => {
    if (options.resolveStorageTarget) return options.resolveStorageTarget(name);
    return {
      key: name,
      getItem: () => storage.getItem(name),
      setItem: (value) => storage.setItem(name, value),
      removeItem: () => storage.removeItem(name),
    };
  };

  const flushKey = (key: string) => {
    // A busy database must not retain an unbounded queue of serialized snapshots.
    if (inFlightWrites.has(key)) return;
    const pending = pendingWrites.get(key);
    if (!pending) return;
    pendingWrites.delete(key);
    cancelBufferedFlush(pending.handle);
    let serializedValue = '';
    try {
      if (pending.value != null) serializedValue = JSON.stringify(prepareValue(pending.target, pending.value), options.replacer);
      const setResult = pending.value == null
        ? pending.target.removeItem()
        : pending.target.setItem(serializedValue);
      if (setResult instanceof Promise) {
        inFlightWrites.set(key, pending);
        setResult.catch((error) => {
          recordPersistenceFailure({ name: pending.name, reason: 'write_failed', error, serializedValue });
          console.warn('[storage] persistence async write failed', { name: pending.name, error });
        }).finally(() => {
          inFlightWrites.delete(key);
          try {
            flushKey(key);
          } catch (error) {
            // flushKey records synchronous failures; surface the continuation failure
            // without leaving an unobserved rejected promise after an async write.
            console.warn('[storage] persistence pending flush failed', { name: pending.name, error });
          }
        });
      }
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : '';
      if (errorName === 'QuotaExceededError' || errorName === 'NS_ERROR_DOM_QUOTA_REACHED') {
        recordPersistenceFailure({ name: pending.name, reason: 'quota_exceeded', error, serializedValue });
        console.warn('[storage] persistence skipped: storage quota exceeded', { name: pending.name, error });
        return;
      }
      recordPersistenceFailure({ name: pending.name, reason: 'write_failed', error, serializedValue });
      throw error;
    }
  };

  const flushAll = () => {
    for (const key of Array.from(pendingWrites.keys())) {
      flushKey(key);
    }
  };

  ensureBufferedStorageLifecycle();
  bufferedFlushers.add(flushAll);

  function prepareValue(target: BufferedStorageTarget, value: StorageValue<T> | null) {
    return value && target.transformState
      ? { ...value, state: target.transformState(value.state) as T }
      : value;
  }

  return {
    getItem: (name: string) => {
      const target = resolveStorageTarget(name);
      // A dispatched write remains the latest snapshot until its transaction commits.
      const pending = pendingWrites.get(target.key) ?? inFlightWrites.get(target.key);
      if (pending && (target.canReadPending?.() ?? true)) return prepareValue(target, pending.value);
      const raw = target.getItem();
      if (raw instanceof Promise) {
        return raw.then((value) => prepareValue(target, parsePersistedValue<T>(value, options.reviver)));
      }
      return prepareValue(target, parsePersistedValue<T>(raw, options.reviver));
    },
    setItem: (name: string, value: StorageValue<T>) => {
      if (!isWorkspaceActive()) return;
      const target = resolveStorageTarget(name);
      target.assertWritable?.();
      const key = target.key;
      const pending = pendingWrites.get(key);
      pendingWrites.set(key, {
        name,
        target,
        value,
        handle: pending?.handle ?? scheduleBufferedFlush(() => flushKey(key), flushDelayMs),
      });
    },
    removeItem: (name: string) => {
      if (!isWorkspaceActive()) return;
      const target = resolveStorageTarget(name);
      target.assertWritable?.();
      const key = target.key;
      const pending = pendingWrites.get(key);
      pendingWrites.set(key, {
        name,
        target,
        value: null,
        handle: pending?.handle ?? scheduleBufferedFlush(() => flushKey(key), flushDelayMs),
      });
    },
  };
}

export function createScopedBufferedJsonStorage<T>(
  params: ScopedStorageParams & { flushDelayMs?: number },
): PersistStorage<T, void> {
  return createBufferedJsonStorage<T>(createScopedStorage(params), {
    flushDelayMs: params.flushDelayMs,
    resolveStorageTarget: (name) => {
      const targetName = name === params.storageName ? params.getScopedKey() : name;
      return {
        key: targetName,
        getItem: () => (typeof localStorage === 'undefined' ? null : localStorage.getItem(targetName)),
        setItem: (value) => {
          if (typeof localStorage !== 'undefined') localStorage.setItem(targetName, value);
        },
        removeItem: () => {
          if (typeof localStorage !== 'undefined') localStorage.removeItem(targetName);
        },
      };
    },
  });
}

export function createScopedIndexedDbBufferedJsonStorage<T>(
  params: ScopedStorageParams & { flushDelayMs?: number },
): PersistStorage<T, void> {
  return createBufferedJsonStorage<T>(createScopedIndexedDbStorage(params), {
    flushDelayMs: params.flushDelayMs,
    resolveStorageTarget: (name) => {
      if (name !== params.storageName) {
        return {
          key: name,
          getItem: () => (typeof localStorage === 'undefined' ? null : localStorage.getItem(name)),
          setItem: (value) => {
            if (typeof localStorage !== 'undefined') localStorage.setItem(name, value);
          },
          removeItem: () => {
            if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
          },
        };
      }
      const scopedName = params.getScopedKey();
      return {
        key: scopedName,
        transformState: params.syncTaskField
          ? (state) => filterCancelledSyncTaskState(scopedName, state, params.syncTaskField!)
          : undefined,
        assertWritable: () => assertIndexedDbWritable(scopedName),
        canReadPending: () => !protectedIndexedDbKeys.has(scopedName),
        getItem: () => readScopedIndexedDbItem(scopedName),
        setItem: async (value) => {
          assertIndexedDbWritable(scopedName);
          const storageBackend = await writeIndexedDbItem(scopedName, value);
          if (storageBackend === 'indexedDb' && typeof localStorage !== 'undefined') localStorage.removeItem(scopedName);
        },
        removeItem: async () => {
          assertIndexedDbWritable(scopedName);
          await removeIndexedDbItem(scopedName);
          if (typeof localStorage !== 'undefined') localStorage.removeItem(scopedName);
        },
      };
    },
  });
}
