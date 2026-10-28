import { useCallback, useRef, useState } from 'react';

const SHOW_THRESHOLD = 20;
const HIDE_THRESHOLD = 56;
// Ignore touch-scroll noise so the header does not toggle around a resting point.
const MIN_DELTA = 12;
const MIN_HIDE_SCROLL_RANGE = 80;
const MIN_HIDE_BOTTOM_SLACK = 72;

type AutoHideHeaderMetrics = {
  scrollHeight: number;
  clientHeight: number;
};

export function useAutoHideHeader(disabled = false) {
  const lastScrollTopRef = useRef(0);
  const [hidden, setHidden] = useState(false);

  const reset = useCallback(() => {
    lastScrollTopRef.current = 0;
    setHidden(false);
  }, []);

  const syncScrollTop = useCallback((nextTop: number) => {
    lastScrollTopRef.current = nextTop;
  }, []);

  const handleScrollTop = useCallback((nextTop: number, metrics?: AutoHideHeaderMetrics) => {
    if (disabled) return;
    const previousTop = lastScrollTopRef.current;
    const delta = nextTop - previousTop;
    lastScrollTopRef.current = nextTop;

    const scrollRange = metrics ? Math.max(0, metrics.scrollHeight - metrics.clientHeight) : Number.POSITIVE_INFINITY;
    const bottomSlack = Math.max(0, scrollRange - nextTop);
    const setHiddenIfChanged = (next: boolean) => {
      setHidden((current) => current === next ? current : next);
    };
    if (scrollRange < MIN_HIDE_SCROLL_RANGE) {
      setHiddenIfChanged(false);
      return;
    }
    if (!hidden && bottomSlack < MIN_HIDE_BOTTOM_SLACK) {
      setHiddenIfChanged(false);
      return;
    }

    if (nextTop <= SHOW_THRESHOLD) {
      setHiddenIfChanged(false);
      return;
    }

    if (Math.abs(delta) < MIN_DELTA) return;

    if (delta > 0) {
      if (!hidden && nextTop >= HIDE_THRESHOLD) setHiddenIfChanged(true);
      return;
    }

    if (hidden) setHiddenIfChanged(false);
  }, [disabled, hidden]);

  return { hidden: disabled ? false : hidden, reset, syncScrollTop, handleScrollTop };
}
