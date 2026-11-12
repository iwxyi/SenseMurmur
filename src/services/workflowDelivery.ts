import type { AssistantArtifactItem } from '../types/assistantArtifact';
import type { Message } from '../types/message';

export interface WorkflowArtifactProjection {
  before: AssistantArtifactItem | null;
  after: AssistantArtifactItem;
}

export interface WorkflowDelivery {
  schemaVersion: 1;
  runId: string;
  chatId: string;
  planVersion: number;
  preparedAt: number;
  artifacts: WorkflowArtifactProjection[];
  message: Message;
  previousMessageIdentity: string | null;
}

export type WorkflowDeliveryIssue = 'artifact_conflict' | 'message_conflict' | 'save_failed';

export class WorkflowDeliveryConflictError extends Error {
  readonly issue: 'artifact_conflict' | 'message_conflict';

  constructor(issue: 'artifact_conflict' | 'message_conflict', message: string) {
    super(message);
    this.issue = issue;
    this.name = 'WorkflowDeliveryConflictError';
  }
}

export function workflowDeliveryIssueLabel(issue: WorkflowDeliveryIssue) {
  return { artifact_conflict: '交付产物存在修改或删除冲突，已保留原内容。',
    message_conflict: '交付消息已被修改，已保留修改内容。',
    save_failed: '交付尚未保存完成。请检查本地存储或会话状态，再检查交付。' }[issue];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function artifact(value: unknown, chatId: string): value is AssistantArtifactItem {
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.chatId !== chatId
    || !['document', 'code', 'diagram', 'html', 'table', 'json', 'text'].includes(String(value.kind))
    || typeof value.title !== 'string' || typeof value.sourceMessageId !== 'string'
    || typeof value.currentVersionId !== 'string' || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)
    || !Array.isArray(value.versions) || !value.versions.length || value.versions.length > 12) return false;
  const ids = new Set<string>();
  return value.versions.every((version) => {
    if (!record(version) || typeof version.id !== 'string' || !version.id || ids.has(version.id)
      || version.artifactId !== value.id || typeof version.content !== 'string' || !Number.isFinite(version.createdAt)) return false;
    ids.add(version.id);
    return true;
  }) && ids.has(value.currentVersionId);
}

export function parseWorkflowDelivery(value: unknown): WorkflowDelivery {
  if (!record(value) || value.schemaVersion !== 1) throw new Error('工作流交付清单版本不受支持');
  if (typeof value.runId !== 'string' || !value.runId || typeof value.chatId !== 'string' || !value.chatId
    || !Number.isSafeInteger(value.planVersion) || Number(value.planVersion) < 1 || !Number.isFinite(value.preparedAt)
    || !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 80
    || (value.previousMessageIdentity !== null && typeof value.previousMessageIdentity !== 'string')) throw new Error('工作流交付清单无效');
  const ids = new Set<string>();
  for (const entry of value.artifacts) {
    if (!record(entry) || !artifact(entry.after, value.chatId) || ids.has(entry.after.id)
      || (entry.before !== null && (!artifact(entry.before, value.chatId) || entry.before.id !== entry.after.id))) {
      throw new Error('工作流交付产物无效');
    }
    ids.add(entry.after.id);
  }
  const message = value.message;
  if (!record(message) || message.id !== `team-delivery-${value.runId}` || message.clientKey !== message.id
    || message.chatId !== value.chatId || message.type !== 'ai' || message.senderId !== 'assistant'
    || typeof message.content !== 'string' || !Number.isFinite(message.timestamp) || message.isDeleted !== false
    || !record(message.metadata) || !record(message.metadata.assistant) || !Array.isArray(message.metadata.assistant.artifacts)) {
    throw new Error('工作流交付消息无效');
  }
  const refs = message.metadata.assistant.artifacts;
  if (refs.length !== value.artifacts.length || value.artifacts.some((entry, index) => {
    const ref: unknown = refs[index];
    return !record(ref) || ref.id !== entry.after.id || ref.versionId !== entry.after.currentVersionId
      || ref.kind !== entry.after.kind || ref.title !== entry.after.title;
  })) throw new Error('工作流交付消息与产物不一致');
  return value as unknown as WorkflowDelivery;
}

// Ignore cloud bookkeeping, but compare the exact authored item and versions.
export function workflowArtifactIdentity(item: AssistantArtifactItem | null) {
  if (!item) return null;
  return JSON.stringify({ id: item.id, chatId: item.chatId, kind: item.kind, title: item.title, summary: item.summary,
    language: item.language, sourceMessageId: item.sourceMessageId, deletedAt: item.deletedAt ?? null,
    currentVersionId: item.currentVersionId, versions: item.versions, dataDescriptor: item.dataDescriptor });
}

export function workflowDeliveryMessageIdentity(message: Message | undefined) {
  return message ? JSON.stringify({ content: message.content, isDeleted: message.isDeleted,
    type: message.type, metadata: message.metadata }) : null;
}

export function projectWorkflowArtifacts(items: AssistantArtifactItem[], projections: WorkflowArtifactProjection[]): AssistantArtifactItem[] {
  for (const { before, after } of projections) {
    const current = items.find((item) => item.id === after.id) ?? null;
    const identity = workflowArtifactIdentity(current);
    if (identity !== workflowArtifactIdentity(before) && identity !== workflowArtifactIdentity(after)) {
      throw new WorkflowDeliveryConflictError('artifact_conflict', '交付产物已被修改或删除，请先处理版本冲突后重试');
    }
    if (!current && items.some((item) => item.chatId === after.chatId && item.sourceMessageId === after.sourceMessageId)) {
      throw new WorkflowDeliveryConflictError('artifact_conflict', '交付来源已被其他产物占用，请先处理版本冲突后重试');
    }
  }
  const replacements = new Map(projections.map(({ after }) => [after.id, after]));
  return [...projections.filter(({ after }) => !items.some((item) => item.id === after.id)).map(({ after }) => after),
    ...items.map((item) => {
      const replacement = replacements.get(item.id);
      return replacement && workflowArtifactIdentity(item) !== workflowArtifactIdentity(replacement)
        ? { ...replacement, sortOrder: item.sortOrder } : item;
    })];
}
