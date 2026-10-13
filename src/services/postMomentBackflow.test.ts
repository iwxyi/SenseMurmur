import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../types/chat';
import { findLatestAutoPostMomentCandidate, updateSourceChatAfterPostMoment } from './directSessionRuntime';
import type { SocialEventCandidatePayload } from '../types/runtimeEvent';
import { createInitialRoomState } from './roomStateSynthesizer';

function buildPayload(overrides: Partial<SocialEventCandidatePayload> = {}): SocialEventCandidatePayload {
  return {
    eventKind: 'post_moment',
    initiatorId: 'a',
    participantIds: ['a'],
    targetIds: ['b'],
    reasonType: 'celebration',
    confidence: 0.86,
    urgency: 'soon',
    seedIntent: '想发一条和刚才活动有关的动态。',
    visibilityPlan: 'public',
    expectedArtifacts: ['moment_text', 'moment_food_photo'],
    sourceText: '今晚去吃火锅顺便拍个合照吧。',
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
      id: 'evt-post',
      conversationId: 'chat-1',
      kind: 'event_candidate',
      createdAt: 1,
      actorIds: ['a'],
      targetIds: ['b'],
      summary: 'a 提议发布一条 post_moment 动态',
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

describe('post moment backflow', () => {
  it('tracks candidate completion by identity rather than a later moment', () => {
    const chat = buildChat();
    chat.runtimeEventsV2?.push({
      id: 'evt-artifact',
      conversationId: 'chat-1',
      kind: 'artifact',
      createdAt: 2,
      actorIds: ['a'],
      targetIds: ['b'],
      summary: '甲 发了一条动态',
      visibility: 'derived_public',
      payload: {
        artifactType: 'moment_text',
        eventKind: 'post_moment',
        text: '甲 发了一条动态',
        dedupeKey: 'moment-a-1',
        participantIds: ['a'],
      },
    });
    expect(findLatestAutoPostMomentCandidate(chat)?.id).toBe('evt-post');
    chat.runtimeEventsV2?.push({
      id: 'evt-handled',
      conversationId: chat.id,
      kind: 'artifact',
      createdAt: 3,
      summary: 'handled_social_event:evt-post',
      payload: { artifactType: 'handled_social_event', eventId: 'evt-post' },
    });
    expect(findLatestAutoPostMomentCandidate(chat)).toBeNull();
  });

  it('finds an eligible post moment candidate', () => {
    expect(findLatestAutoPostMomentCandidate(buildChat())?.id).toBe('evt-post');
  });

  it('records publication without inventing reactions, memories, or room changes', () => {
    const chat = buildChat();
    chat.worldState.structuredRoomState = {
      ...createInitialRoomState(),
      heat: 31,
      cohesion: -12,
      dominantThread: ['a', 'b'],
      conflictPairs: [['a', 'b']],
    };
    const patch = updateSourceChatAfterPostMoment(chat, buildPayload(), '甲');
    const kinds = (patch.runtimeEventsV2 || []).map((event) => event.kind);
    expect(kinds).not.toContain('relationship_delta');
    expect(kinds).not.toContain('memory_candidate');
    expect(kinds).toContain('artifact');
    expect(kinds).not.toContain('room_shift');
    expect(patch.worldState?.structuredRoomState).toEqual(chat.worldState.structuredRoomState);
    expect(patch.lastMessageAt).toBeUndefined();
    expect(patch.worldState?.recentEvent).toBe('甲 发布了一条动态。');
    expect(patch.runtimeSeed?.notes).toContain('甲 发布了一条动态。');
    const artifact = patch.runtimeEventsV2?.find((event) => event.kind === 'artifact');
    expect(artifact?.summary).not.toContain('配');
    expect(artifact?.summary).not.toContain('开心');
  });

  it('formats event-themed post moment as a real feed text instead of event record prose', () => {
    const chat = buildChat();
    const patch = updateSourceChatAfterPostMoment(chat, buildPayload({
      reasonType: 'world_attention_share_moment_event',
      sourceText: '今晚一起吃火锅，顺便拍了合照。',
    }), '甲');
    const moment = (patch.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text');
    const text = (moment?.payload as { text?: string }).text || '';
    expect(text).not.toContain('发了一条动态');
    expect(text).not.toContain('记录了刚发生的片段');
    expect(text.length).toBeGreaterThan(8);
  });

  it('formats inner-themed post moment as reflective feed text instead of projection summary', () => {
    const chat = buildChat();
    const patch = updateSourceChatAfterPostMoment(chat, buildPayload({
      reasonType: 'world_attention_share_moment_inner',
      sourceText: '聊完之后心里松了一口气。',
    }), '甲');
    const moment = (patch.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text');
    const text = (moment?.payload as { text?: string }).text || '';
    expect(text).not.toContain('发了一条动态');
    expect(text).not.toContain('写下了当下的内心感受');
    expect(text.length).toBeGreaterThan(8);
  });

  it('backflows companionship residue as natural public moment text', () => {
    const chat = buildChat();
    const patch = updateSourceChatAfterPostMoment(chat, buildPayload({
      reasonType: 'world_attention_share_moment_inner',
      companionshipSeeds: [
        '公开动态可以只留下“有人懂”的余味，不点名用户，也不写成私密记忆：用户说下次一起把话说完。',
        '公开动态可以把和乙之间的关系余波写成一句含蓄状态，不要暴露秘密细节：共同梗/约定：约定争执后先递台阶。',
      ],
    }), '甲');
    const moment = (patch.runtimeEventsV2 || []).find((event) => event.kind === 'artifact' && (event.payload as { artifactType?: string }).artifactType === 'moment_text');
    const text = (moment?.payload as { text?: string }).text || '';
    expect(text.length).toBeGreaterThan(8);
    expect(text).not.toContain('用户');
    expect(text).not.toContain('关系余波');
    expect(text).not.toContain('共同梗/约定：');
    expect(text).not.toContain('发了一条动态');
  });

  it('does not promote expression seeds into new companionship facts', () => {
    const chat = buildChat();
    const patch = updateSourceChatAfterPostMoment(chat, buildPayload({
      dedupeKey: 'moment-companion-1',
      reasonType: 'world_attention_share_moment_inner',
      participantIds: ['a', 'b'],
      targetIds: ['b'],
      companionshipSeeds: [
        '公开动态可以只留下“有人懂”的余味，不点名用户，也不写成私密记忆：用户说下次一起把话说完。',
        '公开动态可以把和乙之间的关系余波写成一句含蓄状态，不要暴露秘密细节：共同梗/约定：约定争执后先递台阶。',
      ],
    }), '甲');
    const reflections = (patch.runtimeEventsV2 || []).filter((event) => {
      const payload = event.payload as { eventType?: string };
      return payload.eventType === 'companionship_moment_reflection';
    });

    expect(reflections).toHaveLength(0);
    expect(patch.runtimeEventsV2?.filter((event) => event.kind === 'artifact')).toHaveLength(1);
  });
});
