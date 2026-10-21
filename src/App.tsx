import { lazy, Suspense, useMemo, useEffect, useRef, useState } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, ThemeProvider, CssBaseline, Typography, useMediaQuery } from '@mui/material';
import { createAppTheme } from './theme';
import { useSettingsStore } from './stores/useSettingsStore';
import { useAuthStore } from './stores/useAuthStore';
import { readAuthSnapshot } from './services/authSnapshot';
import { isWorkspaceActive } from './services/workspaceLifecycle';
import AppLayout from './components/layout/AppLayout';
import MasterDetailLayout from './components/layout/MasterDetailLayout';
import AdminPermissionGate from './components/admin/AdminPermissionGate';
import { useAdminAuthStore } from './stores/useAdminAuthStore';
import { ADMIN_DASHBOARD_PERMISSIONS, ADMIN_PERMISSION_CODES } from './constants/adminPermissions';
import { ADMIN_LOGIN_EVENT } from './services/adminApi';
import { api, type SystemAnnouncementItem } from './services/api';
import { AUTH_SESSION_EXPIRED_EVENT, type AuthSessionExpiredDetail } from './services/authSession';
import { APP_DESCRIPTION, APP_TITLE } from './constants/brand';
import { buildSettingsPath } from './routes/settingsRoute';
import DevUpdatePrompt from './components/common/DevUpdatePrompt';
import PwaUpdatePrompt from './components/common/PwaUpdatePrompt';
import {
  hasPendingGuestImportForUser,
  importGuestDataToCurrentAccount,
  markGuestImportSnapshotDismissed,
  readGuestImportSnapshot,
  type GuestImportSnapshot,
} from './services/guestDataImport';
import { isCloudSyncEnabled } from './services/cloudSyncPreference';
import { useChatStore } from './stores/useChatStore';
import { useCharacterStore } from './stores/useCharacterStore';
import {
  formatInAppNotificationWindow,
  readSeenInAppNotificationIds,
  readSessionReportedInAppNotificationExposureIds,
  useInAppNotificationStore,
  writeSeenInAppNotificationIds,
  writeSessionReportedInAppNotificationExposureIds,
} from './services/inAppNotifications';
import { AppUsageSessionClient, currentUsagePath, getAppUsageAnonymousId } from './services/appUsageSession';
import './i18n';

const routePreloaders = [
  () => import('./pages/HomePage'),
  () => import('./pages/ChatListPage'),
  () => import('./pages/CreateChatPage'),
  () => import('./pages/ChatDetailPage'),
  () => import('./pages/CreateDirectChatPage'),
  () => import('./pages/CharacterLibraryPage'),
  () => import('./pages/CharacterEditorPage'),
  () => import('./pages/SettingsPage'),
  () => import('./pages/RecycleBinPage'),
  () => import('./pages/AIProxyPage'),
  () => import('./pages/MembershipPage'),
  () => import('./pages/AccountPage'),
  () => import('./pages/SyncStatusPage'),
  () => import('./pages/BatchGenerateCharactersPage'),
  () => import('./pages/LettersPage'),
  () => import('./pages/CalendarPage'),
  () => import('./pages/MomentsPage'),
  () => import('./pages/MarketPage'),
  () => import('./pages/FilesPage'),
  () => import('./pages/IntroPage'),
  () => import('./pages/LoginPage'),
  () => import('./pages/PublicSharedChatPage'),
  () => import('./components/admin/AdminLayout'),
  () => import('./pages/admin/AdminLoginPage'),
  () => import('./pages/admin/AdminDashboardPage'),
  () => import('./pages/admin/AdminUsersPage'),
  () => import('./pages/admin/AdminAdminsPage'),
  () => import('./pages/admin/AdminGlobalConfigPage'),
  () => import('./pages/admin/AdminAIProviderPage'),
  () => import('./pages/admin/AdminPlatformPage'),
  () => import('./pages/admin/AdminBillingPage'),
  () => import('./pages/admin/AdminModerationPage'),
  () => import('./pages/admin/AdminMarketPage'),
  () => import('./pages/admin/AdminRiskPage'),
  () => import('./pages/admin/AdminAuditPage'),
  () => import('./pages/admin/AdminNotificationsPage'),
  () => import('./pages/admin/AdminUsagePage'),
  () => import('./pages/admin/AdminCloudStoragePage'),
  () => import('./pages/admin/AdminSendRecordsPage'),
  () => import('./pages/admin/AdminProfilePage'),
];

