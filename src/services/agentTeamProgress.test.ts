import { describe, expect, it } from 'vitest';
import { hasRepeatedTeamReviewWithoutProgress, hasSemanticallyStalledTeamReview, parseTeamProgressAssessment, teamReviewProgressComparison } from './agentTeamProgress';
import { prepareWorkflowReviewRecord } from './workflowReviewRecord';
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
  function semanticFixture() {
    const snapshot = fixture();
    const previous = snapshot.tasks[1];
    previous.status = 'running';
    previous.output = prepareWorkflowReviewRecord(snapshot, previous.id, '有来源', [{ task: 'draft', output: '缺少来源' }])({ complete: false, reason: '缺少来源', nextRequest: '补充来源' });
    previous.status = 'completed';
    snapshot.tasks[2].output = '尚未找到资料，后面会继续搜集';
    const current = snapshot.tasks[3];
    current.status = 'running';
    const finish = prepareWorkflowReviewRecord(snapshot, current.id, '有来源', [{ task: 'draft', output: '缺少来源' }, { task: 'revision', output: '尚未找到资料，后面会继续搜集' }]);
    const comparison = teamReviewProgressComparison(snapshot, current.id, previous.output.criteriaSha256);
    current.output = finish({ complete: false, reason: '仍无可核对来源', nextRequest: '查找可核验的公开资料' },
      parseTeamProgressAssessment(comparison, { progress: { status: 'stalled', reason: '只是改写缺少资料的说法，没有新增来源', previousReviewTaskId: 'forged' } }));
    current.status = 'completed';
    return { snapshot, comparison };
  }

  it('recognizes paraphrased stalling only with a comparison bound to complete evidence', () => {
    const { snapshot } = semanticFixture();
    expect(hasRepeatedTeamReviewWithoutProgress(snapshot, 'review_2')).toBe(false);
    expect(hasSemanticallyStalledTeamReview(snapshot, 'review_2')).toBe(true);
    snapshot.tasks[2].output = '已新增可核验公开资料';
    expect(hasSemanticallyStalledTeamReview(snapshot, 'review_2')).toBe(false);
  });

  it('binds task inputs without sending runtime configuration to the reviewer', () => {
    const { snapshot, comparison } = semanticFixture();
    snapshot.tasks[2].input = { task: { goal: '核对资料', acceptance: '有可核验出处' }, sourcePlanTaskId: 'internal-plan', internalConfig: 'private-value' };
    const next = teamReviewProgressComparison(snapshot, 'review_2', comparison!.comparison.criteriaSha256);
    expect(next!.comparisonSha256).not.toBe(comparison!.comparisonSha256);
    expect(next!.comparison.after[1]).toMatchObject({ goal: '核对资料', acceptance: '有可核验出处' });
    expect(JSON.stringify(next)).not.toContain('internal-plan');
    expect(JSON.stringify(next)).not.toContain('private-value');
    expect(hasSemanticallyStalledTeamReview(snapshot, 'review_2')).toBe(false);
  });

  it('does not compare changed criteria, incomplete evidence, media or oversized text', () => {
    for (const change of ['criteria', 'media', 'large', 'incomplete'] as const) {
      const { snapshot, comparison } = semanticFixture();
      if (change === 'media') snapshot.tasks[2].kind = 'agent_video';
      if (change === 'large') snapshot.tasks[2].output = 'x'.repeat(13_000);
      if (change === 'incomplete') snapshot.tasks[2].status = 'running';
      expect(teamReviewProgressComparison(snapshot, 'review_2', change === 'criteria' ? '0'.repeat(64) : comparison!.comparison.criteriaSha256)).toBeNull();
    }
  });

  it('keeps uncertain or advanced comparisons running and rejects malformed assessments', () => {
    const { snapshot, comparison } = semanticFixture();
    const output = snapshot.tasks[3].output as object;
    for (const status of ['advanced', 'uncertain']) {
      snapshot.tasks[3].output = { ...output, progress: parseTeamProgressAssessment(comparison, { progress: { status, reason: '证据不同' } }) };
      expect(hasSemanticallyStalledTeamReview(snapshot, 'review_2')).toBe(false);
    }
    expect(parseTeamProgressAssessment(comparison, {})).toBeUndefined();
    expect(() => parseTeamProgressAssessment(comparison, { progress: { status: 'maybe', reason: '理由' } })).toThrow();
    expect(() => parseTeamProgressAssessment(comparison, { progress: { status: 'stalled', reason: '' } })).toThrow();
    expect(parseTeamProgressAssessment(null, { progress: { status: 'stalled' } })).toBeUndefined();
  });
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
