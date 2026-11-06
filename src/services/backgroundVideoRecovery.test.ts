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
      accepted, accepted, message('queued', 'queued'), message('missing-task', 'generating'),
      { ...message('deleted', 'generating', 'task-2'), isDeleted: true },
      { ...message('other-chat', 'generating', 'task-3'), chatId: 'other' },
    ], new Set(['chat']), true)).toEqual([accepted]);
  });
});
