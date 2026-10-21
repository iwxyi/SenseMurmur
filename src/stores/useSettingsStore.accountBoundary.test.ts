import { afterEach, expect, it, vi } from 'vitest';
import { storageKey } from '../constants/brand';
import { adoptWorkspaceSession, initializeWorkspaceLifecycle, stopWorkspace } from '../services/workspaceLifecycle';

afterEach(() => vi.unstubAllGlobals());

it('resets in-memory API keys and restores only the destination account settings', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', new EventTarget());
  const login = (id: string) => {
    localStorage.setItem(storageKey('user'), JSON.stringify({ id }));
    localStorage.setItem(storageKey('token'), `token-${id}`);
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
  };
  login('a');
  const dispose = initializeWorkspaceLifecycle(vi.fn());
  try {
    const { useSettingsStore, resetSettingsStoreForAccountBoundary } = await import('./useSettingsStore');
    const originalProfile = useSettingsStore.getState().aiProfiles[0]!;
    useSettingsStore.setState({
      api: { ...useSettingsStore.getState().api, apiKey: 'a-key' },
      aiProfiles: [{ ...originalProfile, apiKey: 'a-key' }],
    });
    login('b');
    adoptWorkspaceSession();
    await resetSettingsStoreForAccountBoundary();
    expect(useSettingsStore.getState().api.apiKey).not.toBe('a-key');
    expect(useSettingsStore.getState().aiProfiles.some((profile) => profile.apiKey === 'a-key')).toBe(false);
    useSettingsStore.setState({
      api: { ...useSettingsStore.getState().api, apiKey: 'b-key' },
      aiProfiles: [{ ...originalProfile, apiKey: 'b-key' }],
    });
    login('a');
    adoptWorkspaceSession();
    await resetSettingsStoreForAccountBoundary();
    expect(useSettingsStore.getState().api.apiKey).toBe('a-key');
    login('b');
    adoptWorkspaceSession();
    await resetSettingsStoreForAccountBoundary();
    expect(useSettingsStore.getState().api.apiKey).toBe('b-key');
  } finally {
    stopWorkspace();
    dispose();
  }
});
