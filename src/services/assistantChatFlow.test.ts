import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantAgentPatchSet } from '../types/assistantArtifact';
import type { Message } from '../types/message';
import type { GroupChat } from '../types/chat';
import { useChatStore } from '../stores/useChatStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { buildAssistantChatDraft } from './chatDraftBuilder';
import { generateResponse } from './aiClient';
import { api } from './api';
import { buildBranchStateWithHead, forkBranchState } from './messageBranching';
import { buildAgentArtifactReplyContent, markAssistantMediaAttachmentsFailed, maybeGenerateAssistantChatTitle, runAssistantChatReplyFlow } from './assistantChatFlow';

const agentOrchestratorMock = vi.hoisted(() => ({
  planAssistantAgentChange: vi.fn(),
  writeAssistantAgentPatchSet: vi.fn(),
}));
const networkTransferMock = vi.hoisted(() => ({
  executeNetworkTransferTask: vi.fn(),
}));

vi.mock('./aiClient', () => ({
  generateResponse: vi.fn(),
}));

vi.mock('./assistantAgentOrchestrator', () => agentOrchestratorMock);
vi.mock('./networkTransferService', () => networkTransferMock);
vi.mock('./sessionNetworkResourceStore', () => ({
  listSessionNetworkResourceRegistry: vi.fn(async () => []),
  getSessionNetworkResourceContexts: vi.fn(async () => []),
}));

vi.mock('../stores/useAssistantArtifactStore', () => ({
  ensureAssistantArtifactStoreHydrated: vi.fn(async () => undefined),
  useAssistantArtifactStore: {
    getState: () => ({
      getArtifactsForChat: vi.fn(() => []),
      commitPatchSet: vi.fn(() => []),
    }),
  },
}));

vi.mock('../stores/useLocalWorkspaceStore', () => ({
  useLocalWorkspaceStore: {
    getState: () => ({
      directories: [],
      getDefaultDirectory: vi.fn(() => null),
      getSelectedFilePaths: vi.fn(() => []),
      listDefaultDirectoryFiles: vi.fn(async () => []),
      readDefaultDirectoryTextFiles: vi.fn(async () => []),
    }),
  },
}));

const generateResponseMock = vi.mocked(generateResponse);

function assistantChat(id = 'assistant-chat-1'): GroupChat {
  return {
    ...buildAssistantChatDraft(),
    id,
    createdAt: 1000,
    updatedAt: 1000,
    lastMessageAt: 1000,
  };
}

beforeEach(() => {
  generateResponseMock.mockReset();
  agentOrchestratorMock.planAssistantAgentChange.mockReset();
  agentOrchestratorMock.writeAssistantAgentPatchSet.mockReset();
  networkTransferMock.executeNetworkTransferTask.mockReset();
  useChatStore.setState({ chats: [] });
});

describe('assistantChatFlow failed regeneration', () => {
  it.each(['unavailable', 'partial', 'cancelled', 'empty'])('removes the transient reply without switching away from the new branch when generation fails (%s)', async (failure) => {
    const chat = assistantChat();
    chat.modeState.assistantCapabilities = { ...chat.modeState.assistantCapabilities, agent: false, artifacts: false };
    const original: Message = { id: 'original', chatId: chat.id, type: 'ai', senderId: 'actor', senderName: '角色',
      content: '原来的回答', emotion: 0, timestamp: 1001, isDeleted: false };
    const newBranchState = buildBranchStateWithHead(
      forkBranchState({ enabled: true }, original.id, 'main-before-regenerate-1000'), null, 'main',
    );
    chat.messageBranchState = newBranchState;
    useChatStore.setState({ chats: [chat] });
    const visible = new Map<string, Message>([[original.id, original]]);
    const upsertMessage = vi.fn((message: Message) => {
      if (message.isDeleted) visible.delete(message.id);
      else visible.set(message.id, message);
    });
    const updateChat = vi.fn(async () => undefined);
    const controller = new AbortController();
    generateResponseMock.mockImplementation(async (_api, _prompt, _messages, onStream) => {
      if (failure === 'empty') return '   ';
      if (failure === 'partial') onStream?.('尚未完成');
      if (failure === 'cancelled') {
        controller.abort();
        return '已被取消的迟到回复';
      }
      throw new Error('AI 服务不可用');
    });
    await expect(runAssistantChatReplyFlow({
      api: { provider: 'openai', apiKey: 'test', model: 'test', baseUrl: '' }, aiProfiles: [], chat, chatId: chat.id,
      currentMessages: [], upsertMessage, updateChat, revisionOfNodeId: original.id, signal: controller.signal,
    })).rejects.toThrow();
    expect(Array.from(visible.values())).toEqual([original]);
    expect(updateChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().chats[0].messageBranchState).toEqual(newBranchState);
    expect(upsertMessage.mock.calls.at(-1)?.[0]).toMatchObject({ isStreaming: true, isDeleted: true });
  });

});

