import type { AICharacter } from '../types/character';
import type { Message, MessageAttachment, MessageAttachmentKind, MessageMetadata } from '../types/message';
import { isAIProfileUsable, type AIModelProfile } from '../types/settings';
import { api, ApiError } from './api';
import { workspaceFetch as fetch } from './workspaceLifecycle';
import { generateAudioWithAdapter, generateImageWithAdapter, generateVideoWithAdapter, synthesizeSpeechWithAdapter } from './aiGenerationAdapter';
import { waitForAiMediaTask } from './aiClient';
import { readAuthSnapshot } from './authSnapshot';
import { logRecoverableError, reportRecoverableError } from './diagnostics';
import { redactAiDiagnosticValue } from './aiDiagnosticText';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { synthesizeSpeech, usesManagedSpeechProfile } from './speech';
import { useAuthStore } from '../stores/useAuthStore';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { conversationExecutionLockName } from './conversationExecutionLock';
import { assertChatExecutionLease, runWithChatExecutionLeaseWhenAvailable } from './chatExecutionLease';
import { getChatExecutionFence } from './chatExecutionFence';
import { currentWorkflowScope } from './workflowRunRuntime';
import { getWorkspaceSignal } from './workspaceLifecycle';
import { mergeMessages } from '../stores/messageStoreMerge';

function findProfile(profiles: AIModelProfile[], id?: string | null) {
  const profile = id ? profiles.find((item) => item.id === id) : null;
  return isAIProfileUsable(profile) ? profile : null;
}

function findGenerationProfile(profiles: AIModelProfile[], type: 'image' | 'audio' | 'video', id?: string | null) {
  const profile = findProfile(profiles, id)
    || (type === 'audio' ? profiles.find((item) => item.type === 'tts' && item.isDefault && isAIProfileUsable(item)) : null)
    || profiles.find((item) => item.type === type && item.isDefault && isAIProfileUsable(item))
    || (type === 'audio' ? profiles.find((item) => item.type === 'tts' && isAIProfileUsable(item)) : null)
    || profiles.find((item) => item.type === type && isAIProfileUsable(item));
  return isAIProfileUsable(profile) ? profile : null;
}

/**
 * Derive a per-message delivery mood for formal AI audio attachments.
 * The character's voice id never changes; this is only a transient expression
 * overlay. Manual playback intentionally does not call this helper.
 */
function deriveActiveVoiceEmotion(character: AICharacter | null | undefined, text: string, messages: Message[] = [], currentMessageId?: string) {
  const state = character?.emotionalState;
  const latestOtherMessage = [...messages].reverse().find((message) => (
    message.id !== currentMessageId && !message.isDeleted && (message.type === 'user' || message.type === 'ai') && message.senderId !== character?.id
  ));
  const relation = latestOtherMessage && character
    ? character.relationships.find((item) => item.characterId === latestOtherMessage.senderId)
    : undefined;
  const scores: Array<{ score: number; label: string }> = [
    { score: state?.irritation || 0, label: '紧绷、略带不耐烦' },
    { score: state?.excitement || 0, label: '兴奋、明亮、有活力' },
    { score: (state?.affection || 0) + Math.max(0, relation?.warmth || 0) * 0.35, label: '温柔、亲近、带关怀' },
    { score: state?.embarrassment || 0, label: '害羞、轻微犹豫' },
    { score: (state?.insecurity || 0) + Math.max(0, relation?.threat || 0) * 0.3, label: '谨慎、略带不安' },
  ].sort((a, b) => b.score - a.score);
  const strongest = scores[0];
  const relationCue = relation
    ? relation.warmth >= 45 && relation.trust >= 35
      ? '对对方更放松、更愿意亲近'
      : relation.threat >= 35 || relation.trust <= -25
        ? '对对方保持克制和防备'
        : ''
    : '';
  if ((!strongest || strongest.score < 35) && !relationCue) return undefined;
  const punctuation = /[!?！？]/.test(text) ? '语气随标点自然加强，不要夸张表演。' : '保持自然口语停连。';
  return [strongest && strongest.score >= 35 ? strongest.label : '', relationCue, punctuation].filter(Boolean).join('；');
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

async function ensureDataUrl(value: string) {
  if (value.startsWith('data:')) return value;
  const response = await fetch(value);
  const blob = await response.blob();
  return blobToDataUrl(blob);
}

async function getAudioDurationMs(dataUrl: string) {
  if (typeof Audio === 'undefined') return undefined;
  return await new Promise<number | undefined>((resolve) => {
    const audio = new Audio();
    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const durationMs = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : undefined;
      cleanup();
      resolve(durationMs);
    };
    audio.onerror = () => {
      cleanup();
      resolve(undefined);
    };
    audio.src = dataUrl;
  });
}

