import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_PROFILE, DEFAULT_AVATAR_GENERATION_SETTINGS, DEFAULT_IMAGE_AI_PROFILE } from '../types/settings';
import { createTestChat } from '../test/fixtures';

vi.mock('./aiGenerationAdapter', () => ({ generateImageWithAdapter: vi.fn() }));
vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));
vi.mock('./characterGenerator', () => ({ parseGeneratedJsonPayload: vi.fn() }));
vi.mock('../stores/useCharacterStore', () => ({ useCharacterStore: { getState: vi.fn() } }));
vi.mock('../stores/useChatStore', () => ({ useChatStore: { getState: vi.fn() } }));
vi.mock('../stores/useAuthStore', () => ({ useAuthStore: { getState: vi.fn() } }));
vi.mock('./api', () => ({ api: {} }));
vi.mock('./diagnostics', () => ({ logRecoverableError: vi.fn(), notifyDiagnosticToast: vi.fn() }));
vi.mock('../utils/avatarUpload', () => ({ prepareAvatarUploadDataUrl: vi.fn() }));

describe('image generation error reporting', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each(['avatar', 'background'] as const)('reports three failed group %s tasks once each', async (kind) => {
    const { generateImageWithAdapter } = await import('./aiGenerationAdapter');
    vi.mocked(generateImageWithAdapter).mockRejectedValue(new Error('Model unavailable'));
    const { enqueueGroupVisualGeneration } = await import('./groupVisualGeneration');
    const { getChatCompletionSummary } = await import('./chatCompletionQueue');
    const { avatarGenerationQueue } = await import('./avatarGenerationQueue');

    const chats = [1, 2, 3].map((index) => createTestChat({ id: `group-${index}`, name: `Group ${index}` }));
    for (const chat of chats) {
      enqueueGroupVisualGeneration({
        chat, members: [], profiles: [DEFAULT_IMAGE_AI_PROFILE],
        settings: DEFAULT_AVATAR_GENERATION_SETTINGS, language: 'en', kind,
      });
    }

    await vi.waitFor(() => expect(getChatCompletionSummary().image.failed).toBe(3));
    const errors = [...getChatCompletionSummary().recentErrors, ...avatarGenerationQueue.getSummary().recentErrors];
    expect(errors).toHaveLength(3);
    expect(new Set(errors.map((error) => error.title)).size).toBe(3);
    expect(errors.every((error) => error.message === 'Model unavailable')).toBe(true);
    expect(generateImageWithAdapter).toHaveBeenCalledTimes(3);
    expect(generateImageWithAdapter).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ provider: 'official-acedata', model: 'nano-banana-pro' }),
    }));
    if (kind === 'avatar') {
      expect(vi.mocked(generateImageWithAdapter).mock.calls[0][0].prompt).not.toContain('edge-to-edge');
    }
    for (const chat of chats) {
      expect(avatarGenerationQueue.getLatestTaskForTarget(`chat-${kind}:${chat.id}`)).toMatchObject({
        status: 'failed', error: 'Model unavailable',
      });
    }
  });

  it.each(['zh', 'en'] as const)('enforces full-bleed backgrounds for generated and fallback plans in %s', async (language) => {
    const { generateImageWithAdapter } = await import('./aiGenerationAdapter');
    const { generateResponse } = await import('./aiClient');
    const { parseGeneratedJsonPayload } = await import('./characterGenerator');
    vi.mocked(generateImageWithAdapter).mockRejectedValue(new Error('Model unavailable'));
    vi.mocked(generateResponse).mockResolvedValue('visual plan');
    vi.mocked(parseGeneratedJsonPayload).mockReturnValue({
      prompt: 'Soft peach garden', negativePrompt: 'watermark', backgroundOpacity: 0.16,
    });
    const { enqueueGroupVisualGeneration } = await import('./groupVisualGeneration');
    const { getChatCompletionSummary } = await import('./chatCompletionQueue');

    for (const useDirector of [false, true]) {
      enqueueGroupVisualGeneration({
        chat: createTestChat({ id: `background-${useDirector}` }), members: [],
        profiles: useDirector ? [DEFAULT_AI_PROFILE, DEFAULT_IMAGE_AI_PROFILE] : [DEFAULT_IMAGE_AI_PROFILE],
        settings: DEFAULT_AVATAR_GENERATION_SETTINGS, language, kind: 'background',
      });
      await vi.waitFor(() => expect(getChatCompletionSummary().image.failed).toBe(useDirector ? 2 : 1));
    }

    expect(generateImageWithAdapter).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(generateImageWithAdapter).mock.calls) {
      expect(request.prompt).toContain('edge-to-edge');
      expect(request.negativePrompt).toContain('blank margins');
      expect(request.negativePrompt).toContain('transparent borders');
      expect(request.negativePrompt).toContain('watermark');
    }
    expect(generateResponse).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateResponse).mock.calls[0][1]).toContain('edge-to-edge');
    expect(vi.mocked(generateImageWithAdapter).mock.calls[1][0].prompt).toContain('Soft peach garden');
  });

  it('still reports standalone image failures and rejects task waiters', async () => {
    const { generateImageWithAdapter } = await import('./aiGenerationAdapter');
    vi.mocked(generateImageWithAdapter).mockRejectedValue(new Error('Model unavailable'));
    const { avatarGenerationQueue } = await import('./avatarGenerationQueue');
    const id = avatarGenerationQueue.enqueue(DEFAULT_IMAGE_AI_PROFILE, 'An avatar', {
      targetKey: 'standalone-avatar', description: 'Standalone avatar',
    });

    await expect(avatarGenerationQueue.waitForTask(id)).rejects.toThrow('Model unavailable');
    expect(avatarGenerationQueue.getSummary().recentErrors).toEqual([
      expect.objectContaining({ id, title: 'Standalone avatar', message: 'Model unavailable' }),
    ]);
  });
});
