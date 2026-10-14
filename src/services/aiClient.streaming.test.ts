import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateJsonResponse, generateResponse, parseSSEStream } from './aiClient';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('AI streaming lifecycle', () => {
  function openStream(frame: string) {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame)); },
      cancel,
    });
    return { response: new Response(stream), cancel };
  }
  it('finishes at DONE even when the provider keeps its connection open', async () => {
    const { response, cancel } = openStream('data: {"choices":[]}\n\ndata: [DONE]\n\n');
    const onData = vi.fn();
    await parseSSEStream(response, onData);
    expect(onData).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('propagates consumer errors including branch cancellation', async () => {
    const { response, cancel } = openStream('data: {"text":"reply"}\n\n');
    await expect(parseSSEStream(response, () => { throw new Error('branch switched'); })).rejects.toThrow('branch switched');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('accepts CRLF frames and stops at Anthropic message_stop', async () => {
    const { response, cancel } = openStream('data: {"type":"message_stop"}\r\n\r\n');
    await parseSSEStream(response, vi.fn());
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('reports invalid frames and rejects instead of producing partial success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response } = openStream('data: {broken}\n\n');
    await expect(parseSSEStream(response, vi.fn())).rejects.toThrow('无效 JSON');
    expect(console.error).toHaveBeenCalledWith('[ai-stream:invalid-frame]', expect.any(Object));
  });
  it('rejects an idle stream and closes its reader', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response, cancel } = openStream(': keepalive\n\n');
    const result = expect(parseSSEStream(response, vi.fn(), 100)).rejects.toThrow('长时间没有数据');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([generateResponse, generateJsonResponse])('times out a request that never returns headers', async (generate) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    })));
    const config = { provider: 'openai', apiKey: 'test', model: 'test', baseUrl: 'https://example.test/v1' };
    const request = generate === generateResponse
      ? generateResponse(config, 'system', [])
      : generateJsonResponse(config, 'system', []);
    const rejection = expect(request).rejects.toThrow('超过五分钟');
    await vi.advanceTimersByTimeAsync(300_000);
    await rejection;
    expect(console.error).toHaveBeenCalledWith('[ai-request:timeout]', expect.objectContaining({ timeoutMs: 300_000 }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
