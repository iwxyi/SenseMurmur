import type { AIModelType } from './settings';
import type { BubbleStyleDefinition } from './bubbleStyle';

export interface PersonalityParams {
  openness: number;
  extroversion: number;
  agreeableness: number;
  neuroticism: number;
  humor: number;
  creativity: number;
  assertiveness: number;
  empathy: number;
}

export interface CharacterBehaviorParams {
  proactivity: number;
  aggressiveness: number;
  humorIntensity: number;
  empathyLevel: number;
  summarizing: number;
  offTopic: number;
}

export interface CharacterRelationshipPreset {
  characterId: string;
  warmth: number;
  competence: number;
  trust: number;
  threat: number;
  attachment?: number;
  deference?: number;
  note?: string;
  source?: 'user' | 'ai_inferred' | 'imported';
  confidence?: number;
  evidence?: string;
  updatedAt?: number;
}

export interface CharacterMemoryConfig {
  longTerm: string[];
  shortTermSummary: string;
  secrets: string[];
  obsessions: string[];
  tabooTopics: string[];
  userMemories: string[];
}

export interface CharacterInterventionConfig {
  allowSpeakAs: boolean;
  allowDirectorPrompt: boolean;
  allowPrivateThread: boolean;
}

export interface CharacterSpeechProfile {
  catchphrases: string[];
  fillers: string[];
  tabooPhrases: string[];
  preferredOpeners: string[];
  preferredClosers: string[];
  sentenceLengthBias: 'short' | 'mixed' | 'long';
  questionBias: number;
  sarcasmBias: number;
}

export interface CharacterVoiceConfig {
  enabled: boolean;
  voiceName?: string;
  providerCode?: string;
  voiceSource?: 'auto' | 'manual' | 'pending';
  assignmentStatus?: 'assigned' | 'pending' | 'unavailable';
  voiceProfile?: {
    gender?: 'female' | 'male' | 'neutral' | 'unknown';
    age?: string;
    language?: string;
    traits?: string[];
    styles?: string[];
    emotions?: string[];
    energy?: string;
  };
  style?: string;
  role?: string;
  rate?: string;
  pitch?: string;
  emotion?: string;
  stability?: number;
  similarity?: number;
  instructions?: string;
}

export interface CharacterCoreProfile {
  coreDesire?: string;
  coreFear?: string;
  valuePriority?: string[];
  socialMask?: string;
  biases?: string[];
  values?: string[];
  sensitivities?: string[];
  perceptionBiases?: string[];
  interactionHabits?: string[];
  expressionHabits?: string[];
  attachmentStyle?: string;
  conflictStyle?: string;
  unmetNeeds?: string[];
  selfImage?: string;
  hiddenSoftSpots?: string[];
}

export interface CharacterVisualReferenceImage {
  id: string;
  assetId: string;
  url: string;
  mimeType?: string;
  sizeBytes?: number;
  checksum?: string;
  label?: string;
  source?: 'uploaded' | 'generated';
  isPrimary?: boolean;
  createdAt: number;
}

export interface CharacterVisualIdentityDefaults {
  useReferenceImages?: boolean;
}

export interface CharacterVisualIdentity {
  description?: string;
  styleHint?: string;
  negativePrompt?: string;
  seed?: string | number | null;
  referenceImages?: CharacterVisualReferenceImage[];
  primaryReferenceImageId?: string | null;
  defaults?: CharacterVisualIdentityDefaults;
}

export type CharacterGenerationOverride = 'follow_global' | 'on' | 'off';

export interface CharacterGenerationPreferences {
  moments?: CharacterGenerationOverride;
  diaries?: CharacterGenerationOverride;
  companionship?: CharacterGenerationOverride;
}

export function normalizeCharacterVisualIdentity(input?: CharacterVisualIdentity | null): CharacterVisualIdentity {
  const referenceImages = Array.isArray(input?.referenceImages)
    ? input.referenceImages.map((image): CharacterVisualReferenceImage => ({
        id: image.id,
        assetId: image.assetId || image.id,
        url: image.url,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        checksum: image.checksum,
        label: image.label,
        source: image.source === 'generated' ? 'generated' : 'uploaded',
        isPrimary: Boolean(image.isPrimary),
        createdAt: Number(image.createdAt || Date.now()),
      }))
    : [];
  return {
    description: typeof input?.description === 'string' ? input.description : '',
    styleHint: typeof input?.styleHint === 'string' ? input.styleHint : '',
    negativePrompt: typeof input?.negativePrompt === 'string' ? input.negativePrompt : '',
    seed: input?.seed ?? null,
    referenceImages,
    primaryReferenceImageId: input?.primaryReferenceImageId ?? null,
    defaults: {
      useReferenceImages: Boolean(input?.defaults?.useReferenceImages),
    },
  };
}

