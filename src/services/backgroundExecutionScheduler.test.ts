import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBackgroundExecutionSummary, scheduleBackgroundExecution } from './backgroundExecutionScheduler';
import { setBackgroundExecutionMaxActiveConversations } from './backgroundExecutionPreferences';

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

describe('background execution scheduler', () => {
  beforeEach(() => setBackgroundExecutionMaxActiveConversations(3));
  it('honors the concurrency preference and starts queued work when the limit increases', async () => {
    setBackgroundExecutionMaxActiveConversations(1);
    const firstGate = deferred();
    const first = scheduleBackgroundExecution('preference-a', async () => { await firstGate.wait; });
    const second = vi.fn(async () => undefined);
    const queued = scheduleBackgroundExecution('preference-b', second);
    await Promise.resolve();
    expect(getBackgroundExecutionSummary()).toMatchObject({ active: 1, queued: 1 });
    expect(second).not.toHaveBeenCalled();
    setBackgroundExecutionMaxActiveConversations(2);
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    firstGate.release();
    await Promise.all([first, queued]);
    setBackgroundExecutionMaxActiveConversations(3);
  });

  it('serializes one chat while another chat can run', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const first = vi.fn(async () => { await firstGate.wait; return 'first'; });
    const sameChat = vi.fn(async () => 'same');
    const otherChat = vi.fn(async () => { await secondGate.wait; return 'other'; });
    const firstResult = scheduleBackgroundExecution('chat-a', first, undefined, 'run-a');
    const waitingResult = scheduleBackgroundExecution('chat-a', sameChat, undefined, 'run-waiting');
    const otherResult = scheduleBackgroundExecution('chat-b', otherChat);
    await vi.waitFor(() => expect(otherChat).toHaveBeenCalledTimes(1));
    expect(sameChat).not.toHaveBeenCalled();
    expect(getBackgroundExecutionSummary()).toMatchObject({ active: 2, queued: 1 });
    expect(getBackgroundExecutionSummary().activeWorkIds).toEqual(['run-a']);
    firstGate.release();
    await expect(firstResult).resolves.toBe('first');
    await expect(waitingResult).resolves.toBe('same');
    secondGate.release();
    await expect(otherResult).resolves.toBe('other');
  });

  it('limits active chats and starts the next queued chat after a slot is released', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const running = gates.map((gate, index) => scheduleBackgroundExecution(`chat-${index}`, async () => { await gate.wait; return index; }));
    const fourth = vi.fn(async () => 4);
    const waiting = scheduleBackgroundExecution('chat-4', fourth);
    expect(getBackgroundExecutionSummary()).toMatchObject({ active: 3, queued: 1 });
    expect(fourth).not.toHaveBeenCalled();
    gates[0].release();
    await expect(running[0]).resolves.toBe(0);
    await expect(waiting).resolves.toBe(4);
    gates[1].release(); gates[2].release();
    await Promise.all([running[1], running[2]]);
  });

  it('round-robins queued sessions so one busy chat cannot starve another', async () => {
    setBackgroundExecutionMaxActiveConversations(1);
    const firstGate = deferred();
    const order: string[] = [];
    const first = scheduleBackgroundExecution('fair-a', async () => { order.push('a1'); await firstGate.wait; });
    const queuedA = scheduleBackgroundExecution('fair-a', async () => { order.push('a2'); });
    const queuedA2 = scheduleBackgroundExecution('fair-a', async () => { order.push('a3'); });
    const queuedB = scheduleBackgroundExecution('fair-b', async () => { order.push('b1'); });

    firstGate.release();
    await Promise.all([first, queuedA, queuedA2, queuedB]);

    expect(order).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it('releases a chat slot when a task throws before returning a promise', async () => {
    const first = scheduleBackgroundExecution('sync-throw', () => { throw new Error('启动失败'); }, undefined, 'failed-run');
    const next = scheduleBackgroundExecution('sync-throw', async () => 'recovered', undefined, 'next-run');
    await expect(first).rejects.toThrow('启动失败');
    await expect(next).resolves.toBe('recovered');
    expect(getBackgroundExecutionSummary()).toMatchObject({ active: 0, queued: 0, activeWorkIds: [] });
  });

  it('does not invoke a claimed task if its signal aborts before dispatch', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => 'unexpected');
    const pending = scheduleBackgroundExecution('abort-before-dispatch', execute, controller.signal, 'aborted-run');
    controller.abort(new Error('账号已切换'));
    await expect(pending).rejects.toThrow('账号已切换');
    expect(execute).not.toHaveBeenCalled();
    expect(getBackgroundExecutionSummary()).toMatchObject({ active: 0, queued: 0, activeWorkIds: [] });
  });
});
