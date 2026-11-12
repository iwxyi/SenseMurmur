import { describe, expect, it } from 'vitest';
import type { WorkflowSnapshot } from './workflowRunRuntime';
import { analyzeWorkflowRevisionImpact, parseWorkflowRevisionImpact } from './workflowRevisionImpact';

function fixture(): WorkflowSnapshot {
  return { run: { id: 'run', chatId: 'chat', goal: '视频', status: 'completed', generation: 1, planVersion: 3, updatedAt: 1 },
    tasks: [
      ['image', 'agent_image', []], ['video', 'agent_video', ['image']],
      ['music', 'agent_audio', []], ['composition', 'agent_media_composition', ['video', 'music']],
      ['parent', 'agent_delegate', ['composition']], ['review', 'team_review', ['parent']],
    ].map(([id, kind, dependsOn]) => ({ id: id as string, runId: 'run', kind: kind as string,
      dependsOn: dependsOn as string[], input: null, status: 'completed', attempt: 1, updatedAt: 1 })) };
}

describe('targeted workflow revision impact', () => {
  it('includes downstream composition, delegation and review without revising an unrelated input', () => {
    const result = analyzeWorkflowRevisionImpact(fixture(), 'image');
    expect(result).toEqual({ schemaVersion: 1, basePlanVersion: 3, targetTaskId: 'image',
      affectedTaskIds: ['image', 'video', 'composition', 'parent', 'review'], generatedMediaTaskIds: ['image', 'video'] });
    expect(parseWorkflowRevisionImpact(structuredClone(result))).toEqual(result);
  });

  it('includes context consumers conservatively and does not classify unstarted media as executed', () => {
    const snapshot = fixture();
    snapshot.tasks[1].attempt = 0;
    snapshot.tasks[2].dependsOn = ['image'];
    const result = analyzeWorkflowRevisionImpact(snapshot, 'image');
    expect(result.affectedTaskIds).toContain('music');
    expect(result.generatedMediaTaskIds).toEqual(['image', 'music']);
  });

  it('rejects missing, duplicate and foreign task references', () => {
    expect(() => analyzeWorkflowRevisionImpact(fixture(), 'missing')).toThrow();
    for (const mutate of [
      (snapshot: WorkflowSnapshot) => { snapshot.tasks.push(snapshot.tasks[0]); },
      (snapshot: WorkflowSnapshot) => { snapshot.tasks[1].runId = 'other'; },
      (snapshot: WorkflowSnapshot) => { snapshot.tasks[1].dependsOn = ['missing']; },
    ]) {
      const snapshot = fixture();
      mutate(snapshot);
      expect(() => analyzeWorkflowRevisionImpact(snapshot, 'image')).toThrow();
    }
  });

  it('rejects malformed versions and sets and copies only the persisted contract', () => {
    const result = analyzeWorkflowRevisionImpact(fixture(), 'image');
    for (const change of [{ schemaVersion: 2 }, { basePlanVersion: 0 }, { targetTaskId: 'missing' },
      { affectedTaskIds: ['image', 'image'] }, { affectedTaskIds: ['image', ' '] },
      { generatedMediaTaskIds: ['music'] }, { generatedMediaTaskIds: ['image', 'image'] }]) {
      expect(() => parseWorkflowRevisionImpact({ ...result, ...change })).toThrow();
    }
    const parsed = parseWorkflowRevisionImpact({ ...result, secret: 'private' });
    expect(parsed).toEqual(result);
    parsed.affectedTaskIds.push('new');
    expect(result.affectedTaskIds).not.toContain('new');
  });
});
