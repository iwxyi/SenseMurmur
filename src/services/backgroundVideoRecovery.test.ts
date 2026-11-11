import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { findPendingVideoMessages, recoverBackgroundVideoTasks } from './backgroundVideoRecovery';
import { useChatStore } from '../stores/useChatStore';
import { __messageRuntimePersistenceForTests, useMessageStore } from '../stores/useMessageStore';
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
  it('keeps an older generating video visible after cached chat eviction', () => {
    const pending = message('old-video', 'generating', 'task-old');
    const messageWindowsByChatId = Object.fromEntries([
      ['chat', { messages: [pending], lastSyncedAt: 1, updatedAt: 1 }],
      ...Array.from({ length: 13 }, (_, index) => [`recent-${index}`, {
        messages: [], lastSyncedAt: index + 2, updatedAt: index + 2,
      }] as const),
    ]);
    const persisted = __messageRuntimePersistenceForTests.buildPersistedMessageState({ messageWindowsByChatId, pendingOperations: [] });
    expect(Object.keys(persisted.messageWindowsByChatId)).toHaveLength(12);
    expect(findPendingVideoMessages(Object.values(persisted.messageWindowsByChatId).flatMap((window) => window.messages), new Set(['chat']), true))
      .toEqual([expect.objectContaining({ id: pending.id, serverId: pending.serverId })]);
  });
  it('retains every recoverable video even when active jobs exceed the chat cache limit', () => {
    const pending = Array.from({ length: 13 }, (_, index) => ({ ...message(`pending-${index}`, 'generating', `task-${index}`), chatId: `chat-${index}` }));
    const messageWindowsByChatId = Object.fromEntries(pending.map((item, index) => [item.chatId, {
      messages: [item], lastSyncedAt: index + 1, updatedAt: index + 1,
    }]));
    const persisted = __messageRuntimePersistenceForTests.buildPersistedMessageState({ messageWindowsByChatId, pendingOperations: [] });
    expect(Object.keys(persisted.messageWindowsByChatId)).toHaveLength(13);
    expect(findPendingVideoMessages(Object.values(persisted.messageWindowsByChatId).flatMap((window) => window.messages),
      new Set(pending.map((item) => item.chatId)), true)).toHaveLength(13);
  });
  it('selects each accepted task once without restarting queued generation', () => {
    const accepted = message('accepted', 'generating', 'task-1');
    const submitting: Message = { ...message('submitting', 'generating'), metadata: { attachments: [{
      ...message('submitting', 'generating').metadata!.attachments![0], generationJobId: 'media-gen-saved',
    }] } };
    expect(findPendingVideoMessages([
      { ...message('accepted', 'queued'), metadata: { attachments: [{ ...message('accepted', 'queued').metadata!.attachments![0], updatedAt: 0 }] } },
      accepted, accepted, submitting, message('queued', 'queued'), message('missing-task', 'generating'),
      { ...message('deleted', 'generating', 'task-2'), isDeleted: true },
      { ...message('other-chat', 'generating', 'task-3'), chatId: 'other' },
    ], new Set(['chat']), true)).toEqual([accepted, submitting]);
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

  it('does not resume a deleted copy with the same attachment version', () => {
    const generating = message('deleted-copy', 'generating', 'task-1');
    expect(findPendingVideoMessages([generating, { ...generating, isDeleted: true }], new Set(['chat']), true)).toEqual([]);
  });

  it('resumes a task from the message window after store rehydration', async () => {
    vi.mocked(processRichMessageMedia).mockClear();
    vi.mocked(readAuthSnapshot).mockReturnValue({ mode: 'cloud' } as ReturnType<typeof readAuthSnapshot>);
    vi.mocked(isCloudSyncEnabled).mockReturnValue(true);
    vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
    vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
    useChatStore.setState({ chats: [{ id: 'chat', deletedAt: null } as ReturnType<typeof useChatStore.getState>['chats'][number]] });
    const pending = message('rehydrated', 'generating', 'task-rehydrated');
    const persisted = __messageRuntimePersistenceForTests.buildPersistedMessageState({
      messageWindowsByChatId: { chat: { messages: [pending], lastSyncedAt: 1, updatedAt: 1 } },
      pendingOperations: [],
    });
    const originalStorage = useMessageStore.persist.getOptions().storage;
    useMessageStore.persist.setOptions({ storage: {
      getItem: async () => ({ state: persisted, version: useMessageStore.persist.getOptions().version }),
      setItem: () => undefined,
      removeItem: () => undefined,
    } as typeof originalStorage });
    try {
      useMessageStore.setState({ messages: [], messageWindowsByChatId: {} });
      await useMessageStore.persist.rehydrate();
      expect(useMessageStore.getState().messageWindowsByChatId.chat?.messages).toContainEqual(expect.objectContaining({
        id: pending.id,
        serverId: pending.serverId,
        metadata: pending.metadata,
      }));
      expect(await recoverBackgroundVideoTasks()).toBe(1);
      expect(processRichMessageMedia).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.objectContaining({ id: pending.id, serverId: pending.serverId }),
        attachmentIds: ['video-rehydrated'],
      }));
    } finally {
      useMessageStore.persist.setOptions({ storage: originalStorage });
    }
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

  it('schedules a persisted submitting request key for server reconciliation', async () => {
    vi.mocked(processRichMessageMedia).mockClear();
    vi.mocked(readAuthSnapshot).mockReturnValue({ mode: 'cloud' } as ReturnType<typeof readAuthSnapshot>);
    vi.mocked(isCloudSyncEnabled).mockReturnValue(true);
    vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
    vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
    vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
    useChatStore.setState({ chats: [{ id: 'chat', deletedAt: null } as ReturnType<typeof useChatStore.getState>['chats'][number]] });
    const submitting = message('request-key', 'generating');
    submitting.metadata!.attachments![0].generationJobId = 'media-gen-original';
    useMessageStore.setState({ messages: [submitting], messageWindowsByChatId: {} });
    await recoverBackgroundVideoTasks();
    await vi.waitFor(() => expect(processRichMessageMedia).toHaveBeenCalledWith(expect.objectContaining({
      message: submitting, attachmentIds: ['video-request-key'],
    })));
  });
});
