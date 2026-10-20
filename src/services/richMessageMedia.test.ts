import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';
import type { AIModelProfile } from '../types/settings';
import { getRichMediaQueueSnapshot, processRichMessageMedia, resetRichMediaQueueForTests, retryRichMessageMedia, scrubLocalMediaUrlsForCloud } from './richMessageMedia';
import { generateImageWithAdapter } from './aiGenerationAdapter';
import { api } from './api';

vi.mock('./api', () => ({
  api: {
    createMediaAsset: vi.fn(),
    updateMessageMetadata: vi.fn(),
  },
}));

vi.mock('./aiGenerationAdapter', () => ({
  generateImageWithAdapter: vi.fn(),
  synthesizeSpeechWithAdapter: vi.fn(),
}));

const imageProfile: AIModelProfile = {
  id: 'image-default',
  name: '默认图片',
  type: 'image',
  provider: 'openai',
  apiKey: 'key',
  baseUrl: 'https://example.test',
  model: 'image-model',
  isDefault: true,
};

const chatStoreState = vi.hoisted(() => ({
  chats: [] as Array<Record<string, unknown>>,
}));

const artifactStoreState = vi.hoisted(() => ({
  createImageArtifactFromAttachment: vi.fn(),
}));

vi.mock('../stores/useChatStore', () => ({
  useChatStore: { getState: () => chatStoreState },
}));

vi.mock('../stores/useAssistantArtifactStore', () => ({
  useAssistantArtifactStore: { getState: () => artifactStoreState },
}));

const character = {
  id: 'mei',
  name: '美羊羊',
  avatar: '',
  modelProfileIds: {},
} as AICharacter;

const subjectCharacter = {
  id: 'hui',
  name: '灰太狼',
  avatar: '',
  visualIdentity: {
    description: '灰色狼，黄色补丁帽，两撇胡子',
    negativePrompt: 'no sheep ears',
    seed: 777,
  },
} as AICharacter;

