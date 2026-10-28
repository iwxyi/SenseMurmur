import type { LocalOutboxItem, LocalOutboxScopeType, LocalOutboxStatus } from './localOutboxProjection';

export interface LocalOutboxRecord extends LocalOutboxItem {
  sourceType: LocalOutboxScopeType;
  sourceId: string;
  resultId?: string;
  updatedAt: number;
  payload?: unknown;
}

export interface PersistedLocalOutboxRecord extends LocalOutboxRecord {
  key: string;
  storageKey: string;
}

export interface LocalOutboxPersistenceAdapter {
  list: (storageKey: string) => Promise<PersistedLocalOutboxRecord[]>;
  upsertMany: (storageKey: string, records: LocalOutboxRecord[]) => Promise<void>;
  remove: (storageKey: string, ids: string[]) => Promise<void>;
  clear: (storageKey: string) => Promise<void>;
  replaceSource: (storageKey: string, sourceType: LocalOutboxScopeType, records: LocalOutboxRecord[]) => Promise<void>;
}

export interface LocalOutboxStatusPatch {
  status: LocalOutboxStatus;
  attemptCount?: number;
  lastError?: string | null;
  retryAt?: number;
  lockedAt?: number;
  updatedAt?: number;
}

const LOCAL_OUTBOX_DB_NAME = 'pneumata-local-outbox';
const LOCAL_OUTBOX_DB_VERSION = 1;
const LOCAL_OUTBOX_STORE = 'outbox_records';
const LOCAL_OUTBOX_STORAGE_INDEX = 'storageKey';
const LOCAL_OUTBOX_SOURCE_INDEX = 'storageKeySourceType';
const LOCAL_OUTBOX_KEY_SEPARATOR = '\n';

let localOutboxDbOpenPromise: Promise<IDBDatabase | null> | null = null;

function localOutboxRowKey(storageKey: string, id: string) {
  return `${storageKey}${LOCAL_OUTBOX_KEY_SEPARATOR}${id}`;
}

function normalizeStatus(value: unknown): LocalOutboxStatus | null {
  return value === 'pending' || value === 'syncing' || value === 'failed' || value === 'succeeded' ? value : null;
}

function normalizeScopeType(value: unknown): LocalOutboxScopeType | null {
  return value === 'character' || value === 'chat' || value === 'message' || value === 'artifact' ? value : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function sanitizeLocalOutboxRecord(value: unknown): LocalOutboxRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const scopeType = normalizeScopeType(record.scopeType);
  const status = normalizeStatus(record.status);
  const id = stringValue(record.id);
  if (!scopeType || !status || !id) return null;
  const sourceType = normalizeScopeType(record.sourceType) || scopeType;
  const targetId = stringValue(record.targetId);
  const targetIds = stringArrayValue(record.targetIds);
  return {
    id,
    scopeType,
    sourceType,
    sourceId: stringValue(record.sourceId) || id,
    resultId: typeof record.resultId === 'string' ? record.resultId : undefined,
    kind: stringValue(record.kind) || 'operation',
    targetId,
    targetLabel: typeof record.targetLabel === 'string' ? record.targetLabel : undefined,
    targetIds: targetIds.length ? targetIds : [targetId].filter(Boolean),
    status,
    createdAt: numberValue(record.createdAt),
    attemptCount: numberValue(record.attemptCount),
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    retryAt: numberValue(record.retryAt),
    lockedAt: numberValue(record.lockedAt),
    priority: numberValue(record.priority),
    summaryKey: typeof record.summaryKey === 'string' ? record.summaryKey : undefined,
    updatedAt: numberValue(record.updatedAt) || Date.now(),
    payload: record.payload,
  };
}

function toPersistedRow(storageKey: string, record: LocalOutboxRecord): PersistedLocalOutboxRecord {
  return {
    ...record,
    key: localOutboxRowKey(storageKey, record.id),
    storageKey,
  };
}

function openLocalOutboxDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (localOutboxDbOpenPromise) return localOutboxDbOpenPromise;
  localOutboxDbOpenPromise = new Promise((resolve) => {
    const request = indexedDB.open(LOCAL_OUTBOX_DB_NAME, LOCAL_OUTBOX_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LOCAL_OUTBOX_STORE)) {
        const store = database.createObjectStore(LOCAL_OUTBOX_STORE, { keyPath: 'key' });
        store.createIndex(LOCAL_OUTBOX_STORAGE_INDEX, 'storageKey', { unique: false });
        store.createIndex(LOCAL_OUTBOX_SOURCE_INDEX, ['storageKey', 'sourceType'], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn('[local-outbox] indexeddb open failed', request.error);
      resolve(null);
    };
    request.onblocked = () => {
      console.warn('[local-outbox] indexeddb open blocked');
    };
  });
  return localOutboxDbOpenPromise;
}

