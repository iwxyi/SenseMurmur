import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { AUTH_SNAPSHOT_KEY, readAuthSnapshot } from '../services/authSnapshot';
import { adoptWorkspaceSession, initializeWorkspaceLifecycle, stopWorkspace } from '../services/workspaceLifecycle';
import { useAuthStore } from './useAuthStore';

const mocks = vi.hoisted(() => ({
  login: vi.fn(), passwordLogin: vi.fn(), resetSettings: vi.fn(), bootstrap: vi.fn(),
  resetChats: vi.fn(), resetCharacters: vi.fn(), resetMessages: vi.fn(), resetArtifacts: vi.fn(),
  hydrate: vi.fn(), revoke: vi.fn(), capture: vi.fn(), refresh: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { login: mocks.login, passwordLogin: mocks.passwordLogin, revokeAuthSession: mocks.revoke },
}));
vi.mock('./useSettingsStore', () => ({
  resetSettingsStoreForAccountBoundary: mocks.resetSettings,
  useSettingsStore: { getState: () => ({ refreshSettingsFromCloud: mocks.refresh, loadSettings: mocks.refresh }), setState: vi.fn() },
}));
vi.mock('./useChatStore', () => ({
  resetChatStoreForAccountBoundary: mocks.resetChats,
  useChatStore: { persist: { rehydrate: mocks.hydrate }, getState: () => ({ markChatsWarm: vi.fn(), refreshChatSummaryFromCloud: mocks.refresh }) },
}));
vi.mock('./useCharacterStore', () => ({
  resetCharacterStoreForAccountBoundary: mocks.resetCharacters,
  useCharacterStore: { persist: { rehydrate: mocks.hydrate }, getState: () => ({ markCharactersWarm: vi.fn(), refreshCharacterSummaryFromCloud: mocks.refresh }) },
}));
vi.mock('./useMessageStore', () => ({ resetMessageStoreForAccountBoundary: mocks.resetMessages }));
vi.mock('./useCharacterArtifactStore', () => ({
  resetCharacterArtifactStoreForAccountBoundary: mocks.resetArtifacts,
  useCharacterArtifactStore: { persist: { rehydrate: mocks.hydrate } },
}));
vi.mock('../services/localToCloudBootstrap', () => ({
  captureLocalCloudBootstrapSnapshot: mocks.capture,
  hasBootstrapEntityData: () => true,
  bootstrapLocalDataToCloud: mocks.bootstrap,
}));
vi.mock('../services/guestDataImport', () => ({ readGuestImportSnapshot: async () => null, hasPendingGuestImportForUser: () => false }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const result = (id: string) => ({ token: `token-${id}`, refreshToken: `refresh-${id}`, user: { id, phone: '', nickname: id, avatar: '' } });

describe('login initialization account boundaries', () => {
  let dispose: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    dispose = initializeWorkspaceLifecycle(vi.fn());
    useAuthStore.setState({ token: null, user: null, authMode: 'local', isLoading: false, isWorkspaceReady: true, isLoggedIn: false });
    mocks.login.mockResolvedValue(result('a'));
    mocks.passwordLogin.mockResolvedValue(result('a'));
    mocks.capture.mockResolvedValue({ chats: [] });
    mocks.bootstrap.mockResolvedValue(undefined);
    mocks.resetSettings.mockResolvedValue(undefined);
    mocks.revoke.mockResolvedValue(undefined);
  });
  afterEach(() => { stopWorkspace(); dispose(); vi.unstubAllGlobals(); });

  function replaceWithB() {
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({ version: 1, generation: 'b', mode: 'cloud', ...result('b') }));
  }

  it('does not clear B credentials when A bootstrap rejects after another tab logs in', async () => {
    const bootstrap = deferred<void>();
    mocks.bootstrap.mockReturnValueOnce(bootstrap.promise);
    const login = useAuthStore.getState().login('phone', 'code');
    const rejected = expect(login).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledOnce());
    const resets = mocks.resetChats.mock.calls.length;
    replaceWithB();
    bootstrap.reject(new Error('import failed'));
    await rejected;
    expect(readAuthSnapshot()).toMatchObject({ token: 'token-b', user: { id: 'b' } });
    expect(mocks.resetChats).toHaveBeenCalledTimes(resets);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('does not resume A initialization into a newly adopted lifetime in the same document', async () => {
    const reset = deferred<void>();
    mocks.resetSettings.mockReturnValueOnce(reset.promise);
    const login = useAuthStore.getState().loginWithPassword('phone', 'password');
    const rejected = expect(login).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.resetSettings).toHaveBeenCalledOnce());
    replaceWithB();
    adoptWorkspaceSession();
    useAuthStore.setState({ user: result('b').user, token: 'token-b', isWorkspaceReady: false });
    reset.resolve();
    await rejected;
    expect(mocks.resetChats).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ user: { id: 'b' }, token: 'token-b', isWorkspaceReady: false });
  });

  it('does not let a stale logout waiting for the lock clear B credentials', async () => {
    await useAuthStore.getState().loginWithPassword('phone', 'password');
    let enter!: () => void;
    vi.stubGlobal('navigator', { locks: { request: (_name: string, action: () => unknown) => new Promise((resolve, reject) => {
      enter = () => { try { resolve(action()); } catch (error) { reject(error); } };
    }) } });
    const logout = useAuthStore.getState().logout();
    const rejected = expect(logout).rejects.toMatchObject({ name: 'AbortError' });
    replaceWithB();
    enter();
    await rejected;
    expect(readAuthSnapshot().token).toBe('token-b');
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it.each(['logout', 'enterLocalMode', 'expireCloudSession'] as const)('%s clears credentials without crypto.randomUUID or Web Locks', async (action) => {
    await useAuthStore.getState().loginWithPassword('phone', 'password');
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    vi.stubGlobal('navigator', {});
    await expect(useAuthStore.getState()[action]()).resolves.toBeUndefined();
    expect(readAuthSnapshot()).toMatchObject({ token: null, refreshToken: null, user: null });
    if (action === 'logout') expect(mocks.revoke).toHaveBeenCalledWith('token-a', 'refresh-a');
  });
});
