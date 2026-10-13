import type { GroupChat } from '../../types/chat';
import type { DirectorInterventionPayload, RuntimeEventV2 } from '../../types/runtimeEvent';
import type { SessionActionDefinition, SessionActionExecutionResult } from '../../types/sessionEngine';
import { buildStartPrivateThreadExecutionResult } from '../directSessionRuntime';
import { canUseMute, canUsePrivateThreads } from '../conversationCapabilities';
import { canActorRunSessionAction, resolveConversationActorRef } from '../memberActionPolicy';
import { buildActionRuntimeContract } from '../sessionRuntimeContract';
import { sanitizeStoryChoicePrompt } from '../storyChoices';
import { recordLearningAttempt } from '../learningProgressRuntime';
import { deriveLearningNextStep } from '../learningNextStep';
import { retainRuntimeEvents } from '../runtimeEventRetention';

function truncate(text: string, maxLength: number) {
  const normalized = text.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function getTargetLabel(chat: GroupChat, action: SessionActionDefinition) {
  const targetId = typeof action.payload?.targetId === 'string' ? action.payload.targetId : action.targetIds?.[0];
  if (!targetId) return '';
  const index = chat.memberIds.indexOf(targetId);
  if (index === -1) return '';
  return ` → 对象#${index + 1}`;
}

function buildActionResult(chat: GroupChat, action: SessionActionDefinition, title: string, summary: string, eventType = 'session_action_scaffold', metrics?: Record<string, unknown>): SessionActionExecutionResult {
  const actorId = typeof action.payload?.actorId === 'string' ? action.payload.actorId : action.actorId;
  return {
    chatPatch: {
      worldState: {
        ...chat.worldState,
        recentEvent: summary,
      },
    },
    runtimeEvents: [buildActionRuntimeContract(chat, action.type, action.payload || {}, actorId, {
      eventType,
      title,
      summary,
      metrics: {
        ...(metrics || {}),
        _actorAudit: {
          actorId: actorId || null,
          origin: actorId ? (chat.memberIds.includes(actorId) ? 'member' : (chat.operatorIds || []).includes(actorId) ? 'operator' : 'external') : 'unknown',
          isOperator: Boolean(actorId && (chat.operatorIds || []).includes(actorId)),
        },
      },
      visibilityScope: action.visibility || 'public',
    })],
  };
}

function getPrompt(action: SessionActionDefinition) {
  return typeof action.payload?.prompt === 'string' ? action.payload.prompt : '';
}

function getPayloadText(action: SessionActionDefinition, key: string) {
  const value = action.payload?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stableEventSeed(parts: Array<string | number | undefined>) {
  const joined = parts.filter((item) => item !== undefined && item !== null && String(item).length > 0).join('|');
  let hash = 0;
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 31 + joined.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function prepareAction(action: SessionActionDefinition) {
  const targetId = typeof action.payload?.targetId === 'string' ? action.payload.targetId : undefined;
  return {
    ...action,
    targetIds: action.targetIds?.length ? action.targetIds : targetId ? [targetId] : [],
  };
}

function validateAction(action: SessionActionDefinition) {
  if ((action.type === 'ask_question' || action.type === 'question_member' || action.type === 'director_intervention') && !getPrompt(action)) return false;
  if (action.type === 'submit_evidence' && !getPayloadText(action, 'evidenceText')) return false;
  if (action.type === 'record_verdict' && !getPayloadText(action, 'verdictText')) return false;
  if (action.type === 'submit_learning_attempt' && (!getPayloadText(action, 'artifactId') || !getPayloadText(action, 'answer'))) return false;
  if (action.type === 'grade_learning_attempt' && !getPayloadText(action, 'attemptId')) return false;
  if (['ask_question', 'question_member', 'start_private_thread', 'wolf_vote', 'inspect_player', 'vote_player', 'mute_member', 'unmute_member'].includes(action.type) && !(action.targetIds?.length)) return false;
  return true;
}

function canActorExecuteAction(chat: GroupChat, action: SessionActionDefinition) {
  const actorId = typeof action.payload?.actorId === 'string' ? action.payload.actorId : action.actorId;
  if (!actorId) return true;
  if (action.type === 'choose_story_branch' && actorId === 'user') return true;
  if (action.type === 'mute_member' || action.type === 'unmute_member') {
    if (actorId === 'user') return true;
    if (actorId === chat.governance.ownerCharacterId) return true;
    if (chat.governance.adminCharacterIds.includes(actorId)) return true;
    const memberSet = new Set(chat.memberIds);
    const aiIds = new Set(
      chat.memberIds.filter((id) => id !== 'user' && !/([_:-]|^)(gm|game|game_master|judge|referee|host|mc|主持|guide|guidance|topic|facilitator|引导|narrator|旁白|director|god|上帝|导演|moderator|mod|管理|system|orchestrator|scheduler|runtime)([_:-]|$)/i.test(id)),
    );
    const actorRef = resolveConversationActorRef(actorId, memberSet, aiIds);
    return canActorRunSessionAction(action.type, actorRef);
  }
  const memberSet = new Set(chat.memberIds);
  const aiIds = new Set(
    chat.memberIds.filter((id) => id !== 'user' && !/([_:-]|^)(gm|game|game_master|judge|referee|host|mc|主持|guide|guidance|topic|facilitator|引导|narrator|旁白|director|god|上帝|导演|moderator|mod|管理|system|orchestrator|scheduler|runtime)([_:-]|$)/i.test(id)),
  );
  const actorRef = resolveConversationActorRef(actorId, memberSet, aiIds);
  return canActorRunSessionAction(action.type, actorRef);
}

function validateTargetIdsInConversation(chat: GroupChat, action: SessionActionDefinition) {
  const requiresTargets = ['ask_question', 'question_member', 'start_private_thread', 'wolf_vote', 'inspect_player', 'vote_player', 'mute_member', 'unmute_member'].includes(action.type);
  if (!requiresTargets) return true;
  const memberSet = new Set(chat.memberIds);
  return (action.targetIds || []).every((id) => memberSet.has(id));
}

function validateMemberMuteAction(chat: GroupChat, action: SessionActionDefinition) {
  if (action.type !== 'mute_member' && action.type !== 'unmute_member') return true;
  if (!canUseMute(chat)) return false;
  const targetId = action.targetIds?.[0] || '';
  return Boolean(targetId && targetId !== 'user' && chat.memberIds.includes(targetId));
}

function validateDirectorInterventionTarget(chat: GroupChat, action: SessionActionDefinition) {
  if (action.type !== 'director_intervention') return true;
  if (!action.targetIds?.length) return true;
  const memberSet = new Set(chat.memberIds);
  return action.targetIds.every((id) => memberSet.has(id));
}

function validateStartPrivateThread(chat: GroupChat, action: SessionActionDefinition) {
  if (!canUsePrivateThreads(chat)) return false;
  const targetId = typeof action.payload?.targetId === 'string' ? action.payload.targetId : action.targetIds?.[0] || '';
  const actorId = typeof action.payload?.actorId === 'string' ? action.payload.actorId : action.actorId || '';
  if (!actorId || !targetId || actorId === targetId) return false;
  const memberSet = new Set(chat.memberIds);
  if (!memberSet.has(actorId) || !memberSet.has(targetId)) return false;
  return true;
}

function buildPhasePatch(chat: GroupChat, phase: GroupChat['worldState']['phase'], recentEvent: string) {
  return {
    worldState: {
      ...chat.worldState,
      phase,
      recentEvent,
    },
  };
}

function resolveDirectorInterventionIntent(value: unknown): DirectorInterventionPayload['intent'] {
  const allowed: DirectorInterventionPayload['intent'][] = ['force_reply', 'escalate', 'cool_down', 'inject_event', 'summarize', 'reveal', 'redirect'];
  if (typeof value === 'string' && allowed.includes(value as DirectorInterventionPayload['intent'])) return value as DirectorInterventionPayload['intent'];
  return 'inject_event';
}

function buildDirectorInterventionRuntimeEvent(chat: GroupChat, action: SessionActionDefinition, summary: string): RuntimeEventV2 {
  const prompt = getPrompt(action);
  const targetActorIds = action.targetIds || [];
  const requestedCreatedAt = readNumber(action.payload?.createdAt) ?? readNumber(action.payload?.timestamp);
  const now = typeof requestedCreatedAt === 'number' ? Math.round(requestedCreatedAt) : Date.now();
  const requestedMaxTurns = readNumber(action.payload?.maxTurns);
  const maxTurns = typeof requestedMaxTurns === 'number' ? Math.max(1, Math.min(5, Math.round(requestedMaxTurns))) : 1;
  const requestedExpiresAt = readNumber(action.payload?.expiresAt);
  const requestedPressure = readNumber(action.payload?.pressure);
  const payload: DirectorInterventionPayload = {
    intent: resolveDirectorInterventionIntent(action.payload?.intent),
    targetActorIds,
    targetLineId: typeof action.payload?.targetLineId === 'string' ? action.payload.targetLineId : undefined,
    pressure: typeof requestedPressure === 'number' ? Math.max(0, Math.min(1, requestedPressure)) : 0.9,
    text: prompt || summary,
    maxTurns,
    expiresAt: typeof requestedExpiresAt === 'number' ? requestedExpiresAt : now + 10 * 60_000,
  };
  const seed = stableEventSeed([chat.id, action.type, now, payload.intent, action.actorId || 'user', targetActorIds.join(','), payload.text]);
  return {
    id: `evt_${now}_${seed}`,
    conversationId: chat.id,
    kind: 'director_intervention',
    createdAt: now,
    actorIds: action.actorId ? [action.actorId] : ['user'],
    targetIds: targetActorIds,
    summary,
    channelId: 'moderator',
    eventClass: 'action',
    visibility: action.visibility || 'moderator_only',
    payload,
  };
}

function handleAskQuestion(chat: GroupChat, action: SessionActionDefinition) {
  const summary = `提问${getTargetLabel(chat, action)}：${truncate(getPrompt(action), 48)}`;
  return buildActionResult(chat, action, '面试官发起提问', summary, 'interview_question', { targetIds: action.targetIds || [], round: action.payload?.round });
}

function handleDirectorIntervention(chat: GroupChat, action: SessionActionDefinition) {
  const prompt = getPrompt(action);
  const summary = prompt ? `导演推进：${truncate(prompt, 48)}` : '执行了导演推进';
  const result = buildActionResult(chat, action, '面试阶段推进', summary, 'interview_phase_control', { prompt });
  const event = buildDirectorInterventionRuntimeEvent(chat, action, summary);
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      runtimeEventsV2: retainRuntimeEvents([...(chat.runtimeEventsV2 || []), event], 160),
    },
  };
}

function handleStartPrivateThread(chat: GroupChat, action: SessionActionDefinition) {
  const targetId = typeof action.payload?.targetId === 'string' ? action.payload.targetId : action.targetIds?.[0] || '';
  const actorId = typeof action.payload?.actorId === 'string' ? action.payload.actorId : action.actorId || '';
  return buildStartPrivateThreadExecutionResult(chat, actorId, targetId, getPrompt(action));
}

function buildSeatsWithMuteState(chat: GroupChat, targetId: string, muted: boolean) {
  const existingSeats = chat.scenarioState?.seats || [];
  const existingSeat = existingSeats.find((seat) => seat.actorId === targetId);
  const nextSeat = {
    ...(existingSeat || {
      seatId: `seat-${Math.max(1, chat.memberIds.indexOf(targetId) + 1)}`,
      seatIndex: Math.max(0, chat.memberIds.indexOf(targetId)),
      actorId: targetId,
    }),
    muted,
    canSpeak: !muted,
  };
  if (existingSeat) {
    return existingSeats.map((seat) => (seat.actorId === targetId ? nextSeat : seat));
  }
  return [...existingSeats, nextSeat];
}

function handleMemberMute(chat: GroupChat, action: SessionActionDefinition) {
  const targetId = action.targetIds?.[0] || '';
  const muted = action.type === 'mute_member';
  const prompt = getPrompt(action);
  const summary = `${muted ? '禁言' : '解除禁言'}${getTargetLabel(chat, action)}${prompt ? `：${truncate(prompt, 32)}` : ''}`;
  const result = buildActionResult(chat, action, muted ? '禁言成员' : '解除禁言', summary, muted ? 'member_muted' : 'member_unmuted', { targetId, prompt });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        seats: buildSeatsWithMuteState(chat, targetId, muted),
      },
    },
  };
}

