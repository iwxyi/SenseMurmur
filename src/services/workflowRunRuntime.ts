import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from './authStorageScope';
import { claimedTaskAttempt, parseWorkflowTaskAttempt, settleTaskAttempt, type WorkflowTaskAttempt } from './workflowTaskAttempt';
import { appliedWorkflowPlanRevision, parseWorkflowPlanRevision, type WorkflowPlanRevision } from './workflowPlanRevision';
import { parseWorkflowGoalSpec, workflowDeadlineBlockReason, type WorkflowGoalSpec } from './workflowGoalSpec';
import { isWorkflowModelTask, parseWorkflowModelInvocation, workflowModelInvocationId, type WorkflowModelInvocation } from './workflowModelInvocation';
import { copyWorkflowDelivery, parseWorkflowDelivery, type WorkflowDelivery, type WorkflowDeliveryBranch, type WorkflowDeliveryIssue } from './workflowDelivery';
import { isWorkflowToolTask, parseWorkflowToolInvocation, workflowToolInvocationId, workflowToolOperationKey, type WorkflowToolInvocation } from './workflowToolInvocation';
import { parseWorkflowToolRequest, workflowJsonDigest, workflowToolRequestKind, type WorkflowToolRequest } from './workflowToolRequest';
import { parseWorkflowReviewRecord } from './workflowReviewRecord';
import { parseWorkflowRevisionImpact } from './workflowRevisionImpact';
import { parseTeamReviewInput } from './agentTeamReviewEvidence';
import { assertWorkflowDecisions, assertWorkflowDecisionTransition, deliveryCopyDecision, type WorkflowDecisionRecord } from './workflowDecision';
import { assertWorkflowUserResponse, createWorkflowUserResponse, type WorkflowUserResponse } from './workflowUserResponse';
import { parseWorkflowModelRequest, type WorkflowModelRequest } from './workflowModelRequest';
import { assertWorkflowApprovals, assertWorkflowApprovalTransition, pendingWorkflowApproval, proposeWorkflowApproval, workflowApprovalMatches,
  type WorkflowApproval, type WorkflowApprovalRequirement } from './workflowApproval';
import type { WorkflowUsageReference } from '../types/workflowUsage';
import { workflowAdmissionBlockReason } from './workflowAdmission';
import { parseWorkflowCapabilityIssue, type WorkflowCapabilityIssue, type WorkflowCapabilityRequirement } from './workflowCapability';

export type WorkflowTaskStatus = 'queued' | 'running' | 'waiting_dependency' | 'waiting_external' | 'waiting_user' | 'result_unknown' | 'completed' | 'failed' | 'cancelled' | 'abandoned';

export interface WorkflowTask {
  schemaVersion?: 1;
  id: string;
  runId: string;
  dependsOn: string[];
  status: WorkflowTaskStatus;
  kind: string;
  input: unknown;
  output?: unknown;
  userResponse?: WorkflowUserResponse;
  approvals?: WorkflowApproval[];
  externalTaskId?: string;
  error?: string;
  capabilityIssue?: WorkflowCapabilityIssue;
  attempt: number;
  unstartedModelAttempts?: number;
  modelInvocation?: WorkflowModelInvocation;
  toolInvocation?: WorkflowToolInvocation;
  expansion?: { taskIds: string[]; context: unknown };
  updatedAt: number;
}

export interface WorkflowRun {
  schemaVersion?: 1;
  id: string;
  chatId: string;
  goal: string;
  goalSpec?: WorkflowGoalSpec;
  retryOfRunId?: string;
  retryRootRunId?: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  generation: number;
  planVersion: number;
  resumeCommandIds?: string[];
  planOpen?: boolean;
  autoReview?: boolean;
  pauseRequested?: boolean;
  pauseReason?: string;
  deliveryStatus?: 'pending' | 'published';
  delivery?: WorkflowDelivery;
  deliveryCopy?: WorkflowDelivery;
  deliveryIssue?: WorkflowDeliveryIssue;
  decisions?: WorkflowDecisionRecord[];
  maxModelCalls?: number;
  updatedAt: number;
}

export interface WorkflowSnapshot {
  schemaVersion?: 1;
  run: WorkflowRun;
  tasks: WorkflowTask[];
}

export interface WorkflowEvent {
  eventId: string;
  aggregateVersion: number;
  sequence: number;
  runId: string;
  occurredAt: number;
  runStatus: WorkflowRun['status'];
  generation: number;
  planVersion: number;
  changedTasks: Array<{ id: string; status: WorkflowTaskStatus | 'removed'; attempt: number }>;
}

const RUN_STATUSES = new Set<WorkflowRun['status']>(['active', 'paused', 'completed', 'failed', 'cancelled']);
const TASK_STATUSES = new Set<WorkflowTaskStatus>([
  'queued', 'running', 'waiting_dependency', 'waiting_external', 'waiting_user',
  'result_unknown', 'completed', 'failed', 'cancelled', 'abandoned',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`工作流${label}无效`);
}

function assertWorkflowSnapshot(value: unknown): asserts value is WorkflowSnapshot {
  if (!isRecord(value) || !isRecord(value.run) || !Array.isArray(value.tasks)) throw new Error('工作流快照结构无效');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('工作流快照版本不受支持');
  const run = value.run;
  const tasks = value.tasks;
  if (run.schemaVersion !== undefined && run.schemaVersion !== 1) throw new Error('工作流运行契约版本不受支持');
  assertNonEmptyString(run.id, '运行 ID');
  assertNonEmptyString(run.chatId, '会话 ID');
  assertNonEmptyString(run.goal, '目标');
  if (run.goalSpec !== undefined && parseWorkflowGoalSpec(run.goalSpec).objective !== run.goal) throw new Error('目标契约与运行目标不一致');
  if (!RUN_STATUSES.has(run.status as WorkflowRun['status'])) throw new Error('工作流运行状态无效');
  if (!Number.isSafeInteger(run.generation) || (run.generation as number) < 0) throw new Error('工作流运行代次无效');
  if (!Number.isSafeInteger(run.planVersion) || (run.planVersion as number) < 1) throw new Error('工作流计划版本无效');
  if (!Number.isFinite(run.updatedAt)) throw new Error('工作流更新时间无效');
  if (run.pauseReason !== undefined && (typeof run.pauseReason !== 'string' || !run.pauseReason.trim() || run.pauseReason.length > 1000)) throw new Error('工作流暂停原因无效');
  if (run.resumeCommandIds !== undefined && (!Array.isArray(run.resumeCommandIds) || run.resumeCommandIds.some((id) => typeof id !== 'string' || !id))) {
    throw new Error('工作流恢复命令记录无效');
  }
  if (run.deliveryStatus !== undefined && run.deliveryStatus !== 'pending' && run.deliveryStatus !== 'published') throw new Error('工作流交付状态无效');
  if (run.deliveryIssue !== undefined && !['artifact_conflict', 'message_conflict', 'save_failed'].includes(String(run.deliveryIssue))) throw new Error('工作流交付问题无效');
  if (run.delivery !== undefined) {
    const delivery = parseWorkflowDelivery(run.delivery);
    if (delivery.copyOfPlanVersion !== undefined || delivery.runId !== run.id || delivery.chatId !== run.chatId || delivery.planVersion > Number(run.planVersion)) throw new Error('工作流交付清单归属无效');
  }
  if (run.deliveryCopy !== undefined) {
    const copy = parseWorkflowDelivery(run.deliveryCopy);
    if (!run.delivery || copy.copyOfPlanVersion !== copy.planVersion || copy.runId !== run.id
      || copy.chatId !== run.chatId || copy.planVersion > parseWorkflowDelivery(run.delivery).planVersion) throw new Error('另存交付归属无效');
  }
  if (run.maxModelCalls !== undefined && (!Number.isSafeInteger(run.maxModelCalls) || (run.maxModelCalls as number) < 1 || (run.maxModelCalls as number) > 1000)) throw new Error('工作流模型调用上限无效');
  assertWorkflowDecisions(run as unknown as WorkflowRun);

  const taskIds = new Set<string>();
  for (const candidate of value.tasks) {
    if (!isRecord(candidate)) throw new Error('工作流任务结构无效');
    if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== 1) throw new Error('工作流任务契约版本不受支持');
    assertNonEmptyString(candidate.id, '任务 ID');
    assertNonEmptyString(candidate.runId, '任务运行 ID');
    assertNonEmptyString(candidate.kind, '任务类型');
    if (candidate.runId !== run.id) throw new Error('工作流任务不属于当前运行');
    if (taskIds.has(candidate.id)) throw new Error('工作流任务 ID 重复');
    taskIds.add(candidate.id);
    if (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some((id) => typeof id !== 'string' || !id)) throw new Error('工作流任务依赖无效');
    if (new Set(candidate.dependsOn).size !== candidate.dependsOn.length) throw new Error('工作流任务依赖重复');
    if (!TASK_STATUSES.has(candidate.status as WorkflowTaskStatus)) throw new Error('工作流任务状态无效');
    assertWorkflowUserResponse(candidate as unknown as WorkflowTask, Number(run.planVersion));
    assertWorkflowApprovals(value as unknown as WorkflowSnapshot, candidate as unknown as WorkflowTask);
    if (!Number.isSafeInteger(candidate.attempt) || (candidate.attempt as number) < 0) throw new Error('工作流任务尝试次数无效');
    if (candidate.capabilityIssue !== undefined) {
      const issue = parseWorkflowCapabilityIssue(candidate.capabilityIssue);
      if (issue.attempt !== candidate.attempt
        || issue.planVersion > Number(run.planVersion)) throw new Error('能力不足记录不属于当前失败任务');
    }
    if (candidate.kind === 'team_review' && isRecord(candidate.input) && candidate.input.schemaVersion !== undefined) parseTeamReviewInput(candidate.input);
    if (candidate.kind === 'team_plan_revision' && isRecord(candidate.input) && candidate.input.impact !== undefined) {
      const impact = parseWorkflowRevisionImpact(candidate.input.impact);
      const sourceTaskIds = candidate.input.sourceTaskIds;
      if (impact.basePlanVersion >= Number(run.planVersion) || !Array.isArray(sourceTaskIds)
        || !sourceTaskIds.includes(impact.targetTaskId)
        || impact.affectedTaskIds.some((id) => !tasks.some((task) => isRecord(task) && task.id === id && task.runId === run.id))) throw new Error('修订影响范围归属无效');
    }
    if (candidate.kind === 'team_review' && isRecord(candidate.output) && candidate.output.schemaVersion !== undefined) {
      const review = parseWorkflowReviewRecord(candidate.output);
      if (review.runId !== run.id || review.taskId !== candidate.id || review.attempt !== candidate.attempt
        || review.planVersion > Number(run.planVersion) || candidate.status !== 'completed') throw new Error('验收记录归属无效');
    }
    if (candidate.unstartedModelAttempts !== undefined && (!isWorkflowModelTask(candidate.kind)
      || !Number.isSafeInteger(candidate.unstartedModelAttempts) || Number(candidate.unstartedModelAttempts) < 0
      || Number(candidate.unstartedModelAttempts) > Number(candidate.attempt))) throw new Error('工作流未调用次数无效');
    if (candidate.modelInvocation !== undefined) {
      const invocation = parseWorkflowModelInvocation(candidate.modelInvocation);
      if (!isWorkflowModelTask(candidate.kind) || invocation.runId !== candidate.runId || invocation.taskId !== candidate.id
        || invocation.attempt !== candidate.attempt) throw new Error('工作流调用关联无效');
    }
    if (candidate.toolInvocation !== undefined) {
      const invocation = parseWorkflowToolInvocation(candidate.toolInvocation);
      if (invocation.kind !== candidate.kind || invocation.runId !== candidate.runId || invocation.taskId !== candidate.id
        || invocation.attempt !== candidate.attempt || invocation.planVersion > Number(run.planVersion)) throw new Error('工作流工具调用关联无效');
    }
    const dependencies = candidate.dependsOn;
    if (candidate.expansion !== undefined && (!isRecord(candidate.expansion)
      || !Array.isArray(candidate.expansion.taskIds) || !candidate.expansion.taskIds.length
      || candidate.expansion.taskIds.length > 48 || candidate.expansion.taskIds.some((id) => typeof id !== 'string' || !id || id === candidate.id)
      || new Set(candidate.expansion.taskIds).size !== candidate.expansion.taskIds.length
      || candidate.expansion.taskIds.some((id) => !dependencies.includes(id)))) throw new Error('工作流子任务展开记录无效');
    if (!Number.isFinite(candidate.updatedAt)) throw new Error('工作流任务更新时间无效');
    for (const field of ['externalTaskId', 'error'] as const) {
      if (candidate[field] !== undefined && typeof candidate[field] !== 'string') throw new Error(`工作流任务${field}无效`);
    }
  }
  assertTaskGraph(value.tasks as WorkflowTask[]);
}

