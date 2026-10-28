import { Box, ButtonBase } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { motion, reducedMotionSx, transition } from '../../styles/motion';
import { buildFloatingTabGroupSx } from './FloatingSegmentedTabs.styles';
import { requestNearestContentScrollToTop } from '../../services/contentScrollRegion';

type FloatingSegmentedTab<T extends string | number> = {
  value: T;
  label: ReactNode;
};

const POINTER_Y_TOLERANCE_PX = 52;
const POINTER_X_TOLERANCE_PX = 44;
const TOUCH_SCROLL_INTENT_PX = 8;
const TOUCH_POINTER_Y_TOLERANCE_PX = 68;
const TOUCH_POINTER_X_TOLERANCE_PX = 58;
const TAB_SCROLL_PADDING_PX = 6;
const TAB_INDICATOR_MIN_DURATION_MS = 140;
const TAB_INDICATOR_MAX_DURATION_MS = 260;
const TAB_EDGE_FADE_WIDTH_PX = 22;

export type FloatingSegmentedTabsProps<T extends string | number> = {
  value: T;
  items: FloatingSegmentedTab<T>[];
  onChange: (value: T) => void;
  equalWidth?: boolean;
  comfortable?: boolean;
  scrollContentToTopOnChange?: boolean;
};

export default function FloatingSegmentedTabs<T extends string | number>({
  value,
  items,
  onChange,
  equalWidth = true,
  comfortable = true,
  scrollContentToTopOnChange = false,
}: FloatingSegmentedTabsProps<T>) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollAnimationRef = useRef<number | null>(null);
  const pointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    pointerType: string;
    allowDragPreview: boolean;
    scrollIntent: boolean;
  } | null>(null);
  const previewValueRef = useRef<T | null>(null);
  const latestPointerTypeRef = useRef<string>('mouse');
  const suppressClickRef = useRef(false);
  const animateIndicatorRef = useRef(false);
  const animateScrollRef = useRef(false);
  const hasPositionedScrollRef = useRef(false);
  const [previewValue, setPreviewValue] = useState<T | null>(null);
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  const visualValue = previewValue ?? value;

  const tabFeedbackBg = useCallback((theme: Theme) => (
    theme.palette.mode === 'light' ? 'rgba(15,23,42,0.055)' : 'rgba(226,232,240,0.085)'
  ), []);
  const tabPressedBg = useCallback((theme: Theme) => (
    theme.palette.mode === 'light' ? 'rgba(15,23,42,0.07)' : 'rgba(226,232,240,0.11)'
  ), []);

  const markIndicatorAnimation = useCallback(() => {
    animateIndicatorRef.current = true;
  }, []);

  const markScrollAnimation = useCallback(() => {
    animateScrollRef.current = true;
  }, []);

  const commitChange = useCallback((nextValue: T) => {
    if (nextValue === value) return;
    if (scrollContentToTopOnChange) {
      requestNearestContentScrollToTop(scrollContainerRef.current, { preserveHeader: false });
    }
    onChange(nextValue);
  }, [onChange, scrollContentToTopOnChange, value]);

  const setVisualPreview = useCallback((nextValue: T | null) => {
    if (previewValueRef.current === nextValue) return;
    previewValueRef.current = nextValue;
    setPreviewValue(nextValue);
  }, []);

  const itemValues = useMemo(() => items.map((item) => item.value), [items]);

  const stopScrollAnimation = useCallback(() => {
    if (scrollAnimationRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationRef.current);
      scrollAnimationRef.current = null;
    }
  }, []);

  const animateScrollTo = useCallback((container: HTMLDivElement, nextLeft: number, animated: boolean) => {
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const targetLeft = Math.max(0, Math.min(maxLeft, nextLeft));
    const startLeft = container.scrollLeft;
    const distance = targetLeft - startLeft;
    stopScrollAnimation();
    if (!animated || Math.abs(distance) < 1 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      container.scrollLeft = targetLeft;
      return;
    }

    const duration = Math.max(
      motion.durations.navTrack,
      Math.min(motion.durations.settle, Math.round(Math.abs(distance) * 0.72)),
    );
    const startedAt = window.performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      container.scrollLeft = startLeft + distance * eased;
      if (progress < 1) {
        scrollAnimationRef.current = window.requestAnimationFrame(step);
      } else {
        scrollAnimationRef.current = null;
      }
    };
    scrollAnimationRef.current = window.requestAnimationFrame(step);
  }, [stopScrollAnimation]);

  const updateScrollPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    const selectedIndex = itemValues.findIndex((candidate) => candidate === value);
    const target = itemRefs.current.get(String(value));
    if (!container || !target || selectedIndex < 0 || container.scrollWidth <= container.clientWidth + 1) {
      hasPositionedScrollRef.current = true;
      animateScrollRef.current = false;
      return;
    }

    const previous = itemRefs.current.get(String(itemValues[selectedIndex - 1]));
    const next = itemRefs.current.get(String(itemValues[selectedIndex + 1]));
    const viewportStart = container.scrollLeft;
    const viewportEnd = viewportStart + container.clientWidth;
    const desiredStart = Math.max(0, (previous || target).offsetLeft - TAB_SCROLL_PADDING_PX);
    const desiredEndNode = next || target;
    const desiredEnd = desiredEndNode.offsetLeft + desiredEndNode.offsetWidth + TAB_SCROLL_PADDING_PX;
    const targetStart = Math.max(0, target.offsetLeft - TAB_SCROLL_PADDING_PX);
    const targetEnd = target.offsetLeft + target.offsetWidth + TAB_SCROLL_PADDING_PX;
    const desiredWidth = desiredEnd - desiredStart;
    let nextLeft = viewportStart;

    if (desiredWidth <= container.clientWidth) {
      if (desiredStart < viewportStart) nextLeft = desiredStart;
      else if (desiredEnd > viewportEnd) nextLeft = desiredEnd - container.clientWidth;
    } else if (targetStart < viewportStart) {
      nextLeft = targetStart;
    } else if (targetEnd > viewportEnd) {
      nextLeft = targetEnd - container.clientWidth;
    }

    const shouldAnimate = hasPositionedScrollRef.current && animateScrollRef.current;
    hasPositionedScrollRef.current = true;
    animateScrollRef.current = false;
    if (Math.abs(nextLeft - viewportStart) >= 1) {
      animateScrollTo(container, nextLeft, shouldAnimate);
    }
  }, [animateScrollTo, itemValues, value]);

  const updateScrollEdges = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      setScrollEdges((current) => (
        current.left === false && current.right === false ? current : { left: false, right: false }
      ));
      return;
    }
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const nextEdges = {
      left: container.scrollLeft > 1,
      right: container.scrollLeft < maxLeft - 1,
    };
    setScrollEdges((current) => (
      current.left === nextEdges.left && current.right === nextEdges.right ? current : nextEdges
    ));
  }, []);

  const updateIndicator = useCallback(() => {
    const group = groupRef.current;
    const target = itemRefs.current.get(String(visualValue));
    const indicator = indicatorRef.current;
    if (!indicator) return;
    if (!group || !target) {
      indicator.style.opacity = '0';
      return;
    }

    const groupBounds = group.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const currentLeft = Number(indicator.dataset.left || '0');
    const nextLeft = targetBounds.left - groupBounds.left + group.scrollLeft;
    const distance = Math.abs(nextLeft - currentLeft);
    const previewDuration = Math.max(TAB_INDICATOR_MIN_DURATION_MS, Math.min(TAB_INDICATOR_MAX_DURATION_MS, Math.round(distance * 0.5)));
    const settledDuration = Math.max(TAB_INDICATOR_MIN_DURATION_MS, Math.min(TAB_INDICATOR_MAX_DURATION_MS, Math.round(distance * 0.62)));
    const shouldAnimate = animateIndicatorRef.current || previewValueRef.current !== null;
    const duration = previewValueRef.current !== null ? previewDuration : settledDuration;
    const easing = previewValueRef.current !== null ? motion.softOut : motion.standard;
    indicator.style.opacity = '1';
    indicator.style.transition = shouldAnimate
      ? transition(['transform', 'width', 'opacity', 'background-color', 'box-shadow'], duration, easing)
      : 'none';
    indicator.style.transform = `translateX(${nextLeft}px)`;
    indicator.style.width = `${targetBounds.width}px`;
    indicator.dataset.left = String(nextLeft);
    animateIndicatorRef.current = false;
  }, [visualValue]);

  useLayoutEffect(() => {
    updateScrollPosition();
    updateIndicator();
    updateScrollEdges();
  }, [itemValues, updateIndicator, updateScrollEdges, updateScrollPosition]);

  useEffect(() => stopScrollAnimation, [stopScrollAnimation]);

  useEffect(() => {
    if (previewValue !== null && previewValue === value) {
      const timer = window.setTimeout(() => setVisualPreview(null), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [previewValue, setVisualPreview, value]);

  useEffect(() => {
    const handleResize = () => {
      updateScrollPosition();
      updateIndicator();
      updateScrollEdges();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateIndicator, updateScrollEdges, updateScrollPosition]);

  useEffect(() => {
    const handleWindowBlur = () => {
      pointerRef.current = null;
      suppressClickRef.current = false;
      setVisualPreview(null);
    };
    window.addEventListener('blur', handleWindowBlur);
    return () => window.removeEventListener('blur', handleWindowBlur);
  }, [setVisualPreview]);

  const isHorizontallyScrollable = useCallback(() => {
    const container = scrollContainerRef.current;
    return Boolean(container && container.scrollWidth > container.clientWidth + 1);
  }, []);

  const resolveValueAtPoint = useCallback((clientX: number, clientY: number) => {
    const group = groupRef.current;
    if (!group) return null;
    const groupBounds = group.getBoundingClientRect();
    const xTolerance = latestPointerTypeRef.current === 'touch' ? TOUCH_POINTER_X_TOLERANCE_PX : POINTER_X_TOLERANCE_PX;
    if (clientX < groupBounds.left - xTolerance || clientX > groupBounds.right + xTolerance) {
      return null;
    }
    const yTolerance = latestPointerTypeRef.current === 'touch' ? TOUCH_POINTER_Y_TOLERANCE_PX : POINTER_Y_TOLERANCE_PX;
    if (clientY < groupBounds.top - yTolerance || clientY > groupBounds.bottom + yTolerance) {
      return null;
    }

    let closestValue: T | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const item of itemValues) {
      const node = itemRefs.current.get(String(item));
      if (!node) continue;
      const bounds = node.getBoundingClientRect();
      if (clientX >= bounds.left && clientX <= bounds.right) return item;
      const centerX = bounds.left + bounds.width / 2;
      const distance = Math.abs(clientX - centerX);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestValue = item;
      }
    }
    return closestValue;
  }, [itemValues]);

  const handlePointerDown = (itemValue: T, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    pointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pointerType: event.pointerType,
      allowDragPreview: event.pointerType !== 'touch' || !isHorizontallyScrollable(),
      scrollIntent: false,
    };
    latestPointerTypeRef.current = event.pointerType;
    suppressClickRef.current = true;
    markIndicatorAnimation();
    markScrollAnimation();
    setVisualPreview(itemValue);
    // A direct press changes immediately; equality in commitChange prevents duplicate work.
    commitChange(itemValue);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointer = pointerRef.current;
    if (!pointer) return;

    const deltaX = event.clientX - pointer.startX;
    const deltaY = event.clientY - pointer.startY;
    if (
      pointer.pointerType === 'touch'
      && !pointer.allowDragPreview
      && Math.abs(deltaX) > TOUCH_SCROLL_INTENT_PX
      && Math.abs(deltaX) > Math.abs(deltaY)
    ) {
      pointer.scrollIntent = true;
      setVisualPreview(null);
      if (event.currentTarget.hasPointerCapture(pointer.pointerId)) {
        event.currentTarget.releasePointerCapture(pointer.pointerId);
      }
      return;
    }
    if (pointer.scrollIntent || !pointer.allowDragPreview) return;

    const nextValue = resolveValueAtPoint(event.clientX, event.clientY);
    if (nextValue !== previewValueRef.current) markIndicatorAnimation();
    setVisualPreview(nextValue);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointer = pointerRef.current;
    if (!pointer) return;

    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(pointer.pointerId)) {
      event.currentTarget.releasePointerCapture(pointer.pointerId);
    }

    const targetValue = pointer.scrollIntent
      ? resolveValueAtPoint(event.clientX, event.clientY)
      : previewValueRef.current;
    if (targetValue === null) {
      setVisualPreview(null);
      return;
    }

    if (targetValue === value) {
      setVisualPreview(null);
      return;
    }

    setVisualPreview(targetValue);
    markIndicatorAnimation();
    markScrollAnimation();
    commitChange(targetValue);
  };

  const handleKeyDown = (itemValue: T, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = itemValues.findIndex((candidate) => candidate === itemValue);
    if (currentIndex < 0) return;

    const moveFocus = (nextIndex: number) => {
      const nextValue = itemValues[nextIndex];
      const nextNode = nextValue === undefined ? null : itemRefs.current.get(String(nextValue));
      nextNode?.focus();
      if (nextValue !== undefined) {
        markIndicatorAnimation();
        markScrollAnimation();
        setVisualPreview(nextValue);
      }
    };

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveFocus(Math.max(0, currentIndex - 1));
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveFocus(Math.min(itemValues.length - 1, currentIndex + 1));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      moveFocus(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      moveFocus(itemValues.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (itemValue !== value) {
        markIndicatorAnimation();
        markScrollAnimation();
        commitChange(itemValue);
      }
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    suppressClickRef.current = false;
    setVisualPreview(null);
    if (pointer && event.currentTarget.hasPointerCapture(pointer.pointerId)) {
      event.currentTarget.releasePointerCapture(pointer.pointerId);
    }
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    const handleScroll = () => updateScrollEdges();
    const handleWheel = (event: WheelEvent) => {
      if (container.scrollWidth <= container.clientWidth + 1) return;
      const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (Math.abs(delta) < 1) return;

      const maxLeft = container.scrollWidth - container.clientWidth;
      const nextLeft = Math.max(0, Math.min(maxLeft, container.scrollLeft + delta));
      stopScrollAnimation();
      event.preventDefault();
      container.scrollLeft = nextLeft;
      updateScrollEdges();
    };

    updateScrollEdges();
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
    };
  }, [stopScrollAnimation, updateScrollEdges]);

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'inline-flex',
        maxWidth: '100%',
        '&::before, &::after': {
          content: '""',
          position: 'absolute',
          top: 1,
          bottom: 1,
          width: TAB_EDGE_FADE_WIDTH_PX,
          zIndex: 3,
          pointerEvents: 'none',
          opacity: 0,
          transition: transition(['opacity'], motion.durations.base, motion.softOut),
        },
        '&::before': {
          left: 1,
          borderTopLeftRadius: { xs: '14px', sm: '15px' },
          borderBottomLeftRadius: { xs: '14px', sm: '15px' },
          opacity: scrollEdges.left ? 1 : 0,
          background: (theme) => `linear-gradient(90deg, ${theme.palette.mode === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(16,18,26,0.92)'}, transparent)`,
        },
        '&::after': {
          right: 1,
          borderTopRightRadius: { xs: '14px', sm: '15px' },
          borderBottomRightRadius: { xs: '14px', sm: '15px' },
          opacity: scrollEdges.right ? 1 : 0,
          background: (theme) => `linear-gradient(270deg, ${theme.palette.mode === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(16,18,26,0.92)'}, transparent)`,
        },
        ...reducedMotionSx,
      }}
    >
      <Box ref={scrollContainerRef} sx={buildFloatingTabGroupSx()}>
        <Box
          ref={groupRef}
          sx={{
            position: 'relative',
            display: 'flex',
            gap: comfortable ? { xs: 0.25, sm: 0.4 } : { xs: 0.25, sm: 0.35 },
            minWidth: 0,
          }}
        >
          <Box
            aria-hidden
            ref={indicatorRef}
            sx={{
              position: 'absolute',
              zIndex: 0,
              top: 0,
              bottom: 0,
              left: 0,
              width: 0,
              opacity: 0,
              transform: 'translateX(0)',
              borderRadius: { xs: '10px', sm: '11px' },
              pointerEvents: 'none',
              bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.12)' : 'rgba(120,156,220,0.18)',
              boxShadow: (theme) => theme.palette.mode === 'light'
                ? '0 8px 18px rgba(49,90,156,0.12), 0 1px 0 rgba(255,255,255,0.72) inset'
                : '0 10px 22px rgba(0,0,0,0.24), 0 1px 0 rgba(255,255,255,0.06) inset',
              transition: transition(['transform', 'width', 'opacity', 'background-color', 'box-shadow'], motion.durations.navTrack, motion.softOut),
              willChange: 'transform, width',
              '@media (prefers-reduced-motion: reduce)': {
                transition: transition(['transform', 'width', 'opacity'], motion.durations.fast, motion.softOut),
              },
            }}
          />
          {items.map((item) => {
            const selected = item.value === visualValue;
            return (
              <ButtonBase
                key={String(item.value)}
                disableRipple
                ref={(node) => {
                  const key = String(item.value);
                  if (node) itemRefs.current.set(key, node);
                  else itemRefs.current.delete(key);
                }}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  markIndicatorAnimation();
                  markScrollAnimation();
                  commitChange(item.value);
                }}
                onPointerDown={(event) => handlePointerDown(item.value, event)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onKeyDown={(event) => handleKeyDown(item.value, event)}
                onBlur={() => {
                  if (!pointerRef.current) setVisualPreview(null);
                }}
                aria-pressed={item.value === value}
                sx={{
                  position: 'relative',
                  zIndex: 1,
                  minHeight: { xs: 36, sm: 38 },
                  minWidth: equalWidth
                    ? comfortable ? { xs: 58, sm: 74, md: 88 } : { xs: 58, sm: 68 }
                    : 'max-content',
                  flex: equalWidth ? '1 1 auto' : '0 1 auto',
                  px: comfortable ? { xs: 1.2, sm: 1.8, md: 2.2 } : { xs: 1.35, sm: 1.75 },
                  borderRadius: { xs: '10px', sm: '11px' },
                  color: selected ? 'primary.main' : 'text.secondary',
                  bgcolor: 'transparent',
                  boxShadow: 'none',
                  touchAction: 'pan-x pan-y',
                  fontWeight: 760,
                  fontSize: { xs: '0.8rem', sm: '0.875rem' },
                  whiteSpace: 'nowrap',
                  opacity: selected ? 1 : 0.78,
                  overflow: 'hidden',
                  outline: '1px solid transparent',
                  transition: transition(['background-color', 'color', 'opacity', 'box-shadow', 'outline-color', 'transform'], motion.durations.base, motion.softOut),
                  '&::before': {
                    content: '""',
                    position: 'absolute',
                    inset: 0,
                    zIndex: 0,
                    borderRadius: 'inherit',
                    bgcolor: tabFeedbackBg,
                    opacity: selected ? 1 : 0,
                    pointerEvents: 'none',
                    transition: transition(['opacity', 'background-color'], motion.durations.base, motion.softOut),
                  },
                  '@media (hover: hover) and (pointer: fine)': {
                    '&:hover': {
                      opacity: 1,
                      outlineColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.045)' : 'rgba(226,232,240,0.06)',
                    },
                    '&:hover::before': {
                      opacity: 1,
                    },
                  },
                  '&:active': {
                    transform: 'scale(0.986)',
                    transitionTimingFunction: motion.navDrag,
                    transitionDuration: `${motion.durations.fast}ms`,
                  },
                  '&:active::before': {
                    opacity: 1,
                    bgcolor: tabPressedBg,
                    transitionDuration: `${motion.durations.fast}ms`,
                  },
                  '&:focus-visible': {
                    outlineColor: 'primary.main',
                    boxShadow: (theme) => theme.palette.mode === 'light'
                      ? '0 0 0 3px rgba(49,90,156,0.13)'
                      : '0 0 0 3px rgba(120,156,220,0.18)',
                  },
                  ...reducedMotionSx,
                }}
              >
                <Box component="span" sx={{ position: 'relative', zIndex: 1, display: 'block', minWidth: 0, whiteSpace: 'nowrap' }}>
                  {item.label}
                </Box>
              </ButtonBase>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
