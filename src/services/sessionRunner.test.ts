import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { buildNoSendContextKey, runSessionLoop, shouldPauseSettledConversation } from './sessionRunner';
import { GenerationCancelledError } from './generationCancellation';

const runOneRoundMock = vi.fn();
const runSessionActionExecutorMock = vi.fn();
const runSessionCommitPipelineMock = vi.fn();

vi.mock('./chatEngine', () => ({
  runOneRound: (...args: unknown[]) => runOneRoundMock(...args),
}));

vi.mock('./sessionActionExecutors/sessionActionExecutorRegistry', () => ({
  runSessionActionExecutor: (...args: unknown[]) => runSessionActionExecutorMock(...args),
}));

vi.mock('./sessionCommitPipeline', () => ({
  runSessionCommitPipeline: (...args: unknown[]) => runSessionCommitPipelineMock(...args),
}));

vi.mock('./sessionEngineKernel', () => ({
  createSessionRuntimeContext: () => ({ participants: [] }),
}));

vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ token: null, user: null }),
  },
}));

vi.mock('./sessionActionBus', () => ({
  getAllowedSessionActions: (_engine: unknown, context: { conversation: GroupChat }) => {
    if (context.conversation.sessionKind?.scenarioId === 'open-chat') return [{ type: 'speak' }];
    if (context.conversation.sessionKind?.scenarioId === 'werewolf-classic') return [{ type: 'wolf_vote' }];
    return [{ type: 'ask_question', payload: { prompt: '问题', targetId: 'b' }, targetIds: ['b'] }, { type: 'speak' }];
  },
}));

vi.mock('./sessionStateMachine', () => ({
  getCurrentSessionPhase: (_engine: unknown, chat: GroupChat) => ({
    allowedActions: chat.sessionKind?.scenarioId === 'open-chat' && chat.worldState.phase === 'aligned'
      ? ['director_intervention']
      : ['ask_question', 'speak'],
  }),
}));

vi.mock('./interviewRunnerPolicy', () => ({
  shouldInterviewAllowSpeak: (chat: GroupChat) => chat.worldState.phase !== 'aligned',
  shouldInterviewRunAction: (chat: GroupChat) => chat.worldState.phase === 'idle' || chat.worldState.phase === 'aligned',
}));

vi.mock('./engines/interviewEngine', () => ({
  INTERVIEW_ENGINE: {
    key: 'interview',
    createInitialConfig: () => ({}),
    createInitialState: () => ({}),
    buildParticipants: () => [],
    getVisiblePanels: () => [],
    getAvailableActions: () => [{ type: 'ask_question' }],
    getActionSchema: () => ({
      title: '面试动作',
      actions: [{ type: 'ask_question', payload: { prompt: '问题', targetId: 'b' }, targetIds: ['b'] }],
    }),
    resolveTurnPolicy: (context: { conversation: GroupChat }) => ({
      runChat: context.conversation.worldState.phase !== 'idle' && context.conversation.worldState.phase !== 'aligned',
      runAction: true,
      interleaveAction: false,
    }),
    buildGenerationPromptContext: () => ({ promptPrefix: 'interview' }),
    onMessageCommitted: async () => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] }),
  },
}));

vi.mock('./engines/openChatEngine', () => ({
  openChatEngine: {
    key: 'open_chat',
    createInitialConfig: () => ({}),
    createInitialState: () => ({}),
    buildParticipants: () => [],
    getVisiblePanels: () => [],
    getAvailableActions: () => [{ type: 'speak' }],
    getActionSchema: () => null,
    resolveTurnPolicy: (context: { conversation: GroupChat }) => ({
      runChat: context.conversation.worldState.phase !== 'aligned',
      runAction: false,
      interleaveAction: false,
    }),
    buildGenerationPromptContext: () => ({ promptPrefix: 'open' }),
    onMessageCommitted: async () => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] }),
  },
}));

vi.mock('./engines/werewolfEngine', () => ({
  WEREWOLF_ENGINE: {
    key: 'werewolf',
    createInitialConfig: () => ({}),
    createInitialState: () => ({}),
    buildParticipants: () => [],
    getVisiblePanels: () => [],
    getAvailableActions: () => [{ type: 'wolf_vote' }],
    getActionSchema: () => ({ title: '狼人动作', actions: [{ type: 'wolf_vote', payload: { targetId: 'b' }, targetIds: ['b'] }] }),
    resolveTurnPolicy: () => ({ runChat: false, runAction: true, interleaveAction: false }),
    onMessageCommitted: async () => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] }),
  },
}));

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realMathRandom = Math.random;
const realLocalStorage = globalThis.localStorage;

const localStorageStub = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(() => null),
  length: 0,
} as Storage;

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageStub,
  configurable: true,
});

globalThis.setTimeout = ((fn: (...args: unknown[]) => void) => {
  fn();
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as unknown as typeof setTimeout;

globalThis.clearTimeout = (() => undefined) as unknown as typeof clearTimeout;
Math.random = () => 0;

afterAll(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Math.random = realMathRandom;
  Object.defineProperty(globalThis, 'localStorage', {
    value: realLocalStorage,
    configurable: true,
  });
});

beforeEach(() => {
  runOneRoundMock.mockReset();
  runSessionActionExecutorMock.mockReset();
  runSessionCommitPipelineMock.mockReset();
});

function buildCommitPipelineResult(args: { message: Partial<import('../types/message').Message>; chat: GroupChat; characters: unknown[] }) {
  const persistedMessage = {
    id: `persisted-${Math.random()}`,
    chatId: 'chat-1',
    type: 'ai',
    senderId: args.message.senderId || 'a',
    senderName: args.message.senderName || '甲',
    content: args.message.content || '',
    emotion: 0,
    timestamp: 1,
    isDeleted: false,
    ...args.message,
  } as Message;
  return {
    persistedMessage,
    transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] },
    nextChat: args.chat,
    nextCharacters: args.characters,
  };
}