export interface EmotionalState {
  irritation: number;
  affection: number;
  insecurity: number;
  excitement: number;
  embarrassment: number;
}

export type InnerImpulse =
  | 'answer'
  | 'show_off'
  | 'take_control'
  | 'defend_face'
  | 'seek_attention'
  | 'comfort'
  | 'repair'
  | 'mock'
  | 'avoid'
  | 'change_topic'
  | 'stay_silent'
  | 'send_emoji'
  | 'withdraw';

export interface CharacterSoulState {
  mood: {
    pleasure: number;
    arousal: number;
    dominance: number;
  };
  energy: number;
  attention: number;
  loneliness: number;
  repression: number;
  shame: number;
  envy: number;
  trustInRoom: number;
  ignoredStreak: number;
  lastImpulse?: InnerImpulse;
  lastImpulseReason?: string;
  lastSpokeAt?: number;
  updatedAt?: number;
}

export interface CharacterPresenceState {
  status: 'online' | 'away';
  activity?: string;
  reason?: string;
  unavailableUntil?: number;
  lastAwayAt?: number;
  updatedAt: number;
  sourceMessageId?: string;
  calendarItemId?: string;
  locationHint?: string;
}

import type { MemoryItem } from '../services/memoryTypes';

export interface AICharacter {
  id: string;
  name: string;
  avatar: string;
  personality: PersonalityParams;
  personalityDrift?: Partial<PersonalityParams>;
  emotionalState?: EmotionalState;
  soulState?: CharacterSoulState;
  presence?: CharacterPresenceState;
  coreProfile?: CharacterCoreProfile;
  visualIdentity?: CharacterVisualIdentity | null;
  // Lightweight API projections can return visual assets separately from the
  // descriptive identity. Card views need both response shapes.
  visualReferenceImages?: CharacterVisualReferenceImage[];
  speechProfile?: CharacterSpeechProfile;
  voiceConfig?: CharacterVoiceConfig;
  behavior: CharacterBehaviorParams;
  expertise: string[];
  speakingStyle: string;
  background: string;
  group?: string | null;
  relationships: CharacterRelationshipPreset[];
  memory: CharacterMemoryConfig;
  layeredMemories?: MemoryItem[];
  intervention: CharacterInterventionConfig;
  runtimeTimeline?: Array<{ type: 'memory' | 'relationship' | 'drift'; text: string; createdAt: number }>;
  modelProfileId?: string | null;
  modelProfileIds?: Partial<Record<AIModelType, string | null>>;
  generationPreferences?: CharacterGenerationPreferences;
  bubbleStyle?: BubbleStyleDefinition | null;
  bubbleStyleId?: string | null;
  isPreset: boolean;
  deletedAt?: number | null;
  fieldVersions?: Record<string, number>;
  sourceMarketItemId?: string | null;
  sourceMarketItemVersion?: number | null;
  sourceMarketKind?: 'character_template' | 'chat_template' | 'bundle_template' | string | null;
  characterDetailLoaded?: boolean;
  createdAt: number;
  updatedAt: number;
}

export function normalizeCharacterGroup(value?: string | null) {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return normalized ? normalized.slice(0, 40) : null;
}

export function getTopicDerivedCharacterGroup(value?: string | null) {
  return normalizeCharacterGroup(value);
}

export function getCharacterGroupList(characters: AICharacter[]) {
  return Array.from(new Set(characters.map((character) => normalizeCharacterGroup(character.group)).filter(Boolean) as string[]))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

export function isSameCharacterGroup(a?: string | null, b?: string | null) {
  return normalizeCharacterGroup(a) === normalizeCharacterGroup(b);
}

export function isCharacterInGroup(character: AICharacter, group?: string | null) {
  const normalized = normalizeCharacterGroup(group);
  return normalized ? normalizeCharacterGroup(character.group) === normalized : true;
}

export function getCharactersInGroup(characters: AICharacter[], group?: string | null) {
  const normalized = normalizeCharacterGroup(group);
  return normalized ? characters.filter((character) => normalizeCharacterGroup(character.group) === normalized) : characters;
}

export function mergeCharacterGroup(existing: string[], suggested?: string[] | null) {
  return Array.from(new Set([...existing, ...((suggested || []).map((item) => item.trim()).filter(Boolean))]));
}

export function hasCharacterGroup(value?: string | null) {
  return Boolean(normalizeCharacterGroup(value));
}

export function clearCharacterGroup() {
  return null;
}

export function getCharacterGroupLabel(value?: string | null) {
  return normalizeCharacterGroup(value) || '';
}

export function canDeleteCharacterGroup(value?: string | null) {
  return Boolean(normalizeCharacterGroup(value));
}

export function normalizeCharacterGroupsForSelection(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => normalizeCharacterGroup(value)).filter(Boolean) as string[]));
}

