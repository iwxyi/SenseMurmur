import type { WorkflowSnapshot, WorkflowTask } from './workflowRunRuntime';
import { workflowJsonDigest } from './workflowToolRequest';

export interface WorkflowApprovalRequirement {
  summary: string;
  consequences: string;
  executionSha256?: string;
}

export interface WorkflowApproval extends WorkflowApprovalRequirement {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  attempt: number;
  planVersion: number;
  proposedAt: number;
  scopeSha256: string;
  invalidatedAt?: number;
  decision?: { actor: 'local_user'; outcome: 'approved' | 'rejected'; planVersion: number; decidedAt: number };
}

export function parseWorkflowApprovalRequirement(value: unknown): WorkflowApprovalRequirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('审批方案无效');
  const item = value as Record<string, unknown>;
  for (const key of ['summary', 'consequences'] as const) {
    if (typeof item[key] !== 'string' || !item[key].trim() || item[key].length > 2000) throw new Error('审批说明无效');
  }
  if (item.executionSha256 !== undefined && (typeof item.executionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.executionSha256))) throw new Error('审批执行配置摘要无效');
  return { summary: (item.summary as string).trim(), consequences: (item.consequences as string).trim(),
    ...(item.executionSha256 === undefined ? {} : { executionSha256: item.executionSha256 as string }) };
}

function approvalScope(snapshot: WorkflowSnapshot, task: WorkflowTask) {
  return workflowJsonDigest({ runId: task.runId, taskId: task.id, kind: task.kind, input: task.input,
    dependsOn: task.dependsOn, dependencies: task.dependsOn.map((id) => {
      const source = snapshot.tasks.find((item) => item.id === id);
      if (!source || source.status !== 'completed') throw new Error('审批依赖尚未完成');
      return { id, attempt: source.attempt, outputSha256: workflowJsonDigest(source.output ?? null) };
    }) });
}

export function proposeWorkflowApproval(snapshot: WorkflowSnapshot, task: WorkflowTask, requirement: WorkflowApprovalRequirement): WorkflowApproval {
  return { schemaVersion: 1, runId: task.runId, taskId: task.id, attempt: task.attempt + 1,
    planVersion: snapshot.run.planVersion, proposedAt: Date.now(), scopeSha256: approvalScope(snapshot, task),
    ...parseWorkflowApprovalRequirement(requirement) };
}

export function pendingWorkflowApproval(task: WorkflowTask) {
  const last = task.approvals?.at(-1);
  return last && !last.decision && last.invalidatedAt === undefined ? last : undefined;
}

export function workflowApprovalMatches(task: WorkflowTask, requirement: WorkflowApprovalRequirement, expectedAttempt = task.attempt + 1) {
  const last = task.approvals?.at(-1);
  return Boolean(last && last.invalidatedAt === undefined && last.attempt === expectedAttempt
    && last.decision?.outcome === 'approved' && last.executionSha256 === requirement.executionSha256);
}

export function assertWorkflowApprovals(snapshot: WorkflowSnapshot, task: WorkflowTask) {
  if (task.approvals === undefined) return;
  if (!Array.isArray(task.approvals) || !task.approvals.length) throw new Error('审批记录无效');
  let previousAttempt = 0;
  for (const [index, item] of task.approvals.entries()) {
    parseWorkflowApprovalRequirement(item);
    if (item.schemaVersion !== 1 || item.runId !== task.runId || item.taskId !== task.id
      || !Number.isSafeInteger(item.attempt) || item.attempt < previousAttempt
      || (item.attempt === previousAttempt && task.approvals[index - 1]?.invalidatedAt === undefined) || item.attempt > task.attempt + 1
      || !Number.isSafeInteger(item.planVersion) || item.planVersion < 1 || item.planVersion > snapshot.run.planVersion
      || !Number.isSafeInteger(item.proposedAt) || item.proposedAt < 0 || !/^[a-f0-9]{64}$/.test(item.scopeSha256)) throw new Error('审批版本或范围无效');
    previousAttempt = item.attempt;
    if (item.invalidatedAt !== undefined && (!Number.isSafeInteger(item.invalidatedAt) || item.invalidatedAt < (item.decision?.decidedAt ?? item.proposedAt)
      || item.decision?.outcome === 'rejected' || index === task.approvals.length - 1)) throw new Error('审批失效记录无效');
    if (item.decision) {
      const decision = item.decision;
      if (decision.actor !== 'local_user' || !['approved', 'rejected'].includes(decision.outcome)
        || !Number.isSafeInteger(decision.planVersion) || decision.planVersion < item.planVersion || decision.planVersion >= snapshot.run.planVersion
        || !Number.isSafeInteger(decision.decidedAt) || decision.decidedAt < item.proposedAt
        || (decision.outcome === 'rejected' && snapshot.run.status !== 'cancelled')) throw new Error('审批决定无效');
    } else if (item.invalidatedAt === undefined && (index !== task.approvals.length - 1 || task.status !== 'waiting_user' && snapshot.run.status !== 'cancelled')) {
      throw new Error('未确认的审批不能执行');
    }
    if (item.invalidatedAt === undefined && item.attempt > task.attempt && item.scopeSha256 !== approvalScope(snapshot, task)) throw new Error('审批方案或素材已改变');
  }
}

