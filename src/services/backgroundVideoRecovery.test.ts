import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { findPendingVideoMessages } from './backgroundVideoRecovery';

function message(id: string, status: 'generating' | 'queued', taskId?: string): Message {
  return { id, chatId: 'chat', type: 'ai', senderId: 'assistant', senderName: '助手', content: '', emotion: 0, timestamp: 1,
    serverId: `server-${id}`, metadata: { attachments: [{ id: `video-${id}`, kind: 'video', status,
      altText: '视频', mediaTaskId: taskId, createdAt: 1, updatedAt: 1 }] } };
}

describe('background video recovery', () => {
  it('selects each accepted task once without restarting queued generation', () => {
    const accepted = message('accepted', 'generating', 'task-1');
    expect(findPendingVideoMessages([
      { ...message('accepted', 'queued'), metadata: { attachments: [{ ...message('accepted', 'queued').metadata!.attachments![0], updatedAt: 0 }] } },
      accepted, accepted, message('queued', 'queued'), message('missing-task', 'generating'),
      { ...message('deleted', 'generating', 'task-2'), isDeleted: true },
      { ...message('other-chat', 'generating', 'task-3'), chatId: 'other' },
    ], new Set(['chat']), true)).toEqual([accepted]);
  });

  it('does not revive a task after a newer message copy marks it complete', () => {
    const generating = message('same', 'generating', 'task-1');
    const ready: Message = { ...generating, metadata: { attachments: [{
      ...generating.metadata!.attachments![0], status: 'ready', mediaTaskId: undefined, updatedAt: 2,
    }] } };
    expect(findPendingVideoMessages([generating, ready], new Set(['chat']), true)).toEqual([]);
  });
});
