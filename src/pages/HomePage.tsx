import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Alert, Avatar, Box, Typography, Button, ButtonBase, CardActionArea, IconButton, Chip, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ChatIcon from '@mui/icons-material/Chat';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeveloperModeIcon from '@mui/icons-material/DeveloperMode';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import PersonIcon from '@mui/icons-material/Person';
import SettingsSuggestIcon from '@mui/icons-material/SettingsSuggest';
import SyncProblemIcon from '@mui/icons-material/SyncProblem';
import CloseIcon from '@mui/icons-material/Close';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '../stores/useAuthStore';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { readPersistentUiValue } from '../utils/persistentUiState';
import { useMessageStore } from '../stores/useMessageStore';
import type { SyncScopeSnapshot } from '../stores/syncScopeMetadata';
import { getUsableDefaultTextAIProfile, hasUsableDefaultTextAI } from '../types/settings';
import { getLocalDataUserId } from '../services/authStorageScope';
import ChatCard from '../components/chat/ChatCard';
import EmptyState from '../components/common/EmptyState';
import NoCharactersDialog from '../components/common/NoCharactersDialog';
import SurfaceCard from '../components/common/SurfaceCard';
import PageSection from '../components/common/PageSection';
import { buildSettingsPath } from '../routes/settingsRoute';
import SectionHeader from '../components/common/SectionHeader';
import HomeCommandLauncher from '../features/homeCommand/HomeCommandLauncher';
import { MIN_MEMBERS } from '../constants/defaults';
import { avatarGenerationQueue, type AvatarGenerationQueueSummary } from '../services/avatarGenerationQueue';
import { dismissAllCharacterCompletionErrors, dismissCharacterCompletionError, getCharacterCompletionSummary, subscribeCharacterCompletionQueue, type CharacterCompletionSummary } from '../services/characterCompletionQueue';
import type { HomeCompanionshipSnapshot } from '../services/companionshipProjection';
import { shouldShowCompanionshipStatusHints } from '../services/companionshipStatusVisibility';
import { isCloudSyncEnabled } from '../services/cloudSyncPreference';
import { buildHomeSyncOverview } from '../services/homeSyncOverview';
import { buildLocalOutboxProjection, type LocalOutboxArtifactJobLike } from '../services/localOutboxProjection';
import { mirrorLocalOutboxQueues } from '../services/localOutboxMirror';
import { projectWorldCalendar, type WorldCalendarItem } from '../services/worldRuntimeProjection';
import { api, type OfficialAiProviderInfo } from '../services/api';
import { formatInAppNotificationWindow, notificationAlertSeverity, useInAppNotificationStore } from '../services/inAppNotifications';
import { getRegisteredSyncWorkerEntries } from '../stores/storeSyncScheduler';
import { motion, transition } from '../styles/motion';
import { formatAiAmount } from '../utils/aiPoints';
import { dismissAllRichMediaGenerationErrors, dismissRichMediaGenerationError, getRecentRichMediaGenerationErrors, getRichMediaQueueSnapshot, subscribeRichMediaQueue } from '../services/richMessageMedia';
import { dismissAllChatCompletionErrors, dismissChatCompletionError, getChatCompletionSummary, subscribeChatCompletionQueue, type ChatCompletionSummary } from '../services/chatCompletionQueue';
import { isImageAvatar } from '../utils/avatar';
import { buildCardAvatarHoverMotionSx } from '../styles/avatarHoverMotion';

interface HomeOverviewCard {
  label: string;
  value: string | number;
  icon: ReactNode;
  color: string;
  onOpen: () => void | Promise<void>;
  onCreate?: () => void | Promise<void>;
  createLabel?: string;
  attention?: boolean;
}

interface GenerationOverviewError {
  id: string;
  source: 'avatar' | 'completion' | 'chat-completion' | 'rich-media';
  title: string;
  message: string;
  createdAt: number;
}

const AI_POINT_PLACEHOLDER_VALUE = '--';

type OfficialBalanceProvider = string;

interface ArtifactHomeState {
  jobs: LocalOutboxArtifactJobLike[];
  syncScopes: SyncScopeSnapshot[];
}

interface ArtifactStoreSnapshotLike {
  jobs: Array<{
    id: string;
    kind: string;
    characterId: string;
    dateKey?: string | null;
    sourceKey?: string | null;
    createdAt: number;
    status: string;
    attempts: number;
    error?: string | null;
    updatedAt: number;
  }>;
  getSyncScopeStates: () => SyncScopeSnapshot[];
}

const EMPTY_ARTIFACT_HOME_STATE: ArtifactHomeState = {
  jobs: [],
  syncScopes: [],
};

type OfficialBalanceProviderInfo = {
  key: OfficialBalanceProvider;
  publicProvider: string;
  label: string;
  accessAllowed: boolean;
};

function normalizeOfficialBalanceProvider(provider: string): OfficialBalanceProvider | null {
  if (provider === 'official') return 'official-2';
  if (provider === 'official-deepseek') return 'official-1';
  if (provider === 'official-moacode') return 'official-2';
  if (provider === 'official-moacode-team') return 'official-team';
  if (provider === 'official-gpt') return 'official-4';
  if (provider.startsWith('official-')) return provider;
  return null;
}

function buildStatGridSx() {
  return {
    display: 'grid',
    gridTemplateColumns: {
      xs: 'repeat(2, minmax(0, 1fr))',
      sm: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))',
    },
    '@media (min-width: 360px) and (max-width: 599.95px)': {
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    },
    columnGap: { xs: 0.55, sm: 1 },
    rowGap: { xs: 0.8, sm: 1.25 },
    mt: 1,
    px: 0,
    pb: 0.75,
    alignItems: 'stretch',
    justifyContent: { xs: 'stretch', sm: 'start' },
  };
}

function buildStatCellSx() {
  return {
    minWidth: 0,
    display: 'flex',
    justifyContent: 'stretch',
    overflow: 'visible',
  };
}

function formatHomeCalendarTime(timestamp: number | null | undefined) {
  if (typeof timestamp !== 'number') return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatOngoingActivityWindow(item: WorldCalendarItem) {
  const start = formatHomeCalendarTime(item.startAt);
  const end = formatHomeCalendarTime(item.endAt);
  if (start && end) return `${start} - ${end}`;
  if (start && typeof item.durationMinutes === 'number') return `${start} · 约${item.durationMinutes}分钟`;
  if (start) return start;
  return item.timeHint || '时间未定';
}

function formatOngoingActivityProgress(item: WorldCalendarItem, now: number) {
  if (typeof item.endAt === 'number') {
    const remainingMinutes = Math.max(0, Math.ceil((item.endAt - now) / 60_000));
    if (remainingMinutes > 0) return `预计还剩 ${remainingMinutes} 分钟`;
    return '即将结束';
  }
  if (typeof item.startAt === 'number') {
    const elapsedMinutes = Math.max(0, Math.floor((now - item.startAt) / 60_000));
    return elapsedMinutes > 0 ? `已进行 ${elapsedMinutes} 分钟` : '刚刚开始';
  }
  return '进行中';
}

function buildOngoingActivityRowSx() {
  return {
    display: 'grid',
    gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto' },
    gap: { xs: 1, sm: 1.5 },
    alignItems: { xs: 'stretch', sm: 'center' },
    p: { xs: 1.25, sm: 1.5 },
    borderRadius: 1.5,
    border: '1px solid',
    borderColor: 'divider',
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.045)' : 'rgba(120,156,220,0.075)',
    cursor: 'pointer',
    transition: transition(['border-color', 'background-color'], motion.durations.base, motion.gentleSpring),
    '&:hover': {
      borderColor: 'primary.main',
      bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.075)' : 'rgba(120,156,220,0.11)',
    },
  };
}

