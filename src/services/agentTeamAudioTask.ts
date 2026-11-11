import type { Message } from '../types/message';
import { getUsablePreferredAIProfile } from '../types/settings';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { attachMessageToActiveBranch } from './messageBranching';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { isLocalOnlyMediaMode, processRichMessageMedia } from './richMessageMedia';
import { WorkflowPreflightError, type WorkflowTaskResult } from './workflowRunRuntime';

function teamAudioMessage(runId: string, taskId: string): Message | null {
  const state = useMessageStore.getState();
  return [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]
    .filter((message) => message.metadata?.agentTeamMedia?.runId === runId && message.metadata.agentTeamMedia.taskId === taskId && !message.isDeleted)
    .sort((left, right) => Math.max(0, ...(right.metadata?.attachments || []).map((item) => item.updatedAt || 0))
      - Math.max(0, ...(left.metadata?.attachments || []).map((item) => item.updatedAt || 0)))[0] || null;
}

export function inspectAgentTeamAudioAttachment(runId: string, taskId: string) {
  const attachment = teamAudioMessage(runId, taskId)?.metadata?.attachments?.find((item) => item.kind === 'audio');
  if (!attachment) return null;
  if (attachment.status === 'ready') return attachment.url
    ? { status: 'completed' as const, output: `音乐已生成并保存在当前聊天附件。主题：${(attachment.promptText || attachment.altText).slice(0, 2000)}` }
    : { status: 'failed' as const, error: '音乐已生成，但文件尚未保存到聊天' };
  if (attachment.status === 'failed') return { status: 'failed' as const, error: attachment.error || '音乐生成失败' };
  if (attachment.mediaTaskId) return { status: 'waiting_external' as const, externalTaskId: attachment.mediaTaskId };
  if (attachment.status === 'queued' || (attachment.status === 'generating' && attachment.generationJobId)) return { status: 'queued' as const };
  return null;
}

function waitForMessage(runId: string, taskId: string, signal: AbortSignal) {
  return new Promise<Message>((resolve, reject) => {
    let settled = false;
    const finish = (message?: Message, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (message) resolve(message);
    };
    const inspect = () => { const message = teamAudioMessage(runId, taskId); if (message?.serverId) finish(message); };
    const onAbort = () => finish(undefined, new Error('音乐消息同步已中断'));
    const unsubscribe = useMessageStore.subscribe(inspect);
    const timer = setTimeout(() => finish(undefined, new Error('音乐消息同步超时，请核对后继续')), 60_000);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort(); else inspect();
  });
}

export async function queueAgentTeamAudio(params: { runId: string; taskId: string; chatId: string; prompt: string; signal: AbortSignal }): Promise<WorkflowTaskResult> {
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  const chat = useChatStore.getState().chats.find((item) => item.id === params.chatId && item.type === 'assistant' && item.deletedAt == null);
  if (!chat) throw new WorkflowPreflightError('助手会话已删除');
  if (params.signal.aborted) throw new WorkflowPreflightError('团队任务已中断');
  const existing = teamAudioMessage(params.runId, params.taskId);
  const prior = inspectAgentTeamAudioAttachment(params.runId, params.taskId);
  if (prior?.status === 'completed') return { output: prior.output };
  if (prior?.status === 'failed') throw new WorkflowPreflightError(prior.error);
  if (existing && prior?.status !== 'queued' && prior?.status !== 'waiting_external') throw new Error('音乐任务已开始提交，但结果尚未确认，请核对后继续');
  const profile = getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'audio');
  if (!existing && !profile) throw new WorkflowPreflightError('音频模型未配置');
  const now = Date.now();
  const state = useMessageStore.getState();
  const known = [...state.messages, ...(state.messageWindowsByChatId[chat.id]?.messages || [])];
  const message = existing || attachMessageToActiveBranch(chat, known, {
    id: `team-audio-${params.runId}-${params.taskId}`, clientKey: `team-audio-${params.runId}-${params.taskId}`, chatId: chat.id,
    type: 'ai' as const, senderId: 'assistant', senderName: '助手', content: '音乐', emotion: 0, timestamp: now, isDeleted: false,
    metadata: { agentTeamMedia: { runId: params.runId, taskId: params.taskId }, attachments: [{
      id: `team-audio-${params.taskId}`, kind: 'audio' as const, audioPurpose: 'music_generation' as const, status: 'queued' as const,
      altText: '团队生成音乐', promptText: params.prompt, createdAt: now, updatedAt: now,
    }] },
  }) as Message;
  if (!existing) {
    state.upsertMessage(message);
    state.queueMessageSync(message);
    flushBufferedPersistenceWrites();
  }
  const synced = isLocalOnlyMediaMode() ? message : await waitForMessage(params.runId, params.taskId, params.signal);
  if (params.signal.aborted) throw new Error('音乐任务已中断，提交结果需要核对');
  await processRichMessageMedia({ message: synced, aiProfiles: useSettingsStore.getState().aiProfiles,
    sharesConversationLease: true,
    upsertMessage: (next) => useMessageStore.getState().upsertMessage(next) });
  const result = inspectAgentTeamAudioAttachment(params.runId, params.taskId);
  if (result?.status === 'waiting_external') return { externalTaskId: result.externalTaskId };
  if (result?.status === 'completed') return { output: result.output };
  if (result?.status === 'failed') throw new WorkflowPreflightError(result.error);
  throw new Error('音乐任务提交结果无法确认，请核对后继续');
}
