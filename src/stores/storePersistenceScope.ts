import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';
import { recordPersistenceFailure } from '../services/persistenceHealth';
import { isWorkspaceActive } from '../services/workspaceLifecycle';

interface ScopedStorageParams {
  getScopedKey: () => string;
  storageName: string;
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
const INDEXED_DB_OPEN_TIMEOUT_MS = 1200;
const INDEXED_DB_READ_TIMEOUT_MS = 1200;
let indexedDbOpenPromise: Promise<IDBDatabase | null> | null = null;
let indexedDbLastOpenFailure: Error | null = null;
let indexedDbConnection: IDBDatabase | null = null;

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
    request.onsuccess = () => finish(request.result);
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

async function readIndexedDbItemOnce(key: string) {
  const database = await openIndexedDb();
  if (!database && indexedDbLastOpenFailure) throw indexedDbLastOpenFailure;
  if (!database) return null;
  return new Promise<string | null>((resolve, reject) => {
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
    const timeoutHandle = globalThis.setTimeout(() => {
      fail(new Error(`IndexedDB read timed out for ${key}`));
    }, INDEXED_DB_READ_TIMEOUT_MS);
    const transaction = database.transaction(INDEXED_DB_OBJECT_STORE, 'readonly');
    const request = transaction.objectStore(INDEXED_DB_OBJECT_STORE).get(key);
    request.onsuccess = () => finish(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => fail(request.error || new Error('IndexedDB read failed'));
  });
}

async function readIndexedDbItem(key: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readIndexedDbItemOnce(key);
    } catch (error) {
      lastError = error;
      const retryable = shouldRetryIndexedDbRead(error);
      if (retryable) resetIndexedDbConnection();
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
    request.onsuccess = () => resolve();
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
    request.onsuccess = () => resolve();
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
      const localValue = typeof localStorage === 'undefined' ? null : localStorage.getItem(scopedName);
      if (localValue != null) return localValue;
      try {
        const indexedValue = await readIndexedDbItem(scopedName);
        if (indexedValue != null) return indexedValue;
      } catch (error) {
        recordPersistenceFailure({ name: scopedName, reason: 'read_failed', error });
        console.warn('[storage] indexeddb read failed', { name: scopedName, error });
      }
      return null;
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
    const pending = pendingWrites.get(key);
    if (!pending) return;
    pendingWrites.delete(key);
    cancelBufferedFlush(pending.handle);
    if (pending.value == null) {
      const removeResult = pending.target.removeItem();
      if (removeResult instanceof Promise) {
        removeResult.catch((error) => {
          recordPersistenceFailure({ name: pending.name, reason: 'write_failed', error });
          console.warn('[storage] persistence remove failed', { name: pending.name, error });
        });
      }
      return;
    }
    let serializedValue = '';
    try {
      serializedValue = JSON.stringify(pending.value, options.replacer);
      const setResult = pending.target.setItem(serializedValue);
      if (setResult instanceof Promise) {
        setResult.catch((error) => {
          recordPersistenceFailure({ name: pending.name, reason: 'write_failed', error, serializedValue });
          console.warn('[storage] persistence async write failed', { name: pending.name, error });
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

  return {
    getItem: (name: string) => {
      const target = resolveStorageTarget(name);
      const pending = pendingWrites.get(target.key);
      if (pending) return pending.value;
      const raw = target.getItem();
      if (raw instanceof Promise) {
        return raw.then((value) => parsePersistedValue<T>(value, options.reviver));
      }
      return parsePersistedValue<T>(raw, options.reviver);
    },
    setItem: (name: string, value: StorageValue<T>) => {
      if (!isWorkspaceActive()) return;
      const target = resolveStorageTarget(name);
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
        getItem: async () => {
          const localValue = typeof localStorage === 'undefined' ? null : localStorage.getItem(scopedName);
          if (localValue != null) return localValue;
          try {
            return await readIndexedDbItem(scopedName);
          } catch (error) {
            recordPersistenceFailure({ name: scopedName, reason: 'read_failed', error });
            console.warn('[storage] indexeddb buffered read failed', { name: scopedName, error });
            return null;
          }
        },
        setItem: async (value) => {
          const storageBackend = await writeIndexedDbItem(scopedName, value);
          if (storageBackend === 'indexedDb' && typeof localStorage !== 'undefined') localStorage.removeItem(scopedName);
        },
        removeItem: async () => {
          await removeIndexedDbItem(scopedName);
          if (typeof localStorage !== 'undefined') localStorage.removeItem(scopedName);
        },
      };
    },
  });
}
