import { storageKey } from '../constants/brand';
import { AUTH_SNAPSHOT_KEY, readAuthSnapshot } from './authSnapshot';

const AUTH_KEYS = new Set([AUTH_SNAPSHOT_KEY, ...['user', 'auth-mode', 'token', 'workspace-generation'].map(storageKey)]);

interface WorkspaceIdentity {
  generation: string | null;
  userId: string | null;
  mode: string | null;
  hasToken: boolean;
  dataUserId: string;
}

let identity: WorkspaceIdentity | null = null;
let controller = new AbortController();
let retired = false;
let navigateToLogin: ((path?: string) => void) | null = null;
const shutdownListeners = new Set<() => void>();
const responseSignals = new WeakMap<Response, AbortSignal>();

export function getResponseWorkspaceSignal(response: Response) {
  return responseSignals.get(response) ?? getWorkspaceSignal();
}

function readIdentity(): WorkspaceIdentity {
  const session = readAuthSnapshot();
  const userId = session.user?.id || null;
  const mode = session.mode;
  const hasToken = Boolean(session.token);
  return {
    generation: session.generation, userId, mode, hasToken,
    dataUserId: userId || ((hasToken || mode === 'cloud') && typeof localStorage !== 'undefined'
      ? localStorage.getItem(storageKey('last-cloud-user-id')) : null) || 'guest',
  };
}

export function onWorkspaceShutdown(listener: () => void) {
  shutdownListeners.add(listener);
  return () => { shutdownListeners.delete(listener); };
}

export function stopWorkspace() {
  if (retired) return;
  retired = true;
  controller.abort(new DOMException('账号已退出或切换', 'AbortError'));
  for (const listener of shutdownListeners) {
    try {
      listener();
    } catch (error) {
      console.error('[workspace] shutdown failed', { error });
    }
  }
}

export function isWorkspaceActive() {
  if (!identity) return !retired;
  if (retired) return false;
  const current = readIdentity();
  if (current.generation !== identity.generation || current.userId !== identity.userId
    || current.mode !== identity.mode || current.hasToken !== identity.hasToken) {
    stopWorkspace();
    navigateToLogin?.();
    return false;
  }
  return true;
}

export function getWorkspaceSignal() {
  isWorkspaceActive();
  return controller.signal;
}

export function assertWorkspaceActive(signal = getWorkspaceSignal()) {
  isWorkspaceActive();
  signal.throwIfAborted();
}

export function getWorkspaceDataUserId() {
  if (!identity) return undefined;
  isWorkspaceActive();
  return identity.dataUserId;
}

/** Called only by this tab's successful login, after all credentials are stored. */
export function adoptWorkspaceSession() {
  stopWorkspace();
  controller = new AbortController();
  retired = false;
  if (identity) identity = readIdentity();
}

export function reloadWorkspaceAtLogin(path = '/login') {
  if (navigateToLogin) navigateToLogin(path);
  else if (typeof window !== 'undefined') window.location.reload();
}

export function initializeWorkspaceLifecycle(onAccountChange: (path?: string) => void) {
  identity = readIdentity();
  retired = false;
  controller = new AbortController();
  navigateToLogin = onAccountChange;
  const check = () => { isWorkspaceActive(); };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (event.key === null || AUTH_KEYS.has(event.key)) check();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', check);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', check);
    window.removeEventListener('pageshow', check);
    document.removeEventListener('visibilitychange', check);
    identity = null;
    navigateToLogin = null;
    retired = false;
    controller = new AbortController();
  };
}

/** One abort signal covers backend requests, third-party AI and response streams. */
export async function workspaceFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const signal = getWorkspaceSignal();
  assertWorkspaceActive(signal);
  const callerSignal = init.signal || (input instanceof Request ? input.signal : null);
  const requestSignal = callerSignal ? AbortSignal.any([signal, callerSignal]) : signal;
  const response = await globalThis.fetch(input, { ...init, signal: requestSignal });
  assertWorkspaceActive(signal);
  responseSignals.set(response, signal);
  return response;
}
