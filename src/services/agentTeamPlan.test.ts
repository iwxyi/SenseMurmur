import { describe, expect, it, vi } from 'vitest';
import { planAgentTeam, validateAgentTeamPlan } from './agentTeamPlan';
import { generateResponse } from './aiClient';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));

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
  it('enforces image reference capability and count for saved sources', async () => {
    const sources = [1, 2].map((index) => ({ taskId: `previous_${index}`, kind: 'image' as const, attempt: 1, outputSha256: String(index).repeat(64) }));
    const params = { api: { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, goal: '复用旧图', savedMedia: sources };
    for (const tool of ['image_generation', 'video_generation'] as const) {
      const candidate = { ...valid(), roles: [{ ...valid().roles[0], allowedTools: [tool] }],
        tasks: [{ id: 'edit', roleId: 'researcher', goal: '复用旧图', acceptance: '有效', tool, dependsOn: [],
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
    const shot = { ...plan.tasks[0], tool: 'video_generation' };
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
    expect(legacy).toMatchObject({ schemaVersion: 1, roles: [{ schemaVersion: 1 }] });
    expect(() => validateAgentTeamPlan({ ...valid(), schemaVersion: 2 })).toThrow('团队计划版本不受支持');
    const unsupportedRole = valid();
    unsupportedRole.roles[0] = { ...unsupportedRole.roles[0], schemaVersion: 2 } as typeof unsupportedRole.roles[number];
    expect(() => validateAgentTeamPlan(unsupportedRole)).toThrow('岗位契约版本不受支持');
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

  it('rejects unknown tools and missing role references', () => {
    const unknownTool = valid();
    unknownTool.roles[0].allowedTools = ['shell'];
    expect(() => validateAgentTeamPlan(unknownTool)).toThrow('不可用工具');
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
    expect(() => validateAgentTeamPlan(plan)).toThrow('未获授权');
  });

  it('accepts video only when the role declares the tool', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['text_generation', 'video_generation'];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'video_generation' } as typeof plan.tasks[1];
    expect(validateAgentTeamPlan(plan).tasks[1].tool).toBe('video_generation');
    plan.roles[0].allowedTools = ['text_generation'];
    expect(() => validateAgentTeamPlan(plan)).toThrow('未获授权');
  });

  it('accepts music generation only when the role declares the tool', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['audio_generation', 'text_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'audio_generation' } as typeof plan.tasks[0];
    expect(validateAgentTeamPlan(plan).tasks[0].tool).toBe('audio_generation');
    plan.roles[0].allowedTools = ['text_generation'];
    expect(() => validateAgentTeamPlan(plan)).toThrow('未获授权');
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
    plan.tasks[1] = { ...plan.tasks[1], tool: 'video_generation' } as typeof plan.tasks[1];
    expect(() => validateAgentTeamPlan(plan)).toThrow('不能接收已生成的音乐或视频片段');
    plan.roles[0].allowedTools.push('text_generation');
    plan.tasks[1] = { ...plan.tasks[1], tool: 'text_generation' } as typeof plan.tasks[1];
    plan.tasks.push({ id: 'video', roleId: 'researcher', goal: '生成成片', dependsOn: ['report'], tool: 'video_generation', acceptance: '视频含音乐' });
    expect(() => validateAgentTeamPlan(plan)).toThrow('不能接收已生成的音乐或视频片段');
  });

  it('rejects chaining two video tasks as if the second could join the first clip', () => {
    const plan = valid();
    plan.roles[0].allowedTools = ['video_generation'];
    plan.tasks[0] = { ...plan.tasks[0], tool: 'video_generation' } as typeof plan.tasks[0];
    plan.tasks[1] = { ...plan.tasks[1], tool: 'video_generation' } as typeof plan.tasks[1];
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
    plan.tasks[1] = { ...plan.tasks[1], tool: 'video_generation' } as typeof plan.tasks[1];
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