function migrateWorkflowSnapshot(value: unknown): WorkflowSnapshot {
  assertWorkflowSnapshot(value);
  if (value.schemaVersion === 1 && value.run.schemaVersion === 1 && value.tasks.every((task) => task.schemaVersion === 1)) return value;
  return { ...value, schemaVersion: 1, run: { ...value.run, schemaVersion: 1 },
    tasks: value.tasks.map((task) => task.schemaVersion === 1 ? task : { ...task, schemaVersion: 1 }) };
}

export interface WorkflowResumeSummary {
  completed: string[];
  waiting: string[];
  blocked: Array<{ taskId: string; reason: string }>;
  runnable: string[];
}

export function summarizeWorkflowRun(snapshot: WorkflowSnapshot): WorkflowResumeSummary {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const result: WorkflowResumeSummary = { completed: [], waiting: [], blocked: [], runnable: [] };
  for (const task of snapshot.tasks) {
    if (task.status === 'abandoned') continue;
    if (task.status === 'completed') {
      result.completed.push(task.id);
      continue;
    }
    if (task.status === 'failed' || task.status === 'result_unknown' || task.status === 'waiting_user' || task.status === 'cancelled') {
      result.blocked.push({ taskId: task.id, reason: task.error || task.status });
      continue;
    }
    if (task.dependsOn.some((id) => {
      const dependency = byId.get(id);
      return dependency?.status === 'failed' || dependency?.status === 'result_unknown' || dependency?.status === 'cancelled';
    })) {
      result.blocked.push({ taskId: task.id, reason: '前置任务未完成且需要处理' });
      continue;
    }
    if (task.status === 'waiting_external' || task.status === 'running' || task.dependsOn.some((id) => byId.get(id)?.status !== 'completed')) {
      result.waiting.push(task.id);
      continue;
    }
    result.runnable.push(task.id);
  }
  return result;
}

export function isRetryableTeamTask(task: WorkflowTask): boolean {
  return task.status === 'failed' && ['team_plan', 'team_plan_revision', 'agent_delegation', 'agent_text',
    'agent_image_inspection', 'agent_video_inspection', 'agent_web_search'].includes(task.kind);
}

export function countWorkflowModelCalls(snapshot: WorkflowSnapshot): number {
  return snapshot.tasks.filter((task) => isWorkflowModelTask(task.kind))
    .reduce((total, task) => total + task.attempt - (task.unstartedModelAttempts || 0), 0);
}

function finishModelInvocation(task: WorkflowTask, state: 'succeeded' | 'failed' | 'result_unknown', now: number): WorkflowTask {
  const invocation = task.modelInvocation;
  if (!invocation || (invocation.state !== 'reserved' && invocation.state !== 'started')) return task;
  const notStarted = invocation.state === 'reserved';
  return { ...task,
    unstartedModelAttempts: (task.unstartedModelAttempts || 0) + (notStarted ? 1 : 0),
    modelInvocation: { ...invocation, state: notStarted ? 'not_started' : state, finishedAt: Math.max(now, invocation.startedAt ?? invocation.reservedAt) },
  };
}

export function invocationUnstarted(task: WorkflowTask) {
  return task.modelInvocation?.state === 'reserved' || task.toolInvocation?.state === 'reserved';
}

function finishInvocation(task: WorkflowTask, state: 'succeeded' | 'failed' | 'result_unknown', now: number, externalTaskId?: string, reconciled = false): WorkflowTask {
  const next = finishModelInvocation(task, state, now);
  const invocation = task.toolInvocation;
  if (!invocation || invocation.state === 'not_started' || invocation.state === 'rejected' || (!reconciled && !['reserved', 'started', 'waiting_external'].includes(invocation.state))) return next;
  const waiting = invocation.state !== 'reserved' && state === 'succeeded' && Boolean(externalTaskId);
  const { finishedAt: previousFinishedAt, ...activeInvocation } = invocation;
  void previousFinishedAt;
  return { ...next, toolInvocation: { ...activeInvocation,
    state: invocation.state === 'reserved' ? 'not_started' : waiting ? 'waiting_external' : state,
    ...(externalTaskId ? { externalTaskId } : {}),
    ...(!waiting ? { finishedAt: Math.max(now, invocation.startedAt ?? invocation.reservedAt) } : {}) } };
}

export function reconcileWorkflowTaskInvocation(task: WorkflowTask): WorkflowTask {
  if (task.status === 'waiting_external') return finishInvocation(task, 'succeeded', task.updatedAt, task.externalTaskId, true);
  if (task.status === 'completed') return finishInvocation(task, 'succeeded', task.updatedAt, undefined, true);
  if (task.status === 'failed') return finishInvocation(task, 'failed', task.updatedAt, undefined, true);
  if (task.status === 'queued' || task.status === 'result_unknown') return finishInvocation(task, 'result_unknown', task.updatedAt, undefined, true);
  return task;
}

export function rejectWorkflowTaskAdmission(task: WorkflowTask, reason: string): WorkflowTask {
  const finished = finishInvocation(task, 'failed', Date.now());
  return { ...finished, status: 'queued', error: reason, updatedAt: Date.now(),
    ...(finished.modelInvocation?.state === 'failed' ? { modelInvocation: { ...finished.modelInvocation, state: 'rejected' as const } } : {}),
    ...(finished.toolInvocation?.state === 'failed' ? { toolInvocation: { ...finished.toolInvocation, state: 'rejected' as const } } : {}) };
}

export interface WorkflowTaskResult {
  output?: unknown;
  waitingForUser?: true;
  externalTaskId?: string;
  spawn?: { tasks: WorkflowTask[]; context: unknown };
}

export interface WorkflowExecutor {
  tracksModelInvocations?: boolean;
  tracksToolInvocations?: boolean;
  dispatchBlockReason?(snapshot: WorkflowSnapshot): string | undefined;
  approvalRequirement?(task: WorkflowTask, snapshot: WorkflowSnapshot): WorkflowApprovalRequirement | undefined;
  execute(task: WorkflowTask, signal: AbortSignal, context: WorkflowExecutionContext): Promise<WorkflowTaskResult>;
  inspectExternal?(task: WorkflowTask, signal: AbortSignal): Promise<{ status: 'pending' | 'completed' | 'failed'; output?: unknown; error?: string }>;
  reconcileInterrupted?(task: WorkflowTask): Promise<{ status: 'queued' | 'waiting_external' | 'completed' | 'failed'; externalTaskId?: string; output?: unknown; error?: string; admissionRejected?: true } | null>;
}

export interface WorkflowExecutionContext {
  beginModelInvocation(request?: WorkflowModelRequest): Promise<void | WorkflowUsageReference>;
  usageReference?: WorkflowUsageReference;
  beginToolInvocation(request?: WorkflowToolRequest): Promise<void>;
}

export class WorkflowPreflightError extends Error {
  readonly capability?: WorkflowCapabilityRequirement;

  constructor(message: string, capability?: WorkflowCapabilityRequirement) {
    super(message);
    this.name = 'WorkflowPreflightError';
    this.capability = capability;
  }
}

