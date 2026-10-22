import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message } from '../types/message';
import { api, ApiError, type SyncChangeScope } from '../services/api';
import { buildApiErrorUserMessage } from '../services/apiErrorMessage';
import { reportRecoverableError } from '../services/diagnostics';
import { hasLocalDataUrlMedia, scrubLocalMediaUrlsForCloud, uploadLocalMessageMediaToCloud } from '../services/richMessageMedia';
import { useAuthStore } from './useAuthStore';
import { CLIENT_STORE_SCHEMA_VERSION, migrateMessageStoreState } from './storeMigrations';
import { createScopedIndexedDbBufferedJsonStorage, flushBufferedPersistenceWrites } from './storePersistenceScope';
import { createSyncScheduler } from './storeSyncScheduler';
import { canAttemptOnlineSync, getPendingQueueWorkerPriority, isTerminalSyncError, recoverInterruptedOperations, retryFailedOperations, runPendingOperationQueue } from './storeSyncHelpers';
import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from '../services/authStorageScope';
import { isCloudSyncEnabled } from '../services/cloudSyncPreference';
import { useChatStore } from './useChatStore';
import { useCharacterStore } from './useCharacterStore';
import { useFactArchiveStore } from './useFactArchiveStore';
import { createSyncScopeMetadata, type SyncScopeSnapshot } from './syncScopeMetadata';
import { completeLocalOutboxWorkerOperation, markLocalOutboxWorkerOperation, mirrorLocalOutboxWorkerQueue, removeLocalOutboxWorkerOperation } from '../services/localOutboxWorkerBridge';
import { useSettingsStore } from './useSettingsStore';
import { compactMessage, compactMessageMetadata } from '../services/messageMetadataCompaction';
import { logDeveloperDiagnostic } from '../services/developerDiagnostics';
import { buildMessageIdentityKeys } from '../services/messageIdentity';
import { canRecreateMissingCloudChat } from '../services/chatAvailability';
import {
  type CachedMessageWindow,
  MAX_ACTIVE_MESSAGES_PER_CHAT,
  countUniqueMessages,
  hasCompactedNarrativeWindow,
  mergeMessages,
  messagesFromWindowChanges,
  normalizeMessage,
  trimActiveMessages,
  trimActiveMessagesForDirection,
  trimMessagesWithBranchContext,
} from './messageStoreMerge';

function isLocalOnlyMode() {
  return useAuthStore.getState().authMode === 'local' || !isCloudSyncEnabled();
}

const countedAiMessageKeys = new Set<string>();
// Monotonic local barrier used to invalidate in-flight/outbox writes when a
// chat is cleared. Without it, a request already picked up by the worker can
// arrive after DELETE and resurrect an old branch parent.
const clearedChatAt = new Map<string, number>();
function getClearBarrier(chatId: string) {
  const memory = clearedChatAt.get(chatId);
  if (memory) return memory;
  try {
    const value = Number(localStorage.getItem(scopedStorageKey(`messages-cleared-at-${chatId}`)) || 0);
    if (value > 0) clearedChatAt.set(chatId, value);
    return value;
  } catch {
    return 0;
  }
}
function setClearBarrier(chatId: string, timestamp: number) {
  clearedChatAt.set(chatId, timestamp);
  try { localStorage.setItem(scopedStorageKey(`messages-cleared-at-${chatId}`), String(timestamp)); } catch { /* storage unavailable */ }
}

function recordAiMessageStats(message: Message) {
  if (message.type !== 'ai' || message.isDeleted || message.isStreaming) return;
  const key = message.clientKey || message.serverId || message.id;
  if (!key || countedAiMessageKeys.has(key)) return;
  countedAiMessageKeys.add(key);
  useSettingsStore.getState().recordAiMessageReceived(1);
}

