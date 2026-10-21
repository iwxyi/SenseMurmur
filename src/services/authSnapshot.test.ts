import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { AUTH_SNAPSHOT_KEY, readAuthSnapshot, updateAuthSnapshot } from './authSnapshot';
import type { AuthSnapshot } from './authSnapshot';

const session = (id: string): AuthSnapshot => ({
  version: 1, generation: `generation-${id}`, mode: 'cloud',
  token: `token-${id}`, refreshToken: `refresh-${id}`,
  user: { id, nickname: id, phone: '', avatar: '' },
});

describe('atomic authentication snapshots', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('commits one complete snapshot and removes legacy credentials', async () => {
    localStorage.setItem('pneumata-token', 'old-token');
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    const read = vi.spyOn(localStorage, 'setItem');
    await updateAuthSnapshot(readAuthSnapshot(), () => session('a'));
    expect(read.mock.calls).toEqual([[AUTH_SNAPSHOT_KEY, JSON.stringify(session('a'))]]);
    expect(readAuthSnapshot()).toEqual(session('a'));
    expect(localStorage.getItem('pneumata-token')).toBeNull();
  });

  it('serializes concurrent commits and rejects the stale writer with IndexedDB', async () => {
    vi.stubGlobal('navigator', {});
    const expected = readAuthSnapshot();
    const results = await Promise.allSettled([
      updateAuthSnapshot(expected, () => session('a')),
      updateAuthSnapshot(expected, () => session('b')),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { name: 'AbortError' } });
    expect(readAuthSnapshot()).toEqual(session('a'));
  });

  it('rechecks the current generation after acquiring the browser lock', async () => {
    let enter!: () => void;
    vi.stubGlobal('navigator', {
      locks: { request: (_name: string, action: () => AuthSnapshot) => new Promise<AuthSnapshot>((resolve, reject) => {
        enter = () => { try { resolve(action()); } catch (error) { reject(error); } };
      }) },
    });
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(session('a')));
    const update = vi.fn(() => session('c'));
    const pending = updateAuthSnapshot(readAuthSnapshot(), update);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(session('b')));
    enter();
    await rejected;
    expect(update).not.toHaveBeenCalled();
    expect(readAuthSnapshot()).toEqual(session('b'));
  });

  it('never falls back to old credentials after a corrupted snapshot', () => {
    localStorage.setItem('pneumata-token', 'old-token');
    localStorage.setItem(AUTH_SNAPSHOT_KEY, '{');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(readAuthSnapshot()).toMatchObject({ token: null, refreshToken: null });
  });
});
