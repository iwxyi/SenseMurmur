import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { processRichMessageMedia } from './richMessageMedia';
import { readAuthSnapshot } from './authSnapshot';
import { isCloudSyncEnabled } from './cloudSyncPreference';

export function findPendingVideoMessages(messages: Message[], activeChatIds: Set<string>, requiresServerId: boolean) {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id) || message.isDeleted || !activeChatIds.has(message.chatId) || (requiresServerId && !message.serverId)) return false;
    const pending = message.metadata?.attachments?.some((attachment) => attachment.kind === 'video' && attachment.status === 'generating' && Boolean(attachment.mediaTaskId)) || false;
    if (pending) seen.add(message.id);
    return pending;
  });
}

/** Resume only video tasks already accepted by the server. Queued generations remain user controlled. */
export async function recoverBackgroundVideoTasks() {
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  const chats = useChatStore.getState().chats;
  const state = useMessageStore.getState();
  const activeChatIds = new Set(chats.filter((chat) => chat.deletedAt == null).map((chat) => chat.id));
  const requiresServerId = readAuthSnapshot().mode === 'cloud' && isCloudSyncEnabled();
  const messages = findPendingVideoMessages([
    ...state.messages,
    ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages),
  ], activeChatIds, requiresServerId);
  await Promise.all(messages.map((message) => processRichMessageMedia({
    message,
    attachmentIds: message.metadata?.attachments?.filter((attachment) => attachment.kind === 'video' && attachment.status === 'generating' && attachment.mediaTaskId).map((attachment) => attachment.id),
    aiProfiles: useSettingsStore.getState().aiProfiles,
    upsertMessage: (next) => useMessageStore.getState().upsertMessage(next),
  })));
  return messages.length;
}