function createGenerationJobId() {
  return `media-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
}

type GenerativeAttachmentKind = Extract<MessageAttachmentKind, 'image' | 'audio' | 'video' | 'sticker'>;
type RichMediaQueueLane = 'image' | 'audio' | 'video' | 'sticker';
type GenerativeAttachment = MessageAttachment & { kind: GenerativeAttachmentKind };

function isGenerativeAttachment(attachment: MessageAttachment): attachment is GenerativeAttachment {
  return attachment.kind === 'image' || attachment.kind === 'audio' || attachment.kind === 'video' || attachment.kind === 'sticker';
}

function toMediaGenerationErrorText(error: unknown, kind: GenerativeAttachmentKind) {
  if (isAbortError(error)) {
    if (kind === 'audio') return '语音生成超时，请稍后重试。';
    if (kind === 'sticker') return '表情包搜索超时，请稍后重试。';
    if (kind === 'video') return '视频生成超时，请稍后重试。';
    return '图片生成超时，请稍后重试。';
  }
  if (error instanceof Error) return error.message;
  if (kind === 'audio') return String(error || '语音生成失败');
  if (kind === 'sticker') return String(error || '表情包搜索失败');
  if (kind === 'video') return String(error || '视频生成失败');
  return String(error || '图片生成失败');
}

function shouldKeepSubmittedMediaPending(error: unknown, terminalTaskKnown = false) {
  if (terminalTaskKnown) return false;
  if (isAbortError(error)) return true;
  if (error instanceof ApiError) return ![400, 404, 422].includes(error.status || 0);
  if (!(error instanceof Error)) return true;
  return !/(已生成，但文件获取或保存失败|ACE 任务生成失败|视频生成失败，服务端未返回可展示的失败原因|音乐生成失败，服务端未返回可展示的失败原因)/.test(error.message);
}

const latestRichMediaMessageById = new Map<string, Message>();
const richMediaMessageUsers = new Map<string, number>();
const richMediaMetadataWritesByMessageId = new Map<string, Promise<void>>();
type RichMediaQueueEntryStatus = 'queued' | 'generating';
export type RichMediaQueueSnapshotEntry = {
  messageId: string;
  attachmentId: string;
  kind: GenerativeAttachmentKind;
  lane: RichMediaQueueLane;
  audioPurpose?: MessageAttachment['audioPurpose'];
  status: RichMediaQueueEntryStatus;
  position: number;
  total: number;
};

export interface RichMediaGenerationError {
  id: string;
  title: string;
  message: string;
  createdAt: number;
}

type RichMediaQueueEntry = {
  id: string;
  messageId: string;
  attachmentId: string;
  kind: GenerativeAttachmentKind;
  lane: RichMediaQueueLane;
  status: RichMediaQueueEntryStatus;
  message: Message;
  character?: AICharacter | null;
  characters?: AICharacter[];
  messages?: Message[];
  aiProfiles: AIModelProfile[];
  upsertMessage: (message: Message) => void;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  taskId?: string;
  generationJobId?: string;
  sharesConversationLease?: boolean;
  executionSignal?: AbortSignal;
  terminalTaskKnown?: boolean;
};

const pendingRichMediaQueue: RichMediaQueueEntry[] = [];
const activeRichMediaQueueEntriesById = new Map<string, RichMediaQueueEntry>();
const longRunningRichMediaEntriesById = new Map<string, RichMediaQueueEntry>();
const richMediaQueueListeners = new Set<() => void>();
const runningRichMediaQueueEntries = new Map<RichMediaQueueLane, RichMediaQueueEntry>();
let richMediaQueueSnapshotCache: RichMediaQueueSnapshotEntry[] = [];
const richMediaGenerationErrors = new Map<string, RichMediaGenerationError>();
const dismissedRichMediaGenerationErrorIds = new Set<string>();

function rememberRichMediaMessage(message: Message) {
  const previous = latestRichMediaMessageById.get(message.id);
  const merged = previous ? mergeMessages([previous], [message])[0] : message;
  latestRichMediaMessageById.set(message.id, merged);
  return merged;
}

function getLatestRichMediaMessage(messageId: string, fallback: Message) {
  return latestRichMediaMessageById.get(messageId) || fallback;
}

function releaseRichMediaMessageIfIdle(messageId: string) {
  if (richMediaMessageUsers.has(messageId)) return;
  if ([...longRunningRichMediaEntriesById.values()].some((entry) => entry.messageId === messageId)) return;
  latestRichMediaMessageById.delete(messageId);
}

function richMediaQueueEntryId(messageId: string, attachmentId: string) {
  return `${messageId}:${attachmentId}`;
}

function richMediaQueueLane(attachment: GenerativeAttachment): RichMediaQueueLane {
  return attachment.kind;
}

function isRecoverableGenerativeAttachment(item: MessageAttachment): item is GenerativeAttachment {
  return isGenerativeAttachment(item) && (item.status === 'queued' || item.status === 'generating');
}

function buildRichMediaQueueSnapshot(): RichMediaQueueSnapshotEntry[] {
  const entries = [
    ...runningRichMediaQueueEntries.values(),
    ...longRunningRichMediaEntriesById.values(),
    ...pendingRichMediaQueue,
  ].filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
  return entries.map((entry, index) => ({
    messageId: entry.messageId,
    attachmentId: entry.attachmentId,
    kind: entry.kind,
    lane: entry.lane,
    audioPurpose: entry.message.metadata?.attachments?.find((attachment) => attachment.id === entry.attachmentId)?.audioPurpose,
    status: entry.status,
    position: entries.slice(0, index + 1).filter((candidate) => candidate.lane === entry.lane).length,
    total: entries.filter((candidate) => candidate.lane === entry.lane).length,
  }));
}

function publishRichMediaQueueSnapshot() {
  richMediaQueueSnapshotCache = buildRichMediaQueueSnapshot();
  richMediaQueueListeners.forEach((listener) => listener());
}

export function getRichMediaQueueSnapshot() {
  return richMediaQueueSnapshotCache;
}

export function subscribeRichMediaQueue(listener: () => void) {
  richMediaQueueListeners.add(listener);
  return () => richMediaQueueListeners.delete(listener);
}

export function getRecentRichMediaGenerationErrors() {
  return [...richMediaGenerationErrors.values()]
    .filter((error) => !dismissedRichMediaGenerationErrorIds.has(error.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function dismissRichMediaGenerationError(id: string) {
  dismissedRichMediaGenerationErrorIds.add(id);
  publishRichMediaQueueSnapshot();
}

export function dismissAllRichMediaGenerationErrors() {
  richMediaGenerationErrors.forEach((_, id) => dismissedRichMediaGenerationErrorIds.add(id));
  publishRichMediaQueueSnapshot();
}

export function resetRichMediaQueueForTests() {
  if (!import.meta.env?.MODE?.includes('test')) return;
  pendingRichMediaQueue.splice(0, pendingRichMediaQueue.length);
  activeRichMediaQueueEntriesById.clear();
  longRunningRichMediaEntriesById.clear();
  runningRichMediaQueueEntries.clear();
  richMediaQueueSnapshotCache = [];
  latestRichMediaMessageById.clear();
  richMediaMessageUsers.clear();
  richMediaMetadataWritesByMessageId.clear();
  richMediaGenerationErrors.clear();
  dismissedRichMediaGenerationErrorIds.clear();
  publishRichMediaQueueSnapshot();
}

function updateRichMediaMessage(params: {
  message: Message;
  attachmentId: string;
  patch: Partial<MessageAttachment>;
  upsertMessage: (message: Message) => void;
  persistMetadata?: boolean;
}) {
  const latest = getLatestRichMediaMessage(params.message.id, params.message);
  const nextMetadata = updateAttachment(latest.metadata, params.attachmentId, params.patch);
  const nextMessage = { ...latest, metadata: nextMetadata };
  const mergedMessage = rememberRichMediaMessage(nextMessage);
  params.upsertMessage(mergedMessage);
  if (params.persistMetadata !== false) persistRichMessageMetadata(mergedMessage, mergedMessage.metadata || nextMetadata, 'rich-message-media.persist-metadata', params.attachmentId);
  return mergedMessage;
}

async function persistVideoSubmissionKey(message: Message) {
  if (isLocalOnlyMediaMode()) return;
  if (!message.serverId) throw new Error('云端视频消息尚未同步，不能提交生成任务');
  const serverId = message.serverId;
  const previous = richMediaMetadataWritesByMessageId.get(serverId);
  const pending = (previous || Promise.resolve()).then(() => {
    const current = getLatestRichMediaMessage(message.id, message);
    return api.updateMessageMetadata(serverId, current.metadata, current.chatId).then(() => undefined);
  });
  richMediaMetadataWritesByMessageId.set(serverId, pending);
  try {
    await pending;
  } finally {
    if (richMediaMetadataWritesByMessageId.get(serverId) === pending) richMediaMetadataWritesByMessageId.delete(serverId);
  }
}

function persistRichMessageMetadata(message: Message, metadata: MessageMetadata, location: string, attachmentId?: string) {
  if (isLocalOnlyMediaMode()) return;
  if (!message.serverId) {
    logRecoverableError({
      location: `${location}.missing-server-id`,
      error: new Error('云端消息尚未返回服务端 ID，未发送元数据更新。'),
      extra: { messageId: message.id, attachmentId },
    });
    return;
  }
  const serverId = message.serverId;
  const previous = richMediaMetadataWritesByMessageId.get(serverId);
  const write = () => {
    const current = getLatestRichMediaMessage(message.id, message);
    return api.updateMessageMetadata(serverId, current.metadata || metadata, current.chatId).then(() => undefined).catch((error) => {
    logRecoverableError({
      location,
      error,
      extra: { messageId: message.id, serverId, attachmentId },
    });
    });
  };
  const pending = previous ? previous.then(write) : write();
  richMediaMetadataWritesByMessageId.set(serverId, pending);
  void pending.finally(() => {
    if (richMediaMetadataWritesByMessageId.get(serverId) === pending) richMediaMetadataWritesByMessageId.delete(serverId);
  });
}

function retryAttachmentMetadata(metadata: MessageMetadata | undefined, attachmentId: string, generationJobId: string, reuseMediaTask = false): MessageMetadata {
  const attachments = metadata?.attachments || [];
  const target = attachments.find((attachment) => attachment.id === attachmentId);
  if (!target) return metadata || {};
  const retriedAttachment: MessageAttachment = {
    ...target,
    status: 'queued',
    error: undefined,
    mediaTaskId: reuseMediaTask && (target.kind === 'video' || (target.kind === 'audio' && target.audioPurpose === 'music_generation')) ? target.mediaTaskId : undefined,
    assetId: undefined,
    url: undefined,
    thumbnailAssetId: undefined,
    width: undefined,
    height: undefined,
    sizeBytes: undefined,
    checksum: undefined,
    generationJobId,
    updatedAt: Date.now(),
  };
  const remaining = attachments.filter((attachment) => attachment.id !== attachmentId);
  const activeIndex = remaining.findIndex((attachment) => attachment.status === 'generating' && isGenerativeAttachment(attachment));
  const nextAttachments = activeIndex >= 0
    ? [
        ...remaining.slice(0, activeIndex + 1),
        retriedAttachment,
        ...remaining.slice(activeIndex + 1),
      ]
    : [retriedAttachment, ...remaining];
  return {
    ...(metadata || {}),
    attachments: nextAttachments,
    generation: {
      ...(metadata?.generation || {}),
      status: 'generating',
      updatedAt: Date.now(),
    },
  };
}

export function isLocalOnlyMediaMode() {
  return !isCloudSyncEnabled() || readAuthSnapshot().mode !== 'cloud';
}

function updateAttachment(metadata: MessageMetadata | undefined, attachmentId: string, patch: Partial<MessageAttachment>): MessageMetadata {
  const attachments = (metadata?.attachments || []).map((attachment) => (
    attachment.id === attachmentId ? { ...attachment, ...patch, updatedAt: Date.now() } : attachment
  ));
  const generationStatus = attachments.some((item) => item.status === 'queued' || item.status === 'generating')
    ? 'generating'
    : attachments.some((item) => item.status === 'failed')
      ? 'failed'
      : 'ready';
  return {
    ...(metadata || {}),
    attachments,
    generation: {
      ...(metadata?.generation || {}),
      status: generationStatus,
      updatedAt: Date.now(),
    },
  };
}

function messageImageReferenceMap(messages: Message[]) {
  const refs = new Map<string, { url: string; mimeType?: string; label?: string }>();
  for (const message of messages) {
    if (message.isDeleted) continue;
    for (const attachment of message.metadata?.attachments || []) {
      if (attachment.kind !== 'image' || attachment.status !== 'ready' || !attachment.url) continue;
      const value = {
        url: attachment.url,
        mimeType: attachment.mimeType,
        label: attachment.caption || attachment.altText || '参考图',
      };
      refs.set(`${message.id}:${attachment.id}`, value);
      if (message.serverId) refs.set(`${message.serverId}:${attachment.id}`, value);
      if (message.clientKey) refs.set(`${message.clientKey}:${attachment.id}`, value);
      refs.set(attachment.id, value);
    }
  }
  return refs;
}

function resolveAttachmentReferenceImages(attachment: MessageAttachment, messages: Message[]) {
  const explicit = attachment.referenceImages?.filter((image) => image.url) || [];
  const ids = Array.from(new Set([
    ...(attachment.targetImageIds || []),
    ...(attachment.referenceImageIds || []),
    ...(attachment.styleImageIds || []),
  ].filter(Boolean))).slice(0, 9);
  if (!ids.length) return explicit.length ? explicit : undefined;

  const refs = messageImageReferenceMap(messages);
  const resolved = ids.flatMap((id) => {
    const ref = refs.get(id);
    return ref ? [ref] : [];
  });
  const seen = new Set<string>();
  const merged = [...explicit, ...resolved].filter((image) => {
    if (seen.has(image.url)) return false;
    seen.add(image.url);
    return true;
  }).slice(0, 9);
  return merged.length ? merged : undefined;
}

async function attachAssistantImageArtifact(params: {
  message: Message;
  attachmentId: string;
  upsertMessage: (message: Message) => void;
}) {
  const attachment = params.message.metadata?.attachments?.find((item) => item.id === params.attachmentId);
  if (!attachment || attachment.kind !== 'image' || attachment.status !== 'ready' || !attachment.assetId) return params.message;
  const [{ useChatStore }, { useAssistantArtifactStore }] = await Promise.all([
    import('../stores/useChatStore'),
    import('../stores/useAssistantArtifactStore'),
  ]);
  const chat = useChatStore.getState().chats.find((item) => item.id === params.message.chatId);
  if (chat?.type !== 'assistant') return params.message;
  const capabilities = chat.modeState.assistantCapabilities || {};
  if (!capabilities.agent || !capabilities.artifacts) return params.message;
  const artifact = useAssistantArtifactStore.getState().createImageArtifactFromAttachment({
    chatId: params.message.chatId,
    message: params.message,
    attachment,
    timestamp: Date.now(),
  });
  if (!artifact) return params.message;
  const existingRefs = params.message.metadata?.assistant?.artifacts || [];
  if (existingRefs.some((ref) => ref.id === artifact.id)) return params.message;
  const metadata: MessageMetadata = {
    ...(params.message.metadata || {}),
    attachments: (params.message.metadata?.attachments || []).map((item) => (
      item.id === attachment.id
        ? { ...item, targetArtifactId: artifact.id }
        : item
    )),
    assistant: {
      ...(params.message.metadata?.assistant || {}),
      mode: 'general',
      artifacts: [...existingRefs, { id: artifact.id, kind: artifact.kind, title: artifact.title }],
    },
  };
  const nextMessage = { ...params.message, metadata };
  const mergedMessage = rememberRichMediaMessage(nextMessage);
  params.upsertMessage(mergedMessage);
  persistRichMessageMetadata(mergedMessage, mergedMessage.metadata || metadata, 'rich-message-media.persist-assistant-artifact');
  return mergedMessage;
}

async function pollVideoTask(params: {
  entry: RichMediaQueueEntry;
  message: Message;
  attachment: GenerativeAttachment;
  generationJobId: string;
  taskId: string;
}) {
  const task = await waitForAiMediaTask(params.taskId);
  params.entry.terminalTaskKnown = task.status === 'succeeded' || task.status === 'failed';
  return runWithMediaResultLease(params.message.chatId, params.message.serverId, async (signal) => {
  let latestMessage = getLatestRichMediaMessage(params.entry.messageId, params.message);
  const latestAttachment = latestMessage.metadata?.attachments?.find((item) => item.id === params.attachment.id);
  if (latestAttachment?.generationJobId !== params.generationJobId) return;
  if (task.aspectRatio && task.aspectRatio !== latestAttachment?.aspectRatio) {
    latestMessage = updateRichMediaMessage({ message: latestMessage, attachmentId: params.attachment.id, patch: { aspectRatio: task.aspectRatio }, upsertMessage: params.entry.upsertMessage });
  }
  if (task.status === 'failed') {
    const result = task.result && typeof task.result === 'object' && !Array.isArray(task.result)
      ? task.result as Record<string, unknown> : {};
    console.error('[rich-message-media:video-task-failed]', { result: redactAiDiagnosticValue(task.result) });
    const reason = typeof result.error === 'string' ? result.error.trim() : '';
    const safeSubmissionReason = /^ACE 任务生成失败：ACE 请求失败 \([45]\d\d\)(：ACE 上游可用余额不足)?(，?错误码 [A-Za-z][A-Za-z0-9_.-]{0,63})?(，类型 [A-Za-z][A-Za-z0-9_.-]{0,63})?(，参数 [A-Za-z][A-Za-z0-9_.[\]-]{0,79})?$/.test(reason);
    throw new Error(safeSubmissionReason || /^ACE 任务生成失败：(上游返回 HTTP [45]\d\d(，错误码 [A-Za-z][A-Za-z0-9_.-]{0,63})?(，参数 [A-Za-z][A-Za-z0-9_.[\]-]{0,79})?(，视频输入参数无效)?(，任务已取消)?|错误码 [A-Za-z][A-Za-z0-9_.-]{0,63}(，参数 [A-Za-z][A-Za-z0-9_.[\]-]{0,79})?(，视频输入参数无效)?(，任务已取消)?|任务已取消|上游任务失败，未提供错误码或状态码)$/.test(reason)
      ? reason : '视频生成失败，服务端未返回可展示的失败原因。');
  }
  if (task.status === 'succeeded') {
      let asset: { id?: string; url: string; mimeType: string; sizeBytes?: number; checksum?: string };
      try {
        asset = isLocalOnlyMediaMode()
          ? await api.downloadAiMediaTaskContent(params.taskId).then(async (blob) => ({ id: undefined, url: await blobToDataUrl(blob), mimeType: blob.type || 'video/mp4', sizeBytes: blob.size, checksum: undefined }))
          : await api.createMediaAssetFromAiTask({
            chatId: latestMessage.chatId,
            messageId: latestMessage.serverId || latestMessage.id,
            attachmentId: params.attachment.id,
            taskId: params.taskId,
            description: params.attachment.caption || params.attachment.altText,
            promptText: params.attachment.promptText,
          }, { signal });
      } catch (error) {
        throw new Error(`视频已生成，但文件获取或保存失败：${error instanceof Error ? error.message : '网络请求失败'}`);
      }
      updateRichMediaMessage({
        message: latestMessage,
        attachmentId: params.attachment.id,
        patch: { status: 'ready', error: undefined, mediaTaskId: undefined, assetId: asset.id, url: asset.url, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, checksum: asset.checksum, generationJobId: params.generationJobId },
        upsertMessage: params.entry.upsertMessage,
      });
    return;
  }
  throw new Error('媒体任务未完成');
  });
}

async function pollMusicTask(params: { entry: RichMediaQueueEntry; message: Message; attachment: GenerativeAttachment; generationJobId: string; taskId: string }) {
  const task = await waitForAiMediaTask(params.taskId);
  params.entry.terminalTaskKnown = task.status === 'succeeded' || task.status === 'failed';
  return runWithMediaResultLease(params.message.chatId, params.message.serverId, async (signal) => {
  const latestMessage = getLatestRichMediaMessage(params.entry.messageId, params.message);
  const latestAttachment = latestMessage.metadata?.attachments?.find((item) => item.id === params.attachment.id);
  if (latestAttachment?.generationJobId !== params.generationJobId) return;
  if (task.status === 'failed') {
    const result = task.result && typeof task.result === 'object' && !Array.isArray(task.result) ? task.result as Record<string, unknown> : {};
    const reason = typeof result.error === 'string' ? result.error : '音乐生成失败，服务端未返回可展示的失败原因。';
    throw new Error(reason);
  }
  if (task.status !== 'succeeded') throw new Error('音乐任务未完成');
  let asset: { id?: string; url: string; mimeType: string; sizeBytes?: number; checksum?: string };
  try {
    asset = isLocalOnlyMediaMode()
      ? await api.downloadAiMediaTaskContent(params.taskId, 'audio').then(async (blob) => ({ id: undefined, url: await blobToDataUrl(blob), mimeType: blob.type || 'audio/mpeg', sizeBytes: blob.size, checksum: undefined }))
      : await api.createMediaAssetFromAiTask({ chatId: latestMessage.chatId, messageId: latestMessage.serverId || latestMessage.id,
        attachmentId: params.attachment.id, taskId: params.taskId, kind: 'audio', description: params.attachment.caption || params.attachment.altText,
        promptText: params.attachment.promptText }, { signal });
  } catch (error) {
    throw new Error(`音乐已生成，但文件获取或保存失败：${error instanceof Error ? error.message : '网络请求失败'}`);
  }
  const durationMs = isLocalOnlyMediaMode() && asset.url.startsWith('data:') ? await getAudioDurationMs(asset.url) : undefined;
  updateRichMediaMessage({ message: latestMessage, attachmentId: params.attachment.id,
    patch: { status: 'ready', error: undefined, mediaTaskId: undefined, assetId: asset.id, url: asset.url, mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes, checksum: asset.checksum, durationMs, generationJobId: params.generationJobId }, upsertMessage: params.entry.upsertMessage });
  });
}

async function runWithMediaResultLease<T>(chatId: string, serverMessageId: string | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (isLocalOnlyMediaMode()) return work(getWorkspaceSignal());
  const scope = currentWorkflowScope();
  const signal = getWorkspaceSignal();
  const run = () => runWithChatExecutionLeaseWhenAvailable(chatId, async (leaseSignal) => {
    if (signal.aborted || getWorkspaceSignal() !== signal || currentWorkflowScope() !== scope) {
      throw new Error('账号已切换，媒体结果等待恢复');
    }
    const result = await work(leaseSignal);
    const pending = serverMessageId ? richMediaMetadataWritesByMessageId.get(serverMessageId) : undefined;
    if (pending) await pending;
    return result;
  }, signal);
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return run();
  return navigator.locks.request(conversationExecutionLockName(scope, chatId), run);
}

async function runRichMediaQueueEntry(entry: RichMediaQueueEntry, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason || new DOMException('团队运行已中断', 'AbortError');
  if (entry.sharesConversationLease && !isLocalOnlyMediaMode()) assertChatExecutionLease(entry.message.chatId);
  const messageId = entry.messageId;
  const currentMessage = getLatestRichMediaMessage(messageId, entry.message);
  if (!isLocalOnlyMediaMode() && !currentMessage.serverId) {
    logRecoverableError({
      location: 'rich-message-media.queue.missing-server-id',
      error: new Error('云端富媒体队列未等待服务端消息 ID。'),
      extra: { messageId: currentMessage.id, attachmentId: entry.attachmentId },
    });
    return;
  }
  const attachment = (currentMessage.metadata?.attachments || []).find((item): item is GenerativeAttachment => (
    item.id === entry.attachmentId && isRecoverableGenerativeAttachment(item)
  ));
  if (!attachment) return;

  const generationJobId = attachment.generationJobId || createGenerationJobId();
  if (richMediaGenerationErrors.delete(entry.id)) publishRichMediaQueueSnapshot();
  let workingMessage: Message = updateRichMediaMessage({
    message: currentMessage,
    attachmentId: attachment.id,
    patch: {
      status: 'generating',
      error: undefined,
      generationJobId,
    },
    upsertMessage: entry.upsertMessage,
    persistMetadata: attachment.kind !== 'video',
  });

  try {
    if ((attachment.kind === 'video' || (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation')) && !attachment.mediaTaskId) {
      flushBufferedPersistenceWrites();
      await persistVideoSubmissionKey(workingMessage);
    }
    if (attachment.kind === 'sticker') {
      const result = await api.searchDoutu(attachment.promptText || attachment.altText, { chatId: workingMessage.chatId, messageId: workingMessage.serverId || workingMessage.id });
      const latestAttachment = getLatestRichMediaMessage(messageId, workingMessage).metadata?.attachments?.find((item) => item.id === attachment.id);
      if (latestAttachment?.generationJobId !== generationJobId) return;
      workingMessage = updateRichMediaMessage({ message: workingMessage, attachmentId: attachment.id, patch: {
        status: 'ready', url: result.imageUrl, mimeType: /\.gif(?:$|[?#])/i.test(result.imageUrl) ? 'image/gif' : 'image/*', generationJobId,
      }, upsertMessage: entry.upsertMessage });
      rememberRichMediaMessage(workingMessage);
      return;
    }
    if (attachment.kind === 'image') {
      const profile = findGenerationProfile(entry.aiProfiles, 'image', entry.character?.modelProfileIds?.image);
      if (!profile || !attachment.promptText) throw new Error('图片模型未配置');
      const referenceCharacters = (attachment.referenceCharacterIds || [])
        .map((id) => entry.characters?.find((character) => character.id === id))
        .filter(Boolean) as AICharacter[];
      const visualCharacter = referenceCharacters[0] || entry.character || null;
      const referenceImages = resolveAttachmentReferenceImages(attachment, [
        ...(entry.messages || []),
        currentMessage,
      ]);
      const images = await generateImageWithAdapter({
        profile,
        prompt: attachment.promptText,
        count: 1,
        intent: 'chat-image',
        character: referenceCharacters.length ? null : entry.character,
        characters: referenceCharacters,
        referenceImages,
        aspectRatio: attachment.aspectRatio,
        imageSize: attachment.imageSize,
        allowCharacterReferenceImages: true,
        useCharacterReferenceImages: true,
        negativePrompt: visualCharacter?.visualIdentity?.negativePrompt,
        seed: visualCharacter?.visualIdentity?.seed,
        signal,
        aiUsage: {
          type: 'image_generation',
          workflow: workingMessage.metadata?.workflowUsage,
          label: '聊天图片生成',
          scope: 'chat',
          resourceId: workingMessage.chatId,
        },
      });
      const first = images[0];
      if (!first?.dataUrl) throw new Error('图片服务未返回可用的图片数据，请检查模型响应。');
      const latestAttachment = getLatestRichMediaMessage(messageId, workingMessage).metadata?.attachments?.find((item) => item.id === attachment.id);
      if (latestAttachment?.generationJobId !== generationJobId) return;
      const dataUrl = await ensureDataUrl(first.dataUrl);
      const asset = isLocalOnlyMediaMode()
        ? { id: undefined, url: dataUrl, mimeType: first.mimeType, sizeBytes: dataUrl.length, checksum: undefined }
        : await api.createMediaAsset({
            chatId: workingMessage.chatId,
            messageId: workingMessage.serverId || workingMessage.id,
            attachmentId: attachment.id,
            kind: 'image',
            dataUrl,
            description: attachment.caption || attachment.altText,
            promptText: attachment.promptText,
            sourceType: 'chat-image',
          }, { signal });
      workingMessage = updateRichMediaMessage({
        message: workingMessage,
        attachmentId: attachment.id,
        patch: {
          status: 'ready',
          assetId: asset.id,
          url: asset.url || dataUrl,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          checksum: asset.checksum,
          generationJobId,
        },
        upsertMessage: entry.upsertMessage,
      });
      workingMessage = await attachAssistantImageArtifact({
        message: workingMessage,
        attachmentId: attachment.id,
        upsertMessage: entry.upsertMessage,
      });
      rememberRichMediaMessage(workingMessage);
      return;
    }

    if (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation') {
      let taskId = attachment.mediaTaskId;
      if (!taskId) {
        const clientRequestKey = attachment.generationJobId || generationJobId;
        try {
          const task = await api.getAiMediaTaskByRequestKey(clientRequestKey);
          taskId = task.task_id;
        } catch (lookupError) {
          if (!(lookupError instanceof ApiError) || lookupError.status !== 404) throw lookupError;
          const profile = findGenerationProfile(entry.aiProfiles, 'audio');
          if (!profile) throw new Error('音频模型未配置');
          const task = await generateAudioWithAdapter({ profile, prompt: attachment.promptText || attachment.altText, signal,
            clientRequestKey, aiUsage: { type: 'audio_generation', label: '聊天音乐生成', scope: 'chat', resourceId: workingMessage.chatId, workflow: workingMessage.metadata?.workflowUsage } });
          taskId = task.task_id;
        }
      }
      if (!taskId) throw new Error('音乐任务提交失败：未返回任务 ID');
      workingMessage = updateRichMediaMessage({ message: workingMessage, attachmentId: attachment.id,
        patch: { status: 'generating', mediaTaskId: taskId, generationJobId }, upsertMessage: entry.upsertMessage });
      entry.taskId = taskId;
      entry.generationJobId = generationJobId;
      longRunningRichMediaEntriesById.set(entry.id, entry);
      publishRichMediaQueueSnapshot();
      void pollMusicTask({ entry, message: workingMessage, attachment, generationJobId, taskId }).catch((error) => {
        const latestMessage = getLatestRichMediaMessage(entry.messageId, workingMessage);
        const latest = latestMessage.metadata?.attachments?.find((item) => item.id === attachment.id);
        if (latest?.generationJobId !== generationJobId) return;
        const errorText = toMediaGenerationErrorText(error, 'audio');
        richMediaGenerationErrors.set(entry.id, { id: entry.id, title: '聊天音乐生成', message: errorText, createdAt: Date.now() });
        publishRichMediaQueueSnapshot();
        if (shouldKeepSubmittedMediaPending(error, entry.terminalTaskKnown)) {
          updateRichMediaMessage({ message: latestMessage, attachmentId: attachment.id,
            patch: { status: 'generating', error: errorText, mediaTaskId: taskId, generationJobId },
            upsertMessage: entry.upsertMessage, persistMetadata: false });
          return;
        }
        void runWithMediaResultLease(latestMessage.chatId, latestMessage.serverId, async () => {
          updateRichMediaMessage({ message: latestMessage, attachmentId: attachment.id,
            patch: { status: 'failed', error: errorText, mediaTaskId: taskId, generationJobId }, upsertMessage: entry.upsertMessage });
        }).catch((commitError) => console.error('[rich-message-media:audio-failure-commit]', commitError));
      }).finally(() => {
        if (longRunningRichMediaEntriesById.get(entry.id) === entry) longRunningRichMediaEntriesById.delete(entry.id);
        releaseRichMediaMessageIfIdle(entry.messageId);
        publishRichMediaQueueSnapshot();
      });
      return;
    }

    if (attachment.kind === 'video') {
      const profile = findGenerationProfile(entry.aiProfiles, 'video', entry.character?.modelProfileIds?.video);
      const referenceImages = resolveAttachmentReferenceImages(attachment, [
        ...(entry.messages || []),
        currentMessage,
      ]);
      let taskId = attachment.mediaTaskId;
      if (!taskId) {
        const clientRequestKey = attachment.generationJobId || generationJobId;
        let task: Awaited<ReturnType<typeof generateVideoWithAdapter>>;
        try {
          task = await api.getAiMediaTaskByRequestKey(clientRequestKey);
        } catch (lookupError) {
          if (!(lookupError instanceof ApiError) || lookupError.status !== 404) throw lookupError;
          if (!profile) throw new Error('视频模型未配置');
          if (!attachment.promptText) throw new Error('视频提示词缺失');
          task = await generateVideoWithAdapter({
            profile,
            prompt: attachment.promptText,
            clientRequestKey,
            aspectRatio: attachment.aspectRatio,
            duration: attachment.videoDuration,
            resolution: attachment.videoResolution,
            referenceImages,
            signal,
            aiUsage: { type: 'video_generation', label: '聊天视频生成', scope: 'chat', resourceId: workingMessage.chatId, workflow: workingMessage.metadata?.workflowUsage },
          });
        }
        taskId = task.task_id;
        if (taskId && task.aspectRatio) {
          workingMessage = updateRichMediaMessage({
            message: workingMessage,
            attachmentId: attachment.id,
            patch: { aspectRatio: task.aspectRatio },
            upsertMessage: entry.upsertMessage,
          });
        }
      }
      if (!taskId) throw new Error('视频任务提交失败：未返回任务 ID');
      workingMessage = updateRichMediaMessage({
        message: workingMessage,
        attachmentId: attachment.id,
        patch: { status: 'generating', mediaTaskId: taskId, generationJobId },
        upsertMessage: entry.upsertMessage,
      });
      // The server owns the long-running task. Poll independently so other
      // media kinds can continue through their own queue work.
      entry.taskId = taskId;
      entry.generationJobId = generationJobId;
      longRunningRichMediaEntriesById.set(entry.id, entry);
      publishRichMediaQueueSnapshot();
      void pollVideoTask({ entry, message: workingMessage, attachment, generationJobId, taskId })
        .catch((error) => {
          const latestMessage = getLatestRichMediaMessage(entry.messageId, workingMessage);
          const latestAttachment = latestMessage.metadata?.attachments?.find((item) => item.id === attachment.id);
          if (latestAttachment?.generationJobId !== generationJobId) return;
          const errorText = toMediaGenerationErrorText(error, 'video');
          richMediaGenerationErrors.set(entry.id, { id: entry.id, title: '聊天视频生成', message: errorText, createdAt: Date.now() });
          publishRichMediaQueueSnapshot();
          if (shouldKeepSubmittedMediaPending(error, entry.terminalTaskKnown)) {
            updateRichMediaMessage({ message: latestMessage, attachmentId: attachment.id,
              patch: { status: 'generating', error: errorText, mediaTaskId: taskId, generationJobId },
              upsertMessage: entry.upsertMessage, persistMetadata: false });
            return;
          }
          void runWithMediaResultLease(latestMessage.chatId, latestMessage.serverId, async () => {
            updateRichMediaMessage({ message: latestMessage, attachmentId: attachment.id, patch: { status: 'failed', error: errorText, mediaTaskId: taskId, generationJobId }, upsertMessage: entry.upsertMessage });
          }).catch((commitError) => console.error('[rich-message-media:video-failure-commit]', commitError));
        })
        .finally(() => {
          if (longRunningRichMediaEntriesById.get(entry.id) === entry) {
            longRunningRichMediaEntriesById.delete(entry.id);
          }
          releaseRichMediaMessageIfIdle(entry.messageId);
          publishRichMediaQueueSnapshot();
        });
      return;
    }

    const profile = findGenerationProfile(entry.aiProfiles, 'audio', entry.character?.modelProfileIds?.tts || entry.character?.modelProfileIds?.audio);
    if (!profile) throw new Error('语音模型未配置');
    const voice = attachment.ttsVoice || entry.character?.voiceConfig?.voiceName
      || (profile.provider === 'microsoft' ? profile.model : undefined);
    const speechText = attachment.promptText || workingMessage.content;
    const localOnly = isLocalOnlyMediaMode();
    const voiceStyle = [entry.character?.voiceConfig?.style, entry.character?.voiceConfig?.instructions].filter(Boolean).join('；') || undefined;
    const voiceEmotion = deriveActiveVoiceEmotion(entry.character, speechText, entry.messages || [], workingMessage.id);
    const usesManagedSpeech = usesManagedSpeechProfile(profile);
    const speechResult = !localOnly && usesManagedSpeech
      ? await synthesizeSpeech({
          providerCode: profile.provider.startsWith('managed:') ? profile.provider.slice('managed:'.length) : undefined,
          modelId: profile.model,
          text: speechText,
          voice,
          language: attachment.ttsLanguage,
          speed: attachment.ttsSpeed,
          pitch: attachment.ttsPitch,
          style: attachment.ttsStyle || voiceStyle,
          emotion: voiceEmotion,
          chatId: workingMessage.chatId,
          messageId: workingMessage.serverId || workingMessage.id,
          attachmentId: attachment.id,
          workflowUsage: workingMessage.metadata?.workflowUsage,
        }, { signal })
      : null;
    const latestAttachment = getLatestRichMediaMessage(messageId, workingMessage).metadata?.attachments?.find((item) => item.id === attachment.id);
    if (latestAttachment?.generationJobId !== generationJobId) return;
    const dataUrl = speechResult?.audioDataUrl || await blobToDataUrl((await synthesizeSpeechWithAdapter({
      profile,
      intent: 'chat-audio',
      input: speechText,
      voice,
      format: 'mp3',
      language: attachment.ttsLanguage,
      speed: attachment.ttsSpeed,
      pitch: attachment.ttsPitch,
      style: attachment.ttsStyle,
      signal,
    })).blob);
    const durationMs = await getAudioDurationMs(dataUrl);
    const asset = speechResult?.asset || { id: undefined, url: dataUrl, mimeType: speechResult?.mimeType || 'audio/mpeg', sizeBytes: dataUrl.length, checksum: undefined };
    workingMessage = updateRichMediaMessage({
      message: workingMessage,
      attachmentId: attachment.id,
      patch: {
        status: 'ready',
        assetId: asset.id,
        url: asset.url || dataUrl,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        durationMs,
        generationJobId,
      },
      upsertMessage: entry.upsertMessage,
    });
    rememberRichMediaMessage(workingMessage);
  } catch (error) {
    if (entry.executionSignal?.aborted) return;
    const latestAttachment = getLatestRichMediaMessage(messageId, workingMessage).metadata?.attachments?.find((item) => item.id === attachment.id);
    if (latestAttachment?.generationJobId !== generationJobId) return;
    const uncertainSubmission = isAbortError(error) && !entry.taskId
      && (attachment.kind === 'video' || (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation'));
    reportRecoverableError({
      location: 'rich-message-media.process',
      error,
      userMessage: uncertainSubmission ? '媒体任务结果待核对。' : attachment.kind === 'sticker' ? '表情包搜索失败。' : attachment.kind === 'image' ? '图片生成失败。' : attachment.kind === 'video' ? '视频生成失败。' : '语音生成失败。',
      extra: {
        messageId: workingMessage.id,
        attachmentId: attachment.id,
        attachmentKind: attachment.kind,
        senderId: workingMessage.senderId,
      },
    });
    const errorText = uncertainSubmission
      ? '提交请求已中断，正在核对服务端是否已接收；确认前不会重新生成。'
      : toMediaGenerationErrorText(error, attachment.kind);
    richMediaGenerationErrors.set(entry.id, {
      id: entry.id,
      title: attachment.kind === 'sticker' ? '聊天表情包搜索' : attachment.kind === 'image' ? '聊天图片生成' : attachment.kind === 'video' ? '聊天视频生成' : '聊天语音生成',
      message: errorText,
      createdAt: Date.now(),
    });
    publishRichMediaQueueSnapshot();
    updateRichMediaMessage({
      message: workingMessage,
      attachmentId: attachment.id,
      patch: {
        status: uncertainSubmission ? 'generating' : 'failed',
        error: errorText,
        generationJobId,
      },
      upsertMessage: entry.upsertMessage,
    });
  }
}

function pumpRichMediaQueue() {
  const index = pendingRichMediaQueue.findIndex((item) => !runningRichMediaQueueEntries.has(item.lane));
  if (index < 0) { publishRichMediaQueueSnapshot(); return; }
  const entry = pendingRichMediaQueue.splice(index, 1)[0];
  runningRichMediaQueueEntries.set(entry.lane, entry);
  entry.status = 'generating';
  publishRichMediaQueueSnapshot();
  void runRichMediaQueueEntryWithLease(entry)
    .then(entry.resolve, (error) => {
      const latest = getLatestRichMediaMessage(entry.messageId, entry.message);
      const attachment = latest.metadata?.attachments?.find((item) => item.id === entry.attachmentId);
      if (attachment && isRecoverableGenerativeAttachment(attachment)) {
        const uncertainSubmission = isAbortError(error) && !entry.taskId
          && (attachment.kind === 'video' || (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation'));
        const errorText = uncertainSubmission
          ? '提交请求已中断，正在核对服务端是否已接收；确认前不会重新生成。'
          : toMediaGenerationErrorText(error, attachment.kind);
        richMediaGenerationErrors.set(entry.id, { id: entry.id, title: '媒体生成', message: errorText, createdAt: Date.now() });
        if (!entry.taskId) {
          updateRichMediaMessage({ message: latest, attachmentId: attachment.id,
            patch: { status: uncertainSubmission ? 'generating' : 'failed', error: errorText }, upsertMessage: entry.upsertMessage });
        }
      }
      entry.reject(error);
    })
    .finally(() => {
      activeRichMediaQueueEntriesById.delete(entry.id);
      if (runningRichMediaQueueEntries.get(entry.lane) === entry) runningRichMediaQueueEntries.delete(entry.lane);
      publishRichMediaQueueSnapshot();
      pumpRichMediaQueue();
    });
  pumpRichMediaQueue();
}

async function runRichMediaQueueEntryWithLease(entry: RichMediaQueueEntry) {
  if (isLocalOnlyMediaMode()) return runRichMediaQueueEntry(entry, entry.executionSignal);
  const chatId = entry.message.chatId;
  if (entry.sharesConversationLease) {
    if (!getChatExecutionFence(chatId)) throw new Error('团队媒体任务没有有效的会话运行权，已暂停提交');
    const signal = entry.executionSignal;
    if (!signal || signal.aborted) throw signal?.reason || new DOMException('团队运行已中断', 'AbortError');
    assertChatExecutionLease(chatId);
    await runRichMediaQueueEntry(entry, signal);
    const serverId = entry.message.serverId;
    if (serverId) await richMediaMetadataWritesByMessageId.get(serverId);
    assertChatExecutionLease(chatId);
    if (signal.aborted) throw signal.reason || new DOMException('团队运行已中断', 'AbortError');
    return;
  }
  const scope = currentWorkflowScope();
  const signal = getWorkspaceSignal();
  const run = () => runWithChatExecutionLeaseWhenAvailable(chatId, async (leaseSignal) => {
    if (signal.aborted || getWorkspaceSignal() !== signal || currentWorkflowScope() !== scope) {
      throw new Error('账号已切换，媒体任务已暂停');
    }
    await runRichMediaQueueEntry(entry, leaseSignal);
    const serverId = entry.message.serverId;
    if (serverId) await richMediaMetadataWritesByMessageId.get(serverId);
  }, signal);
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return run();
  return navigator.locks.request(conversationExecutionLockName(scope, chatId), async () => {
    return run();
  });
}

function enqueueRichMediaAttachment(params: {
  message: Message;
  attachment: GenerativeAttachment;
  character?: AICharacter | null;
  characters?: AICharacter[];
  messages?: Message[];
  aiProfiles: AIModelProfile[];
  upsertMessage: (message: Message) => void;
  priority?: 'normal' | 'next';
  sharesConversationLease?: boolean;
  executionSignal?: AbortSignal;
}) {
  const id = richMediaQueueEntryId(params.message.id, params.attachment.id);
  const existing = activeRichMediaQueueEntriesById.get(id);
  if (existing) return existing.promise;
  const polling = longRunningRichMediaEntriesById.get(id);
  if (polling && (
    (params.attachment.mediaTaskId && params.attachment.mediaTaskId === polling.taskId)
    || (params.attachment.generationJobId && params.attachment.generationJobId === polling.generationJobId)
  )) return polling.promise;

  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: RichMediaQueueEntry = {
    id,
    messageId: params.message.id,
    attachmentId: params.attachment.id,
    kind: params.attachment.kind,
    lane: richMediaQueueLane(params.attachment),
    status: 'queued',
    message: params.message,
    character: params.character,
    characters: params.characters,
    messages: params.messages,
    aiProfiles: params.aiProfiles,
    upsertMessage: params.upsertMessage,
    sharesConversationLease: params.sharesConversationLease,
    executionSignal: params.executionSignal,
    promise,
    resolve,
    reject,
  };
  activeRichMediaQueueEntriesById.set(id, entry);
  if (params.priority === 'next') {
    pendingRichMediaQueue.unshift(entry);
  } else {
    pendingRichMediaQueue.push(entry);
  }
  publishRichMediaQueueSnapshot();
  pumpRichMediaQueue();
  return promise;
}

export async function processRichMessageMedia(params: {
  message: Message;
  character?: AICharacter | null;
  characters?: AICharacter[];
  messages?: Message[];
  aiProfiles: AIModelProfile[];
  upsertMessage: (message: Message) => void;
  attachmentIds?: string[];
  priority?: 'normal' | 'next';
  sharesConversationLease?: boolean;
  executionSignal?: AbortSignal;
}) {
  if (!isLocalOnlyMediaMode() && !params.message.serverId) return;
  const attachmentFilter = params.attachmentIds?.length ? new Set(params.attachmentIds) : null;
  const attachments = (params.message.metadata?.attachments || [])
    .filter((item): item is GenerativeAttachment => (
      isRecoverableGenerativeAttachment(item)
      && (!attachmentFilter || attachmentFilter.has(item.id))
    ));
  if (!attachments.length) return;
  const messageId = params.message.id;
  richMediaMessageUsers.set(messageId, (richMediaMessageUsers.get(messageId) || 0) + 1);
  rememberRichMediaMessage(params.message);
  try {
    const imageCount = attachments.filter((attachment) => attachment.kind === 'image').length;
    if (imageCount > 0 && !params.attachmentIds?.length && useAuthStore.getState().authMode === 'cloud') {
      try {
        await api.authorizeImageGenerationBatch(imageCount);
      } catch (error) {
        const message = error instanceof Error && error.message
          ? error.message
          : `本次请求包含 ${imageCount} 张图片，当前会员单次批量生成上限不足。请减少图片数量或升级会员后重试。`;
        let failedMessage = params.message;
        for (const attachment of attachments) {
          if (attachment.kind !== 'image') continue;
          failedMessage = updateRichMediaMessage({
            message: failedMessage,
            attachmentId: attachment.id,
            patch: { status: 'failed', error: message },
            upsertMessage: params.upsertMessage,
          });
        }
        return;
      }
    }
    await Promise.all(attachments.map((attachment) => enqueueRichMediaAttachment({
      message: params.message,
      attachment,
      character: params.character,
      characters: params.characters,
      messages: params.messages,
      aiProfiles: params.aiProfiles,
      upsertMessage: params.upsertMessage,
      priority: params.priority,
      sharesConversationLease: params.sharesConversationLease,
      executionSignal: params.executionSignal,
    })));
  } finally {
    // Polling may continue after submission returns. Retain the merged message
    // until every task on it has committed, then release media data URLs.
    const users = (richMediaMessageUsers.get(messageId) || 1) - 1;
    if (users) richMediaMessageUsers.set(messageId, users);
    else {
      richMediaMessageUsers.delete(messageId);
      releaseRichMediaMessageIfIdle(messageId);
    }
  }
}

export async function retryRichMessageMedia(params: {
  message: Message;
  attachmentId: string;
  character?: AICharacter | null;
  characters?: AICharacter[];
  messages?: Message[];
  aiProfiles: AIModelProfile[];
  upsertMessage: (message: Message) => void;
}): Promise<void> {
  const attachments = params.message.metadata?.attachments || [];
  const target = attachments.find((attachment) => attachment.id === params.attachmentId);
  if (!target || (target.status !== 'failed' && target.status !== 'queued' && target.status !== 'generating' && !(target.status === 'ready' && (!target.url || target.kind === 'sticker')))) return;
  const activePoll = longRunningRichMediaEntriesById.get(richMediaQueueEntryId(params.message.id, params.attachmentId));
  if (activePoll && target.mediaTaskId && activePoll.taskId === target.mediaTaskId) return;
  const isAsyncTask = target.kind === 'video' || (target.kind === 'audio' && target.audioPurpose === 'music_generation');
  if (isAsyncTask && target.status === 'generating' && target.mediaTaskId) {
    await processRichMessageMedia({ ...params, attachmentIds: [params.attachmentId], priority: 'next' });
    return;
  }
  let reuseMediaTask = false;
  if (isAsyncTask && target.mediaTaskId) {
    try { reuseMediaTask = (await api.getAiMediaTask(target.mediaTaskId)).status !== 'failed'; }
    catch { reuseMediaTask = true; }
  }
  if (isAsyncTask && !target.mediaTaskId && target.generationJobId) {
    try {
      const task = await api.getAiMediaTaskByRequestKey(target.generationJobId);
      reuseMediaTask = task.status !== 'failed';
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) reuseMediaTask = true;
    }
  }
  const generationJobId = reuseMediaTask && target.generationJobId ? target.generationJobId : createGenerationJobId();
  const retryMetadata = retryAttachmentMetadata(params.message.metadata, params.attachmentId, generationJobId, reuseMediaTask);
  const retryMessage = { ...params.message, metadata: retryMetadata };
  params.upsertMessage(retryMessage);
  persistRichMessageMetadata(retryMessage, retryMetadata, 'rich-message-media.retry-persist-metadata', params.attachmentId);
  void processRichMessageMedia({
    message: retryMessage,
    character: params.character,
    characters: params.characters,
    messages: params.messages,
    aiProfiles: params.aiProfiles,
    upsertMessage: params.upsertMessage,
    attachmentIds: [params.attachmentId],
    priority: 'next',
  });
}

export function hasLocalDataUrlMedia(message: Message) {
  return Boolean(message.metadata?.attachments?.some((attachment) => attachment.status === 'ready' && typeof attachment.url === 'string' && attachment.url.startsWith('data:')));
}

export function scrubLocalMediaUrlsForCloud(message: Message) {
  if (!message.metadata?.attachments?.length) return message.metadata;
  return {
    ...message.metadata,
    attachments: message.metadata.attachments.map((attachment) => {
      if (attachment.status === 'ready' && typeof attachment.url === 'string' && attachment.url.startsWith('data:')) {
        return {
          ...attachment,
          url: undefined,
          assetId: undefined,
          updatedAt: Date.now(),
        };
      }
      return attachment;
    }),
  };
}

export async function uploadLocalMessageMediaToCloud(params: {
  localMessage: Message;
  cloudMessage: Message;
}) {
  const attachments = params.localMessage.metadata?.attachments || [];
  if (!attachments.length) return params.cloudMessage.metadata;
  let nextMetadata = params.cloudMessage.metadata || scrubLocalMediaUrlsForCloud(params.localMessage);
  for (const attachment of attachments) {
    if (attachment.status !== 'ready' || !attachment.url?.startsWith('data:')) continue;
    const asset = await api.createMediaAsset({
      chatId: params.cloudMessage.chatId,
      messageId: params.cloudMessage.serverId || params.cloudMessage.id,
      attachmentId: attachment.id,
      kind: attachment.kind === 'file' ? 'thumbnail' : attachment.kind,
      dataUrl: attachment.url,
      description: attachment.caption || attachment.altText,
      promptText: attachment.promptText,
      sourceType: `chat-${attachment.kind}`,
    });
    nextMetadata = updateAttachment(nextMetadata, attachment.id, {
      status: 'ready',
      assetId: asset.id,
      url: asset.url,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      checksum: asset.checksum,
    });
  }
  await api.updateMessageMetadata(params.cloudMessage.serverId || params.cloudMessage.id, nextMetadata, params.cloudMessage.chatId);
  return nextMetadata;
}
