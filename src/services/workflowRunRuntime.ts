import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from './authStorageScope';
import { claimedTaskAttempt, parseWorkflowTaskAttempt, settleTaskAttempt, type WorkflowTaskAttempt } from './workflowTaskAttempt';

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
  deliveryStatus?: 'pending' | 'published';
  maxModelCalls?: number;
  updatedAt: number;
}

export interface WorkflowSnapshot {
  schemaVersion?: 1;
  run: WorkflowRun;
  tasks: WorkflowTask[];
}

export interface WorkflowEvent {
  eventId: string;
  aggregateVersion: number;
  sequence: number;
  runId: string;
  occurredAt: number;
  runStatus: WorkflowRun['status'];
  generation: number;
  planVersion: number;
  changedTasks: Array<{ id: string; status: WorkflowTaskStatus | 'removed'; attempt: number }>;
}

const RUN_STATUSES = new Set<WorkflowRun['status']>(['active', 'paused', 'completed', 'failed', 'cancelled']);
const TASK_STATUSES = new Set<WorkflowTaskStatus>([
  'queued', 'running', 'waiting_dependency', 'waiting_external', 'waiting_user',
  'result_unknown', 'completed', 'failed', 'cancelled', 'abandoned',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`工作流${label}无效`);
}

function assertWorkflowSnapshot(value: unknown): asserts value is WorkflowSnapshot {
  if (!isRecord(value) || !isRecord(value.run) || !Array.isArray(value.tasks)) throw new Error('工作流快照结构无效');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('工作流快照版本不受支持');
  const run = value.run;
  assertNonEmptyString(run.id, '运行 ID');
  assertNonEmptyString(run.chatId, '会话 ID');
  assertNonEmptyString(run.goal, '目标');
  if (!RUN_STATUSES.has(run.status as WorkflowRun['status'])) throw new Error('工作流运行状态无效');
  if (!Number.isSafeInteger(run.generation) || (run.generation as number) < 0) throw new Error('工作流运行代次无效');
  if (!Number.isSafeInteger(run.planVersion) || (run.planVersion as number) < 1) throw new Error('工作流计划版本无效');
  if (!Number.isFinite(run.updatedAt)) throw new Error('工作流更新时间无效');
  if (run.resumeCommandIds !== undefined && (!Array.isArray(run.resumeCommandIds) || run.resumeCommandIds.some((id) => typeof id !== 'string' || !id))) {
    throw new Error('工作流恢复命令记录无效');
  }
  if (run.deliveryStatus !== undefined && run.deliveryStatus !== 'pending' && run.deliveryStatus !== 'published') throw new Error('工作流交付状态无效');
  if (run.maxModelCalls !== undefined && (!Number.isSafeInteger(run.maxModelCalls) || (run.maxModelCalls as number) < 1 || (run.maxModelCalls as number) > 1000)) throw new Error('工作流模型调用上限无效');

  const taskIds = new Set<string>();
  for (const candidate of value.tasks) {
    if (!isRecord(candidate)) throw new Error('工作流任务结构无效');
    assertNonEmptyString(candidate.id, '任务 ID');
    assertNonEmptyString(candidate.runId, '任务运行 ID');
    assertNonEmptyString(candidate.kind, '任务类型');
    if (candidate.runId !== run.id) throw new Error('工作流任务不属于当前运行');
    if (taskIds.has(candidate.id)) throw new Error('工作流任务 ID 重复');
    taskIds.add(candidate.id);
    if (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some((id) => typeof id !== 'string' || !id)) throw new Error('工作流任务依赖无效');
    if (new Set(candidate.dependsOn).size !== candidate.dependsOn.length) throw new Error('工作流任务依赖重复');
    if (!TASK_STATUSES.has(candidate.status as WorkflowTaskStatus)) throw new Error('工作流任务状态无效');
    if (!Number.isSafeInteger(candidate.attempt) || (candidate.attempt as number) < 0) throw new Error('工作流任务尝试次数无效');
    if (!Number.isFinite(candidate.updatedAt)) throw new Error('工作流任务更新时间无效');
    for (const field of ['externalTaskId', 'error'] as const) {
      if (candidate[field] !== undefined && typeof candidate[field] !== 'string') throw new Error(`工作流任务${field}无效`);
    }
  }
  assertTaskGraph(value.tasks as WorkflowTask[]);
}

