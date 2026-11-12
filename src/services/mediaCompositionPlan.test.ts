import { describe, expect, it } from 'vitest';
import { validateMediaCompositionPlan } from './mediaCompositionPlan';
import { validateAgentTeamPlan } from './agentTeamPlan';

const plan = () => ({
  summary: '制作两镜头配乐短片', finalAcceptance: '交付合成成片',
  roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '按分镜执行', acceptance: '成片可用', allowedTools: ['video_generation', 'audio_generation', 'media_composition'] }],
  tasks: [
    { id: 'shot_a', roleId: 'director', goal: '镜头一', dependsOn: [], acceptance: '画面已保存', tool: 'video_generation' },
    { id: 'shot_b', roleId: 'director', goal: '镜头二', dependsOn: [], acceptance: '画面已保存', tool: 'video_generation' },
    { id: 'music', roleId: 'director', goal: '配乐', dependsOn: [], acceptance: '音乐已保存', tool: 'audio_generation' },
    { id: 'film', roleId: 'director', goal: '合成', dependsOn: ['shot_a', 'shot_b', 'music'], acceptance: '成片已保存', tool: 'media_composition',
      composition: { clips: [{ taskId: 'shot_b', startSeconds: 1, durationSeconds: 3 }, { taskId: 'shot_a' }], audioTracks: [{ taskId: 'music', volume: 0.5, loop: true }], aspectRatio: '9:16' } },
  ],
});

describe('media composition plan', () => {
  it('preserves clip order and validated sound and crop settings through plan parsing', () => {
    const parsed = validateAgentTeamPlan(plan());
    expect(parsed.tasks[3].composition).toMatchObject({ clips: [{ taskId: 'shot_b', startSeconds: 1, durationSeconds: 3 }, { taskId: 'shot_a' }], audioTracks: [{ taskId: 'music', volume: 0.5, loop: true }], aspectRatio: '9:16' });
  });
  it('requires real direct video and music dependencies instead of arbitrary task references', () => {
    const missing = plan();
    missing.tasks[3].dependsOn = ['shot_a', 'music'];
    expect(() => validateAgentTeamPlan(missing)).toThrow('合成片段必须直接依赖');
    const wrongKind = plan();
    wrongKind.tasks[0].tool = 'audio_generation';
    expect(() => validateAgentTeamPlan(wrongKind)).toThrow('合成片段必须直接依赖');
    const wrongAudio = plan();
    wrongAudio.tasks[2].tool = 'video_generation';
    expect(() => validateAgentTeamPlan(wrongAudio)).toThrow('合成音轨必须直接依赖');
  });
  it('rejects unsafe crop, volume, malformed loop and unsupported frame settings', () => {
    expect(() => validateMediaCompositionPlan({ clips: [{ taskId: 'shot', startSeconds: -1 }] })).toThrow('片段起点');
    expect(() => validateMediaCompositionPlan({ clips: [{ taskId: 'shot', durationSeconds: 0 }] })).toThrow('片段时长');
    expect(() => validateMediaCompositionPlan({ clips: [{ taskId: 'shot' }], audioTracks: [{ taskId: 'music', volume: 8 }] })).toThrow('音轨音量');
    expect(() => validateMediaCompositionPlan({ clips: [{ taskId: 'shot' }], audioTracks: [{ taskId: 'music', loop: 'true' }] })).toThrow('循环参数');
    expect(() => validateMediaCompositionPlan({ clips: [{ taskId: 'shot' }], aspectRatio: '3:2' })).toThrow('画面比例');
  });
  it('supports many shots without the ordinary eight-dependency ceiling', () => {
    const source = plan();
    source.tasks = Array.from({ length: 40 }, (_, index) => ({ ...source.tasks[0], id: `shot_${index}` }));
    const film = plan().tasks[3];
    film.dependsOn = source.tasks.map((task) => task.id);
    film.composition = { clips: film.dependsOn.map((taskId) => ({ taskId })), audioTracks: [], aspectRatio: '9:16' } as typeof film.composition;
    source.tasks.push(film);
    expect(validateAgentTeamPlan(source).tasks.at(-1)?.composition?.clips).toHaveLength(40);
  });
});
