import { describe, expect, it } from 'vitest';
import type { WorkflowSnapshot } from './workflowRunRuntime';
import { completedTeamTextArtifactProjections } from './agentTeamTextArtifacts';

function snapshot(output = '# 分镜剧本'): WorkflowSnapshot {
  return {
    run: { id: 'run-1', chatId: 'chat-1', goal: '制作短片', status: 'active', generation: 1, planVersion: 1, updatedAt: 10 },
    tasks: [{
      id: 'script', runId: 'run-1', kind: 'agent_text', status: 'completed', attempt: 1,
      input: { task: { goal: '编写分镜', acceptance: '包含镜头时长', deliverable: { kind: 'document', title: '15 秒分镜剧本' } } },
      output, dependsOn: [], updatedAt: 10,
    }],
  } as WorkflowSnapshot;
}

describe('completedTeamTextArtifactProjections', () => {
  it('creates a stable partial artifact that final delivery can reuse', () => {
    const first = completedTeamTextArtifactProjections(snapshot(), []);
    expect(first).toHaveLength(1);
    expect(first[0].after).toMatchObject({
      id: 'team-artifact-team-delivery-run-1:script',
      sourceMessageId: 'team-delivery-run-1:script',
      title: '15 秒分镜剧本',
    });
    expect(first[0].after.currentVersionId).toMatch(/^team-artifact-team-delivery-run-1:script:task:1:[a-f0-9]{12}$/);
    expect(completedTeamTextArtifactProjections(snapshot(), [first[0].after])).toEqual([]);
    const revised = completedTeamTextArtifactProjections(snapshot('# 修改后分镜'), [first[0].after]);
    expect(revised[0].after.id).toBe(first[0].after.id);
    expect(revised[0].after.currentVersionId).not.toBe(first[0].after.currentVersionId);
    expect(revised[0].after.versions).toHaveLength(2);
    expect(new Set(revised[0].after.versions.map((version) => version.id)).size).toBe(2);
    expect(completedTeamTextArtifactProjections(snapshot(), [revised[0].after])).toEqual([]);
  });

  it('preserves a later user revision when the same task snapshot is replayed', () => {
    const first = completedTeamTextArtifactProjections(snapshot(), [])[0].after;
    const edited = {
      ...first,
      currentVersionId: `${first.id}:user:1`,
      versions: [...first.versions, { ...first.versions[0], id: `${first.id}:user:1`, content: '# 用户修改', stage: 'user_revision' as const }],
    };
    expect(completedTeamTextArtifactProjections(snapshot(), [edited])).toEqual([]);
  });

  it('does not publish incomplete work or imply final delivery', () => {
    const pending = snapshot();
    pending.tasks[0].status = 'waiting_external';
    expect(completedTeamTextArtifactProjections(pending, [])).toEqual([]);
    expect(completedTeamTextArtifactProjections(snapshot(), [])[0].after.title).not.toContain('已完成');
  });
});
