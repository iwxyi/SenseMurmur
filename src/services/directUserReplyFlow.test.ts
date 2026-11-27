import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConversation } from '../types/chat';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CHARACTER_INTERVENTION, DEFAULT_EMOTIONAL_STATE, type AICharacter } from '../types/character';
import type { Message } from '../types/message';
import { DEFAULT_API_CONFIG } from '../types/settings';
import { generateJsonResponse } from './aiClient';
import { buildCompanionshipPhaseEventFromDirectUserMessage, resolveCompanionshipPhaseEventFromDirectUserMessage } from './directCompanionshipPhase';
import { runDirectUserReplyFlow } from './directUserReplyFlow';

vi.mock('./aiClient', () => ({
  generateJsonResponse: vi.fn(),
}));

const directFlowMocks = vi.hoisted(() => ({
  generateAndCommitAiMessage: vi.fn(),
  resolveSessionEngine: vi.fn(),
}));

vi.hoisted(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
    configurable: true,
  });
});

vi.mock('./aiMessageOrchestrator', () => ({
  generateAndCommitAiMessage: directFlowMocks.generateAndCommitAiMessage,
}));

vi.mock('./sessionEngineRegistry', () => ({
  resolveSessionEngine: directFlowMocks.resolveSessionEngine,
}));

const generateJsonResponseMock = vi.mocked(generateJsonResponse);

beforeEach(() => {
  generateJsonResponseMock.mockReset();
  directFlowMocks.generateAndCommitAiMessage.mockReset();
  directFlowMocks.resolveSessionEngine.mockReset();
  generateJsonResponseMock.mockResolvedValue(JSON.stringify({
    phase: { shouldCreate: false },
    careTopics: [],
    userProfile: { shouldCreate: false, items: [] },
  }));
  directFlowMocks.resolveSessionEngine.mockReturnValue({
    buildGenerationPromptContext: vi.fn(() => null),
    onMessageCommitted: vi.fn(() => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] })),
  });
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
    memory: {
      shortTermSummary: '',
      longTerm: [],
      secrets: [],
      obsessions: [],
      tabooTopics: [],
      userMemories: [],
    },
    intervention: DEFAULT_CHARACTER_INTERVENTION,
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function chat(type: 'direct' | 'group' = 'direct') {
  return normalizeConversation({
    id: 'chat-1',
    type,
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

describe('directUserReplyFlow companionship phase events', () => {
  it('does not create confirmed romantic phase event from local relationship text', () => {
    const event = buildCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('那我们就按恋人关系相处吧。'),
    });

    expect(event).toBeNull();
  });

  it('does not create reconciling and crisis events from local repair or conflict text', () => {
    const repair = buildCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('我们别冷战了，慢慢说开吧。'),
    });
    const crisis = buildCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('你刚刚那句话让我很不舒服，我们先冷静一下。'),
    });

    expect(repair).toBeNull();
    expect(crisis).toBeNull();
  });

  it('does not create phase events for ordinary direct or group messages', () => {
    expect(buildCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('今天晚上吃什么？'),
    })).toBeNull();
    expect(buildCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('group'),
      character: character(),
      message: message('那我们就按恋人关系相处吧。'),
    })).toBeNull();
  });

  it('does not create local crisis phase events from non-relationship discomfort text', () => {
    expect(buildCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('今天工作让我很不舒服，我得先冷静一下。'),
    })).toBeNull();
    expect(buildCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('这个游戏剧情让我很受伤。'),
    })).toBeNull();
  });

  it('uses model judgment when text api config exists', async () => {
    generateJsonResponseMock.mockResolvedValueOnce(JSON.stringify({
      shouldCreate: true,
      phase: 'confirmed',
      style: 'romantic',
      confidence: 0.86,
      reason: '用户明确确认恋人关系。',
      evidence: ['按恋人关系相处'],
    }));

    const event = await resolveCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('那我们就按恋人关系相处吧。'),
      textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
    });

    expect(generateJsonResponseMock).toHaveBeenCalledTimes(1);
    expect(event?.payload).toMatchObject({
      phase: 'confirmed',
      style: 'romantic',
      confidence: 0.86,
      decisionSource: 'model',
    });
  });

  it('accepts model-led mature and cooling phase transitions', async () => {
    generateJsonResponseMock.mockResolvedValueOnce(JSON.stringify({
      shouldCreate: true,
      phase: 'deep',
      style: 'romantic',
      confidence: 0.84,
      reason: '用户明确表达长期稳定的亲密承诺。',
      evidence: ['我们慢慢走很久也可以'],
    }));
    const deepEvent = await resolveCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('我不需要每天轰轰烈烈，但想和你慢慢走很久。'),
      textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
    });

    generateJsonResponseMock.mockResolvedValueOnce(JSON.stringify({
      shouldCreate: true,
      phase: 'cooling',
      style: 'friend',
      confidence: 0.82,
      reason: '用户明确表达希望降温并减少亲密互动。',
      evidence: ['最近先少联系一点'],
    }));
    const coolingEvent = await resolveCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('最近我们先少联系一点吧，我想把距离拉回来。'),
      textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
    });

    expect(deepEvent?.payload).toMatchObject({
      phase: 'deep',
      style: 'romantic',
      decisionSource: 'model',
    });
    expect(coolingEvent?.payload).toMatchObject({
      phase: 'cooling',
      style: 'friend',
      decisionSource: 'model',
    });
  });

  it('trusts conservative model rejection to avoid local keyword false positives', async () => {
    generateJsonResponseMock.mockResolvedValueOnce(JSON.stringify({
      shouldCreate: false,
      phase: 'none',
      style: null,
      confidence: 0.2,
      reason: '用户只是在讨论一个假设，不是确认当前关系。',
      evidence: [],
    }));

    const event = await resolveCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('如果我们按恋人关系相处，会不会很奇怪？'),
      textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
    });

    expect(event).toBeNull();
  });

  it('skips phase write when model judgment fails', async () => {
    generateJsonResponseMock.mockRejectedValueOnce(new Error('model unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const event = await resolveCompanionshipPhaseEventFromDirectUserMessage({
      chat: chat('direct'),
      character: character(),
      message: message('我们别冷战了，慢慢说开吧。'),
      textApiConfig: { provider: 'openai', apiKey: 'key', baseUrl: 'https://example.test', model: 'model' },
    });

    expect(event).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[recoverable-warning] companionship:phase-model'), expect.objectContaining({
      messagePreview: '我们别冷战了，慢慢说开吧。',
    }));
    warnSpy.mockRestore();
  });
});

