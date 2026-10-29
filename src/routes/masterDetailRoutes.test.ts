import { describe, expect, it } from 'vitest';
import { getMasterDetailSection } from './masterDetailRoutes';

describe('master/detail route ownership', () => {
  it.each(['/chats', '/chats/room-a', '/chats/room-b/edit', '/chats/create', '/direct/create'])('keeps %s in the shared chat shell', (path) => {
    expect(getMasterDetailSection(path)).toBe('chats');
  });

  it.each(['/characters', '/characters/role-a/edit', '/characters/role-b/edit', '/characters/create'])('keeps %s in the shared character shell', (path) => {
    expect(getMasterDetailSection(path)).toBe('characters');
  });

  it.each(['/characters/batch-generate', '/characters/role-a', '/chats/room-a/unknown', '/calendar'])('does not capture the standalone route %s', (path) => {
    expect(getMasterDetailSection(path)).toBeNull();
  });
});
