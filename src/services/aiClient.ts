import type { APIConfig, AIModelProfile } from '../types/settings';
import { normalizeAIModelAdvancedOptions, normalizeMaxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS } from '../types/settings';
import { api } from './api';
import { backendUrl } from './backendUrl';
import { redactAiDiagnosticText } from './aiDiagnosticText';
import { assertWorkspaceActive, getResponseWorkspaceSignal, workspaceFetch as fetch } from './workspaceLifecycle';

type ChatRole = 'user' | 'assistant' | 'system';
export interface ChatMessageImageAttachment {
  url: string;
  mimeType?: string;
}

type ChatMessage = { role: ChatRole; content: string; attachments?: ChatMessageImageAttachment[] };
type OpenAICompatibleMessageContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>;
type MaybeTypedConfig = APIConfig & Partial<Pick<AIModelProfile, 'type'>>;
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
export type AiUsageType =
  | 'assistant_chat'
  | 'direct_chat'
  | 'group_chat'
  | 'story_chat'
  | 'group_creation'
  | 'character_generation'
  | 'character_visual_identity'
  | 'relationship_analysis'
  | 'memory_distillation'
  | 'memory_refinement'
  | 'character_core_profile'
  | 'user_profile_memory'
  | 'companionship_assessment'
  | 'companionship_care'
  | 'companionship_phase'
  | 'companionship_ritual'
  | 'world_decision'
  | 'message_analysis'
  | 'interaction_analysis'
  | 'social_event_analysis'
  | 'chat_draft'
  | 'character_artifact'
  | 'moment_generation'
  | 'image_generation'
  | 'web_search'
  | 'model_test'
  | 'other';

export type AiUsageMetadata = {
  type: AiUsageType;
  label?: string;
  scope?: string;
  resourceId?: string;
  relatedIds?: string[];
};

export type GenerateResponseOptions = {
  responseFormat?: 'text' | 'json';
  maxTokens?: number;
  maxInputChars?: number;
  signal?: AbortSignal;
  aiUsage?: AiUsageMetadata;
};

const DEFAULT_MAX_TEXT_INPUT_CHARS = 600_000;
const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
const INLINE_IMAGE_DATA_URL_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]{1024,}/i;

function isLegacyOfficialProvider(provider: APIConfig['provider']) {
  return provider === 'official' || String(provider).startsWith('official-');
}

function resolveOfficialBackendProvider(provider: APIConfig['provider']) {
  if (provider === 'official' || provider === 'official-moacode') return 'official-2';
  if (provider === 'official-deepseek') return 'official-1';
  if (provider === 'official-moacode-team') return 'official-team';
  if (provider === 'official-gpt') return 'official-4';
  return provider;
}

function usesOfficialProxy(config: APIConfig) {
  return isLegacyOfficialProvider(config.provider) || trimTrailingSlashes(config.baseUrl) === '/api/ai';
}

export interface AvailableModelInfo {
  id: string;
  label: string;
  raw?: JSONValue;
}

export interface ImageGenerationOptions {
  prompt: string;
  size?: string;
  aspectRatio?: string;
  imageSize?: '1K' | '2K' | '4K' | string;
  count?: number;
  negativePrompt?: string;
  seed?: string | number | null;
  referenceImages?: Array<{
    url: string;
    mimeType?: string;
  }>;
  signal?: AbortSignal;
  aiUsage?: AiUsageMetadata;
}

export interface GeneratedImage {
  mimeType: string;
  dataUrl: string;
  revisedPrompt?: string;
  url?: string;
}

export interface SpeechSynthesisOptions {
  input: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
  language?: string;
  style?: string;
  speed?: number;
  pitch?: number;
}

export interface SpeechSynthesisResult {
  mimeType: string;
  blob: Blob;
  objectUrl: string;
}

export interface AudioTranscriptionOptions {
  file: Blob;
  fileName?: string;
  prompt?: string;
  language?: string;
}

export interface AudioTranscriptionResult {
  text: string;
  raw?: JSONValue;
}

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string) {
  return `${trimTrailingSlashes(baseUrl)}/${path.replace(/^\/+/, '')}`;
}

function encodeDataUrl(mimeType: string, base64: string) {
  return `data:${mimeType};base64,${base64}`;
}

function guessAudioMimeType(format?: string) {
  switch (format) {
    case 'wav': return 'audio/wav';
    case 'opus': return 'audio/ogg';
    case 'aac': return 'audio/aac';
    case 'flac': return 'audio/flac';
    case 'pcm': return 'audio/pcm';
    default: return 'audio/mpeg';
  }
}

function createObjectUrl(blob: Blob) {
  return URL.createObjectURL(blob);
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number, timeoutReason: string) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      signal,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let externalAbortHandler: (() => void) | null = null;

  if (signal?.aborted) {
    controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
  } else {
    externalAbortHandler = () => controller.abort(signal?.reason || new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', externalAbortHandler, { once: true });
    timeoutHandle = setTimeout(() => {
      controller.abort(new Error(timeoutReason));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (externalAbortHandler && signal) signal.removeEventListener('abort', externalAbortHandler);
    },
  };
}

function splitSystemMessages(messages: ChatMessage[], systemPrompt: string) {
  const systemParts = [
    systemPrompt.trim(),
    ...messages.filter((message) => message.role === 'system').map((message) => message.content.trim()),
  ].filter(Boolean);

  const conversation = messages.filter((message) => message.role !== 'system');
  return {
    systemPrompt: systemParts.join('\n\n'),
    conversation: conversation.length > 0 ? conversation : [{ role: 'user' as const, content: 'Hello' }],
  };
}

function assertTextInputWithinBudget(systemPrompt: string, messages: ChatMessage[], options: GenerateResponseOptions = {}) {
  const textParts = [systemPrompt, ...messages.map((message) => message.content || '')];
  const inlineDataUrlPart = textParts.find((part) => INLINE_IMAGE_DATA_URL_PATTERN.test(part));
  if (inlineDataUrlPart) {
    const sample = inlineDataUrlPart.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`AI text request contains inline image data. Store images as attachments/assets and pass lightweight references instead. Sample: ${sample}`);
  }

  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_TEXT_INPUT_CHARS;
  const totalChars = textParts.reduce((sum, part) => sum + part.length, 0);
  if (totalChars > maxInputChars) {
    throw new Error(`AI text request is too large (${totalChars} chars, limit ${maxInputChars}). Compact conversation or artifact context before calling the model.`);
  }
}

