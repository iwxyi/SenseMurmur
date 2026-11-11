import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { processRichMessageMedia } from './richMessageMedia';
import { readAuthSnapshot } from './authSnapshot';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { getWorkspaceSignal } from './workspaceLifecycle';

let recoveryWatcher: { signal: AbortSignal; unsubscribe: () => void } | null = null;
const scheduledTasks = new Set<string>();

function videoTaskKeys(message: Message) {
  return (message.metadata?.attachments || []).filter((attachment) => (attachment.kind === 'video' || (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation'))
    && attachment.status === 'generating' && (attachment.mediaTaskId || attachment.generationJobId))
    .map((attachment) => `${message.id}:${attachment.id}:${attachment.mediaTaskId || attachment.generationJobId}`);
}

export function findPendingVideoMessages(messages: Message[], activeChatIds: Set<string>, requiresServerId: boolean) {
  const latest = new Map<string, Message>();
  for (const message of messages) {
    const previous = latest.get(message.id);
    if (previous && !previous.isDeleted && !message.isDeleted) {
      const attachments = new Map((previous.metadata?.attachments || []).map((attachment) => [attachment.id, attachment]));
      for (const attachment of message.metadata?.attachments || []) {
        const prior = attachments.get(attachment.id);
        if (!prior || attachment.updatedAt >= prior.updatedAt) attachments.set(attachment.id, attachment);
      }
      const previousUpdatedAt = Math.max(0, ...(previous.metadata?.attachments || []).map((attachment) => attachment.updatedAt || 0));
      const updatedAt = Math.max(0, ...(message.metadata?.attachments || []).map((attachment) => attachment.updatedAt || 0));
      const preferred = updatedAt > previousUpdatedAt || (updatedAt === previousUpdatedAt && !previous.serverId && message.serverId)
        ? message : previous;
      latest.set(message.id, { ...preferred, metadata: { ...preferred.metadata, attachments: [...attachments.values()] } });
      continue;
    }
    const updatedAt = Math.max(0, ...(message.metadata?.attachments || []).map((attachment) => attachment.updatedAt || 0));
    const previousUpdatedAt = previous ? Math.max(0, ...(previous.metadata?.attachments || []).map((attachment) => attachment.updatedAt || 0)) : -1;
    if (!previous || updatedAt > previousUpdatedAt || (updatedAt === previousUpdatedAt
      && ((!previous.isDeleted && message.isDeleted) || (!previous.serverId && Boolean(message.serverId) && !message.isDeleted)))) {
      latest.set(message.id, message);
    }
  }
  return [...latest.values()].filter((message) => !message.isDeleted && activeChatIds.has(message.chatId)
    && (!requiresServerId || Boolean(message.serverId))
    && (message.metadata?.attachments?.some((attachment) => (attachment.kind === 'video' || (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation')) && attachment.status === 'generating'
      && Boolean(attachment.mediaTaskId || attachment.generationJobId)) || false));
}

/** Reconcile submitting videos by their saved request key, then resume accepted tasks. */
export async function recoverBackgroundVideoTasks() {
  const workspaceSignal = getWorkspaceSignal();
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
  ]);
  if (workspaceSignal.aborted || getWorkspaceSignal() !== workspaceSignal) return 0;
  if (recoveryWatcher?.signal === workspaceSignal) return 0;
  recoveryWatcher?.unsubscribe();
  scheduledTasks.clear();
  const scan = () => {
    if (workspaceSignal.aborted || getWorkspaceSignal() !== workspaceSignal) return 0;
    const state = useMessageStore.getState();
    const activeChatIds = new Set(useChatStore.getState().chats.filter((chat) => chat.deletedAt == null).map((chat) => chat.id));
    const requiresServerId = readAuthSnapshot().mode === 'cloud' && isCloudSyncEnabled();
    const messages = findPendingVideoMessages([
      ...state.messages,
      ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages),
    ], activeChatIds, requiresServerId);
    let dispatched = 0;
    for (const message of messages) {
      const keys = videoTaskKeys(message);
      const fresh = keys.filter((key) => !scheduledTasks.has(key));
      if (!fresh.length) continue;
      fresh.forEach((key) => scheduledTasks.add(key));
      dispatched += fresh.length;
      void processRichMessageMedia({
        message,
        attachmentIds: message.metadata?.attachments?.filter((attachment) => (attachment.kind === 'video' || (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation')) && attachment.status === 'generating'
          && (attachment.mediaTaskId || attachment.generationJobId)
          && fresh.includes(`${message.id}:${attachment.id}:${attachment.mediaTaskId || attachment.generationJobId}`)).map((attachment) => attachment.id),
        aiProfiles: useSettingsStore.getState().aiProfiles,
        upsertMessage: (next) => useMessageStore.getState().upsertMessage(next),
      }).catch((error) => {
        console.error('[video-task:recovery-processing-failed]', error);
      });
    }
    return dispatched;
  };
  let pending = false;
  const unsubscribe = useMessageStore.subscribe((next, previous) => {
    if (next.messages === previous.messages && next.messageWindowsByChatId === previous.messageWindowsByChatId) return;
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; scan(); });
  });
  const cleanup = () => {
    unsubscribe();
    workspaceSignal.removeEventListener('abort', cleanup);
    if (recoveryWatcher?.signal === workspaceSignal) recoveryWatcher = null;
    scheduledTasks.clear();
  };
  workspaceSignal.addEventListener('abort', cleanup, { once: true });
  recoveryWatcher = { signal: workspaceSignal, unsubscribe: cleanup };
  return scan();
}
