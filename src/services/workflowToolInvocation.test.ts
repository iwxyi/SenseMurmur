import { describe, expect, it } from 'vitest';
import { parseWorkflowToolInvocation, workflowToolInvocationId, workflowToolOperationKey, type WorkflowToolInvocation } from './workflowToolInvocation';

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
});
