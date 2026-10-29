import { create } from 'zustand';
import { ApiError, api } from '../services/api';
import { buildApiErrorUserMessage } from '../services/apiErrorMessage';
import { resetSettingsStoreForAccountBoundary, useSettingsStore } from './useSettingsStore';
import { reportRecoverableError } from '../services/diagnostics';
import { rememberCloudUserId } from '../services/authStorageScope';
import { rememberLastCloudPhone } from '../services/authSession';
import { beginCloudSyncBootstrapLock, endCloudSyncBootstrapLock, isCloudSyncBootstrapLocked, runWithCloudSyncBootstrapLock } from '../services/cloudSyncBootstrapLock';
import { isAccountCloudBootstrapPending, markAccountCloudBootstrapPending, markAccountCloudBootstrapReady, needsAccountCloudBootstrap } from '../services/accountCloudBootstrap';
import { isCloudSyncEnabled, isCloudSyncUserDisabled, setCloudSyncEnabled } from '../services/cloudSyncPreference';
import { setAssistantArtifactCloudSyncEnabled } from '../services/assistantArtifactCloudSyncPreference';
import { adoptWorkspaceSession, assertWorkspaceActive, getWorkspaceSignal, isWorkspaceActive, reloadWorkspaceAtLogin, stopWorkspace } from '../services/workspaceLifecycle';
import { readAuthSnapshot, updateAuthSnapshot } from '../services/authSnapshot';
import { flushBufferedPersistenceWrites } from './storePersistenceScope';
import { generateId } from '../utils/id';

interface User {
  id: string;
  phone: string;
  email?: string;
  nickname: string;
  avatar: string;
  cloudSyncEntitled?: boolean;
  assistantArtifactCloudSyncEntitled?: boolean;
  aiProxyEntitled?: boolean;
  agentEntitled?: boolean;
  aiSearchEntitled?: boolean;
  alapiDoutuEnabled?: boolean;
  marketAccessEntitled?: boolean;
  marketUploadEntitled?: boolean;
  chatShareEntitled?: boolean;
  developerModeEntitled?: boolean;
  retentionLimits?: Record<string, { storage: number; recall: number }>;
  cloudStorageBytes?: number;
  cloudStorageMembershipBytes?: number;
  cloudStorageAccountBytes?: number;
  cloudStorageGrants?: Array<{ bytes: number; expiresAt: number | null }>;
}

type AuthMode = 'cloud' | 'local';

interface AuthStore {
  token: string | null;
  user: User | null;
  isLoggedIn: boolean;
  isLoading: boolean;
  isWorkspaceReady: boolean;
  authMode: AuthMode;

  // Actions
  sendCode: (phone: string, purpose?: 'login' | 'register' | 'forgot-password' | 'change-phone', captchaToken?: string) => Promise<{ success: boolean; mock?: boolean; code?: string }>;
  login: (phone: string, code: string) => Promise<void>;
  loginWithPassword: (phone: string, password: string) => Promise<void>;
  enterLocalMode: () => Promise<void>;
  logout: () => Promise<void>;
  expireCloudSession: () => Promise<void>;
  checkAuth: () => Promise<boolean>;
  setUser: (user: User) => Promise<void>;
  updateProfile: (updates: Partial<User>) => Promise<void>;
  sendChangePhoneCode: (phone: string, captchaToken?: string) => Promise<{ success: boolean; mock?: boolean; code?: string }>;
  changePhone: (phone: string, code: string) => Promise<void>;
  sendPasswordCode: (captchaToken?: string) => Promise<{ success: boolean; mock?: boolean; code?: string }>;
  changePassword: (data: { mode: 'old_password' | 'phone_code'; oldPassword?: string; code?: string; newPassword: string }) => Promise<void>;
}

async function loadWorkspaceStores(signal: AbortSignal) {
  const [chatStoreModule, characterStoreModule, messageStoreModule] = await Promise.all([
    import('./useChatStore'),
    import('./useCharacterStore'),
    import('./useMessageStore'),
  ]);
  assertWorkspaceActive(signal);
  return {
    resetChatStoreForAccountBoundary: chatStoreModule.resetChatStoreForAccountBoundary,
    resetCharacterStoreForAccountBoundary: characterStoreModule.resetCharacterStoreForAccountBoundary,
    resetMessageStoreForAccountBoundary: messageStoreModule.resetMessageStoreForAccountBoundary,
    useChatStore: chatStoreModule.useChatStore,
    useCharacterStore: characterStoreModule.useCharacterStore,
  };
}

