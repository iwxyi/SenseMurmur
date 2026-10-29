import { describe, expect, it } from 'vitest';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CORE_PROFILE, DEFAULT_PERSONALITY, DEFAULT_SPEECH_PROFILE } from '../types/character';
import { normalizeGeneratedProfile } from './characterGenerator';
import { buildCharacterProfileCompletionPatch, isCharacterProfileCompletionMissing } from './characterProfileCompletion';

const generated = normalizeGeneratedProfile({
  background: '与室友合住的电台主持人，希望获得认可。', speakingStyle: '喜欢自嘲，语调夸张。', expertise: ['主持'],
  personality: { ...DEFAULT_PERSONALITY, humor: 88, neuroticism: 76 },
  behavior: { ...DEFAULT_CHARACTER_BEHAVIOR, proactivity: 71, humorIntensity: 92, offTopic: 80 },
  speechProfile: { ...DEFAULT_SPEECH_PROFILE, catchphrases: ['好男人就是我'], questionBias: 27 },
  coreProfile: { coreDesire: '被认可', coreFear: '被忽视', socialMask: '装作自信', values: ['友情'],
    attachmentStyle: '渴望亲近', conflictStyle: '嘴硬后和解', selfImage: '优秀主持人', expressionHabits: ['自嘲'] },
});
const character = {
  name: '曾小贤', background: generated.background, speakingStyle: generated.speakingStyle, expertise: generated.expertise,
  personality: { ...DEFAULT_PERSONALITY }, behavior: { ...DEFAULT_CHARACTER_BEHAVIOR },
  coreProfile: { ...DEFAULT_CORE_PROFILE }, speechProfile: { ...DEFAULT_SPEECH_PROFILE },
};

describe('character library profile completion', () => {
  it('treats default personality, behavior, core profile and speech as incomplete', () => {
    for (const field of ['base', 'personality', 'profile'] as const) expect(isCharacterProfileCompletionMissing(character, field)).toBe(true);
  });

  it('saves personality and both social and discussion behavior groups', () => {
    const patch = buildCharacterProfileCompletionPatch(character, generated, 'personality', false);
    expect(patch.personality?.humor).toBe(88);
    expect(patch.behavior).toMatchObject({ proactivity: 71, humorIntensity: 92, offTopic: 80 });
    expect(isCharacterProfileCompletionMissing({ ...character, ...patch }, 'personality')).toBe(false);
  });

  it('preserves custom numeric values including zero when only behavior needs filling', () => {
    const custom = { ...character, personality: { ...DEFAULT_PERSONALITY, humor: 0, empathy: 81 } };
    const patch = buildCharacterProfileCompletionPatch(custom, generated, 'personality', false);
    expect(patch.personality).toEqual(custom.personality);
    expect(patch.behavior).toEqual(generated.behavior);
    expect(buildCharacterProfileCompletionPatch(custom, generated, 'personality', true).personality).toEqual(generated.personality);
  });

  it('fills an empty profile object and preserves partial custom profile data and legacy aliases', () => {
    expect(buildCharacterProfileCompletionPatch(character, generated, 'profile', false).coreProfile?.coreDesire).toBe('被认可');
    const patch = buildCharacterProfileCompletionPatch({ ...character, coreProfile: { coreDesire: '保留的目标', valuePriority: ['尊重'], values: [] } }, generated, 'profile', false);
    expect(patch.coreProfile).toMatchObject({ coreDesire: '保留的目标', coreFear: '被忽视', values: ['尊重'], valuePriority: ['尊重'], expressionHabits: ['自嘲'] });
    expect(isCharacterProfileCompletionMissing({ ...character, ...patch }, 'profile')).toBe(false);
  });

  it('fills speech habits without overwriting existing valid basic descriptions', () => {
    const current = { ...character, background: '自定义经历', speakingStyle: '自定义语气' };
    const patch = buildCharacterProfileCompletionPatch(current, generated, 'base', false);
    expect(patch).toMatchObject({ background: '自定义经历', speakingStyle: '自定义语气', speechProfile: { catchphrases: ['好男人就是我'], questionBias: 27 } });
    expect(isCharacterProfileCompletionMissing({ ...current, ...patch }, 'base')).toBe(false);
  });

  it('fills legacy all-zero placeholders and missing numeric axes', () => {
    const partial = { ...character, behavior: { ...DEFAULT_CHARACTER_BEHAVIOR, proactivity: Number.NaN } };
    expect(isCharacterProfileCompletionMissing(partial, 'personality')).toBe(true);
    expect(buildCharacterProfileCompletionPatch(partial, generated, 'personality', false).behavior?.proactivity).toBe(71);
    const cleared = { ...character, personality: Object.fromEntries(Object.keys(DEFAULT_PERSONALITY).map((key) => [key, 0])) as typeof DEFAULT_PERSONALITY };
    expect(buildCharacterProfileCompletionPatch(cleared, generated, 'personality', false).personality).toEqual(generated.personality);
  });
});
