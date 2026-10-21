import { useAuthStore } from './useAuthStore';
import type { SyncPatchOperation } from '../services/syncProjector';
import { isCloudSyncEnabled, isCloudSyncUserDisabled, setCloudSyncEnabled } from '../services/cloudSyncPreference';
import { isCloudSyncBootstrapLocked } from '../services/cloudSyncBootstrapLock';
import { isWorkspaceActive } from '../services/workspaceLifecycle';

export function isLocalOnlyMode() {
  return useAuthStore.getState().authMode === 'local';
}

function getCloudSyncGateState() {
  const authState = useAuthStore.getState();
  const authMode = authState.authMode;
  const isLoggedIn = authState.isLoggedIn;
  const userDisabled = isCloudSyncUserDisabled();
  const entitlementDisabled = authState.user?.cloudSyncEntitled === false;
  let cloudSyncEnabled = isCloudSyncEnabled();

  if (
    authMode === 'cloud'
    && isLoggedIn
    && !cloudSyncEnabled
    && !userDisabled
    && !entitlementDisabled
  ) {
    setCloudSyncEnabled(true, { source: 'auth' });
    cloudSyncEnabled = true;
  }

  const bootstrapLocked = isCloudSyncBootstrapLocked();
  const reasons = [
    authMode === 'local' ? 'local-mode' : '',
    !isLoggedIn ? 'not-logged-in' : '',
    !cloudSyncEnabled && userDisabled ? 'cloud-sync-user-disabled' : '',
    !cloudSyncEnabled && entitlementDisabled ? 'cloud-sync-not-entitled' : '',
    !cloudSyncEnabled && !userDisabled && !entitlementDisabled ? 'cloud-sync-disabled' : '',
    bootstrapLocked ? 'bootstrap-locked' : '',
  ].filter(Boolean);

  return {
    skipCloudSync: reasons.length > 0,
    reasons,
    authMode,
    isLoggedIn,
    cloudSyncEnabled,
    cloudSyncUserDisabled: userDisabled,
    cloudSyncEntitlementDisabled: entitlementDisabled,
    bootstrapLocked,
    userId: authState.user?.id || null,
  };
}

export function shouldSkipCloudSync() {
  return !isWorkspaceActive() || getCloudSyncGateState().skipCloudSync;
}

export function getCloudSyncSkipDiagnostics() {
  return getCloudSyncGateState();
}

export function canAttemptOnlineSync() {
  return !shouldSkipCloudSync() && (typeof navigator === 'undefined' || navigator.onLine);
}

export type SyncErrorKind = 'auth' | 'network' | 'server_unavailable' | 'conflict_ignored' | 'validation' | 'unknown';

const SYNC_ERROR_KINDS: SyncErrorKind[] = ['auth', 'network', 'server_unavailable', 'conflict_ignored', 'validation'];

export interface SyncErrorClassification {
  kind: SyncErrorKind;
  message: string;
  retryable: boolean;
  terminal: boolean;
}

function syncErrorFlags(kind: SyncErrorKind) {
  return {
    retryable: kind === 'network' || kind === 'server_unavailable',
    terminal: kind === 'validation' || kind === 'conflict_ignored',
  };
}

export function parseSyncErrorClassification(value: unknown): SyncErrorClassification {
  const text = value instanceof Error ? value.message : String(value ?? '');
  const prefixMatch = text.match(/^([a-z_]+):\s*(.*)$/i);
  const parsedKind = prefixMatch?.[1] as SyncErrorKind | undefined;
  const kind = parsedKind && SYNC_ERROR_KINDS.includes(parsedKind) ? parsedKind : 'unknown';
  const message = prefixMatch && kind !== 'unknown' ? prefixMatch[2] : text;
  return {
    kind,
    message,
    ...syncErrorFlags(kind),
  };
}

export function classifySyncError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : '';
  if (/BRANCH_PARENT_NOT_FOUND|CHAT_CREATE_PENDING|SYNC_OPERATION_IN_PROGRESS/i.test(code) || /分支父节点尚未同步|同步操作正在处理|对应会话尚未完成云端创建/i.test(message)) {
    return `network: ${message}`;
  }
  if (/BRANCH_STATE_CONFLICT|BRANCH_STATE_STALE|BRANCH_NODE_CONFLICT/i.test(code) || /分支状态已被其他设备更新|分支状态已更新|分支节点 ID 已指向其他消息/i.test(message)) {
    return `conflict_ignored: ${message}`;
  }
  if (/chat:create pending|branch parent pending|会话尚未完成云端创建|对应会话尚未完成云端创建|分支父消息尚未完成云端同步/i.test(message)) return `network: ${message}`;
  if (/401|登录已过期|未登录/i.test(message)) return `auth: ${message}`;
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) return `network: ${message}`;
  if (/500|502|503|504|服务器错误/i.test(message)) return `server_unavailable: ${message}`;
  if (/404|不存在|未删除/i.test(message)) return `conflict_ignored: ${message}`;
  return `validation: ${message}`;
}

