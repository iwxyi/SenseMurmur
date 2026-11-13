import { describe, expect, it } from 'vitest';
import { claimedTaskAttempt, parseWorkflowTaskAttempt, settleTaskAttempt, workflowTaskDefinitionDigest, type WorkflowTaskAttempt } from './workflowTaskAttempt';
import type { WorkflowTask } from './workflowRunRuntime';

const attempt: WorkflowTaskAttempt = {
  schemaVersion: 1, runId: 'run', taskId: 'task', kind: 'agent_video', attempt: 1,
  generation: 0, planVersion: 1, status: 'failed', startedAt: 10, updatedAt: 20, finishedAt: 20,
};
const task: WorkflowTask = {
  id: 'task', runId: 'run', kind: 'agent_video', input: '', dependsOn: [], attempt: 1, updatedAt: 30, status: 'queued',
};

describe('task attempt contract', () => {
  it('binds each claim to the task definition without copying its private input', () => {
    const source = { ...task, input: { prompt: 'private prompt', revision: 1 }, status: 'running' as const };
    const claimed = claimedTaskAttempt({ run: { id: 'run', chatId: 'chat', goal: 'goal', status: 'active',
      generation: 0, planVersion: 2, updatedAt: 30 }, tasks: [source] }, source);
    expect(claimed.definitionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(claimed.definitionSha256).toBe(workflowTaskDefinitionDigest({ ...source, schemaVersion: 1,
      input: { revision: 1, prompt: 'private prompt' } }));
    expect(workflowTaskDefinitionDigest({ ...source, input: { prompt: 'changed' } })).not.toBe(claimed.definitionSha256);
    expect(workflowTaskDefinitionDigest({ ...source, dependsOn: ['other'] })).not.toBe(claimed.definitionSha256);
    expect(JSON.stringify(claimed)).not.toContain('private prompt');
    expect(parseWorkflowTaskAttempt(claimed)).toEqual(claimed);
    expect(settleTaskAttempt(claimed, { ...source, status: 'completed' }).definitionSha256).toBe(claimed.definitionSha256);
    expect(() => parseWorkflowTaskAttempt({ ...claimed, definitionSha256: 'invalid' })).toThrow('定义摘要');
  });
  it('binds the exact completed dependency output at claim time without storing its contents', () => {
    const dependency: WorkflowTask = { ...task, id: 'source', input: null, output: { text: 'private upstream result' },
      status: 'completed', attempt: 1 };
    const target: WorkflowTask = { ...task, dependsOn: ['source'], status: 'running' };
    const snapshot = { run: { id: 'run', chatId: 'chat', goal: 'goal', status: 'active' as const,
      generation: 0, planVersion: 1, updatedAt: 30 }, tasks: [dependency, target] };
    const claimed = claimedTaskAttempt(snapshot, target);
    expect(claimed.dependencyOutputs).toEqual([{ taskId: 'source',
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(JSON.stringify(claimed)).not.toContain('private upstream result');
    expect(parseWorkflowTaskAttempt(claimed)).toEqual(claimed);
    expect(claimedTaskAttempt({ ...snapshot, tasks: [{ ...dependency, output: { text: 'changed' } }, target] }, target)
      .dependencyOutputs).not.toEqual(claimed.dependencyOutputs);
    expect(() => claimedTaskAttempt({ ...snapshot, tasks: [{ ...dependency, status: 'failed' }, target] }, target))
      .toThrow('未完成的依赖输出');
    expect(() => parseWorkflowTaskAttempt({ ...claimed, dependencyOutputs: [
      ...claimed.dependencyOutputs!, claimed.dependencyOutputs![0],
    ] })).toThrow('依赖版本');
  });
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
