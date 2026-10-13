import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
  DEFAULT_CONVERSATION_DRAMA_RULES,
  DEFAULT_CONVERSATION_GOVERNANCE,
  DEFAULT_CONVERSATION_WORLD_STATE,
  DEFAULT_OPEN_CHAT_MODE_CONFIG,
  DEFAULT_OPEN_CHAT_MODE_STATE,
  type GroupChat,
} from '../types/chat';
import type { RelationshipLedgerEntry, RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';
import type { Message } from '../types/message';
import type { AICharacter } from '../types/character';
import type { MemoryItem } from '../services/memoryTypes';
import { storageKey } from '../constants/brand';
import { createInitialRoomState } from '../services/roomStateSynthesizer';

function createStorageMock() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  };
}

function memory(index: number): MemoryItem {
  return {
    id: `memory-${index}`,
    scope: 'conversation',
    layer: 'episodic',
    kind: 'status_shift',
    ownerId: 'chat-1',
    text: `记忆 ${index}`,
    salience: 50,
    confidence: 0.8,
    recency: 50,
    reinforcementCount: 1,
    sourceEventIds: [`event-${index}`],
    createdAt: index,
    updatedAt: index,
  };
}

function runtimeEvent(index: number): RuntimeEventV2 {
  return {
    id: `event-${index}`,
    conversationId: 'chat-1',
    kind: 'room_shift',
    createdAt: index,
    summary: `房间变化 ${index}`,
    visibility: 'public',
    payload: { heat: index },
  };
}

function companionshipEvent(id: string, createdAt: number, payload: Record<string, unknown>): RuntimeEventV2 {
  return {
    id,
    conversationId: 'chat-1',
    kind: 'artifact',
    createdAt,
    summary: `陪伴事件 ${id}`,
    visibility: 'pair_private',
    payload,
  };
}

function companionshipStateEvents(createdAtOffset = 0) {
  const at = (value: number) => createdAtOffset + value;
  return [
    companionshipEvent('companionship-phase-old', at(2), {
      eventType: 'companionship_phase_event',
      characterId: 'char-1',
      userId: 'user-1',
      phase: 'confirmed',
      confidence: 0.93,
      decisionSource: 'model',
    }),
    companionshipEvent('companionship-addressing-old', at(3), {
      eventType: 'companionship_addressing',
      characterId: 'char-1',
      userId: 'user-1',
      action: 'set_private',
      privateAddress: '小月亮',
      confidence: 0.9,
      decisionSource: 'model',
    }),
    companionshipEvent('companionship-care-topic-old', at(4), {
      eventType: 'companionship_care_topic',
      characterId: 'char-1',
      userId: 'user-1',
      topicId: 'topic-1',
      topicText: '明天面试',
      action: 'opened',
    }),
    companionshipEvent('companionship-promise-old', at(5), {
      eventType: 'companionship_promise',
      characterId: 'char-1',
      userId: 'user-1',
      promiseId: 'promise-1',
      promiseText: '周末一起看电影',
      action: 'opened',
    }),
    companionshipEvent('companionship-ritual-old', at(6), {
      eventType: 'companionship_ritual',
      characterId: 'char-1',
      userId: 'user-1',
      ritualId: 'ritual-goodnight',
      action: 'performed',
      kind: 'daily_greeting',
    }),
    companionshipEvent('companionship-secret-old', at(7), {
      eventType: 'companionship_shared_secret',
      characterId: 'char-1',
      userId: 'user-1',
      secretId: 'secret-1',
      action: 'recorded',
      publicMask: '懂的人会懂',
    }),
    companionshipEvent('companionship-phrase-old', at(7.1), {
      eventType: 'companionship_shared_phrase',
      characterId: 'char-1',
      userId: 'user-1',
      phraseId: 'phrase-1',
      action: 'upsert',
      text: '慢慢来，我在',
    }),
    companionshipEvent('companionship-phrase-other-old', at(7.2), {
      eventType: 'companionship_shared_phrase',
      characterId: 'char-1',
      userId: 'user-1',
      phraseId: 'phrase-2',
      action: 'upsert',
      text: '晚点回来',
    }),
    companionshipEvent('companionship-anchor-old', at(8), {
      eventType: 'companionship_shared_anchor',
      characterId: 'char-1',
      userId: 'user-1',
      anchorId: 'anchor-1',
      action: 'upsert',
      text: '第一次认真说开',
    }),
    companionshipEvent('companionship-profile-old', at(9), {
      eventType: 'companionship_user_profile_memory',
      characterId: 'char-1',
      userId: 'user-1',
      action: 'upsert',
      items: [{ kind: 'preference', text: '喜欢晚上聊天' }],
    }),
    companionshipEvent('companionship-conflict-old', at(10), {
      eventType: 'companionship_intimate_conflict',
      characterId: 'char-1',
      userId: 'user-1',
      action: 'opened',
      kind: 'testing',
      summary: '试探性冷淡',
    }),
    companionshipEvent('companionship-attachment-old', at(11), {
      eventType: 'companionship_attachment_profile',
      characterId: 'char-1',
      userId: 'user-1',
      action: 'inferred',
      inferredStyle: 'secure',
    }),
    companionshipEvent('companionship-online-return-old', at(12), {
      eventType: 'companionship_online_return',
      characterId: 'char-1',
      userId: 'user-1',
      action: 'shown',
      text: '终于等到你回来。',
    }),
    companionshipEvent('companionship-unsent-draft-old', at(13), {
      eventType: 'companionship_unsent_draft',
      characterId: 'char-1',
      userId: 'user-1',
      action: 'drafted',
      text: '本来想问问你后来怎么样。',
    }),
  ];
}

