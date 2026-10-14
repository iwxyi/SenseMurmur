import { describe, expect, it } from 'vitest';
import { resolveComposerControls } from './composerState';

const input = { canStop: true, disabled: false, submitting: false, hasDraft: false };

describe('composer controls', () => {
  it('shows an enabled stop button while sending is forbidden, even during a submission', () => {
    expect(resolveComposerControls({ ...input, submitting: true,
      state: { phase: 'generating', canSend: false, canCancel: true },
    })).toMatchObject({ pending: true, showStop: true, sendDisabled: true, buttonDisabled: false });
  });
  it('uses the current composer state over a stale legacy pending flag', () => {
    expect(resolveComposerControls({ ...input, hasDraft: true, legacyPending: true,
      state: { phase: 'idle', canSend: true, canCancel: false },
    })).toMatchObject({ pending: false, showStop: false, buttonDisabled: false });
  });
  it('marks a branch reply as busy independently of local user submission', () => {
    expect(resolveComposerControls({ ...input, state: { phase: 'generating', canCancel: true } }))
      .toMatchObject({ pending: true, showStop: true, buttonDisabled: false });
  });
  it('shows busy state for work that cannot be cancelled', () => {
    expect(resolveComposerControls({ ...input, hasDraft: true,
      state: { phase: 'committing', canCancel: false },
    })).toMatchObject({ pending: true, showStop: false, buttonDisabled: true });
  });
  it('does not spin for paused or failed runs', () => {
    for (const phase of ['paused', 'error'] as const) {
      expect(resolveComposerControls({ ...input, hasDraft: true, state: { phase } }))
        .toMatchObject({ pending: false, showStop: false, buttonDisabled: false });
    }
  });
});
