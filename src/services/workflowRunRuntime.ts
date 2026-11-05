import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from './authStorageScope';

export type WorkflowTaskStatus = 'queued' | 'running' | 'waiting_dependency' | 'waiting_external' | 'waiting_user' | 'result_unknown' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowTask {
  id: string;
  runId: string;
  dependsOn: string[];
  status: WorkflowTaskStatus;
  kind: string;
  input: unknown;
  output?: unknown;
  externalTaskId?: string;
  error?: string;
  attempt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: string;
  chatId: string;
  goal: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  generation: number;
  planVersion: number;
  resumeCommandIds?: string[];
  updatedAt: number;
}

export interface WorkflowSnapshot {
  run: WorkflowRun;
  tasks: WorkflowTask[];
}

export interface WorkflowResumeSummary {
  completed: string[];
  waiting: string[];
  blocked: Array<{ taskId: string; reason: string }>;
  runnable: string[];
}

export function summarizeWorkflowRun(snapshot: WorkflowSnapshot): WorkflowResumeSummary {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const result: WorkflowResumeSummary = { completed: [], waiting: [], blocked: [], runnable: [] };
  for (const task of snapshot.tasks) {
    if (task.status === 'completed') {
      result.completed.push(task.id);
      continue;
    }
    if (task.status === 'failed' || task.status === 'result_unknown' || task.status === 'waiting_user' || task.status === 'cancelled') {
      result.blocked.push({ taskId: task.id, reason: task.error || task.status });
      continue;
    }
    if (task.dependsOn.some((id) => {
      const dependency = byId.get(id);
      return dependency?.status === 'failed' || dependency?.status === 'result_unknown' || dependency?.status === 'cancelled';
    })) {
      result.blocked.push({ taskId: task.id, reason: '前置任务未完成且需要处理' });
      continue;
    }
    if (task.status === 'waiting_external' || task.status === 'running' || task.dependsOn.some((id) => byId.get(id)?.status !== 'completed')) {
      result.waiting.push(task.id);
      continue;
    }
    result.runnable.push(task.id);
  }
  return result;
}

export interface WorkflowTaskResult {
  output?: unknown;
  externalTaskId?: string;
}

export interface WorkflowExecutor {
  execute(task: WorkflowTask, signal: AbortSignal): Promise<WorkflowTaskResult>;
  inspectExternal?(task: WorkflowTask, signal: AbortSignal): Promise<{ status: 'pending' | 'completed' | 'failed'; output?: unknown; error?: string }>;
}

export interface WorkflowRepository {
  read(scope: string, runId: string): Promise<WorkflowSnapshot | null>;
  list(scope: string): Promise<WorkflowSnapshot[]>;
  transact<T>(scope: string, runId: string, update: (current: WorkflowSnapshot | null) => { snapshot: WorkflowSnapshot; value: T }): Promise<T>;
}

const DB_NAME = 'pneumata-workflow-runs';
const STORE = 'runs';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('此设备不支持工作流持久化'));
  if (dbPromise) return dbPromise;
  const pending: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开工作流存储失败'));
    request.onblocked = () => reject(new Error('工作流存储被其他页面阻塞'));
  });
  dbPromise = pending.catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function rowKey(scope: string, runId: string) {
  return `${scope}\n${runId}`;
}

export function workflowRunLockName(scope: string, runId: string) {
  return `pneumata-workflow-${rowKey(scope, runId)}`;
}

export function currentWorkflowScope() {
  return scopedStorageKey(`workflow-runs-${getLocalDataUserId()}`);
}

