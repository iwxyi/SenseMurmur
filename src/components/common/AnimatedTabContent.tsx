import { Box } from '@mui/material';
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { SxProps, Theme } from '@mui/material/styles';
import { motion } from '../../styles/motion';

type AnimatedTabContentProps<T extends string | number> = {
  value: T;
  direction?: -1 | 1;
  children: ReactNode;
  sx?: SxProps<Theme>;
};

type TabPane<T extends string | number> = {
  value: T;
  children: ReactNode;
  slot: 0 | 1;
};

type TabTransition<T extends string | number> = {
  key: number;
  outgoing: TabPane<T>;
  direction: -1 | 1;
};

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeToReducedMotionChange(onStoreChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => undefined;
  }
  const mediaQueryList = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQueryList.addEventListener('change', onStoreChange);
  return () => mediaQueryList.removeEventListener('change', onStoreChange);
}

function getReducedMotionSnapshot() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

function getReducedMotionServerSnapshot() {
  return false;
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotionChange,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

export default function AnimatedTabContent<T extends string | number>({ value, direction = 1, children, sx }: AnimatedTabContentProps<T>) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const paneChildrenByValueRef = useRef(new Map<T, ReactNode>());
  const [currentPane, setCurrentPane] = useState<TabPane<T>>(() => ({
    value,
    children,
    slot: 0,
  }));
  const [transition, setTransition] = useState<TabTransition<T> | null>(null);
  const transitionKeyRef = useRef(0);

  useLayoutEffect(() => {
    paneChildrenByValueRef.current.set(value, children);
    let cancelled = false;
    const scheduleStateUpdate = (callback: () => void) => {
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
    };

    if (prefersReducedMotion && transition !== null) {
      scheduleStateUpdate(() => setTransition(null));
    }

    if (Object.is(currentPane.value, value)) {
      return () => {
        cancelled = true;
      };
    }

    const nextPane: TabPane<T> = {
      value,
      children,
      slot: currentPane.slot === 0 ? 1 : 0,
    };
    const outgoingPane: TabPane<T> = {
      ...currentPane,
      // The outgoing pane must be frozen, while the active pane always renders
      // the newest children so controlled inputs keep their IME composition state.
      children: paneChildrenByValueRef.current.get(currentPane.value) ?? currentPane.children,
    };

    if (prefersReducedMotion) {
      scheduleStateUpdate(() => {
        setTransition(null);
        setCurrentPane(nextPane);
      });
      return () => {
        cancelled = true;
      };
    }

    transitionKeyRef.current += 1;
    const transitionKey = transitionKeyRef.current;
    scheduleStateUpdate(() => {
      setTransition({
        key: transitionKey,
        outgoing: outgoingPane,
        direction,
      });
      setCurrentPane(nextPane);
    });

    return () => {
      cancelled = true;
    };
  }, [children, currentPane, direction, prefersReducedMotion, transition, value]);

  const enteringAnimation = `animatedTabContentEnter ${motion.durations.navTrack}ms ${motion.standard} both`;
  const exitingAnimation = `animatedTabContentExit ${motion.durations.navTrack}ms ${motion.standard} both`;
  const effectiveDirection = transition?.direction ?? direction;

  const renderPane = (slot: 0 | 1) => {
    const outgoing = transition?.outgoing.slot === slot ? transition.outgoing : null;
    const pane = outgoing || (currentPane.slot === slot ? currentPane : null);
    if (!pane) return null;

    const isOutgoing = outgoing !== null;
    return (
      <Box
        key={`slot-${slot}`}
        aria-hidden={isOutgoing || undefined}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget || isOutgoing
            || event.animationName !== 'animatedTabContentEnter') return;
          // Mounting cards can block the main thread longer than the animation
          // duration. Finish on playback completion, not a timer set before paint.
          const completedKey = transition?.key;
          setTransition((current) => current?.key === completedKey ? null : current);
        }}
        sx={{
          minWidth: 0,
          position: isOutgoing ? 'absolute' : 'relative',
          ...(isOutgoing ? {
            inset: 0,
            width: '100%',
            pointerEvents: 'none',
          } : {}),
          animation: prefersReducedMotion || transition === null
            ? undefined
            : (isOutgoing ? exitingAnimation : enteringAnimation),
          willChange: transition === null ? undefined : 'transform',
        }}
      >
        <Box key={String(pane.value)} sx={{ minWidth: 0 }}>
          {isOutgoing ? pane.children : children}
        </Box>
      </Box>
    );
  };

  return (
    <Box
      sx={{
        minWidth: 0,
        position: 'relative',
        overflow: 'hidden',
        '--tab-enter-offset': effectiveDirection >= 0 ? '100%' : '-100%',
        '--tab-exit-offset': effectiveDirection >= 0 ? '-100%' : '100%',
        '@keyframes animatedTabContentEnter': {
          from: {
            transform: 'translate3d(var(--tab-enter-offset), 0, 0)',
          },
          to: {
            transform: 'translate3d(0, 0, 0)',
          },
        },
        '@keyframes animatedTabContentExit': {
          from: {
            transform: 'translate3d(0, 0, 0)',
          },
          to: {
            transform: 'translate3d(var(--tab-exit-offset), 0, 0)',
          },
        },
        '@media (prefers-reduced-motion: reduce)': {
          '@keyframes animatedTabContentEnter': {
            from: { opacity: 0.72 },
            to: { opacity: 1 },
          },
          '@keyframes animatedTabContentExit': {
            from: { opacity: 1 },
            to: { opacity: 0 },
          },
        },
        ...sx,
      }}
    >
      {renderPane(0)}
      {renderPane(1)}
    </Box>
  );
}
