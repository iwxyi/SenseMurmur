import React, { type ReactNode } from 'react';
import {
  Box,
  Drawer,
  SwipeableDrawer,
  IconButton,
  useMediaQuery,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useResponsive } from '../../hooks/useResponsive';
import { useUIStore } from '../../stores/useUIStore';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';
import { LayoutHeaderActionsContext } from './AppLayoutContext';
import GlassHeader, { GLASS_HEADER_HEIGHT } from './GlassHeader';
import { useAutoHideHeader } from '../../hooks/useAutoHideHeader';
import { useDetailCollapsedState } from './masterDetailState';
import { getMasterDetailSection } from '../../routes/masterDetailRoutes';
import { motion } from '../../styles/motion';
import AppSnackbar from '../common/AppSnackbar';
import { APP_DIAGNOSTIC_TOAST_EVENT, type DiagnosticToastDetail } from '../../services/diagnostics';
import { CONTENT_SCROLL_TO_TOP_EVENT, type ContentScrollToTopDetail } from '../../services/contentScrollRegion';
import { useApplicationSocialFlow } from '../../hooks/useApplicationSocialFlow';
import { usePrivateSocialIntentFlow } from '../../hooks/usePrivateSocialIntentFlow';
import { useChatStore } from '../../stores/useChatStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { getLocalDataUserId } from '../../services/authStorageScope';

const routeMeta = [
  { match: (pathname: string) => pathname === '/', titleKey: 'nav.home' },
  { match: (pathname: string) => pathname === '/chats' || pathname.startsWith('/chats/'), titleKey: 'nav.chats' },
  { match: (pathname: string) => pathname === '/characters/create', titleKey: 'character.create' },
  { match: (pathname: string) => /^\/characters\/[^/]+\/edit$/.test(pathname), titleKey: 'character.edit' },
  { match: (pathname: string) => pathname.startsWith('/characters'), titleKey: 'nav.characters' },
  { match: (pathname: string) => pathname.startsWith('/moments'), titleKey: 'nav.moments' },
  { match: (pathname: string) => pathname.startsWith('/market'), titleKey: 'nav.market' },
  { match: (pathname: string) => pathname.startsWith('/calendar'), titleKey: 'nav.calendar' },
  { match: (pathname: string) => pathname.startsWith('/letters'), titleKey: 'nav.letters' },
  { match: (pathname: string) => pathname.startsWith('/intro'), titleKey: 'nav.intro' },
  { match: (pathname: string) => pathname.startsWith('/ai-models'), titleKey: 'nav.models' },
  { match: (pathname: string) => pathname.startsWith('/ai-proxy'), titleKey: 'nav.aiProxy' },
  { match: (pathname: string) => pathname.startsWith('/membership'), titleKey: 'nav.membership' },
  { match: (pathname: string) => pathname.startsWith('/account'), titleKey: 'nav.account' },
  { match: (pathname: string) => pathname.startsWith('/settings'), titleKey: 'nav.settings' },
];

function getRouteMeta(pathname: string) {
  return routeMeta.find((item) => item.match(pathname)) ?? routeMeta[0];
}

const SIDEBAR_WIDTH = 280;
const SIDEBAR_COLLAPSED_WIDTH = 72;

