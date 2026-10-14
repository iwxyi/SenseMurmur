import { describe, expect, it, vi } from 'vitest';
import type { AppCommandContext, AppCommandRoute } from './commandTypes';
import { executeAppCommandRoute, findReusableGroupChat } from './executeCommand';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useChatStore } from '../../stores/useChatStore';
import { useMessageStore } from '../../stores/useMessageStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { api } from '../../services/api';
import type { GroupChat } from '../../types/chat';
import { DEFAULT_CONVERSATION_DIRECTOR_CONTROLS, DEFAULT_CONVERSATION_DRAMA_RULES, DEFAULT_CONVERSATION_GOVERNANCE, DEFAULT_CONVERSATION_WORLD_STATE, DEFAULT_OPEN_CHAT_MODE_CONFIG, DEFAULT_OPEN_CHAT_MODE_STATE, createDefaultSessionKind } from '../../types/chat';
import type { AICharacter } from '../../types/character';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CHARACTER_INTERVENTION, DEFAULT_CHARACTER_MEMORY, DEFAULT_PERSONALITY } from '../../types/character';
import type { Message } from '../../types/message';
import { DEFAULT_CHAT_DRAFT_DEFAULTS } from '../../types/settings';

const { generateResponseMock } = vi.hoisted(() => ({
  generateResponseMock: vi.fn(),
}));

vi.mock('../../services/aiClient', () => ({
  generateResponse: (...args: unknown[]) => generateResponseMock(...args),
}));

function context(input = '小明'): AppCommandContext {
  return {
    source: 'home',
    input,
    navigate: vi.fn(),
    apiConfig: { provider: 'openai', apiKey: '', baseUrl: '', model: 'test-model' },
    aiProfiles: [],
  };
}

function character(id: string, name: string): AICharacter {
  return {
    id,
    name,
    avatar: '🤖',
    personality: DEFAULT_PERSONALITY,
    behavior: DEFAULT_CHARACTER_BEHAVIOR,
    expertise: [],
    speakingStyle: '自然表达。',
    background: `${name} 的背景。`,
    group: null,
    relationships: [],
    memory: DEFAULT_CHARACTER_MEMORY,
    intervention: DEFAULT_CHARACTER_INTERVENTION,
    isPreset: false,
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
  };
}

function chat(id: string, name: string, type: GroupChat['type'] = 'group'): GroupChat {
  const sessionKind = createDefaultSessionKind(type, 'open_chat');
  return {
    id,
    type,
    mode: 'open_chat',
    sessionKind,
    modeConfig: DEFAULT_OPEN_CHAT_MODE_CONFIG,
    modeState: DEFAULT_OPEN_CHAT_MODE_STATE,
    name,
    topic: `${name} 的主题`,
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: type === 'assistant' ? [] : ['user'],
    speed: 1,
    isActive: false,
    allowIntervention: true,
    showRoleActions: type !== 'assistant',
    topicSeed: '',
    governance: DEFAULT_CONVERSATION_GOVERNANCE,
    dramaRules: DEFAULT_CONVERSATION_DRAMA_RULES,
    worldState: DEFAULT_CONVERSATION_WORLD_STATE,
    directorControls: DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
    createdAt: 1000,
    updatedAt: 1000,
    lastMessageAt: 1000,
    deletedAt: null,
  };
}

function message(id: string, chatId: string, content: string): Message {
  return {
    id,
    chatId,
    type: 'ai',
    senderId: 'assistant',
    senderName: '助手',
    content,
    emotion: 0,
    timestamp: 1000,
    isDeleted: false,
  };
}

