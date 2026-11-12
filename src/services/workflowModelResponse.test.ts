import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateResponse } from './aiClient';
import { describeWorkflowModelRequest, parseWorkflowModelRequest, type WorkflowModelRequest } from './workflowModelRequest';
import { generateWorkflowModelResponse } from './workflowModelResponse';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));
const config = { provider: 'openai', model: 'test', apiKey: 'private-key', baseUrl: 'https://model.invalid/private' };
const messages = [{ role: 'user' as const, content: 'private input', attachments: [{ url: 'data:image/png;base64,aGVsbG8=' }] }];

beforeEach(() => vi.mocked(generateResponse).mockReset());

describe('workflow model request boundary', () => {
  it('binds generation inputs and excludes credentials and operational metadata', () => {
    const request = describeWorkflowModelRequest(config, 'system', messages, { maxTokens: 500 });
    expect(parseWorkflowModelRequest(request)).toEqual(request);
    expect(JSON.stringify(request)).not.toMatch(/private|base64|system/);
    expect(describeWorkflowModelRequest({ ...config, apiKey: 'rotated' }, 'system', messages,
      { maxTokens: 500, signal: new AbortController().signal, aiUsage: { type: 'other', label: 'changed' } })).toEqual(request);
    for (const changed of [
      describeWorkflowModelRequest({ ...config, model: 'other' }, 'system', messages, { maxTokens: 500 }),
      describeWorkflowModelRequest(config, 'other', messages, { maxTokens: 500 }),
      describeWorkflowModelRequest(config, 'system', [{ ...messages[0], content: 'other' }], { maxTokens: 500 }),
      describeWorkflowModelRequest(config, 'system', [{ ...messages[0], attachments: [{ url: 'data:image/png;base64,b3RoZXI=' }] }], { maxTokens: 500 }),
      describeWorkflowModelRequest(config, 'system', messages, { maxTokens: 600 }),
      describeWorkflowModelRequest({ ...config, advancedOptions: { reasoningMode: 'enabled' } }, 'system', messages, { maxTokens: 500 }),
    ]) expect(changed).not.toEqual(request);
  });

  it('persists the digest before dispatch and keeps those inputs fixed across the asynchronous boundary', async () => {
    const api = { ...config };
    const input = structuredClone(messages);
    const beforeModelRequest = vi.fn(async (request: WorkflowModelRequest) => {
      expect(generateResponse).not.toHaveBeenCalled();
      expect(request).toEqual(describeWorkflowModelRequest(config, 'system', messages, { maxTokens: 500 }));
      api.model = 'changed while persisting';
      input[0].content = 'changed while persisting';
    });
    vi.mocked(generateResponse).mockResolvedValue('done');
    expect(await generateWorkflowModelResponse(api, 'system', input, undefined, { maxTokens: 500, beforeModelRequest })).toBe('done');
    expect(beforeModelRequest).toHaveBeenCalledOnce();
    expect(generateResponse).toHaveBeenCalledWith(config, 'system', messages, undefined, { maxTokens: 500, signal: undefined });
  });

  it('does not dispatch if persistence fails', async () => {
    await expect(generateWorkflowModelResponse(config, 'system', messages, undefined, {
      beforeModelRequest: async () => { throw new Error('storage unavailable'); },
    })).rejects.toThrow('storage unavailable');
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it('uses the persisted invocation reference and preserves usage context', async () => {
    const workflow = { schemaVersion: 1 as const, runId: 'run', taskId: 'task', attempt: 2, kind: 'model' as const };
    vi.mocked(generateResponse).mockResolvedValue('done');
    await generateWorkflowModelResponse(config, 'system', messages, undefined, {
      aiUsage: { type: 'assistant_chat', label: '团队任务', scope: 'chat', resourceId: 'chat', workflow: { ...workflow, runId: 'spoofed' } },
      beforeModelRequest: async () => workflow,
    });
    expect(vi.mocked(generateResponse).mock.calls[0][4]?.aiUsage).toEqual({
      type: 'assistant_chat', label: '团队任务', scope: 'chat', resourceId: 'chat', workflow,
    });
  });

  it.each(['before', 'during'] as const)('does not dispatch when aborted %s persistence', async (when) => {
    const controller = new AbortController();
    if (when === 'before') controller.abort();
    const beforeModelRequest = vi.fn(async () => { controller.abort(); });
    await expect(generateWorkflowModelResponse(config, 'system', messages, undefined,
      { signal: controller.signal, beforeModelRequest })).rejects.toThrow();
    expect(beforeModelRequest).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(generateResponse).not.toHaveBeenCalled();
  });
});
