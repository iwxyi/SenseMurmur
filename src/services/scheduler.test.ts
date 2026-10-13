import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { DEFAULT_CONVERSATION_DIRECTOR_CONTROLS, DEFAULT_CONVERSATION_DRAMA_RULES, DEFAULT_CONVERSATION_GOVERNANCE, DEFAULT_CONVERSATION_WORLD_STATE } from '../types/chat';
import { calculateWeights, resolvePendingReplyContext } from './scheduler';
import { resolveDirectorIntent, type DirectorIntent } from './directorIntent';

const realMathRandom = Math.random;
Math.random = () => 0;

afterAll(() => {
  Math.random = realMathRandom;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

function buildCharacter(id: string, name: string, patch: Partial<AICharacter> = {}): AICharacter {
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
    ...patch,
  };
}

function buildChat(): GroupChat {
  return {
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free' },
    name: '群聊',
    topic: '测试',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    sourceChatId: null,
    sourceMemberIds: [],
    runtimeTimeline: [],
    runtimeEventsV2: [],
    relationshipLedger: [],
    governance: DEFAULT_CONVERSATION_GOVERNANCE,
    dramaRules: DEFAULT_CONVERSATION_DRAMA_RULES,
    worldState: DEFAULT_CONVERSATION_WORLD_STATE,
    directorControls: DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  };
}

function buildMessage(patch: Partial<Message>): Message {
  return {
    id: patch.id || 'm1',
    chatId: 'chat-1',
    type: patch.type || 'ai',
    senderId: patch.senderId || 'a',
    senderName: patch.senderName || '甲',
    content: patch.content || '',
    emotion: 0,
    timestamp: patch.timestamp || 1,
    isDeleted: false,
  };
}

describe('scheduler speaker scoring', () => {
  it('boosts the actor targeted by DirectorIntent and exposes score reasons', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['b'],
      pressure: 0.9,
      reason: '用户点名乙',
    };
    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '乙，你说呢？' })],
      {},
      1,
      0,
      null,
      buildChat(),
      intent,
    );
    const a = candidates.find((candidate) => candidate.characterId === 'a');
    const b = candidates.find((candidate) => candidate.characterId === 'b');
    expect(b?.weight).toBeGreaterThan(a?.weight || 0);
    expect(b?.scoreBreakdown?.addressed).toBeGreaterThanOrEqual(0.86);
    expect(b?.scoreBreakdown?.topicRelevance).toBeGreaterThan(0);
    expect(b?.scoreBreakdown?.lineInvolvement).toBeGreaterThan(0);
    expect(b?.scoreBreakdown?.reasons).toContain('director:answer:target');
    expect(b?.scoreBreakdown?.reasons).toContain('direct_user_address');
  });

  it('surfaces emotional aftermath as a speaker reason', () => {
    const candidates = calculateWeights(
      [
        buildCharacter('a', '甲'),
        buildCharacter('b', '乙', { emotionalState: { irritation: 18, affection: 0, insecurity: 6, excitement: 0, embarrassment: 0 } }),
      ],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '你这也太不靠谱了吧？' })],
      {},
      1,
      0,
      null,
      buildChat(),
    );

    const b = candidates.find((candidate) => candidate.characterId === 'b');
    expect(b?.scoreBreakdown?.emotionalPressure).toBeGreaterThan(0);
    expect(b?.scoreBreakdown?.reasons).toContain('emotion:tension');
  });

  it('surfaces inner-life pressure when a character has been ignored for several turns', () => {
    const now = Date.now();
    const candidates = calculateWeights(
      [
        buildCharacter('a', '甲', { behavior: { proactivity: 22, aggressiveness: 20, humorIntensity: 20, empathyLevel: 40, summarizing: 20, offTopic: 5 } }),
        buildCharacter('b', '乙', {
          behavior: { proactivity: 70, aggressiveness: 20, humorIntensity: 30, empathyLevel: 60, summarizing: 20, offTopic: 5 },
          soulState: {
            mood: { pleasure: -8, arousal: 18, dominance: 42 }, energy: 48, attention: 44,
            loneliness: 52, repression: 8, shame: 0, envy: 0, trustInRoom: 48, ignoredStreak: 2,
          },
        }),
        buildCharacter('c', '丙', { behavior: { proactivity: 28, aggressiveness: 20, humorIntensity: 20, empathyLevel: 40, summarizing: 20, offTopic: 5 } }),
      ],
      [
        buildMessage({ id: 'b0', senderId: 'b', senderName: '乙', content: '我刚才那个线索其实还没说完。', timestamp: now - 50_000 }),
        buildMessage({ id: 'a1', senderId: 'a', senderName: '甲', content: '先聊别的吧。', timestamp: now - 40_000 }),
        buildMessage({ id: 'c1', senderId: 'c', senderName: '丙', content: '我也想换个话题。', timestamp: now - 30_000 }),
        buildMessage({ id: 'a2', senderId: 'a', senderName: '甲', content: '天气倒是不错。', timestamp: now - 20_000 }),
        buildMessage({ id: 'c2', senderId: 'c', senderName: '丙', content: '嗯，出去走走也行。', timestamp: now - 10_000 }),
      ],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] },
    );

    const b = candidates.find((candidate) => candidate.characterId === 'b');
    expect(b?.scoreBreakdown?.innerLifePressure).toBeGreaterThan(0);
    expect(b?.scoreBreakdown?.reasons.some((reason) => reason.startsWith('inner:seek_attention'))).toBe(true);
  });

  it('uses an explicit relationship stake to rank a character above a generic bystander', () => {
    const candidates = calculateWeights(
      [
        buildCharacter('a', '甲'),
        buildCharacter('b', '乙', { relationships: [{ characterId: 'a', warmth: 28, competence: 12, trust: 20, threat: 2 }], coreProfile: { coreDesire: '不让熟人替别人吞下代价' } }),
        buildCharacter('c', '丙'),
      ],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '这个亏我先吃了，别耽误大家。' })],
      {}, 1, 0, null, { ...buildChat(), memberIds: ['a', 'b', 'c'] },
    );
    const b = candidates.find((candidate) => candidate.characterId === 'b');
    const c = candidates.find((candidate) => candidate.characterId === 'c');
    expect(b?.weight).toBeGreaterThan(c?.weight || 0);
    expect(b?.scoreBreakdown?.reasons).not.toContain('character_drive:strong');
  });

  it('marks an otherwise unengaged, low-drive bystander as silence-preferring', () => {
    const candidates = calculateWeights(
      [
        buildCharacter('a', '甲'),
        buildCharacter('b', '乙', { behavior: { proactivity: 8, aggressiveness: 10, humorIntensity: 10, empathyLevel: 20, summarizing: 10, offTopic: 5 }, personality: { openness: 30, extroversion: 5, agreeableness: 50, neuroticism: 50, humor: 20, creativity: 20, assertiveness: 20, empathy: 30 } }),
      ],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '今晚先散了吧。' })],
      {}, 1, 0, null, buildChat(),
    );
    const b = candidates.find((candidate) => candidate.characterId === 'b');
    expect(b?.scoreBreakdown?.reasons).toContain('character_drive:let_silence_stand');
  });

  it('does not treat generic second-person wording as an explicit direct cue', () => {
    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '你这也太不靠谱了吧？' })],
      {},
      1,
      0,
      null,
      buildChat(),
    );

    const b = candidates.find((candidate) => candidate.characterId === 'b');
    expect(b?.scoreBreakdown?.addressed).toBe(0);
  });

  it('boosts a direct cue only when the previous AI line explicitly addresses that actor', () => {
    const addressedMessage = buildMessage({ senderId: 'a', senderName: '甲', content: '刚才那个锅底方案我不太同意。' }) as Message & {
      addressedTargetIds: string[];
      primaryAddressedTargetId: string;
    };
    addressedMessage.addressedTargetIds = ['b'];
    addressedMessage.primaryAddressedTargetId = 'b';

    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      [addressedMessage],
      {},
      1,
      0,
      null,
      buildChat(),
    );

    const b = candidates.find((candidate) => candidate.characterId === 'b');
    expect(b?.scoreBreakdown?.addressed).toBeGreaterThanOrEqual(0.62);
    expect(b?.scoreBreakdown?.reasons).toContain('direct_message_address');
  });

  it('treats strong interaction hints as pending replies for the target actor', () => {
    const challengedMessage = buildMessage({ senderId: 'a', senderName: '甲', content: '乙，这个方案你得解释。' });
    challengedMessage.interactionHints = [{
      actorId: 'a',
      targetId: 'b',
      kind: 'challenge',
      tone: 'cold',
      intensity: 3,
      confidence: 0.86,
      evidenceText: challengedMessage.content,
    }];

    const pending = resolvePendingReplyContext(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')],
      [challengedMessage],
    );
    expect(pending?.primaryTargetId).toBe('b');

    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')],
      [challengedMessage],
      {},
      1,
      0,
      pending,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] },
    );

    const b = candidates.find((candidate) => candidate.characterId === 'b');
    const c = candidates.find((candidate) => candidate.characterId === 'c');
    expect(b?.weight).toBeGreaterThan(c?.weight || 0);
    expect(b?.scoreBreakdown?.reasons).toContain('pending_reply');
    expect(b?.scoreBreakdown?.addressed).toBeGreaterThan(0);
  });

  it('keeps reply targets attached to the complete multi-bubble turn', () => {
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')];
    const first = buildMessage({ id: 'm1', senderId: 'a', senderName: '甲', content: '乙，你什么时候知道的？', timestamp: 1 }) as Message & {
      addressedTargetIds?: string[] | null;
      primaryAddressedTargetId?: string | null;
    };
    first.addressedTargetIds = ['b'];
    first.primaryAddressedTargetId = 'b';
    first.metadata = { turnSegment: { index: 0, count: 3 } };
    const second = buildMessage({ id: 'm2', senderId: 'a', senderName: '甲', content: '谁递的话', timestamp: 2 });
    second.metadata = { turnSegment: { index: 1, count: 3 } };
    const third = buildMessage({ id: 'm3', senderId: 'a', senderName: '甲', content: '还是你自己去过？', timestamp: 3 });
    third.metadata = { turnSegment: { index: 2, count: 3 } };

    const pending = resolvePendingReplyContext(characters, [first, second, third]);

    expect(pending).toMatchObject({
      primaryTargetId: 'b',
      sourceSpeakerId: 'a',
      sourceMessageId: 'm3',
    });
  });

  it('keeps an explicit reply debt open when another member interrupts', () => {
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')];
    const addressed = buildMessage({ id: 'm1', senderId: 'a', senderName: '甲', content: '乙，这件事你来答。', timestamp: 1 }) as Message & {
      addressedTargetIds?: string[] | null;
      primaryAddressedTargetId?: string | null;
    };
    addressed.addressedTargetIds = ['b'];
    addressed.primaryAddressedTargetId = 'b';
    const interruption = buildMessage({ id: 'm2', senderId: 'c', senderName: '丙', content: '等一下，我先说一句。', timestamp: 2 });

    expect(resolvePendingReplyContext(characters, [addressed, interruption])).toMatchObject({
      primaryTargetId: 'b',
      sourceSpeakerId: 'a',
      sourceMessageId: 'm1',
      unmetTurns: 1,
      strength: 'strong',
    });
  });

  it('drops reply debt for departed actors and does not revive it after their return', () => {
    const addressed = { id: 'departure-question', type: 'ai', senderId: 'a', content: '路上小心。',
      timestamp: Date.now() - 1000, addressedTargetIds: ['b'], primaryAddressedTargetId: 'b' } as Message;
    const b = buildCharacter('b', '乙', { presence: { status: 'away', updatedAt: Date.now(), unavailableUntil: Date.now() + 60_000 } });
    const a = buildCharacter('a', '甲');
    expect(resolvePendingReplyContext([a, b], [addressed])).toBeNull();
    expect(resolvePendingReplyContext([a, { ...b, presence: { ...b.presence!, status: 'online' } }], [addressed])).toBeNull();
    expect(resolvePendingReplyContext([a, buildCharacter('b', '乙')], [addressed])?.primaryTargetId).toBe('b');
  });

  it('keeps reply debt when an online actor merely updates their activity', () => {
    const addressed = Object.assign(buildMessage({ senderId: 'a', timestamp: 1000 }), {
      addressedTargetIds: ['b'], primaryAddressedTargetId: 'b',
    });
    const b = buildCharacter('b', '乙', { presence: { status: 'online', updatedAt: 2000, activity: '修器械' } });
    expect(resolvePendingReplyContext([buildCharacter('a', '甲'), b], [addressed])?.primaryTargetId).toBe('b');
  });

  it('settles an earlier reply debt after the addressed member speaks', () => {
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')];
    const addressed = buildMessage({ id: 'm1', senderId: 'a', senderName: '甲', content: '乙，这件事你来答。', timestamp: 1 }) as Message & {
      addressedTargetIds?: string[] | null;
      primaryAddressedTargetId?: string | null;
    };
    addressed.addressedTargetIds = ['b'];
    addressed.primaryAddressedTargetId = 'b';

    expect(resolvePendingReplyContext(characters, [
      addressed,
      buildMessage({ id: 'm2', senderId: 'c', senderName: '丙', content: '我先插一句。', timestamp: 2 }),
      buildMessage({ id: 'm3', senderId: 'b', senderName: '乙', content: '行，我来答。', timestamp: 3 }),
    ])).toBeNull();
  });

  it('returns to an overdue explicit addressee when newer exchanges keep arriving', () => {
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')];
    const addressed = buildMessage({ id: 'm1', senderId: 'a', content: '丙，请你审一下风险。', timestamp: 1 }) as Message & {
      addressedTargetIds: string[];
      primaryAddressedTargetId: string;
    };
    addressed.addressedTargetIds = ['c'];
    addressed.primaryAddressedTargetId = 'c';
    const newer = buildMessage({ id: 'm2', senderId: 'b', content: '甲，口径你定。', timestamp: 2 }) as Message & {
      addressedTargetIds: string[];
    };
    newer.addressedTargetIds = ['a'];
    expect(resolvePendingReplyContext(characters, [addressed, newer])?.primaryTargetId).toBe('a');

    const continued = buildMessage({ id: 'm3', senderId: 'a', content: '乙，按这个口径做。', timestamp: 3 }) as Message & {
      addressedTargetIds: string[];
    };
    continued.addressedTargetIds = ['b'];
    expect(resolvePendingReplyContext(characters, [addressed, newer, continued])).toMatchObject({
      primaryTargetId: 'c',
      sourceMessageId: 'm1',
      unmetTurns: 2,
    });
  });

  it('does not force an unspoken member into an ordinary multi-character exchange', () => {
    const now = Date.now();
    const candidates = calculateWeights(
      [
        buildCharacter('a', '甲'),
        buildCharacter('b', '乙'),
        buildCharacter('c', '丙', { behavior: { proactivity: 35, aggressiveness: 20, humorIntensity: 20, empathyLevel: 45, summarizing: 25, offTopic: 10 } }),
      ],
      [
        buildMessage({ id: 'm1', senderId: 'a', senderName: '甲', content: '先把开业流程说清楚。', timestamp: now - 20_000 }),
        buildMessage({ id: 'm2', senderId: 'b', senderName: '乙', content: '我补一下前厅排队和点单。', timestamp: now - 10_000 }),
      ],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] },
    );

    const c = candidates.find((candidate) => candidate.characterId === 'c');
    expect(c?.scoreBreakdown?.silencePressure).toBeLessThanOrEqual(0.06);
    expect(c?.scoreBreakdown?.reasons).not.toContain('unspoken_member');
  });

  it('counts a multi-bubble turn once when detecting an unspoken member', () => {
    const now = Date.now();
    const messages = [
      ...['甲先说一段。', '甲再补一句。', '甲最后收住。'].map((content, index) => {
        const message = buildMessage({ id: `a-${index}`, senderId: 'a', senderName: '甲', content, timestamp: now - 40_000 + index });
        message.metadata = { turnSegment: { index, count: 3 } };
        return message;
      }),
      ...['乙先说一段。', '乙再补一句。', '乙最后收住。'].map((content, index) => {
        const message = buildMessage({ id: `b-${index}`, senderId: 'b', senderName: '乙', content, timestamp: now - 20_000 + index });
        message.metadata = { turnSegment: { index, count: 3 } };
        return message;
      }),
      ...['甲又说一段。', '甲又补一句。', '甲又收住。'].map((content, index) => {
        const message = buildMessage({ id: `a2-${index}`, senderId: 'a', senderName: '甲', content, timestamp: now - 10_000 + index });
        message.metadata = { turnSegment: { index, count: 3 } };
        return message;
      }),
    ];
    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')],
      messages,
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] },
    );

    const c = candidates.find((candidate) => candidate.characterId === 'c');
    expect(c?.scoreBreakdown?.reasons).toContain('unspoken_member');
  });

  it('keeps the pending responder without treating unspoken rotation as pressure', () => {
    const now = Date.now();
    const latest = buildMessage({ id: 'm3', senderId: 'a', senderName: '甲', content: '乙，那你的规矩是什么？', timestamp: now - 5_000 });
    latest.interactionHints = [{
      actorId: 'a',
      targetId: 'b',
      kind: 'probe',
      tone: 'cold',
      intensity: 3,
      confidence: 0.82,
      evidenceText: latest.content,
    }];
    const messages = [
      buildMessage({ id: 'm1', senderId: 'a', senderName: '甲', content: '先说我的规矩。', timestamp: now - 25_000 }),
      buildMessage({ id: 'm2', senderId: 'b', senderName: '乙', content: '你这规矩第一天就会卡住。', timestamp: now - 15_000 }),
      latest,
    ];
    const characters = [
      buildCharacter('a', '甲'),
      buildCharacter('b', '乙'),
      buildCharacter('c', '丙', { behavior: { proactivity: 35, aggressiveness: 20, humorIntensity: 20, empathyLevel: 45, summarizing: 25, offTopic: 10 } }),
    ];
    const pending = resolvePendingReplyContext(characters, messages);

    const candidates = calculateWeights(
      characters,
      messages,
      {},
      1,
      0,
      pending,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] },
      resolveDirectorIntent({ chat: buildChat(), characters, messages, pendingReplyContext: pending }),
    );

    const b = candidates.find((candidate) => candidate.characterId === 'b');
    const c = candidates.find((candidate) => candidate.characterId === 'c');
    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['b']);
    expect(b?.scoreBreakdown?.reasons).toContain('pending_reply');
    expect(c).toBeUndefined();
  });

  it('keeps an explicit user-directed target even during a two-actor exchange loop', () => {
    const now = Date.now();
    const latest = buildMessage({ id: 'm3', senderId: 'a', senderName: '甲', content: '乙，那你的规矩是什么？', timestamp: now - 5_000 });
    latest.interactionHints = [{
      actorId: 'a',
      targetId: 'b',
      kind: 'probe',
      tone: 'cold',
      intensity: 3,
      confidence: 0.82,
      evidenceText: latest.content,
    }];
    const messages = [
      buildMessage({ id: 'm1', senderId: 'a', senderName: '甲', content: '先说我的规矩。', timestamp: now - 25_000 }),
      buildMessage({ id: 'm2', senderId: 'b', senderName: '乙', content: '你这规矩第一天就会卡住。', timestamp: now - 15_000 }),
      latest,
    ];
    const characters = [
      buildCharacter('a', '甲'),
      buildCharacter('b', '乙'),
      buildCharacter('c', '丙', { behavior: { proactivity: 35, aggressiveness: 20, humorIntensity: 20, empathyLevel: 45, summarizing: 25, offTopic: 10 } }),
    ];
    const pending = resolvePendingReplyContext(characters, messages);
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['b'],
      pressure: 0.9,
      reason: '用户明确要求乙回答。',
    };

    const candidates = calculateWeights(
      characters,
      messages,
      {},
      1,
      0,
      pending,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] },
      intent,
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['b']);
    expect(candidates[0]?.scoreBreakdown?.reasons).toContain('pending_reply');
    expect(candidates[0]?.scoreBreakdown?.reasons).toContain('director:answer:target');
  });

  it('preserves the all-silent fallback without granting an unspoken member exclusive eligibility', () => {
    const now = Date.now();
    const messages = [
      buildMessage({ id: 'm1', senderId: 'a', senderName: '甲', content: '第一天先把规矩定死。', timestamp: now - 25_000 }),
      buildMessage({ id: 'm2', senderId: 'b', senderName: '乙', content: '规矩太硬，客人会不敢反馈。', timestamp: now - 15_000 }),
      buildMessage({ id: 'm3', senderId: 'a', senderName: '甲', content: '那就留样抽查。', timestamp: now - 5_000 }),
    ];
    const characters = [
      buildCharacter('a', '甲'),
      buildCharacter('b', '乙'),
      buildCharacter('c', '丙', { behavior: { proactivity: 35, aggressiveness: 20, humorIntensity: 20, empathyLevel: 45, summarizing: 25, offTopic: 10 } }),
    ];

    const candidates = calculateWeights(
      characters,
      messages,
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] },
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['b', 'c']);
    expect(candidates.find((candidate) => candidate.characterId === 'c')?.scoreBreakdown?.reasons).toContain('unspoken_member');
    expect(candidates.every((candidate) => candidate.scoreBreakdown?.reasons.includes('inner:stay_silent'))).toBe(true);
  });

  it('keeps a user-invited recent speaker eligible instead of giving an unspoken member the whole turn', () => {
    const now = Date.now();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')];
    const messages = [
      buildMessage({ id: 'm1', senderId: 'a', content: '记录我带回来了。', timestamp: now - 25_000 }),
      buildMessage({ id: 'm2', senderId: 'a', content: '乙，你看清了吗？', timestamp: now - 15_000 }),
      buildMessage({ id: 'm3', senderId: 'b', content: '看清了，这份记录能用。', timestamp: now - 5_000 }),
      buildMessage({ id: 'u1', type: 'user', senderId: 'user', content: '乙，你看甲这趟做得怎么样？', timestamp: now - 1_000 }),
    ];
    const intent: DirectorIntent = {
      source: 'user_message', beatType: 'invite', targetActorIds: ['b'], pressure: 0.5,
      reason: '用户邀请乙评价。',
      userGuidance: {
        kind: 'topic_shift', rawText: messages[3].content, actorIds: ['b'], mentionedActorIds: ['a'],
        hasHardConstraints: false, focusText: messages[3].content, beatType: 'invite',
        pressure: 0.5, maxTurns: 1, minTargetTurns: 1, reason: '用户邀请乙评价。',
      },
    };
    const candidates = calculateWeights(characters, messages, {}, 1, 0, null,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] }, intent);

    expect(candidates.find((candidate) => candidate.characterId === 'b')?.scoreBreakdown?.reasons).toContain('direct_user_address');
    expect(candidates.find((candidate) => candidate.characterId === 'c')).toBeUndefined();
  });

  it('drops low-pressure stay-silent candidates when another actor has a live cue', () => {
    const addressedMessage = buildMessage({ senderId: 'a', senderName: '甲', content: '乙，你来定。' }) as Message & {
      addressedTargetIds: string[];
      primaryAddressedTargetId: string;
    };
    addressedMessage.addressedTargetIds = ['b'];
    addressedMessage.primaryAddressedTargetId = 'b';

    const candidates = calculateWeights(
      [buildCharacter('b', '乙'), buildCharacter('c', '丙')],
      [addressedMessage],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['b', 'c'] },
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['b']);
  });

  it('excludes muted members from speaker candidates when mute governance is enabled', () => {
    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '乙，你说呢？' })],
      {},
      1,
      0,
      null,
      {
        ...buildChat(),
        governance: { ...DEFAULT_CONVERSATION_GOVERNANCE, allowMute: true },
        scenarioState: {
          seats: [
            { seatId: 'seat-a', seatIndex: 0, actorId: 'a' },
            { seatId: 'seat-b', seatIndex: 1, actorId: 'b', muted: true },
          ],
        },
      },
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['a']);
  });

  it('excludes temporarily away and deleted characters from speaker candidates', () => {
    const now = Date.now();
    const candidates = calculateWeights(
      [
        buildCharacter('a', '甲'),
        buildCharacter('b', '乙', {
          presence: { status: 'away', activity: '睡觉', updatedAt: now, unavailableUntil: now + 60_000 },
        }),
        buildCharacter('c', '丙', { deletedAt: now }),
      ],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '乙和丙，你们说呢？' })],
      {},
      1,
      0,
      null,
      buildChat(),
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['a']);
  });

  it('lets explicit user media guidance override cooldown and suppress non-target speakers', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['b'],
      pressure: 0.98,
      reason: '用户指定角色发送或创作图片。',
      userGuidance: {
        kind: 'media_request',
        rawText: '乙发个甲的照片',
        actorIds: ['b'],
        mentionedActorIds: ['b', 'a'],
        mediaRequest: {
          kind: 'image',
          subjectActorIds: ['a'],
          subjectText: '甲',
          actionText: '发个甲的照片',
        },
        focusText: '乙发个甲的照片',
        beatType: 'answer',
        pressure: 0.98,
        maxTurns: 1,
        reason: '用户指定角色发送或创作图片。',
      },
    };
    const now = Date.now();
    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '刚刚说过一句。', timestamp: now })],
      { b: now },
      1,
      60_000,
      null,
      buildChat(),
      intent,
    );

    const a = candidates.find((candidate) => candidate.characterId === 'a');
    const b = candidates.find((candidate) => candidate.characterId === 'b');
    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['b']);
    expect(a).toBeUndefined();
    expect(b).toBeTruthy();
    expect(b?.scoreBreakdown?.reasons).toContain('director:media_request:target');
  });

  it('uses latest topic guidance as the main topic relevance source instead of stale banter', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'invite',
      targetActorIds: [],
      pressure: 0.58,
      reason: '用户正在明确改变群聊焦点。',
      userGuidance: {
        kind: 'topic_shift',
        rawText: '新话题：狼抓羊有过错吗？狼应该抓羊吗？',
        actorIds: [],
        mentionedActorIds: [],
        focusText: '新话题：狼抓羊有过错吗？狼应该抓羊吗？',
        beatType: 'invite',
        pressure: 0.58,
        maxTurns: 3,
        reason: '用户正在明确改变群聊焦点。',
      },
    };
    const candidates = calculateWeights(
      [
        buildCharacter('banana', '蕉太狼', { expertise: ['香蕉', '甜点'] }),
        buildCharacter('ethics', '慢羊羊', { expertise: ['狼抓羊', '伦理', '自然法则'] }),
      ],
      [
        buildMessage({ id: 'm1', senderId: 'banana', senderName: '蕉太狼', content: '香蕉香蕉香蕉，灰太狼的胡子也像香蕉。', timestamp: 10 }),
        buildMessage({ id: 'm2', senderId: 'banana', senderName: '蕉太狼', content: '香蕉证件照也不是不行。', timestamp: 20 }),
        buildMessage({ id: 'm3', type: 'user', senderId: 'user', senderName: '我', content: '新话题：狼抓羊有过错吗？狼应该抓羊吗？', timestamp: 30 }),
      ],
      {},
      1,
      0,
      null,
      buildChat(),
      intent,
    );

    const banana = candidates.find((candidate) => candidate.characterId === 'banana');
    const ethics = candidates.find((candidate) => candidate.characterId === 'ethics');
    expect(ethics?.scoreBreakdown?.topicRelevance).toBeGreaterThan(banana?.scoreBreakdown?.topicRelevance || 0);
  });

  it('adds attention_state bias for actors with strong user-focused attention', () => {
    const chat = buildChat();
    chat.runtimeEventsV2 = [{
      id: 'att-1',
      conversationId: chat.id,
      kind: 'attention_candidate',
      createdAt: Date.now() - 60_000,
      actorIds: ['b'],
      targetIds: ['user'],
      summary: '乙对用户有跟进动机',
      visibility: 'derived_public',
      payload: { reason: '用户刚点名乙', confidence: 0.9, targetIds: ['user'] },
    }];
    chat.relationshipLedger = [{
      pairKey: 'b->user',
      actorId: 'b',
      targetId: 'user',
      current: { warmth: 7, trust: 6, competence: 3, threat: 1 },
      trend: 'up',
      recentEvents: [],
      lastUpdatedAt: Date.now() - 90_000,
    }];

    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '先看看谁接。' })],
      {},
      1,
      0,
      null,
      chat,
      null,
    );
    const b = candidates.find((candidate) => candidate.characterId === 'b');
    expect(b?.scoreBreakdown?.reasons).toContain('attention_state');
  });

  it('does not let attention_state override explicit targeted user guidance', () => {
    const chat = buildChat();
    chat.runtimeEventsV2 = [{
      id: 'att-1',
      conversationId: chat.id,
      kind: 'attention_candidate',
      createdAt: Date.now() - 60_000,
      actorIds: ['a'],
      targetIds: ['user'],
      summary: '甲想跟进用户',
      visibility: 'derived_public',
      payload: { reason: '用户刚点名甲', confidence: 0.9, targetIds: ['user'] },
    }];
    chat.relationshipLedger = [{
      pairKey: 'a->user',
      actorId: 'a',
      targetId: 'user',
      current: { warmth: 7, trust: 6, competence: 3, threat: 1 },
      trend: 'up',
      recentEvents: [],
      lastUpdatedAt: Date.now() - 90_000,
    }];
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['b'],
      pressure: 0.95,
      reason: '用户点名乙优先回应',
      userGuidance: {
        kind: 'direct_reply',
        rawText: '乙先说',
        actorIds: ['b'],
        mentionedActorIds: ['b'],
        focusText: '乙先说',
        beatType: 'answer',
        pressure: 0.95,
        maxTurns: 1,
        reason: '用户点名乙优先回应',
      },
    };
    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '先看看谁接。' })],
      {},
      1,
      0,
      null,
      chat,
      intent,
    );
    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['b']);
  });

  it('keeps named hard constraints active without forcing the constrained actor to monopolize speech', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'invite',
      targetActorIds: [],
      pressure: 0.84,
      reason: '用户提到角色并给出了需要持续遵守的群聊约束。',
      userGuidance: {
        kind: 'topic_shift',
        rawText: '小唐预算不超过80，别忽略她',
        actorIds: [],
        mentionedActorIds: ['tang'],
        hardConstraintActorIds: ['tang'],
        hasHardConstraints: true,
        focusText: '小唐预算不超过80，别忽略她',
        beatType: 'invite',
        pressure: 0.84,
        maxTurns: 5,
        reason: '用户提到角色并给出了需要持续遵守的群聊约束。',
      },
    };
    const now = Date.now();
    const candidates = calculateWeights(
      [buildCharacter('tang', '小唐'), buildCharacter('a', '安安'), buildCharacter('b', '周策')],
      [
        buildMessage({ senderId: 'a', senderName: '安安', content: '我倾向近一点。', timestamp: now - 10_000 }),
        buildMessage({ senderId: 'b', senderName: '周策', content: '预算先放一放。', timestamp: now }),
      ],
      { tang: now },
      1,
      60_000,
      null,
      { ...buildChat(), memberIds: ['tang', 'a', 'b'] },
      intent,
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['a']);
  });

  it('does not force a mentioned topic subject to be the next speaker', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'invite',
      targetActorIds: ['qin'],
      pressure: 0.7,
      reason: '用户提到角色并改变当前讨论焦点。',
      userGuidance: {
        kind: 'topic_shift',
        rawText: '如果秦始皇开一家主题餐馆，你们觉得第一天会发生什么？',
        actorIds: [],
        mentionedActorIds: ['qin'],
        focusText: '如果秦始皇开一家主题餐馆，你们觉得第一天会发生什么？',
        beatType: 'invite',
        pressure: 0.7,
        maxTurns: 3,
        reason: '用户提到角色并改变当前讨论焦点。',
      },
    };
    const candidates = calculateWeights(
      [
        buildCharacter('qin', '秦始皇'),
        buildCharacter('operator', '餐饮运营顾问林澈', { behavior: { proactivity: 75, aggressiveness: 35, humorIntensity: 30, empathyLevel: 45, summarizing: 40, offTopic: 10 } }),
        buildCharacter('chef', '御厨阿衡', { expertise: ['火候', '试菜', '后厨'] }),
      ],
      [buildMessage({ type: 'user', senderId: 'user', senderName: '我', content: intent.userGuidance!.rawText })],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['qin', 'operator', 'chef'] },
      intent,
    );

    expect(candidates.map((candidate) => candidate.characterId)).toContain('qin');
    expect(candidates.map((candidate) => candidate.characterId)).toContain('operator');
    expect(candidates.length).toBeGreaterThan(1);
  });

  it('suppresses a criticized hijacking actor during a corrective guidance window', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: [],
      pressure: 0.92,
      reason: '用户点名角色回应。',
      userGuidance: {
        kind: 'direct_reply',
        rawText: '我刚才是想听安安说，不是让周策替她做决定。',
        actorIds: ['anan'],
        mentionedActorIds: ['anan', 'zhou'],
        suppressedActorIds: ['zhou'],
        focusText: '我刚才是想听安安说，不是让周策替她做决定。',
        beatType: 'answer',
        pressure: 0.92,
        maxTurns: 5,
        reason: '用户点名角色回应。',
      },
    };
    const candidates = calculateWeights(
      [buildCharacter('anan', '安安'), buildCharacter('zhou', '周策'), buildCharacter('mei', '梅青')],
      [
        buildMessage({ senderId: 'anan', senderName: '安安', content: '我已经把访谈结论说清楚了。', timestamp: 10 }),
        buildMessage({ senderId: 'mei', senderName: '梅青', content: '那接下来别急着让周策重新包装。', timestamp: 20 }),
      ],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['anan', 'zhou', 'mei'] },
      intent,
    );

    expect(candidates.map((candidate) => candidate.characterId)).not.toContain('zhou');
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('defers a soft framing actor after the requested actor has answered enough', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: [],
      pressure: 0.92,
      reason: '用户点名角色回应。',
      userGuidance: {
        kind: 'direct_reply',
        rawText: '安安，你直接说吧，用户到底为什么不再用了？不用先照顾周策的汇报口径。',
        actorIds: ['anan'],
        mentionedActorIds: ['anan', 'zhou'],
        suppressedActorIds: [],
        deferredActorIds: ['zhou'],
        focusText: '安安，你直接说吧，用户到底为什么不再用了？不用先照顾周策的汇报口径。',
        beatType: 'answer',
        pressure: 0.92,
        maxTurns: 5,
        minTargetTurns: 2,
        reason: '用户点名角色回应。',
      },
    };
    const candidates = calculateWeights(
      [
        buildCharacter('anan', '安安', { behavior: { proactivity: 18, aggressiveness: 4, humorIntensity: 8, empathyLevel: 78, summarizing: 20, offTopic: 6 } }),
        buildCharacter('zhou', '周策', { behavior: { proactivity: 95, aggressiveness: 55, humorIntensity: 20, empathyLevel: 24, summarizing: 70, offTopic: 10 } }),
        buildCharacter('mei', '梅青', { behavior: { proactivity: 54, aggressiveness: 12, humorIntensity: 26, empathyLevel: 72, summarizing: 44, offTopic: 10 } }),
      ],
      [
        buildMessage({ senderId: 'anan', senderName: '安安', content: '访谈里用户主要卡在审核等待。', timestamp: 10 }),
        buildMessage({ senderId: 'anan', senderName: '安安', content: '他们不是不需要产品，是等不起。', timestamp: 20 }),
      ],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['anan', 'zhou', 'mei'] },
      intent,
    );

    expect(candidates.map((candidate) => candidate.characterId)).not.toContain('zhou');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.find((candidate) => candidate.characterId === 'mei')?.scoreBreakdown?.reasons).toContain('guidance_floor_guardian');
  });

  it('keeps suppression-only guidance from protecting the last speaker into repetition', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: [],
      pressure: 0.92,
      reason: '用户点名角色回应。',
      userGuidance: {
        kind: 'direct_reply',
        rawText: '我刚才是想听安安说，不是让周策替她做决定。',
        actorIds: ['anan'],
        mentionedActorIds: ['anan', 'zhou'],
        suppressedActorIds: ['zhou'],
        focusText: '我刚才是想听安安说，不是让周策替她做决定。',
        beatType: 'answer',
        pressure: 0.92,
        maxTurns: 5,
        reason: '用户点名角色回应。',
      },
    };
    const now = Date.now();
    const candidates = calculateWeights(
      [
        buildCharacter('anan', '安安', { behavior: { proactivity: 18, aggressiveness: 4, humorIntensity: 8, empathyLevel: 78, summarizing: 20, offTopic: 6 } }),
        buildCharacter('zhou', '周策', { behavior: { proactivity: 86, aggressiveness: 48, humorIntensity: 20, empathyLevel: 26, summarizing: 60, offTopic: 10 } }),
        buildCharacter('mei', '梅青', { behavior: { proactivity: 54, aggressiveness: 12, humorIntensity: 26, empathyLevel: 72, summarizing: 44, offTopic: 10 } }),
      ],
      [
        buildMessage({ senderId: 'mei', senderName: '梅青', content: '周策，可以先让安安把访谈原话说完。', timestamp: now - 40_000 }),
        buildMessage({ senderId: 'anan', senderName: '安安', content: '入口和客服是两个主要问题。', timestamp: now - 20_000 }),
        buildMessage({ senderId: 'anan', senderName: '安安', content: '我会把这些整理成时间表。', timestamp: now }),
      ],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['anan', 'zhou', 'mei'] },
      intent,
    );

    expect(candidates.map((candidate) => candidate.characterId)).not.toContain('anan');
    expect(candidates.map((candidate) => candidate.characterId)).not.toContain('zhou');
    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['mei']);
  });

  it('removes the previous AI speaker from normal rotation when another member can speak', () => {
    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '我刚说完，看看别人怎么想。' })],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['a', 'b', 'c'] },
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['b', 'c']);
  });

  it('keeps the previous AI speaker when explicit user guidance targets that speaker', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['a'],
      pressure: 0.95,
      reason: '用户明确要求甲继续回答',
      userGuidance: {
        kind: 'direct_reply',
        rawText: '甲继续说',
        actorIds: ['a'],
        mentionedActorIds: ['a'],
        focusText: '甲继续说',
        beatType: 'answer',
        pressure: 0.95,
        maxTurns: 1,
        reason: '用户明确要求甲继续回答',
      },
    };
    const candidates = calculateWeights(
      [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      [
        buildMessage({ senderId: 'a', senderName: '甲', content: '我先说一句。' }),
        buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '甲继续说。' }),
      ],
      {},
      1,
      0,
      null,
      buildChat(),
      intent,
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['a']);
  });

  it('penalizes repeated speakers after a user guidance turn so the room does not plan around the user', () => {
    const intent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: [],
      pressure: 0.82,
      reason: '用户给出了现场约束。',
      userGuidance: {
        kind: 'topic_shift',
        rawText: '我不是想喝酒，只是想找有无酒精选项的热闹地方。',
        actorIds: [],
        mentionedActorIds: [],
        focusText: '有无酒精选项的热闹地方',
        beatType: 'answer',
        pressure: 0.82,
        maxTurns: 4,
        reason: '用户给出了现场约束。',
        hasHardConstraints: true,
      },
    };
    const candidates = calculateWeights(
      [
        buildCharacter('a', '甲', { behavior: { proactivity: 80, aggressiveness: 40, humorIntensity: 40, empathyLevel: 50, summarizing: 50, offTopic: 20 } }),
        buildCharacter('b', '乙', { behavior: { proactivity: 55, aggressiveness: 40, humorIntensity: 40, empathyLevel: 50, summarizing: 50, offTopic: 20 } }),
      ],
      [
        buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '我不是想喝酒，只是想找有无酒精选项的热闹地方。', timestamp: 10 }),
        buildMessage({ senderId: 'a', senderName: '甲', content: '那我先问问老板。', timestamp: 20 }),
        buildMessage({ senderId: 'a', senderName: '甲', content: '价格也得问清楚。', timestamp: 30 }),
        buildMessage({ senderId: 'b', senderName: '乙', content: '还要确认音乐是不是太吵。', timestamp: 40 }),
      ],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['a', 'b'] },
      intent,
    );

    const repeated = candidates.find((candidate) => candidate.characterId === 'a');
    expect(repeated).toBeTruthy();
    expect(repeated?.scoreBreakdown?.reasons).toContain('user_presence_rotation');
    expect(repeated?.scoreBreakdown?.cooldownPenalty).toBeGreaterThan(0);
  });

  it('keeps the previous AI speaker when no other member can speak', () => {
    const candidates = calculateWeights(
      [buildCharacter('a', '甲')],
      [buildMessage({ senderId: 'a', senderName: '甲', content: '这里只有我。' })],
      {},
      1,
      0,
      null,
      { ...buildChat(), memberIds: ['a'] },
    );

    expect(candidates.map((candidate) => candidate.characterId)).toEqual(['a']);
  });
});
