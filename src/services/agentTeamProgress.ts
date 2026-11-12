import type { WorkflowSnapshot, WorkflowTask } from './workflowRunRuntime';

function normalized(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function reviewSources(task: WorkflowTask): string[] | null {
  if (!task.input || typeof task.input !== 'object' || !('sourceTaskIds' in task.input)) return null;
  const ids: unknown = task.input.sourceTaskIds;
  return Array.isArray(ids) && ids.every((id): id is string => typeof id === 'string') ? ids : null;
}

function nextRequest(task: WorkflowTask): string | null {
  if (!task.output || typeof task.output !== 'object' || !('complete' in task.output)
    || task.output.complete !== false || !('nextRequest' in task.output) || typeof task.output.nextRequest !== 'string') return null;
  return normalized(task.output.nextRequest);
}

/** Only identical text evidence is conclusive; media completion summaries cannot establish progress. */
export function hasRepeatedTeamReviewWithoutProgress(snapshot: WorkflowSnapshot, reviewId: string): boolean {
  const index = snapshot.tasks.findIndex((task) => task.id === reviewId);
  const current = snapshot.tasks[index];
  if (!current || current.kind !== 'team_review' || current.status !== 'completed') return false;
  const previous = snapshot.tasks.slice(0, index).filter((task) => task.kind === 'team_review' && task.status === 'completed').at(-1);
  if (!previous || !nextRequest(current) || nextRequest(current) !== nextRequest(previous)) return false;
  const beforeIds = reviewSources(previous);
  const afterIds = reviewSources(current);
  if (!beforeIds?.length || !afterIds?.length) return false;
  const beforeSet = new Set(beforeIds);
  const newTasks = afterIds.filter((id) => !beforeSet.has(id)).map((id) => snapshot.tasks.find((task) => task.id === id));
  if (!newTasks.length || newTasks.some((task) => !task || !['agent_text', 'agent_web_search'].includes(task.kind))) return false;
  const outputs = (ids: string[]) => ids.map((id) => snapshot.tasks.find((task) => task.id === id))
    .map((task) => task?.status === 'completed' && typeof task.output === 'string' ? normalized(task.output) : null);
  const before = outputs(beforeIds);
  const after = outputs(afterIds);
  if (before.some((output) => !output) || after.some((output) => !output)) return false;
  const beforeOutputs = new Set(before);
  const afterOutputs = new Set(after);
  return beforeOutputs.size === afterOutputs.size && [...beforeOutputs].every((output) => afterOutputs.has(output));
}
