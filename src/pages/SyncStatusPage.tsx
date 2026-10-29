import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { Alert, Box, Button, ButtonGroup, Card, CardContent, Chip, Divider, IconButton, Menu, MenuItem, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useChatStore } from '../stores/useChatStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useMessageStore } from '../stores/useMessageStore';
import { ARTIFACT_CLOUD_SYNC_CHANGED_EVENT, ensureCharacterArtifactStoreHydrated, useCharacterArtifactStore } from '../stores/useCharacterArtifactStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import EmptyState from '../components/common/EmptyState';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { readCloudSyncBootstrapStatus, type CloudSyncBootstrapStatus } from '../services/cloudSyncBootstrapStatus';
import { scheduleSyncWorkersByPriority } from '../stores/storeSyncScheduler';
import { buildOperationsDiffPreview, buildPatchDiffPreview } from '../services/syncDiffPreview';
import type { SyncScopeSnapshot } from '../stores/syncScopeMetadata';
import { clearPersistenceFailures, PERSISTENCE_HEALTH_EVENT, readPersistenceHealth } from '../services/persistenceHealth';
import { buildLocalRecoverySnapshot } from '../services/localRecoveryExport';
import { importLocalRecoverySnapshot, type LocalRecoveryImportResult } from '../services/localRecoveryImport';
import { runLocalPersistenceMaintenance, type LocalPersistenceMaintenanceResult } from '../services/localPersistenceMaintenance';
import { classifySyncError, parseSyncErrorClassification, type SyncErrorKind } from '../stores/storeSyncHelpers';
import { buildLocalOutboxProjection } from '../services/localOutboxProjection';
import { mirrorLocalOutboxQueues } from '../services/localOutboxMirror';
import { clearLocalOutboxHistory, listLocalOutboxHistory, LOCAL_OUTBOX_HISTORY_CHANGED_EVENT, type LocalOutboxHistoryEntry } from '../services/localOutboxWorkerBridge';
import type { Message } from '../types/message';
import { hasUsableDefaultTextAI } from '../types/settings';
import { isCloudSyncEnabled } from '../services/cloudSyncPreference';
import { api, type CharacterArtifactSummaryEntry } from '../services/api';

function clipText(value: unknown, max = 120) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function taskTargetLabel(item: { targetLabel?: string; payload?: unknown; createdAt: number }, currentName: string | undefined, isZh: boolean) {
  const payload = item.payload && typeof item.payload === 'object' ? item.payload as Record<string, unknown> : null;
  const patch = payload?.patch && typeof payload.patch === 'object' ? payload.patch as Record<string, unknown> : null;
  return currentName || item.targetLabel
    || (typeof payload?.targetLabel === 'string' ? payload.targetLabel : '')
    || (typeof patch?.name === 'string' ? patch.name : '')
    || (isZh ? `名称未记录 · ${formatTime(item.createdAt, true)}` : `Name unavailable · ${formatTime(item.createdAt, false)}`);
}

function displayConflictField(field: string, isZh: boolean) {
  const names: Record<string, [string, string]> = {
    runtimeEventsV2: ['会话事件', 'Conversation events'],
    name: ['名称', 'Name'],
    topic: ['话题', 'Topic'],
    memberIds: ['参与角色', 'Participants'],
  };
  return names[field]?.[isZh ? 0 : 1] || (isZh ? '内容' : 'Content');
}

function describeConflictValue(value: unknown, isZh: boolean) {
  if (Array.isArray(value)) return isZh ? `${value.length} 项` : `${value.length} items`;
  if (value && typeof value === 'object') return isZh ? '有内容' : 'Has content';
  return clipText(value, 48) || (isZh ? '空' : 'Empty');
}

function summarizePatch(patch: Record<string, unknown> | undefined, isZh: boolean) {
  const keys = Object.keys(patch || {}).filter((key) => key !== 'updatedAt');
  if (!keys.length) return isZh ? '本地操作没有可展示的字段变更' : 'No displayable field changes in this local operation';
  return isZh ? `本地有 ${keys.length} 项内容等待同步` : `${keys.length} local changes waiting to sync`;
}

function rememberMessageSnapshot(index: Map<string, Message>, message: Message | undefined | null) {
  if (!message) return;
  index.set(message.id, message);
  if (message.clientKey) index.set(message.clientKey, message);
  if (message.serverId) index.set(message.serverId, message);
}

function downloadJson(filename: string, data: unknown) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatTime(value: number, isZh: boolean) {
  if (!value) return isZh ? '未记录' : 'Not recorded';
  return new Date(value).toLocaleString();
}

function TaskTime({ value, isZh }: { value: number; isZh: boolean }) {
  const date = new Date(value);
  return (
    <Tooltip title={formatTime(value, isZh)}>
      <Typography component="time" dateTime={value ? date.toISOString() : undefined} variant="caption"
        sx={{ color: 'text.disabled', whiteSpace: 'nowrap', textAlign: 'right', fontVariantNumeric: 'tabular-nums', pt: 0.25 }}>
        {value ? date.toLocaleString(isZh ? 'zh-CN' : 'en-US', {
          ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }) : formatTime(value, isZh)}
      </Typography>
    </Tooltip>
  );
}

function summarizeSyncScopeState(state: SyncScopeSnapshot, isZh: boolean) {
  const now = Date.now();
  if (state.inflight) return { label: isZh ? '检查中' : 'Checking', color: 'primary' as const };
  if (state.retryAt > now) return { label: isZh ? '退避中' : 'Backoff', color: 'warning' as const };
  if (state.lastError) return { label: isZh ? '异常' : 'Issue', color: 'error' as const };
  if (state.lastCheckedAt > 0) return { label: isZh ? '已检查' : 'Checked', color: 'success' as const };
  return { label: isZh ? '未检查' : 'Unchecked', color: 'default' as const };
}

function syncErrorKindLabel(kind: SyncErrorKind, isZh: boolean) {
  const labels: Record<SyncErrorKind, string> = {
    auth: isZh ? '鉴权' : 'Auth',
    network: isZh ? '网络' : 'Network',
    server_unavailable: isZh ? '服务端' : 'Server',
    conflict_ignored: isZh ? '冲突忽略' : 'Conflict ignored',
    validation: isZh ? '校验失败' : 'Validation failed',
    unknown: isZh ? '未知' : 'Unknown',
  };
  return labels[kind];
}

function resolveDisplayErrorClassification(raw: string | null | undefined) {
  const initial = parseSyncErrorClassification(raw);
  if (initial.kind !== 'unknown' || !initial.message) return initial;
  return parseSyncErrorClassification(classifySyncError(initial.message));
}

function isUnavailableChatError(raw: string | null | undefined) {
  const classification = parseSyncErrorClassification(raw);
  return classification.kind === 'conflict_ignored'
    && /(?:群聊|聊天|会话)不存在|404|not found/i.test(classification.message);
}

type SyncStatusFilterKey =
  | 'all'
  | 'queued'
  | 'syncing'
  | 'failed'
  | 'conflict'
  | 'history'
  | 'checking'
  | 'backoff'
  | 'scope_issue'
  | 'checked'
  | `error_kind:${SyncErrorKind}`;

function matchesScopeFilter(state: SyncScopeSnapshot, filter: SyncStatusFilterKey) {
  if (filter === 'all') return true;
  if (filter === 'checking') return state.inflight;
  if (filter === 'backoff') return !state.inflight && state.retryAt > Date.now();
  if (filter === 'scope_issue') return !state.inflight && !(state.retryAt > Date.now()) && Boolean(state.lastError);
  if (filter === 'checked') return !state.inflight && !(state.retryAt > Date.now()) && !state.lastError && state.lastCheckedAt > 0;
  if (filter.startsWith('error_kind:')) {
    return state.lastError ? resolveDisplayErrorClassification(state.lastError).kind === filter.slice('error_kind:'.length) : false;
  }
  return false;
}

function matchesQueueItemFilter(item: { status: string; lastError: string | null }, filter: SyncStatusFilterKey) {
  if (filter === 'all') return true;
  if (filter === 'queued') return item.status === 'pending';
  if (filter === 'syncing') return item.status === 'syncing';
  if (filter === 'failed') return item.status === 'failed';
  if (filter === 'conflict') return item.status === 'conflict';
  if (filter.startsWith('error_kind:')) {
    return item.lastError ? resolveDisplayErrorClassification(item.lastError).kind === filter.slice('error_kind:'.length) : false;
  }
  return false;
}

function isQueueFilter(filter: SyncStatusFilterKey) {
  return filter === 'all' || filter === 'queued' || filter === 'syncing' || filter === 'failed' || filter === 'conflict' || filter.startsWith('error_kind:');
}

function isScopeFilter(filter: SyncStatusFilterKey) {
  return filter === 'all' || filter === 'checking' || filter === 'backoff' || filter === 'scope_issue' || filter === 'checked' || filter.startsWith('error_kind:');
}

function countForFilter(items: { status: string; lastError: string | null }[], scopes: SyncScopeSnapshot[], filter: SyncStatusFilterKey) {
  const queueCount = items.filter((item) => matchesQueueItemFilter(item, filter)).length;
  const scopeCount = scopes.filter((scope) => matchesScopeFilter(scope, filter)).length;
  if (filter === 'queued' || filter === 'syncing' || filter === 'failed' || filter === 'conflict') return queueCount;
  if (filter === 'checking' || filter === 'backoff' || filter === 'scope_issue' || filter === 'checked') return scopeCount;
  return queueCount + scopeCount;
}

