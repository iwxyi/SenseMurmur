import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { GroupChat } from '../types/chat';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { getCalendarStateEventIds } from '../services/runtimeEventRetention';
import { useCharacterStore } from './useCharacterStore';
import { api, type SyncChangeScope } from '../services/api';
import { buildApiErrorUserMessage } from '../services/apiErrorMessage';
import { reportRecoverableError, reportRecoverableWarning } from '../services/diagnostics';
import { projectEntities, type SyncPatchOperation } from '../services/syncProjector';
import { clearResolvedFieldConflicts, detectPendingFieldConflicts, type FieldConflictRecord } from '../services/syncConflictRecords';
import { buildWarmState } from './storeWarmHelpers';
import { createScopedIndexedDbBufferedJsonStorage, createScopedIndexedDbStorage, flushBufferedPersistenceWrites } from './storePersistenceScope';
import { createSyncScheduler } from './storeSyncScheduler';
import { createSyncScopeMetadata, type SyncScopeSnapshot } from './syncScopeMetadata';
import { createGuestUploadFlag } from './storeGuestUpload';
import { CLIENT_STORE_SCHEMA_VERSION, migrateChatStoreState } from './storeMigrations';
import { scopedStorageKey, storageKey } from '../constants/brand';
import { getLocalDataUserId } from '../services/authStorageScope';
import { completeLocalOutboxWorkerOperation, markLocalOutboxWorkerOperation, mirrorLocalOutboxWorkerQueue, removeLocalOutboxWorkerOperation } from '../services/localOutboxWorkerBridge';
import {
  canAttemptOnlineSync,
  classifySyncError,
  createPendingOperation,
  getPendingQueueWorkerPriority,
  isTerminalSyncError,
  latestSyncError,
  getCloudSyncSkipDiagnostics,
  recoverInterruptedOperations,
  removePendingOperation,
  retryFailedOperations,
  runPendingOperationQueue,
  shouldSkipCloudSync,
  updatePendingOperation,
} from './storeSyncHelpers';
import { DEFAULT_BASIC_RETENTION_LIMITS, getCurrentRetentionLimits, takeRecentByLimit } from '../services/retentionLimits';
import { useLocalWorkspaceStore } from './useLocalWorkspaceStore';
import { logDeveloperDiagnostic } from '../services/developerDiagnostics';
import { sanitizeChatLatestMessage } from '../services/chatLatestMessage';
import { buildChatRuntimeDeltaPatch } from '../services/chatRuntimeDelta';