export const indexedDbWorkflowRepository: WorkflowRepository = {
  async read(scope, runId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(rowKey(scope, runId));
      request.onsuccess = () => resolve((request.result as WorkflowSnapshot | undefined) || null);
      request.onerror = () => reject(request.error || new Error('读取工作流失败'));
    });
  },
  async list(scope) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const prefix = `${scope}\n`;
      const request = tx.objectStore(STORE).openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      const rows: WorkflowSnapshot[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(rows);
          return;
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) rows.push(cursor.value as WorkflowSnapshot);
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('列出工作流失败'));
    });
  },
  async transact(scope, runId, update) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(rowKey(scope, runId));
      let value: unknown;
      request.onsuccess = () => {
        try {
          const next = update((request.result as WorkflowSnapshot | undefined) || null);
          value = next.value;
          store.put(next.snapshot, rowKey(scope, runId));
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => resolve(value as Awaited<ReturnType<typeof update>>['value']);
      tx.onerror = () => reject(tx.error || new Error('保存工作流失败'));
      tx.onabort = () => reject(tx.error || new Error('工作流事务中止'));
    });
  },
};

function assertTaskGraph(tasks: WorkflowTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('工作流任务 ID 重复');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('工作流任务依赖形成环');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error('工作流任务依赖不存在');
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
}

