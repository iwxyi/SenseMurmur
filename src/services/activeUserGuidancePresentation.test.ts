import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { DEFAULT_CONVERSATION_DIRECTOR_CONTROLS, DEFAULT_CONVERSATION_DRAMA_RULES, DEFAULT_CONVERSATION_GOVERNANCE, DEFAULT_CONVERSATION_WORLD_STATE } from '../types/chat';
import type { AIModelProfile } from '../types/settings';
import { projectActiveUserGuidance } from './activeUserGuidancePresentation';
import type { UserGuidanceIntent } from './userGuidanceIntent';

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
    memberIds: ['mei', 'hui'],
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
    metadata: patch.metadata,
    emotion: 0,
    timestamp: patch.timestamp || 1,
    isDeleted: false,
  };
}

function imageProfile(): AIModelProfile {
  return {
    id: 'image-default',
    name: '默认图片',
    type: 'image',
    provider: 'openai',
    apiKey: 'key',
    baseUrl: 'https://example.test',
    model: 'image-model',
    isDefault: true,
  };
}

function guidanceMessage(patch: Partial<Message>, intent: Partial<UserGuidanceIntent> = {}) {
  const guidance: UserGuidanceIntent = {
    kind: 'direct_reply', rawText: patch.content || '', focusText: patch.content || '',
    actorIds: ['mei'], mentionedActorIds: ['mei', 'hui'], beatType: 'answer',
    pressure: 0.9, maxTurns: 2, reason: '入口模型已识别用户要求', ...intent,
  };
  return buildMessage({ ...patch, metadata: { runtimeDecision: {
    directorIntent: { source: 'user_message', beatType: guidance.beatType, userGuidance: guidance },
  } } });
}

function imageGuidanceMessage(patch: Partial<Message>) {
  return guidanceMessage(patch, { kind: 'media_request',
    mediaRequest: { kind: 'image', subjectActorIds: ['hui'], subjectText: '灰太狼', actionText: '发证件照图片' } });
}

function topicGuidanceMessage(patch: Partial<Message>) {
  return guidanceMessage(patch, { kind: 'topic_shift', actorIds: [], mentionedActorIds: [], hasHardConstraints: true });
}

