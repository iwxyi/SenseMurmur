import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message, MessageAttachment } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import type { SessionActionSchema, SessionNormalizedIntentResult } from '../types/sessionEngine';
import type { AIModelProfile, APIConfig } from '../types/settings';
import { buildActionRuntimeContract, buildRuntimeEventContract } from './sessionRuntimeContract';
import { canActorRunSessionAction, resolveMemberActorRef } from './memberActionPolicy';
import { getUsablePreferredAIProfile } from '../types/settings';
import { useChatStore } from '../stores/useChatStore';
import { logDeveloperDiagnostic } from './developerDiagnostics';
import { retainRuntimeEvents } from './runtimeEventRetention';

export interface ChatSurfaceActionContext {
  chat: GroupChat | undefined;
  chats: GroupChat[];
  characters: AICharacter[];
  actionSchema: SessionActionSchema | null;
  speakAsChar: AICharacter | null;
  updateChat: (id: string, updates: Partial<GroupChat>) => Promise<void>;
  addMessage: (input: Omit<Message, 'id' | 'timestamp' | 'isDeleted'> & { timestamp?: number }) => Promise<unknown>;
  appendEventMessage: (
    chatId: string,
    payload: {
      eventType: string;
      title: string;
      summary: string;
      pair?: [string, string];
      metrics?: unknown;
      visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';
      visibleToIds?: string[];
      visibleToRoles?: string[];
      createdAt?: number;
      sourceMessageId?: string;
    },
  ) => Promise<void>;
  setSnackbar: (value: { open: boolean; message: string; severity: 'error' | 'success' }) => void;
}

export interface AutoSocialEventFlowContext {
  chats: GroupChat[];
  characters: AICharacter[];
  aiProfiles?: AIModelProfile[];
  updateChat: (id: string, updates: Partial<GroupChat>) => Promise<void>;
  addMessage: (input: Record<string, unknown>) => Promise<unknown>;
  appendEventMessage: (
    chatId: string,
    payload: {
      eventType: string;
      title: string;
      summary: string;
      pair?: [string, string];
      metrics?: unknown;
      visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';
      visibleToIds?: string[];
      visibleToRoles?: string[];
      createdAt?: number;
      sourceMessageId?: string;
    },
  ) => Promise<void>;
}

function resolveActionActorOrigin(chat: GroupChat, actorId: string | undefined) {
  if (!actorId) return 'unknown';
  if (chat.memberIds.includes(actorId)) return 'member';
  if ((chat.operatorIds || []).includes(actorId)) return 'operator';
  return 'external';
}

function resolveTextApiConfig(aiProfiles: AIModelProfile[]): APIConfig | null {
  const profile = getUsablePreferredAIProfile(aiProfiles, 'text');
  if (!profile) return null;
  return {
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
  };
}

