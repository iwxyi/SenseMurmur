export type LocalOutboxScopeType = 'character' | 'chat' | 'message' | 'artifact';
export type LocalOutboxStatus = 'pending' | 'syncing' | 'failed' | 'succeeded';

export interface LocalOutboxPatchOperationLike {
  id: string;
  targetLabel?: string;
  kind?: string;
  entityId?: string;
  targetIds?: string[];
  clientTimestamp?: number;
  patch?: Record<string, unknown>;
  status?: string;
  attemptCount?: number;
  lastError?: string;
  retryAt?: number;
  lockedAt?: number;
}

export interface LocalOutboxMessageOperationLike {
  id: string;
  targetLabel?: string;
  kind?: string;
  chatId?: string;
  localMessageId?: string;
  messageId?: string;
  createdAt?: number;
  status?: string;
  attemptCount?: number;
  lastError?: string;
  retryAt?: number;
  lockedAt?: number;
}

export interface LocalOutboxArtifactJobLike {
  id: string;
  targetLabel?: string;
  kind?: string;
  characterId?: string;
  dateKey?: string | null;
  sourceKey?: string | null;
  createdAt?: number;
  status?: string;
  attempts?: number;
  error?: string | null;
  updatedAt?: number;
}

export interface LocalOutboxItem {
  id: string;
  targetLabel?: string;
  scopeType: LocalOutboxScopeType;
  kind: string;
  targetId: string;
  targetIds: string[];
  status: LocalOutboxStatus;
  createdAt: number;
  attemptCount: number;
  lastError: string | null;
  retryAt: number;
  lockedAt: number;
  priority: number;
  summaryKey?: string;
}

export interface BuildLocalOutboxProjectionInput {
  characterOperations?: LocalOutboxPatchOperationLike[];
  chatOperations?: LocalOutboxPatchOperationLike[];
  messageOperations?: LocalOutboxMessageOperationLike[];
  artifactJobs?: LocalOutboxArtifactJobLike[];
}

function sortLocalOutboxItems(items: LocalOutboxItem[]) {
  return [...items].sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

function normalizeStatus(status: string | null | undefined): LocalOutboxStatus | null {
  if (status === 'pending' || status === 'syncing' || status === 'failed' || status === 'succeeded') return status;
  if (status === 'running') return 'syncing';
  return null;
}

function operationPriority(kind: string, patch?: Record<string, unknown>) {
  if (kind === 'create') return 100;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'deletedAt')) return 80;
  if (kind === 'delete') return 70;
  return 10;
}

function numberOrZero(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function patchOperationToOutbox(scopeType: 'character' | 'chat', operation: LocalOutboxPatchOperationLike): LocalOutboxItem | null {
  const status = normalizeStatus(operation.status);
  if (!status) return null;
  const kind = operation.kind || 'patch';
  const targetIds = operation.targetIds?.length ? operation.targetIds : [operation.entityId || ''].filter(Boolean);
  return {
    id: operation.id,
    targetLabel: operation.targetLabel || (typeof operation.patch?.name === 'string' ? operation.patch.name : undefined),
    scopeType,
    kind,
    targetId: operation.entityId || targetIds[0] || '',
    targetIds,
    status,
    createdAt: numberOrZero(operation.clientTimestamp),
    attemptCount: numberOrZero(operation.attemptCount),
    lastError: operation.lastError || null,
    retryAt: numberOrZero(operation.retryAt),
    lockedAt: numberOrZero(operation.lockedAt),
    priority: operationPriority(kind, operation.patch),
    summaryKey: Object.keys(operation.patch || {}).sort().join(','),
  };
}

function messageOperationToOutbox(operation: LocalOutboxMessageOperationLike): LocalOutboxItem | null {
  const status = normalizeStatus(operation.status);
  if (!status) return null;
  const kind = operation.kind || 'create';
  const targetId = operation.messageId || operation.localMessageId || operation.chatId || '';
  return {
    id: operation.id,
    targetLabel: operation.targetLabel,
    scopeType: 'message',
    kind,
    targetId,
    targetIds: [targetId].filter(Boolean),
    status,
    createdAt: numberOrZero(operation.createdAt),
    attemptCount: numberOrZero(operation.attemptCount),
    lastError: operation.lastError || null,
    retryAt: numberOrZero(operation.retryAt),
    lockedAt: numberOrZero(operation.lockedAt),
    priority: operationPriority(kind),
    summaryKey: operation.chatId,
  };
}

function artifactJobToOutbox(job: LocalOutboxArtifactJobLike): LocalOutboxItem | null {
  const status = normalizeStatus(job.status);
  if (!status) return null;
  const targetId = job.characterId || '';
  return {
    id: job.id,
    targetLabel: job.targetLabel,
    scopeType: 'artifact',
    kind: job.kind || 'generate',
    targetId,
    targetIds: [targetId].filter(Boolean),
    status,
    createdAt: numberOrZero(job.createdAt || job.updatedAt),
    attemptCount: numberOrZero(job.attempts),
    lastError: job.error || null,
    retryAt: 0,
    lockedAt: 0,
    priority: status === 'syncing' ? 90 : 30,
    summaryKey: [job.dateKey, job.sourceKey].filter(Boolean).join(':'),
  };
}

export function buildLocalOutboxProjection(input: BuildLocalOutboxProjectionInput) {
  return sortLocalOutboxItems([
    ...(input.characterOperations || []).map((operation) => patchOperationToOutbox('character', operation)),
    ...(input.chatOperations || []).map((operation) => patchOperationToOutbox('chat', operation)),
    ...(input.messageOperations || []).map(messageOperationToOutbox),
    ...(input.artifactJobs || []).map(artifactJobToOutbox),
  ].filter((item): item is LocalOutboxItem => Boolean(item)));
}

export function projectLocalOutboxRecords(records: LocalOutboxItem[]) {
  return sortLocalOutboxItems(records);
}

export function summarizeLocalOutbox(items: LocalOutboxItem[]) {
  return {
    uploading: items.filter((item) => item.status === 'syncing').length,
    pendingUpload: items.filter((item) => item.status === 'pending').length,
    failedUpload: items.filter((item) => item.status === 'failed').length,
  };
}