function buildAnthropicUrl(baseUrl: string) {
  const normalized = trimTrailingSlashes(baseUrl);
  if (normalized.endsWith('/messages')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

function buildGeminiUrl(baseUrl: string, model: string, stream: boolean) {
  const normalized = trimTrailingSlashes(baseUrl);
  const method = stream ? 'streamGenerateContent' : 'generateContent';

  if (normalized.includes('/models/')) {
    if (normalized.endsWith(`:${method}`)) return normalized;
    if (normalized.endsWith(`:${stream ? 'generateContent' : 'streamGenerateContent'}`)) {
      return normalized.replace(/:(generateContent|streamGenerateContent)$/, `:${method}`);
    }
    return `${normalized}:${method}`;
  }

  return `${normalized}/models/${model}:${method}`;
}

function buildOfficialGeminiGenerateContentUrl(baseUrl: string, model: string) {
  const normalized = trimTrailingSlashes(baseUrl || '/api/ai');
  return `${normalized}/gemini/models/${encodeURIComponent(model)}/generateContent`;
}

function buildZhipuUrl(baseUrl: string) {
  const normalized = trimTrailingSlashes(baseUrl);
  if (normalized.endsWith('/chat/completions')) return normalized;
  return `${normalized}/chat/completions`;
}

function buildQwenUrl(baseUrl: string) {
  const normalized = trimTrailingSlashes(baseUrl);
  if (normalized.endsWith('/services/aigc/text-generation/generation')) return normalized;
  return `${normalized}/services/aigc/text-generation/generation`;
}

function buildOpenAICompatibleImageUrl(baseUrl: string) {
  const normalized = trimTrailingSlashes(baseUrl);
  if (normalized.endsWith('/images/generations')) return normalized;
  return `${normalized}/images/generations`;
}

function buildOpenAICompatibleImageEditUrl(baseUrl: string) {
  const normalized = trimTrailingSlashes(baseUrl);
  if (normalized.endsWith('/images/edits')) return normalized;
  if (normalized.endsWith('/images/generations')) return normalized.replace(/\/images\/generations$/, '/images/edits');
  return `${normalized}/images/edits`;
}

function isNanoBananaImageModel(model: unknown) {
  const normalized = String(model || '').trim().toLowerCase();
  return normalized.includes('image-preview') || normalized.includes('nanobanana') || normalized.includes('nano-banana');
}

function imageSizeToGeminiConfig(size: unknown, aspectRatioOverride?: string, imageSizeOverride?: string) {
  const allowedAspectRatios = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
  const normalizedAspectRatio = typeof aspectRatioOverride === 'string' ? aspectRatioOverride.trim() : '';
  const normalizedImageSize = typeof imageSizeOverride === 'string' ? imageSizeOverride.trim().toUpperCase() : '';
  if (normalizedAspectRatio || normalizedImageSize) {
    return {
      ...(allowedAspectRatios.has(normalizedAspectRatio) ? { aspectRatio: normalizedAspectRatio } : {}),
      ...(['1K', '2K', '4K'].includes(normalizedImageSize) ? { imageSize: normalizedImageSize } : {}),
    };
  }
  const text = typeof size === 'string' ? size.trim().toLowerCase() : '';
  const match = text.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {};
  const gcd = (left: number, right: number): number => (right === 0 ? left : gcd(right, left % right));
  const divisor = gcd(width, height);
  const aspectRatio = `${width / divisor}:${height / divisor}`;
  return {
    ...(allowedAspectRatios.has(aspectRatio) ? { aspectRatio } : {}),
    imageSize: Math.max(width, height) > 2048 ? '4K' : Math.max(width, height) > 1024 ? '2K' : '1K',
  };
}

function buildOpenAICompatibleSpeechUrl(baseUrl: string) {
  const normalized = trimTrailingSlashes(baseUrl);
  if (normalized.endsWith('/audio/speech')) return normalized;
  return `${normalized}/audio/speech`;
}

function buildMicrosoftSpeechUrl(config: APIConfig) {
  const normalized = trimTrailingSlashes(config.baseUrl);
  if (normalized.includes('/cognitiveservices/v1')) return normalized;
  return `${normalized}/cognitiveservices/v1`;
}

function buildOpenAICompatibleTranscriptionUrl(baseUrl: string) {
  const normalized = trimTrailingSlashes(baseUrl);
  if (normalized.endsWith('/audio/transcriptions')) return normalized;
  return `${normalized}/audio/transcriptions`;
}

function buildOpenAICompatibleChatUrl(baseUrl: string) {
  const normalized = trimTrailingSlashes(baseUrl);
  if (normalized.endsWith('/chat/completions')) return normalized;
  return `${normalized}/chat/completions`;
}

function splitDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

function buildOpenAICompatibleContent(message: ChatMessage): OpenAICompatibleMessageContent {
  const attachments = (message.attachments || []).filter((attachment) => attachment.url);
  if (!attachments.length) return message.content;
  return [
    ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
    ...attachments.map((attachment) => ({
      type: 'image_url' as const,
      image_url: { url: attachment.url },
    })),
  ];
}

function appendJsonInstructionToContent(content: OpenAICompatibleMessageContent): OpenAICompatibleMessageContent {
  const instruction = 'Return exactly one valid json object.';
  if (typeof content === 'string') {
    return content.trim() ? `${content}\n\n${instruction}` : instruction;
  }
  return [...content, { type: 'text', text: instruction }];
}

function buildAnthropicContent(message: ChatMessage) {
  const textParts = message.content ? [{ type: 'text', text: message.content }] : [];
  const imageParts = (message.attachments || []).flatMap((attachment) => {
    const data = splitDataUrl(attachment.url);
    if (!data) return [];
    return [{
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType || data.mimeType,
        data: data.base64,
      },
    }];
  });
  const content = [...textParts, ...imageParts];
  return content.length ? content : [{ type: 'text', text: '' }];
}

function buildGeminiParts(message: ChatMessage) {
  const textParts = message.content ? [{ text: message.content }] : [];
  const imageParts = (message.attachments || []).flatMap((attachment) => {
    const data = splitDataUrl(attachment.url);
    if (!data) return [];
    return [{
      inlineData: {
        mimeType: attachment.mimeType || data.mimeType,
        data: data.base64,
      },
    }];
  });
  const parts = [...textParts, ...imageParts];
  return parts.length ? parts : [{ text: '' }];
}

function buildQwenContent(message: ChatMessage) {
  const imageParts = (message.attachments || [])
    .filter((attachment) => attachment.url)
    .map((attachment) => ({ image: attachment.url }));
  if (!imageParts.length) return message.content;
  return [
    ...(message.content ? [{ text: message.content }] : []),
    ...imageParts,
  ];
}

function buildQwenMessages(messages: ChatMessage[], systemPrompt: string) {
  return [
    { role: 'system' as const, content: systemPrompt },
    ...messages.map((message) => ({
      role: message.role,
      content: buildQwenContent(message),
    })),
  ];
}

function buildOpenAICompatibleMessages(messages: ChatMessage[], systemPrompt: string, includeJsonInputInstruction = false) {
  const payload = [
    { role: 'system' as const, content: systemPrompt },
    ...messages.map((message) => ({
      role: message.role,
      content: buildOpenAICompatibleContent(message),
    })),
  ];
  if (!includeJsonInputInstruction) return payload;
  for (let index = payload.length - 1; index >= 0; index -= 1) {
    if (payload[index]?.role === 'user') {
      payload[index] = {
        ...payload[index],
        content: appendJsonInstructionToContent(payload[index].content),
      };
      return payload;
    }
  }
  return [
    ...payload,
    { role: 'user' as const, content: 'Return exactly one valid json object.' },
  ];
}

function buildOfficialMessages(messages: ChatMessage[], systemPrompt: string, includeJsonInputInstruction = false) {
  return buildOpenAICompatibleMessages(messages, systemPrompt, includeJsonInputInstruction);
}

async function parseOfficialProxyResponse(response: Response) {
  const result = await parseJsonResponse<{
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  } & Record<string, JSONValue>>(response, 'Official AI request failed');
  const content = result.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((item) => item.text || '').join('') : (content || '');
}

function isOpenAICompatibleEndpoint(config: APIConfig) {
  const baseUrl = config.baseUrl.toLowerCase();
  if (config.provider === 'google') return baseUrl.includes('/openai');
  if (config.provider === 'alibaba') return baseUrl.includes('compatible-mode');
  return false;
}

function usesOpenAICompatibleChatApi(config: APIConfig) {
  if (isOpenAICompatibleEndpoint(config)) return true;
  return ['openai', 'xai', 'deepseek', 'moonshot', 'minimax', 'bytedance', 'custom'].includes(config.provider);
}

function buildOpenAICompatibleAdvancedRequestFields(config: APIConfig): Record<string, unknown> {
  const normalizedProvider = String(config.provider || '').trim().toLowerCase();
  const normalizedModel = config.model.trim().toLowerCase();
  if ((normalizedProvider === 'deepseek' || normalizedProvider === 'official-1' || normalizedProvider === 'official-deepseek')
    && (normalizedModel.startsWith('deepseek-v4') || normalizedModel.includes('deepseek-v4'))) {
    const reasoningMode = normalizeAIModelAdvancedOptions(config.provider, config.model, config.advancedOptions).reasoningMode;
    if (reasoningMode === 'disabled') return { thinking: { type: 'disabled' } };
    if (reasoningMode === 'enabled') return { thinking: { type: 'enabled' } };
  }
  return {};
}

export async function parseSSEStream(
  response: Response,
  onData: (parsed: Record<string, unknown>) => void,
  idleTimeoutMs = 120_000,
) {
  if (!response.ok || !response.body) {
    throw await createPublicAiRequestError(response, 'Streaming request failed');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const processFrame = (frame: string) => {
    const lines = frame.split('\n').map((line) => line.trim()).filter(Boolean);
    const dataLines = lines.filter((line) => line.startsWith('data:'));

    for (const line of dataLines) {
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') return true;
      let parsed: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(data);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SSE object');
        parsed = value as Record<string, unknown>;
      } catch (error) {
        console.error('[ai-stream:invalid-frame]', { dataLength: data.length, errorType: error instanceof Error ? error.name : typeof error });
        throw new Error('AI 流式响应包含无效 JSON，本次生成未完成');
      }
      if (parsed.error || parsed.type === 'error') {
        console.error('[ai-stream:upstream-error]', {
          type: parsed.type,
          detail: redactAiDiagnosticText(JSON.stringify(parsed.error ?? parsed)),
        });
        throw new Error('AI 服务在流式回复期间返回错误，本次生成未完成');
      }
      onData(parsed);
      if (parsed.type === 'message_stop') return true;
    }
    return false;
  };

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            console.error('[ai-stream:idle-timeout]', { idleTimeoutMs });
            reject(new Error('AI 流式响应长时间没有数据，本次生成已停止，请重试'));
          }, idleTimeoutMs);
        }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';

      for (const part of parts) {
        if (processFrame(part)) return;
      }
    }
    if (buffer.trim()) processFrame(buffer);
  } finally {
    decoder.decode();
    // Cancel the unread tail: some providers keep the connection open after DONE.
    void reader.cancel().catch((error: unknown) => {
      console.error('[ai-stream:cancel-failed]', error);
    });
    reader.releaseLock();
  }
}