function handleWolfVote(chat: GroupChat, action: SessionActionDefinition) {
  const prompt = getPrompt(action);
  const targetId = action.targetIds?.[0] || '';
  const summary = `狼人夜晚刀口${getTargetLabel(chat, action)}${prompt ? `：${truncate(prompt, 32)}` : ''}`;
  return {
    chatPatch: {
      ...buildPhasePatch(chat, 'debating', summary),
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'day_discussion',
        eliminatedActorId: targetId,
        lastNightTargetId: targetId,
      },
    },
    runtimeEvents: [buildActionRuntimeContract(chat, action.type, action.payload || {}, action.actorId, { eventType: 'werewolf_night_action', title: '狼人夜晚袭击结算', summary, metrics: { targetIds: action.targetIds || [], prompt }, visibilityScope: action.visibility || 'pair_private' })],
  };
}

function handleInspectPlayer(chat: GroupChat, action: SessionActionDefinition) {
  const targetId = action.targetIds?.[0] || '';
  const summary = `预言家查验${getTargetLabel(chat, action)}`;
  return {
    chatPatch: {
      ...buildPhasePatch(chat, 'warming', summary),
      scenarioState: {
        ...(chat.scenarioState || {}),
        lastInspectionTargetId: targetId,
      },
    },
    runtimeEvents: [buildActionRuntimeContract(chat, action.type, action.payload || {}, action.actorId, { eventType: 'werewolf_inspection', title: '预言家夜晚查验', summary, metrics: { targetIds: action.targetIds || [] }, visibilityScope: action.visibility || 'role_private' })],
  };
}

