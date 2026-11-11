import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from './authStorageScope';

export type WorkflowTaskStatus = 'queued' | 'running' | 'waiting_dependency' | 'waiting_external' | 'waiting_user' | 'result_unknown' | 'completed' | 'failed' | 'cancelled' | 'abandoned';

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
  retryOfRunId?: string;
  retryRootRunId?: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  generation: number;
  planVersion: number;
  resumeCommandIds?: string[];
  planOpen?: boolean;
  autoReview?: boolean;
  pauseRequested?: boolean;
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
    if (task.status === 'abandoned') continue;
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
  reconcileInterrupted?(task: WorkflowTask): Promise<{ status: 'queued' | 'waiting_external' | 'completed' | 'failed'; externalTaskId?: string; output?: unknown; error?: string } | null>;
}

export class WorkflowPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowPreflightError';
  }
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

  async function replaceUserBlockWithTasks(runId: string, expectedPlanVersion: number, additions: WorkflowTask[]) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'paused' || current.run.planVersion !== expectedPlanVersion) throw new Error('团队计划已更新，请刷新后重试');
      const block = current.tasks.find((task) => task.id === 'review_needs_user' && task.status === 'waiting_user');
      if (!block || additions.length !== 1) throw new Error('当前没有可处理的验收阻塞');
      const tasks = [...current.tasks.filter((task) => task.id !== block.id), ...additions];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current,
        run: { ...current.run, autoReview: false, planVersion: current.run.planVersion + 1, updatedAt: Date.now() }, tasks };
      return { snapshot, value: snapshot };
    });
  }

  async function addTeamRevision(runId: string, expectedPlanVersion: number, task: WorkflowTask) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      const completed = current.run.status === 'completed' && !current.run.planOpen && current.tasks.every((item) => item.status === 'completed' || item.status === 'abandoned');
      if (!completed && current.run.status !== 'paused') throw new Error('请先暂停整个团队任务');
      if (task.runId !== runId || task.kind !== 'team_plan_revision' || task.attempt !== 0 || task.status !== 'waiting_dependency') throw new Error('追加任务状态无效');
      const tasks = [...current.tasks, task];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, tasks,
        run: { ...current.run, status: 'paused', planOpen: true, autoReview: false,
          planVersion: current.run.planVersion + 1, generation: completed ? current.run.generation + 1 : current.run.generation, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function blockForUser(runId: string, expectedPlanVersion: number, block: WorkflowTask) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion || current.run.status !== 'active') throw new Error('工作流计划版本冲突');
      if (current.tasks.some((task) => task.id === block.id) || block.runId !== runId || block.status !== 'waiting_user') throw new Error('验收阻塞状态无效');
      const tasks = [...current.tasks, block];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, tasks,
        run: { ...current.run, status: 'paused', planVersion: current.run.planVersion + 1, updatedAt: Date.now() } };
      return { snapshot, value: snapshot };
    });
  }

  async function abandonUnknownReview(runId: string, expectedPlanVersion: number, reviewId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'paused' || current.run.planVersion !== expectedPlanVersion) throw new Error('团队计划已更新，请刷新后重试');
      const target = current.tasks.find((task) => task.id === reviewId && task.kind === 'team_review' && task.status === 'result_unknown');
      if (!target || current.tasks.some((task) => task.id === 'review_needs_user')) throw new Error('当前没有可放弃的待核对验收');
      const now = Date.now();
      const block: WorkflowTask = { id: 'review_needs_user', runId, kind: 'team_review_block', input: null,
        dependsOn: [], status: 'waiting_user', error: '上次主 Agent 验收结果无法核对。请追加明确指示或新建团队任务。', attempt: 0, updatedAt: now };
      const tasks = [...current.tasks.map((task) => task.id === reviewId ? { ...task, status: 'abandoned' as const,
        error: '用户已放弃核对本次验收，原结果仍未知', updatedAt: now } : task), block];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, tasks,
        run: { ...current.run, autoReview: false, planVersion: current.run.planVersion + 1, updatedAt: now } };
      return { snapshot, value: snapshot };
    });
  }

  async function retryFailedReview(runId: string, expectedPlanVersion: number, reviewId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion || current.run.status !== 'failed') throw new Error('团队计划已更新，请刷新后重试');
      const review = current.tasks.find((task) => task.id === reviewId && task.kind === 'team_review' && task.status === 'failed');
      if (!review || current.tasks.some((task) => task.status === 'running' || task.status === 'result_unknown')) throw new Error('当前验收任务不能重试');
      const now = Date.now();
      const snapshot: WorkflowSnapshot = { ...current,
        run: { ...current.run, status: 'paused', planVersion: current.run.planVersion + 1, updatedAt: now },
        tasks: current.tasks.map((task) => task.id === reviewId ? { ...task, status: 'queued', error: undefined, updatedAt: now } : task),
      };
      return { snapshot, value: snapshot };
    });
  }

  async function retryFailedTeamPlan(runId: string, expectedPlanVersion: number, taskId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion || current.run.status !== 'failed') throw new Error('团队计划已更新，请刷新后重试');
      const target = current.tasks.find((task) => task.id === taskId && (task.kind === 'team_plan' || task.kind === 'team_plan_revision') && task.status === 'failed');
      if (!target || current.tasks.some((task) => task.status === 'running' || task.status === 'result_unknown')) throw new Error('当前规划任务不能重试');
      const now = Date.now();
      const snapshot: WorkflowSnapshot = { ...current,
        run: { ...current.run, status: 'paused', planVersion: current.run.planVersion + 1, updatedAt: now },
        tasks: current.tasks.map((task) => task.id === taskId ? { ...task, status: 'queued', error: undefined, updatedAt: now } : task),
      };
      return { snapshot, value: snapshot };
    });
  }

  async function addTasksOnce(runId: string, expectedPlanVersion: number, additions: WorkflowTask[]) {
    if (!additions.length) throw new Error('工作流计划修订不能为空');
    return mutate(scope(), runId, (current) => {
      if (additions.every((task) => current.tasks.some((item) => item.id === task.id))) return { snapshot: current, value: current };
      if (additions.some((task) => current.tasks.some((item) => item.id === task.id))) throw new Error('工作流计划部分任务已存在');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (current.run.status !== 'active' && current.run.status !== 'paused') throw new Error('工作流已结束');
      if (additions.some((task) => task.runId !== runId || (task.status !== 'queued' && task.status !== 'waiting_dependency') || task.attempt !== 0)) throw new Error('新任务状态无效');
      const tasks = [...current.tasks, ...additions];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: Date.now() }, tasks };
      return { snapshot, value: snapshot };
    });
  }

  async function expandPlanOnce(runId: string, expectedPlanVersion: number, sourceTaskId: string, additions: WorkflowTask[]) {
    if (!additions.length) throw new Error('团队计划不能没有任务');
    return mutate(scope(), runId, (current) => {
      const source = current.tasks.find((task) => task.id === sourceTaskId);
      if (!source || source.status !== 'completed') throw new Error('团队规划尚未完成');
      if (additions.every((task) => current.tasks.some((item) => item.id === task.id))) return { snapshot: current, value: current };
      if (additions.some((task) => current.tasks.some((item) => item.id === task.id))) throw new Error('团队计划部分任务已存在');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (current.run.status !== 'active' && current.run.status !== 'paused') throw new Error('工作流已结束');
      if (additions.some((task) => task.runId !== runId || (task.status !== 'queued' && task.status !== 'waiting_dependency') || task.attempt !== 0)) throw new Error('新任务状态无效');
      const tasks = [...current.tasks, ...additions];
      assertTaskGraph(tasks);
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run, planVersion: current.run.planVersion + 1, updatedAt: Date.now() }, tasks };
      return { snapshot, value: snapshot };
    });
  }

  async function closePlan(runId: string, expectedPlanVersion: number) {
    return mutate(scope(), runId, (current) => {
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (current.run.status !== 'active' && current.run.status !== 'paused') throw new Error('工作流已结束');
      const allCompleted = current.tasks.every((task) => task.status === 'completed' || task.status === 'abandoned');
      const snapshot: WorkflowSnapshot = {
        ...current,
        run: { ...current.run, planOpen: false, status: allCompleted ? 'completed' : current.run.status, planVersion: current.run.planVersion + 1, updatedAt: Date.now() },
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
      if (executor.reconcileInterrupted) {
        const interrupted = await repository.read(storageScope, runId);
        for (const task of interrupted?.tasks.filter((item) => item.status === 'running') || []) {
          const result = await executor.reconcileInterrupted(task);
          if (!result) continue;
          await mutate(storageScope, runId, (current) => ({ snapshot: {
            ...current,
            tasks: current.tasks.map((item) => item.id === task.id && item.status === 'running' ? {
              ...item, status: result.status, externalTaskId: result.externalTaskId ?? item.externalTaskId,
              output: result.output ?? item.output, error: result.error, updatedAt: Date.now(),
            } : item),
          }, value: undefined }));
        }
      }
      const inspectedExternalIds = new Set<string>();
      const concurrency = Math.max(1, Math.min(8, Math.floor(maxConcurrentTasks) || 1));
      const alreadyApplied = await mutate(storageScope, runId, (current) => {
        if (commandId && current.run.resumeCommandIds?.includes(commandId)) return { snapshot: current, value: true };
        if (current.run.status === 'completed' || current.run.status === 'cancelled') return { snapshot: current, value: true };
        if (current.run.pauseRequested) return { snapshot: { ...current, run: { ...current.run, status: 'paused', pauseRequested: false, updatedAt: Date.now() } }, value: true };
        return { snapshot: { ...current, run: { ...current.run, status: 'active', pauseRequested: false, generation: current.run.generation + 1, resumeCommandIds: commandId ? [...(current.run.resumeCommandIds || []).slice(-99), commandId] : current.run.resumeCommandIds, updatedAt: Date.now() }, tasks: current.tasks.map((task) => task.status === 'running' ? { ...task, status: 'result_unknown', error: '上次执行中断，需核对结果', updatedAt: Date.now() } : task) }, value: false };
      });
      if (alreadyApplied) {
        const current = await repository.read(storageScope, runId);
        if (!current) throw new Error('工作流不存在');
        return current;
      }
      while (!signal.aborted) {
        if (scope() !== storageScope) break;
        const snapshot = await repository.read(storageScope, runId);
        if (!snapshot || snapshot.run.status !== 'active' || snapshot.run.pauseRequested) break;
        const generation = snapshot.run.generation;
        const completed = new Set(snapshot.tasks.filter((task) => task.status === 'completed').map((task) => task.id));
        const ready = snapshot.tasks.filter((task) => (task.status === 'queued' || task.status === 'waiting_dependency') && task.dependsOn.every((id) => completed.has(id)));
        const external = snapshot.tasks.filter((task) => task.status === 'waiting_external' && task.externalTaskId && executor.inspectExternal && !inspectedExternalIds.has(task.id));
        const batch = [...ready, ...external].slice(0, concurrency);
        if (!batch.length) break;
        const claimed = new Set(batch.filter((task) => ready.includes(task)).map((task) => task.id));
        const dispatchAllowed = await mutate(storageScope, runId, (current) => {
          if (scope() !== storageScope || current.run.generation !== generation || current.run.status !== 'active' || current.run.pauseRequested) {
            return { snapshot: current, value: false };
          }
          return { snapshot: {
            ...current,
            tasks: current.tasks.map((item) => claimed.has(item.id)
              ? { ...item, status: 'running', attempt: item.attempt + 1, updatedAt: Date.now() } : item),
          }, value: true };
        });
        if (!dispatchAllowed) break;
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
            await mutate(storageScope, runId, (current) => ({ snapshot: scope() !== storageScope || current.run.generation !== generation || current.run.status !== 'active' ? current : { ...current, tasks: current.tasks.map((item) => item.id === task.id ? { ...item, status: !isReady ? 'waiting_external' : error instanceof WorkflowPreflightError ? 'failed' : 'result_unknown', error: error instanceof Error ? error.message : '任务状态查询失败', updatedAt: Date.now() } : item) }, value: undefined }));
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
        const completed = !current.run.planOpen && tasks.every((task) => task.status === 'completed' || task.status === 'abandoned');
        const failed = tasks.some((task) => task.status === 'failed');
        const snapshot = { ...current, tasks, run: { ...current.run, status: current.run.status !== 'active' ? current.run.status : signal.aborted || current.run.pauseRequested ? 'paused' as const : completed ? 'completed' as const : failed ? 'failed' as const : current.run.status, pauseRequested: false, updatedAt: Date.now() } };
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

  async function requestPauseAfterCurrentBatch(runId: string) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'active') return { snapshot: current, value: current };
      const snapshot: WorkflowSnapshot = {
        ...current,
        run: { ...current.run, pauseRequested: true, updatedAt: Date.now() },
      };
      return { snapshot, value: snapshot };
    });
  }

  return { create, addTasks, addTeamRevision, replaceUserBlockWithTasks, blockForUser, abandonUnknownReview, retryFailedReview, retryFailedTeamPlan, addTasksOnce, expandPlanOnce, closePlan, resume, pause, requestPauseAfterCurrentBatch, list: () => repository.list(scope()), read: (runId: string) => repository.read(scope(), runId) };
}
