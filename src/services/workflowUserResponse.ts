import { workflowJsonDigest } from './workflowToolRequest';

export interface WorkflowUserResponse {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  planVersion: number;
  actor: 'local_user';
  respondedAt: number;
  inputSha256: string;
  outputSha256: string;
}

export function createWorkflowUserResponse(task: { id: string; runId: string; input: unknown }, planVersion: number,
  output: string, respondedAt: number): WorkflowUserResponse {
  return { schemaVersion: 1, runId: task.runId, taskId: task.id, planVersion, actor: 'local_user', respondedAt,
    inputSha256: workflowJsonDigest(task.input), outputSha256: workflowJsonDigest(output) };
}

export function assertWorkflowUserResponse(task: { id: string; runId: string; input: unknown; output?: unknown; kind: string;
  status: string; userResponse?: WorkflowUserResponse }, planVersion: number) {
  const record = task.userResponse;
  if (record === undefined) {
    if (task.kind === 'agent_user_input' && task.status === 'completed') throw new Error('用户答复缺少版本依据');
    return;
  }
  if (!record || typeof record !== 'object' || record.schemaVersion !== 1 || record.actor !== 'local_user'
    || record.runId !== task.runId || record.taskId !== task.id || !Number.isSafeInteger(record.planVersion)
    || record.planVersion < 1 || record.planVersion >= planVersion || !Number.isFinite(record.respondedAt) || record.respondedAt < 0
    || task.kind !== 'agent_user_input' || task.status !== 'completed' || typeof task.output !== 'string'
    || !task.output.trim() || task.output.length > 4000
    || record.inputSha256 !== workflowJsonDigest(task.input) || record.outputSha256 !== workflowJsonDigest(task.output)) {
    throw new Error('用户答复版本或范围无效');
  }
}
