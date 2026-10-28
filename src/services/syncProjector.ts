export interface SyncPatchOperation<TPatch extends Record<string, unknown>> {
  id: string;
  entityId: string;
  targetLabel?: string;
  clientTimestamp: number;
  patch: TPatch;
  status: 'pending' | 'syncing' | 'failed';
  attemptCount: number;
  lastError?: string;
  retryAt?: number;
  lockedAt?: number;
}

export function applyFieldPatch<T extends { fieldVersions?: Record<string, number> }>(entity: T, patch: Record<string, unknown>, clientTimestamp: number): T {
  const fieldVersions = { ...(entity.fieldVersions || {}) };
  const next: Record<string, unknown> = { ...entity };

  for (const [field, value] of Object.entries(patch)) {
    const previous = fieldVersions[field] || 0;
    next[field] = value;
    fieldVersions[field] = Math.max(previous, clientTimestamp);
  }

  next.fieldVersions = fieldVersions;
  return next as T;
}

export function projectEntities<T extends { id: string; fieldVersions?: Record<string, number> }>(
  entities: T[],
  operations: Array<SyncPatchOperation<Record<string, unknown>>>
) {
  const map = new Map(entities.map((item) => [item.id, item]));
  const ordered = [...operations].sort((a, b) => a.clientTimestamp - b.clientTimestamp);

  for (const operation of ordered) {
    const current = map.get(operation.entityId);
    if (!current) continue;
    map.set(operation.entityId, applyFieldPatch(current, operation.patch, operation.clientTimestamp));
  }

  return Array.from(map.values());
}
