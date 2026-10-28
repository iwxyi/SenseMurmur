import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AICharacter, CharacterVisualReferenceImage } from '../types/character';
import { normalizeCharacter, normalizeCharacterGroup } from '../types/character';
import { api, type SyncChangeScope } from '../services/api';
import { buildApiErrorUserMessage } from '../services/apiErrorMessage';
import { reportRecoverableError, reportRecoverableWarning } from '../services/diagnostics';
import { projectEntities, type SyncPatchOperation } from '../services/syncProjector';
import { clearResolvedFieldConflicts, detectPendingFieldConflicts, removePendingConflictField, type FieldConflictRecord } from '../services/syncConflictRecords';
import { buildWarmState } from './storeWarmHelpers';
import { createScopedIndexedDbBufferedJsonStorage, createScopedIndexedDbStorage, flushBufferedPersistenceWrites } from './storePersistenceScope';
import { bindSyncTaskCancellation, cancelSyncTasks, filterCancelledSyncTasks } from '../services/syncTaskCancellation';
import { createSyncScheduler } from './storeSyncScheduler';
import { createSyncScopeMetadata, type SyncScopeSnapshot } from './syncScopeMetadata';
import { CLIENT_STORE_SCHEMA_VERSION, migrateCharacterStoreState } from './storeMigrations';
import { scopedStorageKey, storageKey } from '../constants/brand';
import { getLocalDataUserId } from '../services/authStorageScope';
import { isReservedNonCharacterActorId } from '../services/actorRefPresentation';
import { completeLocalOutboxWorkerOperation, markLocalOutboxWorkerOperation, mirrorLocalOutboxWorkerQueue, removeLocalOutboxWorkerOperation } from '../services/localOutboxWorkerBridge';
import {
  canAttemptOnlineSync,
  classifySyncError,
  createPendingOperation,
  getPendingQueueWorkerPriority,
  isTerminalSyncError,
  latestSyncError,
  recoverInterruptedOperations,
  removePendingOperation,
  retryFailedOperations,
  runPendingOperationQueue,
  shouldSkipCloudSync,
  updatePendingOperation,
} from './storeSyncHelpers';
import { DEFAULT_BASIC_RETENTION_LIMITS, getCurrentRetentionLimits, takeRecentByLimit } from '../services/retentionLimits';

function createLocalCharacterId() {
  return `local-character-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function applyLocalCharacterCreate(charData: Omit<AICharacter, 'id' | 'createdAt' | 'updatedAt' | 'isPreset'>) {
  const now = Date.now();
  return normalizeCharacter({
    ...charData,
    id: createLocalCharacterId(),
    isPreset: false,
    createdAt: now,
    updatedAt: now,
  } as AICharacter);
}

function applyLocalCharacterUpdate(character: AICharacter, updates: Partial<AICharacter>) {
  return normalizeCharacter({
    ...character,
    ...updates,
    updatedAt: Date.now(),
  });
}

/**
 * Visual assets are persisted through their own API, so projecting them here
 * must not enqueue a character patch that could race with that API.
 */
export function projectLocalCharacterVisualAssets(
  character: AICharacter,
  assets: CharacterVisualReferenceImage[],
  primaryReferenceImageId: string | null,
) {
  const seen = new Set<string>();
  const uniqueAssets = assets.filter((asset) => {
    const key = asset.id || asset.assetId || asset.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const primaryId = uniqueAssets.some((asset) => asset.id === primaryReferenceImageId)
    ? primaryReferenceImageId
    : uniqueAssets.find((asset) => asset.isPrimary)?.id || uniqueAssets[0]?.id || null;
  const referenceImages = uniqueAssets.map((asset) => ({
    ...asset,
    assetId: asset.assetId || asset.id,
    isPrimary: asset.id === primaryId,
  }));
  // The asset endpoint owns the remote version. Keeping updatedAt intact also
  // prevents the editor from treating this local projection as an external
  // character edit and resetting unrelated, unsaved form fields.
  return normalizeCharacter({
    ...character,
    visualIdentity: {
      ...(character.visualIdentity || {}),
      referenceImages,
      primaryReferenceImageId: primaryId,
    },
    visualReferenceImages: referenceImages,
  });
}

function applyLocalCharacterDelete(character: AICharacter) {
  return normalizeCharacter({
    ...character,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function applyLocalCharacterRestore(character: AICharacter) {
  return normalizeCharacter({
    ...character,
    deletedAt: null,
    updatedAt: Date.now(),
  });
}

function applyLocalCharacterPurge(characters: AICharacter[], ids: string[]) {
  const normalizedIds = new Set(ids);
  return characters.filter((character) => !normalizedIds.has(character.id));
}

function createConflictCopyCharacterName(character: AICharacter, characters: AICharacter[]) {
  const base = `${character.name || '未命名角色'}（本地副本）`;
  const existing = new Set(characters.map((item) => normalizeCharacterNameKey(item.name)).filter(Boolean));
  if (!existing.has(normalizeCharacterNameKey(base))) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} ${index}`;
    if (!existing.has(normalizeCharacterNameKey(candidate))) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function createConflictCopyCharacterData(character: AICharacter, characters: AICharacter[]): Omit<AICharacter, 'id' | 'createdAt' | 'updatedAt' | 'isPreset'> {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    isPreset: _isPreset,
    deletedAt: _deletedAt,
    fieldVersions: _fieldVersions,
    characterDetailLoaded: _characterDetailLoaded,
    ...data
  } = character;
  return {
    ...data,
    name: createConflictCopyCharacterName(character, characters),
    deletedAt: null,
  };
}

function applyLocalEmptyDeletedCharacters(characters: AICharacter[]) {
  return characters.filter((character) => character.deletedAt == null);
}

type CharacterCreatePayload = Omit<AICharacter, 'id' | 'createdAt' | 'updatedAt' | 'isPreset'> & { id?: string; operationId?: string };

async function createCharacterRemote(charData: CharacterCreatePayload) {
  const result = await api.createCharacter({
    id: charData.id,
    operationId: charData.operationId,
    name: charData.name,
    avatar: charData.avatar,
    personality: charData.personality as unknown as Record<string, number>,
    behavior: charData.behavior,
    expertise: charData.expertise,
    speakingStyle: charData.speakingStyle,
    background: charData.background,
    group: normalizeCharacterGroup(charData.group),
    personalityDrift: charData.personalityDrift,
    emotionalState: charData.emotionalState,
    soulState: charData.soulState,
    coreProfile: charData.coreProfile,
    visualIdentity: charData.visualIdentity,
    speechProfile: charData.speechProfile,
    voiceConfig: charData.voiceConfig,
    relationships: charData.relationships,
    memory: charData.memory,
    layeredMemories: charData.layeredMemories,
    intervention: charData.intervention,
    runtimeTimeline: charData.runtimeTimeline,
    modelProfileId: charData.modelProfileId,
    modelProfileIds: charData.modelProfileIds,
    generationPreferences: charData.generationPreferences,
    bubbleStyle: charData.bubbleStyle,
    bubbleStyleId: charData.bubbleStyleId,
  });
  return normalizeCharacter(result as unknown as AICharacter);
}

function getGuestCharacterStorageKey() {
  return scopedStorageKey('characters-guest');
}

function createCharacterStorageForKey(key: string) {
  return createScopedIndexedDbStorage({
    getScopedKey: () => key,
    storageName: getCharacterStoreStorageName(),
  });
}

async function readGuestCharacters() {
  try {
    const storage = createCharacterStorageForKey(getGuestCharacterStorageKey());
    const raw = await storage.getItem(getCharacterStoreStorageName());
    if (!raw) return [] as AICharacter[];
    const parsed = JSON.parse(raw) as { state?: { characters?: AICharacter[] } } | AICharacter[];
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.state?.characters) ? parsed.state.characters : [];
  } catch {
    return [];
  }
}

async function clearGuestCharacters() {
  const storage = createCharacterStorageForKey(getGuestCharacterStorageKey());
  await storage.removeItem(getCharacterStoreStorageName());
}

async function uploadGuestCharactersToCloud() {
  if (shouldSkipCloudSync()) return;
  const guestCharacters = (await readGuestCharacters()).filter((character) => !character.deletedAt && !character.isPreset);
  if (!guestCharacters.length) return;
  try {
    for (const character of guestCharacters) {
      await createCharacterRemote(character);
    }
    await clearGuestCharacters();
  } catch {
    // ignore malformed guest cache
  }
}