function handleVotePlayer(chat: GroupChat, action: SessionActionDefinition) {
  const prompt = getPrompt(action);
  const targetId = action.targetIds?.[0] || '';
  const summary = `白天投票${getTargetLabel(chat, action)}${prompt ? `：${truncate(prompt, 32)}` : ''}`;
  return {
    chatPatch: {
      ...buildPhasePatch(chat, 'aligned', summary),
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'vote_resolution',
        eliminatedActorId: targetId,
      },
    },
    runtimeEvents: [buildActionRuntimeContract(chat, action.type, action.payload || {}, action.actorId, { eventType: 'werewolf_vote', title: '白天投票推进', summary, metrics: { targetIds: action.targetIds || [], prompt }, visibilityScope: action.visibility || 'public' })],
  };
}

function handleStoryBranch(chat: GroupChat, action: SessionActionDefinition): SessionActionExecutionResult {
  const selectedBranchId = typeof action.payload?.branchId === 'string' ? action.payload.branchId : 'main';
  const prompt = getPrompt(action);
  const existingBranches = chat.scenarioState?.branches || [];
  const currentEpoch = Math.max(Number(chat.scenarioState?.choiceEpoch || 0), 1);
  const selectedBranch = existingBranches.find((branch) => (
    branch.branchId === selectedBranchId
    && Number(branch.choiceEpoch || currentEpoch) === currentEpoch
  ));
  const isCustom = selectedBranchId === '__custom_story_branch' || !selectedBranch;
  const branchId = isCustom ? `custom-${Date.now().toString(36)}` : selectedBranchId;
  const branchPrompt = sanitizeStoryChoicePrompt(prompt || selectedBranch?.prompt || selectedBranch?.description || selectedBranch?.label || '');
  const summary = `剧情分支：${isCustom ? '自定义走向' : branchId}${branchPrompt ? ` · ${truncate(branchPrompt, 36)}` : ''}`;
  const alreadySelected = !isCustom && chat.scenarioState?.choiceHistory?.some((choice) => (
    Number(choice.choiceEpoch || 0) === currentEpoch
    && (choice.branchId === branchId || (selectedBranch?.label && choice.label === selectedBranch.label))
  ));
  if (alreadySelected) {
    return buildActionResult(chat, action, '剧情分支已选择', summary, 'story_branch', {
      branchId,
      prompt: branchPrompt,
      duplicate: true,
    });
  }
  const selectedChoice = {
    branchId,
    label: selectedBranch?.label || branchPrompt || '自定义走向',
    prompt: branchPrompt,
    ...(selectedBranch?.intent ? { intent: selectedBranch.intent } : {}),
    ...(selectedBranch?.risk ? { risk: selectedBranch.risk } : {}),
    ...(selectedBranch?.reward ? { reward: selectedBranch.reward } : {}),
    choiceEpoch: currentEpoch,
    chosenAt: Date.now(),
  };
  const choiceHistory = [
    ...(chat.scenarioState?.choiceHistory || []),
    selectedChoice,
  ].slice(-12);
  const nextBranches = isCustom
    ? [
      ...existingBranches.map((branch) => ({
        ...branch,
        status: branch.status === 'chosen' || Number(branch.choiceEpoch || currentEpoch) === currentEpoch ? 'completed' as const : branch.status,
      })),
      { branchId, label: truncate(branchPrompt || '自定义走向', 18), description: branchPrompt, prompt: branchPrompt, status: 'chosen' as const, source: 'custom' as const, choiceEpoch: currentEpoch },
    ]
    : existingBranches.map((branch) => ({
      ...branch,
      status: branch.branchId === branchId && Number(branch.choiceEpoch || currentEpoch) === currentEpoch ? 'chosen' as const : branch.status === 'chosen' || Number(branch.choiceEpoch || currentEpoch) === currentEpoch ? 'completed' as const : branch.status,
    }));
  const result = buildActionResult(chat, action, '剧情分支推进', summary, 'story_branch', { branchId, prompt: branchPrompt, source: isCustom ? 'custom' : selectedBranch?.source });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'branch' as const,
        storyBeatKind: 'consequence' as const,
        storyChoicePolicy: 'forbid' as const,
        storyBeatReason: 'resolve selected branch before opening another choice',
        storyDirection: branchPrompt || chat.scenarioState?.storyDirection,
        sceneBeatCount: 0,
        choiceEpoch: currentEpoch,
        selectedChoiceEpoch: currentEpoch,
        selectedChoice,
        choiceHistory,
        branches: nextBranches.length
          ? nextBranches
          : [{ branchId, label: branchPrompt || chat.topic || '主线剧情', status: 'chosen' as const, prompt: branchPrompt, source: isCustom ? 'custom' as const : 'system' as const }],
      },
    },
  };
}

