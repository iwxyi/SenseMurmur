import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { buildAssistantChatDraft } from './chatDraftBuilder';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import type { Message } from '../types/message';
import { assistantReplyRunId, listAssistantBackgroundReplies, recoverAssistantBackgroundReplies, resumeAssistantBackgroundReply, retryAssistantBackgroundReply, startAssistantBackgroundReply } from './assistantBackgroundReply';
import { currentWorkflowScope, indexedDbWorkflowRepository } from './workflowRunRuntime';
import { buildBranchStateWithHead } from './messageBranching';
import { projectActiveBranchMessages } from './messageBranching';

const reply = vi.hoisted(() => vi.fn());
const decideRoute = vi.hoisted(() => vi.fn());
const runTeam = vi.hoisted(() => vi.fn());
vi.mock('./assistantChatFlow', () => ({ runAssistantChatReplyFlow: reply }));
vi.mock('./assistantTeamIntent', () => ({ decideAssistantTaskRoute: decideRoute }));
vi.mock('./agentTeamWorkflow', () => ({ runAgentTeam: runTeam }));

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
  decideRoute.mockReset().mockResolvedValue({ route: 'reply' });
  runTeam.mockReset().mockResolvedValue({ snapshot: { run: { status: 'completed', id: 'team-run', chatId: '', goal: '', generation: 1, planVersion: 1, updatedAt: 1 }, tasks: [] } });
});

