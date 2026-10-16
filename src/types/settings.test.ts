import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_AI_PROFILE, buildTextInputCapabilityPatch, getInputCapabilityLockState, inferTextInputCapabilities, normalizeAIProfiles, resolveAIModelInputCapabilities } from './settings';

describe('GPT image input capabilities', () => {
  it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-4.1', 'gpt-4o', 'gpt-5.5'])(
    'recognizes ACE chat model %s and permits enabling image uploads', (model) => {
      const profile = { provider: 'official-acedata', model, type: 'text' as const, inputCapabilities: { imageInput: false, multiImageInput: false } };
      expect(getInputCapabilityLockState(profile)).toMatchObject({ imageInput: false, multiImageInput: false });
      expect(resolveAIModelInputCapabilities(profile).imageInput).toBe(false);
      const inputCapabilities = buildTextInputCapabilityPatch(profile.provider, profile.model, profile.inputCapabilities, { imageInput: true, multiImageInput: true });
      expect(resolveAIModelInputCapabilities({ ...profile, inputCapabilities })).toMatchObject({ imageInput: true, multiImageInput: true, maxAttachments: 10 });
    },
  );

  it('supports GPT-6 names on custom compatible endpoints without enabling unknown or text-only models', () => {
    expect(inferTextInputCapabilities('custom', 'gpt-6.1-sol').imageInput).toBe(true);
    for (const model of ['gpt-4', 'gpt-3.5-turbo', 'unknown', 'gpt-60']) {
      expect(getInputCapabilityLockState({ provider: 'official-acedata', model, type: 'text' }).imageInput).toBe(true);
    }
  });
});

describe('normalizeAIProfiles', () => {
  it('preserves the ACE model name and selected channel', () => {
    const profiles = normalizeAIProfiles([{
      id: 'ace-text', name: 'ACE', type: 'text', isDefault: true,
      provider: 'official-acedata', model: 'gpt-6-sol', baseUrl: '/api/ai', apiKey: '',
    }]);
    expect(profiles.find((profile) => profile.id === 'ace-text')).toMatchObject({ provider: 'official-acedata', model: 'gpt-6-sol' });
  });

  it('migrates the old default image preset to ACE and preserves a customized model', () => {
    const oldPreset = { ...DEFAULT_IMAGE_AI_PROFILE, provider: 'official-nanobanana' as const, model: 'gemini-3-pro-image-preview' };
    expect(normalizeAIProfiles([oldPreset]).find((profile) => profile.id === 'default-image')).toMatchObject({
      provider: 'official-acedata', model: 'nano-banana-pro', isDefault: true,
    });
    expect(normalizeAIProfiles([{ ...oldPreset, model: 'gemini-2.5-flash-image' }]).find((profile) => profile.id === 'default-image')).toMatchObject({
      provider: 'official-nanobanana', model: 'gemini-2.5-flash-image',
    });
  });

  it('preserves image defaults and backfills missing or invalid resolution with 1K', () => {
    for (const size of [undefined, 'invalid', '1K', '2K', '4K']) {
      const profile = { ...DEFAULT_IMAGE_AI_PROFILE, defaultImageSize: size };
      const profiles = normalizeAIProfiles([profile as typeof DEFAULT_IMAGE_AI_PROFILE]);
      expect(profiles.find((item) => item.type === 'image')?.defaultImageSize).toBe(size === '2K' || size === '4K' ? size : '1K');
    }
  });

  it('treats official GPT text providers as vision-capable even without a GPT model alias', () => {
    expect(inferTextInputCapabilities('official-2', 'official-2')).toMatchObject({
      imageInput: true,
      multiImageInput: true,
    });
    expect(inferTextInputCapabilities('official-deepseek', 'deepseek-v4-flash')).toMatchObject({
      imageInput: true,
    });
  });

  it('provides official text and image profiles by default', () => {
    const profiles = normalizeAIProfiles();

    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        provider: 'official-deepseek',
        model: 'deepseek-v4-flash',
        isDefault: true,
      }),
      expect.objectContaining({
        type: 'image',
        provider: 'official-acedata',
        model: DEFAULT_IMAGE_AI_PROFILE.model,
        isDefault: true,
      }),
    ]));
  });

  it('backfills the official image profile when cloud settings only contain text profiles', () => {
    const profiles = normalizeAIProfiles([{
      id: 'default',
      name: 'Text',
      type: 'text',
      isDefault: true,
      provider: 'official-deepseek',
      apiKey: '',
      baseUrl: '/api/ai',
      model: 'deepseek-chat',
    }]);

    expect(profiles.find((profile) => profile.type === 'text')).toEqual(expect.objectContaining({
      provider: 'official-deepseek',
      model: 'deepseek-v4-flash',
      isDefault: true,
    }));
    expect(profiles.find((profile) => profile.type === 'image')).toEqual(expect.objectContaining({
      provider: 'official-acedata',
      model: DEFAULT_IMAGE_AI_PROFILE.model,
      isDefault: true,
    }));
  });

  it('migrates legacy official DeepSeek reasoner settings to the configured v4 pro model', () => {
    const profiles = normalizeAIProfiles([{
      id: 'default',
      name: 'Text',
      type: 'text',
      isDefault: true,
      provider: 'official-deepseek',
      apiKey: '',
      baseUrl: '/api/ai',
      model: 'deepseek-reasoner',
    }]);

    expect(profiles.find((profile) => profile.type === 'text')).toEqual(expect.objectContaining({
      provider: 'official-deepseek',
      model: 'deepseek-v4-pro',
      isDefault: true,
    }));
  });

  it('migrates legacy custom DeepSeek model settings to supported v4 names', () => {
    const profiles = normalizeAIProfiles([{
      id: 'custom-deepseek',
      name: 'DeepSeek',
      type: 'text',
      isDefault: true,
      provider: 'deepseek',
      apiKey: 'key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    }]);

    expect(profiles.find((profile) => profile.type === 'text')).toEqual(expect.objectContaining({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      isDefault: true,
    }));
  });
});
