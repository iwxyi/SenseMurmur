import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from './authStorageScope';

const DEFAULT_MAX_ACTIVE_CONVERSATIONS = 3;
const MIN_MAX_ACTIVE_CONVERSATIONS = 1;
const MAX_MAX_ACTIVE_CONVERSATIONS = 3;
const listeners = new Set<() => void>();
let memoryPreference: { userId: string; maxActiveConversations: number } | null = null;

function preferenceKey() {
  return scopedStorageKey(`background-execution:${getLocalDataUserId()}`);
}

export function getBackgroundExecutionPreferences() {
  const userId = getLocalDataUserId();
  if (typeof localStorage === 'undefined') return { maxActiveConversations: memoryPreference?.userId === userId ? memoryPreference.maxActiveConversations : DEFAULT_MAX_ACTIVE_CONVERSATIONS };
  try {
    const parsed = JSON.parse(localStorage.getItem(preferenceKey()) || 'null') as { maxActiveConversations?: unknown } | null;
    const value = parsed?.maxActiveConversations;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { maxActiveConversations: Math.max(MIN_MAX_ACTIVE_CONVERSATIONS, Math.min(MAX_MAX_ACTIVE_CONVERSATIONS, Math.floor(value))) };
    }
  } catch {
    // Invalid local preferences use the current default.
  }
  return { maxActiveConversations: DEFAULT_MAX_ACTIVE_CONVERSATIONS };
}

export function setBackgroundExecutionMaxActiveConversations(value: number) {
  const maxActiveConversations = Math.max(MIN_MAX_ACTIVE_CONVERSATIONS, Math.min(MAX_MAX_ACTIVE_CONVERSATIONS, Math.floor(value)));
  memoryPreference = { userId: getLocalDataUserId(), maxActiveConversations };
  if (typeof localStorage !== 'undefined') localStorage.setItem(preferenceKey(), JSON.stringify({ maxActiveConversations }));
  listeners.forEach((listener) => listener());
}

export function subscribeBackgroundExecutionPreferences(listener: () => void) {
  listeners.add(listener);
  if (typeof window !== 'undefined') {
    const onStorage = (event: StorageEvent) => { if (event.key === preferenceKey()) listener(); };
    window.addEventListener('storage', onStorage);
    return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
  }
  return () => { listeners.delete(listener); };
}
