import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import { normalizeConversation } from '../types/chat';
import type { ConflictFocusState } from '../types/runtimeEvent';
import { projectConflictPanelItems } from './conflictPanelProjection';

function member(id: string, name: string): AICharacter {
  return {
    id,
    name,
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
    behavior: { proactivity: 50, aggressiveness: 50, humorIntensity: 50, empathyLevel: 50, summarizing: 50, offTopic: 50 },
    expertise: [],
    speakingStyle: '',
    background: '',
    relationships: [],
    memory: { longTerm: [], shortTermSummary: '', secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
    intervention: { allowSpeakAs: true, allowDirectorPrompt: true, allowPrivateThread: true },
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildChat() {
  return normalizeConversation({
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '群聊',
    topic: '',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    runtimeEventsV2: [],
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

describe('conflictPanelProjection', () => {
  it('projects active conflicts and axis entries into readable items', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      worldState: {
        ...buildChat().worldState,
        conflictState: {
          primaryConflict: {
            id: 'c1',
            scope: 'group',
            type: 'value_conflict',
            severity: 0.72,
            stage: 'escalating',
            summary: 'a 与 b 正在争执是否继续推进',
            participantIds: ['a'],
            targetIds: ['b'],
            nextPressure: 'escalate',
            developmentHooks: ['raise_stakes'],
            sourceEventIds: ['evt-1'],
            updatedAt: 1,
          },
          activeConflicts: [],
          developmentHooks: [],
          volatility: 0.4,
          cooling: 0.1,
          updatedAt: 1,
        },
        conflictAxes: [{
          title: '效率 vs 稳妥',
          poles: ['效率优先', '稳妥优先'],
          currentTilt: -12,
        }],
      },
    });
    const items = projectConflictPanelItems(chat, [member('a', '甲'), member('b', '乙')]);
    expect(items).toHaveLength(2);
    expect(items[0]?.key).toBe('c1');
    expect(items[0]?.chips).toEqual(expect.arrayContaining(['升温中', '甲', '乙']));
    expect(items[1]?.title).toBe('效率 vs 稳妥');
    expect(items[1]?.chips).toEqual(['轴配置']);
  });

  it('dedupes duplicate conflict ids and skips resolved conflicts', () => {
    const conflict: ConflictFocusState = {
      id: 'dup',
      scope: 'group' as const,
      type: 'value_conflict' as const,
      severity: 0.6,
      stage: 'open' as const,
      summary: '重复冲突',
      participantIds: ['a'],
      targetIds: ['b'],
      nextPressure: 'escalate' as const,
      developmentHooks: ['invite_target_response'],
      sourceEventIds: ['evt-2'],
      updatedAt: 1,
    };
    const chat = normalizeConversation({
      ...buildChat(),
      worldState: {
        ...buildChat().worldState,
        conflictState: {
          primaryConflict: conflict,
          activeConflicts: [
            conflict,
            { ...conflict, id: 'resolved-1', stage: 'resolved' as const },
          ],
          developmentHooks: [],
          volatility: 0.3,
          cooling: 0.2,
          updatedAt: 1,
        },
      },
    });
    const items = projectConflictPanelItems(chat, [member('a', '甲'), member('b', '乙')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe('dup');
  });

  it('maps user participant id to 我 in chips', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['user', 'a'],
      worldState: {
        ...buildChat().worldState,
        conflictState: {
          primaryConflict: {
            id: 'user-conflict',
            scope: 'group',
            type: 'value_conflict',
            severity: 0.62,
            stage: 'open',
            summary: 'user 与 a 在观点上有分歧',
            participantIds: ['user'],
            targetIds: ['a'],
            nextPressure: 'stabilize',
            developmentHooks: ['invite_target_response'],
            sourceEventIds: ['evt-user'],
            updatedAt: 1,
          },
          activeConflicts: [],
          developmentHooks: [],
          volatility: 0.2,
          cooling: 0.3,
          updatedAt: 1,
        },
      },
    });
    const items = projectConflictPanelItems(chat, [member('a', '甲')]);
    expect(items[0]?.chips).toEqual(expect.arrayContaining(['我', '甲']));
  });
});