function buildQueuedImageMessage(patch: Partial<Message> = {}): Message {
  return {
    id: patch.id || 'm-image',
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'mei',
    senderName: '美羊羊',
    content: '我把图发你看。',
    emotion: 0,
    timestamp: 123,
    isDeleted: false,
    metadata: {
      attachments: [{
        id: 'image-1',
        kind: 'image',
        status: 'queued',
        promptText: '灰太狼证件照',
        altText: '灰太狼证件照',
        createdAt: 123,
        updatedAt: 123,
      }],
    },
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForExpectation(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe('processRichMessageMedia', () => {
  const localStorageMock = (() => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    };
  })();

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true });
    vi.clearAllMocks();
    resetRichMediaQueueForTests();
    localStorage.clear();
    chatStoreState.chats = [];
    artifactStoreState.createImageArtifactFromAttachment.mockReset();
    vi.mocked(api.updateMessageMetadata).mockResolvedValue({});
  });

  it('marks the message-level generation state as failed when image generation cannot run', async () => {
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: buildQueuedImageMessage(),
      character,
      aiProfiles: [],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.metadata?.attachments?.[0]?.status).toBe('generating');
    expect(upserts[0]?.metadata?.generation?.status).toBe('generating');
    expect(upserts[1]?.metadata?.attachments?.[0]?.status).toBe('failed');
    expect(upserts[1]?.metadata?.attachments?.[0]?.error).toBe('图片模型未配置');
    expect(upserts[1]?.metadata?.generation?.status).toBe('failed');
  });

  it('turns aborted image generations into a user-facing timeout failure', async () => {
    vi.mocked(generateImageWithAdapter).mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: buildQueuedImageMessage(),
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'failed',
      error: '图片生成超时，请稍后重试。',
    });
    expect(upserts.at(-1)?.metadata?.generation?.status).toBe('failed');
  });

  it('marks the message-level generation state as ready after a generated image is attached', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,abc',
      mimeType: 'image/png',
    }]);
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: buildQueuedImageMessage(),
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready',
      url: 'data:image/png;base64,abc',
      mimeType: 'image/png',
    });
    expect(upserts.at(-1)?.metadata?.generation?.status).toBe('ready');
  });

  it('keeps the generated data url visible if media asset creation returns no url', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,fallback',
      mimeType: 'image/png',
    }]);
    const { api } = await import('./api');
    vi.mocked(api.createMediaAsset).mockResolvedValue({
      id: 'asset-missing-url',
      url: '',
      mimeType: 'image/png',
      sizeBytes: 1234,
    });
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: buildQueuedImageMessage({ serverId: 'server-message-image' }),
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready',
      assetId: 'asset-missing-url',
      url: 'data:image/png;base64,fallback',
    });
  });

  it('registers generated assistant images as image artifacts when agent artifacts are enabled', async () => {
    chatStoreState.chats = [{
      id: 'chat-1',
      type: 'assistant',
      modeState: { assistantCapabilities: { agent: true, artifacts: true } },
    }];
    artifactStoreState.createImageArtifactFromAttachment.mockReturnValue({
      id: 'artifact-image-1',
      kind: 'image',
      title: '灰太狼证件照',
    });
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,cloud',
      mimeType: 'image/png',
    }]);
    const { api } = await import('./api');
    vi.mocked(api.createMediaAsset).mockResolvedValue({
      id: 'asset-1',
      url: '/uploads/media/u/chat/image.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
      checksum: 'hash',
    });
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: buildQueuedImageMessage({ serverId: 'server-message-image' }),
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(artifactStoreState.createImageArtifactFromAttachment).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      attachment: expect.objectContaining({ assetId: 'asset-1', status: 'ready' }),
    }));
    expect(upserts.at(-1)?.metadata?.assistant?.artifacts?.[0]).toMatchObject({
      id: 'artifact-image-1',
      kind: 'image',
      title: '灰太狼证件照',
    });
  });

  it('waits for a server message id before processing or patching cloud media', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: buildQueuedImageMessage(),
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(upserts).toEqual([]);
    expect(generateImageWithAdapter).not.toHaveBeenCalled();
    expect(api.updateMessageMetadata).not.toHaveBeenCalled();
  });

  it('uses referenced subject characters for image generation instead of the sending character', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,subject',
      mimeType: 'image/png',
    }]);
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: buildQueuedImageMessage({
        metadata: {
          attachments: [{
            id: 'image-1',
            kind: 'image',
            status: 'queued',
            promptText: '灰太狼证件照',
            altText: '灰太狼证件照',
            referenceCharacterIds: ['hui'],
            createdAt: 123,
            updatedAt: 123,
          }],
        },
      }),
      character,
      characters: [character, subjectCharacter],
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(generateImageWithAdapter).toHaveBeenCalledWith(expect.objectContaining({
      character: null,
      characters: [subjectCharacter],
      negativePrompt: 'no sheep ears',
      seed: 777,
    }));
    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready',
      url: 'data:image/png;base64,subject',
    });
  });

  it('passes explicit reference images from the message attachment to the image adapter', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,referenced',
      mimeType: 'image/png',
    }]);
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: buildQueuedImageMessage({
        metadata: {
          attachments: [{
            id: 'image-1',
            kind: 'image',
            status: 'queued',
            promptText: '按参考图风格生成海报',
            altText: '参考图海报',
            referenceImages: [{ url: 'https://example.test/reference.png', mimeType: 'image/png', label: '用户参考图' }],
            createdAt: 123,
            updatedAt: 123,
          }],
        },
      }),
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(generateImageWithAdapter).toHaveBeenCalledWith(expect.objectContaining({
      referenceImages: [{ url: 'https://example.test/reference.png', mimeType: 'image/png', label: '用户参考图' }],
    }));
    expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('ready');
  });

  it('resolves referenced image ids from the current message window when a queued edit is recovered', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,edited',
      mimeType: 'image/png',
    }]);
    const sourceMessage = buildQueuedImageMessage({
      id: 'message-source',
      metadata: {
        attachments: [{
          id: 'source-image',
          kind: 'image',
          status: 'ready',
          url: 'data:image/png;base64,source',
          mimeType: 'image/png',
          altText: '梁文峰照片',
          caption: '待修改图片',
          createdAt: 100,
          updatedAt: 110,
        }],
      },
    });
    const editMessage = buildQueuedImageMessage({
      id: 'message-edit',
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'queued',
          promptText: '把图片里的梁文峰改成梁晓峰，保持原图构图和背景不变。',
          altText: '改名后的图片',
          targetImageIds: ['message-source:source-image'],
          createdAt: 123,
          updatedAt: 123,
        }],
      },
    });
    const upserts: Message[] = [];

    await processRichMessageMedia({
      message: editMessage,
      messages: [sourceMessage, editMessage],
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(generateImageWithAdapter).toHaveBeenCalledWith(expect.objectContaining({
      referenceImages: [{
        url: 'data:image/png;base64,source',
        mimeType: 'image/png',
        label: '待修改图片',
      }],
    }));
    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready',
      url: 'data:image/png;base64,edited',
    });
  });

  it('scrubs local data urls for cloud without downgrading ready images back to the generation queue', () => {
    const metadata = scrubLocalMediaUrlsForCloud(buildQueuedImageMessage({
      metadata: {
        generation: { status: 'ready', updatedAt: 130 },
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'ready',
          url: 'data:image/png;base64,ready',
          mimeType: 'image/png',
          altText: '已生成图片',
          promptText: '正确的图片提示词',
          createdAt: 123,
          updatedAt: 130,
        }],
      },
    }));

    expect(metadata?.attachments?.[0]).toMatchObject({
      id: 'image-1',
      status: 'ready',
      url: undefined,
      assetId: undefined,
    });
    expect(metadata?.generation?.status).toBe('ready');
  });

  it('retries a failed media attachment by resetting it to queued and running the same pipeline', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,retry',
      mimeType: 'image/png',
    }]);
    const failedMessage = buildQueuedImageMessage({
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'failed',
          promptText: '灰太狼证件照',
          altText: '灰太狼证件照',
          error: '上次生成失败',
          createdAt: 123,
          updatedAt: 124,
        }],
        generation: { status: 'failed', updatedAt: 124 },
      },
    });
    const upserts: Message[] = [];

    await retryRichMessageMedia({
      message: failedMessage,
      attachmentId: 'image-1',
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(upserts[0]?.metadata?.attachments?.[0]).toMatchObject({
      status: 'queued',
      error: undefined,
      url: undefined,
    });
    await waitForExpectation(() => {
      expect(upserts.some((message) => message.metadata?.attachments?.[0]?.status === 'generating')).toBe(true);
      expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
        status: 'ready',
        url: 'data:image/png;base64,retry',
      });
      expect(upserts.at(-1)?.metadata?.generation?.status).toBe('ready');
    });
  });

  it('allows retrying a stuck generating media attachment', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,recovered',
      mimeType: 'image/png',
    }]);
    const stuckMessage = buildQueuedImageMessage({
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'generating',
          promptText: '番茄炒蛋',
          altText: '番茄炒蛋',
          generationJobId: 'old-job',
          createdAt: 123,
          updatedAt: 124,
        }],
        generation: { status: 'generating', updatedAt: 124 },
      },
    });
    const upserts: Message[] = [];

    await retryRichMessageMedia({
      message: stuckMessage,
      attachmentId: 'image-1',
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    expect(upserts[0]?.metadata?.attachments?.[0]).toMatchObject({
      status: 'queued',
      error: undefined,
      url: undefined,
    });
    expect(upserts[0]?.metadata?.attachments?.[0]?.generationJobId).not.toBe('old-job');
    await waitForExpectation(() => {
      expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
        status: 'ready',
        url: 'data:image/png;base64,recovered',
      });
    });
  });

  it('keeps all image generation inputs intact when retrying while clearing only stale output fields', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,retry-inputs',
      mimeType: 'image/png',
    }]);
    const failedMessage = buildQueuedImageMessage({
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'failed',
          slotId: 'cover-slot',
          promptText: '把参考图里的标题放大 20%，其余构图保持不变。',
          altText: '标题放大后的海报',
          caption: '海报修改稿',
          semanticSummary: '上一版标题偏小。',
          aspectRatio: '4:5',
          imageSize: '2K',
          targetArtifactId: 'artifact-image-1',
          targetImageIds: ['message-old:image-old'],
          referenceImageIds: ['message-ref:image-ref'],
          styleImageIds: ['message-style:image-style'],
          referenceCharacterIds: ['hui'],
          referenceImages: [{ url: 'data:image/png;base64,old', mimeType: 'image/png', label: '上一版图片' }],
          error: '上次生成失败',
          assetId: 'stale-asset',
          url: '/stale.png',
          thumbnailAssetId: 'stale-thumb',
          width: 1024,
          height: 1280,
          sizeBytes: 999,
          checksum: 'stale-checksum',
          createdAt: 123,
          updatedAt: 124,
        }],
        generation: { status: 'failed', updatedAt: 124 },
      },
    });
    const upserts: Message[] = [];

    await retryRichMessageMedia({
      message: failedMessage,
      attachmentId: 'image-1',
      character,
      characters: [character, subjectCharacter],
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    const queued = upserts[0]?.metadata?.attachments?.[0];
    expect(queued).toMatchObject({
      status: 'queued',
      slotId: 'cover-slot',
      promptText: '把参考图里的标题放大 20%，其余构图保持不变。',
      altText: '标题放大后的海报',
      caption: '海报修改稿',
      semanticSummary: '上一版标题偏小。',
      aspectRatio: '4:5',
      imageSize: '2K',
      targetArtifactId: 'artifact-image-1',
      targetImageIds: ['message-old:image-old'],
      referenceImageIds: ['message-ref:image-ref'],
      styleImageIds: ['message-style:image-style'],
      referenceCharacterIds: ['hui'],
      referenceImages: [{ url: 'data:image/png;base64,old', mimeType: 'image/png', label: '上一版图片' }],
      error: undefined,
      assetId: undefined,
      url: undefined,
      thumbnailAssetId: undefined,
      width: undefined,
      height: undefined,
      sizeBytes: undefined,
      checksum: undefined,
    });
    await waitForExpectation(() => {
      expect(generateImageWithAdapter).toHaveBeenCalledWith(expect.objectContaining({
        prompt: '把参考图里的标题放大 20%，其余构图保持不变。',
        aspectRatio: '4:5',
        imageSize: '2K',
        referenceImages: [{ url: 'data:image/png;base64,old', mimeType: 'image/png', label: '上一版图片' }],
        characters: [subjectCharacter],
      }));
      expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
        status: 'ready',
        url: 'data:image/png;base64,retry-inputs',
      });
    });
  });

  it('keeps queued retries behind the current generating attachment', async () => {
    const first = deferred<Array<{ dataUrl: string; mimeType: string }>>();
    const second = deferred<Array<{ dataUrl: string; mimeType: string }>>();
    vi.mocked(generateImageWithAdapter)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const upserts: Message[] = [];
    const message = buildQueuedImageMessage({
      metadata: {
        attachments: [
          {
            id: 'image-1',
            kind: 'image',
            status: 'queued',
            promptText: '第一张图',
            altText: '第一张图',
            createdAt: 123,
            updatedAt: 123,
          },
          {
            id: 'image-2',
            kind: 'image',
            status: 'queued',
            promptText: '第二张图',
            altText: '第二张图',
            createdAt: 124,
            updatedAt: 124,
          },
        ],
      },
    });

    const firstRun = processRichMessageMedia({
      message,
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (next) => upserts.push(next),
    });

    expect(upserts.at(-1)?.metadata?.attachments?.[0]?.id).toBe('image-1');
    expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('generating');

    await retryRichMessageMedia({
      message: upserts.at(-1) as Message,
      attachmentId: 'image-2',
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (next) => upserts.push(next),
    });

    expect(upserts.at(-1)?.metadata?.attachments?.map((attachment) => `${attachment.id}:${attachment.status}`)).toEqual([
      'image-1:generating',
      'image-2:queued',
    ]);

    first.resolve([{ dataUrl: 'data:image/png;base64,first', mimeType: 'image/png' }]);
    await waitForExpectation(() => {
      expect(upserts.at(-1)?.metadata?.attachments?.[1]?.status).toBe('generating');
      const generatingCount = upserts.at(-1)?.metadata?.attachments?.filter((attachment) => attachment.status === 'generating').length;
      expect(generatingCount).toBe(1);
    });

    second.resolve([{ dataUrl: 'data:image/png;base64,second', mimeType: 'image/png' }]);
    await firstRun;

    expect(upserts.at(-1)?.metadata?.attachments?.[1]).toMatchObject({
      status: 'ready',
      url: 'data:image/png;base64,second',
    });
  });

  it('serializes media generation across different assistant messages with one global queue', async () => {
    const first = deferred<Array<{ dataUrl: string; mimeType: string }>>();
    const second = deferred<Array<{ dataUrl: string; mimeType: string }>>();
    vi.mocked(generateImageWithAdapter)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const firstUpserts: Message[] = [];
    const secondUpserts: Message[] = [];
    const firstRun = processRichMessageMedia({
      message: buildQueuedImageMessage({ id: 'message-first' }),
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => firstUpserts.push(message),
    });
    const secondRun = processRichMessageMedia({
      message: buildQueuedImageMessage({ id: 'message-second' }),
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => secondUpserts.push(message),
    });

    await waitForExpectation(() => {
      expect(firstUpserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('generating');
      expect(secondUpserts).toHaveLength(0);
      expect(getRichMediaQueueSnapshot()).toEqual([
        expect.objectContaining({ messageId: 'message-first', attachmentId: 'image-1', status: 'generating', position: 1, total: 2 }),
        expect.objectContaining({ messageId: 'message-second', attachmentId: 'image-1', status: 'queued', position: 2, total: 2 }),
      ]);
    });

    first.resolve([{ dataUrl: 'data:image/png;base64,first-global', mimeType: 'image/png' }]);
    await waitForExpectation(() => {
      expect(firstUpserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('ready');
      expect(secondUpserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('generating');
      expect(getRichMediaQueueSnapshot()).toEqual([
        expect.objectContaining({ messageId: 'message-second', attachmentId: 'image-1', status: 'generating', position: 1, total: 1 }),
      ]);
    });

    second.resolve([{ dataUrl: 'data:image/png;base64,second-global', mimeType: 'image/png' }]);
    await Promise.all([firstRun, secondRun]);

    expect(secondUpserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready',
      url: 'data:image/png;base64,second-global',
    });
  });

  it('recovers a stale generating attachment into the global queue', async () => {
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{
      dataUrl: 'data:image/png;base64,recovered',
      mimeType: 'image/png',
    }]);
    const staleMessage = buildQueuedImageMessage({
      id: 'message-stale-generating',
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'generating',
          generationJobId: 'stale-job',
          promptText: '恢复中的番茄炒蛋',
          altText: '恢复中的番茄炒蛋',
          createdAt: 123,
          updatedAt: 456,
        }],
      },
    });
    const upserts: Message[] = [];

    const run = processRichMessageMedia({
      message: staleMessage,
      character,
      aiProfiles: [imageProfile],
      upsertMessage: (message) => upserts.push(message),
    });

    await waitForExpectation(() => {
      expect(getRichMediaQueueSnapshot()).toEqual([
        expect.objectContaining({ messageId: 'message-stale-generating', attachmentId: 'image-1', status: 'generating', position: 1, total: 1 }),
      ]);
    });
    await run;

    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready',
      url: 'data:image/png;base64,recovered',
    });
  });
});