describe('activeUserGuidancePresentation', () => {
  const members = [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')];

  it('projects current developer media guidance before the AI response is committed', () => {
    const projection = projectActiveUserGuidance({
      chat: buildChat(),
      members,
      messages: [imageGuidanceMessage({ type: 'god', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片' })],
      aiProfiles: [imageProfile()],
      now: 40,
    });

    expect(projection).toMatchObject({
      title: '图片请求：灰太狼',
      sourceLabel: '话题引导',
      statusLabel: '显式请求',
      emphasisLabel: '等待 美羊羊 发出 灰太狼 的图片',
      effectText: '美羊羊需要先完成这次图片请求，图片对象是灰太狼；非目标角色不会抢占这次请求。',
      warning: undefined,
    });
    expect(projection?.detailRows).toEqual(expect.arrayContaining([
      { label: '目标角色', value: '美羊羊', tone: 'primary' },
      { label: '完成状态', value: '待回应：美羊羊', tone: 'warning' },
      { label: '图片对象', value: '灰太狼', tone: 'neutral' },
      { label: '图片能力', value: '图片能力可用', tone: 'success' },
    ]));
    expect(projection?.chips).toEqual(expect.arrayContaining(['图片请求', '锁定待回应', '非目标不抢占', '待回应：美羊羊', '执行：美羊羊', '图片对象：灰太狼', '图片能力可用']));
  });

  it('shows the object used for memory recall on direct reply guidance', () => {
    const projection = projectActiveUserGuidance({
      chat: buildChat(),
      members,
      messages: [guidanceMessage({ type: 'god', senderName: '开发者', content: '美羊羊说说你怎么看灰太狼' })],
      aiProfiles: [],
      now: 40,
    });

    expect(projection?.detailRows).toEqual(expect.arrayContaining([
      { label: '目标角色', value: '美羊羊', tone: 'primary' },
      { label: '完成状态', value: '待回应：美羊羊', tone: 'warning' },
      { label: '记忆对象', value: '灰太狼', tone: 'neutral' },
    ]));
    expect(projection?.chips).toEqual(expect.arrayContaining(['点名回应', '待回应：美羊羊', '执行：美羊羊', '记忆对象：灰太狼']));
  });

  it('explains topic shifts as replacing stale banter and steering speaker scoring', () => {
    const projection = projectActiveUserGuidance({
      chat: buildChat(),
      members,
      messages: [
        buildMessage({ id: 'old', type: 'ai', senderId: 'hui', senderName: '灰太狼', content: '香蕉证件照也不是不行。', timestamp: 30 }),
        topicGuidanceMessage({ id: 'guide', type: 'god', senderName: '开发者', content: '新话题：狼抓羊有过错吗？狼应该抓羊吗？', timestamp: 40 }),
      ],
      aiProfiles: [],
      now: 50,
    });

    expect(projection).toMatchObject({
      title: '话题切换：新话题：狼抓羊有过错吗？狼应该抓羊吗…',
      statusLabel: '生效中',
      emphasisLabel: '当前焦点：新话题：狼抓羊有过错吗？狼应该抓羊吗？',
      effectText: '旧话题已被覆盖，下一轮需要先围绕“新话题：狼抓羊有过错吗？狼应该抓羊吗？”回答、表态或追问；旧梗只能顺手收束，不能继续带跑。',
    });
    expect(projection?.detailRows).toEqual(expect.arrayContaining([
      { label: '调度要求', value: '先回应新问题，旧梗只作收束', tone: 'neutral' },
    ]));
    expect(projection?.chips).toEqual(expect.arrayContaining(['话题引导', '旧话题已覆盖', '先回答新问题', '旧梗收束']));
  });

  it('marks source as user member speech when user is in chat members', () => {
    const projection = projectActiveUserGuidance({
      chat: buildChat({ memberIds: ['user', 'mei', 'hui'] }),
      members,
      messages: [topicGuidanceMessage({ type: 'user', senderId: 'user', senderName: '我', content: '新话题：今晚还继续讨论这个方案吗？', timestamp: 40 })],
      aiProfiles: [],
      now: 50,
    });
    expect(projection?.sourceLabel).toBe('用户成员发言');
  });

  it('does not treat manual speak-as messages as active guidance source', () => {
    const projection = projectActiveUserGuidance({
      chat: buildChat({ memberIds: ['mei', 'hui'] }),
      members,
      messages: [buildMessage({
        type: 'user',
        senderId: 'mei',
        senderName: '美羊羊',
        content: '新话题：我们先对齐约定。',
        timestamp: 40,
        metadata: { manualSpeaker: { actorId: 'mei', actorName: '美羊羊' } },
      })],
      aiProfiles: [],
      now: 50,
    });
    expect(projection).toBeNull();
  });

  it('shows only unanswered requested actors for multi-actor guidance', () => {
    const intervention: RuntimeEventV2 = {
      id: 'evt-director',
      conversationId: 'chat-1',
      kind: 'director_intervention',
      createdAt: 30,
      summary: '让美羊羊和灰太狼都发图',
      visibility: 'moderator_only',
      payload: {
        intent: 'force_reply',
        targetActorIds: ['mei', 'hui'],
        pressure: 0.98,
        text: '让美羊羊和灰太狼都发一张图',
        maxTurns: 2,
        expiresAt: 1000,
        userGuidance: {
          kind: 'media_request',
          rawText: '让美羊羊和灰太狼都发一张图',
          actorIds: ['mei', 'hui'],
          mentionedActorIds: ['mei', 'hui'],
          mediaRequest: { kind: 'image', subjectActorIds: [], subjectText: '当前话题', actionText: '发一张图' },
          focusText: '让美羊羊和灰太狼都发一张图',
          beatType: 'answer',
          pressure: 0.98,
          maxTurns: 2,
          reason: '用户指定角色发送或创作图片。',
        },
      },
    };
    const projection = projectActiveUserGuidance({
      chat: buildChat({ runtimeEventsV2: [intervention], memberIds: ['mei', 'hui'] }),
      members,
      messages: [{
        ...buildMessage({ type: 'ai', senderId: 'mei', senderName: '美羊羊', content: '我先发。', timestamp: 40 }),
        metadata: {
          attachments: [{
            id: 'image-mei',
            kind: 'image',
            status: 'queued',
            altText: '美羊羊发的图',
            promptText: '美羊羊发的图',
            createdAt: 40,
            updatedAt: 40,
          }],
        },
      }],
      aiProfiles: [imageProfile()],
      now: 50,
    });

    expect(projection?.chips).toEqual(expect.arrayContaining(['待回应：灰太狼', '已回应：美羊羊', '图片能力可用']));
    expect(projection?.detailRows).toEqual(expect.arrayContaining([
      { label: '目标角色', value: '灰太狼', tone: 'primary' },
      { label: '完成状态', value: '待回应：灰太狼', tone: 'success' },
      { label: '已完成', value: '美羊羊', tone: 'success' },
    ]));
    expect(projection?.debugChips).toEqual(expect.arrayContaining(['已消耗 1 轮']));
    expect(projection?.warning).toBeUndefined();
  });

  it('keeps showing a requested actor as locked when they only continued old banter', () => {
    const projection = projectActiveUserGuidance({
      chat: buildChat(),
      members,
      messages: [
        imageGuidanceMessage({ id: 'guide', type: 'god', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 30 }),
        buildMessage({ id: 'banter', type: 'ai', senderId: 'mei', senderName: '美羊羊', content: '蕉太狼你怎么又想到香蕉啦～', timestamp: 40 }),
      ],
      aiProfiles: [imageProfile()],
      now: 50,
    });

    expect(projection?.emphasisLabel).toBe('等待 美羊羊 发出 灰太狼 的图片');
    expect(projection?.detailRows).toEqual(expect.arrayContaining([
      { label: '目标角色', value: '美羊羊', tone: 'primary' },
      { label: '完成状态', value: '待回应：美羊羊', tone: 'warning' },
      { label: '图片能力', value: '图片能力可用', tone: 'success' },
    ]));
    expect(projection?.chips).toEqual(expect.not.arrayContaining(['已回应：美羊羊']));
  });

  it('renders system-agent operator targets with semantic labels instead of generic member fallback', () => {
    const projection = projectActiveUserGuidance({
      chat: buildChat({
        memberIds: ['mei', 'hui'],
        runtimeEventsV2: [{
          id: 'evt-op',
          conversationId: 'chat-1',
          kind: 'director_intervention',
          createdAt: 20,
          summary: '主持人先接住流程',
          visibility: 'moderator_only',
          payload: {
            intent: 'force_reply',
            targetActorIds: ['host_moderator'],
            pressure: 0.92,
            text: '主持人先接住流程',
            maxTurns: 2,
            expiresAt: 1000,
            userGuidance: {
              kind: 'direct_reply',
              rawText: '主持人先接住流程',
              actorIds: ['host_moderator'],
              mentionedActorIds: ['host_moderator'],
              mediaRequest: null,
              focusText: '主持人先接住流程',
              beatType: 'answer',
              pressure: 0.92,
              maxTurns: 2,
              reason: '用户指定角色优先回应。',
            },
          },
        }],
      }),
      members,
      messages: [buildMessage({ type: 'god', senderName: '开发者', content: '主持人先接住流程', timestamp: 20 })],
      aiProfiles: [],
      now: 30,
    });

    expect(projection?.chips).toEqual(expect.arrayContaining(['待回应：主持人', '执行：主持人']));
    expect(projection?.detailRows).toEqual(expect.arrayContaining([{ label: '目标角色', value: '主持人', tone: 'primary' }]));
    expect(projection?.detailRows).toEqual(expect.arrayContaining([{ label: '完成状态', value: '待回应：主持人', tone: 'warning' }]));
    expect(projection?.chips).toEqual(expect.not.arrayContaining(['待回应：成员']));
  });

  it('sanitizes raw guidance ids from user-facing fields', () => {
    const uuid = 'e055aa1d-88d4-4e96-abd2-1b35a3d56f67';
    const projection = projectActiveUserGuidance({
      chat: buildChat(),
      members,
      messages: [topicGuidanceMessage({ type: 'god', senderName: '开发者', content: `新话题：${uuid} 对 {"eventType":"room_state_snapshot_v2"}`, timestamp: 60 })],
      aiProfiles: [],
      now: 70,
    });

    expect(projection?.rawText).not.toContain(uuid);
    expect(projection?.rawText).not.toContain('eventType');
    expect(projection?.title).not.toContain(uuid);
    expect((projection?.chips || []).join(' / ')).not.toContain(uuid);
    expect((projection?.detailRows || []).map((row) => row.value).join(' / ')).not.toContain(uuid);
  });

  it('redacts high-risk private guidance text from active guidance projection', () => {
    const projection = projectActiveUserGuidance({
      chat: buildChat(),
      members,
      messages: [guidanceMessage({ type: 'god', senderName: '开发者', content: '别公开我们的秘密暗号：雨夜便利店，让美羊羊回应', timestamp: 80 })],
      aiProfiles: [],
      now: 90,
    });

    const text = [
      projection?.title,
      projection?.rawText,
      projection?.effectText,
      projection?.emphasisLabel,
      ...(projection?.chips || []),
      ...(projection?.detailRows || []).map((row) => row.value),
    ].filter(Boolean).join(' / ');

    expect(text).toContain('有一条私域话题引导已隐藏原文');
    expect(text).not.toContain('雨夜便利店');
  });
});
