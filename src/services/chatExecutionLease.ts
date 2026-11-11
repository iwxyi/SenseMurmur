import { scopedStorageKey } from '../constants/brand';
import { readAuthSnapshot } from './authSnapshot';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { api } from './api';
import { clearChatExecutionFence, getChatExecutionFence, setChatExecutionFence, type ChatExecutionFence } from './chatExecutionFence';
import { useMessageStore } from '../stores/useMessageStore';
import { useChatStore } from '../stores/useChatStore';

const LEASE_RENEW_INTERVAL_MS = 15_000;
const lostLeases = new Map<string, Error>();

function leaseKey(chatId: string, fence: ChatExecutionFence) {
  return `${chatId}:${fence.ownerId}:${fence.generation}`;
}

function pendingFencedWrites(chatId: string, fence: ChatExecutionFence) {
  const matches = (operation: { executionFence?: ChatExecutionFence; chatId?: string; entityId?: string }) => {
    const operationFence = operation.executionFence;
    return (operation.chatId === chatId || operation.entityId === chatId)
      && operationFence?.ownerId === fence.ownerId && operationFence.generation === fence.generation;
  };
  return useMessageStore.getState().pendingOperations.filter(matches).length
    + useChatStore.getState().pendingOperations.filter(matches).length;
}

async function confirmFencedWrites(chatId: string, fence: ChatExecutionFence) {
  if (!pendingFencedWrites(chatId, fence)) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('本次会话仍有待同步结果；联网后请核对同步状态');
  await useChatStore.getState().flushPendingOperations();
  await useMessageStore.getState().flushPendingOperations();
  await useChatStore.getState().flushPendingOperations();
  if (pendingFencedWrites(chatId, fence)) throw new Error('本次会话仍有待同步结果，请在同步状态中检查后继续');
}

export function assertChatExecutionLease(chatId: string) {
  const auth = readAuthSnapshot();
  if (auth.mode !== 'cloud' || !auth.token || !isCloudSyncEnabled()) return;
  const fence = getChatExecutionFence(chatId);
  if (!fence) return;
  const error = lostLeases.get(leaseKey(chatId, fence));
  if (error) throw error;
}

function getOwnerId() {
  if (typeof sessionStorage === 'undefined') return crypto.randomUUID();
  const key = scopedStorageKey('chat-execution-owner');
  const current = sessionStorage.getItem(key);
  if (current) return current;
  const next = crypto.randomUUID();
  sessionStorage.setItem(key, next);
  return next;
}

export async function runWithChatExecutionLease<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  const auth = readAuthSnapshot();
  if (auth.mode !== 'cloud' || !auth.token || !isCloudSyncEnabled()) return work();

  const ownerId = getOwnerId();
  const lease = await api.acquireChatExecutionLease(chatId, ownerId);
  const fence: ChatExecutionFence = { ownerId, generation: lease.generation };
  lostLeases.delete(leaseKey(chatId, fence));
  setChatExecutionFence(chatId, fence);
  let leaseError: Error | null = null;
  let pendingRenewal: Promise<void> | null = null;
  const renewTimer = window.setInterval(() => {
    if (pendingRenewal || leaseError) return;
    const renewal = api.renewChatExecutionLease(chatId, fence).then(() => undefined).catch((error: unknown) => {
      leaseError = error instanceof Error ? error : new Error('会话运行权已丢失');
      lostLeases.set(leaseKey(chatId, fence), leaseError);
    });
    pendingRenewal = renewal;
    void renewal.finally(() => {
      if (pendingRenewal === renewal) pendingRenewal = null;
    });
  }, LEASE_RENEW_INTERVAL_MS);

  try {
    const result = await work();
    await confirmFencedWrites(chatId, fence);
    if (pendingRenewal) await pendingRenewal;
    if (leaseError) throw leaseError;
    return result;
  } finally {
    window.clearInterval(renewTimer);
    if (pendingRenewal) await pendingRenewal;
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
