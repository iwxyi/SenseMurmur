import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { countWorkflowModelCalls, createWorkflowRunRuntime, indexedDbWorkflowRepository, summarizeWorkflowRun, WorkflowPreflightError, type WorkflowExecutionContext, type WorkflowSnapshot, type WorkflowTask } from './workflowRunRuntime';
import { workflowModelInvocationId } from './workflowModelInvocation';
import { defaultWorkflowGoalSpec } from './workflowGoalSpec';

let testIndexedDb: IDBFactory | undefined;

beforeAll(async () => {
  testIndexedDb = new IDBFactory();
  vi.stubGlobal('indexedDB', testIndexedDb);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = testIndexedDb!.open('pneumata-workflow-runs', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('runs');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = db.transaction('runs', 'readwrite');
  tx.objectStore('runs').put(snapshot('legacy-v1'), 'legacy-scope\nlegacy-v1');
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
});

function snapshot(id: string): WorkflowSnapshot {
  return {
    run: { id, chatId: 'chat', goal: '制作短片', status: 'active', generation: 0, planVersion: 1, updatedAt: 1 },
    tasks: [
      { id: 'script', runId: id, kind: 'script', input: '恐龙追逐', dependsOn: [], status: 'queued', attempt: 0, updatedAt: 1 },
      { id: 'video', runId: id, kind: 'video', input: '使用脚本', dependsOn: ['script'], status: 'waiting_dependency', attempt: 0, updatedAt: 1 },
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', testIndexedDb!);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<WorkflowSnapshot>) => callback({}) } });
});

describe('workflow run runtime', () => {
  it.each(['valid', 'duplicate', 'cycle', 'missing'] as const)('atomically expands child tasks: %s', async (mode) => {
    const id = crypto.randomUUID();
    const scope = `expand-${id}`;
    const initial = snapshot(id);
    initial.tasks[0].kind = 'agent_delegation';
    const calls: string[] = [];
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
      tracksModelInvocations: true,
      async execute(task, _signal, context) {
        calls.push(task.id);
        if (task.kind === 'agent_delegation') {
          await context.beginModelInvocation();
          const saved = await indexedDbWorkflowRepository.read(scope, id);
          if (saved?.tasks.find((item) => item.id === task.id)?.expansion) {
            expect(saved.tasks.find((item) => item.id === 'child')?.status).toBe('completed');
            return { output: '子任务汇总' };
          }
          const child: WorkflowTask = { id: 'child', runId: id, kind: 'local', input: '执行',
            dependsOn: mode === 'cycle' ? ['script'] : mode === 'missing' ? ['missing'] : [], status: 'queued', attempt: 0, updatedAt: 1 };
          return { spawn: { tasks: mode === 'duplicate' ? [child, child] : [child], context: { summary: '已保存的子计划' } } };
        }
        if (task.id === 'video') {
          const saved = await indexedDbWorkflowRepository.read(scope, id);
          expect(saved?.tasks[0].output).toBe('子任务汇总');
        }
        return { output: '完成' };
      },
    }, () => scope);
    await runtime.create(initial);
    const result = await runtime.resume(id);
    if (mode === 'valid') {
      expect(calls).toEqual(['script', 'child', 'script', 'video']);
      expect(result.run.status).toBe('completed');
      expect(result.run.planVersion).toBe(2);
      expect((await indexedDbWorkflowRepository.listTaskAttempts(scope, id, 'script')).map((attempt) => attempt.status)).toEqual(['completed', 'completed']);
    } else {
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].status).toBe('failed');
      expect(result.run.planVersion).toBe(1);
      expect(calls).toEqual(['script']);
    }
  });

  it('resumes persisted children and parent synthesis after reaching a shared model budget', async () => {
    const id = crypto.randomUUID();
    const scope = `expand-budget-${id}`;
    const initial = snapshot(id);
    initial.run.maxModelCalls = 1;
    initial.tasks = [{ ...initial.tasks[0], kind: 'agent_delegation' }];
    const execute = vi.fn(async (task: WorkflowTask, _signal: AbortSignal, context: WorkflowExecutionContext) => {
      await context.beginModelInvocation();
      const saved = await indexedDbWorkflowRepository.read(scope, id);
      if (task.id === 'script' && !saved?.tasks[0].expansion) return { spawn: { context: '子计划', tasks: [
        { id: 'child', runId: id, kind: 'agent_text', input: '执行', dependsOn: [], status: 'queued' as const, attempt: 0, updatedAt: 1 },
      ] } };
      return { output: task.id === 'child' ? '子交付' : '汇总' };
    });
    const create = () => createWorkflowRunRuntime(indexedDbWorkflowRepository, { tracksModelInvocations: true, execute }, () => scope);
    await create().create(initial);
    const paused = await create().resume(id);
    expect(paused.run.status).toBe('paused');
    expect(paused.tasks[0].expansion?.context).toBe('子计划');
    expect(execute).toHaveBeenCalledTimes(1);
    await indexedDbWorkflowRepository.transact(scope, id, (current) => ({ snapshot: { ...current!, run: { ...current!.run, maxModelCalls: 3 } }, value: undefined }));
    const completed = await create().resume(id);
    expect(completed.run.status).toBe('completed');
    expect(execute.mock.calls.map(([task]) => task.id)).toEqual(['script', 'child', 'script']);
    expect(countWorkflowModelCalls(completed)).toBe(3);
  });

  it.each(['success', 'preflight', 'unknown', 'invalid-response', 'duplicate'] as const)('journals model request boundaries: %s', async (outcome) => {
    const id = crypto.randomUUID();
    const scope = `invocation-${id}`;
    const plan = snapshot(id);
    plan.run.maxModelCalls = 1;
    plan.tasks = [{ ...plan.tasks[0], kind: 'agent_text' }];
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
      tracksModelInvocations: true,
      async execute(task, _signal, context) {
        const reserved = await indexedDbWorkflowRepository.read(scope, id);
        expect(reserved?.tasks[0].modelInvocation?.state).toBe('reserved');
        if (outcome === 'preflight') throw new WorkflowPreflightError('权限不足');
        await context.beginModelInvocation();
        const attempts = await indexedDbWorkflowRepository.listTaskAttempts(scope, id, task.id);
        expect(attempts[0].modelInvocation?.state).toBe('started');
        if (outcome === 'duplicate') await expect(context.beginModelInvocation()).rejects.toThrow('已失效或已开始');
        if (outcome === 'unknown') throw new Error('连接中断');
        if (outcome === 'invalid-response') throw new WorkflowPreflightError('响应格式错误');
        return { output: '结果' };
      },
    }, () => scope);
    await runtime.create(plan);
    const result = await runtime.resume(id);
    const expected = outcome === 'preflight' ? 'not_started' : outcome === 'unknown' ? 'result_unknown' : outcome === 'invalid-response' ? 'failed' : 'succeeded';
    expect(result.tasks[0].modelInvocation?.state).toBe(expected);
    expect(countWorkflowModelCalls(result)).toBe(outcome === 'preflight' ? 0 : 1);
    expect((await indexedDbWorkflowRepository.listTaskAttempts(scope, id, plan.tasks[0].id))[0].modelInvocation).toEqual(result.tasks[0].modelInvocation);
  });

  it.each(['reserved', 'started'] as const)('recovers %s model requests without duplicate paid calls', async (state) => {
    const id = crypto.randomUUID();
    const scope = `recover-invocation-${id}`;
    const plan = snapshot(id);
    plan.run.status = 'paused';
    plan.run.maxModelCalls = 1;
    plan.tasks = [{ ...plan.tasks[0], kind: 'agent_text', status: 'running', attempt: 1,
      modelInvocation: { schemaVersion: 1, id: workflowModelInvocationId(id, 'script', 1), runId: id, taskId: 'script', attempt: 1, state, reservedAt: 1,
        ...(state === 'started' ? { startedAt: 1 } : {}) } }];
    const execute = vi.fn(async (_task: WorkflowTask, _signal: AbortSignal, context: WorkflowExecutionContext) => { await context.beginModelInvocation(); return { output: '完成' }; });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { tracksModelInvocations: true, execute }, () => scope);
    await runtime.create(plan);
    const result = await runtime.resume(id);
    expect(execute).toHaveBeenCalledTimes(state === 'reserved' ? 1 : 0);
    expect(result.tasks[0].status).toBe(state === 'reserved' ? 'completed' : 'result_unknown');
    expect(result.tasks[0].attempt).toBe(state === 'reserved' ? 2 : 1);
    expect(countWorkflowModelCalls(result)).toBe(1);
    await runtime.resume(id);
    expect(execute).toHaveBeenCalledTimes(state === 'reserved' ? 1 : 0);
  });

  it.each(['abort', 'pause', 'account'] as const)('rejects request start after losing execution authority: %s', async (reason) => {
    const id = crypto.randomUUID();
    const storageScope = `authority-${id}`;
    let currentScope = storageScope;
    const plan = snapshot(id);
    plan.tasks = [{ ...plan.tasks[0], kind: 'agent_text' }];
    const controller = new AbortController();
    const request = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (_task: WorkflowTask, _signal: AbortSignal, context: WorkflowExecutionContext) => {
      await gate;
      await context.beginModelInvocation();
      request();
      return { output: '不能发出请求' };
    });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { tracksModelInvocations: true, execute }, () => currentScope);
    await runtime.create(plan);
    const pending = runtime.resume(id, controller.signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    if (reason === 'abort') controller.abort();
    if (reason === 'pause') await runtime.pause(id);
    if (reason === 'account') currentScope = 'different-account';
    release();
    await pending;
    expect(request).not.toHaveBeenCalled();
    currentScope = storageScope;
    const saved = await runtime.read(id);
    expect(saved?.tasks[0].modelInvocation?.startedAt).toBeUndefined();
  });

  it('rejects a tracked executor result without a persisted request boundary', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.tasks = [{ ...plan.tasks[0], kind: 'agent_text' }];
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { tracksModelInvocations: true, execute: async () => ({ output: '无调用记录' }) }, () => `missing-boundary-${id}`);
    await runtime.create(plan);
    const result = await runtime.resume(id);
    expect(result.tasks[0]).toMatchObject({ status: 'failed', modelInvocation: { state: 'not_started' } });
    expect(countWorkflowModelCalls(result)).toBe(0);
  });

  it('persists immutable goal authorization and rejects mismatched or unsupported contracts', async () => {
    const id = crypto.randomUUID();
    const scope = `goal-${id}`;
    const plan = snapshot(id);
    plan.run.goalSpec = defaultWorkflowGoalSpec(plan.run.goal);
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => scope);
    await runtime.create(plan);
    expect((await runtime.read(id))?.run.goalSpec).toEqual(plan.run.goalSpec);
    await expect(indexedDbWorkflowRepository.transact(scope, id, (current) => {
      if (!current?.run.goalSpec) throw new Error('missing goal');
      return { snapshot: { ...current, run: { ...current.run, goalSpec: { ...current.run.goalSpec, allowedTools: [] } } }, value: undefined };
    })).rejects.toThrow('不能在执行中替换');
    await expect(indexedDbWorkflowRepository.transact(scope, id, (current) => {
      if (!current?.run.goalSpec) throw new Error('missing goal');
      current.run.goalSpec.allowedTools = [];
      return { snapshot: current, value: undefined };
    })).rejects.toThrow('不能在执行中替换');
    expect((await runtime.read(id))?.run.goalSpec).toEqual(plan.run.goalSpec);
    await expect(runtime.create({ ...snapshot('invalid-goal'), run: { ...snapshot('invalid-goal').run, goalSpec: defaultWorkflowGoalSpec('不同目标') } })).rejects.toThrow('不一致');
    expect((await indexedDbWorkflowRepository.read('legacy-scope', 'legacy-v1'))?.run.goalSpec).toBeUndefined();
  });

  it('uses the persisted goal concurrency limit after recreating the runtime', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.tasks[1] = { ...plan.tasks[1], dependsOn: [], status: 'queued' };
    plan.run.goalSpec = { ...defaultWorkflowGoalSpec(plan.run.goal), execution: { ...defaultWorkflowGoalSpec(plan.run.goal).execution, maxConcurrentTasks: 1 } };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => { await gate; return { output: '完成' }; });
    const first = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => `goal-limit-${id}`, 3);
    await first.create(plan);
    const restored = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => `goal-limit-${id}`, 3);
    const pending = restored.resume(id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const running = await restored.read(id);
    expect(running?.tasks.filter((task) => task.status === 'running')).toHaveLength(1);
    release();
    expect((await pending).run.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('atomically journals plan edits, rejects version jumps and isolates accounts', async () => {
    const id = crypto.randomUUID();
    const scope = `revisions-${id}`;
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => scope);
    await runtime.create(snapshot(id));
    await runtime.addTasks(id, 1, [{ ...snapshot(id).tasks[0], id: 'extra' }]);
    const revisions = await indexedDbWorkflowRepository.listPlanRevisions(scope, id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ parentVersion: 1, version: 2, addedTaskIds: ['extra'] });
    expect(await indexedDbWorkflowRepository.listPlanRevisions('other-account', id)).toEqual([]);
    const before = await runtime.read(id);
    await expect(indexedDbWorkflowRepository.transact(scope, id, (current) => {
      if (!current) throw new Error('missing');
      return { snapshot: { ...current, run: { ...current.run, planVersion: 4 } }, value: undefined };
    })).rejects.toThrow('按版本顺序');
    expect(await runtime.read(id)).toEqual(before);
    expect(await indexedDbWorkflowRepository.listPlanRevisions(scope, id)).toEqual(revisions);
    await runtime.pause(id);
    expect(await indexedDbWorkflowRepository.listPlanRevisions(scope, id)).toEqual(revisions);
  });

  it('journals in-place task edits against the original transaction snapshot', async () => {
    const id = crypto.randomUUID();
    const scope = `mutable-edit-${id}`;
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => scope);
    await runtime.create(snapshot(id));
    await indexedDbWorkflowRepository.transact(scope, id, (current) => {
      if (!current) throw new Error('missing');
      current.run.planVersion += 1;
      current.tasks[0].input = '修订脚本';
      return { snapshot: current, value: undefined };
    });
    const revisions = await indexedDbWorkflowRepository.listPlanRevisions(scope, id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ parentVersion: 1, version: 2, updatedTaskIds: ['script'] });
  });

  it('upgrades a version 1 database and preserves its legacy run snapshot', async () => {
    const upgraded = await indexedDbWorkflowRepository.read('legacy-scope', 'legacy-v1');
    expect(upgraded?.schemaVersion).toBe(1);
    expect(upgraded?.run.goal).toBe('制作短片');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = testIndexedDb!.open('pneumata-workflow-runs', 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(db.objectStoreNames.contains('runs')).toBe(true);
    expect(db.objectStoreNames.contains('events')).toBe(true);
    expect(db.objectStoreNames.contains('outbox')).toBe(true);
    expect(db.objectStoreNames.contains('outbox_consumers')).toBe(true);
    expect(db.objectStoreNames.contains('task_attempts')).toBe(true);
    expect(db.objectStoreNames.contains('plan_revisions')).toBe(true);
    expect(await indexedDbWorkflowRepository.listPlanRevisions('legacy-scope', 'legacy-v1')).toEqual([]);
    db.close();
  });

  it('persists dependency progress and resumes the external task without generating it again', async () => {
    const id = crypto.randomUUID();
    const execute = vi.fn(async (task: { id: string }) => task.id === 'script' ? { output: '脚本完成' } : { externalTaskId: 'upstream-1' });
    const inspectExternal = vi.fn().mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'completed', output: 'video.mp4' });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute, inspectExternal }, () => 'test');
    await runtime.create(snapshot(id));
    const first = await runtime.resume(id);
    expect(first.tasks.map((task) => task.status)).toEqual(['completed', 'waiting_external']);
    expect(execute).toHaveBeenCalledTimes(2);
    const second = await runtime.resume(id);
    expect(second.run.status).toBe('completed');
    expect(second.tasks[1].output).toBe('video.mp4');
    expect(execute).toHaveBeenCalledTimes(2);
    const attempts = await indexedDbWorkflowRepository.listTaskAttempts('test', id, 'video');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, status: 'completed', externalTaskId: 'upstream-1' });
    expect(attempts[0].finishedAt).toBeGreaterThanOrEqual(attempts[0].startedAt);
    await runtime.resume(id);
    expect(await indexedDbWorkflowRepository.listTaskAttempts('test', id, 'video')).toEqual(attempts);
    expect(await indexedDbWorkflowRepository.listTaskAttempts('other-user', id, 'video')).toEqual([]);
  });

  it('commits the execution record before dispatch and preserves it across retries', async () => {
    const id = crypto.randomUUID();
    const scope = `attempt-${id}`;
    const plan = snapshot(id);
    plan.tasks = [plan.tasks[0]];
    const execute = vi.fn(async () => {
      const attempts = await indexedDbWorkflowRepository.listTaskAttempts(scope, id, 'script');
      expect(attempts.at(-1)).toMatchObject({ attempt: execute.mock.calls.length, status: 'running', planVersion: 1 });
      if (execute.mock.calls.length === 1) throw new Error('connection interrupted');
      return { output: 'done' };
    });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => scope);
    await runtime.create(plan);
    await runtime.resume(id);
    const first = (await indexedDbWorkflowRepository.listTaskAttempts(scope, id, 'script'))[0];
    expect(first.status).toBe('result_unknown');
    await indexedDbWorkflowRepository.transact(scope, id, (current) => {
      if (!current) throw new Error('missing');
      return { snapshot: { ...current, run: { ...current.run, status: 'active' }, tasks: current.tasks.map((task) => ({ ...task, status: 'queued' })) }, value: undefined };
    });
    expect(await indexedDbWorkflowRepository.listTaskAttempts(scope, id, 'script')).toEqual([first]);
    await runtime.resume(id);
    const attempts = await indexedDbWorkflowRepository.listTaskAttempts(scope, id, 'script');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(first);
    expect(attempts[1]).toMatchObject({ attempt: 2, status: 'completed' });
  });

  it('reconciles an interrupted submitted task before deciding whether to resend', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.tasks = [{ ...plan.tasks[0], status: 'running', attempt: 1 }];
    const execute = vi.fn();
    const reconcileInterrupted = vi.fn().mockResolvedValue({ status: 'waiting_external', externalTaskId: 'task-saved' });
    const inspectExternal = vi.fn().mockResolvedValue({ status: 'completed', output: '已保存的视频' });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute, reconcileInterrupted, inspectExternal }, () => 'reconcile-submitted-test');
    await runtime.create(plan);
    const result = await runtime.resume(id);
    expect(result.tasks[0]).toMatchObject({ status: 'completed', externalTaskId: 'task-saved', output: '已保存的视频', attempt: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(reconcileInterrupted).toHaveBeenCalledTimes(1);
  });

  it('keeps uncertain results blocked across repeated resume calls', async () => {
    const id = crypto.randomUUID();
    const execute = vi.fn().mockRejectedValue(new Error('连接中断'));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test');
    await runtime.create(snapshot(id));
    const result = await runtime.resume(id);
    expect(result.tasks[0]).toMatchObject({ status: 'result_unknown', attempt: 1 });
    await runtime.resume(id);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reserves the remaining model-call allowance before a concurrent batch', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.run.maxModelCalls = 1;
    plan.tasks = [
      { ...plan.tasks[0], id: 'first', kind: 'agent_text' },
      { ...plan.tasks[0], id: 'second', kind: 'agent_text' },
    ];
    const execute = vi.fn(async (task: { id: string }) => ({ output: task.id }));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => `model-limit-${id}`);
    await runtime.create(plan);
    const first = await runtime.resume(id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.run.status).toBe('paused');
    expect(first.tasks.map((task) => task.status)).toEqual(['completed', 'queued']);
    await runtime.resume(id);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(runtime.setModelCallLimit(id, first.run.planVersion, 1)).rejects.toThrow('新上限必须大于');
    await expect(runtime.setModelCallLimit(id, first.run.planVersion + 1, 2)).rejects.toThrow('版本冲突');
    const extended = await runtime.setModelCallLimit(id, first.run.planVersion, 2);
    expect(extended.run.planVersion).toBe(first.run.planVersion + 1);
    expect(execute).toHaveBeenCalledTimes(1);
    const completed = await runtime.resume(id);
    expect(completed.run.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('collects an already submitted external result after the model-call allowance is exhausted', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.run.maxModelCalls = 1;
    plan.tasks = [
      { ...plan.tasks[0], id: 'text', kind: 'agent_text', status: 'completed', attempt: 1 },
      { ...plan.tasks[0], id: 'video', kind: 'agent_video', status: 'waiting_external', externalTaskId: 'submitted-video', attempt: 1 },
      { ...plan.tasks[0], id: 'summary', kind: 'agent_text', dependsOn: ['video'], status: 'waiting_dependency' },
    ];
    const execute = vi.fn();
    const inspectExternal = vi.fn().mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'completed', output: 'saved-video.mp4' });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute, inspectExternal }, () => `external-limit-${id}`);
    await runtime.create(plan);
    expect((await runtime.resume(id)).run.status).toBe('active');
    const collected = await runtime.resume(id);
    expect(collected.run.status).toBe('paused');
    expect(collected.tasks[1]).toMatchObject({ status: 'completed', output: 'saved-video.mp4', attempt: 1 });
    expect(inspectExternal).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects cyclic plans before persisting', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'test');
    const plan = snapshot(id);
    plan.tasks[0].dependsOn = ['video'];
    await expect(runtime.create(plan)).rejects.toThrow('依赖形成环');
    expect(await runtime.read(id)).toBeNull();
  });

  it('rejects malformed task contracts before any task is dispatched', async () => {
    const id = crypto.randomUUID();
    const execute = vi.fn();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test');
    const plan = snapshot(id);
    plan.tasks[0] = { ...plan.tasks[0], status: 'not-a-state' as WorkflowSnapshot['tasks'][number]['status'] };
    await expect(runtime.create(plan)).rejects.toThrow('任务状态无效');
    expect(execute).not.toHaveBeenCalled();
    expect(await runtime.read(id)).toBeNull();
  });

  it('rejects invalid state transitions at the persistence boundary', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'test');
    await runtime.create(snapshot(id));
    await expect(indexedDbWorkflowRepository.transact('test', id, (current) => {
      if (!current) throw new Error('missing');
      return { snapshot: { ...current, tasks: current.tasks.map((task) => task.id === 'script' ? { ...task, attempt: -1 } : task) }, value: undefined };
    })).rejects.toThrow('尝试次数无效');
    expect((await runtime.read(id))?.tasks[0].attempt).toBe(0);
  });

  it('writes new snapshots with an explicit schema version', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'test');
    await runtime.create(snapshot(id));
    expect((await runtime.read(id))?.schemaVersion).toBe(1);
  });

  it('persists ordered events atomically and paginates after a sequence', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'event-test');
    await runtime.create(snapshot(id));
    await indexedDbWorkflowRepository.transact('event-test', id, (current) => {
      if (!current) throw new Error('missing');
      return { snapshot: { ...current, run: { ...current.run, status: 'paused', updatedAt: 2 } }, value: undefined };
    });
    const events = await indexedDbWorkflowRepository.listEvents('event-test', id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[0].changedTasks).toHaveLength(2);
    expect(events[0].eventId).toBe(`${id}:1`);
    expect(events[0].aggregateVersion).toBe(1);
    expect(events[1].runStatus).toBe('paused');
    expect(await indexedDbWorkflowRepository.listEvents('event-test', id, 1)).toEqual([events[1]]);
  });

  it('replays durable outbox records until a consumer acknowledges them', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'outbox-test');
    await runtime.create(snapshot(id));
    await indexedDbWorkflowRepository.registerOutboxConsumer('outbox-test', id, 'delivery');
    const firstRead = await indexedDbWorkflowRepository.listOutboxEvents('outbox-test', id, 'delivery');
    expect(firstRead).toHaveLength(1);
    expect(firstRead[0].eventId).toBe(`${id}:1`);
    expect(await indexedDbWorkflowRepository.listOutboxEvents('outbox-test', id, 'delivery')).toEqual(firstRead);

    await indexedDbWorkflowRepository.transact('outbox-test', id, (current) => {
      if (!current) throw new Error('missing');
      return { snapshot: { ...current, run: { ...current.run, status: 'paused', updatedAt: 2 } }, value: undefined };
    });
    const events = await indexedDbWorkflowRepository.listOutboxEvents('outbox-test', id, 'delivery');
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    await indexedDbWorkflowRepository.acknowledgeOutboxEvents('outbox-test', id, 'delivery', 2);
    await indexedDbWorkflowRepository.acknowledgeOutboxEvents('outbox-test', id, 'delivery', 1);
    expect(await indexedDbWorkflowRepository.listOutboxEvents('outbox-test', id, 'delivery')).toEqual([]);
    await expect(indexedDbWorkflowRepository.acknowledgeOutboxEvents('outbox-test', id, 'delivery', 3)).rejects.toThrow('尚未写入');
  });

  it('retains the latest 256 events without deleting the boundary event', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'event-retention-test');
    await runtime.create(snapshot(id));
    await indexedDbWorkflowRepository.registerOutboxConsumer('event-retention-test', id, 'retention-check');
    for (let version = 2; version <= 260; version += 1) {
      await indexedDbWorkflowRepository.transact('event-retention-test', id, (current) => {
        if (!current) throw new Error('missing');
        return { snapshot: { ...current, run: { ...current.run, planVersion: version, updatedAt: version } }, value: undefined };
      });
    }
    const events = await indexedDbWorkflowRepository.listEvents('event-retention-test', id);
    expect(events).toHaveLength(256);
    expect(events[0].sequence).toBe(5);
    expect(events.at(-1)?.sequence).toBe(260);
    const outbox = await indexedDbWorkflowRepository.listOutboxEvents('event-retention-test', id, 'retention-check', 1000);
    expect(outbox).toHaveLength(260);
    expect(outbox[0].sequence).toBe(1);
    expect(outbox.at(-1)?.sequence).toBe(260);
  });

  it('does not commit an event when snapshot validation aborts the transaction', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'event-atomicity-test');
    await runtime.create(snapshot(id));
    await indexedDbWorkflowRepository.registerOutboxConsumer('event-atomicity-test', id, 'atomicity-check');
    await expect(indexedDbWorkflowRepository.transact('event-atomicity-test', id, (current) => {
      if (!current) throw new Error('missing');
      return { snapshot: { ...current, run: { ...current.run, planVersion: 2 }, tasks: [{ ...current.tasks[0], attempt: -1 }, current.tasks[1]] }, value: undefined };
    })).rejects.toThrow('尝试次数无效');
    expect(await indexedDbWorkflowRepository.listEvents('event-atomicity-test', id)).toHaveLength(1);
    expect((await indexedDbWorkflowRepository.listOutboxEvents('event-atomicity-test', id, 'atomicity-check')).map((event) => event.sequence)).toEqual([1]);
    expect((await runtime.read(id))?.run.planVersion).toBe(1);
    expect(await indexedDbWorkflowRepository.listTaskAttempts('event-atomicity-test', id, 'script')).toEqual([]);
  });

  it('migrates legacy snapshots without rewriting their task history', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'test');
    await runtime.create(snapshot(id));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = testIndexedDb!.open('pneumata-workflow-runs', 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const legacy = snapshot(id);
    legacy.tasks[0] = { ...legacy.tasks[0], status: 'completed', attempt: 1, output: '已交付' };
    const tx = db.transaction('runs', 'readwrite');
    tx.objectStore('runs').put(legacy, `test\n${id}`);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const migrated = await runtime.read(id);
    expect(migrated?.schemaVersion).toBe(1);
    expect(migrated?.tasks[0]).toMatchObject({ status: 'completed', output: '已交付', attempt: 1 });
    expect(migrated?.tasks).toHaveLength(2);
    expect(await indexedDbWorkflowRepository.listTaskAttempts('test', id, 'script')).toEqual([]);
  });

  it('rejects a late result after pause changes the run generation', async () => {
    const id = crypto.randomUUID();
    let finish!: (value: { output: string }) => void;
    const execute = vi.fn(() => new Promise<{ output: string }>((resolve) => { finish = resolve; }));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test');
    await runtime.create(snapshot(id));
    const pending = runtime.resume(id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await runtime.pause(id);
    finish({ output: '迟到结果' });
    const result = await pending;
    expect(result.run.status).toBe('paused');
    expect(result.tasks[0].output).toBeUndefined();
  });

  it('pauses after the current paid batch commits and leaves dependent work queued', async () => {
    const id = crypto.randomUUID();
    let finish!: (value: { output: string }) => void;
    const execute = vi.fn(() => new Promise<{ output: string }>((resolve) => { finish = resolve; }));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'pause-after-batch-test');
    await runtime.create(snapshot(id));
    const pending = runtime.resume(id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await runtime.requestPauseAfterCurrentBatch(id);
    finish({ output: '已保存的脚本' });
    const result = await pending;
    expect(result.run.status).toBe('paused');
    expect(result.run.pauseRequested).toBe(false);
    expect(result.tasks.map((task) => task.status)).toEqual(['completed', 'waiting_dependency']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('continues independent tasks while an external result is pending', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.tasks[0] = { ...plan.tasks[0], status: 'waiting_external', externalTaskId: 'upstream-2' };
    plan.tasks[1] = { ...plan.tasks[1], dependsOn: [], status: 'queued' };
    const execute = vi.fn(async () => ({ output: '独立任务完成' }));
    const inspectExternal = vi.fn(async () => ({ status: 'pending' as const }));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute, inspectExternal }, () => 'test');
    await runtime.create(plan);
    const result = await runtime.resume(id);
    expect(result.tasks.map((task) => task.status)).toEqual(['waiting_external', 'completed']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(inspectExternal).toHaveBeenCalledTimes(1);
  });

  it('keeps a queryable external task available after a transient status query error', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.tasks = [{ ...plan.tasks[0], status: 'waiting_external', externalTaskId: 'upstream-3' }];
    const inspectExternal = vi.fn().mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce({ status: 'completed', output: '结果' });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn(), inspectExternal }, () => 'test');
    await runtime.create(plan);
    const first = await runtime.resume(id);
    expect(first.tasks[0].status).toBe('waiting_external');
    const second = await runtime.resume(id);
    expect(second.tasks[0].status).toBe('completed');
    expect(inspectExternal).toHaveBeenCalledTimes(2);
  });

  it('does not write an in-flight result after the account scope changes', async () => {
    const id = crypto.randomUUID();
    let account = 'account-a';
    let finish!: (value: { output: string }) => void;
    const execute = vi.fn(() => new Promise<{ output: string }>((resolve) => { finish = resolve; }));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => account);
    await runtime.create(snapshot(id));
    const pending = runtime.resume(id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    account = 'account-b';
    finish({ output: '旧账号结果' });
    await pending;
    account = 'account-a';
    const stored = await runtime.read(id);
    expect(stored?.tasks[0].output).toBeUndefined();
    expect(stored?.tasks[0].status).toBe('running');
  });

  it('summarizes blocked dependent tasks for a single run-level resume view', () => {
    const plan = snapshot('run');
    plan.tasks[0] = { ...plan.tasks[0], status: 'result_unknown', error: '结果需要核对' };
    expect(summarizeWorkflowRun(plan)).toEqual({
      completed: [], waiting: [], runnable: [],
      blocked: [
        { taskId: 'script', reason: '结果需要核对' },
        { taskId: 'video', reason: '前置任务未完成且需要处理' },
      ],
    });
  });

  it('does not dispatch when another tab owns the run lock', async () => {
    const id = crypto.randomUUID();
    const execute = vi.fn();
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: null) => Promise<WorkflowSnapshot>) => callback(null) } });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test');
    await runtime.create(snapshot(id));
    await expect(runtime.resume(id)).rejects.toThrow('另一个标签页运行');
    expect(execute).not.toHaveBeenCalled();
  });

  it('adds delegated tasks atomically with a plan version guard', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'test');
    await runtime.create(snapshot(id));
    const delegated = { id: 'soundtrack', runId: id, kind: 'audio', input: '配乐', dependsOn: ['script'], status: 'waiting_dependency' as const, attempt: 0, updatedAt: 2 };
    const revised = await runtime.addTasks(id, 1, [delegated]);
    expect(revised.run.planVersion).toBe(2);
    expect(revised.tasks).toHaveLength(3);
    await expect(runtime.addTasks(id, 1, [{ ...delegated, id: 'another' }])).rejects.toThrow('计划版本冲突');
    await expect(runtime.addTasks(id, 2, [{ ...delegated, id: 'loop', dependsOn: ['loop'] }])).rejects.toThrow('依赖形成环');
    expect((await runtime.read(id))?.tasks).toHaveLength(3);
  });

  it('allows only one concurrent revision against the same plan version', async () => {
    const id = crypto.randomUUID();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'test');
    await runtime.create(snapshot(id));
    const additions = ['audio-a', 'audio-b'].map((taskId) => ({
      id: taskId, runId: id, kind: 'audio', input: taskId, dependsOn: ['script'],
      status: 'waiting_dependency' as const, attempt: 0, updatedAt: 2,
    }));
    const results = await Promise.allSettled(additions.map((task) => runtime.addTasks(id, 1, [task])));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await runtime.read(id))?.tasks).toHaveLength(3);
  });

  it('deduplicates a run-level resume command after it has been applied', async () => {
    const id = crypto.randomUUID();
    const execute = vi.fn(async () => ({ output: '完成' }));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test');
    await runtime.create(snapshot(id));
    await runtime.resume(id, undefined, 'resume-1');
    const generation = (await runtime.read(id))?.run.generation;
    await runtime.resume(id, undefined, 'resume-1');
    expect((await runtime.read(id))?.run.generation).toBe(generation);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('lists only runs in the current account scope', async () => {
    const prefix = crypto.randomUUID();
    const runtimeA = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => `${prefix}-account-a`);
    const runtimeB = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => `${prefix}-account-b`);
    await runtimeA.create(snapshot(crypto.randomUUID()));
    await runtimeB.create(snapshot(crypto.randomUUID()));
    expect(await runtimeA.list()).toHaveLength(1);
    expect(await runtimeB.list()).toHaveLength(1);
    expect((await runtimeA.list())[0].run.id).not.toBe((await runtimeB.list())[0].run.id);
  });

  it('runs independent delegated tasks concurrently within the configured limit', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.tasks[1] = { ...plan.tasks[1], dependsOn: [], status: 'queued' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => { await gate; return { output: '完成' }; });
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test', 2);
    await runtime.create(plan);
    const pending = runtime.resume(id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    release();
    expect((await pending).run.status).toBe('completed');
  });

  it('marks a cancelled in-flight request as unknown instead of retrying it', async () => {
    const id = crypto.randomUUID();
    const abortController = new AbortController();
    let rejectExecution!: (error: Error) => void;
    const execute = vi.fn(() => new Promise<{ output: string }>((_resolve, reject) => { rejectExecution = reject; }));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test');
    await runtime.create(snapshot(id));
    const pending = runtime.resume(id, abortController.signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    abortController.abort();
    rejectExecution(new Error('已中断'));
    const result = await pending;
    expect(result.run.status).toBe('paused');
    expect(result.tasks[0].status).toBe('result_unknown');
    await runtime.resume(id);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('marks a rejected preflight as failed before a paid request starts', async () => {
    const id = crypto.randomUUID();
    const execute = vi.fn().mockRejectedValue(new WorkflowPreflightError('原始消息已删除'));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test');
    await runtime.create(snapshot(id));
    const result = await runtime.resume(id);
    expect(result.run.status).toBe('failed');
    expect(result.tasks[0]).toMatchObject({ status: 'failed', error: '原始消息已删除' });
  });

  it('keeps an open plan available for delegation after its initial tasks finish', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.run.planOpen = true;
    plan.tasks = [plan.tasks[0]];
    const execute = vi.fn(async () => ({ output: '脚本' }));
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute }, () => 'test');
    await runtime.create(plan);
    const first = await runtime.resume(id);
    expect(first.run.status).toBe('active');
    const delegated = { id: 'video', runId: id, kind: 'video', input: '生成视频', dependsOn: ['script'], status: 'queued' as const, attempt: 0, updatedAt: Date.now() };
    await runtime.addTasks(id, 1, [delegated]);
    const second = await runtime.resume(id);
    expect(second.tasks[1].status).toBe('completed');
    expect(second.run.status).toBe('active');
    expect((await runtime.closePlan(id, 2)).run.status).toBe('completed');
  });

  it('expands a completed planner task only once', async () => {
    const id = crypto.randomUUID();
    const plan = snapshot(id);
    plan.run.planOpen = true;
    plan.tasks = [{ ...plan.tasks[0], id: 'plan', kind: 'team_plan', status: 'completed', output: { summary: '计划' } }];
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: vi.fn() }, () => 'test');
    await runtime.create(plan);
    const child = { id: 'child', runId: id, kind: 'agent_text', input: { goal: '写报告' }, dependsOn: ['plan'], status: 'queued' as const, attempt: 0, updatedAt: 2 };
    await runtime.expandPlanOnce(id, 1, 'plan', [child]);
    await runtime.expandPlanOnce(id, 1, 'plan', [child]);
    expect((await runtime.read(id))?.tasks).toHaveLength(2);
    expect((await runtime.read(id))?.run.planVersion).toBe(2);
  });
});
