import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { commitGeneratedMessageTurn } from './generatedMessageTurnCommit';
import { useSettingsStore } from '../stores/useSettingsStore';

const runSessionCommitPipelineMock = vi.fn();

vi.mock('./sessionCommitPipeline', () => ({
  runSessionCommitPipeline: (...args: unknown[]) => runSessionCommitPipelineMock(...args),
}));

beforeEach(() => {
  runSessionCommitPipelineMock.mockReset();
  useSettingsStore.setState({ enableStreamingDisplayAnimation: false });
});

function buildPersistedMessage(content: string, index: number): Message {
  return {
    id: `local-${index}`,
    clientKey: `local-${index}`,
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'char-1',
    senderName: '甲',
    content,
    emotion: 0,
    timestamp: 100 + index,
    isDeleted: false,
  };
}

function baseParams() {
  return {
    api: { provider: 'openai', apiKey: 'x', baseUrl: 'http://localhost', model: 'test' },
    chatId: 'chat-1',
    chat: { id: 'chat-1' },
    characters: [],
    streamingMessage: null,
    currentMessages: [],
    onCommit: vi.fn(),
    upsertMessage: vi.fn(),
    updateCharacter: vi.fn(),
    updateCharacters: vi.fn(),
    appendEventMessage: vi.fn(),
    appendEventMessages: vi.fn(),
    updateChat: vi.fn(),
    applyChatRuntimeDelta: vi.fn(),
    recordSpeak: vi.fn(),
  };
}

