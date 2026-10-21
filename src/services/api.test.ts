import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readAuthSnapshot } from './authSnapshot';
import { ApiError, api } from './api';
import { AUTH_SESSION_EXPIRED_EVENT } from './authSession';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return values;
}

function mockJsonFetch(body: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    headers: {
      get: (key: string) => key.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async () => body,
  });
}

describe('api sync changes', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rebuilds the current scope when a log cursor has expired', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'reset_required',
        code: 'SYNC_CURSOR_EXPIRED',
        scope: 'chats.summary',
        cursor: 'log:120',
        revision: 'log:120',
        changes: [],
        hasMore: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'modified',
        scope: 'chats.summary',
        cursor: 'log:150',
        revision: 'log:150',
        changes: [{ op: 'delete', entity: 'chat_summary', id: 'chat-1', revision: 150 }],
        hasMore: false,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getSyncChanges({ scope: 'chats.summary', since: 'log:1' });

    expect(result.status).toBe('modified');
    expect(result.cursor).toBe('log:150');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sync/changes?scope=chats.summary&since=log%3A1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/sync/changes?scope=chats.summary');
  });

  it('does not retry ordinary sync responses', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      status: 'not_modified',
      scope: 'characters.summary',
      cursor: 'log:10',
      revision: 'log:10',
      changes: [],
      hasMore: false,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getSyncChanges({ scope: 'characters.summary', since: 'log:10' });

    expect(result.status).toBe('not_modified');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sync/changes?scope=characters.summary&since=log%3A10');
  });

  it('dispatches a session expired event when an authenticated request returns 401', async () => {
    installLocalStorage({
      'pneumata-auth-mode': 'cloud',
      'pneumata-token': 'token-1',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: '登录已过期，请重新登录',
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('CustomEvent', class<T = unknown> extends Event {
      detail: T;
      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    });
    const eventTarget = new EventTarget();
    Object.defineProperty(eventTarget, 'location', {
      value: { pathname: '/chats/1', search: '?tab=0', hash: '' },
    });
    vi.stubGlobal('window', eventTarget);
    const events: unknown[] = [];
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, (event) => events.push((event as CustomEvent).detail));

    await expect(api.getMe()).rejects.toBeInstanceOf(ApiError);

    expect(events).toEqual([
      expect.objectContaining({ status: 401, path: '/api/auth/me', reason: 'refresh_token_missing' }),
    ]);
  });

  it('does not dispatch a session expired event for local-only requests that return 401', async () => {
    installLocalStorage({
      'pneumata-auth-mode': 'local',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: '需要登录',
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('CustomEvent', class<T = unknown> extends Event {
      detail: T;
      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    });
    const eventTarget = new EventTarget();
    Object.defineProperty(eventTarget, 'location', {
      value: { pathname: '/characters/create', search: '', hash: '' },
    });
    vi.stubGlobal('window', eventTarget);
    const events: unknown[] = [];
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, (event) => events.push((event as CustomEvent).detail));

    await expect(api.getMe()).rejects.toBeInstanceOf(ApiError);

    expect(events).toEqual([]);
  });

  it.each(['network', 'server', 'invalid-response'])('retains credentials when refresh has a temporary %s failure', async (failure) => {
    installLocalStorage({
      'pneumata-auth-mode': 'cloud',
      'pneumata-token': 'expired-token',
      'pneumata-refresh-token': 'refresh-token-1',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TOKEN_EXPIRED' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }));
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else if (failure === 'server') fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    else fetchMock.mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(api.getMe()).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE', status: 503 });

    expect(localStorage.getItem('pneumata-token')).toBe('expired-token');
    expect(localStorage.getItem('pneumata-refresh-token')).toBe('refresh-token-1');
    expect(warn).toHaveBeenCalledWith('[auth] session refresh unavailable; retaining login', expect.objectContaining({
      reason: failure === 'network' ? 'refresh_network_error' : failure === 'server' ? 'refresh_rejected' : 'refresh_response_invalid',
    }));
  });

  it('reports refresh rejection with its status and safe server code', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    installLocalStorage({
      'pneumata-auth-mode': 'cloud',
      'pneumata-token': 'expired-token',
      'pneumata-refresh-token': 'refresh-token-1',
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TOKEN_EXPIRED', error: 'private response text' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })));
    vi.stubGlobal('CustomEvent', class<T = unknown> extends Event {
      detail: T;
      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    });
    const target = new EventTarget();
    Object.defineProperty(target, 'location', { value: { pathname: '/', search: '', hash: '' } });
    vi.stubGlobal('window', target);
    const events: unknown[] = [];
    target.addEventListener(AUTH_SESSION_EXPIRED_EVENT, (event) => events.push((event as CustomEvent).detail));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(api.getMe()).rejects.toMatchObject({ status: 401 });
    expect(events).toEqual([expect.objectContaining({ reason: 'refresh_rejected', diagnostic: 'TOKEN_EXPIRED' })]);
    expect(JSON.stringify(events)).not.toContain('private response text');
    expect(JSON.stringify(events)).not.toContain('refresh-token-1');
  });

  it('refreshes an expired access token and retries the original request', async () => {
    installLocalStorage({
      'pneumata-auth-mode': 'cloud',
      'pneumata-token': 'expired-token',
      'pneumata-refresh-token': 'refresh-token-1',
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '登录已过期' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ token: 'token-2', refreshToken: 'refresh-token-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1', phone: '+8613800000000', nickname: '用户', avatar: '🍵' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getMe()).resolves.toMatchObject({ id: 'user-1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readAuthSnapshot()).toMatchObject({ token: 'token-2', refreshToken: 'refresh-token-2' });
    expect(localStorage.getItem('pneumata-token')).toBeNull();
    expect(localStorage.getItem('pneumata-refresh-token')).toBeNull();
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe('Bearer token-2');
  });

  it('accepts a refresh token rotated by another tab', async () => {
    installLocalStorage({
      'pneumata-auth-mode': 'cloud',
      'pneumata-token': 'expired-token',
      'pneumata-refresh-token': 'refresh-token-1',
    });
    const refreshResponse = new Response(JSON.stringify({ error: '会话已被刷新' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '登录已过期' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => {
        localStorage.setItem('pneumata-token', 'token-from-other-tab');
        localStorage.setItem('pneumata-refresh-token', 'refresh-token-from-other-tab');
        return refreshResponse;
      })
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1', phone: '+8613800000000', nickname: '用户', avatar: '🍵' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getMe()).resolves.toMatchObject({ id: 'user-1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem('pneumata-refresh-token')).toBe('refresh-token-from-other-tab');
  });
});

describe('api getAiBalance cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    installLocalStorage({ 'pneumata-token': 'token-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reuses in-flight and fresh cached balance requests per provider', async () => {
    const fetchMock = mockJsonFetch({ availableBalance: 12 });
    vi.stubGlobal('fetch', fetchMock);
    const { api: freshApi } = await import('./api');

    const [first, second] = await Promise.all([
      freshApi.getAiBalance('deepseek'),
      freshApi.getAiBalance('deepseek'),
    ]);
    const third = await freshApi.getAiBalance('deepseek');

    expect(first).toEqual({ availableBalance: 12 });
    expect(second).toEqual({ availableBalance: 12 });
    expect(third).toEqual({ availableBalance: 12 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/balance?provider=deepseek', expect.objectContaining({
      method: 'GET',
    }));
  });

  it('bypasses cached balance when force is requested', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ availableBalance: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ availableBalance: 2 }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { api: freshApi } = await import('./api');

    await expect(freshApi.getAiBalance('deepseek')).resolves.toEqual({ availableBalance: 1 });
    await expect(freshApi.getAiBalance('deepseek', { force: true })).resolves.toEqual({ availableBalance: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
