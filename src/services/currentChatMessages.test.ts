import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { pendingAgentTeamMediaMessages, projectCurrentChatMessages, projectMergedChatMessages } from './currentChatMessages';

function message(patch: Partial<Message>): Message {
  return {
    id: patch.id || 'm1',
    chatId: patch.chatId || 'chat-1',
    type: patch.type || 'ai',
    senderId: patch.senderId || 'a',
    senderName: patch.senderName || '甲',
    content: patch.content || '内容',
    emotion: 0,
    timestamp: patch.timestamp ?? 1,
    isDeleted: false,
    ...patch,
  };
}

describe('projectCurrentChatMessages', () => {
  it('retains pending team image bubbles from the local store or cached message window', () => {
    const queued = message({ id: 'team-image', metadata: { agentTeamMedia: { runId: 'run', taskId: 'frame' },
      attachments: [{ id: 'image', kind: 'image', status: 'queued', altText: '关键帧', promptText: '丛林', createdAt: 2, updatedAt: 2 }] } });
    const generating = { ...queued, metadata: { ...queued.metadata, attachments: [{ ...queued.metadata!.attachments![0]!, status: 'generating' as const, updatedAt: 3 }] } };
    const failed = { ...generating, metadata: { ...generating.metadata, attachments: [{ ...generating.metadata.attachments![0]!, status: 'failed' as const, updatedAt: 4 }] } };
    const ready = { ...generating, metadata: { ...generating.metadata, attachments: [{ ...generating.metadata.attachments![0]!, status: 'ready' as const, updatedAt: 5 }] } };
    const hidden = { ...queued, id: 'deleted-image', isDeleted: true };

    expect(pendingAgentTeamMediaMessages('chat-1', [queued, generating, failed, ready, hidden])).toEqual([ready]);
    expect(pendingAgentTeamMediaMessages('chat-1', [ready])).toEqual([ready]);
    expect(pendingAgentTeamMediaMessages('other-chat', [queued])).toEqual([]);
  });
  it('does not deduplicate distinct branch nodes with equal content and timestamps', () => {
    const original = message({ id: 'original', timestamp: 2, metadata: { branching: { nodeId: 'original', parentNodeId: 'root' } } });
    const revision = message({ id: 'revision', timestamp: 2, metadata: { branching: { nodeId: 'revision', parentNodeId: 'root', revisionOfNodeId: 'original' } } });
    const root = message({ id: 'root', timestamp: 1 });
    expect(projectMergedChatMessages({ chatId: 'chat-1', activeMessages: [root, revision], cachedWindow: { messages: [root, original] } }).map((item) => item.id)).toEqual(['root', 'original', 'revision']);
  });

  it('retains severed history inside the dynamic viewport without expanding it to all cached messages', () => {
    const chat = { messageBranchState: { enabled: true, activeLeafNodeId: 'severed-4' } } as never;
    const cached = Array.from({ length: 5 }, (_, index) => message({ id: `severed-${index}`, timestamp: index,
      metadata: { branching: { nodeId: `severed-${index}`, parentNodeId: null } } }));
    expect(projectCurrentChatMessages({ chatId: 'chat-1', chat, activeMessages: cached.slice(-3), cachedWindow: { messages: cached } }).map((item) => item.id)).toEqual(['severed-2', 'severed-3', 'severed-4']);
  });
  it('keeps a new team media placeholder visible when the active message window has not advanced yet', () => {
    const parent = message({ id: 'team-parent', timestamp: 1,
      metadata: { branching: { nodeId: 'team-parent', parentNodeId: null, sequence: 1 } } });
    const image = message({ id: 'team-image', timestamp: 2,
      metadata: { agentTeamMedia: { runId: 'run', taskId: 'image' },
        branching: { nodeId: 'team-image', parentNodeId: 'team-parent', sequence: 2 },
        attachments: [{ id: 'image', kind: 'image', status: 'queued', altText: '参考图', promptText: '森林', createdAt: 2, updatedAt: 2 }] } });
    const chat = { messageBranchState: { enabled: true, activeBranchName: 'edited', activeLeafNodeId: image.id,
      refs: { edited: { name: 'edited', headNodeId: image.id, createdAt: 1, updatedAt: 2, version: 2 } } } } as never;

    const projected = projectCurrentChatMessages({ chatId: 'chat-1', chat, activeMessages: [parent],
      cachedWindow: { messages: [parent, image] } });

    expect(projected.map((item) => item.id)).toEqual(['team-parent', 'team-image']);
  });
  it('keeps a completed team media bubble visible after later delivery messages advance the viewport', () => {
    const root = message({ id: 'root', timestamp: 1,
      metadata: { branching: { nodeId: 'root', parentNodeId: null, sequence: 1 } } });
    const media = message({ id: 'team-image', timestamp: 2,
      metadata: { agentTeamMedia: { runId: 'run', taskId: 'image' },
        branching: { nodeId: 'team-image', parentNodeId: 'root', sequence: 2 },
        attachments: [{ id: 'image', kind: 'image', status: 'ready', altText: '成片关键帧', createdAt: 2, updatedAt: 3 }] } });
    const review = message({ id: 'review', timestamp: 20, content: '验收完成',
      metadata: { branching: { nodeId: 'review', parentNodeId: 'team-image', sequence: 3 } } });
    const delivery = message({ id: 'delivery', timestamp: 30, content: '团队交付完成',
      metadata: { branching: { nodeId: 'delivery', parentNodeId: 'review', sequence: 4 } } });
    const chat = { messageBranchState: { enabled: true, activeBranchName: 'new', activeLeafNodeId: 'delivery',
      refs: { new: { name: 'new', headNodeId: 'delivery', createdAt: 1, updatedAt: 30, version: 4 } } } } as never;

    const projected = projectCurrentChatMessages({ chatId: 'chat-1', chat, activeMessages: [review, delivery],
      cachedWindow: { messages: [root, media, review, delivery] } });

    expect(projected.map((item) => item.id)).toEqual(['team-image', 'review', 'delivery']);
  });
  it('preserves branch ancestry for non-render callers even without an explicit cache flag', () => {
    const chat = {
      sessionKind: { scenarioId: 'open-chat' },
      messageBranchState: { enabled: true, activeLeafNodeId: 'tail' },
    } as never;
    const cached = Array.from({ length: 50 }, (_, index) => message({
      id: `node-${index}`,
      timestamp: index,
      metadata: { branching: { nodeId: `node-${index}`, parentNodeId: index ? `node-${index - 1}` : null, sequence: index } },
    }));
    cached[49] = message({ id: 'tail', timestamp: 49, metadata: { branching: { nodeId: 'tail', parentNodeId: 'node-48', sequence: 49 } } });
    const projected = projectCurrentChatMessages({ chatId: 'chat-1', chat, activeMessages: [cached.at(-1)!], cachedWindow: { messages: cached, activeLimit: 40 } });
    expect(projected.at(-1)?.id).toBe('tail');
    expect(projected.length).toBe(1);
  });
  it('renders current chat messages from the cached window even when active messages are empty', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [],
      cachedWindow: {
        messages: [
          message({ id: 'user-1', type: 'user', senderId: 'user', senderName: 'User', content: '我刚发的消息' }),
        ],
      },
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toBe('我刚发的消息');
  });

  it('uses the active window as the visible source when active messages exist', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [
        message({ id: 'active-user-1', type: 'user', senderId: 'user', senderName: 'User', content: '先说一句', timestamp: 1 }),
        message({ id: 'stream-1', content: '正在说', timestamp: 2, isStreaming: true }),
      ],
      cachedWindow: {
        messages: [
          message({ id: 'cached-tail-1', content: '缓存尾部不应混入历史窗口', timestamp: 1000 }),
        ],
      },
    });

    expect(projected.map((item) => item.id)).toEqual(['active-user-1', 'stream-1']);
  });

  it('keeps the cached window when active messages are only a sparse tail refresh', () => {
    const cached = Array.from({ length: 12 }, (_, index) => message({
      id: `cached-${index + 1}`,
      content: `缓存消息 ${index + 1}`,
      timestamp: index + 1,
    }));
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [
        message({ id: 'cached-10', content: '缓存消息 10 已刷新', timestamp: 10 }),
        message({ id: 'cached-11', content: '缓存消息 11 已刷新', timestamp: 11 }),
        message({ id: 'cached-12', content: '缓存消息 12 已刷新', timestamp: 12 }),
      ],
      cachedWindow: {
        messages: cached,
        activeLimit: 12,
      },
    });

    expect(projected).toHaveLength(12);
    expect(projected.at(-1)?.content).toBe('缓存消息 12 已刷新');
  });

  it('keeps committed streamed content when a delayed streaming frame arrives', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [
        message({
          id: 'local-stream-1',
          clientKey: 'local-stream-1',
          serverId: 'server-message-1',
          content: '完整正式内容，已经提交。',
          timestamp: 10,
          isStreaming: false,
        }),
        message({
          id: 'local-stream-1',
          clientKey: 'local-stream-1',
          content: '完整',
          timestamp: 10,
          isStreaming: true,
        }),
      ],
      cachedWindow: null,
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toBe('完整正式内容，已经提交。');
    expect(projected[0]?.isStreaming).toBe(false);
  });

  it('merges a local streamed message with its later server id', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [
        message({
          id: 'server-message-1',
          serverId: 'server-message-1',
          content: '逐字显示完整内容',
          timestamp: 12,
          isStreaming: false,
        }),
      ],
      cachedWindow: {
        messages: [
          message({
            id: 'local-stream-1',
            clientKey: 'local-stream-1',
            serverId: 'server-message-1',
            content: '逐字显示完整内容',
            timestamp: 10,
            isStreaming: false,
          }),
        ],
      },
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.id).toBe('local-stream-1');
    expect(projected[0]?.serverId).toBe('server-message-1');
  });

  it('keeps a new streaming turn separate from the previous same-speaker message with matching content', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [
        message({
          id: 'stream-2',
          clientKey: 'stream-2',
          content: '上一条刚说过的话',
          timestamp: 2000,
          isStreaming: true,
        }),
      ],
      cachedWindow: {
        messages: [
          message({
            id: 'previous-1',
            content: '上一条刚说过的话',
            timestamp: 1000,
            isStreaming: false,
          }),
        ],
      },
    });

    expect(projected.map((item) => item.id)).toEqual(['stream-2']);
    expect(projected.map((item) => item.isStreaming)).toEqual([true]);
  });

  it('keeps repeated committed same-speaker content as separate projected messages', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [
        message({
          id: 'repeat-2',
          content: '好',
          timestamp: 1200,
          isStreaming: false,
        }),
      ],
      cachedWindow: {
        messages: [
          message({
            id: 'repeat-1',
            content: '好',
            timestamp: 1000,
            isStreaming: false,
          }),
        ],
      },
    });

    expect(projected.map((item) => item.id)).toEqual(['repeat-2']);
  });

  it('removes hydrated cache duplicates even when active messages use different ids', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [
        message({ id: 'active-user-1', type: 'user', senderId: 'user', senderName: 'User', content: '先说一句', timestamp: 1000 }),
        message({ id: 'active-ai-1', content: '上一条历史消息', timestamp: 2000 }),
      ],
      cachedWindow: {
        messages: [
          message({ id: 'cached-user-1', type: 'user', senderId: 'user', senderName: 'User', content: '先说一句', timestamp: 900 }),
          message({ id: 'cached-ai-1', content: '上一条历史消息', timestamp: 1900 }),
        ],
      },
    });

    expect(projected.map((item) => item.id)).toEqual(['active-user-1', 'active-ai-1']);
  });

  it('does not append cached tail messages to a historical active window', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [
        message({ id: 'history-481', content: '历史窗口开头', timestamp: 481 }),
        message({ id: 'history-520', content: '历史窗口结尾', timestamp: 520 }),
      ],
      cachedWindow: {
        messages: [
          message({ id: 'tail-999', content: '缓存尾部一', timestamp: 999 }),
          message({ id: 'tail-1000', content: '缓存尾部二', timestamp: 1000 }),
        ],
      },
    });

    expect(projected.map((item) => item.id)).toEqual(['history-481', 'history-520']);
  });

  it('keeps branch metadata when a streaming placeholder is replaced by the committed branch message', () => {
    const chat = {
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' },
      messageBranchState: {
        selectedRevisionByRootId: { 'm-b': 'm-b2' },
        activeChildByParentNodeId: { 'm-a': 'm-b2', 'm-b2': 'local-stream-1' },
        activeLeafNodeId: 'local-stream-1',
      },
    } as const;
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      chat,
      activeMessages: [
        message({ id: 'm-a', type: 'user', senderId: 'user', senderName: 'User', content: 'A', timestamp: 1 }),
        message({ id: 'm-b', content: 'B', timestamp: 2 }),
        message({
          id: 'm-b2',
          content: 'B2',
          timestamp: 3,
          metadata: { branching: { parentNodeId: 'm-a', revisionRootId: 'm-b', revisionOfMessageId: 'm-b' } },
        }),
        message({
          id: 'local-stream-1',
          clientKey: 'local-stream-1',
          content: '最终提交内容',
          timestamp: 4,
          isStreaming: false,
          metadata: { branching: { parentNodeId: 'm-b2' } },
        }),
        message({
          id: 'local-stream-1',
          clientKey: 'local-stream-1',
          content: '最终',
          timestamp: 4,
          isStreaming: true,
        }),
      ],
      cachedWindow: null,
    });

    expect(projected.map((item) => item.id)).toEqual(['m-a', 'm-b2', 'local-stream-1']);
    expect(projected.at(-1)?.content).toBe('最终提交内容');
    expect(projected.at(-1)?.metadata?.branching?.parentNodeId).toBe('m-b2');
  });

  it('ignores messages from other chats', () => {
    const projected = projectCurrentChatMessages({
      chatId: 'chat-1',
      activeMessages: [message({ id: 'other', chatId: 'chat-2' })],
      cachedWindow: { messages: [message({ id: 'current', chatId: 'chat-1' })] },
    });

    expect(projected.map((item) => item.id)).toEqual(['current']);
  });
});
