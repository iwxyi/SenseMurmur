import {
  DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_PERSONALITY, DEFAULT_SPEECH_PROFILE,
  type AICharacter, type CharacterCoreProfile, type CharacterSpeechProfile,
} from '../types/character';
import { getCharacterBasicProfileMissing } from './characterBasicProfile';
import type { normalizeGeneratedProfile } from './characterGenerator';

export type ProfileCompletionField = 'base' | 'personality' | 'profile';
type GeneratedProfile = ReturnType<typeof normalizeGeneratedProfile>;
type CompletionProfile = Pick<AICharacter, 'name' | 'background' | 'speakingStyle' | 'expertise' | 'personality' | 'behavior' | 'coreProfile' | 'speechProfile'>;
const coreTextFields = ['coreDesire', 'coreFear', 'socialMask', 'attachmentStyle', 'conflictStyle', 'selfImage'] as const;

function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isPlaceholderBlock<T extends object>(current: Partial<T> | undefined, defaults: T) {
  const keys = Object.keys(defaults) as Array<keyof T>;
  return !current || keys.every((key) => current[key] === defaults[key]) || keys.every((key) => current[key] === 0);
}

function numericBlockMissing<T extends object>(current: Partial<T> | undefined, defaults: T) {
  return isPlaceholderBlock(current, defaults) || (Object.keys(defaults) as Array<keyof T>).some((key) => !validScore(current?.[key]));
}

function mergeNumericBlock<T extends object>(current: Partial<T> | undefined, generated: T, defaults: T): T {
  if (isPlaceholderBlock(current, defaults)) return { ...generated };
  const result = { ...generated };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const value = current?.[key];
    if (validScore(value)) result[key] = value as T[keyof T];
  }
  return result;
}

function hasContent(value: unknown) {
  return Array.isArray(value) ? value.some((entry) => typeof entry === 'string' && Boolean(entry.trim()))
    : typeof value === 'string' && Boolean(value.trim());
}

function speechMissing(current: CharacterSpeechProfile | undefined) {
  if (!current) return true;
  return Object.entries(DEFAULT_SPEECH_PROFILE).every(([key, fallback]) => {
    const value = current[key as keyof CharacterSpeechProfile];
    return Array.isArray(fallback) ? !hasContent(value) : value === undefined || value === fallback;
  });
}

export function isCharacterProfileCompletionMissing(character: CompletionProfile, field: ProfileCompletionField): boolean {
  if (field === 'base') return Object.values(getCharacterBasicProfileMissing(character)).some(Boolean) || speechMissing(character.speechProfile);
  if (field === 'personality') return numericBlockMissing(character.personality, DEFAULT_PERSONALITY)
    || numericBlockMissing(character.behavior, DEFAULT_CHARACTER_BEHAVIOR);
  const core = character.coreProfile;
  return coreTextFields.some((key) => !core?.[key]?.trim()) || !hasContent(core?.values) && !hasContent(core?.valuePriority);
}

export function buildCharacterProfileCompletionPatch(character: CompletionProfile, generated: GeneratedProfile, field: ProfileCompletionField, regenerate: boolean): Partial<AICharacter> {
  if (field === 'personality') return {
    personality: regenerate ? generated.personality : mergeNumericBlock(character.personality, generated.personality, DEFAULT_PERSONALITY),
    behavior: regenerate ? generated.behavior : mergeNumericBlock(character.behavior, generated.behavior, DEFAULT_CHARACTER_BEHAVIOR),
  };
  if (field === 'profile') {
    const coreProfile: CharacterCoreProfile = { ...generated.coreProfile };
    if (!regenerate && character.coreProfile) {
      Object.assign(coreProfile, Object.fromEntries(Object.entries(character.coreProfile).filter(([, value]) => hasContent(value))));
      coreProfile.values = hasContent(character.coreProfile.values) ? character.coreProfile.values
        : hasContent(character.coreProfile.valuePriority) ? character.coreProfile.valuePriority : coreProfile.values;
      coreProfile.perceptionBiases = hasContent(character.coreProfile.perceptionBiases) ? character.coreProfile.perceptionBiases
        : hasContent(character.coreProfile.biases) ? character.coreProfile.biases : coreProfile.perceptionBiases;
    }
    coreProfile.valuePriority = coreProfile.values;
    coreProfile.biases = coreProfile.perceptionBiases;
    return { coreProfile };
  }
  const missing = getCharacterBasicProfileMissing(character);
  let speechProfile = generated.speechProfile;
  if (!regenerate && !speechMissing(character.speechProfile)) {
    speechProfile = { ...generated.speechProfile, ...Object.fromEntries(Object.entries(character.speechProfile || {}).filter(([, value]) => typeof value === 'number' ? validScore(value) : hasContent(value))) };
  }
  return {
    background: regenerate || missing.background ? generated.background : character.background,
    speakingStyle: regenerate || missing.speakingStyle ? generated.speakingStyle : character.speakingStyle,
    expertise: regenerate || missing.expertise ? generated.expertise : character.expertise,
    speechProfile,
  };
}
