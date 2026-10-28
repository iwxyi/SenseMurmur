import type { SyncPatchOperation } from './syncProjector';

export interface FieldConflictRecord {
  id: string;
  entityType: 'chat' | 'character';
  entityId: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  localOperationIds: string[];
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  detectedAt: number;
  accepted?: boolean;
}

const HIDDEN_FIELDS = new Set(['updatedAt', 'lastMessageAt', 'createdAt', 'fieldVersions']);
const MAX_CONFLICTS = 80;
const MAX_STRING_LENGTH = 160;
const MAX_ARRAY_ITEMS = 6;
const MAX_OBJECT_KEYS = 12;

function isDisplayableField(field: string) {
  return !HIDDEN_FIELDS.has(field);
}

function stableValue(value: unknown) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function valuesDiffer(a: unknown, b: unknown) {
  return stableValue(a) !== stableValue(b);
}

function compactConflictValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (/^data:[^;]+;base64,/i.test(normalized)) return `[inline-media:${normalized.length}]`;
    return normalized.length > MAX_STRING_LENGTH ? `${normalized.slice(0, MAX_STRING_LENGTH - 1)}...` : normalized;
  }
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (depth >= 2) return `[${Array.isArray(value) ? 'array' : 'object'}]`;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactConflictValue(item, depth + 1, seen));
    return value.length > MAX_ARRAY_ITEMS ? [...items, `... +${value.length - MAX_ARRAY_ITEMS}`] : items;
  }
  const source = value as Record<string, unknown>;
  const entries = Object.entries(source).slice(0, MAX_OBJECT_KEYS);
  const compacted: Record<string, unknown> = {};
  entries.forEach(([key, entryValue]) => {
    compacted[key] = compactConflictValue(entryValue, depth + 1, seen);
  });
  if (Object.keys(source).length > MAX_OBJECT_KEYS) {
    compacted.__truncatedKeys = Object.keys(source).length - MAX_OBJECT_KEYS;
  }
  return compacted;
}

function conflictId(entityType: FieldConflictRecord['entityType'], entityId: string, field: string) {
  return `${entityType}:${entityId}:${field}`;
}

export function detectPendingFieldConflicts<TEntity extends { id: string; updatedAt?: number; fieldVersions?: Record<string, number> }>(
  params: {
    entityType: FieldConflictRecord['entityType'];
    localEntities: TEntity[];
    remoteEntities: TEntity[];
    pendingOperations: Array<SyncPatchOperation<Record<string, unknown>>>;
    existingConflicts?: FieldConflictRecord[];
    now?: number;
  },
) {
  const now = params.now ?? Date.now();
  const localById = new Map(params.localEntities.map((entity) => [entity.id, entity]));
  const pendingByEntity = new Map<string, Array<SyncPatchOperation<Record<string, unknown>>>>();
  params.pendingOperations
    .filter((operation) => operation.status !== 'failed')
    .forEach((operation) => {
      const list = pendingByEntity.get(operation.entityId) || [];
      list.push(operation);
      pendingByEntity.set(operation.entityId, list);
    });

  const refreshedById = new Map(params.remoteEntities.map((entity) => [entity.id, entity as Record<string, unknown>]));
  const nextById = new Map((params.existingConflicts || [])
    .filter((record) => record.entityType !== params.entityType || (
      !Object.prototype.hasOwnProperty.call(refreshedById.get(record.entityId) || {}, record.field)
      && record.remoteUpdatedAt > record.localUpdatedAt
      && pendingByEntity.get(record.entityId)?.some((operation) => operation.id === record.localOperationIds.at(-1))
    ))
    .map((record) => [record.id, record]));

  for (const remote of params.remoteEntities) {
    const local = localById.get(remote.id);
    const pending = pendingByEntity.get(remote.id);
    if (!local || !pending?.length) continue;
    const remoteRecord = remote as Record<string, unknown>;
    const localRecord = local as Record<string, unknown>;
    const remotePatchFields = new Set(Object.keys(remoteRecord).filter(isDisplayableField));

    for (const operation of pending) {
      for (const field of Object.keys(operation.patch).filter(isDisplayableField)) {
        if (!remotePatchFields.has(field)) continue;
        if (!valuesDiffer(localRecord[field], remoteRecord[field])) continue;
        const remoteFieldVersion = remote.fieldVersions
          ? (remote.fieldVersions[field] || 0)
          : (remote.updatedAt || 0);
        if (remoteFieldVersion <= operation.clientTimestamp) continue;
        const id = conflictId(params.entityType, remote.id, field);
        const previous = (params.existingConflicts || []).find((record) => record.id === id);
        nextById.set(id, {
          id,
          entityType: params.entityType,
          entityId: remote.id,
          field,
          localValue: compactConflictValue(localRecord[field]),
          remoteValue: compactConflictValue(remoteRecord[field]),
          localOperationIds: Array.from(new Set([...(previous?.localOperationIds || []), operation.id])),
          localUpdatedAt: operation.clientTimestamp,
          remoteUpdatedAt: remoteFieldVersion,
          detectedAt: previous?.detectedAt || now,
          accepted: previous?.accepted === true
            && previous.localOperationIds.includes(operation.id)
            && previous.remoteUpdatedAt >= remoteFieldVersion,
        });
      }
    }
  }

  return Array.from(nextById.values())
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, MAX_CONFLICTS);
}

export function removePendingConflictField<TOperation extends SyncPatchOperation<Record<string, unknown>>>(
  operations: TOperation[], entityId: string, field: string,
): TOperation[] {
  return operations.flatMap((operation) => {
    if (operation.entityId !== entityId || !Object.prototype.hasOwnProperty.call(operation.patch, field)) return [operation];
    if (operation.status === 'syncing') throw new Error('同步正在进行，请完成后重试');
    const patch = { ...operation.patch };
    delete patch[field];
    return Object.keys(patch).length ? [{ ...operation, patch }] : [];
  });
}

export function clearResolvedFieldConflicts(
  records: FieldConflictRecord[],
  params: {
    entityType: FieldConflictRecord['entityType'];
    entityIds?: string[];
    operationIds?: string[];
  },
) {
  const entityIds = new Set(params.entityIds || []);
  const operationIds = new Set(params.operationIds || []);
  if (!entityIds.size && !operationIds.size) return records;
  return records.filter((record) => {
    if (record.entityType !== params.entityType) return true;
    if (entityIds.has(record.entityId)) return false;
    if (record.localOperationIds.some((id) => operationIds.has(id))) return false;
    return true;
  });
}