function buildChat(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'chat-1',
    type: 'group',
    mode: 'interview',
    sessionKind: { topology: 'group', family: 'interview', scenarioId: 'panel-interview', surfaceProfile: 'form' },
    modeConfig: {},
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    name: '测试',
    topic: '测试',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['a', 'b'],
    speed: 999,
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
    ...overrides,
  } as GroupChat;
}

function buildLoopParams(chat: GroupChat) {
  let running = true;
  return {
    loopId: 'loop-1',
    chatId: chat.id,
    chat,
    characters: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as never[],
    api: { provider: 'openai', apiKey: 'x', baseUrl: 'http://localhost', model: 'test' },
    getCurrentMessages: () => [] as Message[],
    isRunning: () => running,
    isPaused: () => false,
    isActiveLoop: (loopId: string): boolean => loopId === 'loop-1',
    onSpeakerSelected: vi.fn(),
    getStreamingMessage: undefined as (() => unknown) | undefined,
    onCommitStarted: undefined as (() => void) | undefined,
    pauseLoop: () => { running = false; },
    onCommitFinished: undefined as (() => void) | undefined,
    onTurnWorkStarted: undefined as (() => void) | undefined,
    onTurnWorkFinished: undefined as (() => void) | undefined,
    getCurrentChat: undefined as (() => GroupChat | undefined) | undefined,
    onMessageChunk: vi.fn(),
    onIdle: vi.fn(() => { running = false; }),
    onClearStreamingState: vi.fn(),
    onDiscardStreamingMessage: vi.fn(),
    onEngineError: vi.fn(),
    onLoopError: vi.fn(() => { running = false; }),
    onCommit: vi.fn(async () => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] })),
    upsertMessage: vi.fn(),
    updateCharacter: vi.fn(async () => undefined),
    appendEventMessage: vi.fn(async () => undefined),
    updateChat: vi.fn(async () => { running = false; }),
    recordSpeak: vi.fn(),
    signal: undefined as AbortSignal | undefined,
  };
}

