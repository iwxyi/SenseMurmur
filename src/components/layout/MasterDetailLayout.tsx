import { Box } from '@mui/material';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMediaQuery } from '@mui/material';
import { storageKey } from '../../constants/brand';
import { PaneLayoutProvider } from './PaneLayoutContext';
import { LayoutHeaderActionsContext } from './AppLayoutContext';
import GlassHeader, { GLASS_HEADER_HEIGHT } from './GlassHeader';
import { useAutoHideHeader } from '../../hooks/useAutoHideHeader';
import { useDetailCollapsedState, writeDetailCollapsedState } from './masterDetailState';
import PaneResizeDivider, { PANE_RESIZE_DIVIDER_LAYOUT_WIDTH } from './PaneResizeDivider';
import { CONTENT_SCROLL_TO_TOP_EVENT, type ContentScrollToTopDetail } from '../../services/contentScrollRegion';
import { motion } from '../../styles/motion';
import { useLocation } from 'react-router-dom';
import { getMasterDetailSection } from '../../routes/masterDetailRoutes';

const MIN_MASTER_WIDTH = 320;
const DEFAULT_MASTER_WIDTH = 430;
const MAX_MASTER_WIDTH = 720;
const MIN_DETAIL_WIDTH = 240;
const DIVIDER_LAYOUT_WIDTH = PANE_RESIZE_DIVIDER_LAYOUT_WIDTH;
const MASTER_WIDTH_STORAGE_KEY = storageKey('master-detail-master-width');
const paneScrollPositions = new Map<string, number>();

export function clearPaneScrollPositions() {
  paneScrollPositions.clear();
}

function paneScrollKey(role: 'master' | 'detail', pathname: string) {
  if (role === 'detail') return `${role}:${pathname}`;
  const owner = getMasterDetailSection(pathname);
  const section = owner ? `/${owner}` : pathname;
  return `${role}:${section}`;
}

function clampMasterWidth(value: number, containerWidth?: number | null) {
  if (!Number.isFinite(value)) return DEFAULT_MASTER_WIDTH;
  const baseWidth = containerWidth || (typeof window === 'undefined' ? 0 : window.innerWidth);
  const detailAwareMax = baseWidth > 0 ? Math.max(MIN_MASTER_WIDTH, baseWidth - DIVIDER_LAYOUT_WIDTH - MIN_DETAIL_WIDTH) : MAX_MASTER_WIDTH;
  const viewportMax = typeof window === 'undefined'
    ? MAX_MASTER_WIDTH
    : Math.max(MIN_MASTER_WIDTH, Math.min(MAX_MASTER_WIDTH, detailAwareMax));
  return Math.min(viewportMax, Math.max(MIN_MASTER_WIDTH, Math.round(value)));
}

function getInitialMasterWidth() {
  if (typeof localStorage === 'undefined') return DEFAULT_MASTER_WIDTH;
  const stored = Number(localStorage.getItem(MASTER_WIDTH_STORAGE_KEY));
  return clampMasterWidth(stored || DEFAULT_MASTER_WIDTH);
}

