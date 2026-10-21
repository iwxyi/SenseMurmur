import { storageKey } from '../constants/brand';
import { getWorkspaceDataUserId } from './workspaceLifecycle';
import { readAuthSnapshot } from './authSnapshot';

const LAST_CLOUD_USER_ID_KEY = storageKey('last-cloud-user-id');

export function rememberCloudUserId(user: { id?: string | null } | null | undefined) {
  if (!user?.id || typeof localStorage === 'undefined') return;
  localStorage.setItem(LAST_CLOUD_USER_ID_KEY, user.id);
}

export function getStoredAuthUserId() {
  return readAuthSnapshot().user?.id || null;
}

export function getLocalDataUserId() {
  const workspaceUserId = getWorkspaceDataUserId();
  if (workspaceUserId !== undefined) return workspaceUserId;
  if (typeof localStorage === 'undefined') return 'guest';
  const session = readAuthSnapshot();
  const currentUserId = session.user?.id;
  if (currentUserId) return currentUserId;
  const authMode = session.mode;
  const token = session.token;
  const lastCloudUserId = localStorage.getItem(LAST_CLOUD_USER_ID_KEY);
  if ((token || authMode === 'cloud') && lastCloudUserId) return lastCloudUserId;
  return 'guest';
}
