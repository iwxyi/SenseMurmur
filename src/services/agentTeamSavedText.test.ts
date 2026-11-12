import { describe, expect, it } from 'vitest';
import { validateAgentTeamPlan } from './agentTeamPlan';
import { listTeamSavedText, resolveTeamSavedText } from './agentTeamSavedText';
import type { WorkflowSnapshot } from './workflowRunRuntime';

function fixture(): WorkflowSnapshot {
  return { run: { id: 'run', chatId: 'chat', goal: '制作短片', status: 'completed', generation: 1, planVersion: 2, updatedAt: 1 }, tasks: [
    { id: 'script', runId: 'run', kind: 'agent_text', input: {}, output: '需要逐字保留的原稿。', dependsOn: [], status: 'completed', attempt: 2, updatedAt: 1 },
  ] };
}

function plan(tool = 'text_generation', snapshot = fixture()) {
  return { summary: '复用原稿', finalAcceptance: '准确',
    roles: [{ id: 'writer', name: '作者', responsibility: '制作', method: '复用', acceptance: '准确', allowedTools: [tool] }],
    tasks: [{ id: 'reuse', roleId: 'writer', goal: '复用', acceptance: '准确', tool, dependsOn: [],
      savedText: listTeamSavedText(snapshot, ['script']).map((entry) => ({ ...entry, alias: 'original' })),
      ...(tool === 'speech_generation' ? { speech: { textTaskId: 'original' } } : {}) }],
  };
}

describe('saved text in later plans', () => {
  it('binds the exact original output and only catalogs authorized completed text', () => {
    const snapshot = fixture();
    const references = listTeamSavedText(snapshot, ['script']);
    expect(references).toEqual([{ taskId: 'script', attempt: 2, outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const task = validateAgentTeamPlan(plan()).tasks[0];
    expect(resolveTeamSavedText(task, snapshot, ['script'])).toEqual([{ alias: 'original', taskId: 'script', content: snapshot.tasks[0].output }]);
    expect(listTeamSavedText(snapshot, [])).toEqual([]);
    expect(listTeamSavedText(snapshot, ['script', 'script'])).toHaveLength(1);
    expect(JSON.stringify(references)).not.toContain('原稿');
  });

  it('rejects changed versions, unauthorized or foreign tasks and unavailable original text', () => {
    const task = validateAgentTeamPlan(plan()).tasks[0];
    expect(() => resolveTeamSavedText(task, fixture(), [])).toThrow('范围');
    for (const change of [
      { output: '新稿' }, { attempt: 3 }, { status: 'waiting_external' as const }, { runId: 'other' },
      { output: '长'.repeat(12_001) }, { output: '' }, { output: {} }, { kind: 'agent_video' },
      { kind: 'agent_delegation', input: { task: { tool: 'delegate_task', mediaOutput: 'video' } } },
    ]) {
      const snapshot = fixture();
      Object.assign(snapshot.tasks[0], change);
      expect(() => resolveTeamSavedText(task, snapshot, ['script'])).toThrow('历史文字');
    }
    expect(resolveTeamSavedText({ ...task, savedText: undefined }, fixture(), [])).toEqual([]);
  });

  it('supports exact text in generation and delegation without adding historical aliases to the DAG', () => {
    for (const tool of ['text_generation', 'image_generation', 'video_generation', 'audio_generation', 'speech_generation', 'delegate_task']) {
      const task = validateAgentTeamPlan(plan(tool)).tasks[0];
      expect(task.dependsOn).toEqual([]);
      expect(resolveTeamSavedText(task, fixture(), ['script'])[0].content).toBe('需要逐字保留的原稿。');
    }
  });

  it('rejects ambiguous narration, alias collisions, duplicate sources and malformed versions', () => {
    const base = plan();
    const task = base.tasks[0];
    const reference = task.savedText[0];
    for (const change of [
      { savedText: [] }, { savedText: [{ ...reference, alias: 'reuse' }] },
      { savedText: [{ ...reference, attempt: 0 }] }, { savedText: [{ ...reference, outputSha256: 'wrong' }] },
      { savedText: [reference, { ...reference, alias: 'other' }] },
      { savedText: [reference, { ...reference, taskId: 'other' }] },
      { dependsOn: ['original'] },
    ]) expect(() => validateAgentTeamPlan({ ...base, tasks: [{ ...task, ...change }] })).toThrow();
    const speech = plan('speech_generation');
    for (const change of [
      { speech: { text: 'literal' } }, { speech: { textTaskId: 'missing' } }, { dependsOn: ['original'] },
      { savedText: [reference, { ...reference, alias: 'other', taskId: 'other' }] },
    ]) expect(() => validateAgentTeamPlan({ ...speech, tasks: [{ ...speech.tasks[0], ...change }] })).toThrow();
    expect(() => validateAgentTeamPlan(plan('web_search'))).toThrow('工具');
  });
});
