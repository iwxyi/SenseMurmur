import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { inspectAgentTeamImageAttachment, queueAgentTeamImage, teamImageReference } from './agentTeamImageTask';
import { isLocalOnlyMediaMode, processRichMessageMedia } from './richMessageMedia';
import { captureTeamSourceBranch } from './agentTeamConversation';
import { projectCurrentChatMessages } from './currentChatMessages';

vi.mock('./richMessageMedia', () => ({ processRichMessageMedia: vi.fn(), isLocalOnlyMediaMode: vi.fn(() => true) }));

const profile = { id: 'image-test', name: '测试图片', type: 'image' as const, provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true };

function imageMessage(status: 'queued' | 'generating' | 'ready' | 'failed', url?: string): Message {
  return { id: 'team-image-run-shot', chatId: 'team-image-chat', type: 'ai', senderId: 'assistant', senderName: '助手', content: '图片', emotion: 0,
    timestamp: 1, isDeleted: false, metadata: { agentTeamMedia: { runId: 'run', taskId: 'shot' }, attachments: [{
      id: 'team-image-shot', kind: 'image', status, altText: '团队生成图片', promptText: '森林场景图', url, createdAt: 1, updatedAt: 2,
    }] } };
}

beforeEach(() => {
  vi.mocked(processRichMessageMedia).mockReset();
  vi.mocked(isLocalOnlyMediaMode).mockReturnValue(true);
  vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
  useChatStore.setState({ chats: [{ id: 'team-image-chat', type: 'assistant', deletedAt: null } as ReturnType<typeof useChatStore.getState>['chats'][number]] });
  useSettingsStore.setState({ aiProfiles: [profile] });
  useMessageStore.setState({ activeChatId: 'team-image-chat', messages: [], messageWindowsByChatId: {} });
});

