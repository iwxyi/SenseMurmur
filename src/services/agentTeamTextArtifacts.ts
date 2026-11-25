import type { AssistantArtifactItem } from '../types/assistantArtifact';
import type { WorkflowSnapshot } from './workflowRunRuntime';
import type { WorkflowArtifactProjection } from './workflowDelivery';
import { sanitizeUserFacingText } from './displayTextSanitizer';
import { workflowJsonDigest } from './workflowToolRequest';
import { ensureAssistantArtifactStoreHydrated, useAssistantArtifactStore } from '../stores/useAssistantArtifactStore';
import { commitBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { getLocalDataUserId } from './authStorageScope';
import { scopedStorageKey } from '../constants/brand';

export function completedTeamTextArtifactProjections(snapshot: WorkflowSnapshot, existing: AssistantArtifactItem[]): WorkflowArtifactProjection[] {
  const bySource = new Map(existing.filter((item) => item.chatId === snapshot.run.chatId && item.deletedAt == null)
    .map((item) => [item.sourceMessageId, item]));
  return snapshot.tasks.flatMap((task) => {
    if (task.kind !== 'agent_text' || task.status !== 'completed' || typeof task.output !== 'string' || !task.output.trim()) return [];
    const input = task.input && typeof task.input === 'object' ? task.input as {
      task?: { goal?: string; acceptance?: string; deliverable?: { kind?: AssistantArtifactItem['kind']; title?: string; language?: string } };
    } : undefined;
    const sourceMessageId = `team-delivery-${snapshot.run.id}:${task.id}`;
    const current = bySource.get(sourceMessageId);
    const id = current?.id || `team-artifact-${sourceMessageId}`;
    const versionId = `${id}:task:${task.attempt}:${workflowJsonDigest(task.output).slice(0, 12)}`;
    if (current?.versions.find((version) => version.id === current.currentVersionId)?.content === task.output) return [];
    if (current?.versions.some((version) => version.id === versionId)) return [];
    const version = {
      id: versionId, artifactId: id, content: task.output,
      language: input?.task?.deliverable?.language || null,
      sourceMessageId, baseVersionId: current?.currentVersionId || null,
      createdAt: task.updatedAt, updatedAt: task.updatedAt, revision: (current?.revision || 0) + 1,
    };
    const after: AssistantArtifactItem = {
      ...current,
      id, chatId: snapshot.run.chatId,
      kind: input?.task?.deliverable?.kind || 'document',
      title: sanitizeUserFacingText(input?.task?.deliverable?.title || input?.task?.goal || '任务结果').slice(0, 80),
      summary: sanitizeUserFacingText(input?.task?.acceptance || '').slice(0, 300),
      language: input?.task?.deliverable?.language || null,
      sourceMessageId,
      currentVersionId: versionId,
      versions: [...(current?.versions || []), version].slice(-12),
      revision: (current?.revision || 0) + 1,
      createdAt: current?.createdAt || task.updatedAt,
      updatedAt: task.updatedAt,
      deletedAt: null,
      sortOrder: current?.sortOrder ?? task.updatedAt,
    };
    return [{ before: current || null, after }];
  });
}

export async function publishCompletedTeamTextArtifacts(snapshot: WorkflowSnapshot) {
  const account = getLocalDataUserId();
  const storageKey = scopedStorageKey(`assistant-artifacts-${account}`);
  await ensureAssistantArtifactStoreHydrated();
  if (getLocalDataUserId() !== account) throw new Error('账号已切换，已停止保存文字产物');
  const store = useAssistantArtifactStore.getState();
  const projections = completedTeamTextArtifactProjections(snapshot, store.getArtifactsForChat(snapshot.run.chatId));
  if (projections.length) store.applyWorkflowDelivery(projections, { syncToCloud: false });
  const sources = new Set(snapshot.tasks.filter((task) => task.kind === 'agent_text' && task.status === 'completed'
    && typeof task.output === 'string' && task.output.trim()).map((task) => `team-delivery-${snapshot.run.id}:${task.id}`));
  const artifactIds = store.getArtifactsForChat(snapshot.run.chatId).filter((item) => sources.has(item.sourceMessageId)).map((item) => item.id);
  if (!artifactIds.length) return 0;
  await commitBufferedPersistenceWrites([storageKey]);
  if (getLocalDataUserId() !== account) throw new Error('账号已切换，已停止保存文字产物');
  await store.confirmWorkflowArtifactsInCloud(snapshot.run.chatId, artifactIds);
  return projections.length;
}
