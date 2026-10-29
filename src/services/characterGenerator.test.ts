import { describe, expect, it, vi } from 'vitest';
import { generateResponse } from './aiClient';
import { generateCharacterBasicProfileDraft, parseGeneratedProfile, parseGeneratedProfileMap } from './characterGenerator';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));

describe('characterGenerator', () => {
  it('retries duplicated identity summaries and returns distinct basic fields', async () => {
    const request = vi.mocked(generateResponse);
    request.mockReset();
    request.mockResolvedValueOnce(JSON.stringify({ background: '电台主持人', speakingStyle: '电台主持人', expertise: ['主持'] }));
    request.mockResolvedValueOnce(JSON.stringify({ background: '与室友合住公寓的电台主持人，希望事业得到认可。', speakingStyle: '语调夸张，喜欢自嘲，紧张时会嘴硬。', expertise: ['主持'] }));
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
