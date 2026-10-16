import type { RuntimeEvolutionIntensity } from './chat';
import type { ArtifactAppearanceSettings } from './artifactAppearance';
import { DEFAULT_ARTIFACT_APPEARANCE_SETTINGS } from './artifactAppearance';
import { DEFAULT_CHAT_REPLY_PREFERENCES, type ChatReplyPreferences } from './chatReplyPreferences';

export type OfficialAIProvider = 'official' | `official-${string}`;
export type BuiltInAIProvider = OfficialAIProvider | 'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'alibaba' | 'zhipu' | 'moonshot' | 'minimax' | 'bytedance' | 'microsoft' | 'custom';
export type AIProvider = BuiltInAIProvider | (string & {});
export type AIModelType = 'text' | 'image' | 'tts' | 'stt' | 'audio' | 'document';
export type AudioModelCapability = 'tts' | 'stt' | 'both';
export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemePresetId = 'rednote' | 'jade' | 'reader' | 'imperial' | 'night' | 'mirage' | 'aurora' | 'paper' | 'sakura' | 'ember' | 'graphite' | 'dopamine' | 'morandi';
export type Language = 'zh' | 'en';

export interface APIConfig {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Hard ceiling for one response; independent from input/context limits. */
  maxOutputTokens?: number;
  advancedOptions?: Partial<AIModelAdvancedOptions>;
}

export interface AIModelImageCapabilities {
  textToImage: boolean;
  referenceImage: boolean;
  multiReferenceImage: boolean;
  seed: boolean;
  negativePrompt: boolean;
}

export interface AIModelInputCapabilities {
  imageInput: boolean;
  multiImageInput: boolean;
  fileInput: boolean;
  maxAttachments: number;
  supportedMimeTypes: string[];
}

export type AIReasoningMode = 'auto' | 'enabled' | 'disabled';

export interface AIModelAdvancedOptions {
  reasoningMode: AIReasoningMode;
}

export type ImageGenerationSize = '1K' | '2K' | '4K';

export function normalizeImageGenerationSize(value: unknown): ImageGenerationSize {
  return value === '2K' || value === '4K' ? value : '1K';
}

export interface AIModelProfile extends APIConfig {
  id: string;
  name: string;
  type: AIModelType;
  audioCapability?: AudioModelCapability;
  isDefault?: boolean;
  imageCapabilities?: Partial<AIModelImageCapabilities>;
  defaultImageSize?: ImageGenerationSize;
  inputCapabilities?: Partial<AIModelInputCapabilities>;
  advancedOptions?: Partial<AIModelAdvancedOptions>;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
export const MAX_ALLOWED_OUTPUT_TOKENS = 1_000_000;
export function normalizeMaxOutputTokens(value: unknown, fallback = DEFAULT_MAX_OUTPUT_TOKENS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_ALLOWED_OUTPUT_TOKENS, Math.max(256, Math.floor(parsed)));
}

export const DEFAULT_INPUT_CAPABILITIES: AIModelInputCapabilities = {
  imageInput: false,
  multiImageInput: false,
  fileInput: false,
  maxAttachments: 1,
  supportedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
};

export function normalizeInputCapabilities(input?: Partial<AIModelInputCapabilities> | null): AIModelInputCapabilities {
  return {
    ...DEFAULT_INPUT_CAPABILITIES,
    ...(input || {}),
    imageInput: Boolean(input?.imageInput),
    multiImageInput: Boolean(input?.multiImageInput),
    fileInput: Boolean(input?.fileInput),
    maxAttachments: Math.max(1, Number(input?.maxAttachments) || DEFAULT_INPUT_CAPABILITIES.maxAttachments),
    supportedMimeTypes: Array.isArray(input?.supportedMimeTypes) && input.supportedMimeTypes.length
      ? input.supportedMimeTypes
      : DEFAULT_INPUT_CAPABILITIES.supportedMimeTypes,
  };
}

export function inferTextInputCapabilities(provider: AIProvider, model: string): AIModelInputCapabilities {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  const base = normalizeInputCapabilities();
  const multiImage = { ...base, imageInput: true, multiImageInput: true, maxAttachments: 10 };
  const singleImage = { ...base, imageInput: true, multiImageInput: false, maxAttachments: 1 };
  const multiImageWithFiles = {
    ...multiImage,
    fileInput: true,
    supportedMimeTypes: [...DEFAULT_INPUT_CAPABILITIES.supportedMimeTypes, 'application/pdf', 'text/plain', 'text/markdown'],
  };

  if (
    normalizedProvider === 'official'
    || normalizedProvider === 'official-2'
    || normalizedProvider === 'official-moacode'
    || normalizedProvider === 'official-gpt'
    || normalizedProvider === 'official-4'
  ) {
    return multiImage;
  }
  if (
    (normalizedProvider === 'deepseek' || normalizedProvider === 'official-1' || normalizedProvider === 'official-deepseek')
    && (normalizedModel.startsWith('deepseek-v4') || normalizedModel.includes('deepseek-v4'))
  ) {
    return singleImage;
  }
  if (!normalizedModel) return base;
  if (normalizedModel.includes('gemini')) return multiImageWithFiles;
  if (
    normalizedModel.includes('claude-3')
    || normalizedModel.includes('claude-sonnet')
    || normalizedModel.includes('claude-opus')
    || normalizedModel.includes('claude-haiku')
    || normalizedModel.includes('claude-4')
    || normalizedModel.includes('claude-5')
    || normalizedModel.includes('gpt-4o')
    || normalizedModel.includes('gpt-4.1')
    || normalizedModel.includes('gpt-5')
    || /(?:^|:)gpt-6(?:[.-]|$)/.test(normalizedModel)
    || normalizedModel.includes('glm-4v')
    || normalizedModel.includes('glm-4.5v')
    || normalizedModel.includes('qwen-vl')
    || normalizedModel.includes('qvq')
    || normalizedModel.includes('omni')
    || normalizedModel.includes('vision')
  ) {
    return multiImage;
  }

  return base;
}

