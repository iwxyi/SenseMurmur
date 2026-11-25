type RuntimeMemoryMonitorModule = typeof import('./runtimeMemoryMonitor');
type LocalPersistenceDiagnosticsModule = typeof import('./localPersistenceDiagnostics');
type DeveloperDiagnosticsModule = typeof import('./developerDiagnostics');
type RuntimeMemoryBootstrapApi = {
  enable: () => boolean;
  disable: () => boolean;
  verbose: (enabled?: boolean) => boolean;
  isEnabled: () => boolean;
  enableBrowserRuntimeCounters: () => Promise<unknown>;
  areBrowserRuntimeCountersEnabled: () => Promise<unknown>;
  clear: () => Promise<unknown>;
  cleanup: () => Promise<unknown>;
  export: () => Promise<unknown>;
  latest: (count?: number) => Promise<unknown>;
  summary: () => Promise<unknown>;
  snapshot: () => Promise<unknown>;
  gcSnapshot: () => Promise<unknown>;
  mark: () => Promise<unknown>;
  diff: () => Promise<unknown>;
  watch: (options?: { intervalMs?: number; limit?: number }) => Promise<unknown>;
};
type DeveloperDiagnosticsBootstrapApi = {
  enable: () => boolean;
  disable: () => boolean;
  isEnabled: () => boolean;
  scopes: (value?: string | string[]) => string[];
  latest: (count?: number) => unknown[];
  clear: () => void;
  export: () => unknown[];
};

const MEMORY_MONITOR_KEY = 'pneumata-runtime-memory-monitor';
const MEMORY_MONITOR_VERBOSE_KEY = 'pneumata-runtime-memory-monitor-verbose';

let runtimeMemoryMonitorPromise: Promise<RuntimeMemoryMonitorModule> | null = null;
let persistenceDiagnosticsPromise: Promise<LocalPersistenceDiagnosticsModule> | null = null;
let developerDiagnosticsPromise: Promise<DeveloperDiagnosticsModule> | null = null;
let runtimeMemoryMonitorBootstrapApi: RuntimeMemoryBootstrapApi | null = null;
let developerDiagnosticsBootstrapApi: DeveloperDiagnosticsBootstrapApi | null = null;

function diagnosticsWindow() {
  return window as unknown as {
    __PNEUMATA_MEMORY_MONITOR__?: RuntimeMemoryBootstrapApi | Record<string, (...args: unknown[]) => unknown>;
    __PNEUMATA_PERSISTENCE_DIAGNOSTICS__?: Record<string, unknown>;
    __SENSE_MURMUR_DIAGNOSTICS__?: DeveloperDiagnosticsBootstrapApi;
    __PNEUMATA_DEVELOPER_DIAGNOSTICS__?: DeveloperDiagnosticsBootstrapApi;
  };
}

function loadRuntimeMemoryMonitor() {
  runtimeMemoryMonitorPromise ??= (async () => {
    if (
      typeof window !== 'undefined'
      && runtimeMemoryMonitorBootstrapApi
      && diagnosticsWindow().__PNEUMATA_MEMORY_MONITOR__ === runtimeMemoryMonitorBootstrapApi
    ) {
      delete diagnosticsWindow().__PNEUMATA_MEMORY_MONITOR__;
    }
    return import('./runtimeMemoryMonitor');
  })();
  return runtimeMemoryMonitorPromise;
}

async function getRuntimeMemoryMonitorApi() {
  await loadRuntimeMemoryMonitor();
  return diagnosticsWindow().__PNEUMATA_MEMORY_MONITOR__ as Record<string, (...args: unknown[]) => unknown> | undefined;
}

function loadPersistenceDiagnostics() {
  persistenceDiagnosticsPromise ??= import('./localPersistenceDiagnostics');
  return persistenceDiagnosticsPromise;
}

function loadDeveloperDiagnostics() {
  developerDiagnosticsPromise ??= import('./developerDiagnostics');
  return developerDiagnosticsPromise;
}

function readBooleanFlag(key: string) {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(key) === '1';
}

function writeBooleanFlag(key: string, value: boolean) {
  if (typeof localStorage === 'undefined') return value;
  if (value) localStorage.setItem(key, '1');
  else localStorage.removeItem(key);
  return value;
}

