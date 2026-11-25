import { getProviderCatalogEntry, getProvidersForType, type AIProviderCatalogEntry } from '../constants/aiModelCatalog';
import type { AIModelType, AIProvider } from '../types/settings';

export type AIProviderOption = AIProviderCatalogEntry & { unavailableReason?: string };

const directSpeechDefaults = {
  tts: { openai: 'tts-1', google: 'gemini-2.5-flash-preview-tts', microsoft: 'zh-CN-XiaoxiaoNeural' },
  stt: { openai: 'gpt-4o-mini-transcribe' },
} as const;

export function getDirectSpeechProviderOptions(type: 'tts' | 'stt'): AIProviderOption[] {
  const modelByProvider: Record<string, string> = directSpeechDefaults[type];
  const supported = Object.entries(modelByProvider).map(([key, model]) => {
    const catalog = getProviderCatalogEntry(key as AIProvider);
    return {
      ...catalog,
      defaults: { ...catalog.defaults, audio: { baseUrl: catalog.defaults.audio?.baseUrl || '', model } },
      popularModels: { ...catalog.popularModels, audio: [model] },
    };
  });
  return [...supported, getProviderCatalogEntry('custom')];
}

export function resolveLegacyOfficialProviderKey(provider: string) {
  if (provider === 'official' || provider === 'official-moacode') return 'official-2';
  if (provider === 'official-deepseek') return 'official-1';
  if (provider === 'official-moacode-team') return 'official-team';
  if (provider === 'official-gpt') return 'official-4';
  return provider;
}

export function providerSupportsType(option: AIProviderOption, type: AIModelType) {
  const catalogType = type === 'tts' || type === 'stt' ? 'audio' : type;
  const defaults = option.defaults[catalogType];
  // Switching types writes the provider's default model into the profile.
  // A recommended-model list alone cannot produce a usable profile.
  return Boolean(defaults?.model?.trim());
}

export function resolveSelectableProviderKey(provider: string, type: AIModelType, providerOptions: AIProviderOption[] = getProvidersForType(type)) {
  const catalogType = type === 'tts' || type === 'stt' ? 'audio' : type;
  const exactProvider = providerOptions.find((item) => item.key === provider);
  if (exactProvider && providerSupportsType(exactProvider, type) && !exactProvider.unavailableReason) return exactProvider.key;
  const legacyProvider = resolveLegacyOfficialProviderKey(provider);
  const mappedProvider = providerOptions.find((item) => item.key === legacyProvider);
  if (mappedProvider && providerSupportsType(mappedProvider, type) && !mappedProvider.unavailableReason) return mappedProvider.key;
  const catalogProvider = getProviderCatalogEntry(provider as AIProvider);
  if (catalogProvider.defaults[catalogType]) {
    const catalogOption = providerOptions.find((item) => item.key === catalogProvider.key);
    if (catalogOption && providerSupportsType(catalogOption, type) && !catalogOption.unavailableReason) return catalogOption.key;
  }
  return providerOptions.find((item) => providerSupportsType(item, type) && !item.unavailableReason)?.key
    || providerOptions.find((item) => providerSupportsType(item, type))?.key
    || catalogProvider.key;
}
