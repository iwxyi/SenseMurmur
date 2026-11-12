import { parseWorkflowToolRequest, workflowToolRequestKind, type WorkflowToolRequest } from './workflowToolRequest';

export const WORKFLOW_TOOL_TASK_KINDS = ['agent_web_search', 'agent_image', 'agent_audio', 'agent_video', 'agent_media_composition'] as const;

export interface WorkflowToolInvocation {
  schemaVersion: 1;
  id: string;
  operationKey: string;
  runId: string;
  taskId: string;
  attempt: number;
  kind: typeof WORKFLOW_TOOL_TASK_KINDS[number];
  planVersion: number;
  state: 'reserved' | 'started' | 'waiting_external' | 'succeeded' | 'failed' | 'result_unknown' | 'not_started';
  reservedAt: number;
  startedAt?: number;
  finishedAt?: number;
  externalTaskId?: string;
  request?: WorkflowToolRequest;
}

export function isWorkflowToolTask(kind: string): kind is WorkflowToolInvocation['kind'] {
  return WORKFLOW_TOOL_TASK_KINDS.some((known) => known === kind);
}

export function workflowToolOperationKey(runId: string, taskId: string) {
  return JSON.stringify(['tool', runId, taskId]);
}

export function workflowToolInvocationId(runId: string, taskId: string, attempt: number) {
  return JSON.stringify(['tool', runId, taskId, attempt]);
}

export function parseWorkflowToolInvocation(raw: unknown): WorkflowToolInvocation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工具调用记录无效');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('工具调用记录版本不受支持');
  if (typeof value.runId !== 'string' || !value.runId || typeof value.taskId !== 'string' || !value.taskId
    || !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1
    || !Number.isSafeInteger(value.planVersion) || Number(value.planVersion) < 1
    || typeof value.kind !== 'string' || !isWorkflowToolTask(value.kind)
    || value.operationKey !== workflowToolOperationKey(value.runId, value.taskId)
    || value.id !== workflowToolInvocationId(value.runId, value.taskId, Number(value.attempt))) throw new Error('工具调用关联无效');
  if (!['reserved', 'started', 'waiting_external', 'succeeded', 'failed', 'result_unknown', 'not_started'].includes(String(value.state))) throw new Error('工具调用状态无效');
  const unstarted = value.state === 'reserved' || value.state === 'not_started';
  const request = value.request === undefined ? undefined : parseWorkflowToolRequest(value.request);
  if (request && (unstarted || workflowToolRequestKind(request) !== value.kind)) throw new Error('工具请求摘要与调用不一致');
  const terminal = !['reserved', 'started', 'waiting_external'].includes(String(value.state));
  if (unstarted !== (value.startedAt === undefined) || terminal !== (value.finishedAt !== undefined)
    || !Number.isFinite(value.reservedAt)
    || (value.startedAt !== undefined && (!Number.isFinite(value.startedAt) || Number(value.startedAt) < Number(value.reservedAt)))
    || (value.finishedAt !== undefined && (!Number.isFinite(value.finishedAt) || Number(value.finishedAt) < Number(value.startedAt ?? value.reservedAt)))) throw new Error('工具调用时间无效');
  if ((value.externalTaskId !== undefined && (typeof value.externalTaskId !== 'string' || !value.externalTaskId))
    || (value.state === 'waiting_external' && !value.externalTaskId)) throw new Error('工具调用外部关联无效');
  return { schemaVersion: 1, id: value.id as string, operationKey: value.operationKey as string,
    runId: value.runId, taskId: value.taskId, attempt: Number(value.attempt), kind: value.kind,
    planVersion: Number(value.planVersion), state: value.state as WorkflowToolInvocation['state'], reservedAt: Number(value.reservedAt),
    ...(value.startedAt === undefined ? {} : { startedAt: Number(value.startedAt) }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: Number(value.finishedAt) }),
    ...(value.externalTaskId === undefined ? {} : { externalTaskId: value.externalTaskId as string }),
    ...(request ? { request } : {}) };
}
