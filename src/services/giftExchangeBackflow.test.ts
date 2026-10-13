import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../types/chat';
import type { SocialEventCandidatePayload } from '../types/runtimeEvent';
import { updateSourceChatAfterGiftExchange } from './directSessionRuntime';

function buildPayload(overrides: Partial<SocialEventCandidatePayload> = {}): SocialEventCandidatePayload {
  return {
    eventKind: 'gift_exchange',
    initiatorId: 'a',
    participantIds: ['a'],
    targetIds: ['b'],
    reasonType: 'care_gesture',
    confidence: 0.88,
    urgency: 'soon',
    seedIntent: '想送个小礼物表达心意。',
    visibilityPlan: 'public',
    expectedArtifacts: ['gift_note'],
    sourceText: '我给你带了杯咖啡，别太辛苦。',
    title: '礼物互动',
    activityType: '送咖啡',
    dedupeKey: 'gift-a-b-1',
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
    memberIds: ['a', 'b'],
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

describe('gift exchange backflow', () => {
  it('records intent without fabricating completed behavior or character effects', () => {
    const chat = buildChat();
    const payload = buildPayload();
    const patch = updateSourceChatAfterGiftExchange(chat, payload, '甲');
    const additions = (patch.runtimeEventsV2 || []).filter((event) => !chat.runtimeEventsV2?.some((existing) => existing.id === event.id));
    expect(additions).toHaveLength(1);
    expect(additions[0]).toMatchObject({
      kind: 'artifact',
      payload: { eventKind: 'gift_exchange', status: 'tentative', seedIntent: payload.seedIntent, sourceText: payload.sourceText },
    });
    expect(patch.worldState).toBeUndefined();
    expect(patch.runtimeSeed).toBeUndefined();
    expect(patch.lastMessageAt).toBeUndefined();
  });
});
