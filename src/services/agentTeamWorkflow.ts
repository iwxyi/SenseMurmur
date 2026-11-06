import { getUsablePreferredAIProfile, type APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';
import { planAgentTeam, validateAgentTeamPlan, type AgentTeamPlan, type AgentTeamTask } from './agentTeamPlan';
import { createWorkflowRunRuntime, indexedDbWorkflowRepository, summarizeWorkflowRun, WorkflowPreflightError, type WorkflowTask, type WorkflowSnapshot } from './workflowRunRuntime';
import { ensureAssistantArtifactStoreHydrated, useAssistantArtifactStore } from '../stores/useAssistantArtifactStore';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { currentWorkflowScope, workflowRunLockName } from './workflowRunRuntime';
import { attachMessageToActiveBranch } from './messageBranching';
import type { Message } from '../types/message';
import { useSettingsStore } from '../stores/useSettingsStore';
import { readAuthSnapshot } from './authSnapshot';
import { getWorkspaceSignal } from './workspaceLifecycle';
import { scheduleBackgroundExecution } from './backgroundExecutionScheduler';
import { runWithConversationExecutionLock } from './conversationExecutionLock';
import { api as appApi } from './api';
import { resolveChatAgentCapabilities } from './chatAgentCapabilities';
import { inspectAgentTeamVideoAttachment, queueAgentTeamVideo } from './agentTeamVideoTask';

interface TeamTaskInput {
  task: AgentTeamTask;
  goal: string;
  role: AgentTeamPlan['roles'][number];
  userInstruction?: string;
  sourcePlanTaskId?: string;
  contextTaskIds?: string[];
}

interface TeamRevisionInput { request: string; sourceTaskIds: string[] }

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

export function createAgentTeamWorkflow(api: APIConfig, scope: () => string) {
  const runtime: ReturnType<typeof createWorkflowRunRuntime> = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
    async execute(task: WorkflowTask, signal) {
      if (task.kind === 'team_plan') {
        if (typeof task.input !== 'string') throw new WorkflowPreflightError('团队目标无效');
        const snapshot = await runtime.read(task.runId);
        const chat = useChatStore.getState().chats.find((item) => item.id === snapshot?.run.chatId);
        return { output: await planAgentTeam({ api, goal: task.input, webSearch: Boolean(chat?.modeState && resolveChatAgentCapabilities(chat).webSearch), videoGeneration: Boolean(getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'video')), signal }) };
      }
      if (task.kind === 'team_plan_revision') {
        if (!isTeamRevisionInput(task.input)) throw new WorkflowPreflightError('追加委派输入无效');
        const snapshot = await runtime.read(task.runId);
        if (!snapshot) throw new WorkflowPreflightError('团队任务记录不存在');
        const prior = task.input.sourceTaskIds.map((id) => {
          const source = snapshot.tasks.find((item) => item.id === id);
          if (!source || source.status !== 'completed' || typeof source.output !== 'string') throw new WorkflowPreflightError('已有交付尚未就绪');
          return { task: id, output: source.output.slice(0, 8000) };
        });
        const chat = useChatStore.getState().chats.find((item) => item.id === snapshot.run.chatId);
        return { output: await planAgentTeam({ api, goal: `总目标：${snapshot.run.goal}\n追加要求：${task.input.request}\n已有交付：${JSON.stringify(prior)}\n只规划新增且尚未完成的工作。`, webSearch: Boolean(chat?.modeState && resolveChatAgentCapabilities(chat).webSearch), videoGeneration: Boolean(getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'video')), signal }) };
      }
      if ((task.kind !== 'agent_text' && task.kind !== 'agent_web_search' && task.kind !== 'agent_video') || !isTeamTaskInput(task.input)) throw new WorkflowPreflightError('团队任务类型无效');
      const input = task.input;
      const role = input.role;
      const snapshot = await runtime.read(task.runId);
      if (!snapshot) throw new WorkflowPreflightError('团队任务记录不存在');
      let plan: AgentTeamPlan;
      try {
        plan = validateAgentTeamPlan(snapshot.tasks.find((item) => item.id === (input.sourcePlanTaskId || 'plan'))?.output);
      } catch (error) {
        throw new WorkflowPreflightError(error instanceof Error ? error.message : '团队计划无效');
      }
      const plannedTask = plan.tasks.find((item) => item.id === (input.sourcePlanTaskId ? task.id.replace(/^delegated_/, '') : task.id));
      const plannedRole = plan.roles.find((item) => item.id === plannedTask?.roleId);
      if (!plannedTask || !plannedRole || JSON.stringify(input.task) !== JSON.stringify(plannedTask) || JSON.stringify(role) !== JSON.stringify(plannedRole) || input.goal !== snapshot.run.goal
        || (input.userInstruction !== undefined && (typeof input.userInstruction !== 'string' || !input.userInstruction.trim() || input.userInstruction.length > 4000))) {
        throw new WorkflowPreflightError('团队任务与已保存计划不一致');
      }
      const selectedTool = input.task.tool || 'text_generation';
      if (task.kind !== (selectedTool === 'web_search' ? 'agent_web_search' : selectedTool === 'video_generation' ? 'agent_video' : 'agent_text')) throw new WorkflowPreflightError('团队任务工具与计划不一致');
      if (selectedTool === 'video_generation') {
        return queueAgentTeamVideo({ runId: task.runId, taskId: task.id, chatId: snapshot.run.chatId,
          prompt: [input.task.goal, input.userInstruction].filter(Boolean).join('\n'), signal });
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
      const upstream = [...input.task.dependsOn.map((id) => input.sourcePlanTaskId ? `delegated_${id}` : id), ...(input.contextTaskIds || [])].map((id) => {
        const dependency = snapshot.tasks.find((item) => item.id === id);
        if (!dependency || dependency.status !== 'completed' || typeof dependency.output !== 'string') throw new WorkflowPreflightError('上游交付尚未就绪');
        return { taskId: id, content: dependency.output.slice(0, 24_000) };
      });
      const output = await generateResponse(api, [
        `岗位：${role.name}`,
        `职责：${role.responsibility}`,
        `方法：${role.method}`,
        `岗位验收：${role.acceptance}`,
        `本任务验收：${input.task.acceptance}`,
        '只根据提供的目标与上游交付工作；不声称调用了未提供的工具。缺少事实依据时标明不确定性。',
      ].join('\n'), [{ role: 'user', content: `总目标：${input.goal}\n当前任务：${input.task.goal}\n${input.userInstruction ? `用户补充指示：${input.userInstruction}\n` : ''}上游交付：${JSON.stringify(upstream)}` }], undefined, {
        responseFormat: 'text', signal,
        aiUsage: { type: 'assistant_chat', label: '团队文本任务', scope: 'chat' },
      });
      if (!output.trim()) throw new Error('子 Agent 未提交内容');
      return { output: output.trim() };
    },
    async inspectExternal(task) {
      if (task.kind !== 'agent_video') throw new WorkflowPreflightError('外部任务类型无效');
      const result = inspectAgentTeamVideoAttachment(task.runId, task.id);
      if (result?.status === 'completed') return result;
      if (result?.status === 'failed') return result;
      return { status: 'pending' as const };
    },
    async reconcileInterrupted(task) {
      if (task.kind !== 'agent_video') return null;
      return inspectAgentTeamVideoAttachment(task.runId, task.id);
    },
  }, scope);

  return {
    read: runtime.read,
    list: runtime.list,
    requestPauseAfterCurrentBatch: runtime.requestPauseAfterCurrentBatch,
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
        if (current.tasks.some((task) => task.kind === 'team_plan_revision')) throw new Error('当前团队任务已使用追加委派机会');
        if (current.tasks.some((task) => task.status === 'running' || task.status === 'result_unknown' || task.status === 'failed')) throw new Error('请先处理未完成或待核对的步骤');
        const sourceTaskIds = current.tasks.filter((task) => task.kind === 'agent_text' || task.kind === 'agent_web_search' || task.kind === 'agent_video').map((task) => task.id);
        if (!sourceTaskIds.length) throw new Error('团队规划尚未完成');
        const task: WorkflowTask = {
          id: 'delegate', runId, kind: 'team_plan_revision',
          input: { request: trimmed, sourceTaskIds } satisfies TeamRevisionInput,
          dependsOn: sourceTaskIds, status: 'waiting_dependency', attempt: 0, updatedAt: Date.now(),
        };
        return current.run.status === 'completed'
          ? runtime.reopenWithTasks(runId, expectedPlanVersion, [task])
          : runtime.addTasks(runId, expectedPlanVersion, [task]);
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
          if (!target || (target.kind !== 'agent_text' && target.kind !== 'agent_web_search' && target.kind !== 'agent_video') || !isTeamTaskInput(target.input) || target.attempt !== 0
            || (target.status !== 'queued' && target.status !== 'waiting_dependency')) throw new Error('只能修改尚未执行的子任务');
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
    async start(runId: string, chatId: string, goal: string) {
      const now = Date.now();
      const initial: WorkflowSnapshot = {
        run: { id: runId, chatId, goal, status: 'active', generation: 0, planVersion: 1, planOpen: true, updatedAt: now },
        tasks: [{ id: 'plan', runId, kind: 'team_plan', input: goal, dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }],
      };
      if (!await runtime.read(runId)) await runtime.create(initial);
      return this.resume(runId);
    },
    async resume(runId: string) {
      let snapshot = await runtime.resume(runId, getWorkspaceSignal());
      const planner = snapshot.tasks.find((task) => task.id === 'plan');
      if (planner?.status !== 'completed') return { snapshot, summary: summarizeWorkflowRun(snapshot) };
      const plan = validateAgentTeamPlan(planner.output);
      const roles = new Map(plan.roles.map((role) => [role.id, role]));
      const additions = plan.tasks.map((task): WorkflowTask => ({
        id: task.id,
        runId,
        kind: task.tool === 'web_search' ? 'agent_web_search' : task.tool === 'video_generation' ? 'agent_video' : 'agent_text',
        input: { task, goal: snapshot.run.goal, role: roles.get(task.roleId)! } satisfies TeamTaskInput,
        dependsOn: ['plan', ...task.dependsOn],
        status: task.dependsOn.length ? 'waiting_dependency' : 'queued',
        attempt: 0,
        updatedAt: Date.now(),
      }));
      snapshot = await runtime.expandPlanOnce(runId, snapshot.run.planVersion, 'plan', additions);
      if (snapshot.run.status === 'active') snapshot = await runtime.resume(runId, getWorkspaceSignal());
      const revisionTask = snapshot.tasks.find((task) => task.kind === 'team_plan_revision');
      if (revisionTask?.status === 'completed') {
        const delegated = validateAgentTeamPlan(revisionTask.output);
        if (snapshot.tasks.length + delegated.tasks.length > 24) throw new Error('团队任务规模超出限制');
        const delegatedRoles = new Map(delegated.roles.map((role) => [role.id, role]));
        const contextTaskIds = isTeamRevisionInput(revisionTask.input) ? revisionTask.input.sourceTaskIds : [];
        const delegatedTasks = delegated.tasks.map((task): WorkflowTask => ({
          id: `delegated_${task.id}`, runId, kind: task.tool === 'web_search' ? 'agent_web_search' : task.tool === 'video_generation' ? 'agent_video' : 'agent_text',
          input: { task, goal: snapshot.run.goal, role: delegatedRoles.get(task.roleId)!, sourcePlanTaskId: revisionTask.id, contextTaskIds } satisfies TeamTaskInput,
          dependsOn: [revisionTask.id, ...contextTaskIds, ...task.dependsOn.map((id) => `delegated_${id}`)],
          status: 'waiting_dependency', attempt: 0, updatedAt: Date.now(),
        }));
        snapshot = await runtime.expandPlanOnce(runId, snapshot.run.planVersion, revisionTask.id, delegatedTasks);
        if (snapshot.run.status === 'active') snapshot = await runtime.resume(runId, getWorkspaceSignal());
      }
      if (snapshot.run.status !== 'completed' && snapshot.tasks.every((task) => task.status === 'completed')) snapshot = await runtime.closePlan(runId, snapshot.run.planVersion);
      return { snapshot, summary: summarizeWorkflowRun(snapshot) };
    },
    async publish(runId: string) {
      if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队交付');
      const deliveryScope = scope();
      return navigator.locks.request(workflowRunLockName(deliveryScope, runId), async () => {
      if (scope() !== deliveryScope) throw new Error('账号已切换，团队交付已暂停');
      const snapshot = await runtime.read(runId);
      if (!snapshot || snapshot.run.status !== 'completed') throw new Error('团队任务尚未完成');
      await Promise.all([
        ensureAssistantArtifactStoreHydrated(),
        useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
        useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
      ]);
      const chat = useChatStore.getState().chats.find((item) => item.id === snapshot.run.chatId && item.deletedAt == null);
      if (!chat || chat.type !== 'assistant') throw new Error('交付会话不可用');
      const sourceId = `team-delivery-${runId}`;
      const existing = useAssistantArtifactStore.getState().getArtifactsForChat(chat.id).find((item) => item.sourceMessageId === sourceId);
      const existingVersion = existing?.versions.find((item) => item.id === existing.currentVersionId);
      const plan = validateAgentTeamPlan(snapshot.tasks.find((task) => task.id === 'plan')?.output);
      const delegatedPlan = snapshot.tasks.find((task) => task.kind === 'team_plan_revision')?.output;
      const delegated = delegatedPlan ? validateAgentTeamPlan(delegatedPlan) : null;
      const content = [
        `# ${plan.summary}`,
        ...plan.tasks.map((task) => {
          const output = snapshot.tasks.find((item) => item.id === task.id)?.output;
          if (typeof output !== 'string') throw new Error('团队交付缺少任务结果');
          return `## ${task.goal}\n\n${output}`;
        }),
        ...(delegated ? delegated.tasks.map((task) => {
          const output = snapshot.tasks.find((item) => item.id === `delegated_${task.id}`)?.output;
          if (typeof output !== 'string') throw new Error('追加委派交付缺少任务结果');
          return `## ${task.goal}\n\n${output}`;
        }) : []),
      ].join('\n\n');
      const artifact = existingVersion?.content === content ? existing : useAssistantArtifactStore.getState().upsertArtifactsFromMessage({
        chatId: chat.id,
        messageId: sourceId,
        drafts: [{ kind: 'document', title: plan.summary.slice(0, 60), content, summary: delegated?.finalAcceptance || plan.finalAcceptance,
          ...(existing ? { action: 'update' as const, targetArtifactId: existing.id, baseVersionId: existing.currentVersionId } : {}) }],
      })[0];
      if (!artifact) throw new Error('团队交付产物保存失败');
      if (scope() !== deliveryScope) throw new Error('账号已切换，团队交付已暂停');
      const messageStore = useMessageStore.getState();
      const known = [...messageStore.messages, ...(messageStore.messageWindowsByChatId[chat.id]?.messages || [])];
      const previousDelivery = known.find((item) => item.id === sourceId || item.clientKey === sourceId);
      if (!previousDelivery || previousDelivery.metadata?.assistant?.artifacts?.[0]?.versionId !== artifact.currentVersionId) {
        const draft = attachMessageToActiveBranch(chat, known, {
          id: sourceId, clientKey: sourceId, chatId: chat.id, type: 'ai' as const,
          senderId: 'assistant', senderName: '助手', content: `${existing ? '团队任务已更新' : '团队任务已完成'}：${plan.summary}`,
          emotion: 0, timestamp: previousDelivery?.timestamp || Date.now(), isDeleted: false,
          metadata: { format: 'markdown' as const, assistant: { mode: 'general' as const, artifacts: [{ id: artifact.id, kind: artifact.kind, title: artifact.title, versionId: artifact.currentVersionId }] } },
        }) as Message;
        useMessageStore.getState().upsertMessage(draft);
        useMessageStore.getState().queueMessageSync(draft);
        void useChatStore.getState().updateChat(chat.id, { lastMessageAt: draft.timestamp, latestMessage: draft });
      }
      flushBufferedPersistenceWrites();
      return artifact;
      });
    },
  };
}

