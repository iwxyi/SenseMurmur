import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConversation, type DriverMessageCommitTransition } from '../types/chat';
import { DEFAULT_API_CONFIG } from '../types/settings';
import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';
import { runChatCommitPipeline } from './chatCommitPipeline';

const persistStreamingMessageMock = vi.fn();
const finalizeChatCommitRuntimeMock = vi.fn();
const applyChatCommitRuntimeMock = vi.fn();
const createRuntimeMemoryTimerMock = vi.fn();
const processRichMessageMediaMock = vi.fn();
const isLocalOnlyMediaModeMock = vi.fn();

vi.mock('./chatCommitMessage', () => ({
  persistStreamingMessage: (...args: unknown[]) => persistStreamingMessageMock(...args),
}));

vi.mock('./chatCommitRuntime', () => ({
  finalizeChatCommitRuntime: (...args: unknown[]) => finalizeChatCommitRuntimeMock(...args),
}));

vi.mock('./chatCommitApply', () => ({
  applyChatCommitRuntime: (...args: unknown[]) => applyChatCommitRuntimeMock(...args),
}));

vi.mock('./runtimeMemoryTimer', () => ({
  createRuntimeMemoryTimer: (...args: unknown[]) => createRuntimeMemoryTimerMock(...args),
}));

vi.mock('./richMessageMedia', () => ({
  processRichMessageMedia: (...args: unknown[]) => processRichMessageMediaMock(...args),
  isLocalOnlyMediaMode: () => isLocalOnlyMediaModeMock(),
}));

function buildChat() {
  return normalizeConversation({
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    name: '群聊',
    topic: '测试',
    style: 'free',
    memberIds: ['char-1'],
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free', currentSpeakerId: null, currentTopicFocus: '', lastRelationshipEventAt: null },
    runtimeEvolutionIntensity: 'balanced',
    speed: 1,
    isActive: false,
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

function buildStreamingMessage(): Message {
  return {
    id: 'local-stream-1',
    clientKey: 'local-stream-1',
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'char-1',
    senderName: '甲',
    content: '逐字显示完整内容',
    emotion: 0,
    timestamp: 123,
    isDeleted: false,
    isStreaming: true,
  };
}

describe('runChatCommitPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRuntimeMemoryTimerMock.mockReturnValue({
      mark: vi.fn(),
      finish: vi.fn(),
    });
    const transition: DriverMessageCommitTransition = {
      chatPatch: {},
      characterPatches: [],
      runtimeEvents: [],
    };
    finalizeChatCommitRuntimeMock.mockResolvedValue(transition);
    applyChatCommitRuntimeMock.mockResolvedValue(undefined);
    processRichMessageMediaMock.mockResolvedValue(undefined);
    isLocalOnlyMediaModeMock.mockReturnValue(true);
  });

  it('immediately reuses the streaming bubble when committing the final generated message', async () => {
    const chat = buildChat();
    const streamingMessage = buildStreamingMessage();
    const upsertMessage = vi.fn();
    const persistedMessage: Message = {
      ...streamingMessage,
      content: '逐字显示完整内容，最终提交也必须留在同一条气泡。',
      isStreaming: false,
    };
    persistStreamingMessageMock.mockResolvedValue(persistedMessage);

    await runChatCommitPipeline({
      api: DEFAULT_API_CONFIG,
      chatId: chat.id,
      chat,
      characters: [{ id: 'char-1', name: '甲' } as AICharacter],
      message: {
        chatId: chat.id,
        type: 'ai',
        senderId: 'char-1',
        senderName: '甲',
        content: persistedMessage.content,
        emotion: 0,
      },
      streamingMessage,
      currentMessages: [streamingMessage],
      onCommit: vi.fn(),
      upsertMessage,
      updateCharacter: vi.fn(),
      updateChat: vi.fn(),
      appendEventMessage: vi.fn(),
      recordSpeak: vi.fn(),
    });

    expect(persistStreamingMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      existingLocalMessage: streamingMessage,
      deferLocalUpsert: false,
      upsertMessage,
    }));
  });

  it.each(['image', 'sticker'] as const)('waits for a server message id before processing queued %s in cloud mode', async (kind) => {
    isLocalOnlyMediaModeMock.mockReturnValue(false);
    const chat = buildChat();
    const upsertMessage = vi.fn();
    let onPersisted: ((message: Message) => void) | undefined;
    const localMessage: Message = {
      id: 'local-stream-1',
      clientKey: 'local-stream-1',
      chatId: chat.id,
      type: 'ai',
      senderId: 'char-1',
      senderName: '甲',
      content: '我把图发你看。',
      emotion: 0,
      timestamp: 123,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'image-1',
          kind,
          status: 'queued',
          promptText: 'A chat image',
          altText: '一张图',
          createdAt: 123,
          updatedAt: 123,
        }],
      },
    };
    persistStreamingMessageMock.mockImplementation(async (params) => {
      onPersisted = params.onPersisted;
      return localMessage;
    });

    await runChatCommitPipeline({
      api: DEFAULT_API_CONFIG,
      chatId: chat.id,
      chat,
      characters: [{ id: 'char-1', name: '甲', modelProfileIds: {} } as AICharacter],
      message: {
        chatId: chat.id,
        type: 'ai',
        senderId: 'char-1',
        senderName: '甲',
        content: localMessage.content,
        emotion: 0,
        metadata: localMessage.metadata,
      },
      streamingMessage: null,
      currentMessages: [],
      aiProfiles: kind === 'sticker' ? [] : [{
        id: 'image-default',
        name: '默认图片',
        type: 'image',
        provider: 'openai',
        apiKey: 'key',
        baseUrl: 'https://example.test',
        model: 'image-model',
        isDefault: true,
      }],
      onCommit: vi.fn(),
      upsertMessage,
      updateCharacter: vi.fn(),
      updateChat: vi.fn(),
      appendEventMessage: vi.fn(),
      recordSpeak: vi.fn(),
    });

    expect(processRichMessageMediaMock).not.toHaveBeenCalled();
    expect(upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: localMessage.id,
      metadata: expect.objectContaining({
        generation: expect.objectContaining({ status: 'queued' }),
      }),
    }));

    const serverMessage = { ...localMessage, serverId: 'server-message-1' };
    onPersisted?.(serverMessage);

    expect(processRichMessageMediaMock).toHaveBeenCalledWith(expect.objectContaining({
      message: serverMessage,
      characters: expect.arrayContaining([expect.objectContaining({ id: 'char-1' })]),
      aiProfiles: kind === 'sticker' ? [] : expect.arrayContaining([expect.objectContaining({ id: 'image-default' })]),
      upsertMessage,
    }));
  });
});
