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
import type { RelationshipLedgerEntry, RuntimeEventV2 } from '../types/runtimeEvent';
import type { Message } from '../types/message';
import type { MemoryItem } from '../services/memoryTypes';
import { storageKey } from '../constants/brand';

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
