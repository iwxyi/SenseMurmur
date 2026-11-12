import { teamTaskMediaKind, validateAgentTeamPlan, type AgentTeamTask } from './agentTeamPlan';
import { WorkflowPreflightError, type WorkflowSnapshot, type WorkflowTask } from './workflowRunRuntime';

type MediaKind = NonNullable<AgentTeamTask['mediaOutput']>;
const CONCRETE_KINDS: Record<MediaKind, string[]> = {
  image: ['agent_image'], video: ['agent_video', 'agent_media_composition'], audio: ['agent_audio'],
};

function taskInput(task: WorkflowTask) {
  const input = task.input;
  if (!input || typeof input !== 'object' || !('task' in input)
    || !input.task || typeof input.task !== 'object') throw new WorkflowPreflightError('媒体来源任务契约无效');
  return input as { task: AgentTeamTask; sourcePlanTaskId?: string };
}

export function assertTeamMediaOutput(plan: ReturnType<typeof validateAgentTeamPlan>, expected: MediaKind) {
  if (!plan.resultTaskId || teamTaskMediaKind(plan.tasks.find((task) => task.id === plan.resultTaskId)) !== expected) {
    throw new WorkflowPreflightError('下级计划未指定符合父任务要求的媒体交付');
  }
}

// Resolve through saved plan membership, never through summary text or guessed URLs.
function resolve(snapshot: WorkflowSnapshot, task: WorkflowTask, expected: MediaKind, visited: Set<string>, depth: number): string {
  if (task.runId !== snapshot.run.id || visited.has(task.id) || depth > 3) throw new WorkflowPreflightError('媒体交付来源无效或形成循环');
  visited.add(task.id);
  const input = taskInput(task);
  if (teamTaskMediaKind(input.task) !== expected) throw new WorkflowPreflightError('媒体交付类型与使用要求不一致');
  if (task.kind !== 'agent_delegation') {
    if (!CONCRETE_KINDS[expected].includes(task.kind) || task.status !== 'completed') throw new WorkflowPreflightError('媒体来源任务尚未完成或类型无效');
    return task.id;
  }
  if (input.task.tool !== 'delegate_task' || !task.expansion) throw new WorkflowPreflightError('媒体委派尚无已保存的下级计划');
  let plan: ReturnType<typeof validateAgentTeamPlan>;
  try { plan = validateAgentTeamPlan(task.expansion.context); }
  catch (error) { throw new WorkflowPreflightError(error instanceof Error ? error.message : '媒体交付计划无效'); }
  assertTeamMediaOutput(plan, expected);
  const exported = plan.tasks.find((item) => item.id === plan.resultTaskId)!;
  const candidates = snapshot.tasks.filter((item) => {
    if (!task.expansion!.taskIds.includes(item.id)) return false;
    const child = taskInput(item);
    return child.sourcePlanTaskId === task.id && child.task.id === exported.id;
  });
  if (candidates.length !== 1) throw new WorkflowPreflightError('媒体交付任务缺失或重复');
  const child = candidates[0];
  if (child.status !== 'completed' || JSON.stringify(taskInput(child).task) !== JSON.stringify(exported)) {
    throw new WorkflowPreflightError('媒体交付尚未完成或与已保存计划不一致');
  }
  return resolve(snapshot, child, expected, visited, depth + 1);
}

export function resolveTeamMediaTask(snapshot: WorkflowSnapshot, taskId: string, expected: MediaKind): string {
  const task = snapshot.tasks.find((item) => item.id === taskId);
  if (!task || task.status !== 'completed') throw new WorkflowPreflightError('媒体来源任务尚未完成');
  return resolve(snapshot, task, expected, new Set(), 0);
}

export function resolveTeamDelegationMedia(snapshot: WorkflowSnapshot, task: WorkflowTask, expected: MediaKind): string {
  if (task.kind !== 'agent_delegation') throw new WorkflowPreflightError('媒体来源不是委派任务');
  return resolve(snapshot, task, expected, new Set(), 0);
}
