import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CHARACTER_INTERVENTION, DEFAULT_EMOTIONAL_STATE, type AICharacter } from '../types/character';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import { generateJsonResponse } from './aiClient';
import { resolveDirectCompanionshipAssessmentEvents } from './directCompanionshipAssessment';
import { buildUserCompanionshipProjection } from './companionshipProjection';

vi.mock('./aiClient', () => ({
  generateJsonResponse: vi.fn(),
}));

const generateJsonResponseMock = vi.mocked(generateJsonResponse);

beforeEach(() => {
  generateJsonResponseMock.mockReset();
});

function character(): AICharacter {
  return {
    id: 'char-a',
    name: '苏苏',
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 65, neuroticism: 45, humor: 50, creativity: 50, assertiveness: 42, empathy: 72 },
    emotionalState: DEFAULT_EMOTIONAL_STATE,
    relationships: [],
    layeredMemories: [],
    background: '',
    speakingStyle: '',
    expertise: [],
    coreProfile: { coreDesire: '', coreFear: '', valuePriority: [], socialMask: '', biases: [], interactionHabits: [] },
    group: '',
    behavior: DEFAULT_CHARACTER_BEHAVIOR,
    memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
    intervention: DEFAULT_CHARACTER_INTERVENTION,
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function chat() {
  return normalizeConversation({
    id: 'chat-1',
    type: 'direct',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '测试单聊',
    topic: '',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['char-a'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

function message(content: string): Message {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    type: 'user',
    senderId: 'user',
    senderName: '用户',
    content,
    emotion: 0,
    timestamp: 1000,
    isDeleted: false,
  };
}

describe('directCompanionshipAssessment', () => {
  it('uses one model call to produce phase, care topic, and user profile events', async () => {
    generateJsonResponseMock.mockResolvedValueOnce(JSON.stringify({
      phase: {
        shouldCreate: true,
        phase: 'confirmed',
        style: 'romantic',
        confidence: 0.91,
        reason: '用户明确确认关系。',
        evidence: ['我们就按恋人关系相处吧'],
      },
      careTopics: [{
        shouldCreate: true,
        action: 'opened',
        topicText: '明天面试有点紧张',
        urgency: 'high',
        dueInHours: 48,
        confidence: 0.86,
        reason: '用户提到明天面试压力。',
        evidence: '明天面试有点紧张',
      }],
      userProfile: {
        shouldCreate: true,
        items: [{
          kind: 'address_preference',
          text: '用户希望被称呼为小夏',
          evidence: '以后叫我小夏',
          confidence: 0.9,
          sensitive: false,
        }],
        reason: '用户给出称呼偏好。',
      },
      addressing: {
        shouldCreate: true,
        action: 'set_current',
        currentAddress: '小夏',
        confidence: 0.9,
        reason: '用户明确要求当前称呼。',
        evidence: '以后叫我小夏',
      },
      promises: [{
        shouldCreate: true,
        action: 'opened',
        promiseText: '面试结束后告诉苏苏结果',
        promiseKind: 'user_followup',
        dueInHours: 48,
        confidence: 0.86,
        reason: '用户和角色形成了等用户回来说结果的约定。',
        evidence: '明天面试完我回来告诉你结果',
      }],
      sharedAnchors: [{
        shouldCreate: true,
        kind: 'milestone',
        title: '第一次约定面试后报平安',
        text: '用户和苏苏约好面试后回来告诉结果，这是两人关系里的一个小里程碑。',
        salience: 78,
        confidence: 0.87,
        reason: '用户明确把面试后的回来说结果交给当前角色记住。',
        evidence: '明天面试完我回来告诉你结果',
      }],
      sharedSecrets: [{
        shouldCreate: true,
        privateText: '用户只告诉苏苏自己其实很害怕这次面试失败。',
        publicMask: '有一件只适合私下记着的面试心事',
        consequenceKind: 'none',
        emotionalWeight: 76,
        confidence: 0.89,
        reason: '用户明确说这件事只告诉苏苏。',
        evidence: '我只告诉你，我其实很害怕这次面试失败',
      }],
      sharedPhrases: [{
        shouldCreate: true,
        action: 'upsert',
        text: '慢慢来，我在',
        kind: 'comfort_line',
        visibility: 'between_actors',
        firstSaidBy: 'char-a',
        emotionalWeight: 78,
        reuseCount: 2,
        confidence: 0.88,
        reason: '用户明确把这句话当作两人之间的安慰语。',
        evidence: '以后我们之间这句话就叫“慢慢来，我在”',
      }],
      intimateConflict: {
        shouldCreate: true,
        action: 'repair_attempted',
        kind: 'repair_attempt',
        severity: 32,
        repairReadiness: 68,
        summary: '用户愿意把刚才的不舒服说开。',
        confidence: 0.84,
        evidence: ['刚才那句话让我不舒服，但我们慢慢说开吧'],
      },
      attachmentProfile: {
        shouldCreate: true,
        inferredStyle: 'anxious',
        confidence: 0.82,
        reason: '用户明确希望重要情绪能得到确认。',
        evidence: ['我紧张的时候希望你明确回应我一下'],
        adaptations: ['多给具体确认', '不要把沉默理解成不需要回应'],
      },
    }));

    const events = await resolveDirectCompanionshipAssessmentEvents({
      chat: chat(),
      character: character(),
      message: message('以后叫我小夏。我们就按恋人关系相处吧，明天面试有点紧张。'),
      textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
    });

    expect(generateJsonResponseMock).toHaveBeenCalledTimes(1);
    expect(events.map((event) => (event.payload as { eventType?: string }).eventType)).toEqual([
      'companionship_phase_event',
      'companionship_care_topic',
      'companionship_user_profile_memory',
      'companionship_addressing',
      'companionship_promise',
      'companionship_shared_anchor',
      'companionship_shared_secret',
      'companionship_shared_phrase',
      'companionship_intimate_conflict',
      'companionship_attachment_profile',
    ]);
    expect(events[0]?.payload).toMatchObject({
      eventType: 'companionship_phase_event',
      sourceMessageIds: ['msg-1'],
      decisionSource: 'model',
    });
    expect(events[0]?.evidenceMessageIds).toEqual(['msg-1']);
    expect(events[3]?.payload).toMatchObject({
      eventType: 'companionship_addressing',
      action: 'set_current',
      currentAddress: '小夏',
      sourceMessageIds: ['msg-1'],
      decisionSource: 'model',
    });
    expect(events[3]?.evidenceMessageIds).toEqual(['msg-1']);
    expect(events[4]?.payload).toMatchObject({
      eventType: 'companionship_promise',
      action: 'opened',
      promiseText: '面试结束后告诉苏苏结果',
      promiseKind: 'user_followup',
      sourceMessageIds: ['msg-1'],
      decisionSource: 'model',
    });
    expect((events[4]?.payload as { dueAt?: number }).dueAt).toBe(1000 + 48 * 60 * 60_000);
    expect(events[4]?.evidenceMessageIds).toEqual(['msg-1']);
    expect(events[5]?.payload).toMatchObject({
      eventType: 'companionship_shared_anchor',
      action: 'upsert',
      kind: 'milestone',
      title: '第一次约定面试后报平安',
      sourceMessageIds: ['msg-1'],
      decisionSource: 'model',
    });
    expect(events[5]?.evidenceMessageIds).toEqual(['msg-1']);
    expect(events[6]?.payload).toMatchObject({
      eventType: 'companionship_shared_secret',
      action: 'recorded',
      privateText: '用户只告诉苏苏自己其实很害怕这次面试失败。',
      publicMask: '有一件只适合私下记着的面试心事',
      sourceMessageIds: ['msg-1'],
      decisionSource: 'model',
    });
    expect(events[6]?.evidenceMessageIds).toEqual(['msg-1']);
    expect(events.at(-1)?.payload).toMatchObject({
      eventType: 'companionship_attachment_profile',
      action: 'inferred',
      inferredStyle: 'anxious',
      sourceMessageIds: ['msg-1'],
      decisionSource: 'model',
    });
    expect(events.at(-1)?.evidenceMessageIds).toEqual(['msg-1']);
    expect(events.at(-2)?.payload).toMatchObject({
      eventType: 'companionship_intimate_conflict',
      action: 'repair_attempted',
      kind: 'repair_attempt',
      sourceMessageIds: ['msg-1'],
      decisionSource: 'model',
    });
    expect(events.at(-2)?.evidenceMessageIds).toEqual(['msg-1']);
    expect(events.at(-3)?.payload).toMatchObject({
      eventType: 'companionship_shared_phrase',
      action: 'upsert',
      text: '慢慢来，我在',
      kind: 'comfort_line',
      sourceMessageIds: ['msg-1'],
      decisionSource: 'model',
    });
    expect(events.at(-3)?.evidenceMessageIds).toEqual(['msg-1']);
  });

  it('carries explicit promise effects from model assessment into intimacy projection', async () => {
    generateJsonResponseMock.mockResolvedValueOnce(JSON.stringify({
      promises: [{
        shouldCreate: true,
        action: 'fulfilled',
        promiseText: '一起把误会说开',
        promiseKind: 'repair_agreement',
        relationshipEffects: { fulfilled: { intimacy: 5, security: 8 } },
        confidence: 0.9,
        evidence: '我们已经一起把误会说开了',
      }],
    }));
    const directChat = chat();
    const events = await resolveDirectCompanionshipAssessmentEvents({
      chat: directChat,
      character: character(),
      message: message('我们已经一起把误会说开了'),
      textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ relationshipEffects: { fulfilled: { intimacy: 5, security: 8 } } });
    const withoutEffects = events.map((event) => ({ ...event, payload: { ...event.payload, relationshipEffects: undefined } }));
    const project = (runtimeEventsV2: typeof events) => buildUserCompanionshipProjection({
      chat: { ...directChat, runtimeEventsV2 }, character: character(), messages: [], now: 1_000,
    }).userBond!.intimacy;
    expect(project(events).intimacy - project(withoutEffects).intimacy).toBe(5);
    expect(project(events).security - project(withoutEffects).security).toBe(8);
  });

  it.each([{ intimacy: '5' }, { intimacy: 101 }, { unknownAxis: 1 }])('reports invalid promise effects instead of applying them: %j', async (fulfilled) => {
    generateJsonResponseMock.mockResolvedValueOnce(JSON.stringify({
      promises: [{ shouldCreate: true, action: 'fulfilled', promiseText: '一起散步', confidence: 0.9, relationshipEffects: { fulfilled } }],
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const events = await resolveDirectCompanionshipAssessmentEvents({
        chat: chat(), character: character(), message: message('已经一起散步了'),
        textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
      });
      expect(events).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('companionship:direct-assessment-model'), expect.objectContaining({
        error: expect.objectContaining({ message: expect.stringContaining('Invalid promise relationshipEffects') }),
      }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips local shared phrase and intimate conflict writes when the model assessment fails', async () => {
    generateJsonResponseMock.mockRejectedValueOnce(new Error('model unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events = await resolveDirectCompanionshipAssessmentEvents({
      chat: chat(),
      character: character(),
      message: message('以后我们之间的暗号就叫“慢慢来，我在”。刚才那句话让我很受伤，我们先别聊了。'),
      textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
    });
    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[recoverable-warning] companionship:direct-assessment-model'), expect.objectContaining({
      messagePreview: '以后我们之间的暗号就叫“慢慢来，我在”。刚才那句话让我很受伤，我们先别聊了。',
    }));
    warnSpy.mockRestore();
  });
});