export function createWorkflowRunRuntime(repository: WorkflowRepository, executor: WorkflowExecutor, scope: () => string = currentWorkflowScope, maxConcurrentTasks = 3) {
  const active = new Map<string, Promise<WorkflowSnapshot>>();
  const mutate = <T>(storageScope: string, runId: string, update: (snapshot: WorkflowSnapshot) => { snapshot: WorkflowSnapshot; value: T }) =>
    repository.transact(storageScope, runId, (current) => {
      if (!current) throw new Error('工作流不存在');
      return update(current);
    });

  async function create(snapshot: WorkflowSnapshot) {
    assertTaskGraph(snapshot.tasks);
    if (snapshot.tasks.some((task) => task.runId !== snapshot.run.id)) throw new Error('任务不属于当前工作流');
    return repository.transact(scope(), snapshot.run.id, (current) => {
      if (current) throw new Error('工作流已经存在');
      return { snapshot, value: snapshot };
    });
  }

  async function addTasks(runId: string, expectedPlanVersion: number, additions: WorkflowTask[]) {
    if (!additions.length) throw new Error('工作流计划修订不能为空');
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'active' && current.run.status !== 'paused') throw new Error('工作流已结束，不能追加任务');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (additions.some((task) => task.runId !== runId || task.status !== 'queued' && task.status !== 'waiting_dependency' || task.attempt !== 0)) {
        throw new Error('新任务的归属或初始状态无效');
      }
      const tasks = [...current.tasks, ...additions];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = {
        ...current,
        run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: Date.now() },
        tasks,
      };
      return { snapshot, value: snapshot };
    });
  }

  async function runWithLock(runId: string, storageScope: string, work: () => Promise<WorkflowSnapshot>) {
    if (typeof navigator === 'undefined') return work();
    if (!navigator.locks?.request) throw new Error('此浏览器不支持安全的多标签页工作流执行');
    const lockName = workflowRunLockName(storageScope, runId);
    return navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('此工作流已在另一个标签页运行');
      return work();
    });
  }

  async function resume(runId: string, signal = new AbortController().signal, commandId?: string): Promise<WorkflowSnapshot> {
    const storageScope = scope();
    const activeKey = rowKey(storageScope, runId);
    const existing = active.get(activeKey);
    if (existing) return existing;
    const operation = runWithLock(runId, storageScope, async () => {
      const inspectedExternalIds = new Set<string>();
      const concurrency = Math.max(1, Math.min(8, Math.floor(maxConcurrentTasks) || 1));
      const alreadyApplied = await mutate(storageScope, runId, (current) => {
        if (commandId && current.run.resumeCommandIds?.includes(commandId)) return { snapshot: current, value: true };
        if (current.run.status === 'completed' || current.run.status === 'cancelled') return { snapshot: current, value: true };
        return { snapshot: { ...current, run: { ...current.run, status: 'active', generation: current.run.generation + 1, resumeCommandIds: commandId ? [...(current.run.resumeCommandIds || []).slice(-99), commandId] : current.run.resumeCommandIds, updatedAt: Date.now() }, tasks: current.tasks.map((task) => task.status === 'running' ? { ...task, status: 'result_unknown', error: '上次执行中断，需核对结果', updatedAt: Date.now() } : task) }, value: false };
      });
      if (alreadyApplied) {
        const current = await repository.read(storageScope, runId);
        if (!current) throw new Error('工作流不存在');
        return current;
      }
      while (!signal.aborted) {
        if (scope() !== storageScope) break;
        const snapshot = await repository.read(storageScope, runId);
        if (!snapshot || snapshot.run.status !== 'active') break;
        const generation = snapshot.run.generation;
        const completed = new Set(snapshot.tasks.filter((task) => task.status === 'completed').map((task) => task.id));
        const ready = snapshot.tasks.filter((task) => (task.status === 'queued' || task.status === 'waiting_dependency') && task.dependsOn.every((id) => completed.has(id)));
        const external = snapshot.tasks.filter((task) => task.status === 'waiting_external' && task.externalTaskId && executor.inspectExternal && !inspectedExternalIds.has(task.id));
        const batch = [...ready, ...external].slice(0, concurrency);
        if (!batch.length) break;
        const claimed = new Set(batch.filter((task) => ready.includes(task)).map((task) => task.id));
        await mutate(storageScope, runId, (current) => ({ snapshot: {
          ...current,
          tasks: current.tasks.map((item) => claimed.has(item.id)
            ? { ...item, status: 'running', attempt: item.attempt + 1, updatedAt: Date.now() } : item),
        }, value: undefined }));
        await Promise.all(batch.map(async (task) => {
          const isReady = claimed.has(task.id);
          try {
            const result = isReady ? await executor.execute(task, signal) : await executor.inspectExternal!(task, signal);
            await mutate(storageScope, runId, (current) => ({ snapshot: scope() !== storageScope || current.run.generation !== generation || current.run.status !== 'active' ? current : {
              ...current,
              tasks: current.tasks.map((item) => item.id === task.id ? {
                ...item,
                status: 'status' in result ? result.status === 'pending' ? 'waiting_external' : result.status === 'failed' ? 'failed' : 'completed' : result.externalTaskId ? 'waiting_external' : 'completed',
                output: result.output ?? item.output,
                externalTaskId: 'externalTaskId' in result ? result.externalTaskId : item.externalTaskId,
                error: 'error' in result ? result.error : undefined,
                updatedAt: Date.now(),
              } : item),
            }, value: undefined }));
            if ('status' in result && result.status === 'pending') inspectedExternalIds.add(task.id);
          } catch (error) {
            await mutate(storageScope, runId, (current) => ({ snapshot: scope() !== storageScope || current.run.generation !== generation || current.run.status !== 'active' ? current : { ...current, tasks: current.tasks.map((item) => item.id === task.id ? { ...item, status: isReady ? 'result_unknown' : 'waiting_external', error: error instanceof Error ? error.message : '任务状态查询失败', updatedAt: Date.now() } : item) }, value: undefined }));
            if (!isReady) inspectedExternalIds.add(task.id);
          }
        }));
      }
      return mutate(storageScope, runId, (current) => {
        const tasks = signal.aborted
          ? current.tasks.map((task) => task.status === 'running'
            ? { ...task, status: 'result_unknown' as const, error: '请求已中断，结果需要核对', updatedAt: Date.now() }
            : task)
          : current.tasks;
        const completed = tasks.every((task) => task.status === 'completed');
        const failed = tasks.some((task) => task.status === 'failed');
        const snapshot = { ...current, tasks, run: { ...current.run, status: current.run.status !== 'active' ? current.run.status : signal.aborted ? 'paused' as const : completed ? 'completed' as const : failed ? 'failed' as const : current.run.status } };
        return { snapshot, value: snapshot };
      });
    }).finally(() => active.delete(activeKey));
    active.set(activeKey, operation);
    return operation;
  }

  async function pause(runId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status === 'completed' || current.run.status === 'cancelled') return { snapshot: current, value: current };
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run, status: 'paused', generation: current.run.generation + 1, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  return { create, addTasks, resume, pause, list: () => repository.list(scope()), read: (runId: string) => repository.read(scope(), runId) };
}
