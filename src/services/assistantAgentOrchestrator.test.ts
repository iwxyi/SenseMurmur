import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantAgentChangePlan, AssistantAgentPatchSet, AssistantArtifactItem } from '../types/assistantArtifact';
import type { Message } from '../types/message';
import {
  buildCompactImageAttachmentRefs,
  buildCompactImageReferenceRegistry,
  planAssistantAgentChange,
  validateAssistantAgentPatchSet,
  writeAssistantAgentPatchSet,
} from './assistantAgentOrchestrator';

const generateResponseMock = vi.hoisted(() => vi.fn());

vi.mock('./aiClient', () => ({
  generateResponse: (...args: unknown[]) => generateResponseMock(...args),
}));

function artifact(overrides: Partial<AssistantArtifactItem> = {}): AssistantArtifactItem {
  return {
    id: 'artifact-a',
    chatId: 'chat-a',
    kind: 'diagram',
    title: '注册流程',
    summary: '注册流程图',
    language: 'mermaid',
    currentVersionId: 'version-a',
    sourceMessageId: 'message-a',
    createdAt: 1,
    updatedAt: 1,
    versions: [{
      id: 'version-a',
      artifactId: 'artifact-a',
      content: 'flowchart TD\nA-->B',
      language: 'mermaid',
      sourceMessageId: 'message-a',
      createdAt: 1,
    }],
    deletedAt: null,
    ...overrides,
  };
}

