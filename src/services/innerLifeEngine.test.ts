import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';
import type { GroupChat } from '../types/chat';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { buildInnerLifeMetadata, buildInnerLifePromptBlock, getInnerLifeSpeakerBias, projectInnerLife } from './innerLifeEngine';

function character(patch: Partial<AICharacter> = {}): AICharacter {
  return {
    id: 'a',
    name: '小甲',
    avatar: '',
    personality: { openness: 50, extroversion: 60, agreeableness: 45, neuroticism: 40, humor: 50, creativity: 50, assertiveness: 55, empathy: 55 },
    behavior: { proactivity: 65, aggressiveness: 35, humorIntensity: 45, empathyLevel: 55, summarizing: 30, offTopic: 20 },
    expertise: ['蛋糕'],
    speakingStyle: '短句，爱吐槽',
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

function message(patch: Partial<Message>): Message {
  return {
    id: patch.id || 'm',
    chatId: 'c',
    type: patch.type || 'ai',
    senderId: patch.senderId || 'b',
    senderName: patch.senderName || '小乙',
    content: patch.content || '',
    emotion: 0,
    timestamp: patch.timestamp || 1,
    isDeleted: false,
    ...patch,
  };
}

function addressedMessage(patch: Partial<Message>): Message {
  return {
    ...message(patch),
    addressedTargetIds: ['a'],
    primaryAddressedTargetId: 'a',
  };
}

function roomWithInteraction(kind: 'challenge' | 'support', actorId: string, targetId: string, createdAt = 2, intensity = 5): GroupChat {
  return {
    runtimeEventsV2: [{
      id: 'interaction-1', conversationId: 'c', kind: 'interaction', createdAt,
      actorIds: [actorId], targetIds: [targetId], summary: 'directed turn',
      payload: { kind, actorId, targetId, intensity, tone: kind === 'challenge' ? 'annoyed' : 'warm', evidenceText: 'directed turn', confidence: 0.95 },
    } satisfies RuntimeEventV2],
  } as GroupChat;
}

describe('innerLifeEngine', () => {
  it('keeps suggested rhythm distinct from the messages actually emitted', () => {
    const projection = projectInnerLife({ character: character(), messages: [message({ content: '小甲，你怎么看？' })], now: 10 });
    const metadata = buildInnerLifeMetadata(projection, 3);
    expect(metadata?.expressionPlan?.suggestedMessageCount).toBe(projection.expressionPlan.messageCount);
    expect(metadata?.expressionPlan?.messageCount).toBe(3);
  });
  it('projects answer impulse when the character is addressed', () => {
    const projection = projectInnerLife({
      character: character(),
      messages: [addressedMessage({ content: '小甲，你怎么看这个蛋糕？' })],
      now: 10,
    });

    expect(projection.impulse).toBe('answer');
    expect(projection.pressure).toBeGreaterThan(0.8);
    expect(projection.evidence.join(' / ')).toContain('直接提到');
  });

  it.each([null, []])('does not turn an addressed answer into reply pressure when debt is %s', (replyDebtTargetIds) => {
    const projection = projectInnerLife({ character: character(), now: 10,
      messages: [addressedMessage({ senderId: 'b', type: 'ai',
        content: '工时费可能比衣服还贵。', replyDebtTargetIds })],
    });
    expect(projection.impulse).not.toBe('answer');
    expect(projection.evidence.join(' / ')).not.toContain('尚未回应');
  });

  it('honors explicit reply debt even without an addressed-target field', () => {
    const projection = projectInnerLife({ character: character(), now: 10,
      messages: [message({ senderId: 'b', type: 'ai', content: '你来决定。', replyDebtTargetIds: ['a'] })],
    });
    expect(projection.impulse).toBe('answer');
  });

  it('does not restore reply pressure from the last other message after an answer', () => {
    const projection = projectInnerLife({ character: character(), now: 10,
      messages: [addressedMessage({ senderId: 'b', content: '要不要改？', timestamp: 1 }),
        message({ senderId: 'a', type: 'ai', content: '不改了。', timestamp: 2 })],
    });
    expect(projection.impulse).not.toBe('answer');
  });

  it('does not leave a pressured direct human address as casual inner tone', () => {
    const projection = projectInnerLife({
      character: character(),
      messages: [message({ type: 'user', senderId: 'user', senderName: '我', content: '小甲，你现在就解释清楚。' })],
      explicitUserAddressed: true,
      now: 10,
    });

    expect(projection.tone).toBe('serious');
    expect(projection.evidence.join(' / ')).toContain('即时回应压力');
  });

  it('does not treat a narrative mention as a direct address', () => {
    const projection = projectInnerLife({
      character: character({ behavior: { proactivity: 20, aggressiveness: 20, humorIntensity: 20, empathyLevel: 30, summarizing: 20, offTopic: 5 } }),
      messages: [message({
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '闻溪刚才先问了小甲，却完全没问许棠。',
      })],
      now: 10,
    });

    expect(projection.impulse).not.toBe('answer');
    expect(projection.evidence.join(' / ')).not.toContain('直接点名');
  });

  it('does not flatten a high-pressure answer to another character into casual tone', () => {
    const projection = projectInnerLife({
      character: character(),
      messages: [addressedMessage({ senderId: 'b', senderName: '小乙', content: '小甲，这件事你现在给我一个交代。' })],
      now: 10,
    });

    expect(projection.impulse).toBe('answer');
    expect(projection.pressure).toBeGreaterThan(0.8);
    expect(projection.tone).toBe('serious');
  });

  it('lets pressure from a close relationship expose vulnerability instead of generic seriousness', () => {
    const projection = projectInnerLife({
      character: character({
        relationships: [{ characterId: 'b', warmth: 72, trust: 60, competence: 40, threat: 8, attachment: 68, deference: 0 }],
      }),
      messages: [addressedMessage({ senderId: 'b', senderName: '小乙', content: '小甲，你是真的不在意我怎么想吗？' })],
      now: 10,
    });

    expect(projection.impulse).toBe('answer');
    expect(projection.tone).toBe('vulnerable');
  });

  it('makes a medium model-judged support event visible on the next turn', () => {
    const projection = projectInnerLife({
      chat: roomWithInteraction('support', 'b', 'a', 2, 2),
      character: character({
        emotionalState: { affection: 16, irritation: 0, insecurity: 0, excitement: 6, embarrassment: 0 },
      }),
      messages: [message({ senderId: 'b', senderName: '小乙', content: '这次我站你这边。', timestamp: 2 })],
      now: 3,
    });

    expect(projection.activeAffect?.pressure).toBeCloseTo(0.4);
    expect(projection.impulse).toBe('answer');
    expect(projection.tone).toBe('vulnerable');
  });

  it('keeps an unanswered human address active when a later room message intervenes', () => {
    const projection = projectInnerLife({
      character: character(),
      messages: [
        message({ id: 'own', senderId: 'a', senderName: '小甲', content: '我先听着', timestamp: 1 }),
        addressedMessage({ id: 'user', type: 'user', senderId: 'user', senderName: '我', content: '小甲，你别躲，解释清楚。', timestamp: 2 }),
        message({ id: 'other', senderId: 'b', senderName: '小乙', content: '我也想听。', timestamp: 3 }),
      ],
      now: 10,
    });

    expect(projection.impulse).toBe('answer');
    expect(projection.tone).toBe('serious');
    expect(projection.evidence.join(' / ')).toContain('尚未回应');
  });

  it('clears an earlier address after the character has answered', () => {
    const projection = projectInnerLife({
      character: character({ behavior: { proactivity: 20, aggressiveness: 35, humorIntensity: 45, empathyLevel: 55, summarizing: 30, offTopic: 20 } }),
      messages: [
        message({ id: 'user', type: 'user', senderId: 'user', senderName: '我', content: '小甲，你解释清楚。', timestamp: 1 }),
        message({ id: 'own', senderId: 'a', senderName: '小甲', content: '我已经说完了。', timestamp: 2 }),
        message({ id: 'other', senderId: 'b', senderName: '小乙', content: '那先这样。', timestamp: 3 }),
      ],
      now: 10,
    });

    expect(projection.evidence.join(' / ')).not.toContain('尚未回应');
    expect(projection.tone).toBe('casual');
  });

  it('maps proactive low-humor authority to taking control instead of showing off', () => {
    const projection = projectInnerLife({
      character: character({
        personality: { openness: 42, extroversion: 38, agreeableness: 30, neuroticism: 22, humor: 12, creativity: 35, assertiveness: 92, empathy: 46 },
        behavior: { proactivity: 78, aggressiveness: 38, humorIntensity: 8, empathyLevel: 45, summarizing: 34, offTopic: 4 },
      }),
      messages: [message({ senderId: 'b', senderName: '小乙', content: '卷上只记了未报。' })],
      now: 10,
    });

    expect(projection.impulse).toBe('take_control');
    expect(projection.tone).toBe('serious');
    expect(projection.reason).toContain('接管场面');
  });

  it('raises attention-seeking pressure after ignored turns', () => {
    const projection = projectInnerLife({
      character: character(),
      messages: [
        message({ id: 'own', senderId: 'a', senderName: '小甲', content: '我刚刚说的也不是没道理吧', timestamp: 1 }),
        message({ id: 'b1', senderId: 'b', content: '换个话题', timestamp: 2 }),
        message({ id: 'b2', senderId: 'c', content: '嗯嗯', timestamp: 3 }),
      ],
      now: 20,
    });

    expect(projection.state.ignoredStreak).toBeGreaterThan(0);
    expect(projection.state.loneliness).toBeGreaterThanOrEqual(20);
    expect(projection.impulse).not.toBe('seek_attention');
    expect(getInnerLifeSpeakerBias(projection).reason).toMatch(/^inner:/);
  });

  it('does not mistake a directed reply without a name for being ignored', () => {
    const projection = projectInnerLife({
      character: character(),
      messages: [
        message({ id: 'own', senderId: 'a', content: '我走河边那条路。', timestamp: 1 }),
        addressedMessage({ id: 'reply', senderId: 'b', content: '那条路晚上有灯吗？', timestamp: 2 }),
        message({ id: 'other', senderId: 'c', content: '我也想知道。', timestamp: 3 }),
      ],
      now: 20,
    });

    expect(projection.state.ignoredStreak).toBe(0);
    expect(projection.evidence.join(' / ')).not.toContain('未被明显接住');
  });

  it('does not infer exclusion from one intervening turn', () => {
    const projection = projectInnerLife({
      character: character(),
      messages: [
        message({ id: 'own', senderId: 'a', content: '我先去看一下。', timestamp: 1 }),
        message({ id: 'other', senderId: 'b', content: '门还开着。', timestamp: 2 }),
      ],
      now: 20,
    });

    expect(projection.state.ignoredStreak).toBe(0);
  });

  it('keeps neutral room safety stable across repeated ordinary exchanges', () => {
    let actor = character({ personality: { ...character().personality, agreeableness: 50 } });
    for (let turn = 0; turn < 20; turn += 1) {
      const projection = projectInnerLife({ character: actor, messages: [], now: turn });
      actor = { ...actor, soulState: projection.state };
    }
    expect(actor.soulState?.trustInRoom).toBeGreaterThanOrEqual(49);
    expect(actor.soulState?.trustInRoom).toBeLessThanOrEqual(51);
  });

  it('turns a sustained ignored streak into an observable attention-seeking impulse', () => {
    const projection = projectInnerLife({
      character: character({
        soulState: {
          mood: { pleasure: -10, arousal: 20, dominance: 40 },
          energy: 50,
          attention: 45,
          loneliness: 65,
          repression: 8,
          shame: 4,
          envy: 0,
          trustInRoom: 50,
          ignoredStreak: 3,
        },
      }),
      messages: [
        message({ id: 'own', senderId: 'a', senderName: '小甲', content: '我其实很想把这件事说完。', timestamp: 1 }),
        message({ id: 'b1', senderId: 'b', content: '先不聊这个。', timestamp: 2 }),
        message({ id: 'b2', senderId: 'c', content: '换个话题吧。', timestamp: 3 }),
        message({ id: 'b3', senderId: 'b', content: '有人看球吗？', timestamp: 4 }),
        message({ id: 'b4', senderId: 'c', content: '看了，挺精彩。', timestamp: 5 }),
      ],
      now: 20,
    });

    expect(projection.state.ignoredStreak).toBe(4);
    expect(projection.state.loneliness).toBeGreaterThanOrEqual(62);
    expect(projection.impulse).toBe('seek_attention');
    expect(projection.expressionPlan.length).toBe('short');
    expect(getInnerLifeSpeakerBias(projection).bias).toBeGreaterThan(0);
  });

  it('lets direct address override competing inner pressures', () => {
    const projection = projectInnerLife({
      character: character({
        emotionalState: { affection: 10, irritation: 90, insecurity: 80, excitement: 5, embarrassment: 90 },
        soulState: {
          mood: { pleasure: -80, arousal: 70, dominance: 20 },
          energy: 18,
          attention: 10,
          loneliness: 90,
          repression: 90,
          shame: 90,
          envy: 30,
          trustInRoom: 15,
          ignoredStreak: 4,
        },
      }),
      messages: [addressedMessage({ content: '小甲，你必须回答这个问题。', senderId: 'b' })],
      now: 20,
    });

    expect(projection.impulse).toBe('answer');
    expect(projection.pressure).toBeGreaterThan(0.8);
    expect(projection.expressionPlan.allowWithdraw).toBe(true);
  });

  it('carries a sudden emotion into the tone of an answer without making it a permanent trait', () => {
    const upset = character({
      emotionalState: { affection: 2, irritation: 68, insecurity: 15, excitement: 0, embarrassment: 4 },
    });
    const addressed = projectInnerLife({ character: upset, messages: [addressedMessage({ content: '小甲，你真的没意见？' })], now: 20 });
    const unaddressed = projectInnerLife({ character: upset, messages: [message({ content: '这件事之后再说。' })], now: 20 });

    expect(addressed.impulse).toBe('answer');
    expect(addressed.tone).toBe('defensive');
    expect(unaddressed.tone).toBe('casual');
  });

  it('keeps direct pressure from a superior ahead of generic emotional tone', () => {
    const projection = projectInnerLife({
      character: character({
        relationships: [{ characterId: 'b', warmth: 0, trust: 30, competence: 55, threat: 5, deference: 60 }],
        emotionalState: { affection: 2, irritation: 62, insecurity: 8, excitement: 0, embarrassment: 4 },
      }),
      messages: [addressedMessage({ content: '小甲，你来解释。' })],
      now: 20,
    });

    expect(projection.impulse).toBe('answer');
    expect(projection.tone).toBe('serious');
  });

  it('uses low energy and low room trust to produce a short avoidance plan', () => {
    const projection = projectInnerLife({
      character: character({
        behavior: { proactivity: 20, aggressiveness: 20, humorIntensity: 20, empathyLevel: 30, summarizing: 20, offTopic: 5 },
        soulState: {
          mood: { pleasure: -50, arousal: 10, dominance: 25 },
          energy: 8,
          attention: 20,
          loneliness: 10,
          repression: 20,
          shame: 10,
          envy: 0,
          trustInRoom: 12,
          ignoredStreak: 0,
        },
      }),
      messages: [message({ content: '你怎么看？', senderId: 'b' })],
      now: 20,
    });

    expect(projection.impulse).toBe('avoid');
    expect(projection.expressionPlan.length).toBe('micro');
    expect(projection.expressionPlan.tone).toBe('tired');
    expect(projection.expressionPlan.allowWithdraw).toBe(false);
  });

  it('uses shame and repression to make an unaddressed character protect face', () => {
    const projection = projectInnerLife({
      character: character({
        emotionalState: { affection: 10, irritation: 10, insecurity: 90, excitement: 10, embarrassment: 90 },
        soulState: {
          mood: { pleasure: -30, arousal: 50, dominance: 35 },
          energy: 48,
          attention: 45,
          loneliness: 0,
          repression: 80,
          shame: 85,
          envy: 0,
          trustInRoom: 55,
          ignoredStreak: 0,
        },
      }),
      messages: [message({ content: '我倒觉得这个方案还有得商量。', senderId: 'b' })],
      now: 20,
    });

    expect(projection.impulse).toBe('defend_face');
    expect(projection.expressionPlan.tone).toBe('defensive');
    expect(projection.expressionPlan.allowWithdraw).toBe(true);
  });

  it('does not assign a global emotion to the latest person without a directed event', () => {
    const projection = projectInnerLife({
      character: character({
        emotionalState: { affection: 4, irritation: 38, insecurity: 9, excitement: 2, embarrassment: 6 },
      }),
      messages: [message({ content: '这件事就这么算了。', senderId: 'b' })],
      now: 20,
    });

    expect(projection.dominantEmotion).toMatchObject({ kind: 'irritation', value: 38 });
    expect(projection.impulse).toBe('stay_silent');
    expect(projection.activeAffect).toBeNull();
  });

  it('does not turn relationship intensity into a locally prescribed mocking impulse', () => {
    const projection = projectInnerLife({
      character: character({
        relationships: [{ characterId: 'b', warmth: -60, trust: -50, competence: 10, threat: 60 }],
        emotionalState: { affection: 0, irritation: 8, insecurity: 0, excitement: 0, embarrassment: 0 },
      }),
      messages: [message({ content: '这件事我会处理。', senderId: 'b' })],
      now: 20,
    });

    expect(projection.impulse).not.toBe('mock');
    expect(projection.reason).not.toContain('关系张力');
  });

  it('projects repair impulse after a sharp previous message leaves residue', () => {
    const projection = projectInnerLife({
      character: character({
        emotionalState: { affection: 20, irritation: 10, insecurity: 40, excitement: 10, embarrassment: 55 },
        soulState: {
          mood: { pleasure: -10, arousal: 40, dominance: 35 },
          energy: 50,
          attention: 50,
          loneliness: 10,
          repression: 58,
          shame: 60,
          envy: 0,
          trustInRoom: 55,
          ignoredStreak: 0,
        },
      }),
      chat: roomWithInteraction('challenge', 'a', 'b', 1),
      messages: [
        message({ id: 'own', senderId: 'a', senderName: '小甲', content: '不是，你这也太离谱了吧', timestamp: 1 }),
        message({ id: 'b1', senderId: 'b', content: '行，当我没说', timestamp: 2 }),
      ],
      now: 30,
    });

    expect(projection.impulse).toBe('repair');
    expect(projection.reason).toContain('找补');
    expect(projection.evidence.join(' / ')).toContain('修复压力');
  });

  it('keeps a sudden emotional impact attached to its source when a third person interrupts', () => {
    const chat = roomWithInteraction('challenge', 'b', 'a');
    const messages = [
      message({ id: 'b', senderId: 'b', timestamp: 2, content: '你之前做错了。' }),
      message({ id: 'c', senderId: 'c', timestamp: 3, content: '外面下雨了。' }),
    ];
    const projection = projectInnerLife({ chat, character: character({
      emotionalState: { irritation: 70, affection: 0, insecurity: 10, excitement: 0, embarrassment: 0 },
    }), messages, now: 4 });

    expect(projection.activeAffect).toMatchObject({ counterpartId: 'b', role: 'received', age: 1 });
    expect(projection.activeAffect?.pressure).toBeGreaterThan(0.7);
    expect(projection.impulse).toBe('defend_face');
  });

  it('releases expressed pressure while retaining directed residue until it fades', () => {
    const chat = roomWithInteraction('challenge', 'a', 'b');
    const messages = [message({ id: 'a', senderId: 'a', timestamp: 2, content: '我不同意。' })];
    const fresh = projectInnerLife({ chat, character: character(), messages, now: 3 });
    const later = projectInnerLife({ chat, character: character(), messages: [
      ...messages,
      ...Array.from({ length: 6 }, (_, index) => message({ id: `m-${index}`, senderId: 'c', timestamp: index + 3, content: '继续讨论。' })),
    ], now: 10 });

    expect(fresh.activeAffect).toMatchObject({ counterpartId: 'b', role: 'expressed' });
    expect(fresh.activeAffect?.pressure).toBeLessThan(0.5);
    expect(later.activeAffect).toBeNull();
  });

  it('uses expression feedback memories to tighten assistant-like expression plans', () => {
    const projection = projectInnerLife({
      character: character({
        layeredMemories: [{
          id: 'fb-1',
          scope: 'character_self',
          layer: 'episodic',
          kind: 'taboo',
          ownerId: 'a',
          text: '用户反馈：这类回复太像通用助手，后续要减少中立总结、服务式措辞和标准答案腔',
          evidenceText: '作为一个AI助手，我建议你可以从以下几点开始。',
          salience: 0.8,
          confidence: 0.82,
          recency: 0.9,
          reinforcementCount: 1,
          sourceEventIds: ['fb'],
          sourceTag: 'expression_feedback',
          createdAt: 1,
          updatedAt: 1,
        }],
        behavior: { proactivity: 80, aggressiveness: 35, humorIntensity: 45, empathyLevel: 55, summarizing: 30, offTopic: 20 },
      }),
      messages: [message({ content: '你来解释一下？', senderId: 'b' })],
      now: 40,
    });

    expect(projection.expressionPlan.messageCount).toBe(1);
    expect(projection.expressionPlan.length).not.toBe('normal');
    expect(projection.expressionPlan.tone).toBe('casual');
    expect(projection.evidence.join(' / ')).toContain('用户表达反馈记忆');
  });

  it('uses repeated length feedback as a stronger shortening signal', () => {
    const projection = projectInnerLife({
      character: character({
        layeredMemories: [
          {
            id: 'fb-1',
            scope: 'character_self',
            layer: 'working',
            kind: 'trait_evidence',
            ownerId: 'a',
            text: '用户反馈：这类回复偏长，后续除非任务明确需要长文，否则应更克制、更像即时聊天',
            salience: 0.82,
            confidence: 0.86,
            recency: 0.9,
            reinforcementCount: 2,
            sourceEventIds: ['fb-1'],
            sourceTag: 'expression_feedback',
            createdAt: 1,
            updatedAt: 2,
          },
          {
            id: 'fb-2',
            scope: 'character_self',
            layer: 'working',
            kind: 'trait_evidence',
            ownerId: 'a',
            text: '用户反馈：这类回复太长，需要更像即时聊天',
            salience: 0.8,
            confidence: 0.84,
            recency: 0.9,
            reinforcementCount: 1,
            sourceEventIds: ['fb-2'],
            sourceTag: 'expression_feedback',
            createdAt: 2,
            updatedAt: 3,
          },
        ],
        behavior: { proactivity: 80, aggressiveness: 35, humorIntensity: 45, empathyLevel: 55, summarizing: 30, offTopic: 20 },
      }),
      messages: [message({ content: '说说你的看法', senderId: 'b' })],
      now: 50,
    });

    expect(projection.impulse).toBe('show_off');
    expect(projection.expressionPlan.length).toBe('short');
    expect(projection.expressionPlan.messageCount).toBe(1);
  });

  it('preserves now=0 as a valid soul-state timestamp', () => {
    const projection = projectInnerLife({
      character: character(),
      messages: [message({ content: '小甲，你怎么看？' })],
      now: 0,
    });
    expect(projection.state.updatedAt).toBe(0);
  });

  it('keeps inner-life prompt pressure behavioral instead of generic confession or aphorism', () => {
    const projection = projectInnerLife({
      character: character({
        emotionalState: { affection: 10, irritation: 10, insecurity: 90, excitement: 10, embarrassment: 90 },
        soulState: {
          mood: { pleasure: -30, arousal: 50, dominance: 35 },
          energy: 48,
          attention: 45,
          loneliness: 0,
          repression: 80,
          shame: 85,
          envy: 0,
          trustInRoom: 55,
          ignoredStreak: 0,
        },
      }),
      messages: [message({ content: '我倒觉得这个方案还有得商量。', senderId: 'b' })],
      now: 20,
    });

    const prompt = buildInnerLifePromptBlock(projection);
    expect(prompt).toContain('keep the character’s social mask and habits alive');
    expect(prompt).toContain('Do not turn the pressure into a clean apology');
    expect(prompt).toContain('prefer concrete risk judgment, practical care, changed priority');
    expect(prompt).toContain('Avoid farewell tone, death monologue, and polished aphorisms');
    const stateOnly = buildInnerLifePromptBlock(projection, { stateOnly: true });
    expect(stateOnly).not.toContain(projection.reason);
    expect(stateOnly).not.toContain(`tone: ${projection.tone}`);
    expect(stateOnly).not.toContain('Current impulse:');
    expect(stateOnly).toContain('Recorded emotional lead:');
    expect(stateOnly).toContain('Recorded residue:');
    expect(stateOnly).toContain('scheduler urgency is not emotional intensity');
    expect(stateOnly).not.toContain('Do not turn the pressure');
    expect(stateOnly).not.toContain('Choose whether to send');
    expect(stateOnly.length).toBeLessThan(prompt.length);
  });
});