function createIndexedDbLocalOutboxAdapter(): LocalOutboxPersistenceAdapter {
  return {
    async list(storageKey) {
      const database = await openLocalOutboxDb();
      if (!database) return [];
      return new Promise<PersistedLocalOutboxRecord[]>((resolve, reject) => {
        const transaction = database.transaction(LOCAL_OUTBOX_STORE, 'readonly');
        const store = transaction.objectStore(LOCAL_OUTBOX_STORE);
        const request = store.index(LOCAL_OUTBOX_STORAGE_INDEX).openCursor(IDBKeyRange.only(storageKey));
        const result: PersistedLocalOutboxRecord[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(result.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt || a.id.localeCompare(b.id)));
            return;
          }
          const row = cursor.value as PersistedLocalOutboxRecord;
          const sanitized = sanitizeLocalOutboxRecord(row);
          if (sanitized) result.push({ ...sanitized, key: row.key, storageKey });
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('Local outbox read failed'));
      });
    },
    async upsertMany(storageKey, records) {
      const database = await openLocalOutboxDb();
      if (!database) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(LOCAL_OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(LOCAL_OUTBOX_STORE);
        records.forEach((record) => store.put(toPersistedRow(storageKey, record)));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Local outbox upsert failed'));
      });
    },
    async remove(storageKey, ids) {
      const database = await openLocalOutboxDb();
      if (!database) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(LOCAL_OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(LOCAL_OUTBOX_STORE);
        ids.forEach((id) => store.delete(localOutboxRowKey(storageKey, id)));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Local outbox remove failed'));
      });
    },
    async clear(storageKey) {
      const database = await openLocalOutboxDb();
      if (!database) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(LOCAL_OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(LOCAL_OUTBOX_STORE);
        const request = store.index(LOCAL_OUTBOX_STORAGE_INDEX).openCursor(IDBKeyRange.only(storageKey));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('Local outbox clear failed'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Local outbox clear failed'));
      });
    },
    async replaceSource(storageKey, sourceType, records) {
      const database = await openLocalOutboxDb();
      if (!database) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(LOCAL_OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(LOCAL_OUTBOX_STORE);
        const index = store.index(LOCAL_OUTBOX_SOURCE_INDEX);
        const request = index.openCursor(IDBKeyRange.only([storageKey, sourceType]));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
            return;
          }
          records.forEach((record) => store.put(toPersistedRow(storageKey, { ...record, sourceType })));
        };
        request.onerror = () => reject(request.error || new Error('Local outbox replace failed'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Local outbox replace failed'));
      });
    },
  };
}

const defaultLocalOutboxAdapter = createIndexedDbLocalOutboxAdapter();

export function selectDueLocalOutboxRecord(records: LocalOutboxRecord[], now = Date.now(), sourceType?: LocalOutboxScopeType) {
  const dueRecords = records
    .filter((record) => record.status === 'pending')
    .filter((record) => !sourceType || record.sourceType === sourceType)
    .filter((record) => !record.retryAt || record.retryAt <= now)
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return dueRecords[0] ?? null;
}

export function createLocalOutboxRepository(adapter: LocalOutboxPersistenceAdapter = defaultLocalOutboxAdapter) {
  return {
    list(storageKey: string) {
      return adapter.list(storageKey);
    },
    async upsertMany(storageKey: string, records: LocalOutboxRecord[]) {
      const sanitized = records
        .map((record) => sanitizeLocalOutboxRecord(record))
        .filter((record): record is LocalOutboxRecord => Boolean(record));
      await adapter.upsertMany(storageKey, sanitized);
    },
    remove(storageKey: string, ids: string[]) {
      return adapter.remove(storageKey, ids);
    },
    clear(storageKey: string) {
      return adapter.clear(storageKey);
    },
    async replaceSource(storageKey: string, sourceType: LocalOutboxScopeType, records: LocalOutboxRecord[]) {
      const sanitized = records
        .map((record) => sanitizeLocalOutboxRecord({ ...record, sourceType }))
        .filter((record): record is LocalOutboxRecord => Boolean(record));
      await adapter.replaceSource(storageKey, sourceType, sanitized);
    },
    async selectDue(storageKey: string, options: { now?: number; sourceType?: LocalOutboxScopeType } = {}) {
      const records = await adapter.list(storageKey);
      return selectDueLocalOutboxRecord(records, options.now, options.sourceType);
    },
    async markStatus(storageKey: string, id: string, patch: LocalOutboxStatusPatch) {
      const records = await adapter.list(storageKey);
      const existing = records.find((record) => record.id === id);
      if (!existing) return null;
      const next = sanitizeLocalOutboxRecord({
        ...existing,
        ...patch,
        updatedAt: patch.updatedAt ?? Date.now(),
      });
      if (!next) return null;
      await adapter.upsertMany(storageKey, [next]);
      return next;
    },
  };
}

export const localOutboxRepository = createLocalOutboxRepository();
