import { describe, expect, it } from 'vitest';
import { assistantTeamFailureReply, assistantTeamProgressMessage, assistantTeamTaskOutputMessages } from './assistantTeamProgress';
import type { WorkflowSnapshot } from './workflowRunRuntime';

function run(overrides: Partial<WorkflowSnapshot['run']> = {}, tasks: WorkflowSnapshot['tasks'] = []): WorkflowSnapshot {
  return { run: { id: 'team-run', chatId: 'chat', goal: 'make a video', status: 'active', generation: 1, planVersion: 1, updatedAt: 10, ...overrides }, tasks };
}

describe('assistant team progress presentation', () => {
  it('projects completed text task output into the chat while a run is still unresolved', () => {
    const snapshot = run({ status: 'failed', goalSpec: { sourceBranch: { enabled: false } } as never }, [
      { id: 'script', runId: 'team-run', kind: 'agent_text', input: { task: { goal: '编写短片剧本' } }, dependsOn: [],
        status: 'completed', attempt: 1, output: '镜头一：恐龙从树林中现身。', updatedAt: 5 },
    ]);
    const messages = assistantTeamTaskOutputMessages('chat', [snapshot]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'ai', content: '镜头一：恐龙从树林中现身。' });
    expect(messages[0]?.metadata?.agentTeamTaskOutput).toMatchObject({ runId: 'team-run', taskId: 'script' });
  });

  it('keeps task output attached to its source branch', () => {
    const snapshot = run({ goalSpec: { sourceBranch: { enabled: true, headNodeId: 'branch-a' } } as never }, [
      { id: 'script', runId: 'team-run', kind: 'agent_text', input: { task: { goal: '编写剧本' } }, dependsOn: [],
        status: 'completed', attempt: 1, output: '剧本正文', updatedAt: 5 },
    ]);
    expect(assistantTeamTaskOutputMessages('chat', [snapshot], new Set(['branch-b']))).toEqual([]);
    expect(assistantTeamTaskOutputMessages('chat', [snapshot], new Set(['branch-a']))).toHaveLength(1);
  });

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

  it('shows only the current step from a multi-step plan in the chat notice', () => {
    const snapshot = run({}, [
      { id: 'plan', runId: 'team-run', kind: 'team_plan', input: 'goal', dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1 },
      { id: 'image', runId: 'team-run', kind: 'agent_image', input: { task: { goal: 'Generate key frames' } }, dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: 2 },
      { id: 'inspect', runId: 'team-run', kind: 'agent_image_inspection', input: { task: { goal: 'Inspect the key frames' } }, dependsOn: ['image'], status: 'running', attempt: 1, updatedAt: 3 },
      { id: 'video', runId: 'team-run', kind: 'agent_video', input: { task: { goal: 'Render the video' } }, dependsOn: ['inspect'], status: 'waiting_dependency', attempt: 0, updatedAt: 3 },
    ]);
    const message = assistantTeamProgressMessage('chat', [snapshot]);
    expect(message?.content).toBe('检查媒体素材 · 进行中');
    expect(message?.metadata?.chatNotice?.details).toEqual(['Inspect the key frames · 进行中']);
    expect(message?.metadata?.chatNotice?.progress).toMatchObject({ completed: 2, total: 4 });
  });

  it('shows the capability failure and a model setup recovery hint in the assistant reply', () => {
    const reply = assistantTeamFailureReply('当前未配置视频模型');
    expect(reply).toContain('当前未配置视频模型');
    expect(reply).toContain('模型设置');
    expect(reply).toContain('工作台重试规划');
  });

  it('offers reconciliation for a blocked run', () => {
    const snapshot = run({ status: 'failed' }, [
      { id: 'image', runId: 'team-run', kind: 'agent_image', input: 'frame', dependsOn: [], status: 'result_unknown', attempt: 1, error: '运行权续期超时', updatedAt: 10 },
    ]);
    const notice = assistantTeamProgressMessage('chat', [snapshot]);
    expect(notice?.content).toContain('运行权续期超时');
    expect(notice?.metadata?.chatNotice?.action).toEqual({ kind: 'agent_team_reconcile', runId: 'team-run', label: '核对并继续' });
  });

  it('shows the recovery failure instead of the older image rejection', () => {
    const snapshot = run({ status: 'failed' }, [
      { id: 'image', runId: 'team-run', kind: 'agent_image', input: 'frame', dependsOn: [], status: 'failed', attempt: 1,
        error: '图片提示词被服务商内容审核拒绝', updatedAt: 8 },
      { id: 'recovery', runId: 'team-run', kind: 'team_recovery', input: {}, dependsOn: [], status: 'failed', attempt: 1,
        error: '主 Agent 未返回可解析的图片修订方案，已暂停以避免重复提交', updatedAt: 10 },
    ]);
    const notice = assistantTeamProgressMessage('chat', [snapshot]);
    expect(notice?.content).toContain('主 Agent 未返回可解析的图片修订方案');
    expect(notice?.content).not.toContain('图片提示词被服务商内容审核拒绝');
  });

  it('shows the main agent stop reason when the target cannot be revised', () => {
    const snapshot = run({ status: 'failed' }, [
      { id: 'image', runId: 'team-run', kind: 'agent_image', input: 'frame', dependsOn: [], status: 'failed', attempt: 1,
        error: '图片提示词被服务商内容审核拒绝', updatedAt: 8 },
      { id: 'recovery', runId: 'team-run', kind: 'team_recovery', input: {}, dependsOn: [], status: 'completed', attempt: 1,
        output: { action: 'stop', reason: '当前目标需要用户调整' }, updatedAt: 10 },
    ]);
    expect(assistantTeamProgressMessage('chat', [snapshot])?.content).toContain('当前目标需要用户调整');
  });

  it('shows automatic image revision without increasing delivery progress', () => {
    const snapshot = run({}, [
      { id: 'script', runId: 'team-run', kind: 'agent_text', input: 'script', dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1 },
      { id: 'image', runId: 'team-run', kind: 'agent_image', input: 'frame', dependsOn: ['script'], status: 'failed', attempt: 1,
        error: '图片提示词被服务商内容审核拒绝', updatedAt: 8 },
      { id: 'recovery', runId: 'team-run', kind: 'team_recovery', input: {}, dependsOn: ['script'], status: 'running', attempt: 1, updatedAt: 10 },
    ]);
    const notice = assistantTeamProgressMessage('chat', [snapshot]);
    expect(notice?.content).toBe('图片未通过服务商审核，正在调整画面');
    expect(notice?.metadata?.chatNotice?.progress).toMatchObject({ completed: 1, total: 2 });
    expect(notice?.metadata?.chatNotice?.action).toBeUndefined();
  });

  it('shows general recovery and does not count plan revisions as deliverables', () => {
    const snapshot = run({}, [
      { id: 'script', runId: 'team-run', kind: 'agent_text', input: 'script', dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1 },
      { id: 'inspect', runId: 'team-run', kind: 'agent_image_inspection', input: 'inspect', dependsOn: ['script'], status: 'failed', attempt: 1, error: '读取失败', updatedAt: 8 },
      { id: 'recovery', runId: 'team-run', kind: 'team_recovery', input: { targetTaskId: 'inspect' }, dependsOn: ['script'], status: 'running', attempt: 1, updatedAt: 10 },
      { id: 'revision', runId: 'team-run', kind: 'team_plan_revision', input: {}, dependsOn: ['script'], status: 'waiting_dependency', attempt: 0, updatedAt: 10 },
    ]);
    const notice = assistantTeamProgressMessage('chat', [snapshot]);
    expect(notice?.content).toBe('任务遇到问题，正在重新安排后续工作');
    expect(notice?.metadata?.chatNotice?.progress).toMatchObject({ completed: 1, total: 2 });
  });

  it('marks a persisted legacy lease error as missing its original cause', () => {
    const snapshot = run({ status: 'failed' }, [
      { id: 'image', runId: 'team-run', kind: 'agent_image', input: 'frame', dependsOn: [], status: 'result_unknown', attempt: 1,
        error: '会话运行权已失效，请重新恢复任务', updatedAt: 10 },
    ]);
    expect(assistantTeamProgressMessage('chat', [snapshot])?.content).toContain('无法从旧记录判断');
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
