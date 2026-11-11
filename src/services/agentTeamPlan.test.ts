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
    expect(validateAgentTeamPlan(valid()).tasks[1].dependsOn).toEqual(['research']);
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
