import type { AICharacter, CharacterVisualReferenceImage } from '../types/character';
import type { APIConfig, AIModelProfile } from '../types/settings';
import { normalizeImageCapabilities, normalizeImageGenerationSize, normalizeVideoGenerationDefaults } from '../types/settings';
import { assertMultimediaGenerationPermission, reportMultimediaPermissionError } from './multimediaPermission';
import {
  generateImage,
  generateJsonResponse,
  generateResponse,
  synthesizeSpeech,
  transcribeAudio,
  submitAiMediaTask,
  type AudioTranscriptionOptions,
  type AudioTranscriptionResult,
  type AiUsageMetadata,
  type GeneratedImage,
  type ImageGenerationOptions,
  type SpeechSynthesisOptions,
  type SpeechSynthesisResult,
} from './aiClient';

type ChatRole = 'user' | 'assistant' | 'system';
type ChatMessage = { role: ChatRole; content: string };

export type GenerationIntent =
  | 'chat-text'
  | 'chat-json'
  | 'chat-image'
  | 'chat-audio'
  | 'chat-video'
  | 'character-reference'
  | 'avatar'
  | 'audio-transcription';

export interface ImageReferenceInput {
  url: string;
  mimeType?: string;
  characterId?: string;
  label?: string;
}

export interface ImageGenerationAdapterOptions {
  profile: AIModelProfile;
  prompt: string;
  intent: GenerationIntent;
  count?: number;
  size?: string;
  aspectRatio?: string;
  imageSize?: string;
  negativePrompt?: string;
  seed?: string | number | null;
  referenceImages?: ImageReferenceInput[];
  character?: AICharacter | null;
  characters?: AICharacter[];
  allowCharacterReferenceImages?: boolean;
  useCharacterReferenceImages?: boolean;
  signal?: AbortSignal;
  aiUsage?: AiUsageMetadata;
}

export interface TextGenerationAdapterOptions {
  profile: AIModelProfile | APIConfig;
  systemPrompt: string;
  messages: ChatMessage[];
  onChunk?: (chunk: string) => void;
  maxTokens?: number;
  signal?: AbortSignal;
  aiUsage?: AiUsageMetadata;
}

export interface SpeechGenerationAdapterOptions extends SpeechSynthesisOptions {
  profile: AIModelProfile | APIConfig;
  intent?: GenerationIntent;
}

export interface AudioTranscriptionAdapterOptions extends AudioTranscriptionOptions {
  profile: AIModelProfile | APIConfig;
  intent?: GenerationIntent;
}

export interface VideoGenerationAdapterOptions {
  profile: AIModelProfile;
  prompt: string;
  aspectRatio?: string;
  duration?: number;
  resolution?: string;
  referenceImages?: ImageReferenceInput[];
  signal?: AbortSignal;
  aiUsage?: AiUsageMetadata;
}

function profileToApi(profile: AIModelProfile | APIConfig): APIConfig {
  return {
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
  };
}

function isAIModelProfile(profile: AIModelProfile | APIConfig): profile is AIModelProfile {
  return 'id' in profile && 'type' in profile;
}

function sortReferenceImages(images: CharacterVisualReferenceImage[], primaryId?: string | null) {
  return [...images].sort((a, b) => {
    const aPrimary = a.id === primaryId || a.isPrimary;
    const bPrimary = b.id === primaryId || b.isPrimary;
    if (aPrimary === bPrimary) return (b.createdAt || 0) - (a.createdAt || 0);
    return aPrimary ? -1 : 1;
  });
}

function collectCharacterReferenceImages(params: ImageGenerationAdapterOptions): ImageReferenceInput[] {
  if (!params.allowCharacterReferenceImages) return [];
  const characters = [
    ...(params.character ? [params.character] : []),
    ...(params.characters || []),
  ];
  const uniqueCharacters = Array.from(new Map(characters.map((character) => [character.id, character])).values());
  const references: ImageReferenceInput[] = [];

  for (const character of uniqueCharacters) {
    const visualIdentity = character.visualIdentity;
    if (!visualIdentity?.defaults?.useReferenceImages) continue;
    const images = sortReferenceImages(visualIdentity.referenceImages || [], visualIdentity.primaryReferenceImageId);
    for (const image of images) {
      if (!image.url) continue;
      references.push({
        url: image.url,
        mimeType: image.mimeType,
        characterId: character.id,
        label: image.label || character.name,
      });
    }
  }

  return references;
}

function appendVisualIdentityText(prompt: string, params: ImageGenerationAdapterOptions) {
  const characters = [
    ...(params.character ? [params.character] : []),
    ...(params.characters || []),
  ];
  const uniqueCharacters = Array.from(new Map(characters.map((character) => [character.id, character])).values());
  const hints = uniqueCharacters
    .map((character) => {
      const visual = character.visualIdentity;
      const parts = [
        visual?.description?.trim() ? `${character.name} visual identity: ${visual.description.trim()}` : '',
        visual?.styleHint?.trim() ? `${character.name} visual style: ${visual.styleHint.trim()}` : '',
      ].filter(Boolean);
      return parts.join('\n');
    })
    .filter(Boolean);
  return hints.length ? `${prompt}\n\nCharacter visual anchors:\n${hints.join('\n')}` : prompt;
}

