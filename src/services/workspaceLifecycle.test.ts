import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageKey } from '../constants/brand';
import { api } from './api';
import { getLocalDataUserId } from './authStorageScope';
import { createReplyOperation } from './replyOperation';
import { adoptWorkspaceSession, getWorkspaceSignal, initializeWorkspaceLifecycle, isWorkspaceActive, stopWorkspace, workspaceFetch } from './workspaceLifecycle';
import { AUTH_SNAPSHOT_KEY, readAuthSnapshot } from './authSnapshot';
import { createScopedBufferedJsonStorage, flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { createSettingsStorage, getSettingsStorageKey, SETTINGS_STORAGE_NAME } from '../stores/settingsStorage';
import { enqueueChatCompletionTask, getChatCompletionSummary } from './chatCompletionQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function publishWorkspaceLogout() {
  localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({ ...readAuthSnapshot(), generation: crypto.randomUUID() }));
}

describe('workspace account boundaries', () => {
  let dispose: () => void;
  let navigate: ReturnType<typeof vi.fn>;

  function loginAs(id: string) {
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({
      version: 1, generation: crypto.randomUUID(), mode: 'cloud', user: { id },
      token: `token-${id}`, refreshToken: `refresh-${id}`,
    }));
  }

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    loginAs('a');
    navigate = vi.fn();
    dispose = initializeWorkspaceLifecycle(navigate);
  });

  afterEach(() => {
    stopWorkspace();
    flushBufferedPersistenceWrites();
    dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('aborts active replies and fetches on another tab logout, navigating once', async () => {
    const operation = createReplyOperation();
    const reply = operation.begin();
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_input, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    const request = workspaceFetch('/api/ai');
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    localStorage.removeItem(storageKey('token'));
    publishWorkspaceLogout();
    window.dispatchEvent(Object.assign(new Event('storage'), { key: storageKey('workspace-generation') }));
    window.dispatchEvent(new Event('focus'));
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(reply.controller.signal.aborted).toBe(true);
    expect(operation.getSnapshot()).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('blocks requests and cache writes before the storage event arrives', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const storage = createScopedBufferedJsonStorage<{ account: string }>({
      storageName: 'cache', getScopedKey: () => `cache-${getLocalDataUserId()}`, flushDelayMs: 10_000,
    });
    storage.setItem('cache', { state: { account: 'a' } });
    loginAs('b');
    storage.setItem('cache', { state: { account: 'wrong' } });
    await expect(api.fetchWithAuth('/api/settings', { method: 'PUT', body: 'old-data' })).rejects.toMatchObject({ name: 'AbortError' });
    flushBufferedPersistenceWrites();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getLocalDataUserId()).toBe('a');
    expect(localStorage.getItem('cache-b')).toBeNull();
    expect(JSON.parse(localStorage.getItem('cache-a')!)).toMatchObject({ state: { account: 'a' } });
  });

  it('allows access token rotation but retires a logout and relogin to the same account', () => {
    const signal = getWorkspaceSignal();
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({ ...readAuthSnapshot(), token: 'renewed' }));
    expect(isWorkspaceActive()).toBe(true);
    expect(signal.aborted).toBe(false);
    publishWorkspaceLogout();
    loginAs('a');
    expect(isWorkspaceActive()).toBe(false);
    expect(signal.aborted).toBe(true);
  });

  it('does not retry a late 401 using the other account token', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const request = api.fetchWithAuth('/api/settings', { method: 'PUT', body: 'a-data' });
    loginAs('b');
    response.resolve(json({}, 401));
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never lets a late refresh response replace the new account credentials', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 401)).mockReturnValueOnce(response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const request = api.getMe();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    loginAs('b');
    response.resolve(json({ token: 'late-a', refreshToken: 'late-a-refresh', user: { id: 'a' } }));
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(readAuthSnapshot()).toMatchObject({ token: 'token-b', refreshToken: 'refresh-b' });
  });

  it('rejects a JSON body that finishes after logout', async () => {
    const body = deferred<unknown>();
    const response = json({});
    const read = vi.spyOn(response, 'json').mockReturnValue(body.promise);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const request = api.getMe();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    stopWorkspace();
    body.resolve({ id: 'a' });
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('drops queued completions when the running supplier ignores cancellation', async () => {
    const running = deferred<void>();
    const next = vi.fn();
    const input = { kind: 'text' as const, chatId: 'chat', chatName: 'chat', field: 'topic', label: 'topic' };
    enqueueChatCompletionTask({ ...input, run: () => running.promise });
    enqueueChatCompletionTask({ ...input, run: next });
    stopWorkspace();
    running.resolve();
    await running.promise;
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    expect(getChatCompletionSummary().text.total).toBe(0);
  });

  it('migrates legacy settings once and isolates keys and stats from the next account', () => {
    const legacy = JSON.stringify({ state: { api: { apiKey: 'a-key' }, usageStats: { count: 7 } } });
    localStorage.setItem(SETTINGS_STORAGE_NAME, legacy);
    const storage = createSettingsStorage();
    expect(storage.getItem(SETTINGS_STORAGE_NAME)).toBe(legacy);
    loginAs('b');
    adoptWorkspaceSession();
    expect(storage.getItem(SETTINGS_STORAGE_NAME)).toBeNull();
    storage.setItem(SETTINGS_STORAGE_NAME, 'b-settings');
    expect(localStorage.getItem(getSettingsStorageKey())).toBe('b-settings');
    expect(localStorage.getItem(SETTINGS_STORAGE_NAME)).toBe(legacy);
    loginAs('a');
    adoptWorkspaceSession();
    expect(storage.getItem(SETTINGS_STORAGE_NAME)).toBe(legacy);
  });
});
