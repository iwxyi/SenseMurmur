import { localOutboxRepository, type LocalOutboxRecord } from './localOutboxDb';
import { localOutboxStorageKey, mirrorLocalOutboxSourceQueue } from './localOutboxMirror';
import type {
  LocalOutboxArtifactJobLike,
  LocalOutboxMessageOperationLike,
  LocalOutboxPatchOperationLike,
  LocalOutboxScopeType,
  LocalOutboxStatus,
} from './localOutboxProjection';
import { buildLocalOutboxProjection } from './localOutboxProjection';
import { filterCancelledSyncTasks, syncTaskQueueStorageKey } from './syncTaskCancellation';

export const LOCAL_OUTBOX_HISTORY_CHANGED_EVENT = 'pneumata-local-outbox-history-changed';

function historyStorageKey(storageKey: string) {
  return `${storageKey}:history`;
}

function notifyHistoryChanged() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(LOCAL_OUTBOX_HISTORY_CHANGED_EVENT));
  }
}

export interface LocalOutboxWorkerOperationLike {
  id: string;
  status: LocalOutboxStatus | 'running';
  attemptCount?: number;
  lastError?: string | null;
  retryAt?: number;
  lockedAt?: number;
}

export type LocalOutboxHistoryEntry = LocalOutboxRecord;

function sourceInput(sourceType: LocalOutboxScopeType, operations: unknown[]) {
  if (sourceType === 'character') return { characterOperations: operations as LocalOutboxPatchOperationLike[] };
  if (sourceType === 'chat') return { chatOperations: operations as LocalOutboxPatchOperationLike[] };
  if (sourceType === 'message') return { messageOperations: operations as LocalOutboxMessageOperationLike[] };
  return { artifactJobs: operations as LocalOutboxArtifactJobLike[] };
}

export async function mirrorLocalOutboxWorkerQueue(sourceType: LocalOutboxScopeType, operations: unknown[]) {
  try {
    await mirrorLocalOutboxSourceQueue(sourceType, sourceInput(sourceType, operations));
  } catch (error) {
    console.warn(`[local-outbox] failed to mirror ${sourceType} queue`, error);
  }
}

export function removeLocalOutboxWorkerOperation(operationId: string) {
  void localOutboxRepository.remove(localOutboxStorageKey(), [operationId]).catch((error) => {
    console.warn('[local-outbox] failed to remove operation', error);
  });
}

export async function completeLocalOutboxWorkerOperation(
  sourceType: LocalOutboxScopeType,
  operation: LocalOutboxPatchOperationLike | LocalOutboxMessageOperationLike | LocalOutboxArtifactJobLike,
  resultId?: string,
) {
  // Completed history has its own namespace: mirroring a live queue must never
  // delete an acknowledgement or race with its removal from the source store.
  const storageKey = localOutboxStorageKey();
  if (!filterCancelledSyncTasks(syncTaskQueueStorageKey(sourceType), [operation]).length) return;
  const [item] = buildLocalOutboxProjection(sourceInput(sourceType, [{ ...operation, status: 'succeeded' }]));
  if (!item) throw new Error('Cannot archive an invalid sync operation');
  try {
    await localOutboxRepository.upsertMany(historyStorageKey(storageKey), [{
      ...item, sourceType, sourceId: operation.id, resultId, updatedAt: Date.now(),
      lastError: null, retryAt: 0, lockedAt: 0,
    }]);
    await trimLocalOutboxHistory(storageKey);
    notifyHistoryChanged();
  } catch (error) {
    console.warn('[local-outbox] failed to complete operation', error);
  }
}

export function markLocalOutboxWorkerOperation(operation: LocalOutboxWorkerOperationLike) {
  void localOutboxRepository.markStatus(localOutboxStorageKey(), operation.id, {
    status: operation.status === 'running' ? 'syncing' : operation.status,
    attemptCount: operation.attemptCount || 0,
    lastError: operation.lastError || null,
    retryAt: operation.retryAt || 0,
    lockedAt: operation.lockedAt || 0,
  }).then(() => {
    if (operation.status === 'failed') notifyHistoryChanged();
    return null;
  }).catch((error) => {
    console.warn('[local-outbox] failed to mark operation', error);
  });
}

export async function listLocalOutboxHistory(options: { limit?: number; offset?: number; activeIds?: Set<string> } = {}) {
  const storageKey = localOutboxStorageKey();
  const [records, archived] = await Promise.all([
    localOutboxRepository.list(storageKey), localOutboxRepository.list(historyStorageKey(storageKey)),
  ]);
  const history = [...new Map([...records, ...archived].map((record) => [record.id, record])).values()]
    .filter((record) => (record.status === 'failed' || record.status === 'succeeded') && !options.activeIds?.has(record.id))
    .filter((record) => filterCancelledSyncTasks(syncTaskQueueStorageKey(record.sourceType), [record]).length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const offset = Math.max(0, options.offset || 0);
  const limit = Math.max(1, options.limit || 50);
  return {
    items: history.slice(offset, offset + limit),
    total: history.length,
    succeededTotal: history.filter((record) => record.status === 'succeeded').length,
    failedTotal: history.filter((record) => record.status === 'failed').length,
    hasMore: offset + limit < history.length,
  };
}

async function trimLocalOutboxHistory(storageKey: string, limit = 1000) {
  const records = await localOutboxRepository.list(historyStorageKey(storageKey));
  const overflow = records
    .filter((record) => record.status === 'failed' || record.status === 'succeeded')
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(limit);
  if (!overflow.length) return 0;
  await localOutboxRepository.remove(historyStorageKey(storageKey), overflow.map((record) => record.id));
  return overflow.length;
}

export async function clearLocalOutboxHistory() {
  const storageKey = localOutboxStorageKey();
  const [records, archived] = await Promise.all([
    localOutboxRepository.list(storageKey), localOutboxRepository.list(historyStorageKey(storageKey)),
  ]);
  const ids = records
    .filter((record) => record.status === 'failed' || record.status === 'succeeded')
    .map((record) => record.id);
  await Promise.all([
    localOutboxRepository.remove(storageKey, ids),
    localOutboxRepository.clear(historyStorageKey(storageKey)),
  ]);
  notifyHistoryChanged();
  return new Set([...ids, ...archived.map((record) => record.id)]).size;
}
