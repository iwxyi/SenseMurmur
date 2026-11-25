import type { APIConfig } from '../types/settings';
import { generateWorkflowModelResponse as generateResponse, type WorkflowModelRequestHook } from './workflowModelResponse';
import { WorkflowPreflightError } from './workflowRunRuntime';
import { validateMediaCompositionPlan, type MediaCompositionPlan } from './mediaCompositionPlan';
import { WORKFLOW_TOOLS, type WorkflowTool } from './workflowGoalSpec';
import { sameTeamSavedTextVersion, type AgentTeamSavedText } from './agentTeamSavedText';
import { matchesTeamJsonSchema, parseTeamJsonSchema, type TeamJsonSchema } from './agentTeamJsonSchema';
import { parseWorkflowApprovalRequirement, type WorkflowApprovalRequirement } from './workflowApproval';
import { parseTeamDelegationReview, reviewTeamDelegation, type DelegationGoal, type TeamDelegationReview } from './agentTeamDelegationReview';
import { compileTeamRevisionPatch, parseTeamRevisionCompilation, type TeamRevisionBase, type TeamRevisionCompilation } from './agentTeamRevisionPatch';
import { workflowJsonDigest } from './workflowToolRequest';
import { TEAM_SPEECH_TEXT_LIMIT } from './teamSpeechLimit';
import { logDeveloperDiagnostic } from './developerDiagnostics';

export interface AgentTeamRole {
  schemaVersion?: 1;
  contractVersion?: 1;
  id: string;
  name: string;
  responsibility: string;
  method: string;
  acceptance: string;
  allowedTools: WorkflowTool[];
  inputSchema?: TeamJsonSchema;
  outputSchema?: TeamJsonSchema;
}

export interface AgentTeamTask {
  schemaVersion?: 1;
  id: string;
  roleId: string;
  goal: string;
  dependsOn: string[];
  acceptance: string;
  tool?: AgentTeamRole['allowedTools'][number];
  videoPrompt?: string;
  videoDurationSeconds?: number;
  mediaOutput?: 'image' | 'video' | 'audio';
  composition?: MediaCompositionPlan;
  savedMedia?: Array<{ alias: string; taskId: string; kind: 'image' | 'video' | 'audio'; attempt: number; outputSha256: string }>;
  savedText?: AgentTeamSavedText[];
  speech?: { text?: string; textTaskId?: string };
  approval?: WorkflowApprovalRequirement;
  deliverable?: {
    schemaVersion?: 1;
    kind: 'document' | 'code' | 'diagram' | 'html' | 'table' | 'json' | 'text';
    title: string;
    language?: string;
    jsonSchema?: TeamJsonSchema;
  };
}

export interface AgentTeamPlan {
  schemaVersion?: 1;
  summary: string;
  roles: AgentTeamRole[];
  tasks: AgentTeamTask[];
  finalAcceptance: string;
  resultTaskId?: string;
  delegationReview?: TeamDelegationReview;
  revisionCompilation?: TeamRevisionCompilation;
}

export function teamTaskMediaKind(task: AgentTeamTask | undefined): AgentTeamTask['mediaOutput'] {
  if (!task) return undefined;
  if (task.tool === 'delegate_task') return task.mediaOutput;
  if (task.tool === 'image_generation') return 'image';
  if (task.tool === 'video_generation' || task.tool === 'media_composition') return 'video';
  if (task.tool === 'audio_generation' || task.tool === 'speech_generation') return 'audio';
  return undefined;
}

export function directTeamMediaReferences(task: AgentTeamTask, byId: Map<string, AgentTeamTask>, kind: NonNullable<AgentTeamTask['mediaOutput']>) {
  return [...task.dependsOn.filter((id) => teamTaskMediaKind(byId.get(id)) === kind),
    ...(task.savedMedia || []).filter((media) => media.kind === kind).map((media) => media.alias)];
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,39}$/;
const TOOLS: ReadonlySet<string> = new Set(WORKFLOW_TOOLS);
const TOOL_NAMES: Record<WorkflowTool, string> = {
  text_generation: '文字生成', web_search: '网页搜索', image_generation: '图片生成', audio_generation: '音乐生成',
  speech_generation: '配音', video_generation: '视频生成', image_inspection: '图片检查', video_inspection: '视频检查',
  media_composition: '音视频合成', delegate_task: '委派子任务', user_input: '询问用户',
};

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

