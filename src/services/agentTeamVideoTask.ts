import type { Message } from '../types/message';
import type { WorkflowUsageReference } from '../types/workflowUsage';
import { getUsablePreferredAIProfile, type AIModelProfile } from '../types/settings';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { attachMessageToActiveBranch } from './messageBranching';
import { advanceTeamConversation, teamConversationContext } from './agentTeamConversation';
import type { WorkflowGoalSpec } from './workflowGoalSpec';
import { processRichMessageMedia } from './richMessageMedia';
import { WorkflowPreflightError } from './workflowRunRuntime';
import { inspectTeamMediaAdmission, recoverTeamMediaAdmission } from './agentTeamMediaAdmission';
import { agentTeamMediaTitle } from './agentTeamMediaTitle';
import { waitForMessageCloudConfirmation } from './messageCloudConfirmation';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { isLocalOnlyMediaMode } from './richMessageMedia';
import type { WorkflowTaskResult } from './workflowRunRuntime';
import type { PreparedMediaExecution } from './preparedMediaExecution';

function teamVideoMessage(runId: string, taskId: string): Message | null {
  const state = useMessageStore.getState();
  return [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]
    .filter((message) => message.metadata?.agentTeamMedia?.runId === runId && message.metadata.agentTeamMedia.taskId === taskId && !message.isDeleted)
    .sort((left, right) => {
      const rightUpdatedAt = Math.max(0, ...(right.metadata?.attachments || []).map((item) => item.updatedAt || 0));
      const leftUpdatedAt = Math.max(0, ...(left.metadata?.attachments || []).map((item) => item.updatedAt || 0));
      return rightUpdatedAt - leftUpdatedAt || Number(Boolean(right.serverId)) - Number(Boolean(left.serverId));
    })[0] || null;
}

export function inspectAgentTeamVideoAttachment(runId: string, taskId: string) {
  const message = teamVideoMessage(runId, taskId);
  const attachment = message?.metadata?.attachments?.find((item) => item.kind === 'video');
  if (!message || !attachment) return null;
  const admission = inspectTeamMediaAdmission(attachment);
  if (admission) return admission;
  if (attachment.status === 'ready') {
    if (!attachment.url) return { status: 'failed' as const, error: '视频任务已完成，但文件尚未保存到聊天，请在附件中重试获取文件' };
    return { status: 'completed' as const, output: `视频已生成并保存在当前聊天附件。内容：${(attachment.promptText || attachment.altText).slice(0, 2000)}` };
  }
  if (attachment.status === 'failed') return { status: 'failed' as const, error: attachment.error || '视频生成失败' };
  if (attachment.mediaTaskId) return { status: 'waiting_external' as const, externalTaskId: attachment.mediaTaskId };
  if (attachment.status === 'queued') return { status: 'queued' as const };
  if (attachment.status === 'generating' && attachment.generationJobId) return { status: 'queued' as const };
  return null;
}