describe('commitGeneratedMessageTurn', () => {
  it('preserves earlier committed bubbles and stops later sends after a segment fails', async () => {
    const committed: Message[] = [];
    const failure = new Error('second segment persistence failed');
    runSessionCommitPipelineMock.mockImplementation(async (args: { message: Message }) => {
      if (committed.length === 1) throw failure;
      const persistedMessage = buildPersistedMessage(args.message.content, 1);
      committed.push(persistedMessage);
      return { persistedMessage, transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] },
        nextChat: { id: 'chat-1', messageBranchState: { enabled: true, activeLeafNodeId: persistedMessage.id } },
        nextCharacters: [] };
    });
    const params = baseParams();
    await expect(commitGeneratedMessageTurn({ ...params,
      message: { chatId: 'chat-1', type: 'ai', senderId: 'char-1', senderName: '甲',
        content: '先听你说。', extraMessages: ['这句未能保存。', '这句不应发送。'], emotion: 0 },
    } as never)).rejects.toBe(failure);
    expect(committed.map((message) => message.content)).toEqual(['先听你说。']);
    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(2);
    expect(runSessionCommitPipelineMock.mock.calls[1][0]).toMatchObject({
      chat: { messageBranchState: { activeLeafNodeId: 'local-1' } }, currentMessages: committed,
    });
    expect(params.upsertMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'local-1', isDeleted: true }));
    expect(params.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ isStreaming: true, isDeleted: true }));
  });

  it('keeps a locally saved bubble when subsequent runtime work fails', async () => {
    const params = baseParams();
    const streamingMessage = buildPersistedMessage('输入中', 1);
    runSessionCommitPipelineMock.mockImplementation(async (args: { upsertMessage: (message: Message) => void }) => {
      args.upsertMessage({ ...streamingMessage, content: '已保存', isStreaming: false });
      throw new Error('runtime failed');
    });
    await expect(commitGeneratedMessageTurn({ ...params, streamingMessage,
      message: { ...streamingMessage, content: '已保存' },
    } as never)).rejects.toThrow('runtime failed');
    expect(params.upsertMessage).not.toHaveBeenCalledWith(expect.objectContaining({ isDeleted: true }));
  });

  it('commits each explicit message part through the normal session pipeline', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args: { message: Message }) => ({
      persistedMessage: buildPersistedMessage(args.message.content, runSessionCommitPipelineMock.mock.calls.length),
      transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] },
      nextChat: { id: 'chat-1' },
      nextCharacters: [],
    }));

    await commitGeneratedMessageTurn({
      ...baseParams(),
      message: {
        chatId: 'chat-1',
        type: 'ai',
        senderId: 'char-1',
        senderName: '甲',
        content: '等下',
        extraMessages: ['你刚说谁来着？'],
        emotion: 0,
      },
    } as never);

    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(2);
    expect(runSessionCommitPipelineMock.mock.calls.map((call) => call[0].message.content)).toEqual(['等下', '你刚说谁来着？']);
    expect(runSessionCommitPipelineMock.mock.calls[1]?.[0]).toMatchObject({
      streamingMessage: expect.objectContaining({ content: '', senderId: 'char-1' }),
      localRevealStartDelayMs: undefined,
    });
  });

  it('uses the branch head returned by one segment when committing the next segment', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args: { message: Message; chat: { messageBranchState?: { activeLeafNodeId?: string } } }) => {
      const index = runSessionCommitPipelineMock.mock.calls.length;
      const persistedMessage = buildPersistedMessage(args.message.content, index);
      return {
        persistedMessage,
        transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] },
        nextChat: {
          id: 'chat-1',
          messageBranchState: { enabled: true, activeLeafNodeId: persistedMessage.id },
        },
        nextCharacters: [],
      };
    });

    await commitGeneratedMessageTurn({
      ...baseParams(),
      chat: { id: 'chat-1', messageBranchState: { enabled: true, activeLeafNodeId: 'before-turn' } },
      message: {
        chatId: 'chat-1',
        type: 'ai',
        senderId: 'char-1',
        senderName: '甲',
        content: '第一条',
        extraMessages: ['第二条', '第三条'],
        emotion: 0,
      },
    } as never);

    expect(runSessionCommitPipelineMock.mock.calls[1]?.[0].chat.messageBranchState.activeLeafNodeId).toBe('local-1');
    expect(runSessionCommitPipelineMock.mock.calls[2]?.[0].chat.messageBranchState.activeLeafNodeId).toBe('local-2');
  });

  it('passes each segment metadata independently to the normal commit pipeline', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args: { message: Message }) => ({
      persistedMessage: buildPersistedMessage(args.message.content, runSessionCommitPipelineMock.mock.calls.length),
      transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] },
      nextChat: { id: 'chat-1' },
      nextCharacters: [],
    }));

    await commitGeneratedMessageTurn({
      ...baseParams(),
      message: {
        chatId: 'chat-1',
        type: 'ai',
        senderId: 'char-1',
        senderName: '甲',
        content: '第一条',
        metadata: { generatedAt: 777000 },
        messageParts: [
          { content: '第一条', metadata: { generatedAt: 777000 } },
          {
            content: '第二条图片',
            metadata: {
              attachments: [{ id: 'image-1', kind: 'image', status: 'queued', altText: '小花', promptText: '一朵小花', createdAt: 1, updatedAt: 1 }],
            },
          },
          {
            content: '第三条语音',
            metadata: {
              attachments: [{ id: 'audio-1', kind: 'audio', status: 'queued', altText: '语音：你好', promptText: '你好', createdAt: 1, updatedAt: 1 }],
            },
          },
        ],
        emotion: 0,
      },
    } as never);

    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(3);
    expect(runSessionCommitPipelineMock.mock.calls[1]?.[0]?.message).toMatchObject({
      content: '第二条图片',
      metadata: { attachments: [{ id: 'image-1', kind: 'image', status: 'queued' }] },
    });
    expect(runSessionCommitPipelineMock.mock.calls[2]?.[0]?.message).toMatchObject({
      content: '第三条语音',
      metadata: { attachments: [{ id: 'audio-1', kind: 'audio', status: 'queued' }] },
    });
  });

  it('keeps the existing single-message commit path when no explicit parts are provided', async () => {
    runSessionCommitPipelineMock.mockResolvedValue({
      persistedMessage: buildPersistedMessage('完整回复', 0),
      transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] },
      nextChat: { id: 'chat-1' },
      nextCharacters: [],
    });

    await commitGeneratedMessageTurn({
      ...baseParams(),
      message: {
        chatId: 'chat-1',
        type: 'ai',
        senderId: 'char-1',
        senderName: '甲',
        content: '完整回复',
        emotion: 0,
      },
    } as never);

    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(1);
  });

  it('creates independent streaming identities without entry-point callbacks', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args: { message: Message; streamingMessage?: Message | null }) => ({
      persistedMessage: buildPersistedMessage(args.message.content, runSessionCommitPipelineMock.mock.calls.length),
      transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] },
      nextChat: { id: 'chat-1' },
      nextCharacters: [],
    }));
    await commitGeneratedMessageTurn({
      ...baseParams(),
      message: {
        chatId: 'chat-1', type: 'ai', senderId: 'char-1', senderName: '甲', content: '第一条',
        messageParts: [{ content: '第一条' }, { content: '第二条' }], emotion: 0,
      },
    } as never);
    const first = runSessionCommitPipelineMock.mock.calls[0]?.[0]?.streamingMessage as Message;
    const followup = runSessionCommitPipelineMock.mock.calls[1]?.[0]?.streamingMessage as Message;
    expect(followup.content).toBe('');
    expect(followup.id).not.toBe(first.id);
    expect(followup.clientKey).not.toBe(first.clientKey);
  });
});
