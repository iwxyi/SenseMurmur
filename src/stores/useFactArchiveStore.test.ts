import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFactArchiveStore } from './useFactArchiveStore';
import type { FactEvidence } from '../services/factualMemoryTypes';

function evidence(overrides: Partial<FactEvidence> = {}): FactEvidence {
  return {
    id: 'message-1', nodeId: 'node-1', content: '暗号是青梅煮酒', senderId: 'character-1', senderName: '角色一',
    timestamp: 100, audience: ['user', 'character-1'], ...overrides,
  };
}

describe('useFactArchiveStore', () => {
  beforeEach(() => {
    useFactArchiveStore.setState({ chats: {} });
  });

  it('keeps conversation node content compact and retains only cited source snapshots', () => {
    const cited = evidence();
    const context = evidence({ id: 'message-2', nodeId: 'node-2', content: '无关上下文' });
    useFactArchiveStore.getState().capture('chat-1', [cited, context]);
    useFactArchiveStore.getState().save('chat-1', {
      messageId: 'message-1', facts: [{ text: '暗号是青梅煮酒', status: 'agreed', sourceIds: ['message-1'] }],
      sources: [cited, context],
    });

    const archive = useFactArchiveStore.getState().chats['chat-1'];
    expect(archive.nodes['node-1'].content).toBe(cited.content);
    expect(archive.nodes['node-2'].content).toBe('');
    expect(archive.entries['message-1'].sources).toEqual([cited]);
  });

  it('preserves captured audience and invalidates facts when cited source text changes', () => {
    const original = evidence();
    useFactArchiveStore.getState().capture('chat-1', [original]);
    useFactArchiveStore.getState().save('chat-1', {
      messageId: 'message-1', facts: [{ text: '暗号是青梅煮酒', status: 'agreed', sourceIds: ['message-1'] }], sources: [original],
    });

    useFactArchiveStore.getState().capture('chat-1', [evidence({ content: '暗号改成桃园结义', audience: ['user', 'character-2'] })]);
    const node = useFactArchiveStore.getState().chats['chat-1'].nodes['node-1'];
    expect(node.audience).toEqual(original.audience);
    expect(node.invalid).toBe(true);
    expect(node.content).toBe(original.content);
  });
});
