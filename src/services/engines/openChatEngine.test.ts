import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openChatEngine } from './openChatEngine';
import { normalizeConversation } from '../../types/chat';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CHARACTER_MEMORY, DEFAULT_CHARACTER_INTERVENTION, DEFAULT_EMOTIONAL_STATE, type AICharacter } from '../../types/character';
import { DEFAULT_API_CONFIG, DEFAULT_COMPANIONSHIP_SETTINGS } from '../../types/settings';
import type { DriverMessageCommitResult } from '../../types/chat';
import type { RuntimeEventV2, SocialEventCandidatePayload, SocialEventHintEnvelope } from '../../types/runtimeEvent';
import { setAIGenerationRuntimeConfig } from '../aiGenerationRuntimeConfig';
import { setCompanionshipRuntimeConfig } from '../companionshipRuntimeConfig';

const generateResponseMock = vi.fn();
const generateJsonResponseMock = vi.fn();
type OpenChatCommittedMessageForTest = Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'] & {
  socialEventHints?: SocialEventHintEnvelope[] | null;
};

vi.mock('../aiClient', () => ({
  generateResponse: (...args: unknown[]) => generateResponseMock(...args),
  generateJsonResponse: (...args: unknown[]) => generateJsonResponseMock(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
  generateResponseMock.mockReset();
  generateJsonResponseMock.mockReset();
  setAIGenerationRuntimeConfig({ enableMoments: true, enableDiaries: true });
  setCompanionshipRuntimeConfig(DEFAULT_COMPANIONSHIP_SETTINGS);
});

afterEach(() => {
  vi.useRealTimers();
});

function buildApiConfig() {
  return {
    ...DEFAULT_API_CONFIG,
    apiKey: 'test-key',
  };
}

function buildChat(patch: Partial<ReturnType<typeof normalizeConversation>> = {}) {
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
    memberIds: ['a', 'b', 'user'],
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
    ...patch,
  });
}

function buildCharacter(id: string, name: string, patch: Partial<AICharacter> = {}): AICharacter {
  return {
    id,
    name,
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
    emotionalState: DEFAULT_EMOTIONAL_STATE,
    relationships: [],
    layeredMemories: [],
    background: '',
    speakingStyle: '',
    expertise: [],
    coreProfile: { coreDesire: '', coreFear: '', valuePriority: [], socialMask: '', biases: [], interactionHabits: [] },
    group: '',
    behavior: DEFAULT_CHARACTER_BEHAVIOR,
    memory: DEFAULT_CHARACTER_MEMORY,
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
    ...patch,
  };
}

function readRuntimeEvents(result: DriverMessageCommitResult) {
  return result.chatPatch.runtimeEventsV2 || result.chatRuntimeDelta?.runtimeEventsV2?.upserts || [];
}

function applyResultToChat(chat: ReturnType<typeof buildChat>, result: DriverMessageCommitResult) {
  const eventById = new Map((chat.runtimeEventsV2 || []).map((event) => [event.id, event] as const));
  result.chatRuntimeDelta?.runtimeEventsV2?.upserts.forEach((event) => eventById.set(event.id, event));
  const ledgerByKey = new Map((chat.relationshipLedger || []).map((entry) => [entry.pairKey, entry] as const));
  result.chatRuntimeDelta?.relationshipLedger?.upserts.forEach((entry) => ledgerByKey.set(entry.pairKey, entry));
  const isPresent = <T,>(value: T | undefined): value is T => Boolean(value);
  return normalizeConversation({
    ...chat,
    ...result.chatPatch,
    runtimeEventsV2: result.chatRuntimeDelta?.runtimeEventsV2
      ? result.chatRuntimeDelta.runtimeEventsV2.orderedIds.map((id) => eventById.get(id)).filter(isPresent)
      : (result.chatPatch.runtimeEventsV2 || chat.runtimeEventsV2),
    relationshipLedger: result.chatRuntimeDelta?.relationshipLedger
      ? result.chatRuntimeDelta.relationshipLedger.orderedPairKeys.map((key) => ledgerByKey.get(key)).filter(isPresent)
      : (result.chatPatch.relationshipLedger || chat.relationshipLedger),
    updatedAt: chat.updatedAt + 1,
    lastMessageAt: chat.lastMessageAt + 1,
  });
}

function readAppliedRuntimeEvents(chat: ReturnType<typeof buildChat>, result: DriverMessageCommitResult) {
  return applyResultToChat(chat, result).runtimeEventsV2 || [];
}

describe('openChatEngine runtime context', () => {
  it('exposes distinct direct and group delivery plans to the shared generator', () => {
    const buildContext = openChatEngine.buildRuntimeContextBundle;
    expect(buildContext).toBeTypeOf('function');
    if (!buildContext) throw new Error('open chat runtime context builder is missing');

    type Context = Parameters<typeof buildContext>[0];
    const speaker = buildCharacter('a', '甲');
    const direct = buildContext({ conversation: buildChat({ type: 'direct' }), speaker } as Context);
    const group = buildContext({ conversation: buildChat({ type: 'group' }), speaker } as Context);

    expect(direct?.expressionPlan?.surface).toBe('companion');
    expect(direct?.expressionPlan?.rhythm).toBe('one_shot');
    expect(group?.expressionPlan?.surface).toBe('casual');
    expect(group?.expressionPlan?.rhythm).toBe('back_and_forth');
  });
});

