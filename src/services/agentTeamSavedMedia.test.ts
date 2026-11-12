import { describe, expect, it } from 'vitest';
import { directTeamMediaReferences, validateAgentTeamPlan } from './agentTeamPlan';
import { assertTeamSavedMedia, listTeamSavedMedia } from './agentTeamSavedMedia';
import type { WorkflowSnapshot } from './workflowRunRuntime';

function fixture(): WorkflowSnapshot {
  return { run: { id: 'run', chatId: 'chat', goal: '短片', status: 'completed', generation: 1, planVersion: 3, updatedAt: 1 }, tasks: [
    { id: 'shot', runId: 'run', kind: 'agent_video', input: { task: { tool: 'video_generation' } },
      output: '视频已保存', dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1 },
    { id: 'music', runId: 'run', kind: 'agent_audio', input: { task: { tool: 'audio_generation' } },
      output: '音乐已保存', dependsOn: [], status: 'completed', attempt: 2, updatedAt: 1 },
  ] };
}

function plan(snapshot = fixture()) {
  return validateAgentTeamPlan({ summary: '重新剪辑', finalAcceptance: '新成片可播放',
    roles: [{ id: 'editor', name: '剪辑师', responsibility: '剪辑配乐', method: '复用素材', acceptance: '可播放', allowedTools: ['media_composition'] }],
    tasks: [{ id: 'film', roleId: 'editor', goal: '重新剪辑', tool: 'media_composition', acceptance: '可播放', dependsOn: [],
      savedMedia: listTeamSavedMedia(snapshot, ['shot', 'music']).map((source) => ({ ...source, alias: `old_${source.taskId}` })),
      composition: { clips: [{ taskId: 'old_shot' }], audioTracks: [{ taskId: 'old_music' }] } }],
  });
}

describe('saved media in later plans', () => {
  it('allows saved images for reference and inspection, and a saved video for inspection', () => {
    const base = plan();
    const source = base.tasks[0].savedMedia![0];
    for (const tool of ['image_generation', 'video_generation', 'image_inspection', 'video_inspection'] as const) {
      const kind = tool === 'video_inspection' ? 'video' : 'image';
      const candidate = validateAgentTeamPlan({ ...base, roles: [{ ...base.roles[0], allowedTools: [tool] }],
        tasks: [{ id: 'inspect', roleId: base.roles[0].id, goal: '复用', acceptance: '有效', tool, dependsOn: [],
          savedMedia: [{ ...source, alias: 'old_media', kind }] }] });
      expect(directTeamMediaReferences(candidate.tasks[0], new Map(), kind)).toEqual(['old_media']);
      expect(() => validateAgentTeamPlan({ ...candidate, tasks: [{ ...candidate.tasks[0],
        savedMedia: [{ ...source, alias: 'old_media', kind: 'audio' }] }] })).toThrow('版本');
    }
    const snapshot = fixture();
    snapshot.tasks.push({ ...snapshot.tasks[0], id: 'image', kind: 'agent_image', input: { task: { tool: 'image_generation' } } });
    expect(listTeamSavedMedia(snapshot, ['image'])).toMatchObject([{ taskId: 'image', kind: 'image' }]);
    snapshot.tasks[2].input = { task: null };
    expect(listTeamSavedMedia(snapshot, ['image'])).toEqual([]);
  });

  it('binds eligible completed sources without copying output text or file addresses', () => {
    const snapshot = fixture();
    const catalog = listTeamSavedMedia(snapshot, ['shot', 'music']);
    expect(catalog).toMatchObject([{ taskId: 'shot', kind: 'video', attempt: 1 }, { taskId: 'music', kind: 'audio', attempt: 2 }]);
    expect(catalog[0].outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(catalog)).not.toContain('已保存');
    expect(() => assertTeamSavedMedia(plan(), snapshot, ['shot', 'music'])).not.toThrow();
    snapshot.tasks[0].status = 'waiting_external';
    expect(listTeamSavedMedia(snapshot, ['shot', 'music'])).toHaveLength(1);
  });

  it('rejects unauthorized, changed, foreign or incomplete sources before composition', () => {
    const saved = plan();
    expect(() => assertTeamSavedMedia(saved, fixture(), ['music'])).toThrow('范围或版本');
    for (const mutate of [
      (snapshot: WorkflowSnapshot) => { snapshot.tasks[0].output = '另一个结果'; },
      (snapshot: WorkflowSnapshot) => { snapshot.tasks[0].attempt++; },
      (snapshot: WorkflowSnapshot) => { snapshot.tasks[0].runId = 'other'; },
      (snapshot: WorkflowSnapshot) => { snapshot.tasks[0].status = 'failed'; },
    ]) {
      const snapshot = fixture();
      mutate(snapshot);
      expect(() => assertTeamSavedMedia(saved, snapshot, ['shot', 'music'])).toThrow();
    }
  });

  it('rejects invalid aliases, types, unused references and non-composition declarations', () => {
    const base = plan();
    const task = base.tasks[0];
    for (const change of [
      { savedMedia: [task.savedMedia![0], task.savedMedia![0]] },
      { savedMedia: task.savedMedia!.map((source) => ({ ...source, alias: 'film' })) },
      { savedMedia: task.savedMedia!.map((source) => ({ ...source, attempt: 0 })) },
      { savedMedia: task.savedMedia!.map((source) => ({ ...source, outputSha256: 'invalid' })) },
      { savedMedia: task.savedMedia!.map((source) => ({ ...source, kind: 'image' })) },
      { savedMedia: [...task.savedMedia!, { ...task.savedMedia![0], alias: 'unused' }] },
      { composition: { clips: [{ taskId: 'old_music' }] } },
      { tool: 'text_generation', composition: undefined },
    ]) expect(() => validateAgentTeamPlan({ ...base, tasks: [{ ...task, ...change }] })).toThrow();
  });
});
