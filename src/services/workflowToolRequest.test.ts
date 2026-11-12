import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { describeWorkflowToolRequest, parseWorkflowToolRequest } from './workflowToolRequest';

describe('workflow tool request identity', () => {
  it('uses canonical JSON and a verified SHA-256 implementation without Web Crypto', () => {
    vi.stubGlobal('crypto', {});
    try {
      const result = describeWorkflowToolRequest('video_generation', { referenceImages: [], prompt: '森林追逐' });
      expect(result.sha256).toBe(createHash('sha256').update('{"input":{"prompt":"森林追逐","referenceImages":[]},"schemaVersion":1,"tool":"video_generation"}').digest('hex'));
      expect(result).toEqual(describeWorkflowToolRequest('video_generation', { prompt: '森林追逐', referenceImages: [] }));
      expect(JSON.stringify(result)).not.toContain('森林');
    } finally { vi.unstubAllGlobals(); }
  });

  it('distinguishes actual input changes, array order, tool and optional values', () => {
    const original = describeWorkflowToolRequest('video_generation', { prompt: '追逐', references: ['a', 'b'] });
    for (const input of [{ prompt: '追逐！', references: ['a', 'b'] }, { prompt: '追逐', references: ['b', 'a'] },
      { prompt: '追逐', references: ['a', 'b'], duration: 5 }]) {
      expect(describeWorkflowToolRequest('video_generation', input).sha256).not.toBe(original.sha256);
    }
    expect(describeWorkflowToolRequest('image_generation', { prompt: '追逐', references: ['a', 'b'] }).sha256).not.toBe(original.sha256);
    expect(describeWorkflowToolRequest('video_generation', { prompt: '追逐', references: ['a', 'b'], duration: undefined })).toEqual(original);
  });

  it('supports shared JSON references without confusing them with a cycle', () => {
    const source = { taskId: 'shot' };
    expect(describeWorkflowToolRequest('media_composition', [source, source]))
      .toEqual(describeWorkflowToolRequest('media_composition', [{ taskId: 'shot' }, { taskId: 'shot' }]));
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => describeWorkflowToolRequest('media_composition', cycle)).toThrow('循环');
  });

  it.each([undefined, NaN, Infinity, 1n, () => 'hidden', new Date(), new Map(), [undefined], Array(1), { [Symbol('hidden')]: 'value' }])('rejects lossy non-JSON input: %s', (value) => {
    expect(() => describeWorkflowToolRequest('web_search', value)).toThrow();
  });

  it('validates the version and digest and strips extra request contents', () => {
    const request = describeWorkflowToolRequest('speech_generation', { prompt: '你好' });
    expect(parseWorkflowToolRequest({ ...request, apiKey: 'secret', prompt: '你好', url: 'private' })).toEqual(request);
    for (const change of [{ schemaVersion: 2 }, { tool: 'shell' }, { sha256: '123' }, { sha256: request.sha256.toUpperCase() }]) {
      expect(() => parseWorkflowToolRequest({ ...request, ...change })).toThrow();
    }
  });
});
