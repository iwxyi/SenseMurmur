import { describe, expect, it } from 'vitest';
import { parseWorkflowToolInvocation, workflowToolInvocationId, workflowToolOperationKey, type WorkflowToolInvocation } from './workflowToolInvocation';
import { describeWorkflowToolRequest } from './workflowToolRequest';

const invocation: WorkflowToolInvocation = { schemaVersion: 1, id: workflowToolInvocationId('run', 'task', 1),
  operationKey: workflowToolOperationKey('run', 'task'), runId: 'run', taskId: 'task', attempt: 1,
  planVersion: 2, kind: 'agent_video', state: 'reserved', reservedAt: 10 };

describe('workflow tool invocation', () => {
  it('parses a minimal local reservation and removes private extra fields', () => {
    expect(parseWorkflowToolInvocation({ ...invocation, prompt: 'private', token: 'secret', url: 'private' })).toEqual(invocation);
  });
  it.each([
    { schemaVersion: 2 }, { id: 'unrelated' }, { operationKey: 'unrelated' }, { kind: 'agent_text' },
    { attempt: 0 }, { planVersion: 0 }, { state: 'started' }, { finishedAt: 11 },
    { state: 'not_started' }, { state: 'waiting_external', startedAt: 11 },
    { state: 'started', startedAt: 9 }, { state: 'failed', startedAt: 12, finishedAt: 11 },
  ])('rejects malformed records: %j', (change) => {
    expect(() => parseWorkflowToolInvocation({ ...invocation, ...change })).toThrow();
  });
  it('requires a real external reference for external waiting', () => {
    const waiting = { ...invocation, state: 'waiting_external', startedAt: 11, externalTaskId: 'provider-task' };
    expect(parseWorkflowToolInvocation(waiting)).toEqual(waiting);
    expect(() => parseWorkflowToolInvocation({ ...waiting, finishedAt: 12 })).toThrow('时间');
  });
  it('binds request identity to the tool kind and only a started invocation', () => {
    const request = describeWorkflowToolRequest('video_generation', { prompt: 'private' });
    const started = { ...invocation, state: 'started', startedAt: 11, request };
    expect(parseWorkflowToolInvocation(started)).toEqual(started);
    expect(() => parseWorkflowToolInvocation({ ...invocation, request })).toThrow('不一致');
    expect(() => parseWorkflowToolInvocation({ ...started, request: describeWorkflowToolRequest('web_search', {}) })).toThrow('不一致');
    expect(parseWorkflowToolInvocation({ ...started, request: { ...request, prompt: 'private' } }).request).toEqual(request);
  });
});
