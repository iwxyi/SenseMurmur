type WorkPhase = 'turn' | 'commit';

export function createTurnWorkTracker() {
  let loopId: string | null = null;
  let snapshot = { turn: 0, commit: 0 };
  const listeners = new Set<() => void>();
  const publish = (next: typeof snapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate(id: string) {
      loopId = id;
      publish({ turn: 0, commit: 0 });
    },
    change(id: string, phase: WorkPhase, delta: 1 | -1) {
      // A cancelled run can finish after the next run has already started.
      if (id !== loopId) return;
      const count = snapshot[phase] + delta;
      if (count < 0) {
        console.error('[chat-run:unbalanced-work]', { phase, counts: snapshot });
        return;
      }
      publish({ ...snapshot, [phase]: count });
    },
    clear(id?: string) {
      if (id !== undefined && id !== loopId) return null;
      const remaining = snapshot;
      loopId = null;
      publish({ turn: 0, commit: 0 });
      return remaining;
    },
  };
}