function createLocalChatId() {
  return `local-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function applyLocalChatCreate(chatData: Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'>) {
  const now = Date.now();
  return normalizeConversation({
    ...chatData,
    id: createLocalChatId(),
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  } as GroupChat);
}

function buildPatchedFieldVersions(chat: GroupChat, updates: Partial<GroupChat>, versionAt: number) {
  const ignoredFields = new Set(['createdAt', 'updatedAt', 'lastMessageAt', 'latestMessage', 'runtimeDetailLoaded', 'runtimeDetailHydratedAt', 'worldRuntimeLoaded']);
  const fieldVersions = { ...(chat.fieldVersions || {}) };
  for (const field of Object.keys(updates)) {
    if (ignoredFields.has(field)) continue;
    fieldVersions[field] = Math.max(fieldVersions[field] || 0, versionAt);
  }
  return fieldVersions;
}

function applyLocalChatUpdate(chat: GroupChat, updates: Partial<GroupChat>, versionAt = Date.now()) {
  const cleanUpdates = sanitizeChatLatestPatch(chat, updates);
  return normalizeConversation({
    ...chat,
    ...cleanUpdates,
    fieldVersions: buildPatchedFieldVersions(chat, cleanUpdates, versionAt),
    updatedAt: versionAt,
    lastMessageAt: cleanUpdates.lastMessageAt ?? chat.lastMessageAt,
  });
}

function sanitizeChatLatestPatch(chat: GroupChat | undefined, updates: Partial<GroupChat>) {
  if (!Object.prototype.hasOwnProperty.call(updates, 'latestMessage')) return updates;
  const nextUpdates = { ...updates };
  const nextLatest = sanitizeChatLatestMessage(updates.latestMessage);
  if (nextLatest) {
    nextUpdates.latestMessage = nextLatest;
    return nextUpdates;
  }
  const previousLatest = sanitizeChatLatestMessage(chat?.latestMessage);
  nextUpdates.latestMessage = previousLatest;
  if (Object.prototype.hasOwnProperty.call(updates, 'lastMessageAt')) {
    nextUpdates.lastMessageAt = previousLatest?.timestamp ?? chat?.lastMessageAt ?? updates.lastMessageAt;
  }
  return nextUpdates;
}

function applyLocalChatDelete(chat: GroupChat) {
  return normalizeConversation({
    ...chat,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function prepareAssistantLocalWorkspaceChatRename(id: string, updates: Partial<GroupChat>, chats: GroupChat[]) {
  if (typeof updates.name !== 'string') return;
  const existing = chats.find((chat) => chat.id === id);
  if (!existing || existing.type !== 'assistant') return;
  const nextName = updates.name.trim();
  const previousName = existing.name || '';
  if (!nextName || nextName === previousName) return;
  const workspace = useLocalWorkspaceStore.getState();
  if (workspace.isChatWriteLocked(id)) {
    throw new Error('本地产物正在读写，请稍后再修改聊天名称');
  }
  if (!workspace.getDefaultDirectory()) return;
  const artifactModule = await import('./useAssistantArtifactStore');
  const artifacts = artifactModule.useAssistantArtifactStore.getState().getArtifactsForChat(id);
  await workspace.mirrorAssistantChatRename({
    chat: { ...existing, name: nextName },
    previousChatName: previousName,
    artifacts,
  });
}

function applyLocalChatRestore(chat: GroupChat) {
  return normalizeConversation({
    ...chat,
    deletedAt: null,
    isActive: true,
    updatedAt: Date.now(),
  });
}

function applyLocalChatPurge(chats: GroupChat[], ids: string[]) {
  const normalizedIds = new Set(ids);
  return chats.filter((chat) => !normalizedIds.has(chat.id));
}

function createConflictCopyChatData(chat: GroupChat): Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'> {
  const data = { ...chat } as Partial<GroupChat>;
  delete data.id;
  delete data.createdAt;
  delete data.updatedAt;
  delete data.lastMessageAt;
  delete data.deletedAt;
  delete data.fieldVersions;
  delete data.latestMessage;
  delete data.runtimeDetailLoaded;
  delete data.runtimeDetailHydratedAt;
  delete data.worldRuntimeLoaded;
  return {
    ...data,
    name: `${chat.name || '未命名聊天'}（本地副本）`,
    sourceChatId: chat.sourceChatId || chat.id,
    sourceMemberIds: chat.sourceMemberIds?.length ? chat.sourceMemberIds : chat.memberIds,
    deletedAt: null,
  } as Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'>;
}

function applyLocalEmptyDeletedChats(chats: GroupChat[]) {
  return chats.filter((chat) => chat.deletedAt == null);
}

const guestChatUploadFlag = createGuestUploadFlag<GroupChat>(
  storageKey('guest-chats-upload-pending'),
);

function migrateGuestChatsToCloud(chats: GroupChat[]) {
  guestChatUploadFlag.write(chats);
}

function clearGuestChatUploadFlag() {
  guestChatUploadFlag.clear();
}

function readGuestChatUploadFlag(): GroupChat[] {
  return guestChatUploadFlag.read();
}

async function flushGuestChatsToCloud(addChatRemote: (chat: Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'>) => Promise<GroupChat>) {
  const pending = readGuestChatUploadFlag();
  if (!pending.length) return;
  for (const chat of pending) {
    await addChatRemote({
      ...chat,
      sourceChatId: chat.sourceChatId || null,
      sourceMemberIds: chat.sourceMemberIds || [],
    });
  }
  clearGuestChatUploadFlag();
}

type ChatCreatePayload = Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'> & { id?: string; operationId?: string };

async function createChatRemote(chatData: ChatCreatePayload) {
  const result = await api.createChat({
    id: chatData.id,
    operationId: chatData.operationId,
    type: chatData.type,
    mode: chatData.mode,
    modeConfig: chatData.modeConfig,
    modeState: chatData.modeState,
    sessionKind: chatData.sessionKind,
    scenarioState: chatData.scenarioState,
    channels: chatData.channels,
    layoutState: chatData.layoutState,
    scenarioPackage: chatData.scenarioPackage,
    judgeAgent: chatData.judgeAgent,
    layeredGrowth: chatData.layeredGrowth,
    modeStateSummary: chatData.modeStateSummary,
    memoryLayerSummary: chatData.memoryLayerSummary,
    growthSnapshots: chatData.growthSnapshots,
    roleMemorySummaries: chatData.roleMemorySummaries,
    scenarioMemorySummary: chatData.scenarioMemorySummary,
    topologySummary: chatData.topologySummary,
    name: chatData.name,
    topic: chatData.topic,
    style: chatData.style,
    memberIds: chatData.memberIds,
    speed: chatData.speed,
    isActive: chatData.isActive,
    allowIntervention: chatData.allowIntervention,
    showRoleActions: chatData.showRoleActions,
    topicSeed: chatData.topicSeed,
    sourceChatId: chatData.sourceChatId,
    sourceMemberIds: chatData.sourceMemberIds,
    runtimeSeed: chatData.runtimeSeed,
    layeredMemories: chatData.layeredMemories,
    runtimeTimeline: chatData.runtimeTimeline,
    runtimeEventsV2: chatData.runtimeEventsV2,
    relationshipLedger: chatData.relationshipLedger,
    relationshipStructure: chatData.relationshipStructure,
    governance: chatData.governance,
    dramaRules: chatData.dramaRules,
    worldState: chatData.worldState,
    directorControls: chatData.directorControls,
    messageBranchState: chatData.messageBranchState,
  });
  return normalizeConversation(result as unknown as GroupChat);
}

interface PendingChatOperation extends SyncPatchOperation<Record<string, unknown>> {
  kind: 'create' | 'patch';
  targetIds: string[];
}

function pendingChatOperationPriority(operation: PendingChatOperation) {
  if (operation.kind === 'create') return 100;
  if ('deletedAt' in operation.patch) return 80;
  return 10;
}

interface PersistedChatState {
  chats: GroupChat[];
  currentChatId: string | null;
  lastSyncedAt: number;
  pendingOperations: PendingChatOperation[];
  fieldConflicts?: FieldConflictRecord[];
}

const COMPANIONSHIP_STATE_HISTORY_PER_KEY = 4;
const MAX_PERSISTED_DATA_URL_CHARS = 2048;

function isInlineDataUrl(value: string) {
  return /^data:[^;]+;base64,/i.test(value);
}

function shouldDropPersistedString(key: string, value: string) {
  const normalizedKey = key.toLowerCase();
  return isInlineDataUrl(value) && (value.length > MAX_PERSISTED_DATA_URL_CHARS || normalizedKey.includes('dataurl') || normalizedKey === 'url' || normalizedKey.endsWith('url'));
}

function stripLargeInlineMediaForPersistence<T>(value: T, key = '', seen = new WeakSet<object>()): T {
  if (typeof value === 'string') {
    return (shouldDropPersistedString(key, value) ? undefined : value) as T;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined as T;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .map((item) => stripLargeInlineMediaForPersistence(item, key, seen))
        .filter((item) => item !== undefined) as T;
    }
    const source = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    Object.entries(source).forEach(([entryKey, entryValue]) => {
      const stripped = stripLargeInlineMediaForPersistence(entryValue, entryKey, seen);
      if (stripped !== undefined) next[entryKey] = stripped;
    });
    return next as T;
  } finally {
    // Shared references are valid; only an ancestor reference forms a cycle.
    seen.delete(value);
  }
}

function getRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function getRecordStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function getCompanionshipRuntimeEventStateKey(event: RuntimeEventV2) {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  const eventType = typeof payload?.eventType === 'string' ? payload.eventType : '';
  if (!eventType.startsWith('companionship_')) return '';
  const payloadRecord = payload as Record<string, unknown>;
  if (eventType === 'companionship_private_thread_schedule') {
    const participantKey = getRecordStringArray(payloadRecord, 'participantIds').sort().join('::');
    return `${eventType}:${participantKey || getRecordString(payloadRecord, 'dedupeKey') || event.id}`;
  }
  const characterId = getRecordString(payloadRecord, 'characterId') || event.actorIds?.[0] || 'unknown-character';
  const userId = getRecordString(payloadRecord, 'userId') || event.targetIds?.[0] || 'default-user';
  const baseKey = `${eventType}:${characterId}:${userId}`;
  if (eventType === 'companionship_care_topic') return `${baseKey}:${getRecordString(payloadRecord, 'topicId') || event.id}`;
  if (eventType === 'companionship_promise') return `${baseKey}:${getRecordString(payloadRecord, 'promiseId') || event.id}`;
  if (eventType === 'companionship_ritual') return `${baseKey}:${getRecordString(payloadRecord, 'ritualId') || getRecordString(payloadRecord, 'kind') || event.id}`;
  if (eventType === 'companionship_shared_secret') return `${baseKey}:${getRecordString(payloadRecord, 'secretId') || event.id}`;
  if (eventType === 'companionship_shared_phrase') return `${baseKey}:${getRecordString(payloadRecord, 'phraseId') || event.id}`;
  if (eventType === 'companionship_shared_anchor') return `${baseKey}:${getRecordString(payloadRecord, 'anchorId') || event.id}`;
  if (eventType === 'companionship_diary_reflection') return `${baseKey}:${getRecordString(payloadRecord, 'reflectionId') || event.id}`;
  if (eventType === 'companionship_user_profile_memory') {
    const items = Array.isArray(payloadRecord.items) ? payloadRecord.items as Array<Record<string, unknown>> : [];
    const signature = items
      .map((item) => `${getRecordString(item, 'kind')}:${getRecordString(item, 'text').slice(0, 48)}`)
      .filter(Boolean)
      .join('|');
    return `${baseKey}:${signature || event.id}`;
  }
  return baseKey;
}

function compactRuntimeEventsForPersistence(events: RuntimeEventV2[] | undefined, limit: number): RuntimeEventV2[] {
  if (!Array.isArray(events)) return [];
  if (events.length <= limit) return stripLargeInlineMediaForPersistence(events);
  const calendarIds = getCalendarStateEventIds(events);
  const calendarEvents = events.filter((event) => calendarIds.has(event.id));
  const historyEvents = events.filter((event) => !calendarIds.has(event.id));
  const stateHistoryEvents = new Map<string, RuntimeEventV2[]>();
  for (const event of historyEvents) {
    const key = getCompanionshipRuntimeEventStateKey(event);
    if (!key) continue;
    const history = stateHistoryEvents.get(key) || [];
    history.push(event);
    stateHistoryEvents.set(
      key,
      history
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, COMPANIONSHIP_STATE_HISTORY_PER_KEY),
    );
  }
  const selected = new Map<string, RuntimeEventV2>();
  const addEvent = (event: RuntimeEventV2) => selected.set(event.id, event);
  [...stateHistoryEvents.values()]
    .flat()
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit)
    .forEach(addEvent);
  for (let index = historyEvents.length - 1; index >= 0 && selected.size < limit; index -= 1) {
    addEvent(historyEvents[index]);
  }
  calendarEvents.forEach(addEvent);
  return stripLargeInlineMediaForPersistence(
    Array.from(selected.values()).sort((left, right) => left.createdAt - right.createdAt),
  );
}

function mergeRuntimeEventsForSync(localEvents: RuntimeEventV2[] | undefined, remoteEvents: RuntimeEventV2[] | undefined) {
  if (!localEvents?.length) return remoteEvents || [];
  if (!remoteEvents?.length) return localEvents;
  const byId = new Map<string, RuntimeEventV2>();
  [...localEvents, ...remoteEvents].forEach((event) => byId.set(event.id, event));
  return compactRuntimeEventsForPersistence(
    Array.from(byId.values()).sort((left, right) => left.createdAt - right.createdAt),
    getCurrentRetentionLimits().runtimeEventsV2.storage,
  );
}

function mergeFieldVersionsForSync(local: GroupChat | undefined, remote: GroupChat | undefined) {
  const result = { ...(remote?.fieldVersions || {}) };
  for (const [field, version] of Object.entries(local?.fieldVersions || {})) {
    result[field] = Math.max(result[field] || 0, version || 0);
  }
  return result;
}

function isRemoteChatFieldNewer(local: GroupChat | undefined, remote: GroupChat, field: keyof GroupChat & string) {
  if (!local) return true;
  return (remote.fieldVersions?.[field] || 0) > (local.fieldVersions?.[field] || 0);
}

function mergeMessageBranchStateForSync(local: GroupChat | undefined, remote: GroupChat, fallback: 'local' | 'remote') {
  if (!local) return remote.messageBranchState ?? null;
  const localVersion = local.fieldVersions?.messageBranchState || 0;
  const remoteVersion = remote.fieldVersions?.messageBranchState || 0;
  if (remoteVersion > localVersion) return remote.messageBranchState ?? null;
  if (localVersion > remoteVersion) return local.messageBranchState ?? null;
  if (local.messageBranchState && !remote.messageBranchState) return local.messageBranchState;
  if (remote.messageBranchState && !local.messageBranchState) return remote.messageBranchState;
  return fallback === 'remote' ? remote.messageBranchState ?? null : local.messageBranchState ?? null;
}

function compactRuntimeSeedForPersistence(runtimeSeed: GroupChat['runtimeSeed']): GroupChat['runtimeSeed'] {
  const limits = getCurrentRetentionLimits();
  return {
    notes: takeRecentByLimit(runtimeSeed?.notes, limits.runtimeSeedNotes.storage),
    artifacts: takeRecentByLimit(runtimeSeed?.artifacts, limits.runtimeSeedArtifacts.storage),
  };
}

function compactChatRuntimeFieldsForPersistence<T extends Partial<GroupChat>>(chat: T): T {
  const limits = getCurrentRetentionLimits();
  return {
    ...chat,
    ...(chat.layeredMemories !== undefined ? {
      layeredMemories: takeRecentByLimit(chat.layeredMemories, limits.chatLayeredMemories.storage),
    } : {}),
    ...(chat.runtimeSeed !== undefined ? {
      runtimeSeed: compactRuntimeSeedForPersistence(chat.runtimeSeed),
    } : {}),
    ...(chat.roleMemorySummaries !== undefined ? {
      roleMemorySummaries: takeRecentByLimit(chat.roleMemorySummaries, limits.roleMemorySummaries.storage),
    } : {}),
    ...(chat.growthSnapshots !== undefined ? {
      growthSnapshots: takeRecentByLimit(chat.growthSnapshots, limits.growthSnapshots.storage),
    } : {}),
    ...(chat.runtimeTimeline !== undefined ? {
      runtimeTimeline: takeRecentByLimit(chat.runtimeTimeline, limits.runtimeTimeline.storage),
    } : {}),
    ...(chat.runtimeEventsV2 !== undefined ? {
      runtimeEventsV2: compactRuntimeEventsForPersistence(chat.runtimeEventsV2, limits.runtimeEventsV2.storage),
    } : {}),
    ...(chat.relationshipLedger !== undefined ? {
      relationshipLedger: takeRecentByLimit(chat.relationshipLedger, limits.relationshipLedger.storage),
    } : {}),
  };
}

function compactGroupVisualForCloud(value: unknown): GroupChat['groupVisual'] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const visual = value as Record<string, unknown>;
  const avatarUrl = typeof visual.avatarUrl === 'string' && visual.avatarUrl.trim() ? visual.avatarUrl.trim() : null;
  const backgroundUrl = typeof visual.backgroundUrl === 'string' && visual.backgroundUrl.trim() ? visual.backgroundUrl.trim() : null;
  const rawOpacity = visual.backgroundOpacity;
  const backgroundOpacity = typeof rawOpacity === 'number' && Number.isFinite(rawOpacity)
    ? Math.min(1, Math.max(0.05, rawOpacity))
    : null;
  return {
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(backgroundUrl ? { backgroundUrl } : {}),
    ...(backgroundUrl && backgroundOpacity != null ? { backgroundOpacity } : {}),
  };
}

function compactChatPatchForCloud(patch: PendingChatOperation['patch'] | Partial<GroupChat>): Partial<GroupChat> & Record<string, unknown> {
  if (!patch || typeof patch !== 'object') return {};
  const nextPatch: Partial<GroupChat> & Record<string, unknown> = compactChatRuntimeFieldsForPersistence({ ...patch });
  delete nextPatch.updatedAt;
  delete nextPatch.lastMessageAt;
  delete nextPatch.runtimeDetailHydratedAt;
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'groupVisual')) {
    nextPatch.groupVisual = compactGroupVisualForCloud(nextPatch.groupVisual);
  }
  return nextPatch;
}

function isRuntimeMemoryDiagnosticsEnabled() {
  return typeof localStorage !== 'undefined'
    && localStorage.getItem(scopedStorageKey('runtime-memory-monitor')) === '1';
}

function recordRuntimeMemoryDiagnostic(label: string, params: Parameters<typeof import('../services/runtimeMemoryMonitor')['recordRuntimeMemory']>[1]) {
  if (!isRuntimeMemoryDiagnosticsEnabled()) return;
  void import('../services/runtimeMemoryMonitor').then(({ recordRuntimeMemory }) => {
    recordRuntimeMemory(label, params);
  });
}

function buildPersistedChatState(state: PersistedChatState): PersistedChatState {
  if (shouldSkipCloudSync()) return state;
  if (isRuntimeMemoryDiagnosticsEnabled()) {
    recordRuntimeMemoryDiagnostic('chat-store:partialize:start', {
      extra: {
        chatCount: state.chats.length,
        pendingOperationCount: state.pendingOperations.length,
      },
    });
  }
  const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  const persisted = {
    chats: state.chats.map((chat) => normalizeConversation({
      ...compactChatRuntimeFieldsForPersistence(chat),
      runtimeDetailLoaded: isChatRuntimeDetailLoaded(chat),
      worldRuntimeLoaded: Boolean(chat.worldRuntimeLoaded),
    } as GroupChat)),
    currentChatId: state.currentChatId,
    lastSyncedAt: state.lastSyncedAt,
    pendingOperations: recoverInterruptedOperations(state.pendingOperations)
      .map((operation) => ({
        ...operation,
        patch: compactChatPatchForCloud(operation.patch),
      }))
      .filter((operation) => Object.keys(operation.patch || {}).length > 0),
    fieldConflicts: state.fieldConflicts || [],
  };
  if (isRuntimeMemoryDiagnosticsEnabled()) {
    recordRuntimeMemoryDiagnostic('chat-store:partialize:finish', {
      extra: {
        chatCount: persisted.chats.length,
        pendingOperationCount: persisted.pendingOperations.length,
        elapsedMs: typeof performance !== 'undefined' ? Math.round((performance.now() - startedAt) * 10) / 10 : 0,
      },
    });
  }
  return persisted;
}

interface ChatStore extends PersistedChatState {
  isLoading: boolean;
  pendingEditSyncCount: number;
  pendingEditSyncError: string | null;
  remoteDeletedChatIds: string[];
  remoteDeletedChats: GroupChat[];
  fieldConflicts: FieldConflictRecord[];
  chatSummaryLoadedAt: number;
  loadChats: (options?: { waitForCloud?: boolean }) => Promise<void>;
  loadChat: (id: string) => Promise<GroupChat | null>;
  loadWorldRuntime: () => Promise<void>;
  prefetchChats: () => Promise<void>;
  prefetchWorldRuntime: () => Promise<void>;
  restoreLocalChats: () => Promise<void>;
  refreshChatSummaryFromCloud: () => Promise<void>;
  flushPendingOperations: () => Promise<void>;
  queuePatch: (entityId: string, patch: Record<string, unknown>, kind?: PendingChatOperation['kind']) => void;
  loadProjectedDeletedChats: () => Promise<GroupChat[]>;
  loadProjectedChats: () => Promise<GroupChat[]>;
  loadProjectedState: () => Promise<void>;
  getPendingOperations: () => PendingChatOperation[];
  getPendingEditError: () => string | null;
  getPendingEditCount: () => number;
  clearPendingOperations: () => void;
  clearPendingOperationsForChat: (chatId: string) => void;
  confirmCreateOperationsSynced: (entityIds: string[]) => void;
  discardFailedOperation: (operationId: string) => void;
  resolveRemoteDeleteConflict: (id: string, resolution: 'restore_local' | 'discard_local' | 'save_as_new') => Promise<void>;
  retryFailedOperations: () => void;
  loadPendingSnapshot: () => Promise<GroupChat[]>;
  loadProjectedRecycleBin: () => Promise<GroupChat[]>;
  hydrateProjectedState: () => void;
  resumeSync: () => void;
  syncPatch: (entityId: string, patch: Record<string, unknown>, kind?: PendingChatOperation['kind']) => Promise<void>;
  loadProjectedVisibleChats: () => Promise<GroupChat[]>;
  addChat: (chat: Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'>) => Promise<GroupChat>;
  updateChat: (id: string, updates: Partial<GroupChat>) => Promise<void>;
  applyChatRuntimePatch: (id: string, buildPatch: (chat: GroupChat) => Partial<GroupChat> | null) => Promise<boolean>;
  applyChatRuntimeDelta: (id: string, delta: NonNullable<import('../types/chat').DriverMessageCommitTransition['chatRuntimeDelta']>, patch?: Partial<GroupChat>) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  restoreChats: (ids: string[]) => Promise<void>;
  purgeChats: (ids: string[]) => Promise<void>;
  emptyDeletedChats: () => Promise<void>;
  loadDeletedChats: () => Promise<GroupChat[]>;
  setCurrentChat: (id: string | null) => void;
  getCurrentChat: () => GroupChat | undefined;
  getChat: (id: string) => GroupChat | undefined;
  hasChatLoaded: (id: string) => boolean;
  getChatsLoadedAt: () => number;
  getSyncScopeStates: () => SyncScopeSnapshot[];
  markChatsWarm: () => void;
}

function getUserId() {
  return getLocalDataUserId();
}

function getChatStorageKey() {
  return scopedStorageKey(`chats-${getUserId()}`);
}

function getChatStoreStorageName() {
  return scopedStorageKey('chats');
}

function createChatStorageForKey(key: string) {
  return createScopedIndexedDbStorage({
    getScopedKey: () => key,
    storageName: getChatStoreStorageName(),
  });
}

function normalizeChats(items: GroupChat[]) {
  return items.map((item) => {
    const chat = normalizeConversation(item);
    return {
      ...chat,
      latestMessage: sanitizeChatLatestMessage(chat.latestMessage),
    };
  });
}

function hasText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasArrayItems(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function hasRecordDetail(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).some((item) => (
    hasText(item)
    || hasArrayItems(item)
    || (item && typeof item === 'object' && !Array.isArray(item) && hasRecordDetail(item))
  ));
}

function hasChatRuntimeDetailEvidence(chat: GroupChat | undefined) {
  return Boolean(chat && (
    (typeof chat.runtimeDetailHydratedAt === 'number' && chat.runtimeDetailHydratedAt > 0)
    || hasText(chat.topicSeed)
    || hasArrayItems(chat.layeredMemories)
    || hasArrayItems(chat.runtimeTimeline)
    || hasArrayItems(chat.runtimeEventsV2)
    || hasArrayItems(chat.relationshipLedger)
    || hasArrayItems(chat.growthSnapshots)
    || hasRecordDetail(chat.runtimeSeed)
  ));
}

function isChatRuntimeDetailLoaded(chat: GroupChat | undefined) {
  if (!chat) return false;
  if (chat.runtimeDetailLoaded === false) return false;
  return hasChatRuntimeDetailEvidence(chat);
}

function markChatRuntimeDetailLoaded(chat: GroupChat) {
  return {
    ...chat,
    runtimeDetailLoaded: true,
    runtimeDetailHydratedAt: chat.runtimeDetailHydratedAt || Date.now(),
  };
}

function sortChats(chats: GroupChat[]) {
  return [...chats].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

function getErrorStatus(error: unknown) {
  return typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : null;
}

function getErrorCode(error: unknown) {
  return typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : null;
}

function buildChatListSignature(chats: GroupChat[]) {
  return chats
    .map((chat) => [
      chat.id,
      chat.updatedAt || 0,
      chat.lastMessageAt || 0,
      chat.deletedAt || 0,
      chat.latestMessage?.id || '',
      chat.latestMessage?.timestamp || 0,
      chat.latestMessage?.content || '',
      chat.runtimeDetailLoaded ? 1 : 0,
      chat.runtimeDetailHydratedAt || 0,
      chat.worldRuntimeLoaded ? 1 : 0,
      JSON.stringify(chat.sessionKind || {}),
      JSON.stringify(chat.modeState || {}),
      JSON.stringify(chat.modeStateSummary || {}),
      chat.runtimeEventsV2?.at(-1)?.id || '',
      chat.runtimeEventsV2?.length || 0,
      chat.relationshipLedger?.length || 0,
    ].join(':'))
    .join('|');
}

function mergeChatRecord(local: GroupChat | undefined, remote: GroupChat) {
  const remoteHasDetail = remote.runtimeDetailLoaded === true;
  const localHasDetail = isChatRuntimeDetailLoaded(local);
  if (!local) {
    return {
      ...remote,
      runtimeDetailLoaded: remoteHasDetail,
    };
  }
  if (!remoteHasDetail) {
    if (!localHasDetail) {
      return {
        ...remote,
        type: remote.memberIds?.length ? remote.type : local.type,
        memberIds: remote.memberIds?.length ? remote.memberIds : local.memberIds,
        sourceChatId: remote.sourceChatId ?? local.sourceChatId,
        sourceMemberIds: remote.sourceMemberIds?.length ? remote.sourceMemberIds : local.sourceMemberIds,
        fieldVersions: mergeFieldVersionsForSync(local, remote),
        messageBranchState: mergeMessageBranchStateForSync(local, remote, 'remote'),
        runtimeDetailLoaded: false,
      };
    }
    return {
      ...local,
      id: remote.id,
      type: remote.memberIds?.length ? remote.type : local.type,
      mode: remote.mode,
      name: remote.name,
      topic: remote.topic,
      style: remote.style,
      runtimeEvolutionIntensity: remote.runtimeEvolutionIntensity,
      memberIds: remote.memberIds?.length ? remote.memberIds : local.memberIds,
      sourceChatId: remote.sourceChatId ?? local.sourceChatId,
      sourceMemberIds: remote.sourceMemberIds?.length ? remote.sourceMemberIds : local.sourceMemberIds,
      memberCharacterSummaries: remote.memberCharacterSummaries?.length ? remote.memberCharacterSummaries : local.memberCharacterSummaries,
      speed: remote.speed,
      isActive: remote.isActive,
      allowIntervention: remote.allowIntervention,
      showRoleActions: remote.showRoleActions,
      topicSeed: remote.topicSeed,
      deletedAt: remote.deletedAt,
      fieldVersions: mergeFieldVersionsForSync(local, remote),
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
      lastMessageAt: remote.lastMessageAt,
      latestMessage: remote.latestMessage,
      messageBranchState: mergeMessageBranchStateForSync(local, remote, 'remote'),
      runtimeDetailLoaded: true,
    };
  }
  if (local.updatedAt >= remote.updatedAt) {
    if (localHasDetail) {
      return {
        ...local,
        memberCharacterSummaries: remote.memberCharacterSummaries?.length ? remote.memberCharacterSummaries : local.memberCharacterSummaries,
        fieldVersions: mergeFieldVersionsForSync(local, remote),
        runtimeEventsV2: mergeRuntimeEventsForSync(local.runtimeEventsV2, remote.runtimeEventsV2),
        messageBranchState: mergeMessageBranchStateForSync(local, remote, 'local'),
        runtimeDetailLoaded: true,
      };
    }
    return {
      ...remote,
      id: local.id,
      type: local.type,
      mode: local.mode,
      name: local.name,
      topic: local.topic,
      style: local.style,
      runtimeEvolutionIntensity: local.runtimeEvolutionIntensity,
      memberIds: local.memberIds,
      sourceChatId: local.sourceChatId,
      sourceMemberIds: local.sourceMemberIds,
      memberCharacterSummaries: remote.memberCharacterSummaries?.length ? remote.memberCharacterSummaries : local.memberCharacterSummaries,
      speed: local.speed,
      isActive: local.isActive,
      allowIntervention: local.allowIntervention,
      showRoleActions: local.showRoleActions,
      topicSeed: local.topicSeed,
      deletedAt: local.deletedAt,
      fieldVersions: mergeFieldVersionsForSync(local, remote),
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
      lastMessageAt: local.lastMessageAt,
      worldState: local.worldState,
      latestMessage: local.latestMessage,
      runtimeEventsV2: mergeRuntimeEventsForSync(local.runtimeEventsV2, remote.runtimeEventsV2),
      messageBranchState: mergeMessageBranchStateForSync(local, remote, 'local'),
      runtimeDetailLoaded: true,
    };
  }
  return {
    ...remote,
    type: remote.memberIds?.length ? remote.type : local.type,
    memberIds: remote.memberIds?.length ? remote.memberIds : local.memberIds,
    sourceChatId: remote.sourceChatId ?? local.sourceChatId,
    sourceMemberIds: remote.sourceMemberIds?.length ? remote.sourceMemberIds : local.sourceMemberIds,
    runtimeEventsV2: mergeRuntimeEventsForSync(local.runtimeEventsV2, remote.runtimeEventsV2),
    fieldVersions: mergeFieldVersionsForSync(local, remote),
    messageBranchState: mergeMessageBranchStateForSync(local, remote, 'remote'),
    runtimeDetailLoaded: true,
  };
}

function mergeWorldRuntimeRecord(local: GroupChat | undefined, remote: GroupChat) {
  if (!local || !isChatRuntimeDetailLoaded(local)) return remote;
  return {
    ...local,
    worldRuntimeLoaded: true,
    runtimeEventsV2: mergeRuntimeEventsForSync(local.runtimeEventsV2, remote.runtimeEventsV2),
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    lastMessageAt: Math.max(local.lastMessageAt || 0, remote.lastMessageAt || 0),
  };
}

function mergeChats(localChats: GroupChat[], remoteChats: GroupChat[], pendingOperations: PendingChatOperation[] = []) {
  const merged = new Map<string, GroupChat>();

  for (const chat of normalizeChats(localChats)) merged.set(chat.id, chat);

  for (const remote of normalizeChats(remoteChats)) {
    const local = merged.get(remote.id);
    const fillsMissingDetail = Boolean(remote.runtimeDetailLoaded && !isChatRuntimeDetailLoaded(local));
    const fillsMissingWorldRuntime = Boolean(remote.worldRuntimeLoaded && !local?.worldRuntimeLoaded);
    const remoteBranchStateNewer = isRemoteChatFieldNewer(local, remote, 'messageBranchState');
    if (!local || remote.updatedAt > local.updatedAt || fillsMissingDetail || fillsMissingWorldRuntime || remoteBranchStateNewer) {
      merged.set(remote.id, normalizeConversation(mergeChatRecord(local, remote)));
    }
  }

  return sortChats(projectEntities(Array.from(merged.values()), pendingOperations));
}

function mergeVisibleChats(localChats: GroupChat[], remoteChats: GroupChat[], pendingOperations: PendingChatOperation[] = []) {
  return mergeChats(localChats, remoteChats, pendingOperations).filter((chat) => chat.deletedAt == null);
}

function mergeDeletedChats(localChats: GroupChat[], remoteChats: GroupChat[], pendingOperations: PendingChatOperation[] = []) {
  return mergeChats(localChats, remoteChats, pendingOperations).filter((chat) => chat.deletedAt != null);
}

function hasNonDeletePendingChatOperation(pendingOperations: PendingChatOperation[], chatId: string) {
  return pendingOperations.some((operation) => (
    operation.entityId === chatId
    && operation.patch.deletedAt == null
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeChatSummaryChange(change: Record<string, unknown>) {
  if (change.entity !== 'chat_summary' || typeof change.id !== 'string') return null;
  const patch = isRecord(change.patch) ? change.patch : {};
  const chat = normalizeConversation({
    ...patch,
    id: change.id,
    latestMessage: sanitizeChatLatestMessage(isRecord(patch.latestMessage) ? patch.latestMessage as unknown as Message : null),
    runtimeDetailLoaded: false,
  } as unknown as GroupChat);
  return {
    op: change.op === 'delete' ? 'delete' as const : 'upsert' as const,
    chat,
  };
}

function chatSummariesFromChanges(changes: Array<Record<string, unknown>>) {
  const parsed = changes.map(normalizeChatSummaryChange).filter(Boolean) as Array<ReturnType<typeof normalizeChatSummaryChange> & {}>;
  if (parsed.length !== changes.length) return null;
  return {
    upserts: parsed.filter((item) => item.op === 'upsert').map((item) => item.chat),
    deletes: parsed.filter((item) => item.op === 'delete').map((item) => item.chat),
  };
}

function worldRuntimeChatsFromChanges(changes: Array<Record<string, unknown>> | undefined) {
  if (!changes?.length) return null;
  const upserts: GroupChat[] = [];
  const deletes: GroupChat[] = [];
  for (const change of changes) {
    if (change.entity !== 'world_runtime_chat' || typeof change.id !== 'string') {
      return null;
    }
    const patch = isRecord(change.patch) ? change.patch : {};
    const chat = normalizeConversation({
      ...patch,
      id: change.id,
      runtimeDetailLoaded: false,
      worldRuntimeLoaded: true,
    } as unknown as GroupChat);
    if (change.op === 'delete' || chat.deletedAt != null) {
      deletes.push(chat);
    } else if (change.op === 'upsert') {
      upserts.push(chat);
    } else {
      return null;
    }
  }
  return { upserts, deletes };
}

function chatDetailFromChanges(changes: Array<Record<string, unknown>> | undefined, id: string) {
  if (!changes?.length) return null;
  const change = changes.find((item) => item.entity === 'chat_detail' && item.id === id);
  if (!change) return null;
  if (change.op === 'delete') {
    return markChatRuntimeDetailLoaded(normalizeConversation({
      id,
      ...(isRecord(change.patch) ? change.patch : {}),
      deletedAt: isRecord(change.patch) && typeof change.patch.deletedAt === 'number' ? change.patch.deletedAt : Date.now(),
      runtimeDetailLoaded: true,
    } as unknown as GroupChat));
  }
  if (!isRecord(change.patch)) return null;
  return markChatRuntimeDetailLoaded(normalizeConversation({
    ...change.patch,
    id,
    runtimeDetailLoaded: true,
  } as unknown as GroupChat));
}

async function fetchChatSnapshot() {
  const result = await api.getChats() as unknown as GroupChat[];
  return normalizeChats(result.map((item) => ({ ...item, runtimeDetailLoaded: false })));
}

async function fetchChatDetail(id: string) {
  const result = await api.getChat(id);
  const detail = markChatRuntimeDetailLoaded(normalizeConversation({
    ...(result as unknown as GroupChat),
    runtimeDetailLoaded: true,
  }));
  if (detail.memberCharacterSummaries?.length) {
    useCharacterStore.getState().hydrateCharacterSummaries(detail.memberCharacterSummaries);
  }
  return detail;
}

async function fetchWorldRuntimeSnapshot() {
  const result = await api.getWorldRuntimeChats();
  return normalizeChats(result as unknown as GroupChat[]);
}

async function fetchDeletedChatSnapshot() {
  const result = await api.getDeletedChats() as unknown as Record<string, unknown>[];
  return result.map((item) => normalizeConversation(item as unknown as GroupChat));
}

async function reloadProjectedChatState(pendingOperations: PendingChatOperation[]) {
  const [active, deleted] = await Promise.all([fetchChatSnapshot(), fetchDeletedChatSnapshot()]);
  return {
    visible: mergeVisibleChats([], active, pendingOperations),
    deleted: mergeDeletedChats([], [...active, ...deleted], pendingOperations),
  };
}

async function reloadVisibleChatState(pendingOperations: PendingChatOperation[]) {
  const active = await fetchChatSnapshot();
  return mergeVisibleChats([], active, pendingOperations);
}

async function probeChatScopeChanges(scope: SyncChangeScope, options: { forceFull?: boolean } = {}) {
  const scopeState = chatSyncScopes.getState(scope);
  const since = options.forceFull ? null : scopeState.cursor ?? scopeState.revision ?? null;
  try {
    return await api.getSyncChanges({ scope, since });
  } catch {
    return null;
  }
}

function projectVisibleChats(chats: GroupChat[], pendingOperations: PendingChatOperation[]) {
  return projectEntities(chats, pendingOperations).filter((item) => item.deletedAt == null);
}

function markChatsLoadingIdle(state: ChatStore) {
  if (!state.isLoading) return state;
  return { isLoading: false };
}

function buildProjectedChatStoreState(state: ChatStore, isLoading: boolean) {
  const visibleChats = projectVisibleChats(state.chats, state.pendingOperations);
  const pendingEditSyncCount = state.pendingOperations.length;
  const pendingEditSyncError = latestChatError(state.pendingOperations);
  if (
    state.isLoading === isLoading
    && state.pendingEditSyncCount === pendingEditSyncCount
    && state.pendingEditSyncError === pendingEditSyncError
    && buildChatListSignature(visibleChats) === buildChatListSignature(state.chats)
  ) {
    return state;
  }
  return {
    ...buildWarmState({
      items: state.chats,
      projectVisible: (items) => projectVisibleChats(items, state.pendingOperations),
      pendingEditSyncCount,
      pendingEditSyncError,
      isLoading,
    }),
    chats: visibleChats,
  };
}

function buildWarmChatStoreState(state: ChatStore) {
  return buildProjectedChatStoreState(state, state.chats.length === 0);
}

function buildMarkedWarmChatStoreState(state: ChatStore) {
  return buildProjectedChatStoreState(state, state.isLoading);
}

const latestChatError = latestSyncError;
const createPendingChatOperation = createPendingOperation<Record<string, unknown>, PendingChatOperation>;
const removePendingChatOperation = removePendingOperation;
const updatePendingChatOperation = updatePendingOperation;
const canSyncChats = canAttemptOnlineSync;
const CHAT_SYNC_DELAYS = [1000, 3000, 10000, 30000];
const CHAT_REFRESH_TTL_MS = 30_000;
const CHAT_DETAIL_REFRESH_TTL_MS = 120_000;
const CHAT_SUMMARY_SCOPE: SyncChangeScope = 'chats.summary';
const WORLD_RUNTIME_SCOPE: SyncChangeScope = 'world-runtime.window';
const chatDetailScope = (id: string): SyncChangeScope => `chats.detail:${id}`;
const chatSyncScheduler = createSyncScheduler('chat.pending-operations', {
  priority: () => getPendingQueueWorkerPriority(useChatStore.getState().pendingOperations, 80, pendingChatOperationPriority),
});
const chatScopeSyncScheduler = createSyncScheduler('chat.scope-refresh', { priority: 30 });
const chatSyncScopes = createSyncScopeMetadata(CHAT_REFRESH_TTL_MS, {
  getStorageKey: () => scopedStorageKey(`chat-sync-scopes-${getLocalDataUserId()}`),
});
const requestedChatScopeChecks = new Set<SyncChangeScope>();

function scheduleChatFlush(flush: () => Promise<void>, delay = 0) {
  chatSyncScheduler.schedule(flush, delay);
}

function scheduleChatScopeRefresh(flush: () => Promise<void>, scope: SyncChangeScope, delay = 0) {
  requestedChatScopeChecks.add(scope);
  chatScopeSyncScheduler.schedule(flush, delay);
}

function mergeChatPatchOperations(operations: PendingChatOperation[]) {
  const merged = new Map<string, PendingChatOperation>();
  for (const operation of operations) {
    const cloudPatch = compactChatPatchForCloud(operation.patch);
    if (Object.keys(cloudPatch).length === 0) continue;
    const compactedOperation = {
      ...operation,
      patch: cloudPatch,
    };
    const existing = merged.get(operation.entityId);
    if (!existing) {
      merged.set(operation.entityId, compactedOperation);
      continue;
    }
    merged.set(operation.entityId, {
      ...existing,
      id: compactedOperation.id,
      patch: {
        ...(existing.patch || {}),
        ...(compactedOperation.patch || {}),
      },
      clientTimestamp: compactedOperation.clientTimestamp,
      status: existing.status === 'syncing' ? 'syncing' : compactedOperation.status,
      attemptCount: Math.max(existing.attemptCount || 0, compactedOperation.attemptCount || 0),
      lastError: compactedOperation.lastError || existing.lastError,
      targetIds: compactedOperation.targetIds?.length ? compactedOperation.targetIds : existing.targetIds,
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.clientTimestamp - right.clientTimestamp);
}

async function executeChatOperation(operation: PendingChatOperation) {
  if (operation.kind === 'create') {
    return createChatRemote({
      ...(operation.patch as ChatCreatePayload),
      id: operation.entityId,
      operationId: operation.id,
    });
  }
  return api.syncChatPatch(operation.entityId, {
    operationId: operation.id,
    clientTimestamp: operation.clientTimestamp,
    patch: operation.patch,
  });
}

async function applyChatPurge(ids: string[]) {
  const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
  if (!normalizedIds.length) return;
  if (normalizedIds.length === 1) return api.purgeChat(normalizedIds[0]);
  await api.bulkPurgeChats(normalizedIds);
}

async function applyEmptyDeletedChats() {
  await api.emptyDeletedChats();
}

async function maybeUploadGuestChats(get: () => ChatStore) {
  if (shouldSkipCloudSync()) return;
  const guestKey = scopedStorageKey('chats-guest');
  const guestStorage = createChatStorageForKey(guestKey);
  const raw = await guestStorage.getItem(getChatStoreStorageName());
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { state?: { chats?: GroupChat[] } };
    const guestChats = (parsed.state?.chats || []).filter((chat) => !chat.deletedAt);
    if (!guestChats.length) return;
    migrateGuestChatsToCloud(guestChats);
    await flushGuestChatsToCloud(createChatRemote);
    await guestStorage.removeItem(getChatStoreStorageName());
    await get().loadChats();
  } catch {
    // ignore malformed guest cache
  }
}

export function clearPersistedChatStore() {
  void useChatStore.persist.clearStorage();
  localStorage.removeItem(getChatStorageKey());
  localStorage.removeItem(getChatStoreStorageName());
  chatSyncScopes.clear();
}

export async function resetChatStoreForAccountBoundary() {
  const storageKey = getChatStorageKey();
  const storage = createChatStorageForKey(storageKey);
  const storageName = getChatStoreStorageName();
  const preservedSnapshot = await storage.getItem(storageName);
  chatSyncScopes.clear();
  useChatStore.setState({
    chats: [],
    currentChatId: null,
    lastSyncedAt: 0,
    pendingOperations: [],
    pendingEditSyncCount: 0,
    pendingEditSyncError: null,
    remoteDeletedChatIds: [],
    remoteDeletedChats: [],
    fieldConflicts: [],
    chatSummaryLoadedAt: 0,
    isLoading: false,
  });
  flushBufferedPersistenceWrites();
  if (preservedSnapshot != null) {
    await storage.setItem(storageName, preservedSnapshot);
  } else {
    await storage.removeItem(storageName);
  }
}

const chatStorage = createScopedIndexedDbBufferedJsonStorage<PersistedChatState>({
  getScopedKey: getChatStorageKey,
  storageName: getChatStoreStorageName(),
  flushDelayMs: 96,
});
let chatSyncLifecycleRegistered = false;
let chatHydrationPromise: Promise<void> | null = null;

function ensureChatStoreHydrated() {
  if (useChatStore.persist.hasHydrated()) return Promise.resolve();
  chatHydrationPromise ??= Promise.resolve(useChatStore.persist.rehydrate()).finally(() => {
    chatHydrationPromise = null;
  });
  return chatHydrationPromise;
}

async function readPersistedChatStoreState(): Promise<PersistedChatState | null> {
  const value = await chatStorage.getItem(getChatStoreStorageName()) as { state?: unknown; version?: number } | null;
  if (!value?.state || typeof value.state !== 'object') return null;
  const migrated = value.version === CLIENT_STORE_SCHEMA_VERSION
    ? value.state
    : migrateChatStoreState(value.state as PersistedChatState);
  return migrated as PersistedChatState;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => {
      const flushPendingOperations = async () => {
        await mirrorLocalOutboxWorkerQueue('chat', get().pendingOperations);
        await runPendingOperationQueue<PendingChatOperation>({
          getOperations: () => get().pendingOperations,
          canRun: canSyncChats,
          retryDelays: CHAT_SYNC_DELAYS,
          isTerminalError: isTerminalSyncError,
          priority: pendingChatOperationPriority,
          batchSize: 3,
          updateOperation: (operationId, operation) => {
            set((current) => ({
              pendingOperations: updatePendingChatOperation(current.pendingOperations, operationId, operation),
            }));
            markLocalOutboxWorkerOperation(operation);
          },
          execute: executeChatOperation,
          onSuccess: (operation) => {
            const nextQueue = removePendingChatOperation(get().pendingOperations, operation.id);
            set((current) => ({
              chats: projectEntities(current.chats, nextQueue).filter((chat) => chat.deletedAt == null),
              pendingOperations: nextQueue,
              fieldConflicts: clearResolvedFieldConflicts(current.fieldConflicts, { entityType: 'chat', operationIds: [operation.id] }),
              pendingEditSyncCount: nextQueue.length,
              pendingEditSyncError: latestChatError(nextQueue),
              lastSyncedAt: Date.now(),
            }));
            completeLocalOutboxWorkerOperation(operation.id);
            window.setTimeout(() => removeLocalOutboxWorkerOperation(operation.id), 1500);
          },
          onFailure: (operation, _error, retry) => {
            set((current) => ({
              pendingEditSyncCount: current.pendingOperations.length,
              pendingEditSyncError: retry.classified,
            }));
            const stillQueued = get().pendingOperations.some((item) => item.id === operation.id);
            if (stillQueued) {
              markLocalOutboxWorkerOperation(retry.retryOperation);
              return;
            }
            removeLocalOutboxWorkerOperation(operation.id);
          },
          scheduleNext: (delay) => scheduleChatFlush(flushPendingOperations, delay),
        });
      };
      const flushRequestedChatScopes = async () => {
        const scopes = Array.from(requestedChatScopeChecks);
        requestedChatScopeChecks.clear();
        for (const scope of scopes) {
          if (scope === CHAT_SUMMARY_SCOPE) {
            await get().loadChats();
          } else if (scope === WORLD_RUNTIME_SCOPE) {
            await get().loadWorldRuntime();
          }
        }
      };

      if (!chatSyncLifecycleRegistered) {
        chatSyncScheduler.registerLifecycle(flushPendingOperations, 300);
        chatScopeSyncScheduler.registerLifecycle(flushRequestedChatScopes, 600);
        chatSyncLifecycleRegistered = true;
      }

      return {
        chats: [],
        currentChatId: null,
        lastSyncedAt: 0,
        pendingOperations: [],
        pendingEditSyncCount: 0,
        pendingEditSyncError: null,
        remoteDeletedChatIds: [],
        remoteDeletedChats: [],
        fieldConflicts: [],
        chatSummaryLoadedAt: 0,
        isLoading: false,

        loadChats: async (options) => {
          await ensureChatStoreHydrated();
          set(buildWarmChatStoreState);
          logDeveloperDiagnostic('chat-store:loadChats:start', {
            currentChats: get().chats.length,
            chatSummaryLoadedAt: get().chatSummaryLoadedAt,
            ...getCloudSyncSkipDiagnostics(),
            summaryFresh: chatSyncScopes.isFresh(CHAT_SUMMARY_SCOPE),
          }, 'debug', 'chat-sync');
          if (shouldSkipCloudSync()) {
            logDeveloperDiagnostic('chat-store:loadChats:skip-cloud', {
              ...getCloudSyncSkipDiagnostics(),
              currentChats: get().chats.length,
            }, 'info', 'chat-sync');
            set(markChatsLoadingIdle);
            return;
          }
          if (get().chats.length > 0 && get().chatSummaryLoadedAt > 0 && chatSyncScopes.isFresh(CHAT_SUMMARY_SCOPE)) {
            logDeveloperDiagnostic('chat-store:loadChats:skip-fresh', {
              currentChats: get().chats.length,
              chatSummaryLoadedAt: get().chatSummaryLoadedAt,
            }, 'debug', 'chat-sync');
            set(markChatsLoadingIdle);
            return;
          }
          const refresh = chatSyncScopes.run(CHAT_SUMMARY_SCOPE, async () => {
            try {
              await maybeUploadGuestChats(get);
              const changeProbe = await probeChatScopeChanges(CHAT_SUMMARY_SCOPE, { forceFull: get().chats.length === 0 || get().chatSummaryLoadedAt === 0 });
              logDeveloperDiagnostic('chat-store:loadChats:probe', {
                status: changeProbe?.status,
                changes: changeProbe?.changes?.length || 0,
                hasMore: changeProbe?.hasMore,
                cursor: Boolean(changeProbe?.cursor),
              }, 'debug', 'chat-sync');
              if (changeProbe?.status === 'not_modified') {
                chatSyncScopes.markChecked(CHAT_SUMMARY_SCOPE, {
                  cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: false,
                });
                set((state) => (
                  state.chatSummaryLoadedAt > 0
                    ? markChatsLoadingIdle(state)
                    : { ...markChatsLoadingIdle(state), chatSummaryLoadedAt: Date.now() }
                ));
                return;
              }
              const summaryChanges = changeProbe?.changes?.length ? chatSummariesFromChanges(changeProbe.changes) : null;
              if (summaryChanges) {
                set((state) => {
                  const deleteConflicts = summaryChanges.deletes.filter((chat) => hasNonDeletePendingChatOperation(state.pendingOperations, chat.id));
                  const applicableDeletes = summaryChanges.deletes.filter((chat) => !hasNonDeletePendingChatOperation(state.pendingOperations, chat.id));
                  const changedChats = [...summaryChanges.upserts, ...applicableDeletes];
                  const fieldConflicts = detectPendingFieldConflicts({
                    entityType: 'chat',
                    localEntities: state.chats,
                    remoteEntities: changedChats,
                    pendingOperations: state.pendingOperations,
                    existingConflicts: state.fieldConflicts,
                  });
                  const merged = mergeChats(state.chats, changedChats, state.pendingOperations);
                  const nextChats = merged.filter((chat) => chat.deletedAt == null);
                  const deletedIds = new Set(applicableDeletes.map((chat) => chat.id));
                  const deletedSnapshots = merged.filter((chat) => deletedIds.has(chat.id) && chat.deletedAt != null);
                  const conflictSnapshots = deleteConflicts.map((remote) => state.chats.find((chat) => chat.id === remote.id) || remote);
                  const changed = buildChatListSignature(nextChats) !== buildChatListSignature(state.chats);
                  chatSyncScopes.markChecked(CHAT_SUMMARY_SCOPE, {
                    cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                    applied: changed || deletedSnapshots.length > 0 || conflictSnapshots.length > 0,
                  });
                  return {
                    ...(changed ? { chats: nextChats } : {}),
                    remoteDeletedChatIds: Array.from(new Set([
                      ...state.remoteDeletedChatIds.filter((id) => !summaryChanges.upserts.some((chat) => chat.id === id)),
                      ...deletedSnapshots.map((chat) => chat.id),
                      ...deleteConflicts.map((chat) => chat.id),
                    ])),
                    remoteDeletedChats: [
                      ...conflictSnapshots,
                      ...deletedSnapshots,
                      ...state.remoteDeletedChats
                        .filter((chat) => !summaryChanges.upserts.some((visibleChat) => visibleChat.id === chat.id))
                        .filter((chat) => !conflictSnapshots.some((conflictChat) => conflictChat.id === chat.id))
                        .filter((chat) => !deletedSnapshots.some((deletedChat) => deletedChat.id === chat.id)),
                    ],
                    fieldConflicts,
                    isLoading: false,
                    lastSyncedAt: Date.now(),
                    chatSummaryLoadedAt: Date.now(),
                    pendingEditSyncCount: state.pendingOperations.length,
                    pendingEditSyncError: latestChatError(state.pendingOperations),
                  };
                });
                return;
              }
              const visible = await reloadVisibleChatState(get().pendingOperations);
              logDeveloperDiagnostic('chat-store:loadChats:reload-visible', {
                visibleChats: visible.length,
                pendingOperations: get().pendingOperations.length,
              }, 'debug', 'chat-sync');
              set((state) => ({
                ...(() => {
                  const nextChats = mergeVisibleChats(state.chats, visible, state.pendingOperations);
                  const changed = buildChatListSignature(nextChats) !== buildChatListSignature(state.chats);
                  chatSyncScopes.markChecked(CHAT_SUMMARY_SCOPE, {
                    cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                    applied: changed,
                  });
                  return changed ? { chats: nextChats } : {};
                })(),
                remoteDeletedChatIds: state.remoteDeletedChatIds.filter((id) => !visible.some((chat) => chat.id === id)),
                remoteDeletedChats: state.remoteDeletedChats.filter((chat) => !visible.some((visibleChat) => visibleChat.id === chat.id)),
                isLoading: false,
                lastSyncedAt: Date.now(),
                chatSummaryLoadedAt: Date.now(),
                pendingEditSyncCount: get().pendingOperations.length,
                pendingEditSyncError: latestChatError(get().pendingOperations),
              }));
            } catch (error) {
              chatSyncScopes.markError(CHAT_SUMMARY_SCOPE, error);
              reportRecoverableError({
                location: 'cloud-sync:chats-load',
                error,
                userMessage: buildApiErrorUserMessage(error, '聊天云同步'),
              });
              set({ isLoading: false, pendingEditSyncError: classifySyncError(error) });
            }
          }, { markCheckedOnSuccess: false });
          if (get().chats.length > 0 && !options?.waitForCloud) {
            void refresh;
            return;
          }
          return refresh;
        },

        loadChat: async (id): Promise<GroupChat | null> => {
          if (!id) return null;
          await ensureChatStoreHydrated();
          const cached = get().chats.find((chat) => chat.id === id);
          logDeveloperDiagnostic('chat-store:loadChat:start', {
            chatId: id,
            hasCached: Boolean(cached),
            cachedRuntimeDetailLoaded: cached?.runtimeDetailLoaded,
            cachedMemberCount: cached?.memberIds?.length,
            ...getCloudSyncSkipDiagnostics(),
          }, 'debug', 'chat-sync');
          if (shouldSkipCloudSync()) {
            logDeveloperDiagnostic('chat-store:loadChat:skip-cloud', {
              chatId: id,
              hasCached: Boolean(cached),
              ...getCloudSyncSkipDiagnostics(),
            }, 'info', 'chat-sync');
            return cached || null;
          }
          const scope = chatDetailScope(id);
          if ((isChatRuntimeDetailLoaded(cached) || cached?.id.startsWith('local-chat-')) && chatSyncScopes.isFresh(scope, CHAT_DETAIL_REFRESH_TTL_MS)) {
            logDeveloperDiagnostic('chat-store:loadChat:skip-fresh', {
              chatId: id,
              cachedRuntimeDetailLoaded: cached?.runtimeDetailLoaded,
              scopeFresh: true,
            }, 'debug', 'chat-sync');
            return cached ?? null;
          }
          const refresh = chatSyncScopes.run<GroupChat | null>(scope, async (): Promise<GroupChat | null> => {
            try {
              const cachedHasDetailCursor = cached?.runtimeDetailLoaded === true;
              const cachedHasUsableDetail = isChatRuntimeDetailLoaded(cached);
              const changeProbe = cachedHasDetailCursor ? await probeChatScopeChanges(scope) : null;
              logDeveloperDiagnostic('chat-store:loadChat:probe', {
                chatId: id,
                cachedHasDetailCursor,
                cachedHasUsableDetail,
                status: changeProbe?.status,
                changes: changeProbe?.changes?.length || 0,
              }, 'debug', 'chat-sync');
              if (changeProbe?.status === 'not_modified') {
                chatSyncScopes.markChecked(scope, {
                  cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: false,
                });
                if (cachedHasUsableDetail) return cached || null;
              }
              const detail = chatDetailFromChanges(changeProbe?.changes, id) || await fetchChatDetail(id);
              logDeveloperDiagnostic('chat-store:loadChat:detail-loaded', {
                chatId: id,
                deleted: detail.deletedAt != null,
                memberCount: detail.memberIds?.length,
                runtimeDetailLoaded: detail.runtimeDetailLoaded,
                memberCharacterSummaries: detail.memberCharacterSummaries?.length || 0,
              }, 'debug', 'chat-sync');
              if (detail.memberCharacterSummaries?.length) {
                useCharacterStore.getState().hydrateCharacterSummaries(detail.memberCharacterSummaries);
              }
              if (detail.deletedAt != null) {
                const snapshot = cached || detail;
                const hasPendingConflict = hasNonDeletePendingChatOperation(get().pendingOperations, id);
                chatSyncScopes.markChecked(scope, {
                  cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: true,
                });
                set((state) => ({
                  chats: hasPendingConflict ? projectVisibleChats(state.chats, state.pendingOperations) : state.chats.filter((chat) => chat.id !== id),
                  remoteDeletedChatIds: Array.from(new Set([...state.remoteDeletedChatIds, id])),
                  remoteDeletedChats: [snapshot, ...state.remoteDeletedChats.filter((chat) => chat.id !== id)],
                  lastSyncedAt: state.lastSyncedAt || Date.now(),
                  pendingEditSyncCount: state.pendingOperations.length,
                  pendingEditSyncError: latestChatError(state.pendingOperations),
                }));
                return snapshot;
              }
              set((state) => {
                const fieldConflicts = detectPendingFieldConflicts({
                  entityType: 'chat',
                  localEntities: state.chats,
                  remoteEntities: [detail],
                  pendingOperations: state.pendingOperations,
                  existingConflicts: state.fieldConflicts,
                });
                const nextChats = mergeVisibleChats(state.chats, [detail], state.pendingOperations);
                const changed = buildChatListSignature(nextChats) !== buildChatListSignature(state.chats);
                chatSyncScopes.markChecked(scope, {
                  cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: changed,
                });
                return {
                  ...(changed ? { chats: nextChats } : {}),
                  remoteDeletedChatIds: state.remoteDeletedChatIds.filter((chatId) => chatId !== id),
                  remoteDeletedChats: state.remoteDeletedChats.filter((chat) => chat.id !== id),
                  fieldConflicts,
                  lastSyncedAt: state.lastSyncedAt || Date.now(),
                  pendingEditSyncCount: state.pendingOperations.length,
                  pendingEditSyncError: latestChatError(state.pendingOperations),
                };
              });
              return get().chats.find((chat) => chat.id === id) || detail;
            } catch (error) {
              const fallback = get().chats.find((chat) => chat.id === id) || null;
              if (getErrorStatus(error) === 404 && fallback) {
                chatSyncScopes.markChecked(scope, { applied: false });
                if (hasChatRuntimeDetailEvidence(fallback) && fallback.runtimeDetailLoaded !== true) {
                  const loadedFallback = markChatRuntimeDetailLoaded(fallback);
                  set((state) => ({
                    chats: state.chats.map((chat) => (
                      chat.id === id ? loadedFallback : chat
                    )),
                  }));
                  return loadedFallback;
                }
                return fallback;
              }
              chatSyncScopes.markError(scope, error);
              const diagnostics = {
                chatId: id,
                status: getErrorStatus(error),
                code: getErrorCode(error),
                hasLocalFallback: Boolean(fallback),
                cachedDetailLoaded: Boolean(fallback?.runtimeDetailLoaded),
                pendingOperationCount: get().pendingOperations.filter((operation) => operation.entityId === id).length,
              };
              if (fallback) {
                reportRecoverableWarning({
                  location: 'cloud-sync:chat-detail-load',
                  error,
                  message: '聊天云端详情暂时不可用，已继续使用本地会话数据。',
                  extra: diagnostics,
                });
                return fallback;
              }
              reportRecoverableError({
                location: 'cloud-sync:chat-detail-load',
                error,
                userMessage: buildApiErrorUserMessage(error, '聊天详情同步'),
                extra: diagnostics,
              });
              return null;
            }
          }, { markCheckedOnSuccess: false });
          if (isChatRuntimeDetailLoaded(cached) || cached?.id.startsWith('local-chat-')) {
            void refresh;
            return cached ?? null;
          }
          const loaded = await refresh;
          return loaded ?? null;
        },

        loadWorldRuntime: async () => {
          await ensureChatStoreHydrated();
          if (shouldSkipCloudSync()) return;
          if (chatSyncScopes.isFresh(WORLD_RUNTIME_SCOPE)) return;
          return chatSyncScopes.run(WORLD_RUNTIME_SCOPE, async () => {
            try {
              const changeProbe = await probeChatScopeChanges(WORLD_RUNTIME_SCOPE);
              if (changeProbe?.status === 'not_modified') {
                chatSyncScopes.markChecked(WORLD_RUNTIME_SCOPE, {
                  cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: false,
                });
                return;
              }
              const snapshot = worldRuntimeChatsFromChanges(changeProbe?.changes);
              const remoteSnapshot = snapshot || { upserts: await fetchWorldRuntimeSnapshot(), deletes: [] };
              set((state) => {
                const byId = new Map(state.chats.map((chat) => [chat.id, chat] as const));
                const deletedIds = new Set(remoteSnapshot.deletes.map((chat) => chat.id));
                const mergedRuntime = remoteSnapshot.upserts.map((remote) => normalizeConversation(mergeWorldRuntimeRecord(byId.get(remote.id), remote)));
                const nextChats = mergeVisibleChats(
                  state.chats.filter((chat) => !deletedIds.has(chat.id)),
                  mergedRuntime,
                  state.pendingOperations,
                );
                const changed = buildChatListSignature(nextChats) !== buildChatListSignature(state.chats);
                chatSyncScopes.markChecked(WORLD_RUNTIME_SCOPE, {
                  cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: changed,
                });
                return {
                  ...(changed ? { chats: nextChats } : {}),
                  pendingEditSyncCount: state.pendingOperations.length,
                  pendingEditSyncError: latestChatError(state.pendingOperations),
                };
              });
            } catch (error) {
              chatSyncScopes.markError(WORLD_RUNTIME_SCOPE, error);
              reportRecoverableError({
                location: 'cloud-sync:world-runtime-load',
                error,
                userMessage: buildApiErrorUserMessage(error, '世界运行摘要同步'),
              });
            }
          }, { markCheckedOnSuccess: false });
        },

        prefetchChats: async () => {
          if (shouldSkipCloudSync()) {
            logDeveloperDiagnostic('chat-store:prefetchChats:local', {
              currentChats: get().chats.length,
            }, 'debug', 'chat-sync');
            await get().loadChats();
            return;
          }
          const state = get();
          if (state.chats.length > 0 && state.chatSummaryLoadedAt > 0 && chatSyncScopes.isFresh(CHAT_SUMMARY_SCOPE)) {
            logDeveloperDiagnostic('chat-store:prefetchChats:skip-fresh', {
              currentChats: state.chats.length,
              chatSummaryLoadedAt: state.chatSummaryLoadedAt,
            }, 'debug', 'chat-sync');
            return;
          }
          logDeveloperDiagnostic('chat-store:prefetchChats:schedule', {
            currentChats: state.chats.length,
            chatSummaryLoadedAt: state.chatSummaryLoadedAt,
          }, 'debug', 'chat-sync');
          scheduleChatScopeRefresh(flushRequestedChatScopes, CHAT_SUMMARY_SCOPE);
        },

        restoreLocalChats: async () => {
          await ensureChatStoreHydrated();
          const persisted = await readPersistedChatStoreState();
          logDeveloperDiagnostic('chat-store:restoreLocalChats:start', {
            persistedChats: persisted?.chats?.length || 0,
            currentChats: get().chats.length,
            pendingOperations: persisted?.pendingOperations?.length || 0,
          }, 'debug', 'chat-sync');
          if (!persisted?.chats?.length) return;
          set((state) => {
            const pendingOperations = state.pendingOperations.length
              ? state.pendingOperations
              : recoverInterruptedOperations(persisted.pendingOperations || []);
            const nextChats = mergeVisibleChats(
              persisted.chats,
              state.chats,
              pendingOperations,
            );
            const nextSignature = buildChatListSignature(nextChats);
            const currentSignature = buildChatListSignature(state.chats);
            if (
              nextSignature === currentSignature
              && pendingOperations.length === state.pendingOperations.length
              && (persisted.currentChatId || null) === (state.currentChatId || null)
              && (persisted.lastSyncedAt || 0) <= (state.lastSyncedAt || 0)
            ) {
              return {};
            }
            return {
              chats: nextChats,
              currentChatId: state.currentChatId || persisted.currentChatId || null,
              lastSyncedAt: Math.max(state.lastSyncedAt || 0, persisted.lastSyncedAt || 0),
              chatSummaryLoadedAt: nextChats.length > state.chats.length ? Date.now() : state.chatSummaryLoadedAt,
              pendingOperations,
              pendingEditSyncCount: pendingOperations.length,
              pendingEditSyncError: latestChatError(pendingOperations),
            };
          });
        },

        refreshChatSummaryFromCloud: async () => {
          chatSyncScopes.clear(CHAT_SUMMARY_SCOPE);
          await get().loadChats({ waitForCloud: true });
        },

        prefetchWorldRuntime: async () => {
          if (chatSyncScopes.isFresh(WORLD_RUNTIME_SCOPE)) return;
          scheduleChatScopeRefresh(flushRequestedChatScopes, WORLD_RUNTIME_SCOPE);
        },

        getChat: (id) => get().chats.find((chat) => chat.id === id),
        hasChatLoaded: (id) => isChatRuntimeDetailLoaded(get().chats.find((chat) => chat.id === id)),
        getChatsLoadedAt: () => get().lastSyncedAt,
        getSyncScopeStates: () => chatSyncScopes.listStates(),
        markChatsWarm: () => {
          void ensureChatStoreHydrated().then(() => {
            set(buildMarkedWarmChatStoreState);
          });
        },

        flushPendingOperations,

        queuePatch: (entityId, patch, kind = 'patch') => {
          const cloudPatch = compactChatPatchForCloud(patch);
          const operation = Object.keys(cloudPatch).length > 0
            ? createPendingChatOperation({ kind, targetIds: entityId ? [entityId] : [], patch: cloudPatch })
            : null;
          set((state) => {
            const pendingOperations = operation
              ? mergeChatPatchOperations([...state.pendingOperations, operation])
              : mergeChatPatchOperations(state.pendingOperations);
            if (isRuntimeMemoryDiagnosticsEnabled()) {
              const targetChat = state.chats.find((chat) => chat.id === entityId) || null;
              recordRuntimeMemoryDiagnostic('chat-store:queue-patch', {
                chatId: entityId,
                extra: {
                  kind,
                  runtimeEvents: targetChat?.runtimeEventsV2?.length || 0,
                  relationshipLedger: targetChat?.relationshipLedger?.length || 0,
                  layeredMemories: targetChat?.layeredMemories?.length || 0,
                  patchKeys: Object.keys(patch || {}),
                  cloudPatchKeys: Object.keys(cloudPatch || {}),
                  pendingOperationCount: pendingOperations.length,
                  pendingOperationsJson: (() => {
                    try {
                      return JSON.stringify(pendingOperations).length;
                    } catch {
                      return -1;
                    }
                  })(),
                  patchJson: (() => {
                    try {
                      return JSON.stringify(patch).length;
                    } catch {
                      return -1;
                    }
                  })(),
                  cloudPatchJson: (() => {
                    try {
                      return JSON.stringify(cloudPatch).length;
                    } catch {
                      return -1;
                    }
                  })(),
                },
              });
            }
            return {
              pendingOperations,
              chats: state.chats.map((chat) => chat.id === entityId
                ? applyLocalChatUpdate(chat, patch as Partial<GroupChat>, operation?.clientTimestamp || Date.now())
                : chat).filter((chat) => chat.deletedAt == null),
              pendingEditSyncCount: pendingOperations.length,
              pendingEditSyncError: latestChatError(pendingOperations),
            };
          });
          if (operation) scheduleChatFlush(flushPendingOperations, 120);
        },

        loadProjectedDeletedChats: async () => {
          const { deleted } = await reloadProjectedChatState(get().pendingOperations);
          return deleted;
        },
        loadProjectedChats: async () => {
          return reloadVisibleChatState(get().pendingOperations);
        },
        loadProjectedState: async () => { await get().loadChats(); },
        getPendingOperations: () => get().pendingOperations,
        getPendingEditError: () => latestChatError(get().pendingOperations),
        getPendingEditCount: () => get().pendingOperations.length,
        clearPendingOperations: () => set({ pendingOperations: [], pendingEditSyncCount: 0, pendingEditSyncError: null, fieldConflicts: [] }),
        clearPendingOperationsForChat: (chatId) => set((state) => {
          const pendingOperations = state.pendingOperations.filter((operation) => operation.entityId !== chatId && !operation.targetIds.includes(chatId));
          if (pendingOperations.length === state.pendingOperations.length) return {};
          return {
            pendingOperations,
            chats: projectEntities(state.chats, pendingOperations).filter((chat) => chat.deletedAt == null),
            pendingEditSyncCount: pendingOperations.length,
            pendingEditSyncError: latestChatError(pendingOperations),
            fieldConflicts: state.fieldConflicts.filter((conflict) => conflict.entityId !== chatId),
          };
        }),
        confirmCreateOperationsSynced: (entityIds) => set((state) => {
          const normalizedIds = new Set(entityIds.filter(Boolean));
          if (!normalizedIds.size) return {};
          const pendingOperations = state.pendingOperations.filter((operation) => (
            operation.kind !== 'create' || !normalizedIds.has(operation.entityId)
          ));
          if (pendingOperations.length === state.pendingOperations.length) return {};
          return {
            chats: projectVisibleChats(state.chats, pendingOperations),
            pendingOperations,
            fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'chat', entityIds: Array.from(normalizedIds) }),
            pendingEditSyncCount: pendingOperations.length,
            pendingEditSyncError: latestChatError(pendingOperations),
          };
        }),
        discardFailedOperation: (operationId) => set((state) => {
          const operation = state.pendingOperations.find((item) => item.id === operationId);
          if (operation?.status !== 'failed') return {};
          const pendingOperations = removePendingChatOperation(state.pendingOperations, operationId);
          return {
            chats: projectVisibleChats(state.chats, pendingOperations),
            pendingOperations,
            fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'chat', operationIds: [operationId] }),
            pendingEditSyncCount: pendingOperations.length,
            pendingEditSyncError: latestChatError(pendingOperations),
          };
        }),
        resolveRemoteDeleteConflict: async (id, resolution) => {
          if (!id) return;
          if (resolution === 'restore_local') {
            set((state) => ({
              remoteDeletedChatIds: state.remoteDeletedChatIds.filter((chatId) => chatId !== id),
              remoteDeletedChats: state.remoteDeletedChats.filter((chat) => chat.id !== id),
              fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'chat', entityIds: [id] }),
            }));
            await get().syncPatch(id, { deletedAt: null, isActive: true }, 'patch');
            scheduleChatFlush(flushPendingOperations, 100);
            return;
          }
          if (resolution === 'save_as_new') {
            const snapshot = get().chats.find((chat) => chat.id === id) || get().remoteDeletedChats.find((chat) => chat.id === id);
            if (snapshot) await get().addChat(createConflictCopyChatData(snapshot));
          }
          set((state) => {
            const pendingOperations = state.pendingOperations.filter((operation) => operation.entityId !== id);
            return {
              chats: state.chats.filter((chat) => chat.id !== id),
              currentChatId: state.currentChatId === id ? null : state.currentChatId,
              pendingOperations,
              fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'chat', entityIds: [id] }),
              pendingEditSyncCount: pendingOperations.length,
              pendingEditSyncError: latestChatError(pendingOperations),
              remoteDeletedChatIds: state.remoteDeletedChatIds.filter((chatId) => chatId !== id),
              remoteDeletedChats: state.remoteDeletedChats.filter((chat) => chat.id !== id),
            };
          });
        },
        retryFailedOperations: () => set((state) => {
          const pendingOperations = retryFailedOperations(state.pendingOperations);
          if (pendingOperations === state.pendingOperations) return {};
          return {
            pendingOperations,
            pendingEditSyncCount: pendingOperations.length,
            pendingEditSyncError: latestChatError(pendingOperations),
          };
        }),
        loadPendingSnapshot: async () => get().loadProjectedChats(),
        loadProjectedRecycleBin: async () => get().loadProjectedDeletedChats(),
        hydrateProjectedState: () => set((state) => ({ chats: projectVisibleChats(state.chats, state.pendingOperations) })),
        resumeSync: () => scheduleChatFlush(flushPendingOperations, 100),
        syncPatch: async (entityId, patch, kind = 'patch') => {
          get().queuePatch(entityId, patch, kind);
        },
        loadProjectedVisibleChats: async () => projectVisibleChats(get().chats, get().pendingOperations),

        addChat: async (chatData) => {
          const chat = applyLocalChatCreate(chatData);
          set((state) => {
            const pendingOperations = shouldSkipCloudSync()
              ? state.pendingOperations
              : mergeChatPatchOperations([
                ...state.pendingOperations,
                createPendingChatOperation({
                  kind: 'create',
                  targetIds: [chat.id],
                  patch: compactChatPatchForCloud({ ...chat, id: chat.id } as Record<string, unknown>),
                }),
              ]);
            return {
              chats: [chat, ...state.chats.filter((item) => item.id !== chat.id)].sort((a, b) => b.lastMessageAt - a.lastMessageAt),
              currentChatId: chat.id,
              pendingOperations,
              pendingEditSyncCount: pendingOperations.length,
              pendingEditSyncError: latestChatError(pendingOperations),
            };
          });
          if (!shouldSkipCloudSync()) {
            scheduleChatFlush(flushPendingOperations, 120);
          }
          return chat;
        },

        updateChat: async (id, updates) => {
          const currentChat = get().chats.find((chat) => chat.id === id);
          const cleanUpdates = sanitizeChatLatestPatch(currentChat, updates);
          await prepareAssistantLocalWorkspaceChatRename(id, cleanUpdates, get().chats);
          if (shouldSkipCloudSync()) {
            set((state) => ({
              chats: state.chats.map((chat) => chat.id === id ? applyLocalChatUpdate(chat, cleanUpdates) : chat),
            }));
            return;
          }
          if (Object.keys(compactChatPatchForCloud(cleanUpdates as Record<string, unknown>)).length === 0) {
            set((state) => ({
              chats: state.chats.map((chat) => chat.id === id ? applyLocalChatUpdate(chat, cleanUpdates) : chat),
            }));
            return;
          }
          await get().syncPatch(id, cleanUpdates, 'patch');
        },

        applyChatRuntimePatch: async (id, buildPatch) => {
          let applied = false;
          let queued = false;
          set((state) => {
            const chat = state.chats.find((item) => item.id === id && item.deletedAt == null);
            if (!chat) return state;
            const patch = buildPatch(chat);
            if (!patch || Object.keys(patch).length === 0) return state;
            const cleanPatch = sanitizeChatLatestPatch(chat, patch);
            const cloudPatch = compactChatPatchForCloud(cleanPatch as Record<string, unknown>);
            const operation = !shouldSkipCloudSync() && Object.keys(cloudPatch).length > 0
              ? createPendingChatOperation({ kind: 'patch', targetIds: [id], patch: cloudPatch })
              : null;
            const pendingOperations = operation
              ? mergeChatPatchOperations([...state.pendingOperations, operation])
              : state.pendingOperations;
            applied = true;
            queued = Boolean(operation);
            return {
              chats: state.chats.map((item) => item.id === id ? applyLocalChatUpdate(item, cleanPatch) : item),
              ...(operation ? {
                pendingOperations,
                pendingEditSyncCount: pendingOperations.length,
                pendingEditSyncError: latestChatError(pendingOperations),
              } : {}),
            };
          });
          if (queued) scheduleChatFlush(flushPendingOperations, 120);
          return applied;
        },

        applyChatRuntimeDelta: async (id, delta, patch = {}) => {
          await get().applyChatRuntimePatch(id, (chat) => ({
            ...patch,
            ...buildChatRuntimeDeltaPatch(chat, delta),
          }));
        },

        deleteChat: async (id) => {
          if (!id) return;
          const deletedAt = Date.now();
          if (shouldSkipCloudSync()) {
            set((state) => ({
              chats: state.chats.map((chat) => chat.id === id ? applyLocalChatDelete(chat) : chat).filter((chat) => chat.deletedAt == null),
              currentChatId: state.currentChatId === id ? null : state.currentChatId,
            }));
            return;
          }
          await get().syncPatch(id, { deletedAt, isActive: false }, 'patch');
          set((state) => ({ currentChatId: state.currentChatId === id ? null : state.currentChatId }));
        },

        restoreChats: async (ids) => {
          const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
          if (!normalizedIds.length) return;
          if (shouldSkipCloudSync()) {
            set((state) => ({
              chats: state.chats.map((chat) => normalizedIds.includes(chat.id) ? applyLocalChatRestore(chat) : chat).filter((chat) => chat.deletedAt == null),
            }));
            return;
          }
          await Promise.all(normalizedIds.map((chatId) => get().syncPatch(chatId, { deletedAt: null, isActive: true }, 'patch')));
        },

        purgeChats: async (ids) => {
          const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
          if (!normalizedIds.length) return;
          if (shouldSkipCloudSync()) {
            set((state) => ({ chats: applyLocalChatPurge(state.chats, normalizedIds) }));
            return;
          }
          await applyChatPurge(normalizedIds);
          const projectedState = await reloadProjectedChatState(get().pendingOperations);
          set({
            chats: projectedState.visible,
            lastSyncedAt: Date.now(),
            pendingEditSyncCount: get().pendingOperations.length,
            pendingEditSyncError: latestChatError(get().pendingOperations),
          });
        },

        emptyDeletedChats: async () => {
          if (shouldSkipCloudSync()) {
            set((state) => ({ chats: applyLocalEmptyDeletedChats(state.chats) }));
            return;
          }
          await applyEmptyDeletedChats();
          const projectedState = await reloadProjectedChatState(get().pendingOperations);
          set({
            chats: projectedState.visible,
            lastSyncedAt: Date.now(),
            pendingEditSyncCount: get().pendingOperations.length,
            pendingEditSyncError: latestChatError(get().pendingOperations),
          });
        },

        loadDeletedChats: async () => {
          const { deleted } = await reloadProjectedChatState(get().pendingOperations);
          return deleted;
        },

        setCurrentChat: (id) => set({ currentChatId: id }),
        getCurrentChat: () => get().chats.find((chat) => chat.id === get().currentChatId),
      };
    },
    {
      name: getChatStoreStorageName(),
      storage: chatStorage,
      version: CLIENT_STORE_SCHEMA_VERSION,
      migrate: (persistedState) => {
        const migrated = migrateChatStoreState(persistedState as PersistedChatState) as PersistedChatState;
        return {
          ...migrated,
          pendingOperations: recoverInterruptedOperations(migrated.pendingOperations || []),
          fieldConflicts: migrated.fieldConflicts || [],
        };
      },
      partialize: (state) => buildPersistedChatState({
        chats: state.chats,
        currentChatId: state.currentChatId,
        lastSyncedAt: state.lastSyncedAt,
        pendingOperations: state.pendingOperations,
      }),
      skipHydration: true,
    }
  )
);

export const __chatRuntimePersistenceForTests = {
  compactChatPatchForCloud,
  compactRuntimeEventsForPersistence,
  mergeRuntimeEventsForSync,
  mergeChatRecord,
  mergeChats,
  mergeWorldRuntimeRecord,
  buildChatListSignature,
  buildPersistedChatState,
  limits: {
    layeredMemories: DEFAULT_BASIC_RETENTION_LIMITS.chatLayeredMemories.storage,
    runtimeSeedNotes: DEFAULT_BASIC_RETENTION_LIMITS.runtimeSeedNotes.storage,
    runtimeSeedArtifacts: DEFAULT_BASIC_RETENTION_LIMITS.runtimeSeedArtifacts.storage,
    runtimeTimeline: DEFAULT_BASIC_RETENTION_LIMITS.runtimeTimeline.storage,
    runtimeEventsV2: DEFAULT_BASIC_RETENTION_LIMITS.runtimeEventsV2.storage,
    companionshipStateHistoryPerKey: COMPANIONSHIP_STATE_HISTORY_PER_KEY,
    relationshipLedger: DEFAULT_BASIC_RETENTION_LIMITS.relationshipLedger.storage,
  },
};
