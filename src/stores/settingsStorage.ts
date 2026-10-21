import type { StateStorage } from 'zustand/middleware';
import { scopedStorageKey, storageKey } from '../constants/brand';
import { getLocalDataUserId } from '../services/authStorageScope';
import { isWorkspaceActive } from '../services/workspaceLifecycle';
import { createScopedStorage } from './storePersistenceScope';

export const SETTINGS_STORAGE_NAME = scopedStorageKey('settings');
export const getSettingsStorageKey = () => scopedStorageKey(`settings-${getLocalDataUserId()}`);

export function createSettingsStorage(): StateStorage {
  const ownerKey = storageKey('settings-legacy-owner');
  // Bind the old device-wide snapshot once, before any account switch.
  if (typeof localStorage !== 'undefined' && isWorkspaceActive() && !localStorage.getItem(ownerKey)) {
    const owner = getLocalDataUserId() === 'guest'
      ? localStorage.getItem(storageKey('last-cloud-user-id')) || 'guest'
      : getLocalDataUserId();
    localStorage.setItem(ownerKey, owner);
  }
  const storage = createScopedStorage({ getScopedKey: getSettingsStorageKey, storageName: SETTINGS_STORAGE_NAME });
  return {
    ...storage,
    getItem: (name) => {
      if (name === SETTINGS_STORAGE_NAME && typeof localStorage !== 'undefined' && isWorkspaceActive()
        && localStorage.getItem(ownerKey) === getLocalDataUserId()
        && localStorage.getItem(getSettingsStorageKey()) === null) {
        const legacy = localStorage.getItem(SETTINGS_STORAGE_NAME);
        if (legacy !== null) storage.setItem(name, legacy);
      }
      return storage.getItem(name);
    },
  };
}