function taskStatusLabel(scopeType: string, status: string, isZh: boolean, fallback: string) {
  if (scopeType !== 'artifact') return fallback;
  const labels: Record<string, [string, string]> = {
    pending: ['待生成', 'Waiting to generate'],
    syncing: ['生成中', 'Generating'],
    failed: ['生成失败', 'Generation failed'],
    succeeded: ['生成完成', 'Generated'],
  };
  return labels[status]?.[isZh ? 0 : 1] || fallback;
}

function artifactCloudStatus(
  record: LocalOutboxHistoryEntry,
  localUpdatedAt: number | undefined,
  remote: CharacterArtifactSummaryEntry | undefined,
  summariesAvailable: boolean,
  loading: boolean,
  cloudEnabled: boolean,
  isZh: boolean,
) {
  if (!record.resultId) return isZh ? '云端状态未记录' : 'Cloud status was not recorded';
  if (!cloudEnabled) return isZh ? '仅保存在本机' : 'Saved on this device';
  if (loading || !summariesAvailable) return isZh ? '正在核对云端' : 'Checking cloud';
  if (!remote) return localUpdatedAt
    ? (isZh ? '云端尚无此内容' : 'Not yet in cloud')
    : (isZh ? '本机与云端均无此内容' : 'Not found on this device or in cloud');
  if (remote.deletedAt != null) return isZh ? '云端已删除' : 'Deleted in cloud';
  if (localUpdatedAt && remote.updatedAt < localUpdatedAt) return isZh ? '本地版本较新，待同步' : 'Newer local version pending sync';
  if (!localUpdatedAt) return isZh ? '云端已有版本' : 'A version exists in cloud';
  return isZh ? '云端已保存' : 'Saved in cloud';
}

function describeScopeTarget(scope: string, isZh: boolean) {
  const type = scope.split(':')[0];
  if (type === 'messages.window') return isZh ? '消息检查' : 'Message check';
  if (type === 'chats.detail') return isZh ? '聊天详情检查' : 'Chat detail check';
  if (type === 'characters.detail') return isZh ? '角色详情检查' : 'Character detail check';
  return isZh ? '数据检查' : 'Data check';
}

function describeScopeFailureHint(scope: string, rawError: string | null | undefined, isZh: boolean) {
  const message = String(rawError || '');
  const [, targetId] = scope.split(':');
  const isLocalChat = typeof targetId === 'string' && targetId.startsWith('local-chat-');
  if (/群聊不存在|聊天不存在|LOCAL_CHAT_NOT_REMOTE|404|不存在/i.test(message)) {
    if (scope.startsWith('messages.window:') && isLocalChat) {
      return isZh
        ? '原因：这批消息依赖的本地临时聊天还没有云端对应记录，或该聊天已被删除，所以消息窗口检查无法继续。先检查该聊天的创建同步是否成功。'
        : 'Cause: this message batch depends on a local temporary chat that does not have a remote record yet, or the chat was deleted. Check whether chat creation synced successfully first.';
    }
    if (scope.startsWith('chats.detail:') && isLocalChat) {
      return isZh
        ? '原因：这个本地临时聊天还没有对应的云端聊天记录，或云端记录已不存在，所以详情检查失败。先检查聊天创建任务。'
        : 'Cause: this local temporary chat does not have a matching remote chat yet, or the remote record no longer exists. Check the chat creation task first.';
    }
    return isZh ? '原因：检查目标在云端不存在，通常是依赖对象尚未上传成功，或已被删除。' : 'Cause: the checked target does not exist in the cloud, usually because a dependency was not uploaded successfully or was deleted.';
  }
  return null;
}

const compactChipSx = {
  borderRadius: 1,
  '& .MuiChip-label': {
    px: 1.1,
    fontWeight: 600,
  },
};

const SYNC_HISTORY_PAGE_SIZE = 50;

