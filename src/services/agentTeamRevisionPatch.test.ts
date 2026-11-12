import { describe, expect, it, vi } from 'vitest';
import { compileTeamRevisionPatch, parseTeamRevisionCompilation, type TeamRevisionBase } from './agentTeamRevisionPatch';
import { planAgentTeam, validateAgentTeamPlan } from './agentTeamPlan';
import { workflowJsonDigest } from './workflowToolRequest';
import { generateResponse } from './aiClient';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));

function fixture(): TeamRevisionBase {
  const tasks = [
    { id: 'image_a', tool: 'image_generation', dependsOn: [] },
    { id: 'video_a', tool: 'video_generation', dependsOn: ['image_a'] },
    { id: 'image_b', tool: 'image_generation', dependsOn: [] },
    { id: 'video_b', tool: 'video_generation', dependsOn: ['image_b'] },
    { id: 'music', tool: 'audio_generation', dependsOn: [] },
    { id: 'final', tool: 'media_composition', dependsOn: ['video_a', 'video_b', 'music'],
      composition: { clips: [{ taskId: 'video_a' }, { taskId: 'video_b' }], audioTracks: [{ taskId: 'music' }] } },
  ];
  const plan = validateAgentTeamPlan({ summary: '两镜头短片', finalAcceptance: '完整短片',
    roles: [{ id: 'maker', name: '制作', responsibility: '制作短片', method: '分镜制作', acceptance: '可播放',
      allowedTools: ['image_generation', 'video_generation', 'audio_generation', 'media_composition'] }],
    tasks: tasks.map((task) => ({ roleId: 'maker', goal: `制作${task.id}`, acceptance: '可使用', ...task })),
    resultTaskId: 'final',
  });
  return { plan, targetTaskId: 'image_a', savedText: [], savedMedia: tasks.filter((task) => task.id !== 'final').map((task) => ({
    taskId: task.id, kind: task.tool === 'image_generation' ? 'image' : task.tool === 'video_generation' ? 'video' : 'audio',
    attempt: 2, outputSha256: 'a'.repeat(64),
  })) };
}

const patchFor = (base: TeamRevisionBase, ids = [base.targetTaskId]) => ({ schemaVersion: 1,
  basePlanSha256: workflowJsonDigest(base.plan), updates: ids.map((taskId) => ({ taskId, goal: '改成雨夜', acceptance: '体现雨滴' })) });