export default function AppLayout({ children }: { children?: ReactNode }) {
  useApplicationSocialFlow();
  usePrivateSocialIntentFlow();
  const artifactChats = useChatStore((state) => state.chats);
  const artifactCharacters = useCharacterStore((state) => state.characters);
  const artifactProfiles = useSettingsStore((state) => state.aiProfiles);
  const [artifactCalendarDay, setArtifactCalendarDay] = React.useState(() => new Date().toDateString());
  React.useEffect(() => {
    const checkDay = () => setArtifactCalendarDay(new Date().toDateString());
    const timer = setInterval(checkDay, 60_000);
    document.addEventListener('visibilitychange', checkDay);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', checkDay);
    };
  }, []);
  React.useEffect(() => {
    const accountId = getLocalDataUserId();
    const timer = setTimeout(() => {
      void import('../../stores/useCharacterArtifactStore').then(async ({ ensureCharacterArtifactStoreHydrated, useCharacterArtifactStore }) => {
        await ensureCharacterArtifactStoreHydrated();
        if (getLocalDataUserId() !== accountId) return;
        useCharacterArtifactStore.getState().syncCharacters(useCharacterStore.getState().characters);
      }).catch((error) => console.error('[character-artifact] scheduling failed', error));
    }, 6000);
    return () => clearTimeout(timer);
  }, [artifactChats, artifactCharacters, artifactProfiles, artifactCalendarDay]);
  const { t } = useTranslation();
  const location = useLocation();
  const { isMobile, isTablet, isDesktop } = useResponsive();
  const isThreeColumn = useMediaQuery('(min-width:1280px)');
  const detailCollapsed = useDetailCollapsedState();
  const { sidebarOpen, setSidebarOpen } = useUIStore(useShallow((state) => ({
    sidebarOpen: state.sidebarOpen,
    setSidebarOpen: state.setSidebarOpen,
  })));
  const shouldShowMenuButton = isMobile || isTablet;
  const currentRoute = getRouteMeta(location.pathname);
  const settingsTab = location.pathname === '/settings' ? new URLSearchParams(location.search).get('tab') : null;
  const currentTitle = t(settingsTab === 'models' ? 'nav.models' : currentRoute.titleKey);
  const [headerActions, setHeaderActions] = React.useState<ReactNode>(null);
  const [headerTitle, setHeaderTitle] = React.useState<ReactNode | null>(null);
  const [headerBackAction, setHeaderBackAction] = React.useState<(() => void) | null>(null);
  const [hideMobileBottomNav, setHideMobileBottomNav] = React.useState(false);
  const [diagnosticToast, setDiagnosticToast] = React.useState<{ open: boolean; message: ReactNode; severity: DiagnosticToastDetail['severity'] }>({
    open: false,
    message: '',
    severity: 'error',
  });
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const savedScrollTopRef = React.useRef(0);
  const scrollPositionsRef = React.useRef(new Map<string, number>());
  const restoringScrollRef = React.useRef(false);
  const suppressHeaderScrollRef = React.useRef(false);
  const releaseHeaderScrollFrameRef = React.useRef<number | null>(null);
  const effectiveHeaderTitle = headerTitle ?? currentTitle;
  const scrollKey = `${location.pathname}${location.search}`;
  const mainPaddingBottom = 0;
  const isChatDetailRoute = /^\/chats\/[^/]+$/.test(location.pathname) && location.pathname !== '/chats/create';
  const isIntroRoute = location.pathname.startsWith('/intro');
  const supportsMasterDetail = getMasterDetailSection(location.pathname) !== null;
  const isMasterDetailRoute = supportsMasterDetail && isThreeColumn && !detailCollapsed;
  const hasInternalScroll = isChatDetailRoute || isMasterDetailRoute || location.pathname === '/account/sync-status';
  const showMobileTopBar = shouldShowMenuButton && !isMasterDetailRoute && !isChatDetailRoute;
  const showDesktopTopBar = !shouldShowMenuButton && !isMasterDetailRoute && !isChatDetailRoute;
  const headerOffset = isChatDetailRoute && !isMasterDetailRoute
    ? 0
    : showMobileTopBar
      ? `calc(${GLASS_HEADER_HEIGHT}px + env(safe-area-inset-top, 0px))`
      : showDesktopTopBar ? 49 : 0;
  const {
    hidden: headerHidden,
    reset: resetHeaderHidden,
    syncScrollTop: syncHeaderScrollTop,
    handleScrollTop: handleHeaderScrollTop,
  } = useAutoHideHeader(isChatDetailRoute || isMasterDetailRoute || sidebarOpen);
  const effectiveHeaderHidden = headerHidden;
  const floatingTabTopOffset = effectiveHeaderHidden
    ? 10
    : (showMobileTopBar || showDesktopTopBar) ? GLASS_HEADER_HEIGHT + 12 : 10;
  const handleHeaderLeadingAction = () => {
    if (headerBackAction) {
      headerBackAction();
      return;
    }
    setSidebarOpen(true);
  };

  React.useEffect(() => {
    const handleDiagnosticToast = (event: Event) => {
      const detail = (event as CustomEvent<DiagnosticToastDetail>).detail;
      if (!detail?.message) return;
      setDiagnosticToast({
        open: true,
        message: detail.message,
        severity: detail.severity || 'error',
      });
    };
    window.addEventListener(APP_DIAGNOSTIC_TOAST_EVENT, handleDiagnosticToast);
    return () => window.removeEventListener(APP_DIAGNOSTIC_TOAST_EVENT, handleDiagnosticToast);
  }, []);

  React.useEffect(() => {
    resetHeaderHidden();
  }, [location.pathname, resetHeaderHidden]);

  React.useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    const scrollPositions = scrollPositionsRef.current;
    const savedTop = scrollPositions.get(scrollKey) || 0;
    savedScrollTopRef.current = savedTop;
    restoringScrollRef.current = savedTop > 0;
    let observer: ResizeObserver | null = null;
    const restore = () => {
      if (!restoringScrollRef.current) return;
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.min(savedTop, maxTop);
      syncHeaderScrollTop(container.scrollTop);
      if (maxTop >= savedTop) {
        restoringScrollRef.current = false;
        observer?.disconnect();
      }
    };
    if (savedTop > 0 && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(restore);
      observer.observe(container);
      const content = container.lastElementChild;
      if (content) observer.observe(content);
    }
    restore();
    const frame = savedTop > 0 ? window.requestAnimationFrame(restore) : null;
    return () => {
      scrollPositions.set(scrollKey, savedScrollTopRef.current);
      restoringScrollRef.current = false;
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [scrollKey, syncHeaderScrollTop]);

  React.useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    const handleScrollToTop = (event: Event) => {
      const detail = (event as CustomEvent<ContentScrollToTopDetail>).detail;
      const preserveHeader = detail?.preserveHeader === true;
      if (!preserveHeader) {
        container.scrollTop = 0;
        resetHeaderHidden();
        return;
      }

      if (releaseHeaderScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(releaseHeaderScrollFrameRef.current);
      }
      suppressHeaderScrollRef.current = true;
      syncHeaderScrollTop(0);
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
  }, [resetHeaderHidden, syncHeaderScrollTop]);

  const handleMainScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const { currentTarget } = event;
    if (!restoringScrollRef.current && currentTarget.getClientRects().length > 0) {
      savedScrollTopRef.current = currentTarget.scrollTop;
    }
    if (suppressHeaderScrollRef.current) {
      syncHeaderScrollTop(currentTarget.scrollTop);
      return;
    }
    handleHeaderScrollTop(currentTarget.scrollTop, {
      scrollHeight: currentTarget.scrollHeight,
      clientHeight: currentTarget.clientHeight,
    });
  };

  const mobileHeader = (
    <GlassHeader
      title={effectiveHeaderTitle}
      hidden={effectiveHeaderHidden}
      safeAreaTop
      zIndex={sidebarOpen ? 1099 : 1199}
      tone={isIntroRoute ? 'intro' : 'default'}
      leading={
        <IconButton
          onClick={handleHeaderLeadingAction}
          sx={{
            borderRadius: 3,
            flex: '0 0 auto',
            color: isIntroRoute ? 'rgba(255,244,228,0.86)' : 'text.primary',
          }}
        >
          {headerBackAction ? <ArrowBackIcon /> : <MenuIcon />}
        </IconButton>
      }
      actions={headerActions}
    />
  );

  const desktopHeader = (
    <GlassHeader
      title={effectiveHeaderTitle}
      hidden={effectiveHeaderHidden}
      tone={isIntroRoute ? 'intro' : 'default'}
      leading={headerBackAction ? (
          <IconButton
            onClick={headerBackAction}
            sx={{
              borderRadius: 3,
              flex: '0 0 auto',
              color: isIntroRoute ? 'rgba(255,244,228,0.86)' : 'text.primary',
            }}
          >
            <ArrowBackIcon />
          </IconButton>
        ) : null}
      actions={headerActions}
    />
  );

  return (
    <LayoutHeaderActionsContext.Provider value={{ setHeaderActions, setHeaderTitle, setHeaderBackAction, setHideMobileBottomNav }}>
    <Box sx={{ display: 'flex', height: '100dvh', minHeight: '100dvh', overflow: 'hidden' }}>
        {isDesktop && (
          <Box
            sx={{
              width: sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH,
              flexShrink: 0,
              transition: `width 320ms ${motion.emphasized}`,
            }}
          >
            <Sidebar collapsed={!sidebarOpen} />
          </Box>
        )}

        {isTablet && (
          <Drawer
            variant="temporary"
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            sx={{
              '& .MuiDrawer-paper': {
                width: SIDEBAR_WIDTH,
                borderRadius: 0,
              },
            }}
          >
            <Sidebar collapsed={false} />
          </Drawer>
        )}

        {isMobile && (
          <SwipeableDrawer
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onOpen={() => setSidebarOpen(true)}
            sx={{
              '& .MuiDrawer-paper': {
                width: SIDEBAR_WIDTH,
                borderRadius: 0,
              },
            }}
          >
            <Sidebar collapsed={false} />
          </SwipeableDrawer>
        )}

        <Box
          component="main"
          sx={{
            flexGrow: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            height: '100dvh',
            pb: mainPaddingBottom,
            position: 'relative',
            overflow: 'hidden',
            bgcolor: isIntroRoute ? '#0A0A0F' : 'background.default',
            backgroundImage: 'none',
          }}
        >
          {showMobileTopBar ? mobileHeader : null}
          {showDesktopTopBar ? desktopHeader : null}

          <Box
            ref={scrollContainerRef}
            data-pneumata-scroll-region="main"
            onScroll={handleMainScroll}
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: hasInternalScroll ? 'hidden' : 'auto',
              scrollbarGutter: hasInternalScroll ? 'auto' : 'stable',
              '--app-floating-tab-top': `${floatingTabTopOffset}px`,
            }}
          >
            {headerOffset ? <Box aria-hidden sx={{ height: headerOffset, flexShrink: 0, pointerEvents: 'none' }} /> : null}
            <Box
              sx={hasInternalScroll
                ? { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }
                : { flex: '0 0 auto' }}
            >
              {children ?? <Outlet />}
            </Box>
          </Box>

          {isMobile && !hideMobileBottomNav ? (
            <BottomNav compact={effectiveHeaderHidden} />
          ) : null}
          <AppSnackbar
            open={diagnosticToast.open}
            message={diagnosticToast.message}
            severity={diagnosticToast.severity}
            onClose={() => setDiagnosticToast((prev) => ({ ...prev, open: false }))}
            offset={isChatDetailRoute ? 'composer' : isMobile && !hideMobileBottomNav ? 'navigation' : 'none'}
          />
        </Box>
      </Box>
    </LayoutHeaderActionsContext.Provider>
  );
}