async function parseJsonResponse<T>(response: Response, fallbackPrefix: string): Promise<T> {
  const signal = getResponseWorkspaceSignal(response);
  assertWorkspaceActive(signal);
  if (!response.ok) {
    throw await createPublicAiRequestError(response, fallbackPrefix);
  }
  const result = await response.json() as T;
  assertWorkspaceActive(signal);
  return result;
}

export interface AiRequestDiagnostic {
  status: number;
  statusText: string;
  code?: string;
  detail?: unknown;
  error?: string;
}

export interface PublicAiRequestError extends Error {
  diagnostic?: AiRequestDiagnostic;
}

function parseAiErrorDiagnostic(rawBody: string, response: Response): AiRequestDiagnostic {
  const diagnostic: AiRequestDiagnostic = {
    status: response.status,
    statusText: response.statusText,
  };
  const body = redactAiDiagnosticText(rawBody);
  if (!body) return diagnostic;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.code === 'string') diagnostic.code = parsed.code;
    if (typeof parsed.error === 'string') diagnostic.error = parsed.error;
    if ('detail' in parsed) diagnostic.detail = parsed.detail;
  } catch {
    diagnostic.detail = body;
  }
  return diagnostic;
}

async function createPublicAiRequestError(response: Response, fallbackPrefix: string): Promise<PublicAiRequestError> {
  // Official-provider failures may include routing, pricing, or upstream
  // details. They are useful for local diagnostics but must never become chat text.
  const rawBody = await response.text().catch(() => '');
  const diagnostic = parseAiErrorDiagnostic(rawBody, response);
  const imageErrorMessages: Record<string, string> = {
    AI_IMAGE_SERVICE_UNCONFIGURED: '图片服务的模型或价格配置不完整，请管理员检查配置。',
    AI_IMAGE_COUNT_UNSUPPORTED: '当前图片模型每次请求仅支持一张图片。',
    AI_IMAGE_UPSTREAM_AUTH_FAILED: '图片供应商认证或权限校验失败，请管理员检查服务配置。',
    AI_IMAGE_UPSTREAM_BALANCE_INSUFFICIENT: '图片供应商账户余额不足，请管理员检查供应商额度。',
    AI_IMAGE_UPSTREAM_RATE_LIMITED: '图片供应商请求限流，请稍后重试。',
    AI_IMAGE_UPSTREAM_INVALID_REQUEST: '图片供应商拒绝了生成参数，请检查模型、图片尺寸和参考图。',
    AI_IMAGE_UPSTREAM_MODEL_UNAVAILABLE: '图片供应商未找到请求的模型或接口，请管理员检查模型配置。',
    AI_IMAGE_UPSTREAM_TIMEOUT: '图片生成请求超时，请检查生成结果后再重试，避免重复扣费。',
    AI_IMAGE_UPSTREAM_UNAVAILABLE: '图片供应商连接失败或服务异常，请稍后重试。',
    AI_IMAGE_UPSTREAM_ERROR: '图片供应商未能完成生成请求，请管理员检查供应商服务状态。',
    AI_IMAGE_INVALID_RESPONSE: '图片供应商返回了无效响应，请稍后重试。',
    AI_IMAGE_EMPTY_RESPONSE: '图片供应商未返回图片，请调整提示词后重试。',
    AI_IMAGE_SIZE_UNSUPPORTED: '当前模型不支持所选图片尺寸，请调整后重试。',
  };
  const knownBusinessErrorMessages: Record<string, string> = {
    VIP_LIMIT_EXCEEDED: '已达到当前会员权益上限。',
    AI_POINTS_INSUFFICIENT: 'AI 点数不足，暂时无法继续生成。',
    AI_ACCESS_DISABLED: '当前账号的 AI 服务已被停用。',
    VIP_PROVIDER_ACCESS_REQUIRED: '当前账号无权使用该 AI 服务或模型。',
    AI_PROVIDER_INACTIVE: '所选 AI 服务当前已停用。',
    AI_PROVIDER_KEY_MISSING: '所选 AI 服务尚未完成服务端配置。',
    AI_PROVIDER_NOT_AVAILABLE: '所选 AI 服务当前不可用，请切换模型后重试。',
    AI_PROVIDER_PROXY_UNSUPPORTED: '所选 AI 服务不支持当前请求类型。',
    AI_MODEL_NOT_AVAILABLE: '所选模型当前不可用，请切换模型后重试。',
    NANOBANANA_SESSION_MISSING: '图片服务尚未完成服务端配置。',
    NANOBANANA_USER_ID_MISSING: '图片服务的账户配置不完整。',
  };
  let message: string;
  if (diagnostic.code && imageErrorMessages[diagnostic.code]) message = imageErrorMessages[diagnostic.code];
  else if (response.status === 401) message = 'AI 服务认证已失效，请重新登录后重试。';
  else if (diagnostic.code && knownBusinessErrorMessages[diagnostic.code]) message = diagnostic.error || knownBusinessErrorMessages[diagnostic.code];
  else if (response.status === 402) message = diagnostic.error || 'AI 点数不足，暂时无法继续生成。';
  else if (response.status === 403) message = diagnostic.error || '当前账号无权使用该 AI 服务或模型。';
  else if (response.status === 429) message = 'AI 服务请求过于频繁，请稍后重试。';
  else if (response.status >= 400 && response.status < 500) message = '所选模型当前不可用，请切换模型后重试。';
  else message = `${fallbackPrefix}：AI 服务暂时不可用，请稍后重试。`;

  const error = new Error(message) as PublicAiRequestError;
  error.diagnostic = diagnostic;
  return error;
}

