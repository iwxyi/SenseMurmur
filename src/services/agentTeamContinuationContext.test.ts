import { describe, expect, it } from 'vitest';
import type { WorkflowSnapshot } from './workflowRunRuntime';
import { priorTeamContinuationContext } from './agentTeamContinuationContext';

function priorRun(id: string, goal: string, updatedAt: number): WorkflowSnapshot {
  return { run: { id, chatId: 'chat', goal, status: 'failed', generation: 1, planVersion: 1, updatedAt }, tasks: [
    { id: 'script', runId: id, kind: 'agent_text', input: {}, dependsOn: [], status: 'completed', attempt: 1, output: '黄昏森林中，恐龙追赶机器猫。', updatedAt },
    { id: 'image', runId: id, kind: 'agent_image', input: {}, dependsOn: [], status: 'completed', attempt: 1, output: '图片已生成。', updatedAt },
  ] } as WorkflowSnapshot;
}

describe('agent team continuation context', () => {
  it('includes the latest related completed script and retained image count when the user requests continuation', () => {
    const context = priorTeamContinuationContext({ goal: '继续完成恐龙追机器猫视频，保留已生成剧本，不要重复图片', chatId: 'chat', runId: 'current',
      runs: [priorRun('older', '恐龙追机器猫视频', 1), priorRun('latest', '恐龙追机器猫短片', 2)] });
    expect(context).toContain('黄昏森林中，恐龙追赶机器猫。');
    expect(context).toContain('已有 1 个图片素材产物');
    expect(context).toContain('只补足尚未完成的目标');
  });

  it('does not pull unrelated run output into a new plan', () => {
    expect(priorTeamContinuationContext({ goal: '写一份产品报告', chatId: 'chat', runId: 'current', runs: [priorRun('other', '恐龙追机器猫视频', 1)] })).toBe('');
  });
});