export function validateAgentTeamPlan(raw: unknown, options: { requireVideoPrompt?: boolean; maxVideoPromptLength?: number } = {}): AgentTeamPlan {
  const source = record(raw);
  if (source.schemaVersion !== undefined && source.schemaVersion !== 1) throw new Error('团队计划版本不受支持');
  if (!Array.isArray(source.roles) || !Array.isArray(source.tasks)) throw new Error('团队计划缺少岗位或任务');
  if (source.roles.length < 1 || source.roles.length > 8 || source.tasks.length < 1 || source.tasks.length > 48) throw new Error('团队计划规模超出限制');
  const roles = source.roles.map((item): AgentTeamRole => {
    const value = record(item);
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('岗位契约版本不受支持');
    if (value.contractVersion !== undefined && value.contractVersion !== 1) throw new Error('岗位实例契约版本不受支持');
    if (!Array.isArray(value.allowedTools)) throw new Error(`岗位“${String(value.name || value.id || '未命名')}”缺少工具列表`);
    const unsupportedTools = value.allowedTools.filter((tool) => !TOOLS.has(String(tool)));
    if (unsupportedTools.length) {
      throw new Error(`岗位“${String(value.name || value.id || '未命名')}”申请了工具目录外的标识：${unsupportedTools.map((tool) => `“${String(tool).slice(0, 80)}”`).join('、')}。支持的工具 ID：${[...WORKFLOW_TOOLS].join('、')}`);
    }
    const inputSchema = value.inputSchema === undefined ? undefined : parseTeamJsonSchema(value.inputSchema);
    const outputSchema = value.outputSchema === undefined ? undefined : parseTeamJsonSchema(value.outputSchema);
    return {
      schemaVersion: 1,
      contractVersion: 1,
      id: identifier(value.id, '岗位 ID'),
      name: requiredText(value.name, '岗位名称', 60),
      responsibility: requiredText(value.responsibility, '岗位职责', 500),
      method: requiredText(value.method, '工作方法', 800),
      acceptance: requiredText(value.acceptance, '岗位验收', 500),
      allowedTools: value.allowedTools as AgentTeamRole['allowedTools'],
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
    };
  });
  const roleIds = new Set(roles.map((role) => role.id));
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  if (roleIds.size !== roles.length) throw new Error('岗位 ID 重复');
  const tasks = source.tasks.map((item, index): AgentTeamTask => {
    const value = record(item);
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('任务契约版本不受支持');
    const roleId = identifier(value.roleId, '任务岗位 ID');
    if (!roleIds.has(roleId)) throw new Error('任务引用了不存在的岗位');
    const tool = value.tool === undefined ? 'text_generation' : value.tool;
    if (typeof tool !== 'string' || !TOOLS.has(tool)) throw new Error(`第 ${index + 1} 个任务申请了工具目录外的标识“${String(tool).slice(0, 80)}”。支持的工具 ID：${[...WORKFLOW_TOOLS].join('、')}`);
    const selectedTool = tool as AgentTeamRole['allowedTools'][number];
    if (selectedTool === 'user_input' && value.deliverable !== undefined) throw new Error('用户提问不能声明生成产物');
    if (value.videoDurationSeconds !== undefined
      && (selectedTool !== 'video_generation' || typeof value.videoDurationSeconds !== 'number'
        || !Number.isInteger(value.videoDurationSeconds) || value.videoDurationSeconds < 1 || value.videoDurationSeconds > 120)) {
      throw new Error('视频片段时长只可用于视频生成任务，且须为 1 到 120 秒的整数');
    }
    if (value.videoPrompt !== undefined && selectedTool !== 'video_generation') throw new Error('videoPrompt 只可用于视频生成任务');
    const videoPrompt = value.videoPrompt === undefined ? undefined : requiredText(value.videoPrompt, '视频生成提示词', 12_000);
    if (selectedTool === 'video_generation' && options.requireVideoPrompt && !videoPrompt) throw new Error(`视频任务“${String(value.id || index + 1)}”缺少结构化 videoPrompt 字段`);
    if (selectedTool === 'video_generation' && videoPrompt && options.maxVideoPromptLength && [...videoPrompt].length > options.maxVideoPromptLength) {
      throw new Error(`视频任务“${String(value.id || index + 1)}”的 videoPrompt 为 ${[...videoPrompt].length} 字符，超过当前模型 ${options.maxVideoPromptLength} 字符上限`);
    }
    if (value.deliverable !== undefined && selectedTool !== 'text_generation' && selectedTool !== 'delegate_task') throw new Error('文字产物只可由文本或委派任务交付');
    if (value.mediaOutput !== undefined && (tool !== 'delegate_task' || !['image', 'video', 'audio'].includes(String(value.mediaOutput)))) throw new Error('只有委派任务可以声明有效的媒体交付类型');
    const role = rolesById.get(roleId)!;
    if (!role.allowedTools.includes(selectedTool)) {
      throw new Error(`团队计划内部工具不一致：第 ${index + 1} 个任务指定“${TOOL_NAMES[selectedTool]}”，岗位“${role.name}”仅列出${role.allowedTools.map((allowed) => `“${TOOL_NAMES[allowed]}”`).join('、') || '无工具'}。尚未涉及用户授权。`);
    }
    if (!Array.isArray(value.dependsOn) || value.dependsOn.length > (tool === 'media_composition' ? 48 : 8)
      || new Set(value.dependsOn).size !== value.dependsOn.length) throw new Error('任务依赖无效');
    if (tool !== 'media_composition' && value.composition !== undefined) throw new Error('只有合成任务可以声明合成配置');
    const composition = tool === 'media_composition' ? validateMediaCompositionPlan(value.composition) : undefined;
    let savedMedia: AgentTeamTask['savedMedia'];
    if (value.savedMedia !== undefined) {
      if (!['media_composition', 'image_generation', 'video_generation', 'image_inspection', 'video_inspection'].includes(tool)
        || !Array.isArray(value.savedMedia) || !value.savedMedia.length || value.savedMedia.length > (tool === 'media_composition' ? 52 : 8)) throw new Error('历史素材的工具或数量无效');
      savedMedia = value.savedMedia.map((entry) => {
        const media = record(entry);
        const kinds = tool === 'media_composition' ? ['video', 'audio'] : tool === 'video_inspection' ? ['video'] : ['image'];
        if (!kinds.includes(String(media.kind)) || !Number.isSafeInteger(media.attempt) || Number(media.attempt) < 1
          || typeof media.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.outputSha256)) throw new Error('历史素材版本无效');
        return { alias: identifier(media.alias, '历史素材别名'), taskId: requiredText(media.taskId, '历史素材任务', 256),
          kind: media.kind as 'image' | 'video' | 'audio', attempt: Number(media.attempt), outputSha256: media.outputSha256 };
      });
      if (new Set(savedMedia.map((media) => media.alias)).size !== savedMedia.length) throw new Error('历史素材别名重复');
    }
    let savedText: AgentTeamTask['savedText'];
    if (value.savedText !== undefined) {
      if (!['text_generation', 'image_generation', 'video_generation', 'audio_generation', 'speech_generation', 'delegate_task'].includes(tool)
        || !Array.isArray(value.savedText) || !value.savedText.length || value.savedText.length > 8) throw new Error('历史文字交付的工具或数量无效');
      savedText = value.savedText.map((entry) => {
        const reference = record(entry);
        if (!Number.isSafeInteger(reference.attempt) || Number(reference.attempt) < 1
          || typeof reference.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.outputSha256)) throw new Error('历史文字交付版本无效');
        const artifact = reference.artifact === undefined ? undefined : record(reference.artifact);
        if (artifact?.filePath !== undefined) requiredText(artifact.filePath, '产物文件路径', 1024);
        return { alias: identifier(reference.alias, '历史文字别名'), taskId: requiredText(reference.taskId, '历史文字任务', 256),
          attempt: Number(reference.attempt), outputSha256: reference.outputSha256,
          ...(artifact ? { artifact: { id: requiredText(artifact.id, '文字产物标识', 512), versionId: requiredText(artifact.versionId, '文字产物版本', 768),
            ...(artifact.filePath !== undefined ? { filePath: artifact.filePath as string } : {}) } } : {}) };
      });
      if (new Set(savedText.map((entry) => entry.alias)).size !== savedText.length
        || new Set(savedText.map((entry) => JSON.stringify([entry.taskId, entry.artifact?.filePath ?? null]))).size !== savedText.length) throw new Error('历史文字交付重复');
      if (savedText.some((entry) => savedMedia?.some((media) => media.alias === entry.alias))) throw new Error('历史文字与素材别名冲突');
    }
    if (tool !== 'speech_generation' && value.speech !== undefined) throw new Error('只有配音任务可以声明配音正文');
    let speech: AgentTeamTask['speech'];
    if (tool === 'speech_generation') {
      const rawSpeech = record(value.speech);
      if ((rawSpeech.text === undefined) === (rawSpeech.textTaskId === undefined)) throw new Error('配音必须指定正文或正文任务，且只能选择一种');
      speech = rawSpeech.text !== undefined
        ? { text: requiredText(rawSpeech.text, '配音正文', TEAM_SPEECH_TEXT_LIMIT) }
        : { textTaskId: identifier(rawSpeech.textTaskId, '配音正文任务 ID') };
    }
    let deliverable: AgentTeamTask['deliverable'];
    if (value.deliverable !== undefined) {
      const rawDeliverable = record(value.deliverable);
      if (rawDeliverable.schemaVersion !== undefined && rawDeliverable.schemaVersion !== 1) throw new Error('不支持的任务交付契约版本');
      const kind = rawDeliverable.kind;
      if (!['document', 'code', 'diagram', 'html', 'table', 'json', 'text'].includes(String(kind))) throw new Error('任务交付类型无效');
      if (kind === 'table' && rawDeliverable.language !== undefined && !['csv', 'tsv', 'markdown', 'md'].includes(String(rawDeliverable.language).trim().toLowerCase())) throw new Error('表格交付语言须为 csv、tsv 或 markdown');
      if (rawDeliverable.jsonSchema !== undefined && kind !== 'json') throw new Error('仅 JSON 交付可以声明字段契约');
      deliverable = {
        schemaVersion: 1,
        kind: kind as NonNullable<AgentTeamTask['deliverable']>['kind'],
        title: requiredText(rawDeliverable.title, '任务交付标题', 120),
        ...(rawDeliverable.language === undefined ? {} : { language: requiredText(rawDeliverable.language, '交付语言', 40) }),
        ...(rawDeliverable.jsonSchema === undefined ? {} : { jsonSchema: parseTeamJsonSchema(rawDeliverable.jsonSchema) }),
      };
    }
    return {
      schemaVersion: 1,
      id: identifier(value.id, '任务 ID'),
      roleId,
      goal: requiredText(value.goal, '任务目标', 1200),
      dependsOn: value.dependsOn.map((dependency) => identifier(dependency, '依赖任务 ID')),
      acceptance: requiredText(value.acceptance, '任务验收', 800),
      ...(value.tool === undefined ? {} : { tool: selectedTool }),
      ...(videoPrompt === undefined ? {} : { videoPrompt }),
      ...(value.videoDurationSeconds === undefined ? {} : { videoDurationSeconds: value.videoDurationSeconds }),
      ...(value.mediaOutput === undefined ? {} : { mediaOutput: value.mediaOutput as AgentTeamTask['mediaOutput'] }),
      ...(composition ? { composition } : {}),
      ...(savedMedia ? { savedMedia } : {}),
      ...(savedText ? { savedText } : {}),
      ...(speech ? { speech } : {}),
      ...(value.approval === undefined ? {} : { approval: parseWorkflowApprovalRequirement(value.approval) }),
      ...(deliverable ? { deliverable } : {}),
    };
  });
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  if (tasksById.size !== tasks.length) throw new Error('任务 ID 重复');
  for (const role of roles) {
    if ((role.inputSchema || role.outputSchema) && tasks.some((task) => task.roleId === role.id
      && !['text_generation', 'delegate_task'].includes(task.tool || 'text_generation'))) {
      throw new Error('岗位输入/输出字段契约只适用于文本与委派任务');
    }
  }
  if (tasks.some((task) => task.savedMedia?.some((media) => tasksById.has(media.alias)))) throw new Error('历史素材别名与计划任务冲突');
  if (tasks.some((task) => task.savedText?.some((entry) => tasksById.has(entry.alias)))) throw new Error('历史文字别名与计划任务冲突');
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
    && !directTeamMediaReferences(task, tasksById, 'image').length)) {
    throw new Error('图片检查必须直接依赖图片生成任务');
  }
  if (tasks.some((task) => task.tool === 'video_inspection'
    && directTeamMediaReferences(task, tasksById, 'video').length !== 1)) {
    throw new Error('视频检查必须直接依赖唯一的视频生成或合成任务');
  }
  if (tasks.some((task) => task.tool === 'audio_generation'
    && task.dependsOn.some((id) => !['text_generation', 'web_search', 'user_input'].includes(tasksById.get(id)?.tool || 'text_generation')))) {
    throw new Error('音乐任务目前只能依赖文字歌词或说明');
  }
  for (const task of tasks.filter((item) => item.tool === 'speech_generation')) {
    const sourceId = task.speech?.textTaskId;
    const saved = task.savedText?.find((entry) => entry.alias === sourceId);
    const invalidSource = sourceId
      ? task.dependsOn.length !== 1 || task.dependsOn[0] !== sourceId || (tasksById.get(sourceId)?.tool || 'text_generation') !== 'text_generation'
      : task.dependsOn.length !== 0;
    if (saved ? task.dependsOn.length !== 0 || task.savedText?.length !== 1 : task.savedText?.length || invalidSource) {
      throw new Error('配音只能直接使用正文，或依赖唯一的文字正文任务');
    }
  }
  if (tasks.some((task) => task.tool === 'image_generation'
    && task.dependsOn.some((id) => {
      const source = tasksById.get(id)!;
      return source.tool === 'delegate_task'
        ? Boolean(source.mediaOutput && source.mediaOutput !== 'image')
        : !['text_generation', 'web_search', 'user_input', 'image_inspection', 'image_generation'].includes(source.tool || 'text_generation');
    }))) {
    throw new Error('图片任务只能依赖文字或已生成图片，不能读取音频与视频附件');
  }
  const hasUnsupportedVideoAncestor = (task: AgentTeamTask, visited = new Set<string>()): boolean => task.dependsOn.some((id) => {
    if (visited.has(id)) return false;
    visited.add(id);
    const source = tasksById.get(id);
    return Boolean(source && (teamTaskMediaKind(source) === 'audio' || teamTaskMediaKind(source) === 'video'
      || (source.tool !== 'delegate_task' && hasUnsupportedVideoAncestor(source, visited))));
  });
  if (tasks.some((task) => task.tool === 'video_generation' && hasUnsupportedVideoAncestor(task))) {
    throw new Error('视频任务目前不能接收已生成的音乐或视频片段；需要配乐或拼接时须使用音视频合成工具');
  }
  for (const task of tasks.filter((item) => item.tool === 'media_composition')) {
    const composition = task.composition!;
    for (const clip of composition.clips) {
      const saved = task.savedMedia?.find((media) => media.alias === clip.taskId);
      if (saved ? saved.kind !== 'video' : !task.dependsOn.includes(clip.taskId) || teamTaskMediaKind(tasksById.get(clip.taskId)) !== 'video') throw new Error('合成片段必须直接依赖视频生成或合成任务');
    }
    for (const track of composition.audioTracks || []) {
      const saved = task.savedMedia?.find((media) => media.alias === track.taskId);
      if (saved ? saved.kind !== 'audio' : !task.dependsOn.includes(track.taskId) || teamTaskMediaKind(tasksById.get(track.taskId)) !== 'audio') throw new Error('合成音轨必须直接依赖音乐生成或配音任务');
    }
    if (task.savedMedia?.some((media) => ![...composition.clips, ...(composition.audioTracks || [])].some((item) => item.taskId === media.alias))) throw new Error('历史素材未被合成配置使用');
  }
  const resultTaskId = source.resultTaskId === undefined ? undefined : identifier(source.resultTaskId, '媒体交付任务 ID');
  if (resultTaskId && !teamTaskMediaKind(tasksById.get(resultTaskId))) throw new Error('媒体交付必须指定计划内的媒体任务');
  const revisionCompilation = source.revisionCompilation === undefined ? undefined : parseTeamRevisionCompilation(source.revisionCompilation);
  if (revisionCompilation && (revisionCompilation.rerunTaskIds.length !== tasks.length
    || revisionCompilation.rerunTaskIds.some((id) => !tasksById.has(id)))) throw new Error('局部重做记录与任务图不一致');
  return {
    schemaVersion: 1,
    summary: requiredText(source.summary, '计划摘要', 800),
    roles,
    tasks,
    finalAcceptance: requiredText(source.finalAcceptance, '最终验收', 800),
    ...(resultTaskId ? { resultTaskId } : {}),
    ...(source.delegationReview === undefined ? {} : { delegationReview: parseTeamDelegationReview(source.delegationReview, tasks) }),
    ...(revisionCompilation ? { revisionCompilation } : {}),
  };
}