const [
  loadHomePage,
  loadChatListPage,
  loadCreateChatPage,
  loadChatDetailPage,
  loadCreateDirectChatPage,
  loadCharacterLibraryPage,
  loadCharacterEditorPage,
  loadSettingsPage,
  loadRecycleBinPage,
  loadAIProxyPage,
  loadMembershipPage,
  loadAccountPage,
  loadSyncStatusPage,
  loadBatchGenerateCharactersPage,
  loadLettersPage,
  loadCalendarPage,
  loadMomentsPage,
  loadMarketPage,
  loadFilesPage,
  loadIntroPage,
  loadLoginPage,
  loadPublicSharedChatPage,
  loadAdminLayout,
  loadAdminLoginPage,
  loadAdminDashboardPage,
  loadAdminUsersPage,
  loadAdminAdminsPage,
  loadAdminGlobalConfigPage,
  loadAdminAIProviderPage,
  loadAdminPlatformPage,
  loadAdminBillingPage,
  loadAdminModerationPage,
  loadAdminMarketPage,
  loadAdminRiskPage,
  loadAdminAuditPage,
  loadAdminNotificationsPage,
  loadAdminUsagePage,
  loadAdminCloudStoragePage,
  loadAdminSendRecordsPage,
  loadAdminProfilePage,
] = routePreloaders;

const HomePage = lazy(loadHomePage);
const ChatListPage = lazy(loadChatListPage);
const CreateChatPage = lazy(loadCreateChatPage);
const ChatDetailPage = lazy(loadChatDetailPage);
const CreateDirectChatPage = lazy(loadCreateDirectChatPage);
const CharacterLibraryPage = lazy(loadCharacterLibraryPage);
const CharacterEditorPage = lazy(loadCharacterEditorPage);
const SettingsPage = lazy(loadSettingsPage);
const RecycleBinPage = lazy(loadRecycleBinPage);
const AIProxyPage = lazy(loadAIProxyPage);
const MembershipPage = lazy(loadMembershipPage);
const AccountPage = lazy(loadAccountPage);
const SyncStatusPage = lazy(loadSyncStatusPage);
const BatchGenerateCharactersPage = lazy(loadBatchGenerateCharactersPage);
const LettersPage = lazy(loadLettersPage);
const CalendarPage = lazy(loadCalendarPage);
const MomentsPage = lazy(loadMomentsPage);
const MarketPage = lazy(loadMarketPage);
const FilesPage = lazy(loadFilesPage);
const IntroPage = lazy(loadIntroPage);
const IntroConceptPage = lazy(() => import('./pages/IntroPage').then((module) => ({ default: module.IntroConceptPage })));
const LoginPage = lazy(loadLoginPage);
const PublicSharedChatPage = lazy(loadPublicSharedChatPage);
const AdminLayout = lazy(loadAdminLayout);
const AdminLoginPage = lazy(loadAdminLoginPage);
const AdminDashboardPage = lazy(loadAdminDashboardPage);
const AdminUsersPage = lazy(loadAdminUsersPage);
const AdminAdminsPage = lazy(loadAdminAdminsPage);
const AdminGlobalConfigPage = lazy(loadAdminGlobalConfigPage);
const AdminAIProviderPage = lazy(loadAdminAIProviderPage);
const AdminPlatformPage = lazy(loadAdminPlatformPage);
const AdminBillingPage = lazy(loadAdminBillingPage);
const AdminModerationPage = lazy(loadAdminModerationPage);
const AdminMarketPage = lazy(loadAdminMarketPage);
const AdminRiskPage = lazy(loadAdminRiskPage);
const AdminAuditPage = lazy(loadAdminAuditPage);
const AdminNotificationsPage = lazy(loadAdminNotificationsPage);
const AdminUsagePage = lazy(loadAdminUsagePage);
const AdminCloudStoragePage = lazy(loadAdminCloudStoragePage);
const AdminSendRecordsPage = lazy(loadAdminSendRecordsPage);
const AdminProfilePage = lazy(loadAdminProfilePage);
const AppRouter = import.meta.env.VITE_APP_ROUTER === 'hash' ? HashRouter : BrowserRouter;

