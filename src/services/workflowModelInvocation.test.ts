import { describe, expect, it } from 'vitest';
import { parseWorkflowModelInvocation, workflowModelInvocationId, type WorkflowModelInvocation } from './workflowModelInvocation';
import { describeWorkflowModelRequest } from './workflowModelRequest';

const reserved: WorkflowModelInvocation = { schemaVersion: 1, id: workflowModelInvocationId('run', 'task', 1), runId: 'run', taskId: 'task', attempt: 1, state: 'reserved', reservedAt: 10 };

describe('model invocation contract', () => {
  it('preserves request digests only for calls that started', () => {
    const request = describeWorkflowModelRequest({ provider: 'openai', model: 'test', apiKey: 'secret', baseUrl: '' }, 'private', []);
    expect(() => parseWorkflowModelInvocation({ ...reserved, request })).toThrow('未开始');
    expect(() => parseWorkflowModelInvocation({ ...reserved, request, state: 'not_started', finishedAt: 11 })).toThrow('未开始');
    const started = { ...reserved, state: 'started', startedAt: 11, request };
    expect(parseWorkflowModelInvocation(started)).toEqual(started);
    expect(() => parseWorkflowModelInvocation({ ...started, request: { ...request, schemaVersion: 2 } })).toThrow('模型请求摘要');
    expect(() => parseWorkflowModelInvocation({ ...started, request: { schemaVersion: 1, sha256: 'invalid' } })).toThrow('模型请求摘要');
  });
  it('accepts ordered request and no-request outcomes and removes private fields', () => {
    expect(parseWorkflowModelInvocation({ ...reserved, token: 'secret', prompt: 'private' })).toEqual(reserved);
    expect(parseWorkflowModelInvocation({ ...reserved, state: 'not_started', finishedAt: 11 }).state).toBe('not_started');
    expect(parseWorkflowModelInvocation({ ...reserved, state: 'succeeded', startedAt: 11, finishedAt: 12 }).state).toBe('succeeded');
  });
  it.each([
    { schemaVersion: 2 }, { attempt: 2 }, { id: 'other' }, { state: 'unknown' },
    { reservedAt: Infinity }, { startedAt: 11 }, { state: 'started' },
    { state: 'started', startedAt: 9 }, { state: 'started', startedAt: 11, finishedAt: 12 },
    { state: 'not_started' }, { state: 'succeeded', startedAt: 11, finishedAt: 10 },
  ])('rejects inconsistent persisted records: %j', (patch) => {
    expect(() => parseWorkflowModelInvocation({ ...reserved, ...patch })).toThrow();
  });
});