function canRefreshRemoteAfterAuth(user: User | null) {
  return user?.cloudSyncEntitled !== false && isCloudSyncEnabled() && !isCloudSyncBootstrapLocked()
    && !(user?.id && isAccountCloudBootstrapPending(user.id));
}

function lockCloudAuthInitialization() {
  beginCloudSyncBootstrapLock();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    endCloudSyncBootstrapLock();
  };
}

async function hydrateWorkspaceStoresFromCurrentScope(signal: AbortSignal) {
  const { useChatStore, useCharacterStore } = await loadWorkspaceStores(signal);
  const artifactStoreModule = await import('./useCharacterArtifactStore');
  assertWorkspaceActive(signal);
  await Promise.allSettled([
    useChatStore.persist.rehydrate(),
    useCharacterStore.persist.rehydrate(),
    artifactStoreModule.useCharacterArtifactStore.persist.rehydrate(),
  ]);
  assertWorkspaceActive(signal);
  return {
    useChatStore,
    useCharacterStore,
  };
}

async function refreshStoresAfterCloudAuth(user: User | null, signal: AbortSignal, options: { deferRemoteRefresh?: boolean } = {}) {
  const { useChatStore, useCharacterStore } = await hydrateWorkspaceStoresFromCurrentScope(signal);
  assertWorkspaceActive(signal);
  const settingsStore = useSettingsStore.getState();
  const chatStore = useChatStore.getState();
  const characterStore = useCharacterStore.getState();
  chatStore.markChatsWarm();
  characterStore.markCharactersWarm();
  if (user?.id && user.cloudSyncEntitled !== false && isCloudSyncEnabled() && needsAccountCloudBootstrap(user.id)) {
    markAccountCloudBootstrapPending(user.id);
    const bootstrap = await import('../services/localToCloudBootstrap');
    assertWorkspaceActive(signal);
    await runWithCloudSyncBootstrapLock(async () => {
      const snapshot = await bootstrap.captureLocalCloudBootstrapSnapshot(signal);
      await bootstrap.bootstrapLocalDataToCloud(snapshot, signal);
      assertWorkspaceActive(signal);
      markAccountCloudBootstrapReady(user.id);
    });
  }
  if (options.deferRemoteRefresh || isCloudSyncBootstrapLocked()) return;
  if (canRefreshRemoteAfterAuth(user)) {
    void Promise.allSettled([
      settingsStore.refreshSettingsFromCloud(),
      chatStore.refreshChatSummaryFromCloud(),
      characterStore.refreshCharacterSummaryFromCloud(),
    ]);
    return;
  }
  void settingsStore.loadSettings();
  void chatStore.prefetchChats();
  void characterStore.prefetchCharacters();
}

async function refreshRemoteStoresAfterCloudAuth(user: User | null, signal: AbortSignal) {
  const settingsStore = useSettingsStore.getState();
  const [{ useChatStore }, { useCharacterStore }] = await Promise.all([
    import('./useChatStore'),
    import('./useCharacterStore'),
  ]);
  assertWorkspaceActive(signal);
  const chatStore = useChatStore.getState();
  const characterStore = useCharacterStore.getState();
  if (canRefreshRemoteAfterAuth(user)) {
    void Promise.allSettled([
      settingsStore.refreshSettingsFromCloud(),
      chatStore.refreshChatSummaryFromCloud(),
      characterStore.refreshCharacterSummaryFromCloud(),
    ]);
    return;
  }
  void settingsStore.loadSettings();
  void chatStore.prefetchChats();
  void characterStore.prefetchCharacters();
}

async function resetLocalWorkspaceStoresForAccountBoundary(signal: AbortSignal) {
  const {
    resetChatStoreForAccountBoundary,
    resetCharacterStoreForAccountBoundary,
    resetMessageStoreForAccountBoundary,
  } = await loadWorkspaceStores(signal);
  const { resetCharacterArtifactStoreForAccountBoundary } = await import('./useCharacterArtifactStore');
  assertWorkspaceActive(signal);
  await resetChatStoreForAccountBoundary();
  assertWorkspaceActive(signal);
  await resetCharacterStoreForAccountBoundary();
  assertWorkspaceActive(signal);
  await resetMessageStoreForAccountBoundary();
  assertWorkspaceActive(signal);
  await resetCharacterArtifactStoreForAccountBoundary();
  assertWorkspaceActive(signal);
}

