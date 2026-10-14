import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupChat } from '../types/chat';
import { createChatAutoSocialScheduler, getAutoSocialFlowDelayMs, hasPendingAutoSocialEventCandidate } from './useChatAutoSocialFlow';

function chatWithRuntimeEvents(runtimeEventsV2: GroupChat['runtimeEventsV2']): GroupChat {
  return {
    id: 'chat-1',
    type: 'group',
    runtimeEventsV2,
  } as GroupChat;
}

describe('hasPendingAutoSocialEventCandidate', () => {
  it('returns false when there are no social candidates', () => {
    expect(hasPendingAutoSocialEventCandidate(chatWithRuntimeEvents([
      { id: 'evt-1', kind: 'artifact', summary: 'published', payload: {}, createdAt: 1 },
    ] as GroupChat['runtimeEventsV2']))).toBe(false);
  });

  it('returns true for unhandled auto social candidates', () => {
    expect(hasPendingAutoSocialEventCandidate(chatWithRuntimeEvents([
      { id: 'candidate-1', kind: 'event_candidate', summary: 'candidate', payload: { eventKind: 'post_moment' }, createdAt: 1 },
    ] as GroupChat['runtimeEventsV2']))).toBe(true);
  });

  it('returns false for handled auto social candidates', () => {
    expect(hasPendingAutoSocialEventCandidate(chatWithRuntimeEvents([
      { id: 'candidate-1', kind: 'event_candidate', summary: 'candidate', payload: { eventKind: 'post_moment' }, createdAt: 1 },
      { id: 'handled-1', kind: 'artifact', summary: 'handled_social_event:candidate-1', payload: {}, createdAt: 2 },
    ] as GroupChat['runtimeEventsV2']))).toBe(false);
  });
});

describe('getAutoSocialFlowDelayMs', () => {
  it('runs pending candidates quickly', () => {
    expect(getAutoSocialFlowDelayMs(chatWithRuntimeEvents([
      { id: 'candidate-1', kind: 'event_candidate', summary: 'candidate', payload: { eventKind: 'post_moment' }, createdAt: 1 },
    ] as GroupChat['runtimeEventsV2']), 10_000)).toBe(8_000);
  });

  it('runs a low-frequency world tick after the chat has been idle long enough', () => {
    expect(getAutoSocialFlowDelayMs({
      ...chatWithRuntimeEvents([]),
      updatedAt: 10_000 - 2 * 60 * 60_000,
    } as GroupChat, 10_000)).toBe(12_000);
  });

  it('waits for the world idle window when the chat was just updated', () => {
    expect(getAutoSocialFlowDelayMs({
      ...chatWithRuntimeEvents([]),
      updatedAt: 10_000 - 30 * 60_000,
    } as GroupChat, 10_000)).toBe(90 * 60_000);
  });
});

