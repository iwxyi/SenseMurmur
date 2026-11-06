import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storageKey } from '../constants/brand';
import { setCloudSyncEnabled } from '../services/cloudSyncPreference';
import { getCloudSyncSkipDiagnostics, shouldSkipCloudSync } from './storeSyncHelpers';
import { useAuthStore } from './useAuthStore';
import { markAccountCloudBootstrapReady } from '../services/accountCloudBootstrap';

const storage = new Map<string, string>();

class TestCustomEvent<T = unknown> extends Event {
  detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }
}

vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => { storage.clear(); },
});

vi.stubGlobal('CustomEvent', TestCustomEvent);
vi.stubGlobal('window', {
  dispatchEvent: vi.fn(),
});

function setCloudUser(cloudSyncEntitled = true) {
  useAuthStore.setState({
    token: 'token',
    user: {
      id: 'user-1',
      phone: '13800000000',
      nickname: '测试用户',
      avatar: '',
      cloudSyncEntitled,
    },
    isLoggedIn: true,
    authMode: 'cloud',
  });
}

describe('storeSyncHelpers cloud sync gate', () => {
  beforeEach(() => {
    storage.clear();
    vi.mocked(window.dispatchEvent).mockClear();
    useAuthStore.setState({
      token: null,
      user: null,
      isLoggedIn: false,
      authMode: 'local',
    });
  });

  it('recovers stale disabled cloud sync after account bootstrap completes', () => {
    setCloudSyncEnabled(false, { source: 'entitlement' });
    setCloudUser(true);

    expect(shouldSkipCloudSync()).toBe(true);
    markAccountCloudBootstrapReady('user-1');
    expect(shouldSkipCloudSync()).toBe(false);
    expect(localStorage.getItem(storageKey('cloud-sync-enabled'))).toBe('1');
    expect(getCloudSyncSkipDiagnostics()).toMatchObject({
      skipCloudSync: false,
      reasons: [],
      cloudSyncEnabled: true,
      cloudSyncUserDisabled: false,
      cloudSyncEntitlementDisabled: false,
    });
  });

  it('preserves an explicit user-disabled cloud sync preference', () => {
    setCloudSyncEnabled(false, { source: 'user' });
    setCloudUser(true);

    expect(shouldSkipCloudSync()).toBe(true);
    expect(getCloudSyncSkipDiagnostics()).toMatchObject({
      skipCloudSync: true,
      reasons: ['cloud-sync-user-disabled', 'account-bootstrap-pending'],
      cloudSyncEnabled: false,
      cloudSyncUserDisabled: true,
    });
  });

  it('does not recover cloud sync when entitlement is disabled', () => {
    setCloudSyncEnabled(false, { source: 'entitlement' });
    setCloudUser(false);

    expect(shouldSkipCloudSync()).toBe(true);
    expect(getCloudSyncSkipDiagnostics()).toMatchObject({
      skipCloudSync: true,
      reasons: ['cloud-sync-not-entitled', 'account-bootstrap-pending'],
      cloudSyncEnabled: false,
      cloudSyncEntitlementDisabled: true,
    });
  });
});
