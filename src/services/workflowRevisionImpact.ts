import type { WorkflowSnapshot } from './workflowRunRuntime';

export interface WorkflowRevisionImpact {
  schemaVersion: 1;
  basePlanVersion: number;
  targetTaskId: string;
  affectedTaskIds: string[];
  generatedMediaTaskIds: string[];
}

const GENERATED_MEDIA_KINDS = new Set(['agent_image', 'agent_audio', 'agent_video']);

// Dependency edges include saved delegation and context dependencies, so the analysis is conservative.
export function analyzeWorkflowRevisionImpact(snapshot: WorkflowSnapshot, targetTaskId: string): WorkflowRevisionImpact {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  if (byId.size !== snapshot.tasks.length || !byId.has(targetTaskId)) throw new Error('修订目标不存在或任务重复');
  const consumers = new Map<string, string[]>();
  for (const task of snapshot.tasks) {
    if (task.runId !== snapshot.run.id) throw new Error('修订任务不属于当前工作流');
    for (const id of task.dependsOn) {
      if (!byId.has(id)) throw new Error('修订依赖任务不存在');
      const list = consumers.get(id) ?? [];
      list.push(task.id);
      consumers.set(id, list);
    }
  }
  const affected = new Set([targetTaskId]);
  const pending = [targetTaskId];
  for (let index = 0; index < pending.length; index += 1) {
    for (const id of consumers.get(pending[index]) ?? []) {
      if (affected.has(id)) continue;
      affected.add(id);
      pending.push(id);
    }
  }
  const affectedTasks = snapshot.tasks.filter((task) => affected.has(task.id));
  return { schemaVersion: 1, basePlanVersion: snapshot.run.planVersion, targetTaskId,
    affectedTaskIds: affectedTasks.map((task) => task.id),
    generatedMediaTaskIds: affectedTasks.filter((task) => GENERATED_MEDIA_KINDS.has(task.kind) && task.attempt > 0).map((task) => task.id) };
}

export function parseWorkflowRevisionImpact(raw: unknown): WorkflowRevisionImpact {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('修订影响范围无效');
  const value = raw as Record<string, unknown>;
  const validIds = (ids: unknown): ids is string[] => Array.isArray(ids)
    && ids.every((id) => typeof id === 'string' && Boolean(id.trim())) && new Set(ids).size === ids.length;
  const affectedTaskIds = value.affectedTaskIds;
  const generatedMediaTaskIds = value.generatedMediaTaskIds;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.basePlanVersion) || Number(value.basePlanVersion) < 1
    || typeof value.targetTaskId !== 'string' || !validIds(affectedTaskIds) || !affectedTaskIds.includes(value.targetTaskId)
    || !validIds(generatedMediaTaskIds) || generatedMediaTaskIds.some((id) => !affectedTaskIds.includes(id))) throw new Error('修订影响范围版本或内容无效');
  return { schemaVersion: 1, basePlanVersion: Number(value.basePlanVersion), targetTaskId: value.targetTaskId,
    affectedTaskIds: [...affectedTaskIds], generatedMediaTaskIds: [...generatedMediaTaskIds] };
}
