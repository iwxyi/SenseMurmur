import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { buildAssistantChatDraft } from './chatDraftBuilder';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import type { Message } from '../types/message';
import { assistantReplyRunId, listAssistantBackgroundReplies, recoverAssistantBackgroundReplies, resumeAssistantBackgroundReply, startAssistantBackgroundReply } from './assistantBackgroundReply';
import { currentWorkflowScope, indexedDbWorkflowRepository } from './workflowRunRuntime';

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
  it('coalesces simultaneous starts for the same user message', async () => {
    const chatId = crypto.randomUUID();
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1 };
    const userMessage: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '用户', content: '写一段介绍', emotion: 0, timestamp: 1, isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    reply.mockResolvedValue({ id: 'reply-1' });
    const [first, second] = await Promise.all([
      startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id }),
      startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id }),
    ]);
    expect(first.snapshot.run.status).toBe('completed');
    expect(second.snapshot.run.status).toBe('completed');
    expect(reply).toHaveBeenCalledTimes(1);
    expect(await listAssistantBackgroundReplies(chatId)).toHaveLength(1);
  });

  it('excludes other workflow kinds from assistant reply listings', async () => {
    const chatId = crypto.randomUUID();
    const runId = `team-${crypto.randomUUID()}`;
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '团队目标', status: 'paused', generation: 0, planVersion: 1, updatedAt: 1 },
      tasks: [{ id: 'plan', runId, kind: 'team_plan', input: '团队目标', dependsOn: [], status: 'queued', attempt: 0, updatedAt: 1 }],
    }, value: undefined }));
    expect(await listAssistantBackgroundReplies(chatId)).toEqual([]);
  });

  it('uses the stored user message and current account scoped run', async () => {
    const chatId = crypto.randomUUID();
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1 };
    const userMessage: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '用户', content: '写一段介绍', emotion: 0, timestamp: Date.now(), isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    reply.mockResolvedValue({ id: 'reply-1' });
    const result = await startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id, selectedArtifactId: 'html-artifact' });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0].currentMessages).toContainEqual(userMessage);
    expect(reply.mock.calls[0][0].selectedArtifactId).toBe('html-artifact');
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks[0].output).toBe('reply-1');
    expect((await listAssistantBackgroundReplies(chatId))[0].run.id).toBe(assistantReplyRunId(chatId, userMessage.id));
    await recoverAssistantBackgroundReplies();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('keeps an edited reply on its captured branch and refuses to answer after branch switch', async () => {
    const chatId = crypto.randomUUID();
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1,
      messageBranchState: { enabled: true, activeBranchName: 'main', activeLeafNodeId: 'edited-node' } };
    const userMessage: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '用户', content: '修订后的请求', emotion: 0, timestamp: Date.now(), isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    reply.mockResolvedValue({ id: 'reply-branch' });
    const result = await startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id, expectedBranchLeafNodeId: 'edited-node' });
    expect(result.snapshot.tasks[0].input).toMatchObject({ expectedBranchLeafNodeId: 'edited-node' });
    expect(reply).toHaveBeenCalledTimes(1);

    const switchedChat = { ...chat, messageBranchState: { ...chat.messageBranchState, activeLeafNodeId: 'other-node' } };
    useChatStore.setState({ chats: [switchedChat] });
    const otherMessage: Message = { ...userMessage, id: crypto.randomUUID(), content: '另一条分支消息', timestamp: userMessage.timestamp + 1 };
    useMessageStore.setState({ messages: [userMessage, otherMessage] });
    const blocked = await startAssistantBackgroundReply({ chatId, userMessageId: otherMessage.id, expectedBranchLeafNodeId: 'edited-node' });
    expect(blocked.summary.blocked[0]?.reason).toContain('消息分支已切换');
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

  it('reconciles an already committed reply before marking an interrupted run unknown', async () => {
    const chatId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const runId = assistantReplyRunId(chatId, userMessageId);
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 2 };
    const userMessage: Message = { id: userMessageId, chatId, type: 'user', senderId: 'user', senderName: '用户', content: '写介绍', emotion: 0, timestamp: 1, isDeleted: false };
    const committed: Message = { id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '介绍已完成', emotion: 0,
      timestamp: 2, isDeleted: false, metadata: { assistantReplyToUserMessageId: userMessageId } };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage, committed], messageWindowsByChatId: {} });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '回复用户消息', status: 'active', generation: 1, planVersion: 1, updatedAt: 1 },
      tasks: [{ id: userMessageId, runId, kind: 'assistant_reply', input: { chatId, userMessageId }, dependsOn: [], status: 'running', attempt: 1, updatedAt: 1 }],
    }, value: undefined }));
    await recoverAssistantBackgroundReplies();
    const recovered = (await listAssistantBackgroundReplies(chatId))[0];
    expect(recovered.run.status).toBe('completed');
    expect(recovered.tasks[0]).toMatchObject({ status: 'completed', output: committed.id });
    await resumeAssistantBackgroundReply(runId, crypto.randomUUID());
    expect(reply).not.toHaveBeenCalled();
  });

  it('does not mistake a regenerated reply for a pending background run result', async () => {
    const chatId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const runId = assistantReplyRunId(chatId, userMessageId);
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 2 };
    const userMessage: Message = { id: userMessageId, chatId, type: 'user', senderId: 'user', senderName: '用户', content: '写介绍', emotion: 0, timestamp: 1, isDeleted: false };
    const regenerated: Message = { id: crypto.randomUUID(), chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '重新回答', emotion: 0,
      timestamp: 2, isDeleted: false, metadata: { assistantReplyToUserMessageId: userMessageId } };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage, regenerated], messageWindowsByChatId: {} });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '回复用户消息', status: 'active', generation: 1, planVersion: 1, updatedAt: 1 },
      tasks: [{ id: userMessageId, runId, kind: 'assistant_reply', input: { chatId, userMessageId, replyRunId: runId }, dependsOn: [], status: 'running', attempt: 1, updatedAt: 1 }],
    }, value: undefined }));
    await recoverAssistantBackgroundReplies();
    const recovered = (await listAssistantBackgroundReplies(chatId))[0];
    expect(recovered.run.status).toBe('paused');
    expect(recovered.tasks[0].status).toBe('result_unknown');
  });
});
