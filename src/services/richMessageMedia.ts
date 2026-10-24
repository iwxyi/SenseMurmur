import type { AICharacter } from '../types/character';
import type { Message, MessageAttachment, MessageAttachmentKind, MessageMetadata } from '../types/message';
import { isAIProfileUsable, type AIModelProfile } from '../types/settings';
import { api } from './api';
import { workspaceFetch as fetch } from './workspaceLifecycle';
import { generateImageWithAdapter, synthesizeSpeechWithAdapter } from './aiGenerationAdapter';
import { readAuthSnapshot } from './authSnapshot';
import { logRecoverableError, reportRecoverableError } from './diagnostics';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { synthesizeSpeech, usesManagedSpeechProfile } from './speech';
import { useAuthStore } from '../stores/useAuthStore';

function findProfile(profiles: AIModelProfile[], id?: string | null) {
  const profile = id ? profiles.find((item) => item.id === id) : null;
  return isAIProfileUsable(profile) ? profile : null;
}

function findGenerationProfile(profiles: AIModelProfile[], type: 'image' | 'audio', id?: string | null) {
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

type GenerativeAttachmentKind = Extract<MessageAttachmentKind, 'image' | 'audio' | 'sticker'>;
type GenerativeAttachment = MessageAttachment & { kind: GenerativeAttachmentKind };

function isGenerativeAttachment(attachment: MessageAttachment): attachment is GenerativeAttachment {
  return attachment.kind === 'image' || attachment.kind === 'audio' || attachment.kind === 'sticker';
}

function toMediaGenerationErrorText(error: unknown, kind: GenerativeAttachmentKind) {
  if (isAbortError(error)) {
    if (kind === 'audio') return '语音生成超时，请稍后重试。';
    if (kind === 'sticker') return '表情包搜索超时，请稍后重试。';
    return '图片生成超时，请稍后重试。';
  }
  if (error instanceof Error) return error.message;
  if (kind === 'audio') return String(error || '语音生成失败');
  if (kind === 'sticker') return String(error || '表情包搜索失败');
  return String(error || '图片生成失败');
}

const latestRichMediaMessageById = new Map<string, Message>();
const richMediaMessageUsers = new Map<string, number>();
type RichMediaQueueEntryStatus = 'queued' | 'generating';
export type RichMediaQueueSnapshotEntry = {
  messageId: string;
  attachmentId: string;
  kind: GenerativeAttachmentKind;
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
};

const pendingRichMediaQueue: RichMediaQueueEntry[] = [];
const activeRichMediaQueueEntriesById = new Map<string, RichMediaQueueEntry>();
const richMediaQueueListeners = new Set<() => void>();
let runningRichMediaQueueEntry: RichMediaQueueEntry | null = null;
let richMediaQueueSnapshotCache: RichMediaQueueSnapshotEntry[] = [];
const richMediaGenerationErrors = new Map<string, RichMediaGenerationError>();
const dismissedRichMediaGenerationErrorIds = new Set<string>();

function rememberRichMediaMessage(message: Message) {
  latestRichMediaMessageById.set(message.id, message);
}

function getLatestRichMediaMessage(messageId: string, fallback: Message) {
  return latestRichMediaMessageById.get(messageId) || fallback;
}

function richMediaQueueEntryId(messageId: string, attachmentId: string) {
  return `${messageId}:${attachmentId}`;
}

function isRecoverableGenerativeAttachment(item: MessageAttachment): item is GenerativeAttachment {
  return isGenerativeAttachment(item) && (item.status === 'queued' || item.status === 'generating');
}

function buildRichMediaQueueSnapshot(): RichMediaQueueSnapshotEntry[] {
  const entries = [
    ...(runningRichMediaQueueEntry ? [runningRichMediaQueueEntry] : []),
    ...pendingRichMediaQueue,
  ];
  return entries.map((entry, index) => ({
    messageId: entry.messageId,
    attachmentId: entry.attachmentId,
    kind: entry.kind,
    status: entry.status,
    position: index + 1,
    total: entries.length,
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
  runningRichMediaQueueEntry = null;
  richMediaQueueSnapshotCache = [];
  latestRichMediaMessageById.clear();
  richMediaMessageUsers.clear();
  richMediaGenerationErrors.clear();
  dismissedRichMediaGenerationErrorIds.clear();
  publishRichMediaQueueSnapshot();
}

function updateRichMediaMessage(params: {
  message: Message;
  attachmentId: string;
  patch: Partial<MessageAttachment>;
  upsertMessage: (message: Message) => void;
}) {
  const nextMetadata = updateAttachment(params.message.metadata, params.attachmentId, params.patch);
  const nextMessage = { ...params.message, metadata: nextMetadata };
  rememberRichMediaMessage(nextMessage);
  params.upsertMessage(nextMessage);
  persistRichMessageMetadata(nextMessage, nextMetadata, 'rich-message-media.persist-metadata', params.attachmentId);
  return nextMessage;
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
  void api.updateMessageMetadata(message.serverId, metadata).catch((error) => {
    logRecoverableError({
      location,
      error,
      extra: { messageId: message.id, serverId: message.serverId, attachmentId },
    });
  });
}

function retryAttachmentMetadata(metadata: MessageMetadata | undefined, attachmentId: string, generationJobId: string): MessageMetadata {
  const attachments = metadata?.attachments || [];
  const target = attachments.find((attachment) => attachment.id === attachmentId);
  if (!target) return metadata || {};
  const retriedAttachment: MessageAttachment = {
    ...target,
    status: 'queued',
    error: undefined,
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
  params.upsertMessage(nextMessage);
  persistRichMessageMetadata(nextMessage, metadata, 'rich-message-media.persist-assistant-artifact');
  return nextMessage;
}

async function runRichMediaQueueEntry(entry: RichMediaQueueEntry) {
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
  let workingMessage: Message = updateRichMediaMessage({
    message: currentMessage,
    attachmentId: attachment.id,
    patch: {
      status: 'generating',
      generationJobId,
    },
    upsertMessage: entry.upsertMessage,
  });

  try {
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
        aiUsage: {
          type: 'image_generation',
          label: '聊天图片生成',
          scope: 'chat',
          resourceId: workingMessage.chatId,
        },
      });
      const first = images[0];
      if (!first?.dataUrl) throw new Error('图片生成失败');
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
          });
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

    const profile = findGenerationProfile(entry.aiProfiles, 'audio', entry.character?.modelProfileIds?.tts || entry.character?.modelProfileIds?.audio);
    if (!profile) throw new Error('语音模型未配置');
    const voice = attachment.ttsVoice || entry.character?.voiceConfig?.voiceName || profile.model;
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
        })
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
    const latestAttachment = getLatestRichMediaMessage(messageId, workingMessage).metadata?.attachments?.find((item) => item.id === attachment.id);
    if (latestAttachment?.generationJobId !== generationJobId) return;
    reportRecoverableError({
      location: 'rich-message-media.process',
      error,
      userMessage: attachment.kind === 'image' ? '图片生成失败。' : '语音生成失败。',
      extra: {
        messageId: workingMessage.id,
        attachmentId: attachment.id,
        attachmentKind: attachment.kind,
        senderId: workingMessage.senderId,
      },
    });
    const errorText = toMediaGenerationErrorText(error, attachment.kind);
    richMediaGenerationErrors.set(entry.id, {
      id: entry.id,
      title: attachment.kind === 'image' ? '聊天图片生成' : '聊天语音生成',
      message: errorText,
      createdAt: Date.now(),
    });
    publishRichMediaQueueSnapshot();
    updateRichMediaMessage({
      message: workingMessage,
      attachmentId: attachment.id,
      patch: {
        status: 'failed',
        error: errorText,
        generationJobId,
      },
      upsertMessage: entry.upsertMessage,
    });
  }
}