function migrateWorkflowSnapshot(value: unknown): WorkflowSnapshot {
  assertWorkflowSnapshot(value);
  return value.schemaVersion === 1 ? value : { ...value, schemaVersion: 1 };
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

export function countWorkflowModelCalls(snapshot: WorkflowSnapshot): number {
  return snapshot.tasks.filter((task) => task.kind === 'team_plan' || task.kind === 'team_plan_revision'
    || task.kind === 'team_review' || task.kind === 'agent_text' || task.kind === 'agent_image_inspection')
    .reduce((total, task) => total + task.attempt, 0);
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
  listTaskAttempts(scope: string, runId: string, taskId: string): Promise<WorkflowTaskAttempt[]>;
  read(scope: string, runId: string): Promise<WorkflowSnapshot | null>;
  list(scope: string): Promise<WorkflowSnapshot[]>;
  listEvents(scope: string, runId: string, afterSequence?: number): Promise<WorkflowEvent[]>;
  registerOutboxConsumer(scope: string, runId: string, consumerId: string): Promise<void>;
  listOutboxEvents(scope: string, runId: string, consumerId: string, limit?: number): Promise<WorkflowEvent[]>;
  acknowledgeOutboxEvents(scope: string, runId: string, consumerId: string, throughSequence: number): Promise<void>;
  transact<T>(scope: string, runId: string, update: (current: WorkflowSnapshot | null) => { snapshot: WorkflowSnapshot; value: T }): Promise<T>;
}

const DB_NAME = 'pneumata-workflow-runs';
const STORE = 'runs';
const EVENT_STORE = 'events';
const OUTBOX_STORE = 'outbox';
const CONSUMER_STORE = 'outbox_consumers';
const ATTEMPT_STORE = 'task_attempts';
const EVENT_RETENTION_PER_RUN = 256;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('此设备不支持工作流持久化'));
  if (dbPromise) return dbPromise;
  const pending: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 4);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      if (!database.objectStoreNames.contains(EVENT_STORE)) database.createObjectStore(EVENT_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) database.createObjectStore(OUTBOX_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(CONSUMER_STORE)) database.createObjectStore(CONSUMER_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(ATTEMPT_STORE)) database.createObjectStore(ATTEMPT_STORE);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); dbPromise = null; };
      resolve(database);
    };
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

function eventPrefix(scope: string, runId: string) {
  return rowKey(scope, runId) + String.fromCharCode(10);
}

function eventKey(scope: string, runId: string, sequence: number) {
  return eventPrefix(scope, runId) + String(sequence).padStart(16, '0');
}

function consumerKey(scope: string, runId: string, consumerId: string) {
  return `${rowKey(scope, runId)}\n${consumerId}`;
}

function changedTaskStates(current: WorkflowSnapshot | null, next: WorkflowSnapshot) {
  const before = new Map((current?.tasks || []).map((task) => [task.id, task]));
  const after = new Map(next.tasks.map((task) => [task.id, task]));
  const changed: WorkflowEvent['changedTasks'] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(id);
    const task = after.get(id);
    if (previous?.status === task?.status && previous?.attempt === task?.attempt) continue;
    changed.push({ id, status: task?.status || 'removed', attempt: task?.attempt || previous?.attempt || 0 });
  }
  return changed.sort((left, right) => left.id.localeCompare(right.id));
}

function hasWorkflowStateChange(current: WorkflowSnapshot | null, next: WorkflowSnapshot, changedTasks: WorkflowEvent['changedTasks']) {
  if (!current || changedTasks.length > 0) return true;
  return current.run.status !== next.run.status
    || current.run.generation !== next.run.generation
    || current.run.planVersion !== next.run.planVersion
    || current.run.deliveryStatus !== next.run.deliveryStatus
    || current.run.pauseRequested !== next.run.pauseRequested
    || current.run.planOpen !== next.run.planOpen;
}

export function workflowRunLockName(scope: string, runId: string) {
  return `pneumata-workflow-${rowKey(scope, runId)}`;
}

export function currentWorkflowScope() {
  return scopedStorageKey(`workflow-runs-${getLocalDataUserId()}`);
}

