import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { createTestChat } from '../test/fixtures';
import { storageKey } from '../constants/brand';

const getMessagesMock = vi.hoisted(() => vi.fn());
const getChatMock = vi.hoisted(() => vi.fn());
const getSyncChangesMock = vi.hoisted(() => vi.fn());
const reportRecoverableErrorMock = vi.hoisted(() => vi.fn());
const MockApiError = vi.hoisted(() => class ApiError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, options?: { code?: string; status?: number }) {
    super(message);
    this.name = 'ApiError';
    this.code = options?.code;
    this.status = options?.status;
  }
});

vi.mock('../services/api', () => ({
  ApiError: MockApiError,
  api: {
    getSyncChanges: getSyncChangesMock,
    getChat: getChatMock,
    getMessages: getMessagesMock,
    createMessage: vi.fn(),
    deleteMessage: vi.fn(),
  },
}));

vi.mock('../services/diagnostics', () => ({
  reportRecoverableError: reportRecoverableErrorMock,
}));

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  key: (index: number) => string | null;
  readonly length: number;
}

function createStorageMock(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  };
}

function buildMessage(index: number, chatId = 'chat-1'): Message {
  return {
    id: `message-${index}`,
    chatId,
    type: 'ai',
    senderId: 'character-1',
    senderName: '角色',
    content: `消息 ${index}`,
    emotion: 0,
    timestamp: index,
    isDeleted: false,
  };
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe('useMessageStore', () => {
  beforeEach(() => {
    vi.resetModules();
    getMessagesMock.mockReset();
    getChatMock.mockReset();
    getChatMock.mockRejectedValue(new MockApiError('聊天不存在', { code: 'NOT_FOUND', status: 404 }));
    getSyncChangesMock.mockReset();
    reportRecoverableErrorMock.mockReset();
    vi.stubGlobal('localStorage', createStorageMock());
    localStorage.setItem(storageKey('auth-mode'), 'local');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('caps active chat messages during repeated upserts', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = `auth-ready-chat-${Date.now()}-${Math.random()}`;
    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {},
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: false,
      hasMoreNewer: false,
    });
    const existingMessages = Array.from({ length: 1000 }, (_, index) => buildMessage(index, chatId));
    const cachedMessages = existingMessages;

    useMessageStore.setState({
      messages: existingMessages,
      messageWindowsByChatId: {
        [chatId]: {
          messages: cachedMessages,
          lastSyncedAt: 0,
          updatedAt: cachedMessages.at(-1)?.timestamp ?? 0,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    useMessageStore.getState().upsertMessage(buildMessage(1000, chatId));

    const state = useMessageStore.getState();
    expect(state.messages).toHaveLength(240);
    expect(state.messages[0]?.id).toBe('message-761');
    expect(state.messages.at(-1)?.id).toBe('message-1000');
    expect(state.messageWindowsByChatId[chatId]?.messages).toHaveLength(1000);
    expect(state.messageWindowsByChatId[chatId]?.messages[0]?.id).toBe('message-1');
    expect(state.messageWindowsByChatId[chatId]?.messages.at(-1)?.id).toBe('message-1000');
  }, 20_000);

  it('keeps message windows with pending operations during cache eviction', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const pendingChatId = 'chat-pending';
    const ordinaryChatId = 'chat-ordinary-old';
    const windows = Object.fromEntries([
      [pendingChatId, {
        messages: [buildMessage(1, pendingChatId)],
        lastSyncedAt: 0,
        updatedAt: 1,
      }],
      [ordinaryChatId, {
        messages: [buildMessage(2, ordinaryChatId)],
        lastSyncedAt: 0,
        updatedAt: 2,
      }],
      ...Array.from({ length: 10 }, (_, index) => {
        const chatId = `chat-recent-${index}`;
        return [chatId, {
          messages: [buildMessage(index + 10, chatId)],
          lastSyncedAt: 0,
          updatedAt: 100 + index,
        }];
      }),
    ]);

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: windows,
      pendingOperations: [{
        id: 'pending-message-create',
        kind: 'create',
        chatId: pendingChatId,
        localMessageId: 'message-1',
        messageId: 'message-1',
        payload: buildMessage(1, pendingChatId),
        createdAt: Date.now(),
        attemptCount: 0,
        status: 'pending',
      }],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    useMessageStore.getState().upsertMessage(buildMessage(999, 'chat-new'));

    const cache = useMessageStore.getState().messageWindowsByChatId;
    expect(Object.keys(cache)).toHaveLength(12);
    expect(cache[pendingChatId]).toBeDefined();
    expect(cache[ordinaryChatId]).toBeUndefined();
    expect(cache['chat-new']).toBeDefined();
  });

  it('keeps cloud-backed windows scrollable when local cache is only a partial window', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'auth-ready-chat';
    const cachedMessages = Array.from({ length: 100 }, (_, index) => buildMessage(index + 901, chatId));

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: cachedMessages,
          lastSyncedAt: Date.now(),
          updatedAt: cachedMessages.at(-1)?.timestamp ?? 0,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: false,
    });

    await useMessageStore.getState().hydrateMessagesFromCache(chatId);

    expect(useMessageStore.getState().messages[0]?.id).toBe('message-961');
    expect(useMessageStore.getState().hasMore).toBe(true);
  });

  it('fetches cloud messages when a window first opened in local mode is reopened after cloud auth becomes ready', async () => {
    const [{ useMessageStore }, { useAuthStore }] = await Promise.all([
      import('./useMessageStore'),
      import('./useAuthStore'),
    ]);
    const chatId = `auth-ready-chat-${Date.now()}-${Math.random()}`;
    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {},
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: false,
      hasMoreNewer: false,
    });

    await useMessageStore.getState().openChatWindow(chatId, { limit: 40, revalidate: true });
    expect(getMessagesMock).not.toHaveBeenCalled();
    expect(useMessageStore.getState().messages).toEqual([]);

    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    localStorage.setItem(storageKey('token'), 'token');
    useAuthStore.setState({
      authMode: 'cloud',
      isLoggedIn: true,
      token: 'token',
      user: {
        id: 'user-1',
        phone: '13500000000',
        nickname: '测试用户',
        avatar: '',
      },
    });
    getMessagesMock.mockResolvedValueOnce([buildMessage(1, chatId)]);

    await useMessageStore.getState().openChatWindow(chatId, { limit: 40, revalidate: true });

    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    expect(useMessageStore.getState().messages.map((message) => message.id)).toEqual(['message-1']);
  });

  it('reopens cloud chat windows with a partial persisted page even if remoteExhausted was persisted', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const persistedMessages = Array.from({ length: 7 }, (_, index) => buildMessage(index + 994, chatId));
    const fetchedMessages = Array.from({ length: 40 }, (_, index) => buildMessage(index + 961, chatId));
    let resolveFetchedMessages!: (messages: Message[]) => void;
    getMessagesMock.mockReturnValueOnce(new Promise<Message[]>((resolve) => {
      resolveFetchedMessages = resolve;
    }));

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: persistedMessages,
          lastSyncedAt: Date.now(),
          updatedAt: persistedMessages.at(-1)?.timestamp ?? 0,
          remoteExhausted: true,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: false,
    });

    const openPromise = useMessageStore.getState().openChatWindow(chatId, { limit: 40, revalidate: true });
    await waitForAssertion(() => {
      expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    });

    expect(useMessageStore.getState().messages).toHaveLength(7);
    expect(useMessageStore.getState().messages[0]?.id).toBe('message-994');
    expect(useMessageStore.getState().isLoading).toBe(true);

    resolveFetchedMessages(fetchedMessages);
    await openPromise;

    const state = useMessageStore.getState();
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    expect(state.messages[0]?.id).toBe('message-961');
    expect(state.messages).toHaveLength(40);
    expect(state.hasMore).toBe(true);
  });

  it('shows a complete local cache immediately while cloud revalidation is still pending', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const cachedMessages = Array.from({ length: 80 }, (_, index) => buildMessage(index + 1, chatId));
    let resolveFetchedMessages!: (messages: Message[]) => void;
    getMessagesMock.mockReturnValueOnce(new Promise<Message[]>((resolve) => {
      resolveFetchedMessages = resolve;
    }));

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: cachedMessages,
          lastSyncedAt: Date.now() - 60_000,
          updatedAt: cachedMessages.at(-1)?.timestamp ?? 0,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: false,
    });

    const openPromise = useMessageStore.getState().openChatWindow(chatId, { limit: 40, revalidate: true });

    await waitForAssertion(() => {
      expect(useMessageStore.getState().messages).toHaveLength(40);
      expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    });
    expect(useMessageStore.getState().messages[0]?.id).toBe('message-41');
    expect(useMessageStore.getState().messages.at(-1)?.id).toBe('message-80');

    resolveFetchedMessages(cachedMessages.slice(-40));
    await openPromise;

    const state = useMessageStore.getState();
    expect(state.messages).toHaveLength(40);
    expect(state.messages[0]?.id).toBe('message-41');
    expect(state.messages.at(-1)?.id).toBe('message-80');
    expect(state.messageWindowsByChatId[chatId]?.messages).toHaveLength(80);
  });

  it('refreshes cached story narrative metadata when blocks were compacted away', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'story-chat';
    const compactedStoryMessage: Message = {
      ...buildMessage(1, chatId),
      id: 'story-1',
      senderId: 'narrator',
      senderName: '旁白',
      content: '旁白。角色：“台词。”',
      metadata: {
        narrativeTurn: {
          turnId: 'turn-1',
          turnKind: 'narrative_beat',
          povActorId: 'narrator',
          blockCount: 2,
        } as unknown as NonNullable<Message['metadata']>['narrativeTurn'],
      },
    };
    const refreshedStoryMessage: Message = {
      ...compactedStoryMessage,
      metadata: {
        narrativeTurn: {
          turnId: 'turn-1',
          turnKind: 'narrative_beat',
          povActorId: 'narrator',
          blocks: [
            { id: 'block-1', actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: '旁白。' },
            { id: 'block-2', actorId: 'character-1', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', characterId: 'character-1', text: '台词。' },
          ],
        },
      },
    };
    getMessagesMock.mockResolvedValueOnce([refreshedStoryMessage]);

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [compactedStoryMessage],
          lastSyncedAt: Date.now(),
          updatedAt: compactedStoryMessage.timestamp,
          remoteExhausted: true,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: false,
    });

    await useMessageStore.getState().openChatWindow(chatId, { limit: 40, revalidate: false });

    expect(getSyncChangesMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined }));
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    expect(useMessageStore.getState().messages[0]?.metadata?.narrativeTurn?.blocks).toHaveLength(2);
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages[0]?.metadata?.narrativeTurn?.blocks).toHaveLength(2);
  });

  it('does not persist transient streaming flags in cached message windows', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const streamingMessage = {
      ...buildMessage(1, chatId),
      isStreaming: true,
    };

    useMessageStore.setState({
      messages: [streamingMessage],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [streamingMessage],
          lastSyncedAt: 0,
          updatedAt: streamingMessage.timestamp,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    const raw = localStorage.getItem(storageKey('message-storage'));
    const persisted = raw ? JSON.parse(raw) : null;
    const cachedMessage = persisted?.state?.messageWindowsByChatId?.[chatId]?.messages?.[0];

    expect(cachedMessage?.isStreaming).toBeUndefined();
  });

  it('loads older cloud messages past the local cache window', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const cachedMessages = Array.from({ length: 100 }, (_, index) => buildMessage(index + 901, chatId));
    const olderMessages = Array.from({ length: 40 }, (_, index) => buildMessage(index + 861, chatId));
    getMessagesMock.mockResolvedValueOnce(olderMessages);

    useMessageStore.setState({
      messages: cachedMessages.slice(-40),
      messageWindowsByChatId: {
        [chatId]: {
          messages: cachedMessages,
          lastSyncedAt: Date.now(),
          updatedAt: cachedMessages.at(-1)?.timestamp ?? 0,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    await useMessageStore.getState().loadMessages(chatId, { append: true, before: 961, limit: 40 });

    const state = useMessageStore.getState();
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: 961 });
    expect(state.messages[0]?.id).toBe('message-861');
    expect(state.messages.at(-1)?.id).toBe('message-1000');
    expect(state.messages).toHaveLength(80);
    expect(state.hasMore).toBe(true);
  });

  it('uses paged message API when cloud window probe is modified without inline changes', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const fetchedMessages = Array.from({ length: 40 }, (_, index) => buildMessage(index + 1, chatId));
    getSyncChangesMock.mockResolvedValueOnce({
      status: 'modified',
      scope: `messages.window:${chatId}`,
      cursor: 'messages.window:rev-1',
      revision: 'messages.window:rev-1',
      changes: [],
    });
    getMessagesMock.mockResolvedValueOnce(fetchedMessages);

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: Array.from({ length: 40 }, (_, index) => buildMessage(index + 41, chatId)),
          lastSyncedAt: Date.now() - 60_000,
          updatedAt: 80,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    await useMessageStore.getState().loadMessages(chatId, { limit: 40 });

    expect(getSyncChangesMock).toHaveBeenCalledWith({ scope: `messages.window:${chatId}`, since: null });
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    expect(useMessageStore.getState().messages).toHaveLength(40);
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages).toHaveLength(80);
  });

  it('replaces a stale local window when the complete cloud conversation fits in one response', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-reseeded';
    const staleMessages = Array.from({ length: 10 }, (_, index) => buildMessage(index + 1, chatId));
    const cloudMessages = Array.from({ length: 4 }, (_, index) => ({
      ...buildMessage(index + 101, chatId),
      content: `云端重建消息 ${index + 1}`,
    }));
    getSyncChangesMock.mockResolvedValueOnce({
      status: 'modified',
      scope: `messages.window:${chatId}`,
      cursor: 'messages.window:reseeded',
      revision: 'messages.window:reseeded',
      changes: [],
    });
    getMessagesMock.mockResolvedValueOnce(cloudMessages);

    useMessageStore.setState({
      messages: staleMessages,
      messageWindowsByChatId: {
        [chatId]: {
          messages: staleMessages,
          lastSyncedAt: Date.now() - 60_000,
          updatedAt: staleMessages.at(-1)?.timestamp ?? 0,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    await useMessageStore.getState().loadMessages(chatId, { limit: 40 });

    expect(useMessageStore.getState().messages.map((message) => message.content)).toEqual(cloudMessages.map((message) => message.content));
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.map((message) => message.content)).toEqual(cloudMessages.map((message) => message.content));
  });

  it('uses the cloud message window snapshot on first device load so branch history is not lost', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-branch';
    const windowMessages = [
      buildMessage(1, chatId),
      {
        ...buildMessage(2, chatId),
        metadata: { branching: { nodeId: 'node-2', parentNodeId: 'message-1', revisionRootId: 'message-2' } },
      },
      {
        ...buildMessage(90, chatId),
        metadata: {
          attachments: [{
            id: 'image-1',
            kind: 'image',
            status: 'ready',
            assetId: 'asset-1',
            url: '/media/asset-1.png',
            altText: '世界杯图片',
            createdAt: 90,
            updatedAt: 91,
          }],
        },
      },
    ] as Message[];
    getSyncChangesMock.mockResolvedValueOnce({
      status: 'modified',
      scope: `messages.window:${chatId}`,
      cursor: 'messages.window:rev-branch',
      revision: 'messages.window:rev-branch',
      changes: windowMessages.map((message) => ({
        entity: 'message_window_message',
        op: 'upsert',
        id: message.id,
        patch: {
          serverId: message.id,
          chatId: message.chatId,
          type: message.type,
          senderId: message.senderId,
          senderName: message.senderName,
          content: message.content,
          metadata: message.metadata,
          emotion: message.emotion,
          timestamp: message.timestamp,
          isDeleted: message.isDeleted,
        },
      })),
    });

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {},
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    await useMessageStore.getState().loadMessages(chatId, { limit: 40 });

    expect(getSyncChangesMock).toHaveBeenCalledWith({ scope: `messages.window:${chatId}`, since: null });
    expect(getMessagesMock).not.toHaveBeenCalled();
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-90',
    ]);
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.at(-1)?.metadata?.attachments?.[0]?.assetId).toBe('asset-1');
  });

  it('falls back to paged history when an empty local window receives a not-modified cloud probe', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-empty-local-window';
    const fetchedMessages = Array.from({ length: 3 }, (_, index) => buildMessage(index + 1, chatId));
    getSyncChangesMock.mockResolvedValueOnce({
      status: 'not_modified',
      scope: `messages.window:${chatId}`,
      cursor: 'messages.window:rev-existing',
      revision: 'messages.window:rev-existing',
      hasMore: false,
    });
    getMessagesMock.mockResolvedValueOnce(fetchedMessages);

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {},
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    await useMessageStore.getState().loadMessages(chatId, { limit: 40 });

    expect(getSyncChangesMock).toHaveBeenCalledWith({ scope: `messages.window:${chatId}`, since: null });
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    expect(useMessageStore.getState().messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ]);
  });

  it('keeps pending message create payload updated when media finishes before cloud upload', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-media-pending';
    const created = await useMessageStore.getState().addMessage({
      chatId,
      type: 'ai',
      senderId: 'character-1',
      senderName: '角色',
      content: '发图',
      emotion: 0,
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'queued',
          altText: '世界杯图',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });

    useMessageStore.getState().upsertMessage({
      ...created,
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'ready',
          assetId: 'asset-ready',
          url: '/media/asset-ready.png',
          altText: '世界杯图',
          createdAt: 1,
          updatedAt: 2,
        }],
      },
    });

    expect(useMessageStore.getState().pendingOperations[0]?.payload?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready',
      assetId: 'asset-ready',
      url: '/media/asset-ready.png',
    });
  });

  it('keeps the cached tail window visible when cloud changes only include sparse recent messages', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const cachedMessages = Array.from({ length: 80 }, (_, index) => buildMessage(index + 1, chatId));
    const changedMessages = cachedMessages.slice(-3).map((message) => ({
      ...message,
      content: `${message.content} 已刷新`,
    }));
    getSyncChangesMock.mockResolvedValueOnce({
      status: 'modified',
      scope: `messages.window:${chatId}`,
      cursor: 'messages.window:rev-2',
      revision: 'messages.window:rev-2',
      changes: changedMessages.map((message) => ({
        entity: 'message_window_message',
        op: 'upsert',
        id: message.id,
        patch: {
          chatId: message.chatId,
          type: message.type,
          senderId: message.senderId,
          senderName: message.senderName,
          content: message.content,
          metadata: message.metadata,
          emotion: message.emotion,
          timestamp: message.timestamp,
          isDeleted: message.isDeleted,
        },
      })),
    });

    useMessageStore.setState({
      messages: cachedMessages.slice(-3),
      messageWindowsByChatId: {
        [chatId]: {
          messages: cachedMessages,
          lastSyncedAt: Date.now() - 60_000,
          updatedAt: cachedMessages.at(-1)?.timestamp ?? 0,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    await useMessageStore.getState().loadMessages(chatId, { limit: 40 });

    const state = useMessageStore.getState();
    expect(getMessagesMock).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(40);
    expect(state.messages[0]?.id).toBe('message-41');
    expect(state.messages.at(-1)?.id).toBe('message-80');
    expect(state.messages.at(-1)?.content).toBe('消息 80 已刷新');
    expect(state.messageWindowsByChatId[chatId]?.messages).toHaveLength(80);
    expect(state.messageWindowsByChatId[chatId]?.messages.at(-1)?.content).toBe('消息 80 已刷新');
  });

  it('resets the cached active window limit when hydrating a chat from cache', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const { projectCurrentChatMessages } = await import('../services/currentChatMessages');
    const chatId = 'chat-1';
    const cachedMessages = Array.from({ length: 120 }, (_, index) => buildMessage(index + 1, chatId));

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: cachedMessages,
          lastSyncedAt: 0,
          updatedAt: cachedMessages.at(-1)?.timestamp ?? 0,
          activeLimit: 120,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    await useMessageStore.getState().hydrateMessagesFromCache(chatId, { limit: 40 });

    const state = useMessageStore.getState();
    const projected = projectCurrentChatMessages({
      chatId,
      activeMessages: state.messages,
      cachedWindow: state.messageWindowsByChatId[chatId],
    });
    expect(state.messages.map((message) => message.id)).toEqual(
      cachedMessages.slice(-40).map((message) => message.id),
    );
    expect(state.messageWindowsByChatId[chatId]?.activeLimit).toBe(40);
    expect(projected.map((message) => message.id)).toEqual(
      cachedMessages.slice(-40).map((message) => message.id),
    );
  });

  it('strips non-message fields when merging fetched and persisted messages', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const bloatedMessage = {
      ...buildMessage(1, chatId),
      debugPayload: { text: 'server-only' },
      rawResponse: Array.from({ length: 8 }, (_, index) => ({ index })),
    } as unknown as Message;

    useMessageStore.setState({
      messages: [bloatedMessage],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [bloatedMessage],
          lastSyncedAt: 0,
          updatedAt: 1,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    useMessageStore.getState().upsertMessage(buildMessage(2, chatId));

    const state = useMessageStore.getState();
    const activeMessage = state.messages.find((message) => message.id === 'message-1') as unknown as Record<string, unknown>;
    const cachedMessage = state.messageWindowsByChatId[chatId]?.messages.find((message) => message.id === 'message-1') as unknown as Record<string, unknown>;
    expect(activeMessage.debugPayload).toBeUndefined();
    expect(activeMessage.rawResponse).toBeUndefined();
    expect(cachedMessage.debugPayload).toBeUndefined();
    expect(cachedMessage.rawResponse).toBeUndefined();
  });

  it('keeps rich message metadata and caller timestamps for local messages', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const created = await useMessageStore.getState().addMessage({
      chatId,
      type: 'ai',
      senderId: 'character-1',
      senderName: '角色',
      content: '给你看这张照片',
      emotion: 0,
      timestamp: 12345,
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'queued',
          altText: '自拍照',
          createdAt: 12345,
          updatedAt: 12345,
        }],
      },
    });

    expect(created.timestamp).toBe(12345);
    expect(created.metadata?.attachments?.[0]?.kind).toBe('image');
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages[0]?.metadata?.attachments?.[0]?.altText).toBe('自拍照');
  });

  it('keeps committed streamed text when a stale streaming frame is upserted later', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const committed: Message = {
      id: 'local-stream-1',
      clientKey: 'local-stream-1',
      serverId: 'server-message-1',
      chatId,
      type: 'ai',
      senderId: 'character-1',
      senderName: '角色',
      content: '完整正式内容，不能被后到的短流式帧覆盖。',
      emotion: 0,
      timestamp: 123,
      isDeleted: false,
      isStreaming: false,
    };
    const staleStreaming: Message = {
      ...committed,
      serverId: undefined,
      content: '完整正式',
      isStreaming: true,
    };

    useMessageStore.setState({
      messages: [committed],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [committed],
          lastSyncedAt: 0,
          updatedAt: committed.timestamp,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    useMessageStore.getState().upsertMessage(staleStreaming);

    const state = useMessageStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe(committed.content);
    expect(state.messages[0]?.isStreaming).toBe(false);
    expect(state.messageWindowsByChatId[chatId]?.messages).toHaveLength(1);
    expect(state.messageWindowsByChatId[chatId]?.messages[0]?.content).toBe(committed.content);
  });

  it('does not merge a new streaming turn into the previous same-speaker message by content', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const previous: Message = {
      id: 'previous-message-1',
      chatId,
      type: 'ai',
      senderId: 'character-1',
      senderName: '角色',
      content: '上一条刚说过的话',
      emotion: 0,
      timestamp: 1000,
      isDeleted: false,
      isStreaming: false,
    };
    const streaming: Message = {
      id: 'streaming-message-2',
      clientKey: 'streaming-message-2',
      chatId,
      type: 'ai',
      senderId: 'character-1',
      senderName: '角色',
      content: previous.content,
      emotion: 0,
      timestamp: 2000,
      isDeleted: false,
      isStreaming: true,
    };

    useMessageStore.setState({
      messages: [previous],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [previous],
          lastSyncedAt: 0,
          updatedAt: previous.timestamp,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    const windowBeforeStreaming = useMessageStore.getState().messageWindowsByChatId[chatId];
    useMessageStore.getState().upsertMessage(streaming);

    const state = useMessageStore.getState();
    expect(state.messages.map((message) => message.id)).toEqual(['previous-message-1', 'streaming-message-2']);
    expect(state.messages[0]?.isStreaming).toBe(false);
    expect(state.messages[1]?.isStreaming).toBe(true);
    expect(state.messageWindowsByChatId[chatId]).toBe(windowBeforeStreaming);
    expect(state.messageWindowsByChatId[chatId]?.messages.map((message) => message.id)).toEqual(['previous-message-1']);
  });

  it('keeps repeated committed same-speaker content as distinct messages', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const first = {
      ...buildMessage(1, chatId),
      id: 'repeat-1',
      content: '好',
      timestamp: 1000,
    };
    const second = {
      ...buildMessage(2, chatId),
      id: 'repeat-2',
      content: '好',
      timestamp: 1200,
    };

    useMessageStore.setState({
      messages: [first],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [first],
          lastSyncedAt: 0,
          updatedAt: first.timestamp,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    useMessageStore.getState().upsertMessage(second);

    const state = useMessageStore.getState();
    expect(state.messages.map((message) => message.id)).toEqual(['repeat-1', 'repeat-2']);
    expect(state.messageWindowsByChatId[chatId]?.messages.map((message) => message.id)).toEqual(['repeat-1', 'repeat-2']);
  });

  it('merges local streamed messages with server confirmations by shared server id', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const local: Message = {
      id: 'local-stream-1',
      clientKey: 'local-stream-1',
      serverId: 'server-message-1',
      chatId,
      type: 'ai',
      senderId: 'character-1',
      senderName: '角色',
      content: '逐字显示完整内容',
      emotion: 0,
      timestamp: 123,
      isDeleted: false,
      isStreaming: false,
    };
    const remote: Message = {
      ...local,
      id: 'server-message-1',
      clientKey: undefined,
      timestamp: 999,
    };

    useMessageStore.setState({
      messages: [local],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [local],
          lastSyncedAt: 0,
          updatedAt: local.timestamp,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      hasMore: true,
    });

    useMessageStore.getState().upsertMessage(remote);

    const state = useMessageStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.id).toBe('local-stream-1');
    expect(state.messages[0]?.clientKey).toBe('local-stream-1');
    expect(state.messages[0]?.serverId).toBe('server-message-1');
    expect(state.messageWindowsByChatId[chatId]?.messages).toHaveLength(1);
  });

  it('uses local message window and keeps first message pending until a newly created local chat is synced', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const { useChatStore } = await import('./useChatStore');
    useChatStore.setState({
      chats: [{
        id: 'local-chat-12345678',
        type: 'direct',
        mode: 'open_chat',
        modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
        modeState: { phase: 'free' },
        name: '新单聊',
        topic: '',
        style: 'free',
        runtimeEvolutionIntensity: 'balanced',
        memberIds: ['char-1'],
        speed: 1,
        isActive: false,
        allowIntervention: true,
        showRoleActions: true,
        topicSeed: '',
        runtimeSeed: { notes: [], artifacts: [] },
        createdAt: 1,
        updatedAt: 1,
        lastMessageAt: 1,
      } as never],
      currentChatId: 'local-chat-12345678',
      lastSyncedAt: 1,
      pendingOperations: [{
        id: 'chat-create-op',
        kind: 'create',
        entityId: 'local-chat-12345678',
        patch: { id: 'local-chat-12345678' },
        targetIds: ['local-chat-12345678'],
        clientTimestamp: Date.now(),
        attemptCount: 0,
        status: 'pending',
      } as never],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      fieldConflicts: [],
      chatSummaryLoadedAt: 1,
      isLoading: false,
    });

    await useMessageStore.getState().openChatWindow('local-chat-12345678', { limit: 40, revalidate: true });
    expect(getMessagesMock).not.toHaveBeenCalled();

    await useMessageStore.getState().addMessage({
      chatId: 'local-chat-12345678',
      type: 'ai',
      senderId: 'char-1',
      senderName: '角色',
      content: '第一句',
      emotion: 0,
    });

    expect(useMessageStore.getState().pendingOperations).toHaveLength(1);
    expect(useMessageStore.getState().pendingOperations[0]?.chatId).toBe('local-chat-12345678');
    expect(useMessageStore.getState().messageWindowsByChatId['local-chat-12345678']?.messages[0]?.chatId).toBe('local-chat-12345678');
    expect(useChatStore.getState().pendingOperations[0]?.kind).toBe('create');
    expect(getMessagesMock).not.toHaveBeenCalled();
  });

  it('loads cloud history when a remote chat exists but a stale local create operation remains', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const { useChatStore } = await import('./useChatStore');
    const chatId = 'local-chat-already-remote';
    useChatStore.setState({
      chats: [{ id: chatId, type: 'group', name: '学习房', topic: '', memberIds: ['char-1'] } as never],
      pendingOperations: [{ id: 'stale-create', kind: 'create', entityId: chatId, patch: { id: chatId }, targetIds: [chatId], clientTimestamp: Date.now(), attemptCount: 0, status: 'pending' } as never],
    } as never);
    getChatMock.mockResolvedValueOnce({ id: chatId });
    getMessagesMock.mockResolvedValueOnce([buildMessage(1, chatId)]);

    await useMessageStore.getState().openChatWindow(chatId, { limit: 40, revalidate: true });

    expect(getChatMock).toHaveBeenCalledWith(chatId);
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    expect(useChatStore.getState().pendingOperations).toHaveLength(0);
    expect(useMessageStore.getState().messages).toHaveLength(1);
  });

  it('keeps local messages visible without a user-facing error when the cloud message resource is missing', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'local-first-chat';
    const cachedMessage = buildMessage(1, chatId);
    getSyncChangesMock.mockResolvedValueOnce({
      status: 'modified',
      scope: `messages.window:${chatId}`,
      cursor: 'messages.window:rev-missing',
      revision: 'messages.window:rev-missing',
      changes: [],
    });
    getMessagesMock.mockRejectedValueOnce(new MockApiError('群聊不存在', { code: 'NOT_FOUND', status: 404 }));

    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [cachedMessage],
          lastSyncedAt: 0,
          updatedAt: cachedMessage.timestamp,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: true,
      hasMoreNewer: false,
    });

    await useMessageStore.getState().loadMessages(chatId, { limit: 40 });

    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, before: undefined });
    expect(useMessageStore.getState().messages.map((message) => message.id)).toEqual(['message-1']);
    expect(useMessageStore.getState().isLoading).toBe(false);
    expect(reportRecoverableErrorMock).not.toHaveBeenCalled();
  });

  it('queues local chat creation when cloud messages fail because the chat is missing remotely', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const [{ useMessageStore }, { useChatStore }, { useCharacterStore }, { buildDeletedCharacter }] = await Promise.all([
      import('./useMessageStore'),
      import('./useChatStore'),
      import('./useCharacterStore'),
      import('../utils/deletedEntity'),
    ]);
    const chatId = 'local-first-chat-needs-cloud-create';
    const cachedMessage = buildMessage(1, chatId);
    getSyncChangesMock.mockResolvedValueOnce({
      status: 'modified',
      scope: `messages.window:${chatId}`,
      cursor: 'messages.window:rev-missing',
      revision: 'messages.window:rev-missing',
      changes: [],
    });
    getMessagesMock.mockRejectedValueOnce(new MockApiError('聊天不存在', { code: 'NOT_FOUND', status: 404 }));
    useCharacterStore.setState({
      characters: [{
        ...buildDeletedCharacter('character-1', '角色'),
        deletedAt: null,
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    useChatStore.setState({
      chats: [createTestChat({
        id: chatId,
        type: 'direct',
        mode: 'open_chat',
        name: '本地单聊',
        topic: '',
        style: 'free',
        memberIds: ['user', 'character-1'],
        speed: 1,
        isActive: true,
        allowIntervention: true,
        showRoleActions: true,
        createdAt: 1,
        updatedAt: 2,
        lastMessageAt: 2,
      })],
      pendingOperations: [],
      currentChatId: chatId,
      lastSyncedAt: 1,
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      fieldConflicts: [],
      chatSummaryLoadedAt: 1,
      isLoading: false,
    });
    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [cachedMessage],
          lastSyncedAt: 0,
          updatedAt: cachedMessage.timestamp,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: true,
      hasMoreNewer: false,
    });

    await useMessageStore.getState().loadMessages(chatId, { limit: 40 });

    expect(useMessageStore.getState().messages.map((message) => message.id)).toEqual(['message-1']);
    expect(useChatStore.getState().pendingOperations).toEqual([
      expect.objectContaining({
        kind: 'create',
        entityId: chatId,
        status: 'pending',
      }),
    ]);
    expect(reportRecoverableErrorMock).not.toHaveBeenCalled();
  }, 20_000);

  it('does not recreate a cloud direct chat when its required character is deleted locally', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const [{ useMessageStore }, { useChatStore }, { useCharacterStore }, { buildDeletedCharacter }] = await Promise.all([
      import('./useMessageStore'),
      import('./useChatStore'),
      import('./useCharacterStore'),
      import('../utils/deletedEntity'),
    ]);
    const chatId = 'deleted-character-direct-chat';
    const cachedMessage = buildMessage(1, chatId);
    getSyncChangesMock.mockResolvedValueOnce({
      status: 'modified',
      scope: `messages.window:${chatId}`,
      cursor: 'messages.window:rev-missing-deleted-character',
      revision: 'messages.window:rev-missing-deleted-character',
      changes: [],
    });
    getMessagesMock.mockRejectedValueOnce(new MockApiError('聊天不存在', { code: 'NOT_FOUND', status: 404 }));
    useCharacterStore.setState({
      characters: [{
        ...buildDeletedCharacter('character-1', '角色'),
        deletedAt: 10,
        createdAt: 1,
        updatedAt: 10,
      }],
    });

    useChatStore.setState({
      chats: [createTestChat({
        id: chatId,
        type: 'direct',
        mode: 'open_chat',
        name: '已删除角色单聊',
        topic: '',
        style: 'free',
        memberIds: ['user', 'character-1'],
        speed: 1,
        isActive: true,
        allowIntervention: true,
        showRoleActions: true,
        createdAt: 1,
        updatedAt: 2,
        lastMessageAt: 2,
      })],
      pendingOperations: [],
      currentChatId: chatId,
      lastSyncedAt: 1,
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      fieldConflicts: [],
      chatSummaryLoadedAt: 1,
      isLoading: false,
    });
    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        [chatId]: {
          messages: [cachedMessage],
          lastSyncedAt: 0,
          updatedAt: cachedMessage.timestamp,
        },
      },
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: true,
      hasMoreNewer: false,
    });

    await useMessageStore.getState().loadMessages(chatId, { limit: 40 });

    expect(useMessageStore.getState().messages.map((message) => message.id)).toEqual(['message-1']);
    expect(useChatStore.getState().pendingOperations).toEqual([]);
    expect(reportRecoverableErrorMock).not.toHaveBeenCalled();
  }, 20_000);

  it('opens a cloud message window around a historical timestamp', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const fetchedMessages = Array.from({ length: 40 }, (_, index) => buildMessage(index + 481, chatId));
    getMessagesMock.mockResolvedValueOnce(fetchedMessages);

    await useMessageStore.getState().openChatWindow(chatId, { limit: 40, aroundTimestamp: 500 });

    const state = useMessageStore.getState();
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, aroundTimestamp: 500 });
    expect(state.messages[0]?.id).toBe('message-481');
    expect(state.messages.at(-1)?.id).toBe('message-520');
    expect(state.hasMore).toBe(true);
    expect(state.hasMoreNewer).toBe(true);
  });

  it('loads newer cloud messages below a historical active window', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const activeMessages = Array.from({ length: 40 }, (_, index) => buildMessage(index + 481, chatId));
    const newerMessages = Array.from({ length: 40 }, (_, index) => buildMessage(index + 521, chatId));
    getMessagesMock.mockResolvedValueOnce(newerMessages);

    useMessageStore.setState({
      messages: activeMessages,
      messageWindowsByChatId: {
        [chatId]: {
          messages: activeMessages,
          lastSyncedAt: Date.now(),
          updatedAt: activeMessages.at(-1)?.timestamp ?? 0,
          remoteExhausted: false,
          remoteNewerExhausted: false,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: true,
      hasMoreNewer: true,
    });

    await useMessageStore.getState().loadMessages(chatId, { append: true, after: 520, limit: 40 });

    const state = useMessageStore.getState();
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, after: 520 });
    expect(state.messages[0]?.id).toBe('message-481');
    expect(state.messages.at(-1)?.id).toBe('message-560');
    expect(state.hasMoreNewer).toBe(true);
    expect(state.isLoadingNewer).toBe(false);
  });

  it('restores newer messages from the retained local window after loading older messages', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'local');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-local-window';
    const older = Array.from({ length: 40 }, (_, index) => buildMessage(index + 1, chatId));
    const newer = Array.from({ length: 40 }, (_, index) => buildMessage(index + 41, chatId));
    useMessageStore.setState({
      messages: older,
      messageWindowsByChatId: {
        [chatId]: { messages: [...older, ...newer], lastSyncedAt: Date.now(), updatedAt: 80, activeLimit: 40 },
      },
      pendingOperations: [], activeChatId: chatId, isLoading: false, isLoadingOlder: false,
      isLoadingNewer: false, hasMore: true, hasMoreNewer: true,
    });
    await useMessageStore.getState().loadMessages(chatId, { append: true, after: 40, limit: 40 });
    const state = useMessageStore.getState();
    expect(state.messages[0]?.id).toBe('message-1');
    expect(state.messages.at(-1)?.id).toBe('message-80');
    expect(state.hasMoreNewer).toBe(false);
  });

  it('stops newer pagination after an empty cloud page even when cached messages have later timestamps', async () => {
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    const { useMessageStore } = await import('./useMessageStore');
    const chatId = 'chat-1';
    const activeMessages = Array.from({ length: 40 }, (_, index) => buildMessage(index + 481, chatId));
    const offPathCachedTail = [
      ...activeMessages,
      buildMessage(999, chatId),
    ];
    getMessagesMock.mockResolvedValueOnce([]);

    useMessageStore.setState({
      messages: activeMessages,
      messageWindowsByChatId: {
        [chatId]: {
          messages: offPathCachedTail,
          lastSyncedAt: Date.now(),
          updatedAt: offPathCachedTail.at(-1)?.timestamp ?? 0,
          remoteExhausted: false,
          remoteNewerExhausted: false,
        },
      },
      pendingOperations: [],
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: true,
      hasMoreNewer: true,
    });

    await useMessageStore.getState().loadMessages(chatId, { append: true, after: 520, limit: 40 });

    const state = useMessageStore.getState();
    expect(getMessagesMock).toHaveBeenCalledWith(chatId, { limit: 40, after: 520 });
    expect(state.messages).toHaveLength(40);
    expect(state.messages.at(-1)?.id).toBe('message-520');
    expect(state.hasMoreNewer).toBe(false);
    expect(state.messageWindowsByChatId[chatId]?.messages.some((message) => message.id === 'message-999')).toBe(true);
  });

});
