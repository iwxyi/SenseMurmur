import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LocalCloudBootstrapSnapshot } from './localToCloudBootstrap';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import { DEFAULT_SETTINGS } from '../types/settings';

const localStore = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: (key: string) => localStore.get(key) ?? null,
  setItem: (key: string, value: string) => { localStore.set(key, value); },
  removeItem: (key: string) => { localStore.delete(key); },
  clear: () => { localStore.clear(); },
  key: (index: number) => Array.from(localStore.keys())[index] ?? null,
  get length() { return localStore.size; },
});

let bootstrap: Awaited<typeof import('./localToCloudBootstrap')>;

beforeAll(async () => {
  bootstrap = await import('./localToCloudBootstrap');
});

function character(id: string, name: string, extra: Partial<AICharacter> = {}) {
  return {
    id,
    name,
    avatar: '🙂',
    personality: {},
    expertise: [],
    speakingStyle: '',
    background: '',
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as AICharacter;
}

function chat(id: string, name: string, extra: Partial<GroupChat> = {}) {
  return {
    id,
    type: 'group',
    mode: 'free',
    name,
    topic: '',
    style: '',
    memberIds: [],
    speed: 'normal',
    isActive: true,
    allowIntervention: true,
    showRoleActions: true,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as GroupChat;
}

function snapshot(overrides: Partial<LocalCloudBootstrapSnapshot> = {}): LocalCloudBootstrapSnapshot {
  return {
    characters: [],
    chats: [],
    messageWindowsByChatId: {},
    settingsShouldUpload: true,
    ...overrides,
  };
}

describe('localToCloudBootstrap', () => {
  it.each(['active', 'deleted', 'missing', 'rejected'] as const)('reconciles offline deletions against %s cloud records before enabling sync', async (state) => {
    const { api } = await import('./api');
    const { useCharacterStore } = await import('../stores/useCharacterStore');
    const { useChatStore } = await import('../stores/useChatStore');
    const changes = vi.spyOn(api, 'getSyncChanges').mockImplementation(async ({ scope }) => ({
      status: 'modified', scope, cursor: 'log:1', revision: 'log:1',
      changes: state === 'missing' ? [] : [{
        entity: scope === 'characters.summary' ? 'character_summary' : 'chat_summary',
        id: scope === 'characters.summary' ? 'offline-character' : 'offline-chat',
        op: state === 'deleted' ? 'delete' : 'upsert',
        patch: { id: scope === 'characters.summary' ? 'offline-character' : 'offline-chat', name: '已删内容', deletedAt: state === 'deleted' ? 1 : null },
      }],
    }) as Awaited<ReturnType<typeof api.getSyncChanges>>);
    const deleteCharacter = vi.spyOn(api, 'syncCharacterPatch').mockResolvedValue({ success: true, character: { deletedAt: state === 'rejected' ? null : 2 } });
    const deleteChat = vi.spyOn(api, 'syncChatPatch').mockResolvedValue({ success: true, chat: { deletedAt: 2 } });
    const createCharacter = vi.spyOn(api, 'createCharacter');
    const createChat = vi.spyOn(api, 'createChat');
    const confirmCharacter = vi.spyOn(useCharacterStore.getState(), 'confirmOperationsSynced');
    const confirmChat = vi.spyOn(useChatStore.getState(), 'confirmOperationsSynced');
    try {
      const uploading = bootstrap.bootstrapLocalDataToCloud(snapshot({
        settingsShouldUpload: false,
        pendingCharacterOperations: [{ id: 'delete-character', entityId: 'offline-character', kind: 'patch', status: 'pending', clientTimestamp: 2, patch: { deletedAt: 2 } }],
        pendingChatOperations: [{ id: 'delete-chat', entityId: 'offline-chat', kind: 'patch', status: 'pending', clientTimestamp: 2, patch: { deletedAt: 2 } }],
      }));
      if (state === 'rejected') {
        await expect(uploading).rejects.toThrow('云端未接受本地删除');
        expect(confirmCharacter).not.toHaveBeenCalled();
        expect(confirmChat).not.toHaveBeenCalled();
      } else {
        await uploading;
        expect(confirmCharacter).toHaveBeenCalledWith(['delete-character']);
        expect(confirmChat).toHaveBeenCalledWith(['delete-chat']);
      }
      expect(changes).toHaveBeenCalledTimes(2);
      expect(deleteCharacter).toHaveBeenCalledTimes(state === 'active' || state === 'rejected' ? 1 : 0);
      expect(deleteChat).toHaveBeenCalledTimes(state === 'active' ? 1 : 0);
      expect(createCharacter).not.toHaveBeenCalled();
      expect(createChat).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('uploads only never-uploaded records and does not recreate another device\'s deletions', () => {
    const plan = bootstrap.createBootstrapReconcilePlan(snapshot({
      characters: [character('offline-character', '本地角色'), character('deleted-character', '另一设备已删', { updatedAt: 999 })],
      chats: [chat('offline-chat', '本地会话'), chat('deleted-chat', '另一设备已删', { updatedAt: 999 })],
    }), {
      characters: [{ id: 'deleted-character', name: '另一设备已删', deletedAt: 2 }],
      chats: [{ id: 'deleted-chat', name: '另一设备已删', deletedAt: 2 }],
    });
    expect(plan.charactersToCreate.map((item) => item.id)).toEqual(['offline-character']);
    expect(plan.chatsToCreate.map((item) => item.id)).toEqual(['offline-chat']);
    expect(plan.chatsAlreadyRemote).toEqual([]);
    expect(plan.chatsToPatchRuntime).toEqual([]);
  });
  it('does not start fallback requests or write bootstrap status after its session ends', async () => {
    const { api } = await import('./api');
    const controller = new AbortController();
    let rejectSummary!: (error: Error) => void;
    const deferred = new Promise<Awaited<ReturnType<typeof api.getSyncChanges>>>((_resolve, reject) => { rejectSummary = reject; });
    const summary = vi.spyOn(api, 'getSyncChanges').mockReturnValue(deferred);
    const characters = vi.spyOn(api, 'getCharacters');
    const chats = vi.spyOn(api, 'getChats');
    localStore.clear();
    const pending = bootstrap.bootstrapLocalDataToCloud(snapshot({ characters: [character('local-a', 'A')] }), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    rejectSummary(new Error('Old summary failed'));
    await rejected;
    expect(characters).not.toHaveBeenCalled();
    expect(chats).not.toHaveBeenCalled();
    expect(localStore.size).toBe(0);
    summary.mockRestore();
    characters.mockRestore();
    chats.mockRestore();
  });
  it('does not upload default settings during local bootstrap', () => {
    expect(bootstrap.shouldUploadSettingsDuringBootstrap(DEFAULT_SETTINGS as ReturnType<typeof import('../stores/useSettingsStore').useSettingsStore.getState>)).toBe(false);
    expect(bootstrap.shouldUploadSettingsDuringBootstrap({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
    } as ReturnType<typeof import('../stores/useSettingsStore').useSettingsStore.getState>)).toBe(true);
  });

  it('uploads settings-only bootstrap without fetching remote entity summaries', async () => {
    localStore.clear();
    const originalApi = await import('./api');
    const getSyncChanges = vi.spyOn(originalApi.api, 'getSyncChanges');
    const createCharacter = vi.spyOn(originalApi.api, 'createCharacter');
    const createChat = vi.spyOn(originalApi.api, 'createChat');
    const syncSettings = vi.spyOn((await import('../stores/useSettingsStore')).useSettingsStore.getState(), 'syncCurrentSettingsToServer').mockResolvedValue(undefined);

    await bootstrap.bootstrapLocalDataToCloud(snapshot({
      settingsShouldUpload: true,
    }));

    expect(syncSettings).toHaveBeenCalledTimes(1);
    expect(getSyncChanges).not.toHaveBeenCalled();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(createChat).not.toHaveBeenCalled();

    getSyncChanges.mockRestore();
    createCharacter.mockRestore();
    createChat.mockRestore();
    syncSettings.mockRestore();
  });

  it('builds a summary reconcile plan before uploading local data', () => {
    const plan = bootstrap.createBootstrapReconcilePlan(
      snapshot({
        characters: [
          character('local-a', '阿青'),
          character('cloud-existing', '已有角色'),
          character('preset-local', '预设', { isPreset: true }),
          character('deleted-local', '本地已删', { deletedAt: 10 }),
        ],
        chats: [
          chat('local-chat', '本地群聊'),
          chat('cloud-chat', '已有群聊'),
          chat('deleted-chat', '本地已删', { deletedAt: 10 }),
        ],
      }),
      {
        characters: [
          { id: 'cloud-existing', name: '已有角色', isPreset: false, deletedAt: null },
          { id: 'remote-same-name', name: '阿青', isPreset: false, deletedAt: null },
        ],
        chats: [
          { id: 'cloud-chat', name: '已有群聊', deletedAt: null },
        ],
      },
    );

    expect(plan.charactersToCreate.map((item) => item.id)).toEqual(['local-a']);
    expect(plan.charactersAlreadyRemote.map((item) => item.id)).toEqual(['cloud-existing']);
    expect(plan.characterNameConflicts).toEqual([{
      localId: 'local-a',
      localName: '阿青',
      remoteId: 'remote-same-name',
      remoteName: '阿青',
    }]);
    expect(plan.chatsToCreate.map((item) => item.id)).toEqual(['local-chat']);
    expect(plan.chatsAlreadyRemote.map((item) => item.id)).toEqual(['cloud-chat']);
  });

  it('treats local-id chats with the same name as already remote during bootstrap', () => {
    const plan = bootstrap.createBootstrapReconcilePlan(
      snapshot({
        chats: [
          chat('local-chat-12345678', '跨设备群聊'),
          chat('cloud-chat', '已有群聊'),
        ],
      }),
      {
        characters: [],
        chats: [
          { id: 'cloud-group-1', name: '跨设备群聊', deletedAt: null },
          { id: 'cloud-chat', name: '已有群聊', deletedAt: null },
        ],
      },
    );

    expect(plan.chatsToCreate).toEqual([]);
    expect(plan.chatsAlreadyRemote.map((item) => item.id)).toEqual(['local-chat-12345678', 'cloud-chat']);
  });

  it('marks already-remote chats with local world runtime data for patching', () => {
    const plan = bootstrap.createBootstrapReconcilePlan(
      snapshot({
        chats: [
          chat('local-chat-12345678', '跨设备群聊', {
            runtimeEventsV2: [{
              id: 'local-moment',
              conversationId: 'local-chat-12345678',
              kind: 'artifact',
              actorIds: ['char-a'],
              targetIds: [],
              visibility: 'public',
              summary: '本地朋友圈',
              createdAt: 2,
              payload: { eventKind: 'post_moment', artifactType: 'moment_text', text: '本地动态' },
            }],
          }),
        ],
      }),
      {
        characters: [],
        chats: [
          { id: 'cloud-group-1', name: '跨设备群聊', deletedAt: null },
        ],
      },
    );

    expect(plan.chatsToCreate).toEqual([]);
    expect(plan.chatsToPatchRuntime.map((item) => item.id)).toEqual(['local-chat-12345678']);
  });

  it('patches already-remote chats with merged local moment runtime events during bootstrap', async () => {
    localStore.clear();
    const originalApi = await import('./api');
    const getSyncChanges = vi.spyOn(originalApi.api, 'getSyncChanges').mockImplementation(async ({ scope }) => {
      if (scope === 'chats.summary') {
        return {
          status: 'modified',
          scope,
          cursor: 'chats',
          revision: 'chats',
          changes: [{
            entity: 'chat_summary',
            id: 'cloud-group-1',
            updatedAt: 1,
            deletedAt: null,
            patch: { id: 'cloud-group-1', name: '跨设备群聊', type: 'group', deletedAt: null },
          }],
        } as Awaited<ReturnType<typeof originalApi.api.getSyncChanges>>;
      }
      return {
        status: 'modified',
        scope,
        cursor: 'characters',
        revision: 'characters',
        changes: [],
      } as Awaited<ReturnType<typeof originalApi.api.getSyncChanges>>;
    });
    const getChat = vi.spyOn(originalApi.api, 'getChat').mockResolvedValue(chat('cloud-group-1', '跨设备群聊', {
      runtimeEventsV2: [{
        id: 'remote-moment',
        conversationId: 'cloud-group-1',
        kind: 'artifact',
        actorIds: ['char-a'],
        targetIds: [],
        visibility: 'public',
        summary: '云端朋友圈',
        createdAt: 1,
        payload: { eventKind: 'post_moment', artifactType: 'moment_text', text: '云端动态' },
      }],
    }) as unknown as Awaited<ReturnType<typeof originalApi.api.getChat>>);
    const syncChatPatch = vi.spyOn(originalApi.api, 'syncChatPatch').mockResolvedValue({
      success: true,
      chat: {},
    });
    const syncSettings = vi.spyOn((await import('../stores/useSettingsStore')).useSettingsStore.getState(), 'syncCurrentSettingsToServer').mockResolvedValue(undefined);

    await bootstrap.bootstrapLocalDataToCloud(snapshot({
      settingsShouldUpload: false,
      chats: [chat('local-chat-12345678', '跨设备群聊', {
        runtimeEventsV2: [{
          id: 'local-moment',
          conversationId: 'local-chat-12345678',
          kind: 'artifact',
          actorIds: ['char-a'],
          targetIds: [],
          visibility: 'public',
          summary: '本地朋友圈',
          createdAt: 2,
          payload: { eventKind: 'post_moment', artifactType: 'moment_text', text: '本地动态' },
        }],
      })],
    }));

    expect(getChat).toHaveBeenCalledWith('cloud-group-1');
    expect(syncChatPatch).toHaveBeenCalledWith('cloud-group-1', expect.objectContaining({
      patch: expect.objectContaining({
        runtimeEventsV2: expect.arrayContaining([
          expect.objectContaining({ id: 'remote-moment' }),
          expect.objectContaining({ id: 'local-moment', conversationId: 'cloud-group-1' }),
        ]),
      }),
    }));

    getSyncChanges.mockRestore();
    getChat.mockRestore();
    syncChatPatch.mockRestore();
    syncSettings.mockRestore();
  });

  it('maps local-id chats skipped by bootstrap to the matching remote chat id for message upload', async () => {
    localStore.clear();
    const originalApi = await import('./api');
    const createMessage = vi.spyOn(originalApi.api, 'createMessage').mockResolvedValue({
      id: 'message-created',
      chatId: 'cloud-group-1',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '你好',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
    } as Awaited<ReturnType<typeof originalApi.api.createMessage>>);
    const getSyncChanges = vi.spyOn(originalApi.api, 'getSyncChanges').mockImplementation(async ({ scope }) => {
      if (scope === 'chats.summary') {
        return {
          status: 'modified',
          scope,
          cursor: 'chats',
          revision: 'chats',
          changes: [{
            entity: 'chat_summary',
            id: 'cloud-group-1',
            updatedAt: 1,
            deletedAt: null,
            patch: { id: 'cloud-group-1', name: '跨设备群聊', type: 'group', deletedAt: null },
          }],
        } as Awaited<ReturnType<typeof originalApi.api.getSyncChanges>>;
      }
      return {
        status: 'modified',
        scope,
        cursor: 'characters',
        revision: 'characters',
        changes: [],
      } as Awaited<ReturnType<typeof originalApi.api.getSyncChanges>>;
    });
    const syncSettings = vi.spyOn((await import('../stores/useSettingsStore')).useSettingsStore.getState(), 'syncCurrentSettingsToServer').mockResolvedValue(undefined);

    await bootstrap.bootstrapLocalDataToCloud(snapshot({
      settingsShouldUpload: false,
      chats: [chat('local-chat-12345678', '跨设备群聊')],
      messageWindowsByChatId: {
        'local-chat-12345678': {
          messages: [{
            id: 'msg-1',
            chatId: 'local-chat-12345678',
            type: 'user',
            senderId: 'user',
            senderName: '用户',
            content: '你好',
            emotion: 0,
            timestamp: 1,
            isDeleted: false,
          }],
        },
      },
    }));

    expect(createMessage).toHaveBeenCalledWith('cloud-group-1', expect.objectContaining({
      senderId: 'user',
      content: '你好',
    }));

    createMessage.mockRestore();
    getSyncChanges.mockRestore();
    syncSettings.mockRestore();
  });

  it('carries pending creates into the bootstrap reconcile plan', () => {
    const plan = bootstrap.createBootstrapReconcilePlan(
      snapshot({
        pendingCharacterOperations: [{
          id: 'char-op',
          kind: 'create',
          entityId: 'local-character',
          targetIds: ['local-character'],
          status: 'pending',
        }],
        pendingChatOperations: [{
          id: 'chat-op',
          kind: 'create',
          entityId: 'local-chat',
          targetIds: ['local-chat'],
          status: 'pending',
        }],
        pendingMessageOperations: [{
          id: 'message-op',
          kind: 'create',
          chatId: 'local-chat',
          localMessageId: 'local-message',
          status: 'pending',
        }],
      }),
      { characters: [], chats: [] },
    );

    expect(plan.pendingCharacterCreates.map((item) => item.id)).toEqual(['char-op']);
    expect(plan.pendingChatCreates.map((item) => item.id)).toEqual(['chat-op']);
    expect(plan.pendingMessageCreates.map((item) => item.id)).toEqual(['message-op']);
  });

  it('limits persisted bootstrap conflict details while keeping the total count', async () => {
    localStore.clear();
    const conflicts = Array.from({ length: 25 }, (_, index) => character(`local-${index}`, `重复${index}`));
    const remoteCharacters = conflicts.map((item, index) => ({
      id: `remote-${index}`,
      name: item.name,
      isPreset: false,
      deletedAt: null,
    }));
    const originalApi = await import('./api');
    const getSyncChanges = vi.spyOn(originalApi.api, 'getSyncChanges').mockImplementation(async ({ scope }) => {
      if (scope === 'characters.summary') {
        return {
          status: 'modified',
          scope,
          cursor: 'characters',
          revision: 'characters',
          changes: remoteCharacters.map((character) => ({
            entity: 'character_summary',
            id: character.id,
            updatedAt: 1,
            deletedAt: null,
            patch: character,
          })),
        } as Awaited<ReturnType<typeof originalApi.api.getSyncChanges>>;
      }
      return {
        status: 'modified',
        scope,
        cursor: 'chats',
        revision: 'chats',
        changes: [],
      } as Awaited<ReturnType<typeof originalApi.api.getSyncChanges>>;
    });
    const syncSettings = vi.spyOn((await import('../stores/useSettingsStore')).useSettingsStore.getState(), 'syncCurrentSettingsToServer').mockResolvedValue(undefined);
    const createCharacter = vi.spyOn(originalApi.api, 'createCharacter').mockImplementation(async (payload) => ({
      id: `created-${String(payload.name)}`,
      ...payload,
    }) as Awaited<ReturnType<typeof originalApi.api.createCharacter>>);

    await bootstrap.bootstrapLocalDataToCloud(snapshot({
      characters: conflicts,
      settingsShouldUpload: false,
      pendingCharacterOperations: [{
        id: 'character-create-local-0',
        kind: 'create',
        entityId: 'local-0',
        targetIds: ['local-0'],
        status: 'pending',
      }],
    }));

    const statusModule = await import('./cloudSyncBootstrapStatus');
    const status = statusModule.readCloudSyncBootstrapStatus();
    expect(status?.characterNameConflicts).toBe(25);
    expect(status?.characterNameConflictDetails).toHaveLength(statusModule.BOOTSTRAP_STATUS_CONFLICT_DETAIL_LIMIT);
    expect(status?.characterNameConflictDetailOverflow).toBe(5);
    expect(createCharacter).toHaveBeenCalledWith(expect.objectContaining({
      id: 'local-0',
      operationId: 'character-create-local-0',
    }));

    getSyncChanges.mockRestore();
    syncSettings.mockRestore();
    createCharacter.mockRestore();
  });
});
