import { scopedStorageKey } from '../constants/brand';

function key(userId: string) {
  return scopedStorageKey(`account-cloud-bootstrap-v1-${userId}`);
}

export function needsAccountCloudBootstrap(userId: string) {
  return localStorage.getItem(key(userId)) !== 'ready';
}

export function isAccountCloudBootstrapPending(userId: string) {
  return localStorage.getItem(key(userId)) === 'pending';
}

export function markAccountCloudBootstrapPending(userId: string) {
  localStorage.setItem(key(userId), 'pending');
}

export function markAccountCloudBootstrapReady(userId: string) {
  localStorage.setItem(key(userId), 'ready');
}
