import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import type { AICharacter } from '../types/character';
import { normalizeConversation, type DriverMessageCommitTransition } from '../types/chat';
import { projectWorldCalendar } from './worldRuntimeProjection';
import { applyPresenceUpdateToTransition, buildPresencePatchFromMessage, isCharacterAvailableForScheduling } from './characterPresence';

function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'a',
    senderName: '甲',
    content: '我先去睡了。',
    emotion: 0,
    timestamp: 1,
    isDeleted: false,
    ...patch,
  };
}

describe('characterPresence', () => {
  const chat = normalizeConversation({ id: 'chat-1', memberIds: ['a', 'b'], mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free' }, name: '群聊', topic: '', style: 'free', speed: 1, isActive: false,
    allowIntervention: true, topicSeed: '', createdAt: 1, updatedAt: 1, lastMessageAt: 1 });
  const transition = { chatPatch: {}, characterPatches: [], runtimeEvents: [] };

  it.each(['new', 'baseline', 'legacy'] as const)('preserves the %s event delta contract when adding a calendar activity', (kind) => {
    const existing = {
      id: 'existing', conversationId: chat.id, kind: 'message_generated' as const,
      createdAt: 1, summary: 'existing', payload: {},
    };
    const source = { ...chat, runtimeEventsV2: [existing] };
    const input: DriverMessageCommitTransition = {
      ...transition,
      ...(kind === 'new' ? {} : { chatRuntimeDelta: { runtimeEventsV2: {
        orderedIds: [existing.id], upserts: [],
        ...(kind === 'baseline' ? { baseIds: ['original-baseline'] } : {}),
      } } }),
    };
    const result = applyPresenceUpdateToTransition({ chat: source, transition: input, now: 1000,
      message: message({ metadata: { presenceUpdate: { status: 'away' } } }),
    });
    expect(result.chatRuntimeDelta?.runtimeEventsV2?.baseIds).toEqual(
      kind === 'new' ? [existing.id] : kind === 'baseline' ? ['original-baseline'] : undefined,
    );
    expect(result.chatRuntimeDelta?.runtimeEventsV2?.orderedIds).toContain(existing.id);
    expect(result.chatRuntimeDelta?.runtimeEventsV2?.upserts).toHaveLength(1);
  });

  it('commits a three-day solo departure to calendar and availability with location', () => {
    const result = applyPresenceUpdateToTransition({ chat, transition, now: 1000,
      message: message({ content: '我去襄阳探路，三日回来。', metadata: { activityUpdate: {
        title: '襄阳探路', kind: 'travel', status: 'in_progress', startsNow: true,
        durationMinutes: 4320, locationHint: '襄阳', availability: 'away', evidenceText: '三日回来',
      } } }),
    });
    expect(result.characterPatches[0].patch.presence).toMatchObject({ status: 'away', unavailableUntil: 1000 + 4320 * 60_000 });
    const items = projectWorldCalendar([{ ...chat, runtimeEventsV2: result.chatRuntimeDelta!.runtimeEventsV2!.upserts }], [], { now: 1000 }).items;
    expect(items[0]).toMatchObject({ title: '襄阳探路', kind: 'travel', status: 'in_progress', participantIds: ['a'],
      locationHint: '襄阳', durationMinutes: 4320, availabilityByActor: { a: 'away' } });
    expect(projectWorldCalendar([{ ...chat, runtimeEventsV2: result.chatRuntimeDelta!.runtimeEventsV2!.upserts }], [], { now: 1000 + 4320 * 60_000 }).items[0].status).toBe('completed');
  });

  it('records future plans without making the speaker unavailable, even with a duplicate legacy away field', () => {
    const result = applyPresenceUpdateToTransition({ chat, transition, now: 1000,
      message: message({ content: '明天出门。', metadata: { presenceUpdate: { status: 'away' }, activityUpdate: {
        title: '出门', kind: 'travel', status: 'planned', startAt: 100_000, durationMinutes: 60,
        availability: 'away', evidenceText: '明天出门',
      } } }),
    });
    expect(result.characterPatches).toEqual([]);
    expect(result.chatRuntimeDelta?.runtimeEventsV2?.upserts).toHaveLength(1);
  });

  it('records an activity already in progress without inventing its past start time', () => {
    const result = applyPresenceUpdateToTransition({ chat, transition, now: 1000,
      message: message({ content: '我正在修器械，过会儿再聊。', metadata: { activityUpdate: {
        title: '修器械', kind: 'preparation', status: 'in_progress', startsNow: false,
        durationMinutes: 60, availability: 'away', evidenceText: '我正在修器械',
      } } }),
    });
    expect(result.chatPatch.runtimeEventsV2?.[0].payload).toMatchObject({ status: 'in_progress', startAt: 1000 });
    expect(result.characterPatches[0].patch.presence?.unavailableUntil).toBe(1000 + 60 * 60_000);
  });

  it('allows chatting during a shared activity and never changes another participant presence', () => {
    const result = applyPresenceUpdateToTransition({ chat, transition, now: 1000,
      message: message({ content: '我在营里修器械，你来帮忙吧。', metadata: { activityUpdate: {
        title: '修器械', kind: 'activity', status: 'in_progress', startsNow: true,
        participantIds: ['a', 'b', 'unknown'], availability: 'online', evidenceText: '我在营里修器械',
      } } }),
    });
    expect(result.characterPatches.map((item) => item.characterId)).toEqual(['a']);
    expect(result.characterPatches[0].patch.presence?.status).toBe('online');
    expect(result.chatRuntimeDelta?.runtimeEventsV2?.upserts[0].payload).toMatchObject({ participantIds: ['a', 'b'], participantStates: { a: 'going', b: 'invited' } });
  });

  it('ends the linked activity early on an explicit return', () => {
    const character = { id: 'a', presence: { status: 'away', updatedAt: 1000, calendarItemId: 'trip', unavailableUntil: 100_000 } } as AICharacter;
    const result = applyPresenceUpdateToTransition({ chat, characters: [character], transition, now: 5000,
      message: message({ content: '我回来了。', metadata: { presenceUpdate: { status: 'online', evidenceText: '我回来了' } } }),
    });
    expect(result.characterPatches[0].patch.presence?.status).toBe('online');
    expect(result.chatRuntimeDelta?.runtimeEventsV2?.upserts[0].payload).toMatchObject({ calendarItemId: 'trip', status: 'completed', endAt: 5000 });
    expect(result.characterPatches[0].patch.presence?.lastAwayAt).toBe(1000);
  });

  function ongoingActivity() {
    const started = applyPresenceUpdateToTransition({ chat, transition, now: 1000,
      message: message({ content: '一起去探路，三个时辰回来。', metadata: { activityUpdate: {
        title: '探路', kind: 'travel', status: 'in_progress', startsNow: true,
        durationMinutes: 180, participantIds: ['b'], availability: 'away', evidenceText: '一起去探路',
      } } }),
    });
    const id = 'actor-activity-m1';
    const source = { ...chat, ...started.chatPatch, runtimeEventsV2: [...started.chatPatch.runtimeEventsV2!, {
      id: 'accepted', conversationId: chat.id, kind: 'calendar_item_patch' as const,
      createdAt: 2000, actorIds: ['b'], visibility: 'public' as const,
      payload: { calendarItemId: id, addParticipantStates: { b: 'going' } },
    }] };
    const character = { id: 'a', ...started.characterPatches[0].patch } as AICharacter;
    return { id, source, character, started };
  }

  it.each([undefined, ['a', 'b']])('preserves timing and accepted participants on a location update: %j', (participantIds) => {
    const { id, source, character } = ongoingActivity();
    const now = 1000 + 60 * 60_000;
    const result = applyPresenceUpdateToTransition({ chat: source, characters: [character], transition, now,
      message: message({ id: 'location', content: '还在探路，到了城南。', metadata: { activityUpdate: {
        calendarItemId: id, title: '探路', kind: 'travel', status: 'in_progress',
        participantIds, availability: 'away', locationHint: '城南', evidenceText: '到了城南',
      } } }),
    });
    const item = projectWorldCalendar([{ ...source, ...result.chatPatch }], [], { now }).items[0];
    expect(item).toMatchObject({ startAt: 1000, endAt: 1000 + 180 * 60_000, durationMinutes: 180,
      participantIds: ['a', 'b'], participantStates: { a: 'going', b: 'going' }, locationHint: '城南' });
    expect(result.characterPatches[0].patch.presence).toMatchObject({
      unavailableUntil: 1000 + 180 * 60_000, lastAwayAt: 1000,
    });
  });

  it('updates remaining time from now and keeps the linked absence window aligned', () => {
    const { id, source, character } = ongoingActivity();
    const now = 1000 + 60 * 60_000;
    const result = applyPresenceUpdateToTransition({ chat: source, characters: [character], transition, now,
      message: message({ id: 'remaining', content: '还要两个时辰。', metadata: { activityUpdate: {
        calendarItemId: id, title: '探路', kind: 'travel', status: 'in_progress',
        durationMinutes: 120, evidenceText: '还要两个时辰',
      } } }),
    });
    const item = projectWorldCalendar([{ ...source, ...result.chatPatch }], [], { now }).items[0];
    expect(item).toMatchObject({ startAt: 1000, endAt: now + 120 * 60_000, durationMinutes: 120 });
    expect(result.characterPatches[0].patch.presence).toMatchObject({ status: 'away',
      unavailableUntil: item.endAt, lastAwayAt: 1000 });
  });

  it('honors an explicit new start instead of preserving the original time', () => {
    const { id, source } = ongoingActivity();
    const now = 1000 + 60 * 60_000;
    const result = applyPresenceUpdateToTransition({ chat: source, transition, now,
      message: message({ id: 'reschedule', content: '明日再出发。', metadata: { activityUpdate: {
        calendarItemId: id, title: '探路', kind: 'travel', status: 'planned', startAt: now + 24 * 60 * 60_000,
        durationMinutes: 90, evidenceText: '明日再出发',
      } } }),
    });
    const item = projectWorldCalendar([{ ...source, ...result.chatPatch }], [], { now }).items[0];
    expect(item).toMatchObject({ status: 'planned', startAt: now + 24 * 60 * 60_000,
      endAt: now + (24 * 60 + 90) * 60_000, participantStates: { a: 'going', b: 'going' } });
    expect(result.characterPatches).toEqual([]);
  });

  it.each(['completed', 'cancelled'] as const)('preserves an activity history when it is %s', (status) => {
    const { id, source, character } = ongoingActivity();
    const now = 1000 + 60 * 60_000;
    const result = applyPresenceUpdateToTransition({ chat: source, characters: [character], transition, now,
      message: message({ id: 'finish', content: '探路结束了。', metadata: { activityUpdate: {
        calendarItemId: id, title: '探路', kind: 'travel', status, evidenceText: '探路结束了',
      } } }),
    });
    const item = projectWorldCalendar([{ ...source, ...result.chatPatch }], [], { now }).items[0];
    expect(item).toMatchObject({ status, startAt: 1000, endAt: now,
      participantStates: { a: 'going', b: 'going' } });
    expect(result.characterPatches[0].patch.presence?.status).toBe('online');
  });

  it('reads activity state already accumulated in the current transition', () => {
    const { id, started } = ongoingActivity();
    const result = applyPresenceUpdateToTransition({ chat, transition: started, now: 5000,
      message: message({ id: 'second-bubble', content: '到了城南。', metadata: { activityUpdate: {
        calendarItemId: id, title: '探路', kind: 'travel', status: 'in_progress',
        locationHint: '城南', evidenceText: '到了城南',
      } } }),
    });
    const item = projectWorldCalendar([{ ...chat, ...result.chatPatch }], [], { now: 5000 }).items[0];
    expect(item).toMatchObject({ startAt: 1000, endAt: 1000 + 180 * 60_000,
      participantStates: { a: 'going', b: 'invited' }, locationHint: '城南' });
  });

  it('bounds a new absence during an existing activity without a known end', () => {
    const started = applyPresenceUpdateToTransition({ chat, transition, now: 1000,
      message: message({ content: '正在修器械。', metadata: { activityUpdate: {
        title: '修器械', kind: 'preparation', status: 'in_progress', availability: 'online',
        evidenceText: '正在修器械',
      } } }),
    });
    const now = 60_000;
    const result = applyPresenceUpdateToTransition({ chat: { ...chat, ...started.chatPatch }, transition, now,
      message: message({ id: 'away', content: '先不聊了。', metadata: { activityUpdate: {
        calendarItemId: 'actor-activity-m1', title: '修器械', kind: 'preparation', status: 'in_progress',
        availability: 'away', evidenceText: '先不聊了',
      } } }),
    });
    const item = projectWorldCalendar([{ ...chat, ...result.chatPatch }], [], { now }).items[0];
    expect(item).toMatchObject({ startAt: 1000, endAt: now + 30 * 60_000 });
    expect(result.characterPatches[0].patch.presence?.unavailableUntil).toBe(item.endAt);
  });

  it('closes the previous interval when the speaker starts a different activity', () => {
    const character = { id: 'a', presence: { status: 'away', updatedAt: 1000, calendarItemId: 'trip', unavailableUntil: 100_000 } } as AICharacter;
    const result = applyPresenceUpdateToTransition({ chat, characters: [character], transition, now: 5000,
      message: message({ content: '探路结束，我去营里歇一个时辰。', metadata: { activityUpdate: {
        title: '营里休息', kind: 'rest', status: 'in_progress', startsNow: true,
        durationMinutes: 120, availability: 'away', evidenceText: '我去营里歇一个时辰',
      } } }),
    });
    const items = projectWorldCalendar([{ ...chat, ...result.chatPatch }], [], { now: 5000 }).items;
    expect(items.find((item) => item.id === 'trip')?.status).toBe('completed');
    expect(items.find((item) => item.id === 'actor-activity-m1')?.status).toBe('in_progress');
    expect(result.characterPatches[0].patch.presence).toMatchObject({ status: 'away', lastAwayAt: 5000 });
  });

  it.each([
    { isDeleted: true }, { metadata: { visibility: 'role_private' } },
    { metadata: { withdrawal: { withdrawn: true } } },
  ] as Partial<Message>[])('rejects nonpublic or removed departure writes: %j', (patch) => {
    const result = applyPresenceUpdateToTransition({ chat, transition, message: message({ ...patch,
      metadata: { ...patch.metadata, presenceUpdate: { status: 'away' } } }), now: 1000 });
    expect(result).toBe(transition);
  });

  it('does not derive departure from prose or unsupported evidence', () => {
    expect(buildPresencePatchFromMessage({ message: message() })).toBeNull();
    expect(buildPresencePatchFromMessage({ message: message({ metadata: { presenceUpdate: { status: 'away', evidenceText: '不存在的原文' } } }) })).toBeNull();
  });
  it('builds a global away patch from model-provided presence metadata', () => {
    const patch = buildPresencePatchFromMessage({
      message: message({
        metadata: {
          presenceUpdate: {
            status: 'away',
            activity: '睡觉',
            reason: '角色明确说去睡了',
            durationMinutes: 480,
          },
        },
      }),
      now: 1_000,
    });

    expect(patch?.presence).toMatchObject({
      status: 'away',
      activity: '睡觉',
      reason: '角色明确说去睡了',
      unavailableUntil: 1_000 + 480 * 60_000,
      sourceMessageId: 'm1',
    });
  });

  it('keeps away characters out of scheduling until the away window expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
    const now = Date.now();
    const character = {
      presence: {
        status: 'away' as const,
        activity: '洗澡',
        updatedAt: now,
        unavailableUntil: now + 20 * 60_000,
      },
    };

    expect(isCharacterAvailableForScheduling(character, now)).toBe(false);
    expect(isCharacterAvailableForScheduling(character, now + 21 * 60_000)).toBe(true);
    vi.useRealTimers();
  });

  it('merges presence patches into existing commit transition character patches', () => {
    const transition = applyPresenceUpdateToTransition({
      message: message({
        metadata: {
          presenceUpdate: {
            status: 'away',
            activity: '忙工作',
            reason: '角色说要先去处理工作',
            durationMinutes: 60,
          },
        },
      }),
      transition: {
        chatPatch: {},
        runtimeEvents: [],
        characterPatches: [{ characterId: 'a', patch: { speakingStyle: '短句' } }],
      },
      now: 2_000,
    });

    expect(transition.characterPatches).toHaveLength(1);
    expect(transition.characterPatches[0]).toMatchObject({
      characterId: 'a',
      patch: {
        speakingStyle: '短句',
        presence: { status: 'away', activity: '忙工作' },
      },
    });
  });
});
