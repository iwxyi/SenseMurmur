import type { APIConfig } from '../types/settings';
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

interface TeamTaskInput {
  task: AgentTeamTask;
  goal: string;
  role: AgentTeamPlan['roles'][number];
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
        return { output: await planAgentTeam({ api, goal: task.input, signal }) };
      }
      if (task.kind !== 'agent_text' || !isTeamTaskInput(task.input)) throw new WorkflowPreflightError('团队任务类型无效');
      const role = task.input.role;
      const snapshot = await runtime.read(task.runId);
      if (!snapshot) throw new WorkflowPreflightError('团队任务记录不存在');
      let plan: AgentTeamPlan;
      try {
        plan = validateAgentTeamPlan(snapshot.tasks.find((item) => item.id === 'plan')?.output);
      } catch (error) {
        throw new WorkflowPreflightError(error instanceof Error ? error.message : '团队计划无效');
      }
      const plannedTask = plan.tasks.find((item) => item.id === task.id);
      const plannedRole = plan.roles.find((item) => item.id === plannedTask?.roleId);
      if (!plannedTask || !plannedRole || JSON.stringify(task.input.task) !== JSON.stringify(plannedTask) || JSON.stringify(role) !== JSON.stringify(plannedRole) || task.input.goal !== snapshot.run.goal) {
        throw new WorkflowPreflightError('团队任务与已保存计划不一致');
      }
      const upstream = task.input.task.dependsOn.map((id) => {
        const dependency = snapshot.tasks.find((item) => item.id === id);
        if (!dependency || dependency.status !== 'completed' || typeof dependency.output !== 'string') throw new WorkflowPreflightError('上游交付尚未就绪');
        return { taskId: id, content: dependency.output.slice(0, 24_000) };
      });
      const output = await generateResponse(api, [
        `岗位：${role.name}`,
        `职责：${role.responsibility}`,
        `方法：${role.method}`,
        `岗位验收：${role.acceptance}`,
        `本任务验收：${task.input.task.acceptance}`,
        '只根据提供的目标与上游交付工作；不声称调用了未提供的工具。缺少事实依据时标明不确定性。',
      ].join('\n'), [{ role: 'user', content: `总目标：${task.input.goal}\n当前任务：${task.input.task.goal}\n上游交付：${JSON.stringify(upstream)}` }], undefined, {
        responseFormat: 'text', signal,
        aiUsage: { type: 'assistant_chat', label: '团队文本任务', scope: 'chat' },
      });
      if (!output.trim()) throw new Error('子 Agent 未提交内容');
      return { output: output.trim() };
    },
  }, scope);

  return {
    read: runtime.read,
    list: runtime.list,
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
        kind: 'agent_text',
        input: { task, goal: snapshot.run.goal, role: roles.get(task.roleId)! } satisfies TeamTaskInput,
        dependsOn: ['plan', ...task.dependsOn],
        status: task.dependsOn.length ? 'waiting_dependency' : 'queued',
        attempt: 0,
        updatedAt: Date.now(),
      }));
      snapshot = await runtime.expandPlanOnce(runId, snapshot.run.planVersion, 'plan', additions);
      snapshot = await runtime.resume(runId, getWorkspaceSignal());
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
      const plan = validateAgentTeamPlan(snapshot.tasks.find((task) => task.id === 'plan')?.output);
      const content = [
        `# ${plan.summary}`,
        ...plan.tasks.map((task) => {
          const output = snapshot.tasks.find((item) => item.id === task.id)?.output;
          if (typeof output !== 'string') throw new Error('团队交付缺少任务结果');
          return `## ${task.goal}\n\n${output}`;
        }),
      ].join('\n\n');
      const artifact = existing || useAssistantArtifactStore.getState().upsertArtifactsFromMessage({
        chatId: chat.id,
        messageId: sourceId,
        drafts: [{ kind: 'document', title: plan.summary.slice(0, 60), content, summary: plan.finalAcceptance }],
      })[0];
      if (!artifact) throw new Error('团队交付产物保存失败');
      if (scope() !== deliveryScope) throw new Error('账号已切换，团队交付已暂停');
      const messageStore = useMessageStore.getState();
      const known = [...messageStore.messages, ...(messageStore.messageWindowsByChatId[chat.id]?.messages || [])];
      if (!known.some((item) => item.id === sourceId || item.clientKey === sourceId)) {
        const draft = attachMessageToActiveBranch(chat, known, {
          id: sourceId, clientKey: sourceId, chatId: chat.id, type: 'ai' as const,
          senderId: 'assistant', senderName: '助手', content: `团队任务已完成：${plan.summary}`,
          emotion: 0, timestamp: Date.now(), isDeleted: false,
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
    const chatLock = `pneumata-assistant-chat-${originalScope}-${params.chatId}`;
    return await navigator.locks.request(chatLock, async () => {
      if (currentWorkflowScope() !== originalScope || getWorkspaceSignal().aborted) throw new Error('账号已切换，团队任务已暂停');
      const workflow = currentTeamWorkflow();
      const result = params.runId ? await workflow.resume(runId) : await workflow.start(runId, params.chatId, params.goal);
      if (currentWorkflowScope() !== originalScope || getWorkspaceSignal().aborted) throw new Error('账号已切换，团队交付已暂停');
      if (result.snapshot.run.status === 'completed') await workflow.publish(runId);
      return result;
    });
  } finally {
    activeTeamRuns.delete(runId);
    notifyTeam();
  }
}

export function isAgentTeamRunActive(runId: string) { return activeTeamRuns.has(runId); }

export function hasActiveAgentTeamRuns() { return activeTeamRuns.size > 0; }

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
          tasks: current.tasks.map((task) => task.status === 'running'
            ? { ...task, status: 'result_unknown', error: '程序关闭前的模型请求结果无法确认', updatedAt: Date.now() }
            : task),
        };
        return { snapshot, value: true };
      });
    });
    changed ||= recovered;
  }
  if (changed) notifyTeam();
  return changed;
}
