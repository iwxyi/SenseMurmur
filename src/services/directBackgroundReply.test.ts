import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { directReplyRunId, listDirectBackgroundReplies, recoverDirectBackgroundReplies, resumeDirectBackgroundReply, startDirectBackgroundReply } from './directBackgroundReply';
import { currentWorkflowScope, indexedDbWorkflowRepository } from './workflowRunRuntime';

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
      params.upsertMessage({ id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'character', senderName: '角色', content: '你好', emotion: 0, timestamp: userMessage.timestamp + 1, isDeleted: false, metadata: { directReplyToUserMessageId: userMessage.id } });
    });
    const first = await startDirectBackgroundReply(chatId, userMessage.id);
    expect(first.snapshot.run.status).toBe('completed');
    expect(flow.mock.calls[0][0].userMessage.id).toBe(userMessage.id);
    expect(flow.mock.calls[0][0].historyCutoffTimestamp).toBe(userMessage.timestamp);
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

  it('recognizes a committed reply when the run checkpoint was interrupted', async () => {
    const { chatId, userMessage } = setup();
    const runId = directReplyRunId(chatId, userMessage.id);
    const now = Date.now();
    useMessageStore.getState().upsertMessage({
      id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'character', senderName: '角色',
      content: '已回复', emotion: 0, timestamp: now + 1, isDeleted: false,
      metadata: { directReplyToUserMessageId: userMessage.id },
    });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({
      snapshot: {
        run: { id: runId, chatId, goal: '回复用户消息', status: 'active', generation: 1, planVersion: 1, updatedAt: now },
        tasks: [{ id: userMessage.id, runId, kind: 'direct_reply', input: { chatId, userMessageId: userMessage.id }, dependsOn: [], status: 'running', attempt: 1, updatedAt: now }],
      }, value: undefined,
    }));
    expect(await recoverDirectBackgroundReplies()).toBe(true);
    const restored = (await listDirectBackgroundReplies(chatId))[0];
    expect(restored.run.status).toBe('completed');
    expect(restored.tasks[0].status).toBe('completed');
    expect(flow).not.toHaveBeenCalled();
  });

  it('reconciles a saved reply after a later flow error without resending the model request', async () => {
    const { chatId, userMessage } = setup();
    flow.mockImplementation(async (params: { upsertMessage: (message: Message) => void }) => {
      params.upsertMessage({
        id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'character', senderName: '角色',
        content: '已保存', emotion: 0, timestamp: userMessage.timestamp + 1, isDeleted: false,
        metadata: { directReplyToUserMessageId: userMessage.id },
      });
      throw new Error('后续分析失败');
    });
    const first = await startDirectBackgroundReply(chatId, userMessage.id);
    expect(first.snapshot.tasks[0].status).toBe('result_unknown');
    const resumed = await resumeDirectBackgroundReply(first.snapshot.run.id);
    expect(resumed.snapshot.run.status).toBe('completed');
    expect(resumed.snapshot.tasks[0].status).toBe('completed');
    expect(flow).toHaveBeenCalledTimes(1);
  });

  it('keeps a second reply queued until the first reply releases the chat lock', async () => {
    const { chatId, userMessage } = setup();
    const secondMessage: Message = { ...userMessage, id: crypto.randomUUID(), content: '第二条', timestamp: userMessage.timestamp + 10 };
    useMessageStore.getState().upsertMessage(secondMessage);
    const held = new Map<string, Promise<unknown>>();
    vi.stubGlobal('navigator', { locks: { request: async (name: string, options: unknown, callback?: (lock: object) => Promise<unknown>) => {
      const run = callback || options as (lock: object) => Promise<unknown>;
      const previous = held.get(name);
      if (previous) await previous.catch(() => undefined);
      const current = run({});
      held.set(name, current);
      try { return await current; } finally { if (held.get(name) === current) held.delete(name); }
    } } });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    flow.mockImplementation(async (params: { userMessage: Message; upsertMessage: (message: Message) => void }) => {
      if (params.userMessage.id === userMessage.id) await gate;
      params.upsertMessage({
        id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'character', senderName: '角色',
        content: '已回复', emotion: 0, timestamp: params.userMessage.timestamp + 1, isDeleted: false,
        metadata: { directReplyToUserMessageId: params.userMessage.id },
      });
    });
    const first = startDirectBackgroundReply(chatId, userMessage.id);
    await vi.waitFor(() => expect(flow).toHaveBeenCalledTimes(1));
    const second = startDirectBackgroundReply(chatId, secondMessage.id);
    await vi.waitFor(async () => expect((await listDirectBackgroundReplies(chatId)).length).toBe(2));
    const queued = (await listDirectBackgroundReplies(chatId)).find((item) => item.tasks[0].id === secondMessage.id);
    expect(queued?.tasks[0].status).toBe('queued');
    expect(queued?.tasks[0].attempt).toBe(0);
    expect(flow).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(flow).toHaveBeenCalledTimes(2);
  });
});
