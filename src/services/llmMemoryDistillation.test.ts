import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AICharacter } from '../types/character';
import { normalizeConversation, type GroupChat } from '../types/chat';
import { DEFAULT_API_CONFIG } from '../types/settings';
import type { MemoryItem } from './memoryTypes';
import { buildLlmDistillationSource, distillChatMemoriesWithLlm, mergeCoreProfilePatch, shouldRunLlmCharacterDistillation, shouldRunLlmChatDistillation } from './llmMemoryDistillation';

const generateJsonResponseMock = vi.fn();

vi.mock('./aiClient', () => ({
  generateJsonResponse: (...args: unknown[]) => generateJsonResponseMock(...args),
}));

function buildChat(layeredMemories: MemoryItem[]): GroupChat {
  return normalizeConversation({
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '群聊',
    topic: '测试',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['char-a', 'char-b', 'char-c', 'char-d', 'char-e'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    layeredMemories,
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

function buildRuntimeMemoryItem(args: {
  id: string;
  subjectIds: string[];
  eventIds: string[];
  updatedAt: number;
  layer?: MemoryItem['layer'];
  sourceTag?: string;
  scope?: MemoryItem['scope'];
}): MemoryItem {
  return {
    id: args.id,
    ownerId: 'chat-1',
    scope: args.scope || 'relationship',
    layer: args.layer || 'episodic',
    kind: 'resentment',
    subjectIds: args.subjectIds,
    text: `${args.id}-evidence`,
    evidenceText: `${args.id} 的完整原始对话证据：这是一段比摘要更完整的互动原文`,
    salience: 0.82,
    confidence: 0.85,
    recency: 0.92,
    reinforcementCount: 1,
    sourceEventIds: args.eventIds,
    sourceTag: args.sourceTag || 'interaction',
    origin: 'runtime',
    createdAt: args.updatedAt - 50,
    updatedAt: args.updatedAt,
  };
}

function buildLlmMemoryItem(eventIds: string[], distilledAt: number, distilledFromIds: string[]): MemoryItem {
  return {
    id: 'llm-1',
    ownerId: 'chat-1',
    scope: 'relationship',
    layer: 'long_term',
    kind: 'resentment',
    subjectIds: ['char-a', 'char-b'],
    text: '长期拉扯主线',
    salience: 0.9,
    confidence: 0.88,
    recency: 1,
    reinforcementCount: 1,
    sourceEventIds: eventIds,
    sourceTag: 'llm_memory_distillation',
    origin: 'distilled',
    distilledFromIds,
    distilledAt,
    distillationVersion: 'llm-v2',
    createdAt: distilledAt,
    updatedAt: distilledAt,
  };
}

function buildRuntimeBatch(args: {
  prefix: string;
  eventStart: number;
  count: number;
  updatedAt: number;
  eventsPerItem?: number;
}) {
  const subjectPatterns = [
    ['char-a', 'char-b'],
    ['char-a', 'char-c'],
    ['char-b', 'char-d'],
    ['char-c', 'char-e'],
  ];
  const eventsPerItem = args.eventsPerItem || 1;
  return Array.from({ length: args.count }, (_, index) => {
    const start = args.eventStart + (index * eventsPerItem);
    const eventIds = Array.from({ length: eventsPerItem }, (__unused, offset) => `evt-${start + offset}`);
    return buildRuntimeMemoryItem({
      id: `${args.prefix}-${index + 1}`,
      subjectIds: subjectPatterns[index % subjectPatterns.length],
      eventIds,
      updatedAt: args.updatedAt,
    });
  });
}

describe('llmMemoryDistillation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tracks the full source event coverage in chat LLM distillation candidates', async () => {
    generateJsonResponseMock.mockResolvedValue(JSON.stringify({
      items: [
        {
          scope: 'relationship',
          kind: 'resentment',
          subjectIds: ['char-a', 'char-b'],
          text: '红太狼和沸羊羊长期互相顶牛。',
          confidence: 0.84,
          sharedPhrase: {
            text: '这回算我欠你的',
            kind: 'promise_line',
            visibility: 'between_actors',
          },
        },
      ],
    }));
    const source = buildRuntimeBatch({ prefix: 'seed', eventStart: 1, count: 18, updatedAt: 200, eventsPerItem: 1 });
    const chat = buildChat(source);

    const result = await distillChatMemoriesWithLlm(DEFAULT_API_CONFIG, chat, { now: 1777000000000 });

    expect(generateJsonResponseMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.sourceEventIds).toEqual(expect.arrayContaining(source.map((item) => item.sourceEventIds[0])));
    expect(new Set(result[0]?.sourceEventIds || []).size).toBe(18);
    expect(result[0]?.distilledAt).toBe(1777000000000);
    expect(result[0]?.evidenceText).toContain('完整原始对话证据');
    expect(result[0]?.sharedPhrase).toEqual({
      text: '这回算我欠你的',
      kind: 'promise_line',
      visibility: 'between_actors',
    });
    expect(generateJsonResponseMock.mock.calls[0]?.[2]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: expect.stringContaining('原始证据'),
      }),
    ]));
  });

  it('keeps character self experience available to the character distillation path', () => {
    const selfItems = buildRuntimeBatch({ prefix: 'self', eventStart: 500, count: 8, updatedAt: 600 })
      .map((item) => ({ ...item, scope: 'character_self' as const, kind: 'trait_evidence' as const }));
    expect(buildLlmDistillationSource({ layeredMemories: selfItems }, 'character')).toHaveLength(8);
    expect(buildLlmDistillationSource({ layeredMemories: selfItems }, 'chat')).toEqual([]);
  });

  it('allows real character self sources through the character distillation thresholds', () => {
    const selfItems = buildRuntimeBatch({ prefix: 'self-source', eventStart: 700, count: 8, updatedAt: 800, eventsPerItem: 2 })
      .map((item) => ({
        ...item,
        ownerId: 'char-a',
        scope: 'character_self' as const,
        kind: 'trait_evidence' as const,
        sourceTag: 'self_expression',
        subjectIds: undefined,
      }));
    expect(shouldRunLlmCharacterDistillation({ id: 'char-a', layeredMemories: selfItems } as AICharacter, 0)).toBe(true);
    expect(shouldRunLlmChatDistillation(buildChat(selfItems), 0)).toBe(false);
  });

  it('accepts multi-lens experience analysis results as memory candidates', async () => {
    generateJsonResponseMock.mockResolvedValue(JSON.stringify({
      objectiveEvents: [
        {
          scope: 'conversation',
          kind: 'conflict',
          subjectIds: ['char-a', 'char-b'],
          text: '群聊围绕谁有资格评价发明形成了持续拉扯。',
          confidence: 0.86,
          decision: 'create',
        },
      ],
      relationshipImprints: [
        {
          scope: 'relationship',
          kind: 'resentment',
          subjectIds: ['char-a', 'char-b'],
          text: '红太狼开始把沸羊羊视为总爱拆台的人，戒备和厌烦都在加重。',
          confidence: 0.88,
          decision: 'reinforce',
        },
      ],
      emotionEffects: [
        {
          scope: 'conversation',
          kind: 'status_shift',
          subjectIds: ['char-a', 'char-b'],
          text: '群聊里围绕发明的玩笑留下了防御和看热闹并存的情绪惯性。',
          confidence: 0.8,
          decision: 'create',
        },
      ],
    }));
    const source = buildRuntimeBatch({ prefix: 'lens', eventStart: 30, count: 18, updatedAt: 400, eventsPerItem: 1 });
    const chat = buildChat(source);

    const result = await distillChatMemoriesWithLlm(DEFAULT_API_CONFIG, chat);

    expect(result).toHaveLength(3);
    expect(result.map((item) => item.sourceTag)).toEqual([
      'llm_memory_objective_event',
      'llm_memory_relationship_imprint',
      'llm_memory_emotion_effect',
    ]);
    expect(result.map((item) => item.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('持续拉扯'),
      expect.stringContaining('戒备和厌烦'),
      expect.stringContaining('情绪惯性'),
    ]));
  });

  it('keeps multiple subject-specific LLM memories with normalized recall metadata', async () => {
    generateJsonResponseMock.mockResolvedValue(JSON.stringify({
      relationshipImprints: [
        {
          scope: 'relationship',
          kind: 'bond',
          subjectIds: ['char-a', 'char-b'],
          text: '甲开始把乙当作能在关键时刻接住自己的人。',
          confidence: 0.88,
          decision: 'create',
          semanticTags: ['信任', '互相支持'],
          associations: ['求助', '配合', '关键时刻', '站边', '安全感', '复盘', '任务', '聊天', '关系', '靠得住'],
        },
        {
          scope: 'relationship',
          kind: 'resentment',
          subjectIds: ['char-c', 'char-d'],
          text: '丙对丁的玩笑开始形成稳定戒备。',
          confidence: 0.82,
          decision: 'create',
          visibility: 'private',
          privacyRisk: 0.4,
          validity: 'active',
        },
        {
          scope: 'relationship',
          kind: 'bond',
          subjectIds: ['char-e', 'char-a'],
          text: '戊和甲形成了轻松互相递话的默契。',
          confidence: 0.8,
          decision: 'create',
        },
        {
          scope: 'relationship',
          kind: 'resentment',
          subjectIds: ['char-b', 'char-c'],
          text: '乙开始厌烦丙总在公开场合抢话。',
          confidence: 0.81,
          decision: 'create',
        },
        {
          scope: 'conversation',
          kind: 'status_shift',
          subjectIds: ['char-a', 'char-b', 'char-c'],
          text: '群聊在互相维护与拆台之间形成了新的站队惯性。',
          confidence: 0.84,
          decision: 'create',
        },
        {
          scope: 'relationship',
          kind: 'bond',
          subjectIds: ['char-d', 'char-e'],
          text: '丁和戊在连续配合后形成了低调同盟。',
          confidence: 0.79,
          decision: 'create',
        },
        {
          scope: 'relationship',
          kind: 'bond',
          subjectIds: ['char-x', 'char-y'],
          text: '超过上限的第七条不应进入候选。',
          confidence: 0.79,
          decision: 'create',
        },
      ],
    }));
    const source = buildRuntimeBatch({ prefix: 'multi', eventStart: 70, count: 18, updatedAt: 600, eventsPerItem: 1 });
    const chat = buildChat(source);

    const result = await distillChatMemoriesWithLlm(DEFAULT_API_CONFIG, chat, { now: 1777000000000 });

    expect(result).toHaveLength(6);
    expect(result.map((item) => item.subjectIds?.join(':'))).toEqual(expect.arrayContaining([
      'char-a:char-b',
      'char-c:char-d',
      'char-e:char-a',
      'char-b:char-c',
      'char-a:char-b:char-c',
      'char-d:char-e',
    ]));
    expect(result.map((item) => item.text).join('\n')).not.toContain('第七条');
    const first = result.find((item) => item.subjectIds?.join(':') === 'char-a:char-b');
    expect(first?.subjectOwner).toBe('target');
    expect(first?.sourceType).toBe('distilled');
    expect(first?.visibility).toBe('pair_private');
    expect(first?.validity).toBe('active');
    expect(first?.privacyRisk).toBeGreaterThan(0);
    expect(first?.semanticTags).toEqual(expect.arrayContaining(['信任', '互相支持']));
    expect(first?.associations?.length).toBeLessThanOrEqual(12);
    const privateItem = result.find((item) => item.subjectIds?.join(':') === 'char-c:char-d');
    expect(privateItem?.visibility).toBe('private');
    expect(privateItem?.privacyRisk).toBe(0.4);
  });

  it('does not rerun chat LLM distillation when post-distillation updates only reuse covered evidence', () => {
    const coveredSource = buildRuntimeBatch({ prefix: 'covered', eventStart: 1, count: 12, updatedAt: 3200, eventsPerItem: 2 });
    const coveredEventIds = Array.from(new Set(coveredSource.flatMap((item) => item.sourceEventIds)));
    const latestLlmItem = buildLlmMemoryItem(coveredEventIds, 3000, coveredSource.map((item) => item.id));
    const chat = buildChat([latestLlmItem, ...coveredSource]);

    expect(shouldRunLlmChatDistillation(chat, 0)).toBe(false);
  });

  it('reruns chat LLM distillation only after enough truly new evidence accumulates', () => {
    const seenEventIds = Array.from({ length: 18 }, (_, index) => `evt-${index + 1}`);
    const latestLlmItem = buildLlmMemoryItem(seenEventIds, 3000, ['old-1', 'old-2']);
    const novelSource = buildRuntimeBatch({ prefix: 'novel', eventStart: 19, count: 12, updatedAt: 3600, eventsPerItem: 2 });
    const chat = buildChat([latestLlmItem, ...novelSource]);

    expect(shouldRunLlmChatDistillation(chat, 0)).toBe(true);
  });

  it('excludes raw runtime evidence from LLM distillation source', () => {
    const rawRelationshipDelta = {
      ...buildRuntimeMemoryItem({
        id: 'runtime-delta',
        subjectIds: ['char-a', 'char-b'],
        eventIds: ['evt-runtime'],
        updatedAt: 500,
        sourceTag: 'relationship_delta',
      }),
    };
    const rawRoomShift = {
      ...buildRuntimeMemoryItem({
        id: 'runtime-room',
        subjectIds: ['char-a'],
        eventIds: ['evt-room'],
        updatedAt: 501,
        scope: 'system_runtime',
        layer: 'working',
        sourceTag: 'room_shift',
      }),
    };

    expect(buildLlmDistillationSource({ layeredMemories: [rawRelationshipDelta, rawRoomShift] })).toEqual([]);
  });

  it('merges LLM core profile patches without dropping manual anchors or legacy fields', () => {
    const merged = mergeCoreProfilePatch({
      coreDesire: '想被认真当成可靠的人。',
      coreFear: '害怕被轻视。',
      socialMask: '用逞强保护自己。',
      valuePriority: ['可靠'],
      biases: ['容易把沉默理解为否定'],
      interactionHabits: ['先追问再表态'],
      expressionHabits: ['旧的表达观察'],
    }, {
      coreDesire: '',
      values: ['可靠', '被认可'],
      perceptionBiases: ['容易把玩笑听成挑衅'],
      sensitivities: ['被当众否定'],
      attachmentStyle: '越在意越会试探。',
      conflictStyle: '被压过时会追问和反驳。',
      unmetNeeds: ['稳定的认可'],
      selfImage: '觉得自己应该撑住场面。',
      hiddenSoftSpots: ['被真诚维护时会动摇'],
      expressionHabits: ['熟人面前会把犹豫拆成两句补发', '被逼问时先停半句再回答'],
    });

    expect(merged.coreDesire).toBe('想被认真当成可靠的人。');
    expect(merged.coreFear).toBe('害怕被轻视。');
    expect(merged.socialMask).toBe('用逞强保护自己。');
    expect(merged.values).toEqual(['可靠', '被认可']);
    expect(merged.valuePriority).toEqual(merged.values);
    expect(merged.perceptionBiases).toEqual(['容易把沉默理解为否定', '容易把玩笑听成挑衅']);
    expect(merged.biases).toEqual(merged.perceptionBiases);
    expect(merged.sensitivities).toContain('被当众否定');
    expect(merged.attachmentStyle).toContain('试探');
    expect(merged.unmetNeeds).toContain('稳定的认可');
    expect(merged.hiddenSoftSpots?.some((item) => item.includes('真诚维护'))).toBe(true);
    expect(merged.expressionHabits).toEqual(['熟人面前会把犹豫拆成两句补发', '被逼问时先停半句再回答']);
  });
});