function buildStatCardSx() {
  return {
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    minWidth: 0,
    position: 'relative',
    overflow: 'visible',
    cursor: 'pointer',
    transition: transition(['transform', 'box-shadow', 'border-color'], motion.durations.base, motion.gentleSpring),
    '&:hover': {
      boxShadow: (theme: Theme) => theme.palette.mode === 'light' ? '0 16px 36px rgba(15,23,42,0.08)' : '0 18px 42px rgba(0,0,0,0.34)',
      borderColor: 'primary.main',
    },
    '&:active': {
      transform: 'scale(0.992)',
      transitionTimingFunction: motion.press,
      transitionDuration: `${motion.durations.instant}ms`,
    },
    '&::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      borderTop: '1px solid',
      borderColor: (theme: Theme) => `${theme.palette.primary.main}24`,
      pointerEvents: 'none',
      borderRadius: 'inherit',
    },
  };
}

function buildAttentionCardSx() {
  return {
    ...buildStatCardSx(),
    borderColor: (theme: Theme) => `${theme.palette.primary.main}42`,
    bgcolor: (theme: Theme) => theme.palette.mode === 'light'
      ? 'rgba(49,90,156,0.065)'
      : 'rgba(120,156,220,0.095)',
    '&::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      borderTop: '1px solid',
      borderColor: (theme: Theme) => `${theme.palette.primary.main}40`,
      pointerEvents: 'none',
      borderRadius: 'inherit',
    },
  };
}

function buildStatContentSx() {
  return {
    width: '100%',
    textAlign: 'center',
    p: 0,
    '&:last-child': { pb: 0 },
    minHeight: { xs: 78, sm: 88 },
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  };
}

function buildStatCenterSx() {
  return {
    width: '100%',
    minHeight: { xs: 78, sm: 88 },
    py: { xs: 1, sm: 1.35 },
    px: { xs: 0.3, sm: 0.9 },
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: { xs: 0.35, sm: 0.45 },
    overflow: 'visible',
  };
}

function buildCreateButtonSx() {
  return {
    position: 'absolute',
    right: -6,
    bottom: -6,
    zIndex: 1,
    width: { xs: 28, sm: 30 },
    height: { xs: 28, sm: 30 },
    bgcolor: 'primary.main',
    color: 'primary.contrastText',
    boxShadow: (theme: Theme) => theme.palette.mode === 'light'
      ? '0 10px 24px rgba(15,23,42,0.20)'
      : '0 12px 28px rgba(0,0,0,0.42)',
    border: 2,
    borderColor: 'background.default',
    borderRadius: '50%',
    transition: transition(['transform', 'box-shadow', 'background-color'], motion.durations.base, motion.spring),
    '&:hover': {
      bgcolor: 'primary.dark',
      transform: 'translateY(-1px) scale(1.08)',
      boxShadow: 4,
    },
    '&:active': {
      transform: 'scale(0.93)',
      transitionTimingFunction: motion.press,
      transitionDuration: `${motion.durations.instant}ms`,
    },
    '& .MuiTouchRipple-root': {
      borderRadius: '50%',
    },
  };
}

function buildStatLabelSx() {
  return {
    width: '100%',
    lineHeight: 1.25,
    textAlign: 'center',
    minHeight: { xs: '2.2em', sm: '2.3em' },
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    color: 'text.secondary',
    fontSize: { xs: '0.66rem', sm: '0.78rem' },
    '& > span': {
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
    },
  };
}

function buildStatValueSx() {
  return {
    fontWeight: 700,
    lineHeight: 1,
    fontSize: { xs: '1rem', sm: '1.16rem' },
  };
}

function buildStatIconSx(color: string) {
  return {
    color,
    fontSize: { xs: '0.9rem', sm: '1rem' },
    lineHeight: 1,
  };
}

function buildGridSx() {
  return {
    display: 'grid',
    gridTemplateColumns: {
      xs: '1fr',
      sm: 'repeat(2, minmax(0, 1fr))',
      lg: 'repeat(3, minmax(0, 1fr))',
    },
    gap: 1.5,
  };
}

function projectArtifactHomeState(state: ArtifactStoreSnapshotLike): ArtifactHomeState {
  return {
    jobs: state.jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      characterId: job.characterId,
      dateKey: job.dateKey,
      sourceKey: job.sourceKey,
      createdAt: job.createdAt,
      status: job.status,
      attempts: job.attempts,
      error: job.error,
      updatedAt: job.updatedAt,
    })),
    syncScopes: state.getSyncScopeStates(),
  };
}

function areArtifactJobsEqual(a: LocalOutboxArtifactJobLike[], b: LocalOutboxArtifactJobLike[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return Boolean(other)
      && item.id === other.id
      && item.kind === other.kind
      && item.characterId === other.characterId
      && item.dateKey === other.dateKey
      && item.sourceKey === other.sourceKey
      && item.createdAt === other.createdAt
      && item.status === other.status
      && item.attempts === other.attempts
      && item.error === other.error
      && item.updatedAt === other.updatedAt;
  });
}

function areSyncScopeSnapshotsEqual(a: SyncScopeSnapshot[], b: SyncScopeSnapshot[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return Boolean(other)
      && item.scope === other.scope
      && item.lastCheckedAt === other.lastCheckedAt
      && item.lastAppliedAt === other.lastAppliedAt
      && item.cursor === other.cursor
      && item.revision === other.revision
      && item.lastError === other.lastError
      && item.errorCount === other.errorCount
      && item.retryAt === other.retryAt
      && item.inflight === other.inflight;
  });
}

function areArtifactHomeStatesEqual(a: ArtifactHomeState, b: ArtifactHomeState) {
  return areArtifactJobsEqual(a.jobs, b.jobs) && areSyncScopeSnapshotsEqual(a.syncScopes, b.syncScopes);
}