export const indexedDbWorkflowRepository: WorkflowRepository = {
  async listTaskAttempts(scope, runId, taskId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ATTEMPT_STORE, 'readonly');
      const prefix = `${rowKey(scope, runId)}\n${JSON.stringify(taskId)}\n`;
      const request = tx.objectStore(ATTEMPT_STORE).getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      request.onsuccess = () => {
        try { resolve(request.result.map(parseWorkflowTaskAttempt)); } catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error || new Error('读取任务执行历史失败'));
      tx.onabort = () => reject(tx.error || new Error('读取任务执行历史中止'));
    });
  },
  async read(scope, runId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(rowKey(scope, runId));
      request.onsuccess = () => {
        const snapshot: unknown = request.result;
        if (snapshot === undefined) resolve(null);
        else {
          try {
            resolve(migrateWorkflowSnapshot(snapshot));
          } catch (error) {
            reject(error);
          }
        }
      };
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
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          try {
            rows.push(migrateWorkflowSnapshot(cursor.value));
          } catch (error) {
            reject(error);
            return;
          }
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('列出工作流失败'));
    });
  },
  async listEvents(scope, runId, afterSequence = 0) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('工作流事件游标无效');
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EVENT_STORE, 'readonly');
      const prefix = eventPrefix(scope, runId);
      const lowerBound = eventKey(scope, runId, afterSequence + 1);
      const request = tx.objectStore(EVENT_STORE).openCursor(IDBKeyRange.bound(lowerBound, prefix + String.fromCharCode(65535)));
      const events: WorkflowEvent[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(events);
          return;
        }
        const value: unknown = cursor.value;
        if (isRecord(value) && value.runId === runId && Number.isSafeInteger(value.sequence)
          && typeof value.occurredAt === 'number' && RUN_STATUSES.has(value.runStatus as WorkflowRun['status'])
          && Array.isArray(value.changedTasks)) {
          const changedTasks = value.changedTasks.flatMap((candidate): WorkflowEvent['changedTasks'] => {
            if (!isRecord(candidate) || typeof candidate.id !== 'string' || !Number.isSafeInteger(candidate.attempt)) return [];
            if (candidate.status !== 'removed' && !TASK_STATUSES.has(candidate.status as WorkflowTaskStatus)) return [];
            return [{ id: candidate.id, status: candidate.status as WorkflowTaskStatus | 'removed', attempt: candidate.attempt as number }];
          });
          events.push({
            eventId: typeof value.eventId === 'string' ? value.eventId : `${runId}:${String(value.sequence)}`,
            aggregateVersion: Number.isSafeInteger(value.aggregateVersion) ? value.aggregateVersion as number : value.sequence as number,
            sequence: value.sequence as number,
            runId,
            occurredAt: value.occurredAt,
            runStatus: value.runStatus as WorkflowRun['status'],
            generation: Number(value.generation),
            planVersion: Number(value.planVersion),
            changedTasks,
          });
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('读取工作流事件失败'));
    });
  },
  async registerOutboxConsumer(scope, runId, consumerId) {
    assertNonEmptyString(consumerId, 'outbox 消费者 ID');
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, CONSUMER_STORE], 'readwrite');
      const runRequest = tx.objectStore(STORE).get(rowKey(scope, runId));
      runRequest.onsuccess = () => {
        if (runRequest.result === undefined) { tx.abort(); reject(new Error('工作流不存在')); return; }
        const key = consumerKey(scope, runId, consumerId);
        const consumerStore = tx.objectStore(CONSUMER_STORE);
        const currentRequest = consumerStore.get(key);
        currentRequest.onsuccess = () => {
          if (currentRequest.result === undefined) consumerStore.put({ key, scope, runId, consumerId, acknowledgedThrough: 0 });
        };
        currentRequest.onerror = () => { tx.abort(); reject(currentRequest.error || new Error('读取 outbox 消费回执失败')); };
      };
      runRequest.onerror = () => { tx.abort(); reject(runRequest.error || new Error('读取工作流失败')); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('注册 outbox 消费者失败'));
      tx.onabort = () => reject(tx.error || new Error('注册 outbox 消费者事务中止'));
    });
  },
  async listOutboxEvents(scope, runId, consumerId, limit = 100) {
    assertNonEmptyString(consumerId, 'outbox 消费者 ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('outbox 批量大小无效');
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([OUTBOX_STORE, CONSUMER_STORE], 'readonly');
      const consumerRequest = tx.objectStore(CONSUMER_STORE).get(consumerKey(scope, runId, consumerId));
      consumerRequest.onsuccess = () => {
        const consumer = consumerRequest.result;
        if (!consumer) { reject(new Error('outbox 消费者尚未注册')); return; }
        const prefix = eventPrefix(scope, runId);
        const lowerBound = eventKey(scope, runId, consumer.acknowledgedThrough + 1);
        const request = tx.objectStore(OUTBOX_STORE).openCursor(IDBKeyRange.bound(lowerBound, prefix + String.fromCharCode(65535)));
        const events: WorkflowEvent[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || events.length >= limit) { resolve(events); return; }
          const { key, ...event } = cursor.value;
          void key;
          events.push(event as WorkflowEvent);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('读取工作流 outbox 失败'));
      };
      consumerRequest.onerror = () => reject(consumerRequest.error || new Error('读取 outbox 消费回执失败'));
    });
  },
  async acknowledgeOutboxEvents(scope, runId, consumerId, throughSequence) {
    assertNonEmptyString(consumerId, 'outbox 消费者 ID');
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) throw new Error('outbox 回执序号无效');
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([OUTBOX_STORE, CONSUMER_STORE], 'readwrite');
      const consumerStore = tx.objectStore(CONSUMER_STORE);
      const key = consumerKey(scope, runId, consumerId);
      const request = consumerStore.get(key);
      request.onsuccess = () => {
        const consumer = request.result;
        if (!consumer) { tx.abort(); reject(new Error('outbox 消费者尚未注册')); return; }
        if (throughSequence <= consumer.acknowledgedThrough) return;
        const eventRequest = tx.objectStore(OUTBOX_STORE).get(eventKey(scope, runId, throughSequence));
        eventRequest.onsuccess = () => {
          if (!eventRequest.result) { tx.abort(); reject(new Error('不能确认尚未写入的 outbox 事件')); return; }
          consumerStore.put({ ...consumer, acknowledgedThrough: throughSequence, updatedAt: Date.now() });
        };
        eventRequest.onerror = () => { tx.abort(); reject(eventRequest.error || new Error('核对 outbox 事件失败')); };
      };
      request.onerror = () => { tx.abort(); reject(request.error || new Error('读取 outbox 消费回执失败')); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('保存 outbox 回执失败'));
      tx.onabort = () => reject(tx.error || new Error('保存 outbox 回执事务中止'));
    });
  },
  async transact(scope, runId, update) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, EVENT_STORE, OUTBOX_STORE, ATTEMPT_STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(rowKey(scope, runId));
      let value: unknown;
      request.onsuccess = () => {
        try {
          const current: unknown = request.result;
          const migratedCurrent = current === undefined ? null : migrateWorkflowSnapshot(current);
          const next = update(migratedCurrent);
          const migratedNext = migrateWorkflowSnapshot(next.snapshot);
          value = next.value;
          store.put(migratedNext, rowKey(scope, runId));
          const changedTasks = changedTaskStates(migratedCurrent, migratedNext);
          const beforeTasks = new Map(migratedCurrent?.tasks.map((task) => [task.id, task]));
          const attempts = tx.objectStore(ATTEMPT_STORE);
          for (const task of migratedNext.tasks) {
            const before = beforeTasks.get(task.id);
            if (!task.attempt || !before) continue;
            const key = `${rowKey(scope, runId)}\n${JSON.stringify(task.id)}\n${String(task.attempt).padStart(16, '0')}`;
            if (task.status === 'running' && task.attempt === before.attempt + 1) {
              attempts.add(claimedTaskAttempt(migratedNext, task), key);
            } else if (task.attempt === before.attempt && (task.status !== before.status || task.externalTaskId !== before.externalTaskId)) {
              const attemptRequest = attempts.get(key);
              attemptRequest.onsuccess = () => {
                if (attemptRequest.result === undefined) return;
                try { attempts.put(settleTaskAttempt(parseWorkflowTaskAttempt(attemptRequest.result), task), key); }
                catch (error) { tx.abort(); reject(error); }
              };
            }
          }
          if (!hasWorkflowStateChange(migratedCurrent, migratedNext, changedTasks)) return;
          const prefix = eventPrefix(scope, runId);
          const eventStore = tx.objectStore(EVENT_STORE);
          const range = IDBKeyRange.bound(prefix, prefix + String.fromCharCode(65535));
          const lastEventRequest = eventStore.openCursor(range, 'prev');
          lastEventRequest.onsuccess = () => {
            try {
              const key = lastEventRequest.result?.key;
              const previousSequence = typeof key === 'string' ? Number(key.slice(prefix.length)) || 0 : 0;
              const sequence = previousSequence + 1;
              const event: WorkflowEvent & { key: string } = {
                key: eventKey(scope, runId, sequence),
                eventId: `${runId}:${sequence}`,
                aggregateVersion: sequence,
                sequence,
                runId,
                occurredAt: migratedNext.run.updatedAt,
                runStatus: migratedNext.run.status,
                generation: migratedNext.run.generation,
                planVersion: migratedNext.run.planVersion,
                changedTasks,
              };
              eventStore.put(event);
              tx.objectStore(OUTBOX_STORE).put(event);
              const oldestRetainedSequence = sequence - EVENT_RETENTION_PER_RUN;
              if (oldestRetainedSequence > 0) {
                const pruneRange = IDBKeyRange.bound(prefix, eventKey(scope, runId, oldestRetainedSequence));
                const pruneRequest = eventStore.openCursor(pruneRange);
                pruneRequest.onsuccess = () => pruneRequest.result?.delete();
                pruneRequest.onerror = () => {
                  tx.abort();
                  reject(pruneRequest.error || new Error('清理工作流事件失败'));
                };
              }
            } catch (error) {
              tx.abort();
              reject(error);
            }
          };
          lastEventRequest.onerror = () => {
            tx.abort();
            reject(lastEventRequest.error || new Error('写入工作流事件失败'));
          };
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
      const next = update(current);
      assertWorkflowSnapshot(next.snapshot);
      return next;
    });

  async function create(snapshot: WorkflowSnapshot) {
    const versionedSnapshot = migrateWorkflowSnapshot(snapshot);
    return repository.transact(scope(), snapshot.run.id, (current) => {
      if (current) throw new Error('工作流已经存在');
      return { snapshot: versionedSnapshot, value: versionedSnapshot };
    });
  }

  async function setModelCallLimit(runId: string, expectedPlanVersion: number, maxModelCalls?: number) {
    if (maxModelCalls !== undefined && (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 1000)) throw new Error('模型调用上限应为 1 到 1000 的整数');
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'paused') throw new Error('请先暂停整个任务');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流计划版本冲突');
      if (maxModelCalls !== undefined && maxModelCalls <= countWorkflowModelCalls(current)) throw new Error('新上限必须大于已使用的模型调用次数');
      const snapshot: WorkflowSnapshot = { ...current, run: { ...current.run, maxModelCalls, planVersion: current.run.planVersion + 1, updatedAt: Date.now() } };
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

  async function markDeliveryPublished(runId: string, expectedPlanVersion: number) {
    return mutate(scope(), runId, (current) => {
      if (current.run.status !== 'completed') throw new Error('只能确认已完成的工作流交付');
      if (current.run.planVersion !== expectedPlanVersion) throw new Error('工作流交付版本冲突');
      if (current.run.deliveryStatus === 'published') return { snapshot: current, value: current };
      const snapshot = { ...current, run: { ...current.run, deliveryStatus: 'published' as const, updatedAt: Date.now() } };
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
        const remainingModelCalls = snapshot.run.maxModelCalls === undefined ? Number.POSITIVE_INFINITY
          : Math.max(0, snapshot.run.maxModelCalls - countWorkflowModelCalls(snapshot));
        let selectedModelCalls = 0;
        const batch = [...ready, ...external].filter((task) => {
          if (task.status === 'waiting_external') return true;
          if (task.kind !== 'team_plan' && task.kind !== 'team_plan_revision' && task.kind !== 'team_review'
            && task.kind !== 'agent_text' && task.kind !== 'agent_image_inspection') return true;
          if (selectedModelCalls >= remainingModelCalls) return false;
          selectedModelCalls += 1;
          return true;
        }).slice(0, concurrency);
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
        const modelCallLimitReached = !failed && current.run.maxModelCalls !== undefined
          && countWorkflowModelCalls({ ...current, tasks }) >= current.run.maxModelCalls
          && !tasks.some((task) => task.status === 'waiting_external')
          && tasks.some((task) => task.status === 'queued' || task.status === 'waiting_dependency');
        const snapshot = { ...current, tasks, run: { ...current.run, status: current.run.status !== 'active' ? current.run.status : signal.aborted || current.run.pauseRequested || modelCallLimitReached ? 'paused' as const : completed ? 'completed' as const : failed ? 'failed' as const : current.run.status, pauseRequested: false, updatedAt: Date.now() } };
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

  return { create, setModelCallLimit, addTasks, addTeamRevision, replaceUserBlockWithTasks, blockForUser, abandonUnknownReview, retryFailedReview, retryFailedTeamPlan, addTasksOnce, expandPlanOnce, closePlan, markDeliveryPublished, resume, pause, requestPauseAfterCurrentBatch, list: () => repository.list(scope()), read: (runId: string) => repository.read(scope(), runId) };
}
