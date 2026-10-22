import { useSettingsStore } from '../stores/useSettingsStore';

export type DeveloperDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

const DIAGNOSTIC_SCOPE_STORAGE_KEY = 'miragetea:developer-diagnostic-scopes';
const DIAGNOSTIC_ENABLED_STORAGE_KEY = 'miragetea:developer-diagnostics-enabled';
const DIAGNOSTIC_BUFFER_STORAGE_KEY = 'miragetea:developer-diagnostics-buffer';
const MAX_DIAGNOSTIC_BUFFER_LENGTH = 500;

// High-frequency lifecycle traces are useful while developing a subsystem,
// but overwhelm the console during normal developer-mode use. Keep warnings
// and errors visible; these routine entries are intentionally opt-out.
const SUPPRESSED_ROUTINE_LOCATIONS = new Set([
  'chat-store:loadChats:start', 'chat-store:loadChats:probe',
  'chat-store:loadChat:start', 'chat-store:loadChat:probe', 'chat-store:loadChat:detail-loaded',
  'chat-store:restoreLocalChats:start',
  'message-window:persist-merge', 'message-window:hydrate-cache-start', 'message-window:hydrate-cache-done',
  'message-window:page-projection', 'message-window:open', 'message-window:hydrated', 'message-window:load-start',
  'message-window:load-fetched', 'message-window:load-merged',
  'chat-detail:bootstrap:start', 'chat-detail:bootstrap:local-chat', 'chat-detail:bootstrap:loaded-chat', 'chat-detail:bootstrap:load-members',
  'chat-detail:open-window:skip-duplicate',
  'chat-window:open', 'manual-input:task-start', 'manual-input:task-finished',
  'chat-scroll:anchor-restored', 'chat-scroll:request-hit', 'chat-scroll:initial-tail-reveal',
  'chat-scroll:position-reported', 'chat-scroll:position-report-skipped',
  'message-window:upsert-many-window',
  'message-pagination:render-state', 'message-pagination:page-state',
  'message-pagination:request', 'message-pagination:result', 'message-pagination:store-merge',
  'chat-scroll:write', 'chat-scroll:reach-top',
  'story-run:start-gate', 'story-run:started', 'story-run:pause-gate',
  'chat-run:modules-ready',
  'html-artifact:click', 'html-artifact:keyboard-open', 'html-artifact:open-request',
  'html-artifact:iframe-load',
]);

interface DeveloperDiagnosticEntry {
  at: string;
  location: string;
  level: DeveloperDiagnosticLevel;
  scope?: string;
  payload: Record<string, unknown>;
}

function safeStorage() {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

export function isDeveloperDiagnosticsEnabled() {
  const storage = safeStorage();
  return Boolean(useSettingsStore.getState().developerMode || storage?.getItem(DIAGNOSTIC_ENABLED_STORAGE_KEY) === '1');
}

function parseDiagnosticScopes(raw: string | null) {
  return new Set((raw || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean));
}

export function isDeveloperDiagnosticScopeEnabled(scope?: string) {
  if (!isDeveloperDiagnosticsEnabled()) return false;
  if (!scope) return true;
  const storage = safeStorage();
  if (!storage) return true;
  const scopes = parseDiagnosticScopes(storage.getItem(DIAGNOSTIC_SCOPE_STORAGE_KEY));
  return scopes.size === 0 || scopes.has('*') || scopes.has(scope);
}

function readDiagnosticBuffer() {
  const storage = safeStorage();
  if (!storage) return [] as DeveloperDiagnosticEntry[];
  try {
    const raw = storage.getItem(DIAGNOSTIC_BUFFER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DeveloperDiagnosticEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeDiagnosticBuffer(entries: DeveloperDiagnosticEntry[]) {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(DIAGNOSTIC_BUFFER_STORAGE_KEY, JSON.stringify(entries.slice(-MAX_DIAGNOSTIC_BUFFER_LENGTH)));
  } catch {
    // ignore quota and serialization failures
  }
}

export function setDeveloperDiagnosticsEnabled(enabled: boolean) {
  const storage = safeStorage();
  if (!storage) return enabled;
  if (enabled) storage.setItem(DIAGNOSTIC_ENABLED_STORAGE_KEY, '1');
  else storage.removeItem(DIAGNOSTIC_ENABLED_STORAGE_KEY);
  return enabled;
}

export function setDeveloperDiagnosticScopes(scopes: string[]) {
  const storage = safeStorage();
  if (!storage) return scopes;
  const normalized = Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
  if (normalized.length === 0) {
    storage.removeItem(DIAGNOSTIC_SCOPE_STORAGE_KEY);
  } else {
    storage.setItem(DIAGNOSTIC_SCOPE_STORAGE_KEY, normalized.join(','));
  }
  return normalized;
}

export function clearDeveloperDiagnostics() {
  const storage = safeStorage();
  if (!storage) return;
  storage.removeItem(DIAGNOSTIC_BUFFER_STORAGE_KEY);
}

export function getDeveloperDiagnostics() {
  return readDiagnosticBuffer();
}

export function logDeveloperDiagnostic(
  location: string,
  payload: Record<string, unknown> = {},
  level: DeveloperDiagnosticLevel = 'debug',
  scope?: string,
) {
  if (!isDeveloperDiagnosticScopeEnabled(scope)) return;
  if (SUPPRESSED_ROUTINE_LOCATIONS.has(location) && level !== 'warn' && level !== 'error') return;
  if (typeof console === 'undefined') return;
  const writer = console[level] || console.debug || console.log;
  if (typeof writer !== 'function') return;
  const entry = {
    at: new Date().toISOString(),
    ...payload,
  };
  writeDiagnosticBuffer([
    ...readDiagnosticBuffer(),
    {
      at: entry.at,
      location,
      level,
      scope,
      payload,
    },
  ]);
  // Scroll traces should remain fully expanded/copyable in browser consoles;
  // logging a live object can be collapsed or rendered with late values.
  if (location.startsWith('chat-scroll:')) {
    writer.call(console, `[dev:${location}] ${JSON.stringify(entry)}`);
  } else {
    writer.call(console, `[dev:${location}]`, entry);
  }
}

export function measureDeveloperDiagnostic<T>(
  location: string,
  run: () => T,
  payload: Record<string, unknown> = {},
  scope?: string,
  warnThresholdMs = 16,
) {
  if (!isDeveloperDiagnosticScopeEnabled(scope) || typeof performance === 'undefined') return run();
  const startedAt = performance.now();
  try {
    return run();
  } finally {
    const durationMs = performance.now() - startedAt;
    logDeveloperDiagnostic(location, {
      ...payload,
      durationMs: Number(durationMs.toFixed(2)),
    }, durationMs >= warnThresholdMs ? 'info' : 'debug', scope);
  }
}
