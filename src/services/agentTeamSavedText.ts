import { teamTaskMediaKind, type AgentTeamTask } from './agentTeamPlan';
import { workflowJsonDigest } from './workflowToolRequest';
import { WorkflowPreflightError, type WorkflowSnapshot } from './workflowRunRuntime';

export interface AgentTeamSavedText {
  alias: string;
  taskId: string;
  attempt: number;
  outputSha256: string;
}

const TEXT_KINDS = new Set(['agent_text', 'agent_web_search', 'agent_image_inspection', 'agent_video_inspection', 'agent_delegation']);

export function listTeamSavedText(snapshot: WorkflowSnapshot, sourceTaskIds: string[]): Omit<AgentTeamSavedText, 'alias'>[] {
  const allowed = new Set(sourceTaskIds);
  return snapshot.tasks.flatMap((task) => {
    if (!allowed.has(task.id) || task.runId !== snapshot.run.id || task.status !== 'completed' || task.attempt < 1
      || !TEXT_KINDS.has(task.kind) || typeof task.output !== 'string' || !task.output.trim() || task.output.length > 12_000) return [];
    if (task.kind === 'agent_delegation') {
      const input = task.input;
      if (!input || typeof input !== 'object' || !('task' in input) || !input.task || typeof input.task !== 'object' || Array.isArray(input.task)
        || teamTaskMediaKind(input.task as AgentTeamTask)) return [];
    }
    return [{ taskId: task.id, attempt: task.attempt, outputSha256: workflowJsonDigest(task.output) }];
  });
}

export function resolveTeamSavedText(task: AgentTeamTask, snapshot: WorkflowSnapshot, sourceTaskIds: string[]) {
  if (!task.savedText?.length) return [];
  const available = listTeamSavedText(snapshot, sourceTaskIds);
  return task.savedText.map((reference) => {
    if (!available.some((source) => source.taskId === reference.taskId && source.attempt === reference.attempt
      && source.outputSha256 === reference.outputSha256)) throw new WorkflowPreflightError('历史文字交付不属于本次规划范围、正文过长或版本已变化');
    const source = snapshot.tasks.find((item) => item.id === reference.taskId)!;
    return { alias: reference.alias, taskId: reference.taskId, content: source.output as string };
  });
}