export function isTerminalSyncError(classified: string) {
  return parseSyncErrorClassification(classified).terminal;
}

export function latestSyncError<T extends { lastError?: string }>(queue: T[]) {
  return [...queue].reverse().find((item) => item.lastError)?.lastError || null;
}

export function isOperationDue<T extends { status: 'pending' | 'syncing' | 'failed'; retryAt?: number }>(operation: T, now = Date.now()) {
  return operation.status === 'pending' && (!operation.retryAt || operation.retryAt <= now);
}

export function selectDueOperation<T extends { status: 'pending' | 'syncing' | 'failed'; retryAt?: number }>(
  operations: T[],
  now = Date.now(),
  priority?: (operation: T) => number,
) {
  const dueOperations = operations.filter((item) => isOperationDue(item, now));
  if (!dueOperations.length) return undefined;
  if (!priority) return dueOperations[0];
  return dueOperations.reduce((best, item) => (priority(item) > priority(best) ? item : best), dueOperations[0]);
}

export function getPendingQueueWorkerPriority<T extends { status: 'pending' | 'syncing' | 'failed'; retryAt?: number }>(
  operations: T[],
  basePriority: number,
  priority: (operation: T) => number,
  now = Date.now(),
) {
  const dueOperation = selectDueOperation(operations, now, priority);
  return basePriority + (dueOperation ? priority(dueOperation) : 0);
}

export function nextRetryAt(attemptCount: number, delays: number[], now = Date.now()) {
  const delay = delays[Math.min(attemptCount, delays.length - 1)] ?? delays.at(-1) ?? 0;
  return delay > 0 ? now + delay : now;
}

function createOperationId(kind: string, timestamp: number, targetIds: string[]) {
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 12);
  return `${kind}-${timestamp}-${targetIds[0] || 'all'}-${randomId}`;
}

export function createPendingOperation<TPatch extends Record<string, unknown>, TOp extends SyncPatchOperation<TPatch> & { kind: string; targetIds: string[] }>(
  params: {
    kind: TOp['kind'];
    targetIds?: string[];
    patch?: TPatch;
    timestamp?: number;
  }
): TOp {
  const timestamp = params.timestamp ?? Date.now();
  const targetIds = params.targetIds ?? [];
  return {
    id: createOperationId(String(params.kind), timestamp, targetIds),
    kind: params.kind,
    entityId: targetIds[0] || '',
    patch: (params.patch || {}) as TPatch,
    targetIds,
    clientTimestamp: timestamp,
    attemptCount: 0,
    status: 'pending',
    lastError: undefined,
    retryAt: 0,
    lockedAt: 0,
  } as TOp;
}

export function removePendingOperation<T extends { id: string }>(queue: T[], operationId: string) {
  return queue.filter((item) => item.id !== operationId);
}

export function updatePendingOperation<T extends { id: string }>(queue: T[], operationId: string, patch: Partial<T>) {
  return queue.map((item) => item.id === operationId ? { ...item, ...patch } : item);
}

export function markOperationLocked<T extends { lockedAt?: number }>(operation: T, now = Date.now()) {
  return { ...operation, lockedAt: now };
}

export function markOperationRetry<T extends { status: 'pending' | 'syncing' | 'failed'; attemptCount: number; lastError?: string; retryAt?: number; lockedAt?: number }>(
  operation: T,
  error: string,
  retryAt: number,
  status: T['status'] = 'pending' as T['status'],
) {
  return {
    ...operation,
    status,
    attemptCount: operation.attemptCount + 1,
    lastError: error,
    retryAt: status === 'pending' ? retryAt : 0,
    lockedAt: 0,
  };
}

export interface DueOperationWorker<T extends { id: string; status: 'pending' | 'syncing' | 'failed'; attemptCount: number; retryAt?: number; lockedAt?: number }, TResult = unknown> {
  getOperations: () => T[];
  canRun: () => boolean;
  markSyncing: (operation: T, lockedOperation: T) => void;
  execute: (operation: T) => Promise<TResult>;
  onSuccess: (operation: T, result: TResult) => void;
  onFailure: (operation: T, error: unknown, retry: { classified: string; status: T['status']; retryAt: number; retryOperation: T }) => void;
  retryDelays: number[];
  isTerminalError?: (classified: string) => boolean;
  priority?: (operation: T) => number;
  now?: () => number;
}

export interface PendingOperationQueueWorker<T extends { id: string; status: 'pending' | 'syncing' | 'failed'; attemptCount: number; retryAt?: number; lockedAt?: number }, TResult = unknown> {
  getOperations: () => T[];
  canRun: () => boolean;
  updateOperation: (operationId: string, operation: T) => void;
  execute: (operation: T) => Promise<TResult>;
  onSuccess: (operation: T, result: TResult) => void;
  onFailure?: (operation: T, error: unknown, retry: { classified: string; status: T['status']; retryAt: number; retryOperation: T }) => void;
  scheduleNext?: (delay: number) => void;
  retryDelays: number[];
  isTerminalError?: (classified: string) => boolean;
  priority?: (operation: T) => number;
  now?: () => number;
  batchSize?: number;
}

