import type { AgentTeamPlan, AgentTeamTask } from './agentTeamPlan';
import type { AgentTeamSavedText } from './agentTeamSavedText';
import { workflowJsonDigest } from './workflowToolRequest';

type SavedMedia = NonNullable<AgentTeamTask['savedMedia']>[number];

export interface TeamRevisionBase {
  plan: AgentTeamPlan;
  targetTaskId: string;
  taskSources?: Record<string, string>;
  savedText: Omit<AgentTeamSavedText, 'alias'>[];
  savedMedia: Omit<SavedMedia, 'alias'>[];
}

export interface TeamRevisionCompilation {
  schemaVersion: 1;
  basePlanSha256: string;
  changedTaskIds: string[];
  rerunTaskIds: string[];
  reusedTaskIds: string[];
}

export function parseTeamRevisionCompilation(raw: unknown): TeamRevisionCompilation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('局部重做记录无效');
  const value = raw as Record<string, unknown>;
  const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length <= 48
    && ids.every((id) => typeof id === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(id)) && new Set(ids).size === ids.length;
  if (value.schemaVersion !== 1 || typeof value.basePlanSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.basePlanSha256)
    || !validIds(value.changedTaskIds) || !value.changedTaskIds.length || !validIds(value.rerunTaskIds)
    || !validIds(value.reusedTaskIds) || value.changedTaskIds.some((id) => !(value.rerunTaskIds as string[]).includes(id))
    || value.reusedTaskIds.some((id) => (value.rerunTaskIds as string[]).includes(id))) throw new Error('局部重做记录版本或范围无效');
  return { schemaVersion: 1, basePlanSha256: value.basePlanSha256,
    changedTaskIds: [...value.changedTaskIds], rerunTaskIds: [...value.rerunTaskIds], reusedTaskIds: [...value.reusedTaskIds] };
}

// Keep scheduling and saved source versions in the compiled plan; never fabricate completed tasks.
export function compileTeamRevisionPatch(raw: unknown, base: TeamRevisionBase): AgentTeamPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('局部修订格式无效');
  const patch = raw as Record<string, unknown>;
  if (patch.schemaVersion !== 1 || patch.basePlanSha256 !== workflowJsonDigest(base.plan)
    || Object.keys(patch).some((key) => !['schemaVersion', 'basePlanSha256', 'updates'].includes(key))
    || !Array.isArray(patch.updates) || !patch.updates.length || patch.updates.length > 48) throw new Error('局部修订的原计划版本或修改列表无效');
  const byId = new Map(base.plan.tasks.map((task) => [task.id, task]));
  if (byId.size !== base.plan.tasks.length || !byId.has(base.targetTaskId)
    || base.plan.tasks.some((task) => task.tool === 'delegate_task')) throw new Error('当前计划不支持局部修订，请完整重规划');
  if (base.taskSources && (Object.keys(base.taskSources).length !== byId.size
    || Object.keys(base.taskSources).some((id) => !byId.has(id))
    || Object.values(base.taskSources).some((id) => typeof id !== 'string' || !id.trim())
    || new Set(Object.values(base.taskSources)).size !== byId.size)) throw new Error('局部修订的运行任务对应关系无效');
  const updates = new Map<string, { goal: string; acceptance: string }>();
  for (const rawUpdate of patch.updates) {
    if (!rawUpdate || typeof rawUpdate !== 'object' || Array.isArray(rawUpdate)) throw new Error('局部修订条目无效');
    const update = rawUpdate as Record<string, unknown>;
    const source = typeof update.taskId === 'string' ? byId.get(update.taskId) : undefined;
    if (!source || updates.has(source.id) || Object.keys(update).some((key) => !['taskId', 'goal', 'acceptance'].includes(key))
      || typeof update.goal !== 'string' || !update.goal.trim() || update.goal.length > 1200
      || typeof update.acceptance !== 'string' || !update.acceptance.trim() || update.acceptance.length > 800) throw new Error('局部修订任务、目标或验收无效');
    const next = { goal: update.goal.trim(), acceptance: update.acceptance.trim() };
    if (next.goal === source.goal && next.acceptance === source.acceptance) throw new Error('局部修订没有改变任务要求');
    updates.set(source.id, next);
  }
  if (!updates.has(base.targetTaskId)) throw new Error('局部修订没有包含指定任务');
  const affected = new Set(updates.keys());
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of base.plan.tasks) if (!affected.has(task.id) && task.dependsOn.some((id) => affected.has(id))) {
      affected.add(task.id);
      grew = true;
    }
  }
  const reused = new Set<string>();
  const tasks = base.plan.tasks.filter((task) => affected.has(task.id)).map((task): AgentTeamTask => {
    const savedText = [...(task.savedText ?? [])];
    const savedMedia = [...(task.savedMedia ?? [])];
    for (const id of task.dependsOn.filter((id) => !affected.has(id))) {
      const sourceId = base.taskSources?.[id] ?? id;
      const media = base.savedMedia.find((entry) => entry.taskId === sourceId);
      if (media) savedMedia.push({ ...media, alias: id });
      else {
        const text = base.savedText.find((entry) => entry.taskId === sourceId && !entry.artifact);
        if (!text) throw new Error('局部修订缺少可固定版本的上游交付，请完整重规划');
        savedText.push({ ...text, alias: id });
      }
      reused.add(id);
    }
    return { ...task, ...updates.get(task.id), dependsOn: task.dependsOn.filter((id) => affected.has(id)),
      ...(savedText.length ? { savedText } : {}), ...(savedMedia.length ? { savedMedia } : {}) };
  });
  const revisionCompilation = parseTeamRevisionCompilation({ schemaVersion: 1, basePlanSha256: patch.basePlanSha256,
    changedTaskIds: [...updates.keys()], rerunTaskIds: tasks.map((task) => task.id), reusedTaskIds: [...reused] });
  return { schemaVersion: 1, summary: '按新要求修订任务及其下游，复用未变化的上游交付',
    roles: base.plan.roles.filter((role) => tasks.some((task) => task.roleId === role.id)), tasks,
    finalAcceptance: base.plan.finalAcceptance,
    ...(base.plan.resultTaskId && affected.has(base.plan.resultTaskId) ? { resultTaskId: base.plan.resultTaskId } : {}),
    revisionCompilation };
}
