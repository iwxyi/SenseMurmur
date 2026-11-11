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
  it('accepts a bounded task graph with explicit role contracts', () => {
    const plan = validateAgentTeamPlan(valid());
    expect(plan.tasks[1].dependsOn).toEqual(['research']);
    expect(plan.schemaVersion).toBe(1);
    expect(plan.roles[0].schemaVersion).toBe(1);
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
    expect(parsed.tasks[0].deliverable).toEqual({ kind: 'table', title: '竞品对照表', language: 'markdown' });
    expect(parsed.tasks[1].deliverable).toBeUndefined();
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [{ ...plan.tasks[0], deliverable: { kind: 'audio', title: '无效类型' } }, plan.tasks[1]] })).toThrow('交付类型无效');
    expect(() => validateAgentTeamPlan({ ...plan, tasks: [{ ...plan.tasks[0], deliverable: { kind: 'table', title: '' } }, plan.tasks[1]] })).toThrow('交付标题无效');
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
    oversized.roles = Array.from({ length: 7 }, (_, index) => ({ ...oversized.roles[0], id: `role_${index}` }));
    expect(() => validateAgentTeamPlan(oversized)).toThrow('规模超出限制');
  });
});
