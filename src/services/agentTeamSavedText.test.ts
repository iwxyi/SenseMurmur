import { describe, expect, it } from 'vitest';
import { validateAgentTeamPlan } from './agentTeamPlan';
import { listTeamSavedText, resolveTeamSavedText } from './agentTeamSavedText';
import type { WorkflowSnapshot } from './workflowRunRuntime';
import type { AssistantArtifactItem } from '../types/assistantArtifact';

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
  function editedArtifact(): AssistantArtifactItem {
    return { id: 'artifact', chatId: 'chat', sourceMessageId: 'team-delivery-run:script', title: '用户稿件', kind: 'document',
      currentVersionId: 'edited', createdAt: 1, updatedAt: 2, versions: [
        { id: 'original', artifactId: 'artifact', content: '原稿', sourceMessageId: 'team-delivery-run:script', createdAt: 1 },
        { id: 'edited', artifactId: 'artifact', content: '用户修改后的稿件。', sourceMessageId: 'team-delivery-run:script', createdAt: 2 },
      ] };
  }

  it('catalogs the edited artifact alongside original task output and pins the selected version', () => {
    const snapshot = fixture();
    const artifact = editedArtifact();
    const catalog = listTeamSavedText(snapshot, ['script'], [artifact]);
    expect(catalog).toHaveLength(2);
    expect(catalog[0].artifact).toEqual({ id: 'artifact', versionId: 'edited' });
    const task = { ...validateAgentTeamPlan(plan()).tasks[0], savedText: [{ ...catalog[0], alias: 'edited' }] };
    artifact.versions.push({ ...artifact.versions[1], id: 'later', content: '后续编辑', createdAt: 3 });
    artifact.currentVersionId = 'later';
    expect(resolveTeamSavedText(task, snapshot, ['script'], [artifact])[0].content).toBe('用户修改后的稿件。');
    expect(snapshot.tasks[0].output).toBe('需要逐字保留的原稿。');
    expect(JSON.stringify(catalog)).not.toContain('修改后的稿件');
  });

  it('pins multiple project files independently and rejects missing or mutated pinned files', () => {
    const snapshot = fixture();
    const artifact = editedArtifact();
    artifact.versions[1].files = [
      { id: 'main', path: 'src/main.ts', content: 'export const title = "原版本";' },
      { id: 'style', path: 'src/style.css', content: 'body { color: red; }' },
    ];
    const catalog = listTeamSavedText(snapshot, ['script'], [artifact]).filter((entry) => entry.artifact);
    expect(catalog).toHaveLength(2);
    const candidate = plan();
    const task = validateAgentTeamPlan({ ...candidate, tasks: [{ ...candidate.tasks[0],
      savedText: catalog.map((entry, index) => ({ ...entry, alias: `file_${index}` })) }] }).tasks[0];
    artifact.versions.push({ ...artifact.versions[1], id: 'later', files: [] });
    artifact.currentVersionId = 'later';
    expect(resolveTeamSavedText(task, snapshot, ['script'], [artifact]).map((entry) => entry.content))
      .toEqual(['export const title = "原版本";', 'body { color: red; }']);
    const pinned = artifact.versions[1].files!;
    pinned[0].content = 'changed';
    expect(() => resolveTeamSavedText(task, snapshot, ['script'], [artifact])).toThrow('正文已变化');
    pinned.splice(0, 1);
    expect(() => resolveTeamSavedText(task, snapshot, ['script'], [artifact])).toThrow('指定版本不可用');
  });

  it('excludes ambiguous or oversized files and never authorizes a different file with identical content', () => {
    const snapshot = fixture();
    const artifact = editedArtifact();
    artifact.versions[1].files = [
      { id: 'a', path: 'a.ts', content: 'same' }, { id: 'b', path: 'b.ts', content: 'same' },
      { id: 'duplicate', path: 'a.ts', content: 'other' },
      { id: 'long', path: 'long.ts', content: 'x'.repeat(12_001) },
    ];
    const catalog = listTeamSavedText(snapshot, ['script'], [artifact]).filter((entry) => entry.artifact);
    expect(catalog.map((entry) => entry.artifact?.filePath)).toEqual(['b.ts']);
    const task = { ...validateAgentTeamPlan(plan()).tasks[0], savedText: [{ ...catalog[0], alias: 'file' }] };
    task.savedText[0].artifact = { ...catalog[0].artifact!, filePath: 'a.ts' };
    expect(() => resolveTeamSavedText(task, snapshot, ['script'], [artifact])).toThrow('文字产物');
  });

  it('rejects deleted, foreign, mutated or missing artifact versions and multi-file inputs', () => {
    const snapshot = fixture();
    const catalog = listTeamSavedText(snapshot, ['script'], [editedArtifact()]);
    const task = { ...validateAgentTeamPlan(plan()).tasks[0], savedText: [{ ...catalog[0], alias: 'edited' }] };
    for (const mutate of [
      (item: AssistantArtifactItem) => { item.deletedAt = 3; },
      (item: AssistantArtifactItem) => { item.chatId = 'other'; },
      (item: AssistantArtifactItem) => { item.sourceMessageId = 'team-delivery-other:script'; },
      (item: AssistantArtifactItem) => { item.versions[1].content = '篡改同版本'; },
      (item: AssistantArtifactItem) => { item.versions.splice(1); },
      (item: AssistantArtifactItem) => { item.versions[1].artifactId = 'other'; },
      (item: AssistantArtifactItem) => { item.versions[1].content = '长'.repeat(12_001); },
      (item: AssistantArtifactItem) => { item.versions[1].files = [{ path: 'main.js', content: 'code' }]; },
    ]) {
      const artifact = editedArtifact();
      mutate(artifact);
      expect(() => resolveTeamSavedText(task, snapshot, ['script'], [artifact])).toThrow('文字产物');
    }
    expect(() => resolveTeamSavedText(task, snapshot, [], [editedArtifact()])).toThrow('范围');
  });

  it('allows a short edited artifact even when original task output exceeds the text input limit', () => {
    const snapshot = fixture();
    snapshot.tasks[0].output = '长'.repeat(12_001);
    const artifact = editedArtifact();
    const references = listTeamSavedText(snapshot, ['script'], [artifact]);
    expect(references).toHaveLength(1);
    expect(resolveTeamSavedText({ ...validateAgentTeamPlan(plan()).tasks[0], savedText: [{ ...references[0], alias: 'short' }] }, snapshot, ['script'], [artifact])[0].content)
      .toBe('用户修改后的稿件。');
  });

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