export function assertWorkflowApprovalTransition(before: WorkflowSnapshot | null, after: WorkflowSnapshot) {
  for (const task of before?.tasks ?? []) {
    if (!task.approvals) continue;
    const next = after.tasks.find((item) => item.id === task.id);
    if (!next?.approvals || next.approvals.length < task.approvals.length) throw new Error('已保存的审批不可删除');
    for (const [index, record] of task.approvals.entries()) {
      const changed = next.approvals[index];
      if (workflowJsonDigest({ ...record, decision: undefined, invalidatedAt: undefined }) !== workflowJsonDigest({ ...changed, decision: undefined, invalidatedAt: undefined })
        || (record.decision && workflowJsonDigest(record.decision) !== workflowJsonDigest(changed.decision))
        || (record.invalidatedAt !== undefined && record.invalidatedAt !== changed.invalidatedAt)) throw new Error('已保存的审批不可修改');
      if (record.invalidatedAt === undefined && changed.invalidatedAt !== undefined
        && (index !== task.approvals.length - 1 || record.attempt !== task.attempt + 1 || record.decision?.outcome === 'rejected'
          || next.attempt !== task.attempt || next.approvals.length !== task.approvals.length + 1
          || (!record.decision && (task.status !== 'waiting_user' || next.status !== 'waiting_user'
            || before!.tasks.some((item) => item.status === 'running') || !['active', 'paused'].includes(before!.run.status)
            || after.run.status !== before!.run.status || after.run.planVersion !== before!.run.planVersion + 1 || changed.decision !== undefined))
          || next.approvals.at(-1)?.executionSha256 === record.executionSha256)) throw new Error('只有执行配置变化才能使审批失效');
      if (record.invalidatedAt === undefined && record.attempt > task.attempt && next.attempt >= record.attempt
        && (record.decision?.outcome !== 'approved' || record.scopeSha256 !== approvalScope(after, next))) throw new Error('执行范围未获当前审批');
      if (!record.decision && changed.decision && (task.status !== 'waiting_user' || next.attempt !== task.attempt
        || before!.tasks.some((item) => item.status === 'running') || !['active', 'paused'].includes(before!.run.status)
        || changed.decision.planVersion !== before!.run.planVersion || after.run.planVersion !== before!.run.planVersion + 1
        || (changed.decision.outcome === 'approved' ? next.status !== 'queued' : after.run.status !== 'cancelled'))) throw new Error('只能确认当前待审批的步骤');
    }
  }
  for (const task of after.tasks) {
    const previous = before?.tasks.find((item) => item.id === task.id);
    const count = previous?.approvals?.length ?? 0;
    if ((task.approvals?.length ?? 0) > count) {
      const added = task.approvals!.at(-1)!;
      const replacesPending = previous?.status === 'waiting_user' && pendingWorkflowApproval(previous)
        && task.approvals![count - 1]?.invalidatedAt !== undefined;
      if (!before || !previous || task.approvals!.length !== count + 1 || (!replacesPending && !['queued', 'waiting_dependency'].includes(previous.status))
        || (replacesPending ? !['active', 'paused'].includes(before.run.status) : before.run.status !== 'active') || added.decision || added.attempt !== previous.attempt + 1
        || task.attempt !== previous.attempt || task.status !== 'waiting_user' || added.planVersion !== before.run.planVersion
        || added.scopeSha256 !== approvalScope(before, previous)) throw new Error('审批必须在实际执行前提出');
    }
  }
}
