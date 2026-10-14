import { useCallback, useRef } from 'react';
import { logDeveloperDiagnostic } from '../services/developerDiagnostics';

export interface ManualInputQueueController {
  enqueueManualInput: (task: () => Promise<void>) => Promise<void>;
  isManualInputPending: () => boolean;
}

export async function runInterruptedManualInput<T>(params: {
  enqueueManualInput: ManualInputQueueController['enqueueManualInput'];
  interrupt: () => void;
  shouldContinue: () => boolean;
  task: () => Promise<T | undefined>;
  resumeOnCompleted: boolean;
  onCompleted: (result: T) => void;
}) {
  params.interrupt();
  let result: T | undefined;
  await params.enqueueManualInput(async () => {
    if (!params.shouldContinue()) return;
    result = await params.task();
  });
  // Resume only after the queue has released its manual-input gate.
  if (params.resumeOnCompleted && result !== undefined && params.shouldContinue()) params.onCompleted(result);
}

export function useManualInputQueue(params: {
  isRunningRef: React.MutableRefObject<boolean>;
  isPausedRef: React.MutableRefObject<boolean>;
  hasPendingTurnWork: () => boolean;
  pause: () => void;
  waitTimeoutMs?: number;
}): ManualInputQueueController {
  const { isRunningRef, isPausedRef, hasPendingTurnWork, pause, waitTimeoutMs = 45_000 } = params;
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(false);

  const waitForCurrentTurnToSettle = useCallback(async () => {
    const startedAt = Date.now();
    let loggedWaitStart = false;
    while (hasPendingTurnWork() && Date.now() - startedAt < waitTimeoutMs) {
      if (!loggedWaitStart) {
        loggedWaitStart = true;
        logDeveloperDiagnostic('manual-input:wait-turn-start', {
          waitTimeoutMs,
        }, 'info', 'chat-run');
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (hasPendingTurnWork()) {
      console.error('[manual-input:wait-turn-timeout]', {
        elapsedMs: Date.now() - startedAt,
        waitTimeoutMs,
        isRunning: isRunningRef.current,
        isPaused: isPausedRef.current,
      });
      logDeveloperDiagnostic('manual-input:wait-turn-timeout', {
        elapsedMs: Date.now() - startedAt,
        waitTimeoutMs,
      }, 'warn', 'chat-run');
      throw new Error('当前发言一直没有结束，请稍后重试');
    }
    if (loggedWaitStart) {
      logDeveloperDiagnostic('manual-input:wait-turn-finished', {
        elapsedMs: Date.now() - startedAt,
      }, 'info', 'chat-run');
    }
  }, [hasPendingTurnWork, waitTimeoutMs, isRunningRef, isPausedRef]);

  const enqueueManualInput = useCallback((task: () => Promise<void>) => {
    const enqueuedAt = Date.now();
    const queued = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        pendingRef.current = true;
        try {
          logDeveloperDiagnostic('manual-input:task-start', {
            queueWaitMs: Date.now() - enqueuedAt,
          }, 'debug', 'chat-run');
          await waitForCurrentTurnToSettle();
          if (isRunningRef.current && !isPausedRef.current) {
            isPausedRef.current = true;
            pause();
          }
          await task();
        } finally {
          logDeveloperDiagnostic('manual-input:task-finished', {
            totalElapsedMs: Date.now() - enqueuedAt,
          }, 'debug', 'chat-run');
          pendingRef.current = false;
        }
      });
    queueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [isPausedRef, isRunningRef, pause, waitForCurrentTurnToSettle]);

  const isManualInputPending = useCallback(() => pendingRef.current, []);

  return { enqueueManualInput, isManualInputPending };
}