export async function queueAgentTeamVideo(params: { runId: string; taskId: string; chatId: string; prompt: string; title?: string; profile?: AIModelProfile; mediaExecution?: PreparedMediaExecution; usageReference?: WorkflowUsageReference; sourceBranch?: WorkflowGoalSpec['sourceBranch']; referenceImages?: Array<{ url: string; mimeType?: string; label?: string }>; durationSeconds?: number; signal: AbortSignal }): Promise<WorkflowTaskResult> {
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  const chat = useChatStore.getState().chats.find((item) => item.id === params.chatId && item.type === 'assistant' && item.deletedAt == null);
  if (!chat) throw new WorkflowPreflightError('助手会话已删除');
  if (params.signal.aborted) throw new WorkflowPreflightError('团队任务已中断');
  const priorMessage = teamVideoMessage(params.runId, params.taskId);
  const rejectedBeforeSubmission = priorMessage?.metadata?.attachments?.some((item) => item.kind === 'video' && inspectTeamMediaAdmission(item));
  const existing = recoverTeamMediaAdmission(priorMessage, 'video', params.usageReference);
  if (existing) {
    const result = inspectAgentTeamVideoAttachment(params.runId, params.taskId);
    const retryableFailure = existing.metadata?.attachments?.some((item) => item.kind === 'video'
      && item.status === 'failed' && !item.admissionRejection);
    if (result?.status === 'waiting_external') return { externalTaskId: result.externalTaskId };
    if (result?.status === 'completed') return { output: result.output };
    if (result?.status === 'failed' && !retryableFailure) throw new WorkflowPreflightError(result.error);
    if (result?.status !== 'queued' && !(result?.status === 'failed' && retryableFailure)) {
      throw new Error('视频任务已开始提交，但结果尚未确认，请核对后继续');
    }
  }
  const profile = params.profile ?? getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'video');
  if (profile && profile.type !== 'video') throw new WorkflowPreflightError('视频模型类型不符');
  if (!profile && !existing?.metadata?.attachments?.some((item) => item.kind === 'video' && (item.mediaTaskId || item.generationJobId))) {
    throw new WorkflowPreflightError('视频模型未配置');
  }
  const now = Date.now();
  const state = useMessageStore.getState();
  const known = [...state.messages, ...(state.messageWindowsByChatId[chat.id]?.messages || [])];
  const executionFields = params.mediaExecution ? { executionQuoteId: params.mediaExecution.quote.id,
    generationJobId: String(params.mediaExecution.request.client_request_key),
    aspectRatio: typeof params.mediaExecution.request.aspect_ratio === 'string' ? params.mediaExecution.request.aspect_ratio : undefined,
    videoDuration: typeof params.mediaExecution.request.duration === 'number' ? params.mediaExecution.request.duration : undefined,
    videoResolution: typeof params.mediaExecution.request.resolution === 'string' ? params.mediaExecution.request.resolution : undefined,
  } : {};
  const title = agentTeamMediaTitle(params.title || params.prompt, '视频');
  let message = existing || attachMessageToActiveBranch(teamConversationContext(chat, params), known, {
    id: `team-video-${params.runId}-${params.taskId}`, clientKey: `team-video-${params.runId}-${params.taskId}`, chatId: chat.id, type: 'ai' as const,
    senderId: 'assistant', senderName: '助手', content: `视频 · ${title}`, emotion: 0,
    timestamp: now, isDeleted: false,
    metadata: { agentTeamMedia: { runId: params.runId, taskId: params.taskId }, workflowUsage: params.usageReference,
      attachments: [{ id: `team-video-${params.taskId}`, kind: 'video' as const, status: 'queued' as const,
        altText: title, promptText: params.prompt, aspectRatio: profile?.videoDefaults?.aspectRatio,
        referenceImages: params.referenceImages, videoDuration: params.durationSeconds,
        videoResolution: profile?.videoDefaults?.resolution, createdAt: now, updatedAt: now, ...executionFields }] },
  }) as Message;
  const unsubmitted = existing?.metadata?.attachments?.find((item) => item.kind === 'video'
    && item.status === 'queued' && !item.mediaTaskId && !item.generationJobId);
  const failedAttachment = existing?.metadata?.attachments?.find((item) => item.kind === 'video'
    && item.status === 'failed' && !item.admissionRejection);
  if (failedAttachment) {
    const attemptKey = params.usageReference
      ? `team-video-${params.runId}-${params.taskId}-${params.usageReference.attempt}`
      : `team-video-${params.runId}-${params.taskId}-${now}`;
    message = { ...message, metadata: { ...message.metadata, workflowUsage: params.usageReference,
      attachments: message.metadata?.attachments?.map((item) => item.id === failedAttachment.id ? {
        ...item, status: 'queued', error: undefined, mediaTaskId: undefined, executionQuoteId: undefined,
        generationJobId: attemptKey, promptText: params.prompt, referenceImages: params.referenceImages,
        videoDuration: params.durationSeconds ?? item.videoDuration,
        aspectRatio: item.aspectRatio ?? profile?.videoDefaults?.aspectRatio,
        videoResolution: profile?.videoDefaults?.resolution ?? item.videoResolution,
        updatedAt: now, ...executionFields,
      } : item) } };
    state.upsertMessage(message);
    state.queueMessageSync(message);
    flushBufferedPersistenceWrites();
  }
  if (unsubmitted && (params.mediaExecution || rejectedBeforeSubmission)) {
    message = { ...message, metadata: { ...message.metadata, workflowUsage: params.usageReference,
      attachments: message.metadata?.attachments?.map((item) => item.id === unsubmitted.id ? {
        ...item, promptText: params.prompt, referenceImages: params.referenceImages, updatedAt: now,
        executionQuoteId: undefined, ...executionFields,
      } : item) } };
    state.upsertMessage(message);
    state.queueMessageSync(message);
    flushBufferedPersistenceWrites();
  }
  if (!existing) {
    state.upsertMessage(message);
    state.queueMessageSync(message);
    await advanceTeamConversation(message, params.sourceBranch);
    flushBufferedPersistenceWrites();
  }
  let synced = message;
  if (!isLocalOnlyMediaMode()) {
    try {
      synced = await waitForMessageCloudConfirmation({ chatId: message.chatId, messageId: message.id, signal: params.signal });
    } catch (error) {
      throw new WorkflowPreflightError(error instanceof Error ? error.message : '视频占位消息未能同步，未提交生成请求');
    }
  }
  if (params.signal.aborted) throw new Error('视频任务已中断，提交结果需要核对');
  await processRichMessageMedia({ message: synced, aiProfiles: profile ? [profile] : [],
    sharesConversationLease: true,
    executionSignal: params.signal,
    upsertMessage: (next) => useMessageStore.getState().upsertMessage(next) });
  const result = inspectAgentTeamVideoAttachment(params.runId, params.taskId);
  if (result?.status === 'waiting_external') return { externalTaskId: result.externalTaskId };
  if (result?.status === 'completed') return { output: result.output };
  if (result?.status === 'failed') throw new WorkflowPreflightError(result.error);
  throw new Error('视频任务提交结果无法确认，请核对后继续');
}
