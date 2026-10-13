import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConversation } from '../types/chat';
import type { AICharacter } from '../types/character';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CHARACTER_INTERVENTION, DEFAULT_CHARACTER_MEMORY, DEFAULT_PERSONALITY } from '../types/character';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { projectWorldAttentionCandidates, projectWorldAttentionStates, projectWorldCalendar, projectWorldCalendarItems, projectWorldMoments } from './worldRuntimeProjection';
import { retainRuntimeEvents } from './runtimeEventRetention';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

function character(id: string, name: string): AICharacter {
  return {
    id,
    name,
    avatar: '',
    personality: DEFAULT_PERSONALITY,
    behavior: DEFAULT_CHARACTER_BEHAVIOR,
    expertise: [],
    speakingStyle: '',
    background: '',
    relationships: [],
    memory: DEFAULT_CHARACTER_MEMORY,
    intervention: DEFAULT_CHARACTER_INTERVENTION,
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildChat(id: string, name: string, runtimeEventsV2: RuntimeEventV2[]) {
  return normalizeConversation({
    id,
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free' },
    name,
    topic: '',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    runtimeEventsV2,
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

describe('worldRuntimeProjection', () => {
  it('merges duplicate social outing candidates into one calendar item', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '先提议吃火锅',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: '吃火锅', activityType: '火锅', participantIds: ['a'], dedupeKey: 'outing-hg' },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 120,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '确认去吃火锅',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: '吃火锅', activityType: '火锅', participantIds: ['a', 'b'], dedupeKey: 'outing-hg' },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('confirmed');
    expect(items[0]?.participantNames).toEqual(['A', 'B']);
    expect(items[0]?.sourceRefs[0]?.eventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('filters calendar items by conversation id', () => {
    const chats = [
      buildChat('chat-1', '群聊一', [{
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '群聊一吃饭',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: '吃饭', activityType: '聚餐', participantIds: ['a', 'b'], dedupeKey: 'outing-1' },
      }]),
      buildChat('chat-2', '群聊二', [{
        id: 'evt-2',
        conversationId: 'chat-2',
        kind: 'artifact',
        createdAt: 110,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '群聊二唱歌',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: 'K歌', activityType: '唱歌', participantIds: ['a', 'b'], dedupeKey: 'outing-2' },
      }]),
    ];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')], { conversationId: 'chat-2' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('K歌');
    expect(items[0]?.sourceRefs[0]?.conversationId).toBe('chat-2');
  });

  it('applies calendar patch updates for participants, details, and cancellation', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '先去吃火锅',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: '吃火锅', activityType: '火锅', participantIds: ['a', 'b'], dedupeKey: 'outing-hg' },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 110,
        actorIds: ['a'],
        summary: 'C 也加入',
        visibility: 'derived_public',
        payload: { calendarItemId: 'outing-hg', addParticipantIds: ['c'], summary: 'A、B、C约火锅' },
      },
      {
        id: 'evt-3',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 120,
        actorIds: ['b'],
        summary: 'B不去了，改成K歌',
        visibility: 'derived_public',
        payload: { calendarItemId: 'outing-hg', removeParticipantIds: ['b'], title: 'K歌', activityType: '唱歌', timeHint: '明晚 20:00', locationHint: '静安寺', summary: '改去K歌' },
      },
      {
        id: 'evt-4',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 130,
        actorIds: ['a'],
        summary: '全部取消',
        visibility: 'derived_public',
        payload: { calendarItemId: 'outing-hg', cancelled: true, summary: '大家都不去了' },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B'), character('c', 'C')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('cancelled');
    expect(items[0]?.title).toBe('K歌');
    expect(items[0]?.activityType).toBe('唱歌');
    expect(items[0]?.participantNames).toEqual(['A', 'C']);
    expect(items[0]?.timeHint).toBe('明晚 20:00');
    expect(items[0]?.locationHint).toBe('静安寺');
    expect(items[0]?.summary).toBe('大家都不去了');
    const history: RuntimeEventV2[] = Array.from({ length: 300 }, (_, index) => ({
      id: `history-${index}`, conversationId: 'chat-1', kind: 'room_shift',
      createdAt: 1000 + index, visibility: 'public', summary: 'history', payload: {},
    }));
    const retained = retainRuntimeEvents([...(chats[0].runtimeEventsV2 || []), ...history], 120);
    expect(retained).toHaveLength(124);
    expect(projectWorldCalendarItems(
      [buildChat('chat-1', '群聊一', retained)],
      [character('a', 'A'), character('b', 'B'), character('c', 'C')],
    )).toEqual(items);
    expect(retainRuntimeEvents(retained, 0).map((event) => event.id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
  });

  it('projects participant states from outing events and patch updates', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        summary: '先约饭',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '约饭',
          participantIds: ['a', 'b'],
          participantStates: { a: 'going', b: 'invited' },
          dedupeKey: 'outing-state-1',
        },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 110,
        actorIds: ['a'],
        summary: 'B改为也去，C暂定',
        visibility: 'derived_public',
        payload: {
          calendarItemId: 'outing-state-1',
          addParticipantIds: ['c'],
          addParticipantStates: { b: 'going', c: 'maybe' },
        },
      },
      {
        id: 'evt-3',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 120,
        actorIds: ['a'],
        summary: 'A先撤了',
        visibility: 'derived_public',
        payload: {
          calendarItemId: 'outing-state-1',
          removeParticipantStateIds: ['a'],
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B'), character('c', 'C')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.participantIds).toEqual(['a', 'b', 'c']);
    expect(items[0]?.participantStates).toEqual({ b: 'going', c: 'maybe', a: 'mentioned' });
  });

  it('merges a realistic multi-turn outing flow from candidate, confirmation, reschedule, withdrawal, and rejoin hints', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-a-propose',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b', 'c'],
        summary: 'A 提议周五去茶馆',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '茶馆小聚',
          activityType: '茶馆',
          timeHint: '周五 20:00',
          locationHint: '后巷蓝布门帘茶馆',
          participantIds: ['a', 'b', 'c'],
          targetIds: ['b', 'c'],
          participantStates: { a: 'interested', b: 'invited', c: 'invited' },
          dedupeKey: 'outing-tea-flow',
        },
      },
      {
        id: 'evt-b-confirm',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 110,
        actorIds: ['b'],
        targetIds: ['a', 'c'],
        summary: 'B 确认要去',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '茶馆小聚',
          activityType: '茶馆',
          timeHint: '周五 20:00',
          locationHint: '后巷蓝布门帘茶馆',
          participantIds: ['b'],
          targetIds: ['a', 'c'],
          participantStates: { b: 'going' },
          dedupeKey: 'outing-tea-flow',
        },
      },
      {
        id: 'evt-c-reschedule',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 120,
        actorIds: ['c'],
        targetIds: ['a', 'b'],
        summary: 'C 提议改时间',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '茶馆小聚',
          activityType: '茶馆',
          timeHint: '周五 21:00',
          participantIds: ['c'],
          participantStates: { c: 'maybe' },
          dedupeKey: 'outing-tea-flow',
        },
      },
      {
        id: 'evt-a-place',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 130,
        actorIds: ['a'],
        targetIds: ['b', 'c'],
        summary: 'A 确认改时间并调整地点',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '茶馆小聚',
          activityType: '茶馆',
          timeHint: '周五 21:00',
          locationHint: '河边二楼包间',
          participantIds: ['a'],
          participantStates: { a: 'going' },
          dedupeKey: 'outing-tea-flow',
        },
      },
      {
        id: 'evt-b-decline',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 140,
        actorIds: ['b'],
        targetIds: [],
        summary: 'B 不去了',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '茶馆小聚',
          participantIds: ['b'],
          participantStates: { b: 'declined' },
          dedupeKey: 'outing-tea-flow',
        },
      },
      {
        id: 'evt-c-withdraw',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 150,
        actorIds: ['c'],
        targetIds: [],
        summary: 'C 也不去了',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '茶馆小聚',
          participantIds: ['c'],
          participantStates: { c: 'withdrawn' },
          dedupeKey: 'outing-tea-flow',
        },
      },
      {
        id: 'evt-d-going',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 160,
        actorIds: ['d'],
        targetIds: ['a'],
        summary: 'D 要去',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '茶馆小聚',
          participantIds: ['d'],
          participantStates: { d: 'going' },
          dedupeKey: 'outing-tea-flow',
        },
      },
      {
        id: 'evt-b-rejoin',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 170,
        actorIds: ['b'],
        targetIds: ['a', 'd'],
        summary: 'B 又想去了',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '茶馆小聚',
          participantIds: ['b'],
          participantStates: { b: 'going' },
          dedupeKey: 'outing-tea-flow',
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B'), character('c', 'C'), character('d', 'D')]);

    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('confirmed');
    expect(items[0]?.title).toBe('茶馆小聚');
    expect(items[0]?.timeHint).toBe('周五 21:00');
    expect(items[0]?.locationHint).toBe('河边二楼包间');
    expect(items[0]?.participantIds).toEqual(['a', 'b', 'c', 'd']);
    expect(items[0]?.participantNames).toEqual(['A', 'B', 'C', 'D']);
    expect(items[0]?.participantStates).toEqual({
      a: 'going',
      b: 'going',
      c: 'withdrawn',
      d: 'going',
    });
  });

  it('derives participant ids from participantStates when patch only provides states', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 100,
        actorIds: ['a'],
        summary: '先发一个状态补丁',
        visibility: 'derived_public',
        payload: {
          calendarItemId: 'outing-state-2',
          participantStates: { a: 'going', user: 'invited' },
          title: '周末活动',
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.participantIds).toEqual(['a', 'user']);
    expect(items[0]?.participantNames).toEqual(['A', '我']);
    expect(items[0]?.participantStates).toEqual({ a: 'going', user: 'invited' });
  });

  it('drops invalid endAt and non-positive durationMinutes in calendar patch', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 100,
        actorIds: ['a'],
        summary: '先创建',
        visibility: 'derived_public',
        payload: {
          calendarItemId: 'outing-time-1',
          title: '夜宵局',
          startAt: 1800000000000,
          endAt: 1800003600000,
          durationMinutes: 60,
        },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 110,
        actorIds: ['a'],
        summary: '错误时间补丁',
        visibility: 'derived_public',
        payload: {
          calendarItemId: 'outing-time-1',
          startAt: 1800007200000,
          endAt: 1800003600000,
          durationMinutes: -20,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.startAt).toBe(1800007200000);
    expect(items[0]?.endAt).toBeNull();
    expect(items[0]?.durationMinutes).toBeNull();
  });

  it('includes user participant when social outing targetIds include user', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '甲想约用户吃饭',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '约饭',
          activityType: '聚餐',
          participantIds: ['a'],
          targetIds: ['user'],
          dedupeKey: 'outing-user-1',
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.participantIds).toContain('user');
    expect(items[0]?.participantNames).toContain('我');
  });

  it('keeps calendar item source refs when one source conversation is deleted', () => {
    const groupChat = buildChat('group-1', '群聊一', [{
      id: 'evt-1',
      conversationId: 'group-1',
      kind: 'artifact',
      createdAt: 100,
      actorIds: ['a'],
      targetIds: ['b'],
      summary: '群里约了吃饭',
      visibility: 'derived_public',
      payload: { eventKind: 'social_outing', title: '吃饭', activityType: '聚餐', participantIds: ['a', 'b'], dedupeKey: 'outing-1' },
    }]);
    const deletedDm = {
      ...buildChat('dm-1', '私聊一', [{
        id: 'evt-2',
        conversationId: 'dm-1',
        kind: 'calendar_item_patch',
        createdAt: 120,
        actorIds: ['a'],
        summary: '私聊里改了时间',
        visibility: 'derived_public',
        payload: { calendarItemId: 'outing-1', timeHint: '周六 19:00', summary: '改成周六晚' },
      }]),
      deletedAt: Date.now(),
    };
    const items = projectWorldCalendarItems([groupChat, deletedDm], [character('a', 'A'), character('b', 'B')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.timeHint).toBe('周六 19:00');
    expect(items[0]?.sourceRefs.map((item) => item.conversationId).sort()).toEqual(['dm-1', 'group-1']);
    const deletedSource = items[0]?.sourceRefs.find((item) => item.conversationId === 'dm-1');
    expect(deletedSource?.sourceDeleted).toBe(true);
    expect(deletedSource?.conversationName).toContain('来源已删除');
  });

  it('keeps moment source refs from deleted conversations and marks deleted source name', () => {
    const live = buildChat('group-1', '群聊一', [{
      id: 'evt-1',
      conversationId: 'group-1',
      kind: 'event_candidate',
      createdAt: 100,
      actorIds: ['a'],
      summary: '候选动态',
      visibility: 'derived_public',
      payload: { eventKind: 'post_moment', dedupeKey: 'moment-1', title: '朋友圈' },
    }]);
    const deletedDm = {
      ...buildChat('dm-1', '私聊一', [{
        id: 'evt-2',
        conversationId: 'dm-1',
        kind: 'artifact',
        createdAt: 120,
        actorIds: ['a'],
        summary: '落地动态',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', artifactType: 'moment_text', dedupeKey: 'moment-1', text: '今天心情不错。', title: '朋友圈' },
      }]),
      deletedAt: Date.now(),
    };
    const moments = projectWorldMoments([live, deletedDm], [character('a', 'A')]);
    expect(moments).toHaveLength(1);
    expect(moments[0]?.sourceRefs.map((item) => item.conversationId).sort()).toEqual(['dm-1', 'group-1']);
    expect(moments[0]?.sourceRefs.find((item) => item.conversationId === 'dm-1')?.conversationName).toContain('来源已删除');
  });

  it('keeps multi-conversation-bound item visible when filtering by source conversation', () => {
    const chats = [
      buildChat('group-1', '群聊', [{
        id: 'evt-1',
        conversationId: 'group-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '群里约了吃火锅',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: '吃火锅', activityType: '火锅', participantIds: ['a', 'b'], dedupeKey: 'outing-hg' },
      }]),
      buildChat('dm-a-b', 'A与B私聊', [{
        id: 'evt-2',
        conversationId: 'dm-a-b',
        kind: 'calendar_item_patch',
        createdAt: 120,
        actorIds: ['a'],
        summary: '私聊里改了时间',
        visibility: 'derived_public',
        payload: { calendarItemId: 'outing-hg', timeHint: '周六晚', summary: '改为周六晚' },
      }]),
    ];
    const groupScoped = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')], { conversationId: 'group-1' });
    const dmScoped = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')], { conversationId: 'dm-a-b' });
    expect(groupScoped).toHaveLength(1);
    expect(dmScoped).toHaveLength(1);
    expect(groupScoped[0]?.timeHint).toBe('周六晚');
    expect(dmScoped[0]?.timeHint).toBe('周六晚');
  });

  it('projects travel and reminder calendar item kinds', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['a'],
        summary: '上海到杭州路程2小时',
        visibility: 'derived_public',
        payload: { eventKind: 'travel_plan', title: '前往杭州', activityType: '出行', participantIds: ['a'], dedupeKey: 'travel-a-hz', timeHint: '18:00-20:00' },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 110,
        actorIds: ['a'],
        summary: '出发前提醒',
        visibility: 'derived_public',
        payload: { calendarItemId: 'reminder-hg', kind: 'reminder', title: '出发提醒', participantIds: ['a'], timeHint: '17:30', summary: '提前30分钟出门' },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A')]);
    const travel = items.find((item) => item.id === 'travel-a-hz');
    const reminder = items.find((item) => item.id === 'reminder-hg');
    expect(travel?.kind).toBe('travel');
    expect(reminder?.kind).toBe('reminder');
    expect(reminder?.title).toBe('出发提醒');
  });

  it('projects structured schedule fields and patch updates', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '安排火锅',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '吃火锅',
          activityType: '火锅',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-hg',
          startAt: 1800000000000,
          durationMinutes: 120,
        },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 120,
        actorIds: ['a'],
        summary: '改时间并补结束时间',
        visibility: 'derived_public',
        payload: {
          calendarItemId: 'outing-hg',
          startAt: 1800003600000,
          endAt: 1800010800000,
          durationMinutes: 90,
        },
      },
      {
        id: 'evt-3',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 130,
        actorIds: ['a'],
        summary: '清除结束时间',
        visibility: 'derived_public',
        payload: {
          calendarItemId: 'outing-hg',
          clearEndAt: true,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.startAt).toBe(1800003600000);
    expect(items[0]?.endAt).toBeNull();
    expect(items[0]?.durationMinutes).toBe(90);
  });

  it('estimates activity duration when durationMinutes is missing', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '明晚吃火锅',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '吃火锅',
          activityType: '火锅',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-hg',
          startAt: 1800000000000,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')]);
    const activity = items.find((item) => item.id === 'outing-hg');
    expect(activity?.durationMinutes).toBe(120);
    expect(activity?.endAt).toBe(1800007200000);
  });

  it('auto-creates travel item before activity for cross-city participants', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '去杭州吃火锅',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '杭州火锅局',
          activityType: '火锅',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-hz',
          startAt: 1800000000000,
          destinationCity: '杭州',
          locationHint: '杭州西湖',
          participantOrigins: {
            a: '上海',
            b: '杭州',
          },
          travelDurationMinutes: 120,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')]);
    const travel = items.find((item) => item.id === 'outing-hz::travel');
    const activity = items.find((item) => item.id === 'outing-hz');
    expect(activity).toBeTruthy();
    expect(travel?.kind).toBe('travel');
    expect(travel?.participantIds).toEqual(['a']);
    expect(travel?.startAt).toBe(1799992800000);
    expect(travel?.endAt).toBe(1800000000000);
    expect(travel?.locationHint).toContain('杭州');
  });

  it('auto-creates preparation and rest items around activity', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '周末聚餐',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '周末聚餐',
          activityType: '聚餐',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-dinner',
          startAt: 1800000000000,
          durationMinutes: 120,
          autoPreparationRest: true,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')]);
    const prep = items.find((item) => item.id === 'outing-dinner::prep');
    const rest = items.find((item) => item.id === 'outing-dinner::rest');
    expect(prep?.kind).toBe('preparation');
    expect(prep?.startAt).toBe(1799998200000);
    expect(prep?.endAt).toBe(1800000000000);
    expect(rest?.kind).toBe('rest');
    expect(rest?.startAt).toBe(1800007200000);
    expect(rest?.endAt).toBe(1800008640000);
  });

  it('can disable automatic preparation/rest occupancy derivation', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '周末聚餐',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '周末聚餐',
          activityType: '聚餐',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-dinner',
          startAt: 1800000000000,
          durationMinutes: 120,
          autoPreparationRest: false,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')]);
    expect(items.some((item) => item.id === 'outing-dinner::prep')).toBe(false);
    expect(items.some((item) => item.id === 'outing-dinner::rest')).toBe(false);
  });

  it('chains travel->preparation->activity->rest occupancy for cross-city participants when explicitly enabled', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '去杭州参加线下活动',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '杭州活动',
          activityType: '线下活动',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-hz-chain',
          startAt: 1800000000000,
          durationMinutes: 120,
          destinationCity: '杭州',
          locationHint: '杭州西湖',
          participantOrigins: {
            a: '上海',
            b: '杭州',
          },
          travelDurationMinutes: 120,
          preparationDurationMinutes: 30,
          restDurationMinutes: 30,
          autoPreparationRest: true,
          autoPreparationRestAfterTravel: true,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')]);
    const travel = items.find((item) => item.id === 'outing-hz-chain::travel');
    const prep = items.find((item) => item.id === 'outing-hz-chain::prep');
    const activity = items.find((item) => item.id === 'outing-hz-chain');
    const rest = items.find((item) => item.id === 'outing-hz-chain::rest');
    expect(travel?.kind).toBe('travel');
    expect(travel?.startAt).toBe(1799992800000);
    expect(travel?.endAt).toBe(1800000000000);
    expect(prep?.kind).toBe('preparation');
    expect(prep?.startAt).toBe(1800000000000);
    expect(prep?.endAt).toBe(1800001800000);
    expect(activity?.startAt).toBe(1800000000000);
    expect(activity?.endAt).toBe(1800007200000);
    expect(rest?.kind).toBe('rest');
    expect(rest?.startAt).toBe(1800009000000);
    expect(rest?.endAt).toBe(1800010800000);
    expect(prep?.participantIds).toEqual(['a', 'b']);
    expect(rest?.participantIds).toEqual(['a', 'b']);
  });

  it('detects participant time conflicts and suggests delay minutes', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '火锅局',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '吃火锅',
          activityType: '火锅',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-1',
          startAt: 1800000000000,
          durationMinutes: 120,
        },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 110,
        actorIds: ['a'],
        targetIds: ['c'],
        summary: 'K歌局',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '去K歌',
          activityType: 'K歌',
          participantIds: ['a', 'c'],
          dedupeKey: 'outing-2',
          startAt: 1800003600000,
          durationMinutes: 120,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B'), character('c', 'C')]);
    const first = items.find((item) => item.id === 'outing-1');
    const second = items.find((item) => item.id === 'outing-2');
    expect(first?.conflict?.hasConflict).toBe(true);
    expect(second?.conflict?.hasConflict).toBe(true);
    expect(first?.conflict?.participantIds).toEqual(['a']);
    expect(first?.conflict?.conflictWithItemIds).toContain('outing-2');
    expect(second?.conflict?.conflictWithItemIds).toContain('outing-1');
    expect(first?.conflict?.suggestedDelayMinutes).toBe(75);
    const suggestion = first?.conflict?.resolutionSuggestions?.find((item) => item.itemId === 'outing-2');
    expect(suggestion?.strategy).toBe('delay_after_conflict');
    expect(suggestion?.basedOnItemId).toBe('outing-1');
    expect(suggestion?.delayMinutes).toBe(75);
    expect(suggestion?.suggestedStartAt).toBe(1800008100000);
    const patchDraft = first?.conflict?.patchDrafts?.find((item) => item.calendarItemId === 'outing-2');
    expect(patchDraft?.eventType).toBe('calendar_item_patch');
    expect(patchDraft?.patch.startAt).toBe(1800008100000);
    expect(patchDraft?.basedOnItemId).toBe('outing-1');
  });

  it('builds chained patch drafts for travel/prep/activity/rest when late item is chain-root', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-a',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '早场活动',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '早场活动',
          activityType: '活动',
          participantIds: ['a'],
          dedupeKey: 'event-a',
          startAt: 1800000000000,
          durationMinutes: 120,
        },
      },
      {
        id: 'evt-chain',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 110,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '跨城活动',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '跨城活动',
          activityType: '活动',
          participantIds: ['a', 'b'],
          dedupeKey: 'event-chain',
          startAt: 1800003600000,
          durationMinutes: 120,
          destinationCity: '杭州',
          locationHint: '杭州西湖',
          participantOrigins: { a: '上海', b: '杭州' },
          travelDurationMinutes: 120,
          preparationDurationMinutes: 30,
          restDurationMinutes: 30,
          autoPreparationRest: true,
          autoPreparationRestAfterTravel: true,
        },
      },
    ])];
    const projected = projectWorldCalendar(chats, [character('a', 'A'), character('b', 'B')]);
    const draftIds = projected.patchDraftQueue
      .filter((draft) => draft.basedOnItemId === 'event-a')
      .map((draft) => draft.calendarItemId)
      .sort();
    expect(draftIds).toEqual(['event-chain', 'event-chain::prep', 'event-chain::rest', 'event-chain::travel']);
  });

  it('skips conflict linking when shared participant is in inactive schedule state', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '火锅局',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '吃火锅',
          activityType: '火锅',
          participantIds: ['a', 'b'],
          participantStates: { a: 'going', b: 'going' },
          dedupeKey: 'outing-state-conflict-1',
          startAt: 1800000000000,
          durationMinutes: 120,
        },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 110,
        actorIds: ['a'],
        targetIds: ['c'],
        summary: 'K歌局',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '去K歌',
          activityType: 'K歌',
          participantIds: ['a', 'c'],
          participantStates: { a: 'declined', c: 'going' },
          dedupeKey: 'outing-state-conflict-2',
          startAt: 1800003600000,
          durationMinutes: 120,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B'), character('c', 'C')]);
    const first = items.find((item) => item.id === 'outing-state-conflict-1');
    const second = items.find((item) => item.id === 'outing-state-conflict-2');
    expect(first?.conflict).toBeNull();
    expect(second?.conflict).toBeNull();
  });

  it('builds multi-conflict chain suggestions without duplicate patch drafts', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-a',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'A局',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: 'A局', activityType: '活动', participantIds: ['a'], dedupeKey: 'event-a', startAt: 1800000000000, durationMinutes: 60 },
      },
      {
        id: 'evt-b',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 101,
        actorIds: ['a'],
        targetIds: ['c'],
        summary: 'B局',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: 'B局', activityType: '活动', participantIds: ['a'], dedupeKey: 'event-b', startAt: 1800001800000, durationMinutes: 60 },
      },
      {
        id: 'evt-c',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 102,
        actorIds: ['a'],
        targetIds: ['d'],
        summary: 'C局',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: 'C局', activityType: '活动', participantIds: ['a'], dedupeKey: 'event-c', startAt: 1800003600000, durationMinutes: 60 },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B'), character('c', 'C'), character('d', 'D')]);
    const eventA = items.find((item) => item.id === 'event-a');
    const eventB = items.find((item) => item.id === 'event-b');
    expect(eventA?.conflict?.patchDrafts?.some((draft) => draft.calendarItemId === 'event-b')).toBe(true);
    expect(eventB?.conflict?.patchDrafts?.some((draft) => draft.calendarItemId === 'event-c')).toBe(true);
    const allDraftKeys = (eventB?.conflict?.patchDrafts || []).map((draft) => `${draft.calendarItemId}:${draft.basedOnItemId}`);
    expect(new Set(allDraftKeys).size).toBe(allDraftKeys.length);
  });

  it('builds global patch draft queue with deterministic order', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-a',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'A局',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: 'A局', activityType: '活动', participantIds: ['a'], dedupeKey: 'event-a', startAt: 1800000000000, durationMinutes: 60 },
      },
      {
        id: 'evt-b',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 101,
        actorIds: ['a'],
        targetIds: ['c'],
        summary: 'B局',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: 'B局', activityType: '活动', participantIds: ['a'], dedupeKey: 'event-b', startAt: 1800001800000, durationMinutes: 60 },
      },
      {
        id: 'evt-c',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 102,
        actorIds: ['a'],
        targetIds: ['d'],
        summary: 'C局',
        visibility: 'derived_public',
        payload: { eventKind: 'social_outing', title: 'C局', activityType: '活动', participantIds: ['a'], dedupeKey: 'event-c', startAt: 1800003600000, durationMinutes: 60 },
      },
    ])];
    const projection = projectWorldCalendar(chats, [character('a', 'A'), character('b', 'B'), character('c', 'C'), character('d', 'D')]);
    const keys = projection.patchDraftQueue.map((draft) => `${draft.calendarItemId}:${draft.basedOnItemId}`);
    expect(keys).toEqual(['event-b:event-a', 'event-c:event-b']);
    expect(projection.patchDraftQueue[0]?.patch.startAt).toBe(1800004500000);
    expect(projection.patchDraftQueue[1]?.patch.startAt).toBe(1800006300000);
  });

  it('projects published moment artifacts and merges candidate source refs with the same dedupe key', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'A 想发朋友圈',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', dedupeKey: 'moment-1', title: '夜宵局', text: '先记一下今晚夜宵', expectedArtifacts: ['moment_text'] },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 120,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'A 发出了朋友圈',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', artifactType: 'moment_text', dedupeKey: 'moment-1', title: '夜宵局', text: '夜宵结束，今天很开心', expectedArtifacts: ['moment_text'] },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A'), character('b', 'B')]);
    expect(moments).toHaveLength(1);
    expect(moments[0]?.id).toBe('evt-2');
    expect(moments[0]?.text).toContain('夜宵结束');
    expect(moments[0]?.text).not.toContain('想发朋友圈');
    expect(moments[0]?.sourceRefs[0]?.eventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('does not expose pending moment candidates as published feed posts', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'A 提议发布一条 post_moment 动态',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', dedupeKey: 'moment-1', title: '朋友圈', text: '先记一下今晚夜宵', expectedArtifacts: ['moment_text'] },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A'), character('b', 'B')]);
    expect(moments).toHaveLength(0);
  });

  it('can expose pending moment candidates for developer debugging', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'A 提议发布一条 post_moment 动态',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', dedupeKey: 'moment-debug-1', title: '朋友圈', seedIntent: '想发一条更内心化的动态。', expectedArtifacts: ['moment_text'] },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A'), character('b', 'B')], { includeCandidates: true });
    expect(moments).toHaveLength(1);
    expect(moments[0]?.debugState).toBe('candidate');
    expect(moments[0]?.text).toContain('内心化');
  });

  it('hides legacy record-style moment artifacts from the normal feed', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-legacy',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        summary: 'A 发了一条动态：带着点情绪地记录了刚才的事',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', artifactType: 'moment_text', dedupeKey: 'moment-legacy-1', text: 'A 发了一条动态：带着点情绪地记录了刚才的事' },
      },
    ])];
    expect(projectWorldMoments(chats, [character('a', 'A')])).toHaveLength(0);
  });

  it('uses public summary text for private-visibility moments', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-private',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 130,
        actorIds: ['a'],
        summary: '私域动态完成',
        visibility: 'pair_private',
        payload: {
          eventKind: 'post_moment',
          artifactType: 'moment_text',
          dedupeKey: 'moment-private-1',
          title: '朋友圈',
          text: '这是私聊正文，不应公开显示。',
          publicSummary: '和朋友聊完后，心情更轻松了。',
        },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A')]);
    expect(moments).toHaveLength(1);
    expect(moments[0]?.text).toBe('和朋友聊完后，心情更轻松了。');
    expect(moments[0]?.text).not.toContain('私聊正文');
  });

  it('uses generated moment text instead of public summary for public moments', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-public',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 130,
        actorIds: ['a'],
        summary: 'A 发了一条动态，写下了当下的内心感受。',
        visibility: 'derived_public',
        payload: {
          eventKind: 'post_moment',
          artifactType: 'moment_text',
          dedupeKey: 'moment-public-1',
          title: '朋友圈',
          text: '有些话当场说出来就变味了。先放在这里，等风过去再看。',
          publicSummary: 'A 发了一条动态，写下了当下的内心感受。',
        },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A')]);
    expect(moments).toHaveLength(1);
    expect(moments[0]?.text).toContain('先放在这里');
    expect(moments[0]?.text).not.toContain('发了一条动态');
  });

  it('projects moment media from artifact payload', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-media',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 140,
        actorIds: ['a'],
        summary: 'A 发了图文朋友圈',
        visibility: 'derived_public',
        payload: {
          eventKind: 'post_moment',
          artifactType: 'moment_text',
          dedupeKey: 'moment-media-1',
          text: '今天的光线、气氛和人都刚刚好。',
          media: [{ assetId: 'asset-1', thumbnailAssetId: 'thumb-1', thumbnailUrl: 'local-thumb', fullUrl: 'local-full', mimeType: 'image/webp', sizeBytes: 120000, storage: 'local_indexeddb', alt: '合影' }],
        },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A')]);
    expect(moments[0]?.media[0]?.assetId).toBe('asset-1');
    expect(moments[0]?.media[0]?.thumbnailAssetId).toBe('thumb-1');
    expect(moments[0]?.media[0]?.url).toBe('local-thumb');
    expect(moments[0]?.media[0]?.fullUrl).toBe('local-full');
    expect(moments[0]?.media[0]?.sizeBytes).toBe(120000);
    expect(moments[0]?.media[0]?.storage).toBe('local_indexeddb');
  });

  it('dedupes identical public summary and event summary in moment debug evidence', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-debug',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 150,
        actorIds: ['a'],
        summary: 'A 发了一条动态，写下了当下的内心感受。',
        visibility: 'derived_public',
        payload: {
          eventKind: 'post_moment',
          artifactType: 'moment_text',
          dedupeKey: 'moment-debug-2',
          text: '有些话当场说出来就变味了。',
          publicSummary: 'A 发了一条动态，写下了当下的内心感受。',
        },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A')]);
    const duplicateRows = moments[0]?.debugEvidence.filter((row) => row.includes('A 发了一条动态')) || [];
    expect(duplicateRows).toHaveLength(1);
  });

  it('aggregates moment source refs across conversations when dedupe key matches', () => {
    const chats = [
      buildChat('group-1', '群聊一', [{
        id: 'evt-1',
        conversationId: 'group-1',
        kind: 'event_candidate',
        createdAt: 100,
        actorIds: ['a'],
        summary: '候选动态',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', dedupeKey: 'moment-a-1', expectedArtifacts: ['moment_text'], title: '朋友圈' },
      }]),
      buildChat('dm-1', '私聊一', [{
        id: 'evt-2',
        conversationId: 'dm-1',
        kind: 'artifact',
        createdAt: 120,
        actorIds: ['a'],
        summary: '落地动态',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', artifactType: 'moment_text', dedupeKey: 'moment-a-1', text: '今天这顿不错。', title: '朋友圈' },
      }]),
    ];
    const moments = projectWorldMoments(chats, [character('a', 'A')]);
    expect(moments).toHaveLength(1);
    expect(moments[0]?.id).toBe('evt-2');
    expect(moments[0]?.sourceRefs).toHaveLength(2);
    expect(moments[0]?.sourceRefs.map((item) => item.conversationId).sort()).toEqual(['dm-1', 'group-1']);
    expect(moments[0]?.sourceRefs.find((item) => item.conversationId === 'group-1')?.eventIds).toEqual(['evt-1']);
    expect(moments[0]?.sourceRefs.find((item) => item.conversationId === 'dm-1')?.eventIds).toEqual(['evt-2']);
  });

  it('projects attention candidates from runtime events', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: 180,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'A 在等 B 回应',
        visibility: 'derived_public',
        payload: { reason: '用户点名后仍未回应', confidence: 0.82, targetIds: ['b'] },
      },
    ])];
    const attention = projectWorldAttentionCandidates(chats, [character('a', 'A'), character('b', 'B')]);
    expect(attention).toHaveLength(1);
    expect(attention[0]?.actorName).toBe('A');
    expect(attention[0]?.actorRef).toEqual({ kind: 'ai_character', id: 'a' });
    expect(attention[0]?.targetNames).toEqual(['B']);
    expect(attention[0]?.targetRefs).toEqual([{ kind: 'ai_character', id: 'b' }]);
    expect(attention[0]?.confidence).toBe(0.82);
  });

  it('degrades unknown actor ids to generic member labels in projections', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'att-1',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: 180,
        actorIds: ['unknown-actor'],
        targetIds: ['unknown-target'],
        summary: '未知成员待回应',
        visibility: 'derived_public',
        payload: { reason: 'unknown id test', confidence: 0.5, targetIds: ['unknown-target'] },
      },
    ])];
    const attention = projectWorldAttentionCandidates(chats, [character('a', 'A'), character('b', 'B')]);
    expect(attention).toHaveLength(1);
    expect(attention[0]?.actorName).toBe('成员');
    expect(attention[0]?.targetNames).toEqual(['成员']);
    expect(attention[0]?.actorRef).toEqual({ kind: 'system_agent', id: 'unknown-actor' });
    expect(attention[0]?.targetRefs).toEqual([{ kind: 'system_agent', id: 'unknown-target' }]);
  });

  it.each([
    ['status_update', 'status_note'],
    ['check_in', 'check_in_note'],
    ['react_to_moment', 'moment_reaction_note'],
  ])('keeps tentative %s out of published moments', (eventKind, artifactType) => {
    const chats = [buildChat('chat-1', '群聊一', [{
      id: 'intent-1', conversationId: 'chat-1', kind: 'artifact', createdAt: 200,
      actorIds: ['a'], targetIds: ['user'], visibility: 'derived_public', summary: '待定意图',
      payload: { eventKind, artifactType, status: 'tentative', seedIntent: '想问问近况', text: '待定意图' },
    }])];
    expect(projectWorldMoments(chats, [character('a', 'A')])).toEqual([]);
    expect(projectWorldMoments(chats, [character('a', 'A')], { includeCandidates: true }))
      .toMatchObject([{ debugState: 'candidate' }]);
  });

  it('projects check_in and react_to_moment as world moments', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-checkin',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 200,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'A 给用户发了问候',
        visibility: 'derived_public',
        payload: { eventKind: 'check_in', artifactType: 'check_in_note', text: '最近怎么样？', title: '问候跟进' },
      },
      {
        id: 'evt-react',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 210,
        actorIds: ['b'],
        targetIds: ['user'],
        summary: 'B 回应了刚刚的动态',
        visibility: 'derived_public',
        payload: { eventKind: 'react_to_moment', artifactType: 'moment_reaction_note', text: '这条动态我也有同感。', title: '动态回应' },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A'), character('b', 'B')]);
    expect(moments.map((item) => item.kind)).toEqual(['react_to_moment', 'check_in']);
    expect(moments[0]?.title).toBe('动态回应');
    expect(moments[1]?.title).toBe('问候跟进');
  });

  it('projects attention states with relationship and restraint signals', () => {
    const chats = [normalizeConversation({
      ...buildChat('chat-1', '群聊一', [
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: 180,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: 'A 想跟进用户',
          visibility: 'derived_public',
          payload: { reason: '用户点名后仍未回应', confidence: 0.86, targetIds: ['user'] },
        },
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 7, trust: 6, competence: 4, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 170,
      }],
    })];
    const states = projectWorldAttentionStates(chats, [character('a', 'A')], { now: 200 });
    expect(states).toHaveLength(1);
    expect(states[0]?.actorName).toBe('A');
    expect(states[0]?.actorRef).toEqual({ kind: 'ai_character', id: 'a' });
    expect(states[0]?.targetName).toBe('我');
    expect(states[0]?.targetRef).toEqual({ kind: 'user_persona', id: 'user' });
    expect(states[0]?.attentionScore).toBeGreaterThan(0.7);
    expect(states[0]?.restraint).toBeLessThan(0.65);
    expect(states[0]?.suggestedActions).toContain('private_message');
    expect(states[0]?.suggestedActions).toContain('invite_activity');
    expect(states[0]?.suggestedActions).toContain('calendar_reminder');
    expect(states[0]?.suggestedActions).toContain('comfort');
    expect(states[0]?.suggestedActions).toContain('share_moment');
  });

  it('raises restraint in quiet hours or after recent private touches', () => {
    const now = new Date('2026-05-30T00:30:00+08:00').getTime();
    const chats = [normalizeConversation({
      ...buildChat('chat-1', '群聊一', [
        {
          id: 'att-1',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          createdAt: now - 20 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: 'A 想继续跟进',
          visibility: 'derived_public',
          payload: { reason: '用户刚被点名', confidence: 0.8, targetIds: ['user'] },
        },
        {
          id: 'evt-private-1',
          conversationId: 'chat-1',
          kind: 'event_candidate',
          createdAt: now - 30 * 60_000,
          actorIds: ['a'],
          targetIds: ['user'],
          summary: 'A 刚私聊过用户',
          visibility: 'derived_public',
          payload: {
            eventKind: 'pair_private_thread',
            initiatorId: 'a',
            participantIds: ['a', 'user'],
            targetIds: ['user'],
            reasonType: 'attention_followup',
            confidence: 0.8,
            urgency: 'soon',
            seedIntent: '继续跟进',
            visibilityPlan: 'user_private',
          },
        },
      ]),
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 5, trust: 4, competence: 3, threat: 1 },
        trend: 'flat',
        recentEvents: [],
        lastUpdatedAt: now - 25 * 60_000,
      }],
    })];
    const states = projectWorldAttentionStates(chats, [character('a', 'A')], { now });
    expect(states).toHaveLength(1);
    expect(states[0]?.restraint).toBeGreaterThan(0.7);
    expect(states[0]?.reasons.join(' / ')).toContain('夜间时段');
    expect(states[0]?.reasons.join(' / ')).toContain('最近已有私域触达');
  });

  it('derives in-progress and completed statuses from schedule window', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '进行中的活动',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '午餐会',
          activityType: '聚餐',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-in-progress',
          startAt: 1800000000000,
          endAt: 1800003600000,
        },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 110,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '已经结束的活动',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          title: '昨晚电影',
          activityType: '电影',
          participantIds: ['a', 'b'],
          dedupeKey: 'outing-completed',
          startAt: 1799990000000,
          endAt: 1799997200000,
        },
      },
    ])];
    const items = projectWorldCalendarItems(chats, [character('a', 'A'), character('b', 'B')], { now: 1800001200000 });
    expect(items.find((item) => item.id === 'outing-in-progress')?.status).toBe('in_progress');
    expect(items.find((item) => item.id === 'outing-completed')?.status).toBe('completed');
  });

  it('accumulates source weights for repeated moment evidence under same dedupe key', () => {
    const chats = [buildChat('chat-1', '群聊一', [
      {
        id: 'evt-1',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 100,
        actorIds: ['a'],
        summary: '候选',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', dedupeKey: 'moment-weight-1', title: '朋友圈' },
      },
      {
        id: 'evt-2',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 120,
        actorIds: ['a'],
        summary: '落地',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', artifactType: 'moment_text', dedupeKey: 'moment-weight-1', text: '今天不错', title: '朋友圈' },
      },
      {
        id: 'evt-3',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 140,
        actorIds: ['a'],
        summary: '补充',
        visibility: 'derived_public',
        payload: { eventKind: 'post_moment', artifactType: 'moment_text', dedupeKey: 'moment-weight-1', text: '再补充一句', title: '朋友圈' },
      },
    ])];
    const moments = projectWorldMoments(chats, [character('a', 'A')]);
    expect(moments).toHaveLength(1);
    const source = moments[0]?.sourceRefs.find((item) => item.conversationId === 'chat-1');
    expect(source?.eventIds).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect((source?.weight || 0)).toBeGreaterThan(1);
  });
});
