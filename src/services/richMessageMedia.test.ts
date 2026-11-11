import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';
import type { AIModelProfile } from '../types/settings';
import { getRecentRichMediaGenerationErrors, getRichMediaQueueSnapshot, processRichMessageMedia, resetRichMediaQueueForTests, retryRichMessageMedia, scrubLocalMediaUrlsForCloud, subscribeRichMediaQueue } from './richMessageMedia';
import { generateAudioWithAdapter, generateImageWithAdapter, generateVideoWithAdapter } from './aiGenerationAdapter';
import { waitForAiMediaTask } from './aiClient';
import { api, ApiError } from './api';
import { runWithChatExecutionLease } from './chatExecutionLease';

vi.mock('./chatExecutionLease', () => ({ runWithChatExecutionLease: vi.fn(async (_chatId: string, work: () => Promise<void>) => work()) }));

vi.mock('./api', () => ({
  ApiError: class ApiError extends Error { status: number; constructor(message: string, options: { status: number }) { super(message); this.status = options.status; } },
  api: {
    createMediaAsset: vi.fn(),
    createMediaAssetFromAiTask: vi.fn(),
    downloadAiMediaTaskContent: vi.fn(),
    getAiMediaTask: vi.fn(),
    getAiMediaTaskByRequestKey: vi.fn(),
    updateMessageMetadata: vi.fn(),
    searchDoutu: vi.fn(),
  },
}));

