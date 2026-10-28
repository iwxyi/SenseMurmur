import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from './authStorageScope';
import { localOutboxRepository, type LocalOutboxRecord } from './localOutboxDb';
import { filterCancelledSyncTasks, syncTaskQueueStorageKey } from './syncTaskCancellation';
import {
  buildLocalOutboxProjection,
  type LocalOutboxArtifactJobLike,
  type LocalOutboxItem,
  type LocalOutboxMessageOperationLike,
  type LocalOutboxPatchOperationLike,
  type LocalOutboxScopeType,
} from './localOutboxProjection';

interface LocalOutboxMirrorRepository {
  replaceSource: (storageKey: string, sourceType: LocalOutboxScopeType, records: LocalOutboxRecord[]) => Promise<void>;
}

export interface MirrorLocalOutboxQueuesInput {
  characterOperations?: LocalOutboxPatchOperationLike[];
  chatOperations?: LocalOutboxPatchOperationLike[];
  messageOperations?: LocalOutboxMessageOperationLike[];
  artifactJobs?: LocalOutboxArtifactJobLike[];
}

export function localOutboxStorageKey(userId = getLocalDataUserId()) {
  return scopedStorageKey(`local-outbox-${userId}`);
}

function toRecord(item: LocalOutboxItem, sourceType: LocalOutboxScopeType, payload: unknown, updatedAt: number): LocalOutboxRecord {
  return {
    ...item,
    sourceType,
    sourceId: item.id,
    updatedAt,
    payload,
  };
}

function buildSourceRecords(
  sourceType: LocalOutboxScopeType,
  payloads: unknown[],
  items: LocalOutboxItem[],
  updatedAt: number,
) {
  const payloadsById = new Map(payloads
    .filter((payload): payload is { id: string } => Boolean(payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string'))
    .map((payload) => [payload.id, payload]));
  return filterCancelledSyncTasks(syncTaskQueueStorageKey(sourceType), items)
    .map((item) => toRecord(item, sourceType, payloadsById.get(item.id) || null, updatedAt));
}

function buildRecordsForSource(
  sourceType: LocalOutboxScopeType,
  input: MirrorLocalOutboxQueuesInput,
  updatedAt: number,
) {
  if (sourceType === 'character') {
    const characterOperations = input.characterOperations || [];
    return buildSourceRecords('character', characterOperations, buildLocalOutboxProjection({ characterOperations }), updatedAt);
  }
  if (sourceType === 'chat') {
    const chatOperations = input.chatOperations || [];
    return buildSourceRecords('chat', chatOperations, buildLocalOutboxProjection({ chatOperations }), updatedAt);
  }
  if (sourceType === 'message') {
    const messageOperations = input.messageOperations || [];
    return buildSourceRecords('message', messageOperations, buildLocalOutboxProjection({ messageOperations }), updatedAt);
  }
  const artifactJobs = input.artifactJobs || [];
  return buildSourceRecords('artifact', artifactJobs, buildLocalOutboxProjection({ artifactJobs }), updatedAt);
}

export async function mirrorLocalOutboxSourceQueue(
  sourceType: LocalOutboxScopeType,
  input: MirrorLocalOutboxQueuesInput,
  options: {
    repository?: LocalOutboxMirrorRepository;
    storageKey?: string;
    now?: number;
  } = {},
) {
  const repository = options.repository || localOutboxRepository;
  const storageKey = options.storageKey || localOutboxStorageKey();
  const updatedAt = options.now ?? Date.now();
  await repository.replaceSource(storageKey, sourceType, buildRecordsForSource(sourceType, input, updatedAt));
}

export async function mirrorLocalOutboxQueues(
  input: MirrorLocalOutboxQueuesInput,
  options: {
    repository?: LocalOutboxMirrorRepository;
    storageKey?: string;
    now?: number;
  } = {},
) {
  const repository = options.repository || localOutboxRepository;
  const storageKey = options.storageKey || localOutboxStorageKey();
  const updatedAt = options.now ?? Date.now();
  const characterOperations = input.characterOperations || [];
  const chatOperations = input.chatOperations || [];
  const messageOperations = input.messageOperations || [];
  const artifactJobs = input.artifactJobs || [];

  await Promise.all([
    repository.replaceSource(
      storageKey,
      'character',
      buildSourceRecords('character', characterOperations, buildLocalOutboxProjection({ characterOperations }), updatedAt),
    ),
    repository.replaceSource(
      storageKey,
      'chat',
      buildSourceRecords('chat', chatOperations, buildLocalOutboxProjection({ chatOperations }), updatedAt),
    ),
    repository.replaceSource(
      storageKey,
      'message',
      buildSourceRecords('message', messageOperations, buildLocalOutboxProjection({ messageOperations }), updatedAt),
    ),
    repository.replaceSource(
      storageKey,
      'artifact',
      buildSourceRecords('artifact', artifactJobs, buildLocalOutboxProjection({ artifactJobs }), updatedAt),
    ),
  ]);
}
