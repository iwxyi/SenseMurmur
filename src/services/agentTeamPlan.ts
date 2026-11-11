import type { APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';
import { WorkflowPreflightError } from './workflowRunRuntime';

export interface AgentTeamRole {
  id: string;
  name: string;
  responsibility: string;
  method: string;
  acceptance: string;
  allowedTools: Array<'text_generation' | 'web_search' | 'image_generation' | 'audio_generation' | 'video_generation' | 'image_inspection'>;
}

export interface AgentTeamTask {
  id: string;
  roleId: string;
  goal: string;
  dependsOn: string[];
  acceptance: string;
  tool?: AgentTeamRole['allowedTools'][number];
}

export interface AgentTeamPlan {
  summary: string;
  roles: AgentTeamRole[];
  tasks: AgentTeamTask[];
  finalAcceptance: string;
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,39}$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('团队计划格式无效');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}无效`);
  return value.trim();
}

function identifier(value: unknown, label: string) {
  const result = requiredText(value, label, 40);
  if (!IDENTIFIER.test(result)) throw new Error(`${label}格式无效`);
  return result;
}

export function validateAgentTeamPlan(raw: unknown): AgentTeamPlan {
  const source = record(raw);
  if (!Array.isArray(source.roles) || !Array.isArray(source.tasks)) throw new Error('团队计划缺少岗位或任务');
  if (source.roles.length < 1 || source.roles.length > 6 || source.tasks.length < 1 || source.tasks.length > 16) throw new Error('团队计划规模超出限制');
  const roles = source.roles.map((item): AgentTeamRole => {
    const value = record(item);
    if (!Array.isArray(value.allowedTools) || value.allowedTools.some((tool) => tool !== 'text_generation' && tool !== 'web_search' && tool !== 'image_generation' && tool !== 'audio_generation' && tool !== 'video_generation' && tool !== 'image_inspection')) throw new Error('岗位申请了不可用工具');
    return {
      id: identifier(value.id, '岗位 ID'),
      name: requiredText(value.name, '岗位名称', 60),
      responsibility: requiredText(value.responsibility, '岗位职责', 500),
      method: requiredText(value.method, '工作方法', 800),
      acceptance: requiredText(value.acceptance, '岗位验收', 500),
      allowedTools: value.allowedTools as AgentTeamRole['allowedTools'],
    };
  });
  const roleIds = new Set(roles.map((role) => role.id));
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  if (roleIds.size !== roles.length) throw new Error('岗位 ID 重复');
  const tasks = source.tasks.map((item): AgentTeamTask => {
    const value = record(item);
    const roleId = identifier(value.roleId, '任务岗位 ID');
    if (!roleIds.has(roleId)) throw new Error('任务引用了不存在的岗位');
    const tool = value.tool === undefined ? 'text_generation' : value.tool;
    if (tool !== 'text_generation' && tool !== 'web_search' && tool !== 'image_generation' && tool !== 'audio_generation' && tool !== 'video_generation' && tool !== 'image_inspection') throw new Error('任务申请了不可用工具');
    if (!rolesById.get(roleId)?.allowedTools.includes(tool)) throw new Error('任务使用了岗位未获授权的工具');
    if (!Array.isArray(value.dependsOn) || value.dependsOn.length > 8) throw new Error('任务依赖无效');
    return {
      id: identifier(value.id, '任务 ID'),
      roleId,
      goal: requiredText(value.goal, '任务目标', 1200),
      dependsOn: value.dependsOn.map((dependency) => identifier(dependency, '依赖任务 ID')),
      acceptance: requiredText(value.acceptance, '任务验收', 800),
      ...(value.tool === undefined ? {} : { tool }),
    };
  });
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  if (tasksById.size !== tasks.length) throw new Error('任务 ID 重复');
  if (tasks.some((task) => task.id === 'plan' || task.id === 'delegate' || task.id === 'review_needs_user'
    || /^(?:review|delegate|auto_delegate)_\d+(?:_|$)/.test(task.id) || task.id.startsWith('delegated_'))) {
    throw new Error('任务 ID 与内部规划步骤冲突');
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('团队计划依赖形成环');
    if (visited.has(id)) return;
    const task = tasksById.get(id);
    if (!task) throw new Error('任务依赖不存在');
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
  if (tasks.some((task) => task.tool === 'image_inspection'
    && !task.dependsOn.some((id) => tasksById.get(id)?.tool === 'image_generation'))) {
    throw new Error('图片检查必须直接依赖图片生成任务');
  }
  return {
    summary: requiredText(source.summary, '计划摘要', 800),
    roles,
    tasks,
    finalAcceptance: requiredText(source.finalAcceptance, '最终验收', 800),
  };
}

export async function planAgentTeam(params: { api: APIConfig; goal: string; chatId?: string; webSearch?: boolean; imageGeneration?: boolean; audioGeneration?: boolean; imageInspection?: boolean; videoGeneration?: boolean; videoReferenceImages?: boolean; videoRequiresReferenceImage?: boolean; maxVideoReferenceImages?: number; videoUnavailableReason?: string; signal?: AbortSignal }) {
  const goal = requiredText(params.goal, '用户目标', 12_000);
  const raw = await generateResponse(params.api, [
    '你是通用任务的主 Agent。根据用户目标设计最小可行的团队与无环任务图。简单任务只用一个岗位。',
    `当前开放工具：text_generation${params.webSearch ? '、web_search' : ''}${params.imageGeneration ? '、image_generation' : ''}${params.audioGeneration ? '、audio_generation' : ''}${params.imageInspection ? '、image_inspection' : ''}${params.videoGeneration ? '、video_generation' : ''}。${params.videoUnavailableReason ? `视频生成当前不可用：${params.videoUnavailableReason}。` : ''}网页搜索任务的 goal 是搜索词；图片任务的 goal 是可生成的画面提示词；音乐任务的 goal 是包含风格、情绪、乐器与可选歌词要求的音乐提示词，系统异步生成完整音频。用户要求明确歌词时，先用 text_generation 写歌词，再让 audio_generation 依赖歌词任务；系统会把歌词交付作为音乐提示词的一部分。图片检查必须直接依赖已生成图片，模型会收到真实画面；视频任务的 goal 是精炼成片提示词，可以依赖脚本${params.videoReferenceImages ? '和图片' : ''}任务。${params.videoRequiresReferenceImage ? '当前视频模型必须先有参考图片。' : ''}${params.videoReferenceImages ? `依赖图片时系统把图片作为参考素材${params.maxVideoReferenceImages ? `，当前模型最多 ${params.maxVideoReferenceImages} 张` : ''}。` : '当前视频模型不能接收参考图片，不要规划图片到视频的依赖。'}视频由系统异步生成，不能声称立即成片。只安排确实必要的图像、音乐与视频生成，避免为验证或补充说明而反复生成同一媒体。不得承诺音视频剪辑合成、文件写入或代码执行；能力不足时在摘要说明。`,
    '岗位必须有具体职责、方法和可检查的验收标准；任务必须有唯一 ID、岗位归属、明确目标和依赖。不要用岗位名称冒充专业能力。',
    '只输出 JSON：{"summary":"...","roles":[{"id":"researcher","name":"...","responsibility":"...","method":"...","acceptance":"...","allowedTools":["text_generation"]}],"tasks":[{"id":"research","roleId":"researcher","goal":"...","dependsOn":[],"tool":"text_generation","acceptance":"..."}],"finalAcceptance":"..."}',
  ].join('\n'), [{ role: 'user', content: goal }], undefined, {
    responseFormat: 'json', maxTokens: 2400, signal: params.signal,
    aiUsage: { type: 'assistant_chat', label: '团队任务规划', scope: 'chat', resourceId: params.chatId },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkflowPreflightError(`团队规划返回了无效 JSON：${error instanceof Error ? error.message : '解析失败'}`);
  }
  let plan: AgentTeamPlan;
  try { plan = validateAgentTeamPlan(parsed); }
  catch (error) { throw new WorkflowPreflightError(error instanceof Error ? error.message : '团队计划无效'); }
  if (!params.webSearch && plan.tasks.some((task) => task.tool === 'web_search')) throw new WorkflowPreflightError('当前会话未开启网页搜索');
  if (!params.imageGeneration && plan.tasks.some((task) => task.tool === 'image_generation')) throw new WorkflowPreflightError('当前未配置图片模型');
  if (!params.audioGeneration && plan.tasks.some((task) => task.tool === 'audio_generation')) throw new WorkflowPreflightError('当前未配置音乐生成模型');
  if (!params.imageInspection && plan.tasks.some((task) => task.tool === 'image_inspection')) throw new WorkflowPreflightError('当前文字模型不支持图片检查');
  if (!params.videoGeneration && plan.tasks.some((task) => task.tool === 'video_generation')) throw new WorkflowPreflightError(params.videoUnavailableReason || '当前未配置视频模型');
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  const dependsOnImage = (task: AgentTeamTask, visited = new Set<string>()): boolean => task.dependsOn.some((dependency) => {
    if (visited.has(dependency)) return false;
    const upstream = tasksById.get(dependency);
    if (!upstream) return false;
    if (upstream.tool === 'image_generation') return true;
    visited.add(dependency);
    return dependsOnImage(upstream, visited);
  });
  if (!params.videoReferenceImages && plan.tasks.some((task) => task.tool === 'video_generation' && dependsOnImage(task))) {
    throw new WorkflowPreflightError('当前视频模型不支持参考图片，请改用文字脚本到视频或切换视频模型');
  }
  return plan;
}
