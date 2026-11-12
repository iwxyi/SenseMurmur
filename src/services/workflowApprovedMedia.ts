import type { Message, MessageAttachment } from '../types/message';
import { currentWorkflowScope, indexedDbWorkflowRepository } from './workflowRunRuntime';
import { parsePreparedMediaExecution } from './preparedMediaExecution';
import { workflowJsonDigest } from './workflowToolRequest';

export async function readApprovedWorkflowMedia(message: Message, attachment: MessageAttachment) {
  if (!attachment.executionQuoteId) return undefined;
  const usage = message.metadata?.workflowUsage;
  const scope = currentWorkflowScope();
  if (!usage || usage.kind !== 'tool') throw new Error('媒体任务缺少执行审批归属');
  const snapshot = await indexedDbWorkflowRepository.read(scope, usage.runId);
  const task = snapshot?.tasks.find((item) => item.id === usage.taskId);
  const approval = task?.approvals?.at(-1);
  if (currentWorkflowScope() !== scope || !snapshot || snapshot.run.chatId !== message.chatId
    || snapshot.run.status !== 'active' || snapshot.run.pauseRequested || task?.status !== 'running'
    || task.attempt !== usage.attempt || task.toolInvocation?.state !== 'started'
    || !approval || approval.attempt !== usage.attempt || approval.invalidatedAt !== undefined || approval.decision?.outcome !== 'approved'
    || approval.mediaExecution?.quote.id !== attachment.executionQuoteId) throw new Error('媒体执行审批已失效，请从任务工作台核对后继续');
  const execution = parsePreparedMediaExecution(approval.mediaExecution);
  const metadata = execution.request.metadata as { aiUsage?: { resourceId?: string; workflow?: unknown } } | undefined;
  if (metadata?.aiUsage?.resourceId !== message.chatId || workflowJsonDigest(metadata.aiUsage.workflow ?? null) !== workflowJsonDigest(usage)
    || execution.request.client_request_key !== attachment.generationJobId) throw new Error('媒体请求与获批步骤不一致');
  return execution;
}
