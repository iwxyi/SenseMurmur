import { api } from './api';
import { assertWorkspaceActive, getWorkspaceSignal } from './workspaceLifecycle';
import { buildApiErrorUserMessage } from './apiErrorMessage';
import { reportRecoverableError } from './diagnostics';
import { normalizeCharacter, type AICharacter } from '../types/character';
import { normalizeConversation, type GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { buildSettingsPayload, useSettingsStore } from '../stores/useSettingsStore';
import { DEFAULT_SETTINGS } from '../types/settings';
import { latestEntityChanges } from './syncChanges';
import {
  BOOTSTRAP_STATUS_CONFLICT_DETAIL_LIMIT,
  readCloudSyncBootstrapStatus,
  writeCloudSyncBootstrapStatus,
  type CloudSyncBootstrapStatus,
} from './cloudSyncBootstrapStatus';

type MessageWindowSnapshot = Record<string, { messages: Message[]; lastSyncedAt?: number; updatedAt?: number }>;

interface BootstrapPendingEntityOperation {
  id: string;
  kind: string;
  entityId: string;
  targetIds?: string[];
  status: 'pending' | 'syncing' | 'failed';
  patch?: Record<string, unknown>;
  clientTimestamp?: number;
}

interface BootstrapPendingMessageOperation {
  id: string;
  kind: string;
  chatId: string;
  localMessageId?: string;
  messageId?: string;
  status: 'pending' | 'syncing' | 'failed';
}

export interface LocalCloudBootstrapSnapshot {
  characters: AICharacter[];
  chats: GroupChat[];
  messageWindowsByChatId: MessageWindowSnapshot;
  settingsShouldUpload: boolean;
  pendingCharacterOperations?: BootstrapPendingEntityOperation[];
  pendingChatOperations?: BootstrapPendingEntityOperation[];
  pendingMessageOperations?: BootstrapPendingMessageOperation[];
}

interface BootstrapRemoteSummary {
  characters: Array<Pick<AICharacter, 'id' | 'name' | 'deletedAt' | 'isPreset'>>;
  chats: Array<Pick<GroupChat, 'id' | 'name' | 'deletedAt'>>;
}

export interface BootstrapReconcilePlan {
  remote: BootstrapRemoteSummary;
  charactersToCreate: AICharacter[];
  charactersAlreadyRemote: AICharacter[];
  characterNameConflicts: Array<{ localId: string; localName: string; remoteId: string; remoteName: string }>;
  chatsToCreate: GroupChat[];
  chatsAlreadyRemote: GroupChat[];
  chatsToPatchRuntime: GroupChat[];
  pendingCharacterCreates: BootstrapPendingEntityOperation[];
  pendingChatCreates: BootstrapPendingEntityOperation[];
  pendingMessageCreates: BootstrapPendingMessageOperation[];
  settingsShouldUpload: boolean;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function ensureLocalStoresHydrated() {
  const rehydrateIfAvailable = (store: { persist?: { hasHydrated?: () => boolean; rehydrate?: () => void | Promise<void> } }) => {
    if (!store.persist?.rehydrate) return Promise.resolve();
    return store.persist.hasHydrated?.() ? Promise.resolve() : Promise.resolve(store.persist.rehydrate());
  };
  await Promise.all([
    rehydrateIfAvailable(useCharacterStore),
    rehydrateIfAvailable(useChatStore),
    rehydrateIfAvailable(useMessageStore),
    rehydrateIfAvailable(useSettingsStore),
  ]);
}

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

export function shouldUploadSettingsDuringBootstrap(settings: ReturnType<typeof useSettingsStore.getState>) {
  return stableJson(buildSettingsPayload(settings)) !== stableJson(buildSettingsPayload(DEFAULT_SETTINGS));
}

export async function captureLocalCloudBootstrapSnapshot(signal = getWorkspaceSignal()): Promise<LocalCloudBootstrapSnapshot> {
  assertWorkspaceActive(signal);
  await ensureLocalStoresHydrated();
  assertWorkspaceActive(signal);
  const characterState = useCharacterStore.getState();
  const chatState = useChatStore.getState();
  const messageState = useMessageStore.getState();
  const settingsState = useSettingsStore.getState();
  return {
    characters: cloneJson(characterState.characters || []),
    chats: cloneJson(chatState.chats || []),
    messageWindowsByChatId: cloneJson(messageState.messageWindowsByChatId || {}),
    settingsShouldUpload: shouldUploadSettingsDuringBootstrap(settingsState),
    pendingCharacterOperations: cloneJson(characterState.getPendingOperations?.() || characterState.pendingOperations || []),
    pendingChatOperations: cloneJson(chatState.getPendingOperations?.() || chatState.pendingOperations || []),
    pendingMessageOperations: cloneJson(messageState.pendingOperations || []),
  };
}

function isLocalId(id: string | null | undefined) {
  return Boolean(id && /^local[-_]/i.test(id));
}

function isUserLikeSender(id: string | null | undefined) {
  return id === 'user' || id === 'system' || id === 'god';
}

function hasBootstrapData(snapshot: LocalCloudBootstrapSnapshot) {
  return snapshot.settingsShouldUpload || hasBootstrapEntityData(snapshot);
}

function pendingDeletions(operations: BootstrapPendingEntityOperation[] = []) {
  const latest = new Map<string, BootstrapPendingEntityOperation>();
  for (const operation of operations) {
    if (operation.patch && Object.prototype.hasOwnProperty.call(operation.patch, 'deletedAt')) {
      latest.set(operation.entityId, operation);
    }
  }
  return [...latest.values()].filter((operation): operation is BootstrapPendingEntityOperation & { patch: Record<string, unknown> & { deletedAt: number } } => (
    typeof operation.patch?.deletedAt === 'number'
  ));
}

export function hasBootstrapEntityData(snapshot: LocalCloudBootstrapSnapshot) {
  if (pendingDeletions(snapshot.pendingCharacterOperations).length || pendingDeletions(snapshot.pendingChatOperations).length) return true;
  const hasCharacters = snapshot.characters.some((character) => !character.isPreset && character.deletedAt == null);
  const hasChats = snapshot.chats.some((chat) => chat.deletedAt == null);
  const hasMessages = Object.values(snapshot.messageWindowsByChatId).some((window) =>
    (window.messages || []).some((message) => !message.isDeleted && message.type !== 'event'),
  );
  const hasPendingCreates = Boolean(
    snapshot.pendingCharacterOperations?.some((operation) => operation.kind === 'create')
    || snapshot.pendingChatOperations?.some((operation) => operation.kind === 'create')
    || snapshot.pendingMessageOperations?.some((operation) => operation.kind === 'create'),
  );
  return hasCharacters || hasChats || hasMessages || hasPendingCreates;
}

function normalizeNameKey(name: string | null | undefined) {
  return (name || '').trim().toLowerCase();
}

function activeRemoteIds<T extends { id: string; deletedAt?: number | null }>(items: T[]) {
  return new Set(items.filter((item) => item.deletedAt == null).map((item) => item.id));
}

function activeRemoteNameMap<T extends { id: string; name: string; deletedAt?: number | null }>(items: T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    if (item.deletedAt != null) continue;
    const key = normalizeNameKey(item.name);
    if (!key || map.has(key)) continue;
    map.set(key, item);
  }
  return map;
}

function hasLocalRuntimeWorldData(chat: GroupChat) {
  const worldState = chat.worldState as unknown;
  return Boolean(
    chat.runtimeEventsV2?.length
    || chat.relationshipLedger?.length
    || chat.runtimeTimeline?.length
    || chat.layeredMemories?.length
    || (worldState && typeof worldState === 'object' && Object.keys(worldState as Record<string, unknown>).length > 0),
  );
}

export function createBootstrapReconcilePlan(
  snapshot: LocalCloudBootstrapSnapshot,
  remote: BootstrapRemoteSummary,
): BootstrapReconcilePlan {
  const remoteCharacterIds = activeRemoteIds(remote.characters);
  const remoteChatIds = activeRemoteIds(remote.chats);
  const remoteCharacterNames = activeRemoteNameMap(remote.characters);
  const deletedCharacterIds = new Set(remote.characters.filter((character) => character.deletedAt != null).map((character) => character.id));
  const deletedChatIds = new Set(remote.chats.filter((chat) => chat.deletedAt != null).map((chat) => chat.id));
  pendingDeletions(snapshot.pendingCharacterOperations).forEach((operation) => deletedCharacterIds.add(operation.entityId));
  pendingDeletions(snapshot.pendingChatOperations).forEach((operation) => deletedChatIds.add(operation.entityId));
  const localCharacters = snapshot.characters.filter((character) => !character.isPreset && character.deletedAt == null && !deletedCharacterIds.has(character.id));
  const localChats = snapshot.chats.filter((chat) => chat.deletedAt == null && !deletedChatIds.has(chat.id));
  const charactersToCreate = localCharacters.filter((character) => !remoteCharacterIds.has(character.id));
  const pendingCharacterCreates = (snapshot.pendingCharacterOperations || []).filter((operation) => operation.kind === 'create');
  const pendingChatCreates = (snapshot.pendingChatOperations || []).filter((operation) => operation.kind === 'create');
  const pendingMessageCreates = (snapshot.pendingMessageOperations || []).filter((operation) => operation.kind === 'create');
  const remoteChatsByName = activeRemoteNameMap(remote.chats);
  const chatsAlreadyRemote = localChats.filter((chat) => {
    if (remoteChatIds.has(chat.id)) return true;
    if (!isLocalId(chat.id)) return false;
    const remoteChat = remoteChatsByName.get(normalizeNameKey(chat.name));
    return Boolean(remoteChat && remoteChat.id !== chat.id);
  });
  const chatsToCreate = localChats.filter((chat) => !chatsAlreadyRemote.some((item) => item.id === chat.id));

  return {
    remote,
    charactersToCreate,
    charactersAlreadyRemote: localCharacters.filter((character) => remoteCharacterIds.has(character.id)),
    characterNameConflicts: charactersToCreate
      .map((character) => {
        const remoteCharacter = remoteCharacterNames.get(normalizeNameKey(character.name));
        return remoteCharacter
          ? {
              localId: character.id,
              localName: character.name,
              remoteId: remoteCharacter.id,
              remoteName: remoteCharacter.name,
            }
          : null;
      })
      .filter((item): item is { localId: string; localName: string; remoteId: string; remoteName: string } => Boolean(item)),
    chatsToCreate,
    chatsAlreadyRemote,
    chatsToPatchRuntime: chatsAlreadyRemote.filter(hasLocalRuntimeWorldData),
    pendingCharacterCreates,
    pendingChatCreates,
    pendingMessageCreates,
    settingsShouldUpload: snapshot.settingsShouldUpload,
  };
}

function buildBootstrapStatus(
  state: CloudSyncBootstrapStatus['state'],
  plan: BootstrapReconcilePlan,
  lastError: string | null = null,
): CloudSyncBootstrapStatus {
  const detailOverflow = Math.max(0, plan.characterNameConflicts.length - BOOTSTRAP_STATUS_CONFLICT_DETAIL_LIMIT);
  return {
    updatedAt: Date.now(),
    state,
    charactersToCreate: plan.charactersToCreate.length,
    charactersAlreadyRemote: plan.charactersAlreadyRemote.length,
    characterNameConflicts: plan.characterNameConflicts.length,
    chatsToCreate: plan.chatsToCreate.length,
    chatsAlreadyRemote: plan.chatsAlreadyRemote.length,
    pendingCharacterCreates: plan.pendingCharacterCreates.length,
    pendingChatCreates: plan.pendingChatCreates.length,
    pendingMessageCreates: plan.pendingMessageCreates.length,
    characterNameConflictDetails: plan.characterNameConflicts.slice(0, BOOTSTRAP_STATUS_CONFLICT_DETAIL_LIMIT),
    characterNameConflictDetailOverflow: detailOverflow,
    lastError,
  };
}

function failedBootstrapStatusFromPrevious(error: unknown): CloudSyncBootstrapStatus {
  const previousStatus = readCloudSyncBootstrapStatus();
  return {
    updatedAt: Date.now(),
    state: 'failed',
    charactersToCreate: Number(previousStatus?.charactersToCreate || 0),
    charactersAlreadyRemote: Number(previousStatus?.charactersAlreadyRemote || 0),
    characterNameConflicts: Number(previousStatus?.characterNameConflicts || 0),
    chatsToCreate: Number(previousStatus?.chatsToCreate || 0),
    chatsAlreadyRemote: Number(previousStatus?.chatsAlreadyRemote || 0),
    pendingCharacterCreates: Number(previousStatus?.pendingCharacterCreates || 0),
    pendingChatCreates: Number(previousStatus?.pendingChatCreates || 0),
    pendingMessageCreates: Number(previousStatus?.pendingMessageCreates || 0),
    characterNameConflictDetails: previousStatus?.characterNameConflictDetails || [],
    characterNameConflictDetailOverflow: Number(previousStatus?.characterNameConflictDetailOverflow || 0),
    lastError: error instanceof Error ? error.message : String(error),
  };
}

function summaryEntriesFromChanges<T>(changes: Array<Record<string, unknown>> | undefined, entity: string, normalize: (value: unknown) => T) {
  const entries: T[] = [];
  for (const change of latestEntityChanges(changes || [])) {
    if (change.entity !== entity || typeof change.patch !== 'object' || !change.patch) continue;
    entries.push(normalize(change.patch));
  }
  return entries;
}

async function fetchRemoteBootstrapSummary(signal: AbortSignal): Promise<BootstrapRemoteSummary> {
  assertWorkspaceActive(signal);
  const [characterChanges, chatChanges] = await Promise.allSettled([
    api.getSyncChanges({ scope: 'characters.summary' }),
    api.getSyncChanges({ scope: 'chats.summary' }),
  ]);
  assertWorkspaceActive(signal);

  const characters = characterChanges.status === 'fulfilled'
    ? summaryEntriesFromChanges(characterChanges.value.changes, 'character_summary', (value) => normalizeCharacter(value as AICharacter))
    : (await Promise.all([api.getCharacters(), api.getDeletedCharacters()])).flat().map((character) => normalizeCharacter(character as unknown as AICharacter));
  assertWorkspaceActive(signal);
  const chats = chatChanges.status === 'fulfilled'
    ? summaryEntriesFromChanges(chatChanges.value.changes, 'chat_summary', (value) => normalizeConversation(value as GroupChat))
    : (await Promise.all([api.getChats(), api.getDeletedChats()])).flat().map((chat) => normalizeConversation(chat as unknown as GroupChat));

  assertWorkspaceActive(signal);
  return { characters, chats };
}

export async function buildBootstrapReconcilePlan(snapshot: LocalCloudBootstrapSnapshot, signal = getWorkspaceSignal()) {
  return createBootstrapReconcilePlan(snapshot, await fetchRemoteBootstrapSummary(signal));
}

function buildUniqueName(baseName: string, usedNames: Set<string>) {
  const normalizedBase = (baseName || '未命名角色').trim() || '未命名角色';
  let candidate = normalizedBase;
  let suffix = 0;
  while (usedNames.has(candidate.trim().toLowerCase())) {
    suffix += 1;
    candidate = suffix === 1 ? `${normalizedBase}（本地）` : `${normalizedBase}（本地 ${suffix}）`;
  }
  usedNames.add(candidate.trim().toLowerCase());
  return candidate;
}

async function uploadSettings() {
  await useSettingsStore.getState().syncCurrentSettingsToServer();
}

function pendingCreateOperationIdByEntity(operations: BootstrapPendingEntityOperation[]) {
  return new Map(operations
    .filter((operation) => operation.kind === 'create' && operation.entityId && operation.id)
    .map((operation) => [operation.entityId, operation.id]));
}

async function uploadCharacters(plan: BootstrapReconcilePlan, signal: AbortSignal) {
  assertWorkspaceActive(signal);
  const usedNames = new Set(
    plan.remote.characters
      .filter((character) => !character.isPreset && character.deletedAt == null)
      .map((character) => character.name.trim().toLowerCase())
      .filter(Boolean),
  );
  const idMap = new Map<string, string>();
  for (const character of plan.charactersAlreadyRemote) {
    idMap.set(character.id, character.id);
  }
  const pendingOperationIds = pendingCreateOperationIdByEntity(plan.pendingCharacterCreates);

  for (const character of plan.charactersToCreate) {
    assertWorkspaceActive(signal);
    const name = buildUniqueName(character.name, usedNames);
    const created = normalizeCharacter(await api.createCharacter({
      id: character.id,
      operationId: pendingOperationIds.get(character.id),
      name,
      avatar: character.avatar,
      personality: character.personality as unknown as Record<string, number>,
      behavior: character.behavior,
      expertise: character.expertise,
      speakingStyle: character.speakingStyle,
      background: character.background,
      group: character.group,
      personalityDrift: character.personalityDrift,
      emotionalState: character.emotionalState,
      soulState: character.soulState,
      coreProfile: character.coreProfile,
      visualIdentity: character.visualIdentity,
      speechProfile: character.speechProfile,
      voiceConfig: character.voiceConfig,
      relationships: character.relationships,
      memory: character.memory,
      layeredMemories: character.layeredMemories,
      intervention: character.intervention,
      runtimeTimeline: character.runtimeTimeline,
      modelProfileId: character.modelProfileId,
      modelProfileIds: character.modelProfileIds,
      bubbleStyle: character.bubbleStyle,
      bubbleStyleId: character.bubbleStyleId,
    } as Parameters<typeof api.createCharacter>[0]) as unknown as AICharacter);
    assertWorkspaceActive(signal);
    idMap.set(character.id, created.id);
  }

  return idMap;
}

function mapCharacterId(id: string, characterIdMap: Map<string, string>) {
  return characterIdMap.get(id) || id;
}

function mapCharacterIds(ids: string[] | undefined, characterIdMap: Map<string, string>) {
  return (ids || []).map((id) => mapCharacterId(id, characterIdMap));
}

function mapJsonReferences<T>(value: T, characterIdMap: Map<string, string>, extraIdMap: Map<string, string> = new Map()): T {
  if (!value && value !== 0) return value;
  const idMap = new Map([...characterIdMap, ...extraIdMap]);
  if (idMap.size === 0) return value;
  try {
    let text = JSON.stringify(value);
    for (const [localId, cloudId] of idMap.entries()) {
      text = text.split(localId).join(cloudId);
    }
    return JSON.parse(text) as T;
  } catch (error) {
    console.warn('[cloud-sync] failed to remap structured local references', { error, value });
    return value;
  }
}

function mergeRecordsById<T extends { id?: unknown; createdAt?: unknown }>(localItems: T[] | undefined, remoteItems: T[] | undefined) {
  if (!localItems?.length) return remoteItems || [];
  if (!remoteItems?.length) return localItems;
  const byId = new Map<string, T>();
  remoteItems.forEach((item, index) => {
    const id = typeof item.id === 'string' && item.id ? item.id : `__remote_index_${index}`;
    byId.set(id, item);
  });
  localItems.forEach((item, index) => {
    const id = typeof item.id === 'string' && item.id ? item.id : `__local_index_${index}`;
    byId.set(id, item);
  });
  return Array.from(byId.values()).sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
}

function mergeRecordsByKey<T extends { pairKey?: unknown; updatedAt?: unknown }>(localItems: T[] | undefined, remoteItems: T[] | undefined) {
  if (!localItems?.length) return remoteItems || [];
  if (!remoteItems?.length) return localItems;
  const byKey = new Map<string, T>();
  remoteItems.forEach((item, index) => {
    const key = typeof item.pairKey === 'string' && item.pairKey ? item.pairKey : `__remote_index_${index}`;
    byKey.set(key, item);
  });
  localItems.forEach((item, index) => {
    const key = typeof item.pairKey === 'string' && item.pairKey ? item.pairKey : `__local_index_${index}`;
    byKey.set(key, item);
  });
  return Array.from(byKey.values()).sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
}

function mergeRuntimeWorldPatch(localChat: GroupChat, remoteChat: GroupChat, characterIdMap: Map<string, string>, chatIdMap: Map<string, string>) {
  return {
    runtimeEventsV2: mapJsonReferences(mergeRecordsById(localChat.runtimeEventsV2, remoteChat.runtimeEventsV2), characterIdMap, chatIdMap),
    relationshipLedger: mapJsonReferences(mergeRecordsByKey(localChat.relationshipLedger, remoteChat.relationshipLedger), characterIdMap, chatIdMap),
    runtimeTimeline: mapJsonReferences(mergeRecordsById(localChat.runtimeTimeline, remoteChat.runtimeTimeline), characterIdMap, chatIdMap),
    layeredMemories: mapJsonReferences(mergeRecordsById(localChat.layeredMemories, remoteChat.layeredMemories), characterIdMap, chatIdMap),
    worldState: {
      ...(remoteChat.worldState || {}),
      ...mapJsonReferences(localChat.worldState || {}, characterIdMap, chatIdMap),
    },
  };
}

function hasRuntimeWorldPatchData(patch: ReturnType<typeof mergeRuntimeWorldPatch>) {
  return Boolean(
    patch.runtimeEventsV2.length
    || patch.relationshipLedger.length
    || patch.runtimeTimeline.length
    || patch.layeredMemories.length
    || Object.keys(patch.worldState || {}).length,
  );
}

async function uploadChats(plan: BootstrapReconcilePlan, characterIdMap: Map<string, string>, signal: AbortSignal) {
  assertWorkspaceActive(signal);
  const chatIdMap = new Map<string, string>();
  const remoteChatsByName = activeRemoteNameMap(plan.remote.chats);
  for (const chat of plan.chatsAlreadyRemote) {
    const remoteId = plan.remote.chats.find((item) => item.deletedAt == null && item.id === chat.id)?.id
      || (isLocalId(chat.id) ? remoteChatsByName.get(normalizeNameKey(chat.name))?.id : null)
      || chat.id;
    chatIdMap.set(chat.id, remoteId);
  }
  const pendingOperationIds = pendingCreateOperationIdByEntity(plan.pendingChatCreates);

  for (const chat of plan.chatsToCreate) {
    assertWorkspaceActive(signal);
    const created = normalizeConversation(await api.createChat({
      id: chat.id,
      operationId: pendingOperationIds.get(chat.id),
      type: chat.type,
      mode: chat.mode,
      modeConfig: mapJsonReferences(chat.modeConfig, characterIdMap),
      modeState: mapJsonReferences(chat.modeState, characterIdMap),
      name: chat.name,
      topic: chat.topic,
      style: chat.style,
      runtimeEvolutionIntensity: chat.runtimeEvolutionIntensity,
      memberIds: mapCharacterIds(chat.memberIds, characterIdMap),
      speed: chat.speed,
      isActive: chat.isActive,
      allowIntervention: chat.allowIntervention,
      showRoleActions: chat.showRoleActions,
      topicSeed: chat.topicSeed,
      sourceChatId: chat.sourceChatId && chatIdMap.has(chat.sourceChatId) ? chatIdMap.get(chat.sourceChatId)! : null,
      sourceMemberIds: mapCharacterIds(chat.sourceMemberIds, characterIdMap),
      runtimeSeed: mapJsonReferences(chat.runtimeSeed, characterIdMap),
      layeredMemories: mapJsonReferences(chat.layeredMemories, characterIdMap),
      runtimeTimeline: mapJsonReferences(chat.runtimeTimeline, characterIdMap),
      runtimeEventsV2: mapJsonReferences(chat.runtimeEventsV2, characterIdMap),
      relationshipLedger: mapJsonReferences(chat.relationshipLedger, characterIdMap),
      governance: mapJsonReferences(chat.governance, characterIdMap),
      dramaRules: mapJsonReferences(chat.dramaRules, characterIdMap),
      worldState: mapJsonReferences(chat.worldState, characterIdMap),
      directorControls: mapJsonReferences(chat.directorControls, characterIdMap),
    } as Parameters<typeof api.createChat>[0]) as unknown as GroupChat);
    assertWorkspaceActive(signal);
    chatIdMap.set(chat.id, created.id);
  }

  for (const chat of plan.chatsToPatchRuntime) {
    assertWorkspaceActive(signal);
    const remoteId = chatIdMap.get(chat.id);
    if (!remoteId) continue;
    const remoteChat = normalizeConversation(await api.getChat(remoteId) as unknown as GroupChat);
    assertWorkspaceActive(signal);
    const patch = mergeRuntimeWorldPatch(chat, remoteChat, characterIdMap, chatIdMap);
    if (!hasRuntimeWorldPatchData(patch)) continue;
    await api.syncChatPatch(remoteId, {
      operationId: `bootstrap-runtime-${chat.id}-${Date.now()}`,
      clientTimestamp: Date.now(),
      patch,
    });
    assertWorkspaceActive(signal);
  }

  return chatIdMap;
}

function confirmBootstrapCreateOperations(plan: BootstrapReconcilePlan, characterIdMap: Map<string, string>, chatIdMap: Map<string, string>) {
  const syncedCharacterIds = plan.pendingCharacterCreates
    .map((operation) => operation.entityId)
    .filter((id) => characterIdMap.has(id));
  const syncedChatIds = plan.pendingChatCreates
    .map((operation) => operation.entityId)
    .filter((id) => chatIdMap.has(id));
  if (syncedCharacterIds.length) {
    useCharacterStore.getState().confirmCreateOperationsSynced?.(syncedCharacterIds);
  }
  if (syncedChatIds.length) {
    useChatStore.getState().confirmCreateOperationsSynced?.(syncedChatIds);
  }
}

function collectMessagesForUpload(snapshot: LocalCloudBootstrapSnapshot, chatIdMap: Map<string, string>, plan: BootstrapReconcilePlan) {
  const messages: Message[] = [];
  const seen = new Set<string>();
  const pendingMessageIds = new Set(
    plan.pendingMessageCreates
      .map((operation) => operation.localMessageId || operation.messageId)
      .filter(Boolean),
  );
  for (const [localChatId, window] of Object.entries(snapshot.messageWindowsByChatId)) {
    if (!chatIdMap.has(localChatId)) continue;
    for (const message of window.messages || []) {
      if (message.isDeleted || message.type === 'event') continue;
      if (pendingMessageIds.has(message.id) || (message.clientKey && pendingMessageIds.has(message.clientKey))) continue;
      const key = `${message.id}:${message.chatId}:${message.timestamp}:${message.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(message);
    }
  }
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

async function uploadMessages(
  snapshot: LocalCloudBootstrapSnapshot,
  chatIdMap: Map<string, string>,
  characterIdMap: Map<string, string>,
  plan: BootstrapReconcilePlan,
  signal: AbortSignal,
) {
  assertWorkspaceActive(signal);
  const messages = collectMessagesForUpload(snapshot, chatIdMap, plan);
  for (const message of messages) {
    assertWorkspaceActive(signal);
    const cloudChatId = chatIdMap.get(message.chatId);
    if (!cloudChatId) continue;
    const senderId = isUserLikeSender(message.senderId) ? message.senderId : mapCharacterId(message.senderId, characterIdMap);
    if (isLocalId(senderId)) {
      console.warn('[cloud-sync] skip local message with unresolved sender', {
        localMessageId: message.id,
        localChatId: message.chatId,
        senderId: message.senderId,
      });
      continue;
    }
    await api.createMessage(cloudChatId, {
      type: message.type,
      senderId,
      senderName: message.senderName,
      content: message.content,
      metadata: mapJsonReferences(message.metadata, characterIdMap),
      emotion: message.emotion,
      timestamp: message.timestamp,
    });
    assertWorkspaceActive(signal);
  }
}

export async function bootstrapLocalDataToCloud(snapshot: LocalCloudBootstrapSnapshot, signal = getWorkspaceSignal()) {
  assertWorkspaceActive(signal);
  if (!hasBootstrapData(snapshot)) return;
  console.info('[cloud-sync] bootstrap local data to cloud started', {
    characters: snapshot.characters.length,
    chats: snapshot.chats.length,
    messageWindows: Object.keys(snapshot.messageWindowsByChatId).length,
  });
  try {
    const plan = hasBootstrapEntityData(snapshot)
      ? await buildBootstrapReconcilePlan(snapshot, signal)
      : createBootstrapReconcilePlan(snapshot, { characters: [], chats: [] });
    assertWorkspaceActive(signal);
    writeCloudSyncBootstrapStatus(buildBootstrapStatus('planned', plan));
    console.info('[cloud-sync] bootstrap reconcile plan prepared', {
      charactersToCreate: plan.charactersToCreate.length,
      charactersAlreadyRemote: plan.charactersAlreadyRemote.length,
      characterNameConflicts: plan.characterNameConflicts.length,
      chatsToCreate: plan.chatsToCreate.length,
      chatsAlreadyRemote: plan.chatsAlreadyRemote.length,
      pendingCharacterCreates: plan.pendingCharacterCreates.length,
      pendingChatCreates: plan.pendingChatCreates.length,
      pendingMessageCreates: plan.pendingMessageCreates.length,
    });
    writeCloudSyncBootstrapStatus(buildBootstrapStatus('running', plan));
    // Apply deletions recorded while sync was disabled before any remote list can reappear.
    for (const kind of ['character', 'chat'] as const) {
      const operations = (kind === 'character' ? snapshot.pendingCharacterOperations : snapshot.pendingChatOperations) || [];
      const remote = kind === 'character' ? plan.remote.characters : plan.remote.chats;
      for (const operation of pendingDeletions(operations)) {
        assertWorkspaceActive(signal);
        if (remote.some((entity) => entity.id === operation.entityId && entity.deletedAt == null)) {
          const data = {
            operationId: operation.id,
            clientTimestamp: operation.clientTimestamp ?? operation.patch.deletedAt,
            patch: kind === 'chat'
              ? { deletedAt: operation.patch.deletedAt, isActive: false }
              : { deletedAt: operation.patch.deletedAt },
          };
          const deleted = kind === 'character'
            ? (await api.syncCharacterPatch(operation.entityId, data)).character
            : (await api.syncChatPatch(operation.entityId, data)).chat;
          assertWorkspaceActive(signal);
          if (deleted.deletedAt == null) throw new Error('云端未接受本地删除，已保留待同步操作，请检查同步冲突。');
        }
        const confirmedIds = operations.filter((item) => item.entityId === operation.entityId).map((item) => item.id);
        if (kind === 'character') useCharacterStore.getState().confirmOperationsSynced(confirmedIds);
        else useChatStore.getState().confirmOperationsSynced(confirmedIds);
      }
    }
    if (plan.settingsShouldUpload) {
      await uploadSettings();
      assertWorkspaceActive(signal);
    }
    const characterIdMap = await uploadCharacters(plan, signal);
    const chatIdMap = await uploadChats(plan, characterIdMap, signal);
    await uploadMessages(snapshot, chatIdMap, characterIdMap, plan, signal);
    assertWorkspaceActive(signal);
    confirmBootstrapCreateOperations(plan, characterIdMap, chatIdMap);
    writeCloudSyncBootstrapStatus(buildBootstrapStatus('succeeded', plan));
    console.info('[cloud-sync] bootstrap local data to cloud finished', {
      charactersUploaded: characterIdMap.size,
      chatsUploaded: chatIdMap.size,
    });
  } catch (error) {
    assertWorkspaceActive(signal);
    writeCloudSyncBootstrapStatus(failedBootstrapStatusFromPrevious(error));
    reportRecoverableError({
      location: 'cloud-sync:bootstrap-local-data',
      error,
      userMessage: buildApiErrorUserMessage(error, '本地数据同步到云端'),
      extra: {
        characters: snapshot.characters.length,
        chats: snapshot.chats.length,
        messageWindows: Object.keys(snapshot.messageWindowsByChatId).length,
      },
    });
    throw error;
  }
}