function handleStoryScene(chat: GroupChat, action: SessionActionDefinition) {
  const prompt = getPrompt(action);
  const summary = `剧情场景推进${prompt ? `：${truncate(prompt, 40)}` : ''}`;
  const result = buildActionResult(chat, action, '剧情场景推进', summary, 'story_scene', { prompt });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'scene',
        storyDirection: prompt || chat.scenarioState?.storyDirection,
        branches: (chat.scenarioState?.branches || []).map((branch) => ({
          ...branch,
          status: branch.status === 'chosen' ? 'completed' as const : branch.status,
        })),
      },
    },
  };
}

function handleAssignStudyTask(chat: GroupChat, action: SessionActionDefinition) {
  const task = typeof action.payload?.task === 'string' ? action.payload.task : getPrompt(action);
  const summary = `学习任务：${truncate(task, 48)}`;
  const result = buildActionResult(chat, action, '布置学习任务', summary, 'study_task', { task });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'learning',
      },
    },
  };
}

function handleMapLearningGoal(chat: GroupChat, action: SessionActionDefinition) {
  const goal = getPayloadText(action, 'goal') || getPrompt(action) || chat.topic || '当前学习目标';
  const summary = `整理知识点：${truncate(goal, 48)}`;
  const result = buildActionResult(chat, action, '整理学习目标', summary, 'study_goal_mapped', { goal });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'learning',
        learning: {
          ...(chat.scenarioState?.learning || {}),
          goal,
          lastStudyAction: 'map',
          knowledgeItems: chat.scenarioState?.learning?.knowledgeItems || [],
        },
      },
    },
  };
}

