import { describe, expect, it } from 'vitest';
import { assistantTeamFailureReply, assistantTeamProgressMessage } from './assistantTeamProgress';
import type { WorkflowSnapshot } from './workflowRunRuntime';

function run(overrides: Partial<WorkflowSnapshot['run']> = {}, tasks: WorkflowSnapshot['tasks'] = []): WorkflowSnapshot {
  return { run: { id: 'team-run', chatId: 'chat', goal: 'make a video', status: 'active', generation: 1, planVersion: 1, updatedAt: 10, ...overrides }, tasks };
}

describe('assistant team progress presentation', () => {
  it('summarizes the current work without exposing serialized task data', () => {
    const snapshot = run({}, [
      { id: 'plan', runId: 'team-run', kind: 'team_plan', input: 'goal', dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1 },
      { id: 'video', runId: 'team-run', kind: 'agent_video', input: { task: { goal: 'Render the final clip', acceptance: 'playable' }, role: { name: 'Video maker' } }, dependsOn: ['plan'], status: 'waiting_external', attempt: 1, updatedAt: 10 },
    ]);
    const message = assistantTeamProgressMessage('chat', [snapshot]);
    expect(message?.content).toBe('生成视频 · 等待视频生成');
    expect(message?.metadata?.chatNotice?.progress).toMatchObject({ completed: 1, total: 2 });
    expect(message?.metadata?.chatNotice?.details).toContain('Render the final clip · 等待视频生成');
    expect(JSON.stringify(message)).not.toContain('"acceptance"');
  });

  it('shows the capability failure and a model setup recovery hint in the assistant reply', () => {
    const reply = assistantTeamFailureReply('当前未配置视频模型');
    expect(reply).toContain('当前未配置视频模型');
    expect(reply).toContain('模型设置');
    expect(reply).toContain('工作台重试规划');
  });

  it('shows progress only when its source belongs to the visible message branch', () => {
    const oldBranch = run({ id: 'team-old-user', goalSpec: {
      schemaVersion: 1, objective: 'make a video', constraints: [], acceptance: [], allowedTools: [],
      execution: { location: 'client', recovery: 'safe_steps_only', maxConcurrentTasks: 3, maxAutomaticReviewRounds: 3 },
      sourceBranch: { enabled: true, name: 'main', headNodeId: 'old-user' },
    } });
    const currentBranch = run({ id: 'team-new-user', updatedAt: 20, goalSpec: {
      ...oldBranch.run.goalSpec!, sourceBranch: { enabled: true, name: 'main', headNodeId: 'new-user' },
    } });
    expect(assistantTeamProgressMessage('chat', [oldBranch], new Set(['new-user']))).toBeNull();
    expect(assistantTeamProgressMessage('chat', [oldBranch, currentBranch], new Set(['new-user']))?.metadata?.chatNotice?.details)
      .toEqual([]);
    expect(assistantTeamProgressMessage('chat', [oldBranch], new Set(['old-user']))?.content).toBeTruthy();
  });
});
