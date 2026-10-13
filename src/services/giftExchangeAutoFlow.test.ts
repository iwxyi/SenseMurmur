import { describe, expect, it, vi } from 'vitest';
import { normalizeConversation, type GroupChat } from '../types/chat';
import type { SocialEventCandidatePayload } from '../types/runtimeEvent';
import { runSocialEventAutoFlow } from './directSessionRuntime';

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
    runtimeEventsV2: [{
      id: 'evt-gift',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: 1,
      actorIds: ['a'],
      targetIds: ['b'],
      summary: 'a 提议触发一次礼物互动',
      visibility: 'derived_public',
      payload: buildPayload(),
    }],
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [], structuredRoomState: null },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

describe('gift exchange auto flow', () => {
  it('reuses the engine artifact for the same candidate without adding effects', async () => {
    const chat = buildChat();
    chat.runtimeEventsV2!.push({
      id: 'intent-1', conversationId: chat.id, kind: 'artifact', createdAt: 2,
      actorIds: ['a'], targetIds: ['b'], summary: '待定礼物意图', visibility: 'derived_public',
      payload: { artifactType: 'gift_note', eventKind: 'gift_exchange', status: 'tentative', candidateId: 'evt-gift' },
    });
    const updateChat = vi.fn<(id: string, patch: Partial<GroupChat>) => Promise<void>>(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat], characters: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never[],
      allowWorldFallback: false,
      applyChatRuntimePatch: async (id, buildPatch) => {
        const patch = buildPatch(chat);
        if (!patch) return false;
        await updateChat(id, patch);
        return true;
      },
      addChat: vi.fn(async () => chat), addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBe('evt-gift');
    const patch = updateChat.mock.calls[0][1];
    expect(patch.runtimeEventsV2?.filter((event) => (event.payload as { artifactType?: string }).artifactType === 'gift_note'))
      .toHaveLength(1);
    expect(patch.runtimeEventsV2?.some((event) => ['memory_candidate', 'relationship_delta', 'room_shift'].includes(event.kind))).toBe(false);
    expect(patch.worldState).toBeUndefined();
  });

  it('auto-backflows gift exchange candidates', async () => {
    const chat = buildChat();
    const updateChat = vi.fn<(id: string, patch: Partial<GroupChat>) => Promise<void>>(async () => undefined);
    const result = await runSocialEventAutoFlow(chat, {
      chats: [chat],
      characters: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never[],
      applyChatRuntimePatch: async (id, buildPatch) => {
        const patch = buildPatch(chat);
        if (!patch) return false;
        await updateChat(id, patch);
        return true;
      },
      addChat: vi.fn(async () => chat),
      addMessage: vi.fn(async () => ({})),
      appendEventMessage: vi.fn(async () => undefined),
    });
    expect(result.handledEventId).toBe('evt-gift');
    expect(updateChat).toHaveBeenCalledTimes(1);
  });
});