vi.mock('./aiGenerationAdapter', () => ({
  generateImageWithAdapter: vi.fn(),
  generateVideoWithAdapter: vi.fn(),
  generateAudioWithAdapter: vi.fn(),
  synthesizeSpeechWithAdapter: vi.fn(),
}));
vi.mock('./aiClient', () => ({
  waitForAiMediaTask: vi.fn(),
  extractAiMediaResultUrl: vi.fn(() => 'data:video/mp4;base64,AAAA'),
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
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => Promise<void>) => work() } });
    Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true });
    vi.clearAllMocks();
    resetRichMediaQueueForTests();
    localStorage.clear();
    chatStoreState.chats = [];
    artifactStoreState.createImageArtifactFromAttachment.mockReset();
    vi.mocked(api.updateMessageMetadata).mockResolvedValue({});
    vi.mocked(api.getAiMediaTaskByRequestKey).mockRejectedValue(new ApiError('任务不存在', { status: 404 }));
  });

  it.each([false, true])('polls video tasks and stores the playable result (resume: %s)', async (resume) => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const pending = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(waitForAiMediaTask).mockReturnValue(pending.promise);
    vi.mocked(generateVideoWithAdapter).mockResolvedValue({ task_id: 'video-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    vi.mocked(api.createMediaAssetFromAiTask).mockResolvedValue({ id: 'video-asset', url: 'https://example.test/video.mp4', mimeType: 'video/mp4', sizeBytes: 123 } as Awaited<ReturnType<typeof api.createMediaAssetFromAiTask>>);
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: resume ? 'generating' : 'queued',
      altText: '追逐短片',
      mediaTaskId: resume ? 'video-task' : undefined,
      promptText: resume ? undefined : '追逐场景', videoDuration: 8, videoResolution: '720p', aspectRatio: '16:9',
      createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message,
      aiProfiles: resume ? [] : [{ ...imageProfile, type: 'video', model: 'video-model' }],
      upsertMessage: (next) => upserts.push(next),
    });
    await waitForExpectation(() => expect(waitForAiMediaTask).toHaveBeenCalledWith('video-task'));
    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'generating', mediaTaskId: 'video-task' });
    if (resume) expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    else expect(generateVideoWithAdapter).toHaveBeenCalledWith(expect.objectContaining({ prompt: '追逐场景', duration: 8, resolution: '720p', aspectRatio: '16:9' }));
    pending.resolve({ task_id: 'video-task', model: 'video-model', status: 'succeeded', result: {}, chargedAmount: 1, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'ready', assetId: 'video-asset', url: 'https://example.test/video.mp4', mediaTaskId: undefined }));
  });

  it('waits for the conversation lock and acquires a lease before submitting a cloud video', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const events: string[] = [];
    let unlock!: () => void;
    const lockGate = new Promise<void>((resolve) => { unlock = resolve; });
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => Promise<void>) => {
      events.push('wait-lock');
      await lockGate;
      events.push('locked');
      return work();
    } } });
    vi.mocked(runWithChatExecutionLease).mockImplementationOnce(async (_chatId, work) => {
      events.push('leased');
      return work();
    });
    vi.mocked(generateVideoWithAdapter).mockImplementationOnce(async () => {
      events.push('submit');
      return { task_id: 'leased-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>;
    });
    const pending = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(waitForAiMediaTask).mockReturnValue(pending.promise);
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'queued', promptText: '森林追逐', altText: '短片', createdAt: 123, updatedAt: 123,
    }] } });
    const processing = processRichMessageMedia({ message, aiProfiles: [{ ...imageProfile, type: 'video', model: 'video-model' }], upsertMessage: vi.fn() });
    await waitForExpectation(() => expect(events).toContain('wait-lock'));
    expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    unlock();
    await waitForExpectation(() => expect(events).toContain('submit'));
    expect(events).toEqual(['wait-lock', 'locked', 'leased', 'submit']);
    await processing;
    pending.resolve({ task_id: 'leased-task', model: 'video-model', status: 'failed', result: { error: '测试结束' },
      chargedAmount: 0, reservedAmount: 0, createdAt: 1, updatedAt: 2 });
  });

  it('resumes an accepted video task when metadata writes are unavailable', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    vi.mocked(api.updateMessageMetadata).mockRejectedValue(new Error('network unavailable'));
    const pending = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(waitForAiMediaTask).mockReturnValue(pending.promise);
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', mediaTaskId: 'accepted-task',
      generationJobId: 'media-gen-accepted', altText: '视频', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage: (next) => upserts.push(next) });
    expect(waitForAiMediaTask).toHaveBeenCalledWith('accepted-task');
    expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('generating');
    pending.resolve({ task_id: 'accepted-task', model: 'video-model', status: 'failed', result: { error: 'ACE 任务生成失败：任务已取消' }, chargedAmount: 0, reservedAmount: 0, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('failed'));
  });

  it('keeps an accepted video pending when polling fails due to a temporary network error', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    vi.mocked(waitForAiMediaTask).mockRejectedValueOnce(new ApiError('网络暂时不可用', { status: 503 }));
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', mediaTaskId: 'accepted-task', generationJobId: 'media-gen-accepted',
      altText: '短片', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    const notify = vi.fn();
    const unsubscribe = subscribeRichMediaQueue(notify);
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage: (next) => upserts.push(next) });
    await waitForExpectation(() => expect(waitForAiMediaTask).toHaveBeenCalledWith('accepted-task'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'generating', mediaTaskId: 'accepted-task' });
    expect(upserts.at(-1)?.metadata?.attachments?.[0]?.error).toBe('网络暂时不可用');
    expect(getRecentRichMediaGenerationErrors()).toEqual(expect.arrayContaining([expect.objectContaining({ message: '网络暂时不可用' })]));
    expect(notify).toHaveBeenCalled();
    unsubscribe();
  });

  it('waits for a fresh lease before committing a completed cloud video', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    let unlock!: () => void;
    const lockGate = new Promise<void>((resolve) => { unlock = resolve; });
    const lockRequest = vi.fn(async (_name: string, work: () => Promise<void>) => {
      await lockGate;
      return work();
    });
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });
    vi.mocked(waitForAiMediaTask).mockResolvedValue({ task_id: 'completed-task', model: 'video-model', status: 'succeeded',
      result: {}, chargedAmount: 1, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    vi.mocked(api.createMediaAssetFromAiTask).mockResolvedValue({ id: 'saved-video', url: '/media/saved-video',
      mimeType: 'video/mp4', sizeBytes: 100 } as Awaited<ReturnType<typeof api.createMediaAssetFromAiTask>>);
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', mediaTaskId: 'completed-task', generationJobId: 'saved-job',
      altText: '短片', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    const processing = processRichMessageMedia({ message, aiProfiles: [], upsertMessage: (next) => upserts.push(next) });
    await waitForExpectation(() => expect(lockRequest).toHaveBeenCalled());
    expect(api.createMediaAssetFromAiTask).not.toHaveBeenCalled();
    unlock();
    await processing;
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('ready'));
    expect(runWithChatExecutionLease).toHaveBeenCalledWith('chat-1', expect.any(Function));
  });

  it('resumes music by saved request key after its model configuration is removed', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    vi.mocked(api.getAiMediaTaskByRequestKey).mockResolvedValue({ task_id: 'saved-music', model: 'old-audio-model', status: 'running',
      result: null, chargedAmount: null, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    const pending = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(waitForAiMediaTask).mockReturnValue(pending.promise);
    const message = buildQueuedImageMessage({ serverId: 'server-music', metadata: { attachments: [{
      id: 'music-1', kind: 'audio', audioPurpose: 'music_generation', status: 'generating',
      generationJobId: 'media-gen-music', altText: '歌曲', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage: (next) => upserts.push(next) });
    await waitForExpectation(() => expect(waitForAiMediaTask).toHaveBeenCalledWith('saved-music'));
    expect(generateAudioWithAdapter).not.toHaveBeenCalled();
    pending.resolve({ task_id: 'saved-music', model: 'old-audio-model', status: 'failed', result: { error: '上游任务失败' },
      chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 3 });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('failed'));
  });

  it('uses the submitted video ratio for the waiting card', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const pending = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(waitForAiMediaTask).mockReturnValue(pending.promise);
    vi.mocked(generateVideoWithAdapter).mockResolvedValue({ task_id: 'video-ratio', aspectRatio: '9:16' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'queued', altText: '视频', promptText: '森林追逐', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message, aiProfiles: [{ ...imageProfile, type: 'video', model: 'MiniMax-H3' }], upsertMessage: (next) => upserts.push(next) });
    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'generating', aspectRatio: '9:16' });
    pending.resolve({ task_id: 'video-ratio', model: 'MiniMax-H3', status: 'failed', result: {}, chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('failed'));
  });

  it('saves the video request key before submitting an upstream generation', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const persisted = deferred<Awaited<ReturnType<typeof api.updateMessageMetadata>>>();
    vi.mocked(api.updateMessageMetadata).mockReturnValueOnce(persisted.promise);
    vi.mocked(generateVideoWithAdapter).mockResolvedValue({ task_id: 'ordered-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    vi.mocked(waitForAiMediaTask).mockReturnValue(new Promise(() => {}));
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'queued', altText: '视频', promptText: '森林追逐', createdAt: 123, updatedAt: 123,
    }] } });
    const processing = processRichMessageMedia({ message, aiProfiles: [{ ...imageProfile, type: 'video', model: 'MiniMax-H3' }], upsertMessage: () => {} });
    await waitForExpectation(() => expect(api.updateMessageMetadata).toHaveBeenCalledOnce());
    expect(api.updateMessageMetadata).toHaveBeenCalledOnce();
    expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    persisted.resolve({});
    await processing;
    await waitForExpectation(() => expect(generateVideoWithAdapter).toHaveBeenCalledOnce());
    const savedMetadata = vi.mocked(api.updateMessageMetadata).mock.calls[0][1] as Message['metadata'];
    expect(savedMetadata?.attachments?.[0]).toMatchObject({ status: 'generating', generationJobId: expect.stringMatching(/^media-gen-/) });
    expect(vi.mocked(generateVideoWithAdapter).mock.calls[0][0].clientRequestKey).toBe(savedMetadata?.attachments?.[0]?.generationJobId);
  });

  it('keeps one video poll and avoids repeated metadata writes while the chat reprocesses a generating task', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const pending = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(waitForAiMediaTask).mockReturnValue(pending.promise);
    vi.mocked(generateVideoWithAdapter).mockResolvedValue({ task_id: 'video-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    vi.mocked(api.createMediaAssetFromAiTask).mockResolvedValue({ id: 'video-asset', url: 'https://example.test/video.mp4', mimeType: 'video/mp4', sizeBytes: 123 } as Awaited<ReturnType<typeof api.createMediaAssetFromAiTask>>);
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'queued', altText: '追逐短片', promptText: '追逐场景', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    const params = { aiProfiles: [{ ...imageProfile, type: 'video' as const, model: 'video-model' }], upsertMessage: (next: Message) => upserts.push(next) };
    await processRichMessageMedia({ ...params, message });
    await waitForExpectation(() => expect(waitForAiMediaTask).toHaveBeenCalledTimes(1));
    const metadataWrites = vi.mocked(api.updateMessageMetadata).mock.calls.length;
    const generating = upserts.at(-1)!;
    for (let index = 0; index < 10; index += 1) {
      await processRichMessageMedia({ ...params, message: generating });
    }
    expect(waitForAiMediaTask).toHaveBeenCalledTimes(1);
    expect(generateVideoWithAdapter).toHaveBeenCalledTimes(1);
    expect(api.updateMessageMetadata).toHaveBeenCalledTimes(metadataWrites);
    pending.resolve({ task_id: 'video-task', model: 'video-model', status: 'succeeded', result: {}, chargedAmount: 1, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('ready'));
  });

  it('persists the server video failure reason on the attachment', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    vi.mocked(waitForAiMediaTask).mockResolvedValue({
      task_id: 'video-task', model: 'video-model', status: 'failed',
      result: { error: 'ACE 任务生成失败：上游返回 HTTP 400，错误码 INVALID_DURATION' },
      chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 2,
    });
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', altText: '追逐短片',
      mediaTaskId: 'video-task', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage: (next) => upserts.push(next) });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'failed', error: 'ACE 任务生成失败：上游返回 HTTP 400，错误码 INVALID_DURATION',
    }));
    await waitForExpectation(() => expect(api.updateMessageMetadata).toHaveBeenCalledWith('server-video', expect.objectContaining({
      attachments: [expect.objectContaining({ status: 'failed', error: 'ACE 任务生成失败：上游返回 HTTP 400，错误码 INVALID_DURATION' })],
    }), 'chat-1'));
  });

  it('shows the ACE upstream balance reason on a failed video placeholder', async () => {
    vi.mocked(waitForAiMediaTask).mockResolvedValue({
      task_id: 'video-task', model: 'MiniMax-H3', status: 'failed',
      result: { error: 'ACE 任务生成失败：ACE 请求失败 (403)：ACE 上游可用余额不足，错误码 used_up' },
      chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 2,
    });
    const message = buildQueuedImageMessage({ metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', mediaTaskId: 'video-task', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage: (next) => upserts.push(next) });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'failed', error: 'ACE 任务生成失败：ACE 请求失败 (403)：ACE 上游可用余额不足，错误码 used_up',
    }));
  });

  it('shows the ACE submission rejection on a failed video placeholder', async () => {
    vi.mocked(generateVideoWithAdapter).mockRejectedValue(new Error('ACE 请求失败 (403)：ACE 上游可用余额不足，错误码 used_up'));
    const message = buildQueuedImageMessage({ metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'queued', promptText: '追逐场景', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message, aiProfiles: [{ ...imageProfile, type: 'video', model: 'MiniMax-H3' }], upsertMessage: (next) => upserts.push(next) });
    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'failed', error: 'ACE 请求失败 (403)：ACE 上游可用余额不足，错误码 used_up',
    });
  });

  it('recovers a submitted video by request key without submitting or charging again', async () => {
    vi.mocked(api.getAiMediaTaskByRequestKey).mockResolvedValue({ task_id: 'saved-task', model: 'MiniMax-H3', status: 'running', result: null,
      chargedAmount: null, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    vi.mocked(waitForAiMediaTask).mockResolvedValue({ task_id: 'saved-task', model: 'MiniMax-H3', status: 'failed', result: { error: '上游任务失败' },
      chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 3 });
    const message = buildQueuedImageMessage({ metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', generationJobId: 'media-gen-recovery', promptText: '追逐场景', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage: (next) => upserts.push(next) });
    expect(api.getAiMediaTaskByRequestKey).toHaveBeenCalledWith('media-gen-recovery');
    expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    expect(upserts.some((item) => item.metadata?.attachments?.[0]?.mediaTaskId === 'saved-task')).toBe(true);
  });

  it('writes a concrete image failure after the generating metadata update completes', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const firstWrite = deferred<Record<string, unknown>>();
    vi.mocked(api.updateMessageMetadata).mockReturnValueOnce(firstWrite.promise);
    vi.mocked(generateImageWithAdapter).mockRejectedValue(new Error('图片供应商请求限流，请稍后重试。'));
    const upserts: Message[] = [];
    const processing = processRichMessageMedia({
      message: buildQueuedImageMessage({ serverId: 'server-image' }),
      aiProfiles: [imageProfile], upsertMessage: (next) => upserts.push(next),
    });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'failed' }));
    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'failed', error: '图片供应商请求限流，请稍后重试。' });
    expect(api.updateMessageMetadata).toHaveBeenCalledTimes(1);
    firstWrite.resolve({});
    await processing;
    await waitForExpectation(() => expect(api.updateMessageMetadata).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.updateMessageMetadata).mock.calls[1]?.[1]).toMatchObject({
      attachments: [expect.objectContaining({ status: 'failed', error: '图片供应商请求限流，请稍后重试。' })],
    });
  });

  it('writes the latest combined attachments after a prior cloud metadata write releases', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const firstWrite = deferred<Record<string, unknown>>();
    const imageGate = deferred<Array<{ dataUrl: string; mimeType: string }>>();
    const videoGate = deferred<Awaited<ReturnType<typeof generateVideoWithAdapter>>>();
    const pollGate = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(api.updateMessageMetadata).mockReturnValueOnce(firstWrite.promise);
    vi.mocked(api.createMediaAsset).mockResolvedValue({ id: 'mixed-image-asset', url: '/uploads/mixed-image.png', mimeType: 'image/png', sizeBytes: 20 } as Awaited<ReturnType<typeof api.createMediaAsset>>);
    vi.mocked(generateImageWithAdapter).mockReturnValue(imageGate.promise);
    vi.mocked(generateVideoWithAdapter).mockReturnValue(videoGate.promise);
    vi.mocked(waitForAiMediaTask).mockReturnValue(pollGate.promise);
    const message = buildQueuedImageMessage({ id: 'cloud-mixed', serverId: 'server-cloud-mixed', metadata: { attachments: [
      { id: 'image-1', kind: 'image', status: 'queued', promptText: '场景图', altText: '图片', createdAt: 123, updatedAt: 123 },
      { id: 'video-1', kind: 'video', status: 'queued', promptText: '森林追逐', altText: '视频', createdAt: 123, updatedAt: 123 },
    ] } });
    const run = processRichMessageMedia({ message,
      aiProfiles: [imageProfile, { ...imageProfile, type: 'video', model: 'video-model' }], upsertMessage: () => undefined });
    await waitForExpectation(() => expect(api.updateMessageMetadata).toHaveBeenCalledTimes(1));
    imageGate.resolve([{ dataUrl: 'data:image/png;base64,cloud-mixed', mimeType: 'image/png' }]);
    await waitForExpectation(() => expect(api.updateMessageMetadata).toHaveBeenCalledTimes(1));
    firstWrite.resolve({});
    await waitForExpectation(() => {
      expect(vi.mocked(api.updateMessageMetadata).mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [, metadata] of vi.mocked(api.updateMessageMetadata).mock.calls.slice(1)) {
        expect((metadata as Message['metadata'])?.attachments).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'image-1', status: 'ready' }),
          expect.objectContaining({ id: 'video-1', status: 'generating' }),
        ]));
      }
    });
    videoGate.resolve({ task_id: 'cloud-mixed-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    await run;
    pollGate.resolve({ task_id: 'cloud-mixed-task', model: 'video-model', status: 'failed', result: { error: '测试结束' },
      chargedAmount: 0, reservedAmount: 0, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(getRichMediaQueueSnapshot()).toEqual([]));
  });

  it('searches stickers without a model profile and preserves the keyword on retry', async () => {
    vi.mocked(api.searchDoutu)
      .mockRejectedValueOnce(new Error('搜索暂时失败'))
      .mockResolvedValueOnce({ keyword: '开心', imageUrl: 'https://example.test/happy.gif', pointCost: 1, balanceAfter: 9 });
    const message = buildQueuedImageMessage({ metadata: { attachments: [{
      id: 'sticker-1', kind: 'sticker', status: 'queued', promptText: '开心',
      altText: '开心地笑', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    const upsertMessage = (next: Message) => upserts.push(next);
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage });
    const failed = upserts.at(-1)!;
    expect(failed.metadata?.attachments?.[0].status).toBe('failed');
    await retryRichMessageMedia({ message: failed, attachmentId: 'sticker-1', aiProfiles: [], upsertMessage });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready', url: 'https://example.test/happy.gif', promptText: '开心',
    }));
    expect(api.searchDoutu).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(api.searchDoutu).mock.calls) expect(call[0]).toBe('开心');
  });

  it('searches again when a ready sticker URL fails to load in the browser', async () => {
    vi.mocked(api.searchDoutu).mockResolvedValue({ keyword: '开心', imageUrl: 'https://example.test/recovered.gif', pointCost: 1, balanceAfter: 9 });
    const message = buildQueuedImageMessage({ metadata: { attachments: [{
      id: 'sticker-broken', kind: 'sticker', status: 'ready', promptText: '开心',
      altText: '开心地笑', url: 'https://example.test/missing.gif', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    await retryRichMessageMedia({ message, attachmentId: 'sticker-broken', aiProfiles: [], upsertMessage: next => upserts.push(next) });
    expect(upserts[0].metadata?.attachments?.[0]).toMatchObject({ status: 'queued', url: undefined });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'ready', url: 'https://example.test/recovered.gif' }));
    expect(api.searchDoutu).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.searchDoutu).mock.calls[0][0]).toBe('开心');
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

  it('submits a new video task on retry instead of polling the failed task again', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const submitted = deferred<Awaited<ReturnType<typeof generateVideoWithAdapter>>>();
    const polled = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(generateVideoWithAdapter).mockReturnValue(submitted.promise);
    vi.mocked(waitForAiMediaTask).mockReturnValue(polled.promise);
    vi.mocked(api.getAiMediaTask).mockResolvedValue({ task_id: 'old-failed-task', model: 'video-model', status: 'failed', result: {}, chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    const failedMessage = buildQueuedImageMessage({ serverId: 'server-video', metadata: {
      attachments: [{ id: 'video-1', kind: 'video', status: 'failed', altText: '追逐短片',
        promptText: '恐龙追逐机器猫', mediaTaskId: 'old-failed-task', error: '上次任务失败', createdAt: 123, updatedAt: 124 }],
      generation: { status: 'failed', updatedAt: 124 },
    } });
    const upserts: Message[] = [];
    await retryRichMessageMedia({ message: failedMessage, attachmentId: 'video-1',
      aiProfiles: [{ ...imageProfile, type: 'video', model: 'video-model' }],
      upsertMessage: (next) => upserts.push(next),
    });
    expect(upserts[0]?.metadata?.attachments?.[0]).toMatchObject({ status: 'queued', mediaTaskId: undefined, error: undefined });
    await waitForExpectation(() => expect(generateVideoWithAdapter).toHaveBeenCalledTimes(1));
    await waitForExpectation(() => expect(api.updateMessageMetadata).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.updateMessageMetadata).mock.calls.map(([, metadata]) => (metadata as Message['metadata'])?.attachments?.[0]?.status)).toEqual(['queued', 'generating']);
    expect(waitForAiMediaTask).not.toHaveBeenCalled();
    submitted.resolve({ task_id: 'new-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    await waitForExpectation(() => expect(waitForAiMediaTask).toHaveBeenCalledWith('new-task'));
    expect(waitForAiMediaTask).not.toHaveBeenCalledWith('old-failed-task');
    expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'generating', mediaTaskId: 'new-task' });
    await waitForExpectation(() => expect(api.updateMessageMetadata).toHaveBeenCalledTimes(3));
    expect((vi.mocked(api.updateMessageMetadata).mock.calls[2]?.[1] as Message['metadata'])?.attachments?.[0]).toMatchObject({ status: 'generating', mediaTaskId: 'new-task' });
    polled.resolve({ task_id: 'new-task', model: 'video-model', status: 'failed', result: { error: 'ACE 任务生成失败：错误码 bad_request，视频输入参数无效' }, chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('failed'));
    expect(upserts.at(-1)?.metadata?.attachments?.[0]?.error).toContain('视频输入参数无效');
  });

  it('reuses the original request key when submission response was lost', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const polled = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(api.getAiMediaTaskByRequestKey).mockResolvedValue({ task_id: 'accepted-task', model: 'MiniMax-H3', status: 'running', result: null,
      chargedAmount: null, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
    vi.mocked(waitForAiMediaTask).mockReturnValue(polled.promise);
    const failedMessage = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'failed', promptText: '森林追逐', generationJobId: 'media-gen-original', error: '网络中断', createdAt: 123, updatedAt: 124,
    }] } });
    const upserts: Message[] = [];
    await retryRichMessageMedia({ message: failedMessage, attachmentId: 'video-1', aiProfiles: [{ ...imageProfile, type: 'video', model: 'MiniMax-H3' }], upsertMessage: (next) => upserts.push(next) });
    await waitForExpectation(() => expect(api.getAiMediaTaskByRequestKey).toHaveBeenCalledWith('media-gen-original'));
    await waitForExpectation(() => expect(waitForAiMediaTask).toHaveBeenCalledWith('accepted-task'));
    expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    expect(upserts.at(-1)?.metadata?.attachments?.[0]?.generationJobId).toBe('media-gen-original');
    polled.resolve({ task_id: 'accepted-task', model: 'MiniMax-H3', status: 'failed', result: { error: '上游失败' }, chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 3 });
  });

  it('reuses a successful video task when saving its file fails', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const completedTask = { task_id: 'completed-video', model: 'MiniMax-H3', status: 'succeeded' as const, result: { data: { url: 'https://example.test/video.mp4' } }, chargedAmount: 1, reservedAmount: 1, createdAt: 1, updatedAt: 2 };
    vi.mocked(waitForAiMediaTask).mockResolvedValue(completedTask);
    vi.mocked(api.getAiMediaTask).mockResolvedValue(completedTask);
    vi.mocked(api.createMediaAssetFromAiTask)
      .mockRejectedValueOnce(new Error('网络请求失败'))
      .mockResolvedValueOnce({ id: 'saved-video', url: '/media/saved-video', mimeType: 'video/mp4', sizeBytes: 18_000_000 });
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', mediaTaskId: 'completed-video', promptText: '追逐场景', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    const upsertMessage = (next: Message) => upserts.push(next);
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'failed', mediaTaskId: 'completed-video' }));
    expect(upserts.at(-1)?.metadata?.attachments?.[0]?.error).toContain('视频已生成，但文件获取或保存失败');
    await retryRichMessageMedia({ message: upserts.at(-1)!, attachmentId: 'video-1', aiProfiles: [], upsertMessage });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.[0]).toMatchObject({ status: 'ready', assetId: 'saved-video' }));
    expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    expect(api.createMediaAssetFromAiTask).toHaveBeenCalledTimes(2);
    expect(api.createMediaAssetFromAiTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'completed-video' }));
  });

  it('does not reset an accepted video while its task ID is already being polled', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const polled = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(waitForAiMediaTask).mockReturnValue(polled.promise);
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', mediaTaskId: 'accepted-task',
      generationJobId: 'media-gen-original', promptText: '追逐场景', createdAt: 123, updatedAt: 123,
    }] } });
    const upserts: Message[] = [];
    const upsertMessage = (next: Message) => upserts.push(next);
    await processRichMessageMedia({ message, aiProfiles: [], upsertMessage });
    await waitForExpectation(() => expect(waitForAiMediaTask).toHaveBeenCalledWith('accepted-task'));
    const count = upserts.length;
    await retryRichMessageMedia({ message: upserts.at(-1)!, attachmentId: 'video-1', aiProfiles: [], upsertMessage });
    expect(upserts).toHaveLength(count);
    expect(api.getAiMediaTask).not.toHaveBeenCalled();
    expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    polled.resolve({ task_id: 'accepted-task', model: 'MiniMax-H3', status: 'failed', result: { error: '上游失败' },
      chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
  });

  it('checks a saved generating task directly without a separate status request', async () => {
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    localStorage.setItem('pneumata-cloud-sync-enabled', '1');
    const polled = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(waitForAiMediaTask).mockReturnValue(polled.promise);
    const message = buildQueuedImageMessage({ serverId: 'server-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'generating', mediaTaskId: 'accepted-task',
      generationJobId: 'media-gen-original', promptText: '追逐场景', createdAt: 123, updatedAt: 123,
    }] } });
    await retryRichMessageMedia({ message, attachmentId: 'video-1', aiProfiles: [], upsertMessage: vi.fn() });
    await waitForExpectation(() => expect(waitForAiMediaTask).toHaveBeenCalledWith('accepted-task'));
    expect(api.getAiMediaTask).not.toHaveBeenCalled();
    expect(generateVideoWithAdapter).not.toHaveBeenCalled();
    polled.resolve({ task_id: 'accepted-task', model: 'MiniMax-H3', status: 'failed', result: { error: '上游失败' },
      chargedAmount: 0, reservedAmount: 1, createdAt: 1, updatedAt: 2 });
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

  it('starts video submission while an image is still generating', async () => {
    const imageGate = deferred<Array<{ dataUrl: string; mimeType: string }>>();
    const videoGate = deferred<Awaited<ReturnType<typeof generateVideoWithAdapter>>>();
    const pollGate = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(generateImageWithAdapter).mockReturnValue(imageGate.promise);
    vi.mocked(generateVideoWithAdapter).mockReturnValue(videoGate.promise);
    vi.mocked(waitForAiMediaTask).mockReturnValue(pollGate.promise);
    const imageUpserts: Message[] = [];
    const videoUpserts: Message[] = [];
    const imageRun = processRichMessageMedia({ message: buildQueuedImageMessage({ id: 'parallel-image' }),
      character, aiProfiles: [imageProfile], upsertMessage: (next) => imageUpserts.push(next) });
    const videoRun = processRichMessageMedia({ message: buildQueuedImageMessage({ id: 'parallel-video', metadata: { attachments: [{
      id: 'video-1', kind: 'video', status: 'queued', promptText: '森林追逐', altText: '视频', createdAt: 123, updatedAt: 123,
    }] } }), aiProfiles: [{ ...imageProfile, type: 'video', model: 'video-model' }],
    upsertMessage: (next) => videoUpserts.push(next) });

    await waitForExpectation(() => {
      expect(generateImageWithAdapter).toHaveBeenCalledTimes(1);
      expect(generateVideoWithAdapter).toHaveBeenCalledTimes(1);
      expect(imageUpserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('generating');
      expect(videoUpserts.at(-1)?.metadata?.attachments?.[0]?.status).toBe('generating');
      expect(getRichMediaQueueSnapshot()).toEqual(expect.arrayContaining([
        expect.objectContaining({ lane: 'image', position: 1, total: 1 }),
        expect.objectContaining({ lane: 'video', position: 1, total: 1 }),
      ]));
    });
    videoGate.resolve({ task_id: 'parallel-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    await videoRun;
    imageGate.resolve([{ dataUrl: 'data:image/png;base64,parallel', mimeType: 'image/png' }]);
    await imageRun;
    pollGate.resolve({ task_id: 'parallel-task', model: 'video-model', status: 'failed', result: { error: '测试结束' },
      chargedAmount: 0, reservedAmount: 0, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(getRichMediaQueueSnapshot()).toEqual([]));
  });

  it('keeps both results when image and video on one message finish in different lanes', async () => {
    const imageGate = deferred<Array<{ dataUrl: string; mimeType: string }>>();
    const videoGate = deferred<Awaited<ReturnType<typeof generateVideoWithAdapter>>>();
    const pollGate = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(generateImageWithAdapter).mockReturnValue(imageGate.promise);
    vi.mocked(generateVideoWithAdapter).mockReturnValue(videoGate.promise);
    vi.mocked(waitForAiMediaTask).mockReturnValue(pollGate.promise);
    const message = buildQueuedImageMessage({ id: 'mixed-message', metadata: { attachments: [
      { id: 'image-1', kind: 'image', status: 'queued', promptText: '场景图', altText: '图片', createdAt: 123, updatedAt: 123 },
      { id: 'video-1', kind: 'video', status: 'queued', promptText: '森林追逐', altText: '视频', createdAt: 123, updatedAt: 123 },
    ] } });
    const upserts: Message[] = [];
    const run = processRichMessageMedia({ message, aiProfiles: [imageProfile, { ...imageProfile, type: 'video', model: 'video-model' }],
      upsertMessage: (next) => upserts.push(next) });
    await waitForExpectation(() => {
      expect(generateImageWithAdapter).toHaveBeenCalledTimes(1);
      expect(generateVideoWithAdapter).toHaveBeenCalledTimes(1);
    });
    videoGate.resolve({ task_id: 'mixed-video-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    imageGate.resolve([{ dataUrl: 'data:image/png;base64,mixed', mimeType: 'image/png' }]);
    await run;
    expect(upserts.at(-1)?.metadata?.attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'image-1', status: 'ready' }),
      expect.objectContaining({ id: 'video-1', status: 'generating', mediaTaskId: 'mixed-video-task' }),
    ]));
    pollGate.resolve({ task_id: 'mixed-video-task', model: 'video-model', status: 'failed', result: { error: '测试结束' },
      chargedAmount: 0, reservedAmount: 0, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(getRichMediaQueueSnapshot()).toEqual([]));
  });

  it('keeps a finished image when video polling completes after the submission queue released its message', async () => {
    const pollGate = deferred<Awaited<ReturnType<typeof waitForAiMediaTask>>>();
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{ dataUrl: 'data:image/png;base64,retained', mimeType: 'image/png' }]);
    vi.mocked(generateVideoWithAdapter).mockResolvedValue({ task_id: 'late-video-task' } as Awaited<ReturnType<typeof generateVideoWithAdapter>>);
    vi.mocked(waitForAiMediaTask).mockReturnValue(pollGate.promise);
    const message = buildQueuedImageMessage({ id: 'late-video-message', metadata: { attachments: [
      { id: 'image-1', kind: 'image', status: 'queued', promptText: '场景图', altText: '图片', createdAt: 123, updatedAt: 123 },
      { id: 'video-1', kind: 'video', status: 'queued', promptText: '森林追逐', altText: '视频', createdAt: 123, updatedAt: 123 },
    ] } });
    const upserts: Message[] = [];
    await processRichMessageMedia({ message, aiProfiles: [imageProfile, { ...imageProfile, type: 'video', model: 'video-model' }],
      upsertMessage: (next) => upserts.push(next) });
    expect(upserts.at(-1)?.metadata?.attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'image-1', status: 'ready' }),
      expect.objectContaining({ id: 'video-1', status: 'generating', mediaTaskId: 'late-video-task' }),
    ]));
    pollGate.resolve({ task_id: 'late-video-task', model: 'video-model', status: 'failed', result: { error: '测试结束' },
      chargedAmount: 0, reservedAmount: 0, createdAt: 1, updatedAt: 2 });
    await waitForExpectation(() => expect(upserts.at(-1)?.metadata?.attachments?.find((item) => item.id === 'video-1')?.status).toBe('failed'));
    expect(upserts.at(-1)?.metadata?.attachments?.find((item) => item.id === 'image-1')?.status).toBe('ready');
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
