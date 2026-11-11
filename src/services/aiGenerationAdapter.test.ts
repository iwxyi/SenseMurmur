import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMAGE_AI_PROFILE } from '../types/settings';
import { api } from './api';
import { generateImageWithAdapter, generateVideoWithAdapter, resolveImageGenerationRequest, resolveVideoGenerationParameters } from './aiGenerationAdapter';
import { clearChatExecutionFence, setChatExecutionFence } from './chatExecutionFence';
import { generateResponse } from './aiClient';

describe('video generation defaults', () => {
  const profile = { ...DEFAULT_IMAGE_AI_PROFILE, type: 'video' as const };
  afterEach(() => vi.restoreAllMocks());

  it('sends resolved parameters through the asynchronous media submission', async () => {
    const membership = { vipActive: false, activeSubscription: null, latestSubscription: null, recentOrders: [] };
    vi.spyOn(api, 'getBillingMembership').mockResolvedValue({
      ...membership,
      vipEntitlement: { tierCode: 'free', entitlement: { multimediaGenerationEnabled: true } as NonNullable<Awaited<ReturnType<typeof api.getBillingMembership>>['vipEntitlement']>['entitlement'] },
    });
    const submit = vi.spyOn(api, 'generateAiMedia').mockResolvedValue({
      task_id: 'task-test', model: profile.model, status: 'running', result: null,
      chargedAmount: null, reservedAmount: 0, createdAt: 0, updatedAt: 0,
    });
    await generateVideoWithAdapter({ profile: { ...profile, videoDefaults: { aspectRatio: '9:16', resolution: '1080p', duration: 6 } }, prompt: 'tea', duration: 4 });
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ async: true, aspect_ratio: '9:16', resolution: '1080p', duration: 4 }));
    await generateVideoWithAdapter({ profile, prompt: 'tea' });
    expect(submit.mock.calls[1][0]).not.toHaveProperty('resolution');
    expect(submit.mock.calls[1][0]).not.toHaveProperty('aspect_ratio');
    expect(submit.mock.calls[1][0]).not.toHaveProperty('duration');
  });

  it('sends the active chat fence with a team video task', async () => {
    const fence = { ownerId: 'owner-current-123456', generation: 8 };
    setChatExecutionFence('chat-test', fence);
    const membership = { vipActive: false, activeSubscription: null, latestSubscription: null, recentOrders: [] };
    vi.spyOn(api, 'getBillingMembership').mockResolvedValue({
      ...membership,
      vipEntitlement: { tierCode: 'free', entitlement: { multimediaGenerationEnabled: true } as NonNullable<Awaited<ReturnType<typeof api.getBillingMembership>>['vipEntitlement']>['entitlement'] },
    });
    const submit = vi.spyOn(api, 'generateAiMedia').mockResolvedValue({
      task_id: 'task-test', model: profile.model, status: 'running', result: null,
      chargedAmount: null, reservedAmount: 0, createdAt: 0, updatedAt: 0,
    });
    try {
      await generateVideoWithAdapter({ profile, prompt: 'tea', aiUsage: { type: 'video_generation', scope: 'chat', resourceId: 'chat-test' } });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ executionFence: fence }));
    } finally {
      clearChatExecutionFence('chat-test', fence);
    }
  });

  it('omits unset parameters so backend defaults can apply', () => {
    expect(resolveVideoGenerationParameters({ profile, prompt: 'tea' })).toEqual({});
    expect(resolveVideoGenerationParameters({ profile: { ...profile, videoDefaults: { aspectRatio: '', resolution: ' ', duration: NaN } }, prompt: 'tea' })).toEqual({});
  });

  it('merges explicit requests over model defaults independently for each parameter', () => {
    const params = { profile: { ...profile, videoDefaults: { aspectRatio: '16:9', resolution: '1080p', duration: 8 } }, prompt: 'tea' };
    expect(resolveVideoGenerationParameters(params)).toEqual({ aspect_ratio: '16:9', resolution: '1080p', duration: 8 });
    expect(resolveVideoGenerationParameters({ ...params, resolution: '720p' })).toEqual({ aspect_ratio: '16:9', resolution: '720p', duration: 8 });
    expect(resolveVideoGenerationParameters({ ...params, aspectRatio: '9:16', duration: 5, resolution: '480p', referenceImages: [{ url: 'https://example.com/tea.png' }] })).toEqual({ aspect_ratio: '9:16', resolution: '480p', duration: 5, image_urls: ['https://example.com/tea.png'] });
  });
});

