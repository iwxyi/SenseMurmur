import { isCloudSyncEnabled } from '../services/cloudSyncPreference';
import { isCloudSyncBootstrapLocked } from '../services/cloudSyncBootstrapLock';
import { isWorkspaceActive, onWorkspaceShutdown } from '../services/workspaceLifecycle';

type FlushTask = () => Promise<void>;

interface SyncSchedulerOptions {
  priority?: number | (() => number);
}

interface RegisteredLifecycleTask {
  id: string;
  flush: FlushTask;
  delay: number;
  getPriority: () => number;
  schedule: (delay?: number) => void;
  cancel: () => void;
}

const syncWorkers = new Map<string, RegisteredLifecycleTask>();
const workerIdsByFlush = new WeakMap<FlushTask, string>();

let lifecycleListenersRegistered = false;
let anonymousWorkerCounter = 0;

function shouldRunCloudSyncTask() {
  return isWorkspaceActive() && isCloudSyncEnabled() && !isCloudSyncBootstrapLocked();
}

function sortWorkersByPriority() {
  return Array.from(syncWorkers.values())
    .sort((a, b) => b.getPriority() - a.getPriority());
}

function scheduleLifecycleTasks(delayOverride?: number) {
  if (!shouldRunCloudSyncTask()) return;
  const tasks = sortWorkersByPriority();
  tasks.forEach((task, index) => {
    const baseDelay = delayOverride ?? task.delay;
    task.schedule(baseDelay + index * 25);
  });
}

function resolvePriority(priority: SyncSchedulerOptions['priority']) {
  if (typeof priority === 'function') return priority();
  return priority ?? 0;
}

function normalizePriorityGetter(priority: SyncSchedulerOptions['priority']) {
  return () => resolvePriority(priority);
}

export function getSyncWorkerPriority(id: string) {
  return syncWorkers.get(id)?.getPriority() ?? null;
}

export function getRegisteredSyncWorkerEntries() {
  return sortWorkersByPriority().map((worker) => ({
    id: worker.id,
    priority: worker.getPriority(),
    delay: worker.delay,
  }));
}

export function scheduleSyncWorkersByPriority(delay = 0) {
  if (!shouldRunCloudSyncTask()) return [];
  const tasks = sortWorkersByPriority();
  tasks.forEach((task, index) => {
    task.schedule(delay + index * 25);
  });
  return tasks.map((task) => task.id);
}

function cancelLifecycleTasks() {
  for (const task of syncWorkers.values()) {
    task.cancel();
  }
}

onWorkspaceShutdown(cancelLifecycleTasks);

function ensureLifecycleListeners() {
  if (lifecycleListenersRegistered || typeof window === 'undefined' || typeof document === 'undefined') return;
  lifecycleListenersRegistered = true;

  window.addEventListener('online', () => {
    scheduleLifecycleTasks();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleLifecycleTasks();
  });

  window.addEventListener('pneumata-cloud-sync-preference-changed', (event) => {
    const enabled = event instanceof CustomEvent ? Boolean(event.detail?.enabled) : shouldRunCloudSyncTask();
    if (enabled) {
      scheduleLifecycleTasks(100);
    } else {
      cancelLifecycleTasks();
    }
  });

  window.addEventListener('pneumata-cloud-sync-bootstrap-lock-changed', (event) => {
    const locked = event instanceof CustomEvent ? Boolean(event.detail?.locked) : isCloudSyncBootstrapLocked();
    if (locked) {
      cancelLifecycleTasks();
    } else {
      scheduleLifecycleTasks(100);
    }
  });
}

function resolveWorkerId(id: string | undefined, flush: FlushTask) {
  if (id) return id;
  const existing = workerIdsByFlush.get(flush);
  if (existing) return existing;
  anonymousWorkerCounter += 1;
  const next = `anonymous-sync-worker-${anonymousWorkerCounter}`;
  workerIdsByFlush.set(flush, next);
  return next;
}

export function scheduleSyncWorker(id: string, delay = 0) {
  const worker = syncWorkers.get(id);
  if (!worker) return false;
  worker.schedule(delay);
  return true;
}

export function scheduleAllSyncWorkers(delay = 0) {
  scheduleLifecycleTasks(delay);
}

export function getRegisteredSyncWorkerIds() {
  return Array.from(syncWorkers.keys());
}

export function createSyncScheduler(workerId?: string, options: SyncSchedulerOptions = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const getPriority = normalizePriorityGetter(options.priority);

  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (flush: FlushTask, delay = 0) => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (!shouldRunCloudSyncTask()) return;
      void flush();
    }, delay);
  };

  return {
    schedule,
    registerLifecycle(flush: FlushTask, delay = 300) {
      ensureLifecycleListeners();
      if (typeof window === 'undefined') return;
      const id = resolveWorkerId(workerId, flush);
      syncWorkers.set(id, {
        id,
        flush,
        delay,
        getPriority,
        schedule: (nextDelay = delay) => schedule(flush, nextDelay),
        cancel,
      });
    },
  };
}
