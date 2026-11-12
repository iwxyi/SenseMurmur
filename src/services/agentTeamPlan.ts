import type { APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';
import { WorkflowPreflightError } from './workflowRunRuntime';
import { validateMediaCompositionPlan, type MediaCompositionPlan } from './mediaCompositionPlan';
import { WORKFLOW_TOOLS, type WorkflowTool } from './workflowGoalSpec';
import { sameTeamSavedTextVersion, type AgentTeamSavedText } from './agentTeamSavedText';
import { parseTeamJsonSchema, type TeamJsonSchema } from './agentTeamJsonSchema';

export interface AgentTeamRole {
  schemaVersion?: 1;
  id: string;
  name: string;
  responsibility: string;
  method: string;
  acceptance: string;
  allowedTools: WorkflowTool[];
}

export interface AgentTeamTask {
  id: string;
  roleId: string;
  goal: string;
  dependsOn: string[];
  acceptance: string;
  tool?: AgentTeamRole['allowedTools'][number];
  mediaOutput?: 'image' | 'video' | 'audio';
  composition?: MediaCompositionPlan;
  savedMedia?: Array<{ alias: string; taskId: string; kind: 'image' | 'video' | 'audio'; attempt: number; outputSha256: string }>;
  savedText?: AgentTeamSavedText[];
  speech?: { text?: string; textTaskId?: string };
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
    if (selectedTool === 'user_input' && value.deliverable !== undefined) throw new Error('用户提问不能声明生成产物');
    if (value.mediaOutput !== undefined && (tool !== 'delegate_task' || !['image', 'video', 'audio'].includes(String(value.mediaOutput)))) throw new Error('只有委派任务可以声明有效的媒体交付类型');
    if (!rolesById.get(roleId)?.allowedTools.includes(selectedTool)) throw new Error('任务使用了岗位未获授权的工具');
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
        ? { text: requiredText(rawSpeech.text, '配音正文', 12_000) }
        : { textTaskId: identifier(rawSpeech.textTaskId, '配音正文任务 ID') };
    }
    let deliverable: AgentTeamTask['deliverable'];
    if (value.deliverable !== undefined) {
      const rawDeliverable = record(value.deliverable);
      if (rawDeliverable.schemaVersion !== undefined && rawDeliverable.schemaVersion !== 1) throw new Error('不支持的任务交付契约版本');
      const kind = rawDeliverable.kind;
      if (!['document', 'code', 'diagram', 'html', 'table', 'json', 'text'].includes(String(kind))) throw new Error('任务交付类型无效');
      if ((kind === 'table' || kind === 'json') && selectedTool !== 'text_generation' && selectedTool !== 'delegate_task') throw new Error('结构化交付须由文本或委派任务生成');
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
      id: identifier(value.id, '任务 ID'),
      roleId,
      goal: requiredText(value.goal, '任务目标', 1200),
      dependsOn: value.dependsOn.map((dependency) => identifier(dependency, '依赖任务 ID')),
      acceptance: requiredText(value.acceptance, '任务验收', 800),
      ...(value.tool === undefined ? {} : { tool: selectedTool }),
      ...(value.mediaOutput === undefined ? {} : { mediaOutput: value.mediaOutput as AgentTeamTask['mediaOutput'] }),
      ...(composition ? { composition } : {}),
      ...(savedMedia ? { savedMedia } : {}),
      ...(savedText ? { savedText } : {}),
      ...(speech ? { speech } : {}),
      ...(deliverable ? { deliverable } : {}),
    };
  });
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  if (tasksById.size !== tasks.length) throw new Error('任务 ID 重复');
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
  return {
    schemaVersion: 1,
    summary: requiredText(source.summary, '计划摘要', 800),
    roles,
    tasks,
    finalAcceptance: requiredText(source.finalAcceptance, '最终验收', 800),
    ...(resultTaskId ? { resultTaskId } : {}),
  };
}

