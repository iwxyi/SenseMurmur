import { scopedStorageKey } from '../constants/brand';
import { readAuthSnapshot } from './authSnapshot';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { api } from './api';
import { clearChatExecutionFence, getChatExecutionFence, setChatExecutionFence, type ChatExecutionFence } from './chatExecutionFence';

const LEASE_RENEW_INTERVAL_MS = 15_000;
const lostLeases = new Map<string, Error>();

function leaseKey(chatId: string, fence: ChatExecutionFence) {
  return `${chatId}:${fence.ownerId}:${fence.generation}`;
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
  const renewTimer = window.setInterval(() => {
    void api.renewChatExecutionLease(chatId, fence).catch((error: unknown) => {
      leaseError = error instanceof Error ? error : new Error('会话运行权已丢失');
      lostLeases.set(leaseKey(chatId, fence), leaseError);
    });
  }, LEASE_RENEW_INTERVAL_MS);

  try {
    const result = await work();
    if (leaseError) throw leaseError;
    return result;
  } finally {
    window.clearInterval(renewTimer);
    try {
      await api.releaseChatExecutionLease(chatId, fence);
    } finally {
      clearChatExecutionFence(chatId, fence);
      lostLeases.delete(leaseKey(chatId, fence));
    }
  }
}
