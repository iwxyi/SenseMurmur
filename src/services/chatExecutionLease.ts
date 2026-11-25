import { readAuthSnapshot } from './authSnapshot';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { api, ApiError } from './api';
import { clearChatExecutionFence, getChatExecutionFence, setChatExecutionFence, type ChatExecutionFence } from './chatExecutionFence';
import { canAttemptOnlineSync, getCloudSyncSkipDiagnostics } from '../stores/storeSyncHelpers';

const LEASE_RENEW_INTERVAL_MS = 15_000;
const LEASE_OWNED_RETRY_MS = 5_000;
const FENCED_WRITE_CONFIRM_TIMEOUT_MS = 45_000;
const lostLeases = new Map<string, Error>();
const activeLeaseRefreshers = new Map<string, { fence: ChatExecutionFence; refresh: () => Promise<void> }>();

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

async function confirmFencedWrites(chatId: string, fence: ChatExecutionFence, signal?: AbortSignal) {
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
  const deadline = Date.now() + FENCED_WRITE_CONFIRM_TIMEOUT_MS;
  let rounds = 0;
  while (pendingCount() > 0 && Date.now() < deadline && rounds < 12) {
    rounds += 1;
    signal?.throwIfAborted();
    await useChatStore.getState().flushPendingOperations();
    await useMessageStore.getState().flushPendingOperations();
    await useChatStore.getState().flushPendingOperations();
    if (!pendingCount()) break;
    const pending = [...useMessageStore.getState().pendingOperations, ...useChatStore.getState().pendingOperations]
      .filter((operation) => operation.executionFence?.ownerId === fence.ownerId && operation.executionFence.generation === fence.generation);
    if (pending.some((operation) => operation.status === 'failed')) break;
    const retryTimes = pending.filter((operation) => operation.status === 'pending' && operation.retryAt)
      .map((operation) => operation.retryAt!);
    if (!retryTimes.length) continue;
    const nextRetryAt = Math.min(...retryTimes);
    const delay = Math.max(50, Math.min(5_000, nextRetryAt - Date.now(), deadline - Date.now()));
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason || new Error('会话同步确认已中断')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  if (pendingCount()) {
    const pending = [...useMessageStore.getState().pendingOperations, ...useChatStore.getState().pendingOperations]
      .filter((operation) => operation.executionFence?.ownerId === fence.ownerId && operation.executionFence.generation === fence.generation);
    const reason = pending.find((operation) => operation.lastError)?.lastError;
    const summary = pending.map((operation) => {
      const kind = 'kind' in operation ? String(operation.kind) : '更新';
      const label = 'targetLabel' in operation && operation.targetLabel ? `「${operation.targetLabel}」` : '';
      const attempts = 'attemptCount' in operation ? `，尝试 ${operation.attemptCount}` : '';
      return `${kind}${label}（${operation.status}${attempts}）`;
    }).join('、');
    throw new Error(`本次会话仍有待同步结果${reason ? `：${reason}` : `；未确认操作：${summary || '状态未知'}`}`);
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

export async function refreshChatExecutionLeaseBeforeWrite(chatId: string) {
  const active = activeLeaseRefreshers.get(chatId);
  if (active) await active.refresh();
  assertChatExecutionLease(chatId);
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
  let expiresAt = lease.expiresAt;
  const controller = new AbortController();
  const onExternalAbort = () => abortAsCancellation(controller, externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const renew = () => {
    if (leaseError) return Promise.reject(leaseError);
    if (pendingRenewal) return pendingRenewal;
    const renewal = api.renewChatExecutionLease(chatId, fence).then((result) => { expiresAt = result.expiresAt; }).catch((error: unknown) => {
      leaseError = error instanceof ApiError ? error
        : new Error(`会话运行权续期请求失败：${error instanceof Error ? error.message : '连接或服务异常'}。当前步骤结果尚未确认，请核对后继续`);
      lostLeases.set(leaseKey(chatId, fence), leaseError);
      abortAsCancellation(controller, leaseError);
    });
    pendingRenewal = renewal;
    void renewal.finally(() => {
      if (pendingRenewal === renewal) pendingRenewal = null;
    });
    return renewal;
  };
  const refresh = async () => {
    if (leaseError) throw leaseError;
    if (pendingRenewal) await pendingRenewal;
    if (Date.now() >= expiresAt - LEASE_RENEW_INTERVAL_MS) await renew();
    if (leaseError) throw leaseError;
  };
  activeLeaseRefreshers.set(chatId, { fence, refresh });
  const renewTimer = window.setInterval(() => { void renew(); }, LEASE_RENEW_INTERVAL_MS);
  const onVisible = () => { if (document.visibilityState === 'visible') void renew(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  let writesConfirmed = false;
  try {
    const result = await work(controller.signal);
    if (externalSignal?.aborted) throw externalSignal.reason || new Error('任务已取消');
    await confirmFencedWrites(chatId, fence, controller.signal);
    writesConfirmed = true;
    if (pendingRenewal) await pendingRenewal;
    if (leaseError) throw leaseError;
    return result;
  } finally {
    externalSignal?.removeEventListener('abort', onExternalAbort);
    window.clearInterval(renewTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (activeLeaseRefreshers.get(chatId)?.fence.ownerId === fence.ownerId) activeLeaseRefreshers.delete(chatId);
    if (pendingRenewal) await pendingRenewal;
    if (!writesConfirmed && !leaseError) {
      try {
        await confirmFencedWrites(chatId, fence, controller.signal);
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
