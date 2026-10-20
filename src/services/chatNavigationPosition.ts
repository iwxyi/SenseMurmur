import { getLocalDataUserId } from './authStorageScope';
import type { MessageListScrollPosition } from '../components/chat/MessageList';

const positions = new Map<string, MessageListScrollPosition>();
export function readChatNavigationPosition(chatId: string, scope = getLocalDataUserId()) { return positions.get(`${scope}:${chatId}`) || null; }
export function saveChatNavigationPosition(chatId: string, position: MessageListScrollPosition) {
  const key = `${getLocalDataUserId()}:${chatId}`;
  positions.delete(key);
  positions.set(key, position);
  if (positions.size > 64) positions.delete(positions.keys().next().value!);
}
