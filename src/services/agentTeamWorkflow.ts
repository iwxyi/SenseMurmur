import { getUsablePreferredAIProfile, normalizeImageCapabilities, resolveAIModelInputCapabilities, type APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';
import { planAgentTeam, teamTaskMediaKind, validateAgentTeamPlan, type AgentTeamPlan, type AgentTeamTask } from './agentTeamPlan';
import { assertTeamMediaOutput, resolveTeamDelegationMedia, resolveTeamMediaTask } from './agentTeamMediaReference';
import { countWorkflowModelCalls, createWorkflowRunRuntime, indexedDbWorkflowRepository, summarizeWorkflowRun, WorkflowPreflightError, type WorkflowTask, type WorkflowSnapshot } from './workflowRunRuntime';
import { ensureAssistantArtifactStoreHydrated, useAssistantArtifactStore } from '../stores/useAssistantArtifactStore';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { currentWorkflowScope, workflowRunLockName } from './workflowRunRuntime';
import { attachMessageToActiveBranch } from './messageBranching';
import { advanceTeamConversation, captureTeamSourceBranch, teamConversationBlockReason, teamConversationContext } from './agentTeamConversation';
import type { Message } from '../types/message';
import type { AssistantArtifactItem } from '../types/assistantArtifact';
import { useSettingsStore } from '../stores/useSettingsStore';
import { readAuthSnapshot } from './authSnapshot';
import { getWorkspaceSignal } from './workspaceLifecycle';
import { scheduleBackgroundExecution } from './backgroundExecutionScheduler';
import { runWithConversationExecutionLock } from './conversationExecutionLock';
import { assertChatExecutionLease } from './chatExecutionLease';
import { getChatExecutionFence } from './chatExecutionFence';
import { api as appApi } from './api';
import { resolveChatAgentCapabilities } from './chatAgentCapabilities';
import { inspectAgentTeamVideoAttachment, queueAgentTeamVideo } from './agentTeamVideoTask';
import { inspectAgentTeamImageAttachment, queueAgentTeamImage, teamImageReference } from './agentTeamImageTask';
import { inspectAgentTeamImages } from './agentTeamImageInspection';
import { inspectAgentTeamAudioAttachment, queueAgentTeamAudio } from './agentTeamAudioTask';
import { listAvailableModels } from './aiClient';
import { canComposeTeamMedia, composeAgentTeamMedia, inspectAgentTeamComposition, teamMediaAttachment } from './agentTeamMediaComposition';
import { hasRepeatedTeamReviewWithoutProgress } from './agentTeamProgress';
import { inspectAgentTeamVideo } from './agentTeamVideoInspection';
import { assertWorkflowToolAuthorized, defaultWorkflowGoalSpec, parseWorkflowGoalSpec, workflowGoalContext, type WorkflowGoalSpec } from './workflowGoalSpec';

const TOOL_TASK_KINDS = {
  text_generation: 'agent_text', web_search: 'agent_web_search', image_generation: 'agent_image', audio_generation: 'agent_audio', speech_generation: 'agent_audio',
  image_inspection: 'agent_image_inspection', video_inspection: 'agent_video_inspection', video_generation: 'agent_video', media_composition: 'agent_media_composition',
  delegate_task: 'agent_delegation',
} as const;

function teamTaskKind(task: AgentTeamTask) { return TOOL_TASK_KINDS[task.tool || 'text_generation']; }
function assertGoalPlanAuthorized(snapshot: WorkflowSnapshot, plan: AgentTeamPlan) {
  try {
    for (const role of plan.roles) for (const tool of role.allowedTools) assertWorkflowToolAuthorized(snapshot.run.goalSpec, tool);
  } catch (error) {
    throw new WorkflowPreflightError(error instanceof Error ? error.message : '目标授权无效');
  }
}
function isAgentTaskKind(kind: string) { return Object.values(TOOL_TASK_KINDS).some((value) => value === kind); }

function requireActiveAssistantChat(chatId: string) {
  const chat = useChatStore.getState().chats.find((item) => item.id === chatId && item.type === 'assistant' && item.deletedAt == null);
  if (!chat) throw new WorkflowPreflightError('助手会话已删除或不可用');
  return chat;
}

async function teamMediaCapabilities() {
  const profiles = useSettingsStore.getState().aiProfiles;
  const imageProfile = getUsablePreferredAIProfile(profiles, 'image');
  const audioProfile = getUsablePreferredAIProfile(profiles, 'audio');
  const textProfile = getUsablePreferredAIProfile(profiles, 'text');
  const imageCapabilities = normalizeImageCapabilities(imageProfile?.imageCapabilities);
  const media = { imageGeneration: Boolean(imageProfile), imageReferenceImages: Boolean(imageProfile && imageCapabilities.referenceImage),
    maxImageReferenceImages: imageProfile && imageCapabilities.referenceImage ? imageCapabilities.multiReferenceImage ? undefined : 1 : 0,
    audioGeneration: Boolean(audioProfile), speechGeneration: Boolean(getUsablePreferredAIProfile(profiles, 'tts')),
    imageInspection: Boolean(imageProfile && textProfile && resolveAIModelInputCapabilities(textProfile).imageInput),
    videoInspection: Boolean(typeof document !== 'undefined' && textProfile && resolveAIModelInputCapabilities(textProfile).imageInput),
    mediaComposition: canComposeTeamMedia() };
  const videoProfile = getUsablePreferredAIProfile(profiles, 'video');
  if (!videoProfile) return { ...media, videoGeneration: false, videoReferenceImages: false, videoRequiresReferenceImage: false, maxVideoReferenceImages: 0, videoUnavailableReason: '当前未配置视频模型' };
  let videoReferenceImages = false;
  let videoRequiresReferenceImage = false;
  let maxVideoReferenceImages: number | undefined = 0;
  if (videoProfile.provider.startsWith('official')) {
    let models: Awaited<ReturnType<typeof listAvailableModels>>;
    try { models = await listAvailableModels(videoProfile, 'video'); }
    catch (error) {
      return { ...media, videoGeneration: false, videoReferenceImages: false, videoRequiresReferenceImage: false, maxVideoReferenceImages: 0,
        videoUnavailableReason: `视频模型目录暂不可用：${error instanceof Error ? error.message : '查询失败'}` };
    }
    const selected = models.find((item) => item.id === videoProfile.model);
    if (!selected) return { ...media, videoGeneration: false, videoReferenceImages: false, videoRequiresReferenceImage: false, maxVideoReferenceImages: 0, videoUnavailableReason: '当前视频模型未在可用模型列表中' };
    const raw = selected.raw;
    const options = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.aceVideoOptions : undefined;
    videoReferenceImages = Boolean(options && typeof options === 'object' && !Array.isArray(options)
      && (options as Record<string, unknown>).acceptsReferenceImages === true);
    videoRequiresReferenceImage = Boolean(options && typeof options === 'object' && !Array.isArray(options)
      && (options as Record<string, unknown>).requiresReferenceImage === true);
    const advertisedLimit = options && typeof options === 'object' && !Array.isArray(options)
      ? (options as Record<string, unknown>).maxReferenceImages : undefined;
    maxVideoReferenceImages = videoReferenceImages && typeof advertisedLimit === 'number' && Number.isInteger(advertisedLimit)
      ? advertisedLimit : videoReferenceImages ? undefined : 0;
  }
  return { ...media, videoGeneration: true, videoReferenceImages, videoRequiresReferenceImage, maxVideoReferenceImages, videoUnavailableReason: undefined };
}

interface TeamTaskInput {
  task: AgentTeamTask;
  goal: string;
  role: AgentTeamPlan['roles'][number];
  userInstruction?: string;
  sourcePlanTaskId?: string;
  contextTaskIds?: string[];
}

interface TeamRevisionInput { request: string; sourceTaskIds: string[] }
interface TeamReviewInput { sourceTaskIds: string[] }

function selectReviewEvidence(snapshot: WorkflowSnapshot, taskIds: string[]) {
  const sources = taskIds.map((id) => {
    const source = snapshot.tasks.find((item) => item.id === id);
    if (!source || source.status !== 'completed' || typeof source.output !== 'string') throw new WorkflowPreflightError('验收证据尚未就绪');
    return source;
  });
  const maxPerTask = sources.length <= 12 ? 1800 : Math.max(240, Math.floor(24_000 / sources.length));
  return { omitted: 0,
    evidence: sources.map((source) => ({ task: source.id, output: (source.output as string).slice(0, maxPerTask) })) };
}

function countImageUpstream(task: AgentTeamTask, byId: Map<string, AgentTeamTask>) {
  const visited = new Set<string>();
  const visit = (current: AgentTeamTask) => current.dependsOn.forEach((id) => {
    if (visited.has(id)) return;
    visited.add(id);
    const upstream = byId.get(id);
    if (upstream && upstream.tool !== 'delegate_task') visit(upstream);
  });
  visit(task);
  return [...visited].filter((id) => teamTaskMediaKind(byId.get(id)) === 'image').length;
}

function directImageDependencies(task: AgentTeamTask, byId: Map<string, AgentTeamTask>) {
  return task.dependsOn.filter((id) => teamTaskMediaKind(byId.get(id)) === 'image');
}

function parseTeamReview(value: unknown): { complete: boolean; reason: string; nextRequest?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowPreflightError('主 Agent 验收结果无效');
  const result = value as Record<string, unknown>;
  if (typeof result.complete !== 'boolean' || typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 1000) throw new WorkflowPreflightError('主 Agent 验收结果无效');
  if (!result.complete && (typeof result.nextRequest !== 'string' || !result.nextRequest.trim() || result.nextRequest.length > 2000)) throw new WorkflowPreflightError('主 Agent 缺少后续任务说明');
  return { complete: result.complete, reason: result.reason.trim(), ...(!result.complete ? { nextRequest: (result.nextRequest as string).trim() } : {}) };
}

function reviewBlockTask(runId: string, reviewId: string, reason: string): WorkflowTask {
  return { id: 'review_needs_user', runId, kind: 'team_review_block', input: null, dependsOn: [reviewId],
    status: 'waiting_user', error: reason, attempt: 0, updatedAt: Date.now() };
}

function delegatedTaskId(sourcePlanTaskId: string, taskId: string) {
  return sourcePlanTaskId === 'delegate' ? `delegated_${taskId}` : `${sourcePlanTaskId}_${taskId}`;
}

function originalPlanTaskId(sourcePlanTaskId: string, taskId: string) {
  const prefix = delegatedTaskId(sourcePlanTaskId, '');
  return taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId;
}

function isTeamRevisionInput(value: unknown): value is TeamRevisionInput {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TeamRevisionInput>;
  return typeof candidate.request === 'string' && candidate.request.trim().length > 0
    && Array.isArray(candidate.sourceTaskIds) && candidate.sourceTaskIds.every((id) => typeof id === 'string');
}

function isTeamTaskInput(value: unknown): value is TeamTaskInput {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TeamTaskInput>;
  return Boolean(candidate.task && candidate.role && typeof candidate.goal === 'string');
}

function delegationAncestors(snapshot: WorkflowSnapshot, task: WorkflowTask): WorkflowTask[] {
  const ancestors: WorkflowTask[] = [];
  const visited = new Set([task.id]);
  let sourceId = isTeamTaskInput(task.input) ? task.input.sourcePlanTaskId : undefined;
  while (sourceId) {
    if (visited.has(sourceId)) throw new WorkflowPreflightError('委派关系形成循环');
    visited.add(sourceId);
    const source = snapshot.tasks.find((item) => item.id === sourceId);
    if (!source) throw new WorkflowPreflightError('委派来源不存在');
    if (source.kind !== 'agent_delegation') break;
    ancestors.push(source);
    sourceId = isTeamTaskInput(source.input) ? source.input.sourcePlanTaskId : undefined;
  }
  return ancestors;
}

function assertInheritedPlanAuthorized(snapshot: WorkflowSnapshot, parent: WorkflowTask, plan: AgentTeamPlan) {
  assertGoalPlanAuthorized(snapshot, plan);
  if (!isTeamTaskInput(parent.input)) throw new WorkflowPreflightError('父任务授权记录无效');
  const tools = parent.input.role.allowedTools;
  if (plan.roles.some((role) => role.allowedTools.some((tool) => !tools.includes(tool)))) throw new WorkflowPreflightError('下级岗位申请了父任务未获准的工具');
}

function sameAgentTeamRole(left: AgentTeamPlan['roles'][number], right: AgentTeamPlan['roles'][number]) {
  const leftTools = new Set(left.allowedTools);
  const rightTools = new Set(right.allowedTools);
  return left.id === right.id
    && left.name === right.name
    && left.responsibility === right.responsibility
    && left.method === right.method
    && left.acceptance === right.acceptance
    && leftTools.size === rightTools.size
    && [...leftTools].every((tool) => rightTools.has(tool));
}

function sameAgentTeamTask(left: AgentTeamPlan['tasks'][number], right: AgentTeamPlan['tasks'][number]) {
  const leftDependencies = new Set(left.dependsOn);
  const rightDependencies = new Set(right.dependsOn);
  return left.id === right.id
    && left.roleId === right.roleId
    && left.goal === right.goal
    && left.acceptance === right.acceptance
    && (left.tool || 'text_generation') === (right.tool || 'text_generation')
    && left.mediaOutput === right.mediaOutput
    && left.deliverable?.kind === right.deliverable?.kind
    && left.deliverable?.title === right.deliverable?.title
    && left.deliverable?.language === right.deliverable?.language
    && JSON.stringify(left.composition) === JSON.stringify(right.composition)
    && JSON.stringify(left.speech) === JSON.stringify(right.speech)
    && leftDependencies.size === rightDependencies.size
    && [...leftDependencies].every((id) => rightDependencies.has(id));
}

export function buildAgentTeamTaskRevisionRequest(task: WorkflowTask, instruction: string) {
  const trimmed = instruction.trim();
  if (!trimmed || trimmed.length > 4000) throw new WorkflowPreflightError('补充指示应为 1 到 4000 个字符');
  if (task.status !== 'completed' || task.attempt < 1 || !isTeamTaskInput(task.input)) {
    throw new WorkflowPreflightError('只有已完成的子 Agent 任务可以发起定向追加委派');
  }
  const role = task.input.role;
  const originalTask = task.input.task;
  return [
    `请围绕已完成的子 Agent 任务“${role.name}”进行定向追加协作。`,
    `原职责：${role.responsibility}`,
    `原方法：${role.method}`,
    `原任务：${originalTask.goal}`,
    `原验收：${originalTask.acceptance}`,
    `用户给该子 Agent 的新指示：${trimmed}`,
    '只规划这条指示所需的补充或修订工作；复用 Run 中已有交付作为证据，不重复已完成的生成任务。',
  ].join('\n');
}

function validateAvailableTeamTools(plan: AgentTeamPlan, capabilities: Awaited<ReturnType<typeof teamMediaCapabilities>>, webSearch: boolean) {
  if (!webSearch && plan.tasks.some((task) => task.tool === 'web_search')) throw new WorkflowPreflightError('当前会话未开启网页搜索');
  if (!capabilities.imageGeneration && plan.tasks.some((task) => task.tool === 'image_generation')) throw new WorkflowPreflightError('当前未配置图片模型');
  if (!capabilities.audioGeneration && plan.tasks.some((task) => task.tool === 'audio_generation')) throw new WorkflowPreflightError('当前未配置音乐生成模型');
  if (!capabilities.speechGeneration && plan.tasks.some((task) => task.tool === 'speech_generation')) throw new WorkflowPreflightError('当前未配置 TTS 配音模型');
  if (!capabilities.mediaComposition && plan.tasks.some((task) => task.tool === 'media_composition')) throw new WorkflowPreflightError('此设备不支持本地音视频合成');
  if (!capabilities.imageInspection && plan.tasks.some((task) => task.tool === 'image_inspection')) throw new WorkflowPreflightError('当前文字模型不支持图片检查');
  if (!capabilities.videoInspection && plan.tasks.some((task) => task.tool === 'video_inspection')) throw new WorkflowPreflightError('当前设备或文字模型不支持视频抽帧检查');
  if (!capabilities.videoGeneration && plan.tasks.some((task) => task.tool === 'video_generation')) throw new WorkflowPreflightError(capabilities.videoUnavailableReason || '当前视频模型不可用');
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  if (!capabilities.imageReferenceImages && plan.tasks.some((task) => task.tool === 'image_generation' && directImageDependencies(task, byId).length > 0)) {
    throw new WorkflowPreflightError('当前图片模型不支持参考图片，请切换模型或改用图片检查文字迭代');
  }
  if (capabilities.maxImageReferenceImages !== undefined && plan.tasks.some((task) => task.tool === 'image_generation'
    && directImageDependencies(task, byId).length > capabilities.maxImageReferenceImages!)) {
    throw new WorkflowPreflightError(`当前图片模型最多支持 ${capabilities.maxImageReferenceImages} 张参考图片，请减少素材或更换模型`);
  }
  if (!capabilities.videoReferenceImages && plan.tasks.some((task) => task.tool === 'video_generation' && countImageUpstream(task, byId) > 0)) {
    throw new WorkflowPreflightError('当前视频模型不支持参考图片，请切换视频模型或调整追加要求');
  }
  if (capabilities.videoRequiresReferenceImage && plan.tasks.some((task) => task.tool === 'video_generation' && countImageUpstream(task, byId) === 0)) {
    throw new WorkflowPreflightError('当前视频模型必须提供参考图片，请先生成图片素材或更换模型');
  }
  if (capabilities.maxVideoReferenceImages !== undefined && plan.tasks.some((task) => task.tool === 'video_generation'
    && countImageUpstream(task, byId) > capabilities.maxVideoReferenceImages!)) {
    throw new WorkflowPreflightError(`当前视频模型最多支持 ${capabilities.maxVideoReferenceImages} 张参考图片，请减少素材或调整计划`);
  }
}

export function createAgentTeamWorkflow(api: APIConfig, scope: () => string) {
  const runtime: ReturnType<typeof createWorkflowRunRuntime> = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
    tracksModelInvocations: true,
    dispatchBlockReason(snapshot) {
      return teamConversationBlockReason(useChatStore.getState().chats.find((chat) => chat.id === snapshot.run.chatId), snapshot.run.goalSpec);
    },
    async execute(task: WorkflowTask, signal, context) {
      if (task.kind === 'team_plan') {
        if (typeof task.input !== 'string') throw new WorkflowPreflightError('团队目标无效');
        const snapshot = await runtime.read(task.runId);
        if (!snapshot) throw new WorkflowPreflightError('团队任务记录不存在');
        const chat = requireActiveAssistantChat(snapshot.run.chatId);
        const webSearch = Boolean(chat?.modeState && resolveChatAgentCapabilities(chat).webSearch);
        const capabilities = await teamMediaCapabilities();
        const plan = await planAgentTeam({ api, goal: task.input + workflowGoalContext(snapshot.run.goalSpec), chatId: snapshot.run.chatId, webSearch, ...capabilities, delegation: !snapshot.run.goalSpec || snapshot.run.goalSpec.allowedTools.includes('delegate_task'), signal, beforeModelRequest: context.beginModelInvocation });
        validateAvailableTeamTools(plan, capabilities, webSearch);
        assertGoalPlanAuthorized(snapshot, plan);
        return { output: plan };
      }
      if (task.kind === 'team_plan_revision') {
        if (!isTeamRevisionInput(task.input)) throw new WorkflowPreflightError('追加委派输入无效');
        const snapshot = await runtime.read(task.runId);
        if (!snapshot) throw new WorkflowPreflightError('团队任务记录不存在');
        const prior = task.input.sourceTaskIds.map((id) => {
          const source = snapshot.tasks.find((item) => item.id === id);
          if (!source || source.status !== 'completed' || typeof source.output !== 'string') throw new WorkflowPreflightError('已有交付尚未就绪');
          return { task: id, output: source.output.slice(0, 1500) };
        });
        const recentPrior = prior.slice(-8);
        const chat = requireActiveAssistantChat(snapshot.run.chatId);
        const webSearch = Boolean(chat?.modeState && resolveChatAgentCapabilities(chat).webSearch);
        const capabilities = await teamMediaCapabilities();
        const plan = await planAgentTeam({ api, goal: `总目标：${snapshot.run.goal}${workflowGoalContext(snapshot.run.goalSpec)}\n追加要求：${task.input.request}\n最近交付（共 ${prior.length} 项）：${JSON.stringify(recentPrior)}\n只规划新增且尚未完成的工作。`, chatId: snapshot.run.chatId, webSearch, ...capabilities, delegation: !snapshot.run.goalSpec || snapshot.run.goalSpec.allowedTools.includes('delegate_task'), signal, beforeModelRequest: context.beginModelInvocation });
        validateAvailableTeamTools(plan, capabilities, webSearch);
        assertGoalPlanAuthorized(snapshot, plan);
        return { output: plan };
      }
      if (task.kind === 'team_review') {
        const input = task.input as TeamReviewInput;
        const snapshot = await runtime.read(task.runId);
        if (!snapshot || !Array.isArray(input?.sourceTaskIds)) throw new WorkflowPreflightError('主 Agent 验收输入无效');
        requireActiveAssistantChat(snapshot.run.chatId);
        let finalAcceptance: string;
        try { finalAcceptance = validateAgentTeamPlan(snapshot.tasks.find((item) => item.id === 'plan')?.output).finalAcceptance; }
        catch (error) { throw new WorkflowPreflightError(error instanceof Error ? error.message : '团队验收标准无效'); }
        const { evidence, omitted } = selectReviewEvidence(snapshot, input.sourceTaskIds);
        finalAcceptance += workflowGoalContext(snapshot.run.goalSpec);
        await context.beginModelInvocation();
        const raw = await generateResponse(api, '你是主 Agent 的交付验收员。根据原目标、最终验收标准和真实完成记录判断是否已达到可用交付。只能基于现有工具能力提出最多一步必要补做，不得重复已完成工作。图片、音乐和视频生成任务的文字记录只证明附件已保存；只有明确的图片检查或视频抽帧检查任务才提供实际画面观察，抽帧检查仅覆盖报告列出的采样时刻，不证明音轨、逐帧连续性或全部镜头合格。不能把未检查的媒体当作已验证。缺失的剪辑、混音、代码执行等能力不得伪装为已完成。仅输出 JSON：{"complete":true,"reason":"..."} 或 {"complete":false,"reason":"...","nextRequest":"需要补做的具体工作"}。', [{ role: 'user', content: `原目标：${snapshot.run.goal}\n最终验收标准：${finalAcceptance}\n已完成任务摘要（另有 ${omitted} 项已完成记录未列出）：${JSON.stringify(evidence)}` }], undefined, {
          responseFormat: 'json', maxTokens: 600, signal,
          aiUsage: { type: 'assistant_chat', label: '团队交付验收', scope: 'chat', resourceId: snapshot.run.chatId },
        });
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch (error) { throw new WorkflowPreflightError(`主 Agent 验收返回了无效 JSON：${error instanceof Error ? error.message : '解析失败'}`); }
        return { output: parseTeamReview(parsed) };
      }
      if (!isAgentTaskKind(task.kind) || !isTeamTaskInput(task.input)) throw new WorkflowPreflightError('团队任务类型无效');
      const input = task.input;
      const role = input.role;
      const snapshot = await runtime.read(task.runId);
      if (!snapshot) throw new WorkflowPreflightError('团队任务记录不存在');
      requireActiveAssistantChat(snapshot.run.chatId);
      assertChatExecutionLease(snapshot.run.chatId);
      let plan: AgentTeamPlan;
      try {
        const source = snapshot.tasks.find((item) => item.id === (input.sourcePlanTaskId || 'plan'));
        plan = validateAgentTeamPlan(source?.expansion?.context ?? source?.output);
        if (source?.kind === 'agent_delegation') assertInheritedPlanAuthorized(snapshot, source, plan);
      } catch (error) {
        throw new WorkflowPreflightError(error instanceof Error ? error.message : '团队计划无效');
      }
      const plannedTask = plan.tasks.find((item) => item.id === (input.sourcePlanTaskId ? originalPlanTaskId(input.sourcePlanTaskId, task.id) : task.id));
      const plannedRole = plan.roles.find((item) => item.id === plannedTask?.roleId);
      if (!plannedTask || !plannedRole || !sameAgentTeamTask(input.task, plannedTask) || !sameAgentTeamRole(role, plannedRole) || input.goal !== snapshot.run.goal
        || (input.userInstruction !== undefined && (typeof input.userInstruction !== 'string' || !input.userInstruction.trim() || input.userInstruction.length > 4000))) {
        throw new WorkflowPreflightError('团队任务与已保存计划不一致');
      }
      const selectedTool = input.task.tool || 'text_generation';
      assertGoalPlanAuthorized(snapshot, plan);
      if (task.kind !== teamTaskKind(input.task)) throw new WorkflowPreflightError('团队任务工具与计划不一致');
      if (signal.aborted) throw new WorkflowPreflightError('团队任务已中断');
      if (selectedTool === 'delegate_task') {
        const ancestors = delegationAncestors(snapshot, task);
        if (ancestors.length >= 3) throw new WorkflowPreflightError('已达到最多3层委派，请直接执行具体工作');
        if (ancestors.some((ancestor) => isTeamTaskInput(ancestor.input)
          && ancestor.input.task.goal.normalize('NFKC').replace(/\s+/g, ' ').trim() === input.task.goal.normalize('NFKC').replace(/\s+/g, ' ').trim())) throw new WorkflowPreflightError('下级委派重复祖先目标，已阻止循环拆分');
        if (task.expansion) {
          if (input.task.mediaOutput) {
            const sourceId = resolveTeamDelegationMedia(snapshot, task, input.task.mediaOutput);
            const ready = input.task.mediaOutput === 'image' ? teamImageReference(task.runId, sourceId)
              : teamMediaAttachment(task.runId, sourceId);
            if (!ready) throw new WorkflowPreflightError('下级交付的媒体文件尚未保存在当前聊天，请先恢复文件');
          }
          const evidence = selectReviewEvidence(snapshot, task.expansion.taskIds).evidence;
          await context.beginModelInvocation();
          const output = await generateResponse(api, `你负责汇总下级 Agent 的真实交付。按父任务验收给出可用结果；不得声称未执行的工作已完成，明确列出缺口。${workflowGoalContext(snapshot.run.goalSpec)}`,
            [{ role: 'user', content: `总目标：${snapshot.run.goal}\n父任务：${input.task.goal}\n用户补充指示：${input.userInstruction || '无'}\n验收：${input.task.acceptance}\n下级交付：${JSON.stringify(evidence)}` }], undefined,
            { responseFormat: 'text', signal, aiUsage: { type: 'assistant_chat', label: '下级任务汇总', scope: 'chat', resourceId: snapshot.run.chatId } });
          if (!output.trim()) throw new WorkflowPreflightError('下级任务汇总返回空内容');
          return { output };
        }
        const chat = requireActiveAssistantChat(snapshot.run.chatId);
        const capabilities = await teamMediaCapabilities();
        const can = (tool: AgentTeamPlan['roles'][number]['allowedTools'][number]) => role.allowedTools.includes(tool);
        const contextTaskIds = task.dependsOn.filter((id) => {
          const source = snapshot.tasks.find((item) => item.id === id);
          return source?.status === 'completed' && typeof source.output === 'string';
        });
        const prior = selectReviewEvidence(snapshot, contextTaskIds).evidence.slice(-8)
          .map((entry) => ({ ...entry, output: entry.output.slice(0, 600) }));
        const delegated = await planAgentTeam({ api, goal: `总目标：${snapshot.run.goal}${workflowGoalContext(snapshot.run.goalSpec)}\n只拆分当前子目标：${input.task.goal}\n用户补充指示：${input.userInstruction || '无'}\n验收：${input.task.acceptance}\n${input.task.mediaOutput ? `必须交付一份 ${input.task.mediaOutput} 媒体，计划根字段 resultTaskId 必须指定对应的最终媒体任务。` : ''}\n本岗位可用工具：${role.allowedTools.join('、')}\n已有交付：${JSON.stringify(prior)}`,
          chatId: snapshot.run.chatId, ...capabilities,
          webSearch: can('web_search') && Boolean(chat.modeState && resolveChatAgentCapabilities(chat).webSearch),
          imageGeneration: can('image_generation') && capabilities.imageGeneration,
          audioGeneration: can('audio_generation') && capabilities.audioGeneration,
          speechGeneration: can('speech_generation') && capabilities.speechGeneration,
          videoGeneration: can('video_generation') && capabilities.videoGeneration,
          imageInspection: can('image_inspection') && capabilities.imageInspection,
          videoInspection: can('video_inspection') && capabilities.videoInspection,
          mediaComposition: can('media_composition') && capabilities.mediaComposition,
          delegation: ancestors.length < 2, signal, beforeModelRequest: context.beginModelInvocation });
        assertInheritedPlanAuthorized(snapshot, task, delegated);
        if (input.task.mediaOutput) assertTeamMediaOutput(delegated, input.task.mediaOutput);
        validateAvailableTeamTools(delegated, capabilities, Boolean(chat.modeState && resolveChatAgentCapabilities(chat).webSearch));
        const delegatedRoles = new Map(delegated.roles.map((item) => [item.id, item]));
        return { spawn: { context: delegated, tasks: delegated.tasks.map((child): WorkflowTask => ({
          id: delegatedTaskId(task.id, child.id), runId: task.runId, kind: teamTaskKind(child),
          input: { task: child, goal: snapshot.run.goal, role: delegatedRoles.get(child.roleId)!, sourcePlanTaskId: task.id, contextTaskIds } satisfies TeamTaskInput,
          dependsOn: [...new Set([...contextTaskIds, ...child.dependsOn.map((id) => delegatedTaskId(task.id, id))])],
          status: 'waiting_dependency', attempt: 0, updatedAt: Date.now(),
        })) } };
      }
      if (selectedTool === 'media_composition') {
        if (!input.task.composition) throw new WorkflowPreflightError('缺少音视频合成配置');
        const clips = new Set(input.task.composition.clips.map((clip) => clip.taskId));
        return composeAgentTeamMedia({ runId: task.runId, taskId: task.id, chatId: snapshot.run.chatId,
          sourceBranch: snapshot.run.goalSpec?.sourceBranch,
          plan: input.task.composition, resolveTaskId: (id) => resolveTeamMediaTask(snapshot,
            input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, id) : id, clips.has(id) ? 'video' : 'audio'), signal });
      }
      if (selectedTool === 'image_generation') {
        const imageTaskIds = directImageDependencies(input.task, new Map(plan.tasks.map((item) => [item.id, item])));
        const imageProfile = getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'image');
        const imageCapabilities = normalizeImageCapabilities(imageProfile?.imageCapabilities);
        if (imageTaskIds.length && (!imageProfile || !imageCapabilities.referenceImage)) throw new WorkflowPreflightError('当前图片模型不支持参考图片');
        if (imageTaskIds.length > 1 && !imageCapabilities.multiReferenceImage) throw new WorkflowPreflightError('当前图片模型只支持一张参考图片');
        const referenceImages = imageTaskIds.map((id) => {
          const dependencyId = input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, id) : id;
          const reference = teamImageReference(task.runId, resolveTeamMediaTask(snapshot, dependencyId, 'image'));
          if (!reference) throw new WorkflowPreflightError('图片任务的参考图片文件尚未就绪');
          return reference;
        });
        const upstream = input.task.dependsOn.filter((id) => !imageTaskIds.includes(id)).map((id) => {
          const dependency = snapshot.tasks.find((item) => item.id === (input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, id) : id));
          if (!dependency || dependency.status !== 'completed' || typeof dependency.output !== 'string') throw new WorkflowPreflightError('图片的上游脚本尚未就绪');
          return dependency.output.slice(0, 12_000);
        });
        return queueAgentTeamImage({ runId: task.runId, taskId: task.id, chatId: snapshot.run.chatId,
          sourceBranch: snapshot.run.goalSpec?.sourceBranch,
          prompt: [input.task.goal, workflowGoalContext(snapshot.run.goalSpec), ...upstream, input.userInstruction].filter(Boolean).join('\n\n'), referenceImages, signal });
      }
      if (selectedTool === 'image_inspection') {
        const profile = getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'text');
        const capabilities = resolveAIModelInputCapabilities(profile);
        if (!profile || !capabilities.imageInput) throw new WorkflowPreflightError('当前文字模型不支持图片检查');
        const imageTaskIds = directImageDependencies(input.task, new Map(plan.tasks.map((item) => [item.id, item])))
          .map((id) => resolveTeamMediaTask(snapshot, input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, id) : id, 'image'));
        if (!imageTaskIds.length || imageTaskIds.length > capabilities.maxAttachments) throw new WorkflowPreflightError('图片检查的参考图片数量不符合当前模型限制');
        const references = imageTaskIds.map((id) => teamImageReference(task.runId, id));
        if (references.some((reference) => !reference)) throw new WorkflowPreflightError('图片检查的参考图片尚未就绪');
        const output = await inspectAgentTeamImages({
          api: { provider: profile.provider, apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model, maxOutputTokens: profile.maxOutputTokens },
          goal: [input.task.goal, workflowGoalContext(snapshot.run.goalSpec), input.userInstruction].filter(Boolean).join('\n'), acceptance: input.task.acceptance,
          chatId: snapshot.run.chatId,
          references: references.filter((reference): reference is NonNullable<typeof reference> => Boolean(reference)), signal,
          beforeModelRequest: context.beginModelInvocation,
        });
        return { output };
      }
      if (selectedTool === 'video_inspection') {
        const profile = getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'text');
        const capabilities = resolveAIModelInputCapabilities(profile);
        if (!profile || !capabilities.imageInput || capabilities.maxAttachments < 1) throw new WorkflowPreflightError('当前文字模型不支持视频抽帧检查');
        const videoTaskIds = input.task.dependsOn.filter((id) => teamTaskMediaKind(plan.tasks.find((source) => source.id === id)) === 'video')
          .map((id) => resolveTeamMediaTask(snapshot, input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, id) : id, 'video'));
        if (videoTaskIds.length !== 1) throw new WorkflowPreflightError('视频检查需要唯一的成片文件');
        const attachment = teamMediaAttachment(task.runId, videoTaskIds[0]);
        if (!attachment?.url || attachment.kind !== 'video') throw new WorkflowPreflightError('待检查视频尚未保存在当前聊天，请先恢复视频文件');
        return { output: await inspectAgentTeamVideo({
          api: { provider: profile.provider, apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model, maxOutputTokens: profile.maxOutputTokens },
          chatId: snapshot.run.chatId, goal: [input.task.goal, workflowGoalContext(snapshot.run.goalSpec), input.userInstruction].filter(Boolean).join('\n'), acceptance: input.task.acceptance,
          url: attachment.url, maxFrames: Math.min(6, capabilities.maxAttachments), signal,
          beforeModelRequest: context.beginModelInvocation,
        }) };
      }
      if (selectedTool === 'speech_generation') {
        const speech = input.task.speech;
        if (!speech) throw new WorkflowPreflightError('配音正文配置缺失');
        let text = speech.text;
        if (speech.textTaskId) {
          const sourceId = input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, speech.textTaskId) : speech.textTaskId;
          const source = snapshot.tasks.find((item) => item.id === sourceId);
          if (!source || source.kind !== 'agent_text' || source.status !== 'completed' || typeof source.output !== 'string') throw new WorkflowPreflightError('旁白正文尚未就绪');
          text = source.output;
        }
        if (!text?.trim() || text.length > 12_000) throw new WorkflowPreflightError('旁白正文必须为 1 到 12000 个字符');
        if (input.userInstruction) throw new WorkflowPreflightError('配音正文已确定，请通过追加任务修订正文后重新配音');
        return queueAgentTeamAudio({ runId: task.runId, taskId: task.id, chatId: snapshot.run.chatId,
          sourceBranch: snapshot.run.goalSpec?.sourceBranch,
          prompt: text.trim(), purpose: 'speech', signal });
      }
      if (selectedTool === 'audio_generation') {
        const upstream = input.task.dependsOn.map((id) => {
          const dependencyId = input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, id) : id;
          const dependency = snapshot.tasks.find((item) => item.id === dependencyId);
          if (!dependency || dependency.status !== 'completed' || typeof dependency.output !== 'string') throw new WorkflowPreflightError('音乐的上游歌词或说明尚未就绪');
          if (dependency.kind !== 'agent_text' && dependency.kind !== 'agent_web_search') throw new WorkflowPreflightError('音乐任务目前只能读取文字歌词或说明');
          return dependency.output.slice(0, 12_000);
        });
        return queueAgentTeamAudio({ runId: task.runId, taskId: task.id, chatId: snapshot.run.chatId,
          sourceBranch: snapshot.run.goalSpec?.sourceBranch,
          prompt: [input.task.goal, workflowGoalContext(snapshot.run.goalSpec), ...upstream, input.userInstruction].filter(Boolean).join('\n\n'), signal });
      }
      if (selectedTool === 'video_generation') {
        const existingVideo = inspectAgentTeamVideoAttachment(task.runId, task.id);
        const upstreamTaskIds = new Set<string>();
        const collectUpstream = (id: string) => {
          const dependencyId = input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, id) : id;
          if (upstreamTaskIds.has(dependencyId)) return;
          const dependency = snapshot.tasks.find((item) => item.id === dependencyId);
          if (!dependency) throw new WorkflowPreflightError('视频的上游素材尚未就绪');
          upstreamTaskIds.add(dependencyId);
          const dependencyInput = isTeamTaskInput(dependency.input) ? dependency.input : null;
          if (dependency.kind !== 'agent_delegation') dependencyInput?.task.dependsOn.forEach(collectUpstream);
        };
        input.task.dependsOn.forEach(collectUpstream);
        const imageTaskIds = [...new Set([...upstreamTaskIds].filter((id) => {
          const source = snapshot.tasks.find((item) => item.id === id);
          return source && isTeamTaskInput(source.input) && teamTaskMediaKind(source.input.task) === 'image';
        }).map((id) => resolveTeamMediaTask(snapshot, id, 'image')))];
        const hasImageDependency = imageTaskIds.length > 0;
        if (!existingVideo || existingVideo.status === 'queued') {
          const capabilities = await teamMediaCapabilities();
          if (!capabilities.videoGeneration) throw new WorkflowPreflightError(capabilities.videoUnavailableReason || '当前视频模型不可用');
          if (hasImageDependency && !capabilities.videoReferenceImages) throw new WorkflowPreflightError('当前视频模型不支持参考图片，请切换支持参考图的视频模型后继续');
          if (!hasImageDependency && capabilities.videoRequiresReferenceImage) throw new WorkflowPreflightError('当前视频模型必须提供参考图片，请先生成图片素材或更换模型');
          if (capabilities.maxVideoReferenceImages !== undefined && imageTaskIds.length > capabilities.maxVideoReferenceImages) {
            throw new WorkflowPreflightError(`当前视频模型最多支持 ${capabilities.maxVideoReferenceImages} 张参考图片，请减少素材或更换模型`);
          }
        }
        const referenceImages = imageTaskIds.flatMap((dependencyId) => {
          const reference = teamImageReference(task.runId, dependencyId);
          if (!reference) throw new WorkflowPreflightError('参考图片文件尚未就绪');
          return [reference];
        });
        const upstream = [...upstreamTaskIds].map((dependencyId) => {
          const dependency = snapshot.tasks.find((item) => item.id === dependencyId);
          if (!dependency || dependency.status !== 'completed' || typeof dependency.output !== 'string') throw new WorkflowPreflightError('视频的上游素材尚未就绪');
          return dependency.kind === 'agent_text' || dependency.kind === 'agent_web_search' || dependency.kind === 'agent_image_inspection' || dependency.kind === 'agent_delegation'
            ? dependency.output.slice(0, 12_000) : null;
        }).filter((content): content is string => content !== null);
        return queueAgentTeamVideo({ runId: task.runId, taskId: task.id, chatId: snapshot.run.chatId,
          sourceBranch: snapshot.run.goalSpec?.sourceBranch,
          prompt: [input.task.goal, workflowGoalContext(snapshot.run.goalSpec), ...upstream, input.userInstruction].filter(Boolean).join('\n\n'), referenceImages, signal });
      }
      if (selectedTool === 'web_search') {
        const chat = useChatStore.getState().chats.find((item) => item.id === snapshot.run.chatId && item.type === 'assistant' && item.deletedAt == null);
        if (!chat?.modeState || !resolveChatAgentCapabilities(chat).webSearch) throw new WorkflowPreflightError('当前会话未开启网页搜索');
        const response = await appApi.searchWeb(input.task.goal, { source: 'assistant_agent', resourceId: snapshot.run.chatId, count: 8 });
        if (signal.aborted) throw signal.reason || new Error('团队任务已中断');
        const results = response.results.slice(0, 8).filter((result) => result.title.trim() && /^https?:\/\//i.test(result.url));
        if (!results.length) throw new WorkflowPreflightError('网页搜索没有返回可用结果');
        return { output: [
          `搜索词：${response.query}`,
          ...results.map((result, index) => `${index + 1}. ${result.title}\n来源：${result.url}\n摘要：${(result.summary || result.snippet).trim()}`),
          '以上是搜索结果摘要，具体事实仍需核对原始来源。',
        ].join('\n\n') };
      }
      const directIds = input.task.dependsOn.map((id) => input.sourcePlanTaskId ? delegatedTaskId(input.sourcePlanTaskId, id) : id);
      const contextIds = (input.contextTaskIds || []).filter((id) => !directIds.includes(id)).slice(-8);
      const upstream = [...directIds, ...contextIds].map((id) => {
        const dependency = snapshot.tasks.find((item) => item.id === id);
        if (!dependency || dependency.status !== 'completed' || typeof dependency.output !== 'string') throw new WorkflowPreflightError('上游交付尚未就绪');
        return { taskId: id, content: dependency.output.slice(0, directIds.includes(id) ? 12_000 : 1_500) };
      });
      await context.beginModelInvocation();
      const output = await generateResponse(api, [
        `岗位：${role.name}`,
        `职责：${role.responsibility}`,
        `方法：${role.method}`,
        `岗位验收：${role.acceptance}`,
        `本任务验收：${input.task.acceptance}`,
        workflowGoalContext(snapshot.run.goalSpec),
        '只根据提供的目标与上游交付工作；不声称调用了未提供的工具。缺少事实依据时标明不确定性。',
      ].join('\n'), [{ role: 'user', content: `总目标：${input.goal}\n当前任务：${input.task.goal}\n${input.userInstruction ? `用户补充指示：${input.userInstruction}\n` : ''}上游交付：${JSON.stringify(upstream)}` }], undefined, {
        responseFormat: 'text', signal,
        aiUsage: { type: 'assistant_chat', label: '团队文本任务', scope: 'chat', resourceId: snapshot.run.chatId },
      });
      if (!output.trim()) throw new WorkflowPreflightError('子 Agent 未提交内容');
      return { output: output.trim() };
    },
    async inspectExternal(task) {
      if (task.kind === 'agent_image') {
        const result = inspectAgentTeamImageAttachment(task.runId, task.id);
        if (result?.status === 'completed' || result?.status === 'failed') return result;
        return { status: 'pending' as const };
      }
      if (task.kind === 'agent_audio') {
        const result = inspectAgentTeamAudioAttachment(task.runId, task.id);
        if (result?.status === 'completed' || result?.status === 'failed') return result;
        return { status: 'pending' as const };
      }
      if (task.kind !== 'agent_video') throw new WorkflowPreflightError('外部任务类型无效');
      const result = inspectAgentTeamVideoAttachment(task.runId, task.id);
      if (result?.status === 'completed') return result;
      if (result?.status === 'failed') return result;
      return { status: 'pending' as const };
    },
    async reconcileInterrupted(task) {
      if (task.kind === 'agent_media_composition') return inspectAgentTeamComposition(task.runId, task.id) || { status: 'queued' as const };
      if (task.kind === 'agent_image') return inspectAgentTeamImageAttachment(task.runId, task.id);
      if (task.kind === 'agent_audio') return inspectAgentTeamAudioAttachment(task.runId, task.id);
      if (task.kind !== 'agent_video') return null;
      return inspectAgentTeamVideoAttachment(task.runId, task.id);
    },
  }, scope);

  return {
    read: runtime.read,
    list: runtime.list,
    requestPauseAfterCurrentBatch: runtime.requestPauseAfterCurrentBatch,
    async setModelCallLimit(runId: string, expectedPlanVersion: number, maxModelCalls?: number) {
      if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务修改');
      const storageScope = scope();
      return navigator.locks.request(workflowRunLockName(storageScope, runId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('团队任务正在执行，请暂停后重试');
        if (scope() !== storageScope) throw new Error('账号已切换，任务修改已停止');
        const current = await runtime.read(runId);
        if (!current || current.tasks[0]?.kind !== 'team_plan') throw new Error('团队任务不存在');
        return runtime.setModelCallLimit(runId, expectedPlanVersion, maxModelCalls);
      });
    },
    async addRevisionRequest(runId: string, expectedPlanVersion: number, request: string) {
      const trimmed = request.trim();
      if (!trimmed || trimmed.length > 4000) throw new Error('追加要求应为 1 到 4000 个字符');
      if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务修改');
      const storageScope = scope();
      return navigator.locks.request(workflowRunLockName(storageScope, runId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('团队任务正在执行，请暂停后重试');
        if (scope() !== storageScope) throw new Error('账号已切换，任务修改已停止');
        const current = await runtime.read(runId);
        if (!current || current.tasks[0]?.kind !== 'team_plan') throw new Error('团队任务不存在');
        if (current.run.status !== 'paused' && current.run.status !== 'completed') throw new Error('请先暂停整个团队任务');
        if (current.run.planVersion !== expectedPlanVersion) throw new Error('团队计划已更新，请刷新后重试');
        const hasReviewBlock = current.tasks.some((task) => task.id === 'review_needs_user' && task.status === 'waiting_user');
        if (current.tasks.some((task) => task.status === 'running' || task.status === 'result_unknown' || task.status === 'failed')) throw new Error('请先处理未完成或待核对的步骤');
        if (current.tasks.some((task) => task.kind === 'team_plan_revision' && task.status !== 'completed')) throw new Error('请先完成已追加的团队任务');
        const sourceTaskIds = current.tasks.filter((task) => isAgentTaskKind(task.kind)).map((task) => task.id);
        if (!sourceTaskIds.length) throw new Error('团队规划尚未完成');
        const revisionCount = current.tasks.filter((task) => task.kind === 'team_plan_revision').length;
        const task: WorkflowTask = {
          id: revisionCount === 0 ? 'delegate' : `delegate_${revisionCount + 1}`, runId, kind: 'team_plan_revision',
          input: { request: trimmed, sourceTaskIds } satisfies TeamRevisionInput,
          dependsOn: sourceTaskIds, status: 'waiting_dependency', attempt: 0, updatedAt: Date.now(),
        };
        return hasReviewBlock
          ? runtime.replaceUserBlockWithTasks(runId, expectedPlanVersion, [task])
          : runtime.addTeamRevision(runId, expectedPlanVersion, task);
      });
    },
    async instructQueuedTask(runId: string, taskId: string, expectedPlanVersion: number, instruction: string) {
      const trimmed = instruction.trim();
      if (!trimmed || trimmed.length > 4000) throw new Error('补充指示应为 1 到 4000 个字符');
      if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务修改');
      const storageScope = scope();
      const snapshot = await navigator.locks.request(workflowRunLockName(storageScope, runId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('团队任务正在执行，请暂停后重试');
        if (scope() !== storageScope) throw new Error('账号已切换，任务修改已停止');
        return indexedDbWorkflowRepository.transact(storageScope, runId, (current) => {
          if (!current || current.tasks[0]?.kind !== 'team_plan') throw new Error('团队任务不存在');
          if (current.run.status !== 'paused') throw new Error('请先暂停整个团队任务');
          if (current.run.planVersion !== expectedPlanVersion) throw new Error('团队计划已更新，请刷新后重试');
          const target = current.tasks.find((task) => task.id === taskId);
          if (!target || !isAgentTaskKind(target.kind) || !isTeamTaskInput(target.input) || target.attempt !== 0
            || (target.status !== 'queued' && target.status !== 'waiting_dependency')) throw new Error('只能修改尚未执行的子任务');
          if (target.input.task.tool === 'speech_generation') throw new WorkflowPreflightError('配音正文已确定，请通过追加任务修订正文后重新配音');
          const next: WorkflowSnapshot = {
            ...current,
            run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: Date.now() },
            tasks: current.tasks.map((task) => task.id === taskId ? {
              ...task,
              input: { ...(target.input as TeamTaskInput), userInstruction: trimmed },
              updatedAt: Date.now(),
            } : task),
          };
          return { snapshot: next, value: next };
        });
      });
      return snapshot;
    },
    async abandonUnknownReview(runId: string, reviewId: string, expectedPlanVersion: number) {
      if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务修改');
      const storageScope = scope();
      return navigator.locks.request(workflowRunLockName(storageScope, runId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('团队任务正在执行，请暂停后重试');
        if (scope() !== storageScope) throw new Error('账号已切换，任务修改已停止');
        const current = await runtime.read(runId);
        if (!current || current.tasks[0]?.kind !== 'team_plan') throw new Error('团队任务不存在');
        return runtime.abandonUnknownReview(runId, expectedPlanVersion, reviewId);
      });
    },
    async retryFailedReview(runId: string, reviewId: string, expectedPlanVersion: number) {
      if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务修改');
      const storageScope = scope();
      return navigator.locks.request(workflowRunLockName(storageScope, runId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('团队任务正在执行，请稍后重试');
        if (scope() !== storageScope) throw new Error('账号已切换，任务修改已停止');
        const current = await runtime.read(runId);
        if (!current || current.tasks[0]?.kind !== 'team_plan') throw new Error('团队任务不存在');
        return runtime.retryFailedReview(runId, expectedPlanVersion, reviewId);
      });
    },
    async retryFailedPlan(runId: string, taskId: string, expectedPlanVersion: number) {
      if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务修改');
      const storageScope = scope();
      return navigator.locks.request(workflowRunLockName(storageScope, runId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('团队任务正在执行，请稍后重试');
        if (scope() !== storageScope) throw new Error('账号已切换，任务修改已停止');
        const current = await runtime.read(runId);
        if (!current || current.tasks[0]?.kind !== 'team_plan') throw new Error('团队任务不存在');
        return runtime.retryFailedTeamPlan(runId, expectedPlanVersion, taskId);
      });
    },
    async start(runId: string, chatId: string, goal: string, autoReview = false, signal = getWorkspaceSignal(), maxModelCalls?: number, goalSpec?: WorkflowGoalSpec) {
      if (maxModelCalls !== undefined && (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 1000)) {
        throw new WorkflowPreflightError('模型调用次数上限必须是 1 到 1000 的整数');
      }
      const now = Date.now();
      const contract = goalSpec ? parseWorkflowGoalSpec(goalSpec) : defaultWorkflowGoalSpec(goal);
      if (contract.objective !== goal) throw new WorkflowPreflightError('目标契约与运行目标不一致');
      const chat = requireActiveAssistantChat(chatId);
      const branchError = teamConversationBlockReason(chat, contract);
      if (branchError) throw new WorkflowPreflightError(branchError);
      contract.sourceBranch ??= captureTeamSourceBranch(chat);
      const initial: WorkflowSnapshot = {
        run: { id: runId, chatId, goal, goalSpec: contract, status: 'active', generation: 0, planVersion: 1, planOpen: true, autoReview, maxModelCalls, updatedAt: now },
        tasks: [{ id: 'plan', runId, kind: 'team_plan', input: goal, dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }],
      };
      if (!await runtime.read(runId)) await runtime.create(initial);
      return this.resume(runId, signal);
    },
    async resume(runId: string, signal = getWorkspaceSignal()) {
      const beforeResume = await runtime.read(runId);
      if (beforeResume?.tasks.some((task) => task.id === 'review_needs_user' && task.status === 'waiting_user')) {
        return { snapshot: beforeResume, summary: summarizeWorkflowRun(beforeResume) };
      }
      if (beforeResume?.tasks.some((task) => task.kind === 'agent_media_composition' && (task.status === 'failed' || task.status === 'result_unknown'))) {
        const storageScope = scope();
        if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务执行');
        await navigator.locks.request(workflowRunLockName(storageScope, runId), { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error('团队任务正在执行，请暂停后重试');
          if (scope() !== storageScope) throw new Error('账号已切换，任务恢复已停止');
          await indexedDbWorkflowRepository.transact(storageScope, runId, (current) => {
            if (!current) throw new Error('团队任务记录不存在');
            if (current.run.status === 'completed' || current.run.status === 'cancelled') return { snapshot: current, value: undefined };
            return { snapshot: { ...current, tasks: current.tasks.map((task) => {
              if (task.kind !== 'agent_media_composition' || (task.status !== 'failed' && task.status !== 'result_unknown')) return task;
              const result = inspectAgentTeamComposition(runId, task.id);
              return { ...task, status: result ? 'completed' as const : 'queued' as const, output: result?.output, error: undefined, updatedAt: Date.now() };
            }) }, value: undefined };
          });
        });
      }
      if (beforeResume && beforeResume.tasks.some((task) => (task.status === 'failed' || task.status === 'result_unknown')
        && (task.kind === 'agent_video' ? inspectAgentTeamVideoAttachment(runId, task.id)?.status : task.kind === 'agent_image' ? inspectAgentTeamImageAttachment(runId, task.id)?.status : task.kind === 'agent_audio' ? inspectAgentTeamAudioAttachment(runId, task.id)?.status : null) === 'completed')) {
        await indexedDbWorkflowRepository.transact(scope(), runId, (current) => {
          if (!current) throw new Error('团队任务记录不存在');
          const tasks = current.tasks.map((task) => {
            if ((task.kind !== 'agent_video' && task.kind !== 'agent_image' && task.kind !== 'agent_audio') || (task.status !== 'failed' && task.status !== 'result_unknown')) return task;
            const result = task.kind === 'agent_video' ? inspectAgentTeamVideoAttachment(runId, task.id) : task.kind === 'agent_image' ? inspectAgentTeamImageAttachment(runId, task.id) : inspectAgentTeamAudioAttachment(runId, task.id);
            return result?.status === 'completed' ? { ...task, status: 'completed' as const, output: result.output, error: undefined, updatedAt: Date.now() } : task;
          });
          return { snapshot: { ...current, tasks, run: { ...current.run, status: tasks.some((task) => task.status === 'failed') ? 'failed' : 'paused', updatedAt: Date.now() } }, value: undefined };
        });
      }
      let snapshot = await runtime.resume(runId, signal);
      const planner = snapshot.tasks.find((task) => task.id === 'plan');
      if (planner?.status !== 'completed') return { snapshot, summary: summarizeWorkflowRun(snapshot) };
      const plan = validateAgentTeamPlan(planner.output);
      const roles = new Map(plan.roles.map((role) => [role.id, role]));
      const additions = plan.tasks.map((task): WorkflowTask => ({
        id: task.id,
        runId,
        kind: teamTaskKind(task),
        input: { task, goal: snapshot.run.goal, role: roles.get(task.roleId)! } satisfies TeamTaskInput,
        dependsOn: ['plan', ...task.dependsOn],
        status: task.dependsOn.length ? 'waiting_dependency' : 'queued',
        attempt: 0,
        updatedAt: Date.now(),
      }));
      snapshot = await runtime.expandPlanOnce(runId, snapshot.run.planVersion, 'plan', additions);
      if (snapshot.run.status === 'active') snapshot = await runtime.resume(runId, signal);
      for (const revisionTask of snapshot.tasks.filter((task) => task.kind === 'team_plan_revision' && task.status === 'completed')) {
        if (revisionTask.id.startsWith('auto_delegate_') && snapshot.run.autoReview === false) continue;
        const delegated = validateAgentTeamPlan(revisionTask.output);
        const delegatedRoles = new Map(delegated.roles.map((role) => [role.id, role]));
        const contextTaskIds = isTeamRevisionInput(revisionTask.input) ? revisionTask.input.sourceTaskIds : [];
        const delegatedTasks = delegated.tasks.map((task): WorkflowTask => ({
          id: delegatedTaskId(revisionTask.id, task.id), runId, kind: teamTaskKind(task),
          input: { task, goal: snapshot.run.goal, role: delegatedRoles.get(task.roleId)!, sourcePlanTaskId: revisionTask.id, contextTaskIds } satisfies TeamTaskInput,
          dependsOn: [revisionTask.id, ...contextTaskIds, ...task.dependsOn.map((id) => delegatedTaskId(revisionTask.id, id))],
          status: 'waiting_dependency', attempt: 0, updatedAt: Date.now(),
        }));
        snapshot = await runtime.expandPlanOnce(runId, snapshot.run.planVersion, revisionTask.id, delegatedTasks);
        if (snapshot.run.status === 'active') snapshot = await runtime.resume(runId, signal);
      }
      if (snapshot.run.autoReview && snapshot.run.status === 'active') {
        const maxReviewRounds = snapshot.run.goalSpec?.execution.maxAutomaticReviewRounds ?? 3;
        for (let round = 1; round <= maxReviewRounds; round += 1) {
          if (!snapshot.tasks.every((task) => task.status === 'completed' || task.status === 'abandoned')) break;
          const reviewId = `review_${round}`;
          const review = snapshot.tasks.find((task) => task.id === reviewId);
          if (!review) {
            const sourceTaskIds = snapshot.tasks.filter((task) => isAgentTaskKind(task.kind)).map((task) => task.id);
            if (!sourceTaskIds.length) break;
            snapshot = await runtime.addTasksOnce(runId, snapshot.run.planVersion, [{
              id: reviewId, runId, kind: 'team_review', input: { sourceTaskIds } satisfies TeamReviewInput,
              dependsOn: sourceTaskIds, status: 'queued', attempt: 0, updatedAt: Date.now(),
            }]);
            snapshot = await runtime.resume(runId, signal);
          }
          const completedReview = snapshot.tasks.find((task) => task.id === reviewId);
          if (completedReview?.status !== 'completed') break;
          const verdict = parseTeamReview(completedReview.output);
          if (verdict.complete) break;
          if (hasRepeatedTeamReviewWithoutProgress(snapshot, reviewId)) {
            snapshot = await runtime.blockForUser(runId, snapshot.run.planVersion, reviewBlockTask(runId, reviewId, '自动返工没有产生新的文本交付，验收再次提出相同要求。已暂停以避免重复执行，请补充约束、调整模型或指定下一步。'));
            break;
          }
          if (round === maxReviewRounds) {
            snapshot = await runtime.blockForUser(runId, snapshot.run.planVersion, reviewBlockTask(runId, reviewId, `自动验收仍未通过：${verdict.reason}。请检查目标或追加指示。`));
            break;
          }
          const revisionId = `auto_delegate_${round}`;
          if (!snapshot.tasks.some((task) => task.id === revisionId)) {
            const sourceTaskIds = snapshot.tasks.filter((task) => isAgentTaskKind(task.kind)).map((task) => task.id);
            snapshot = await runtime.addTasksOnce(runId, snapshot.run.planVersion, [{
              id: revisionId, runId, kind: 'team_plan_revision',
              input: { request: verdict.nextRequest!, sourceTaskIds } satisfies TeamRevisionInput,
              dependsOn: [reviewId, ...sourceTaskIds], status: 'queued', attempt: 0, updatedAt: Date.now(),
            }]);
            snapshot = await runtime.resume(runId, signal);
          }
          const revision = snapshot.tasks.find((task) => task.id === revisionId);
          if (revision?.status !== 'completed') break;
          const delegated = validateAgentTeamPlan(revision.output);
          const roles = new Map(delegated.roles.map((role) => [role.id, role]));
          const contextTaskIds = isTeamRevisionInput(revision.input) ? revision.input.sourceTaskIds : [];
          snapshot = await runtime.expandPlanOnce(runId, snapshot.run.planVersion, revisionId, delegated.tasks.map((task): WorkflowTask => ({
            id: delegatedTaskId(revisionId, task.id), runId,
            kind: teamTaskKind(task),
            input: { task, goal: snapshot.run.goal, role: roles.get(task.roleId)!, sourcePlanTaskId: revisionId, contextTaskIds } satisfies TeamTaskInput,
            dependsOn: [revisionId, ...contextTaskIds, ...task.dependsOn.map((id) => delegatedTaskId(revisionId, id))],
            status: 'waiting_dependency', attempt: 0, updatedAt: Date.now(),
          })));
          if (snapshot.run.status === 'active') snapshot = await runtime.resume(runId, signal);
        }
      }
      if (snapshot.run.status === 'active' && snapshot.tasks.every((task) => task.status === 'completed' || task.status === 'abandoned')) snapshot = await runtime.closePlan(runId, snapshot.run.planVersion);
      return { snapshot, summary: summarizeWorkflowRun(snapshot) };
    },
    async publish(runId: string) {
      if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队交付');
      const deliveryScope = scope();
      const initial = await runtime.read(runId);
      if (!initial || initial.run.status !== 'completed') throw new Error('团队任务尚未完成');
      const chatId = initial.run.chatId;
      const assertDeliveryOwnership = () => {
        if (scope() !== deliveryScope) throw new Error('账号已切换，团队交付已暂停');
        assertChatExecutionLease(chatId);
        const reason = teamConversationBlockReason(useChatStore.getState().chats.find((chat) => chat.id === chatId), initial.run.goalSpec);
        if (reason) throw new Error(reason);
      };
      const publishWithinRunLock = (signal?: AbortSignal) => navigator.locks.request(workflowRunLockName(deliveryScope, runId), async () => {
      if (signal?.aborted) throw signal.reason || new Error('团队交付已暂停');
      assertDeliveryOwnership();
      const snapshot = await runtime.read(runId);
      if (!snapshot || snapshot.run.status !== 'completed') throw new Error('团队任务尚未完成');
      if (snapshot.run.chatId !== chatId) throw new Error('团队交付会话已变化');
      await Promise.all([
        ensureAssistantArtifactStoreHydrated(),
        useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
        useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
      ]);
      if (signal?.aborted) throw signal.reason || new Error('团队交付已暂停');
      assertDeliveryOwnership();
      const chat = useChatStore.getState().chats.find((item) => item.id === snapshot.run.chatId && item.deletedAt == null);
      if (!chat || chat.type !== 'assistant') throw new Error('交付会话不可用');
      const sourceId = `team-delivery-${runId}`;
      const chatArtifacts = useAssistantArtifactStore.getState().getArtifactsForChat(chat.id);
      const plan = validateAgentTeamPlan(snapshot.tasks.find((task) => task.id === 'plan')?.output);
      const delegatedPlans = snapshot.tasks.filter((task) => (task.kind === 'team_plan_revision' || task.kind === 'agent_delegation') && task.status === 'completed'
        && snapshot.tasks.some((item) => item.id.startsWith(delegatedTaskId(task.id, '')))).map((task) => ({
        sourceId: task.id, plan: validateAgentTeamPlan(task.expansion?.context ?? task.output),
      }));
      const completed = [
        ...plan.tasks.map((task) => ({ task, id: task.id })),
        ...delegatedPlans.flatMap(({ sourceId: revisionId, plan: delegated }) => delegated.tasks.map((task) => ({ task, id: delegatedTaskId(revisionId, task.id) }))),
      ].map(({ task, id }) => {
        const output = snapshot.tasks.find((item) => item.id === id)?.output;
        if (typeof output !== 'string') throw new Error('团队交付缺少任务结果');
        return { task, id, output };
      });
      const declared = completed.filter((item) => item.task.deliverable);
      const untyped = completed.filter((item) => !item.task.deliverable);
      const artifacts: Array<AssistantArtifactItem | null> = [];
      const store = useAssistantArtifactStore.getState();
      const upsert = (artifactSourceId: string, kind: 'document' | 'code' | 'diagram' | 'html' | 'table' | 'json' | 'text', title: string, content: string, summary: string, language?: string) => {
        const existing = chatArtifacts.find((item) => item.sourceMessageId === artifactSourceId);
        const current = existing?.versions.find((item) => item.id === existing.currentVersionId);
        if (current?.content.trim() === content.trim()) return existing!;
        return store.upsertArtifactsFromMessage({ chatId: chat.id, messageId: artifactSourceId, drafts: [{
          kind, title, content, summary, language,
          ...(existing ? { action: 'update' as const, targetArtifactId: existing.id, baseVersionId: existing.currentVersionId } : {}),
        }] })[0] || null;
      };
      assertDeliveryOwnership();
      for (const { task, id, output } of declared) {
        const spec = task.deliverable!;
        artifacts.push(upsert(`${sourceId}:${id}`, spec.kind, spec.title, output, task.acceptance, spec.language));
      }
      const summaryContent = declared.length
        ? [`# ${plan.summary}`, ...untyped.map(({ task, output }) => `## ${task.goal}\n\n${output}`)].join('\n\n')
        : [`# ${plan.summary}`, ...completed.map(({ task, output }) => `## ${task.goal}\n\n${output}`)].join('\n\n');
      if (!declared.length || untyped.length) {
        artifacts.push(upsert(sourceId, 'document', plan.summary.slice(0, 60), summaryContent,
          delegatedPlans.at(-1)?.plan.finalAcceptance || plan.finalAcceptance));
      }
      const savedArtifacts = artifacts.filter((item): item is AssistantArtifactItem => Boolean(item));
      if (!savedArtifacts.length || savedArtifacts.length !== artifacts.length) throw new Error('团队交付产物保存失败');
      if (signal?.aborted) throw signal.reason || new Error('团队交付已暂停');
      assertDeliveryOwnership();
      const messageStore = useMessageStore.getState();
      const known = [...messageStore.messages, ...(messageStore.messageWindowsByChatId[chat.id]?.messages || [])];
      const previousDelivery = known.find((item) => item.id === sourceId || item.clientKey === sourceId);
      const artifactRefs = savedArtifacts.map((item) => ({ id: item.id, kind: item.kind, title: item.title, versionId: item.currentVersionId }));
      const refsChanged = JSON.stringify(previousDelivery?.metadata?.assistant?.artifacts || []) !== JSON.stringify(artifactRefs);
      if (!previousDelivery || refsChanged) {
        const draft = attachMessageToActiveBranch(teamConversationContext(chat, snapshot.run.goalSpec), known, {
          id: sourceId, clientKey: sourceId, chatId: chat.id, type: 'ai' as const,
          senderId: 'assistant', senderName: '助手', content: `${previousDelivery ? '团队任务已更新' : '团队任务已完成'}：${plan.summary}`,
          emotion: 0, timestamp: previousDelivery?.timestamp || Date.now(), isDeleted: false,
          metadata: { format: 'markdown' as const, assistant: { mode: 'general' as const, artifacts: artifactRefs } },
        }) as Message;
        useMessageStore.getState().upsertMessage(draft);
        useMessageStore.getState().queueMessageSync(draft);
        await advanceTeamConversation(draft, snapshot.run.goalSpec?.sourceBranch);
        void useChatStore.getState().updateChat(chat.id, { lastMessageAt: draft.timestamp, latestMessage: draft });
      }
      flushBufferedPersistenceWrites();
      if (signal?.aborted) throw signal.reason || new Error('团队交付已暂停');
      assertDeliveryOwnership();
      await runtime.markDeliveryPublished(runId, snapshot.run.planVersion);
      return savedArtifacts[0];
      });
      if (getChatExecutionFence(chatId)) {
        assertDeliveryOwnership();
        return publishWithinRunLock();
      }
      return runWithConversationExecutionLock(deliveryScope, chatId, async (signal) => {
        assertDeliveryOwnership();
        return publishWithinRunLock(signal);
      });
    },
  };
}

