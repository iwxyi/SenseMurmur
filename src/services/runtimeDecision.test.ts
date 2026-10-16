import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { DEFAULT_CONVERSATION_DIRECTOR_CONTROLS, DEFAULT_CONVERSATION_DRAMA_RULES, DEFAULT_CONVERSATION_GOVERNANCE, DEFAULT_CONVERSATION_WORLD_STATE } from '../types/chat';
import { projectRuntimePressure, resolveLatestActiveUserGuidance, shouldUseFreeSpeechRuntimeDecision } from './runtimeDecision';

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

function buildCharacter(id: string, name: string): AICharacter {
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
  };
}

function buildMessage(patch: Partial<Message>): Message {
  return {
    id: patch.id || 'm1',
    chatId: 'chat-1',
    type: patch.type || 'user',
    senderId: patch.senderId || 'user',
    senderName: patch.senderName || '用户',
    content: patch.content || '',
    emotion: 0,
    timestamp: patch.timestamp || 1,
    isDeleted: false,
    metadata: patch.metadata,
  };
}

describe('runtimeDecision', () => {
  it('projects narrative pressure and a director intent for free-speaking group chats', () => {
    const chat = buildChat({
      worldState: {
        ...DEFAULT_CONVERSATION_WORLD_STATE,
        conflictState: {
          primaryConflict: {
            id: 'conflict-1',
            scope: 'group',
            type: 'value_conflict',
            severity: 0.8,
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
          volatility: 0.5,
          cooling: 0,
          updatedAt: 10,
        },
      },
    });
    const projection = projectRuntimePressure({
      chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'ai', senderId: 'a', senderName: '甲', content: '这不是一回事。' })],
      now: 20,
    });
    expect(projection.primaryLine?.id).toBe('conflict-1');
    expect(projection.directorIntent?.source).toBe('conflict');
    expect(projection.directorIntent?.targetActorIds).toContain('b');
  });

  it('disables free-speech runtime decisions for fixed-turn scenarios', () => {
    const chat = buildChat({ scenarioState: { currentTurnActorId: 'a', turnOrder: ['a', 'b'] } });
    expect(shouldUseFreeSpeechRuntimeDecision(chat)).toBe(false);
    const projection = projectRuntimePressure({
      chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ content: '甲，你来。' })],
    });
    expect(projection).toEqual({ narrativeLines: [], primaryLine: null, directorIntent: null });
  });

  it('keeps an assessed user target available in fixed-turn sessions', () => {
    const chat = buildChat({ scenarioState: { currentTurnActorId: 'a', turnOrder: ['a', 'b'] } });
    const messages = [buildMessage({
      content: '乙先回答。',
      metadata: {
        runtimeDecision: {
          directorIntent: {
            source: 'user_message',
            beatType: 'answer',
            targetActorIds: ['b'],
            pressure: 0.9,
            reason: '用户明确指定乙先回答。',
            userGuidance: {
              kind: 'direct_reply',
              rawText: '乙先回答。',
              actorIds: ['b'],
              mentionedActorIds: ['b'],
              focusText: '先回答',
              beatType: 'answer',
              pressure: 0.9,
              maxTurns: 1,
              reason: '用户明确指定乙先回答。',
            },
          },
        },
      },
    })];
    expect(resolveLatestActiveUserGuidance([buildCharacter('a', '甲'), buildCharacter('b', '乙')], messages, 20).intent?.targetActorIds).toEqual(['b']);
    const projection = projectRuntimePressure({
      chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages,
      now: 20,
    });
    expect(projection.directorIntent?.targetActorIds).toEqual(['b']);
    expect(projection.directorIntent?.userGuidance?.kind).toBe('direct_reply');
  });

  it('lets the latest director intervention override projected pressure', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      actorIds: ['user'],
      targetIds: ['a'],
      summary: '让甲先回应，不要继续升级',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a'],
        pressure: 0.95,
        text: '让甲先回应，不要继续升级',
      },
    };
    const chat = buildChat({ runtimeEventsV2: [intervention] });
    const projection = projectRuntimePressure({
      chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'ai', senderId: 'b', senderName: '乙', content: '你别躲。' })],
      now: 40,
    });
    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['a'],
      pressure: 0.95,
    });
  });

  it('accepts now=0 without falling back to Date.now', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director-zero',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 0,
      actorIds: ['user'],
      targetIds: ['a'],
      summary: '让甲先回应',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a'],
        pressure: 0.9,
        text: '让甲先回应',
      },
    };
    const projection = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'user', content: '甲先说' })],
      now: 0,
    });
    expect(projection.directorIntent?.targetActorIds).toEqual(['a']);
  });

  it('does not treat manual speak-as messages as user guidance', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [
        buildMessage({
          type: 'user',
          senderId: 'a',
          senderName: '甲',
          content: '新话题：狼抓羊有过错吗？',
          metadata: { manualSpeaker: { actorId: 'a', actorName: '甲' } },
        }),
      ],
      now: 50,
    });
    expect(projection.directorIntent?.userGuidance).toBeFalsy();
  });

  it.skip('legacy prose-only image intent inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼')],
      messages: [buildMessage({ type: 'user', senderId: 'user', senderName: '我', content: '美羊羊发个灰太狼证件照的图片' })],
      now: 40,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['a'],
      pressure: 0.98,
    });
    expect(projection.directorIntent?.userGuidance).toMatchObject({
      kind: 'media_request',
      actorIds: ['a'],
      mediaRequest: { kind: 'image', subjectActorIds: ['b'] },
    });
  });

  it.skip('legacy prose-only developer intent inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼')],
      messages: [buildMessage({ type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片' })],
      now: 40,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['a'],
      pressure: 0.98,
    });
    expect(projection.directorIntent?.userGuidance).toMatchObject({
      kind: 'media_request',
      actorIds: ['a'],
      mediaRequest: { kind: 'image', subjectActorIds: ['b'] },
    });
  });

  it.skip('legacy prose-only targeted guidance inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼')],
      messages: [
        buildMessage({ type: 'ai', senderId: 'b', senderName: '灰太狼', content: '美羊羊，你说呢？', timestamp: 30 }),
        buildMessage({ type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 40 }),
      ],
      pendingReplyContext: {
        targetIds: ['a'],
        primaryTargetId: 'a',
        sourceSpeakerId: 'b',
        unmetTurns: 1,
        strength: 'strong',
      },
      now: 50,
    });

    expect(projection.directorIntent?.userGuidance).toMatchObject({
      kind: 'media_request',
      rawText: '美羊羊发个灰太狼证件照的图片',
    });
    expect(projection.directorIntent?.targetActorIds).toEqual(['a']);
  });

  it.skip('legacy prose-only guidance precedence inference is retired', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-old-director',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      summary: '继续让乙回应旧梗',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['b'],
        pressure: 0.95,
        text: '让乙继续回应旧梗',
        maxTurns: 4,
        expiresAt: 1000,
      },
    };
    const projection = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼')],
      messages: [
        buildMessage({ type: 'ai', senderId: 'b', senderName: '灰太狼', content: '旧梗还没完。', timestamp: 35 }),
        buildMessage({ type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 40 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent?.userGuidance).toMatchObject({
      kind: 'media_request',
      rawText: '美羊羊发个灰太狼证件照的图片',
    });
    expect(projection.directorIntent?.targetActorIds).toEqual(['a']);
  });

  it('does not resurrect older guidance after a newer targeted request is completed', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼')],
      messages: [
        buildMessage({ id: 'old-guide', type: 'god', senderId: 'user', senderName: '开发者', content: '新话题：狼抓羊有过错吗？狼应该抓羊吗？', timestamp: 10 }),
        buildMessage({ id: 'new-guide', type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 30 }),
        buildMessage({ id: 'done', type: 'ai', senderId: 'a', senderName: '美羊羊', content: '画好啦。', timestamp: 40 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent?.userGuidance?.rawText).not.toBe('新话题：狼抓羊有过错吗？狼应该抓羊吗？');
  });

  it('keeps only unanswered requested actors active for multi-actor guidance', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      summary: '让甲乙都发图',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a', 'b'],
        pressure: 0.98,
        text: '让甲和乙都发一张图',
        maxTurns: 2,
        expiresAt: 1000,
        userGuidance: {
          kind: 'media_request',
          rawText: '让甲和乙都发一张图',
          actorIds: ['a', 'b'],
          mentionedActorIds: ['a', 'b'],
          mediaRequest: {
            kind: 'image',
            subjectActorIds: [],
            subjectText: '当前话题',
            actionText: '发一张图',
          },
          focusText: '让甲和乙都发一张图',
          beatType: 'answer',
          pressure: 0.98,
          maxTurns: 2,
          reason: '用户指定角色发送或创作图片。',
        },
      },
    };
    const afterFirst = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [{
        ...buildMessage({ type: 'ai', senderId: 'a', senderName: '甲', content: '我先发。', timestamp: 40 }),
        metadata: {
          attachments: [{
            id: 'image-a',
            kind: 'image',
            status: 'queued',
            altText: '甲发的图',
            promptText: '甲发的图',
            createdAt: 40,
            updatedAt: 40,
          }],
        },
      }],
      now: 50,
    });
    expect(afterFirst.directorIntent).toMatchObject({ source: 'user_message', targetActorIds: ['b'] });

    const afterBoth = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [
        {
          ...buildMessage({ id: 'm-a', type: 'ai', senderId: 'a', senderName: '甲', content: '我先发。', timestamp: 40 }),
          metadata: {
            attachments: [{
              id: 'image-a',
              kind: 'image',
              status: 'queued',
              altText: '甲发的图',
              promptText: '甲发的图',
              createdAt: 40,
              updatedAt: 40,
            }],
          },
        },
        {
          ...buildMessage({ id: 'm-b', type: 'ai', senderId: 'b', senderName: '乙', content: '我也发。', timestamp: 45 }),
          metadata: {
            attachments: [{
              id: 'image-b',
              kind: 'image',
              status: 'queued',
              altText: '乙发的图',
              promptText: '乙发的图',
              createdAt: 45,
              updatedAt: 45,
            }],
          },
        },
      ],
      now: 50,
    });
    expect(afterBoth.directorIntent?.source).not.toBe('user_message');
  });

  it('does not let non-target replies consume targeted media guidance', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director-media',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      summary: '让美羊羊发灰太狼证件照',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a'],
        pressure: 0.98,
        text: '美羊羊发个灰太狼证件照的图片',
        maxTurns: 1,
        expiresAt: 1000,
        userGuidance: {
          kind: 'media_request',
          rawText: '美羊羊发个灰太狼证件照的图片',
          actorIds: ['a'],
          mentionedActorIds: ['a', 'b'],
          mediaRequest: {
            kind: 'image',
            subjectActorIds: ['b'],
            subjectText: '灰太狼',
            actionText: '发个灰太狼证件照的图片',
          },
          focusText: '美羊羊发个灰太狼证件照的图片',
          beatType: 'answer',
          pressure: 0.98,
          maxTurns: 1,
          reason: '用户指定角色发送或创作图片。',
        },
      },
    };
    const projection = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼'), buildCharacter('c', '懒羊羊')],
      messages: [
        buildMessage({ type: 'ai', senderId: 'b', senderName: '灰太狼', content: '我看看你画得够不够帅。', timestamp: 40 }),
        buildMessage({ type: 'ai', senderId: 'c', senderName: '懒羊羊', content: '我也想看。', timestamp: 45 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      targetActorIds: ['a'],
    });
    expect(projection.directorIntent?.userGuidance?.kind).toBe('media_request');
  });

  it.skip('legacy director events without structured guidance are not semantically reparsed', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director-media-text',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      summary: '让美羊羊发灰太狼证件照',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a'],
        pressure: 0.98,
        text: '美羊羊发个灰太狼证件照的图片',
        maxTurns: 1,
        expiresAt: 1000,
      },
    };
    const projection = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼'), buildCharacter('c', '懒羊羊')],
      messages: [
        buildMessage({ type: 'ai', senderId: 'b', senderName: '灰太狼', content: '我看看你画得够不够帅。', timestamp: 40 }),
        buildMessage({ type: 'ai', senderId: 'c', senderName: '懒羊羊', content: '我也想看。', timestamp: 45 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['a'],
    });
    expect(projection.directorIntent?.userGuidance).toMatchObject({
      kind: 'media_request',
      actorIds: ['a'],
      mediaRequest: { kind: 'image', subjectActorIds: ['b'] },
    });
  });

  it.skip('legacy prose-only media persistence inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼'), buildCharacter('c', '懒羊羊')],
      messages: [
        buildMessage({ id: 'guide', type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 30 }),
        buildMessage({ id: 'non-target', type: 'ai', senderId: 'b', senderName: '灰太狼', content: '我看看你画得够不够帅。', timestamp: 40 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['a'],
    });
    expect(projection.directorIntent?.userGuidance).toMatchObject({
      kind: 'media_request',
      actorIds: ['a'],
      mediaRequest: { kind: 'image', subjectActorIds: ['b'] },
    });
  });

  it.skip('legacy prose-only constraint inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat({ memberIds: ['tang', 'a', 'b'] }),
      characters: [buildCharacter('tang', '小唐'), buildCharacter('a', '安安'), buildCharacter('b', '周策')],
      messages: [
        buildMessage({ id: 'guide', type: 'user', senderId: 'user', senderName: '我', content: '小唐预算不超过80，别忽略她', timestamp: 100 }),
        buildMessage({ id: 'a1', type: 'ai', senderId: 'a', senderName: '安安', content: '那先看看店的位置。', timestamp: 110 }),
        buildMessage({ id: 'b1', type: 'ai', senderId: 'b', senderName: '周策', content: '我倾向近一点。', timestamp: 120 }),
      ],
      now: 130,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'invite',
      targetActorIds: [],
    });
    expect(projection.directorIntent?.userGuidance).toMatchObject({
      rawText: '小唐预算不超过80，别忽略她',
      hasHardConstraints: true,
      hardConstraintActorIds: ['tang'],
    });
  });

  it.skip('legacy prose-only mention persistence inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat({ memberIds: ['user', 'anan', 'zhou', 'mei'] }),
      characters: [buildCharacter('anan', '安安'), buildCharacter('zhou', '周策'), buildCharacter('mei', '梅青')],
      messages: [
        buildMessage({
          id: 'guide',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '安安，你直接说吧，用户到底为什么不再用了？不用先照顾周策的汇报口径。',
          timestamp: 100,
        }),
        buildMessage({
          id: 'hijack',
          type: 'ai',
          senderId: 'zhou',
          senderName: '周策',
          content: '我先补一句，流失不能简单归因到一个点，外部环境也有影响。',
          timestamp: 110,
        }),
        buildMessage({
          id: 'handoff',
          type: 'ai',
          senderId: 'mei',
          senderName: '梅青',
          content: '周策，可以先让安安把访谈原话说完。',
          timestamp: 120,
        }),
      ],
      now: 130,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['anan'],
    });
    expect(projection.directorIntent?.userGuidance).toMatchObject({
      kind: 'direct_reply',
      actorIds: ['anan'],
      deferredActorIds: ['zhou'],
    });
  });

  it.skip('legacy prose-only deferred-speaker inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat({ memberIds: ['user', 'anan', 'zhou', 'mei'] }),
      characters: [buildCharacter('anan', '安安'), buildCharacter('zhou', '周策'), buildCharacter('mei', '梅青')],
      messages: [
        buildMessage({
          id: 'guide',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '安安，你直接说吧，用户到底为什么不再用了？不用先照顾周策的汇报口径。',
          timestamp: 100,
        }),
        buildMessage({
          id: 'answer-1',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '访谈里用户主要卡在审核等待。',
          timestamp: 110,
        }),
        buildMessage({
          id: 'answer-2',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '他们不是不需要产品，是等不起。',
          timestamp: 120,
        }),
      ],
      now: 130,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      targetActorIds: [],
    });
    expect(projection.directorIntent?.userGuidance).toMatchObject({
      rawText: '安安，你直接说吧，用户到底为什么不再用了？不用先照顾周策的汇报口径。',
      deferredActorIds: ['zhou'],
    });
  });

  it.skip('legacy prose-only corrective guidance inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat({ memberIds: ['user', 'anan', 'zhou', 'mei'] }),
      characters: [buildCharacter('anan', '安安'), buildCharacter('zhou', '周策'), buildCharacter('mei', '梅青')],
      messages: [
        buildMessage({
          id: 'guide',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '我刚才是想听安安说，不是让周策替她做决定。',
          timestamp: 100,
        }),
        buildMessage({
          id: 'answer-1',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '我先说一部分，访谈里用户主要卡在承诺没有兑现。',
          timestamp: 110,
        }),
      ],
      now: 120,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['anan'],
    });
  });

  it.skip('legacy prose-only suppression inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat({ memberIds: ['user', 'anan', 'zhou', 'mei'] }),
      characters: [buildCharacter('anan', '安安'), buildCharacter('zhou', '周策'), buildCharacter('mei', '梅青')],
      messages: [
        buildMessage({
          id: 'guide',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '我刚才是想听安安说，不是让周策替她做决定。',
          timestamp: 100,
        }),
        buildMessage({
          id: 'answer-1',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '我先说一部分，访谈里用户主要卡在承诺没有兑现。',
          timestamp: 110,
        }),
        buildMessage({
          id: 'answer-2',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '还有一点是客服跟进太慢，他们不是不需要产品，是不再信任我们。',
          timestamp: 120,
        }),
      ],
      now: 130,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      targetActorIds: [],
    });
    expect(projection.directorIntent?.userGuidance).toMatchObject({
      rawText: '我刚才是想听安安说，不是让周策替她做决定。',
      suppressedActorIds: ['zhou'],
    });
  });

  it('expires corrective floor window after target answers and one guardian turn', () => {
    const projection = projectRuntimePressure({
      chat: buildChat({ memberIds: ['user', 'anan', 'zhou', 'mei'] }),
      characters: [buildCharacter('anan', '安安'), buildCharacter('zhou', '周策'), buildCharacter('mei', '梅青')],
      messages: [
        buildMessage({
          id: 'guide',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '我刚才是想听安安说，不是让周策替她做决定。',
          timestamp: 100,
        }),
        buildMessage({
          id: 'answer-1',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '我先说一部分，访谈里用户主要卡在承诺没有兑现。',
          timestamp: 110,
        }),
        buildMessage({
          id: 'answer-2',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '还有一点是客服跟进太慢，他们不是不需要产品，是不再信任我们。',
          timestamp: 120,
        }),
        buildMessage({
          id: 'guardian',
          type: 'ai',
          senderId: 'mei',
          senderName: '梅青',
          content: '先让安安这条线按她自己的说法走完。',
          timestamp: 130,
        }),
      ],
      now: 140,
    });

    expect(projection.directorIntent?.userGuidance?.rawText).not.toBe('我刚才是想听安安说，不是让周策替她做决定。');
  });

  it('releases corrective suppression after the guidance window is consumed', () => {
    const projection = projectRuntimePressure({
      chat: buildChat({ memberIds: ['user', 'anan', 'zhou', 'mei'] }),
      characters: [buildCharacter('anan', '安安'), buildCharacter('zhou', '周策'), buildCharacter('mei', '梅青')],
      messages: [
        buildMessage({
          id: 'guide',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '我刚才是想听安安说，不是让周策替她做决定。',
          timestamp: 100,
        }),
        ...Array.from({ length: 5 }, (_, index) => buildMessage({
          id: `answer-${index + 1}`,
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: `我继续补第 ${index + 1} 点。`,
          timestamp: 110 + index * 10,
        })),
      ],
      now: 170,
    });

    expect(projection.directorIntent?.userGuidance?.rawText).not.toBe('我刚才是想听安安说，不是让周策替她做决定。');
  });

  it.skip('legacy prose-only media completion inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼'), buildCharacter('c', '蕉太狼')],
      messages: [
        buildMessage({ id: 'guide', type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 30 }),
        buildMessage({ id: 'target-banter', type: 'ai', senderId: 'a', senderName: '美羊羊', content: '蕉太狼你这一天天的，满脑子都是香蕉。', timestamp: 40 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['a'],
    });
    expect(projection.directorIntent?.userGuidance?.kind).toBe('media_request');
  });

  it('completes a targeted media request after the requested actor commits an image attachment', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼')],
      messages: [
        buildMessage({ id: 'guide', type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 30 }),
        {
          ...buildMessage({ id: 'done', type: 'ai', senderId: 'a', senderName: '美羊羊', content: '来啦，证件照画好了。', timestamp: 40 }),
          metadata: {
            attachments: [{
              id: 'image-1',
              kind: 'image',
              status: 'queued',
              altText: '灰太狼证件照',
              promptText: '灰太狼证件照',
              createdAt: 40,
              updatedAt: 40,
            }],
          },
        },
      ],
      now: 50,
    });

    expect(projection.directorIntent?.userGuidance?.rawText).not.toBe('美羊羊发个灰太狼证件照的图片');
  });

  it('does not keep plain topic shifts active as persistent director guidance after a reply', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '蕉太狼'), buildCharacter('b', '慢羊羊')],
      messages: [
        buildMessage({ id: 'guide', type: 'god', senderId: 'user', senderName: '开发者', content: '新话题：狼抓羊有过错吗？狼应该抓羊吗？', timestamp: 30 }),
        buildMessage({ id: 'first', type: 'ai', senderId: 'a', senderName: '蕉太狼', content: '香蕉证件照也不是不行。', timestamp: 40 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent?.userGuidance).toBeFalsy();
  });

  it('does not keep plain question guidance active from old-banter overlap alone', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼'), buildCharacter('c', '慢羊羊')],
      messages: [
        buildMessage({ id: 'guide', type: 'god', senderId: 'user', senderName: '开发者', content: '新话题：狼抓羊有过错吗？狼应该抓羊吗？', timestamp: 30 }),
        buildMessage({ id: 'first', type: 'ai', senderId: 'a', senderName: '美羊羊', content: '灰太狼先生，你要真去考个“抓羊证”，我倒是可以帮你画个美美的证件照哦。', timestamp: 40 }),
        buildMessage({ id: 'second', type: 'ai', senderId: 'b', senderName: '灰太狼', content: '抓羊证这东西要是真有，我第一个去报名。', timestamp: 45 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent?.userGuidance).toBeFalsy();
  });

  it.skip('legacy prose-only media completion inference is retired', () => {
    const projection = projectRuntimePressure({
      chat: buildChat(),
      characters: [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼'), buildCharacter('c', '蕉太狼')],
      messages: [
        buildMessage({ id: 'guide', type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 30 }),
        buildMessage({ id: 'target-joke', type: 'ai', senderId: 'a', senderName: '美羊羊', content: '蕉太狼你这一天天的，满脑子都是香蕉，连灰太狼先生的胡子都不放过啦。', timestamp: 40 }),
      ],
      now: 50,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['a'],
    });
    expect(projection.directorIntent?.userGuidance?.kind).toBe('media_request');
  });

  it('expires a director intervention after one AI response by default', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      summary: '让甲先回应',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a'],
        pressure: 0.95,
        text: '让甲先回应',
      },
    };
    const projection = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [
        buildMessage({ type: 'ai', senderId: 'b', senderName: '乙', content: '你别躲。', timestamp: 40 }),
      ],
      now: 50,
    });
    expect(projection.directorIntent?.source).not.toBe('user_message');
  });

  it('keeps a director intervention active for configured maxTurns', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      summary: '连续两轮让甲接住',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a'],
        pressure: 0.95,
        text: '连续两轮让甲接住',
        maxTurns: 2,
        expiresAt: 1000,
      },
    };
    const projection = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [
        buildMessage({ type: 'ai', senderId: 'b', senderName: '乙', content: '第一轮之后。', timestamp: 40 }),
      ],
      now: 50,
    });
    expect(projection.directorIntent).toMatchObject({ source: 'user_message', targetActorIds: ['a'] });
  });

  it.each(['suppressedActorIds', 'deferredActorIds'] as const)('releases %s after the model-assessed restraint window is consumed', (restraintField) => {
    const guidance = {
      kind: 'direct_reply' as const,
      rawText: '我想听安安说，不是让周策替她决定。',
      actorIds: ['a'],
      mentionedActorIds: ['a', 'b'],
      suppressedActorIds: restraintField === 'suppressedActorIds' ? ['b'] : [],
      deferredActorIds: restraintField === 'deferredActorIds' ? ['b'] : [],
      focusText: '让安安自己说完',
      beatType: 'answer' as const,
      pressure: 0.92,
      maxTurns: 2,
      minTargetTurns: 1,
      reason: '模型判断用户正在纠正抢话。',
    };
    const intervention: RuntimeEventV2 = {
      id: 'evt-floor-restraint',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      actorIds: ['user'],
      targetIds: ['a'],
      summary: guidance.reason,
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a'],
        pressure: guidance.pressure,
        text: guidance.rawText,
        maxTurns: guidance.maxTurns,
        expiresAt: 1000,
        userGuidance: guidance,
      },
    };
    const projection = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '安安'), buildCharacter('b', '周策')],
      messages: [buildMessage({ type: 'ai', senderId: 'a', senderName: '安安', content: '我自己说。', timestamp: 40 })],
      now: 50,
    });

    expect(projection.directorIntent).toMatchObject({
      source: 'user_message',
      targetActorIds: [],
      userGuidance: { [restraintField]: ['b'] },
    });

    const released = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '安安'), buildCharacter('b', '周策')],
      messages: [
        buildMessage({ id: 'floor', type: 'ai', senderId: 'a', content: '我自己说。', timestamp: 40 }),
        buildMessage({ id: 'after-floor', type: 'ai', senderId: 'a', content: '就这些。', timestamp: 45 }),
      ],
      now: 50,
    });
    expect(released.directorIntent?.source).not.toBe('user_message');
  });

  it('ignores expired director interventions', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      summary: '已经过期',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['a'],
        pressure: 0.95,
        text: '已经过期',
        expiresAt: 35,
      },
    };
    const projection = projectRuntimePressure({
      chat: buildChat({ runtimeEventsV2: [intervention] }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'ai', senderId: 'b', senderName: '乙', content: '继续。', timestamp: 32 })],
      now: 40,
    });
    expect(projection.directorIntent?.source).not.toBe('user_message');
  });
});
