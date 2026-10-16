import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { DEFAULT_CONVERSATION_DIRECTOR_CONTROLS, DEFAULT_CONVERSATION_DRAMA_RULES, DEFAULT_CONVERSATION_GOVERNANCE, DEFAULT_CONVERSATION_WORLD_STATE } from '../types/chat';
import { resolveDirectorIntent } from './directorIntent';
import { projectNarrativeLines } from './narrativeProjection';
import { getDirectorIntentSpeakerBias } from './speakerScoring';

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

describe('resolveDirectorIntent', () => {
  it('uses the actual user turn for ordinary guidance without topic projection duplicating it', () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const messages = [buildMessage({ content: '今天逛街穿什么？' })];
    const lines = projectNarrativeLines({ chat, characters, messages, now: 2 });
    const intent = resolveDirectorIntent({ chat, characters, messages, narrativeLines: lines });
    expect(intent.source).toBe('user_message');
    expect(intent.beatType).toBe('invite');
    expect(lines.find((line) => line.id === 'topic:latest')?.possibleNextBeats).toEqual([]);
  });

  it.each([true, false])('does not assign the latest AI speaker a casual reply task with projection=%s', (withProjection) => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const messages = [buildMessage({ type: 'ai', senderId: 'a', senderName: '甲', content: '今晚先到这儿。' })];
    const intent = resolveDirectorIntent({ chat, characters, messages,
      narrativeLines: withProjection ? projectNarrativeLines({ chat, characters, messages, now: 2 }) : undefined });
    expect(intent.targetActorIds).toEqual([]);
    expect(intent.pressure).toBe(0);
    expect(getDirectorIntentSpeakerBias({ character: characters[1], directorIntent: intent, chat }).bias).toBe(0);
  });

  it.each([true, false])('does not turn casual drift into a summarizer assignment with projection=%s', (withProjection) => {
    const chat = buildChat({ worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE,
      structuredRoomState: { heat: 0, cohesion: 0, topicDrift: 80, dominantThread: null,
        alliances: [], conflictPairs: [], pileOnTarget: null, silencedActors: [] } } });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    characters[1].behavior.summarizing = 90;
    const messages = [buildMessage({ type: 'ai', senderId: 'a', content: '今天的晚霞好看。' })];
    const intent = resolveDirectorIntent({ chat, characters, messages,
      narrativeLines: withProjection ? projectNarrativeLines({ chat, characters, messages, now: 2 }) : undefined });
    expect(intent.beatType).not.toBe('summarize');
    expect(getDirectorIntentSpeakerBias({ character: characters[1], directorIntent: intent, chat }).reasons)
      .not.toContain('director:summarizer');
  });

  it('retains drift-based synthesis in analysis rooms', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat({
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE,
          structuredRoomState: { heat: 0, cohesion: 0, topicDrift: 80, dominantThread: null,
            alliances: [], conflictPairs: [], pileOnTarget: null, silencedActors: [] } },
      }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')], messages: [],
    });
    expect(intent.beatType).toBe('summarize');
  });

  it('preserves an explicit user request to summarize in casual chat', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({
        content: '甲，帮我总结一下刚才的讨论。',
        metadata: { runtimeDecision: { directorIntent: {
          source: 'user_message', beatType: 'summarize', targetActorIds: ['a'],
          userGuidance: {
            kind: 'direct_reply', rawText: '甲，帮我总结一下刚才的讨论。',
            actorIds: ['a'], mentionedActorIds: ['a'], focusText: '总结刚才的讨论',
            beatType: 'summarize', pressure: 0.8, maxTurns: 1,
            reason: '用户明确请求总结。',
          },
        } } },
      })],
    });
    expect(intent.source).toBe('user_message');
    expect(intent.beatType).toBe('summarize');
    expect(intent.targetActorIds).toEqual(['a']);
  });

  it('prioritizes an unresolved pending reply', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'ai', senderId: 'a', senderName: '甲', content: '乙你怎么看？' })],
      pendingReplyContext: {
        targetIds: ['b'],
        primaryTargetId: 'b',
        sourceSpeakerId: 'a',
        unmetTurns: 2,
        strength: 'strong',
      },
    });
    expect(intent.source).toBe('conversation_reply');
    expect(intent.beatType).toBe('answer');
    expect(intent.targetActorIds).toEqual(['b']);
    expect(intent.pressure).toBeGreaterThan(0.8);
  });

  it.each([0.8, 0])('retains conflict focus at severity %s without renewing cold pressure', (severity) => {
    const intent = resolveDirectorIntent({
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
              summary: '甲乙正在争夺解释权',
              participantIds: ['a'],
              targetIds: ['b'],
              nextPressure: 'spread',
              developmentHooks: ['force_side_taking'],
              sourceEventIds: [],
              updatedAt: 1,
            },
            activeConflicts: [],
            developmentHooks: [],
            volatility: 0.5,
            cooling: 0,
            updatedAt: 1,
          },
        },
      }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'ai', senderId: 'a', senderName: '甲', content: '这事不是这么算的。' })],
    });
    expect(intent.source).toBe('conflict');
    expect(intent.beatType).toBe(severity === 0 ? 'answer' : 'invite');
    if (severity === 0) expect(intent.pressure).toBe(0.18);
    expect(intent.targetActorIds).toEqual(['b', 'a']);
    expect(intent.targetLineId).toBe('conflict-1');
  });

  it('uses the primary narrative line before legacy room fallbacks', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'ai', senderId: 'a', senderName: '甲', content: '刚才那件事还没完。' })],
      narrativeLines: [{
        id: 'relationship:a->b',
        conversationId: 'chat-1',
        type: 'relationship',
        title: '紧张对峙',
        summary: '甲对乙的信任正在下降',
        participantIds: ['a', 'b'],
        visibility: 'public',
        status: 'active',
        tension: 0.7,
        momentum: 0.7,
        salience: 0.82,
        sourceEventIds: ['event-1'],
        lastTouchedAt: 1,
        openQuestions: ['这段关系会继续恶化吗？'],
        possibleNextBeats: [{
          beatType: 'challenge',
          targetActorIds: ['a', 'b'],
          pressure: 0.76,
          reason: '关系线已经成为当前焦点',
        }],
      }],
    });
    expect(intent.source).toBe('relationship');
    expect(intent.targetLineId).toBe('relationship:a->b');
    expect(intent.beatType).toBe('challenge');
  });

  it('keeps faction defense out of analysis rooms', () => {
    const factionLine = {
      id: 'faction:shared-side',
      conversationId: 'chat-1',
      type: 'faction' as const,
      title: '阵营压力',
      summary: '几名成员正在形成同一立场。',
      participantIds: ['a', 'b'],
      visibility: 'public' as const,
      status: 'active' as const,
      tension: 0.2,
      momentum: 0.8,
      salience: 0.82,
      sourceEventIds: ['event-1'],
      lastTouchedAt: 1,
      openQuestions: [],
      possibleNextBeats: [{
        beatType: 'defend' as const,
        targetActorIds: ['a', 'b'],
        pressure: 0.74,
        reason: '自动推荐已经形成可感知的阵营压力。',
      }],
    };
    const intent = resolveDirectorIntent({
      chat: buildChat({
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
      }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'ai', senderId: 'a', senderName: '甲', content: '这个说法我站。' })],
      narrativeLines: [factionLine],
    });

    expect(intent.source).toBe('topic');
    expect(intent.beatType).toBe('summarize');
    expect(intent.targetActorIds).toEqual([]);
    expect(intent.reason).toContain('不使用阵营防守压力');
  });

  it('preserves faction defense in ordinary conversation rooms', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [buildMessage({ type: 'ai', senderId: 'a', senderName: '甲', content: '我站乙。' })],
      narrativeLines: [{
        id: 'faction:ordinary',
        conversationId: 'chat-1',
        type: 'faction',
        title: '阵营压力',
        summary: '普通群聊里的关系站边。',
        participantIds: ['a', 'b'],
        visibility: 'public',
        status: 'active',
        tension: 0.2,
        momentum: 0.8,
        salience: 0.82,
        sourceEventIds: [],
        lastTouchedAt: 1,
        openQuestions: [],
        possibleNextBeats: [{
          beatType: 'defend',
          targetActorIds: ['b'],
          pressure: 0.74,
          reason: '普通关系线可以有人站边。',
        }],
      }],
    });

    expect(intent.source).toBe('faction');
    expect(intent.beatType).toBe('defend');
    expect(intent.targetActorIds).toEqual(['b']);
  });

  it('normalizes room state metrics before converting them into pressure', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat({
        worldState: {
          ...DEFAULT_CONVERSATION_WORLD_STATE,
          structuredRoomState: {
            heat: 80,
            cohesion: -8,
            topicDrift: 0,
            dominantThread: ['a', 'b'],
            alliances: [],
            conflictPairs: [['a', 'b']],
            pileOnTarget: 'b',
            silencedActors: [],
          },
        },
      }),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [],
    });

    expect(intent.source).toBe('room_state');
    expect(intent.beatType).toBe('cool_down');
    expect(intent.pressure).toBeGreaterThan(0.7);
    expect(intent.pressure).toBeLessThan(0.9);
  });

  it('does not treat manual speak-as user messages as topic guidance', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [
        buildMessage({
          type: 'user',
          senderId: 'a',
          senderName: '甲',
          content: '新话题：今晚聊身份冲突',
          metadata: { manualSpeaker: { actorId: 'a', actorName: '甲' } },
        }),
      ],
    });

    expect(intent.source).not.toBe('user_message');
    expect(intent.userGuidance).toBeFalsy();
  });

  it('treats god messages as topic guidance', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [
        buildMessage({
          type: 'god',
          senderId: 'user',
          senderName: '主持',
          content: '新话题：你们对规则公平性的看法',
          metadata: { runtimeDecision: { directorIntent: { source: 'user_message', beatType: 'invite', targetActorIds: [], userGuidance: { kind: 'topic_shift', rawText: '新话题：你们对规则公平性的看法', actorIds: [], mentionedActorIds: [], focusText: '你们对规则公平性的看法', beatType: 'invite', pressure: 0.5, maxTurns: 1 } } } },
        }),
      ],
    });

    expect(intent.source).toBe('user_message');
    expect(intent.userGuidance?.kind).toBe('topic_shift');
  });

  it.skip('legacy prose-only collective intent inference is retired', () => {
    const intent = resolveDirectorIntent({
      chat: buildChat(),
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      messages: [
        buildMessage({
          type: 'user',
          senderId: 'user',
          senderName: '用户',
          content: '你怎么看待AI在未来对人类的影响？每个人写一篇800字作文',
        }),
      ],
    });

    expect(intent.source).toBe('user_message');
    expect(intent.beatType).toBe('answer');
    expect(intent.targetActorIds).toEqual(['a', 'b']);
    expect(intent.userGuidance?.kind).toBe('direct_reply');
    expect(intent.userGuidance?.actorIds).toEqual(['a', 'b']);
  });
});
