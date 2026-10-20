import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { buildConversationTimeContext } from './conversationTimeContext';

const now = new Date(2026, 9, 20, 23, 30).getTime();
const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm', chatId: 'room', senderId: 'a', senderName: 'A', type: 'ai',
  content: 'hello', timestamp: now - 120_000, emotion: 0, isDeleted: false, ...overrides,
});

describe('conversation time context', () => {
  it('provides local time and elapsed public silence without interpreting intent', () => {
    const context = buildConversationTimeContext([message()], now);
    expect(context).toContain('23:30');
    expect(context).toContain('Last visible send was 120 seconds ago');
    expect(context).toContain('Late hours do not imply fatigue');
    expect(context).toContain('this device clock is not the story clock');
    expect(context).not.toContain('hello');
  });

  it('ignores non-public sends, unfinished previews, deleted messages and future timestamps', () => {
    const context = buildConversationTimeContext([
      message(), message({ type: 'system', timestamp: now }), message({ type: 'event', timestamp: now }),
      message({ type: 'god', timestamp: now }), message({ isDeleted: true, timestamp: now }),
      message({ isStreaming: true, timestamp: now }), message({ timestamp: now + 1 }),
    ], now);
    expect(context).toContain('Last visible send was 120 seconds ago');
    expect(buildConversationTimeContext([], now)).not.toContain('Last visible send');
  });
});