describe('runSessionLoop', () => {
  it('reports why visible streamed text is discarded after generation fails', async () => {
    const error = Object.assign(new Error('结构化回复无效'), { protocolReason: 'missing_json_envelope' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }));
    const notify = vi.fn();
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      hooks.onMessageChunk('已经显示的回复');
      hooks.onError(error);
      params.pauseLoop();
    });
    try {
      await runSessionLoop({ ...params, onMessageDisplayAnomaly: notify } as never);
      expect(warning).toHaveBeenCalledWith('[chat-run:stream-preview-discarded]', expect.objectContaining({
        reason: 'generation_failed', previewContentLength: '已经显示的回复'.length,
        protocolReason: 'missing_json_envelope',
      }));
      expect(params.onCommit).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('notifies when visible text is reset for an output retry even if the next attempt is quiet', async () => {
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }));
    const notify = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      hooks.onMessageChunk('');
      hooks.onMessageChunk('已显示的无效回复');
      hooks.onMessageChunk('');
      hooks.onQuiet();
      params.pauseLoop();
    });
    try {
      await runSessionLoop({ ...params, onMessageDisplayAnomaly: notify } as never);
      expect(notify).toHaveBeenCalledExactlyOnceWith('刚才显示的回复未通过格式检查，正在重新生成。');
      expect(warning).toHaveBeenCalledWith('[chat-run:stream-preview-discarded]', expect.objectContaining({
        reason: 'output_retry', previewContentLength: '已显示的无效回复'.length,
      }));
    } finally {
      warning.mockRestore();
    }
  });

  it('does not notify when a character declines without displaying text', async () => {
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }));
    const notify = vi.fn();
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      hooks.onNoSend({ speakerId: 'a' });
      params.pauseLoop();
    });
    await runSessionLoop({ ...params, onMessageDisplayAnomaly: notify } as never);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ['speaker_reselected', '本轮重新选择了发言角色，上一段预览未发送。'],
    ['idle_after_preview', '房间已进入等待状态，但生成过程中出现了文字预览，这段文字未发送。'],
    ['quiet_after_preview', '本轮最终返回静默结果，与已显示的文字不一致，这段预览未发送。'],
    ['no_send_after_preview', '角色最终选择了不发言，与已显示的文字不一致，这段预览未发送。'],
  ])('explains the specific preview removal reason: %s', async (reason, explanation) => {
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }));
    const notify = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      hooks.onMessageChunk('已经显示的文字');
      if (reason === 'speaker_reselected') hooks.onSpeakerSelected('b', { id: 'b', name: '乙' });
      if (reason === 'idle_after_preview') hooks.onIdle('当前阶段没有可发言角色');
      if (reason === 'quiet_after_preview') hooks.onQuiet();
      if (reason === 'no_send_after_preview') hooks.onNoSend({ speakerId: 'a' });
      params.pauseLoop();
    });
    try {
      await runSessionLoop({ ...params, onMessageDisplayAnomaly: notify } as never);
      expect(notify).toHaveBeenCalledExactlyOnceWith(explanation);
      expect(warning).toHaveBeenCalledWith('[chat-run:stream-preview-discarded]', expect.objectContaining({
        reason, detail: reason === 'idle_after_preview' ? '当前阶段没有可发言角色' : null,
      }));
    } finally {
      warning.mockRestore();
    }
  });

  it('reports a committed reply that disappears from the active message projection', async () => {
    const preview = { id: 'preview', clientKey: 'preview', chatId: 'chat-1', type: 'ai', senderId: 'a',
      senderName: '甲', content: '预览', timestamp: 1, isStreaming: true } as Message;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notify = vi.fn();
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }));
    params.getCurrentMessages = () => [preview];
    params.getStreamingMessage = () => preview;
    runSessionCommitPipelineMock.mockImplementation(async (args) => {
      const result = buildCommitPipelineResult(args);
      return { ...result, persistedMessage: { ...result.persistedMessage,
        id: 'saved-but-hidden', clientKey: 'saved-but-hidden' } };
    });
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      await hooks.onMessageComplete({ ...preview, content: '正式回复' });
      params.pauseLoop();
    });
    try {
      await runSessionLoop({ ...params, onMessageDisplayAnomaly: notify } as never);
      expect(errorLog).toHaveBeenCalledWith('[chat-run:committed-message-not-projected]', expect.objectContaining({
        committedCount: 1, projectedCount: 1,
      }));
      expect(notify).toHaveBeenCalledExactlyOnceWith('回复已保存，但未能显示在当前对话中，请重新进入查看。');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('waits without starting busy work when all members decline and wakes for a new message', async () => {
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }));
    const start = vi.fn();
    const finish = vi.fn();
    const waitingChanged = vi.fn();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let messages: Message[] = [];
    let waited = false;
    let waitCount = 0;
    params.getCurrentMessages = () => messages;
    const previousTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      if (ms === 250 && runOneRoundMock.mock.calls.length === 2) {
        waited = true;
        expect(start).toHaveBeenCalledTimes(2);
        expect(finish).toHaveBeenCalledTimes(2);
        expect(waitingChanged.mock.calls).toEqual([[true]]);
        waitCount += 1;
        if (waitCount === 3) messages = [{ id: 'wake', type: 'user', content: '等一下。' } as Message];
      }
      fn();
      return 0;
    }) as unknown as typeof setTimeout;
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks, _profiles, context) => {
      const round = runOneRoundMock.mock.calls.length;
      if (round <= 2) hooks.onNoSend({ delivery: 'no_send', speakerId: round === 1 ? 'a' : 'b' });
      else {
        expect(context.consumedSpeakerIds.size).toBe(0);
        params.pauseLoop();
      }
    });
    try {
      await runSessionLoop({ ...params, onTurnWorkStarted: start, onTurnWorkFinished: finish,
        onWaitingForInputChange: waitingChanged } as never);
      expect(waited).toBe(true);
      expect(runOneRoundMock).toHaveBeenCalledTimes(3);
      expect(waitingChanged.mock.calls).toEqual([[true], [false]]);
      expect(info.mock.calls.filter(([label]) => label === '[chat-run:no-send]')).toEqual([
        ['[chat-run:no-send]', { speakerName: '甲', delivery: 'no_send' }],
        ['[chat-run:no-send]', { speakerName: '乙', delivery: 'no_send' }],
      ]);
      expect(info.mock.calls.filter(([label]) => String(label).startsWith('[chat-run:waiting-input]'))).toHaveLength(1);
    } finally {
      globalThis.setTimeout = previousTimeout;
      info.mockRestore();
    }
  });

  it('clears silent placeholders and work state without committing or counting speech', async () => {
    const chat = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const params = buildLoopParams(chat);
    const start = vi.fn();
    const finish = vi.fn();
    const discard = vi.fn();
    const commitStart = vi.fn();
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks, _profiles, context) => {
      const round = runOneRoundMock.mock.calls.length;
      expect(context.allowNoSend).toBe(true);
      if (round === 1) {
        hooks.onSpeakerSelected('a');
        hooks.onNoSend({ delivery: 'no_send', speakerId: 'a' });
      } else {
        expect([...context.consumedSpeakerIds]).toEqual(['a']);
        params.pauseLoop();
      }
    });
    await runSessionLoop({ ...params, onTurnWorkStarted: start, onTurnWorkFinished: finish,
      onDiscardStreamingMessage: discard, onCommitStarted: commitStart } as never);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(params.onClearStreamingState).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(commitStart).not.toHaveBeenCalled();
    expect(params.recordSpeak).not.toHaveBeenCalled();
    expect(params.upsertMessage).not.toHaveBeenCalled();
    expect(params.updateChat).not.toHaveBeenCalled();
    expect(params.onEngineError).not.toHaveBeenCalled();
  });

  it('invalidates silence for new dialogue and does not carry an in-flight old-context result forward', async () => {
    const chat = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const params = buildLoopParams(chat);
    let messages: Message[] = [];
    params.getCurrentMessages = () => messages;
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks, _profiles, context) => {
      const round = runOneRoundMock.mock.calls.length;
      if (round === 1) {
        hooks.onNoSend({ delivery: 'no_send', speakerId: 'a' });
        messages = [{ id: 'new', content: '新消息', type: 'user' } as Message];
      } else if (round === 2) {
        expect(context.consumedSpeakerIds.size).toBe(0);
        messages = [{ id: 'newer', content: '又一条消息', type: 'user' } as Message];
        hooks.onNoSend({ delivery: 'no_send', speakerId: 'b' });
      } else {
        expect(context.consumedSpeakerIds.size).toBe(0);
        params.pauseLoop();
      }
    });
    await runSessionLoop(params as never);
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('does not clear a replacement loop when an old silent request finishes', async () => {
    const params = buildLoopParams(buildChat());
    let active = true;
    params.isActiveLoop = () => active;
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      active = false;
      hooks.onNoSend({ delivery: 'no_send', speakerId: 'a' });
      params.pauseLoop();
    });
    await runSessionLoop(params as never);
    expect(params.onClearStreamingState).not.toHaveBeenCalled();
    expect(params.onDiscardStreamingMessage).not.toHaveBeenCalled();
  });

  it('keeps an autonomous window stable across AI and runtime updates, but resets for new external input', () => {
    const chat = buildChat();
    const key = buildNoSendContextKey(chat, []);
    expect(buildNoSendContextKey({ ...chat, updatedAt: 500, runtimeDetailHydratedAt: 600,
      worldState: { ...chat.worldState, recentEvent: '运行态发生变化' },
      runtimeEventsV2: [{ id: 'trace', kind: 'decision_trace' }, { id: 'score', kind: 'score_update', eventClass: 'score' }] as never[] }, [])).toBe(key);
    expect(buildNoSendContextKey(chat, [{ id: 'typing', type: 'ai', content: '未提交草稿', isStreaming: true } as Message])).toBe(key);
    expect(buildNoSendContextKey(chat, [{ id: 'ai', type: 'ai', content: '新回复' } as Message])).toBe(key);
    expect(buildNoSendContextKey({ ...chat, messageBranchState: { activeBranchName: 'other' } }, [])).not.toBe(key);
    expect(buildNoSendContextKey(chat, [{ id: 'new', type: 'user', content: '你好' } as Message])).not.toBe(key);
    expect(buildNoSendContextKey(chat, [{ id: 'director', type: 'god', content: '阿甲来说说。' } as Message])).not.toBe(key);
    const previous = { id: 'user-old', type: 'user', content: '先聊鞋。', timestamp: 10 } as Message;
    const anchoredKey = buildNoSendContextKey(chat, [previous], previous);
    expect(buildNoSendContextKey(chat, [{ id: 'ai-new', type: 'ai', content: '我选平底鞋。', timestamp: 12 } as Message], previous)).toBe(anchoredKey);
    expect(buildNoSendContextKey(chat, [{ id: 'older', type: 'user', content: '更早的话题', timestamp: 1 } as Message], previous)).toBe(anchoredKey);
    expect(buildNoSendContextKey(chat, [{ id: 'user-new', type: 'user', content: '再聊外套。', timestamp: 13 } as Message], previous)).not.toBe(anchoredKey);
  });

  it('does not reopen consumed speakers when the last user message leaves the paging window', async () => {
    const chat = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const params = buildLoopParams(chat);
    let messages: Message[] = [{ id: 'user', chatId: chat.id, type: 'user', content: '先聊鞋。', timestamp: 1 } as Message];
    params.getCurrentMessages = () => messages;
    const previousTimeout = globalThis.setTimeout;
    let waited = false;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      if (ms === 250 && runOneRoundMock.mock.calls.length === 2) {
        waited = true;
        params.pauseLoop();
      }
      fn();
      return 0;
    }) as unknown as typeof setTimeout;
    runOneRoundMock.mockImplementation(async (_chat, _characters, _snapshot, _api, hooks) => {
      const round = runOneRoundMock.mock.calls.length;
      hooks.onNoSend({ delivery: 'no_send', speakerId: round === 1 ? 'a' : 'b' });
      messages = [{ id: `ai-${round}`, chatId: chat.id, type: 'ai', senderId: round === 1 ? 'a' : 'b',
        content: '已加载的新窗口。', timestamp: round + 1 } as Message];
    });
    try {
      await runSessionLoop(params as never);
    } finally {
      globalThis.setTimeout = previousTimeout;
    }
    expect(waited).toBe(true);
    expect(runOneRoundMock).toHaveBeenCalledTimes(2);
  });

  it('ignores reply debt owed by a character who has left the room', async () => {
    const chat = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const params = buildLoopParams(chat);
    params.characters = [...params.characters, { id: 'c', name: '丙' } as never];
    const messages: Message[] = [{ id: 'request', chatId: chat.id, type: 'ai', senderId: 'a', senderName: '甲',
      content: '丙，你说呢？', timestamp: 1, replyDebtTargetIds: ['c'] } as Message];
    params.getCurrentMessages = () => messages;
    const previousTimeout = globalThis.setTimeout;
    let waited = false;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      if (ms === 250 && runOneRoundMock.mock.calls.length === 2) {
        waited = true;
        params.pauseLoop();
      }
      fn();
      return 0;
    }) as unknown as typeof setTimeout;
    runOneRoundMock.mockImplementation(async (_chat, _characters, _snapshot, _api, hooks) => {
      const round = runOneRoundMock.mock.calls.length;
      hooks.onNoSend({ delivery: 'no_send', speakerId: round === 1 ? 'a' : 'b' });
    });
    try {
      await runSessionLoop(params as never);
    } finally {
      globalThis.setTimeout = previousTimeout;
    }
    expect(waited).toBe(true);
    expect(runOneRoundMock).toHaveBeenCalledTimes(2);
  });

  it('continues autonomous dialogue beyond one successful turn per member without user input', async () => {
    const chat = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const params = buildLoopParams(chat);
    const messages: Message[] = [];
    params.getCurrentMessages = () => messages;
    runSessionCommitPipelineMock.mockImplementation(async (args: Parameters<typeof buildCommitPipelineResult>[0] & { upsertMessage: (message: Message) => void }) => {
      const result = buildCommitPipelineResult(args);
      args.upsertMessage(result.persistedMessage);
      messages.push(result.persistedMessage);
      return result;
    });

    let waitedForInput = false;
    const previousTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      if (ms === 250) {
        waitedForInput = true;
        params.pauseLoop();
      }
      fn();
      return 0;
    }) as unknown as typeof setTimeout;

    runOneRoundMock.mockImplementation(async (_chat, _characters, _snapshot, _api, hooks, _profiles, context) => {
      const round = runOneRoundMock.mock.calls.length;
      expect(context.consumedSpeakerIds.size).toBe(0);
      if (round <= 6) {
        const speakerId = round % 2 === 1 ? 'a' : 'b';
        await hooks.onMessageComplete({ id: `generated-${round}`, chatId: chat.id, type: 'ai', senderId: speakerId,
          senderName: speakerId === 'a' ? '甲' : '乙', content: '这轮说完了。', emotion: 0 } as never);
      } else {
        expect(context.consumedSpeakerIds.size).toBe(0);
        params.pauseLoop();
      }
    });

    try {
      await runSessionLoop(params as never);
    } finally {
      globalThis.setTimeout = previousTimeout;
    }
    expect(waitedForInput).toBe(false);
    expect(runOneRoundMock).toHaveBeenCalledTimes(7);
    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(6);
  });

  it('reopens silent members and their reply opportunities after a successful published turn', async () => {
    const chat = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const params = buildLoopParams(chat);
    const messages: Message[] = [{ id: 'request', chatId: chat.id, type: 'ai', senderId: 'a',
      senderName: '甲', content: '乙，你说呢？', timestamp: 1, replyDebtTargetIds: ['b'] } as Message];
    params.getCurrentMessages = () => messages;
    runSessionCommitPipelineMock.mockImplementation(async (args: Parameters<typeof buildCommitPipelineResult>[0] & { upsertMessage: (message: Message) => void }) => {
      const result = buildCommitPipelineResult(args);
      args.upsertMessage(result.persistedMessage);
      messages.push(result.persistedMessage);
      return result;
    });
    runOneRoundMock.mockImplementation(async (_chat, _characters, _snapshot, _api, hooks, _profiles, context) => {
      const round = runOneRoundMock.mock.calls.length;
      if (round === 1) {
        hooks.onNoSend({ delivery: 'no_send', speakerId: 'b' });
      } else if (round === 2) {
        expect([...context.consumedSpeakerIds]).toEqual(['b']);
        expect([...context.consumedReplyDebtSpeakerIds]).toEqual(['b']);
        const speakerId = 'a';
        await hooks.onMessageComplete({ id: `generated-${round}`, chatId: chat.id, type: 'ai', senderId: speakerId,
          senderName: '甲', content: '说完了。', emotion: 0,
          replyDebtTargetIds: ['b'], primaryReplyDebtTargetId: 'b' } as never);
      } else {
        expect(context.consumedSpeakerIds.size).toBe(0);
        expect(context.consumedReplyDebtSpeakerIds.size).toBe(0);
        params.pauseLoop();
      }
    });

    await runSessionLoop(params as never);
    expect(runOneRoundMock).toHaveBeenCalledTimes(3);
  });

  it('waits for the final pending reply then pauses without another settled update', async () => {
    const start = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    let current = start;
    const messages: Message[] = [];
    const params = buildLoopParams(start);
    params.getCurrentChat = () => current;
    params.getCurrentMessages = () => messages;
    const pause = vi.fn(params.pauseLoop);
    params.pauseLoop = pause;
    runOneRoundMock.mockImplementation(async () => {
      const round = runOneRoundMock.mock.calls.length;
      if (round > 2) throw new Error('Unexpected generation after the final reply');
      current = { ...start, worldState: { ...start.worldState, conversationContinuity: { items: [], settledAt: 10 } } };
      messages.push({ id: `reply-${round}`, chatId: start.id, type: 'ai', senderId: round === 1 ? 'a' : 'b',
        senderName: round === 1 ? '甲' : '乙', content: round === 1 ? '乙，你说完咱们就走。' : '走吧。',
        timestamp: round, emotion: 0, isDeleted: false, addressedTargetIds: round === 1 ? ['b'] : [],
        primaryAddressedTargetId: round === 1 ? 'b' : null });
    });
    await runSessionLoop(params as never);
    expect(runOneRoundMock).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('keeps quiet ticks running without pause, errors or commits and reads a later user turn', async () => {
    const start = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const params = buildLoopParams(start);
    let messages: Message[] = [];
    params.getCurrentMessages = () => messages;
    const quiet = vi.fn();
    const pause = vi.fn(params.pauseLoop);
    params.pauseLoop = pause;
    runOneRoundMock.mockImplementation(async (_chat, _characters, snapshot, _api, hooks) => {
      if (runOneRoundMock.mock.calls.length === 1) {
        hooks.onQuiet();
        messages = [{ id: 'user-new', type: 'user', content: '还有一件事。' } as Message];
      } else {
        expect(snapshot).toEqual(messages);
        expect(pause).not.toHaveBeenCalled();
        hooks.onQuiet();
        params.pauseLoop();
      }
    });
    await runSessionLoop({ ...params, onQuiet: quiet } as never);
    expect(quiet).toHaveBeenCalledTimes(2);
    expect(params.onIdle).not.toHaveBeenCalled();
    expect(params.onLoopError).not.toHaveBeenCalled();
    expect(params.onEngineError).not.toHaveBeenCalled();
    expect(params.onCommit).not.toHaveBeenCalled();
    expect(params.upsertMessage).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('does not pause a newly started run because of a retained old settled signal', async () => {
    const start = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' },
      worldState: { ...buildChat().worldState, conversationContinuity: { items: [], settledAt: 10 } } });
    const params = buildLoopParams(start);
    params.getCurrentChat = () => start;
    const pause = vi.fn(params.pauseLoop);
    params.pauseLoop = pause;
    runOneRoundMock.mockImplementation(async () => {
      if (runOneRoundMock.mock.calls.length === 2) params.onIdle();
    });
    await runSessionLoop(params as never);
    expect(runOneRoundMock).toHaveBeenCalledTimes(2);
    expect(pause).not.toHaveBeenCalled();
  });

  it('resets the settlement baseline when the same loop is paused and resumed', async () => {
    const start = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    let current = start;
    let running = true;
    let paused = false;
    const params = buildLoopParams(start);
    params.getCurrentChat = () => current;
    params.isRunning = () => running;
    params.isPaused = () => {
      const wasPaused = paused;
      paused = false;
      return wasPaused;
    };
    const pause = vi.fn(() => { paused = true; });
    params.pauseLoop = pause;
    runOneRoundMock.mockImplementation(async () => {
      current = { ...start, worldState: { ...start.worldState, conversationContinuity: { items: [], settledAt: 10 } } };
      if (runOneRoundMock.mock.calls.length === 2) running = false;
    });
    await runSessionLoop(params as never);
    expect(runOneRoundMock).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('pauses a newly settled group only after pending replies are answered', () => {
    const before = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const after = { ...before, worldState: { ...before.worldState, conversationContinuity: { items: [], settledAt: 10 } } };
    const characters = buildLoopParams(before).characters;
    const request: Message = { id: 'request', chatId: before.id, type: 'ai', senderId: 'a', senderName: '甲',
      content: '乙，你说呢？', timestamp: 1, emotion: 0, isDeleted: false, addressedTargetIds: ['b'], primaryAddressedTargetId: 'b' };
    expect(shouldPauseSettledConversation(before, after, characters, [request])).toBe(false);
    expect(shouldPauseSettledConversation(before, after, characters, [request,
      { ...request, id: 'answer', senderId: 'b', content: '今天先到这。', addressedTargetIds: [], primaryAddressedTargetId: null },
    ])).toBe(true);
    expect(shouldPauseSettledConversation(after, after, characters, [])).toBe(false);
    expect(shouldPauseSettledConversation(before, { ...after, type: 'direct' }, characters, [])).toBe(false);
  });
  it.each(['direct', 'ai_direct'] as const)('pauses %s after committing every bubble from one generation', async (type) => {
    runSessionCommitPipelineMock.mockImplementation(async (args) => buildCommitPipelineResult(args));
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      for (const [index, content] of ['第一条', '第二条'].entries()) {
        await hooks.onMessageComplete({ id: `msg-${index}`, chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content, emotion: 0 });
      }
    });
    const params = buildLoopParams(buildChat({
      type,
      mode: 'open_chat',
      sessionKind: { topology: type === 'direct' ? 'direct' : 'thread', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' },
    }));
    const pauseLoop = vi.fn(params.pauseLoop);
    params.pauseLoop = pauseLoop;

    await runSessionLoop(params as never);

    expect(runOneRoundMock).toHaveBeenCalledTimes(1);
    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(2);
    const committedReplies = runSessionCommitPipelineMock.mock.calls
      .map(([args]) => args.message as Message);
    expect(committedReplies.map((message) => message.content)).toEqual(['第一条', '第二条']);
    expect(params.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '第一条' }));
    expect(params.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '第二条' }));
    expect(pauseLoop).toHaveBeenCalledTimes(1);
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('passes model stream chunks directly to the live message callback', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args) => buildCommitPipelineResult(args));
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      hooks.onMessageChunk('真');
      hooks.onMessageChunk('真正');
      hooks.onMessageChunk('真正流式');
      await hooks.onMessageComplete({ id: 'msg-stream', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: '真正流式', emotion: 0 });
    });
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    params.getCurrentMessages = () => [{ id: 'm1', chatId: 'chat-1', type: 'ai', senderId: 'b', senderName: '乙', content: '上一句', emotion: 0 }] as never[];
    params.onClearStreamingState = vi.fn(() => {
      params.onLoopError();
    });
    await runSessionLoop(params as never);
    expect(params.onMessageChunk).toHaveBeenNthCalledWith(1, '真');
    expect(params.onMessageChunk).toHaveBeenNthCalledWith(2, '真正');
    expect(params.onMessageChunk).toHaveBeenNthCalledWith(3, '真正流式');
    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation signal to the active round and does not commit after cancellation', async () => {
    const controller = new AbortController();
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      expect(hooks.signal).toBe(controller.signal);
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      controller.abort();
      throw new GenerationCancelledError();
    });
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    params.signal = controller.signal;
    params.getCurrentMessages = () => [{ id: 'm1', chatId: 'chat-1', type: 'ai', senderId: 'b', senderName: '乙', content: '上一句', emotion: 0 }] as never[];

    await runSessionLoop(params as never);

    expect(params.onClearStreamingState).toHaveBeenCalledTimes(1);
    expect(params.onCommit).not.toHaveBeenCalled();
    expect(params.appendEventMessage).not.toHaveBeenCalled();
    expect(params.onEngineError).not.toHaveBeenCalled();
  });

  it('does not clear or pause a replacement loop when the old round is cancelled', async () => {
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }));
    params.pauseLoop = vi.fn();
    runOneRoundMock.mockImplementation(async () => {
      params.isActiveLoop = () => false;
      throw new GenerationCancelledError();
    });
    await runSessionLoop(params as never);
    expect(params.onClearStreamingState).not.toHaveBeenCalled();
    expect(params.pauseLoop).not.toHaveBeenCalled();
  });

  it('idles blocked interview actions when no executable schema action is available', async () => {
    const params = buildLoopParams(buildChat({ mode: 'interview', worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    await runSessionLoop(params as never);
    expect(runSessionActionExecutorMock).not.toHaveBeenCalled();
    expect(runOneRoundMock).not.toHaveBeenCalled();
    expect(params.updateChat).not.toHaveBeenCalled();
    expect(params.onIdle).toHaveBeenCalled();
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('does not auto-run manual governance actions from the action schema', async () => {
    const engine = {
      key: 'governance-test',
      createInitialConfig: () => ({}),
      createInitialState: () => ({}),
      buildParticipants: () => [],
      getVisiblePanels: () => [],
      getAvailableActions: () => [{ type: 'mute_member' }],
      getActionSchema: () => ({
        title: '治理动作',
        actions: [{ type: 'mute_member', targetIds: ['a'], visibility: 'moderator_only' as const }],
      }),
      resolveTurnPolicy: () => ({ runChat: false, runAction: true, interleaveAction: false }),
      onMessageCommitted: async () => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] }),
    };
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }));

    await runSessionLoop({ ...params, resolveSessionEngine: async () => engine } as never);

    expect(runSessionActionExecutorMock).not.toHaveBeenCalled();
    expect(params.updateChat).not.toHaveBeenCalled();
    expect(params.onIdle).toHaveBeenCalled();
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('does not auto-run form actions when required fields have no payload', async () => {
    const engine = {
      key: 'manual-form-test',
      createInitialConfig: () => ({}),
      createInitialState: () => ({}),
      buildParticipants: () => [],
      getVisiblePanels: () => [],
      getAvailableActions: () => [{ type: 'assign_study_task' }],
      getActionSchema: () => ({
        title: '表单动作',
        actions: [{
          type: 'assign_study_task',
          fields: [{ key: 'task', label: '任务内容', type: 'textarea' as const, required: true }],
        }],
      }),
      resolveTurnPolicy: () => ({ runChat: false, runAction: true, interleaveAction: false }),
      onMessageCommitted: async () => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] }),
    };
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'study', scenarioId: 'ielts-coach', surfaceProfile: 'form' } }));

    await runSessionLoop({ ...params, resolveSessionEngine: async () => engine } as never);

    expect(runSessionActionExecutorMock).not.toHaveBeenCalled();
    expect(params.updateChat).not.toHaveBeenCalled();
    expect(params.onIdle).not.toHaveBeenCalled();
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('skips chat ticks when engine policy disallows werewolf speaking', async () => {
    const params = buildLoopParams(buildChat({ mode: 'werewolf', sessionKind: { topology: 'table', family: 'deduction', scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    await runSessionLoop(params as never);
    expect(runOneRoundMock).not.toHaveBeenCalled();
    expect(params.onIdle).toHaveBeenCalled();
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('runs speaking ticks and commits the generated message', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args) => buildCommitPipelineResult(args));
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      await hooks.onMessageComplete({ id: 'msg-1', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: '完整回复', emotion: 0 });
    });
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    params.getCurrentMessages = () => [{ id: 'm1', chatId: 'chat-1', type: 'ai', senderId: 'b', senderName: '乙', content: '上一句', emotion: 0 }] as never[];
    params.onClearStreamingState = vi.fn(() => {
      params.onLoopError();
    });
    await runSessionLoop(params as never);
    expect(runOneRoundMock).toHaveBeenCalledTimes(1);
    expect(params.onSpeakerSelected).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'a' }));
    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(1);
  });

  it('does not pause the whole room when recent members naturally close the conversation', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args) => buildCommitPipelineResult(args));
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('b', { id: 'b', name: '乙' });
      await hooks.onMessageComplete({ id: 'msg-1', chatId: 'chat-1', type: 'ai', senderId: 'b', senderName: '乙', content: '我还在，继续。', emotion: 0 });
    });
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    const pauseLoop = vi.fn(params.pauseLoop);
    params.pauseLoop = pauseLoop;
    params.onClearStreamingState = vi.fn(() => {
      params.onLoopError();
    });
    params.getCurrentMessages = () => [
      { id: 'm1', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: '那今天先这样吧。', emotion: 0, timestamp: 1, isDeleted: false },
      { id: 'm2', chatId: 'chat-1', type: 'ai', senderId: 'b', senderName: '乙', content: '晚安，我去睡了。', emotion: 0, timestamp: 2, isDeleted: false },
      { id: 'm3', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: '明早见，收工。', emotion: 0, timestamp: 3, isDeleted: false },
    ] as never[];

    await runSessionLoop(params as never);

    expect(pauseLoop).not.toHaveBeenCalled();
    expect(runOneRoundMock).toHaveBeenCalledTimes(1);
  });

  it('keeps story-reader loops running after an ordinary committed narrative round', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args) => buildCommitPipelineResult(args));
    let completedRounds = 0;
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      completedRounds += 1;
      await hooks.onMessageComplete({ id: `msg-${completedRounds}`, chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: completedRounds === 1 ? '月奴顿住脚步。' : '窗外风声更紧。', emotion: 0 });
    });
    const params = buildLoopParams(buildChat({
      mode: 'scripted_play',
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' },
      scenarioState: { phase: 'branch', choiceEpoch: 2 },
      worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never,
    }));
    const defaultPauseLoop = params.pauseLoop;
    const pauseLoop = vi.fn(() => defaultPauseLoop());
    params.pauseLoop = pauseLoop;
    params.onClearStreamingState = vi.fn(() => {
      if (completedRounds >= 2) params.onLoopError();
    });

    await runSessionLoop(params as never);

    expect(runOneRoundMock).toHaveBeenCalledTimes(2);
    expect(runSessionCommitPipelineMock).toHaveBeenCalledTimes(2);
    expect(pauseLoop).not.toHaveBeenCalled();
  });

  it('marks turn work while a speaking tick is selecting or generating', async () => {
    const started = vi.fn();
    const finished = vi.fn();
    runSessionCommitPipelineMock.mockImplementation(async (args) => buildCommitPipelineResult(args));
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      expect(started).toHaveBeenCalledTimes(1);
      expect(finished).not.toHaveBeenCalled();
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      await hooks.onMessageComplete({ id: 'msg-1', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: '完整回复', emotion: 0 });
    });
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    params.onTurnWorkStarted = started;
    params.onTurnWorkFinished = finished;
    params.onClearStreamingState = vi.fn(() => {
      params.onLoopError();
    });

    await runSessionLoop(params as never);

    expect(started).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('uses the latest chat snapshot when running a chat round', async () => {
    const staleChat = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'aligned', mood: '', focus: '旧焦点', recentEvent: '', conflictAxes: [] } as never });
    const latestChat = buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '最新用户引导', recentEvent: '', conflictAxes: [] } as never });
    const params = buildLoopParams(staleChat);
    params.getCurrentChat = () => latestChat;
    runOneRoundMock.mockImplementation(async () => {
      params.onLoopError();
    });

    await runSessionLoop(params as never);

    expect(runOneRoundMock).toHaveBeenCalledTimes(1);
    expect(runOneRoundMock.mock.calls[0]?.[0]).toBe(latestChat);
  });

  it('tracks commit lifecycle and forwards the current streaming message', async () => {
    const streamingMessage = {
      id: 'stream-1',
      chatId: 'chat-1',
      type: 'ai',
      senderId: 'a',
      senderName: '甲',
      content: '正在说',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
      isStreaming: true,
    };
    const commitStarted = vi.fn();
    const commitFinished = vi.fn();
    runSessionCommitPipelineMock.mockImplementation(async (args) => buildCommitPipelineResult(args));
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      await hooks.onMessageComplete({ id: 'msg-1', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: '完整回复', emotion: 0 });
    });
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    params.getStreamingMessage = () => streamingMessage as never;
    params.onCommitStarted = commitStarted;
    params.onCommitFinished = commitFinished;
    params.onClearStreamingState = vi.fn(() => {
      params.onLoopError();
    });

    await runSessionLoop(params as never);

    expect(commitStarted).toHaveBeenCalledTimes(1);
    expect(commitFinished).toHaveBeenCalledTimes(1);
    expect(runSessionCommitPipelineMock).toHaveBeenCalledWith(expect.objectContaining({
      streamingMessage,
    }));
  });

  it('records commit failures as visible runtime events', async () => {
    runSessionCommitPipelineMock.mockRejectedValueOnce(new Error('commit exploded'));
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      await hooks.onMessageComplete({ id: 'msg-1', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: '完整回复', emotion: 0 });
    });
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    const pause = params.pauseLoop;
    params.pauseLoop = vi.fn(pause);

    await runSessionLoop(params as never);

    expect(params.onLoopError).toHaveBeenCalledWith(expect.objectContaining({ message: 'commit exploded' }));
    expect(params.appendEventMessage).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      eventType: 'runtime_error',
      title: '提交失败',
      summary: 'commit exploded',
      visibilityScope: 'public',
    }), undefined);
    expect(params.onClearStreamingState).toHaveBeenCalledTimes(1);
    expect(params.pauseLoop).toHaveBeenCalled();
  });

  it('passes engine prompt context through to chat rounds', async () => {
    runSessionCommitPipelineMock.mockImplementation(async (args) => buildCommitPipelineResult(args));
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      await hooks.onMessageComplete({ id: 'msg-2', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲', content: '另一条回复', emotion: 0 });
    });
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    params.getCurrentMessages = () => [{ id: 'm1', chatId: 'chat-1', type: 'ai', senderId: 'b', senderName: '乙', content: '上一句', emotion: 0 }] as never[];
    params.onClearStreamingState = vi.fn(() => {
      params.onLoopError();
    });
    await runSessionLoop(params as never);
    expect(runOneRoundMock.mock.calls[0]?.[6]).toMatchObject({ buildPromptContext: expect.any(Function) });
  });

  it('applies analysis run policy so manual activation can start from an old AI turn', async () => {
    const messages: Message[] = [{
      id: 'm1',
      chatId: 'chat-1',
      type: 'ai',
      senderId: 'b',
      senderName: '乙',
      content: '普通聊天式承接，没有结构化审议产物。',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
    }];
    runSessionCommitPipelineMock.mockImplementation(async (args) => {
      const result = buildCommitPipelineResult(args);
      messages.push(result.persistedMessage);
      return result;
    });
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onSpeakerSelected('a', { id: 'a', name: '甲' });
      await hooks.onMessageComplete({
        id: 'msg-analysis-manual',
        chatId: 'chat-1',
        type: 'ai',
        senderId: 'a',
        senderName: '甲',
        content: '我先重新拉回审议问题。',
        emotion: 0,
      });
    });
    const analysisEngine = {
      key: 'analysis-test',
      createInitialConfig: () => ({}),
      createInitialState: () => ({}),
      buildParticipants: () => [],
      getVisiblePanels: () => [],
      getAvailableActions: () => [],
      getActionSchema: () => null,
      resolveTurnPolicy: () => ({ runChat: false, runAction: false, interleaveAction: false }),
      buildGenerationPromptContext: () => ({ promptPrefix: 'analysis' }),
      onMessageCommitted: async () => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] }),
    };
    const params = buildLoopParams(buildChat({
      mode: 'group_discussion',
      sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
    }));
    params.getCurrentMessages = () => messages;
    params.onClearStreamingState = vi.fn(() => {
      if (runOneRoundMock.mock.calls.length >= 2) params.pauseLoop();
    });

    await runSessionLoop({ ...params, resolveSessionEngine: async () => analysisEngine } as never);

    expect(runOneRoundMock).toHaveBeenCalledTimes(2);
    expect(params.appendEventMessage).not.toHaveBeenCalledWith('chat-1', expect.objectContaining({
      eventType: 'analysis_run_policy',
      metrics: expect.objectContaining({ reason: 'no_structural_progress' }),
    }));
    expect(params.onIdle).not.toHaveBeenCalled();
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('idles blocked speaking phases without reporting loop errors', async () => {
    const params = buildLoopParams(buildChat({ mode: 'open_chat', worldState: { phase: 'aligned', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    await runSessionLoop(params as never);
    expect(runOneRoundMock).not.toHaveBeenCalled();
    expect(params.onIdle).toHaveBeenCalled();
    expect(params.onLoopError).not.toHaveBeenCalled();
  });

  it('stops retrying after an engine error is paused by the UI layer', async () => {
    const params = buildLoopParams(buildChat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' }, worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] } as never }));
    params.onEngineError = vi.fn(() => {
      params.pauseLoop();
    });
    runOneRoundMock.mockImplementation(async (_chat, _characters, _messages, _api, hooks) => {
      hooks.onError(new Error('Maximum call stack size exceeded'));
    });

    await runSessionLoop(params as never);

    expect(runOneRoundMock).toHaveBeenCalledTimes(1);
    expect(params.onEngineError).toHaveBeenCalledTimes(1);
    expect(params.onLoopError).not.toHaveBeenCalled();
  });
});

export {};
