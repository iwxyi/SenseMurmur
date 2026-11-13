import { api } from './api';
import { getChatExecutionFence } from './chatExecutionFence';
import { workflowJsonDigest } from './workflowToolRequest';
import { assertWorkflowSnapshot, type WorkflowRepositoryCheckpoint, type WorkflowSnapshot } from './workflowRunRuntime';

export interface WorkflowCheckpoint {
  schemaVersion: 1;
  data: WorkflowRepositoryCheckpoint;
}

export function validateWorkflowCheckpoint(raw: unknown, runId: string, chatId: string): WorkflowCheckpoint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工作流检查点无效');
  const value = raw as Record<string, unknown>;
  const data = value.data as WorkflowRepositoryCheckpoint | undefined;
  const snapshot = data?.snapshot;
  if (value.schemaVersion !== 1 || !snapshot || snapshot.schemaVersion !== 1
    || snapshot.run?.schemaVersion !== 1 || snapshot.run.id !== runId || snapshot.run.chatId !== chatId
    || !Array.isArray(snapshot.tasks) || snapshot.tasks.some((task) => task.schemaVersion !== 1)) {
    throw new Error('工作流检查点版本或归属无效');
  }
  assertWorkflowSnapshot(snapshot);
  if (!Array.isArray(data.outbox) || !Array.isArray(data.attempts)
    || !Array.isArray(data.revisions) || !Array.isArray(data.consumers)) throw new Error('工作流检查点历史无效');
  workflowJsonDigest(value);
  return value as unknown as WorkflowCheckpoint;
}

export async function saveWorkflowCheckpoint(data: WorkflowRepositoryCheckpoint, expectedRevision: number) {
  const snapshot = data.snapshot;
  const fence = getChatExecutionFence(snapshot.run.chatId);
  if (!fence) throw new Error('同步工作流前必须取得会话运行权');
  const payload = validateWorkflowCheckpoint({ schemaVersion: 1, data }, snapshot.run.id, snapshot.run.chatId);
  return api.putWorkflowCheckpoint(snapshot.run.id, { chatId: snapshot.run.chatId, expectedRevision, executionFence: fence, payload });
}