function handleCreateLearningPractice(chat: GroupChat, action: SessionActionDefinition) {
  const focus = getPayloadText(action, 'focus') || getPrompt(action) || '当前薄弱项';
  const summary = `生成学习练习：${truncate(focus, 48)}`;
  const result = buildActionResult(chat, action, '生成学习练习', summary, 'study_practice_requested', { focus });
  const learning = {
    ...(chat.scenarioState?.learning || { goal: chat.topic || '当前学习目标', knowledgeItems: [] }),
    lastStudyAction: 'practice' as const,
  };
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'learning',
        learning: { ...learning, nextStepSuggestion: learning.goal && learning.knowledgeItems ? deriveLearningNextStep(learning) : undefined },
      },
    },
  };
}

function handleSubmitLearningAttempt(chat: GroupChat, action: SessionActionDefinition) {
  const artifactId = getPayloadText(action, 'artifactId');
  const answer = getPayloadText(action, 'answer') || getPrompt(action);
  const attemptId = getPayloadText(action, 'attemptId') || `attempt-${Date.now()}`;
  const summary = `提交学习练习：${truncate(answer, 40)}`;
  const result = buildActionResult(chat, action, '提交学习练习', summary, 'study_attempt_submitted', { artifactId, attemptId });
  const patch = recordLearningAttempt(chat, { id: attemptId, artifactId, status: 'submitted', feedback: answer, createdAt: Date.now() });
  return { ...result, chatPatch: { ...result.chatPatch, ...(patch as Partial<GroupChat>) } };
}

