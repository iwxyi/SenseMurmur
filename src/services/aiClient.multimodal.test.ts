import { afterEach, describe, expect, it } from 'vitest';
import { generateImage, generateResponse } from './aiClient';

const fetchMock = globalThis.fetch;

describe('aiClient multimodal requests', () => {
  it('routes a custom Ace-NanoBanana model ID through the Gemini image proxy', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const images = await generateImage({ provider: 'official-ace-nanobanana', apiKey: '', baseUrl: '/api/ai', model: 'custom-image-id' }, { prompt: 'a tea cup' });
    expect(calls[0].url).toContain('generateContent');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ provider: 'official-ace-nanobanana', contents: [{ parts: [{ text: 'a tea cup' }] }] });
    expect(images).toHaveLength(1);
  });
  afterEach(() => {
    globalThis.fetch = fetchMock;
  });

  it('builds OpenAI-compatible image message content', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse({ provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' }, 'system', [{
      role: 'user',
      content: '看这张图',
      attachments: [{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }],
    }]);

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('preserves uploaded images when sending an ACE GPT model through the official proxy', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ choices: [{ message: { content: '收到图片' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse({ provider: 'official-acedata', apiKey: '', baseUrl: '/api/ai', model: 'gpt-6.1-sol' }, 'system', [{
      role: 'user', content: '看这张图', attachments: [{ url: 'https://example.test/photo.png', mimeType: 'image/png' }],
    }]);

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body).toMatchObject({ provider: 'official-acedata', model: 'gpt-6.1-sol' });
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'https://example.test/photo.png' } },
    ]);
  });

  it('shows the member generation limit instead of a generic permission error', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: '今日 AI 生成次数已达当前会员上限',
      code: 'VIP_LIMIT_EXCEEDED',
      detail: { limit: 3, current: 3 },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    await expect(generateImage(
      { provider: 'official-nanobanana', apiKey: '', baseUrl: '/api/ai', model: 'gemini-3-pro-image-preview' },
      { prompt: '一盏台灯' },
    )).rejects.toThrow('今日 AI 生成次数已达当前会员上限');
  });

  it.each([
    ['AI_IMAGE_SERVICE_UNCONFIGURED', '图片服务的模型或价格配置不完整'],
    ['AI_IMAGE_UPSTREAM_AUTH_FAILED', '图片供应商认证或权限校验失败'],
    ['AI_IMAGE_UPSTREAM_BALANCE_INSUFFICIENT', '图片供应商账户余额不足'],
    ['AI_IMAGE_UPSTREAM_RATE_LIMITED', '图片供应商请求限流'],
    ['AI_IMAGE_UPSTREAM_TIMEOUT', '图片生成请求超时'],
    ['AI_IMAGE_EMPTY_RESPONSE', '图片供应商未返回图片'],
  ])('shows the safe image failure reason for %s', async (code, message) => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code, error: 'secret-token private upstream error', detail: { prompt: 'private prompt' },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const error = await generateImage(
      { provider: 'official-ace-nanobanana', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-pro' },
      { prompt: '一盏台灯' },
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toMatch(/secret-token|private|Gemini/);
  });

  it('builds Anthropic image content with base64 source', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse({ provider: 'anthropic', apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-0' }, 'system', [{
      role: 'user',
      content: '看图',
      attachments: [{ url: 'data:image/jpeg;base64,BBB', mimeType: 'image/jpeg' }],
    }]);

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
    ]);
  });

  it('builds Gemini image parts with inlineData', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse({ provider: 'google', apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' }, 'system', [{
      role: 'user',
      content: '图片里是什么',
      attachments: [{ url: 'data:image/webp;base64,CCC', mimeType: 'image/webp' }],
    }]);

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body.contents[0].parts).toEqual([
      { text: '图片里是什么' },
      { inlineData: { mimeType: 'image/webp', data: 'CCC' } },
    ]);
  });

  it('rejects inline image data in text content before making a text request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await expect(generateResponse(
      { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      'system',
      [{
        role: 'user',
        content: `参考图：data:image/png;base64,${'A'.repeat(2048)}`,
      }],
    )).rejects.toThrow(/inline image data/i);
    expect(called).toBe(false);
  });

  it('rejects oversized text payloads before making a request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await expect(generateResponse(
      { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      'system',
      [{ role: 'user', content: 'x'.repeat(128) }],
      undefined,
      { maxInputChars: 32 },
    )).rejects.toThrow(/too large/i);
    expect(called).toBe(false);
  });

  it('adds a lowercase json instruction for json_object requests', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse(
      { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      '你是结构化规划器。',
      [{ role: 'user', content: '输出对象' }],
      undefined,
      { responseFormat: 'json' },
    );

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(String(body.messages[0]?.content || '')).toContain('json');
    expect(String(body.messages[1]?.content || '')).toContain('json');
  });

  it('sends DeepSeek V4 thinking disabled directly in official proxy requests', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse(
      { provider: 'official-1', apiKey: '', baseUrl: '/api/ai', model: 'deepseek-v4-flash', advancedOptions: { reasoningMode: 'disabled' } },
      'system',
      [{ role: 'user', content: '今晚茶馆聊什么？' }],
    );

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.modelOptions).toBeUndefined();
  });

  it('sends native JSON format through official DeepSeek proxy without changing historical JSON examples', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"messages":[{"content":"看看袖口。"}]}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const prior = JSON.stringify({ messages: [{ content: '先别扔。' }] });
    await generateResponse({ provider: 'official-1', apiKey: '', baseUrl: '/api/ai', model: 'deepseek-v4-flash' },
      'Return one JSON object.', [{ role: 'assistant', content: prior }, { role: 'user', content: '阿强: 袖口还能改。' }],
      undefined, { responseFormat: 'json' });
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.find((item: { role: string }) => item.role === 'assistant').content).toBe(prior);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('defaults DeepSeek V4 thinking to disabled when advanced options are missing', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse(
      { provider: 'official-1', apiKey: '', baseUrl: '/api/ai', model: 'deepseek-v4-flash' },
      'system',
      [{ role: 'user', content: '今晚茶馆聊什么？' }],
    );

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.modelOptions).toBeUndefined();
  });

  it('sends DeepSeek V4 thinking enabled directly in official proxy requests', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse(
      { provider: 'official-1', apiKey: '', baseUrl: '/api/ai', model: 'deepseek-v4-pro', advancedOptions: { reasoningMode: 'enabled' } },
      'system',
      [{ role: 'user', content: '帮我分析一下。' }],
    );

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.modelOptions).toBeUndefined();
  });

  it('keeps json_object requests valid when the latest user message contains images', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init || {});
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await generateResponse(
      { provider: 'official-gpt', apiKey: '', baseUrl: '/api/ai', model: 'gpt-5.4-mini' },
      '你是结构化规划器。',
      [{
        role: 'user',
        content: '解释这张参考图',
        attachments: [{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }],
      }],
      undefined,
      { responseFormat: 'json' },
    );

    const body = JSON.parse(String(calls[0]?.body || '{}'));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: '解释这张参考图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: 'Return exactly one valid json object.' },
    ]);
  });
});
