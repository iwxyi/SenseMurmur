import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { directReplyRunId, listDirectBackgroundReplies, recoverDirectBackgroundReplies, resumeDirectBackgroundReply, startDirectBackgroundReply } from './directBackgroundReply';

const flow = vi.hoisted(() => vi.fn());
vi.mock('./directUserReplyFlow', () => ({ runDirectUserReplyFlow: flow }));

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: unknown, callback?: (lock: object) => Promise<unknown>) => (callback || options as (lock: object) => Promise<unknown>)({}) } });
  vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useCharacterStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
  flow.mockReset();
});

function setup() {
  const chatId = crypto.randomUUID();
  const chat = normalizeConversation({ id: chatId, type: 'direct', name: '私聊', memberIds: ['character'], createdAt: 1, updatedAt: 1, lastMessageAt: 1 });
  const userMessage: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '我', content: '你好', emotion: 0, timestamp: Date.now(), isDeleted: false };
  useChatStore.setState({ chats: [chat] });
  useCharacterStore.setState((state) => ({ characters: [{ ...state.characters[0], id: 'character', name: '角色' } as (typeof state.characters)[number]] }));
  useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
  return { chatId, userMessage };
}

describe('direct background reply', () => {
  it('uses the committed user message, then avoids duplicate generation on resume', async () => {
    const { chatId, userMessage } = setup();
    flow.mockImplementation(async (params: { upsertMessage: (message: Message) => void }) => {
      useMessageStore.setState({ activeChatId: null, messages: [] });
      params.upsertMessage({ id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'character', senderName: '角色', content: '你好', emotion: 0, timestamp: userMessage.timestamp + 1, isDeleted: false });
    });
    const first = await startDirectBackgroundReply(chatId, userMessage.id);
    expect(first.snapshot.run.status).toBe('completed');
    expect(flow.mock.calls[0][0].userMessage.id).toBe(userMessage.id);
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.some((message) => message.type === 'ai' && message.content === '你好')).toBe(true);
    expect((await listDirectBackgroundReplies(chatId))[0].run.id).toBe(directReplyRunId(chatId, userMessage.id));
    await resumeDirectBackgroundReply(first.snapshot.run.id);
    expect(flow).toHaveBeenCalledTimes(1);
  });

  it('blocks an uncertain request instead of generating it again after recovery', async () => {
    const { chatId, userMessage } = setup();
    flow.mockRejectedValue(new Error('网络断开'));
    const first = await startDirectBackgroundReply(chatId, userMessage.id);
    expect(first.snapshot.tasks[0].status).toBe('result_unknown');
    await recoverDirectBackgroundReplies();
    const resumed = await resumeDirectBackgroundReply(first.snapshot.run.id);
    expect(resumed.summary.blocked).toHaveLength(1);
    expect(flow).toHaveBeenCalledTimes(1);
  });
});