export type DueOperationResult<T, TResult = unknown> =
  | { ran: false }
  | { ran: true; status: 'success'; operation: T; result: TResult }
  | { ran: true; status: 'failure'; operation: T; error: unknown; classified: string; retryAt: number };

export async function runDueOperation<T extends { id: string; status: 'pending' | 'syncing' | 'failed'; attemptCount: number; retryAt?: number; lockedAt?: number }, TResult = unknown>(
  worker: DueOperationWorker<T, TResult>,
): Promise<DueOperationResult<T, TResult>> {
  const now = worker.now?.() ?? Date.now();
  const operation = selectDueOperation(worker.getOperations(), now, worker.priority);
  if (!operation || !worker.canRun()) return { ran: false as const };

  const lockedOperation = { ...markOperationLocked(operation, now), status: 'syncing' as const } as T;
  worker.markSyncing(operation, lockedOperation);

  try {
    const result = await worker.execute(operation);
    worker.onSuccess(operation, result);
    return { ran: true as const, status: 'success' as const, operation, result };
  } catch (error) {
    const classified = classifySyncError(error);
    const attemptCount = operation.attemptCount + 1;
    const status = worker.isTerminalError?.(classified) ? 'failed' as T['status'] : 'pending' as T['status'];
    const retryAt = status === 'pending'
      ? nextRetryAt(attemptCount, worker.retryDelays, now)
      : 0;
    const retryOperation = markOperationRetry(operation, classified, retryAt, status) as T;
    worker.onFailure(operation, error, { classified, status, retryAt, retryOperation });
    return { ran: true as const, status: 'failure' as const, operation, error, classified, retryAt };
  }
}

export interface PendingOperationQueueResult<T, TResult = unknown> {
  ran: boolean;
  results: Array<DueOperationResult<T, TResult>>;
  processed: number;
}

export async function runPendingOperationQueue<T extends { id: string; status: 'pending' | 'syncing' | 'failed'; attemptCount: number; retryAt?: number; lockedAt?: number }, TResult = unknown>(
  worker: PendingOperationQueueWorker<T, TResult>,
) {
  const batchSize = Math.max(1, Math.floor(worker.batchSize ?? 1));
  const results: Array<DueOperationResult<T, TResult>> = [];
  const runOne = () => runDueOperation<T, TResult>({
    getOperations: worker.getOperations,
    canRun: worker.canRun,
    retryDelays: worker.retryDelays,
    isTerminalError: worker.isTerminalError,
    priority: worker.priority,
    now: worker.now,
    markSyncing: (operation, lockedOperation) => {
      worker.updateOperation(operation.id, lockedOperation);
    },
    execute: worker.execute,
    onSuccess: (operation, result) => {
      worker.onSuccess(operation, result);
      if (batchSize === 1) worker.scheduleNext?.(50);
    },
    onFailure: (operation, error, retry) => {
      worker.updateOperation(operation.id, retry.retryOperation);
      worker.onFailure?.(operation, error, retry);
      if (retry.status === 'pending') {
        const now = worker.now?.() ?? Date.now();
        worker.scheduleNext?.(Math.max(0, retry.retryAt - now));
      }
    },
  });

  for (let index = 0; index < batchSize; index += 1) {
    const result = await runOne();
    results.push(result);
    if (!result.ran || result.status === 'failure') break;
  }

  const stoppedOnFailure = results.some((result) => result.ran && result.status === 'failure');
  if (batchSize > 1 && !stoppedOnFailure) {
    const now = worker.now?.() ?? Date.now();
    if (selectDueOperation(worker.getOperations(), now, worker.priority)) {
      worker.scheduleNext?.(0);
    }
  }

  return {
    ran: results.some((result) => result.ran),
    results,
    processed: results.filter((result) => result.ran).length,
  } satisfies PendingOperationQueueResult<T, TResult>;
}

export function recoverInterruptedOperations<T extends { status: 'pending' | 'syncing' | 'failed'; lastError?: string; lockedAt?: number }>(queue: T[] = []) {
  return queue.map((item) => item.status === 'syncing'
    ? {
      ...item,
      status: 'pending' as const,
      lastError: item.lastError || 'network: 上次同步中断，已重新排队',
      lockedAt: 0,
    }
    : item);
}

export function retryFailedOperations<T extends { status: 'pending' | 'syncing' | 'failed'; lastError?: string; retryAt?: number; lockedAt?: number }>(queue: T[] = []) {
  let changed = false;
  const nextQueue = queue.map((item) => item.status === 'failed'
    ? {
      ...item,
      status: 'pending' as const,
      lastError: undefined,
      retryAt: 0,
      lockedAt: 0,
    }
    : item);
  changed = nextQueue.some((item, index) => item !== queue[index]);
  return changed ? nextQueue : queue;
}
