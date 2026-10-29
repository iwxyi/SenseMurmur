import { useEffect, useMemo, useState } from 'react';
import type { AICharacter } from '../types/character';
import type { CompanionshipStatusSignature } from '../types/companionship';
import { buildDefaultSessionSurfaceProjection, resolveSessionDefinitionForConversation, type GroupChat, type ParticipantInstance, type RuntimeAction, type RuntimePanelDefinition } from '../types/chat';
import type { Message } from '../types/message';
import type { SessionActionDefinition, SessionProjectionContext } from '../types/sessionEngine';
import { getCurrentRetentionLimits } from '../services/retentionLimits';

type SessionProjectionData = Awaited<ReturnType<typeof import('../services/sessionEngineKernel')['resolveSessionProjectionData']>>;
type ProjectedChatDetailState = ReturnType<typeof import('../services/sessionProjection')['buildProjectedChatDetailState']>;
type ProjectedRuntimeState = ReturnType<typeof import('../services/sessionProjection')['projectRuntimeState']>;
type ProjectedSessionFrameworkState = ReturnType<typeof import('../services/sessionProjection')['projectSessionFrameworkState']>;
type ChatWithProjectedRuntime = GroupChat & { primaryRecentEvent?: string };
type StorySidebarTab = 'session' | 'chapters' | 'clues' | 'roles' | 'developer';
type DirectMemoryPanelContext = {
  targetName: string | null;
  targetSummary: string;
  targetResolutionLabel?: string;
  memoryVisibility: string;
  recentMemories: Array<{ id: string; text: string; layer: string; scope: string }>;
  recentRelationshipChanges: Array<{ type: string; text: string; createdAt: number }>;
  recentMemoryWrites?: Array<{ id: string; text: string; layer: string; scope: string }>;
  sourceTagSummary?: string;
  sourceTagRows?: Array<{ tag: string; count: number; label: string }>;
  targetResolution?: string;
  companionshipStatus?: CompanionshipStatusSignature | null;
};

export function isActivitySidebarAction(action: Pick<SessionActionDefinition, 'type'>) {
  return action.type === 'start_private_thread'
    || action.type === 'attention_followup_user'
    || action.type === 'attention_followup_member';
}

export function splitSidebarActions(actions: SessionActionDefinition[]) {
  return {
    sessionActions: actions.filter((action) => !isActivitySidebarAction(action)),
    activityActions: actions.filter(isActivitySidebarAction),
  };
}

function createLightweightConversationParticipants(conversation: GroupChat): ParticipantInstance[] {
  const orderedIds = Array.from(new Set([...(conversation.memberIds || []), ...(conversation.operatorIds || [])]));
  return orderedIds.map((memberId, index) => {
    const isUser = memberId === 'user';
    const isOperator = !conversation.memberIds.includes(memberId);
    const entityType = isUser ? 'user' : isOperator ? 'system_agent' : 'ai';
    return {
      participantId: `${conversation.id}:${memberId}`,
      conversationId: conversation.id,
      entityType,
      entityRefId: memberId,
      seatIndex: isOperator ? undefined : index,
      displayName: isUser ? '我' : undefined,
      canSpeak: true,
      canAct: true,
      roleKey: isUser ? 'user_persona' : isOperator ? 'system_agent' : conversation.type === 'direct' ? 'direct_partner' : conversation.type === 'ai_direct' ? 'private_party' : 'participant',
      faction: null,
      flags: {
        channelRole: isOperator ? 'operator' : conversation.type,
        actorRefKind: isUser ? 'user_persona' : isOperator ? 'system_agent' : 'ai_character',
        isOperator,
      },
    };
  });
}

function shouldUseLightweightSidebarProjection(chat: GroupChat, rightPanelTab: string) {
  if (rightPanelTab === 'activities') return false;
  const scenarioId = chat.sessionKind?.scenarioId;
  const family = chat.sessionKind?.family;
  return !scenarioId
    || scenarioId === 'open-chat'
    || scenarioId === 'direct-chat'
    || scenarioId === 'ai-private-thread'
    || family === 'conversation'
    || family === 'simulation';
}

function createLightweightProjectionContext(chat: GroupChat): SessionProjectionContext {
  return {
    conversation: chat,
    participants: createLightweightConversationParticipants(chat),
    viewerId: undefined,
    viewerRole: null,
    conversationType: chat.type,
  };
}

