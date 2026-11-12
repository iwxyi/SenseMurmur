import type { WorkflowSnapshot } from './workflowRunRuntime';

export interface WorkflowPlanRevision {
  schemaVersion: 1;
  runId: string;
  parentVersion: number;
  version: number;
  appliedAt: number;
  addedTaskIds: string[];
  removedTaskIds: string[];
  updatedTaskIds: string[];
  changedRunFields: string[];
}

const PLAN_RUN_FIELDS = ['goal', 'goalSpec', 'maxModelCalls', 'autoReview', 'planOpen'] as const;

export function parseWorkflowPlanRevision(raw: unknown): WorkflowPlanRevision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('计划修订记录无效');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('计划修订记录版本不受支持');
  if (typeof value.runId !== 'string' || !value.runId.trim()) throw new Error('计划修订运行标识无效');
  if (!Number.isSafeInteger(value.parentVersion) || Number(value.parentVersion) < 1
    || value.version !== Number(value.parentVersion) + 1) throw new Error('计划修订版本链无效');
  if (!Number.isFinite(value.appliedAt)) throw new Error('计划修订时间无效');
  for (const field of ['addedTaskIds', 'removedTaskIds', 'updatedTaskIds', 'changedRunFields'] as const) {
    const ids = value[field];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(ids).size !== ids.length) throw new Error('计划修订变更项无效');
  }
  const addedTaskIds = value.addedTaskIds as string[];
  const removedTaskIds = value.removedTaskIds as string[];
  const updatedTaskIds = value.updatedTaskIds as string[];
  if (new Set([...addedTaskIds, ...removedTaskIds, ...updatedTaskIds]).size
    !== addedTaskIds.length + removedTaskIds.length + updatedTaskIds.length) throw new Error('计划修订变更项冲突');
  if ((value.changedRunFields as string[]).some((field) => !PLAN_RUN_FIELDS.some((allowed) => allowed === field))) {
    throw new Error('计划修订运行字段无效');
  }
  return { schemaVersion: 1, runId: value.runId, parentVersion: value.parentVersion as number,
    version: value.version as number, appliedAt: value.appliedAt as number,
    addedTaskIds, removedTaskIds, updatedTaskIds, changedRunFields: value.changedRunFields as string[] };
}

export function appliedWorkflowPlanRevision(before: WorkflowSnapshot | null, after: WorkflowSnapshot): WorkflowPlanRevision | null {
  // Existing snapshots have no reliable revision history; start recording at the next change.
  if (!before) return null;
  if (after.run.id !== before.run.id) throw new Error('计划修订不能改变运行标识');
  if (after.run.planVersion === before.run.planVersion) return null;
  if (after.run.planVersion !== before.run.planVersion + 1) throw new Error('计划修订必须按版本顺序提交');
  const previous = new Map(before.tasks.map((task) => [task.id, task]));
  const nextIds = new Set(after.tasks.map((task) => task.id));
  return parseWorkflowPlanRevision({
    schemaVersion: 1, runId: after.run.id, parentVersion: before.run.planVersion,
    version: after.run.planVersion, appliedAt: after.run.updatedAt,
    addedTaskIds: after.tasks.filter((task) => !previous.has(task.id)).map((task) => task.id),
    removedTaskIds: before.tasks.filter((task) => !nextIds.has(task.id)).map((task) => task.id),
    updatedTaskIds: after.tasks.filter((task) => {
      const prior = previous.get(task.id);
      return prior && (task.kind !== prior.kind || task.status !== prior.status || task.attempt !== prior.attempt
        || JSON.stringify(task.input) !== JSON.stringify(prior.input)
        || JSON.stringify(task.dependsOn) !== JSON.stringify(prior.dependsOn));
    }).map((task) => task.id),
    changedRunFields: PLAN_RUN_FIELDS.filter((field) => JSON.stringify(before.run[field]) !== JSON.stringify(after.run[field])),
  });
}
