import { describe, expect, it } from 'vitest';
import { createLocalOutboxRepository, sanitizeLocalOutboxRecord, selectDueLocalOutboxRecord, type LocalOutboxPersistenceAdapter, type LocalOutboxRecord, type PersistedLocalOutboxRecord } from './localOutboxDb';
import type { LocalOutboxScopeType } from './localOutboxProjection';

function createMemoryAdapter(): LocalOutboxPersistenceAdapter {
  const rows = new Map<string, PersistedLocalOutboxRecord>();
  const keyOf = (storageKey: string, id: string) => `${storageKey}\n${id}`;
  const persist = (storageKey: string, record: LocalOutboxRecord): PersistedLocalOutboxRecord => ({
    ...record,
    key: keyOf(storageKey, record.id),
    storageKey,
  });
  return {
    async list(storageKey) {
      return Array.from(rows.values())
        .filter((row) => row.storageKey === storageKey)
        .sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    },
    async upsertMany(storageKey, records) {
      records.forEach((record) => rows.set(keyOf(storageKey, record.id), persist(storageKey, record)));
    },
    async remove(storageKey, ids) {
      ids.forEach((id) => rows.delete(keyOf(storageKey, id)));
    },
    async clear(storageKey) {
      for (const row of Array.from(rows.values())) {
        if (row.storageKey === storageKey) rows.delete(row.key);
      }
    },
    async replaceSource(storageKey, sourceType, records) {
      for (const row of Array.from(rows.values())) {
        if (row.storageKey === storageKey && row.sourceType === sourceType) rows.delete(row.key);
      }
      records.forEach((record) => rows.set(keyOf(storageKey, record.id), persist(storageKey, { ...record, sourceType })));
    },
  };
}

function outboxRecord(params: Partial<LocalOutboxRecord> & { id: string; sourceType: LocalOutboxScopeType }): LocalOutboxRecord {
  return {
    id: params.id,
    sourceType: params.sourceType,
    sourceId: params.sourceId || params.id,
    scopeType: params.scopeType || params.sourceType,
    kind: params.kind || 'patch',
    targetId: params.targetId || params.id,
    targetIds: params.targetIds || [params.targetId || params.id],
    status: params.status || 'pending',
    createdAt: params.createdAt || 1,
    attemptCount: params.attemptCount || 0,
    lastError: params.lastError ?? null,
    retryAt: params.retryAt || 0,
    lockedAt: params.lockedAt || 0,
    priority: params.priority || 10,
    updatedAt: params.updatedAt || 1,
    payload: params.payload,
  };
}

describe('localOutboxDb', () => {
  it('sanitizes persisted records before they enter the outbox', () => {
    expect(sanitizeLocalOutboxRecord({
      id: 'op-1',
      scopeType: 'chat',
      status: 'pending',
      kind: 'patch',
      targetId: 'chat-1',
      targetLabel: '离线聊天',
    })).toMatchObject({
      id: 'op-1',
      scopeType: 'chat',
      sourceType: 'chat',
      status: 'pending',
      targetIds: ['chat-1'],
      targetLabel: '离线聊天',
    });

    expect(sanitizeLocalOutboxRecord({ id: 'bad', scopeType: 'chat', status: 'done' })).toBeNull();
  });

  it('replaces one source queue without deleting other sources for the same storage key', async () => {
    const repository = createLocalOutboxRepository(createMemoryAdapter());
    await repository.upsertMany('user-1', [
      outboxRecord({ id: 'chat-1', sourceType: 'chat', priority: 80 }),
      outboxRecord({ id: 'message-1', sourceType: 'message', priority: 100 }),
    ]);

    await repository.replaceSource('user-1', 'chat', [
      outboxRecord({ id: 'chat-2', sourceType: 'chat', priority: 10 }),
    ]);

    expect((await repository.list('user-1')).map((item) => item.id)).toEqual(['message-1', 'chat-2']);
  });

  it('removes selected records by id inside the current storage key', async () => {
    const repository = createLocalOutboxRepository(createMemoryAdapter());
    await repository.upsertMany('user-1', [
      outboxRecord({ id: 'chat-1', sourceType: 'chat' }),
      outboxRecord({ id: 'chat-2', sourceType: 'chat' }),
    ]);
    await repository.upsertMany('user-2', [
      outboxRecord({ id: 'chat-1', sourceType: 'chat' }),
    ]);

    await repository.remove('user-1', ['chat-1']);

    expect((await repository.list('user-1')).map((item) => item.id)).toEqual(['chat-2']);
    expect((await repository.list('user-2')).map((item) => item.id)).toEqual(['chat-1']);
  });

  it('clears all records for one storage key only', async () => {
    const repository = createLocalOutboxRepository(createMemoryAdapter());
    await repository.upsertMany('user-1', [
      outboxRecord({ id: 'chat-1', sourceType: 'chat' }),
      outboxRecord({ id: 'message-1', sourceType: 'message' }),
    ]);
    await repository.upsertMany('user-2', [
      outboxRecord({ id: 'chat-1', sourceType: 'chat' }),
    ]);

    await repository.clear('user-1');

    expect(await repository.list('user-1')).toEqual([]);
    expect((await repository.list('user-2')).map((item) => item.id)).toEqual(['chat-1']);
  });

  it('selects the highest priority due pending record', () => {
    const records = [
      outboxRecord({ id: 'future', sourceType: 'chat', retryAt: 2_000, priority: 100 }),
      outboxRecord({ id: 'failed', sourceType: 'message', status: 'failed', priority: 200 }),
      outboxRecord({ id: 'low', sourceType: 'chat', retryAt: 0, priority: 10 }),
      outboxRecord({ id: 'high', sourceType: 'message', retryAt: 0, priority: 100 }),
    ];

    expect(selectDueLocalOutboxRecord(records, 1_000)?.id).toBe('high');
    expect(selectDueLocalOutboxRecord(records, 1_000, 'chat')?.id).toBe('low');
  });

  it('marks a persisted record status without losing payload or source metadata', async () => {
    const repository = createLocalOutboxRepository(createMemoryAdapter());
    await repository.upsertMany('user-1', [
      outboxRecord({
        id: 'message-1',
        sourceType: 'message',
        priority: 100,
        payload: { content: 'hello' },
      }),
    ]);

    const syncing = await repository.markStatus('user-1', 'message-1', {
      status: 'syncing',
      lockedAt: 1_500,
      updatedAt: 1_500,
    });

    expect(syncing).toMatchObject({
      id: 'message-1',
      sourceType: 'message',
      status: 'syncing',
      lockedAt: 1_500,
      payload: { content: 'hello' },
    });
    expect(await repository.selectDue('user-1', { now: 2_000 })).toBeNull();

    await repository.markStatus('user-1', 'message-1', {
      status: 'pending',
      attemptCount: 1,
      lastError: 'network: offline',
      retryAt: 3_000,
      lockedAt: 0,
      updatedAt: 2_000,
    });

    expect(await repository.selectDue('user-1', { now: 2_500 })).toBeNull();
    expect((await repository.selectDue('user-1', { now: 3_001 }))?.id).toBe('message-1');
  });
});
