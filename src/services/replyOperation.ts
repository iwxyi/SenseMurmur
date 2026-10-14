import { logDeveloperDiagnostic } from './developerDiagnostics';

export function createReplyOperation() {
  const controllerRef: { current: AbortController | null } = { current: null };
  const epochRef = { current: 0 };
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  return {
    controllerRef,
    epochRef,
    getSnapshot: () => controllerRef.current !== null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin() {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const epoch = ++epochRef.current;
      logDeveloperDiagnostic('reply-operation:started', { epoch }, 'debug', 'chat-run');
      publish();
      return { controller, epoch };
    },
    finish(controller: AbortController) {
      // An old request may finish after branch switching or another send.
      if (controllerRef.current !== controller) {
        logDeveloperDiagnostic('reply-operation:stale-completion', { epoch: epochRef.current }, 'debug', 'chat-run');
        return;
      }
      controllerRef.current = null;
      logDeveloperDiagnostic('reply-operation:finished', { epoch: epochRef.current }, 'debug', 'chat-run');
      publish();
    },
    cancel() {
      controllerRef.current?.abort();
      controllerRef.current = null;
      epochRef.current += 1;
      logDeveloperDiagnostic('reply-operation:cancelled', { epoch: epochRef.current }, 'debug', 'chat-run');
      publish();
    },
  };
}