function rememberUser(user: User) {
  rememberCloudUserId(user);
  rememberLastCloudPhone(user.phone);
}

async function persistUser(user: User, signal: AbortSignal) {
  const expected = readAuthSnapshot();
  await updateAuthSnapshot(expected, (current) => {
    assertWorkspaceActive(signal);
    if (current.user && current.user.id !== user.id) throw new DOMException('账号已切换', 'AbortError');
    return { ...current, user };
  }, () => rememberUser(user));
  assertWorkspaceActive(signal);
}

function applyCloudSyncEntitlement(user: User | null) {
  if (user?.cloudSyncEntitled === false) {
    if (user.id) markAccountCloudBootstrapPending(user.id);
    setCloudSyncEnabled(false, { source: 'entitlement' });
  }
  if (user?.assistantArtifactCloudSyncEntitled === false) {
    setAssistantArtifactCloudSyncEnabled(false);
  }
  if (user?.developerModeEntitled !== undefined) {
    useSettingsStore.setState((state) => user.developerModeEntitled
      ? { ...state, developerModeEntitled: true }
      : {
          ...state,
          developerModeEntitled: false,
          developerMode: false,
          memoryUI: { ...state.memoryUI, showDeveloperMemory: false },
        });
  }
}

function enableCloudSyncForLogin(user: User | null) {
  if (user?.cloudSyncEntitled !== false && !isCloudSyncUserDisabled()) {
    setCloudSyncEnabled(true, { source: 'auth' });
  }
  applyCloudSyncEntitlement(user);
}

const initialAuthSession = readAuthSnapshot();

