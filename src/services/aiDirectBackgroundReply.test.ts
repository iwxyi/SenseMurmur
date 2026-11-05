import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { aiDirectReplyRunId, listAiDirectBackgroundReplies, recoverAiDirectBackgroundReplies, resumeAiDirectBackgroundReply, startAiDirectBackgroundReply } from './aiDirectBackgroundReply';
import { currentWorkflowScope, indexedDbWorkflowRepository } from './workflowRunRuntime';

const runLoop = vi.hoisted(() => vi.fn());
vi.mock('./sessionRunner', () => ({ runSessionLoop: runLoop }));

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: unknown, callback?: (lock: object) => Promise<unknown>) =>
    (callback || options as (lock: object) => Promise<unknown>)({}) } });
  vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useCharacterStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
  runLoop.mockReset();
});

function setup() {
  const chatId = crypto.randomUUID();
  const chat = normalizeConversation({ id: chatId, type: 'ai_direct', name: '角色私聊', memberIds: ['a', 'b'], createdAt: 1, updatedAt: 1, lastMessageAt: 1 });
  const source: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '我', content: '聊聊', emotion: 0, timestamp: Date.now(), isDeleted: false };
  useChatStore.setState({ chats: [chat] });
  useCharacterStore.setState((state) => ({ characters: ['a', 'b'].map((id) => ({ ...state.characters[0], id, name: id })) as typeof state.characters }));
  useMessageStore.setState({ activeChatId: chatId, messages: [source], messageWindowsByChatId: {} });
  return { chatId, source };
}

describe('AI direct background reply', () => {
  it('continues after the chat page is gone and does not repeat a committed reply', async () => {
    const { chatId, source } = setup();
    runLoop.mockImplementation(async (params: { onCommittedMessage: (message: Message) => void; upsertMessage: (message: Message) => void }) => {
      useMessageStore.setState({ activeChatId: null, messages: [source] });
      const reply: Message = { ...source, id: crypto.randomUUID(), type: 'ai', senderId: 'a', senderName: 'a', content: '回复', timestamp: source.timestamp + 1,
        metadata: { directReplyToUserMessageId: source.id } };
      params.upsertMessage(reply);
      params.onCommittedMessage(reply);
    });
    const first = await startAiDirectBackgroundReply(chatId, source.id);
    expect(first.run.status).toBe('completed');
    expect(first.tasks[0].output).toBeDefined();
    await resumeAiDirectBackgroundReply(aiDirectReplyRunId(chatId, source.id));
    expect(runLoop).toHaveBeenCalledTimes(1);
  });

  it('holds an uncertain result for inspection instead of resending', async () => {
    const { chatId, source } = setup();
    runLoop.mockImplementation(async (params: { onEngineError: (error: Error) => void }) => {
      params.onEngineError(new Error('请求结果未知'));
    });
    const first = await startAiDirectBackgroundReply(chatId, source.id);
    expect(first.tasks[0].status).toBe('result_unknown');
    await recoverAiDirectBackgroundReplies();
    await resumeAiDirectBackgroundReply(first.run.id);
    expect(runLoop).toHaveBeenCalledTimes(1);
  });

  it('treats an explicit no-send decision as a completed turn', async () => {
    const { chatId, source } = setup();
    runLoop.mockImplementation(async (params: { onQuiet: () => void }) => {
      params.onQuiet();
    });
    const result = await startAiDirectBackgroundReply(chatId, source.id);
    expect(result.run.status).toBe('completed');
    expect(result.tasks[0].output).toEqual({ outcome: 'no_reply' });
  });

  it('treats a role deciding not to speak as a completed turn', async () => {
    const { chatId, source } = setup();
    runLoop.mockImplementation(async (params: { onNoSendDecision: () => void }) => {
      params.onNoSendDecision();
    });
    const result = await startAiDirectBackgroundReply(chatId, source.id);
    expect(result.run.status).toBe('completed');
    expect(result.tasks[0].output).toEqual({ outcome: 'no_reply' });
  });

  it('reconciles a saved reply after an interrupted checkpoint', async () => {
    const { chatId, source } = setup();
    const runId = aiDirectReplyRunId(chatId, source.id);
    useMessageStore.getState().upsertMessage({ ...source, id: crypto.randomUUID(), type: 'ai', senderId: 'a', senderName: 'a', content: '已保存', timestamp: source.timestamp + 1,
      metadata: { directReplyToUserMessageId: source.id } });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: 'AI 私聊回复', status: 'active', generation: 1, planVersion: 1, updatedAt: Date.now() },
      tasks: [{ id: source.id, runId, kind: 'ai_direct_reply', input: { chatId, userMessageId: source.id }, dependsOn: [], status: 'running', attempt: 1, updatedAt: Date.now() }],
    }, value: undefined }));
    await recoverAiDirectBackgroundReplies();
    const restored = (await listAiDirectBackgroundReplies(chatId))[0];
    expect(restored.run.status).toBe('completed');
    expect(restored.tasks[0].status).toBe('completed');
    expect(runLoop).not.toHaveBeenCalled();
  });

  it('does not mark an interrupted multi-bubble reply complete from its first bubble', async () => {
    const { chatId, source } = setup();
    const runId = aiDirectReplyRunId(chatId, source.id);
    useMessageStore.getState().upsertMessage({ ...source, id: crypto.randomUUID(), type: 'ai', senderId: 'a', senderName: 'a', content: '第一句', timestamp: source.timestamp + 1,
      metadata: { directReplyToUserMessageId: source.id, turnSegment: { index: 0, count: 2 } } });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: 'AI 私聊回复', status: 'active', generation: 1, planVersion: 1, updatedAt: Date.now() },
      tasks: [{ id: source.id, runId, kind: 'ai_direct_reply', input: { chatId, userMessageId: source.id }, dependsOn: [], status: 'running', attempt: 1, updatedAt: Date.now() }],
    }, value: undefined }));
    await recoverAiDirectBackgroundReplies();
    const restored = (await listAiDirectBackgroundReplies(chatId))[0];
    expect(restored.run.status).toBe('paused');
    expect(restored.tasks[0].status).toBe('result_unknown');
  });
});
