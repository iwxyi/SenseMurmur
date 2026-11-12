import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { api } from './api';
import { prepareAiMediaTask, submitPreparedAiMediaTask } from './aiClient';
import { createWorkflowRunRuntime, indexedDbWorkflowRepository, type WorkflowSnapshot, type WorkflowTask } from './workflowRunRuntime';
import type { WorkflowApprovalRequirement } from './workflowApproval';

beforeAll(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
beforeEach(() => {
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}) } });
});
afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const runId = crypto.randomUUID();
  const scope = `approval-preparation-${runId}`;
  let configuration = 'a'.repeat(64);
  let quoteRevision = 'b';
  let fresh = true;
  const response = () => ({ schemaVersion: 1, id: quoteRevision.repeat(64), model: 'fixture-video', modality: 'video',
    requestSha256: 'c'.repeat(64), costQuoteId: 'd'.repeat(64), amount: '1.250000', unit: 'credit',
    kind: 'request_tariff', capturedAt: 1000, expiresAt: 301000, token: 'e'.repeat(64) });
  const preview = vi.spyOn(api, 'quoteAiMedia').mockImplementation(async () => response());
  const generate = vi.spyOn(api, 'generateAiMedia').mockResolvedValue({ task_id: 'accepted', status: 'running' });
  const approvalRequirement = (task: WorkflowTask): WorkflowApprovalRequirement => {
    const prior = task.approvals?.at(-1);
    return { summary: '生成视频', consequences: '会产生费用', executionSha256: configuration,
      ...(fresh && prior?.executionSha256 === configuration && prior.mediaExecution?.quote.id === quoteRevision.repeat(64)
        ? { mediaExecution: prior.mediaExecution } : {}) };
  };
  const prepare = vi.fn(async (_task: WorkflowTask, _snapshot: WorkflowSnapshot, requirement: WorkflowApprovalRequirement, signal: AbortSignal) => {
    if (requirement.mediaExecution) return requirement;
    const mediaExecution = await prepareAiMediaTask({ profile: { provider: 'official-ace', model: 'fixture-video' },
      prompt: '根据脚本制作森林短片', parameters: { duration: 5, resolution: '720p' }, clientRequestKey: runId, signal });
    fresh = true;
    return { ...requirement, mediaExecution };
  });
  const execute = vi.fn(async (task: WorkflowTask, _signal: AbortSignal, context: { beginToolInvocation(): Promise<void> }) => {
    await context.beginToolInvocation();
    await submitPreparedAiMediaTask(task.approvals!.at(-1)!.mediaExecution!);
    return { output: '已提交' };
  });
  const makeRuntime = () => createWorkflowRunRuntime(indexedDbWorkflowRepository, {
    tracksToolInvocations: true, approvalRequirement, prepareApprovalRequirement: prepare, execute,
  }, () => scope);
  const initial: WorkflowSnapshot = { run: { id: runId, chatId: 'chat', goal: '制作短片', status: 'active', planVersion: 1, generation: 0, updatedAt: 1 },
    tasks: [{ id: 'video', runId, kind: 'agent_video', input: '森林', dependsOn: [], status: 'queued', attempt: 0, updatedAt: 1 }] };
  return { runId, scope, initial, makeRuntime, preview, generate, execute, prepare,
    changeConfiguration: () => { configuration = 'f'.repeat(64); },
    expireQuote: () => { fresh = false; quoteRevision = 'f'; }, response };
}

