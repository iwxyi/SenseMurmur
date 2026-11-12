import { describe, expect, it } from 'vitest';
import { hasRepeatedTeamReviewWithoutProgress } from './agentTeamProgress';
import type { WorkflowSnapshot, WorkflowTask } from './workflowRunRuntime';

function fixture(): WorkflowSnapshot {
  const task = (id: string, kind: string, output: unknown, input: unknown = null): WorkflowTask => ({
    id, runId: 'run', kind, input, output, dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1,
  });
  return {
    run: { id: 'run', chatId: 'chat', goal: '研究', status: 'active', generation: 1, planVersion: 1, updatedAt: 1 },
    tasks: [task('draft', 'agent_text', '缺少来源'),
      task('review_1', 'team_review', { complete: false, nextRequest: '补充来源' }, { sourceTaskIds: ['draft'] }),
      task('revision', 'agent_text', '缺少来源'),
      task('review_2', 'team_review', { complete: false, nextRequest: '补充来源' }, { sourceTaskIds: ['draft', 'revision'] })],
  };
}

describe('team progress detection', () => {
  it('compares leaf deliveries across aggregate roots and skips intermediate reviews', () => {
    const snapshot = fixture();
    const root = snapshot.tasks[3];
    const partial = { ...root, id: 'review_2_batch_1', input: { schemaVersion: 2, mode: 'batch', partial: true, sourceTaskIds: ['draft', 'revision'] } };
    root.input = { schemaVersion: 2, mode: 'aggregate', sourceTaskIds: [partial.id] };
    snapshot.tasks.splice(3, 0, partial);
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, root.id)).toBe(true);
    snapshot.tasks[2].output = '新增来源';
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, root.id)).toBe(false);
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, partial.id)).toBe(false);
  });
  it('recognizes repeated requests with identical text evidence', () => {
    expect(hasRepeatedTeamReviewWithoutProgress(fixture(), 'review_2')).toBe(true);
  });
  it('continues when revised text adds evidence even if the request repeats', () => {
    const snapshot = fixture();
    snapshot.tasks[2].output = '新增公开来源';
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, 'review_2')).toBe(false);
  });
  it('does not infer media progress from generic completion text', () => {
    const snapshot = fixture();
    snapshot.tasks[2].kind = 'agent_video';
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, 'review_2')).toBe(false);
  });
  it('requires two incomplete reviews with the same requested action', () => {
    const snapshot = fixture();
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, 'review_1')).toBe(false);
    snapshot.tasks[3].output = { complete: false, nextRequest: '更换研究方向' };
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, 'review_2')).toBe(false);
    snapshot.tasks[3].output = { complete: true };
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, 'review_2')).toBe(false);
  });
});