export function appendCharacterGroup(existing: string[], value?: string | null) {
  const normalized = normalizeCharacterGroup(value);
  return normalized && !existing.includes(normalized) ? [...existing, normalized] : existing;
}

export function isPresetCharacterSelectable(character: AICharacter) {
  return !character.isPreset;
}

export function normalizeCharacterName(value?: string | null) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function getDuplicateCharacterNameKeys(characters: AICharacter[]) {
  const counts = new Map<string, number>();
  characters
    .filter((character) => character.deletedAt == null)
    .forEach((character) => {
      const key = normalizeCharacterName(character.name);
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

export function hasDuplicateCharacterName(character: Pick<AICharacter, 'name'>, duplicateKeys: Set<string>) {
  return duplicateKeys.has(normalizeCharacterName(character.name));
}

export function getDuplicateCharacters(characters: AICharacter[]) {
  const duplicateKeys = getDuplicateCharacterNameKeys(characters);
  return characters.filter((character) => hasDuplicateCharacterName(character, duplicateKeys));
}

export function getDuplicateCharacterCount(characters: AICharacter[]) {
  return getDuplicateCharacters(characters).length;
}

export function getDuplicateCharacterWarningText(character: Pick<AICharacter, 'name' | 'group'>, language: string) {
  const groupLabel = normalizeCharacterGroup(character.group);
  return language.startsWith('zh')
    ? `该角色与其他“${character.name}”重名${groupLabel ? `（分组：${groupLabel}）` : ''}，可能导致目标识别歧义。`
    : `This character shares the name "${character.name}"${groupLabel ? ` (group: ${groupLabel})` : ''}, which may cause target resolution ambiguity.`;
}

export function getDuplicateCharacterBannerText(characters: AICharacter[], language: string) {
  const duplicates = getDuplicateCharacters(characters);
  if (!duplicates.length) return '';
  return language.startsWith('zh')
    ? `发现 ${duplicates.length} 个历史重名角色，可能影响单聊目标识别。建议尽快改名。`
    : `Found ${duplicates.length} legacy characters with duplicate names. Direct target resolution may be ambiguous until they are renamed.`;
}

export const DEFAULT_PERSONALITY: PersonalityParams = {
  openness: 50,
  extroversion: 50,
  agreeableness: 50,
  neuroticism: 50,
  humor: 50,
  creativity: 50,
  assertiveness: 50,
  empathy: 50,
};

export const DEFAULT_CHARACTER_BEHAVIOR: CharacterBehaviorParams = {
  proactivity: 50,
  aggressiveness: 50,
  humorIntensity: 50,
  empathyLevel: 50,
  summarizing: 50,
  offTopic: 50,
};

export const DEFAULT_CHARACTER_MEMORY: CharacterMemoryConfig = {
  longTerm: [],
  shortTermSummary: '',
  secrets: [],
  obsessions: [],
  tabooTopics: [],
  userMemories: [],
};

export const DEFAULT_CHARACTER_INTERVENTION: CharacterInterventionConfig = {
  allowSpeakAs: true,
  allowDirectorPrompt: true,
  allowPrivateThread: true,
};

export const DEFAULT_EMOTIONAL_STATE: EmotionalState = {
  irritation: 0,
  affection: 0,
  insecurity: 0,
  excitement: 0,
  embarrassment: 0,
};

export const DEFAULT_CORE_PROFILE: CharacterCoreProfile = {
  coreDesire: '',
  coreFear: '',
  valuePriority: [],
  socialMask: '',
  biases: [],
  values: [],
  sensitivities: [],
  perceptionBiases: [],
  interactionHabits: [],
  expressionHabits: [],
  attachmentStyle: '',
  conflictStyle: '',
  unmetNeeds: [],
  selfImage: '',
  hiddenSoftSpots: [],
};

export const DEFAULT_SPEECH_PROFILE: CharacterSpeechProfile = {
  catchphrases: [],
  fillers: [],
  tabooPhrases: [],
  preferredOpeners: [],
  preferredClosers: [],
  sentenceLengthBias: 'mixed',
  questionBias: 50,
  sarcasmBias: 50,
};

export const DEFAULT_VOICE_CONFIG: CharacterVoiceConfig = {
  enabled: false,
  voiceName: '',
  style: '',
  role: '',
  rate: '',
  pitch: '',
};

export const DEFAULT_CHARACTER_MODEL_PROFILE_IDS: Partial<Record<AIModelType, string | null>> = {
  text: null,
  image: null,
  tts: null,
  stt: null,
  audio: null,
  document: null,
};

export function normalizeCharacterModelProfileIds(input?: Partial<Record<AIModelType, string | null>> | null, legacyTextId?: string | null) {
  return {
    ...DEFAULT_CHARACTER_MODEL_PROFILE_IDS,
    ...(input || {}),
    text: input?.text ?? legacyTextId ?? null,
  } satisfies Partial<Record<AIModelType, string | null>>;
}

export function getCharacterModelProfileId(character: Pick<AICharacter, 'modelProfileIds' | 'modelProfileId'>, type: AIModelType) {
  const profileIds = normalizeCharacterModelProfileIds(character.modelProfileIds, character.modelProfileId);
  return profileIds[type] ?? null;
}

function normalizeRelationshipMetric(value: number, min: number, max: number) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return Math.max(min, Math.min(max, safeValue));
}

function normalizeRelationshipPreset(input: CharacterRelationshipPreset): CharacterRelationshipPreset {
  return {
    ...input,
    warmth: normalizeRelationshipMetric(input.warmth, -100, 100),
    competence: normalizeRelationshipMetric(input.competence, -100, 100),
    trust: normalizeRelationshipMetric(input.trust, -100, 100),
    threat: normalizeRelationshipMetric(input.threat, 0, 100),
  };
}

export function normalizeCharacter(input: Partial<AICharacter> & Pick<AICharacter, 'id' | 'name' | 'avatar' | 'personality' | 'expertise' | 'speakingStyle' | 'background' | 'isPreset' | 'createdAt' | 'updatedAt'>): AICharacter {
  return {
    ...input,
    expertise: Array.isArray(input.expertise) ? input.expertise.filter((item): item is string => typeof item === 'string') : [],
    background: typeof input.background === 'string' ? input.background : '',
    speakingStyle: typeof input.speakingStyle === 'string' ? input.speakingStyle : '',
    personalityDrift: input.personalityDrift || {},
    emotionalState: {
      ...DEFAULT_EMOTIONAL_STATE,
      ...(input.emotionalState || {}),
    },
    coreProfile: {
      ...DEFAULT_CORE_PROFILE,
      ...(input.coreProfile || {}),
      valuePriority: input.coreProfile?.valuePriority || [],
      biases: input.coreProfile?.biases || [],
      values: input.coreProfile?.values || input.coreProfile?.valuePriority || [],
      sensitivities: input.coreProfile?.sensitivities || [],
      perceptionBiases: input.coreProfile?.perceptionBiases || input.coreProfile?.biases || [],
      interactionHabits: input.coreProfile?.interactionHabits || [],
      expressionHabits: input.coreProfile?.expressionHabits || [],
      unmetNeeds: input.coreProfile?.unmetNeeds || [],
      hiddenSoftSpots: input.coreProfile?.hiddenSoftSpots || [],
    },
    visualIdentity: normalizeCharacterVisualIdentity(input.visualIdentity),
    speechProfile: {
      ...DEFAULT_SPEECH_PROFILE,
      ...(input.speechProfile || {}),
      catchphrases: input.speechProfile?.catchphrases || [],
      fillers: input.speechProfile?.fillers || [],
      tabooPhrases: input.speechProfile?.tabooPhrases || [],
      preferredOpeners: input.speechProfile?.preferredOpeners || [],
      preferredClosers: input.speechProfile?.preferredClosers || [],
    },
    voiceConfig: {
      ...DEFAULT_VOICE_CONFIG,
      ...(input.voiceConfig || {}),
    },
    behavior: {
      ...DEFAULT_CHARACTER_BEHAVIOR,
      ...(input.behavior || {}),
    },
    group: normalizeCharacterGroup(input.group),
    relationships: (input.relationships || []).map(normalizeRelationshipPreset),
    runtimeTimeline: input.runtimeTimeline || [],
    memory: {
      ...DEFAULT_CHARACTER_MEMORY,
      ...(input.memory || {}),
      longTerm: input.memory?.longTerm || [],
      secrets: input.memory?.secrets || [],
      obsessions: input.memory?.obsessions || [],
      tabooTopics: input.memory?.tabooTopics || [],
      userMemories: input.memory?.userMemories || [],
    },
    layeredMemories: input.layeredMemories || [],
    intervention: {
      ...DEFAULT_CHARACTER_INTERVENTION,
      ...(input.intervention || {}),
    },
    modelProfileId: input.modelProfileId || null,
    modelProfileIds: normalizeCharacterModelProfileIds(input.modelProfileIds, input.modelProfileId),
    generationPreferences: {
      moments: input.generationPreferences?.moments || 'follow_global',
      diaries: input.generationPreferences?.diaries || 'follow_global',
      companionship: input.generationPreferences?.companionship || 'follow_global',
    },
    bubbleStyle: input.bubbleStyle || null,
  };
}