function normalizeProviderKey(provider: AIProvider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'official-deepseek') return 'official-1';
  if (normalized === 'official-gpt') return 'official-4';
  if (normalized === 'official') return 'official-2';
  return normalized;
}

export function inferReasoningModeSupport(provider: AIProvider, model: string) {
  const normalizedProvider = normalizeProviderKey(provider);
  const normalizedModel = model.trim().toLowerCase();
  const isDeepSeekProvider = normalizedProvider === 'deepseek' || normalizedProvider === 'official-1';
  const isDeepSeekV4 = normalizedModel.startsWith('deepseek-v4') || normalizedModel.includes('deepseek-v4');
  return {
    supported: isDeepSeekProvider && isDeepSeekV4,
    source: isDeepSeekProvider && isDeepSeekV4 ? 'deepseek-v4' : 'unsupported',
  } as const;
}

export function normalizeAIModelAdvancedOptions(
  provider: AIProvider,
  model: string,
  input?: Partial<AIModelAdvancedOptions> | null,
): AIModelAdvancedOptions {
  const support = inferReasoningModeSupport(provider, model);
  const requestedMode = input?.reasoningMode;
  const reasoningMode: AIReasoningMode = support.supported
    ? (requestedMode === 'enabled' || requestedMode === 'disabled' ? requestedMode : 'disabled')
    : 'auto';
  return { reasoningMode };
}

export function getReasoningModeUiMeta(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'advancedOptions'> | null, language: Language = 'zh') {
  const support = profile ? inferReasoningModeSupport(profile.provider, profile.model) : { supported: false, source: 'unsupported' as const };
  const options = profile ? normalizeAIModelAdvancedOptions(profile.provider, profile.model, profile.advancedOptions) : { reasoningMode: 'auto' as AIReasoningMode };
  if (language === 'zh') {
    return {
      supported: support.supported,
      enabled: options.reasoningMode === 'enabled',
      label: '深度思考',
      badge: support.supported ? 'DeepSeek V4 支持' : '当前模型未识别到支持',
      tooltip: support.supported
        ? '开启后允许模型返回更强推理过程，速度和消耗可能明显增加；关闭后会向 DeepSeek V4 发送 thinking.disabled。'
        : '不同服务商参数不一致，当前模型未识别到可安全控制的深度思考开关。',
    };
  }
  return {
    supported: support.supported,
    enabled: options.reasoningMode === 'enabled',
    label: 'Deep thinking',
    badge: support.supported ? 'DeepSeek V4 supported' : 'Not detected',
    tooltip: support.supported
      ? 'Allows stronger reasoning but may increase latency and cost; disabling sends thinking.disabled to DeepSeek V4.'
      : 'Provider parameters differ, and this model was not identified as safe to control.',
  };
}

export function resolveAIModelInputCapabilities(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null): AIModelInputCapabilities {
  if (!profile || (profile.type || 'text') !== 'text') return normalizeInputCapabilities();
  const inferred = inferTextInputCapabilities(profile.provider, profile.model);
  return normalizeInputCapabilities({
    ...inferred,
    imageInput: inferred.imageInput ? (profile.inputCapabilities?.imageInput ?? inferred.imageInput) : false,
    multiImageInput: inferred.imageInput && inferred.multiImageInput ? (profile.inputCapabilities?.multiImageInput ?? inferred.multiImageInput) : false,
    fileInput: inferred.fileInput ? (profile.inputCapabilities?.fileInput ?? inferred.fileInput) : false,
    maxAttachments: inferred.imageInput && (profile.inputCapabilities?.multiImageInput ?? inferred.multiImageInput) ? inferred.maxAttachments : 1,
    supportedMimeTypes: inferred.supportedMimeTypes,
  });
}

export function getInputCapabilityLockState(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  if (!profile || (profile.type || 'text') !== 'text') return { imageInput: true, multiImageInput: true, fileInput: true };
  const inferred = inferTextInputCapabilities(profile.provider, profile.model);
  return {
    imageInput: !inferred.imageInput,
    multiImageInput: !inferred.multiImageInput,
    fileInput: !inferred.fileInput,
  };
}

export function buildTextInputCapabilityPatch(provider: AIProvider, model: string, current: Partial<AIModelInputCapabilities> | null | undefined, patch: Partial<AIModelInputCapabilities>) {
  const next = normalizeInputCapabilities({ ...(current || {}), ...patch });
  const inferred = inferTextInputCapabilities(provider, model);
  next.imageInput = inferred.imageInput ? next.imageInput : false;
  next.multiImageInput = inferred.multiImageInput ? next.multiImageInput : false;
  next.fileInput = inferred.fileInput ? next.fileInput : false;
  if (!next.imageInput) next.multiImageInput = false;
  if (next.multiImageInput) next.imageInput = true;
  next.maxAttachments = next.multiImageInput ? inferred.maxAttachments : 1;
  next.supportedMimeTypes = inferred.supportedMimeTypes;
  return next;
}

export function getAttachmentUiCapabilitySummary(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null, language: Language = 'zh') {
  const capabilities = resolveAIModelInputCapabilities(profile);
  const reasoningSupport = profile ? inferReasoningModeSupport(profile.provider, profile.model) : { source: 'unsupported' as const };
  if (language === 'zh') {
    if (!capabilities.imageInput && !capabilities.fileInput) return '未开启图片/附件输入能力';
    const parts = [] as string[];
    if (capabilities.imageInput) parts.push(reasoningSupport.source === 'deepseek-v4' ? '图片文字识别' : (capabilities.multiImageInput ? `图片（多图 ${capabilities.maxAttachments}）` : '图片'));
    if (capabilities.fileInput) parts.push('附件');
    return parts.join(' / ');
  }
  if (!capabilities.imageInput && !capabilities.fileInput) return 'Image/file input not enabled';
  const parts = [] as string[];
  if (capabilities.imageInput) parts.push(reasoningSupport.source === 'deepseek-v4' ? 'image OCR' : (capabilities.multiImageInput ? `images (${capabilities.maxAttachments})` : 'image'));
  if (capabilities.fileInput) parts.push('file');
  return parts.join(' / ');
}

