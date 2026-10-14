import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { InnerLifeProjection } from './innerLifeEngine';
import { deriveCharacterTurnDrive } from './characterTurnDrive';

function actor(id: string, patch: Partial<AICharacter>): AICharacter {
  return {
    id, name: id, avatar: '', personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
    behavior: { proactivity: 50, aggressiveness: 50, humorIntensity: 50, empathyLevel: 50, summarizing: 50, offTopic: 50 }, expertise: [], speakingStyle: '', background: '', relationships: [],
    memory: { longTerm: [], shortTermSummary: '', secrets: [], obsessions: [], tabooTopics: [], userMemories: [] }, intervention: { allowSpeakAs: true, allowDirectorPrompt: true, allowPrivateThread: true }, isPreset: false, createdAt: 1, updatedAt: 1, ...patch,
  };
}

const quiet: InnerLifeProjection = {
  actorId: 'x', impulse: 'stay_silent', tone: 'casual', reason: 'no direct trigger', pressure: 0.24, evidence: [],
  state: { mood: { pleasure: 0, arousal: 0, dominance: 50 }, energy: 50, attention: 50, loneliness: 0, repression: 0, shame: 0, envy: 0, trustInRoom: 50, ignoredStreak: 0, updatedAt: 1 },
  expressionPlan: { tone: 'casual', length: 'short', messageCount: 1, typoLevel: 0, delayMs: 0, allowWithdraw: false },
};

describe('character turn drive structural evaluation', () => {
  it('scores four character profiles across four identical room pressures', () => {
    const cast = [
      actor('guardian', { coreProfile: { coreDesire: '不让熟人替别人吞下代价', interactionHabits: ['先看最后是谁吃亏'] }, relationships: [{ characterId: 'speaker', warmth: 28, competence: 10, trust: 20, threat: 2 }] }),
      actor('skeptic', { coreProfile: { coreFear: '好听的承诺最后又变成空话', perceptionBiases: ['听见含糊安排就先看谁能兑现'] }, relationships: [{ characterId: 'speaker', warmth: 4, competence: 16, trust: 5, threat: 18 }] }),
      actor('free_spirit', { coreProfile: { coreDesire: '别把活人过成一张账本', sensitivities: ['讨厌有人替所有人把话说死'] } }),
      actor('bystander', { coreProfile: { values: ['不替别人收拾他们没问自己的事'], interactionHabits: ['事情没落到自己身上就先听着'] } }),
    ];
    const pressures = ['地界和收成明天再慢慢问，先把摊子支起来。', '这件事谁都别争了，我已经替大家答应。', '账先别算，人情以后总会还。', '他不在场，先把责任记到他头上。'];
    const outputs = pressures.flatMap((content) => cast.map((speaker) => deriveCharacterTurnDrive({
      speaker,
      messages: [{ id: content, chatId: 'c', senderId: 'speaker', senderName: 'Speaker', emotion: 0, type: 'ai', content, timestamp: 1, isDeleted: false }],
      innerLife: quiet,
    })));
    const perPressure = pressures.map((_, index) => outputs.slice(index * cast.length, (index + 1) * cast.length));
    const distinctPairs = perPressure.flatMap((drives) => drives.flatMap((drive, index) => drives.slice(index + 1).map((other) => (
      drive.stake !== other.stake || drive.relationalAction !== other.relationalAction || drive.attentionLens !== other.attentionLens
    ))));
    const differentiationScore = distinctPairs.filter(Boolean).length / distinctPairs.length * 100;
    const genericManagerCount = outputs.filter((drive) => /room-manager|new condition|handoff/i.test(`${drive.stake} ${drive.attentionLens}`)).length;
    const evidenceCoverageScore = outputs.filter((drive) => drive.evidence.includes('character_attention_pattern') && drive.evidence.some((item) => item === 'core_desire' || item === 'core_fear' || item === 'core_values')).length / outputs.length * 100;

    expect(outputs).toHaveLength(16);
    expect(differentiationScore).toBe(100);
    expect(evidenceCoverageScore).toBe(100);
    expect(genericManagerCount).toBe(0);
  });
});