function pumpRichMediaQueue() {
  if (runningRichMediaQueueEntry) return;
  const entry = pendingRichMediaQueue.shift();
  if (!entry) {
    publishRichMediaQueueSnapshot();
    return;
  }
  runningRichMediaQueueEntry = entry;
  entry.status = 'generating';
  publishRichMediaQueueSnapshot();
  void runRichMediaQueueEntry(entry)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      activeRichMediaQueueEntriesById.delete(entry.id);
      runningRichMediaQueueEntry = null;
      publishRichMediaQueueSnapshot();
      pumpRichMediaQueue();
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
}) {
  const id = richMediaQueueEntryId(params.message.id, params.attachment.id);
  const existing = activeRichMediaQueueEntriesById.get(id);
  if (existing) return existing.promise;

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
    status: 'queued',
    message: params.message,
    character: params.character,
    characters: params.characters,
    messages: params.messages,
    aiProfiles: params.aiProfiles,
    upsertMessage: params.upsertMessage,
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
    })));
  } finally {
    // Concurrent retries/attachments share the latest message only while in use.
    // Finished jobs must not retain message bodies or generated data URLs.
    const users = (richMediaMessageUsers.get(messageId) || 1) - 1;
    if (users) richMediaMessageUsers.set(messageId, users);
    else {
      richMediaMessageUsers.delete(messageId);
      latestRichMediaMessageById.delete(messageId);
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
  if (!target || (target.status !== 'failed' && target.status !== 'queued' && target.status !== 'generating' && !(target.status === 'ready' && !target.url))) return;
  const generationJobId = createGenerationJobId();
  const retryMetadata = retryAttachmentMetadata(params.message.metadata, params.attachmentId, generationJobId);
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
  await api.updateMessageMetadata(params.cloudMessage.serverId || params.cloudMessage.id, nextMetadata);
  return nextMetadata;
}
