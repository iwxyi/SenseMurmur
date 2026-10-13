import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../types/chat';
import {
  DEFAULT_CHARACTER_BEHAVIOR,
  DEFAULT_CHARACTER_INTERVENTION,
  DEFAULT_EMOTIONAL_STATE,
  type AICharacter,
} from '../types/character';
import type { Message } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import type { MemoryItem } from './memoryTypes';
import { setChatMemoryRuntimeConfig } from './chatMemoryRuntimeConfig';
import { buildChatMessages, buildCrossModeMemoryPrompt, buildPromptAssemblyWithContext, buildPromptCharacterMindTrace, buildPromptMemoryTrace, buildSystemPromptWithContext } from './promptBuilder';

function buildCharacter(overrides: Partial<AICharacter> = {}): AICharacter {
  return {
    id: 'char-a',
    name: '苏苏',
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
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

function buildChat() {
  return normalizeConversation({
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '测试群聊',
    topic: '日常聊天',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['char-a'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

function buildDirectChat() {
  return normalizeConversation({
    ...buildChat(),
    type: 'direct',
    name: '苏苏单聊',
    relationshipLedger: [{
      pairKey: 'char-a->user',
      actorId: 'char-a',
      targetId: 'user',
      current: { warmth: 48, competence: 8, trust: 42, threat: 4 },
      derived: {
        semantic: {
          stage: '深度绑定',
          labels: ['喜欢', '深度牵挂'],
          summary: '深度绑定：喜欢、深度牵挂',
          intensity: 72,
        },
      },
      trend: 'up',
      recentEvents: [{ id: 'evt-1', kind: 'interaction', createdAt: 10, summary: '用户记得苏苏提过的压力。', actorIds: ['char-a'], targetIds: ['user'] }],
      lastUpdatedAt: 10,
    }],
  });
}

function buildAiDirectChat() {
  return normalizeConversation({
    ...buildChat(),
    type: 'ai_direct',
    name: '苏苏和阿远',
    memberIds: ['char-a', 'char-b'],
  });
}

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id || 'msg-1',
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'char-b',
    senderName: '阿远',
    content: '那次雨夜我不是故意失约。',
    emotion: 0,
    timestamp: 2,
    isDeleted: false,
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'old-memory',
    ownerId: 'char-a',
    scope: 'relationship',
    layer: 'long_term',
    kind: 'resentment',
    subjectIds: ['char-b'],
    text: '苏苏记得阿远曾在雨夜失约。',
    salience: 0.82,
    confidence: 0.82,
    recency: 0.2,
    reinforcementCount: 2,
    sourceEventIds: ['old-event'],
    sourceTag: 'llm_memory_relationship_imprint',
    origin: 'distilled',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: 10,
    subjectOwner: 'target',
    privacyRisk: 0.55,
    visibility: 'pair_private',
    validity: 'active',
    ...overrides,
  };
}

const leakySpeakerId = '3c78729f-e52d-4dde-b27f-01a949960bb8b';
const leakyTargetId = '8b3d7266-c0c7-4ceb-8dc2-45126f3f2321';

describe('buildSystemPromptWithContext', () => {
  it('uses ordinary group relationship data as evidence without a per-turn display quota', () => {
    const speaker = buildCharacter({
      relationships: [{
        characterId: 'char-b',
        warmth: -12,
        competence: 42,
        trust: 18,
        threat: 30,
        note: '对方是上位者，既得听令，也始终怕被看穿心思。',
      }],
    });
    const target = buildCharacter({ id: 'char-b', name: '阎君' });
    const prompt = buildSystemPromptWithContext(speaker, { ...buildChat(), memberIds: [speaker.id, target.id] }, 0, [
      buildMessage({ senderId: target.id, senderName: target.name, content: '西巷的事，谁来担？' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('## Member Relationship Context');
    expect(prompt).toContain('阎君');
    expect(prompt).toContain('toward 阎君: warmth -12');
    expect(prompt).not.toContain('Current counterpart:');
    expect(prompt).not.toContain('Make one consequence perceptible');
  });

  it.each(['direct', 'ai_direct'] as const)('keeps %s relationship evidence without forcing a visible action', (type) => {
    const note = '雨夜失约后仍有些介意，但还没有问出口。';
    const targetId = type === 'direct' ? 'user' : 'char-b';
    const speaker = buildCharacter({
      relationships: [{ characterId: targetId, warmth: 36, competence: 42, trust: 28, threat: 12, note }],
    });
    const target = buildCharacter({ id: targetId, name: '阿远' });
    const prompt = buildPromptAssemblyWithContext(speaker, {
      ...(type === 'direct' ? buildDirectChat() : buildAiDirectChat()),
      memberIds: [speaker.id, target.id],
    }, 0, [buildMessage({ type: type === 'direct' ? 'user' : 'ai', senderId: target.id, senderName: target.name })], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]), { preferredTargetActorId: targetId }).systemPrompt;

    expect(prompt).toContain('evidence, not a required visible relationship action');
    expect(prompt).toContain(note);
    expect(prompt).not.toContain('Make one consequence perceptible');
    expect(prompt).not.toContain('decide the immediate relational pressure');
  });

  it('retains explicit relational consequence guidance for dedicated analysis play', () => {
    const speaker = buildCharacter({
      relationships: [{ characterId: 'char-b', warmth: 36, competence: 42, trust: 28, threat: 12, note: '雨夜失约后仍有些介意。' }],
    });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const prompt = buildSystemPromptWithContext(speaker, {
      ...buildChat(),
      mode: 'group_discussion',
      sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
      memberIds: [speaker.id, target.id],
    }, 0, [buildMessage({ senderId: target.id, senderName: target.name })], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('Make one consequence perceptible');
  });

  it('passes developer guidance messages to the model as user turns', () => {
    const rendered = buildChatMessages([
      buildMessage({ type: 'god', senderId: 'user', senderName: '开发者', content: '新话题：狼抓羊有过错吗？' }),
    ], new Map(), 12);

    expect(rendered).toEqual([
      { role: 'user', content: '话题引导: 新话题：狼抓羊有过错吗？' },
    ]);
  });

  it.each(['free', 'roleplay'] as const)('grounds group speaker identity and past accounts in %s style', (style) => {
    const speaker = buildCharacter();
    const prompt = buildSystemPromptWithContext(speaker, { ...buildChat(), style }, 0, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '三弟，你怎么确认的？' }),
    ], new Map([[speaker.id, speaker]]));
    expect(prompt).toContain('Follow the named transcript speaker, not the API role');
    expect(prompt).toContain('only when explicitly established');
    expect(prompt).toContain('unknown details remain unknown or clearly tentative');
    expect(prompt).toContain('A concise uncertainty is a complete answer');
    expect(prompt).toContain('New present actions may unfold');
  });

  it('keeps ordinary group continuity rules out of private and story-reader contracts', () => {
    const speaker = buildCharacter();
    for (const chat of [buildDirectChat(), normalizeConversation({ ...buildChat(),
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'text' } })]) {
      const prompt = buildSystemPromptWithContext(speaker, chat, 0, [], new Map([[speaker.id, speaker]]));
      expect(prompt).not.toContain('Follow the named transcript speaker, not the API role');
      expect(prompt).not.toContain('unknown details remain unknown or clearly tentative');
    }
  });

  it('projects direct chat history with the current speaker as assistant', () => {
    const rendered = buildChatMessages([
      buildMessage({ type: 'user', senderId: 'user', senderName: '开发者', content: '能具体讲讲第一章发生了什么吗？', timestamp: 1 }),
      buildMessage({ type: 'ai', senderId: 'char-a', senderName: '潇潇', content: '第一章从废弃大楼里的命案展开。', timestamp: 2 }),
      buildMessage({ type: 'user', senderId: 'user', senderName: '开发者', content: '第二章又讲了什么？', timestamp: 3 }),
    ], new Map(), 12, { currentSpeakerId: 'char-a', chatType: buildDirectChat().type });

    expect(rendered).toEqual([
      { role: 'user', content: '用户: 能具体讲讲第一章发生了什么吗？' },
      { role: 'assistant', content: '第一章从废弃大楼里的命案展开。' },
      { role: 'user', content: '用户: 第二章又讲了什么？' },
    ]);
  });

  it('projects group chat history with other AI speakers as named user-side context', () => {
    const rendered = buildChatMessages([
      buildMessage({ type: 'user', senderId: 'user', senderName: '开发者', content: '你们换一种接法。', timestamp: 1 }),
      buildMessage({ type: 'ai', senderId: 'char-a', senderName: '甲', content: '收到，那我负责带锅底，八点见。', timestamp: 2 }),
      buildMessage({ type: 'ai', senderId: 'char-b', senderName: '乙', content: '收到，那我负责带蘸料，八点见。', timestamp: 3 }),
    ], new Map(), 12, { currentSpeakerId: 'char-b', chatType: buildChat().type });

    expect(rendered).toEqual([
      { role: 'user', content: '用户: 你们换一种接法。' },
      { role: 'user', content: '甲: 收到，那我负责带锅底，八点见。' },
      { role: 'assistant', content: '收到，那我负责带蘸料，八点见。' },
    ]);
  });

  it('removes long stage asides from non-story recent event prompt context', () => {
    const character = buildCharacter();
    const chat = normalizeConversation({
      ...buildChat(),
      sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
      worldState: {
        ...buildChat().worldState,
        recentEvent: '审议推进：（听到程序员那句“那沓纸在就行”，站在厨房门口，手里擦灶台的抹布还没放下。忽然笑了一声。）你们这一个个的散场太有仪式感。',
      },
    });

    const prompt = buildSystemPromptWithContext(character, chat, 0, [], new Map([[character.id, character]]));

    expect(prompt).toContain('Recent event: 审议推进：');
    expect(prompt).toContain('你们这一个个的散场太有仪式感');
    expect(prompt).not.toContain('站在厨房门口');
    expect(prompt).not.toContain('擦灶台');
  });

  it('treats character occupation as a background distribution rather than a mandatory example source', () => {
    const character = buildCharacter({
      background: '宠物猫舍主理人',
      expertise: ['猫行为学'],
    });
    const prompt = buildSystemPromptWithContext(character, buildChat(), 0, [], new Map([[character.id, character]]));

    expect(prompt).toContain('## Character Grounding');
    expect(prompt).toContain('These are causes of attention and judgment');
    expect(prompt).toContain('not facts that every reply must mention');
    expect(prompt).not.toContain('## Persona Activation');
  });

  it('keeps compact group grounding character-specific without turning it into a checklist', () => {
    const character = buildCharacter({
      coreProfile: {
        coreDesire: '',
        coreFear: '',
        valuePriority: ['体面', '可靠'],
        socialMask: '先拿玩笑挡一下认真话',
        biases: [],
        interactionHabits: ['先看谁在替别人吞代价'],
        expressionHabits: ['真正担心时先挖苦一句'],
        sensitivities: ['被当成只会附和的人'],
        conflictStyle: '不正面吵，先挑对方逻辑里的刺',
      },
    });
    const prompt = buildSystemPromptWithContext(character, buildChat(), 0, [], new Map([[character.id, character]]));
    expect(prompt.split('穿搭博主')).toHaveLength(2);
    expect(prompt.split('轻快')).toHaveLength(2);
    expect(prompt).toContain('真正担心时先挖苦一句');
    expect(prompt.split('真正担心时先挖苦一句')).toHaveLength(2);
    expect(prompt).toContain('Conflict posture: 不正面吵，先挑对方逻辑里的刺');
    expect(prompt).toContain('What this person protects first: 体面, 可靠');
    expect(prompt).toContain('These voice fingerprints are differentiators');
  });

  it('injects core desire and fear as private deeper motivation instead of loose profile data', () => {
    const character = buildCharacter({
      coreProfile: {
        coreDesire: '想被当作真正可靠的人，而不是只会活跃气氛的人。',
        coreFear: '害怕别人发现自己其实经常没有把握。',
        socialMask: '先开玩笑，避免太快暴露认真。',
        valuePriority: ['可靠', '体面'],
        biases: [],
        interactionHabits: ['先试探对方是否愿意认真听'],
      },
    });

    const prompt = buildSystemPromptWithContext(character, buildChat(), 0, [], new Map([[character.id, character]]));

    expect(prompt).toContain('## Core Character Continuity');
    expect(prompt).toContain('Desires: 想被当作真正可靠的人');
    expect(prompt).toContain('Fears and sensitivities: 害怕别人发现自己其实经常没有把握');
    expect(prompt).toContain('Stable self: 穿搭博主 / 先开玩笑');
    expect(prompt).toContain('Voice and habits: 轻快 / 先试探对方是否愿意认真听');
    expect(prompt).toContain('This projection is inner context, not a checklist');
  });

  it('lets the ordinary group turn directive own broad natural-chat length guidance', () => {
    const character = buildCharacter({
      behavior: {
        ...DEFAULT_CHARACTER_BEHAVIOR,
        empathyLevel: 82,
      },
    });
    const prompt = buildSystemPromptWithContext(character, buildChat(), 0, [], new Map([[character.id, character]]));

    expect(prompt).toContain('## Expression Bias');
    expect(prompt).toContain('Notice emotional cues');
    expect(prompt).not.toContain('Sound like a person in a live chat');
    expect(prompt).not.toContain('Let the situation decide length');
    expect(prompt).not.toContain('Do not default to a fixed medium length');
    expect(prompt).toContain('## Response Rules');
    expect(prompt).toContain('Reply as a chat message');
  });

  it('keeps companionship evidence without duplicating ordinary conversation expression rules', () => {
    const character = buildCharacter();
    const prompt = buildSystemPromptWithContext(character, buildDirectChat(), 0, [], new Map([[character.id, character]]));

    expect(prompt).not.toContain('Sound like a person in a live chat');
    expect(prompt).not.toContain('Let the situation decide length');
    expect(prompt).not.toContain('Do not default to a fixed medium length');
    expect(prompt).not.toContain('Take a real relational stance');
    expect(prompt).not.toContain('Poetry, reassurance, a farewell, or silence can all be right');
    expect(prompt).not.toContain('second independent bubble');
  });

  it('projects AI private thread counterpart turns as named user-side context', () => {
    const rendered = buildChatMessages([
      buildMessage({
        type: 'ai',
        senderId: 'char-a',
        senderName: '苏苏',
        content: '我刚才在群里是不是说重了？',
        timestamp: 1,
      }),
      buildMessage({
        type: 'ai',
        senderId: 'char-b',
        senderName: '阿远',
        content: '有一点，但我知道你不是故意的。',
        timestamp: 2,
      }),
    ], new Map(), 12, { currentSpeakerId: 'char-a', chatType: buildAiDirectChat().type });

    expect(rendered).toEqual([
      { role: 'assistant', content: '我刚才在群里是不是说重了？' },
      { role: 'user', content: '阿远: 有一点，但我知道你不是故意的。' },
    ]);
  });

  it('does not duplicate raw recent dialogue inside the system prompt window summary', () => {
    const character = buildCharacter();
    const prompt = buildSystemPromptWithContext(character, buildChat(), 0, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '开发者', content: '这种违约金要怎么举证？' }),
      buildMessage({ type: 'ai', senderId: 'char-a', senderName: '专业律师', content: '你这个问题问到了实务中的痛点。' }),
    ], new Map([[character.id, character]]));

    expect(prompt).toContain('## Conversation Window');
    expect(prompt).toContain('complete recent transcript is provided separately');
    expect(prompt).toContain('Recent visible turns: 2');
    expect(prompt).not.toContain('这种违约金要怎么举证');
    expect(prompt).not.toContain('你这个问题问到了实务中的痛点');
  });

  it('targets the latest AI speaker in group prompts as the default local relationship target', () => {
    const speaker = buildCharacter({ id: 'char-a', name: '喜羊羊' });
    const latestAi = buildCharacter({ id: 'char-b', name: '灰太狼' });
    const trace = buildPromptMemoryTrace(speaker, { ...buildChat(), memberIds: ['char-a', 'char-b'] }, [
      buildMessage({ senderId: 'char-b', senderName: '灰太狼', content: '你这话听着就不靠谱。' }),
    ], new Map([
      [speaker.id, speaker],
      [latestAi.id, latestAi],
    ]));

    expect(trace.targetActorId).toBe('char-b');
    expect(trace.targetReason).toBe('来自上一条消息的最近发言者');
  });

  it.each(['user', 'god'] as const)('does not retrieve the old AI counterpart after a new %s turn without a character subject', (type) => {
    const speaker = buildCharacter({ id: 'char-a', name: '张飞' });
    const other = buildCharacter({ id: 'char-b', name: '关羽' });
    const members = new Map([[speaker.id, speaker], [other.id, other]]);
    const room = { ...buildChat(), memberIds: [speaker.id, other.id] };
    const messages = [
      buildMessage({ senderId: other.id, senderName: other.name, content: '记录看过了。', timestamp: 1 }),
      buildMessage({ type, senderId: 'user', senderName: '用户', content: '南门的空当是怎么确认的？', timestamp: 2 }),
      buildMessage({ type: 'system', content: '系统消息', timestamp: 3 }),
      buildMessage({ senderId: other.id, content: '已删除消息', isDeleted: true, timestamp: 4 }),
    ];
    const assembly = buildPromptAssemblyWithContext(speaker, room, 0, messages, members);

    expect(assembly.memoryTrace.targetActorId).toBeUndefined();
    expect(assembly.characterMindTrace.targetActorId).toBe('user');

    const withSubject = buildPromptAssemblyWithContext(speaker, room, 0, messages, members, { preferredTargetActorId: other.id });
    expect(withSubject.memoryTrace.targetActorId).toBe(other.id);
    expect(withSubject.memoryTrace.targetReason).toBe('来自本回合行为规划的当前对象');
  });

  it('keeps the planner target for retrieval without assigning the group reply recipient', () => {
    const speaker = buildCharacter({
      id: 'char-a',
      name: '牛头',
      relationships: [
        { characterId: 'char-c', warmth: 6, competence: 72, trust: 38, threat: 24, deference: 70, note: '对阎君既熟悉又敬畏。' },
        { characterId: 'char-b', warmth: 60, competence: 50, trust: 65, threat: 0, attachment: 42, note: '和马面相处熟稔。' },
      ],
    });
    const latestAi = buildCharacter({ id: 'char-b', name: '马面' });
    const plannedTarget = buildCharacter({ id: 'char-c', name: '阎君' });
    const room = {
      ...buildChat(),
      memberIds: ['char-a', 'char-b', 'char-c'],
      relationshipStructure: {
        version: 1 as const,
        edges: [],
        sharedFacts: [{ id: 'authority', memberIds: ['char-a', 'char-c'], kind: 'authority' as const, statement: '阎君统辖幽都，牛头受其差遣。', confidence: 0.98, evidence: '角色设定', updatedAt: 1 }],
        updatedAt: 1,
      },
    };
    const assembly = buildPromptAssemblyWithContext(speaker, room, 0, [
      buildMessage({ senderId: latestAi.id, senderName: latestAi.name, content: '我先去看西巷。' }),
    ], new Map([
      [speaker.id, speaker],
      [latestAi.id, latestAi],
      [plannedTarget.id, plannedTarget],
    ]), { preferredTargetActorId: plannedTarget.id });

    expect(assembly.memoryTrace.targetActorId).toBe(plannedTarget.id);
    expect(assembly.memoryTrace.targetReason).toBe('来自本回合行为规划的当前对象');
    expect(assembly.systemPrompt).toContain('牛头 toward 阎君: warmth 6');
    expect(assembly.systemPrompt).toContain('牛头 toward 马面: warmth 60');
    expect(assembly.systemPrompt).toContain('Shared reality: 阎君统辖幽都，牛头受其差遣。');
    expect(assembly.systemPrompt).toContain('deference 70');
    expect(assembly.systemPrompt).not.toContain('Current counterpart:');
    expect(assembly.systemPrompt).not.toContain('和马面相处熟稔。');
  });

  it('includes group relationship evidence without a recent reply target and excludes absent members', () => {
    const speaker = buildCharacter({
      id: 'char-a',
      name: '牛头',
      relationships: [
        { characterId: 'char-b', warmth: 60, competence: 50, trust: 65, threat: 0, attachment: 42, deference: 10 },
        { characterId: 'char-c', warmth: 30, competence: 40, trust: 30, threat: 5 },
      ],
    });
    const member = buildCharacter({ id: 'char-b', name: '马面' });
    const absent = buildCharacter({ id: 'char-c', name: '外群成员' });
    const assembly = buildPromptAssemblyWithContext(speaker, {
      ...buildChat(), memberIds: [speaker.id, member.id],
    }, 0, [], new Map([[speaker.id, speaker], [member.id, member], [absent.id, absent]]));

    expect(assembly.memoryTrace.targetActorId).toBeUndefined();
    expect(assembly.systemPrompt).toContain('牛头 toward 马面: warmth 60');
    expect(assembly.systemPrompt).toContain('attachment 42, deference 10');
    expect(assembly.systemPrompt).not.toContain('外群成员');
    expect(assembly.systemPrompt).not.toContain('Current counterpart:');
  });

  it('targets the latest AI speaker in group prompts when that message explicitly addresses the current speaker', () => {
    const speaker = buildCharacter({ id: 'char-a', name: '喜羊羊' });
    const latestAi = buildCharacter({ id: 'char-b', name: '灰太狼' });
    const message = buildMessage({ senderId: 'char-b', senderName: '灰太狼', content: '刚才那个锅底方案我不太同意。' }) as Message & {
      addressedTargetIds: string[];
      primaryAddressedTargetId: string;
    };
    message.addressedTargetIds = ['char-a'];
    message.primaryAddressedTargetId = 'char-a';

    const trace = buildPromptMemoryTrace(speaker, { ...buildChat(), memberIds: ['char-a', 'char-b'] }, [message], new Map([
      [speaker.id, speaker],
      [latestAi.id, latestAi],
    ]));

    expect(trace.targetActorId).toBe('char-b');
    expect(trace.targetReason).toBe('来自上一条消息的明确指向');
  });

  it('turns a current relationship ledger into stance without exposing semantic evidence as a recall cue', () => {
    const speaker = buildCharacter({ id: 'char-a', name: '喜羊羊' });
    const target = buildCharacter({ id: 'char-b', name: '灰太狼' });
    const chat = {
      ...buildChat(),
      memberIds: ['char-a', 'char-b'],
      relationshipLedger: [{
        pairKey: 'char-a->char-b',
        actorId: 'char-a',
        targetId: 'char-b',
        current: { warmth: 56, competence: 0, trust: 68, threat: 4, attachment: 32, deference: 12 },
        derived: {
          semantic: {
            stage: '互相信任',
            labels: ['默契'],
            summary: '互相信任：会替对方留余地',
            intensity: 64,
          },
        },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: 40,
      }],
    };

    const prompt = buildSystemPromptWithContext(speaker, chat, 0, [
      buildMessage({ senderId: target.id, senderName: target.name, content: '这次方案我可能做错了。' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).not.toContain('## Active Continuity Pull');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('Stance toward 灰太狼');
    expect(prompt).toContain('亲和 56');
    expect(prompt).toContain('attachment 32, deference 12');
    expect(prompt).not.toContain('更容易靠近、维护或给对方留余地');
    expect(prompt).not.toContain('互相信任：会替对方留余地');
  });

  it('does not render legacy influence state as a separate visible prompt block', () => {
    const speaker = buildCharacter({
      relationships: [{
        characterId: 'char-b',
        warmth: 42,
        competence: 0,
        trust: 35,
        threat: 0,
        note: '会替阿远留一点余地。',
      }],
      layeredMemories: [memory({
        id: 'target-memory',
        ownerId: 'char-a',
        subjectIds: ['char-b'],
        scope: 'relationship',
        text: '苏苏记得阿远之前帮她圆过场。',
        summary: '阿远之前帮她圆过场。',
      })],
    });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const prompt = buildSystemPromptWithContext(speaker, buildChat({ memberIds: ['char-a', 'char-b'] }), 0, [
      buildMessage({ senderId: 'char-b', senderName: '阿远', content: '那我先说一句。' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).not.toContain('## Influence State');
    expect(prompt).not.toContain('Topic bias:');
    expect(prompt).not.toContain('## Active Continuity Pull');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('Stance toward 阿远');
  });

  it('adds a group-specific user boundary reminder when user continuity is present', () => {
    const speaker = buildCharacter({
      id: 'char-a',
      name: '阿晚',
      memory: {
        longTerm: [],
        shortTermSummary: '',
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户私下说自己很怕明天面试，别在群里提。'],
      },
    });

    const prompt = buildSystemPromptWithContext(speaker, {
      ...buildChat(),
      memberIds: ['char-a', 'user'],
    }, 0, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '大家随便聊吧，我听着。' }),
    ], new Map([
      [speaker.id, speaker],
    ]));

    expect(prompt).not.toContain('## Active Continuity Pull');
    expect(prompt).toContain('User continuity: User continuity exists');
    expect(prompt).toContain('without revealing private facts');
    expect(prompt).not.toContain('用户私下说自己很怕明天面试');
  });

  it('does not let stale human guidance retarget prompt memory after a newer user turn', () => {
    const speaker = buildCharacter({ id: 'char-a', name: '潇潇' });
    const target = buildCharacter({ id: 'char-b', name: '阿强' });
    const trace = buildPromptMemoryTrace(speaker, { ...buildChat(), memberIds: ['char-a', 'char-b'] }, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '开发者', content: '阿强刚才怎么看？', timestamp: 1 }),
      buildMessage({ type: 'ai', senderId: 'char-a', senderName: '潇潇', content: '我先说我的看法。', timestamp: 2 }),
      buildMessage({ type: 'user', senderId: 'user', senderName: '开发者', content: '第二章又讲了什么？', timestamp: 3 }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(trace.targetActorId).toBeUndefined();
    expect(trace.targetReason).toBeUndefined();
  });

  it('keeps private user memory text out of public room mind continuity', () => {
    const character = buildCharacter({
      memory: {
        shortTermSummary: '刚和用户聊过春季穿搭',
        longTerm: ['记得用户喜欢低饱和配色'],
        secrets: ['不想承认自己接了商业合作'],
        obsessions: ['总会关注鞋包搭配'],
        tabooTopics: ['被质疑审美时会防御'],
        userMemories: ['用户预算有限但重视质感'],
      },
    });

    const prompt = buildSystemPromptWithContext(character, buildChat(), 0, [], new Map([[character.id, character]]));

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('Self continuity');
    expect(prompt).toContain('刚和用户聊过春季穿搭');
    expect(prompt).toContain('记得用户喜欢低饱和配色');
    expect(prompt).toContain('总会关注鞋包搭配');
    expect(prompt).toContain('被质疑审美时会防御');
    expect(prompt).toContain('未公开的角色自有内容');
    expect(prompt).not.toContain('## Manual Memory Seeds');
    expect(prompt).not.toContain('不想承认自己接了商业合作');
    expect(prompt).not.toContain('用户预算有限但重视质感');
  });

  it('moves authored character continuity into the mind projection for ordinary groups', () => {
    const character = buildCharacter({
      memory: {
        shortTermSummary: '最近不太想被人追问旧事。',
        longTerm: ['曾经在雨夜替朋友守过店。'],
        secrets: ['不愿承认自己曾经临阵退缩。'],
        obsessions: ['会反复检查门有没有锁好。'],
        tabooTopics: ['被拿失败经历开玩笑时会防御。'],
        userMemories: [],
      },
    });
    const ordinaryGroup = {
      ...buildChat(),
      memberIds: ['char-a', 'char-b'],
      sessionKind: {
        topology: 'group' as const,
        family: 'conversation' as const,
        scenarioId: 'open-chat',
        surfaceProfile: 'text' as const,
      },
    };
    const prompt = buildSystemPromptWithContext(
      character,
      ordinaryGroup,
      0,
      [buildMessage({ senderId: 'char-b', senderName: '阿远', content: '今晚先别聊太沉。' })],
      new Map([
        [character.id, character],
        ['char-b', buildCharacter({ id: 'char-b', name: '阿远' })],
      ]),
    );

      expect(prompt).toContain('## Character Mind Projection');
      expect(prompt).toContain('## Core Character Continuity');
    expect(prompt).toContain('Self continuity');
    expect(prompt).toContain('长期经历：曾经在雨夜替朋友守过店');
    expect(prompt).toContain('敏感触发：被拿失败经历开玩笑时会防御');
    expect(prompt).toContain('未公开的角色自有内容');
    expect(prompt).not.toContain('## Manual Memory Seeds');
    expect(prompt).not.toContain('不愿承认自己曾经临阵退缩');
  });

  it('keeps direct chat user memory text available as pair-private context', () => {
    const character = buildCharacter({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户预算有限但重视质感'],
      },
    });

    const prompt = buildSystemPromptWithContext(character, buildDirectChat(), 0, [], new Map([[character.id, character]]));

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('User continuity');
    expect(prompt).toContain('User details are handled by the companionship context');
    expect(prompt).not.toContain('User continuity: 用户预算有限但重视质感');
    expect(prompt).toContain('## Companionship Context');
    expect(prompt).toContain('Remembered user cues');
    expect(prompt).toContain('用户预算有限但重视质感');
    expect(prompt).not.toContain('Memories about the user');
    expect(prompt).not.toContain('## Private-Channel Memories');
    expect(prompt).not.toContain('## Visible Recall Cues');
  });

  it('keeps authored character memory available in private direct prompts', () => {
    const character = buildCharacter({
      memory: {
        shortTermSummary: '最近想把一件旧事说清楚。',
        longTerm: ['曾经在雨夜替朋友守过店。'],
        secrets: ['不愿承认自己曾经临阵退缩。'],
        obsessions: ['会反复检查门有没有锁好。'],
        tabooTopics: ['被拿失败经历开玩笑时会防御。'],
        userMemories: [],
      },
    });

    const prompt = buildSystemPromptWithContext(
      character,
      buildDirectChat(),
      0,
      [buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '你今天怎么了？' })],
      new Map([[character.id, character]]),
    );

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('曾经在雨夜替朋友守过店');
    expect(prompt).toContain('## Manual Memory Seeds');
    expect(prompt).not.toContain('Stable long-term memories');
    expect(prompt).not.toContain('## Private-Channel Memories');
    expect(prompt).toContain('不愿承认自己曾经临阵退缩');
  });

  it('keeps authored character memory available in AI-private prompts', () => {
    const character = buildCharacter({
      memory: {
        shortTermSummary: '最近想把一件旧事说清楚。',
        longTerm: ['曾经在雨夜替朋友守过店。'],
        secrets: ['不愿承认自己曾经临阵退缩。'],
        obsessions: [],
        tabooTopics: [],
        userMemories: [],
      },
    });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });

    const prompt = buildSystemPromptWithContext(
      character,
      buildAiDirectChat(),
      0,
      [buildMessage({ senderId: target.id, senderName: target.name, content: '你今天怎么了？' })],
      new Map([
        [character.id, character],
        [target.id, target],
      ]),
    );

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('曾经在雨夜替朋友守过店');
    expect(prompt).toContain('## Manual Memory Seeds');
    expect(prompt).not.toContain('Stable long-term memories');
    expect(prompt).not.toContain('## Pair-Thread Memories');
    expect(prompt).toContain('不愿承认自己曾经临阵退缩');
  });

  it('lets the mind projection own AI-private relationship and channel policy', () => {
    const character = buildCharacter({
      relationships: [{
        characterId: 'char-b',
        warmth: 62,
        competence: 18,
        trust: 74,
        threat: 4,
        note: '互相信任：会替对方留余地。',
      }],
    });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const chat = {
      ...buildAiDirectChat(),
      relationshipLedger: [{
        pairKey: 'char-a->char-b',
        actorId: 'char-a',
        targetId: 'char-b',
        current: { warmth: 62, competence: 18, trust: 74, threat: 4 },
        derived: {
          semantic: {
            stage: '互相信任',
            labels: ['默契'],
            summary: '互相信任：会替对方留余地',
            intensity: 70,
          },
        },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: 40,
      }],
    };

    const prompt = buildSystemPromptWithContext(
      character,
      chat,
      0,
      [buildMessage({ senderId: target.id, senderName: target.name, content: '这件事我会接住。' })],
      new Map([
        [character.id, character],
        [target.id, target],
      ]),
    );

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('Stance toward 阿远');
    expect(prompt).toContain('Relationship continuity');
    expect(prompt).toContain('互相信任：会替对方留余地');
    expect(prompt).not.toContain('## Social Appraisal');
    expect(prompt).not.toContain('## Relationship Influence');
    expect(prompt).not.toContain('## Relationship Semantics');
    expect(prompt).not.toContain('## Targeted Response Lens');
    expect(prompt).not.toContain('## Targeted Reply Rule');
    expect(prompt).not.toContain('## Targeted Influence Summary');
    expect(prompt).not.toContain('## Active Continuity Pull');
    expect(prompt).not.toContain('## Influence Mode');
    expect(prompt).not.toContain('## Channel Bias');
    expect(prompt).not.toContain('## Memory Priority');
    expect(prompt).toContain('这是 AI 之间的私密对话');
  });

  it('keeps core continuity when visible old-memory callbacks are disabled', () => {
    setChatMemoryRuntimeConfig({ enabled: false });
    try {
      const character = buildCharacter({
        memory: {
          shortTermSummary: '',
          longTerm: [],
          secrets: [],
          obsessions: [],
          tabooTopics: [],
          userMemories: ['用户预算有限但重视质感'],
        },
      });

      const prompt = buildSystemPromptWithContext(character, buildDirectChat(), 0, [
        buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '今天想买一件外套。' }),
      ], new Map([[character.id, character]]));

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('## Core Character Continuity');
      expect(prompt).toContain('User continuity');
      expect(prompt).toContain('User details are handled by the companionship context');
      expect(prompt).not.toContain('User continuity: 用户预算有限但重视质感');
      expect(prompt).toContain('Remembered user cues');
      expect(prompt).toContain('用户预算有限但重视质感');
      expect(prompt).not.toContain('## Visible Recall Cues');
      expect(prompt).not.toContain('## Private-Channel Memories');
    } finally {
      setChatMemoryRuntimeConfig(null);
    }
  });

  it('carries character-owned memories from other chats into a later direct chat', () => {
    const character = buildCharacter({
      layeredMemories: [
        memory({
          id: 'group-experience-memory',
          scope: 'relationship',
          subjectIds: ['char-a', 'char-b'],
          text: '在十皇共议中，苏苏记住了阿远会在争执最激烈时先替别人留台阶。',
          evidenceText: '这条记忆来自十皇共议，不是当前单聊。',
          relatedConversationId: 'group-chat-1',
          sourceTag: 'llm_memory_character_perspective',
          archivedAt: null,
          recency: 0.85,
          updatedAt: 100,
        }),
      ],
    });
    const directChat = buildDirectChat();
    const prompt = buildSystemPromptWithContext(
      character,
      directChat,
      0,
        [buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '你还记得阿远吗？', metadata: { runtimeDecision: { directorIntent: { source: 'user_message', beatType: 'answer', targetActorIds: ['char-b'], userGuidance: { kind: 'direct_reply', rawText: '你还记得阿远吗？', actorIds: ['char-a'], mentionedActorIds: ['char-b'], focusText: '阿远', beatType: 'answer', pressure: 0.7, maxTurns: 1 } } } } })],
      new Map([
        [character.id, character],
        ['char-b', buildCharacter({ id: 'char-b', name: '阿远' })],
      ]),
    );
    const trace = buildPromptMemoryTrace(
      character,
      directChat,
      [buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '你还记得阿远吗？', metadata: { runtimeDecision: { directorIntent: { source: 'user_message', beatType: 'answer', targetActorIds: ['char-b'], userGuidance: { kind: 'direct_reply', rawText: '你还记得阿远吗？', actorIds: ['char-a'], mentionedActorIds: ['char-b'], focusText: '阿远', beatType: 'answer', pressure: 0.7, maxTurns: 1 } } } } })],
      new Map([
        [character.id, character],
        ['char-b', buildCharacter({ id: 'char-b', name: '阿远' })],
      ]),
    );

    expect(prompt).toContain('苏苏记住了阿远会在争执最激烈时先替别人留台阶');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).not.toContain('## Private-Channel Memories');
    expect(prompt).not.toContain('group-chat-1');
    expect(trace.injectedIds).toContain('group-experience-memory');
  });

  it('injects companionship context for direct chats without confirming romance', () => {
    const character = buildCharacter({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说过明天面试会紧张。'],
      },
    });
    const prompt = buildSystemPromptWithContext(character, buildDirectChat(), 0, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '明天面试有点紧张。' }),
    ], new Map([[character.id, character]]));

    expect(prompt).toContain('## Companionship Context');
    expect(prompt).toContain('Pending care topics');
    expect(prompt).toContain('明天面试');
    expect(prompt).toContain('Do not claim a confirmed romantic relationship');
    expect(prompt).not.toContain('phase: confirmed relationship');
  });

  it('injects user shared memory anchors into direct companionship context', () => {
    const character = buildCharacter({
      layeredMemories: [{
        id: 'user-anchor',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'char-a',
        subjectIds: ['char-a', 'user'],
        text: '第一次深夜聊天后，苏苏记住了用户当时没有退出对话。',
        evidenceText: '用户那晚陪苏苏聊到很晚。',
        salience: 0.9,
        confidence: 0.9,
        recency: 0.7,
        reinforcementCount: 2,
        sourceEventIds: ['evt-user-anchor'],
        origin: 'distilled',
        createdAt: 10,
        updatedAt: 20,
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
    const prompt = buildSystemPromptWithContext(character, buildDirectChat(), 0, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '今天有点累。' }),
    ], new Map([[character.id, character]]));

    expect(prompt).toContain('Shared memory anchors with the user');
    expect(prompt).toContain('第一次深夜聊天');
    expect(prompt).not.toContain('User continuity: 第一次深夜聊天');
    expect(prompt).not.toContain('## Visible Recall Cues');
    const mindBeforeCompanionship = prompt.split('## Companionship Context')[0];
    expect(mindBeforeCompanionship).not.toContain('第一次深夜聊天');
    expect(mindBeforeCompanionship).toContain('Shared user history is handled by the companionship context');
    expect(prompt).not.toContain('只有他们知道的暗号');
  });

  it('does not inject user companionship context for group chats where user is not a member', () => {
    const character = buildCharacter();
    const prompt = buildSystemPromptWithContext(character, buildChat(), 0, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '明天面试有点紧张。' }),
    ], new Map([[character.id, character]]));

    expect(prompt).not.toContain('## Companionship Context');
  });

  it('injects public-safe companionship continuity when user joins a group room', () => {
    const character = buildCharacter({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户下周要面试，希望别被公开点名。'],
      },
    });
    const groupWithUser = {
      ...buildChat(),
      memberIds: ['char-a', 'user'],
      relationshipLedger: [{
        pairKey: 'char-a->user',
        actorId: 'char-a',
        targetId: 'user',
        current: { warmth: 36, competence: 0, trust: 30, threat: 4 },
        derived: {
          semantic: {
            stage: '熟悉陪伴',
            labels: ['牵挂'],
            summary: '熟悉陪伴：有牵挂但需要克制公开表达',
            intensity: 54,
          },
        },
        trend: 'flat' as const,
        recentEvents: [],
        lastUpdatedAt: 20,
      }],
    };

    const prompt = buildSystemPromptWithContext(character, groupWithUser, 0, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '我也在群里听着。' }),
    ], new Map([[character.id, character]]));

    expect(prompt).not.toContain('## Companionship Context');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('User continuity');
    expect(prompt).toContain('without revealing private facts');
    expect(prompt).not.toContain('用户下周要面试');
    expect(prompt).not.toContain('希望别被公开点名');
  });

  it('injects public-safe companionship continuity in cross-mode prompts', () => {
    const character = buildCharacter({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户下周要面试，希望别被公开点名。'],
      },
    });
    const groupWithUser = {
      ...buildChat(),
      memberIds: ['char-a', 'user'],
      relationshipLedger: [{
        pairKey: 'char-a->user',
        actorId: 'char-a',
        targetId: 'user',
        current: { warmth: 36, competence: 0, trust: 30, threat: 4 },
        derived: {
          semantic: {
            stage: '熟悉陪伴',
            labels: ['牵挂'],
            summary: '熟悉陪伴：有牵挂但需要克制公开表达',
            intensity: 54,
          },
        },
        trend: 'flat' as const,
        recentEvents: [],
        lastUpdatedAt: 20,
      }],
    };

    const prompt = buildCrossModeMemoryPrompt(character, groupWithUser, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '我也在旁边听。' }),
    ], new Map([[character.id, character]]));

    expect(prompt).not.toContain('## Companionship Context');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('User continuity');
    expect(prompt).toContain('without revealing private facts');
    expect(prompt).not.toContain('用户下周要面试');
    expect(prompt).not.toContain('希望别被公开点名');
  });

  it('redacts private user facts from public relationship stance summaries', () => {
    const character = buildCharacter();
    const groupWithUser = {
      ...buildChat(),
      memberIds: ['char-a', 'user'],
      relationshipLedger: [{
        pairKey: 'char-a->user',
        actorId: 'char-a',
        targetId: 'user',
        current: { warmth: 42, competence: 0, trust: 38, threat: 4 },
        derived: {
          semantic: {
            stage: '熟悉陪伴',
            labels: ['牵挂', '下周面试'],
            summary: '熟悉陪伴：知道用户下周要面试，希望别被公开点名',
            intensity: 58,
          },
        },
        trend: 'flat' as const,
        recentEvents: [],
        lastUpdatedAt: 20,
      }],
    };

    const prompt = buildSystemPromptWithContext(character, groupWithUser, 0, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '我也在群里听着。' }),
    ], new Map([[character.id, character]]));

    expect(prompt).not.toContain('## Companionship Context');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('User continuity');
    expect(prompt).not.toContain('下周要面试');
    expect(prompt).not.toContain('公开点名');
  });

  it('uses the character mind projection for public relationship stance without legacy duplicate blocks', () => {
    const speaker = buildCharacter();
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const chat = {
      ...buildChat(),
      memberIds: ['char-a', 'char-b'],
      relationshipLedger: [{
        pairKey: 'char-a->char-b',
        actorId: 'char-a',
        targetId: 'char-b',
        current: { warmth: 50, competence: 0, trust: 46, threat: 8 },
        derived: {
          semantic: {
            stage: '互相信任',
            labels: ['默契', '秘密暗号'],
            summary: '互相信任：共同秘密是雨夜便利店暗号，不能公开说',
            intensity: 62,
          },
        },
        trend: 'flat' as const,
        recentEvents: [],
        lastUpdatedAt: 30,
      }],
    };

    const prompt = buildSystemPromptWithContext(speaker, chat, 0, [
      buildMessage({ senderId: 'char-b', senderName: '阿远', content: '先别把话说太满。' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).not.toContain('## Relationship Semantics');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('Stance toward 阿远');
    expect(prompt).not.toContain('雨夜便利店');
    expect(prompt).not.toContain('不能公开说');
  });

  it('keeps legacy targeting and relationship influence blocks out of ordinary group prompts', () => {
    const speaker = buildCharacter({
      relationships: [{
        characterId: 'char-b',
        warmth: 50,
        competence: 10,
        trust: 46,
        threat: 8,
        note: '会替阿远留一点余地。',
      }],
      layeredMemories: [memory({
        id: 'group-target-memory',
        ownerId: 'char-a',
        subjectIds: ['char-b'],
        scope: 'relationship',
        text: '苏苏记得阿远之前帮她圆过场。',
        summary: '阿远之前帮她圆过场。',
      })],
    });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const chat = {
      ...buildChat(),
      memberIds: ['char-a', 'char-b'],
      relationshipLedger: [{
        pairKey: 'char-a->char-b',
        actorId: 'char-a',
        targetId: 'char-b',
        current: { warmth: 50, competence: 10, trust: 46, threat: 8 },
        derived: {
          semantic: {
            stage: '互相信任',
            labels: ['默契'],
            summary: '互相信任：默契',
            intensity: 62,
          },
        },
        trend: 'flat' as const,
        recentEvents: [],
        lastUpdatedAt: 30,
      }],
    };

    const prompt = buildSystemPromptWithContext(speaker, chat, 0, [
      buildMessage({ senderId: 'char-b', senderName: '阿远', content: '先别把话说太满。' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('Stance toward 阿远');
    expect(prompt).not.toContain('## Targeted Response Lens');
    expect(prompt).not.toContain('## Targeted Reply Rule');
    expect(prompt).not.toContain('## Targeted Influence Summary');
    expect(prompt).not.toContain('## Relationship Influence');
    expect(prompt).not.toContain('## Relationship Semantics');
    expect(prompt).not.toContain('## Memory Influence');
    expect(prompt).not.toContain('## Group Pressure');
  });

  it('lets the character mind projection own ordinary group reasoning, influence, and memory priority', () => {
    const speaker = buildCharacter({
      layeredMemories: [
        memory({
          id: 'cue-memory',
          archivedAt: null,
          text: '苏苏记得阿远上次主动给紧张的人留过台阶。',
          summary: '阿远上次主动给紧张的人留过台阶。',
          evidenceText: '阿远没有公开追问。',
          updatedAt: 50,
          recency: 0.9,
          privacyRisk: 0.05,
          visibility: 'public_safe',
        }),
      ],
    });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const prompt = buildSystemPromptWithContext(speaker, {
      ...buildChat(),
      mode: 'open_chat',
      memberIds: ['char-a', 'char-b'],
      sessionKind: {
        topology: 'group',
        family: 'conversation',
        scenarioId: 'open-chat',
        surfaceProfile: 'text',
      },
    }, 0, [
      buildMessage({ senderId: 'char-b', senderName: '阿远', content: '这杯茶先放这儿。' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('## Conversation Context');
    expect(prompt).not.toContain('Current room topic');
    expect(prompt).toContain('## Visible Recall Cues');
    expect(prompt).toContain('阿远上次主动给紧张的人留过台阶');
    expect(prompt).toContain('Visible rule');
    expect(prompt).not.toContain('## Group-Influenced Memories');
    expect(prompt).not.toContain('## Channel Bias');
    expect(prompt).not.toContain('## Influence Mode');
    expect(prompt).not.toContain('## Reasoning Bias');
    expect(prompt).not.toContain('## Memory Priority');
  });

  it('lets the character mind projection own ordinary group active conflict pressure', () => {
    const speaker = buildCharacter();
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const prompt = buildSystemPromptWithContext(speaker, {
      ...buildChat(),
      mode: 'open_chat',
      memberIds: ['char-a', 'char-b'],
      sessionKind: {
        topology: 'group',
        family: 'conversation',
        scenarioId: 'open-chat',
        surfaceProfile: 'text',
      },
      worldState: {
        ...buildChat().worldState,
        conflictState: {
          primaryConflict: {
            id: 'conflict-1',
            scope: 'group',
            type: 'value_conflict',
            severity: 0.82,
            stage: 'escalating',
            summary: '阿远被连续追问，气氛正在升高',
            participantIds: ['char-a'],
            targetIds: ['char-b'],
            nextPressure: 'cool',
            developmentHooks: ['invite_target_response'],
            sourceEventIds: ['event-1'],
            updatedAt: 50,
          },
          activeConflicts: [],
          developmentHooks: ['invite_target_response'],
          volatility: 0.6,
          cooling: 0.1,
          updatedAt: 50,
        },
      },
    }, 0, [
      buildMessage({ senderId: 'char-b', senderName: '阿远', content: '先别都压过来。' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('当前矛盾：阿远被连续追问，气氛正在升高');
    expect(prompt).toContain('矛盾阶段：escalating');
    expect(prompt).not.toContain('## Active Conflict');
  });

  it('keeps legacy active conflict prompts readable without exposing numeric severity', () => {
    const speaker = buildCharacter();
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const prompt = buildSystemPromptWithContext(speaker, {
      ...buildChat(),
      mode: 'werewolf',
      memberIds: ['char-a', 'char-b'],
      sessionKind: { topology: 'group', family: 'deduction', scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid' },
      worldState: {
        ...buildChat().worldState,
        conflictState: {
          primaryConflict: {
            id: 'conflict-1',
            scope: 'group',
            type: 'value_conflict',
            severity: 0.82,
            stage: 'escalating',
            summary: '阿远被连续追问，气氛正在升高',
            participantIds: ['char-a'],
            targetIds: ['char-b'],
            nextPressure: 'cool',
            developmentHooks: ['invite_target_response'],
            sourceEventIds: ['event-1'],
            updatedAt: 50,
          },
          activeConflicts: [],
          developmentHooks: ['invite_target_response'],
          volatility: 0.6,
          cooling: 0.1,
          updatedAt: 50,
        },
      },
    }, 0, [
      buildMessage({ senderId: 'char-b', senderName: '阿远', content: '先别都压过来。' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('## Active Conflict');
    expect(prompt).toContain('Intensity: high');
    expect(prompt).toContain('Summary: 阿远被连续追问，气氛正在升高');
    expect(prompt).not.toContain('Severity:');
    expect(prompt).not.toContain('0.82');
  });

  it('keeps shared secrets masked in public group prompts', () => {
    const speaker = buildCharacter({
      relationships: [{
        characterId: 'char-b',
        warmth: 72,
        competence: 10,
        trust: 86,
        threat: 0,
        note: '共同秘密是只有他们知道的暗号：雨夜便利店。',
      }],
    });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const chat = { ...buildChat(), memberIds: ['char-a', 'char-b'] };
    const prompt = buildSystemPromptWithContext(speaker, chat, 0, [buildMessage()], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('## Public Shared-Secret Guard');
    expect(prompt).toContain('一个只有熟人懂的暗号');
    expect(prompt).toContain('Do not reveal privateText');
    expect(prompt).not.toContain('雨夜便利店');

    const trace = buildPromptMemoryTrace(speaker, chat, [buildMessage()], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));
    expect(trace.sharedSecretGuards).toContain('群聊避嫌：一个只有熟人懂的暗号 · sealed');
  });

  it('allows pair-private shared secret recall in AI direct prompts', () => {
    const speaker = buildCharacter({
      relationships: [{
        characterId: 'char-b',
        warmth: 72,
        competence: 10,
        trust: 86,
        threat: 0,
        note: '共同秘密是只有他们知道的暗号：雨夜便利店。',
      }],
    });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const prompt = buildSystemPromptWithContext(speaker, buildAiDirectChat(), 0, [
      buildMessage({ senderId: 'char-b', senderName: '阿远', content: '你刚刚在群里怎么突然岔开话题？' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('## Pair-Private Shared Secrets');
    expect(prompt).toContain('雨夜便利店');
    expect(prompt).toContain('you may use these as subtext or recall them directly');

    const trace = buildPromptMemoryTrace(speaker, buildAiDirectChat(), [
      buildMessage({ senderId: 'char-b', senderName: '阿远', content: '你刚刚在群里怎么突然岔开话题？' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));
    expect(trace.sharedSecretGuards).toContain('AI私聊可召回：阿远 · 一个只有熟人懂的暗号 · sealed');
  });

  it('uses user shared anchors as high-priority private-channel memory candidates', () => {
    const speaker = buildCharacter();
    const sharedAnchorEvent: RuntimeEventV2 = {
      id: 'evt-user-shared-anchor',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 1_000,
      actorIds: ['user'],
      targetIds: ['char-a'],
      summary: '苏苏记录了一次深夜陪伴。',
      visibility: 'pair_private',
      eventClass: 'artifact',
      payload: {
        eventType: 'companionship_shared_anchor',
        characterId: 'char-a',
        userId: 'user',
        anchorId: 'late-night-care',
        action: 'upsert',
        kind: 'first_time',
        participantIds: ['char-a', 'user'],
        title: '第一次深夜陪伴',
        text: '第一次深夜聊天后，苏苏记住了用户没有离开。',
        evidence: '用户那晚陪苏苏聊到很晚。',
        salience: 86,
        confidence: 0.92,
        decisionSource: 'model',
      },
    };
    const chat = {
      ...buildDirectChat(),
      runtimeEventsV2: [sharedAnchorEvent],
      updatedAt: 1_200,
    };
    const messages = [buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '今晚又想起那次深夜聊天。', timestamp: 1_300 })];
    const characters = new Map([[speaker.id, speaker]]);

    const trace = buildPromptMemoryTrace(speaker, chat, messages, characters);
    const prompt = buildSystemPromptWithContext(speaker, chat, 0, messages, characters);

    expect(trace.injectedIds).toContain('companionship-anchor-memory-runtime-anchor-late-night-care');
    expect(prompt).toContain('第一次深夜陪伴');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('## Companionship Context');
    expect(prompt).not.toContain('Private-Channel Memories');
  });

  it('uses active user profile events as private-channel memory candidates and respects revoke events', () => {
    const speaker = buildCharacter();
    const profileEvent: RuntimeEventV2 = {
      id: 'evt-user-profile-pressure',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 1_000,
      actorIds: ['user'],
      targetIds: ['char-a'],
      summary: '苏苏记录了用户最近面试压力很大。',
      visibility: 'pair_private',
      eventClass: 'artifact',
      evidenceMessageIds: ['msg-profile-source'],
      payload: {
        eventType: 'companionship_user_profile_memory',
        characterId: 'char-a',
        userId: 'user',
        action: 'upsert',
        items: [{
          kind: 'pressure_source',
          text: '用户这周因为面试压力很大',
          evidence: '用户说这周面试压得睡不好。',
          sourceMessageIds: ['msg-profile-source'],
          confidence: 0.92,
          sensitive: true,
        }],
        reason: 'model extracted a sensitive user profile cue',
        sourceMessageIds: ['msg-profile-source'],
        confidence: 0.92,
        decisionSource: 'model',
      },
    };
    const chat = {
      ...buildDirectChat(),
      runtimeEventsV2: [profileEvent],
      updatedAt: 1_200,
    };
    const messages = [buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '我这周面试压力还是很大。', timestamp: 1_300 })];
    const characters = new Map([[speaker.id, speaker]]);

    const trace = buildPromptMemoryTrace(speaker, chat, messages, characters);
    const prompt = buildSystemPromptWithContext(speaker, chat, 0, messages, characters);

    expect(trace.injectedIds.some((id) => id.startsWith('companionship-user-profile-memory-char-a-pressure_source'))).toBe(true);
    expect(prompt).toContain('用户这周因为面试压力很大');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).toContain('## Companionship Context');
    expect(prompt).not.toContain('Private-Channel Memories');

    const revokedChat = {
      ...chat,
      runtimeEventsV2: [
        profileEvent,
        {
          ...profileEvent,
          id: 'evt-user-profile-pressure-revoked',
          createdAt: 1_100,
          summary: '用户撤回了面试压力画像。',
          payload: {
            ...profileEvent.payload,
            action: 'revoke',
          },
        } as RuntimeEventV2,
      ],
    };
    const revokedTrace = buildPromptMemoryTrace(speaker, revokedChat, messages, characters);
    const revokedPrompt = buildSystemPromptWithContext(speaker, revokedChat, 0, messages, characters);

    expect(revokedTrace.injectedIds.some((id) => id.startsWith('companionship-user-profile-memory-char-a-pressure_source'))).toBe(false);
    expect(revokedPrompt).not.toContain('pressure source: 用户这周因为面试压力很大');
  });

  it('uses AI pair shared anchors as pair-thread memory candidates', () => {
    const speaker = buildCharacter();
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const sharedAnchorEvent: RuntimeEventV2 = {
      id: 'evt-ai-pair-anchor',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 1_000,
      actorIds: ['char-a'],
      targetIds: ['char-b'],
      summary: '苏苏和阿远记录了一次和解。',
      visibility: 'role_private',
      eventClass: 'artifact',
      payload: {
        eventType: 'companionship_shared_anchor',
        characterId: 'char-a',
        anchorId: 'pair-repair',
        action: 'upsert',
        kind: 'repair',
        participantIds: ['char-a', 'char-b'],
        title: '雨夜后的和解',
        text: '雨夜误会之后，苏苏和阿远说好下次先把话说清楚。',
        evidence: '阿远主动解释了失约原因。',
        salience: 78,
        confidence: 0.88,
        decisionSource: 'model',
      },
    };
    const chat = {
      ...buildAiDirectChat(),
      runtimeEventsV2: [sharedAnchorEvent],
      updatedAt: 1_200,
    };
    const messages = [buildMessage({ senderId: 'char-b', senderName: '阿远', content: '雨夜那件事，我还是想解释一下。', timestamp: 1_300 })];
    const characters = new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]);

    const trace = buildPromptMemoryTrace(speaker, chat, messages, characters);
    const prompt = buildSystemPromptWithContext(speaker, chat, 0, messages, characters);

    expect(trace.injectedIds).toContain('companionship-anchor-memory-runtime-anchor-pair-repair');
    expect(trace.targetActorId).toBe('char-b');
    expect(prompt).toContain('雨夜后的和解');
    expect(prompt).toContain('## Character Mind Projection');
    expect(prompt).not.toContain('Pair-Thread Memories');
  });

  it('exposes archived memories that were actually injected into the prompt trace', () => {
    const speaker = buildCharacter({ layeredMemories: [memory()] });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const chat = { ...buildChat(), memberIds: ['char-a', 'char-b'] };
    const message = buildMessage() as Message & { addressedTargetIds: string[]; primaryAddressedTargetId: string };
    message.addressedTargetIds = [speaker.id];
    message.primaryAddressedTargetId = speaker.id;
    const trace = buildPromptMemoryTrace(speaker, chat, [message], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(trace.injectedIds).toContain('old-memory');
    expect(trace.recalledArchives[0]).toMatchObject({
      id: 'old-memory',
      recallReason: expect.stringContaining('旧档'),
    });
  });

  it('keeps memory ids and recall scores out of visible legacy memory cue prompts', () => {
    const speaker = buildCharacter({ layeredMemories: [memory()] });
    const target = buildCharacter({ id: 'char-b', name: '阿远' });
    const chat = {
      ...buildChat(),
      mode: 'werewolf' as const,
      memberIds: ['char-a', 'char-b'],
      sessionKind: { topology: 'group' as const, family: 'deduction' as const, scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid' as const },
    };
    const message = buildMessage() as Message & { addressedTargetIds: string[]; primaryAddressedTargetId: string };
    message.addressedTargetIds = [speaker.id];
    message.primaryAddressedTargetId = speaker.id;
    const prompt = buildSystemPromptWithContext(speaker, chat, 0, [message], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('## Group-Influenced Memories');
    expect(prompt).toContain('Visible rule');
    expect(prompt).toContain('雨夜失约');
    expect(prompt).not.toContain('old-memory');
    expect(prompt).not.toContain('score=');
    expect(prompt).not.toContain('[natural');
    expect(prompt).not.toContain('[implicit');
  });

  it('prioritizes the person named by human guidance over the latest AI speaker', () => {
    const speaker = buildCharacter({
      id: 'char-a',
      name: '苏苏',
      layeredMemories: [
        memory({
          id: 'about-target',
          ownerId: 'char-a',
          subjectIds: ['char-c'],
          text: '苏苏记得林北上次替她挡了一句难听话。',
          summary: '林北曾替苏苏解围。',
          archivedAt: 10,
        }),
        memory({
          id: 'about-latest-speaker',
          ownerId: 'char-a',
          subjectIds: ['char-b'],
          text: '苏苏记得阿远昨天跑题。',
          summary: '阿远昨天跑题。',
          archivedAt: null,
          salience: 0.95,
          confidence: 0.95,
          recency: 1,
        }),
      ],
    });
    const latestSpeaker = buildCharacter({ id: 'char-b', name: '阿远' });
    const namedTarget = buildCharacter({ id: 'char-c', name: '林北' });
    const chat = { ...buildChat(), memberIds: ['char-a', 'char-b', 'char-c'] };
    const trace = buildPromptMemoryTrace(speaker, chat, [
      buildMessage({ id: 'ai-latest', senderId: 'char-b', senderName: '阿远', content: '继续刚才那个梗。', timestamp: 2 }),
      buildMessage({ id: 'user-guidance', type: 'god', senderId: 'user', senderName: '开发者', content: '苏苏说说你怎么看林北', timestamp: 3, metadata: { runtimeDecision: { directorIntent: { source: 'user_message', beatType: 'answer', targetActorIds: ['char-a'], userGuidance: { kind: 'direct_reply', rawText: '苏苏说说你怎么看林北', actorIds: ['char-a'], mentionedActorIds: ['char-c'], focusText: '你怎么看林北', beatType: 'answer', pressure: 0.7, maxTurns: 1 } } } } }),
    ], new Map([
      [speaker.id, speaker],
      [latestSpeaker.id, latestSpeaker],
      [namedTarget.id, namedTarget],
    ]));

    expect(trace.injectedIds).toContain('about-target');
    expect(trace).toMatchObject({
      targetActorId: 'char-c',
      targetActorName: '林北',
      targetReason: '来自人工点名中的被谈论对象',
    });
    expect(trace.recalledArchives[0]).toMatchObject({
      id: 'about-target',
      recallReason: expect.stringContaining('旧档'),
    });
  });

  it('builds a compact character mind trace without private memory text', () => {
    const speaker = buildCharacter({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户下周要面试，希望别被公开点名。'],
      },
    });
    const groupWithUser = { ...buildChat(), memberIds: ['char-a', 'user'] };
    const trace = buildPromptCharacterMindTrace(speaker, groupWithUser, [
      buildMessage({ type: 'user', senderId: 'user', senderName: '用户', content: '我也在群里听着。' }),
    ], new Map([[speaker.id, speaker]]));

    expect(trace).toMatchObject({
      visibility: 'public',
      memorySource: 'assembly_candidates',
      omittedPrivateContinuity: true,
      hasUserContinuity: true,
    });
    expect(JSON.stringify(trace)).not.toContain('面试');
    expect(JSON.stringify(trace)).not.toContain('公开点名');
  });

  it('builds prompt, memory trace, and character mind trace from one assembly path', () => {
    const speaker = buildCharacter({
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户下周要面试，希望别被公开点名。'],
      },
      layeredMemories: [memory({
        id: 'shared-thread',
        ownerId: 'char-a',
        scope: 'relationship',
        subjectIds: ['char-b'],
        text: '对林北有一次被维护后的关系余温。',
        summary: '被林北维护过，关系更柔和。',
      })],
    });
    const target = buildCharacter({ id: 'char-b', name: '林北' });
    const chat = { ...buildChat(), memberIds: ['char-a', 'char-b', 'user'] };
    const messages = [
      buildMessage({ senderId: 'char-b', senderName: '林北', content: '刚才那句话你怎么看？' }),
    ];
    const characters = new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]);
    const assembly = buildPromptAssemblyWithContext(speaker, chat, 0, messages, characters);

    expect(assembly.systemPrompt).toBe(buildSystemPromptWithContext(speaker, chat, 0, messages, characters));
    expect(assembly.memoryTrace.targetActorName).toBe('林北');
    expect(assembly.characterMindTrace).toMatchObject({
      visibility: 'public',
      memorySource: 'assembly_candidates',
      targetActorName: '林北',
      hasUserContinuity: true,
      omittedPrivateContinuity: true,
    });
    expect(JSON.stringify(assembly.characterMindTrace)).not.toContain('面试');
  });

  it('uses media request subjects as targeted memory subjects instead of only the sender', () => {
    const sender = buildCharacter({
      id: 'char-a',
      name: '美羊羊',
      relationships: [{
        characterId: 'char-c',
        warmth: 24,
        competence: 8,
        trust: 20,
        threat: 0,
        note: '愿意替灰太狼留一点余地。',
      }],
      layeredMemories: [memory({
        id: 'gray-wolf-portrait-memory',
        ownerId: 'char-a',
        subjectIds: ['char-c'],
        text: '美羊羊记得灰太狼特别在意胡子有没有画歪。',
        summary: '灰太狼很在意胡子是否对称。',
        archivedAt: 10,
      })],
    });
    const latestSpeaker = buildCharacter({ id: 'char-b', name: '懒羊羊' });
    const subject = buildCharacter({ id: 'char-c', name: '灰太狼' });
    const chat = { ...buildChat(), memberIds: ['char-a', 'char-b', 'char-c'] };
    const trace = buildPromptMemoryTrace(sender, chat, [
      buildMessage({ id: 'ai-latest', senderId: 'char-b', senderName: '懒羊羊', content: '我想继续聊零食。', timestamp: 2 }),
      buildMessage({ id: 'user-image', type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 3, metadata: { runtimeDecision: { directorIntent: { source: 'user_message', beatType: 'answer', targetActorIds: ['char-a'], userGuidance: { kind: 'media_request', rawText: '美羊羊发个灰太狼证件照的图片', actorIds: ['char-a'], mentionedActorIds: ['char-c'], focusText: '灰太狼证件照', beatType: 'answer', pressure: 0.9, maxTurns: 1, mediaRequest: { kind: 'image', subjectActorIds: ['char-c'], subjectText: '灰太狼', actionText: '发证件照' } } } } } }),
    ], new Map([
      [sender.id, sender],
      [latestSpeaker.id, latestSpeaker],
      [subject.id, subject],
    ]));
    const prompt = buildSystemPromptWithContext(sender, chat, 0, [
      buildMessage({ id: 'ai-latest', senderId: 'char-b', senderName: '懒羊羊', content: '我想继续聊零食。', timestamp: 2 }),
      buildMessage({ id: 'user-image', type: 'god', senderId: 'user', senderName: '开发者', content: '美羊羊发个灰太狼证件照的图片', timestamp: 3, metadata: { runtimeDecision: { directorIntent: { source: 'user_message', beatType: 'answer', targetActorIds: ['char-a'], userGuidance: { kind: 'media_request', rawText: '美羊羊发个灰太狼证件照的图片', actorIds: ['char-a'], mentionedActorIds: ['char-c'], focusText: '灰太狼证件照', beatType: 'answer', pressure: 0.9, maxTurns: 1, mediaRequest: { kind: 'image', subjectActorIds: ['char-c'], subjectText: '灰太狼', actionText: '发证件照' } } } } } }),
    ], new Map([
      [sender.id, sender],
      [latestSpeaker.id, latestSpeaker],
      [subject.id, subject],
    ]));

    expect(trace.injectedIds).toContain('gray-wolf-portrait-memory');
    expect(trace).toMatchObject({
      targetActorId: 'char-c',
      targetActorName: '灰太狼',
      targetReason: '来自人工发图请求的图片对象',
    });
    expect(trace.recalledArchives[0]?.summary).toContain('灰太狼');
    expect(prompt).toContain('Stance toward 灰太狼');
    expect(prompt).not.toContain('Stance toward 懒羊羊');
  });

  it('injects readable memory context into generation prompts without raw ids or enum labels', () => {
    const speaker = buildCharacter({
      id: leakySpeakerId,
      name: '喜羊羊',
      layeredMemories: [memory({
        id: 'leaky-memory',
        ownerId: leakySpeakerId,
        subjectIds: [leakyTargetId],
        scope: 'relationship',
        layer: 'long_term',
        kind: 'status_shift',
        text: `${leakySpeakerId} 在 status_shift 后开始回避 ${leakyTargetId}`,
        evidenceText: `source events: ${leakySpeakerId} relationship_delta ${leakyTargetId}`,
        sourceTag: 'unknown_internal_source',
        archivedAt: null,
        salience: 0.95,
        confidence: 0.92,
        recency: 0.9,
        privacyRisk: 0.05,
        visibility: 'public_safe',
      })],
    });
    const target = buildCharacter({ id: leakyTargetId, name: '灰太狼' });
    const chat = { ...buildChat(), memberIds: [leakySpeakerId, leakyTargetId] };
    const prompt = buildSystemPromptWithContext(speaker, chat, 0, [
      buildMessage({ senderId: leakyTargetId, senderName: '灰太狼', content: '你刚才是不是又躲开了？' }),
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(prompt).toContain('喜羊羊');
    expect(prompt).toContain('灰太狼');
    expect(prompt).toContain('state shift');
    expect(prompt).not.toContain(leakySpeakerId);
    expect(prompt).not.toContain(leakyTargetId);
    expect(prompt).not.toContain('status_shift');
    expect(prompt).not.toContain('relationship_delta');
    expect(prompt).not.toContain('source events');
    expect(prompt).not.toContain('unknown_internal_source');
    expect(prompt).not.toContain('[relationship/');
  });

  it('sanitizes recalled memory trace summaries while keeping structural trace fields', () => {
    const speaker = buildCharacter({
      id: leakySpeakerId,
      name: '喜羊羊',
      layeredMemories: [memory({
        id: 'archived-leaky-memory',
        ownerId: leakySpeakerId,
        subjectIds: [leakyTargetId],
        scope: 'relationship',
        layer: 'long_term',
        kind: 'status_shift',
        text: `${leakySpeakerId} 因 status_shift 记住了 ${leakyTargetId} 的追问`,
        summary: `${leakyTargetId} 记得那次追问`,
        sourceTag: 'unknown_internal_source',
        archivedAt: 10,
      })],
    });
    const target = buildCharacter({ id: leakyTargetId, name: '灰太狼' });
    const chat = { ...buildChat(), memberIds: [leakySpeakerId, leakyTargetId] };
    const message = buildMessage({ senderId: leakyTargetId, senderName: '灰太狼', content: '你还记得那次追问吗？' }) as Message & {
      addressedTargetIds: string[];
      primaryAddressedTargetId: string;
    };
    message.addressedTargetIds = [speaker.id];
    message.primaryAddressedTargetId = speaker.id;
    const trace = buildPromptMemoryTrace(speaker, chat, [
      message,
    ], new Map([
      [speaker.id, speaker],
      [target.id, target],
    ]));

    expect(trace.recalledArchives[0]).toMatchObject({
      id: 'archived-leaky-memory',
      scope: 'relationship',
      kind: 'status_shift',
      layer: 'long_term',
    });
    expect(trace.recalledArchives[0].summary).toContain('灰太狼');
    expect(trace.recalledArchives[0].summary).not.toContain(leakySpeakerId);
    expect(trace.recalledArchives[0].summary).not.toContain(leakyTargetId);
    expect(trace.recalledArchives[0].summary).not.toContain('status_shift');
  });
});
