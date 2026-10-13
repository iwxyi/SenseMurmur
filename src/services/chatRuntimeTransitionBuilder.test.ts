import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../types/chat';
import {
  DEFAULT_CHARACTER_BEHAVIOR,
  DEFAULT_CHARACTER_INTERVENTION,
  DEFAULT_CHARACTER_MEMORY,
  DEFAULT_EMOTIONAL_STATE,
  type AICharacter,
} from '../types/character';
import type { ConflictDevelopmentHook, ConflictFocusPayload } from '../types/runtimeEvent';
import type { MemoryItem } from './memoryTypes';
import { buildChatPatch, buildNextWorldState, buildRelationshipTransition, buildWorldRuntimeEvents } from './chatRuntimeTransitionBuilder';
import { resolveRuntimeEvolutionConfig } from './runtimeEvolutionConfig';

function buildChat(overrides: Partial<ReturnType<typeof normalizeConversation>> = {}) {
  return normalizeConversation({
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '群聊',
    topic: '测试',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['char-a', 'char-b', 'char-c'],
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
    ...overrides,
  });
}

function buildCharacter(id: string, name: string, layeredMemories: MemoryItem[] = []): AICharacter {
  return {
    id,
    name,
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
    emotionalState: DEFAULT_EMOTIONAL_STATE,
    relationships: [],
    layeredMemories,
    background: '',
    speakingStyle: '',
    expertise: [],
    coreProfile: { coreDesire: '', coreFear: '', valuePriority: [], socialMask: '', biases: [], interactionHabits: [] },
    group: '',
    behavior: DEFAULT_CHARACTER_BEHAVIOR,
    memory: DEFAULT_CHARACTER_MEMORY,
    intervention: DEFAULT_CHARACTER_INTERVENTION,
    isPreset: false,
    speechProfile: undefined,
    personalityDrift: {},
    modelProfileId: null,
    modelProfileIds: {},
    bubbleStyleId: null,
    runtimeTimeline: [],
    deletedAt: null,
    fieldVersions: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildRelationshipMemory(id: string, ownerId: string, subjectIds: string[], text: string, evidenceId: string, updatedAt: number): MemoryItem {
  return {
    id,
    ownerId,
    scope: 'relationship',
    layer: 'episodic',
    kind: 'resentment',
    subjectIds,
    text,
    salience: 0.8,
    confidence: 0.82,
    recency: 0.9,
    reinforcementCount: 1,
    sourceEventIds: [evidenceId],
    sourceTag: 'interaction',
    origin: 'runtime',
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('buildRelationshipTransition', () => {
  it('accepts a human message without an incoming interaction hint', () => {
    const result = buildRelationshipTransition({
      conversation: buildChat(),
      characters: [buildCharacter('char-a', '甲')],
      message: { type: 'user', senderId: 'user', content: '甲，你怎么看？' },
      previousAiMessage: null,
    });
    expect(result.characterPatches).toEqual([]);
  });

  it.each(['user', 'god'] as const)('does not attribute private %s input to the AI pair', (type) => {
    const chat = buildChat({
      type: 'ai_direct',
      memberIds: ['char-a', 'char-b'],
      sourceChatId: 'source-group',
      sourceMemberIds: ['char-a', 'char-b'],
    });
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');
    speaker.personalityDrift = { openness: 3 };
    const characters = [speaker, target];
    const before = structuredClone(characters);

    const result = buildRelationshipTransition({
      conversation: chat,
      characters,
      message: { type, senderId: 'user', content: '这是私下给你们的指示，请先各自想想。' },
      previousAiMessage: null,
    });

    expect(result.characterPatches).toEqual([]);
    expect(result.runtimeEvents).toEqual([]);
    expect(result.relationshipLedger).toEqual([]);
    expect(characters).toEqual(before);
  });

  it('applies a fast target emotion without inventing a lasting relationship delta', () => {
    const chat = buildChat();
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '你根本不配管这件事。',
        interactionHint: {
          kind: 'dismiss', actorId: 'char-a', targetId: 'char-b', intensity: 5, tone: 'sarcastic', evidenceText: '你根本不配管这件事。', confidence: 0.96,
          immediateImpact: { targetEmotionDelta: { irritation: 34, embarrassment: 24 } },
        },
      },
      previousAiMessage: null,
    });

    const targetPatch = result.characterPatches.find((patch) => patch.characterId === 'char-b')?.patch;
    expect(targetPatch?.emotionalState?.irritation).toBeGreaterThanOrEqual(30);
    expect(targetPatch?.emotionalState?.embarrassment).toBeGreaterThanOrEqual(20);
    expect(result.runtimeEvents.some((event) => event.eventType === 'group_relationship_shift')).toBe(false);
  });

  it('merges several same-target interaction hints into one target patch and decays only once', () => {
    const chat = buildChat();
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');
    target.emotionalState = { irritation: 40, affection: 0, insecurity: 10, excitement: 0, embarrassment: 0 };

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '你别装没听见。还有，这件事轮不到你替我决定。',
        interactionHints: [
          { kind: 'probe', actorId: 'char-a', targetId: 'char-b', intensity: 3, tone: 'annoyed', evidenceText: '你别装没听见。', confidence: 0.92, immediateImpact: { targetEmotionDelta: { irritation: 12 } } },
          { kind: 'challenge', actorId: 'char-a', targetId: 'char-b', intensity: 4, tone: 'defensive', evidenceText: '轮不到你替我决定。', confidence: 0.95, immediateImpact: { targetEmotionDelta: { irritation: 18, insecurity: 14 } } },
        ],
      },
      previousAiMessage: null,
    });

    const targetPatches = result.characterPatches.filter((patch) => patch.characterId === 'char-b');
    expect(targetPatches).toHaveLength(1);
    expect(targetPatches[0]?.patch.emotionalState?.irritation).toBeGreaterThan(40);
    expect(targetPatches[0]?.patch.emotionalState?.insecurity).toBeGreaterThan(10);
  });

  it('keeps a model-authored relationship delta directional while still affecting target emotion', () => {
    const chat = buildChat();
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '这一次我信你的判断。',
        interactionHint: {
          kind: 'support', actorId: 'char-a', targetId: 'char-b', intensity: 3, tone: 'warm', evidenceText: '这一次我信你的判断。', confidence: 0.94,
          immediateImpact: { targetEmotionDelta: { affection: 12 } },
          relationship: { delta: { warmth: 2, competence: 3, trust: 4, threat: 0, attachment: 0, deference: 0 }, labels: ['认可'], stance: '更愿意托付判断' },
        },
      },
      previousAiMessage: null,
    });

    const speakerPatch = result.characterPatches.find((patch) => patch.characterId === 'char-a')?.patch;
    const targetPatch = result.characterPatches.find((patch) => patch.characterId === 'char-b')?.patch;
    expect(speakerPatch?.relationships?.find((item) => item.characterId === 'char-b')?.trust).toBe(4);
    expect(targetPatch?.relationships).toBeUndefined();
    expect(targetPatch?.emotionalState?.affection).toBeGreaterThan(0);
  });

  it('emits localized character memory distillation events when local distillation is triggered', () => {
    const chat = buildChat();
    const speaker = buildCharacter('char-a', '甲', [
      buildRelationshipMemory('m1', 'char-a', ['char-b'], 'char-b 总爱抢话。', 'e1', 101),
      buildRelationshipMemory('m2', 'char-a', ['char-c'], 'char-c 会替 char-b 接茬。', 'e2', 102),
      buildRelationshipMemory('m3', 'char-a', ['char-b'], 'char-b 一被质疑就顶回来。', 'e3', 103),
      buildRelationshipMemory('m4', 'char-a', ['char-c'], 'char-c 常帮 char-b 圆场。', 'e4', 104),
    ]);
    const target = buildCharacter('char-b', '乙');
    const witness = buildCharacter('char-c', '丙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target, witness],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '乙你别老抢着接话。',
        interactionHint: {
          kind: 'challenge',
          actorId: 'char-a',
          targetId: 'char-b',
          intensity: 4,
          tone: 'annoyed',
          evidenceText: '乙你别老抢着接话。',
          confidence: 0.94,
        },
      },
      previousAiMessage: null,
    });

    const distillationEvent = result.runtimeEvents.find((event) => event.eventType === 'memory_distillation');
    expect(distillationEvent).toBeTruthy();
    expect(distillationEvent?.title).toBe('本地蒸馏 · 甲');
    expect(distillationEvent?.summary).toContain('乙');
    expect(distillationEvent?.summary).toContain('丙');
    expect(distillationEvent?.summary).not.toContain('char-b');
    expect(distillationEvent?.summary).not.toContain('char-c');

    const payload = distillationEvent?.metrics as { ownerType?: string; source?: string; candidateTexts?: string[] };
    expect(payload.ownerType).toBe('character');
    expect(payload.source).toBe('local');
    expect(payload.candidateTexts?.[0]).toContain('乙');
  });

  it('does not emit duplicate conflict focus events when the primary conflict has not meaningfully changed', () => {
    const developmentHooks: ConflictDevelopmentHook[] = ['invite_target_response', 'force_side_taking'];
    const existingConflict = {
      id: 'conflict-1',
      scope: 'group' as const,
      type: 'authority_challenge' as const,
      severity: 0.82,
      stage: 'open' as const,
      summary: '这句话把“谁有资格管”推到了台面上。',
      participantIds: ['char-a', 'char-b'],
      targetIds: ['char-b'],
      nextPressure: 'escalate' as const,
      developmentHooks,
      sourceEventIds: [],
      updatedAt: 1,
    };
    const chat = buildChat({
      worldState: {
        phase: 'idle',
        mood: '',
        focus: '',
        recentEvent: existingConflict.summary,
        conflictAxes: [{ title: '归属/身份冲突', poles: ['默认认同', '公开争夺'], currentTilt: -30 }],
        conflictState: {
          primaryConflict: existingConflict,
          activeConflicts: [existingConflict],
          developmentHooks,
          volatility: existingConflict.severity,
          cooling: 0,
          updatedAt: 1,
        },
      },
    });
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '乙你别总一副要管全场的样子。',
        interactionHint: {
          kind: 'challenge',
          actorId: 'char-a',
          targetId: 'char-b',
          intensity: 4,
          tone: 'annoyed',
          evidenceText: '乙你别总一副要管全场的样子。',
          confidence: 0.93,
        },
        conflictFocus: {
          present: true,
          type: 'authority_challenge',
          severity: 0.82,
          stage: 'open',
          summary: '这句话把“谁有资格管”推到了台面上。',
          primaryTargetIds: ['char-b'],
          participantIds: ['char-a', 'char-b'],
          nextPressure: 'escalate',
          developmentHooks: ['invite_target_response', 'force_side_taking'],
        },
      },
      previousAiMessage: null,
    });

    expect(result.runtimeEvents.some((event) => event.eventType === 'conflict_focus_shift')).toBe(false);
  });

  it('rejects high-severity conflict focus without enough evidence reason text', () => {
    const chat = buildChat();
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '这句话直接把矛盾升级了。',
        interactionHint: {
          kind: 'challenge',
          actorId: 'char-a',
          targetId: 'char-b',
          intensity: 4,
          tone: 'annoyed',
          evidenceText: '这句话直接把矛盾升级了。',
          confidence: 0.93,
        },
        conflictFocus: {
          present: true,
          type: 'authority_challenge',
          severity: 0.86,
          stage: 'open',
          summary: '谁有资格主导这件事，已经出现正面碰撞。',
          primaryTargetIds: ['char-b'],
          participantIds: ['char-a', 'char-b'],
          nextPressure: 'escalate',
          developmentHooks: ['invite_target_response'],
          why: '太短',
        },
      },
      previousAiMessage: null,
    });

    expect(result.runtimeEvents.some((event) => event.eventType === 'conflict_focus_shift')).toBe(false);
  });

  it('keeps core profile unchanged during runtime speech and leaves evolution to LLM distillation', () => {
    const chat = buildChat();
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');
    speaker.coreProfile = {
      coreDesire: '想被当作可靠的人。',
      coreFear: '',
      socialMask: '',
      valuePriority: [],
      biases: [],
      interactionHabits: [],
    };

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '乙你别老抢着接话，凭什么总是一副要管全场的样子？你是不是看不起我？',
        interactionHint: {
          kind: 'challenge',
          actorId: 'char-a',
          targetId: 'char-b',
          intensity: 4,
          tone: 'annoyed',
          evidenceText: '乙你别老抢着接话，凭什么总是一副要管全场的样子？你是不是看不起我？',
          confidence: 0.94,
        },
      },
      previousAiMessage: null,
    });

    const speakerPatch = result.characterPatches.find((patch) => patch.characterId === 'char-a')?.patch;
    expect(speakerPatch?.coreProfile).toBeUndefined();
  });

  it.each(['group', 'ai_direct'] as const)('writes %s relationship deltas back to global character relationships and the room ledger', (type) => {
    const chat = buildChat(type === 'ai_direct' ? {
      type,
      memberIds: ['char-a', 'char-b'],
      sourceChatId: 'source-group',
      sourceMemberIds: ['char-a', 'char-b'],
    } : {});
    const speaker = buildCharacter('char-a', '甲');
    speaker.relationships = [{ characterId: 'char-b', warmth: 30, competence: 20, trust: 25, threat: 4, attachment: 12, deference: 8, note: '甲认可乙，但仍会观察。' }];
    const target = buildCharacter('char-b', '乙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '乙，这次你处理得不错。',
        interactionHint: {
          kind: 'support',
          actorId: 'char-a',
          targetId: 'char-b',
          intensity: 4,
          tone: 'warm',
          evidenceText: '乙，这次你处理得不错。',
          confidence: 0.94,
          relationship: { delta: { warmth: 2, trust: 2 }, labels: ['支持'], stance: '这次确实值得肯定' },
        },
      },
      previousAiMessage: null,
    });

    const speakerPatch = result.characterPatches.find((patch) => patch.characterId === 'char-a')?.patch;
    expect(speakerPatch?.relationships?.[0]).toMatchObject({ characterId: 'char-b', warmth: 32, trust: 27 });
    const ledger = result.relationshipLedger.find((entry) => entry.pairKey === 'char-a->char-b');
    expect(ledger?.baseline).toMatchObject({ warmth: 30, trust: 25 });
    expect(ledger?.adjustment.warmth).toBeGreaterThan(0);
    expect(ledger?.adjustment.trust).toBeGreaterThan(0);
  });

  it('treats speak-as user messages as character-authored runtime speech', () => {
    const chat = buildChat();
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'user',
        senderId: 'char-a',
        content: '乙你先别急着下结论，我觉得这里还有问题。',
        interactionHint: {
          kind: 'challenge',
          actorId: 'char-a',
          targetId: 'char-b',
          intensity: 3,
          tone: 'annoyed',
          evidenceText: '乙你先别急着下结论，我觉得这里还有问题。',
          confidence: 0.91,
        },
      },
      previousAiMessage: null,
    });

    const speakerPatch = result.characterPatches.find((patch) => patch.characterId === 'char-a')?.patch;
    const targetPatch = result.characterPatches.find((patch) => patch.characterId === 'char-b')?.patch;
    expect(speakerPatch?.soulState?.lastImpulse).toBeTruthy();
    expect(speakerPatch?.emotionalState).toBeTruthy();
    expect(targetPatch?.soulState?.lastImpulse).toBeTruthy();
    expect(result.runtimeEvents.some((event) => event.eventType === 'group_relationship_shift')).toBe(false);
  });

  it('does not emit relationship shift event when interaction confidence is below gate', () => {
    const chat = buildChat();
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '乙你这样不太行。',
        interactionHint: {
          kind: 'challenge',
          actorId: 'char-a',
          targetId: 'char-b',
          intensity: 4,
          tone: 'annoyed',
          evidenceText: '乙你这样不太行。',
          confidence: 0.6,
        },
      },
      previousAiMessage: null,
    });

    expect(result.runtimeEvents.some((event) => event.eventType === 'group_relationship_shift')).toBe(false);
  });

  it('does not create pair relationship ledger for AI private thread messages without model hints', () => {
    const chat = buildChat({
      type: 'ai_direct',
      memberIds: ['char-a', 'char-b'],
      sourceMemberIds: ['char-a', 'char-b'],
      relationshipLedger: [],
    });
    const speaker = buildCharacter('char-a', '甲');
    const target = buildCharacter('char-b', '乙');

    const result = buildRelationshipTransition({
      conversation: chat,
      characters: [speaker, target],
      message: {
        type: 'ai',
        senderId: 'char-a',
        content: '乙，我觉得这件事可以一起慢慢想，你不用一个人扛着。',
      },
      previousAiMessage: null,
    });

    expect(result.relationshipLedger).toHaveLength(0);
    expect(result.runtimeEvents.some((event) => event.eventType === 'group_relationship_shift')).toBe(false);
  });
});

