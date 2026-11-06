import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { testConnection, waitForAiMediaTask } from './aiClient';

const config = {
  provider: 'official-ace', apiKey: '', baseUrl: '/api/ai',
  model: 'doubao-seedance-2-0-fast-260128', type: 'video' as const,
};

describe('video connection test', () => {
  afterEach(() => vi.restoreAllMocks());

  it('checks the selected video catalog without issuing a chat or generation request', async () => {
    const request = vi.spyOn(api, 'fetchWithAuth').mockResolvedValue(new Response(JSON.stringify({
      items: [{ id: config.model, family: 'video' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect(await testConnection(config)).toEqual({ success: true });
    expect(request).toHaveBeenCalledOnce();
    const url = new URL(String(request.mock.calls[0][0]), 'https://example.test');
    expect(url.pathname).toBe('/api/ai/models');
    expect(url.searchParams.get('family')).toBe('video');
    expect(url.searchParams.get('provider')).toBe('official-acedata');
  });

  it('rejects an absent model rather than reporting a successful connection', async () => {
    vi.spyOn(api, 'fetchWithAuth').mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const result = await testConnection(config);
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain('所选视频模型未在当前渠道');
  });

  it('preserves catalog access errors', async () => {
    vi.spyOn(api, 'fetchWithAuth').mockResolvedValue(new Response(JSON.stringify({ error: '当前账号无权访问该渠道' }), { status: 403 }));
    const result = await testConnection(config);
    expect(result.success).toBe(false);
    expect((result.error as Error).message).toContain('当前账号无权访问该渠道');
  });
});

it('stops polling when the server cannot confirm whether ACE accepted a task', async () => {
  const request = vi.spyOn(api, 'getAiMediaTask').mockResolvedValue({ task_id: 'saved-task', model: config.model,
    status: 'submission_unknown', result: null, chargedAmount: null, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
  await expect(waitForAiMediaTask('saved-task')).rejects.toThrow('提交结果尚未确认');
  expect(request).toHaveBeenCalledOnce();
  request.mockRestore();
});
