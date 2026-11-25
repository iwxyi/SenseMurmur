import type { Message, MessageAttachment } from '../types/message';
import type { MediaCompositionPlan } from './mediaCompositionPlan';
import { useMessageStore } from '../stores/useMessageStore';
import { useChatStore } from '../stores/useChatStore';
import { attachMessageToActiveBranch } from './messageBranching';
import { advanceTeamConversation, teamConversationContext } from './agentTeamConversation';
import type { WorkflowGoalSpec } from './workflowGoalSpec';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { WorkflowPreflightError } from './workflowRunRuntime';
import { assertChatExecutionLease } from './chatExecutionLease';
import { waitForMessageCloudConfirmation } from './messageCloudConfirmation';
import { isLocalOnlyMediaMode, uploadLocalMessageMediaToCloud } from './richMessageMedia';
import { ApiError } from './api';

function teamMediaMessages() {
  const state = useMessageStore.getState();
  return [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)];
}

export function canComposeTeamMedia() {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && Boolean(globalThis.navigator?.locks?.request);
}

export function teamMediaAttachment(runId: string, taskId: string): MessageAttachment | undefined {
  return teamMediaMessages()
    .filter((message) => !message.isDeleted && message.metadata?.agentTeamMedia?.runId === runId && message.metadata.agentTeamMedia.taskId === taskId)
    .flatMap((message) => message.metadata?.attachments || [])
    .filter((attachment) => attachment.status === 'ready' && attachment.url && (attachment.kind === 'video' || attachment.kind === 'audio'))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

export function inspectAgentTeamComposition(runId: string, taskId: string) {
  const attachment = teamMediaAttachment(runId, taskId);
  return attachment?.kind === 'video' ? { status: 'completed' as const, output: `视频已在本机完成合成并保存在当前聊天附件。${attachment.semanticSummary || ''}` } : null;
}

// A cloud message is created first while its inline video stays in local storage.
// The existing bytes can then be published under the same message and attachment.
export async function syncAgentTeamCompositionToCloud(runId: string, taskId: string, signal: AbortSignal) {
  if (isLocalOnlyMediaMode()) return;
  const local = teamMediaMessages().find((message) => !message.isDeleted
    && message.metadata?.agentTeamMedia?.runId === runId && message.metadata.agentTeamMedia.taskId === taskId
    && message.metadata?.attachments?.some((attachment) => attachment.kind === 'video' && attachment.status === 'ready'
      && attachment.url?.startsWith('data:video/')));
  if (!local) return;
  signal.throwIfAborted();
  assertChatExecutionLease(local.chatId);
  const cloud = await waitForMessageCloudConfirmation({ chatId: local.chatId, messageId: local.id, signal });
  signal.throwIfAborted();
  const metadata = await uploadLocalMessageMediaToCloud({ localMessage: local, cloudMessage: cloud, signal });
  useMessageStore.getState().upsertMessage({ ...local, ...cloud, metadata }, { replaceAttachments: true });
  flushBufferedPersistenceWrites();
}

async function completedCompositionOutput(runId: string, taskId: string, output: string, signal: AbortSignal) {
  try {
    await syncAgentTeamCompositionToCloud(runId, taskId, signal);
    return output;
  } catch (error) {
    signal.throwIfAborted();
    const code = error instanceof ApiError && error.code ? error.code : undefined;
    const reason = code === 'CLOUD_STORAGE_QUOTA_EXCEEDED' ? '云端存储容量不足'
      : code === 'CLOUD_FILE_TOO_LARGE' ? '成片超过云端单文件大小限制'
        : code === 'CLOUD_STORAGE_NOT_ENTITLED' ? '当前账号没有云端文件存储权限'
          : code ? `云端保存失败（${code}）` : '云端保存未确认';
    return `${output}\n${reason}。成片可在本机播放，可以重新同步已有文件。`;
  }
}

export async function composeAgentTeamMedia(params: {
  runId: string; taskId: string; chatId: string; plan: MediaCompositionPlan; sourceBranch?: WorkflowGoalSpec['sourceBranch'];
  resolveTaskId: (id: string) => string; signal: AbortSignal;
}) {
  const existing = inspectAgentTeamComposition(params.runId, params.taskId);
  if (existing) {
    return { output: await completedCompositionOutput(params.runId, params.taskId, existing.output, params.signal) };
  }
  const chat = useChatStore.getState().chats.find((item) => item.id === params.chatId && item.type === 'assistant' && item.deletedAt == null);
  if (!chat) throw new WorkflowPreflightError('助手会话已删除');
  params.signal.throwIfAborted();
  const sources = new Map<string, string>();
  for (const item of [...params.plan.clips, ...(params.plan.audioTracks || [])]) {
    const attachment = teamMediaAttachment(params.runId, params.resolveTaskId(item.taskId));
    if (!attachment?.url) throw new WorkflowPreflightError('合成素材尚未保存在当前聊天，请先恢复上游媒体文件');
    sources.set(item.taskId, attachment.url);
  }
  const { composeLocalMedia } = await import('./localMediaComposition');
  const result = await composeLocalMedia({ plan: params.plan, sources, signal: params.signal });
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('合成视频保存失败'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(result.blob);
  });
  params.signal.throwIfAborted();
  assertChatExecutionLease(params.chatId);
  if (!useChatStore.getState().chats.some((item) => item.id === chat.id && item.deletedAt == null)) throw new WorkflowPreflightError('助手会话已删除，合成结果未写入');
  const now = Date.now();
  const state = useMessageStore.getState();
  const semanticSummary = `按顺序合并 ${params.plan.clips.length} 个片段，叠加 ${params.plan.audioTracks?.length || 0} 条音轨，时长约 ${(result.durationMs / 1000).toFixed(1)} 秒。未进行成片画面检查。`;
  const latestChat = useChatStore.getState().chats.find((item) => item.id === chat.id && item.deletedAt == null);
  if (!latestChat) throw new WorkflowPreflightError('助手会话已删除，合成结果未写入');
  const message = attachMessageToActiveBranch(teamConversationContext(latestChat, params), [...state.messages, ...(state.messageWindowsByChatId[chat.id]?.messages || [])], {
    id: `team-composition-${params.runId}-${params.taskId}`, clientKey: `team-composition-${params.runId}-${params.taskId}`,
    chatId: chat.id, type: 'ai', senderId: 'assistant', senderName: '助手', content: '合成视频',
    emotion: 0, timestamp: now, isDeleted: false,
    metadata: { agentTeamMedia: { runId: params.runId, taskId: params.taskId }, attachments: [{
      id: `team-composition-${params.taskId}`, kind: 'video', status: 'ready', altText: '团队合成视频',
      url, mimeType: 'video/mp4', fileName: '合成视频.mp4', sizeBytes: result.blob.size,
      width: result.width, height: result.height, durationMs: result.durationMs,
      aspectRatio: `${result.width}:${result.height}`, semanticSummary, createdAt: now, updatedAt: now,
    }] },
  }) as Message;
  state.upsertMessage(message);
  state.queueMessageSync(message);
  await advanceTeamConversation(message, params.sourceBranch);
  flushBufferedPersistenceWrites();
  return { output: await completedCompositionOutput(params.runId, params.taskId,
    `视频已在本机完成合成并保存在当前聊天附件。${semanticSummary}`, params.signal) };
}
