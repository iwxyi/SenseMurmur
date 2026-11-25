import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planAgentTeam, validateAgentRoleInput, validateAgentRoleOutput, validateAgentTeamPlan } from './agentTeamPlan';
import { generateResponse } from './aiClient';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));
beforeEach(() => vi.mocked(generateResponse).mockReset());

const valid = () => ({
  summary: '先研究，再写报告',
  roles: [{ id: 'researcher', name: '研究员', responsibility: '收集问题线索', method: '逐项比较并注明假设', acceptance: '列出证据与不确定性', allowedTools: ['text_generation'] }],
  tasks: [
    { id: 'research', roleId: 'researcher', goal: '分析需求', dependsOn: [], acceptance: '需求清单完整' },
    { id: 'report', roleId: 'researcher', goal: '写报告', dependsOn: ['research'], acceptance: '报告覆盖清单' },
  ],
  finalAcceptance: '交付报告',
});

describe('agent team plan', () => {
  it('treats the visible plan as the next executable stage in rolling mode', async () => {
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(valid()));
    await planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '完成复杂目标', rolling: true });
    const prompt = vi.mocked(generateResponse).mock.calls.at(-1)?.[1] || '';
    expect(prompt).toContain('持续规划');
    expect(prompt).toContain('只列当前有充分依据');
    expect(prompt).toContain('主 Agent 会读取真实产物');
  });
  it('tells the planner to add audio generation only when the user asks for audio', async () => {
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(valid()));
    await planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '生成一段视频', mediaComposition: true });
    const prompt = vi.mocked(generateResponse).mock.calls.at(-1)?.[1] || '';
    expect(prompt).toContain('只有用户明确要求生成音乐、伴奏或配音时才安排');
    expect(prompt).toContain('不得因为视频制作习惯');
    expect(prompt).toContain('只生成一个视频且不需要后期处理时，必须直接交付');
    expect(prompt).toContain('视频生成模型可能已生成原生音频');
    expect(prompt).toContain('导演级创作要求');
    expect(prompt).toContain('角色走位和动作节拍');
    expect(prompt).toContain('每条关键帧提示词重复视觉连续性基准');
    expect(prompt).toContain('完整成片提示词必须放在同一任务的 videoPrompt 字段');
    expect(prompt).toContain('不得期待运行时截断或拼接');
    expect(prompt).toContain('视频生成提示词：');
    expect(prompt).toContain('多张关键帧必须拆成多个 image_generation 任务');
    expect(prompt).toContain('每个任务只含对应的一条提示词');
    expect(prompt).toContain('上游正文供规划参考，系统不会自动拼入图片请求');
    expect(prompt).toContain('工具清单、岗位权限及工作流控制说明属于内部信息');
  });

  it('carries the verified single-clip duration workaround into the generated task plan', async () => {
    const candidate = { ...valid(), roles: [{ ...valid().roles[0], allowedTools: ['video_generation'] }],
      tasks: [{ id: 'shot', roleId: 'researcher', goal: '生成追逐镜头', videoPrompt: '雨夜后巷中机器猫奔跑，恐龙从后方追近。', dependsOn: [], tool: 'video_generation', videoDurationSeconds: 4, acceptance: '4秒镜头' }] };
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify({ ...candidate, tasks: [{ ...candidate.tasks[0], videoPrompt: undefined }] }))
      .mockResolvedValueOnce(JSON.stringify(candidate));
    const plan = await planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '制作15秒短片',
      videoGeneration: true, mediaComposition: true, videoExecutionNote: '4秒成功，5秒被拒绝' });
    expect(plan.tasks[0].videoDurationSeconds).toBe(4);
    expect(plan.tasks[0].videoPrompt).toBe('雨夜后巷中机器猫奔跑，恐龙从后方追近。');
    expect(generateResponse).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateResponse).mock.lastCall?.[1]).toContain('视频生成任务可通过 videoDurationSeconds');
    expect(vi.mocked(generateResponse).mock.lastCall?.[1]).toContain('4秒成功，5秒被拒绝');
  });

  it('normalizes serial video dependencies into independent clips and direct composition inputs', async () => {
    const role = { id: 'editor', name: '剪辑师', responsibility: '制作视频', method: '逐段生成并合成', acceptance: '成片可播放',
      allowedTools: ['video_generation', 'media_composition'] };
    const candidate = { summary: '生成独立片段后合成', roles: [role], finalAcceptance: '成片可播放', resultTaskId: 'film', tasks: [
      { id: 'shot_a', roleId: role.id, goal: '生成追逐开场', videoPrompt: '雨夜街巷中霸王龙冲入画面，机器猫开始奔跑。', tool: 'video_generation', videoDurationSeconds: 4, dependsOn: [], acceptance: '片段可播放' },
      { id: 'shot_b', roleId: role.id, goal: '生成追逐结尾', videoPrompt: '同一雨夜街巷中恐龙滑倒，机器猫冲出巷口。', tool: 'video_generation', videoDurationSeconds: 4, dependsOn: ['shot_a'], acceptance: '片段可播放' },
      { id: 'film', roleId: role.id, goal: '合成15秒成片', tool: 'media_composition', dependsOn: ['shot_b'],
        composition: { clips: [{ taskId: 'shot_a', durationSeconds: 4 }, { taskId: 'shot_b', durationSeconds: 3 }], aspectRatio: '16:9' }, acceptance: '可播放' },
    ] };
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
    const plan = await planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '制作视频',
      videoGeneration: true, mediaComposition: true, videoExecutionNote: '片段须独立生成' });
    expect(plan.tasks[1].dependsOn).toEqual([]);
    expect(plan.tasks[2].dependsOn).toEqual(['shot_b', 'shot_a']);
    expect(plan.tasks[2].composition?.clips.map((clip) => clip.taskId)).toEqual(['shot_a', 'shot_b']);
  });

  it('limits per-task duration to video-generation tasks and integer seconds', () => {
    const video = { ...valid().tasks[0], tool: 'video_generation', videoDurationSeconds: 4 };
    const role = { ...valid().roles[0], allowedTools: ['video_generation'] };
    expect(validateAgentTeamPlan({ ...valid(), roles: [role], tasks: [video] }).tasks[0].videoDurationSeconds).toBe(4);
    for (const invalid of [0, 4.5, 121, '4']) {
      expect(() => validateAgentTeamPlan({ ...valid(), roles: [role], tasks: [{ ...video, videoDurationSeconds: invalid }] })).toThrow('视频片段时长');
    }
    expect(() => validateAgentTeamPlan({ ...valid(), tasks: [{ ...valid().tasks[0], videoDurationSeconds: 4 }] })).toThrow('视频片段时长');
  });

  it('retries planning when the videoPrompt field is missing or malformed', async () => {
    const role = { ...valid().roles[0], allowedTools: ['video_generation'] };
    const invalid = { ...valid(), roles: [role], tasks: [{ id: 'shot', roleId: role.id, goal: '制作镜头', tool: 'video_generation', dependsOn: [], acceptance: '可播放' }] };
    const corrected = { ...invalid, tasks: [{ ...invalid.tasks[0], videoPrompt: '雨夜街巷，机器猫奔跑，恐龙追赶，3D动画电影风格。' }] };
    vi.mocked(generateResponse).mockResolvedValueOnce('{invalid-json').mockResolvedValueOnce(JSON.stringify(corrected));

    const plan = await planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '生成追逐视频', videoGeneration: true,
      maxVideoPromptLength: 1000 });

    expect(plan.tasks[0].videoPrompt).toBe(corrected.tasks[0].videoPrompt);
    expect(generateResponse).toHaveBeenCalledTimes(2);
  });

  it('persists semantic scope evidence only after validating every delegated goal', async () => {
    const candidate = { ...valid(), roles: [{ ...valid().roles[0], allowedTools: ['delegate_task', 'text_generation'] }],
      tasks: [{ ...valid().tasks[0], tool: 'delegate_task' }],
      delegationChecks: [{ taskId: 'research', status: 'narrower', reason: '仅分析需求，不承担完整产品交付' }] };
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '开发并交付产品', delegation: true,
      delegationAncestors: [{ goal: '开发并交付产品', acceptance: '可运行交付' }] };
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
    const plan = await planAgentTeam(params);
    expect(plan.delegationReview?.checks).toEqual(candidate.delegationChecks);
    expect(validateAgentTeamPlan(JSON.parse(JSON.stringify(plan))).delegationReview).toEqual(plan.delegationReview);
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify({ ...candidate, delegationChecks: undefined, delegationReview: plan.delegationReview }));
    await expect(planAgentTeam(params)).rejects.toThrow('范围检查记录');
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify({ ...candidate,
      delegationChecks: [{ ...candidate.delegationChecks[0], status: 'uncertain' }] }));
    await expect(planAgentTeam(params)).rejects.toThrow('范围无法确认');
  });
  it('preserves explicit approval requirements and rejects incomplete proposals', () => {
    const plan = valid();
    const approval = { summary: '确认研究方向', consequences: '确认后开始模型分析' };
    expect(validateAgentTeamPlan({ ...plan, tasks: [{ ...plan.tasks[0], approval }] }).tasks[0].approval).toEqual(approval);
    for (const invalid of [null, {}, { summary: '', consequences: '开始' }, { summary: '确认', consequences: ' ' }]) {
      expect(() => validateAgentTeamPlan({ ...plan, tasks: [{ ...plan.tasks[0], approval: invalid }] })).toThrow('审批');
    }
  });
  it('allows question answers as media context while requiring a separate narration writing task', () => {
    const plan = valid();
    const question = { ...plan.tasks[0], tool: 'user_input' };
    for (const tool of ['image_generation', 'audio_generation', 'video_generation']) {
      const candidate = { ...plan, roles: [{ ...plan.roles[0], allowedTools: ['user_input', tool] }],
        tasks: [question, { ...plan.tasks[1], tool }] };
      expect(validateAgentTeamPlan(candidate).tasks[1].tool).toBe(tool);
      expect(() => validateAgentTeamPlan({ ...candidate, tasks: [{ ...question, deliverable: { kind: 'document', title: '假答复' } }] })).toThrow('不能声明');
    }
    expect(() => validateAgentTeamPlan({ ...plan, roles: [{ ...plan.roles[0], allowedTools: ['user_input', 'speech_generation'] }],
      tasks: [question, { ...plan.tasks[1], tool: 'speech_generation', speech: { textTaskId: question.id } }] })).toThrow();
  });
  it('requires exact authorization for a pinned project file even if another file has the same digest', async () => {
    const source = { taskId: 'old', attempt: 1, outputSha256: 'a'.repeat(64), artifact: { id: 'project', versionId: 'v1', filePath: 'src/main.ts' } };
    const candidate = { ...valid(), tasks: [{ ...valid().tasks[0], savedText: [{ ...source, alias: 'main' }] }] };
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
    await expect(planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '修改代码',
      savedText: [{ ...source, artifact: { ...source.artifact, filePath: 'src/other.ts' } }] })).rejects.toThrow('未授权或版本不符');
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
    expect((await planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '修改代码', savedText: [source] }))
      .tasks[0].savedText?.[0].artifact?.filePath).toBe('src/main.ts');
  });
  it('keeps the user goal separate from long runtime planning context', async () => {
    const goal = '愿'.repeat(12_000);
    const context = '历史交付'.repeat(8_000);
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(valid()));
    await planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal, context });
    expect(vi.mocked(generateResponse).mock.lastCall?.[2]).toEqual([{ role: 'user', content: `${goal}\n${context}` }]);
  });

  it('rejects oversized goals or context before starting a model invocation', async () => {
    const beforeModelRequest = vi.fn();
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '继续任务', beforeModelRequest };
    const previousCalls = vi.mocked(generateResponse).mock.calls.length;
    await expect(planAgentTeam({ ...params, goal: '愿'.repeat(12_001) })).rejects.toThrow('用户目标无效');
    await expect(planAgentTeam({ ...params, context: '史'.repeat(128_001) })).rejects.toThrow('规划上下文无效');
    expect(beforeModelRequest).not.toHaveBeenCalled();
    expect(vi.mocked(generateResponse).mock.calls).toHaveLength(previousCalls);
  });

  it('preserves artifact version references and rejects guessed artifact IDs even with the same text digest', async () => {
    const reference = { taskId: 'old', attempt: 1, outputSha256: 'a'.repeat(64), artifact: { id: 'artifact', versionId: 'edited' } };
    const candidate = { ...valid(), tasks: [{ ...valid().tasks[0], savedText: [{ ...reference, alias: 'edited' }] }] };
    expect(validateAgentTeamPlan(candidate).tasks[0].savedText?.[0].artifact).toEqual(reference.artifact);
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '使用修改后的正文' };
    for (const source of [
      { ...reference, artifact: undefined }, { ...reference, artifact: { id: 'other', versionId: 'edited' } },
      { ...reference, artifact: { id: 'artifact', versionId: 'original' } },
    ]) {
      vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
      await expect(planAgentTeam({ ...params, savedText: [source] })).rejects.toThrow('未授权或版本不符');
    }
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
    expect((await planAgentTeam({ ...params, savedText: [reference] })).tasks[0].savedText?.[0].artifact).toEqual(reference.artifact);
    for (const artifact of [{ id: '', versionId: 'edited' }, { id: 'artifact' }, null]) {
      expect(() => validateAgentTeamPlan({ ...candidate, tasks: [{ ...candidate.tasks[0], savedText: [{ ...reference, alias: 'edited', artifact }] }] })).toThrow();
    }
  });

  it('enforces image reference capability and count for saved sources', async () => {
    const sources = [1, 2].map((index) => ({ taskId: `previous_${index}`, kind: 'image' as const, attempt: 1, outputSha256: String(index).repeat(64) }));
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '复用旧图', savedMedia: sources };
    for (const tool of ['image_generation', 'video_generation'] as const) {
      const candidate = { ...valid(), roles: [{ ...valid().roles[0], allowedTools: [tool] }],
        tasks: [{ id: 'edit', roleId: 'researcher', goal: '复用旧图', acceptance: '有效', tool, dependsOn: [],
          ...(tool === 'video_generation' ? { videoPrompt: '雨夜街巷中恐龙追赶机器猫。' } : {}),
          savedMedia: sources.map((source, index) => ({ ...source, alias: `old_${index}` })) }] };
      vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
      await expect(planAgentTeam({ ...params, imageGeneration: true, videoGeneration: true })).rejects.toThrow('不支持参考图片');
      if (tool === 'image_generation') {
        vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
        await expect(planAgentTeam({ ...params, imageGeneration: true, imageReferenceImages: true, maxImageReferenceImages: 1 })).rejects.toThrow('最多支持');
      }
      vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
      expect((await planAgentTeam({ ...params, imageGeneration: true, videoGeneration: true, imageReferenceImages: true, videoReferenceImages: true })).tasks[0].savedMedia).toHaveLength(2);
    }
  });

  it('permits only exact saved-media catalog entries in a new composition plan', async () => {
    const source = { taskId: 'previous_shot', kind: 'video' as const, attempt: 2, outputSha256: 'a'.repeat(64) };
    const candidate = { ...valid(), roles: [{ ...valid().roles[0], allowedTools: ['media_composition'] }],
      tasks: [{ id: 'film', roleId: 'researcher', goal: '重新剪辑', acceptance: '可播放', tool: 'media_composition', dependsOn: [],
        savedMedia: [{ ...source, alias: 'old_clip' }], composition: { clips: [{ taskId: 'old_clip' }] } }] };
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '重新剪辑', mediaComposition: true };
    for (const catalog of [undefined, [{ ...source, attempt: 1 }], [{ ...source, taskId: 'foreign' }], [{ ...source, outputSha256: 'b'.repeat(64) }]]) {
      vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
      await expect(planAgentTeam({ ...params, savedMedia: catalog })).rejects.toThrow('未授权或版本不符');
    }
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
    expect((await planAgentTeam({ ...params, savedMedia: [source] })).tasks[0].savedMedia).toEqual(candidate.tasks[0].savedMedia);
  });

  it('validates typed delegated exports and their use in composition and inspection', () => {
    const role = { ...valid().roles[0], allowedTools: ['delegate_task', 'video_generation', 'audio_generation', 'media_composition', 'video_inspection', 'text_generation'] };
    const video = { id: 'scene', roleId: role.id, goal: '制作镜头', acceptance: '视频', dependsOn: [], tool: 'delegate_task', mediaOutput: 'video' };
    const audio = { ...video, id: 'music', mediaOutput: 'audio' };
    const film = { ...video, id: 'film', tool: 'media_composition', mediaOutput: undefined, dependsOn: ['scene', 'music'], composition: { clips: [{ taskId: 'scene' }], audioTracks: [{ taskId: 'music' }] } };
    const candidate = { ...valid(), roles: [role], tasks: [video, audio, film], resultTaskId: 'film' };
    expect(validateAgentTeamPlan(candidate)).toMatchObject({ resultTaskId: 'film', tasks: [{ mediaOutput: 'video' }, { mediaOutput: 'audio' }, {}] });
    expect(() => validateAgentTeamPlan({ ...candidate, resultTaskId: 'missing' })).toThrow('媒体交付');
    expect(() => validateAgentTeamPlan({ ...candidate, tasks: [{ ...video, tool: 'video_generation' }] })).toThrow('只有委派任务');
    expect(() => validateAgentTeamPlan({ ...candidate, tasks: [{ ...video, mediaOutput: 'image' }, audio, film] })).toThrow('合成片段');
    expect(validateAgentTeamPlan({ ...candidate, tasks: [video, { ...film, id: 'inspect', tool: 'video_inspection', composition: undefined, dependsOn: ['scene'] }], resultTaskId: 'scene' }).resultTaskId).toBe('scene');
  });
  it('requires video inspection to read one direct saved video source', async () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['video_generation', 'video_inspection'];
    const shot = { ...plan.tasks[0], tool: 'video_generation', videoPrompt: '森林中恐龙追赶机器猫。' };
    const inspect = { ...plan.tasks[1], tool: 'video_inspection' };
    const candidate = { ...plan, tasks: [shot, inspect] };
    expect(validateAgentTeamPlan(candidate).tasks[1].tool).toBe('video_inspection');
    expect(() => validateAgentTeamPlan({ ...candidate, tasks: [shot, { ...inspect, dependsOn: [] }] })).toThrow('唯一');
    expect(() => validateAgentTeamPlan({ ...candidate, tasks: [shot, { ...shot, id: 'second' }, { ...inspect, dependsOn: ['research', 'second'] }] })).toThrow('唯一');
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
    await expect(planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o' }, goal: '检查视频', videoGeneration: true }))
      .rejects.toThrow('不支持视频抽帧检查');
  });
  it('accepts explicit narration text and a dedicated script dependency', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['text_generation', 'speech_generation'];
    const tasks = [plan.tasks[0], { ...plan.tasks[1], tool: 'speech_generation', speech: { textTaskId: 'research' } }];
    expect(validateAgentTeamPlan({ ...plan, tasks }).tasks[1].speech).toEqual({ textTaskId: 'research' });
    expect(validateAgentTeamPlan({ ...plan, tasks: [{ ...tasks[1], dependsOn: [], speech: { text: '欢迎来到森林。' } }] }).tasks[0].speech).toEqual({ text: '欢迎来到森林。' });
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [tasks[0], { ...tasks[1], speech: { text: '你好', textTaskId: 'research' } }] })).toThrow('只能选择一种');
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [tasks[0], { ...tasks[1], speech: { text: '你好' } }] })).toThrow('唯一的文字正文任务');
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [tasks[0], { ...tasks[1], speech: undefined }] })).toThrow('格式无效');
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [{ ...tasks[1], dependsOn: [], speech: { text: '字'.repeat(4_001) } }] })).toThrow('配音正文无效');
    expect(validateAgentTeamPlan({ ...plan, tasks: [{ ...tasks[1], dependsOn: [], speech: { text: '字'.repeat(4_000) } }] }).tasks[0].speech?.text).toHaveLength(4_000);
  });

  it('accepts narration in composition audio tracks while rejecting it as video generation input', () => {
    const role = { ...valid().roles[0], allowedTools: ['speech_generation', 'video_generation', 'media_composition'] };
    const speech = { id: 'voice', roleId: role.id, goal: '生成旁白', acceptance: '可播放', dependsOn: [], tool: 'speech_generation', speech: { text: '森林里一场追逐开始了。' } };
    const video = { id: 'shot', roleId: role.id, goal: '森林', acceptance: '可播放', dependsOn: [], tool: 'video_generation' };
    const film = { id: 'film', roleId: role.id, goal: '配音短片', acceptance: '可播放', dependsOn: ['voice', 'shot'], tool: 'media_composition', composition: { clips: [{ taskId: 'shot' }], audioTracks: [{ taskId: 'voice', volume: 1 }] } };
    expect(validateAgentTeamPlan({ ...valid(), roles: [role], tasks: [speech, video, film] }).tasks[2].composition?.audioTracks?.[0].taskId).toBe('voice');
    expect(() => validateAgentTeamPlan({ ...valid(), roles: [role], tasks: [speech, { ...video, dependsOn: ['voice'] }] })).toThrow('音视频合成工具');
  });

  it('accepts a bounded task graph with explicit role contracts', () => {
    const plan = validateAgentTeamPlan(valid());
    expect(plan.tasks[1].dependsOn).toEqual(['research']);
    expect(plan.schemaVersion).toBe(1);
    expect(plan.roles[0].schemaVersion).toBe(1);
    expect(plan.tasks[0].schemaVersion).toBe(1);
  });

  it('accepts forty shot tasks while keeping a hard plan limit', () => {
    const plan = valid();
    plan.tasks = Array.from({ length: 40 }, (_, index) => ({
      id: `shot_${index + 1}`, roleId: 'researcher', goal: `镜头 ${index + 1}`,
      dependsOn: index === 0 ? [] : [`shot_${index}`], acceptance: '有可核对结果',
    }));
    expect(validateAgentTeamPlan(plan).tasks).toHaveLength(40);
    plan.tasks.push(...Array.from({ length: 9 }, (_, index) => ({
      id: `extra_${index + 1}`, roleId: 'researcher', goal: '补充镜头', dependsOn: [], acceptance: '完成',
    })));
    expect(() => validateAgentTeamPlan(plan)).toThrow('规模超出限制');
  });

  it('migrates legacy plans and roles in memory while rejecting unknown contract versions', () => {
    const legacy = validateAgentTeamPlan(valid());
    expect(legacy).toMatchObject({ schemaVersion: 1, roles: [{ schemaVersion: 1, contractVersion: 1 }], tasks: [{ schemaVersion: 1 }, { schemaVersion: 1 }] });
    expect(() => validateAgentTeamPlan({ ...valid(), schemaVersion: 2 })).toThrow('团队计划版本不受支持');
    const unsupportedRole = valid();
    unsupportedRole.roles[0] = { ...unsupportedRole.roles[0], schemaVersion: 2 } as typeof unsupportedRole.roles[number];
    expect(() => validateAgentTeamPlan(unsupportedRole)).toThrow('岗位契约版本不受支持');
    unsupportedRole.roles[0] = { ...valid().roles[0], contractVersion: 2 } as typeof unsupportedRole.roles[number];
    expect(() => validateAgentTeamPlan(unsupportedRole)).toThrow('岗位实例契约版本不受支持');
    const unsupportedTask = valid();
    Object.assign(unsupportedTask.tasks[0], { schemaVersion: 2 });
    expect(() => validateAgentTeamPlan(unsupportedTask)).toThrow('任务契约版本不受支持');
  });

  it('validates versioned role input and output schemas at the contract boundary', () => {
    const candidate = valid();
    candidate.roles[0] = { ...candidate.roles[0], inputSchema: {
      type: 'object', properties: { taskGoal: { type: 'string' }, upstream: { type: 'array', items: { type: 'object' } } },
      required: ['taskGoal', 'upstream'], additionalProperties: false,
    }, outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };
    const role = validateAgentTeamPlan(candidate).roles[0];
    expect(role.contractVersion).toBe(1);
    validateAgentRoleInput(role, { taskGoal: '分析需求', upstream: [] });
    expect(() => validateAgentRoleInput(role, { taskGoal: 3, upstream: [] })).toThrow('不符合岗位契约字段要求');
    expect(validateAgentRoleOutput(role, '{"answer":"完成"}')).toBe('{"answer":"完成"}');
    expect(() => validateAgentRoleOutput(role, '```json\n{"answer":"完成"}\n```')).toThrow('要求纯 JSON');
    expect(() => validateAgentRoleOutput(role, '{"private":"do-not-leak"}')).toThrow('不符合岗位契约字段要求');
    expect(() => validateAgentTeamPlan({ ...candidate, tasks: [
      { ...candidate.tasks[0], tool: 'image_generation' },
    ], roles: [{ ...candidate.roles[0], allowedTools: ['image_generation'] }] })).toThrow('只适用于文本与委派任务');
  });

  it('validates optional typed deliverables and preserves legacy tasks without one', () => {
    const plan = valid();
    plan.tasks[0] = { ...plan.tasks[0], deliverable: { kind: 'table', title: '竞品对照表', language: 'markdown' } };
    const parsed = validateAgentTeamPlan(plan);
    expect(parsed.tasks[0].deliverable).toEqual({ schemaVersion: 1, kind: 'table', title: '竞品对照表', language: 'markdown' });
    expect(parsed.tasks[1].deliverable).toBeUndefined();
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [{ ...plan.tasks[0], deliverable: { kind: 'audio', title: '无效类型' } }, plan.tasks[1]] })).toThrow('交付类型无效');
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [{ ...plan.tasks[0], deliverable: { kind: 'table', title: '' } }, plan.tasks[1]] })).toThrow('交付标题无效');
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [{ ...plan.tasks[0], deliverable: { schemaVersion: 2, kind: 'json', title: '结果' } }, plan.tasks[1]] })).toThrow('交付契约版本');
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [{ ...plan.tasks[0], deliverable: { kind: 'table', title: '数据', language: 'html' } }] })).toThrow('表格');
    expect(() => validateAgentTeamPlan({ ...plan, roles: [{ ...plan.roles[0], allowedTools: ['image_generation'] }],
      tasks: [{ ...plan.tasks[0], tool: 'image_generation' }] })).toThrow('交付');
    const jsonSchema = { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] };
    const structured = { ...plan, tasks: [{ ...plan.tasks[0], deliverable: { kind: 'json', title: '结果', jsonSchema } }] };
    expect(validateAgentTeamPlan(structured).tasks[0].deliverable?.jsonSchema).toEqual(jsonSchema);
    expect(() => validateAgentTeamPlan({ ...structured, tasks: [{ ...plan.tasks[0], deliverable: { kind: 'table', title: '数据', jsonSchema } }] })).toThrow('仅 JSON');
  });

  it('keeps a media plan when the model attaches a redundant text deliverable to media tasks', async () => {
    const role = { ...valid().roles[0], allowedTools: ['text_generation', 'image_generation', 'video_generation'] };
    const candidate = { ...valid(), roles: [role], tasks: [
      { id: 'script', roleId: role.id, goal: '写 15 秒剧本', dependsOn: [], acceptance: '含分镜', tool: 'text_generation', deliverable: { kind: 'document', title: '剧本' } },
      { id: 'image', roleId: role.id, goal: '生成角色素材', dependsOn: ['script'], acceptance: '图片可用', tool: 'image_generation', deliverable: { kind: 'json', title: '图片素材' } },
      { id: 'film', roleId: role.id, goal: '生成视频', videoPrompt: '森林中恐龙追赶机器猫。', dependsOn: ['script', 'image'], acceptance: '视频可播放', tool: 'video_generation', deliverable: { kind: 'table', title: '成片' } },
    ], resultTaskId: 'film' };
    expect(() => validateAgentTeamPlan(candidate)).toThrow('文字产物只可由文本或委派任务交付');
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(candidate));
    const plan = await planAgentTeam({ api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '生成短片',
      imageGeneration: true, videoGeneration: true, videoReferenceImages: true });
    expect(plan.tasks.map((task) => task.deliverable?.kind)).toEqual(['document', undefined, undefined]);
    expect(plan.resultTaskId).toBe('film');
  });

  it('repairs a unique invalid composition source without issuing a second model request', async () => {
    vi.mocked(generateResponse).mockClear();
    const role = { ...valid().roles[0], allowedTools: ['text_generation', 'image_generation', 'video_generation', 'media_composition'] };
    const script = { id: 'script', roleId: role.id, goal: '写剧本', dependsOn: [], acceptance: '剧本完整', tool: 'text_generation' };
    const image = { id: 'image', roleId: role.id, goal: '生成参考图', dependsOn: ['script'], acceptance: '画面可用', tool: 'image_generation' };
    const shot = { id: 'shot', roleId: role.id, goal: '生成视频', videoPrompt: '森林中恐龙追赶机器猫。', dependsOn: ['script', 'image'], acceptance: '视频可播放', tool: 'video_generation' };
    const film = { id: 'film', roleId: role.id, goal: '合成成片', dependsOn: ['image', 'shot'], acceptance: '成片可播放', tool: 'media_composition', composition: { clips: [{ taskId: 'image' }] } };
    const invalid = { ...valid(), roles: [role], tasks: [script, image, shot, film], resultTaskId: 'film' };
    const repaired = { ...invalid, tasks: [script, image, shot, { ...film, dependsOn: ['shot'], composition: { clips: [{ taskId: 'shot' }] } }] };
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '剧本、图片、视频成片',
      imageGeneration: true, videoGeneration: true, videoReferenceImages: true, mediaComposition: true };
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(invalid));
    expect((await planAgentTeam(params)).tasks[3].composition?.clips[0].taskId).toBe('shot');
    expect(generateResponse).toHaveBeenCalledTimes(1);
    const alternateShot = { ...shot, id: 'alternate_shot' };
    const invalidAlternate = { ...invalid, tasks: [script, image, shot, alternateShot,
      { ...film, dependsOn: ['shot', 'alternate_shot', 'image'], composition: { clips: [{ taskId: 'image' }] } }] };
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(invalidAlternate)).mockResolvedValueOnce(JSON.stringify(invalidAlternate));
    await expect(planAgentTeam(params)).rejects.toThrow('合成片段必须直接依赖视频生成或合成任务');
  });

  it('aligns task tool declarations with their role without issuing a second model request', async () => {
    vi.mocked(generateResponse).mockClear();
    const invalid = { ...valid(), tasks: [{ ...valid().tasks[0], tool: 'image_generation' }] };
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '生成一张参考图', imageGeneration: true };
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(invalid));
    const plan = await planAgentTeam(params);
    expect(plan.tasks[0].tool).toBe('image_generation');
    expect(plan.roles[0].allowedTools).toContain('image_generation');
    expect(generateResponse).toHaveBeenCalledTimes(1);
  });

  it('repairs an unknown role tool identifier once and reports the exact identifier if repair fails', async () => {
    const invalid = { ...valid(), roles: [{ ...valid().roles[0], allowedTools: ['text_generation', 'shell'] }] };
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '写剧本' };
    vi.mocked(generateResponse).mockReset()
      .mockResolvedValueOnce(JSON.stringify(invalid))
      .mockResolvedValueOnce(JSON.stringify(valid()));

    const plan = await planAgentTeam(params);
    expect(plan.roles[0]?.allowedTools).toEqual(['text_generation']);
    expect(generateResponse).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateResponse).mock.calls[1]?.[2]?.[0]?.content).toContain('shell');

    vi.mocked(generateResponse).mockReset().mockResolvedValueOnce(JSON.stringify(invalid)).mockResolvedValueOnce(JSON.stringify(invalid));
    await expect(planAgentTeam(params)).rejects.toThrow('岗位“研究员”申请了工具目录外的标识：“shell”');
  });

  it('rejects unknown tools and missing role references', () => {
    const unknownTool = valid();
    unknownTool.roles[0].allowedTools = ['shell'];
    expect(() => validateAgentTeamPlan(unknownTool)).toThrow('岗位“研究员”申请了工具目录外的标识：“shell”');
    const missingRole = valid();
    missingRole.tasks[0].roleId = 'ghost';
    expect(() => validateAgentTeamPlan(missingRole)).toThrow('不存在的岗位');
  });

  it('accepts search only when the role declares the tool', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['text_generation', 'web_search'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'web_search' } as typeof plan.tasks[0];
    expect(validateAgentTeamPlan(plan).tasks[0].tool).toBe('web_search');
    plan.roles[0].allowedTools = ['text_generation'];
    expect(() => validateAgentTeamPlan(plan)).toThrow('团队计划内部工具不一致');
  });

  it('accepts video only when the role declares the tool', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['text_generation', 'video_generation'];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'video_generation', videoPrompt: '森林中恐龙追赶机器猫。' } as typeof plan.tasks[1];
    expect(validateAgentTeamPlan(plan).tasks[1].tool).toBe('video_generation');
    plan.roles[0].allowedTools = ['text_generation'];
    expect(() => validateAgentTeamPlan(plan)).toThrow('团队计划内部工具不一致');
  });

  it('accepts music generation only when the role declares the tool', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['audio_generation', 'text_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'audio_generation' } as typeof plan.tasks[0];
    expect(validateAgentTeamPlan(plan).tasks[0].tool).toBe('audio_generation');
    plan.roles[0].allowedTools = ['text_generation'];
    expect(() => validateAgentTeamPlan(plan)).toThrow('团队计划内部工具不一致');
  });

  it('rejects a media dependency that the music adapter cannot consume', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['image_generation', 'audio_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'image_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'audio_generation' } as typeof plan.tasks[1];
    expect(() => validateAgentTeamPlan(plan)).toThrow('只能依赖文字歌词或说明');
  });

  it('allows image generation to depend on another generated image', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['image_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'image_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'image_generation' } as typeof plan.tasks[1];
    expect(validateAgentTeamPlan(plan).tasks[1].dependsOn).toEqual(['research']);
  });

  it('rejects image references unsupported by the selected model before queueing', async () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['image_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'image_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'image_generation' } as typeof plan.tasks[1];
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(plan));
    await expect(planAgentTeam({ api: { provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'gpt' },
      goal: '根据前一张图继续画', imageGeneration: true, imageReferenceImages: false }))
      .rejects.toThrow('当前图片模型不支持参考图片');
  });

  it('rejects more image references than the model accepts', async () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['image_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'image_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'image_generation', dependsOn: [] } as typeof plan.tasks[1];
    plan.tasks.push({ id: 'combined', roleId: 'researcher', goal: '合并画面', dependsOn: ['research', 'report'], tool: 'image_generation', acceptance: '合并图已生成' });
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(plan));
    await expect(planAgentTeam({ api: { provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'gpt' },
      goal: '合并两张图', imageGeneration: true, imageReferenceImages: true, maxImageReferenceImages: 1 }))
      .rejects.toThrow('最多支持 1 张参考图片');
  });

  it('allows image generation to use the written result of an image inspection', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['image_generation', 'image_inspection'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'image_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'image_inspection' } as typeof plan.tasks[1];
    plan.tasks.push({ id: 'refined', roleId: 'researcher', goal: '根据检查文字重新生成', dependsOn: ['report'], tool: 'image_generation', acceptance: '新的图片可用' });
    expect(validateAgentTeamPlan(plan).tasks[2].dependsOn).toEqual(['report']);
  });

  it('rejects video depending on generated music because no audio composition tool exists', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['audio_generation', 'video_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'audio_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'video_generation', videoPrompt: '树林中恐龙追赶机器猫。' } as typeof plan.tasks[1];
    expect(() => validateAgentTeamPlan(plan)).toThrow('不能接收已生成的音乐或视频片段');
    plan.roles[0].allowedTools.push('text_generation');
    plan.tasks[1] = { ...plan.tasks[1], tool: 'text_generation', videoPrompt: undefined } as typeof plan.tasks[1];
    plan.tasks.push({ id: 'video', roleId: 'researcher', goal: '生成成片', videoPrompt: '树林中恐龙追赶机器猫。', dependsOn: ['report'], tool: 'video_generation', acceptance: '视频含音乐' });
    expect(() => validateAgentTeamPlan(plan)).toThrow('不能接收已生成的音乐或视频片段');
  });

  it('rejects chaining two video tasks as if the second could join the first clip', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['video_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'video_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'video_generation', videoPrompt: '树林中恐龙追赶机器猫。' } as typeof plan.tasks[1];
    expect(() => validateAgentTeamPlan(plan)).toThrow('不能接收已生成的音乐或视频片段');
  });

  it('requires image inspection to directly depend on generated images', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['image_generation', 'image_inspection'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'image_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'image_inspection' } as typeof plan.tasks[1];
    expect(validateAgentTeamPlan(plan).tasks[1].tool).toBe('image_inspection');
    plan.tasks[1].dependsOn = [];
    expect(() => validateAgentTeamPlan(plan)).toThrow('直接依赖图片生成任务');
  });

  it('rejects an image to video plan when the selected model cannot receive reference images', async () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['image_generation', 'video_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'image_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'video_generation', videoPrompt: '森林中恐龙追赶机器猫。' } as typeof plan.tasks[1];
    vi.mocked(generateResponse).mockResolvedValueOnce(JSON.stringify(plan));
    await expect(planAgentTeam({ api: { provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'gpt' },
      goal: '先生成图片再制作视频', imageGeneration: true, videoGeneration: true, videoReferenceImages: false }))
      .rejects.toThrow('不支持参考图片');
  });

  it('rejects cycles, duplicate IDs and oversized teams', () => {
    const cycle = valid();
    cycle.tasks[0].dependsOn = ['report'];
    expect(() => validateAgentTeamPlan(cycle)).toThrow('形成环');
    const duplicate = valid();
    duplicate.tasks[1].id = 'research';
    expect(() => validateAgentTeamPlan(duplicate)).toThrow('任务 ID 重复');
    const reserved = valid();
    reserved.tasks[0].id = 'plan';
    expect(() => validateAgentTeamPlan(reserved)).toThrow('内部规划步骤冲突');
    for (const id of ['delegate', 'delegated_report', 'review_1', 'auto_delegate_1_report', 'review_needs_user']) {
      const internal = valid();
      internal.tasks[0].id = id;
      expect(() => validateAgentTeamPlan(internal)).toThrow('内部规划步骤冲突');
    }
    const oversized = valid();
    oversized.roles = Array.from({ length: 9 }, (_, index) => ({ ...oversized.roles[0], id: `role_${index}` }));
    expect(() => validateAgentTeamPlan(oversized)).toThrow('规模超出限制');
  });

  it('accepts only exact saved text versions supplied by the authorized planning catalog', async () => {
    const original = valid();
    const reference = { alias: 'original', taskId: 'older_report', attempt: 2, outputSha256: 'a'.repeat(64) };
    const plan = { ...original, tasks: [{ ...original.tasks[0], dependsOn: [], savedText: [reference] }] };
    const api = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    vi.mocked(generateResponse).mockResolvedValue(JSON.stringify(plan));
    await expect(planAgentTeam({ api, goal: '复用原报告' })).rejects.toThrow('未授权或版本不符的历史文字');
    await expect(planAgentTeam({ api, goal: '复用原报告', savedText: [{ ...reference, attempt: 3 }] })).rejects.toThrow('未授权或版本不符的历史文字');
    await expect(planAgentTeam({ api, goal: '复用原报告', savedText: [reference] })).resolves.toMatchObject({ tasks: [{ savedText: [reference] }] });
  });
});
