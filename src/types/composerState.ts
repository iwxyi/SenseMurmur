export type ComposerPhase = 'idle' | 'queued' | 'cancelling' | 'branching' | 'committing' | 'waiting_turn' | 'generating' | 'processing_media' | 'submitting_artifact' | 'paused' | 'error';
export interface ComposerState {
  phase: ComposerPhase;
  label?: string;
  hint?: string;
  canSend?: boolean;
  canDraft?: boolean;
  canCancel?: boolean;
  canSwitchBranch?: boolean;
}

export function resolveComposerControls(input: {
  state?: ComposerState;
  legacyPending?: boolean;
  canStop: boolean;
  disabled: boolean;
  submitting: boolean;
  hasDraft: boolean;
}) {
  const pending = input.state
    ? !['idle', 'error', 'paused'].includes(input.state.phase)
    : Boolean(input.legacyPending);
  const showStop = pending && input.state?.canCancel !== false && input.canStop;
  const sendDisabled = input.disabled || input.state?.canSend === false;
  return {
    pending,
    showStop,
    sendDisabled,
    buttonDisabled: showStop ? input.disabled : sendDisabled || !input.hasDraft || input.submitting || pending,
  };
}
