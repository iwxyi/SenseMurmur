import { readAuthSnapshot } from './authSnapshot';
import { backendUrl } from './backendUrl';
import { assertWorkspaceActive, getWorkspaceSignal, onWorkspaceShutdown, workspaceFetch } from './workspaceLifecycle';

const API_BASE = '/api';
const ANONYMOUS_ID_KEY = 'pneumata.appUsage.anonymousId';
const HEARTBEAT_INTERVAL_MS = 60_000;
const ID_LIKE_SEGMENT_PATTERN = /^[0-9a-f]{8,}-[0-9a-f-]{13,}$|^[A-Za-z0-9_-]{16,}$/i;

type UsageSessionStartResponse = {
  sessionId: string;
  heartbeatIntervalMs?: number;
};

function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getAppUsageAnonymousId() {
  try {
    const existing = localStorage.getItem(ANONYMOUS_ID_KEY);
    if (existing) return existing;
    const next = randomId();
    localStorage.setItem(ANONYMOUS_ID_KEY, next);
    return next;
  } catch {
    return randomId();
  }
}

function getAuthHeaders() {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = readAuthSnapshot().token;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    return headers;
  }
  return headers;
}

function normalizeUsagePath(path: string) {
  const rawPathname = path.split(/[?#]/)[0] || '/';
  const pathname = rawPathname.startsWith('/') ? rawPathname : `/${rawPathname}`;
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length) return '/';
  if (segments[0] === 'chats' && segments.length >= 2) {
    if (segments[1] === 'create') return '/chats/create';
    return segments[2] === 'edit' ? '/chats/:id/edit' : '/chats/:id';
  }
  if (segments[0] === 'characters' && segments.length >= 2) {
    if (segments[1] === 'create' || segments[1] === 'batch-generate') return `/${segments.slice(0, 2).join('/')}`;
    return segments[2] === 'edit' ? '/characters/:id/edit' : '/characters/:id';
  }
  if (segments[0] === 'shared') return '/shared/:token';
  return `/${segments.map((segment) => (ID_LIKE_SEGMENT_PATTERN.test(segment) ? ':id' : segment)).join('/')}`.slice(0, 255);
}

export function currentUsagePath() {
  if (typeof window === 'undefined') return '/';
  return normalizeUsagePath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const signal = getWorkspaceSignal();
  const response = await workspaceFetch(backendUrl(`${API_BASE}${path}`), {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
    keepalive: true,
  });
  if (!response.ok) throw new Error(`Usage session request failed: ${response.status}`);
  const result = await response.json() as T;
  assertWorkspaceActive(signal);
  return result;
}

export class AppUsageSessionClient {
  private sessionId: string | null = null;
  private heartbeatTimer: number | null = null;
  private heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
  private lastHeartbeatPath = '';
  private stopped = false;
  private unsubscribeShutdown: (() => void) | null = null;

  async start(path = currentUsagePath()) {
    this.stopped = false;
    this.unsubscribeShutdown?.();
    this.unsubscribeShutdown = onWorkspaceShutdown(() => this.end(path));
    const result = await postJson<UsageSessionStartResponse>('/usage/sessions/start', {
      anonymousId: getAppUsageAnonymousId(),
      path,
    });
    if (this.stopped) return;
    this.sessionId = result.sessionId;
    this.heartbeatIntervalMs = Number(result.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS);
    this.lastHeartbeatPath = path;
    this.scheduleHeartbeat();
  }

  heartbeat(path = currentUsagePath()) {
    if (!this.sessionId || this.stopped) return Promise.resolve();
    this.lastHeartbeatPath = path;
    return postJson<{ ok: boolean }>(`/usage/sessions/${encodeURIComponent(this.sessionId)}/heartbeat`, {
      anonymousId: getAppUsageAnonymousId(),
      path,
    }).catch(() => undefined);
  }

  end(path = currentUsagePath()) {
    this.unsubscribeShutdown?.();
    this.unsubscribeShutdown = null;
    this.stopped = true;
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    const body = JSON.stringify({ anonymousId: getAppUsageAnonymousId(), path });
    const url = backendUrl(`${API_BASE}/usage/sessions/${encodeURIComponent(sessionId)}/end`);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return;
    }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  }

  private scheduleHeartbeat() {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => {
      void this.heartbeat();
    }, this.heartbeatIntervalMs);
  }
}
