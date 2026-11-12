import { describe, expect, it } from 'vitest';
import { appliedWorkflowPlanRevision, parseWorkflowPlanRevision } from './workflowPlanRevision';
import type { WorkflowSnapshot } from './workflowRunRuntime';

function snapshot(): WorkflowSnapshot {
  return { run: { id: 'run', chatId: 'chat', goal: 'private goal', status: 'paused', generation: 0, planVersion: 4, updatedAt: 10 },
    tasks: [{ id: 'script', runId: 'run', kind: 'text', input: 'private prompt', dependsOn: [], status: 'queued', attempt: 0, updatedAt: 10 }] };
}

describe('workflow plan revision contract', () => {
  it('records only change identifiers and preserves the actual parent version', () => {
    const before = snapshot();
    const after: WorkflowSnapshot = { ...before, run: { ...before.run, maxModelCalls: 20, planVersion: 5, updatedAt: 20 },
      tasks: [{ ...before.tasks[0], input: 'private revised prompt' },
        { ...before.tasks[0], id: 'video', dependsOn: ['script'] }] };
    const revision = appliedWorkflowPlanRevision(before, after);
    expect(revision).toEqual({ schemaVersion: 1, runId: 'run', parentVersion: 4, version: 5, appliedAt: 20,
      addedTaskIds: ['video'], removedTaskIds: [], updatedTaskIds: ['script'], changedRunFields: ['maxModelCalls'] });
    expect(JSON.stringify(revision)).not.toContain('private');
    expect(appliedWorkflowPlanRevision(null, before)).toBeNull();
    expect(appliedWorkflowPlanRevision(before, before)).toBeNull();
  });

  it('rejects version rollback, skipped revisions, foreign runs and unknown schemas', () => {
    const before = snapshot();
    for (const planVersion of [3, 6]) expect(() => appliedWorkflowPlanRevision(before,
      { ...before, run: { ...before.run, planVersion } })).toThrow('按版本顺序');
    expect(() => appliedWorkflowPlanRevision(before, { ...before, run: { ...before.run, id: 'other' } })).toThrow('运行标识');
    const revision = appliedWorkflowPlanRevision(before, { ...before, run: { ...before.run, planVersion: 5 } });
    expect(() => parseWorkflowPlanRevision({ ...revision, schemaVersion: 2 })).toThrow('版本不受支持');
    expect(() => parseWorkflowPlanRevision({ ...revision, addedTaskIds: ['script'], updatedTaskIds: ['script'] })).toThrow('冲突');
    expect(() => parseWorkflowPlanRevision({ ...revision, changedRunFields: ['token'] })).toThrow('运行字段');
  });
});
