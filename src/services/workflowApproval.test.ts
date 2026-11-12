import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createWorkflowRunRuntime, indexedDbWorkflowRepository, type WorkflowSnapshot } from './workflowRunRuntime';
import { pendingWorkflowApproval } from './workflowApproval';

beforeAll(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
beforeEach(() => {
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}) } });
});

function setup() {
  let executionSha256: string | undefined;
  const runId = crypto.randomUUID();
  const scope = `approval-${runId}`;
  const execute = vi.fn(async (task: { id: string }) => ({ output: task.id === 'script' ? '已完成脚本' : '已完成生成' }));
  const makeRuntime = () => createWorkflowRunRuntime(indexedDbWorkflowRepository, {
    execute, approvalRequirement: (task) => task.id === 'video' ? { summary: '按已完成脚本制作视频', consequences: '生成会产生费用', executionSha256 } : undefined,
  }, () => scope);
  const initial: WorkflowSnapshot = { run: { id: runId, chatId: 'chat', goal: '制作短片', status: 'active', planVersion: 1, generation: 0, updatedAt: 1 },
    tasks: [
      { id: 'script', runId, kind: 'agent_text', input: '脚本', dependsOn: [], status: 'queued', attempt: 0, updatedAt: 1 },
      { id: 'video', runId, kind: 'agent_text', input: '视频', dependsOn: ['script'], status: 'waiting_dependency', attempt: 0, updatedAt: 1 },
      { id: 'independent', runId, kind: 'agent_text', input: '独立工作', dependsOn: [], status: 'queued', attempt: 0, updatedAt: 1 },
    ] };
  return { runId, scope, execute, initial, makeRuntime, setExecution: (digest: string | undefined) => { executionSha256 = digest; } };
}