describe('assistant reply display', () => {
  it('reveals a network chunk gradually and persists the same branch node', async () => {
    const wasEnabled = useSettingsStore.getState().enableStreamingDisplayAnimation;
    useSettingsStore.setState({ enableStreamingDisplayAnimation: true });
    try {
      const chat = assistantChat();
      chat.name = '逐字测试';
      chat.modeState.assistantCapabilities = { ...chat.modeState.assistantCapabilities, agent: false, artifacts: false };
      const content = '这是一条逐字显示的助手回复';
      const frames: Message[] = [];
      generateResponseMock.mockImplementation(async (_api, _prompt, _messages, onStream) => {
        onStream?.(content);
        await new Promise((resolve) => setTimeout(resolve, 65));
        expect(frames.at(-1)?.content.length).toBeGreaterThan(0);
        expect(frames.at(-1)?.content.length).toBeLessThan(content.length);
        return content;
      });
      const result = await runAssistantChatReplyFlow({
        api: { provider: 'openai', apiKey: 'test', model: 'test', baseUrl: '' }, aiProfiles: [], chat, chatId: chat.id,
        currentMessages: [], upsertMessage: (message) => frames.push(message), updateChat: vi.fn(async () => undefined),
      });
      expect(result?.content).toBe(content);
      expect(String(generateResponseMock.mock.calls[0]?.[1])).toContain('## Chat preferences');
      expect(frames.at(-1)?.isStreaming).toBe(false);
      expect(new Set(frames.map((frame) => frame.id)).size).toBe(1);
      expect(new Set(frames.map((frame) => frame.metadata?.branching?.nodeId)).size).toBe(1);
    } finally {
      useSettingsStore.setState({ enableStreamingDisplayAnimation: wasEnabled });
    }
  });
});

describe('assistantChatFlow network download discovery', () => {
  it('continues a search into a verified direct download instead of claiming it lacks download access', async () => {
    const chat = assistantChat();
    chat.modeState.agentCapabilities = {
      enabled: true,
      chatArtifactRead: true,
      chatArtifactWrite: true,
      fileUpload: true,
      fileDownload: true,
      workspaceRead: true,
      workspaceWrite: false,
      officeTransform: false,
      commandExecution: false,
      systemActions: false,
      webSearch: true,
      updatedAt: 1000,
    };
    const userMessage: Message = {
      id: 'message-user-download', chatId: chat.id, type: 'user', senderId: 'user', senderName: '我',
      content: '帮我下载测试手册到下载文件夹', emotion: 0, timestamp: 1001, isDeleted: false,
    };
    agentOrchestratorMock.planAssistantAgentChange.mockResolvedValue({
      intent: 'search', searchQuery: '测试手册 PDF 官方下载', scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'export', instruction: userMessage.content }], requiresConfirmation: false, confidence: 1,
    });
    const searchWebMock = vi.spyOn(api, 'searchWeb').mockResolvedValue({
      query: '测试手册 PDF 官方下载', providerCode: 'test', pointCost: 1,
      results: [{ title: '测试手册 PDF', url: 'https://example.com/manual.pdf', snippet: '官方下载文件' }],
    });
    generateResponseMock.mockResolvedValue(JSON.stringify({ url: 'https://example.com/manual.pdf', fileName: 'manual.pdf' }));
    networkTransferMock.executeNetworkTransferTask.mockResolvedValue([{
      directoryId: 'network-task', path: 'https://example.com/manual.pdf', name: 'manual.pdf', mimeType: 'text/plain',
      sizeBytes: 1024, content: '网络传输任务完成。\n保存目标：设备', truncated: false, originalLength: 22,
    }]);
    const upsertMessage = vi.fn();

    await runAssistantChatReplyFlow({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      aiProfiles: [], chat, chatId: chat.id, currentMessages: [userMessage], upsertMessage,
      updateChat: vi.fn(async () => undefined),
    });

    expect(networkTransferMock.executeNetworkTransferTask).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      url: 'https://example.com/manual.pdf', action: 'export', destination: 'device',
    }));
    expect(upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ai', content: expect.stringContaining('保存目标：设备'),
    }));
    searchWebMock.mockRestore();
  });
});

