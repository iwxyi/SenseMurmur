import { describe, expect, it, vi } from 'vitest';
import { normalizeConversation, type GroupChat } from '../types/chat';
import type { SocialEventRuntimeOps } from './directSessionRuntime';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CHARACTER_INTERVENTION, DEFAULT_CHARACTER_MEMORY, DEFAULT_PERSONALITY, type AICharacter } from '../types/character';
import type { SessionNormalizedIntentResult } from '../types/sessionEngine';
import { runAutoSocialEventFlowImpl, runSessionActionImpl, runSurfaceIntentImpl, type ChatSurfaceActionContext } from './chatSurfaceActions';
import { useChatStore } from '../stores/useChatStore';
import * as authStorageScope from './authStorageScope';

function buildCharacter(id: string, name: string): AICharacter {
  return {
    id,
    name,
    avatar: '',
    personality: DEFAULT_PERSONALITY,
    behavior: DEFAULT_CHARACTER_BEHAVIOR,
    expertise: [],
    speakingStyle: '',
    background: '',
    relationships: [],
    memory: DEFAULT_CHARACTER_MEMORY,
    intervention: DEFAULT_CHARACTER_INTERVENTION,
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildChat() {
  return normalizeConversation({
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free' },
    name: 'chat-1',
    topic: '',
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

function buildDirectChat() {
  return normalizeConversation({
    ...buildChat(),
    id: 'direct-1',
    type: 'direct',
    name: 'direct-1',
    memberIds: ['a'],
  });
}

function buildContext(): ChatSurfaceActionContext {
  const chat = buildChat();
  return {
    chat,
    chats: [chat],
    characters: [buildCharacter('a', 'A'), buildCharacter('b', 'B')],
    actionSchema: null,
    speakAsChar: null,
    updateChat: vi.fn(async () => undefined),
    addMessage: vi.fn(async () => undefined),
    appendEventMessage: vi.fn(async () => undefined),
    setSnackbar: vi.fn(),
  };
}

describe('chatSurfaceActions', () => {
  it.each(['deleted', 'account_changed'] as const)('rejects social writes after the source becomes %s during execution', async (reason) => {
    const context = buildContext();
    const source = context.chat!;
    const getChat = vi.spyOn(useChatStore.getState(), 'getChat').mockReturnValue(source);
    const account = vi.spyOn(authStorageScope, 'getLocalDataUserId').mockReturnValue('initial');
    const applyPatch = vi.spyOn(useChatStore.getState(), 'applyChatRuntimePatch');
    const addChat = vi.spyOn(useChatStore.getState(), 'addChat');
    const runSocialEventAutoFlow = vi.fn(async (_chat: GroupChat, ops: SocialEventRuntimeOps) => {
      if (reason === 'deleted') getChat.mockReturnValue({ ...source, deletedAt: 1 });
      else account.mockReturnValue('different');
      expect(await ops.applyChatRuntimePatch(source.id, () => ({}))).toBe(false);
      await expect(ops.addChat(source)).rejects.toThrow('账户或来源会话已失效');
      await expect(ops.addMessage({ chatId: source.id, senderId: 'a', senderName: '甲',
        type: 'ai', content: '你好', emotion: 0 })).rejects.toThrow('账户或来源会话已失效');
      await expect(ops.appendEventMessage(source.id, { eventType: 'test', title: '事件', summary: '已完成' }))
        .rejects.toThrow('账户或来源会话已失效');
      return { handledEventId: null };
    });
    vi.doMock('./directSessionRuntime', () => ({ runSocialEventAutoFlow }));
    try {
      await runAutoSocialEventFlowImpl(source, context);
      expect(runSocialEventAutoFlow).toHaveBeenCalledOnce();
      expect(applyPatch).not.toHaveBeenCalled();
      expect(addChat).not.toHaveBeenCalled();
      expect(context.addMessage).not.toHaveBeenCalled();
      expect(context.appendEventMessage).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('./directSessionRuntime');
      vi.restoreAllMocks();
    }
  });

  it('applies calendar patch drafts via unified patch queue action', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    const applyWorldCalendarPatchDraftQueue = vi.fn(async () => ({
      appliedCount: 2,
      skippedCount: 1,
      failedCount: 0,
      persistedCount: 2,
      failures: [],
      appliedItems: [{ chatId: 'chat-1', calendarItemId: 'item-1', idempotencyKey: 'k1', reason: 'patch-1' }],
      skippedItems: [{ calendarItemId: 'item-2', idempotencyKey: 'k2', reason: 'duplicate_idempotency' as const }],
    }));
    vi.doMock('./worldCalendarPatchApply', () => ({ applyWorldCalendarPatchDraftQueue }));
    try {
      await runSessionActionImpl(context, { type: 'apply_calendar_patch_drafts' }, {}, trigger);
      expect(applyWorldCalendarPatchDraftQueue).toHaveBeenCalledTimes(1);
      expect(trigger).not.toHaveBeenCalled();
      expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
        open: true,
        severity: 'success',
      }));
      expect(context.appendEventMessage).toHaveBeenCalledWith(
        context.chat?.id,
        expect.objectContaining({
          eventType: 'calendar_patch_apply_result',
          visibilityScope: 'moderator_only',
          metrics: expect.objectContaining({
            appliedCount: 2,
            skippedCount: 1,
            failedCount: 0,
          }),
        }),
      );
    } finally {
      vi.doUnmock('./worldCalendarPatchApply');
    }
  });

  it('rejects calendar patch action when actor has no moderation capability', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    const applyWorldCalendarPatchDraftQueue = vi.fn(async () => ({
      appliedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      persistedCount: 1,
      failures: [],
      appliedItems: [],
      skippedItems: [],
    }));
    vi.doMock('./worldCalendarPatchApply', () => ({ applyWorldCalendarPatchDraftQueue }));
    try {
      await runSessionActionImpl(context, { type: 'apply_calendar_patch_drafts', actorId: 'a' }, {}, trigger);
      expect(applyWorldCalendarPatchDraftQueue).not.toHaveBeenCalled();
      expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
        open: true,
        severity: 'error',
      }));
    } finally {
      vi.doUnmock('./worldCalendarPatchApply');
    }
  });

  it('routes start_private_thread action to trigger callback', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'start_private_thread' }, { actorId: 'a', targetId: 'b' }, trigger);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(context.chat, 'a', 'b', true);
  });

  it('does not trigger start_private_thread when payload is invalid', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'start_private_thread' }, { actorId: 'a', targetId: 'a' }, trigger);
    await runSessionActionImpl(context, { type: 'start_private_thread' }, { actorId: '', targetId: 'b' }, trigger);
    await runSessionActionImpl(context, { type: 'start_private_thread' }, { actorId: 'a', targetId: 'not-in-chat' }, trigger);
    expect(trigger).not.toHaveBeenCalled();
    expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      severity: 'error',
    }));
  });

  it('does not trigger start_private_thread when one side is not an AI participant', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'user'],
    });
    const context = {
      ...buildContext(),
      chat,
      chats: [chat],
      characters: [buildCharacter('a', 'A')],
    } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'start_private_thread' }, { actorId: 'a', targetId: 'user' }, trigger);
    expect(trigger).not.toHaveBeenCalled();
    expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      severity: 'error',
    }));
  });

  it('writes runtime contract for regular action', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'director_intervention', actorId: 'a' }, { prompt: '推进下一阶段' }, trigger);
    expect(context.updateChat).toHaveBeenCalledTimes(1);
    expect(context.appendEventMessage).toHaveBeenCalledTimes(1);
  });

  it('applies story branch action through session executor', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      mode: 'scripted_play',
      sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
      scenarioState: {
        ...(buildChat().scenarioState || {}),
        phase: 'scene',
        choiceEpoch: 1,
        branches: [
          { branchId: 'main', label: '主线', status: 'available' as const, choiceEpoch: 1 },
          { branchId: 'hidden', label: '暗线', status: 'available' as const, choiceEpoch: 1, intent: '追踪', risk: '暴露行踪', reward: '找到线索' },
        ],
      },
    });
    const context = { ...buildContext(), chat, chats: [chat] } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'choose_story_branch' }, { branchId: 'hidden', prompt: '追查暗线' }, trigger);
    expect(context.updateChat).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      scenarioState: expect.objectContaining({
        phase: 'branch',
        storyBeatKind: 'consequence',
        storyChoicePolicy: 'forbid',
        storyBeatReason: 'resolve selected branch before opening another choice',
        selectedChoiceEpoch: 1,
        selectedChoice: expect.objectContaining({
          branchId: 'hidden',
          label: '暗线',
          prompt: '追查暗线',
          intent: '追踪',
          risk: '暴露行踪',
          reward: '找到线索',
          choiceEpoch: 1,
          chosenAt: expect.any(Number),
        }),
        choiceHistory: [expect.objectContaining({
          branchId: 'hidden',
          label: '暗线',
          prompt: '追查暗线',
          intent: '追踪',
          risk: '暴露行踪',
          reward: '找到线索',
          choiceEpoch: 1,
          chosenAt: expect.any(Number),
        })],
        branches: expect.arrayContaining([
          expect.objectContaining({ branchId: 'hidden', status: 'chosen', choiceEpoch: 1 }),
          expect.objectContaining({ branchId: 'main', status: 'completed', choiceEpoch: 1 }),
        ]),
      }),
    }));
    expect(context.appendEventMessage).toHaveBeenCalledWith(chat.id, expect.objectContaining({ eventType: 'story_branch' }));
  });

  it('lets the user choose a story branch even when user is not a room member', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      mode: 'scripted_play',
      sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
      scenarioState: {
        ...(buildChat().scenarioState || {}),
        phase: 'choice',
        choiceEpoch: 3,
        branches: [
          { branchId: 'ask', label: '追问护士', status: 'available' as const, choiceEpoch: 3, prompt: '追问护士停电期间的位置' },
          { branchId: 'search', label: '检查血迹', status: 'available' as const, choiceEpoch: 3, prompt: '检查墙上的新鲜血迹' },
        ],
      },
    });
    const context = { ...buildContext(), chat, chats: [chat] } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'choose_story_branch', actorId: 'user' }, { branchId: 'ask', prompt: '追问护士停电期间的位置' }, trigger);
    expect(context.updateChat).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      scenarioState: expect.objectContaining({
        phase: 'branch',
        selectedChoiceEpoch: 3,
        branches: expect.arrayContaining([
          expect.objectContaining({ branchId: 'ask', status: 'chosen', choiceEpoch: 3 }),
          expect.objectContaining({ branchId: 'search', status: 'completed', choiceEpoch: 3 }),
        ]),
      }),
    }));
    expect(context.appendEventMessage).toHaveBeenCalledWith(chat.id, expect.objectContaining({ eventType: 'story_branch' }));
  });

  it('cleans branch prompt meta before writing story branch direction', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      mode: 'scripted_play',
      sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
      scenarioState: {
        ...(buildChat().scenarioState || {}),
        phase: 'choice',
        choiceEpoch: 3,
        branches: [
          { branchId: 'ask', label: '追问护士', status: 'available' as const, choiceEpoch: 3, prompt: '追问护士停电期间的位置；风险：激怒护士；收益：确认时间线' },
          { branchId: 'search', label: '检查血迹', status: 'available' as const, choiceEpoch: 3, prompt: '检查墙上的血迹' },
        ],
      },
    });
    const context = { ...buildContext(), chat, chats: [chat] } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'choose_story_branch', actorId: 'user' }, { branchId: 'ask' }, trigger);

    expect(context.updateChat).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      scenarioState: expect.objectContaining({
        storyDirection: '追问护士停电期间的位置',
        selectedChoice: expect.objectContaining({
          branchId: 'ask',
          prompt: '追问护士停电期间的位置',
        }),
        choiceHistory: [expect.objectContaining({
          branchId: 'ask',
          prompt: '追问护士停电期间的位置',
        })],
      }),
    }));
  });

  it('keeps repeated story branch selection idempotent for the same choice epoch', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      mode: 'scripted_play',
      sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
      scenarioState: {
        ...(buildChat().scenarioState || {}),
        phase: 'branch',
        choiceEpoch: 3,
        selectedChoiceEpoch: 3,
        selectedChoice: { branchId: 'ask', label: '追问护士', prompt: '追问护士停电期间的位置', choiceEpoch: 3 },
        choiceHistory: [{ branchId: 'ask', label: '追问护士', prompt: '追问护士停电期间的位置', choiceEpoch: 3 }],
        branches: [
          { branchId: 'ask', label: '追问护士', status: 'chosen' as const, choiceEpoch: 3, prompt: '追问护士停电期间的位置' },
          { branchId: 'search', label: '检查血迹', status: 'completed' as const, choiceEpoch: 3, prompt: '检查墙上的新鲜血迹' },
        ],
      },
    });
    const context = { ...buildContext(), chat, chats: [chat] } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'choose_story_branch', actorId: 'user' }, { branchId: 'ask', prompt: '追问护士停电期间的位置' }, trigger);
    const patch = vi.mocked(context.updateChat).mock.calls[0]?.[1];
    expect(patch?.scenarioState).toBeUndefined();
    expect(patch?.worldState).toEqual(expect.objectContaining({
      recentEvent: expect.stringContaining('剧情分支'),
    }));
    expect(context.appendEventMessage).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      eventType: 'story_branch',
      metrics: expect.objectContaining({ duplicate: true }),
    }));
  });

  it('does not select a stale story branch from an older choice epoch', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      mode: 'scripted_play',
      sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
      scenarioState: {
        ...(buildChat().scenarioState || {}),
        phase: 'choice',
        choiceEpoch: 4,
        branches: [
          { branchId: 'ask-old', label: '追问护士', status: 'available' as const, choiceEpoch: 3, prompt: '旧轮追问护士' },
          { branchId: 'ask-current', label: '追问护士', status: 'available' as const, choiceEpoch: 4, prompt: '当前轮追问护士' },
          { branchId: 'search-current', label: '检查血迹', status: 'available' as const, choiceEpoch: 4, prompt: '当前轮检查血迹' },
        ],
      },
    });
    const context = { ...buildContext(), chat, chats: [chat] } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'choose_story_branch', actorId: 'user' }, { branchId: 'ask-old', prompt: '用户点到了过期选项' }, trigger);
    expect(context.updateChat).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      scenarioState: expect.objectContaining({
        phase: 'branch',
        selectedChoiceEpoch: 4,
        selectedChoice: expect.objectContaining({
          prompt: '用户点到了过期选项',
          choiceEpoch: 4,
        }),
        branches: expect.arrayContaining([
          expect.objectContaining({ branchId: 'ask-old', status: 'available', choiceEpoch: 3 }),
          expect.objectContaining({ branchId: 'ask-current', status: 'completed', choiceEpoch: 4 }),
          expect.objectContaining({ branchId: 'search-current', status: 'completed', choiceEpoch: 4 }),
          expect.objectContaining({ source: 'custom', status: 'chosen', choiceEpoch: 4 }),
        ]),
      }),
    }));
  });


  it('records custom story branch direction from free input', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      mode: 'scripted_play',
      sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
      scenarioState: {
        phase: 'scene',
        choiceEpoch: 1,
        branches: [{ branchId: 'main', label: '主线', status: 'available' as const, choiceEpoch: 1 }],
      },
    });
    const context = { ...buildContext(), chat, chats: [chat] } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'choose_story_branch' }, { branchId: '__custom_story_branch', prompt: '主角决定独自进入旧宅地下室' }, trigger);
    expect(context.updateChat).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      scenarioState: expect.objectContaining({
        phase: 'branch',
        storyDirection: '主角决定独自进入旧宅地下室',
        selectedChoiceEpoch: 1,
        branches: expect.arrayContaining([
          expect.objectContaining({ branchId: 'main', status: 'completed', choiceEpoch: 1 }),
          expect.objectContaining({ source: 'custom', status: 'chosen', choiceEpoch: 1 }),
        ]),
      }),
    }));
  });


  it('marks non-member operator origin in action audit metrics', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'b'],
      operatorIds: ['host_moderator'],
    });
    const context = {
      ...buildContext(),
      chat,
      chats: [chat],
    } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(
      context,
      { type: 'director_intervention', actorId: 'host_moderator' },
      { prompt: '先收束争议' },
      trigger,
    );
    expect(context.appendEventMessage).toHaveBeenCalledWith(
      chat.id,
      expect.objectContaining({
        eventType: 'interview_phase_control',
        metrics: expect.objectContaining({
          _actorAudit: expect.objectContaining({
            actorId: 'host_moderator',
            origin: 'operator',
            isOperator: true,
          }),
        }),
      }),
    );
  });

  it('rejects generic action when target is outside current chat', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(
      context,
      { type: 'ask_question', actorId: 'a' },
      { targetId: 'outsider', prompt: '请回答' },
      trigger,
    );
    expect(context.updateChat).not.toHaveBeenCalled();
    expect(context.appendEventMessage).not.toHaveBeenCalled();
    expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      severity: 'error',
    }));
  });

  it('rejects director_intervention when target is outside current chat', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(
      context,
      { type: 'director_intervention', actorId: 'a' },
      { targetId: 'outsider', prompt: '推进' },
      trigger,
    );
    expect(context.updateChat).not.toHaveBeenCalled();
    expect(context.appendEventMessage).not.toHaveBeenCalled();
    expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      severity: 'error',
    }));
  });

  it('converts attention followup action into developer guidance message', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(
      context,
      { type: 'attention_followup_user', actorId: 'a' },
      { focus: '先回应用户刚才的问题，再追问一个细节' },
      trigger,
    );
    expect(context.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: context.chat?.id,
      type: 'god',
      senderId: 'user',
    }));
    expect(context.updateChat).toHaveBeenCalledWith(
      context.chat?.id,
      expect.objectContaining({
        runtimeEventsV2: expect.arrayContaining([
          expect.objectContaining({
            kind: 'director_intervention',
            visibility: 'moderator_only',
            payload: expect.objectContaining({
              eventType: 'attention_followup_user',
              actorId: 'a',
            }),
          }),
        ]),
      }),
    );
    expect(context.appendEventMessage).toHaveBeenCalledWith(
      context.chat?.id,
      expect.objectContaining({
        eventType: 'attention_followup_user',
        visibilityScope: 'moderator_only',
      }),
    );
    expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      severity: 'success',
    }));
  });

  it('rejects attention followup action when target is not a current AI member', async () => {
    const chat = normalizeConversation({
      ...buildChat(),
      memberIds: ['a', 'user'],
    });
    const context = {
      ...buildContext(),
      chat,
      chats: [chat],
      characters: [buildCharacter('a', 'A')],
    } satisfies ChatSurfaceActionContext;
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(context, { type: 'attention_followup_user', actorId: 'user' }, {}, trigger);
    expect(context.updateChat).not.toHaveBeenCalled();
    expect(context.addMessage).not.toHaveBeenCalled();
    expect(context.appendEventMessage).not.toHaveBeenCalled();
    expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      severity: 'error',
    }));
  });

  it('converts attention_followup_member action into topic-guidance message', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(
      context,
      { type: 'attention_followup_member', actorId: 'a' },
      { targetId: 'b', focus: '先回应他刚才的核心判断，再补一个反例' },
      trigger,
    );
    expect(context.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: context.chat?.id,
      type: 'god',
      senderId: 'user',
      content: expect.stringContaining('请A先跟进B'),
    }));
    expect(context.updateChat).toHaveBeenCalledWith(
      context.chat?.id,
      expect.objectContaining({
        runtimeEventsV2: expect.arrayContaining([
          expect.objectContaining({
            kind: 'director_intervention',
            payload: expect.objectContaining({
              eventType: 'attention_followup_member',
              actorId: 'a',
              targetId: 'b',
            }),
          }),
          expect.objectContaining({
            kind: 'attention_candidate',
            actorIds: ['a'],
            targetIds: ['b'],
            payload: expect.objectContaining({
              source: 'manual_attention_followup_member',
            }),
          }),
        ]),
      }),
    );
    expect(context.appendEventMessage).toHaveBeenCalledWith(
      context.chat?.id,
      expect.objectContaining({
        eventType: 'attention_followup_member',
        visibilityScope: 'moderator_only',
      }),
    );
  });

  it('rejects attention_followup_member when target is invalid', async () => {
    const context = buildContext();
    const trigger = vi.fn(async () => null);
    await runSessionActionImpl(
      context,
      { type: 'attention_followup_member', actorId: 'a' },
      { targetId: 'user' },
      trigger,
    );
    expect(context.updateChat).not.toHaveBeenCalled();
    expect(context.addMessage).not.toHaveBeenCalled();
    expect(context.appendEventMessage).not.toHaveBeenCalled();
    expect(context.setSnackbar).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      severity: 'error',
    }));
  });

  it('routes message intent to guide sender by default', async () => {
    const context = buildContext();
    const runSessionAction = vi.fn(async () => undefined);
    const handleGuideSend = vi.fn(async () => undefined);
    const handleMemberSpeakSend = vi.fn(async () => undefined);
    const handleSpeakAs = vi.fn(async () => undefined);
    const intent = {
      intent: {
        type: 'message_intent',
        payload: { content: '你好', mode: 'guide' },
      },
    } as SessionNormalizedIntentResult;
    await runSurfaceIntentImpl(context, intent, { runSessionAction, handleGuideSend, handleMemberSpeakSend, handleSpeakAs });
    expect(handleGuideSend).toHaveBeenCalledWith('你好', []);
    expect(handleMemberSpeakSend).not.toHaveBeenCalled();
    expect(handleSpeakAs).not.toHaveBeenCalled();
    expect(runSessionAction).not.toHaveBeenCalled();
  });

  it('routes direct chat text to user sender even when legacy surface says guide', async () => {
    const chat = buildDirectChat();
    const context = { ...buildContext(), chat, chats: [chat] };
    const runSessionAction = vi.fn(async () => undefined);
    const handleGuideSend = vi.fn(async () => undefined);
    const handleMemberSpeakSend = vi.fn(async () => undefined);
    const handleSpeakAs = vi.fn(async () => undefined);
    const intent = {
      intent: {
        type: 'message_intent',
        payload: { content: '你在吗', mode: 'guide' },
      },
    } as SessionNormalizedIntentResult;
    await runSurfaceIntentImpl(context, intent, { runSessionAction, handleGuideSend, handleMemberSpeakSend, handleSpeakAs });
    expect(handleMemberSpeakSend).toHaveBeenCalledWith('你在吗', []);
    expect(handleGuideSend).not.toHaveBeenCalled();
    expect(handleSpeakAs).not.toHaveBeenCalled();
    expect(runSessionAction).not.toHaveBeenCalled();
  });

  it('routes memberSpeak mode to member sender', async () => {
    const context = buildContext();
    const runSessionAction = vi.fn(async () => undefined);
    const handleGuideSend = vi.fn(async () => undefined);
    const handleMemberSpeakSend = vi.fn(async () => undefined);
    const handleSpeakAs = vi.fn(async () => undefined);
    const intent = {
      intent: {
        type: 'message_intent',
        payload: { content: '我是成员', mode: 'memberSpeak' },
      },
    } as SessionNormalizedIntentResult;
    await runSurfaceIntentImpl(context, intent, { runSessionAction, handleGuideSend, handleMemberSpeakSend, handleSpeakAs });
    expect(handleMemberSpeakSend).toHaveBeenCalledWith('我是成员', []);
    expect(handleGuideSend).not.toHaveBeenCalled();
    expect(handleSpeakAs).not.toHaveBeenCalled();
    expect(runSessionAction).not.toHaveBeenCalled();
  });

  it('routes message intent to speakAs when speakAsChar exists', async () => {
    const context = { ...buildContext(), speakAsChar: buildCharacter('a', 'A') };
    const runSessionAction = vi.fn(async () => undefined);
    const handleGuideSend = vi.fn(async () => undefined);
    const handleMemberSpeakSend = vi.fn(async () => undefined);
    const handleSpeakAs = vi.fn(async () => undefined);
    const intent = {
      intent: {
        type: 'message_intent',
        payload: { content: '我来讲', mode: 'guide' },
      },
    } as SessionNormalizedIntentResult;
    await runSurfaceIntentImpl(context, intent, { runSessionAction, handleGuideSend, handleMemberSpeakSend, handleSpeakAs });
    expect(handleSpeakAs).toHaveBeenCalledWith('我来讲', []);
    expect(handleGuideSend).not.toHaveBeenCalled();
    expect(handleMemberSpeakSend).not.toHaveBeenCalled();
  });

  it('handles board intent by writing runtime event', async () => {
    const context = buildContext();
    const runSessionAction = vi.fn(async () => undefined);
    const handleGuideSend = vi.fn(async () => undefined);
    const handleMemberSpeakSend = vi.fn(async () => undefined);
    const handleSpeakAs = vi.fn(async () => undefined);
    const intent = {
      intent: {
        type: 'board_intent',
        payload: {
          boardId: 'main',
          action: 'place',
          piece: 'x',
          point: { x: 1, y: 2 },
        },
      },
    } as SessionNormalizedIntentResult;
    await runSurfaceIntentImpl(context, intent, { runSessionAction, handleGuideSend, handleMemberSpeakSend, handleSpeakAs });
    expect(context.updateChat).toHaveBeenCalledTimes(1);
    expect(context.appendEventMessage).toHaveBeenCalledTimes(1);
  });

  it('maps action intent from normalized surface intent', async () => {
    const context = {
      ...buildContext(),
      actionSchema: {
        schemaId: 'schema',
        title: 'actions',
        actions: [{ type: 'director_intervention', label: '导演干预' }],
      },
    };
    const runSessionAction = vi.fn(async () => undefined);
    const handleGuideSend = vi.fn(async () => undefined);
    const handleMemberSpeakSend = vi.fn(async () => undefined);
    const handleSpeakAs = vi.fn(async () => undefined);
    const intent = {
      intent: {
        type: 'action_intent',
        payload: {
          actionType: 'director_intervention',
          actorId: 'a',
          fields: { prompt: '继续推进' },
        },
      },
    } as SessionNormalizedIntentResult;
    await runSurfaceIntentImpl(context, intent, { runSessionAction, handleGuideSend, handleMemberSpeakSend, handleSpeakAs });
    expect(runSessionAction).toHaveBeenCalledTimes(1);
    expect(runSessionAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'director_intervention' }),
      { prompt: '继续推进' },
    );
    expect(handleGuideSend).not.toHaveBeenCalled();
    expect(handleMemberSpeakSend).not.toHaveBeenCalled();
    expect(handleSpeakAs).not.toHaveBeenCalled();
  });
});
