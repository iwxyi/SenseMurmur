import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { getLatestChatPreviewMessage, sanitizeChatLatestMessage } from './chatLatestMessage';

function message(overrides: Partial<Message>): Message {
  return {
    id: overrides.id || 'm-1',
    chatId: 'chat-1',
    type: overrides.type || 'ai',
    senderId: overrides.senderId || 'char-a',
    senderName: 'Actor',
    content: overrides.content || '继续说。',
    emotion: 0,
    timestamp: overrides.timestamp || 1,
    isDeleted: false,
    ...overrides,
  };
}

describe('chat latest message helpers', () => {
  it('excludes event, system and deleted messages from chat previews', () => {
    const latest = getLatestChatPreviewMessage([
      message({ id: 'ai-old', type: 'ai', timestamp: 100, content: '最后一句可读回复' }),
      message({ id: 'event-new', type: 'event', timestamp: 300, content: '归属/身份冲突：0' }),
      message({ id: 'system-new', type: 'system', timestamp: 400, content: '系统状态' }),
      message({ id: 'deleted-new', type: 'user', timestamp: 500, isDeleted: true, content: '已删除' }),
    ]);

    expect(latest?.id).toBe('ai-old');
  });

  it('normalizes invalid latest messages to null', () => {
    expect(sanitizeChatLatestMessage(message({ type: 'event' }))).toBeNull();
    expect(sanitizeChatLatestMessage(message({ type: 'system' }))).toBeNull();
    expect(sanitizeChatLatestMessage(message({ type: 'ai' }))?.type).toBe('ai');
  });
});