export function getInputCapabilitySource(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  if (!profile) return 'none' as const;
  const baseUrl = 'baseUrl' in profile ? String((profile as typeof profile & { baseUrl?: string }).baseUrl || '') : '';
  if (profile.provider === 'official' || String(profile.provider).startsWith('official-') || baseUrl.replace(/\/+$/, '') === '/api/ai') return 'official' as const;
  if (profile.provider === 'anthropic' || profile.provider === 'google') return 'official' as const;
  return inferTextInputCapabilities(profile.provider, profile.model).imageInput || inferTextInputCapabilities(profile.provider, profile.model).fileInput
    ? 'third-party-inferred' as const
    : 'unsupported' as const;
}

export function getInputCapabilityWarning(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null, language: Language = 'zh') {
  if (getInputCapabilitySource(profile) !== 'third-party-inferred') return '';
  const support = profile ? inferReasoningModeSupport(profile.provider, profile.model) : { source: 'unsupported' as const };
  if (support.source === 'deepseek-v4') {
    return language === 'zh'
      ? 'DeepSeek V4 的图片输入主要用于识别图片中的文字，不等同于通用视觉理解。'
      : 'DeepSeek V4 image input is mainly for OCR, not general visual understanding.';
  }
  return language === 'zh'
    ? '按模型名推断当前第三方模型可能支持图片输入，但实际兼容性取决于服务商实现，发送失败时请关闭该能力。'
    : 'This third-party model is inferred by name to support image input, but actual compatibility depends on the provider implementation.';
}

export function getInputCapabilityBadge(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null, language: Language = 'zh') {
  const source = getInputCapabilitySource(profile);
  if (source === 'official') return language === 'zh' ? '官方通道' : 'Official channel';
  if (source === 'third-party-inferred') return language === 'zh' ? '第三方推断' : '3rd-party inferred';
  return language === 'zh' ? '不支持' : 'Unsupported';
}

export function shouldShowInputCapabilityWarning(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return getInputCapabilitySource(profile) === 'third-party-inferred';
}

export function isUnsupportedInputCapability(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return getInputCapabilitySource(profile) === 'unsupported';
}

export function isThirdPartyInferredInputCapability(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return getInputCapabilitySource(profile) === 'third-party-inferred';
}

export function isOfficialInputCapability(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return getInputCapabilitySource(profile) === 'official';
}

export function getInputCapabilityDescription(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null, language: Language = 'zh') {
  const summary = getAttachmentUiCapabilitySummary(profile, language);
  const badge = getInputCapabilityBadge(profile, language);
  return `${badge} · ${summary}`;
}

export function canEnableImageInputByDefault(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return Boolean(profile) && inferTextInputCapabilities(profile!.provider, profile!.model).imageInput;
}

export function canEnableFileInputByDefault(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return Boolean(profile) && inferTextInputCapabilities(profile!.provider, profile!.model).fileInput;
}

export function canEnableMultiImageInputByDefault(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return Boolean(profile) && inferTextInputCapabilities(profile!.provider, profile!.model).multiImageInput;
}

export function getInferredInputCapabilityState(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return profile ? inferTextInputCapabilities(profile.provider, profile.model) : normalizeInputCapabilities();
}

export function getInferredInputCapabilitySummary(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null, language: Language = 'zh') {
  const inferred = getInferredInputCapabilityState(profile);
  if (language === 'zh') {
    if (!inferred.imageInput && !inferred.fileInput) return '未识别到图片/附件输入支持';
    const parts = [] as string[];
    if (inferred.imageInput) parts.push(inferred.multiImageInput ? `图片（多图 ${inferred.maxAttachments}）` : '图片');
    if (inferred.fileInput) parts.push('附件');
    return parts.join(' / ');
  }
  if (!inferred.imageInput && !inferred.fileInput) return 'No inferred image/file input support';
  const parts = [] as string[];
  if (inferred.imageInput) parts.push(inferred.multiImageInput ? `images (${inferred.maxAttachments})` : 'image');
  if (inferred.fileInput) parts.push('file');
  return parts.join(' / ');
}

export function shouldLockInputCapability(key: keyof Pick<AIModelInputCapabilities, 'imageInput' | 'multiImageInput' | 'fileInput'>, profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return getInputCapabilityLockState(profile)[key];
}

export function getInputCapabilityUiMeta(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null, language: Language = 'zh') {
  return {
    badge: getInputCapabilityBadge(profile, language),
    warning: getInputCapabilityWarning(profile, language),
    summary: getInputCapabilityDescription(profile, language),
    source: getInputCapabilitySource(profile),
  };
}

export function isInputCapabilityLocked(key: keyof Pick<AIModelInputCapabilities, 'imageInput' | 'multiImageInput' | 'fileInput'>, profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return shouldLockInputCapability(key, profile);
}

export function buildResolvedInputCapabilityState(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return resolveAIModelInputCapabilities(profile);
}

export function buildResolvedInputCapabilityUi(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null, language: Language = 'zh') {
  return {
    capabilities: resolveAIModelInputCapabilities(profile),
    meta: getInputCapabilityUiMeta(profile, language),
    locks: getInputCapabilityLockState(profile),
  };
}

export function shouldAllowImageUploadUi(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return resolveAIModelInputCapabilities(profile).imageInput;
}

export function shouldAllowMultiImageUploadUi(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  const resolved = resolveAIModelInputCapabilities(profile);
  return resolved.imageInput && resolved.multiImageInput;
}

