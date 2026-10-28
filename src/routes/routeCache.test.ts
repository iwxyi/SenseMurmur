import { describe, expect, it } from 'vitest';
import type { Location, NavigationType } from 'react-router-dom';
import { advanceRouteCache, createRouteCache } from './routeCache';

function location(path: string, key: string): Location {
  const url = new URL(path, 'https://example.test');
  return { pathname: url.pathname, search: url.search, hash: url.hash, state: null, key };
}

function visit(paths: Array<[string, string, NavigationType]>) {
  const [first, ...rest] = paths;
  return rest.reduce(
    (cache, [path, key, action]) => advanceRouteCache(cache, location(path, key), action, 'guest'),
    createRouteCache(location(first[0], first[1]), first[2], 'guest'),
  );
}

describe('route cache', () => {
  it('reuses a list after detail returns through a push navigation', () => {
    const cache = visit([
      ['/chats?tab=1', 'list', 'POP'],
      ['/chats/chat-a?fromTab=1', 'detail', 'PUSH'],
      ['/chats?tab=1', 'return', 'PUSH'],
    ]);
    expect(cache.activeId).toBe('list');
    expect(cache.entries).toHaveLength(2);
  });

  it('preserves the original page through same-path query replacement and editor return', () => {
    const cache = visit([
      ['/chats', 'list', 'POP'],
      ['/chats?tab=1', 'tab', 'REPLACE'],
      ['/characters/char-a/edit?returnTo=%2Fchats%3Ftab%3D1', 'editor', 'PUSH'],
      ['/chats?tab=1&restoreDraft=1', 'return', 'REPLACE'],
    ]);
    expect(cache.activeId).toBe('list');
    expect(cache.entries).toHaveLength(2);
  });

  it('keeps consecutive page instances and clears them on account switch', () => {
    const cache = visit([
      ['/chats', 'list', 'POP'],
      ['/chats/chat-a', 'chat', 'PUSH'],
      ['/characters/char-a/edit', 'editor', 'PUSH'],
      ['/chats/chat-a', 'return', 'PUSH'],
    ]);
    expect(cache.activeId).toBe('chat');
    expect(cache.entries).toHaveLength(3);
    const switched = advanceRouteCache(cache, location('/chats', 'new-account'), 'PUSH', 'cloud:new-user');
    expect(switched.entries).toHaveLength(1);
    expect(switched.activeId).toBe('new-account');
  });
});