describe('buildWorldRuntimeEvents', () => {
  it('appends attention candidate runtime event when user mentions members in group chat', () => {
    const chat = buildChat({ runtimeEventsV2: [] });
    const patch = buildChatPatch(
      chat,
      { type: 'user', senderId: 'user', content: '甲先说说，乙也跟进。' },
      chat.worldState,
      [],
      resolveRuntimeEvolutionConfig('balanced'),
      [{ id: 'char-a', name: '甲' }, { id: 'char-b', name: '乙' }],
    );
    const runtimeEvents = patch.runtimeEventsV2 || [];
    const candidate = runtimeEvents.find((event) => event.kind === 'attention_candidate');
    expect(candidate).toBeTruthy();
    expect(candidate?.targetIds).toEqual(['char-a', 'char-b']);
  });

  it('uses message timestamp for deterministic attention candidate id and createdAt', () => {
    const chat = buildChat({ runtimeEventsV2: [] });
    const input = { type: 'user' as const, senderId: 'user', content: '甲先说说，乙也跟进。', timestamp: 456789 };
    const patchA = buildChatPatch(
      chat,
      input,
      chat.worldState,
      [],
      resolveRuntimeEvolutionConfig('balanced'),
      [{ id: 'char-a', name: '甲' }, { id: 'char-b', name: '乙' }],
    );
    const patchB = buildChatPatch(
      chat,
      input,
      chat.worldState,
      [],
      resolveRuntimeEvolutionConfig('balanced'),
      [{ id: 'char-a', name: '甲' }, { id: 'char-b', name: '乙' }],
    );
    const candidateA = (patchA.runtimeEventsV2 || []).find((event) => event.kind === 'attention_candidate');
    const candidateB = (patchB.runtimeEventsV2 || []).find((event) => event.kind === 'attention_candidate');
    expect(candidateA?.createdAt).toBe(456789);
    expect(candidateB?.createdAt).toBe(456789);
    expect(candidateA?.id).toBe(candidateB?.id);
  });

  it('backfills role-role shared phrase events from distilled group memories for each participant', () => {
    const distilled: MemoryItem = {
      id: 'distilled-role-joke',
      ownerId: 'chat-1',
      scope: 'relationship',
      layer: 'long_term',
      kind: 'bond',
      subjectIds: ['char-a', 'char-b'],
      text: '甲和乙把“雨天加班券”当作共同梗。',
      salience: 0.82,
      confidence: 0.86,
      recency: 0.7,
      reinforcementCount: 2,
      sourceEventIds: ['e1', 'e2'],
      sourceTag: 'memory_distillation',
      origin: 'distilled',
      sharedPhrase: { text: '雨天加班券', kind: 'inside_joke', visibility: 'between_actors' },
      distilledFromIds: ['m1', 'm2'],
      distilledAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const chat = buildChat({ layeredMemories: [distilled], runtimeEventsV2: [] });

    const patch = buildChatPatch(
      chat,
      { type: 'ai', senderId: 'char-a', content: '今天又下雨了，懂吧。', timestamp: 1_500 },
      chat.worldState,
      [],
      resolveRuntimeEvolutionConfig('balanced'),
      [{ id: 'char-a', name: '甲' }, { id: 'char-b', name: '乙' }],
    );
    const phrasePayloads = (patch.runtimeEventsV2 || [])
      .map((event) => event.payload as Record<string, unknown>)
      .filter((payload) => payload.eventType === 'companionship_shared_phrase');

    expect(phrasePayloads).toHaveLength(2);
    expect(phrasePayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ characterId: 'char-a', text: '雨天加班券', participantIds: ['char-a', 'char-b'], userId: undefined }),
      expect.objectContaining({ characterId: 'char-b', text: '雨天加班券', participantIds: ['char-a', 'char-b'], userId: undefined }),
    ]));
  });

  it('does not emit duplicate conflict axis and world-state events when summaries stay the same', () => {
    const previousWorldState = {
      phase: 'idle' as const,
      mood: '',
      focus: '',
      recentEvent: '这句话把“谁有资格管”推到了台面上。',
      conflictAxes: [{ title: '归属/身份冲突', poles: ['默认认同', '公开争夺'] as [string, string], currentTilt: -30 }],
    };
    const nextWorldState = {
      ...previousWorldState,
      conflictAxes: [{ title: '归属/身份冲突', poles: ['默认认同', '公开争夺'] as [string, string], currentTilt: -48 }],
    };

    const events = buildWorldRuntimeEvents(
      { type: 'ai', content: '新的一句接话' },
      previousWorldState,
      nextWorldState,
      nextWorldState.conflictAxes || [],
      resolveRuntimeEvolutionConfig('balanced'),
    );

    expect(events).toEqual([]);
  });

  it('emits a conflict axis event when the displayed summary actually changes', () => {
    const previousWorldState = {
      phase: 'idle' as const,
      mood: '',
      focus: '',
      recentEvent: '',
      conflictAxes: [{ title: '归属/身份冲突', poles: ['默认认同', '公开争夺'] as [string, string], currentTilt: -30 }],
    };
    const nextAxes = [{ title: '群体关系', poles: ['结盟', '拆台'] as [string, string], currentTilt: -40 }];
    const nextWorldState = {
      ...previousWorldState,
      conflictAxes: nextAxes,
      recentEvent: '新的局势变化',
    };

    const events = buildWorldRuntimeEvents(
      { type: 'ai', content: '新的一句接话' },
      previousWorldState,
      nextWorldState,
      nextAxes,
      resolveRuntimeEvolutionConfig('balanced'),
    );

    expect(events.some((event) => event.eventType === 'conflict_axis_shift')).toBe(true);
  });

  it('uses message timestamp for deterministic world runtime event createdAt', () => {
    const previousWorldState = {
      phase: 'idle' as const,
      mood: '',
      focus: '',
      recentEvent: '',
      conflictAxes: [],
    };
    const nextAxes = [{ title: '群体关系', poles: ['结盟', '拆台'] as [string, string], currentTilt: -40 }];
    const nextWorldState = {
      ...previousWorldState,
      conflictAxes: nextAxes,
      recentEvent: '新的局势变化',
    };

    const events = buildWorldRuntimeEvents(
      { type: 'ai', content: '新的一句接话', timestamp: 777 },
      previousWorldState,
      nextWorldState,
      nextAxes,
      resolveRuntimeEvolutionConfig('balanced'),
    );

    expect(events[0]?.createdAt).toBe(777);
  });

  it('preserves conflict state without an evidenced update and accepts an explicit low-heat resolution', () => {
    const developmentHooks: ConflictDevelopmentHook[] = ['invite_target_response'];
    const chat = buildChat({
      worldState: {
        phase: 'idle',
        mood: '',
        focus: '',
        recentEvent: '旧矛盾',
        conflictAxes: [],
        conflictState: {
          primaryConflict: {
            id: 'conflict-1',
            scope: 'group',
            type: 'authority_challenge',
            severity: 0.66,
            stage: 'open',
            summary: '旧矛盾',
            participantIds: ['char-a', 'char-b'],
            targetIds: ['char-b'],
            nextPressure: 'escalate',
            developmentHooks,
            sourceEventIds: [],
            updatedAt: 1,
          },
          activeConflicts: [{
            id: 'conflict-1',
            scope: 'group',
            type: 'authority_challenge',
            severity: 0.66,
            stage: 'open',
            summary: '旧矛盾',
            participantIds: ['char-a', 'char-b'],
            targetIds: ['char-b'],
            nextPressure: 'escalate',
            developmentHooks,
            sourceEventIds: [],
            updatedAt: 1,
          }],
          developmentHooks,
          volatility: 0.66,
          cooling: 0,
          updatedAt: 1,
        },
      },
    });

    const result = buildNextWorldState(chat, {
      type: 'ai',
      senderId: 'char-c',
      content: '现在换个话题继续聊别的。',
      conflictFocus: null,
    });

    expect(result.worldState.conflictState).toEqual(chat.worldState.conflictState);
    let next = result.worldState;
    for (let i = 0; i < 30; i += 1) {
      next = buildNextWorldState({ ...chat, worldState: next }, {
        type: 'ai', senderId: 'char-c', content: '别的话题。', conflictFocus: null,
      }).worldState;
    }
    expect(next.conflictState).toEqual(chat.worldState.conflictState);
    for (const message of [
      { type: 'user' as const, senderId: 'user', content: '先停一下。' },
      { type: 'ai' as const, senderId: 'char-a', content: '别的话题。' },
      { type: 'ai' as const, senderId: 'char-a', content: '已经说清楚。', isDeleted: true },
      { type: 'ai' as const, senderId: 'char-a', content: '已经说清楚。', metadata: { visibility: 'pair_private' as const } },
    ]) {
      const unchanged = buildNextWorldState(chat, { ...message, timestamp: 200,
        conflictFocus: { present: true, conflictId: 'conflict-1', type: 'authority_challenge', severity: 0,
          stage: 'resolved', summary: '已经说清楚。', participantIds: ['char-a', 'char-b'], evidenceText: '已经说清楚' },
      });
      expect(unchanged.nextConflictState).toEqual(chat.worldState.conflictState);
    }
    const invalidResolution = buildNextWorldState({ ...chat, worldState: next }, {
      type: 'ai', senderId: 'char-a', content: '明天再谈。',
      conflictFocus: { present: true, conflictId: 'conflict-1', type: 'authority_challenge', severity: 0,
        stage: 'resolved', summary: '这次越权的事说清楚了。', participantIds: ['char-a', 'char-b'],
        evidenceText: '这次越权的事说清楚了' },
    });
    expect(invalidResolution.nextConflictState?.primaryConflict?.id).toBe('conflict-1');
    expect(invalidResolution.nextConflictState?.primaryConflict?.stage).toBe('open');
    expect(invalidResolution.nextConflictState).toEqual(chat.worldState.conflictState);
    const resolved = buildNextWorldState({ ...chat, worldState: next }, {
      type: 'ai', senderId: 'char-a', content: '这次越权的事说清楚了。',
      conflictFocus: { present: true, conflictId: 'conflict-1', type: 'authority_challenge', severity: 0.1,
        evidenceText: '这次越权的事说清楚了',
        stage: 'resolved', summary: '这次越权的事说清楚了。', participantIds: ['char-a', 'char-b'],
        primaryTargetIds: ['char-b'], nextPressure: 'cool' },
    });
    expect(resolved.worldState.conflictState?.primaryConflict).toBeNull();
    expect(resolved.worldState.conflictState?.activeConflicts).toEqual([]);
  });

  it('updates only the evidenced conflict and keeps multi-bubble state equal to a single send', () => {
    let chat = buildChat();
    for (const [type, severity] of [
      ['authority_challenge', 0.8], ['goal_conflict', 0.6],
    ] as const) {
      chat = { ...chat, worldState: buildNextWorldState(chat, {
        type: 'ai', senderId: 'char-a', content: '这件事仍有争议。', timestamp: 100,
        conflictFocus: { present: true, type, severity, stage: 'open', summary: '这件事仍有争议。',
          participantIds: ['char-a', 'char-b'], evidenceText: '仍有争议', why: '双方仍然公开争论此事。' },
      }).worldState };
    }
    const untouched = chat.worldState.conflictState?.activeConflicts.find((item) => item.type === 'authority_challenge');
    const goalId = chat.worldState.conflictState?.primaryConflict?.id;
    expect(untouched).toBeDefined();
    const cooled = buildNextWorldState(chat, {
      type: 'ai', senderId: 'char-a', content: '目标分歧缓和了，还没解决。', timestamp: 200,
      conflictFocus: { present: true, conflictId: goalId, type: 'goal_conflict', severity: 0.2, stage: 'cooling',
        summary: '目标分歧缓和了，还没解决。', participantIds: ['char-a', 'char-b'], nextPressure: 'cool',
        evidenceText: '目标分歧缓和了，还没解决' },
    });
    expect(cooled.nextConflictState?.primaryConflict).toMatchObject({ id: goalId, severity: 0.2, stage: 'cooling' });
    expect(cooled.nextConflictState?.activeConflicts.find((item) => item.id === untouched?.id)).toEqual(untouched);
    let multiBubble = cooled.worldState;
    for (let i = 0; i < 4; i += 1) {
      multiBubble = buildNextWorldState({ ...chat, worldState: multiBubble }, {
        type: 'ai', senderId: 'char-a', content: '另一条消息。', timestamp: 201 + i,
      }).worldState;
    }
    expect(multiBubble.conflictState).toEqual(cooled.nextConflictState);
    const resolved = buildNextWorldState({ ...chat, worldState: multiBubble }, {
      type: 'ai', senderId: 'char-a', content: '目标分歧已经解决。', timestamp: 300,
      conflictFocus: { present: true, conflictId: goalId, type: 'goal_conflict', severity: 0, stage: 'resolved',
        summary: '目标分歧已经解决。', participantIds: ['char-a', 'char-b'], evidenceText: '目标分歧已经解决' },
    });
    expect(resolved.nextConflictState?.primaryConflict).toEqual(untouched);
    expect(resolved.nextConflictState?.activeConflicts).toEqual([untouched]);
  });

  it.each(['goal_conflict', 'value_conflict', 'tone_escalation', 'identity_ownership'] as const)(
    'records %s without deriving axis poles or alliances from pressure', (type) => {
      for (const nextPressure of ['cool', 'stabilize', 'escalate'] as const) {
        const chat = buildChat({
          style: 'debate',
          dramaRules: { allowCliques: true, allowMockery: true, allowAlliances: true, allowContempt: true },
        });
        const message = { type: 'ai' as const, senderId: 'char-a', content: '这条风险还没有解决。', timestamp: 123456,
          conflictFocus: {
            present: true, type, severity: 0.8, stage: 'open', summary: '上线风险尚未解决。',
            participantIds: ['char-a', 'char-b'], primaryTargetIds: ['char-b'], nextPressure,
            developmentHooks: ['invite_target_response'], why: '双方还在争议当前方案是否能够上线。',
            evidenceText: '这条风险还没有解决',
          } satisfies ConflictFocusPayload,
        };
        const result = buildNextWorldState(chat, message);
        expect(result.nextConflictState?.primaryConflict).toMatchObject({ type, nextPressure, summary: '上线风险尚未解决。' });
        expect(result.nextConflictAxes.every((axis) => axis.currentTilt === 0)).toBe(true);
        expect(result.worldState.structuredRoomState?.alliances || []).toEqual([]);
        const events = buildWorldRuntimeEvents(message, chat.worldState, result.worldState, result.nextConflictAxes,
          resolveRuntimeEvolutionConfig('balanced'));
        expect(events.some((event) => event.eventType === 'conflict_axis_shift')).toBe(false);
        expect(events.some((event) => event.summary?.includes('结盟'))).toBe(false);

        const configured = { ...chat, worldState: { ...chat.worldState,
          conflictAxes: [{ title: '自定义轴', poles: ['保留', '调整'] as [string, string], currentTilt: -26 }],
        } };
        expect(buildNextWorldState(configured, message).nextConflictAxes).toEqual(configured.worldState.conflictAxes);
        expect(buildNextWorldState(configured, { type: 'ai', senderId: 'char-a', content: '继续。' }).worldState.recentEvent).toBe('');
      }
    },
  );

  it('does not adopt high-severity conflict focus into world state without evidence reason', () => {
    const chat = buildChat();
    const result = buildNextWorldState(chat, {
      type: 'ai',
      senderId: 'char-a',
      content: '这里冲突很大。',
      conflictFocus: {
        present: true,
        type: 'authority_challenge',
        severity: 0.9,
        stage: 'escalating',
        summary: '冲突升级，关系正面碰撞。',
        participantIds: ['char-a', 'char-b'],
        primaryTargetIds: ['char-b'],
        nextPressure: 'escalate',
        developmentHooks: ['raise_stakes'],
        why: '不足',
      },
    });
    expect(result.worldState.conflictState).toBeNull();
  });

  it('uses message timestamp to keep conflict state ids and updatedAt deterministic', () => {
    const chat = buildChat();
    const payload: import('../types/runtimeEvent').ConflictFocusPayload = {
      present: true as const,
      type: 'authority_challenge' as const,
      severity: 0.76,
      stage: 'open' as const,
      summary: '围绕主导权的公开冲突开始成形。',
      participantIds: ['char-a', 'char-b'],
      primaryTargetIds: ['char-b'],
      nextPressure: 'escalate' as const,
      developmentHooks: ['invite_target_response'],
      why: '一方要求主导，另一方公开反驳并质疑资格。',
      evidenceText: '冲突正在形成',
    };
    const resultA = buildNextWorldState(chat, {
      type: 'ai',
      senderId: 'char-a',
      content: '冲突正在形成。',
      timestamp: 123456,
      conflictFocus: payload,
    });
    const resultB = buildNextWorldState(chat, {
      type: 'ai',
      senderId: 'char-a',
      content: '冲突正在形成。',
      timestamp: 123456,
      conflictFocus: payload,
    });

    expect(resultA.worldState.conflictState?.primaryConflict?.id).toBe(resultB.worldState.conflictState?.primaryConflict?.id);
    expect(resultA.worldState.conflictState?.updatedAt).toBe(123456);
    expect(resultB.worldState.conflictState?.updatedAt).toBe(123456);
    for (const invalid of [
      { ...payload, evidenceText: undefined },
      { ...payload, evidenceText: '没有说过的话' },
      { ...payload, participantIds: ['char-a', 'unknown'] },
    ]) {
      const rejected = buildNextWorldState(chat, { type: 'ai', senderId: 'char-a', content: '冲突正在形成。', conflictFocus: invalid });
      expect(rejected.nextConflictState).toBeNull();
      expect(rejected.nextConflictAxes).toEqual(buildNextWorldState(chat, { type: 'ai', senderId: 'char-a', content: '冲突正在形成。' }).nextConflictAxes);
    }
    for (const invalidMessage of [
      { isDeleted: true },
      { senderId: 'unknown' },
      { metadata: { visibility: 'pair_private' as const } },
      { metadata: { withdrawal: { withdrawn: true } } },
    ]) {
      expect(buildNextWorldState(chat, { type: 'ai', senderId: 'char-a', content: '冲突正在形成。', conflictFocus: payload,
        ...invalidMessage }).nextConflictState).toBeNull();
    }
  });
});
