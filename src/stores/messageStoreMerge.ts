import type { Message, MessageAttachment, MessageMetadata } from '../types/message';
import { buildMessageIdentityKeys, getMessageRenderIdentity, isLocalOnlyMessageId, messagesShareIdentity } from '../services/messageIdentity';
import { compactMessageMetadata } from '../services/messageMetadataCompaction';

export const MAX_CACHED_MESSAGES_PER_CHAT = 1000;
// Branch ancestry is graph context, not visible timeline. Retain a larger
// bounded window for chats that contain branch metadata so a cold device can
// resolve the active head's parents without exposing sibling branches.
export const MAX_BRANCH_GRAPH_MESSAGES_PER_CHAT = 5000;
export const MAX_ACTIVE_MESSAGES_PER_CHAT = 240;

export interface CachedMessageWindow {
  messages: Message[];
  lastSyncedAt: number;
  updatedAt: number;
  remoteExhausted?: boolean;
  remoteNewerExhausted?: boolean;
  activeLimit?: number;
}

export function normalizeMessage(message: Message): Message {
  const rawSync = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>).sync
    : null;
  const persistedClientKey = rawSync && typeof rawSync === 'object' && !Array.isArray(rawSync)
    && typeof (rawSync as Record<string, unknown>).clientKey === 'string'
    ? (rawSync as Record<string, unknown>).clientKey as string
    : undefined;
  return {
    id: message.id,
    clientKey: message.clientKey || persistedClientKey,
    serverId: message.serverId,
    chatId: message.chatId,
    type: message.type,
    senderId: message.senderId,
    senderName: message.senderName,
    content: message.content,
    metadata: compactMessageMetadata(message.metadata, { dropContextText: true }),
    emotion: typeof message.emotion === 'number' ? message.emotion : 0,
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
    isDeleted: Boolean(message.isDeleted),
    isOptimistic: message.isOptimistic,
    isStreaming: message.isStreaming,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function messagesFromWindowChanges(changes: Array<Record<string, unknown>> | undefined, chatId: string) {
  if (!changes?.length) return null;
  const messages: Message[] = [];
  for (const change of changes) {
    if (change.entity !== 'message_window_message' || typeof change.id !== 'string' || !isRecord(change.patch)) return null;
    const patch = change.patch;
    if (patch.chatId !== chatId) return null;
    messages.push(normalizeMessage({
      id: change.id,
      clientKey: typeof patch.clientKey === 'string' ? patch.clientKey : undefined,
      serverId: typeof patch.serverId === 'string' ? patch.serverId : change.id,
      chatId,
      type: patch.type as Message['type'],
      senderId: typeof patch.senderId === 'string' ? patch.senderId : 'system',
      senderName: typeof patch.senderName === 'string' ? patch.senderName : 'System',
      content: typeof patch.content === 'string' ? patch.content : '',
      metadata: isRecord(patch.metadata) ? patch.metadata as Message['metadata'] : undefined,
      emotion: Number(patch.emotion || 0),
      timestamp: Number(patch.timestamp || 0),
      isDeleted: change.op === 'delete' ? true : Boolean(patch.isDeleted),
    }));
  }
  return messages.sort(compareMessagesByTimeline);
}

export function compareMessagesByTimeline(left: Message, right: Message) {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  if (left.type === 'event' && right.type !== 'event') return 1;
  if (left.type !== 'event' && right.type === 'event') return -1;
  return 0;
}

export function dedupeMessages(messages: Message[]) {
  const result: Message[] = [];
  const identityIndex = new Map<string, number>();
  const remember = (message: Message, index: number) => {
    for (const key of buildMessageIdentityKeys(message)) identityIndex.set(key, index);
  };

  for (const message of messages.map(normalizeMessage)) {
    const identityMatch = buildMessageIdentityKeys(message)
      .map((key) => identityIndex.get(key))
      .find((index): index is number => index !== undefined);
    if (identityMatch !== undefined) {
      result[identityMatch] = mergeMessagePair(result[identityMatch], message);
      remember(result[identityMatch], identityMatch);
      continue;
    }

    const nextIndex = result.length;
    result.push(message);
    remember(message, nextIndex);
  }

  return result;
}

function hasLocalMessageIdentity(message: Message) {
  return Boolean(message.clientKey || isLocalOnlyMessageId(message.id));
}

function shouldKeepExistingMessage(existing: Message, incoming: Message) {
  return Boolean(incoming.isStreaming && !existing.isStreaming && messagesShareIdentity(existing, incoming));
}

function hasUsableMediaUrl(attachment: MessageAttachment | undefined) {
  return Boolean(attachment?.url && typeof attachment.url === 'string');
}

function shouldPreserveLocalReadyAttachment(local: MessageAttachment | undefined, incoming: MessageAttachment) {
  if (!local || local.status !== 'ready' || !hasUsableMediaUrl(local)) return false;
  if (incoming.status === 'queued' || incoming.status === 'generating') return true;
  return incoming.status === 'ready' && !hasUsableMediaUrl(incoming);
}

function mergeAttachmentPair(local: MessageAttachment | undefined, incoming: MessageAttachment) {
  if (shouldPreserveLocalReadyAttachment(local, incoming)) {
    return {
      ...incoming,
      ...local,
      updatedAt: Math.max(local?.updatedAt || 0, incoming.updatedAt || 0),
    };
  }
  return incoming;
}

function mergeMetadataPair(existing: MessageMetadata | undefined, incoming: MessageMetadata | undefined) {
  if (!incoming || Object.keys(incoming as Record<string, unknown>).length === 0) return existing;
  if (existing?.branching && !incoming.branching) incoming = { ...incoming, branching: existing.branching };
  if (!existing?.attachments?.length || !incoming.attachments?.length) return incoming;

  const existingAttachments = new Map(existing.attachments.map((attachment) => [attachment.id, attachment]));
  const incomingIds = new Set(incoming.attachments.map((attachment) => attachment.id));
  const attachments = [
    ...incoming.attachments.map((attachment) => mergeAttachmentPair(existingAttachments.get(attachment.id), attachment)),
    ...existing.attachments.filter((attachment) => !incomingIds.has(attachment.id)),
  ];
  const generationStatus = attachments.some((attachment) => attachment.status === 'queued' || attachment.status === 'generating')
    ? 'generating'
    : attachments.some((attachment) => attachment.status === 'failed')
      ? 'failed'
      : attachments.length
        ? 'ready'
        : incoming.generation?.status;

  return {
    ...incoming,
    attachments,
    generation: incoming.generation || existing.generation
      ? {
          ...(existing.generation || {}),
          ...(incoming.generation || {}),
          status: generationStatus,
        }
      : undefined,
  };
}

function mergeMessagePair(existing: Message, incoming: Message) {
  if (shouldKeepExistingMessage(existing, incoming)) return existing;
  const existingHasLocalIdentity = hasLocalMessageIdentity(existing);
  const incomingHasLocalIdentity = hasLocalMessageIdentity(incoming);
  const id = existingHasLocalIdentity ? existing.id : incomingHasLocalIdentity ? incoming.id : incoming.id || existing.id;
  const serverId = incoming.serverId
    || existing.serverId
    || (!isLocalOnlyMessageId(incoming.id) && incoming.id !== id ? incoming.id : undefined)
    || (!isLocalOnlyMessageId(existing.id) && existing.id !== id ? existing.id : undefined);
  return {
    ...existing,
    ...incoming,
    id,
    clientKey: existing.clientKey || incoming.clientKey,
    serverId,
    timestamp: existingHasLocalIdentity ? existing.timestamp : incoming.timestamp,
    isOptimistic: incoming.isOptimistic ?? existing.isOptimistic,
    isStreaming: incoming.isStreaming ?? existing.isStreaming,
    metadata: mergeMetadataPair(existing.metadata, incoming.metadata),
  };
}

export function mergeMessages(localMessages: Message[], remoteMessages: Message[]) {
  const merged = new Map<string, Message>();
  const identityIndex = new Map<string, string>();
  const indexMessage = (identity: string, message: Message) => {
    for (const key of buildMessageIdentityKeys(message)) identityIndex.set(key, identity);
  };

  for (const message of localMessages.map(normalizeMessage)) {
    const identity = getMessageRenderIdentity(message);
    merged.set(identity, message);
    indexMessage(identity, message);
  }

  for (const remote of remoteMessages.map(normalizeMessage)) {
    const localIdentity = buildMessageIdentityKeys(remote)
      .map((key) => identityIndex.get(key))
      .find((identity): identity is string => Boolean(identity)) || null;
    const local = localIdentity ? merged.get(localIdentity) || null : null;

    if (!local) {
      const identity = getMessageRenderIdentity(remote);
      merged.set(identity, remote);
      indexMessage(identity, remote);
      continue;
    }

    if (!localIdentity) continue;
    const mergedMessage = mergeMessagePair(local, remote);
    if (localIdentity !== getMessageRenderIdentity(mergedMessage)) merged.delete(localIdentity);
    const nextIdentity = getMessageRenderIdentity(mergedMessage);
    merged.set(nextIdentity, mergedMessage);
    indexMessage(nextIdentity, mergedMessage);
  }

  return dedupeMessages(Array.from(merged.values())).sort(compareMessagesByTimeline);
}

export function countUniqueMessages(messages: Message[]) {
  return dedupeMessages(messages).length;
}

export function hasCompactedNarrativeTurnWithoutBlocks(message: Message) {
  const narrativeTurn = message.metadata?.narrativeTurn as Record<string, unknown> | undefined;
  if (!narrativeTurn || typeof narrativeTurn !== 'object' || Array.isArray(narrativeTurn)) return false;
  const blocks = Array.isArray(narrativeTurn.blocks) ? narrativeTurn.blocks : null;
  const blockCount = typeof narrativeTurn.blockCount === 'number' ? narrativeTurn.blockCount : 0;
  return blockCount > 0 && (!blocks || blocks.length === 0);
}

export function hasCompactedNarrativeWindow(window?: CachedMessageWindow | null) {
  return Boolean(window?.messages?.some(hasCompactedNarrativeTurnWithoutBlocks));
}

export function trimMessages(messages: Message[]) {
  return dedupeMessages(messages).slice(-MAX_CACHED_MESSAGES_PER_CHAT);
}

export function trimMessagesWithBranchContext(messages: Message[]) {
  const deduped = dedupeMessages(messages);
  const hasBranchGraph = deduped.some((message) => Boolean(message.metadata?.branching));
  return deduped.slice(-(hasBranchGraph ? MAX_BRANCH_GRAPH_MESSAGES_PER_CHAT : MAX_CACHED_MESSAGES_PER_CHAT));
}

export function trimActiveMessages(messages: Message[]) {
  return dedupeMessages(messages).slice(-MAX_ACTIVE_MESSAGES_PER_CHAT);
}

export function trimActiveMessagesForDirection(messages: Message[], direction: 'older' | 'newer' | 'tail') {
  const deduped = dedupeMessages(messages);
  if (deduped.length <= MAX_ACTIVE_MESSAGES_PER_CHAT) return deduped;
  return direction === 'older'
    ? deduped.slice(0, MAX_ACTIVE_MESSAGES_PER_CHAT)
    : deduped.slice(-MAX_ACTIVE_MESSAGES_PER_CHAT);
}
