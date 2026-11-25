import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_SNAPSHOT_KEY } from './authSnapshot';
import { api, ApiError } from './api';
import { getChatExecutionFence } from './chatExecutionFence';
import { assertChatExecutionLease, refreshChatExecutionLeaseBeforeWrite, runWithChatExecutionLease, runWithChatExecutionLeaseWhenAvailable } from './chatExecutionLease';
import { useMessageStore } from '../stores/useMessageStore';
import { useChatStore } from '../stores/useChatStore';

vi.mock('./api', () => ({
  ApiError: class ApiError extends Error { code?: string; constructor(message: string, options?: { code?: string }) { super(message); this.code = options?.code; } },
  api: {
    acquireChatExecutionLease: vi.fn(), renewChatExecutionLease: vi.fn(), releaseChatExecutionLease: vi.fn(),
  },
}));

vi.mock('../stores/storeSyncHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/storeSyncHelpers')>();
  return {
    ...actual,
    canAttemptOnlineSync: () => true,
    getCloudSyncSkipDiagnostics: () => ({ reasons: [] }),
  };
});

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
    let leaseSignal: AbortSignal | undefined;
    const running = runWithChatExecutionLease('chat-two', async (signal) => {
      leaseSignal = signal;
      await work;
      assertChatExecutionLease('chat-two');
    });
    await vi.waitFor(() => expect(getChatExecutionFence('chat-two')).toBeDefined());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(leaseSignal?.aborted).toBe(true);
    expect(leaseSignal?.reason).toMatchObject({ name: 'AbortError', message: '会话运行权续期请求失败：lease lost。当前步骤结果尚未确认，请核对后继续' });
    expect(() => assertChatExecutionLease('chat-two')).toThrow('lease lost');
    finish();
    await expect(running).rejects.toThrow('lease lost');
    expect(getChatExecutionFence('chat-two')).toBeUndefined();
  });

  it('renews a delayed lease before saving after the page resumes', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const running = runWithChatExecutionLease('chat-delayed', async () => {
      await pending;
      await refreshChatExecutionLeaseBeforeWrite('chat-delayed');
      return 'saved';
    });
    await vi.waitFor(() => expect(getChatExecutionFence('chat-delayed')).toBeDefined());
    vi.setSystemTime(Date.now() + 60_000);
    finish();
    await expect(running).resolves.toBe('saved');
    expect(api.renewChatExecutionLease).toHaveBeenCalledOnce();
    expect(api.renewChatExecutionLease).toHaveBeenCalledWith('chat-delayed', expect.objectContaining({ generation: 1 }));
  });

  it('forwards cancellation to the protected work', async () => {
    const controller = new AbortController();
    let leaseSignal: AbortSignal | undefined;
    const running = runWithChatExecutionLease('chat-cancel', async (signal) => {
      leaseSignal = signal;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }, controller.signal);
    await vi.waitFor(() => expect(leaseSignal).toBeDefined());
    controller.abort(new Error('workspace stopped'));
    await expect(running).rejects.toThrow('workspace stopped');
    expect(leaseSignal?.aborted).toBe(true);
  });

  it('waits for a foreign device lease without invoking work until it can acquire ownership', async () => {
    vi.mocked(api.acquireChatExecutionLease)
      .mockRejectedValueOnce(new ApiError('此会话正在另一台设备运行', { code: 'CHAT_EXECUTION_OWNED' }))
      .mockResolvedValueOnce({ generation: 2, expiresAt: Date.now() + 45_000 });
    const work = vi.fn(async () => 'completed');
    const running = runWithChatExecutionLeaseWhenAvailable('chat-owned', work);
    await vi.waitFor(() => expect(api.acquireChatExecutionLease).toHaveBeenCalledTimes(1));
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(running).resolves.toBe('completed');
    expect(api.acquireChatExecutionLease).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledOnce();
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

  it('drains more than one sync batch before releasing the lease', async () => {
    let flushCount = 0;
    const flush = vi.spyOn(useMessageStore.getState(), 'flushPendingOperations').mockImplementation(async () => {
      flushCount += 1;
      useMessageStore.setState((state) => ({ pendingOperations: state.pendingOperations.slice(3) }));
    });
    await runWithChatExecutionLease('chat-many-writes', async () => {
      const fence = getChatExecutionFence('chat-many-writes')!;
      useMessageStore.setState({ pendingOperations: Array.from({ length: 7 }, (_, index) => ({
        id: `message-${index}`, chatId: 'chat-many-writes', executionFence: fence, status: 'pending' as const,
        attemptCount: 0, createdAt: Date.now(), kind: 'create' as const,
      })) });
    });
    expect(flushCount).toBe(3);
    expect(useMessageStore.getState().pendingOperations).toHaveLength(0);
    flush.mockRestore();
  });

  it('continues draining when syncing one write replaces it with another', async () => {
    let flushCount = 0;
    const flush = vi.spyOn(useMessageStore.getState(), 'flushPendingOperations').mockImplementation(async () => {
      flushCount += 1;
      if (flushCount === 1) {
        const fence = getChatExecutionFence('chat-replaced-write')!;
        useMessageStore.setState({ pendingOperations: [{ id: 'replacement', chatId: 'chat-replaced-write', executionFence: fence,
          status: 'pending', attemptCount: 0, createdAt: Date.now(), kind: 'create' }] });
      } else useMessageStore.setState({ pendingOperations: [] });
    });
    await runWithChatExecutionLease('chat-replaced-write', async () => {
      const fence = getChatExecutionFence('chat-replaced-write')!;
      useMessageStore.setState({ pendingOperations: [{ id: 'original', chatId: 'chat-replaced-write', executionFence: fence,
        status: 'pending', attemptCount: 0, createdAt: Date.now(), kind: 'create' }] });
    });
    expect(flushCount).toBe(2);
    flush.mockRestore();
  });

  it('keeps an unsynced fenced write visible and reports incomplete delivery', async () => {
    const flush = vi.spyOn(useMessageStore.getState(), 'flushPendingOperations').mockResolvedValue();
    await expect(runWithChatExecutionLease('chat-four', async () => {
      const fence = getChatExecutionFence('chat-four')!;
      useMessageStore.setState({ pendingOperations: [{ id: 'message-test', chatId: 'chat-four', executionFence: fence, status: 'failed', attemptCount: 1, lastError: 'network: server unavailable', createdAt: Date.now(), kind: 'create' }] });
    })).rejects.toThrow('network: server unavailable');
    expect(useMessageStore.getState().pendingOperations).toHaveLength(1);
    expect(api.releaseChatExecutionLease).toHaveBeenCalledOnce();
    flush.mockRestore();
  });

  it('reports the pending operation state when no sync error has been recorded yet', async () => {
    const flush = vi.spyOn(useMessageStore.getState(), 'flushPendingOperations').mockResolvedValue();
    await expect(runWithChatExecutionLease('chat-pending-state', async () => {
      const fence = getChatExecutionFence('chat-pending-state')!;
      useMessageStore.setState({ pendingOperations: [{ id: 'message-test', chatId: 'chat-pending-state', executionFence: fence,
        status: 'syncing', attemptCount: 2, createdAt: Date.now(), kind: 'create', targetLabel: '团队任务消息' }] });
    })).rejects.toThrow('未确认操作：create「团队任务消息」（syncing，尝试 2）');
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
