import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupChat } from '../types/chat';
import { createApplicationSocialScheduler, getDailyMomentImageErrorMessage } from './useApplicationSocialFlow';

describe('daily moment image failure feedback', () => {
  it('distinguishes service limits and quota without showing provider details', () => {
    expect(getDailyMomentImageErrorMessage({ diagnostic: { status: 429 } })).toContain('请求受限');
    expect(getDailyMomentImageErrorMessage({ diagnostic: { status: 403, code: 'insufficient_user_quota' } })).toContain('额度不足');
    expect(getDailyMomentImageErrorMessage({ diagnostic: { status: 403 } })).toContain('无权访问');
    expect(getDailyMomentImageErrorMessage(new Error('secret provider response'))).toBe('朋友圈配图生成失败，本次发布文字动态。');
  });
});

describe('application social execution host', () => {
  let host: ReturnType<typeof createApplicationSocialScheduler>;
  beforeEach(() => { vi.useFakeTimers(); host = createApplicationSocialScheduler(); });
  afterEach(() => { host.dispose(); vi.useRealTimers(); });
  const chat = (id: string): GroupChat => ({ id, type: 'group', runtimeEventsV2: [
    { id: `${id}-candidate`, kind: 'event_candidate', payload: { eventKind: 'check_in' } },
  ] } as GroupChat);

  it('keeps each room deadline across application updates and uses the latest callback', async () => {
    const oldRun = vi.fn();
    const run = vi.fn().mockResolvedValue({});
    host.update([chat('a'), chat('b')], oldRun, vi.fn());
    await vi.advanceTimersByTimeAsync(4000);
    host.update([chat('a'), chat('b')], run, vi.fn());
    await vi.advanceTimersByTimeAsync(4000);
    expect(oldRun).not.toHaveBeenCalled();
    expect(run.mock.calls.map(([room]) => room.id)).toEqual(['a', 'b']);
    host.update([chat('a'), chat('b')], run, vi.fn());
    await vi.advanceTimersByTimeAsync(8000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stops removed, deleted and private rooms and clears timers on disposal', async () => {
    const run = vi.fn();
    host.update([chat('a'), chat('b')], run, vi.fn());
    host.update([{ ...chat('a'), deletedAt: 1 }, { ...chat('b'), type: 'direct' }], run, vi.fn());
    await vi.advanceTimersByTimeAsync(8000);
    expect(run).not.toHaveBeenCalled();
    host.update([chat('c')], run, vi.fn());
    host.dispose();
    await vi.advanceTimersByTimeAsync(8000);
    expect(run).not.toHaveBeenCalled();
  });
});
