import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_SNAPSHOT_KEY } from './authSnapshot';
import { api } from './api';
import { getChatExecutionFence } from './chatExecutionFence';
import { assertChatExecutionLease, runWithChatExecutionLease } from './chatExecutionLease';
import { useMessageStore } from '../stores/useMessageStore';
import { useChatStore } from '../stores/useChatStore';

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
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { setInterval, clearInterval });
  vi.mocked(api.acquireChatExecutionLease).mockResolvedValue({ generation: 1, expiresAt: Date.now() + 45_000 });
  vi.mocked(api.renewChatExecutionLease).mockResolvedValue({ generation: 1, expiresAt: Date.now() + 45_000 });
  vi.mocked(api.releaseChatExecutionLease).mockResolvedValue({ released: true });
  useMessageStore.setState({ pendingOperations: [] });
  useChatStore.setState({ pendingOperations: [] });
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

  it('flushes fenced message writes before releasing the lease', async () => {
    const sequence: string[] = [];
    const flush = vi.spyOn(useMessageStore.getState(), 'flushPendingOperations').mockImplementation(async () => {
      sequence.push('flush');
      useMessageStore.setState({ pendingOperations: [] });
    });
    vi.mocked(api.releaseChatExecutionLease).mockImplementation(async () => {
      sequence.push('release');
      return { released: true };
    });
    await runWithChatExecutionLease('chat-three', async () => {
      const fence = getChatExecutionFence('chat-three')!;
      useMessageStore.setState({ pendingOperations: [{ id: 'message-test', chatId: 'chat-three', executionFence: fence, status: 'pending', attemptCount: 0, createdAt: Date.now(), kind: 'create' }] });
    });
    expect(sequence).toEqual(['flush', 'release']);
    flush.mockRestore();
  });

  it('keeps an unsynced fenced write visible and reports incomplete delivery', async () => {
    const flush = vi.spyOn(useMessageStore.getState(), 'flushPendingOperations').mockResolvedValue();
    await expect(runWithChatExecutionLease('chat-four', async () => {
      const fence = getChatExecutionFence('chat-four')!;
      useMessageStore.setState({ pendingOperations: [{ id: 'message-test', chatId: 'chat-four', executionFence: fence, status: 'failed', attemptCount: 1, createdAt: Date.now(), kind: 'create' }] });
    })).rejects.toThrow('仍有待同步结果');
    expect(useMessageStore.getState().pendingOperations).toHaveLength(1);
    expect(api.releaseChatExecutionLease).toHaveBeenCalledOnce();
    flush.mockRestore();
  });

  it('confirms local writes before release even when the task itself fails', async () => {
    const sequence: string[] = [];
    const flush = vi.spyOn(useMessageStore.getState(), 'flushPendingOperations').mockImplementation(async () => {
      sequence.push('flush');
      useMessageStore.setState({ pendingOperations: [] });
    });
    vi.mocked(api.releaseChatExecutionLease).mockImplementation(async () => {
      sequence.push('release');
      return { released: true };
    });
    await expect(runWithChatExecutionLease('chat-five', async () => {
      const fence = getChatExecutionFence('chat-five')!;
      useMessageStore.setState({ pendingOperations: [{ id: 'message-test', chatId: 'chat-five', executionFence: fence, status: 'pending', attemptCount: 0, createdAt: Date.now(), kind: 'create' }] });
      throw new Error('task failed');
    })).rejects.toThrow('task failed');
    expect(sequence).toEqual(['flush', 'release']);
    flush.mockRestore();
  });
});
