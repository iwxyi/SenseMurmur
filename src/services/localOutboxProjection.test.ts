import { describe, expect, it } from 'vitest';
import { buildLocalOutboxProjection, projectLocalOutboxRecords, summarizeLocalOutbox } from './localOutboxProjection';

describe('localOutboxProjection', () => {
  it('preserves names independently of the current entity cache', () => {
    const items = buildLocalOutboxProjection({
      chatOperations: [{ id: 'chat-edit', entityId: 'chat-1', targetLabel: '离线聊天', patch: { topic: '更新' }, status: 'failed' }],
      messageOperations: [{ id: 'message-create', chatId: 'chat-1', targetLabel: '离线聊天', status: 'pending' }],
      characterOperations: [{ id: 'character-rename', entityId: 'character-1', patch: { name: '角色新名称' }, status: 'pending' }],
    });
    expect(items.find((item) => item.id === 'chat-edit')?.targetLabel).toBe('离线聊天');
    expect(items.find((item) => item.id === 'message-create')?.targetLabel).toBe('离线聊天');
    expect(items.find((item) => item.id === 'character-rename')?.targetLabel).toBe('角色新名称');
  });
  it('normalizes character, chat, message, and artifact queues into one local outbox view', () => {
    const items = buildLocalOutboxProjection({
      characterOperations: [{
        id: 'character-patch-1',
        kind: 'patch',
        entityId: 'character-1',
        targetIds: ['character-1'],
        clientTimestamp: 100,
        patch: { name: '新名字' },
        status: 'pending',
        attemptCount: 1,
      }],
      chatOperations: [{
        id: 'chat-delete-1',
        kind: 'patch',
        entityId: 'chat-1',
        targetIds: ['chat-1'],
        clientTimestamp: 200,
        patch: { deletedAt: 200 },
        status: 'failed',
        attemptCount: 2,
        lastError: 'server_unavailable: 502',
      }],
      messageOperations: [{
        id: 'message-create-1',
        kind: 'create',
        chatId: 'chat-1',
        localMessageId: 'local-message-1',
        createdAt: 300,
        status: 'syncing',
        attemptCount: 0,
      }],
      artifactJobs: [{
        id: 'diary-job-1',
        kind: 'diary',
        characterId: 'character-1',
        dateKey: '2026-06-08',
        status: 'running',
        attempts: 1,
        createdAt: 400,
      }],
    });

    expect(items.map((item) => [item.scopeType, item.status, item.priority])).toEqual([
      ['message', 'syncing', 100],
      ['artifact', 'syncing', 90],
      ['chat', 'failed', 80],
      ['character', 'pending', 10],
    ]);
    expect(items.find((item) => item.id === 'chat-delete-1')).toMatchObject({
      targetId: 'chat-1',
      attemptCount: 2,
      lastError: 'server_unavailable: 502',
      summaryKey: 'deletedAt',
    });
  });

  it('summarizes upload status from the normalized outbox', () => {
    const items = buildLocalOutboxProjection({
      characterOperations: [
        { id: 'a', entityId: 'c1', status: 'pending', clientTimestamp: 1, attemptCount: 0 },
        { id: 'b', entityId: 'c2', status: 'failed', clientTimestamp: 2, attemptCount: 1 },
      ],
      messageOperations: [
        { id: 'c', chatId: 'chat-1', status: 'syncing', createdAt: 3, attemptCount: 0 },
      ],
    });

    expect(summarizeLocalOutbox(items)).toEqual({
      uploading: 1,
      pendingUpload: 1,
      failedUpload: 1,
    });
  });

  it('projects already persisted outbox records without depending on store-specific fields', () => {
    expect(projectLocalOutboxRecords([
      {
        id: 'low',
        scopeType: 'chat',
        kind: 'patch',
        targetId: 'chat-1',
        targetIds: ['chat-1'],
        status: 'pending',
        createdAt: 10,
        attemptCount: 0,
        lastError: null,
        retryAt: 0,
        lockedAt: 0,
        priority: 10,
      },
      {
        id: 'high',
        scopeType: 'message',
        kind: 'create',
        targetId: 'message-1',
        targetIds: ['message-1'],
        status: 'pending',
        createdAt: 1,
        attemptCount: 0,
        lastError: null,
        retryAt: 0,
        lockedAt: 0,
        priority: 100,
      },
    ]).map((item) => item.id)).toEqual(['high', 'low']);
  });
});
