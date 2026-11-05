import { describe, expect, it } from 'vitest';
import { projectBackgroundExecutionOverview } from './backgroundExecutionOverview';
import type { WorkflowSnapshot, WorkflowTaskStatus } from './workflowRunRuntime';

function sample(id: string, status: WorkflowSnapshot['run']['status'], taskStatus: WorkflowTaskStatus): WorkflowSnapshot {
  return {
    run: { id, chatId: id, goal: '回复', status, generation: 0, planVersion: 1, updatedAt: 1 },
    tasks: [{ id: `${id}-task`, runId: id, kind: 'assistant_reply', input: {}, dependsOn: [], status: taskStatus, attempt: 0, updatedAt: 1 }],
  };
}

describe('background execution overview', () => {
  it('projects persisted runs and live ownership without counting completed work', () => {
    const overview = projectBackgroundExecutionOverview([
      sample('active', 'active', 'running'),
      sample('queued', 'active', 'queued'),
      sample('paused', 'paused', 'queued'),
      sample('blocked', 'paused', 'result_unknown'),
      sample('done', 'completed', 'completed'),
      sample('awaiting-close', 'active', 'completed'),
    ], ['active']);
    expect(overview).toEqual({ running: 1, queued: 1, interrupted: 1, blocked: 1, chatId: 'active' });
  });
});