function handleGradeLearningAttempt(chat: GroupChat, action: SessionActionDefinition) {
  const attemptId = getPayloadText(action, 'attemptId');
  const feedback = getPayloadText(action, 'feedback') || getPrompt(action);
  const score = typeof action.payload?.score === 'number' ? action.payload.score : undefined;
  const maxScore = typeof action.payload?.maxScore === 'number' ? action.payload.maxScore : undefined;
  const existing = chat.scenarioState?.learning?.attempts?.find((attempt) => attempt.id === attemptId);
  const attempt = { ...(existing || { id: attemptId || `attempt-${Date.now()}`, createdAt: Date.now() }), status: 'graded' as const, score, maxScore, feedback, gradedAt: Date.now() };
  const result = buildActionResult(chat, action, '批改学习练习', `批改结果：${truncate(feedback, 48)}`, 'study_attempt_graded', { attemptId: attempt.id, score, maxScore });
  const patch = recordLearningAttempt(chat, attempt);
  return { ...result, chatPatch: { ...result.chatPatch, ...(patch as Partial<GroupChat>) } };
}

function handleReviewProgress(chat: GroupChat, action: SessionActionDefinition) {
  const focus = typeof action.payload?.focus === 'string' ? action.payload.focus : getPrompt(action);
  const summary = `学习复盘：${truncate(focus, 48)}`;
  const result = buildActionResult(chat, action, '复盘学习进度', summary, 'study_review', { focus });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'review',
      },
    },
  };
}

function handleAssignAgentTask(chat: GroupChat, action: SessionActionDefinition) {
  const task = typeof action.payload?.task === 'string' ? action.payload.task : getPrompt(action);
  const summary = `分配任务：${truncate(task, 48)}`;
  const result = buildActionResult(chat, action, '分配Agent任务', summary, 'agent_task', { task });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'executing',
      },
    },
  };
}

function handleSummarizeWorkflow(chat: GroupChat, action: SessionActionDefinition) {
  const focus = typeof action.payload?.focus === 'string' ? action.payload.focus : getPrompt(action);
  const summary = `流程总结：${truncate(focus, 48)}`;
  const result = buildActionResult(chat, action, '总结工作流', summary, 'agent_summary', { focus });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'review',
      },
    },
  };
}

