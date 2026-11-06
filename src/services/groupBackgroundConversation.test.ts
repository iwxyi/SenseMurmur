import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { groupConversationRunId, listGroupBackgroundConversations, pauseGroupBackgroundConversation, recoverGroupBackgroundConversations, startGroupBackgroundConversation } from './groupBackgroundConversation';
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
  const chat = normalizeConversation({ id: chatId, type: 'group', name: '群聊', memberIds: ['a', 'b'], createdAt: 1, updatedAt: 1, lastMessageAt: 1, isActive: false });
  useChatStore.setState({ chats: [chat] });
  useCharacterStore.setState((state) => ({ characters: ['a', 'b'].map((id) => ({ ...state.characters[0], id, name: id })) as typeof state.characters }));
  useMessageStore.setState({ activeChatId: chatId, messages: [], messageWindowsByChatId: {} });
  return chatId;
}

describe('background group conversation', () => {
  it('runs after the page closes and continues in the same persisted run after new input', async () => {
    const chatId = setup();
    runLoop.mockImplementation(async (params: { groupTurnTaskId: string; onCommittedMessage: (message: Message) => void; onWaitingForInput: () => void }) => {
      useMessageStore.setState({ activeChatId: null, messages: [] });
      if (runLoop.mock.calls.length === 1) {
        params.onCommittedMessage({ id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'a', senderName: 'a', content: '第一句', emotion: 0,
          timestamp: Date.now(), metadata: { groupTurnTaskId: params.groupTurnTaskId } });
      } else {
        params.onWaitingForInput();
      }
    });
    await startGroupBackgroundConversation(chatId);
    const first = (await listGroupBackgroundConversations(chatId))[0];
    expect(first.tasks.map((task) => task.status)).toEqual(['completed', 'completed']);
    expect(first.tasks[0].output).toMatchObject({ outcome: 'committed' });
    expect(first.tasks[1].output).toEqual({ outcome: 'stopped' });
    expect(useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive).toBe(false);

    runLoop.mockImplementation(async (params: { onWaitingForInput: () => void }) => params.onWaitingForInput());
    await startGroupBackgroundConversation(chatId);
    const next = (await listGroupBackgroundConversations(chatId))[0];
    expect(next.run.id).toBe(first.run.id);
    expect(next.tasks).toHaveLength(3);
    expect(runLoop).toHaveBeenCalledTimes(3);
  });

  it('reconciles a saved full turn on restart without generating it again', async () => {
    const chatId = setup();
    const runId = groupConversationRunId(chatId);
    const taskId = `${runId}:turn:1`;
    const reply: Message = { id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'a', senderName: 'a', content: '已保存', emotion: 0,
      timestamp: Date.now(), metadata: { groupTurnTaskId: taskId } };
    useMessageStore.setState({ activeChatId: chatId, messages: [reply] });
    await useChatStore.getState().updateChat(chatId, { isActive: true });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '群聊自动运行', status: 'active', planOpen: true, generation: 1, planVersion: 1, updatedAt: Date.now() },
      tasks: [{ id: taskId, runId, kind: 'group_conversation_turn', input: { chatId }, dependsOn: [], status: 'running', attempt: 1, updatedAt: Date.now() }],
    }, value: undefined }));
    await recoverGroupBackgroundConversations();
    const restored = (await listGroupBackgroundConversations(chatId))[0];
    expect(restored.run.status).toBe('paused');
    expect(restored.tasks[0]).toMatchObject({ status: 'completed', output: { outcome: 'committed', messageId: reply.id } });
    expect(useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive).toBe(false);
    expect(runLoop).not.toHaveBeenCalled();
  });

  it('holds an unconfirmed in-flight turn instead of resending it', async () => {
    const chatId = setup();
    const runId = groupConversationRunId(chatId);
    const taskId = `${runId}:turn:1`;
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '群聊自动运行', status: 'active', planOpen: true, generation: 1, planVersion: 1, updatedAt: Date.now() },
      tasks: [{ id: taskId, runId, kind: 'group_conversation_turn', input: { chatId }, dependsOn: [], status: 'running', attempt: 1, updatedAt: Date.now() }],
    }, value: undefined }));
    await recoverGroupBackgroundConversations();
    const restored = (await listGroupBackgroundConversations(chatId))[0];
    expect(restored.tasks[0].status).toBe('result_unknown');
    await expect(startGroupBackgroundConversation(chatId)).rejects.toThrow('结果需要核对');
    expect(runLoop).not.toHaveBeenCalled();
  });

  it('reconciles a saved turn even after an earlier recovery marked it uncertain', async () => {
    const chatId = setup();
    const runId = groupConversationRunId(chatId);
    const taskId = `${runId}:turn:1`;
    const reply: Message = { id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'a', senderName: 'a', content: '已保存', emotion: 0,
      timestamp: Date.now(), metadata: { groupTurnTaskId: taskId } };
    useMessageStore.setState({ activeChatId: chatId, messages: [reply] });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '群聊自动运行', status: 'paused', planOpen: true, generation: 2, planVersion: 1, updatedAt: Date.now() },
      tasks: [{ id: taskId, runId, kind: 'group_conversation_turn', input: { chatId }, dependsOn: [], status: 'result_unknown', attempt: 1, updatedAt: Date.now() }],
    }, value: undefined }));
    await recoverGroupBackgroundConversations();
    const restored = (await listGroupBackgroundConversations(chatId))[0];
    expect(restored.tasks[0]).toMatchObject({ status: 'completed', output: { outcome: 'committed', messageId: reply.id } });
    expect(runLoop).not.toHaveBeenCalled();
  });

  it('finishes the current turn when paused and does not dispatch another', async () => {
    const chatId = setup();
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let enteredTurn: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredTurn = resolve; });
    runLoop.mockImplementation(async (params: { groupTurnTaskId: string; onCommittedMessage: (message: Message) => void }) => {
      enteredTurn?.();
      await turnGate;
      params.onCommittedMessage({ id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'a', senderName: 'a', content: '暂停前完成', emotion: 0,
        timestamp: Date.now(), metadata: { groupTurnTaskId: params.groupTurnTaskId } });
    });
    const running = startGroupBackgroundConversation(chatId);
    await entered;
    await pauseGroupBackgroundConversation(chatId);
    releaseTurn?.();
    await running;
    const saved = (await listGroupBackgroundConversations(chatId))[0];
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0].status).toBe('completed');
    expect(saved.run.status).toBe('paused');
    expect(runLoop).toHaveBeenCalledTimes(1);
  });

  it('reopening an active chat does not restart its in-flight turn or undo pause', async () => {
    const chatId = setup();
    let releaseTurn: (() => void) | undefined;
    let enteredTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const entered = new Promise<void>((resolve) => { enteredTurn = resolve; });
    runLoop.mockImplementation(async (params: { groupTurnTaskId: string; onCommittedMessage: (message: Message) => void }) => {
      enteredTurn?.();
      await turnGate;
      params.onCommittedMessage({ id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'a', senderName: 'a', content: '已完成', emotion: 0,
        timestamp: Date.now(), metadata: { groupTurnTaskId: params.groupTurnTaskId } });
    });
    const running = startGroupBackgroundConversation(chatId);
    await entered;
    const reopened = startGroupBackgroundConversation(chatId);
    await pauseGroupBackgroundConversation(chatId);
    releaseTurn?.();
    await Promise.all([running, reopened]);
    const saved = (await listGroupBackgroundConversations(chatId))[0];
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(saved.tasks).toHaveLength(1);
    expect(saved.run.status).toBe('paused');
    expect(useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive).toBe(false);
  });
});
