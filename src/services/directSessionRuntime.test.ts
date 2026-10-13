import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConversation, type GroupChat } from '../types/chat';
import { buildPrivateThreadOpenedEvent, buildStartPrivateThreadExecutionResult, createAiPrivateThread, passesWorldAttentionRestraintPolicy, pickAutoPairPrivateThreadCandidate, runSocialEventAutoFlow as executeSocialEventAutoFlow, type SocialEventRuntimeOps } from './directSessionRuntime';
import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';
import type { RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';
import { setAIGenerationRuntimeConfig } from './aiGenerationRuntimeConfig';
import { DEFAULT_COMPANIONSHIP_SETTINGS } from '../types/settings';
import { setCompanionshipRuntimeConfig } from './companionshipRuntimeConfig';
import * as aiClient from './aiClient';

// Existing effect assertions capture patches; store regressions cover atomic commits.
function runSocialEventAutoFlow(chat: GroupChat, ops: Omit<SocialEventRuntimeOps, 'applyChatRuntimePatch'> & {
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<unknown>;
}) {
  return executeSocialEventAutoFlow(chat, {
    ...ops,
    applyChatRuntimePatch: async (id, buildPatch) => {
      const patch = buildPatch(chat);
      if (!patch) return false;
      await ops.updateChat(id, patch);
      return true;
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
  setAIGenerationRuntimeConfig({ enableMoments: true, enableDiaries: true });
  setCompanionshipRuntimeConfig(DEFAULT_COMPANIONSHIP_SETTINGS);
});

afterEach(() => {
  vi.useRealTimers();
});

function buildCandidatePayload(overrides: Partial<SocialEventCandidatePayload> = {}): SocialEventCandidatePayload {
  return {
    eventKind: 'pair_private_thread',
    initiatorId: 'a',
    participantIds: ['a', 'b'],
    targetIds: ['b'],
    reasonType: 'unresolved_question',
    confidence: 0.82,
    urgency: 'immediate',
    seedIntent: '继续私下聊',
    visibilityPlan: 'conversation_private',
    expectedArtifacts: ['private_thread_summary'],
    ...overrides,
  };
}

function buildCharacter(id: string, name: string): AICharacter {
  return { id, name } as AICharacter;
}

type TestRuntimeMessageInput = {
  chatId: string;
  type: 'ai' | 'system';
  senderId: string;
  senderName: string;
  content: string;
  emotion: number;
};

type TestAppendEventPayload = {
  eventType: string;
  title: string;
  summary: string;
  pair?: [string, string];
  metrics?: unknown;
  visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';
  visibleToIds?: string[];
  visibleToRoles?: string[];
};

function buildAddMessageMock() {
  return vi.fn(async (message: TestRuntimeMessageInput) => {
    void message;
    return {};
  });
}

function buildAppendEventMessageMock() {
  return vi.fn(async (chatId: string, payload: TestAppendEventPayload) => {
    void chatId;
    void payload;
    return undefined;
  });
}

function buildCandidateEvent(payload: SocialEventCandidatePayload, createdAt = 1) {
  return {
    id: `evt-candidate-${createdAt}`,
    conversationId: 'chat-1',
    kind: 'event_candidate' as const,
    createdAt,
    actorIds: ['a'],
    targetIds: ['b'],
    summary: 'a 提议与 b 发起双人私聊候选',
    visibility: 'derived_public' as const,
    payload,
  };
}

function buildOpenedEvent(createdAt = 2) {
  return {
    id: `evt-opened-${createdAt}`,
    conversationId: 'chat-1',
    kind: 'artifact' as const,
    createdAt,
    actorIds: ['a'],
    targetIds: ['a', 'b'],
    summary: 'a 与 b 的双人私聊已自动派生',
    visibility: 'derived_public' as const,
    payload: {
      artifactType: 'private_thread_opened',
      eventKind: 'pair_private_thread',
      participantIds: ['a', 'b'],
    },
  };
}

function buildChatWithEvents(events: RuntimeEventV2[]) {
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
    runtimeEventsV2: events,
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

function buildBaseChat() {
  return buildChatWithEvents([]);
}

function buildDirectChatWithEvents(events: RuntimeEventV2[]) {
  return normalizeConversation({
    ...buildBaseChat(),
    type: 'direct',
    memberIds: ['a'],
    runtimeEventsV2: events,
  });
}

function buildUserMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-user-1',
    chatId: 'chat-1',
    type: 'user',
    senderId: 'user',
    senderName: '用户',
    content: '今天先到这里，回头再聊。',
    timestamp: Date.now() - 30 * 60 * 60_000,
    emotion: 0,
    isDeleted: false,
    ...overrides,
  };
}

function buildOpenedBaseChat() {
  return buildBaseChat();
}

function buildOpenedCandidate() {
  return buildCandidateEvent(buildCandidatePayload());
}

function buildOpenedEventChat() {
  return buildOpenedBaseChat();
}

function buildOpenedEventCandidate() {
  return buildOpenedCandidate();
}

function buildOpenedEventPairThreadChat() {
  return buildOpenedEventChat();
}

function buildOpenedEventPairThreadCandidate() {
  return buildOpenedEventCandidate();
}

function buildOpenedEventLowConfidencePayload() {
  return buildCandidatePayload({ confidence: 0.65 });
}

function buildOpenedEventCooldownPayload() {
  return buildCandidatePayload();
}

function buildOpenedEventStandardPayload() {
  return buildCandidatePayload();
}

function buildOpenedEventWithPayload(payload: SocialEventCandidatePayload, createdAt = 1) {
  return buildCandidateEvent(payload, createdAt);
}

function buildOpenedEventWithOpened(createdAtCandidate: number, createdAtOpened: number) {
  return buildChatWithEvents([buildCandidateEvent(buildOpenedEventCooldownPayload(), createdAtCandidate), buildOpenedEvent(createdAtOpened)]);
}

function buildOpenedEventStandardChat() {
  return buildChatWithEvents([buildOpenedEventWithPayload(buildOpenedEventStandardPayload())]);
}

function buildOpenedEventLowChat() {
  return buildChatWithEvents([buildOpenedEventWithPayload(buildOpenedEventLowConfidencePayload())]);
}

function buildOpenedEventCooldownWindowChat() {
  return buildOpenedEventWithOpened(1000, 1005);
}

function buildOpenedEventLowExpectedNull() {
  return null;
}

function buildOpenedEventCooldownExpectedNull() {
  return null;
}

function buildOpenedEventStandardExpectedId() {
  return 'evt-candidate-1';
}

describe('directSessionRuntime pair-thread adjudication helpers', () => {
  it('builds shared private-thread execution result', () => {
    const result = buildStartPrivateThreadExecutionResult(buildBaseChat(), 'a', 'b', '继续聊刚才的话题', [
      buildCharacter('a', '喜羊羊'),
      buildCharacter('b', '灰太狼'),
    ]);
    expect(result.runtimeEvents?.[0]?.eventType).toBe('start_private_thread');
    expect(result.runtimeEvents?.[0]?.summary).toContain('喜羊羊');
    expect(result.runtimeEvents?.[0]?.summary).toContain('灰太狼');
    expect(result.runtimeEvents?.[0]?.summary).not.toContain('a → b');
  });

  it('refuses to create AI private thread when starter/target are not in source chat members', async () => {
    const sourceChat = buildBaseChat();
    const addChat = vi.fn(async () => buildBaseChat());
    const privateChat = await createAiPrivateThread({
      sourceChat,
      chats: [sourceChat],
      characters: [buildCharacter('a', '喜羊羊'), buildCharacter('b', '灰太狼'), buildCharacter('outsider', '沸羊羊')],
      starterId: 'a',
      targetId: 'outsider',
      addChat,
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(privateChat).toBeNull();
    expect(addChat).not.toHaveBeenCalled();
  });

  it('seeds AI private thread with source-aware opening message', async () => {
    const sourceChat = buildBaseChat();
    const addMessage = buildAddMessageMock();
    const privateChat = await createAiPrivateThread({
      sourceChat,
      chats: [sourceChat],
      characters: [buildCharacter('a', '喜羊羊'), buildCharacter('b', '灰太狼')],
      starterId: 'a',
      targetId: 'b',
      triggerReason: '灰太狼刚才回避了群里的关键问题，喜羊羊想私下追问。',
      openingMessage: '灰太狼，刚才那个问题你在群里没有接。我想单独问一句，你到底在担心什么？',
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage,
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(privateChat).not.toBeNull();
    expect(addMessage).toHaveBeenCalledTimes(2);
    expect(addMessage.mock.calls[1]?.[0]).toMatchObject({
      chatId: privateChat?.id,
      type: 'ai',
      senderId: 'a',
      senderName: '喜羊羊',
      content: '灰太狼，刚才那个问题你在群里没有接。我想单独问一句，你到底在担心什么？',
    });
  });

  it('passes candidate opening message into auto-opened AI private thread', async () => {
    const chat = buildChatWithEvents([buildCandidateEvent(buildCandidatePayload({
      triggerReason: '甲在群里追问乙的关键回避，适合转入私聊。',
      openingMessage: '乙，刚才你避开的那句话我没放下。你可以只跟我说真实原因。',
    }))]);
    const addMessage = buildAddMessageMock();
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      updateChat: vi.fn(async () => undefined),
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage,
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.privateChatId).toBe('chat-1');
    expect(addMessage.mock.calls[1]?.[0]).toMatchObject({
      type: 'ai',
      senderId: 'a',
      content: '乙，刚才你避开的那句话我没放下。你可以只跟我说真实原因。',
    });
  });

  it('auto-opens companionship private thread candidates with their relationship-aware first message', async () => {
    const chat = buildChatWithEvents([buildCandidateEvent(buildCandidatePayload({
      reasonType: 'companionship_care_followup',
      confidence: 0.9,
      seedIntent: '甲对乙的陪伴关系有未尽余波：担心乙最近太累。',
      triggerReason: '角色-角色陪伴关系触发：担心乙最近太累。',
      openingMessage: '乙，刚才在群里我没接着问，是不想让你难堪。但这件事我还是有点放心不下，想单独确认一下。',
      dedupeKey: 'companionship-private-thread-chat-1-a-b',
    }))]);
    const addMessage = buildAddMessageMock();
    const appendEventMessage = buildAppendEventMessageMock();
    const updateChat = vi.fn(async (_chatId: string, _patch: Partial<ReturnType<typeof normalizeConversation>>) => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage,
      appendEventMessage,
    });
    expect(result.privateChatId).toBe('chat-1');
    expect(addMessage.mock.calls[1]?.[0]).toMatchObject({
      type: 'ai',
      senderId: 'a',
      senderName: '甲',
      content: '乙，刚才在群里我没接着问，是不想让你难堪。但这件事我还是有点放心不下，想单独确认一下。',
    });
    expect(appendEventMessage.mock.calls[0]?.[1]).toMatchObject({
      eventType: 'private_chat_started',
      summary: '角色-角色陪伴关系触发：担心乙最近太累。',
    });
    const updatedPatch = updateChat.mock.calls[0]?.[1] as { runtimeEventsV2?: RuntimeEventV2[] } | undefined;
    const updatedEvents = updatedPatch?.runtimeEventsV2 || [];
    const schedule = updatedEvents.find((event) => (event.payload as { eventType?: string }).eventType === 'companionship_private_thread_schedule');
    expect(schedule).toMatchObject({
      kind: 'artifact',
      visibility: 'role_private',
      visibleToIds: ['a', 'b'],
      payload: expect.objectContaining({
        action: 'opened',
        actorId: 'a',
        targetId: 'b',
        candidateId: 'evt-candidate-1',
        privateChatId: 'chat-1',
        dedupeKey: 'companionship-private-thread-chat-1-a-b',
      }),
    });
  });

  it('runs unified auto social flow for post moment candidates', async () => {
    const chat = buildChatWithEvents([buildCandidateEvent(buildCandidatePayload({ eventKind: 'post_moment', participantIds: ['a'], confidence: 0.9, reasonType: 'celebration', visibilityPlan: 'public', dedupeKey: 'moment-1' }))]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBe('evt-candidate-1');
    expect(updateChat).toHaveBeenCalledTimes(1);
    const patch = updateChat.mock.calls[0]?.[1] as { runtimeEventsV2?: RuntimeEventV2[] } | undefined;
    const moment = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text');
    expect(moment?.createdAt).toBe(3);
  });

  it('suppresses existing post moment candidates when moments generation is disabled', async () => {
    const chat = buildChatWithEvents([buildCandidateEvent(buildCandidatePayload({ eventKind: 'post_moment', participantIds: ['a'], confidence: 0.9, reasonType: 'celebration', visibilityPlan: 'public', dedupeKey: 'moment-disabled-existing' }))]);
    const updateChat = vi.fn(async () => undefined);
    setAIGenerationRuntimeConfig({ enableMoments: false, enableDiaries: true });
    try {
      const result = await runSocialEventAutoFlow(chat, {
        chats: [chat],
        characters: [buildCharacter('a', '甲')],
        updateChat,
        addChat: vi.fn(async () => buildBaseChat()),
        addMessage: vi.fn(async () => ({})),
        appendEventMessage: vi.fn(async () => undefined),
      });
      expect(result.handledEventId).toBe('evt-candidate-1');
      const patch = updateChat.mock.calls[0]?.[1] as { runtimeEventsV2?: RuntimeEventV2[] } | undefined;
      const events = patch?.runtimeEventsV2 || [];
      expect(events.some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text')).toBe(false);
      expect(events.some((event) => event.kind === 'artifact'
        && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
        && (event.payload as { reasonType?: string }).reasonType === 'world_attention_moment_disabled')).toBe(true);
    } finally {
      setAIGenerationRuntimeConfig({ enableMoments: true, enableDiaries: true });
    }
  });

  it('suppresses post moment publish during quiet hours for non-night-owl persona', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T23:40:00+08:00'));
    try {
      const chat = buildChatWithEvents([buildCandidateEvent(buildCandidatePayload({
        eventKind: 'post_moment',
        participantIds: ['a'],
        confidence: 0.9,
        reasonType: 'celebration',
        visibilityPlan: 'public',
        dedupeKey: 'moment-quiet-1',
      }))]);
      const updateChat = vi.fn(async () => undefined);
      await runSocialEventAutoFlow(chat, {
        chats: [chat],
        characters: [buildCharacter('a', '甲')],
        updateChat,
        addChat: vi.fn(async () => buildBaseChat()),
        addMessage: vi.fn(async () => ({})),
        appendEventMessage: vi.fn(async () => undefined),
      });
      const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
      const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed');
      const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { eventType?: string; decisionType?: string; reasonType?: string }).eventType === 'world_decision_v2');
      expect((suppression?.payload as { reasonType?: string }).reasonType).toBe('world_attention_moment_quiet_hours');
      expect((decision?.payload as { decisionType?: string; reasonType?: string }).decisionType).toBe('suppressed');
      expect((decision?.payload as { reasonType?: string }).reasonType).toBe('world_attention_moment_quiet_hours');
      expect((decision?.payload as { nextSuggestedAt?: number }).nextSuggestedAt).toBe((suppression?.payload as { nextSuggestedAt?: number }).nextSuggestedAt);
      expect((patch?.runtimeEventsV2 || []).some((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses post moment publish inside anti-spam window', async () => {
    const now = Date.now();
    const chat = buildChatWithEvents([
      buildCandidateEvent(buildCandidatePayload({
        eventKind: 'post_moment',
        participantIds: ['a'],
        confidence: 0.9,
        reasonType: 'celebration',
        visibilityPlan: 'public',
        dedupeKey: 'moment-spam-1',
      }), now),
      {
        id: 'artifact-post-recent',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 20 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '甲刚发过一条动态',
        visibility: 'derived_public',
        payload: { artifactType: 'moment_text', eventKind: 'post_moment', text: '甲刚发过一条动态' },
      } as RuntimeEventV2,
    ]);
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed');
    const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { eventType?: string; decisionType?: string; reasonType?: string }).eventType === 'world_decision_v2');
    expect((suppression?.payload as { reasonType?: string }).reasonType).toBe('world_attention_moment_spam_window');
    expect((decision?.payload as { decisionType?: string; reasonType?: string }).decisionType).toBe('suppressed');
    expect((decision?.payload as { reasonType?: string }).reasonType).toBe('world_attention_moment_spam_window');
    expect((decision?.payload as { nextSuggestedAt?: number }).nextSuggestedAt).toBe((suppression?.payload as { nextSuggestedAt?: number }).nextSuggestedAt);
  });

  it('runs unified auto social flow for outing candidates', async () => {
    const chat = buildChatWithEvents([buildCandidateEvent(buildCandidatePayload({ eventKind: 'social_outing', participantIds: ['a', 'b'], confidence: 0.9, reasonType: 'celebration', visibilityPlan: 'public', dedupeKey: 'outing-1' }))]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [],
      allowWorldFallback: false,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBe('evt-candidate-1');
    expect(updateChat).toHaveBeenCalledTimes(1);
    const patch = (updateChat.mock.calls[0] as [string, Partial<typeof chat>] | undefined)?.[1];
    const events = patch?.runtimeEventsV2 || [];
    expect(events.some((event) => ['relationship_delta', 'memory_candidate', 'room_shift'].includes(event.kind))).toBe(false);
    expect(events.find((event) => (event.payload as { artifactType?: string }).artifactType === 'outing_summary')?.payload)
      .toMatchObject({ status: 'tentative' });
    expect(events.some((event) => event.summary === 'handled_social_event:evt-candidate-1')).toBe(true);
  });

  it.each([
    ['post_moment', 'moment_text', 'public'],
    ['status_update', 'status_note', 'public'],
    ['check_in', 'check_in_note', 'user_private'],
    ['react_to_moment', 'moment_reaction_note', 'user_private'],
    ['social_outing', 'outing_summary', 'public'],
    ['gift_exchange', 'gift_note', 'public'],
    ['conflict_expression', 'conflict_note', 'public'],
  ] as const)('consumes pending %s after a newer candidate was handled', async (eventKind, artifactType, visibilityPlan) => {
    const payload = buildCandidatePayload({
      eventKind,
      visibilityPlan,
      participantIds: ['a', 'b'],
      targetIds: visibilityPlan === 'user_private' || eventKind === 'status_update' ? ['user'] : ['b'],
      confidence: 0.9,
      reasonType: 'celebration',
      dedupeKey: 'pending-older',
    });
    let chat = buildChatWithEvents([
      buildCandidateEvent(payload, 1),
      buildCandidateEvent({ ...payload, dedupeKey: 'handled-newer' }, 2),
      {
        ...buildOpenedEvent(3),
        actorIds: ['a'],
        payload: { artifactType, eventKind, dedupeKey: 'handled-newer' },
      },
      {
        ...buildOpenedEvent(4),
        summary: 'handled_social_event:evt-candidate-2',
        payload: { artifactType: 'handled_social_event', eventId: 'evt-candidate-2' },
      },
    ]);
    const updateChat = vi.fn(async (_id: string, patch: Partial<typeof chat>) => {
      chat = normalizeConversation({ ...chat, ...patch });
    });
    const ops = {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      allowWorldFallback: false,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: buildAddMessageMock(),
      appendEventMessage: buildAppendEventMessageMock(),
    };

    const result = await runSocialEventAutoFlow(chat, ops);
    expect(result.handledEventId).toBe('evt-candidate-1');
    expect(chat.runtimeEventsV2?.filter((event) => event.summary === 'handled_social_event:evt-candidate-1')).toHaveLength(1);
    expect(chat.runtimeEventsV2?.some((event) => event.kind === 'artifact'
      && (event.payload as { dedupeKey?: string }).dedupeKey === 'pending-older')).toBe(true);

    if (eventKind !== 'post_moment' && eventKind !== 'social_outing') {
      const added = chat.runtimeEventsV2?.filter((event) => event.createdAt > 4) || [];
      expect(added.some((event) => ['relationship_delta', 'memory_candidate', 'room_shift'].includes(event.kind))).toBe(false);
      expect(added.find((event) => (event.payload as { artifactType?: string }).artifactType === artifactType))
        .toMatchObject({
          visibility: visibilityPlan === 'public' ? 'derived_public' : 'pair_private',
          payload: { status: 'tentative', seedIntent: payload.seedIntent },
        });
      expect(ops.addMessage).not.toHaveBeenCalled();
    }

    expect(await runSocialEventAutoFlow(chat, ops)).toEqual({ handledEventId: null });
    expect(updateChat).toHaveBeenCalledTimes(1);
  });

  it('does not let an already handled private-thread candidate block another kind', async () => {
    const chat = buildChatWithEvents([
      buildCandidateEvent(buildCandidatePayload({ eventKind: 'gift_exchange', visibilityPlan: 'public' }), 1),
      buildCandidateEvent(buildCandidatePayload(), 2),
      {
        ...buildOpenedEvent(3),
        summary: 'handled_social_event:evt-candidate-2',
        payload: { artifactType: 'handled_social_event', eventId: 'evt-candidate-2' },
      },
    ]);
    const addChat = vi.fn(async () => buildBaseChat());
    const updateChat = vi.fn(async (id: string, patch: Partial<typeof chat>) => {
      void id;
      void patch;
    });
    expect(pickAutoPairPrivateThreadCandidate(chat)).toBeNull();
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      allowWorldFallback: false,
      updateChat,
      addChat,
      addMessage: buildAddMessageMock(),
      appendEventMessage: buildAppendEventMessageMock(),
    });
    expect(result.handledEventId).toBe('evt-candidate-1');
    expect(addChat).not.toHaveBeenCalled();
    expect(updateChat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['gift_exchange', 'gift_note'],
    ['conflict_expression', 'conflict_note'],
  ] as const)('skips duplicate %s content while consuming a distinct pending candidate', async (eventKind, artifactType) => {
    const payload = buildCandidatePayload({ eventKind, visibilityPlan: 'public', confidence: 0.9 });
    const chat = buildChatWithEvents([
      buildCandidateEvent({ ...payload, dedupeKey: 'distinct-event' }, 1),
      buildCandidateEvent({ ...payload, dedupeKey: 'same-event' }, 2),
      { ...buildOpenedEvent(3), payload: { artifactType, eventKind, dedupeKey: 'same-event' } },
    ]);
    const updateChat = vi.fn(async (id: string, patch: Partial<typeof chat>) => {
      void id;
      void patch;
    });
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      allowWorldFallback: false,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: buildAddMessageMock(),
      appendEventMessage: buildAppendEventMessageMock(),
    });
    expect(result.handledEventId).toBe('evt-candidate-1');
    const patch = updateChat.mock.calls[0]?.[1];
    const artifacts = patch?.runtimeEventsV2?.filter((event) => event.kind === 'artifact'
      && (event.payload as { artifactType?: string }).artifactType === artifactType);
    expect(artifacts?.filter((event) => (event.payload as { dedupeKey?: string }).dedupeKey === 'same-event')).toHaveLength(1);
    expect(artifacts?.filter((event) => (event.payload as { dedupeKey?: string }).dedupeKey === 'distinct-event')).toHaveLength(1);
  });

  it('consumes two distinct outing candidates and retains both arrangements without replaying either', async () => {
    const payload = buildCandidatePayload({
      eventKind: 'social_outing',
      visibilityPlan: 'public',
      confidence: 0.9,
      reasonType: 'celebration',
    });
    let chat = buildChatWithEvents([
      buildCandidateEvent({ ...payload, title: '湖边散步', dedupeKey: 'lake-walk' }, 1),
      buildCandidateEvent({ ...payload, title: '院中下棋', dedupeKey: 'courtyard-chess' }, 2),
    ]);
    const updateChat = vi.fn(async (_id: string, patch: Partial<typeof chat>) => {
      chat = normalizeConversation({ ...chat, ...patch });
    });
    const ops = {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      allowWorldFallback: false,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: buildAddMessageMock(),
      appendEventMessage: buildAppendEventMessageMock(),
    };
    expect((await runSocialEventAutoFlow(chat, ops)).handledEventId).toBe('evt-candidate-2');
    vi.advanceTimersByTime(8_000);
    expect((await runSocialEventAutoFlow(chat, ops)).handledEventId).toBe('evt-candidate-1');
    const arrangements = chat.runtimeEventsV2?.filter((event) => event.kind === 'artifact'
      && (event.payload as { artifactType?: string }).artifactType === 'outing_summary');
    expect(arrangements?.map((event) => (event.payload as { dedupeKey?: string }).dedupeKey).sort())
      .toEqual(['courtyard-chess', 'lake-walk']);
    expect(arrangements?.every((event) => (event.payload as { status?: string }).status === 'tentative')).toBe(true);
    expect(await runSocialEventAutoFlow(chat, ops)).toEqual({ handledEventId: null });
    expect(updateChat).toHaveBeenCalledTimes(2);
  });

  it('does not generate a world-driven fallback when only committed candidates may be consumed', async () => {
    const chat = buildChatWithEvents([{
      id: 'att-paused',
      conversationId: 'chat-1',
      kind: 'attention_candidate',
      createdAt: Date.now() - 2_000,
      actorIds: ['user'],
      targetIds: ['a'],
      summary: '用户点名甲，等待回应',
      visibility: 'derived_public',
      payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚点名了甲' },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      allowWorldFallback: false,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result).toEqual({ handledEventId: null });
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('runs unified auto social flow for check_in candidates', async () => {
    const chat = buildChatWithEvents([buildCandidateEvent(buildCandidatePayload({
      eventKind: 'check_in',
      participantIds: ['a'],
      targetIds: ['user'],
      confidence: 0.85,
      reasonType: 'attention_check_in',
      visibilityPlan: 'user_private',
      dedupeKey: 'checkin-1',
    }))]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBe('evt-candidate-1');
    expect(updateChat).toHaveBeenCalledTimes(1);
  });

  it('runs unified auto social flow for react_to_moment candidates', async () => {
    const chat = buildChatWithEvents([buildCandidateEvent(buildCandidatePayload({
      eventKind: 'react_to_moment',
      participantIds: ['a'],
      targetIds: ['user'],
      confidence: 0.86,
      reasonType: 'attention_react_moment',
      visibilityPlan: 'user_private',
      dedupeKey: 'react-moment-1',
    }))]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBe('evt-candidate-1');
    expect(updateChat).toHaveBeenCalledTimes(1);
  });

  it('falls back to world-driven attention candidate when no explicit social candidate exists', async () => {
    const chat = buildChatWithEvents([{
      id: 'att-1',
      conversationId: 'chat-1',
      kind: 'attention_candidate',
      createdAt: Date.now() - 2_000,
      actorIds: ['user'],
      targetIds: ['a'],
      summary: '用户点名 a，等待回应',
      visibility: 'derived_public',
      payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚点名了甲' },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeTruthy();
    expect(updateChat).toHaveBeenCalledTimes(1);
  });

  it('does not commit a world candidate after the running chat pauses during evaluation', async () => {
    const chat = { ...buildChatWithEvents([{
      id: 'attention-before-pause', conversationId: 'chat-1', kind: 'attention_candidate',
      createdAt: Date.now() - 2_000, actorIds: ['user'], targetIds: ['a'], summary: '用户等待回应',
      visibility: 'derived_public', payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9 },
    }]), isActive: true };
    const commit = vi.fn(async (_id: string, buildPatch: (current: GroupChat) => Partial<GroupChat> | null) => {
      void _id;
      expect(buildPatch({ ...chat, isActive: false })).toBeNull();
      return false;
    });
    const result = await executeSocialEventAutoFlow(chat, {
      chats: [chat], characters: [buildCharacter('a', '甲')], allowWorldFallback: true,
      applyChatRuntimePatch: commit, addChat: vi.fn(async () => buildBaseChat()),
      addMessage: buildAddMessageMock(), appendEventMessage: buildAppendEventMessageMock(),
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.handledEventId).toBeNull();
  });

  it('world-driven fallback does not turn user follow-up attention into local outing artifacts', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名 a，等待回应',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.92, reason: '用户刚点名了甲' },
      } as RuntimeEventV2]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 10, competence: 2, trust: 9, threat: -1 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(updateChat).toHaveBeenCalledTimes(1);
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    expect((patch?.runtimeEventsV2 || []).some((event) => {
      const payload = event.payload as { artifactType?: string; eventKind?: string };
      return event.kind === 'event_candidate' && payload.eventKind === 'social_outing'
        || event.kind === 'artifact' && payload.artifactType === 'outing_summary';
    })).toBe(false);
  });

  it('creates and consumes check_in candidate when a direct pending care topic is due', async () => {
    const now = Date.now();
    const chat = {
      ...buildDirectChatWithEvents([{
      id: 'care-open',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: now - 48 * 60 * 60_000,
      actorIds: ['user'],
      targetIds: ['a'],
      summary: '甲记录了一个需要后续关心的用户事项',
      visibility: 'pair_private',
      payload: {
        eventType: 'companionship_care_topic',
        characterId: 'a',
        userId: 'user',
        topicId: 'care-a-interview-1',
        topicText: '明天面试有点紧张。',
        action: 'opened',
        urgency: 'high',
        evidence: '明天面试有点紧张。',
        dueAt: now - 1_000,
      },
    } as RuntimeEventV2]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, competence: 4, trust: 6, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    expect(updateChat).toHaveBeenCalledTimes(1);
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const candidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_pending_care_due');
    const artifact = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { artifactType?: string; dedupeKey?: string }).artifactType === 'check_in_note'
      && ((event.payload as { dedupeKey?: string }).dedupeKey || '').includes('care-a-interview-1'));
    const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_pending_care_due');
    expect(candidate).toBeTruthy();
    expect(artifact).toBeTruthy();
    expect(decision).toBeTruthy();
  });

  it('does not create pending-care check_in after the topic is closed', async () => {
    const now = Date.now();
    const chat = buildDirectChatWithEvents([
      {
        id: 'care-open',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 48 * 60 * 60_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '甲记录了一个需要后续关心的用户事项',
        visibility: 'pair_private',
        payload: {
          eventType: 'companionship_care_topic',
          characterId: 'a',
          userId: 'user',
          topicId: 'care-a-interview-1',
          topicText: '明天面试有点紧张。',
          action: 'opened',
          urgency: 'high',
          dueAt: now - 1_000,
        },
      } as RuntimeEventV2,
      {
        id: 'care-closed',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 10_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '甲记录用户完成了一个关心事项',
        visibility: 'pair_private',
        payload: {
          eventType: 'companionship_care_topic',
          characterId: 'a',
          userId: 'user',
          topicId: 'care-a-interview-1',
          topicText: '明天面试有点紧张。',
          action: 'closed',
          urgency: 'high',
        },
      } as RuntimeEventV2,
    ]);
    const updateChat = vi.fn(async () => undefined);

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    expect(updateChat).not.toHaveBeenCalled();
  });

  it('marks very overdue pending-care topic as stale instead of creating check_in', async () => {
    const now = Date.now();
    const chat = buildDirectChatWithEvents([{
      id: 'care-open',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: now - 20 * 24 * 60 * 60_000,
      actorIds: ['user'],
      targetIds: ['a'],
      summary: '甲记录了一个需要后续关心的用户事项',
      visibility: 'pair_private',
      payload: {
        eventType: 'companionship_care_topic',
        characterId: 'a',
        userId: 'user',
        topicId: 'care-a-interview-1',
        topicText: '明天面试有点紧张。',
        action: 'opened',
        urgency: 'high',
        evidence: '明天面试有点紧张。',
        dueAt: now - 8 * 24 * 60 * 60_000 - 1_000,
      },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    expect(updateChat).toHaveBeenCalledTimes(1);
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const stale = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; action?: string }).eventType === 'companionship_care_topic'
      && (event.payload as { action?: string }).action === 'stale');
    const checkIn = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_pending_care_due');
    expect(stale).toBeTruthy();
    expect(checkIn).toBeUndefined();
  });

  it('blocks due pending-care check_in when user rejects proactive contact', async () => {
    const now = Date.now();
    const chat = buildDirectChatWithEvents([{
      id: 'care-open',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: now - 48 * 60 * 60_000,
      actorIds: ['user'],
      targetIds: ['a'],
      summary: '甲记录了一个需要后续关心的用户事项',
      visibility: 'pair_private',
      payload: {
        eventType: 'companionship_care_topic',
        characterId: 'a',
        userId: 'user',
        topicId: 'care-a-interview-1',
        topicText: '明天面试有点紧张。',
        action: 'opened',
        urgency: 'high',
        dueAt: now - 1_000,
      },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);
    const actor = {
      ...buildCharacter('a', '甲'),
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说不要主动打扰，也别提醒或私聊。'],
      },
    } as AICharacter;

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [actor],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    expect(updateChat).not.toHaveBeenCalled();
  });

  it('creates and consumes check_in candidate when a direct pending promise is due', async () => {
    const now = Date.now();
    const chat = {
      ...buildDirectChatWithEvents([{
      id: 'promise-open',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: now - 48 * 60 * 60_000,
      actorIds: ['user', 'a'],
      targetIds: ['a', 'user'],
      summary: '甲记录了一个还没完成的约定',
      visibility: 'pair_private',
      payload: {
        eventType: 'companionship_promise',
        characterId: 'a',
        userId: 'user',
        promiseId: 'promise-weekend-movie',
        promiseText: '周末一起看那部电影',
        action: 'opened',
        participantIds: ['a', 'user'],
        evidence: '周末一起看那部电影吧。',
        dueAt: now - 1_000,
        confidence: 0.9,
        decisionSource: 'model',
      },
    } as RuntimeEventV2]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, competence: 4, trust: 6, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    expect(updateChat).toHaveBeenCalledTimes(1);
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const candidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_pending_promise_due');
    const artifact = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { artifactType?: string; dedupeKey?: string }).artifactType === 'check_in_note'
      && ((event.payload as { dedupeKey?: string }).dedupeKey || '').includes('promise-weekend-movie'));
    const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_pending_promise_due');
    expect(candidate).toBeTruthy();
    expect(artifact).toBeTruthy();
    expect(decision).toBeTruthy();
  });

  it('does not create pending-promise check_in for boundary agreements that should not be reminded', async () => {
    const now = Date.now();
    const chat = {
      ...buildDirectChatWithEvents([{
        id: 'promise-boundary',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 48 * 60 * 60_000,
        actorIds: ['user', 'a'],
        targetIds: ['a', 'user'],
        summary: '甲记录了一个关系边界约定',
        visibility: 'pair_private',
        payload: {
          eventType: 'companionship_promise',
          characterId: 'a',
          userId: 'user',
          promiseId: 'promise-do-not-remind',
          promiseText: '说好不要再提醒我这件事',
          action: 'opened',
          participantIds: ['a', 'user'],
          promiseKind: 'boundary_agreement',
          reminderPolicy: { shouldRemind: false, tone: 'none', maxFollowUps: 0, seedIntent: '只作为边界遵守。' },
          evidence: '用户说：不要再提醒我这件事。',
          dueAt: now - 1_000,
          confidence: 0.9,
          decisionSource: 'model',
        },
      } as RuntimeEventV2]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, competence: 4, trust: 6, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    expect(updateChat).not.toHaveBeenCalled();
  });

  it('does not create pending-promise check_in after the promise is revoked', async () => {
    const now = Date.now();
    const chat = buildDirectChatWithEvents([
      {
        id: 'promise-open',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 48 * 60 * 60_000,
        actorIds: ['user', 'a'],
        targetIds: ['a', 'user'],
        summary: '甲记录了一个还没完成的约定',
        visibility: 'pair_private',
        payload: {
          eventType: 'companionship_promise',
          characterId: 'a',
          userId: 'user',
          promiseId: 'promise-weekend-movie',
          promiseText: '周末一起看那部电影',
          action: 'opened',
          participantIds: ['a', 'user'],
          dueAt: now - 1_000,
          confidence: 0.9,
          decisionSource: 'model',
        },
      } as RuntimeEventV2,
      {
        id: 'promise-revoked',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 10_000,
        actorIds: ['user', 'a'],
        targetIds: ['a', 'user'],
        summary: '用户关闭了一个未完成约定',
        visibility: 'pair_private',
        payload: {
          eventType: 'companionship_promise',
          characterId: 'a',
          userId: 'user',
          promiseId: 'promise-weekend-movie',
          promiseText: '周末一起看那部电影',
          action: 'revoked',
          participantIds: ['a', 'user'],
          evidence: '这个不用再问了。',
          confidence: 0.9,
          decisionSource: 'model',
        },
      } as RuntimeEventV2,
    ]);
    const updateChat = vi.fn(async () => undefined);

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    expect(updateChat).not.toHaveBeenCalled();
  });

  it('creates and consumes check_in candidate from online return projection', async () => {
    const now = Date.now();
    const chat = {
      ...buildDirectChatWithEvents([]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 68, competence: 12, trust: 62, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 30 * 60 * 60_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      messages: [buildUserMessage({ timestamp: now - 30 * 60 * 60_000 })],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    expect(updateChat).toHaveBeenCalledTimes(1);
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const candidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_online_return_greeting');
    const artifact = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { artifactType?: string; dedupeKey?: string }).artifactType === 'check_in_note'
      && ((event.payload as { dedupeKey?: string }).dedupeKey || '').includes('companionship-online-return'));
    const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_online_return_greeting');
    expect(candidate).toBeTruthy();
    const candidatePayload = candidate?.payload as { seedIntent?: string; sourceText?: string };
    expect(candidatePayload.seedIntent || '').toContain('低压力');
    expect(candidatePayload.seedIntent || '').toContain('不限制用户若继续提出任务时的回答完整度');
    expect(candidatePayload.seedIntent || '').not.toContain('回来了。');
    expect(candidatePayload.sourceText || '').toContain('回来了。');
    expect(artifact).toBeTruthy();
    expect(decision).toBeTruthy();
  });

  it('blocks online-return check_in when user rejects proactive contact', async () => {
    const now = Date.now();
    const chat = {
      ...buildDirectChatWithEvents([]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 68, competence: 12, trust: 62, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 30 * 60 * 60_000,
      }],
    };
    const actor = {
      ...buildCharacter('a', '甲'),
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说不要主动打扰，也别提醒或私聊。'],
      },
    } as AICharacter;
    const updateChat = vi.fn(async () => undefined);

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [actor],
      messages: [buildUserMessage({ timestamp: now - 30 * 60 * 60_000 })],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const candidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_online_return_greeting');
    expect(candidate).toBeUndefined();
  });

  it('world-driven fallback maps private_message attention into a private check-in intent', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名 a，等待回应',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.95, reason: '用户主动提到了甲，甲想私下确认近况' },
      } as RuntimeEventV2]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 2, competence: 4, trust: 2, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    expect((worldCandidate?.payload as { reasonType?: string }).reasonType).toBe('world_attention_private_message');
    expect((worldCandidate?.payload as { visibilityPlan?: string }).visibilityPlan).toBe('user_private');
    expect((worldCandidate?.payload as { title?: string }).title).toBe('私聊问候');
  });

  it('world-driven fallback maps ask_followup attention into a follow-up check-in intent', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([{
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: now - 2_000,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户刚问了一个未完结话题',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.4, reason: '用户问了后续问题' },
      } as RuntimeEventV2]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 2, competence: 2, trust: 2, threat: 1 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    expect((worldCandidate?.payload as { reasonType?: string }).reasonType).toBe('world_attention_followup_question');
    expect((worldCandidate?.payload as { activityType?: string }).activityType).toBe('追问关心');
  });

  it('world-driven fallback suppresses repeated private check-in within cooldown window', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户点名 a，等待回应',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.95, reason: '用户主动提到了甲，甲想私下确认近况' },
        } as RuntimeEventV2,
        {
          id: 'artifact-check-in-recent',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 30 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '甲刚刚问候了用户',
          visibility: 'derived_public',
          payload: { artifactType: 'check_in_note', eventKind: 'check_in', text: '甲刚刚问候了用户' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 16, competence: 4, trust: 14, threat: -3 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate');
    expect((worldCandidate?.payload as { reasonType?: string }).reasonType).not.toBe('world_attention_private_message');
  });

  it('does not map invite_activity attention into social_outing candidate without model-authored social event hint', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到周末想一起出去',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.95, reason: '用户刚提到周末活动安排' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 16, competence: 4, trust: 14, threat: -3 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'social_outing');
    expect(worldCandidate).toBeUndefined();
    expect((patch?.runtimeEventsV2 || []).some((event) => event.kind === 'artifact' && (event.payload as { eventKind?: string; artifactType?: string }).eventKind === 'social_outing' && (event.payload as { artifactType?: string }).artifactType === 'outing_summary')).toBe(false);
  });

  it('world-driven fallback maps calendar_reminder attention into status_update candidate', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提醒了明天安排',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.88, reason: '用户提到明天的日程安排' },
        } as RuntimeEventV2,
        {
          id: 'artifact-outing-recent',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 30 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '甲刚刚发起过活动邀约',
          visibility: 'derived_public',
          payload: { artifactType: 'outing_summary', eventKind: 'social_outing', text: '甲刚刚发起过活动邀约' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'status_update');
    expect((worldCandidate?.payload as { reasonType?: string }).reasonType).toBe('world_attention_calendar_reminder');
    expect((worldCandidate?.payload as { activityType?: string }).activityType).toBe('日程提醒');
  });

  it('boosts world-driven check_in confidence from comfort_first influence evaluation', async () => {
    const now = Date.now();
    const baseChat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.88, reason: '用户提到最近状态' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, competence: 4, trust: 3, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const influencedChat = {
      ...baseChat,
      runtimeEventsV2: [...(baseChat.runtimeEventsV2 || []), {
        id: 'eval-1',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 1_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '规则评估',
        visibility: 'derived_public',
        payload: {
          eventType: 'world_influence_rule_evaluated',
          matchedRuleIds: ['comfort_first'],
          unmetRuleIds: [],
        },
      } as RuntimeEventV2],
    };
    const updateChatBase = vi.fn(async () => undefined);
    const updateChatInfluenced = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(baseChat, {
      chats: [baseChat],
      characters: [buildCharacter('a', '甲')],
      updateChat: updateChatBase,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    await runSocialEventAutoFlow(influencedChat, {
      chats: [influencedChat],
      characters: [buildCharacter('a', '甲')],
      updateChat: updateChatInfluenced,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const basePatch = (updateChatBase.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const influencedPatch = (updateChatInfluenced.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const baseCandidate = (basePatch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    const influencedCandidate = (influencedPatch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    expect(baseCandidate).toBeTruthy();
    expect(influencedCandidate).toBeTruthy();
    const baseConfidence = (baseCandidate?.payload as { confidence?: number }).confidence || 0;
    const influencedConfidence = (influencedCandidate?.payload as { confidence?: number }).confidence || 0;
    expect(influencedConfidence).toBeGreaterThan(baseConfidence);
  });

  it('boosts world-driven status_update confidence from urgent_calendar_first influence evaluation', async () => {
    const now = Date.now();
    const baseChat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提醒了明天安排',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.88, reason: '用户提到明天的日程安排' },
        } as RuntimeEventV2,
        {
          id: 'artifact-outing-recent',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 30 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '甲刚刚发起过活动邀约',
          visibility: 'derived_public',
          payload: { artifactType: 'outing_summary', eventKind: 'social_outing', text: '甲刚刚发起过活动邀约' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const influencedChat = {
      ...baseChat,
      runtimeEventsV2: [...(baseChat.runtimeEventsV2 || []), {
        id: 'eval-1',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: now - 1_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '规则评估',
        visibility: 'derived_public',
        payload: {
          eventType: 'world_influence_rule_evaluated',
          matchedRuleIds: ['urgent_calendar_first'],
          unmetRuleIds: [],
        },
      } as RuntimeEventV2],
    };
    const updateChatBase = vi.fn(async () => undefined);
    const updateChatInfluenced = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(baseChat, {
      chats: [baseChat],
      characters: [buildCharacter('a', '甲')],
      updateChat: updateChatBase,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    await runSocialEventAutoFlow(influencedChat, {
      chats: [influencedChat],
      characters: [buildCharacter('a', '甲')],
      updateChat: updateChatInfluenced,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const basePatch = (updateChatBase.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const influencedPatch = (updateChatInfluenced.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const baseCandidate = (basePatch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_calendar_reminder');
    const influencedCandidate = (influencedPatch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { reasonType?: string }).reasonType === 'world_attention_calendar_reminder');
    expect(baseCandidate).toBeTruthy();
    expect(influencedCandidate).toBeTruthy();
    const baseConfidence = (baseCandidate?.payload as { confidence?: number }).confidence || 0;
    const influencedConfidence = (influencedCandidate?.payload as { confidence?: number }).confidence || 0;
    expect(influencedConfidence).toBeGreaterThan(baseConfidence);
  });

  it('does not call an extra model arbitration request for proactive-care candidates', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 10, competence: 4, trust: 8, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    const jsonSpy = vi.spyOn(aiClient, 'generateJsonResponse');
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      textApiConfig: { provider: 'openai', baseUrl: '', apiKey: 'k', model: 'gpt-4o-mini' },
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(jsonSpy).not.toHaveBeenCalled();
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate') as RuntimeEventV2 | undefined;
    expect(worldCandidate).toBeTruthy();
    expect(((worldCandidate?.payload as { seedIntent?: string }).seedIntent || '').length).toBeGreaterThan(0);
    const modelArbitrationDecision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_model_arbitration');
    expect(modelArbitrationDecision).toBeFalsy();
    jsonSpy.mockRestore();
  });

  it('prioritizes upcoming shared calendar item as world_calendar_upcoming_reminder', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
        {
          id: 'cal-1',
          conversationId: 'chat-1',
          kind: 'calendar_item_patch',
          createdAt: now - 5 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '明早晨会安排',
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
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'status_update');
    expect((worldCandidate?.payload as { reasonType?: string }).reasonType).toBe('world_calendar_upcoming_reminder');
    expect((worldCandidate?.payload as { dedupeKey?: string }).dedupeKey).toContain('item-upcoming-1');
  });

  it('records restrained proactive-care fallback when status_update is selected', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
        {
          id: 'artifact-checkin-recent',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 10 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '甲刚刚私聊问候过',
          visibility: 'derived_public',
          payload: { artifactType: 'check_in_note', eventKind: 'check_in', text: '甲刚刚私聊问候过' },
        } as RuntimeEventV2,
        {
          id: 'artifact-outing-recent',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 20 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '甲刚刚发起过活动邀约',
          visibility: 'derived_public',
          payload: { artifactType: 'outing_summary', eventKind: 'social_outing', text: '甲刚刚发起过活动邀约' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [{ ...buildCharacter('a', '甲'), generationPreferences: { moments: 'off', diaries: 'follow_global' } } as AICharacter],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string; decisionType?: string }).eventType === 'world_decision_v2'
      && ['world_attention_restrained_fallback', 'world_attention_cooldown_window', 'world_attention_moment_delay_window'].includes((event.payload as { reasonType?: string }).reasonType || '')
      && (event.payload as { decisionType?: string }).decisionType === 'fallback');
    const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string }).eventType === 'event_candidate_suppressed');
    expect(decision || suppression).toBeTruthy();
  });

  it('suppresses share_moment at late night for non-night-owl personas and records reason', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T23:50:00+08:00'));
    try {
      const now = Date.now();
      const chat = {
        ...buildChatWithEvents([
          {
            id: 'att-1',
            conversationId: 'chat-1',
            kind: 'attention_candidate',
            createdAt: now - 2_000,
            actorIds: ['user'],
            targetIds: ['a'],
            summary: '用户提到最近状态',
            visibility: 'derived_public',
            payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
          } as RuntimeEventV2,
        ]),
        relationshipLedger: [{
          pairKey: 'a->user',
          actorId: 'a',
          targetId: 'user',
          current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
          trend: 'up' as const,
          recentEvents: [],
          lastUpdatedAt: now - 1_000,
        }],
      };
      const updateChat = vi.fn(async () => undefined);
      await runSocialEventAutoFlow(chat, {
        chats: [chat],
        characters: [{ ...buildCharacter('a', '甲'), speakingStyle: '作息规律，白天活跃。' } as AICharacter],
        updateChat,
        addChat: vi.fn(async () => buildBaseChat()),
        addMessage: vi.fn(async () => ({})),
        appendEventMessage: vi.fn(async () => undefined),
      });
      const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
      const patch = firstCall?.[1];
      const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
        && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
        && (event.payload as { reasonType?: string }).reasonType === 'world_attention_moment_quiet_hours');
      expect(suppression).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records next suggested trigger time when share_moment is delayed and falls back to status_update', async () => {
    const now = Date.now();
    const recentSocialAt = now - 5 * 60_000;
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
        {
          id: 'artifact-status-recent',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: recentSocialAt,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '甲刚刚状态更新',
          visibility: 'derived_public',
          payload: { artifactType: 'status_note', eventKind: 'status_update', text: '甲刚刚状态更新' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string; decisionType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { decisionType?: string }).decisionType === 'fallback'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_moment_delay_window');
    const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_moment_delay_window');
    const holder = decision || suppression;
    expect(holder).toBeTruthy();
    expect(typeof (holder?.payload as { nextSuggestedAt?: unknown })?.nextSuggestedAt).toBe('number');
  });

  it('consumes pending delayed-moment schedule and keeps fallback before suggested time', async () => {
    const now = Date.now();
    const nextSuggestedAt = now + 8 * 60_000;
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
        {
          id: 'sup-delay',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 1_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '发圈候选进入延迟窗口',
          visibility: 'derived_public',
          payload: {
            eventType: 'event_candidate_suppressed',
            reasonType: 'world_attention_moment_delay_window',
            candidateEventKind: 'post_moment',
            nextSuggestedAt,
          },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const fallback = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string; decisionType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_moment_delay_window'
      && (event.payload as { decisionType?: string }).decisionType === 'fallback');
    const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_moment_delay_window');
    const holder = fallback || suppression;
    expect(holder).toBeTruthy();
    expect((holder?.payload as { nextSuggestedAt?: number }).nextSuggestedAt).toBe(nextSuggestedAt);
  });

  it('records proactive-care cooldown fallback with nextSuggestedAt for check_in intent', async () => {
    const now = Date.now();
    const recentCheckInAt = now - 10 * 60_000;
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
        {
          id: 'artifact-checkin-recent',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: recentCheckInAt,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '甲刚刚问候过',
          visibility: 'derived_public',
          payload: { artifactType: 'check_in_note', eventKind: 'check_in', text: '甲刚刚问候过' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 4, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const fallback = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string; decisionType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_cooldown_window'
      && (event.payload as { decisionType?: string }).decisionType === 'fallback');
    const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_check_in_cooldown');
    const holder = fallback || suppression;
    expect(holder).toBeTruthy();
    expect(typeof (holder?.payload as { nextSuggestedAt?: unknown })?.nextSuggestedAt).toBe('number');
  });

  it('world-driven post_moment uses text-only artifact when image model is unavailable', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 11, competence: 4, trust: 9, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      imageModelEnabled: false,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment');
    if (!worldCandidate) return;
    expect((worldCandidate.payload as { expectedArtifacts?: string[] }).expectedArtifacts).toEqual(['moment_text']);
  });

  it('world-driven post_moment may include optional image artifacts when image model is available', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 11, competence: 4, trust: 9, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      imageModelEnabled: true,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
    const patch = firstCall?.[1];
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment');
    if (!worldCandidate) return;
    const artifacts = (worldCandidate.payload as { expectedArtifacts?: string[] }).expectedArtifacts || [];
    expect(artifacts.includes('moment_text')).toBe(true);
    expect(artifacts.every((item) => ['moment_text', 'moment_selfie', 'moment_group_photo', 'moment_scene_photo'].includes(item))).toBe(true);
  });

  it('backdates world-driven post_moment artifacts into the offline idle window', async () => {
    const now = Date.now();
    const lastChatAt = now - 4 * 60 * 60_000;
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: lastChatAt + 1_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
        {
          id: 'check-1',
          conversationId: 'chat-1',
          kind: 'artifact',
          createdAt: now - 60 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: '甲刚刚问候过',
          visibility: 'derived_public',
          payload: { artifactType: 'check_in_note', eventKind: 'check_in', text: '甲刚刚问候过' },
        } as RuntimeEventV2,
      ]),
      updatedAt: lastChatAt,
      lastMessageAt: lastChatAt,
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 11, competence: 4, trust: 9, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: lastChatAt + 2_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      imageModelEnabled: false,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const patch = updateChat.mock.calls[0]?.[1] as { runtimeEventsV2?: RuntimeEventV2[] } | undefined;
    const candidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment');
    const moment = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text');
    expect(candidate?.createdAt).toBeLessThanOrEqual(now - 5 * 60_000);
    expect(candidate?.createdAt).toBeGreaterThanOrEqual(lastChatAt + 2 * 60 * 60_000);
    expect(moment?.createdAt).toBe((candidate?.createdAt || 0) + 2);
  });

  it('does not create world-driven post_moment when global moments generation is disabled', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 11, competence: 4, trust: 9, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    setAIGenerationRuntimeConfig({ enableMoments: false, enableDiaries: true });
    try {
      await runSocialEventAutoFlow(chat, {
        chats: [chat],
        characters: [buildCharacter('a', '甲')],
        imageModelEnabled: true,
        updateChat,
        addChat: vi.fn(async () => buildBaseChat()),
        addMessage: vi.fn(async () => ({})),
        appendEventMessage: vi.fn(async () => undefined),
      });
      const firstCall = updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined;
      const patch = firstCall?.[1];
      const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate' && (event.payload as { eventKind?: string }).eventKind === 'post_moment');
      expect(worldCandidate).toBeUndefined();
    } finally {
      setAIGenerationRuntimeConfig({ enableMoments: true, enableDiaries: true });
    }
  });

  it('writes suppression artifact when world attention restraint is too high', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 1_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.92, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 2, competence: 3, trust: 2, threat: 10 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 500,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_high_restraint');
    const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; decisionType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { decisionType?: string }).decisionType === 'suppressed');
    const checkInCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate'
      && (event.payload as { eventKind?: string }).eventKind === 'check_in');
    expect(suppression || decision || !checkInCandidate).toBeTruthy();
  });

  it('writes companionship-boundary suppression and does not fallback to user-directed status update', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 1_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户点名 a，等待回应',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.95, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 18, competence: 4, trust: 16, threat: -2 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 500,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    const actor = {
      ...buildCharacter('a', '甲'),
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说不要主动打扰，也别提醒或私聊。'],
      },
    } as AICharacter;

    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [actor],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });

    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const events = patch?.runtimeEventsV2 || [];
    const suppression = events.find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_boundary');
    const decision = events.find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string; decisionType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { reasonType?: string }).reasonType === 'companionship_boundary'
      && (event.payload as { decisionType?: string }).decisionType === 'suppressed');
    const userDirectedCandidate = events.find((event) => {
      if (event.kind !== 'event_candidate') return false;
      const payload = event.payload as { eventKind?: string; targetIds?: string[] };
      return Boolean(payload.targetIds?.includes('user') && ['check_in', 'status_update', 'social_outing', 'react_to_moment'].includes(payload.eventKind || ''));
    });

    expect(suppression).toBeTruthy();
    expect(decision).toBeTruthy();
    expect(userDirectedCandidate).toBeUndefined();
  });

  it('writes moment-disabled suppression when share_moment is suggested for the actor', async () => {
    const now = Date.now();
    const chat = {
      ...buildChatWithEvents([
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 2_000,
          actorIds: ['user'],
          targetIds: ['a'],
          summary: '用户提到最近状态',
          visibility: 'derived_public',
          payload: { source: 'user_group_message', targetIds: ['a'], confidence: 0.9, reason: '用户刚提到近期生活状态' },
        } as RuntimeEventV2,
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 11, competence: 4, trust: 9, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [{ ...buildCharacter('a', '甲'), generationPreferences: { moments: 'off', diaries: 'follow_global' } } as AICharacter],
      imageModelEnabled: true,
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    const patch = (updateChat.mock.calls.at(0) as [string, { runtimeEventsV2?: RuntimeEventV2[] }] | undefined)?.[1];
    const suppression = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; reasonType?: string }).eventType === 'event_candidate_suppressed'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_moment_disabled');
    const decision = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'artifact'
      && (event.payload as { eventType?: string; decisionType?: string; reasonType?: string }).eventType === 'world_decision_v2'
      && (event.payload as { decisionType?: string; reasonType?: string }).decisionType === 'fallback'
      && (event.payload as { reasonType?: string }).reasonType === 'world_attention_moment_disabled');
    const worldCandidate = (patch?.runtimeEventsV2 || []).find((event) => event.kind === 'event_candidate');
    expect(suppression).toBeTruthy();
    expect(decision).toBeTruthy();
    expect(worldCandidate).toBeTruthy();
  });

  it('skips check_in candidate consumption when restraint policy blocks due to high threat', async () => {
    const now = new Date('2026-05-29T21:30:00+08:00').getTime();
    const chat = {
      ...buildChatWithEvents([{
        id: 'evt-checkin-blocked',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: now,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '甲准备私聊问候用户',
        visibility: 'derived_public',
        payload: {
          eventKind: 'check_in',
          initiatorId: 'a',
          participantIds: ['a'],
          targetIds: ['user'],
          reasonType: 'world_attention_followup',
          confidence: 0.88,
          urgency: 'soon',
          seedIntent: '确认一下你的状态',
          visibilityPlan: 'user_private',
          expectedArtifacts: ['check_in_note'],
        },
      } as RuntimeEventV2]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, competence: 3, trust: 7, threat: 9 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('skips social_outing candidate consumption during quiet hours', async () => {
    const now = new Date('2026-05-29T23:30:00+08:00').getTime();
    const chat = {
      ...buildChatWithEvents([{
        id: 'evt-outing-blocked',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: now,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '甲准备邀约活动',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          initiatorId: 'a',
          participantIds: ['a', 'user'],
          targetIds: ['user'],
          reasonType: 'world_attention_invite_activity',
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '周末一起出去走走',
          visibilityPlan: 'mixed',
          expectedArtifacts: ['outing_summary'],
        },
      } as RuntimeEventV2]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 3, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('skips consuming duplicated check_in candidate when dedupeKey artifact already exists in window', async () => {
    const now = new Date('2026-05-29T21:30:00+08:00').getTime();
    const chat = buildChatWithEvents([
      {
        id: 'evt-checkin-existing-artifact',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: now - 20 * 60_000,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '甲刚完成问候',
        visibility: 'derived_public',
        payload: {
          artifactType: 'check_in_note',
          eventKind: 'check_in',
          dedupeKey: 'checkin-dedupe-1',
          text: '甲刚完成问候',
        },
      } as RuntimeEventV2,
      {
        id: 'evt-checkin-duplicate-candidate',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: now,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '甲再次准备同一条问候',
        visibility: 'derived_public',
        payload: {
          eventKind: 'check_in',
          initiatorId: 'a',
          participantIds: ['a'],
          targetIds: ['user'],
          reasonType: 'world_attention_followup',
          confidence: 0.9,
          urgency: 'soon',
          seedIntent: '重复问候',
          visibilityPlan: 'user_private',
          expectedArtifacts: ['check_in_note'],
          dedupeKey: 'checkin-dedupe-1',
        },
      } as RuntimeEventV2,
    ]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('skips candidate consumption when initiator is not in chat members', async () => {
    const now = new Date('2026-05-29T21:30:00+08:00').getTime();
    const chat = buildChatWithEvents([{
      id: 'evt-invalid-initiator',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: now,
      actorIds: ['outsider'],
      targetIds: ['user'],
      summary: '外部角色准备问候用户',
      visibility: 'derived_public',
      payload: {
        eventKind: 'check_in',
        initiatorId: 'outsider',
        participantIds: ['outsider'],
        targetIds: ['user'],
        reasonType: 'world_attention_followup',
        confidence: 0.9,
        urgency: 'soon',
        seedIntent: '外部问候',
        visibilityPlan: 'user_private',
        expectedArtifacts: ['check_in_note'],
      },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('skips pair_private_thread candidate when participant list includes user', async () => {
    const chat = buildChatWithEvents([{
      id: 'evt-invalid-pair',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: Date.now(),
      actorIds: ['a'],
      targetIds: ['user'],
      summary: '非法双边候选',
      visibility: 'derived_public',
      payload: {
        eventKind: 'pair_private_thread',
        initiatorId: 'a',
        participantIds: ['a', 'user'],
        targetIds: ['user'],
        reasonType: 'unresolved_question',
        confidence: 0.95,
        urgency: 'immediate',
        seedIntent: '继续私聊',
        visibilityPlan: 'conversation_private',
        expectedArtifacts: ['private_thread_summary'],
      },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.privateChatId).toBeNull();
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('skips check_in candidate when visibilityPlan is not user_private', async () => {
    const chat = buildChatWithEvents([{
      id: 'evt-invalid-checkin-visibility',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: Date.now(),
      actorIds: ['a'],
      targetIds: ['user'],
      summary: '可见性错误的问候候选',
      visibility: 'derived_public',
      payload: {
        eventKind: 'check_in',
        initiatorId: 'a',
        participantIds: ['a'],
        targetIds: ['user'],
        reasonType: 'world_attention_followup',
        confidence: 0.9,
        urgency: 'soon',
        seedIntent: '问候',
        visibilityPlan: 'public',
        expectedArtifacts: ['check_in_note'],
      },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('skips candidate consumption when initiator is missing from participantIds', async () => {
    const chat = buildChatWithEvents([{
      id: 'evt-invalid-participant-shape',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: Date.now(),
      actorIds: ['a'],
      targetIds: ['user'],
      summary: 'participantIds 不含发起者',
      visibility: 'derived_public',
      payload: {
        eventKind: 'check_in',
        initiatorId: 'a',
        participantIds: ['b'],
        targetIds: ['user'],
        reasonType: 'world_attention_followup',
        confidence: 0.9,
        urgency: 'soon',
        seedIntent: '问候',
        visibilityPlan: 'user_private',
        expectedArtifacts: ['check_in_note'],
      },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('skips check_in candidate when expectedArtifacts mismatches canonical artifact', async () => {
    const chat = buildChatWithEvents([{
      id: 'evt-invalid-expected-artifacts',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: Date.now(),
      actorIds: ['a'],
      targetIds: ['user'],
      summary: 'expectedArtifacts 不匹配',
      visibility: 'derived_public',
      payload: {
        eventKind: 'check_in',
        initiatorId: 'a',
        participantIds: ['a'],
        targetIds: ['user'],
        reasonType: 'world_attention_followup',
        confidence: 0.9,
        urgency: 'soon',
        seedIntent: '问候',
        visibilityPlan: 'user_private',
        expectedArtifacts: ['status_note'],
      },
    } as RuntimeEventV2]);
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('skips user-targeted candidate when user is not a chat member', async () => {
    const base = buildChatWithEvents([{
      id: 'evt-user-not-member',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: Date.now(),
      actorIds: ['a'],
      targetIds: ['user'],
      summary: '用户不在群里却发起问候',
      visibility: 'derived_public',
      payload: {
        eventKind: 'check_in',
        initiatorId: 'a',
        participantIds: ['a'],
        targetIds: ['user'],
        reasonType: 'world_attention_followup',
        confidence: 0.9,
        urgency: 'soon',
        seedIntent: '问候',
        visibilityPlan: 'user_private',
        expectedArtifacts: ['check_in_note'],
      },
    } as RuntimeEventV2]);
    const chat = { ...base, memberIds: ['a', 'b'] };
    const updateChat = vi.fn(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBeNull();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('picks the latest eligible pair private thread candidate', () => {
    const chat = buildOpenedEventStandardChat();
    expect(pickAutoPairPrivateThreadCandidate(chat)?.id).toBe(buildOpenedEventStandardExpectedId());
  });

  it('skips low-confidence candidates', () => {
    expect(pickAutoPairPrivateThreadCandidate(buildOpenedEventLowChat())).toBe(buildOpenedEventLowExpectedNull());
  });

  it('skips candidates still within cooldown after opened thread', () => {
    expect(pickAutoPairPrivateThreadCandidate(buildOpenedEventCooldownWindowChat())).toBe(buildOpenedEventCooldownExpectedNull());
  });

  it('skips companionship pair candidates during schedule cooldown', () => {
    const chat = buildChatWithEvents([
      buildCandidateEvent(buildCandidatePayload({ reasonType: 'companionship_promise_followup', dedupeKey: 'companionship-private-thread-chat-1-a-b' }), 1000),
      {
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
      } as RuntimeEventV2,
    ]);
    expect(pickAutoPairPrivateThreadCandidate(chat)).toBeNull();
  });

  it('allows companionship pair candidates when private thread cooldown is disabled', () => {
    setCompanionshipRuntimeConfig({
      ...DEFAULT_COMPANIONSHIP_SETTINGS,
      privateThreadCooldownHours: 0,
    });
    const chat = buildChatWithEvents([
      buildCandidateEvent(buildCandidatePayload({ reasonType: 'companionship_promise_followup', dedupeKey: 'companionship-private-thread-chat-1-a-b' }), 1000),
      {
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
      } as RuntimeEventV2,
    ]);
    expect(pickAutoPairPrivateThreadCandidate(chat)?.id).toBe('evt-candidate-1000');
  });

  it('records skipped schedule when auto flow sees a cooling companionship pair candidate', async () => {
    const chat = buildChatWithEvents([
      buildCandidateEvent(buildCandidatePayload({ reasonType: 'companionship_promise_followup', dedupeKey: 'companionship-private-thread-chat-1-a-b' }), 1000),
      {
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
      } as RuntimeEventV2,
    ]);
    const updateChat = vi.fn(async (_chatId: string, _patch: Partial<ReturnType<typeof normalizeConversation>>) => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [buildCharacter('a', '甲'), buildCharacter('b', '乙')],
      updateChat,
      addChat: vi.fn(async () => buildBaseChat()),
      addMessage: buildAddMessageMock(),
      appendEventMessage: buildAppendEventMessageMock(),
    });
    const updatedPatch = updateChat.mock.calls[0]?.[1] as { runtimeEventsV2?: RuntimeEventV2[] } | undefined;
    const skipped = (updatedPatch?.runtimeEventsV2 || []).find((event) => (event.payload as { eventType?: string; action?: string }).eventType === 'companionship_private_thread_schedule'
      && (event.payload as { action?: string }).action === 'skipped');

    expect(result).toMatchObject({ privateChatId: null, handledEventId: 'evt-candidate-1000' });
    expect(skipped).toMatchObject({
      visibility: 'role_private',
      visibleToIds: ['a', 'b'],
      payload: expect.objectContaining({
        action: 'skipped',
        candidateId: 'evt-candidate-1000',
        dedupeKey: 'companionship-private-thread-chat-1-a-b',
      }),
    });
  });

  it('creates a public opened-thread artifact event', () => {
    const chat = buildOpenedEventPairThreadChat();
    const opened = buildPrivateThreadOpenedEvent(chat, buildOpenedEventPairThreadCandidate());
    expect(opened.kind).toBe('artifact');
    expect(opened.visibility).toBe('derived_public');
    expect((opened.payload as { artifactType?: string; eventKind?: string; candidateId?: string }).artifactType).toBe('private_thread_opened');
    expect((opened.payload as { artifactType?: string; eventKind?: string; candidateId?: string }).eventKind).toBe('pair_private_thread');
    expect((opened.payload as { artifactType?: string; eventKind?: string; candidateId?: string }).candidateId).toBe('evt-candidate-1');
  });
});

describe('passesWorldAttentionRestraintPolicy', () => {
  it('blocks user-targeted proactive care when companionship boundary rejects active contact', () => {
    const now = new Date('2026-05-29T21:30:00+08:00').getTime();
    const chat = {
      ...buildBaseChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 50, competence: 2, trust: 50, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    const actor = {
      ...buildCharacter('a', '甲'),
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说不要主动打扰，也别提醒或私聊。'],
      },
    } as AICharacter;

    expect(passesWorldAttentionRestraintPolicy(chat, 'a', 'user', now, 'check_in', 'world_attention_private_message', actor)).toBe(false);
    expect(passesWorldAttentionRestraintPolicy(chat, 'a', 'user', now, 'social_outing', 'world_attention_invite_activity', actor)).toBe(false);
  });

  it('blocks invite activity during quiet hours', () => {
    const now = new Date('2026-05-29T23:30:00+08:00').getTime();
    const chat = {
      ...buildBaseChat(),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 12, competence: 2, trust: 10, threat: 0 },
        trend: 'up' as const,
        recentEvents: [],
        lastUpdatedAt: now - 1_000,
      }],
    };
    expect(passesWorldAttentionRestraintPolicy(chat, 'a', 'user', now, 'social_outing', 'world_attention_invite_activity')).toBe(false);
  });

  it('blocks reminder when recent user-private follow-up is still in cooldown', () => {
    const now = new Date('2026-05-29T21:30:00+08:00').getTime();
    const chat = buildChatWithEvents([{
      id: 'evt-check-1',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: now - 30 * 60_000,
      actorIds: ['a'],
      targetIds: ['user'],
      summary: 'a 私聊问候了 user',
      visibility: 'derived_public',
      payload: { eventKind: 'check_in', visibilityPlan: 'user_private', artifactType: 'check_in_note' },
    } as RuntimeEventV2]);
    chat.relationshipLedger = [{
      pairKey: 'a->user',
      actorId: 'a',
      targetId: 'user',
      current: { warmth: 9, competence: 2, trust: 8, threat: 0 },
      trend: 'up' as const,
      recentEvents: [],
      lastUpdatedAt: now - 1_000,
    }];
    expect(passesWorldAttentionRestraintPolicy(chat, 'a', 'user', now, 'status_update', 'world_attention_calendar_reminder')).toBe(false);
  });
});