export interface WorkflowRepository {
  listPlanRevisions(scope: string, runId: string): Promise<WorkflowPlanRevision[]>;
  listTaskAttempts(scope: string, runId: string, taskId: string): Promise<WorkflowTaskAttempt[]>;
  read(scope: string, runId: string): Promise<WorkflowSnapshot | null>;
  list(scope: string): Promise<WorkflowSnapshot[]>;
  listEvents(scope: string, runId: string, afterSequence?: number): Promise<WorkflowEvent[]>;
  registerOutboxConsumer(scope: string, runId: string, consumerId: string): Promise<void>;
  listOutboxEvents(scope: string, runId: string, consumerId: string, limit?: number): Promise<WorkflowEvent[]>;
  acknowledgeOutboxEvents(scope: string, runId: string, consumerId: string, throughSequence: number): Promise<void>;
  transact<T>(scope: string, runId: string, update: (current: WorkflowSnapshot | null) => { snapshot: WorkflowSnapshot; value: T }): Promise<T>;
}

const DB_NAME = 'pneumata-workflow-runs';
const STORE = 'runs';
const EVENT_STORE = 'events';
const OUTBOX_STORE = 'outbox';
const CONSUMER_STORE = 'outbox_consumers';
const ATTEMPT_STORE = 'task_attempts';
const REVISION_STORE = 'plan_revisions';
const EVENT_RETENTION_PER_RUN = 256;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('此设备不支持工作流持久化'));
  if (dbPromise) return dbPromise;
  const pending: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 5);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      if (!database.objectStoreNames.contains(EVENT_STORE)) database.createObjectStore(EVENT_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) database.createObjectStore(OUTBOX_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(CONSUMER_STORE)) database.createObjectStore(CONSUMER_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(ATTEMPT_STORE)) database.createObjectStore(ATTEMPT_STORE);
      if (!database.objectStoreNames.contains(REVISION_STORE)) database.createObjectStore(REVISION_STORE);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); dbPromise = null; };
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error('打开工作流存储失败'));
    request.onblocked = () => reject(new Error('工作流存储被其他页面阻塞'));
  });
  dbPromise = pending.catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function rowKey(scope: string, runId: string) {
  return `${scope}\n${runId}`;
}

function eventPrefix(scope: string, runId: string) {
  return rowKey(scope, runId) + String.fromCharCode(10);
}

function eventKey(scope: string, runId: string, sequence: number) {
  return eventPrefix(scope, runId) + String(sequence).padStart(16, '0');
}

function consumerKey(scope: string, runId: string, consumerId: string) {
  return `${rowKey(scope, runId)}\n${consumerId}`;
}

function changedTaskStates(current: WorkflowSnapshot | null, next: WorkflowSnapshot) {
  const before = new Map((current?.tasks || []).map((task) => [task.id, task]));
  const after = new Map(next.tasks.map((task) => [task.id, task]));
  const changed: WorkflowEvent['changedTasks'] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(id);
    const task = after.get(id);
    if (previous?.status === task?.status && previous?.attempt === task?.attempt
      && JSON.stringify(previous?.modelInvocation) === JSON.stringify(task?.modelInvocation)
      && JSON.stringify(previous?.toolInvocation) === JSON.stringify(task?.toolInvocation)) continue;
    changed.push({ id, status: task?.status || 'removed', attempt: task?.attempt || previous?.attempt || 0 });
  }
  return changed.sort((left, right) => left.id.localeCompare(right.id));
}

function hasWorkflowStateChange(current: WorkflowSnapshot | null, next: WorkflowSnapshot, changedTasks: WorkflowEvent['changedTasks']) {
  if (!current || changedTasks.length > 0) return true;
  return current.run.status !== next.run.status
    || current.run.generation !== next.run.generation
    || current.run.planVersion !== next.run.planVersion
    || current.run.deliveryStatus !== next.run.deliveryStatus
    || current.run.deliveryIssue !== next.run.deliveryIssue
    || JSON.stringify(current.run.delivery) !== JSON.stringify(next.run.delivery)
    || JSON.stringify(current.run.deliveryCopy) !== JSON.stringify(next.run.deliveryCopy)
    || JSON.stringify(current.run.decisions) !== JSON.stringify(next.run.decisions)
    || current.run.pauseRequested !== next.run.pauseRequested
    || current.run.pauseReason !== next.run.pauseReason
    || current.run.planOpen !== next.run.planOpen;
}

export function workflowRunLockName(scope: string, runId: string) {
  return `pneumata-workflow-${rowKey(scope, runId)}`;
}

export function currentWorkflowScope() {
  return scopedStorageKey(`workflow-runs-${getLocalDataUserId()}`);
}

