import { describe, expect, it } from 'vitest';
import { parseWorkflowModelInvocation, workflowModelInvocationId, type WorkflowModelInvocation } from './workflowModelInvocation';

const reserved: WorkflowModelInvocation = { schemaVersion: 1, id: workflowModelInvocationId('run', 'task', 1), runId: 'run', taskId: 'task', attempt: 1, state: 'reserved', reservedAt: 10 };

describe('model invocation contract', () => {
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
