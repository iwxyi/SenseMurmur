import { describe, expect, it } from 'vitest';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_EMOTIONAL_STATE, type AICharacter } from '../types/character';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import { buildCharacterMindProjection, buildCharacterMindProjectionPromptBlock } from './characterMindProjection';
import { adaptCharacterMindProjectionForPrompt } from './characterMindPromptAdapter';
import type { MemoryItem } from './memoryTypes';

function character(overrides: Partial<AICharacter> = {}): AICharacter {
  return {
    id: 'char-a',
    name: '苏苏',
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 65, neuroticism: 45, humor: 50, creativity: 50, assertiveness: 42, empathy: 72 },
    emotionalState: DEFAULT_EMOTIONAL_STATE,
    relationships: [],
    layeredMemories: [],
    background: '一个会记住共同经历的陪伴角色。',
    speakingStyle: '说话自然、克制，偶尔嘴硬。',
    expertise: [],
    coreProfile: {
      coreDesire: '希望被理解',
      coreFear: '被轻易忘记',
      valuePriority: ['关系中的诚实'],
      interactionHabits: ['先观察，再接话'],
      hiddenSoftSpots: ['用户认真回应时会放松'],
    },
    group: '',
    behavior: DEFAULT_CHARACTER_BEHAVIOR,
    memory: {
      shortTermSummary: '',
      longTerm: [],
      secrets: [],
      obsessions: [],
      tabooTopics: [],
      userMemories: ['用户不喜欢太甜的饮料。'],
    },
    intervention: { allowSpeakAs: true, allowDirectorPrompt: true, allowPrivateThread: true },
    createdAt: 1,
    updatedAt: 1,
    isPreset: false,
    ...overrides,
  };
}

function message(content: string, senderId = 'user'): Message {
  return {
    id: `m-${content}`,
    chatId: 'chat-1',
    type: senderId === 'user' ? 'user' : 'ai',
    senderId,
    senderName: senderId === 'user' ? '用户' : '小铁',
    content,
    emotion: 0,
    timestamp: 1000,
    isDeleted: false,
  };
}

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: overrides.id || 'memory-1',
    ownerId: 'char-a',
    scope: 'relationship',
    layer: 'long_term',
    kind: 'bond',
    subjectIds: ['char-b'],
    text: '一条普通记忆。',
    salience: 0.6,
    confidence: 0.75,
    recency: 0.4,
    reinforcementCount: 1,
    sourceEventIds: [],
    sourceTag: 'test',
    origin: 'runtime',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    distilledAt: null,
    distilledFromIds: [],
    distillationVersion: null,
    ...overrides,
  };
}