export const indexedDbWorkflowRepository: WorkflowRepository = {
  async listPlanRevisions(scope, runId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REVISION_STORE, 'readonly');
      const prefix = `${rowKey(scope, runId)}\n`;
      const request = tx.objectStore(REVISION_STORE).getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      request.onsuccess = () => {
        try { resolve(request.result.map(parseWorkflowPlanRevision)); } catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error || new Error('读取计划修订历史失败'));
      tx.onabort = () => reject(tx.error || new Error('读取计划修订历史中止'));
    });
  },
  async listTaskAttempts(scope, runId, taskId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ATTEMPT_STORE, 'readonly');
      const prefix = `${rowKey(scope, runId)}\n${JSON.stringify(taskId)}\n`;
      const request = tx.objectStore(ATTEMPT_STORE).getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      request.onsuccess = () => {
        try { resolve(request.result.map(parseWorkflowTaskAttempt)); } catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error || new Error('读取任务执行历史失败'));
      tx.onabort = () => reject(tx.error || new Error('读取任务执行历史中止'));
    });
  },
  async read(scope, runId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(rowKey(scope, runId));
      request.onsuccess = () => {
        const snapshot: unknown = request.result;
        if (snapshot === undefined) resolve(null);
        else {
          try {
            resolve(migrateWorkflowSnapshot(snapshot));
          } catch (error) {
            reject(error);
          }
        }
      };
      request.onerror = () => reject(request.error || new Error('读取工作流失败'));
    });
  },
  async list(scope) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const prefix = `${scope}\n`;
      const request = tx.objectStore(STORE).openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      const rows: WorkflowSnapshot[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(rows);
          return;
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          try {
            rows.push(migrateWorkflowSnapshot(cursor.value));
          } catch (error) {
            reject(error);
            return;
          }
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('列出工作流失败'));
    });
  },
  async listEvents(scope, runId, afterSequence = 0) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('工作流事件游标无效');
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EVENT_STORE, 'readonly');
      const prefix = eventPrefix(scope, runId);
      const lowerBound = eventKey(scope, runId, afterSequence + 1);
      const request = tx.objectStore(EVENT_STORE).openCursor(IDBKeyRange.bound(lowerBound, prefix + String.fromCharCode(65535)));
      const events: WorkflowEvent[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(events);
          return;
        }
        const value: unknown = cursor.value;
        if (isRecord(value) && value.runId === runId && Number.isSafeInteger(value.sequence)
          && typeof value.occurredAt === 'number' && RUN_STATUSES.has(value.runStatus as WorkflowRun['status'])
          && Array.isArray(value.changedTasks)) {
          const changedTasks = value.changedTasks.flatMap((candidate): WorkflowEvent['changedTasks'] => {
            if (!isRecord(candidate) || typeof candidate.id !== 'string' || !Number.isSafeInteger(candidate.attempt)) return [];
            if (candidate.status !== 'removed' && !TASK_STATUSES.has(candidate.status as WorkflowTaskStatus)) return [];
            return [{ id: candidate.id, status: candidate.status as WorkflowTaskStatus | 'removed', attempt: candidate.attempt as number }];
          });
          events.push({
            eventId: typeof value.eventId === 'string' ? value.eventId : `${runId}:${String(value.sequence)}`,
            aggregateVersion: Number.isSafeInteger(value.aggregateVersion) ? value.aggregateVersion as number : value.sequence as number,
            sequence: value.sequence as number,
            runId,
            occurredAt: value.occurredAt,
            runStatus: value.runStatus as WorkflowRun['status'],
            generation: Number(value.generation),
            planVersion: Number(value.planVersion),
            changedTasks,
          });
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('读取工作流事件失败'));
    });
  },
  async registerOutboxConsumer(scope, runId, consumerId) {
    assertNonEmptyString(consumerId, 'outbox 消费者 ID');
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, CONSUMER_STORE], 'readwrite');
      const runRequest = tx.objectStore(STORE).get(rowKey(scope, runId));
      runRequest.onsuccess = () => {
        if (runRequest.result === undefined) { tx.abort(); reject(new Error('工作流不存在')); return; }
        const key = consumerKey(scope, runId, consumerId);
        const consumerStore = tx.objectStore(CONSUMER_STORE);
        const currentRequest = consumerStore.get(key);
        currentRequest.onsuccess = () => {
          if (currentRequest.result === undefined) consumerStore.put({ key, scope, runId, consumerId, acknowledgedThrough: 0 });
        };
        currentRequest.onerror = () => { tx.abort(); reject(currentRequest.error || new Error('读取 outbox 消费回执失败')); };
      };
      runRequest.onerror = () => { tx.abort(); reject(runRequest.error || new Error('读取工作流失败')); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('注册 outbox 消费者失败'));
      tx.onabort = () => reject(tx.error || new Error('注册 outbox 消费者事务中止'));
    });
  },
  async listOutboxEvents(scope, runId, consumerId, limit = 100) {
    assertNonEmptyString(consumerId, 'outbox 消费者 ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('outbox 批量大小无效');
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([OUTBOX_STORE, CONSUMER_STORE], 'readonly');
      const consumerRequest = tx.objectStore(CONSUMER_STORE).get(consumerKey(scope, runId, consumerId));
      consumerRequest.onsuccess = () => {
        const consumer = consumerRequest.result;
        if (!consumer) { reject(new Error('outbox 消费者尚未注册')); return; }
        const prefix = eventPrefix(scope, runId);
        const lowerBound = eventKey(scope, runId, consumer.acknowledgedThrough + 1);
        const request = tx.objectStore(OUTBOX_STORE).openCursor(IDBKeyRange.bound(lowerBound, prefix + String.fromCharCode(65535)));
        const events: WorkflowEvent[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || events.length >= limit) { resolve(events); return; }
          const { key, ...event } = cursor.value;
          void key;
          events.push(event as WorkflowEvent);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('读取工作流 outbox 失败'));
      };
      consumerRequest.onerror = () => reject(consumerRequest.error || new Error('读取 outbox 消费回执失败'));
    });
  },
  async acknowledgeOutboxEvents(scope, runId, consumerId, throughSequence) {
    assertNonEmptyString(consumerId, 'outbox 消费者 ID');
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) throw new Error('outbox 回执序号无效');
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([OUTBOX_STORE, CONSUMER_STORE], 'readwrite');
      const consumerStore = tx.objectStore(CONSUMER_STORE);
      const key = consumerKey(scope, runId, consumerId);
      const request = consumerStore.get(key);
      request.onsuccess = () => {
        const consumer = request.result;
        if (!consumer) { tx.abort(); reject(new Error('outbox 消费者尚未注册')); return; }
        if (throughSequence <= consumer.acknowledgedThrough) return;
        const eventRequest = tx.objectStore(OUTBOX_STORE).get(eventKey(scope, runId, throughSequence));
        eventRequest.onsuccess = () => {
          if (!eventRequest.result) { tx.abort(); reject(new Error('不能确认尚未写入的 outbox 事件')); return; }
          consumerStore.put({ ...consumer, acknowledgedThrough: throughSequence, updatedAt: Date.now() });
        };
        eventRequest.onerror = () => { tx.abort(); reject(eventRequest.error || new Error('核对 outbox 事件失败')); };
      };
      request.onerror = () => { tx.abort(); reject(request.error || new Error('读取 outbox 消费回执失败')); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('保存 outbox 回执失败'));
      tx.onabort = () => reject(tx.error || new Error('保存 outbox 回执事务中止'));
    });
  },
  async transact(scope, runId, update) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, EVENT_STORE, OUTBOX_STORE, ATTEMPT_STORE, REVISION_STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(rowKey(scope, runId));
      let value: unknown;
      request.onsuccess = () => {
        try {
          const current: unknown = request.result;
          const migratedCurrent = current === undefined ? null : migrateWorkflowSnapshot(current);
          const next = update(migratedCurrent === null ? null : structuredClone(migratedCurrent));
          const migratedNext = migrateWorkflowSnapshot(next.snapshot);
          assertWorkflowApprovalTransition(migratedCurrent, migratedNext);
          for (const task of migratedCurrent?.tasks ?? []) {
            if (task.kind === 'team_plan_revision' && isRecord(task.input) && task.input.impact !== undefined) {
              const nextTask = migratedNext.tasks.find((item) => item.id === task.id);
              if (!nextTask || JSON.stringify(nextTask.input) !== JSON.stringify(task.input)) throw new Error('已保存的定向修订不可修改');
            }
            const nextTask = migratedNext.tasks.find((item) => item.id === task.id);
            if (task.attempt > 0 && task.status !== 'completed' && (!nextTask || nextTask.kind !== task.kind
              || JSON.stringify(nextTask.input) !== JSON.stringify(task.input))) {
              throw new Error('已开始的任务定义不可修改，请追加新任务进行修订');
            }
            if (task.userResponse && JSON.stringify(task.userResponse) !== JSON.stringify(nextTask?.userResponse)) throw new Error('已保存的用户答复不可修改');
            if (task.kind === 'team_review' && isRecord(task.input) && task.input.schemaVersion === 2
              && (!nextTask || nextTask.kind !== task.kind || JSON.stringify(nextTask.input) !== JSON.stringify(task.input)
                || JSON.stringify(nextTask.dependsOn) !== JSON.stringify(task.dependsOn))) throw new Error('已保存的分批审核范围不可修改');
            if (task.kind === 'team_review' && isRecord(task.output) && task.output.schemaVersion !== undefined
              && (!nextTask || nextTask.attempt !== task.attempt || JSON.stringify(nextTask.output) !== JSON.stringify(task.output))) throw new Error('已保存的验收记录不可修改');
            if (task.status === 'completed') {
              const evidence = (item: WorkflowTask) => ({ id: item.id, runId: item.runId, kind: item.kind,
                status: item.status, attempt: item.attempt, input: item.input, output: item.output,
                dependsOn: item.dependsOn, expansion: item.expansion, externalTaskId: item.externalTaskId });
              if (!nextTask || JSON.stringify(evidence(nextTask)) !== JSON.stringify(evidence(task))) {
                throw new Error('已完成的任务记录不可修改，请追加新任务进行修订');
              }
            }
          }
          if (migratedCurrent && JSON.stringify(migratedCurrent.run.goalSpec) !== JSON.stringify(migratedNext.run.goalSpec)) {
            const before = migratedCurrent.run;
            const after = migratedNext.run;
            const executionLimitsOnly = before.goalSpec && after.goalSpec
              && JSON.stringify(parseWorkflowGoalSpec({ ...before.goalSpec, deadlineAt: undefined, platformBudget: undefined }))
                === JSON.stringify(parseWorkflowGoalSpec({ ...after.goalSpec, deadlineAt: undefined, platformBudget: undefined }))
              && (!before.goalSpec.platformBudget || Boolean(after.goalSpec.platformBudget
                && after.goalSpec.platformBudget.billingUnit === before.goalSpec.platformBudget.billingUnit
                && after.goalSpec.platformBudget.revision >= before.goalSpec.platformBudget.revision
                && (after.goalSpec.platformBudget.revision !== before.goalSpec.platformBudget.revision
                  || JSON.stringify(after.goalSpec.platformBudget) === JSON.stringify(before.goalSpec.platformBudget))));
            if (!executionLimitsOnly || before.status !== 'paused' || after.status !== 'paused'
              || after.planVersion !== before.planVersion + 1 || migratedCurrent.tasks.some((task) => task.status === 'running')) {
              throw new Error('目标契约不能在执行中替换，请新建任务以变更目标授权');
            }
          }
          const previousDelivery = migratedCurrent?.run.delivery;
          for (const task of migratedNext.tasks.filter((item) => item.userResponse)) {
            const before = migratedCurrent?.tasks.find((item) => item.id === task.id);
            if (!before?.userResponse && (!before || before.kind !== 'agent_user_input' || before.status !== 'waiting_user'
              || !migratedCurrent || !['paused', 'active'].includes(migratedCurrent.run.status) || task.status !== 'completed'
              || task.userResponse!.planVersion !== migratedCurrent.run.planVersion
              || migratedNext.run.planVersion !== migratedCurrent.run.planVersion + 1
              || workflowJsonDigest(before.input) !== workflowJsonDigest(task.input))) throw new Error('只能答复当前等待用户的步骤');
          }
          const previousCopy = migratedCurrent?.run.deliveryCopy;
          const nextCopy = migratedNext.run.deliveryCopy;
          if (previousCopy && (!nextCopy || nextCopy.planVersion < previousCopy.planVersion
            || (nextCopy.planVersion === previousCopy.planVersion && JSON.stringify(nextCopy) !== JSON.stringify(previousCopy)))) throw new Error('已准备的另存清单不可修改');
          if (JSON.stringify(previousCopy) !== JSON.stringify(nextCopy) && nextCopy) {
            if (!migratedCurrent || migratedCurrent.run.status !== 'completed' || migratedCurrent.run.deliveryStatus === 'published'
              || !['artifact_conflict', 'message_conflict'].includes(migratedCurrent.run.deliveryIssue || '')
              || migratedNext.run.status !== 'completed' || migratedNext.run.planVersion !== migratedCurrent.run.planVersion
              || !previousDelivery || JSON.stringify(migratedNext.run.delivery) !== JSON.stringify(previousDelivery)
              || JSON.stringify(nextCopy) !== JSON.stringify(copyWorkflowDelivery(previousDelivery, nextCopy.preparedAt, nextCopy.message.metadata?.branching))) throw new Error('只能为当前冲突交付另存副本');
          }
          assertWorkflowDecisionTransition(migratedCurrent?.run.decisions, migratedNext.run.decisions,
            JSON.stringify(previousCopy) !== JSON.stringify(nextCopy) && nextCopy && previousDelivery
              ? deliveryCopyDecision(previousDelivery, nextCopy, migratedCurrent!.run.deliveryIssue as WorkflowDecisionRecord['scope']['conflict']) : undefined);
          if (JSON.stringify(previousDelivery) !== JSON.stringify(migratedNext.run.delivery) && migratedNext.run.delivery
            && (migratedNext.run.status !== 'completed' || migratedNext.run.delivery.planVersion !== migratedNext.run.planVersion)) throw new Error('只能为当前已完成计划准备交付清单');
          if (previousDelivery && (!migratedNext.run.delivery || migratedNext.run.delivery.planVersion < previousDelivery.planVersion
            || (migratedNext.run.delivery.planVersion === previousDelivery.planVersion
              && JSON.stringify(previousDelivery) !== JSON.stringify(migratedNext.run.delivery)))) throw new Error('已准备的交付清单不可修改');
          const revision = appliedWorkflowPlanRevision(migratedCurrent, migratedNext);
          value = next.value;
          store.put(migratedNext, rowKey(scope, runId));
          if (revision) tx.objectStore(REVISION_STORE).add(revision,
            `${rowKey(scope, runId)}\n${String(revision.version).padStart(16, '0')}`);
          const changedTasks = changedTaskStates(migratedCurrent, migratedNext);
          const beforeTasks = new Map(migratedCurrent?.tasks.map((task) => [task.id, task]));
          const attempts = tx.objectStore(ATTEMPT_STORE);
          for (const task of migratedNext.tasks) {
            const before = beforeTasks.get(task.id);
            if (before?.attempt === task.attempt && before.modelInvocation?.request
              && JSON.stringify(before.modelInvocation.request) !== JSON.stringify(task.modelInvocation?.request)) throw new Error('已开始的模型请求摘要不可修改');
            if (before?.attempt === task.attempt && !before.modelInvocation?.request && task.modelInvocation?.request
              && (before.modelInvocation?.state !== 'reserved' || task.modelInvocation.state !== 'started')) throw new Error('不能补造历史模型请求摘要');
            if (before?.attempt === task.attempt && before.toolInvocation?.request
              && JSON.stringify(before.toolInvocation.request) !== JSON.stringify(task.toolInvocation?.request)) throw new Error('已开始的工具请求摘要不可修改');
            if (before?.attempt === task.attempt && !before.toolInvocation?.request && task.toolInvocation?.request
              && (before.toolInvocation?.state !== 'reserved' || task.toolInvocation.state !== 'started')) throw new Error('不能补造历史工具请求摘要');
            if (!task.attempt || !before) continue;
            const key = `${rowKey(scope, runId)}\n${JSON.stringify(task.id)}\n${String(task.attempt).padStart(16, '0')}`;
            if (task.status === 'running' && task.attempt === before.attempt + 1) {
              attempts.add(claimedTaskAttempt(migratedNext, task), key);
            } else if (task.attempt === before.attempt && (task.status !== before.status || task.externalTaskId !== before.externalTaskId
              || JSON.stringify(task.modelInvocation) !== JSON.stringify(before.modelInvocation)
              || JSON.stringify(task.toolInvocation) !== JSON.stringify(before.toolInvocation))) {
              const attemptRequest = attempts.get(key);
              attemptRequest.onsuccess = () => {
                if (attemptRequest.result === undefined) return;
                try { attempts.put(settleTaskAttempt(parseWorkflowTaskAttempt(attemptRequest.result), task), key); }
                catch (error) { tx.abort(); reject(error); }
              };
            }
          }
          if (!hasWorkflowStateChange(migratedCurrent, migratedNext, changedTasks)) return;
          const prefix = eventPrefix(scope, runId);
          const eventStore = tx.objectStore(EVENT_STORE);
          const range = IDBKeyRange.bound(prefix, prefix + String.fromCharCode(65535));
          const lastEventRequest = eventStore.openCursor(range, 'prev');
          lastEventRequest.onsuccess = () => {
            try {
              const key = lastEventRequest.result?.key;
              const previousSequence = typeof key === 'string' ? Number(key.slice(prefix.length)) || 0 : 0;
              const sequence = previousSequence + 1;
              const event: WorkflowEvent & { key: string } = {
                key: eventKey(scope, runId, sequence),
                eventId: `${runId}:${sequence}`,
                aggregateVersion: sequence,
                sequence,
                runId,
                occurredAt: migratedNext.run.updatedAt,
                runStatus: migratedNext.run.status,
                generation: migratedNext.run.generation,
                planVersion: migratedNext.run.planVersion,
                changedTasks,
              };
              eventStore.put(event);
              tx.objectStore(OUTBOX_STORE).put(event);
              const oldestRetainedSequence = sequence - EVENT_RETENTION_PER_RUN;
              if (oldestRetainedSequence > 0) {
                const pruneRange = IDBKeyRange.bound(prefix, eventKey(scope, runId, oldestRetainedSequence));
                const pruneRequest = eventStore.openCursor(pruneRange);
                pruneRequest.onsuccess = () => pruneRequest.result?.delete();
                pruneRequest.onerror = () => {
                  tx.abort();
                  reject(pruneRequest.error || new Error('清理工作流事件失败'));
                };
              }
            } catch (error) {
              tx.abort();
              reject(error);
            }
          };
          lastEventRequest.onerror = () => {
            tx.abort();
            reject(lastEventRequest.error || new Error('写入工作流事件失败'));
          };
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => resolve(value as Awaited<ReturnType<typeof update>>['value']);
      tx.onerror = () => reject(tx.error || new Error('保存工作流失败'));
      tx.onabort = () => reject(tx.error || new Error('工作流事务中止'));
    });
  },
};

