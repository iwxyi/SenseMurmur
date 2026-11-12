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

  function mediaFixture(kind: string, inspectionKind: string) {
    const snapshot = fixture();
    const media = (id: string): WorkflowTask => ({ id, runId: 'run', kind, input: { task: { goal: '蓝色主角跑向右侧', acceptance: '保持蓝色与运动方向' } },
      output: '附件已保存，不能由此推断质量', dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1 });
    const inspect = (id: string, source: string): WorkflowTask => ({ ...media(id), kind: inspectionKind,
      dependsOn: [source], output: '观察到主角变为红色；采样画面中朝左移动。未检查音轨。' });
    snapshot.tasks = [media('media-before'), inspect('inspect-before', 'media-before'), snapshot.tasks[1],
      media('media-after'), inspect('inspect-after', 'media-after'), snapshot.tasks[3]];
    const previous = snapshot.tasks[2];
    previous.input = { sourceTaskIds: ['media-before', 'inspect-before'] };
    previous.status = 'running';
    previous.output = prepareWorkflowReviewRecord(snapshot, previous.id, '保持蓝色和向右移动', [])({ complete: false, reason: '颜色和方向错误', nextRequest: '修正颜色和方向并检查' });
    previous.status = 'completed';
    const current = snapshot.tasks[5];
    current.input = { sourceTaskIds: ['media-before', 'inspect-before', 'media-after', 'inspect-after'] };
    current.status = 'running';
    const comparison = teamReviewProgressComparison(snapshot, current.id, previous.output.criteriaSha256);
    current.output = prepareWorkflowReviewRecord(snapshot, current.id, '保持蓝色和向右移动', [])(
      { complete: false, reason: '观察报告中的缺陷未解决', nextRequest: '调整参考素材' },
      parseTeamProgressAssessment(comparison, { progress: { status: 'stalled', reason: '两次检查均观察到相同的颜色和方向错误' } }));
    current.status = 'completed';
    return { snapshot, comparison };
  }

  it.each([
    ['agent_image', 'agent_image_inspection'], ['agent_video', 'agent_video_inspection'], ['agent_media_composition', 'agent_video_inspection'],
  ])('compares %s using complete inspection observations and binds source identity', (kind, inspectionKind) => {
    const { snapshot, comparison } = mediaFixture(kind, inspectionKind);
    expect(comparison?.comparison.observationScope).toContain('不证明音轨');
    expect(comparison?.comparison.after[2]).toMatchObject({ kind, observationTaskIds: ['inspect-after'] });
    expect(comparison?.comparison.after[2]).not.toHaveProperty('output');
    expect(comparison?.comparison.after[3].output).toContain('主角变为红色');
    expect(hasSemanticallyStalledTeamReview(snapshot, 'review_2')).toBe(true);
    snapshot.tasks[3].attempt += 1;
    expect(hasSemanticallyStalledTeamReview(snapshot, 'review_2')).toBe(false);
  });

  it.each(['uninspected-before', 'wrong-source', 'wrong-kind', 'incomplete', 'empty', 'audio', 'oversized'])('does not infer media stagnation with %s evidence', (change) => {
    const { snapshot, comparison } = mediaFixture('agent_video', 'agent_video_inspection');
    if (change === 'uninspected-before') snapshot.tasks[1].dependsOn = [];
    if (change === 'wrong-source') snapshot.tasks[4].dependsOn = ['media-before'];
    if (change === 'wrong-kind') snapshot.tasks[4].kind = 'agent_image_inspection';
    if (change === 'incomplete') snapshot.tasks[4].status = 'running';
    if (change === 'empty') snapshot.tasks[4].output = ' ';
    if (change === 'audio') snapshot.tasks[3].kind = 'agent_audio';
    if (change === 'oversized') snapshot.tasks[4].output = 'x'.repeat(13_000);
    expect(teamReviewProgressComparison(snapshot, 'review_2', comparison!.comparison.criteriaSha256)).toBeNull();
    expect(hasSemanticallyStalledTeamReview(snapshot, 'review_2')).toBe(false);
  });

  it.each(['report', 'source', 'dependency'])('invalidates a saved media assessment when its %s changes', (change) => {
    const { snapshot } = mediaFixture('agent_video', 'agent_video_inspection');
    if (change === 'report') snapshot.tasks[4].output = '采样中已正确保持蓝色并朝右';
    if (change === 'source') snapshot.tasks[3].output = '另一份附件已保存';
    if (change === 'dependency') snapshot.tasks[4].dependsOn.push('media-before');
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