function chat(type: 'direct' | 'group' = 'direct') {
  return normalizeConversation({
    id: 'chat-1',
    type,
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: type === 'direct' ? '私聊' : '群聊',
    topic: '今晚喝什么',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: type === 'direct' ? ['char-a'] : ['char-a', 'char-b'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: {
      phase: 'idle',
      mood: '',
      focus: '',
      recentEvent: '',
      conflictAxes: [],
      structuredRoomState: {
        heat: 72,
        cohesion: 30,
        topicDrift: 12,
        dominantThread: ['char-a', 'char-b'],
        pileOnTarget: 'char-b',
        alliances: [['char-a', 'char-b']],
        conflictPairs: [],
        silencedActors: [],
      },
    },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

describe('characterMindProjection', () => {
  it.each([0, 30, -40])('interprets cohesion on its signed scale (%s)', (cohesion) => {
    const room = chat('group');
    room.worldState.structuredRoomState = { ...room.worldState.structuredRoomState!, cohesion };
    const speaker = character();
    const projection = buildCharacterMindProjection({ chat: room, character: speaker, characters: [speaker], messages: [], now: 2000 });
    expect(projection.room.constraints.some((line) => line.includes('凝聚度偏低'))).toBe(cohesion <= -35);
  });
  it.each([80, -80])('preserves all six relationship axes without prescribing tone (%s)', (value) => {
    const target = character({ id: 'char-b', name: '小铁' });
    const speaker = character({ relationships: [{
      characterId: target.id,
      warmth: value,
      competence: value,
      trust: value,
      threat: value,
      attachment: value,
      deference: value,
      note: '彼此共事多年，刚为一件事意见不合。',
    }] });
    const projection = buildCharacterMindProjection({
      chat: chat('group'), character: speaker, characters: [speaker, target],
      messages: [message('这次我不同意。', target.id)], now: 2000,
    });
    const evidence = projection.relationship.stance.join('');
    for (const axis of ['亲和', '能力', '信任', '威胁', '在意', '让位']) {
      expect(evidence).toContain(`${axis} ${value}`);
    }
    expect(projection.expression.temperature).toContain('长期关系不是固定口吻');
    expect(projection.hidden.conflictReasons).not.toContain('想靠近与想防备同时存在。');
    expect(projection.continuity.relationshipMemories).toContain('本人长期关系看法：彼此共事多年，刚为一件事意见不合。');
  });

  it('keeps persistent user continuity available without current-chat profile events', () => {
    const speaker = character({
      relationships: [{ characterId: 'user', warmth: 24, competence: 0, trust: 30, threat: 4, note: '愿意照顾用户，但不喜欢被强迫表态。' }],
      soulState: {
        mood: { pleasure: 50, arousal: 40, dominance: 40 },
        energy: 72,
        attention: 65,
        loneliness: 20,
        repression: 20,
        shame: 10,
        envy: 0,
        trustInRoom: 60,
        ignoredStreak: 0,
        lastImpulse: 'comfort',
        lastImpulseReason: '本地调度判断应该立即安慰',
        updatedAt: 1,
      },
    });
    const projection = buildCharacterMindProjection({
      chat: chat('direct'),
      character: speaker,
      characters: [speaker],
      messages: [message('今天太阳好大。')],
      now: 2000,
    });

    expect(projection.continuity.userProfile).toContain('用户不喜欢太甜的饮料。');
    expect(projection.hidden.memorySource).toBe('fallback_retrieval');
    expect(projection.relationship.targetName).toBe('用户');
    expect(projection.relationship.stance.join('')).toContain('本人对对方的关系感受与评价');
    expect(projection.identity.desires).toContain('希望被理解');
    expect(projection.currentState.activeNeeds).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain('本地调度判断应该立即安慰');
  });

  it('keeps authored unmet needs in standing identity rather than immediate pressure', () => {
    const speaker = character({ coreProfile: { coreDesire: '希望被理解', unmetNeeds: ['想有自己的空间'] } });
    const projection = buildCharacterMindProjection({ chat: chat('group'), character: speaker, characters: [speaker], messages: [message('今晚喝什么？')], now: 2000 });
    expect(projection.identity.desires).toEqual(['希望被理解', '想有自己的空间']);
    expect(projection.currentState.activeNeeds).toEqual([]);
  });

  it('does not treat shared anchors or artifacts as ordinary user profile facts', () => {
    const speaker = character({
      memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
      layeredMemories: [
        memory({
          id: 'shared-anchor',
          kind: 'bond',
          subjectIds: ['char-a', 'user'],
          text: '第一次深夜聊天后，苏苏记住了用户没有退出对话。',
          summary: '第一次深夜聊天后，用户没有退出对话。',
        }),
        memory({
          id: 'ordinary-user-profile',
          kind: 'trait_evidence',
          subjectIds: ['user'],
          text: '用户不喜欢太甜的饮料。',
          summary: '用户不喜欢太甜的饮料。',
        }),
      ],
    });
    const projection = buildCharacterMindProjection({
      chat: chat('direct'),
      character: speaker,
      characters: [speaker],
      messages: [message('今天太阳好大。')],
      now: 2000,
    });

    expect(projection.continuity.userProfile).toContain('用户不喜欢太甜的饮料。');
    expect(projection.continuity.userProfile.join('\n')).not.toContain('第一次深夜聊天');
  });

  it('projects authored character memory into self continuity without exposing secret text', () => {
    const speaker = character({
      memory: {
        shortTermSummary: '最近对被误解这件事有点敏感。',
        longTerm: ['曾经在雨夜替朋友守过店。'],
        secrets: ['不愿承认自己曾经临阵退缩。'],
        obsessions: ['会反复检查门有没有锁好。'],
        tabooTopics: ['被拿失败经历开玩笑时会防御。'],
        userMemories: [],
      },
    });
    const projection = buildCharacterMindProjection({
      chat: chat('group'),
      character: speaker,
      characters: [speaker],
      messages: [message('今天先聊点轻松的。', 'char-b')],
      now: 2000,
    });

    expect(projection.continuity.selfMemories).toEqual(expect.arrayContaining([
      '近期自我状态：最近对被误解这件事有点敏感。',
      '长期经历：曾经在雨夜替朋友守过店。',
      '注意力偏好：会反复检查门有没有锁好。',
      '敏感触发：被拿失败经历开玩笑时会防御。',
    ]));
    expect(projection.continuity.selfMemories.join('\n')).not.toContain('临阵退缩');
    expect(projection.hidden.privacyGuards).toContain('角色有未公开的自有内容，只能影响回避、克制或防御，不要主动揭露正文。');
  });

  it.each([true, false])('keeps recalled self experience in the ordinary group prompt with a full authored history (recent summary: %s)', (hasSummary) => {
    const speaker = character({
      memory: {
        shortTermSummary: hasSummary ? '今晚要接孩子，已经约好了时间。' : '',
        longTerm: Array.from({ length: 10 }, (_, index) => `旧经历${index + 1}`),
        secrets: ['未公开的秘密'],
        obsessions: ['旧偏好'],
        tabooTopics: [],
        userMemories: [],
      },
    });
    const recalled = ['今天已经答应替同事交一份稿。', '昨天加班错过了末班车。', '最近在攒搬家的钱。'];
    const value = buildCharacterMindProjection({
      chat: chat('group'), character: speaker, characters: [speaker],
      messages: [message('今晚还能帮忙吗？', 'char-b')],
      memoryCandidates: recalled.map((text, index) => memory({
        id: `self-${index}`, scope: 'character_self', subjectIds: [speaker.id], text,
      })),
      target: null,
      now: 2000,
    });
    const output = adaptCharacterMindProjectionForPrompt(value, {
      chatType: 'group', maxCoreLines: 7, visibleMemoryRecall: 'off',
    });

    for (const text of recalled) expect(output.coreContinuityBlock).toContain(text);
    if (hasSummary) expect(output.coreContinuityBlock).toContain('今晚要接孩子');
    expect(value.continuity.selfMemories).toContain('长期经历：旧经历1');
    expect(output.coreContinuityBlock).not.toContain('未公开的秘密');
    expect(output.coreContinuityBlock).not.toContain('旧经历10');
    expect(output.coreContinuityBlock.split('\n').filter((line) => line.startsWith('- ')).length).toBeLessThanOrEqual(7);
  });

  it.each(['assembly', 'fallback'] as const)('preserves self memory validity through the %s path', (path) => {
    const memories = [
      memory({ id: 'corrected', scope: 'character_self', text: '已被纠正的经历', validity: 'contradicted' }),
      memory({ id: 'expired', scope: 'character_self', text: '已经失效的状态', validity: 'stale' }),
      memory({ id: 'hidden', scope: 'character_self', text: '禁止显现的记忆正文', visibility: 'never_surface' }),
      ...(['joke', 'test', 'temporary'] as const).map((sourceType) => memory({
        id: sourceType, scope: 'character_self', text: `非稳定经历${sourceType}`, sourceType,
      })),
      memory({ id: 'uncertain', scope: 'character_self', text: '那天似乎答应过帮忙', validity: 'uncertain' }),
      memory({ id: 'active', scope: 'character_self', text: '昨晚加班错过末班车', validity: 'active' }),
    ];
    const speaker = character({ layeredMemories: memories });
    const projection = buildCharacterMindProjection({
      chat: chat('group'), character: speaker, characters: [speaker], messages: [],
      ...(path === 'assembly' ? { memoryCandidates: memories } : {}), now: 2000,
    });
    const output = adaptCharacterMindProjectionForPrompt(projection, { chatType: 'group', visibleMemoryRecall: 'off' });
    expect(output.coreContinuityBlock).toContain('昨晚加班错过末班车');
    expect(output.coreContinuityBlock).toContain('【尚未确认】那天似乎答应过帮忙');
    expect(output.coreContinuityBlock).not.toContain('已被纠正');
    expect(output.coreContinuityBlock).not.toContain('已经失效');
    expect(output.coreContinuityBlock).not.toContain('非稳定经历');
    expect(output.coreContinuityBlock).not.toContain('禁止显现的记忆正文');
  });

  it('keeps distilled subjective understanding distinct from established self experience in the final prompt', () => {
    const speaker = character();
    const projection = buildCharacterMindProjection({
      chat: chat('group'), character: speaker, characters: [speaker], messages: [],
      memoryCandidates: [
        memory({ scope: 'character_self', kind: 'bias', sourceTag: 'llm_memory_character_perspective', text: '经理不回消息是在针对自己。' }),
        memory({ id: 'experience', scope: 'character_self', kind: 'status_shift', text: '昨晚等回复等到十一点。' }),
      ], now: 2000,
    });
    const output = adaptCharacterMindProjectionForPrompt(projection, { chatType: 'group', visibleMemoryRecall: 'off' });
    expect(output.coreContinuityBlock).toContain('【角色的主观理解，不代表他人真实动机】经理不回消息是在针对自己。');
    expect(projection.continuity.selfMemories).toContain('昨晚等回复等到十一点。');
  });

  it('combines group pressure, target relationship, and active room lines', () => {
    const target = character({ id: 'char-b', name: '小铁' });
    const speaker = character({
      relationships: [{ characterId: 'char-b', warmth: -18, competence: 22, trust: -24, threat: 36, note: '认可能力，但对他保持戒备。' }],
    });
    const projection = buildCharacterMindProjection({
      chat: chat('group'),
      character: speaker,
      characters: [speaker, target],
      messages: [message('先别急着替我下结论。', 'char-b')],
      now: 2000,
    });

    expect(projection.relationship.targetName).toBe('小铁');
    expect(projection.relationship.stance.join('')).toContain('信任 -24');
    expect(projection.relationship.currentRoomPressure).toContain('目标正在承受房间里的集中压力。');
    expect(projection.room.activeLines.length).toBeGreaterThan(0);
    expect(projection.expression.omissions).toContain('内部状态分数');
  });

  it('keeps the global authored relationship authoritative over a stale room ledger', () => {
    const target = character({ id: 'char-b', name: '小铁' });
    const speaker = character({
      relationships: [{
        characterId: 'char-b',
        warmth: 58,
        competence: 20,
        trust: 64,
        threat: 2,
        note: '长期愿意替小铁留余地。',
      }],
    });
    const projection = buildCharacterMindProjection({
      chat: {
        ...chat('group'),
        relationshipLedger: [{
          pairKey: 'char-a->char-b',
          actorId: 'char-a',
          targetId: 'char-b',
          current: { warmth: 0, competence: 0, trust: -20, threat: 48 },
          derived: {
            semantic: {
              stage: '紧张对峙',
              labels: ['戒备'],
              summary: '紧张对峙：戒备',
              intensity: 62,
            },
          },
          trend: 'volatile',
          recentEvents: [],
          lastUpdatedAt: 20,
        }],
      },
      character: speaker,
      characters: [speaker, target],
      messages: [message('这次先别替我做决定。', 'char-b')],
      now: 2000,
    });

    expect(projection.relationship.stance.join('')).toContain('亲和 58');
    expect(projection.relationship.stance.join('')).toContain('信任 64');
    expect(projection.relationship.stance.join('')).not.toContain('威胁 48');
    expect(projection.continuity.relationshipMemories).toContain('本人长期关系看法：长期愿意替小铁留余地。');
    expect(projection.continuity.relationshipMemories).not.toContain('本人当前关系印象：紧张对峙：戒备');
    expect(projection.expression.temperature).toContain('长期关系不是固定口吻');
  });

  it('preserves an explicitly targetless turn despite a recent speaker', () => {
    const speaker = character();
    const other = character({ id: 'char-b', name: '阿远' });
    const projection = buildCharacterMindProjection({
      chat: chat('group'), character: speaker, characters: [speaker, other],
      messages: [message('我刚到。', other.id)], target: null, now: 2000,
    });
    expect(projection.relationship.targetId).toBeUndefined();
    expect(projection.relationship.targetName).toBeUndefined();
  });

  it('uses an upstream resolved target instead of re-picking the latest speaker', () => {
    const latestSpeaker = character({ id: 'char-b', name: '阿远' });
    const guidedTarget = character({ id: 'char-c', name: '林北' });
    const speaker = character({
      relationships: [{ characterId: 'char-c', warmth: 28, competence: 10, trust: 22, threat: 0, note: '愿意替林北留一点余地。' }],
    });
    const projection = buildCharacterMindProjection({
      chat: chat('group'),
      character: speaker,
      characters: [speaker, latestSpeaker, guidedTarget],
      messages: [message('继续刚才那个梗。', 'char-b')],
      target: { id: 'char-c', name: '林北' },
      now: 2000,
    });

    expect(projection.relationship.targetName).toBe('林北');
    expect(projection.relationship.stance.join('')).toContain('亲和 28');
    expect(projection.expression.attention).toContain('林北');
  });

  it('projects current public room facts as relationship continuity', () => {
    const speaker = character();
    const target = character({ id: 'char-b', name: '阿远' });
    const projection = buildCharacterMindProjection({
      chat: {
        ...chat('group'),
        relationshipStructure: {
          version: 1,
          updatedAt: 10,
          edges: [{ id: 'duty', fromId: 'char-a', toId: 'char-b', kind: 'duty', statement: '苏苏负责复核阿远的交接', confidence: 0.9, evidence: '职责设定', updatedAt: 10 }],
          sharedFacts: [{ id: 'affiliation', memberIds: ['char-a', 'char-b'], kind: 'affiliation', statement: '二人同属夜班组', confidence: 0.9, evidence: '阵营设定', updatedAt: 10 }],
        },
      },
      character: speaker,
      characters: [speaker, target],
      messages: [message('交接单在这儿。', 'char-b')],
      now: 2000,
    });
    expect(projection.continuity.relationshipMemories).toEqual(expect.arrayContaining([
      '共同关系：二人同属夜班组',
    ]));
  });

  it.each(['authored', 'ledger'] as const)('preserves the subjective boundary of %s relationship context without exposing notes publicly', (source) => {
    const impression = '觉得阿远没回消息是怕自己抢走晋升机会。';
    const speaker = character({
      relationships: source === 'authored'
        ? [{ characterId: 'char-b', warmth: 0, competence: 0, trust: -10, threat: 10, note: impression }]
        : [],
    });
    const target = character({ id: 'char-b', name: '阿远' });
    const projection = buildCharacterMindProjection({
      chat: {
        ...chat('group'),
        relationshipLedger: source === 'ledger' ? [{
          pairKey: 'char-a->char-b', actorId: 'char-a', targetId: 'char-b',
          current: { warmth: 0, competence: 0, trust: -10, threat: 10 },
          derived: { semantic: { stage: '戒备', labels: [], summary: impression, intensity: 10 } },
          trend: 'stable', recentEvents: [], lastUpdatedAt: 20,
        }] : [],
      },
      character: speaker, characters: [speaker, target],
      messages: [message('交接单在这儿。', target.id)], now: 2000,
    });
    const privatePrompt = adaptCharacterMindProjectionForPrompt(projection, {
      chatType: 'group', visibility: 'private', visibleMemoryRecall: 'off',
    }).promptBlock;
    const publicPrompt = adaptCharacterMindProjectionForPrompt(projection, {
      chatType: 'group', visibleMemoryRecall: 'off',
    }).promptBlock;

    expect(privatePrompt).toContain(`${source === 'authored' ? '本人长期关系看法' : '本人当前关系印象'}：${impression}`);
    expect(privatePrompt).toContain('非对方的内心事实');
    expect(publicPrompt).not.toContain(impression);
    expect(publicPrompt).toContain('非对方的内心事实');
  });

  it('ranks relevant memories before older unrelated memories in the mind projection', () => {
    const target = character({ id: 'char-b', name: '阿远' });
    const unrelated = Array.from({ length: 12 }, (_, index) => memory({
      id: `old-${index}`,
      subjectIds: ['char-x'],
      text: `旧闲聊记忆 ${index}`,
      summary: `旧闲聊记忆 ${index}`,
      salience: 0.2,
      confidence: 0.5,
      recency: 0.1,
    }));
    const speaker = character({
      layeredMemories: [
        ...unrelated,
        memory({
          id: 'relevant-target-memory',
          subjectIds: ['char-b'],
          text: '阿远之前帮苏苏圆过一次场，所以苏苏会给他留余地。',
          summary: '阿远之前帮她圆过场。',
          salience: 0.82,
          confidence: 0.9,
          recency: 0.7,
          reinforcementCount: 3,
        }),
      ],
    });

    const projection = buildCharacterMindProjection({
      chat: chat('group'),
      character: speaker,
      characters: [speaker, target],
      messages: [message('先别把话说太满。', 'char-b')],
      now: 2000,
    });

    expect(projection.continuity.relationshipMemories[0]).toContain('阿远之前帮她圆过场');
    expect(projection.hidden.recallCandidates.some((item) => item.includes('阿远之前帮她圆过场'))).toBe(true);
  });

  it('uses memory associations to wake related user continuity without exact keyword overlap', () => {
    const speaker = character({
      memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
      layeredMemories: [
        memory({
          id: 'user-drink-preference',
          kind: 'trait_evidence',
          scope: 'relationship',
          subjectIds: ['user'],
          text: '用户不喜欢太甜的饮料。',
          summary: '用户偏好低甜饮品。',
          semanticTags: ['饮品偏好'],
          associations: ['奶茶', '柠檬茶', '饮料'],
          salience: 0.86,
          confidence: 0.92,
          recency: 0.62,
        }),
      ],
    });

    const projection = buildCharacterMindProjection({
      chat: chat('direct'),
      character: speaker,
      characters: [speaker],
      messages: [message('我想喝奶茶。')],
      now: 2000,
    });

    expect(projection.continuity.userProfile[0]).toContain('低甜饮品');
    expect(projection.hidden.recallCandidates[0]).toContain('低甜饮品');
  });

  it('accepts the prompt assembly memory candidates instead of requiring them on the character', () => {
    const speaker = character({
      memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
      layeredMemories: [],
    });
    const injectedMemory = memory({
      id: 'assembly-user-memory',
      kind: 'trait_evidence',
      subjectIds: ['user'],
      text: '用户最近在准备一个重要面试。',
      summary: '用户最近在准备一个重要面试。',
      sourceTag: 'companionship_user_profile',
      visibility: 'private',
    });

    const projection = buildCharacterMindProjection({
      chat: chat('direct'),
      character: speaker,
      characters: [speaker],
      messages: [message('今天有点累。')],
      memoryCandidates: [injectedMemory],
      now: 2000,
    });

    expect(projection.continuity.userProfile).toContain('用户最近在准备一个重要面试。');
    expect(projection.hidden.memorySource).toBe('assembly_candidates');
  });

  it('renders a compact model-facing block without exposing hidden trace fields', () => {
    const speaker = character();
    const projection = buildCharacterMindProjection({
      chat: chat('direct'),
      character: speaker,
      characters: [speaker],
      messages: [message('今天太阳好大。')],
      now: 2000,
    });
    const block = buildCharacterMindProjectionPromptBlock(projection, { visibility: 'private' });

    expect(block).toContain('## Character Mind Projection');
    expect(block).toContain('用户不喜欢太甜的饮料。');
    expect(block).not.toContain('sourceIds');
    expect(block).not.toContain('score');
  });

  it('preserves every recorded emotion axis without prescribing a behavioral reaction', () => {
    const speaker = character({
      emotionalState: { irritation: 44, affection: 38, insecurity: 31, excitement: 8, embarrassment: 18 },
    });
    const projection = buildCharacterMindProjection({
      chat: chat('group'),
      character: speaker,
      characters: [speaker, character({ id: 'char-b', name: '阿远' })],
      messages: [message('你刚才那句什么意思？', 'char-b')],
      now: 2000,
    });

    const evidence = projection.currentState.emotionalUndercurrent.join('\n');
    for (const [axis, value] of Object.entries(speaker.emotionalState!)) {
      expect(evidence).toContain(`${axis} ${value}`);
    }
    expect(evidence).not.toContain('顶回');
    expect(evidence).not.toContain('护短');
    const prompt = buildCharacterMindProjectionPromptBlock(projection, { visibility: 'private' });
    expect(prompt).toContain('excitement 8');
    expect(prompt).toContain('embarrassment 18');
  });

  it('does not turn scheduler impulses into a model-facing self-appraisal', () => {
    const speaker = character({ soulState: {
      mood: { pleasure: 50, arousal: 40, dominance: 40 }, energy: 72, attention: 65, loneliness: 20,
      repression: 20, shame: 10, envy: 0, trustInRoom: 60, ignoredStreak: 0, updatedAt: 1,
      lastImpulse: 'repair', lastImpulseReason: '调度估值',
    } });
    const input = { chat: chat('group'), character: speaker, characters: [speaker], messages: [message('喝茶吗？')], now: 2000 };
    const base = buildCharacterMindProjection(input);
    const changed = buildCharacterMindProjection({ ...input, character: { ...speaker, soulState: { ...speaker.soulState!, lastImpulse: 'withdraw', lastImpulseReason: '另一种调度估值' } } });
    expect(changed.currentState).toEqual(base.currentState);
    expect(changed.currentState.selfAppraisal).toBeUndefined();
  });

  it('defaults model-facing blocks to public-safe continuity without raw private facts or transcript text', () => {
    const speaker = character({
      relationships: [{ characterId: 'char-b', warmth: 72, competence: 10, trust: 86, threat: 0, note: '共同秘密是雨夜便利店。' }],
      layeredMemories: [{
        id: 'leaky',
        ownerId: 'char-a',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        subjectIds: ['char-b'],
        text: '3c78729f-e52d-4dde-b27f-01a949960bb8b 与 char-b 有雨夜便利店暗号',
        salience: 0.8,
        confidence: 0.9,
        recency: 1,
        reinforcementCount: 1,
        sourceEventIds: ['evt-secret'],
        sourceTag: 'test',
        origin: 'runtime',
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
        distilledAt: null,
        distilledFromIds: [],
        distillationVersion: null,
      }],
    });
    const target = character({ id: 'char-b', name: '阿远' });
    const projection = buildCharacterMindProjection({
      chat: chat('group'),
      character: speaker,
      characters: [speaker, target],
      messages: [message('那次雨夜我不是故意失约。', 'char-b')],
      now: 2000,
    });
    const block = buildCharacterMindProjectionPromptBlock(projection);

    expect(block).toContain('Relationship continuity exists');
    expect(block).not.toContain('Active room lines');
    expect(block).not.toContain('雨夜便利店');
    expect(block).not.toContain('那次雨夜我不是故意失约');
    expect(block).not.toContain('3c78729f-e52d-4dde-b27f-01a949960bb8b');
  });
});
