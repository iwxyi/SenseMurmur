import { describe, expect, it } from 'vitest';
import { validateAgentTeamPlan } from './agentTeamPlan';
import { assertTeamMediaOutput, resolveTeamDelegationMedia, resolveTeamMediaTask } from './agentTeamMediaReference';
import type { WorkflowSnapshot, WorkflowTask } from './workflowRunRuntime';

function fixture(): WorkflowSnapshot {
  const role = { id: 'artist', name: '画师', responsibility: '画图', method: '绘制', acceptance: '清晰', allowedTools: ['image_generation', 'delegate_task'] };
  const childPlan = validateAgentTeamPlan({ summary: '绘制', roles: [role], tasks: [{ id: 'frame', roleId: role.id, goal: '画森林', tool: 'image_generation', dependsOn: [], acceptance: '清晰' }], resultTaskId: 'frame', finalAcceptance: '图片' });
  const nestedPlan = validateAgentTeamPlan({ ...childPlan, tasks: [{ ...childPlan.tasks[0], id: 'nested', tool: 'delegate_task', mediaOutput: 'image' }], resultTaskId: 'nested' });
  const task = (id: string, input: unknown, extra: Partial<WorkflowTask> = {}): WorkflowTask => ({ id, runId: 'run', kind: 'agent_delegation', status: 'completed', attempt: 1, updatedAt: 1, dependsOn: [], input, ...extra });
  return {
    run: { id: 'run', chatId: 'chat', goal: '画森林', status: 'active', generation: 1, planVersion: 1, updatedAt: 1 },
    tasks: [
      task('art', { task: { tool: 'delegate_task', mediaOutput: 'image' } }, { expansion: { taskIds: ['opaque-child'], context: nestedPlan } }),
      task('opaque-child', { task: nestedPlan.tasks[0], sourcePlanTaskId: 'art' }, { expansion: { taskIds: ['opaque-file'], context: childPlan } }),
      task('opaque-file', { task: childPlan.tasks[0], sourcePlanTaskId: 'opaque-child' }, { kind: 'agent_image', output: '已保存，不含 URL' }),
    ],
  };
}

describe('exact delegated media references', () => {
  it('resolves recursive exports from saved membership without relying on ID prefixes or URLs', () => {
    expect(resolveTeamMediaTask(fixture(), 'art', 'image')).toBe('opaque-file');
    const snapshot = fixture();
    snapshot.tasks[0].status = 'running';
    expect(resolveTeamDelegationMedia(snapshot, snapshot.tasks[0], 'image')).toBe('opaque-file');
    expect(() => resolveTeamMediaTask(snapshot, 'art', 'image')).toThrow('尚未完成');
  });

  it.each(['wrong-kind', 'pending', 'other-run', 'missing', 'duplicate', 'wrong-parent', 'changed-contract', 'missing-export'])(
    'rejects invalid export: %s', (mode) => {
      const snapshot = fixture();
      const leaf = snapshot.tasks[2];
      if (mode === 'wrong-kind') leaf.kind = 'agent_audio';
      if (mode === 'pending') leaf.status = 'waiting_external';
      if (mode === 'other-run') leaf.runId = 'other';
      if (mode === 'missing') snapshot.tasks.pop();
      if (mode === 'duplicate') snapshot.tasks.push({ ...leaf });
      if (mode === 'wrong-parent') leaf.input = { ...(leaf.input as object), sourcePlanTaskId: 'other' };
      if (mode === 'changed-contract') leaf.input = { task: { tool: 'image_generation', id: 'frame', goal: 'changed' }, sourcePlanTaskId: 'opaque-child' };
      if (mode === 'missing-export') snapshot.tasks[1].expansion!.context = { ...(snapshot.tasks[1].expansion!.context as object), resultTaskId: undefined };
      expect(() => resolveTeamMediaTask(snapshot, 'art', 'image')).toThrow();
    },
  );

  it('rejects a child plan with an incompatible primary delivery', () => {
    const snapshot = fixture();
    const plan = validateAgentTeamPlan(snapshot.tasks[1].expansion!.context);
    expect(() => assertTeamMediaOutput(plan, 'video')).toThrow('符合父任务');
    expect(() => resolveTeamMediaTask(snapshot, 'art', 'audio')).toThrow('类型');
  });
});
