import type { Message } from '../types/message';
import type { GroupChat } from '../types/chat';
import { buildMessageIdentityKeys, getMessageRenderIdentity, messagesShareIdentity } from './messageIdentity';
import { isMessageBranchingEnabled, projectActiveBranchMessages } from './messageBranching';

export interface MessageWindowLike {
  messages?: Message[];
  activeLimit?: number;
  preserveBranchContext?: boolean;
}

function shouldKeepExistingMessage(existing: Message, incoming: Message) {
  return Boolean(incoming.isStreaming && !existing.isStreaming && messagesShareIdentity(existing, incoming));
}

function mergeProjectedMessage(existing: Message, incoming: Message) {
  if (shouldKeepExistingMessage(existing, incoming)) return existing;
  const nextMetadata = incoming.metadata && Object.keys(incoming.metadata).length
    ? {
        ...(existing.metadata || {}),
        ...incoming.metadata,
      }
    : existing.metadata;
  return {
    ...existing,
    ...incoming,
    id: existing.clientKey ? existing.id : incoming.id || existing.id,
    clientKey: existing.clientKey || incoming.clientKey,
    serverId: incoming.serverId || existing.serverId,
    metadata: nextMetadata,
    timestamp: existing.clientKey ? existing.timestamp : incoming.timestamp,
  };
}

function compareByTimeline(left: Message, right: Message) {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  if (left.type === 'event' && right.type !== 'event') return 1;
  if (left.type !== 'event' && right.type === 'event') return -1;
  return 0;
}

function normalizeContentForSignature(content: string) {
  return content.trim().replace(/\s+/g, ' ');
}

function buildSemanticMessageSignature(message: Message) {
  const content = normalizeContentForSignature(message.content);
  if (!content) return null;
  const narrativeTurnId = message.metadata?.narrativeTurn?.turnId || '';
  return JSON.stringify([message.type, message.senderId, narrativeTurnId, content]);
}

function hasMatchingNeighbor(params: {
  cachedMessages: Message[];
  activeMessages: Message[];
  cachedIndex: number;
  activeIndex: number;
}) {
  const previousCached = params.cachedMessages[params.cachedIndex - 1];
  const previousActive = params.activeMessages[params.activeIndex - 1];
  if (
    previousCached
    && previousActive
    && buildSemanticMessageSignature(previousCached) === buildSemanticMessageSignature(previousActive)
  ) return true;

  const nextCached = params.cachedMessages[params.cachedIndex + 1];
  const nextActive = params.activeMessages[params.activeIndex + 1];
  return Boolean(
    nextCached
    && nextActive
    && buildSemanticMessageSignature(nextCached) === buildSemanticMessageSignature(nextActive)
  );
}

function removeHydratedCacheDuplicates(cachedMessages: Message[], activeMessages: Message[]) {
  if (!activeMessages.length || !cachedMessages.length) return cachedMessages;

  const activeBySignature = new Map<string, number[]>();
  activeMessages.forEach((message, index) => {
    if (message.isStreaming) return;
    const signature = buildSemanticMessageSignature(message);
    if (!signature) return;
    const indexes = activeBySignature.get(signature) || [];
    indexes.push(index);
    activeBySignature.set(signature, indexes);
  });

  return cachedMessages.filter((message, cachedIndex) => {
    if (message.isStreaming) return true;
    const signature = buildSemanticMessageSignature(message);
    if (!signature) return true;
    const activeIndexes = activeBySignature.get(signature) || [];
    return !activeIndexes.some((activeIndex) => {
      const activeMessage = activeMessages[activeIndex];
      // Text similarity is a legacy hydration aid, not branch identity.
      // Distinct graph nodes must survive even if their reply text is equal.
      if (message.metadata?.branching || activeMessage.metadata?.branching) return messagesShareIdentity(message, activeMessage);
      return activeMessage.timestamp === message.timestamp || hasMatchingNeighbor({
        cachedMessages,
        activeMessages,
        cachedIndex,
        activeIndex,
      });
    });
  });
}

function buildMessageIdentitySet(messages: Message[]) {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const key of buildMessageIdentityKeys(message)) keys.add(key);
  }
  return keys;
}

function sharesIdentityWithAnyActiveMessage(message: Message, activeIdentityKeys: Set<string>) {
  const keys = buildMessageIdentityKeys(message);
  if (!keys.length) return false;
  return keys.some((key) => activeIdentityKeys.has(key));
}