const teamListeners = new Set<() => void>();
let teamRevision = 0;
const notifyTeam = () => { teamRevision += 1; teamListeners.forEach((listener) => listener()); };
const activeTeamRuns = new Set<string>();
let videoWakePending = false;
const videoWakeKeys = new Set<string>();
const deferredVideoWakeRuns = new Set<string>();
function completedTeamVideoKeys(state: ReturnType<typeof useMessageStore.getState>) {
  const keys = new Set<string>();
  for (const message of [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]) {
    const team = message.metadata?.agentTeamMedia;
    if (!team || message.isDeleted) continue;
    if (message.metadata?.attachments?.some((attachment) => attachment.kind === 'video' && (attachment.status === 'ready' || attachment.status === 'failed'))) {
      keys.add(`${team.runId}:${team.taskId}`);
    }
  }
  return keys;
}
useMessageStore.subscribe((next, previous) => {
  if (next.messages === previous.messages && next.messageWindowsByChatId === previous.messageWindowsByChatId) return;
  const previousCompleted = completedTeamVideoKeys(previous);
  const newlyCompleted = completedTeamVideoKeys(next);
  for (const key of previousCompleted) newlyCompleted.delete(key);
  if (!newlyCompleted.size) return;
  for (const key of newlyCompleted) videoWakeKeys.add(key);
  if (videoWakePending) return;
  videoWakePending = true;
  queueMicrotask(() => {
    videoWakePending = false;
    const wakeKeys = new Set(videoWakeKeys);
    videoWakeKeys.clear();
    void listAgentTeamRuns().then((runs) => {
      for (const run of runs) {
        if (run.run.status !== 'active') continue;
        if (!run.tasks.some((task) => task.kind === 'agent_video' && task.status === 'waiting_external'
          && wakeKeys.has(`${task.runId}:${task.id}`))) continue;
        if (activeTeamRuns.has(run.run.id)) {
          deferredVideoWakeRuns.add(run.run.id);
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

export async function runAgentTeam(params: { chatId: string; goal: string; runId?: string }) {
  const auth = readAuthSnapshot();
  if (auth.mode === 'cloud' && auth.user?.agentEntitled !== true) throw new Error('当前账号没有 Agent 权限');
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务执行');
  const originalScope = currentWorkflowScope();
  if (activeTeamRuns.has(params.runId || '')) throw new Error('团队任务正在执行');
  const runId = params.runId || `team-${crypto.randomUUID()}`;
  activeTeamRuns.add(runId);
  notifyTeam();
  try {
    return await scheduleBackgroundExecution(params.chatId, () => runWithConversationExecutionLock(originalScope, params.chatId, async () => {
      if (currentWorkflowScope() !== originalScope || getWorkspaceSignal().aborted) throw new Error('账号已切换，团队任务已暂停');
      const workflow = currentTeamWorkflow();
      const result = params.runId ? await workflow.resume(runId) : await workflow.start(runId, params.chatId, params.goal);
      if (currentWorkflowScope() !== originalScope || getWorkspaceSignal().aborted) throw new Error('账号已切换，团队交付已暂停');
      if (result.snapshot.run.status === 'completed') await workflow.publish(runId);
      return result;
    }), getWorkspaceSignal(), runId);
  } finally {
    activeTeamRuns.delete(runId);
    notifyTeam();
    if (deferredVideoWakeRuns.delete(runId)) {
      queueMicrotask(() => {
        void listAgentTeamRuns(params.chatId).then((runs) => {
          const run = runs.find((item) => item.run.id === runId);
          if (!run || run.run.status !== 'active' || activeTeamRuns.has(runId)) return;
          if (!run.tasks.some((task) => task.kind === 'agent_video' && task.status === 'waiting_external'
            && ['completed', 'failed'].includes(inspectAgentTeamVideoAttachment(runId, task.id)?.status || ''))) return;
          void runAgentTeam({ chatId: run.run.chatId, goal: run.run.goal, runId })
            .catch((error) => console.error('[agent-team:video-deferred-resume-failed]', error));
        }).catch((error) => console.error('[agent-team:video-deferred-wake-failed]', error));
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

export async function recoverAgentTeamRuns() {
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的团队任务恢复');
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
  if (changed) notifyTeam();
  return changed;
}
