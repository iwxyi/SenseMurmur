import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageKey } from '../constants/brand';
import {
  DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
  DEFAULT_CONVERSATION_DRAMA_RULES,
  DEFAULT_CONVERSATION_GOVERNANCE,
  DEFAULT_CONVERSATION_WORLD_STATE,
  DEFAULT_OPEN_CHAT_MODE_CONFIG,
  DEFAULT_OPEN_CHAT_MODE_STATE,
  type GroupChat,
} from '../types/chat';
import type { AICharacter } from '../types/character';
import type { CharacterArtifactEntry } from './useCharacterArtifactStore';

function createStorageMock() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  };
}

const apiMocks = vi.hoisted(() => ({
  login: vi.fn(),
  getMe: vi.fn(),
  getSyncChanges: vi.fn(),
  getSettings: vi.fn(),
  getChat: vi.fn(),
  getChats: vi.fn(),
  getMessages: vi.fn(),
  getDeletedChats: vi.fn(),
  syncChatPatch: vi.fn(),
  createChat: vi.fn(),
  getCharacter: vi.fn(),
  getCharacters: vi.fn(),
  getDeletedCharacters: vi.fn(),
  syncCharacterPatch: vi.fn(),
  getCharacterArtifactSummaries: vi.fn(),
  getCharacterArtifactItem: vi.fn(),
}));

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<typeof import('../services/api')>('../services/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      login: apiMocks.login,
      getMe: apiMocks.getMe,
      getSyncChanges: apiMocks.getSyncChanges,
      getSettings: apiMocks.getSettings,
      getChat: apiMocks.getChat,
      getChats: apiMocks.getChats,
      getMessages: apiMocks.getMessages,
      getDeletedChats: apiMocks.getDeletedChats,
      syncChatPatch: apiMocks.syncChatPatch,
      createChat: apiMocks.createChat,
      getCharacter: apiMocks.getCharacter,
      getCharacters: apiMocks.getCharacters,
      getDeletedCharacters: apiMocks.getDeletedCharacters,
      syncCharacterPatch: apiMocks.syncCharacterPatch,
      getCharacterArtifactSummaries: apiMocks.getCharacterArtifactSummaries,
      getCharacterArtifactItem: apiMocks.getCharacterArtifactItem,
    },
  };
});

function seedCloudAuth() {
  localStorage.setItem(storageKey('token'), 'token');
  localStorage.setItem(storageKey('auth-mode'), 'cloud');
}

function chat(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: DEFAULT_OPEN_CHAT_MODE_CONFIG,
    modeState: DEFAULT_OPEN_CHAT_MODE_STATE,
    name: '测试群聊',
    topic: '测试主题',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['character-1'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    layeredMemories: [],
    runtimeSeed: { notes: [], artifacts: [] },
    runtimeTimeline: [],
    runtimeEventsV2: [],
    relationshipLedger: [],
    governance: DEFAULT_CONVERSATION_GOVERNANCE,
    dramaRules: DEFAULT_CONVERSATION_DRAMA_RULES,
    worldState: DEFAULT_CONVERSATION_WORLD_STATE,
    directorControls: DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
    ...overrides,
  };
}