function relationship(index: number): RelationshipLedgerEntry {
  return {
    pairKey: `a-${index}->b-${index}`,
    actorId: `a-${index}`,
    targetId: `b-${index}`,
    current: { warmth: 1, competence: 0, trust: 2, threat: 0 },
    trend: 'up',
    recentEvents: [],
    lastUpdatedAt: index,
  };
}

function chat(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: DEFAULT_OPEN_CHAT_MODE_CONFIG,
    modeState: DEFAULT_OPEN_CHAT_MODE_STATE,
    name: '测试群聊',
    topic: '测试主题',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    layeredMemories: [],
    runtimeSeed: { notes: [], artifacts: [] },
    runtimeTimeline: [],
    runtimeEventsV2: [],
    relationshipLedger: [],
    governance: DEFAULT_CONVERSATION_GOVERNANCE,
    dramaRules: DEFAULT_CONVERSATION_DRAMA_RULES,
    worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE, mood: '紧张', focus: '关系变化' },
    directorControls: DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
    ...overrides,
  };
}

function message(overrides: Partial<Message>): Message {
  return {
    id: overrides.id || 'message-1',
    chatId: 'chat-1',
    type: overrides.type || 'ai',
    senderId: overrides.senderId || 'a',
    content: overrides.content || '继续聊。',
    emotion: 0,
    timestamp: overrides.timestamp || 100,
    isDeleted: false,
    ...overrides,
  };
}