function handleBoardMove(chat: GroupChat, action: SessionActionDefinition) {
  const position = typeof action.payload?.position === 'string' ? action.payload.position : '';
  const move = typeof action.payload?.move === 'string' ? action.payload.move : '';
  const pieceId = typeof action.payload?.pieceId === 'string' ? action.payload.pieceId : '';
  const summary = `棋盘动作：${[pieceId, move, position].filter(Boolean).join(' / ') || '落子'}`;
  return buildActionResult(chat, action, '执行棋盘动作', summary, 'board_move', { position, move, pieceId });
}

function handleSearchClue(chat: GroupChat, action: SessionActionDefinition) {
  const clueId = typeof action.payload?.clueId === 'string' ? action.payload.clueId : '';
  const prompt = getPrompt(action);
  const summary = `搜证：${clueId || '线索'}${prompt ? ` · ${truncate(prompt, 36)}` : ''}`;
  const result = buildActionResult(chat, action, '推进搜证', summary, 'mystery_clue', { clueId, prompt });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'investigation',
        branches: (chat.scenarioState?.branches || []).map((branch) => ({
          ...branch,
          status: branch.branchId === clueId ? 'chosen' as const : branch.status,
        })),
      },
    },
  };
}

function handleReconstructCase(chat: GroupChat, action: SessionActionDefinition) {
  const hypothesis = typeof action.payload?.hypothesis === 'string' ? action.payload.hypothesis : getPrompt(action);
  const summary = `还原案件：${truncate(hypothesis, 48)}`;
  const result = buildActionResult(chat, action, '案件还原', summary, 'mystery_reconstruct', { hypothesis });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'reconstruction',
      },
    },
  };
}

function handleQuestionMember(chat: GroupChat, action: SessionActionDefinition) {
  const targetId = action.targetIds?.[0] || '';
  const targetIndex = chat.memberIds.indexOf(targetId);
  const targetLabel = targetIndex >= 0 ? `成员#${targetIndex + 1}` : '指定成员';
  const prompt = getPrompt(action);
  const summary = `审议质询 → ${targetLabel}：${truncate(prompt, 48)}`;
  const result = buildActionResult(chat, action, '质询成员', summary, 'discussion_inquiry', { targetIds: action.targetIds || [], prompt });
  const interventionEvent = buildDirectorInterventionRuntimeEvent(chat, {
    ...action,
    type: 'director_intervention',
    payload: {
      ...(action.payload || {}),
      prompt,
      intent: 'force_reply',
      pressure: '0.9',
      maxTurns: '1',
    },
  }, summary);
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      worldState: {
        ...chat.worldState,
        phase: 'debating' as const,
        focus: chat.worldState?.focus || chat.scenarioState?.goals?.[0]?.label || chat.topic,
        recentEvent: summary,
      },
      runtimeEventsV2: retainRuntimeEvents([...(chat.runtimeEventsV2 || []), interventionEvent], 160),
    },
  };
}

function handleSummarizeDiscussion(chat: GroupChat, action: SessionActionDefinition) {
  const summaryText = typeof action.payload?.focus === 'string' ? action.payload.focus : getPrompt(action);
  const summary = `审议总结：${truncate(summaryText, 48)}`;
  const result = buildActionResult(chat, action, '总结审议', summary, 'discussion_summary', { summaryText });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'synthesis',
        summaryText,
      },
    },
  };
}

function handleSubmitEvidence(chat: GroupChat, action: SessionActionDefinition) {
  const evidenceText = getPayloadText(action, 'evidenceText');
  const now = Date.now();
  const evidence = {
    id: `evidence-${now}-${stableEventSeed([chat.id, evidenceText])}`,
    actorId: action.actorId || 'user',
    text: truncate(evidenceText, 160),
    createdAt: now,
  };
  const summary = `提交证据：${truncate(evidenceText, 48)}`;
  const result = buildActionResult(chat, action, '提交证据', summary, 'deliberation_evidence_submitted', { evidenceText: evidence.text });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        deliberationEvidence: [...(chat.scenarioState?.deliberationEvidence || []), evidence].slice(-8),
      },
      worldState: {
        ...chat.worldState,
        phase: 'debating' as const,
        recentEvent: summary,
      },
    },
  };
}