const teamListeners = new Set<() => void>();
let teamRevision = 0;
const notifyTeam = () => { teamRevision += 1; teamListeners.forEach((listener) => listener()); };
const activeTeamRuns = new Set<string>();
let mediaWakePending = false;
const mediaWakeKeys = new Set<string>();
const deferredMediaWakeRuns = new Set<string>();
function completedTeamMediaStatuses(state: ReturnType<typeof useMessageStore.getState>) {
  const latest = new Map<string, Message>();
  for (const message of [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]) {
    const team = message.metadata?.agentTeamMedia;
    if (!team) continue;
    const key = `${team.runId}:${team.taskId}`;
    const previous = latest.get(key);
    const updatedAt = Math.max(0, ...(message.metadata?.attachments || []).map((attachment) => attachment.updatedAt || 0));
    const previousUpdatedAt = Math.max(0, ...(previous?.metadata?.attachments || []).map((attachment) => attachment.updatedAt || 0));
    if (!previous || updatedAt > previousUpdatedAt || (updatedAt === previousUpdatedAt && Boolean(message.serverId) && !previous.serverId)) latest.set(key, message);
  }
  const statuses = new Map<string, 'ready' | 'failed'>();
  for (const [key, message] of latest) {
    const team = message.metadata?.agentTeamMedia;
    if (!team || message.isDeleted) continue;
    const status = message.metadata?.attachments?.find((attachment) => attachment.kind === 'video' || attachment.kind === 'image' || (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation'))?.status;
    if (status === 'ready' || status === 'failed') statuses.set(key, status);
  }
  return statuses;
}
useMessageStore.subscribe((next, previous) => {
  if (next.messages === previous.messages && next.messageWindowsByChatId === previous.messageWindowsByChatId) return;
  const previousCompleted = completedTeamMediaStatuses(previous);
  const newlyCompleted = completedTeamMediaStatuses(next);
  for (const [key, status] of previousCompleted) if (newlyCompleted.get(key) === status) newlyCompleted.delete(key);
  if (!newlyCompleted.size) return;
  for (const key of newlyCompleted.keys()) mediaWakeKeys.add(key);
  if (mediaWakePending) return;
  mediaWakePending = true;
  queueMicrotask(() => {
    mediaWakePending = false;
    const wakeKeys = new Set(mediaWakeKeys);
    mediaWakeKeys.clear();
    void listAgentTeamRuns().then((runs) => {
      for (const run of runs) {
        if (run.run.status !== 'active' && run.run.status !== 'failed') continue;
        if (!run.tasks.some((task) => (task.kind === 'agent_video' || task.kind === 'agent_image' || task.kind === 'agent_audio') && (task.status === 'waiting_external' || task.status === 'running' || task.status === 'failed' || task.status === 'result_unknown')
          && wakeKeys.has(`${task.runId}:${task.id}`))) continue;
        if (run.run.status === 'failed' && !run.tasks.some((task) => (task.status === 'failed' || task.status === 'result_unknown')
          && (task.kind === 'agent_video' ? inspectAgentTeamVideoAttachment(task.runId, task.id)?.status : task.kind === 'agent_image' ? inspectAgentTeamImageAttachment(task.runId, task.id)?.status : task.kind === 'agent_audio' ? inspectAgentTeamAudioAttachment(task.runId, task.id)?.status : null) === 'completed')) continue;
        if (activeTeamRuns.has(run.run.id)) {
          deferredMediaWakeRuns.add(run.run.id);
          continue;
        }
        void runAgentTeam({ chatId: run.run.chatId, goal: run.run.goal, runId: run.run.id })
          .catch((error) => console.error('[agent-team:video-resume-failed]', error));
      }
    }).catch((error) => console.error('[agent-team:video-wake-failed]', error));
  });
});

export function subscribeAgentTeamRuns(listener: () => void) {
  teamListeners.add(listener);
  return () => { teamListeners.delete(listener); };
}

export function getAgentTeamRunRevision() { return teamRevision; }

function currentTeamWorkflow() {
  return createAgentTeamWorkflow(useSettingsStore.getState().api, currentWorkflowScope);
}

export async function listAgentTeamRuns(chatId?: string) {
  const runs = await currentTeamWorkflow().list();
  return runs.filter((item) => item.tasks[0]?.kind === 'team_plan' && (!chatId || item.run.chatId === chatId));
}

export function isRecoverableAgentTeamRun(snapshot: WorkflowSnapshot) {
  return snapshot.run.status === 'paused'
    && (snapshot.run.maxModelCalls === undefined || countWorkflowModelCalls(snapshot) < snapshot.run.maxModelCalls
      || snapshot.tasks.some((task) => task.status === 'waiting_external'))
    && snapshot.tasks.length > 0
    && snapshot.tasks.every((task) => task.status !== 'failed' && task.status !== 'result_unknown' && task.status !== 'waiting_user')
    && snapshot.tasks.some((task) => task.status === 'queued' || task.status === 'waiting_dependency' || task.status === 'waiting_external');
}

export async function runAgentTeam(params: { chatId: string; goal: string; runId?: string; maxModelCalls?: number }) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务执行');
  const originalScope = currentWorkflowScope();
  if (activeTeamRuns.has(params.runId || '')) throw new Error('团队任务正在执行');
  const runId = params.runId || `team-${crypto.randomUUID()}`;
  activeTeamRuns.add(runId);
  notifyTeam();
  try {
    const workspaceSignal = getWorkspaceSignal();
    return await scheduleBackgroundExecution(params.chatId, () => runWithConversationExecutionLock(originalScope, params.chatId, async (signal) => {
      if (currentWorkflowScope() !== originalScope || getWorkspaceSignal().aborted) throw new Error('账号已切换，团队任务已暂停');
      const workflow = currentTeamWorkflow();
      const result = params.runId ? await workflow.resume(runId, signal) : await workflow.start(runId, params.chatId, params.goal, true, signal, params.maxModelCalls);
      if (currentWorkflowScope() !== originalScope || getWorkspaceSignal().aborted) throw new Error('账号已切换，团队交付已暂停');
      if (result.snapshot.run.status === 'completed') await workflow.publish(runId);
      return result;
    }, workspaceSignal), workspaceSignal, runId);
  } finally {
    activeTeamRuns.delete(runId);
    notifyTeam();
    if (deferredMediaWakeRuns.delete(runId)) {
      queueMicrotask(() => {
        void listAgentTeamRuns(params.chatId).then((runs) => {
          const run = runs.find((item) => item.run.id === runId);
          if (!run || (run.run.status !== 'active' && run.run.status !== 'failed') || activeTeamRuns.has(runId)) return;
          if (!run.tasks.some((task) => (task.kind === 'agent_video' || task.kind === 'agent_image' || task.kind === 'agent_audio')
            && (task.status === 'waiting_external' || task.status === 'failed')
            && ['completed', 'failed'].includes((task.kind === 'agent_video' ? inspectAgentTeamVideoAttachment(runId, task.id) : task.kind === 'agent_image' ? inspectAgentTeamImageAttachment(runId, task.id) : inspectAgentTeamAudioAttachment(runId, task.id))?.status || ''))) return;
          void runAgentTeam({ chatId: run.run.chatId, goal: run.run.goal, runId })
            .catch((error) => console.error('[agent-team:media-deferred-resume-failed]', error));
        }).catch((error) => console.error('[agent-team:media-deferred-wake-failed]', error));
      });
    }
  }
}

export function isAgentTeamRunActive(runId: string) { return activeTeamRuns.has(runId); }

export function hasActiveAgentTeamRuns() { return activeTeamRuns.size > 0; }

export async function pauseAgentTeamAfterCurrentBatch(runId: string) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  const workflow = currentTeamWorkflow();
  const run = await workflow.read(runId);
  if (!run || run.tasks[0]?.kind !== 'team_plan') throw new Error('团队任务不存在');
  const result = await workflow.requestPauseAfterCurrentBatch(runId);
  notifyTeam();
  return result;
}

