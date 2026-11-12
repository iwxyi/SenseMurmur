import { describe, expect, it } from 'vitest';
import { parseWorkflowTaskAttempt, settleTaskAttempt, type WorkflowTaskAttempt } from './workflowTaskAttempt';
import type { WorkflowTask } from './workflowRunRuntime';

const attempt: WorkflowTaskAttempt = {
  schemaVersion: 1, runId: 'run', taskId: 'task', kind: 'agent_video', attempt: 1,
  generation: 0, planVersion: 1, status: 'failed', startedAt: 10, updatedAt: 20, finishedAt: 20,
};
const task: WorkflowTask = {
  id: 'task', runId: 'run', kind: 'agent_video', input: '', dependsOn: [], attempt: 1, updatedAt: 30, status: 'queued',
};

describe('task attempt contract', () => {
  it('rejects unknown versions, invalid counters and inconsistent times', () => {
    expect(() => parseWorkflowTaskAttempt({ ...attempt, schemaVersion: 2 })).toThrow('版本');
    expect(() => parseWorkflowTaskAttempt({ ...attempt, attempt: 0 })).toThrow('代次');
    expect(() => parseWorkflowTaskAttempt({ ...attempt, finishedAt: 21 })).toThrow('时间');
  });

  it('retains prior outcome when a task is scheduled for another attempt', () => {
    expect(settleTaskAttempt(attempt, task)).toEqual(attempt);
    expect(settleTaskAttempt(attempt, { ...task, status: 'waiting_dependency' })).toEqual(attempt);
  });

  it('closes the interrupted local question attempt before safely re-queueing it', () => {
    const { finishedAt, ...running } = attempt;
    void finishedAt;
    expect(settleTaskAttempt({ ...running, kind: 'agent_user_input', status: 'running' }, { ...task, kind: 'agent_user_input' }))
      .toMatchObject({ status: 'cancelled', updatedAt: 30, finishedAt: 30 });
  });

  it('clears obsolete finish time when reconciling a pending external result', () => {
    const pending = settleTaskAttempt(attempt, { ...task, status: 'waiting_external', externalTaskId: 'upstream' });
    expect(pending.finishedAt).toBeUndefined();
    expect(pending).toMatchObject({ status: 'waiting_external', externalTaskId: 'upstream', updatedAt: 30 });
    expect(settleTaskAttempt(pending, { ...task, status: 'completed', updatedAt: 40 }).finishedAt).toBe(40);
  });

  it('omits fields outside the persisted contract', () => {
    expect(parseWorkflowTaskAttempt({ ...attempt, prompt: 'private', token: 'secret' })).toEqual(attempt);
  });
});