describe('chat runtime persistence', () => {
  it('keeps calendar source and incremental patches outside the cloud and local history budget', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { compactChatPatchForCloud, buildPersistedChatState, limits } = __chatRuntimePersistenceForTests;
    const calendarEvents: RuntimeEventV2[] = [
      { ...runtimeEvent(1), id: 'calendar-source', kind: 'artifact', payload: { eventKind: 'travel_plan', dedupeKey: 'trip', title: 'Trip', participantIds: ['char-1'] } },
      { ...runtimeEvent(2), id: 'calendar-title', kind: 'calendar_item_patch', payload: { calendarItemId: 'trip', title: 'Updated trip' } },
      { ...runtimeEvent(3), id: 'calendar-cancel', kind: 'calendar_item_patch', payload: { calendarItemId: 'trip', cancelled: true } },
      { ...runtimeEvent(4), id: 'calendar-handled', kind: 'artifact', summary: 'handled_social_event:calendar-source', payload: {} },
    ];
    const sourceChat = chat({ runtimeEventsV2: [...calendarEvents, ...Array.from({ length: limits.runtimeEventsV2 + 10 }, (_, index) => runtimeEvent(index + 100))] });
    const cloud = compactChatPatchForCloud(sourceChat);
    const local = buildPersistedChatState({ chats: [sourceChat], currentChatId: 'chat-1', lastSyncedAt: 1, pendingOperations: [] });
    for (const events of [cloud.runtimeEventsV2, local.chats[0]?.runtimeEventsV2]) {
      expect(events?.filter((event) => event.id.startsWith('calendar-'))).toEqual(calendarEvents);
    }
  });
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createStorageMock());
    localStorage.setItem(storageKey('auth-mode'), 'cloud');
    localStorage.setItem(storageKey('token'), 'test-token');
  });

  it('builds runtime patches synchronously from the latest state and queues the same merged state', async () => {
    const { useChatStore } = await import('./useChatStore');
    const base = chat({ runtimeEventsV2: [runtimeEvent(1)] });
    useChatStore.setState({ chats: [base], pendingOperations: [] });
    const first = useChatStore.getState().applyChatRuntimePatch(base.id, (current) => ({
      runtimeEventsV2: [...(current.runtimeEventsV2 || []), runtimeEvent(2)],
      worldState: { ...current.worldState, focus: '新的分工' },
      runtimeSeed: { ...current.runtimeSeed, notes: ['新的承诺'] },
    }));
    const second = useChatStore.getState().applyChatRuntimePatch(base.id, (current) => ({
      runtimeEventsV2: [...(current.runtimeEventsV2 || []), runtimeEvent(3)],
      worldState: { ...current.worldState, recentEvent: '活动安排' },
      runtimeSeed: { ...current.runtimeSeed, notes: [...(current.runtimeSeed?.notes || []), '安排已记录'] },
    }));
    expect(useChatStore.getState().chats[0]?.runtimeEventsV2?.map((event) => event.id))
      .toEqual(['event-1', 'event-2', 'event-3']);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    const state = useChatStore.getState();
    expect(state.chats[0]?.worldState).toMatchObject({ focus: '新的分工', recentEvent: '活动安排' });
    expect(state.chats[0]?.runtimeSeed?.notes).toEqual(['新的承诺', '安排已记录']);
    expect(state.pendingOperations).toHaveLength(1);
    expect(state.pendingOperations[0]?.patch).toMatchObject({
      runtimeEventsV2: state.chats[0]?.runtimeEventsV2,
      worldState: state.chats[0]?.worldState,
      runtimeSeed: state.chats[0]?.runtimeSeed,
    });
  });

  it.each(['missing', 'deleted', 'unchanged', 'failed'] as const)('does not queue a %s runtime patch', async (condition) => {
    const { useChatStore } = await import('./useChatStore');
    const base = chat({ deletedAt: condition === 'deleted' ? 10 : undefined });
    useChatStore.setState({ chats: condition === 'missing' ? [] : [base], pendingOperations: [] });
    const before = useChatStore.getState().chats;
    const buildPatch = vi.fn(() => {
      if (condition === 'failed') throw new Error('effect construction failed');
      return condition === 'unchanged' ? null : { topic: '不会写入' };
    });
    const result = useChatStore.getState().applyChatRuntimePatch(base.id, buildPatch);
    if (condition === 'failed') await expect(result).rejects.toThrow('effect construction failed');
    else expect(await result).toBe(false);
    if (condition === 'missing' || condition === 'deleted') expect(buildPatch).not.toHaveBeenCalled();
    expect(useChatStore.getState().chats).toBe(before);
    expect(useChatStore.getState().pendingOperations).toHaveLength(0);
  });

  it('retains ordinary generation and source notice events while private thread creation waits', async () => {
    const { useChatStore } = await import('./useChatStore');
    const { runSocialEventAutoFlow } = await import('../services/directSessionRuntime');
    const candidate: RuntimeEventV2 = {
      ...runtimeEvent(1), kind: 'event_candidate',
      payload: {
        eventKind: 'pair_private_thread', initiatorId: 'a', participantIds: ['a', 'b'], targetIds: ['b'],
        reasonType: 'unresolved_question', confidence: 0.9, urgency: 'immediate', seedIntent: '继续私聊',
        visibilityPlan: 'conversation_private', expectedArtifacts: ['private_thread_summary'],
      },
    };
    const base = chat({ runtimeEventsV2: [candidate] });
    useChatStore.setState({ chats: [base], pendingOperations: [] });
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const flow = runSocialEventAutoFlow(base, {
      chats: [base], characters: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as AICharacter[],
      allowWorldFallback: false,
      applyChatRuntimePatch: useChatStore.getState().applyChatRuntimePatch,
      addChat: async (input) => {
        await creationGate;
        return useChatStore.getState().addChat(input);
      },
      addMessage: vi.fn(async () => undefined),
      appendEventMessage: async (id) => {
        await useChatStore.getState().applyChatRuntimePatch(id, (current) => ({
          runtimeEventsV2: [...(current.runtimeEventsV2 || []), runtimeEvent(3)],
        }));
      },
    });
    const latestMessage = message({ id: 'during-creation', timestamp: 500 });
    await useChatStore.getState().updateChat(base.id, {
      runtimeEventsV2: [candidate, runtimeEvent(2)],
      worldState: {
        ...base.worldState, focus: '已接受的新分工', recentEvent: '普通发言已提交',
        structuredRoomState: { ...createInitialRoomState(), heat: 64, dominantThread: 'new-thread' },
      },
      runtimeSeed: { notes: ['本人已接受'], artifacts: ['新的日程'] },
      latestMessage, lastMessageAt: latestMessage.timestamp,
      isActive: false,
    });
    releaseCreation();
    const result = await flow;
    expect(result.privateChatId).toBeTruthy();
    expect(result.handledEventId).toBe(candidate.id);
    const updated = useChatStore.getState().getChat(base.id)!;
    expect(updated.runtimeEventsV2?.map((event) => event.id)).toEqual(expect.arrayContaining(['event-1', 'event-2', 'event-3']));
    expect(updated.runtimeEventsV2?.filter((event) => event.summary === `handled_social_event:${candidate.id}`)).toHaveLength(1);
    expect(updated.worldState).toMatchObject({ focus: '已接受的新分工', recentEvent: '普通发言已提交' });
    expect(updated.runtimeSeed).toMatchObject({ notes: ['本人已接受'], artifacts: ['新的日程'] });
    expect(updated.latestMessage?.id).toBe(latestMessage.id);
    expect(updated.isActive).toBe(false);
    const pending = useChatStore.getState().pendingOperations.find((operation) => operation.targetIds.includes(base.id));
    expect(pending?.patch.runtimeEventsV2).toEqual(updated.runtimeEventsV2);
    expect(pending?.patch.worldState).toEqual(updated.worldState);
    expect(pending?.patch.runtimeSeed).toEqual(updated.runtimeSeed);
  });

  it.each(['post_moment', 'status_update', 'check_in', 'react_to_moment', 'social_outing', 'gift_exchange', 'conflict_expression'] as const)(
    'applies %s effects to the latest room and seed instead of the selection snapshot', async (eventKind) => {
      const { useChatStore } = await import('./useChatStore');
      const { runSocialEventAutoFlow } = await import('../services/directSessionRuntime');
      const userTarget = eventKind === 'status_update' || eventKind === 'check_in' || eventKind === 'react_to_moment';
      const payload: SocialEventCandidatePayload = {
        eventKind, initiatorId: 'a', participantIds: ['a'], targetIds: [userTarget ? 'user' : 'b'],
        reasonType: 'care_gesture', confidence: 0.9, urgency: 'soon', seedIntent: '模型已提交的社交候选',
        visibilityPlan: eventKind === 'check_in' || eventKind === 'react_to_moment' ? 'user_private' : 'public',
        expectedArtifacts: [], dedupeKey: `latest-state-${eventKind}`,
      };
      const candidate = { ...runtimeEvent(1), kind: 'event_candidate' as const, payload };
      const base = chat({ memberIds: ['a', 'b', 'user'], runtimeEventsV2: [candidate] });
      useChatStore.setState({ chats: [base], pendingOperations: [] });
      await useChatStore.getState().updateChat(base.id, {
        runtimeEventsV2: [candidate, runtimeEvent(2)],
        worldState: { ...base.worldState, focus: '新的事项', structuredRoomState: { ...createInitialRoomState(), heat: 64, dominantThread: 'new-thread' } },
        runtimeSeed: { notes: ['新的承诺'], artifacts: ['新的安排'] },
      });
      const result = await runSocialEventAutoFlow(base, {
        chats: [base], characters: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as AICharacter[],
        allowWorldFallback: false, applyChatRuntimePatch: useChatStore.getState().applyChatRuntimePatch,
        addChat: vi.fn(async () => base), addMessage: vi.fn(async () => undefined), appendEventMessage: vi.fn(async () => undefined),
      });
      expect(result.handledEventId).toBe(candidate.id);
      const updated = useChatStore.getState().getChat(base.id)!;
      expect(updated.runtimeEventsV2?.map((event) => event.id)).toContain('event-2');
      expect(updated.worldState.focus).toBe('新的事项');
      expect(updated.worldState.structuredRoomState?.heat).toBeGreaterThan(40);
      expect(updated.runtimeSeed?.notes).toContain('新的承诺');
      expect(updated.runtimeSeed?.artifacts).toContain('新的安排');
      const pending = useChatStore.getState().pendingOperations.find((operation) => operation.targetIds.includes(base.id));
      expect(pending?.patch.worldState).toEqual(updated.worldState);
      expect(pending?.patch.runtimeSeed).toEqual(updated.runtimeSeed);
      expect(pending?.patch.runtimeEventsV2).toEqual(updated.runtimeEventsV2);
    },
  );

  it.each(['removed', 'handled', 'member-left', 'deleted'] as const)('rejects a candidate that became %s during private thread creation', async (condition) => {
    const { useChatStore } = await import('./useChatStore');
    const { runSocialEventAutoFlow } = await import('../services/directSessionRuntime');
    const candidate: RuntimeEventV2 = {
      ...runtimeEvent(1), kind: 'event_candidate',
      payload: {
        eventKind: 'pair_private_thread', initiatorId: 'a', participantIds: ['a', 'b'], targetIds: ['b'],
        reasonType: 'unresolved_question', confidence: 0.9, urgency: 'immediate', seedIntent: '继续私聊',
        visibilityPlan: 'conversation_private', expectedArtifacts: ['private_thread_summary'],
      },
    };
    const base = chat({ runtimeEventsV2: [candidate] });
    useChatStore.setState({ chats: [base], pendingOperations: [] });
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const flow = runSocialEventAutoFlow(base, {
      chats: [base], characters: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as AICharacter[],
      allowWorldFallback: false, applyChatRuntimePatch: useChatStore.getState().applyChatRuntimePatch,
      addChat: async (input) => {
        await creationGate;
        return useChatStore.getState().addChat(input);
      },
      addMessage: vi.fn(async () => undefined), appendEventMessage: vi.fn(async () => undefined),
    });
    const handled: RuntimeEventV2 = { ...runtimeEvent(2), kind: 'artifact', summary: `handled_social_event:${candidate.id}`, payload: {} };
    await useChatStore.getState().updateChat(base.id, {
      runtimeEventsV2: condition === 'removed' ? [] : condition === 'handled' ? [candidate, handled] : [candidate],
      memberIds: condition === 'member-left' ? ['a'] : base.memberIds,
      deletedAt: condition === 'deleted' ? 10 : undefined,
    });
    const before = useChatStore.getState().getChat(base.id);
    releaseCreation();
    expect(await flow).toMatchObject({ handledEventId: null });
    expect(useChatStore.getState().getChat(base.id)).toBe(before);
    const pending = useChatStore.getState().pendingOperations.find((operation) => operation.targetIds.includes(base.id));
    expect(pending?.patch.runtimeEventsV2).toEqual(before?.runtimeEventsV2);
  });

  it('uses current candidates and pause state at the page action entry instead of its stale callback snapshot', async () => {
    const { useChatStore } = await import('./useChatStore');
    const { runAutoSocialEventFlowImpl } = await import('../services/chatSurfaceActions');
    const base = chat();
    const candidate: RuntimeEventV2 = {
      ...runtimeEvent(1), kind: 'event_candidate',
      payload: {
        eventKind: 'social_outing', initiatorId: 'a', participantIds: ['a', 'b'], targetIds: ['b'],
        reasonType: 'shared_activity', confidence: 0.9, urgency: 'soon', seedIntent: '一起练兵',
        visibilityPlan: 'public', expectedArtifacts: ['outing_summary'],
      },
    };
    useChatStore.setState({ chats: [chat({ isActive: false, runtimeEventsV2: [candidate] })], pendingOperations: [] });
    const updateChat = vi.fn(async () => undefined);
    expect(await runAutoSocialEventFlowImpl(base, {
      chats: [base], characters: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as AICharacter[],
      updateChat, addMessage: vi.fn(async () => undefined), appendEventMessage: vi.fn(async () => undefined),
    })).toMatchObject({ handledEventId: candidate.id });
    expect(updateChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().getChat(base.id)?.isActive).toBe(false);
    expect(useChatStore.getState().getChat(base.id)?.runtimeEventsV2?.some((event) => event.summary === `handled_social_event:${candidate.id}`)).toBe(true);
  });

  it('keeps bounded runtime fields in cloud patches', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { compactChatPatchForCloud, limits } = __chatRuntimePersistenceForTests;
    const patch = compactChatPatchForCloud({
      layeredMemories: Array.from({ length: limits.layeredMemories + 5 }, (_, index) => memory(index)),
      runtimeSeed: {
        notes: Array.from({ length: limits.runtimeSeedNotes + 3 }, (_, index) => `note-${index}`),
        artifacts: Array.from({ length: limits.runtimeSeedArtifacts + 3 }, (_, index) => `artifact-${index}`),
      },
      runtimeTimeline: Array.from({ length: limits.runtimeTimeline + 5 }, (_, index) => ({ type: 'note', text: `timeline-${index}`, createdAt: index })),
      runtimeEventsV2: Array.from({ length: limits.runtimeEventsV2 + 5 }, (_, index) => runtimeEvent(index)),
      relationshipLedger: Array.from({ length: limits.relationshipLedger + 5 }, (_, index) => relationship(index)),
      worldState: { mood: '紧张', focus: '关系变化', recentEvent: '刚刚被维护', conflictAxes: [] },
      updatedAt: 999,
      lastMessageAt: 999,
    });

    expect(patch.layeredMemories).toHaveLength(limits.layeredMemories);
    expect(patch.runtimeSeed).toMatchObject({
      notes: expect.arrayContaining(['note-3']),
      artifacts: expect.arrayContaining(['artifact-3']),
    });
    expect((patch.runtimeSeed as NonNullable<GroupChat['runtimeSeed']>).notes).toHaveLength(limits.runtimeSeedNotes);
    expect(patch.runtimeTimeline).toHaveLength(limits.runtimeTimeline);
    expect(patch.runtimeEventsV2).toHaveLength(limits.runtimeEventsV2);
    expect(patch.relationshipLedger).toHaveLength(limits.relationshipLedger);
    expect(patch.worldState).toMatchObject({ mood: '紧张', focus: '关系变化' });
    expect(patch.updatedAt).toBeUndefined();
    expect(patch.lastMessageAt).toBeUndefined();
  });

  it('persists repeated references in sibling fields while removing real ancestor cycles', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { compactChatPatchForCloud, buildPersistedChatState } = __chatRuntimePersistenceForTests;
    const participantIds = ['a', 'b'];
    const sharedPayload: Record<string, unknown> = { participantIds };
    sharedPayload.self = sharedPayload;
    const event: RuntimeEventV2 = {
      ...runtimeEvent(1), kind: 'artifact', actorIds: participantIds, targetIds: participantIds,
      payload: { first: sharedPayload, second: sharedPayload },
    };
    const base = chat({ runtimeEventsV2: [event] });
    const cloud = compactChatPatchForCloud({ runtimeEventsV2: [event] });
    const local = buildPersistedChatState({ chats: [base], currentChatId: base.id, lastSyncedAt: 1, pendingOperations: [] });
    for (const persisted of [cloud.runtimeEventsV2?.[0], local.chats[0]?.runtimeEventsV2?.[0]]) {
      expect(persisted).toEqual({
        ...event, payload: { first: { participantIds }, second: { participantIds } },
      });
      expect(() => JSON.stringify(persisted)).not.toThrow();
    }
  });

  it('preserves current companionship state events when runtime events are compacted', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { compactChatPatchForCloud, limits } = __chatRuntimePersistenceForTests;
    const stateEvents = companionshipStateEvents();
    const recentEvents = Array.from({ length: limits.runtimeEventsV2 + 8 }, (_, index) => runtimeEvent(100 + index));
    const patch = compactChatPatchForCloud({
      runtimeEventsV2: [...stateEvents, ...recentEvents],
    });
    const eventIds = ((patch.runtimeEventsV2 || []) as RuntimeEventV2[]).map((event) => event.id);

    expect(patch.runtimeEventsV2).toHaveLength(limits.runtimeEventsV2);
    expect(eventIds).toEqual(expect.arrayContaining(stateEvents.map((event) => event.id)));
  });

  it('keeps remote message branch state when that field version is newer than a locally newer chat record', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { mergeChatRecord } = __chatRuntimePersistenceForTests;
    const local = chat({
      updatedAt: 3000,
      topic: '本机较新的普通字段',
      fieldVersions: { topic: 3000, messageBranchState: 1000 },
      messageBranchState: {
        selectedRevisionByRootId: { root: 'old-revision' },
        activeChildByParentNodeId: { parent: 'old-revision' },
        activeLeafNodeId: 'old-revision',
        updatedAt: 1000,
      },
    });
    const remote = chat({
      updatedAt: 2000,
      topic: '远端旧主题',
      runtimeDetailLoaded: true,
      fieldVersions: { topic: 500, messageBranchState: 4000 },
      messageBranchState: {
        selectedRevisionByRootId: { root: 'new-revision' },
        activeChildByParentNodeId: { parent: 'new-revision' },
        activeLeafNodeId: 'new-revision',
        updatedAt: 4000,
      },
    });

    const merged = mergeChatRecord(local, remote);

    expect(merged.topic).toBe('本机较新的普通字段');
    expect(merged.messageBranchState?.selectedRevisionByRootId).toMatchObject({ root: 'new-revision' });
    expect(merged.fieldVersions?.messageBranchState).toBe(4000);
  });

  it('treats assistant agent capability changes as chat list changes', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { buildChatListSignature } = __chatRuntimePersistenceForTests;
    const disabled = chat({
      type: 'assistant',
      modeState: {
        ...DEFAULT_OPEN_CHAT_MODE_STATE,
        assistantCapabilities: { agent: false, artifacts: false, webSearch: false },
      },
    });
    const enabled = chat({
      ...disabled,
      modeState: {
        ...disabled.modeState,
        assistantCapabilities: { agent: true, artifacts: true, webSearch: true },
      },
    });

    expect(buildChatListSignature([disabled])).not.toBe(buildChatListSignature([enabled]));
  });

  it('stamps message branch state field version when a local chat patch is queued', async () => {
    const { useChatStore } = await import('./useChatStore');
    const base = chat({ fieldVersions: {}, messageBranchState: null });
    useChatStore.setState({
      chats: [base],
      currentChatId: base.id,
      lastSyncedAt: 0,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      fieldConflicts: [],
      chatSummaryLoadedAt: 0,
      isLoading: false,
    });

    await useChatStore.getState().updateChat(base.id, {
      messageBranchState: {
        selectedRevisionByRootId: { root: 'local-revision' },
        activeChildByParentNodeId: { parent: 'local-revision' },
        activeLeafNodeId: 'local-revision',
        updatedAt: 5000,
      },
    });

    const updated = useChatStore.getState().chats[0];
    const operation = useChatStore.getState().pendingOperations[0];
    expect(updated?.messageBranchState?.activeLeafNodeId).toBe('local-revision');
    expect(updated?.fieldVersions?.messageBranchState).toBe(operation?.clientTimestamp);
    expect(operation?.patch.messageBranchState).toBeTruthy();
  });

  it('does not let runtime event messages replace chat latest preview', async () => {
    const { useChatStore } = await import('./useChatStore');
    const previousLatest = message({ id: 'message-visible', type: 'ai', content: '真正的最后一句发言', timestamp: 100 });
    const runtimeEvent = message({ id: 'message-event', type: 'event', content: '归属/身份冲突：0', timestamp: 200 });
    const base = chat({ latestMessage: previousLatest, lastMessageAt: previousLatest.timestamp });
    useChatStore.setState({
      chats: [base],
      currentChatId: base.id,
      lastSyncedAt: 0,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      fieldConflicts: [],
      chatSummaryLoadedAt: 0,
      isLoading: false,
    });

    await useChatStore.getState().updateChat(base.id, {
      latestMessage: runtimeEvent,
      lastMessageAt: runtimeEvent.timestamp,
    });

    const updated = useChatStore.getState().chats[0];
    const operation = useChatStore.getState().pendingOperations[0];
    expect(updated?.latestMessage?.id).toBe(previousLatest.id);
    expect(updated?.lastMessageAt).toBe(previousLatest.timestamp);
    expect((operation?.patch.latestMessage as Message | undefined)?.id).toBe(previousLatest.id);
  });

  it('queues non-runtime chat patch fields when applying runtime delta', async () => {
    const { useChatStore } = await import('./useChatStore');
    const base = chat({ scenarioState: { deliberationClaims: [] } as GroupChat['scenarioState'] });
    useChatStore.setState({
      chats: [base],
      currentChatId: base.id,
      lastSyncedAt: 0,
      pendingOperations: [],
      pendingEditSyncCount: 0,
      pendingEditSyncError: null,
      remoteDeletedChatIds: [],
      remoteDeletedChats: [],
      fieldConflicts: [],
      chatSummaryLoadedAt: 0,
      isLoading: false,
    });

    await useChatStore.getState().applyChatRuntimeDelta(
      base.id,
      {
        runtimeEventsV2: {
          upserts: [runtimeEvent(2)],
          orderedIds: ['event-2'],
        },
      },
      {
        scenarioState: {
          deliberationClaims: [{
            id: 'claim-1',
            text: '公共区域需要可仲裁规则',
            actorId: 'analyst',
            sourceMessageId: 'message-1',
            createdAt: 2,
            confidence: 0.8,
          }],
        } as GroupChat['scenarioState'],
      },
    );

    const state = useChatStore.getState();
    expect(state.chats[0]?.runtimeEventsV2).toHaveLength(1);
    expect(state.chats[0]?.scenarioState?.deliberationClaims).toHaveLength(1);
    expect(state.pendingOperations).toHaveLength(1);
    expect(state.pendingOperations[0]?.patch.scenarioState).toMatchObject({
      deliberationClaims: [expect.objectContaining({ id: 'claim-1' })],
    });
    expect(state.pendingOperations[0]?.patch.runtimeEventsV2).toBeUndefined();
  });

  it('merges a stale remote chat when only message branch state has a newer field version', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { mergeChats } = __chatRuntimePersistenceForTests;
    const local = chat({
      updatedAt: 3000,
      fieldVersions: { messageBranchState: 1000 },
      messageBranchState: {
        selectedRevisionByRootId: { root: 'old-revision' },
        activeChildByParentNodeId: { parent: 'old-revision' },
        activeLeafNodeId: 'old-revision',
        updatedAt: 1000,
      },
    });
    const remote = chat({
      updatedAt: 2000,
      runtimeDetailLoaded: true,
      fieldVersions: { messageBranchState: 4000 },
      messageBranchState: {
        selectedRevisionByRootId: { root: 'new-revision' },
        activeChildByParentNodeId: { parent: 'new-revision' },
        activeLeafNodeId: 'new-revision',
        updatedAt: 4000,
      },
    });

    const [merged] = mergeChats([local], [remote]);

    expect(merged?.updatedAt).toBe(3000);
    expect(merged?.messageBranchState?.activeLeafNodeId).toBe('new-revision');
  });

  it('does not overwrite legacy non-null message branch state with null when field versions are missing', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { mergeChatRecord } = __chatRuntimePersistenceForTests;
    const local = chat({
      updatedAt: 1000,
      fieldVersions: {},
      messageBranchState: {
        selectedRevisionByRootId: { root: 'legacy-revision' },
        activeChildByParentNodeId: { parent: 'legacy-revision' },
        activeLeafNodeId: 'legacy-revision',
        updatedAt: 1000,
      },
    });
    const remote = chat({
      updatedAt: 2000,
      fieldVersions: {},
      messageBranchState: null,
    });

    const merged = mergeChatRecord(local, remote);

    expect(merged.messageBranchState?.activeLeafNodeId).toBe('legacy-revision');
  });

  it('preserves recent companionship lifecycle history for the same state key', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { compactChatPatchForCloud, limits } = __chatRuntimePersistenceForTests;
    const promiseHistory = ['opened', 'fulfilled', 'stale', 'revoked', 'opened'].map((action, index) => companionshipEvent(`companionship-promise-history-${index}`, 10 + index, {
      eventType: 'companionship_promise',
      characterId: 'char-1',
      userId: 'user-1',
      promiseId: 'promise-history',
      promiseText: `同一个约定的生命周期 ${index}`,
      action,
    }));
    const secretHistory = ['recorded', 'hinted_publicly', 'leaked', 'confessed', 'revoked'].map((action, index) => companionshipEvent(`companionship-secret-history-${index}`, 20 + index, {
      eventType: 'companionship_shared_secret',
      characterId: 'char-1',
      userId: 'user-1',
      secretId: 'secret-history',
      privateText: `同一个小秘密 ${index}`,
      publicMask: `公开遮罩 ${index}`,
      participantIds: ['char-1', 'user-1'],
      action,
    }));
    const recentEvents = Array.from({ length: limits.runtimeEventsV2 + 20 }, (_, index) => runtimeEvent(100 + index));
    const patch = compactChatPatchForCloud({
      runtimeEventsV2: [...promiseHistory, ...secretHistory, ...recentEvents],
    });
    const eventIds = ((patch.runtimeEventsV2 || []) as RuntimeEventV2[]).map((event) => event.id);

    expect(patch.runtimeEventsV2).toHaveLength(limits.runtimeEventsV2);
    expect(eventIds).toEqual(expect.arrayContaining([
      'companionship-promise-history-1',
      'companionship-promise-history-2',
      'companionship-promise-history-3',
      'companionship-promise-history-4',
      'companionship-secret-history-1',
      'companionship-secret-history-2',
      'companionship-secret-history-3',
      'companionship-secret-history-4',
    ]));
    expect(eventIds).not.toContain('companionship-promise-history-0');
    expect(eventIds).not.toContain('companionship-secret-history-0');
  });

  it('preserves private thread schedule history per companionship pair', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { compactChatPatchForCloud, limits } = __chatRuntimePersistenceForTests;
    const abHistory = ['candidate_created', 'opened', 'skipped', 'opened', 'skipped'].map((action, index) => companionshipEvent(`companionship-private-thread-ab-${index}`, 10 + index, {
      eventType: 'companionship_private_thread_schedule',
      actorId: 'a',
      targetId: 'b',
      participantIds: ['a', 'b'],
      action,
      dedupeKey: 'companionship-private-thread-chat-1-a-b',
    }));
    const acHistory = ['candidate_created', 'opened', 'skipped'].map((action, index) => companionshipEvent(`companionship-private-thread-ac-${index}`, 20 + index, {
      eventType: 'companionship_private_thread_schedule',
      actorId: 'a',
      targetId: 'c',
      participantIds: ['a', 'c'],
      action,
      dedupeKey: 'companionship-private-thread-chat-1-a-c',
    }));
    const recentEvents = Array.from({ length: limits.runtimeEventsV2 + 20 }, (_, index) => runtimeEvent(100 + index));
    const patch = compactChatPatchForCloud({
      runtimeEventsV2: [...abHistory, ...acHistory, ...recentEvents],
    });
    const eventIds = ((patch.runtimeEventsV2 || []) as RuntimeEventV2[]).map((event) => event.id);

    expect(eventIds).toEqual(expect.arrayContaining([
      'companionship-private-thread-ab-1',
      'companionship-private-thread-ab-2',
      'companionship-private-thread-ab-3',
      'companionship-private-thread-ab-4',
      'companionship-private-thread-ac-0',
      'companionship-private-thread-ac-1',
      'companionship-private-thread-ac-2',
    ]));
    expect(eventIds).not.toContain('companionship-private-thread-ab-0');
  });

  it('merges remote runtime windows without dropping local companionship state events', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { mergeChatRecord, mergeWorldRuntimeRecord } = __chatRuntimePersistenceForTests;
    const stateEvents = companionshipStateEvents();
    const remoteRecent = runtimeEvent(20);
    const local = chat({ updatedAt: 10, runtimeEventsV2: stateEvents, runtimeDetailLoaded: true });
    const remote = chat({ updatedAt: 20, runtimeEventsV2: [remoteRecent], runtimeDetailLoaded: true });
    const mergedDetail = mergeChatRecord(local, remote);
    const mergedWorld = mergeWorldRuntimeRecord(local, { ...remote, runtimeDetailLoaded: false, worldRuntimeLoaded: true });

    expect(mergedDetail.runtimeEventsV2?.map((event) => event.id)).toEqual([...stateEvents.map((event) => event.id), 'event-20']);
    expect(mergedWorld.runtimeEventsV2?.map((event) => event.id)).toEqual([...stateEvents.map((event) => event.id), 'event-20']);
  });

  it('keeps direct chats direct when summary patches omit type and member shape', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { mergeChatRecord } = __chatRuntimePersistenceForTests;
    const local = chat({
      type: 'direct',
      memberIds: ['user', 'char-1'],
      sourceChatId: 'chat-source',
      sourceMemberIds: ['char-1'],
      updatedAt: 10,
      lastMessageAt: 10,
    });
    const remote = chat({
      id: 'chat-1',
      updatedAt: 20,
      lastMessageAt: 20,
      topic: '新话题',
      memberIds: [],
      type: 'group',
    });

    const merged = mergeChatRecord(local, remote);

    expect(merged.type).toBe('direct');
    expect(merged.memberIds).toEqual(['user', 'char-1']);
    expect(merged.sourceChatId).toBe('chat-source');
    expect(merged.sourceMemberIds).toEqual(['char-1']);
    expect(merged.topic).toBe('新话题');
  });

  it('keeps bounded runtime fields in local persistence', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { buildPersistedChatState, limits } = __chatRuntimePersistenceForTests;
    const persisted = buildPersistedChatState({
      chats: [chat({
        layeredMemories: Array.from({ length: limits.layeredMemories + 2 }, (_, index) => memory(index)),
        runtimeTimeline: Array.from({ length: limits.runtimeTimeline + 2 }, (_, index) => ({ type: 'note', text: `timeline-${index}`, createdAt: index })),
        runtimeEventsV2: Array.from({ length: limits.runtimeEventsV2 + 2 }, (_, index) => runtimeEvent(index)),
        relationshipLedger: Array.from({ length: limits.relationshipLedger + 2 }, (_, index) => relationship(index)),
      })],
      currentChatId: 'chat-1',
      lastSyncedAt: 1,
      pendingOperations: [],
    });

    expect(persisted.chats[0].layeredMemories).toHaveLength(limits.layeredMemories);
    expect(persisted.chats[0].runtimeTimeline).toHaveLength(limits.runtimeTimeline);
    expect(persisted.chats[0].runtimeEventsV2).toHaveLength(limits.runtimeEventsV2);
    expect(persisted.chats[0].relationshipLedger).toHaveLength(limits.relationshipLedger);
    expect(persisted.chats[0].runtimeDetailLoaded).toBe(true);
  });

  it('strips inline data url media from chat runtime persistence and cloud patches', async () => {
    const { __chatRuntimePersistenceForTests } = await import('./useChatStore');
    const { buildPersistedChatState, compactChatPatchForCloud } = __chatRuntimePersistenceForTests;
    const dataUrl = `data:image/png;base64,${'a'.repeat(6000)}`;
    const event = runtimeEvent(1);
    event.payload = {
      artifactType: 'moment_text',
      media: [{
        url: dataUrl,
        thumbnailUrl: dataUrl,
        fullUrl: dataUrl,
        dataUrl,
        alt: '测试图片',
      }],
    };

    const persisted = buildPersistedChatState({
      chats: [chat({ runtimeEventsV2: [event] })],
      currentChatId: 'chat-1',
      lastSyncedAt: 1,
      pendingOperations: [],
    });
    const cloudPatch = compactChatPatchForCloud({ runtimeEventsV2: [event] });

    expect(JSON.stringify(persisted)).not.toContain('data:image/png;base64');
    expect(JSON.stringify(cloudPatch)).not.toContain('data:image/png;base64');
    expect(persisted.chats[0].runtimeEventsV2?.[0]?.payload).toMatchObject({
      artifactType: 'moment_text',
      media: [{ alt: '测试图片' }],
    });
  });
});
