import { beforeAll, describe, expect, it, vi } from 'vitest';

const localStore = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: (key: string) => localStore.get(key) ?? null,
  setItem: (key: string, value: string) => { localStore.set(key, value); },
  removeItem: (key: string) => { localStore.delete(key); },
  clear: () => { localStore.clear(); },
  key: (index: number) => Array.from(localStore.keys())[index] ?? null,
  get length() { return localStore.size; },
});

let helpers: Awaited<typeof import('./storeSyncHelpers')>;

beforeAll(async () => {
  helpers = await import('./storeSyncHelpers');
});

describe('storeSyncHelpers', () => {
  it('tracks persistent retry and lock metadata for pending operations', () => {
    const operation = {
      id: 'op-1',
      status: 'pending' as const,
      attemptCount: 0,
      retryAt: 0,
      lockedAt: 0,
    };

    expect(helpers.isOperationDue(operation)).toBe(true);

    const locked = helpers.markOperationLocked(operation, 1_100);
    expect(locked.lockedAt).toBe(1_100);

    const retryAt = helpers.nextRetryAt(1, [500, 1_000], 1_200);
    const retry = helpers.markOperationRetry(locked, 'server_unavailable: 502', retryAt);
    expect(retry.status).toBe('pending');
    expect(retry.attemptCount).toBe(1);
    expect(retry.retryAt).toBe(2_200);
    expect(retry.lockedAt).toBe(0);
    expect(helpers.isOperationDue(retry, 2_199)).toBe(false);
    expect(helpers.isOperationDue(retry, 2_200)).toBe(true);

    const recovered = helpers.recoverInterruptedOperations([{ ...retry, status: 'syncing' as const, lockedAt: 1_500 }])[0];
    expect(recovered.status).toBe('pending');
    expect(recovered.lockedAt).toBe(0);
    expect(recovered.lastError).toBe('server_unavailable: 502');
  });

  it('requeues failed operations for explicit user retry', () => {
    const operations = [
      { id: 'failed', status: 'failed' as const, attemptCount: 2, retryAt: 9_999, lockedAt: 123, lastError: 'validation: bad' },
      { id: 'pending', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0 },
    ];

    const retried = helpers.retryFailedOperations(operations);

    expect(retried).not.toBe(operations);
    expect(retried[0]).toMatchObject({
      id: 'failed',
      status: 'pending',
      retryAt: 0,
      lockedAt: 0,
      lastError: undefined,
    });
    expect(retried[1]).toBe(operations[1]);

    expect(helpers.retryFailedOperations(operations, { includeTerminal: false })).toBe(operations);

    const noFailed = [operations[1]];
    expect(helpers.retryFailedOperations(noFailed)).toBe(noFailed);
  });

  it('parses persisted sync error classifications without changing the stored string format', () => {
    expect(helpers.parseSyncErrorClassification('server_unavailable: 502')).toMatchObject({
      kind: 'server_unavailable',
      message: '502',
      retryable: true,
      terminal: false,
    });
    expect(helpers.parseSyncErrorClassification('validation: bad payload')).toMatchObject({
      kind: 'validation',
      message: 'bad payload',
      retryable: false,
      terminal: true,
    });
    expect(helpers.parseSyncErrorClassification('old unclassified error')).toMatchObject({
      kind: 'unknown',
      message: 'old unclassified error',
      retryable: false,
      terminal: false,
    });
    expect(helpers.isTerminalSyncError('validation: bad payload')).toBe(true);
    expect(helpers.isTerminalSyncError('server_unavailable: 502')).toBe(false);
  });

  it('treats chat create dependency waits as retryable sync work', () => {
    const classified = helpers.classifySyncError(new Error('chat:create pending: 对应会话尚未完成云端创建，消息稍后重试。'));
    expect(classified).toMatch(/^network:/);
    expect(helpers.parseSyncErrorClassification(classified)).toMatchObject({
      retryable: true,
      terminal: false,
    });
  });

  it('runs due operations through the shared worker executor', async () => {
    const operations = [{
      id: 'op-1',
      status: 'pending' as const,
      attemptCount: 0,
      retryAt: 0,
      lockedAt: 0,
    }];
    const events: string[] = [];

    const result = await helpers.runDueOperation({
      getOperations: () => operations,
      canRun: () => true,
      retryDelays: [500],
      now: () => 1_000,
      markSyncing: (_operation, lockedOperation) => {
        events.push(`lock:${lockedOperation.status}:${lockedOperation.lockedAt}`);
        operations[0] = lockedOperation;
      },
      execute: async () => {
        events.push('execute');
      },
      onSuccess: (operation) => {
        events.push(`success:${operation.id}`);
      },
      onFailure: () => {
        events.push('failure');
      },
    });

    expect(result).toMatchObject({ ran: true, status: 'success' });
    expect(events).toEqual(['lock:syncing:1000', 'execute', 'success:op-1']);
  });

  it('selects due operations by explicit priority when provided', () => {
    const operations = [
      { id: 'later', status: 'pending' as const, attemptCount: 0, retryAt: 2_000 },
      { id: 'low', status: 'pending' as const, attemptCount: 0, retryAt: 0, priority: 1 },
      { id: 'high', status: 'pending' as const, attemptCount: 0, retryAt: 0, priority: 10 },
      { id: 'syncing', status: 'syncing' as const, attemptCount: 0, retryAt: 0, priority: 100 },
    ];

    expect(helpers.selectDueOperation(operations, 1_000)?.id).toBe('low');
    expect(helpers.selectDueOperation(operations, 1_000, (operation) => operation.priority ?? 0)?.id).toBe('high');
    expect(helpers.selectDueOperation(operations, 1_999, (operation) => operation.priority ?? 0)?.id).toBe('high');
    expect(helpers.selectDueOperation(operations, 2_000, (operation) => operation.id === 'later' ? 20 : operation.priority ?? 0)?.id).toBe('later');
  });

  it('raises worker priority by the highest due operation priority only', () => {
    const operations = [
      { id: 'later', status: 'pending' as const, attemptCount: 0, retryAt: 2_000, priority: 100 },
      { id: 'low', status: 'pending' as const, attemptCount: 0, retryAt: 0, priority: 10 },
      { id: 'high', status: 'pending' as const, attemptCount: 0, retryAt: 0, priority: 80 },
      { id: 'syncing', status: 'syncing' as const, attemptCount: 0, retryAt: 0, priority: 200 },
    ];

    expect(helpers.getPendingQueueWorkerPriority(operations, 70, (operation) => operation.priority, 1_000)).toBe(150);
    expect(helpers.getPendingQueueWorkerPriority(operations, 70, (operation) => operation.priority, 1_999)).toBe(150);
    expect(helpers.getPendingQueueWorkerPriority(operations, 70, (operation) => operation.priority, 2_000)).toBe(170);
    expect(helpers.getPendingQueueWorkerPriority([], 70, (operation: { priority: number }) => operation.priority, 2_000)).toBe(70);
  });

  it('classifies failures and returns a retry operation from the shared worker executor', async () => {
    const operations = [{
      id: 'op-1',
      status: 'pending' as const,
      attemptCount: 0,
      retryAt: 0,
      lockedAt: 0,
    }];
    let retryOperation: typeof operations[number] | null = null;

    const result = await helpers.runDueOperation({
      getOperations: () => operations,
      canRun: () => true,
      retryDelays: [500],
      now: () => 1_000,
      markSyncing: (_operation, lockedOperation) => {
        operations[0] = lockedOperation;
      },
      execute: async () => {
        throw new Error('502');
      },
      onSuccess: () => {},
      onFailure: (_operation, _error, retry) => {
        retryOperation = retry.retryOperation;
      },
    });

    expect(result).toMatchObject({ ran: true, status: 'failure', classified: 'server_unavailable: 502' });
    expect(retryOperation).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      retryAt: expect.any(Number),
      lockedAt: 0,
      lastError: 'server_unavailable: 502',
    });
  });

  it('wraps queue locking, success scheduling, and retry scheduling', async () => {
    const operations = [{
      id: 'op-1',
      status: 'pending' as const,
      attemptCount: 0,
      retryAt: 0,
      lockedAt: 0,
    }];
    const scheduled: number[] = [];
    const events: string[] = [];

    await helpers.runPendingOperationQueue({
      getOperations: () => operations,
      canRun: () => true,
      retryDelays: [500],
      now: () => 1_000,
      updateOperation: (_operationId, operation) => {
        operations[0] = operation;
        events.push(`update:${operation.status}:${operation.lockedAt}`);
      },
      execute: async () => {
        events.push('execute');
      },
      onSuccess: (operation) => {
        events.push(`success:${operation.id}`);
      },
      scheduleNext: (delay) => {
        scheduled.push(delay);
      },
    });

    expect(events).toEqual(['update:syncing:1000', 'execute', 'success:op-1']);
    expect(scheduled).toEqual([50]);

    operations[0] = {
      id: 'op-2',
      status: 'pending',
      attemptCount: 0,
      retryAt: 0,
      lockedAt: 0,
    };
    scheduled.length = 0;

    await helpers.runPendingOperationQueue({
      getOperations: () => operations,
      canRun: () => true,
      retryDelays: [500],
      now: () => 1_000,
      updateOperation: (_operationId, operation) => {
        operations[0] = operation;
      },
      execute: async () => {
        throw new Error('502');
      },
      onSuccess: () => {},
      scheduleNext: (delay) => {
        scheduled.push(delay);
      },
    });

    expect(operations[0]).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      lastError: 'server_unavailable: 502',
      lockedAt: 0,
    });
    expect(scheduled).toEqual([500]);
  });

  it('passes priority selection through the queue wrapper', async () => {
    const operations = [
      { id: 'low', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0, priority: 1 },
      { id: 'high', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0, priority: 10 },
    ];
    const events: string[] = [];

    await helpers.runPendingOperationQueue({
      getOperations: () => operations,
      canRun: () => true,
      retryDelays: [500],
      priority: (operation) => operation.priority,
      updateOperation: (operationId, operation) => {
        events.push(`update:${operationId}:${operation.status}`);
      },
      execute: async (operation) => {
        events.push(`execute:${operation.id}`);
      },
      onSuccess: (operation) => {
        events.push(`success:${operation.id}`);
      },
    });

    expect(events).toEqual(['update:high:syncing', 'execute:high', 'success:high']);
  });

  it('claims multiple due operations in one queue run without per-item timer churn', async () => {
    let operations = [
      { id: 'low', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0, priority: 1 },
      { id: 'high', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0, priority: 10 },
      { id: 'mid', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0, priority: 5 },
      { id: 'later', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0, priority: 4 },
    ];
    const events: string[] = [];
    const scheduled: number[] = [];

    const result = await helpers.runPendingOperationQueue({
      getOperations: () => operations,
      canRun: () => true,
      retryDelays: [500],
      priority: (operation) => operation.priority,
      batchSize: 3,
      updateOperation: (operationId, operation) => {
        operations = operations.map((item) => item.id === operationId ? operation : item);
        events.push(`update:${operationId}:${operation.status}`);
      },
      execute: async (operation) => {
        events.push(`execute:${operation.id}`);
      },
      onSuccess: (operation) => {
        events.push(`success:${operation.id}`);
        operations = operations.filter((item) => item.id !== operation.id);
      },
      scheduleNext: (delay) => {
        scheduled.push(delay);
      },
    });

    expect(result).toMatchObject({ ran: true, processed: 3 });
    expect(events).toEqual([
      'update:high:syncing',
      'execute:high',
      'success:high',
      'update:mid:syncing',
      'execute:mid',
      'success:mid',
      'update:later:syncing',
      'execute:later',
      'success:later',
    ]);
    expect(operations.map((operation) => operation.id)).toEqual(['low']);
    expect(scheduled).toEqual([0]);
  });

  it('stops a batch on first retryable failure', async () => {
    let operations = [
      { id: 'first', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0 },
      { id: 'second', status: 'pending' as const, attemptCount: 0, retryAt: 0, lockedAt: 0 },
    ];
    const executed: string[] = [];
    const scheduled: number[] = [];

    const result = await helpers.runPendingOperationQueue({
      getOperations: () => operations,
      canRun: () => true,
      retryDelays: [500],
      now: () => 1_000,
      batchSize: 3,
      updateOperation: (operationId, operation) => {
        operations = operations.map((item) => item.id === operationId ? operation : item);
      },
      execute: async (operation) => {
        executed.push(operation.id);
        throw new Error('502');
      },
      onSuccess: () => {},
      scheduleNext: (delay) => {
        scheduled.push(delay);
      },
    });

    expect(result).toMatchObject({ ran: true, processed: 1 });
    expect(executed).toEqual(['first']);
    expect(operations[0]).toMatchObject({
      id: 'first',
      status: 'pending',
      attemptCount: 1,
      lastError: 'server_unavailable: 502',
      retryAt: 1_500,
    });
    expect(operations[1]).toMatchObject({ id: 'second', status: 'pending', attemptCount: 0 });
    expect(scheduled).toEqual([500]);
  });
});
