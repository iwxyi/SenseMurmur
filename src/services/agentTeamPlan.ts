import type { APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';

export interface AgentTeamRole {
  id: string;
  name: string;
  responsibility: string;
  method: string;
  acceptance: string;
  allowedTools: Array<'text_generation' | 'web_search'>;
}

export interface AgentTeamTask {
  id: string;
  roleId: string;
  goal: string;
  dependsOn: string[];
  acceptance: string;
  tool?: 'text_generation' | 'web_search';
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
    if (!Array.isArray(value.allowedTools) || value.allowedTools.some((tool) => tool !== 'text_generation' && tool !== 'web_search')) throw new Error('岗位申请了不可用工具');
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
    if (tool !== 'text_generation' && tool !== 'web_search') throw new Error('任务申请了不可用工具');
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
  if (tasksById.has('plan')) throw new Error('任务 ID 与内部规划步骤冲突');
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
  return {
    summary: requiredText(source.summary, '计划摘要', 800),
    roles,
    tasks,
    finalAcceptance: requiredText(source.finalAcceptance, '最终验收', 800),
  };
}

export async function planAgentTeam(params: { api: APIConfig; goal: string; webSearch?: boolean; signal?: AbortSignal }) {
  const goal = requiredText(params.goal, '用户目标', 12_000);
  const raw = await generateResponse(params.api, [
    '你是通用任务的主 Agent。根据用户目标设计最小可行的团队与无环任务图。简单任务只用一个岗位。',
    params.webSearch
      ? '当前开放 text_generation 与 web_search 工具。需要实时资料时安排独立 web_search 任务，任务 goal 应是明确搜索词，后续文本任务依赖搜索结果。不得承诺图片、音频、视频合成、文件写入或代码执行。'
      : '当前仅开放 text_generation 工具；不得承诺图片、音频、视频合成、网页检索、文件写入或代码执行。能力不足时请在计划摘要中写明限制。',
    '岗位必须有具体职责、方法和可检查的验收标准；任务必须有唯一 ID、岗位归属、明确目标和依赖。不要用岗位名称冒充专业能力。',
    '只输出 JSON：{"summary":"...","roles":[{"id":"researcher","name":"...","responsibility":"...","method":"...","acceptance":"...","allowedTools":["text_generation"]}],"tasks":[{"id":"research","roleId":"researcher","goal":"...","dependsOn":[],"tool":"text_generation","acceptance":"..."}],"finalAcceptance":"..."}',
  ].join('\n'), [{ role: 'user', content: goal }], undefined, {
    responseFormat: 'json', maxTokens: 2400, signal: params.signal,
    aiUsage: { type: 'assistant_chat', label: '团队任务规划', scope: 'chat' },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('团队规划返回了无效 JSON', { cause: error });
  }
  const plan = validateAgentTeamPlan(parsed);
  if (!params.webSearch && plan.tasks.some((task) => task.tool === 'web_search')) throw new Error('当前会话未开启网页搜索');
  return plan;
}