async function urlToBlob(value: string, fallbackMimeType = 'image/png') {
  const response = await fetch(value);
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || `Failed to load reference image: ${response.status}`);
  }
  const blob = await response.blob();
  return blob.type ? blob : new Blob([blob], { type: fallbackMimeType });
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function getBlobExtension(mimeType: string) {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

async function generateAnthropicResponse(
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  options: GenerateResponseOptions = {},
) {
  const payload = splitSystemMessages(messages, systemPrompt);
  const endpoint = buildAnthropicUrl(config.baseUrl);
  const maxTokensConfig = options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens };

  if (onChunk) {
    let fullResponse = '';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        system: payload.systemPrompt || undefined,
        messages: payload.conversation.map((message) => ({
          role: message.role,
          content: buildAnthropicContent(message),
        })),
        ...maxTokensConfig,
        temperature: 0.8,
        stream: true,
      }),
      signal: options.signal,
    });

    await parseSSEStream(response, (parsed) => {
      const delta = parsed.delta as { text?: string } | undefined;
      if (parsed.type === 'content_block_delta' && delta?.text) {
        fullResponse += delta.text;
        onChunk(fullResponse);
      }
    });
    return fullResponse;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
      body: JSON.stringify({
        model: config.model,
        system: payload.systemPrompt || undefined,
        messages: payload.conversation.map((message) => ({
          role: message.role,
          content: buildAnthropicContent(message),
        })),
        ...maxTokensConfig,
        temperature: 0.8,
      }),
      signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || `Anthropic request failed: ${response.status}`);
  }

  const result = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  return result.content?.filter((item) => item.type === 'text').map((item) => item.text || '').join('') || '';
}

