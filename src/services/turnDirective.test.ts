import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import {
  DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
  DEFAULT_CONVERSATION_DRAMA_RULES,
  DEFAULT_CONVERSATION_GOVERNANCE,
  DEFAULT_CONVERSATION_WORLD_STATE,
  type GroupChat,
} from '../types/chat';
import type { Message } from '../types/message';
import type { InnerLifeProjection } from './innerLifeEngine';
import type { ConversationMovePlan } from './conversationMovePlanner';
import type { SpeakIntent } from './intentEngine';
import type { TurnPlan } from './turnPlanner';
import { buildTurnDirective, buildTurnDirectivePrompt, shouldUseUnifiedTurnDirective } from './turnDirective';
import { projectNarrativeLines } from './narrativeProjection';
import { applyConversationUpdate } from './conversationContinuity';

function character(id: string, name: string, patch: Partial<AICharacter> = {}): AICharacter {
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

function chat(patch: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: false },
    modeState: { phase: 'free' },
    name: '闲聊',
    topic: '周末生日聚会怎么安排',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['rui', 'chen'],
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

function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    chatId: 'chat-1',
    senderId: 'chen',
    senderName: '陈越',
    type: 'ai',
    emotion: 0,
    content: '这次就按贵的订吧，省得麻烦。',
    timestamp: 1,
    isDeleted: false,
    ...patch,
  };
}

const intent: SpeakIntent = {
  shouldSpeak: true,
  reason: 'wants to protect the current target without inheriting their viewpoint',
  target: 'chen',
  stance: 'back_up',
  emotionalTone: 'warm',
  delivery: 'short_reply',
  messageShape: 'single_sentence',
};

const innerLife: InnerLifeProjection = {
  actorId: 'rui',
  impulse: 'seek_attention',
  tone: 'vulnerable',
  reason: '最近发言没有被接住，想确认自己仍被看见。',
  pressure: 0.72,
  evidence: ['最近 3 轮未被明显接住'],
  state: {
    mood: { pleasure: 0, arousal: 20, dominance: 45 },
    energy: 44,
    attention: 58,
    loneliness: 70,
    repression: 20,
    shame: 10,
    envy: 0,
    trustInRoom: 48,
    ignoredStreak: 3,
    updatedAt: 1,
  },
  expressionPlan: { tone: 'vulnerable', length: 'short', messageCount: 1, typoLevel: 0, delayMs: 500, allowWithdraw: false },
};

const movePlan: ConversationMovePlan = {
  speakerId: 'rui',
  targetActorId: 'chen',
  targetClaimText: '这次就按贵的订吧，省得麻烦。',
  moveType: 'add_boundary_condition',
  socialPosture: { warmth: 'warm', directness: 'soft' },
  reason: 'default_room_move',
  confidence: 0.7,
};

const turnPlan: TurnPlan = {
  rhythm: 'short_reply',
  maxBubbleCount: 1,
  lengthBand: 'short',
  allowExtraMessages: false,
  waitSensitive: false,
  reasons: ['test'],
};

