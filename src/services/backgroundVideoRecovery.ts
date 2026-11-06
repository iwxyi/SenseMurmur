import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { processRichMessageMedia } from './richMessageMedia';
import { readAuthSnapshot } from './authSnapshot';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { getWorkspaceSignal } from './workspaceLifecycle';

export function findPendingVideoMessages(messages: Message[], activeChatIds: Set<string>, requiresServerId: boolean) {
  const latest = new Map<string, Message>();
  for (const message of messages) {
    const previous = latest.get(message.id);
    const updatedAt = Math.max(0, ...(message.metadata?.attachments || []).map((attachment) => attachment.updatedAt || 0));
    const previousUpdatedAt = previous ? Math.max(0, ...(previous.metadata?.attachments || []).map((attachment) => attachment.updatedAt || 0)) : -1;
    if (!previous || updatedAt > previousUpdatedAt) latest.set(message.id, message);
  }
  return [...latest.values()].filter((message) => !message.isDeleted && activeChatIds.has(message.chatId)
    && (!requiresServerId || Boolean(message.serverId))
    && (message.metadata?.attachments?.some((attachment) => attachment.kind === 'video' && attachment.status === 'generating' && Boolean(attachment.mediaTaskId)) || false));
}

/** Resume only video tasks already accepted by the server. Queued generations remain user controlled. */
export async function recoverBackgroundVideoTasks() {
  const workspaceSignal = getWorkspaceSignal();
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  if (workspaceSignal.aborted || getWorkspaceSignal() !== workspaceSignal) return 0;
  const chats = useChatStore.getState().chats;
  const state = useMessageStore.getState();
  const activeChatIds = new Set(chats.filter((chat) => chat.deletedAt == null).map((chat) => chat.id));
  const requiresServerId = readAuthSnapshot().mode === 'cloud' && isCloudSyncEnabled();
  const messages = findPendingVideoMessages([
    ...state.messages,
    ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages),
  ], activeChatIds, requiresServerId);
  await Promise.all(messages.map((message) => {
    if (workspaceSignal.aborted || getWorkspaceSignal() !== workspaceSignal) return Promise.resolve();
    return processRichMessageMedia({
    message,
    attachmentIds: message.metadata?.attachments?.filter((attachment) => attachment.kind === 'video' && attachment.status === 'generating' && attachment.mediaTaskId).map((attachment) => attachment.id),
    aiProfiles: useSettingsStore.getState().aiProfiles,
    upsertMessage: (next) => useMessageStore.getState().upsertMessage(next),
    });
  }));
  return messages.length;
}