export function validateAgentRoleInput(role: AgentTeamRole, input: unknown) {
  if (role.inputSchema && !matchesTeamJsonSchema(role.inputSchema, input)) {
    throw new WorkflowPreflightError(`岗位“${role.name}”的任务输入不符合岗位契约字段要求`);
  }
}

export function validateAgentRoleOutput(role: AgentTeamRole, raw: string) {
  const output = raw.trim();
  if (!output) throw new WorkflowPreflightError(`岗位“${role.name}”未提交内容`);
  if (!role.outputSchema) return output;
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { throw new WorkflowPreflightError(`岗位“${role.name}”的输出不符合岗位契约：要求纯 JSON`); }
  if (!matchesTeamJsonSchema(role.outputSchema, value)) {
    throw new WorkflowPreflightError(`岗位“${role.name}”的输出不符合岗位契约字段要求`);
  }
  return output;
}

export function agentRoleContractInstruction(role: AgentTeamRole) {
  return [
    role.inputSchema ? `岗位输入契约 JSON Schema：${JSON.stringify(role.inputSchema)}。用户消息中的 JSON 必须符合该结构。` : '',
    role.outputSchema ? `岗位输出契约 JSON Schema：${JSON.stringify(role.outputSchema)}。只返回符合该结构的纯 JSON，不附加 Markdown 围栏或说明。` : '',
  ].filter(Boolean).join('\n');
}