describe('assistant background reply', () => {
  it('routes a multi-step chat request into one team run without a manual form', async () => {
    const chatId = crypto.randomUUID();
    const chat = { ...buildAssistantChatDraft({ agentAvailable: true }), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1 };
    const userMessage: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '用户',
      content: '从调研到脚本再到制作视频，一口气完成', emotion: 0, timestamp: Date.now(), isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    decideRoute.mockResolvedValue({ route: 'team', goal: userMessage.content });
    const first = await startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id });
    expect(first.snapshot.run.status).toBe('completed');
    await vi.waitFor(() => expect(runTeam).toHaveBeenCalledWith(expect.objectContaining({ chatId, goal: userMessage.content, sourceMessageId: userMessage.id })));
    const startMessages = useMessageStore.getState().messages.filter((message) => message.metadata?.assistantReplyToUserMessageId === userMessage.id);
    expect(startMessages).toHaveLength(1);
    expect(startMessages[0].content).toContain('后台执行');
    expect(reply).not.toHaveBeenCalled();
    expect(await listAssistantBackgroundReplies(chatId)).toEqual([]);
    await resumeAssistantBackgroundReply(first.snapshot.run.id, 'resume');
    await vi.waitFor(() => expect(runTeam).toHaveBeenCalledTimes(2));
    expect(useMessageStore.getState().messages.filter((message) => message.metadata?.assistantReplyToUserMessageId === userMessage.id)).toHaveLength(1);
    expect(decideRoute).toHaveBeenCalledTimes(1);
  });

  it('returns a readable assistant message when team planning fails on a missing video model', async () => {
    const chatId = crypto.randomUUID();
    const chat = { ...buildAssistantChatDraft({ agentAvailable: true }), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1 };
    const userMessage: Message = { id: crypto.randomUUID(), chatId, type: 'user', senderId: 'user', senderName: '用户',
      content: '帮我完成一个短视频', emotion: 0, timestamp: Date.now(), isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    decideRoute.mockResolvedValue({ route: 'team', goal: userMessage.content });
    runTeam.mockResolvedValue({ snapshot: { run: { id: 'team-failed', chatId, goal: userMessage.content, status: 'failed', generation: 1, planVersion: 1, updatedAt: Date.now() },
      tasks: [{ id: 'plan', runId: 'team-failed', kind: 'team_plan', input: userMessage.content, dependsOn: [], status: 'failed', error: '当前未配置视频模型', attempt: 1, updatedAt: Date.now() }] } });
    const started = await startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id });
    expect(started.snapshot.run.status).toBe('completed');
    await vi.waitFor(() => expect(useMessageStore.getState().messages.some((message) => message.metadata?.assistantTeamFinal)).toBe(true));
    const finalReply = useMessageStore.getState().messages.find((message) => message.metadata?.assistantTeamFinal);
    expect(finalReply?.content).toContain('当前未配置视频模型');
    expect(finalReply?.content).toContain('模型设置');
    expect(finalReply?.content).toContain('工作台重试规划');
  });

  it('keeps a routed team start and failure on the edited message branch', async () => {
    const chatId = crypto.randomUUID();
    const oldUser: Message = { id: 'old-user', chatId, type: 'user', senderId: 'user', senderName: '用户',
      content: '旧目标', emotion: 0, timestamp: 1, isDeleted: false,
      metadata: { branching: { nodeId: 'old-user', parentNodeId: null, rootNodeId: 'old-user', sequence: 1 } } };
    const revisedUser: Message = { ...oldUser, id: 'revised-user', content: '新目标', timestamp: 2,
      metadata: { branching: { nodeId: 'revised-user', parentNodeId: null, rootNodeId: 'old-user', sequence: 2,
        revisionOfNodeId: 'old-user' } } };
    const chat = { ...buildAssistantChatDraft({ agentAvailable: true }), id: chatId, createdAt: 1, updatedAt: 2, lastMessageAt: 2,
      messageBranchState: { enabled: true, activeBranchName: 'main', activeLeafNodeId: revisedUser.id,
        refs: { main: { name: 'main', headNodeId: revisedUser.id, createdAt: 1, updatedAt: 2, version: 1 },
          other: { name: 'other', headNodeId: oldUser.id, createdAt: 1, updatedAt: 2, version: 1 } } } };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [oldUser, revisedUser], messageWindowsByChatId: {} });
    decideRoute.mockResolvedValue({ route: 'team', goal: revisedUser.content });
    runTeam.mockImplementation(async (params: { goalSpec?: { sourceBranch?: { headNodeId: string | null } } }) => ({
      snapshot: { run: { id: 'team-revised-user', chatId, goal: revisedUser.content, goalSpec: params.goalSpec,
        status: 'failed', generation: 1, planVersion: 1, updatedAt: Date.now() },
      tasks: [{ id: 'plan', runId: 'team-revised-user', kind: 'team_plan', input: revisedUser.content,
        dependsOn: [], status: 'failed', error: '当前未配置视频模型', attempt: 1, updatedAt: Date.now() }] },
    }));
    await startAssistantBackgroundReply({ chatId, userMessageId: revisedUser.id, expectedBranchLeafNodeId: revisedUser.id });
    await vi.waitFor(() => expect(useMessageStore.getState().messages.some((message) => message.metadata?.assistantTeamFinal)).toBe(true));
    const messages = useMessageStore.getState().messages.filter((message) => message.chatId === chatId);
    const start = messages.find((message) => message.metadata?.branching?.nodeId === 'assistant-team-start-revised-user');
    const failure = messages.find((message) => message.metadata?.branching?.nodeId === 'assistant-team-result-revised-user');
    expect(start?.metadata?.branching?.parentNodeId).toBe(revisedUser.id);
    expect(failure?.metadata?.branching?.parentNodeId).toBe(start?.metadata?.branching?.nodeId);
    expect(runTeam.mock.calls.at(-1)?.[0].goalSpec.sourceBranch.headNodeId).toBe(revisedUser.id);
    const selected = useChatStore.getState().chats.find((item) => item.id === chatId)!;
    expect(projectActiveBranchMessages(selected, messages).map((message) => message.metadata?.branching?.nodeId)).toContain(failure?.metadata?.branching?.nodeId);
  });

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

  it('rewinds and commits a regenerated assistant reply inside its durable run', async () => {
    const chatId = crypto.randomUUID();
    const oldState = { enabled: true, activeBranchName: 'main', activeLeafNodeId: 'assistant-old', refs: {
      main: { name: 'main', headNodeId: 'assistant-old', createdAt: 1, updatedAt: 1, version: 1 },
    } };
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 2, messageBranchState: oldState };
    const userMessage: Message = { id: 'user-root', chatId, type: 'user', senderId: 'user', senderName: '用户', content: '先回答', emotion: 0, timestamp: 1, isDeleted: false,
      metadata: { branching: { nodeId: 'user-node', parentNodeId: null, sequence: 0 } } };
    const oldReply: Message = { id: 'old-reply', chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '旧答案', emotion: 0, timestamp: 2, isDeleted: false,
      metadata: { branching: { nodeId: 'assistant-old', parentNodeId: 'user-node', sequence: 1 } } };
    const newReply: Message = { id: 'new-reply', chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '新答案', emotion: 0, timestamp: 3, isDeleted: false,
      metadata: { branching: { nodeId: 'assistant-new', parentNodeId: 'user-node', sequence: 2 } } };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage, oldReply], messageWindowsByChatId: {} });
    reply.mockResolvedValue(newReply);
    const runId = `${chatId}\nregenerate\nassistant-old\nattempt-one`;
    const result = await startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id, runId, replyRunId: runId,
      replyTimestamp: 3, revisionOfNodeId: 'assistant-old', replySender: { id: 'assistant', name: '助手' },
      branchRegeneration: { branchName: 'main', expectedActiveLeafNodeId: 'assistant-old',
        rewoundState: buildBranchStateWithHead(oldState, 'user-node', 'main') } });
    expect(result.snapshot.run.status).toBe('completed');
    expect(reply.mock.calls[0][0].currentMessages).toContainEqual(userMessage);
    expect(reply.mock.calls[0][0].currentMessages).not.toContainEqual(oldReply);
    expect(reply.mock.calls[0][0]).toMatchObject({ replyRunId: runId, revisionOfNodeId: 'assistant-old' });
    expect(useChatStore.getState().chats[0].messageBranchState?.activeLeafNodeId).toBe('assistant-new');
  });

  it('does not rewind a branch changed while regeneration waits in the scheduler', async () => {
    const chatId = crypto.randomUUID();
    const state = { enabled: true, activeBranchName: 'main', activeLeafNodeId: 'different-node' };
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 2, messageBranchState: state };
    const userMessage: Message = { id: 'user-root', chatId, type: 'user', senderId: 'user', senderName: '用户', content: '先回答', emotion: 0, timestamp: 1, isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    const rewoundState = buildBranchStateWithHead(state, 'user-root', 'main');
    const result = await startAssistantBackgroundReply({ chatId, userMessageId: userMessage.id, runId: `${chatId}\nregenerate\nstale`,
      branchRegeneration: { sourceNodeId: 'assistant-old', branchName: 'main', expectedActiveLeafNodeId: 'assistant-old', rewoundState } });
    expect(result.summary.blocked[0]?.reason).toContain('消息分支已切换');
    expect(useChatStore.getState().chats[0].messageBranchState?.activeLeafNodeId).toBe('different-node');
    expect(reply).not.toHaveBeenCalled();
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

  it('retries a failed HTML repair as a new run with its original artifact and branch context', async () => {
    const chatId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const originalRunId = `html-repair-${crypto.randomUUID()}`;
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1,
      messageBranchState: { enabled: true, activeBranchName: 'main', activeLeafNodeId: 'branch-head' } };
    const userMessage: Message = { id: userMessageId, chatId, type: 'user', senderId: 'user', senderName: '用户', content: '修复页面', emotion: 0, timestamp: 1, isDeleted: false };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage], messageWindowsByChatId: {} });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), originalRunId, () => ({ snapshot: {
      run: { id: originalRunId, chatId, goal: '修复 HTML 页面', status: 'failed', generation: 1, planVersion: 1, updatedAt: 2 },
      tasks: [{ id: userMessageId, runId: originalRunId, kind: 'assistant_reply', input: { chatId, userMessageId,
        replyRunId: originalRunId, selectedArtifactId: 'artifact-1', expectedBranchLeafNodeId: 'branch-head', replyTimestamp: 2 },
      dependsOn: [], status: 'failed', error: '修复失败', attempt: 1, updatedAt: 2 }],
    }, value: undefined }));
    reply.mockResolvedValue({ id: 'repair-reply' });

    const result = await retryAssistantBackgroundReply(originalRunId, 'retry-command');

    expect(result.snapshot.run.id).toContain(`${originalRunId}\nretry\nretry-command`);
    expect(result.snapshot.run).toMatchObject({ retryOfRunId: originalRunId, retryRootRunId: originalRunId });
    expect(result.snapshot.run.status).toBe('completed');
    expect(reply.mock.calls[0][0]).toMatchObject({
      chatId,
      selectedArtifactId: 'artifact-1',
      currentMessages: [userMessage],
    });
    expect(reply.mock.calls[0][0].replyRunId).not.toBe(originalRunId);
    expect((await listAssistantBackgroundReplies(chatId))).toHaveLength(2);
  });

  it('requires explicit confirmation before retrying an uncertain request', async () => {
    const chatId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const runId = `uncertain-${crypto.randomUUID()}`;
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '生成媒体', status: 'paused', generation: 1, planVersion: 1, updatedAt: 2 },
      tasks: [{ id: userMessageId, runId, kind: 'assistant_reply', input: { chatId, userMessageId }, dependsOn: [],
        status: 'result_unknown', error: '请求结果未确认', attempt: 1, updatedAt: 2 }],
    }, value: undefined }));

    await expect(retryAssistantBackgroundReply(runId, 'retry-command')).rejects.toThrow('必须确认可能重复调用');
    expect(await listAssistantBackgroundReplies(chatId)).toHaveLength(1);
    expect(reply).not.toHaveBeenCalled();
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

  it('restores the regenerated branch head when recovery finds its committed reply', async () => {
    const chatId = crypto.randomUUID();
    const userMessageId = 'user-root';
    const runId = `${chatId}\nregenerate\nassistant-old\nrecover`;
    const rewoundState = { enabled: true, activeBranchName: 'main', activeLeafNodeId: 'user-node', refs: {
      main: { name: 'main', headNodeId: 'user-node', createdAt: 1, updatedAt: 1, version: 2 },
    } };
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: 1, updatedAt: 1, lastMessageAt: 1, messageBranchState: rewoundState };
    const userMessage: Message = { id: userMessageId, chatId, type: 'user', senderId: 'user', senderName: '用户', content: '先回答', emotion: 0, timestamp: 1, isDeleted: false,
      metadata: { branching: { nodeId: 'user-node', parentNodeId: null, sequence: 0 } } };
    const replyMessage: Message = { id: 'new-reply', chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '新答案', emotion: 0, timestamp: 3, isDeleted: false,
      metadata: { assistantReplyToUserMessageId: userMessageId, assistantReplyRunId: runId,
        branching: { nodeId: 'assistant-new', parentNodeId: 'user-node', sequence: 2 } } };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ activeChatId: chatId, messages: [userMessage, replyMessage], messageWindowsByChatId: {} });
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId, goal: '重新回答助手消息', status: 'active', generation: 1, planVersion: 1, updatedAt: 2 },
      tasks: [{ id: userMessageId, runId, kind: 'assistant_reply', input: { chatId, userMessageId, replyRunId: runId,
      branchRegeneration: { branchName: 'main', expectedActiveLeafNodeId: 'assistant-old', rewoundState } },
      dependsOn: [], status: 'running', attempt: 1, updatedAt: 2 }],
    }, value: undefined }));
    await recoverAssistantBackgroundReplies();
    expect((await listAssistantBackgroundReplies(chatId)).find((run) => run.run.id === runId)?.run.status).toBe('completed');
    expect(useChatStore.getState().chats[0].messageBranchState?.activeLeafNodeId).toBe('assistant-new');
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
