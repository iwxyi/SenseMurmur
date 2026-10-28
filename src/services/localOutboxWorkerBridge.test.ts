import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageKey } from '../constants/brand';

describe('localOutboxWorkerBridge history', () => {
  beforeEach(() => {
    vi.resetModules();
    const values = new Map<string, string>();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
    vi.stubGlobal('window', new EventTarget());
    localStorage.setItem(storageKey('auth-mode'), 'local');
  });

  afterEach(() => vi.unstubAllGlobals());

  const operation = {
    id: 'completed-edit', kind: 'patch', entityId: 'chat-1', targetLabel: '已完成的聊天',
    clientTimestamp: 100, status: 'syncing', attemptCount: 1, patch: { topic: 'private content' },
  };

  it('keeps successful history after the live queue is replaced and its row removed', async () => {
    const bridge = await import('./localOutboxWorkerBridge');
    const mirror = await import('./localOutboxMirror');
    const changed = vi.fn();
    window.addEventListener(bridge.LOCAL_OUTBOX_HISTORY_CHANGED_EVENT, changed);
    await bridge.mirrorLocalOutboxWorkerQueue('chat', [operation]);
    await mirror.mirrorLocalOutboxQueues({});
    await bridge.completeLocalOutboxWorkerOperation('chat', operation, 'saved-item-1');
    bridge.removeLocalOutboxWorkerOperation(operation.id);
    await mirror.mirrorLocalOutboxQueues({});

    const history = await bridge.listLocalOutboxHistory();
    expect(history).toMatchObject({ total: 1, succeededTotal: 1, failedTotal: 0 });
    expect(history.items[0]).toMatchObject({ id: operation.id, targetLabel: operation.targetLabel, resultId: 'saved-item-1', status: 'succeeded' });
    expect(history.items[0].payload).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1);
    await bridge.completeLocalOutboxWorkerOperation('chat', operation, 'saved-item-1');
    expect((await bridge.listLocalOutboxHistory()).total).toBe(1);
  });

  it('clears completed history without deleting pending work, and it stays cleared after mirroring', async () => {
    const bridge = await import('./localOutboxWorkerBridge');
    const mirror = await import('./localOutboxMirror');
    const { localOutboxRepository } = await import('./localOutboxDb');
    const pending = { ...operation, id: 'pending-edit', status: 'pending' };
    await bridge.completeLocalOutboxWorkerOperation('chat', operation);
    await bridge.mirrorLocalOutboxWorkerQueue('chat', [pending]);

    await bridge.clearLocalOutboxHistory();
    await bridge.mirrorLocalOutboxWorkerQueue('chat', [pending]);

    expect((await bridge.listLocalOutboxHistory()).total).toBe(0);
    expect(await localOutboxRepository.list(mirror.localOutboxStorageKey())).toEqual([expect.objectContaining({ id: pending.id, status: 'pending' })]);
  });

  it('isolates completed history between accounts', async () => {
    const bridge = await import('./localOutboxWorkerBridge');
    localStorage.setItem(storageKey('user'), JSON.stringify({ id: 'account-a' }));
    await bridge.completeLocalOutboxWorkerOperation('chat', operation);
    localStorage.setItem(storageKey('user'), JSON.stringify({ id: 'account-b' }));
    expect((await bridge.listLocalOutboxHistory()).total).toBe(0);
    localStorage.setItem(storageKey('user'), JSON.stringify({ id: 'account-a' }));
    expect((await bridge.listLocalOutboxHistory()).succeededTotal).toBe(1);
  });
});