describe('assistantChatFlow media artifacts', () => {
  it('passes the latest uploaded image to a vision-capable GPT text model', async () => {
    const chat = assistantChat();
    const userMessage: Message = {
      id: 'message-user-image',
      chatId: chat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: '请解释这张图片',
      emotion: 0,
      timestamp: 1001,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'uploaded-image',
          kind: 'image',
          status: 'ready',
          altText: '用户上传的图片',
          mimeType: 'image/png',
          url: 'data:image/png;base64,AAA',
          createdAt: 1001,
          updatedAt: 1001,
        }],
      },
    };
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '这是一张图片。',
      imageSummaries: [{ attachmentId: 'uploaded-image', summary: '用户上传的图片。' }],
    }));

    await runAssistantChatReplyFlow({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      aiProfiles: [{
        id: 'gpt-text',
        name: 'GPT',
        type: 'text',
        provider: 'openai',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
        isDefault: true,
      }],
      chat,
      chatId: chat.id,
      currentMessages: [userMessage],
      upsertMessage: vi.fn(),
      updateChat: vi.fn(async () => undefined),
    });

    const projected = generateResponseMock.mock.calls[0]?.[2] as Array<{
      content: string;
      attachments?: Array<{ url: string; mimeType?: string }>;
    }>;
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      content: expect.stringContaining('请解释这张图片'),
      attachments: [{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }],
    });
    expect(generateResponseMock.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('stores a lightweight semantic summary on uploaded images after a vision reply', async () => {
    const chat = assistantChat();
    const userMessage: Message = {
      id: 'message-user-fish',
      chatId: chat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: '这几张图里哪张是鲫鱼？',
      emotion: 0,
      timestamp: 1001,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'fish-image',
          kind: 'image',
          status: 'ready',
          altText: '用户上传的图片',
          mimeType: 'image/png',
          url: 'data:image/png;base64,FISH',
          createdAt: 1001,
          updatedAt: 1001,
        }],
      },
    };
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '第一张图里钓到的是鲫鱼，体型偏小，银灰色鱼身。',
      imageSummaries: [{
        attachmentId: 'fish-image',
        summary: '钓到的鲫鱼，体型偏小，银灰色鱼身，可按“鲫鱼图”引用。',
      }],
    }));
    const upsertMessage = vi.fn();

    await runAssistantChatReplyFlow({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      aiProfiles: [{
        id: 'gpt-text',
        name: 'GPT',
        type: 'text',
        provider: 'openai',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
        isDefault: true,
      }],
      chat,
      chatId: chat.id,
      currentMessages: [userMessage],
      upsertMessage,
      updateChat: vi.fn(async () => undefined),
    });

    const summarizedUserMessage = upsertMessage.mock.calls
      .map((call) => call[0] as Message)
      .find((message) => message.id === userMessage.id && message.metadata?.attachments?.[0]?.semanticSummary);
    expect(summarizedUserMessage?.metadata?.attachments?.[0]?.semanticSummary).toContain('鲫鱼');
    expect(summarizedUserMessage?.metadata?.attachments?.[0]?.semanticSummary).toContain('银灰色鱼身');
  });

  it('stores multi-image semantic summaries by structured attachment id', async () => {
    const chat = assistantChat();
    const userMessage: Message = {
      id: 'message-user-multi-fish',
      chatId: chat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: '上面哪张钓的是鲫鱼？',
      emotion: 0,
      timestamp: 1001,
      isDeleted: false,
      metadata: {
        attachments: [
          {
            id: 'image-1',
            kind: 'image',
            status: 'ready',
            altText: '第一张图',
            mimeType: 'image/png',
            url: 'data:image/png;base64,FISH',
            createdAt: 1001,
            updatedAt: 1001,
          },
          {
            id: 'image-2',
            kind: 'image',
            status: 'ready',
            altText: '第二张图',
            mimeType: 'image/png',
            url: 'data:image/png;base64,BUCKET',
            createdAt: 1001,
            updatedAt: 1001,
          },
        ],
      },
    };
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '第一张图里钓到的是鲫鱼，第二张图主要是水桶和鱼竿。',
      imageSummaries: [
        { attachmentId: 'image-1', summary: '钓到的鲫鱼，银灰色鱼身。' },
        { attachmentId: 'image-2', summary: '水桶和鱼竿。' },
      ],
    }));
    const upsertMessage = vi.fn();

    await runAssistantChatReplyFlow({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      aiProfiles: [{
        id: 'gpt-text',
        name: 'GPT',
        type: 'text',
        provider: 'openai',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
        isDefault: true,
        inputCapabilities: { imageInput: true, multiImageInput: true, maxAttachments: 9 },
      }],
      chat,
      chatId: chat.id,
      currentMessages: [userMessage],
      upsertMessage,
      updateChat: vi.fn(async () => undefined),
    });

    const summarizedUserMessage = upsertMessage.mock.calls
      .map((call) => call[0] as Message)
      .find((message) => message.id === userMessage.id && message.metadata?.attachments?.some((attachment) => attachment.semanticSummary));
    const [first, second] = summarizedUserMessage?.metadata?.attachments || [];
    expect(first?.semanticSummary).toContain('鲫鱼');
    expect(first?.semanticSummary).not.toContain('水桶');
    expect(second?.semanticSummary).toContain('水桶');
    expect(second?.semanticSummary).not.toContain('鲫鱼');
  });

  it('ignores hallucinated image summary attachment ids', async () => {
    const chat = assistantChat();
    const userMessage: Message = {
      id: 'message-user-bad-summary-id',
      chatId: chat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: '解释图片',
      emotion: 0,
      timestamp: 1001,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'real-image',
          kind: 'image',
          status: 'ready',
          altText: '真实图片',
          mimeType: 'image/png',
          url: 'data:image/png;base64,REAL',
          createdAt: 1001,
          updatedAt: 1001,
        }],
      },
    };
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我看到了图片内容。',
      imageSummaries: [{ attachmentId: 'fake-image', summary: '幻觉出来的图片摘要。' }],
    }));
    const upsertMessage = vi.fn();

    await runAssistantChatReplyFlow({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      aiProfiles: [{
        id: 'gpt-text',
        name: 'GPT',
        type: 'text',
        provider: 'openai',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
        isDefault: true,
      }],
      chat,
      chatId: chat.id,
      currentMessages: [userMessage],
      upsertMessage,
      updateChat: vi.fn(async () => undefined),
    });

    expect(upsertMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      id: userMessage.id,
      metadata: expect.objectContaining({
        attachments: [expect.objectContaining({ semanticSummary: expect.any(String) })],
      }),
    }));
  });

  it('passes uploaded images through the official GPT provider even when the model alias is provider-like', async () => {
    const chat = assistantChat();
    const userMessage: Message = {
      id: 'message-user-official-image',
      chatId: chat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: '解释这张参考图',
      emotion: 0,
      timestamp: 1001,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'uploaded-image',
          kind: 'image',
          status: 'ready',
          altText: '参考图',
          mimeType: 'image/png',
          url: 'data:image/png;base64,AAA',
          createdAt: 1001,
          updatedAt: 1001,
        }],
      },
    };
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我看到了图片内容。',
      imageSummaries: [{ attachmentId: 'uploaded-image', summary: '参考图。' }],
    }));

    await runAssistantChatReplyFlow({
      api: { provider: 'official-2', apiKey: '', baseUrl: '/api/ai', model: 'official-2' },
      aiProfiles: [{
        id: 'official-gpt',
        name: '官方2',
        type: 'text',
        provider: 'official-2',
        apiKey: '',
        baseUrl: '/api/ai',
        model: 'official-2',
        isDefault: true,
      }],
      chat,
      chatId: chat.id,
      currentMessages: [userMessage],
      upsertMessage: vi.fn(),
      updateChat: vi.fn(async () => undefined),
    });

    const projected = generateResponseMock.mock.calls[0]?.[2] as Array<{
      attachments?: Array<{ url: string; mimeType?: string }>;
    }>;
    expect(projected[0]?.attachments).toEqual([{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }]);
  });

  it('does not pretend to see uploaded images when text image input is disabled', async () => {
    const chat = assistantChat();
    const userMessage: Message = {
      id: 'message-user-image-disabled',
      chatId: chat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: '请解释这张图片',
      emotion: 0,
      timestamp: 1001,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'uploaded-image',
          kind: 'image',
          status: 'ready',
          altText: '捕获.PNG',
          mimeType: 'image/png',
          url: 'data:image/png;base64,AAA',
          sizeBytes: 3000,
          createdAt: 1001,
          updatedAt: 1001,
        }],
      },
    };
    generateResponseMock.mockResolvedValue('当前模型未收到可解析的图片输入。');
    const upsertMessage = vi.fn();

    await runAssistantChatReplyFlow({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      aiProfiles: [{
        id: 'gpt-text',
        name: 'GPT',
        type: 'text',
        provider: 'openai',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
        isDefault: true,
        inputCapabilities: { imageInput: false, multiImageInput: false },
      }],
      chat,
      chatId: chat.id,
      currentMessages: [userMessage],
      upsertMessage,
      updateChat: vi.fn(async () => undefined),
    });

    const systemPrompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    const projected = generateResponseMock.mock.calls[0]?.[2] as Array<{
      content: string;
      attachments?: Array<{ url: string; mimeType?: string }>;
    }>;
    expect(systemPrompt).toContain('当前文本模型请求没有携带可视觉解析的图片输入');
    expect(projected[0]?.content).toContain('[图片附件：捕获.PNG]');
    expect(projected[0]?.attachments).toBeUndefined();
    expect(upsertMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      id: userMessage.id,
      metadata: expect.objectContaining({
        attachments: [expect.objectContaining({ semanticSummary: expect.any(String) })],
      }),
    }));
  });

  it('uses the text model with image pixels for Agent chat replies instead of planner-only text', async () => {
    const chat = assistantChat();
    chat.modeState.assistantCapabilities = {
      ...(chat.modeState.assistantCapabilities || {}),
      agent: true,
      artifacts: true,
    };
    const userMessage: Message = {
      id: 'message-user-agent-image',
      chatId: chat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: '解释这张参考图',
      emotion: 0,
      timestamp: 1001,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'uploaded-image',
          kind: 'image',
          status: 'ready',
          altText: '参考图',
          mimeType: 'image/png',
          url: 'data:image/png;base64,AAA',
          createdAt: 1001,
          updatedAt: 1001,
        }],
      },
    };
    agentOrchestratorMock.planAssistantAgentChange.mockResolvedValue({
      intent: 'chat',
      assistantMessage: '我只能看到图片附件名称。',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [],
      requiresConfirmation: false,
      clarificationQuestion: '',
      confidence: 1,
      rationale: 'planner text',
    });
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我已根据图片内容完成解释。',
      imageSummaries: [{ attachmentId: 'uploaded-image', summary: '参考图内容已解释。' }],
    }));
    const upsertMessage = vi.fn();

    await runAssistantChatReplyFlow({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      aiProfiles: [{
        id: 'gpt-text',
        name: 'GPT',
        type: 'text',
        provider: 'openai',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
        isDefault: true,
      }],
      chat,
      chatId: chat.id,
      currentMessages: [userMessage],
      upsertMessage,
      updateChat: vi.fn(async () => undefined),
    });

    const imageReplyCall = generateResponseMock.mock.calls.find((call) => {
      const projectedMessages = call[2] as Array<{ attachments?: unknown[] }>;
      return projectedMessages.some((message) => Boolean(message.attachments?.length));
    });
    expect(imageReplyCall).toBeTruthy();
    const projected = imageReplyCall?.[2] as Array<{
      attachments?: Array<{ url: string; mimeType?: string }>;
    }>;
    expect(projected[0]?.attachments).toEqual([{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }]);
    const finalMessage = upsertMessage.mock.calls
      .map((call) => call[0] as Message)
      .find((message) => message.type === 'ai' && message.content === '我已根据图片内容完成解释。');
    expect(finalMessage?.content).toBe('我已根据图片内容完成解释。');
  });

  it('does not append the same Mermaid artifact twice when the writer already included it inline', () => {
    const mermaid = [
      'flowchart TD',
      '    A[父亲] -->|夫妻| B[母亲]',
      '    A -->|父子| C[儿子]',
      '    B -->|母子| C',
      '    C -->|夫妻| D[儿媳]',
      '    C -->|父子| E[孙子]',
      '    D -->|母子| E',
    ].join('\n');
    const patchSet: AssistantAgentPatchSet = {
      assistantMessage: [
        '这是一个简单的角色关系图示例。',
        '',
        '```mermaid',
        mermaid,
        '```',
      ].join('\n'),
      patches: [{
        action: 'create',
        kind: 'diagram',
        title: '角色关系图 (Mermaid)',
        language: 'mermaid',
        content: mermaid,
      }],
      mediaTasks: [],
    };

    const content = buildAgentArtifactReplyContent(patchSet);

    expect(content.match(/```mermaid/g)?.length).toBe(1);
    expect(content).not.toContain('## 角色关系图 (Mermaid)');
  });

  it('appends artifact content when the assistant message only contains a short summary', () => {
    const patchSet: AssistantAgentPatchSet = {
      assistantMessage: '已为你整理好角色关系图。',
      patches: [{
        action: 'create',
        kind: 'diagram',
        title: '角色关系图',
        language: 'mermaid',
        content: 'flowchart TD\n    A[秦始皇] -->|任用| B[李斯]\n    A -->|防范| C[赵高]',
      }],
      mediaTasks: [],
    };

    expect(buildAgentArtifactReplyContent(patchSet)).toContain('```mermaid');
  });

  it('keeps CSV and JSON source content out of the chat bubble', () => {
    const patchSet: AssistantAgentPatchSet = {
      assistantMessage: '已整理好数据文件。',
      patches: [{
        action: 'create',
        kind: 'table',
        title: '数据记录',
        content: 'id,name\n1,alpha\n2,beta',
      }, {
        action: 'create',
        kind: 'json',
        title: '结构化数据',
        content: '{"id":1,"name":"alpha"}',
      }],
      mediaTasks: [],
    };

    const content = buildAgentArtifactReplyContent(patchSet);
    expect(content).toContain('已整理好数据文件');
    expect(content).toContain('完整内容请在产物中查看或下载');
    expect(content).not.toContain('id,name');
    expect(content).not.toContain('"name":"alpha"');
  });

  it('keeps the user-facing assistant message separate from image prompts', () => {
    const patchSet: AssistantAgentPatchSet = {
      assistantMessage: '我为你生成一张红烧肉照片，肥瘦相间、酱色油亮，适合直接查看。',
      patches: [],
      mediaTasks: [{
        kind: 'image',
        prompt: 'A realistic photo of Chinese braised pork belly, glossy soy caramel sauce, food photography',
        altText: '红烧肉照片',
        targetImageIds: ['message-a:image-1'],
        referenceImageIds: ['message-b:image-2'],
        styleImageIds: ['message-c:image-3'],
      }],
    };

    expect(buildAgentArtifactReplyContent(patchSet)).toBe('我为你生成一张红烧肉照片，肥瘦相间、酱色油亮，适合直接查看。');
  });

  it('marks pending assistant media attachments as failed when media processing aborts unexpectedly', () => {
    const message: Message = {
      id: 'message-1',
      chatId: 'chat-1',
      type: 'ai',
      senderId: 'assistant',
      senderName: '助手',
      content: '对方正在发送图片，稍等一下。',
      emotion: 0,
      timestamp: 1000,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'queued',
          altText: '红烧肉照片',
          promptText: '红烧肉照片',
          createdAt: 1000,
          updatedAt: 1000,
        }],
        generation: {
          status: 'queued',
          updatedAt: 1000,
        },
      },
    };

    const next = markAssistantMediaAttachmentsFailed(message, new Error('生成服务异常'));

    expect(next.metadata?.attachments?.[0]).toMatchObject({
      id: 'image-1',
      status: 'failed',
      error: '生成服务异常',
    });
    expect(next.metadata?.generation?.status).toBe('failed');
  });
});