export function shouldAllowFileUploadUi(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return resolveAIModelInputCapabilities(profile).fileInput;
}

export function getResolvedInputCapabilityMax(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return resolveAIModelInputCapabilities(profile).maxAttachments;
}

export function getResolvedInputCapabilityMimes(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return resolveAIModelInputCapabilities(profile).supportedMimeTypes;
}

export function getResolvedInputCapabilityWarning(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null, language: Language = 'zh') {
  return getInputCapabilityWarning(profile, language);
}

export function getResolvedInputCapabilityBadge(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null, language: Language = 'zh') {
  return getInputCapabilityBadge(profile, language);
}

export function getResolvedInputCapabilitySource(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return getInputCapabilitySource(profile);
}

export function getResolvedInputCapabilityDescription(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null, language: Language = 'zh') {
  return getInputCapabilityDescription(profile, language);
}

export function getResolvedInputCapabilityLocks(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return getInputCapabilityLockState(profile);
}

export function shouldDefaultEnableInputCapability(key: keyof Pick<AIModelInputCapabilities, 'imageInput' | 'multiImageInput' | 'fileInput'>, profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  const inferred = getInferredInputCapabilityState(profile);
  return Boolean(inferred[key]);
}

export function shouldShowInputCapabilityBadge(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return Boolean(profile);
}

export function shouldShowInputCapabilitySummary(profile?: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null) {
  return Boolean(profile);
}

export function shouldShowInputCapabilityWarningText(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null) {
  return shouldShowInputCapabilityWarning(profile);
}

export function getInputCapabilityToggleHelp(profile?: Pick<AIModelProfile, 'provider' | 'model'> | null, language: Language = 'zh') {
  return getInputCapabilityWarning(profile, language);
}

export function canToggleInputCapabilityByKey(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined, key: keyof Pick<AIModelInputCapabilities, 'imageInput' | 'multiImageInput' | 'fileInput'>) {
  if (!profile) return false;
  const inferred = inferTextInputCapabilities(profile.provider, profile.model);
  return Boolean(inferred[key]);
}

export function isImageInputToggleEnabled(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined) {
  return canToggleInputCapabilityByKey(profile, 'imageInput');
}

export function isMultiImageInputToggleEnabled(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined) {
  return canToggleInputCapabilityByKey(profile, 'multiImageInput');
}

export function isFileInputToggleEnabled(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined) {
  return canToggleInputCapabilityByKey(profile, 'fileInput');
}

export function getInputCapabilityProviderState(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined) {
  return {
    imageInput: isImageInputToggleEnabled(profile),
    multiImageInput: isMultiImageInputToggleEnabled(profile),
    fileInput: isFileInputToggleEnabled(profile),
  };
}

export function getInputCapabilityProviderSummary(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined, language: Language = 'zh') {
  return getInferredInputCapabilitySummary(profile, language);
}

export function getInputCapabilityProviderWarning(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined, language: Language = 'zh') {
  return getInputCapabilityWarning(profile, language);
}

export function isProviderInferenceRisk(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined) {
  return getInputCapabilitySource(profile) === 'third-party-inferred';
}

export function shouldKeepToggleInteractive(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined, key: keyof Pick<AIModelInputCapabilities, 'imageInput' | 'multiImageInput' | 'fileInput'>) {
  return canToggleInputCapabilityByKey(profile, key);
}

export function getInputCapabilityLockReason(profile: Pick<AIModelProfile, 'provider' | 'model'> | null | undefined, language: Language = 'zh') {
  if (!profile) return language === 'zh' ? '当前模型未识别到该输入能力，不能手动开启。' : 'This model was not identified as supporting this input capability.';
  if (isProviderInferenceRisk(profile)) return getInputCapabilityWarning(profile, language);
  return language === 'zh' ? '当前模型未识别到该输入能力，不能手动开启。' : 'This model was not identified as supporting this input capability.';
}

export function getAttachmentUiCapabilityText(profile: Pick<AIModelProfile, 'provider' | 'model' | 'type' | 'inputCapabilities'> | null | undefined, language: Language = 'zh') {
  return getAttachmentUiCapabilitySummary(profile, language);
}

export function normalizeAIProfiles(aiProfiles?: AIModelProfile[], api?: APIConfig): AIModelProfile[] {
  const sourceProfiles = Array.isArray(aiProfiles) && aiProfiles.length > 0
    ? aiProfiles
    : [{
        ...DEFAULT_AI_PROFILE,
        ...(api || DEFAULT_AI_PROFILE),
        id: 'default',
        name: 'Default',
        type: 'text' as AIModelType,
        isDefault: true,
      }];

  const seenDefaultTypes = new Set<AIModelType>();
  const normalized: AIModelProfile[] = sourceProfiles.map((profile, index) => {
    const type = profile.type || 'text';
    const isDefault = Boolean(profile.isDefault) && !seenDefaultTypes.has(type);
    if (isDefault) seenDefaultTypes.add(type);
    const migrateDefaultImage = profile.id === 'default-image' && type === 'image' && profile.isDefault === true
      && profile.provider === 'official-nanobanana' && profile.baseUrl === '/api/ai'
      && profile.model === 'gemini-3-pro-image-preview';
    const provider = migrateDefaultImage ? DEFAULT_IMAGE_AI_PROFILE.provider : profile.provider || DEFAULT_AI_PROFILE.provider;
    const baseUrl = profile.baseUrl || DEFAULT_AI_PROFILE.baseUrl;
    const model = normalizeDeepSeekModelName(provider, baseUrl, migrateDefaultImage ? DEFAULT_IMAGE_AI_PROFILE.model : profile.model || DEFAULT_AI_PROFILE.model);
    return {
      ...DEFAULT_AI_PROFILE,
      ...profile,
      provider,
      baseUrl,
      model,
      maxOutputTokens: normalizeMaxOutputTokens(profile.maxOutputTokens),
      id: profile.id || (index === 0 ? 'default' : `profile-${index + 1}`),
      name: profile.name || (index === 0 ? 'Default' : `Model ${index + 1}`),
      type,
      isDefault,
      imageCapabilities: type === 'image' ? normalizeImageCapabilities(profile.imageCapabilities) : undefined,
      defaultImageSize: type === 'image' ? normalizeImageGenerationSize(profile.defaultImageSize) : undefined,
      inputCapabilities: type === 'text' ? resolveAIModelInputCapabilities(profile) : undefined,
      advancedOptions: type === 'text' ? normalizeAIModelAdvancedOptions(provider, model, profile.advancedOptions) : undefined,
    };
  });

  if (!normalized.some((profile) => profile.type === 'image')) {
    normalized.push({ ...DEFAULT_IMAGE_AI_PROFILE });
  }
  if (!normalized.some((profile) => profile.type === 'tts')) {
    normalized.push({ ...DEFAULT_TTS_AI_PROFILE });
  }
  if (!normalized.some((profile) => profile.type === 'stt')) {
    normalized.push({ ...DEFAULT_STT_AI_PROFILE });
  }

  for (const type of ['text', 'image', 'tts', 'stt', 'audio', 'document'] as AIModelType[]) {
    const items = normalized.filter((profile) => profile.type === type);
    if (items.length === 1) items[0].isDefault = true;
  }

  return normalized;
}