describe('agent team image task', () => {
  it('keeps a generated image visible on its conversation branch after status updates', async () => {
    const parent: Message = { id: 'team-parent', chatId: 'team-image-chat', type: 'ai', senderId: 'assistant',
      content: '开始制作', timestamp: 1, isDeleted: false,
      metadata: { branching: { nodeId: 'team-parent', parentNodeId: null, sequence: 1 } } };
    const chat = { ...useChatStore.getState().chats[0], messageBranchState: { enabled: true, activeBranchName: 'main',
      activeLeafNodeId: parent.id, refs: { main: { name: 'main', headNodeId: parent.id, createdAt: 1, updatedAt: 1, version: 1 } } } };
    useChatStore.setState({ chats: [chat] });
    useMessageStore.setState({ messages: [parent] });
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      const currentChat = useChatStore.getState().chats[0];
      expect(projectCurrentChatMessages({ chatId: message.chatId, chat: currentChat,
        activeMessages: useMessageStore.getState().messages })).toContainEqual(expect.objectContaining({ id: message.id }));
      upsertMessage({ ...message, serverId: 'server-image', metadata: { ...message.metadata,
        attachments: message.metadata!.attachments!.map((item) => ({ ...item, status: 'ready',
          url: '/uploads/image.png', updatedAt: Date.now() + 1 })) } });
    });
    await queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: chat.id, prompt: '森林场景图',
      sourceBranch: captureTeamSourceBranch(chat), signal: new AbortController().signal });
    expect(projectCurrentChatMessages({ chatId: chat.id, chat: useChatStore.getState().chats[0],
      activeMessages: useMessageStore.getState().messages })).toContainEqual(expect.objectContaining({ id: 'team-image-run-shot' }));
  });
  it('keeps the approved model configuration when the current default changes', async () => {
    useSettingsStore.setState({ aiProfiles: [{ ...profile, model: 'different-model', defaultImageSize: '4K' }] });
    const approvedProfile = { ...profile, defaultImageSize: '2K' as const };
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, aiProfiles, upsertMessage }) => {
      expect(aiProfiles).toEqual([approvedProfile]);
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'ready', url: '/uploads/approved.png', updatedAt: Date.now() + 1,
      })) } });
    });
    await queueAgentTeamImage({ runId: 'run', taskId: 'approved', chatId: 'team-image-chat', prompt: '森林',
      profile: approvedProfile, signal: new AbortController().signal });
    expect(processRichMessageMedia).toHaveBeenCalledTimes(1);
  });

  it('uses one attachment and exposes the ready image as a video reference', async () => {
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({ ...item, status: 'ready', url: 'https://example.test/scene.png', updatedAt: Date.now() + 1 })) } });
    });
    const usageReference = { schemaVersion: 1 as const, runId: 'run', taskId: 'shot', attempt: 1, kind: 'tool' as const };
    const params = { runId: 'run', taskId: 'shot', chatId: 'team-image-chat', prompt: '森林场景图', usageReference, signal: new AbortController().signal };
    expect(await queueAgentTeamImage(params)).toEqual({ output: expect.stringContaining('森林场景图') });
    expect(teamImageReference('run', 'shot')).toMatchObject({ url: 'https://example.test/scene.png' });
    expect(useMessageStore.getState().messages[0].metadata?.workflowUsage).toEqual(usageReference);
    expect(await queueAgentTeamImage(params)).toEqual({ output: expect.stringContaining('森林场景图') });
    expect(processRichMessageMedia).toHaveBeenCalledTimes(1);
  });

  it('persists upstream reference images in the queued attachment', async () => {
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      expect(message.metadata?.attachments?.[0]?.referenceImages).toEqual([
        { url: '/uploads/media/user/chat/scene.png', mimeType: 'image/png', label: '场景图' },
      ]);
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'ready', url: '/uploads/media/user/chat/character.png', updatedAt: Date.now() + 1,
      })) } });
    });
    await queueAgentTeamImage({ runId: 'run', taskId: 'character', chatId: 'team-image-chat', prompt: '在森林中画角色',
      referenceImages: [{ url: '/uploads/media/user/chat/scene.png', mimeType: 'image/png', label: '场景图' }], signal: new AbortController().signal });
    expect(useMessageStore.getState().messages[0].metadata?.attachments?.[0]?.referenceImages?.[0]?.url)
      .toBe('/uploads/media/user/chat/scene.png');
  });

  it('does not resubmit an image whose upstream request started before interruption', async () => {
    useMessageStore.setState({ messages: [imageMessage('generating')] });
    useSettingsStore.setState({ aiProfiles: [] });
    await expect(queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: 'team-image-chat', prompt: '森林场景图', signal: new AbortController().signal }))
      .rejects.toThrow('结果尚未确认');
    expect(processRichMessageMedia).not.toHaveBeenCalled();
  });

  it('reuses a queued attachment without creating another message', async () => {
    useMessageStore.setState({ messages: [imageMessage('queued')] });
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({ ...item, status: 'ready', url: 'https://example.test/scene.png', updatedAt: 3 })) } });
    });
    await queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: 'team-image-chat', prompt: '森林场景图', signal: new AbortController().signal });
    expect(useMessageStore.getState().messages.filter((message) => message.metadata?.agentTeamMedia?.runId === 'run')).toHaveLength(1);
  });

  it('shows a short task title on the media bubble and attachment', async () => {
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'ready', url: '/uploads/titled.png', updatedAt: Date.now() + 1,
      })) } });
    });
    await queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: 'team-image-chat',
      title: '追逐高潮关键帧：机器猫在雨夜巷口避开霸王龙', prompt: '完整画面提示词', signal: new AbortController().signal });
    expect(useMessageStore.getState().messages[0]).toMatchObject({
      content: '图片 · 追逐高潮关键帧：机器猫在雨夜巷口避开霸王龙',
      metadata: { attachments: [expect.objectContaining({ altText: '追逐高潮关键帧：机器猫在雨夜巷口避开霸王龙' })] },
    });
  });

  it('requeues a failed image on the same chat message with revised prompt and a new attempt key', async () => {
    const failed = imageMessage('failed');
    failed.metadata!.attachments![0] = { ...failed.metadata!.attachments![0], error: 'content rejected', generationJobId: 'old-attempt' };
    useMessageStore.setState({ messages: [failed] });
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      expect(message.metadata?.attachments?.[0]).toMatchObject({ status: 'queued', promptText: '森林竹蜻蜓场景', generationJobId: 'team-image-run-shot-2' });
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'ready', url: '/uploads/retry.png', updatedAt: Date.now() + 1,
      })) } });
    });
    const result = await queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: failed.chatId,
      prompt: '森林竹蜻蜓场景', usageReference: { schemaVersion: 1, runId: 'run', taskId: 'shot', attempt: 2, kind: 'tool' },
      signal: new AbortController().signal });
    expect(result.output).toContain('森林竹蜻蜓场景');
    expect(useMessageStore.getState().messages).toHaveLength(1);
    expect(useMessageStore.getState().messages[0].metadata?.attachments?.[0]).toMatchObject({ status: 'ready', url: '/uploads/retry.png' });
  });

  it('actively drains the message outbox while waiting for the image placeholder', async () => {
    vi.mocked(isLocalOnlyMediaMode).mockReturnValue(false);
    const message = imageMessage('queued');
    const originalChatFlush = useChatStore.getState().flushPendingOperations;
    const originalMessageFlush = useMessageStore.getState().flushPendingOperations;
    const chatFlush = vi.fn(async () => undefined);
    const messageFlush = vi.fn(async () => {
      useMessageStore.getState().upsertMessage({ ...message, serverId: 'remote-image-message' });
    });
    useChatStore.setState({ flushPendingOperations: chatFlush });
    useMessageStore.setState({ messages: [message], flushPendingOperations: messageFlush });
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message: synced, upsertMessage }) => {
      expect(synced.serverId).toBe('remote-image-message');
      upsertMessage({ ...synced, metadata: { ...synced.metadata, attachments: synced.metadata!.attachments!.map((item) => ({
        ...item, status: 'ready', url: '/uploads/image.png', updatedAt: 3,
      })) } });
    });
    try {
      await expect(queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: message.chatId,
        prompt: '森林场景图', signal: new AbortController().signal })).resolves.toMatchObject({ output: expect.any(String) });
      expect(chatFlush).toHaveBeenCalled();
      expect(messageFlush).toHaveBeenCalled();
      expect(processRichMessageMedia).toHaveBeenCalledOnce();
    } finally {
      useChatStore.setState({ flushPendingOperations: originalChatFlush });
      useMessageStore.setState({ flushPendingOperations: originalMessageFlush });
    }
  });

  it('reports a terminal parent sync error instead of waiting for the generic timeout', async () => {
    vi.mocked(isLocalOnlyMediaMode).mockReturnValue(false);
    const message = imageMessage('queued');
    const parent: Message = { id: 'branch-parent', chatId: message.chatId, type: 'ai', senderId: 'assistant', senderName: '助手',
      content: '前一条消息', emotion: 0, timestamp: 0, isDeleted: false,
      metadata: { branching: { nodeId: 'parent-node', parentNodeId: null, sequence: 1 } } };
    useMessageStore.setState({ messages: [parent, message], pendingOperations: [
      { id: 'parent-sync', kind: 'create', chatId: parent.chatId, localMessageId: parent.id, messageId: parent.id, payload: parent,
        createdAt: 1, attemptCount: 5, status: 'failed', lastError: '账号无权访问该会话' },
    ] });
    useMessageStore.setState({ messages: [{ ...message, metadata: { ...message.metadata,
      branching: { nodeId: message.id, parentNodeId: 'parent-node', sequence: 2 } } }] });

    await expect(queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: message.chatId, prompt: '森林场景图', signal: new AbortController().signal }))
      .rejects.toThrow('图片占位消息的分支父消息同步失败：账号无权访问该会话');
    expect(processRichMessageMedia).not.toHaveBeenCalled();
  });

  it('includes the pending outbox error when placeholder synchronization times out', async () => {
    vi.useFakeTimers();
    vi.mocked(isLocalOnlyMediaMode).mockReturnValue(false);
    const message = imageMessage('queued');
    const originalChatFlush = useChatStore.getState().flushPendingOperations;
    const originalMessageFlush = useMessageStore.getState().flushPendingOperations;
    useChatStore.setState({ flushPendingOperations: vi.fn(async () => undefined) });
    useMessageStore.setState({ messages: [message], flushPendingOperations: vi.fn(async () => undefined), pendingOperations: [{
      id: 'image-pending', kind: 'create', chatId: message.chatId, localMessageId: message.id, messageId: message.id,
      payload: message, createdAt: 1, attemptCount: 2, status: 'pending', retryAt: Date.now() + 120_000,
      lastError: 'network: 分支父消息尚未完成云端同步',
    }] });
    try {
      const result = queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: message.chatId,
        prompt: '森林场景图', signal: new AbortController().signal });
      const assertion = expect(result).rejects.toThrow('最近错误：network: 分支父消息尚未完成云端同步');
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(processRichMessageMedia).not.toHaveBeenCalled();
    } finally {
      useChatStore.setState({ flushPendingOperations: originalChatFlush });
      useMessageStore.setState({ flushPendingOperations: originalMessageFlush });
      vi.useRealTimers();
    }
  });

  it('blocks missing image files and carries the saved failure reason', () => {
    useMessageStore.setState({ messages: [imageMessage('ready')] });
    expect(inspectAgentTeamImageAttachment('run', 'shot')).toMatchObject({ status: 'failed' });
    useMessageStore.setState({ messages: [{ ...imageMessage('failed'), metadata: { ...imageMessage('failed').metadata,
      attachments: [{ ...imageMessage('failed').metadata!.attachments![0], error: '上游额度不足' }] } }] });
    expect(inspectAgentTeamImageAttachment('run', 'shot')).toEqual({ status: 'failed', error: '上游额度不足' });
  });

  it('preserves a saved backend path for server-side reference resolution', () => {
    useMessageStore.setState({ messages: [imageMessage('ready', '/uploads/media/scene.png')] });
    expect(teamImageReference('run', 'shot')?.url).toBe('/uploads/media/scene.png');
  });
});