function buildLightweightRuntimeState(chat: GroupChat): ProjectedRuntimeState {
  const runtimeEventsV2 = chat.runtimeEventsV2 || [];
  return {
    worldState: chat.worldState,
    runtimeTimeline: [],
    runtimeSeed: {
      notes: chat.runtimeSeed?.notes || [],
      artifacts: chat.runtimeSeed?.artifacts || [],
    },
    runtimeEventsV2,
    relationshipLedger: chat.relationshipLedger || [],
    primaryRecentEvent: chat.worldState?.recentEvent || '',
    latestEvent: runtimeEventsV2.length ? runtimeEventsV2[runtimeEventsV2.length - 1] : null,
    timelineCount: runtimeEventsV2.length + (chat.runtimeTimeline?.length || 0),
  };
}

function buildLightweightFrameworkState(chat: GroupChat): ProjectedSessionFrameworkState {
  const definition = resolveSessionDefinitionForConversation(chat);
  return {
    definition,
    surfaces: buildDefaultSessionSurfaceProjection(chat),
    familyLabel: definition.kind.family,
    scenarioLabel: definition.scenario.label,
    topologyLabel: definition.kind.topology,
  };
}

function buildLightweightProjectionData(chat: GroupChat) {
  const context = createLightweightProjectionContext(chat);
  const actionSchema = null;
  const visiblePanels: RuntimePanelDefinition[] = [
    { key: 'members', title: chat.type === 'group' ? '成员' : '角色', type: 'members', tabKey: 'members' },
    { key: 'runtime', title: '运行态', type: 'runtime', tabKey: 'world' },
  ];
  const availableActions: RuntimeAction[] = [{ type: 'speak' }];
  return {
    view: { visiblePanels, availableActions },
    actionSchema,
    runtimeState: buildLightweightRuntimeState(context.conversation),
    frameworkState: buildLightweightFrameworkState(context.conversation),
    privatePayloads: [],
  };
}

export function resolveLightweightSidebarTab(params: {
  rightPanelTab: string;
  showMemberTab: boolean;
  showRuntimeTab: boolean;
  showActionTab: boolean;
}) {
  if (params.showMemberTab && params.rightPanelTab === 'members') return 'members';
  if (params.showRuntimeTab && params.rightPanelTab === 'narrative') return 'narrative';
  if (params.showRuntimeTab && params.rightPanelTab === 'world') return 'world';
  if (params.showActionTab && params.rightPanelTab === 'activities') return 'actions';
  if (params.showMemberTab) return 'members';
  if (params.showRuntimeTab) return 'world';
  return 'actions';
}

function buildLightweightProjectedSessionActions(chat: GroupChat, actions: SessionActionDefinition[], members: AICharacter[] = []) {
  if (chat.type !== 'group') return actions;
  const chatMemberSet = new Set(chat.memberIds);
  const scopedMembers = members.filter((member) => chatMemberSet.has(member.id));
  const canInjectPrivateThread = chat.governance.allowPrivateThreads && scopedMembers.length >= 2;
  const hasPrivateThreadAction = actions.some((action) => action.type === 'start_private_thread');
  const startPrivateThread: SessionActionDefinition = {
    type: 'start_private_thread',
    label: '发起角色私聊',
    description: '从群聊中手动选择两名成员，开启一段独立的角色私聊。',
    fields: [
      { key: 'actorId', label: '发起者', type: 'single_select', required: true, options: scopedMembers.map((member) => ({ value: member.id, label: member.name })) },
      { key: 'targetId', label: '对象', type: 'single_select', required: true, options: scopedMembers.map((member) => ({ value: member.id, label: member.name })) },
    ],
    visibility: 'public',
  };
  return [
    ...(canInjectPrivateThread && !hasPrivateThreadAction ? [startPrivateThread] : []),
    ...actions,
  ];
}

