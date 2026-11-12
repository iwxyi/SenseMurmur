import type { APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';
import { WorkflowPreflightError } from './workflowRunRuntime';
import { validateMediaCompositionPlan, type MediaCompositionPlan } from './mediaCompositionPlan';

export interface AgentTeamRole {
  schemaVersion?: 1;
  id: string;
  name: string;
  responsibility: string;
  method: string;
  acceptance: string;
  allowedTools: Array<'text_generation' | 'web_search' | 'image_generation' | 'audio_generation' | 'speech_generation' | 'video_generation' | 'image_inspection' | 'media_composition'>;
}

export interface AgentTeamTask {
  id: string;
  roleId: string;
  goal: string;
  dependsOn: string[];
  acceptance: string;
  tool?: AgentTeamRole['allowedTools'][number];
  composition?: MediaCompositionPlan;
  speech?: { text?: string; textTaskId?: string };
  deliverable?: {
    kind: 'document' | 'code' | 'diagram' | 'html' | 'table' | 'json' | 'text';
    title: string;
    language?: string;
  };
}

export interface AgentTeamPlan {
  schemaVersion?: 1;
  summary: string;
  roles: AgentTeamRole[];
  tasks: AgentTeamTask[];
  finalAcceptance: string;
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,39}$/;
const TOOLS = new Set(['text_generation', 'web_search', 'image_generation', 'audio_generation', 'speech_generation', 'video_generation', 'image_inspection', 'media_composition']);

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
  if (source.schemaVersion !== undefined && source.schemaVersion !== 1) throw new Error('团队计划版本不受支持');
  if (!Array.isArray(source.roles) || !Array.isArray(source.tasks)) throw new Error('团队计划缺少岗位或任务');
  if (source.roles.length < 1 || source.roles.length > 8 || source.tasks.length < 1 || source.tasks.length > 48) throw new Error('团队计划规模超出限制');
  const roles = source.roles.map((item): AgentTeamRole => {
    const value = record(item);
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('岗位契约版本不受支持');
    if (!Array.isArray(value.allowedTools) || value.allowedTools.some((tool) => !TOOLS.has(tool))) throw new Error('岗位申请了不可用工具');
    return {
      schemaVersion: 1,
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
    if (typeof tool !== 'string' || !TOOLS.has(tool)) throw new Error('任务申请了不可用工具');
    const selectedTool = tool as AgentTeamRole['allowedTools'][number];
    if (!rolesById.get(roleId)?.allowedTools.includes(selectedTool)) throw new Error('任务使用了岗位未获授权的工具');
    if (!Array.isArray(value.dependsOn) || value.dependsOn.length > (tool === 'media_composition' ? 48 : 8)
      || new Set(value.dependsOn).size !== value.dependsOn.length) throw new Error('任务依赖无效');
    if (tool !== 'media_composition' && value.composition !== undefined) throw new Error('只有合成任务可以声明合成配置');
    const composition = tool === 'media_composition' ? validateMediaCompositionPlan(value.composition) : undefined;
    if (tool !== 'speech_generation' && value.speech !== undefined) throw new Error('只有配音任务可以声明配音正文');
    let speech: AgentTeamTask['speech'];
    if (tool === 'speech_generation') {
      const rawSpeech = record(value.speech);
      if ((rawSpeech.text === undefined) === (rawSpeech.textTaskId === undefined)) throw new Error('配音必须指定正文或正文任务，且只能选择一种');
      speech = rawSpeech.text !== undefined
        ? { text: requiredText(rawSpeech.text, '配音正文', 12_000) }
        : { textTaskId: identifier(rawSpeech.textTaskId, '配音正文任务 ID') };
    }
    let deliverable: AgentTeamTask['deliverable'];
    if (value.deliverable !== undefined) {
      const rawDeliverable = record(value.deliverable);
      const kind = rawDeliverable.kind;
      if (!['document', 'code', 'diagram', 'html', 'table', 'json', 'text'].includes(String(kind))) throw new Error('任务交付类型无效');
      deliverable = {
        kind: kind as NonNullable<AgentTeamTask['deliverable']>['kind'],
        title: requiredText(rawDeliverable.title, '任务交付标题', 120),
        ...(rawDeliverable.language === undefined ? {} : { language: requiredText(rawDeliverable.language, '交付语言', 40) }),
      };
    }
    return {
      id: identifier(value.id, '任务 ID'),
      roleId,
      goal: requiredText(value.goal, '任务目标', 1200),
      dependsOn: value.dependsOn.map((dependency) => identifier(dependency, '依赖任务 ID')),
      acceptance: requiredText(value.acceptance, '任务验收', 800),
      ...(value.tool === undefined ? {} : { tool: selectedTool }),
      ...(composition ? { composition } : {}),
      ...(speech ? { speech } : {}),
      ...(deliverable ? { deliverable } : {}),
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
  if (tasks.some((task) => task.tool === 'audio_generation'
    && task.dependsOn.some((id) => !['text_generation', 'web_search'].includes(tasksById.get(id)?.tool || 'text_generation')))) {
    throw new Error('音乐任务目前只能依赖文字歌词或说明');
  }
  for (const task of tasks.filter((item) => item.tool === 'speech_generation')) {
    const sourceId = task.speech?.textTaskId;
    if (sourceId ? task.dependsOn.length !== 1 || task.dependsOn[0] !== sourceId
      || (tasksById.get(sourceId)?.tool || 'text_generation') !== 'text_generation' : task.dependsOn.length !== 0) {
      throw new Error('配音只能直接使用正文，或依赖唯一的文字正文任务');
    }
  }
  if (tasks.some((task) => task.tool === 'image_generation'
    && task.dependsOn.some((id) => !['text_generation', 'web_search', 'image_inspection', 'image_generation'].includes(tasksById.get(id)?.tool || 'text_generation')))) {
    throw new Error('图片任务只能依赖文字或已生成图片，不能读取音频与视频附件');
  }
  const hasUnsupportedVideoAncestor = (task: AgentTeamTask, visited = new Set<string>()): boolean => task.dependsOn.some((id) => {
    if (visited.has(id)) return false;
    visited.add(id);
    const source = tasksById.get(id);
    return Boolean(source && (source.tool === 'audio_generation' || source.tool === 'speech_generation' || source.tool === 'video_generation' || source.tool === 'media_composition'
      || hasUnsupportedVideoAncestor(source, visited)));
  });
  if (tasks.some((task) => task.tool === 'video_generation' && hasUnsupportedVideoAncestor(task))) {
    throw new Error('视频任务目前不能接收已生成的音乐或视频片段；需要配乐或拼接时须使用音视频合成工具');
  }
  for (const task of tasks.filter((item) => item.tool === 'media_composition')) {
    const composition = task.composition!;
    for (const clip of composition.clips) {
      if (!task.dependsOn.includes(clip.taskId) || !['video_generation', 'media_composition'].includes(tasksById.get(clip.taskId)?.tool || '')) throw new Error('合成片段必须直接依赖视频生成或合成任务');
    }
    for (const track of composition.audioTracks || []) {
      if (!task.dependsOn.includes(track.taskId) || !['audio_generation', 'speech_generation'].includes(tasksById.get(track.taskId)?.tool || '')) throw new Error('合成音轨必须直接依赖音乐生成或配音任务');
    }
  }
  return {
    schemaVersion: 1,
    summary: requiredText(source.summary, '计划摘要', 800),
    roles,
    tasks,
    finalAcceptance: requiredText(source.finalAcceptance, '最终验收', 800),
  };
}

export async function planAgentTeam(params: { api: APIConfig; goal: string; chatId?: string; webSearch?: boolean; imageGeneration?: boolean; imageReferenceImages?: boolean; maxImageReferenceImages?: number; audioGeneration?: boolean; speechGeneration?: boolean; imageInspection?: boolean; videoGeneration?: boolean; videoReferenceImages?: boolean; videoRequiresReferenceImage?: boolean; maxVideoReferenceImages?: number; videoUnavailableReason?: string; mediaComposition?: boolean; signal?: AbortSignal }) {
  const goal = requiredText(params.goal, '用户目标', 12_000);
  const raw = await generateResponse(params.api, [
    '你是通用任务的主 Agent。根据用户目标设计最小可行的团队与无环任务图。简单任务只用一个岗位。',
    `当前开放工具：text_generation${params.webSearch ? '、web_search' : ''}${params.imageGeneration ? '、image_generation' : ''}${params.audioGeneration ? '、audio_generation' : ''}${params.imageInspection ? '、image_inspection' : ''}${params.videoGeneration ? '、video_generation' : ''}${params.mediaComposition ? '、media_composition' : ''}。${params.videoUnavailableReason ? `视频生成当前不可用：${params.videoUnavailableReason}。` : ''}网页搜索任务的 goal 是搜索词；图片任务的 goal 是可生成的画面提示词，可依赖文字脚本、搜索摘要或图片检查文字${params.imageReferenceImages ? `，也可直接依赖已生成图片并作为参考图${params.maxImageReferenceImages ? `（最多 ${params.maxImageReferenceImages} 张）` : ''}` : '；当前图片模型不支持参考图，不要让图片任务直接依赖图片任务'}；音乐任务的 goal 是包含风格、情绪、乐器与可选歌词要求的音乐提示词，系统异步生成完整音频。用户要求明确歌词时，先用 text_generation 写歌词，再让 audio_generation 依赖歌词任务；系统会把歌词交付作为音乐提示词的一部分。图片检查必须直接依赖已生成图片，模型会收到真实画面；视频任务的 goal 是精炼成片提示词，可以依赖脚本${params.videoReferenceImages ? '和图片' : ''}任务。video_generation 不能依赖音乐或其他视频片段。${params.videoRequiresReferenceImage ? '当前视频模型必须先有参考图片。' : ''}${params.videoReferenceImages ? `依赖图片时系统把图片作为参考素材${params.maxVideoReferenceImages ? `，当前模型最多 ${params.maxVideoReferenceImages} 张` : ''}。` : '当前视频模型不能接收参考图片，不要规划图片到视频的依赖。'}视频由系统异步生成，不能声称立即成片。只安排确实必要的图像、音乐与视频生成，避免为验证或补充说明而反复生成同一媒体。不得承诺任意文件写入或代码执行；能力不足时在摘要说明。`,
    '岗位必须有具体职责、方法和可检查的验收标准；任务必须有唯一 ID、岗位归属、明确目标和依赖。不要用岗位名称冒充专业能力。',
    params.speechGeneration ? '另开放 speech_generation 旁白配音工具，使用用户配置的 TTS 模型及默认音色。必须声明 speech:{"text":"需要逐字朗读的正文"} 且 dependsOn:[]，或先安排 text_generation 只撰写旁白正文，再声明 speech:{"textTaskId":"narration_script"} 且 dependsOn:["narration_script"]。二者只能选一。goal 描述制作目的，不能混入配音正文；系统只朗读 speech 指定内容，不朗读岗位说明或验收要求。请控制正文长度以适配视频时长，配音不能直接作为 video_generation 的输入，应交给 media_composition 叠加。' : '当前未配置 TTS 模型，不得安排 speech_generation 配音。',
    params.mediaComposition ? '另开放 media_composition 本地音视频合成工具，可按顺序拼接、裁剪视频并叠加最多4条音乐或旁白音轨。它不是视频生成工具，不调用付费模型。合成任务必须声明 composition:{"clips":[{"taskId":"shot_a","startSeconds":0,"durationSeconds":5},{"taskId":"shot_b"}],"audioTracks":[{"taskId":"music","volume":0.7,"offsetSeconds":0,"loop":true}],"aspectRatio":"16:9","originalAudioVolume":0.3}。clips 必填且按播放顺序排列，引用的任务必须直接在 dependsOn 中，视频来源须为 video_generation 或 media_composition，音轨来源须为 audio_generation 或 speech_generation。其余参数均可省略，画面比例可选16:9、9:16、1:1，不裁切主体而用留边统一画幅；最长10分钟，素材合计不超过256MiB，输出720p级MP4。多个镜头先各自生成再交给合成任务；不要让 video_generation 直接依赖音视频。不得声称已视觉检查成片。' : '当前设备不支持本地音视频合成，不得安排 media_composition。',
    '只为需要用户单独打开、复用或编辑的任务声明 deliverable；可选类型 document、table、code、diagram、html、json、text。格式为 {"kind":"table","title":"市场比较表","language":"csv"}。未声明时仍会纳入团队总结，不要给搜索、图片/音频/视频生成等每个步骤机械创建文字产物。只输出 JSON：{"schemaVersion":1,"summary":"...","roles":[{"schemaVersion":1,"id":"researcher","name":"...","responsibility":"...","method":"...","acceptance":"...","allowedTools":["text_generation"]}],"tasks":[{"id":"research","roleId":"researcher","goal":"...","dependsOn":[],"tool":"text_generation","acceptance":"...","deliverable":{"kind":"table","title":"比较表","language":"csv"}}],"finalAcceptance":"..."}',
  ].join('\n'), [{ role: 'user', content: goal }], undefined, {
    responseFormat: 'json', maxTokens: 10_000, signal: params.signal,
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
  if (!params.imageReferenceImages && plan.tasks.some((task) => task.tool === 'image_generation'
    && task.dependsOn.some((id) => plan.tasks.find((source) => source.id === id)?.tool === 'image_generation'))) {
    throw new WorkflowPreflightError('当前图片模型不支持参考图片');
  }
  if (params.maxImageReferenceImages && plan.tasks.some((task) => task.tool === 'image_generation'
    && task.dependsOn.filter((id) => plan.tasks.find((source) => source.id === id)?.tool === 'image_generation').length > params.maxImageReferenceImages!)) {
    throw new WorkflowPreflightError(`当前图片模型最多支持 ${params.maxImageReferenceImages} 张参考图片`);
  }
  if (!params.audioGeneration && plan.tasks.some((task) => task.tool === 'audio_generation')) throw new WorkflowPreflightError('当前未配置音乐生成模型');
  if (!params.speechGeneration && plan.tasks.some((task) => task.tool === 'speech_generation')) throw new WorkflowPreflightError('当前未配置 TTS 配音模型');
  if (!params.mediaComposition && plan.tasks.some((task) => task.tool === 'media_composition')) throw new WorkflowPreflightError('此设备不支持本地音视频合成');
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