describe('assistantAgentOrchestrator validation', () => {
  beforeEach(() => {
    generateResponseMock.mockReset();
  });

  it('limits network requests to four and rejects unsupported URL schemes', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      intent: 'chat',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [],
      requiresConfirmation: false,
      confidence: 1,
      networkRequests: [
        ...Array.from({ length: 8 }, (_, index) => ({ url: `https://example.com/${index}`, mode: 'readable' })),
        { url: 'file:///etc/passwd', mode: 'source' },
        { url: 'javascript:alert(1)', mode: 'readable' },
      ],
    }));

    const plan = await planAssistantAgentChange({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage: { id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '读取这些网页', emotion: 0, timestamp: 1, isDeleted: false },
      existingArtifacts: [],
      toolCapabilities: { networkAccess: true },
    });

    expect(plan.networkRequests).toHaveLength(4);
    expect(plan.networkRequests?.every((request) => request.url.startsWith('https://'))).toBe(true);
  });

  it('accepts anonymous FTP and only selects registered session resources', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      intent: 'chat',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [],
      requiresConfirmation: false,
      confidence: 1,
      networkRequests: [
        { url: 'ftp://example.com/pub/file.txt', mode: 'binary', action: 'store' },
        { url: 'ftp://user:secret@example.com/private.txt', mode: 'binary', action: 'store' },
      ],
      sessionResourceIds: ['resource-ok', 'resource-unknown'],
    }));

    const plan = await planAssistantAgentChange({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage: { id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '读取刚才保存的文件', emotion: 0, timestamp: 1, isDeleted: false },
      existingArtifacts: [],
      toolCapabilities: { networkAccess: true },
      sessionResourceRegistry: [{ id: 'resource-ok', name: 'file.txt', path: 'file.txt', sourceUrl: 'ftp://example.com/pub/file.txt', mimeType: 'text/plain', sizeBytes: 10, createdAt: 1 }],
    });

    expect(plan.networkRequests).toEqual([expect.objectContaining({ url: 'ftp://example.com/pub/file.txt', mode: 'binary', action: 'store' })]);
    expect(plan.sessionResourceIds).toEqual(['resource-ok']);
  });

  it('asks before writing to an unresolved workspace target', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      intent: 'chat',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [],
      requiresConfirmation: false,
      confidence: 1,
      networkRequests: [{ url: 'https://example.com/file.zip', mode: 'binary', action: 'store', destination: 'workspace', workspaceId: 'unknown' }],
    }));

    const plan = await planAssistantAgentChange({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a', messages: [],
      userMessage: { id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '保存到工作区', emotion: 0, timestamp: 1, isDeleted: false },
      existingArtifacts: [],
      toolCapabilities: {
        networkAccess: true,
        localWorkspace: true,
        localWorkspaceDirectories: [
          { id: 'workspace-a', name: '资料', isDefault: false },
          { id: 'workspace-b', name: '项目', isDefault: false },
        ],
      },
    });

    expect(plan.intent).toBe('clarify');
    expect(plan.networkRequests).toEqual([]);
    expect(plan.clarificationQuestion).toContain('哪个已授权工作区');
  });

  it('turns a named download without a URL into source discovery instead of a capability denial', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      intent: 'chat',
      assistantMessage: '我没有下载能力。',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [],
      requiresConfirmation: false,
      confidence: 0.7,
    }));

    const plan = await planAssistantAgentChange({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a', messages: [],
      userMessage: { id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '帮我下载一个新华字典到下载文件夹', emotion: 0, timestamp: 1, isDeleted: false },
      existingArtifacts: [],
      toolCapabilities: { webSearch: true, networkAccess: true },
    });

    expect(plan.intent).toBe('search');
    expect(plan.searchQuery).toBe('帮我下载一个新华字典到下载文件夹');
    expect(plan.assistantMessage).toBe('');
    expect(plan.operations).toEqual([expect.objectContaining({ kind: 'export' })]);
  });

  it('keeps generated HTML out of the visible assistant message', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '已为你创建旅行调查。\n\n## 旅行偏好调查\n```html\n<!doctype html><html><body><form><input name="destination"></form></body></html>\n```',
      patches: [{
        action: 'create',
        kind: 'html',
        title: '旅行偏好调查',
        content: '<!doctype html><html><body><form><input name="destination"></form></body></html>',
        htmlRuntime: {
          submission: {
            interactionId: 'travel-1',
            resultType: 'form',
            fields: [{ name: 'destination', type: 'text', required: true }],
          },
        },
      }],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      responseExperience: 'interactive_workspace',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '创建旅行调查' }],
      requiresConfirmation: false,
      confidence: 1,
    };
    const userMessage: Message = {
      id: 'message-user',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '创建旅行调查',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage,
      plan,
      existingArtifacts: [],
    });

    expect(patchSet.assistantMessage).toBe('已为你创建旅行调查。\n\n## 旅行偏好调查');
    expect(patchSet.assistantMessage).not.toContain('```html');
    expect(patchSet.assistantMessage).not.toContain('<!doctype html>');
    expect(patchSet.patches[0]?.content).toContain('<!doctype html>');
    expect(patchSet.patches[0]?.htmlRuntime?.presentation).toBe('fullscreen');
  });

  it('rejects HTML artifacts when the planner classified the request as source code', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '```html\n<div>Hello</div>\n```',
      patches: [{ action: 'create', kind: 'html', title: '示例', content: '<div>Hello</div>', htmlRuntime: {} }],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      responseExperience: 'source_code',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '展示 HTML 示例代码' }],
      requiresConfirmation: false,
      confidence: 1,
    };
    const userMessage: Message = {
      id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '写一段 HTML 示例代码', emotion: 0, timestamp: 1, isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a', messages: [], userMessage, plan, existingArtifacts: [],
    });

    expect(patchSet.patches).toEqual([]);
  });

  it('allows a local calculator without a chat submission schema', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '可以直接换算。',
      patches: [{ action: 'create', kind: 'html', title: '汇率换算', content: '<form><input name="amount" type="number"><button type="button">换算</button></form>' }],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      responseExperience: 'structured_input',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '创建轻量汇率换算工具' }],
      requiresConfirmation: false,
      confidence: 1,
    };
    const userMessage: Message = {
      id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '给我一个简单的汇率换算工具', emotion: 0, timestamp: 1, isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a', messages: [], userMessage, plan, existingArtifacts: [],
    });

    expect(patchSet.patches[0]?.htmlRuntime?.presentation).toBe('inline');
    expect(patchSet.patches[0]?.htmlRuntime?.submission).toBeUndefined();
  });

  it('allows a read-only HTML visualization without a submission schema', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '这是当前显卡性能分层。',
      patches: [{ action: 'create', kind: 'html', title: '显卡天梯图', content: '<section><ol><li>RTX 5090</li><li>RTX 5080</li></ol></section>' }],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      responseExperience: 'visual_explanation',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '用天梯图展示显卡性能' }],
      requiresConfirmation: false,
      confidence: 1,
    };
    const userMessage: Message = {
      id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '给我看看显卡天梯图', emotion: 0, timestamp: 1, isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a', messages: [], userMessage, plan, existingArtifacts: [],
    });

    expect(patchSet.patches[0]?.htmlRuntime).toMatchObject({ executionMode: 'declarative', presentation: 'inline' });
    expect(patchSet.patches[0]?.htmlRuntime?.submission).toBeUndefined();
  });

  it('keeps data URL images out of text model payload references', () => {
    const message: Message = {
      id: 'message-image',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '参考这张图',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'att-image',
          kind: 'image',
          status: 'ready',
          altText: '参考图',
          caption: '参考图说明',
          url: `data:image/png;base64,${'A'.repeat(4096)}`,
          mimeType: 'image/png',
          width: 1024,
          height: 1024,
          sizeBytes: 4096,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    };

    expect(buildCompactImageAttachmentRefs(message)).toEqual([{
      id: 'att-image',
      messageId: 'message-image',
      refId: 'message-image:att-image',
      mimeType: 'image/png',
      altText: '参考图',
      caption: '参考图说明',
      width: 1024,
      height: 1024,
      sizeBytes: 4096,
      urlKind: 'data',
    }]);
    expect(JSON.stringify(buildCompactImageAttachmentRefs(message))).not.toContain('data:image');
  });

  it('builds a lightweight image reference registry independent of text history', () => {
    const imageOnlyMessage: Message = {
      id: 'message-image-only',
      chatId: 'chat-a',
      type: 'ai',
      senderId: 'assistant',
      senderName: '助手',
      content: '',
      emotion: 0,
      timestamp: 20,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'att-latest',
          kind: 'image',
          status: 'ready',
          altText: '上一张生成图',
          promptText: '赛博茶馆里的红铜茶壶，霓虹灯反射，电影感构图',
          semanticSummary: '模型识别：红铜茶壶在赛博茶馆中，霓虹反射明显。',
          url: `data:image/png;base64,${'B'.repeat(4096)}`,
          mimeType: 'image/png',
          createdAt: 20,
          updatedAt: 20,
        }],
      },
    };
    const olderMessage: Message = {
      ...imageOnlyMessage,
      id: 'message-older',
      content: '旧参考图',
      timestamp: 10,
      metadata: {
        attachments: [{
          id: 'att-older',
          kind: 'image',
          status: 'ready',
          altText: '旧参考图',
          url: 'https://example.test/older.png',
          mimeType: 'image/png',
          createdAt: 10,
          updatedAt: 10,
        }],
      },
    };

    const registry = buildCompactImageReferenceRegistry([olderMessage, imageOnlyMessage]);

    expect(registry.map((item) => item.refId)).toEqual([
      'message-image-only:att-latest',
      'message-older:att-older',
    ]);
    expect(registry[0]).toMatchObject({
      messageRole: 'assistant',
      messageContentPreview: '',
      promptText: '赛博茶馆里的红铜茶壶，霓虹灯反射，电影感构图',
      semanticSummary: '模型识别：红铜茶壶在赛博茶馆中，霓虹反射明显。',
      urlKind: 'data',
    });
    expect(JSON.stringify(registry)).not.toContain('data:image');
  });

  it('keeps terse image media prompts model-guided before dispatching image generation', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '下面是三张图。',
      patches: [],
      mediaTasks: [{
        kind: 'image',
        slotId: 'image-1',
        userCaption: '番茄炒蛋',
        prompt: '番茄炒蛋',
        altText: '番茄炒蛋',
      }],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '生成图片' }],
      requiresConfirmation: false,
      confidence: 0.95,
    };
    const userMessage: Message = {
      id: 'message-image',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '帮我生成番茄炒蛋',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage,
      plan,
      existingArtifacts: [],
    });

    const writerPrompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(writerPrompt).toContain('先在内部梳理');
    expect(writerPrompt).toContain('最近对话中已经确定的主题/角色/风格/禁忌/数量/用途');
    expect(writerPrompt).toContain('给图片模型执行的最终提示词，不是对图片模型说“请你再写提示词”');
    expect(patchSet.mediaTasks?.[0]?.prompt).toContain('Original user image request: 番茄炒蛋');
    expect(patchSet.mediaTasks?.[0]?.prompt).toContain('Do not infer a fixed category from local keywords');
    expect(patchSet.mediaTasks?.[0]?.prompt).toContain('番茄炒蛋');
    expect(patchSet.mediaTasks?.[0]?.prompt).not.toBe('番茄炒蛋');
  });

  it('rejects inline image placeholders that do not have media tasks', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '好的，为你生成一张红烧肉的图片。\n\n![红烧肉成菜图](attachment:image-1)',
      patches: [],
      mediaTasks: [],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '生成一张红烧肉图片' }],
      requiresConfirmation: false,
      confidence: 0.95,
    };
    const userMessage: Message = {
      id: 'message-image-recovery',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '帮我生成一张红烧肉的图片',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage,
      plan,
      existingArtifacts: [],
    });

    expect(patchSet.assistantMessage).toContain('图片任务输出不完整');
    expect(patchSet.assistantMessage).toContain('image-1');
    expect(patchSet.mediaTasks).toEqual([]);
  });

  it('rejects update patches outside the planned artifact scope', () => {
    const plan: AssistantAgentChangePlan = {
      intent: 'update',
      scope: { targetMode: 'single', artifactIds: ['artifact-a'] },
      operations: [{ kind: 'style_change', instruction: '字体小一些' }],
      requiresConfirmation: false,
      confidence: 0.92,
    };
    const patchSet: AssistantAgentPatchSet = {
      assistantMessage: '已调整。',
      patches: [{
        action: 'update',
        artifactId: 'artifact-b',
        kind: 'diagram',
        title: '注册流程',
        language: 'mermaid',
        content: 'flowchart TD\nA-->B',
        baseVersionId: 'version-b',
      }],
    };

    expect(validateAssistantAgentPatchSet({
      patchSet,
      plan,
      existingArtifacts: [artifact()],
    }).patches).toEqual([]);
  });

  it('rejects stale update patches when base version does not match', () => {
    const plan: AssistantAgentChangePlan = {
      intent: 'update',
      scope: { targetMode: 'single', artifactIds: ['artifact-a'] },
      operations: [{ kind: 'content_edit', instruction: '增加审批节点' }],
      requiresConfirmation: false,
      confidence: 0.92,
    };
    const patchSet: AssistantAgentPatchSet = {
      assistantMessage: '已调整。',
      patches: [{
        action: 'update',
        artifactId: 'artifact-a',
        kind: 'diagram',
        title: '注册流程',
        language: 'mermaid',
        content: 'flowchart TD\nA-->B-->C',
        baseVersionId: 'old-version',
      }],
    };

    expect(validateAssistantAgentPatchSet({
      patchSet,
      plan,
      existingArtifacts: [artifact()],
    }).patches).toEqual([]);
  });

  it('keeps validated image media tasks for create plans', () => {
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '生成一张产品海报' }],
      requiresConfirmation: false,
      confidence: 0.95,
    };
    const patchSet: AssistantAgentPatchSet = {
      assistantMessage: '图片已加入生成队列。',
      patches: [],
      mediaTasks: [{
        kind: 'image',
        prompt: 'A clean product poster, studio lighting',
        altText: '产品海报',
        referenceImages: [{ url: 'https://example.test/ref.png', mimeType: 'image/png', label: '参考图' }],
      }],
    };

    expect(validateAssistantAgentPatchSet({
      patchSet,
      plan,
      existingArtifacts: [],
    }).mediaTasks).toEqual(patchSet.mediaTasks);
  });

  it('deduplicates generated media task slot ids', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '这里是两张图。\n\n![第一张](attachment:image-1)\n\n![第二张](attachment:image-1)',
      patches: [],
      mediaTasks: [
        { kind: 'image', slotId: 'image-1', prompt: 'First image prompt', altText: '第一张' },
        { kind: 'image', slotId: 'image-1', prompt: 'Second image prompt', altText: '第二张' },
      ],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '生成两张图' }],
      requiresConfirmation: false,
      confidence: 0.9,
    };
    const userMessage: Message = {
      id: 'message-user',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '生成两张图',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage,
      plan,
      existingArtifacts: [],
    });

    expect(patchSet.mediaTasks?.map((task) => task.slotId)).toEqual(['image-1', 'image-1-2']);
    expect(patchSet.assistantMessage).toContain('attachment:image-1-2');
  });

  it('preserves grouped data filters from the writer response', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '已查询。',
      patches: [],
      dataOperations: [{
        kind: 'query',
        artifactId: 'data-a',
        filter: [{ any: [
          { field: 'profile.name', operator: 'eq', value: '张三' },
          { not: { field: 'score', operator: 'lt', value: 60 } },
        ] }],
      }],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'update',
      scope: { targetMode: 'single', artifactIds: ['data-a'] },
      operations: [{ kind: 'search', instruction: '查询数据' }],
      requiresConfirmation: false,
      confidence: 1,
    };
    const dataArtifact = { ...artifact({ id: 'data-a', kind: 'json' as const }), versions: [{
      id: 'version-a', artifactId: 'data-a', content: '[]', sourceMessageId: 'message-a', createdAt: 1,
    }] };
    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a', messages: [], userMessage: {
        id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '查询数据', emotion: 0, timestamp: 1, isDeleted: false,
      }, plan, existingArtifacts: [dataArtifact],
    });
    expect(patchSet.dataOperations?.[0]?.filter).toEqual([{ any: [
      { field: 'profile.name', operator: 'eq', value: '张三' },
      { not: { field: 'score', operator: 'lt', value: 60 } },
    ] }]);
  });

  it('uses the latest image as target for implicit image text edits when the writer asks to reupload', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '请重新上传要修改的图片，或确认是上一条里那张图片。',
      patches: [],
      mediaTasks: [],
    }));
    const imageMessage: Message = {
      id: 'message-image',
      chatId: 'chat-a',
      type: 'ai',
      senderId: 'assistant',
      senderName: '助手',
      content: '图片已生成。',
      emotion: 0,
      timestamp: 10,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'image-a',
          kind: 'image',
          status: 'ready',
          altText: '梁文峰照片',
          caption: '含有人名梁文峰的图片',
          url: 'data:image/png;base64,AAA',
          mimeType: 'image/png',
          createdAt: 10,
          updatedAt: 10,
        }],
      },
    };
    const userMessage: Message = {
      id: 'message-user',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '把图片里的梁文峰改成梁晓峰',
      emotion: 0,
      timestamp: 20,
      isDeleted: false,
    };
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '编辑图片文字' }],
      requiresConfirmation: false,
      confidence: 0.9,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [imageMessage],
      userMessage,
      plan,
      existingArtifacts: [],
    });

    expect(patchSet.mediaTasks).toHaveLength(1);
    expect(patchSet.mediaTasks?.[0]?.targetImageIds).toEqual(['message-image:image-a']);
    expect(patchSet.mediaTasks?.[0]?.referenceImages?.[0]?.url).toBe('data:image/png;base64,AAA');
    expect(patchSet.assistantMessage).toContain('attachment:image-1');
  });

  it('fills the latest image target when an implicit edit media task omits image ids', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '已准备修改。',
      patches: [],
      mediaTasks: [{
        kind: 'image',
        slotId: 'edit-name',
        prompt: '把图片里的梁文峰改成梁晓峰，保持其它内容不变',
        altText: '修改后图片',
      }],
    }));
    const imageMessage: Message = {
      id: 'message-image-latest',
      chatId: 'chat-a',
      type: 'ai',
      senderId: 'assistant',
      senderName: '助手',
      content: '',
      emotion: 0,
      timestamp: 30,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'image-latest',
          kind: 'image',
          status: 'ready',
          altText: '上一张图',
          url: 'https://example.test/latest.png',
          mimeType: 'image/png',
          createdAt: 30,
          updatedAt: 30,
        }],
      },
    };
    const userMessage: Message = {
      id: 'message-user',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '把图片里的梁文峰改成梁晓峰',
      emotion: 0,
      timestamp: 40,
      isDeleted: false,
    };
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '编辑图片文字' }],
      requiresConfirmation: false,
      confidence: 0.9,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [imageMessage],
      userMessage,
      plan,
      existingArtifacts: [],
    });

    expect(patchSet.mediaTasks?.[0]?.slotId).toBe('edit-name');
    expect(patchSet.mediaTasks?.[0]?.targetImageIds).toEqual(['message-image-latest:image-latest']);
    expect(patchSet.mediaTasks?.[0]?.referenceImages?.[0]?.url).toBe('https://example.test/latest.png');
  });

  it('keeps long user-facing image articles instead of truncating near the first paragraph', async () => {
    const longIntro = `这是一篇图文说明。\n\n${'正文段落。'.repeat(500)}`;
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: longIntro,
      patches: [],
      mediaTasks: [
        { kind: 'image', slotId: 'cover', prompt: 'Cover image prompt', altText: '封面图' },
      ],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'create',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [{ kind: 'create', instruction: '生成图文文章' }],
      requiresConfirmation: false,
      confidence: 0.9,
    };
    const userMessage: Message = {
      id: 'message-user',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '生成图文文章',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage,
      plan,
      existingArtifacts: [],
    });

    expect(patchSet.assistantMessage.length).toBeGreaterThan(1000);
    expect(patchSet.assistantMessage).toContain('attachment:cover');
  });

  it('compacts oversized target artifact context for writer requests', async () => {
    generateResponseMock.mockResolvedValue(JSON.stringify({
      assistantMessage: '已修改。',
      patches: [{
        action: 'update',
        artifactId: 'artifact-a',
        kind: 'document',
        title: '长文档',
        content: '模型试图基于裁剪内容生成的新版本',
        baseVersionId: 'version-a',
      }],
      mediaTasks: [],
    }));
    const plan: AssistantAgentChangePlan = {
      intent: 'update',
      scope: { targetMode: 'single', artifactIds: ['artifact-a'] },
      operations: [{ kind: 'content_edit', instruction: '调整措辞' }],
      requiresConfirmation: false,
      confidence: 0.9,
    };
    const userMessage: Message = {
      id: 'message-user',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '调整一下这个文档',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
    };

    const patchSet = await writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage,
      plan,
      existingArtifacts: [artifact({
        kind: 'document',
        title: '长文档',
        versions: [{
          id: 'version-a',
          artifactId: 'artifact-a',
          content: '正文'.repeat(100_000),
          language: 'markdown',
          sourceMessageId: 'message-a',
          createdAt: 1,
        }],
      })],
    });

    const content = String((generateResponseMock.mock.calls[0]?.[2] as Array<{ content: string }>)[0].content);
    expect(content.length).toBeLessThan(420_000);
    expect(content).toContain('"currentVersionContentTruncated":true');
    expect(content).toContain('上下文已裁剪');
    expect(patchSet.patches).toEqual([]);
    expect(patchSet.assistantMessage).toContain('上下文不足');
  });

  it('does not automatically retry malformed HTML repair output', async () => {
    generateResponseMock.mockResolvedValue('这不是 JSON');
    const plan: AssistantAgentChangePlan = {
      intent: 'update',
      responseExperience: 'interactive_workspace',
      scope: { targetMode: 'single', artifactIds: ['artifact-a'] },
      operations: [{ kind: 'content_edit', instruction: '修复页面运行错误' }],
      requiresConfirmation: false,
      confidence: 1,
    };
    const userMessage: Message = {
      id: 'message-user',
      chatId: 'chat-a',
      type: 'user',
      senderId: 'user',
      senderName: '用户',
      content: '请修复这个页面',
      emotion: 0,
      timestamp: 2,
      isDeleted: false,
      metadata: {
        assistantHtmlRuntimeError: {
          artifactId: 'artifact-a',
          versionId: 'version-a',
          message: "Cannot read properties of null (reading 'n')",
          kind: 'runtime',
          reportedAt: 2,
        },
      },
    };

    await expect(writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage,
      plan,
      existingArtifacts: [artifact({
        kind: 'html',
        title: '围堵猫咪',
        language: 'html',
        versions: [{
          id: 'version-a', artifactId: 'artifact-a', content: '<!doctype html><canvas></canvas>', language: 'html', sourceMessageId: 'message-a', createdAt: 1,
        }],
      })],
    })).rejects.toMatchObject({ name: 'AssistantAgentFormatError' });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('HTML 运行诊断修复');
  });

  it('does not retain malformed model output on format errors', async () => {
    generateResponseMock.mockResolvedValue('sensitive malformed response');
    const request = writeAssistantAgentPatchSet({
      api: { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      chatId: 'chat-a',
      messages: [],
      userMessage: {
        id: 'message-user', chatId: 'chat-a', type: 'user', senderId: 'user', senderName: '用户', content: '创建文档', emotion: 0, timestamp: 1, isDeleted: false,
      },
      plan: {
        intent: 'create', scope: { targetMode: 'unknown', artifactIds: [] }, operations: [{ kind: 'create', instruction: '创建文档' }], requiresConfirmation: false, confidence: 1,
      },
      existingArtifacts: [],
    });

    const error = await request.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'AssistantAgentFormatError' });
    expect(error).not.toHaveProperty('rawResponse');
    expect(JSON.stringify(error)).not.toContain('sensitive malformed response');
  });
});