function buildLocalImportedCharacters(chars: AICharacter[]) {
  return chars.map((character) => applyLocalCharacterCreate({
    name: character.name,
    avatar: character.avatar,
    personality: character.personality,
    behavior: character.behavior,
    expertise: character.expertise,
    speakingStyle: character.speakingStyle,
    background: character.background,
    group: character.group,
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
    generationPreferences: character.generationPreferences,
    bubbleStyle: character.bubbleStyle,
    bubbleStyleId: character.bubbleStyleId,
    fieldVersions: character.fieldVersions,
    deletedAt: character.deletedAt,
  }));
}

let artifactHydrationPromise: Promise<void> | null = null;
let artifactSyncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingArtifactSyncCharacters: AICharacter[] | null = null;
const ARTIFACT_SYNC_BACKGROUND_DELAY_MS = 6000;

async function loadCharacterArtifactStore() {
  const { useCharacterArtifactStore } = await import('./useCharacterArtifactStore');
  return useCharacterArtifactStore;
}

async function ensureCharacterArtifactStoreHydrated() {
  const useCharacterArtifactStore = await loadCharacterArtifactStore();
  if (!useCharacterArtifactStore.persist.hasHydrated()) {
    artifactHydrationPromise ??= Promise.resolve(useCharacterArtifactStore.persist.rehydrate()).finally(() => {
      artifactHydrationPromise = null;
    });
    await artifactHydrationPromise;
  }
  return useCharacterArtifactStore;
}

function syncCharacterArtifacts(characters: AICharacter[]) {
  pendingArtifactSyncCharacters = characters;
  if (artifactSyncTimer) clearTimeout(artifactSyncTimer);
  artifactSyncTimer = setTimeout(() => {
    artifactSyncTimer = null;
    const nextCharacters = pendingArtifactSyncCharacters;
    pendingArtifactSyncCharacters = null;
    if (!nextCharacters) return;
    void ensureCharacterArtifactStoreHydrated().then((useCharacterArtifactStore) => {
      useCharacterArtifactStore.getState().syncCharacters(nextCharacters);
    });
  }, ARTIFACT_SYNC_BACKGROUND_DELAY_MS);
}

function enqueueFinalLettersForDeletion(characters: AICharacter[], ids: string[]) {
  const normalizedIds = new Set(ids);
  const deleted = characters.filter((character) => normalizedIds.has(character.id) && !character.isPreset);
  if (!deleted.length) return;
  void ensureCharacterArtifactStoreHydrated().then((useCharacterArtifactStore) => {
    deleted.forEach((character) => {
      useCharacterArtifactStore.getState().enqueueLetterArtifact({
        kind: 'final_letter',
        character,
        relatedCharacters: characters.filter((item) => item.id !== character.id).map((item) => ({ id: item.id, name: item.name })),
        sourceKey: character.deletedAt ? `${character.deletedAt}` : `${Date.now()}`,
      });
    });
  });
}

function enqueueBirthLettersForCreation(createdCharacters: AICharacter[], characters: AICharacter[]) {
  const created = createdCharacters.filter((character) => !character.isPreset && character.deletedAt == null);
  if (!created.length) return;
  void ensureCharacterArtifactStoreHydrated().then((useCharacterArtifactStore) => {
    created.forEach((character) => {
      useCharacterArtifactStore.getState().enqueueLetterArtifact({
        kind: 'birth_letter',
        character,
        relatedCharacters: characters.filter((item) => item.id !== character.id).map((item) => ({ id: item.id, name: item.name })),
        sourceKey: `${character.createdAt || Date.now()}`,
      });
    });
  });
}