export interface ChatDraftDefaults {
  style: 'free' | 'debate' | 'brainstorm' | 'roleplay';
  showRoleActions: boolean;
  includeUserAsMember: boolean;
  runtimeEvolutionIntensity: RuntimeEvolutionIntensity;
}


export interface ChatDraftDefaults {
  style: 'free' | 'debate' | 'brainstorm' | 'roleplay';
  showRoleActions: boolean;
  includeUserAsMember: boolean;
  runtimeEvolutionIntensity: RuntimeEvolutionIntensity;
}

import type { BubbleStyleDefinition } from './bubbleStyle';

export interface DeveloperUIPrefs {
  autoApplyCodeUpdates: boolean;
  showMemoryDebug: boolean;
  showRelationshipEvents: boolean;
  showAffectEvents: boolean;
  showConflictEvents: boolean;
  showStateEvents: boolean;
  showMemoryDistillationEvents: boolean;
  showCalendarEvents: boolean;
  showLocalInterceptionHints: boolean;
  showSpeechStyle: boolean;
  showAdvancedRuntimePanels: boolean;
  showDeliberationDebug: boolean;
  showPresenceDebug: boolean;
  showCompanionshipDebug: boolean;
  showMomentDebug: boolean;
  showWithdrawnMessageContent: boolean;
  enableHumanAppraisal: boolean;
  dramaBoost: boolean;
}

export type DeveloperUISettings = DeveloperUIPrefs;

export function isAffectEventsVisible(prefs: DeveloperUIPrefs) {
  return Boolean(prefs.showAffectEvents);
}

export function getDeveloperAffectDefault() {
  return false;
}

export function getDeveloperUiDefaults() {
  return DEFAULT_DEVELOPER_UI_PREFS;
}

export function normalizeDeveloperUiPrefs(input?: Partial<DeveloperUIPrefs> | null): DeveloperUIPrefs {
  return {
    autoApplyCodeUpdates: Boolean(input?.autoApplyCodeUpdates),
    showMemoryDebug: Boolean(input?.showMemoryDebug),
    showRelationshipEvents: Boolean(input?.showRelationshipEvents),
    showAffectEvents: Boolean(input?.showAffectEvents),
    showConflictEvents: Boolean(input?.showConflictEvents),
    showStateEvents: Boolean(input?.showStateEvents),
    showMemoryDistillationEvents: Boolean(input?.showMemoryDistillationEvents),
    showCalendarEvents: Boolean(input?.showCalendarEvents),
    showLocalInterceptionHints: Boolean(input?.showLocalInterceptionHints),
    showSpeechStyle: Boolean(input?.showSpeechStyle),
    showAdvancedRuntimePanels: Boolean(input?.showAdvancedRuntimePanels),
    showDeliberationDebug: Boolean(input?.showDeliberationDebug),
    showPresenceDebug: Boolean(input?.showPresenceDebug),
    showCompanionshipDebug: Boolean(input?.showCompanionshipDebug),
    showMomentDebug: Boolean(input?.showMomentDebug),
    showWithdrawnMessageContent: Boolean(input?.showWithdrawnMessageContent),
    enableHumanAppraisal: input?.enableHumanAppraisal ?? DEFAULT_DEVELOPER_UI_PREFS.enableHumanAppraisal,
    dramaBoost: Boolean(input?.dramaBoost),
  };
}

export function mergeDeveloperUiPrefs(input?: Partial<DeveloperUIPrefs> | null) {
  return {
    ...DEFAULT_DEVELOPER_UI_PREFS,
    ...(input || {}),
    showAffectEvents: Boolean(input?.showAffectEvents),
    enableHumanAppraisal: input?.enableHumanAppraisal ?? DEFAULT_DEVELOPER_UI_PREFS.enableHumanAppraisal,
  } satisfies DeveloperUIPrefs;
}

export function getDeveloperUiPrefValue(input: Partial<DeveloperUIPrefs> | null | undefined, key: keyof DeveloperUIPrefs) {
  return Boolean(input?.[key]);
}