export async function updateAgentTeamModelCallLimit(params: { runId: string; expectedPlanVersion: number; maxModelCalls?: number }) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  const result = await currentTeamWorkflow().setModelCallLimit(params.runId, params.expectedPlanVersion, params.maxModelCalls);
  notifyTeam();
  return result;
}

export async function instructAgentTeamTask(params: { runId: string; taskId: string; expectedPlanVersion: number; instruction: string }) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  const result = await currentTeamWorkflow().instructQueuedTask(params.runId, params.taskId, params.expectedPlanVersion, params.instruction);
  notifyTeam();
  return result;
}

export async function delegateAgentTeamTask(params: { runId: string; expectedPlanVersion: number; request: string }) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  const result = await currentTeamWorkflow().addRevisionRequest(params.runId, params.expectedPlanVersion, params.request);
  notifyTeam();
  return result;
}

export async function abandonAgentTeamReview(params: { runId: string; reviewId: string; expectedPlanVersion: number }) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  const result = await currentTeamWorkflow().abandonUnknownReview(params.runId, params.reviewId, params.expectedPlanVersion);
  notifyTeam();
  return result;
}

export async function retryAgentTeamReview(params: { runId: string; reviewId: string; expectedPlanVersion: number }) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  const result = await currentTeamWorkflow().retryFailedReview(params.runId, params.reviewId, params.expectedPlanVersion);
  notifyTeam();
  return result;
}