async function generateGeminiResponse(
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  options: GenerateResponseOptions = {},
) {
  const payload = splitSystemMessages(messages, systemPrompt);
  const query = `key=${encodeURIComponent(config.apiKey)}${onChunk ? '&alt=sse' : ''}`;
  const endpoint = `${buildGeminiUrl(config.baseUrl, config.model, Boolean(onChunk))}?${query}`;
  const maxOutputTokens = options.maxTokens === undefined ? undefined : options.maxTokens;
  const requestBody = {
    systemInstruction: payload.systemPrompt
      ? { parts: [{ text: payload.systemPrompt }] }
      : undefined,
    contents: payload.conversation.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: buildGeminiParts(message),
    })),
    generationConfig: {
      temperature: 0.8,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      responseMimeType: options.responseFormat === 'json' ? 'application/json' : undefined,
    },
  };

  if (onChunk) {
    let fullResponse = '';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    await parseSSEStream(response, (parsed) => {
      const candidates = parsed.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
      const text = candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
      if (text) {
        fullResponse += text;
        onChunk(fullResponse);
      }
    });
    return fullResponse;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || `Gemini request failed: ${response.status}`);
  }

  const result = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}

async function generateZhipuResponse(
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  options: GenerateResponseOptions = {},
) {
  const endpoint = buildZhipuUrl(config.baseUrl);
  const maxTokensConfig = options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens };
  const requestBody = {
    model: config.model,
    messages: buildOpenAICompatibleMessages(messages, systemPrompt, options.responseFormat === 'json'),
    temperature: 0.8,
    ...maxTokensConfig,
    stream: Boolean(onChunk),
    response_format: options.responseFormat === 'json' ? { type: 'json_object' } : undefined,
  };

  if (onChunk) {
    let fullResponse = '';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    await parseSSEStream(response, (parsed) => {
      const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
      const content = choices?.[0]?.delta?.content || '';
      if (content) {
        fullResponse += content;
        onChunk(fullResponse);
      }
    });
    return fullResponse;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || `Zhipu request failed: ${response.status}`);
  }

  const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return result.choices?.[0]?.message?.content || '';
}

async function generateQwenResponse(
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  options: GenerateResponseOptions = {},
) {
  const endpoint = buildQwenUrl(config.baseUrl);
  const maxTokensConfig = options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens };
  const requestBody = {
    model: config.model,
    input: {
      messages: buildQwenMessages(messages, systemPrompt),
    },
    parameters: {
      temperature: 0.8,
      ...maxTokensConfig,
      incremental_output: Boolean(onChunk),
      result_format: 'message',
      response_format: options.responseFormat === 'json' ? { type: 'json_object' } : undefined,
    },
  };

  if (onChunk) {
    let fullResponse = '';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'X-DashScope-SSE': 'enable',
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    await parseSSEStream(response, (parsed) => {
      const output = parsed.output as {
        choices?: Array<{ message?: { content?: Array<{ text?: string }> | string } }>;
      } | undefined;
      const content = output?.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content.map((item) => item.text || '').join('')
        : (typeof content === 'string' ? content : '');
      if (text) {
        fullResponse = text;
        onChunk(fullResponse);
      }
    });
    return fullResponse;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || `Qwen request failed: ${response.status}`);
  }

  const result = await response.json() as {
    output?: { choices?: Array<{ message?: { content?: Array<{ text?: string }> | string } }> };
  };
  const content = result.output?.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((item) => item.text || '').join('') : (typeof content === 'string' ? content : '');
}

async function generateOpenAICompatibleResponse(
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  options: GenerateResponseOptions = {},
) {
  const endpoint = buildOpenAICompatibleChatUrl(config.baseUrl);
  const maxTokensConfig = options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens };
  const requestBody = {
    model: config.model,
    messages: buildOpenAICompatibleMessages(messages, systemPrompt, options.responseFormat === 'json'),
    stream: Boolean(onChunk),
    ...maxTokensConfig,
    temperature: 0.8,
    ...buildOpenAICompatibleAdvancedRequestFields(config),
    response_format: options.responseFormat === 'json' ? { type: 'json_object' } : undefined,
  };

  if (onChunk) {
    let fullResponse = '';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    await parseSSEStream(response, (parsed) => {
      const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
      const content = choices?.[0]?.delta?.content || '';
      if (content) {
        fullResponse += content;
        onChunk(fullResponse);
      }
    });
    return fullResponse;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: options.signal,
  });

  const result = await parseJsonResponse<{
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  } & Record<string, JSONValue>>(response, 'OpenAI-compatible request failed');
  const content = result.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((item) => item.text || '').join('') : (content || '');
}

async function generateOfficialResponse(
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  options: GenerateResponseOptions = {},
) {
  const requestBody = {
    provider: resolveOfficialBackendProvider(config.provider),
    model: config.model.trim(),
    messages: buildOfficialMessages(messages, systemPrompt, options.responseFormat === 'json'),
    stream: Boolean(onChunk),
    max_tokens: options.maxTokens,
    response_format: options.responseFormat === 'json' ? { type: 'json_object' } : undefined,
    ...buildOpenAICompatibleAdvancedRequestFields(config),
    metadata: options.aiUsage ? { aiUsage: options.aiUsage } : undefined,
  };
  const response = await api.fetchWithAuth(backendUrl('/api/ai/v1/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: options.signal,
  });

  if (onChunk) {
    let fullResponse = '';
    await parseSSEStream(response, (parsed) => {
      const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
      const content = choices?.[0]?.delta?.content || '';
      if (content) {
        fullResponse += content;
        onChunk(fullResponse);
      }
    });
    return fullResponse;
  }

  return parseOfficialProxyResponse(response);
}

const providerHandlers: Partial<Record<APIConfig['provider'], typeof generateOpenAICompatibleResponse>> = {
  official: generateOfficialResponse,
  'official-deepseek': generateOfficialResponse,
  'official-gpt': generateOfficialResponse,
  'official-moacode': generateOfficialResponse,
  'official-moacode-team': generateOfficialResponse,
  openai: generateOpenAICompatibleResponse,
  anthropic: generateAnthropicResponse,
  google: generateGeminiResponse,
  xai: generateOpenAICompatibleResponse,
  deepseek: generateOpenAICompatibleResponse,
  alibaba: generateQwenResponse,
  zhipu: generateZhipuResponse,
  moonshot: generateOpenAICompatibleResponse,
  minimax: generateOpenAICompatibleResponse,
  bytedance: generateOpenAICompatibleResponse,
  custom: generateOpenAICompatibleResponse,
};

