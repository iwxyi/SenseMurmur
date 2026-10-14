import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AssistantAgentPatch, AssistantArtifactDataOperation, AssistantArtifactDataResult, AssistantArtifactDraft, AssistantArtifactItem, AssistantArtifactVersion, AssistantArtifactTextOperation, AssistantArtifactVersionOperation } from '../types/assistantArtifact';
import { applyAssistantArtifactDataOperation } from '../services/assistantArtifactData';
import type { Message, MessageAttachment } from '../types/message';
import { scopedStorageKey, storageKey } from '../constants/brand';
import { getLocalDataUserId } from '../services/authStorageScope';
import { createScopedIndexedDbBufferedJsonStorage, flushBufferedPersistenceWrites } from './storePersistenceScope';
import { api } from '../services/api';
import type { SyncChangeScope } from '../services/api';
import { isCloudSyncEnabled } from '../services/cloudSyncPreference';
import { isAssistantArtifactCloudSyncEnabled } from '../services/assistantArtifactCloudSyncPreference';
import { createSyncScopeMetadata } from './syncScopeMetadata';
import { useChatStore } from './useChatStore';
import { useLocalWorkspaceStore } from './useLocalWorkspaceStore';
import { removeAssistantArtifactFromLocalWorkspace } from '../services/localWorkspaceService';

interface AssistantArtifactSnapshot {
  items: AssistantArtifactItem[];
}

interface AssistantArtifactStore extends AssistantArtifactSnapshot {
  upsertArtifactsFromMessage: (params: {
    chatId: string;
    messageId: string;
    drafts: AssistantArtifactDraft[];
    timestamp?: number;
  }) => AssistantArtifactItem[];
  commitPatchSet: (params: {
    chatId: string;
    messageId: string;
    patches: AssistantAgentPatch[];
    timestamp?: number;
  }) => AssistantArtifactItem[];
  applyDataOperations: (params: {
    chatId: string;
    operations: AssistantArtifactDataOperation[];
    timestamp?: number;
  }) => { artifacts: AssistantArtifactItem[]; results: AssistantArtifactDataResult[] };
  applyTextOperations: (params: { chatId: string; operations: AssistantArtifactTextOperation[]; timestamp?: number }) => { artifacts: AssistantArtifactItem[]; results: Array<{ artifactId: string; replacements: number; error?: string }> };
  applyVersionOperations: (params: { chatId: string; operations: AssistantArtifactVersionOperation[]; timestamp?: number }) => { artifacts: AssistantArtifactItem[]; results: Array<{ artifactId: string; kind: AssistantArtifactVersionOperation['kind']; error?: string }> };
  saveHtmlInteractionState: (params: {
    artifactId: string;
    baseVersionId: string;
    interactionState: Record<string, unknown>;
    timestamp?: number;
  }) => AssistantArtifactItem | null;
  submitHtmlInteraction: (params: {
    artifactId: string;
    baseVersionId: string;
    interactionState: Record<string, unknown>;
    submissionId: string;
    timestamp?: number;
  }) => AssistantArtifactItem | null;
  getArtifactsForChat: (chatId: string) => AssistantArtifactItem[];
  refreshArtifactsFromCloud: (chatId: string) => Promise<void>;
  pushArtifactsToCloud: (chatId: string, artifactIds?: string[]) => Promise<void>;
  createImageArtifactFromAttachment: (params: {
    chatId: string;
    message: Message;
    attachment: MessageAttachment;
    timestamp?: number;
  }) => AssistantArtifactItem | null;
  moveArtifact: (chatId: string, artifactId: string, direction: 'up' | 'down') => void;
  deleteArtifact: (artifactId: string) => void;
}

const MAX_ARTIFACTS_PER_CHAT = 80;
const MAX_VERSIONS_PER_ARTIFACT = 12;
const ASSISTANT_ARTIFACT_SYNC_TTL_MS = 30_000;
let assistantArtifactHydrationPromise: Promise<void> | null = null;
const htmlAutosaveCloudPushTimers = new Map<string, number>();
const assistantArtifactSyncScopes = createSyncScopeMetadata(ASSISTANT_ARTIFACT_SYNC_TTL_MS, {
  getStorageKey: () => scopedStorageKey(`assistant-artifact-sync-scopes-${getLocalDataUserId()}`),
});