function removeUnsupportedModelDeliverables(raw: unknown): unknown {
  const plan = record(raw);
  if (!Array.isArray(plan.tasks)) return raw;
  return { ...plan, tasks: plan.tasks.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const task = entry as Record<string, unknown>;
    const tool = task.tool === undefined ? 'text_generation' : task.tool;
    if (tool === 'text_generation' || tool === 'delegate_task' || task.deliverable === undefined) return entry;
    const normalized = { ...task };
    delete normalized.deliverable;
    return normalized;
  }) };
}

function reconcileGeneratedPlanDeclarations(raw: unknown): unknown {
  const plan = record(removeUnsupportedModelDeliverables(raw));
  if (!Array.isArray(plan.roles) || !Array.isArray(plan.tasks)) return plan;
  const roles = plan.roles.map((entry) => record(entry));
  const tasks = plan.tasks.map((entry) => record(entry));
  const rolesById = new Map(roles.filter((role) => typeof role.id === 'string').map((role) => [role.id as string, role]));
  const taskTools = tasks.map((task) => typeof task.tool === 'string' ? task.tool : 'text_generation');
  const taskIndices = new Map(tasks.filter((task) => typeof task.id === 'string').map((task, index) => [task.id as string, index]));
  const hasMediaAncestor = (id: string, visited = new Set<string>()): boolean => {
    if (visited.has(id)) return false;
    visited.add(id);
    const index = taskIndices.get(id);
    if (index === undefined) return false;
    if (['video_generation', 'media_composition', 'audio_generation', 'speech_generation'].includes(taskTools[index])) return true;
    const dependencies = tasks[index].dependsOn;
    return Array.isArray(dependencies) && dependencies.some((dependency) => typeof dependency === 'string' && hasMediaAncestor(dependency, visited));
  };
  const normalizedVideoDependencies: Array<{ taskId: string; removed: string[] }> = [];

  for (let index = 0; index < tasks.length; index++) {
    const role = typeof tasks[index].roleId === 'string' ? rolesById.get(tasks[index].roleId as string) : undefined;
    const allowedTools = role?.allowedTools;
    if (role && Array.isArray(allowedTools) && typeof taskTools[index] === 'string' && !allowedTools.includes(taskTools[index])) {
      role.allowedTools = [...allowedTools, taskTools[index]];
    }
    const dependencyValues = tasks[index].dependsOn;
    if (taskTools[index] === 'video_generation' && Array.isArray(dependencyValues)) {
      const removed = dependencyValues.filter((dependency): dependency is string => typeof dependency === 'string' && hasMediaAncestor(dependency));
      if (removed.length) {
        tasks[index].dependsOn = dependencyValues.filter((dependency) => typeof dependency !== 'string' || !removed.includes(dependency));
        normalizedVideoDependencies.push({ taskId: String(tasks[index].id || index), removed });
      }
    }
    if (taskTools[index] !== 'media_composition' || !Array.isArray(dependencyValues)
      || !tasks[index].composition || typeof tasks[index].composition !== 'object') continue;
    const compositionDependencies = tasks[index].dependsOn;
    const dependencies = new Set((Array.isArray(compositionDependencies) ? compositionDependencies : [])
      .filter((id): id is string => typeof id === 'string'));
    const uniqueDependency = (kind: 'video' | 'audio') => {
      const candidates = tasks.flatMap((candidate, candidateIndex) => {
        if (!dependencies.has(String(candidate.id))) return [];
        const tool = taskTools[candidateIndex];
        const mediaKind = tool === 'video_generation' || tool === 'media_composition' ? 'video'
          : tool === 'audio_generation' || tool === 'speech_generation' ? 'audio' : undefined;
        return mediaKind === kind && typeof candidate.id === 'string' ? [candidate.id] : [];
      });
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const composition = record(tasks[index].composition);
    if (Array.isArray(composition.clips)) {
      const clipDependencies = composition.clips.flatMap((clip) => {
        if (!clip || typeof clip !== 'object' || Array.isArray(clip)) return [];
        const id = (clip as Record<string, unknown>).taskId;
        const index = typeof id === 'string' ? taskIndices.get(id) : undefined;
        return index !== undefined && ['video_generation', 'media_composition'].includes(taskTools[index]) ? [String(id)] : [];
      });
      const currentDependencies = tasks[index].dependsOn;
      const dependencyList = Array.isArray(currentDependencies) ? currentDependencies : [];
      tasks[index].dependsOn = [...new Set([...dependencyList, ...clipDependencies])];
      for (const id of clipDependencies) dependencies.add(id);
    }
    const videoSource = uniqueDependency('video');
    const audioSource = uniqueDependency('audio');
    if (videoSource && Array.isArray(composition.clips)) {
      composition.clips = composition.clips.map((clip) => {
        if (!clip || typeof clip !== 'object' || Array.isArray(clip)) return clip;
        const value = clip as Record<string, unknown>;
        if (tasks[index].savedMedia && Array.isArray(tasks[index].savedMedia)
          && (tasks[index].savedMedia as Array<Record<string, unknown>>).some((media) => media.alias === value.taskId && media.kind === 'video')) return clip;
        const referenced = tasks.find((candidate) => candidate.id === value.taskId);
        const referencedIndex = referenced ? tasks.indexOf(referenced) : -1;
        const isVideo = referencedIndex >= 0 && ['video_generation', 'media_composition'].includes(taskTools[referencedIndex]);
        return isVideo && dependencies.has(String(value.taskId)) ? clip : { ...value, taskId: videoSource };
      });
    }
    if (audioSource && Array.isArray(composition.audioTracks)) {
      composition.audioTracks = composition.audioTracks.map((track) => {
        if (!track || typeof track !== 'object' || Array.isArray(track)) return track;
        const value = track as Record<string, unknown>;
        if (tasks[index].savedMedia && Array.isArray(tasks[index].savedMedia)
          && (tasks[index].savedMedia as Array<Record<string, unknown>>).some((media) => media.alias === value.taskId && media.kind === 'audio')) return track;
        const referenced = tasks.find((candidate) => candidate.id === value.taskId);
        const referencedIndex = referenced ? tasks.indexOf(referenced) : -1;
        const isAudio = referencedIndex >= 0 && ['audio_generation', 'speech_generation'].includes(taskTools[referencedIndex]);
        return isAudio && dependencies.has(String(value.taskId)) ? track : { ...value, taskId: audioSource };
      });
    }
  }
  if (normalizedVideoDependencies.length) logDeveloperDiagnostic('agent-team:plan:removed-media-dependencies', {
    tasks: normalizedVideoDependencies,
  }, 'warn', 'team-plan');
  return { ...plan, roles, tasks };
}

export async function planAgentTeam(params: { api: APIConfig; goal: string; context?: string; chatId?: string; webSearch?: boolean; imageGeneration?: boolean; imageReferenceImages?: boolean; maxImageReferenceImages?: number; audioGeneration?: boolean; speechGeneration?: boolean; imageInspection?: boolean; videoInspection?: boolean; videoGeneration?: boolean; videoReferenceImages?: boolean; videoReferenceImagesOptional?: boolean; videoRequiresReferenceImage?: boolean; maxVideoReferenceImages?: number; maxVideoPromptLength?: number; videoUnavailableReason?: string; videoExecutionNote?: string; mediaComposition?: boolean; savedMedia?: Omit<NonNullable<AgentTeamTask['savedMedia']>[number], 'alias'>[]; savedText?: Omit<AgentTeamSavedText, 'alias'>[]; delegation?: boolean; delegationAncestors?: DelegationGoal[]; revisionBase?: TeamRevisionBase; rolling?: boolean; signal?: AbortSignal; beforeModelRequest?: WorkflowModelRequestHook }) {
  const goal = requiredText(params.goal, '用户目标', 12_000);
  const context = params.context === undefined || params.context === '' ? '' : requiredText(params.context, '规划上下文', 128_000);
  const ancestors = params.delegationAncestors;
  if (ancestors && (!ancestors.length || ancestors.length > 3)) throw new WorkflowPreflightError('委派祖先范围无效');
  ancestors?.forEach((ancestor) => { requiredText(ancestor.goal, '祖先目标', 12_000); requiredText(ancestor.acceptance, '祖先验收', 800); });
  const systemPrompt = [
    '你是通用任务的主 Agent。根据用户目标设计当前阶段的团队与无环任务图。简单任务只用一个岗位。目标是长期约束，计划是可随结果调整的行动草案。',
    '上下文可能包含用户约束、验收条件和 Agent 工具授权。用户约束与验收仅转化为实际交付要求；工具清单、岗位权限及工作流控制说明属于内部信息，绝不能复制进媒体提示词、脚本正文或发给外部供应商的内容。',
    params.rolling ? '采用持续规划：总目标与最终验收保持完整，但 tasks 只列当前有充分依据、接下来可实际执行的一个阶段，优先 1 至 4 项。不要提前编排依赖尚未产出的检查结果、模型生成结果或用户决策的后续细节。当前阶段结束后，主 Agent 会读取真实产物进行验收，并决定下一阶段、改计划或停止。summary 简述当前阶段，不要把未列入 tasks 的未来工作说成已完成。' : '',
    `当前开放工具：text_generation${params.webSearch ? '、web_search' : ''}${params.imageGeneration ? '、image_generation' : ''}${params.audioGeneration ? '、audio_generation' : ''}${params.imageInspection ? '、image_inspection' : ''}${params.videoGeneration ? '、video_generation' : ''}${params.mediaComposition ? '、media_composition' : ''}。${params.videoUnavailableReason ? `视频生成当前不可用：${params.videoUnavailableReason}。` : ''}网页搜索任务的 goal 是搜索词；图片任务的 goal 必须是一条可直接提交给图片模型、只生成一张图片的完整画面提示词。多张关键帧必须拆成多个 image_generation 任务，每个任务只含对应的一条提示词；不得把多条提示词、整份剧本、任务清单、验收说明或“根据剧本生成图片”等 Agent 流程文字放进图片任务 goal。用上游剧本提炼并写全该张图需要的场景、角色外观、构图、动作、光线和画风；上游正文供规划参考，系统不会自动拼入图片请求。图片任务可依赖文字脚本、搜索摘要或图片检查文字${params.imageReferenceImages ? `，也可直接依赖已生成图片并作为参考图${params.maxImageReferenceImages ? `（最多 ${params.maxImageReferenceImages} 张）` : ''}` : '；当前图片模型不支持参考图，不要让图片任务直接依赖图片任务'}；只有用户明确要求生成音乐、伴奏或配音时才安排 audio_generation 或 speech_generation，不得因为视频制作习惯、提示词提到配乐/音效或工具已开放而自行增加音频任务。用户明确要求音乐时，音乐任务的 goal 是包含风格、情绪、乐器与可选歌词要求的音乐提示词，系统异步生成完整音频；用户要求明确歌词时，先用 text_generation 写歌词，再让 audio_generation 依赖歌词任务。图片检查必须直接依赖已生成图片，模型会收到真实画面；视频任务的 goal 是精炼成片提示词，可以依赖脚本${params.videoReferenceImages ? '和图片' : ''}任务。video_generation 不能依赖音乐或其他视频片段。${params.videoRequiresReferenceImage ? '当前视频模型必须先有参考图片。' : ''}${params.videoReferenceImages ? `依赖图片时系统把图片作为参考素材${params.maxVideoReferenceImages ? `，当前模型最多 ${params.maxVideoReferenceImages} 张` : ''}。` : '当前视频模型不能接收参考图片，不要规划图片到视频的依赖。'}视频由系统异步生成，不能声称立即成片。只安排用户要求且确实必要的图像、音乐与视频生成，避免为验证或补充说明而反复生成同一媒体。不得承诺任意文件写入或代码执行；能力不足时在摘要说明。`,
    '导演级创作要求：先建立一句话梗概、主题、人物动机、冲突升级、转折和结尾，再拆解成有因果关系的场景与镜头。剧本明确总时长和每镜头起止时间，时长必须准确相加；每镜头写地点与空间关系、景别/机位/构图、镜头运动、角色走位和动作节拍、可见表情与表演意图、光源方向/质感/色彩、环境声/对白/音乐节奏及转场衔接。建立并在每条关键帧提示词重复视觉连续性基准：角色外观服饰、道具、场景地理、时间天气、主色和光线、动画材质与镜头质感。除非剧本明确安排转场，不得换地点、时间或画风；动作必须由上一镜头自然引出，角色位置与道具状态连续。图片提示词要具体到可直接生成，不使用“同上”或只描述动作而省略环境。视频生成任务的 goal 必须是可直接交给视频模型的成片画面提示词，写实际场景、角色、动作时间线、表演、镜头、光线、色彩、节奏和结尾；不得写“根据剧本生成”“参考检查结论”“写清镜头”等给 Agent 的流程说明。若剧本或单独文字步骤承载视频提示词，正文必须另起一行以“视频生成提示词：”开头，之后紧跟可直接提交的精炼提示词；视频任务依赖该文字步骤。用户明确要求配乐/音效时才安排音频生成；否则在剧本中写可供后期参考的声音设计，不虚构音乐文件已生成。最终验收必须依据实际图片和视频检查结果，不能把计划或模型自述当成检查完成。',
    `结构化媒体输入约定：video_generation 任务的 goal 只写执行目标与验收，直接给视频模型的完整成片提示词必须放在同一任务的 videoPrompt 字段；videoPrompt 要综合剧本、图片检查结论及用户要求，不能指向或依赖运行时从上游正文提取提示词。当前模型的提示词上限为 ${params.maxVideoPromptLength || '模型目录未提供'} 个字符（如有上限，videoPrompt 必须在上限内）；不得期待运行时截断或拼接。新计划里的视频生成任务必须提供 videoPrompt。长剧本、分镜及关键帧说明等独立文字交付应声明 deliverable:{"kind":"document","title":"..."}，保存在文档产物中供用户查看；不要把完整正文直接写入任务 goal。该字段缺失、超限或格式错误时，程序会返回校验错误并要求重新规划，绝不从纯文本回退组装。`,
    params.videoReferenceImagesOptional ? '当前实测模型可以让视频任务依赖图片检查结果作为文字上下文，但系统不会把图片文件提交给视频接口。' : '',
    '岗位必须有具体职责、方法和可检查的验收标准；任务必须有唯一 ID、岗位归属、明确目标和依赖。不要用岗位名称冒充专业能力。',
    `allowedTools 与每个任务的 tool 字段只能使用以下工具 ID，不得创造同义词、中文名或外部工具名：${WORKFLOW_TOOLS.join(', ')}。能力当前未开放时也不能安排该任务；岗位可声明的下级能力仍须属于此目录且受父任务授权。`,
    'JSON 交付需要固定字段时，在 deliverable 增加 jsonSchema，按 JSON Schema draft-07 声明 type、properties、required、additionalProperties、items、enum/const 和数值、长度、数量约束，也支持 anyOf/allOf/oneOf/not。每层约束显式声明 type；不支持 $ref、format、pattern 或自定义关键字。例：{"kind":"json","title":"调研结果","jsonSchema":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}}。该契约由程序校验，不得把它当作事实真实性验收。',
    params.videoExecutionNote ? `视频模型执行限制：${params.videoExecutionNote} 视频生成任务可通过 videoDurationSeconds 指定单段秒数（整数）。总长超过单段上限时，创建多个有不同镜头提示词的 video_generation 任务，再由 media_composition 按顺序拼接并裁切至目标时长。多个 video_generation 任务之间不得互相依赖；media_composition 直接依赖并引用所有片段。` : '',
    params.delegation ? '另开放 delegate_task 委派工具。仅对确实需要执行时再拆分的复杂子目标使用，不要用它替代普通写作。执行该任务的岗位必须同时获准 delegate_task 和下级工作需要的工具。系统会规划下级任务、等待它们完成，再由父 Agent 汇总交付；下级权限只能缩小，共用总调用预算与并发。委派最多3层，不要重复祖先目标。需要向后续任务交付素材时，在委派任务声明 mediaOutput:"image"、"video" 或 "audio"，下级计划必须以根字段 resultTaskId 指定同类型的最终媒体任务，可继续指向同类型的委派任务。每次委派只交付一份主要媒体；需要多份素材时分别安排任务。后续图片/视频生成、图片/视频检查和合成按委派任务 ID 引用对应类型素材，系统解析实际已保存文件，不读取摘要中的 URL。未声明 mediaOutput 的委派只交付文字汇总。' : '本层不开放 delegate_task，直接安排具体工作，不得创建下级委派；若父任务要求媒体交付，仍须在计划根字段 resultTaskId 指定具体媒体任务。',
    params.videoInspection ? '另开放 video_inspection 视频抽帧检查工具。必须直接依赖唯一的 video_generation 或 media_composition 任务；系统读取该任务已保存的视频并按时间均匀抽取最多6帧，使用当前视觉模型检查实际画面。它只能判断抽样内容，不能检查音轨、逐帧流畅度或保证全部镜头正确。需要检查成片时在合成之后安排此任务；不能为了检查而重新生成视频。' : '当前设备或模型不支持视频抽帧检查，不得安排 video_inspection。',
    params.speechGeneration ? `另开放 speech_generation 旁白配音工具，使用用户配置的 TTS 模型及默认音色。必须声明 speech:{"text":"需要逐字朗读的正文"} 且 dependsOn:[]，或先安排 text_generation 只撰写旁白正文，再声明 speech:{"textTaskId":"narration_script"} 且 dependsOn:["narration_script"]。二者只能选一。goal 描述制作目的，不能混入配音正文；系统只朗读 speech 指定内容，不朗读岗位说明或验收要求。单次配音正文最多 ${TEAM_SPEECH_TEXT_LIMIT} 字符，较长正文须拆成多个配音任务并在合成时按顺序使用。请控制正文长度以适配视频时长，配音不能直接作为 video_generation 的输入，应交给 media_composition 叠加。` : '当前未配置 TTS 模型，不得安排 speech_generation 配音。',
    params.mediaComposition ? '另开放 media_composition 本地音视频合成工具，可按顺序拼接、裁剪视频并叠加最多4条独立音乐或旁白音轨。视频生成模型可能已生成原生音频，视为视频自身内容，不需额外音乐模型或合成。它不是视频生成工具，不调用付费模型。仅当用户要求拼接多个视频片段、裁剪/重排片段或叠加用户明确要求的独立音轨时安排；只生成一个视频且不需要后期处理时，必须直接交付 video_generation 结果，不得安排 media_composition。合成任务必须声明 composition:{"clips":[{"taskId":"shot_a","startSeconds":0,"durationSeconds":5},{"taskId":"shot_b"}],"audioTracks":[{"taskId":"music","volume":0.7,"offsetSeconds":0,"loop":true}],"aspectRatio":"16:9","originalAudioVolume":0.3}，同时 dependsOn 必须直接列出实际使用的素材任务 ID。shot_a 和 shot_b 必须是本计划中 tool 为 video_generation/media_composition 的任务，或声明 mediaOutput:"video" 的 delegate_task；图片任务只能作为视频生成的参考输入，不能列入 clips。音乐/配音任务只能列入 audioTracks，不能列入 clips。引用历史素材时 clips/audioTracks 使用 savedMedia 别名而非 dependsOn。画面比例可选16:9、9:16、1:1；最长10分钟，素材合计不超过256MiB，输出720p级MP4。不得声称已视觉检查成片。' : '当前设备不支持本地音视频合成，不得安排 media_composition。',
    params.savedMedia?.length ? `可复用历史素材目录：${JSON.stringify(params.savedMedia)}。优先复用符合要求的素材，不重新生成。任务可增加 savedMedia:[{"alias":"old_clip","taskId":"目录中的原任务标识","kind":"video","attempt":1,"outputSha256":"目录中的完整摘要"}]，除 alias 外必须逐字复制目录字段。dependsOn 只列本次新计划任务，不列历史素材别名。media_composition 接收历史视频/音频，在 composition.clips/audioTracks 中使用 alias；image_generation、image_inspection、video_generation 仅接收历史图片，自动将全部 savedMedia 图片作为参考或检查输入；video_inspection 接收唯一历史视频。检查任务允许使用历史素材替代新计划内的媒体依赖。参考图仍受当前模型能力和数量限制，不支持参考图时不得使用历史图片生成。历史素材可与本次新生成素材混用。不能使用目录外素材、猜测任务标识或将摘要当文件地址。` : '本次没有授权复用的历史素材目录，不得声明 savedMedia。',
    params.savedText?.length ? `可复用历史文字交付目录：${JSON.stringify(params.savedText)}。text_generation、image_generation、video_generation、audio_generation、delegate_task 可声明 savedText:[{"alias":"original_script","taskId":"目录中的原任务标识","attempt":1,"outputSha256":"目录中的完整摘要"}]，除 alias 外逐字复制目录字段，最多8份；系统会按版本提供完整正文（每份最多12000字符），不要为读取原稿而重新创作。dependsOn 只列新计划任务，不列历史别名。speech_generation 可仅指定一份 savedText，并声明 speech:{"textTaskId":"original_script"} 与 dependsOn:[]，逐字朗读该正文；不得同时指定 literal text 或其他历史正文。别名不能与本计划任务或历史素材别名重名。目录摘要仅绑定当时文字记录，不保证其中事实已核实。` : '本次没有授权复用的历史文字目录，不得声明 savedText。',
    params.savedText?.some((entry) => entry.artifact) ? '历史文字目录中带 artifact:{id,versionId,filePath?} 的条目对应用户当前选中的产物版本；filePath 表示该版本中的指定文本文件，不带 filePath 表示单正文。不带 artifact 的条目对应任务原始交付。用户要求使用修改后的稿件或项目文件时，优先选择相应 artifact 条目，完整复制 artifact 和摘要。同一来源每个文件最多选一份版本，可用不同 alias 引用多个文件；仍最多8份。系统固定读取所选版本，不会随产物后续编辑而自动切换；缺失或正文变化会明确报错。此入口不读取图片、音视频或 HTML 交互状态。' : '',
    '另开放 user_input 用户提问工具：只有必须由用户补充关键信息才能继续时使用，goal 是清晰具体的问题，可依赖已完成步骤。系统等待用户真实答复，后续任务通过 dependsOn 读取答复；不得猜测答复或代替用户确认。它不扩大工具授权，不代表费用或外部操作的审批。用户已经要求自主完成时优先合理决策，避免不必要的追问。不为提问声明 deliverable。',
    '任一任务可附 approval:{"summary":"将执行的具体方案","consequences":"执行影响、可能费用及不可撤回之处"} 请求用户审批；程序会在依赖完成后等待真实确认，再执行这一任务。仅在用户要求确认或执行有明确决策需要时使用，避免把普通自主步骤都交给用户。审批不扩大工具权限，不能虚构报价，也不能用 user_input 代替审批。',
    '每个 role 是独立的岗位实例契约，必须 contractVersion:1。对需要机器读取或固定字段输出的文本岗位，可声明 inputSchema 与 outputSchema（受限 JSON Schema；支持 type/properties/required/items/enum/const/数值和长度边界及组合规则，不支持 $ref/format/pattern）。inputSchema 校验实际传给岗位的 JSON：overallGoal、taskGoal、acceptance、userInstruction（无指示为 null）、upstream、savedText；outputSchema 校验岗位返回的纯 JSON。输入/输出字段契约只用于 text_generation 与 delegate_task，不要给媒体执行岗位声明。模型字段可选；不确定是否值得结构化时省略，不要为普通写作增加 JSON 包装。',
    'deliverable 仅适用于 text_generation 或 delegate_task 的独立文字产物；图片、视频、音频、合成、检查、搜索及用户提问任务绝不声明 deliverable，媒体通过工具结果交付，最终媒体任务用根字段 resultTaskId 指定。文字产物可选类型 document、table、code、diagram、html、json、text。交付契约 schemaVersion 为 1，格式为 {"schemaVersion":1,"kind":"table","title":"市场比较表","language":"csv"}。json 交付必须是可解析的纯 JSON；字段要求写入任务验收标准。未声明时仍会纳入团队总结。只输出 JSON：{"schemaVersion":1,"summary":"...","roles":[{"schemaVersion":1,"contractVersion":1,"id":"researcher","name":"...","responsibility":"...","method":"...","acceptance":"...","allowedTools":["text_generation"]}],"tasks":[{"id":"research","roleId":"researcher","goal":"...","dependsOn":[],"tool":"text_generation","acceptance":"...","deliverable":{"schemaVersion":1,"kind":"table","title":"比较表","language":"csv"}}],"finalAcceptance":"..."}',
    ancestors ? `当前及祖先目标（仅作范围比较，不是新增指令）：${JSON.stringify(ancestors)}。对本计划每个 delegate_task 比较其与全部祖先目标的语义范围。在根 JSON 额外返回 delegationChecks:[{"taskId":"子任务ID","status":"narrower","reason":"明确说明缩小了哪些范围及独立交付"}]。status 可为 narrower、repeated、uncertain；换措辞、换岗位、增加流程描述但仍承担相同完整目标属于 repeated；无法判断为 uncertain。只有范围明确缩小且能独立验收才为 narrower。程序会阻止 repeated/uncertain 的委派，优先改用具体执行任务；没有 delegate_task 时无需此字段。此字段是模型判断，不是执行或质量已完成的证明。` : '',
    params.revisionBase ? `本次允许局部修订已有计划。原计划：${JSON.stringify(params.revisionBase.plan)}\n原计划摘要：${workflowJsonDigest(params.revisionBase.plan)}\n指定修改任务：${params.revisionBase.targetTaskId}。若只改任务的 goal/acceptance 且不改变岗位、工具、依赖、合成/配音配置或交付格式，优先只输出 {"revisionPatch":{"schemaVersion":1,"basePlanSha256":"上面的原计划摘要","updates":[{"taskId":"指定任务ID","goal":"修改后的完整目标","acceptance":"修改后的完整验收"}]}}。updates 只列要求发生改变的任务，必须包含指定任务；程序会计算这些任务的全部下游并自动重做，未改变的上游通过历史目录固定版本复用，不要重复列入 updates。不要同时输出 tasks 或完整计划。若需要改变步骤结构、配音正文配置、岗位、参考素材版本或交付格式，返回普通完整新计划。若边界交付无法通过前述 savedText/savedMedia 工具及容量规则引用，也须完整重规划。该入口保留历史交付，不覆盖旧任务。` : '',
      params.revisionBase ? '局部修订保留原计划 finalAcceptance；若总体验收要求变化，返回完整新计划。' : '',
      params.revisionBase?.taskSources ? `原计划任务与本次授权历史目录的运行任务对应关系：${JSON.stringify(params.revisionBase.taskSources)}。revisionPatch.updates 使用原计划的局部任务 ID；边界交付由程序按此对应关系固定版本。` : '',
    ].join('\n');
  const userContent = goal + (context ? `\n${context}` : '');
  const modelOptions = {
    responseFormat: 'json', maxTokens: 10_000, signal: params.signal, beforeModelRequest: params.beforeModelRequest,
    aiUsage: { type: 'assistant_chat', label: '团队任务规划', scope: 'chat', resourceId: params.chatId },
  } as const;
  const parseResponse = (raw: string) => {
    try { return JSON.parse(raw) as unknown; }
    catch (error) { throw new WorkflowPreflightError(`团队规划返回了无效 JSON：${error instanceof Error ? error.message : '解析失败'}`); }
  };
  let raw = await generateResponse(params.api, systemPrompt, [{ role: 'user', content: userContent }], undefined, modelOptions);
  let parsed: unknown;
  let plan: AgentTeamPlan | undefined;
  const validateResponse = (value: unknown) => {
    const patch = record(value).revisionPatch;
    if (patch !== undefined && (!params.revisionBase || record(value).tasks !== undefined)) throw new Error('当前规划不允许局部修订或返回了冲突格式');
    if (record(value).revisionCompilation !== undefined) throw new Error('局部重做记录只能由程序编译');
    if (patch === undefined) return validateAgentTeamPlan(reconcileGeneratedPlanDeclarations(value), {
      requireVideoPrompt: true, maxVideoPromptLength: params.maxVideoPromptLength,
    });
    if (!params.revisionBase) throw new Error('当前规划不允许局部修订');
    return validateAgentTeamPlan(compileTeamRevisionPatch(patch, params.revisionBase), {
      requireVideoPrompt: true, maxVideoPromptLength: params.maxVideoPromptLength,
    });
  };
  let validationError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      parsed = parseResponse(raw);
      plan = validateResponse(parsed);
      validationError = undefined;
      break;
    } catch (error) {
      validationError = error;
      if (attempt === 1) break;
      const diagnostic = error instanceof Error ? error.message : '团队计划格式无效';
      logDeveloperDiagnostic('agent-team:plan:format-correction', { reason: diagnostic }, 'warn', 'team-plan');
      raw = await generateResponse(params.api, `${systemPrompt}\n上次返回未通过确定性格式校验。请依据错误修正完整计划，保持原目标、合理工作顺序、工具种类及媒体交付要求，不要扩大工具权限。所有 video_generation 任务必须有 videoPrompt 字符串字段，且符合提示词长度上限。`,
        [{ role: 'user', content: `原始请求与上下文：\n${userContent}\n\n上次模型计划：\n${raw.slice(0, 24_000)}\n\n确定性校验错误：${diagnostic}\n\n请只返回修正后的完整 JSON 计划。` }], undefined, modelOptions);
    }
  }
  if (validationError || !plan) throw new WorkflowPreflightError(validationError instanceof Error ? validationError.message : '团队计划校验重试后仍无效');
  if (ancestors) {
    try {
      const review = reviewTeamDelegation(plan.tasks, ancestors, record(parsed).delegationChecks);
      if (review) plan.delegationReview = review;
    } catch (error) { throw new WorkflowPreflightError(error instanceof Error ? error.message : '委派范围检查失败'); }
  }
  if (plan.tasks.some((task) => task.savedMedia?.some((media) => !params.savedMedia?.some((source) => source.taskId === media.taskId
    && source.kind === media.kind && source.attempt === media.attempt && source.outputSha256 === media.outputSha256)))) {
    throw new WorkflowPreflightError('规划引用了未授权或版本不符的历史素材');
  }
  if (plan.tasks.some((task) => task.savedText?.some((entry) => !params.savedText?.some((source) => sameTeamSavedTextVersion(source, entry))))) throw new WorkflowPreflightError('规划引用了未授权或版本不符的历史文字');
  if (!params.delegation && plan.roles.some((role) => role.allowedTools.includes('delegate_task'))) throw new WorkflowPreflightError('本层未获准下级委派');
  if (!params.webSearch && plan.tasks.some((task) => task.tool === 'web_search')) throw new WorkflowPreflightError('当前会话未开启网页搜索', { tool: 'web_search', code: 'tool_disabled' });
  if (!params.imageGeneration && plan.tasks.some((task) => task.tool === 'image_generation')) throw new WorkflowPreflightError('当前未配置图片模型', { tool: 'image_generation', code: 'model_missing' });
  if (!params.imageReferenceImages && plan.tasks.some((task) => task.tool === 'image_generation'
    && directTeamMediaReferences(task, new Map(plan.tasks.map((source) => [source.id, source])), 'image').length > 0)) {
    throw new WorkflowPreflightError('当前图片模型不支持参考图片', { tool: 'image_generation', code: 'model_unsupported' });
  }
  if (params.maxImageReferenceImages && plan.tasks.some((task) => task.tool === 'image_generation'
    && directTeamMediaReferences(task, new Map(plan.tasks.map((source) => [source.id, source])), 'image').length > params.maxImageReferenceImages!)) {
    throw new WorkflowPreflightError(`当前图片模型最多支持 ${params.maxImageReferenceImages} 张参考图片`, { tool: 'image_generation', code: 'input_unsupported' });
  }
  if (!params.audioGeneration && plan.tasks.some((task) => task.tool === 'audio_generation')) throw new WorkflowPreflightError('当前未配置音乐生成模型', { tool: 'audio_generation', code: 'model_missing' });
  if (!params.speechGeneration && plan.tasks.some((task) => task.tool === 'speech_generation')) throw new WorkflowPreflightError('当前未配置 TTS 配音模型', { tool: 'speech_generation', code: 'model_missing' });
  if (!params.mediaComposition && plan.tasks.some((task) => task.tool === 'media_composition')) throw new WorkflowPreflightError('此设备不支持本地音视频合成', { tool: 'media_composition', code: 'device_unsupported' });
  if (!params.imageInspection && plan.tasks.some((task) => task.tool === 'image_inspection')) throw new WorkflowPreflightError('当前文字模型不支持图片检查', { tool: 'image_inspection', code: 'model_unsupported' });
  if (!params.videoInspection && plan.tasks.some((task) => task.tool === 'video_inspection')) throw new WorkflowPreflightError('当前设备或文字模型不支持视频抽帧检查', { tool: 'video_inspection', code: 'model_unsupported' });
  if (!params.videoGeneration && plan.tasks.some((task) => task.tool === 'video_generation')) throw new WorkflowPreflightError(params.videoUnavailableReason || '当前未配置视频模型', { tool: 'video_generation', code: 'service_unavailable' });
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  const dependsOnImage = (task: AgentTeamTask, visited = new Set<string>()): boolean => Boolean(task.savedMedia?.some((media) => media.kind === 'image')) || task.dependsOn.some((dependency) => {
    if (visited.has(dependency)) return false;
    const upstream = tasksById.get(dependency);
    if (!upstream) return false;
    if (teamTaskMediaKind(upstream) === 'image') return true;
    if (upstream.tool === 'delegate_task') return false;
    visited.add(dependency);
    return dependsOnImage(upstream, visited);
  });
  if (!params.videoReferenceImages && !params.videoReferenceImagesOptional && plan.tasks.some((task) => task.tool === 'video_generation' && dependsOnImage(task))) {
    throw new WorkflowPreflightError('当前视频模型不支持参考图片，请改用文字脚本到视频或切换视频模型', { tool: 'video_generation', code: 'model_unsupported' });
  }
  return plan;
}
