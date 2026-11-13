import type { Message } from '../../types/message';
import { getMessageRenderIdentity, messagesShareIdentity } from '../../services/messageIdentity';
import { parseRuntimeEvent } from '../../services/runtimeEventFactory';
import { resolveChatTimelinePresentation, type ChatTimelinePresentation } from './chatTimelinePresentation';

export type ChatRenderKind = 'bubble' | 'narrative' | 'system' | 'notice' | 'event';

export interface ChatRenderItem {
  key: string;
  message: Message;
  pending: boolean;
  renderKind: ChatRenderKind;
  presentation: ChatTimelinePresentation;
}

function getEventSourceMessageId(message: Message) {
  if (message.type !== 'event') return null;
  const event = parseRuntimeEvent(message.content);
  return event?.sourceMessageId || null;
}

function getAnchoredSourceMessageId(message: Message) {
  return message.metadata?.storyChoiceSelection?.sourceMessageId || getEventSourceMessageId(message);
}

function getTiePriority(message: Message) {
  if (message.metadata?.storyChoiceSelection?.sourceMessageId) return 1;
  if (message.type === 'event') return 2;
  return 0;
}

export function buildChatRenderItems(messages: Message[]): ChatRenderItem[] {
  const items: Array<ChatRenderItem & { order: number }> = [];

  for (const [order, message] of messages.entries()) {
    if (message.isDeleted) continue;

    if (items.some((item) => messagesShareIdentity(item.message, message))) continue;
    const identity = `${message.chatId}:${getMessageRenderIdentity(message)}`;

    const presentation = resolveChatTimelinePresentation(message);
    items.push({
      key: message.clientKey || identity,
      message,
      pending: Boolean(message.isStreaming),
      renderKind: presentation.kind === 'message' ? 'bubble' : presentation.kind,
      presentation,
      order,
    });
  }

  const timestampByMessageId = new Map<string, number>();
  items.forEach((item) => {
    timestampByMessageId.set(item.message.id, item.message.timestamp);
    if (item.message.serverId) timestampByMessageId.set(item.message.serverId, item.message.timestamp);
    if (item.message.clientKey) timestampByMessageId.set(item.message.clientKey, item.message.timestamp);
  });

  return items
    .sort((a, b) => {
      const aSourceOrder = getAnchoredSourceMessageId(a.message);
      const bSourceOrder = getAnchoredSourceMessageId(b.message);
      const aSortTime = aSourceOrder ? (timestampByMessageId.get(aSourceOrder) ?? a.message.timestamp) : a.message.timestamp;
      const bSortTime = bSourceOrder ? (timestampByMessageId.get(bSourceOrder) ?? b.message.timestamp) : b.message.timestamp;
      if (aSortTime !== bSortTime) return aSortTime - bSortTime;
      const priorityDelta = getTiePriority(a.message) - getTiePriority(b.message);
      if (priorityDelta !== 0) return priorityDelta;
      return a.order - b.order;
    })
    .map((item) => ({
      key: item.key,
      message: item.message,
      pending: item.pending,
      renderKind: item.renderKind,
      presentation: item.presentation,
    }));
}
