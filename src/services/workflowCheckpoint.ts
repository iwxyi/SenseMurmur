import { api, ApiError } from './api';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getChatExecutionFence } from './chatExecutionFence';
import { workflowJsonDigest } from './workflowToolRequest';
import { assertWorkflowSnapshot, indexedDbWorkflowRepository, type WorkflowRepositoryCheckpoint } from './workflowRunRuntime';
import { parseWorkflowTaskAttempt } from './workflowTaskAttempt';
import { parseWorkflowPlanRevision } from './workflowPlanRevision';

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
  for (const event of data.outbox) {
    if (!event || event.runId !== runId || !Number.isSafeInteger(event.sequence) || event.sequence < 1
      || event.eventId !== `${runId}:${event.sequence}` || event.aggregateVersion !== event.sequence) throw new Error('工作流检查点事件无效');
  }
  for (const rawAttempt of data.attempts) {
    const attempt = parseWorkflowTaskAttempt(rawAttempt);
    if (attempt.runId !== runId || !snapshot.tasks.some((task) => task.id === attempt.taskId)) throw new Error('工作流检查点执行记录无效');
  }
  for (const rawRevision of data.revisions) {
    if (parseWorkflowPlanRevision(rawRevision).runId !== runId) throw new Error('工作流检查点修订记录无效');
  }
  const maxSequence = Math.max(0, ...data.outbox.map((event) => event.sequence));
  for (const consumer of data.consumers) {
    if (!consumer || typeof consumer.consumerId !== 'string' || !consumer.consumerId
      || !Number.isSafeInteger(consumer.acknowledgedThrough) || consumer.acknowledgedThrough < 0
      || consumer.acknowledgedThrough > maxSequence) throw new Error('工作流检查点消费回执无效');
  }
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

const pendingPushes = new Map<string, Promise<unknown>>();

export async function pushWorkflowCheckpoint(scope: string, runId: string) {
  const key = `${scope}\n${runId}`;
  const previous = pendingPushes.get(key);
  const operation = (async () => {
    if (previous) await previous;
    return pushWorkflowCheckpointOnce(scope, runId);
  })();
  pendingPushes.set(key, operation);
  try { return await operation; }
  finally { if (pendingPushes.get(key) === operation) pendingPushes.delete(key); }
}

async function pushWorkflowCheckpointOnce(scope: string, runId: string) {
  const data = await indexedDbWorkflowRepository.exportCheckpoint(scope, runId);
  if (!data) throw new Error('本机工作流不存在');
  const snapshot = data.snapshot;
  const cursor = await indexedDbWorkflowRepository.readCheckpointSync(scope, runId);
  const remote = await api.getWorkflowCheckpoint(runId).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (remote && (remote.chatId !== snapshot.run.chatId || !cursor
    || remote.revision !== cursor.revision || remote.sha256 !== cursor.sha256)) {
    throw new Error('远端工作流已有不同进度，请先核对后接管，不能覆盖');
  }
  if (!remote && cursor) throw new Error('远端工作流检查点已丢失，不能按旧游标继续');
  const saved = await saveWorkflowCheckpoint(data, cursor?.revision ?? 0);
  await indexedDbWorkflowRepository.saveCheckpointSync(scope, runId, { revision: saved.revision, sha256: saved.sha256 });
  return saved;
}

export async function assertWorkflowCheckpointCurrent(scope: string, runId: string, chatId: string) {
  const cursor = await indexedDbWorkflowRepository.readCheckpointSync(scope, runId);
  const remote = await api.getWorkflowCheckpoint(runId).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (remote?.chatId !== undefined && remote.chatId !== chatId) throw new Error('远端工作流不属于当前会话');
  if (remote && (!cursor || remote.revision !== cursor.revision || remote.sha256 !== cursor.sha256)) {
    throw new Error('远端工作流已有不同进度，请先核对后接管，不能继续执行');
  }
  if (!remote && cursor) throw new Error('远端工作流检查点已丢失，不能按旧游标继续');
}

export async function pullNewWorkflowCheckpoint(scope: string, runId: string, chatId: string) {
  const current = await indexedDbWorkflowRepository.read(scope, runId);
  if (current) throw new Error('本机已有工作流，不能用远端检查点覆盖');
  const remote = await api.getWorkflowCheckpoint(runId);
  if (remote.chatId !== chatId) throw new Error('远端工作流不属于当前会话');
  const checkpoint = validateWorkflowCheckpoint(remote.payload, runId, chatId);
  if (!Number.isSafeInteger(remote.revision) || remote.revision < 1 || !/^[a-f0-9]{64}$/.test(remote.sha256)) {
    throw new Error('远端工作流检查点修订无效');
  }
  if (bytesToHex(sha256(utf8ToBytes(JSON.stringify(remote.payload)))) !== remote.sha256) throw new Error('远端工作流检查点摘要不一致');
  await indexedDbWorkflowRepository.importCheckpoint(scope, checkpoint.data);
  await indexedDbWorkflowRepository.saveCheckpointSync(scope, runId, { revision: remote.revision, sha256: remote.sha256 });
  return checkpoint.data.snapshot;
}
