import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { prepareAiMediaTask, quoteAiMediaTask, submitAiMediaTask, submitPreparedAiMediaTask } from './aiClient';
import { parsePreparedMediaExecution } from './preparedMediaExecution';
import { parseMediaExecutionQuote, type MediaExecutionQuote } from '../types/mediaExecutionQuote';

const quote: MediaExecutionQuote = { schemaVersion: 1, id: 'a'.repeat(64), model: 'fixture-video', modality: 'video',
  requestSha256: 'b'.repeat(64), costQuoteId: 'c'.repeat(64), amount: '1.250000', unit: 'credit',
  kind: 'request_tariff', capturedAt: 1000, expiresAt: 301000, token: 'd'.repeat(64) };
const options = () => ({ profile: { provider: 'official-ace', model: 'fixture-video' }, prompt: 'forest',
  parameters: { duration: 5, resolution: '720p', image_urls: ['data:image/png;base64,AA=='] },
  clientRequestKey: 'fixture-request', aiUsage: { type: 'video_generation' as const,
    workflow: { schemaVersion: 1 as const, runId: 'fixture-run', taskId: 'fixture-task', attempt: 1, kind: 'tool' as const } } });
afterEach(() => vi.restoreAllMocks());

describe('client signed media quote boundary', () => {
  it('persists an independent request captured before quotation and submits it after caller configuration changes', async () => {
    const original = options();
    const preview = vi.spyOn(api, 'quoteAiMedia').mockImplementation(async () => {
      original.profile.model = 'changed-model';
      original.parameters.duration = 15;
      original.parameters.image_urls.push('changed-image');
      original.aiUsage.workflow.attempt = 2;
      return quote;
    });
    const generate = vi.spyOn(api, 'generateAiMedia').mockResolvedValue({ task_id: 'accepted', status: 'running' });
    const prepared = await prepareAiMediaTask(original);
    const restored = parsePreparedMediaExecution(JSON.parse(JSON.stringify(prepared)));
    await submitPreparedAiMediaTask(restored);
    expect(generate).toHaveBeenCalledWith({ ...preview.mock.calls[0][0], execution_quote: quote }, {});
    expect(restored.request).toMatchObject({ model: 'fixture-video', duration: 5,
      image_urls: ['data:image/png;base64,AA=='], metadata: { aiUsage: { workflow: { attempt: 1 } } } });
    expect(restored.request).not.toHaveProperty('executionFence');
  });

  it('rejects changed persisted parameters before network submission', async () => {
    vi.spyOn(api, 'quoteAiMedia').mockResolvedValue(quote);
    const generate = vi.spyOn(api, 'generateAiMedia');
    const prepared = await prepareAiMediaTask(options());
    prepared.request.duration = 15;
    await expect(submitPreparedAiMediaTask(prepared)).rejects.toThrow('媒体执行方案与报价不一致');
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['executionFence', 'execution_quote', 'apiKey', 'token'])('rejects persisted control or credential field %s', async (key) => {
    vi.spyOn(api, 'quoteAiMedia').mockResolvedValue(quote);
    const generate = vi.spyOn(api, 'generateAiMedia');
    const prepared = await prepareAiMediaTask(options());
    prepared.request[key] = 'unexpected';
    await expect(submitPreparedAiMediaTask(prepared)).rejects.toThrow('媒体执行请求包含非法字段');
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects quote model mismatch and non-JSON inputs without generation', async () => {
    const preview = vi.spyOn(api, 'quoteAiMedia').mockResolvedValue({ ...quote, model: 'other' });
    const generate = vi.spyOn(api, 'generateAiMedia');
    await expect(prepareAiMediaTask(options())).rejects.toThrow('媒体执行方案与报价不一致');
    preview.mockClear();
    await expect(prepareAiMediaTask({ ...options(), parameters: { date: new Date() } })).rejects.toThrow('非 JSON 对象');
    expect(preview).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });

  it('passes an expired captured quote to the backend so an existing idempotent task can still be recovered', async () => {
    vi.spyOn(api, 'quoteAiMedia').mockResolvedValue(quote);
    const generate = vi.spyOn(api, 'generateAiMedia').mockResolvedValue({ task_id: 'original', status: 'running' });
    const prepared = await prepareAiMediaTask(options());
    await expect(submitPreparedAiMediaTask(prepared)).resolves.toMatchObject({ task_id: 'original' });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('does not submit a captured request after cancellation', async () => {
    vi.spyOn(api, 'quoteAiMedia').mockResolvedValue(quote);
    const generate = vi.spyOn(api, 'generateAiMedia');
    const prepared = await prepareAiMediaTask(options());
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(submitPreparedAiMediaTask(prepared, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(generate).not.toHaveBeenCalled();
  });

  it('uses the same request parameters for preview and generation with the signature added separately', async () => {
    const requests = vi.spyOn(api, 'fetchWithAuth').mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(payload.execution_quote ? { task_id: 'accepted', status: 'running' } : quote),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const approved = await quoteAiMediaTask(options());
    expect(requests).toHaveBeenCalledTimes(1);
    expect(String(requests.mock.calls[0][0])).toContain('/ai/media/quotes');
    await submitAiMediaTask({ ...options(), executionQuote: approved });
    expect(requests).toHaveBeenCalledTimes(2);
    expect(String(requests.mock.calls[1][0])).toContain('/ai/media/generations');
    const preview = JSON.parse(String(requests.mock.calls[0][1]?.body));
    const { execution_quote: submittedQuote, ...submitted } = JSON.parse(String(requests.mock.calls[1][1]?.body));
    expect(submitted).toEqual(preview);
    expect(submittedQuote).toEqual(quote);
    expect(preview.metadata.aiUsage.workflow).toEqual(options().aiUsage.workflow);
    expect(preview).not.toHaveProperty('execution_quote');
  });

  it('propagates quote rejection details without submitting a generation', async () => {
    const preview = vi.spyOn(api, 'quoteAiMedia').mockRejectedValue(new ApiError('报价不可用', { status: 409, code: 'AI_MEDIA_QUOTE_UNAVAILABLE' }));
    const generate = vi.spyOn(api, 'generateAiMedia');
    await expect(quoteAiMediaTask(options())).rejects.toMatchObject({ code: 'AI_MEDIA_QUOTE_UNAVAILABLE' });
    expect(preview).toHaveBeenCalledOnce(); expect(generate).not.toHaveBeenCalled();
  });

  it('preserves an estimate as an estimate and strips unexpected response properties', async () => {
    vi.spyOn(api, 'quoteAiMedia').mockResolvedValue({ ...quote, kind: 'usage_estimate', privateContext: 'should-not-persist' });
    const result = await quoteAiMediaTask(options());
    expect(result.kind).toBe('usage_estimate');
    expect(result).not.toHaveProperty('privateContext');
  });

  it.each([null, {}, { ...quote, token: 'bad' }, { ...quote, amount: '-1.000000' },
    { ...quote, expiresAt: 301001 }, { ...quote, kind: 'guaranteed' }])('rejects malformed server quotes %j', async (response) => {
    vi.spyOn(api, 'quoteAiMedia').mockResolvedValue(response);
    await expect(quoteAiMediaTask(options())).rejects.toThrow('报价格式无效');
  });

  it('does not silently drop an invalid quote and generate without approval', async () => {
    const generate = vi.spyOn(api, 'generateAiMedia');
    await expect(submitAiMediaTask({ ...options(), executionQuote: { ...quote, token: 'bad' } })).rejects.toThrow('报价格式无效');
    expect(generate).not.toHaveBeenCalled();
  });

  it('can parse a persisted quote after expiry for history display', () => {
    expect(parseMediaExecutionQuote(JSON.parse(JSON.stringify(quote)))).toEqual(quote);
  });

  it('honors cancellation before a request and after an in-flight preview', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const preview = vi.spyOn(api, 'quoteAiMedia');
    const generate = vi.spyOn(api, 'generateAiMedia');
    await expect(quoteAiMediaTask({ ...options(), signal: controller.signal })).rejects.toThrow('cancelled');
    await expect(submitAiMediaTask({ ...options(), signal: controller.signal })).rejects.toThrow('cancelled');
    expect(preview).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    const pendingController = new AbortController();
    preview.mockImplementation(async () => { pendingController.abort(new Error('cancelled while waiting')); return quote; });
    await expect(quoteAiMediaTask({ ...options(), signal: pendingController.signal })).rejects.toThrow('cancelled while waiting');
    expect(preview).toHaveBeenCalledWith(expect.any(Object), { signal: pendingController.signal });
  });
});
