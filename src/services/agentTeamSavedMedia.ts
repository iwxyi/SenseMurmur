import { teamTaskMediaKind, type AgentTeamPlan, type AgentTeamTask } from './agentTeamPlan';
import { resolveTeamMediaTask } from './agentTeamMediaReference';
import { workflowJsonDigest } from './workflowToolRequest';
import { WorkflowPreflightError, type WorkflowSnapshot } from './workflowRunRuntime';

type SavedMedia = NonNullable<AgentTeamTask['savedMedia']>[number];

export function listTeamSavedMedia(snapshot: WorkflowSnapshot, sourceTaskIds: string[]): Omit<SavedMedia, 'alias'>[] {
  return sourceTaskIds.flatMap((id) => {
    const task = snapshot.tasks.find((item) => item.id === id);
    if (!task || task.status !== 'completed' || task.attempt < 1 || !task.input || typeof task.input !== 'object' || !('task' in task.input)) return [];
    const kind = teamTaskMediaKind(task.input.task as AgentTeamTask);
    if (kind !== 'video' && kind !== 'audio') return [];
    resolveTeamMediaTask(snapshot, id, kind);
    return [{ taskId: id, kind, attempt: task.attempt, outputSha256: workflowJsonDigest(task.output) }];
  });
}

export function assertTeamSavedMedia(plan: AgentTeamPlan, snapshot: WorkflowSnapshot, sourceTaskIds: string[]) {
  if (!plan.tasks.some((task) => task.savedMedia?.length)) return;
  const available = listTeamSavedMedia(snapshot, sourceTaskIds);
  for (const task of plan.tasks) for (const media of task.savedMedia || []) {
    if (!available.some((source) => source.taskId === media.taskId && source.kind === media.kind
      && source.attempt === media.attempt && source.outputSha256 === media.outputSha256)) {
      throw new WorkflowPreflightError('历史素材不属于本次规划范围或版本已变化');
    }
  }
}
