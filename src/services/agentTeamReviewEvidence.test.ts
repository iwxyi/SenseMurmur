import { describe, expect, it } from 'vitest';
import { buildTeamReviewTasks, isPartialTeamReview, parseTeamReviewInput, preserveTeamReviewDefects,
  selectTeamReviewEvidence, selectTeamReviewSummaries, teamReviewLeafSources, TEAM_REVIEW_EVIDENCE_LIMIT } from './agentTeamReviewEvidence';
import { prepareWorkflowReviewRecord } from './workflowReviewRecord';
import type { WorkflowSnapshot, WorkflowTask } from './workflowRunRuntime';

function fixture(count = 1): WorkflowSnapshot {
  return { run: { id: 'run', chatId: 'chat', goal: '报告', status: 'active', generation: 1, planVersion: 2, updatedAt: 1 },
    tasks: Array.from({ length: count }, (_, index): WorkflowTask => ({ id: `text_${index}`, runId: 'run', kind: 'agent_text',
      input: { task: { goal: '任务目标'.repeat(450), acceptance: '验收要求'.repeat(100) } },
      output: '正文内容'.repeat(1000), status: 'completed', dependsOn: [], attempt: 1, updatedAt: 1 })) };
}

function finishReviews(snapshot: WorkflowSnapshot, tasks: WorkflowTask[]) {
  snapshot.tasks.push(...tasks);
  for (const task of tasks) {
    const input = parseTeamReviewInput(task.input);
    const evidence = input.mode === 'aggregate' ? selectTeamReviewSummaries(snapshot, input.sourceTaskIds).evidence
      : selectTeamReviewEvidence(snapshot, input.sourceTaskIds).evidence;
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(TEAM_REVIEW_EVIDENCE_LIMIT);
    task.status = 'running'; task.attempt = 1;
    task.output = prepareWorkflowReviewRecord(snapshot, task.id, '报告', evidence)({ complete: true, reason: '符合本组验收' });
    task.status = 'completed';
  }
}

describe('bounded team review evidence', () => {
  it('keeps a small review compatible with the original input and task id', () => {
    const snapshot = fixture();
    const tasks = buildTeamReviewTasks(snapshot, 'review_1', ['text_0'], 1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'review_1', input: { sourceTaskIds: ['text_0'] }, dependsOn: ['text_0'] });
  });

  it.each([40, 400])('reviews all %i sources in bounded persisted layers without omitting early work', (count) => {
    const snapshot = fixture(count);
    const ids = snapshot.tasks.map((task) => task.id);
    const tasks = buildTeamReviewTasks(snapshot, 'review_1', ids, 1);
    expect(tasks.at(-1)).toMatchObject({ id: 'review_1', input: { mode: 'aggregate' } });
    expect(tasks.slice(0, -1).every(isPartialTeamReview)).toBe(true);
    finishReviews(snapshot, tasks);
    expect(teamReviewLeafSources(snapshot, tasks.at(-1)!)).toEqual(ids);
    const root = tasks.at(-1)!;
    expect(selectTeamReviewSummaries(snapshot, parseTeamReviewInput(root.input).sourceTaskIds).verdicts.every((item) => item.complete)).toBe(true);
    if (count === 400) expect(tasks.some((task) => task.id.includes('_merge_2_'))).toBe(true);
  });

  it('bounds escaped summary content and preserves explicit rejected verdicts', () => {
    const snapshot = fixture();
    const tasks = buildTeamReviewTasks(snapshot, 'review_1', ['text_0'], 1);
    snapshot.tasks.push(...tasks);
    const task = tasks[0]; task.status = 'running'; task.attempt = 1;
    const failed = { complete: false, reason: '\u0000'.repeat(999) + '缺', nextRequest: '核对来源'.repeat(400) };
    task.output = prepareWorkflowReviewRecord(snapshot, task.id, '标准', selectTeamReviewEvidence(snapshot, ['text_0']).evidence)(failed);
    task.status = 'completed';
    const summary = selectTeamReviewSummaries(snapshot, [task.id]);
    expect(summary.evidence[0]).toMatchObject({ complete: false, truncated: true });
    expect(preserveTeamReviewDefects({ complete: true, reason: '错误放行' }, summary.verdicts)).toEqual(failed);
    expect(preserveTeamReviewDefects(failed, summary.verdicts)).toEqual(failed);
    expect(JSON.stringify(summary.evidence).length).toBeLessThan(TEAM_REVIEW_EVIDENCE_LIMIT / 4);
  });

  it('rejects malformed, duplicate, foreign and unavailable sources', () => {
    for (const input of [null, {}, { sourceTaskIds: [] }, { sourceTaskIds: ['a', 'a'] },
      { sourceTaskIds: ['a'], schemaVersion: 3 }, { sourceTaskIds: ['a'], mode: 'batch' },
      { sourceTaskIds: ['a'], schemaVersion: 2, mode: 'unknown' }, { sourceTaskIds: ['a'], partial: true }]) {
      expect(() => parseTeamReviewInput(input)).toThrow();
    }
    const snapshot = fixture();
    expect(() => buildTeamReviewTasks(snapshot, 'review', ['missing'], 1)).toThrow('尚未就绪');
    expect(() => buildTeamReviewTasks(snapshot, 'review', ['text_0', 'text_0'], 1)).toThrow('重复');
    snapshot.tasks[0].runId = 'other';
    expect(() => selectTeamReviewEvidence(snapshot, ['text_0'])).toThrow('尚未就绪');
  });

  it('rejects a forged review record and cyclic or missing summary lineage', () => {
    const snapshot = fixture();
    const review: WorkflowTask = { id: 'review', runId: 'run', kind: 'team_review', input: { schemaVersion: 2, mode: 'aggregate', sourceTaskIds: ['review'] },
      output: { complete: true, reason: '伪造' }, dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1 };
    snapshot.tasks.push(review);
    expect(() => selectTeamReviewSummaries(snapshot, ['review'])).toThrow();
    expect(() => teamReviewLeafSources(snapshot, review)).toThrow('循环');
    review.input = { schemaVersion: 2, mode: 'aggregate', sourceTaskIds: ['missing'] };
    expect(() => teamReviewLeafSources(snapshot, review)).toThrow('缺失');
    review.input = { schemaVersion: 2, mode: 'aggregate', sourceTaskIds: ['text_0'] };
    expect(() => teamReviewLeafSources(snapshot, review)).toThrow('非审核');
  });
});