describe('executeAppCommandRoute', () => {
  it('never auto-executes choices when planner forgets requiresConfirmation', async () => {
    const route: AppCommandRoute = {
      mode: 'local_action',
      action: 'update_theme',
      riskLevel: 'low',
      requiresConfirmation: false,
      plan: { action: 'update_theme', theme: 'dark', title: '切换主题' },
      choices: [
        {
          id: 'light',
          label: '浅色',
          kind: 'execute',
          plan: { action: 'update_theme', plan: { action: 'update_theme', theme: 'light' } },
        },
        {
          id: 'dark',
          label: '深色',
          kind: 'execute',
          plan: { action: 'update_theme', plan: { action: 'update_theme', theme: 'dark' } },
        },
      ],
    };

    const result = await executeAppCommandRoute(route, context());

    expect(result.status).toBe('needs_confirmation');
    expect(result.choices?.map((choice) => choice.id)).toEqual(['light', 'dark']);
  });

  it('passes speaker filters through chat search execution', async () => {
    const searchChatRecordsMock = vi.spyOn(api, 'searchChatRecords').mockResolvedValueOnce({
      query: '统一',
      source: 'cloud',
      totalCount: 1,
      returnedCount: 1,
      hasMore: false,
      limit: 20,
      offset: 0,
      sortBy: 'relevance',
      matches: [{
        chatId: 'chat-1',
        chatName: '历史讨论',
        chatType: 'group',
        messageId: 'msg-1',
        timestamp: 100,
        senderName: '嬴政',
        snippet: '统一六国。',
        matchedKeywords: ['统一'],
        score: 99,
      }],
    });

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'search_chats',
        riskLevel: 'low',
        requiresConfirmation: false,
        plan: {
          action: 'search_chats',
          chatQuery: '统一',
          chatSearchSpeakerQuery: '秦始皇',
          chatSearchScope: 'cloud',
        },
      }, context());

      expect(searchChatRecordsMock).toHaveBeenCalledWith('统一', expect.objectContaining({
        speakerQuery: '秦始皇',
      }));
      expect(result.status).toBe('needs_confirmation');
    } finally {
      searchChatRecordsMock.mockRestore();
    }
  });

  it('reuses an existing group chat with the same title topic members and scenario', () => {
    const existing = {
      id: 'chat-1',
      type: 'group' as const,
      deletedAt: undefined,
      name: '曹操与童年曹操',
      topic: '曹操和童年曹操的对话',
      sessionKind: { scenarioId: 'open-chat' },
      memberIds: ['character-child-cao', 'user', 'character-cao'],
    };

    expect(findReusableGroupChat({
      chats: [existing],
      title: '曹操与童年曹操',
      topic: '曹操和童年曹操的对话',
      scenarioId: 'open-chat',
      memberIds: ['user', 'character-cao', 'character-child-cao'],
    })?.id).toBe('chat-1');

    expect(findReusableGroupChat({
      chats: [{ ...existing, deletedAt: Date.now() }],
      title: '曹操与童年曹操',
      topic: '曹操和童年曹操的对话',
      scenarioId: 'open-chat',
      memberIds: ['user', 'character-cao', 'character-child-cao'],
    })).toBeNull();
  });

  it('uses chat draft defaults for app command group creation unless the plan overrides them', async () => {
    const originalAddChat = useChatStore.getState().addChat;
    const originalChatDraftDefaults = useSettingsStore.getState().chatDraftDefaults;
    const addChat = vi.fn(async (draft: Parameters<typeof originalAddChat>[0]) => {
      const created = { ...draft, id: 'chat-created' } as GroupChat;
      useChatStore.setState({ chats: [created] });
      return created;
    });

    useCharacterStore.setState({ characters: [character('char-qin', '秦始皇')] });
    useChatStore.setState({ chats: [], addChat });
    useSettingsStore.setState({
      chatDraftDefaults: {
        ...DEFAULT_CHAT_DRAFT_DEFAULTS,
        includeUserAsMember: false,
        showRoleActions: false,
      },
    });

    try {
      const defaultResult = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'create_group_chat',
        riskLevel: 'medium',
        requiresConfirmation: false,
        plan: {
          action: 'create_group_chat',
          groupName: '帝王群聊',
          groupTopic: '讨论天下',
          characters: [{ name: '秦始皇' }],
        },
      }, context());

      expect(defaultResult.status).toBe('success');
      expect(addChat).toHaveBeenCalledTimes(1);
      expect(addChat.mock.calls[0]?.[0].memberIds).toEqual(['char-qin']);
      expect(addChat.mock.calls[0]?.[0].showRoleActions).toBe(false);

      useChatStore.setState({ chats: [] });
      const overrideResult = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'create_group_chat',
        riskLevel: 'medium',
        requiresConfirmation: false,
        plan: {
          action: 'create_group_chat',
          groupName: '帝王群聊二',
          groupTopic: '继续讨论天下',
          characters: [{ name: '秦始皇' }],
          includeUserAsMember: true,
          showRoleActions: true,
        },
      }, context());

      expect(overrideResult.status).toBe('success');
      expect(addChat).toHaveBeenCalledTimes(2);
      expect(addChat.mock.calls[1]?.[0].memberIds).toEqual(['char-qin', 'user']);
      expect(addChat.mock.calls[1]?.[0].showRoleActions).toBe(true);
    } finally {
      useCharacterStore.setState({ characters: [] });
      useChatStore.setState({ chats: [], addChat: originalAddChat });
      useSettingsStore.setState({ chatDraftDefaults: originalChatDraftDefaults });
    }
  });

  it('passes opening messages through navigation state when creating a direct chat', async () => {
    const navigate = vi.fn();
    const originalAddChat = useChatStore.getState().addChat;
    useCharacterStore.setState({ characters: [character('char-qin', '秦始皇')] });
    useChatStore.setState({
      chats: [],
      addChat: vi.fn(async (draft) => {
        const created = { ...draft, id: 'chat-qin' } as GroupChat;
        useChatStore.setState({ chats: [created] });
        return created;
      }),
    });

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'create_direct_chat',
        riskLevel: 'medium',
        requiresConfirmation: false,
        plan: {
          action: 'create_direct_chat',
          characterName: '秦始皇',
          openingMessage: '统一六国之后，你最怕哪件事失控？',
        },
      }, { ...context(), navigate });

      expect(result.status).toBe('success');
      expect(navigate).toHaveBeenCalledWith('/chats/chat-qin?fromTab=1', {
        state: { homeCommandInitialMessage: '统一六国之后，你最怕哪件事失控？' },
      });
    } finally {
      useCharacterStore.setState({ characters: [] });
      useChatStore.setState({ chats: [], addChat: originalAddChat });
    }
  });

  it('finds role collections from natural-language Chinese queries without selecting related non-role characters', async () => {
    const qin = {
      ...character('char-qin', '秦始皇'),
      group: '帝王',
      expertise: ['统一六国', '法家治国'],
      background: '嬴政，中国第一位皇帝。',
    };
    const han = {
      ...character('char-han', '汉武帝'),
      group: '帝王',
      expertise: ['汉武盛世', '开疆拓土'],
      background: '刘彻，西汉皇帝。',
    };
    const scholar = {
      ...character('char-scholar', '史官小周'),
      group: '学者',
      expertise: ['帝王史研究'],
      background: '研究中国古代皇帝制度的历史学者，不是皇帝。',
    };
    useCharacterStore.setState({ characters: [qin, han, scholar] });
    generateResponseMock.mockResolvedValueOnce(JSON.stringify({
      matchingIds: ['char-qin', 'char-han'],
    }));

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'read_character_info',
        riskLevel: 'low',
        requiresConfirmation: false,
        plan: {
          action: 'read_character_info',
          characterQuery: '皇帝',
          characterQueryMode: 'collection',
        },
      }, {
        ...context(),
        input: '哪些是皇帝的角色',
      });

      expect(result.status).toBe('success');
      expect(result.markdown).toContain('秦始皇');
      expect(result.markdown).toContain('汉武帝');
      expect(result.markdown).not.toContain('史官小周');
      expect(generateResponseMock).toHaveBeenCalledTimes(1);
      expect(String((generateResponseMock.mock.calls[0]?.[2] as Array<{ content: string }>)[0]?.content || '')).toContain('研究中国古代皇帝制度的历史学者');
    } finally {
      useCharacterStore.setState({ characters: [] });
      generateResponseMock.mockReset();
    }
  });

  it('searches chats without opening one when planner routes to search_chats', async () => {
    useChatStore.setState({
      chats: [
        chat('chat-worldcup', '最新世界杯动态查询', 'assistant'),
        chat('chat-qin', '秦始皇讨论', 'group'),
      ],
    });
    useMessageStore.setState({
      messages: [],
      messageWindowsByChatId: {
        'chat-worldcup': {
          messages: [message('msg-1', 'chat-worldcup', '当前未开启搜索能力，无法联网查询最新的世界杯消息。')],
          lastSyncedAt: 1000,
          updatedAt: 1000,
        },
        'chat-qin': {
          messages: [message('msg-2', 'chat-qin', '我们聊过秦始皇的统一六国。')],
          lastSyncedAt: 1000,
          updatedAt: 1000,
        },
      },
    });

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'search_chats',
        riskLevel: 'low',
        requiresConfirmation: false,
        plan: {
          action: 'search_chats',
          chatQuery: '秦始皇',
          chatTypePreference: 'any',
        },
      }, context('搜索聊天记录里的秦始皇'));

      expect(result.status).toBe('needs_confirmation');
      expect(result.candidates?.map((candidate) => candidate.label)).toEqual(['秦始皇讨论']);
      expect(result.choices?.[0]?.url).toContain('ssmm://chat/chat-qin');
      expect(result.navigateTo).toBeUndefined();
    } finally {
      useChatStore.setState({ chats: [] });
      useMessageStore.setState({ messages: [], messageWindowsByChatId: {} });
    }
  });

  it('stops workflow execution when an early step returns a recoverable info result', async () => {
    useChatStore.setState({ chats: [] });
    try {
      const result = await executeAppCommandRoute({
        mode: 'workflow',
        riskLevel: 'low',
        requiresConfirmation: false,
        steps: [
          {
            action: 'open_existing_chat',
            riskLevel: 'low',
            requiresConfirmation: false,
            plan: {
              action: 'open_existing_chat',
            },
          },
          {
            action: 'create_assistant_chat',
            riskLevel: 'low',
            requiresConfirmation: false,
            plan: {
              action: 'create_assistant_chat',
              chatName: '不应被创建',
            },
          },
        ],
      }, context('打开聊天然后新建助手'));

      expect(result.status).toBe('info');
      expect(result.reasonType).toBe('missing_chat_query');
      expect(result.observation?.workflowStepIndex).toBe(0);
      expect(useChatStore.getState().chats).toHaveLength(0);
    } finally {
      useChatStore.setState({ chats: [] });
    }
  });

  it('merges active messages with cached windows so recently updated content remains searchable', async () => {
    useChatStore.setState({
      chats: [chat('chat-worldcup', '最新世界杯动态查询', 'assistant')],
    });
    useMessageStore.setState({
      messages: [message('msg-worldcup', 'chat-worldcup', '已搜索到巴西队的最新世界杯消息。')],
      messageWindowsByChatId: {
        'chat-worldcup': {
          messages: [message('msg-worldcup', 'chat-worldcup', '当前未开启搜索能力。')],
          lastSyncedAt: 1000,
          updatedAt: 1000,
        },
      },
    });

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'search_chats',
        riskLevel: 'low',
        requiresConfirmation: false,
        plan: {
          action: 'search_chats',
          chatQuery: '巴西队',
          chatTypePreference: 'any',
        },
      }, context());

      expect(result.status).toBe('needs_confirmation');
      expect(result.candidates?.map((candidate) => candidate.id)).toEqual(['chat-worldcup:msg-worldcup']);
    } finally {
      useChatStore.setState({ chats: [] });
      useMessageStore.setState({ messages: [], messageWindowsByChatId: {} });
    }
  });

  it('deletes explicitly named characters through the character store', async () => {
    const originalDeleteCharacters = useCharacterStore.getState().deleteCharacters;
    const deleteCharacters = vi.fn(async (ids: string[]) => {
      useCharacterStore.setState((state) => ({
        characters: state.characters.map((item) => (
          ids.includes(item.id) ? { ...item, deletedAt: 2000, updatedAt: 2000 } : item
        )),
      }));
    });
    useCharacterStore.setState({
      characters: [
        character('char-chen', '掌柜老陈'),
        character('char-tea', 'AI茶博士'),
        character('char-tie', '机械跑堂小铁'),
      ],
      deleteCharacters,
    });

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'delete_characters',
        riskLevel: 'medium',
        requiresConfirmation: false,
        plan: {
          action: 'delete_characters',
          characters: [{ name: '掌柜老陈' }, { name: 'AI茶博士' }, { name: '机械跑堂小铁' }],
        },
      }, context());

      expect(result.status).toBe('success');
      expect(deleteCharacters).toHaveBeenCalledWith(['char-chen', 'char-tea', 'char-tie']);
      expect(result.markdown).toContain('已删除角色：掌柜老陈、AI茶博士、机械跑堂小铁');
    } finally {
      useCharacterStore.setState({ characters: [], deleteCharacters: originalDeleteCharacters });
    }
  });

  it('renames a resolved chat through the chat store', async () => {
    const originalUpdateChat = useChatStore.getState().updateChat;
    const updateChat = vi.fn(async (id: string, updates: Partial<GroupChat>) => {
      useChatStore.setState((state) => ({
        chats: state.chats.map((item) => item.id === id ? { ...item, ...updates } : item),
      }));
    });
    useChatStore.setState({
      chats: [chat('chat-worldcup', '最新世界杯动态查询', 'assistant')],
      updateChat,
    });

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'rename_chat',
        riskLevel: 'medium',
        requiresConfirmation: false,
        plan: { action: 'rename_chat', chatId: 'chat-worldcup', newName: '世界杯消息' },
      }, context());

      expect(result.status).toBe('success');
      expect(updateChat).toHaveBeenCalledWith('chat-worldcup', { name: '世界杯消息' });
    } finally {
      useChatStore.setState({ chats: [], updateChat: originalUpdateChat });
    }
  });

  it('updates a resolved chat topic through the chat store', async () => {
    const originalUpdateChat = useChatStore.getState().updateChat;
    const updateChat = vi.fn(async (id: string, updates: Partial<GroupChat>) => {
      useChatStore.setState((state) => ({
        chats: state.chats.map((item) => item.id === id ? { ...item, ...updates } : item),
      }));
    });
    useChatStore.setState({
      chats: [chat('chat-tea', '赛博茶馆', 'group')],
      updateChat,
    });

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'update_chat_topic',
        riskLevel: 'medium',
        requiresConfirmation: false,
        plan: { action: 'update_chat_topic', chatId: 'chat-tea', newTopic: '雨夜叛逃与旧盟约' },
      }, context());

      expect(result.status).toBe('success');
      expect(updateChat).toHaveBeenCalledWith('chat-tea', { topic: '雨夜叛逃与旧盟约' });
    } finally {
      useChatStore.setState({ chats: [], updateChat: originalUpdateChat });
    }
  });

  it('returns executable chat choices for ambiguous destructive chat actions', async () => {
    const originalDeleteChat = useChatStore.getState().deleteChat;
    const deleteChat = vi.fn(async () => undefined);
    useChatStore.setState({
      chats: [chat('chat-a', '赛博茶馆'), chat('chat-b', '赛博茶馆故事会')],
      deleteChat,
    });

    try {
      const result = await executeAppCommandRoute({
        mode: 'local_action',
        action: 'delete_chats',
        riskLevel: 'medium',
        requiresConfirmation: false,
        plan: { action: 'delete_chats', chatQuery: '赛博茶馆', chatTypePreference: 'group' },
      }, context());

      expect(result.status).toBe('needs_confirmation');
      expect(deleteChat).not.toHaveBeenCalled();
      expect(result.choices?.[0]).toMatchObject({
        kind: 'execute',
        plan: {
          action: 'delete_chats',
          plan: {
            action: 'delete_chats',
            chatId: 'chat-a',
          },
        },
      });
      expect(result.choices?.[0].url).toBeUndefined();
    } finally {
      useChatStore.setState({ chats: [], deleteChat: originalDeleteChat });
    }
  });
});