describe('deterministic team revision compilation', () => {
  it('rebuilds only the changed branch and final composition, pins other media versions', () => {
    const base = fixture();
    const original = JSON.stringify(base);
    const compiled = validateAgentTeamPlan(compileTeamRevisionPatch(patchFor(base), base));
    expect(compiled.tasks.map((task) => task.id)).toEqual(['image_a', 'video_a', 'final']);
    expect(compiled.tasks[2].dependsOn).toEqual(['video_a']);
    expect(compiled.tasks[2].savedMedia).toEqual(base.savedMedia.filter((item) => ['video_b', 'music'].includes(item.taskId))
      .map((item) => ({ ...item, alias: item.taskId })));
    expect(compiled.tasks[2].composition).toEqual(base.plan.tasks[5].composition);
    expect(compiled.revisionCompilation).toMatchObject({ changedTaskIds: ['image_a'], rerunTaskIds: ['image_a', 'video_a', 'final'], reusedTaskIds: ['video_b', 'music'] });
    expect(JSON.stringify(base)).toBe(original);
    expect(validateAgentTeamPlan(JSON.parse(JSON.stringify(compiled)))).toEqual(compiled);
  });

  it('takes the union of changed branches without regenerating music', () => {
    const base = fixture();
    const result = validateAgentTeamPlan(compileTeamRevisionPatch(patchFor(base, ['image_a', 'image_b']), base));
    expect(result.tasks.map((task) => task.id)).toEqual(['image_a', 'video_a', 'image_b', 'video_b', 'final']);
    expect(result.revisionCompilation?.reusedTaskIds).toEqual(['music']);
  });

  it('pins actual runtime sources while preserving local composition aliases in later revisions', () => {
    const original = fixture();
    const taskSources = Object.fromEntries(original.plan.tasks.map((task) => [task.id, `delegated_${task.id}`]));
    const base = { ...original, targetTaskId: 'final', taskSources,
      savedMedia: original.savedMedia.map((entry) => ({ ...entry, taskId: taskSources[entry.taskId] })) };
    const result = validateAgentTeamPlan(compileTeamRevisionPatch(patchFor(base), base));
    expect(result.tasks.map((task) => task.id)).toEqual(['final']);
    expect(result.tasks[0].savedMedia?.map((entry) => [entry.alias, entry.taskId])).toEqual([
      ['video_a', 'delegated_video_a'], ['video_b', 'delegated_video_b'], ['music', 'delegated_music'],
    ]);
    expect(result.tasks[0].composition).toEqual(original.plan.tasks[5].composition);
    for (const mapping of [{}, { ...taskSources, final: taskSources.music }, { ...taskSources, wrong: 'wrong' }]) {
      expect(() => compileTeamRevisionPatch(patchFor(base), { ...base, taskSources: mapping })).toThrow('对应关系无效');
    }
  });

  it('pins an unchanged script body for narration and preserves the speech binding', () => {
    const plan = validateAgentTeamPlan({ summary: '配音', finalAcceptance: '清晰',
      roles: [{ id: 'maker', name: '制作', responsibility: '旁白', method: '朗读', acceptance: '可听', allowedTools: ['text_generation', 'speech_generation'] }],
      tasks: [{ id: 'script', roleId: 'maker', goal: '写旁白', acceptance: '完整', dependsOn: [] },
        { id: 'voice', roleId: 'maker', goal: '朗读', acceptance: '自然', tool: 'speech_generation', dependsOn: ['script'], speech: { textTaskId: 'script' } }] });
    const base: TeamRevisionBase = { plan, targetTaskId: 'voice', savedMedia: [],
      savedText: [{ taskId: 'script', attempt: 1, outputSha256: 'b'.repeat(64) }] };
    const result = validateAgentTeamPlan(compileTeamRevisionPatch(patchFor(base), base));
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ dependsOn: [], speech: { textTaskId: 'script' }, savedText: [{ ...base.savedText[0], alias: 'script' }] });
  });

  it('refuses missing boundary versions instead of silently reissuing work', () => {
    const base = fixture();
    expect(() => compileTeamRevisionPatch(patchFor(base), { ...base, savedMedia: [] })).toThrow('缺少可固定版本');
  });

  it('rejects invalid patches before any compiled task can execute', () => {
    const base = fixture();
    const patch = patchFor(base);
    for (const bad of [null, { ...patch, schemaVersion: 2 }, { ...patch, basePlanSha256: 'f'.repeat(64) },
      { ...patch, tasks: [] }, { ...patch, updates: [] }, { ...patch, updates: [...patch.updates, ...patch.updates] },
      { ...patch, updates: [{ ...patch.updates[0], taskId: 'unknown' }] },
      { ...patch, updates: [{ ...patch.updates[0], taskId: 'music' }] },
      { ...patch, updates: [{ ...patch.updates[0], tool: 'video_generation' }] },
      { ...patch, updates: [{ taskId: 'image_a', goal: base.plan.tasks[0].goal, acceptance: base.plan.tasks[0].acceptance }] },
    ]) expect(() => compileTeamRevisionPatch(bad, base)).toThrow();
  });

  it('rejects a compilation record inconsistent with the executable graph', () => {
    const base = fixture();
    const compiled = compileTeamRevisionPatch(patchFor(base), base);
    expect(() => validateAgentTeamPlan({ ...compiled, tasks: compiled.tasks.slice(1) })).toThrow();
    expect(() => parseTeamRevisionCompilation({ ...compiled.revisionCompilation, reusedTaskIds: ['image_a'] })).toThrow();
  });

  it('compiles through the actual planning parser and enforces model capabilities', async () => {
    const base = fixture();
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '改为雨夜',
      revisionBase: base, savedMedia: base.savedMedia, imageGeneration: true, videoGeneration: true,
      videoReferenceImages: true, mediaComposition: true };
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify({ revisionPatch: patchFor(base) }));
    expect((await planAgentTeam(params)).tasks.map((task) => task.id)).toEqual(['image_a', 'video_a', 'final']);
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify({ revisionPatch: patchFor(base) }));
    await expect(planAgentTeam({ ...params, videoGeneration: false })).rejects.toThrow();
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify({ revisionPatch: patchFor(base) }));
    await expect(planAgentTeam({ ...params, savedMedia: [] })).rejects.toThrow('未授权或版本不符');
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify({ revisionPatch: patchFor(base) }));
    await expect(planAgentTeam({ ...params, revisionBase: undefined })).rejects.toThrow('不允许局部修订');
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(compileTeamRevisionPatch(patchFor(base), base)));
    await expect(planAgentTeam(params)).rejects.toThrow('只能由程序编译');
  });
});
