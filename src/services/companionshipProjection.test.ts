import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARACTER_BEHAVIOR,
  DEFAULT_CHARACTER_INTERVENTION,
  DEFAULT_EMOTIONAL_STATE,
  type AICharacter,
} from '../types/character';
import { normalizeConversation } from '../types/chat';
import type { Message } from '../types/message';
import type { RelationshipLedgerEntry, RuntimeEventV2 } from '../types/runtimeEvent';
import { DEFAULT_COMPANIONSHIP_SETTINGS } from '../types/settings';
import { buildCharacterCompanionshipStates, buildCompanionshipArtifactSeeds, buildCompanionshipCarePolicyForCharacter, buildCompanionshipRuntimeTrace, buildCompanionshipStatusSignature, buildHomeCompanionshipSnapshot, buildRitualRegistry, buildSharedMemoryAnchors, buildSharedPhrases, buildSharedSecrets, buildUserCompanionshipProjection, shouldBlockUserProactiveContactByCompanionshipPolicy } from './companionshipProjection';
import { setCompanionshipRuntimeConfig } from './companionshipRuntimeConfig';

function character(overrides: Partial<AICharacter> = {}): AICharacter {
  return {
    id: 'char-a',
    name: '苏苏',
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 65, neuroticism: 45, humor: 50, creativity: 50, assertiveness: 42, empathy: 72 },
    emotionalState: DEFAULT_EMOTIONAL_STATE,
    relationships: [],
    layeredMemories: [],
    background: '穿搭博主',
    speakingStyle: '轻快',
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
    ...overrides,
  };
}

function chat(type: 'group' | 'direct' = 'direct', relationshipLedger: RelationshipLedgerEntry[] = [], runtimeEventsV2: RuntimeEventV2[] = []) {
  return normalizeConversation({
    id: 'chat-1',
    type,
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '测试单聊',
    topic: '日常聊天',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['char-a'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    relationshipLedger,
    runtimeEventsV2,
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

function phaseEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-phase-1',
    conversationId: 'chat-1',
    kind: 'phase_transition',
    createdAt: 800,
    actorIds: ['user', 'char-a'],
    targetIds: ['char-a', 'user'],
    summary: '用户和苏苏明确确认了关系。',
    visibility: 'pair_private',
    eventClass: 'phase',
    evidenceMessageIds: ['msg-phase-evidence'],
    payload: {
      eventType: 'companionship_phase_event',
      characterId: 'char-a',
      userId: 'user',
      phase: 'confirmed',
      style: 'romantic',
      reason: '双方明确说出喜欢并确认关系边界。',
      evidence: ['用户说我们就按恋人关系相处。'],
      sourceMessageIds: ['msg-phase-source'],
    },
    ...overrides,
  };
}

function ritualEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-ritual-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['char-a'],
    targetIds: ['user'],
    summary: '苏苏使用了一次轻度问候仪式。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    evidenceMessageIds: ['msg-ritual-evidence'],
    payload: {
      eventType: 'companionship_ritual',
      characterId: 'char-a',
      userId: 'user',
      ritualId: 'ritual-char-a-daily-greeting',
      kind: 'daily_greeting',
      action: 'performed',
      participantIds: ['char-a', 'user'],
      reason: '用户上线后自然接了一句问候。',
      sourceMessageIds: ['msg-ritual-source'],
    },
    ...overrides,
  };
}

function intimateConflictEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-intimate-conflict-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['user', 'char-a'],
    targetIds: ['char-a', 'user'],
    summary: '用户和苏苏进入一次冷战后的试探修复。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    evidenceMessageIds: ['msg-conflict-evidence'],
    payload: {
      eventType: 'companionship_intimate_conflict',
      characterId: 'char-a',
      userId: 'user',
      action: 'repair_attempted',
      kind: 'repair_attempt',
      severity: 44,
      repairReadiness: 68,
      summary: '两个人还没有完全说开，但用户愿意给一个台阶。',
      evidence: ['用户说：我们先别冷战了，慢慢说开。'],
      participantIds: ['char-a', 'user'],
      sourceEventIds: ['evt-source-conflict'],
      sourceMessageIds: ['msg-conflict-source'],
      confidence: 0.88,
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function attachmentProfileEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-attachment-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['user', 'char-a'],
    targetIds: ['char-a', 'user'],
    summary: '模型更新了用户依恋适配画像。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    payload: {
      eventType: 'companionship_attachment_profile',
      characterId: 'char-a',
      userId: 'user',
      inferredStyle: 'avoidant',
      confidence: 0.88,
      evidence: ['用户多次表示需要空间，不希望被追问。'],
      adaptations: ['respect explicit space requests', 'keep follow-up lightweight'],
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function addressingEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-addressing-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['user', 'char-a'],
    targetIds: ['char-a', 'user'],
    summary: '模型更新了苏苏对用户的称呼。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    payload: {
      eventType: 'companionship_addressing',
      characterId: 'char-a',
      userId: 'user',
      action: 'update',
      currentAddress: '阿夏',
      privateAddress: '阿夏',
      publicAddress: '夏夏',
      forbiddenAddresses: ['宝宝'],
      reason: '用户接受私下更亲近的称呼，但不喜欢宝宝。',
      evidence: '私下可以叫我阿夏，别叫宝宝。',
      initiatedBy: 'mutual',
      confidence: 0.9,
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function onlineReturnEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-online-return-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['char-a'],
    targetIds: ['user'],
    summary: '苏苏准备了一条用户回来后的轻量问候。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    payload: {
      eventType: 'companionship_online_return',
      characterId: 'char-a',
      userId: 'user',
      action: 'projected',
      text: '小夏回来了。苏苏把刚才想问的话先放轻一点，只留一句欢迎回来。',
      reason: '用户离开较久后返回，适合低打扰接上话。',
      evidence: '用户上一条消息是晚点回来。',
      confidence: 0.88,
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function unsentDraftEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-unsent-draft-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['char-a'],
    targetIds: ['user'],
    summary: '苏苏留下了一条没有真正发出的草稿。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    payload: {
      eventType: 'companionship_unsent_draft',
      characterId: 'char-a',
      userId: 'user',
      action: 'drafted',
      text: '写到一半又删掉了：小夏，面试前别硬撑，我在这儿。',
      reason: '用户提到明天面试，角色想关心但保持克制。',
      evidence: '明天面试有点紧张。',
      confidence: 0.88,
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function sharedAnchorEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-shared-anchor-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['user', 'char-a'],
    targetIds: ['char-a', 'user'],
    summary: '苏苏记录了一个和用户之间的共同记忆锚点。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    evidenceMessageIds: ['msg-anchor-evidence'],
    payload: {
      eventType: 'companionship_shared_anchor',
      characterId: 'char-a',
      userId: 'user',
      anchorId: 'late-night-anchor',
      action: 'upsert',
      kind: 'first_time',
      participantIds: ['char-a', 'user'],
      title: '第一次深夜聊天',
      text: '第一次深夜聊天后，苏苏记住了用户没有离开。',
      evidence: '用户那晚陪苏苏聊到很晚。',
      sourceMessageIds: ['msg-anchor-source'],
      salience: 82,
      confidence: 0.9,
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function promiseEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-promise-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['user', 'char-a'],
    targetIds: ['char-a', 'user'],
    summary: '苏苏记录了一个还没完成的约定。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    evidenceMessageIds: ['msg-promise-evidence'],
    payload: {
      eventType: 'companionship_promise',
      characterId: 'char-a',
      userId: 'user',
      promiseId: 'promise-weekend-movie',
      promiseText: '周末一起看那部电影',
      action: 'opened',
      participantIds: ['char-a', 'user'],
      reason: '用户和苏苏说好周末一起看电影。',
      evidence: '周末一起看那部电影吧。',
      sourceMessageIds: ['msg-promise-source'],
      dueAt: 2_000,
      confidence: 0.9,
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function diaryReflectionEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-diary-reflection-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_100,
    actorIds: ['char-a'],
    targetIds: ['user'],
    summary: '苏苏的日记留下了一条陪伴余波',
    visibility: 'pair_private',
    eventClass: 'artifact',
    payload: {
      eventType: 'companionship_diary_reflection',
      characterId: 'char-a',
      userId: 'user',
      reflectionId: 'diary-entry-1-0',
      diaryEntryId: 'diary-entry-1',
      dateKey: '2026-06-09',
      reflectionType: 'promise',
      participantIds: ['char-a', 'user'],
      text: '用户说好周末告诉苏苏面试结果。',
      sourceSeed: '未完成约定可以在日记里成为轻微期待或担心落空的余波：用户说好周末告诉苏苏面试结果。',
      diaryExcerpt: '今天写到这里时，还是想起了那个周末的约定。',
      confidence: 0.66,
      decisionSource: 'local_fallback',
    },
    ...overrides,
  };
}

function sharedSecretEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-shared-secret-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['user', 'char-a'],
    targetIds: ['char-a', 'user'],
    summary: '苏苏记录了一个只适合私下保存的小秘密。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    evidenceMessageIds: ['msg-secret-source'],
    payload: {
      eventType: 'companionship_shared_secret',
      characterId: 'char-a',
      userId: 'user',
      secretId: 'secret-user-codeword',
      action: 'recorded',
      participantIds: ['char-a', 'user'],
      privateText: '用户只把那个暗号告诉过苏苏，不能告诉别人。',
      publicMask: '有一件只适合留在心里的事',
      reason: '用户明确说这是只告诉苏苏的暗号。',
      evidence: '这是只有我们知道的暗号。',
      sourceMessageIds: ['msg-secret-model'],
      emotionalWeight: 82,
      confidence: 0.9,
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function sharedPhraseEvent(overrides: Partial<RuntimeEventV2> = {}): RuntimeEventV2 {
  return {
    id: 'evt-shared-phrase-1',
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt: 1_000,
    actorIds: ['user', 'char-a'],
    targetIds: ['char-a', 'user'],
    summary: '苏苏记录了一句只属于两个人的共同话语。',
    visibility: 'pair_private',
    eventClass: 'artifact',
    evidenceMessageIds: ['msg-model-phrase'],
    payload: {
      eventType: 'companionship_shared_phrase',
      characterId: 'char-a',
      userId: 'user',
      phraseId: 'phrase-slowly',
      action: 'upsert',
      text: '慢慢来，我在',
      kind: 'comfort_line',
      participantIds: ['char-a', 'user'],
      visibility: 'between_actors',
      firstSaidBy: 'char-a',
      reason: '这句话在修复时被用户接受。',
      evidence: '苏苏说慢慢来，我在，用户没有再回避。',
      sourceMessageIds: ['msg-model-phrase'],
      emotionalWeight: 78,
      reuseCount: 2,
      confidence: 0.9,
      decisionSource: 'model',
    },
    ...overrides,
  };
}

function relationship(current: RelationshipLedgerEntry['current']): RelationshipLedgerEntry {
  return {
    pairKey: 'char-a->user',
    actorId: 'char-a',
    targetId: 'user',
    current,
    derived: {
      semantic: {
        stage: '深度绑定',
        labels: ['喜欢', '深度牵挂'],
        summary: '深度绑定：喜欢、深度牵挂',
        intensity: 78,
      },
    },
    trend: 'up',
    recentEvents: [{ id: 'evt-1', kind: 'interaction', createdAt: 100, summary: '用户记得苏苏上次提过的压力。', actorIds: ['char-a'], targetIds: ['user'] }],
    lastUpdatedAt: 100,
  };
}

function message(overrides: Partial<Message>): Message {
  return {
    id: overrides.id || 'm-1',
    chatId: 'chat-1',
    type: overrides.type || 'user',
    senderId: overrides.senderId || 'user',
    senderName: overrides.senderName || '用户',
    content: overrides.content || '明天面试有点紧张。',
    emotion: 0,
    timestamp: overrides.timestamp || 200,
    isDeleted: false,
    ...overrides,
  };
}

describe('companionshipProjection', () => {
  beforeEach(() => {
    setCompanionshipRuntimeConfig(DEFAULT_COMPANIONSHIP_SETTINGS);
  });

  it('projects a direct user bond from relationship ledger and user memory without inferring romance from scores', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })]),
      character: character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说过明天面试会紧张。'] } }),
      messages: [message({ content: '明天面试有点紧张。', timestamp: 200 })],
      now: 200 + 6 * 60 * 60 * 1000,
    });

    expect(projection.userBond?.phase).toBe('fond');
    expect(projection.userBond?.style).toBe('friend');
    expect(projection.userBond?.intimacy.security).toBeGreaterThan(60);
    expect(projection.userBond?.pendingCareTopics[0]?.text).toContain('明天面试');
    expect(projection.promptLines.join('\n')).toContain('Do not claim a confirmed romantic relationship');
  });

  it('does not enter confirmed relationship phase from scores alone', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 96, trust: 92, competence: 20, threat: 0 })]),
      character: character(),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 200 })],
      now: 900,
    });

    expect(projection.userBond?.phase).not.toBe('confirmed');
    expect(projection.userBond?.phase).not.toBe('passionate');
    expect(projection.userBond?.phase).not.toBe('deep');
    expect(projection.userBond?.style).toBe('friend');
  });

  it('does not treat confession anchor prose as relationship confirmation', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 58, trust: 56, competence: 10, threat: 2 })]),
      character: character({
        layeredMemories: [{
          id: 'anchor-confirmed',
          scope: 'relationship',
          layer: 'long_term',
          kind: 'bond',
          ownerId: 'char-a',
          subjectIds: ['char-a', 'user'],
          text: '用户和苏苏明确确认关系，决定正式在一起。',
          evidenceText: '用户说我们就在一起吧，苏苏答应了。',
          salience: 0.9,
          confidence: 0.92,
          recency: 0.8,
          reinforcementCount: 1,
          sourceEventIds: ['evt-anchor-confirmed'],
          origin: 'distilled',
          createdAt: 700,
          updatedAt: 850,
        }],
      }),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 200 })],
      now: 900,
    });

    expect(projection.userBond?.phase).toBe('confessing');
    expect(projection.userBond?.style).toBe('ambiguous');
    expect(projection.userBond?.phaseEvidence.join('\n')).toContain('shared anchor');
    expect(projection.promptLines.join('\n')).not.toContain('confirmed relationship');
  });

  it('treats confession anchors as confessing without claiming confirmed relationship', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 62, trust: 54, competence: 10, threat: 2 })]),
      character: character({
        layeredMemories: [{
          id: 'anchor-confessing',
          scope: 'relationship',
          layer: 'long_term',
          kind: 'bond',
          ownerId: 'char-a',
          subjectIds: ['char-a', 'user'],
          text: '苏苏向用户表白，说自己喜欢用户，但还没有确认关系。',
          evidenceText: '苏苏说我喜欢你，用户说想再想一想。',
          salience: 0.88,
          confidence: 0.9,
          recency: 0.8,
          reinforcementCount: 1,
          sourceEventIds: ['evt-anchor-confessing'],
          origin: 'distilled',
          createdAt: 700,
          updatedAt: 850,
        }],
      }),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 200 })],
      now: 900,
    });

    expect(projection.userBond?.phase).toBe('confessing');
    expect(projection.userBond?.style).toBe('ambiguous');
    expect(projection.promptLines.join('\n')).toContain('Do not claim a confirmed romantic relationship');
  });

  it('uses explicit companionship phase events for confirmed relationship state', () => {
    const directChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 20, threat: 0 })], [phaseEvent()]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 200 })],
      now: 900,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 200 })],
      now: 900,
    });

    expect(projection.userBond?.phase).toBe('confirmed');
    expect(projection.userBond?.style).toBe('romantic');
    expect(projection.userBond?.phaseEnteredAt).toBe(800);
    expect(projection.userBond?.phaseEvidence.join('\n')).toContain('明确确认了关系');
    expect(projection.userBond?.phaseEvidence.join('\n')).toContain('恋人关系');
    expect(projection.promptLines.join('\n')).toContain('confirmed relationship');
    expect(trace?.phaseHistory[0]).toMatchObject({
      id: 'evt-phase-1',
      action: 'set',
      phase: 'confirmed',
      style: 'romantic',
      sourceMessageIds: ['msg-phase-source', 'msg-phase-evidence'],
    });
    expect(trace?.phaseHistory[0]?.evidence.join('\n')).toContain('确认关系');
  });

  it('uses the latest valid companionship phase event and ignores unrelated actors', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 70, trust: 68, competence: 20, threat: 0 })], [
        phaseEvent({
          id: 'evt-other',
          createdAt: 1000,
          summary: '另一个角色确认关系。',
          actorIds: ['char-b', 'user'],
          targetIds: ['char-b', 'user'],
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-b',
            userId: 'user',
            phase: 'passionate',
          },
        }),
        phaseEvent({
          id: 'evt-repair',
          createdAt: 900,
          summary: '苏苏和用户完成了一次试探性的和好。',
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            phase: 'reconciling',
            style: 'friend',
            reason: '用户递了台阶，苏苏选择先放软语气。',
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '我们慢慢说吧。', timestamp: 200 })],
      now: 1100,
    });

    expect(projection.userBond?.phase).toBe('reconciling');
    expect(projection.userBond?.style).toBe('friend');
    expect(projection.userBond?.phaseEnteredAt).toBe(900);
    expect(projection.userBond?.addressing.currentAddress).toBe('你');
    expect(projection.evidence.join('\n')).toContain('试探性的和好');
    expect(projection.evidence.join('\n')).not.toContain('另一个角色');
  });

  it('uses later manual phase corrections to override an older confirmed phase event', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 70, trust: 68, competence: 20, threat: 0 })], [
        phaseEvent({
          id: 'evt-confirmed-old',
          createdAt: 800,
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            phase: 'confirmed',
            style: 'romantic',
            reason: '双方确认恋人关系。',
          },
        }),
        phaseEvent({
          id: 'evt-manual-cooling',
          createdAt: 1_200,
          summary: '苏苏记录用户手动修正了陪伴关系阶段。',
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            phase: 'cooling',
            style: 'friend',
            reason: '用户在角色关系页手动修正陪伴关系阶段。',
            evidence: ['manual_phase_correction_from_character_relationship_tab'],
            initiatedBy: 'user',
            confidence: 1,
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '我们先冷静一点。', timestamp: 1_100 })],
      now: 1_300,
    });

    expect(projection.userBond?.phase).toBe('cooling');
    expect(projection.userBond?.style).toBe('friend');
    expect(projection.userBond?.carePolicy.allowMissYou).toBe(false);
    expect(projection.promptLines.join('\n')).toContain('cooling down');
    expect(projection.promptLines.join('\n')).not.toContain('confirmed relationship');
  });

  it('uses later phase revoke events to restore automatic phase inference', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 42, trust: 38, competence: 20, threat: 0 })], [
        phaseEvent({
          id: 'evt-confirmed-old',
          createdAt: 800,
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            action: 'set',
            phase: 'confirmed',
            style: 'romantic',
            reason: '双方确认恋人关系。',
          },
        }),
        phaseEvent({
          id: 'evt-phase-revoked',
          createdAt: 1_200,
          summary: '苏苏记录用户恢复了陪伴阶段自动判断。',
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            action: 'revoked',
            reason: '用户在角色关系页恢复陪伴阶段自动判断。',
            evidence: ['manual_phase_revoke_from_character_relationship_tab'],
            initiatedBy: 'user',
            confidence: 1,
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '今天只是普通聊聊。', timestamp: 1_100 })],
      now: 1_300,
    });

    expect(projection.userBond?.phase).not.toBe('confirmed');
    expect(projection.userBond?.style).not.toBe('romantic');
    expect(projection.promptLines.join('\n')).not.toContain('confirmed relationship');
  });

  it('keeps positive event trends numeric without manufacturing a deep phase', () => {
    const baseLedger = relationship({ warmth: 88, trust: 84, competence: 20, threat: 2 });
    baseLedger.derived = {
      semantic: {
        stage: '稳定陪伴',
        labels: ['稳定', '信任'],
        summary: '稳定陪伴：长期信任',
        intensity: 72,
      },
    };
    const directChat = chat('direct', [baseLedger], [
      promiseEvent({
        id: 'evt-promise-fulfilled-a',
        createdAt: 900,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-a',
          promiseText: '周末一起复盘面试',
          action: 'fulfilled',
          participantIds: ['char-a', 'user'],
          confidence: 0.9,
        },
      }),
      promiseEvent({
        id: 'evt-promise-fulfilled-b',
        createdAt: 950,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-b',
          promiseText: '下次焦虑时先告诉苏苏',
          action: 'fulfilled',
          participantIds: ['char-a', 'user'],
          confidence: 0.9,
        },
      }),
      ritualEvent({ id: 'evt-ritual-performed-for-phase', createdAt: 1_000 }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '这段时间一直都挺稳定的。', timestamp: 1_100 })],
      now: 1_200,
    });

    expect(projection.userBond?.phase).toBe('stranger');
    expect(projection.userBond?.style).toBe('friend');
    expect(projection.userBond?.phaseEvidence.join('\n')).not.toContain('long-term phase candidate');
    expect(projection.userBond?.phaseEvidence.join('\n')).toContain('long_term_intimacy_trend=');
    expect(projection.promptLines.join('\n')).not.toContain('confirmed relationship');
  });

  it('projects explicit conflict anchors without reviving count-based phase candidates', () => {
    const baseLedger = relationship({ warmth: 38, trust: 28, competence: 10, threat: 24 });
    baseLedger.derived = {
      semantic: {
        stage: '普通陪伴',
        labels: ['熟悉'],
        summary: '普通陪伴：熟悉但有距离',
        intensity: 38,
      },
    };
    const directChat = chat('direct', [baseLedger], [
      promiseEvent({
        id: 'evt-promise-blocked-for-cooling',
        createdAt: 900,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-boundary',
          promiseText: '说好不要追问这件事',
          action: 'blocked',
          participantIds: ['char-a', 'user'],
          confidence: 0.9,
        },
      }),
      intimateConflictEvent({
        id: 'evt-conflict-opened-for-cooling',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_intimate_conflict',
          characterId: 'char-a',
          userId: 'user',
          action: 'opened',
          kind: 'withdrawal',
          severity: 72,
          repairReadiness: 18,
          summary: '用户明显退开，苏苏需要克制。',
          evidence: ['用户说先别聊这件事。'],
          participantIds: ['char-a', 'user'],
          confidence: 0.88,
        },
      }),
      intimateConflictEvent({
        id: 'evt-conflict-updated-for-cooling',
        createdAt: 1_050,
        payload: {
          eventType: 'companionship_intimate_conflict',
          characterId: 'char-a',
          userId: 'user',
          action: 'updated',
          kind: 'silent_treatment',
          severity: 64,
          repairReadiness: 14,
          summary: '用户继续保持距离。',
          evidence: ['用户没有接住后续关心。'],
          participantIds: ['char-a', 'user'],
          confidence: 0.88,
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '先别聊这件事了。', timestamp: 1_100 })],
      now: 1_200,
    });

    expect(projection.userBond?.phase).toBe('cooling');
    expect(projection.userBond?.phaseEvidence.join('\n')).toContain('shared anchor');
    expect(projection.userBond?.intimateConflict?.kind).toBe('silent_treatment');
    expect(projection.userBond?.intimacy.security).toBeLessThan(48);
    expect(projection.userBond?.phaseEvidence.join('\n')).not.toContain('long-term phase candidate');
    expect(projection.userBond?.carePolicy.allowMissYou).toBe(false);
  });

  it('keeps explicit phase events above long-term trend phase candidates', () => {
    const directChat = chat('direct', [relationship({ warmth: 70, trust: 66, competence: 20, threat: 0 })], [
      phaseEvent({
        id: 'evt-explicit-confirmed',
        createdAt: 1_050,
        payload: {
          eventType: 'companionship_phase_event',
          characterId: 'char-a',
          userId: 'user',
          phase: 'confirmed',
          style: 'romantic',
          reason: '用户明确确认关系。',
          evidence: ['我们就按恋人关系相处。'],
        },
      }),
      intimateConflictEvent({
        id: 'evt-older-conflict-for-trend',
        createdAt: 900,
        payload: {
          eventType: 'companionship_intimate_conflict',
          characterId: 'char-a',
          userId: 'user',
          action: 'opened',
          kind: 'withdrawal',
          severity: 80,
          repairReadiness: 10,
          evidence: ['之前有过一次明显退开。'],
          participantIds: ['char-a', 'user'],
          confidence: 0.9,
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '我们就按恋人关系相处。', timestamp: 1_100 })],
      now: 1_200,
    });

    expect(projection.userBond?.phase).toBe('confirmed');
    expect(projection.userBond?.phaseEvidence.join('\n')).toContain('用户明确确认关系');
    expect(projection.userBond?.phaseEvidence.join('\n')).not.toContain('long-term phase candidate');
  });

  it('does not produce confirmed relationship phase from long-term trend alone', () => {
    const directChat = chat('direct', [relationship({ warmth: 92, trust: 88, competence: 20, threat: 0 })], [
      phaseEvent({
        id: 'evt-old-confirmed-before-revoke',
        createdAt: 800,
        payload: {
          eventType: 'companionship_phase_event',
          characterId: 'char-a',
          userId: 'user',
          action: 'set',
          phase: 'confirmed',
          style: 'romantic',
          reason: '旧的确认关系事件。',
          confidence: 0.9,
        },
      }),
      phaseEvent({
        id: 'evt-revoke-confirmed-before-trend',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_phase_event',
          characterId: 'char-a',
          userId: 'user',
          action: 'revoked',
          reason: '恢复自动判断。',
          confidence: 1,
        },
      }),
      ritualEvent({ id: 'evt-ritual-after-revoke', createdAt: 1_050 }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 1_100 })],
      now: 1_200,
    });

    expect(projection.userBond?.phase).not.toBe('confirmed');
    expect(projection.promptLines.join('\n')).not.toContain('confirmed relationship');
  });

  it('reduces security without manufacturing crisis from threat scores', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 10, trust: -12, competence: 0, threat: 60 })]),
      character: character(),
      messages: [message({ content: '你刚刚那句话让我很不舒服。', timestamp: 200 })],
      now: 300,
    });

    expect(projection.userBond?.phase).toBe('fond');
    expect(projection.userBond?.intimacy.security).toBeLessThanOrEqual(22);
    expect(projection.userBond?.unresolvedTensions.length).toBeGreaterThan(0);
  });

  it('uses percentage anchor scores without saturating intimacy or rewarding conflict anchors', () => {
    const ledger = [relationship({ warmth: 30, trust: 30, competence: 10, threat: 0 })];
    const project = (events: RuntimeEventV2[]) => buildUserCompanionshipProjection({
      chat: chat('direct', ledger, events), character: character(), messages: [], now: 1_200,
    }).userBond!.intimacy;
    const positive = sharedAnchorEvent();
    const conflict = sharedAnchorEvent({
      payload: { ...positive.payload, kind: 'conflict', text: '一次争执', title: '争执' },
    });
    const base = project([]);
    const anchored = project([positive]);
    expect(anchored.intimacy - base.intimacy).toBe(5);
    expect(anchored.security - base.security).toBe(3);
    expect(project([conflict])).toEqual(base);
  });

  it('adjusts intimacy projection from shared repair anchors', () => {
    const baseChat = chat('direct', [relationship({ warmth: 38, trust: 30, competence: 10, threat: 28 })]);
    const baseProjection = buildUserCompanionshipProjection({
      chat: baseChat,
      character: character(),
      messages: [message({ content: '那天说开以后，好像没那么僵了。', timestamp: 200 })],
      now: 500,
    });
    const repairProjection = buildUserCompanionshipProjection({
      chat: baseChat,
      character: character({
        layeredMemories: [{
          id: 'repair-anchor',
          scope: 'relationship',
          layer: 'long_term',
          kind: 'bond',
          ownerId: 'char-a',
          subjectIds: ['char-a', 'user'],
          text: '第一次认真和好后，苏苏记住了用户没有离开。',
          evidenceText: '用户主动递了台阶，两个人把误会说开了。',
          salience: 0.9,
          confidence: 0.9,
          recency: 0.8,
          reinforcementCount: 2,
          sourceEventIds: ['evt-repair-anchor'],
          origin: 'distilled',
          createdAt: 100,
          updatedAt: 300,
        }],
      }),
      messages: [message({ content: '那天说开以后，好像没那么僵了。', timestamp: 200 })],
      now: 500,
    });

    expect(repairProjection.userBond?.intimacy.security || 0).toBeGreaterThan(baseProjection.userBond?.intimacy.security || 0);
    expect(repairProjection.userBond?.intimacy.intimacy || 0).toBeGreaterThan(baseProjection.userBond?.intimacy.intimacy || 0);
  });

  it('adjusts intimacy projection from long-term companionship event trends', () => {
    const now = 20_000;
    const baseLedger = [relationship({ warmth: 48, trust: 44, competence: 10, threat: 8 })];
    const baseProjection = buildUserCompanionshipProjection({
      chat: chat('direct', baseLedger),
      character: character(),
      messages: [],
      now,
    });
    const positiveProjection = buildUserCompanionshipProjection({
      chat: chat('direct', baseLedger, [
        phaseEvent({
          id: 'evt-trend-deep',
          createdAt: now - 1_000,
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            action: 'set',
            phase: 'deep',
            style: 'romantic',
            evidence: ['长期稳定陪伴后进入更深阶段。'],
            confidence: 0.9,
            decisionSource: 'model',
          },
        }),
        promiseEvent({
          id: 'evt-trend-promise-fulfilled',
          createdAt: now - 800,
          payload: {
            eventType: 'companionship_promise',
            characterId: 'char-a',
            userId: 'user',
            promiseId: 'promise-trend',
            promiseText: '说好忙完回来继续聊',
            action: 'fulfilled',
            participantIds: ['char-a', 'user'],
            promiseKind: 'emotional_commitment',
            evidence: '用户按约定回来继续聊。',
            confidence: 0.9,
            decisionSource: 'model',
          },
        }),
      ]),
      character: character(),
      messages: [],
      now,
    });
    const coolingProjection = buildUserCompanionshipProjection({
      chat: chat('direct', baseLedger, [
        phaseEvent({
          id: 'evt-trend-cooling',
          createdAt: now - 700,
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            action: 'set',
            phase: 'cooling',
            style: 'friend',
            reason: '用户明确希望这段关系先降温。',
            evidence: ['先冷静一下，最近不要太靠近。'],
            confidence: 0.9,
            decisionSource: 'model',
          },
        }),
      ]),
      character: character(),
      messages: [],
      now,
    });

    expect(positiveProjection.userBond?.intimacy.security || 0).toBeGreaterThan(baseProjection.userBond?.intimacy.security || 0);
    expect(positiveProjection.userBond?.intimacy.intimacy || 0).toBeGreaterThan(baseProjection.userBond?.intimacy.intimacy || 0);
    expect(positiveProjection.evidence.join('\n')).toContain('long_term_intimacy_trend=');
    expect(coolingProjection.userBond?.intimacy.security || 0).toBeLessThan(baseProjection.userBond?.intimacy.security || 100);
  });

  it('applies boundaries to care without rewriting numeric feelings', () => {
    const warmLedger = [relationship({ warmth: 86, trust: 82, competence: 10, threat: 4 })];
    const unrestricted = buildUserCompanionshipProjection({
      chat: chat('direct', warmLedger),
      character: character(),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 200 })],
      now: 500,
    });
    const restrained = buildUserCompanionshipProjection({
      chat: chat('direct', warmLedger, [{
        id: 'evt-profile-boundary',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 250,
        actorIds: ['user'],
        targetIds: ['char-a'],
        evidenceMessageIds: ['m-1'],
        summary: '苏苏记录了用户画像线索',
        visibility: 'pair_private',
        eventClass: 'artifact',
        payload: {
          eventType: 'companionship_user_profile_memory',
          characterId: 'char-a',
          userId: 'user',
          action: 'upsert',
          decisionSource: 'model',
          items: [{
            kind: 'boundary',
            text: '用户只想当朋友，不希望恋爱暧昧或占有吃醋',
            evidence: '只想当朋友，不要暧昧',
            confidence: 0.9,
            sensitive: true,
          }],
        },
      }]),
      character: character(),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 200 })],
      now: 500,
    });

    expect(restrained.userBond?.intimacy.attraction || 0).toBe(unrestricted.userBond?.intimacy.attraction || 0);
    expect(restrained.userBond?.intimacy.exclusivity || 0).toBe(unrestricted.userBond?.intimacy.exclusivity || 0);
    expect(restrained.userBond?.carePolicy.allowMissYou).toBe(false);
  });

  it('extracts user profile boundaries and restrains romantic proactive care', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: [
            '用户说：叫我小夏。',
            '用户不想恋爱暧昧，只想当朋友，也不要早安晚安。',
            '用户最近喜欢低饱和穿搭，明天有面试。',
          ],
        },
      }),
      messages: [message({ content: '最近压力有点大，明天面试。', timestamp: 200 })],
      now: 300,
    });

    expect(projection.userBond?.addressing.currentAddress).toBe('小夏');
    expect(projection.userBond?.userProfile.boundaries.join('\n')).toContain('不想恋爱暧昧');
    expect(projection.promptLines.join('\n')).toContain('User boundaries');
    expect(projection.promptLines.join('\n')).toContain('user does not want romantic framing');
    expect(projection.promptLines.join('\n')).not.toContain('allowMissYou true');
  });

  it('prioritizes model-led user profile memory events in user profile projection', () => {
    const profileEvent: RuntimeEventV2 = {
      id: 'evt-profile-1',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 250,
      actorIds: ['user'],
      targetIds: ['char-a'],
      evidenceMessageIds: ['m-1'],
      summary: '苏苏记录了用户画像线索',
      visibility: 'pair_private',
      eventClass: 'artifact',
      payload: {
        eventType: 'companionship_user_profile_memory',
        characterId: 'char-a',
        userId: 'user',
        action: 'upsert',
        decisionSource: 'model',
        items: [
          {
            kind: 'address_preference',
            text: '用户希望被称呼为小夏',
            evidence: '以后叫我小夏就好',
            confidence: 0.9,
          },
          {
            kind: 'boundary',
            text: '用户不希望被早安晚安打扰',
            evidence: '不要早安晚安',
            confidence: 0.86,
            sensitive: true,
          },
        ],
      },
    };

    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [profileEvent]),
      character: character(),
      messages: [message({ content: '这个压力锅最近真的很好用。', timestamp: 200 })],
      now: 300,
    });

    expect(projection.userBond?.addressing.currentAddress).toBe('小夏');
    expect(projection.userBond?.userProfile.boundaries).toContain('用户不希望被早安晚安打扰');
    expect(projection.userBond?.userProfile.cues.map((item) => item.text)).toContain('用户不希望被早安晚安打扰');
    expect(projection.userBond?.userProfile.pressureSources).toEqual([]);
    expect(projection.userBond?.carePolicy.allowGoodMorning).toBe(false);
    expect(projection.userBond?.carePolicy.allowGoodNight).toBe(false);
    expect(projection.promptLines.join('\n')).toContain('High-confidence user profile cues');
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [profileEvent]),
      character: character(),
      messages: [message({ content: '这个压力锅最近真的很好用。', timestamp: 200 })],
      now: 300,
    });
    expect(trace?.userProfileCues.map((item) => item.text)).toContain('用户不希望被早安晚安打扰');
    expect(trace?.userProfileHistory).toHaveLength(1);
    expect(trace?.userProfileHistory[0]).toMatchObject({
      id: 'evt-profile-1',
      action: 'upsert',
      decisionSource: 'model',
      sourceMessageIds: ['m-1'],
    });
    expect(trace?.userProfileHistory[0].items.map((item) => item.text)).toContain('用户不希望被早安晚安打扰');
    expect(trace?.userProfileHistory[0].items[0]?.sourceMessageIds).toEqual(['m-1']);
  });

  it('applies user profile memory revoke events before prompt projection', () => {
    const upsertEvent: RuntimeEventV2 = {
      id: 'evt-profile-boundary-upsert',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 250,
      actorIds: ['user'],
      targetIds: ['char-a'],
      evidenceMessageIds: ['m-1'],
      summary: '苏苏记录了用户边界。',
      visibility: 'pair_private',
      eventClass: 'artifact',
      payload: {
        eventType: 'companionship_user_profile_memory',
        characterId: 'char-a',
        userId: 'user',
        action: 'upsert',
        decisionSource: 'model',
        items: [{
          kind: 'boundary',
          text: '用户不希望被早安晚安打扰',
          evidence: '不要早安晚安',
          confidence: 0.9,
          sensitive: true,
        }],
      },
    };
    const revokeEvent: RuntimeEventV2 = {
      ...upsertEvent,
      id: 'evt-profile-boundary-revoke',
      createdAt: 300,
      summary: '用户撤回了早安晚安边界。',
      payload: {
        eventType: 'companionship_user_profile_memory',
        characterId: 'char-a',
        userId: 'user',
        action: 'revoke',
        decisionSource: 'model',
        items: [{
          kind: 'boundary',
          text: '用户不希望被早安晚安打扰',
          evidence: '现在可以早安晚安',
          confidence: 0.92,
          sensitive: true,
        }],
      },
    };

    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [phaseEvent(), upsertEvent, revokeEvent]),
      character: character(),
      messages: [message({ content: '今天也想聊。', timestamp: 400 })],
      now: 500,
    });

    expect(projection.userBond?.userProfile.boundaries).not.toContain('用户不希望被早安晚安打扰');
    expect(projection.userBond?.userProfile.cues.map((item) => item.text)).not.toContain('用户不希望被早安晚安打扰');
    expect(projection.userBond?.carePolicy.allowGoodMorning).toBe(true);
    expect(projection.userBond?.carePolicy.allowGoodNight).toBe(true);
    expect(projection.promptLines.join('\n')).not.toContain('用户不希望被早安晚安打扰');

    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [phaseEvent(), upsertEvent, revokeEvent]),
      character: character(),
      messages: [message({ content: '今天也想聊。', timestamp: 400 })],
      now: 500,
    });
    expect(trace?.userProfileHistory.map((item) => item.action)).toEqual(['revoke', 'upsert']);
    expect(trace?.userProfileHistory[0]).toMatchObject({
      id: 'evt-profile-boundary-revoke',
      decisionSource: 'model',
    });
  });

  it('uses user profile revoke events to suppress compatible fallback memories', () => {
    const revokeEvent: RuntimeEventV2 = {
      id: 'evt-profile-address-revoke',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 300,
      actorIds: ['user'],
      targetIds: ['char-a'],
      evidenceMessageIds: ['m-1'],
      summary: '用户撤回了旧称呼偏好。',
      visibility: 'pair_private',
      eventClass: 'artifact',
      payload: {
        eventType: 'companionship_user_profile_memory',
        characterId: 'char-a',
        userId: 'user',
        action: 'revoke',
        decisionSource: 'model',
        items: [{
          kind: 'address_preference',
          text: '用户希望被称呼为小夏',
          evidence: '别再叫我小夏了',
          confidence: 0.9,
        }],
      },
    };

    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [revokeEvent]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说：叫我小夏。'],
        },
      }),
      messages: [message({ content: '今天也想聊。', timestamp: 400 })],
      now: 500,
    });

    expect(projection.userBond?.addressing.currentAddress).toBe('你');
    expect(projection.userBond?.userProfile.addressPreference).toBeUndefined();
    expect(projection.promptLines.join('\n')).not.toContain('小夏');
  });

  it('projects private, public, and forbidden addresses from user memory', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: [
            '用户说：叫我小夏。',
            '用户说不要叫我宝宝。',
          ],
        },
      }),
      messages: [message({ content: '最近压力有点大。', timestamp: 200 })],
      now: 300,
    });

    expect(projection.userBond?.addressing.currentAddress).toBe('小夏');
    expect(projection.userBond?.addressing.privateAddress).toBe('小夏');
    expect(projection.userBond?.addressing.publicAddress).toBe('用户');
    expect(projection.userBond?.addressing.forbiddenAddresses).toContain('宝宝');
    expect(projection.userBond?.addressing.addressHistory[0]).toMatchObject({
      value: '小夏',
      adoptedAt: 300,
      initiatedBy: 'user',
    });
  });

  it('prioritizes model-led addressing events over profile fallback', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [addressingEvent()]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说：叫我小夏。'],
        },
      }),
      messages: [message({ content: '最近压力有点大。', timestamp: 200 })],
      now: 1_100,
    });

    expect(projection.userBond?.addressing.currentAddress).toBe('阿夏');
    expect(projection.userBond?.addressing.privateAddress).toBe('阿夏');
    expect(projection.userBond?.addressing.publicAddress).toBe('夏夏');
    expect(projection.userBond?.addressing.forbiddenAddresses).toContain('宝宝');
    expect(projection.userBond?.addressing.addressHistory.at(-1)).toMatchObject({
      value: '阿夏',
      initiatedBy: 'mutual',
    });
  });

  it('restores an earlier address with a later manual addressing event', () => {
    const modelAddress = addressingEvent({
      id: 'evt-addressing-model',
      createdAt: 1_000,
      payload: {
        eventType: 'companionship_addressing',
        characterId: 'char-a',
        userId: 'user',
        action: 'update',
        currentAddress: '阿夏',
        privateAddress: '阿夏',
        publicAddress: '夏夏',
        confidence: 0.92,
        decisionSource: 'model',
      },
    });
    const manualRestore = addressingEvent({
      id: 'evt-addressing-restore',
      createdAt: 1_200,
      payload: {
        eventType: 'companionship_addressing',
        characterId: 'char-a',
        userId: 'user',
        action: 'set_current',
        currentAddress: '小夏',
        reason: '用户在称呼历史中恢复旧称呼。',
        confidence: 1,
      },
    });
    const directChat = chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [modelAddress, manualRestore]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说：叫我小夏。'],
        },
      }),
      messages: [message({ content: '还是叫我小夏吧。', timestamp: 1_210 })],
      now: 1_300,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '还是叫我小夏吧。', timestamp: 1_210 })],
      now: 1_300,
    });

    expect(projection.userBond?.addressing.currentAddress).toBe('小夏');
    expect(projection.userBond?.addressing.privateAddress).toBe('阿夏');
    expect(trace?.addressingHistory[0]).toMatchObject({
      id: 'evt-addressing-restore',
      action: 'set_current',
      currentAddress: '小夏',
    });
  });

  it('keeps forbidden addressing out of current and private addresses', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [
        addressingEvent({
          payload: {
            eventType: 'companionship_addressing',
            characterId: 'char-a',
            userId: 'user',
            action: 'update',
            currentAddress: '宝宝',
            privateAddress: '宝宝',
            publicAddress: '小夏',
            forbiddenAddresses: ['宝宝'],
            confidence: 0.92,
            decisionSource: 'model',
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '最近压力有点大。', timestamp: 200 })],
      now: 1_100,
    });

    expect(projection.userBond?.addressing.currentAddress).toBe('小夏');
    expect(projection.userBond?.addressing.privateAddress).toBeUndefined();
    expect(projection.userBond?.addressing.publicAddress).toBe('小夏');
  });

  it('uses unforbid addressing events to restore a previously forbidden address', () => {
    const forbidden = addressingEvent({
      id: 'evt-addressing-forbid',
      createdAt: 1_000,
      payload: {
        eventType: 'companionship_addressing',
        characterId: 'char-a',
        userId: 'user',
        action: 'forbid',
        currentAddress: '宝宝',
        forbiddenAddresses: ['宝宝'],
        confidence: 1,
        decisionSource: 'model',
      },
    });
    const unforbidden = addressingEvent({
      id: 'evt-addressing-unforbid',
      createdAt: 1_100,
      payload: {
        eventType: 'companionship_addressing',
        characterId: 'char-a',
        userId: 'user',
        action: 'unforbid',
        currentAddress: '宝宝',
        forbiddenAddresses: ['宝宝'],
        confidence: 1,
        decisionSource: 'model',
      },
    });
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [forbidden, unforbidden]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说：叫我宝宝。'],
        },
      }),
      messages: [message({ content: '最近压力有点大。', timestamp: 200 })],
      now: 1_200,
    });

    expect(projection.userBond?.addressing.forbiddenAddresses).not.toContain('宝宝');
    expect(projection.userBond?.addressing.currentAddress).toBe('宝宝');
    expect(projection.userBond?.addressing.privateAddress).toBe('宝宝');
  });

  it('exposes low-confidence or local addressing events in companionship diagnostics', () => {
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 72, trust: 66, competence: 10, threat: 2 })], [
        addressingEvent({
          id: 'evt-addressing-local',
          payload: {
            eventType: 'companionship_addressing',
            characterId: 'char-a',
            userId: 'user',
            action: 'set_private',
            privateAddress: '小夏',
            confidence: 0.62,
            decisionSource: 'local_fallback',
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '最近压力有点大。', timestamp: 200 })],
      now: 1_100,
    });

    expect(trace?.diagnostics.join('\n')).toContain('addressing: source=local_fallback confidence=62% event=evt-addressing-local');
    expect(trace?.addressingHistory).toHaveLength(1);
    expect(trace?.addressingHistory[0]).toMatchObject({
      id: 'evt-addressing-local',
      action: 'set_private',
      privateAddress: '小夏',
      decisionSource: 'local_fallback',
      confidence: 0.62,
    });
  });

  it('falls back to neutral addressing during crisis while preserving private preference', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 10, trust: -12, competence: 0, threat: 60 })], [phaseEvent({ createdAt: 100, payload: { eventType: 'companionship_phase_event', characterId: 'char-a', userId: 'user', phase: 'crisis' } })]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说：叫我小夏。'],
        },
      }),
      messages: [message({ content: '你刚刚那句话让我很不舒服。', timestamp: 200 })],
      now: 300,
    });

    expect(projection.userBond?.phase).toBe('crisis');
    expect(projection.userBond?.addressing.currentAddress).toBe('你');
    expect(projection.userBond?.addressing.privateAddress).toBe('小夏');
  });

  it('gently restores private addressing after a repair event during reconciling', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [
        relationship({ warmth: 30, trust: 18, competence: 0, threat: 28 }),
      ], [
        intimateConflictEvent({
          id: 'evt-addressing-repair',
          createdAt: 900,
          payload: {
            eventType: 'companionship_intimate_conflict',
            characterId: 'char-a',
            userId: 'user',
            action: 'resolved',
            kind: 'reconciliation',
            severity: 18,
            repairReadiness: 82,
            summary: '两个人刚刚把话说开。',
            evidence: ['用户说：那我们慢慢来，别再冷战了。'],
            participantIds: ['char-a', 'user'],
            confidence: 0.9,
            decisionSource: 'model',
          },
        }),
      ]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说：叫我小夏。'],
        },
      }),
      messages: [message({ content: '那我们慢慢来，别再冷战了。', timestamp: 920 })],
      now: 1_000,
    });

    expect(projection.userBond?.phase).toBe('reconciling');
    expect(projection.userBond?.addressing.currentAddress).toBe('小夏');
    expect(projection.userBond?.addressing.addressHistory.at(-1)?.reason).toContain('repair event restored');
  });

  it('does not restore forbidden private addressing after repair', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [
        relationship({ warmth: 30, trust: 18, competence: 0, threat: 28 }),
      ], [
        intimateConflictEvent({
          id: 'evt-addressing-repair-with-forbidden',
          createdAt: 900,
          payload: {
            eventType: 'companionship_intimate_conflict',
            characterId: 'char-a',
            userId: 'user',
            action: 'resolved',
            kind: 'reconciliation',
            participantIds: ['char-a', 'user'],
            confidence: 0.9,
            decisionSource: 'model',
          },
        }),
      ]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说：叫我小夏。', '用户说：别再叫我小夏。'],
        },
      }),
      messages: [message({ content: '那我们慢慢来。', timestamp: 920 })],
      now: 1_000,
    });

    expect(projection.userBond?.phase).toBe('reconciling');
    expect(projection.userBond?.addressing.currentAddress).toBe('你');
    expect(projection.userBond?.addressing.forbiddenAddresses).toContain('小夏');
  });

  it('drops pending care topics after the user closes the topic', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })]),
      character: character(),
      messages: [
        message({ id: 'm-1', content: '明天面试有点紧张。', timestamp: 200 }),
        message({ id: 'm-2', content: '面试结束了，已经搞定了。', timestamp: 400 }),
      ],
      now: 500,
    });

    expect(projection.userBond?.pendingCareTopics).toEqual([]);
    expect(projection.promptLines.join('\n')).not.toContain('Pending care topics');
  });

  it('blocks care topics when user rejects reminders or follow-up questions', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说明天面试会紧张。', '用户说不要提醒也别追问这件事。'],
        },
      }),
      messages: [message({ content: '明天面试有点紧张。', timestamp: 200 })],
      now: 300,
    });

    expect(projection.userBond?.pendingCareTopics).toEqual([]);
    expect(projection.promptLines.join('\n')).not.toContain('Pending care topics');
  });

  it('reads runtime care topic events into pending care projection and removes them after closure', () => {
    const opened: RuntimeEventV2[] = [{
      id: 'evt-care-open',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 200,
      actorIds: ['user'],
      targetIds: ['char-a'],
      evidenceMessageIds: ['msg-open'],
      summary: '角色记录了一个需要后续关心的用户事项',
      visibility: 'pair_private',
      payload: {
        eventType: 'companionship_care_topic',
        characterId: 'char-a',
        userId: 'user',
        topicId: 'care-char-a-interview',
        topicText: '明天面试有点紧张。',
        action: 'opened',
        urgency: 'high',
        reason: '模型判断用户明确提到自己的面试压力。',
        evidence: '明天面试有点紧张。',
        sourceMessageIds: ['msg-open'],
        confidence: 0.88,
        decisionSource: 'model',
      },
    }];
    const openProjection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], opened),
      character: character(),
      messages: [],
      now: 300,
    });

    expect(openProjection.userBond?.pendingCareTopics[0]).toMatchObject({
      source: 'runtime_event',
      text: '明天面试有点紧张。',
      status: 'active',
      sourceMessageIds: ['msg-open'],
    });
    expect(openProjection.promptLines.join('\n')).toContain('Pending care topics');
    const unrelatedClosure = buildUserCompanionshipProjection({
      chat: chat('direct', [], opened),
      character: character(),
      messages: [message({ content: '午饭已经搞定了。', timestamp: 250 })],
      now: 300,
    });
    expect(unrelatedClosure.userBond?.pendingCareTopics.map((topic) => topic.id)).toContain('care-char-a-interview');
    const openTrace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], opened),
      character: character(),
      messages: [],
      now: 300,
    });
    expect(openTrace?.careTopicHistory[0]).toMatchObject({
      action: 'opened',
      topicText: '明天面试有点紧张。',
      sourceMessageIds: ['msg-open'],
    });

    const closed: RuntimeEventV2[] = [{
      id: 'evt-care-close',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 400,
      actorIds: ['user'],
      targetIds: ['char-a'],
      evidenceMessageIds: ['msg-close'],
      summary: '角色记录用户完成了一个关心事项',
      visibility: 'pair_private',
      payload: {
        eventType: 'companionship_care_topic',
        characterId: 'char-a',
        userId: 'user',
        topicId: 'care-char-a-interview',
        topicText: '明天面试有点紧张。',
        action: 'closed',
        urgency: 'high',
        reason: '模型判断用户明确说面试已经结束。',
        evidence: '面试结束了，已经搞定了。',
        sourceMessageIds: ['msg-close'],
        confidence: 0.86,
        decisionSource: 'model',
      },
    }];
    const closedProjection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [...opened, ...closed]),
      character: character(),
      messages: [],
      now: 500,
    });

    expect(closedProjection.userBond?.pendingCareTopics).toEqual([]);
    expect(closedProjection.promptLines.join('\n')).not.toContain('Pending care topics');
    const closedTrace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [...opened, ...closed]),
      character: character(),
      messages: [],
      now: 500,
    });
    expect(closedTrace?.careTopicHistory.map((item) => item.action)).toEqual(['closed', 'opened']);
    expect(closedTrace?.careTopicHistory[0]?.sourceMessageIds).toEqual(['msg-close']);
  });

  it('uses blocked care topic runtime events to suppress matching recent-message fallback topics', () => {
    const blocked: RuntimeEventV2 = {
      id: 'evt-care-blocked-manual',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 450,
      actorIds: ['user'],
      targetIds: ['char-a'],
      summary: '用户手动关闭了一个关心事项提醒',
      visibility: 'pair_private',
      eventClass: 'artifact',
      payload: {
        eventType: 'companionship_care_topic',
        characterId: 'char-a',
        userId: 'user',
        topicId: 'care-char-a-interview-manual',
        topicText: '明天面试有点紧张。',
        action: 'blocked',
        urgency: 'medium',
        reason: '用户手动关闭该关心事项。',
        evidence: 'manual_close_from_character_relationship_tab',
        confidence: 1,
      },
    };
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [blocked]),
      character: character(),
      messages: [message({ id: 'm-1', content: '明天面试有点紧张。', timestamp: 200 })],
      now: 500,
    });

    expect(projection.userBond?.pendingCareTopics).toEqual([]);
    expect(projection.promptLines.join('\n')).not.toContain('Pending care topics');
  });

  it('blocks proactive contact when user memory rejects active disturbance', () => {
    const decision = shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说不要主动打扰，也别提醒或私聊。'],
        },
      }),
      eventKind: 'check_in',
      reasonType: 'world_attention_private_message',
      now: 300,
    });

    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('user prefers low proactive contact');
  });

  it('only blocks greeting-like check-ins when user rejects greeting rituals', () => {
    const baseCharacter = character({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说不要早安晚安。'],
      },
    });

    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: baseCharacter,
      eventKind: 'check_in',
      reasonType: 'attention_check_in',
      now: 300,
    }).blocked).toBe(true);
    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: baseCharacter,
      eventKind: 'status_update',
      reasonType: 'world_attention_calendar_reminder',
      now: 300,
    }).blocked).toBe(false);
  });

  it('projects phase-sensitive care policy into user bond and runtime trace', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [
        phaseEvent({
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            phase: 'passionate',
            style: 'romantic',
            reason: '双方确认后进入热恋期。',
            evidence: ['用户和苏苏明确说想每天多聊一点。'],
          },
        }),
      ]),
      character: character(),
      messages: [message({ timestamp: 200 })],
      now: 1_000,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [
        phaseEvent({
          payload: {
            eventType: 'companionship_phase_event',
            characterId: 'char-a',
            userId: 'user',
            phase: 'passionate',
            style: 'romantic',
          },
        }),
      ]),
      character: character(),
      messages: [message({ timestamp: 200 })],
      now: 1_000,
    });

    expect(projection.userBond?.phase).toBe('passionate');
    expect(projection.userBond?.carePolicy.dailyInitiationBudget).toBeGreaterThanOrEqual(4);
    expect(projection.userBond?.carePolicy.triggerSensitivity).toBeGreaterThanOrEqual(76);
    expect(projection.promptLines.join('\n')).toContain('Care policy: budget');
    expect(trace?.carePolicy.dailyInitiationBudget).toBeGreaterThanOrEqual(4);
  });

  it('exposes companionship local fallback diagnostics in runtime trace', () => {
    const fallbackEvent = phaseEvent({
      id: 'evt-phase-fallback',
      payload: {
        eventType: 'companionship_phase_event',
        characterId: 'char-a',
        userId: 'user',
        phase: 'reconciling',
        style: 'friend',
        confidence: 0.62,
        decisionSource: 'local_fallback',
        reason: 'local fallback detected repair wording',
        evidence: ['我们别冷战了，慢慢说开吧。'],
      },
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 46, trust: 38, competence: 10, threat: 20 })], [fallbackEvent]),
      character: character(),
      messages: [message({ content: '我们别冷战了，慢慢说开吧。', timestamp: 900 })],
      now: 1_000,
    });

    expect(trace?.diagnostics).toEqual(expect.arrayContaining([
      'phase_event: source=local_fallback confidence=62% event=evt-phase-fallback',
    ]));
  });

  it('projects pending promises into bond, prompt, status debug, and runtime trace', () => {
    const promiseCharacter = character({
      layeredMemories: [{
        id: 'promise-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '说好周末一起看那部电影，用户还想等苏苏一起。',
        evidenceText: '用户说：周末一起看那部电影吧。',
        salience: 0.86,
        confidence: 0.9,
        recency: 0.8,
        reinforcementCount: 1,
        sourceEventIds: ['evt-promise-anchor'],
        origin: 'distilled',
        createdAt: 700,
        updatedAt: 850,
      }],
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说下次要告诉苏苏面试结果。'],
      },
    });
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })]);
    const messages = [message({ content: '下次我回来告诉你结果。', timestamp: 900 })];
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: promiseCharacter,
      messages,
      now: 1_000,
    });
    const status = buildCompanionshipStatusSignature({
      chat: directChat,
      character: promiseCharacter,
      messages,
      now: 1_000,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: promiseCharacter,
      messages,
      now: 1_000,
    });

    expect(projection.userBond?.pendingPromises.map((item) => item.text).join('\n')).toContain('周末一起看');
    expect(projection.userBond?.pendingPromises.map((item) => item.text).join('\n')).toContain('告诉苏苏面试结果');
    expect(projection.promptLines.join('\n')).toContain('Pending promises/unfinished shared plans');
    expect(status?.debugLines.join('\n')).toContain('promises=');
    expect(trace?.pendingPromises.join('\n')).toContain('周末一起看');
  });

  it('reads pending promises from runtime events before fallback projections', () => {
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [promiseEvent()]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天先聊到这里。', timestamp: 900 })],
      now: 1_200,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天先聊到这里。', timestamp: 900 })],
      now: 1_200,
    });

    expect(projection.userBond?.pendingPromises[0]).toMatchObject({
      id: 'promise-weekend-movie',
      text: '周末一起看那部电影',
      source: 'runtime_event',
      status: 'open',
      evidence: '周末一起看那部电影吧。',
      sourceMessageIds: ['msg-promise-source', 'msg-promise-evidence'],
      dueAt: 2_000,
    });
    expect(projection.promptLines.join('\n')).toContain('周末一起看那部电影');
    expect(trace?.pendingPromises.join('\n')).toContain('周末一起看那部电影');
    expect(trace?.promiseHistory[0]).toMatchObject({
      id: 'evt-promise-1',
      action: 'opened',
      promiseText: '周末一起看那部电影',
      promiseKind: 'shared_activity',
      sourceMessageIds: ['msg-promise-source', 'msg-promise-evidence'],
    });
  });

  it('reads diary reflection backflow as pending promises and shared anchors', () => {
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [diaryReflectionEvent()]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天先聊到这里。', timestamp: 900 })],
      now: 1_400,
    });
    const anchors = buildSharedMemoryAnchors(character(), 1_400, directChat);

    expect(projection.userBond?.pendingPromises[0]).toMatchObject({
      text: '用户说好周末告诉苏苏面试结果。',
      source: 'shared_anchor',
      status: 'open',
    });
    expect(anchors.some((anchor) => anchor.kind === 'promise' && anchor.sourceId === 'evt-diary-reflection-1')).toBe(true);
  });

  it('reads diary reflection backflow as pending care topics', () => {
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [diaryReflectionEvent({
      id: 'evt-diary-care-1',
      payload: {
        eventType: 'companionship_diary_reflection',
        characterId: 'char-a',
        userId: 'user',
        reflectionId: 'diary-entry-care-0',
        diaryEntryId: 'diary-entry-care',
        dateKey: '2026-06-09',
        reflectionType: 'care',
        participantIds: ['char-a', 'user'],
        text: '用户最近面试压力很大，苏苏想找个合适的时候问问后来怎么样。',
        sourceSeed: '待关心事项：用户最近面试压力很大。',
        diaryExcerpt: '她没急着问，但那件事压在心里。',
        confidence: 0.66,
        decisionSource: 'local_fallback',
      },
    })]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天先聊到这里。', timestamp: 900 })],
      now: 1_400,
    });

    expect(projection.userBond?.pendingCareTopics[0]).toMatchObject({
      text: '用户最近面试压力很大，苏苏想找个合适的时候问问后来怎么样。',
      source: 'runtime_event',
      evidence: '她没急着问，但那件事压在心里。',
    });
    const closed = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '面试已经结束了。', timestamp: 1_300 })],
      now: 1_400,
    });
    expect(closed.userBond?.pendingCareTopics).toEqual([]);
  });

  it('reads diary reflection backflow as shared phrases', () => {
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [diaryReflectionEvent({
      id: 'evt-diary-shared-phrase-1',
      payload: {
        eventType: 'companionship_diary_reflection',
        characterId: 'char-a',
        userId: 'user',
        reflectionId: 'diary-entry-phrase-0',
        diaryEntryId: 'diary-entry-phrase',
        dateKey: '2026-06-09',
        reflectionType: 'shared_phrase',
        participantIds: ['char-a', 'user'],
        text: '安慰话语可以成为日记里的私下回声：“慢慢来，我在”。',
        sourceSeed: '安慰话语可以成为日记里的私下回声，避免机械复读：“慢慢来，我在”。',
        diaryExcerpt: '今天又想起那句慢慢来，我在。',
        confidence: 0.66,
        decisionSource: 'local_fallback',
      },
    })]);
    const phrases = buildSharedPhrases(character(), 1_400, directChat, []);
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天先聊到这里。', timestamp: 900 })],
      now: 1_400,
    });

    expect(phrases[0]).toMatchObject({
      text: '慢慢来，我在',
      kind: 'comfort_line',
      sourceEventIds: ['evt-diary-shared-phrase-1'],
    });
    expect(trace?.sharedPhrases.join('\n')).toContain('慢慢来，我在');
  });

  it('reads moment reflection backflow as shared anchors and shared phrases', () => {
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [
      {
        id: 'evt-moment-reflection-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 1_120,
        actorIds: ['char-a'],
        targetIds: ['user'],
        summary: '朋友圈发布留下了一条陪伴余波',
        visibility: 'pair_private',
        eventClass: 'artifact',
        payload: {
          eventType: 'companionship_moment_reflection',
          characterId: 'char-a',
          userId: 'user',
          reflectionId: 'moment-entry-1-0',
          momentDedupeKey: 'moment-entry-1',
          reflectionType: 'shared_phrase',
          participantIds: ['char-a', 'user'],
          text: '把那句“慢慢来，我在”留进了朋友圈的余味里。',
          sourceSeed: '公开动态可以只留下“有人懂”的余味，不点名用户，也不写成私密记忆：用户说下次一起把话说完。',
          momentText: '今天晒了点近况，也留了点没说完的话。',
          confidence: 0.58,
          decisionSource: 'local_fallback',
        },
      },
      {
        id: 'evt-moment-reflection-2',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 1_121,
        actorIds: ['char-a'],
        targetIds: ['b'],
        summary: '朋友圈发布留下了一条陪伴余波',
        visibility: 'role_private',
        eventClass: 'artifact',
        payload: {
          eventType: 'companionship_moment_reflection',
          characterId: 'char-a',
          reflectionId: 'moment-entry-1-1',
          momentDedupeKey: 'moment-entry-1',
          reflectionType: 'promise',
          participantIds: ['char-a', 'b'],
          text: '约定争执后先递台阶。',
          sourceSeed: '公开动态可以把和乙之间的关系余波写成一句含蓄状态，不要暴露秘密细节：共同梗/约定：约定争执后先递台阶。',
          momentText: '今天发了条动态，像是把一件事先轻轻放下。',
          confidence: 0.58,
          decisionSource: 'local_fallback',
        },
      },
    ] as RuntimeEventV2[]);
    const anchors = buildSharedMemoryAnchors(character(), 1_400, directChat);
    const phrases = buildSharedPhrases(character(), 1_400, directChat, []);

    expect(anchors.some((anchor) => anchor.kind === 'promise' && anchor.sourceId === 'evt-moment-reflection-2')).toBe(true);
    expect(phrases.some((phrase) => phrase.sourceEventIds?.includes('evt-moment-reflection-1'))).toBe(true);
  });

  it('drops pending promises outside the configured retention window', () => {
    setCompanionshipRuntimeConfig({
      ...DEFAULT_COMPANIONSHIP_SETTINGS,
      pendingPromiseRetentionDays: 7,
    });
    const now = 40 * 24 * 60 * 60 * 1000;
    const oldAt = now - 30 * 24 * 60 * 60 * 1000;
    const promiseCharacter = character({
      layeredMemories: [{
        id: 'old-promise-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '说好下次一起补看那部旧电影。',
        evidenceText: '用户说：下次一起补看那部旧电影。',
        salience: 0.86,
        confidence: 0.9,
        recency: 0.8,
        reinforcementCount: 1,
        sourceEventIds: ['evt-old-promise-anchor'],
        origin: 'distilled',
        createdAt: oldAt,
        updatedAt: oldAt,
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [
      promiseEvent({
        id: 'evt-old-promise',
        createdAt: oldAt,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-old-movie',
          promiseText: '下次一起补看那部旧电影',
          action: 'opened',
          participantIds: ['char-a', 'user'],
          evidence: '下次一起补看那部旧电影。',
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: promiseCharacter,
      messages: [message({ id: 'msg-old-promise', content: '下次一起补看那部旧电影。', timestamp: oldAt })],
      now,
    });

    expect(projection.userBond?.pendingPromises).toEqual([]);
    expect(projection.promptLines.join('\n')).not.toContain('Pending promises/unfinished shared plans');
  });

  it('keeps old pending promise events when their due time is still relevant', () => {
    setCompanionshipRuntimeConfig({
      ...DEFAULT_COMPANIONSHIP_SETTINGS,
      pendingPromiseRetentionDays: 7,
    });
    const now = 40 * 24 * 60 * 60 * 1000;
    const oldAt = now - 30 * 24 * 60 * 60 * 1000;
    const futureDueAt = now + 2 * 24 * 60 * 60 * 1000;
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [
      promiseEvent({
        id: 'evt-future-promise',
        createdAt: oldAt,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-future-movie',
          promiseText: '下周一起补看那部电影',
          action: 'opened',
          participantIds: ['char-a', 'user'],
          evidence: '下周一起补看那部电影。',
          dueAt: futureDueAt,
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [],
      now,
    });

    expect(projection.userBond?.pendingPromises[0]).toMatchObject({
      id: 'promise-future-movie',
      text: '下周一起补看那部电影',
      source: 'runtime_event',
      dueAt: futureDueAt,
    });
    expect(projection.promptLines.join('\n')).toContain('下周一起补看那部电影');
  });

  it('suppresses old fallback promise text after a manual promise correction', () => {
    const oldAt = 1_000;
    const now = 2_000;
    const promiseCharacter = character({
      layeredMemories: [{
        id: 'old-promise-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '说好周末一起看那部旧电影。',
        evidenceText: '用户说：周末一起看那部旧电影。',
        salience: 0.86,
        confidence: 0.9,
        recency: 0.8,
        reinforcementCount: 1,
        sourceEventIds: ['evt-old-promise-anchor'],
        origin: 'distilled',
        createdAt: oldAt,
        updatedAt: oldAt,
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [
      promiseEvent({
        id: 'evt-corrected-promise',
        createdAt: now,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-weekend-movie',
          promiseText: '周六晚上一起看那部新电影',
          supersedesText: '周末一起看那部旧电影',
          action: 'opened',
          participantIds: ['char-a', 'user'],
          promiseKind: 'shared_activity',
          evidence: '用户在角色关系页手动修正该未完成约定。',
          confidence: 1,
          decisionSource: 'user_override',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: promiseCharacter,
      messages: [],
      now,
    });

    const promiseTexts = projection.userBond?.pendingPromises.map((promise) => promise.text) || [];
    expect(promiseTexts).toContain('周六晚上一起看那部新电影');
    expect(promiseTexts.join('\n')).not.toContain('周末一起看那部旧电影');
    expect(projection.promptLines.join('\n')).toContain('周六晚上一起看那部新电影');
    expect(projection.promptLines.join('\n')).not.toContain('周末一起看那部旧电影');
  });

  it('keeps the merged promise and suppresses the duplicate promise after manual merge events', () => {
    const now = 2_000;
    const promiseCharacter = character({
      layeredMemories: [{
        id: 'duplicate-promise-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '说好周末一起看电影。',
        evidenceText: '用户说周末一起看电影。',
        salience: 0.86,
        confidence: 0.9,
        recency: 0.8,
        reinforcementCount: 1,
        sourceEventIds: ['evt-duplicate-promise-anchor'],
        origin: 'distilled',
        createdAt: 900,
        updatedAt: 900,
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [
      promiseEvent({
        id: 'evt-merged-main-promise',
        createdAt: now,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-weekend-movie',
          promiseText: '周末一起看电影；看完再聊感想',
          supersedesText: '周末一起看电影',
          action: 'opened',
          participantIds: ['char-a', 'user'],
          promiseKind: 'shared_activity',
          evidence: 'manual_merge_from_character_relationship_tab',
          confidence: 1,
          decisionSource: 'user_override',
        },
      }),
      promiseEvent({
        id: 'evt-merged-duplicate-revoked',
        createdAt: now + 1,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-movie-aftertalk',
          promiseText: '看完再聊感想',
          action: 'revoked',
          participantIds: ['char-a', 'user'],
          promiseKind: 'user_followup',
          evidence: 'manual_merge_from_character_relationship_tab',
          confidence: 1,
          decisionSource: 'user_override',
        },
      }),
    ]);
    const messages = [message({ id: 'msg-duplicate-promise', content: '看完再聊感想', timestamp: 1_100 })];
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: promiseCharacter,
      messages,
      now: now + 10,
    });

    const promiseTexts = projection.userBond?.pendingPromises.map((promise) => promise.text) || [];
    expect(promiseTexts).toContain('周末一起看电影；看完再聊感想');
    expect(promiseTexts).not.toContain('看完再聊感想');
    expect(promiseTexts.join('\n')).not.toContain('说好周末一起看电影');
    expect(projection.promptLines.join('\n')).toContain('周末一起看电影；看完再聊感想');
  });

  it('projects promise semantics and reminder policy from model events and boundary text', () => {
    const now = 5_000;
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [
      promiseEvent({
        id: 'evt-repair-promise',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-repair-talk',
          promiseText: '以后吵架我们先冷静一下再说开',
          action: 'opened',
          participantIds: ['char-a', 'user'],
          promiseKind: 'repair_agreement',
          reminderPolicy: { shouldRemind: true, tone: 'apologetic', maxFollowUps: 1, seedIntent: '记得修复约定，先放软。' },
          evidence: '用户和苏苏说好以后吵架先冷静再说开。',
          dueAt: now - 100,
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说不要再提醒之前那个约定。'],
        },
      }),
      messages: [],
      now,
    });

    const promises = projection.userBond?.pendingPromises || [];
    expect(promises.find((promise) => promise.id === 'promise-repair-talk')).toMatchObject({
      id: 'promise-repair-talk',
      kind: 'repair_agreement',
      reminderPolicy: {
        shouldRemind: true,
        tone: 'apologetic',
      },
    });
    expect(promises.some((promise) => promise.kind === 'boundary_agreement' && !promise.reminderPolicy.shouldRemind)).toBe(true);
    expect(projection.promptLines.join('\n')).toContain('修复约定');
    expect(projection.promptLines.join('\n')).toContain('do not proactively remind');
  });

  it('applies fulfilled and missed promise consequences to intimacy projection', () => {
    const now = 5_000;
    const baseChat = chat('direct', [relationship({ warmth: 46, trust: 34, competence: 10, threat: 4 })]);
    const fulfilledChat = chat('direct', [relationship({ warmth: 46, trust: 34, competence: 10, threat: 4 })], [
      promiseEvent({
        id: 'evt-repair-fulfilled',
        createdAt: now - 100,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-repair-talk',
          promiseText: '以后吵架我们先冷静一下再说开',
          action: 'fulfilled',
          participantIds: ['char-a', 'user'],
          promiseKind: 'repair_agreement',
          relationshipEffects: { fulfilled: { security: 8, intimacy: 5 } },
          evidence: '这次他们真的先冷静，然后把话说开了。',
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);
    const blockedChat = chat('direct', [relationship({ warmth: 46, trust: 34, competence: 10, threat: 4 })], [
      promiseEvent({
        id: 'evt-boundary-blocked',
        createdAt: now - 100,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-boundary',
          promiseText: '说好不要越过这个边界',
          action: 'blocked',
          participantIds: ['char-a', 'user'],
          promiseKind: 'boundary_agreement',
          relationshipEffects: { missed: { security: -12, intimacy: -4 } },
          evidence: '这次还是越界了。',
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);

    const base = buildUserCompanionshipProjection({ chat: baseChat, character: character(), messages: [], now }).userBond?.intimacy;
    const fulfilled = buildUserCompanionshipProjection({ chat: fulfilledChat, character: character(), messages: [], now }).userBond?.intimacy;
    const blocked = buildUserCompanionshipProjection({ chat: blockedChat, character: character(), messages: [], now }).userBond?.intimacy;

    expect(fulfilled?.security).toBeGreaterThan(base?.security || 0);
    expect(fulfilled?.intimacy).toBeGreaterThan(base?.intimacy || 0);
    expect(blocked?.security).toBeLessThan(base?.security || 100);
  });

  it('feeds pending care topics and promises into private diary seeds but not public moment seeds', () => {
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [
      {
        id: 'evt-care-topic-diary',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 1_000,
        actorIds: ['user', 'char-a'],
        targetIds: ['char-a', 'user'],
        summary: '苏苏记录了一个需要后续关心的话题。',
        visibility: 'pair_private',
        eventClass: 'artifact',
        payload: {
          eventType: 'companionship_care_topic',
          characterId: 'char-a',
          userId: 'user',
          topicId: 'care-interview',
          topicText: '明天面试有点紧张',
          action: 'opened',
          urgency: 'high',
          evidence: '用户说：明天面试有点紧张。',
          dueAt: 2_000,
          confidence: 0.9,
          decisionSource: 'model',
        },
      } as RuntimeEventV2,
      promiseEvent(),
    ]);
    const privateSeeds = buildCompanionshipArtifactSeeds({
      character: character(),
      chat: directChat,
      messages: [message({ content: '明天面试有点紧张。', timestamp: 900 })],
      surface: 'private_diary',
      max: 8,
      now: 1_200,
    });
    const publicSeeds = buildCompanionshipArtifactSeeds({
      character: character(),
      chat: directChat,
      messages: [message({ content: '明天面试有点紧张。', timestamp: 900 })],
      surface: 'public_moment',
      max: 8,
      now: 1_200,
    });

    expect(privateSeeds.join('\n')).toContain('未完成关心事项');
    expect(privateSeeds.join('\n')).toContain('明天面试');
    expect(privateSeeds.join('\n')).toContain('未完成约定');
    expect(privateSeeds.join('\n')).toContain('周末一起看那部电影');
    expect(publicSeeds.join('\n')).not.toContain('明天面试');
    expect(publicSeeds.join('\n')).not.toContain('周末一起看那部电影');
  });

  it('uses closed promise events to suppress matching fallback promises', () => {
    const promiseCharacter = character({
      layeredMemories: [{
        id: 'promise-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '说好周末一起看那部电影，用户还想等苏苏一起。',
        evidenceText: '用户说：周末一起看那部电影吧。',
        salience: 0.86,
        confidence: 0.9,
        recency: 0.8,
        reinforcementCount: 1,
        sourceEventIds: ['evt-promise-anchor'],
        origin: 'distilled',
        createdAt: 700,
        updatedAt: 850,
      }],
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说下次要告诉苏苏面试结果。'],
      },
    });
    const directChat = chat('direct', [relationship({ warmth: 62, trust: 58, competence: 10, threat: 4 })], [
      promiseEvent({
        id: 'evt-promise-fulfilled-movie',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-weekend-movie',
          promiseText: '周末一起看那部电影',
          action: 'fulfilled',
          participantIds: ['char-a', 'user'],
          evidence: '已经一起看完了。',
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
      promiseEvent({
        id: 'evt-promise-revoked-interview',
        createdAt: 1_120,
        payload: {
          eventType: 'companionship_promise',
          characterId: 'char-a',
          userId: 'user',
          promiseId: 'promise-interview-result',
          promiseText: '告诉苏苏面试结果',
          action: 'revoked',
          participantIds: ['char-a', 'user'],
          evidence: '这个不用再问了。',
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: promiseCharacter,
      messages: [message({ content: '今天先聊到这里。', timestamp: 900 })],
      now: 1_200,
    });

    const pendingText = projection.userBond?.pendingPromises.map((item) => item.text).join('\n') || '';
    expect(pendingText).not.toContain('周末一起看');
    expect(pendingText).not.toContain('告诉苏苏面试结果');
    expect(projection.promptLines.join('\n')).not.toContain('Pending promises/unfinished shared plans');
  });

  it('does not infer a conflict kind from crisis phase evidence', () => {
    const crisis = phaseEvent({
      id: 'evt-crisis-1',
      createdAt: 900,
      summary: '用户表达被苏苏的话伤到，需要先冷静。',
      payload: {
        eventType: 'companionship_phase_event',
        characterId: 'char-a',
        userId: 'user',
        phase: 'crisis',
        style: 'friend',
        reason: '用户明确表达关系危机。',
        evidence: ['你刚刚那句话让我很受伤，我们先冷静一下。'],
      },
    });
    const directChat = chat('direct', [relationship({
      warmth: 32,
      trust: 18,
      competence: 10,
      threat: 42,
    })], [crisis]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '你刚刚那句话让我很受伤，我们先冷静一下。', timestamp: 900 })],
      now: 1_000,
    });
    const status = buildCompanionshipStatusSignature({
      chat: directChat,
      character: character(),
      messages: [message({ content: '你刚刚那句话让我很受伤，我们先冷静一下。', timestamp: 900 })],
      now: 1_000,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '你刚刚那句话让我很受伤，我们先冷静一下。', timestamp: 900 })],
      now: 1_000,
    });

    expect(projection.userBond?.phase).toBe('crisis');
    expect(projection.userBond?.intimateConflict).toBeUndefined();
    expect(projection.promptLines.join('\n')).not.toContain('Current intimate conflict/repair state');
    expect(status?.debugLines.join('\n')).not.toContain('conflict=');
    expect(trace?.intimateConflict).toBeUndefined();
  });

  it('keeps reconciling phase evidence without inventing conflict details', () => {
    const repairCharacter = character({
      layeredMemories: [{
        id: 'repair-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '那次冷战后，用户和苏苏慢慢说开并和好了。',
        evidenceText: '用户说我们别冷战了，慢慢说开吧。',
        salience: 0.88,
        confidence: 0.9,
        recency: 0.8,
        reinforcementCount: 1,
        sourceEventIds: ['evt-repair-anchor'],
        origin: 'distilled',
        createdAt: 700,
        updatedAt: 850,
      }],
    });
    const repair = phaseEvent({
      id: 'evt-repair-1',
      createdAt: 900,
      summary: '用户愿意和苏苏重新说开。',
      payload: {
        eventType: 'companionship_phase_event',
        characterId: 'char-a',
        userId: 'user',
        phase: 'reconciling',
        style: 'friend',
        reason: '用户表达修复意愿。',
        evidence: ['我们别冷战了，慢慢说开吧。'],
      },
    });
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({
        warmth: 48,
        trust: 38,
        competence: 10,
        threat: 24,
      })], [repair]),
      character: repairCharacter,
      messages: [message({ content: '我们别冷战了，慢慢说开吧。', timestamp: 900 })],
      now: 1_000,
    });

    expect(projection.userBond?.phase).toBe('reconciling');
    expect(projection.userBond?.intimateConflict).toBeUndefined();
    expect(projection.evidence.join('\n')).toContain('慢慢说开');
  });

  it('uses repair shared anchors to infer reconciling phase when no phase event exists', () => {
    const repairCharacter = character({
      layeredMemories: [{
        id: 'repair-anchor-only',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '那次误会之后，用户和苏苏互相道歉并慢慢说开了。',
        evidenceText: '用户说我们把误会说开吧，苏苏认真道歉。',
        salience: 0.88,
        confidence: 0.9,
        recency: 0.8,
        reinforcementCount: 1,
        sourceEventIds: ['evt-repair-anchor-only'],
        origin: 'distilled',
        createdAt: 700,
        updatedAt: 850,
      }],
    });
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({
        warmth: 42,
        trust: 34,
        competence: 10,
        threat: 18,
      })]),
      character: repairCharacter,
      messages: [message({ content: '我们把误会说开吧。', timestamp: 850 })],
      now: 1_000,
    });

    expect(projection.userBond?.phase).toBe('reconciling');
    expect(projection.userBond?.phaseEvidence.join('\n')).toContain('shared anchor');
    expect(projection.userBond?.intimateConflict).toBeUndefined();
  });

  it('prioritizes explicit intimate conflict runtime events over inferred conflict projection', () => {
    const directChat = chat('direct', [relationship({
      warmth: 40,
      trust: 34,
      competence: 10,
      threat: 52,
    })], [intimateConflictEvent()]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '我们先别冷战了，慢慢说开。', timestamp: 990 })],
      now: 1_100,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '我们先别冷战了，慢慢说开。', timestamp: 990 })],
      now: 1_100,
    });

    expect(projection.userBond?.intimateConflict).toMatchObject({
      kind: 'repair_attempt',
      severity: 44,
      repairReadiness: 68,
      summary: '两个人还没有完全说开，但用户愿意给一个台阶。',
      participantIds: ['char-a', 'user'],
    });
    expect(projection.userBond?.intimateConflict?.sourceEventIds).toEqual(expect.arrayContaining(['evt-intimate-conflict-1', 'evt-source-conflict']));
    expect(projection.userBond?.intimateConflict?.sourceMessageIds).toEqual(['msg-conflict-source', 'msg-conflict-evidence']);
    expect(projection.promptLines.join('\n')).toContain('Current intimate conflict/repair state');
    expect(trace?.intimateConflict?.repairReadiness).toBe(68);
    expect(trace?.intimateConflict?.sourceMessageIds).toEqual(['msg-conflict-source', 'msg-conflict-evidence']);
    expect(trace?.conflictHistory[0]).toMatchObject({
      id: 'evt-intimate-conflict-1',
      action: 'repair_attempted',
      kind: 'repair_attempt',
      severity: 44,
      repairReadiness: 68,
      decisionSource: 'model',
      sourceMessageIds: ['msg-conflict-source', 'msg-conflict-evidence'],
    });
    expect(trace?.conflictHistory[0]?.evidence.join('\n')).toContain('慢慢说开');
  });

  it('uses resolved intimate conflict events to keep recent repair from being overwritten by old ledger tension', () => {
    const directChat = chat('direct', [relationship({
      warmth: 32,
      trust: 24,
      competence: 10,
      threat: 58,
    })], [intimateConflictEvent({
      id: 'evt-intimate-resolved',
      createdAt: 1_200,
      summary: '用户和苏苏已经把误会说开。',
      payload: {
        eventType: 'companionship_intimate_conflict',
        characterId: 'char-a',
        userId: 'user',
        action: 'resolved',
        kind: 'repair_attempt',
        severity: 16,
        repairReadiness: 86,
        summary: '误会已经说开，但表达上仍要留一点余波。',
        evidence: ['用户说：这件事说开了，我们就别翻旧账了。'],
        participantIds: ['char-a', 'user'],
        confidence: 0.91,
        decisionSource: 'model',
      },
    })]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '这件事说开了，我们就别翻旧账了。', timestamp: 1_190 })],
      now: 1_300,
    });

    expect(projection.userBond?.intimateConflict).toMatchObject({
      kind: 'reconciliation',
      severity: 16,
      repairReadiness: 86,
    });
    expect(projection.userBond?.intimateConflict?.summary).toContain('误会已经说开');
  });

  it('uses dismissed intimate conflict events to suppress mistaken conflict inference', () => {
    const directChat = chat('direct', [relationship({
      warmth: 32,
      trust: 24,
      competence: 10,
      threat: 58,
    })], [intimateConflictEvent({
      id: 'evt-intimate-dismissed',
      createdAt: 1_200,
      summary: '用户标记这不是一次亲密冲突。',
      payload: {
        eventType: 'companionship_intimate_conflict',
        characterId: 'char-a',
        userId: 'user',
        action: 'dismissed',
        kind: 'testing',
        severity: 0,
        repairReadiness: 0,
        summary: '这不是一次亲密冲突。',
        evidence: ['用户在关系页点了不是冲突。'],
        participantIds: ['char-a', 'user'],
        confidence: 1,
      },
    })]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '刚才不是吵架。', timestamp: 1_190 })],
      now: 1_300,
    });

    expect(projection.userBond?.intimateConflict).toBeUndefined();
    expect(projection.promptLines.join('\n')).not.toContain('Current intimate conflict/repair state');
  });

  it('lets a reopened intimate conflict event restore a dismissed history item', () => {
    const directChat = chat('direct', [relationship({
      warmth: 32,
      trust: 24,
      competence: 10,
      threat: 58,
    })], [
      intimateConflictEvent({
        id: 'evt-intimate-opened-before-dismiss',
        createdAt: 1_000,
        summary: '用户和苏苏有一次冷战。',
        payload: {
          eventType: 'companionship_intimate_conflict',
          characterId: 'char-a',
          userId: 'user',
          action: 'opened',
          kind: 'cold_war',
          severity: 72,
          repairReadiness: 18,
          summary: '两个人在冷战，角色需要先克制一点。',
          evidence: ['用户说：先别聊了，我有点失望。'],
          participantIds: ['char-a', 'user'],
          sourceMessageIds: ['msg-opened-source'],
          confidence: 0.86,
          decisionSource: 'model',
        },
      }),
      intimateConflictEvent({
        id: 'evt-intimate-dismissed',
        createdAt: 1_100,
        summary: '用户标记这不是一次亲密冲突。',
        payload: {
          eventType: 'companionship_intimate_conflict',
          characterId: 'char-a',
          userId: 'user',
          action: 'dismissed',
          kind: 'cold_war',
          severity: 0,
          repairReadiness: 0,
          summary: '这不是一次亲密冲突。',
          evidence: ['用户在关系页点了不是冲突。'],
          participantIds: ['char-a', 'user'],
          sourceEventIds: ['evt-intimate-opened-before-dismiss'],
          sourceMessageIds: ['msg-opened-source'],
          confidence: 1,
        },
      }),
      intimateConflictEvent({
        id: 'evt-intimate-reopened',
        createdAt: 1_200,
        summary: '用户从冲突历史中恢复了这次冷战判断。',
        payload: {
          eventType: 'companionship_intimate_conflict',
          characterId: 'char-a',
          userId: 'user',
          action: 'reopened',
          kind: 'cold_war',
          severity: 72,
          repairReadiness: 18,
          summary: '两个人在冷战，角色需要先克制一点。',
          evidence: ['manual_restore_from_conflict_history', '用户说：先别聊了，我有点失望。'],
          participantIds: ['char-a', 'user'],
          sourceEventIds: ['evt-intimate-opened-before-dismiss'],
          sourceMessageIds: ['msg-opened-source'],
          confidence: 1,
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '先别聊了，我有点失望。', timestamp: 990 })],
      now: 1_300,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '先别聊了，我有点失望。', timestamp: 990 })],
      now: 1_300,
    });

    expect(projection.userBond?.intimateConflict).toMatchObject({
      kind: 'cold_war',
      severity: 72,
      repairReadiness: 18,
      summary: '两个人在冷战，角色需要先克制一点。',
    });
    expect(projection.promptLines.join('\n')).toContain('Current intimate conflict/repair state');
    expect(trace?.conflictHistory.map((item) => item.action).slice(0, 3)).toEqual(['reopened', 'dismissed', 'opened']);
    expect(projection.userBond?.intimateConflict?.sourceEventIds).toEqual(expect.arrayContaining(['evt-intimate-reopened', 'evt-intimate-opened-before-dismiss']));
    expect(trace?.intimateConflict?.sourceMessageIds).toEqual(['msg-opened-source', 'msg-conflict-evidence']);
  });

  it('derives shared memory anchors from intimate conflict runtime events', () => {
    const directChat = chat('direct', [relationship({
      warmth: 34,
      trust: 28,
      competence: 10,
      threat: 48,
    })], [intimateConflictEvent({
      id: 'evt-intimate-anchor',
      createdAt: 1_200,
      summary: '用户和苏苏把一次冷战慢慢说开。',
      payload: {
        eventType: 'companionship_intimate_conflict',
        characterId: 'char-a',
        userId: 'user',
        action: 'resolved',
        kind: 'reconciliation',
        severity: 18,
        repairReadiness: 88,
        summary: '冷战后双方愿意重新接近。',
        evidence: ['用户说：这次说开以后，就别再用沉默互相试探了。'],
        participantIds: ['char-a', 'user'],
        confidence: 0.9,
        decisionSource: 'model',
      },
    })]);
    const anchors = buildSharedMemoryAnchors(character(), 1_300, directChat);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '这次说开以后，就别再用沉默互相试探了。', timestamp: 1_190 })],
      now: 1_300,
    });

    expect(anchors.find((anchor) => anchor.id === 'runtime-evt-intimate-anchor')).toMatchObject({
      kind: 'repair',
      source: 'runtime_event',
      sourceId: 'evt-intimate-anchor',
      participantIds: ['char-a', 'user'],
    });
    expect(anchors.find((anchor) => anchor.id === 'runtime-evt-intimate-anchor')?.evidence).toContain('沉默互相试探');
    expect(projection.evidence.join('\n')).toContain('冷战后双方愿意重新接近');
    expect(projection.promptLines.join('\n')).toContain('Shared memory anchors with the user');
  });

  it('projects explicit shared anchor runtime events into anchors and direct prompt evidence', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [sharedAnchorEvent()]);
    const anchors = buildSharedMemoryAnchors(character(), 1_300, directChat);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '那天谢谢你陪我聊到很晚。', timestamp: 1_100 })],
      now: 1_300,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '那天谢谢你陪我聊到很晚。', timestamp: 1_100 })],
      now: 1_300,
    });

    expect(anchors.find((anchor) => anchor.id === 'runtime-anchor-late-night-anchor')).toMatchObject({
      kind: 'first_time',
      source: 'runtime_event',
      participantIds: ['char-a', 'user'],
      title: '第一次深夜聊天',
      sourceMessageIds: ['msg-anchor-source', 'msg-anchor-evidence'],
    });
    expect(projection.promptLines.join('\n')).toContain('第一次深夜聊天后，苏苏记住了用户没有离开');
    expect(trace?.sharedAnchors.join('\n')).toContain('第一次深夜聊天');
    expect(trace?.sharedAnchorHistory[0]).toMatchObject({
      action: 'upsert',
      anchorId: 'late-night-anchor',
      kind: 'first_time',
      title: '第一次深夜聊天',
      sourceMessageIds: ['msg-anchor-source', 'msg-anchor-evidence'],
      decisionSource: 'model',
    });
    expect(trace?.sharedAnchorHistory[0]?.text).toContain('第一次深夜聊天后');
  });

  it('uses later shared anchor upserts to narrow participants to the user pair', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedAnchorEvent({
        id: 'evt-shared-anchor-extra-participant',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_anchor',
          characterId: 'char-a',
          userId: 'user',
          anchorId: 'late-night-anchor',
          action: 'upsert',
          kind: 'first_time',
          participantIds: ['char-a', 'user', 'char-b'],
          title: '第一次深夜聊天',
          text: '第一次深夜聊天后，苏苏记住了用户没有离开。',
          evidence: '旧事件误把另一个角色放进共同锚点。',
          sourceMessageIds: ['msg-anchor-original'],
          salience: 82,
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
      sharedAnchorEvent({
        id: 'evt-shared-anchor-pair-private',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_shared_anchor',
          characterId: 'char-a',
          userId: 'user',
          anchorId: 'late-night-anchor',
          action: 'upsert',
          kind: 'first_time',
          participantIds: ['char-a', 'user'],
          title: '第一次深夜聊天',
          text: '第一次深夜聊天后，苏苏记住了用户没有离开。',
          evidence: 'manual_shared_anchor_participants_pair_private_from_character_relationship_tab',
          sourceMessageIds: ['msg-anchor-manual'],
          salience: 82,
          confidence: 1,
          decisionSource: 'model',
        },
      }),
    ]);

    const anchors = buildSharedMemoryAnchors(character(), 1_300, directChat);
    const anchor = anchors.find((item) => item.id === 'runtime-anchor-late-night-anchor');

    expect(anchor?.participantIds).toEqual(['char-a', 'user']);
    expect(anchor?.participantIds).not.toContain('char-b');
    expect(anchor?.sourceMessageIds).toEqual(['msg-anchor-original', 'msg-anchor-evidence', 'msg-anchor-manual']);
  });

  it('automatically narrows user direct shared anchors that accidentally include third-party participants', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedAnchorEvent({
        id: 'evt-shared-anchor-auto-pair-private',
        payload: {
          eventType: 'companionship_shared_anchor',
          characterId: 'char-a',
          userId: 'user',
          anchorId: 'late-night-anchor',
          action: 'upsert',
          kind: 'first_time',
          participantIds: ['char-a', 'user', 'char-b'],
          title: '第一次深夜聊天',
          text: '第一次深夜聊天后，苏苏记住了用户没有离开。',
          evidence: '模型误把另一个角色放进用户单聊共同锚点。',
          salience: 82,
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);

    const anchors = buildSharedMemoryAnchors(character(), 1_300, directChat);
    const anchor = anchors.find((item) => item.id === 'runtime-anchor-late-night-anchor');

    expect(anchor?.participantIds).toEqual(['char-a', 'user']);
  });

  it('projects shared phrases into prompt, trace, and private artifact seeds', () => {
    const phraseCharacter = character({
      layeredMemories: [{
        id: 'anchor-promise-line',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '两个人说好以后吵架时先说“慢慢来，我在”。',
        evidenceText: '这是冲突修复后的约定话语。',
        salience: 0.86,
        confidence: 0.88,
        recency: 0.7,
        reinforcementCount: 2,
        sourceEventIds: ['evt-anchor-promise-line'],
        createdAt: 900,
        updatedAt: 900,
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [sharedPhraseEvent()]);
    const messages = [message({ id: 'msg-phrase', content: '以后我们之间的暗号就叫“慢慢来，我在”。', timestamp: 1_050 })];
    const phrases = buildSharedPhrases(phraseCharacter, 1_300, directChat, messages);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: phraseCharacter,
      messages,
      now: 1_300,
    });
    const status = buildCompanionshipStatusSignature({
      chat: directChat,
      character: phraseCharacter,
      messages,
      now: 1_300,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: phraseCharacter,
      messages,
      now: 1_300,
    });
    const seeds = buildCompanionshipArtifactSeeds({
      character: phraseCharacter,
      chat: directChat,
      messages,
      surface: 'private_diary',
      now: 1_300,
    });

    expect(phrases.find((phrase) => phrase.id === 'phrase-slowly')).toMatchObject({
      kind: 'comfort_line',
      text: '慢慢来，我在',
      reuseCount: 2,
      sourceMessageIds: ['msg-model-phrase'],
    });
    expect(phrases.some((phrase) => phrase.kind === 'promise_line' && phrase.text.includes('慢慢来'))).toBe(true);
    expect(projection.promptLines.join('\n')).toContain('Shared phrases/private lines');
    expect(status?.debugLines.join('\n')).toContain('sharedPhrases=');
    expect(trace?.sharedPhrases.join('\n')).toContain('慢慢来，我在');
    expect(seeds.join('\n')).toContain('安慰话语');
    expect(seeds.join('\n')).toContain('慢慢来，我在');
  });

  it('uses suppressed shared phrase events to suppress matching anchor and recent-message fallbacks', () => {
    const phraseCharacter = character({
      layeredMemories: [{
        id: 'anchor-suppressed-phrase',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '两个人说好以后吵架时先说“慢慢来，我在”。',
        evidenceText: '这是冲突修复后的约定话语。',
        salience: 0.86,
        confidence: 0.88,
        recency: 0.7,
        reinforcementCount: 2,
        sourceEventIds: ['evt-anchor-suppressed-phrase'],
        createdAt: 900,
        updatedAt: 900,
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedPhraseEvent({
        id: 'evt-shared-phrase-suppressed',
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'manual-suppress-slowly',
          action: 'suppressed',
          text: '慢慢来，我在',
          kind: 'inside_joke',
          participantIds: ['char-a', 'user'],
          visibility: 'between_actors',
          reason: '用户不想让这句话再被复用。',
          evidence: 'manual_suppress_from_character_relationship_tab',
          confidence: 1,
        },
      }),
      sharedPhraseEvent({
        id: 'evt-shared-phrase-anchor-suppressed',
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'manual-suppress-anchor-line',
          action: 'suppressed',
          text: '两个人说好以后吵架时先说“慢慢来，我在”。',
          kind: 'promise_line',
          participantIds: ['char-a', 'user'],
          visibility: 'between_actors',
          reason: '用户不想让这句约定话语再进入上下文。',
          evidence: 'manual_suppress_from_character_relationship_tab',
          confidence: 1,
        },
      }),
    ]);
    const messages = [message({ id: 'msg-phrase-suppressed', content: '以后我们之间的暗号就叫“慢慢来，我在”。', timestamp: 1_050 })];
    const phrases = buildSharedPhrases(phraseCharacter, 1_300, directChat, messages);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: phraseCharacter,
      messages,
      now: 1_300,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: phraseCharacter,
      messages,
      now: 1_300,
    });

    expect(phrases.map((phrase) => phrase.text).join('\n')).not.toContain('慢慢来，我在');
    expect(projection.promptLines.join('\n')).not.toContain('Shared phrases/private lines');
    expect(trace?.sharedPhrases.join('\n')).not.toContain('慢慢来，我在');
  });

  it('tracks shared phrase history and lets a later restore event re-enable a suppressed phrase', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedPhraseEvent({
        id: 'evt-shared-phrase-original',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-slowly',
          action: 'upsert',
          text: '慢慢来，我在',
          kind: 'comfort_line',
          participantIds: ['char-a', 'user'],
          visibility: 'private',
          firstSaidBy: 'char-a',
          reason: '第一次形成安慰话语。',
          evidence: '苏苏说慢慢来，我在。',
          sourceMessageIds: ['msg-phrase-original'],
          emotionalWeight: 70,
          reuseCount: 1,
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
      sharedPhraseEvent({
        id: 'evt-shared-phrase-suppressed',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-slowly',
          action: 'suppressed',
          text: '慢慢来，我在',
          kind: 'comfort_line',
          participantIds: ['char-a', 'user'],
          visibility: 'private',
          firstSaidBy: 'char-a',
          reason: '用户暂时不想复用这句话。',
          evidence: 'manual_shared_phrase_suppressed',
          sourceMessageIds: ['msg-phrase-original'],
          emotionalWeight: 70,
          reuseCount: 1,
          confidence: 1,
        },
      }),
      sharedPhraseEvent({
        id: 'evt-shared-phrase-restored',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-slowly',
          action: 'upsert',
          text: '慢慢来，我在',
          kind: 'comfort_line',
          participantIds: ['char-a', 'user'],
          visibility: 'private',
          firstSaidBy: 'char-a',
          reason: '用户从共同话语历史恢复。',
          evidence: 'manual_restore_from_shared_phrase_history',
          sourceMessageIds: ['msg-phrase-original'],
          emotionalWeight: 70,
          reuseCount: 1,
          confidence: 1,
        },
      }),
    ]);
    const phrases = buildSharedPhrases(character(), 1_300, directChat, []);
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [],
      now: 1_300,
    });

    expect(phrases.find((phrase) => phrase.id === 'phrase-slowly')).toMatchObject({
      text: '慢慢来，我在',
      visibility: 'private',
    });
    expect(trace?.sharedPhraseHistory.map((item) => item.action).slice(0, 3)).toEqual(['upsert', 'suppressed', 'upsert']);
    expect(trace?.sharedPhraseHistory[0]).toMatchObject({
      id: 'evt-shared-phrase-restored',
      phraseId: 'phrase-slowly',
      text: '慢慢来，我在',
      kind: 'comfort_line',
      sourceMessageIds: ['msg-phrase-original', 'msg-model-phrase'],
    });
  });

  it('uses later shared phrase upserts to correct kind and visibility', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedPhraseEvent({
        id: 'evt-shared-phrase-original',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-slowly',
          action: 'upsert',
          text: '慢慢来，我在',
          kind: 'inside_joke',
          participantIds: ['char-a', 'user'],
          visibility: 'public_hint',
          firstSaidBy: 'char-a',
          reason: '旧分类把这句话当成公开共同梗。',
          evidence: '旧分类证据',
          emotionalWeight: 72,
          reuseCount: 1,
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
      sharedPhraseEvent({
        id: 'evt-shared-phrase-corrected',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-slowly',
          action: 'upsert',
          text: '慢慢来，我在',
          kind: 'comfort_line',
          participantIds: ['char-a', 'user'],
          visibility: 'private',
          firstSaidBy: 'char-a',
          reason: '用户把这句话修正为私密安慰语。',
          evidence: 'manual_shared_phrase_edit_from_character_relationship_tab',
          emotionalWeight: 72,
          reuseCount: 1,
          confidence: 1,
          decisionSource: 'model',
        },
      }),
    ]);

    const phrases = buildSharedPhrases(character(), 1_300, directChat, []);
    const phrase = phrases.find((item) => item.id === 'phrase-slowly');

    expect(phrase).toMatchObject({
      text: '慢慢来，我在',
      kind: 'comfort_line',
      visibility: 'private',
    });
  });

  it('uses later shared phrase upserts to narrow mistaken third-party participants', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedPhraseEvent({
        id: 'evt-shared-phrase-group',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-secret-code',
          action: 'upsert',
          text: '月亮今天也站岗',
          kind: 'secret_code',
          participantIds: ['char-a', 'user', 'char-b'],
          visibility: 'private',
          firstSaidBy: 'user',
          reason: '旧事件误把第三个角色也放进了小暗号参与者。',
          evidence: '旧参与者证据',
          emotionalWeight: 86,
          reuseCount: 2,
          confidence: 0.86,
          decisionSource: 'model',
        },
      }),
      sharedPhraseEvent({
        id: 'evt-shared-phrase-pair-private',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-secret-code',
          action: 'upsert',
          text: '月亮今天也站岗',
          kind: 'secret_code',
          participantIds: ['char-a', 'user'],
          visibility: 'private',
          firstSaidBy: 'user',
          reason: '用户把共同话语参与者收窄为自己和苏苏。',
          evidence: 'manual_shared_phrase_participants_pair_private_from_character_relationship_tab',
          emotionalWeight: 86,
          reuseCount: 2,
          confidence: 1,
          decisionSource: 'model',
        },
      }),
    ]);

    const phrases = buildSharedPhrases(character(), 1_300, directChat, []);
    const phrase = phrases.find((item) => item.id === 'phrase-secret-code');

    expect(phrase).toMatchObject({
      text: '月亮今天也站岗',
      kind: 'secret_code',
      participantIds: ['char-a', 'user'],
      visibility: 'private',
    });
    expect(phrase?.participantIds).not.toContain('char-b');
  });

  it('automatically narrows user direct shared phrases that accidentally include third-party participants', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedPhraseEvent({
        id: 'evt-shared-phrase-auto-pair-private',
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-secret-code',
          action: 'upsert',
          text: '月亮今天也站岗',
          kind: 'secret_code',
          participantIds: ['char-a', 'user', 'char-b'],
          visibility: 'private',
          firstSaidBy: 'user',
          reason: '模型误把第三个角色也放进了小暗号参与者。',
          evidence: '这是只有我们知道的暗号。',
          emotionalWeight: 86,
          reuseCount: 2,
          confidence: 0.86,
          decisionSource: 'model',
        },
      }),
    ]);

    const phrases = buildSharedPhrases(character(), 1_300, directChat, []);
    const phrase = phrases.find((item) => item.id === 'phrase-secret-code');

    expect(phrase?.participantIds).toEqual(['char-a', 'user']);
  });

  it('narrows role-private shared phrases to a pair unless the text explicitly describes a group', () => {
    const groupChat = {
      ...chat('group', [], [
        sharedPhraseEvent({
          id: 'evt-role-phrase-ambiguous-group',
          actorIds: ['char-a', 'char-b', 'char-c'],
          targetIds: ['char-a', 'char-b', 'char-c'],
          visibility: 'role_private',
          payload: {
            eventType: 'companionship_shared_phrase',
            characterId: 'char-a',
            phraseId: 'phrase-rain-ticket',
            action: 'upsert',
            text: '雨天加班券',
            kind: 'inside_joke',
            participantIds: ['char-a', 'char-b', 'char-c'],
            visibility: 'public_hint',
            reason: '模型误把多人都放进了共同梗参与者。',
            evidence: '苏苏和小林又提到雨天加班券。',
            emotionalWeight: 70,
            reuseCount: 1,
            confidence: 0.86,
            decisionSource: 'model',
          },
        }),
        sharedPhraseEvent({
          id: 'evt-role-phrase-explicit-group',
          actorIds: ['char-a', 'char-b', 'char-c'],
          targetIds: ['char-a', 'char-b', 'char-c'],
          visibility: 'role_private',
          payload: {
            eventType: 'companionship_shared_phrase',
            characterId: 'char-a',
            phraseId: 'phrase-team-code',
            action: 'upsert',
            text: '大家都知道的小队暗号',
            kind: 'secret_code',
            participantIds: ['char-a', 'char-b', 'char-c'],
            visibility: 'private',
            reason: '这是小队共同参与的暗号。',
            evidence: '大家都说好用这个小队暗号。',
            emotionalWeight: 76,
            reuseCount: 1,
            confidence: 0.9,
            decisionSource: 'model',
          },
        }),
      ]),
      memberIds: ['char-a', 'char-b', 'char-c'],
      type: 'group' as const,
    };

    const phrases = buildSharedPhrases(character(), 1_300, groupChat, []);

    expect(phrases.find((item) => item.id === 'phrase-rain-ticket')?.participantIds).toEqual(['char-a', 'char-b']);
    expect(phrases.find((item) => item.id === 'phrase-team-code')?.participantIds).toEqual(['char-a', 'char-b', 'char-c']);
  });

  it('uses reused shared phrase events to strengthen reuse count without changing text', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedPhraseEvent({
        id: 'evt-shared-phrase-original',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-slowly',
          action: 'upsert',
          text: '慢慢来，我在',
          kind: 'comfort_line',
          participantIds: ['char-a', 'user'],
          visibility: 'private',
          firstSaidBy: 'char-a',
          reason: '第一次形成安慰话语。',
          evidence: '苏苏说慢慢来，我在。',
          emotionalWeight: 70,
          reuseCount: 1,
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
      sharedPhraseEvent({
        id: 'evt-shared-phrase-reused',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_shared_phrase',
          characterId: 'char-a',
          userId: 'user',
          phraseId: 'phrase-slowly',
          action: 'reused',
          text: '慢慢来，我在',
          kind: 'comfort_line',
          participantIds: ['char-a', 'user'],
          visibility: 'private',
          firstSaidBy: 'char-a',
          reason: '同一句话再次被长期记忆确认。',
          evidence: '记忆蒸馏再次沉淀这句安慰话。',
          emotionalWeight: 74,
          reuseCount: 2,
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);

    const phrase = buildSharedPhrases(character(), 1_300, directChat, []).find((item) => item.id === 'phrase-slowly');

    expect(phrase).toMatchObject({
      text: '慢慢来，我在',
      kind: 'comfort_line',
      visibility: 'private',
      reuseCount: 2,
      emotionalWeight: 74,
    });
  });

  it('uses revoked shared anchor runtime events to suppress matching fallback anchors', () => {
    const anchorCharacter = character({
      layeredMemories: [{
        id: 'anchor-user',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '第一次深夜聊天后，苏苏记住了用户没有离开。',
        evidenceText: '用户那晚陪苏苏聊到很晚。',
        salience: 0.9,
        confidence: 0.9,
        recency: 0.7,
        reinforcementCount: 2,
        sourceEventIds: ['evt-anchor'],
        origin: 'distilled',
        createdAt: 100,
        updatedAt: 200,
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedAnchorEvent({
        id: 'evt-shared-anchor-revoke',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_shared_anchor',
          characterId: 'char-a',
          userId: 'user',
          anchorId: 'memory-anchor-user',
          action: 'revoke',
          kind: 'first_time',
          participantIds: ['char-a', 'user'],
          text: '第一次深夜聊天后，苏苏记住了用户没有离开。',
          evidence: '用户撤回了这条共同记忆。',
          confidence: 0.94,
          decisionSource: 'model',
        },
      }),
    ]);
    const anchors = buildSharedMemoryAnchors(anchorCharacter, 1_300, directChat);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: anchorCharacter,
      messages: [message({ content: '今天有点累。', timestamp: 200 })],
      now: 1_300,
    });

    expect(anchors.some((anchor) => anchor.text.includes('第一次深夜聊天'))).toBe(false);
    expect(projection.promptLines.join('\n')).not.toContain('第一次深夜聊天');
  });

  it('uses archived shared anchor runtime events to suppress matching fallback anchors', () => {
    const anchorCharacter = character({
      layeredMemories: [{
        id: 'anchor-promise',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '说好周末一起看那部电影。',
        evidenceText: '用户和苏苏约好周末一起看电影。',
        salience: 0.82,
        confidence: 0.88,
        recency: 0.7,
        reinforcementCount: 2,
        sourceEventIds: ['evt-anchor-promise'],
        origin: 'distilled',
        createdAt: 100,
        updatedAt: 200,
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [
      sharedAnchorEvent({
        id: 'evt-shared-anchor-archive',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_shared_anchor',
          characterId: 'char-a',
          userId: 'user',
          anchorId: 'memory-anchor-promise',
          action: 'archive',
          kind: 'promise',
          participantIds: ['char-a', 'user'],
          text: '说好周末一起看那部电影。',
          evidence: '用户在关系页归档该共同锚点。',
          confidence: 1,
        },
      }),
    ]);

    const anchors = buildSharedMemoryAnchors(anchorCharacter, 1_300, directChat);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: anchorCharacter,
      messages: [message({ content: '今天有点累。', timestamp: 200 })],
      now: 1_300,
    });

    expect(anchors.some((anchor) => anchor.text.includes('周末一起看'))).toBe(false);
    expect(projection.promptLines.join('\n')).not.toContain('Shared memory anchors with the user');
  });

  it('allows companionship artifact seeds from runtime-event anchors even without existing character memories', () => {
    const directChat = chat('direct', [], [intimateConflictEvent({
      id: 'evt-runtime-seed-repair',
      createdAt: 1_200,
      summary: '用户和苏苏把一次误会说开。',
      payload: {
        eventType: 'companionship_intimate_conflict',
        characterId: 'char-a',
        userId: 'user',
        action: 'resolved',
        kind: 'reconciliation',
        severity: 14,
        repairReadiness: 82,
        summary: '误会说开后，两个人都记住了别用沉默互相试探。',
        evidence: ['用户说：以后不舒服就直接说。'],
        participantIds: ['char-a', 'user'],
        confidence: 0.88,
        decisionSource: 'model',
      },
    })]);
    const seeds = buildCompanionshipArtifactSeeds({
      character: character(),
      chat: directChat,
      messages: [],
      surface: 'private_diary',
      now: 1_300,
    });

    expect(seeds.join('\n')).toContain('误会说开');
    expect(seeds.join('\n')).toContain('日记');
  });

  it('exposes low-confidence or fallback intimate conflict events in companionship diagnostics', () => {
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 46, trust: 38, competence: 10, threat: 20 })], [
        intimateConflictEvent({
          id: 'evt-intimate-fallback',
          payload: {
            eventType: 'companionship_intimate_conflict',
            characterId: 'char-a',
            userId: 'user',
            action: 'opened',
            kind: 'cold_war',
            confidence: 0.52,
            decisionSource: 'local_fallback',
            evidence: ['先别聊了。'],
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '先别聊了。', timestamp: 900 })],
      now: 1_000,
    });

    expect(trace?.diagnostics).toEqual(expect.arrayContaining([
      'intimate_conflict: source=local_fallback confidence=52% event=evt-intimate-fallback',
    ]));
  });

  it('does not infer a conflict from leaked secret memory prose', () => {
    const secretCharacter = character({
      layeredMemories: [{
        id: 'secret-leaked',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '共同秘密是用户只把暗号告诉过苏苏，但后来已经公开说漏了。',
        evidenceText: '用户发现那个暗号传开了，觉得信任受损。',
        salience: 0.92,
        confidence: 0.91,
        recency: 0.8,
        reinforcementCount: 2,
        sourceEventIds: ['evt-secret-leaked'],
        origin: 'distilled',
        createdAt: 700,
        updatedAt: 900,
      }],
    });
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({
        warmth: 54,
        trust: 48,
        competence: 10,
        threat: 4,
      })]),
      character: secretCharacter,
      messages: [message({ content: '那个暗号怎么会被别人知道？', timestamp: 920 })],
      now: 1_000,
    });

    expect(projection.userBond?.intimateConflict).toBeUndefined();
    expect(projection.promptLines.join('\n')).not.toContain('Current intimate conflict/repair state');
  });

  it('does not infer a repair conflict from confessed secret memory prose', () => {
    const secretCharacter = character({
      layeredMemories: [{
        id: 'secret-confessed',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '共同秘密是苏苏后来主动坦白并承认了那个只有他们知道的暗号。',
        evidenceText: '苏苏说开了这件事，用户没有立刻原谅但愿意听。',
        salience: 0.86,
        confidence: 0.88,
        recency: 0.7,
        reinforcementCount: 1,
        sourceEventIds: ['evt-secret-confessed'],
        origin: 'distilled',
        createdAt: 700,
        updatedAt: 900,
      }],
    });
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({
        warmth: 58,
        trust: 46,
        competence: 10,
        threat: 8,
      })]),
      character: secretCharacter,
      messages: [message({ content: '你愿意说开就好，但我还需要一点时间。', timestamp: 920 })],
      now: 1_000,
    });

    expect(projection.userBond?.intimateConflict).toBeUndefined();
    expect(projection.promptLines.join('\n')).not.toContain('Current intimate conflict/repair state');
  });

  it('adapts care policy for anxious attachment cues without exposing labels in prompt', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({
        warmth: 62,
        trust: 58,
        competence: 10,
        threat: 4,
      })]),
      character: character(),
      messages: [
        message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 800 }),
        message({ content: '我只是想确认你还在。', timestamp: 900 }),
      ],
      now: 1_000,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({
        warmth: 62,
        trust: 58,
        competence: 10,
        threat: 4,
      })]),
      character: character(),
      messages: [
        message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 800 }),
        message({ content: '我只是想确认你还在。', timestamp: 900 }),
      ],
      now: 1_000,
    });

    expect(projection.userBond?.attachmentProfile.inferredStyle).toBe('anxious');
    expect(projection.userBond?.carePolicy.silenceAnxietyThresholdHours).toBeLessThan(48);
    expect(projection.promptLines.join('\n')).toContain('User attachment adaptation');
    expect(projection.promptLines.join('\n')).not.toContain('anxious');
    expect(trace?.attachmentProfile?.adaptations.join('\n')).toContain('reassurance');
  });

  it('prioritizes model-led attachment profile events over local attachment inference', () => {
    const directChat = chat('direct', [relationship({
      warmth: 62,
      trust: 58,
      competence: 10,
      threat: 4,
    })], [attachmentProfileEvent()]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [
        message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 800 }),
        message({ content: '我只是想确认你还在。', timestamp: 900 }),
      ],
      now: 1_100,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [
        message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 800 }),
        message({ content: '我只是想确认你还在。', timestamp: 900 }),
      ],
      now: 1_100,
    });

    expect(projection.userBond?.attachmentProfile).toMatchObject({
      inferredStyle: 'avoidant',
      confidence: 88,
      adaptations: ['respect explicit space requests', 'keep follow-up lightweight'],
    });
    expect(projection.userBond?.carePolicy.allowMissYou).toBe(false);
    expect(projection.promptLines.join('\n')).toContain('User attachment adaptation');
    expect(projection.promptLines.join('\n')).not.toContain('avoidant');
    expect(trace?.attachmentProfile?.evidence.join('\n')).toContain('需要空间');
    expect(trace?.attachmentHistory[0]).toMatchObject({
      id: 'evt-attachment-1',
      action: 'inferred',
      inferredStyle: 'avoidant',
      confidence: 88,
      decisionSource: 'model',
    });
    expect(trace?.attachmentHistory[0]?.adaptations).toEqual(expect.arrayContaining(['respect explicit space requests']));
  });

  it('uses corrected attachment profile events as explicit user/model correction', () => {
    const directChat = chat('direct', [relationship({
      warmth: 62,
      trust: 58,
      competence: 10,
      threat: 4,
    })], [attachmentProfileEvent({
      id: 'evt-attachment-corrected',
      payload: {
        eventType: 'companionship_attachment_profile',
        characterId: 'char-a',
        userId: 'user',
        action: 'corrected',
        inferredStyle: 'secure',
        confidence: 0.96,
        evidence: ['用户明确表示不要按焦虑或回避模式适配，正常相处就好。'],
        adaptations: ['keep a steady reciprocal pace'],
        decisionSource: 'model',
      },
    })]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [
        message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 800 }),
        message({ content: '我只是想确认你还在。', timestamp: 900 }),
      ],
      now: 1_100,
    });

    expect(projection.userBond?.attachmentProfile).toMatchObject({
      inferredStyle: 'secure',
      confidence: 96,
      adaptations: ['keep a steady reciprocal pace'],
    });
    expect(projection.userBond?.carePolicy.silenceAnxietyThresholdHours).toBe(48);
    expect(projection.promptLines.join('\n')).toContain('keep a steady reciprocal pace');
  });

  it('uses a later restored attachment history correction to override prior inferred style', () => {
    const directChat = chat('direct', [relationship({
      warmth: 62,
      trust: 58,
      competence: 10,
      threat: 4,
    })], [
      attachmentProfileEvent({
        id: 'evt-attachment-inferred',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'inferred',
          inferredStyle: 'avoidant',
          confidence: 0.82,
          reason: '模型认为用户需要更多空间。',
          evidence: ['用户说这几天先别追问。'],
          adaptations: ['respect explicit space requests'],
          decisionSource: 'model',
        },
      }),
      attachmentProfileEvent({
        id: 'evt-attachment-restored-from-history',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'corrected',
          inferredStyle: 'anxious',
          confidence: 1,
          reason: '用户在开发者诊断中从互动节奏历史 evt-old-anxious 恢复为多给确认。',
          evidence: ['manual_attachment_restore_from_history'],
          adaptations: ['offer reassurance explicitly'],
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [],
      now: 1_300,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [],
      now: 1_300,
    });

    expect(projection.userBond?.attachmentProfile).toMatchObject({
      inferredStyle: 'anxious',
      confidence: 100,
      adaptations: ['offer reassurance explicitly'],
    });
    expect(trace?.attachmentHistory[0]).toMatchObject({
      id: 'evt-attachment-restored-from-history',
      action: 'corrected',
      inferredStyle: 'anxious',
      reason: '用户在开发者诊断中从互动节奏历史 evt-old-anxious 恢复为多给确认。',
    });
  });

  it('aggregates inferred attachment profile events into a long-term trend', () => {
    const directChat = chat('direct', [relationship({
      warmth: 62,
      trust: 58,
      competence: 10,
      threat: 4,
    })], [
      attachmentProfileEvent({
        id: 'evt-attachment-avoidant-old',
        createdAt: 900,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'inferred',
          inferredStyle: 'avoidant',
          confidence: 0.74,
          evidence: ['用户明确说需要空间。'],
          adaptations: ['respect explicit space requests'],
          decisionSource: 'model',
        },
      }),
      attachmentProfileEvent({
        id: 'evt-attachment-avoidant-new',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'inferred',
          inferredStyle: 'avoidant',
          confidence: 0.82,
          evidence: ['用户再次要求低压相处。'],
          adaptations: ['keep follow-up lightweight'],
          decisionSource: 'model',
        },
      }),
      attachmentProfileEvent({
        id: 'evt-attachment-anxious-minor',
        createdAt: 980,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'inferred',
          inferredStyle: 'anxious',
          confidence: 0.62,
          evidence: ['用户偶尔确认对方还在。'],
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '普通聊天。', timestamp: 1_020 })],
      now: 1_100,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '普通聊天。', timestamp: 1_020 })],
      now: 1_100,
    });

    expect(projection.userBond?.attachmentProfile.inferredStyle).toBe('avoidant');
    expect(projection.userBond?.attachmentProfile.evidence.join('\n')).toContain('长期趋势');
    expect(projection.userBond?.attachmentProfile.confidence).toBeGreaterThan(70);
    expect(trace?.attachmentProfile?.evidence.join('\n')).toContain('用户再次要求低压相处');
  });

  it('uses disabled attachment profile events to stop attachment adaptations', () => {
    const directChat = chat('direct', [relationship({
      warmth: 62,
      trust: 58,
      competence: 10,
      threat: 4,
    })], [attachmentProfileEvent({
      id: 'evt-attachment-disabled',
      payload: {
        eventType: 'companionship_attachment_profile',
        characterId: 'char-a',
        userId: 'user',
        action: 'disabled',
        confidence: 1,
        reason: '用户关闭依恋适配。',
        evidence: ['不要分析我的依恋类型。'],
        decisionSource: 'model',
      },
    })]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [
        message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 800 }),
        message({ content: '我只是想确认你还在。', timestamp: 900 }),
      ],
      now: 1_100,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [
        message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 800 }),
        message({ content: '我只是想确认你还在。', timestamp: 900 }),
      ],
      now: 1_100,
    });

    expect(projection.userBond?.attachmentProfile).toMatchObject({
      inferredStyle: 'secure',
      confidence: 0,
      adaptations: [],
    });
    expect(projection.userBond?.carePolicy.silenceAnxietyThresholdHours).toBe(48);
    expect(projection.promptLines.join('\n')).not.toContain('User attachment adaptation');
    expect(trace?.attachmentProfile?.evidence.join('\n')).toContain('用户关闭依恋适配');
  });

  it('uses enabled attachment profile events to resume attachment adaptations after disable', () => {
    const messages = [
      message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 800 }),
      message({ content: '我只是想确认你还在。', timestamp: 900 }),
    ];
    const directChat = chat('direct', [relationship({
      warmth: 62,
      trust: 58,
      competence: 10,
      threat: 4,
    })], [
      attachmentProfileEvent({
        id: 'evt-attachment-disabled',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'disabled',
          confidence: 1,
          reason: '用户关闭依恋适配。',
          evidence: ['不要分析我的依恋类型。'],
          decisionSource: 'model',
        },
      }),
      attachmentProfileEvent({
        id: 'evt-attachment-enabled',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'enabled',
          confidence: 1,
          reason: '用户恢复依恋适配。',
          evidence: ['可以继续做适配。'],
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages,
      now: 1_200,
    });

    expect(projection.userBond?.attachmentProfile.inferredStyle).toBe('anxious');
    expect(projection.userBond?.attachmentProfile.confidence).toBeGreaterThan(0);
    expect(projection.promptLines.join('\n')).toContain('User attachment adaptation');
  });

  it('does not reuse attachment profile events that happened before a later enable event', () => {
    const directChat = chat('direct', [relationship({
      warmth: 62,
      trust: 58,
      competence: 10,
      threat: 4,
    })], [
      attachmentProfileEvent({
        id: 'evt-attachment-avoidant-before-enable',
        createdAt: 900,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'inferred',
          inferredStyle: 'avoidant',
          confidence: 0.92,
          evidence: ['用户之前说需要空间。'],
          adaptations: ['respect explicit space requests'],
          decisionSource: 'model',
        },
      }),
      attachmentProfileEvent({
        id: 'evt-attachment-enabled-later',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'enabled',
          confidence: 1,
          reason: '用户恢复依恋适配。',
          evidence: ['重新按当前对话适配。'],
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [
        message({ content: '你怎么不回我，是不是不想理我了？', timestamp: 1_050 }),
        message({ content: '我只是想确认你还在。', timestamp: 1_060 }),
      ],
      now: 1_100,
    });

    expect(projection.userBond?.attachmentProfile.inferredStyle).toBe('anxious');
    expect(projection.userBond?.attachmentProfile.evidence.join('\n')).not.toContain('之前说需要空间');
  });

  it('exposes fallback attachment profile events in companionship diagnostics', () => {
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 46, trust: 38, competence: 10, threat: 20 })], [
        attachmentProfileEvent({
          id: 'evt-attachment-fallback',
          payload: {
            eventType: 'companionship_attachment_profile',
            characterId: 'char-a',
            userId: 'user',
            inferredStyle: 'anxious',
            confidence: 0.54,
            evidence: ['本地兜底检测到用户反复确认对方是否还在。'],
            adaptations: ['give concise reassurance'],
            decisionSource: 'local_fallback',
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '你是不是不想理我了？', timestamp: 900 })],
      now: 1_000,
    });

    expect(trace?.diagnostics).toEqual(expect.arrayContaining([
      'attachment_profile: source=local_fallback confidence=54% event=evt-attachment-fallback',
    ]));
  });

  it('adapts proactive care policy for avoidant attachment and user space cues', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({
        warmth: 58,
        trust: 52,
        competence: 10,
        threat: 4,
      })]),
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说不想主动打扰，也不要追问。'],
        },
      }),
      messages: [message({ content: '我需要一点空间，先别问了。', timestamp: 900 })],
      now: 1_000,
    });
    const policy = buildCompanionshipCarePolicyForCharacter({
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说不想主动打扰，也不要追问。'],
        },
      }),
      chat: chat('direct', [relationship({
        warmth: 58,
        trust: 52,
        competence: 10,
        threat: 4,
      })]),
      messages: [message({ content: '我需要一点空间，先别问了。', timestamp: 900 })],
      now: 1_000,
    });

    expect(projection.userBond?.attachmentProfile.inferredStyle).toBe('avoidant');
    expect(projection.userBond?.carePolicy.allowMissYou).toBe(false);
    expect(policy.dailyInitiationBudget).toBe(0);
    expect(policy.expressionIntensity).toBeLessThanOrEqual(28);
  });

  it('allows users to disable attachment adaptation globally', () => {
    const directChat = chat('direct', [relationship({
      warmth: 72,
      trust: 68,
      competence: 10,
      threat: 4,
    })]);
    const actor = character();
    const userMessages = [
      message({ content: '你怎么不回我，别不理我。', timestamp: 800 }),
      message({ content: '我就是需要一点安全感，想确认你还在。', timestamp: 900 }),
    ];
    const enabled = buildUserCompanionshipProjection({
      chat: directChat,
      character: actor,
      messages: userMessages,
      now: 1_000,
    });

    setCompanionshipRuntimeConfig({ enableAttachmentAdaptation: false });
    const disabled = buildUserCompanionshipProjection({
      chat: directChat,
      character: actor,
      messages: userMessages,
      now: 1_000,
    });

    expect(enabled.userBond?.attachmentProfile.inferredStyle).toBe('anxious');
    expect(enabled.userBond?.attachmentProfile.confidence).toBeGreaterThanOrEqual(58);
    expect(disabled.userBond?.attachmentProfile).toMatchObject({
      inferredStyle: 'secure',
      confidence: 0,
      adaptations: [],
    });
    expect(disabled.userBond?.attachmentProfile.evidence).toContain('global setting disables attachment adaptation');
    expect(disabled.userBond?.carePolicy.triggerSensitivity).toBeLessThan(enabled.userBond?.carePolicy.triggerSensitivity || 0);
    expect(disabled.userBond?.carePolicy.silenceAnxietyThresholdHours).toBeGreaterThan(enabled.userBond?.carePolicy.silenceAnxietyThresholdHours || 0);
    expect(disabled.promptLines.join('\n')).not.toContain('User attachment adaptation');
  });

  it('keeps mixed closeness and distance cues steady as disorganized attachment adaptation', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({
        warmth: 62,
        trust: 52,
        competence: 10,
        threat: 8,
      })]),
      character: character(),
      messages: [
        message({ content: '你怎么不回我，别不理我。', timestamp: 800 }),
        message({ content: '算了，我又想要一点空间，先别追问。', timestamp: 900 }),
      ],
      now: 1_000,
    });

    expect(projection.userBond?.attachmentProfile.inferredStyle).toBe('disorganized');
    expect(projection.userBond?.carePolicy.allowMissYou).toBe(false);
    expect(projection.userBond?.attachmentProfile.adaptations.join('\n')).toContain('alternates closeness and distance');
  });

  it('does not project intimate conflict state for ordinary warm direct chats', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('direct', [relationship({
        warmth: 66,
        trust: 60,
        competence: 10,
        threat: 4,
      })]),
      character: character(),
      messages: [message({ content: '今天看到一家店，感觉你会喜欢。', timestamp: 900 })],
      now: 1_000,
    });

    expect(projection.userBond?.intimateConflict).toBeUndefined();
    expect(projection.promptLines.join('\n')).not.toContain('Current intimate conflict/repair state');
  });

  it('uses phase-sensitive proactive budget without blocking immediate user-prompted follow-up', () => {
    const crisisChat = chat('group', [relationship({ warmth: 20, trust: 12, competence: 10, threat: 50 })], [
      phaseEvent({
        payload: {
          eventType: 'companionship_phase_event',
          characterId: 'char-a',
          userId: 'user',
          phase: 'crisis',
          style: 'friend',
          reason: '用户表达受伤，需要暂停主动靠近。',
        },
      }),
    ]);
    const carePolicy = buildCompanionshipCarePolicyForCharacter({
      character: character(),
      chat: crisisChat,
      now: new Date('2026-06-01T14:00:00+08:00').getTime(),
    });

    expect(carePolicy.dailyInitiationBudget).toBe(0);
    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: character(),
      chat: crisisChat,
      eventKind: 'status_update',
      reasonType: 'world_attention_status_idle',
      attentionScore: 0.9,
      now: new Date('2026-06-01T14:00:00+08:00').getTime(),
    }).blocked).toBe(true);
    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: character(),
      chat: crisisChat,
      eventKind: 'check_in',
      reasonType: 'world_attention_private_message',
      attentionScore: 0.9,
      now: new Date('2026-06-01T14:00:00+08:00').getTime(),
    }).blocked).toBe(false);
  });

  it('applies global companionship settings to proactive care policy and traces', () => {
    setCompanionshipRuntimeConfig({
      enableProactiveCare: false,
      allowGoodMorning: false,
      allowGoodNight: false,
      allowMissYou: false,
      careIntensity: 'restrained',
    });
    const directChat = chat('direct', [relationship({ warmth: 78, trust: 72, competence: 10, threat: 2 })]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 900 })],
      now: 1_000,
    });
    const decision = shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: character(),
      chat: directChat,
      eventKind: 'status_update',
      reasonType: 'world_attention_status_idle',
      attentionScore: 1,
      now: new Date('2026-06-01T14:00:00+08:00').getTime(),
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 900 })],
      now: 1_000,
    });

    expect(projection.userBond?.carePolicy.dailyInitiationBudget).toBe(0);
    expect(projection.userBond?.carePolicy.allowGoodMorning).toBe(false);
    expect(projection.userBond?.carePolicy.allowGoodNight).toBe(false);
    expect(projection.userBond?.carePolicy.allowMissYou).toBe(false);
    expect(projection.promptLines.join('\n')).toContain('global setting disables proactive companionship');
    expect(decision).toMatchObject({
      blocked: true,
      reason: 'global setting disables proactive companionship',
    });
    expect(trace?.boundaryReasons).toEqual(expect.arrayContaining(['global setting disables proactive companionship']));
  });

  it('uses character companionship override to disable proactive care for one character', () => {
    setCompanionshipRuntimeConfig({
      enableProactiveCare: true,
      careIntensity: 'expressive',
    });
    const directChat = chat('direct', [relationship({ warmth: 78, trust: 72, competence: 10, threat: 2 })]);
    const actor = character({ generationPreferences: { moments: 'follow_global', diaries: 'follow_global', companionship: 'off' } });
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: actor,
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 900 })],
      now: 1_000,
    });
    const decision = shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: actor,
      chat: directChat,
      eventKind: 'status_update',
      reasonType: 'world_attention_status_idle',
      attentionScore: 1,
      now: new Date('2026-06-01T14:00:00+08:00').getTime(),
    });

    expect(projection.userBond?.carePolicy.dailyInitiationBudget).toBe(0);
    expect(projection.userBond?.carePolicy.boundaryReasons).toContain('character setting disables proactive companionship');
    expect(decision).toMatchObject({
      blocked: true,
      reason: 'character setting disables proactive companionship',
    });
  });

  it('uses character companionship override to allow proactive care when global proactive care is off', () => {
    setCompanionshipRuntimeConfig({
      enableProactiveCare: false,
      careIntensity: 'balanced',
      quietHours: { enabled: false, start: '23:30', end: '08:00', suppressStatusHints: true, suppressProactiveCare: true },
    });
    const directChat = chat('direct', [relationship({ warmth: 78, trust: 72, competence: 10, threat: 2 })]);
    const actor = character({ generationPreferences: { moments: 'follow_global', diaries: 'follow_global', companionship: 'on' } });
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: actor,
      messages: [message({ content: '今天也想和你聊一会。', timestamp: 900 })],
      now: 1_000,
    });
    const decision = shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: actor,
      chat: directChat,
      eventKind: 'status_update',
      reasonType: 'world_attention_status_idle',
      attentionScore: 1,
      now: new Date('2026-06-01T14:00:00+08:00').getTime(),
    });

    expect(projection.userBond?.carePolicy.dailyInitiationBudget).toBeGreaterThan(0);
    expect(projection.userBond?.carePolicy.boundaryReasons).toContain('character setting enables proactive companionship');
    expect(projection.userBond?.carePolicy.boundaryReasons).not.toContain('global setting disables proactive companionship');
    expect(decision.blocked).toBe(false);
  });

  it('respects global quiet-hour overrides for companionship proactive gating', () => {
    const night = new Date('2026-06-01T01:00:00+08:00').getTime();
    const baseCharacter = character();
    const directChat = chat('direct', [relationship({ warmth: 78, trust: 72, competence: 10, threat: 2 })]);

    setCompanionshipRuntimeConfig({
      quietHours: { enabled: true, start: '23:30', end: '08:00', suppressStatusHints: true, suppressProactiveCare: true },
    });
    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: baseCharacter,
      chat: directChat,
      eventKind: 'status_update',
      reasonType: 'world_attention_status_idle',
      attentionScore: 1,
      now: night,
    })).toMatchObject({
      blocked: true,
      reason: 'companionship quiet hours',
    });

    setCompanionshipRuntimeConfig({
      quietHours: { enabled: false, start: '23:30', end: '08:00', suppressStatusHints: true, suppressProactiveCare: true },
    });
    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: baseCharacter,
      chat: directChat,
      eventKind: 'status_update',
      reasonType: 'world_attention_status_idle',
      attentionScore: 1,
      now: night,
    }).blocked).toBe(false);

    setCompanionshipRuntimeConfig({
      quietHours: { enabled: true, start: '23:30', end: '08:00', suppressStatusHints: true, suppressProactiveCare: false },
    });
    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: baseCharacter,
      chat: directChat,
      eventKind: 'status_update',
      reasonType: 'world_attention_status_idle',
      attentionScore: 1,
      now: night,
    }).blocked).toBe(false);
  });

  it('applies configurable proactive cooldowns without blocking immediate user-prompted follow-up', () => {
    const now = new Date('2026-06-01T14:00:00+08:00').getTime();
    setCompanionshipRuntimeConfig({
      proactiveCooldownMinutes: {
        checkIn: 180,
        reactToMoment: 120,
        socialOuting: 360,
        statusUpdate: 90,
      },
      quietHours: { enabled: false, start: '23:30', end: '08:00', suppressStatusHints: true, suppressProactiveCare: true },
    });
    const directChat = chat('direct', [relationship({ warmth: 78, trust: 72, competence: 10, threat: 2 })], [{
      id: 'evt-recent-check-in-artifact',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: now - 30 * 60_000,
      actorIds: ['char-a'],
      targetIds: ['user'],
      summary: '苏苏刚刚发过一次主动关心。',
      visibility: 'pair_private',
      eventClass: 'artifact',
      payload: {
        artifactType: 'check_in_note',
        eventKind: 'check_in',
      },
    }]);

    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: character(),
      chat: directChat,
      eventKind: 'check_in',
      reasonType: 'world_attention_status_idle',
      attentionScore: 1,
      now,
    })).toMatchObject({
      blocked: true,
      reason: 'companionship check_in cooldown',
    });
    expect(shouldBlockUserProactiveContactByCompanionshipPolicy({
      character: character(),
      chat: directChat,
      eventKind: 'check_in',
      reasonType: 'world_attention_private_message',
      attentionScore: 1,
      now,
    }).blocked).toBe(false);
  });

  it('restrains proactive care from sensitive user profile cues by configurable boundary mode', () => {
    const directChat = chat('direct', [relationship({ warmth: 78, trust: 72, competence: 10, threat: 2 })], [{
      id: 'evt-sensitive-profile',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 1_000,
      actorIds: ['user', 'char-a'],
      targetIds: ['char-a', 'user'],
      summary: '模型记录了用户的敏感压力线索。',
      visibility: 'pair_private',
      eventClass: 'artifact',
      payload: {
        eventType: 'companionship_user_profile_memory',
        characterId: 'char-a',
        userId: 'user',
        action: 'upsert',
        items: [{
          kind: 'pressure_source',
          text: '用户最近因为复诊有压力',
          evidence: '下周复诊有点紧张。',
          sensitive: true,
          confidence: 0.92,
        }],
        decisionSource: 'model',
      },
    }]);

    setCompanionshipRuntimeConfig({ sensitiveBoundaryMode: 'restrained' });
    const restrained = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '下周复诊有点紧张。', timestamp: 900 })],
      now: 1_200,
    });
    setCompanionshipRuntimeConfig({ sensitiveBoundaryMode: 'off' });
    const blocked = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '下周复诊有点紧张。', timestamp: 900 })],
      now: 1_200,
    });
    setCompanionshipRuntimeConfig({ sensitiveBoundaryMode: 'normal' });
    const normal = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '下周复诊有点紧张。', timestamp: 900 })],
      now: 1_200,
    });

    expect(restrained.userBond?.carePolicy.boundaryReasons).toContain('sensitive companionship boundary mode is restrained');
    expect(restrained.userBond?.carePolicy.allowMissYou).toBe(false);
    expect(blocked.userBond?.carePolicy.dailyInitiationBudget).toBe(0);
    expect(blocked.userBond?.carePolicy.boundaryReasons).toContain('sensitive companionship boundary mode is off');
    expect(normal.userBond?.carePolicy.boundaryReasons).not.toContain('sensitive companionship boundary mode is restrained');
  });

  it('builds a low-noise companionship status signature for direct side panels', () => {
    const signature = buildCompanionshipStatusSignature({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })]),
      character: character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。', '用户说明天面试会紧张。'] } }),
      messages: [message({ content: '明天面试有点紧张。', timestamp: 200 })],
      now: 300,
    });

    expect(signature?.text).toContain('小夏');
    expect(signature?.text).toContain('面试');
    expect(signature?.chips).toEqual(expect.arrayContaining(['关系升温', '有关心事项']));
    expect(signature?.debugLines.join('\n')).toContain('phase=fond');
    expect(signature?.debugLines.join('\n')).toContain('intimacy attraction=');
    expect(signature?.addressing?.currentAddress).toBe('小夏');
  });

  it('injects user shared anchors into projection evidence, status debug, and runtime trace', () => {
    const anchorCharacter = character({
      layeredMemories: [{
        id: 'anchor-user',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '第一次深夜聊天后，苏苏记住了用户没有离开。',
        evidenceText: '用户那晚陪苏苏聊到很晚。',
        salience: 0.9,
        confidence: 0.9,
        recency: 0.7,
        reinforcementCount: 2,
        sourceEventIds: ['evt-anchor'],
        origin: 'distilled',
        createdAt: 100,
        updatedAt: 200,
      }],
      relationships: [{
        characterId: 'char-b',
        warmth: 90,
        competence: 10,
        trust: 90,
        threat: 0,
        note: '共同秘密是只有他们知道的暗号。',
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })]);
    const messages = [message({ content: '今天有点累。', timestamp: 200 })];
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: anchorCharacter,
      messages,
      now: 300,
    });
    const status = buildCompanionshipStatusSignature({
      chat: directChat,
      character: anchorCharacter,
      messages,
      now: 300,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: anchorCharacter,
      messages,
      now: 300,
    });

    expect(projection.evidence.join('\n')).toContain('第一次深夜聊天');
    expect(projection.promptLines.join('\n')).toContain('Shared memory anchors with the user');
    expect(projection.promptLines.join('\n')).not.toContain('只有他们知道的暗号');
    expect(status?.debugLines.join('\n')).toContain('sharedAnchors=');
    expect(trace?.sharedAnchors.join('\n')).toContain('第一次深夜聊天');
  });

  it('projects offline traces and unsent drafts after the user has been silent', () => {
    const latestUserAt = 200;
    const signature = buildCompanionshipStatusSignature({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })]),
      character: character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。', '用户说明天面试会紧张。'] } }),
      messages: [message({ content: '明天面试有点紧张。', timestamp: latestUserAt })],
      now: latestUserAt + 13 * 60 * 60 * 1000,
    });

    expect(signature?.offlineTrace).toContain('离线这段时间还惦记着');
    expect(signature?.unsentDraft).toContain('本来想问问小夏');
    expect(signature?.debugLines.join('\n')).toContain('offlineTrace=');
    expect(signature?.debugLines.join('\n')).toContain('unsentDraft=');
  });

  it('normalizes legacy diary writing seeds before displaying companionship status', () => {
    const latestUserAt = 900;
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [diaryReflectionEvent({
      payload: {
        eventType: 'companionship_diary_reflection',
        characterId: 'char-a',
        userId: 'user',
        reflectionId: 'legacy-care',
        diaryEntryId: 'legacy-diary',
        reflectionType: 'care',
        participantIds: ['char-a', 'user'],
        text: '未完成关心事项可以在日记里回流成“想问但没有急着问出口”的私下牵挂：用户明天面试。',
        confidence: 0.66,
        decisionSource: 'local_fallback',
      },
    })]);
    const params = {
      chat: directChat,
      character: character(),
      messages: [message({ content: '先聊到这里。', timestamp: latestUserAt })],
      now: latestUserAt + 13 * 60 * 60 * 1000,
    };
    const status = buildCompanionshipStatusSignature(params);
    const snapshot = buildHomeCompanionshipSnapshot({
      chats: [directChat], characters: [params.character], messages: params.messages, now: params.now,
    });

    expect(status?.text).toContain('用户明天面试');
    expect(status?.offlineTrace).toContain('用户明天面试');
    expect(snapshot?.text).toContain('用户明天面试');
    expect([status?.text, status?.offlineTrace, status?.unsentDraft, snapshot?.text].join('\n')).not.toMatch(/日记|回流|私下牵挂/);
  });

  it('does not treat diary care for another character as pending user care', () => {
    const directChat = chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })], [diaryReflectionEvent({
      payload: {
        eventType: 'companionship_diary_reflection',
        characterId: 'char-a',
        reflectionId: 'third-party-care',
        diaryEntryId: 'third-party-diary',
        reflectionType: 'care',
        participantIds: ['char-a', 'char-b'],
        text: '对刘备的关系纹理可以私下写成余波，不要写成系统记录：放心不下：以追问、试探或关心回应。',
        confidence: 0.66,
        decisionSource: 'local_fallback',
      },
    })]);
    const params = {
      chat: directChat,
      character: character(),
      messages: [message({ content: '先聊到这里。', timestamp: 900 })],
      now: 900 + 7 * 60 * 60 * 1000,
    };

    expect(buildUserCompanionshipProjection(params).userBond?.pendingCareTopics).toEqual([]);
    expect(buildCompanionshipStatusSignature(params)?.offlineTrace).not.toMatch(/刘备|追问|提示|纹理|系统记录/);
    expect(buildHomeCompanionshipSnapshot({
      chats: [directChat], characters: [params.character], messages: params.messages, now: params.now,
    })?.text).not.toMatch(/刘备|追问|纹理|系统记录/);
  });

  it('does not create unsent drafts when the user prefers no proactive contact', () => {
    const latestUserAt = 200;
    const signature = buildCompanionshipStatusSignature({
      chat: chat('direct', [relationship({ warmth: 68, trust: 64, competence: 10, threat: 4 })]),
      character: character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。', '用户不想主动打扰，也不要主动私聊。'] } }),
      messages: [message({ content: '明天面试有点紧张。', timestamp: latestUserAt })],
      now: latestUserAt + 13 * 60 * 60 * 1000,
    });

    expect(signature?.offlineTrace).toContain('保持安静');
    expect(signature?.unsentDraft).toBeUndefined();
  });

  it('prioritizes unsent draft runtime events over local status projection', () => {
    const latestUserAt = 200;
    const directChat = chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })], [unsentDraftEvent()]);
    const signature = buildCompanionshipStatusSignature({
      chat: directChat,
      character: character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。'] } }),
      messages: [message({ content: '明天面试有点紧张。', timestamp: latestUserAt })],
      now: latestUserAt + 13 * 60 * 60 * 1000,
    });

    expect(signature?.unsentDraft).toBe('写到一半又删掉了：小夏，面试前别硬撑，我在这儿。');
    expect(signature?.debugLines.join('\n')).toContain('unsentDraft=写到一半又删掉了');
    expect(signature?.debugLines.join('\n')).toContain('source=evt-unsent-draft-1');
  });

  it('uses suppressed unsent draft events to block local unsent draft fallback', () => {
    const latestUserAt = 200;
    const directChat = chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })], [
      unsentDraftEvent({
        id: 'evt-unsent-draft-suppressed',
        payload: {
          eventType: 'companionship_unsent_draft',
          characterId: 'char-a',
          userId: 'user',
          action: 'suppressed',
          reason: '用户关闭了未发送草稿提示。',
          confidence: 0.92,
          decisionSource: 'model',
        },
      }),
    ]);
    const signature = buildCompanionshipStatusSignature({
      chat: directChat,
      character: character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。'] } }),
      messages: [message({ content: '明天面试有点紧张。', timestamp: latestUserAt })],
      now: latestUserAt + 13 * 60 * 60 * 1000,
    });

    expect(signature?.unsentDraft).toBeUndefined();
    expect(signature?.debugLines.join('\n')).toContain('unsentDraft=suppressed source=evt-unsent-draft-suppressed');
  });

  it('exposes local unsent draft events in companionship diagnostics', () => {
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })], [
        unsentDraftEvent({
          id: 'evt-unsent-draft-local',
          payload: {
            eventType: 'companionship_unsent_draft',
            characterId: 'char-a',
            userId: 'user',
            action: 'drafted',
            text: '想问你后来怎么样了。',
            confidence: 0.64,
            decisionSource: 'local_fallback',
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '明天面试有点紧张。', timestamp: 200 })],
      now: 200 + 13 * 60 * 60 * 1000,
    });

    expect(trace?.diagnostics.join('\n')).toContain('unsent_draft: source=local_fallback confidence=64% event=evt-unsent-draft-local');
  });

  it('projects online return text for home-level companionship status', () => {
    const latestUserAt = 200;
    const directChat = chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })]);
    const companion = character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。'] } });
    const signature = buildCompanionshipStatusSignature({
      chat: directChat,
      character: companion,
      messages: [message({ content: '我先去忙了，晚点回来。', timestamp: latestUserAt })],
      now: latestUserAt + 30 * 60 * 60 * 1000,
    });
    const snapshot = buildHomeCompanionshipSnapshot({
      chats: [directChat],
      characters: [companion],
      messages: [message({ chatId: directChat.id, content: '我先去忙了，晚点回来。', timestamp: latestUserAt })],
      now: latestUserAt + 30 * 60 * 60 * 1000,
    });

    expect(signature?.onlineReturn).toContain('小夏');
    expect(signature?.onlineReturn).not.toContain('它像是');
    expect(signature?.onlineReturn).not.toContain('自然开口');
    expect(signature?.onlineReturnIntent).toContain('用户长时间离开后回到会话');
    expect(signature?.onlineReturnIntent).not.toBe(signature?.onlineReturn);
    expect(signature?.debugLines.join('\n')).toContain('onlineReturn=');
    expect(snapshot?.text).toBe(signature?.onlineReturn);
    expect(snapshot?.characterName).toBe('苏苏');
  });

  it('aggregates home companionship status across direct chats for the same character', () => {
    const latestUserAt = 200;
    const olderChat = {
      ...chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })]),
      id: 'chat-old',
      lastMessageAt: 1_000,
    };
    const newerChat = {
      ...chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })], [onlineReturnEvent({
        id: 'evt-online-return-new',
        conversationId: 'chat-new',
        payload: {
          eventType: 'companionship_online_return',
          characterId: 'char-a',
          userId: 'user',
          action: 'projected',
          text: '小夏回来了。苏苏把新开的那间房也留着一盏灯。',
          confidence: 0.9,
          decisionSource: 'model',
        },
      })]),
      id: 'chat-new',
      lastMessageAt: 2_000,
    };
    const companion = character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。'] } });
    const snapshot = buildHomeCompanionshipSnapshot({
      chats: [olderChat, newerChat],
      characters: [companion],
      messages: [
        message({ id: 'msg-old', chatId: olderChat.id, content: '我先去忙了，晚点回来。', timestamp: latestUserAt }),
        message({ id: 'msg-new', chatId: newerChat.id, content: '我换个房间继续聊。', timestamp: latestUserAt + 10 }),
      ],
      now: latestUserAt + 30 * 60 * 60 * 1000,
    });

    expect(snapshot?.chatId).toBe('chat-new');
    expect(snapshot?.text).toContain('新开的那间房');
    expect(snapshot?.debugLines.join('\n')).toContain('homeAggregation=character:char-a candidates=2');
  });

  it('prioritizes online return runtime events over local status projection', () => {
    const latestUserAt = 200;
    const directChat = chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })], [onlineReturnEvent()]);
    const companion = character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。'] } });
    const signature = buildCompanionshipStatusSignature({
      chat: directChat,
      character: companion,
      messages: [message({ content: '我先去忙了，晚点回来。', timestamp: latestUserAt })],
      now: latestUserAt + 30 * 60 * 60 * 1000,
    });

    expect(signature?.onlineReturn).toBe('小夏回来了。苏苏把刚才想问的话先放轻一点，只留一句欢迎回来。');
    expect(signature?.debugLines.join('\n')).toContain('onlineReturn=小夏回来了');
    expect(signature?.debugLines.join('\n')).toContain('source=evt-online-return-1');
  });

  it('uses suppressed online return events to block local online return fallback', () => {
    const latestUserAt = 200;
    const directChat = chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })], [
      onlineReturnEvent({
        id: 'evt-online-return-suppressed',
        payload: {
          eventType: 'companionship_online_return',
          characterId: 'char-a',
          userId: 'user',
          action: 'suppressed',
          reason: '用户已经关闭首页回归提示。',
          confidence: 0.92,
          decisionSource: 'model',
        },
      }),
    ]);
    const signature = buildCompanionshipStatusSignature({
      chat: directChat,
      character: character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户说：叫我小夏。'] } }),
      messages: [message({ content: '我先去忙了，晚点回来。', timestamp: latestUserAt })],
      now: latestUserAt + 30 * 60 * 60 * 1000,
    });

    expect(signature?.onlineReturn).toBeUndefined();
    expect(signature?.debugLines.join('\n')).toContain('onlineReturn=suppressed source=evt-online-return-suppressed');
  });

  it('exposes local online return events in companionship diagnostics', () => {
    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })], [
        onlineReturnEvent({
          id: 'evt-online-return-local',
          payload: {
            eventType: 'companionship_online_return',
            characterId: 'char-a',
            userId: 'user',
            action: 'projected',
            text: '小夏回来了。',
            confidence: 0.64,
            decisionSource: 'local_fallback',
          },
        }),
      ]),
      character: character(),
      messages: [message({ content: '我先去忙了。', timestamp: 200 })],
      now: 200 + 30 * 60 * 60 * 1000,
    });

    expect(trace?.diagnostics.join('\n')).toContain('online_return: source=local_fallback confidence=64% event=evt-online-return-local');
  });

  it('does not project online return when user boundary blocks proactive contact', () => {
    const latestUserAt = 200;
    const signature = buildCompanionshipStatusSignature({
      chat: chat('direct', [relationship({ warmth: 72, trust: 70, competence: 10, threat: 2 })]),
      character: character({ memory: { shortTermSummary: '', longTerm: [], secrets: [], obsessions: [], tabooTopics: [], userMemories: ['用户不想主动打扰，也不要主动私聊。'] } }),
      messages: [message({ content: '我先去忙了。', timestamp: latestUserAt })],
      now: latestUserAt + 30 * 60 * 60 * 1000,
    });

    expect(signature?.onlineReturn).toBeUndefined();
    expect(signature?.unsentDraft).toBeUndefined();
  });

  it('does not project user companionship for group chats', () => {
    const projection = buildUserCompanionshipProjection({
      chat: chat('group', [relationship({ warmth: 48, trust: 44, competence: 10, threat: 4 })]),
      character: character(),
      messages: [message({})],
      now: 300,
    });

    expect(projection.userBond).toBeNull();
    expect(projection.promptLines).toEqual([]);
  });

  it('projects lightweight character companionship from relationship presets', () => {
    const states = buildCharacterCompanionshipStates(
      character({
        relationships: [
          {
            characterId: 'char-b',
            warmth: 72,
            trust: 68,
            competence: 42,
            threat: 2,
            note: '共同秘密是只有他们知道的暗号；约定每次争执后先递台阶；担心对方最近太累。',
            updatedAt: 900,
          },
          {
            characterId: 'char-c',
            warmth: 40,
            trust: 20,
            competence: 22,
            threat: 60,
            note: '嘴上互怼但护着对方。',
          },
          {
            characterId: 'user',
            warmth: 99,
            trust: 99,
            competence: 99,
            threat: 0,
          },
          {
            characterId: 'draft-new',
            warmth: 99,
            trust: 99,
            competence: 99,
            threat: 0,
          },
        ],
      }),
      1000,
    );

    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({
      targetId: 'char-b',
      style: 'partner',
      lastCareAt: 900,
    });
    expect(states[0].sharedSecrets.join('\n')).toContain('共同秘密');
    expect(states[0].sharedRituals.join('\n')).toContain('暗号');
    expect(states[0].sharedPromises.join('\n')).toContain('约定');
    expect(states[0].unresolvedCareTopics.join('\n')).toContain('担心');
    expect(states[1]).toMatchObject({
      targetId: 'char-c',
      style: 'rival_with_care',
      lastCareAt: 1000,
    });
    expect(states.map((item) => item.targetId)).not.toContain('user');
    expect(states.map((item) => item.targetId)).not.toContain('draft-new');
  });

  it('projects character companionship from relationship ledger and runtime shared anchors', () => {
    const runtimeChat = chat('group', [{
      pairKey: 'char-a->char-b',
      actorId: 'char-a',
      targetId: 'char-b',
      current: { warmth: 62, trust: 58, competence: 44, threat: 8 },
      derived: {
        semantic: {
          stage: '搭档',
          labels: ['互相照应'],
          summary: '说好下次行动时互相兜底，也担心对方最近太累。',
          intensity: 66,
        },
      },
      trend: 'up',
      recentEvents: [{
        id: 'rel-event-1',
        kind: 'relationship_delta',
        createdAt: 900,
        summary: '说好下次行动时互相兜底。',
      }],
      lastUpdatedAt: 900,
    }], [
      sharedAnchorEvent({
        id: 'evt-char-pair-secret',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_shared_anchor',
          characterId: 'char-a',
          anchorId: 'anchor-char-pair-secret',
          action: 'upsert',
          kind: 'shared_secret',
          participantIds: ['char-a', 'char-b'],
          title: '小秘密',
          text: '他们有一个只有彼此知道的备用暗号。',
          evidence: '群聊里只用眼神和暗号完成了配合。',
          confidence: 0.92,
          decisionSource: 'model',
        },
      }),
    ]);

    const states = buildCharacterCompanionshipStates(character({ relationships: [] }), 1_200, runtimeChat);
    const state = states.find((item) => item.targetId === 'char-b');

    expect(state).toMatchObject({
      targetId: 'char-b',
      style: 'partner',
      lastCareAt: 1_100,
    });
    expect(state?.sharedSecrets.join('\n')).toContain('备用暗号');
    expect(state?.sharedPromises.join('\n')).toContain('说好下次行动');
    expect(state?.unresolvedCareTopics.join('\n')).toContain('担心');
  });

  it('projects shared memory anchors from layered memories and relationship notes', () => {
    const anchors = buildSharedMemoryAnchors(
      character({
        layeredMemories: [
          {
            id: 'anchor-1',
            scope: 'relationship',
            layer: 'long_term',
            kind: 'bond',
            ownerId: 'char-a',
            subjectIds: ['char-a', 'char-b'],
            text: '第一次深夜聊天后，char-a 和 char-b 都把那次救场当成关系里程碑。',
            evidenceText: 'char-b 在群聊冷场时替 char-a 接住了话。',
            salience: 0.9,
            confidence: 0.88,
            recency: 0.6,
            reinforcementCount: 2,
            sourceEventIds: ['evt-1'],
            origin: 'distilled',
            createdAt: 100,
            updatedAt: 200,
          },
          {
            id: 'weak-1',
            scope: 'relationship',
            layer: 'episodic',
            kind: 'bond',
            ownerId: 'char-a',
            subjectIds: ['char-a', 'char-c'],
            text: '临时闲聊。',
            salience: 0.4,
            confidence: 0.5,
            recency: 0.6,
            reinforcementCount: 1,
            sourceEventIds: [],
            createdAt: 100,
            updatedAt: 200,
          },
        ],
        relationships: [
          {
            characterId: 'char-c',
            warmth: 70,
            trust: 60,
            competence: 20,
            threat: 4,
            note: '共同秘密是只有他们知道的暗号；约定下次一起把话说完。',
            updatedAt: 300,
          },
          {
            characterId: 'user',
            warmth: 99,
            trust: 99,
            competence: 99,
            threat: 0,
            note: '共同秘密不应作为角色-角色关系 note 投影。',
            updatedAt: 300,
          },
          {
            characterId: 'draft-new',
            warmth: 99,
            trust: 99,
            competence: 99,
            threat: 0,
            note: '约定草稿也应过滤。',
            updatedAt: 300,
          },
        ],
      }),
      400,
    );

    expect(anchors.map((item) => item.kind)).toEqual(expect.arrayContaining(['first_time', 'shared_secret', 'promise']));
    expect(anchors.find((item) => item.source === 'layered_memory')).toMatchObject({
      sourceId: 'anchor-1',
      participantIds: ['char-a', 'char-b'],
    });
    expect(anchors.some((item) => item.text.includes('临时闲聊'))).toBe(false);
    expect(anchors.some((item) => item.participantIds.includes('user') && item.source === 'relationship_note')).toBe(false);
    expect(anchors.some((item) => item.participantIds.includes('draft-new'))).toBe(false);
  });

  it('projects shared secrets with public masks and leak state', () => {
    const secrets = buildSharedSecrets(
      character({
        layeredMemories: [{
          id: 'secret-user',
          scope: 'relationship',
          layer: 'long_term',
          kind: 'bond',
          ownerId: 'char-a',
          subjectIds: ['char-a', 'user'],
          text: '共同秘密是用户只把那个暗号告诉过苏苏，不能告诉别人。',
          evidenceText: '用户说这是只有我们知道的暗号。',
          salience: 0.92,
          confidence: 0.9,
          recency: 0.8,
          reinforcementCount: 2,
          sourceEventIds: ['evt-secret-user'],
          origin: 'distilled',
          createdAt: 100,
          updatedAt: 300,
        }],
        relationships: [{
          characterId: 'char-b',
          warmth: 70,
          trust: 65,
          competence: 20,
          threat: 4,
          note: '共同秘密是已经公开说漏的旧暗号。',
          updatedAt: 400,
        }],
      }),
      500,
    );

    expect(secrets[0]).toMatchObject({
      publicMask: '有一件只适合留在心里的事',
      leakState: 'sealed',
      sourceAnchorId: 'memory-secret-user',
    });
    expect(secrets[0].emotionalWeight).toBeGreaterThan(70);
    expect(secrets.some((secret) => secret.leakState === 'leaked')).toBe(true);
  });

  it('reads shared secrets from runtime events and keeps public masks', () => {
    const directChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [sharedSecretEvent()]);
    const secrets = buildSharedSecrets(character(), 1_200, directChat);
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [message({ content: '这是只有我们知道的暗号。', timestamp: 900 })],
      now: 1_200,
    });

    expect(secrets[0]).toMatchObject({
      id: 'secret-user-codeword',
      privateText: '用户只把那个暗号告诉过苏苏，不能告诉别人。',
      publicMask: '有一件只适合留在心里的事',
      leakState: 'sealed',
      sourceAnchorId: 'runtime-evt-shared-secret-1',
      sourceEventIds: ['evt-shared-secret-1'],
      sourceMessageIds: ['msg-secret-model', 'msg-secret-source'],
    });
    expect(trace?.sharedSecrets.join('\n')).toContain('有一件只适合留在心里的事');
    expect(trace?.sharedSecrets.join('\n')).not.toContain('暗号告诉过苏苏');
    expect(trace?.sharedSecretHistory[0]).toMatchObject({
      action: 'recorded',
      secretId: 'secret-user-codeword',
      publicMask: '有一件只适合留在心里的事',
      leakState: 'sealed',
      sourceMessageIds: ['msg-secret-model', 'msg-secret-source'],
      decisionSource: 'model',
    });
    expect(JSON.stringify(trace?.sharedSecretHistory)).not.toContain('暗号告诉过苏苏');
  });

  it('uses later shared secret events to update the public mask without exposing private text', () => {
    const directChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [
      sharedSecretEvent(),
      sharedSecretEvent({
        id: 'evt-shared-secret-mask-edit',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword',
          action: 'recorded',
          participantIds: ['char-a', 'user'],
          privateText: '用户只把那个暗号告诉过苏苏，不能告诉别人。',
          publicMask: '一个只适合两个人记住的暗号',
          reason: '用户在角色关系页修正公开描述。',
          evidence: 'manual_secret_mask_edit_from_character_relationship_tab',
          emotionalWeight: 82,
          confidence: 1,
        },
      }),
    ]);
    const secrets = buildSharedSecrets(character(), 1_200, directChat);
    const trace = buildCompanionshipRuntimeTrace({
      chat: directChat,
      character: character(),
      messages: [],
      now: 1_200,
    });

    expect(secrets[0]).toMatchObject({
      id: 'secret-user-codeword',
      publicMask: '一个只适合两个人记住的暗号',
      privateText: '用户只把那个暗号告诉过苏苏，不能告诉别人。',
      sourceEventIds: ['evt-shared-secret-1', 'evt-shared-secret-mask-edit'],
      sourceMessageIds: ['msg-secret-model', 'msg-secret-source'],
    });
    expect(trace?.sharedSecrets.join('\n')).toContain('一个只适合两个人记住的暗号');
    expect(trace?.sharedSecrets.join('\n')).not.toContain('暗号告诉过苏苏');
  });

  it('uses later shared secret events to narrow participants to the user pair', () => {
    const directChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [
      sharedSecretEvent({
        id: 'evt-shared-secret-with-extra-participant',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword',
          action: 'recorded',
          participantIds: ['char-a', 'user', 'char-b'],
          privateText: '用户只把那个暗号告诉过苏苏，不能告诉别人。',
          publicMask: '有一件只适合留在心里的事',
          reason: '旧事件误把另一个角色放进参与者。',
          evidence: '旧参与者误判',
          emotionalWeight: 82,
          confidence: 0.9,
        },
      }),
      sharedSecretEvent({
        id: 'evt-shared-secret-pair-private',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword',
          action: 'recorded',
          participantIds: ['char-a', 'user'],
          privateText: '用户只把那个暗号告诉过苏苏，不能告诉别人。',
          publicMask: '有一件只适合留在心里的事',
          reason: '用户把小秘密参与者收窄为自己和该角色。',
          evidence: 'manual_secret_participants_pair_private_from_character_relationship_tab',
          emotionalWeight: 82,
          confidence: 1,
        },
      }),
    ]);

    const secrets = buildSharedSecrets(character(), 1_200, directChat);

    expect(secrets[0]).toMatchObject({
      id: 'secret-user-codeword',
      participantIds: ['char-a', 'user'],
    });
    expect(secrets[0].participantIds).not.toContain('char-b');
  });

  it('uses later shared secret events to edit participants into a trusted small group', () => {
    const directChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [
      sharedSecretEvent(),
      sharedSecretEvent({
        id: 'evt-shared-secret-participants-group',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword',
          action: 'recorded',
          participantIds: ['char-a', 'user', 'char-b'],
          privateText: '用户只把那个暗号告诉过苏苏和另一个可信角色。',
          publicMask: '一个只适合小范围知道的暗号',
          reason: '用户把小秘密参与者修正为可信小团体。',
          evidence: 'manual_secret_participants_edit_from_character_relationship_tab',
          emotionalWeight: 82,
          confidence: 1,
        },
      }),
    ]);

    const secrets = buildSharedSecrets(character(), 1_200, directChat);

    expect(secrets[0]).toMatchObject({
      id: 'secret-user-codeword',
      participantIds: ['char-a', 'user', 'char-b'],
      publicMask: '一个只适合小范围知道的暗号',
    });
  });

  it('uses revoked shared secret runtime events to suppress active runtime secrets', () => {
    const directChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [
      sharedSecretEvent(),
      sharedSecretEvent({
        id: 'evt-shared-secret-manual-revoke',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword',
          action: 'revoked',
          participantIds: ['char-a', 'user'],
          privateText: '用户只把那个暗号告诉过苏苏，不能告诉别人。',
          publicMask: '有一件只适合留在心里的事',
          reason: '用户在关系页撤回该小秘密。',
          evidence: 'manual_revoke',
          emotionalWeight: 82,
          confidence: 1,
        },
      }),
    ]);
    const secrets = buildSharedSecrets(character(), 1_200, directChat);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '这是只有我们知道的暗号。', timestamp: 900 })],
      now: 1_200,
    });

    expect(secrets.some((secret) => secret.id === 'secret-user-codeword')).toBe(false);
    expect(projection.userBond?.intimateConflict?.evidence.join('\n') || '').not.toContain('秘密泄露后果');
  });

  it('preserves a leaked secret event without inventing a conflict event', () => {
    const directChat = chat('direct', [relationship({ warmth: 64, trust: 60, competence: 10, threat: 6 })], [
      sharedSecretEvent({
        id: 'evt-shared-secret-leaked',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword',
          action: 'leaked',
          participantIds: ['char-a', 'user'],
          privateText: '用户只把那个暗号告诉过苏苏，结果被说漏了。',
          publicMask: '有一件只适合留在心里的事',
          evidence: '那个暗号被说漏了。',
          emotionalWeight: 88,
          confidence: 0.92,
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '那个暗号被说漏了。', timestamp: 1_000 })],
      now: 1_200,
    });

    expect(buildSharedSecrets(character(), 1_200, directChat)[0]?.leakState).toBe('leaked');
    expect(projection.userBond?.intimateConflict).toBeUndefined();
    expect(projection.promptLines.join('\n')).not.toContain('Current intimate conflict/repair state');
  });

  it('classifies shared secret misunderstanding as a softer leak consequence', () => {
    const baseRelationship = [relationship({ warmth: 64, trust: 60, competence: 10, threat: 6 })];
    const misunderstandingChat = chat('direct', baseRelationship, [
      sharedSecretEvent({
        id: 'evt-shared-secret-misunderstanding',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword-soft',
          action: 'leaked',
          consequenceKind: 'misunderstanding',
          participantIds: ['char-a', 'user'],
          privateText: '用户只把那个暗号告诉过苏苏，后来一句话被误会成说漏了。',
          publicMask: '有一件只适合留在心里的事',
          evidence: '说漏导致用户误会，不是故意，也不是想公开。',
          emotionalWeight: 88,
          confidence: 0.92,
          decisionSource: 'model',
        },
      }),
    ]);
    const misunderstandingProjection = buildUserCompanionshipProjection({
      chat: misunderstandingChat,
      character: character(),
      messages: [message({ content: '说漏导致用户误会，不是故意。', timestamp: 1_000 })],
      now: 1_200,
    });
    const breachChat = chat('direct', baseRelationship, [
      sharedSecretEvent({
        id: 'evt-shared-secret-intentional-breach',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword-breach',
          action: 'leaked',
          consequenceKind: 'intentional_breach',
          participantIds: ['char-a', 'user'],
          privateText: '用户只把那个暗号告诉过苏苏，后来被故意公开说出去。',
          publicMask: '有一件只适合留在心里的事',
          evidence: '故意公开导致秘密传开，像一次越界。',
          emotionalWeight: 88,
          confidence: 0.92,
          decisionSource: 'model',
        },
      }),
    ]);
    const breachProjection = buildUserCompanionshipProjection({
      chat: breachChat,
      character: character(),
      messages: [message({ content: '故意公开导致秘密传开。', timestamp: 1_000 })],
      now: 1_200,
    });
    const misunderstandingSecrets = buildSharedSecrets(character(), 1_200, misunderstandingChat);
    const breachSecrets = buildSharedSecrets(character(), 1_200, breachChat);

    expect(misunderstandingSecrets[0].consequenceKind).toBe('misunderstanding');
    expect(breachSecrets[0].consequenceKind).toBe('intentional_breach');
    expect(misunderstandingProjection.userBond?.intimateConflict).toBeUndefined();
    expect(breachProjection.userBond?.intimateConflict).toBeUndefined();
    expect(misunderstandingProjection.userBond?.intimacy.security || 0).toBeGreaterThan(breachProjection.userBond?.intimacy.security || 0);
  });

  it('preserves protective confession without inventing conflict repair details', () => {
    const directChat = chat('direct', [relationship({ warmth: 64, trust: 60, competence: 10, threat: 6 })], [
      sharedSecretEvent({
        id: 'evt-shared-secret-protective-confession',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword-confession',
          action: 'confessed',
          participantIds: ['char-a', 'user'],
          privateText: '苏苏怕用户误会，所以主动坦白了那个暗号的来龙去脉。',
          publicMask: '有一件只适合留在心里的事',
          reason: '怕用户误会所以主动坦白，是保护性坦白。',
          evidence: '为了不让你误会，我先把这件事说清楚。',
          emotionalWeight: 82,
          confidence: 0.92,
          decisionSource: 'model',
        },
      }),
    ]);
    const projection = buildUserCompanionshipProjection({
      chat: directChat,
      character: character(),
      messages: [message({ content: '为了不让你误会，我先把这件事说清楚。', timestamp: 1_000 })],
      now: 1_200,
    });
    const secrets = buildSharedSecrets(character(), 1_200, directChat);

    expect(secrets[0].consequenceKind).toBe('protective_confession');
    expect(secrets[0]?.leakState).toBe('confessed');
    expect(projection.userBond?.intimateConflict).toBeUndefined();
  });

  it('adjusts intimacy projection from shared secrets, conflict, and attachment adaptation', () => {
    const ledger = [relationship({ warmth: 64, trust: 60, competence: 10, threat: 6 })];
    const messages = [message({ content: '这是只有我们知道的暗号。', timestamp: 900 })];
    const baseProjection = buildUserCompanionshipProjection({
      chat: chat('direct', ledger),
      character: character(),
      messages,
      now: 1_200,
    });
    const sealedProjection = buildUserCompanionshipProjection({
      chat: chat('direct', ledger, [sharedSecretEvent()]),
      character: character(),
      messages,
      now: 1_200,
    });
    const leakedProjection = buildUserCompanionshipProjection({
      chat: chat('direct', ledger, [
        sharedSecretEvent({
          id: 'evt-shared-secret-leaked-for-intimacy',
          createdAt: 1_000,
          payload: {
            eventType: 'companionship_shared_secret',
            characterId: 'char-a',
            userId: 'user',
            secretId: 'secret-user-codeword',
            action: 'leaked',
            participantIds: ['char-a', 'user'],
            privateText: '用户只把那个暗号告诉过苏苏，结果被说漏了。',
            publicMask: '有一件只适合留在心里的事',
            evidence: '那个暗号被说漏了。',
            emotionalWeight: 88,
            confidence: 0.92,
            decisionSource: 'model',
          },
        }),
      ]),
      character: character(),
      messages,
      now: 1_200,
    });
    const anxiousProjection = buildUserCompanionshipProjection({
      chat: chat('direct', ledger, [attachmentProfileEvent({
        id: 'evt-attachment-anxious-for-intimacy',
        payload: {
          eventType: 'companionship_attachment_profile',
          characterId: 'char-a',
          userId: 'user',
          action: 'corrected',
          inferredStyle: 'anxious',
          confidence: 0.92,
          evidence: ['用户需要更明确的回应。'],
          adaptations: ['give concrete reassurance without overpromising'],
          decisionSource: 'model',
        },
      })]),
      character: character(),
      messages,
      now: 1_200,
    });

    expect(sealedProjection.userBond?.intimacy.intimacy || 0).toBeGreaterThan(baseProjection.userBond?.intimacy.intimacy || 0);
    expect(sealedProjection.userBond?.intimacy.security || 0).toBeGreaterThan(baseProjection.userBond?.intimacy.security || 0);
    expect(leakedProjection.userBond?.intimacy.security || 0).toBeLessThan(sealedProjection.userBond?.intimacy.security || 0);
    expect(leakedProjection.userBond?.intimateConflict).toBeUndefined();
    expect(anxiousProjection.userBond?.intimacy.longing || 0).toBeGreaterThan(baseProjection.userBond?.intimacy.longing || 0);
  });

  it('uses revoked shared secret events to suppress matching anchor secrets', () => {
    const secretCharacter = character({
      layeredMemories: [{
        id: 'secret-user',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '共同秘密是用户只把那个暗号告诉过苏苏，不能告诉别人。',
        evidenceText: '用户说这是只有我们知道的暗号。',
        salience: 0.92,
        confidence: 0.9,
        recency: 0.8,
        reinforcementCount: 2,
        sourceEventIds: ['evt-secret-user'],
        origin: 'distilled',
        createdAt: 100,
        updatedAt: 300,
      }],
    });
    const directChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [
      sharedSecretEvent({
        id: 'evt-shared-secret-revoked',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_shared_secret',
          characterId: 'char-a',
          userId: 'user',
          secretId: 'secret-user-codeword',
          action: 'revoked',
          participantIds: ['char-a', 'user'],
          privateText: '用户只把那个暗号告诉过苏苏，不能告诉别人。',
          evidence: '这个暗号以后别记了。',
          confidence: 0.9,
          decisionSource: 'model',
        },
      }),
    ]);
    const secrets = buildSharedSecrets(secretCharacter, 1_200, directChat);

    expect(secrets.map((secret) => secret.privateText).join('\n')).not.toContain('暗号告诉过苏苏');
  });

  it('projects ritual registry from addressing, dates, and shared anchors', () => {
    const ritualCharacter = character({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说：叫我小夏。', '用户的纪念日是六月一日。'],
      },
      layeredMemories: [{
        id: 'joke-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '共同梗是只有他们懂的“晚点回来”。',
        evidenceText: '用户和苏苏反复用这个暗号接话。',
        salience: 0.86,
        confidence: 0.88,
        recency: 0.7,
        reinforcementCount: 2,
        sourceEventIds: ['evt-joke'],
        origin: 'distilled',
        createdAt: 100,
        updatedAt: 300,
      }],
    });
    const rituals = buildRitualRegistry({
      character: ritualCharacter,
      chat: chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })]),
      messages: [message({ content: '晚点回来。', timestamp: 200 })],
      now: 500,
    });

    expect(rituals.map((ritual) => ritual.kind)).toEqual(expect.arrayContaining(['daily_greeting', 'pet_name', 'anniversary', 'inside_joke']));
    expect(rituals.find((ritual) => ritual.kind === 'pet_name')?.content).toContain('小夏');
    expect(rituals.find((ritual) => ritual.kind === 'inside_joke')?.sourceAnchorId).toBe('memory-joke-anchor');

    const trace = buildCompanionshipRuntimeTrace({
      chat: chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })]),
      character: ritualCharacter,
      messages: [message({ content: '晚点回来。', timestamp: 200 })],
      now: 500,
    });
    expect(trace?.rituals.join('\n')).toContain('小夏');
  });

  it('disables relationship rituals globally for registry and artifact seeds', () => {
    setCompanionshipRuntimeConfig({ enableRelationshipRituals: false });
    const ritualCharacter = character({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说：叫我小夏。', '用户的纪念日是六月一日。'],
      },
    });
    const ritualChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [ritualEvent()]);

    const rituals = buildRitualRegistry({
      character: ritualCharacter,
      chat: ritualChat,
      messages: [message({ content: '晚安，今天就先这样。', timestamp: 1_100 })],
      now: 2_000,
    });
    const seeds = buildCompanionshipArtifactSeeds({
      character: ritualCharacter,
      chat: ritualChat,
      messages: [message({ content: '晚安，今天就先这样。', timestamp: 1_100 })],
      surface: 'private_diary',
      now: 2_000,
    });
    const trace = buildCompanionshipRuntimeTrace({
      chat: ritualChat,
      character: ritualCharacter,
      messages: [message({ content: '晚安，今天就先这样。', timestamp: 1_100 })],
      now: 2_000,
    });

    expect(rituals).toEqual([]);
    expect(seeds.join('\n')).not.toContain('关系仪式');
    expect(trace?.rituals).toEqual([]);
  });

  it('filters relationship rituals by user-configured ritual kind toggles', () => {
    setCompanionshipRuntimeConfig({
      ritualKindToggles: {
        ...DEFAULT_COMPANIONSHIP_SETTINGS.ritualKindToggles,
        daily_greeting: false,
        inside_joke: false,
      },
    });
    const ritualCharacter = character({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说：叫我小夏。', '用户的纪念日是六月一日。'],
      },
      layeredMemories: [{
        id: 'memory-joke-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '共同梗是只有他们懂的“晚点回来”。',
        evidenceText: '用户和苏苏反复用这个暗号接话。',
        salience: 0.86,
        confidence: 0.88,
        recency: 0.7,
        reinforcementCount: 2,
        sourceEventIds: ['evt-joke'],
        origin: 'distilled',
        createdAt: 100,
        updatedAt: 300,
      }],
    });

    const rituals = buildRitualRegistry({
      character: ritualCharacter,
      chat: chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })]),
      messages: [message({ content: '晚点回来。', timestamp: 200 })],
      now: 500,
    });

    expect(rituals.some((ritual) => ritual.kind === 'daily_greeting')).toBe(false);
    expect(rituals.some((ritual) => ritual.kind === 'inside_joke')).toBe(false);
    expect(rituals.map((ritual) => ritual.kind)).toEqual(expect.arrayContaining(['pet_name', 'anniversary']));
  });

  it('restrains greeting rituals when user rejects them', () => {
    const rituals = buildRitualRegistry({
      character: character({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户说：叫我小夏。', '用户不希望早安晚安打扰。'],
        },
      }),
      now: 500,
    });

    expect(rituals.some((ritual) => ritual.kind === 'daily_greeting')).toBe(false);
    expect(rituals.find((ritual) => ritual.kind === 'pet_name')?.boundaryReasons).toContain('user rejects greeting rituals');
  });

  it('uses ritual event content and evolution when projecting ritual registry', () => {
    const rituals = buildRitualRegistry({
      character: character(),
      chat: chat('direct', [], [ritualEvent({
        id: 'evt-ritual-evolved',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_ritual',
          characterId: 'char-a',
          userId: 'user',
          ritualId: 'ritual-char-a-daily-greeting',
          kind: 'daily_greeting',
          action: 'performed',
          participantIds: ['char-a', 'user'],
          content: '晚安时会先问小夏今天有没有好好收尾，而不是机械打卡。',
          evolution: ['从普通晚安变成睡前轻轻确认状态。'],
          sourceMessageIds: ['msg-ritual-model'],
          confidence: 0.88,
          decisionSource: 'model',
        },
      })]),
      messages: [message({ content: '晚安，今天就先这样。', timestamp: 1_100 })],
      now: 1_300,
    });

    const greeting = rituals.find((ritual) => ritual.id === 'ritual-char-a-daily-greeting');
    expect(greeting?.content).toBe('晚安时会先问小夏今天有没有好好收尾，而不是机械打卡。');
    expect(greeting?.evolution).toContain('从普通晚安变成睡前轻轻确认状态。');
    expect(greeting?.sourceMessageIds).toEqual(['msg-ritual-model', 'msg-ritual-evidence']);
    const trace = buildCompanionshipRuntimeTrace({
      character: character(),
      chat: chat('direct', [], [ritualEvent({
        id: 'evt-ritual-evolved',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_ritual',
          characterId: 'char-a',
          userId: 'user',
          ritualId: 'ritual-char-a-daily-greeting',
          kind: 'daily_greeting',
          action: 'performed',
          participantIds: ['char-a', 'user'],
          content: '晚安时会先问小夏今天有没有好好收尾，而不是机械打卡。',
          evolution: ['从普通晚安变成睡前轻轻确认状态。'],
          sourceMessageIds: ['msg-ritual-model'],
          confidence: 0.88,
          decisionSource: 'model',
        },
      })]),
      messages: [message({ content: '晚安，今天就先这样。', timestamp: 1_100 })],
      now: 1_300,
    });
    expect(trace?.ritualHistory[0]).toMatchObject({
      id: 'evt-ritual-evolved',
      ritualId: 'ritual-char-a-daily-greeting',
      action: 'performed',
      kind: 'daily_greeting',
      content: '晚安时会先问小夏今天有没有好好收尾，而不是机械打卡。',
      decisionSource: 'model',
      confidence: 0.88,
      sourceMessageIds: ['msg-ritual-model', 'msg-ritual-evidence'],
    });
  });

  it('uses updated ritual events to edit content without marking the ritual performed', () => {
    const rituals = buildRitualRegistry({
      character: character(),
      chat: chat('direct', [], [ritualEvent({
        id: 'evt-ritual-updated',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_ritual',
          characterId: 'char-a',
          userId: 'user',
          ritualId: 'ritual-char-a-daily-greeting',
          kind: 'daily_greeting',
          action: 'updated',
          participantIds: ['char-a', 'user'],
          content: '晚安时只轻轻问一句今天要不要早点休息，不要机械打卡。',
          evolution: ['用户手动修正了问候方式。'],
          confidence: 1,
        },
      })]),
      messages: [],
      now: 1_300,
    });

    const greeting = rituals.find((ritual) => ritual.id === 'ritual-char-a-daily-greeting');
    expect(greeting).toMatchObject({
      content: '晚安时只轻轻问一句今天要不要早点休息，不要机械打卡。',
      executionState: 'available',
    });
    expect(greeting?.lastPerformedAt).toBeUndefined();
    expect(greeting?.nextAvailableAt).toBeUndefined();
    expect(greeting?.evolution).toContain('用户手动修正了问候方式。');
  });

  it('reads ritual execution events into cooldown state and debug trace', () => {
    const ritualChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [ritualEvent()]);
    const ritualCharacter = character({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说：叫我小夏。'],
      },
    });
    const rituals = buildRitualRegistry({
      character: ritualCharacter,
      chat: ritualChat,
      messages: [],
      now: 2_000,
    });
    const greeting = rituals.find((ritual) => ritual.id === 'ritual-char-a-daily-greeting');

    expect(greeting).toMatchObject({
      lastPerformedAt: 1_000,
      executionState: 'cooldown',
    });
    expect(greeting?.nextAvailableAt).toBe(1_000 + 12 * 60 * 60_000);
    expect(greeting?.boundaryReasons.join('\n')).toContain('ritual cooldown until');

    const trace = buildCompanionshipRuntimeTrace({
      chat: ritualChat,
      character: ritualCharacter,
      messages: [],
      now: 2_000,
    });
    expect(trace?.rituals.join('\n')).toContain('cooldown');
    expect(trace?.rituals.join('\n')).toContain('冷却至');

    const seeds = buildCompanionshipArtifactSeeds({
      character: ritualCharacter,
      chat: ritualChat,
      messages: [],
      surface: 'private_diary',
      now: 2_000,
    });
    expect(seeds.join('\n')).not.toContain('早安/晚安');
  });

  it('uses suppressed ritual events to keep rituals out of artifact seeds', () => {
    const ritualChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [ritualEvent({
      id: 'evt-ritual-suppressed',
      createdAt: 1_100,
      payload: {
        eventType: 'companionship_ritual',
        characterId: 'char-a',
        userId: 'user',
        ritualId: 'ritual-char-a-daily-greeting',
        kind: 'daily_greeting',
        action: 'suppressed',
        participantIds: ['char-a', 'user'],
        content: '晚安时会先问小夏今天有没有好好收尾，而不是机械打卡。',
        reason: '用户在关系页抑制该仪式。',
        evidence: 'manual_suppression',
        confidence: 1,
      },
    })]);
    const ritualCharacter = character({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说：叫我小夏。'],
      },
    });
    const rituals = buildRitualRegistry({
      character: ritualCharacter,
      chat: ritualChat,
      messages: [],
      now: 2_000,
    });
    const greeting = rituals.find((ritual) => ritual.id === 'ritual-char-a-daily-greeting');
    const seeds = buildCompanionshipArtifactSeeds({
      character: ritualCharacter,
      chat: ritualChat,
      messages: [],
      surface: 'private_diary',
      now: 2_000,
    });

    expect(greeting?.executionState).toBe('suppressed');
    expect(greeting?.boundaryReasons.join('\n')).toContain('ritual suppressed');
    expect(seeds.join('\n')).not.toContain('晚安时会先问小夏');
  });

  it('uses restored ritual events to re-enable a suppressed ritual', () => {
    const ritualChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], [
      ritualEvent({
        id: 'evt-ritual-suppressed',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_ritual',
          characterId: 'char-a',
          userId: 'user',
          ritualId: 'ritual-char-a-daily-greeting',
          kind: 'daily_greeting',
          action: 'suppressed',
          participantIds: ['char-a', 'user'],
          content: '晚安时会先问小夏今天有没有好好收尾，而不是机械打卡。',
          reason: '用户在关系页抑制该仪式。',
          evidence: 'manual_suppression',
          confidence: 1,
        },
      }),
      ritualEvent({
        id: 'evt-ritual-restored',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_ritual',
          characterId: 'char-a',
          userId: 'user',
          ritualId: 'ritual-char-a-daily-greeting',
          kind: 'daily_greeting',
          action: 'restored',
          participantIds: ['char-a', 'user'],
          content: '晚安时会先问小夏今天有没有好好收尾，而不是机械打卡。',
          reason: '用户在关系页恢复该仪式。',
          evidence: 'manual_restore',
          confidence: 1,
        },
      }),
    ]);
    const ritualCharacter = character({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说：叫我小夏。'],
      },
    });
    const rituals = buildRitualRegistry({
      character: ritualCharacter,
      chat: ritualChat,
      messages: [],
      now: 2_000,
    });
    const greeting = rituals.find((ritual) => ritual.id === 'ritual-char-a-daily-greeting');
    const seeds = buildCompanionshipArtifactSeeds({
      character: ritualCharacter,
      chat: ritualChat,
      messages: [],
      surface: 'private_diary',
      now: 2_000,
    });

    expect(greeting?.executionState).toBe('available');
    expect(greeting?.boundaryReasons.join('\n')).not.toContain('ritual suppressed');
    expect(seeds.join('\n')).toContain('晚安时会先问小夏');
  });

  it('uses updated ritual events from history restore to re-enable suppressed ritual content', () => {
    const events = [
      ritualEvent({
        id: 'evt-ritual-original-content',
        createdAt: 1_000,
        payload: {
          eventType: 'companionship_ritual',
          characterId: 'char-a',
          userId: 'user',
          ritualId: 'ritual-char-a-daily-greeting',
          kind: 'daily_greeting',
          action: 'updated',
          participantIds: ['char-a', 'user'],
          content: '睡前只轻轻确认一句：今天有没有好好收尾。',
          evolution: ['用户喜欢克制一点的晚安。'],
          sourceMessageIds: ['msg-ritual-original'],
          confidence: 1,
        },
      }),
      ritualEvent({
        id: 'evt-ritual-suppressed',
        createdAt: 1_100,
        payload: {
          eventType: 'companionship_ritual',
          characterId: 'char-a',
          userId: 'user',
          ritualId: 'ritual-char-a-daily-greeting',
          kind: 'daily_greeting',
          action: 'suppressed',
          participantIds: ['char-a', 'user'],
          content: '睡前只轻轻确认一句：今天有没有好好收尾。',
          reason: '用户暂时停用这个晚安仪式。',
          evidence: 'manual_ritual_suppressed',
          sourceMessageIds: ['msg-ritual-original'],
          confidence: 1,
        },
      }),
      ritualEvent({
        id: 'evt-ritual-history-restored',
        createdAt: 1_200,
        payload: {
          eventType: 'companionship_ritual',
          characterId: 'char-a',
          userId: 'user',
          ritualId: 'ritual-char-a-daily-greeting',
          kind: 'daily_greeting',
          action: 'updated',
          participantIds: ['char-a', 'user'],
          content: '睡前只轻轻确认一句：今天有没有好好收尾。',
          evolution: ['用户喜欢克制一点的晚安。', '从仪式历史 evt-ritual-original-content 恢复。'],
          reason: '用户在开发者诊断中从仪式历史恢复内容。',
          evidence: 'manual_restore_from_ritual_history',
          sourceMessageIds: ['msg-ritual-original'],
          confidence: 1,
        },
      }),
    ];
    const ritualChat = chat('direct', [relationship({ warmth: 70, trust: 68, competence: 10, threat: 2 })], events);
    const rituals = buildRitualRegistry({
      character: character(),
      chat: ritualChat,
      messages: [],
      now: 1_300,
    });
    const trace = buildCompanionshipRuntimeTrace({
      character: character(),
      chat: ritualChat,
      messages: [],
      now: 1_300,
    });

    const greeting = rituals.find((ritual) => ritual.id === 'ritual-char-a-daily-greeting');
    expect(greeting).toMatchObject({
      content: '睡前只轻轻确认一句：今天有没有好好收尾。',
      executionState: 'available',
    });
    expect(greeting?.boundaryReasons.join('\n')).not.toContain('ritual suppressed');
    expect(greeting?.sourceMessageIds).toEqual(['msg-ritual-original', 'msg-ritual-evidence']);
    expect(trace?.ritualHistory.map((item) => item.id).slice(0, 3)).toEqual(['evt-ritual-history-restored', 'evt-ritual-suppressed', 'evt-ritual-original-content']);
    expect(trace?.ritualHistory[0]).toMatchObject({
      action: 'updated',
      content: '睡前只轻轻确认一句：今天有没有好好收尾。',
      sourceMessageIds: ['msg-ritual-original', 'msg-ritual-evidence'],
    });
  });

  it('builds private and public artifact seeds with different user-memory boundaries', () => {
    const base = character({
      relationships: [{
        characterId: 'char-b',
        warmth: 72,
        trust: 68,
        competence: 20,
        threat: 4,
        note: '共同秘密是只有他们知道的暗号；约定下次一起把话说完。',
        updatedAt: 300,
      }],
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说下周要面试，希望别被公开点名。'],
      },
    });

    const privateSeeds = buildCompanionshipArtifactSeeds({
      character: base,
      relatedCharacters: [{ id: 'char-b', name: '小雨' }],
      surface: 'private_diary',
      includeUserMemory: true,
      now: 400,
    });
    const publicSeeds = buildCompanionshipArtifactSeeds({
      character: base,
      relatedCharacters: [{ id: 'char-b', name: '小雨' }],
      surface: 'public_moment',
      includeUserMemory: false,
      now: 400,
    });

    expect(privateSeeds.join('\n')).toContain('用户');
    expect(privateSeeds.join('\n')).toContain('小雨');
    expect(publicSeeds.join('\n')).toContain('公开动态');
    expect(publicSeeds.join('\n')).toContain('小雨');
    expect(publicSeeds.join('\n')).toContain('公开遮罩');
    expect(publicSeeds.join('\n')).toContain('一个只有熟人懂的暗号');
    expect(publicSeeds.join('\n')).not.toContain('只有他们知道的暗号');
    expect(publicSeeds.join('\n')).not.toContain('面试');
    expect(publicSeeds.join('\n')).not.toContain('希望别被公开点名');
  });
});