function RouteFallback() {
  return (
    <Box sx={{ px: 2.5, pt: 1.5 }}>
      <LinearProgress sx={{ borderRadius: 999 }} />
    </Box>
  );
}

function RouteElement({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

function ChatDetailRouteElement() {
  return <RouteElement><ChatDetailPage /></RouteElement>;
}

function ChatMasterDetailRouteElement({ detail, fallback = 'detail', detailTitle = '会话' }: { detail: React.ReactNode; fallback?: 'master' | 'detail'; detailTitle?: React.ReactNode | null }) {
  return (
    <MasterDetailLayout
      master={<RouteElement><ChatListPage /></RouteElement>}
      detail={detail}
      masterTitle="聊天"
      detailTitle={detail ? detailTitle : null}
      fallback={fallback}
    />
  );
}

function CharacterMasterDetailRouteElement({ detail, fallback = 'detail' }: { detail: React.ReactNode; fallback?: 'master' | 'detail' }) {
  return (
    <MasterDetailLayout
      master={<RouteElement><CharacterLibraryPage /></RouteElement>}
      detail={detail}
      masterTitle="角色库"
      detailTitle={detail ? '角色' : null}
      fallback={fallback}
    />
  );
}

function RequireAdminAuth() {
  const isLoggedIn = useAdminAuthStore((s) => s.isLoggedIn);
  const isLoading = useAdminAuthStore((s) => s.isLoading);
  const location = useLocation();
  if (isLoading) {
    return <RouteFallback />;
  }
  if (!isLoggedIn) {
    return <Navigate to="/admin/login" state={{ from: location }} replace />;
  }
  return <Outlet />;
}

function AdminAuthRedirectHandler() {
  const logout = useAdminAuthStore((s) => s.logout);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (event: Event) => {
      const from = (event as CustomEvent<{ from?: string }>).detail?.from || `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (!from.startsWith('/admin')) return;
      logout();
      navigate('/admin/login', { replace: true, state: { from: { pathname: from } } });
    };
    window.addEventListener(ADMIN_LOGIN_EVENT, handler);
    return () => window.removeEventListener(ADMIN_LOGIN_EVENT, handler);
  }, [logout, navigate]);

  return null;
}

function AdminAuthBootstrap() {
  const checkAdminAuth = useAdminAuthStore((s) => s.checkAuth);
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');

  useEffect(() => {
    if (!isAdminRoute) return;
    void checkAdminAuth();
  }, [checkAdminAuth, isAdminRoute]);

  return null;
}

function LegacyAdminAIProviderRedirect() {
  const { providerCode = '' } = useParams();
  return (
    <Navigate
      to={providerCode ? `/admin/platform/ai/providers/${encodeURIComponent(providerCode)}` : '/admin/platform?tab=ai'}
      replace
    />
  );
}

function AuthBootstrap() {
  const token = useAuthStore((s) => s.token);
  const authMode = useAuthStore((s) => s.authMode);
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');

  useEffect(() => {
    if (isAdminRoute) return;
    if (authMode !== 'cloud' || !token) return;
    void checkAuth();
  }, [authMode, checkAuth, isAdminRoute, token]);

  useEffect(() => {
    if (isAdminRoute || authMode !== 'cloud' || !token) return;
    let disposed = false;
    let timer: number | null = null;
    const refresh = async () => {
      if (disposed || !isWorkspaceActive() || document.visibilityState === 'hidden' || !navigator.onLine) return;
      try {
        const refreshed = await api.refreshAuthIfNeeded();
        if (!disposed && isWorkspaceActive() && refreshed) {
          useAuthStore.setState({ token: readAuthSnapshot().token });
        }
      } catch (error) {
        if (!isWorkspaceActive()) return;
        console.warn('[auth] scheduled refresh failed', { error });
      }
      if (!disposed && isWorkspaceActive()) schedule();
    };
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      const delay = api.getAuthRefreshDelayMs();
      // Unknown/non-JWT tokens are left to the normal request/401 fallback.
      if (delay === null) return;
      timer = window.setTimeout(() => { void refresh(); }, Math.max(30_000, delay));
    };
    const onResume = () => { void refresh(); };
    window.addEventListener('focus', onResume);
    window.addEventListener('online', onResume);
    window.addEventListener('storage', onResume);
    document.addEventListener('visibilitychange', onResume);
    schedule();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('online', onResume);
      window.removeEventListener('storage', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [authMode, isAdminRoute, token]);

  return null;
}

function AuthSessionRedirectHandler() {
  const expireCloudSession = useAuthStore((s) => s.expireCloudSession);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<AuthSessionExpiredDetail>).detail || {};
      expireCloudSession();
      navigate('/login', {
        replace: true,
        state: {
          from: detail.from,
          reason: 'expired',
        },
      });
    };
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handler);
  }, [expireCloudSession, navigate]);

  return null;
}

function DataLoader({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const authMode = useAuthStore((s) => s.authMode);
  const isWorkspaceReady = useAuthStore((s) => s.isWorkspaceReady);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');

  useEffect(() => {
    if (!isAdminRoute && isWorkspaceReady && (isLoggedIn || authMode === 'local')) {
      void loadSettings();
    }
  }, [authMode, isAdminRoute, isLoggedIn, isWorkspaceReady, loadSettings]);

  // Admin pages use their own authentication and API surface; they must not
  // wait for the user workspace bootstrap (which is intentionally skipped on
  // /admin routes).
  return isAdminRoute || isWorkspaceReady ? <>{children}</> : <RouteFallback />;
}

function startPostImportCloudRefresh() {
  if (!isCloudSyncEnabled()) return;
  void Promise.allSettled([
    useSettingsStore.getState().refreshSettingsFromCloud(),
    useChatStore.getState().refreshChatSummaryFromCloud(),
    useCharacterStore.getState().refreshCharacterSummaryFromCloud(),
  ]);
}

function GuestImportPrompt() {
  const authMode = useAuthStore((s) => s.authMode);
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const userId = useAuthStore((s) => s.user?.id || null);
  const [snapshot, setSnapshot] = useState<GuestImportSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isLoggedIn || authMode !== 'cloud' || !userId) {
      void Promise.resolve().then(() => {
        if (!cancelled) setSnapshot(null);
      });
      return () => {
        cancelled = true;
      };
    }
    void readGuestImportSnapshot().then((nextSnapshot) => {
      if (cancelled) return;
      setSnapshot(hasPendingGuestImportForUser(userId, nextSnapshot) ? nextSnapshot : null);
    });
    return () => {
      cancelled = true;
    };
  }, [authMode, isLoggedIn, userId]);

  const closeAndRefresh = () => {
    if (userId && snapshot) markGuestImportSnapshotDismissed(userId, snapshot);
    setSnapshot(null);
    startPostImportCloudRefresh();
  };

  const handleImport = async () => {
    if (!snapshot) return;
    setBusy(true);
    try {
      await importGuestDataToCurrentAccount(snapshot);
      closeAndRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(snapshot)} maxWidth="xs" fullWidth>
      <DialogTitle>导入未登录数据</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          检测到此设备上有未登录时创建的本地数据。你可以导入到当前账号；不导入时，这些数据会保留在未登录本地空间，退出账号后仍可看到。
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={closeAndRefresh} disabled={busy}>暂不导入</Button>
        <Button variant="contained" onClick={handleImport} disabled={busy}>导入到当前账号</Button>
      </DialogActions>
    </Dialog>
  );
}

function SiteConfigBootstrap({ onThemeColor }: { onThemeColor: (value: string | null) => void }) {
  useEffect(() => {
    let cancelled = false;
    const fallbackTitle = document.title || APP_TITLE;
    const ensureMeta = (name: string) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = name;
        document.head.appendChild(meta);
      }
      return meta;
    };
    const ensureFavicon = () => {
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      return link;
    };
    void api.getPlatformPublicConfig()
      .then(({ site }) => {
        if (cancelled) return;
        document.title = site.siteTitle || APP_TITLE;
        ensureMeta('description').content = site.siteDescription || APP_DESCRIPTION;
        onThemeColor(site.themeColor || null);
        if (site.faviconUrl) ensureFavicon().href = site.faviconUrl;
      })
      .catch(() => {
        if (cancelled) return;
        document.title = fallbackTitle;
        ensureMeta('description').content = APP_DESCRIPTION;
        onThemeColor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [onThemeColor]);

  return null;
}

function RouteThemeColorBootstrap({ onThemeColor }: { onThemeColor: (value: string | null) => void }) {
  const location = useLocation();

  useEffect(() => {
    const isIntroRoute = location.pathname === '/intro' || location.pathname === '/intro/concept';
    onThemeColor(isIntroRoute ? '#0A0A0F' : null);
  }, [location.pathname, onThemeColor]);

  return null;
}

function InAppNotificationBootstrap() {
  const authUserId = useAuthStore((state) => state.user?.id || '');
  const setNotificationItems = useInAppNotificationStore((state) => state.setItems);
  const [popupNotification, setPopupNotification] = useState<SystemAnnouncementItem | null>(null);
  const closePopupNotification = () => {
    const notificationId = popupNotification?.id;
    setPopupNotification(null);
    if (!notificationId) return;
    void api.recordSystemAnnouncementReceipts({
      announcementIds: [notificationId],
      eventType: 'popup_ack',
      anonymousId: getAppUsageAnonymousId(),
    }).catch((error) => {
      console.warn('[notifications] failed to record in-app message popup ack', error);
    });
  };

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let lastLoadedAt = 0;
    const loadNotifications = (force = false) => {
      if (document.visibilityState === 'hidden' && !force) return;
      const now = Date.now();
      if (!force && (inFlight || now - lastLoadedAt < 30_000)) return;
      inFlight = true;
      lastLoadedAt = now;
      api.getSystemAnnouncements()
        .then((result) => {
          if (cancelled) return;
          const activeItems = (result.items || []).filter((item) => item.pinnedEnabled || item.popupEnabled);
          setNotificationItems(activeItems);
          const seenScope = authUserId || 'guest';
          const reportedExposureIds = readSessionReportedInAppNotificationExposureIds(seenScope);
          const exposureIds = activeItems.map((item) => item.id).filter((id) => !reportedExposureIds.has(id));
          if (exposureIds.length) {
            exposureIds.forEach((id) => reportedExposureIds.add(id));
            writeSessionReportedInAppNotificationExposureIds(reportedExposureIds, seenScope);
            void api.recordSystemAnnouncementReceipts({
              announcementIds: exposureIds,
              eventType: 'exposure',
              anonymousId: getAppUsageAnonymousId(),
            }).catch((error) => {
              console.warn('[notifications] failed to record in-app message exposure', error);
            });
          }
          const seenIds = readSeenInAppNotificationIds(seenScope);
          const nextPopup = activeItems.find((item) => item.popupEnabled && !seenIds.has(item.id));
          if (nextPopup) {
            seenIds.add(nextPopup.id);
            writeSeenInAppNotificationIds(seenIds, seenScope);
            setPopupNotification(nextPopup);
          }
        })
        .catch((error) => {
          console.warn('[notifications] failed to load in-app messages', error);
          if (!cancelled) setNotificationItems([]);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    loadNotifications(true);
    const timer = window.setInterval(() => loadNotifications(), 5 * 60_000);
    const handleFocus = () => loadNotifications();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadNotifications();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authUserId, setNotificationItems]);

  return (
    <Dialog open={Boolean(popupNotification)} onClose={closePopupNotification} maxWidth="sm" fullWidth>
      <DialogTitle>{popupNotification?.title || '站内信'}</DialogTitle>
      <DialogContent>
        {popupNotification ? (
          <Box sx={{ display: 'grid', gap: 1, pt: 0.5 }}>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, overflowWrap: 'anywhere' }}>
              {popupNotification.body}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              生效时间：{formatInAppNotificationWindow(popupNotification)}
            </Typography>
          </Box>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={closePopupNotification}>知道了</Button>
      </DialogActions>
    </Dialog>
  );
}

function AppUsageSessionBootstrap() {
  const location = useLocation();
  const authUserId = useAuthStore((state) => state.user?.id || '');
  const isAdminRoute = location.pathname.startsWith('/admin');
  const clientRef = useRef<AppUsageSessionClient | null>(null);

  useEffect(() => {
    if (isAdminRoute) return undefined;
    const client = new AppUsageSessionClient();
    clientRef.current = client;
    void client.start().catch((error) => {
      console.warn('[usage] failed to start app usage session', error);
    });

    const heartbeat = () => {
      void client.heartbeat().catch(() => undefined);
    };
    const end = () => {
      client.end();
    };
    const handleVisibilityChange = () => {
      heartbeat();
    };

    window.addEventListener('focus', heartbeat);
    window.addEventListener('pagehide', end);
    window.addEventListener('beforeunload', end);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', heartbeat);
      window.removeEventListener('pagehide', end);
      window.removeEventListener('beforeunload', end);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      client.end();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [authUserId, isAdminRoute]);

  useEffect(() => {
    if (isAdminRoute) return;
    void clientRef.current?.heartbeat(currentUsagePath());
  }, [isAdminRoute, location.hash, location.pathname, location.search]);

  return null;
}

function RoutedApp() {
  return (
    <Routes>
      <Route path="/login" element={<RouteElement><LoginPage /></RouteElement>} />
      <Route path="/admin/login" element={<RouteElement><AdminLoginPage /></RouteElement>} />
      <Route path="/intro/concept" element={<RouteElement><IntroConceptPage /></RouteElement>} />
      <Route path="/shared/:token" element={<RouteElement><PublicSharedChatPage /></RouteElement>} />
      <Route path="/shared/chats/:token" element={<RouteElement><PublicSharedChatPage /></RouteElement>} />
      <Route element={<RequireAdminAuth />}>
        <Route path="/admin" element={<RouteElement><AdminLayout /></RouteElement>}>
          <Route index element={<RouteElement><AdminPermissionGate permissions={ADMIN_DASHBOARD_PERMISSIONS}><AdminDashboardPage /></AdminPermissionGate></RouteElement>} />
          <Route path="users" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.usersRead]}><AdminUsersPage /></AdminPermissionGate></RouteElement>} />
          <Route path="admins" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.adminAll]}><AdminAdminsPage /></AdminPermissionGate></RouteElement>} />
          <Route path="global-config" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.platformRead]}><AdminGlobalConfigPage /></AdminPermissionGate></RouteElement>} />
          <Route path="ai" element={<Navigate to="/admin/platform?tab=ai" replace />} />
          <Route path="ai/providers/:providerCode" element={<LegacyAdminAIProviderRedirect />} />
          <Route path="platform/ai/providers/:providerCode" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.aiRead]}><AdminAIProviderPage /></AdminPermissionGate></RouteElement>} />
          <Route path="platform" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.platformRead, ADMIN_PERMISSION_CODES.aiRead]}><AdminPlatformPage /></AdminPermissionGate></RouteElement>} />
          <Route path="billing" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.billingRead]}><AdminBillingPage /></AdminPermissionGate></RouteElement>} />
          <Route path="moderation" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.sharesReview]}><AdminModerationPage /></AdminPermissionGate></RouteElement>} />
          <Route path="market" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.marketRead]}><AdminMarketPage /></AdminPermissionGate></RouteElement>} />
          <Route path="notifications" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.notificationsRead]}><AdminNotificationsPage /></AdminPermissionGate></RouteElement>} />
          <Route path="usage" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.usersRead]}><AdminUsagePage /></AdminPermissionGate></RouteElement>} />
          <Route path="files" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.usersRead]}><AdminCloudStoragePage /></AdminPermissionGate></RouteElement>} />
          <Route path="send-records" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.notificationsRead]}><AdminSendRecordsPage /></AdminPermissionGate></RouteElement>} />
          <Route path="config-migration" element={<Navigate to="/admin/global-config" replace />} />
          <Route path="risk" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.riskRead]}><AdminRiskPage /></AdminPermissionGate></RouteElement>} />
          <Route path="audit" element={<RouteElement><AdminPermissionGate permissions={[ADMIN_PERMISSION_CODES.auditRead]}><AdminAuditPage /></AdminPermissionGate></RouteElement>} />
          <Route path="me" element={<RouteElement><AdminProfilePage /></RouteElement>} />
        </Route>
      </Route>
      <Route element={<AppLayout />}>
        <Route path="/" element={<RouteElement><HomePage /></RouteElement>} />
        <Route path="/chats" element={<ChatMasterDetailRouteElement detail={null} fallback="master" />} />
        <Route path="/chats/create" element={<ChatMasterDetailRouteElement detail={<RouteElement><CreateChatPage /></RouteElement>} />} />
        <Route path="/direct/create" element={<ChatMasterDetailRouteElement detail={<RouteElement><CreateDirectChatPage /></RouteElement>} />} />
        <Route path="/chats/:id/edit" element={<ChatMasterDetailRouteElement detail={<RouteElement><CreateChatPage /></RouteElement>} />} />
        <Route path="/chats/:id" element={<ChatMasterDetailRouteElement detail={<ChatDetailRouteElement />} detailTitle={null} />} />
        <Route path="/characters" element={<CharacterMasterDetailRouteElement detail={null} fallback="master" />} />
        <Route path="/characters/create" element={<CharacterMasterDetailRouteElement detail={<RouteElement><CharacterEditorPage /></RouteElement>} />} />
        <Route path="/characters/:id/edit" element={<CharacterMasterDetailRouteElement detail={<RouteElement><CharacterEditorPage /></RouteElement>} />} />
        <Route path="/characters/batch-generate" element={<RouteElement><BatchGenerateCharactersPage /></RouteElement>} />
        <Route path="/letters" element={<RouteElement><LettersPage /></RouteElement>} />
        <Route path="/calendar" element={<RouteElement><CalendarPage /></RouteElement>} />
        <Route path="/moments" element={<RouteElement><MomentsPage /></RouteElement>} />
        <Route path="/market" element={<RouteElement><MarketPage /></RouteElement>} />
        <Route path="/files" element={<RouteElement><FilesPage /></RouteElement>} />
        <Route path="/intro" element={<RouteElement><IntroPage /></RouteElement>} />
        <Route path="/ai-models" element={<Navigate to={buildSettingsPath({ tab: 'models' })} replace />} />
        <Route path="/ai-proxy" element={<RouteElement><AIProxyPage /></RouteElement>} />
        <Route path="/membership" element={<RouteElement><MembershipPage /></RouteElement>} />
        <Route path="/account" element={<RouteElement><AccountPage /></RouteElement>} />
        <Route path="/account/sync-status" element={<RouteElement><SyncStatusPage /></RouteElement>} />
        <Route path="/settings" element={<RouteElement><SettingsPage /></RouteElement>} />
        <Route path="/settings/recycle-bin" element={<RouteElement><RecycleBinPage /></RouteElement>} />
      </Route>
    </Routes>
  );
}

export default function App() {
  const themeMode = useSettingsStore((s) => s.theme);
  const themePreset = useSettingsStore((s) => s.themePreset);
  const themeColor = useSettingsStore((s) => s.themeColor);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [settingsHydrated, setSettingsHydrated] = useState(() => useSettingsStore.persist.hasHydrated());
  const [siteThemeColor, setSiteThemeColor] = useState<string | null>(null);
  const [routeThemeColor, setRouteThemeColor] = useState<string | null>(null);

  useEffect(() => {
    if (settingsHydrated) return;
    let cancelled = false;
    Promise.resolve(useSettingsStore.persist.rehydrate()).finally(() => {
      if (!cancelled) setSettingsHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [settingsHydrated]);

  const resolvedMode = themeMode === 'system' ? (prefersDark ? 'dark' : 'light') : themeMode;

  const theme = useMemo(
    () => createAppTheme(resolvedMode, themeColor, themePreset),
    [resolvedMode, themeColor, themePreset]
  );

  useEffect(() => {
    const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.content = routeThemeColor || siteThemeColor || theme.palette.primary.main;
  }, [routeThemeColor, siteThemeColor, theme]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <DevUpdatePrompt />
      <PwaUpdatePrompt />
      {settingsHydrated ? (
        <AppRouter>
          <SiteConfigBootstrap onThemeColor={setSiteThemeColor} />
          <RouteThemeColorBootstrap onThemeColor={setRouteThemeColor} />
          <AuthBootstrap />
          <AuthSessionRedirectHandler />
          <AdminAuthRedirectHandler />
          <AdminAuthBootstrap />
          <GuestImportPrompt />
          <InAppNotificationBootstrap />
          <AppUsageSessionBootstrap />
          <DataLoader>
            <RoutedApp />
          </DataLoader>
        </AppRouter>
      ) : (
        <RouteFallback />
      )}
    </ThemeProvider>
  );
}