function installDiagnosticsBootstrap() {
  if (typeof window === 'undefined') return;
  const target = diagnosticsWindow();

  if (!target.__PNEUMATA_MEMORY_MONITOR__) {
    runtimeMemoryMonitorBootstrapApi = {
      enable: () => writeBooleanFlag(MEMORY_MONITOR_KEY, true),
      disable: () => writeBooleanFlag(MEMORY_MONITOR_KEY, false),
      verbose: (enabled?: boolean) => typeof enabled === 'boolean'
        ? writeBooleanFlag(MEMORY_MONITOR_VERBOSE_KEY, enabled)
        : readBooleanFlag(MEMORY_MONITOR_VERBOSE_KEY),
      isEnabled: () => readBooleanFlag(MEMORY_MONITOR_KEY),
      enableBrowserRuntimeCounters: async () => (await getRuntimeMemoryMonitorApi())?.enableBrowserRuntimeCounters?.(),
      areBrowserRuntimeCountersEnabled: async () => (await getRuntimeMemoryMonitorApi())?.areBrowserRuntimeCountersEnabled?.(),
      clear: async () => (await getRuntimeMemoryMonitorApi())?.clear?.(),
      cleanup: async () => (await getRuntimeMemoryMonitorApi())?.cleanup?.(),
      export: async () => (await getRuntimeMemoryMonitorApi())?.export?.(),
      latest: async (count?: number) => (await getRuntimeMemoryMonitorApi())?.latest?.(count),
      summary: async () => (await getRuntimeMemoryMonitorApi())?.summary?.(),
      snapshot: async () => (await getRuntimeMemoryMonitorApi())?.snapshot?.(),
      gcSnapshot: async () => (await getRuntimeMemoryMonitorApi())?.gcSnapshot?.(),
      mark: async () => (await getRuntimeMemoryMonitorApi())?.mark?.(),
      diff: async () => (await getRuntimeMemoryMonitorApi())?.diff?.(),
      watch: async (options?: { intervalMs?: number; limit?: number }) => (await getRuntimeMemoryMonitorApi())?.watch?.(options),
    };
    target.__PNEUMATA_MEMORY_MONITOR__ = runtimeMemoryMonitorBootstrapApi;
  }

  if (!target.__SENSE_MURMUR_DIAGNOSTICS__) {
    developerDiagnosticsBootstrapApi = {
      enable: () => {
        void loadDeveloperDiagnostics().then(({ logDeveloperDiagnostic }) => {
          logDeveloperDiagnostic('diagnostics:enabled', { scopes: localStorage.getItem('miragetea:developer-diagnostic-scopes') || '*' }, 'info', 'diagnostics');
        });
        return writeBooleanFlag('miragetea:developer-diagnostics-enabled', true);
      },
      disable: () => writeBooleanFlag('miragetea:developer-diagnostics-enabled', false),
      isEnabled: () => readBooleanFlag('miragetea:developer-diagnostics-enabled'),
      scopes: (value?: string | string[]) => {
        if (value !== undefined) {
          const scopes = Array.isArray(value) ? value : value.split(',');
          void loadDeveloperDiagnostics().then(({ setDeveloperDiagnosticScopes }) => setDeveloperDiagnosticScopes(scopes));
          return scopes.map((scope) => scope.trim()).filter(Boolean);
        }
        return (localStorage.getItem('miragetea:developer-diagnostic-scopes') || '')
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean);
      },
      latest: (count = 50) => {
        try {
          const entries = JSON.parse(localStorage.getItem('miragetea:developer-diagnostics-buffer') || '[]') as unknown[];
          return entries.slice(-count);
        } catch {
          return [];
        }
      },
      clear: () => {
        void loadDeveloperDiagnostics().then(({ clearDeveloperDiagnostics }) => clearDeveloperDiagnostics());
      },
      export: () => {
        try {
          const entries = JSON.parse(localStorage.getItem('miragetea:developer-diagnostics-buffer') || '[]') as unknown[];
          console.info(`[developer-diagnostics] ${entries.length} 条记录已返回；控制台仅显示摘要`);
          return entries;
        } catch {
          return [];
        }
      },
    };
    target.__SENSE_MURMUR_DIAGNOSTICS__ = developerDiagnosticsBootstrapApi;
    target.__PNEUMATA_DEVELOPER_DIAGNOSTICS__ = developerDiagnosticsBootstrapApi;
  }

  target.__PNEUMATA_PERSISTENCE_DIAGNOSTICS__ = target.__PNEUMATA_PERSISTENCE_DIAGNOSTICS__ || {
    snapshot: async (limit = 20) => {
      const { buildLocalPersistenceDiagnostics } = await loadPersistenceDiagnostics();
      const snapshot = await buildLocalPersistenceDiagnostics(limit);
      console.info('[persistence-diagnostics] snapshot', snapshot);
      return snapshot;
    },
  };
}

installDiagnosticsBootstrap();
