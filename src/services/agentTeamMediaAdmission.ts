import type { Message, MessageAttachment, MessageAttachmentKind } from '../types/message';
import type { WorkflowUsageReference } from '../types/workflowUsage';
import { useMessageStore } from '../stores/useMessageStore';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { workflowAdmissionBlockReason } from './workflowAdmission';

export function inspectTeamMediaAdmission(attachment: MessageAttachment) {
  if (attachment.status !== 'failed' || attachment.mediaTaskId || !attachment.admissionRejection) return null;
  const reason = workflowAdmissionBlockReason(Object.assign(new Error(), attachment.admissionRejection));
  return reason ? { status: 'queued' as const, admissionRejected: true as const, error: reason } : null;
}

export function recoverTeamMediaAdmission(message: Message | null, kind: MessageAttachmentKind, usage?: WorkflowUsageReference): Message | null {
  if (!message) return null;
  const rejected = message.metadata?.attachments?.find((item) => item.kind === kind && inspectTeamMediaAdmission(item));
  if (!rejected) return message;
  const next: Message = { ...message, metadata: { ...message.metadata, workflowUsage: usage,
    attachments: message.metadata?.attachments?.map((item) => item.id === rejected.id
      ? { ...item, status: 'queued', error: undefined, admissionRejection: undefined, generationJobId: undefined, updatedAt: Date.now() } : item) } };
  const state = useMessageStore.getState();
  state.upsertMessage(next);
  state.queueMessageSync(next);
  flushBufferedPersistenceWrites();
  return next;
}
