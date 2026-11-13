import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from './authStorageScope';
import { useAuthStore } from '../stores/useAuthStore';

const DEFAULT_MAX_ACTIVE_CONVERSATIONS = 3;
const MIN_MAX_ACTIVE_CONVERSATIONS = 0;
const listeners = new Set<() => void>();
let memoryPreference: { userId: string; maxActiveConversations: number } | null = null;

function preferenceKey() {
  return scopedStorageKey(`background-execution:${getLocalDataUserId()}`);
}

export function getMaxBackgroundConversationsEntitled() {
  const state = useAuthStore.getState();
  const value = state.authMode === 'cloud' ? state.user?.maxBackgroundConversations : 1;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function clampPreference(value: number) {
  if (!Number.isSafeInteger(value) || value < MIN_MAX_ACTIVE_CONVERSATIONS) return MIN_MAX_ACTIVE_CONVERSATIONS;
  return Math.min(getMaxBackgroundConversationsEntitled(), value);
}

export function getBackgroundExecutionPreferences() {
  const userId = getLocalDataUserId();
  if (typeof localStorage === 'undefined') return { maxActiveConversations: clampPreference(memoryPreference?.userId === userId ? memoryPreference.maxActiveConversations : DEFAULT_MAX_ACTIVE_CONVERSATIONS) };
  try {
    const parsed = JSON.parse(localStorage.getItem(preferenceKey()) || 'null') as { maxActiveConversations?: unknown } | null;
    const value = parsed?.maxActiveConversations;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { maxActiveConversations: clampPreference(value) };
    }
  } catch {
    // Invalid local preferences use the current default.
  }
  return { maxActiveConversations: clampPreference(DEFAULT_MAX_ACTIVE_CONVERSATIONS) };
}

export function setBackgroundExecutionMaxActiveConversations(value: number) {
  const maxActiveConversations = clampPreference(value);
  memoryPreference = { userId: getLocalDataUserId(), maxActiveConversations };
  if (typeof localStorage !== 'undefined') localStorage.setItem(preferenceKey(), JSON.stringify({ maxActiveConversations }));
  listeners.forEach((listener) => listener());
}

export function canContinueConversationsInBackground() {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function'
    && getBackgroundExecutionPreferences().maxActiveConversations > 0;
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

useAuthStore.subscribe((state, previous) => {
  if (state.authMode !== previous.authMode || state.user?.maxBackgroundConversations !== previous.user?.maxBackgroundConversations) {
    listeners.forEach((listener) => listener());
  }
});