export async function planAgentTeam(params: { api: APIConfig; goal: string; context?: string; chatId?: string; webSearch?: boolean; imageGeneration?: boolean; imageReferenceImages?: boolean; maxImageReferenceImages?: number; audioGeneration?: boolean; speechGeneration?: boolean; imageInspection?: boolean; videoInspection?: boolean; videoGeneration?: boolean; videoReferenceImages?: boolean; videoRequiresReferenceImage?: boolean; maxVideoReferenceImages?: number; videoUnavailableReason?: string; mediaComposition?: boolean; savedMedia?: Omit<NonNullable<AgentTeamTask['savedMedia']>[number], 'alias'>[]; savedText?: Omit<AgentTeamSavedText, 'alias'>[]; delegation?: boolean; signal?: AbortSignal; beforeModelRequest?: () => Promise<void> }) {
  const goal = requiredText(params.goal, '用户目标', 12_000);
  const context = params.context === undefined || params.context === '' ? '' : requiredText(params.context, '规划上下文', 128_000);
  await params.beforeModelRequest?.();
  const raw = await generateResponse(params.api, [
    '你是通用任务的主 Agent。根据用户目标设计最小可行的团队与无环任务图。简单任务只用一个岗位。',
    `当前开放工具：text_generation${params.webSearch ? '、web_search' : ''}${params.imageGeneration ? '、image_generation' : ''}${params.audioGeneration ? '、audio_generation' : ''}${params.imageInspection ? '、image_inspection' : ''}${params.videoGeneration ? '、video_generation' : ''}${params.mediaComposition ? '、media_composition' : ''}。${params.videoUnavailableReason ? `视频生成当前不可用：${params.videoUnavailableReason}。` : ''}网页搜索任务的 goal 是搜索词；图片任务的 goal 是可生成的画面提示词，可依赖文字脚本、搜索摘要或图片检查文字${params.imageReferenceImages ? `，也可直接依赖已生成图片并作为参考图${params.maxImageReferenceImages ? `（最多 ${params.maxImageReferenceImages} 张）` : ''}` : '；当前图片模型不支持参考图，不要让图片任务直接依赖图片任务'}；音乐任务的 goal 是包含风格、情绪、乐器与可选歌词要求的音乐提示词，系统异步生成完整音频。用户要求明确歌词时，先用 text_generation 写歌词，再让 audio_generation 依赖歌词任务；系统会把歌词交付作为音乐提示词的一部分。图片检查必须直接依赖已生成图片，模型会收到真实画面；视频任务的 goal 是精炼成片提示词，可以依赖脚本${params.videoReferenceImages ? '和图片' : ''}任务。video_generation 不能依赖音乐或其他视频片段。${params.videoRequiresReferenceImage ? '当前视频模型必须先有参考图片。' : ''}${params.videoReferenceImages ? `依赖图片时系统把图片作为参考素材${params.maxVideoReferenceImages ? `，当前模型最多 ${params.maxVideoReferenceImages} 张` : ''}。` : '当前视频模型不能接收参考图片，不要规划图片到视频的依赖。'}视频由系统异步生成，不能声称立即成片。只安排确实必要的图像、音乐与视频生成，避免为验证或补充说明而反复生成同一媒体。不得承诺任意文件写入或代码执行；能力不足时在摘要说明。`,
    '岗位必须有具体职责、方法和可检查的验收标准；任务必须有唯一 ID、岗位归属、明确目标和依赖。不要用岗位名称冒充专业能力。',
    'JSON 交付需要固定字段时，在 deliverable 增加 jsonSchema，按 JSON Schema draft-07 声明 type、properties、required、additionalProperties、items、enum/const 和数值、长度、数量约束，也支持 anyOf/allOf/oneOf/not。每层约束显式声明 type；不支持 $ref、format、pattern 或自定义关键字。例：{"kind":"json","title":"调研结果","jsonSchema":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}}。该契约由程序校验，不得把它当作事实真实性验收。',
    params.delegation ? '另开放 delegate_task 委派工具。仅对确实需要执行时再拆分的复杂子目标使用，不要用它替代普通写作。执行该任务的岗位必须同时获准 delegate_task 和下级工作需要的工具。系统会规划下级任务、等待它们完成，再由父 Agent 汇总交付；下级权限只能缩小，共用总调用预算与并发。委派最多3层，不要重复祖先目标。需要向后续任务交付素材时，在委派任务声明 mediaOutput:"image"、"video" 或 "audio"，下级计划必须以根字段 resultTaskId 指定同类型的最终媒体任务，可继续指向同类型的委派任务。每次委派只交付一份主要媒体；需要多份素材时分别安排任务。后续图片/视频生成、图片/视频检查和合成按委派任务 ID 引用对应类型素材，系统解析实际已保存文件，不读取摘要中的 URL。未声明 mediaOutput 的委派只交付文字汇总。' : '本层不开放 delegate_task，直接安排具体工作，不得创建下级委派；若父任务要求媒体交付，仍须在计划根字段 resultTaskId 指定具体媒体任务。',
    params.videoInspection ? '另开放 video_inspection 视频抽帧检查工具。必须直接依赖唯一的 video_generation 或 media_composition 任务；系统读取该任务已保存的视频并按时间均匀抽取最多6帧，使用当前视觉模型检查实际画面。它只能判断抽样内容，不能检查音轨、逐帧流畅度或保证全部镜头正确。需要检查成片时在合成之后安排此任务；不能为了检查而重新生成视频。' : '当前设备或模型不支持视频抽帧检查，不得安排 video_inspection。',
    params.speechGeneration ? '另开放 speech_generation 旁白配音工具，使用用户配置的 TTS 模型及默认音色。必须声明 speech:{"text":"需要逐字朗读的正文"} 且 dependsOn:[]，或先安排 text_generation 只撰写旁白正文，再声明 speech:{"textTaskId":"narration_script"} 且 dependsOn:["narration_script"]。二者只能选一。goal 描述制作目的，不能混入配音正文；系统只朗读 speech 指定内容，不朗读岗位说明或验收要求。请控制正文长度以适配视频时长，配音不能直接作为 video_generation 的输入，应交给 media_composition 叠加。' : '当前未配置 TTS 模型，不得安排 speech_generation 配音。',
    params.mediaComposition ? '另开放 media_composition 本地音视频合成工具，可按顺序拼接、裁剪视频并叠加最多4条音乐或旁白音轨。它不是视频生成工具，不调用付费模型。合成任务必须声明 composition:{"clips":[{"taskId":"shot_a","startSeconds":0,"durationSeconds":5},{"taskId":"shot_b"}],"audioTracks":[{"taskId":"music","volume":0.7,"offsetSeconds":0,"loop":true}],"aspectRatio":"16:9","originalAudioVolume":0.3}。clips 必填且按播放顺序排列，引用的任务必须直接在 dependsOn 中，视频来源须为 video_generation 或 media_composition，音轨来源须为 audio_generation 或 speech_generation。其余参数均可省略，画面比例可选16:9、9:16、1:1，不裁切主体而用留边统一画幅；最长10分钟，素材合计不超过256MiB，输出720p级MP4。多个镜头先各自生成再交给合成任务；不要让 video_generation 直接依赖音视频。不得声称已视觉检查成片。' : '当前设备不支持本地音视频合成，不得安排 media_composition。',
    params.savedMedia?.length ? `可复用历史素材目录：${JSON.stringify(params.savedMedia)}。优先复用符合要求的素材，不重新生成。任务可增加 savedMedia:[{"alias":"old_clip","taskId":"目录中的原任务标识","kind":"video","attempt":1,"outputSha256":"目录中的完整摘要"}]，除 alias 外必须逐字复制目录字段。dependsOn 只列本次新计划任务，不列历史素材别名。media_composition 接收历史视频/音频，在 composition.clips/audioTracks 中使用 alias；image_generation、image_inspection、video_generation 仅接收历史图片，自动将全部 savedMedia 图片作为参考或检查输入；video_inspection 接收唯一历史视频。检查任务允许使用历史素材替代新计划内的媒体依赖。参考图仍受当前模型能力和数量限制，不支持参考图时不得使用历史图片生成。历史素材可与本次新生成素材混用。不能使用目录外素材、猜测任务标识或将摘要当文件地址。` : '本次没有授权复用的历史素材目录，不得声明 savedMedia。',
    params.savedText?.length ? `可复用历史文字交付目录：${JSON.stringify(params.savedText)}。text_generation、image_generation、video_generation、audio_generation、delegate_task 可声明 savedText:[{"alias":"original_script","taskId":"目录中的原任务标识","attempt":1,"outputSha256":"目录中的完整摘要"}]，除 alias 外逐字复制目录字段，最多8份；系统会按版本提供完整正文（每份最多12000字符），不要为读取原稿而重新创作。dependsOn 只列新计划任务，不列历史别名。speech_generation 可仅指定一份 savedText，并声明 speech:{"textTaskId":"original_script"} 与 dependsOn:[]，逐字朗读该正文；不得同时指定 literal text 或其他历史正文。别名不能与本计划任务或历史素材别名重名。目录摘要仅绑定当时文字记录，不保证其中事实已核实。` : '本次没有授权复用的历史文字目录，不得声明 savedText。',
    params.savedText?.some((entry) => entry.artifact) ? '历史文字目录中带 artifact:{id,versionId,filePath?} 的条目对应用户当前选中的产物版本；filePath 表示该版本中的指定文本文件，不带 filePath 表示单正文。不带 artifact 的条目对应任务原始交付。用户要求使用修改后的稿件或项目文件时，优先选择相应 artifact 条目，完整复制 artifact 和摘要。同一来源每个文件最多选一份版本，可用不同 alias 引用多个文件；仍最多8份。系统固定读取所选版本，不会随产物后续编辑而自动切换；缺失或正文变化会明确报错。此入口不读取图片、音视频或 HTML 交互状态。' : '',
    '另开放 user_input 用户提问工具：只有必须由用户补充关键信息才能继续时使用，goal 是清晰具体的问题，可依赖已完成步骤。系统等待用户真实答复，后续任务通过 dependsOn 读取答复；不得猜测答复或代替用户确认。它不扩大工具授权，不代表费用或外部操作的审批。用户已经要求自主完成时优先合理决策，避免不必要的追问。不为提问声明 deliverable。',
    '只为需要用户单独打开、复用或编辑的任务声明 deliverable；可选类型 document、table、code、diagram、html、json、text。交付契约 schemaVersion 为 1，格式为 {"schemaVersion":1,"kind":"table","title":"市场比较表","language":"csv"}。json 交付必须是可解析的纯 JSON；字段要求写入任务验收标准。未声明时仍会纳入团队总结，不要给搜索、图片/音频/视频生成等每个步骤机械创建文字产物。只输出 JSON：{"schemaVersion":1,"summary":"...","roles":[{"schemaVersion":1,"id":"researcher","name":"...","responsibility":"...","method":"...","acceptance":"...","allowedTools":["text_generation"]}],"tasks":[{"id":"research","roleId":"researcher","goal":"...","dependsOn":[],"tool":"text_generation","acceptance":"...","deliverable":{"schemaVersion":1,"kind":"table","title":"比较表","language":"csv"}}],"finalAcceptance":"..."}',
  ].join('\n'), [{ role: 'user', content: goal + (context ? `\n${context}` : '') }], undefined, {
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
  if (plan.tasks.some((task) => task.savedMedia?.some((media) => !params.savedMedia?.some((source) => source.taskId === media.taskId
    && source.kind === media.kind && source.attempt === media.attempt && source.outputSha256 === media.outputSha256)))) {
    throw new WorkflowPreflightError('规划引用了未授权或版本不符的历史素材');
  }
  if (plan.tasks.some((task) => task.savedText?.some((entry) => !params.savedText?.some((source) => sameTeamSavedTextVersion(source, entry))))) throw new WorkflowPreflightError('规划引用了未授权或版本不符的历史文字');
  if (!params.delegation && plan.roles.some((role) => role.allowedTools.includes('delegate_task'))) throw new WorkflowPreflightError('本层未获准下级委派');
  if (!params.webSearch && plan.tasks.some((task) => task.tool === 'web_search')) throw new WorkflowPreflightError('当前会话未开启网页搜索');
  if (!params.imageGeneration && plan.tasks.some((task) => task.tool === 'image_generation')) throw new WorkflowPreflightError('当前未配置图片模型');
  if (!params.imageReferenceImages && plan.tasks.some((task) => task.tool === 'image_generation'
    && directTeamMediaReferences(task, new Map(plan.tasks.map((source) => [source.id, source])), 'image').length > 0)) {
    throw new WorkflowPreflightError('当前图片模型不支持参考图片');
  }
  if (params.maxImageReferenceImages && plan.tasks.some((task) => task.tool === 'image_generation'
    && directTeamMediaReferences(task, new Map(plan.tasks.map((source) => [source.id, source])), 'image').length > params.maxImageReferenceImages!)) {
    throw new WorkflowPreflightError(`当前图片模型最多支持 ${params.maxImageReferenceImages} 张参考图片`);
  }
  if (!params.audioGeneration && plan.tasks.some((task) => task.tool === 'audio_generation')) throw new WorkflowPreflightError('当前未配置音乐生成模型');
  if (!params.speechGeneration && plan.tasks.some((task) => task.tool === 'speech_generation')) throw new WorkflowPreflightError('当前未配置 TTS 配音模型');
  if (!params.mediaComposition && plan.tasks.some((task) => task.tool === 'media_composition')) throw new WorkflowPreflightError('此设备不支持本地音视频合成');
  if (!params.imageInspection && plan.tasks.some((task) => task.tool === 'image_inspection')) throw new WorkflowPreflightError('当前文字模型不支持图片检查');
  if (!params.videoInspection && plan.tasks.some((task) => task.tool === 'video_inspection')) throw new WorkflowPreflightError('当前设备或文字模型不支持视频抽帧检查');
  if (!params.videoGeneration && plan.tasks.some((task) => task.tool === 'video_generation')) throw new WorkflowPreflightError(params.videoUnavailableReason || '当前未配置视频模型');
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
  if (!params.videoReferenceImages && plan.tasks.some((task) => task.tool === 'video_generation' && dependsOnImage(task))) {
    throw new WorkflowPreflightError('当前视频模型不支持参考图片，请改用文字脚本到视频或切换视频模型');
  }
  return plan;
}
