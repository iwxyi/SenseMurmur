import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { aiDirectConversationRunId, groupConversationRunId, isGroupBackgroundTurnBlocked, listAiDirectBackgroundConversations, listGroupBackgroundConversations, pauseAiDirectBackgroundConversation, pauseGroupBackgroundConversation, recoverGroupBackgroundConversations, resumeGroupBackgroundConversation, startAiDirectBackgroundConversation, startGroupBackgroundConversation } from './groupBackgroundConversation';
import { currentWorkflowScope, indexedDbWorkflowRepository, workflowRunLockName } from './workflowRunRuntime';

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
  it('stops a story room at visible branch choices until the reader selects one', () => {
    const chat = normalizeConversation({
      id: 'story-room', type: 'group', name: '故事房', memberIds: ['a'], createdAt: 1, updatedAt: 1, lastMessageAt: 1,
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' },
      scenarioState: { phase: 'choice', choiceEpoch: 1 },
    });
    const choices = [{ label: '打开档案室', prompt: '去档案室' }, { label: '追问医生', prompt: '追问医生' }];
    const messages = [{ id: 'choice', chatId: chat.id, type: 'ai', senderId: 'narrator', senderName: '旁白', content: '请选择', emotion: 0,
      timestamp: 1, metadata: { storyChoices: choices } }] as Message[];
    expect(isGroupBackgroundTurnBlocked(chat, messages)).toBe(true);
    expect(isGroupBackgroundTurnBlocked({ ...chat, scenarioState: { ...chat.scenarioState, phase: 'branch' } }, messages)).toBe(false);
  });

  it('persists a stopped story turn without generating past an unselected choice', async () => {
    const chatId = setup();
    const current = useChatStore.getState().chats[0];
    const storyChat = normalizeConversation({
      ...current,
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' },
      scenarioState: { phase: 'choice', choiceEpoch: 1 },
    });
    useChatStore.setState({ chats: [storyChat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [{ id: 'choice', chatId, type: 'ai', senderId: 'narrator', senderName: '旁白', content: '请选择', emotion: 0,
      timestamp: 1, metadata: { storyChoices: [{ label: '打开档案室' }, { label: '追问医生' }] } } as Message], messageWindowsByChatId: {} });

    await startGroupBackgroundConversation(chatId);

    const snapshot = (await listGroupBackgroundConversations(chatId))[0];
    expect(snapshot.tasks[0]).toMatchObject({ status: 'completed', output: { outcome: 'stopped', reason: 'waiting_story_choice' } });
    expect(runLoop).not.toHaveBeenCalled();
  });

  it('runs one learner-triggered study reply in the background and then waits for new input', async () => {
    const chatId = setup();
    const current = useChatStore.getState().chats[0];
    const studyChat = normalizeConversation({
      ...current,
      memberIds: ['user', 'a'],
      sessionKind: { topology: 'group', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' },
      scenarioState: { phase: 'learning', learning: { goal: '学习数据库索引', knowledgeItems: [] } },
    });
    useChatStore.setState({ chats: [studyChat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [{ id: 'learner-question', chatId, type: 'user', senderId: 'user', senderName: '学习者', content: '什么是覆盖索引？', emotion: 0,
      timestamp: 1 } as Message], messageWindowsByChatId: {} });
    runLoop.mockImplementation(async (params: { groupTurnTaskId: string; onCommittedMessage: (message: Message) => void }) => {
      params.onCommittedMessage({ id: 'teacher-reply', chatId, type: 'ai', senderId: 'a', senderName: 'a', content: '覆盖索引包含查询需要的字段。', emotion: 0,
        timestamp: Date.now(), metadata: { groupTurnTaskId: params.groupTurnTaskId } });
    });

    await startGroupBackgroundConversation(chatId);

    const snapshot = (await listGroupBackgroundConversations(chatId))[0];
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(snapshot.tasks.map((task) => task.status)).toEqual(['completed']);
    expect(snapshot.tasks[0].output).toMatchObject({ outcome: 'committed', messageId: 'teacher-reply' });
    expect(useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive).toBe(false);
  });

  it('runs analysis rooms through the persistent background turn executor', async () => {
    const chatId = setup();
    const current = useChatStore.getState().chats[0];
    useChatStore.setState({ chats: [normalizeConversation({
      ...current,
      sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
    })] });
    runLoop.mockImplementation(async (params: { onIdle: () => void }) => params.onIdle());

    await startGroupBackgroundConversation(chatId);

    const snapshot = (await listGroupBackgroundConversations(chatId))[0];
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'completed', output: { outcome: 'stopped' } });
    expect(useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive).toBe(false);
  });

  it('runs AI private threads in a persistent turn and honors pause after the current reply', async () => {
    const chatId = setup();
    const current = useChatStore.getState().chats[0];
    useChatStore.setState({ chats: [normalizeConversation({
      ...current,
      type: 'ai_direct',
      sessionKind: { topology: 'thread', family: 'conversation', scenarioId: 'ai-private-thread', surfaceProfile: 'text' },
      sourceChatId: 'source-group',
      sourceMemberIds: ['a', 'b'],
    })] });
    runLoop.mockImplementation(async (params: { groupTurnTaskId: string; onCommittedMessage: (message: Message) => void }) => {
      params.onCommittedMessage({ id: 'private-thread-reply', chatId, type: 'ai', senderId: 'b', senderName: 'b', content: '我也想把这件事说清楚。', emotion: 0,
        timestamp: Date.now(), metadata: { groupTurnTaskId: params.groupTurnTaskId } });
      await pauseAiDirectBackgroundConversation(chatId);
    });

    await startAiDirectBackgroundConversation(chatId);

    const saved = (await listAiDirectBackgroundConversations(chatId))[0];
    expect(saved.run.id).toBe(aiDirectConversationRunId(chatId));
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0]).toMatchObject({ status: 'completed', output: { outcome: 'committed', messageId: 'private-thread-reply' } });
    expect(saved.run.status).toBe('paused');
    expect(useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive).toBe(false);
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect((await listGroupBackgroundConversations(chatId))).toHaveLength(0);
  });

  it('waits for the reader after one committed story chapter and resumes on explicit start', async () => {
    const chatId = setup();
    const current = useChatStore.getState().chats[0];
    useChatStore.setState({ chats: [normalizeConversation({ ...current,
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' },
      scenarioState: { phase: 'scene', choiceEpoch: 0 },
    })] });
    runLoop.mockImplementation(async (params: { groupTurnTaskId: string; onCommittedMessage: (message: Message) => void }) => {
      params.onCommittedMessage({ id: `chapter-${runLoop.mock.calls.length}`, chatId, type: 'ai', senderId: 'a', senderName: 'a', content: '故事继续。', emotion: 0,
        timestamp: Date.now(), metadata: { groupTurnTaskId: params.groupTurnTaskId } });
    });

    await startGroupBackgroundConversation(chatId);
    const first = (await listGroupBackgroundConversations(chatId))[0];
    expect(first.tasks).toHaveLength(1);
    expect(first.tasks[0].output).toMatchObject({ outcome: 'committed', messageId: 'chapter-1' });
    expect(useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive).toBe(false);

    await startGroupBackgroundConversation(chatId);
    const second = (await listGroupBackgroundConversations(chatId))[0];
    expect(second.run.id).toBe(first.run.id);
    expect(second.tasks).toHaveLength(2);
    expect(second.tasks[1].output).toMatchObject({ outcome: 'committed', messageId: 'chapter-2' });
    expect(runLoop).toHaveBeenCalledTimes(2);
  });

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

  it('coalesces simultaneous starts before the run is created', async () => {
    const chatId = setup();
    runLoop.mockImplementation(async (params: { onWaitingForInput: () => void }) => params.onWaitingForInput());
    const first = startGroupBackgroundConversation(chatId);
    const second = startGroupBackgroundConversation(chatId);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect((await listGroupBackgroundConversations(chatId))).toHaveLength(1);
  });

  it('does not drive turns when another tab owns the group loop', async () => {
    const chatId = setup();
    const runId = groupConversationRunId(chatId);
    const now = Date.now();
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '群聊自动运行', status: 'active', planOpen: true, generation: 0, planVersion: 1, updatedAt: now },
      tasks: [{ id: `${runId}:turn:1`, runId, kind: 'group_conversation_turn', input: { chatId },
        dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }],
    }, value: undefined }));
    await useChatStore.getState().updateChat(chatId, { isActive: true });
    const driverLock = `${workflowRunLockName(currentWorkflowScope(), runId)}:driver`;
    vi.stubGlobal('navigator', { locks: { request: async (name: string, options: unknown, callback?: (lock: object | null) => Promise<unknown>) =>
      (callback || options as (lock: object | null) => Promise<unknown>)(name === driverLock ? null : {}) } });
    await resumeGroupBackgroundConversation(chatId);
    await recoverGroupBackgroundConversations();
    expect(runLoop).not.toHaveBeenCalled();
    const saved = (await listGroupBackgroundConversations(chatId))[0];
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0].status).toBe('queued');
    expect(saved.run.status).toBe('active');
    expect(useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive).toBe(true);
  });
});
