import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { useMessageStore } from '../stores/useMessageStore';
import { messageCloudConfirmationFailure, waitForMessageCloudConfirmation } from './messageCloudConfirmation';

const child: Message = {
  id: 'child', chatId: 'chat', type: 'ai', senderId: 'assistant', senderName: '助手', content: '', emotion: 0,
  timestamp: 1, isDeleted: false, metadata: { branching: { nodeId: 'child-node', parentNodeId: 'parent-node', rootNodeId: 'root', sequence: 2 } },
};

beforeEach(() => {
  useMessageStore.setState({ messages: [child], messageWindowsByChatId: {}, pendingOperations: [] });
});

describe('message cloud confirmation', () => {
  it('returns the failed branch parent cause instead of timing out', async () => {
    useMessageStore.setState({ pendingOperations: [{ id: 'parent-create', kind: 'create', chatId: 'chat', localMessageId: 'parent',
      payload: { id: 'parent', clientKey: 'parent', metadata: { branching: { nodeId: 'parent-node' } } }, status: 'failed',
      attemptCount: 1, lastError: 'ownership_conflict: 当前会话由另一设备运行，消息未提交' } as never] });
    expect(messageCloudConfirmationFailure(child)).toContain('ownership_conflict');
    await expect(waitForMessageCloudConfirmation({ chatId: 'chat', messageId: 'child', timeoutMs: 1000 }))
      .rejects.toThrow('ownership_conflict: 当前会话由另一设备运行，消息未提交');
  });

  it('resolves only after the server confirmation appears', async () => {
    const waiting = waitForMessageCloudConfirmation({ chatId: 'chat', messageId: 'child', timeoutMs: 1000 });
    useMessageStore.setState({ messages: [{ ...child, serverId: 'server-child' }] });
    await expect(waiting).resolves.toMatchObject({ serverId: 'server-child' });
  });
});