describe('persistent workflow approval', () => {
  it.each(['model', 'tool'] as const)('blocks a late configuration change at the %s request boundary', async (kind) => {
    const { runId, initial, scope } = setup();
    let executionSha256 = 'a'.repeat(64);
    const submitted = vi.fn();
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
      tracksModelInvocations: true, tracksToolInvocations: true,
      approvalRequirement: () => ({ summary: '确认执行', consequences: '会产生费用', executionSha256 }),
      async execute(_task, _signal, context) {
        executionSha256 = 'b'.repeat(64);
        if (kind === 'model') await context.beginModelInvocation();
        else await context.beginToolInvocation();
        submitted();
        return { output: '结果' };
      },
    }, () => scope);
    await runtime.create({ ...initial, tasks: [{ ...initial.tasks[1], kind: kind === 'model' ? 'agent_text' : 'agent_video', dependsOn: [], status: 'queued' }] });
    await runtime.resume(runId);
    await runtime.decideApproval(runId, 'video', 1, 'approved');
    const blocked = await runtime.resume(runId);
    expect(blocked.tasks[0]).toMatchObject({ status: 'failed', error: '执行配置已改变，请重新确认审批' });
    expect(kind === 'model' ? blocked.tasks[0].modelInvocation?.state : blocked.tasks[0].toolInvocation?.state).toBe('not_started');
    expect(submitted).not.toHaveBeenCalled();
  });

  it('invalidates an approved configuration before dispatch and persists both decisions across restore', async () => {
    const { runId, initial, execute, makeRuntime, setExecution } = setup();
    setExecution('a'.repeat(64));
    const runtime = makeRuntime();
    await runtime.create(initial);
    await runtime.resume(runId);
    await runtime.decideApproval(runId, 'video', 1, 'approved');
    setExecution('b'.repeat(64));
    const changed = await makeRuntime().resume(runId);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(changed.tasks[1]).toMatchObject({ status: 'waiting_user', attempt: 0 });
    expect(changed.tasks[1].approvals).toHaveLength(2);
    expect(changed.tasks[1].approvals?.[0]).toMatchObject({ invalidatedAt: expect.any(Number), decision: { outcome: 'approved' } });
    expect(pendingWorkflowApproval(changed.tasks[1])?.executionSha256).toBe('b'.repeat(64));
    const restored = makeRuntime();
    expect((await restored.resume(runId)).tasks[1].approvals).toEqual(changed.tasks[1].approvals);
    await restored.decideApproval(runId, 'video', changed.run.planVersion, 'approved');
    expect((await restored.resume(runId)).run.status).toBe('completed');
    await makeRuntime().resume(runId);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('requires configuration confirmation when restoring an old approval without a configuration digest', async () => {
    const { runId, initial, execute, makeRuntime, setExecution } = setup();
    const runtime = makeRuntime();
    await runtime.create(initial);
    await runtime.resume(runId);
    await runtime.decideApproval(runId, 'video', 1, 'approved');
    setExecution('c'.repeat(64));
    const waiting = await makeRuntime().resume(runId);
    expect(waiting.tasks[1].status).toBe('waiting_user');
    expect(waiting.tasks[1].approvals).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('waits before claiming, preserves independent work, resumes once after explicit approval', async () => {
    const { runId, initial, execute, makeRuntime, scope } = setup();
    const runtime = makeRuntime();
    await runtime.create(initial);
    const waiting = await runtime.resume(runId);
    expect(waiting.run.status).toBe('paused');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(waiting.tasks[1]).toMatchObject({ status: 'waiting_user', attempt: 0 });
    expect(pendingWorkflowApproval(waiting.tasks[1])).toMatchObject({ schemaVersion: 1, attempt: 1, planVersion: 1 });
    expect(await indexedDbWorkflowRepository.listTaskAttempts(scope, runId, 'video')).toEqual([]);
    const restored = makeRuntime();
    expect((await restored.resume(runId)).tasks[1].status).toBe('waiting_user');
    expect(execute).toHaveBeenCalledTimes(2);
    const approved = await restored.decideApproval(runId, 'video', waiting.run.planVersion, 'approved');
    expect(approved.run.planVersion).toBe(2);
    expect(approved.tasks[1].approvals?.[0].decision).toMatchObject({ actor: 'local_user', outcome: 'approved' });
    expect((await restored.resume(runId)).run.status).toBe('completed');
    await restored.resume(runId);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('rejects stale or duplicate decisions without changing the journal', async () => {
    const { runId, initial, makeRuntime, scope } = setup();
    const runtime = makeRuntime();
    await runtime.create(initial);
    await runtime.resume(runId);
    const events = await indexedDbWorkflowRepository.listEvents(scope, runId);
    await expect(runtime.decideApproval(runId, 'video', 9, 'approved')).rejects.toThrow('计划已更新');
    expect(await indexedDbWorkflowRepository.listEvents(scope, runId)).toEqual(events);
    const approved = await runtime.decideApproval(runId, 'video', 1, 'approved');
    await expect(runtime.decideApproval(runId, 'video', approved.run.planVersion, 'approved')).rejects.toThrow('没有等待审批');
  });

  it('stops the task group on rejection and never dispatches after resume', async () => {
    const { runId, initial, execute, makeRuntime } = setup();
    const runtime = makeRuntime();
    await runtime.create(initial);
    await runtime.resume(runId);
    const rejected = await runtime.decideApproval(runId, 'video', 1, 'rejected');
    expect(rejected.run.status).toBe('cancelled');
    expect(rejected.tasks[0].output).toBe('已完成脚本');
    expect((await makeRuntime().resume(runId)).run.status).toBe('cancelled');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(['remove', 'summary', 'input', 'decision', 'execution', 'invalidate', 'claim-changed-input'] as const)('atomically rejects %s tampering', async (field) => {
    const { runId, initial, makeRuntime, scope } = setup();
    const runtime = makeRuntime();
    await runtime.create(initial);
    await runtime.resume(runId);
    await runtime.decideApproval(runId, 'video', 1, 'approved');
    const before = await runtime.read(runId);
    const events = await indexedDbWorkflowRepository.listEvents(scope, runId);
    await expect(indexedDbWorkflowRepository.transact(scope, runId, (current) => {
      const task = current!.tasks[1];
      if (field === 'remove') delete task.approvals;
      if (field === 'summary') task.approvals![0].summary = '换一个方案';
      if (field === 'decision') task.approvals![0].decision!.decidedAt += 1;
      if (field === 'execution') task.approvals![0].executionSha256 = 'f'.repeat(64);
      if (field === 'invalidate') task.approvals![0].invalidatedAt = Date.now();
      if (field === 'input' || field === 'claim-changed-input') task.input = '不同视频';
      if (field === 'claim-changed-input') { task.status = 'running'; task.attempt += 1; }
      return { snapshot: current!, value: undefined };
    })).rejects.toThrow(/审批/);
    expect(await runtime.read(runId)).toEqual(before);
    expect(await indexedDbWorkflowRepository.listEvents(scope, runId)).toEqual(events);
  });

  it('requires a new approval for a new attempt', async () => {
    const { runId, initial, execute, makeRuntime, scope } = setup();
    const runtime = makeRuntime();
    await runtime.create(initial);
    await runtime.resume(runId);
    await runtime.decideApproval(runId, 'video', 1, 'approved');
    execute.mockImplementation(async (task) => { if (task.id === 'video') throw new Error('连接中断'); return { output: '成功' }; });
    await runtime.resume(runId);
    await indexedDbWorkflowRepository.transact(scope, runId, (current) => {
      current!.tasks[1].status = 'queued';
      current!.run.status = 'paused';
      return { snapshot: current!, value: undefined };
    });
    const waiting = await makeRuntime().resume(runId);
    expect(waiting.tasks[1]).toMatchObject({ status: 'waiting_user', attempt: 1 });
    expect(waiting.tasks[1].approvals).toHaveLength(2);
    expect(pendingWorkflowApproval(waiting.tasks[1])?.attempt).toBe(2);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