export async function runSessionActionImpl(
  context: ChatSurfaceActionContext,
  action: { type: string; actorId?: string },
  payload: Record<string, unknown>,
  triggerPairPrivateThread: (sourceChat: GroupChat, actorId: string, targetId: string, navigateAfterCreate?: boolean) => Promise<unknown>,
) {
  const chat = context.chat;
  if (!chat) return;
  const memberSet = new Set(chat.memberIds);
  const aiIdSet = new Set(context.characters.map((character) => character.id));
  const assertActorPermission = (actionType: string, actorId: string | undefined, errorMessage: string) => {
    if (!actorId) return true;
    const actorRef = resolveMemberActorRef(actorId, aiIdSet);
    if (canActorRunSessionAction(actionType, actorRef)) return true;
    context.setSnackbar({
      open: true,
      severity: 'error',
      message: errorMessage,
    });
    return false;
  };
  const canStartPrivateThread = (actorId: string, targetId: string) => {
    if (!actorId || !targetId || actorId === targetId) return false;
    if (!memberSet.has(actorId) || !memberSet.has(targetId)) return false;
    return aiIdSet.has(actorId) && aiIdSet.has(targetId);
  };
  if (action.type === 'apply_calendar_patch_drafts') {
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : action.actorId;
    if (!assertActorPermission(action.type, actorId, '当前身份不能应用日历草案。')) return;
    const { applyWorldCalendarPatchDraftQueue } = await import('./worldCalendarPatchApply');
    const result = await applyWorldCalendarPatchDraftQueue({
      chats: context.chats,
      characters: context.characters,
      updateChat: context.updateChat,
      conversationId: chat.id,
      trigger: 'action_panel',
      riskMode: 'manual',
      continueOnPersistError: true,
    });
    context.setSnackbar({
      open: true,
      severity: 'success',
      message: result.appliedCount > 0
        ? `已应用 ${result.appliedCount} 条日历草案${result.skippedCount ? `（跳过 ${result.skippedCount} 条）` : ''}${result.failedCount ? `（失败 ${result.failedCount} 条）` : ''}`
        : '当前会话暂无可应用草案',
    });
    const skippedReasonCounts = result.skippedItems.reduce<Record<string, number>>((acc, item) => {
      const key = item.reason || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    await context.appendEventMessage(chat.id, buildActionRuntimeContract(chat, action.type, payload, actorId, {
      eventType: 'calendar_patch_apply_result',
      title: '日历草案执行',
      summary: result.appliedCount > 0
        ? `执行完成：应用 ${result.appliedCount}，跳过 ${result.skippedCount}，失败 ${result.failedCount}`
        : '执行完成：当前会话暂无可应用草案',
      metrics: {
        appliedCount: result.appliedCount,
        skippedCount: result.skippedCount,
        failedCount: result.failedCount,
        queueCount: result.queueCount,
        persistedCount: result.persistedCount,
        modelArbitration: result.modelArbitration || null,
        appliedItems: result.appliedItems.slice(0, 8),
        skippedItems: result.skippedItems.slice(0, 8),
        skippedReasonCounts,
        failures: result.failures.slice(0, 8),
      },
      visibilityScope: 'moderator_only',
    }));
    return;
  }
  if (action.type === 'start_private_thread') {
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : action.actorId || '';
    if (!assertActorPermission(action.type, actorId, '当前身份不能发起 AI 私聊。')) return;
    const targetId = typeof payload.targetId === 'string' ? payload.targetId : '';
    if (!canStartPrivateThread(actorId, targetId)) {
      context.setSnackbar({
        open: true,
        severity: 'error',
        message: '只能在当前群聊成员中选择两个不同的 AI 角色发起私聊。',
      });
      return;
    }
    await triggerPairPrivateThread(chat, actorId, targetId, true);
    return;
  }
  if (action.type === 'attention_followup_user') {
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : action.actorId || '';
    const memberSet = new Set(chat.memberIds);
    if (!actorId || !memberSet.has(actorId) || !aiIdSet.has(actorId)) {
      context.setSnackbar({
        open: true,
        severity: 'error',
        message: '只能对当前群聊中的 AI 角色发起用户跟进动作。',
      });
      return;
    }
    const actorName = context.characters.find((character) => character.id === actorId)?.name || actorId;
    const focus = typeof payload.focus === 'string' ? payload.focus.trim() : '';
    const guidanceContent = focus
      ? `请${actorName}先跟进用户：${focus}`
      : `请${actorName}先跟进用户，接住当前问题并继续追问。`;
    const now = Date.now();
    const runtimeEvent: RuntimeEventV2 = {
      id: `evt-attention-followup-${now}`,
      conversationId: chat.id,
      kind: 'director_intervention',
      createdAt: now,
      actorIds: ['user'],
      targetIds: [actorId],
      summary: `${actorName} 需要优先跟进用户`,
      visibility: 'moderator_only',
      payload: {
        eventType: 'attention_followup_user',
        actorId,
        focus: focus || null,
      },
    };
    await context.updateChat(chat.id, {
      runtimeEventsV2: retainRuntimeEvents([...(chat.runtimeEventsV2 || []), runtimeEvent], 160),
    });
    await context.addMessage({
      chatId: chat.id,
      type: 'god',
      senderId: 'user',
      senderName: '话题引导',
      content: guidanceContent,
      emotion: 0,
    });
    await context.appendEventMessage(chat.id, buildActionRuntimeContract(chat, action.type, payload, actorId, {
      eventType: 'attention_followup_user',
      title: '关注跟进',
      summary: `${actorName} 已收到用户跟进指令`,
      metrics: {
        actorId,
        focus: focus || null,
        _actorAudit: {
          actorId,
          origin: resolveActionActorOrigin(chat, actorId),
          isOperator: (chat.operatorIds || []).includes(actorId),
        },
      },
      visibilityScope: 'moderator_only',
    }));
    context.setSnackbar({
      open: true,
      severity: 'success',
      message: `已让${actorName}优先跟进用户`,
    });
    return;
  }
  if (action.type === 'attention_followup_member') {
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : action.actorId || '';
    const targetId = typeof payload.targetId === 'string' ? payload.targetId : '';
    const memberSet = new Set(chat.memberIds);
    if (!actorId || !targetId || actorId === targetId || !memberSet.has(actorId) || !memberSet.has(targetId) || !aiIdSet.has(actorId) || !aiIdSet.has(targetId)) {
      context.setSnackbar({
        open: true,
        severity: 'error',
        message: '只能在当前群聊中指定两个不同的 AI 角色执行成员跟进动作。',
      });
      return;
    }
    const actorName = context.characters.find((character) => character.id === actorId)?.name || actorId;
    const targetName = context.characters.find((character) => character.id === targetId)?.name || targetId;
    const focus = typeof payload.focus === 'string' ? payload.focus.trim() : '';
    const guidanceContent = focus
      ? `请${actorName}先跟进${targetName}：${focus}`
      : `请${actorName}先跟进${targetName}刚才的发言，先接住再追问。`;
    const now = Date.now();
    const runtimeEvent: RuntimeEventV2 = {
      id: `evt-attention-followup-member-${now}`,
      conversationId: chat.id,
      kind: 'director_intervention',
      createdAt: now,
      actorIds: ['user'],
      targetIds: [actorId, targetId],
      summary: `${actorName} 需要优先跟进 ${targetName}`,
      visibility: 'moderator_only',
      payload: {
        eventType: 'attention_followup_member',
        actorId,
        targetId,
        focus: focus || null,
      },
    };
    const attentionCandidateEvent: RuntimeEventV2 = {
      id: `evt-attention-followup-member-candidate-${now}`,
      conversationId: chat.id,
      kind: 'attention_candidate',
      createdAt: now,
      actorIds: [actorId],
      targetIds: [targetId],
      summary: `${actorName} 对 ${targetName} 形成手动跟进关注候选`,
      visibility: 'derived_public',
      payload: {
        source: 'manual_attention_followup_member',
        reason: focus || `${actorName} 需要优先跟进 ${targetName}`,
        confidence: 0.92,
        targetIds: [targetId],
      },
    };
    await context.updateChat(chat.id, {
      runtimeEventsV2: retainRuntimeEvents([...(chat.runtimeEventsV2 || []), runtimeEvent, attentionCandidateEvent], 160),
    });
    await context.addMessage({
      chatId: chat.id,
      type: 'god',
      senderId: 'user',
      senderName: '话题引导',
      content: guidanceContent,
      emotion: 0,
    });
    await context.appendEventMessage(chat.id, buildActionRuntimeContract(chat, action.type, payload, actorId, {
      eventType: 'attention_followup_member',
      title: '成员跟进',
      summary: `${actorName} 已收到跟进 ${targetName} 的指令`,
      metrics: {
        actorId,
        targetId,
        focus: focus || null,
        _actorAudit: {
          actorId,
          origin: resolveActionActorOrigin(chat, actorId),
          isOperator: (chat.operatorIds || []).includes(actorId),
        },
      },
      visibilityScope: 'moderator_only',
    }));
    context.setSnackbar({
      open: true,
      severity: 'success',
      message: `已让${actorName}优先跟进${targetName}`,
    });
    return;
  }
  if (action.type === 'director_intervention') {
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : action.actorId;
    if (!assertActorPermission(action.type, actorId, '当前身份不能执行导演干预。')) return;
    const targetId = typeof payload.targetId === 'string' ? payload.targetId : '';
    if (targetId && !memberSet.has(targetId)) {
      context.setSnackbar({
        open: true,
        severity: 'error',
        message: '导演干预目标必须是当前群聊成员。',
      });
      return;
    }
  }
  const genericTargetId = typeof payload.targetId === 'string' ? payload.targetId : '';
  if (genericTargetId && !memberSet.has(genericTargetId)) {
    context.setSnackbar({
      open: true,
      severity: 'error',
      message: '动作目标必须是当前群聊成员。',
    });
    return;
  }

  const { runSessionActionExecutor } = await import('./sessionActionExecutors/sessionActionExecutorRegistry');
  const executionResult = runSessionActionExecutor(chat, { ...action, payload });
  if (executionResult) {
    logDeveloperDiagnostic('session-action:executed', {
      chatId: chat.id,
      actionType: action.type,
      actorId: action.actorId || null,
      payload,
      chatPatchKeys: Object.keys(executionResult.chatPatch || {}),
      scenarioPhase: executionResult.chatPatch?.scenarioState?.phase || null,
      scenarioChoiceEpoch: executionResult.chatPatch?.scenarioState?.choiceEpoch || null,
      runtimeEventCount: executionResult.runtimeEvents?.length || 0,
    }, action.type === 'choose_story_branch' && executionResult.chatPatch?.scenarioState?.phase !== 'branch' ? 'warn' : 'info');
    await context.updateChat(chat.id, executionResult.chatPatch || {});
    for (const runtimeEvent of executionResult.runtimeEvents || []) {
      await context.appendEventMessage(chat.id, runtimeEvent);
    }
    context.setSnackbar({ open: true, severity: 'success', message: '动作已执行' });
    return executionResult;
  }

  const { buildDefaultActionIntent, buildSessionIntentSummary } = await import('../types/sessionEngine');
  const intent = buildDefaultActionIntent(action.type, payload, action.actorId);
  const summary = `${action.type}：${buildSessionIntentSummary(intent)}`;
  logDeveloperDiagnostic('session-action:fallback-intent', {
    chatId: chat.id,
    actionType: action.type,
    actorId: action.actorId || null,
    payload,
    summary,
  }, 'warn');
  await context.updateChat(chat.id, {
    worldState: {
      ...chat.worldState,
      recentEvent: summary,
    },
  });
  await context.appendEventMessage(chat.id, buildActionRuntimeContract(chat, action.type, payload, action.actorId, {
    eventType: 'session_action_intent',
    title: action.type,
    summary,
    metrics: {
      ...payload,
      _actorAudit: {
        actorId: action.actorId || null,
        origin: resolveActionActorOrigin(chat, action.actorId),
        isOperator: Boolean(action.actorId && (chat.operatorIds || []).includes(action.actorId)),
      },
    },
    visibilityScope: 'public',
  }));
}

export async function runSurfaceIntentImpl(
  context: ChatSurfaceActionContext,
  surfaceResult: SessionNormalizedIntentResult,
  handlers: {
    runSessionAction: (action: { type: string; actorId?: string }, payload: Record<string, unknown>) => Promise<unknown>;
    handleGuideSend: (content: string, attachments?: MessageAttachment[]) => Promise<void>;
    handleMemberSpeakSend: (content: string, attachments?: MessageAttachment[]) => Promise<void>;
    handleSpeakAs: (content: string, attachments?: MessageAttachment[]) => Promise<void>;
  },
) {
  const chat = context.chat;
  if (!chat) return;
  const { buildActionFromIntent, buildBoardArtifactEventSummary } = await import('../types/sessionEngine');
  const { intent } = surfaceResult;

  if (intent.type === 'message_intent') {
    const content = typeof intent.payload.content === 'string' ? intent.payload.content : '';
    const attachments = Array.isArray(intent.payload.attachments) ? intent.payload.attachments as MessageAttachment[] : [];
    if (!content && attachments.length === 0) return;
    if ((intent.payload.mode === 'speakAs' || context.speakAsChar) && context.speakAsChar) {
      await handlers.handleSpeakAs(content, attachments);
      return;
    }
    if (intent.payload.mode === 'memberSpeak' || chat.type === 'direct') {
      await handlers.handleMemberSpeakSend(content, attachments);
      return;
    }
    await handlers.handleGuideSend(content, attachments);
    return;
  }

  if (intent.type === 'board_intent') {
    const summary = buildBoardArtifactEventSummary(intent);
    await context.updateChat(chat.id, {
      worldState: {
        ...chat.worldState,
        recentEvent: summary,
      },
    });
    await context.appendEventMessage(chat.id, buildRuntimeEventContract(chat, intent, {
      eventType: 'board_intent',
      title: '棋盘动作',
      summary,
      metrics: intent.payload,
      visibilityScope: 'public',
    }));
    return;
  }

  const action = buildActionFromIntent(context.actionSchema, intent);
  if (action) {
    await handlers.runSessionAction(action, typeof intent.payload.fields === 'object' && intent.payload.fields ? intent.payload.fields as Record<string, unknown> : {});
  }
}

export async function runAutoSocialEventFlowImpl(sourceChat: GroupChat, context: AutoSocialEventFlowContext) {
  const { runSocialEventAutoFlow } = await import('./directSessionRuntime');
  const imageModelEnabled = Boolean(getUsablePreferredAIProfile(context.aiProfiles || [], 'image'));
  const textApiConfig = resolveTextApiConfig(context.aiProfiles || []);
  const currentChat = useChatStore.getState().getChat(sourceChat.id);
  if (!currentChat || currentChat.deletedAt != null) return { handledEventId: null };
  return runSocialEventAutoFlow(currentChat, {
    chats: useChatStore.getState().chats,
    characters: context.characters,
    imageModelEnabled,
    textApiConfig,
    allowWorldFallback: currentChat.isActive,
    applyChatRuntimePatch: useChatStore.getState().applyChatRuntimePatch,
    addChat: async (input) => useChatStore.getState().addChat(input as never),
    addMessage: context.addMessage,
    appendEventMessage: context.appendEventMessage,
  });
}