function normalizeCharacters(items: AICharacter[]) {
  return items.map((item) => normalizeCharacter(item));
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

function hasCharacterDetailEvidence(character: AICharacter | undefined) {
  return Boolean(character && (
    hasText(character.background)
    || hasText(character.speakingStyle)
    || hasArrayItems(character.relationships)
    || hasArrayItems(character.layeredMemories)
    || hasArrayItems(character.runtimeTimeline)
    || hasRecordDetail(character.memory)
    || hasRecordDetail(character.coreProfile)
    || hasRecordDetail(character.soulState)
    || hasRecordDetail(character.emotionalState)
    || hasRecordDetail(character.behavior)
    || hasRecordDetail(character.intervention)
    || hasRecordDetail(character.voiceConfig)
  ));
}

function isCharacterDetailLoaded(character: AICharacter | undefined) {
  if (!character) return false;
  if (character.characterDetailLoaded === true) return true;
  if (character.characterDetailLoaded === false) return false;
  return hasCharacterDetailEvidence(character);
}

function sortCharacters(characters: AICharacter[]) {
  return [...characters].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function buildCharacterListSignature(characters: AICharacter[]) {
  return characters
    .map((character) => [
      character.id,
      character.updatedAt || 0,
      character.deletedAt || 0,
      character.characterDetailLoaded ? 1 : 0,
      character.bubbleStyle ? 1 : 0,
      character.bubbleStyleId || '',
    ].join(':'))
    .join('|');
}

function normalizeCharacterNameKey(name: string | null | undefined) {
  return (name || '').trim().toLowerCase();
}

function assertUniqueCharacterNames(characters: AICharacter[], names: string[], excludedIds: string[] = []) {
  const excluded = new Set(excludedIds);
  const existing = new Set(
    characters
      .filter((character) => !excluded.has(character.id) && character.deletedAt == null)
      .map((character) => normalizeCharacterNameKey(character.name))
      .filter(Boolean)
  );
  const seen = new Set<string>();
  for (const name of names) {
    const key = normalizeCharacterNameKey(name);
    if (!key) continue;
    if (existing.has(key) || seen.has(key)) {
      throw new Error('DUPLICATE_CHARACTER_NAME');
    }
    seen.add(key);
  }
}

function assertUniqueCharacterNameUpdate(characters: AICharacter[], id: string, updates: Partial<AICharacter>) {
  if (typeof updates.name !== 'string') return;
  const nextName = normalizeCharacterNameKey(updates.name);
  if (!nextName) return;
  assertUniqueCharacterNames(characters, [updates.name], [id]);
}

function assertUniqueCharacterNameBatch(characters: AICharacter[], charsData: Array<Omit<AICharacter, 'id' | 'createdAt' | 'updatedAt' | 'isPreset'>>) {
  assertUniqueCharacterNames(characters, charsData.map((item) => item.name));
}

function mergeCharacterRecord(local: AICharacter | undefined, remote: AICharacter) {
  const remoteHasDetail = isCharacterDetailLoaded(remote);
  const localHasDetail = isCharacterDetailLoaded(local);
  if (!local) {
    return {
      ...remote,
      characterDetailLoaded: remoteHasDetail,
    };
  }
  if (!remoteHasDetail) {
    if (!localHasDetail) {
      return {
        ...remote,
        characterDetailLoaded: false,
      };
    }
    return {
      ...local,
      id: remote.id,
      name: remote.name,
      avatar: remote.avatar,
      personality: remote.personality,
      expertise: remote.expertise,
      group: remote.group,
      bubbleStyleId: remote.bubbleStyleId,
      bubbleStyle: remote.bubbleStyle || local.bubbleStyle,
      isPreset: remote.isPreset,
      deletedAt: remote.deletedAt,
      fieldVersions: remote.fieldVersions,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
      characterDetailLoaded: true,
    };
  }
  if (local.updatedAt >= remote.updatedAt) {
    if (localHasDetail) {
      return {
        ...local,
        fieldVersions: { ...(remote.fieldVersions || {}), ...(local.fieldVersions || {}) },
        characterDetailLoaded: true,
      };
    }
    return {
      ...remote,
      id: local.id,
      name: local.name,
      avatar: local.avatar,
      personality: local.personality,
      expertise: local.expertise,
      group: local.group,
      bubbleStyleId: local.bubbleStyleId,
      bubbleStyle: local.bubbleStyle || remote.bubbleStyle,
      isPreset: local.isPreset,
      deletedAt: local.deletedAt,
      fieldVersions: { ...(remote.fieldVersions || {}), ...(local.fieldVersions || {}) },
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
      characterDetailLoaded: true,
    };
  }
  return {
    ...remote,
    characterDetailLoaded: true,
  };
}

function mergeCharacters(localCharacters: AICharacter[], remoteCharacters: AICharacter[], pendingOperations: PendingCharacterOperation[] = []) {
  const merged = new Map<string, AICharacter>();
  for (const character of normalizeCharacters(localCharacters)) merged.set(character.id, character);
  for (const remote of normalizeCharacters(remoteCharacters)) {
    const local = merged.get(remote.id);
    const fillsMissingBubbleStyle = Boolean(!local?.bubbleStyle && remote.bubbleStyle);
    if (!local || remote.updatedAt > local.updatedAt || (remote.characterDetailLoaded && !local.characterDetailLoaded) || fillsMissingBubbleStyle) {
      merged.set(remote.id, normalizeCharacter(mergeCharacterRecord(local, remote)));
    }
  }
  return sortCharacters(projectEntities(Array.from(merged.values()), pendingOperations));
}

function projectVisibleCharacters(characters: AICharacter[], pendingOperations: PendingCharacterOperation[]) {
  return sortCharacters(projectEntities(characters, pendingOperations).filter((item) => item.deletedAt == null));
}

function mergeVisibleCharacters(localCharacters: AICharacter[], remoteCharacters: AICharacter[], pendingOperations: PendingCharacterOperation[] = []) {
  return mergeCharacters(localCharacters, remoteCharacters, pendingOperations).filter((item) => item.deletedAt == null);
}

function mergeDeletedCharacters(localCharacters: AICharacter[], remoteCharacters: AICharacter[], pendingOperations: PendingCharacterOperation[] = []) {
  return mergeCharacters(localCharacters, remoteCharacters, pendingOperations).filter((item) => item.deletedAt != null);
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

function hasNonDeletePendingCharacterOperation(pendingOperations: PendingCharacterOperation[], characterId: string) {
  return pendingOperations.some((operation) => (
    operation.entityId === characterId
    && operation.patch.deletedAt == null
  ));
}

async function fetchCharacterSnapshot() {
  const result = await api.getCharacters() as unknown as AICharacter[];
  return normalizeCharacters(result.map((item) => ({ ...item, characterDetailLoaded: false })));
}

async function fetchCharacterDetail(id: string) {
  const result = await api.getCharacter(id);
  return normalizeCharacter(result as unknown as AICharacter);
}

async function fetchDeletedCharacterSnapshot() {
  const result = await api.getDeletedCharacters() as unknown as Record<string, unknown>[];
  return result.map((item) => normalizeCharacter(item as unknown as AICharacter));
}

async function fetchAllCharacterSnapshots() {
  const [active, deleted] = await Promise.all([fetchCharacterSnapshot(), fetchDeletedCharacterSnapshot()]);
  return { active, deleted };
}

interface PendingCharacterOperation extends SyncPatchOperation<Record<string, unknown>> {
  kind: 'create' | 'patch';
  targetIds: string[];
}

function pendingCharacterOperationPriority(operation: PendingCharacterOperation) {
  if (operation.kind === 'create') return 100;
  if ('deletedAt' in operation.patch) return 80;
  return 10;
}

interface PersistedCharacterState {
  characters: AICharacter[];
  lastSyncedAt: number;
  pendingOperations: PendingCharacterOperation[];
  fieldConflicts?: FieldConflictRecord[];
}

function compactCharacterRuntimeFieldsForPersistence<T extends Partial<AICharacter>>(character: T): T {
  const limits = getCurrentRetentionLimits();
  return {
    ...character,
    ...(character.layeredMemories !== undefined ? {
      layeredMemories: takeRecentByLimit(character.layeredMemories, limits.characterLayeredMemories.storage),
    } : {}),
    ...(character.runtimeTimeline !== undefined ? {
      runtimeTimeline: takeRecentByLimit(character.runtimeTimeline, limits.characterRuntimeTimeline.storage),
    } : {}),
  };
}

function persistCharacterAvatarForCloud(avatar: string) {
  return /^data:/i.test(avatar) ? '' : avatar;
}

function compactCharacterPatchForCloud(patch: PendingCharacterOperation['patch']) {
  if (!patch || typeof patch !== 'object') return {};
  const nextPatch = compactCharacterRuntimeFieldsForPersistence({ ...patch } as Partial<AICharacter>) as Record<string, unknown>;
  delete nextPatch.updatedAt;
  return nextPatch;
}

function buildPersistedCharacterState(state: PersistedCharacterState): PersistedCharacterState {
  if (shouldSkipCloudSync()) return state;
  return {
    characters: state.characters.map((character) => normalizeCharacter({
      id: character.id,
      name: character.name,
      avatar: persistCharacterAvatarForCloud(character.avatar),
      group: character.group,
      visualIdentity: character.visualIdentity,
      visualReferenceImages: character.visualReferenceImages,
      bubbleStyle: character.bubbleStyle || null,
      bubbleStyleId: character.bubbleStyleId || null,
      modelProfileId: character.modelProfileId || null,
      modelProfileIds: character.modelProfileIds,
      generationPreferences: character.generationPreferences,
      personality: character.personality,
      personalityDrift: character.personalityDrift,
      emotionalState: character.emotionalState,
      soulState: character.soulState,
      coreProfile: character.coreProfile,
      speechProfile: character.speechProfile,
      voiceConfig: character.voiceConfig,
      behavior: character.behavior,
      expertise: character.expertise,
      speakingStyle: character.speakingStyle,
      background: character.background,
      relationships: character.relationships,
      memory: character.memory,
      layeredMemories: takeRecentByLimit(character.layeredMemories, getCurrentRetentionLimits().characterLayeredMemories.storage),
      intervention: character.intervention,
      runtimeTimeline: takeRecentByLimit(character.runtimeTimeline, getCurrentRetentionLimits().characterRuntimeTimeline.storage),
      characterDetailLoaded: isCharacterDetailLoaded(character),
      isPreset: character.isPreset,
      deletedAt: character.deletedAt ?? null,
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
    } as AICharacter)),
    lastSyncedAt: state.lastSyncedAt,
    pendingOperations: recoverInterruptedOperations(state.pendingOperations)
      .map((operation) => ({
        ...operation,
        patch: compactCharacterPatchForCloud(operation.patch),
      }))
      .filter((operation) => Object.keys(operation.patch || {}).length > 0),
    fieldConflicts: state.fieldConflicts || [],
  };
}

interface CharacterStore extends PersistedCharacterState {
  isLoading: boolean;
  pendingEditSyncCount: number;
  pendingEditSyncError: string | null;
  remoteDeletedCharacterIds: string[];
  fieldConflicts: FieldConflictRecord[];
  loadCharacters: () => Promise<void>;
  loadCharacter: (id: string) => Promise<AICharacter | null>;
  prefetchCharacters: () => Promise<void>;
  refreshCharacterSummaryFromCloud: () => Promise<void>;
  flushPendingOperations: () => Promise<void>;
  queuePatch: (entityId: string, patch: Record<string, unknown>, kind?: PendingCharacterOperation['kind']) => void;
  loadProjectedDeletedCharacters: () => Promise<AICharacter[]>;
  loadProjectedCharacters: () => Promise<AICharacter[]>;
  loadProjectedState: () => Promise<void>;
  getPendingOperations: () => PendingCharacterOperation[];
  getPendingEditError: () => string | null;
  getPendingEditCount: () => number;
  clearPendingOperations: () => void;
  confirmCreateOperationsSynced: (entityIds: string[]) => void;
  discardFailedOperation: (operationId: string) => void;
  clearSyncTasks: (operationIds: string[]) => void;
  resolveRemoteDeleteConflict: (id: string, resolution: 'restore_local' | 'discard_local' | 'save_as_new') => Promise<void>;
  resolveFieldConflict: (id: string, field: string, resolution: 'keep_local' | 'use_remote') => Promise<void>;
  retryFailedOperations: () => void;
  loadPendingSnapshot: () => Promise<AICharacter[]>;
  loadProjectedRecycleBin: () => Promise<AICharacter[]>;
  hydrateProjectedState: () => void;
  resumeSync: () => void;
  syncPatch: (entityId: string, patch: Record<string, unknown>, kind?: PendingCharacterOperation['kind']) => Promise<void>;
  loadProjectedVisibleCharacters: () => Promise<AICharacter[]>;
  addCharacter: (char: Omit<AICharacter, 'id' | 'createdAt' | 'updatedAt' | 'isPreset'>) => Promise<AICharacter>;
  addCharacters: (chars: Array<Omit<AICharacter, 'id' | 'createdAt' | 'updatedAt' | 'isPreset'>>) => Promise<AICharacter[]>;
  updateCharacter: (id: string, updates: Partial<AICharacter>) => Promise<void>;
  applyLocalCharacterVisualAssets: (id: string, assets: CharacterVisualReferenceImage[], primaryReferenceImageId: string | null) => void;
  updateCharacters: (patches: Array<{ id: string; updates: Partial<AICharacter> }>) => Promise<void>;
  deleteCharacter: (id: string) => Promise<void>;
  deleteCharacters: (ids: string[]) => Promise<void>;
  restoreCharacters: (ids: string[]) => Promise<void>;
  purgeCharacters: (ids: string[]) => Promise<void>;
  emptyDeletedCharacters: () => Promise<void>;
  loadDeletedCharacters: () => Promise<AICharacter[]>;
  updateCharactersGroup: (ids: string[], group: string | null) => Promise<void>;
  getCharacter: (id: string) => AICharacter | undefined;
  hasCharacterLoaded: (id: string) => boolean;
  getCharactersLoadedAt: () => number;
  getSyncScopeStates: () => SyncScopeSnapshot[];
  markCharactersWarm: () => void;
  hydrateCharacterSummaries: (characters: Array<Partial<AICharacter> & Pick<AICharacter, 'id' | 'name' | 'avatar' | 'personality' | 'expertise' | 'speakingStyle' | 'background' | 'isPreset' | 'createdAt' | 'updatedAt'>>) => void;
  getPresets: () => AICharacter[];
  getCustom: () => AICharacter[];
  importCharacters: (chars: AICharacter[]) => Promise<void>;
  initializePresets: () => Promise<void>;
}

function getUserId() {
  return getLocalDataUserId();
}

function getCharacterStorageKey() {
  return scopedStorageKey(`characters-${getUserId()}`);
}

function getCharacterStoreStorageName() {
  return scopedStorageKey('characters');
}

const latestCharacterError = latestSyncError;
const createPendingCharacterOperation = createPendingOperation<Record<string, unknown>, PendingCharacterOperation>;
const removePendingCharacterOperation = removePendingOperation;
const updatePendingCharacterOperation = updatePendingOperation;
const canAttemptSync = canAttemptOnlineSync;
const CHARACTER_SYNC_DELAYS = [1000, 3000, 10000, 30000];
const CHARACTER_REFRESH_TTL_MS = 30_000;
const CHARACTER_DETAIL_REFRESH_TTL_MS = 120_000;
const CHARACTER_SUMMARY_SCOPE: SyncChangeScope = 'characters.summary';
const characterDetailScope = (id: string): SyncChangeScope => `characters.detail:${id}`;
const characterSyncScheduler = createSyncScheduler('character.pending-operations', {
  priority: () => getPendingQueueWorkerPriority(useCharacterStore.getState().pendingOperations, 70, pendingCharacterOperationPriority),
});
const characterScopeSyncScheduler = createSyncScheduler('character.scope-refresh', { priority: 25 });
const characterSyncScopes = createSyncScopeMetadata(CHARACTER_REFRESH_TTL_MS, {
  getStorageKey: () => scopedStorageKey(`character-sync-scopes-${getLocalDataUserId()}`),
});
let characterSummaryScopeRequested = false;

function scheduleCharacterFlush(flush: () => Promise<void>, delay = 0) {
  characterSyncScheduler.schedule(flush, delay);
}

function scheduleCharacterScopeRefresh(flush: () => Promise<void>, delay = 0) {
  characterSummaryScopeRequested = true;
  characterScopeSyncScheduler.schedule(flush, delay);
}

function mergeCharacterPatchOperations(operations: PendingCharacterOperation[]) {
  const merged = new Map<string, PendingCharacterOperation>();
  for (const operation of operations) {
    const cloudPatch = compactCharacterPatchForCloud(operation.patch);
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
    const terminalFailure = existing.status === 'failed' && isTerminalSyncError(existing.lastError || '');
    merged.set(operation.entityId, {
      ...existing,
      id: terminalFailure ? existing.id : compactedOperation.id,
      patch: {
        ...(existing.patch || {}),
        ...(compactedOperation.patch || {}),
      },
      clientTimestamp: compactedOperation.clientTimestamp,
      status: terminalFailure ? 'failed' : existing.status === 'syncing' ? 'syncing' : compactedOperation.status,
      attemptCount: Math.max(existing.attemptCount || 0, compactedOperation.attemptCount || 0),
      lastError: compactedOperation.lastError || existing.lastError,
      targetIds: compactedOperation.targetIds?.length ? compactedOperation.targetIds : existing.targetIds,
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.clientTimestamp - right.clientTimestamp);
}

function visibleCharactersFromState(state: CharacterStore) {
  return projectVisibleCharacters(state.characters, state.pendingOperations);
}

function markCharactersLoadingIdle(state: CharacterStore) {
  if (!state.isLoading) return state;
  return { isLoading: false };
}

function buildProjectedCharacterStoreState(state: CharacterStore, isLoading: boolean) {
  const visibleCharacters = visibleCharactersFromState(state);
  const pendingEditSyncCount = state.pendingOperations.length;
  const pendingEditSyncError = latestCharacterError(state.pendingOperations);
  if (
    state.isLoading === isLoading
    && state.pendingEditSyncCount === pendingEditSyncCount
    && state.pendingEditSyncError === pendingEditSyncError
    && buildCharacterListSignature(visibleCharacters) === buildCharacterListSignature(state.characters)
  ) {
    return state;
  }
  return {
    ...buildWarmState({
      items: state.characters,
      projectVisible: () => visibleCharactersFromState(state),
      pendingEditSyncCount,
      pendingEditSyncError,
      isLoading,
    }),
    characters: visibleCharacters,
  };
}

function buildWarmCharacterStoreState(state: CharacterStore) {
  return buildProjectedCharacterStoreState(state, state.characters.length === 0);
}

function buildMarkedWarmCharacterStoreState(state: CharacterStore) {
  return buildProjectedCharacterStoreState(state, state.isLoading);
}

function queueAndProjectCharacters(state: CharacterStore, operations: PendingCharacterOperation[]) {
  const pendingOperations = mergeCharacterPatchOperations([...state.pendingOperations, ...operations]);
  return {
    pendingOperations,
    characters: projectVisibleCharacters(state.characters, pendingOperations),
    pendingEditSyncCount: pendingOperations.length,
    pendingEditSyncError: latestCharacterError(pendingOperations),
  };
}

function createCharacterLocally(state: CharacterStore, charData: Omit<AICharacter, 'id' | 'createdAt' | 'updatedAt' | 'isPreset'>) {
  const character = applyLocalCharacterCreate(charData);
  return {
    character,
    characters: sortCharacters([...state.characters.filter((item) => item.id !== character.id), character]),
  };
}

function deleteCharactersLocally(state: CharacterStore, ids: string[]) {
  const normalizedIds = new Set(ids);
  return sortCharacters(state.characters.map((character) => normalizedIds.has(character.id) ? applyLocalCharacterDelete(character) : character).filter((character) => character.deletedAt == null));
}

function restoreCharactersLocally(state: CharacterStore, ids: string[]) {
  const normalizedIds = new Set(ids);
  return sortCharacters(state.characters.map((character) => normalizedIds.has(character.id) ? applyLocalCharacterRestore(character) : character).filter((character) => character.deletedAt == null));
}

function updateCharacterLocally(state: CharacterStore, id: string, updates: Partial<AICharacter>) {
  return sortCharacters(state.characters.map((character) => character.id === id ? applyLocalCharacterUpdate(character, updates) : character));
}

function importCharactersBatchLocally(state: CharacterStore, chars: AICharacter[]) {
  return sortCharacters(mergeCharacters(state.characters, buildLocalImportedCharacters(chars), []));
}

async function executeCharacterOperation(operation: PendingCharacterOperation) {
  if (operation.kind === 'create') {
    return createCharacterRemote({
      ...(operation.patch as CharacterCreatePayload),
      id: operation.entityId,
      operationId: operation.id,
    });
  }
  const character = useCharacterStore.getState().characters.find((item) => item.id === operation.entityId);
  if (character?.isPreset) {
    return { success: true, character: null };
  }
  return api.syncCharacterPatch(operation.entityId, {
    operationId: operation.id,
    clientTimestamp: operation.clientTimestamp,
    patch: operation.patch,
  });
}

async function applyCharacterPurge(ids: string[]) {
  const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
  if (!normalizedIds.length) return;
  if (normalizedIds.length === 1) return api.purgeCharacter(normalizedIds[0]);
  await api.bulkPurgeCharacters(normalizedIds);
}

async function applyEmptyDeletedCharacters() {
  await api.emptyDeletedCharacters();
}

async function reloadProjectedCharacterState(pendingOperations: PendingCharacterOperation[]) {
  const { active, deleted } = await fetchAllCharacterSnapshots();
  return {
    visible: mergeVisibleCharacters([], active, pendingOperations),
    deleted: mergeDeletedCharacters([], [...active, ...deleted], pendingOperations),
  };
}

async function reloadVisibleCharacterState(pendingOperations: PendingCharacterOperation[]) {
  const active = await fetchCharacterSnapshot();
  return mergeVisibleCharacters([], active, pendingOperations);
}

async function probeCharacterSummaryChanges(options: { forceFull?: boolean } = {}) {
  const scopeState = characterSyncScopes.getState(CHARACTER_SUMMARY_SCOPE);
  const since = options.forceFull ? null : scopeState.cursor ?? scopeState.revision ?? null;
  try {
    return await api.getSyncChanges({ scope: CHARACTER_SUMMARY_SCOPE, since });
  } catch {
    return null;
  }
}

function characterSummariesFromChanges(changes: Array<Record<string, unknown>> | undefined) {
  const items: AICharacter[] = [];
  for (const change of changes || []) {
    if (change.entity !== 'character_summary' || typeof change.patch !== 'object' || !change.patch) continue;
    items.push(normalizeCharacter({
      ...(change.patch as unknown as AICharacter),
      characterDetailLoaded: false,
    }));
  }
  return items;
}

function characterDetailFromChanges(changes: Array<Record<string, unknown>> | undefined, id: string) {
  if (!changes?.length) return null;
  const change = changes.find((item) => item.entity === 'character_detail' && item.id === id);
  if (!change) return null;
  const patch = (change.patch && typeof change.patch === 'object' && !Array.isArray(change.patch))
    ? change.patch as Record<string, unknown>
    : {};
  if (change.op === 'delete') {
    return normalizeCharacter({
      ...patch,
      id,
      deletedAt: typeof patch.deletedAt === 'number' ? patch.deletedAt : Date.now(),
      characterDetailLoaded: true,
    } as unknown as AICharacter);
  }
  if (!Object.keys(patch).length) return null;
  return normalizeCharacter({
    ...patch,
    id,
    characterDetailLoaded: true,
  } as unknown as AICharacter);
}

async function probeCharacterDetailChanges(scope: SyncChangeScope) {
  const scopeState = characterSyncScopes.getState(scope);
  const since = scopeState.cursor ?? scopeState.revision ?? null;
  try {
    return await api.getSyncChanges({ scope, since });
  } catch {
    return null;
  }
}

export function clearPersistedCharacterStore() {
  void useCharacterStore.persist.clearStorage();
  localStorage.removeItem(getCharacterStorageKey());
  localStorage.removeItem(getCharacterStoreStorageName());
  characterSyncScopes.clear();
}

export async function resetCharacterStoreForAccountBoundary() {
  const storage = createCharacterStorageForKey(getCharacterStorageKey());
  const storageName = getCharacterStoreStorageName();
  const preservedSnapshot = await storage.getItem(storageName);
  characterSyncScopes.clear();
  useCharacterStore.setState({
    characters: [],
    lastSyncedAt: 0,
    pendingOperations: [],
    pendingEditSyncCount: 0,
    pendingEditSyncError: null,
    remoteDeletedCharacterIds: [],
    fieldConflicts: [],
    isLoading: false,
  });
  flushBufferedPersistenceWrites();
  if (preservedSnapshot != null) {
    await storage.setItem(storageName, preservedSnapshot);
  } else {
    await storage.removeItem(storageName);
  }
}

const characterStorage = createScopedIndexedDbBufferedJsonStorage<PersistedCharacterState>({
  getScopedKey: getCharacterStorageKey,
  storageName: getCharacterStoreStorageName(),
  syncTaskField: 'pendingOperations',
  flushDelayMs: 96,
});

let characterSyncLifecycleRegistered = false;
let characterHydrationPromise: Promise<void> | null = null;

function ensureCharacterStoreHydrated() {
  if (useCharacterStore.persist.hasHydrated()) return Promise.resolve();
  characterHydrationPromise ??= Promise.resolve(useCharacterStore.persist.rehydrate()).finally(() => {
    characterHydrationPromise = null;
  });
  return characterHydrationPromise;
}

export const useCharacterStore = create<CharacterStore>()(
  persist(
    (set, get) => {
      const flushPendingOperations = async () => {
        await mirrorLocalOutboxWorkerQueue('character', get().pendingOperations);
        await runPendingOperationQueue<PendingCharacterOperation>({
          getOperations: () => filterCancelledSyncTasks(getCharacterStorageKey(), get().pendingOperations),
          canRun: canAttemptSync,
          retryDelays: CHARACTER_SYNC_DELAYS,
          isTerminalError: isTerminalSyncError,
          priority: pendingCharacterOperationPriority,
          batchSize: 3,
          updateOperation: (operationId, operation) => {
            set((current) => ({
              pendingOperations: updatePendingCharacterOperation(current.pendingOperations, operationId, operation),
            }));
            markLocalOutboxWorkerOperation(operation);
          },
          execute: executeCharacterOperation,
          onSuccess: (operation) => {
            const nextQueue = removePendingCharacterOperation(get().pendingOperations, operation.id);
            set((current) => ({
              characters: projectVisibleCharacters(current.characters, nextQueue),
              pendingOperations: nextQueue,
              fieldConflicts: clearResolvedFieldConflicts(current.fieldConflicts, { entityType: 'character', operationIds: [operation.id] }),
              pendingEditSyncCount: nextQueue.length,
              pendingEditSyncError: latestCharacterError(nextQueue),
              lastSyncedAt: Date.now(),
            }));
            void completeLocalOutboxWorkerOperation('character', operation);
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
          scheduleNext: (delay) => scheduleCharacterFlush(flushPendingOperations, delay),
        });
      };

      if (!characterSyncLifecycleRegistered) {
        characterSyncScheduler.registerLifecycle(flushPendingOperations, 300);
        characterScopeSyncScheduler.registerLifecycle(async () => {
          if (characterSummaryScopeRequested) await get().loadCharacters();
        }, 625);
        characterSyncLifecycleRegistered = true;
      }

      return {
        characters: [],
        lastSyncedAt: 0,
        pendingOperations: [],
        pendingEditSyncCount: 0,
        pendingEditSyncError: null,
        remoteDeletedCharacterIds: [],
        fieldConflicts: [],
        isLoading: false,

        loadCharacters: async () => {
          await ensureCharacterStoreHydrated();
          set(buildWarmCharacterStoreState);
          if (shouldSkipCloudSync()) {
            set(markCharactersLoadingIdle);
            return;
          }
          if (get().characters.length > 0 && characterSyncScopes.isFresh(CHARACTER_SUMMARY_SCOPE)) {
            set(markCharactersLoadingIdle);
            return;
          }
          return characterSyncScopes.run(CHARACTER_SUMMARY_SCOPE, async () => {
            try {
              await uploadGuestCharactersToCloud();
              const changeProbe = await probeCharacterSummaryChanges({ forceFull: get().characters.length === 0 });
              if (changeProbe?.status === 'not_modified') {
                characterSyncScopes.markChecked(CHARACTER_SUMMARY_SCOPE, {
                  cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: false,
                });
                set(markCharactersLoadingIdle);
                return;
              }
              const changedSummaries = characterSummariesFromChanges(changeProbe?.changes);
              if (changeProbe?.status === 'modified' && changedSummaries.length) {
                set((state) => {
                  const deleteConflicts = changedSummaries.filter((character) => (
                    character.deletedAt != null
                    && !character.isPreset
                    && hasNonDeletePendingCharacterOperation(state.pendingOperations, character.id)
                  ));
                  const applicableSummaries = changedSummaries.filter((character) => (
                    character.deletedAt == null
                    || character.isPreset
                    || !hasNonDeletePendingCharacterOperation(state.pendingOperations, character.id)
                  ));
                  const fieldConflicts = detectPendingFieldConflicts({
                    entityType: 'character',
                    localEntities: state.characters,
                    remoteEntities: applicableSummaries,
                    pendingOperations: state.pendingOperations,
                    existingConflicts: state.fieldConflicts,
                  });
                  const nextCharacters = mergeCharacters(state.characters, applicableSummaries, state.pendingOperations);
                  const nextVisible = nextCharacters.filter((item) => item.deletedAt == null);
                  const changed = buildCharacterListSignature(nextVisible) !== buildCharacterListSignature(state.characters);
                  characterSyncScopes.markChecked(CHARACTER_SUMMARY_SCOPE, {
                    cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                    applied: changed || deleteConflicts.length > 0,
                  });
                  const deleteConflictIds = new Set(deleteConflicts.map((character) => character.id));
                  return {
                    ...(changed ? { characters: nextVisible } : {}),
                    remoteDeletedCharacterIds: Array.from(new Set([
                      ...state.remoteDeletedCharacterIds,
                      ...changedSummaries.filter((character) => character.deletedAt != null && !character.isPreset).map((character) => character.id),
                    ])).filter((id) => deleteConflictIds.has(id) || !nextVisible.some((character) => character.id === id)),
                    fieldConflicts,
                    isLoading: false,
                    lastSyncedAt: Date.now(),
                    pendingEditSyncCount: get().pendingOperations.length,
                    pendingEditSyncError: latestCharacterError(get().pendingOperations),
                  };
                });
                return;
              }
              const visible = await reloadVisibleCharacterState(get().pendingOperations);
              set((state) => ({
                ...(() => {
                  const nextCharacters = mergeVisibleCharacters(state.characters, visible, state.pendingOperations);
                  const changed = buildCharacterListSignature(nextCharacters) !== buildCharacterListSignature(state.characters);
                  characterSyncScopes.markChecked(CHARACTER_SUMMARY_SCOPE, {
                    cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                    applied: changed,
                  });
                  return changed ? { characters: nextCharacters } : {};
                })(),
                remoteDeletedCharacterIds: state.remoteDeletedCharacterIds.filter((id) => !visible.some((character) => character.id === id)),
                isLoading: false,
                lastSyncedAt: Date.now(),
                pendingEditSyncCount: get().pendingOperations.length,
                pendingEditSyncError: latestCharacterError(get().pendingOperations),
              }));
            } catch (error) {
              characterSyncScopes.markError(CHARACTER_SUMMARY_SCOPE, error);
              reportRecoverableError({
                location: 'cloud-sync:characters-load',
                error,
                userMessage: buildApiErrorUserMessage(error, '角色云同步'),
              });
              set({ isLoading: false, pendingEditSyncError: classifySyncError(error) });
            }
          }, { markCheckedOnSuccess: false });
        },

        loadCharacter: async (id): Promise<AICharacter | null> => {
          if (!id || isReservedNonCharacterActorId(id)) return null;
          await ensureCharacterStoreHydrated();
          const cached = get().characters.find((character) => character.id === id);
          if (cached?.isPreset) return cached;
          if (shouldSkipCloudSync()) return cached || null;
          const scope = characterDetailScope(id);
          const refreshCharacterDetail = () => characterSyncScopes.run<AICharacter | null>(scope, async (): Promise<AICharacter | null> => {
            try {
              const changeProbe = isCharacterDetailLoaded(cached) ? await probeCharacterDetailChanges(scope) : null;
              if (changeProbe?.status === 'not_modified') {
                characterSyncScopes.markChecked(scope, {
                  cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: false,
                });
                return cached || null;
              }
              const detail = characterDetailFromChanges(changeProbe?.changes, id) || await fetchCharacterDetail(id);
              if (detail.deletedAt != null) {
                const hasPendingConflict = hasNonDeletePendingCharacterOperation(get().pendingOperations, id);
                characterSyncScopes.markChecked(scope, {
                  cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: true,
                });
                set((state) => ({
                  characters: hasPendingConflict ? projectVisibleCharacters(state.characters, state.pendingOperations) : state.characters.filter((character) => character.id !== id),
                  remoteDeletedCharacterIds: Array.from(new Set([...state.remoteDeletedCharacterIds, id])),
                  lastSyncedAt: state.lastSyncedAt || Date.now(),
                  pendingEditSyncCount: state.pendingOperations.length,
                  pendingEditSyncError: latestCharacterError(state.pendingOperations),
                }));
                return cached || detail;
              }
              set((state) => {
                const fieldConflicts = detectPendingFieldConflicts({
                  entityType: 'character',
                  localEntities: state.characters,
                  remoteEntities: [detail],
                  pendingOperations: state.pendingOperations,
                  existingConflicts: state.fieldConflicts,
                });
                const nextCharacters = mergeVisibleCharacters(state.characters, [detail], state.pendingOperations);
                const changed = buildCharacterListSignature(nextCharacters) !== buildCharacterListSignature(state.characters);
                characterSyncScopes.markChecked(scope, {
                  cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
                  applied: changed,
                });
                return {
                  ...(changed ? { characters: nextCharacters } : {}),
                  remoteDeletedCharacterIds: state.remoteDeletedCharacterIds.filter((characterId) => characterId !== id),
                  fieldConflicts,
                  lastSyncedAt: state.lastSyncedAt || Date.now(),
                  pendingEditSyncCount: state.pendingOperations.length,
                  pendingEditSyncError: latestCharacterError(state.pendingOperations),
                };
              });
              return get().characters.find((character) => character.id === id) || detail;
            } catch (error) {
              const fallback = get().characters.find((character) => character.id === id) || null;
              if (getErrorStatus(error) === 404 && fallback) {
                characterSyncScopes.markChecked(scope, { applied: false });
                if (hasCharacterDetailEvidence(fallback) && fallback.characterDetailLoaded !== true) {
                  set((state) => ({
                    characters: state.characters.map((character) => (
                      character.id === id ? { ...character, characterDetailLoaded: true } : character
                    )),
                  }));
                  return { ...fallback, characterDetailLoaded: true };
                }
                return fallback;
              }
              characterSyncScopes.markError(scope, error);
              const diagnostics = {
                characterId: id,
                status: getErrorStatus(error),
                code: getErrorCode(error),
                hasLocalFallback: Boolean(fallback),
                cachedDetailLoaded: Boolean(fallback?.characterDetailLoaded),
                pendingOperationCount: get().pendingOperations.filter((operation) => operation.entityId === id).length,
              };
              if (fallback) {
                reportRecoverableWarning({
                  location: 'cloud-sync:character-detail-load',
                  error,
                  message: '角色云端详情暂时不可用，已继续使用本地角色数据。',
                  extra: diagnostics,
                });
                return fallback;
              }
              reportRecoverableError({
                location: 'cloud-sync:character-detail-load',
                error,
                userMessage: buildApiErrorUserMessage(error, '角色详情同步'),
                extra: diagnostics,
              });
              return null;
            }
          }, { markCheckedOnSuccess: false });
          if (isCharacterDetailLoaded(cached)) {
            if (!characterSyncScopes.isFresh(scope, CHARACTER_DETAIL_REFRESH_TTL_MS)) {
              void refreshCharacterDetail();
            }
            return cached ?? null;
          }
          const loaded = await refreshCharacterDetail();
          return loaded ?? null;
        },

        prefetchCharacters: async () => {
          if (shouldSkipCloudSync()) {
            await get().loadCharacters();
            return;
          }
          const state = get();
          if (state.characters.length > 0 && characterSyncScopes.isFresh(CHARACTER_SUMMARY_SCOPE)) return;
          scheduleCharacterScopeRefresh(async () => { await get().loadCharacters(); });
        },

        refreshCharacterSummaryFromCloud: async () => {
          characterSyncScopes.clear(CHARACTER_SUMMARY_SCOPE);
          await get().loadCharacters();
        },

        flushPendingOperations,

        queuePatch: (entityId, patch, kind = 'patch') => {
          const character = get().characters.find((item) => item.id === entityId);
          if (character?.isPreset) {
            set((state) => {
              const characters = updateCharacterLocally(state, entityId, patch as Partial<AICharacter>);
              syncCharacterArtifacts(characters);
              return { characters };
            });
            return;
          }
          const cloudPatch = compactCharacterPatchForCloud(patch);
          const operation = Object.keys(cloudPatch).length > 0
            ? createPendingCharacterOperation({ kind, targetIds: entityId ? [entityId] : [], patch: cloudPatch,
              targetLabel: typeof patch.name === 'string' ? patch.name : get().characters.find((item) => item.id === entityId)?.name })
            : null;
          set((state) => {
            const queued = operation ? queueAndProjectCharacters(state, [operation]) : queueAndProjectCharacters(state, []);
            const nextCharacters = updateCharacterLocally({
              ...state,
              pendingOperations: queued.pendingOperations,
              characters: queued.characters,
            } as CharacterStore, entityId, patch as Partial<AICharacter>);
            syncCharacterArtifacts(nextCharacters);
            return {
              ...queued,
              characters: nextCharacters,
            };
          });
          if (operation) scheduleCharacterFlush(flushPendingOperations, 120);
        },

        loadProjectedDeletedCharacters: async () => {
          const { deleted } = await reloadProjectedCharacterState(get().pendingOperations);
          return deleted;
        },

        loadProjectedCharacters: async () => {
          return reloadVisibleCharacterState(get().pendingOperations);
        },

        loadProjectedState: async () => { await get().loadCharacters(); },
        getPendingOperations: () => get().pendingOperations,
        getPendingEditError: () => latestCharacterError(get().pendingOperations),
        getPendingEditCount: () => get().pendingOperations.length,
        clearPendingOperations: () => set({ pendingOperations: [], pendingEditSyncCount: 0, pendingEditSyncError: null, fieldConflicts: [] }),
        confirmCreateOperationsSynced: (entityIds) => set((state) => {
          const normalizedIds = new Set(entityIds.filter(Boolean));
          if (!normalizedIds.size) return {};
          const pendingOperations = state.pendingOperations.filter((operation) => (
            operation.kind !== 'create' || !normalizedIds.has(operation.entityId)
          ));
          if (pendingOperations.length === state.pendingOperations.length) return {};
          return {
            characters: projectVisibleCharacters(state.characters, pendingOperations),
            pendingOperations,
            fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'character', entityIds: Array.from(normalizedIds) }),
            pendingEditSyncCount: pendingOperations.length,
            pendingEditSyncError: latestCharacterError(pendingOperations),
          };
        }),
        discardFailedOperation: (operationId) => set((state) => {
          const operation = state.pendingOperations.find((item) => item.id === operationId);
          if (operation?.status !== 'failed') return {};
          cancelSyncTasks(getCharacterStorageKey(), [operationId]);
          const pendingOperations = removePendingCharacterOperation(state.pendingOperations, operationId);
          return {
            characters: projectVisibleCharacters(state.characters, pendingOperations),
            pendingOperations,
            fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'character', operationIds: [operationId] }),
            pendingEditSyncCount: pendingOperations.length,
            pendingEditSyncError: latestCharacterError(pendingOperations),
          };
        }),
        clearSyncTasks: (operationIds) => set((state) => {
          const ids = new Set(operationIds);
          const removed = state.pendingOperations.filter((operation) => ids.has(operation.id) && operation.status !== 'syncing');
          if (!removed.length) return {};
          const removedIds = new Set(removed.map((operation) => operation.id));
          cancelSyncTasks(getCharacterStorageKey(), [...removedIds]);
          const pendingOperations = state.pendingOperations.filter((operation) => !removedIds.has(operation.id));
          removedIds.forEach(removeLocalOutboxWorkerOperation);
          return {
            pendingOperations,
            fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'character', operationIds: [...removedIds] }),
            pendingEditSyncCount: pendingOperations.length,
            pendingEditSyncError: latestCharacterError(pendingOperations),
          };
        }),
        resolveRemoteDeleteConflict: async (id, resolution) => {
          if (!id) return;
          if (resolution === 'restore_local') {
            set((state) => ({
              remoteDeletedCharacterIds: state.remoteDeletedCharacterIds.filter((characterId) => characterId !== id),
              fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'character', entityIds: [id] }),
            }));
            await get().syncPatch(id, { deletedAt: null }, 'patch');
            scheduleCharacterFlush(flushPendingOperations, 100);
            return;
          }
          if (resolution === 'save_as_new') {
            const snapshot = get().characters.find((character) => character.id === id);
            if (snapshot) await get().addCharacter(createConflictCopyCharacterData(snapshot, get().characters));
          }
          set((state) => {
            const pendingOperations = state.pendingOperations.filter((operation) => operation.entityId !== id);
            const characters = state.characters.filter((character) => character.id !== id);
            syncCharacterArtifacts(characters);
            return {
              characters,
              pendingOperations,
              fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, { entityType: 'character', entityIds: [id] }),
              pendingEditSyncCount: pendingOperations.length,
              pendingEditSyncError: latestCharacterError(pendingOperations),
              remoteDeletedCharacterIds: state.remoteDeletedCharacterIds.filter((characterId) => characterId !== id),
            };
          });
        },
        resolveFieldConflict: async (id, field, resolution) => {
          const conflict = get().fieldConflicts.find((item) => item.entityId === id && item.field === field && !item.accepted);
          if (!conflict) return;
          if (resolution === 'keep_local') {
            set((state) => ({ fieldConflicts: state.fieldConflicts.map((item) => item.id === conflict.id ? { ...item, accepted: true } : item) }));
            scheduleCharacterFlush(flushPendingOperations, 0);
            return;
          }
          const remote = await fetchCharacterDetail(id);
          set((state) => {
            if (!state.fieldConflicts.some((item) => item.id === conflict.id)) return {};
            const pendingOperations = removePendingConflictField(state.pendingOperations, id, field);
            const characters = state.characters.map((character) => character.id === id
              ? normalizeCharacter({ ...character, [field]: (remote as unknown as Record<string, unknown>)[field], fieldVersions: { ...character.fieldVersions, [field]: remote.fieldVersions?.[field] || 0 } } as AICharacter)
              : character);
            return {
              characters: projectVisibleCharacters(characters, pendingOperations),
              pendingOperations,
              fieldConflicts: state.fieldConflicts.filter((item) => item.id !== conflict.id),
              pendingEditSyncCount: pendingOperations.length,
              pendingEditSyncError: latestCharacterError(pendingOperations),
            };
          });
          scheduleCharacterFlush(flushPendingOperations, 0);
        },
        retryFailedOperations: () => set((state) => {
          const pendingOperations = retryFailedOperations(state.pendingOperations, { includeTerminal: false });
          if (pendingOperations === state.pendingOperations) return {};
          return {
            pendingOperations,
            pendingEditSyncCount: pendingOperations.length,
            pendingEditSyncError: latestCharacterError(pendingOperations),
          };
        }),
        loadPendingSnapshot: async () => get().loadProjectedCharacters(),
        loadProjectedRecycleBin: async () => get().loadProjectedDeletedCharacters(),
        hydrateProjectedState: () => set((state) => ({ characters: projectVisibleCharacters(state.characters, state.pendingOperations) })),
        resumeSync: () => scheduleCharacterFlush(flushPendingOperations, 100),
        syncPatch: async (entityId, patch, kind = 'patch') => {
          get().queuePatch(entityId, patch, kind);
        },
        loadProjectedVisibleCharacters: async () => get().loadProjectedCharacters(),

        addCharacter: async (charData) => {
          const [character] = await get().addCharacters([charData]);
          return character;
        },

        addCharacters: async (charsData) => {
          if (!charsData.length) return [];
          assertUniqueCharacterNameBatch(get().characters, charsData);
          const createdCharacters: AICharacter[] = [];
          set((state) => {
            const characters = (() => {
              let nextCharacters = state.characters;
              for (const charData of charsData) {
                const local = createCharacterLocally({ ...state, characters: nextCharacters }, charData);
                createdCharacters.push(local.character);
                nextCharacters = local.characters;
              }
              return nextCharacters;
            })();
            const operations = shouldSkipCloudSync()
              ? []
              : createdCharacters.map((character) => createPendingCharacterOperation({
                kind: 'create',
                targetIds: [character.id],
                targetLabel: character.name,
                patch: compactCharacterPatchForCloud({ ...character, id: character.id } as Record<string, unknown>),
              }));
            const queued = operations.length
              ? queueAndProjectCharacters({ ...state, characters } as CharacterStore, operations)
              : {
                pendingOperations: state.pendingOperations,
                pendingEditSyncCount: state.pendingOperations.length,
                pendingEditSyncError: latestCharacterError(state.pendingOperations),
              };
            return {
              characters,
              pendingOperations: queued.pendingOperations,
              pendingEditSyncCount: queued.pendingEditSyncCount,
              pendingEditSyncError: queued.pendingEditSyncError,
            };
          });
          enqueueBirthLettersForCreation(createdCharacters, get().characters);
          if (!shouldSkipCloudSync()) {
            scheduleCharacterFlush(flushPendingOperations, 120);
          }
          return createdCharacters;
        },

        updateCharacter: async (id, updates) => {
          assertUniqueCharacterNameUpdate(get().characters, id, updates);
          if (shouldSkipCloudSync()) {
            set((state) => {
              const characters = updateCharacterLocally(state, id, updates);
              syncCharacterArtifacts(characters);
              return { characters };
            });
            return;
          }
          await get().syncPatch(id, updates, 'patch');
        },

        applyLocalCharacterVisualAssets: (id, assets, primaryReferenceImageId) => {
          set((state) => {
            const characters = sortCharacters(state.characters.map((character) => (
              character.id === id
                ? projectLocalCharacterVisualAssets(character, assets, primaryReferenceImageId)
                : character
            )));
            syncCharacterArtifacts(characters);
            return { characters };
          });
        },

        updateCharacters: async (patches) => {
          const normalizedPatches = patches.filter((patch) => patch.id);
          if (!normalizedPatches.length) return;
          normalizedPatches.forEach((patch) => assertUniqueCharacterNameUpdate(get().characters, patch.id, patch.updates));
          if (shouldSkipCloudSync()) {
            set((state) => {
              let nextCharacters = state.characters;
              for (const patch of normalizedPatches) {
                nextCharacters = updateCharacterLocally({ ...state, characters: nextCharacters } as CharacterStore, patch.id, patch.updates);
              }
              syncCharacterArtifacts(nextCharacters);
              return { characters: nextCharacters };
            });
            return;
          }
          const operations = normalizedPatches
            .map((patch) => {
              const character = get().characters.find((item) => item.id === patch.id);
              if (character?.isPreset) return null;
              const cloudPatch = compactCharacterPatchForCloud(patch.updates as Record<string, unknown>);
              if (Object.keys(cloudPatch).length === 0) return null;
              return createPendingCharacterOperation({ kind: 'patch', targetIds: [patch.id], patch: cloudPatch, targetLabel: character?.name });
            })
            .filter(Boolean) as PendingCharacterOperation[];
          set((state) => {
            const queued = queueAndProjectCharacters(state, operations);
            let nextCharacters = queued.characters;
            for (const patch of normalizedPatches) {
              nextCharacters = updateCharacterLocally({
                ...state,
                pendingOperations: queued.pendingOperations,
                characters: nextCharacters,
              } as CharacterStore, patch.id, patch.updates);
            }
            return {
              ...queued,
              characters: nextCharacters,
            };
          });
          if (operations.length) scheduleCharacterFlush(flushPendingOperations, 120);
        },

        deleteCharacter: async (id) => {
          const normalizedIds = Array.from(new Set([id].filter(Boolean)));
          if (!normalizedIds.length) return;
          enqueueFinalLettersForDeletion(get().characters, normalizedIds);
          const deletedAt = Date.now();
          if (shouldSkipCloudSync()) {
            set((state) => {
              const characters = deleteCharactersLocally(state, normalizedIds);
              syncCharacterArtifacts(characters);
              return { characters };
            });
            return;
          }
          await Promise.all(normalizedIds.map((characterId) => get().syncPatch(characterId, { deletedAt }, 'patch')));
        },

        deleteCharacters: async (ids) => {
          const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
          if (!normalizedIds.length) return;
          enqueueFinalLettersForDeletion(get().characters, normalizedIds);
          if (shouldSkipCloudSync()) {
            set((state) => {
              const characters = deleteCharactersLocally(state, normalizedIds);
              syncCharacterArtifacts(characters);
              return { characters };
            });
            return;
          }
          const deletedAt = Date.now();
          await Promise.all(normalizedIds.map((characterId) => get().syncPatch(characterId, { deletedAt }, 'patch')));
        },

        restoreCharacters: async (ids) => {
          const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
          if (!normalizedIds.length) return;
          if (shouldSkipCloudSync()) {
            set((state) => {
              const characters = restoreCharactersLocally(state, normalizedIds);
              syncCharacterArtifacts(characters);
              return { characters };
            });
            return;
          }
          await Promise.all(normalizedIds.map((characterId) => get().syncPatch(characterId, { deletedAt: null }, 'patch')));
        },

        purgeCharacters: async (ids) => {
          const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
          if (!normalizedIds.length) return;
          if (shouldSkipCloudSync()) {
            set((state) => {
              const characters = sortCharacters(applyLocalCharacterPurge(state.characters, normalizedIds));
              syncCharacterArtifacts(characters);
              return { characters };
            });
            return;
          }
          await applyCharacterPurge(normalizedIds);
          const projectedState = await reloadProjectedCharacterState(get().pendingOperations);
          set({
            characters: projectedState.visible,
            lastSyncedAt: Date.now(),
            pendingEditSyncCount: get().pendingOperations.length,
            pendingEditSyncError: latestCharacterError(get().pendingOperations),
          });
          syncCharacterArtifacts(projectedState.visible);
        },

        emptyDeletedCharacters: async () => {
          if (shouldSkipCloudSync()) {
            set((state) => {
              const characters = sortCharacters(applyLocalEmptyDeletedCharacters(state.characters));
              syncCharacterArtifacts(characters);
              return { characters };
            });
            return;
          }
          await applyEmptyDeletedCharacters();
          const projectedState = await reloadProjectedCharacterState(get().pendingOperations);
          set({
            characters: projectedState.visible,
            lastSyncedAt: Date.now(),
            pendingEditSyncCount: get().pendingOperations.length,
            pendingEditSyncError: latestCharacterError(get().pendingOperations),
          });
          syncCharacterArtifacts(projectedState.visible);
        },

        loadDeletedCharacters: async () => {
          const { deleted } = await reloadProjectedCharacterState(get().pendingOperations);
          return deleted;
        },

        updateCharactersGroup: async (ids, group) => {
          const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
          const normalizedGroup = normalizeCharacterGroup(group);
          if (!normalizedIds.length) return;
          if (shouldSkipCloudSync()) {
            set((state) => ({
              characters: (() => {
                const characters = sortCharacters(state.characters.map((character) => normalizedIds.includes(character.id)
                  ? applyLocalCharacterUpdate(character, { group: normalizedGroup })
                  : character));
                syncCharacterArtifacts(characters);
                return characters;
              })(),
            }));
            return;
          }
          await Promise.all(normalizedIds.map((id) => get().syncPatch(id, { group: normalizedGroup }, 'patch')));
        },

        getCharacter: (id) => get().characters.find((c) => c.id === id),
        hasCharacterLoaded: (id) => isCharacterDetailLoaded(get().characters.find((c) => c.id === id)),
        getCharactersLoadedAt: () => get().lastSyncedAt,
        getSyncScopeStates: () => characterSyncScopes.listStates(),
        markCharactersWarm: () => {
          void ensureCharacterStoreHydrated().then(() => {
            set(buildMarkedWarmCharacterStoreState);
          });
        },
        hydrateCharacterSummaries: (summaries) => {
          if (!summaries.length) return;
          set((state) => {
            const nextCharacters = mergeVisibleCharacters(
              state.characters,
              summaries.map((summary) => normalizeCharacter({
                id: summary.id,
                name: summary.name,
                avatar: summary.avatar,
                personality: summary.personality,
                expertise: summary.expertise,
                speakingStyle: summary.speakingStyle,
                background: summary.background,
                isPreset: summary.isPreset,
                createdAt: summary.createdAt,
                updatedAt: summary.updatedAt,
                visualIdentity: summary.visualIdentity,
                speechProfile: summary.speechProfile,
                bubbleStyleId: summary.bubbleStyleId,
                bubbleStyle: summary.bubbleStyle,
                characterDetailLoaded: false,
              } as AICharacter)),
              state.pendingOperations,
            );
            if (buildCharacterListSignature(nextCharacters) === buildCharacterListSignature(state.characters)) {
              return {};
            }
            return { characters: nextCharacters };
          });
        },
        getPresets: () => get().characters.filter((c) => c.isPreset),
        getCustom: () => get().characters.filter((c) => !c.isPreset),

        importCharacters: async (chars) => {
          assertUniqueCharacterNameBatch(get().characters, chars);
          if (shouldSkipCloudSync()) {
            set((state) => {
              const characters = importCharactersBatchLocally(state, chars);
              syncCharacterArtifacts(characters);
              return { characters };
            });
            return;
          }
          const created = await Promise.all(chars.map((c) => createCharacterRemote(c)));
          set((state) => ({
            characters: mergeCharacters(state.characters, [...created, ...state.characters], state.pendingOperations).filter((item) => item.deletedAt == null),
          }));
          syncCharacterArtifacts(get().characters);
        },

        initializePresets: async () => undefined,
      };
    },
    {
      name: getCharacterStoreStorageName(),
      storage: characterStorage,
      version: CLIENT_STORE_SCHEMA_VERSION,
      migrate: (persistedState) => {
        const migrated = migrateCharacterStoreState(persistedState as PersistedCharacterState) as PersistedCharacterState;
        return {
          ...migrated,
          pendingOperations: recoverInterruptedOperations(migrated.pendingOperations || []),
          fieldConflicts: migrated.fieldConflicts || [],
        };
      },
      partialize: (state) => buildPersistedCharacterState({
        characters: state.characters,
        lastSyncedAt: state.lastSyncedAt,
        pendingOperations: state.pendingOperations,
      }),
      skipHydration: true,
    }
  )
);

bindSyncTaskCancellation(useCharacterStore, {
  getStorageKey: getCharacterStorageKey,
  getQueue: (state) => state.pendingOperations,
  applyQueue: (state, pendingOperations) => ({
    pendingOperations,
    pendingEditSyncCount: pendingOperations.length,
    pendingEditSyncError: latestCharacterError(pendingOperations),
    fieldConflicts: clearResolvedFieldConflicts(state.fieldConflicts, {
      entityType: 'character',
      operationIds: state.pendingOperations.filter((operation) => !pendingOperations.includes(operation)).map((operation) => operation.id),
    }),
  }),
});

export const __characterRuntimePersistenceForTests = {
  compactCharacterPatchForCloud,
  buildPersistedCharacterState,
  isCharacterDetailLoaded,
  limits: {
    layeredMemories: DEFAULT_BASIC_RETENTION_LIMITS.characterLayeredMemories.storage,
    runtimeTimeline: DEFAULT_BASIC_RETENTION_LIMITS.characterRuntimeTimeline.storage,
  },
};