export async function retryAgentTeamPlan(params: { runId: string; taskId: string; expectedPlanVersion: number }) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  const result = await currentTeamWorkflow().retryFailedPlan(params.runId, params.taskId, params.expectedPlanVersion);
  notifyTeam();
  return result;
}

export async function recoverAgentTeamRuns() {
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务恢复');
  if (!useMessageStore.persist.hasHydrated()) await useMessageStore.persist.rehydrate();
  const storageScope = currentWorkflowScope();
  const runs = await listAgentTeamRuns();
  let changed = false;
  for (const run of runs) {
    if (run.run.status !== 'active' || activeTeamRuns.has(run.run.id)) continue;
    const recovered = await navigator.locks.request(workflowRunLockName(storageScope, run.run.id), { ifAvailable: true }, async (lock) => {
      if (!lock || currentWorkflowScope() !== storageScope) return false;
      return indexedDbWorkflowRepository.transact(storageScope, run.run.id, (current) => {
        if (!current || current.run.status !== 'active') return { snapshot: current || run, value: false };
        const snapshot: WorkflowSnapshot = {
          ...current,
          run: { ...current.run, status: 'paused', generation: current.run.generation + 1, updatedAt: Date.now() },
          tasks: current.tasks.map((task) => {
            if (task.status !== 'running') return task;
            if (task.kind === 'agent_media_composition') {
              const result = inspectAgentTeamComposition(task.runId, task.id);
              return { ...task, status: result ? 'completed' : 'queued', output: result?.output, error: undefined, updatedAt: Date.now() };
            }
            const image = task.kind === 'agent_image' ? inspectAgentTeamImageAttachment(task.runId, task.id) : null;
            if (image?.status === 'queued') return { ...task, status: 'queued', updatedAt: Date.now() };
            if (image?.status === 'completed') return { ...task, status: 'completed', output: image.output, updatedAt: Date.now() };
            if (image?.status === 'failed') return { ...task, status: 'failed', error: image.error, updatedAt: Date.now() };
            const audio = task.kind === 'agent_audio' ? inspectAgentTeamAudioAttachment(task.runId, task.id) : null;
            if (audio?.status === 'queued') return { ...task, status: 'queued', updatedAt: Date.now() };
            if (audio?.status === 'waiting_external') return { ...task, status: 'waiting_external', externalTaskId: audio.externalTaskId, updatedAt: Date.now() };
            if (audio?.status === 'completed') return { ...task, status: 'completed', output: audio.output, updatedAt: Date.now() };
            if (audio?.status === 'failed') return { ...task, status: 'failed', error: audio.error, updatedAt: Date.now() };
            const video = task.kind === 'agent_video' ? inspectAgentTeamVideoAttachment(task.runId, task.id) : null;
            if (video?.status === 'queued') return { ...task, status: 'queued', updatedAt: Date.now() };
            if (video?.status === 'waiting_external') return { ...task, status: 'waiting_external', externalTaskId: video.externalTaskId, updatedAt: Date.now() };
            if (video?.status === 'completed') return { ...task, status: 'completed', output: video.output, updatedAt: Date.now() };
            if (video?.status === 'failed') return { ...task, status: 'failed', error: video.error, updatedAt: Date.now() };
            return { ...task, status: 'result_unknown', error: '程序关闭前的请求结果无法确认', updatedAt: Date.now() };
          }),
        };
        return { snapshot, value: true };
      });
    });
    changed ||= recovered;
  }
  for (const run of runs) {
    if (currentWorkflowScope() !== storageScope) break;
    await indexedDbWorkflowRepository.registerOutboxConsumer(storageScope, run.run.id, 'team-delivery');
    try {
      if (run.run.status === 'completed' && run.run.deliveryStatus !== 'published') {
        await currentTeamWorkflow().publish(run.run.id);
        changed = true;
      }
      while (currentWorkflowScope() === storageScope) {
        const events = await indexedDbWorkflowRepository.listOutboxEvents(storageScope, run.run.id, 'team-delivery', 1000);
        if (!events.length) break;
        await indexedDbWorkflowRepository.acknowledgeOutboxEvents(storageScope, run.run.id, 'team-delivery', events.at(-1)!.sequence);
      }
    } catch (error) {
      console.error('[agent-team:delivery-recovery-failed]', { runId: run.run.id, error });
    }
  }
  if (changed) notifyTeam();
  return changed;
}
