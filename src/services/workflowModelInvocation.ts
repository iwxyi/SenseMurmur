import { parseWorkflowModelRequest, type WorkflowModelRequest } from './workflowModelRequest';

export const WORKFLOW_MODEL_TASK_KINDS = ['team_plan', 'team_plan_revision', 'team_recovery', 'team_review', 'agent_text', 'agent_delegation', 'agent_image_inspection', 'agent_video_inspection'] as const;

export interface WorkflowModelInvocation {
  schemaVersion: 1;
  id: string;
  runId: string;
  taskId: string;
  attempt: number;
  state: 'reserved' | 'started' | 'succeeded' | 'failed' | 'result_unknown' | 'not_started' | 'rejected';
  reservedAt: number;
  startedAt?: number;
  finishedAt?: number;
  request?: WorkflowModelRequest;
  requests?: WorkflowModelRequest[];
}

export function workflowModelInvocationId(runId: string, taskId: string, attempt: number) {
  return JSON.stringify([runId, taskId, attempt]);
}

export function isWorkflowModelTask(kind: string) {
  return WORKFLOW_MODEL_TASK_KINDS.some((known) => known === kind);
}

export function parseWorkflowModelInvocation(raw: unknown): WorkflowModelInvocation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型调用记录无效');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('模型调用记录版本不受支持');
  if (typeof value.runId !== 'string' || !value.runId || typeof value.taskId !== 'string' || !value.taskId
    || !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1
    || value.id !== workflowModelInvocationId(value.runId, value.taskId, Number(value.attempt))) throw new Error('模型调用关联无效');
  if (!['reserved', 'started', 'succeeded', 'failed', 'result_unknown', 'not_started', 'rejected'].includes(String(value.state))) throw new Error('模型调用状态无效');
  if (!Number.isFinite(value.reservedAt)
    || (value.startedAt !== undefined && (!Number.isFinite(value.startedAt) || Number(value.startedAt) < Number(value.reservedAt)))
    || (value.finishedAt !== undefined && (!Number.isFinite(value.finishedAt) || Number(value.finishedAt) < Number(value.startedAt ?? value.reservedAt)))) throw new Error('模型调用时间无效');
  const notStarted = value.state === 'reserved' || value.state === 'not_started';
  const terminal = value.state !== 'reserved' && value.state !== 'started';
  if (notStarted !== (value.startedAt === undefined) || terminal !== (value.finishedAt !== undefined)) throw new Error('模型调用状态与时间不一致');
  const request = value.request === undefined ? undefined : parseWorkflowModelRequest(value.request);
  if (request && notStarted) throw new Error('未开始的模型调用不能包含请求摘要');
  const requests = value.requests === undefined ? undefined : Array.isArray(value.requests)
    ? value.requests.map(parseWorkflowModelRequest) : (() => { throw new Error('模型请求记录列表无效'); })();
  if (requests && (notStarted || !requests.length || (request && JSON.stringify(requests[0]) !== JSON.stringify(request)))) {
    throw new Error('模型请求记录列表与调用摘要不一致');
  }
  return { schemaVersion: 1, id: value.id as string, runId: value.runId, taskId: value.taskId, attempt: Number(value.attempt),
    state: value.state as WorkflowModelInvocation['state'], reservedAt: Number(value.reservedAt),
    ...(value.startedAt === undefined ? {} : { startedAt: Number(value.startedAt) }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: Number(value.finishedAt) }),
    ...(request ? { request } : {}), ...(requests ? { requests } : {}) };
}