async function listOpenAICompatibleModels(config: APIConfig) {
  const normalizedBase = trimTrailingSlashes(config.baseUrl);
  const modelUrl = normalizedBase.endsWith('/models')
    ? normalizedBase
    : normalizedBase.endsWith('/chat/completions')
      ? normalizedBase.replace(/\/chat\/completions$/, '/models')
      : joinUrl(normalizedBase, '/models');
  const response = await fetch(modelUrl, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });
  const result = await parseJsonResponse<{ data?: Array<{ id?: string }> }>(response, 'Model list request failed');
  return (result.data || [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, label: id }));
}

async function listOfficialModels(config: APIConfig): Promise<AvailableModelInfo[]> {
  const provider = resolveOfficialBackendProvider(config.provider);
  const response = await api.fetchWithAuth(backendUrl(`/api/ai/models?provider=${encodeURIComponent(provider)}`));
  const result = await parseJsonResponse<{ items?: Array<{ id?: string; label?: string; family?: string; tier?: string | null; metadata?: JSONValue }> }>(response, 'Official model list request failed');
  return (result.items || [])
    .filter((item): item is { id: string; label?: string; family?: string; tier?: string | null; metadata?: JSONValue } => Boolean(item.id))
    .map((item) => {
      const raw: Record<string, JSONValue> = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
        ? { ...(item.metadata as Record<string, JSONValue>) }
        : {};
      if (item.family) raw.family = item.family;
      if (item.tier) raw.tier = item.tier;
      return { id: item.id, label: item.label || item.id, raw };
    });
}

