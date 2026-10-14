import { describe, expect, it, vi } from 'vitest';
import { createTurnWorkTracker } from './turnWorkTracker';

describe('turn work lifecycle', () => {
  it('notifies subscribers when the last pending turn finishes', () => {
    const tracker = createTurnWorkTracker();
    tracker.activate('first');
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.change('first', 'turn', 1);
    tracker.change('first', 'commit', 1);
    tracker.change('first', 'commit', -1);
    tracker.change('first', 'turn', -1);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(tracker.getSnapshot()).toEqual({ turn: 0, commit: 0 });
  });
  it('isolates cleanup from an aborted run after a new run starts', () => {
    const tracker = createTurnWorkTracker();
    tracker.activate('old');
    tracker.change('old', 'turn', 1);
    tracker.clear();
    tracker.activate('new');
    tracker.change('new', 'turn', 1);
    tracker.change('old', 'turn', -1);
    tracker.clear('old');
    expect(tracker.getSnapshot().turn).toBe(1);
    tracker.change('new', 'turn', -1);
    expect(tracker.getSnapshot().turn).toBe(0);
  });
  it('reports mismatched completion instead of silently clamping counts', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tracker = createTurnWorkTracker();
    tracker.activate('run');
    tracker.change('run', 'commit', -1);
    expect(error).toHaveBeenCalledWith('[chat-run:unbalanced-work]', expect.any(Object));
    error.mockRestore();
  });
});
