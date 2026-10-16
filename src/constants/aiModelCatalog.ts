import type { AIModelImageCapabilities, AIModelType, AIProvider } from '../types/settings';
import { normalizeImageCapabilities } from '../types/settings';

const OFFICIAL_TEXT_MODELS = [
  'gpt-5.5',
  'gpt-5.1',
  'gpt-5.1-2025-11-13',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'o4-mini',
  'o3',
  'o3-mini',
  'o3-mini-2025-01-31',
  'o1',
  'o1-2024-12-17',
  'o1-preview',
  'o1-preview-2024-09-12',
  'o1-mini',
  'o1-mini-2024-09-12',
  'gpt-4.5-preview-2025-02-27',
  'gpt-4.1',
  'gpt-4.1-2025-04-14',
  'gpt-4.1-mini',
  'gpt-4.1-mini-2025-04-14',
  'gpt-4.1-nano',
  'gpt-4.1-nano-2025-04-14',
  'gpt-4o',
  'gpt-4o-2024-08-06',
  'gpt-4o-2024-05-13',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4-turbo-2024-04-09',
  'gpt-4-turbo-preview',
  'gpt-4-1106-preview',
  'gpt-4-0125-preview',
  'gpt-4-vision-preview',
  'gpt-4-1106-vision-preview',
  'gpt-4',
  'gpt-4-0613',
  'gpt-4-0314',
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-0125',
  'gpt-3.5-turbo-1106',
  'gpt-3.5-turbo-0613',
  'gpt-3.5-turbo-0301',
  'gpt-3.5-turbo-16k',
  'gpt-3.5-turbo-16k-0613',
];

const OFFICIAL_DEEPSEEK_TEXT_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
];

const OFFICIAL_MOACODE_CODE_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-0',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-3-7-sonnet-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
  'gpt-5-codex',
  'codex-mini-latest',
];
const OFFICIAL_MOACODE_TEXT_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  ...OFFICIAL_MOACODE_CODE_MODELS,
];
const OFFICIAL_NANOBANANA_IMAGE_MODELS = [
  'gemini-3-pro-image-preview',
];

export interface ProviderTypeDefaults {
  baseUrl: string;
  model: string;
}

export interface AIProviderCatalogEntry {
  key: AIProvider;
  label: string;
  family: string;
  defaults: Partial<Record<AIModelType, ProviderTypeDefaults>>;
  popularModels: Partial<Record<AIModelType, string[]>>;
  hidden?: boolean;
}