function assertTaskGraph(tasks: WorkflowTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('工作流任务 ID 重复');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('工作流任务依赖形成环');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error('工作流任务依赖不存在');
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
}

export function createWorkflowRunRuntime(repository: WorkflowRepository, executor: WorkflowExecutor, scope: () => string = currentWorkflowScope, maxConcurrentTasks = 3) {
  const active = new Map<string, Promise<WorkflowSnapshot>>();
  const mutate = <T>(storageScope: string, runId: string, update: (snapshot: WorkflowSnapshot) => { snapshot: WorkflowSnapshot; value: T }) =>
    repository.transact(storageScope, runId, (current) => {
      if (!current) throw new Error('工作流不存在');
      const next = update(current);
      assertWorkflowSnapshot(next.snapshot);
      return next;
    });

  async function create(snapshot: WorkflowSnapshot) {
    const versionedSnapshot = migrateWorkflowSnapshot(snapshot);
    return repository.transact(scope(), snapshot.run.id, (current) => {
      if (current) throw new Error('工作流已经存在');
      return { snapshot: versionedSnapshot, value: versionedSnapshot };
    });
  }

  async function setModelCallLimit(runId: string, expectedPlanVersion: number, maxModelCalls?: number) {
    if (maxModelCalls !== undefined && (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 1000)) throw new Error('模型调用上限应为 1 到 1000 的整数');
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'paused') throw new Error('请先暂停整个任务');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (maxModelCalls !== undefined && maxModelCalls <= countWorkflowModelCalls(current)) throw new Error('新上限必须大于已使用的模型调用次数');
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run, maxModelCalls, planVersion: current.run.planVersion + 1, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function setDeadline(runId: string, expectedPlanVersion: number, deadlineAt?: number) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'paused' || current.tasks.some((task) => task.status === 'running')) throw new Error('请先暂停整个任务');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (!current.run.goalSpec) throw new Error('旧任务没有目标契约，请新建任务设置截止时间');
      const goalSpec = parseWorkflowGoalSpec({ ...current.run.goalSpec, deadlineAt });
      if (workflowDeadlineBlockReason(goalSpec)) throw new Error('新的截止时间必须晚于当前时间');
      const next: WorkflowSnapshot = { ...current, run: { ...current.run, goalSpec,
        planVersion: current.run.planVersion + 1, updatedAt: Date.now() } };
      return { snapshot: next, value: next };
    });
  }

  async function bindPlatformBudget(runId: string, expectedPlanVersion: number, budget: NonNullable<WorkflowGoalSpec['platformBudget']>) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'paused' || current.tasks.some((task) => task.status === 'running')) throw new Error('请先暂停整个任务');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (!current.run.goalSpec) throw new Error('旧任务没有目标契约，请新建任务设置预算');
      const goalSpec = parseWorkflowGoalSpec({ ...current.run.goalSpec, platformBudget: budget });
      const next: WorkflowSnapshot = { ...current, run: { ...current.run, goalSpec,
        planVersion: current.run.planVersion + 1, updatedAt: Date.now() } };
      return { snapshot: next, value: next };
    });
  }

  async function addTasks(runId: string, expectedPlanVersion: number, additions: WorkflowTask[]) {
    if (!additions.length) throw new Error('工作流计划修订不能为空');
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'active' && current.run.status !== 'paused') throw new Error('工作流已结束，不能追加任务');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (additions.some((task) => task.runId !== runId || task.status !== 'queued' && task.status !== 'waiting_dependency' || task.attempt !== 0)) {
        throw new Error('新任务的归属或初始状态无效');
      }
      const tasks = [...current.tasks, ...additions];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = {
        ...current,
        run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: Date.now() },
        tasks,
      };
      return { snapshot, value: snapshot };
    });
  }

  async function replaceUserBlockWithTasks(runId: string, expectedPlanVersion: number, additions: WorkflowTask[]) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'paused' || current.run.planVersion !== expectedPlanVersion) throw new Error('团队计划已更新，请刷新后重试');
      const block = current.tasks.find((task) => task.id === 'review_needs_user' && task.status === 'waiting_user');
      if (!block || additions.length !== 1) throw new Error('当前没有可处理的验收阻塞');
      const tasks = [...current.tasks.filter((task) => task.id !== block.id), ...additions];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current,
        run: { ...current.run, autoReview: false, planVersion: current.run.planVersion + 1, updatedAt: Date.now() }, tasks };
      return { snapshot, value: snapshot };
    });
  }

  async function addTeamRevision(runId: string, expectedPlanVersion: number, task: WorkflowTask) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      const completed = current.run.status === 'completed' && !current.run.planOpen && current.tasks.every((item) => item.status === 'completed' || item.status === 'abandoned');
      if (!completed && current.run.status !== 'paused') throw new Error('请先暂停整个团队任务');
      if (task.runId !== runId || task.kind !== 'team_plan_revision' || task.attempt !== 0 || task.status !== 'waiting_dependency') throw new Error('追加任务状态无效');
      const tasks = [...current.tasks, task];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, tasks,
        run: { ...current.run, status: 'paused', planOpen: true, autoReview: false,
          planVersion: current.run.planVersion + 1, generation: completed ? current.run.generation + 1 : current.run.generation, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function answerUserInput(runId: string, taskId: string, expectedPlanVersion: number, answer: string) {
    const output = answer.trim();
    if (!output || output.length > 4000) throw new Error('答复应为 1 到 4000 个字符');
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('团队计划已更新，请刷新后重试');
      if (!['paused', 'active'].includes(current.run.status) || current.tasks.some((task) => task.status === 'running')) throw new Error('请等待当前步骤结束后答复');
      const task = current.tasks.find((item) => item.id === taskId);
      if (!task || task.kind !== 'agent_user_input' || task.status !== 'waiting_user'
        || task.userResponse || task.dependsOn.some((id) => current.tasks.find((item) => item.id === id)?.status !== 'completed')) throw new Error('该步骤没有等待用户答复');
      const now = Date.now();
      const next: WorkflowSnapshot = { ...current,
        run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: now },
        tasks: current.tasks.map((item) => item.id !== taskId ? item : { ...item, status: 'completed', output,
          userResponse: createWorkflowUserResponse(task, expectedPlanVersion, output, now), updatedAt: now }) };
      return { snapshot: next, value: next };
    });
  }

  async function decideApproval(runId: string, taskId: string, expectedPlanVersion: number, outcome: 'approved' | 'rejected') {
    if (outcome !== 'approved' && outcome !== 'rejected') throw new Error('审批决定无效');
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('团队计划已更新，请刷新后重试');
      if (!['paused', 'active'].includes(current.run.status) || current.tasks.some((task) => task.status === 'running')) throw new Error('请等待当前步骤结束后审批');
      const task = current.tasks.find((item) => item.id === taskId);
      const pending = task && pendingWorkflowApproval(task);
      if (!task || task.status !== 'waiting_user' || !pending) throw new Error('该步骤没有等待审批');
      const now = Math.max(Date.now(), pending.proposedAt);
      const requirement = outcome === 'approved' ? executor.approvalRequirement?.(task, current) : undefined;
      if (requirement && requirement.executionSha256 !== pending.executionSha256) {
        const next: WorkflowSnapshot = { ...current,
          run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: now },
          tasks: current.tasks.map((item) => item.id !== taskId ? item : { ...item, updatedAt: now,
            approvals: [...item.approvals!.slice(0, -1), { ...pending, invalidatedAt: now },
              proposeWorkflowApproval(current, task, requirement)] }) };
        return { snapshot: next, value: next };
      }
      const next: WorkflowSnapshot = { ...current,
        run: { ...current.run, planVersion: current.run.planVersion + 1,
          ...(outcome === 'rejected' ? { status: 'cancelled' as const, generation: current.run.generation + 1, pauseReason: '你已拒绝执行，任务组已停止' } : {}), updatedAt: now },
        tasks: current.tasks.map((item) => item.id !== taskId ? item : { ...item, status: outcome === 'approved' ? 'queued' : 'cancelled',
          error: outcome === 'approved' ? undefined : '你已拒绝执行', updatedAt: now,
          approvals: item.approvals!.map((approval) => approval !== pending ? approval : { ...approval,
            decision: { actor: 'local_user', outcome, planVersion: expectedPlanVersion, decidedAt: now } }) }) };
      return { snapshot: next, value: next };
    });
  }

  async function blockForUser(runId: string, expectedPlanVersion: number, block: WorkflowTask) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion || current.run.status !== 'active') throw new Error('工作流计划版本冲突');
      if (current.tasks.some((task) => task.id === block.id) || block.runId !== runId || block.status !== 'waiting_user') throw new Error('验收阻塞状态无效');
      const tasks = [...current.tasks, block];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, tasks,
        run: { ...current.run, status: 'paused', planVersion: current.run.planVersion + 1, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function abandonUnknownReview(runId: string, expectedPlanVersion: number, reviewId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'paused' || current.run.planVersion !== expectedPlanVersion) throw new Error('团队计划已更新，请刷新后重试');
      const target = current.tasks.find((task) => task.id === reviewId && task.kind === 'team_review' && task.status === 'result_unknown');
      if (!target || current.tasks.some((task) => task.id === 'review_needs_user')) throw new Error('当前没有可放弃的待核对验收');
      const now = Date.now();
      const reviews = new Map(current.tasks.filter((task) => task.kind === 'team_review').map((task) => [task.id, task]));
      const neighbors = new Map<string, string[]>();
      for (const task of reviews.values()) for (const id of task.dependsOn) {
        if (!reviews.has(id)) continue;
        neighbors.set(task.id, [...(neighbors.get(task.id) || []), id]);
        neighbors.set(id, [...(neighbors.get(id) || []), task.id]);
      }
      // Abandon the unfinished review tree together, so aggregates cannot wait forever on an unknown batch.
      const reviewIds = new Set([reviewId]);
      for (const id of reviewIds) for (const neighbor of neighbors.get(id) || []) reviewIds.add(neighbor);
      const block: WorkflowTask = { id: 'review_needs_user', runId, kind: 'team_review_block', input: null,
        dependsOn: [], status: 'waiting_user', error: '上次主 Agent 验收结果无法核对。请追加明确指示或新建团队任务。', attempt: 0, updatedAt: now };
      const tasks = [...current.tasks.map((task) => reviewIds.has(task.id) && task.status !== 'completed' && task.status !== 'abandoned'
        ? { ...task, status: 'abandoned' as const,
          error: task.status === 'result_unknown' ? '用户已放弃核对本轮验收，原结果仍未知' : '用户已放弃本轮未完成的验收', updatedAt: now } : task), block];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, tasks,
        run: { ...current.run, autoReview: false, planVersion: current.run.planVersion + 1, updatedAt: now } };
      return { snapshot, value: snapshot };
    });
  }

  async function retryFailedReview(runId: string, expectedPlanVersion: number, reviewId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion || current.run.status !== 'failed') throw new Error('团队计划已更新，请刷新后重试');
      const review = current.tasks.find((task) => task.id === reviewId && task.kind === 'team_review' && task.status === 'failed');
      if (!review || current.tasks.some((task) => task.status === 'running' || task.status === 'result_unknown')) throw new Error('当前验收任务不能重试');
      const now = Date.now();
      const snapshot: WorkflowSnapshot = { ...current,
        run: { ...current.run, status: 'paused', planVersion: current.run.planVersion + 1, updatedAt: now },
        tasks: current.tasks.map((task) => task.id === reviewId ? { ...task, status: 'queued', error: undefined, updatedAt: now } : task),
      };
      return { snapshot, value: snapshot };
    });
  }

  async function retryFailedTeamTask(runId: string, expectedPlanVersion: number, taskId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion || current.run.status !== 'failed') throw new Error('团队计划已更新，请刷新后重试');
      const target = current.tasks.find((task) => task.id === taskId && isRetryableTeamTask(task));
      if (!target || current.tasks.some((task) => task.status === 'running' || task.status === 'result_unknown')) throw new Error('当前任务不能重试');
      const now = Date.now();
      const snapshot: WorkflowSnapshot = { ...current,
        run: { ...current.run, status: 'paused', planVersion: current.run.planVersion + 1, updatedAt: now },
        tasks: current.tasks.map((task) => task.id === taskId ? { ...task, status: 'queued', error: undefined, capabilityIssue: undefined, updatedAt: now } : task),
      };
      return { snapshot, value: snapshot };
    });
  }

  async function addTasksOnce(runId: string, expectedPlanVersion: number, additions: WorkflowTask[]) {
    if (!additions.length) throw new Error('工作流计划修订不能为空');
    return mutate(scope(), runId, (current) => {
      if (additions.every((task) => current.tasks.some((item) => item.id === task.id))) return { snapshot: current, value: current };
      if (additions.some((task) => current.tasks.some((item) => item.id === task.id))) throw new Error('工作流计划部分任务已存在');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (current.run.status !== 'active' && current.run.status !== 'paused') throw new Error('工作流已结束');
      if (additions.some((task) => task.runId !== runId || (task.status !== 'queued' && task.status !== 'waiting_dependency') || task.attempt !== 0)) throw new Error('新任务状态无效');
      const tasks = [...current.tasks, ...additions];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: Date.now() }, tasks };
      return { snapshot, value: snapshot };
    });
  }

  async function expandPlanOnce(runId: string, expectedPlanVersion: number, sourceTaskId: string, additions: WorkflowTask[]) {
    if (!additions.length) throw new Error('团队计划不能没有任务');
    return mutate(scope(), runId, (current) => {
      const source = current.tasks.find((task) => task.id === sourceTaskId);
      if (!source || source.status !== 'completed') throw new Error('团队规划尚未完成');
      if (additions.every((task) => current.tasks.some((item) => item.id === task.id))) return { snapshot: current, value: current };
      if (additions.some((task) => current.tasks.some((item) => item.id === task.id))) throw new Error('团队计划部分任务已存在');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (current.run.status !== 'active' && current.run.status !== 'paused') throw new Error('工作流已结束');
      if (additions.some((task) => task.runId !== runId || (task.status !== 'queued' && task.status !== 'waiting_dependency') || task.attempt !== 0)) throw new Error('新任务状态无效');
      const tasks = [...current.tasks, ...additions];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: Date.now() }, tasks };
      return { snapshot, value: snapshot };
    });
  }

  async function closePlan(runId: string, expectedPlanVersion: number) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (current.run.status !== 'active' && current.run.status !== 'paused') throw new Error('工作流已结束');
      const allCompleted = current.tasks.every((task) => task.status === 'completed' || task.status === 'abandoned');
      const snapshot: WorkflowSnapshot = {
        ...current,
        run: { ...current.run, planOpen: false, status: allCompleted ? 'completed' : current.run.status, planVersion: current.run.planVersion + 1, updatedAt: Date.now() },
      };
      return { snapshot, value: snapshot };
    });
  }

  async function prepareDelivery(runId: string, expectedPlanVersion: number, value: WorkflowDelivery) {
    const delivery = parseWorkflowDelivery(value);
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'completed' || current.run.planVersion !== expectedPlanVersion
        || delivery.runId !== runId || delivery.chatId !== current.run.chatId || delivery.planVersion !== expectedPlanVersion) throw new Error('工作流交付版本冲突');
      if (current.run.delivery?.planVersion === expectedPlanVersion) {
        if (JSON.stringify(current.run.delivery) !== JSON.stringify(delivery)) throw new Error('已准备的交付清单不可修改');
        return { snapshot: current, value: current.run.delivery };
      }
      return { snapshot: { ...current, run: { ...current.run, delivery, deliveryStatus: 'pending' as const, updatedAt: Date.now() } }, value: delivery };
    });
  }

  async function markDeliveryPublished(runId: string, expectedPlanVersion: number) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'completed') throw new Error('只能确认已完成的工作流交付');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流交付版本冲突');
      if (current.run.deliveryStatus === 'published') return { snapshot: current, value: current };
      const snapshot = { ...current, run: { ...current.run, deliveryStatus: 'published' as const, deliveryIssue: undefined, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function prepareDeliveryCopy(runId: string, expectedPlanVersion: number, branching?: WorkflowDeliveryBranch) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'completed' || current.run.planVersion !== expectedPlanVersion
        || current.run.delivery?.planVersion !== expectedPlanVersion) throw new Error('工作流交付版本冲突');
      if (current.run.deliveryCopy?.planVersion === expectedPlanVersion) return { snapshot: current, value: current };
      if (current.run.deliveryStatus === 'published' || !['artifact_conflict', 'message_conflict'].includes(current.run.deliveryIssue || '')) throw new Error('当前交付没有待处理的内容冲突');
      const copy = copyWorkflowDelivery(current.run.delivery, Math.max(Date.now(), current.run.delivery.preparedAt), branching);
      const decision = deliveryCopyDecision(current.run.delivery, copy, current.run.deliveryIssue as WorkflowDecisionRecord['scope']['conflict']);
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run,
        deliveryCopy: copy, decisions: [...(current.run.decisions || []), decision], deliveryIssue: undefined, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function recordDeliveryIssue(runId: string, expectedPlanVersion: number, issue: WorkflowDeliveryIssue) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'completed' || current.run.planVersion !== expectedPlanVersion || current.run.deliveryStatus === 'published') return { snapshot: current, value: current };
      const snapshot = { ...current, run: { ...current.run, deliveryIssue: issue, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function runWithLock(runId: string, storageScope: string, work: () => Promise<WorkflowSnapshot>) {
    if (typeof navigator === 'undefined') return work();
    if (!navigator.locks?.request) throw new Error('此浏览器不支持安全的多标签页工作流执行');
    const lockName = workflowRunLockName(storageScope, runId);
    return navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('此工作流已在另一个标签页运行');
      return work();
    });
  }

  async function resume(runId: string, signal = new AbortController().signal, commandId?: string): Promise<WorkflowSnapshot> {
    const storageScope = scope();
    const activeKey = rowKey(storageScope, runId);
    const existing = active.get(activeKey);
    if (existing) return existing;
    const operation = runWithLock(runId, storageScope, async () => {
      if (executor.reconcileInterrupted) {
        const interrupted = await repository.read(storageScope, runId);
        for (const task of interrupted?.tasks.filter((item) => item.status === 'running') || []) {
          if (invocationUnstarted(task)) continue;
          const result = await executor.reconcileInterrupted(task);
          if (!result) continue;
          await mutate(storageScope, runId, (current) => ({ snapshot: {
            ...current,
            run: result.admissionRejected ? { ...current.run, pauseRequested: true, pauseReason: result.error, updatedAt: Date.now() } : current.run,
            tasks: current.tasks.map((item) => item.id === task.id && item.status === 'running' ? {
              ...(result.admissionRejected ? rejectWorkflowTaskAdmission(item, result.error || '请求未获受理，请检查任务预算。') : {
              ...finishInvocation(item, result.status === 'failed' ? 'failed' : result.status === 'queued' ? 'result_unknown' : 'succeeded', Date.now(), result.status === 'waiting_external' ? result.externalTaskId ?? item.externalTaskId : undefined),
              status: result.status, externalTaskId: result.externalTaskId ?? item.externalTaskId,
              output: result.output ?? item.output, error: result.error, updatedAt: Date.now(),
              }),
            } : item),
          }, value: undefined }));
        }
      }
      const inspectedExternalIds = new Set<string>();
      const alreadyApplied = await mutate(storageScope, runId, (current) => {
        if (commandId && current.run.resumeCommandIds?.includes(commandId)) return { snapshot: current, value: true };
        if (current.run.status === 'completed' || current.run.status === 'cancelled') return { snapshot: current, value: true };
        if (current.run.pauseRequested) return { snapshot: { ...current, run: { ...current.run, status: 'paused', pauseRequested: false, updatedAt: Date.now() } }, value: true };
        return { snapshot: { ...current, run: { ...current.run, status: 'active', pauseRequested: false, pauseReason: undefined, generation: current.run.generation + 1, resumeCommandIds: commandId ? [...(current.run.resumeCommandIds || []).slice(-99), commandId] : current.run.resumeCommandIds, updatedAt: Date.now() }, tasks: current.tasks.map((task) => task.status === 'running'
          ? { ...finishInvocation(task, 'result_unknown', Date.now()),
            status: invocationUnstarted(task) ? 'queued' : 'result_unknown',
            error: invocationUnstarted(task) ? undefined : '上次执行中断，需核对结果', updatedAt: Date.now() } : task) }, value: false };
      });
      if (alreadyApplied) {
        const current = await repository.read(storageScope, runId);
        if (!current) throw new Error('工作流不存在');
        return current;
      }
      while (!signal.aborted) {
        if (scope() !== storageScope) break;
        const snapshot = await repository.read(storageScope, runId);
        if (!snapshot || snapshot.run.status !== 'active' || snapshot.run.pauseRequested) break;
        const pauseReason = workflowDeadlineBlockReason(snapshot.run.goalSpec) || executor.dispatchBlockReason?.(snapshot);
        if (pauseReason) {
          await mutate(storageScope, runId, (current) => ({ snapshot: { ...current,
            run: { ...current.run, status: 'paused', pauseReason, updatedAt: Date.now() } }, value: undefined }));
          break;
        }
        const concurrency = Math.max(1, Math.min(8, Math.floor(maxConcurrentTasks) || 1, snapshot.run.goalSpec?.execution.maxConcurrentTasks ?? 8));
        const generation = snapshot.run.generation;
        const completed = new Set(snapshot.tasks.filter((task) => task.status === 'completed').map((task) => task.id));
        const ready = snapshot.tasks.filter((task) => (task.status === 'queued' || task.status === 'waiting_dependency') && task.dependsOn.every((id) => completed.has(id)));
        const requiresApproval = ready.filter((task) => {
          const requirement = executor.approvalRequirement?.(task, snapshot);
          return requirement && !workflowApprovalMatches(task, requirement);
        });
        if (requiresApproval.length) {
          await mutate(storageScope, runId, (current) => {
            if (scope() !== storageScope || current.run.generation !== generation || current.run.status !== 'active' || current.run.pauseRequested) return { snapshot: current, value: undefined };
            return { snapshot: { ...current, tasks: current.tasks.map((task) => {
              if (!requiresApproval.some((item) => item.id === task.id)) return task;
              const requirement = executor.approvalRequirement?.(task, current);
              if (!requirement) throw new Error('审批要求已改变');
              const approvals = [...(task.approvals ?? [])];
              const prior = approvals.at(-1);
              if (prior?.attempt === task.attempt + 1 && prior.decision?.outcome === 'approved') {
                approvals[approvals.length - 1] = { ...prior, invalidatedAt: Math.max(Date.now(), prior.decision.decidedAt) };
              }
              return { ...task, status: 'waiting_user' as const, error: '等待你确认执行', updatedAt: Date.now(),
                approvals: [...approvals, proposeWorkflowApproval(current, task, requirement)] };
            }) }, value: undefined };
          });
          continue;
        }
        const external = snapshot.tasks.filter((task) => task.status === 'waiting_external' && task.externalTaskId && executor.inspectExternal && !inspectedExternalIds.has(task.id));
        const remainingModelCalls = snapshot.run.maxModelCalls === undefined ? Number.POSITIVE_INFINITY
          : Math.max(0, snapshot.run.maxModelCalls - countWorkflowModelCalls(snapshot));
        let selectedModelCalls = 0;
        const batch = [...ready, ...external].filter((task) => {
          if (task.status === 'waiting_external') return true;
          if (!isWorkflowModelTask(task.kind)) return true;
          if (selectedModelCalls >= remainingModelCalls) return false;
          selectedModelCalls += 1;
          return true;
        }).slice(0, concurrency);
        if (!batch.length) break;
        const claimed = new Set(batch.filter((task) => ready.includes(task)).map((task) => task.id));
        const dispatchAllowed = await mutate(storageScope, runId, (current) => {
          if (scope() !== storageScope || current.run.generation !== generation || current.run.status !== 'active' || current.run.pauseRequested) {
            return { snapshot: current, value: false };
          }
          const reason = workflowDeadlineBlockReason(current.run.goalSpec) || executor.dispatchBlockReason?.(current);
          if (reason) return { snapshot: { ...current, run: { ...current.run, status: 'paused', pauseReason: reason, updatedAt: Date.now() } }, value: false };
          for (const item of current.tasks.filter((task) => claimed.has(task.id))) {
            const requirement = executor.approvalRequirement?.(item, current);
            if (requirement && !workflowApprovalMatches(item, requirement)) return { snapshot: current, value: false };
          }
          return { snapshot: {
            ...current,
            tasks: current.tasks.map((item) => claimed.has(item.id)
              ? { ...item, status: 'running', capabilityIssue: undefined, attempt: item.attempt + 1, updatedAt: Date.now(),
                ...(executor.tracksModelInvocations && isWorkflowModelTask(item.kind) ? { modelInvocation: {
                  schemaVersion: 1 as const, id: workflowModelInvocationId(runId, item.id, item.attempt + 1),
                  runId, taskId: item.id, attempt: item.attempt + 1, state: 'reserved' as const, reservedAt: Date.now(),
                } } : {}),
                ...(executor.tracksToolInvocations && isWorkflowToolTask(item.kind) ? { toolInvocation: {
                  schemaVersion: 1 as const, id: workflowToolInvocationId(runId, item.id, item.attempt + 1),
                  operationKey: workflowToolOperationKey(runId, item.id), kind: item.kind, planVersion: current.run.planVersion,
                  runId, taskId: item.id, attempt: item.attempt + 1, state: 'reserved' as const, reservedAt: Date.now(),
                } } : {}) } : item),
          }, value: true };
        });
        if (!dispatchAllowed) break;
        await Promise.all(batch.map(async (task) => {
          const isReady = claimed.has(task.id);
          const context: WorkflowExecutionContext = {
            usageReference: isReady && executor.tracksToolInvocations && isWorkflowToolTask(task.kind)
              ? { schemaVersion: 1, runId, taskId: task.id, attempt: task.attempt + 1, kind: 'tool',
                ...(snapshot.run.goalSpec?.platformBudget ? { budgetRevision: snapshot.run.goalSpec.platformBudget.revision } : {}) } : undefined,
            async beginToolInvocation(request) {
              signal.throwIfAborted();
              const description = request === undefined ? undefined : parseWorkflowToolRequest(request);
              if (description && workflowToolRequestKind(description) !== task.kind) throw new WorkflowPreflightError('工具请求类型与任务不一致');
              await mutate(storageScope, runId, (current) => {
                const item = current.tasks.find((candidate) => candidate.id === task.id);
                if (!executor.tracksToolInvocations || !isReady || scope() !== storageScope
                  || current.run.generation !== generation || current.run.status !== 'active' || current.run.pauseRequested
                  || item?.status !== 'running' || item.attempt !== task.attempt + 1 || item.toolInvocation?.state !== 'reserved') {
                  throw new WorkflowPreflightError('工具调用的运行权已失效或已开始');
                }
                const reason = workflowDeadlineBlockReason(current.run.goalSpec) || executor.dispatchBlockReason?.(current);
                if (reason) throw new WorkflowPreflightError(reason);
                const requirement = executor.approvalRequirement?.(item, current);
                if (requirement && !workflowApprovalMatches(item, requirement, item.attempt)) throw new WorkflowPreflightError('执行配置已改变，请重新确认审批');
                const invocation = item.toolInvocation;
                const now = Math.max(Date.now(), invocation.reservedAt);
                return { snapshot: { ...current, run: { ...current.run, updatedAt: now }, tasks: current.tasks.map((candidate) => candidate.id === task.id
                  ? { ...candidate, updatedAt: now, toolInvocation: { ...invocation, state: 'started', startedAt: now,
                    ...(description ? { request: description } : {}) } } : candidate) }, value: undefined };
              });
              signal.throwIfAborted();
            },
            async beginModelInvocation(request) {
              signal.throwIfAborted();
              const description = request === undefined ? undefined : parseWorkflowModelRequest(request);
              await mutate(storageScope, runId, (current) => {
                const item = current.tasks.find((candidate) => candidate.id === task.id);
                if (!executor.tracksModelInvocations || !isReady || scope() !== storageScope
                  || current.run.generation !== generation || current.run.status !== 'active' || current.run.pauseRequested
                  || item?.status !== 'running' || item.attempt !== task.attempt + 1 || item.modelInvocation?.state !== 'reserved') {
                  throw new WorkflowPreflightError('模型调用的运行权已失效或已开始');
                }
                const reason = workflowDeadlineBlockReason(current.run.goalSpec) || executor.dispatchBlockReason?.(current);
                if (reason) throw new WorkflowPreflightError(reason);
                const requirement = executor.approvalRequirement?.(item, current);
                if (requirement && !workflowApprovalMatches(item, requirement, item.attempt)) throw new WorkflowPreflightError('执行配置已改变，请重新确认审批');
                const now = Math.max(Date.now(), item.modelInvocation.reservedAt);
                return { snapshot: { ...current, run: { ...current.run, updatedAt: now }, tasks: current.tasks.map((candidate) => candidate.id === task.id
                  ? { ...candidate, updatedAt: now, modelInvocation: { ...item.modelInvocation!, state: 'started', startedAt: now,
                    ...(description ? { request: description } : {}) } } : candidate) }, value: undefined };
              });
              signal.throwIfAborted();
              return { schemaVersion: 1, runId, taskId: task.id, attempt: task.attempt + 1, kind: 'model',
                ...(snapshot.run.goalSpec?.platformBudget ? { budgetRevision: snapshot.run.goalSpec.platformBudget.revision } : {}) };
            },
          };
          try {
            const result = isReady ? await executor.execute(task, signal, context) : await executor.inspectExternal!(task, signal);
            await mutate(storageScope, runId, (current) => {
              if (scope() !== storageScope || current.run.generation !== generation || current.run.status !== 'active') return { snapshot: current, value: undefined };
              const spawn = 'spawn' in result ? result.spawn : undefined;
              const waitingForUser = 'waitingForUser' in result && result.waitingForUser === true;
              if (waitingForUser && (task.kind !== 'agent_user_input' || spawn || result.output !== undefined
                || ('externalTaskId' in result && result.externalTaskId))) throw new WorkflowPreflightError('用户提问等待状态无效');
              const parent = current.tasks.find((item) => item.id === task.id);
              if (spawn && (!isReady || !parent || parent.expansion || ('externalTaskId' in result && result.externalTaskId) || !spawn.tasks.length || spawn.tasks.length > 48
                || spawn.tasks.some((child) => child.runId !== runId || child.attempt !== 0 || child.expansion
                  || !['queued', 'waiting_dependency'].includes(child.status) || current.tasks.some((existing) => existing.id === child.id)))) {
                throw new WorkflowPreflightError('子任务展开状态无效');
              }
              const next: WorkflowSnapshot = {
              ...current, run: { ...current.run, planVersion: current.run.planVersion + (spawn ? 1 : 0), updatedAt: Date.now() },
              tasks: [...current.tasks.map((item): WorkflowTask => {
                if (item.id !== task.id) return item;
                if (isReady && invocationUnstarted(item)) throw new WorkflowPreflightError('执行器未记录调用开始，结果不能提交');
                return {
                ...finishInvocation(item, 'status' in result && result.status === 'failed' ? 'failed' : 'succeeded', Date.now(),
                  'status' in result && result.status === 'pending' ? item.externalTaskId : 'externalTaskId' in result ? result.externalTaskId : undefined),
                status: waitingForUser ? 'waiting_user' : spawn ? 'waiting_dependency' : 'status' in result ? result.status === 'pending' ? 'waiting_external' : result.status === 'failed' ? 'failed' : 'completed' : result.externalTaskId ? 'waiting_external' : 'completed',
                ...(spawn ? { expansion: { taskIds: spawn.tasks.map((child) => child.id), context: spawn.context }, dependsOn: [...new Set([...item.dependsOn, ...spawn.tasks.map((child) => child.id)])] } : {}),
                output: result.output ?? item.output,
                externalTaskId: 'externalTaskId' in result ? result.externalTaskId : item.externalTaskId,
                error: 'error' in result ? result.error : undefined,
                updatedAt: Date.now(),
              }; }), ...(spawn?.tasks || [])],
            };
              if (spawn) {
                try {
                  assertWorkflowSnapshot(next);
                } catch (error) {
                  throw new WorkflowPreflightError(error instanceof Error ? error.message : '子任务展开计划无效');
                }
              }
              return { snapshot: next, value: undefined }; });
            if ('status' in result && result.status === 'pending') inspectedExternalIds.add(task.id);
          } catch (error) {
            const admissionReason = isReady ? workflowAdmissionBlockReason(error) : undefined;
            await mutate(storageScope, runId, (current) => ({ snapshot: scope() !== storageScope || current.run.generation !== generation || current.run.status !== 'active' ? current : { ...current,
              run: admissionReason ? { ...current.run, pauseRequested: true, pauseReason: admissionReason, updatedAt: Date.now() } : current.run,
              tasks: current.tasks.map((item) => {
              if (item.id !== task.id) return item;
              if (admissionReason) {
                return rejectWorkflowTaskAdmission(item, admissionReason);
              }
              const definiteFailure = error instanceof WorkflowPreflightError || invocationUnstarted(item);
              const blockedBeforeRequest = invocationUnstarted(item)
                && (current.run.pauseRequested || workflowDeadlineBlockReason(current.run.goalSpec) || executor.dispatchBlockReason?.(current));
              return { ...(isReady ? finishInvocation(item, definiteFailure ? 'failed' : 'result_unknown', Date.now()) : item),
                status: blockedBeforeRequest ? 'queued' : !isReady ? 'waiting_external' : definiteFailure ? 'failed' : 'result_unknown',
                capabilityIssue: !blockedBeforeRequest && isReady && error instanceof WorkflowPreflightError && error.capability
                  ? { schemaVersion: 1, ...error.capability, attempt: item.attempt, planVersion: current.run.planVersion } : undefined,
                error: blockedBeforeRequest ? undefined : error instanceof Error ? error.message : '任务状态查询失败', updatedAt: Date.now() };
            }) }, value: undefined }));
            if (!isReady) inspectedExternalIds.add(task.id);
          }
        }));
      }
      return mutate(storageScope, runId, (current) => {
        const tasks = signal.aborted
          ? current.tasks.map((task) => task.status === 'running'
            ? { ...finishInvocation(task, 'result_unknown', Date.now()), status: invocationUnstarted(task) ? 'queued' as const : 'result_unknown' as const,
              error: invocationUnstarted(task) ? undefined : '请求已中断，结果需要核对', updatedAt: Date.now() }
            : task)
          : current.tasks;
        const completed = !current.run.planOpen && tasks.every((task) => task.status === 'completed' || task.status === 'abandoned');
        const failed = tasks.some((task) => task.status === 'failed');
        const modelCallLimitReached = !failed && current.run.maxModelCalls !== undefined
          && countWorkflowModelCalls({ ...current, tasks }) >= current.run.maxModelCalls
          && !tasks.some((task) => task.status === 'waiting_external')
          && tasks.some((task) => task.status === 'queued' || task.status === 'waiting_dependency');
        const waitingForUser = !failed && tasks.some((task) => task.status === 'waiting_user' && (task.kind === 'agent_user_input' || pendingWorkflowApproval(task)))
          && !tasks.some((task) => task.status === 'waiting_external');
        const snapshot = { ...current, tasks, run: { ...current.run, status: current.run.status !== 'active' ? current.run.status : signal.aborted || current.run.pauseRequested || modelCallLimitReached || waitingForUser ? 'paused' as const : completed ? 'completed' as const : failed ? 'failed' as const : current.run.status, pauseRequested: false, updatedAt: Date.now() } };
        return { snapshot, value: snapshot };
      });
    }).finally(() => active.delete(activeKey));
    active.set(activeKey, operation);
    return operation;
  }

  async function pause(runId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status === 'completed' || current.run.status === 'cancelled') return { snapshot: current, value: current };
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run, status: 'paused', generation: current.run.generation + 1, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function requestPauseAfterCurrentBatch(runId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'active') return { snapshot: current, value: current };
      const snapshot: WorkflowSnapshot = {
        ...current,
        run: { ...current.run, pauseRequested: true, updatedAt: Date.now() },
      };
      return { snapshot, value: snapshot };
    });
  }

  return { create, setModelCallLimit, setDeadline, bindPlatformBudget, addTasks, addTeamRevision, replaceUserBlockWithTasks, answerUserInput, decideApproval, blockForUser, abandonUnknownReview, retryFailedReview, retryFailedTeamTask, addTasksOnce, expandPlanOnce, closePlan, prepareDelivery, prepareDeliveryCopy, markDeliveryPublished, recordDeliveryIssue, resume, pause, requestPauseAfterCurrentBatch, list: () => repository.list(scope()), read: (runId: string) => repository.read(scope(), runId) };
}
