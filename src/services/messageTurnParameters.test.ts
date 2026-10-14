import { describe, expect, it } from 'vitest';
import { captureTurnParameters, finishTurnParameters } from './messageTurnParameters';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import { createTestChat } from '../test/fixtures';
import type { InnerLifeProjection } from './innerLifeEngine';

const character = (id: string, name = id, relationships: AICharacter['relationships'] = []): AICharacter => ({
  id, name, avatar: '', personality: {} as AICharacter['personality'], behavior: {} as AICharacter['behavior'],
  expertise: [], speakingStyle: '', background: '', relationships, memory: { longTerm: [], shortTermSummary: '', secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
  intervention: {} as AICharacter['intervention'], isPreset: false, createdAt: 0, updatedAt: 0,
});

const innerLife = (): InnerLifeProjection => ({
  actorId: 'speaker', impulse: 'answer', tone: 'defensive', reason: 'test', pressure: 0.7,
  evidence: ['直接点名'], state: { mood: { pleasure: 20, arousal: 60, dominance: 40 }, energy: 50, attention: 70, loneliness: 0, repression: 0, shame: 0, envy: 0, trustInRoom: 50, ignoredStreak: 0 },
  expressionPlan: { tone: 'defensive', length: 'short', messageCount: 2, typoLevel: 0, delayMs: 0, allowWithdraw: false },
});

const chat = (ledger: GroupChat['relationshipLedger'] = []): GroupChat => createTestChat({ id: 'chat', name: 'test', memberIds: ['speaker', 'target'], relationshipLedger: ledger });

describe('message turn parameters', () => {
  it('does not create a snapshot when developer mode is disabled', () => {
    expect(captureTurnParameters({ chat: chat(), speaker: character('speaker'), members: [character('speaker'), character('target')], innerLife: innerLife(), move: 'answer', intendedRecipientIds: ['target'], enabled: false })).toBeUndefined();
  });

  it('captures only relevant relations and prefers global character relationships', () => {
    const speaker = character('speaker', '说话者', [{ characterId: 'target', warmth: 72, competence: 61, trust: 55, threat: 12, attachment: 30, deference: 8 }]);
    const snapshot = captureTurnParameters({ chat: chat([{ actorId: 'speaker', targetId: 'target', current: { warmth: 1, competence: 1, trust: 1, threat: 1 } } as never]), speaker, members: [speaker, character('target', '目标'), character('unrelated')], innerLife: innerLife(), move: 'answer', intendedRecipientIds: ['target'], enabled: true });
    expect(snapshot?.relationships).toEqual([{ target: '目标', warmth: 72, competence: 61, trust: 55, threat: 12, attachment: 30, deference: 8 }]);
    expect(JSON.stringify(snapshot)).not.toContain('"target":"target"');
  });

  it('uses the ledger only when no global relation exists', () => {
    const snapshot = captureTurnParameters({ chat: chat([{ actorId: 'speaker', targetId: 'target', current: { warmth: 9, competence: 8, trust: 7, threat: 6, attachment: 5, deference: 4 } } as never]), speaker: character('speaker'), members: [character('speaker'), character('target', '目标')], innerLife: innerLife(), move: 'answer', intendedRecipientIds: ['target'], enabled: true });
    expect(snapshot?.relationships[0]).toMatchObject({ target: '目标', warmth: 9, attachment: 5, deference: 4 });
  });

  it('finishes delivery using display names and bubble count', () => {
    const captured = captureTurnParameters({ chat: chat(), speaker: character('speaker'), members: [character('speaker'), character('target', '目标')], innerLife: innerLife(), move: 'answer', intendedRecipientIds: [], enabled: true });
    const finished = finishTurnParameters({ captured, members: [character('speaker'), character('target', '目标')], addressedTargetIds: ['target', 'missing'], primaryAddressedTargetId: 'target', bubbleCount: 3 });
    expect(finished?.delivery).toEqual({ addressedRecipients: ['目标'], primaryRecipient: '目标', bubbleCount: 3 });
    expect(JSON.stringify(finished)).not.toContain('missing');
  });
});
