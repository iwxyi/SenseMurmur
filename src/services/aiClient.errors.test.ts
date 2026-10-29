import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateResponse, type PublicAiRequestError } from './aiClient';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('official AI error diagnostics', () => {
  it.each([
    [400, '请求参数'], [401, '上游认证失败'], [402, '账户额度不足'],
    [403, '拒绝访问'], [404, '未找到模型或接口'], [429, '限流'], [504, '超时'],
  ])('explains upstream HTTP %s while preserving the gateway status', async (upstreamStatus, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      error: 'ACE 请求失败', code: 'ACE_UPSTREAM_ERROR',
      detail: { upstreamStatus, token: 'private-key', prompt: 'private-prompt' },
    }, { status: 502 })));
    const error = await generateResponse({ provider: 'official-acedata', apiKey: '', model: 'gpt-6-sol', baseUrl: '/api/ai' }, '', []).catch((failure: PublicAiRequestError) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect((error as PublicAiRequestError).diagnostic).toMatchObject({ status: 502, upstreamStatus });
    expect(log).toHaveBeenCalledWith('[ai-request:failed]', expect.objectContaining({ status: 502, upstreamStatus }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-key|private-prompt/);
  });

  it('logs model, Agent stage and upstream parameter failures without truncating JSON before parsing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      ignored: 'x'.repeat(2500), error: 'ACE 请求失败', code: 'ACE_UPSTREAM_ERROR',
      detail: { upstreamStatus: 400, upstreamParam: 'max_tokens', upstreamMessage: 'max_tokens exceeds limit' },
    }, { status: 502 })));
    await generateResponse({ provider: 'official-acedata', apiKey: '', model: 'gpt-6-sol', baseUrl: '/api/ai' }, '', [], undefined, {
      maxTokens: 65536, aiUsage: { type: 'assistant_chat', label: '助手Agent补丁生成', scope: 'chat' },
    }).catch(() => undefined);
    expect(log).toHaveBeenCalledWith('[ai-request:context]', expect.objectContaining({
      model: 'gpt-6-sol', stage: '助手Agent补丁生成', maxTokens: 65536,
      diagnostic: expect.objectContaining({ detail: expect.objectContaining({ upstreamParam: 'max_tokens', upstreamMessage: 'max_tokens exceeds limit' }) }),
    }));
  });
});
