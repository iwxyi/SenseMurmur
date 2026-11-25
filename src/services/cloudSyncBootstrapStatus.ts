import { storageKey } from '../constants/brand';

const BOOTSTRAP_STATUS_KEY = storageKey('cloud-sync-bootstrap-status');
export const BOOTSTRAP_STATUS_CONFLICT_DETAIL_LIMIT = 20;

export interface CloudSyncBootstrapCharacterNameConflictDetail {
  localId: string;
  localName: string;
  remoteId: string;
  remoteName: string;
}

export interface CloudSyncBootstrapStatus {
  updatedAt: number;
  state: 'planned' | 'running' | 'succeeded' | 'failed';
  charactersToCreate: number;
  charactersAlreadyRemote: number;
  characterNameConflicts: number;
  chatsToCreate: number;
  chatsAlreadyRemote: number;
  pendingCharacterCreates: number;
  pendingChatCreates: number;
  pendingMessageCreates: number;
  orphanedBranchMessages?: number;
  characterNameConflictDetails?: CloudSyncBootstrapCharacterNameConflictDetail[];
  characterNameConflictDetailOverflow?: number;
  lastError?: string | null;
}

function dispatchBootstrapStatusEvent(status: CloudSyncBootstrapStatus | null) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('pneumata-cloud-sync-bootstrap-status-changed', {
    detail: { status },
  }));
}

export function readCloudSyncBootstrapStatus() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(BOOTSTRAP_STATUS_KEY);
    return raw ? JSON.parse(raw) as CloudSyncBootstrapStatus : null;
  } catch {
    return null;
  }
}

export function writeCloudSyncBootstrapStatus(status: CloudSyncBootstrapStatus) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(BOOTSTRAP_STATUS_KEY, JSON.stringify(status));
  dispatchBootstrapStatusEvent(status);
}

export function clearCloudSyncBootstrapStatus() {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(BOOTSTRAP_STATUS_KEY);
  dispatchBootstrapStatusEvent(null);
}