function handleRecordVerdict(chat: GroupChat, action: SessionActionDefinition) {
  const verdictText = getPayloadText(action, 'verdictText');
  const now = Date.now();
  const verdict = {
    id: `verdict-${now}-${stableEventSeed([chat.id, verdictText])}`,
    actorId: action.actorId || 'user',
    text: truncate(verdictText, 180),
    tendency: 'mixed' as const,
    createdAt: now,
  };
  const summary = `记录裁决：${truncate(verdictText, 48)}`;
  const result = buildActionResult(chat, action, '记录裁决', summary, 'deliberation_verdict_recorded', { verdictText: verdict.text });
  return {
    ...result,
    chatPatch: {
      ...result.chatPatch,
      scenarioState: {
        ...(chat.scenarioState || {}),
        deliberationVerdicts: [...(chat.scenarioState?.deliberationVerdicts || []), verdict].slice(-6),
      },
      worldState: {
        ...chat.worldState,
        phase: 'aligned' as const,
        recentEvent: summary,
      },
    },
  };
}

function handleShiftToSynthesis(chat: GroupChat, action: SessionActionDefinition) {
  const summary = '手动切换到结论整理';
  return {
    ...buildActionResult(chat, action, '切换审议阶段', summary, 'discussion_phase_shift', { phase: 'synthesis' }),
    chatPatch: {
      scenarioState: {
        ...(chat.scenarioState || {}),
        phase: 'synthesis',
      },
      worldState: {
        ...chat.worldState,
        phase: 'aligned' as const,
        recentEvent: summary,
      },
    },
  };
}

function getHandler(action: SessionActionDefinition) {
  if (action.type === 'ask_question') return handleAskQuestion;
  if (action.type === 'question_member') return handleQuestionMember;
  if (action.type === 'director_intervention') return handleDirectorIntervention;
  if (action.type === 'start_private_thread') return handleStartPrivateThread;
  if (action.type === 'mute_member' || action.type === 'unmute_member') return handleMemberMute;
  if (action.type === 'wolf_vote') return handleWolfVote;
  if (action.type === 'inspect_player') return handleInspectPlayer;
  if (action.type === 'vote_player') return handleVotePlayer;
  if (action.type === 'choose_story_branch') return handleStoryBranch;
  if (action.type === 'advance_story_scene') return handleStoryScene;
  if (action.type === 'assign_study_task') return handleAssignStudyTask;
  if (action.type === 'map_learning_goal') return handleMapLearningGoal;
  if (action.type === 'create_learning_practice') return handleCreateLearningPractice;
  if (action.type === 'submit_learning_attempt') return handleSubmitLearningAttempt;
  if (action.type === 'grade_learning_attempt') return handleGradeLearningAttempt;
  if (action.type === 'review_progress') return handleReviewProgress;
  if (action.type === 'review_learning_progress') return handleReviewProgress;
  if (action.type === 'assign_agent_task') return handleAssignAgentTask;
  if (action.type === 'summarize_workflow') return handleSummarizeWorkflow;
  if (action.type === 'board_move') return handleBoardMove;
  if (action.type === 'search_clue') return handleSearchClue;
  if (action.type === 'reconstruct_case') return handleReconstructCase;
  if (action.type === 'summarize_discussion') return handleSummarizeDiscussion;
  if (action.type === 'submit_evidence') return handleSubmitEvidence;
  if (action.type === 'record_verdict') return handleRecordVerdict;
  if (action.type === 'shift_to_synthesis') return handleShiftToSynthesis;
  return null;
}

export function executeNonChatActionScaffold(chat: GroupChat, action: SessionActionDefinition) {
  const prepared = prepareAction(action);
  if (!validateAction(prepared)) return null;
  if (!canActorExecuteAction(chat, prepared)) return null;
  if (!validateTargetIdsInConversation(chat, prepared)) return null;
  if (!validateDirectorInterventionTarget(chat, prepared)) return null;
  if (!validateMemberMuteAction(chat, prepared)) return null;
  if (prepared.type === 'start_private_thread' && !validateStartPrivateThread(chat, prepared)) return null;
  const handler = getHandler(prepared);
  if (!handler) return null;
  return handler(chat, prepared);
}
