import { describe, expect, it } from 'vitest';
import { clearResolvedFieldConflicts, detectPendingFieldConflicts, removePendingConflictField } from './syncConflictRecords';

describe('syncConflictRecords', () => {
  it('records remote field updates that collide with local pending fields', () => {
    const conflicts = detectPendingFieldConflicts({
      entityType: 'chat',
      now: 300,
      localEntities: [{ id: 'chat-1', name: '本地标题', updatedAt: 200 }],
      remoteEntities: [{ id: 'chat-1', name: '云端标题', updatedAt: 250 }],
      pendingOperations: [{
        id: 'op-1',
        entityId: 'chat-1',
        clientTimestamp: 200,
        patch: { name: '本地标题' },
        status: 'pending',
        attemptCount: 0,
      }],
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      id: 'chat:chat-1:name',
      field: 'name',
      localValue: '本地标题',
      remoteValue: '云端标题',
      localOperationIds: ['op-1'],
    });
  });

  it('does not record conflicts for equal values or metadata-only fields', () => {
    const conflicts = detectPendingFieldConflicts({
      entityType: 'character',
      localEntities: [{ id: 'character-1', name: '小甲', updatedAt: 200 }],
      remoteEntities: [{ id: 'character-1', name: '小甲', updatedAt: 250 }],
      pendingOperations: [{
        id: 'op-1',
        entityId: 'character-1',
        clientTimestamp: 200,
        patch: { name: '小甲', updatedAt: 200 },
        status: 'pending',
        attemptCount: 0,
      }],
    });

    expect(conflicts).toEqual([]);
  });

  it('does not report an older cloud field as a concurrent local update', () => {
    const pendingOperations = [{ id: 'op-1', entityId: 'chat-1', clientTimestamp: 300, patch: { runtimeEventsV2: [{ id: 'event' }] }, status: 'pending' as const, attemptCount: 0 }];
    const params = {
      entityType: 'chat' as const,
      localEntities: [{ id: 'chat-1', runtimeEventsV2: [{ id: 'event' }], updatedAt: 300 }],
      remoteEntities: [{ id: 'chat-1', runtimeEventsV2: [], updatedAt: 200, fieldVersions: { runtimeEventsV2: 100 } }],
      pendingOperations,
    };
    const stale = [{ id: 'chat:chat-1:runtimeEventsV2', entityType: 'chat' as const, entityId: 'chat-1', field: 'runtimeEventsV2', localValue: [], remoteValue: [], localOperationIds: ['op-1'], localUpdatedAt: 300, remoteUpdatedAt: 200, detectedAt: 350 }];
    expect(detectPendingFieldConflicts({ ...params, existingConflicts: stale })).toEqual([]);
  });

  it('retains a detail-field conflict when a summary refresh omits that field', () => {
    const record = { id: 'chat:chat-1:runtimeEventsV2', entityType: 'chat' as const, entityId: 'chat-1', field: 'runtimeEventsV2', localValue: [{ id: 'a' }], remoteValue: [], localOperationIds: ['op-1'], localUpdatedAt: 200, remoteUpdatedAt: 300, detectedAt: 310 };
    const conflicts = detectPendingFieldConflicts({
      entityType: 'chat',
      localEntities: [{ id: 'chat-1', name: '本地', runtimeEventsV2: [{ id: 'a' }] }],
      remoteEntities: [{ id: 'chat-1', name: '本地', updatedAt: 350 }],
      pendingOperations: [{ id: 'op-1', entityId: 'chat-1', clientTimestamp: 200, patch: { runtimeEventsV2: [{ id: 'a' }] }, status: 'pending', attemptCount: 0 }],
      existingConflicts: [record],
    });
    expect(conflicts).toEqual([record]);
  });

  it('clears conflicts by entity or operation id', () => {
    const records = detectPendingFieldConflicts({
      entityType: 'chat',
      localEntities: [{ id: 'chat-1', name: '本地标题' }],
      remoteEntities: [{ id: 'chat-1', name: '云端标题' }],
      pendingOperations: [{
        id: 'op-1',
        entityId: 'chat-1',
        clientTimestamp: 200,
        patch: { name: '本地标题' },
        status: 'pending',
        attemptCount: 0,
      }],
    });

    expect(clearResolvedFieldConflicts(records, { entityType: 'chat', operationIds: ['op-1'] })).toEqual([]);
  });

  it('compacts large conflict values instead of storing full payloads', () => {
    const conflicts = detectPendingFieldConflicts({
      entityType: 'chat',
      localEntities: [{
        id: 'chat-1',
        runtimeEventsV2: [{
          payload: {
            media: [{ url: `data:image/png;base64,${'a'.repeat(500)}` }],
            text: '本地'.repeat(200),
          },
        }],
      }],
      remoteEntities: [{
        id: 'chat-1',
        updatedAt: 300,
        runtimeEventsV2: [{
          payload: {
            media: [{ url: `data:image/png;base64,${'b'.repeat(500)}` }],
            text: '云端'.repeat(200),
          },
        }],
      }],
      pendingOperations: [{
        id: 'op-1',
        entityId: 'chat-1',
        clientTimestamp: 200,
        patch: { runtimeEventsV2: [] },
        status: 'pending',
        attemptCount: 0,
      }],
    });

    const serialized = JSON.stringify(conflicts[0]);
    expect(serialized.length).toBeLessThan(800);
    expect(serialized).not.toContain('a'.repeat(100));
    expect(serialized).not.toContain('b'.repeat(100));
  });

  it('removes only the chosen field from a pending patch', () => {
    const operations = [{ id: 'op-1', entityId: 'chat-1', clientTimestamp: 200, patch: { name: '本地', topic: '保留' }, status: 'pending' as const, attemptCount: 0 }];
    expect(removePendingConflictField(operations, 'chat-1', 'name')).toEqual([{ ...operations[0], patch: { topic: '保留' } }]);
    expect(removePendingConflictField(operations, 'chat-1', 'topic')[0].patch).toEqual({ name: '本地' });
    expect(operations[0].patch).toEqual({ name: '本地', topic: '保留' });
  });
});