export function getDeveloperUiVisibility(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiToggleKeys() {
  return ['showMemoryDebug', 'showRelationshipEvents', 'showAffectEvents', 'showConflictEvents', 'showStateEvents', 'showMemoryDistillationEvents', 'showCalendarEvents', 'showLocalInterceptionHints', 'showSpeechStyle', 'showAdvancedRuntimePanels', 'showDeliberationDebug', 'showPresenceDebug', 'showCompanionshipDebug', 'showMomentDebug', 'showWithdrawnMessageContent', 'enableHumanAppraisal', 'dramaBoost'] as const;
}

export function getDeveloperUiAffectKey() {
  return 'showAffectEvents' as const;
}

export function getDeveloperUiShape(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiPrefs(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiConfig(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiModel(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiSummary(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiSnapshot(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiNormalized(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiRuntime(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiFlags(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiDisplay(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiPayload(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiData(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiEnvelope(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiRecord(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiCurrent(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiValue(input: Partial<DeveloperUIPrefs> | null | undefined, key: keyof DeveloperUIPrefs) {
  return getDeveloperUiPrefValue(input, key);
}

export function getDeveloperUiBoolean(input: Partial<DeveloperUIPrefs> | null | undefined, key: keyof DeveloperUIPrefs) {
  return getDeveloperUiPrefValue(input, key);
}

export function getDeveloperUiAffectVisibility(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return Boolean(input?.showAffectEvents);
}

export function getDeveloperUiRelationshipVisibility(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return Boolean(input?.showRelationshipEvents);
}

export function getDeveloperUiMemoryVisibility(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return Boolean(input?.showMemoryDebug);
}

export function getDeveloperUiSpeechVisibility(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return Boolean(input?.showSpeechStyle);
}

export function getDeveloperUiAdvancedVisibility(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return Boolean(input?.showAdvancedRuntimePanels);
}

export function getDeveloperUiDramaVisibility(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return Boolean(input?.dramaBoost);
}

export function getDeveloperUiHintVisibility(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiToggleState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiPanelState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiEventState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiEventVisibility(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiDiagnostics(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiDefaultsSnapshot() {
  return DEFAULT_DEVELOPER_UI_PREFS;
}

export function getDeveloperUiDefaultAffectValue() {
  return false;
}

export function getDeveloperUiAffectDefaultValue() {
  return false;
}

export function getDeveloperUiToggleStateByKey(input: Partial<DeveloperUIPrefs> | null | undefined, key: keyof DeveloperUIPrefs) {
  return getDeveloperUiPrefValue(input, key);
}

export function getDeveloperUiAffectToggle(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return Boolean(input?.showAffectEvents);
}

export function getDeveloperUiEventToggle(input: Partial<DeveloperUIPrefs> | null | undefined) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiShapeState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiSettings(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiDeveloperState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiDeveloperSettings(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiEffectiveState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiEffectivePrefs(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiResolved(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiResolvedState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiResolvedPrefs(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiComputed(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiComputedState(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiComputedPrefs(input?: Partial<DeveloperUIPrefs> | null) {
  return normalizeDeveloperUiPrefs(input);
}

export function getDeveloperUiAffectComputed(input?: Partial<DeveloperUIPrefs> | null) {
  return Boolean(input?.showAffectEvents);
}

export function getDeveloperUiRelationshipComputed(input?: Partial<DeveloperUIPrefs> | null) {
  return Boolean(input?.showRelationshipEvents);
}

export function getDeveloperUiMemoryComputed(input?: Partial<DeveloperUIPrefs> | null) {
  return Boolean(input?.showMemoryDebug);
}

export function getDeveloperUiSpeechComputed(input?: Partial<DeveloperUIPrefs> | null) {
  return Boolean(input?.showSpeechStyle);
}

export function getDeveloperUiAdvancedComputed(input?: Partial<DeveloperUIPrefs> | null) {
  return Boolean(input?.showAdvancedRuntimePanels);
}

export function getDeveloperUiDramaComputed(input?: Partial<DeveloperUIPrefs> | null) {
  return Boolean(input?.dramaBoost);
}

export interface AvatarGenerationSettings {
  autoGenerateCharacterAvatar: boolean;
  preferNonPhotorealAvatar: boolean;
}

export interface AIGenerationSettings {
  enableMoments: boolean;
  enableDiaries: boolean;
}

export type CompanionshipCareIntensity = 'restrained' | 'balanced' | 'expressive';
export type CompanionshipRitualKind = 'daily_greeting' | 'anniversary' | 'inside_joke' | 'pet_name' | 'reconciliation' | 'milestone';
export type MemoryVisibleRecallMode = 'implicit' | 'balanced' | 'direct';

export interface CompanionshipSettings {
  enableProactiveCare: boolean;
  showStatusHints: boolean;
  enableAttachmentAdaptation: boolean;
  enableRelationshipRituals: boolean;
  ritualKindToggles: Record<CompanionshipRitualKind, boolean>;
  enableCharacterPrivateThreads: boolean;
  pendingPromiseRetentionDays: number;
  privateThreadCooldownHours: number;
  proactiveCooldownMinutes: {
    checkIn: number;
    reactToMoment: number;
    socialOuting: number;
    statusUpdate: number;
  };
  sensitiveBoundaryMode: 'normal' | 'restrained' | 'off';
  allowGoodMorning: boolean;
  allowGoodNight: boolean;
  allowMissYou: boolean;
  careIntensity: CompanionshipCareIntensity;
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
    suppressStatusHints: boolean;
    suppressProactiveCare: boolean;
  };
}

export interface ChatMemorySettings {
  enabled: boolean;
  visibleRecallMode: MemoryVisibleRecallMode;
  maxCuesPerTurn: number;
  cueCooldownTurns: number;
}

export interface UsageStats {
  aiMessageCount: number;
  updatedAt: number;
}

export interface ChatAppearanceSettings {
  maxContentWidth: number;
  maxContentWidthUnlimited: boolean;
  voiceWaveformStyle: 'wave' | 'blocks' | 'neon' | 'spectrum' | 'pulse' | 'orbit' | 'ribbon' | 'echo' | 'constellation' | 'helix' | 'comet';
  storyReader: {
    fontFamily: 'default' | 'serif' | 'sans';
    fontSize: number;
    lineHeight: number;
    revealMode: 'fade' | 'instant';
  };
}

export interface AppSettings {
  api: APIConfig;
  aiProfiles: AIModelProfile[];
  theme: ThemeMode;
  themePreset: ThemePresetId;
  themeColor: string;
  language: Language;
  defaultSpeed: number;
  compactBubbleMode: boolean;
  compactPrivateBubbleMode: boolean;
  hidePrivateChatIdentity: boolean;
  enableStreamingDisplayAnimation: boolean;
  showVoiceTranscript: boolean;
  enableChatStickers: boolean;
  developerMode: boolean;
  avatarGeneration: AvatarGenerationSettings;
  aiGeneration: AIGenerationSettings;
  companionship: CompanionshipSettings;
  chatMemory: ChatMemorySettings;
  chatReplyPreferences: ChatReplyPreferences;
  developerUI: DeveloperUIPrefs;
  chatDraftDefaults: ChatDraftDefaults;
  customBubbleStyles: BubbleStyleDefinition[];
  userBubbleStyleId: string | null;
  userBubbleStyle: BubbleStyleDefinition | null;
  artifactAppearance: ArtifactAppearanceSettings;
  chatAppearance: ChatAppearanceSettings;
  usageStats: UsageStats;
}

export const DEFAULT_DEVELOPER_UI_PREFS: DeveloperUIPrefs = {
  autoApplyCodeUpdates: false,
  showMemoryDebug: false,
  showRelationshipEvents: false,
  showAffectEvents: false,
  showConflictEvents: false,
  showStateEvents: false,
  showMemoryDistillationEvents: false,
  showCalendarEvents: false,
  showLocalInterceptionHints: false,
  showSpeechStyle: false,
  showAdvancedRuntimePanels: false,
  showDeliberationDebug: false,
  showPresenceDebug: false,
  showCompanionshipDebug: false,
  showMomentDebug: false,
  showWithdrawnMessageContent: false,
  enableHumanAppraisal: true,
  dramaBoost: false,
};

export const DEFAULT_AVATAR_GENERATION_SETTINGS: AvatarGenerationSettings = {
  autoGenerateCharacterAvatar: true,
  preferNonPhotorealAvatar: true,
};

export const DEFAULT_AI_GENERATION_SETTINGS: AIGenerationSettings = {
  enableMoments: true,
  enableDiaries: true,
};

export const DEFAULT_COMPANIONSHIP_SETTINGS: CompanionshipSettings = {
  enableProactiveCare: true,
  showStatusHints: true,
  enableAttachmentAdaptation: true,
  enableRelationshipRituals: true,
  ritualKindToggles: {
    daily_greeting: true,
    anniversary: true,
    inside_joke: true,
    pet_name: true,
    reconciliation: true,
    milestone: true,
  },
  enableCharacterPrivateThreads: true,
  pendingPromiseRetentionDays: 30,
  privateThreadCooldownHours: 6,
  proactiveCooldownMinutes: {
    checkIn: 120,
    reactToMoment: 120,
    socialOuting: 360,
    statusUpdate: 90,
  },
  sensitiveBoundaryMode: 'restrained',
  allowGoodMorning: true,
  allowGoodNight: true,
  allowMissYou: true,
  careIntensity: 'balanced',
  quietHours: {
    enabled: true,
    start: '23:30',
    end: '08:00',
    suppressStatusHints: true,
    suppressProactiveCare: true,
  },
};

export const DEFAULT_CHAT_MEMORY_SETTINGS: ChatMemorySettings = {
  enabled: true,
  visibleRecallMode: 'balanced',
  maxCuesPerTurn: 3,
  cueCooldownTurns: 8,
};

export function normalizeChatMemorySettings(input?: Partial<ChatMemorySettings> | null): ChatMemorySettings {
  const visibleRecallMode: MemoryVisibleRecallMode = input?.visibleRecallMode === 'implicit' || input?.visibleRecallMode === 'direct'
    ? input.visibleRecallMode
    : 'balanced';
  return {
    enabled: input?.enabled ?? DEFAULT_CHAT_MEMORY_SETTINGS.enabled,
    visibleRecallMode,
    maxCuesPerTurn: Math.max(0, Math.min(3, Math.round(Number(input?.maxCuesPerTurn ?? DEFAULT_CHAT_MEMORY_SETTINGS.maxCuesPerTurn)))),
    cueCooldownTurns: Math.max(0, Math.min(24, Math.round(Number(input?.cueCooldownTurns ?? DEFAULT_CHAT_MEMORY_SETTINGS.cueCooldownTurns)))),
  };
}

export const DEFAULT_USAGE_STATS: UsageStats = {
  aiMessageCount: 0,
  updatedAt: 0,
};

export const DEFAULT_CHAT_APPEARANCE_SETTINGS: ChatAppearanceSettings = {
  maxContentWidth: 760,
  maxContentWidthUnlimited: false,
  voiceWaveformStyle: 'wave',
  storyReader: {
    fontFamily: 'default',
    fontSize: 16,
    lineHeight: 2.05,
    revealMode: 'fade',
  },
};

export type AppSettingsWithMemory = AppSettings & { memoryUI: { showDeveloperMemory?: boolean } };

const OFFICIAL_DEEPSEEK_LEGACY_MODEL_MAP: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
};

function normalizeDeepSeekModelName(provider: AIProvider, baseUrl: string, model: string) {
  const normalizedModel = model.trim();
  if ((provider === 'official-deepseek' && baseUrl === '/api/ai') || provider === 'deepseek') {
    return OFFICIAL_DEEPSEEK_LEGACY_MODEL_MAP[normalizedModel] || normalizedModel || 'deepseek-v4-flash';
  }
  return normalizedModel;
}

export const DEFAULT_API_CONFIG: APIConfig = {
  provider: 'official-deepseek',
  apiKey: '',
  baseUrl: '/api/ai',
  model: 'deepseek-v4-flash',
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
};

export const DEFAULT_IMAGE_CAPABILITIES: AIModelImageCapabilities = {
  textToImage: true,
  referenceImage: true,
  multiReferenceImage: true,
  seed: false,
  negativePrompt: false,
};

export const DEFAULT_AI_PROFILE: AIModelProfile = {
  id: 'default',
  name: 'Default',
  type: 'text',
  isDefault: true,
  ...DEFAULT_API_CONFIG,
};

export const DEFAULT_IMAGE_AI_PROFILE: AIModelProfile = {
  id: 'default-image',
  name: '官方图片',
  type: 'image',
  isDefault: true,
  provider: 'official-acedata',
  apiKey: '',
  baseUrl: '/api/ai',
  model: 'nano-banana-pro',
  imageCapabilities: DEFAULT_IMAGE_CAPABILITIES,
  defaultImageSize: '1K',
};

export const DEFAULT_TTS_AI_PROFILE: AIModelProfile = {
  id: 'default-tts',
  name: '官方语音（TTS）',
  type: 'tts',
  isDefault: true,
  provider: 'official',
  apiKey: '',
  baseUrl: '/api',
  model: 'speech-tts',
};

export const DEFAULT_STT_AI_PROFILE: AIModelProfile = {
  id: 'default-stt',
  name: '官方语音（STT）',
  type: 'stt',
  isDefault: true,
  provider: 'official',
  apiKey: '',
  baseUrl: '/api',
  model: 'speech-stt',
};

export function normalizeImageCapabilities(input?: Partial<AIModelImageCapabilities> | null): AIModelImageCapabilities {
  return {
    ...DEFAULT_IMAGE_CAPABILITIES,
    ...(input || {}),
    textToImage: input?.textToImage ?? DEFAULT_IMAGE_CAPABILITIES.textToImage,
    referenceImage: Boolean(input?.referenceImage),
    multiReferenceImage: Boolean(input?.multiReferenceImage),
    seed: Boolean(input?.seed),
    negativePrompt: Boolean(input?.negativePrompt),
  };
}

export function getDefaultAIProfile(aiProfiles: AIModelProfile[], type: AIModelType) {
  return normalizeAIProfiles(aiProfiles).find((profile) => profile.type === type && profile.isDefault) || null;
}

export function getPreferredAIProfile(aiProfiles: AIModelProfile[], type: AIModelType) {
  const normalized = normalizeAIProfiles(aiProfiles);
  return normalized.find((profile) => profile.type === type && profile.isDefault)
    || normalized.find((profile) => profile.type === type)
    || null;
}

export function isAIProfileUsable<T extends Pick<APIConfig, 'apiKey' | 'model'>>(profile: T | null | undefined): profile is T {
  if (!profile?.model?.trim()) return false;
  const provider = 'provider' in profile ? (profile as T & Pick<APIConfig, 'provider'>).provider : null;
  const baseUrl = 'baseUrl' in profile ? String((profile as T & { baseUrl?: string }).baseUrl || '') : '';
  return provider === 'official' || String(provider).startsWith('official-') || baseUrl.replace(/\/+$/, '') === '/api/ai' || Boolean(profile.apiKey?.trim());
}

export function getUsablePreferredAIProfile(aiProfiles: AIModelProfile[], type: AIModelType) {
  const profile = getPreferredAIProfile(aiProfiles, type);
  return isAIProfileUsable(profile) ? profile : null;
}

export function getUsableDefaultTextAIProfile(aiProfiles: AIModelProfile[]) {
  return getUsablePreferredAIProfile(aiProfiles, 'text');
}

export function hasUsableDefaultTextAI(aiProfiles: AIModelProfile[]) {
  return Boolean(getUsableDefaultTextAIProfile(aiProfiles));
}

export const DEFAULT_CHAT_DRAFT_DEFAULTS: ChatDraftDefaults = {
  style: 'free',
  showRoleActions: true,
  includeUserAsMember: true,
  runtimeEvolutionIntensity: 'balanced',
};

export const DEFAULT_SETTINGS: AppSettingsWithMemory = {
  api: DEFAULT_API_CONFIG,
  aiProfiles: [DEFAULT_AI_PROFILE, DEFAULT_IMAGE_AI_PROFILE],
  theme: 'system',
  themePreset: 'aurora',
  themeColor: '#5B6CFF',
  language: 'zh',
  defaultSpeed: 1.0,
  compactBubbleMode: false,
  compactPrivateBubbleMode: true,
  hidePrivateChatIdentity: true,
  enableStreamingDisplayAnimation: true,
  showVoiceTranscript: false,
  enableChatStickers: true,
  developerMode: false,
  avatarGeneration: DEFAULT_AVATAR_GENERATION_SETTINGS,
  aiGeneration: DEFAULT_AI_GENERATION_SETTINGS,
  companionship: DEFAULT_COMPANIONSHIP_SETTINGS,
  chatMemory: DEFAULT_CHAT_MEMORY_SETTINGS,
  chatReplyPreferences: DEFAULT_CHAT_REPLY_PREFERENCES,
  developerUI: DEFAULT_DEVELOPER_UI_PREFS,
  chatDraftDefaults: DEFAULT_CHAT_DRAFT_DEFAULTS,
  customBubbleStyles: [],
  userBubbleStyleId: null,
  userBubbleStyle: null,
  artifactAppearance: DEFAULT_ARTIFACT_APPEARANCE_SETTINGS,
  chatAppearance: DEFAULT_CHAT_APPEARANCE_SETTINGS,
  usageStats: DEFAULT_USAGE_STATS,
  memoryUI: { showDeveloperMemory: false },
};