function createLocalMessage(msgData: Omit<Message, 'id' | 'timestamp' | 'isDeleted'> & { timestamp?: number }): Message {
  const timestamp = typeof msgData.timestamp === 'number' ? msgData.timestamp : Date.now();
  const id = `local-message-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ...msgData,
    metadata: compactMessageMetadata(msgData.metadata, { dropContextText: true }),
    id,
    clientKey: id,
    timestamp,
    isDeleted: false,
    isOptimistic: true,
  };
}

async function uploadGuestMessagesToCloud() {
  if (isLocalOnlyMode()) return;
  try {
    const raw = localStorage.getItem(scopedStorageKey('messages-guest'));
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: { messageWindowsByChatId?: Record<string, { messages: Message[] }> } };
    const windows = parsed.state?.messageWindowsByChatId || {};
    for (const chatId of Object.keys(windows)) {
      for (const message of windows[chatId]?.messages || []) {
        if (message.isDeleted || message.type === 'event') continue;
        const cloudMessage = await api.createMessage(chatId, {
          type: message.type,
          senderId: message.senderId,
          senderName: message.senderName,
          content: message.content,
          metadata: hasLocalDataUrlMedia(message) ? scrubLocalMediaUrlsForCloud(message) : message.metadata,
          emotion: message.emotion,
        }) as unknown as Message;
        if (hasLocalDataUrlMedia(message)) {
          await uploadLocalMessageMediaToCloud({ localMessage: message, cloudMessage });
        }
      }
    }
    localStorage.removeItem(scopedStorageKey('messages-guest'));
  } catch {
    // ignore malformed guest cache
  }
}

function localDeleteMessage(message: Message) {
  return { ...message, isDeleted: true };
}

function shouldSkipCloudSync() {
  return isLocalOnlyMode();
}

function mergeLocalWindow(cache: Record<string, CachedMessageWindow>, chatId: string, messages: Message[], pendingOperations: PendingMessageOperation[] = []) {
  const currentWindow = cache[chatId];
  return trimCache({
    ...cache,
    [chatId]: {
      messages: trimMessagesWithBranchContext(messages),
      lastSyncedAt: Date.now(),
      updatedAt: messages.at(-1)?.timestamp || Date.now(),
      remoteExhausted: currentWindow?.remoteExhausted,
      remoteNewerExhausted: currentWindow?.remoteNewerExhausted,
      activeLimit: currentWindow?.activeLimit,
    },
  }, pendingOperations);
}

function locallyMarkDeleted(state: MessageStore, id: string) {
  const nextWindows = Object.fromEntries(
    Object.entries(state.messageWindowsByChatId).map(([chatId, window]) => [
      chatId,
      { ...window, messages: window.messages.map((message) => (message.id === id ? localDeleteMessage(message) : message)) },
    ])
  );
  return {
    messages: state.messages.map((message) => (message.id === id ? localDeleteMessage(message) : message)),
    messageWindowsByChatId: trimCache(nextWindows, state.pendingOperations),
  };
}

function locallyDeleteLastN(state: MessageStore, chatId: string, n: number) {
  const msgs = state.messages.filter((message) => message.chatId === chatId && !message.isDeleted).slice(-n);
  const ids = new Set(msgs.map((message) => message.id));
  const nextMessages = state.messages.map((message) => (ids.has(message.id) ? localDeleteMessage(message) : message));
  const currentWindow = state.messageWindowsByChatId[chatId];
  const nextChatMessages = (currentWindow?.messages || []).map((message) => (ids.has(message.id) ? localDeleteMessage(message) : message));
  return {
    messages: nextMessages,
    messageWindowsByChatId: trimCache({
      ...state.messageWindowsByChatId,
      [chatId]: {
        messages: nextChatMessages,
        lastSyncedAt: Date.now(),
        updatedAt: nextChatMessages.at(-1)?.timestamp || currentWindow?.updatedAt || Date.now(),
        activeLimit: currentWindow?.activeLimit,
      },
    }, state.pendingOperations),
  };
}

function activeMessageWindow(messages: Message[], limit = DEFAULT_MESSAGE_WINDOW_LIMIT) {
  return messages.slice(-limit);
}

function findFirstTimestampGreaterThan(messages: Message[], timestamp: number) {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (messages[mid]?.timestamp <= timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

function findFirstTimestampAtLeast(messages: Message[], timestamp: number) {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (messages[mid]?.timestamp < timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

function getRequestedWindowLimit(requestedLimit = DEFAULT_MESSAGE_WINDOW_LIMIT) {
  return Math.min(
    MAX_ACTIVE_MESSAGES_PER_CHAT,
    Math.max(DEFAULT_MESSAGE_WINDOW_LIMIT, requestedLimit),
  );
}

function canLoadMoreFromWindow(window: CachedMessageWindow | undefined, activeMessages: Message[], limit: number) {
  const cachedMessages = window?.messages || [];
  const earliestActive = activeMessages.filter((message) => !message.isDeleted)
    .reduce<number | undefined>((earliest, message) => earliest === undefined ? message.timestamp : Math.min(earliest, message.timestamp), undefined);
  if (earliestActive !== undefined && cachedMessages.some((message) => !message.isDeleted && message.timestamp < earliestActive)) return true;
  if (shouldSkipCloudSync()) return cachedMessages.length >= limit;
  if (cachedMessages.length < limit) return true;
  return !window?.remoteExhausted;
}

function canLoadNewerFromWindow(window: CachedMessageWindow | undefined, activeMessages: Message[], limit: number) {
  void limit;
  const cachedMessages = window?.messages || [];
  const latestActive = activeMessages.filter((message) => !message.isDeleted)
    .reduce<number | undefined>((latest, message) => latest === undefined ? message.timestamp : Math.max(latest, message.timestamp), undefined);
  if (latestActive !== undefined && cachedMessages.some((message) => !message.isDeleted && message.timestamp > latestActive)) return true;
  // Local mode still keeps a larger retained window than the active render
  // window. After prepending older messages, newer messages may be displaced
  // into that local cache and must be restorable without a cloud request.
  if (shouldSkipCloudSync()) {
    return latestActive !== undefined && cachedMessages.some((message) => !message.isDeleted && message.timestamp > latestActive);
  }
  if (!activeMessages.length) return false;
  return !window?.remoteNewerExhausted;
}

function localHydratedWindow(state: MessageStore, chatId: string, requestedLimit = DEFAULT_MESSAGE_WINDOW_LIMIT) {
  const cachedWindow = state.messageWindowsByChatId[chatId];
  const cachedMessages = cachedWindow?.messages || [];
  const limit = getRequestedWindowLimit(requestedLimit);
  const activeMessages = activeMessageWindow(cachedMessages, limit);
  const nextWindow = cachedWindow ? {
    ...cachedWindow,
    activeLimit: Math.max(activeMessages.length, limit),
  } : null;
  return {
    activeChatId: chatId,
    messages: activeMessages,
    ...(nextWindow ? {
      messageWindowsByChatId: trimCache({
        ...state.messageWindowsByChatId,
        [chatId]: nextWindow,
      }, state.pendingOperations),
    } : {}),
    hasMore: canLoadMoreFromWindow(cachedWindow, activeMessages, limit),
    hasMoreNewer: canLoadNewerFromWindow(cachedWindow, activeMessages, limit),
  };
}

function localUpsertMessage(state: MessageStore, message: Message) {
  const currentWindow = state.messageWindowsByChatId[message.chatId];
  const current = currentWindow?.messages || [];
  const nextChatMessages = trimMessagesWithBranchContext(mergeMessages(current, [message]));
  const nextActiveMessages = trimActiveMessages(mergeMessages(state.messages, [message]));
  return {
    messages: state.activeChatId === message.chatId ? nextActiveMessages : state.messages,
    messageWindowsByChatId: mergeLocalWindow(state.messageWindowsByChatId, message.chatId, nextChatMessages, state.pendingOperations),
  };
}

function localLoadMessages(state: MessageStore, chatId: string, options?: MessageLoadOptions) {
  const currentWindow = state.messageWindowsByChatId[chatId];
  const current = currentWindow?.messages || [];
  const limit = getRequestedWindowLimit(options?.limit ?? DEFAULT_MESSAGE_WINDOW_LIMIT);
  if (options?.aroundTimestamp !== undefined) {
    const target = Number(options.aroundTimestamp);
    const beforeLimit = Math.max(1, Math.ceil(limit / 2));
    const afterLimit = Math.max(0, limit - beforeLimit);
    const splitIndex = findFirstTimestampGreaterThan(current, target);
    const olderMessages = current.slice(Math.max(0, splitIndex - beforeLimit), splitIndex);
    const newerMessages = current.slice(splitIndex, splitIndex + afterLimit);
    const nextMessages = mergeMessages(olderMessages, newerMessages);
    const earliestTimestamp = nextMessages.find((message) => message.chatId === chatId && !message.isDeleted)?.timestamp ?? Number.NEGATIVE_INFINITY;
    const hasMoreLocal = current.some((message) => !message.isDeleted && message.timestamp < earliestTimestamp);
    return {
      messages: nextMessages,
      messageWindowsByChatId: trimCache({
        ...state.messageWindowsByChatId,
        [chatId]: {
          ...(currentWindow || { messages: current, lastSyncedAt: 0, updatedAt: current.at(-1)?.timestamp || Date.now() }),
          activeLimit: Math.max(countUniqueMessages(nextMessages), limit),
        },
      }, state.pendingOperations),
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: hasMoreLocal,
      hasMoreNewer: current.some((message) => !message.isDeleted && message.timestamp > (nextMessages.at(-1)?.timestamp ?? Number.POSITIVE_INFINITY)),
    };
  }
  if (options?.append && options.before !== undefined) {
    const beforeIndex = findFirstTimestampAtLeast(current, Number(options.before));
    const olderMessages = current.slice(Math.max(0, beforeIndex - limit), beforeIndex);
    const activeCurrent = state.activeChatId === chatId ? state.messages : activeMessageWindow(current, limit);
    const nextMessages = trimActiveMessagesForDirection(mergeMessages(activeCurrent, olderMessages), 'older');
    const earliestTimestamp = nextMessages.find((message) => message.chatId === chatId && !message.isDeleted)?.timestamp ?? Number.NEGATIVE_INFINITY;
    const hasMoreLocal = current.some((message) => !message.isDeleted && message.timestamp < earliestTimestamp);
    return {
      messages: nextMessages,
      messageWindowsByChatId: trimCache({
        ...state.messageWindowsByChatId,
        [chatId]: {
          ...(currentWindow || { messages: current, lastSyncedAt: 0, updatedAt: current.at(-1)?.timestamp || Date.now() }),
          activeLimit: Math.max(countUniqueMessages(nextMessages), limit),
        },
      }, state.pendingOperations),
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: hasMoreLocal,
      hasMoreNewer: canLoadNewerFromWindow(currentWindow, nextMessages, limit),
    };
  }
  if (options?.append && options.after !== undefined) {
    const afterIndex = findFirstTimestampGreaterThan(current, Number(options.after));
    const newerMessages = current.slice(afterIndex, afterIndex + limit);
    const activeCurrent = state.activeChatId === chatId ? state.messages : activeMessageWindow(current, limit);
    const nextMessages = trimActiveMessagesForDirection(mergeMessages(activeCurrent, newerMessages), 'newer');
    const latestTimestamp = nextMessages.at(-1)?.timestamp ?? Number.POSITIVE_INFINITY;
    return {
      messages: nextMessages,
      messageWindowsByChatId: trimCache({
        ...state.messageWindowsByChatId,
        [chatId]: {
          ...(currentWindow || { messages: current, lastSyncedAt: 0, updatedAt: current.at(-1)?.timestamp || Date.now() }),
          activeLimit: Math.max(countUniqueMessages(nextMessages), limit),
        },
      }, state.pendingOperations),
      activeChatId: chatId,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: canLoadMoreFromWindow(currentWindow, nextMessages, limit),
      hasMoreNewer: current.some((message) => !message.isDeleted && message.timestamp > latestTimestamp),
    };
  }
  const activeMessages = activeMessageWindow(current, limit);
  return {
    messages: activeMessages,
    activeChatId: chatId,
    isLoading: false,
    isLoadingOlder: false,
    isLoadingNewer: false,
    hasMore: canLoadMoreFromWindow(currentWindow, activeMessages, limit),
    hasMoreNewer: canLoadNewerFromWindow(currentWindow, activeMessages, limit),
  };
}

function localAddMessage(state: MessageStore, msgData: Omit<Message, 'id' | 'timestamp' | 'isDeleted'>) {
  const message = createLocalMessage(msgData);
  return {
    message,
    ...localUpsertMessage(state, message),
  };
}

function logMessageWindowDebug(event: string, payload: Record<string, unknown>) {
  logDeveloperDiagnostic(`message-window:${event}`, payload, 'debug', 'message-window');
}

function summarizeMessageWindows(cache: Record<string, CachedMessageWindow>, focusChatId?: string) {
  const entries = Object.entries(cache)
    .sort((left, right) => {
      if (focusChatId && left[0] === focusChatId) return -1;
      if (focusChatId && right[0] === focusChatId) return 1;
      return right[1].updatedAt - left[1].updatedAt;
    })
    .slice(0, 8);
  return entries.map(([chatId, window]) => ({
    chatId,
    messages: window.messages?.length || 0,
    activeLimit: window.activeLimit,
    updatedAt: window.updatedAt,
    remoteExhausted: window.remoteExhausted,
    remoteNewerExhausted: window.remoteNewerExhausted,
    firstTimestamp: window.messages?.[0]?.timestamp,
    lastTimestamp: window.messages?.at(-1)?.timestamp,
  }));
}

function localMessageInsertResult(state: MessageStore, msgData: Omit<Message, 'id' | 'timestamp' | 'isDeleted'>) {
  return localAddMessage(state, msgData);
}

function localMessageDeletionResult(state: MessageStore, id: string) {
  return locallyMarkDeleted(state, id);
}

function localMessageDeleteBatchResult(state: MessageStore, chatId: string, n: number) {
  return locallyDeleteLastN(state, chatId, n);
}

function localFetchedMessages(state: MessageStore, chatId: string, options?: MessageLoadOptions) {
  return localLoadMessages(state, chatId, options);
}

function localHydratedMessages(state: MessageStore, chatId: string, limit?: number) {
  return localHydratedWindow(state, chatId, limit);
}


const DEFAULT_MESSAGE_WINDOW_LIMIT = 40;
const MAX_CACHED_CHATS = 12;
const MAX_PERSISTED_DATA_URL_CHARS = 2048;

interface PendingMessageOperation {
  id: string;
  kind: 'create' | 'delete';
  chatId: string;
  localMessageId?: string;
  messageId?: string;
  payload?: Message;
  createdAt: number;
  attemptCount: number;
  status: 'pending' | 'syncing' | 'failed';
  lastError?: string;
  retryAt?: number;
  lockedAt?: number;
}

type MessageLoadOptions = { append?: boolean; before?: number; after?: number; aroundTimestamp?: number; limit?: number; resetWindow?: boolean };

type CloudMessageFetchStrategy =
  | { kind: 'window-snapshot'; reason: 'initial_or_revalidate' }
  | { kind: 'paged-history'; reason: 'append' | 'around_timestamp' | 'reset_window' | 'compacted_narrative' };

function selectCloudMessageFetchStrategy(options: MessageLoadOptions | undefined, currentWindow: CachedMessageWindow | undefined): CloudMessageFetchStrategy {
  if (options?.append || options?.before !== undefined || options?.after !== undefined) {
    return { kind: 'paged-history', reason: 'append' };
  }
  if (options?.aroundTimestamp !== undefined) {
    return { kind: 'paged-history', reason: 'around_timestamp' };
  }
  if (options?.resetWindow) {
    return { kind: 'paged-history', reason: 'reset_window' };
  }
  if (hasCompactedNarrativeWindow(currentWindow)) {
    return { kind: 'paged-history', reason: 'compacted_narrative' };
  }
  return { kind: 'window-snapshot', reason: 'initial_or_revalidate' };
}

function buildMessageFetchOptions(options: {
  limit: number;
  before?: number;
  after?: number;
  aroundTimestamp?: number;
}) {
  return {
    limit: options.limit,
    ...(options.before !== undefined ? { before: options.before } : {}),
    ...(options.after !== undefined ? { after: options.after } : {}),
    ...(options.aroundTimestamp !== undefined ? { aroundTimestamp: options.aroundTimestamp } : {}),
  };
}

function pendingMessageOperationPriority(operation: PendingMessageOperation) {
  if (operation.kind !== 'create') return 20;
  // Branch children must never overtake an older unsynced parent. The queue
  // worker selects the highest priority item, so ordering creates by message
  // timestamp (oldest first) preserves the graph's causal write order even
  // when optimistic updates enqueue in a different React/render turn.
  const timestamp = Number(operation.payload?.timestamp ?? operation.createdAt);
  return 1e15 - timestamp;
}

function isTerminalMessageSyncError(classified: string) {
  if (/BRANCH_PARENT_NOT_FOUND|chat:create pending|CHAT_CREATE_PENDING/i.test(classified)) return false;
  return isTerminalSyncError(classified);
}

interface PersistedMessageState {
  messageWindowsByChatId: Record<string, CachedMessageWindow>;
  pendingOperations: PendingMessageOperation[];
}

function getUserId() {
  return getLocalDataUserId();
}

function getMessageStorageKey() {
  return scopedStorageKey(`messages-${getUserId()}`);
}

function getMessageStoreStorageName() {
  return scopedStorageKey('messages');
}

function createMessageStorage(key = getMessageStorageKey()) {
  return createScopedIndexedDbBufferedJsonStorage<PersistedMessageState>({
    getScopedKey: () => key,
    storageName: getMessageStoreStorageName(),
    flushDelayMs: 64,
  });
}

export function clearPersistedMessageStore() {
  void useMessageStore.persist.clearStorage();
  localStorage.removeItem(getMessageStorageKey());
  localStorage.removeItem(getMessageStoreStorageName());
  messageSyncScopes.clear();
}

export async function resetMessageStoreForAccountBoundary() {
  const storage = createMessageStorage(getMessageStorageKey());
  const storageName = getMessageStoreStorageName();
  const preservedSnapshot = await storage.getItem(storageName);
  messageSyncScopes.clear();
  logMessageWindowDebug('reset-account-boundary', {
    existingWindows: summarizeMessageWindows(useMessageStore.getState().messageWindowsByChatId),
  });
  useMessageStore.setState({
    messages: [],
    messageWindowsByChatId: {},
    pendingOperations: [],
    activeChatId: null,
    isLoading: false,
    isLoadingOlder: false,
    isLoadingNewer: false,
    hasMore: true,
    hasMoreNewer: false,
  });
  flushBufferedPersistenceWrites();
  if (preservedSnapshot != null) {
    await storage.setItem(storageName, preservedSnapshot);
  } else {
    await storage.removeItem(storageName);
  }
}

function isInlineDataUrl(value: string) {
  return /^data:[^;]+;base64,/i.test(value);
}

function shouldDropPersistedString(key: string, value: string) {
  const normalizedKey = key.toLowerCase();
  return isInlineDataUrl(value) && (
    value.length > MAX_PERSISTED_DATA_URL_CHARS
    || normalizedKey.includes('dataurl')
    || normalizedKey === 'url'
    || normalizedKey.endsWith('url')
  );
}

function stripLargeInlineMediaForPersistence<T>(value: T, key = '', seen = new WeakSet<object>()): T {
  if (typeof value === 'string') {
    return (shouldDropPersistedString(key, value) ? undefined : value) as T;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined as T;
  seen.add(value);
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
}

function compactMessageForPersistence(message: Message, options: { stripInlineMedia?: boolean } = {}) {
  const normalized = compactMessage(normalizeMessage(message), { dropContextText: true });
  const persisted = { ...normalized };
  delete persisted.isStreaming;
  if (options.stripInlineMedia === false) return persisted;
  return {
    ...persisted,
    metadata: stripLargeInlineMediaForPersistence(normalized.metadata),
  };
}

function compactPendingMessageOperation(operation: PendingMessageOperation): PendingMessageOperation {
  const payload = operation.payload ? compactMessage(operation.payload, { dropContextText: true }) : undefined;
  return {
    ...operation,
    payload: payload ? stripLargeInlineMediaForPersistence(payload) : undefined,
  };
}

let lastPersistedMessageStateInput: {
  messageWindowsByChatId: PersistedMessageState['messageWindowsByChatId'];
  pendingOperations: PersistedMessageState['pendingOperations'];
} | null = null;
let lastPersistedMessageStateOutput: PersistedMessageState | null = null;

function buildPersistedMessageState(state: PersistedMessageState): PersistedMessageState {
  if (
    lastPersistedMessageStateInput
    && lastPersistedMessageStateOutput
    && lastPersistedMessageStateInput.messageWindowsByChatId === state.messageWindowsByChatId
    && lastPersistedMessageStateInput.pendingOperations === state.pendingOperations
  ) {
    return lastPersistedMessageStateOutput;
  }
  const pendingOperations = recoverInterruptedOperations(state.pendingOperations || []).map(compactPendingMessageOperation);
  const compactedWindows = Object.fromEntries(Object.entries(state.messageWindowsByChatId || {}).map(([chatId, window]) => [chatId, {
    ...window,
    messages: (window.messages || []).map((message) => compactMessageForPersistence(message, { stripInlineMedia: false })),
  }]));
  const persisted = {
    messageWindowsByChatId: trimCache(compactedWindows, pendingOperations),
    pendingOperations,
  };
  lastPersistedMessageStateInput = {
    messageWindowsByChatId: state.messageWindowsByChatId,
    pendingOperations: state.pendingOperations,
  };
  lastPersistedMessageStateOutput = persisted;
  return persisted;
}

function getPendingChatIds(pendingOperations: PendingMessageOperation[] = []) {
  return new Set(pendingOperations.map((operation) => operation.chatId).filter(Boolean));
}

function trimCache(cache: Record<string, CachedMessageWindow>, pendingOperations: PendingMessageOperation[] = []) {
  const pendingChatIds = getPendingChatIds(pendingOperations);
  const entries = Object.entries(cache).sort((a, b) => {
    const aPending = pendingChatIds.has(a[0]) ? 1 : 0;
    const bPending = pendingChatIds.has(b[0]) ? 1 : 0;
    if (aPending !== bPending) return bPending - aPending;
    return b[1].updatedAt - a[1].updatedAt;
  });
  if (entries.length > MAX_CACHED_CHATS) {
    logMessageWindowDebug('trim-cache-evict', {
      totalWindows: entries.length,
      keptWindows: entries.slice(0, MAX_CACHED_CHATS).map(([chatId, window]) => ({
        chatId,
        messages: window.messages?.length || 0,
        updatedAt: window.updatedAt,
      })),
      evictedWindows: entries.slice(MAX_CACHED_CHATS).map(([chatId, window]) => ({
        chatId,
        messages: window.messages?.length || 0,
        updatedAt: window.updatedAt,
      })),
    });
  }
  return Object.fromEntries(
    entries
      .slice(0, MAX_CACHED_CHATS)
      .map(([chatId, window]) => [chatId, { ...window, messages: trimMessagesWithBranchContext(window.messages) }])
  );
}

const messageStorage = createMessageStorage();
const MESSAGE_SYNC_DELAYS = [1000, 3000, 10000, 30000];
const MESSAGE_WINDOW_REFRESH_TTL_MS = 5 * 60_000;
const messageSyncScheduler = createSyncScheduler('message.pending-operations', {
  priority: () => getPendingQueueWorkerPriority(useMessageStore.getState().pendingOperations, 100, pendingMessageOperationPriority),
});
const messageWindowScopeSyncScheduler = createSyncScheduler('message.window-scope-refresh', { priority: 20 });
const messageSyncScopes = createSyncScopeMetadata(MESSAGE_WINDOW_REFRESH_TTL_MS, {
  getStorageKey: () => scopedStorageKey(`message-sync-scopes-${getLocalDataUserId()}`),
});
let messageSyncLifecycleRegistered = false;
let messageHydrationPromise: Promise<void> | null = null;
let messageStoreHydrated = false;

function ensureMessageStoreHydrated(): Promise<void> {
  if (messageStoreHydrated || useMessageStore.persist.hasHydrated()) {
    messageStoreHydrated = true;
    return Promise.resolve();
  }
  messageHydrationPromise ??= Promise.resolve(useMessageStore.persist.rehydrate()).finally(() => {
    messageStoreHydrated = true;
    messageHydrationPromise = null;
  });
  return messageHydrationPromise;
}

function shouldRevalidateMessageWindow(lastSyncedAt: number | undefined, revalidate?: boolean) {
  if (!revalidate) return false;
  if (!lastSyncedAt) return true;
  return Date.now() - lastSyncedAt > 15_000;
}

const messageWindowScope = (chatId: string): SyncChangeScope => `messages.window:${chatId}`;

async function probeMessageWindowChanges(chatId: string, options: { forceSnapshot?: boolean } = {}) {
  const scope = messageWindowScope(chatId);
  const scopeState = messageSyncScopes.getState(scope);
  const since = options.forceSnapshot ? null : scopeState.cursor ?? scopeState.revision ?? null;
  try {
    return await api.getSyncChanges({ scope, since });
  } catch {
    return null;
  }
}

function createPendingMessageOperation(message: Message): PendingMessageOperation {
  const operationId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${message.id}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id: `message-create-${operationId}`,
    kind: 'create',
    chatId: message.chatId,
    localMessageId: message.id,
    messageId: message.serverId || message.id,
    payload: compactMessage(message, { dropContextText: true }),
    createdAt: Date.now(),
    attemptCount: 0,
    status: 'pending',
  };
}

function messagePayloadForCloud(message: Message, operationId: string) {
  const compactedMetadata = compactMessageMetadata(
    hasLocalDataUrlMedia(message) ? scrubLocalMediaUrlsForCloud(message) : message.metadata,
    { dropContextText: true },
  );
  const metadata = compactedMetadata && typeof compactedMetadata === 'object' && !Array.isArray(compactedMetadata)
    ? {
        ...compactedMetadata,
        ...(compactedMetadata.branching && typeof compactedMetadata.branching === 'object' && !Array.isArray(compactedMetadata.branching)
          ? {
              branching: {
                ...compactedMetadata.branching,
                nodeId: typeof compactedMetadata.branching.nodeId === 'string' && compactedMetadata.branching.nodeId.trim()
                  ? compactedMetadata.branching.nodeId
                  : (message.clientKey || message.id),
              },
            }
          : {}),
      }
    : compactedMetadata;
  return {
    type: message.type,
    senderId: message.senderId,
    senderName: message.senderName,
    content: message.content,
    metadata,
    emotion: message.emotion,
    timestamp: message.timestamp,
    clientKey: message.clientKey || message.id,
    operationId,
  };
}

function normalizeFetchedCloudMessage(message: Message): Message {
  const sync = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>).sync
    : null;
  const clientKey = message.clientKey
    || (sync && typeof sync === 'object' && !Array.isArray(sync) && typeof (sync as Record<string, unknown>).clientKey === 'string'
      ? (sync as Record<string, unknown>).clientKey as string
      : undefined);
  return normalizeMessage({
    ...message,
    clientKey,
    serverId: message.serverId || message.id,
  });
}

function mergeMessageServerConfirmation(localMessage: Message, savedMessage: unknown): Message {
  const saved = savedMessage as Partial<Message> | null | undefined;
  return {
    ...localMessage,
    serverId: saved?.serverId || saved?.id || localMessage.serverId,
    clientKey: localMessage.clientKey || saved?.clientKey,
    isDeleted: Boolean(saved?.isDeleted ?? localMessage.isDeleted),
    isOptimistic: false,
    isStreaming: false,
  };
}

function upsertPendingCreateOperation(queue: PendingMessageOperation[], message: Message) {
  const clientKey = message.clientKey || message.id;
  const existing = queue.find((operation) => operation.kind === 'create' && (
    operation.localMessageId === message.id || operation.payload?.clientKey === clientKey
  ));
  if (existing) {
    return queue.map((operation) => operation.id === existing.id
      ? { ...operation, payload: compactMessage(message, { dropContextText: true }), status: operation.status === 'syncing' ? 'syncing' as const : 'pending' as const }
      : operation);
  }
  return [...queue, createPendingMessageOperation(message)];
}

function hasPendingCreateOperation(queue: PendingMessageOperation[], message: Message) {
  const clientKey = message.clientKey || message.id;
  return queue.some((operation) => operation.kind === 'create' && (
    operation.localMessageId === message.id || operation.payload?.clientKey === clientKey
  ));
}

function hasPendingChatCreate(chatId: string) {
  return useChatStore.getState().pendingOperations.some((operation) => (
    operation.kind === 'create'
    && operation.entityId === chatId
    && operation.status !== 'failed'
  ));
}

function isChatCreatePendingForMessages(chatId: string) {
  if (shouldSkipCloudSync()) return false;
  return hasPendingChatCreate(chatId);
}

function scheduleChatSyncFirst() {
  void useChatStore.getState().resumeSync();
}

/**
 * A chat can already exist remotely while an interrupted local create
 * operation is still persisted (for example after a reload during sync).
 * In that case treating the operation as authoritative prevents any message
 * request from being sent and leaves the detail page blank. Confirm the
 * remote resource before waiting for the outbox again.
 */
async function reconcilePendingChatCreate(chatId: string) {
  if (!isChatCreatePendingForMessages(chatId)) return false;
  try {
    await api.getChat(chatId);
    useChatStore.getState().confirmCreateOperationsSynced([chatId]);
    return true;
  } catch {
    return false;
  }
}

function ensureLocalChatCreateQueued(chatId: string) {
  if (shouldSkipCloudSync() || hasPendingChatCreate(chatId)) return false;
  const chat = useChatStore.getState().chats.find((item) => item.id === chatId && item.deletedAt == null);
  if (!chat) return false;
  if (!canRecreateMissingCloudChat(chat, useCharacterStore.getState().characters)) return false;
  void useChatStore.getState().syncPatch(chatId, { ...chat, id: chat.id } as Record<string, unknown>, 'create');
  scheduleChatSyncFirst();
  return true;
}

function isCloudMissingResourceError(error: unknown) {
  return error instanceof ApiError && (
    error.status === 404
    || error.code?.toUpperCase() === 'NOT_FOUND'
  );
}

function removePendingMessageOperation(queue: PendingMessageOperation[], operationId: string) {
  return queue.filter((operation) => operation.id !== operationId);
}

function updatePendingMessageOperation(queue: PendingMessageOperation[], operationId: string, patch: Partial<PendingMessageOperation>) {
  return queue.map((operation) => operation.id === operationId ? { ...operation, ...patch } : operation);
}

interface MessageStore {
  messages: Message[];
  messageWindowsByChatId: Record<string, CachedMessageWindow>;
  pendingOperations: PendingMessageOperation[];
  activeChatId: string | null;
  isLoading: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  hasMore: boolean;
  hasMoreNewer: boolean;

  hydrateMessagesFromCache: (chatId: string, options?: { limit?: number }) => Promise<void>;
  openChatWindow: (chatId: string, options?: { limit?: number; revalidate?: boolean; aroundTimestamp?: number; resetWindow?: boolean }) => Promise<void>;
  closeChatWindow: (chatId: string, options?: { clearActiveOnly?: boolean }) => void;
  prefetchMessages: (chatId: string, options?: { limit?: number }) => Promise<void>;
  hasMessageWindow: (chatId: string) => boolean;
  loadMessages: (chatId: string, options?: MessageLoadOptions) => Promise<void>;
  addMessage: (msg: Omit<Message, 'id' | 'timestamp' | 'isDeleted'> & { timestamp?: number }) => Promise<Message>;
  upsertMessage: (message: Message) => void;
  upsertMessages: (messages: Message[]) => void;
  queueMessageSync: (message: Message) => void;
  flushPendingOperations: () => Promise<void>;
  discardFailedOperation: (operationId: string) => void;
  retryFailedOperations: () => void;
  clearChatMessagesLocal: (chatId: string) => void;
  deleteMessage: (id: string) => Promise<void>;
  withdrawMessage: (id: string) => Promise<void>;
  deleteLastNMessages: (chatId: string, n: number) => Promise<void>;
  clearMessages: () => void;
  getRecentMessages: (n: number) => Message[];
  getSyncScopeStates: () => SyncScopeSnapshot[];
}

export const useMessageStore = create<MessageStore>()(
  persist(
    (set, get) => {
      const flushPendingOperations = async () => {
        await mirrorLocalOutboxWorkerQueue('message', get().pendingOperations);
        await runPendingOperationQueue<PendingMessageOperation>({
          getOperations: () => get().pendingOperations,
          canRun: canAttemptOnlineSync,
          retryDelays: MESSAGE_SYNC_DELAYS,
          isTerminalError: isTerminalMessageSyncError,
          priority: pendingMessageOperationPriority,
          batchSize: 3,
          updateOperation: (operationId, operation) => {
            set((current) => ({
              pendingOperations: updatePendingMessageOperation(current.pendingOperations, operationId, operation),
            }));
            markLocalOutboxWorkerOperation(operation);
          },
          execute: async (operation) => {
            if (operation.kind === 'create' && operation.payload) {
              const localMessage = operation.payload;
              const clearBarrier = getClearBarrier(localMessage.chatId);
              if (clearBarrier && Number(localMessage.timestamp || 0) <= clearBarrier) {
                return null as never;
              }
              if (hasPendingChatCreate(localMessage.chatId)) {
                scheduleChatSyncFirst();
                if (await reconcilePendingChatCreate(localMessage.chatId)) {
                  // The chat was created remotely while its local outbox
                  // marker was still pending; continue with the message.
                } else {
                  throw new ApiError('chat:create pending: 对应会话尚未完成云端创建，消息稍后重试。', { code: 'CHAT_CREATE_PENDING', status: 409 });
                }
              }
              const parentNodeId = typeof localMessage.metadata?.branching?.parentNodeId === 'string' ? localMessage.metadata.branching.parentNodeId.trim() : '';
              const parentPending = parentNodeId && get().pendingOperations.some((operation) => {
                if (operation.kind !== 'create' || operation.localMessageId === localMessage.id || operation.chatId !== localMessage.chatId) return false;
                const candidate = operation.payload;
                const nodeId = candidate?.metadata?.branching?.nodeId;
                return nodeId === parentNodeId || candidate?.id === parentNodeId || candidate?.clientKey === parentNodeId;
              });
              if (parentPending) {
                throw new ApiError('branch parent pending: 分支父消息尚未完成云端同步，子消息稍后重试。', { code: 'BRANCH_PARENT_PENDING', status: 409 });
              }
              let savedMessage: unknown;
              try {
                savedMessage = await api.createMessage(localMessage.chatId, messagePayloadForCloud(localMessage, operation.id));
              } catch (error) {
                const barrier = getClearBarrier(localMessage.chatId);
                if (barrier && Number(localMessage.timestamp || 0) <= barrier && error instanceof ApiError && error.code === 'BRANCH_PARENT_NOT_FOUND') {
                  return null as never;
                }
                throw error;
              }
              const persistedMessage = mergeMessageServerConfirmation(localMessage, savedMessage);
              set((current) => ({
                ...localUpsertMessage(current, persistedMessage),
                pendingOperations: removePendingMessageOperation(current.pendingOperations, operation.id),
              }));
              completeLocalOutboxWorkerOperation(operation.id);
              window.setTimeout(() => removeLocalOutboxWorkerOperation(operation.id), 1500);
              if (hasLocalDataUrlMedia(localMessage)) {
                await uploadLocalMessageMediaToCloud({ localMessage, cloudMessage: persistedMessage });
              }
            }
          },
          onSuccess: (operation) => {
            set((current) => ({
              pendingOperations: removePendingMessageOperation(current.pendingOperations, operation.id),
            }));
            completeLocalOutboxWorkerOperation(operation.id);
            window.setTimeout(() => removeLocalOutboxWorkerOperation(operation.id), 1500);
          },
          onFailure: (operation, _error, retry) => {
            const stillQueued = get().pendingOperations.some((item) => item.id === operation.id);
            if (stillQueued) {
              markLocalOutboxWorkerOperation(retry.retryOperation);
              return;
            }
            removeLocalOutboxWorkerOperation(operation.id);
          },
          scheduleNext: (delay) => messageSyncScheduler.schedule(flushPendingOperations, delay),
        });
      };
      const refreshCachedMessageWindows = async () => {
        await ensureMessageStoreHydrated();
        if (shouldSkipCloudSync()) return;
        const cachedWindows = Object.entries(get().messageWindowsByChatId)
          .filter(([, window]) => window.messages?.length)
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
          .slice(0, 5);
        for (const [chatId, cachedWindow] of cachedWindows) {
          const scope = messageWindowScope(chatId);
          const shouldRefreshCompactedNarrative = hasCompactedNarrativeWindow(cachedWindow);
          if (!shouldRefreshCompactedNarrative && messageSyncScopes.isFresh(scope)) continue;
          try {
            const scopeState = messageSyncScopes.getState(scope);
            const changeProbe = shouldRefreshCompactedNarrative
              ? null
              : await api.getSyncChanges({ scope, since: scopeState.cursor ?? scopeState.revision ?? null });
            if (changeProbe?.status === 'not_modified') {
              messageSyncScopes.markChecked(scope, {
                cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                applied: false,
              });
              continue;
            }
            const fetchedFromChanges = messagesFromWindowChanges(changeProbe?.changes, chatId);
            const fetched = fetchedFromChanges
              || await api.getMessages(chatId, { limit: DEFAULT_MESSAGE_WINDOW_LIMIT }) as unknown as Message[];
            set((state) => {
              const currentWindow = state.messageWindowsByChatId[chatId] || cachedWindow;
              const merged = mergeMessages(currentWindow.messages || [], fetched);
              const trimmed = trimMessagesWithBranchContext(merged);
              const nextCache = trimCache({
                ...state.messageWindowsByChatId,
                [chatId]: {
              messages: trimMessagesWithBranchContext(trimmed),
                  lastSyncedAt: Date.now(),
                  updatedAt: trimmed.at(-1)?.timestamp || currentWindow.updatedAt || Date.now(),
                  remoteExhausted: fetchedFromChanges ? currentWindow.remoteExhausted : fetched.length < DEFAULT_MESSAGE_WINDOW_LIMIT,
                  remoteNewerExhausted: currentWindow.remoteNewerExhausted ?? true,
                  activeLimit: currentWindow.activeLimit,
                },
              }, state.pendingOperations);
              if (changeProbe) {
                messageSyncScopes.markChecked(scope, {
                  cursor: changeProbe.cursor,
                    revision: changeProbe?.revision,
                    fresh: !changeProbe?.hasMore,
                  applied: fetched.length > 0,
                });
              }
              return {
                messageWindowsByChatId: nextCache,
                messages: state.activeChatId === chatId
                  ? activeMessageWindow(trimmed, DEFAULT_MESSAGE_WINDOW_LIMIT)
                  : state.messages,
              };
            });
          } catch (error) {
            messageSyncScopes.markError(scope, error);
          }
        }
      };

      if (!messageSyncLifecycleRegistered) {
        messageSyncScheduler.registerLifecycle(flushPendingOperations, 300);
        messageWindowScopeSyncScheduler.registerLifecycle(refreshCachedMessageWindows, 700);
        messageSyncLifecycleRegistered = true;
      }

      return {
        messages: [],
      messageWindowsByChatId: {},
      pendingOperations: [],
      activeChatId: null,
      isLoading: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMore: true,
      hasMoreNewer: false,

      hydrateMessagesFromCache: (chatId, options) => {
        const applyCachedWindow = () => {
          const limit = options?.limit ?? DEFAULT_MESSAGE_WINDOW_LIMIT;
          const beforeWindow = get().messageWindowsByChatId[chatId];
          logMessageWindowDebug('hydrate-cache-start', {
            chatId,
            cachedWindowMessages: beforeWindow?.messages?.length || 0,
            cachedWindowActiveLimit: beforeWindow?.activeLimit,
            requestedLimit: limit,
            activeMessagesBefore: get().messages.filter((message) => message.chatId === chatId).length,
          });
          set((state) => localHydratedMessages(state, chatId, limit));
          logMessageWindowDebug('hydrate-cache-done', {
            chatId,
            cachedWindowMessages: get().messageWindowsByChatId[chatId]?.messages?.length || 0,
            activeMessagesAfter: get().messages.filter((message) => message.chatId === chatId).length,
            hasMore: get().hasMore,
            hasMoreNewer: get().hasMoreNewer,
          });
        };
        if (messageStoreHydrated) {
          applyCachedWindow();
          return Promise.resolve();
        }
        return ensureMessageStoreHydrated().then(applyCachedWindow);
      },

      openChatWindow: async (chatId: string, options?: { limit?: number; revalidate?: boolean; aroundTimestamp?: number; resetWindow?: boolean }) => {
        await ensureMessageStoreHydrated();
        if (!shouldSkipCloudSync()) messageSyncScheduler.schedule(flushPendingOperations, 100);
        if (options?.aroundTimestamp !== undefined) {
          await get().loadMessages(chatId, { limit: options.limit, aroundTimestamp: options.aroundTimestamp });
          // A stale reading position can legitimately point outside the
          // retained message range (for example after a cloud restore). Do
          // not leave the detail page blank in that case; fall back to the
          // latest window so the conversation remains discoverable.
          if (!get().messageWindowsByChatId[chatId]?.messages?.length) {
            logMessageWindowDebug('open-around-empty-fallback-tail', {
              chatId,
              aroundTimestamp: options.aroundTimestamp,
            });
            await get().loadMessages(chatId, { limit: options.limit, resetWindow: true });
          }
          return;
        }
        if (options?.resetWindow) {
          await get().loadMessages(chatId, { limit: options.limit, resetWindow: true });
          return;
        }
        const currentWindow = get().messageWindowsByChatId[chatId];
        const limit = options?.limit ?? DEFAULT_MESSAGE_WINDOW_LIMIT;
        const shouldPrimePartialCloudWindow = !shouldSkipCloudSync() && (currentWindow?.messages?.length || 0) > 0 && (currentWindow?.messages?.length || 0) < limit;
        logMessageWindowDebug('open', {
          chatId,
          limit,
          cloudSync: !shouldSkipCloudSync(),
          cachedWindowMessages: currentWindow?.messages?.length || 0,
          cachedWindowActiveLimit: currentWindow?.activeLimit,
          cachedRemoteExhausted: currentWindow?.remoteExhausted,
          cachedRemoteNewerExhausted: currentWindow?.remoteNewerExhausted,
          activeMessages: get().messages.filter((message) => message.chatId === chatId).length,
          shouldPrimePartialCloudWindow,
          revalidate: options?.revalidate ?? true,
        });
        await get().hydrateMessagesFromCache(chatId, { limit });
        if (isChatCreatePendingForMessages(chatId)) {
          if (await reconcilePendingChatCreate(chatId)) {
            await get().loadMessages(chatId, { limit });
            return;
          }
          scheduleChatSyncFirst();
          messageSyncScheduler.schedule(flushPendingOperations, 450);
          return;
        }
        const hydratedWindow = get().messageWindowsByChatId[chatId];
        const shouldRevalidate = shouldRevalidateMessageWindow(currentWindow?.lastSyncedAt, options?.revalidate ?? true);
        const shouldRefreshCompactedNarrative = hasCompactedNarrativeWindow(hydratedWindow);
        logMessageWindowDebug('hydrated', {
          chatId,
          limit,
          activeMessages: get().messages.filter((message) => message.chatId === chatId).length,
          cachedWindowMessages: hydratedWindow?.messages?.length || 0,
          shouldRevalidate,
          shouldPrimePartialCloudWindow,
          shouldRefreshCompactedNarrative,
        });
        if (!hydratedWindow?.messages?.length) {
          await get().loadMessages(chatId, { limit });
          return;
        }
        if (shouldRevalidate || shouldPrimePartialCloudWindow || shouldRefreshCompactedNarrative) {
          void get().loadMessages(chatId, { limit, resetWindow: shouldRefreshCompactedNarrative });
        }
      },

      closeChatWindow: (chatId: string, options?: { clearActiveOnly?: boolean }) => {
        if (options?.clearActiveOnly) {
          set((state) => ({
            activeChatId: state.activeChatId === chatId ? null : state.activeChatId,
            messages: state.activeChatId === chatId ? [] : state.messages,
            hasMore: state.activeChatId === chatId ? false : state.hasMore,
            hasMoreNewer: state.activeChatId === chatId ? false : state.hasMoreNewer,
          }));
          return;
        }
        get().clearChatMessagesLocal(chatId);
      },

      prefetchMessages: async (chatId: string, options?: { limit?: number }) => {
        await ensureMessageStoreHydrated();
        if (get().messageWindowsByChatId[chatId]?.messages?.length) return;
        await get().loadMessages(chatId, { limit: options?.limit ?? DEFAULT_MESSAGE_WINDOW_LIMIT });
      },

      hasMessageWindow: (chatId: string) => Boolean(get().messageWindowsByChatId[chatId]?.messages?.length),

      loadMessages: async (chatId, options) => {
        const isAppend = Boolean(options?.append);
        const isAppendNewer = isAppend && options?.after !== undefined;
        set({ isLoading: !isAppend, isLoadingOlder: isAppend && !isAppendNewer, isLoadingNewer: isAppendNewer, activeChatId: chatId });
        logMessageWindowDebug('load-start', {
          chatId,
          options: options || {},
          cloudSync: !shouldSkipCloudSync(),
          cachedWindowMessages: get().messageWindowsByChatId[chatId]?.messages?.length || 0,
          activeMessages: get().messages.filter((message) => message.chatId === chatId).length,
        });
        if (shouldSkipCloudSync()) {
          set((state) => localFetchedMessages(state, chatId, options));
          return;
        }
        if (isChatCreatePendingForMessages(chatId)) {
          if (await reconcilePendingChatCreate(chatId)) {
            return get().loadMessages(chatId, options);
          }
          scheduleChatSyncFirst();
          messageSyncScheduler.schedule(flushPendingOperations, 450);
          set((state) => ({
            ...localFetchedMessages(state, chatId, options),
            isLoading: false,
            isLoadingOlder: false,
            isLoadingNewer: false,
          }));
          return;
        }
        try {
          await uploadGuestMessagesToCloud();
          const currentWindowBeforeFetch = get().messageWindowsByChatId[chatId];
          const identitiesBeforeFetch = new Set([
            ...(currentWindowBeforeFetch?.messages || []),
            ...get().messages.filter((message) => message.chatId === chatId),
          ].flatMap(buildMessageIdentityKeys));
          const pendingIdentitiesBeforeFetch = new Set(get().pendingOperations
            .filter((operation) => operation.chatId === chatId && operation.kind === 'create')
            .flatMap((operation) => operation.payload ? buildMessageIdentityKeys(operation.payload) : [operation.localMessageId || '']));
          const isAroundWindow = options?.aroundTimestamp !== undefined;
          const limit = getRequestedWindowLimit(options?.limit ?? DEFAULT_MESSAGE_WINDOW_LIMIT);
          const fetchStrategy = selectCloudMessageFetchStrategy(options, currentWindowBeforeFetch);
          const canUseWindowSnapshot = fetchStrategy.kind === 'window-snapshot';
          const canProbeWindow = canUseWindowSnapshot && Boolean(currentWindowBeforeFetch?.messages?.length);
          if (canProbeWindow && messageSyncScopes.isFresh(messageWindowScope(chatId))) {
            const activeMessages = activeMessageWindow(currentWindowBeforeFetch?.messages || [], limit);
            set(() => ({
              activeChatId: chatId,
              messages: activeMessages,
              isLoading: false,
              isLoadingOlder: false,
              isLoadingNewer: false,
              hasMore: canLoadMoreFromWindow(currentWindowBeforeFetch, activeMessages, limit),
              hasMoreNewer: canLoadNewerFromWindow(currentWindowBeforeFetch, activeMessages, limit),
            }));
            return;
          }
          const shouldForceWindowSnapshot = canUseWindowSnapshot && !currentWindowBeforeFetch?.messages?.length;
          const changeProbe = canUseWindowSnapshot ? await probeMessageWindowChanges(chatId, { forceSnapshot: shouldForceWindowSnapshot }) : null;
          if (changeProbe?.status === 'not_modified' && currentWindowBeforeFetch?.messages?.length) {
            const liveWindow = get().messageWindowsByChatId[chatId];
            const activeMessages = activeMessageWindow(liveWindow?.messages || [], limit);
            messageSyncScopes.markChecked(messageWindowScope(chatId), {
              cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
              applied: false,
            });
            set(() => ({
              activeChatId: chatId,
              messages: activeMessages,
              isLoading: false,
              isLoadingOlder: false,
              isLoadingNewer: false,
              hasMore: canLoadMoreFromWindow(liveWindow, activeMessages, limit),
              hasMoreNewer: canLoadNewerFromWindow(liveWindow, activeMessages, limit),
            }));
            return;
          }
          const fetchedFromChanges = messagesFromWindowChanges(changeProbe?.changes, chatId);
          const fetched = fetchedFromChanges
            || await api.getMessages(chatId, buildMessageFetchOptions({
              limit,
              before: options?.before,
              after: options?.after,
              aroundTimestamp: options?.aroundTimestamp,
            })) as unknown as Message[];
          const normalizedFetched = fetched.map(normalizeFetchedCloudMessage);
          // A non-paginated response smaller than the requested window is a
          // complete cloud tail. Retaining every cached row in that case
          // resurrects messages that were cleared or replaced on another
          // device, because those rows no longer have server IDs to merge
          // against. Keep a pending local create intact until it is uploaded.
          const hasPendingCreateForChat = get().pendingOperations.some((operation) => (
            operation.chatId === chatId && operation.kind === 'create'
          ));
          const shouldReplaceCompleteCloudWindow = !isAppend
            && !isAroundWindow
            && !fetchedFromChanges
            && normalizedFetched.length < limit
            && !hasPendingCreateForChat;
          logMessageWindowDebug('load-fetched', {
            chatId,
            options: options || {},
            fetchStrategy: fetchStrategy.kind,
            fetchStrategyReason: fetchStrategy.reason,
            forcedWindowSnapshot: shouldForceWindowSnapshot,
            probeStatus: changeProbe?.status || null,
            fetchedFromChanges: Boolean(fetchedFromChanges),
            fetchedMessages: normalizedFetched.length,
            replacingCompleteCloudWindow: shouldReplaceCompleteCloudWindow,
            cachedWindowMessagesBeforeSet: get().messageWindowsByChatId[chatId]?.messages?.length || 0,
            activeMessagesBeforeSet: get().messages.filter((message) => message.chatId === chatId).length,
          });
          set((state) => {
            const currentWindow = state.messageWindowsByChatId[chatId];
            const activeMessagesForChat = state.messages.filter((message) => message.chatId === chatId);
            // A response describes the server at request time. A completed
            // upload during the request must not make its new local row stale.
            const liveMessages = mergeMessages(currentWindow?.messages || [], activeMessagesForChat);
            const concurrentMessages = liveMessages.filter((message) => {
              const keys = buildMessageIdentityKeys(message);
              return !keys.some((key) => identitiesBeforeFetch.has(key))
                || keys.some((key) => pendingIdentitiesBeforeFetch.has(key));
            });
            const current = shouldReplaceCompleteCloudWindow ? concurrentMessages : currentWindow?.messages || [];
            const activeCurrent = shouldReplaceCompleteCloudWindow
              ? concurrentMessages
              : activeMessagesForChat.length ? activeMessagesForChat : activeMessageWindow(current, limit);
            const merged = mergeMessages(current, normalizedFetched);
            const trimmed = trimMessagesWithBranchContext(merged);
            const mergedActiveMessages = mergeMessages(activeCurrent, normalizedFetched);
            const nextActiveMessages = isAroundWindow
              ? normalizedFetched
              : isAppend
              ? trimActiveMessagesForDirection(mergedActiveMessages, isAppendNewer ? 'newer' : 'older')
              : activeMessageWindow(trimmed, limit);
            const currentVisibleCount = countUniqueMessages(activeCurrent);
            const nextVisibleCount = countUniqueMessages(nextActiveMessages);
            const addedMessages = nextVisibleCount > currentVisibleCount;
            const isAppendOlder = isAppend && options?.before !== undefined;
            const remoteExhausted = fetchedFromChanges
              ? Boolean(currentWindow?.remoteExhausted)
                : isAroundWindow
                  ? fetched.filter((message) => message.timestamp <= Number(options.aroundTimestamp)).length < Math.ceil(limit / 2)
                  : isAppend
                ? isAppendOlder ? (fetched.length < limit || !addedMessages) : Boolean(currentWindow?.remoteExhausted)
                : fetched.length < limit;
            const remoteNewerExhausted = fetchedFromChanges
              ? currentWindow?.remoteNewerExhausted ?? true
              : isAroundWindow
                ? fetched.filter((message) => message.timestamp > Number(options.aroundTimestamp)).length < Math.max(0, limit - Math.ceil(limit / 2))
                : isAppendNewer
                  ? fetched.length < limit || !addedMessages
                  : true;
            const nextHasMore = isAppend
              ? !remoteExhausted
              : canLoadMoreFromWindow({ ...(currentWindow || { messages: [] as Message[], lastSyncedAt: 0, updatedAt: 0 }), messages: trimmed, remoteExhausted }, nextActiveMessages, limit);
            const nextHasMoreNewer = isAppendNewer && !addedMessages
              ? false
              : canLoadNewerFromWindow({ ...(currentWindow || { messages: [] as Message[], lastSyncedAt: 0, updatedAt: 0 }), messages: trimmed, remoteNewerExhausted }, nextActiveMessages, limit);
            const nextCache = trimCache({
              ...state.messageWindowsByChatId,
              [chatId]: {
                messages: trimmed,
                lastSyncedAt: Date.now(),
                updatedAt: trimmed.at(-1)?.timestamp || currentWindow?.updatedAt || Date.now(),
                remoteExhausted,
                remoteNewerExhausted,
                activeLimit: isAppend
                  ? Math.max(nextVisibleCount, limit)
                  : isAroundWindow || options?.resetWindow
                    ? Math.max(nextVisibleCount, limit)
                    : Math.max(currentWindow?.activeLimit || 0, limit),
              },
            }, state.pendingOperations);
            logMessageWindowDebug('load-merged', {
              chatId,
              options: options || {},
              currentWindowMessages: current.length,
              fetchedMessages: normalizedFetched.length,
              trimmedMessages: trimmed.length,
              nextActiveMessages: nextActiveMessages.length,
              remoteExhausted,
              remoteNewerExhausted,
            });
            if (isAppend) {
              const activeTimestamps = nextActiveMessages.map((message) => Number(message.timestamp || 0)).filter(Boolean);
              const cacheTimestamps = trimmed.map((message) => Number(message.timestamp || 0)).filter(Boolean);
              logDeveloperDiagnostic('message-pagination:store-merge', {
                chatId,
                direction: isAppendNewer ? 'newer' : 'older',
                requestedBefore: options?.before ?? null,
                requestedAfter: options?.after ?? null,
                fetchedMessages: normalizedFetched.length,
                cacheBefore: current.length,
                cacheAfter: trimmed.length,
                activeBefore: activeCurrent.length,
                activeAfter: nextActiveMessages.length,
                activeRange: activeTimestamps.length ? [Math.min(...activeTimestamps), Math.max(...activeTimestamps)] : null,
                cacheRange: cacheTimestamps.length ? [Math.min(...cacheTimestamps), Math.max(...cacheTimestamps)] : null,
                activeLimit: nextCache[chatId]?.activeLimit || null,
                addedMessages,
                hasMoreOlder: nextHasMore,
                hasMoreNewer: nextHasMoreNewer,
                remoteExhausted,
                remoteNewerExhausted,
              }, nextActiveMessages.length <= 2 && trimmed.length > 2 ? 'warn' : 'info', 'message-window');
            }
            if (!isAppend && !options?.before && !options?.after && !isAroundWindow) {
              messageSyncScopes.markChecked(messageWindowScope(chatId), {
                cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                applied: fetched.length > 0,
              });
            }
            return {
              messages: state.activeChatId === chatId ? nextActiveMessages : state.messages,
              activeChatId: chatId,
              messageWindowsByChatId: nextCache,
              isLoading: false,
              isLoadingOlder: false,
              isLoadingNewer: false,
              hasMore: nextHasMore,
              hasMoreNewer: nextHasMoreNewer,
            };
          });
        } catch (error) {
          const cloudMissingResource = isCloudMissingResourceError(error);
          if (cloudMissingResource) ensureLocalChatCreateQueued(chatId);
          if (!isAppend && !options?.before && !options?.after && options?.aroundTimestamp === undefined) {
            if (cloudMissingResource) {
              messageSyncScopes.markChecked(messageWindowScope(chatId), { applied: false, fresh: true });
            } else {
              messageSyncScopes.markError(messageWindowScope(chatId), error);
            }
          }
          if (!cloudMissingResource) {
            reportRecoverableError({
              location: 'cloud-sync:messages-load',
              error,
              userMessage: buildApiErrorUserMessage(error, '消息云同步'),
              extra: { chatId },
            });
          }
          set((state) => ({
            ...(isAppend ? {} : localFetchedMessages(state, chatId)),
            isLoading: false,
            isLoadingOlder: false,
            isLoadingNewer: false,
          }));
        }
      },

      addMessage: async (msgData) => {
        let created: Message | null = null;
        const pendingChatCreate = isChatCreatePendingForMessages(msgData.chatId);
        set((state) => {
          const next = localMessageInsertResult(state, msgData);
          created = next.message;
          const pendingOperations = shouldSkipCloudSync()
            ? state.pendingOperations
            : upsertPendingCreateOperation(state.pendingOperations, next.message);
          return {
            ...next,
            pendingOperations,
          };
        });
        if (created) recordAiMessageStats(created);
        if (!shouldSkipCloudSync()) {
          if (pendingChatCreate) scheduleChatSyncFirst();
          messageSyncScheduler.schedule(flushPendingOperations, pendingChatCreate ? 220 : 120);
        }
        return created as unknown as Message;
      },

      upsertMessage: (message) => {
        set((state) => {
          const currentWindow = state.messageWindowsByChatId[message.chatId];
          const current = currentWindow?.messages || [];
          const nextActiveMessages = trimActiveMessages(mergeMessages(state.messages, [message]));
          const pendingOperations = state.pendingOperations.length > 0 && hasPendingCreateOperation(state.pendingOperations, message)
            ? upsertPendingCreateOperation(state.pendingOperations, message)
            : state.pendingOperations;
          if (message.isStreaming) {
            return {
              messages: state.activeChatId === message.chatId ? nextActiveMessages : state.messages,
              pendingOperations,
            };
          }
          const nextChatMessages = trimMessagesWithBranchContext(mergeMessages(current, [message]));
          logMessageWindowDebug('upsert-one', {
            chatId: message.chatId,
            messageId: message.id,
            currentWindowMessages: current.length,
            nextWindowMessages: nextChatMessages.length,
            activeMessagesBefore: state.messages.filter((item) => item.chatId === message.chatId).length,
            activeMessagesAfter: nextActiveMessages.filter((item) => item.chatId === message.chatId).length,
            incomingTimestamp: message.timestamp,
          });
          return {
            messages: state.activeChatId === message.chatId ? nextActiveMessages : state.messages,
            pendingOperations,
            messageWindowsByChatId: trimCache({
              ...state.messageWindowsByChatId,
              [message.chatId]: {
                messages: nextChatMessages,
                lastSyncedAt: Date.now(),
                updatedAt: message.timestamp,
                remoteExhausted: currentWindow?.remoteExhausted,
                remoteNewerExhausted: currentWindow?.remoteNewerExhausted,
                activeLimit: currentWindow?.activeLimit,
              },
            }, state.pendingOperations),
          };
        });
      },

      upsertMessages: (nextMessages) => {
        if (!nextMessages.length) return;
        set((state) => {
          const messagesByChatId = new Map<string, Message[]>();
          for (const message of nextMessages) {
            messagesByChatId.set(message.chatId, [...(messagesByChatId.get(message.chatId) || []), message]);
          }

          let nextCache = state.messageWindowsByChatId;
          for (const [chatId, chatMessages] of messagesByChatId.entries()) {
            const currentWindow = nextCache[chatId];
            const current = currentWindow?.messages || [];
            const merged = trimMessagesWithBranchContext(mergeMessages(current, chatMessages));
            logMessageWindowDebug('upsert-many-window', {
              chatId,
              incomingMessages: chatMessages.length,
              currentWindowMessages: current.length,
              nextWindowMessages: merged.length,
              firstIncomingTimestamp: chatMessages[0]?.timestamp,
              lastIncomingTimestamp: chatMessages.at(-1)?.timestamp,
            });
            nextCache = {
              ...nextCache,
              [chatId]: {
                messages: merged,
                lastSyncedAt: Date.now(),
                updatedAt: Math.max(...chatMessages.map((message) => message.timestamp), currentWindow?.updatedAt || 0, Date.now()),
                remoteExhausted: currentWindow?.remoteExhausted,
                remoteNewerExhausted: currentWindow?.remoteNewerExhausted,
                activeLimit: currentWindow?.activeLimit,
              },
            };
          }

          const activeMessages = messagesByChatId.get(state.activeChatId || '') || [];
          return {
            messages: activeMessages.length ? trimActiveMessages(mergeMessages(state.messages, activeMessages)) : state.messages,
            messageWindowsByChatId: trimCache(nextCache, state.pendingOperations),
          };
        });
      },

      queueMessageSync: (message) => {
        if (shouldSkipCloudSync()) return;
        const normalized = normalizeMessage({
          ...message,
          clientKey: message.clientKey || message.id,
        });
        set((state) => ({
          ...localUpsertMessage(state, normalized),
          pendingOperations: upsertPendingCreateOperation(state.pendingOperations, normalized),
        }));
        recordAiMessageStats(normalized);
        messageSyncScheduler.schedule(flushPendingOperations, 120);
      },

      flushPendingOperations,

      discardFailedOperation: (operationId) => set((state) => {
        const operation = state.pendingOperations.find((item) => item.id === operationId);
        if (operation?.status !== 'failed') return {};
        return { pendingOperations: removePendingMessageOperation(state.pendingOperations, operationId) };
      }),
      retryFailedOperations: () => set((state) => {
        const pendingOperations = retryFailedOperations(state.pendingOperations);
        if (pendingOperations === state.pendingOperations) return {};
        return { pendingOperations };
      }),

      clearChatMessagesLocal: (chatId) => {
        useFactArchiveStore.getState().clearChat(chatId);
        setClearBarrier(chatId, Date.now());
        set((state) => {
          const nextWindows = { ...state.messageWindowsByChatId };
          const pendingOperations = state.pendingOperations.filter((operation) => operation.chatId !== chatId);
          logMessageWindowDebug('clear-window', {
            chatId,
            currentWindowMessages: state.messageWindowsByChatId[chatId]?.messages?.length || 0,
            activeMessages: state.messages.filter((message) => message.chatId === chatId).length,
          });
          delete nextWindows[chatId];
          return {
            messages: state.activeChatId === chatId ? [] : state.messages,
            messageWindowsByChatId: trimCache(nextWindows, pendingOperations),
            pendingOperations,
            hasMore: state.activeChatId === chatId ? false : state.hasMore,
            hasMoreNewer: state.activeChatId === chatId ? false : state.hasMoreNewer,
          };
        });
      },

      deleteMessage: async (id) => {
        if (shouldSkipCloudSync()) {
          set((state) => localMessageDeletionResult(state, id));
          useFactArchiveStore.getState().invalidate([id]);
          return;
        }
        const targetMessage = get().messages.find((message) => message.id === id)
          || Object.values(get().messageWindowsByChatId).flatMap((window) => window.messages).find((message) => message.id === id);
        // Optimistic messages do not have a server id yet. Deleting them via
        // DELETE /messages/:id produces a misleading "消息不存在" response;
        // mark locally and remove the pending create instead.
        if (!targetMessage?.serverId && targetMessage?.id?.startsWith('local-message-')) {
          set((state) => ({
            ...localMessageDeletionResult(state, id),
            pendingOperations: state.pendingOperations.filter((operation) => operation.localMessageId !== id),
          }));
          useFactArchiveStore.getState().invalidate([id, targetMessage.clientKey || '']);
          return;
        }
        await api.deleteMessage(targetMessage?.serverId || targetMessage?.id || id);
        useFactArchiveStore.getState().invalidate([id, targetMessage?.serverId || '', targetMessage?.clientKey || '']);
        set((state) => {
          const nextWindows = Object.fromEntries(
            Object.entries(state.messageWindowsByChatId).map(([chatId, window]) => {
              const nextMessages = window.messages.map((message) => (message.id === id ? { ...message, isDeleted: true } : message));
              return [chatId, { ...window, messages: nextMessages }];
            })
          );
          return {
            messages: state.messages.map((m) => (m.id === id ? { ...m, isDeleted: true } : m)),
            messageWindowsByChatId: trimCache(nextWindows, state.pendingOperations),
          };
        });
      },

      withdrawMessage: async (id) => {
        const targetMessage = get().messages.find((message) => message.id === id)
          || Object.values(get().messageWindowsByChatId).flatMap((window) => window.messages).find((message) => message.id === id);
        if (!targetMessage) throw new Error('消息不存在');
        const withdrawal = {
          ...(targetMessage.metadata?.withdrawal || {}),
          withdrawn: true,
          withdrawnAt: Date.now(),
        };
        const nextMessage: Message = {
          ...targetMessage,
          metadata: {
            ...(targetMessage.metadata || {}),
            withdrawal,
          },
        };
        set((state) => ({
          messages: state.messages.map((message) => message.id === id ? nextMessage : message),
          messageWindowsByChatId: Object.fromEntries(Object.entries(state.messageWindowsByChatId).map(([chatId, window]) => [
            chatId,
            { ...window, messages: window.messages.map((message) => message.id === id ? nextMessage : message) },
          ])),
        }));
        useFactArchiveStore.getState().invalidate([id, targetMessage.serverId || '', targetMessage.clientKey || '']);
        if (!shouldSkipCloudSync()) {
          await api.updateMessageMetadata(targetMessage.serverId || targetMessage.id, { withdrawal });
        }
      },

      deleteLastNMessages: async (chatId, n) => {
        if (shouldSkipCloudSync()) {
          const ids = get().messages.filter((message) => message.chatId === chatId && !message.isDeleted).slice(-n)
            .flatMap((message) => [message.id, message.serverId || '', message.clientKey || '']);
          set((state) => localMessageDeleteBatchResult(state, chatId, n));
          useFactArchiveStore.getState().invalidate(ids);
          return;
        }
        const msgs = get().messages.filter((m) => m.chatId === chatId && !m.isDeleted).slice(-n);
        for (const msg of msgs) {
          await api.deleteMessage(msg.serverId || msg.id);
        }
        useFactArchiveStore.getState().invalidate(msgs.flatMap((message) => [message.id, message.serverId || '', message.clientKey || '']));
        set((state) => {
          const nextMessages = state.messages.map((m) => (
            msgs.find((dm) => dm.id === m.id) ? { ...m, isDeleted: true } : m
          ));
          const currentWindow = state.messageWindowsByChatId[chatId];
          const nextChatMessages = (currentWindow?.messages || []).map((m) => (
            msgs.find((dm) => dm.id === m.id) ? { ...m, isDeleted: true } : m
          ));
          return {
            messages: nextMessages,
            messageWindowsByChatId: trimCache({
              ...state.messageWindowsByChatId,
              [chatId]: {
                messages: nextChatMessages,
                lastSyncedAt: Date.now(),
                updatedAt: nextChatMessages.at(-1)?.timestamp || currentWindow?.updatedAt || Date.now(),
                remoteExhausted: currentWindow?.remoteExhausted,
                remoteNewerExhausted: currentWindow?.remoteNewerExhausted,
                activeLimit: currentWindow?.activeLimit,
              },
            }, state.pendingOperations),
          };
        });
      },

      clearMessages: () => {
        logMessageWindowDebug('clear-active-messages', {
          activeChatId: get().activeChatId,
          activeMessages: get().messages.length,
          windows: summarizeMessageWindows(get().messageWindowsByChatId, get().activeChatId || undefined),
        });
        set({ messages: [], activeChatId: null, hasMore: true, hasMoreNewer: false, isLoadingNewer: false });
      },

      getRecentMessages: (n) => {
        return get().messages.filter((m) => !m.isDeleted).slice(-n);
      },
      getSyncScopeStates: () => messageSyncScopes.listStates(),
      };
    },
    {
      name: getMessageStoreStorageName(),
      storage: messageStorage,
      version: CLIENT_STORE_SCHEMA_VERSION,
      migrate: (persistedState) => {
        const migrated = migrateMessageStoreState(
          persistedState as PersistedMessageState & { messages?: Array<Record<string, unknown>>; messageWindowsByChatId?: Record<string, { messages?: Array<Record<string, unknown>> }> }
        ) as Partial<PersistedMessageState>;
        const pendingOperations = (migrated.pendingOperations || []).map(compactPendingMessageOperation);
        return {
          messageWindowsByChatId: trimCache(migrated.messageWindowsByChatId || {}, pendingOperations),
          pendingOperations,
        } satisfies PersistedMessageState;
      },
      partialize: (state: MessageStore) => buildPersistedMessageState({
        messageWindowsByChatId: state.messageWindowsByChatId,
        pendingOperations: state.pendingOperations,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<PersistedMessageState>;
        const pendingOperations = (persisted.pendingOperations || []).map(compactPendingMessageOperation);
        const restoredWindows = trimCache(persisted.messageWindowsByChatId || {}, pendingOperations);
        logMessageWindowDebug('persist-merge', {
          restoredWindowCount: Object.keys(restoredWindows).length,
          restoredWindows: summarizeMessageWindows(restoredWindows),
        });
        return {
          ...currentState,
          messageWindowsByChatId: restoredWindows,
          pendingOperations,
        };
      },
      skipHydration: true,
    }
  )
);

export const __messageRuntimePersistenceForTests = {
  buildPersistedMessageState,
  compactPendingMessageOperation,
};