describe('auto social scheduling lifecycle', () => {
  let scheduler: ReturnType<typeof createChatAutoSocialScheduler>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    scheduler = createChatAutoSocialScheduler();
  });
  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  function pendingChat() {
    return { ...chatWithRuntimeEvents([
      { id: 'candidate-1', kind: 'event_candidate', summary: '安排', payload: { eventKind: 'social_outing' }, createdAt: 10_000 },
    ] as GroupChat['runtimeEventsV2']), isActive: true, updatedAt: 10_000 };
  }

  it('checks the world repeatedly without chat mutations and keeps its deadline during messages', async () => {
    const run = vi.fn(async () => undefined);
    const onError = vi.fn();
    const chat = { ...chatWithRuntimeEvents([]), isActive: true, updatedAt: Date.now() };
    scheduler.update({ chat, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(6_000);
    scheduler.update({ chat: { ...chat, updatedAt: Date.now() }, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('continues world checks after an ineligible candidate produces no patch', async () => {
    const run = vi.fn(async () => ({ handledEventId: null }));
    scheduler.update({ chat: pendingChat(), runAutoSocialEventFlow: run, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps the deadline through continuous messages and uses the newest chat and callback', async () => {
    const oldRun = vi.fn(async () => undefined);
    const newRun = vi.fn(async () => undefined);
    const onError = vi.fn();
    scheduler.update({ chat: pendingChat(), runAutoSocialEventFlow: oldRun, onError });
    await vi.advanceTimersByTimeAsync(3_000);
    scheduler.update({ chat: { ...pendingChat(), updatedAt: 13_000 }, runAutoSocialEventFlow: oldRun, onError });
    await vi.advanceTimersByTimeAsync(3_000);
    const latestChat = { ...pendingChat(), updatedAt: 16_000, name: '最新房间' };
    scheduler.update({ chat: latestChat, runAutoSocialEventFlow: newRun, onError });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(oldRun).not.toHaveBeenCalled();
    expect(newRun).toHaveBeenCalledExactlyOnceWith(latestChat);
  });

  it('consumes committed candidates after pause without scheduling an idle world tick', async () => {
    const run = vi.fn(async () => undefined);
    const onError = vi.fn();
    scheduler.update({ chat: pendingChat(), runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(4_000);
    const paused = { ...pendingChat(), isActive: false };
    scheduler.update({ chat: paused, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledExactlyOnceWith(paused);
    scheduler.update({ chat: { ...paused, runtimeEventsV2: [] }, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not postpone consumption when another candidate arrives', async () => {
    const run = vi.fn(async () => undefined);
    const onError = vi.fn();
    const chat = pendingChat();
    scheduler.update({ chat, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(6_000);
    const next = { ...chat, runtimeEventsV2: [...chat.runtimeEventsV2!, { ...chat.runtimeEventsV2![0], id: 'candidate-2' }] };
    scheduler.update({ chat: next, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledExactlyOnceWith(next);
  });

  it('cancels a candidate consumed elsewhere before the timer fires', async () => {
    const run = vi.fn(async () => undefined);
    const onError = vi.fn();
    const chat = { ...pendingChat(), isActive: false };
    scheduler.update({ chat, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(4_000);
    scheduler.update({ chat: { ...chat, runtimeEventsV2: [...chat.runtimeEventsV2!, {
      ...chat.runtimeEventsV2![0], id: 'handled', kind: 'artifact', summary: 'handled_social_event:candidate-1',
    }] }, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('serializes candidate updates while a previous write is still pending', async () => {
    let finish: () => void = () => { throw new Error('write not started'); };
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onError = vi.fn();
    scheduler.update({ chat: pendingChat(), runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(8_000);
    const next = { ...pendingChat(), runtimeEventsV2: [{ ...pendingChat().runtimeEventsV2![0], id: 'candidate-2' }] };
    scheduler.update({ chat: next, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(next);
    finish();
  });

  it('retries failures with bounded backoff and preserves an exhausted candidate', async () => {
    const error = new Error('storage unavailable');
    const run = vi.fn(async () => { throw error; });
    const onError = vi.fn();
    const chat = pendingChat();
    scheduler.update({ chat, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(8_000);
    scheduler.update({ chat: { ...chat, updatedAt: 19_000 }, runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenLastCalledWith(error);
    expect(hasPendingAutoSocialEventCandidate(chat)).toBe(true);
  });

  it('recovers on retry using the latest callback without replaying a successful attempt', async () => {
    const onError = vi.fn();
    const run = vi.fn(async () => { throw new Error('offline'); });
    scheduler.update({ chat: pendingChat(), runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(8_000);
    const recoveredRun = vi.fn(async () => undefined);
    scheduler.update({ chat: pendingChat(), runAutoSocialEventFlow: recoveredRun, onError });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recoveredRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(recoveredRun).toHaveBeenCalledTimes(1);
  });

  it('cancels pending work on disposal and permits a fresh mount to schedule it', async () => {
    const run = vi.fn(async () => undefined);
    const onError = vi.fn();
    scheduler.update({ chat: pendingChat(), runAutoSocialEventFlow: run, onError });
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    scheduler = createChatAutoSocialScheduler();
    scheduler.update({ chat: pendingChat(), runAutoSocialEventFlow: run, onError });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
