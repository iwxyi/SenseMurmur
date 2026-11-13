import { describe, expect, it } from 'vitest';
import { validateWorkflowCheckpoint } from './workflowCheckpoint';

const checkpoint = { schemaVersion: 1, data: { snapshot: { schemaVersion: 1,
  run: { schemaVersion: 1, id: 'run', chatId: 'chat', goal: 'test', status: 'paused', generation: 0, planVersion: 1, updatedAt: 1 },
  tasks: [{ schemaVersion: 1, id: 'task', runId: 'run', kind: 'agent_text', input: 'private',
    dependsOn: [], status: 'completed', output: 'result', attempt: 1, updatedAt: 1 }] }, outbox: [], attempts: [], revisions: [], consumers: [] } };

describe('workflow cloud checkpoint', () => {
  it('accepts only a versioned checkpoint for the requested run and chat', () => {
    expect(validateWorkflowCheckpoint(checkpoint, 'run', 'chat')).toEqual(checkpoint);
    expect(() => validateWorkflowCheckpoint(checkpoint, 'other', 'chat')).toThrow('归属');
    expect(() => validateWorkflowCheckpoint(checkpoint, 'run', 'other')).toThrow('归属');
    expect(() => validateWorkflowCheckpoint({ ...checkpoint, schemaVersion: 2 }, 'run', 'chat')).toThrow('版本');
    expect(() => validateWorkflowCheckpoint({ ...checkpoint, data: { ...checkpoint.data, snapshot: { ...checkpoint.data.snapshot,
      tasks: [{ ...checkpoint.data.snapshot.tasks[0], schemaVersion: 2 }] } } }, 'run', 'chat')).toThrow('版本');
    expect(() => validateWorkflowCheckpoint({ ...checkpoint, data: { ...checkpoint.data, snapshot: { ...checkpoint.data.snapshot,
      tasks: [{ ...checkpoint.data.snapshot.tasks[0], status: 'forged' }] } } }, 'run', 'chat')).toThrow('状态');
  });
});