function PaneShell({ role, title, children }: { role: 'master' | 'detail'; title: ReactNode | null; children: ReactNode }) {
  const location = useLocation();
  const [headerTitle, setHeaderTitleState] = useState<ReactNode | null>(null);
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const suppressHeaderScrollRef = useRef(false);
  const releaseHeaderScrollFrameRef = useRef<number | null>(null);
  const restoringScrollRef = useRef(false);
  const resolvedTitle = headerTitle ?? title;
  const showHeader = resolvedTitle != null || headerActions != null;
  const autoHide = useAutoHideHeader(!showHeader);
  const { syncScrollTop } = autoHide;
  const topInset = showHeader && !autoHide.hidden ? GLASS_HEADER_HEIGHT : 0;
  const scrollKey = paneScrollKey(role, location.pathname);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    const storedTop = paneScrollPositions.get(scrollKey);
    if (storedTop == null) return undefined;
    restoringScrollRef.current = true;
    let settled = false;
    const restore = () => {
      if (settled) return;
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      // Async list data may not have laid out yet. Keep retrying while the
      // container grows, then stop as soon as the saved position is reachable.
      const nextTop = Math.min(storedTop, maxTop);
      container.scrollTop = nextTop;
      syncScrollTop(nextTop);
      if (maxTop >= storedTop || storedTop === 0) {
        settled = true;
        restoringScrollRef.current = false;
      }
    };
    restore();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore);
    observer?.observe(container);
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(restore);
    mutationObserver?.observe(container, { childList: true, subtree: true });
    const frame = window.requestAnimationFrame(restore);
    const retryInterval = window.setInterval(restore, 100);
    const timer = window.setTimeout(() => {
      restore();
      observer?.disconnect();
      mutationObserver?.disconnect();
      window.clearInterval(retryInterval);
      restoringScrollRef.current = false;
    }, 1200);
    return () => {
      settled = true;
      observer?.disconnect();
      mutationObserver?.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearInterval(retryInterval);
      window.clearTimeout(timer);
      restoringScrollRef.current = false;
    };
  }, [scrollKey, syncScrollTop]);

  const contextValue = useMemo(() => ({
    setHeaderActions,
    setHeaderTitle: (nextTitle: ReactNode | null) => setHeaderTitleState(nextTitle),
    setHeaderBackAction: () => undefined,
    setHideMobileBottomNav: () => undefined,
  }), []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    const handleScrollToTop = (event: Event) => {
      const detail = (event as CustomEvent<ContentScrollToTopDetail>).detail;
      const preserveHeader = detail?.preserveHeader === true;
      if (!preserveHeader) {
        container.scrollTop = 0;
        autoHide.reset();
        return;
      }

      if (releaseHeaderScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(releaseHeaderScrollFrameRef.current);
      }
      suppressHeaderScrollRef.current = true;
      autoHide.syncScrollTop(0);
      container.scrollTop = 0;
      releaseHeaderScrollFrameRef.current = window.requestAnimationFrame(() => {
        suppressHeaderScrollRef.current = false;
        releaseHeaderScrollFrameRef.current = null;
      });
    };

    container.addEventListener(CONTENT_SCROLL_TO_TOP_EVENT, handleScrollToTop);
    return () => {
      container.removeEventListener(CONTENT_SCROLL_TO_TOP_EVENT, handleScrollToTop);
      if (releaseHeaderScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(releaseHeaderScrollFrameRef.current);
        releaseHeaderScrollFrameRef.current = null;
      }
    };
  }, [autoHide]);

  return (
    <LayoutHeaderActionsContext.Provider value={contextValue}>
      <PaneLayoutProvider role={role}>
        <Box
          sx={{
            height: '100%',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            overflow: 'hidden',
            '--app-floating-tab-top': '10px',
          }}
        >
          {showHeader ? (
            <GlassHeader title={resolvedTitle} actions={headerActions} hidden={autoHide.hidden} overlay zIndex={1} />
          ) : null}
          <Box
            ref={scrollContainerRef}
            data-pneumata-scroll-region={`pane-${role}`}
            onScroll={(event) => {
              const { currentTarget } = event;
              if (!restoringScrollRef.current) {
                paneScrollPositions.set(scrollKey, currentTarget.scrollTop);
              }
              if (suppressHeaderScrollRef.current) {
                autoHide.syncScrollTop(currentTarget.scrollTop);
                return;
              }
              autoHide.handleScrollTop(currentTarget.scrollTop, {
                scrollHeight: currentTarget.scrollHeight,
                clientHeight: currentTarget.clientHeight,
              });
            }}
            sx={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              scrollbarGutter: 'stable',
              pt: `${topInset}px`,
              transition: 'padding-top 260ms cubic-bezier(0.2, 0, 0, 1)',
            }}
          >
            {children}
          </Box>
        </Box>
      </PaneLayoutProvider>
    </LayoutHeaderActionsContext.Provider>
  );
}

