import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { findPendingVideoMessages, recoverBackgroundVideoTasks } from './backgroundVideoRecovery';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { processRichMessageMedia } from './richMessageMedia';
import { readAuthSnapshot } from './authSnapshot';
import { isCloudSyncEnabled } from './cloudSyncPreference';

vi.mock('./richMessageMedia', () => ({ processRichMessageMedia: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./authSnapshot', async (importOriginal) => ({
  ...await importOriginal<typeof import('./authSnapshot')>(),
  readAuthSnapshot: vi.fn(() => ({ mode: 'cloud' })),
}));
vi.mock('./cloudSyncPreference', async (importOriginal) => ({
  ...await importOriginal<typeof import('./cloudSyncPreference')>(),
  isCloudSyncEnabled: vi.fn(() => true),
}));

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

  it('prefers the synced copy when attachment versions match', () => {
    const synced = message('same-version', 'generating', 'task-1');
    const local = { ...synced, serverId: undefined };
    expect(findPendingVideoMessages([local, synced], new Set(['chat']), true)).toEqual([synced]);
  });

  it('resumes after cloud sync supplies the server message ID and schedules the task once', async () => {
    vi.mocked(processRichMessageMedia).mockClear();
    vi.mocked(readAuthSnapshot).mockReturnValue({ mode: 'cloud' } as ReturnType<typeof readAuthSnapshot>);
    vi.mocked(isCloudSyncEnabled).mockReturnValue(true);
    vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
    vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
    vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
    useChatStore.setState({ chats: [{ id: 'chat', deletedAt: null } as ReturnType<typeof useChatStore.getState>['chats'][number]] });
    const pending = { ...message('late-sync', 'generating', 'task-1'), serverId: undefined };
    useMessageStore.setState({ messages: [pending], messageWindowsByChatId: {} });
    expect(await recoverBackgroundVideoTasks()).toBe(0);
    expect(processRichMessageMedia).not.toHaveBeenCalled();
    useMessageStore.setState({ messages: [{ ...pending, serverId: 'server-late-sync' }] });
    await vi.waitFor(() => expect(processRichMessageMedia).toHaveBeenCalledTimes(1));
    useMessageStore.setState({ messages: [{ ...pending, serverId: 'server-late-sync' }] });
    await Promise.resolve();
    expect(processRichMessageMedia).toHaveBeenCalledTimes(1);
  });
});
