import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../types/chat';
import type { RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';
import { updateSourceChatAfterSocialOuting } from './directSessionRuntime';
import { projectWorldCalendarItems } from './worldRuntimeProjection';

function buildPayload(overrides: Partial<SocialEventCandidatePayload> = {}): SocialEventCandidatePayload {
  return {
    eventKind: 'social_outing',
    initiatorId: 'a',
    participantIds: ['a', 'b', 'c'],
    targetIds: ['b'],
    reasonType: 'celebration',
    confidence: 0.88,
    urgency: 'soon',
    seedIntent: '想把刚才群里的热络气氛延续成一次线下活动。',
    visibilityPlan: 'public',
    expectedArtifacts: ['outing_summary', 'group_photo', 'food_photo'],
    sourceText: '那就今晚一起去吃火锅庆祝一下，顺便拍张合照。',
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
    name: '群聊',
    topic: '测试',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b', 'c'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [], structuredRoomState: null },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

describe('social outing backflow', () => {
  it('dedupe helper treats same-cluster outing as already backflowed', () => {
    const chat = buildChat();
    const payload = buildPayload({ dedupeKey: 'outing-1' });
    chat.runtimeEventsV2 = [{
      id: 'evt-outing-artifact',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 2,
      actorIds: ['a'],
      targetIds: ['a', 'b', 'c'],
      summary: '甲、乙、丙 一起去参加了刚才聊到的活动。',
      visibility: 'derived_public',
      payload: {
        artifactType: 'outing_summary',
        eventKind: 'social_outing',
        text: '甲、乙、丙 一起去参加了刚才聊到的活动。',
        dedupeKey: 'outing-1',
        participantIds: ['a', 'b', 'c'],
      },
    }];
    expect(updateSourceChatAfterSocialOuting(chat, payload, ['甲', '乙', '丙']).runtimeEventsV2?.length).toBeGreaterThan(0);
  });

  it('records an arrangement without fabricating participation or social effects', () => {
    const chat = buildChat();
    const patch = updateSourceChatAfterSocialOuting(chat, buildPayload(), ['甲', '乙', '丙']);
    const kinds = (patch.runtimeEventsV2 || []).map((event) => event.kind);
    expect(kinds).not.toContain('relationship_delta');
    expect(kinds).not.toContain('memory_candidate');
    expect(kinds).toContain('artifact');
    expect(kinds).not.toContain('room_shift');
    expect(patch.worldState?.structuredRoomState).toEqual(chat.worldState.structuredRoomState);
    expect(patch.worldState?.recentEvent).not.toContain('参与了');
    expect(patch.worldState?.recentEvent).toContain('甲、乙、丙');
  });

  it('preserves invitation states and projects the consumed candidate as tentative', () => {
    const chat = buildChat();
    const patch = updateSourceChatAfterSocialOuting(chat, buildPayload({
      title: '营中夜议', dedupeKey: 'night-meeting', timeHint: '今晚', locationHint: '营中',
      participantStates: { a: 'going', b: 'invited', c: 'maybe' },
    }), ['甲', '乙', '丙']);
    const items = projectWorldCalendarItems([{ ...chat, ...patch }], [], { now: Date.now() });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'night-meeting', status: 'tentative', title: '营中夜议',
      timeHint: '今晚', locationHint: '营中', participantStates: { a: 'going', b: 'invited', c: 'maybe' } });
    const runtimeEventsV2: RuntimeEventV2[] = [...(patch.runtimeEventsV2 || []), {
      id: 'meeting-start', conversationId: chat.id, kind: 'calendar_item_patch' as const,
      createdAt: Date.now() + 1, actorIds: ['a'], summary: '夜议开始', visibility: 'public' as const,
      payload: { calendarItemId: 'night-meeting', status: 'in_progress', addParticipantStates: { b: 'going' } },
    }];
    const started = projectWorldCalendarItems([{ ...chat, ...patch, runtimeEventsV2 }], []);
    expect(started[0]).toMatchObject({ id: 'night-meeting', status: 'in_progress',
      participantStates: { a: 'going', b: 'going', c: 'maybe' } });
    runtimeEventsV2.push({ id: 'meeting-cancel', conversationId: chat.id, kind: 'calendar_item_patch',
      createdAt: Date.now() + 2, actorIds: ['a'], summary: '夜议取消', visibility: 'public',
      payload: { calendarItemId: 'night-meeting', status: 'cancelled' } });
    expect(projectWorldCalendarItems([{ ...chat, ...patch, runtimeEventsV2 }], [])[0]?.status).toBe('cancelled');
  });
});