describe('turnDirective', () => {
  it('allows a brief reaction without requiring another task or question', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ senderId: 'chen', content: '那就先等信回来。' })],
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });
    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).toContain('A brief acknowledgement can be the whole response');
    expect(prompt).toContain('Do not attach a new condition');
    expect(prompt).toContain('Let a completed exchange rest');
    expect(prompt).toContain('Optional attention cue: if useful, add one condition, cost, or limit that changes the next response');
    expect(prompt).not.toContain('changes the next response to 陈越');
    expect(prompt).toContain('latest speaker is context, not recipient');
    expect(prompt).toContain('do not explain the whole topic');
  });

  it.each([0, 80])('keeps projected topic context at drift %s out of unresolved task assertions', (topicDrift) => {
    const room = chat({ worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE,
      structuredRoomState: { heat: 0, cohesion: 0, topicDrift, dominantThread: [], alliances: [],
        conflictPairs: [], pileOnTarget: null, silencedActors: [] } } });
    const messages = [message({ senderId: 'rui', content: '今天的晚霞好看。' })];
    const directive = buildTurnDirective({ chat: room, speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')], messages,
      intent, innerLife, conversationMovePlan: movePlan, turnPlan,
      narrativeLines: projectNarrativeLines({ chat: room, messages, now: 2 }),
    });
    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).toContain('Background context');
    expect(prompt).not.toContain('unresolved line');
    expect(prompt).not.toContain('Recorded unresolved matter');
    if (topicDrift) {
      expect(prompt).toContain('Possible angle');
      expect(prompt).not.toContain('Recorded open question');
    } else expect(prompt).toContain('今天的晚霞好看');
  });

  it('removes recorded unresolved pressure after a supported resolution while retaining topic context', () => {
    const room = chat({ worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE,
      conversationContinuity: { items: [{ key: 'budget', kind: 'issue', status: 'open',
        summary: '预算上限尚未确定', participantIds: ['rui', 'chen'], evidenceText: '预算多少？',
        sourceMessageIds: ['m0'], updatedAt: 1 }] } } });
    const reply = message({ senderId: 'rui', content: '预算就两百，已经订好了。', timestamp: 2,
      metadata: { conversationUpdate: { items: [{ key: 'budget', kind: 'issue', status: 'resolved',
        summary: '预算确定为两百并完成预订', participantIds: ['rui', 'chen'], evidenceText: '预算就两百，已经订好了。' }] } } });
    const input = { speaker: character('rui', '瑞瑞'), members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [reply], intent, innerLife, conversationMovePlan: movePlan, turnPlan };
    const before = buildTurnDirectivePrompt(buildTurnDirective({ ...input, chat: room,
      narrativeLines: projectNarrativeLines({ chat: room, messages: [reply], now: 2 }) }));
    expect(before).toContain('Recorded unresolved matter');
    const applied = applyConversationUpdate(room, reply, room.worldState.structuredRoomState);
    const resolvedRoom = { ...room, worldState: { ...room.worldState, conversationContinuity: applied.continuity } };
    const after = buildTurnDirectivePrompt(buildTurnDirective({ ...input, chat: resolvedRoom,
      narrativeLines: projectNarrativeLines({ chat: resolvedRoom, messages: [reply], now: 3 }) }));
    expect(after).toContain('Background context');
    expect(after).toContain('issue/resolved');
    expect(after).not.toContain('Recorded unresolved matter');
    expect(after).not.toContain('Recorded open question');
  });

  it('prioritizes an older unfulfilled commitment and releases its narrative pressure after fulfillment', () => {
    const room = chat({ worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE,
      conversationContinuity: { items: [{ key: 'book', kind: 'commitment', status: 'established',
        summary: '瑞瑞答应把书还给陈越', participantIds: ['rui', 'chen'], evidenceText: '书我会还给你',
        sourceMessageIds: ['promise'], updatedAt: 1 },
      ...Array.from({ length: 8 }, (_, index) => ({ key: `done-${index}`, kind: 'decision' as const,
        status: 'established' as const, summary: '今晚在家吃饭', participantIds: ['rui', 'chen'],
        evidenceText: '今晚在家吃饭', sourceMessageIds: [], updatedAt: index + 2 }))] } } });
    const reply = message({ senderId: 'rui', content: '书给你了，夹着的票还在。', timestamp: 20,
      metadata: { conversationUpdate: { items: [{ key: 'book', kind: 'commitment', status: 'resolved',
        summary: '瑞瑞已经把书还给陈越', participantIds: ['rui', 'chen'], evidenceText: '书给你了' }] } } });
    const input = { speaker: character('rui', '瑞瑞'), members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [reply], intent, innerLife, conversationMovePlan: movePlan, turnPlan };
    const before = buildTurnDirective({ ...input, chat: room,
      narrativeLines: projectNarrativeLines({ chat: room, messages: [reply], now: 20 }) });
    expect(before.continuityEvidence?.[0]).toContain('commitment/established: 瑞瑞答应把书还给陈越');
    const beforePrompt = buildTurnDirectivePrompt(before);
    expect(beforePrompt).toContain('已接受，尚未报告兑现');
    expect(beforePrompt).toContain('it does not require action or resolution this turn');
    expect(beforePrompt).toContain('An established commitment or decision is already accepted');
    expect(beforePrompt).toContain('do not ask for acceptance again or restate that acceptance');
    const applied = applyConversationUpdate(room, reply, room.worldState.structuredRoomState);
    const ended = { ...room, worldState: { ...room.worldState, conversationContinuity: applied.continuity } };
    const after = buildTurnDirectivePrompt(buildTurnDirective({ ...input, chat: ended,
      narrativeLines: projectNarrativeLines({ chat: ended, messages: [reply], now: 21 }) }));
    expect(after).toContain('commitment/resolved: 瑞瑞已经把书还给陈越');
    expect(after).not.toContain('已接受，尚未报告兑现');
    expect(after).not.toContain('Recorded unresolved matter');
  });

  it('uses the director focus even for a roomwide line or a speaker outside its participants', () => {
    const focused = { id: 'current', conversationId: 'chat-1', type: 'goal' as const, title: '等授权', summary: '只接受了分工，未决定开战',
      participantIds: ['chen'], visibility: 'public' as const, status: 'active' as const, tension: 0, momentum: 0.5, salience: 0.5,
      sourceEventIds: [], lastTouchedAt: 1, openQuestions: ['何时能动身尚未定'], possibleNextBeats: [] };
    for (const participantIds of [[], ['chen']]) {
      const directive = buildTurnDirective({ chat: chat(), speaker: character('rui', '瑞瑞'),
        members: [character('rui', '瑞瑞'), character('chen', '陈越')], messages: [message()],
        intent, innerLife, conversationMovePlan: movePlan, turnPlan,
        directorIntent: { source: 'conversation_reply', targetLineId: 'current', beatType: 'answer', targetActorIds: ['rui'], pressure: 0.8, reason: '回应债' },
        narrativeLines: [{ ...focused, participantIds }, { ...focused, id: 'unrelated', summary: '另一个更高热度的事项', salience: 0.9, participantIds: ['rui'] },
          { ...focused, id: 'private', summary: '私密事实', visibility: 'pair_private', salience: 1, participantIds: ['rui'] }],
      });
      expect(directive?.narrativePressure).toContain('未决定开战');
      expect(directive?.narrativePressure).not.toContain('私密事实');
      expect(directive?.narrativePressure).not.toContain('另一个');
    }
  });

  it('keeps narrative and topic targets as soft context in ordinary groups', () => {
    const directive = buildTurnDirective({
      chat: chat(), speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')], messages: [message()],
      intent, innerLife, conversationMovePlan: movePlan, turnPlan,
      directorIntent: { source: 'topic', beatType: 'invite', targetActorIds: ['chen'], pressure: 0.4, reason: '继续话题' },
    });
    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).not.toContain('to 陈越');
    expect(prompt).toContain('latest speaker is context, not recipient');
  });
  it('does not prescribe expression from scheduler pressure or planned rhythm', () => {
    const input = {
      chat: chat(), speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message()], styleProfile: 'casual_room', intent,
      innerLife, conversationMovePlan: movePlan, turnPlan,
    };
    const base = buildTurnDirectivePrompt(buildTurnDirective(input));
    const changed = buildTurnDirectivePrompt(buildTurnDirective({
      ...input,
      innerLife: { ...innerLife, pressure: 0, tone: 'casual', impulse: 'stay_silent' },
      turnPlan: { ...turnPlan, rhythm: 'multi_bubble', maxBubbleCount: 4 },
    }));
    expect(changed).toBe(base);
  });

  it('keeps a live dramatic question without requiring every turn to escalate it', () => {
    const directive = buildTurnDirective({
      chat: chat(), speaker: character('rui', '瑞瑞'), members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message()], styleProfile: 'dramatic_room', intent, innerLife, conversationMovePlan: movePlan, turnPlan,
      narrativeLines: [{
        id: 'line-1', conversationId: 'chat-1', type: 'conflict', title: '谁承担代价', summary: '订餐费用让两个人都不愿先松口',
        participantIds: ['rui', 'chen'], visibility: 'public', status: 'active', tension: 0.6, momentum: 0.5, salience: 0.8,
        sourceEventIds: [], lastTouchedAt: 1, openQuestions: ['陈越是否愿意承认瑞瑞的预算顾虑？'], possibleNextBeats: [],
      }],
    });
    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).toContain('陈越是否愿意承认瑞瑞的预算顾虑');
    expect(prompt).toContain('not a quota');
    expect(prompt).not.toContain('make one observable state change');
    expect(prompt).not.toContain('Advancing the task with one more fact or assignment is not enough');
    expect(prompt.length).toBeLessThan(4000);
  });

  it('shares ordinary conversation expression across public and private rooms', () => {
    expect(shouldUseUnifiedTurnDirective(chat())).toBe(true);
    expect(shouldUseUnifiedTurnDirective(chat({ type: 'direct' }))).toBe(true);
    expect(shouldUseUnifiedTurnDirective(chat({ type: 'ai_direct' }))).toBe(true);
    expect(shouldUseUnifiedTurnDirective(chat({
      mode: 'werewolf',
      sessionKind: { topology: 'group', family: 'deduction', scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid' },
    }))).toBe(false);
    expect(shouldUseUnifiedTurnDirective(chat({
      mode: 'group_discussion',
      sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
    }))).toBe(false);
  });

  it('turns backing into independent support instead of forced agreement', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message()],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });

    expect(directive?.targetName).toBe('陈越');
    expect(directive?.socialJob).toContain('condition');
    expect(directive?.relationshipEffect).toContain('not a fixed tone');
    expect(directive?.relationshipEffect).not.toContain('warm warmth');
    expect(directive?.relationshipEffect).toContain('relational consequence');
    expect(directive?.situationalConstraints).toEqual([]);
    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).toContain('Speak as this person among people who share this exchange');
    expect(prompt).toContain('not an assigned recipient');
    expect(prompt).not.toContain('live attention is on');
    expect(prompt).not.toContain('Active target: 陈越');
  });

  it('marks an ordinary group cue as optional so a landed exchange does not become a task', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ senderId: 'chen', content: '这事先这样，回头再看。' })],
      intent: { ...intent, target: undefined, stance: 'side_comment' },
      innerLife,
      conversationMovePlan: { ...movePlan, targetActorId: 'chen', moveType: 'react_lightly', reason: 'default_room_move' },
      turnPlan,
    });

    expect(directive?.socialJobRequired).toBe(false);
    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).toContain('Optional attention cue');
    expect(prompt).toContain('if useful');
    expect(prompt).toContain('no new point is valid');
    expect(prompt).not.toContain('- Live:');
  });

  it('keeps a hard pending reply as a real live obligation', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ senderId: 'chen', content: '瑞瑞，你现在给个准话。' })],
      intent,
      innerLife,
      conversationMovePlan: { ...movePlan, reason: 'pending_direct_address' },
      turnPlan,
    });

    expect(directive?.socialJobRequired).toBe(true);
    expect(buildTurnDirectivePrompt(directive)).toContain('- Live:');
  });

  it('projects structured room atmosphere into ordinary group turns without assigning a speaker', () => {
    const directive = buildTurnDirective({
      chat: chat({ worldState: {
        ...DEFAULT_CONVERSATION_WORLD_STATE,
        structuredRoomState: {
          heat: 72,
          cohesion: -28,
          topicDrift: 24,
          dominantThread: ['rui', 'chen'],
          alliances: [['rui', 'chen']],
          conflictPairs: [['rui', 'chen']],
          pileOnTarget: 'chen',
          silencedActors: ['rui'],
        },
      } }),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message()],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });
    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).toContain('Room atmosphere:');
    expect(prompt).toContain('房间气氛偏紧');
    expect(prompt).toContain('陈越正承受多人注意');
    expect(prompt).toContain('not a speaking order');
    expect(prompt).not.toContain('必须由');
  });

  it('keeps planning labels out of the visible dialogue contract', () => {
    const prompt = buildTurnDirectivePrompt({
      roomStyle: 'casual',
      characterDrive: {
        stake: '不想让对方一个人扛着',
        feltReaction: '有点心软又嘴硬',
        attentionLens: '对方话里的犹豫',
        relationalAction: 'situated',
        observableMove: '问一句具体的近况',
        speakingNecessity: 'optional',
        evidence: ['对方话里的犹豫'],
      },
      socialJob: 'show social support while keeping independent judgment',
      emotionalUndercurrent: 'subtle: protective warmth',
      relationshipEffect: 'treat the relationship as evidence',
      requiredChange: 'a specific reaction is enough',
      expressionShape: 'ordinary wording',
      situationalConstraints: [],
      forbiddenDrift: [],
    });

    expect(prompt).toContain('private context, not dialogue');
    expect(prompt).toContain('Choose what catches their attention');
    expect(prompt).not.toContain('先接住/我来回应/这句我认');
    expect(prompt).toContain('warmth, bite, hesitation or delight');
    expect(prompt).not.toContain('Do not manufacture a second point');
    expect(prompt.length).toBeLessThan(1550);
  });

  it('treats scalar social posture as subordinate to concrete relationship evidence', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message()],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });

    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).toContain('relationship continuity');
    expect(prompt).toContain('not a fixed tone');
    expect(prompt).not.toContain('warm warmth and soft directness');
  });

  it('does not promote scheduler face-saving estimates to observed emotion', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message()],
      styleProfile: 'casual_room',
      intent,
      innerLife: { ...innerLife, impulse: 'defend_face', tone: 'defensive', pressure: 0.86 },
      conversationMovePlan: movePlan,
      turnPlan,
    });

    expect(buildTurnDirectivePrompt(directive)).not.toContain('visible: saving face');
    expect(buildTurnDirectivePrompt(directive)).not.toContain('answer because addressed');
    expect(buildTurnDirectivePrompt(directive)).not.toContain('opening beat');
  });

  it('does not treat an unrecorded emotion as proof that the live exchange is neutral', () => {
    const calmInnerLife: InnerLifeProjection = {
      ...innerLife,
      impulse: 'stay_silent',
      tone: 'casual',
      reason: '没有强触发。',
      pressure: 0.24,
      evidence: [],
      activeAffect: null,
      dominantEmotion: null,
    };
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ content: '你刚才当着所有人的面说我只会添乱。' })],
      styleProfile: 'casual_room',
      intent,
      innerLife: calmInnerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });
    const prompt = buildTurnDirectivePrompt(directive);

    expect(directive?.emotionalUndercurrent).toContain('no strong carried feeling is currently recorded');
    expect(directive?.emotionalUndercurrent).not.toContain('low internal pressure');
    expect(prompt).toContain('not a verdict on the live exchange');
    expect(prompt).toContain('the exchange decides the shape');
    expect(prompt).toContain('warmth, bite, hesitation or delight');
  });

  it('keeps calm turns emotionally legible through personality and relationship', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞', {
        speakingStyle: '真正担心时会先挖苦一句。',
        coreProfile: { coreDesire: '不让朋友独自承担代价' },
      }),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ content: '那就按贵的订吧，省得麻烦。' })],
      styleProfile: 'casual_room',
      intent: { ...intent, emotionalTone: 'warm' },
      innerLife: { ...innerLife, pressure: 0.24, impulse: 'stay_silent', tone: 'casual', activeAffect: null, dominantEmotion: null },
      conversationMovePlan: { ...movePlan, socialPosture: { warmth: 'warm', directness: 'soft' } },
      turnPlan,
    });
    const prompt = buildTurnDirectivePrompt(directive);

    expect(directive?.requiredChange).toContain('no mandatory plot or task change');
    expect(prompt).toContain('Speak as this person among people who share this exchange');
    expect(prompt).toContain('the exchange decides the shape');
  });

  it('keeps user guidance above AI-to-AI room momentum', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ type: 'user', senderId: 'user', content: '预算别超过 200。' })],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
      userGuidance: {
        kind: 'topic_shift',
        rawText: '预算别超过 200。',
        actorIds: ['rui'],
        mentionedActorIds: ['rui'],
        focusText: '预算别超过 200。',
        beatType: 'invite',
        pressure: 0.9,
        maxTurns: 4,
        reason: '用户给出预算约束。',
        hasHardConstraints: true,
      },
    });

    expect(directive?.userConstraint).toContain('user steered the topic');
    expect(buildTurnDirectivePrompt(directive)).toContain('User constraint');
    expect(directive?.situationalConstraints.join('\n')).toContain('explicitly apply that constraint');
  });

  it('projects core profile and relationship stakes ahead of the generic social job', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞', { coreProfile: {
        coreDesire: '不让朋友在众人面前被当成可牺牲的那一个',
        interactionHabits: ['先看谁在替别人吞下代价'],
      }, relationships: [{ characterId: 'chen', warmth: 30, trust: 24, competence: 10, threat: 4 }] }),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')], messages: [message()], styleProfile: 'casual_room', intent, innerLife, conversationMovePlan: movePlan, turnPlan,
    });
    const prompt = buildTurnDirectivePrompt(directive);

    expect(prompt).toContain('不让朋友在众人面前被当成可牺牲的那一个');
    expect(prompt).toContain('先看谁在替别人吞下代价');
    expect(prompt).toContain('Relationship context:');
    expect(prompt).toContain('warmth 30');
    expect(prompt).toContain('Personal meaning:');
    expect(prompt).toContain('Standing desire:');
    expect(prompt).not.toContain('They may want to');
    expect(prompt).not.toContain('while risking');
  });

  it('turns shared history into subjective meaning instead of a required-move checklist', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞', {
        speakingStyle: '真正担心时会先挖苦一句。',
        coreProfile: { coreDesire: '确认朋友没在硬撑', coreFear: '把关心说得太肉麻' },
        relationships: [{
          characterId: 'chen',
          warmth: 72,
          competence: 40,
          trust: 68,
          threat: 0,
          attachment: 55,
          note: '记得陈越上次嘴上说没事，后来一个人在楼下坐到天亮。',
        }],
      }),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ content: '没事，你们先睡吧。' })],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });
    const prompt = buildTurnDirectivePrompt(directive);

    expect(prompt).toContain('一个人在楼下坐到天亮');
    expect(prompt).toContain('Speak as this person among people who share this exchange');
    expect(prompt).toContain('what they actually want to say now');
    expect(prompt).not.toContain('make it visible as');
    expect(prompt).not.toContain('Required state change:');
  });

  it('keeps user decision pressure ahead of AI-to-AI logistics', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [
        message({
          type: 'user',
          senderId: 'user',
          senderName: '用户',
          content: '周五想找个像精酿吧一样热闹、有木桌和音乐的地方，你们帮我选。',
        }),
        message({ id: 'm2', senderId: 'chen', senderName: '陈越', content: '北门那家要先问低消。', timestamp: 2 }),
      ],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
      userGuidance: {
        kind: 'topic_shift',
        rawText: '周五想找个像精酿吧一样热闹、有木桌和音乐的地方，你们帮我选。',
        actorIds: [],
        mentionedActorIds: [],
        focusText: '帮我选热闹的地方',
        beatType: 'invite',
        pressure: 0.78,
        maxTurns: 4,
        reason: '用户要求群聊给出选择。',
      },
    });

    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).not.toContain('state one concrete preference or shortlist first');
    expect(prompt).not.toContain('do not pass the choice back to the room');
  });

  it('does not repeat broad clarification after a user asked the room to choose', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [
        message({
          type: 'user',
          senderId: 'user',
          senderName: '用户',
          content: '周五想找个像精酿吧一样热闹、有木桌和音乐的地方，你们帮我选。',
        }),
        message({ id: 'm2', senderId: 'chen', senderName: '陈越', content: '你先说你要的是哪种闹？', timestamp: 2 }),
      ],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });

    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).not.toContain('previous AI already pushed a broad clarification');
    expect(prompt).not.toContain('add a concrete option');
  });

  it('folds situational floor and handoff pressure into the directive', () => {
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [
        message({ type: 'ai', senderId: 'rui', senderName: '瑞瑞', content: '那先别定。' }),
        message({ id: 'm2', type: 'user', senderId: 'user', senderName: '用户', content: '陈越，你怎么看？我想听你的意见。', timestamp: 2 }),
      ],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });

    expect(directive?.situationalConstraints.join('\n')).not.toContain('name someone else');
    expect(directive?.situationalConstraints.join('\n')).not.toContain('short clean handoff');
    expect(directive?.situationalConstraints.join('\n')).toContain('recent own visible line');
    expect(buildTurnDirectivePrompt(directive)).toContain('Situational constraints');
  });

  it.each(['open', 'established'] as const)('keeps %s evidence without assigning a task from prior speech', (status) => {
    const directive = buildTurnDirective({
      chat: chat({ worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE, conversationContinuity: {
        items: [{ key: 'foundation', kind: 'decision', status, summary: '先守住新野',
          evidenceText: '先守住新野', participantIds: ['rui', 'chen'], updatedAt: 2, sourceMessageIds: ['m1'] }],
      } } }),
      speaker: character('rui', '瑞瑞'), members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ senderId: 'rui', content: '先守住新野' }), message({ id: 'm2', timestamp: 2 })],
      intent, innerLife, conversationMovePlan: movePlan, turnPlan,
    });
    const prompt = buildTurnDirectivePrompt(directive);
    expect(prompt).toContain(`${status}: 先守住新野`);
    expect(prompt).toContain('recent own visible line');
    expect(prompt).not.toContain('preserve the current unresolved need');
    expect(prompt).not.toContain('do not switch to a fresh logistical action');
  });

  it('does not treat old own messages as recent after other speakers have moved on', () => {
    const directive = buildTurnDirective({
      chat: chat(), speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message({ senderId: 'rui' }), ...[2, 3, 4].map((index) => message({
        id: `m${index}`, timestamp: index,
      })), message({ id: 'deleted', senderId: 'rui', isDeleted: true }),
      message({ id: 'event', type: 'event' })],
      intent, innerLife, conversationMovePlan: movePlan, turnPlan,
    });
    expect(directive?.situationalConstraints).toEqual([]);
  });

  it('does not expose raw runtime field names in the visible prompt block', () => {
    const prompt = buildTurnDirectivePrompt(buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message()],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
      runtimeBundle: { trace: { hotspotState: 'hot' } } as never,
    }));

    expect(prompt).not.toContain('impulse:');
    expect(prompt).not.toContain('pressure:');
    expect(prompt).not.toContain('policyHits');
    expect(prompt).toContain('private context, not dialogue');
    expect(prompt).toContain('including earlier unfinished moments');
  });

  it('does not prescribe reply length or addressing from recent character counts', () => {
    const longLine = '这件事如果认真讲，'.repeat(24);
    const directive = buildTurnDirective({
      chat: chat(),
      speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [
        message({ id: 'm1', type: 'ai', senderId: 'rui', senderName: '瑞瑞', content: `陈越，${longLine}`, timestamp: 1 }),
        message({ id: 'm2', type: 'ai', senderId: 'chen', senderName: '陈越', content: `瑞瑞，${longLine}`, timestamp: 2 }),
        message({ id: 'm3', type: 'ai', senderId: 'rui', senderName: '瑞瑞', content: `陈越，${longLine}`, timestamp: 3 }),
      ],
      styleProfile: 'casual_room',
      intent,
      innerLife,
      conversationMovePlan: movePlan,
      turnPlan,
    });
    const constraints = directive?.situationalConstraints.join('\n') || '';

    expect(constraints).not.toContain('recent room replies are getting long');
    expect(constraints).not.toContain('chars');
    expect(constraints).not.toContain('overusing visible name-addressing');
    expect(buildTurnDirectivePrompt(directive)).toContain('Situational constraints');
  });

  it('does not turn projected relationship axes into an unresolved plot question', () => {
    const input = {
      chat: chat(), speaker: character('rui', '瑞瑞'),
      members: [character('rui', '瑞瑞'), character('chen', '陈越')],
      messages: [message()], styleProfile: 'casual_room', intent,
      innerLife, conversationMovePlan: movePlan, turnPlan,
    };
    const baseline = buildTurnDirectivePrompt(buildTurnDirective(input));
    const projected = buildTurnDirectivePrompt(buildTurnDirective({
      ...input,
      narrativeLines: [{
        id: 'relationship:rui->chen', conversationId: 'chat-1', type: 'relationship',
        title: '瑞瑞与陈越', summary: '亲和偏高，信任偏高。',
        participantIds: ['rui', 'chen'], visibility: 'public', status: 'active',
        tension: 0, momentum: 0.5, salience: 0.9, sourceEventIds: [], lastTouchedAt: 1,
        openQuestions: ['瑞瑞会保护陈越、暴露偏心，还是因在意而要求更多？'],
        possibleNextBeats: [],
      }],
    }));
    expect(projected).toBe(baseline);
  });
});