function normalizeReferenceImages(params: ImageGenerationAdapterOptions): ImageReferenceInput[] {
  const requested = [
    ...(params.referenceImages || []),
    ...(params.useCharacterReferenceImages ? collectCharacterReferenceImages(params) : []),
  ].filter((item) => item.url);

  const unique = Array.from(new Map(requested.map((item) => [item.url, item])).values());
  const capabilities = normalizeImageCapabilities(isAIModelProfile(params.profile) ? params.profile.imageCapabilities : undefined);
  if (!capabilities.referenceImage) return [];
  return capabilities.multiReferenceImage ? unique : unique.slice(0, 1);
}

export function resolveImageGenerationRequest(params: ImageGenerationAdapterOptions): ImageGenerationOptions {
  const capabilities = normalizeImageCapabilities(params.profile.imageCapabilities);
  const referenceImages = normalizeReferenceImages(params);
  const canUseReferences = capabilities.referenceImage && referenceImages.length > 0;
  const prompt = canUseReferences ? params.prompt : appendVisualIdentityText(params.prompt, params);

  return {
    prompt,
    count: params.count,
    size: params.size,
    aspectRatio: params.aspectRatio,
    imageSize: params.imageSize || (params.size ? undefined : normalizeImageGenerationSize(params.profile.defaultImageSize)),
    signal: params.signal,
    referenceImages: canUseReferences ? referenceImages.map(({ url, mimeType }) => ({ url, mimeType })) : undefined,
    negativePrompt: capabilities.negativePrompt ? params.negativePrompt : undefined,
    seed: capabilities.seed ? params.seed : undefined,
    aiUsage: params.aiUsage || defaultImageGenerationUsage(params.intent),
  };
}

function defaultImageGenerationUsage(intent: GenerationIntent): AiUsageMetadata {
  if (intent === 'character-reference' || intent === 'avatar') {
    return { type: 'character_visual_identity', label: intent === 'avatar' ? '头像生成' : '角色形象图生成' };
  }
  return { type: 'image_generation', label: '图片生成' };
}

export async function generateImageWithAdapter(params: ImageGenerationAdapterOptions): Promise<GeneratedImage[]> {
  return generateImage(profileToApi(params.profile), resolveImageGenerationRequest(params));
}

export function resolveVideoGenerationParameters(params: VideoGenerationAdapterOptions): Record<string, unknown> {
  const defaults = normalizeVideoGenerationDefaults(params.profile.videoDefaults);
  const aspectRatio = params.aspectRatio?.trim() || defaults?.aspectRatio;
  const resolution = params.resolution?.trim() || defaults?.resolution;
  const duration = params.duration ?? defaults?.duration;
  return {
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(resolution ? { resolution } : {}),
    ...(params.referenceImages?.length ? { image_urls: params.referenceImages.map((item) => item.url) } : {}),
  };
}

export async function generateVideoWithAdapter(params: VideoGenerationAdapterOptions) {
  await assertMultimediaGenerationPermission();
  return submitAiMediaTask({
    profile: profileToApi(params.profile),
    prompt: params.prompt,
    parameters: resolveVideoGenerationParameters(params),
    signal: params.signal,
    aiUsage: params.aiUsage || { type: 'video_generation', label: '聊天视频生成' },
  }).catch((error: unknown) => {
    reportMultimediaPermissionError(error);
    throw error;
  });
}

export async function generateTextWithAdapter(params: TextGenerationAdapterOptions): Promise<string> {
  return generateResponse(
    profileToApi(params.profile),
    params.systemPrompt,
    params.messages,
    params.onChunk,
    params.maxTokens === undefined && !params.signal && !params.aiUsage
      ? undefined
      : { maxTokens: params.maxTokens, signal: params.signal, aiUsage: params.aiUsage },
  );
}

export async function generateJsonWithAdapter(params: Omit<TextGenerationAdapterOptions, 'onChunk' | 'maxTokens'>): Promise<string> {
  return generateJsonResponse(profileToApi(params.profile), params.systemPrompt, params.messages, {
    signal: params.signal,
    aiUsage: params.aiUsage,
  });
}

export async function synthesizeSpeechWithAdapter(params: SpeechGenerationAdapterOptions): Promise<SpeechSynthesisResult> {
  return synthesizeSpeech(profileToApi(params.profile), params);
}

export async function transcribeAudioWithAdapter(params: AudioTranscriptionAdapterOptions): Promise<AudioTranscriptionResult> {
  return transcribeAudio(profileToApi(params.profile), params);
}
