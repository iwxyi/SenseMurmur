import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationExecutionLockName, runWithConversationExecutionLock } from './conversationExecutionLock';

afterEach(() => vi.unstubAllGlobals());

describe('conversation execution lock', () => {
  it('uses the same scoped lock for direct replies and group turns', async () => {
    const names: string[] = [];
    vi.stubGlobal('navigator', { locks: { request: async (name: string, _options: unknown, callback: (lock: object) => Promise<string>) => {
      names.push(name);
      return callback({});
    } } });
    expect(await runWithConversationExecutionLock('account-a', 'chat-a', async () => 'done')).toBe('done');
    expect(names).toEqual([conversationExecutionLockName('account-a', 'chat-a')]);
    expect(conversationExecutionLockName('account-a', 'chat-a')).not.toBe(conversationExecutionLockName('account-b', 'chat-a'));
  });

  it('blocks a second tab before it generates a duplicate reply', async () => {
    const work = vi.fn(async () => 'unexpected');
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: null) => Promise<string>) => callback(null) } });
    await expect(runWithConversationExecutionLock('account-a', 'chat-a', work)).rejects.toThrow('另一个标签页');
    expect(work).not.toHaveBeenCalled();
  });
});
