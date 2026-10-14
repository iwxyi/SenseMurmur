import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import * as authSession from './authSession';
import { generateImage, generateResponse, listAvailableModels } from './aiClient';
import { marketApi } from './marketApi';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('shared backend session renewal', () => {
  beforeEach(() => {
    const values = new Map([
      ['pneumata-auth-mode', 'cloud'],
      ['pneumata-token', 'expired-access'],
      ['pneumata-refresh-token', 'valid-refresh'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.spyOn(authSession, 'dispatchAuthSessionExpired').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const official = { provider: 'official' as const, apiKey: '', baseUrl: '/api/ai', model: 'test-model' };
  it.each([
    { name: 'market', run: () => marketApi.list(), result: { items: [] } },
    { name: 'official models', run: () => listAvailableModels(official), result: { items: [] } },
    { name: 'official chat', run: () => generateResponse(official, 'system', [{ role: 'user', content: 'hello' }]), result: { choices: [{ message: { content: 'hello' } }] } },
    { name: 'official images', run: () => generateImage(official, { prompt: 'tea' }), result: { data: [{ b64_json: 'AQID' }] } },
    { name: 'official Gemini images', run: () => generateImage({ ...official, provider: 'official-ace-nanobanana' }, { prompt: 'tea' }), result: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }] } }] } },
  ])('renews $name instead of expiring the session', async ({ run, result }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ code: 'TOKEN_EXPIRED' }, 401))
      .mockResolvedValueOnce(json({ token: 'new-access', refreshToken: 'new-refresh' }))
      .mockResolvedValueOnce(json(result));
    vi.stubGlobal('fetch', fetchMock);

    await run();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh');
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('Authorization')).toBe('Bearer new-access');
    expect(authSession.dispatchAuthSessionExpired).not.toHaveBeenCalled();
  });

  it('renews streaming chat without consuming its response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ token: 'new-access', refreshToken: 'new-refresh' }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onChunk = vi.fn();

    await expect(generateResponse(official, 'system', [{ role: 'user', content: 'hello' }], onChunk)).resolves.toBe('hello');
    expect(onChunk).toHaveBeenCalledWith('hello');
    expect(authSession.dispatchAuthSessionExpired).not.toHaveBeenCalled();
  });

  it('preserves multipart bodies and cancellation when retrying', async () => {
    const body = new FormData();
    body.append('image[]', new Blob(['image']), 'image.png');
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ token: 'new-access', refreshToken: 'new-refresh' }))
      .mockResolvedValueOnce(json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await api.fetchWithAuth('/api/ai/images/edits', { method: 'POST', body, signal: controller.signal });

    expect(fetchMock.mock.calls[2][1].body).toBe(body);
    expect(fetchMock.mock.calls[2][1].signal).toBe(controller.signal);
    expect(new Headers(fetchMock.mock.calls[2][1].headers).has('Content-Type')).toBe(false);
  });

  it('shares one refresh between concurrent requests', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      if (url === '/api/auth/refresh') {
        return json({ token: 'new-access', refreshToken: 'new-refresh' });
      }
      return new Headers(options.headers).get('Authorization') === 'Bearer new-access'
        ? json({ items: [] }) : json({}, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([marketApi.list(), listAvailableModels(official), api.getMe()]);

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/refresh')).toHaveLength(1);
    expect(authSession.dispatchAuthSessionExpired).not.toHaveBeenCalled();
  });

  it('retries a late 401 with the token already renewed by another request', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        localStorage.setItem('pneumata-token', 'new-access');
        localStorage.setItem('pneumata-refresh-token', 'new-refresh');
        return json({}, 401);
      })
      .mockResolvedValueOnce(json({ id: 'user' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getMe()).resolves.toMatchObject({ id: 'user' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('/api/auth/refresh');
    expect(authSession.dispatchAuthSessionExpired).not.toHaveBeenCalled();
  });

  it('retains the session on a temporary failure in an official request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockRejectedValueOnce(new TypeError('Failed to fetch')));

    await expect(listAvailableModels(official)).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' });
    expect(localStorage.getItem('pneumata-refresh-token')).toBe('valid-refresh');
    expect(authSession.dispatchAuthSessionExpired).not.toHaveBeenCalled();
  });

  it('expires only after renewal is definitively rejected', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ code: 'TOKEN_EXPIRED' }, 401)));

    await expect(marketApi.list()).rejects.toMatchObject({ status: 401 });
    expect(authSession.dispatchAuthSessionExpired).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'refresh_rejected', refreshStatus: 401,
    }));
  });

  it('does not renew or expire an external provider API key', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: { message: 'invalid API key' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateResponse({ ...official, provider: 'openai', apiKey: 'external-key', baseUrl: 'https://provider.example/v1' },
      'system', [{ role: 'user', content: 'hello' }])).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer external-key');
    expect(authSession.dispatchAuthSessionExpired).not.toHaveBeenCalled();
  });
});
