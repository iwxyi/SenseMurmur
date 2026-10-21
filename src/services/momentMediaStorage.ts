import { readAuthSnapshot } from './authSnapshot';
import type { AICharacter } from '../types/character';
import { prepareAvatarUploadDataUrl } from '../utils/avatarUpload';
import { api } from './api';
import { isCloudSyncEnabled } from './cloudSyncPreference';

const LOCAL_MOMENT_MEDIA_DB = 'pneumata-moment-media';
const LOCAL_MOMENT_MEDIA_STORE = 'assets';
const LOCAL_MOMENT_MEDIA_PREFIX = 'pneumata-local-moment-media:';
const LOCAL_MOMENT_MEDIA_VERSION = 1;
const MAX_MOMENT_IMAGE_BYTES = 240 * 1024;
const MAX_MOMENT_THUMB_BYTES = 120 * 1024;

export interface StoredMomentMedia {
  assetId?: string;
  thumbnailAssetId?: string;
  url: string;
  thumbnailUrl?: string;
  fullUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  alt?: string;
  storage?: 'cloud_asset' | 'local_indexeddb' | 'inline';
}

interface LocalMomentMediaRecord {
  id: string;
  chatId: string;
  eventId: string;
  dataUrl: string;
  thumbnailDataUrl: string;
  mimeType?: string;
  sizeBytes: number;
  createdAt: number;
  alt?: string;
}

function authMode() {
  return readAuthSnapshot().mode;
}

function isCloudMode() {
  return isCloudSyncEnabled() && authMode() === 'cloud';
}

export function estimateDataUrlBytes(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',');
  const payload = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function getMimeType(dataUrl: string, fallback?: string) {
  return dataUrl.match(/^data:([^;]+);/)?.[1] || fallback;
}

function localMediaUrl(assetId: string, variant: 'thumbnail' | 'full' = 'full') {
  return `${LOCAL_MOMENT_MEDIA_PREFIX}${assetId}${variant === 'thumbnail' ? '#thumbnail' : ''}`;
}

export function isLocalMomentMediaUrl(url?: string) {
  return Boolean(url?.startsWith(LOCAL_MOMENT_MEDIA_PREFIX));
}

function localAssetIdFromUrl(url: string) {
  return url.slice(LOCAL_MOMENT_MEDIA_PREFIX.length).split('#')[0] || '';
}

function isThumbnailUrl(url: string) {
  return url.endsWith('#thumbnail');
}

function openLocalMomentMediaDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(LOCAL_MOMENT_MEDIA_DB, LOCAL_MOMENT_MEDIA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_MOMENT_MEDIA_STORE)) {
        db.createObjectStore(LOCAL_MOMENT_MEDIA_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open local moment media DB'));
  });
}

async function putLocalMomentMedia(record: LocalMomentMediaRecord) {
  const db = await openLocalMomentMediaDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(LOCAL_MOMENT_MEDIA_STORE, 'readwrite');
      transaction.objectStore(LOCAL_MOMENT_MEDIA_STORE).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Failed to save local moment media'));
    });
  } finally {
    db.close();
  }
}

async function getLocalMomentMedia(assetId: string) {
  const db = await openLocalMomentMediaDb();
  try {
    return await new Promise<LocalMomentMediaRecord | undefined>((resolve, reject) => {
      const transaction = db.transaction(LOCAL_MOMENT_MEDIA_STORE, 'readonly');
      const request = transaction.objectStore(LOCAL_MOMENT_MEDIA_STORE).get(assetId);
      request.onsuccess = () => resolve(request.result as LocalMomentMediaRecord | undefined);
      request.onerror = () => reject(request.error || new Error('Failed to read local moment media'));
    });
  } finally {
    db.close();
  }
}

async function compactMomentImage(dataUrl: string, options: { maxSize: number; quality: number; maxBytes: number }) {
  let compact = await prepareAvatarUploadDataUrl(dataUrl, { maxSize: options.maxSize, quality: options.quality });
  if (estimateDataUrlBytes(compact) > options.maxBytes) {
    compact = await prepareAvatarUploadDataUrl(dataUrl, { maxSize: Math.max(240, Math.round(options.maxSize * 0.72)), quality: 0.62 });
  }
  return compact;
}

export async function prepareMomentImageDataUrls(dataUrl: string) {
  const fullDataUrl = await compactMomentImage(dataUrl, {
    maxSize: 720,
    quality: 0.74,
    maxBytes: MAX_MOMENT_IMAGE_BYTES,
  });
  const thumbnailDataUrl = await compactMomentImage(fullDataUrl, {
    maxSize: 320,
    quality: 0.68,
    maxBytes: MAX_MOMENT_THUMB_BYTES,
  });
  return {
    fullDataUrl,
    thumbnailDataUrl,
    mimeType: getMimeType(fullDataUrl),
    sizeBytes: estimateDataUrlBytes(fullDataUrl),
    thumbnailSizeBytes: estimateDataUrlBytes(thumbnailDataUrl),
  };
}

export async function persistGeneratedMomentMedia(params: {
  chatId: string;
  eventId: string;
  actor?: AICharacter | null;
  dataUrl: string;
  mimeType?: string;
  alt?: string;
}) {
  if (!params.dataUrl.startsWith('data:image/')) return null;
  const prepared = await prepareMomentImageDataUrls(params.dataUrl);
  const mimeType = prepared.mimeType || params.mimeType;
  if (isCloudMode()) {
    const [asset, thumbnailAsset] = await Promise.all([
      api.createMediaAsset({
        chatId: params.chatId,
        messageId: `moment-${params.eventId}`,
        attachmentId: `moment-image-${params.eventId}`,
        kind: 'image',
        dataUrl: prepared.fullDataUrl,
      }),
      api.createMediaAsset({
        chatId: params.chatId,
        messageId: `moment-${params.eventId}`,
        attachmentId: `moment-image-${params.eventId}-thumb`,
        kind: 'thumbnail',
        dataUrl: prepared.thumbnailDataUrl,
      }),
    ]);
    return {
      assetId: asset.id,
      thumbnailAssetId: thumbnailAsset.id,
      url: thumbnailAsset.url,
      thumbnailUrl: thumbnailAsset.url,
      fullUrl: asset.url,
      mimeType: asset.mimeType || mimeType,
      sizeBytes: asset.sizeBytes,
      alt: params.alt,
      storage: 'cloud_asset' as const,
    };
  }

  const assetId = `local-moment-${params.eventId}-${Date.now().toString(36)}`;
  await putLocalMomentMedia({
    id: assetId,
    chatId: params.chatId,
    eventId: params.eventId,
    dataUrl: prepared.fullDataUrl,
    thumbnailDataUrl: prepared.thumbnailDataUrl,
    mimeType,
    sizeBytes: prepared.sizeBytes,
    createdAt: Date.now(),
    alt: params.alt,
  });
  return {
    assetId,
    thumbnailAssetId: assetId,
    url: localMediaUrl(assetId),
    thumbnailUrl: localMediaUrl(assetId, 'thumbnail'),
    fullUrl: localMediaUrl(assetId),
    mimeType,
    sizeBytes: prepared.sizeBytes,
    alt: params.alt,
    storage: 'local_indexeddb' as const,
  };
}

export async function resolveMomentMediaUrl(url?: string) {
  if (!url || !isLocalMomentMediaUrl(url)) return url;
  const assetId = localAssetIdFromUrl(url);
  if (!assetId) return undefined;
  const record = await getLocalMomentMedia(assetId);
  if (!record) return undefined;
  return isThumbnailUrl(url) ? record.thumbnailDataUrl || record.dataUrl : record.dataUrl;
}
