import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { buildAssistantChatDraft } from './chatDraftBuilder';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import type { Message } from '../types/message';
import { assistantReplyRunId, listAssistantBackgroundReplies, recoverAssistantBackgroundReplies, resumeAssistantBackgroundReply, startAssistantBackgroundReply } from './assistantBackgroundReply';

const reply = vi.hoisted(() => vi.fn());
vi.mock('./assistantChatFlow', () => ({ runAssistantChatReplyFlow: reply }));

const heldLocks = new Set<string>();

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  heldLocks.clear();
  vi.stubGlobal('navigator', { locks: {
    request: async (name: string, _options: unknown, callback?: (lock: object | null) => Promise<unknown>) => {
      const run = callback || (_options as (lock: object | null) => Promise<unknown>);
      if (heldLocks.has(name)) return run(null);
      heldLocks.add(name);
      try { return await run({}); } finally { heldLocks.delete(name); }
    },
  } });
  vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
  reply.mockReset();
});

describe('assistant background reply', () => {
  it('uses the stored user message and current account scoped run', async () => {
    const chatId = crypto.randomUUID();
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1 };
    const userMessage: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '用户', content: '写一段介绍', emotion: 0, timestamp: Date.now(), isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    reply.mockResolvedValue({ id: 'reply-1' });
    const result = await startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0].currentMessages).toContainEqual(userMessage);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks[0].output).toBe('reply-1');
    expect((await listAssistantBackgroundReplies(chatId))[0].run.id).toBe(assistantReplyRunId(chatId, userMessage.id));
    await recoverAssistantBackgroundReplies();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('does not retry an uncertain request after reopening the app', async () => {
    const chatId = crypto.randomUUID();
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1 };
    const userMessage: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '用户', content: '生成视频', emotion: 0, timestamp: Date.now(), isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    reply.mockRejectedValue(new Error('请求中断'));
    const first = await startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id });
    expect(first.snapshot.tasks[0].status).toBe('result_unknown');
    await recoverAssistantBackgroundReplies();
    const resumed = await resumeAssistantBackgroundReply(first.snapshot.run.id, crypto.randomUUID());
    expect(resumed.summary.blocked).toHaveLength(1);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
