import { describe, expect, it, vi } from 'vitest';
import { getBackgroundExecutionSummary, scheduleBackgroundExecution } from './backgroundExecutionScheduler';

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

describe('background execution scheduler', () => {
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
});
