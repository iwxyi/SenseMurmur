import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openChatEngine } from './engines/openChatEngine';
import {
  buildProjectedChatDetailState,
  buildProjectedSessionActions,
  createProjectionContext,
  projectRuntimeState,
  projectActionSchema,
  projectRecentInteractionItems,
  projectSessionFrameworkState,
  readCalendarPatchMeta,
  readCalendarPatchApplyResultMeta,
  readCandidateSuppressionMeta,
  readGuidanceInfoMeta,
  readAttentionInfoMeta,
  readAttentionSourceMeta,
  readAttentionFollowupMeta,
  readMemoryCandidateMeta,
  readMemoryDistillationMeta,
  readProjectionInfoMeta,
  readRelationshipDeltaMeta,
  readRoomShiftMeta,
  readSocialEventArtifactMeta,
  readSocialEventCandidateMeta,
  readSocialEventClusterMeta,
  readSocialEventEffectMeta,
  readUnifiedWorldDecisionMeta,
  readWorldDecisionV2Meta,
  createViewerRoleForConversation,
} from './sessionProjection';
import { normalizeConversation } from '../types/chat';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

function buildChat() {
  return normalizeConversation({
    id: 'chat-1',
    type: 'ai_direct',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: 'Private chat',
    topic: 'secret',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    topicSeed: '',
    runtimeEventsV2: [
      { id: 'evt-1', conversationId: 'chat-1', kind: 'message_generated', createdAt: 1, actorIds: ['a'], summary: '公开消息', visibility: 'public', payload: { text: '公开消息' } },
      { id: 'evt-2', conversationId: 'chat-1', kind: 'artifact', createdAt: 2, actorIds: ['a'], summary: '狼人私有信息', visibility: 'role_private', visibleToRoles: ['werewolf'], payload: { text: '狼人私有信息' } },
      { id: 'evt-3', conversationId: 'chat-1', kind: 'event_candidate', createdAt: 3, actorIds: ['a'], targetIds: ['b'], summary: 'A 提议与 B 发起双人私聊候选', visibility: 'derived_public', payload: { eventKind: 'pair_private_thread', initiatorId: 'a', participantIds: ['a', 'b'], targetIds: ['b'], reasonType: 'unresolved_question', confidence: 0.82, urgency: 'immediate', seedIntent: '继续私下聊', visibilityPlan: 'conversation_private', expectedArtifacts: ['private_thread_summary'] } },
    ],
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

describe('sessionProjection', () => {
  it('filters runtime events by visibility', () => {
    const chat = buildChat();
    const context = createProjectionContext(chat, openChatEngine.buildParticipants(chat), 'a', 'pair_private');
    const state = projectRuntimeState(chat, context);
    expect(state.runtimeEventsV2).toHaveLength(2);
    expect(state.runtimeEventsV2.map((event) => event.kind)).toEqual(['message_generated', 'event_candidate']);
  });

  it('maps non-member operators to moderator viewer role', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      type: 'group',
      memberIds: ['a', 'b'],
      operatorIds: ['host_moderator'],
    });
    expect(createViewerRoleForConversation(chat, 'host_moderator')).toBe('moderator');
  });

  it('projects open_chat private-thread action schema in group chats', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-1',
      type: 'group',
      memberIds: ['a', 'b', 'c'],
    });
    const context = createProjectionContext(chat, openChatEngine.buildParticipants(chat));
    const schema = projectActionSchema(openChatEngine, context);
    expect(schema?.actions.some((action) => action.type === 'start_private_thread')).toBe(true);
  });

  it('preserves social event candidate metadata in projected timeline', () => {
    const chat = buildChat();
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat), 'a', 'pair_private')).runtimeTimeline;
    const candidate = timeline.find((item) => item.event?.kind === 'event_candidate');
    expect(candidate?.meta?.socialEventCandidate?.eventKind).toBe('pair_private_thread');
  });

  it('uses shared runtime event kind labels in projected timeline', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: 8,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '用户点名 a',
        visibility: 'derived_public',
        payload: { source: 'user_group_message', confidence: 0.88, targetIds: ['a'] },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat))).runtimeTimeline;
    expect(timeline[0]?.label).toBe('关注候选');
  });

  it('replaces participant ids without corrupting unknown UUIDs in projected timeline', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-uuid',
        conversationId: 'chat-1',
        kind: 'message_generated',
        createdAt: 10,
        actorIds: ['a'],
        summary: 'e055aa1d-88d4-4e96-abd2-1b35a3d56f67 对 a 说话',
        visibility: 'public',
        payload: { text: '测试' },
      }],
    });
    const participants = [{ id: 'a', name: '甲' }] as never;
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, participants, 'a', 'participant')).runtimeTimeline;
    expect(timeline[0]?.text).toBe('成员 对 甲 说话');
  });

  it('projects known UUID participants to names without leaking replace offsets', () => {
    const memberId = '3c78729f-e52d-4dde-b27f-01a949960bb8b';
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-known-uuid',
        conversationId: 'chat-1',
        kind: 'message_generated',
        createdAt: 10,
        actorIds: [memberId],
        summary: `${memberId} 接住了 b 的话题`,
        visibility: 'public',
        payload: { text: '测试' },
      }],
    });
    const participants = [{ id: memberId, name: '喜羊羊' }, { id: 'b', name: '沸羊羊' }] as never;
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, participants, memberId, 'participant')).runtimeTimeline;

    expect(timeline[0]?.text).toBe('喜羊羊 接住了 沸羊羊 的话题');
    expect(timeline[0]?.actorNames).toEqual(['喜羊羊']);
  });

  it('projects user actor id as 我 in runtime timeline names', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['user', 'a'],
      runtimeEventsV2: [{
        id: 'evt-user-actor',
        conversationId: 'chat-1',
        kind: 'interaction',
        createdAt: 12,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: 'user 对 a 提了一个问题',
        visibility: 'public',
        payload: { kind: 'probe', actorId: 'user', targetId: 'a', intensity: 3, tone: 'cold', evidenceText: '你怎么看这件事？', confidence: 0.9 },
      }],
    });
    const participants = [{ id: 'a', name: '甲' }] as never;
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, participants, 'a', 'participant')).runtimeTimeline;
    expect(timeline[0]?.actorNames).toEqual(['我']);
    expect(timeline[0]?.text).toContain('我');
    expect(timeline[0]?.text).toContain('甲');
  });

  it('cleans social event candidate text fields with participant names', () => {
    const actorId = '3c78729f-e52d-4dde-b27f-01a949960bb8b';
    const targetId = '8b3d7266-c0c7-4ceb-8dc2-45126f3f2321';
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: [actorId, targetId],
      runtimeEventsV2: [{
        id: 'evt-social-uuid',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 11,
        actorIds: [actorId],
        targetIds: [targetId],
        summary: `${actorId} 想和 ${targetId} 私下继续聊`,
        visibility: 'derived_public',
        payload: {
          eventKind: 'pair_private_thread',
          initiatorId: actorId,
          participantIds: [actorId, targetId],
          targetIds: [targetId],
          reasonType: 'unresolved_question',
          confidence: 0.82,
          urgency: 'immediate',
          seedIntent: `${actorId} 想和 ${targetId} 把刚才的分歧说清楚`,
          sourceText: `${targetId} 刚才没有回应 ${actorId}`,
          title: `${actorId} 与 ${targetId} 私聊`,
          visibilityPlan: 'conversation_private',
          expectedArtifacts: ['private_thread_summary'],
        },
      }],
    });
    const participants = [{ id: actorId, name: '喜羊羊' }, { id: targetId, name: '沸羊羊' }] as never;
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, participants, actorId, 'participant')).runtimeTimeline;
    const candidate = timeline[0]?.meta?.socialEventCandidate;

    expect(timeline[0]?.text).toBe('喜羊羊 想和 沸羊羊 私下继续聊');
    expect(candidate?.seedIntent).toBe('喜羊羊 想和 沸羊羊 把刚才的分歧说清楚');
    expect(candidate?.sourceText).toBe('沸羊羊 刚才没有回应 喜羊羊');
    expect(candidate?.title).toBe('喜羊羊 与 沸羊羊 私聊');
    const visibleText = [timeline[0]?.text, candidate?.seedIntent, candidate?.sourceText, candidate?.title].join(' / ');
    expect(visibleText).not.toContain(actorId);
    expect(visibleText).not.toContain(targetId);
    expect(visibleText).not.toContain('0喜羊羊');
  });

  it('cleans attention trace reasons in social event candidates', () => {
    const actorId = '3c78729f-e52d-4dde-b27f-01a949960bb8b';
    const targetId = '8b3d7266-c0c7-4ceb-8dc2-45126f3f2321';
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: [actorId, targetId],
      runtimeEventsV2: [{
        id: 'evt-social-attention-trace',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 12,
        actorIds: [actorId],
        targetIds: [targetId],
        summary: `${actorId} 准备跟进`,
        visibility: 'derived_public',
        payload: {
          eventKind: 'check_in',
          initiatorId: actorId,
          participantIds: [actorId, 'user'],
          targetIds: ['user'],
          reasonType: 'attention_check_in',
          confidence: 0.8,
          urgency: 'soon',
          seedIntent: `${actorId} 想问问 ${targetId} 最近怎么样`,
          visibilityPlan: 'user_private',
          expectedArtifacts: ['check_in_note'],
          attentionTrace: {
            score: 0.76,
            restraint: 0.42,
            suggestedActions: ['check_in', 'ask_followup'],
            reasons: [
              `关系基线：亲和6 / 信任5 / 威胁1；${actorId} 对 ${targetId} 仍有在意`,
              `${targetId} 最近点名过 ${actorId}`,
            ],
            latestEvidenceAt: 11,
          },
        },
      }],
    });
    const participants = [{ id: actorId, name: '喜羊羊' }, { id: targetId, name: '沸羊羊' }] as never;
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, participants, actorId, 'participant')).runtimeTimeline;
    const attentionTrace = timeline[0]?.meta?.socialEventCandidate?.attentionTrace;
    const reasonText = (attentionTrace?.reasons || []).join(' / ');
    const projectedAttention = readAttentionInfoMeta(timeline[0]!);
    expect(reasonText).toContain('喜羊羊');
    expect(reasonText).toContain('沸羊羊');
    expect(reasonText).not.toContain(actorId);
    expect(reasonText).not.toContain(targetId);
    expect(projectedAttention).toMatchObject({
      scoreLabel: '76%',
      restraintLabel: '42%',
      actorKindLabel: '角色',
      targetKindLabels: ['用户'],
    });
    expect((projectedAttention?.reasons || []).join(' / ')).toContain('喜羊羊');
    expect((projectedAttention?.reasons || []).join(' / ')).toContain('沸羊羊');
  });

  it('extracts world_decision_v2 metadata into projected timeline', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-world-v2',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: 20,
        summary: '世界决策',
        visibility: 'derived_public',
        payload: {
          eventType: 'world_decision_v2',
          domain: 'open_chat',
          selectedId: 'candidate-1',
          selectedKind: 'check_in',
          decisionSource: 'model',
          modelReason: '优先回应当前被点名对象',
          confidenceDelta: 0.03,
          candidateCount: 4,
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat))).runtimeTimeline;
    const meta = readWorldDecisionV2Meta(timeline[0]!);
    expect(meta?.eventType).toBe('world_decision_v2');
    expect(meta?.domain).toBe('open_chat');
    expect(meta?.decisionSource).toBe('model');
    expect(meta?.selectedKind).toBe('check_in');
    expect(meta?.candidateCount).toBe(4);
  });

  it('prefers world_decision_v2 over legacy world_attention_decision when both exist', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-world-both',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: 21,
        summary: '世界决策并存',
        visibility: 'derived_public',
        payload: {
          eventType: 'world_decision_v2',
          domain: 'proactive_care',
          selectedKind: 'status_update',
          selectedReasonType: 'world_attention_calendar_reminder',
          decisionSource: 'local',
          modelReason: '',
          candidateCount: 2,
          // 兼容字段并存时应优先消费 v2
          decisionType: 'fallback',
          toEventKind: 'check_in',
          reasonType: 'legacy_reason',
          reasonDetail: 'legacy detail',
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat))).runtimeTimeline;
    const unified = readUnifiedWorldDecisionMeta(timeline[0]!);
    expect(unified?.version).toBe('v2');
    expect(unified?.selectedKind).toBe('status_update');
    expect(unified?.selectedReasonType).toBe('world_attention_calendar_reminder');
  });

  it('falls back unified world decision reason to selectedReasonType when modelReason is empty', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-world-local',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: 22,
        summary: '世界本地决策',
        visibility: 'derived_public',
        payload: {
          eventType: 'world_decision_v2',
          domain: 'open_chat',
          selectedKind: 'status_update',
          selectedReasonType: 'world_attention_restrained_fallback',
          decisionSource: 'local',
          modelReason: '',
          candidateCount: 3,
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat))).runtimeTimeline;
    const unified = readUnifiedWorldDecisionMeta(timeline[0]!);
    expect(unified?.version).toBe('v2');
    expect(unified?.reason).toBe('world_attention_restrained_fallback');
  });

  it('projects non-participant attention ids as system actor kind labels', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-system-attention',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 13,
        actorIds: ['host'],
        targetIds: ['auditor'],
        summary: '主持人建议先确认流程',
        visibility: 'derived_public',
        payload: {
          eventKind: 'check_in',
          initiatorId: 'host',
          participantIds: ['host'],
          targetIds: ['auditor'],
          reasonType: 'process_followup',
          confidence: 0.7,
          urgency: 'soon',
          seedIntent: '先确认流程是否清楚',
          visibilityPlan: 'public',
          attentionTrace: {
            score: 0.61,
            restraint: 0.33,
            suggestedActions: ['check_in'],
            reasons: ['主持人准备补充流程提醒'],
            latestEvidenceAt: 12,
          },
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }] as never, 'a', 'participant')).runtimeTimeline;
    const projectedAttention = readAttentionInfoMeta(timeline[0]!);
    expect(projectedAttention).toMatchObject({
      actorKindLabel: '系统',
      targetKindLabels: ['系统'],
      actorSubtypeLabel: '主持人',
    });
  });

  it('projects manual attention source for member follow-up candidate', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-manual-attention',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        createdAt: 120,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 对 b 形成手动跟进关注候选',
        visibility: 'derived_public',
        payload: {
          source: 'manual_attention_followup_member',
          confidence: 0.92,
          targetIds: ['b'],
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never, 'a', 'participant')).runtimeTimeline;
    const sourceMeta = readAttentionSourceMeta(timeline[0]!);
    expect(sourceMeta).toMatchObject({
      mode: 'manual',
      label: '手动跟进',
      source: 'manual_attention_followup_member',
    });
  });

  it('projects system agent subtype labels for both actor and target when recognizable', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-system-subtypes',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 14,
        actorIds: ['god-director'],
        targetIds: ['game_master_judge'],
        summary: '导演提醒裁判推进流程',
        visibility: 'derived_public',
        payload: {
          eventKind: 'check_in',
          initiatorId: 'god-director',
          participantIds: ['god-director'],
          targetIds: ['game_master_judge'],
          reasonType: 'process_followup',
          confidence: 0.66,
          urgency: 'soon',
          seedIntent: '导演提醒裁判推进流程',
          visibilityPlan: 'public',
          attentionTrace: {
            score: 0.58,
            restraint: 0.35,
            suggestedActions: ['check_in'],
            reasons: ['导演催促裁判推进当前回合'],
            latestEvidenceAt: 13,
          },
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }] as never, 'a', 'participant')).runtimeTimeline;
    const projectedAttention = readAttentionInfoMeta(timeline[0]!);
    expect(timeline[0]?.actorNames).toEqual(['导演/上帝']);
    expect(timeline[0]?.targetNames).toEqual(['裁判/GM']);
    expect(projectedAttention).toMatchObject({
      actorKindLabel: '系统',
      targetKindLabels: ['系统'],
      actorSubtypeLabel: '导演/上帝',
      targetSubtypeLabels: ['裁判/GM'],
    });
  });

  it('projects attention followup action status as completed when actor replied later', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-followup',
        conversationId: 'chat-1',
        kind: 'director_intervention',
        createdAt: 20,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '让甲跟进用户',
        visibility: 'public',
        payload: {
          eventType: 'attention_followup_user',
          actorId: 'a',
          focus: '先回应用户，再问一个问题',
        },
      }, {
        id: 'evt-reply',
        conversationId: 'chat-1',
        kind: 'message_generated',
        createdAt: 22,
        actorIds: ['a'],
        summary: '甲开始跟进用户',
        visibility: 'public',
        payload: { text: '我先回应你这个问题。' },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never, 'a', 'participant')).runtimeTimeline;
    const followupItem = timeline.find((item) => item.event?.id === 'evt-followup');
    const followupMeta = followupItem ? readAttentionFollowupMeta(followupItem) : null;
    expect(followupMeta).toMatchObject({
      actorId: 'a',
      actorName: '甲',
      status: 'completed',
      focus: '先回应用户，再问一个问题',
    });
  });

  it('records an actor response without inferring semantic fulfillment from its text', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-followup-pending',
        conversationId: 'chat-1',
        kind: 'director_intervention',
        createdAt: 20,
        actorIds: ['user'],
        targetIds: ['a'],
        summary: '让甲跟进用户',
        visibility: 'public',
        payload: {
          eventType: 'attention_followup_user',
          actorId: 'a',
          focus: '先回答用户关于责任的问题',
        },
      }, {
        id: 'evt-off-topic',
        conversationId: 'chat-1',
        kind: 'message_generated',
        createdAt: 22,
        actorIds: ['a'],
        summary: '甲继续聊旧梗',
        visibility: 'public',
        payload: { text: '证件照还是挺搞笑的。' },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never, 'a', 'participant')).runtimeTimeline;
    const followupItem = timeline.find((item) => item.event?.id === 'evt-followup-pending');
    const followupMeta = followupItem ? readAttentionFollowupMeta(followupItem) : null;
    expect(followupMeta).toMatchObject({
      actorId: 'a',
      status: 'completed',
      completedAt: 22,
    });
  });

  it('projects member attention followup action status as completed when actor replied later', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'evt-followup-member',
        conversationId: 'chat-1',
        kind: 'director_intervention',
        createdAt: 30,
        actorIds: ['user'],
        targetIds: ['a', 'b'],
        summary: '让甲跟进乙',
        visibility: 'public',
        payload: {
          eventType: 'attention_followup_member',
          actorId: 'a',
          targetId: 'b',
          focus: '先回应乙，再追问细节',
        },
      }, {
        id: 'evt-reply-member',
        conversationId: 'chat-1',
        kind: 'message_generated',
        createdAt: 32,
        actorIds: ['a'],
        summary: '甲开始跟进乙',
        visibility: 'public',
        payload: { text: '乙，我先回应你刚才的观点，再追问一个关键细节。' },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never, 'a', 'participant')).runtimeTimeline;
    const followupItem = timeline.find((item) => item.event?.id === 'evt-followup-member');
    const followupMeta = followupItem ? readAttentionFollowupMeta(followupItem) : null;
    expect(followupMeta).toMatchObject({
      kind: 'member',
      actorId: 'a',
      actorName: '甲',
      targetId: 'b',
      targetName: '乙',
      status: 'completed',
    });
  });

  it('projects recent interactions by conversation turn instead of raw relationship event slots', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'interaction-old',
        conversationId: 'chat-1',
        kind: 'interaction',
        createdAt: 100,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '甲 → 乙 · 旧互动',
        visibility: 'public',
        payload: { kind: 'challenge', actorId: 'a', targetId: 'b', intensity: 3, tone: 'annoyed', evidenceText: '旧互动', confidence: 0.9 },
      }, {
        id: 'relationship-old',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 101,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '甲→乙 旧关系变化',
        visibility: 'public',
        payload: { actorId: 'a', targetId: 'b', reason: 'challenge', delta: { trust: -1 } },
      }, {
        id: 'interaction-new',
        conversationId: 'chat-1',
        kind: 'interaction',
        createdAt: 200,
        actorIds: ['b'],
        targetIds: ['a'],
        summary: '乙 → 甲 · 新互动',
        visibility: 'public',
        payload: { kind: 'support', actorId: 'b', targetId: 'a', intensity: 4, tone: 'warm', evidenceText: '新互动', confidence: 0.95 },
      }, {
        id: 'relationship-new',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 201,
        actorIds: ['b'],
        targetIds: ['a'],
        summary: '乙→甲 新关系变化',
        visibility: 'public',
        payload: { actorId: 'b', targetId: 'a', reason: 'support', delta: { warmth: 2 } },
      }],
    });

    const recent = projectRecentInteractionItems(chat);
    expect(recent.map((item) => item.event?.id)).toEqual(['interaction-new', 'interaction-old']);
  });

  it('preserves social event artifact metadata in projected timeline', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-artifact',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 10,
        actorIds: ['a'],
        summary: '甲、乙 一起去参加了刚才聊到的吃饭。',
        visibility: 'derived_public',
        payload: {
          artifactType: 'outing_summary',
          eventKind: 'social_outing',
          title: '线下活动',
          activityType: '吃饭',
          dedupeKey: 'outing-1',
          participantIds: ['a', 'b'],
          targetIds: ['b'],
          timeHint: '今晚',
          locationHint: '校门口',
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat), 'a', 'participant')).runtimeTimeline;
    expect(timeline[0]?.meta?.socialEventArtifact?.eventKind).toBe('social_outing');
    expect(timeline[0]?.meta?.socialEventArtifact?.artifactType).toBe('outing_summary');
    expect(timeline[0]?.meta?.socialEventArtifact?.participantIds).toEqual(['a', 'b']);
    expect(timeline[0]?.meta?.socialEventArtifact?.timeHint).toBe('今晚');
    expect(timeline[0]?.meta?.socialEventCluster?.stage).toBe('artifact');
  });

  it('marks opened private-thread artifacts as opened cluster stage', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-opened',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 11,
        actorIds: ['a'],
        targetIds: ['a', 'b'],
        summary: 'a 与 b 的双人私聊已自动派生',
        visibility: 'derived_public',
        payload: {
          artifactType: 'private_thread_opened',
          eventKind: 'pair_private_thread',
          candidateId: 'evt-candidate-1',
          participantIds: ['a', 'b'],
          reasonType: 'unresolved_question',
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat), 'a', 'participant')).runtimeTimeline;
    expect(timeline[0]?.meta?.socialEventCluster?.stage).toBe('opened');
    expect(timeline[0]?.meta?.socialEventCluster?.candidateId).toBe('evt-candidate-1');
  });

  it('projects calendar patch metadata for runtime timeline', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-calendar-patch',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 20,
        actorIds: ['a'],
        summary: '自动顺延咖啡局',
        visibility: 'public',
        payload: {
          source: 'world_calendar_patch_executor',
          calendarItemId: 'outing-coffee',
          basedOnItemId: 'outing-dinner',
          idempotencyKey: 'calendar-patch:outing-coffee',
          startAt: 1800003600000,
          endAt: 1800007200000,
          durationMinutes: 60,
          reason: '晚饭与咖啡冲突，自动顺延',
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat), 'a', 'participant')).runtimeTimeline;
    expect(timeline[0]?.meta?.calendarPatch).toEqual(expect.objectContaining({
      isAuto: true,
      calendarItemId: 'outing-coffee',
      basedOnItemId: 'outing-dinner',
      idempotencyKey: 'calendar-patch:outing-coffee',
      startAt: 1800003600000,
    }));
  });

  it('projects projection and guidance info metadata into timeline meta', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-guidance',
        conversationId: 'chat-1',
        kind: 'director_intervention',
        createdAt: 30,
        actorIds: ['a'],
        summary: '要求甲回复并给出相关图片',
        visibility: 'public',
        payload: {
          projectionKind: 'source_chat_patch',
          topicSnippet: '甲需要先回应乙',
          participantNames: ['甲', '乙'],
          userGuidance: {
            kind: 'media_request',
            actorIds: ['a'],
            mediaRequest: {
              subjectActorIds: ['b'],
              subjectText: '乙的近照',
            },
          },
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never, 'a', 'participant')).runtimeTimeline;
    expect(timeline[0]?.meta?.projectionInfo).toEqual(expect.objectContaining({
      projectionKind: 'source_chat_patch',
      topicSnippet: '甲需要先回应乙',
      participantNames: ['甲', '乙'],
    }));
    expect(timeline[0]?.meta?.guidanceInfo).toEqual(expect.objectContaining({
      kind: 'media_request',
      actorNames: ['甲'],
      subjectNames: ['乙'],
      subjectText: '乙的近照',
    }));
  });

  it('exposes runtime meta through projection accessors', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-accessor-1',
        conversationId: 'chat-1',
        kind: 'event_candidate',
        createdAt: 41,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'A 提议与 B 发起双人私聊候选',
        visibility: 'derived_public',
        payload: {
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
        },
      }, {
        id: 'evt-accessor-2',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 42,
        actorIds: ['a'],
        summary: '候选已经派生',
        visibility: 'derived_public',
        payload: {
          artifactType: 'private_thread_opened',
          eventKind: 'pair_private_thread',
          candidateId: 'evt-accessor-1',
          participantIds: ['a', 'b'],
          reasonType: 'unresolved_question',
        },
      }, {
        id: 'evt-accessor-3',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 43,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '私聊回流：两人关系更近了一点',
        visibility: 'derived_public',
        payload: {
          eventKind: 'pair_private_thread',
          effectType: 'relationship',
          summary: '私聊回流：两人关系更近了一点',
          confidence: 0.82,
        },
      }, {
        id: 'evt-accessor-4',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 44,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '关系变化',
        visibility: 'public',
        payload: {
          reason: 'support',
          delta: { warmth: 2, trust: 1 },
        },
      }, {
        id: 'evt-accessor-5',
        conversationId: 'chat-1',
        kind: 'room_shift',
        createdAt: 45,
        summary: '房间升温',
        visibility: 'public',
        payload: {
          heat: 66,
          cohesion: 18,
          topicDrift: 12,
          delta: { heat: 6, cohesion: 4, topicDrift: 2 },
        },
      }, {
        id: 'evt-accessor-6',
        conversationId: 'chat-1',
        kind: 'memory_candidate',
        createdAt: 46,
        actorIds: ['a'],
        summary: '记忆候选',
        visibility: 'public',
        payload: {
          kind: 'relationship',
          text: 'A 对 B 更信任了',
          salience: 0.72,
          confidence: 0.86,
        },
      }, {
        id: 'evt-accessor-7',
        conversationId: 'chat-1',
        kind: 'artifact',
        createdAt: 47,
        summary: '记忆蒸馏',
        visibility: 'public',
        payload: {
          eventType: 'memory_distillation',
          ownerType: 'character',
          candidateTexts: ['A 对 B 更信任了'],
        },
      }, {
        id: 'evt-accessor-8',
        conversationId: 'chat-1',
        kind: 'director_intervention',
        createdAt: 48,
        actorIds: ['a'],
        summary: '引导',
        visibility: 'public',
        payload: {
          projectionKind: 'source_chat_patch',
          topicSnippet: '先回应后发图',
          participantNames: ['甲', '乙'],
          userGuidance: {
            kind: 'media_request',
            actorIds: ['a'],
            mediaRequest: {
              subjectActorIds: ['b'],
              subjectText: '乙近照',
            },
          },
        },
      }, {
        id: 'evt-accessor-9',
        conversationId: 'chat-1',
        kind: 'calendar_item_patch',
        createdAt: 49,
        actorIds: ['a'],
        summary: '自动顺延',
        visibility: 'public',
        payload: {
          source: 'world_calendar_patch_executor',
          calendarItemId: 'item-1',
          idempotencyKey: 'calendar-patch:item-1',
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never, 'a', 'participant')).runtimeTimeline;

    expect(readSocialEventCandidateMeta(timeline[0]!)).toBeTruthy();
    expect(readSocialEventClusterMeta(timeline[0]!)?.stage).toBe('candidate');
    expect(readSocialEventArtifactMeta(timeline[1]!)?.artifactType).toBe('private_thread_opened');
    expect(readSocialEventEffectMeta(timeline[2]!)?.effectType).toBe('relationship');
    expect(readRelationshipDeltaMeta(timeline[3]!)?.delta?.warmth).toBe(2);
    expect(readRoomShiftMeta(timeline[4]!)?.delta?.heat).toBe(6);
    expect(readMemoryCandidateMeta(timeline[5]!)?.kind).toBe('关系');
    expect(readMemoryDistillationMeta(timeline[6]!)?.eventType).toBe('memory_distillation');
    expect(readProjectionInfoMeta(timeline[7]!)?.projectionKind).toBe('source_chat_patch');
    expect(readGuidanceInfoMeta(timeline[7]!)?.kind).toBe('media_request');
    expect(readCalendarPatchMeta(timeline[8]!)?.calendarItemId).toBe('item-1');
  });

  it('projects private-thread backflow as social event effect metadata', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-effect',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 12,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '私聊回流：两人关系更近了一点',
        visibility: 'derived_public',
        payload: {
          eventKind: 'pair_private_thread',
          effectType: 'relationship',
          summary: '私聊回流：两人关系更近了一点',
          confidence: 0.82,
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat), 'a', 'participant')).runtimeTimeline;
    expect(timeline[0]?.meta?.socialEventEffect?.eventKind).toBe('pair_private_thread');
    expect(timeline[0]?.meta?.socialEventEffect?.effectType).toBe('relationship');
    expect(timeline[0]?.meta?.socialEventCluster?.stage).toBe('effect');
  });

  it('projects scheduling trace metadata for candidate suppression and calendar patch apply result', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-suppressed',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: 51,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: '候选已抑制：check_in',
        visibility: 'public',
        payload: {
          eventType: 'event_candidate_suppressed',
          candidateEventKind: 'check_in',
          reasonType: 'restraint_policy',
          reasonLabel: '触发关注克制策略（冷却/夜间/关系边界）',
          reasonDetail: '同 key 候选中保留更高置信度候选（0.93 > 0.80）',
          confidence: 0.82,
          preferredConfidence: 0.93,
          suppressedConfidence: 0.8,
          preferredCandidateId: 'evt-candidate-keep',
          suppressedCandidateId: 'evt-candidate-drop',
          hitEventId: 'evt-private-hit',
          hitWindow: '90min',
        },
      }, {
        id: 'evt-patch-apply',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: 52,
        actorIds: ['host_moderator'],
        summary: '执行完成：应用 2，跳过 1，失败 0',
        visibility: 'public',
        payload: {
          eventType: 'calendar_patch_apply_result',
          appliedCount: 2,
          skippedCount: 1,
          failedCount: 0,
          queueCount: 4,
          persistedCount: 1,
          skippedReasonCounts: {
            chain_group_blocked: 1,
          },
          modelArbitration: {
            attempted: true,
            applied: true,
            selectedIndependentCount: 3,
          },
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'a', name: '甲' }, { id: 'host_moderator', name: '主持人' }] as never, 'a', 'moderator')).runtimeTimeline;
    const suppressedItem = timeline.find((item) => item.event?.id === 'evt-suppressed');
    const patchApplyItem = timeline.find((item) => item.event?.id === 'evt-patch-apply');
    expect(suppressedItem).toBeTruthy();
    expect(patchApplyItem).toBeTruthy();
    expect(readCandidateSuppressionMeta(suppressedItem!)?.eventType).toBe('event_candidate_suppressed');
    expect(readCandidateSuppressionMeta(suppressedItem!)?.reasonType).toBe('restraint_policy');
    expect(readCandidateSuppressionMeta(suppressedItem!)?.reasonDetail).toContain('0.93 > 0.80');
    expect(readCandidateSuppressionMeta(suppressedItem!)?.preferredConfidence).toBe(0.93);
    expect(readCandidateSuppressionMeta(suppressedItem!)?.preferredCandidateId).toBe('evt-candidate-keep');
    expect(readCandidateSuppressionMeta(suppressedItem!)?.suppressedCandidateId).toBe('evt-candidate-drop');
    expect(readCandidateSuppressionMeta(suppressedItem!)?.hitEventId).toBe('evt-private-hit');
    expect(readCalendarPatchApplyResultMeta(patchApplyItem!)?.eventType).toBe('calendar_patch_apply_result');
    expect(readCalendarPatchApplyResultMeta(patchApplyItem!)?.appliedCount).toBe(2);
    expect(readCalendarPatchApplyResultMeta(patchApplyItem!)?.skippedReasonCounts?.chain_group_blocked).toBe(1);
    expect(readCalendarPatchApplyResultMeta(patchApplyItem!)?.modelArbitration?.applied).toBe(true);
  });

  it('parses calendar patch apply model arbitration and skipped reason breakdown robustly', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-patch-apply-model',
        conversationId: 'chat-1',
        kind: 'action_resolution',
        createdAt: 61,
        actorIds: ['host_moderator'],
        summary: '执行完成：应用 1，跳过 2，失败 0',
        visibility: 'public',
        payload: {
          eventType: 'calendar_patch_apply_result',
          appliedCount: 1,
          skippedCount: 2,
          failedCount: 0,
          queueCount: 3,
          persistedCount: 1,
          skippedReasonCounts: {
            duplicate_idempotency: 2,
            chain_group_blocked: 'x',
          },
          modelArbitration: {
            attempted: true,
            applied: false,
            selectedIndependentCount: 3,
          },
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, [{ id: 'host_moderator', name: '主持人' }] as never, 'host_moderator', 'moderator')).runtimeTimeline;
    const item = timeline.find((entry) => entry.event?.id === 'evt-patch-apply-model');
    const meta = readCalendarPatchApplyResultMeta(item!);
    expect(meta?.eventType).toBe('calendar_patch_apply_result');
    expect(meta?.skippedReasonCounts?.duplicate_idempotency).toBe(2);
    expect(meta?.skippedReasonCounts?.chain_group_blocked).toBeUndefined();
    expect(meta?.modelArbitration?.attempted).toBe(true);
    expect(meta?.modelArbitration?.applied).toBe(false);
    expect(meta?.modelArbitration?.selectedIndependentCount).toBe(3);
  });

  it('projects moment, outing, status-update, conflict, and gift backflow as social event effect metadata', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      runtimeEventsV2: [{
        id: 'evt-moment-effect',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 13,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '动态回流：甲 发了一条动态，记录了刚才的开心时刻。',
        visibility: 'derived_public',
        payload: {
          eventKind: 'post_moment',
          effectType: 'artifact',
          summary: '动态回流：甲 发了一条动态，记录了刚才的开心时刻。',
          confidence: 0.86,
        },
      }, {
        id: 'evt-outing-effect',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 14,
        actorIds: ['a'],
        targetIds: ['a', 'b'],
        summary: '活动回流：甲、乙 参与了刚才提到的吃火锅。',
        visibility: 'derived_public',
        payload: {
          eventKind: 'social_outing',
          effectType: 'artifact',
          summary: '活动回流：甲、乙 参与了刚才提到的吃火锅。',
          confidence: 0.88,
        },
      }, {
        id: 'evt-status-effect',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 15,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '状态回流：甲 在群里同步了自己的近况。',
        visibility: 'derived_public',
        payload: {
          eventKind: 'status_update',
          effectType: 'artifact',
          summary: '状态回流：甲 在群里同步了自己的近况。',
          confidence: 0.87,
        },
      }, {
        id: 'evt-conflict-effect',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 16,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '冲突回流：甲 把刚才的不满直接摊开说了。',
        visibility: 'derived_public',
        payload: {
          eventKind: 'conflict_expression',
          effectType: 'artifact',
          summary: '冲突回流：甲 把刚才的不满直接摊开说了。',
          confidence: 0.89,
        },
      }, {
        id: 'evt-gift-effect',
        conversationId: 'chat-1',
        kind: 'relationship_delta',
        createdAt: 17,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: '礼物回流：甲 刚刚送出了一个小礼物或心意。',
        visibility: 'derived_public',
        payload: {
          eventKind: 'gift_exchange',
          effectType: 'artifact',
          summary: '礼物回流：甲 刚刚送出了一个小礼物或心意。',
          confidence: 0.88,
        },
      }],
    });
    const timeline = projectRuntimeState(chat, createProjectionContext(chat, openChatEngine.buildParticipants(chat), 'a', 'participant')).runtimeTimeline;
    expect(timeline[0]?.meta?.socialEventEffect?.eventKind).toBe('post_moment');
    expect(timeline[1]?.meta?.socialEventEffect?.eventKind).toBe('social_outing');
    expect(timeline[2]?.meta?.socialEventEffect?.eventKind).toBe('status_update');
    expect(timeline[3]?.meta?.socialEventEffect?.eventKind).toBe('conflict_expression');
    expect(timeline[4]?.meta?.socialEventEffect?.eventKind).toBe('gift_exchange');
    expect(timeline[0]?.meta?.socialEventCluster?.stage).toBe('effect');
    expect(timeline[1]?.meta?.socialEventCluster?.stage).toBe('effect');
    expect(timeline[2]?.meta?.socialEventCluster?.stage).toBe('effect');
    expect(timeline[3]?.meta?.socialEventCluster?.stage).toBe('effect');
    expect(timeline[4]?.meta?.socialEventCluster?.stage).toBe('effect');
  });

  it('projects open_chat private-thread action schema in group chats', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-1',
      type: 'group',
      memberIds: ['a', 'b', 'c'],
    });
    const context = createProjectionContext(chat, openChatEngine.buildParticipants(chat));
    const schema = projectActionSchema(openChatEngine, context);
    expect(schema?.actions.some((action) => action.type === 'start_private_thread')).toBe(true);
  });

  it('uses real member names for injected private-thread action fields', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-1',
      type: 'group',
      memberIds: ['a', 'b'],
    });
    const actions = buildProjectedSessionActions(chat, [], [{ id: 'a', name: '喜羊羊' }, { id: 'b', name: '灰太狼' }] as never);
    const action = actions.find((item) => item.type === 'start_private_thread');
    expect(action?.fields?.[0]?.options).toEqual([
      { value: 'a', label: '喜羊羊' },
      { value: 'b', label: '灰太狼' },
    ]);
  });

  it('filters injected private-thread options to current chat members only', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-1',
      type: 'group',
      memberIds: ['a', 'b'],
    });
    const actions = buildProjectedSessionActions(chat, [], [
      { id: 'a', name: '喜羊羊' },
      { id: 'b', name: '灰太狼' },
      { id: 'c', name: '沸羊羊' },
    ] as never);
    const action = actions.find((item) => item.type === 'start_private_thread');
    const actorOptions = action?.fields?.find((field) => field.key === 'actorId')?.options || [];
    expect(actorOptions).toEqual([
      { value: 'a', label: '喜羊羊' },
      { value: 'b', label: '灰太狼' },
    ]);
  });

  it('does not inject private-thread action when available AI members are fewer than two', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-1',
      type: 'group',
      memberIds: ['a'],
    });
    const actions = buildProjectedSessionActions(chat, [], [{ id: 'a', name: '喜羊羊' }] as never);
    expect(actions.some((item) => item.type === 'start_private_thread')).toBe(false);
  });

  it('injects attention follow-up user actions in group chats and keeps existing schema actions', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-attention-1',
      type: 'group',
      memberIds: ['user', 'a', 'b'],
      runtimeEventsV2: [{
        id: 'att-a',
        conversationId: 'group-attention-1',
        kind: 'attention_candidate',
        createdAt: 101,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 想跟进用户',
        visibility: 'derived_public',
        payload: { reason: '用户刚点名 a', confidence: 0.9, targetIds: ['user'] },
      }, {
        id: 'att-b',
        conversationId: 'group-attention-1',
        kind: 'attention_candidate',
        createdAt: 102,
        actorIds: ['b'],
        targetIds: ['user'],
        summary: 'b 想跟进用户',
        visibility: 'derived_public',
        payload: { reason: '用户对 b 有疑问', confidence: 0.82, targetIds: ['user'] },
      }],
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 7, trust: 6, competence: 5, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 100,
      }, {
        pairKey: 'b->user',
        actorId: 'b',
        targetId: 'user',
        current: { warmth: 5, trust: 4, competence: 5, threat: 2 },
        trend: 'flat',
        recentEvents: [],
        lastUpdatedAt: 100,
      }],
    });
    const actions = buildProjectedSessionActions(chat, [{
      type: 'start_private_thread',
      label: '发起 AI 私聊',
      fields: [{ key: 'actorId', label: '发起者', type: 'single_select' }],
    }], [{ id: 'a', name: '喜羊羊' }, { id: 'b', name: '灰太狼' }] as never, new Date('2026-05-29T14:00:00+08:00').getTime());

    expect(actions[0]?.type).toBe('start_private_thread');
    const followups = actions.filter((action) => action.type === 'attention_followup_user');
    expect(followups).toHaveLength(2);
    expect(followups.map((action) => action.actorId)).toEqual(['a', 'b']);
    expect(followups[0]?.visibility).toBe('moderator_only');
    expect(followups[0]?.description).toContain('优先动作：');
    expect(followups[0]?.description).toContain('触发原因：');
  });

  it('dedupes injected attention follow-up actions against existing schema actions', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-attention-2',
      type: 'group',
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'att-a',
        conversationId: 'group-attention-2',
        kind: 'attention_candidate',
        createdAt: 101,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 想跟进用户',
        visibility: 'derived_public',
        payload: { reason: '用户刚点名 a', confidence: 0.9, targetIds: ['user'] },
      }],
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, trust: 7, competence: 6, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 100,
      }],
    });
    const actions = buildProjectedSessionActions(chat, [{
      type: 'attention_followup_user',
      actorId: 'a',
      label: '已有跟进动作',
      visibility: 'moderator_only',
    }], [{ id: 'a', name: '喜羊羊' }] as never, new Date('2026-05-29T14:00:00+08:00').getTime());

    expect(actions.filter((action) => action.type === 'attention_followup_user' && action.actorId === 'a')).toHaveLength(1);
  });

  it('keeps explicit now=0 when projecting attention follow-up actions', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-attention-now-zero',
      type: 'group',
      memberIds: ['user', 'a'],
      runtimeEventsV2: [{
        id: 'att-a-zero',
        conversationId: 'group-attention-now-zero',
        kind: 'attention_candidate',
        createdAt: 0,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 想跟进用户',
        visibility: 'derived_public',
        payload: { reason: '用户刚点名 a', confidence: 0.9, targetIds: ['user'] },
      }],
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, trust: 7, competence: 6, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 0,
      }],
    });
    const actions = buildProjectedSessionActions(chat, [], [{ id: 'a', name: '喜羊羊' }] as never, 0);
    expect(actions.some((action) => action.type === 'attention_followup_user' && action.actorId === 'a')).toBe(true);
  });

  it('does not inject attention follow-up actions when user is not a group member', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-attention-no-user',
      type: 'group',
      memberIds: ['a', 'b'],
      runtimeEventsV2: [{
        id: 'att-a',
        conversationId: 'group-attention-no-user',
        kind: 'attention_candidate',
        createdAt: 101,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 想跟进用户',
        visibility: 'derived_public',
        payload: { reason: '用户刚点名 a', confidence: 0.9, targetIds: ['user'] },
      }],
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, trust: 7, competence: 6, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 100,
      }],
    });
    const actions = buildProjectedSessionActions(chat, [], [{ id: 'a', name: '喜羊羊' }, { id: 'b', name: '灰太狼' }] as never, new Date('2026-05-29T14:00:00+08:00').getTime());
    expect(actions.some((action) => action.type === 'attention_followup_user')).toBe(false);
  });

  it('injects attention follow-up member actions for ai-to-ai attention states', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-attention-member',
      type: 'group',
      memberIds: ['a', 'b', 'c'],
      runtimeEventsV2: [{
        id: 'att-a-b',
        conversationId: 'group-attention-member',
        kind: 'attention_candidate',
        createdAt: 201,
        actorIds: ['a'],
        targetIds: ['b'],
        summary: 'a 想跟进 b',
        visibility: 'derived_public',
        payload: { reason: 'a 刚回应了 b 的观点', confidence: 0.9, targetIds: ['b'] },
      }],
      relationshipLedger: [{
        pairKey: 'a->b',
        actorId: 'a',
        targetId: 'b',
        current: { warmth: 7, trust: 6, competence: 5, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 200,
      }],
    });
    const actions = buildProjectedSessionActions(chat, [], [{ id: 'a', name: '喜羊羊' }, { id: 'b', name: '灰太狼' }, { id: 'c', name: '沸羊羊' }] as never, new Date('2026-05-29T14:00:00+08:00').getTime());
    const followup = actions.find((action) => action.type === 'attention_followup_member' && action.actorId === 'a');
    expect(followup).toBeTruthy();
    expect(followup?.label).toContain('跟进');
    const targetField = followup?.fields?.find((field) => field.key === 'targetId');
    expect(targetField?.options?.[0]).toEqual({ value: 'b', label: '灰太狼' });
  });

  it('sanitizes attention follow-up action reason text in descriptions', () => {
    const uuid = 'e055aa1d-88d4-4e96-abd2-1b35a3d56f67';
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-attention-sanitize',
      type: 'group',
      memberIds: ['user', 'a'],
      runtimeEventsV2: [{
        id: 'att-a-sanitize',
        conversationId: 'group-attention-sanitize',
        kind: 'attention_candidate',
        createdAt: 101,
        actorIds: ['a'],
        targetIds: ['user'],
        summary: 'a 想跟进用户',
        visibility: 'derived_public',
        payload: { reason: `${uuid} {"eventType":"room_state_snapshot_v2"} user 点名 a`, confidence: 0.9, targetIds: ['user'] },
      }],
      relationshipLedger: [{
        pairKey: 'a->user',
        actorId: 'a',
        targetId: 'user',
        current: { warmth: 8, trust: 7, competence: 6, threat: 1 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 100,
      }],
    });
    const actions = buildProjectedSessionActions(chat, [], [{ id: 'a', name: '喜羊羊' }] as never, new Date('2026-05-29T14:00:00+08:00').getTime());
    const followup = actions.find((action) => action.type === 'attention_followup_user' && action.actorId === 'a');
    expect(followup?.description).toContain('系统事件');
    expect(followup?.description).toContain('我');
    expect(followup?.description).not.toContain(uuid);
    expect(followup?.description).not.toContain('eventType');
  });

  it('labels direct private payloads as single-chat information', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'direct-1',
      type: 'direct',
      memberIds: ['a'],
    });
    const state = buildProjectedChatDetailState({
      chat,
      members: [{ id: 'a', name: '喜羊羊' }] as never,
      runtimeState: null,
      privatePayloads: [{ key: 'ctx', title: '单聊上下文', text: '该单聊仅对当前用户与目标角色可见。' }],
      visiblePanels: [],
      schemaActions: [],
      rightPanelTab: 'world',
      frameworkState: projectSessionFrameworkState(chat),
    });

    expect(state.privatePayloadTitle).toBe('单聊信息');
    expect(state.sidebarChat.privatePayloads[0]?.title).toBe('单聊上下文');
    expect(state.sidebarChat.privatePayloads[0]?.title).not.toContain('私聊');
  });

  it('keeps the story chapter tab selected in projected sidebar state', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'story-1',
      type: 'group',
      sessionKind: { topology: 'group', family: 'simulation', scenarioId: 'story-reader', surfaceProfile: 'text' },
      scenarioState: {
        phase: 'scene',
        storyChapters: [{
          id: 'story-1:chapter:1',
          index: 1,
          title: '枕下长剑',
          status: 'active',
          startMessageId: 'm1',
          startBeatId: 'beat-1',
          openedAt: 1,
        }],
      },
    });
    const state = buildProjectedChatDetailState({
      chat,
      members: [{ id: 'a', name: '沈清婉' }] as never,
      runtimeState: null,
      privatePayloads: [],
      visiblePanels: [
        { key: 'members', title: '成员', type: 'members', tabKey: 'members' },
        { key: 'runtime', title: '运行态', type: 'runtime', tabKey: 'world' },
      ],
      schemaActions: [],
      rightPanelTab: 'chapters',
      frameworkState: projectSessionFrameworkState(chat),
    });

    expect(state.activeSidebarTab).toBe('chapters');
    expect(state.sidebarTitle).toBe('章节');
    expect(state.showActionTab).toBe(false);
  });

  it('labels the narrative tab separately from runtime in projected sidebar state', () => {
    const chat = normalizeConversation({
      ...buildChat(),
      id: 'group-narrative',
      type: 'group',
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' },
    });
    const state = buildProjectedChatDetailState({
      chat,
      members: [{ id: 'a', name: '喜羊羊' }] as never,
      runtimeState: null,
      privatePayloads: [],
      visiblePanels: [
        { key: 'members', title: '成员', type: 'members', tabKey: 'members' },
        { key: 'runtime', title: '运行态', type: 'runtime', tabKey: 'world' },
      ],
      schemaActions: [],
      rightPanelTab: 'narrative',
      frameworkState: projectSessionFrameworkState(chat),
    });

    expect(state.activeSidebarTab).toBe('narrative');
    expect(state.sidebarTitle).toBe('叙事流');
  });
});