describe('runDirectUserReplyFlow', () => {
  it('does not start generation or persist direct runtime when the branch reply is stale', async () => {
    const directChat = chat('direct');
    const directCharacter = character();
    const updateCharacter = vi.fn(async () => undefined);

    await expect(runDirectUserReplyFlow({
      api: DEFAULT_API_CONFIG,
      aiProfiles: [],
      chatId: directChat.id,
      chat: directChat,
      userMessage: message('改到新分支。'),
      content: '改到新分支。',
      characters: [directCharacter],
      updateCharacter,
      updateCharacters: vi.fn(async () => undefined),
      upsertMessage: vi.fn(),
      appendEventMessage: vi.fn(async () => undefined),
      appendEventMessages: vi.fn(async () => undefined),
      updateChat: vi.fn(async () => undefined),
      recordSpeak: vi.fn(),
      shouldContinue: () => false,
      deferRuntimePersistenceUntilCommit: true,
    })).rejects.toThrow('单聊回复所属分支已切换');

    expect(updateCharacter).not.toHaveBeenCalled();
    expect(directFlowMocks.generateAndCommitAiMessage).not.toHaveBeenCalled();
  });

  it('uses current-turn runtime state for generation without waiting for persistence', async () => {
    const directChat = chat('direct');
    const directCharacter = character();
    let releaseUpdateCharacter!: () => void;
    const updateCharacter = vi.fn(() => new Promise<void>((resolve) => {
      releaseUpdateCharacter = resolve;
    }));
    directFlowMocks.generateAndCommitAiMessage.mockResolvedValueOnce({ results: [{ persistedMessage: { id: 'reply-1' } }] });

    const replyId = await runDirectUserReplyFlow({
      api: DEFAULT_API_CONFIG,
      aiProfiles: [],
      chatId: directChat.id,
      chat: directChat,
      userMessage: message('今天真的有点累，想安静待一会儿。'),
      content: '今天真的有点累，想安静待一会儿。',
      characters: [directCharacter],
      updateCharacter,
      updateCharacters: vi.fn(async () => undefined),
      upsertMessage: vi.fn(),
      appendEventMessage: vi.fn(async () => undefined),
      appendEventMessages: vi.fn(async () => undefined),
      updateChat: vi.fn(async () => undefined),
      recordSpeak: vi.fn(),
    });

    expect(updateCharacter).toHaveBeenCalledTimes(1);
    expect(replyId).toBe('reply-1');
    expect(directFlowMocks.generateAndCommitAiMessage).toHaveBeenCalledTimes(1);
    expect(directFlowMocks.generateAndCommitAiMessage).toHaveBeenCalledWith(expect.objectContaining({
      speaker: expect.objectContaining({
        id: directCharacter.id,
        runtimeTimeline: expect.arrayContaining([expect.objectContaining({
          type: 'memory',
          text: expect.stringContaining('今天真的有点累'),
        })]),
      }),
      characters: [expect.objectContaining({
        id: directCharacter.id,
        runtimeTimeline: expect.arrayContaining([expect.objectContaining({
          type: 'memory',
          text: expect.stringContaining('今天真的有点累'),
        })]),
      })],
    }));

    releaseUpdateCharacter();
  });
});