async function listAnthropicModels(config: APIConfig) {
  const response = await fetch(joinUrl(config.baseUrl, '/models'), {
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  const result = await parseJsonResponse<{ data?: Array<{ id?: string; display_name?: string }> }>(response, 'Anthropic model list request failed');
  return (result.data || [])
    .filter((item): item is { id: string; display_name?: string } => Boolean(item.id))
    .map((item) => ({ id: item.id, label: item.display_name || item.id }));
}

async function listGeminiModels(config: APIConfig) {
  const response = await fetch(`${joinUrl(config.baseUrl, '/models')}?key=${encodeURIComponent(config.apiKey)}`);
  const result = await parseJsonResponse<{ models?: Array<{ name?: string; displayName?: string }> }>(response, 'Gemini model list request failed');
  return (result.models || [])
    .filter((item): item is { name: string; displayName?: string } => Boolean(item.name))
    .map((item) => {
      const id = item.name.replace(/^models\//, '');
      return { id, label: item.displayName || id };
    });
}

async function listQwenModels(config: APIConfig) {
  return listOpenAICompatibleModels({
    ...config,
    baseUrl: config.baseUrl.includes('compatible-mode') ? config.baseUrl : joinUrl(config.baseUrl, '/compatible-mode/v1'),
  });
}

export async function listAvailableModels(config: APIConfig): Promise<AvailableModelInfo[]> {
  if (usesOfficialProxy(config)) {
    return listOfficialModels(config);
  }
  if (config.provider === 'microsoft') {
    return [
      { id: 'zh-CN-XiaoxiaoNeural', label: 'zh-CN-XiaoxiaoNeural' },
      { id: 'zh-CN-YunxiNeural', label: 'zh-CN-YunxiNeural' },
      { id: 'zh-CN-YunjianNeural', label: 'zh-CN-YunjianNeural' },
      { id: 'zh-CN-XiaoyiNeural', label: 'zh-CN-XiaoyiNeural' },
      { id: 'en-US-JennyNeural', label: 'en-US-JennyNeural' },
      { id: 'en-US-GuyNeural', label: 'en-US-GuyNeural' },
    ];
  }
  if (isOpenAICompatibleEndpoint(config)) {
    return listOpenAICompatibleModels(config);
  }

  switch (config.provider) {
    case 'anthropic':
      return listAnthropicModels(config);
    case 'google':
      return listGeminiModels(config);
    case 'alibaba':
      return listQwenModels(config);
    default:
      return listOpenAICompatibleModels(config);
  }
}

async function generateOpenAICompatibleImage(config: APIConfig, options: ImageGenerationOptions): Promise<GeneratedImage[]> {
  const officialProxy = usesOfficialProxy(config);
  const provider = officialProxy ? resolveOfficialBackendProvider(config.provider) : undefined;
  const resolution = options.imageSize?.trim().toUpperCase();
  const pixelSize = resolution === '4K' ? '4096x4096' : resolution === '2K' ? '2048x2048' : resolution === '1K' ? '1024x1024' : undefined;
  const size = pixelSize || options.size || '1024x1024';
  const timed = withTimeoutSignal(options.signal, DEFAULT_IMAGE_REQUEST_TIMEOUT_MS, '图片生成超时，请稍后重试。');
  if (options.referenceImages?.length) {
    const formData = new FormData();
    formData.append('model', config.model);
    if (provider) formData.append('provider', provider);
    formData.append('prompt', options.prompt);
    formData.append('n', String(options.count || 1));
    formData.append('size', size);
    formData.append('response_format', 'b64_json');
    if (officialProxy && options.aiUsage) formData.append('metadata', JSON.stringify({ aiUsage: options.aiUsage }));

    for (const [index, reference] of options.referenceImages.entries()) {
      const blob = await urlToBlob(reference.url, reference.mimeType || 'image/png');
      formData.append('image[]', blob, `reference-${index + 1}.${getBlobExtension(reference.mimeType || blob.type || 'image/png')}`);
    }

    try {
      const response = await (officialProxy ? api.fetchWithAuth.bind(api) : fetch)(buildOpenAICompatibleImageEditUrl(config.baseUrl), {
        method: 'POST',
        headers: officialProxy ? {} : { Authorization: `Bearer ${config.apiKey}` },
        signal: timed.signal,
        body: formData,
      });
      const result = await parseJsonResponse<{
        data?: Array<{ b64_json?: string; revised_prompt?: string; url?: string }>;
      }>(response, 'Image edit request failed');

      const images: GeneratedImage[] = [];
      for (const item of result.data || []) {
        if (item.b64_json) {
          images.push({
            mimeType: 'image/png',
            dataUrl: encodeDataUrl('image/png', item.b64_json),
            revisedPrompt: item.revised_prompt,
            url: item.url,
          });
          continue;
        }

        if (item.url) {
          images.push({
            mimeType: 'image/png',
            dataUrl: item.url,
            revisedPrompt: item.revised_prompt,
            url: item.url,
          });
        }
      }
      return images;
    } finally {
      timed.cleanup();
    }
  }

  try {
    const response = await (officialProxy ? api.fetchWithAuth.bind(api) : fetch)(buildOpenAICompatibleImageUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(officialProxy ? {} : { Authorization: `Bearer ${config.apiKey}` }),
      },
      signal: timed.signal,
      body: JSON.stringify({
        provider,
        model: config.model,
        prompt: options.prompt,
        n: options.count || 1,
        size,
        response_format: 'b64_json',
        negative_prompt: options.negativePrompt || undefined,
        seed: options.seed ?? undefined,
        metadata: officialProxy && options.aiUsage ? { aiUsage: options.aiUsage } : undefined,
      }),
    });
    const result = await parseJsonResponse<{
      data?: Array<{ b64_json?: string; revised_prompt?: string; url?: string }>;
    }>(response, 'Image generation request failed');

    const images: GeneratedImage[] = [];
    for (const item of result.data || []) {
      if (item.b64_json) {
        images.push({
          mimeType: 'image/png',
          dataUrl: encodeDataUrl('image/png', item.b64_json),
          revisedPrompt: item.revised_prompt,
          url: item.url,
        });
        continue;
      }

      if (item.url) {
        images.push({
          mimeType: 'image/png',
          dataUrl: item.url,
          revisedPrompt: item.revised_prompt,
          url: item.url,
        });
      }
    }
    return images;
  } finally {
    timed.cleanup();
  }
}

async function generateGeminiImage(config: APIConfig, options: ImageGenerationOptions): Promise<GeneratedImage[]> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: options.prompt }];
  for (const reference of options.referenceImages || []) {
    const dataUrl = reference.url.startsWith('data:')
      ? reference.url
      : encodeDataUrl(reference.mimeType || 'image/png', await blobToBase64(await urlToBlob(reference.url, reference.mimeType || 'image/png')));
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }

  const officialProxy = usesOfficialProxy(config);
  const timed = withTimeoutSignal(options.signal, DEFAULT_IMAGE_REQUEST_TIMEOUT_MS, '图片生成超时，请稍后重试。');
  try {
    const response = await (officialProxy ? api.fetchWithAuth.bind(api) : fetch)(officialProxy
      ? backendUrl(buildOfficialGeminiGenerateContentUrl(config.baseUrl || '/api/ai', config.model))
      : `${buildGeminiUrl(config.baseUrl, config.model, false)}?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: timed.signal,
      body: JSON.stringify({
        ...(officialProxy ? { provider: resolveOfficialBackendProvider(config.provider), model: config.model } : {}),
        ...(officialProxy && options.aiUsage ? { metadata: { aiUsage: options.aiUsage } } : {}),
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: imageSizeToGeminiConfig(options.size, options.aspectRatio, options.imageSize),
        },
      }),
    });
    const result = await parseJsonResponse<{
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }> } }>;
    }>(response, 'Gemini image generation request failed');

    const images: GeneratedImage[] = [];
    for (const candidate of result.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        const mimeType = part.inlineData?.mimeType || part.inline_data?.mime_type;
        const data = part.inlineData?.data || part.inline_data?.data;
        if (mimeType && data) {
          images.push({
            mimeType,
            dataUrl: encodeDataUrl(mimeType, data),
          });
        }
      }
    }
    return images;
  } finally {
    timed.cleanup();
  }
}

export async function generateImage(config: APIConfig, options: ImageGenerationOptions): Promise<GeneratedImage[]> {
  if (usesOfficialProxy(config) && (config.provider === 'official-ace-nanobanana' || isNanoBananaImageModel(config.model))) {
    return generateGeminiImage(config, options);
  }
  if (isOpenAICompatibleEndpoint(config)) {
    return generateOpenAICompatibleImage(config, options);
  }

  switch (config.provider) {
    case 'google':
      return generateGeminiImage(config, options);
    default:
      return generateOpenAICompatibleImage(config, options);
  }
}

async function synthesizeOpenAICompatibleSpeech(config: APIConfig, options: SpeechSynthesisOptions): Promise<SpeechSynthesisResult> {
  const response = await fetch(buildOpenAICompatibleSpeechUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: options.input,
      voice: options.voice || 'alloy',
      response_format: options.format || 'mp3',
      ...(typeof options.speed === 'number' ? { speed: options.speed } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || `Speech synthesis request failed: ${response.status}`);
  }

  const blob = await response.blob();
  return {
    mimeType: blob.type || guessAudioMimeType(options.format),
    blob,
    objectUrl: createObjectUrl(blob),
  };
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function synthesizeMicrosoftSpeech(config: APIConfig, options: SpeechSynthesisOptions): Promise<SpeechSynthesisResult> {
  const voice = options.voice || config.model || 'zh-CN-XiaoxiaoNeural';
  const language = options.language || 'zh-CN';
  const rate = typeof options.speed === 'number' ? `${Math.round(options.speed * 100)}%` : '100%';
  const pitch = typeof options.pitch === 'number' ? `${options.pitch >= 0 ? '+' : ''}${options.pitch}Hz` : '0Hz';
  const prosody = `<prosody rate="${escapeXml(rate)}" pitch="${escapeXml(pitch)}">${escapeXml(options.input)}</prosody>`;
  const ssml = `<speak version="1.0" xml:lang="${escapeXml(language)}"><voice name="${escapeXml(voice)}">${prosody}</voice></speak>`;
  const response = await fetch(buildMicrosoftSpeechUrl(config), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/ssml+xml',
      'Ocp-Apim-Subscription-Key': config.apiKey,
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'SenseMurmur',
    },
    body: ssml,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || `Microsoft speech request failed: ${response.status}`);
  }

  const blob = await response.blob();
  return {
    mimeType: blob.type || 'audio/mpeg',
    blob,
    objectUrl: createObjectUrl(blob),
  };
}

async function synthesizeGeminiSpeech(config: APIConfig, options: SpeechSynthesisOptions): Promise<SpeechSynthesisResult> {
  const response = await fetch(`${buildGeminiUrl(config.baseUrl, config.model, false)}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: options.input }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: options.voice ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } } : undefined,
      },
    }),
  });

  const result = await parseJsonResponse<{
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
  }>(response, 'Gemini speech request failed');

  const audioPart = result.candidates?.flatMap((candidate) => candidate.content?.parts || []).find((part) => part.inlineData?.data);
  const mimeType = audioPart?.inlineData?.mimeType || guessAudioMimeType(options.format);
  const base64 = audioPart?.inlineData?.data;
  if (!base64) {
    throw new Error('Gemini speech request returned no audio data');
  }

  const blob = await fetch(encodeDataUrl(mimeType, base64)).then((res) => res.blob());
  return {
    mimeType,
    blob,
    objectUrl: createObjectUrl(blob),
  };
}

