import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageKey } from '../constants/brand';

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
  getSyncChanges: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<typeof import('../services/api')>('../services/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      getSyncChanges: apiMocks.getSyncChanges,
      getSettings: apiMocks.getSettings,
      updateSettings: apiMocks.updateSettings,
    },
  };
});

describe('useSettingsStore', () => {
  beforeEach(() => {
    vi.resetModules();
    const storage = createStorageMock();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    localStorage.setItem(storageKey('token'), 'token');
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    apiMocks.getSyncChanges.mockReset();
    apiMocks.getSettings.mockReset();
    apiMocks.updateSettings.mockReset().mockResolvedValue({});
  });

  afterEach(async () => {
    const { stopWorkspace } = await import('../services/workspaceLifecycle');
    stopWorkspace();
    vi.unstubAllGlobals();
  });

  it('does not rewrite local settings when the remote scope is not modified', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'not_modified',
      scope: 'settings.account',
      cursor: 'settings.account:rev-1',
      revision: 'rev-1',
      changes: [],
    });
    const { useSettingsStore } = await import('./useSettingsStore');
    useSettingsStore.setState({
      _loaded: true,
      lastSyncedAt: 1,
      syncStatus: 'idle',
      syncError: null,
      themeColor: '#315A9C',
    });
    let writes = 0;
    const unsubscribe = useSettingsStore.subscribe(() => {
      writes += 1;
    });

    await useSettingsStore.getState().loadSettings();

    unsubscribe();
    expect(writes).toBe(0);
    expect(apiMocks.getSyncChanges).toHaveBeenCalledWith({
      scope: 'settings.account',
      since: null,
    });
    expect(apiMocks.getSettings).not.toHaveBeenCalled();
  });

  it('persists custom and disabled reply preferences without restoring the default on rehydration', async () => {
    const { useSettingsStore, buildSettingsPayload } = await import('./useSettingsStore');
    const storageName = useSettingsStore.persist.getOptions().name!;
    for (const mode of ['custom', 'off'] as const) {
      useSettingsStore.getState().setChatReplyPreferences({ mode, text: '' });
      const persisted = useSettingsStore.persist.getOptions().storage?.getItem(storageName);
      useSettingsStore.setState({ chatReplyPreferences: { mode: 'default', text: '' } });
      const stored = await persisted;
      expect(stored?.state.chatReplyPreferences).toEqual({ mode, text: '' });
      if (stored) await useSettingsStore.persist.getOptions().storage?.setItem(storageName, stored);
      await useSettingsStore.persist.rehydrate();
      expect(useSettingsStore.getState().chatReplyPreferences).toEqual({ mode, text: '' });
      const payload = buildSettingsPayload(useSettingsStore.getState());
      expect(payload.chatReplyPreferences).toEqual({ mode, text: '' });
    }
  });

  it('loads chat preferences from the cloud', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({ status: 'modified', changes: [] });
    apiMocks.getSettings.mockResolvedValueOnce({
      chatReplyPreferences: { mode: 'custom', text: '语气克制，保留细节。' },
    });
    const { useSettingsStore } = await import('./useSettingsStore');
    useSettingsStore.setState({ _loaded: false, settingsDirty: false });
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().chatReplyPreferences).toEqual({ mode: 'custom', text: '语气克制，保留细节。' });
  });

  it('keeps a newly configured video profile when a stale cloud read arrives before saving', async () => {
    const { useSettingsStore } = await import('./useSettingsStore');
    const oldProfiles = useSettingsStore.getState().aiProfiles;
    useSettingsStore.getState().addAIProfile();
    const added = useSettingsStore.getState().aiProfiles.at(-1)!;
    useSettingsStore.getState().updateAIProfile(added.id, {
      type: 'video', provider: 'official-ace', baseUrl: '/api/ai', model: 'doubao-seedance-2-0-fast-260128',
    });
    expect(useSettingsStore.getState().settingsDirty).toBe(true);
    apiMocks.getSyncChanges.mockResolvedValueOnce({ status: 'modified', changes: [] });
    apiMocks.getSettings.mockResolvedValueOnce({ aiProfiles: oldProfiles });
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().aiProfiles.find((profile) => profile.id === added.id)).toMatchObject({
      type: 'video', model: 'doubao-seedance-2-0-fast-260128',
    });
    expect(apiMocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      aiProfiles: expect.arrayContaining([expect.objectContaining({ id: added.id, type: 'video' })]),
    }));
    const storageName = useSettingsStore.persist.getOptions().name!;
    const persisted = await useSettingsStore.persist.getOptions().storage?.getItem(storageName);
    expect(persisted?.state.aiProfiles?.find((profile) => profile.id === added.id)?.type).toBe('video');
  });

  it('resumes a pending video profile save after rehydration before reading older cloud settings', async () => {
    const { useSettingsStore } = await import('./useSettingsStore');
    useSettingsStore.getState().addAIProfile();
    const added = useSettingsStore.getState().aiProfiles.at(-1)!;
    useSettingsStore.getState().updateAIProfile(added.id, {
      type: 'video', provider: 'official-ace', baseUrl: '/api/ai', model: 'MiniMax-H3',
    });
    const storageName = useSettingsStore.persist.getOptions().name!;
    const persisted = await useSettingsStore.persist.getOptions().storage?.getItem(storageName);
    if (persisted) await useSettingsStore.persist.getOptions().storage?.setItem(storageName, persisted);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().settingsDirty).toBe(true);
    await useSettingsStore.getState().loadSettings();
    expect(apiMocks.getSettings).not.toHaveBeenCalled();
    expect(apiMocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      aiProfiles: expect.arrayContaining([expect.objectContaining({ id: added.id, type: 'video', model: 'MiniMax-H3' })]),
    }));
    expect(useSettingsStore.getState().settingsDirty).toBe(false);
  });
});
