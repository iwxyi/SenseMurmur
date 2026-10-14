import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import type { MemoryItem } from './memoryTypes';
import { DEFAULT_CONVERSATION_DIRECTOR_CONTROLS, DEFAULT_CONVERSATION_DRAMA_RULES, DEFAULT_CONVERSATION_GOVERNANCE, DEFAULT_CONVERSATION_WORLD_STATE } from '../types/chat';
import { projectNarrativeLines } from './narrativeProjection';

function buildChat(patch: Partial<GroupChat> = {}): GroupChat {
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
    ...patch,
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
    timestamp: patch.timestamp ?? 1,
    isDeleted: false,
  };
}

function buildCharacter(id: string, name: string, group?: string): AICharacter {
  return {
    id,
    name,
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
    behavior: { proactivity: 50, aggressiveness: 50, humorIntensity: 50, empathyLevel: 50, summarizing: 50, offTopic: 50 },
    expertise: [],
    speakingStyle: '',
    background: '',
    group,
    relationships: [],
    memory: { longTerm: [], shortTermSummary: '', secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
    intervention: { allowSpeakAs: true, allowDirectorPrompt: true, allowPrivateThread: true },
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function memory(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: 'mem-1',
    scope: 'character_self',
    layer: 'long_term',
    kind: 'trait_evidence',
    ownerId: 'a',
    subjectIds: ['a'],
    text: '甲开始意识到自己总是在争论里先防御，再表达真实需求。',
    salience: 0.82,
    confidence: 0.9,
    recency: 1,
    reinforcementCount: 2,
    sourceEventIds: ['event-growth'],
    sourceTag: 'llm_memory_growth_signal',
    origin: 'distilled',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

describe('projectNarrativeLines', () => {
  it('keeps explicit now=0 without falling back to Date.now', () => {
    const lines = projectNarrativeLines({
      chat: buildChat(),
      messages: [buildMessage({ content: '你又来了。', timestamp: 0 })],
      now: 0,
    });
    const topic = lines.find((line) => line.id === 'topic:latest');
    expect(topic?.lastTouchedAt).toBe(0);
  });

  it.each([0.9, 0])('keeps an unresolved conflict at severity %s without escalating a cold one', (severity) => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        worldState: {
          ...DEFAULT_CONVERSATION_WORLD_STATE,
          conflictState: {
            primaryConflict: {
              id: 'conflict-1',
              scope: 'group',
              type: 'value_conflict',
              severity,
              stage: 'escalating',
              summary: '甲乙的价值冲突正在升级',
              participantIds: ['a'],
              targetIds: ['b'],
              nextPressure: 'escalate',
              developmentHooks: ['invite_target_response'],
              sourceEventIds: ['event-1'],
              updatedAt: 10,
            },
            activeConflicts: [],
            developmentHooks: [],
            volatility: 0.6,
            cooling: 0,
            updatedAt: 10,
          },
        },
      }),
      messages: [buildMessage({ content: '这不是同一回事。' })],
      now: 20,
    });
    expect(lines[0]?.id).toBe('conflict-1');
    expect(lines[0]?.type).toBe('conflict');
    expect(lines[0]?.possibleNextBeats[0]?.beatType).toBe(severity === 0 ? 'answer' : 'escalate');
    expect(lines[0]?.status).toBe('escalating');
    if (severity === 0) expect(lines[0]?.possibleNextBeats[0]?.pressure).toBe(0.18);
  });

  it('filters draft actor ids from conflict narrative participants', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        worldState: {
          ...DEFAULT_CONVERSATION_WORLD_STATE,
          conflictState: {
            primaryConflict: {
              id: 'conflict-draft',
              scope: 'group',
              type: 'value_conflict',
              severity: 0.8,
              stage: 'open',
              summary: '存在草稿身份干扰',
              participantIds: ['a', 'draft-1'],
              targetIds: ['b', 'draft-2'],
              nextPressure: 'escalate',
              developmentHooks: [],
              sourceEventIds: ['event-draft'],
              updatedAt: 12,
            },
            activeConflicts: [],
            developmentHooks: [],
            volatility: 0.4,
            cooling: 0.1,
            updatedAt: 12,
          },
        },
      }),
      messages: [buildMessage({ content: '继续。' })],
      now: 20,
    });
    const line = lines.find((item) => item.id === 'conflict-draft');
    expect(line?.participantIds).toEqual(['b', 'a']);
    expect(line?.possibleNextBeats[0]?.targetActorIds).toEqual(['b', 'a']);
  });

  it('projects salient relationship ledger entries', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        relationshipLedger: [{
          pairKey: 'a->b',
          actorId: 'a',
          targetId: 'b',
          current: { warmth: -20, competence: 5, trust: -35, threat: 60 },
          derived: { salience: 90, semantic: { stage: '紧张对峙', labels: ['戒备'], summary: '紧张对峙：戒备', intensity: 80 } },
          axisReasons: {},
          trend: 'volatile',
          recentEvents: [{ id: 'event-2', kind: 'relationship_delta', createdAt: 10, summary: '关系变差' }],
          lastUpdatedAt: 10,
        }],
      }),
      messages: [buildMessage({ content: '你又来了。' })],
      now: 20,
    });
    expect(lines.some((line) => line.id === 'relationship:a->b')).toBe(true);
    const relationship = lines.find((line) => line.id === 'relationship:a->b');
    expect(relationship?.type).toBe('relationship');
    expect(relationship?.status).toBe('escalating');
  });

  it('does not crash when a legacy relationship entry has a non-array recentEvents field', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        relationshipLedger: [{
          pairKey: 'a->b',
          actorId: 'a',
          targetId: 'b',
          current: { warmth: -30, competence: 0, trust: -25, threat: 45 },
          derived: { salience: 90 },
          axisReasons: {},
          trend: 'volatile',
          recentEvents: { legacy: true } as never,
          lastUpdatedAt: 10,
        }],
      }),
      messages: [buildMessage({ content: '继续。' })],
      now: 20,
    });
    expect(lines.some((line) => line.id === 'relationship:a->b')).toBe(true);
    expect(lines.find((line) => line.id === 'relationship:a->b')?.sourceEventIds).toEqual([]);
  });

  it('projects attachment and hierarchy as dramatic pressure even without hostility', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        relationshipLedger: [{
          pairKey: 'a->b',
          actorId: 'a',
          targetId: 'b',
          current: { warmth: 24, competence: 50, trust: 42, threat: 0, attachment: 48, deference: 62 },
          derived: { salience: 12 },
          axisReasons: {},
          trend: 'flat',
          recentEvents: [],
          lastUpdatedAt: 10,
        }],
      }),
      characters: [buildCharacter('a', '下属'), buildCharacter('b', '上级')],
      messages: [buildMessage({ content: '这件事我没办妥。' })],
      now: 20,
    });

    const relationship = lines.find((line) => line.id === 'relationship:a->b');
    expect(relationship).toBeTruthy();
    expect(relationship?.possibleNextBeats[0]?.beatType).toBe('answer');
    expect(relationship?.openQuestions.join(' ')).toContain('争取认可');
  });

  it('projects legacy relationship entries without a recent event collection', () => {
    const legacyEntry = {
      pairKey: 'a->b',
      actorId: 'a',
      targetId: 'b',
      current: { warmth: -20, competence: 5, trust: -35, threat: 60 },
      derived: { salience: 90 },
      lastUpdatedAt: 10,
    } as NonNullable<GroupChat['relationshipLedger']>[number];
    const lines = projectNarrativeLines({
      chat: buildChat({ relationshipLedger: [legacyEntry] }),
      messages: [buildMessage({ content: '你又来了。' })],
      now: 20,
    });

    const relationship = lines.find((line) => line.id === 'relationship:a->b');
    expect(relationship?.sourceEventIds).toEqual([]);
    expect(relationship?.type).toBe('relationship');
  });

  it('redacts private relationship facts in narrative relationship lines', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        relationshipLedger: [{
          pairKey: 'a->b',
          actorId: 'a',
          targetId: 'b',
          current: { warmth: 50, competence: 5, trust: 46, threat: 8 },
          derived: {
            salience: 90,
            semantic: {
              stage: '互相信任',
              labels: ['默契', '秘密暗号'],
              summary: '互相信任：共同秘密是雨夜便利店暗号，不能公开说',
              intensity: 62,
            },
          },
          axisReasons: {},
          trend: 'flat',
          recentEvents: [{ id: 'event-secret', kind: 'relationship_delta', createdAt: 10, summary: '共同秘密是雨夜便利店暗号，不能公开说' }],
          lastUpdatedAt: 10,
        }],
      }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '先别把话说太满。' })],
      now: 20,
    });
    const relationship = lines.find((line) => line.id === 'relationship:a->b');
    expect(relationship?.summary).toContain('互相信任');
    expect(relationship?.summary).toContain('默契');
    expect(relationship?.summary).not.toContain('雨夜便利店');
    expect(relationship?.summary).not.toContain('不能公开说');
  });

  it('uses character names in fallback relationship summaries', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        relationshipLedger: [{
          pairKey: 'a->b',
          actorId: 'a',
          targetId: 'b',
          current: { warmth: -20, competence: 5, trust: -35, threat: 60 },
          derived: { salience: 90 },
          axisReasons: {},
          trend: 'volatile',
          recentEvents: [{ id: 'event-2', kind: 'relationship_delta', createdAt: 10, summary: '关系变差' }],
          lastUpdatedAt: 10,
        }],
      }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '你又来了。' })],
      now: 20,
    });
    const relationship = lines.find((line) => line.id === 'relationship:a->b');
    expect(relationship?.summary).toBe('甲 对 乙：信任偏低，亲和偏低。');
    expect(relationship?.possibleNextBeats[0]?.reason).toBe('甲 对 乙：信任偏低，亲和偏低。');
  });

  it('projects relationship repair impulse as a softening relationship line', () => {
    const repairingCharacter: AICharacter = {
      ...buildCharacter('a', '甲'),
      soulState: {
        mood: { pleasure: -5, arousal: 36, dominance: 42 },
        energy: 55,
        attention: 58,
        loneliness: 12,
        repression: 48,
        shame: 62,
        envy: 0,
        trustInRoom: 56,
        ignoredStreak: 0,
        lastImpulse: 'repair',
        lastImpulseReason: '前面的刺或嘴硬留下了关系余波，现在有一点找补、缓和或别扭靠近的冲动。',
      },
    };
    const lines = projectNarrativeLines({
      chat: buildChat({
        relationshipLedger: [{
          pairKey: 'a->b',
          actorId: 'a',
          targetId: 'b',
          current: { warmth: -8, competence: 5, trust: -16, threat: 28 },
          derived: { salience: 84, semantic: { stage: '复杂拉扯', labels: ['又在意又防备'], summary: '复杂拉扯：又在意又防备', intensity: 70 } },
          axisReasons: {},
          trend: 'volatile',
          recentEvents: [{ id: 'event-repair', kind: 'relationship_delta', createdAt: 10, summary: '甲刚才话说重了' }],
          lastUpdatedAt: 10,
        }],
      }),
      characters: [repairingCharacter, buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '行，当我没说。' })],
      now: 20,
    });

    const relationship = lines.find((line) => line.id === 'relationship:a->b');
    expect(relationship?.summary).toContain('找补');
    expect(relationship?.openQuestions[0]).toContain('找补');
    expect(relationship?.possibleNextBeats[0]?.beatType).toBe('defend');
  });

  it('projects soft faction lines from character groups', () => {
    const lines = projectNarrativeLines({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲', '现实派'), buildCharacter('b', '乙', '现实派'), buildCharacter('c', '丙', '理想派')],
      messages: [buildMessage({ content: '这个方案到底谁支持？' })],
      now: 20,
    });
    const factionLine = lines.find((line) => line.id === 'faction:group:现实派');
    expect(factionLine?.type).toBe('faction');
    expect(factionLine?.participantIds).toEqual(['a', 'b']);
  });

  it('projects growth lines from distilled character growth memories', () => {
    const character = {
      ...buildCharacter('a', '甲'),
      layeredMemories: [memory({})],
    };
    const lines = projectNarrativeLines({
      chat: buildChat(),
      characters: [character, buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '我刚才反应是不是太急了？' })],
      now: 20,
    });

    const growthLine = lines.find((line) => line.id === 'growth:a');
    expect(growthLine?.type).toBe('growth');
    expect(growthLine?.visibility).toBe('derived_public');
    expect(growthLine?.participantIds).toEqual(['a']);
    expect(growthLine?.possibleNextBeats[0]?.beatType).toBe('invite');
  });

  it('does not project growth lines from raw working evidence', () => {
    const character = {
      ...buildCharacter('a', '甲'),
      layeredMemories: [memory({ layer: 'working', origin: 'runtime', sourceTag: 'relationship_delta' })],
    };
    const lines = projectNarrativeLines({
      chat: buildChat(),
      characters: [character],
      messages: [buildMessage({ content: '普通对话' })],
      now: 20,
    });

    expect(lines.some((line) => line.type === 'growth')).toBe(false);
  });

  it('projects recent director interventions as goal lines', () => {
    const event: RuntimeEventV2 = {
      id: 'evt-goal',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 10,
      summary: '推进到大家讨论怎么收场',
      visibility: 'moderator_only',
      payload: {
        intent: 'inject_event',
        text: '推进到大家讨论怎么收场',
        targetActorIds: ['a'],
        pressure: 0.88,
      },
    };
    const lines = projectNarrativeLines({
      chat: buildChat({ runtimeEventsV2: [event] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '继续。' })],
      now: 20,
    });

    const goalLine = lines.find((line) => line.id === 'goal:evt-goal');
    expect(goalLine?.type).toBe('goal');
    expect(goalLine?.title).toBe('推进目标');
    expect(goalLine?.participantIds).toEqual(['a']);
    expect(goalLine?.openQuestions).toEqual([]);
    expect(goalLine?.possibleNextBeats[0]?.beatType).toBe('invite');
  });

  it('projects scenario structure lines when the chat has scenario state', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        mode: 'werewolf',
        sessionKind: { topology: 'table', family: 'deduction', scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid' },
        scenarioState: {
          roleAssignments: [{ actorId: 'a', roleId: 'leader', factionId: 'group-a' }],
          factions: [{ factionId: 'group-a', label: 'A阵营' }],
          seats: [{ seatId: 'seat-1', seatIndex: 0, actorId: 'a', roleId: 'leader' }],
          currentTurnActorId: 'a',
        },
      }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '继续。' })],
      now: 20,
    });

    const scenarioLine = lines.find((line) => line.type === 'scenario');
    expect(scenarioLine?.id).toBe('scenario:structure');
    expect(scenarioLine?.title).toBe('阵营局势');
    expect(scenarioLine?.summary).toContain('甲：领队');
    expect(scenarioLine?.summary).not.toContain('当前场景骨架');
    expect(scenarioLine?.participantIds).toContain('a');
  });

  it('does not project empty scenario lines for plain open chat default seats', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({
        scenarioState: {
          turnOrder: ['a', 'b'],
          currentTurnActorId: null,
          board: null,
          factions: [],
          seats: [
            { seatId: 'seat-1', seatIndex: 0, actorId: 'a' },
            { seatId: 'seat-2', seatIndex: 1, actorId: 'b' },
          ],
          roleAssignments: [],
        },
      }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '继续。' })],
      now: 20,
    });

    expect(lines.some((line) => line.type === 'scenario')).toBe(false);
  });

  it('uses the latest conversational message for topic lines instead of event JSON', () => {
    const lines = projectNarrativeLines({
      chat: buildChat(),
      messages: [
        buildMessage({ id: 'm1', type: 'ai', content: '最近有什么好玩的事？', timestamp: 10 }),
        buildMessage({ id: 'm2', type: 'event', senderId: 'system', senderName: '事件', content: '{"eventType":"room_state_snapshot_v2","summary":"热度 87"}', timestamp: 20 }),
      ],
      now: 30,
    });

    const topicLine = lines.find((line) => line.type === 'topic');
    expect(topicLine?.summary).toBe('最近有什么好玩的事？');
    expect(topicLine?.summary).not.toContain('eventType');
  });

  it('does not turn private runtime records into mystery pressure in an ordinary conversation', () => {
    const lines = projectNarrativeLines({
      chat: buildChat({ runtimeEventsV2: [{
        id: 'diagnostic', conversationId: 'chat-1', kind: 'artifact', createdAt: 10,
        actorIds: ['a'], visibility: 'moderator_only', summary: '内部状态记录',
        payload: { artifactType: 'private_thread_summary' },
      }] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '那就先歇一会儿。' })], now: 20,
    });
    expect(lines.some((line) => line.type === 'mystery')).toBe(false);
  });

  it('projects private or moderator-only events as non-leaking mystery lines', () => {
    const event: RuntimeEventV2 = {
      id: 'evt-secret',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 10,
      actorIds: ['a'],
      targetIds: ['b'],
      summary: '狼人私聊：甲和乙约定今晚攻击丙',
      visibility: 'role_private',
      payload: { artifactType: 'private_thread_summary' },
    };
    const lines = projectNarrativeLines({
      chat: buildChat({ mode: 'werewolf', runtimeEventsV2: [event] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')],
      messages: [buildMessage({ content: '昨晚是不是有人动手？' })],
      now: 20,
    });

    const mysteryLine = lines.find((line) => line.id === 'mystery:hidden-pressure');
    expect(mysteryLine?.type).toBe('mystery');
    expect(mysteryLine?.summary).not.toContain('攻击丙');
    expect(mysteryLine?.hiddenParticipantIds).toEqual(['a', 'b']);
    expect(mysteryLine?.possibleNextBeats[0]?.beatType).toBe('reveal');
  });

  it('filters draft actor ids from mystery hidden participants', () => {
    const event: RuntimeEventV2 = {
      id: 'evt-secret-draft',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 10,
      actorIds: ['draft-1', 'a'],
      targetIds: ['draft-2', 'b'],
      summary: '私密事件',
      visibility: 'role_private',
      payload: { artifactType: 'private_thread_summary' },
    };
    const lines = projectNarrativeLines({
      chat: buildChat({ mode: 'werewolf', runtimeEventsV2: [event] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '昨晚是不是有人动手？' })],
      now: 20,
    });
    const mysteryLine = lines.find((line) => line.id === 'mystery:hidden-pressure');
    expect(mysteryLine?.hiddenParticipantIds).toEqual(['a', 'b']);
  });
});