export async function synthesizeSpeech(config: APIConfig, options: SpeechSynthesisOptions): Promise<SpeechSynthesisResult> {
  if (config.provider === 'microsoft') {
    return synthesizeMicrosoftSpeech(config, options);
  }
  if (isOpenAICompatibleEndpoint(config)) {
    return synthesizeOpenAICompatibleSpeech(config, options);
  }

  switch (config.provider) {
    case 'google':
      return synthesizeGeminiSpeech(config, options);
    default:
      return synthesizeOpenAICompatibleSpeech(config, options);
  }
}

export async function transcribeAudio(config: APIConfig, options: AudioTranscriptionOptions): Promise<AudioTranscriptionResult> {
  const formData = new FormData();
  formData.append('model', config.model);
  formData.append('file', options.file, options.fileName || 'audio.webm');
  if (options.prompt) formData.append('prompt', options.prompt);
  if (options.language) formData.append('language', options.language);

  const response = await fetch(buildOpenAICompatibleTranscriptionUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: formData,
  });

  const result = await parseJsonResponse<{ text?: string } & Record<string, JSONValue>>(response, 'Audio transcription request failed');
  return {
    text: result.text || '',
    raw: result,
  };
}

async function withTextRequestDeadline<T>(
  config: APIConfig,
  options: GenerateResponseOptions,
  task: (options: GenerateResponseOptions) => Promise<T>,
): Promise<T> {
  const timeoutMs = 300_000;
  const timed = withTimeoutSignal(options.signal, timeoutMs, 'AI 请求超过五分钟未完成，已停止，请重试');
  try {
    return await task({ ...options, signal: timed.signal });
  } catch (error) {
    if (timed.signal?.aborted && !options.signal?.aborted) {
      console.error('[ai-request:timeout]', { provider: config.provider, model: config.model, timeoutMs });
      throw timed.signal.reason;
    }
    throw error;
  } finally {
    timed.cleanup();
  }
}

export const generateResponse = async (
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  options: GenerateResponseOptions = {},
): Promise<string> => {
  const effectiveOptions = { ...options, maxTokens: options.maxTokens === undefined ? normalizeMaxOutputTokens(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS) : Math.min(options.maxTokens, normalizeMaxOutputTokens(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS)) };
  const effectiveSystemPrompt = effectiveOptions.responseFormat === 'json'
    ? `${systemPrompt}\n\nReturn exactly one valid json object. Do not wrap it in markdown.`
    : systemPrompt;
  assertTextInputWithinBudget(effectiveSystemPrompt, messages, effectiveOptions);
  return withTextRequestDeadline(config, effectiveOptions, async (timedOptions) => {
    if (usesOfficialProxy(config)) {
      return generateOfficialResponse(config, effectiveSystemPrompt, messages, onChunk, timedOptions);
    }
    if (isOpenAICompatibleEndpoint(config)) {
      return generateOpenAICompatibleResponse(config, effectiveSystemPrompt, messages, onChunk, timedOptions);
    }
    const handler = providerHandlers[config.provider] || generateOpenAICompatibleResponse;
    return handler(config, effectiveSystemPrompt, messages, onChunk, timedOptions);
  });
};

export const generateJsonResponse = async (
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  options: GenerateResponseOptions = {},
): Promise<string> => withTextRequestDeadline(config, options, (timedOptions) =>
  generateJsonResponseWithinDeadline(config, systemPrompt, messages, timedOptions));

const generateJsonResponseWithinDeadline = async (
  config: APIConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  options: GenerateResponseOptions = {},
): Promise<string> => {
  const jsonPrompt = `${systemPrompt}\n\nThe response must be exactly one valid JSON object. Do not wrap it in markdown.`;
  const jsonOptions: GenerateResponseOptions = { ...options, responseFormat: 'json' };
  assertTextInputWithinBudget(jsonPrompt, messages, jsonOptions);

  try {
    if (usesOfficialProxy(config)) {
      return await generateOfficialResponse(config, jsonPrompt, messages, undefined, jsonOptions);
    }

    if (usesOpenAICompatibleChatApi(config)) {
      return await generateOpenAICompatibleResponse(config, jsonPrompt, messages, undefined, jsonOptions);
    }

    if (config.provider === 'zhipu') {
      return await generateZhipuResponse(config, jsonPrompt, messages, undefined, jsonOptions);
    }

    if (config.provider === 'alibaba') {
      return await generateQwenResponse(config, jsonPrompt, messages, undefined, jsonOptions);
    }

    if (config.provider === 'google') {
      return await generateGeminiResponse(config, jsonPrompt, messages, undefined, jsonOptions);
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!/response_format|json_object|json/i.test(message)) throw error;
  }

  if (usesOfficialProxy(config)) {
    return generateOfficialResponse(config, jsonPrompt, messages, undefined, options);
  }
  const handler = providerHandlers[config.provider] || generateOpenAICompatibleResponse;
  return handler(config, jsonPrompt, messages, undefined, options);
};

async function testTextLikeConnection(config: APIConfig) {
  await generateResponse(config, 'You are a connection test.', [{ role: 'user', content: 'Hello' }], undefined, {
    aiUsage: { type: 'model_test', label: '测试连接' },
  });
}

async function testMetadataConnection(config: APIConfig) {
  await listAvailableModels(config);
}

export interface AIConnectionTestResult {
  success: boolean;
  error?: unknown;
}

export const testConnection = async (config: MaybeTypedConfig): Promise<AIConnectionTestResult> => {
  try {
    if (config.provider === 'microsoft') {
      await synthesizeMicrosoftSpeech(config, { input: 'connection test', voice: config.model });
      return { success: true };
    }
    if (config.type === 'image' || config.type === 'audio') {
      await testMetadataConnection(config);
    } else {
      await testTextLikeConnection(config);
    }
    return { success: true };
  } catch (error) {
    console.error('AI connection test failed:', error);
    return { success: false, error };
  }
};

export function isLikelyBrowserCorsError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /failed to fetch/i.test(message) || /cors/i.test(message);
}
