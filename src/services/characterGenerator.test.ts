import { describe, expect, it, vi } from 'vitest';
import { generateResponse } from './aiClient';
import { generateCharacterBasicProfileDraft, generateCharacterProfileDraft, parseGeneratedProfile, parseGeneratedProfileMap } from './characterGenerator';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_PERSONALITY } from '../types/character';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));

describe('characterGenerator', () => {
  it('retries missing behavior rather than silently accepting default social and discussion scores', async () => {
    const request = vi.mocked(generateResponse);
    request.mockReset();
    request.mockResolvedValueOnce(JSON.stringify({ personality: { ...DEFAULT_PERSONALITY, humor: 88 } }));
    request.mockResolvedValueOnce(JSON.stringify({ personality: { ...DEFAULT_PERSONALITY, humor: 88 }, behavior: { ...DEFAULT_CHARACTER_BEHAVIOR, humorIntensity: 90 } }));
    const profile = await generateCharacterProfileDraft({ provider: 'openai', apiKey: '', baseUrl: '', model: 'test' }, '曾小贤', 'zh', '爱情公寓', 'personality');
    expect(profile.behavior.humorIntensity).toBe(90);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports incomplete core profiles instead of saving normalized empty defaults', async () => {
    const request = vi.mocked(generateResponse);
    request.mockReset();
    request.mockResolvedValue(JSON.stringify({ coreProfile: { coreDesire: '被认可' } }));
    await expect(generateCharacterProfileDraft({ provider: 'openai', apiKey: '', baseUrl: '', model: 'test' }, '曾小贤', 'zh', null, 'profile')).rejects.toThrow('核心画像');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retries duplicated identity summaries and returns distinct basic fields', async () => {
    const request = vi.mocked(generateResponse);
    request.mockReset();
    request.mockResolvedValueOnce(JSON.stringify({ background: '电台主持人', speakingStyle: '电台主持人', expertise: ['主持'] }));
    request.mockResolvedValueOnce(JSON.stringify({ background: '与室友合住公寓的电台主持人，希望事业得到认可。', speakingStyle: '语调夸张，喜欢自嘲，紧张时会嘴硬。', expertise: ['主持'], speechProfile: { catchphrases: ['好男人就是我'] } }));
    const profile = await generateCharacterBasicProfileDraft({ provider: 'openai', apiKey: '', baseUrl: '', model: 'test' }, '曾小贤', 'zh', '爱情公寓');
    expect(profile.speakingStyle).toContain('自嘲');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][2][0].content).toContain('上次基本信息不合格');
  });

  it('exposes invalid basic output after one retry instead of saving it', async () => {
    const request = vi.mocked(generateResponse);
    request.mockReset();
    request.mockResolvedValue(JSON.stringify({ background: '电台主持人', speakingStyle: '电台主持人', expertise: ['主持'] }));
    await expect(generateCharacterBasicProfileDraft({ provider: 'openai', apiKey: '', baseUrl: '', model: 'test' }, '曾小贤', 'zh'))
      .rejects.toThrow('AI 未生成有效的基本信息');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects basic profiles that omit character-specific speech habits', async () => {
    const request = vi.mocked(generateResponse);
    request.mockReset();
    request.mockResolvedValue(JSON.stringify({ background: '与室友合住的主持人', speakingStyle: '语调夸张，喜欢自嘲', expertise: ['主持'] }));
    await expect(generateCharacterBasicProfileDraft({ provider: 'openai', apiKey: '', baseUrl: '', model: 'test' }, '曾小贤', 'zh'))
      .rejects.toThrow('说话习惯不能为空');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('accepts legacy core values and retains generated expression habits', async () => {
    const request = vi.mocked(generateResponse);
    request.mockReset();
    request.mockResolvedValue(JSON.stringify({ coreProfile: {
      coreDesire: '被认可', coreFear: '被忽视', socialMask: '装作自信', values: [], valuePriority: ['友情'],
      attachmentStyle: '渴望亲近', conflictStyle: '嘴硬后和解', selfImage: '优秀主持人', expressionHabits: ['自嘲'],
    } }));
    const profile = await generateCharacterProfileDraft({ provider: 'openai', apiKey: '', baseUrl: '', model: 'test' }, '曾小贤', 'zh', null, 'profile');
    expect(profile.coreProfile).toMatchObject({ values: ['友情'], expressionHabits: ['自嘲'] });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('normalizes generated behavior axes for a single profile', () => {
    const profile = parseGeneratedProfile(JSON.stringify({
      avatar: '🤖',
      personality: {
        openness: 72,
        extroversion: 35,
        agreeableness: 61,
        neuroticism: 44,
        humor: 28,
        creativity: 80,
        assertiveness: 67,
        empathy: 52,
      },
      behavior: {
        proactivity: 81,
        aggressiveness: 22,
        humorIntensity: 17,
        empathyLevel: 58,
        summarizing: 74,
        offTopic: 9,
      },
      expertise: ['测试'],
      speakingStyle: '简洁直接。',
      background: '测试角色。',
      voiceProfile: {
        gender: 'female',
        age: 'young',
        language: 'zh-CN',
        traits: ['温柔', '清冷'],
        energy: 'low',
      },
    }));

    expect(profile.behavior).toMatchObject({
      proactivity: 81,
      aggressiveness: 22,
      humorIntensity: 17,
      empathyLevel: 58,
      summarizing: 74,
      offTopic: 9,
    });
    expect(profile.voiceProfile).toMatchObject({ gender: 'female', age: 'young', language: 'zh-CN', traits: ['温柔', '清冷'], energy: 'low' });
  });

  it('keeps generated behavior axes in batch profiles', () => {
    const profiles = parseGeneratedProfileMap(JSON.stringify([
      {
        name: '甲',
        avatar: '🤖',
        personality: {
          openness: 50,
          extroversion: 50,
          agreeableness: 50,
          neuroticism: 50,
          humor: 50,
          creativity: 50,
          assertiveness: 50,
          empathy: 50,
        },
        behavior: {
          proactivity: 25,
          aggressiveness: 70,
          humorIntensity: 35,
          empathyLevel: 41,
          summarizing: 18,
          offTopic: 63,
        },
        expertise: [],
        speakingStyle: '',
        background: '',
      },
    ]), ['甲']);

    expect(profiles[0].profile.behavior).toMatchObject({
      proactivity: 25,
      aggressiveness: 70,
      humorIntensity: 35,
      empathyLevel: 41,
      summarizing: 18,
      offTopic: 63,
    });
  });
});