function buildLightweightProjectedChatDetailState(params: {
  chat: GroupChat;
  members: AICharacter[];
  runtimeState: ProjectedRuntimeState;
  privatePayloads: Array<{ key: string; title: string; text: string }>;
  visiblePanels: RuntimePanelDefinition[];
  rightPanelTab: string;
  frameworkState: ProjectedSessionFrameworkState;
  speakAsChar?: { name?: string; layeredMemories?: Array<{ text: string }> } | null;
}): ProjectedChatDetailState {
  const memberPanel = params.visiblePanels.find((panel) => panel.tabKey === 'members');
  const runtimePanel = params.visiblePanels.find((panel) => panel.tabKey === 'world');
  const showMemberTab = Boolean(memberPanel);
  const showRuntimeTab = Boolean(runtimePanel);
  const showActionTab = params.chat.type === 'group';
  const activeSidebarTab = resolveLightweightSidebarTab({
    rightPanelTab: params.rightPanelTab,
    showMemberTab,
    showRuntimeTab,
    showActionTab,
  });
  const actionPanelActions = buildLightweightProjectedSessionActions(params.chat, [], params.members);
  const memorySummary = params.speakAsChar?.layeredMemories?.slice(-getCurrentRetentionLimits().characterLayeredMemories.recall).map((item) => item.text).join(' / ');
  return {
    memberPanel,
    runtimePanel,
    showMemberTab,
    showRuntimeTab,
    showActionTab,
    activeSidebarTab,
    sidebarTitle: activeSidebarTab === 'members'
      ? (memberPanel?.title || (params.chat.type === 'group' ? '成员' : '角色'))
      : activeSidebarTab === 'actions'
        ? '动作'
        : activeSidebarTab === 'narrative'
          ? '叙事流'
        : (runtimePanel?.title || '运行态'),
    memberTabTitle: memberPanel?.title || (params.chat.type === 'group' ? '成员' : '角色'),
    runtimeTabTitle: runtimePanel?.title || '运行态',
    privatePayloadTitle: params.chat.type === 'direct' ? '单聊信息' : '私有信息',
    sidebarChat: {
      chat: {
        ...params.chat,
        worldState: params.runtimeState.worldState,
        runtimeSeed: params.runtimeState.runtimeSeed,
        runtimeEventsV2: params.runtimeState.runtimeEventsV2,
        relationshipLedger: params.runtimeState.relationshipLedger,
        primaryRecentEvent: params.runtimeState.primaryRecentEvent,
      },
      privatePayloads: params.privatePayloads,
    },
    actionPanel: { title: '动作与派生', actions: actionPanelActions },
    composerSurfaces: params.frameworkState.surfaces.surfaces,
    compactCharacterMemorySummary: memorySummary,
    speakAsSummary: params.speakAsChar && memorySummary ? `${params.speakAsChar.name}：${memorySummary}` : null,
  };
}

export function enrichParticipantActionOptions(actions: SessionActionDefinition[], members: AICharacter[]): SessionActionDefinition[] {
  if (!actions.length || !members.length) return actions;
  const memberNames = new Map(members.map((member) => [member.id, member.name] as const));
  return actions.map((action) => ({
    ...action,
    fields: action.fields?.map((field) => {
      const shouldResolveMember = field.targetSource === 'participants' || field.key === 'actorId' || field.key === 'targetId';
      if (!shouldResolveMember || !field.options?.length) return field;
      return {
        ...field,
        options: field.options.map((option) => ({
          ...option,
          label: memberNames.get(option.value) || option.label,
        })),
      };
    }),
  }));
}

function mergeProjectedRuntimeChat(chat: GroupChat, projected?: ChatWithProjectedRuntime | null, primaryRecentEvent?: string): ChatWithProjectedRuntime {
  if (!projected) return { ...chat, primaryRecentEvent };
  return {
    ...chat,
    ...projected,
    worldState: {
      ...chat.worldState,
      ...(projected.worldState || {}),
      conflictAxes: projected.worldState?.conflictAxes || chat.worldState.conflictAxes,
      conflictState: projected.worldState?.conflictState ?? chat.worldState.conflictState,
      structuredRoomState: projected.worldState?.structuredRoomState ?? chat.worldState.structuredRoomState,
    },
    layeredMemories: projected.layeredMemories?.length ? projected.layeredMemories : chat.layeredMemories,
    runtimeSeed: projected.runtimeSeed || chat.runtimeSeed,
    runtimeTimeline: projected.runtimeTimeline?.length ? projected.runtimeTimeline : chat.runtimeTimeline,
    runtimeEventsV2: projected.runtimeEventsV2?.length ? projected.runtimeEventsV2 : chat.runtimeEventsV2,
    relationshipLedger: projected.relationshipLedger?.length ? projected.relationshipLedger : chat.relationshipLedger,
    primaryRecentEvent: projected.primaryRecentEvent || primaryRecentEvent,
  };
}