export const AI_PROVIDER_CATALOG: AIProviderCatalogEntry[] = [
  {
    key: 'official-deepseek',
    label: '官方1（DeepSeek）',
    family: '官方模型',
    defaults: {
      text: { baseUrl: '/api/ai', model: 'deepseek-v4-flash' },
      document: { baseUrl: '/api/ai', model: 'deepseek-v4-flash' },
    },
    popularModels: {
      text: OFFICIAL_DEEPSEEK_TEXT_MODELS,
      document: OFFICIAL_DEEPSEEK_TEXT_MODELS,
    },
  },
  {
    key: 'official-moacode',
    label: '官方2（Claude/GPT）',
    family: '官方模型',
    defaults: {
      text: { baseUrl: '/api/ai', model: 'gpt-5.4-mini' },
      document: { baseUrl: '/api/ai', model: 'gpt-5.4-mini' },
    },
    popularModels: {
      text: OFFICIAL_MOACODE_TEXT_MODELS,
      document: OFFICIAL_MOACODE_TEXT_MODELS,
    },
  },
  {
    key: 'official-moacode-team',
    label: '官方团队（Claude/GPT）',
    family: '官方模型',
    defaults: {
      text: { baseUrl: '/api/ai', model: 'gpt-5.5' },
      document: { baseUrl: '/api/ai', model: 'gpt-5.5' },
    },
    popularModels: {
      text: OFFICIAL_MOACODE_TEXT_MODELS,
      document: OFFICIAL_MOACODE_TEXT_MODELS,
    },
  },
  {
    key: 'official-nanobanana',
    label: '官方图片（NanoBanana）',
    family: '官方模型',
    defaults: {
      image: { baseUrl: '/api/ai', model: 'gemini-3-pro-image-preview' },
    },
    popularModels: {
      image: OFFICIAL_NANOBANANA_IMAGE_MODELS,
    },
  },
  {
    key: 'official-acedata',
    label: 'ACE',
    family: '官方模型',
    hidden: true,
    defaults: {
      image: { baseUrl: '/api/ai', model: 'nano-banana-pro' },
    },
    popularModels: {
      image: ['nano-banana-pro'],
    },
  },
  {
    key: 'official-gpt',
    label: '官方4（API2D）',
    family: '官方模型',
    defaults: {
      text: { baseUrl: '/api/ai', model: 'gpt-5.5' },
      document: { baseUrl: '/api/ai', model: 'gpt-5.5' },
    },
    popularModels: {
      text: OFFICIAL_TEXT_MODELS,
      document: OFFICIAL_TEXT_MODELS,
    },
    hidden: true,
  },
  {
    key: 'openai',
    label: 'OpenAI (GPT)',
    family: 'GPT',
    defaults: {
      text: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
      image: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' },
      audio: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-audio-mini' },
      document: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
    },
    popularModels: {
      text: ['gpt-5-mini', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini'],
      image: ['gpt-image-1'],
      audio: ['gpt-audio-mini', 'gpt-audio', 'gpt-4o-transcribe'],
      document: ['gpt-5-mini', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini'],
    },
  },
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    family: 'Claude',
    defaults: {
      text: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8' },
      document: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8' },
    },
    popularModels: {
      text: ['claude-opus-4-8', 'claude-sonnet-4-0', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
      document: ['claude-opus-4-8', 'claude-sonnet-4-0', 'claude-3-7-sonnet-latest'],
    },
  },
  {
    key: 'google',
    label: 'Google (Gemini)',
    family: 'Gemini',
    defaults: {
      text: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
      image: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash-preview-image-generation' },
      audio: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash-preview-tts' },
      document: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
    },
    popularModels: {
      text: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
      image: ['gemini-2.0-flash-preview-image-generation'],
      audio: ['gemini-2.5-flash-preview-tts', 'gemini-2.0-flash-live-001'],
      document: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-pro'],
    },
  },
  {
    key: 'xai',
    label: 'xAI (Grok)',
    family: 'Grok',
    defaults: {
      text: { baseUrl: 'https://api.x.ai/v1', model: 'grok-3-mini-beta' },
      image: { baseUrl: 'https://api.x.ai/v1', model: 'grok-2-image' },
      document: { baseUrl: 'https://api.x.ai/v1', model: 'grok-3-beta' },
    },
    popularModels: {
      text: ['grok-3-beta', 'grok-3-mini-beta', 'grok-2-latest'],
      image: ['grok-2-image'],
      document: ['grok-3-beta', 'grok-2-latest'],
    },
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    family: 'DeepSeek',
    defaults: {
      text: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
      document: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    },
    popularModels: {
      text: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      document: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    },
  },
  {
    key: 'alibaba',
    label: 'Alibaba (Qwen)',
    family: 'Qwen',
    defaults: {
      text: { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-plus' },
      image: { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wanx2.1-t2i-turbo' },
      audio: { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-tts' },
      document: { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-long' },
    },
    popularModels: {
      text: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
      image: ['wanx2.1-t2i-plus', 'wanx2.1-t2i-turbo'],
      audio: ['qwen-tts'],
      document: ['qwen-long', 'qwen-plus'],
    },
  },
  {
    key: 'zhipu',
    label: 'Zhipu (GLM)',
    family: 'GLM',
    defaults: {
      text: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air' },
      image: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-3-flash' },
      document: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air' },
    },
    popularModels: {
      text: ['glm-4.5', 'glm-4.5-air', 'glm-4-plus'],
      image: ['cogview-3-flash', 'cogview-3-plus'],
      document: ['glm-4.5', 'glm-4.5-air', 'glm-4-plus'],
    },
  },
  {
    key: 'moonshot',
    label: 'Moonshot (Kimi)',
    family: 'Kimi',
    defaults: {
      text: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6' },
      document: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6' },
    },
    popularModels: {
      text: ['kimi-k2.6', 'kimi-k2', 'moonshot-v1-8k'],
      document: ['kimi-k2.6', 'kimi-k2', 'moonshot-v1-128k'],
    },
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    family: 'MiniMax',
    defaults: {
      text: { baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-Text-01' },
      audio: { baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd' },
      document: { baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-Text-01' },
    },
    popularModels: {
      text: ['MiniMax-Text-01', 'abab6.5s-chat'],
      audio: ['speech-02-hd', 'speech-01-turbo'],
      document: ['MiniMax-Text-01', 'abab6.5s-chat'],
    },
  },
  {
    key: 'bytedance',
    label: 'ByteDance (Doubao)',
    family: 'Doubao',
    defaults: {
      text: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
      image: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-3.0' },
      audio: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-voice' },
      document: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
    },
    popularModels: {
      text: ['doubao-pro-32k', 'doubao-lite-32k', 'doubao-1.5-pro-32k'],
      image: ['doubao-seedream-3.0'],
      audio: ['doubao-voice'],
      document: ['doubao-pro-32k', 'doubao-1.5-pro-32k'],
    },
  },
  {
    key: 'microsoft',
    label: 'Microsoft Azure Speech',
    family: 'Azure Speech',
    defaults: {
      audio: { baseUrl: 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1', model: 'zh-CN-XiaoxiaoNeural' },
    },
    popularModels: {
      audio: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', 'zh-CN-XiaoyiNeural', 'en-US-JennyNeural', 'en-US-GuyNeural'],
    },
  },
  {
    key: 'custom',
    label: 'Custom',
    family: 'Custom',
    defaults: {
      text: { baseUrl: '', model: '' },
      image: { baseUrl: '', model: '' },
      audio: { baseUrl: '', model: '' },
      document: { baseUrl: '', model: '' },
    },
    popularModels: {
      text: [],
      image: [],
      audio: [],
      document: [],
    },
  },
];

export function getProviderCatalogEntry(provider: AIProvider) {
  if (provider === 'official') return AI_PROVIDER_CATALOG.find((item) => item.key === 'official-moacode') || AI_PROVIDER_CATALOG[0];
  return AI_PROVIDER_CATALOG.find((item) => item.key === provider) || AI_PROVIDER_CATALOG[0];
}

export function getProvidersForType(type: AIModelType, options: { includeHidden?: boolean } = {}) {
  const catalogType = type === 'tts' || type === 'stt' ? 'audio' : type;
  return AI_PROVIDER_CATALOG.filter((item) => item.defaults[catalogType] && (options.includeHidden || !item.hidden));
}

export function getProviderDefaults(provider: AIProvider, type: AIModelType) {
  const entry = getProviderCatalogEntry(provider);
  const catalogType = type === 'tts' || type === 'stt' ? 'audio' : type;
  return entry.defaults[catalogType] || { baseUrl: '', model: '' };
}

export function getPopularModels(provider: AIProvider, type: AIModelType) {
  const entry = getProviderCatalogEntry(provider);
  const catalogType = type === 'tts' || type === 'stt' ? 'audio' : type;
  return entry.popularModels[catalogType] || [];
}

export function inferImageCapabilities(provider: AIProvider, model: string): AIModelImageCapabilities {
  const normalizedModel = model.trim().toLowerCase();
  const base = normalizeImageCapabilities();

  if (!normalizedModel) return base;

  if (provider === 'openai') {
    if (/^gpt-image-1(\.|-|$)/.test(normalizedModel) || normalizedModel === 'gpt-image-1') {
      return { ...base, referenceImage: true, multiReferenceImage: true };
    }
    if (normalizedModel === 'dall-e-2') {
      return { ...base, referenceImage: true };
    }
    return base;
  }

  if (provider === 'google') {
    if (normalizedModel.includes('gemini') && normalizedModel.includes('image')) {
      return { ...base, referenceImage: true, multiReferenceImage: true };
    }
    return base;
  }

  if (provider === 'official-nanobanana' || provider === 'official-ace-nanobanana' || normalizedModel.includes('image-preview') || normalizedModel.includes('nanobanana') || normalizedModel.includes('nano-banana')) {
    return { ...base, referenceImage: true, multiReferenceImage: true };
  }

  if (provider === 'alibaba') {
    if (normalizedModel.includes('imageedit') || normalizedModel.includes('edit') || normalizedModel.includes('i2i')) {
      return { ...base, referenceImage: true };
    }
    return base;
  }

  if (provider === 'bytedance') {
    if (normalizedModel.includes('seedream-4') || normalizedModel.includes('seedream-5') || normalizedModel.includes('seededit') || normalizedModel.includes('i2i')) {
      return { ...base, referenceImage: true, multiReferenceImage: true };
    }
    return base;
  }

  return base;
}
