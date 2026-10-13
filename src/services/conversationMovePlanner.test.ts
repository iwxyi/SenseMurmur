import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { SessionFamily } from '../types/sessionEngine';
import { buildConversationMovePrompt, planConversationMove } from './conversationMovePlanner';

function character(patch: Partial<AICharacter> = {}): AICharacter {
  return {
    id: 'a',
    name: '小甲',
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 45, humor: 30, creativity: 50, assertiveness: 50, empathy: 50 },
    behavior: { proactivity: 50, aggressiveness: 20, humorIntensity: 20, empathyLevel: 50, summarizing: 20, offTopic: 20 },
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
  } as AICharacter;
}

function chat(family: SessionFamily = 'conversation'): GroupChat {
  return {
    id: 'chat-1',
    type: 'group',
    mode: family === 'analysis' ? 'group_discussion' : 'open_chat',
    sessionKind: { topology: 'group', family, scenarioId: family === 'analysis' ? 'opinion-review' : 'open-chat', surfaceProfile: 'text' },
    name: '测试群',
    topic: '合租是否还值得',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b', 'c'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free' },
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  } as GroupChat;
}

function message(id: string, senderId: string, content: string, type: Message['type'] = 'ai'): Message {
  return {
    id,
    chatId: 'chat-1',
    type,
    senderId,
    senderName: senderId,
    content,
    emotion: 0,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    isDeleted: false,
  };
}

function withArtifacts(base: Message, artifacts: NonNullable<Message['metadata']>['deliberationArtifacts']): Message {
  return {
    ...base,
    metadata: {
      ...(base.metadata || {}),
      deliberationArtifacts: artifacts,
    },
  };
}