export default function SyncStatusPage() {
  const { i18n } = useTranslation();
  const characterStore = useCharacterStore();
  const chatStore = useChatStore();
  const messageStore = useMessageStore();
  const artifactStore = useCharacterArtifactStore();
  const settingsStore = useSettingsStore();
  const authMode = useAuthStore((s) => s.authMode);
  const isZh = i18n.language.startsWith('zh');
  const [bootstrapStatus, setBootstrapStatus] = useState<CloudSyncBootstrapStatus | null>(() => readCloudSyncBootstrapStatus());
  const [persistenceHealth, setPersistenceHealth] = useState(() => readPersistenceHealth());
  const [importResult, setImportResult] = useState<LocalRecoveryImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [maintenanceResult, setMaintenanceResult] = useState<LocalPersistenceMaintenanceResult | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [isMaintainingPersistence, setIsMaintainingPersistence] = useState(false);
  const [historyItems, setHistoryItems] = useState<LocalOutboxHistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historySucceededTotal, setHistorySucceededTotal] = useState(0);
  const [historyFailedTotal, setHistoryFailedTotal] = useState(0);
  const [activeFilter, setActiveFilter] = useState<SyncStatusFilterKey>('all');
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequestSeqRef = useRef(0);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [resolvingConflictId, setResolvingConflictId] = useState<string | null>(null);
  const [confirmClearTasks, setConfirmClearTasks] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const [isClearingHistory, setIsClearingHistory] = useState(false);
  const [retryMenuAnchor, setRetryMenuAnchor] = useState<HTMLElement | null>(null);
  const [artifactCloudSummaries, setArtifactCloudSummaries] = useState<Map<string, CharacterArtifactSummaryEntry> | null>(null);
  const [artifactCloudCheckError, setArtifactCloudCheckError] = useState<string | null>(null);
  const [artifactCloudCheckLoading, setArtifactCloudCheckLoading] = useState(false);
  const [artifactCloudCheckRevision, setArtifactCloudCheckRevision] = useState(0);
  const [retryingArtifactCloud, setRetryingArtifactCloud] = useState(false);
  const [artifactCloudUploadError, setArtifactCloudUploadError] = useState(false);
  const recoveryImportInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void ensureCharacterArtifactStoreHydrated();
  }, []);

  useEffect(() => {
    const refresh = () => setArtifactCloudCheckRevision((value) => value + 1);
    window.addEventListener(ARTIFACT_CLOUD_SYNC_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ARTIFACT_CLOUD_SYNC_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const status = event instanceof CustomEvent ? event.detail?.status as CloudSyncBootstrapStatus | null : readCloudSyncBootstrapStatus();
      setBootstrapStatus(status || null);
    };
    window.addEventListener('pneumata-cloud-sync-bootstrap-status-changed', handler);
    return () => window.removeEventListener('pneumata-cloud-sync-bootstrap-status-changed', handler);
  }, []);

  useEffect(() => {
    const handler = () => setPersistenceHealth(readPersistenceHealth());
    window.addEventListener(PERSISTENCE_HEALTH_EVENT, handler);
    return () => window.removeEventListener(PERSISTENCE_HEALTH_EVENT, handler);
  }, []);

  useEffect(() => {
    void mirrorLocalOutboxQueues({
      characterOperations: characterStore.pendingOperations || [],
      chatOperations: chatStore.pendingOperations || [],
      messageOperations: messageStore.pendingOperations || [],
      artifactJobs: artifactStore.jobs || [],
    }).catch((error) => {
      console.warn('[local-outbox] failed to mirror sync status queues', error);
    });
  }, [artifactStore.jobs, characterStore.pendingOperations, chatStore.pendingOperations, messageStore.pendingOperations]);

  const loadHistory = useCallback(async (offset = 0, append = false) => {
    const requestSeq = ++historyRequestSeqRef.current;
    if (append) {
      setIsLoadingMoreHistory(true);
    } else {
      setIsLoadingHistory(true);
    }
    setHistoryError(null);
    try {
      const activeIds = new Set([
        ...(characterStore.pendingOperations || []),
        ...(chatStore.pendingOperations || []),
        ...(messageStore.pendingOperations || []),
        ...(artifactStore.jobs || []),
      ].map((operation) => operation.id));
      const result = await listLocalOutboxHistory({ offset, limit: SYNC_HISTORY_PAGE_SIZE, activeIds });
      if (requestSeq !== historyRequestSeqRef.current) return;
      setHistoryItems((current) => append ? [...current, ...result.items] : result.items);
      setHistoryTotal(result.total);
      setHistorySucceededTotal(result.succeededTotal);
      setHistoryFailedTotal(result.failedTotal);
      setHistoryHasMore(result.hasMore);
    } catch (error) {
      if (requestSeq === historyRequestSeqRef.current) setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestSeq === historyRequestSeqRef.current) {
        if (append) {
          setIsLoadingMoreHistory(false);
        } else {
          setIsLoadingHistory(false);
        }
      }
    }
  }, [artifactStore.jobs, characterStore.pendingOperations, chatStore.pendingOperations, messageStore.pendingOperations]);

  useEffect(() => {
    void loadHistory();
    const handleHistoryChange = () => { void loadHistory(); };
    window.addEventListener(LOCAL_OUTBOX_HISTORY_CHANGED_EVENT, handleHistoryChange);
    return () => window.removeEventListener(LOCAL_OUTBOX_HISTORY_CHANGED_EVENT, handleHistoryChange);
  }, [loadHistory]);

  const hasVerifiableArtifactHistory = historyItems.some((item) => item.scopeType === 'artifact' && item.status === 'succeeded' && item.resultId);
  useEffect(() => {
    if (activeFilter !== 'history' || authMode !== 'cloud' || !isCloudSyncEnabled() || !hasVerifiableArtifactHistory) return;
    let cancelled = false;
    setArtifactCloudCheckLoading(true);
    setArtifactCloudCheckError(null);
    setArtifactCloudSummaries(null);
    void api.getCharacterArtifactSummaries({ includeDeleted: true }).then((response) => {
      if (!cancelled) setArtifactCloudSummaries(new Map(response.items.map((item) => [item.id, item])));
    }).catch((error: unknown) => {
      if (!cancelled) setArtifactCloudCheckError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setArtifactCloudCheckLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeFilter, artifactCloudCheckRevision, authMode, hasVerifiableArtifactHistory]);

  const localOutboxItems = useMemo(() => buildLocalOutboxProjection({
    characterOperations: characterStore.pendingOperations || [],
    chatOperations: chatStore.pendingOperations || [],
    messageOperations: messageStore.pendingOperations || [],
    artifactJobs: artifactStore.jobs || [],
  }), [artifactStore.jobs, characterStore.pendingOperations, chatStore.pendingOperations, messageStore.pendingOperations]);

  const items = useMemo(() => {
    const characterOperationsById = new Map((characterStore.pendingOperations || []).map((operation) => [operation.id, operation]));
    const chatOperationsById = new Map((chatStore.pendingOperations || []).map((operation) => [operation.id, operation]));
    const messageOperationsById = new Map((messageStore.pendingOperations || []).map((operation) => [operation.id, operation]));
    const artifactJobsById = new Map((artifactStore.jobs || []).map((job) => [job.id, job]));
    const pendingMessageKeys = new Set<string>();
    (messageStore.pendingOperations || []).forEach((operation) => {
      [operation.localMessageId, operation.messageId, operation.payload?.id, operation.payload?.clientKey, operation.payload?.serverId]
        .filter((key): key is string => Boolean(key))
        .forEach((key) => pendingMessageKeys.add(key));
    });
    localOutboxItems
      .filter((outboxItem) => outboxItem.scopeType === 'message')
      .forEach((outboxItem) => {
        if (outboxItem.targetId) pendingMessageKeys.add(outboxItem.targetId);
      });
    const messageSnapshotsByKey = new Map<string, Message>();
    (messageStore.pendingOperations || []).forEach((operation) => rememberMessageSnapshot(messageSnapshotsByKey, operation.payload));
    if (pendingMessageKeys.size > 0) {
      Object.values(messageStore.messageWindowsByChatId || {}).forEach((window) => {
        (window.messages || []).forEach((message) => {
          if (
            pendingMessageKeys.has(message.id)
            || Boolean(message.clientKey && pendingMessageKeys.has(message.clientKey))
            || Boolean(message.serverId && pendingMessageKeys.has(message.serverId))
          ) {
            rememberMessageSnapshot(messageSnapshotsByKey, message);
          }
        });
      });
    }

    const queueItems = localOutboxItems.map((outboxItem) => {
      if (outboxItem.scopeType === 'character') {
        const operation = characterOperationsById.get(outboxItem.id);
        const targetId = operation?.entityId || outboxItem.targetId;
        const localSnapshot = characterStore.characters.find((character) => character.id === targetId) || null;
        return {
          id: outboxItem.id,
          scopeType: 'character' as const,
          scope: isZh ? '角色' : 'Characters',
          kind: outboxItem.kind,
          status: outboxItem.status,
          createdAt: outboxItem.createdAt,
          attemptCount: outboxItem.attemptCount,
          lastError: outboxItem.lastError || null,
          targetCount: outboxItem.targetIds.length || 1,
          targetLabel: taskTargetLabel({ ...outboxItem, payload: operation }, localSnapshot?.name, isZh),
          summary: summarizePatch(operation?.patch, isZh),
          diffPreview: buildPatchDiffPreview(operation?.patch),
          exportPayload: {
            operation: operation || outboxItem,
            outboxItem,
            localSnapshot,
          },
        };
      }

      if (outboxItem.scopeType === 'chat') {
        const operation = chatOperationsById.get(outboxItem.id);
        const targetId = operation?.entityId || outboxItem.targetId;
        const localSnapshot = chatStore.chats.find((chat) => chat.id === targetId) || null;
        return {
          id: outboxItem.id,
          scopeType: 'chat' as const,
          scope: isZh ? '聊天' : 'Chats',
          kind: outboxItem.kind,
          status: outboxItem.status,
          createdAt: outboxItem.createdAt,
          attemptCount: outboxItem.attemptCount,
          lastError: outboxItem.lastError || null,
          targetCount: outboxItem.targetIds.length || 1,
          targetLabel: taskTargetLabel({ ...outboxItem, payload: operation }, localSnapshot?.name || chatStore.remoteDeletedChats.find((chat) => chat.id === targetId)?.name, isZh),
          summary: summarizePatch(operation?.patch, isZh),
          diffPreview: buildPatchDiffPreview(operation?.patch),
          exportPayload: {
            operation: operation || outboxItem,
            outboxItem,
            localSnapshot,
          },
        };
      }

      if (outboxItem.scopeType === 'message') {
        const operation = messageOperationsById.get(outboxItem.id);
        const chatId = operation?.chatId || outboxItem.summaryKey || '';
        const targetMessage = operation?.payload
          || (operation?.localMessageId ? messageSnapshotsByKey.get(operation.localMessageId) : null)
          || (operation?.messageId ? messageSnapshotsByKey.get(operation.messageId) : null)
          || messageSnapshotsByKey.get(outboxItem.targetId);
        const chat = chatStore.chats.find((item) => item.id === chatId);
        return {
          id: outboxItem.id,
          scopeType: 'message' as const,
          scope: isZh ? '消息' : 'Messages',
          kind: outboxItem.kind,
          status: outboxItem.status,
          createdAt: outboxItem.createdAt,
          attemptCount: outboxItem.attemptCount,
          lastError: outboxItem.lastError || null,
          targetCount: outboxItem.targetIds.length || 1,
          targetLabel: taskTargetLabel(outboxItem, chat?.name || chatStore.remoteDeletedChats.find((chat) => chat.id === chatId)?.name, isZh),
          summary: targetMessage?.content ? clipText(targetMessage.content) : (isZh ? '本地消息快照未在当前缓存窗口中找到' : 'Local message snapshot was not found in cached windows'),
          exportPayload: {
            operation: operation || outboxItem,
            outboxItem,
            localSnapshot: targetMessage || null,
            chatSnapshot: chat || null,
          },
        };
      }

      const job = artifactJobsById.get(outboxItem.id);
      const localSnapshot = job
        ? artifactStore.items.find((artifact) => (
          artifact.id === job.id
          || artifact.characterId === job.characterId && artifact.kind === job.kind && artifact.sourceKey === job.sourceKey && artifact.dateKey === job.dateKey
        )) || null
        : null;
      return {
        id: outboxItem.id,
        scopeType: 'artifact' as const,
        scope: isZh ? '信件 / 日记生成' : 'Letter / diary generation',
        kind: outboxItem.kind,
        status: outboxItem.status,
        createdAt: outboxItem.createdAt,
        attemptCount: outboxItem.attemptCount,
        lastError: outboxItem.lastError || null,
        targetCount: outboxItem.targetIds.length || 1,
        targetLabel: job?.snapshot?.name || (isZh ? '角色经历' : 'Character artifact'),
        summary: [job?.dateKey, job?.sourceKey].filter(Boolean).join(' · ') || outboxItem.summaryKey || (isZh ? '角色经历生成任务' : 'Character artifact generation job'),
        exportPayload: {
          job: job || outboxItem,
          outboxItem,
          localSnapshot,
        },
      };
    });

    const characterDeleteConflicts = (characterStore.remoteDeletedCharacterIds || [])
      .map((id) => ({
        id,
        localSnapshot: characterStore.characters.find((character) => character.id === id) || null,
        pending: (characterStore.pendingOperations || []).filter((operation) => operation.entityId === id && operation.kind !== 'create'),
      }))
      .filter((item) => item.pending.length > 0)
      .map((item) => ({
        id: `character-delete-conflict-${item.id}`,
        scopeType: 'character' as const,
        scope: isZh ? '角色' : 'Characters',
        kind: 'delete_edit_conflict',
        status: 'conflict',
        createdAt: Math.max(...item.pending.map((operation) => operation.clientTimestamp), 0),
        attemptCount: item.pending.reduce((sum, operation) => sum + operation.attemptCount, 0),
        lastError: null,
        targetCount: item.pending.length,
        targetLabel: item.localSnapshot?.name || item.id,
        summary: isZh ? '云端已删除，本地仍有未同步编辑；本地投影会继续保留，等待手动处理。' : 'Remote deleted this item while local edits are still pending. Local projection is preserved for manual resolution.',
        conflictTargetId: item.id,
        diffPreview: buildOperationsDiffPreview(item.pending),
        exportPayload: {
          conflict: 'remote_delete_with_local_pending',
          remoteDeletedId: item.id,
          pendingOperations: item.pending,
          diffPreview: buildOperationsDiffPreview(item.pending),
          localSnapshot: item.localSnapshot,
        },
      }));

    const chatDeleteConflicts = (chatStore.remoteDeletedChatIds || [])
      .map((id) => ({
        id,
        localSnapshot: chatStore.chats.find((chat) => chat.id === id) || chatStore.remoteDeletedChats.find((chat) => chat.id === id) || null,
        pending: (chatStore.pendingOperations || []).filter((operation) => operation.entityId === id && operation.kind !== 'create'),
      }))
      .filter((item) => item.pending.length > 0)
      .map((item) => ({
        id: `chat-delete-conflict-${item.id}`,
        scopeType: 'chat' as const,
        scope: isZh ? '聊天' : 'Chats',
        kind: 'delete_edit_conflict',
        status: 'conflict',
        createdAt: Math.max(...item.pending.map((operation) => operation.clientTimestamp), 0),
        attemptCount: item.pending.reduce((sum, operation) => sum + operation.attemptCount, 0),
        lastError: null,
        targetCount: item.pending.length,
        targetLabel: item.localSnapshot?.name || item.id,
        summary: isZh ? '云端已删除，本地仍有未同步编辑；本地投影会继续保留，等待手动处理。' : 'Remote deleted this item while local edits are still pending. Local projection is preserved for manual resolution.',
        conflictTargetId: item.id,
        diffPreview: buildOperationsDiffPreview(item.pending),
        exportPayload: {
          conflict: 'remote_delete_with_local_pending',
          remoteDeletedId: item.id,
          pendingOperations: item.pending,
          diffPreview: buildOperationsDiffPreview(item.pending),
          localSnapshot: item.localSnapshot,
        },
      }));

    const characterFieldConflicts = (characterStore.fieldConflicts || [])
      .filter((conflict) => conflict.entityType === 'character' && !conflict.accepted
        && conflict.remoteUpdatedAt > conflict.localUpdatedAt
        && (characterStore.pendingOperations || []).some((operation) => conflict.localOperationIds.includes(operation.id) && operation.status !== 'failed'))
      .map((conflict) => ({
        id: `character-field-conflict-${conflict.entityId}-${conflict.field}`,
        scopeType: 'character' as const,
        scope: isZh ? '角色' : 'Characters',
        kind: 'field_update_conflict',
        status: 'conflict',
        createdAt: conflict.detectedAt,
        attemptCount: 0,
        lastError: null,
        targetCount: 1,
        targetLabel: characterStore.characters.find((character) => character.id === conflict.entityId)?.name || (isZh ? '名称未记录的角色' : 'Character name unavailable'),
        summary: isZh ? `${displayConflictField(conflict.field, true)}在其他设备也有更新，请选择保留哪一版。` : `${displayConflictField(conflict.field, false)} changed on another device. Choose which version to keep.`,
        conflictTargetId: conflict.entityId,
        conflictField: conflict.field,
        diffPreview: [{
          field: conflict.field,
          value: isZh ? `本地 ${describeConflictValue(conflict.localValue, true)} / 云端 ${describeConflictValue(conflict.remoteValue, true)}` : `Local ${describeConflictValue(conflict.localValue, false)} / Cloud ${describeConflictValue(conflict.remoteValue, false)}`,
        }],
        exportPayload: {
          conflict: 'remote_field_update_with_local_pending',
          ...conflict,
          localSnapshot: characterStore.characters.find((character) => character.id === conflict.entityId) || null,
        },
      }));

    const chatFieldConflicts = (chatStore.fieldConflicts || [])
      .filter((conflict) => conflict.entityType === 'chat' && !conflict.accepted
        && conflict.remoteUpdatedAt > conflict.localUpdatedAt
        && (chatStore.pendingOperations || []).some((operation) => conflict.localOperationIds.includes(operation.id) && operation.status !== 'failed'))
      .map((conflict) => ({
        id: `chat-field-conflict-${conflict.entityId}-${conflict.field}`,
        scopeType: 'chat' as const,
        scope: isZh ? '聊天' : 'Chats',
        kind: 'field_update_conflict',
        status: 'conflict',
        createdAt: conflict.detectedAt,
        attemptCount: 0,
        lastError: null,
        targetCount: 1,
        targetLabel: chatStore.chats.find((chat) => chat.id === conflict.entityId)?.name || chatStore.remoteDeletedChats.find((chat) => chat.id === conflict.entityId)?.name || (isZh ? '名称未记录的聊天' : 'Chat name unavailable'),
        summary: isZh ? `${displayConflictField(conflict.field, true)}在其他设备也有更新，请选择保留哪一版。` : `${displayConflictField(conflict.field, false)} changed on another device. Choose which version to keep.`,
        conflictTargetId: conflict.entityId,
        conflictField: conflict.field,
        diffPreview: [{
          field: conflict.field,
          value: isZh ? `本地 ${describeConflictValue(conflict.localValue, true)} / 云端 ${describeConflictValue(conflict.remoteValue, true)}` : `Local ${describeConflictValue(conflict.localValue, false)} / Cloud ${describeConflictValue(conflict.remoteValue, false)}`,
        }],
        exportPayload: {
          conflict: 'remote_field_update_with_local_pending',
          ...conflict,
          localSnapshot: chatStore.chats.find((chat) => chat.id === conflict.entityId) || null,
        },
      }));

    return [...characterDeleteConflicts, ...chatDeleteConflicts, ...characterFieldConflicts, ...chatFieldConflicts, ...queueItems].sort((a, b) => b.createdAt - a.createdAt);
  }, [artifactStore.items, artifactStore.jobs, characterStore.characters, characterStore.fieldConflicts, characterStore.pendingOperations, characterStore.remoteDeletedCharacterIds, chatStore.chats, chatStore.fieldConflicts, chatStore.pendingOperations, chatStore.remoteDeletedChatIds, chatStore.remoteDeletedChats, isZh, localOutboxItems, messageStore.messageWindowsByChatId, messageStore.pendingOperations]);

  const syncScopes = useMemo(() => {
    const entries = [
      ...characterStore.getSyncScopeStates().map((state) => ({ area: isZh ? '角色' : 'Characters', state })),
      ...chatStore.getSyncScopeStates().map((state) => ({ area: isZh ? '聊天' : 'Chats', state })),
      ...messageStore.getSyncScopeStates().map((state) => ({ area: isZh ? '消息' : 'Messages', state })),
      ...artifactStore.getSyncScopeStates().map((state) => ({ area: isZh ? '信件 / 日记' : 'Letters / Diary', state })),
      ...settingsStore.getSyncScopeStates().map((state) => ({ area: isZh ? '设置' : 'Settings', state })),
    ];
    const priority = (item: typeof entries[number]) => {
      if (item.state.inflight) return 0;
      if (item.state.retryAt > Date.now()) return 1;
      if (item.state.lastError) return 2;
      if (item.state.lastCheckedAt > 0) return 3;
      return 4;
    };
    return entries.sort((a, b) => priority(a) - priority(b) || b.state.lastCheckedAt - a.state.lastCheckedAt || a.state.scope.localeCompare(b.state.scope));
  }, [artifactStore, characterStore, chatStore, isZh, messageStore, settingsStore]);

  const filteredSyncScopes = useMemo(() => syncScopes.filter((item) => matchesScopeFilter(item.state, activeFilter)), [activeFilter, syncScopes]);
  const visibleSyncScopes = filteredSyncScopes.slice(0, 30);

  const labelMap: Record<string, string> = {
    character: isZh ? '角色' : 'Character',
    chat: isZh ? '聊天' : 'Chat',
    message: isZh ? '消息' : 'Message',
    artifact: isZh ? '信件 / 日记生成' : 'Letter / diary generation',
    delete: isZh ? '删除' : 'Delete',
    restore: isZh ? '恢复' : 'Restore',
    purge: isZh ? '彻底删除' : 'Purge',
    empty_deleted: isZh ? '清空回收站' : 'Empty trash',
    create: isZh ? '创建' : 'Create',
    patch: isZh ? '编辑' : 'Edit',
    delete_edit_conflict: isZh ? '远端删除 / 本地编辑冲突' : 'Remote delete / local edit conflict',
    field_update_conflict: isZh ? '字段更新冲突' : 'Field update conflict',
    birth_letter: isZh ? '诞生信' : 'Birth letter',
    final_letter: isZh ? '信件' : 'Letter',
    diary: isZh ? '日记' : 'Diary',
    pending: isZh ? '待同步' : 'Pending',
    syncing: isZh ? '同步中' : 'Syncing',
    failed: isZh ? '同步失败' : 'Failed',
    conflict: isZh ? '冲突' : 'Conflict',
    succeeded: isZh ? '已完成' : 'Succeeded',
    planned: isZh ? '已生成计划' : 'Planned',
    running: isZh ? '准备同步中' : 'Running',
  };

  const canRetrySync = localOutboxItems.some((item) => item.scopeType !== 'artifact'
    && item.status === 'failed' && !parseSyncErrorClassification(item.lastError).terminal);
  const retryableArtifactJobs = artifactStore.jobs.filter((job) => job.status === 'failed');
  const canRetryArtifacts = retryableArtifactJobs.length > 0 && hasUsableDefaultTextAI(settingsStore.aiProfiles);
  const canRetryPersistence = Boolean(persistenceHealth.latestFailure) && !isMaintainingPersistence;
  const canRetryAnything = canRetrySync || canRetryArtifacts || canRetryPersistence;
  const retryDisabledReason = canRetryAnything ? ''
    : localOutboxItems.some((item) => item.status === 'failed')
      ? (isZh ? '这些失败项需要手动处理，无法直接重试' : 'These failures need manual resolution before retrying')
      : retryableArtifactJobs.length > 0
        ? (isZh ? '请先配置可用的文本模型' : 'Configure an available text model first')
        : (isZh ? '没有可重试的任务' : 'No tasks to retry');
  const retrySync = () => {
    chatStore.retryFailedOperations();
    characterStore.retryFailedOperations();
    messageStore.retryFailedOperations();
    scheduleSyncWorkersByPriority(0);
  };
  const retryAll = () => {
    if (canRetrySync) retrySync();
    if (canRetryArtifacts) void artifactStore.resumeProcessing({ retryFailed: true });
    if (canRetryPersistence) void maintainLocalPersistence();
  };
  const retryArtifactCloud = async () => {
    setRetryingArtifactCloud(true);
    setArtifactCloudUploadError(false);
    try {
      await artifactStore.retryCloudSync();
      setArtifactCloudUploadError(artifactStore.getSyncScopeStates().some((state) => state.scope === 'artifacts.summary' && Boolean(state.lastError)));
    } catch {
      setArtifactCloudUploadError(true);
    } finally {
      setRetryingArtifactCloud(false);
      setArtifactCloudCheckRevision((value) => value + 1);
    }
  };

  const discardFailed = (item: { id: string; scopeType: 'character' | 'chat' | 'message' | 'artifact'; status: string }) => {
    if (item.status !== 'failed') return;
    try {
      setResolutionError(null);
      if (item.scopeType === 'character') characterStore.discardFailedOperation(item.id);
      if (item.scopeType === 'chat') chatStore.discardFailedOperation(item.id);
      if (item.scopeType === 'message') messageStore.discardFailedOperation(item.id);
      if (item.scopeType === 'artifact') artifactStore.discardFailedJob(item.id);
    } catch {
      setResolutionError(isZh ? '未能保存移除操作，请检查浏览器存储后重试。' : 'Could not save the removal. Check browser storage and try again.');
    }
  };

  const resolveDeleteEditConflict = (item: typeof items[number], resolution: 'restore_local' | 'discard_local' | 'save_as_new') => {
    if (item.status !== 'conflict') return;
    const targetId = 'conflictTargetId' in item && typeof item.conflictTargetId === 'string' ? item.conflictTargetId : null;
    if (!targetId) return;
    if (item.scopeType === 'character') void characterStore.resolveRemoteDeleteConflict(targetId, resolution);
    if (item.scopeType === 'chat') void chatStore.resolveRemoteDeleteConflict(targetId, resolution);
  };

  const resolveFieldConflict = async (item: typeof items[number], resolution: 'keep_local' | 'use_remote') => {
    if (item.status !== 'conflict' || !('conflictField' in item) || !('conflictTargetId' in item)) return;
    setResolutionError(null);
    setResolvingConflictId(item.id);
    try {
      if (item.scopeType === 'chat') await chatStore.resolveFieldConflict(item.conflictTargetId, item.conflictField, resolution);
      if (item.scopeType === 'character') await characterStore.resolveFieldConflict(item.conflictTargetId, item.conflictField, resolution);
    } catch (error) {
      setResolutionError(error instanceof Error ? error.message : String(error));
    } finally {
      setResolvingConflictId(null);
    }
  };

  const failedCount = localOutboxItems.filter((item) => item.status === 'failed').length;
  const pendingCount = localOutboxItems.filter((item) => item.status === 'pending').length;
  const syncingCount = localOutboxItems.filter((item) => item.status === 'syncing').length;
  const conflictCount = items.filter((item) => item.status === 'conflict').length;
  const filteredItems = useMemo(() => items.filter((item) => matchesQueueItemFilter(item, activeFilter)), [activeFilter, items]);
  const selectedTaskIds = new Set(filteredItems.map((item) => item.id));
  for (const item of filteredItems) {
    if (item.status !== 'conflict' || !('conflictTargetId' in item)) continue;
    if ('conflictField' in item) {
      const conflicts = item.scopeType === 'chat' ? chatStore.fieldConflicts : characterStore.fieldConflicts;
      const conflict = conflicts.find((entry) => entry.entityId === item.conflictTargetId && entry.field === item.conflictField);
      conflict?.localOperationIds.forEach((id) => selectedTaskIds.add(id));
    } else {
      localOutboxItems.filter((entry) => entry.scopeType === item.scopeType && entry.targetIds.includes(item.conflictTargetId))
        .forEach((entry) => selectedTaskIds.add(entry.id));
    }
  }
  const selectedTasks = localOutboxItems.filter((item) => selectedTaskIds.has(item.id));
  const hasSelectedRunningTasks = selectedTasks.some((item) => item.status === 'syncing');
  const clearSelectedTasks = () => {
    const idsForScope = (scope: string) => selectedTasks.filter((item) => item.scopeType === scope).map((item) => item.id);
    try {
      setResolutionError(null);
      characterStore.clearSyncTasks(idsForScope('character'));
      chatStore.clearSyncTasks(idsForScope('chat'));
      messageStore.clearSyncTasks(idsForScope('message'));
      artifactStore.clearSyncTasks(idsForScope('artifact'));
    } catch {
      setResolutionError(isZh ? '部分任务未能清空，请检查浏览器存储后重试。' : 'Some tasks could not be cleared. Check browser storage and try again.');
    }
    setConfirmClearTasks(false);
  };
  const failedItems = filteredItems.filter((item) => item.status === 'failed');
  const historyShownCount = historyItems.length;
  const filterChipItems = useMemo(() => {
    const base = [
      { key: 'all' as const, label: isZh ? `全部 ${items.length}` : `All ${items.length}`, color: 'default' as const },
      { key: 'queued' as const, label: isZh ? `待同步 ${pendingCount}` : `Pending ${pendingCount}`, color: 'info' as const },
      { key: 'syncing' as const, label: isZh ? `同步中 ${syncingCount}` : `Syncing ${syncingCount}`, color: 'primary' as const },
      { key: 'failed' as const, label: isZh ? `需处理 ${failedCount}` : `Needs attention ${failedCount}`, color: 'error' as const },
      { key: 'conflict' as const, label: isZh ? `冲突 ${conflictCount}` : `Conflicts ${conflictCount}`, color: 'warning' as const },
    ];
    return [
      ...base.filter((item) => item.key === 'all' || countForFilter(items, syncScopes.map((entry) => entry.state), item.key) > 0),
      { key: 'history' as const, label: isZh ? `历史 ${historyTotal}` : `History ${historyTotal}`, color: 'success' as const },
    ];
  }, [conflictCount, failedCount, historyTotal, isZh, items, pendingCount, syncScopes, syncingCount]);
  const exportFailed = () => downloadJson(`pneumata-sync-failed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, {
    exportedAt: Date.now(),
    authMode,
    items: failedItems.map((item) => ({
      id: item.id,
      scopeType: item.scopeType,
      scope: item.scope,
      kind: item.kind,
      status: item.status,
      createdAt: item.createdAt,
      attemptCount: item.attemptCount,
      lastError: item.lastError,
      targetLabel: item.targetLabel,
      summary: item.summary,
      data: item.exportPayload,
    })),
  });
  const exportItem = (item: typeof items[number]) => downloadJson(`pneumata-sync-${item.scopeType}-${item.id}.json`, {
    exportedAt: Date.now(),
    authMode,
    item,
  });
  const exportBootstrapStatus = () => downloadJson(`pneumata-cloud-sync-bootstrap-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, {
    exportedAt: Date.now(),
    authMode,
    bootstrapStatus,
  });
  const exportSyncScopes = () => downloadJson(`pneumata-sync-scopes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, {
    exportedAt: Date.now(),
    authMode,
    scopes: syncScopes,
  });
  const exportPersistenceHealth = async () => {
    const snapshot = await buildLocalRecoverySnapshot({ persistenceFailures: persistenceHealth.failures });
    downloadJson(`pneumata-local-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, snapshot);
  };
  const handleRecoveryImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportError(null);
    setImportResult(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      setImportResult(importLocalRecoverySnapshot(parsed));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };
  const maintainLocalPersistence = async () => {
    setIsMaintainingPersistence(true);
    setMaintenanceError(null);
    setMaintenanceResult(null);
    try {
      const result = await runLocalPersistenceMaintenance();
      setMaintenanceResult(result);
      setPersistenceHealth(readPersistenceHealth());
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMaintainingPersistence(false);
    }
  };
  const clearPersistenceHealth = () => {
    clearPersistenceFailures();
    setPersistenceHealth(readPersistenceHealth());
  };

  const loadMoreHistory = () => {
    if (isLoadingMoreHistory || !historyHasMore) return;
    void loadHistory(historyItems.length, true);
  };

  const clearHistory = async () => {
    ++historyRequestSeqRef.current;
    setIsLoadingHistory(false);
    setIsLoadingMoreHistory(false);
    setIsClearingHistory(true);
    setHistoryError(null);
    try {
      await clearLocalOutboxHistory();
      setHistoryItems([]);
      setHistoryTotal(0);
      setHistorySucceededTotal(0);
      setHistoryFailedTotal(0);
      setHistoryHasMore(false);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsClearingHistory(false);
    }
  };

  return (
    <Box sx={{ p: 3, pt: { xs: 1, sm: 1, md: 3 }, pb: 0, width: '100%', maxWidth: 960, mx: 'auto', flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {settingsStore.developerMode ? (
        <Box component="details" sx={{ mb: 2, minWidth: 0, '& > summary': { cursor: 'pointer', fontSize: 14, color: 'text.secondary', py: 0.5 } }}>
          <Typography component="summary" variant="body2">{isZh ? '数据与维护' : 'Data and maintenance'}</Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" onClick={exportFailed} disabled={failedItems.length === 0}>
              {isZh ? '导出失败项' : 'Export failed'}
            </Button>
            <input
              ref={recoveryImportInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleRecoveryImport}
              style={{ display: 'none' }}
            />
            <Button size="small" variant="outlined" onClick={() => recoveryImportInputRef.current?.click()}>
              {isZh ? '导入本地恢复快照' : 'Import local recovery snapshot'}
            </Button>
            <Button size="small" variant="outlined" onClick={maintainLocalPersistence} disabled={isMaintainingPersistence}>
              {isZh ? '整理并重试本地保存' : 'Clean up and retry local persistence'}
            </Button>
          </Stack>
        </Box>
      ) : null}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, minWidth: 0 }}>
        <Tabs
          value={activeFilter}
          onChange={(_, value: SyncStatusFilterKey) => setActiveFilter(value)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label={isZh ? '任务筛选' : 'Task filters'}
          sx={{ flex: 1, minWidth: 0, minHeight: 40, '& .MuiTab-root': { minHeight: 40, px: 1.5, minWidth: 0 }, '& .MuiTabs-indicator': { height: 2 } }}
        >
          {filterChipItems.map((item) => <Tab key={item.key} value={item.key} label={item.label} />)}
        </Tabs>
        <Box sx={{ ml: 'auto', display: 'flex', gap: 1, flexShrink: 0, alignItems: 'center' }}>
          <Tooltip title={retryDisabledReason || (isZh ? '重试可恢复任务' : 'Retry recoverable tasks')}>
            <Box component="span" sx={{ display: 'inline-flex' }}>
              <ButtonGroup size="small" variant="outlined" sx={{ '& .MuiButton-root': { minHeight: 30, py: 0.25 } }}>
                <Button onClick={retryAll} disabled={!canRetryAnything} aria-label={isZh ? '重试可恢复任务' : 'Retry recoverable tasks'}>
                  <RefreshIcon fontSize="small" sx={{ display: { xs: 'block', sm: 'none' } }} />
                  <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{isZh ? '重试' : 'Retry'}</Box>
                </Button>
                <Button
                  aria-label={isZh ? '重试选项' : 'Retry options'}
                  aria-haspopup="menu"
                  aria-controls={retryMenuAnchor ? 'sync-retry-menu' : undefined}
                  aria-expanded={Boolean(retryMenuAnchor)}
                  disabled={!canRetryAnything}
                  onClick={(event) => setRetryMenuAnchor(event.currentTarget)}
                  sx={{ px: 0.5, minWidth: 30 }}
                >
                  <ArrowDropDownIcon fontSize="small" />
                </Button>
              </ButtonGroup>
            </Box>
          </Tooltip>
          <Menu id="sync-retry-menu" anchorEl={retryMenuAnchor} open={Boolean(retryMenuAnchor)} onClose={() => setRetryMenuAnchor(null)}>
            <MenuItem disabled={!canRetrySync} onClick={() => { setRetryMenuAnchor(null); retrySync(); }}>
              {isZh ? '重试同步' : 'Retry sync'}
            </MenuItem>
            <MenuItem disabled={!canRetryArtifacts} onClick={() => { setRetryMenuAnchor(null); void artifactStore.resumeProcessing({ retryFailed: true }); }}>
              {isZh ? '重试信件与日记生成' : 'Retry letter and diary generation'}
            </MenuItem>
            {persistenceHealth.latestFailure || settingsStore.developerMode ? (
              <MenuItem disabled={isMaintainingPersistence} onClick={() => { setRetryMenuAnchor(null); void maintainLocalPersistence(); }}>
                {isZh ? '重试本地保存' : 'Retry local saving'}
              </MenuItem>
            ) : null}
          </Menu>
          <Tooltip title={hasSelectedRunningTasks && activeFilter !== 'history' ? (isZh ? '请等待当前同步完成' : 'Wait for current sync to finish') : (isZh ? '清空当前筛选' : 'Clear current filter')}>
            <span>
              <Button size="small" color="inherit" variant="outlined" sx={{ minHeight: 30, py: 0.25 }}
                aria-label={isZh ? '清空当前筛选' : 'Clear current filter'}
                disabled={activeFilter === 'history' ? isClearingHistory || historyTotal === 0 : selectedTasks.length === 0 || hasSelectedRunningTasks}
                onClick={() => activeFilter === 'history' ? void clearHistory() : setConfirmClearTasks(true)}>
                <DeleteOutlineIcon fontSize="small" sx={{ display: { xs: 'block', sm: 'none' } }} />
                <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{isZh ? '清空' : 'Clear'}</Box>
              </Button>
            </span>
          </Tooltip>
        </Box>
      </Box>
      <Box data-pneumata-scroll-region="sync-tasks" sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehaviorY: 'contain', display: 'flex', flexDirection: 'column', pb: { xs: 15, sm: 12, md: 3 }, '& > *': { flexShrink: 0 } }}>
      {authMode === 'local' ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          {isZh ? '当前为离线本地模式：云同步已关闭，登录后会自动尝试上传本地数据。' : 'You are in local-only offline mode. Cloud sync is disabled and local data will be uploaded automatically after login.'}
        </Alert>
      ) : null}

      {persistenceHealth.latestFailure ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Stack spacing={0.75}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              {isZh ? '本地数据保存失败' : 'Local persistence failed'}
            </Typography>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {isZh
                ? `${persistenceHealth.latestFailure.reason === 'quota_exceeded' ? '存储空间不足' : '写入失败'} · ${formatTime(persistenceHealth.latestFailure.at, isZh)}`
                : `${persistenceHealth.latestFailure.reason === 'quota_exceeded' ? 'Storage full' : 'Write failed'} · ${formatTime(persistenceHealth.latestFailure.at, isZh)}`}
              {settingsStore.developerMode ? ` · ${persistenceHealth.latestFailure.name}${persistenceHealth.latestFailure.sizeBytes ? ` · ${Math.round(persistenceHealth.latestFailure.sizeBytes / 1024)} KiB` : ''}` : ''}
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {settingsStore.developerMode ? (
                <Button size="small" variant="outlined" color="error" onClick={exportPersistenceHealth}>
                  {isZh ? '导出本地恢复快照' : 'Export local recovery snapshot'}
                </Button>
              ) : null}
              <Button size="small" variant="outlined" color="error" onClick={maintainLocalPersistence} disabled={isMaintainingPersistence}>
                {isZh ? '整理并重试' : 'Clean up and retry'}
              </Button>
              <Button size="small" color="error" onClick={clearPersistenceHealth}>
                {isZh ? '清除提示' : 'Clear notice'}
              </Button>
            </Stack>
          </Stack>
        </Alert>
      ) : null}

      {settingsStore.developerMode && maintenanceResult ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          {isZh
            ? `本地保存维护完成：迁移旧副本 ${maintenanceResult.migratedFallbacks.migrated} 个，清理旧副本 ${maintenanceResult.migratedFallbacks.removed} 个，跳过 ${maintenanceResult.migratedFallbacks.skipped} 个，失败 ${maintenanceResult.migratedFallbacks.failed} 个；已重试 ${maintenanceResult.retriedStores.length} 个本地 store 的保存。IndexedDB 当前约 ${Math.round(maintenanceResult.diagnostics.totalBytes / 1024)} KiB。`
            : `Local persistence maintenance finished: migrated ${maintenanceResult.migratedFallbacks.migrated}, removed ${maintenanceResult.migratedFallbacks.removed}, skipped ${maintenanceResult.migratedFallbacks.skipped}, failed ${maintenanceResult.migratedFallbacks.failed}. Retried ${maintenanceResult.retriedStores.length} local stores. IndexedDB is about ${Math.round(maintenanceResult.diagnostics.totalBytes / 1024)} KiB.`}
        </Alert>
      ) : null}

      {maintenanceError ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {isZh ? `本地保存维护失败：${maintenanceError}` : `Local persistence maintenance failed: ${maintenanceError}`}
        </Alert>
      ) : null}

      {importResult ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          {isZh
            ? `本地恢复导入完成：角色 ${importResult.counts.characters.imported}，聊天 ${importResult.counts.chats.imported}，消息 ${importResult.counts.messages.imported}，artifact ${importResult.counts.characterArtifacts.imported}；已保留现有较新数据 ${importResult.counts.characters.preserved + importResult.counts.chats.preserved + importResult.counts.messages.preserved + importResult.counts.characterArtifacts.preserved} 项。`
            : `Local recovery import finished: characters ${importResult.counts.characters.imported}, chats ${importResult.counts.chats.imported}, messages ${importResult.counts.messages.imported}, artifacts ${importResult.counts.characterArtifacts.imported}. Preserved newer local records ${importResult.counts.characters.preserved + importResult.counts.chats.preserved + importResult.counts.messages.preserved + importResult.counts.characterArtifacts.preserved}.`}
          {importResult.ignored.length ? ` ${isZh ? '未导入字段：' : 'Ignored fields: '}${importResult.ignored.join(', ')}` : ''}
        </Alert>
      ) : null}

      {importError ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {isZh ? `本地恢复导入失败：${importError}` : `Local recovery import failed: ${importError}`}
        </Alert>
      ) : null}

      {activeFilter === 'history' ? <Box>
      {settingsStore.developerMode && bootstrapStatus ? (
        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent sx={{ display: 'grid', gap: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {isZh ? '云同步开启计划' : 'Cloud sync bootstrap plan'}
              </Typography>
              <Chip
                size="small"
                label={labelMap[bootstrapStatus.state] || bootstrapStatus.state}
                color={bootstrapStatus.state === 'failed' ? 'error' : bootstrapStatus.state === 'succeeded' ? 'success' : 'primary'}
                variant="outlined"
                sx={compactChipSx}
              />
            </Box>
            <Typography variant="caption" color="text.secondary">
              {new Date(bootstrapStatus.updatedAt).toLocaleString()}
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="small" label={isZh ? `待创建角色 ${bootstrapStatus.charactersToCreate}` : `Characters to create ${bootstrapStatus.charactersToCreate}`} variant="outlined" sx={compactChipSx} />
              <Chip size="small" label={isZh ? `已匹配角色 ${bootstrapStatus.charactersAlreadyRemote}` : `Matched characters ${bootstrapStatus.charactersAlreadyRemote}`} variant="outlined" sx={compactChipSx} />
              <Chip size="small" label={isZh ? `待创建聊天 ${bootstrapStatus.chatsToCreate}` : `Chats to create ${bootstrapStatus.chatsToCreate}`} variant="outlined" sx={compactChipSx} />
              <Chip size="small" label={isZh ? `已匹配聊天 ${bootstrapStatus.chatsAlreadyRemote}` : `Matched chats ${bootstrapStatus.chatsAlreadyRemote}`} variant="outlined" sx={compactChipSx} />
              <Chip size="small" label={isZh ? `待重放消息 ${bootstrapStatus.pendingMessageCreates}` : `Pending messages ${bootstrapStatus.pendingMessageCreates}`} variant="outlined" sx={compactChipSx} />
              <Chip size="small" label={isZh ? `同名冲突 ${bootstrapStatus.characterNameConflicts}` : `Name conflicts ${bootstrapStatus.characterNameConflicts}`} color={bootstrapStatus.characterNameConflicts > 0 ? 'warning' : 'default'} variant="outlined" sx={compactChipSx} />
            </Stack>
            {(bootstrapStatus.characterNameConflictDetails || []).length > 0 ? (
              <Box sx={{ display: 'grid', gap: 1 }}>
                <Typography variant="body2" color="warning.main" sx={{ fontWeight: 600 }}>
                  {isZh ? '同名角色会保留两份，上传本地角色时自动追加“（本地）”后缀；后续需要在冲突处理页合并。' : 'Same-name characters are kept as separate records. Local uploads get a local suffix and can be merged later.'}
                </Typography>
                <Stack spacing={0.75}>
                  {bootstrapStatus.characterNameConflictDetails?.map((item) => (
                    <Box
                      key={`${item.localId}:${item.remoteId}`}
                      sx={{
                        p: 1,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        display: 'grid',
                        gap: 0.25,
                      }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {item.localName || item.remoteName}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
                {bootstrapStatus.characterNameConflictDetailOverflow ? (
                  <Typography variant="caption" color="text.secondary">
                    {isZh ? `另有 ${bootstrapStatus.characterNameConflictDetailOverflow} 条冲突未在页面展开，可导出计划查看。` : `${bootstrapStatus.characterNameConflictDetailOverflow} more conflicts are not expanded here. Export the plan to inspect them.`}
                  </Typography>
                ) : null}
              </Box>
            ) : null}
            {bootstrapStatus.lastError ? (
              <Typography variant="body2" color="error.main">
                {bootstrapStatus.lastError}
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {isZh ? '此计划只记录摘要对账结果；完整冲突解决仍会继续补齐。' : 'This records the summary reconcile plan. Full conflict resolution is still being expanded.'}
              </Typography>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button size="small" variant="outlined" onClick={exportBootstrapStatus}>
                {isZh ? '导出开启计划' : 'Export plan'}
              </Button>
            </Box>
          </CardContent>
        </Card>
      ) : null}

      {settingsStore.developerMode ? <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent sx={{ display: 'grid', gap: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {isZh ? '云端检查状态' : 'Cloud check state'}
            </Typography>
            <Button size="small" variant="outlined" onClick={exportSyncScopes} disabled={syncScopes.length === 0}>
              {isZh ? '导出 scope' : 'Export scopes'}
            </Button>
          </Box>
          {filteredSyncScopes.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {isScopeFilter(activeFilter)
                ? (isZh ? '当前筛选下没有匹配的云端检查项。' : 'No cloud check item matches the current filter.')
                : (isZh ? '当前筛选不显示云端检查项。' : 'Cloud check items are hidden by the current filter.')}
            </Typography>
          ) : (
            <Stack spacing={1}>
              {visibleSyncScopes.map((item) => {
                const health = summarizeSyncScopeState(item.state, isZh);
                const errorInfo = resolveDisplayErrorClassification(item.state.lastError);
                const targetInfo = describeScopeTarget(item.state.scope, isZh);
                const failureHint = describeScopeFailureHint(item.state.scope, item.state.lastError, isZh);
                return (
                  <Box
                    key={`${item.area}:${item.state.scope}`}
                    sx={{
                      p: 1,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                      display: 'grid',
                      gap: 0.75,
                    }}
                  >
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        <Chip size="small" label={item.area} variant="outlined" sx={compactChipSx} />
                        {item.state.lastError ? null : <Chip size="small" label={health.label} color={health.color} variant="outlined" sx={compactChipSx} />}
                        {item.state.errorCount > 0 ? <Chip size="small" label={isZh ? `失败 ${item.state.errorCount}` : `Errors ${item.state.errorCount}`} color="error" variant="outlined" sx={compactChipSx} /> : null}
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {targetInfo}
                      </Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {isZh
                        ? `检查：${formatTime(item.state.lastCheckedAt, isZh)} · 应用：${formatTime(item.state.lastAppliedAt, isZh)}`
                        : `Checked: ${formatTime(item.state.lastCheckedAt, isZh)} · Applied: ${formatTime(item.state.lastAppliedAt, isZh)}`}
                      {item.state.retryAt > Date.now()
                        ? (isZh ? ` · 重试：${formatTime(item.state.retryAt, isZh)}` : ` · Retry: ${formatTime(item.state.retryAt, isZh)}`)
                        : ''}
                    </Typography>
                    {item.state.lastError ? (
                      <Box sx={{ display: 'grid', gap: 0.35 }}>
                        <Typography variant="caption" color="error.main" sx={{ fontWeight: 700 }}>
                          {syncErrorKindLabel(errorInfo.kind, isZh)}
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, minWidth: 0 }}>
                          <Typography variant="body2" color="error.main" sx={{ overflowWrap: 'anywhere', minWidth: 0, lineHeight: 1.5 }}>
                            {errorInfo.message}
                          </Typography>
                          {failureHint ? (
                            <Tooltip title={failureHint} arrow>
                              <IconButton size="small" sx={{ color: 'text.secondary', p: 0.25, mt: '2px', alignSelf: 'flex-start', flexShrink: 0 }}>
                                <HelpOutlineIcon sx={{ fontSize: 14 }} />
                              </IconButton>
                            </Tooltip>
                          ) : null}
                        </Box>
                      </Box>
                    ) : null}
                    {item.state.lastError ? null : (
                      <Typography variant="caption" color="text.secondary">
                        {isZh ? '无异常记录' : 'No error recorded'}
                      </Typography>
                    )}
                  </Box>
                );
              })}
              {filteredSyncScopes.length > visibleSyncScopes.length ? (
                <Typography variant="caption" color="text.secondary">
                  {isZh ? `另有 ${filteredSyncScopes.length - visibleSyncScopes.length} 个 scope 未展开，可导出查看。` : `${filteredSyncScopes.length - visibleSyncScopes.length} more scopes are not expanded here. Export to inspect them.`}
                </Typography>
              ) : null}
            </Stack>
          )}
        </CardContent>
      </Card> : null}

      <Box sx={{ py: 1.5 }}>
        <Box sx={{ display: 'grid', gap: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {isZh ? '任务历史' : 'Task history'}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Chip size="small" label={isZh ? `已展示 ${historyShownCount} / 共 ${historyTotal}` : `Shown ${historyShownCount} / ${historyTotal}`} variant="outlined" sx={compactChipSx} />
              <Chip size="small" label={isZh ? `成功 ${historySucceededTotal}` : `Succeeded ${historySucceededTotal}`} variant="outlined" color={historySucceededTotal > 0 ? 'success' : 'default'} sx={compactChipSx} />
              <Chip size="small" label={isZh ? `失败 ${historyFailedTotal}` : `Failed ${historyFailedTotal}`} variant="outlined" color={historyFailedTotal > 0 ? 'error' : 'default'} sx={compactChipSx} />
            </Box>
          </Box>
          {artifactCloudCheckError ? <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => setArtifactCloudCheckRevision((value) => value + 1)}>{isZh ? '重新核对' : 'Check again'}</Button>}>
            {isZh ? '信件和日记的云端状态暂时无法核对。' : 'Could not check cloud status for letters and diaries.'}
          </Alert> : null}
          {artifactCloudUploadError ? <Alert severity="warning">{isZh ? '信件或日记尚未保存到云端，请稍后重试。' : 'Letters or diaries were not saved in cloud. Try again later.'}</Alert> : null}
          {historyError ? <Alert severity="error">{isZh ? `历史读取失败：${historyError}` : `Failed to load history: ${historyError}`}</Alert> : null}
          {isLoadingHistory ? (
            <Typography variant="body2" color="text.secondary">{isZh ? '正在加载任务历史…' : 'Loading task history...'}</Typography>
          ) : historyItems.length === 0 ? (
            <Typography variant="body2" color="text.secondary">{isZh ? '还没有历史记录。' : 'No history yet.'}</Typography>
          ) : (
            <Stack divider={<Divider />}>
              {historyItems.map((item) => {
                const localArtifact = item.resultId ? artifactStore.items.find((entry) => entry.id === item.resultId) : undefined;
                const remoteArtifact = item.resultId ? artifactCloudSummaries?.get(item.resultId) : undefined;
                const canUploadArtifact = item.scopeType === 'artifact' && item.status === 'succeeded'
                  && localArtifact?.deletedAt == null && Boolean(localArtifact)
                  && artifactCloudSummaries !== null && !artifactCloudCheckLoading && !artifactCloudCheckError
                  && authMode === 'cloud' && isCloudSyncEnabled()
                  && (!remoteArtifact || remoteArtifact.deletedAt == null && remoteArtifact.updatedAt < (localArtifact?.updatedAt || 0));
                return (
                <Box key={`history-${item.id}`} sx={{ px: 1, py: 1.25, display: 'grid', gap: 0.5 }}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start', gap: 1.5 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>
                      {taskTargetLabel(item,
                        item.scopeType === 'chat' || item.scopeType === 'message'
                          ? [...chatStore.chats, ...chatStore.remoteDeletedChats].find((chat) => chat.id === (item.scopeType === 'message' ? item.summaryKey : item.targetId))?.name
                          : characterStore.characters.find((character) => character.id === item.targetId)?.name,
                        isZh)}
                    </Typography>
                    <TaskTime value={item.updatedAt || item.createdAt} isZh={isZh} />
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="caption" color="text.secondary">{labelMap[item.scopeType] || item.scopeType} · {labelMap[item.kind] || item.kind}</Typography>
                    <Chip size="small" label={taskStatusLabel(item.scopeType, item.status, isZh, labelMap[item.status] || item.status)} color={item.status === 'failed' ? 'error' : 'success'} variant="outlined" sx={compactChipSx} />
                    {settingsStore.developerMode ? <Typography variant="caption" color="text.secondary">
                      {isZh ? `尝试 ${item.attemptCount} 次` : `${item.attemptCount} attempts`}
                    </Typography> : null}
                  </Box>
                  {item.scopeType === 'artifact' && item.status === 'succeeded' ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Typography variant="caption" color={canUploadArtifact || artifactCloudCheckError ? 'warning.main' : 'text.secondary'}>
                        {artifactCloudCheckError && item.resultId
                          ? (isZh ? '云端核对失败' : 'Cloud check failed')
                          : artifactCloudStatus(item, localArtifact?.updatedAt, remoteArtifact,
                              artifactCloudSummaries !== null, artifactCloudCheckLoading,
                              authMode === 'cloud' && isCloudSyncEnabled(), isZh)}
                      </Typography>
                      {canUploadArtifact ? <Button size="small" variant="text" disabled={retryingArtifactCloud} onClick={() => void retryArtifactCloud()}>
                        {retryingArtifactCloud ? (isZh ? '同步中…' : 'Syncing...') : (isZh ? '同步到云端' : 'Sync to cloud')}
                      </Button> : null}
                    </Box>
                  ) : null}
                  {item.lastError ? <Typography variant="body2" color="error.main" sx={{ overflowWrap: 'anywhere' }}>{resolveDisplayErrorClassification(item.lastError).message}</Typography> : null}
                </Box>
              );})}
              {historyHasMore ? (
                <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                  <Button size="small" variant="outlined" onClick={loadMoreHistory} disabled={isLoadingMoreHistory}>
                    {isLoadingMoreHistory ? (isZh ? '加载中…' : 'Loading...') : (isZh ? '加载更多' : 'Load more')}
                  </Button>
                </Box>
              ) : null}
            </Stack>
          )}
        </Box>
      </Box>
      </Box> : null}

      {resolutionError ? <Alert severity="error" sx={{ order: 1, mb: 1 }}>{resolutionError}</Alert> : null}
      {activeFilter !== 'history' ? <Box sx={{ order: 1 }}>
      {filteredItems.length === 0 ? (
        <EmptyState variant="plain" message={isQueueFilter(activeFilter) ? (isZh ? '当前筛选下没有匹配的同步队列' : 'No sync queue item matches the current filter') : (isZh ? '当前筛选不显示同步队列' : 'Sync queue items are hidden by the current filter')} />
      ) : (
        <Stack divider={<Divider />}>
          {filteredItems.map((item) => (
            <Box key={item.id} sx={{ px: 1, py: 1.5 }}>
              <Box sx={{ display: 'grid', gap: 0.75 }}>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start', gap: 1.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>
                    {item.targetLabel}
                  </Typography>
                  <TaskTime value={item.createdAt} isZh={isZh} />
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">{item.scope} · {labelMap[item.kind] || item.kind}</Typography>
                  <Chip size="small" label={taskStatusLabel(item.scopeType, item.status, isZh, labelMap[item.status] || item.status)} color={item.status === 'conflict' ? 'warning' : item.status === 'failed' ? 'error' : item.status === 'syncing' ? 'primary' : 'info'} variant="outlined" sx={compactChipSx} />
                  {settingsStore.developerMode ? <Typography variant="caption" color="text.secondary">
                    {isZh ? `尝试 ${item.attemptCount} 次` : `${item.attemptCount} attempts`}
                  </Typography> : null}
                </Box>
                {item.status === 'conflict' || item.scopeType === 'message' && item.exportPayload.localSnapshot?.content ? <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {item.summary}
                </Typography> : null}
                {item.status === 'conflict' && 'diffPreview' in item && item.diffPreview?.length ? (
                  <Box sx={{ display: 'grid', gap: 0.5 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                      {isZh ? '本地待提交字段' : 'Local pending fields'}
                    </Typography>
                    <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      {item.diffPreview.map((diff) => (
                        <Chip
                          key={`${item.id}:${diff.field}`}
                          size="small"
                          variant="outlined"
                          label={`${displayConflictField(diff.field, isZh)}: ${diff.value}`}
                          sx={{ ...compactChipSx, maxWidth: '100%', '& .MuiChip-label': { px: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 } }}
                        />
                      ))}
                    </Stack>
                  </Box>
                ) : null}
                {item.lastError ? (
                  <Typography variant="body2" color="error.main" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                    {item.scopeType === 'chat' && isUnavailableChatError(item.lastError)
                      ? (isZh ? '云端缺少这段聊天。本机仍有内容时，可重新上传。' : 'This chat is missing from the cloud. Upload it again if local content remains.')
                      : resolveDisplayErrorClassification(item.lastError).message}
                  </Typography>
                ) : null}
                {item.status === 'failed' || item.status === 'conflict' ? (
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
                    {settingsStore.developerMode ? <Button size="small" variant="outlined" onClick={() => exportItem(item)}>
                      {isZh ? '导出此项' : 'Export item'}
                    </Button> : null}
                    {item.status === 'failed' && item.scopeType === 'chat' && isUnavailableChatError(item.lastError)
                      && item.exportPayload.localSnapshot ? (
                      <Button size="small" variant="contained" onClick={() => {
                        setResolutionError(null);
                        if (!chatStore.queueMissingCloudChat(item.exportPayload.localSnapshot?.id || '')) {
                          setResolutionError(isZh ? '无法重新上传。请确认已开启云同步，且聊天及参与角色没有删除冲突。' : 'Cannot upload. Enable cloud sync and resolve any deletion conflicts for this chat or its characters.');
                        }
                      }}>
                        {isZh ? '重新上传' : 'Upload again'}
                      </Button>
                    ) : null}
                    {item.status === 'failed' ? (
                      <Button size="small" color="warning" onClick={() => discardFailed(item)}>
                        {isZh ? '移除' : 'Remove'}
                      </Button>
                    ) : null}
                    {item.status === 'conflict' && item.kind === 'field_update_conflict' ? (
                      <>
                        <Button size="small" variant="outlined" disabled={resolvingConflictId === item.id} onClick={() => void resolveFieldConflict(item, 'use_remote')}>
                          {isZh ? '采用云端' : 'Use cloud'}
                        </Button>
                        <Button size="small" variant="contained" disabled={resolvingConflictId === item.id} onClick={() => void resolveFieldConflict(item, 'keep_local')}>
                          {isZh ? '保留本地并同步' : 'Keep local and sync'}
                        </Button>
                      </>
                    ) : null}
                    {item.status === 'conflict' && item.kind === 'delete_edit_conflict' && (item.scopeType === 'character' || item.scopeType === 'chat') ? (
                      <>
                        <Button size="small" color="warning" onClick={() => resolveDeleteEditConflict(item, 'discard_local')}>
                          {isZh ? '放弃本地改动' : 'Discard local edits'}
                        </Button>
                        <Button size="small" variant="outlined" color="warning" onClick={() => resolveDeleteEditConflict(item, 'save_as_new')}>
                          {isZh ? '另存为新对象' : 'Save as new'}
                        </Button>
                        <Button size="small" variant="contained" color="warning" onClick={() => resolveDeleteEditConflict(item, 'restore_local')}>
                          {isZh ? '恢复本地编辑' : 'Restore local edits'}
                        </Button>
                      </>
                    ) : null}
                  </Box>
                ) : null}
              </Box>
            </Box>
          ))}
        </Stack>
      )}
      </Box> : null}
      </Box>
      <ConfirmDialog
        open={confirmClearTasks}
        title={isZh ? '清空当前任务' : 'Clear current tasks'}
        message={isZh
          ? `清空当前筛选中的 ${selectedTasks.length} 个任务。本地内容保留，未上传的改动将停止同步。${hasSelectedRunningTasks ? '仍有任务正在同步，请完成后再清空。' : ''}`
          : `Clear ${selectedTasks.length} tasks in this filter. Local content stays, and unsent changes stop syncing.${hasSelectedRunningTasks ? ' Wait for running tasks to finish.' : ''}`}
        onCancel={() => setConfirmClearTasks(false)}
        onConfirm={() => { if (!hasSelectedRunningTasks) clearSelectedTasks(); }}
        destructive
      />
    </Box>
  );
}