function scheduleIdleTask(callback: () => void, timeout = 1200) {
  const scheduler = (window as typeof window & {
    requestIdleCallback?: (idleCallback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  }).requestIdleCallback;
  if (typeof scheduler === 'function') {
    const idleHandle = scheduler(callback, { timeout });
    return () => window.cancelIdleCallback?.(idleHandle);
  }
  const timeoutHandle = window.setTimeout(callback, Math.min(timeout, 400));
  return () => window.clearTimeout(timeoutHandle);
}

function useDeferredArtifactHomeState() {
  const [artifactState, setArtifactState] = useState<ArtifactHomeState>(EMPTY_ARTIFACT_HOME_STATE);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const cancelScheduled = scheduleIdleTask(() => {
      void import('../stores/useCharacterArtifactStore').then(({ useCharacterArtifactStore }) => {
        if (cancelled) return;
        const applyNextState = (nextState: ArtifactHomeState) => {
          setArtifactState((prev) => areArtifactHomeStatesEqual(prev, nextState) ? prev : nextState);
        };
        applyNextState(projectArtifactHomeState(useCharacterArtifactStore.getState()));
        unsubscribe = useCharacterArtifactStore.subscribe((state) => {
          applyNextState(projectArtifactHomeState(state));
        });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      cancelScheduled();
    };
  }, []);

  return artifactState;
}

export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { chats, prefetchChats, markChatsWarm, pendingOperations: chatPendingOperations, getSyncScopeStates: getChatSyncScopeStates } = useChatStore(useShallow((state) => ({
    chats: state.chats,
    prefetchChats: state.prefetchChats,
    markChatsWarm: state.markChatsWarm,
    pendingOperations: state.pendingOperations,
    getSyncScopeStates: state.getSyncScopeStates,
  })));
  const { characters, prefetchCharacters, markCharactersWarm, pendingOperations: characterPendingOperations, getSyncScopeStates: getCharacterSyncScopeStates } = useCharacterStore(useShallow((state) => ({
    characters: state.characters,
    prefetchCharacters: state.prefetchCharacters,
    markCharactersWarm: state.markCharactersWarm,
    pendingOperations: state.pendingOperations,
    getSyncScopeStates: state.getSyncScopeStates,
  })));
  const aiProfiles = useSettingsStore((state) => state.aiProfiles);
  const usageStats = useSettingsStore((state) => state.usageStats);
  const messagePendingOperations = useMessageStore((state) => state.pendingOperations);
  const getMessageSyncScopeStates = useMessageStore((state) => state.getSyncScopeStates);
  const developerMode = useSettingsStore((state) => state.developerMode);
  const { jobs: artifactJobs, syncScopes: artifactSyncScopes } = useDeferredArtifactHomeState();
  const getSettingsSyncScopeStates = useSettingsStore((state) => state.getSyncScopeStates);
  const activeDiaryJobs = artifactJobs.filter((job) => job.kind === 'diary' && (job.status === 'pending' || job.status === 'running')).length;
  const authMode = useAuthStore((state) => state.authMode);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const user = useAuthStore((state) => state.user);
  const [avatarQueueSummary, setAvatarQueueSummary] = useState<AvatarGenerationQueueSummary>(() => avatarGenerationQueue.getSummary());
  const [characterCompletionSummary, setCharacterCompletionSummary] = useState<CharacterCompletionSummary>(() => getCharacterCompletionSummary());
  const [chatCompletionSummary, setChatCompletionSummary] = useState<ChatCompletionSummary>(() => getChatCompletionSummary());
  const [generationErrorsDialogOpen, setGenerationErrorsDialogOpen] = useState(false);
  const [selectedGenerationError, setSelectedGenerationError] = useState<GenerationOverviewError | null>(null);
  const previousLoginIdentityRef = useRef<string | null | undefined>(undefined);
  const [cloudSyncEnabled, setCloudSyncEnabledState] = useState(() => isCloudSyncEnabled());
  const [workerEntries, setWorkerEntries] = useState(() => getRegisteredSyncWorkerEntries());
  const [aiPointBalance, setAiPointBalance] = useState<number | null | undefined>(undefined);
  const [officialProviderAccess, setOfficialProviderAccess] = useState<Record<string, OfficialBalanceProviderInfo> | null>(null);
  const [companionshipSnapshot, setCompanionshipSnapshot] = useState<HomeCompanionshipSnapshot | null>(null);
  const [calendarNow, setCalendarNow] = useState(() => Date.now());
  const richMediaQueue = useSyncExternalStore(subscribeRichMediaQueue, getRichMediaQueueSnapshot, getRichMediaQueueSnapshot);
  const inAppNotifications = useInAppNotificationStore((state) => state.items);
  // Persisted local chat summaries render immediately; cloud prefetch below
  // only merges fresher data and may update this ordering afterwards.
  const recentChats = useMemo(() => chats
    .slice()
    .sort((left, right) => (
      Number(right.lastMessageAt || right.updatedAt || right.createdAt || 0)
      - Number(left.lastMessageAt || left.updatedAt || left.createdAt || 0)
    ))
    .slice(0, 10), [chats]);
  const recentChatIds = useMemo(() => new Set(recentChats.map((chat) => chat.id)), [recentChats]);
  const recentActiveMessages = useMessageStore(useShallow((state) => (
    state.messages.filter((message) => recentChatIds.has(message.chatId)).slice(-30)
  )));
  const recentWindowMessages = useMessageStore(useShallow((state) => (
    recentChats.flatMap((chat) => (state.messageWindowsByChatId[chat.id]?.messages || []).slice(-3))
  )));

  useEffect(() => {
    markChatsWarm();
    markCharactersWarm();
    void prefetchChats();
    void prefetchCharacters();
  }, [markCharactersWarm, markChatsWarm, prefetchCharacters, prefetchChats]);

  useEffect(() => {
    const unsubscribe = avatarGenerationQueue.subscribeSummary(setAvatarQueueSummary);
    return () => { unsubscribe(); };
  }, []);

  useEffect(() => {
    const currentLoginIdentity = isLoggedIn ? String(user?.id || user?.email || 'authenticated') : null;
    if (previousLoginIdentityRef.current !== undefined && currentLoginIdentity && currentLoginIdentity !== previousLoginIdentityRef.current) {
      avatarGenerationQueue.dismissAllErrors();
      dismissAllCharacterCompletionErrors();
      dismissAllChatCompletionErrors();
      dismissAllRichMediaGenerationErrors();
      setSelectedGenerationError(null);
      setGenerationErrorsDialogOpen(false);
    }
    previousLoginIdentityRef.current = currentLoginIdentity;
  }, [isLoggedIn, user?.email, user?.id]);

  const generationErrors = useMemo<GenerationOverviewError[]>(() => [
    ...avatarQueueSummary.recentErrors.map((error) => ({ ...error, source: 'avatar' as const })),
    ...characterCompletionSummary.recentErrors.map((error) => ({ ...error, source: 'completion' as const })),
    ...chatCompletionSummary.recentErrors.map((error) => ({ ...error, source: 'chat-completion' as const })),
    ...getRecentRichMediaGenerationErrors().map((error) => ({ ...error, source: 'rich-media' as const })),
  ].sort((a, b) => b.createdAt - a.createdAt), [avatarQueueSummary.recentErrors, characterCompletionSummary.recentErrors, chatCompletionSummary.recentErrors, richMediaQueue]);
  const recentGenerationErrors = generationErrors.slice(0, 3);
  const dismissGenerationError = (error: GenerationOverviewError) => {
    if (error.source === 'avatar') avatarGenerationQueue.dismissError(error.id);
    else if (error.source === 'completion') dismissCharacterCompletionError(error.id);
    else if (error.source === 'chat-completion') dismissChatCompletionError(error.id);
    else dismissRichMediaGenerationError(error.id);
    if (selectedGenerationError?.source === error.source && selectedGenerationError.id === error.id) setSelectedGenerationError(null);
  };
  const clearGenerationErrors = () => {
    avatarGenerationQueue.dismissAllErrors();
    dismissAllCharacterCompletionErrors();
    dismissAllChatCompletionErrors();
    dismissAllRichMediaGenerationErrors();
    setSelectedGenerationError(null);
    setGenerationErrorsDialogOpen(false);
  };
  useEffect(() => {
    const unsubscribe = subscribeCharacterCompletionQueue(setCharacterCompletionSummary);
    return () => { unsubscribe(); };
  }, []);
  useEffect(() => { const unsubscribe = subscribeChatCompletionQueue(setChatCompletionSummary); return () => { unsubscribe(); }; }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setCalendarNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void mirrorLocalOutboxQueues({
      chatOperations: chatPendingOperations,
      characterOperations: characterPendingOperations,
      messageOperations: messagePendingOperations,
      artifactJobs,
    }).catch((error) => {
      console.warn('[local-outbox] failed to mirror home queues', error);
    });
  }, [artifactJobs, characterPendingOperations, chatPendingOperations, messagePendingOperations]);

  useEffect(() => {
    const update = () => {
      setCloudSyncEnabledState(isCloudSyncEnabled());
      setWorkerEntries(getRegisteredSyncWorkerEntries());
    };
    update();
    const timer = window.setInterval(update, 2500);
    window.addEventListener('pneumata-cloud-sync-preference-changed', update);
    window.addEventListener('pneumata-cloud-sync-bootstrap-lock-changed', update);
    window.addEventListener('online', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pneumata-cloud-sync-preference-changed', update);
      window.removeEventListener('pneumata-cloud-sync-bootstrap-lock-changed', update);
      window.removeEventListener('online', update);
    };
  }, []);

  const customCharacters = characters.filter((character) => !character.isPreset && !character.deletedAt);
  const recentCharacters = useMemo(() => {
    const recentChatActivityByMemberId = new Map<string, number>();
    recentChats.forEach((chat) => {
      const activityAt = Number(chat.lastMessageAt || chat.updatedAt || chat.createdAt || 0);
      chat.memberIds.forEach((memberId) => {
        recentChatActivityByMemberId.set(memberId, Math.max(recentChatActivityByMemberId.get(memberId) || 0, activityAt));
      });
    });
    return characters
      .filter((character) => !character.deletedAt)
      .slice()
      .sort((left, right) => (
        Math.max(Number(right.updatedAt || 0), recentChatActivityByMemberId.get(right.id) || 0)
        - Math.max(Number(left.updatedAt || 0), recentChatActivityByMemberId.get(left.id) || 0)
      ))
      .slice(0, 12);
  }, [characters, recentChats]);
  const recentCharactersRailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = recentCharactersRailRef.current;
    if (!rail) return undefined;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return;
      const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
      const atLeadingEdge = rail.scrollLeft <= 1;
      const atTrailingEdge = rail.scrollLeft >= maxScrollLeft - 1;
      if (!maxScrollLeft || (event.deltaY < 0 && atLeadingEdge) || (event.deltaY > 0 && atTrailingEdge)) return;
      event.preventDefault();
      rail.scrollLeft = Math.min(maxScrollLeft, Math.max(0, rail.scrollLeft + event.deltaY));
    };

    rail.addEventListener('wheel', handleWheel, { passive: false });
    return () => rail.removeEventListener('wheel', handleWheel);
  }, [recentCharacters.length]);
  const [noCharactersDialogOpen, setNoCharactersDialogOpen] = useState(false);
  const [noCharactersReturnTo, setNoCharactersReturnTo] = useState('/chats/create');
  const [noCharactersRequiredCount, setNoCharactersRequiredCount] = useState(MIN_MEMBERS);
  const totalDirectChats = chats.filter((chat) => chat.type === 'direct' || chat.type === 'ai_direct').length;
  const totalGroupChats = chats.filter((chat) => chat.type === 'group').length;
  const resolveChatListTab = (chat: typeof chats[number]) => chat.type === 'assistant' ? 3 : chat.type === 'group' ? 0 : chat.type === 'ai_direct' ? 2 : 1;
  const openChatFromHome = (chat: typeof chats[number]) => navigate(`/chats/${chat.id}?fromTab=${resolveChatListTab(chat)}`);
  const openCreateChatWithCharacterGuard = (path: string) => {
    const requiredCount = path.startsWith('/chats/create') ? MIN_MEMBERS : 1;
    if (customCharacters.length < requiredCount) {
      setNoCharactersReturnTo(path);
      setNoCharactersRequiredCount(requiredCount);
      setNoCharactersDialogOpen(true);
      return;
    }
    navigate(path);
  };
  const noCharactersDialogTitle = customCharacters.length === 0 ? '还没有AI角色' : 'AI角色不足';
  const noCharactersDialogMessage = noCharactersRequiredCount > 1
    ? customCharacters.length === 0
      ? `创建群聊至少需要 ${noCharactersRequiredCount} 个AI角色。可以先去角色库创建角色，或根据主题批量生成。`
      : `当前只有 ${customCharacters.length} 个AI角色，群聊至少需要 ${noCharactersRequiredCount} 个AI角色。请再创建 ${noCharactersRequiredCount - customCharacters.length} 个角色，或根据主题批量生成。`
    : '创建单聊前，需要先在角色库中创建至少一个AI角色。也可以根据主题或故事批量生成角色。';
  const recentChatsTitle = '最近会话';
  const homeChatDisplayMode = readPersistentUiValue('chat-list-style', { displayMode: 'card' }, (value): value is { displayMode: 'list' | 'card' } => Boolean(value && typeof value === 'object' && ((value as { displayMode?: unknown }).displayMode === 'list' || (value as { displayMode?: unknown }).displayMode === 'card'))).displayMode;
  const recentChatsActionTab = recentChats[0] ? resolveChatListTab(recentChats[0]) : 0;
  const needsAIModelSetup = !hasUsableDefaultTextAI(aiProfiles);
  const needsLogin = authMode === 'local' || !isLoggedIn;
  useEffect(() => {
    if (needsLogin) {
      setOfficialProviderAccess(null);
      return;
    }
    setOfficialProviderAccess(null);
    let cancelled = false;
    api.getOfficialAiProviders()
      .then((result) => {
        if (cancelled) return;
        setOfficialProviderAccess(Object.fromEntries((result.items || []).map((provider: OfficialAiProviderInfo) => {
          const publicProvider = String(provider.officialProvider || provider.code || '').toLowerCase();
          return [publicProvider, {
            key: publicProvider,
            publicProvider,
            label: provider.label || provider.name || 'AI点数',
            accessAllowed: provider.accessAllowed !== false,
          }];
        })));
      })
      .catch(() => {
        if (!cancelled) setOfficialProviderAccess(null);
      });
    return () => {
      cancelled = true;
    };
  }, [needsLogin]);
  const enabledOfficialBalanceProviders = useMemo(() => {
    if (!officialProviderAccess) return [];
    const providerKeys = new Set<OfficialBalanceProvider>();
    aiProfiles.forEach((profile) => {
      const normalized = normalizeOfficialBalanceProvider(profile.provider);
      if (!normalized) return;
      if (officialProviderAccess[normalized]?.accessAllowed === false) return;
      providerKeys.add(normalized);
    });
    return Array.from(providerKeys)
      .map((key) => officialProviderAccess[key])
      .filter((provider): provider is OfficialBalanceProviderInfo => Boolean(provider));
  }, [aiProfiles, officialProviderAccess]);
  const primaryOfficialBalanceProvider = enabledOfficialBalanceProviders[0] || null;
  const canQueryAiPoints = !needsLogin && Boolean(primaryOfficialBalanceProvider);
  const shouldReserveAiPointsCard = !needsLogin;
  const aiPointCardValue = primaryOfficialBalanceProvider && typeof aiPointBalance === 'number'
    ? formatAiAmount(aiPointBalance, primaryOfficialBalanceProvider.publicProvider, { compact: true })
    : aiPointBalance === null
      ? '未分配'
      : AI_POINT_PLACEHOLDER_VALUE;
  const needsNicknameSetup = !needsLogin && !String(user?.nickname || '').trim();
  const needsOwnCharacter = characters.length > 0 && customCharacters.length === 0;
  const hasActiveAvatarTasks = avatarQueueSummary.active > 0;
  const hasActiveCharacterCompletions = characterCompletionSummary.text.active > 0 || characterCompletionSummary.image.active > 0;
  const hasActiveChatCompletions = chatCompletionSummary.text.active > 0 || chatCompletionSummary.image.active > 0;
  const hasActiveImageCompletions = characterCompletionSummary.image.active > 0;
  const knownMessages = useMemo(() => [
    ...recentActiveMessages,
    ...recentWindowMessages,
  ], [recentActiveMessages, recentWindowMessages]);
  const recentKnownAiMessageCount = useMemo(() => {
    const keys = new Set<string>();
    const collect = (message: typeof knownMessages[number]) => {
      if (message.type !== 'ai' || message.isDeleted) return;
      keys.add(message.clientKey || message.serverId || message.id);
    };
    knownMessages.forEach(collect);
    return keys.size;
  }, [knownMessages]);
  const aiMessageCount = Math.max(usageStats?.aiMessageCount || 0, recentKnownAiMessageCount);
  const companionshipSettings = useSettingsStore((state) => state.companionship);
  const showCompanionshipStatusHints = shouldShowCompanionshipStatusHints(companionshipSettings);
  useEffect(() => {
    setCompanionshipSnapshot(null);
    if (!showCompanionshipStatusHints) {
      return undefined;
    }
    let cancelled = false;
    const now = Date.now();
    const buildSnapshot = () => {
      void (async () => {
        const { buildHomeCompanionshipSnapshot } = await import('../services/companionshipProjection');
        if (cancelled) return;
        const snapshot = buildHomeCompanionshipSnapshot({
          chats: recentChats,
          characters,
          messages: knownMessages,
          now,
        });
        const { companionshipGenerationKey, readGeneratedHomeCompanionship, readLatestHomeCompanionshipSnapshot, generateHomeCompanionship } = await import('../services/homeCompanionshipGeneration');
        if (cancelled) return;
        if (!snapshot) {
          const saved = readLatestHomeCompanionshipSnapshot({ chats: recentChats, characters, now });
          setCompanionshipSnapshot(saved);
          return;
        }
        const character = characters.find((item) => item.id === snapshot.characterId);
        const chat = recentChats.find((item) => item.id === snapshot.chatId);
        if (!character || !chat) return;
        const inputKey = companionshipGenerationKey(snapshot, character);
        const cached = readGeneratedHomeCompanionship(chat, inputKey, now);
        if (cached) { setCompanionshipSnapshot({ ...snapshot, text: cached }); return; }
        const config = getUsableDefaultTextAIProfile(aiProfiles);
        if (!config) return;
        const scope = getLocalDataUserId();
        const event = await generateHomeCompanionship({ snapshot, character, config, scope: String(scope) });
        // Leaving Home cancels UI updates, but completed content still belongs
        // in this account's conversation so it can be read on return.
        if (getLocalDataUserId() !== scope) return;
        const currentChat = useChatStore.getState().chats.find((item) => item.id === chat.id);
        if (!currentChat || currentChat.deletedAt != null) return;
        const text = (event.payload as Record<string, unknown>).text;
        if (typeof text !== 'string') throw new Error('陪伴信息缺少正文');
        await useChatStore.getState().applyChatRuntimeDelta(chat.id, {
          runtimeEventsV2: {
            orderedIds: [...(currentChat.runtimeEventsV2 || []).map((item) => item.id), event.id],
            upserts: [event],
          },
        });
        if (cancelled) return;
        setCompanionshipSnapshot({ ...snapshot, text });
      })().catch((error: unknown) => {
        console.error('[home-companionship] generation failed', error);
      });
    };
    const scheduler = (window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    }).requestIdleCallback;
    const idleHandle = typeof scheduler === 'function' ? scheduler(buildSnapshot, { timeout: 1800 }) : null;
    const timeoutHandle = idleHandle == null ? window.setTimeout(buildSnapshot, 900) : null;
    return () => {
      cancelled = true;
      if (idleHandle != null) window.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle != null) window.clearTimeout(timeoutHandle);
    };
  }, [aiProfiles, characters, knownMessages, recentChats, showCompanionshipStatusHints]);
  const syncOverview = useMemo(() => buildHomeSyncOverview({
    cloudSyncAvailable: !needsLogin,
    cloudSyncEnabled,
    operations: buildLocalOutboxProjection({
      chatOperations: chatPendingOperations,
      characterOperations: characterPendingOperations,
      messageOperations: messagePendingOperations,
      artifactJobs,
    }),
    artifactJobs: [],
    syncScopes: [
      ...getCharacterSyncScopeStates(),
      ...getChatSyncScopeStates(),
      ...getMessageSyncScopeStates(),
      ...artifactSyncScopes,
      ...getSettingsSyncScopeStates(),
    ],
    workerEntries,
  }), [
    artifactJobs,
    characterPendingOperations,
    chatPendingOperations,
    cloudSyncEnabled,
    artifactSyncScopes,
    getCharacterSyncScopeStates,
    getChatSyncScopeStates,
    getMessageSyncScopeStates,
    getSettingsSyncScopeStates,
    messagePendingOperations,
    needsLogin,
    workerEntries,
  ]);
  const syncUploadingCount = syncOverview.uploading + syncOverview.pendingUpload;
  const syncDownloadingCount = syncOverview.checkingDownloads + syncOverview.pendingDownload;
  const syncExceptionCount = syncOverview.failedUpload + syncOverview.failedScopes + syncOverview.backoffScopes;
  const ongoingActivities = useMemo(() => projectWorldCalendar(chats, characters, { now: calendarNow }).items
    .filter((item) => item.status === 'in_progress')
    .sort((left, right) => (left.endAt || Number.MAX_SAFE_INTEGER) - (right.endAt || Number.MAX_SAFE_INTEGER))
    .slice(0, 4), [calendarNow, characters, chats]);
  const pinnedAnnouncements = useMemo(() => inAppNotifications.filter((item) => item.pinnedEnabled).slice(0, 3), [inAppNotifications]);
  useEffect(() => {
    if (!canQueryAiPoints || !primaryOfficialBalanceProvider) {
      setAiPointBalance(undefined);
      return;
    }
    let cancelled = false;
    setAiPointBalance(undefined);
    const loadBalances = () => {
      api.getAiBalance(primaryOfficialBalanceProvider.publicProvider)
        .then((balance) => {
          const raw = balance.availableBalance ?? balance.available_balance;
          if (!cancelled) setAiPointBalance(typeof raw === 'number' && Number.isFinite(raw) ? raw : null);
        })
        .catch(() => {
          if (!cancelled) setAiPointBalance(null);
        });
    };
    const scheduler = (window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    }).requestIdleCallback;
    const idleHandle = typeof scheduler === 'function' ? scheduler(loadBalances, { timeout: 2400 }) : null;
    const timeoutHandle = idleHandle == null ? window.setTimeout(loadBalances, 1200) : null;
    return () => {
      cancelled = true;
      if (idleHandle != null) window.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle != null) window.clearTimeout(timeoutHandle);
    };
  }, [canQueryAiPoints, primaryOfficialBalanceProvider]);

  const syncStatusStats: HomeOverviewCard[] = (!needsLogin && cloudSyncEnabled) ? [
    ...(syncUploadingCount > 0 ? [{
      label: syncOverview.uploading > 0 ? `${syncOverview.uploading} 正在上传` : '等待上传',
      value: syncUploadingCount,
      icon: <CloudUploadIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/account/sync-status'),
      attention: syncOverview.uploading > 0,
    }] : []),
    ...(syncDownloadingCount > 0 ? [{
      label: syncOverview.checkingDownloads > 0 ? `${syncOverview.checkingDownloads} 正在下载` : '等待下载',
      value: syncDownloadingCount,
      icon: <CloudDownloadIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/account/sync-status'),
      attention: syncOverview.checkingDownloads > 0,
    }] : []),
    ...(syncExceptionCount > 0 ? [{
      label: '未读同步异常',
      value: syncExceptionCount,
      icon: <SyncProblemIcon />,
      color: 'warning.main',
      onOpen: () => navigate('/account/sync-status'),
      attention: true,
    }] : []),
  ].slice(0, 3) : [];

  const attentionStats: HomeOverviewCard[] = [
    ...(needsLogin ? [{
      label: t('nav.signInSync'),
      value: t('nav.localMode'),
      icon: <PersonIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/login'),
      attention: true,
    }] : []),
    ...(needsAIModelSetup ? [{
      label: '默认文本模型',
      value: '待设置',
      icon: <SettingsSuggestIcon />,
      color: 'primary.main',
      onOpen: () => navigate(buildSettingsPath({ tab: 'models', card: 'models' })),
      attention: true,
    }] : []),
    ...(developerMode ? [{
      label: '开发者模式',
      value: '已开启',
      icon: <DeveloperModeIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/settings'),
      attention: true,
    }] : []),
    ...(needsOwnCharacter ? [{
      label: '自定义角色',
      value: '暂无',
      icon: <PersonIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/characters'),
      attention: true,
    }] : []),
    ...(hasActiveAvatarTasks && !hasActiveImageCompletions ? [{
      label: avatarQueueSummary.running > 0
        ? `正在生成：${avatarQueueSummary.current || '头像'}，队列 ${avatarQueueSummary.queued}`
        : '头像等待生成',
      value: avatarQueueSummary.active,
      icon: <AutoAwesomeIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/characters'),
      attention: true,
    }] : []),
    ...(hasActiveCharacterCompletions ? [{
      label: '角色补全中',
      value: `${characterCompletionSummary.text.completed + characterCompletionSummary.image.completed}/${characterCompletionSummary.text.total + characterCompletionSummary.image.total}`
        + (characterCompletionSummary.text.failed + characterCompletionSummary.image.failed > 0
          ? ` · 失败 ${characterCompletionSummary.text.failed + characterCompletionSummary.image.failed}`
          : '')
        + (characterCompletionSummary.text.warnings + characterCompletionSummary.image.warnings > 0
          ? ` · 降级 ${characterCompletionSummary.text.warnings + characterCompletionSummary.image.warnings}`
          : ''),
      icon: <AutoAwesomeIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/characters'),
      attention: true,
    }] : []),
    ...(hasActiveChatCompletions ? [{
      label: `正在处理：${chatCompletionSummary.image.current || chatCompletionSummary.text.current || '群聊视觉'}`,
      value: `${chatCompletionSummary.text.completed + chatCompletionSummary.image.completed}/${chatCompletionSummary.text.total + chatCompletionSummary.image.total}`
        + (chatCompletionSummary.text.failed + chatCompletionSummary.image.failed > 0 ? ` · 失败 ${chatCompletionSummary.text.failed + chatCompletionSummary.image.failed}` : ''),
      icon: <AutoAwesomeIcon />, color: 'primary.main', onOpen: () => navigate('/chats'), attention: true,
    }] : []),
    ...(hasActiveImageCompletions ? [{
      label: `正在生成：${characterCompletionSummary.image.current || avatarQueueSummary.current || '图片'}`,
      value: `${characterCompletionSummary.image.completed}/${characterCompletionSummary.image.total}`
        + (characterCompletionSummary.image.failed > 0 ? ` · 失败 ${characterCompletionSummary.image.failed}` : '')
        + (characterCompletionSummary.image.warnings > 0 ? ` · 基础模板 ${characterCompletionSummary.image.warnings}` : ''),
      icon: <AutoAwesomeIcon />,
      color: 'secondary.main',
      onOpen: () => navigate('/characters'),
      attention: true,
    }] : []),
    ...(richMediaQueue.length ? [{
      label: richMediaQueue[0]?.kind === 'audio' ? '正在生成语音' : '正在生成图片',
      value: richMediaQueue.length > 1 ? `${richMediaQueue[0]?.position || 1}/${richMediaQueue[0]?.total || richMediaQueue.length}` : 1,
      icon: <AutoAwesomeIcon />,
      color: richMediaQueue[0]?.kind === 'audio' ? 'primary.main' : 'secondary.main',
      onOpen: () => navigate('/chats'),
      attention: true,
    }] : []),
    ...(activeDiaryJobs > 0 ? [{
      label: '生成日记',
      value: activeDiaryJobs,
      icon: <MenuBookIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/letters?tab=diary'),
      attention: true,
    }] : []),
  ];

  const stats: HomeOverviewCard[] = [
    ...attentionStats,
    ...(needsNicknameSetup ? [{
      label: '未设置用户昵称',
      value: '待设置',
      icon: <PersonIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/account'),
      attention: true,
    }] : []),
    {
      label: t('home.totalCharacters'),
      value: customCharacters.length,
      icon: <PersonIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/characters'),
      onCreate: () => navigate('/characters/create'),
      createLabel: t('character.create'),
    },
    {
      label: t('home.totalChats'),
      value: totalGroupChats,
      icon: <ChatIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/chats?tab=0'),
      onCreate: () => openCreateChatWithCharacterGuard('/chats/create'),
      createLabel: t('chat.create'),
    },
    {
      label: '单聊数量',
      value: totalDirectChats,
      icon: <ChatIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/chats?tab=1'),
      onCreate: () => openCreateChatWithCharacterGuard('/direct/create'),
      createLabel: '创建单聊',
    },
    {
      label: '角色消息',
      value: aiMessageCount,
      icon: <ChatIcon />,
      color: 'primary.main',
      onOpen: () => navigate('/chats?tab=0'),
    },
    ...(shouldReserveAiPointsCard ? [{
        label: 'AI点数',
        value: aiPointCardValue,
        icon: <AutoAwesomeIcon />,
        color: 'primary.main',
        onOpen: () => navigate(buildSettingsPath({ tab: 'models', card: 'models' })),
      }] : []),
    ...syncStatusStats,
  ];

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: { xs: 2.5, sm: 3, md: 3.5 }, pt: { xs: 1, sm: 1, md: 3 }, pb: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 82px)', sm: 3, md: 3.5 } }}>
      <PageSection spacing={3}>
        {pinnedAnnouncements.length ? (
          <Box sx={{ display: 'grid', gap: 1 }}>
            {pinnedAnnouncements.map((item) => (
              <Alert
                key={item.id}
                severity={notificationAlertSeverity(item.severity)}
                sx={{
                  alignItems: 'flex-start',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  '& .MuiAlert-message': { minWidth: 0, width: '100%' },
                }}
              >
                <Box sx={{ display: 'grid', gap: 0.35, minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 800, overflowWrap: 'anywhere' }}>{item.title}</Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.body}</Typography>
                  <Typography variant="caption" color="text.secondary">生效时间：{formatInAppNotificationWindow(item)}</Typography>
                </Box>
              </Alert>
            ))}
          </Box>
        ) : null}

        <SurfaceCard>
          <SectionHeader title="工作台概览" />
          <Box sx={buildStatGridSx()}>
            {stats.map((stat) => (
              <Box key={stat.label} sx={buildStatCellSx()}>
                <SurfaceCard
                  sx={stat.attention ? buildAttentionCardSx() : buildStatCardSx()}
                  contentSx={buildStatContentSx()}
                >
                  <CardActionArea
                    component="div"
                    role="button"
                    tabIndex={0}
                    aria-label={`${stat.label}快捷入口`}
                    onClick={stat.onOpen}
                    sx={{
                      width: '100%',
                      minHeight: 'inherit',
                      height: '100%',
                      position: 'relative',
                      borderRadius: 'inherit',
                      // 加号故意越出卡片边缘；仅把水波纹自身裁切在卡片内部。
                      overflow: 'visible',
                      '& .MuiTouchRipple-root': { borderRadius: 'inherit', overflow: 'hidden' },
                    }}
                  >
                    {stat.onCreate ? (
                      <IconButton
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          stat.onCreate?.();
                        }}
                        aria-label={stat.createLabel}
                        sx={buildCreateButtonSx()}
                      >
                        <AddIcon fontSize="small" />
                      </IconButton>
                    ) : null}
                    <Box sx={buildStatCenterSx()}>
                      <Box sx={buildStatIconSx(stat.color)}>{stat.icon}</Box>
                      <Typography variant="h5" sx={buildStatValueSx()}>{stat.value}</Typography>
                      <Typography variant="body2" sx={buildStatLabelSx()}><span>{stat.label}</span></Typography>
                    </Box>
                  </CardActionArea>
                </SurfaceCard>
              </Box>
            ))}
          </Box>
          {recentGenerationErrors.length ? (
            <Box sx={{ mt: 2, pt: 1.75, borderTop: '1px solid', borderColor: 'divider', display: 'grid', gap: 0.8 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 760 }}>最近生成错误</Typography>
                {generationErrors.length > 3 ? <Button size="small" onClick={() => setGenerationErrorsDialogOpen(true)}>查看全部</Button> : null}
              </Box>
              {recentGenerationErrors.map((error) => (
                <Box
                  key={`${error.source}:${error.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedGenerationError(error)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedGenerationError(error); } }}
                  sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: 1.1, py: 0.9, border: '1px solid', borderColor: 'error.main', borderRadius: 1, bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(211,47,47,0.045)' : 'rgba(255,112,112,0.08)', cursor: 'pointer', '&:hover': { bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(211,47,47,0.075)' : 'rgba(255,112,112,0.12)' } }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="caption" color="error.main" sx={{ display: 'block', fontWeight: 720, mb: 0.2 }}>{error.title}</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: { xs: 3, md: 1 }, overflowWrap: 'anywhere' }}>{error.message}</Typography>
                  </Box>
                  <IconButton size="small" aria-label="关闭此错误提示" onClick={(event) => { event.stopPropagation(); dismissGenerationError(error); }} sx={{ mt: -0.35, mr: -0.35 }}><CloseIcon fontSize="small" /></IconButton>
                </Box>
              ))}
            </Box>
          ) : null}
        </SurfaceCard>

        <Dialog open={Boolean(selectedGenerationError)} onClose={() => setSelectedGenerationError(null)} fullWidth maxWidth="sm">
          <DialogTitle sx={{ pr: 6 }}>{selectedGenerationError?.title || '生成错误'}<IconButton aria-label="关闭" onClick={() => setSelectedGenerationError(null)} sx={{ position: 'absolute', right: 12, top: 12 }}><CloseIcon /></IconButton></DialogTitle>
          <DialogContent dividers><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selectedGenerationError?.message}</Typography></DialogContent>
          <DialogActions>
            <Button startIcon={<DeleteSweepIcon />} onClick={() => { if (selectedGenerationError) dismissGenerationError(selectedGenerationError); }}>清除此条</Button>
          </DialogActions>
        </Dialog>

        <Dialog open={generationErrorsDialogOpen} onClose={() => setGenerationErrorsDialogOpen(false)} fullWidth maxWidth="md">
          <DialogTitle>全部生成错误</DialogTitle>
          <DialogContent dividers sx={{ minHeight: 0, overflowY: 'auto' }}>
            <Box sx={{ display: 'grid', gap: 1 }}>
              {generationErrors.map((error) => (
                <SurfaceCard key={`${error.source}:${error.id}`} sx={{ borderColor: 'error.main', bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(211,47,47,0.035)' : 'rgba(255,112,112,0.06)' }} contentSx={{ p: 1.35 }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="subtitle2" color="error.main" sx={{ fontWeight: 760 }}>{error.title}</Typography><Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error.message}</Typography></Box>
                    <IconButton size="small" aria-label="关闭此错误提示" onClick={() => dismissGenerationError(error)}><CloseIcon fontSize="small" /></IconButton>
                  </Box>
                </SurfaceCard>
              ))}
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setGenerationErrorsDialogOpen(false)}>关闭</Button>
            <Button startIcon={<DeleteSweepIcon />} disabled={!generationErrors.length} onClick={clearGenerationErrors}>清除全部</Button>
          </DialogActions>
        </Dialog>

        <HomeCommandLauncher />

        {ongoingActivities.length ? (
          <SurfaceCard>
            <SectionHeader
              title="正在进行的活动"
              action={<Button size="small" variant="outlined" onClick={() => navigate('/calendar')}>打开日历</Button>}
            />
            <Box sx={{ display: 'grid', gap: 1.25, mt: 1 }}>
              {ongoingActivities.map((item) => {
                const sourceRef = item.sourceRefs[0];
                return (
                  <Box
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate('/calendar')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') navigate('/calendar');
                    }}
                    sx={buildOngoingActivityRowSx()}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, mb: 0.75 }}>
                        <Box sx={buildStatIconSx('primary.main')}>
                          <EventAvailableIcon fontSize="small" />
                        </Box>
                        <Typography variant="subtitle2" sx={{ fontWeight: 780, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.title}
                        </Typography>
                        <Chip size="small" color="primary" label="进行中" sx={{ height: 22, borderRadius: 999, flexShrink: 0 }} />
                      </Box>
                      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
                        {[
                          formatOngoingActivityWindow(item),
                          item.locationHint ? `地点 ${item.locationHint}` : '',
                          sourceRef?.conversationName ? `来自 ${sourceRef.conversationName}` : '',
                        ].filter(Boolean).join(' · ')}
                      </Typography>
                      {item.participantNames.length ? (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.participantNames.join('、')}
                        </Typography>
                      ) : null}
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: { xs: 'flex-start', sm: 'flex-end' }, alignItems: 'center' }}>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={formatOngoingActivityProgress(item, calendarNow)}
                        sx={{ height: 26, borderRadius: 999, maxWidth: '100%' }}
                      />
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </SurfaceCard>
        ) : null}

        {recentCharacters.length ? (
          <SurfaceCard>
            <SectionHeader title="最近角色" action={<Button size="small" variant="outlined" onClick={() => navigate('/characters')}>查看全部</Button>} />
            <Box
              ref={recentCharactersRailRef}
              sx={{
                display: 'flex',
                gap: 1,
                mt: 1.25,
                overflowX: 'auto',
                overflowY: 'hidden',
                pb: 0.5,
                mx: { xs: -0.25, sm: 0 },
                px: { xs: 0.25, sm: 0 },
                scrollSnapType: 'x proximity',
                scrollbarWidth: 'thin',
                overscrollBehaviorX: 'contain',
                '&::-webkit-scrollbar': { height: 6 },
                '&::-webkit-scrollbar-thumb': { borderRadius: 999, bgcolor: 'action.disabledBackground' },
              }}
            >
              {recentCharacters.map((character) => (
                <ButtonBase
                  key={character.id}
                  component="div"
                  role="button"
                  tabIndex={0}
                  aria-label={`编辑角色${character.name}`}
                  onClick={() => navigate(`/characters/${character.id}/edit?returnTo=${encodeURIComponent('/')}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      navigate(`/characters/${character.id}/edit?returnTo=${encodeURIComponent('/')}`);
                    }
                  }}
                  sx={{
                    flex: '0 0 86px',
                    minWidth: 0,
                    display: 'grid',
                    justifyItems: 'center',
                    gap: 0.65,
                    px: 0.45,
                    py: 0.25,
                    borderRadius: 2,
                    cursor: 'pointer',
                    scrollSnapAlign: 'start',
                    position: 'relative',
                    overflow: 'hidden',
                    transition: transition(['background-color'], motion.durations.base, motion.softOut),
                    '&::after': {
                      content: '""',
                      position: 'absolute',
                      left: 20,
                      right: 20,
                      bottom: 0,
                      height: 1.5,
                      borderRadius: 999,
                      bgcolor: 'primary.main',
                      opacity: 0,
                      transform: 'scaleX(0.45)',
                      transition: transition(['opacity', 'transform'], motion.durations.base, motion.softOut),
                    },
                    ...buildCardAvatarHoverMotionSx('.home-recent-character-avatar-motion'),
                    '&:hover': {
                      bgcolor: 'action.hover',
                      '&::after': { opacity: 0.72, transform: 'scaleX(1)' },
                    },
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
                  }}
                >
                  <Box className="home-recent-character-avatar-motion" sx={{ display: 'flex', borderRadius: '50%' }}>
                    <Avatar
                      src={isImageAvatar(character.avatar) ? character.avatar : undefined}
                      slotProps={{ img: { loading: 'lazy' } }}
                      sx={{ width: 54, height: 54, bgcolor: 'primary.light', fontSize: '1.15rem' }}
                    >
                      {isImageAvatar(character.avatar) ? undefined : (character.avatar?.trim() || character.name.slice(0, 1))}
                    </Avatar>
                  </Box>
                  <Typography variant="caption" noWrap sx={{ width: '100%', textAlign: 'center', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {character.name}
                  </Typography>
                  {character.group ? (
                    <Typography variant="caption" noWrap color="text.secondary" sx={{ width: '100%', mt: -0.55, textAlign: 'center', fontSize: '0.68rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {character.group}
                    </Typography>
                  ) : null}
                </ButtonBase>
              ))}
            </Box>
          </SurfaceCard>
        ) : null}

        <SurfaceCard>
          <SectionHeader title={recentChatsTitle} action={<Button size="small" variant="outlined" onClick={() => navigate(`/chats?tab=${recentChatsActionTab}`)}>查看全部</Button>} />
          {companionshipSnapshot?.text ? (
            <Box
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/chats/${companionshipSnapshot.chatId}?fromTab=1`)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') navigate(`/chats/${companionshipSnapshot.chatId}?fromTab=1`);
              }}
              sx={{
                mb: 1.5,
                px: 1.5,
                py: 1.25,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.045)' : 'rgba(120,156,220,0.075)',
                cursor: 'pointer',
                transition: transition(['border-color', 'background-color'], motion.durations.base, motion.gentleSpring),
                '&:hover': {
                  borderColor: 'primary.main',
                  bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.075)' : 'rgba(120,156,220,0.11)',
                },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Chip size="small" label={companionshipSnapshot.characterName} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                <Typography variant="caption" color="text.secondary">回来以后</Typography>
              </Box>
              <Typography variant="body2" color="text.primary" sx={{ lineHeight: 1.55 }}>
                {companionshipSnapshot.text}
              </Typography>
            </Box>
          ) : null}
          {recentChats.length === 0 ? (
            <EmptyState
              icon="🍵"
              message={t('home.noChats')}
              action={<Button variant="outlined" onClick={() => openCreateChatWithCharacterGuard('/chats/create')}>{t('chat.create')}</Button>}
            />
          ) : (
            <Box sx={homeChatDisplayMode === 'list' ? { display: 'grid', gridTemplateColumns: '1fr', gap: 0 } : buildGridSx()}>
              {recentChats.map((chat, index) => (
                <ChatCard
                  key={chat.id}
                  chat={chat}
                  characters={characters}
                  displayMode={homeChatDisplayMode as 'list' | 'card'}
                  compactCard={homeChatDisplayMode === 'card'}
                  showListDivider={homeChatDisplayMode === 'list' && index < recentChats.length - 1}
                  onClick={() => openChatFromHome(chat)}
                  onAvatarClick={chat.type === 'group'
                    ? () => navigate(`/chats/${chat.id}/edit`)
                    : chat.memberIds[0]
                      ? (memberId) => navigate(`/characters/${memberId || chat.memberIds[0]}/edit?returnTo=${encodeURIComponent('/')}`)
                      : undefined}
                />
              ))}
            </Box>
          )}
        </SurfaceCard>

      </PageSection>
      <NoCharactersDialog
        open={noCharactersDialogOpen}
        onClose={() => setNoCharactersDialogOpen(false)}
        returnTo={noCharactersReturnTo}
        title={noCharactersDialogTitle}
        message={noCharactersDialogMessage}
      />
    </Box>
  );
}
