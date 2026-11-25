import { describe, expect, it } from 'vitest';
import { getProviderCatalogEntry } from '../constants/aiModelCatalog';
import { getDirectSpeechProviderOptions, providerSupportsType, resolveSelectableProviderKey } from './aiModelProviderSelection';

const deepseek = { ...getProviderCatalogEntry('official-deepseek'), key: 'official-1' as const };
const ace = getProviderCatalogEntry('official-acedata');

describe('model provider selection', () => {
  it('switches a new DeepSeek text card to a video-capable provider', () => {
    expect(deepseek.defaults.video).toBeUndefined();
    expect(resolveSelectableProviderKey('official-deepseek', 'video', [deepseek, ace])).toBe('official-acedata');
    expect(ace.defaults.video?.model).toBe('doubao-seedance-2-0-fast-260128');
  });

  it('does not infer video support from an unknown official text default', () => {
    const textOnly = { ...deepseek, key: 'official-custom' as const };
    expect(textOnly.defaults.video).toBeUndefined();
    expect(resolveSelectableProviderKey('official-custom', 'video', [textOnly, ace])).toBe('official-acedata');
  });

  it('selects a compatible provider for each model type', () => {
    const image = getProviderCatalogEntry('official-nanobanana');
    const speech = { ...getProviderCatalogEntry('openai'), key: 'official' as const,
      defaults: { audio: { baseUrl: '/api', model: 'speech-model' } } };
    const options = [deepseek, image, ace, speech];
    expect(resolveSelectableProviderKey('official-1', 'text', options)).toBe('official-1');
    expect(resolveSelectableProviderKey('official-1', 'image', options)).toBe('official-nanobanana');
    expect(resolveSelectableProviderKey('official-1', 'video', options)).toBe('official-acedata');
    expect(resolveSelectableProviderKey('official-nanobanana', 'document', options)).toBe('official-1');
    expect(resolveSelectableProviderKey('official-1', 'tts', options)).toBe('official');
    expect(resolveSelectableProviderKey('official-1', 'stt', options)).toBe('official');
  });

  it('does not auto-select a provider without a usable default model', () => {
    const recommendationsOnly = { ...deepseek, defaults: {}, popularModels: { video: ['suggested-video'] } };
    expect(providerSupportsType(recommendationsOnly, 'video')).toBe(false);
    expect(resolveSelectableProviderKey('official-1', 'video', [recommendationsOnly, ace])).toBe('official-acedata');
  });

  it('uses separate synthesis and transcription defaults', () => {
    const tts = getDirectSpeechProviderOptions('tts');
    const stt = getDirectSpeechProviderOptions('stt');
    expect(tts.find((item) => item.key === 'openai')?.defaults.audio?.model).toBe('tts-1');
    expect(stt.find((item) => item.key === 'openai')?.defaults.audio?.model).toBe('gpt-4o-mini-transcribe');
    expect(stt.some((item) => item.key === 'google')).toBe(false);
    expect(tts.some((item) => item.defaults.audio?.model === 'gpt-audio-mini')).toBe(false);
  });
});