export default function MasterDetailLayout({
  master,
  detail,
  masterTitle,
  detailTitle,
  fallback = 'detail',
}: {
  master: ReactNode;
  detail: ReactNode;
  masterTitle: ReactNode;
  detailTitle: ReactNode | null;
  fallback?: 'master' | 'detail';
}) {
  const isThreeColumn = useMediaQuery('(min-width:1280px)');
  const isPhone = useMediaQuery('(max-width:599px)');
  const [masterWidth, setMasterWidth] = useState(getInitialMasterWidth);
  const detailCollapsed = useDetailCollapsedState();
  const [resizing, setResizing] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number; containerWidth: number } | null>(null);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const updateWidth = () => setContainerWidth(Math.round(element.getBoundingClientRect().width));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const finishResize = useCallback(() => {
    resizeRef.current = null;
    setResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleResizeMove = useCallback((event: PointerEvent) => {
    const state = resizeRef.current;
    if (!state) return;
    const availableWidth = Math.max(MIN_MASTER_WIDTH, state.containerWidth - DIVIDER_LAYOUT_WIDTH);
    const rawWidth = Math.max(MIN_MASTER_WIDTH, Math.min(availableWidth, state.startWidth + event.clientX - state.startX));
    const nextDetailWidth = availableWidth - rawWidth;
    if (nextDetailWidth < MIN_DETAIL_WIDTH) {
      writeDetailCollapsedState(true);
      return;
    }
    const nextWidth = clampMasterWidth(rawWidth, state.containerWidth);
    setMasterWidth(nextWidth);
    localStorage.setItem(MASTER_WIDTH_STORAGE_KEY, String(nextWidth));
    writeDetailCollapsedState(false);
  }, []);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const width = containerWidth || rootRef.current?.getBoundingClientRect().width || window.innerWidth;
    const startWidth = detailCollapsed ? Math.max(MIN_MASTER_WIDTH, width - DIVIDER_LAYOUT_WIDTH) : masterWidth;
    resizeRef.current = { startX: event.clientX, startWidth, containerWidth: width };
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleResizeMove);
    window.addEventListener('pointerup', () => {
      finishResize();
      window.removeEventListener('pointermove', handleResizeMove);
    }, { once: true });
  }, [containerWidth, detailCollapsed, finishResize, handleResizeMove, masterWidth]);

  const openDefaultDetail = useCallback(() => {
    const width = containerWidth || rootRef.current?.getBoundingClientRect().width || window.innerWidth;
    const nextWidth = clampMasterWidth(DEFAULT_MASTER_WIDTH, width);
    setMasterWidth(nextWidth);
    localStorage.setItem(MASTER_WIDTH_STORAGE_KEY, String(nextWidth));
    writeDetailCollapsedState(false);
  }, [containerWidth]);

  useEffect(() => () => finishResize(), [finishResize]);

  if (!isThreeColumn) {
    const showingDetail = fallback !== 'master' && detail != null;
    return (
      <Box
        sx={{
          width: '100%',
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
          // Chat content is absolutely positioned and needs a definite flex viewport.
          ...(showingDetail ? {
            flex: 1,
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
          } : isPhone ? { height: '100%' } : {}),
          ...(isPhone ? {
            animation: `${showingDetail ? 'masterDetailPhoneIn' : 'masterDetailPhoneBack'} ${showingDetail ? motion.durations.slow : motion.durations.base}ms ${showingDetail ? motion.emphasized : motion.standard}`,
            '@keyframes masterDetailPhoneIn': {
              from: { opacity: 0.72 },
              to: { opacity: 1 },
            },
            '@keyframes masterDetailPhoneBack': {
              from: { opacity: 0.84 },
              to: { opacity: 1 },
            },
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          } : {}),
        }}
      >
        {showingDetail ? detail : master}
      </Box>
    );
  }

  const divider = (
    <PaneResizeDivider
      resizing={resizing}
      ariaLabel={detailCollapsed ? '拖动展开右侧列' : '拖动调整列宽'}
      onPointerDown={startResize}
      onDoubleClick={openDefaultDetail}
    />
  );

  return (
    <Box
      ref={rootRef}
      sx={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        display: 'flex',
        overflow: detailCollapsed ? 'visible' : 'hidden',
        bgcolor: 'background.default',
      }}
    >
      <Box
        sx={{
          width: detailCollapsed ? 'auto' : masterWidth,
          flex: detailCollapsed ? '1 1 auto' : `0 0 ${masterWidth}px`,
          minWidth: MIN_MASTER_WIDTH,
          maxWidth: detailCollapsed ? 'none' : MAX_MASTER_WIDTH,
          minHeight: 0,
          height: '100%',
          overflow: detailCollapsed ? 'visible' : 'auto',
          scrollbarGutter: 'stable',
          bgcolor: detailCollapsed
            ? 'background.default'
            : (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.025)',
        }}
      >
        {detailCollapsed
          ? (fallback === 'master' ? master : detail)
          : <PaneShell role="master" title={masterTitle}>{master}</PaneShell>}
      </Box>
      {divider}
      {!detailCollapsed ? (
        <Box sx={{ flex: 1, minWidth: MIN_DETAIL_WIDTH, minHeight: 0, overflow: 'hidden' }}>
          <PaneShell role="detail" title={detailTitle}>{detail}</PaneShell>
        </Box>
      ) : null}
    </Box>
  );
}
