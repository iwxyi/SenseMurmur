import type { WorkflowSnapshot, WorkflowTask, WorkflowTaskStatus } from './workflowRunRuntime';
import { parseWorkflowModelInvocation, type WorkflowModelInvocation } from './workflowModelInvocation';

export interface WorkflowTaskAttempt {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  attempt: number;
  kind: string;
  generation: number;
  planVersion: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  status: WorkflowTaskStatus;
  externalTaskId?: string;
  modelInvocation?: WorkflowModelInvocation;
}

export function parseWorkflowTaskAttempt(raw: unknown): WorkflowTaskAttempt {
  if (!raw || typeof raw !== 'object') throw new Error('任务执行记录无效');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('任务执行记录版本不受支持');
  for (const field of ['runId', 'taskId', 'kind'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error('任务执行记录标识无效');
  }
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0
    || !Number.isSafeInteger(value.planVersion) || Number(value.planVersion) < 1) throw new Error('任务执行记录代次无效');
  if (!Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt)
    || Number(value.updatedAt) < Number(value.startedAt)
    || (value.finishedAt !== undefined && (!Number.isFinite(value.finishedAt) || Number(value.finishedAt) < Number(value.startedAt)
      || Number(value.finishedAt) > Number(value.updatedAt)))) throw new Error('任务执行记录时间无效');
  if (!['queued', 'running', 'waiting_dependency', 'waiting_external', 'waiting_user', 'result_unknown', 'completed', 'failed', 'cancelled', 'abandoned'].includes(String(value.status))) throw new Error('任务执行记录状态无效');
  if (value.externalTaskId !== undefined && typeof value.externalTaskId !== 'string') throw new Error('任务执行记录外部关联无效');
  const modelInvocation = value.modelInvocation === undefined ? undefined : parseWorkflowModelInvocation(value.modelInvocation);
  if (modelInvocation && (modelInvocation.runId !== value.runId || modelInvocation.taskId !== value.taskId || modelInvocation.attempt !== value.attempt)) throw new Error('任务执行记录调用关联无效');
  return {
    schemaVersion: 1, runId: value.runId as string, taskId: value.taskId as string, kind: value.kind as string,
    attempt: value.attempt as number, generation: value.generation as number, planVersion: value.planVersion as number,
    startedAt: value.startedAt as number, updatedAt: value.updatedAt as number, status: value.status as WorkflowTaskStatus,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt as number }),
    ...(value.externalTaskId === undefined ? {} : { externalTaskId: value.externalTaskId as string }),
    ...(modelInvocation ? { modelInvocation } : {}),
  };
}

export function claimedTaskAttempt(snapshot: WorkflowSnapshot, task: WorkflowTask): WorkflowTaskAttempt {
  return { schemaVersion: 1, runId: task.runId, taskId: task.id, kind: task.kind, attempt: task.attempt,
    generation: snapshot.run.generation, planVersion: snapshot.run.planVersion, status: 'running', startedAt: task.updatedAt, updatedAt: task.updatedAt,
    ...(task.modelInvocation ? { modelInvocation: task.modelInvocation } : {}) };
}

export function settleTaskAttempt(attempt: WorkflowTaskAttempt, task: WorkflowTask): WorkflowTaskAttempt {
  // Re-queueing schedules a new attempt; it must not rewrite the previous outcome.
  if (task.status === 'queued' || task.status === 'waiting_dependency') {
    if (task.status === 'waiting_dependency' && task.expansion && task.modelInvocation?.state === 'succeeded') {
      return { ...attempt, status: 'completed', updatedAt: Math.max(task.updatedAt, attempt.updatedAt),
        finishedAt: task.updatedAt, modelInvocation: task.modelInvocation };
    }
    if (task.modelInvocation?.state !== 'not_started') return attempt;
    return { ...attempt, status: 'cancelled', updatedAt: Math.max(task.updatedAt, attempt.updatedAt),
      finishedAt: task.modelInvocation.finishedAt, modelInvocation: task.modelInvocation };
  }
  const updatedAt = Math.max(task.updatedAt, attempt.updatedAt);
  const terminal = ['completed', 'failed', 'cancelled', 'abandoned'].includes(task.status);
  const { finishedAt: previousFinishedAt, ...activeAttempt } = attempt;
  void previousFinishedAt;
  return { ...activeAttempt, status: task.status, updatedAt,
    ...(terminal ? { finishedAt: updatedAt } : {}),
    ...(task.externalTaskId ? { externalTaskId: task.externalTaskId } : {}),
    ...(task.modelInvocation ? { modelInvocation: task.modelInvocation } : {}) };
}
