import { readAuthSnapshot } from './authSnapshot';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { api, ApiError } from './api';
import { clearChatExecutionFence, getChatExecutionFence, setChatExecutionFence, type ChatExecutionFence } from './chatExecutionFence';
import { canAttemptOnlineSync, getCloudSyncSkipDiagnostics } from '../stores/storeSyncHelpers';

const LEASE_RENEW_INTERVAL_MS = 15_000;
const LEASE_OWNED_RETRY_MS = 5_000;
const lostLeases = new Map<string, Error>();

function leaseKey(chatId: string, fence: ChatExecutionFence) {
  return `${chatId}:${fence.ownerId}:${fence.generation}`;
}

function abortAsCancellation(controller: AbortController, reason: unknown) {
  if (controller.signal.aborted) return;
  const message = reason instanceof Error ? reason.message : '会话运行权已丢失';
  controller.abort(new DOMException(message, 'AbortError'));
}

function pendingFencedWrites(
  chatId: string,
  fence: ChatExecutionFence,
  messageOperations: Array<{ executionFence?: ChatExecutionFence; chatId?: string }>,
  chatOperations: Array<{ executionFence?: ChatExecutionFence; entityId?: string }>,
) {
  const matches = (operation: { executionFence?: ChatExecutionFence; chatId?: string; entityId?: string }) => {
    const operationFence = operation.executionFence;
    return (operation.chatId === chatId || operation.entityId === chatId)
      && operationFence?.ownerId === fence.ownerId && operationFence.generation === fence.generation;
  };
  return messageOperations.filter(matches).length + chatOperations.filter(matches).length;
}

async function confirmFencedWrites(chatId: string, fence: ChatExecutionFence) {
  const [{ useMessageStore }, { useChatStore }] = await Promise.all([
    import('../stores/useMessageStore'), import('../stores/useChatStore'),
  ]);
  const pendingCount = () => pendingFencedWrites(chatId, fence,
    useMessageStore.getState().pendingOperations, useChatStore.getState().pendingOperations);
  if (!pendingCount()) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('本次会话仍有待同步结果；联网后请核对同步状态');
  if (!canAttemptOnlineSync()) {
    const reasons = getCloudSyncSkipDiagnostics().reasons;
    throw new Error(`本次会话仍有待同步结果：云同步暂不可用（${reasons.join('、') || '工作区未就绪'}）`);
  }
  // Each store flushes at most three operations. Keep draining while the
  // current lease owns the writes, including parent messages and chat patches.
  let previousPendingIds = '';
  while (pendingCount() > 0) {
    const pendingIds = [...useMessageStore.getState().pendingOperations, ...useChatStore.getState().pendingOperations]
      .filter((operation) => operation.executionFence?.ownerId === fence.ownerId && operation.executionFence.generation === fence.generation)
      .map((operation) => operation.id).sort().join('|');
    if (pendingIds === previousPendingIds) break;
    previousPendingIds = pendingIds;
    await useChatStore.getState().flushPendingOperations();
    await useMessageStore.getState().flushPendingOperations();
    await useChatStore.getState().flushPendingOperations();
  }
  if (pendingCount()) {
    const pending = [...useMessageStore.getState().pendingOperations, ...useChatStore.getState().pendingOperations]
      .filter((operation) => operation.executionFence?.ownerId === fence.ownerId && operation.executionFence.generation === fence.generation);
    const reason = pending.find((operation) => operation.lastError)?.lastError;
    throw new Error(`本次会话仍有待同步结果${reason ? `：${reason}` : '，请在同步状态中检查后继续'}`);
  }
}

export function assertChatExecutionLease(chatId: string) {
  const auth = readAuthSnapshot();
  if (auth.mode !== 'cloud' || !auth.token || !isCloudSyncEnabled()) return;
  const fence = getChatExecutionFence(chatId);
  if (!fence) return;
  const error = lostLeases.get(leaseKey(chatId, fence));
  if (error) throw error;
}

export class ChatExecutionLeaseOwnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatExecutionLeaseOwnedError';
  }
}

export async function runWithChatExecutionLease<T>(chatId: string, work: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
  if (externalSignal?.aborted) throw externalSignal.reason || new Error('任务已取消');
  const auth = readAuthSnapshot();
  if (auth.mode !== 'cloud' || !auth.token || !isCloudSyncEnabled()) {
    const controller = new AbortController();
    const onAbort = () => abortAsCancellation(controller, externalSignal?.reason);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await work(controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      return result;
    }
    finally { externalSignal?.removeEventListener('abort', onAbort); }
  }

  const ownerId = crypto.randomUUID();
  let lease: Awaited<ReturnType<typeof api.acquireChatExecutionLease>>;
  try {
    lease = await api.acquireChatExecutionLease(chatId, ownerId);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CHAT_EXECUTION_OWNED') {
      throw new ChatExecutionLeaseOwnedError(error.message);
    }
    throw error;
  }
  const fence: ChatExecutionFence = { ownerId, generation: lease.generation };
  lostLeases.delete(leaseKey(chatId, fence));
  setChatExecutionFence(chatId, fence);
  let leaseError: Error | null = null;
  let pendingRenewal: Promise<void> | null = null;
  const controller = new AbortController();
  const onExternalAbort = () => abortAsCancellation(controller, externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const renewTimer = window.setInterval(() => {
    if (pendingRenewal || leaseError) return;
    const renewal = api.renewChatExecutionLease(chatId, fence).then(() => undefined).catch((error: unknown) => {
      leaseError = error instanceof Error ? error : new Error('会话运行权已丢失');
      lostLeases.set(leaseKey(chatId, fence), leaseError);
      abortAsCancellation(controller, leaseError);
    });
    pendingRenewal = renewal;
    void renewal.finally(() => {
      if (pendingRenewal === renewal) pendingRenewal = null;
    });
  }, LEASE_RENEW_INTERVAL_MS);

  let writesConfirmed = false;
  try {
    const result = await work(controller.signal);
    if (externalSignal?.aborted) throw externalSignal.reason || new Error('任务已取消');
    await confirmFencedWrites(chatId, fence);
    writesConfirmed = true;
    if (pendingRenewal) await pendingRenewal;
    if (leaseError) throw leaseError;
    return result;
  } finally {
    externalSignal?.removeEventListener('abort', onExternalAbort);
    window.clearInterval(renewTimer);
    if (pendingRenewal) await pendingRenewal;
    if (!writesConfirmed && !leaseError) {
      try {
        await confirmFencedWrites(chatId, fence);
      } catch {
        // The original task error remains authoritative; the outbox retains
        // its own visible sync failure for the user to inspect.
      }
    }
    try {
      await api.releaseChatExecutionLease(chatId, fence);
    } catch {
      console.warn('[chat-execution-lease:release-failed]');
    } finally {
      clearChatExecutionFence(chatId, fence);
      lostLeases.delete(leaseKey(chatId, fence));
    }
  }
}

export async function runWithChatExecutionLeaseWhenAvailable<T>(
  chatId: string,
  work: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  while (true) {
    if (externalSignal?.aborted) throw externalSignal.reason || new Error('任务已取消');
    try {
      return await runWithChatExecutionLease(chatId, work, externalSignal);
    } catch (error) {
      if (!(error instanceof ChatExecutionLeaseOwnedError)) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          externalSignal?.removeEventListener('abort', onAbort);
          resolve();
        }, LEASE_OWNED_RETRY_MS);
        const onAbort = () => {
          clearTimeout(timer);
          externalSignal?.removeEventListener('abort', onAbort);
          reject(externalSignal?.reason || new Error('任务已取消'));
        };
        externalSignal?.addEventListener('abort', onAbort, { once: true });
        if (externalSignal?.aborted) onAbort();
      });
    }
  }
}
