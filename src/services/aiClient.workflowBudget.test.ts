import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateImage, generateJsonResponse, generateResponse } from './aiClient';
import type { APIConfig } from '../types/settings';
import { workflowAdmissionBlockReason } from './workflowAdmission';

const workflow = { schemaVersion: 1 as const, runId: 'run', taskId: 'task', attempt: 1,
  kind: 'model' as const, budgetRevision: 1 };
const aiUsage = { type: 'assistant_chat' as const, workflow };

afterEach(() => vi.unstubAllGlobals());

describe('workflow platform budget request boundary', () => {
  it.each(['text', 'json', 'image'] as const)('rejects a direct %s call before any network or file access', async (kind) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const config: APIConfig = { provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'private', model: 'test' };
    const request = kind === 'image'
      ? generateImage(config, { prompt: 'test', aiUsage, referenceImages: [{ url: 'https://example.test/reference.png' }] })
      : kind === 'json' ? generateJsonResponse(config, 'system', [], { aiUsage })
        : generateResponse(config, 'system', [], undefined, { aiUsage });
    const error = await request.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'WORKFLOW_BUDGET_CHANNEL_UNSUPPORTED', status: 409 });
    expect(workflowAdmissionBlockReason(error)).toContain('第三方直连费用无法纳入预算');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps direct calls available when no platform budget was selected', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const unbudgeted = { schemaVersion: workflow.schemaVersion, runId: workflow.runId, taskId: workflow.taskId,
      attempt: workflow.attempt, kind: workflow.kind };
    expect(await generateResponse({ provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'test' },
      'system', [], undefined, { aiUsage: { ...aiUsage, workflow: unbudgeted } })).toBe('ok');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { provider: 'official-ace', baseUrl: '/api/ai' },
    { provider: 'openai', baseUrl: '/api/ai/' },
  ] as const)('sends the budget revision through a platform route: %j', async (route) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await generateResponse({ ...route, apiKey: '', model: 'test' }, 'system', [], undefined, { aiUsage })).toBe('ok');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ metadata: { aiUsage } });
  });
});