describe('asynchronous approval preparation outside storage transactions', () => {
  it('persists a preparation failure as a pause without consuming an attempt or submitting', async () => {
    const test = setup();
    test.preview.mockRejectedValueOnce(new Error('报价服务不可用'));
    const runtime = test.makeRuntime();
    await runtime.create(test.initial);
    const paused = await runtime.resume(test.runId);
    expect(paused.run).toMatchObject({ status: 'paused', pauseReason: '执行报价准备失败：报价服务不可用' });
    expect(paused.tasks[0]).toMatchObject({ status: 'queued', attempt: 0 });
    expect(paused.tasks[0].approvals).toBeUndefined();
    expect(test.generate).not.toHaveBeenCalled();
    expect((await test.makeRuntime().read(test.runId))?.run.status).toBe('paused');
    expect((await runtime.resume(test.runId)).tasks[0].status).toBe('waiting_user');
    expect(test.preview).toHaveBeenCalledTimes(2);
  });

  it('preserves a concurrent pause when quotation fails late', async () => {
    const test = setup(); const started = deferred(); const release = deferred();
    test.preview.mockImplementation(async () => { started.resolve(); await release.promise; throw new Error('late failure'); });
    const runtime = test.makeRuntime(); await runtime.create(test.initial);
    const running = runtime.resume(test.runId);
    await started.promise; await runtime.pause(test.runId); release.resolve();
    const paused = await running;
    expect(paused.run).toMatchObject({ status: 'paused' });
    expect(paused.run.pauseReason).toBeUndefined();
    expect(paused.tasks[0].attempt).toBe(0);
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('persists quotation before consent, restores it and submits precisely the approved request', async () => {
    const test = setup();
    const runtime = test.makeRuntime();
    await runtime.create(test.initial);
    const pending = await runtime.resume(test.runId);
    expect(pending.tasks[0]).toMatchObject({ status: 'waiting_user', attempt: 0,
      approvals: [{ mediaExecution: { quote: test.response(), request: { prompt: '根据脚本制作森林短片', duration: 5 } } }] });
    expect(test.generate).not.toHaveBeenCalled();
    const restored = test.makeRuntime();
    await restored.decideApproval(test.runId, 'video', 1, 'approved');
    expect((await restored.resume(test.runId)).run.status).toBe('completed');
    expect(test.preview).toHaveBeenCalledOnce();
    expect(test.generate).toHaveBeenCalledWith({ ...test.preview.mock.calls[0][0], execution_quote: test.response() }, {});
    await test.makeRuntime().resume(test.runId);
    expect(test.generate).toHaveBeenCalledOnce();
  });

  it('allows a concurrent IndexedDB pause during network preparation and discards the late quote', async () => {
    const test = setup();
    const started = deferred(); const release = deferred();
    test.preview.mockImplementation(async () => { started.resolve(); await release.promise; return test.response(); });
    const runtime = test.makeRuntime(); await runtime.create(test.initial);
    const running = runtime.resume(test.runId);
    await started.promise;
    await runtime.pause(test.runId);
    release.resolve();
    const paused = await running;
    expect(paused.run.status).toBe('paused');
    expect(paused.tasks[0].approvals).toBeUndefined();
    expect(paused.tasks[0].attempt).toBe(0);
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('discards a quote when configuration changes before it can be persisted', async () => {
    const test = setup();
    test.preview.mockImplementationOnce(async () => { test.changeConfiguration(); return test.response(); });
    const runtime = test.makeRuntime(); await runtime.create(test.initial);
    const pending = await runtime.resume(test.runId);
    expect(test.preview).toHaveBeenCalledTimes(2);
    expect(pending.tasks[0].approvals).toHaveLength(1);
    expect(pending.tasks[0].approvals?.[0].executionSha256).toBe('f'.repeat(64));
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('replaces an expired pending quote and requires a separate approval of its new price', async () => {
    const test = setup(); const runtime = test.makeRuntime(); await runtime.create(test.initial);
    await runtime.resume(test.runId);
    test.expireQuote();
    const replaced = await runtime.decideApproval(test.runId, 'video', 1, 'approved');
    expect(replaced.run.planVersion).toBe(2);
    expect(replaced.tasks[0].approvals).toHaveLength(2);
    expect(replaced.tasks[0].approvals?.[0].invalidatedAt).toEqual(expect.any(Number));
    expect(replaced.tasks[0].approvals?.every((approval) => approval.decision === undefined)).toBe(true);
    expect(replaced.tasks[0].status).toBe('waiting_user');
    await test.makeRuntime().decideApproval(test.runId, 'video', 2, 'approved');
    await test.makeRuntime().resume(test.runId);
    expect(test.generate).toHaveBeenCalledOnce();
    expect(test.preview).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale pending quote without a network request', async () => {
    const test = setup(); const runtime = test.makeRuntime(); await runtime.create(test.initial);
    await runtime.resume(test.runId);
    test.expireQuote();
    test.preview.mockRejectedValue(new Error('服务不可用'));
    const rejected = await runtime.decideApproval(test.runId, 'video', 1, 'rejected');
    expect(rejected.run.status).toBe('cancelled');
    expect(test.preview).toHaveBeenCalledOnce();
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('does not save approval when the workflow changes during quote refresh', async () => {
    const test = setup(); const runtime = test.makeRuntime(); await runtime.create(test.initial);
    await runtime.resume(test.runId); test.expireQuote();
    const started = deferred(); const release = deferred();
    test.preview.mockImplementation(async () => { started.resolve(); await release.promise; return test.response(); });
    const decision = runtime.decideApproval(test.runId, 'video', 1, 'approved');
    await started.promise;
    await runtime.pause(test.runId);
    release.resolve();
    await expect(decision).rejects.toThrow('审批准备期间任务或配置已改变');
    const saved = await runtime.read(test.runId);
    expect(saved?.tasks[0].approvals).toHaveLength(1);
    expect(saved?.tasks[0].approvals?.[0].decision).toBeUndefined();
    expect(test.generate).not.toHaveBeenCalled();
  });
});