function character(overrides: Partial<AICharacter> = {}): AICharacter {
  return {
    id: 'character-1',
    name: '小甲',
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
    behavior: { proactivity: 50, aggressiveness: 20, humorIntensity: 40, empathyLevel: 60, summarizing: 30, offTopic: 20 },
    expertise: ['测试'],
    speakingStyle: '短句',
    background: '测试角色',
    relationships: [],
    memory: { longTerm: [], shortTermSummary: '', secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
    layeredMemories: [],
    intervention: { allowSpeakAs: true, allowDirectorPrompt: true, allowPrivateThread: true },
    runtimeTimeline: [],
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function artifact(overrides: Partial<CharacterArtifactEntry> = {}): CharacterArtifactEntry {
  return {
    id: 'artifact-1',
    kind: 'diary',
    characterId: 'character-1',
    characterName: '小甲',
    dateKey: '2026-06-05',
    sourceKey: 'source-1',
    title: '测试日记',
    text: '本地日记内容',
    source: 'local',
    unread: false,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

describe('cloud no-op sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createStorageMock());
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => unknown) => callback() } });
    seedCloudAuth();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.getSyncChanges.mockResolvedValue({
      status: 'not_modified',
      cursor: 'rev-1',
      revision: 'rev-1',
      changes: [],
    });
    apiMocks.getMe.mockResolvedValue({
      id: 'local-user',
      phone: '13500000000',
      nickname: '测试用户',
      avatar: '🍵',
      cloudSyncEntitled: true,
    });
    apiMocks.login.mockResolvedValue({
      token: 'token',
      refreshToken: 'refresh-token',
      user: {
        id: 'local-user',
        phone: '13500000000',
        nickname: '测试用户',
        avatar: '🍵',
        cloudSyncEntitled: true,
      },
    });
    apiMocks.getSettings.mockResolvedValue({});
    apiMocks.syncChatPatch.mockResolvedValue({ success: true, accepted: true, revision: 1 });
    apiMocks.syncCharacterPatch.mockResolvedValue({ success: true, accepted: true, revision: 1 });
  });

  afterEach(async () => {
    const { stopWorkspace } = await import('../services/workspaceLifecycle');
    stopWorkspace();
    const { flushBufferedPersistenceWrites } = await import('./storePersistenceScope');
    flushBufferedPersistenceWrites();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  it.each(['character', 'chat'] as const)('applies another device\'s %s deletion even when the local clock is ahead', async (kind) => {
    const { useCharacterStore } = await import('./useCharacterStore');
    const { useChatStore } = await import('./useChatStore');
    await Promise.all([useCharacterStore.persist.rehydrate(), useChatStore.persist.rehydrate()]);
    useCharacterStore.setState({ characters: [character({ updatedAt: 999 })], pendingOperations: [] });
    useChatStore.setState({ chats: [chat({ updatedAt: 999 })], pendingOperations: [] });
    const deleted = kind === 'character' ? character({ updatedAt: 2, deletedAt: 2 }) : chat({ updatedAt: 2, deletedAt: 2 });
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified', cursor: 'log:2', revision: 'log:2',
      changes: [{ op: 'delete', entity: `${kind}_summary`, id: `${kind}-1`, revision: 2, patch: deleted }],
    });
    if (kind === 'character') {
      await useCharacterStore.getState().loadCharacters();
      expect(useCharacterStore.getState().characters).toEqual([]);
      expect(useCharacterStore.getState().remoteDeletedCharacterIds).toContain('character-1');
      useCharacterStore.getState().hydrateCharacterSummaries([character({ updatedAt: 1000 })]);
      expect(useCharacterStore.getState().characters).toEqual([]);
    } else {
      await useChatStore.getState().loadChats({ waitForCloud: true });
      expect(useChatStore.getState().chats).toEqual([]);
      expect(useChatStore.getState().remoteDeletedChatIds).toContain('chat-1');
    }
  });

  it.each(['character', 'chat'] as const)('persists an account %s deletion while cloud sync is disabled', async (kind) => {
    const { useAuthStore } = await import('./useAuthStore');
    const { setCloudSyncEnabled } = await import('../services/cloudSyncPreference');
    useAuthStore.setState({ authMode: 'cloud', isLoggedIn: true, user: { id: 'local-user', cloudSyncEntitled: false } as NonNullable<ReturnType<typeof useAuthStore.getState>['user']> });
    setCloudSyncEnabled(false, { source: 'entitlement' });
    const { useCharacterStore } = await import('./useCharacterStore');
    const { useChatStore } = await import('./useChatStore');
    await Promise.all([useCharacterStore.persist.rehydrate(), useChatStore.persist.rehydrate()]);
    useCharacterStore.setState({ characters: [character()], pendingOperations: [] });
    useChatStore.setState({ chats: [chat()], pendingOperations: [] });
    if (kind === 'character') {
      await useCharacterStore.getState().deleteCharacter('character-1');
      await useCharacterStore.persist.rehydrate();
      expect(useCharacterStore.getState().characters).toEqual([]);
      expect(useCharacterStore.getState().pendingOperations).toEqual([expect.objectContaining({ entityId: 'character-1', patch: expect.objectContaining({ deletedAt: expect.any(Number) }) })]);
    } else {
      await useChatStore.getState().deleteChat('chat-1');
      await useChatStore.persist.rehydrate();
      expect(useChatStore.getState().chats).toEqual([]);
      expect(useChatStore.getState().pendingOperations).toEqual([expect.objectContaining({ entityId: 'chat-1', patch: expect.objectContaining({ deletedAt: expect.any(Number) }) })]);
    }
    expect(apiMocks.syncCharacterPatch).not.toHaveBeenCalled();
    expect(apiMocks.syncChatPatch).not.toHaveBeenCalled();
  });

  it('keeps guest and account snapshots separate through account switches and relogin', async () => {
    const accountA = `scope-a-${Date.now()}`;
    const accountB = `scope-b-${Date.now()}`;
    for (const id of ['guest', accountA, accountB]) {
      localStorage.setItem(storageKey(`characters-${id}`), JSON.stringify({
        state: { characters: [character({ id: `character-${id}` })], pendingOperations: [], remoteDeletedCharacterIds: [`deleted-${id}`] },
        version: 5,
      }));
      localStorage.setItem(storageKey(`chats-${id}`), JSON.stringify({
        state: { chats: [chat({ id: `chat-${id}` })], pendingOperations: [] }, version: 5,
      }));
    }
    const { useCharacterStore, resetCharacterStoreForAccountBoundary } = await import('./useCharacterStore');
    const { useChatStore, resetChatStoreForAccountBoundary } = await import('./useChatStore');
    const { getLocalDataUserId } = await import('../services/authStorageScope');
    for (const id of [accountA, accountB, accountA, 'guest', accountB]) {
      if (id === 'guest') {
        localStorage.removeItem(storageKey('user'));
        localStorage.removeItem(storageKey('token'));
        localStorage.setItem(storageKey('auth-mode'), 'local');
      } else {
        localStorage.setItem(storageKey('user'), JSON.stringify({ id }));
        seedCloudAuth();
      }
      expect(getLocalDataUserId()).toBe(id);
      await resetCharacterStoreForAccountBoundary();
      await resetChatStoreForAccountBoundary();
      await useCharacterStore.persist.rehydrate();
      await useChatStore.persist.rehydrate();
      expect(useCharacterStore.getState().characters.map((item) => item.id)).toEqual([`character-${id}`]);
      expect(useCharacterStore.getState().remoteDeletedCharacterIds).toEqual([`deleted-${id}`]);
      expect(useChatStore.getState().chats.map((item) => item.id)).toEqual([`chat-${id}`]);
    }
  });

  it.each(['character', 'chat'] as const)('still applies a confirmed cloud deletion to a local %s', async (kind) => {
    const { useCharacterStore } = await import('./useCharacterStore');
    const { useChatStore } = await import('./useChatStore');
    await Promise.all([useCharacterStore.persist.rehydrate(), useChatStore.persist.rehydrate()]);
    useCharacterStore.setState({ characters: [character({ characterDetailLoaded: true })], pendingOperations: [] });
    useChatStore.setState({ chats: [chat({ runtimeDetailLoaded: true })], pendingOperations: [] });
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified', cursor: 'log:2', revision: 'log:2',
      changes: [{ op: 'delete', entity: `${kind}_detail`, id: `${kind}-1`, revision: 2, patch: { updatedAt: 2, deletedAt: 2 } }],
    });
    if (kind === 'character') await useCharacterStore.getState().loadCharacter('character-1');
    else await useChatStore.getState().loadChat('chat-1');
    await vi.waitFor(() => {
      const items = kind === 'character' ? useCharacterStore.getState().characters : useChatStore.getState().chats;
      expect(items).toEqual([]);
    });
  });

  it.each(['character', 'chat'] as const)('uses the final detail change when a %s was deleted then restored', async (kind) => {
    const { useCharacterStore } = await import('./useCharacterStore');
    const { useChatStore } = await import('./useChatStore');
    await Promise.all([useCharacterStore.persist.rehydrate(), useChatStore.persist.rehydrate()]);
    useCharacterStore.setState({ characters: [character({ characterDetailLoaded: true })], pendingOperations: [] });
    useChatStore.setState({ chats: [chat({ runtimeDetailLoaded: true })], pendingOperations: [] });
    const restored = kind === 'character' ? character({ updatedAt: 2 }) : chat({ updatedAt: 2 });
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified', cursor: 'log:3', revision: 'log:3',
      changes: [
        { op: 'delete', entity: `${kind}_detail`, id: `${kind}-1`, revision: 2, patch: { ...restored, deletedAt: 2 } },
        { op: 'upsert', entity: `${kind}_detail`, id: `${kind}-1`, revision: 2, patch: { ...restored, deletedAt: null } },
      ],
    });
    if (kind === 'character') await useCharacterStore.getState().loadCharacter('character-1');
    else await useChatStore.getState().loadChat('chat-1');
    await vi.waitFor(() => {
      const items = kind === 'character' ? useCharacterStore.getState().characters : useChatStore.getState().chats;
      expect(items).toHaveLength(1);
      expect(items[0].updatedAt).toBe(2);
      expect(items[0].deletedAt).toBeNull();
    });
  });

  it.each(['character', 'chat'] as const)('keeps a local %s when cloud detail only reports a missing record', async (kind) => {
    const { useCharacterStore } = await import('./useCharacterStore');
    const { useChatStore } = await import('./useChatStore');
    await Promise.all([useCharacterStore.persist.rehydrate(), useChatStore.persist.rehydrate()]);
    useCharacterStore.setState({ characters: [character({ characterDetailLoaded: true })] });
    useChatStore.setState({ chats: [chat({ runtimeDetailLoaded: true })] });
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified', cursor: 'log:0', revision: 'log:0',
      changes: [{ op: 'delete', entity: `${kind}_detail`, id: `${kind}-1`, revision: 0 }],
    });
    const missing = Object.assign(new Error('not found'), { status: 404 });
    apiMocks.getCharacter.mockRejectedValue(missing);
    apiMocks.getChat.mockRejectedValue(missing);
    if (kind === 'character') await useCharacterStore.getState().loadCharacter('character-1');
    else await useChatStore.getState().loadChat('chat-1');
    await vi.waitFor(() => {
      expect(kind === 'character' ? apiMocks.getCharacter : apiMocks.getChat).toHaveBeenCalled();
      expect(useCharacterStore.getState().characters).toHaveLength(1);
      expect(useChatStore.getState().chats).toHaveLength(1);
    });
  });

  it('uses the last chat summary change when a deleted chat was restored', async () => {
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({ chats: [chat()], pendingOperations: [] });
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified', cursor: 'log:3', revision: 'log:3',
      changes: [
        { op: 'delete', entity: 'chat_summary', id: 'chat-1', revision: 2, patch: chat({ updatedAt: 2, deletedAt: 2 }) },
        { op: 'upsert', entity: 'chat_summary', id: 'chat-1', revision: 2, patch: chat({ updatedAt: 2, deletedAt: null }) },
      ],
    });
    await useChatStore.getState().loadChats();
    expect(useChatStore.getState().chats.map((item) => item.id)).toEqual(['chat-1']);
    expect(useChatStore.getState().remoteDeletedChatIds).toEqual([]);
  });

  it('does not resurrect deleted characters from cached chat member summaries after tasks finish or hydration', async () => {
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({ characters: [character()] });
    await useCharacterStore.getState().deleteCharacter('character-1');
    useCharacterStore.setState({ pendingOperations: [] });
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.getState().hydrateCharacterSummaries([character({ updatedAt: 100 })]);
    expect(useCharacterStore.getState().characters).toEqual([]);
  });

  it('preserves deletion markers in chat member summaries', async () => {
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({ characters: [] });
    useCharacterStore.getState().hydrateCharacterSummaries([character({ deletedAt: 2, updatedAt: 2 })]);
    expect(useCharacterStore.getState().characters).toEqual([]);
  });

  it('clears selected chat and character tasks while retaining content, other tasks, and running requests', async () => {
    const { useChatStore } = await import('./useChatStore');
    const { useCharacterStore } = await import('./useCharacterStore');
    const operations = (['failed', 'pending', 'syncing'] as const).map((status) => ({
      id: status, entityId: 'chat-1', kind: 'patch' as const, targetIds: ['chat-1'],
      clientTimestamp: 100, patch: { name: '未上传名称' }, status, attemptCount: 1,
    }));
    useChatStore.setState({ chats: [chat()], pendingOperations: operations, fieldConflicts: [] });
    useCharacterStore.setState({ characters: [character()], pendingOperations: operations, fieldConflicts: [] });

    useChatStore.getState().clearSyncTasks(['failed']);
    useCharacterStore.getState().clearSyncTasks(['failed']);
    expect(useChatStore.getState().pendingOperations.map((item) => item.id)).toEqual(['pending', 'syncing']);
    expect(useCharacterStore.getState().pendingOperations.map((item) => item.id)).toEqual(['pending', 'syncing']);

    useChatStore.getState().clearSyncTasks(['pending', 'syncing']);
    useCharacterStore.getState().clearSyncTasks(['pending', 'syncing']);
    expect(useChatStore.getState().pendingOperations.map((item) => item.id)).toEqual(['syncing']);
    expect(useCharacterStore.getState().pendingOperations.map((item) => item.id)).toEqual(['syncing']);
    expect(useChatStore.getState().chats).toEqual([chat()]);
    expect(useCharacterStore.getState().characters).toEqual([character()]);
    expect(useChatStore.getState().pendingEditSyncCount).toBe(1);
    expect(useCharacterStore.getState().pendingEditSyncCount).toBe(1);

    // A late callback or stale tab snapshot must not restore the cancelled tasks.
    useChatStore.setState({ pendingOperations: operations });
    useCharacterStore.setState({ pendingOperations: operations });
    expect(useChatStore.getState().pendingOperations.map((item) => item.id)).toEqual(['syncing']);
    expect(useCharacterStore.getState().pendingOperations.map((item) => item.id)).toEqual(['syncing']);
  });

  it('does not restore cleared chat tasks from an older snapshot after hydration', async () => {
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    const operations = [{
      id: 'week-old-task', entityId: 'chat-1', kind: 'patch' as const, targetIds: ['chat-1'],
      clientTimestamp: Date.now() - 7 * 86400_000, patch: { name: '旧编辑' }, status: 'failed' as const, attemptCount: 2,
    }];
    useChatStore.setState({ chats: [chat()], pendingOperations: operations });
    useChatStore.getState().clearSyncTasks(['week-old-task']);
    const storage = useChatStore.persist.getOptions().storage!;
    const read = vi.spyOn(storage, 'getItem').mockResolvedValue({
      state: { chats: [chat()], currentChatId: null, lastSyncedAt: 0, pendingOperations: operations },
    });
    try {
      await useChatStore.getState().restoreLocalChats();
      expect(useChatStore.getState().pendingOperations).toEqual([]);
      expect(useChatStore.getState().pendingEditSyncCount).toBe(0);
      expect(useChatStore.getState().chats).toHaveLength(1);
    } finally {
      read.mockRestore();
    }
  });

  it('clears selected message and artifact tasks without cancelling running work or deleting artifacts', async () => {
    const { useMessageStore } = await import('./useMessageStore');
    const { useCharacterArtifactStore } = await import('./useCharacterArtifactStore');
    const statuses = ['failed', 'pending', 'syncing'] as const;
    useMessageStore.setState({ pendingOperations: statuses.map((status) => ({
      id: status, kind: 'delete' as const, chatId: 'chat-1', messageId: 'message-1',
      createdAt: 100, attemptCount: 1, status,
    })) });
    useCharacterArtifactStore.setState({ items: [artifact()], jobs: statuses.map((status) => ({
      id: status, key: status, kind: 'diary' as const, characterId: 'character-1', snapshot: {},
      relatedCharacters: [], status: status === 'syncing' ? 'running' as const : status,
      error: null, attempts: 1, createdAt: 100, updatedAt: 100,
    })) });

    useMessageStore.getState().clearSyncTasks(['failed']);
    useCharacterArtifactStore.getState().clearSyncTasks(['failed']);
    expect(useMessageStore.getState().pendingOperations.map((item) => item.id)).toEqual(['pending', 'syncing']);
    expect(useCharacterArtifactStore.getState().jobs.map((item) => item.id)).toEqual(['pending', 'syncing']);
    useMessageStore.getState().clearSyncTasks([...statuses]);
    useCharacterArtifactStore.getState().clearSyncTasks([...statuses]);
    expect(useMessageStore.getState().pendingOperations.map((item) => item.id)).toEqual(['syncing']);
    expect(useCharacterArtifactStore.getState().jobs.map((item) => item.id)).toEqual(['syncing']);
    expect(useCharacterArtifactStore.getState().items).toEqual([artifact()]);
    const staleMessageTasks = statuses.map((status) => ({
      id: status, kind: 'delete' as const, chatId: 'chat-1', messageId: 'message-1',
      createdAt: 100, attemptCount: 1, status,
    }));
    useMessageStore.setState({ pendingOperations: staleMessageTasks });
    expect(useMessageStore.getState().pendingOperations.map((item) => item.id)).toEqual(['syncing']);
    useCharacterArtifactStore.setState({ jobs: [{
      id: 'failed', key: 'failed', kind: 'diary', characterId: 'character-1', snapshot: {},
      relatedCharacters: [], status: 'failed', error: null, attempts: 1, createdAt: 100, updatedAt: 100,
    }] });
    expect(useCharacterArtifactStore.getState().jobs).toEqual([]);
  });

  describe('missing cloud chat recovery', () => {
    beforeEach(() => {
      vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
      vi.stubGlobal('navigator', { onLine: true });
      localStorage.setItem(storageKey('cloud-sync-enabled'), '1');
    });
    afterEach(() => vi.unstubAllGlobals());

    async function prepare() {
      const { useAuthStore } = await import('./useAuthStore');
      useAuthStore.setState({ authMode: 'cloud', isLoggedIn: true, token: 'token' });
      const { useChatStore } = await import('./useChatStore');
      const { useCharacterStore } = await import('./useCharacterStore');
      useCharacterStore.setState({ characters: [character()] });
      useChatStore.setState({ chats: [chat()], pendingOperations: [], remoteDeletedChatIds: [], remoteDeletedChats: [] });
      apiMocks.createChat.mockResolvedValue(chat());
      return useChatStore;
    }

    it('keeps a complete create when an edit follows it', async () => {
      const store = await prepare();
      store.getState().queuePatch('chat-1', { ...chat() }, 'create');
      store.getState().queuePatch('chat-1', { topic: '离线编辑' });
      await store.getState().flushPendingOperations();
      expect(apiMocks.createChat).toHaveBeenCalledWith(expect.objectContaining({ name: '测试群聊', topic: '离线编辑' }));
      expect(apiMocks.syncChatPatch).not.toHaveBeenCalled();
      expect(store.getState().pendingOperations).toEqual([]);
    });

    it('rebuilds a missing chat and retries the edit with a separate idempotency key', async () => {
      const store = await prepare();
      const { ApiError } = await import('../services/api');
      apiMocks.syncChatPatch.mockRejectedValueOnce(new ApiError('群聊不存在', { status: 404 }));
      store.getState().queuePatch('chat-1', { topic: '本地编辑' });
      const originalId = store.getState().pendingOperations[0].id;
      await store.getState().flushPendingOperations();
      expect(apiMocks.createChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'chat-1', topic: '本地编辑' }));
      expect(apiMocks.syncChatPatch).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ operationId: `${originalId}:recovered` }));
      expect(store.getState().pendingOperations).toEqual([]);
    });

    it('replaces an old terminal failure with a fresh full create', async () => {
      const store = await prepare();
      store.getState().queuePatch('chat-1', { topic: '未上传内容' });
      const original = store.getState().pendingOperations[0];
      store.setState({ pendingOperations: [{ ...original, status: 'failed', lastError: 'conflict_ignored: 群聊不存在' }] });
      expect(store.getState().queueMissingCloudChat('chat-1')).toBe(true);
      expect(store.getState().pendingOperations[0]).toMatchObject({ kind: 'create', status: 'pending', targetLabel: '测试群聊', patch: { topic: '未上传内容' } });
      expect(store.getState().pendingOperations[0].id).not.toBe(original.id);
      await store.getState().flushPendingOperations();
      expect(store.getState().pendingOperations).toEqual([]);
    });

    it('does not automatically restore a chat known to be deleted remotely', async () => {
      const store = await prepare();
      const { ApiError } = await import('../services/api');
      store.setState({ remoteDeletedChatIds: ['chat-1'] });
      expect(store.getState().queueMissingCloudChat('chat-1')).toBe(false);
      store.getState().queuePatch('chat-1', { topic: '冲突编辑' });
      apiMocks.syncChatPatch.mockRejectedValueOnce(new ApiError('群聊不存在', { status: 404 }));
      await store.getState().flushPendingOperations();
      expect(apiMocks.createChat).not.toHaveBeenCalled();
      expect(store.getState().pendingOperations[0].status).toBe('failed');
    });
  });

  it('does not force remote summaries after auth when cloud sync is explicitly disabled', async () => {
    localStorage.setItem(storageKey('cloud-sync-enabled'), '0');
    localStorage.setItem(storageKey('cloud-sync-user-disabled'), '1');
    localStorage.setItem(storageKey('cloud-sync-user-disabled-version'), '2');
    localStorage.setItem(storageKey('user'), JSON.stringify({ id: 'local-user' }));
    const { useAuthStore } = await import('./useAuthStore');

    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(apiMocks.getMe).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(apiMocks.getSyncChanges).not.toHaveBeenCalled();
    expect(apiMocks.getSettings).not.toHaveBeenCalled();
    expect(apiMocks.getChats).not.toHaveBeenCalled();
    expect(apiMocks.getCharacters).not.toHaveBeenCalled();
  });

  it('opens a locally cached message window when cloud sync is explicitly disabled', async () => {
    const accountId = `local-message-user-${Date.now()}-${Math.random()}`;
    const chatId = 'local-message-chat';
    localStorage.setItem(storageKey('cloud-sync-enabled'), '0');
    localStorage.setItem(storageKey('cloud-sync-user-disabled'), '1');
    localStorage.setItem(storageKey('cloud-sync-user-disabled-version'), '2');
    localStorage.setItem(storageKey('user'), JSON.stringify({ id: accountId }));
    localStorage.setItem(storageKey(`messages-${accountId}`), JSON.stringify({
      state: {
        messageWindowsByChatId: {
          [chatId]: {
            messages: [{
              id: 'local-message-1',
              clientKey: 'local-message-1',
              chatId,
              type: 'user',
              senderId: 'user',
              senderName: '我',
              content: '本地缓存消息',
              metadata: {},
              emotion: 0,
              timestamp: 100,
              isDeleted: false,
            }],
            lastSyncedAt: 100,
            updatedAt: 100,
            remoteExhausted: true,
            remoteNewerExhausted: true,
            activeLimit: 40,
          },
        },
        pendingOperations: [],
      },
      version: 5,
    }));
    const { useMessageStore } = await import('./useMessageStore');

    await useMessageStore.getState().openChatWindow(chatId, { limit: 40, revalidate: true });

    expect(useMessageStore.getState().messages.map((message) => message.content)).toEqual(['本地缓存消息']);
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages).toHaveLength(1);
    expect(apiMocks.getMessages).not.toHaveBeenCalled();
  });

  it('shows local chats and characters first when cloud sync is enabled but remote sync is pending', async () => {
    const accountId = `local-first-user-${Date.now()}-${Math.random()}`;
    const { markAccountCloudBootstrapReady } = await import('../services/accountCloudBootstrap');
    markAccountCloudBootstrapReady(accountId);
    apiMocks.getMe.mockResolvedValueOnce({
      id: accountId,
      phone: '13500000000',
      nickname: '测试用户',
      avatar: '🍵',
      cloudSyncEntitled: true,
    });
    localStorage.setItem(storageKey('user'), JSON.stringify({ id: accountId }));
    localStorage.setItem(storageKey(`chats-${accountId}`), JSON.stringify({
      state: {
        chats: [chat({ id: 'local-chat-first', name: '先显示本地会话' })],
        currentChatId: null,
        lastSyncedAt: 12,
        pendingOperations: [],
      },
      version: 5,
    }));
    localStorage.setItem(storageKey(`characters-${accountId}`), JSON.stringify({
      state: {
        characters: [character({ id: 'local-character-first', name: '先显示本地角色' })],
        lastSyncedAt: 12,
        pendingOperations: [],
      },
      version: 5,
    }));
    let resolveChanges: (value: unknown) => void = () => undefined;
    apiMocks.getSyncChanges.mockImplementation(() => new Promise((resolve) => {
      resolveChanges = resolve;
    }));
    const [{ useAuthStore }, { useChatStore }, { useCharacterStore }, { getLocalDataUserId }] = await Promise.all([
      import('./useAuthStore'),
      import('./useChatStore'),
      import('./useCharacterStore'),
      import('../services/authStorageScope'),
    ]);

    expect(getLocalDataUserId()).toBe(accountId);
    await useAuthStore.getState().checkAuth();

    await vi.waitFor(() => {
      expect(useChatStore.getState().chats.map((item) => item.name)).toEqual(['先显示本地会话']);
      expect(useCharacterStore.getState().characters.map((item) => item.name)).toEqual(['先显示本地角色']);
    }, { timeout: 5000 });
    expect(apiMocks.getChats).not.toHaveBeenCalled();
    expect(apiMocks.getCharacters).not.toHaveBeenCalled();

    resolveChanges({
      status: 'not_modified',
      cursor: 'rev-1',
      revision: 'rev-1',
      changes: [],
    });
  });

  it('uses the signed-in account local scope without mixing guest data when cloud sync is disabled before login', async () => {
    const accountId = `disabled-sync-account-${Date.now()}-${Math.random()}`;
    apiMocks.login.mockResolvedValueOnce({
      token: 'token',
      refreshToken: 'refresh-token',
      user: {
        id: accountId,
        phone: '13500000000',
        nickname: '测试用户',
        avatar: '🍵',
        cloudSyncEntitled: true,
      },
    });
    localStorage.setItem(storageKey('auth-mode'), 'local');
    localStorage.setItem(storageKey('cloud-sync-enabled'), '0');
    localStorage.setItem(storageKey('cloud-sync-user-disabled'), '1');
    localStorage.setItem(storageKey('cloud-sync-user-disabled-version'), '2');
    localStorage.setItem(storageKey('chats-guest'), JSON.stringify({
      state: {
        chats: [chat({ id: 'guest-chat-disabled-sync', name: '未登录本地会话' })],
        currentChatId: null,
        lastSyncedAt: 12,
        pendingOperations: [],
      },
      version: 3,
    }));
    localStorage.setItem(storageKey('characters-guest'), JSON.stringify({
      state: {
        characters: [character({ id: 'guest-character-disabled-sync', name: '未登录本地角色' })],
        lastSyncedAt: 12,
        pendingOperations: [],
      },
      version: 3,
    }));
    localStorage.setItem(storageKey(`chats-${accountId}`), JSON.stringify({
      state: {
        chats: [chat({ id: 'account-chat-disabled-sync', name: '账号本地会话' })],
        currentChatId: null,
        lastSyncedAt: 12,
        pendingOperations: [],
      },
      version: 3,
    }));
    localStorage.setItem(storageKey(`characters-${accountId}`), JSON.stringify({
      state: {
        characters: [character({ id: 'account-character-disabled-sync', name: '账号本地角色' })],
        lastSyncedAt: 12,
        pendingOperations: [],
      },
      version: 3,
    }));
    const [{ useAuthStore }, { useChatStore }, { useCharacterStore }] = await Promise.all([
      import('./useAuthStore'),
      import('./useChatStore'),
      import('./useCharacterStore'),
    ]);

    await useAuthStore.getState().login('13500000000', '123456');

    expect(apiMocks.login).toHaveBeenCalledTimes(1);
    expect(apiMocks.getCharacters).not.toHaveBeenCalled();
    expect(apiMocks.getChats).not.toHaveBeenCalled();
    expect(apiMocks.getSyncChanges).not.toHaveBeenCalled();
    expect(useChatStore.getState().chats.map((item) => item.name)).toEqual(['账号本地会话']);
    expect(useCharacterStore.getState().characters.map((item) => item.name)).toEqual(['账号本地角色']);
  });

  it('prefetches chats from local persistence when cloud sync is disabled', async () => {
    const localUserId = `local-chat-prefetch-user-${Date.now()}-${Math.random()}`;
    localStorage.setItem(storageKey('cloud-sync-enabled'), '0');
    localStorage.setItem(storageKey('cloud-sync-user-disabled'), '1');
    localStorage.setItem(storageKey('cloud-sync-user-disabled-version'), '2');
    localStorage.setItem(storageKey('user'), JSON.stringify({ id: localUserId }));
    localStorage.setItem(storageKey(`chats-${localUserId}`), JSON.stringify({
      state: {
        chats: [chat({ id: 'local-chat', name: '本地会话' })],
        currentChatId: null,
        lastSyncedAt: 12,
        pendingOperations: [],
      },
      version: 3,
    }));
    const { useChatStore } = await import('./useChatStore');

    useChatStore.getState().markChatsWarm();
    await useChatStore.getState().prefetchChats();

    expect(useChatStore.getState().chats.map((item) => item.name)).toEqual(['本地会话']);
    expect(apiMocks.getSyncChanges).not.toHaveBeenCalled();
    expect(apiMocks.getChats).not.toHaveBeenCalled();
  });

  it('does not rewrite chats or fetch chat summaries when the remote scope is not modified', async () => {
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat()],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      chatSummaryLoadedAt: 1,
      isLoading: false,
    });
    let writes = 0;
    const unsubscribe = useChatStore.subscribe(() => {
      writes += 1;
    });

    await useChatStore.getState().loadChats({ waitForCloud: true });

    unsubscribe();
    expect(writes).toBe(0);
    expect(apiMocks.getSyncChanges).toHaveBeenCalledWith({ scope: 'chats.summary', since: null });
    expect(apiMocks.getChats).not.toHaveBeenCalled();
    expect(apiMocks.getDeletedChats).not.toHaveBeenCalled();
  });

  it('does not rewrite chats when marking an already projected chat list warm', async () => {
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat()],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });
    let writes = 0;
    const unsubscribe = useChatStore.subscribe(() => {
      writes += 1;
    });

    useChatStore.getState().markChatsWarm();

    unsubscribe();
    expect(writes).toBe(0);
  });

  it('awaits forced chat summary refresh until loadChats completes', async () => {
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    let resolveProbe: (value: unknown) => void = () => {};
    apiMocks.getSyncChanges.mockReturnValueOnce(new Promise((resolve) => {
      resolveProbe = resolve;
    }));
    useChatStore.setState({
      chats: [],
      currentChatId: null,
      lastSyncedAt: 0,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      chatSummaryLoadedAt: 0,
      isLoading: false,
    });

    let settled = false;
    const refresh = useChatStore.getState().refreshChatSummaryFromCloud().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    resolveProbe({
      status: 'modified',
      cursor: 'chats.summary:rev-2',
      revision: 'chats.summary:rev-2',
      hasMore: false,
      changes: [{
        op: 'upsert',
        entity: 'chat_summary',
        id: 'chat-1',
        revision: 2,
        patch: chat({ updatedAt: 2, lastMessageAt: 2 }),
      }],
    });
    await refresh;

    expect(settled).toBe(true);
    expect(useChatStore.getState().chats.map((item) => item.id)).toEqual(['chat-1']);
  });

  it('merges chat summary changes without clearing loaded chat runtime details', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified',
      cursor: 'chats.summary:rev-2',
      revision: 'chats.summary:rev-2',
      changes: [{
        op: 'upsert',
        entity: 'chat_summary',
        id: 'chat-1',
        revision: 2,
        patch: {
          id: 'chat-1',
          type: 'group',
          mode: 'open_chat',
          name: '测试群聊新版',
          topic: '测试主题',
          style: 'free',
          runtimeEvolutionIntensity: 'balanced',
          memberIds: ['character-1'],
          sourceChatId: null,
          sourceMemberIds: [],
          speed: 1,
          isActive: true,
          allowIntervention: true,
          showRoleActions: true,
          topicSeed: '',
          deletedAt: null,
          fieldVersions: {},
          createdAt: 1,
          updatedAt: 2,
          lastMessageAt: 2,
          worldState: DEFAULT_CONVERSATION_WORLD_STATE,
          runtimeDetailLoaded: false,
          latestMessage: {
            id: 'message-2',
            chatId: 'chat-1',
            type: 'ai',
            senderId: 'character-1',
            senderName: '小甲',
            content: '最新摘要消息',
            emotion: 60,
            timestamp: 2,
            isDeleted: false,
          },
        },
      }],
    });
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        name: '测试群聊',
        runtimeDetailLoaded: true,
        runtimeSeed: { notes: ['完整前情'], artifacts: ['完整产物'] },
        layeredMemories: [{ id: 'memory-1', scope: 'conversation', layer: 'long_term', kind: 'artifact', ownerId: 'chat-1', text: '完整会话记忆', salience: 0.7, confidence: 0.7, recency: 0.7, reinforcementCount: 1, sourceEventIds: [], createdAt: 1, updatedAt: 1 }],
        runtimeTimeline: [{ type: 'note', text: '完整时间线', createdAt: 1 }],
        updatedAt: 1,
        lastMessageAt: 1,
      })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    await useChatStore.getState().loadChats({ waitForCloud: true });

    const merged = useChatStore.getState().chats[0];
    expect(merged.name).toBe('测试群聊新版');
    expect(merged.updatedAt).toBe(2);
    expect(merged.lastMessageAt).toBe(2);
    expect(merged.latestMessage?.content).toBe('最新摘要消息');
    expect(merged.runtimeDetailLoaded).toBe(true);
    expect(merged.runtimeSeed?.notes).toEqual(['完整前情']);
    expect(merged.layeredMemories?.[0]?.text).toBe('完整会话记忆');
    expect(merged.runtimeTimeline?.[0]?.text).toBe('完整时间线');
    expect(apiMocks.getChats).not.toHaveBeenCalled();
  });

  it('treats chat summary changes without runtime detail flags as summaries', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified',
      cursor: 'chats.summary:rev-2',
      revision: 'chats.summary:rev-2',
      changes: [{
        op: 'upsert',
        entity: 'chat_summary',
        id: 'chat-1',
        revision: 2,
        patch: {
          id: 'chat-1',
          type: 'group',
          mode: 'open_chat',
          name: '缺标记摘要新版',
          topic: '测试主题',
          style: 'free',
          runtimeEvolutionIntensity: 'balanced',
          memberIds: ['character-1'],
          sourceChatId: null,
          sourceMemberIds: [],
          speed: 1,
          isActive: true,
          allowIntervention: true,
          showRoleActions: true,
          topicSeed: '',
          deletedAt: null,
          fieldVersions: {},
          createdAt: 1,
          updatedAt: 2,
          lastMessageAt: 2,
          latestMessage: {
            id: 'message-2',
            chatId: 'chat-1',
            type: 'ai',
            senderId: 'character-1',
            senderName: '小甲',
            content: '最新摘要消息',
            emotion: 60,
            timestamp: 2,
            isDeleted: false,
          },
        },
      }],
    });
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        name: '测试群聊',
        runtimeDetailLoaded: true,
        runtimeSeed: { notes: ['本地完整前情'], artifacts: [] },
        relationshipLedger: [{
          pairKey: 'character-1:character-2',
          actorId: 'character-1',
          targetId: 'character-2',
          current: { warmth: 10, trust: 20, competence: 0, threat: 0 },
          trend: 'flat',
          lastUpdatedAt: 1,
          recentEvents: [],
        }],
        runtimeEventsV2: [{ id: 'event-1', conversationId: 'chat-1', kind: 'room_shift', createdAt: 1, summary: '本地运行事件', payload: {} }],
        updatedAt: 1,
        lastMessageAt: 1,
      })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    await useChatStore.getState().loadChats({ waitForCloud: true });

    const merged = useChatStore.getState().chats[0];
    expect(merged.name).toBe('缺标记摘要新版');
    expect(merged.runtimeDetailLoaded).toBe(true);
    expect(merged.runtimeSeed?.notes).toEqual(['本地完整前情']);
    expect(merged.relationshipLedger?.[0]?.pairKey).toBe('character-1:character-2');
    expect(merged.runtimeEventsV2?.[0]?.summary).toBe('本地运行事件');
  });

  it('keeps pending chat fields projected over newer remote field versions', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified',
      cursor: 'chats.summary:rev-2',
      revision: 'chats.summary:rev-2',
      changes: [{
        op: 'upsert',
        entity: 'chat_summary',
        id: 'chat-1',
        revision: 2,
        patch: chat({
          id: 'chat-1',
          name: '云端群聊名',
          fieldVersions: { name: 200 },
          updatedAt: 200,
          lastMessageAt: 200,
          runtimeDetailLoaded: false,
        }),
      }],
    });
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        id: 'chat-1',
        name: '本地群聊名',
        fieldVersions: { name: 1 },
        updatedAt: 1,
        lastMessageAt: 1,
      })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [{
        id: 'op-chat-name',
        entityId: 'chat-1',
        kind: 'patch',
        targetIds: ['chat-1'],
        clientTimestamp: 100,
        patch: { name: '本地待同步群聊名' },
        status: 'pending',
        attemptCount: 0,
      }],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    await useChatStore.getState().loadChats({ waitForCloud: true });

    const merged = useChatStore.getState().chats[0];
    expect(merged.name).toBe('本地待同步群聊名');
    expect(merged.updatedAt).toBe(200);
    expect(merged.fieldVersions?.name).toBe(200);
    expect(useChatStore.getState().pendingOperations).toHaveLength(1);
    expect(apiMocks.getChats).not.toHaveBeenCalled();
  });

  it('fills older chat details without rolling back newer local summary fields', async () => {
    apiMocks.getChat.mockResolvedValueOnce(chat({
      id: 'chat-1',
      name: '旧远端群聊名',
      topic: '旧远端主题',
      runtimeDetailLoaded: true,
      runtimeSeed: { notes: ['远端详情前情'], artifacts: [] },
      fieldVersions: { name: 1, topic: 1 },
      updatedAt: 1,
      lastMessageAt: 1,
    }));
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        id: 'chat-1',
        name: '本地较新群聊名',
        topic: '本地较新主题',
        runtimeDetailLoaded: false,
        runtimeSeed: { notes: [], artifacts: [] },
        fieldVersions: { name: 200, topic: 200 },
        updatedAt: 200,
        lastMessageAt: 200,
      })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    const loaded = await useChatStore.getState().loadChat('chat-1');

    const merged = useChatStore.getState().chats[0];
    expect(loaded?.name).toBe('本地较新群聊名');
    expect(merged.name).toBe('本地较新群聊名');
    expect(merged.topic).toBe('本地较新主题');
    expect(merged.runtimeDetailLoaded).toBe(true);
    expect(merged.runtimeSeed?.notes).toEqual(['远端详情前情']);
    expect(merged.updatedAt).toBe(200);
    expect(merged.fieldVersions?.name).toBe(200);
  });

  it('does not treat summary-only chats as fully loaded', async () => {
    apiMocks.getChat.mockResolvedValueOnce(chat({
      id: 'chat-1',
      name: '云端详情群聊名',
      topic: '云端详情主题',
      runtimeDetailLoaded: true,
      runtimeSeed: { notes: ['云端详情前情'], artifacts: [] },
      updatedAt: 1,
      lastMessageAt: 1,
    }));
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        id: 'chat-1',
        name: '摘要群聊名',
        topic: '摘要主题',
        runtimeDetailLoaded: false,
        runtimeSeed: { notes: [], artifacts: [] },
        updatedAt: 1,
        lastMessageAt: 1,
      })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    expect(useChatStore.getState().hasChatLoaded('chat-1')).toBe(false);

    await useChatStore.getState().loadChat('chat-1');

    const merged = useChatStore.getState().chats[0];
    expect(apiMocks.getChat).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().hasChatLoaded('chat-1')).toBe(true);
    expect(merged.name).toBe('摘要群聊名');
    expect(merged.topic).toBe('摘要主题');
    expect(merged.runtimeSeed?.notes).toEqual(['云端详情前情']);
  });

  it('does not refetch an already hydrated empty chat detail within the refresh ttl', async () => {
    apiMocks.getChat.mockResolvedValue(chat({
      id: 'chat-1',
      name: '空运行态群聊',
      topic: '',
      runtimeDetailLoaded: true,
      runtimeSeed: { notes: [], artifacts: [] },
      layeredMemories: [],
      runtimeTimeline: [],
      runtimeEventsV2: [],
      relationshipLedger: [],
      updatedAt: 1,
      lastMessageAt: 1,
    }));
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        id: 'chat-1',
        name: '摘要群聊名',
        topic: '',
        runtimeDetailLoaded: false,
        runtimeSeed: { notes: [], artifacts: [] },
        layeredMemories: [],
        runtimeTimeline: [],
        runtimeEventsV2: [],
        relationshipLedger: [],
        updatedAt: 1,
        lastMessageAt: 1,
      })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    await useChatStore.getState().loadChat('chat-1');
    await useChatStore.getState().loadChat('chat-1');

    const merged = useChatStore.getState().chats[0];
    expect(apiMocks.getChat).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().hasChatLoaded('chat-1')).toBe(true);
    expect(merged.runtimeDetailLoaded).toBe(true);
    expect(merged.runtimeDetailHydratedAt).toBeGreaterThan(0);
  });

  it('rechecks chats that were incorrectly marked loaded by legacy summary data', async () => {
    apiMocks.getChat.mockResolvedValueOnce(chat({
      id: 'chat-1',
      name: '云端完整群聊',
      runtimeDetailLoaded: true,
      runtimeSeed: { notes: ['重新拉取的完整前情'], artifacts: [] },
      updatedAt: 1,
      lastMessageAt: 1,
    }));
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        id: 'chat-1',
        name: '旧摘要群聊',
        runtimeDetailLoaded: true,
        runtimeSeed: { notes: [], artifacts: [] },
        layeredMemories: [],
        runtimeTimeline: [],
        runtimeEventsV2: [],
        relationshipLedger: [],
        updatedAt: 1,
        lastMessageAt: 1,
      })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    expect(useChatStore.getState().hasChatLoaded('chat-1')).toBe(false);

    await useChatStore.getState().loadChat('chat-1');

    expect(apiMocks.getChat).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().chats[0]?.runtimeSeed?.notes).toEqual(['重新拉取的完整前情']);
  });

  it('keeps local chat details when cloud detail is missing', async () => {
    apiMocks.getChat.mockRejectedValueOnce(Object.assign(new Error('Not Found'), {
      name: 'ApiError',
      status: 404,
      code: 'NOT_FOUND',
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        id: 'local-chat-1',
        name: '本地会话',
        topic: '本地主题',
        runtimeDetailLoaded: false,
        updatedAt: 200,
        lastMessageAt: 200,
      })],
      currentChatId: 'local-chat-1',
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    const loaded = await useChatStore.getState().loadChat('local-chat-1');
    const loadedAgain = await useChatStore.getState().loadChat('local-chat-1');

    expect(loaded?.name).toBe('本地会话');
    expect(loadedAgain?.name).toBe('本地会话');
    expect(apiMocks.getChat).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[recoverable-warning] cloud-sync:chat-detail-load'), expect.anything());
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('[recoverable] cloud-sync:chat-detail-load'), expect.anything());
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('hydrates character summaries from chat detail changes', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified',
      cursor: 'chats.detail:chat-1:rev-2',
      revision: 'chats.detail:chat-1:rev-2',
      changes: [{
        op: 'upsert',
        entity: 'chat_detail',
        id: 'chat-1',
        revision: 2,
        patch: {
          ...chat({
            id: 'chat-1',
            runtimeDetailLoaded: true,
            updatedAt: 2,
            lastMessageAt: 2,
          }),
          memberCharacterSummaries: [{
            id: 'character-1',
            name: '小甲摘要',
            avatar: '',
            personality: { openness: 60, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
            expertise: ['测试'],
            speakingStyle: '新摘要说话方式',
            background: '新摘要背景',
            bubbleStyleId: 'bubble-1',
            bubbleStyle: { id: 'bubble-1', name: '测试气泡', palette: { primary: '#fff', secondary: '#000', accent: '#999', text: '#111', mutedText: '#666', border: '#222', userBubble: '#333', aiBubble: '#444', userText: '#fff', aiText: '#111', shadow: 'rgba(0,0,0,0.2)' } },
            isPreset: false,
            createdAt: 1,
            updatedAt: 2,
          }],
        },
      }],
    });
    const { useChatStore } = await import('./useChatStore');
    const { useCharacterStore } = await import('./useCharacterStore');
    await useChatStore.persist.rehydrate();
    await useCharacterStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({ id: 'chat-1', runtimeDetailLoaded: true, updatedAt: 1, lastMessageAt: 1 })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });
    useCharacterStore.setState({
      characters: [],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    await useChatStore.getState().loadChat('chat-1');

    const hydrated = useCharacterStore.getState().characters.find((item) => item.id === 'character-1');
    expect(hydrated?.name).toBe('小甲摘要');
    expect(hydrated?.bubbleStyleId).toBe('bubble-1');
  });

  it('preserves member character summaries when older local summary fields win', async () => {
    apiMocks.getChat.mockResolvedValueOnce(chat({
      id: 'chat-1',
      name: '旧远端群聊名',
      topic: '旧远端主题',
      runtimeDetailLoaded: true,
      memberCharacterSummaries: [{
        id: 'character-1',
        name: '小甲摘要',
        avatar: '',
        personality: { openness: 60, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
        expertise: ['测试'],
        speakingStyle: '摘要说话方式',
        background: '摘要背景',
        bubbleStyleId: 'bubble-1',
        bubbleStyle: null,
        isPreset: false,
        createdAt: 1,
        updatedAt: 2,
      }],
      runtimeSeed: { notes: ['远端详情前情'], artifacts: [] },
      fieldVersions: { name: 1, topic: 1 },
      updatedAt: 1,
      lastMessageAt: 1,
    }));
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({
        id: 'chat-1',
        name: '本地较新群聊名',
        topic: '本地较新主题',
        runtimeDetailLoaded: false,
        memberCharacterSummaries: [],
        runtimeSeed: { notes: [], artifacts: [] },
        fieldVersions: { name: 200, topic: 200 },
        updatedAt: 200,
        lastMessageAt: 200,
      })],
      currentChatId: null,
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      isLoading: false,
    });

    await useChatStore.getState().loadChat('chat-1');

    const merged = useChatStore.getState().chats[0];
    expect(merged.name).toBe('本地较新群聊名');
    expect(merged.topic).toBe('本地较新主题');
    expect(merged.runtimeDetailLoaded).toBe(true);
    expect(merged.memberCharacterSummaries?.[0]?.id).toBe('character-1');
    expect(merged.memberCharacterSummaries?.[0]?.bubbleStyleId).toBe('bubble-1');
  });

  it('resolves chat remote-delete conflicts by discarding or restoring local edits', async () => {
    const { useChatStore } = await import('./useChatStore');
    await useChatStore.persist.rehydrate();
    useChatStore.setState({
      chats: [chat({ id: 'chat-1', name: '本地待保留群聊' })],
      currentChatId: 'chat-1',
      lastSyncedAt: 1,
      pendingOperations: [{
        id: 'op-chat-topic',
        entityId: 'chat-1',
        kind: 'patch',
        targetIds: ['chat-1'],
        clientTimestamp: 100,
        patch: { topic: '本地未同步主题' },
        status: 'pending',
        attemptCount: 0,
      }],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedChatIds: ['chat-1'],
      remoteDeletedChats: [chat({ id: 'chat-1', deletedAt: 200 })],
      isLoading: false,
    });

    await useChatStore.getState().resolveRemoteDeleteConflict('chat-1', 'restore_local');

    expect(useChatStore.getState().remoteDeletedChatIds).toEqual([]);
    expect(useChatStore.getState().pendingOperations.some((operation) => operation.patch.deletedAt === null)).toBe(true);
    expect(useChatStore.getState().chats.some((item) => item.id === 'chat-1')).toBe(true);

    useChatStore.setState({
      chats: [chat({ id: 'chat-2', name: '本地要放弃群聊' })],
      currentChatId: 'chat-2',
      pendingOperations: [{
        id: 'op-chat-name',
        entityId: 'chat-2',
        kind: 'patch',
        targetIds: ['chat-2'],
        clientTimestamp: 120,
        patch: { name: '本地未同步名称' },
        status: 'pending',
        attemptCount: 0,
      }],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedChatIds: ['chat-2'],
      remoteDeletedChats: [chat({ id: 'chat-2', deletedAt: 220 })],
    });

    await useChatStore.getState().resolveRemoteDeleteConflict('chat-2', 'discard_local');

    expect(useChatStore.getState().chats.some((item) => item.id === 'chat-2')).toBe(false);
    expect(useChatStore.getState().pendingOperations.some((operation) => operation.entityId === 'chat-2')).toBe(false);
    expect(useChatStore.getState().remoteDeletedChatIds).toEqual([]);
    expect(useChatStore.getState().currentChatId).toBeNull();

    useChatStore.setState({
      chats: [chat({ id: 'chat-3', name: '本地另存群聊', topic: '本地主题' })],
      currentChatId: 'chat-3',
      pendingOperations: [{
        id: 'op-chat-copy',
        entityId: 'chat-3',
        kind: 'patch',
        targetIds: ['chat-3'],
        clientTimestamp: 130,
        patch: { topic: '本地另存主题' },
        status: 'pending',
        attemptCount: 0,
      }],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedChatIds: ['chat-3'],
      remoteDeletedChats: [chat({ id: 'chat-3', deletedAt: 230 })],
    });

    await useChatStore.getState().resolveRemoteDeleteConflict('chat-3', 'save_as_new');

    const chatState = useChatStore.getState();
    const copiedChat = chatState.chats.find((item) => item.sourceChatId === 'chat-3');
    expect(chatState.chats.some((item) => item.id === 'chat-3')).toBe(false);
    expect(copiedChat?.name).toContain('本地另存群聊');
    expect(copiedChat?.name).toContain('本地副本');
    expect(chatState.pendingOperations.some((operation) => operation.entityId === 'chat-3')).toBe(false);
    expect(chatState.pendingOperations.some((operation) => operation.kind === 'create' && operation.entityId === copiedChat?.id)).toBe(true);
    expect(chatState.remoteDeletedChatIds).toEqual([]);
  });

  it('prefetches characters from local persistence when cloud sync is disabled', async () => {
    const localUserId = `local-character-prefetch-user-${Date.now()}-${Math.random()}`;
    localStorage.setItem(storageKey('cloud-sync-enabled'), '0');
    localStorage.setItem(storageKey('cloud-sync-user-disabled'), '1');
    localStorage.setItem(storageKey('cloud-sync-user-disabled-version'), '2');
    localStorage.setItem(storageKey('user'), JSON.stringify({ id: localUserId }));
    localStorage.setItem(storageKey(`characters-${localUserId}`), JSON.stringify({
      state: {
        characters: [character({ id: 'local-character', name: '本地角色' })],
        lastSyncedAt: 12,
        pendingOperations: [],
      },
      version: 3,
    }));
    const { useCharacterStore } = await import('./useCharacterStore');

    useCharacterStore.getState().markCharactersWarm();
    await useCharacterStore.getState().prefetchCharacters();

    expect(useCharacterStore.getState().characters.map((item) => item.name)).toEqual(['本地角色']);
    expect(apiMocks.getSyncChanges).not.toHaveBeenCalled();
    expect(apiMocks.getCharacters).not.toHaveBeenCalled();
  });

  it('does not rewrite characters or fetch character summaries when the remote scope is not modified', async () => {
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character()],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });
    let writes = 0;
    const unsubscribe = useCharacterStore.subscribe(() => {
      writes += 1;
    });

    await useCharacterStore.getState().loadCharacters();

    unsubscribe();
    expect(writes).toBe(0);
    expect(apiMocks.getSyncChanges).toHaveBeenCalledWith({ scope: 'characters.summary', since: null });
    expect(apiMocks.getCharacters).not.toHaveBeenCalled();
    expect(apiMocks.getDeletedCharacters).not.toHaveBeenCalled();
  });

  it('does not rewrite characters when marking an already projected character list warm', async () => {
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character()],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });
    let writes = 0;
    const unsubscribe = useCharacterStore.subscribe(() => {
      writes += 1;
    });

    useCharacterStore.getState().markCharactersWarm();

    unsubscribe();
    expect(writes).toBe(0);
  });

  it('merges character summary changes without clearing loaded character details', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified',
      cursor: 'characters.summary:rev-2',
      revision: 'characters.summary:rev-2',
      changes: [{
        op: 'upsert',
        entity: 'character_summary',
        id: 'character-1',
        revision: 2,
        patch: {
          id: 'character-1',
          name: '小甲新版',
          avatar: '',
          personality: { openness: 70, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
          expertise: ['测试'],
          group: null,
          bubbleStyleId: null,
          bubbleStyle: null,
          isPreset: false,
          deletedAt: null,
          fieldVersions: {},
          createdAt: 1,
          updatedAt: 2,
          characterDetailLoaded: false,
        },
      }],
    });
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character({
        name: '小甲',
        background: '完整背景不能被摘要覆盖',
        speakingStyle: '完整说话方式',
        layeredMemories: [{ id: 'memory-1', scope: 'character_self', layer: 'long_term', kind: 'trait_evidence', ownerId: 'character-1', text: '完整记忆', salience: 0.7, confidence: 0.7, recency: 0.7, reinforcementCount: 1, sourceEventIds: [], createdAt: 1, updatedAt: 1 }],
        characterDetailLoaded: true,
        updatedAt: 1,
      })],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    await useCharacterStore.getState().loadCharacters();

    const merged = useCharacterStore.getState().characters[0];
    expect(merged.name).toBe('小甲新版');
    expect(merged.updatedAt).toBe(2);
    expect(merged.characterDetailLoaded).toBe(true);
    expect(merged.background).toBe('完整背景不能被摘要覆盖');
    expect(merged.speakingStyle).toBe('完整说话方式');
    expect(merged.layeredMemories?.[0]?.text).toBe('完整记忆');
    expect(apiMocks.getCharacters).not.toHaveBeenCalled();
  });

  it('treats character summary changes without detail flags as summaries', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified',
      cursor: 'characters.summary:rev-2',
      revision: 'characters.summary:rev-2',
      changes: [{
        op: 'upsert',
        entity: 'character_summary',
        id: 'character-1',
        revision: 2,
        patch: {
          id: 'character-1',
          name: '小甲摘要新版',
          avatar: '',
          personality: { openness: 70, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
          expertise: ['测试'],
          group: null,
          bubbleStyleId: null,
          bubbleStyle: null,
          isPreset: false,
          deletedAt: null,
          fieldVersions: {},
          createdAt: 1,
          updatedAt: 2,
        },
      }],
    });
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character({
        name: '小甲',
        background: '本地完整背景',
        speakingStyle: '本地完整说话方式',
        relationships: [{ characterId: 'character-2', note: '旧关系', warmth: 10, trust: 20, competence: 0, threat: 0 }],
        memory: { longTerm: ['旧记忆'], shortTermSummary: '短期摘要', secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
        characterDetailLoaded: true,
        updatedAt: 1,
      })],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    await useCharacterStore.getState().loadCharacters();

    const merged = useCharacterStore.getState().characters[0];
    expect(merged.name).toBe('小甲摘要新版');
    expect(merged.characterDetailLoaded).toBe(true);
    expect(merged.background).toBe('本地完整背景');
    expect(merged.speakingStyle).toBe('本地完整说话方式');
    expect(merged.relationships?.[0]?.note).toBe('旧关系');
    expect(merged.memory?.longTerm).toEqual(['旧记忆']);
  });

  it('keeps pending character fields projected over newer remote field versions', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified',
      cursor: 'characters.summary:rev-2',
      revision: 'characters.summary:rev-2',
      changes: [{
        op: 'upsert',
        entity: 'character_summary',
        id: 'character-1',
        revision: 2,
        patch: {
          ...character({
            id: 'character-1',
            name: '云端角色名',
            fieldVersions: { name: 200 },
            updatedAt: 200,
            characterDetailLoaded: false,
          }),
          bubbleStyleId: null,
          bubbleStyle: null,
        },
      }],
    });
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character({
        id: 'character-1',
        name: '本地角色名',
        fieldVersions: { name: 1 },
        updatedAt: 1,
      })],
      lastSyncedAt: 1,
      pendingOperations: [{
        id: 'op-character-name',
        entityId: 'character-1',
        kind: 'patch',
        targetIds: ['character-1'],
        clientTimestamp: 100,
        patch: { name: '本地待同步角色名' },
        status: 'pending',
        attemptCount: 0,
      }],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    await useCharacterStore.getState().loadCharacters();

    const merged = useCharacterStore.getState().characters[0];
    expect(merged.name).toBe('本地待同步角色名');
    expect(merged.updatedAt).toBe(200);
    expect(merged.fieldVersions?.name).toBe(200);
    expect(useCharacterStore.getState().pendingOperations).toHaveLength(1);
    expect(apiMocks.getCharacters).not.toHaveBeenCalled();
  });

  it('fills older character details without rolling back newer local summary fields', async () => {
    apiMocks.getCharacter.mockResolvedValueOnce(character({
      id: 'character-1',
      name: '旧远端角色名',
      background: '远端详情背景',
      speakingStyle: '远端详情说话方式',
      characterDetailLoaded: true,
      fieldVersions: { name: 1 },
      updatedAt: 1,
    }));
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character({
        id: 'character-1',
        name: '本地较新角色名',
        background: '',
        speakingStyle: '',
        characterDetailLoaded: false,
        fieldVersions: { name: 200 },
        updatedAt: 200,
      })],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    const loaded = await useCharacterStore.getState().loadCharacter('character-1');

    const merged = useCharacterStore.getState().characters[0];
    expect(loaded?.name).toBe('本地较新角色名');
    expect(merged.name).toBe('本地较新角色名');
    expect(merged.background).toBe('远端详情背景');
    expect(merged.speakingStyle).toBe('远端详情说话方式');
    expect(merged.characterDetailLoaded).toBe(true);
    expect(merged.updatedAt).toBe(200);
    expect(merged.fieldVersions?.name).toBe(200);
  });

  it('does not treat summary-only characters as fully loaded', async () => {
    apiMocks.getCharacter.mockResolvedValueOnce(character({
      id: 'character-1',
      name: '云端详情角色名',
      background: '云端详情背景',
      speakingStyle: '云端详情说话方式',
      characterDetailLoaded: true,
      updatedAt: 1,
    }));
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character({
        id: 'character-1',
        name: '摘要角色名',
        background: '',
        speakingStyle: '',
        characterDetailLoaded: false,
        updatedAt: 1,
      })],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    expect(useCharacterStore.getState().hasCharacterLoaded('character-1')).toBe(false);

    await useCharacterStore.getState().loadCharacter('character-1');

    const merged = useCharacterStore.getState().characters[0];
    expect(apiMocks.getCharacter).toHaveBeenCalledTimes(1);
    expect(useCharacterStore.getState().hasCharacterLoaded('character-1')).toBe(true);
    expect(merged.name).toBe('摘要角色名');
    expect(merged.background).toBe('云端详情背景');
    expect(merged.speakingStyle).toBe('云端详情说话方式');
  });

  it('keeps local character details when cloud detail fetch fails', async () => {
    apiMocks.getCharacter.mockRejectedValueOnce(Object.assign(new Error('Not Found'), {
      name: 'ApiError',
      status: 404,
      code: 'NOT_FOUND',
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character({
        id: 'local-character-1',
        name: '本地角色',
        background: '本地背景',
        speakingStyle: '本地说话方式',
        characterDetailLoaded: false,
        updatedAt: 200,
      })],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    const loaded = await useCharacterStore.getState().loadCharacter('local-character-1');
    const loadedAgain = await useCharacterStore.getState().loadCharacter('local-character-1');

    expect(loaded?.name).toBe('本地角色');
    expect(loadedAgain?.name).toBe('本地角色');
    expect(loaded?.background).toBe('本地背景');
    expect(useCharacterStore.getState().characters[0]?.name).toBe('本地角色');
    expect(apiMocks.getCharacter).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[recoverable-warning] cloud-sync:character-detail-load'), expect.anything());
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('[recoverable] cloud-sync:character-detail-load'), expect.anything());
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('does not fetch cloud details for preset characters', async () => {
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character({
        id: 'preset-critic',
        name: '预设评论家',
        isPreset: true,
        characterDetailLoaded: false,
      })],
      lastSyncedAt: 1,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    const loaded = await useCharacterStore.getState().loadCharacter('preset-critic');

    expect(loaded?.name).toBe('预设评论家');
    expect(apiMocks.getCharacter).not.toHaveBeenCalled();
    expect(apiMocks.getSyncChanges).not.toHaveBeenCalledWith(expect.objectContaining({ scope: 'characters.detail:preset-critic' }));
  });

  it('awaits forced character summary refresh until loadCharacters completes', async () => {
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    let resolveProbe: (value: unknown) => void = () => {};
    apiMocks.getSyncChanges.mockReturnValueOnce(new Promise((resolve) => {
      resolveProbe = resolve;
    }));
    useCharacterStore.setState({
      characters: [],
      lastSyncedAt: 0,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: [],
      isLoading: false,
    });

    let settled = false;
    const refresh = useCharacterStore.getState().refreshCharacterSummaryFromCloud().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    resolveProbe({
      status: 'modified',
      cursor: 'characters.summary:rev-2',
      revision: 'characters.summary:rev-2',
      hasMore: false,
      changes: [{
        op: 'upsert',
        entity: 'character_summary',
        id: 'character-1',
        revision: 2,
        patch: character({ updatedAt: 2 }),
      }],
    });
    await refresh;

    expect(settled).toBe(true);
    expect(useCharacterStore.getState().characters.map((item) => item.id)).toEqual(['character-1']);
  });

  it('resolves character remote-delete conflicts by discarding or restoring local edits', async () => {
    const { useCharacterStore } = await import('./useCharacterStore');
    await useCharacterStore.persist.rehydrate();
    useCharacterStore.setState({
      characters: [character({ id: 'character-1', name: '本地待保留角色' })],
      lastSyncedAt: 1,
      pendingOperations: [{
        id: 'op-character-background',
        entityId: 'character-1',
        kind: 'patch',
        targetIds: ['character-1'],
        clientTimestamp: 100,
        patch: { background: '本地未同步背景' },
        status: 'pending',
        attemptCount: 0,
      }],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: ['character-1'],
      isLoading: false,
    });

    await useCharacterStore.getState().resolveRemoteDeleteConflict('character-1', 'restore_local');

    expect(useCharacterStore.getState().remoteDeletedCharacterIds).toEqual([]);
    expect(useCharacterStore.getState().pendingOperations.some((operation) => operation.patch.deletedAt === null)).toBe(true);
    expect(useCharacterStore.getState().characters.some((item) => item.id === 'character-1')).toBe(true);

    useCharacterStore.setState({
      characters: [character({ id: 'character-2', name: '本地要放弃角色' })],
      pendingOperations: [{
        id: 'op-character-name',
        entityId: 'character-2',
        kind: 'patch',
        targetIds: ['character-2'],
        clientTimestamp: 120,
        patch: { name: '本地未同步名称' },
        status: 'pending',
        attemptCount: 0,
      }],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: ['character-2'],
      isLoading: false,
    });

    await useCharacterStore.getState().resolveRemoteDeleteConflict('character-2', 'discard_local');

    expect(useCharacterStore.getState().characters.some((item) => item.id === 'character-2')).toBe(false);
    expect(useCharacterStore.getState().pendingOperations.some((operation) => operation.entityId === 'character-2')).toBe(false);
    expect(useCharacterStore.getState().remoteDeletedCharacterIds).toEqual(['character-2']);
    useCharacterStore.getState().hydrateCharacterSummaries([character({ id: 'character-2', updatedAt: 200 })]);
    expect(useCharacterStore.getState().characters.some((item) => item.id === 'character-2')).toBe(false);

    useCharacterStore.setState({
      characters: [character({ id: 'character-3', name: '本地另存角色', background: '本地背景' })],
      pendingOperations: [{
        id: 'op-character-copy',
        entityId: 'character-3',
        kind: 'patch',
        targetIds: ['character-3'],
        clientTimestamp: 130,
        patch: { background: '本地另存背景' },
        status: 'pending',
        attemptCount: 0,
      }],
      pendingEditSyncCount: 1,
      pendingEditSyncError: null,
      remoteDeletedCharacterIds: ['character-3'],
      isLoading: false,
    });

    await useCharacterStore.getState().resolveRemoteDeleteConflict('character-3', 'save_as_new');

    const characterState = useCharacterStore.getState();
    const copiedCharacter = characterState.characters.find((item) => item.id !== 'character-3' && item.name.includes('本地副本'));
    expect(characterState.characters.some((item) => item.id === 'character-3')).toBe(false);
    expect(copiedCharacter?.name).toContain('本地另存角色');
    expect(characterState.pendingOperations.some((operation) => operation.entityId === 'character-3')).toBe(false);
    expect(characterState.pendingOperations.some((operation) => operation.kind === 'create' && operation.entityId === copiedCharacter?.id)).toBe(true);
    expect(characterState.remoteDeletedCharacterIds).toEqual(['character-3']);
    characterState.hydrateCharacterSummaries([character({ id: 'character-3', updatedAt: 200 })]);
    expect(useCharacterStore.getState().characters.some((item) => item.id === 'character-3')).toBe(false);
  });

  it('does not rewrite artifacts or fetch artifact summaries when the remote scope is not modified', async () => {
    const { useCharacterArtifactStore } = await import('./useCharacterArtifactStore');
    useCharacterArtifactStore.setState({
      items: [artifact()],
      jobs: [],
      isProcessing: false,
      unreadLetterCount: 0,
    });
    let writes = 0;
    const unsubscribe = useCharacterArtifactStore.subscribe(() => {
      writes += 1;
    });

    await useCharacterArtifactStore.getState().syncCloud();

    unsubscribe();
    expect(writes).toBe(0);
    expect(apiMocks.getSyncChanges).toHaveBeenCalledWith({ scope: 'artifacts.summary', since: null });
    expect(apiMocks.getCharacterArtifactSummaries).not.toHaveBeenCalled();
    expect(apiMocks.getCharacterArtifactItem).not.toHaveBeenCalled();
  });

  it('checks artifact summaries when the user explicitly retries cloud saving', async () => {
    const { useCharacterArtifactStore } = await import('./useCharacterArtifactStore');
    useCharacterArtifactStore.setState({ items: [], jobs: [], isProcessing: false, unreadLetterCount: 0 });
    apiMocks.getCharacterArtifactSummaries.mockResolvedValue({ items: [], updatedAt: 1 });

    await useCharacterArtifactStore.getState().retryCloudSync();

    expect(apiMocks.getCharacterArtifactSummaries).toHaveBeenCalledWith({ includeDeleted: true });
    expect(apiMocks.getSyncChanges).not.toHaveBeenCalled();
  });
});
