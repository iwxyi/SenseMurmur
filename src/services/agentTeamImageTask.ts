import type { Message } from '../types/message';
import type { WorkflowUsageReference } from '../types/workflowUsage';
import { getUsablePreferredAIProfile, type AIModelProfile } from '../types/settings';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { attachMessageToActiveBranch } from './messageBranching';
import { advanceTeamConversation, teamConversationContext } from './agentTeamConversation';
import type { WorkflowGoalSpec } from './workflowGoalSpec';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { isLocalOnlyMediaMode, processRichMessageMedia } from './richMessageMedia';
import { WorkflowPreflightError, type WorkflowTaskResult } from './workflowRunRuntime';
import { inspectTeamMediaAdmission, recoverTeamMediaAdmission } from './agentTeamMediaAdmission';
import { agentTeamMediaTitle } from './agentTeamMediaTitle';
import type { PreparedMediaExecution } from './preparedMediaExecution';
import { redactAiDiagnosticText } from './aiDiagnosticText';
import { canAttemptOnlineSync, getCloudSyncSkipDiagnostics } from '../stores/storeSyncHelpers';
import { logDeveloperDiagnostic } from './developerDiagnostics';

function imageTraceKey(runId: string, taskId: string) {
  const value = `${runId}:${taskId}`;
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function logTeamImageSync(message: string, details?: Record<string, unknown>, traceKey?: string) {
  const format = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(format).join('、') || '无';
    if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}=${format(item)}`).join('，');
    return redactAiDiagnosticText(String(value ?? '无').replace(/\s+/g, ' '), 500);
  };
  logDeveloperDiagnostic(`agent-team:image-sync:${message}`, { ...(traceKey ? { traceKey } : {}), ...(details ? { details: format(details) } : {}) }, 'info', 'team-media');
}

function teamImageMessage(runId: string, taskId: string): Message | null {
  const state = useMessageStore.getState();
  return [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]
    .filter((message) => message.metadata?.agentTeamMedia?.runId === runId && message.metadata.agentTeamMedia.taskId === taskId && !message.isDeleted)
    .sort((left, right) => {
      const changed = (message: Message) => Math.max(0, ...(message.metadata?.attachments || []).map((item) => item.updatedAt || 0));
      return changed(right) - changed(left) || Number(Boolean(right.serverId)) - Number(Boolean(left.serverId));
    })[0] || null;
}

export function teamImageMessagePrompt(runId: string, taskId: string) {
  return teamImageMessage(runId, taskId)?.metadata?.attachments?.find((item) => item.kind === 'image')?.promptText;
}

function imageMessageSyncFailure(runId: string, taskId: string) {
  const state = useMessageStore.getState();
  const message = teamImageMessage(runId, taskId);
  if (!message) return undefined;
  const operation = state.pendingOperations.find((item) => item.kind === 'create' && item.chatId === message.chatId
    && (item.localMessageId === message.id || item.messageId === message.id
      || Boolean(message.clientKey && item.payload?.clientKey === message.clientKey)));
  if (operation?.status === 'failed') return `图片占位消息同步失败：${operation.lastError || '云端拒绝了这条消息'}`;
  const parentNodeId = message.metadata?.branching?.parentNodeId;
  if (!parentNodeId) return undefined;
  const parent = state.pendingOperations.find((item) => item.kind === 'create' && item.chatId === message.chatId
    && (item.payload?.metadata?.branching?.nodeId === parentNodeId || item.payload?.id === parentNodeId || item.payload?.clientKey === parentNodeId));
  if (parent?.status === 'failed') return `图片占位消息的分支父消息同步失败：${parent.lastError || '云端拒绝了父消息'}`;
  return undefined;
}

function imageMessageQueueState(runId: string, taskId: string) {
  const state = useMessageStore.getState();
  const message = teamImageMessage(runId, taskId);
  if (!message) return { placeholder: { status: 'missing' } };
  const child = state.pendingOperations.find((item) => item.kind === 'create' && item.chatId === message.chatId
    && (item.localMessageId === message.id || item.messageId === message.id
      || Boolean(message.clientKey && item.payload?.clientKey === message.clientKey)));
  const parentNodeId = message.metadata?.branching?.parentNodeId;
  const parent = parentNodeId ? state.pendingOperations.find((item) => item.kind === 'create' && item.chatId === message.chatId
    && (item.payload?.metadata?.branching?.nodeId === parentNodeId || item.payload?.id === parentNodeId || item.payload?.clientKey === parentNodeId)) : undefined;
  const summarize = (operation: typeof child) => operation ? { status: operation.status, attempts: operation.attemptCount,
    retryInMs: operation.retryAt ? Math.max(0, operation.retryAt - Date.now()) : 0,
    lastError: operation.lastError ? redactAiDiagnosticText(operation.lastError, 500) : undefined } : { status: 'not-in-outbox' };
  return { placeholder: summarize(child), branchParent: parentNodeId ? summarize(parent) : { status: 'none' } };
}

function imageMessageTimeoutReason(runId: string, taskId: string) {
  const failure = imageMessageSyncFailure(runId, taskId);
  if (failure) return failure;
  const queue = imageMessageQueueState(runId, taskId);
  const summarize = (label: string, operation?: { status: string; attempts?: number; lastError?: string }) =>
    `${label}${operation?.status || '未找到'}${operation?.attempts ? `，已尝试${operation.attempts}次` : ''}${operation?.lastError ? `，最近错误：${operation.lastError}` : ''}`;
  const gate = getCloudSyncSkipDiagnostics();
  const blocked = !canAttemptOnlineSync()
    ? `；同步不可用：${typeof navigator !== 'undefined' && navigator.onLine === false ? '设备离线' : gate.reasons.join('、') || '工作区未就绪'}` : '';
  return `图片消息同步超时：${summarize('占位消息', queue.placeholder)}；${summarize('分支父消息', queue.branchParent)}${blocked}`;
}

export function teamImageReference(runId: string, taskId: string) {
  const attachment = teamImageMessage(runId, taskId)?.metadata?.attachments?.find((item) => item.kind === 'image');
  if (attachment?.status !== 'ready' || !attachment.url) return null;
  const url = attachment.url;
  if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url) && !/^\/uploads\//i.test(url)) return null;
  return { url, mimeType: attachment.mimeType, label: attachment.altText };
}

export function inspectAgentTeamImageAttachment(runId: string, taskId: string) {
  const attachment = teamImageMessage(runId, taskId)?.metadata?.attachments?.find((item) => item.kind === 'image');
  if (!attachment) return null;
  const admission = inspectTeamMediaAdmission(attachment);
  if (admission) return admission;
  if (attachment.status === 'ready') return attachment.url
    ? { status: 'completed' as const, output: `图片已生成并保存在当前聊天附件。内容：${(attachment.promptText || attachment.altText).slice(0, 2000)}` }
    : { status: 'failed' as const, error: '图片已生成，但文件尚未保存到聊天' };
  if (attachment.status === 'failed') return { status: 'failed' as const, error: attachment.error || '图片生成失败' };
  if (attachment.mediaTaskId) return { status: 'waiting_external' as const, externalTaskId: attachment.mediaTaskId };
  if (attachment.status === 'queued' || (attachment.status === 'generating' && attachment.generationJobId)) return { status: 'queued' as const };
  return null;
}

function waitForServerId(runId: string, taskId: string, signal: AbortSignal) {
  return new Promise<Message>((resolve, reject) => {
    let settled = false;
    let previousQueueState = '';
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (message?: Message, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      if (error) {
        logTeamImageSync('云端消息同步等待结束', { result: 'failed', reason: error.message }, imageTraceKey(runId, taskId));
        reject(error);
      } else if (message) {
        logTeamImageSync('占位消息已确认云端保存', undefined, imageTraceKey(runId, taskId));
        resolve(message);
      }
    };
    const inspect = () => {
      const message = teamImageMessage(runId, taskId);
      if (message?.serverId) finish(message);
      else {
        const queueState = imageMessageQueueState(runId, taskId);
        const signature = JSON.stringify(queueState, (key, value) => key === 'retryInMs' ? undefined : value);
        if (signature !== previousQueueState) {
          previousQueueState = signature;
          logTeamImageSync('占位消息同步队列状态', queueState, imageTraceKey(runId, taskId));
        }
        const failure = imageMessageSyncFailure(runId, taskId);
        if (failure) finish(undefined, new Error(failure));
      }
    };
    const onAbort = () => finish(undefined, new Error('图片消息同步已中断'));
    const unsubscribe = useMessageStore.subscribe(inspect);
    const timer = setTimeout(() => {
      const reason = imageMessageTimeoutReason(runId, taskId);
      const gate = getCloudSyncSkipDiagnostics();
      logTeamImageSync('占位消息同步超时', { ...imageMessageQueueState(runId, taskId), syncAvailable: canAttemptOnlineSync(),
        syncBlockReasons: gate.reasons, reason }, imageTraceKey(runId, taskId));
      finish(undefined, new Error(reason));
    }, 60_000);
    const flush = async () => {
      if (settled || signal.aborted) return;
      try {
        await useChatStore.getState().flushPendingOperations();
        if (!settled && !signal.aborted) await useMessageStore.getState().flushPendingOperations();
      } catch (error) {
        logTeamImageSync('主动刷新同步队列失败', { reason: error instanceof Error ? error.message : String(error) }, imageTraceKey(runId, taskId));
      } finally {
        if (!settled && !signal.aborted) {
          inspect();
          if (!settled) retryTimer = setTimeout(() => { void flush(); }, 5_000);
        }
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else {
      inspect();
      if (!settled) void flush();
    }
  });
}

export async function queueAgentTeamImage(params: { runId: string; taskId: string; chatId: string; prompt: string; sourceBranch?: WorkflowGoalSpec['sourceBranch'];
  title?: string;
  usageReference?: WorkflowUsageReference;
  profile?: AIModelProfile;
  mediaExecution?: PreparedMediaExecution;
  referenceImages?: Array<{ url: string; mimeType?: string; label?: string }>; signal: AbortSignal }): Promise<WorkflowTaskResult> {
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  const chat = useChatStore.getState().chats.find((item) => item.id === params.chatId && item.type === 'assistant' && item.deletedAt == null);
  if (!chat) throw new WorkflowPreflightError('助手会话已删除');
  if (params.signal.aborted) throw new WorkflowPreflightError('团队任务已中断');
  const priorMessage = teamImageMessage(params.runId, params.taskId);
  const traceKey = imageTraceKey(params.runId, params.taskId);
  const rejectedBeforeSubmission = priorMessage?.metadata?.attachments?.some((item) => item.kind === 'image' && inspectTeamMediaAdmission(item));
  const existing = recoverTeamMediaAdmission(priorMessage, 'image', params.usageReference);
  const prior = inspectAgentTeamImageAttachment(params.runId, params.taskId);
  if (prior?.status === 'completed') return { output: prior.output };
  const retryableFailure = prior?.status === 'failed'
    && priorMessage?.metadata?.attachments?.some((item) => item.kind === 'image' && item.status === 'failed' && !item.admissionRejection);
  if (prior?.status === 'failed' && !retryableFailure) throw new WorkflowPreflightError(prior.error);
  if (prior?.status === 'waiting_external') return { externalTaskId: prior.externalTaskId };
  if (existing && prior?.status !== 'queued' && !retryableFailure) throw new Error('图片任务已开始提交，但结果尚未确认，请核对后继续');
  const profile = params.profile ?? getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'image');
  if (!profile || profile.type !== 'image') throw new WorkflowPreflightError('图片模型未配置');
  const now = Date.now();
  const state = useMessageStore.getState();
  const known = [...state.messages, ...(state.messageWindowsByChatId[chat.id]?.messages || [])];
  const executionFields = params.mediaExecution ? { executionQuoteId: params.mediaExecution.quote.id,
    generationJobId: String(params.mediaExecution.request.client_request_key) } : {};
  const title = agentTeamMediaTitle(params.title || params.prompt, '图片');
  let message = existing || attachMessageToActiveBranch(teamConversationContext(chat, params), known, {
    id: `team-image-${params.runId}-${params.taskId}`, clientKey: `team-image-${params.runId}-${params.taskId}`, chatId: chat.id, type: 'ai' as const,
    senderId: 'assistant', senderName: '助手', content: `图片 · ${title}`, emotion: 0, timestamp: now, isDeleted: false,
    metadata: { agentTeamMedia: { runId: params.runId, taskId: params.taskId }, workflowUsage: params.usageReference, attachments: [{
      id: `team-image-${params.taskId}`, kind: 'image' as const, status: 'queued' as const,
      altText: title, promptText: params.prompt, referenceImages: params.referenceImages, createdAt: now, updatedAt: now, ...executionFields,
    }] },
  }) as Message;
  const failedAttachment = existing?.metadata?.attachments?.find((item) => item.kind === 'image'
    && item.status === 'failed' && !item.admissionRejection);
  if (failedAttachment && retryableFailure) {
    const attemptKey = params.usageReference
      ? `team-image-${params.runId}-${params.taskId}-${params.usageReference.attempt}`
      : `team-image-${params.runId}-${params.taskId}-${now}`;
    message = { ...message, metadata: { ...message.metadata, workflowUsage: params.usageReference,
      attachments: message.metadata?.attachments?.map((item) => item.id === failedAttachment.id ? {
        ...item, status: 'queued', error: undefined, mediaTaskId: undefined, executionQuoteId: undefined,
        generationJobId: attemptKey, promptText: params.prompt, referenceImages: params.referenceImages,
        updatedAt: now, ...executionFields,
      } : item) } };
    state.upsertMessage(message);
    state.queueMessageSync(message);
    flushBufferedPersistenceWrites();
  }
  const unsubmitted = existing?.metadata?.attachments?.find((item) => item.kind === 'image'
    && item.status === 'queued' && !item.mediaTaskId && !item.generationJobId);
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
    logTeamImageSync('创建图片占位消息', { syncMode: isLocalOnlyMediaMode() ? 'local' : 'cloud', hasBranchParent: Boolean(message.metadata?.branching?.parentNodeId) }, traceKey);
    state.upsertMessage(message);
    state.queueMessageSync(message);
    await advanceTeamConversation(message, params.sourceBranch);
    flushBufferedPersistenceWrites();
  }
  let synced = message;
  if (!isLocalOnlyMediaMode()) {
    try {
      synced = await waitForServerId(params.runId, params.taskId, params.signal);
    } catch (error) {
      throw new WorkflowPreflightError(error instanceof Error ? error.message : '图片占位消息未能同步，未提交生成请求');
    }
  }
  if (params.signal.aborted) throw new Error('图片任务已中断，提交结果需要核对');
  logTeamImageSync('占位消息同步完成，提交图片生成', { messageConfirmed: Boolean(synced.serverId) }, traceKey);
  try {
    await processRichMessageMedia({ message: synced, aiProfiles: [profile],
      sharesConversationLease: true,
      executionSignal: params.signal,
      upsertMessage: (next) => useMessageStore.getState().upsertMessage(next) });
  } catch (error) {
    logTeamImageSync('图片生成调用失败', { reason: error instanceof Error ? error.message : String(error) }, traceKey);
    throw error;
  }
  const result = inspectAgentTeamImageAttachment(params.runId, params.taskId);
  logTeamImageSync('图片生成结果检查', { status: result?.status || 'unknown', hasOutput: result?.status === 'completed',
    hasError: result?.status === 'failed' }, traceKey);
  if (result?.status === 'waiting_external') return { externalTaskId: result.externalTaskId };
  if (result?.status === 'completed') return { output: result.output };
  if (result?.status === 'failed') throw new WorkflowPreflightError(result.error);
  throw new Error('图片任务结果无法确认，请核对后继续');
}