describe('openChatEngine.onMessageCommitted', () => {
  it('preserves old calendar state through a long-history message commit and subsequent update', async () => {
    const calendar: RuntimeEventV2 = {
      id: 'old-activity', conversationId: 'chat-1', kind: 'calendar_item_patch',
      createdAt: 1, visibility: 'public', summary: 'Plan',
      payload: { calendarItemId: 'activity-1', title: 'Plan', participantIds: ['a'] },
    };
    const chat = normalizeConversation({ ...buildChat(), runtimeEventsV2: [calendar,
      ...Array.from({ length: 180 }, (_, index): RuntimeEventV2 => ({
        id: `history-${index}`, conversationId: 'chat-1', kind: 'room_shift',
        createdAt: index + 10, visibility: 'public', summary: 'history', payload: {},
      })),
    ] });
    const params = {
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: { type: 'ai' as const, senderId: 'a', content: '稍后再聊。' },
      previousAiMessage: null, recentMessages: [],
    };
    const first = await openChatEngine.onMessageCommitted({ ...params, conversation: chat });
    const next = applyResultToChat(chat, first);
    expect(next.runtimeEventsV2).toContainEqual(calendar);
    const cancellation: RuntimeEventV2 = { ...calendar, id: 'cancel-activity', createdAt: Date.now(), payload: { calendarItemId: 'activity-1', cancelled: true } };
    next.runtimeEventsV2 = [...(next.runtimeEventsV2 || []), cancellation];
    const second = await openChatEngine.onMessageCommitted({ ...params, conversation: next });
    const events = readAppliedRuntimeEvents(next, second);
    expect(events).toContainEqual(calendar);
    expect(events).toContainEqual(cancellation);
    const historyCount = events.filter((event) => event.kind !== 'calendar_item_patch').length;
    expect(historyCount).toBeGreaterThan(0);
    expect(historyCount).toBeLessThanOrEqual(120);
  });
  it('retains memory backflow events alongside structured message and continuity events', async () => {
    const chat = buildChat({ layeredMemories: [{
      id: 'shared-decision', scope: 'conversation', layer: 'long_term', kind: 'decision', ownerId: 'chat-1',
      subjectIds: ['a', 'b'], text: '两人约定先探路再议。', salience: 0.8, confidence: 0.9, recency: 1,
      reinforcementCount: 1, sourceEventIds: [], origin: 'distilled',
      createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000,
    }] });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat, characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: { id: 'reply', type: 'ai', senderId: 'a', content: '我先去探路。',
        metadata: { conversationUpdate: { items: [{ key: 'scout', kind: 'commitment', status: 'established',
          summary: '甲承诺探路', participantIds: ['a'], evidenceText: '我先去探路。' }] } } },
      previousAiMessage: null, recentMessages: [],
    });
    const events = readAppliedRuntimeEvents(chat, result);
    expect(events).toContainEqual(expect.objectContaining({ id: 'distilled-shared-decision', kind: 'memory_candidate' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'message_generated' }));
    expect(events).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ eventType: 'conversation_item_updated' }) }));
    const next = applyResultToChat(chat, result);
    const second = await openChatEngine.onMessageCommitted({ conversation: next,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: { id: 'reply-2', type: 'ai', senderId: 'b', content: '路上仔细。' }, previousAiMessage: { senderId: 'a' }, recentMessages: [] });
    expect(readAppliedRuntimeEvents(next, second).filter((event) => event.id === 'distilled-shared-decision')).toHaveLength(1);
  });

  it('persists model-assessed user guidance instead of reparsing message prose', async () => {
    generateJsonResponseMock.mockResolvedValue(JSON.stringify({
      kind: 'direct_reply', actorIds: ['a'], mentionedActorIds: ['a', 'b'],
      suppressedActorIds: ['b'], deferredActorIds: [], hasHardConstraints: false,
      voiceRequest: false, stickerRequest: false, focusText: '让甲先完整回应',
      beatType: 'answer', pressure: 0.93, maxTurns: 2, minTargetTurns: 2,
      reason: '用户纠正了发言顺序。', mediaRequest: null,
    }));
    const chat = buildChat();
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: { type: 'god', senderId: 'user', content: '不是让乙抢答，我想先听甲说完' },
      recentMessages: [],
      apiConfig: buildApiConfig(),
    });
    const event = readRuntimeEvents(result).find((item) => item.kind === 'director_intervention');
    expect(event?.payload.userGuidance).toMatchObject({ actorIds: ['a'], suppressedActorIds: ['b'], minTargetTurns: 2 });
  });

  it('records a user-directed spike and partial release without changing the slow relationship', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const incomingInteractionHint = {
      kind: 'dismiss' as const, actorId: 'user', targetId: 'a', intensity: 5,
      tone: 'annoyed' as const, evidenceText: '甲，你根本不配管这件事。', confidence: 0.95,
    };
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: { type: 'ai', senderId: 'a', content: '你凭什么这么说？', incomingInteractionHint },
      recentMessages: [{ id: 'human-1', chatId: chat.id, type: 'user', senderId: 'user', senderName: '我', content: incomingInteractionHint.evidenceText, emotion: 0, timestamp: 1, isDeleted: false }],
    });
    const emotion = result.characterPatches.find((entry) => entry.characterId === 'a')?.patch.emotionalState;
    expect(emotion?.irritation).toBeGreaterThan(35);
    expect(emotion?.irritation).toBeLessThan(55);
    expect(result.characterPatches.find((entry) => entry.characterId === 'a')?.patch.relationships).toBeUndefined();
    const events = readAppliedRuntimeEvents(chat, result);
    expect(events.some((event) => event.kind === 'interaction' && event.actorIds.includes('user') && event.targetIds?.includes('a'))).toBe(true);
    expect(events.some((event) => event.kind === 'relationship_delta' && event.actorIds.includes('user'))).toBe(false);
  });

  it('produces structured runtime events for message, interaction, room shift, and memory', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const message = {
      type: 'ai' as const,
      senderId: 'a',
      content: '乙，你刚才那个说法不对，我不同意。',
      interactionHint: {
        kind: 'challenge' as const,
        actorId: 'a',
        targetId: 'b',
        intensity: 4,
        tone: 'annoyed' as const,
        evidenceText: '乙，你刚才那个说法不对，我不同意。',
        confidence: 0.92,
        relationship: {
          delta: { warmth: -2, competence: -1, trust: -2, threat: 1, attachment: 0, deference: 0 },
          labels: ['质疑'],
          stance: '对乙的判断更不信任',
        },
      },
      socialEventHints: [{
        eventKind: 'pair_private_thread' as const,
        participantIds: ['a', 'b'],
        targetIds: ['b'],
        reasonType: 'unresolved_question',
        confidence: 0.9,
        urgency: 'immediate' as const,
        seedIntent: '想私下继续和乙把刚才的争议说清楚。',
        visibilityPlan: 'conversation_private' as const,
        expectedArtifacts: ['private_thread_summary'],
        dedupeKey: 'pair-a-b-thread-1',
      }],
    } satisfies OpenChatCommittedMessageForTest;
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: message as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    expect(result.chatPatch.runtimeEventsV2).toBeUndefined();
    expect(result.chatPatch.relationshipLedger).toBeUndefined();
    expect(result.chatRuntimeDelta?.runtimeEventsV2?.upserts.length).toBeGreaterThan(0);
    expect(result.chatRuntimeDelta?.relationshipLedger?.upserts.length).toBeGreaterThan(0);
    const kinds = (readRuntimeEvents(result)).map((event) => event.kind);
    expect(kinds).toContain('message_generated');
    expect(kinds).toContain('interaction');
    expect(kinds).toContain('relationship_delta');
    expect(kinds).toContain('room_shift');
    expect(kinds).toContain('memory_candidate');
    expect(kinds).toContain('event_candidate');
  });

  it('persists every model-judged target instead of dropping secondary interactions', async () => {
    const chat = buildChat({ memberIds: ['a', 'b', 'c', 'user'] });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙'), buildCharacter('c', '丙')];
    const hints = [
      {
        kind: 'challenge' as const, actorId: 'a', targetId: 'b', intensity: 4, tone: 'annoyed' as const, evidenceText: '乙，这事你别推。', confidence: 0.94,
        relationship: { delta: { warmth: -1, competence: -1, trust: -2, threat: 1, attachment: 0, deference: 0 }, labels: ['追责'], stance: '不满乙推卸责任' },
      },
      {
        kind: 'defend' as const, actorId: 'a', targetId: 'c', intensity: 4, tone: 'warm' as const, evidenceText: '丙已经替你扛过一次。', confidence: 0.93,
        relationship: { delta: { warmth: 2, competence: 1, trust: 2, threat: 0, attachment: 1, deference: 0 }, labels: ['袒护'], stance: '更愿意保护丙' },
      },
    ];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai', senderId: 'a', content: '乙，这事你别推。丙已经替你扛过一次。',
        interactionHint: hints[0], interactionHints: hints,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextChat = applyResultToChat(chat, result);

    expect(nextChat.relationshipLedger?.some((entry) => entry.actorId === 'a' && entry.targetId === 'b')).toBe(true);
    expect(nextChat.relationshipLedger?.some((entry) => entry.actorId === 'a' && entry.targetId === 'c')).toBe(true);
    const interactionTargets = (nextChat.runtimeEventsV2 || [])
      .filter((event) => event.kind === 'interaction')
      .flatMap((event) => event.targetIds || []);
    expect(interactionTargets).toEqual(expect.arrayContaining(['b', 'c']));
    expect(nextChat.worldState.structuredRoomState?.conflictPairs).toEqual([]);
    expect(nextChat.worldState.structuredRoomState?.alliances).toEqual([]);
    expect(nextChat.worldState.structuredRoomState?.cohesion).toBe(0);
  });

  it('commits sourced continuity and explicit room structure through the real engine patch', async () => {
    const chat = buildChat();
    const result = await openChatEngine.onMessageCommitted({ conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: { id: 'evidence', timestamp: 20, type: 'ai', senderId: 'a', content: '我会站在你这边。先到这里。',
        metadata: { conversationUpdate: { items: [{ key: 'support', kind: 'commitment', status: 'established',
          summary: '甲承诺支持乙', participantIds: ['a', 'b'], evidenceText: '我会站在你这边' }],
          room: { addAlliances: [['a', 'b']], evidenceText: '我会站在你这边' },
          settled: { evidenceText: '先到这里' } } } },
    });
    const next = applyResultToChat(chat, result);
    expect(next.worldState.conversationContinuity?.items[0].sourceMessageIds).toEqual(['evidence']);
    expect(next.worldState.conversationContinuity?.settledAt).toBe(20);
    expect(next.worldState.structuredRoomState?.alliances).toEqual([['a', 'b']]);
    expect(readRuntimeEvents(result).filter((event) => event.evidenceMessageIds?.includes('evidence'))
      .map((event) => event.kind)).toEqual(expect.arrayContaining(['action_resolution', 'room_shift']));
  });

  it('normalizes non-array social event hints during commit', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '今天这段对话挺有意思，我想发条动态记录一下。',
        socialEventHints: {
          eventKind: 'post_moment',
          targetIds: ['b'],
          reasonType: 'emotion_release',
          confidence: 90,
          urgency: 'soon',
          seedIntent: '想发一条和刚才气氛有关的动态。',
          visibilityPlan: 'public',
        },
      } as unknown as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const eventCandidate = readRuntimeEvents(result).find((event) => event.kind === 'event_candidate');
    expect(eventCandidate?.payload).toMatchObject({
      eventKind: 'post_moment',
      participantIds: ['a'],
    });
    expect((eventCandidate?.payload as SocialEventCandidatePayload | undefined)?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('records plain user guidance as conversation focus and a topic memory cue', async () => {
    const chat = buildChat({ memberIds: ['a', 'b'] });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'user',
        senderId: 'user',
        content: '聊聊今晚要不要一起去看烟花。',
      } as OpenChatCommittedMessageForTest,
      previousAiMessage: null,
      recentMessages: [],
    });

    const applied = applyResultToChat(chat, result);
    expect(applied.worldState.focus).toBe('聊聊今晚要不要一起去看烟花。');
    expect(applied.worldState.recentEvent).toBe('用户引导：聊聊今晚要不要一起去看烟花。');
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'memory_candidate' && event.summary.includes('用户引导'))).toBe(true);
    expect(result.characterPatches).toHaveLength(0);
  });

  it('treats user member messages as normal participation instead of plain guidance', async () => {
    const chat = buildChat({ memberIds: ['user', 'a', 'b'] });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'user',
        senderId: 'user',
        content: '我觉得这个方案可以再具体一点。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    const applied = applyResultToChat(chat, result);
    expect(applied.worldState.recentEvent).not.toContain('用户引导：');
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'memory_candidate' && event.summary.includes('用户发言：'))).toBe(true);
  });

  it('persists model-assessed reply targets from a participating user without local name matching', async () => {
    generateJsonResponseMock.mockResolvedValueOnce(JSON.stringify({
      kind: 'direct_reply',
      actorIds: ['a'],
      mentionedActorIds: ['b'],
      hardConstraintActorIds: [],
      suppressedActorIds: [],
      deferredActorIds: [],
      hasHardConstraints: false,
      voiceRequest: false,
      stickerRequest: false,
      focusText: '让甲回答刚才的问题',
      beatType: 'answer',
      pressure: 0.9,
      maxTurns: 1,
      minTargetTurns: 1,
      reason: '用户直接要求甲回答，乙只是被谈及。',
      mediaRequest: null,
    }));
    const chat = buildChat({ memberIds: ['user', 'a', 'b'] });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      apiConfig: buildApiConfig(),
      message: { type: 'user', senderId: 'user', content: '刚才那件事你来回答。' },
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readAppliedRuntimeEvents(chat, result);
    const guidance = events.find((event) => event.kind === 'director_intervention');
    expect(guidance?.targetIds).toEqual(['a']);
    expect((guidance?.payload as { userGuidance?: { actorIds?: string[] } }).userGuidance?.actorIds).toEqual(['a']);
    expect(events.some((event) => event.kind === 'attention_candidate' && event.targetIds?.includes('a'))).toBe(true);
    expect(events.some((event) => event.kind === 'interaction' && event.actorIds.includes('user'))).toBe(false);
  });

  it('does not infer user mention as participant interaction without model-authored interaction data', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'user',
        senderId: 'user',
        content: '甲你先别急，我不同意这个结论。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const applied = applyResultToChat(chat, result);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'interaction' && event.actorIds?.includes('user') && event.targetIds?.includes('a'))).toBe(false);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'relationship_delta' && event.actorIds?.includes('user') && event.targetIds?.includes('a'))).toBe(false);
    expect(applied.relationshipLedger?.some((entry) => entry.actorId === 'user' && entry.targetId === 'a')).toBe(false);
  });

  it('does not infer ai-to-user interaction from recent user turn without model-authored interaction data', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '你这个问题问得很好，我先直接回答你。',
      },
      previousAiMessage: null,
      recentMessages: [{
        id: 'u-1',
        chatId: chat.id,
        type: 'user',
        senderId: 'user',
        senderName: '用户',
        content: '甲你怎么看这件事？',
        emotion: 0,
        timestamp: Date.now() - 2_000,
        isDeleted: false,
      }],
    });
    const applied = applyResultToChat(chat, result);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'interaction' && event.actorIds?.includes('a') && event.targetIds?.includes('user'))).toBe(false);
  });

  it('does not create ai_response_to_user attention candidate without model-authored interaction data', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '你先别急，我会把这件事说清楚。',
      },
      previousAiMessage: null,
      recentMessages: [{
        id: 'u-2',
        chatId: chat.id,
        type: 'user',
        senderId: 'user',
        senderName: '用户',
        content: '甲你先说明白。',
        emotion: 0,
        timestamp: Date.now() - 2_000,
        isDeleted: false,
      }],
    });
    const applied = applyResultToChat(chat, result);
    const attentionEvent = applied.runtimeEventsV2?.find((event) => event.kind === 'attention_candidate' && event.actorIds?.includes('a') && event.targetIds?.includes('user'));
    expect(attentionEvent).toBeFalsy();
  });

  it('creates ai_response_to_member attention candidate for inferred ai-to-ai interaction', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '乙你刚才那个判断我认同，但我想补一个细节。',
        interactionHint: {
          kind: 'support',
          actorId: 'a',
          targetId: 'b',
          intensity: 3,
          tone: 'warm',
          evidenceText: '乙你刚才那个判断我认同，但我想补一个细节。',
          confidence: 0.9,
        },
      } as OpenChatCommittedMessageForTest,
      previousAiMessage: null,
      recentMessages: [{
        id: 'ai-previous-1',
        chatId: chat.id,
        type: 'ai',
        senderId: 'b',
        senderName: '乙',
        content: '我建议先降风险再推进。',
        emotion: 0,
        timestamp: Date.now() - 2_000,
        isDeleted: false,
      }],
    });
    const applied = applyResultToChat(chat, result);
    const attentionEvent = applied.runtimeEventsV2?.find((event) => event.kind === 'attention_candidate' && event.actorIds?.includes('a') && event.targetIds?.includes('b'));
    expect(attentionEvent).toBeTruthy();
    expect((attentionEvent?.payload as { source?: string }).source).toBe('ai_response_to_member');
  });

  it.skip('treats targeted user media guidance as user attention candidate instead of director intervention', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '美羊羊'), buildCharacter('b', '灰太狼')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'user',
        senderId: 'user',
        content: '美羊羊发个灰太狼证件照的图片',
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    const applied = applyResultToChat(chat, result);
    const directorEvent = applied.runtimeEventsV2?.find((event) => event.kind === 'director_intervention');
    const attentionEvent = applied.runtimeEventsV2?.find((event) => event.kind === 'attention_candidate');
    expect(directorEvent).toBeFalsy();
    expect(attentionEvent).toBeTruthy();
    expect(attentionEvent?.targetIds).toContain('a');
  });

  it('does not treat plain user follow-up as participant interaction toward latest ai speaker without model-authored interaction data', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'user',
        senderId: 'user',
        content: '你这个解释我不同意，为什么要这么判断？',
      },
      previousAiMessage: null,
      recentMessages: [
        {
          id: 'ai-1',
          chatId: chat.id,
          type: 'ai',
          senderId: 'a',
          senderName: '甲',
          content: '我建议先按这个方案执行。',
          emotion: 0,
          timestamp: Date.now() - 2_000,
          isDeleted: false,
        },
      ],
    });

    const applied = applyResultToChat(chat, result);
    const interactionEvent = applied.runtimeEventsV2?.find((event) => event.kind === 'interaction' && event.actorIds?.includes('user') && event.targetIds?.includes('a'));
    const attentionEvent = applied.runtimeEventsV2?.find((event) => event.kind === 'attention_candidate' && event.actorIds?.includes('user') && event.targetIds?.includes('a'));
    expect(interactionEvent).toBeFalsy();
    expect(attentionEvent).toBeFalsy();
  });

  it('does not project non-user external sender as relationship participant', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'user',
        senderId: 'moderator',
        content: '甲先回答这个问题。',
      },
      previousAiMessage: null,
      recentMessages: [
        {
          id: 'ai-1',
          chatId: chat.id,
          type: 'ai',
          senderId: 'a',
          senderName: '甲',
          content: '我建议先按这个方案执行。',
          emotion: 0,
          timestamp: Date.now() - 2_000,
          isDeleted: false,
        },
      ],
    });

    const applied = applyResultToChat(chat, result);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'interaction' && event.actorIds?.includes('moderator'))).toBe(false);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'relationship_delta' && event.actorIds?.includes('moderator'))).toBe(false);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'attention_candidate' && event.actorIds?.includes('moderator'))).toBe(false);
  });

  it('does not create user guidance memory candidate for god/director intervention message', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'god',
        senderId: 'director',
        content: '请甲先回答用户刚才的问题。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const applied = applyResultToChat(chat, result);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'director_intervention')).toBe(true);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'memory_candidate' && event.summary.includes('用户引导'))).toBe(false);
    expect(applied.runtimeEventsV2?.some((event) => event.kind === 'interaction' && event.actorIds?.includes('director'))).toBe(false);
  });

  it.skip('creates user-private follow-up candidate when actor responds after user attention targeting', async () => {
    const chat = buildChat({
      runtimeEventsV2: [{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: Date.now() - 2_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名 a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.8 },
      }],
    });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来先回应一下。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readRuntimeEvents(result);
    const followup = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string; reasonType?: string }).eventKind === 'pair_private_thread' && (event.payload as { reasonType?: string }).reasonType === 'attention_followup');
    expect(followup).toBeTruthy();
    expect((followup?.payload as { participantIds?: string[] }).participantIds).toEqual(['a', 'user']);
  });

  it('does not generate user-targeted attention candidates when user is not a chat member', async () => {
    const chat = buildChat({
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: Date.now() - 2_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名 a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.8 },
      }],
    });
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来先回应一下。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readRuntimeEvents(result);
    expect(nextEvents.some((event) => {
      if (event.kind !== 'event_candidate') return false;
      const payload = event.payload as { targetIds?: string[]; eventKind?: string };
      return (payload.targetIds || []).includes('user')
        && ['pair_private_thread', 'check_in', 'react_to_moment', 'status_update', 'social_outing'].includes(payload.eventKind || '');
    })).toBe(false);
  });

  it('does not generate user-targeted attention candidates when companionship boundary rejects active contact', async () => {
    const chat = buildChat({
      runtimeEventsV2: [{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: Date.now() - 2_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名 a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.8 },
      }],
    });
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [
        buildCharacter('a', '甲', {
          memory: {
            ...DEFAULT_CHARACTER_MEMORY,
            userMemories: ['用户说不要主动打扰，也别提醒或私聊。'],
          },
        }),
        buildCharacter('b', '乙'),
      ],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来先回应一下。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readRuntimeEvents(result);
    expect(nextEvents.some((event) => {
      if (event.kind !== 'event_candidate') return false;
      const payload = event.payload as { targetIds?: string[]; eventKind?: string };
      return (payload.targetIds || []).includes('user')
        && ['pair_private_thread', 'check_in'].includes(payload.eventKind || '');
    })).toBe(false);
  });

  it.skip('creates check_in and react_to_moment candidates from attention and recent moments', async () => {
    const chat = buildChat({
      runtimeEventsV2: [
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: Date.now() - 3_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户点名 a',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.8 },
        },
        {
          id: 'moment-1',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: Date.now() - 20_000,
          actorIds: ['b'],
          summary: 'b 发了动态',
          visibility: 'derived_public',
          payload: { artifactType: 'moment_text', eventKind: 'post_moment', text: '晚饭真不错' },
        },
      ],
    });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我先回应一下刚才的问题。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readRuntimeEvents(result);
    const checkIn = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    const reactMoment = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment');
    const checkInArtifact = nextEvents.find((event) => event.kind === 'artifact' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    const reactMomentArtifact = nextEvents.find((event) => event.kind === 'artifact' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment');
    expect(checkIn).toBeTruthy();
    expect(reactMoment).toBeTruthy();
    expect(checkInArtifact).toBeTruthy();
    expect(reactMomentArtifact).toBeTruthy();
    expect((checkInArtifact?.payload as { candidateId?: string })?.candidateId).toBeTruthy();
    expect((reactMomentArtifact?.payload as { candidateId?: string })?.candidateId).toBeTruthy();
    const checkInTrace = (checkIn?.payload as { attentionTrace?: { score?: number; reasons?: string[] } })?.attentionTrace;
    const reactTrace = (reactMoment?.payload as { attentionTrace?: { score?: number; reasons?: string[] } })?.attentionTrace;
    expect(checkInTrace?.score).toBeGreaterThan(0);
    expect((checkInTrace?.reasons || []).length).toBeGreaterThan(0);
    expect(reactTrace?.score).toBeGreaterThan(0);
  });

  it.skip('suppresses check_in and react_to_moment candidates within cooldown windows', async () => {
    const now = Date.now();
    const chat = buildChat({
      runtimeEventsV2: [
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 3_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户点名 a',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.8 },
        },
        {
          id: 'moment-1',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 8_000,
          actorIds: ['b'],
          summary: 'b 发了动态',
          visibility: 'derived_public',
          payload: { artifactType: 'moment_text', eventKind: 'post_moment', text: '晚饭真不错' },
        },
        {
          id: 'checkin-old',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 5 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: 'a 刚刚问候过用户',
          visibility: 'derived_public',
          payload: { artifactType: 'check_in_note', eventKind: 'check_in', text: '最近怎么样？' },
        },
        {
          id: 'react-old',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 10 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: 'a 刚刚回应过动态',
          visibility: 'derived_public',
          payload: { artifactType: 'moment_reaction_note', eventKind: 'react_to_moment', text: '这条动态不错。' },
        },
      ],
    });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我继续说一下。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readRuntimeEvents(result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in')).toBe(false);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment')).toBe(false);
    const suppressed = nextEvents.filter((event) => event.kind === 'action_resolution' && (event.payload as { eventType?: string }).eventType === 'event_candidate_suppressed');
    expect(suppressed.length).toBeGreaterThan(0);
    const checkInSuppressed = suppressed.find((event) => (event.payload as { candidateEventKind?: string }).candidateEventKind === 'check_in');
    expect(checkInSuppressed).toBeTruthy();
    expect((checkInSuppressed?.payload as { reasonType?: string }).reasonType).toBe('restraint_policy');
    expect((checkInSuppressed?.payload as { hitWindow?: string }).hitWindow).toBe('90min');
    expect((checkInSuppressed?.payload as { hitEventId?: string }).hitEventId).toBe('checkin-old');
    expect((checkInSuppressed?.payload as { nextSuggestedAt?: number }).nextSuggestedAt).toBe(now + 85 * 60_000);
    const reactSuppressed = suppressed.find((event) => (event.payload as { candidateEventKind?: string }).candidateEventKind === 'react_to_moment');
    expect(reactSuppressed).toBeTruthy();
    expect((reactSuppressed?.payload as { reasonType?: string }).reasonType).toBe('dedupe_backflow_react_to_moment');
    expect((reactSuppressed?.payload as { hitWindow?: string }).hitWindow).toBe('45min');
    expect((reactSuppressed?.payload as { hitEventId?: string }).hitEventId).toBe('react-old');
  });

  it('records suppression event when semantic-duplicate candidate is older than existing candidate', async () => {
    const now = Date.now();
    const chat = buildChat({
      runtimeEventsV2: [{
        id: 'candidate-existing-newer',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: now + 30_000,
        actorIds: ['a'],
        summary: 'a 提议发布一条 post_moment 动态',
        visibility: 'derived_public',
        payload: {
          eventKind: 'post_moment',
          initiatorId: 'a',
          participantIds: ['a'],
          reasonType: 'emotion_release',
          confidence: 0.92,
          urgency: 'soon',
          seedIntent: '想发动态',
          visibilityPlan: 'public',
          expectedArtifacts: ['moment_text'],
          title: '朋友圈动态',
          activityType: '记录聚会',
          dedupeKey: 'moment-dup-1',
        },
      }],
    });
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我想发条动态记录一下。',
        socialEventHints: [{
          eventKind: 'post_moment',
          confidence: 0.91,
          reasonType: 'emotion_release',
          dedupeKey: 'moment-dup-1',
          title: '朋友圈动态',
          activityType: '记录聚会',
        }],
      } as never,
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readRuntimeEvents(result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && event.id !== 'candidate-existing-newer' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(false);
    const suppressed = nextEvents.find((event) => event.kind === 'action_resolution' && (event.payload as { reasonType?: string }).reasonType === 'dedupe_semantic_existing_newer');
    expect(suppressed).toBeTruthy();
    expect((suppressed?.payload as { eventType?: string })?.eventType).toBe('event_candidate_suppressed');
    expect((suppressed?.payload as { reasonDetail?: string })?.reasonDetail).toContain('语义重复且已有候选更新');
    expect((suppressed?.payload as { preferredConfidence?: number })?.preferredConfidence).toBe(0.92);
    expect((suppressed?.payload as { suppressedConfidence?: number })?.suppressedConfidence || 0).toBeGreaterThanOrEqual(0.91);
    expect((suppressed?.payload as { preferredCandidateId?: string })?.preferredCandidateId).toBe('candidate-existing-newer');
    expect((suppressed?.payload as { suppressedCandidateId?: string })?.suppressedCandidateId).toBeTruthy();
  });

  it.skip('suppresses attention private/check_in suggestions under high threat relationship', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 1, competence: 3, trust: 1, threat: 10 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 60_000,
      }],
      runtimeEventsV2: [
        {
          id: 'evt-attention',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 10 * 60_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户点名a',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
        },
        {
          id: 'evt-moment',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 5 * 60_000,
          actorIds: ['b'],
          targetIds: ['user'],
          summary: 'B 发动态',
          visibility: 'derived_public',
          payload: { artifactType: 'moment_text', eventKind: 'post_moment', text: '晚饭真不错' },
        },
      ],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我先补一句。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'pair_private_thread')).toBe(false);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in')).toBe(false);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment')).toBe(true);
  });

  it.skip('suppresses user-private attention actions in quiet hours when relationship is weak', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T23:30:00+08:00'));
    try {
      const now = Date.now();
      const chat = normalizeConversation({
        ...buildChat(),
        relationshipLedger: [{
          pairKey: 'a->user',
          actorId: 'a',
          targetId: 'user',
          current: { warmth: 1, competence: 3, trust: 1, threat: 0 },
          trend: 'flat',
          recentEvents: [],
          lastUpdatedAt: now - 60_000,
        }],
        runtimeEventsV2: [{
          id: 'evt-attention',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 5 * 60_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户点名a',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
        }],
      });
      const result = await openChatEngine.onMessageCommitted({
        conversation: chat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: {
          type: 'ai',
          senderId: 'a',
          content: '我先补一句。',
          interactionHint: null,
        },
        previousAiMessage: null,
        recentMessages: [],
      });
      const nextEvents = readAppliedRuntimeEvents(chat, result);
      expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in')).toBe(false);
      const suppressed = nextEvents.find((event) => event.kind === 'action_resolution' && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed' && (event.payload as { reasonType?: string }).reasonType === 'restraint_policy');
      expect(suppressed).toBeTruthy();
      expect((suppressed?.payload as { reasonDetail?: string }).reasonDetail).toContain('关系信号');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create public react_to_moment candidate from private-visibility moment artifact', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 6, competence: 4, trust: 5, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.92, targetIds: ['a'] },
      }, {
        id: 'evt-private-moment',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 5 * 60_000,
        actorIds: ['b'],
        targetIds: ['user'],
        summary: 'B 在私域发布动态',
        visibility: 'pair_private',
        payload: { artifactType: 'moment_text', eventKind: 'post_moment', text: '这段内容仅私域可见' },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我先补一句。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment')).toBe(false);
  });

  it.skip('suppresses attention check_in when recent user-private action already exists', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 6, competence: 4, trust: 4, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 5 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'evt-recent-private',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: now - 30 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 刚私聊跟进过',
        visibility: 'derived_public',
        payload: {
          eventKind: 'pair_private_thread',
          initiatorId: 'a',
          participantIds: ['a', 'user'],
          targetIds: ['user'],
          reasonType: 'attention_followup',
          confidence: 0.82,
          urgency: 'soon',
          seedIntent: '刚刚跟进过',
          visibilityPlan: 'user_private',
          expectedArtifacts: ['private_thread_summary'],
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我继续回应。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in')).toBe(false);
    const suppressed = nextEvents.find((event) => event.kind === 'action_resolution' && (event.payload as { eventType?: string; reasonType?: string; candidateEventKind?: string }).eventType === 'event_candidate_suppressed' && (event.payload as { reasonType?: string; candidateEventKind?: string }).reasonType === 'restraint_policy' && (event.payload as { candidateEventKind?: string }).candidateEventKind === 'check_in');
    expect(suppressed).toBeTruthy();
    expect((suppressed?.payload as { reasonDetail?: string }).reasonDetail).toContain('近期已存在用户私域动作');
    expect((suppressed?.payload as { reasonDetail?: string }).reasonDetail).toContain('evt-recent-private');
    expect((suppressed?.payload as { hitEventId?: string }).hitEventId).toBe('evt-recent-private');
    expect((suppressed?.payload as { hitWindow?: string }).hitWindow).toBe('90min');
    expect(typeof (suppressed?.payload as { nextSuggestedAt?: unknown }).nextSuggestedAt).toBe('number');
  });

  it('skips check_in candidate generation when a pending suppression window exists', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 5 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'sup-checkin',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'check_in 候选已抑制',
        visibility: 'moderator_only',
        payload: {
          eventType: 'event_candidate_suppressed',
          candidateEventKind: 'check_in',
          reasonType: 'restraint_policy',
          nextSuggestedAt: now + 20 * 60_000,
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我继续回应。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in')).toBe(false);
  });

  it.skip('restores check_in candidate generation after suppression window expires', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 5 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'sup-checkin-expired',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 30 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'check_in 候选已抑制（已过期）',
        visibility: 'moderator_only',
        payload: {
          eventType: 'event_candidate_suppressed',
          candidateEventKind: 'check_in',
          reasonType: 'restraint_policy',
          nextSuggestedAt: now - 60_000,
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我继续回应。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const checkIn = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    expect(checkIn).toBeTruthy();
  });

  it('skips react_to_moment candidate generation when a pending suppression window exists', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 5 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'moment-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 20_000,
        actorIds: ['b'],
        summary: 'b 发了动态',
        visibility: 'derived_public',
        payload: { artifactType: 'moment_text', eventKind: 'post_moment', text: '晚饭真不错' },
      }, {
        id: 'sup-react',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'react_to_moment 候选已抑制',
        visibility: 'moderator_only',
        payload: {
          eventType: 'event_candidate_suppressed',
          candidateEventKind: 'react_to_moment',
          reasonType: 'restraint_policy',
          nextSuggestedAt: now + 20 * 60_000,
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我继续回应。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment')).toBe(false);
  });

  it.skip('restores react_to_moment candidate generation after suppression window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
    try {
      const now = Date.now();
      const chat = normalizeConversation({
        ...buildChat(),
        relationshipLedger: [{
          pairKey: 'a->user',
          actorId: 'a',
          targetId: 'user',
          current: { warmth: 6, competence: 4, trust: 5, threat: 0 },
          trend: 'up',
          recentEvents: [],
          lastUpdatedAt: now - 10 * 60_000,
        }],
        runtimeEventsV2: [{
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 5 * 60_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户点名a',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
        }, {
          id: 'moment-1',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 20_000,
          actorIds: ['b'],
          summary: 'b 发了动态',
          visibility: 'derived_public',
          payload: { artifactType: 'moment_text', eventKind: 'post_moment', text: '晚饭真不错' },
        }, {
          id: 'sup-react-expired',
          conversationId: 'chat-1',
          kind: 'action_resolution',
          createdAt: now - 30 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: 'react_to_moment 候选已抑制（已过期）',
          visibility: 'moderator_only',
          payload: {
            eventType: 'event_candidate_suppressed',
            candidateEventKind: 'react_to_moment',
            reasonType: 'restraint_policy',
            nextSuggestedAt: now - 60_000,
          },
        }],
      });
      const result = await openChatEngine.onMessageCommitted({
        conversation: chat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: {
          type: 'ai',
          senderId: 'a',
          content: '我继续回应。',
          interactionHint: null,
        },
        previousAiMessage: null,
        recentMessages: [],
      });
      const nextEvents = readAppliedRuntimeEvents(chat, result);
      const react = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment');
      expect(react).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not build attention-driven invite_activity as social_outing candidate without model-authored social event hint', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 16, competence: 4, trust: 14, threat: -2 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到周末可以一起活动',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.94, targetIds: ['a'] },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我们可以找时间见个面。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const invite = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_invite_activity');
    expect(invite).toBeUndefined();
  });

  it('skips invite_activity candidate generation when a pending suppression window exists', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 16, competence: 4, trust: 14, threat: -2 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到周末可以一起活动',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.94, targetIds: ['a'] },
      }, {
        id: 'sup-outing',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 30_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'social_outing 候选已抑制',
        visibility: 'moderator_only',
        payload: {
          eventType: 'event_candidate_suppressed',
          candidateEventKind: 'social_outing',
          reasonType: 'restraint_policy',
          nextSuggestedAt: now + 20 * 60_000,
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我们先把当前话题说完。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_invite_activity')).toBe(false);
  });

  it('keeps invite_activity candidate generation disabled after suppression window expires without model-authored social event hint', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 16, competence: 4, trust: 14, threat: -2 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到周末可以一起活动',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.94, targetIds: ['a'] },
      }, {
        id: 'sup-outing-expired',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 30 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'social_outing 候选已抑制（已过期）',
        visibility: 'moderator_only',
        payload: {
          eventType: 'event_candidate_suppressed',
          candidateEventKind: 'social_outing',
          reasonType: 'restraint_policy',
          nextSuggestedAt: now - 60_000,
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我们可以抽空见一面。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const invite = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_invite_activity');
    expect(invite).toBeUndefined();
  });

  it.skip('builds attention-driven calendar_reminder as status_update candidate', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到明天安排',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'evt-recent-outing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 20 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '刚发起活动邀约',
        visibility: 'derived_public',
        payload: { artifactType: 'outing_summary', eventKind: 'social_outing', text: '刚发起活动邀约' },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来补一条提醒。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const reminder = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_calendar_reminder');
    expect((reminder?.payload as { eventKind?: string }).eventKind).toBe('status_update');
  });

  it.skip('records nextSuggestedAt when calendar_reminder is suppressed by restraint policy', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到明天安排',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'evt-recent-private',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: now - 30 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 刚私聊跟进过',
        visibility: 'derived_public',
        payload: {
          eventKind: 'pair_private_thread',
          initiatorId: 'a',
          participantIds: ['a', 'user'],
          targetIds: ['user'],
          reasonType: 'attention_followup',
          confidence: 0.82,
          urgency: 'soon',
          seedIntent: '刚刚跟进过',
          visibilityPlan: 'user_private',
          expectedArtifacts: ['private_thread_summary'],
        },
      }, {
        id: 'evt-recent-outing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 20 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '刚发起活动邀约',
        visibility: 'derived_public',
        payload: { artifactType: 'outing_summary', eventKind: 'social_outing', text: '刚发起活动邀约' },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来补一条提醒。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_calendar_reminder')).toBe(false);
    const suppressed = nextEvents.find((event) => event.kind === 'action_resolution'
      && (event.payload as { eventType?: string; reasonType?: string; candidateEventKind?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { reasonType?: string; candidateEventKind?: string }).reasonType === 'restraint_policy'
      && (event.payload as { candidateEventKind?: string }).candidateEventKind === 'status_update');
    expect(suppressed).toBeTruthy();
    expect((suppressed?.payload as { hitWindow?: string }).hitWindow).toBe('2h');
    expect(typeof (suppressed?.payload as { nextSuggestedAt?: unknown }).nextSuggestedAt).toBe('number');
  });

  it('skips calendar reminders while pending status_update suppression window is active', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到明天安排',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'sup-status',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 30_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'status_update 候选已抑制',
        visibility: 'moderator_only',
        payload: {
          eventType: 'event_candidate_suppressed',
          candidateEventKind: 'status_update',
          reasonType: 'restraint_policy',
          nextSuggestedAt: now + 20 * 60_000,
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来补一条提醒。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && ((event.payload as { reasonType?: string }).reasonType === 'world_attention_calendar_reminder' || (event.payload as { reasonType?: string }).reasonType === 'world_calendar_upcoming_reminder'))).toBe(false);
  });

  it.skip('builds calendar-driven reminder candidate from upcoming shared calendar item', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'cal-1',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: now - 5 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '明天晨会安排',
        visibility: 'derived_public',
        payload: {
          eventType: 'calendar_item_patch',
          calendarItemId: 'item-upcoming-1',
          kind: 'activity',
          status: 'planned',
          title: '晨会',
          activityType: '工作会议',
          participantIds: ['a', 'user'],
          participantStates: { a: 'going', user: 'going' },
          startAt: now + 2 * 60 * 60_000,
          durationMinutes: 45,
          summary: '晨会安排',
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我先说点别的。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const reminder = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_calendar_upcoming_reminder');
    expect(reminder).toBeTruthy();
    expect((reminder?.payload as { eventKind?: string }).eventKind).toBe('status_update');
    expect((reminder?.payload as { title?: string }).title).toBe('晨会');
    expect((reminder?.payload as { dedupeKey?: string }).dedupeKey).toContain('item-upcoming-1');
  });

  it.skip('builds attention-driven comfort as check_in candidate', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 14, competence: 4, trust: 12, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户状态有点低落',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我在这，慢慢说。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const comfort = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_comfort');
    expect((comfort?.payload as { eventKind?: string }).eventKind).toBe('check_in');
  });

  it('suppresses status_update candidate when recent status artifact already covers the same cluster', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-status-existing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now + 20_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '甲已更新近况',
        visibility: 'derived_public',
        payload: {
          artifactType: 'status_note',
          eventKind: 'status_update',
          title: '状态更新',
          activityType: '近况同步',
          dedupeKey: 'status-dup-1',
          text: '甲已更新近况',
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我再补一句近况。',
        socialEventHints: [{
          eventKind: 'status_update',
          confidence: 0.9,
          reasonType: 'self_disclosure',
          dedupeKey: 'status-dup-1',
          title: '状态更新',
          activityType: '近况同步',
        }],
      } as never,
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readRuntimeEvents(result);
    const suppressed = nextEvents.find((event) => event.kind === 'action_resolution'
      && (event.payload as { reasonType?: string }).reasonType === 'dedupe_backflow_status_update');
    expect(suppressed).toBeTruthy();
    expect((suppressed?.payload as { hitEventId?: string }).hitEventId).toBe('evt-status-existing');
    expect((suppressed?.payload as { hitWindow?: string }).hitWindow).toBe('cluster');
  });

  it('suppresses post_moment candidate when recent moment artifact already covers the same cluster', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-moment-existing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now + 20_000,
        actorIds: ['a'],
        summary: '甲已发动态',
        visibility: 'derived_public',
        payload: {
          artifactType: 'moment_text',
          eventKind: 'post_moment',
          title: '朋友圈动态',
          activityType: '记录聚会',
          dedupeKey: 'moment-dup-1',
          text: '甲已发动态',
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我想发条动态记录一下。',
        socialEventHints: [{
          eventKind: 'post_moment',
          confidence: 0.9,
          reasonType: 'celebration',
          dedupeKey: 'moment-dup-1',
          title: '朋友圈动态',
          activityType: '记录聚会',
        }],
      } as never,
      previousAiMessage: null,
      recentMessages: [],
    });
    const suppressed = readRuntimeEvents(result).find((event) => event.kind === 'action_resolution'
      && (event.payload as { reasonType?: string }).reasonType === 'dedupe_backflow_post_moment');
    expect(suppressed).toBeTruthy();
    expect((suppressed?.payload as { hitEventId?: string }).hitEventId).toBe('evt-moment-existing');
    expect((suppressed?.payload as { hitWindow?: string }).hitWindow).toBe('cluster');
  });

  it('keeps social_outing candidate tentative even when a recent outing artifact covers the same cluster', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-outing-existing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now + 20_000,
        actorIds: ['a'],
        targetIds: ['a', 'b'],
        summary: '甲乙已线下活动',
        visibility: 'derived_public',
        payload: {
          artifactType: 'outing_summary',
          eventKind: 'social_outing',
          title: '线下活动',
          activityType: '散步',
          dedupeKey: 'outing-dup-1',
          text: '甲乙已线下活动',
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我们周末去散步吧。',
        socialEventHints: [{
          eventKind: 'social_outing',
          confidence: 0.9,
          reasonType: 'celebration',
          dedupeKey: 'outing-dup-1',
          title: '线下活动',
          activityType: '散步',
          participantIds: ['a', 'b'],
        }],
      } as never,
      previousAiMessage: null,
      recentMessages: [],
    });
    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string; dedupeKey?: string }).eventKind === 'social_outing'
      && (event.payload as { dedupeKey?: string }).dedupeKey === 'outing-dup-1')).toBe(true);
    expect(events.some((event) => event.kind === 'action_resolution'
      && (event.payload as { reasonType?: string }).reasonType === 'dedupe_backflow_social_outing')).toBe(false);
  });

  it('suppresses gift_exchange candidate when recent gift artifact already covers the same cluster', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-gift-existing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now + 20_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '甲已送出小礼物',
        visibility: 'derived_public',
        payload: {
          artifactType: 'gift_note',
          eventKind: 'gift_exchange',
          title: '小礼物',
          activityType: '安慰',
          dedupeKey: 'gift-dup-1',
          text: '甲已送出小礼物',
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我给你带了个小礼物。',
        socialEventHints: [{
          eventKind: 'gift_exchange',
          confidence: 0.9,
          reasonType: 'care',
          dedupeKey: 'gift-dup-1',
          title: '小礼物',
          activityType: '安慰',
          targetIds: ['b'],
        }],
      } as never,
      previousAiMessage: null,
      recentMessages: [],
    });
    const suppressed = readRuntimeEvents(result).find((event) => event.kind === 'action_resolution'
      && (event.payload as { reasonType?: string }).reasonType === 'dedupe_backflow_gift_exchange');
    expect(suppressed).toBeTruthy();
    expect((suppressed?.payload as { hitEventId?: string }).hitEventId).toBe('evt-gift-existing');
    expect((suppressed?.payload as { hitWindow?: string }).hitWindow).toBe('cluster');
  });

  it.skip('prefers higher-confidence status_update when attention reminder and hint share the same dedupe key', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到明天安排',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'evt-recent-outing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 20 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '刚发起活动邀约',
        visibility: 'derived_public',
        payload: { artifactType: 'outing_summary', eventKind: 'social_outing', text: '刚发起活动邀约' },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来更新一下提醒：明天别迟到。',
        interactionHint: null,
        socialEventHints: [{
          eventKind: 'status_update',
          confidence: 0.93,
          reasonType: 'self_disclosure',
          dedupeKey: `attention-reminder-${chat.id}-a`,
          seedIntent: '补一条明确提醒。',
          visibilityPlan: 'user_private',
          expectedArtifacts: ['status_note'],
        }],
      } as OpenChatCommittedMessageForTest,
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const statusCandidates = nextEvents.filter((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'status_update');
    expect(statusCandidates).toHaveLength(1);
    const payload = statusCandidates[0]?.payload as { confidence?: number; dedupeKey?: string; seedIntent?: string };
    expect(payload.dedupeKey).toBe(`attention-reminder-${chat.id}-a`);
    expect(payload.confidence || 0).toBeGreaterThanOrEqual(0.93);
    const suppressedDuplicate = nextEvents.find((event) => event.kind === 'action_resolution' && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed' && (event.payload as { reasonType?: string }).reasonType === 'dedupe_key_duplicate');
    expect(suppressedDuplicate).toBeTruthy();
    expect((suppressedDuplicate?.payload as { preferredConfidence?: number }).preferredConfidence || 0).toBeGreaterThanOrEqual(0.93);
    expect((suppressedDuplicate?.payload as { suppressedConfidence?: number }).suppressedConfidence || 0).toBeGreaterThan(0);
    expect((suppressedDuplicate?.payload as { preferredCandidateId?: string }).preferredCandidateId).toBeTruthy();
    expect((suppressedDuplicate?.payload as { suppressedCandidateId?: string }).suppressedCandidateId).toBeTruthy();
  });

  it.skip('builds attention-driven share_moment as post_moment candidate for member follow-up', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-attention-member-followup',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 10 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 对 b 形成手动跟进关注候选',
        visibility: 'derived_public',
        payload: {
          source: 'manual_attention_followup_member',
          confidence: 0.92,
          targetIds: ['b'],
        },
      }, {
        id: 'evt-recent-outing-artifact',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 35 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '刚刚线下活动结束',
        visibility: 'derived_public',
        payload: {
          artifactType: 'outing_summary',
          eventKind: 'social_outing',
        },
      }],
      relationshipLedger: [{
        pairKey: 'a->b',
        actorId: 'a',
        targetId: 'b',
        current: { warmth: 7, competence: 5, trust: 6, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 60_000,
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我补充一个观点。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const moment = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_share_moment');
    expect(moment).toBeTruthy();
    expect((moment?.payload as { eventKind?: string }).eventKind).toBe('post_moment');
    expect((moment?.payload as { targetIds?: string[] }).targetIds).toEqual(['b']);
  });

  it.skip('suppresses hinted post_moment during late night for non-night-owl persona', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T23:45:00+08:00'));
    try {
      const now = Date.now();
      const chat = normalizeConversation({
        ...buildChat(),
        runtimeEventsV2: [{
          id: 'evt-prime',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 5 * 60_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户刚提到刚才聚会',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
        }],
      });
      const result = await openChatEngine.onMessageCommitted({
        conversation: chat,
        characters: [buildCharacter('a', '甲', { speakingStyle: '白天节奏，作息规律。' }), buildCharacter('b', '乙')],
        message: {
          type: 'ai',
          senderId: 'a',
          content: '发个朋友圈记录一下。',
          interactionHint: null,
          socialEventHints: [{
            eventKind: 'post_moment',
            confidence: 0.92,
            urgency: 'immediate',
            seedIntent: '想发一条朋友圈',
          }],
        } as OpenChatCommittedMessageForTest,
        previousAiMessage: null,
        recentMessages: [],
      });
      const nextEvents = readAppliedRuntimeEvents(chat, result);
      expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes hinted post_moment defaults to non-spam friendly payload', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-prime',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 5 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户说今天很有意思',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '发个朋友圈记录一下。',
        interactionHint: null,
        socialEventHints: [{
          eventKind: 'post_moment',
          confidence: 0.92,
          urgency: 'immediate',
          seedIntent: '想发一条朋友圈',
        }],
      } as OpenChatCommittedMessageForTest,
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const moment = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment');
    const payload = moment?.payload as SocialEventCandidatePayload | undefined;
    expect(payload).toBeTruthy();
    expect(payload?.urgency).toBe('soon');
    expect(payload?.expectedArtifacts?.includes('moment_text')).toBe(true);
    expect(payload?.title).toBeTruthy();
    expect(payload?.activityType).toBeTruthy();
  });

  it('disables post_moment candidate when character overrides moments to off', async () => {
    const now = Date.now();
    const actor = { ...buildCharacter('a', '甲'), generationPreferences: { moments: 'off' as const, diaries: 'follow_global' as const } };
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-prime',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 5 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户说今天很有意思',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [actor, buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '发个朋友圈记录一下。',
        interactionHint: null,
        socialEventHints: [{
          eventKind: 'post_moment',
          confidence: 0.92,
          urgency: 'immediate',
        }],
      } as OpenChatCommittedMessageForTest,
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(false);
  });

  it('suppresses attention-driven share_moment during late night for non-night-owl persona', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T23:50:00+08:00'));
    try {
      const now = Date.now();
      const chat = normalizeConversation({
        ...buildChat(),
        memberIds: ['a', 'b'],
        runtimeEventsV2: [{
          id: 'evt-attention-member-followup',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 20 * 60_000,
          actorIds: ['a'],
          targetIds: ['b'],
          summary: 'a 对 b 形成手动跟进关注候选',
          visibility: 'derived_public',
          payload: {
            source: 'manual_attention_followup_member',
            confidence: 0.92,
            targetIds: ['b'],
          },
        }],
        relationshipLedger: [{
          pairKey: 'a->b',
          actorId: 'a',
          targetId: 'b',
          current: { warmth: 7, competence: 5, trust: 6, threat: 1 },
          trend: 'up',
          recentEvents: [],
          lastUpdatedAt: now - 60_000,
        }],
      });
      const result = await openChatEngine.onMessageCommitted({
        conversation: chat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: {
          type: 'ai',
          senderId: 'a',
          content: '我补充一个观点。',
          interactionHint: null,
        },
        previousAiMessage: null,
        recentMessages: [],
      });
      const nextEvents = readAppliedRuntimeEvents(chat, result);
      expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_share_moment')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skip('allows night-owl persona to emit share_moment at late night with richer artifacts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T23:50:00+08:00'));
    try {
      const now = Date.now();
      const chat = normalizeConversation({
        ...buildChat(),
        memberIds: ['a', 'b'],
        runtimeEventsV2: [{
          id: 'evt-attention-member-followup',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 25 * 60_000,
          actorIds: ['a'],
          targetIds: ['b'],
          summary: 'a 对 b 形成手动跟进关注候选',
          visibility: 'derived_public',
          payload: {
            source: 'manual_attention_followup_member',
            confidence: 0.92,
            targetIds: ['b'],
          },
        }, {
          id: 'evt-recent-outing-artifact',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 30 * 60_000,
          actorIds: ['a'],
          targetIds: ['b'],
          summary: '刚刚线下活动结束',
          visibility: 'derived_public',
          payload: {
            artifactType: 'outing_summary',
            eventKind: 'social_outing',
          },
        }],
        relationshipLedger: [{
          pairKey: 'a->b',
          actorId: 'a',
          targetId: 'b',
          current: { warmth: 8, competence: 5, trust: 7, threat: 1 },
          trend: 'up',
          recentEvents: [],
          lastUpdatedAt: now - 60_000,
        }],
      });
      const nightOwl = { ...buildCharacter('a', '甲'), speakingStyle: '夜猫子主播，常常夜间下播后更新动态' };
      const result = await openChatEngine.onMessageCommitted({
        conversation: chat,
        characters: [nightOwl, buildCharacter('b', '乙')],
        message: {
          type: 'ai',
          senderId: 'a',
          content: '我补充一个观点。',
          interactionHint: null,
        },
        previousAiMessage: null,
        recentMessages: [],
      });
      const nextEvents = readAppliedRuntimeEvents(chat, result);
      const moment = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_share_moment');
      expect(moment).toBeTruthy();
      const payload = moment?.payload as { expectedArtifacts?: string[] };
      expect(payload.expectedArtifacts?.includes('moment_text')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skip('boosts check_in candidate confidence when user follow-up has been completed', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 7, competence: 4, trust: 6, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-manual-user-followup',
        conversationId: 'chat-1',
        kind: 'director_intervention',
        createdAt: now - 20 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '让a跟进用户',
        visibility: 'moderator_only',
        payload: { eventType: 'attention_followup_user', actorId: 'a', focus: '先回应用户再追问' },
      }, {
        id: 'evt-a-replied-user',
        conversationId: 'chat-1',
        kind: 'message_generated',
        createdAt: now - 15 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 跟进用户',
        visibility: 'public',
        payload: { text: '我先回应你的问题，再追问一个关键细节。' },
      }, {
        id: 'evt-attention-user-a',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 8 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'evt-recent-outing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 20 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '刚发起活动邀约',
        visibility: 'derived_public',
        payload: { artifactType: 'outing_summary', eventKind: 'social_outing', text: '刚发起活动邀约' },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来补一个提醒。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const checkIn = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'attention_check_in');
    expect(checkIn).toBeTruthy();
    expect((checkIn?.payload as { confidence?: number }).confidence).toBeGreaterThanOrEqual(0.84);
  });

  it.skip('adjusts check_in confidence from world influence evaluation feedback', async () => {
    const now = Date.now();
    const baseChat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 7, competence: 4, trust: 6, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention-user-a',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 8 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }],
    });
    const influencedChat = normalizeConversation({
      ...baseChat,
      runtimeEventsV2: [...(baseChat.runtimeEventsV2 || []), {
        id: 'evt-world-influence-eval',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 2 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '世界影响规则评估',
        visibility: 'derived_public',
        payload: {
          eventType: 'world_influence_rule_evaluated',
          matchedRuleIds: ['comfort_first'],
          unmetRuleIds: [],
        },
      }],
    });
    const [baseResult, influencedResult] = await Promise.all([
      openChatEngine.onMessageCommitted({
        conversation: baseChat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: { type: 'ai', senderId: 'a', content: '我来补一个提醒。', interactionHint: null },
        previousAiMessage: null,
        recentMessages: [],
      }),
      openChatEngine.onMessageCommitted({
        conversation: influencedChat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: { type: 'ai', senderId: 'a', content: '我来补一个提醒。', interactionHint: null },
        previousAiMessage: null,
        recentMessages: [],
      }),
    ]);
    const baseEvents = readAppliedRuntimeEvents(baseChat, baseResult);
    const influencedEvents = readAppliedRuntimeEvents(influencedChat, influencedResult);
    const baseCheckIn = baseEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'attention_check_in');
    const influencedCheckIn = influencedEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'attention_check_in');
    expect(baseCheckIn).toBeTruthy();
    expect(influencedCheckIn).toBeTruthy();
    const baseConfidence = (baseCheckIn?.payload as { confidence?: number }).confidence || 0;
    const influencedConfidence = (influencedCheckIn?.payload as { confidence?: number }).confidence || 0;
    expect(influencedConfidence).toBeGreaterThan(baseConfidence);
  });

  it.skip('boosts share_moment candidate confidence when member follow-up has been completed', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-manual-member-followup',
        conversationId: 'chat-1',
        kind: 'director_intervention',
        createdAt: now - 20 * 60_000,
        actorIds: ['user'],
        targetIds: ['a', 'b'],
        summary: '让a跟进b',
        visibility: 'moderator_only',
        payload: { eventType: 'attention_followup_member', actorId: 'a', targetId: 'b', focus: '先回应乙再追问' },
      }, {
        id: 'evt-a-replied-b',
        conversationId: 'chat-1',
        kind: 'message_generated',
        createdAt: now - 15 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 跟进 b',
        visibility: 'public',
        payload: { text: '乙，我先回应你刚才的判断，再追问一个细节。' },
      }, {
        id: 'evt-attention-a-b',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 10 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 对 b 形成关注候选',
        visibility: 'derived_public',
        payload: { source: 'manual_attention_followup_member', confidence: 0.92, targetIds: ['b'] },
      }, {
        id: 'evt-recent-outing-artifact',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 40 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '刚刚线下活动结束',
        visibility: 'derived_public',
        payload: {
          artifactType: 'outing_summary',
          eventKind: 'social_outing',
        },
      }],
      relationshipLedger: [{
        pairKey: 'a->b',
        actorId: 'a',
        targetId: 'b',
        current: { warmth: 8, competence: 5, trust: 7, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我再补一句。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    const moment = nextEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_share_moment');
    expect(moment).toBeTruthy();
    expect((moment?.payload as { confidence?: number }).confidence).toBeGreaterThanOrEqual(0.88);
  });

  it.skip('boosts calendar reminder confidence after urgent-calendar influence evaluation', async () => {
    const now = Date.now();
    const baseChat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到明天安排',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'evt-recent-outing',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 20 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '刚发起活动邀约',
        visibility: 'derived_public',
        payload: { artifactType: 'outing_summary', eventKind: 'social_outing', text: '刚发起活动邀约' },
      }],
    });
    const influencedChat = normalizeConversation({
      ...baseChat,
      runtimeEventsV2: [...(baseChat.runtimeEventsV2 || []), {
        id: 'evt-world-influence-eval',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 2 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '世界影响规则评估',
        visibility: 'derived_public',
        payload: {
          eventType: 'world_influence_rule_evaluated',
          matchedRuleIds: ['urgent_calendar_first'],
          unmetRuleIds: [],
        },
      }],
    });
    const [baseResult, influencedResult] = await Promise.all([
      openChatEngine.onMessageCommitted({
        conversation: baseChat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: { type: 'ai', senderId: 'a', content: '我再补一句。', interactionHint: null },
        previousAiMessage: null,
        recentMessages: [],
      }),
      openChatEngine.onMessageCommitted({
        conversation: influencedChat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: { type: 'ai', senderId: 'a', content: '我再补一句。', interactionHint: null },
        previousAiMessage: null,
        recentMessages: [],
      }),
    ]);
    const baseEvents = readAppliedRuntimeEvents(baseChat, baseResult);
    const influencedEvents = readAppliedRuntimeEvents(influencedChat, influencedResult);
    const baseReminder = baseEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_calendar_reminder');
    const influencedReminder = influencedEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_calendar_reminder');
    expect(baseReminder).toBeTruthy();
    expect(influencedReminder).toBeTruthy();
    const baseReminderConfidence = (baseReminder?.payload as { confidence?: number }).confidence || 0;
    const influencedReminderConfidence = (influencedReminder?.payload as { confidence?: number }).confidence || 0;
    expect(influencedReminderConfidence).toBeGreaterThan(baseReminderConfidence);
  });

  it.skip('suppresses share_moment confidence when urgent-calendar and restraint feedback exists', async () => {
    const now = Date.now();
    const baseChat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-attention-a-b',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 10 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 对 b 形成关注候选',
        visibility: 'derived_public',
        payload: { source: 'manual_attention_followup_member', confidence: 0.92, targetIds: ['b'] },
      }, {
        id: 'evt-recent-outing-artifact',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 40 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '刚刚线下活动结束',
        visibility: 'derived_public',
        payload: { artifactType: 'outing_summary', eventKind: 'social_outing' },
      }],
      relationshipLedger: [{
        pairKey: 'a->b',
        actorId: 'a',
        targetId: 'b',
        current: { warmth: 8, competence: 5, trust: 7, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
    });
    const influencedChat = normalizeConversation({
      ...baseChat,
      runtimeEventsV2: [...(baseChat.runtimeEventsV2 || []), {
        id: 'evt-world-influence-eval',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 2 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '世界影响规则评估',
        visibility: 'derived_public',
        payload: {
          eventType: 'world_influence_rule_evaluated',
          matchedRuleIds: ['urgent_calendar_first'],
          unmetRuleIds: ['low_pressure_restraint'],
        },
      }],
    });
    const [baseResult, influencedResult] = await Promise.all([
      openChatEngine.onMessageCommitted({
        conversation: baseChat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: { type: 'ai', senderId: 'a', content: '我再补一句。', interactionHint: null },
        previousAiMessage: null,
        recentMessages: [],
      }),
      openChatEngine.onMessageCommitted({
        conversation: influencedChat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: { type: 'ai', senderId: 'a', content: '我再补一句。', interactionHint: null },
        previousAiMessage: null,
        recentMessages: [],
      }),
    ]);
    const baseEvents = readAppliedRuntimeEvents(baseChat, baseResult);
    const influencedEvents = readAppliedRuntimeEvents(influencedChat, influencedResult);
    const baseMoment = baseEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_share_moment');
    const influencedMoment = influencedEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_share_moment');
    expect(baseMoment).toBeTruthy();
    expect(influencedMoment).toBeTruthy();
    const baseMomentConfidence = (baseMoment?.payload as { confidence?: number }).confidence || 0;
    const influencedMomentConfidence = (influencedMoment?.payload as { confidence?: number }).confidence || 0;
    expect(influencedMomentConfidence).toBeLessThan(baseMomentConfidence);
  });

  it.skip('suppresses world_attention_share_moment when no recent trigger artifact exists', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-attention-a-b',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 10 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 对 b 形成关注候选',
        visibility: 'derived_public',
        payload: { source: 'manual_attention_followup_member', confidence: 0.92, targetIds: ['b'] },
      }],
      relationshipLedger: [{
        pairKey: 'a->b',
        actorId: 'a',
        targetId: 'b',
        current: { warmth: 8, competence: 5, trust: 7, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我再补一句。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_share_moment')).toBe(false);
    const suppressed = nextEvents.find((event) => event.kind === 'action_resolution'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { reasonType?: string }).reasonType === 'restraint_policy'
      && (event.payload as { candidateEventKind?: string }).candidateEventKind === 'post_moment');
    expect(suppressed).toBeTruthy();
    expect((suppressed?.payload as { reasonDetail?: string }).reasonDetail).toContain('缺少近期可投射为动态的事件触发');
  });

  it('blocks world attention invite_activity backflow in quiet hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T23:40:00+08:00'));
    try {
      const now = Date.now();
      const chat = normalizeConversation({
        ...buildChat(),
        relationshipLedger: [{
          pairKey: 'a->user',
          actorId: 'a',
          targetId: 'user',
          current: { warmth: 14, competence: 4, trust: 12, threat: 0 },
          trend: 'up',
          recentEvents: [],
          lastUpdatedAt: now - 2_000,
        }],
        runtimeEventsV2: [{
          id: 'evt-attention',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2 * 60_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到周末可以一起活动',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', confidence: 0.94, targetIds: ['a'] },
        }],
      });
      const result = await openChatEngine.onMessageCommitted({
        conversation: chat,
        characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
        message: {
          type: 'ai',
          senderId: 'a',
          content: '要不周末一起散步？',
          interactionHint: null,
        },
        previousAiMessage: null,
        recentMessages: [],
      });
      const nextEvents = readAppliedRuntimeEvents(chat, result);
      expect(nextEvents.some((event) => event.kind === 'artifact' && (event.payload as { eventKind?: string }).eventKind === 'social_outing')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks world attention calendar_reminder backflow when recent private follow-up exists', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 2_000,
      }],
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户提到明天安排',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.9, targetIds: ['a'] },
      }, {
        id: 'evt-recent-private',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: now - 30 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 刚私聊跟进过',
        visibility: 'derived_public',
        payload: {
          eventKind: 'pair_private_thread',
          initiatorId: 'a',
          participantIds: ['a', 'user'],
          targetIds: ['user'],
          reasonType: 'attention_followup',
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '刚刚跟进过',
          visibilityPlan: 'user_private',
          expectedArtifacts: ['private_thread_summary'],
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我来补一个提醒。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const nextEvents = readAppliedRuntimeEvents(chat, result);
    expect(nextEvents.some((event) => event.kind === 'artifact' && (event.payload as { eventKind?: string }).eventKind === 'status_update')).toBe(false);
  });

  it.skip('keeps attention proactive chain explainable and suppresses repeated candidates after artifact backflow', async () => {
    const now = Date.now();
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 7, competence: 4, trust: 6, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 10 * 60_000,
      }],
      runtimeEventsV2: [
        {
          id: 'evt-attention',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2 * 60_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户点名a',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', confidence: 0.92, targetIds: ['a'] },
        },
        {
          id: 'evt-moment',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 5 * 60_000,
          actorIds: ['b'],
          targetIds: ['user'],
          summary: 'B 发动态',
          visibility: 'derived_public',
          payload: { artifactType: 'moment_text', eventKind: 'post_moment', text: '晚饭真不错' },
        },
      ],
    });

    const firstResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我先接住这个请求。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const firstApplied = applyResultToChat(chat, firstResult);
    const firstEvents = firstApplied.runtimeEventsV2 || [];
    const checkInCandidate = firstEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    const reactCandidate = firstEvents.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment');
    const checkInArtifact = firstEvents.find((event) => event.kind === 'artifact' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    const reactArtifact = firstEvents.find((event) => event.kind === 'artifact' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment');

    expect(checkInCandidate).toBeTruthy();
    expect(reactCandidate).toBeTruthy();
    expect(checkInArtifact).toBeTruthy();
    expect(reactArtifact).toBeTruthy();
    expect((checkInCandidate?.payload as { attentionTrace?: { score?: number; reasons?: string[] } }).attentionTrace?.score).toBeGreaterThan(0);
    expect(((checkInCandidate?.payload as { attentionTrace?: { reasons?: string[] } }).attentionTrace?.reasons || []).length).toBeGreaterThan(0);

    const secondResult = await openChatEngine.onMessageCommitted({
      conversation: firstApplied,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我再补一句。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const secondDeltaEvents = readRuntimeEvents(secondResult);
    expect(secondDeltaEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in')).toBe(false);
    expect(secondDeltaEvents.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'react_to_moment')).toBe(false);
  });

  it('records withdrawal residue without preserving the withdrawn text as public runtime', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result: DriverMessageCommitResult = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '甲撤回了一条消息',
        metadata: {
          withdrawal: {
            withdrawn: true,
            originalContent: '乙，你这说法真的太离谱了。',
            reason: '前面的刺留下了关系修复压力。',
            withdrawnAt: 123,
          },
        },
        interactionHint: {
          kind: 'challenge',
          actorId: 'a',
          targetId: 'b',
          intensity: 4,
          tone: 'annoyed',
          evidenceText: '乙，你这说法真的太离谱了。',
          confidence: 0.95,
        },
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    const applied = applyResultToChat(chat, result);
    const events = applied.runtimeEventsV2 || [];
    expect(events.some((event) => event.kind === 'message_generated' && event.summary.includes('撤回了一条消息'))).toBe(true);
    expect(events.some((event) => event.summary.includes('太离谱'))).toBe(false);
    expect(events.some((event) => event.payload && JSON.stringify(event.payload).includes('太离谱'))).toBe(false);
    expect(events.some((event) => event.kind === 'memory_candidate' && event.summary.includes('撤回本身'))).toBe(true);
    expect(applied.relationshipLedger?.length || 0).toBe(0);
  });

  it('keeps relationship ledger recent events lightweight across structured commits', async () => {
    let chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];

    for (let index = 0; index < 4; index += 1) {
      const result = await openChatEngine.onMessageCommitted({
        conversation: chat,
        characters,
        message: {
          type: 'ai',
          senderId: 'a',
          content: `乙，你第 ${index + 1} 次这个说法我还是不同意。`,
          interactionHint: {
            kind: 'challenge',
            actorId: 'a',
            targetId: 'b',
            intensity: 4,
            tone: 'annoyed',
            evidenceText: `乙，你第 ${index + 1} 次这个说法我还是不同意。`,
            confidence: 0.92,
            relationship: {
              delta: { warmth: -1, competence: -1, trust: -2, threat: 1, attachment: 0, deference: 0 },
              labels: ['累积质疑'],
              stance: '对乙的重复判断持续不信任',
            },
          },
        },
        previousAiMessage: null,
        recentMessages: [],
      });

      chat = applyResultToChat(chat, result);
    }

    const ledger = chat.relationshipLedger || [];
    expect(ledger.length).toBeGreaterThan(0);
    const recentEvent = ledger[0]?.recentEvents.at(-1);
    expect(recentEvent && 'summary' in recentEvent).toBe(true);
    expect(recentEvent && Object.prototype.hasOwnProperty.call(recentEvent, 'payload')).toBe(false);
    expect(JSON.stringify(ledger).length).toBeLessThan(6000);
  });

  it('adds post moment candidate/events for celebratory room messages', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const message = {
      type: 'ai' as const,
      senderId: 'a',
      content: '今天这波聊得可以，晚上去吃火锅顺便拍个合照吧。',
      interactionHint: {
        kind: 'support' as const,
        actorId: 'a',
        targetId: 'b',
        intensity: 3,
        tone: 'warm' as const,
        evidenceText: '今天这波聊得可以，晚上去吃火锅顺便拍个合照吧。',
        confidence: 0.9,
      },
      socialEventHints: [{
        eventKind: 'post_moment' as const,
        targetIds: ['b'],
        reasonType: 'celebration',
        confidence: 0.88,
        urgency: 'soon' as const,
        seedIntent: '想发一条和刚才活动气氛有关的动态。',
        visibilityPlan: 'public' as const,
        expectedArtifacts: ['moment_text', 'moment_food_photo', 'moment_group_photo'],
        title: '朋友圈动态',
        activityType: '记录聚会',
        dedupeKey: 'moment-a-celebration-1',
      }],
    };
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: message as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(true);
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text')).toBe(true);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { sourceText?: string }).sourceText?.includes('吃火锅'))).toBe(true);
  });

  it('delays hinted post moment when the same response creates a social outing candidate', async () => {
    vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '那就今晚一起去吃火锅庆祝一下，顺便拍张合照，晚点发条动态。',
        interactionHint: {
          kind: 'support',
          actorId: 'a',
          targetId: 'b',
          intensity: 3,
          tone: 'warm',
          evidenceText: '那就今晚一起去吃火锅庆祝一下，顺便拍张合照，晚点发条动态。',
          confidence: 0.9,
        },
        socialEventHints: [{
          eventKind: 'social_outing',
          participantIds: ['a', 'b'],
          targetIds: ['b'],
          reasonType: 'celebration',
          confidence: 0.91,
          urgency: 'soon',
          seedIntent: '约定今晚一起去吃火锅庆祝。',
          visibilityPlan: 'public',
          expectedArtifacts: ['outing_summary'],
          title: '火锅庆祝',
          activityType: '聚餐',
          dedupeKey: 'outing-with-moment-1',
        }, {
          eventKind: 'post_moment',
          participantIds: ['a'],
          targetIds: ['b'],
          reasonType: 'celebration',
          confidence: 0.89,
          urgency: 'soon',
          seedIntent: '想把今晚聚餐的开心气氛发成动态。',
          visibilityPlan: 'public',
          expectedArtifacts: ['moment_text'],
          title: '朋友圈动态',
          activityType: '记录聚会',
          dedupeKey: 'moment-after-outing-1',
        }],
      } as OpenChatCommittedMessageForTest,
      previousAiMessage: null,
      recentMessages: [],
      apiConfig: buildApiConfig(),
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing')).toBe(true);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(false);
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text')).toBe(false);
    const suppression = events.find((event) => event.kind === 'action_resolution'
      && (event.payload as { eventType?: string; candidateEventKind?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { candidateEventKind?: string }).candidateEventKind === 'post_moment');
    expect(suppression?.payload).toMatchObject({
      reasonType: 'world_attention_moment_delay_window',
      nextSuggestedAt: expect.any(Number),
    });
  });

  it('adds social outing candidate/events for outing-style room messages', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const message = {
      type: 'ai' as const,
      senderId: 'a',
      content: '那就今晚一起去吃火锅庆祝一下，顺便拍张合照。',
      interactionHint: {
        kind: 'support' as const,
        actorId: 'a',
        targetId: 'b',
        intensity: 3,
        tone: 'warm' as const,
        evidenceText: '那就今晚一起去吃火锅庆祝一下，顺便拍张合照。',
        confidence: 0.9,
      },
      socialEventHints: [{
        eventKind: 'social_outing' as const,
        participantIds: ['a', 'b'],
        reasonType: 'celebration',
        confidence: 0.9,
        urgency: 'soon' as const,
        seedIntent: '想把刚才群里的热络气氛延续成一次线下活动。',
        visibilityPlan: 'public' as const,
        expectedArtifacts: ['outing_summary', 'group_photo', 'food_photo'],
        title: '线下活动',
        activityType: '吃饭',
        timeHint: '今晚',
        locationHint: '未定',
        dedupeKey: 'outing-tonight-a-b',
        participantStates: { a: 'interested', b: 'invited' },
      }],
    };
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: message as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    const outing = events.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing');
    expect(outing).toBeTruthy();
    expect((outing?.payload as { participantStates?: Record<string, string> }).participantStates).toEqual({ a: 'interested', b: 'invited' });
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'outing_summary')).toBe(false);
  });

  it('uses valid social outing target ids as invited participants', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '今晚一起去喝茶。',
        socialEventHints: [{
          eventKind: 'social_outing',
          targetIds: ['b'],
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '邀约对方喝茶。',
          visibilityPlan: 'public',
          title: '喝茶',
          activityType: '茶馆',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const outing = readRuntimeEvents(result).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing');
    expect((outing?.payload as { participantIds?: string[] }).participantIds).toEqual(['a', 'b']);
    expect((outing?.payload as { targetIds?: string[] }).targetIds).toEqual(['b']);
  });

  it('creates social outing candidate when model-authored activity hint omits confidence', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '今晚九点半去后巷那家茶馆，我把地址发群里。',
        socialEventHints: [{
          eventKind: 'social_outing',
          participantIds: ['a', 'b'],
          targetIds: ['b'],
          reasonType: 'chat_activity_invite',
          urgency: 'soon',
          seedIntent: '聊天里已经安排了具体时间地点的茶馆活动。',
          visibilityPlan: 'public',
          title: '茶馆小聚',
          activityType: '茶馆',
          timeHint: '今晚九点半',
          locationHint: '后巷茶馆',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const outing = readRuntimeEvents(result).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing');
    expect(outing).toBeTruthy();
    expect((outing?.payload as { confidence?: number }).confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('records diagnostic when model-authored social outing hint confidence is too low', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '改天有空再约。',
        socialEventHints: [{
          eventKind: 'social_outing',
          participantIds: ['a', 'b'],
          confidence: 0.51,
          urgency: 'defer',
          seedIntent: '只是模糊地说以后再约。',
          visibilityPlan: 'public',
          title: '改天再约',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing')).toBe(false);
    const diagnostic = events.find((event) => event.kind === 'action_resolution' && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'structured_social_event_hint_rejected');
    expect(diagnostic?.payload).toMatchObject({
      candidateEventKind: 'social_outing',
      reasonType: 'low_confidence',
      threshold: 0.72,
    });
  });

  it('accepts single-participant updates for an existing model-authored social outing', async () => {
    const chat = buildChat({
      runtimeEventsV2: [{
        id: 'evt-existing-outing',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: Date.now() - 1_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '甲发起茶馆活动',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          initiatorId: 'a',
          participantIds: ['a', 'b'],
          targetIds: ['b'],
          reasonType: 'chat_activity_invite',
          confidence: 0.86,
          urgency: 'soon',
          seedIntent: '茶馆小聚',
          visibilityPlan: 'public',
          expectedArtifacts: ['outing_summary'],
          title: '茶馆小聚',
          activityType: '茶馆',
          dedupeKey: 'outing-tea-house',
          participantStates: { a: 'interested', b: 'invited' },
        } satisfies SocialEventCandidatePayload,
      }],
    });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'b',
        content: '我临时有事，这次茶馆我先不去了。',
        socialEventHints: [{
          eventKind: 'social_outing',
          participantIds: ['b'],
          reasonType: 'chat_activity_followup',
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '乙明确退出同一个茶馆活动。',
          visibilityPlan: 'public',
          expectedArtifacts: ['outing_summary'],
          title: '茶馆小聚',
          activityType: '茶馆',
          dedupeKey: 'outing-tea-house',
          participantStates: { b: 'declined' },
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const outing = readRuntimeEvents(result).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string; dedupeKey?: string }).eventKind === 'social_outing' && (event.payload as { dedupeKey?: string }).dedupeKey === 'outing-tea-house');
    expect(outing).toBeTruthy();
    expect((outing?.payload as SocialEventCandidatePayload).participantStates).toMatchObject({ b: 'declined' });
    expect((outing?.payload as SocialEventCandidatePayload).participantIds).toEqual(['b']);
  });

  it('rejects social outing hints whose participants are not valid member ids', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '今晚大家去茶馆。',
        socialEventHints: [{
          eventKind: 'social_outing',
          participantIds: ['甲', '乙'],
          targetIds: ['胡适'],
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '邀约大家喝茶。',
          visibilityPlan: 'public',
          title: '茶馆局',
          activityType: '茶馆',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing')).toBe(false);
    const diagnostic = events.find((event) => event.kind === 'action_resolution' && (event.payload as { eventType?: string }).eventType === 'structured_social_event_hint_rejected');
    expect(diagnostic?.visibility).toBe('moderator_only');
    expect(diagnostic?.payload).toMatchObject({
      candidateEventKind: 'social_outing',
      reasonType: 'invalid_participants',
      invalidParticipantIds: ['甲', '乙'],
      invalidTargetIds: ['胡适'],
    });
  });

  it('does not create social outing candidate from user activity invite without model-authored hint', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'user',
        senderId: 'user',
        content: '周末大家一起去吃火锅吧。',
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    const outing = events.find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing');
    expect(outing).toBeFalsy();
    expect(events.some((event) => event.kind === 'calendar_item_patch')).toBe(false);
  });

  it('does not create social outing candidate from AI visible invite without model-authored hint', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '鲁迅'), buildCharacter('b', '胡适'), buildCharacter('c', '苏苏')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '行，既然都在线，那不如趁今晚的热气还没散透——九点半，后巷那家还亮着灯的旧茶馆，我请。地址我发群里，走到巷口看见门帘上缝着一块蓝布的就是。',
        socialEventHints: null,
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing')).toBe(false);
  });

  it('does not patch latest tentative social outing from follow-up chat without model-authored hint', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-outing',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 1,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 提出活动候选：火锅',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          initiatorId: 'a',
          participantIds: ['a', 'b'],
          targetIds: ['b'],
          reasonType: 'chat_activity_invite',
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '聊天里出现活动邀约。',
          visibilityPlan: 'public',
          expectedArtifacts: ['outing_summary'],
          title: '吃火锅',
          activityType: '吃火锅',
          timeHint: '周末',
          dedupeKey: 'outing-hotpot',
        },
      }],
    });
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      message: {
        type: 'ai',
        senderId: 'b',
        content: '好啊，我也去，改到周日吧。',
        interactionHint: null,
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'calendar_item_patch')).toBe(false);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing')).toBe(false);
  });

  it('creates post moment candidates from main-response social event hints', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const message: OpenChatCommittedMessageForTest = {
      type: 'ai',
      senderId: 'a',
      content: '今天太开心了，刚才那一幕我都想发出来。',
      interactionHint: {
        kind: 'support',
        actorId: 'a',
        targetId: 'b',
        intensity: 3,
        tone: 'warm',
        evidenceText: '今天太开心了，刚才那一幕我都想发出来。',
        confidence: 0.9,
      },
      socialEventHints: [{
        eventKind: 'post_moment',
        participantIds: ['a'],
        targetIds: ['b'],
        reasonType: 'celebration',
        confidence: 0.91,
        urgency: 'soon',
        seedIntent: '想把刚才的开心时刻发成动态。',
        visibilityPlan: 'public',
        expectedArtifacts: ['moment_text'],
        title: '朋友圈动态',
        activityType: '记录聚会',
        dedupeKey: 'moment-main-hint-1',
      }],
    };
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message,
      previousAiMessage: null,
      recentMessages: [],
      apiConfig: buildApiConfig(),
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(true);
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text')).toBe(true);
    expect(generateResponseMock).not.toHaveBeenCalled();
  });

  it('does not publish hinted post moment immediately during quiet hours', async () => {
    vi.setSystemTime(new Date('2026-06-01T23:45:00+08:00'));
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '刚才那一幕我想发条动态记一下。',
        interactionHint: null,
        socialEventHints: [{
          eventKind: 'post_moment',
          participantIds: ['a'],
          targetIds: ['b'],
          reasonType: 'celebration',
          confidence: 0.91,
          urgency: 'soon',
          seedIntent: '想把刚才的开心时刻发成动态。',
          visibilityPlan: 'public',
          expectedArtifacts: ['moment_text'],
          title: '朋友圈动态',
          activityType: '记录聚会',
          dedupeKey: 'moment-main-hint-quiet-hours',
        }],
      } as OpenChatCommittedMessageForTest,
      previousAiMessage: null,
      recentMessages: [],
      apiConfig: buildApiConfig(),
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(false);
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text')).toBe(false);
    const suppression = events.find((event) => event.kind === 'action_resolution'
      && (event.payload as { eventType?: string; candidateEventKind?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { candidateEventKind?: string }).candidateEventKind === 'post_moment');
    expect(suppression?.payload).toMatchObject({
      reasonType: 'world_attention_moment_quiet_hours',
      nextSuggestedAt: expect.any(Number),
    });
    expect(generateResponseMock).not.toHaveBeenCalled();
  });

  it('does not run AI post moment analysis when no main-response hint is provided', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '刚才这段我真想发出来记录一下。',
        interactionHint: {
          kind: 'support',
          actorId: 'a',
          targetId: 'b',
          intensity: 3,
          tone: 'warm',
          evidenceText: '刚才这段我真想发出来记录一下。',
          confidence: 0.9,
        },
      },
      previousAiMessage: null,
      recentMessages: [],
      apiConfig: buildApiConfig(),
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(false);
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text')).toBe(false);
    expect(events.some((event) => event.kind === 'message_generated')).toBe(true);
    expect(generateResponseMock).not.toHaveBeenCalled();
  });

  it('does not run social event LLM analysis for ordinary messages without explicit hints', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '这事先这样吧，我听明白你的意思了。',
        interactionHint: {
          kind: 'support',
          actorId: 'a',
          targetId: 'b',
          intensity: 3,
          tone: 'warm',
          evidenceText: '这事先这样吧，我听明白你的意思了。',
          confidence: 0.9,
        },
      },
      previousAiMessage: null,
      recentMessages: [],
      apiConfig: buildApiConfig(),
    });

    expect(generateResponseMock).not.toHaveBeenCalled();
    expect((readRuntimeEvents(result)).some((event) => event.kind === 'event_candidate')).toBe(false);
  });

  it.skip('gates pair private thread candidates on actual interaction state', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我们之后再说吧。',
        interactionHint: {
          kind: 'support',
          actorId: 'a',
          targetId: 'b',
          intensity: 1,
          tone: 'warm',
          evidenceText: '我们之后再说吧。',
          confidence: 0.9,
        },
        socialEventHints: [{
          eventKind: 'pair_private_thread',
          participantIds: ['a', 'b'],
          targetIds: ['b'],
          reasonType: 'unresolved_question',
          confidence: 0.9,
          urgency: 'immediate',
          seedIntent: '想私下继续聊。',
          visibilityPlan: 'conversation_private',
          expectedArtifacts: ['private_thread_summary'],
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    expect((readRuntimeEvents(result)).some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'pair_private_thread')).toBe(false);
  });

  it.skip('creates character companionship private thread candidates with concrete opening message', async () => {
    const chat = buildChat({ memberIds: ['a', 'b'] });
    const characters = [
      buildCharacter('a', '甲', {
        relationships: [{
          characterId: 'b',
          warmth: 74,
          trust: 70,
          competence: 30,
          threat: 2,
          note: '共同秘密是只有他们知道的暗号；约定每次争执后先递台阶；担心乙最近太累。',
          updatedAt: Date.now() - 10_000,
        }],
      }),
      buildCharacter('b', '乙'),
    ];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '嗯，我知道了。这个先放一放吧。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const candidate = readRuntimeEvents(result).find((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string; reasonType?: string }).eventKind === 'pair_private_thread'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_care_followup');
    const payload = candidate?.payload as SocialEventCandidatePayload | undefined;
    expect(payload?.participantIds).toEqual(['a', 'b']);
    expect(payload?.targetIds).toEqual(['b']);
    expect(payload?.visibilityPlan).toBe('conversation_private');
    expect(payload?.triggerReason).toContain('担心乙最近太累');
    expect(payload?.openingMessage).toContain('乙');
    expect(payload?.openingMessage).toContain('放心不下');
    expect(payload?.openingMessage).not.toContain('系统');
  });

  it.skip('creates character companionship private thread candidates from shared promises', async () => {
    const chat = buildChat({ memberIds: ['a', 'b'] });
    const characters = [
      buildCharacter('a', '甲', {
        relationships: [{
          characterId: 'b',
          warmth: 70,
          trust: 68,
          competence: 30,
          threat: 2,
          note: '约定下次争执后先把话说完。',
          updatedAt: Date.now() - 10_000,
        }],
      }),
      buildCharacter('b', '乙'),
    ];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '这件事我先不在这里展开。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });
    const candidate = readRuntimeEvents(result).find((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string; reasonType?: string }).eventKind === 'pair_private_thread'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_promise_followup');
    const payload = candidate?.payload as SocialEventCandidatePayload | undefined;
    expect(payload?.participantIds).toEqual(['a', 'b']);
    expect(payload?.triggerReason).toContain('约定下次争执后先把话说完');
    expect(payload?.openingMessage).toContain('之前说好的事');
  });

  it.skip('does not create character companionship private thread candidates during schedule cooldown', async () => {
    const chat = buildChat({
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-schedule-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: Date.now() - 10 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '角色陪伴私聊已进入冷却',
        visibility: 'role_private',
        visibleToIds: ['a', 'b'],
        payload: {
          eventType: 'companionship_private_thread_schedule',
          actorId: 'a',
          targetId: 'b',
          participantIds: ['a', 'b'],
          action: 'opened',
          reasonType: 'companionship_promise_followup',
          dedupeKey: 'companionship-private-thread-chat-1-a-b',
          nextAvailableAt: Date.now() + 60 * 60_000,
        },
      }],
    });
    const characters = [
      buildCharacter('a', '甲', {
        relationships: [{
          characterId: 'b',
          warmth: 70,
          trust: 68,
          competence: 30,
          threat: 2,
          note: '约定下次争执后先把话说完。',
          updatedAt: Date.now() - 10_000,
        }],
      }),
      buildCharacter('b', '乙'),
    ];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '这件事我先不在这里展开。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string; reasonType?: string }).eventKind === 'pair_private_thread'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_promise_followup')).toBe(false);
    expect(events.some((event) => (event.payload as { eventType?: string; action?: string }).eventType === 'companionship_private_thread_schedule'
      && (event.payload as { action?: string }).action === 'skipped')).toBe(true);
  });

  it.skip('creates companionship private thread candidates when schedule cooldown is disabled', async () => {
    setCompanionshipRuntimeConfig({
      ...DEFAULT_COMPANIONSHIP_SETTINGS,
      privateThreadCooldownHours: 0,
    });
    const chat = buildChat({
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-schedule-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: Date.now() - 10 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '角色陪伴私聊已进入冷却',
        visibility: 'role_private',
        visibleToIds: ['a', 'b'],
        payload: {
          eventType: 'companionship_private_thread_schedule',
          actorId: 'a',
          targetId: 'b',
          participantIds: ['a', 'b'],
          action: 'opened',
          reasonType: 'companionship_promise_followup',
          dedupeKey: 'companionship-private-thread-chat-1-a-b',
          nextAvailableAt: Date.now() + 60 * 60_000,
        },
      }],
    });
    const characters = [
      buildCharacter('a', '甲', {
        relationships: [{
          characterId: 'b',
          warmth: 70,
          trust: 68,
          competence: 30,
          threat: 2,
          note: '约定下次争执后先把话说完。',
          updatedAt: Date.now() - 10_000,
        }],
      }),
      buildCharacter('b', '乙'),
    ];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '这件事我先不在这里展开。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    expect(readRuntimeEvents(result).some((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string; reasonType?: string }).eventKind === 'pair_private_thread'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_promise_followup')).toBe(true);
  });

  it.skip('records suppressed diagnostics when character companionship private threads are disabled', async () => {
    setCompanionshipRuntimeConfig({
      ...DEFAULT_COMPANIONSHIP_SETTINGS,
      enableCharacterPrivateThreads: false,
    });
    const chat = buildChat({ memberIds: ['a', 'b'] });
    const characters = [
      buildCharacter('a', '甲', {
        relationships: [{
          characterId: 'b',
          warmth: 70,
          trust: 68,
          competence: 30,
          threat: 2,
          note: '约定下次争执后先把话说完。',
          updatedAt: Date.now() - 10_000,
        }],
      }),
      buildCharacter('b', '乙'),
    ];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '这件事我先不在这里展开。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string; reasonType?: string }).eventKind === 'pair_private_thread'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_promise_followup')).toBe(false);
    const suppressed = events.find((event) => (event.payload as { eventType?: string; action?: string }).eventType === 'companionship_private_thread_schedule'
      && (event.payload as { action?: string }).action === 'suppressed');
    expect(suppressed).toBeTruthy();
    expect((suppressed?.payload as { reason?: string; reasonType?: string } | undefined)?.reason).toContain('disabled by settings');
    expect((suppressed?.payload as { reasonType?: string } | undefined)?.reasonType).toBe('companionship_promise_followup');
  });

  it.skip('does not treat suppressed private thread diagnostics as schedule cooldown', async () => {
    const chat = buildChat({
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-suppressed-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: Date.now() - 10 * 60_000,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '角色陪伴私聊已被设置抑制',
        visibility: 'role_private',
        visibleToIds: ['a', 'b'],
        payload: {
          eventType: 'companionship_private_thread_schedule',
          actorId: 'a',
          targetId: 'b',
          participantIds: ['a', 'b'],
          action: 'suppressed',
          reason: 'character companionship AI private threads disabled by settings',
          reasonType: 'companionship_promise_followup',
          dedupeKey: 'companionship-private-thread-chat-1-a-b',
        },
      }],
    });
    const characters = [
      buildCharacter('a', '甲', {
        relationships: [{
          characterId: 'b',
          warmth: 70,
          trust: 68,
          competence: 30,
          threat: 2,
          note: '约定下次争执后先把话说完。',
          updatedAt: Date.now() - 10_000,
        }],
      }),
      buildCharacter('b', '乙'),
    ];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '这件事我先不在这里展开。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    expect(readRuntimeEvents(result).some((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string; reasonType?: string }).eventKind === 'pair_private_thread'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_promise_followup')).toBe(true);
  });

  it.skip('creates character companionship group mediation candidates as public conflict notes', async () => {
    const chat = buildChat({
      memberIds: ['a', 'b', 'c'],
      worldState: {
        ...buildChat().worldState,
        structuredRoomState: {
          heat: 24,
          cohesion: -4,
          topicDrift: 3,
          dominantThread: ['a', 'b'],
          alliances: [],
          conflictPairs: [['a', 'b']],
          pileOnTarget: null,
          silencedActors: [],
        },
      },
    });
    const characters = [
      buildCharacter('a', '甲', {
        relationships: [{
          characterId: 'b',
          warmth: 72,
          trust: 66,
          competence: 20,
          threat: 8,
          note: '约定每次争执后先递台阶；担心乙最近太累。',
          updatedAt: Date.now() - 10_000,
        }],
      }),
      buildCharacter('b', '乙'),
      buildCharacter('c', '丙'),
    ];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '算了，这话在群里越说越重。',
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    const candidate = readRuntimeEvents(result).find((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string; reasonType?: string }).eventKind === 'conflict_expression'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_group_mediation');
    const payload = candidate?.payload as SocialEventCandidatePayload | undefined;
    expect(payload?.participantIds).toEqual(['a', 'b']);
    expect(payload?.visibilityPlan).toBe('public');
    expect(payload?.title).toBe('群聊圆场');
    expect(payload?.openingMessage).toContain('乙');
    expect(payload?.openingMessage).toContain('气氛往回带');

    const artifact = readRuntimeEvents(result).find((event) => event.kind === 'artifact'
      && (event.payload as { artifactType?: string; reasonType?: string }).artifactType === 'conflict_note'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_group_mediation');
    expect((artifact?.payload as { text?: string } | undefined)?.text).toContain('气氛往回带');
    expect((artifact?.payload as { text?: string } | undefined)?.text).not.toContain('摊开');
  });

  it('uses warm room state to admit post moment candidates', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      worldState: { ...buildChat().worldState, structuredRoomState: { heat: 26, cohesion: 14, topicDrift: 4, dominantThread: ['a', 'b'], alliances: [['a', 'b']], conflictPairs: [], pileOnTarget: null, silencedActors: [] } },
    });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '这段我真想发出来纪念一下。',
        interactionHint: null,
        socialEventHints: [{
          eventKind: 'post_moment',
          confidence: 0.88,
          urgency: 'soon',
          seedIntent: '想发动态。',
          visibilityPlan: 'public',
          expectedArtifacts: ['moment_text'],
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    expect((readRuntimeEvents(result)).some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment')).toBe(true);
  });

  it('uses relationship and room state to admit outing candidates', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      relationshipLedger: [{
        pairKey: 'a->b',
        actorId: 'a',
        targetId: 'b',
        current: { warmth: 8, competence: 5, trust: 4, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 1,
      }],
      worldState: { ...buildChat().worldState, structuredRoomState: { heat: 14, cohesion: 8, topicDrift: 3, dominantThread: ['a', 'b'], alliances: [['a', 'b']], conflictPairs: [], pileOnTarget: null, silencedActors: [] } },
    });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '那今晚一起去吃火锅吧。',
        interactionHint: {
          kind: 'support',
          actorId: 'a',
          targetId: 'b',
          intensity: 3,
          tone: 'warm',
          evidenceText: '那今晚一起去吃火锅吧。',
          confidence: 0.92,
        },
        socialEventHints: [{
          eventKind: 'social_outing',
          participantIds: ['a', 'b'],
          confidence: 0.88,
          urgency: 'soon',
          seedIntent: '线下活动。',
          visibilityPlan: 'public',
          expectedArtifacts: ['outing_summary'],
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    expect((readRuntimeEvents(result)).some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing')).toBe(true);
  });

  it('merges semantically similar outing candidates across nearby messages', async () => {
    const baseChat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-existing-outing',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 1,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 提议触发线下活动',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          initiatorId: 'a',
          participantIds: ['a', 'b'],
          targetIds: ['b'],
          reasonType: 'celebration',
          confidence: 0.82,
          urgency: 'soon',
          seedIntent: '先约一波火锅。',
          visibilityPlan: 'public',
          expectedArtifacts: ['outing_summary'],
          title: '线下活动',
          activityType: '吃火锅',
          timeHint: '今晚',
          locationHint: null,
          dedupeKey: null,
        },
      }],
    });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: baseChat,
      characters,
      message: {
        type: 'ai',
        senderId: 'b',
        content: '行，那今晚就一起去吃火锅吧。',
        interactionHint: {
          kind: 'support',
          actorId: 'b',
          targetId: 'a',
          intensity: 4,
          tone: 'warm',
          evidenceText: '行，那今晚就一起去吃火锅吧。',
          confidence: 0.92,
        },
        socialEventHints: [{
          eventKind: 'social_outing',
          participantIds: ['a', 'b'],
          targetIds: ['a'],
          reasonType: 'celebration',
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '今晚去吃火锅。',
          visibilityPlan: 'public',
          expectedArtifacts: ['outing_summary', 'group_photo'],
          title: '线下活动',
          activityType: '吃火锅',
          timeHint: '今晚',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    const events = readAppliedRuntimeEvents(baseChat, result);
    const outingCandidates = events.filter((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing');
    expect(outingCandidates).toHaveLength(1);
    const latest = outingCandidates.at(-1);
    expect(latest?.id).toBe('evt-existing-outing');
    expect((latest?.payload as { participantIds?: string[] }).participantIds).toEqual(['a', 'b']);
    expect((latest?.payload as { expectedArtifacts?: string[] }).expectedArtifacts).toContain('group_photo');
    expect((latest?.payload as { targetIds?: string[] }).targetIds).toContain('a');
    expect((latest?.payload as { targetIds?: string[] }).targetIds).toContain('b');
  });

  it('merges semantically similar post moment candidates by initiator and topic', async () => {
    const baseChat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-existing-moment',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 1,
        actorIds: ['a'],
        summary: 'a 提议发布一条 post_moment 动态',
        visibility: 'derived_public',
        payload: {
          eventKind: 'post_moment',
          initiatorId: 'a',
          participantIds: ['a'],
          targetIds: ['b'],
          reasonType: 'celebration',
          confidence: 0.84,
          urgency: 'soon',
          seedIntent: '记录火锅局。',
          visibilityPlan: 'public',
          expectedArtifacts: ['moment_text'],
          title: '朋友圈动态',
          activityType: '记录火锅',
          dedupeKey: null,
        },
      }],
    });
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: baseChat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '这波火锅我真得发个动态纪念一下。',
        interactionHint: null,
        socialEventHints: [{
          eventKind: 'post_moment',
          confidence: 0.91,
          urgency: 'soon',
          seedIntent: '发动态记录火锅。',
          visibilityPlan: 'public',
          expectedArtifacts: ['moment_text', 'moment_food_photo'],
          title: '朋友圈动态',
          activityType: '记录火锅',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    const events = readAppliedRuntimeEvents(baseChat, result);
    const moments = events.filter((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment');
    expect(moments).toHaveLength(1);
    const latest = moments.at(-1);
    expect(latest?.id).toBe('evt-existing-moment');
    expect((latest?.payload as { activityType?: string }).activityType).toBe('记录火锅');
    expect((latest?.payload as { seedIntent?: string }).seedIntent).toContain('火锅');
    expect((latest?.payload as { initiatorId?: string }).initiatorId).toBe('a');
    expect((latest?.payload as { title?: string }).title).toBe('朋友圈动态');
    expect((latest?.payload as { visibilityPlan?: string }).visibilityPlan).toBe('public');
  });

  it('adds status update candidate/events for self-update messages', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '最近我在忙新项目，这两天可能回复慢一点。',
        interactionHint: null,
        socialEventHints: [{
          eventKind: 'status_update',
          confidence: 0.88,
          urgency: 'soon',
          seedIntent: '想同步一下最近状态。',
          visibilityPlan: 'public',
          expectedArtifacts: ['status_note'],
          title: '状态更新',
          activityType: '项目近况',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'status_update')).toBe(true);
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'status_note')).toBe(true);
    expect(events.find((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'status_note')?.payload)
      .toMatchObject({ status: 'tentative', seedIntent: '想同步一下最近状态。', sourceText: expect.any(String), candidateId: expect.any(String) });
  });

  it('adds conflict expression candidate/events for confrontational messages', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '你刚才那个说法我真的接受不了。',
        interactionHint: {
          kind: 'challenge',
          actorId: 'a',
          targetId: 'b',
          intensity: 4,
          tone: 'annoyed',
          evidenceText: '你刚才那个说法我真的接受不了。',
          confidence: 0.93,
        },
        socialEventHints: [{
          eventKind: 'conflict_expression',
          targetIds: ['b'],
          participantIds: ['a'],
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '想把刚才的不满直接说开。',
          visibilityPlan: 'public',
          expectedArtifacts: ['conflict_note'],
          title: '冲突表达',
          activityType: '正面摊牌',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'conflict_expression')).toBe(true);
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'conflict_note')).toBe(true);
    expect(events.find((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'conflict_note')?.payload)
      .toMatchObject({ status: 'tentative', seedIntent: '想把刚才的不满直接说开。', sourceText: expect.any(String), candidateId: expect.any(String) });
  });

  it('adds gift exchange candidate/events for caring gift messages', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '我给你带了杯咖啡，别太辛苦。',
        interactionHint: {
          kind: 'support',
          actorId: 'a',
          targetId: 'b',
          intensity: 3,
          tone: 'warm',
          evidenceText: '我给你带了杯咖啡，别太辛苦。',
          confidence: 0.92,
        },
        socialEventHints: [{
          eventKind: 'gift_exchange',
          targetIds: ['b'],
          participantIds: ['a'],
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '想送个小礼物表达心意。',
          visibilityPlan: 'public',
          expectedArtifacts: ['gift_note'],
          title: '礼物互动',
          activityType: '送咖啡',
        }],
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    const events = readRuntimeEvents(result);
    expect(events.some((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'gift_exchange')).toBe(true);
    expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'gift_note')).toBe(true);
    expect(events.find((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'gift_note')?.payload)
      .toMatchObject({ status: 'tentative', seedIntent: '想送个小礼物表达心意。', sourceText: expect.any(String), candidateId: expect.any(String) });
  });

  it('adds artifact events for summary-like messages', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '总结一下，今天的方案就是先拆模块再合并。',
        interactionHint: null,
      },
      previousAiMessage: null,
      recentMessages: [],
    });

    expect((readRuntimeEvents(result)).some((event) => event.kind === 'artifact')).toBe(true);
  });

  it('emits world influence rule evaluation event with matched and unmet rules', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '你先别急，明天上午十点我们再确认时间。',
        metadata: {
          runtimeDecision: {
            worldInfluence: {
              attentionScore: 0.76,
              attentionRestraint: 0.41,
              activeRuleIds: ['comfort_first', 'urgent_calendar_first', 'low_pressure_restraint'],
              activeRuleTexts: [],
            },
          },
        },
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    const events = readRuntimeEvents(result);
    const ruleEval = events.find((event) => (
      event.kind === 'action_resolution'
      && (event.payload as { eventType?: string }).eventType === 'world_influence_rule_evaluated'
    ));
    expect(ruleEval).toBeTruthy();
    expect(ruleEval?.summary).toBe('世界影响规则词面诊断：命中 3/3');
    expect((ruleEval?.payload as { matchedRuleIds?: string[] }).matchedRuleIds).toEqual([
      'comfort_first',
      'urgent_calendar_first',
      'low_pressure_restraint',
    ]);
    expect((ruleEval?.payload as { unmetRuleIds?: string[] }).unmetRuleIds || []).toHaveLength(0);
  });

  it('marks unmet world influence rules when response style violates restraint cues', async () => {
    const chat = buildChat();
    const characters = [buildCharacter('a', '甲'), buildCharacter('b', '乙')];
    const result = await openChatEngine.onMessageCommitted({
      conversation: chat,
      characters,
      message: {
        type: 'ai',
        senderId: 'a',
        content: '你必须马上处理，别拖了。',
        metadata: {
          runtimeDecision: {
            worldInfluence: {
              attentionScore: 0.68,
              attentionRestraint: 0.9,
              activeRuleIds: ['low_pressure_restraint'],
              activeRuleTexts: [],
            },
          },
        },
      } as Parameters<typeof openChatEngine.onMessageCommitted>[0]['message'],
      previousAiMessage: null,
      recentMessages: [],
    });
    const events = readRuntimeEvents(result);
    const ruleEval = events.find((event) => (
      event.kind === 'action_resolution'
      && (event.payload as { eventType?: string }).eventType === 'world_influence_rule_evaluated'
    ));
    expect(ruleEval).toBeTruthy();
    expect((ruleEval?.payload as { matchedRuleIds?: string[] }).matchedRuleIds || []).toHaveLength(0);
    expect((ruleEval?.payload as { unmetRuleIds?: string[] }).unmetRuleIds).toEqual(['low_pressure_restraint']);
  });
});
