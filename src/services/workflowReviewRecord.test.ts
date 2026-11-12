import { describe, expect, it } from 'vitest';
import type { WorkflowSnapshot } from './workflowRunRuntime';
import { parseWorkflowReviewRecord, parseWorkflowReviewVerdict, prepareWorkflowReviewRecord } from './workflowReviewRecord';

function fixture(): WorkflowSnapshot {
  return { run: { id: 'run', chatId: 'chat', goal: '报告', status: 'active', generation: 1, planVersion: 3, updatedAt: 1 }, tasks: [
    { id: 'write', runId: 'run', kind: 'agent_text', input: null, dependsOn: [], status: 'completed', attempt: 2, output: '完整报告及私有来源', updatedAt: 1 },
    { id: 'review', runId: 'run', kind: 'team_review', input: null, dependsOn: ['write'], status: 'running', attempt: 1, updatedAt: 1 },
  ] };
}
const evidence = [{ task: 'write', output: '完整报告' }];
const verdict = { complete: true, reason: '通过' };

describe('versioned workflow reviews', () => {
  it('binds the claimed attempt, full source output and actual truncated evidence without copying them', () => {
    const result = prepareWorkflowReviewRecord(fixture(), 'review', '可读', evidence)(verdict);
    expect(result).toMatchObject({ schemaVersion: 1, runId: 'run', taskId: 'review', attempt: 1, planVersion: 3,
      sources: [{ taskId: 'write', kind: 'agent_text', attempt: 2 }] });
    expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('私有来源');
    expect(JSON.stringify(result)).not.toContain('完整报告');
    expect(parseWorkflowReviewRecord(structuredClone(result))).toEqual(result);
  });

  it('freezes evidence before the model returns and distinguishes later source or criteria changes', () => {
    const snapshot = fixture();
    const finish = prepareWorkflowReviewRecord(snapshot, 'review', '可读', evidence);
    snapshot.tasks[0].output = '修改后的交付';
    const old = finish(verdict);
    const next = prepareWorkflowReviewRecord(snapshot, 'review', '可读', evidence)(verdict);
    expect(old.sources[0].outputSha256).not.toBe(next.sources[0].outputSha256);
    expect(old.evidenceSha256).toBe(next.evidenceSha256);
    expect(prepareWorkflowReviewRecord(snapshot, 'review', '需来源', evidence)(verdict).criteriaSha256).not.toBe(old.criteriaSha256);
    expect(prepareWorkflowReviewRecord(snapshot, 'review', '可读', [{ task: 'write', output: '修改' }])(verdict).evidenceSha256).not.toBe(old.evidenceSha256);
  });

  it('keeps legacy verdicts readable without fabricating provenance', () => {
    expect(parseWorkflowReviewVerdict({ complete: false, reason: ' 缺少来源 ', nextRequest: ' 补充来源 ' }))
      .toEqual({ complete: false, reason: '缺少来源', nextRequest: '补充来源' });
    expect(() => parseWorkflowReviewRecord(verdict)).toThrow();
    expect(() => parseWorkflowReviewVerdict({ complete: false, reason: '缺少来源' })).toThrow('后续任务');
    const historical = fixture();
    historical.tasks[0].attempt = 0;
    expect(prepareWorkflowReviewRecord(historical, 'review', '可读', evidence)(verdict).sources[0].attempt).toBe(0);
  });

  it('rejects unknown versions, malformed hashes and duplicate evidence sources', () => {
    const result = prepareWorkflowReviewRecord(fixture(), 'review', '可读', evidence)(verdict);
    for (const change of [{ schemaVersion: 2 }, { attempt: 0 }, { planVersion: 0 }, { reviewedAt: Infinity },
      { criteriaSha256: 'invalid' }, { sources: [...result.sources, ...result.sources] }]) {
      expect(() => parseWorkflowReviewRecord({ ...result, ...change })).toThrow();
    }
    expect(parseWorkflowReviewRecord({ ...result, apiKey: 'secret' })).toEqual(result);
  });

  it('rejects unclaimed review tasks and incomplete sources', () => {
    const snapshot = fixture();
    snapshot.tasks[1].status = 'queued';
    expect(() => prepareWorkflowReviewRecord(snapshot, 'review', '可读', evidence)).toThrow('尚未领取');
    snapshot.tasks[1].status = 'running';
    snapshot.tasks[0].status = 'failed';
    expect(() => prepareWorkflowReviewRecord(snapshot, 'review', '可读', evidence)).toThrow('尚未就绪');
    snapshot.tasks[0].status = 'completed';
    expect(() => prepareWorkflowReviewRecord(snapshot, 'review', '可读', [...evidence, ...evidence])).toThrow('来源记录');
  });
});
