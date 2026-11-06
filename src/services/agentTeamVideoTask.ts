import type { Message } from '../types/message';
import { getUsablePreferredAIProfile } from '../types/settings';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { attachMessageToActiveBranch } from './messageBranching';
import { processRichMessageMedia } from './richMessageMedia';
import { WorkflowPreflightError } from './workflowRunRuntime';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { isLocalOnlyMediaMode } from './richMessageMedia';
import type { WorkflowTaskResult } from './workflowRunRuntime';

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
  if (attachment.status === 'ready') {
    if (!attachment.url) return { status: 'failed' as const, error: '视频任务已完成，但文件尚未保存到聊天，请在附件中重试获取文件' };
    return { status: 'completed' as const, output: `视频已生成并保存在当前聊天附件。内容：${(attachment.promptText || attachment.altText).slice(0, 2000)}` };
  }
  if (attachment.status === 'failed') return { status: 'failed' as const, error: attachment.error || '视频生成失败' };
  if (attachment.mediaTaskId) return { status: 'waiting_external' as const, externalTaskId: attachment.mediaTaskId };
  if (attachment.status === 'queued') return { status: 'queued' as const };
  return null;
}

function waitForVideoState(runId: string, taskId: string, signal: AbortSignal, predicate: (message: Message) => boolean, timeoutMs: number) {
  return new Promise<Message>((resolve, reject) => {
    let finished = false;
    const finish = (message?: Message, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (message) resolve(message);
    };
    const inspect = () => {
      const message = teamVideoMessage(runId, taskId);
      if (message && predicate(message)) finish(message);
    };
    const onAbort = () => finish(undefined, new Error('视频任务等待已中断'));
    const unsubscribe = useMessageStore.subscribe(inspect);
    const timer = setTimeout(() => finish(undefined, new Error('视频任务状态等待超时，请核对后继续')), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else inspect();
  });
}

export async function queueAgentTeamVideo(params: { runId: string; taskId: string; chatId: string; prompt: string; signal: AbortSignal }): Promise<WorkflowTaskResult> {
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  const chat = useChatStore.getState().chats.find((item) => item.id === params.chatId && item.type === 'assistant' && item.deletedAt == null);
  if (!chat) throw new WorkflowPreflightError('助手会话已删除');
  const profile = getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'video');
  if (!profile) throw new WorkflowPreflightError('视频模型未配置');
  const existing = teamVideoMessage(params.runId, params.taskId);
  if (existing) {
    const result = inspectAgentTeamVideoAttachment(params.runId, params.taskId);
    if (result?.status === 'waiting_external') return { externalTaskId: result.externalTaskId };
    if (result?.status === 'completed') return { output: result.output };
    if (result?.status === 'failed') throw new WorkflowPreflightError(result.error);
    if (result?.status !== 'queued') throw new Error('视频任务已开始提交，但结果尚未确认，请核对后继续');
  }
  const now = Date.now();
  const state = useMessageStore.getState();
  const known = [...state.messages, ...(state.messageWindowsByChatId[chat.id]?.messages || [])];
  const message = existing || attachMessageToActiveBranch(chat, known, {
    id: `team-video-${params.runId}-${params.taskId}`, chatId: chat.id, type: 'ai' as const,
    senderId: 'assistant', senderName: '助手', content: '视频', emotion: 0,
    timestamp: now, isDeleted: false,
    metadata: { agentTeamMedia: { runId: params.runId, taskId: params.taskId },
      attachments: [{ id: `team-video-${params.taskId}`, kind: 'video' as const, status: 'queued' as const,
        altText: '团队生成视频', promptText: params.prompt, createdAt: now, updatedAt: now }] },
  }) as Message;
  if (!existing) {
    state.upsertMessage(message);
    state.queueMessageSync(message);
    flushBufferedPersistenceWrites();
  }
  const synced = isLocalOnlyMediaMode() ? message : await waitForVideoState(params.runId, params.taskId, params.signal,
    (current) => Boolean(current.serverId), 60_000);
  await processRichMessageMedia({ message: synced, aiProfiles: useSettingsStore.getState().aiProfiles,
    upsertMessage: (next) => useMessageStore.getState().upsertMessage(next) });
  const result = inspectAgentTeamVideoAttachment(params.runId, params.taskId);
  if (result?.status === 'waiting_external') return { externalTaskId: result.externalTaskId };
  if (result?.status === 'completed') return { output: result.output };
  if (result?.status === 'failed') throw new WorkflowPreflightError(result.error);
  throw new Error('视频任务提交结果无法确认，请核对后继续');
}