export const useAuthStore = create<AuthStore>((set, get) => ({
  token: initialAuthSession.token,
  user: initialAuthSession.user,
  isLoggedIn: !!initialAuthSession.token,
  isLoading: false,
  isWorkspaceReady: initialAuthSession.mode === 'local' || !initialAuthSession.token,
  authMode: initialAuthSession.mode,

  sendCode: async (phone: string, purpose = 'login', captchaToken?: string) => {
    const result = await api.sendCode(phone, purpose, captchaToken);
    return result;
  },

  sendChangePhoneCode: async (phone: string, captchaToken?: string) => {
    const result = await api.sendChangePhoneCode(phone, captchaToken);
    return result;
  },

  login: async (phone: string, code: string) => {
    // Keep the login route mounted while the request is in flight. Setting the
    // workspace as unavailable here makes DataLoader replace the route tree,
    // which discards LoginPage's error state before it can render.
    let signal = getWorkspaceSignal();
    assertWorkspaceActive(signal);
    const expected = readAuthSnapshot();
    set({ isLoading: true });
    const releaseSyncLock = lockCloudAuthInitialization();
    try {
      const shouldBootstrapLocalData = get().authMode === 'local' && isCloudSyncEnabled();
      const bootstrapModule = shouldBootstrapLocalData ? await import('../services/localToCloudBootstrap') : null;
      assertWorkspaceActive(signal);
      const localSnapshot = bootstrapModule ? await bootstrapModule.captureLocalCloudBootstrapSnapshot(signal) : null;
      assertWorkspaceActive(signal);
      const result = await api.login(phone, code);
      assertWorkspaceActive(signal);
      set({ isWorkspaceReady: false });
      await updateAuthSnapshot(expected, () => {
        assertWorkspaceActive(signal);
        return { version: 1, generation: generateId(), token: result.token, refreshToken: result.refreshToken, user: result.user, mode: 'cloud' };
      }, () => {
        adoptWorkspaceSession();
        signal = getWorkspaceSignal();
        rememberUser(result.user);
      });
      assertWorkspaceActive(signal);
      await resetSettingsStoreForAccountBoundary();
      assertWorkspaceActive(signal);
      enableCloudSyncForLogin(result.user);
      set({
        token: result.token,
        user: result.user,
        isLoggedIn: true,
        isLoading: true,
        authMode: 'cloud',
      });
      await resetLocalWorkspaceStoresForAccountBoundary(signal);
      if (bootstrapModule && localSnapshot && bootstrapModule.hasBootstrapEntityData(localSnapshot) && result.user.cloudSyncEntitled !== false && isCloudSyncEnabled()) {
        try {
          await runWithCloudSyncBootstrapLock(() => bootstrapModule.bootstrapLocalDataToCloud(localSnapshot, signal));
          assertWorkspaceActive(signal);
        } catch (error) {
          assertWorkspaceActive(signal);
          await resetLocalWorkspaceStoresForAccountBoundary(signal);
          assertWorkspaceActive(signal);
          await get().logout();
          throw error;
        }
      }
      const guestImportModule = await import('../services/guestDataImport');
      assertWorkspaceActive(signal);
      const guestImportSnapshot = await guestImportModule.readGuestImportSnapshot();
      assertWorkspaceActive(signal);
      const shouldDeferRemoteRefresh = Boolean(
        result.user?.id
        && guestImportModule.hasPendingGuestImportForUser(result.user.id, guestImportSnapshot),
      );
      await refreshStoresAfterCloudAuth(result.user, signal, { deferRemoteRefresh: shouldDeferRemoteRefresh });
      releaseSyncLock();
      if (!shouldDeferRemoteRefresh) await refreshRemoteStoresAfterCloudAuth(result.user, signal);
      assertWorkspaceActive(signal);
      set({ isLoading: false, isWorkspaceReady: true });
    } catch (error) {
      if (!signal.aborted && isWorkspaceActive()) set({ isLoading: false, isWorkspaceReady: true });
      throw error;
    } finally {
      releaseSyncLock();
    }
  },

  loginWithPassword: async (phone, password) => {
    // See code-login above: request failures must leave LoginPage mounted so
    // its inline error alert remains visible.
    let signal = getWorkspaceSignal();
    assertWorkspaceActive(signal);
    const expected = readAuthSnapshot();
    set({ isLoading: true });
    const releaseSyncLock = lockCloudAuthInitialization();
    try {
      const result = await api.passwordLogin(phone, password);
      assertWorkspaceActive(signal);
      set({ isWorkspaceReady: false });
      await updateAuthSnapshot(expected, () => {
        assertWorkspaceActive(signal);
        return { version: 1, generation: generateId(), token: result.token, refreshToken: result.refreshToken, user: result.user, mode: 'cloud' };
      }, () => {
        adoptWorkspaceSession();
        signal = getWorkspaceSignal();
        rememberUser(result.user);
      });
      assertWorkspaceActive(signal);
      await resetSettingsStoreForAccountBoundary();
      assertWorkspaceActive(signal);
      enableCloudSyncForLogin(result.user);
      set({ token: result.token, user: result.user, isLoggedIn: true, isLoading: true, isWorkspaceReady: false, authMode: 'cloud' });
      await resetLocalWorkspaceStoresForAccountBoundary(signal);
      await refreshStoresAfterCloudAuth(result.user, signal);
      releaseSyncLock();
      await refreshRemoteStoresAfterCloudAuth(result.user, signal);
      assertWorkspaceActive(signal);
      set({ isLoading: false, isWorkspaceReady: true });
    } catch (error) { if (!signal.aborted && isWorkspaceActive()) set({ isLoading: false, isWorkspaceReady: true }); throw error; }
    finally { releaseSyncLock(); }
  },

  enterLocalMode: async () => {
    const signal = getWorkspaceSignal();
    const expected = readAuthSnapshot();
    assertWorkspaceActive(signal);
    set({ isLoading: true, isWorkspaceReady: false });
    flushBufferedPersistenceWrites();
    stopWorkspace();
    try {
      await updateAuthSnapshot(expected, () => ({ version: 1, generation: generateId(), token: null, refreshToken: null, user: null, mode: 'local' }));
    } catch (error) {
      reloadWorkspaceAtLogin();
      throw error;
    }
    set({
      token: null,
      user: null,
      isLoggedIn: false,
      isLoading: true,
      isWorkspaceReady: false,
      authMode: 'local',
    });
    reloadWorkspaceAtLogin('/');
  },

  logout: async () => {
    const signal = getWorkspaceSignal();
    const expected = readAuthSnapshot();
    assertWorkspaceActive(signal);
    set({ isLoading: true, isWorkspaceReady: false });
    flushBufferedPersistenceWrites();
    stopWorkspace();
    let previous = expected;
    try {
      await updateAuthSnapshot(expected, (current) => {
        previous = current;
        return { version: 1, generation: generateId(), token: null, refreshToken: null, user: null, mode: 'local' };
      });
    } catch (error) {
      reloadWorkspaceAtLogin();
      throw error;
    }
    set({
      token: null,
      user: null,
      isLoggedIn: false,
      isLoading: true,
      isWorkspaceReady: false,
      authMode: 'local',
    });
    void api.revokeAuthSession(previous.token, previous.refreshToken).catch((error: unknown) => {
      console.warn('[auth] server logout unavailable; local session cleared', { error });
    });
    reloadWorkspaceAtLogin();
  },

  expireCloudSession: async () => {
    if (!isWorkspaceActive()) return;
    const expected = readAuthSnapshot();
    if (!isWorkspaceActive()) return;
    const phone = get().user?.phone;
    if (phone) rememberLastCloudPhone(phone);
    stopWorkspace();
    try {
      await updateAuthSnapshot(expected, () => ({ version: 1, generation: generateId(), token: null, refreshToken: null, user: null, mode: 'cloud' }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('[auth] session expiration failed', { error });
      reloadWorkspaceAtLogin();
      return;
    }
    set({
      token: null,
      user: null,
      isLoggedIn: false,
      isLoading: false,
      isWorkspaceReady: true,
      authMode: 'cloud',
    });
    reloadWorkspaceAtLogin();
  },

  checkAuth: async () => {
    const signal = getWorkspaceSignal();
    if (!isWorkspaceActive()) return false;
    const token = get().token;
    if (!token) return false;

    set({ isLoading: true, isWorkspaceReady: false });
    const releaseSyncLock = lockCloudAuthInitialization();
    try {
      const user = await api.getMe();
      assertWorkspaceActive(signal);
      await persistUser(user, signal);
      enableCloudSyncForLogin(user);
      // api may have refreshed an expired access token while loading /me.
      // Keep Zustand aligned with the persisted token so bootstrap and route
      // guards do not continue to reason about the expired token.
      set({ token: readAuthSnapshot().token, user, isLoggedIn: true, authMode: 'cloud' });
      await refreshStoresAfterCloudAuth(user, signal, { deferRemoteRefresh: true });
      releaseSyncLock();
      if (!isCloudSyncUserDisabled()) await refreshRemoteStoresAfterCloudAuth(user, signal);
      assertWorkspaceActive(signal);
      set({ isLoading: false, isWorkspaceReady: true });
      return true;
    } catch (error) {
      if (signal.aborted || !isWorkspaceActive()) return false;
      if (error instanceof ApiError && error.status === 401) {
        await get().expireCloudSession();
        return false;
      }
      console.warn('[cloud-sync] auth check unavailable; keeping cloud-local cache active', { error });
      set({ isLoggedIn: true, isLoading: false, isWorkspaceReady: true, authMode: 'cloud' });
      return false;
    } finally {
      releaseSyncLock();
    }
  },

  setUser: async (user: User) => {
    const signal = getWorkspaceSignal();
    await persistUser(user, signal);
    applyCloudSyncEntitlement(user);
    set({ user });
  },

  updateProfile: async (updates) => {
    const signal = getWorkspaceSignal();
    try {
      const result = await api.updateMe({ nickname: updates.nickname, avatar: updates.avatar });
      await persistUser(result, signal);
      applyCloudSyncEntitlement(result);
      set({ user: result });
    } catch (error) {
      reportRecoverableError({
        location: 'auth:update-profile',
        error,
        userMessage: buildApiErrorUserMessage(error, '账号资料更新'),
      });
      throw error;
    }
  },

  changePhone: async (phone, code) => {
    const signal = getWorkspaceSignal();
    try {
      const result = await api.changePhone(phone, code);
      await persistUser(result, signal);
      applyCloudSyncEntitlement(result);
      set({ user: result });
    } catch (error) {
      reportRecoverableError({
        location: 'auth:change-phone',
        error,
        userMessage: buildApiErrorUserMessage(error, '手机号修改'),
      });
      throw error;
    }
  },

  sendPasswordCode: async (captchaToken) => api.sendPasswordCode(captchaToken),
  changePassword: async (data) => { await api.changePassword(data); },
}));