describe('conversationMovePlanner', () => {
  it('targets human unresolved questions before simply following the latest line', () => {
    const plan = planConversationMove({
      chat: chat('conversation'),
      speaker: character(),
      messages: [
        message('m1', 'user', '如果按需热闹最后变成全需怎么办？', 'user'),
        message('m2', 'c', '这个词挺有意思，我也觉得有点像插件。'),
      ],
    });

    expect(plan.moveType).not.toBe('answer_unresolved_question');
  });

  it('does not force casual group speakers to answer every AI question in the room', () => {
    const plan = planConversationMove({
      chat: chat('conversation'),
      speaker: character({ id: 'a', name: '小甲' }),
      messages: [
        message('m1', 'b', '如果按需热闹最后变成全需怎么办？'),
        message('m2', 'c', '这个词挺有意思，我也觉得有点像插件。'),
      ],
    });

    expect(plan.moveType).not.toBe('answer_unresolved_question');
    expect(plan.targetMessageId).not.toBe('m1');
  });

  it('still treats an AI question as pending when it explicitly names the speaker', () => {
    const plan = planConversationMove({
      chat: chat('conversation'),
      speaker: character({ id: 'a', name: '小甲' }),
      messages: [
        message('m1', 'b', '小甲，如果按需热闹最后变成全需怎么办？'),
        message('m2', 'c', '这个词挺有意思，我也觉得有点像插件。'),
      ],
    });

    expect(plan.moveType).not.toBe('answer_unresolved_question');
  });

  it('focuses an earlier direct address after another member interrupts', () => {
    const plan = planConversationMove({
      chat: chat('conversation'),
      speaker: character({ id: 'a', name: '小甲' }),
      messages: [
        message('m1', 'b', '小甲，这件事你现在表个态。'),
        message('m2', 'c', '我先补一个背景。'),
      ],
      pendingReplyContext: {
        targetIds: ['a'], primaryTargetId: 'a', sourceSpeakerId: 'b', sourceMessageId: 'm1', unmetTurns: 1, strength: 'strong',
      },
    });

    expect(plan).toMatchObject({
      targetMessageId: 'm1',
      targetActorId: 'b',
      reason: 'pending_direct_address',
    });
  });

  it('bootstraps analysis-room scrutiny even before artifacts exist', () => {
    const plan = planConversationMove({
      chat: chat('analysis'),
      speaker: character(),
      messages: [
        message('m1', 'b', '确实，“按需热闹”这个说法很准。'),
        message('m2', 'c', '我也觉得“按需热闹”很有画面感。'),
        message('m3', 'b', '这个“按需热闹”可能就是答案。'),
      ],
    });

    expect(plan.moveType).toBe('ask_evidence');
    expect(plan.reason).toBe('bootstrap_missing_artifacts_needs_scrutiny');
  });

  it('uses deliberation artifacts to ask for evidence after unsupported consensus', () => {
    const plan = planConversationMove({
      chat: chat('analysis'),
      speaker: character(),
      messages: [
        withArtifacts(message('m1', 'b', '合租需要先有底层规则。'), {
          claims: [{ text: '合租需要先有底层规则。', confidence: 0.8 }],
        }),
        withArtifacts(message('m2', 'c', '规则跑稳之后才会有温情。'), {
          verdicts: [{ text: '规则是温情前提。', confidence: 0.78 }],
        }),
        withArtifacts(message('m3', 'b', '协议就是关系地基。'), {
          summary: { text: '大家倾向于认可先规矩后默契。', confidence: 0.75 },
        }),
      ],
    });

    expect(plan.moveType).toBe('ask_evidence');
    expect(plan.reason).toBe('claims_without_evidence');
  });

  it('keeps analysis rooms in deliberation mode even when the transcript has drifted into closure', () => {
    const plan = planConversationMove({
      chat: chat('analysis'),
      speaker: character(),
      messages: [
        message('m1', 'b', '各位晚安，我先撤了，灯别关太亮。'),
        message('m2', 'c', '我也下线了，后台挂着，明天见。'),
      ],
    });

    expect(plan.reason).toBe('bootstrap_without_artifacts');
    expect(plan.moveType).toBe('separate_claims');
  });

  it('turns consensus artifacts into assumption testing when verdicts have no issues', () => {
    const plan = planConversationMove({
      chat: chat('analysis'),
      speaker: character(),
      messages: [
        withArtifacts(message('m1', 'b', '协议不伤感情。'), {
          claims: [{ text: '协议不伤感情。', confidence: 0.8 }],
          evidence: [{ text: '一个出租案例住得更久。', confidence: 0.7 }],
        }),
        withArtifacts(message('m2', 'c', '规矩是地基。'), {
          verdicts: [{ text: '规矩能降低矛盾。', confidence: 0.76 }],
        }),
        withArtifacts(message('m3', 'b', '运营系统跑稳了家才生根。'), {
          verdicts: [{ text: '运营系统是家的前提。', confidence: 0.76 }],
          summary: { text: '房间形成了规矩先于默契的倾向。', confidence: 0.72 },
        }),
      ],
    });

    expect(plan.moveType).toBe('test_assumption');
    expect(plan.reason).toBe('consensus_without_questioning');
  });

  it('can bring back prior points in casual rooms instead of only praising the latest line', () => {
    const plan = planConversationMove({
      chat: chat('conversation'),
      speaker: character(),
      messages: [
        message('m1', 'user', '但猫不能在你崩溃时问你还撑得住吗，这个陪伴缺口怎么办？', 'user'),
        message('m2', 'c', '确实这个说法很准。'),
        message('m3', 'b', '我也觉得这个比喻很好。'),
        message('m4', 'c', '说得太真实了。'),
      ],
    });

    expect(plan.moveType).not.toBe('answer_unresolved_question');
  });

  it('lets casual agreement echo loops settle instead of manufacturing another point', () => {
    const plan = planConversationMove({
      chat: chat('conversation'),
      speaker: character(),
      messages: [
        message('m1', 'b', '这句还算稳当。先护住肯做事的人。'),
        message('m2', 'c', '这句我也接。先把分寸立住。'),
        message('m3', 'd', '这后辈说得不差。好骑手也得先认清哪匹马真能跑。'),
        message('m4', 'b', '这句补得对。最后满殿站着的就都是算盘。'),
      ],
    });

    expect(['react_lightly', 'shift_topic_softly']).toContain(plan.moveType);
    expect(plan.reason).toBe('default_room_move');
  });

  it('occasionally braids back to an earlier room thread instead of always answering the latest speaker', () => {
    const base = [
      message('m1', 'b', '我先把北门的事说清楚。'),
      message('m2', 'c', '南边的粮道也不能漏。'),
      message('m3', 'b', '北门先守住，粮道再议。'),
      message('m4', 'c', '那就先记着，别又绕回原处。'),
    ];
    const plans = Array.from({ length: 12 }, (_, index) => planConversationMove({
      chat: chat('conversation'),
      speaker: character({ id: 'a', name: '小甲' }),
      messages: [...base, message(`m${index + 5}`, index % 2 ? 'c' : 'b', '我再补一句。')],
    }));

    expect(plans.some((plan) => plan.reason === 'ambient_thread_braid')).toBe(true);
    expect(plans.filter((plan) => plan.reason === 'ambient_thread_braid').every((plan) => plan.targetMessageId !== `m${base.length + 5}`)).toBe(true);
  });

  it('does not derive a conversation move from rotation or selection despite silence', () => {
    const input = {
      chat: chat('conversation'),
      speaker: character({ behavior: { proactivity: 70, aggressiveness: 20, humorIntensity: 20, empathyLevel: 50, summarizing: 20, offTopic: 20 } }),
      messages: [
        message('m1', 'b', '这句还算稳当。先护住肯做事的人。'),
        message('m2', 'c', '这句我也接。先把分寸立住。'),
        message('m3', 'b', '这句补得对。最后满殿站着的就都是算盘。'),
      ],
      speakerScore: {
        actorId: 'a',
        addressed: 0,
        topicRelevance: 0,
        lineInvolvement: 0,
        emotionalPressure: 0,
        innerLifePressure: 0,
        relationshipPressure: 0,
        factionPressure: 0,
        personalityDrive: 0,
        knowledgeAccess: 0,
        novelty: 0,
        silencePressure: 0.4,
        cooldownPenalty: 0,
        repetitionPenalty: 0,
        finalScore: 0.7,
        reasons: ['unspoken_member', 'inner:stay_silent'],
      },
    };
    expect(planConversationMove(input)).toEqual(planConversationMove({ ...input, speakerScore: undefined }));
  });

  it('does not let rotation override transcript-based guidance', () => {
    const plan = planConversationMove({
      chat: chat('conversation'),
      speaker: character({ id: 'a', name: '小甲' }),
      messages: [
        message('m1', 'b', '小甲，那天你到底是什么感觉？'),
      ],
      speakerScore: {
        actorId: 'a', addressed: 0.62, topicRelevance: 0, lineInvolvement: 0,
        emotionalPressure: 0.6, innerLifePressure: 0.2, relationshipPressure: 0.1,
        factionPressure: 0, personalityDrive: 0.4, knowledgeAccess: 0, novelty: 0,
        silencePressure: 0.4, cooldownPenalty: 0, repetitionPenalty: 0, finalScore: 0.8,
        reasons: ['unspoken_member', 'direct_message_address', 'inner:defend_face'],
      },
    });

    expect(plan).toEqual(planConversationMove({
      chat: chat('conversation'),
      speaker: character({ id: 'a', name: '小甲' }),
      messages: [message('m1', 'b', '小甲，那天你到底是什么感觉？')],
    }));
  });

  it('renders a casual echo-loop prompt that stops manufacturing new substance', () => {
    const prompt = buildConversationMovePrompt({
      speakerId: 'a',
      moveType: 'react_lightly',
      socialPosture: { warmth: 'neutral', directness: 'plain' },
      reason: 'chat_echo_loop',
      confidence: 0.78,
    }, chat('conversation'));

    expect(prompt).toContain('already worried the same point enough');
    expect(prompt).toContain('Do not manufacture a new condition');
    expect(prompt).toContain('brief personal reaction');
  });

  it('does not require a missing angle for a historical break-in reason', () => {
    const prompt = buildConversationMovePrompt({
      speakerId: 'a',
      moveType: 'name_tradeoff',
      socialPosture: { warmth: 'neutral', directness: 'plain' },
      reason: 'break_in_selected_despite_silence',
      confidence: 0.82,
    }, chat('conversation'));

    expect(prompt).not.toContain('selected to break a narrow room loop');
    expect(prompt).not.toContain('concrete missing angle');
    expect(prompt).toContain('secondary realization option');
  });

  it('renders a prompt that separates warmth from viewpoint agreement in analysis rooms', () => {
    const plan = planConversationMove({
      chat: chat('analysis'),
      speaker: character({ relationships: [{ characterId: 'b', warmth: 70, trust: 60, competence: 30, threat: 0, note: '', updatedAt: 1 }] }),
      messages: [message('m1', 'b', '合租应该被做成按需热闹。')],
    });

    const prompt = buildConversationMovePrompt(plan, chat('analysis'));
    expect(prompt).toContain('warmth is interpersonal tone only');
    expect(prompt).toContain('Current semantic job:');
    expect(prompt).not.toContain('Target:');
    expect(prompt).not.toContain('target=');
  });

  it('warns analysis scrutiny moves not to add another supporting analogy', () => {
    const prompt = buildConversationMovePrompt({
      speakerId: 'a',
      moveType: 'ask_evidence',
      socialPosture: { warmth: 'neutral', directness: 'plain' },
      reason: 'claims_without_evidence',
      confidence: 0.8,
    }, chat('analysis'));

    expect(prompt).toContain('Do not add another supporting analogy');
  });

  it('tells casual rooms they may skip jargon or enter from everyday life', () => {
    const prompt = buildConversationMovePrompt({
      speakerId: 'a',
      moveType: 'react_lightly',
      socialPosture: { warmth: 'neutral', directness: 'plain' },
      reason: 'default_room_move',
      confidence: 0.55,
    }, chat('conversation'));

    expect(prompt).toContain('admit a term is outside your lane');
    expect(prompt).toContain('nearby everyday angle');
  });

  it('keeps ordinary thread focus optional, including scheduler-selected reply debt', () => {
    const ordinary = buildConversationMovePrompt({
      speakerId: 'a',
      targetActorId: 'b',
      targetClaimText: '今晚还去不去？',
      moveType: 'react_lightly',
      socialPosture: { warmth: 'neutral', directness: 'plain' },
      reason: 'default_room_move',
      confidence: 0.55,
    }, chat('conversation'), '乙');
    expect(ordinary).toContain('Attention cue only');
    expect(ordinary).toContain('not a required reply');
    expect(ordinary).not.toContain('Reply obligation');

    const direct = buildConversationMovePrompt({
      speakerId: 'a',
      targetActorId: 'b',
      targetClaimText: '今晚还去不去？',
      moveType: 'answer_unresolved_question',
      socialPosture: { warmth: 'neutral', directness: 'plain' },
      reason: 'pending_direct_address',
      confidence: 0.96,
    }, chat('conversation'), '乙');
    expect(direct).toContain('Attention cue only');
    expect(direct).toContain('not a required reply');
    expect(direct).not.toContain('Reply obligation');
  });

});
