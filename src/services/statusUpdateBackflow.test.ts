import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../types/chat';
import type { SocialEventCandidatePayload } from '../types/runtimeEvent';
import { findLatestAutoStatusUpdateCandidate, updateSourceChatAfterStatusUpdate } from './directSessionRuntime';

function buildPayload(overrides: Partial<SocialEventCandidatePayload> = {}): SocialEventCandidatePayload {
  return {
    eventKind: 'status_update',
    initiatorId: 'a',
    participantIds: ['a'],
    targetIds: ['b'],
    reasonType: 'self_disclosure',
    confidence: 0.87,
    urgency: 'soon',
    seedIntent: '想同步一下自己最近的状态。',
    visibilityPlan: 'public',
    expectedArtifacts: ['status_note'],
    sourceText: '最近我在忙新项目，这两天可能回复慢一点。',
    title: '状态更新',
    activityType: '项目近况',
    dedupeKey: 'status-a-1',
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
      id: 'evt-status',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: 1,
      actorIds: ['a'],
      targetIds: ['b'],
      summary: 'a 提议发布一条状态更新',
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

describe('status update backflow', () => {
  it('finds an eligible status update candidate', () => {
    expect(findLatestAutoStatusUpdateCandidate(buildChat())?.id).toBe('evt-status');
  });

  it('records intent without fabricating completed behavior or character effects', () => {
    const chat = buildChat();
    const payload = buildPayload();
    const patch = updateSourceChatAfterStatusUpdate(chat, payload, '甲');
    const additions = (patch.runtimeEventsV2 || []).filter((event) => !chat.runtimeEventsV2?.some((existing) => existing.id === event.id));
    expect(additions).toHaveLength(1);
    expect(additions[0]).toMatchObject({
      kind: 'artifact',
      payload: { eventKind: 'status_update', status: 'tentative', seedIntent: payload.seedIntent, sourceText: payload.sourceText },
    });
    expect(patch.worldState).toBeUndefined();
    expect(patch.runtimeSeed).toBeUndefined();
    expect(patch.lastMessageAt).toBeUndefined();
  });
});
