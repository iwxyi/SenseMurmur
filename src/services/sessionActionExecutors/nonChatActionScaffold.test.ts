import { describe, expect, it } from 'vitest';
import { normalizeConversation, type GroupChat } from '../../types/chat';
import { executeNonChatActionScaffold } from './nonChatActionScaffold';

function buildInterviewChat() {
  return normalizeConversation({
    id: 'interview-1',
    type: 'group',
    mode: 'interview',
    modeConfig: {} as never,
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '面试',
    topic: '招聘',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['host', 'candidate-a'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: false },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: false, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

function buildWerewolfChat() {
  return normalizeConversation({
    id: 'werewolf-1',
    type: 'group',
    mode: 'werewolf',
    modeConfig: {} as never,
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '狼人杀',
    topic: '找狼',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['seer', 'villager-a', 'wolf-a', 'wolf-b'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: false },
    dramaRules: { allowCliques: true, allowMockery: true, allowAlliances: true, allowContempt: true },
    worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

function buildOpenChat() {
  return normalizeConversation({
    id: 'open-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '开放群聊',
    topic: '日常',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

function buildDiscussionChat() {
  return normalizeConversation({
    ...buildOpenChat(),
    id: 'discussion-1',
    mode: 'group_discussion',
    sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
    name: '观点审议',
    topic: '是否要重构推荐系统',
    scenarioState: {
      phase: 'deliberation',
      goals: [{ goalId: 'discussion-goal', label: '是否要重构推荐系统', status: 'active', progress: 0 }],
      progress: [{ key: 'speeches', label: '审议发言', value: 1, target: 4 }],
    },
    worldState: { phase: 'debating', mood: 'engaged', focus: '是否要重构推荐系统', recentEvent: '', conflictAxes: [] },
  });
}

function buildStudyChat() {
  return normalizeConversation({
    ...buildOpenChat(),
    id: 'study-1',
    mode: 'classroom',
    sessionKind: { topology: 'group', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' },
    name: '学习进步',
    topic: '掌握 Python 基础',
    scenarioState: {
      phase: 'mapping',
      learning: { goal: '掌握 Python 基础', teachingMode: 'serious', knowledgeItems: [] },
    },
  });
}

describe('executeNonChatActionScaffold', () => {
  it('executes the study engine goal-mapping, practice, and review actions', () => {
    const chat = buildStudyChat();
    const mapped = executeNonChatActionScaffold(chat, { type: 'map_learning_goal', payload: { goal: '掌握 Python 函数与列表' } });
    expect(mapped?.runtimeEvents?.[0]?.eventType).toBe('study_goal_mapped');
    expect(mapped?.chatPatch?.scenarioState?.learning?.goal).toContain('函数');
    const practiced = executeNonChatActionScaffold(chat, { type: 'create_learning_practice', payload: { focus: '列表推导式' } });
    expect(practiced?.runtimeEvents?.[0]?.eventType).toBe('study_practice_requested');
    expect(practiced?.chatPatch?.scenarioState?.learning?.lastStudyAction).toBe('practice');
    const reviewed = executeNonChatActionScaffold(chat, { type: 'review_learning_progress', payload: { focus: '最近错题' } });
    expect(reviewed?.chatPatch?.scenarioState?.phase).toBe('review');
    expect(reviewed?.runtimeEvents?.[0]?.eventType).toBe('study_review');
    const submitted = executeNonChatActionScaffold(chat, { type: 'submit_learning_attempt', payload: { artifactId: 'paper-1', answer: '1.B' } });
    expect(submitted?.runtimeEvents?.[0]?.eventType).toBe('study_attempt_submitted');
    const attemptId = submitted?.chatPatch?.scenarioState?.learning?.attempts?.[0]?.id || '';
    const graded = executeNonChatActionScaffold({ ...chat, scenarioState: submitted?.chatPatch?.scenarioState }, { type: 'grade_learning_attempt', payload: { attemptId, feedback: '第1题正确', score: 1, maxScore: 1 } });
    expect(graded?.runtimeEvents?.[0]?.eventType).toBe('study_attempt_graded');
    expect(graded?.chatPatch?.scenarioState?.learning?.attempts?.[0]?.status).toBe('graded');
  });

  it('turns ask_question into interview-flavored runtime output', () => {
    const result = executeNonChatActionScaffold(buildInterviewChat(), {
      type: 'ask_question',
      targetIds: ['candidate-a'],
      payload: { targetId: 'candidate-a', prompt: '请介绍一个你主导解决的复杂问题。', round: 1 },
    });
    expect(result?.chatPatch?.worldState?.recentEvent).toContain('提问');
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('interview_question');
    expect(result?.runtimeEvents?.[0]?.title).toContain('面试官发起提问');
  });

  it('turns director_intervention into interview phase control output', () => {
    const result = executeNonChatActionScaffold(buildInterviewChat(), {
      type: 'director_intervention',
      targetIds: ['candidate-a'],
      payload: { prompt: '进入追问轮次，要求回答更具体。', intent: 'force_reply', pressure: '0.95', maxTurns: '2' },
    });
    expect(result?.chatPatch?.worldState?.recentEvent).toContain('导演推进');
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('interview_phase_control');
    const structuredEvent = (result?.chatPatch as Partial<GroupChat> | undefined)?.runtimeEventsV2?.at(-1);
    expect(structuredEvent?.kind).toBe('director_intervention');
    expect(structuredEvent?.targetIds).toEqual(['candidate-a']);
    expect(structuredEvent?.payload).toMatchObject({ intent: 'force_reply', targetActorIds: ['candidate-a'], pressure: 0.95, maxTurns: 2 });
  });

  it('turns wolf_vote into night resolution output', () => {
    const result = executeNonChatActionScaffold(buildWerewolfChat(), {
      type: 'wolf_vote',
      targetIds: ['villager-a'],
      payload: { targetId: 'villager-a', prompt: '先处理发言最强势的。' },
    });
    expect(result?.chatPatch?.worldState?.phase).toBe('debating');
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('werewolf_night_action');
    expect(result?.runtimeEvents?.[0]?.title).toContain('夜晚袭击');
  });

  it('turns inspect_player into seer inspection output', () => {
    const result = executeNonChatActionScaffold(buildWerewolfChat(), {
      type: 'inspect_player',
      targetIds: ['wolf-a'],
      payload: { targetId: 'wolf-a' },
    });
    expect(result?.chatPatch?.worldState?.phase).toBe('warming');
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('werewolf_inspection');
    expect(result?.runtimeEvents?.[0]?.title).toContain('查验');
  });

  it('turns vote_player into day vote resolution output', () => {
    const result = executeNonChatActionScaffold(buildWerewolfChat(), {
      type: 'vote_player',
      targetIds: ['wolf-b'],
      payload: { targetId: 'wolf-b', prompt: '他的站边前后矛盾。' },
    });
    expect(result?.chatPatch?.worldState?.phase).toBe('aligned');
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('werewolf_vote');
    expect(result?.runtimeEvents?.[0]?.title).toContain('白天投票');
  });

  it('rejects start_private_thread when actor/target are invalid in current chat', () => {
    const chat = buildOpenChat();
    const sameActorTarget = executeNonChatActionScaffold(chat, {
      type: 'start_private_thread',
      actorId: 'a',
      targetIds: ['a'],
      payload: { actorId: 'a', targetId: 'a' },
    });
    const outsiderTarget = executeNonChatActionScaffold(chat, {
      type: 'start_private_thread',
      actorId: 'a',
      targetIds: ['outsider'],
      payload: { actorId: 'a', targetId: 'outsider' },
    });
    const missingActor = executeNonChatActionScaffold(chat, {
      type: 'start_private_thread',
      targetIds: ['b'],
      payload: { targetId: 'b' },
    });
    expect(sameActorTarget).toBeNull();
    expect(outsiderTarget).toBeNull();
    expect(missingActor).toBeNull();
  });

  it('rejects start_private_thread when actor is inferred as system agent', () => {
    const chat = normalizeConversation({
      ...buildOpenChat(),
      memberIds: ['host_moderator', 'a', 'b'],
    });
    const result = executeNonChatActionScaffold(chat, {
      type: 'start_private_thread',
      actorId: 'host_moderator',
      targetIds: ['a'],
      payload: { actorId: 'host_moderator', targetId: 'a' },
    });
    expect(result).toBeNull();
  });

  it('mutes and unmutes a member through governance actions', () => {
    const muted = executeNonChatActionScaffold(buildOpenChat(), {
      type: 'mute_member',
      targetIds: ['b'],
      payload: { targetId: 'b', prompt: '本轮先听其他人' },
    });
    expect(muted?.chatPatch?.scenarioState?.seats?.find((seat) => seat.actorId === 'b')).toEqual(
      { seatId: 'seat-2', seatIndex: 1, actorId: 'b', muted: true, canSpeak: false },
    );
    expect(muted?.runtimeEvents?.[0]?.eventType).toBe('member_muted');

    const unmuted = executeNonChatActionScaffold(normalizeConversation({
      ...buildOpenChat(),
      scenarioState: { seats: [{ seatId: 'seat-b', seatIndex: 1, actorId: 'b', muted: true, canSpeak: false }] },
    }), {
      type: 'unmute_member',
      targetIds: ['b'],
      payload: { targetId: 'b', prompt: '恢复参与' },
    });
    expect(unmuted?.chatPatch?.scenarioState?.seats?.find((seat) => seat.actorId === 'b')).toEqual(
      { seatId: 'seat-b', seatIndex: 1, actorId: 'b', muted: false, canSpeak: true },
    );
    expect(unmuted?.runtimeEvents?.[0]?.eventType).toBe('member_unmuted');
  });

  it('rejects mute actions from ordinary members but allows group admins', () => {
    const chat = normalizeConversation({
      ...buildOpenChat(),
      governance: { ownerCharacterId: 'a', adminCharacterIds: ['b'], autoModeration: false, allowMute: true, allowPrivateThreads: true },
      memberIds: ['a', 'b', 'c'],
    });
    const ordinaryMember = executeNonChatActionScaffold(chat, {
      type: 'mute_member',
      actorId: 'c',
      targetIds: ['a'],
      payload: { actorId: 'c', targetId: 'a' },
    });
    const adminMember = executeNonChatActionScaffold(chat, {
      type: 'mute_member',
      actorId: 'b',
      targetIds: ['c'],
      payload: { actorId: 'b', targetId: 'c' },
    });

    expect(ordinaryMember).toBeNull();
    expect(adminMember?.chatPatch?.scenarioState?.seats?.find((seat) => seat.actorId === 'c')?.muted).toBe(true);
  });

  it('rejects target-required actions when target is outside current chat', () => {
    const chat = buildInterviewChat();
    const askQuestion = executeNonChatActionScaffold(chat, {
      type: 'ask_question',
      targetIds: ['outsider'],
      payload: { targetId: 'outsider', prompt: '请介绍项目经历' },
    });
    const votePlayer = executeNonChatActionScaffold(buildWerewolfChat(), {
      type: 'vote_player',
      targetIds: ['outsider'],
      payload: { targetId: 'outsider', prompt: '站边异常' },
    });
    expect(askQuestion).toBeNull();
    expect(votePlayer).toBeNull();
  });

  it('rejects director_intervention when target is outside current chat', () => {
    const result = executeNonChatActionScaffold(buildInterviewChat(), {
      type: 'director_intervention',
      targetIds: ['outsider'],
      payload: { prompt: '进入追问轮次', intent: 'force_reply' },
    });
    expect(result).toBeNull();
  });

  it('builds deterministic director_intervention runtime event id when timestamp is fixed', () => {
    const action = {
      type: 'director_intervention' as const,
      targetIds: ['candidate-a'],
      payload: {
        prompt: '进入追问轮次，要求回答更具体。',
        intent: 'force_reply',
        pressure: '0.95',
        maxTurns: '2',
        createdAt: 1_717_000_123_000,
      },
    };
    const first = executeNonChatActionScaffold(buildInterviewChat(), action);
    const second = executeNonChatActionScaffold(buildInterviewChat(), action);

    const firstId = (first?.chatPatch as Partial<GroupChat> | undefined)?.runtimeEventsV2?.at(-1)?.id;
    const secondId = (second?.chatPatch as Partial<GroupChat> | undefined)?.runtimeEventsV2?.at(-1)?.id;
    expect(firstId).toBeTruthy();
    expect(firstId).toBe(secondId);
  });

  it('switches deliberation to synthesis with a narrow chat patch', () => {
    const result = executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'shift_to_synthesis',
    });

    expect(result?.chatPatch).toEqual({
      scenarioState: expect.objectContaining({ phase: 'synthesis' }),
      worldState: expect.objectContaining({ phase: 'aligned', recentEvent: '手动切换到结论整理' }),
    });
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('discussion_phase_shift');
  });

  it('stores deliberation summary text in synthesis state', () => {
    const result = executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'summarize_discussion',
      payload: { focus: '共识是先拆召回层，分歧是是否同时改排序层。' },
    });

    expect(result?.chatPatch?.scenarioState).toMatchObject({
      phase: 'synthesis',
      summaryText: '共识是先拆召回层，分歧是是否同时改排序层。',
    });
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('discussion_summary');
  });

  it('submits deliberation evidence into scenario state', () => {
    const result = executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'submit_evidence',
      payload: { evidenceText: '过去三次推荐事故都发生在召回层补丁后。' },
    });

    expect(result?.chatPatch?.scenarioState?.deliberationEvidence?.[0]).toMatchObject({
      actorId: 'user',
      text: '过去三次推荐事故都发生在召回层补丁后。',
    });
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('deliberation_evidence_submitted');
  });

  it('records deliberation verdicts into scenario state', () => {
    const result = executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'record_verdict',
      payload: { verdictText: '暂不做最终裁决，先要求反方补充迁移成本量化。' },
    });

    expect(result?.chatPatch?.scenarioState?.deliberationVerdicts?.[0]).toMatchObject({
      actorId: 'user',
      text: '暂不做最终裁决，先要求反方补充迁移成本量化。',
      tendency: 'mixed',
    });
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('deliberation_verdict_recorded');
  });

  it('turns deliberation inquiry into runtime pressure for the target member', () => {
    const result = executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'question_member',
      targetIds: ['b'],
      payload: { targetId: 'b', prompt: '请直接回应排序层风险为什么不能后置。' },
    });

    expect(result?.chatPatch?.worldState?.recentEvent).toContain('审议质询');
    expect(result?.runtimeEvents?.[0]?.eventType).toBe('discussion_inquiry');
    expect(result?.runtimeEvents?.[0]?.title).toBe('质询成员');
    const structuredEvent = (result?.chatPatch as Partial<GroupChat> | undefined)?.runtimeEventsV2?.at(-1);
    expect(structuredEvent?.kind).toBe('director_intervention');
    expect(structuredEvent?.targetIds).toEqual(['b']);
    expect(structuredEvent?.payload).toMatchObject({
      intent: 'force_reply',
      text: '请直接回应排序层风险为什么不能后置。',
      maxTurns: 1,
    });
  });

  it('rejects deliberation inquiry without target or prompt', () => {
    expect(executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'question_member',
      payload: { prompt: '请回应' },
    })).toBeNull();
    expect(executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'question_member',
      targetIds: ['b'],
      payload: { targetId: 'b' },
    })).toBeNull();
    expect(executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'submit_evidence',
      payload: { evidenceText: '' },
    })).toBeNull();
    expect(executeNonChatActionScaffold(buildDiscussionChat(), {
      type: 'record_verdict',
      payload: { verdictText: '' },
    })).toBeNull();
  });
});