describe('image generation default resolution', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the profile default while keeping explicit resolution and pixel size overrides', () => {
    const params = {
      profile: { ...DEFAULT_IMAGE_AI_PROFILE, defaultImageSize: '4K' as const },
      prompt: 'a tea cup',
      intent: 'chat-image' as const,
    };
    expect(resolveImageGenerationRequest(params).imageSize).toBe('4K');
    expect(resolveImageGenerationRequest({ ...params, imageSize: '2K' }).imageSize).toBe('2K');
    expect(resolveImageGenerationRequest({ ...params, size: '1024x1024' })).toMatchObject({ size: '1024x1024', imageSize: undefined });
    expect(resolveImageGenerationRequest({ ...params, profile: { ...params.profile, defaultImageSize: undefined } }).imageSize).toBe('1K');
  });

  it.each(['2K', '4K'] as const)('sends %s defaults and chat overrides through the Ace image proxy', async (defaultImageSize) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const params = {
      profile: { ...DEFAULT_IMAGE_AI_PROFILE, provider: 'official-ace-nanobanana', model: 'nano-banana-pro:official', defaultImageSize },
      prompt: 'a tea cup',
      intent: 'chat-image' as const,
      aspectRatio: '16:9',
    };
    await generateImageWithAdapter(params);
    await generateImageWithAdapter({ ...params, imageSize: '1K' });
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(bodies[0].generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: defaultImageSize });
    expect(bodies[1].generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '1K' });
  });

  it('translates defaults into pixel sizes for OpenAI compatible image requests', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const params = {
      profile: { ...DEFAULT_IMAGE_AI_PROFILE, provider: 'openai', baseUrl: 'https://example.com/v1', model: 'image-model', defaultImageSize: '2K' as const },
      prompt: 'a tea cup', intent: 'chat-image' as const,
    };
    await generateImageWithAdapter(params);
    await generateImageWithAdapter({ ...params, imageSize: '4K' });
    await generateImageWithAdapter({ ...params, size: '1024x1536' });
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)).size)).toEqual(['2048x2048', '4096x4096', '1024x1536']);
  });
});

describe('official requests carry the active chat lease', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('includes the fence in an official text request', async () => {
    const fence = { ownerId: 'owner-current-123456', generation: 8 };
    setChatExecutionFence('chat-text', fence);
    const response = new Response(JSON.stringify({ choices: [{ message: { content: '完成' } }] }), { status: 200 });
    const fetchWithAuth = vi.spyOn(api, 'fetchWithAuth').mockResolvedValue(response);
    try {
      await generateResponse({ provider: 'official-ace', model: 'gpt-6-sol', apiKey: '', baseUrl: '/api/ai' }, '助手',
        [{ role: 'user', content: '你好' }], undefined,
        { aiUsage: { type: 'chat', scope: 'chat', resourceId: 'chat-text' } });
      const body = JSON.parse(String(fetchWithAuth.mock.calls[0][1]?.body));
      expect(body.executionFence).toEqual(fence);
    } finally { clearChatExecutionFence('chat-text', fence); }
  });

  it('includes the fence in an official image request', async () => {
    const fence = { ownerId: 'owner-current-123456', generation: 8 };
    setChatExecutionFence('chat-image', fence);
    const fetchWithAuth = vi.spyOn(api, 'fetchWithAuth').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }] } }],
    }), { status: 200 }));
    try {
      await generateImageWithAdapter({ profile: { ...DEFAULT_IMAGE_AI_PROFILE, provider: 'official-ace-nanobanana',
        model: 'nano-banana-pro:official' }, prompt: '森林', intent: 'chat-image',
      aiUsage: { type: 'image_generation', scope: 'chat', resourceId: 'chat-image' } });
      const body = JSON.parse(String(fetchWithAuth.mock.calls[0][1]?.body));
      expect(body.executionFence).toEqual(fence);
    } finally { clearChatExecutionFence('chat-image', fence); }
  });
});