function getMessageRange(messages: Message[]) {
  if (!messages.length) return null;
  return messages.reduce((range, message) => ({
    min: Math.min(range.min, message.timestamp),
    max: Math.max(range.max, message.timestamp),
  }), { min: messages[0]?.timestamp ?? 0, max: messages[0]?.timestamp ?? 0 });
}

function shouldUseCachedWindowBase(cachedMessages: Message[], activeMessages: Message[]) {
  if (!cachedMessages.length) return false;
  if (!activeMessages.length) return true;
  if (cachedMessages.length <= activeMessages.length) return false;
  const cachedRange = getMessageRange(cachedMessages);
  const activeRange = getMessageRange(activeMessages);
  if (!cachedRange || !activeRange) return false;
  return activeRange.max >= cachedRange.min;
}

export function projectMergedChatMessages(params: {
  chatId: string;
  activeMessages: Message[];
  cachedWindow?: MessageWindowLike | null;
}) {
  const byId = new Map<string, Message>();
  const identityIndex = new Map<string, string>();
  const indexMessage = (identity: string, message: Message) => {
    for (const key of buildMessageIdentityKeys(message)) identityIndex.set(key, identity);
  };
  const activeMessages = params.activeMessages.filter((message) => message.chatId === params.chatId);
  const cachedWindowLimit = params.cachedWindow?.activeLimit && params.cachedWindow.activeLimit > 0
    ? params.cachedWindow.activeLimit
    : 40;
  const preserveBranchContext = params.cachedWindow?.preserveBranchContext
    || params.cachedWindow?.messages?.some((message) => message.chatId === params.chatId && Boolean(message.metadata?.branching));
  const cachedWindowMessages = (params.cachedWindow?.messages || [])
    .filter((message) => message.chatId === params.chatId)
    .slice(preserveBranchContext ? undefined : -cachedWindowLimit);
  const activeIdentityKeys = buildMessageIdentitySet(activeMessages);
  const cachedMessages = removeHydratedCacheDuplicates(
    preserveBranchContext || shouldUseCachedWindowBase(cachedWindowMessages, activeMessages)
      ? cachedWindowMessages
      : cachedWindowMessages.filter((message) => sharesIdentityWithAnyActiveMessage(message, activeIdentityKeys)),
    activeMessages,
  );
  const candidates = [
    ...cachedMessages,
    ...activeMessages,
  ];

  for (const message of candidates) {
    const identity = buildMessageIdentityKeys(message)
      .map((key) => identityIndex.get(key))
      .find((candidate): candidate is string => Boolean(candidate)) || null;
    const existing = identity ? byId.get(identity) || null : null;

    if (!existing || !identity) {
      const nextIdentity = getMessageRenderIdentity(message);
      byId.set(nextIdentity, message);
      indexMessage(nextIdentity, message);
      continue;
    }

    const merged = mergeProjectedMessage(existing, message);
    const nextIdentity = getMessageRenderIdentity(merged);
    if (nextIdentity !== identity) byId.delete(identity);
    byId.set(nextIdentity, merged);
    indexMessage(nextIdentity, merged);
  }

  return Array.from(byId.values()).sort(compareByTimeline);
}

export function projectCurrentChatMessages(params: {
  chatId: string;
  chat?: Pick<GroupChat, 'sessionKind' | 'messageBranchState'> & Partial<Pick<GroupChat, 'mode'>> | null;
  activeMessages: Message[];
  cachedWindow?: MessageWindowLike | null;
  fallbackMessages?: Message[];
}) {
  const branchAwareParams = params.chat && isMessageBranchingEnabled(params.chat)
    ? {
        ...params,
        cachedWindow: params.cachedWindow
          ? { ...params.cachedWindow, preserveBranchContext: true }
          : params.cachedWindow,
      }
    : params;
  const projected = projectMergedChatMessages(branchAwareParams);
  if (!isMessageBranchingEnabled(params.chat)) return projected;
  const activeRange = getMessageRange(params.activeMessages.filter((message) => message.chatId === params.chatId));
  const branched = projectActiveBranchMessages(params.chat, projected, { fallbackMessages: params.fallbackMessages });
  if (!activeRange || !params.activeMessages.length) return branched;
  // Branch selection needs the complete retained cache, but rendering should
  // stay within the store's current paging window. Use the active window's
  // timestamp range as the stable viewport boundary after projection.
  return branched.filter((message) => message.timestamp >= activeRange.min && message.timestamp <= activeRange.max);
}