describe('assistantChatFlow title generation', () => {
  it('renames default assistant chats from AI using user requests without assistant reply text', async () => {
    const chat = assistantChat();
    const updateChat = vi.fn(async () => undefined);
    const messages: Message[] = [
      {
        id: 'message-user',
        chatId: chat.id,
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '查一下最新世界杯消息',
        emotion: 0,
        timestamp: 1001,
        isDeleted: false,
      },
      {
        id: 'message-ai',
        chatId: chat.id,
        type: 'ai',
        senderId: 'assistant',
        senderName: '助手',
        content: '这里是搜索到的世界杯最新动态摘要。',
        emotion: 0,
        timestamp: 1002,
        isDeleted: false,
      },
    ];
    useChatStore.setState({ chats: [chat] });
    generateResponseMock.mockResolvedValue('世界杯动态查询');

    await maybeGenerateAssistantChatTitle({
      api: { provider: 'official', apiKey: '', baseUrl: '/api/ai', model: 'official-1' },
      chat,
      chatId: chat.id,
      currentMessages: messages,
      updateChat,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    const titlePrompt = String((generateResponseMock.mock.calls[0]?.[2] as Array<{ content: string }>)[0]?.content || '');
    expect(titlePrompt).toContain('用户：查一下最新世界杯消息');
    expect(titlePrompt).not.toContain('助手：这里是搜索到的世界杯最新动态摘要。');
    expect(updateChat).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      name: '世界杯动态查询',
      modeState: expect.objectContaining({
        assistantTitle: expect.objectContaining({
          source: 'ai',
          basisMessageCount: 2,
        }),
      }),
    }));
  });

  it('falls back to the user request when the model returns an assistant-style completion sentence', async () => {
    const chat = assistantChat();
    const updateChat = vi.fn(async () => undefined);
    const messages: Message[] = [{
      id: 'message-user-download',
      chatId: chat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: '帮我下载一个新华字典到下载文件夹',
      emotion: 0,
      timestamp: 1001,
      isDeleted: false,
    }];
    useChatStore.setState({ chats: [chat] });
    generateResponseMock.mockResolvedValue('我已经成功地帮你下载了《新华字典》到你的下载文件夹。');

    await maybeGenerateAssistantChatTitle({
      api: { provider: 'official', apiKey: '', baseUrl: '/api/ai', model: 'official-1' },
      chat,
      chatId: chat.id,
      currentMessages: messages,
      updateChat,
    });

    expect(updateChat).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      name: '下载新华字典到下载文件夹',
    }));
  });

  it('repairs an existing AI-generated title that looks like an assistant reply', async () => {
    const chat: GroupChat = {
      ...assistantChat(),
      name: '我已经成功地帮你下载了《新华字典》到你的下载文件夹。',
      modeState: {
        ...buildAssistantChatDraft().modeState,
        assistantTitle: { source: 'ai', updatedAt: 1000 },
      },
    };
    const updateChat = vi.fn(async () => undefined);
    useChatStore.setState({ chats: [chat] });
    generateResponseMock.mockResolvedValue('下载新华字典');

    await maybeGenerateAssistantChatTitle({
      api: { provider: 'official', apiKey: '', baseUrl: '/api/ai', model: 'official-1' },
      chat,
      chatId: chat.id,
      currentMessages: [{
        id: 'message-user-download-repair',
        chatId: chat.id,
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '帮我下载一个新华字典到下载文件夹',
        emotion: 0,
        timestamp: 1001,
        isDeleted: false,
      }],
      updateChat,
    });

    expect(updateChat).toHaveBeenCalledWith(chat.id, expect.objectContaining({
      name: '下载新华字典',
    }));
  });

  it('does not rename assistant chats after a user title is recorded', async () => {
    const chat: GroupChat = {
      ...assistantChat(),
      modeState: {
        ...buildAssistantChatDraft().modeState,
        assistantTitle: { source: 'user', updatedAt: 1000 },
      },
    };
    useChatStore.setState({ chats: [chat] });

    await maybeGenerateAssistantChatTitle({
      api: { provider: 'official', apiKey: '', baseUrl: '/api/ai', model: 'official-1' },
      chat,
      chatId: chat.id,
      currentMessages: [{
        id: 'message-user',
        chatId: chat.id,
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '继续',
        emotion: 0,
        timestamp: 1001,
        isDeleted: false,
      }],
      updateChat: vi.fn(async () => undefined),
    });

    expect(generateResponseMock).not.toHaveBeenCalled();
  });
});