function deriveSessionTabTitle(chat: GroupChat | undefined, actionTitle?: string, isZh = true) {
  if (!chat) return isZh ? '玩法' : 'Session';
  if (chat.sessionKind?.scenarioId === 'story-reader') return isZh ? '故事' : 'Story';
  const family = chat.sessionKind?.family;
  if (family === 'analysis') return isZh ? '审议' : 'Deliberation';
  if (family === 'study') return isZh ? '学习' : 'Study';
  if (family === 'agent') return isZh ? '工作流' : 'Workflow';
  if (family === 'board_game') return isZh ? '棋盘' : 'Board';
  if (family === 'deduction') return isZh ? '狼人杀' : 'Deduction';
  if (family === 'mystery') return isZh ? '剧本' : 'Mystery';
  const title = actionTitle?.trim();
  if (title) {
    return title
      .replace(/(?:动作|操作|面板|Actions?|Panel)$/i, '')
      .replace(/(?:动作|操作|面板)$/u, '')
      .trim() || title;
  }
  return isZh ? '玩法' : 'Session';
}

export function resolveStorySidebarTab(rightPanelTab: string): StorySidebarTab {
  if (rightPanelTab === 'session' || rightPanelTab === 'narrative') return 'session';
  if (rightPanelTab === 'chapters') return 'chapters';
  if (rightPanelTab === 'clues') return 'clues';
  if (rightPanelTab === 'roles') return 'roles';
  if (rightPanelTab === 'developer') return 'developer';
  return 'session';
}

export function shouldShowSessionSidebarTab(chat: GroupChat | undefined, hasSessionSpecificActions: boolean) {
  if (!chat || chat.sessionKind?.scenarioId === 'story-reader') return false;
  if (chat.sessionKind?.family === 'analysis') return true;
  return Boolean(chat.sessionKind?.family !== 'conversation' && hasSessionSpecificActions);
}

