import { describe, expect, it, vi } from 'vitest';
import { createReplyOperation } from './replyOperation';

describe('reply operation ownership', () => {
  it('publishes start and completion for detached replies', () => {
    const operation = createReplyOperation();
    const states: boolean[] = [];
    operation.subscribe(() => states.push(operation.getSnapshot()));
    const { controller } = operation.begin();
    operation.finish(controller);
    expect(states).toEqual([true, false]);
  });

  it('cancels immediately on branch switching, even if the request has not settled', () => {
    const operation = createReplyOperation();
    const { controller, epoch } = operation.begin();
    operation.cancel();
    expect(controller.signal.aborted).toBe(true);
    expect(operation.epochRef.current).not.toBe(epoch);
    expect(operation.getSnapshot()).toBe(false);
    operation.finish(controller);
    expect(operation.getSnapshot()).toBe(false);
  });

  it('does not let an old finally clear a replacement request', () => {
    const operation = createReplyOperation();
    const first = operation.begin();
    const second = operation.begin();
    expect(first.controller.signal.aborted).toBe(true);
    operation.finish(first.controller);
    expect(operation.getSnapshot()).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    operation.finish(second.controller);
    expect(operation.getSnapshot()).toBe(false);
  });

  it('releases the request when loading the reply module or generation fails', async () => {
    const operation = createReplyOperation();
    const { controller } = operation.begin();
    await expect((async () => {
      try {
        await Promise.reject(new Error('module unavailable'));
      } finally {
        operation.finish(controller);
      }
    })()).rejects.toThrow('module unavailable');
    expect(operation.getSnapshot()).toBe(false);
  });

  it('removes subscribers on unmount', () => {
    const operation = createReplyOperation();
    const listener = vi.fn();
    const unsubscribe = operation.subscribe(listener);
    unsubscribe();
    operation.begin();
    expect(listener).not.toHaveBeenCalled();
  });
});
