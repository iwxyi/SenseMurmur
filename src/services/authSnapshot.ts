import { storageKey } from '../constants/brand';
import type { AuthUserResponse } from './api';

export const AUTH_SNAPSHOT_KEY = storageKey('auth-session');
const AUTH_LOCK_NAME = storageKey('auth-session-update');

export interface AuthSnapshot {
  version: 1;
  generation: string | null;
  token: string | null;
  refreshToken: string | null;
  user: AuthUserResponse | null;
  mode: 'cloud' | 'local';
}

function emptySnapshot(): AuthSnapshot {
  return { version: 1, generation: null, token: null, refreshToken: null, user: null, mode: 'local' };
}

export function readAuthSnapshot(): AuthSnapshot {
  if (typeof localStorage === 'undefined') return emptySnapshot();
  const raw = localStorage.getItem(AUTH_SNAPSHOT_KEY);
  if (raw !== null) {
    try {
      const value = JSON.parse(raw) as AuthSnapshot;
      if (value.version === 1 && (value.generation === null || typeof value.generation === 'string')
        && (value.token === null || typeof value.token === 'string')
        && (value.refreshToken === null || typeof value.refreshToken === 'string')
        && (value.user === null || (typeof value.user === 'object' && typeof value.user.id === 'string'))
        && (value.mode === 'cloud' || value.mode === 'local')) return value;
    } catch {
      // A damaged snapshot must never revive credentials from the legacy keys.
    }
    console.error('[auth] invalid session snapshot');
    return { ...emptySnapshot(), generation: 'invalid' };
  }
  // Read old installations until their first coordinated authentication update.
  let user: AuthUserResponse | null = null;
  try {
    const legacy = localStorage.getItem(storageKey('user'));
    const value = legacy ? JSON.parse(legacy) as AuthUserResponse : null;
    if (value && typeof value.id === 'string') user = value;
  } catch {
    console.error('[auth] invalid legacy account metadata');
  }
  const token = localStorage.getItem(storageKey('token'));
  return {
    version: 1, generation: localStorage.getItem(storageKey('workspace-generation')),
    token, refreshToken: localStorage.getItem(storageKey('refresh-token')), user,
    mode: localStorage.getItem(storageKey('auth-mode')) === 'cloud' ? 'cloud'
      : localStorage.getItem(storageKey('auth-mode')) === 'local' ? 'local' : token ? 'cloud' : 'local',
  };
}

// IndexedDB read/write transactions serialize across tabs on older webviews too.
function withIndexedDbAuthLock<T>(action: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持安全的会话更新，请更新浏览器后重试'));
      return;
    }
    const open = indexedDB.open(AUTH_LOCK_NAME, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('mutex'); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('mutex', 'readwrite');
      let result: T;
      let failure: unknown;
      transaction.objectStore('mutex').get('lock').onsuccess = () => {
        try { result = action(); }
        catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => { db.close(); resolve(result); };
      transaction.onabort = () => { db.close(); reject(failure ?? transaction.error); };
    };
  });
}

/** Only synchronous snapshot commits run under the lock; network work stays outside. */
export function updateAuthSnapshot(
  expected: AuthSnapshot,
  update: (current: AuthSnapshot) => AuthSnapshot,
  onCommit?: (next: AuthSnapshot) => void,
): Promise<AuthSnapshot> {
  const commit = () => {
    const current = readAuthSnapshot();
    if (current.generation !== expected.generation || current.user?.id !== expected.user?.id
      || current.mode !== expected.mode || Boolean(current.token) !== Boolean(expected.token)) {
      throw new DOMException('会话已被其他标签页更新', 'AbortError');
    }
    const next = update(current);
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(next));
    for (const key of ['token', 'refresh-token', 'user', 'auth-mode', 'workspace-generation']) {
      localStorage.removeItem(storageKey(key));
    }
    onCommit?.(next);
    return next;
  };
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(AUTH_LOCK_NAME, commit)
    : withIndexedDbAuthLock(commit);
}
