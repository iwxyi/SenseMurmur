import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_SNAPSHOT_KEY } from './authSnapshot';
import { api } from './api';
import { getChatExecutionFence } from './chatExecutionFence';
import { assertChatExecutionLease, runWithChatExecutionLease } from './chatExecutionLease';

vi.mock('./api', () => ({ api: {
  acquireChatExecutionLease: vi.fn(), renewChatExecutionLease: vi.fn(), releaseChatExecutionLease: vi.fn(),
} }));

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  const local = storage();
  local.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({ version: 1, generation: 'test', token: 'token', refreshToken: null, user: { id: 'user-test' }, mode: 'cloud' }));
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('window', { setInterval, clearInterval });
  vi.mocked(api.acquireChatExecutionLease).mockResolvedValue({ generation: 1, expiresAt: Date.now() + 45_000 });
  vi.mocked(api.renewChatExecutionLease).mockResolvedValue({ generation: 1, expiresAt: Date.now() + 45_000 });
  vi.mocked(api.releaseChatExecutionLease).mockResolvedValue({ released: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('chat execution lease', () => {
  it('does not replace a completed result when the release request fails', async () => {
    vi.mocked(api.releaseChatExecutionLease).mockRejectedValue(new Error('network unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(runWithChatExecutionLease('chat-one', async () => 'completed')).resolves.toBe('completed');
    expect(getChatExecutionFence('chat-one')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[chat-execution-lease:release-failed]');
    warn.mockRestore();
  });

  it('stops new work after renewal fails and clears the fence on exit', async () => {
    vi.mocked(api.renewChatExecutionLease).mockRejectedValue(new Error('lease lost'));
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const running = runWithChatExecutionLease('chat-two', async () => {
      await work;
      assertChatExecutionLease('chat-two');
    });
    await vi.waitFor(() => expect(getChatExecutionFence('chat-two')).toBeDefined());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(() => assertChatExecutionLease('chat-two')).toThrow('lease lost');
    finish();
    await expect(running).rejects.toThrow('lease lost');
    expect(getChatExecutionFence('chat-two')).toBeUndefined();
  });
});