export function useChatSidebarProjection(params: {
  chat: GroupChat | undefined;
  members: AICharacter[];
  activeMembers: AICharacter[];
  characters: AICharacter[];
  currentChatMessages: Message[];
  rightPanelTab: string;
  speakAsChar: AICharacter | null;
  language: string;
}) {
  const { chat, members, activeMembers, characters, currentChatMessages, rightPanelTab, speakAsChar, language } = params;
  const isZh = language.startsWith('zh');
  const [projectionData, setProjectionData] = useState<SessionProjectionData | null>(null);
  const [projectedDetailState, setProjectedDetailState] = useState<ProjectedChatDetailState | null>(null);
  const [directMemoryPanelContext, setDirectMemoryPanelContext] = useState<DirectMemoryPanelContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!chat) {
      setProjectionData(null);
      setProjectedDetailState(null);
      return undefined;
    }

    if (shouldUseLightweightSidebarProjection(chat, rightPanelTab)) {
      const nextProjectionData = buildLightweightProjectionData(chat);
      setProjectionData(nextProjectionData as SessionProjectionData);
      setProjectedDetailState(nextProjectionData.frameworkState.definition ? buildLightweightProjectedChatDetailState({
        chat,
        runtimeState: nextProjectionData.runtimeState,
        privatePayloads: nextProjectionData.privatePayloads,
        visiblePanels: nextProjectionData.view.visiblePanels,
        rightPanelTab,
        frameworkState: nextProjectionData.frameworkState,
        speakAsChar,
        members,
      }) : null);
      return undefined;
    }

    void Promise.all([
      import('../services/sessionEngineLoader'),
      import('../services/sessionEngineKernel'),
      import('../services/sessionProjection'),
    ]).then(async ([engineLoader, kernel, sessionProjection]) => {
      if (cancelled) return;
      const engine = await engineLoader.loadSessionEngine(chat);
      if (cancelled) return;
      const runtimeContext = kernel.createSessionRuntimeContext(engine, chat);
      const nextProjectionData = kernel.resolveSessionProjectionData(engine, runtimeContext);
      setProjectionData(nextProjectionData);
      setProjectedDetailState(nextProjectionData.frameworkState.definition ? sessionProjection.buildProjectedChatDetailState({
        chat,
        runtimeState: nextProjectionData.runtimeState,
        privatePayloads: nextProjectionData.privatePayloads,
        visiblePanels: nextProjectionData.view.visiblePanels,
        schemaActions: nextProjectionData.actionSchema?.actions || [],
        schemaTitle: nextProjectionData.actionSchema?.title,
        rightPanelTab,
        frameworkState: nextProjectionData.frameworkState,
        speakAsChar,
        members,
      }) : null);
    });

    return () => {
      cancelled = true;
    };
  }, [chat, members, rightPanelTab, speakAsChar]);

  useEffect(() => {
    let cancelled = false;
    if (!chat || (chat.type !== 'direct' && chat.type !== 'ai_direct') || !activeMembers[0]) {
      setDirectMemoryPanelContext(null);
      return undefined;
    }

    void Promise.all([
      import('../services/promptBuilder'),
      import('../services/companionshipProjection'),
    ]).then(([promptBuilder, companionshipProjection]) => {
      if (cancelled) return;
      setDirectMemoryPanelContext({
        ...promptBuilder.buildDirectMemoryPanelContext(activeMembers[0], currentChatMessages, new Map(characters.map((item) => [item.id, item] as const))),
        companionshipStatus: companionshipProjection.buildCompanionshipStatusSignature({ chat, character: activeMembers[0], messages: currentChatMessages }),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [activeMembers, characters, chat, currentChatMessages]);

  const projectedRuntimeState = projectionData?.runtimeState || null;
  const frameworkState = projectionData?.frameworkState || null;
  const privatePayloads = projectionData?.privatePayloads || [];
  const actionSchema = projectionData?.actionSchema || null;
  const inputSurfaces = frameworkState?.surfaces.surfaces || [];
  const actionTabActions = useMemo(() => enrichParticipantActionOptions(actionSchema?.actions || [], members), [actionSchema, members]);
  const projectedPanelActions = useMemo(() => {
    if (!chat) return actionTabActions;
    if (chat.type !== 'group') return actionTabActions;
    const actions = projectedDetailState?.actionPanel.actions.length
      ? projectedDetailState.actionPanel.actions
      : buildLightweightProjectedSessionActions(chat, actionTabActions.filter((action) => action.type !== 'apply_calendar_patch_drafts'), members);
    return enrichParticipantActionOptions(actions, members)
      .filter((action) => action.type !== 'apply_calendar_patch_drafts');
  }, [actionTabActions, chat, members, projectedDetailState]);
  const sidebarActionGroups = useMemo(() => splitSidebarActions(projectedPanelActions), [projectedPanelActions]);
  const showMemberTab = projectedDetailState?.showMemberTab ?? true;
  const showRuntimeTab = projectedDetailState?.showRuntimeTab ?? true;
  const showActionTab = chat?.sessionKind?.scenarioId === 'story-reader'
    ? false
    : projectedDetailState?.showActionTab ?? (chat?.type === 'group');
  const isStoryRoom = chat?.sessionKind?.scenarioId === 'story-reader';
  const hasSessionSpecificActions = Boolean(chat && !isStoryRoom && chat.sessionKind?.family !== 'conversation' && sidebarActionGroups.sessionActions.length);
  const showSessionTab = shouldShowSessionSidebarTab(chat, hasSessionSpecificActions);
  const sessionTabTitle = deriveSessionTabTitle(chat, actionSchema?.title || projectedDetailState?.actionPanel.title, isZh);
  const projectedActiveTab = projectedDetailState?.activeSidebarTab === 'actions'
    ? (hasSessionSpecificActions ? 'session' : 'activities')
    : projectedDetailState?.activeSidebarTab;
  const storySidebarTab = isStoryRoom ? resolveStorySidebarTab(rightPanelTab) : null;
  const activeSidebarTab = storySidebarTab || projectedActiveTab
    || (showSessionTab && rightPanelTab === 'session' ? 'session'
      : showMemberTab && rightPanelTab === 'members' ? 'members'
      : showRuntimeTab && rightPanelTab === 'narrative' ? 'narrative'
      : showRuntimeTab && rightPanelTab === 'chapters' ? 'chapters'
      : showRuntimeTab && rightPanelTab === 'world' ? 'world'
      : showActionTab && rightPanelTab === 'activities' ? 'activities'
        : showSessionTab ? 'session' : showMemberTab ? 'members' : 'world');
  const localizePanelTitle = (title: string | undefined, fallback: string) => {
    if (!title) return fallback;
    const zhTitles: Record<string, string> = { Members: '成员', Story: '故事', Branches: '分支', Actions: '动作', Tasks: '任务', Workflow: '工作流', Players: '玩家', Board: '棋盘', Moves: '行动', Mystery: '谜题', Clues: '线索', Study: '学习', Discussion: '讨论', Deliberation: '运行态' };
    const enTitles: Record<string, string> = { '成员': 'Members', '角色': 'Characters', '运行态': 'Runtime', '故事': 'Story', '分支': 'Branches', '动作': 'Actions', '活动': 'Activities', '叙事流': 'Narrative', '会话动作': 'Session actions' };
    return isZh ? zhTitles[title] || title : enTitles[title] || title;
  };
  const memberTabTitle = localizePanelTitle(projectedDetailState?.memberTabTitle, chat?.type === 'group' ? (isZh ? '成员' : 'Members') : (isZh ? '角色' : 'Characters'));
  const runtimeTabTitle = localizePanelTitle(projectedDetailState?.runtimeTabTitle, isZh ? '运行态' : 'Runtime');
  const projectedSidebarTitle = projectedDetailState?.sidebarTitle === '动作' || projectedDetailState?.sidebarTitle === 'Actions'
    ? (isZh ? '活动' : 'Activities')
    : localizePanelTitle(projectedDetailState?.sidebarTitle, '');
  const storySidebarTitle = isStoryRoom && activeSidebarTab === 'session'
      ? (isZh ? '故事' : 'Story')
      : isStoryRoom && activeSidebarTab === 'clues'
        ? (isZh ? '线索' : 'Clues')
      : isStoryRoom && activeSidebarTab === 'roles'
        ? (isZh ? '角色' : 'Characters')
      : isStoryRoom && activeSidebarTab === 'developer'
        ? (isZh ? '开发者' : 'Developer')
        : isStoryRoom && activeSidebarTab === 'chapters'
          ? (isZh ? '章节' : 'Chapters')
          : '';
  const sidebarTitle = storySidebarTitle || projectedSidebarTitle
    || (activeSidebarTab === 'session'
      ? sessionTabTitle
      : activeSidebarTab === 'members'
      ? memberTabTitle
      : activeSidebarTab === 'activities'
        ? (isZh ? '活动' : 'Activities')
        : activeSidebarTab === 'narrative'
          ? (isZh ? '叙事流' : 'Narrative')
          : activeSidebarTab === 'chapters'
            ? (isZh ? '章节' : 'Chapters')
          : runtimeTabTitle);
  const runtimePanelLoading = !projectionData && Boolean(chat);

  const projectedSidebarChat = useMemo(
    () => chat ? mergeProjectedRuntimeChat(chat, projectedDetailState?.sidebarChat.chat, projectedRuntimeState?.primaryRecentEvent) : null,
    [chat, projectedDetailState, projectedRuntimeState]
  );
  const activityActions = hasSessionSpecificActions ? sidebarActionGroups.activityActions : projectedPanelActions;
  const sessionActions = sidebarActionGroups.sessionActions;
  const projectedActionPanelActions = activityActions;
  const actionPanelTitle = chat?.type === 'group' ? '动作与派生' : actionSchema?.title;
  const composerSurfaces = projectedDetailState?.composerSurfaces || (inputSurfaces.length ? inputSurfaces : (chat ? buildDefaultSessionSurfaceProjection(chat).surfaces : []));

  return {
    actionSchema,
    actionPanelTitle,
    activeSidebarTab,
    composerSurfaces,
    directMemoryPanelContext,
    memberTabTitle,
    privatePayloads,
    projectedActionPanelActions,
    projectedDetailState,
    projectedRuntimeState,
    projectedSidebarChat,
    runtimePanelLoading,
    runtimeTabTitle,
    sessionActions,
    sessionTabTitle,
    showSessionTab,
    showActionTab,
    showMemberTab,
    showRuntimeTab,
    sidebarTitle,
  };
}