function shouldSyncAssistantArtifactsToCloud() {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(storageKey('auth-mode')) === 'cloud'
    && isCloudSyncEnabled()
    && isAssistantArtifactCloudSyncEnabled();
}

function getAssistantArtifactStorageKey() {
  return scopedStorageKey(`assistant-artifacts-${getLocalDataUserId()}`);
}

function createArtifactId(chatId: string, now: number, index: number) {
  return `assistant-artifact-${chatId}-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`;
}

function createVersionId(artifactId: string, now: number) {
  return `${artifactId}:v:${now}:${Math.random().toString(36).slice(2, 6)}`;
}

function createOperationId(prefix: string) {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function artifactPayloadForCloud(item: AssistantArtifactItem) {
  return {
    ...item,
    baseRevision: item.revision || null,
    operationId: createOperationId(item.id),
  };
}

function findTargetArtifact(items: AssistantArtifactItem[], chatId: string, draft: AssistantArtifactDraft) {
  if (draft.action !== 'update' || !draft.targetArtifactId) return null;
  return items.find((item) => item.id === draft.targetArtifactId && item.chatId === chatId && item.deletedAt == null) || null;
}

function draftFromPatch(patch: AssistantAgentPatch): AssistantArtifactDraft {
  return {
    action: patch.action,
    targetArtifactId: patch.action === 'update' ? patch.artifactId || null : null,
    kind: patch.kind,
    title: patch.title,
    summary: patch.summary,
    language: patch.language || null,
    content: patch.content,
    files: patch.files,
    baseVersionId: patch.baseVersionId || null,
    changeSummary: patch.changeSummary,
    media: patch.media,
    htmlRuntime: patch.htmlRuntime,
    versionStage: patch.versionStage,
    dataDescriptor: patch.dataDescriptor,
  };
}

function currentArtifactVersion(item: AssistantArtifactItem) {
  return item.versions.find((version) => version.id === item.currentVersionId) || item.versions.at(-1) || null;
}

function htmlInteractionVersion(params: {
  artifact: AssistantArtifactItem;
  baseVersion: AssistantArtifactVersion;
  interactionState: Record<string, unknown>;
  stage: 'autosave' | 'submitted';
  timestamp: number;
  submissionId?: string;
}) {
  return {
    ...params.baseVersion,
    id: createVersionId(params.artifact.id, params.timestamp),
    artifactId: params.artifact.id,
    baseVersionId: params.baseVersion.id,
    sourceMessageId: params.baseVersion.sourceMessageId,
    stage: params.stage,
    interactionState: params.interactionState,
    updatedAt: params.timestamp,
    revision: 1,
    submissionId: params.submissionId,
    submittedAt: params.stage === 'submitted' ? params.timestamp : undefined,
    createdAt: params.timestamp,
  } satisfies AssistantArtifactVersion;
}

function pruneChatArtifacts(items: AssistantArtifactItem[], chatId: string) {
  const chatItems = items.filter((item) => item.chatId === chatId && item.deletedAt == null).sort((a, b) => b.updatedAt - a.updatedAt);
  if (chatItems.length <= MAX_ARTIFACTS_PER_CHAT) return { items, prunedArtifactIds: [] as string[] };
  const keepIds = new Set(chatItems.slice(0, MAX_ARTIFACTS_PER_CHAT).map((item) => item.id));
  const prunedArtifactIds = chatItems.filter((item) => !keepIds.has(item.id)).map((item) => item.id);
  const nextItems = items.map((item) => (
    item.chatId === chatId && item.deletedAt == null && !keepIds.has(item.id)
      ? { ...item, deletedAt: Date.now(), updatedAt: Date.now() }
      : item
  ));
  return { items: nextItems, prunedArtifactIds };
}

function orderedChatArtifacts(items: AssistantArtifactItem[], chatId: string) {
  return items
    .filter((item) => item.chatId === chatId && item.deletedAt == null)
    .sort((a, b) => {
      const aOrder = typeof a.sortOrder === 'number' ? a.sortOrder : Number.MAX_SAFE_INTEGER;
      const bOrder = typeof b.sortOrder === 'number' ? b.sortOrder : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return b.updatedAt - a.updatedAt;
    });
}

function mergeArtifactItems(localItems: AssistantArtifactItem[], incomingItems: AssistantArtifactItem[]) {
  if (!incomingItems.length) return localItems;
  const byId = new Map(localItems.map((item) => [item.id, item]));
  for (const incoming of incomingItems) {
    const existing = byId.get(incoming.id);
    if (!existing || (incoming.updatedAt || 0) >= (existing.updatedAt || 0)) {
      byId.set(incoming.id, incoming);
    }
  }
  return Array.from(byId.values());
}

function mergeCloudArtifacts(incomingItems: AssistantArtifactItem[]) {
  if (!incomingItems.length) return;
  useAssistantArtifactStore.setState((state) => ({ items: mergeArtifactItems(state.items, incomingItems) }));
}

function assistantArtifactSyncScope(chatId: string): SyncChangeScope {
  return `assistant-artifacts:${chatId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeCloudArtifactPatch(change: Record<string, unknown>, chatId: string): AssistantArtifactItem | null {
  if (change.entity !== 'assistant_artifact' || typeof change.id !== 'string') return null;
  const patch = isRecord(change.patch) ? change.patch : null;
  if (!patch || patch.chatId !== chatId || typeof patch.kind !== 'string') return null;
  const versions = Array.isArray(patch.versions) ? patch.versions : [];
  return {
    id: change.id,
    chatId,
    kind: patch.kind as AssistantArtifactItem['kind'],
    title: typeof patch.title === 'string' ? patch.title : '未命名产物',
    summary: typeof patch.summary === 'string' ? patch.summary : undefined,
    language: typeof patch.language === 'string' ? patch.language : null,
    currentVersionId: typeof patch.currentVersionId === 'string' ? patch.currentVersionId : '',
    versions: versions as AssistantArtifactItem['versions'],
    sourceMessageId: typeof patch.sourceMessageId === 'string' ? patch.sourceMessageId : '',
    createdAt: Number(patch.createdAt || 0),
    updatedAt: Number(patch.updatedAt || change.revision || 0),
    sortOrder: typeof patch.sortOrder === 'number' ? patch.sortOrder : undefined,
    deletedAt: patch.deletedAt == null ? null : Number(patch.deletedAt),
    revision: Number(patch.revision || change.revision || 1),
    dataDescriptor: isRecord(patch.dataDescriptor) ? patch.dataDescriptor as unknown as AssistantArtifactItem['dataDescriptor'] : undefined,
  };
}

async function refreshArtifactsViaSyncChanges(chatId: string) {
  const scope = assistantArtifactSyncScope(chatId);
  const state = assistantArtifactSyncScopes.getState(scope);
  const since = state.cursor ?? state.revision ?? null;
  const result = await api.getSyncChanges({ scope, since });
  if (result.status === 'modified') {
    const incomingItems = result.changes
      .map((change) => normalizeCloudArtifactPatch(change, chatId))
      .filter((item): item is AssistantArtifactItem => Boolean(item));
    mergeCloudArtifacts(incomingItems);
  }
  assistantArtifactSyncScopes.markChecked(scope, {
    cursor: result.cursor,
    revision: result.revision,
    applied: result.status === 'modified',
  });
}

async function refreshArtifactsViaLegacyEndpoint(chatId: string) {
  const result = await api.getAssistantArtifacts(chatId);
  useAssistantArtifactStore.setState((state) => ({ items: mergeArtifactItems(state.items, result.items) }));
  assistantArtifactSyncScopes.markChecked(assistantArtifactSyncScope(chatId), { applied: true, fresh: false });
}

function scheduleArtifactCloudPush(chatId: string, artifactIds: string[]) {
  if (!shouldSyncAssistantArtifactsToCloud() || !artifactIds.length) return;
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    void useAssistantArtifactStore.getState().pushArtifactsToCloud(chatId, artifactIds).catch(() => undefined);
  }, 0);
}

function scheduleHtmlAutosaveCloudPush(chatId: string, artifactId: string) {
  if (!shouldSyncAssistantArtifactsToCloud() || typeof window === 'undefined') return;
  const key = `${chatId}:${artifactId}`;
  const existingTimer = htmlAutosaveCloudPushTimers.get(key);
  if (existingTimer) window.clearTimeout(existingTimer);
  const timer = window.setTimeout(() => {
    htmlAutosaveCloudPushTimers.delete(key);
    void useAssistantArtifactStore.getState().pushArtifactsToCloud(chatId, [artifactId]).catch(() => undefined);
  }, 4_000);
  htmlAutosaveCloudPushTimers.set(key, timer);
}

function clearHtmlAutosaveCloudPush(chatId: string, artifactId: string) {
  if (typeof window === 'undefined') return;
  const key = `${chatId}:${artifactId}`;
  const timer = htmlAutosaveCloudPushTimers.get(key);
  if (timer) window.clearTimeout(timer);
  htmlAutosaveCloudPushTimers.delete(key);
}

function scheduleArtifactLocalWorkspaceWrite(chatId: string, artifacts: AssistantArtifactItem[]) {
  if (!artifacts.length || typeof window === 'undefined') return;
  window.setTimeout(() => {
    const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
    if (!chat || chat.type !== 'assistant') return;
    const workspace = useLocalWorkspaceStore.getState();
    if (!workspace.getDefaultDirectory()) return;
    void Promise.allSettled(
      artifacts.map((artifact) => workspace.mirrorAssistantArtifact({ chat, artifact })),
    ).then((results) => {
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) console.warn('[assistant-artifact:local-workspace-write-failed]', rejected.reason);
    });
  }, 0);
}

function scheduleArtifactLocalWorkspaceDelete(chatId: string, artifactIds: string[]) {
  if (!artifactIds.length || typeof window === 'undefined') return;
  window.setTimeout(() => {
    const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
    if (!chat || chat.type !== 'assistant') return;
    const workspace = useLocalWorkspaceStore.getState();
    if (!workspace.directories.length) return;
    void Promise.allSettled(
      workspace.directories.map((directory) => (
        Promise.all(
          artifactIds.map((artifactId) => removeAssistantArtifactFromLocalWorkspace({
            directory,
            chatId,
            artifactId,
          })),
        )
      )),
    ).then((results) => {
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) console.warn('[assistant-artifact:local-workspace-delete-failed]', rejected.reason);
    });
  }, 0);
}

export const useAssistantArtifactStore = create<AssistantArtifactStore>()(
  persist(
    (set, get) => ({
      items: [],

      upsertArtifactsFromMessage: ({ chatId, messageId, drafts, timestamp }) => {
        if (!drafts.length) return [];
        const now = timestamp || Date.now();
        const changed: AssistantArtifactItem[] = [];
        let prunedArtifactIds: string[] = [];
        set((state) => {
          let nextItems = [...state.items];
          drafts.forEach((draft, index) => {
            const existing = findTargetArtifact(nextItems, chatId, draft);
            const artifactId = existing?.id || createArtifactId(chatId, now, index);
            const version = {
              id: createVersionId(artifactId, now + index),
              artifactId,
              content: draft.content,
              files: draft.files,
              language: draft.language || null,
              sourceMessageId: messageId,
              baseVersionId: draft.baseVersionId || existing?.currentVersionId || null,
              changeSummary: draft.changeSummary,
              media: draft.media,
              htmlRuntime: draft.htmlRuntime,
              dataDescriptor: draft.dataDescriptor,
              stage: draft.versionStage || (draft.kind === 'html' ? (existing ? 'ai_result' : 'generated') : undefined),
              updatedAt: now + index,
              revision: (existing?.versions.at(-1)?.revision || existing?.revision || 0) + 1,
              createdAt: now + index,
            };
            if (existing) {
              const previousVersion = existing.versions.find((item) => item.content.trim() === draft.content.trim());
              const updated = previousVersion ? {
                ...existing,
                summary: draft.summary || existing.summary,
                updatedAt: now + index,
              } : {
                ...existing,
                title: draft.title || existing.title,
                summary: draft.summary || existing.summary,
                language: draft.language || existing.language || null,
                dataDescriptor: draft.dataDescriptor || existing.dataDescriptor,
                currentVersionId: version.id,
                versions: [...existing.versions, version].slice(-MAX_VERSIONS_PER_ARTIFACT),
                revision: version.revision,
                sourceMessageId: messageId,
                updatedAt: now + index,
              };
              nextItems = nextItems.map((item) => item.id === existing.id ? updated : item);
              changed.push(updated);
              return;
            }
            const created: AssistantArtifactItem = {
              id: artifactId,
              chatId,
              kind: draft.kind,
              title: draft.title,
              summary: draft.summary,
              language: draft.language || null,
              currentVersionId: version.id,
              versions: [version],
              sourceMessageId: messageId,
              createdAt: now + index,
              updatedAt: now + index,
              sortOrder: now + index,
              deletedAt: null,
              dataDescriptor: draft.dataDescriptor,
            };
              nextItems.unshift(created);
              changed.push(created);
            });
          const pruned = pruneChatArtifacts(nextItems, chatId);
          prunedArtifactIds = pruned.prunedArtifactIds;
          return { items: pruned.items };
        });
        scheduleArtifactCloudPush(chatId, changed.map((item) => item.id));
        scheduleArtifactLocalWorkspaceWrite(chatId, changed);
        scheduleArtifactLocalWorkspaceDelete(chatId, prunedArtifactIds);
        return changed;
      },

      commitPatchSet: ({ chatId, messageId, patches, timestamp }) => get().upsertArtifactsFromMessage({
        chatId,
        messageId,
        drafts: patches.map(draftFromPatch),
        timestamp,
      }),
      applyDataOperations: ({ chatId, operations, timestamp }) => {
        const now = timestamp || Date.now();
        const changed: AssistantArtifactItem[] = [];
        const results: AssistantArtifactDataResult[] = [];
        set((state) => {
          let nextItems = [...state.items];
          for (const operation of operations) {
            const current = nextItems.find((item) => item.id === operation.artifactId && item.chatId === chatId && item.deletedAt == null);
            if (!current || !['table', 'json'].includes(current.kind)) {
              results.push({ operation: operation.kind, affectedRows: 0, error: '目标不是 CSV/JSON 数据产物' });
              continue;
            }
            if (operation.baseVersionId && operation.baseVersionId !== current.currentVersionId) {
              results.push({ operation: operation.kind, affectedRows: 0, error: '产物版本已变化，请重新查询后再操作' });
              continue;
            }
            const applied = applyAssistantArtifactDataOperation(current, operation, now + results.length);
            results.push(applied.result);
            if (applied.item !== current) {
              nextItems = nextItems.map((item) => item.id === current.id ? applied.item : item);
              changed.push(applied.item);
            }
          }
          return { items: nextItems };
        });
        if (changed.length) {
          const ids = changed.map((item) => item.id);
          for (const artifact of changed) {
            scheduleArtifactCloudPush(chatId, [artifact.id]);
            scheduleArtifactLocalWorkspaceWrite(chatId, [artifact]);
          }
          void ids;
        }
        return { artifacts: changed, results };
      },
      applyTextOperations: ({ chatId, operations, timestamp }) => {
        const now = timestamp || Date.now();
        const changed: AssistantArtifactItem[] = [];
        const results: Array<{ artifactId: string; replacements: number; error?: string }> = [];
        set((state) => {
          let nextItems = [...state.items];
          for (const operation of operations) {
            const current = nextItems.find((item) => item.id === operation.artifactId && item.chatId === chatId && item.deletedAt == null);
            if (!current || !operation.search) { results.push({ artifactId: operation.artifactId, replacements: 0, error: '目标产物或搜索文本无效' }); continue; }
            if (operation.baseVersionId && operation.baseVersionId !== current.currentVersionId) { results.push({ artifactId: operation.artifactId, replacements: 0, error: '产物版本已变化，请重新读取' }); continue; }
            const version = current.versions.find((entry) => entry.id === current.currentVersionId) || current.versions.at(-1);
            if (!version) { results.push({ artifactId: operation.artifactId, replacements: 0, error: '产物没有可用版本' }); continue; }
            const target = operation.filePath ? version.files?.find((file) => file.path === operation.filePath) : undefined;
            if (operation.filePath && !target) { results.push({ artifactId: operation.artifactId, replacements: 0, error: '找不到目标文件' }); continue; }
            const replace = (content: string) => { const count = operation.replaceAll === false ? (content.includes(operation.search) ? 1 : 0) : content.split(operation.search).length - 1; return { content: operation.replaceAll === false ? content.replace(operation.search, operation.replacement) : content.split(operation.search).join(operation.replacement), count }; };
            const updated = target ? replace(target.content) : replace(version.content);
            const nextVersion: AssistantArtifactVersion = { ...version, id: `${current.id}:text:${now}:${Math.random().toString(36).slice(2, 7)}`, baseVersionId: version.id, content: target ? version.content : updated.content, files: target ? version.files?.map((file) => file.path === target.path ? { ...file, content: updated.content } : file) : version.files, changeSummary: `文本替换 ${updated.count} 处`, updatedAt: now, createdAt: now, revision: 1 };
            const nextItem = { ...current, currentVersionId: nextVersion.id, versions: [...current.versions, nextVersion].slice(-12), updatedAt: now };
            nextItems = nextItems.map((item) => item.id === current.id ? nextItem : item); changed.push(nextItem); results.push({ artifactId: current.id, replacements: updated.count });
          }
          return { items: nextItems };
        });
        for (const item of changed) scheduleArtifactLocalWorkspaceWrite(chatId, [item]);
        return { artifacts: changed, results };
      },
      applyVersionOperations: ({ chatId, operations, timestamp }) => {
        const now = timestamp || Date.now();
        const changed: AssistantArtifactItem[] = [];
        const results: Array<{ artifactId: string; kind: AssistantArtifactVersionOperation['kind']; error?: string }> = [];
        set((state) => {
          let nextItems = [...state.items];
          for (const operation of operations) {
            const current = nextItems.find((item) => item.id === operation.artifactId && item.chatId === chatId && item.deletedAt == null);
            if (!current) { results.push({ artifactId: operation.artifactId, kind: operation.kind, error: '找不到目标产物' }); continue; }
            if (operation.kind === 'restore') {
              const index = current.versions.findIndex((version) => version.id === operation.versionId);
              if (index < 0) { results.push({ artifactId: operation.artifactId, kind: operation.kind, error: '找不到指定版本' }); continue; }
              const versions = current.versions.slice(0, index + 1);
              const updated = { ...current, currentVersionId: operation.versionId!, versions, updatedAt: now };
              nextItems = nextItems.map((item) => item.id === current.id ? updated : item); changed.push(updated); results.push({ artifactId: operation.artifactId, kind: operation.kind });
              continue;
            }
            const keepCount = Math.max(1, Math.min(50, Math.floor(operation.keepCount || MAX_VERSIONS_PER_ARTIFACT)));
            const currentIndex = current.versions.findIndex((version) => version.id === current.currentVersionId);
            const retained = current.versions.slice(Math.max(0, current.versions.length - keepCount));
            if (currentIndex < 0 || !retained.some((version) => version.id === current.currentVersionId)) { results.push({ artifactId: operation.artifactId, kind: operation.kind, error: '版本上限会删除当前版本' }); continue; }
            const updated = { ...current, versions: retained, updatedAt: now };
            nextItems = nextItems.map((item) => item.id === current.id ? updated : item); changed.push(updated); results.push({ artifactId: operation.artifactId, kind: operation.kind });
          }
          return { items: nextItems };
        });
        for (const item of changed) { scheduleArtifactCloudPush(chatId, [item.id]); scheduleArtifactLocalWorkspaceWrite(chatId, [item]); }
        return { artifacts: changed, results };
      },
      saveHtmlInteractionState: ({ artifactId, baseVersionId, interactionState, timestamp }) => {
        const now = timestamp || Date.now();
        const previous = get().items.find((item) => item.id === artifactId) || null;
        set((state) => ({
          items: state.items.map((artifact) => {
            if (artifact.id !== artifactId || artifact.kind !== 'html' || artifact.deletedAt != null) return artifact;
            const current = currentArtifactVersion(artifact);
            if (!current) return artifact;
            if (current.stage === 'autosave') {
              if (current.baseVersionId !== baseVersionId) return artifact;
              const updatedVersion: AssistantArtifactVersion = {
                ...current,
                interactionState,
                updatedAt: now,
                revision: (current.revision || 1) + 1,
              };
              return {
                ...artifact,
                versions: artifact.versions.map((version) => version.id === current.id ? updatedVersion : version),
                updatedAt: now,
              };
            }
            const baseVersion = artifact.versions.find((version) => version.id === baseVersionId);
            if (!baseVersion || current.id !== baseVersionId) return artifact;
            const autosave = htmlInteractionVersion({ artifact, baseVersion, interactionState, stage: 'autosave', timestamp: now });
            return {
              ...artifact,
              currentVersionId: autosave.id,
              versions: [...artifact.versions, autosave].slice(-MAX_VERSIONS_PER_ARTIFACT),
              updatedAt: now,
            };
          }),
        }));
        const persisted = get().items.find((item) => item.id === artifactId) || null;
        if (!persisted || persisted === previous) return null;
        if (persisted) scheduleHtmlAutosaveCloudPush(persisted.chatId, persisted.id);
        return persisted;
      },
      submitHtmlInteraction: ({ artifactId, baseVersionId, interactionState, submissionId, timestamp }) => {
        const now = timestamp || Date.now();
        const previous = get().items.find((item) => item.id === artifactId) || null;
        set((state) => ({
          items: state.items.map((artifact) => {
            if (artifact.id !== artifactId || artifact.kind !== 'html' || artifact.deletedAt != null) return artifact;
            const current = currentArtifactVersion(artifact);
            if (!current) return artifact;
            if (current.submissionId === submissionId && current.stage === 'submitted') {
              return artifact;
            }
            if (current.stage === 'autosave' && current.baseVersionId === baseVersionId) {
              const submitted: AssistantArtifactVersion = {
                ...current,
                stage: 'submitted',
                interactionState,
                submissionId,
                submittedAt: now,
                updatedAt: now,
                revision: (current.revision || 1) + 1,
              };
              return {
                ...artifact,
                versions: artifact.versions.map((version) => version.id === current.id ? submitted : version),
                updatedAt: now,
              };
            }
            if (current.id !== baseVersionId) return artifact;
            const submitted = htmlInteractionVersion({ artifact, baseVersion: current, interactionState, stage: 'submitted', timestamp: now, submissionId });
            return {
              ...artifact,
              currentVersionId: submitted.id,
              versions: [...artifact.versions, submitted].slice(-MAX_VERSIONS_PER_ARTIFACT),
              updatedAt: now,
            };
          }),
        }));
        const persisted = get().items.find((item) => item.id === artifactId) || null;
        if (!persisted || persisted === previous) return null;
        if (persisted) {
          clearHtmlAutosaveCloudPush(persisted.chatId, persisted.id);
          scheduleArtifactCloudPush(persisted.chatId, [persisted.id]);
        }
        return persisted;
      },

      getArtifactsForChat: (chatId) => orderedChatArtifacts(get().items, chatId),

      refreshArtifactsFromCloud: async (chatId) => {
        if (!shouldSyncAssistantArtifactsToCloud()) return;
        const scope = assistantArtifactSyncScope(chatId);
        await assistantArtifactSyncScopes.run(scope, async () => {
          try {
            await refreshArtifactsViaSyncChanges(chatId);
          } catch (error) {
            assistantArtifactSyncScopes.markError(scope, error);
            await refreshArtifactsViaLegacyEndpoint(chatId);
          }
        }, { markCheckedOnSuccess: false });
      },

      pushArtifactsToCloud: async (chatId, artifactIds) => {
        if (!shouldSyncAssistantArtifactsToCloud()) return;
        const items = artifactIds
          ? get().items.filter((item) => item.chatId === chatId && artifactIds.includes(item.id))
          : orderedChatArtifacts(get().items, chatId);
        if (!items.length) return;
        if (items.length === 1) {
          const result = await api.upsertAssistantArtifact(artifactPayloadForCloud(items[0]));
          mergeCloudArtifacts([result.item]);
          return;
        }
        const result = await api.upsertAssistantArtifacts(chatId, items.map(artifactPayloadForCloud));
        mergeCloudArtifacts(result.items);
      },

      createImageArtifactFromAttachment: ({ chatId, message, attachment, timestamp }) => {
        if (attachment.kind !== 'image' || attachment.status !== 'ready' || !attachment.assetId) return null;
        const now = timestamp || Date.now();
        const requestedTarget = attachment.targetArtifactId
          ? get().items.find((item) => item.id === attachment.targetArtifactId && item.chatId === chatId && item.kind === 'image' && item.deletedAt == null)
          : null;
        const artifactId = requestedTarget?.id || `assistant-image-artifact-${message.id}-${attachment.id}`;
        const existing = get().items.find((item) => item.id === artifactId && item.chatId === chatId) || null;
        const currentVersion = existing?.versions.find((version) => version.id === existing.currentVersionId) || existing?.versions.at(-1);
        const currentMedia = currentVersion?.media?.[0];
        if (existing && currentMedia && (
          (attachment.assetId && currentMedia.assetId === attachment.assetId)
          || (attachment.checksum && currentMedia.checksum === attachment.checksum)
        )) {
          return existing;
        }
        const versionId = createVersionId(artifactId, now);
        const media = [{
          assetId: attachment.assetId,
          thumbnailAssetId: attachment.thumbnailAssetId,
          url: attachment.url,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          width: attachment.width,
          height: attachment.height,
          checksum: attachment.checksum,
          alt: attachment.altText,
        }];
        const content = JSON.stringify({ media, promptText: attachment.promptText || '', alt: attachment.altText || '' }, null, 2);
        const imageVersion = {
          id: versionId,
          artifactId,
          content,
          media,
          language: 'json',
          sourceMessageId: message.id,
          baseVersionId: existing?.currentVersionId || null,
          changeSummary: existing ? '根据对话生成新图片版本' : '创建图片产物',
          createdAt: now,
        };
        const item: AssistantArtifactItem = existing ? {
          ...existing,
          title: attachment.altText || existing.title || '图片产物',
          summary: attachment.promptText || existing.summary,
          currentVersionId: versionId,
          versions: [...existing.versions, imageVersion].slice(-MAX_VERSIONS_PER_ARTIFACT),
          sourceMessageId: message.id,
          updatedAt: now,
          deletedAt: null,
        } : {
          id: artifactId,
          chatId,
          kind: 'image',
          title: attachment.altText || '图片产物',
          summary: attachment.promptText || undefined,
          language: 'json',
          currentVersionId: versionId,
          versions: [imageVersion],
          sourceMessageId: message.id,
          createdAt: now,
          updatedAt: now,
          sortOrder: now,
          deletedAt: null,
        };
        set((state) => ({
          items: existing
            ? state.items.map((entry) => entry.id === item.id ? item : entry)
            : [item, ...state.items],
        }));
        scheduleArtifactCloudPush(chatId, [item.id]);
        scheduleArtifactLocalWorkspaceWrite(chatId, [item]);
        return item;
      },

      moveArtifact: (chatId, artifactId, direction) => {
        set((state) => {
          const ordered = orderedChatArtifacts(state.items, chatId);
          const currentIndex = ordered.findIndex((item) => item.id === artifactId);
          const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
          if (currentIndex < 0 || targetIndex < 0 || targetIndex >= ordered.length) return state;
          const nextOrdered = [...ordered];
          const [moved] = nextOrdered.splice(currentIndex, 1);
          if (!moved) return state;
          nextOrdered.splice(targetIndex, 0, moved);
          const nextOrderById = new Map(nextOrdered.map((item, index) => [item.id, index + 1]));
          return {
            items: state.items.map((item) => (
              item.chatId === chatId && nextOrderById.has(item.id)
                ? { ...item, sortOrder: nextOrderById.get(item.id), updatedAt: Date.now() }
                : item
            )),
          };
        });
        scheduleArtifactCloudPush(chatId, [artifactId]);
      },

      deleteArtifact: (artifactId) => {
        const now = Date.now();
        const target = get().items.find((item) => item.id === artifactId);
        set((state) => ({
          items: state.items.map((item) => item.id === artifactId ? { ...item, deletedAt: now, updatedAt: now } : item),
        }));
        if (target) scheduleArtifactCloudPush(target.chatId, [artifactId]);
        if (target) scheduleArtifactLocalWorkspaceDelete(target.chatId, [artifactId]);
      },
    }),
    {
      name: scopedStorageKey('assistant-artifacts'),
      storage: createScopedIndexedDbBufferedJsonStorage<AssistantArtifactSnapshot>({
        getScopedKey: getAssistantArtifactStorageKey,
        storageName: scopedStorageKey('assistant-artifacts'),
        flushDelayMs: 120,
      }),
      partialize: (state) => ({ items: state.items }),
      onRehydrateStorage: () => () => {
        flushBufferedPersistenceWrites();
      },
    },
  ),
);

export function getAssistantArtifactCurrentContent(item: AssistantArtifactItem) {
  const fallbackVersion = item.versions.length ? item.versions[item.versions.length - 1] : null;
  const version = item.versions.find((entry) => entry.id === item.currentVersionId) || fallbackVersion;
  if (!version) return '';
  if (version.files?.length) {
    return version.files
      .map((file) => `// ${file.path}\n${file.content}`)
      .join('\n\n');
  }
  return version.content || '';
}

export function ensureAssistantArtifactStoreHydrated() {
  if (useAssistantArtifactStore.persist.hasHydrated()) return Promise.resolve();
  assistantArtifactHydrationPromise ??= Promise.resolve(useAssistantArtifactStore.persist.rehydrate()).finally(() => {
    assistantArtifactHydrationPromise = null;
  });
  return assistantArtifactHydrationPromise;
}
