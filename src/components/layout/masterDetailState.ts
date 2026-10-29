import { useSyncExternalStore } from 'react';
import { storageKey } from '../../constants/brand';

export const DETAIL_COLLAPSED_STORAGE_KEY = storageKey('master-detail-detail-collapsed');
export const DETAIL_COLLAPSED_CHANGE_EVENT = 'pneumata-master-detail-detail-collapsed-change';

export function readDetailCollapsedState() {
  return typeof localStorage !== 'undefined' && localStorage.getItem(DETAIL_COLLAPSED_STORAGE_KEY) === '1';
}

function subscribeDetailCollapsed(onChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === DETAIL_COLLAPSED_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener(DETAIL_COLLAPSED_CHANGE_EVENT, onChange);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(DETAIL_COLLAPSED_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', handleStorage);
  };
}

export function useDetailCollapsedState() {
  // Activity pauses subscriptions while hidden; React rechecks this snapshot on reveal.
  return useSyncExternalStore(subscribeDetailCollapsed, readDetailCollapsedState, () => false);
}

export function writeDetailCollapsedState(collapsed: boolean) {
  localStorage.setItem(DETAIL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  window.dispatchEvent(new CustomEvent(DETAIL_COLLAPSED_CHANGE_EVENT, { detail: { collapsed } }));
}
