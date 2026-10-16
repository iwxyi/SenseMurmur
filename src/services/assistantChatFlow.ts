import type { GroupChat } from '../types/chat';
import type { Message, MessageAttachment, MessageMetadata } from '../types/message';
import type { AssistantAgentChangePlan, AssistantAgentLocalFileContext, AssistantAgentPatchSet, AssistantArtifactDataResult } from '../types/assistantArtifact';
import type { AIModelInputCapabilities, APIConfig, AIModelProfile } from '../types/settings';
import { getUsablePreferredAIProfile, resolveAIModelInputCapabilities } from '../types/settings';
import { createStreamingLocalMessage, persistLocalFirstMessage } from './chatCommitMessage';
import { generateResponse } from './aiClient';
import { GenerationCancelledError } from './generationCancellation';
import { attachMessageToActiveBranch, buildBranchStateWithHead, isMessageBranchingEnabled } from './messageBranching';
import { useChatStore } from '../stores/useChatStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { createStreamingMessageDisplay } from './streamingMessageDisplay';
import { useAuthStore } from '../stores/useAuthStore';
import { api, ApiError, type AiSearchResponse, type AiSearchResultItem } from './api';
import { resolveRoomCapabilities } from './capabilityRuntime';
import { resolveChatAgentCapabilities } from './chatAgentCapabilities';
import { createLocalWorkspaceMutationPlan } from './localWorkspaceService';
import { buildChatReplyPreferencesPrompt } from './chatReplyPreferences';

const MAX_ASSISTANT_HISTORY = 24;
const MAX_ASSISTANT_TITLE_CONTEXT = 12;
const DEFAULT_ASSISTANT_CHAT_NAME = '新助手会话';
const MAX_GENERATED_TITLE_LENGTH = 28;
const MAX_IMAGE_SEMANTIC_SUMMARY_LENGTH = 700;
const MAX_LOCAL_FILE_CONTEXT_CHARS = 120_000;
const pendingAssistantTitleChatIds = new Set<string>();

interface AssistantVisionReply {
  content: string;
  imageSummaries: Array<{
    attachmentId: string;
    summary: string;
  }>;
}

function ensureAssistantReplyStillCurrent(params: { signal?: AbortSignal; shouldContinue?: () => boolean }) {
  if (params.signal?.aborted) throw new GenerationCancelledError();
  if (params.shouldContinue && !params.shouldContinue()) throw new GenerationCancelledError('助手回复所属分支已切换');
}

function resolveTextProfile(fallback: APIConfig, aiProfiles: AIModelProfile[]) {
  const profile = getUsablePreferredAIProfile(aiProfiles, 'text');
  const api = profile
    ? {
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      maxOutputTokens: profile.maxOutputTokens,
    } satisfies APIConfig
    : fallback;
  return {
    api,
    profile: profile || null,
    inputCapabilities: resolveAIModelInputCapabilities(profile || { ...api, type: 'text' }),
  };
}

function buildAssistantSystemPrompt(chat?: GroupChat) {
  if (chat && isLearningProgressChat(chat)) {
    const learning = chat.scenarioState?.learning;
    const knowledge = learning?.knowledgeItems?.slice(0, 32).map((item) => `${item.title} [${item.status}]`).join('、') || '尚未建立';
    return [
      '你是学习进步房里的教师助理，负责把学习目标变成可沉淀、可复用的学习材料。',
      `总目标：${learning?.goal || chat.topic || '未明确'}。`,
      `教学模式：${learning?.teachingMode || 'casual'}；教师专长：${learning?.teacherExpertise || '未设定'}。`,
      `评估口径：${learning?.assessmentPolicy || 'evidence_only'}。只能把可观察证据记录为证据，不能把推断写成已掌握。`,
      `当前知识点：${knowledge}。`,
      learning?.nextStepSuggestion ? `当前建议下一步：${learning.nextStepSuggestion.title}。${learning.nextStepSuggestion.reason}` : '当前还没有下一步建议。',
      '用户要求整理知识点时，优先生成结构清晰的 Markdown 或 JSON/CSV 记录；要求资料、试卷或练习时，优先生成可交互的 HTML 学习产物。',
      '不要声称用户已经掌握没有证据支持的知识；把推断标为待验证，并保留下一步练习建议。',
      '学习目标可以无限扩展，不要用固定百分比假装精确衡量全部学习成果。',
    ].join('\n');
  }
  return [
    '你是通用 AI 助手。',
    '优先准确、清晰、客观地回答用户问题，不要扮演角色，不要使用虚构人物口吻。',
    '如果问题缺少必要信息，先说明不确定性，再给出可执行的下一步。',
    '如果用户要求最新资料或实时事实，而当前没有检索结果，请明确说明需要联网检索或外部来源确认。',
    '可以使用 Markdown 组织答案，但不要为了形式而过度结构化。',
  ].join('\n');
}

function buildAssistantImageInputPromptBlock(params: { hasImageAttachments: boolean; projectedImageAttachments: boolean }) {
  if (!params.hasImageAttachments) return '';
  if (params.projectedImageAttachments) {
    return [
      '本轮用户上传的图片已作为多模态图片输入提供给你。可以基于图片像素内容回答，但不要编造看不到的细节。',
      '如果本轮需要基于图片内容回答，必须只输出严格 JSON：{"content":"给用户看的自然回答","imageSummaries":[{"attachmentId":"本轮图片附件ID","summary":"这张图可供后续引用的简短事实摘要"}]}。',
      'imageSummaries 只写你确实能从图片和上下文确认的内容；多张图必须按 attachmentId 分别写，不能只写“第一张/第二张”。如果无法确认某张图内容，就不要为那张图写摘要。',
      'content 不要提 JSON、attachmentId 或内部协议。',
    ].join('\n');
  }
  return [
    '本轮用户上传了图片，但当前文本模型请求没有携带可视觉解析的图片输入；你只能看到附件文件名、格式、大小或说明。',
    '不要声称“看起来像”“图中有”等视觉判断，不要根据文件名猜测图片内容。',
    '如果用户要求解释图片内容，请明确说明当前模型未收到可解析的图片输入，并提示切换/开启支持图片输入的文本模型后重试。',
  ].join('\n');
}

function parseAssistantVisionReply(raw: string, userMessage: Message, imageInputProjected: boolean): AssistantVisionReply {
  const fallback = { content: raw.trim(), imageSummaries: [] };
  if (!imageInputProjected) return fallback;
  const validAttachmentIds = new Set((userMessage.metadata?.attachments || [])
    .filter((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url))
    .map((attachment) => attachment.id));
  if (!validAttachmentIds.size) return fallback;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const record = parsed as { content?: unknown; imageSummaries?: unknown };
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (!content) return fallback;
    const imageSummaries = Array.isArray(record.imageSummaries)
      ? record.imageSummaries.flatMap((item): AssistantVisionReply['imageSummaries'] => {
        if (!item || typeof item !== 'object') return [];
        const summaryRecord = item as { attachmentId?: unknown; summary?: unknown };
        const attachmentId = typeof summaryRecord.attachmentId === 'string' ? summaryRecord.attachmentId.trim() : '';
        const summary = typeof summaryRecord.summary === 'string'
          ? summaryRecord.summary.replace(/\s+/g, ' ').trim().slice(0, MAX_IMAGE_SEMANTIC_SUMMARY_LENGTH)
          : '';
        if (!attachmentId || !validAttachmentIds.has(attachmentId) || !summary) return [];
        return [{ attachmentId, summary }];
      })
      : [];
    return { content, imageSummaries };
  } catch {
    return fallback;
  }
}

function buildAssistantImageAttachmentText(message: Message) {
  const attachments = (message.metadata?.attachments || [])
    .filter((attachment) => attachment.kind === 'image' && attachment.status !== 'deleted' && attachment.status !== 'failed');
  if (!attachments.length) return '';
  const labels = attachments
    .slice(0, 6)
    .map((attachment, index) => attachment.semanticSummary || attachment.caption || attachment.altText || attachment.promptText || `图片 ${index + 1}`);
  const suffix = attachments.length > labels.length ? ` 等 ${attachments.length} 张图片` : '';
  return `[图片附件：${labels.join('、')}${suffix}]`;
}

function buildUploadedFileContexts(message: Message): AssistantAgentLocalFileContext[] {
  return (message.metadata?.attachments || []).flatMap((attachment) => {
    if (attachment.kind !== 'file' || attachment.status !== 'ready' || !attachment.textContent) return [];
    const content = attachment.textContent.slice(0, MAX_LOCAL_FILE_CONTEXT_CHARS);
    return [{ directoryId: 'upload', path: attachment.fileName || attachment.altText, name: attachment.fileName || attachment.altText, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes || content.length, content, truncated: content.length < attachment.textContent.length, originalLength: attachment.textContent.length }];
  }).slice(0, 12);
}

function buildAssistantProjectedImageAttachments(message: Message, capabilities: AIModelInputCapabilities) {
  if (!capabilities.imageInput) return undefined;
  const maxAttachments = capabilities.multiImageInput ? capabilities.maxAttachments : 1;
  const attachments = (message.metadata?.attachments || [])
    .filter((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url))
    .map((attachment) => ({ url: attachment.url as string, mimeType: attachment.mimeType }))
    .slice(0, Math.max(1, maxAttachments));
  return attachments.length ? attachments : undefined;
}

function buildAppCommandRecentMessages(messages: Message[]) {
  return messages
    .filter((message) => !message.isDeleted && message.type !== 'event' && message.type !== 'system' && message.content.trim())
    .slice(-8)
    .map((message) => ({
      role: message.type === 'ai' ? 'assistant' as const : 'user' as const,
      content: message.content.trim().slice(0, 1200),
    }));
}

function isAssistantAgentArtifactEnabled(chat: GroupChat) {
  const resolved = resolveChatAgentCapabilities(chat);
  if (resolved.enabled) return resolved.chatArtifactWrite;
  const roomCapability = resolveRoomCapabilities({ chat }).artifacts;
  if (roomCapability.mode !== 'off') return true;
  return Boolean(chat.modeState.assistantCapabilities?.agent && chat.modeState.assistantCapabilities?.artifacts);
}

function isLearningProgressChat(chat: GroupChat) {
  return chat.mode === 'classroom'
    || chat.sessionKind?.family === 'study'
    || chat.sessionKind?.scenarioId === 'learning-progress'
    || chat.sessionKind?.scenarioId === 'ielts-coach';
}

function isAssistantAgentSearchEnabled(chat: GroupChat) {
  const resolved = resolveChatAgentCapabilities(chat);
  if (resolved.enabled) return resolved.webSearch;
  return Boolean(chat.modeState.assistantCapabilities?.agent && chat.modeState.assistantCapabilities?.webSearch);
}

function formatAssistantSearchResult(item: AiSearchResultItem, index: number) {
  const body = item.summary || item.snippet || '';
  const source = [item.siteName, item.publishedAt].filter(Boolean).join(' / ');
  return [
    `${index + 1}. ${item.title}`,
    `URL: ${item.url}`,
    source ? `Source: ${source}` : '',
    body ? `Excerpt: ${body}` : '',
  ].filter(Boolean).join('\n');
}

function buildAssistantSearchResultPromptBlock(params: {
  query: string;
  providerCode: string;
  pointCost: number;
  results: AiSearchResultItem[];
}) {
  return [
    '## Web Search Result',
    `Query: ${params.query}`,
    `Provider: ${params.providerCode}; charged ${params.pointCost} AI points.`,
    'Live web search results are available below. Use them when relevant; do not say you cannot browse or cannot access current information. Do not invent citations. Prefer concise synthesis over listing every result.',
    params.results.map(formatAssistantSearchResult).join('\n\n') || 'No usable result items were returned.',
  ].join('\n');
}

function formatAssistantDataResults(results: AssistantArtifactDataResult[]) {
  return results.map((result, index) => {
    if (result.error) return `数据操作 ${index + 1} 失败：${result.error}`;
    if (result.operation === 'query') {
      if (result.format !== 'csv') {
        return `查询结果 ${index + 1}：匹配 ${result.totalRows || 0} 行${result.truncated ? '，仅显示前 100 行' : ''}\n\n${JSON.stringify(result.rows || [], null, 2)}`;
      }
      const columns = result.columns?.length
        ? result.columns
        : Array.from(new Set((result.rows || []).flatMap((row) => Object.keys(row))));
      const cell = (value: unknown) => String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value)
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ');
      const table = columns.length
        ? [
          `| ${columns.map(cell).join(' | ')} |`,
          `| ${columns.map(() => '---').join(' | ')} |`,
          ...(result.rows || []).map((row) => `| ${columns.map((column) => cell(row[column])).join(' | ')} |`),
        ].join('\n')
        : '没有可展示的字段。';
      return `查询结果 ${index + 1}：匹配 ${result.totalRows || 0} 行${result.truncated ? '，仅显示前 100 行' : ''}\n\n${table}`;
    }
    return `数据操作 ${index + 1}：${result.operation} 已影响 ${result.affectedRows} 行。`;
  }).join('\n\n');
}

function buildLocalFilePromptBlock(localFiles: AssistantAgentLocalFileContext[]) {
  return [
    '## Local Workspace Files',
    'The user authorized these local files for this request. Use only the content below; do not claim access to files not listed here.',
    ...localFiles.map((file, index) => [
      `### File ${index + 1}: ${file.path}`,
      `Name: ${file.name}`,
      `MIME: ${file.mimeType || 'unknown'}; sizeBytes: ${file.sizeBytes}; truncated: ${file.truncated}; originalLength: ${file.originalLength}`,
      '```',
      file.content,
      '```',
    ].join('\n')),
  ].join('\n\n');
}

async function generateAssistantLocalFileAnswer(params: {
  api: APIConfig;
  inputCapabilities: AIModelInputCapabilities;
  chat: GroupChat;
  chatId: string;
  userMessage: Message;
  messages: Message[];
  localFiles: AssistantAgentLocalFileContext[];
  signal?: AbortSignal;
}) {
  const promptImageState = getAssistantPromptImageState(withLatestUserMessage(params.messages, params.userMessage), params.inputCapabilities);
  const raw = await generateResponse(
    params.api,
    [
      buildAssistantSystemPrompt(params.chat),
      buildAssistantImageInputPromptBlock(promptImageState),
      buildLocalFilePromptBlock(params.localFiles),
      'Answer the latest user request using the authorized local file content above. If the provided file content is insufficient or truncated, say what is missing instead of guessing.',
    ].filter(Boolean).join('\n\n'),
    promptImageState.messages,
    undefined,
    {
      responseFormat: 'text',
      signal: params.signal,
      aiUsage: {
        type: 'assistant_chat',
        label: '助手Agent本地文件回答',
        scope: 'chat',
        resourceId: params.chatId,
      },
    },
  );
  return parseAssistantVisionReply(raw, params.userMessage, promptImageState.projectedImageAttachments);
}

async function generateAssistantSearchAnswer(params: {
  api: APIConfig;
  inputCapabilities: AIModelInputCapabilities;
  chatId: string;
  userMessage: Message;
  messages: Message[];
  searchQuery: string;
  searchResponse?: AiSearchResponse;
  signal?: AbortSignal;
}) {
  let searchPromptBlock = '';
  try {
    const response = params.searchResponse || await api.searchWeb(params.searchQuery, {
      source: 'assistant_agent', resourceId: params.chatId,
    });
    searchPromptBlock = buildAssistantSearchResultPromptBlock({
      query: response.query,
      providerCode: response.providerCode,
      pointCost: response.pointCost,
      results: response.results,
    });
  } catch (error) {
    const expectedSkip = error instanceof ApiError && (
      error.code === 'AI_SEARCH_ENTITLEMENT_REQUIRED'
      || error.code === 'AI_SEARCH_PROVIDER_UNAVAILABLE'
      || error.code === 'AI_SEARCH_POINTS_INSUFFICIENT'
      || error.status === 401
    );
    searchPromptBlock = [
      '## Web Search Result',
      `Query: ${params.searchQuery}`,
      `Search failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      expectedSkip
        ? 'Tell the user the search could not be performed because the capability, provider, account, or points are unavailable. Do not invent current facts.'
        : 'Tell the user the search failed and answer only from stable knowledge if possible. Do not invent current facts.',
    ].join('\n');
  }
  const promptImageState = getAssistantPromptImageState(withLatestUserMessage(params.messages, params.userMessage), params.inputCapabilities);
  const raw = await generateResponse(
    params.api,
    [
      buildAssistantSystemPrompt(),
      buildAssistantImageInputPromptBlock(promptImageState),
      searchPromptBlock,
      'Answer the latest user request using the search result above. Keep the answer objective and cite URLs when useful. This Agent can download network files and save them to session storage, authorized workspaces, or the device. Never claim that it lacks download or local-save capability. If no verified direct file URL is available, state that specific limitation and ask only for the missing format/source choice.',
    ].filter(Boolean).join('\n\n'),
    promptImageState.messages,
    undefined,
    {
      responseFormat: 'text',
      signal: params.signal,
      aiUsage: {
        type: 'assistant_chat',
        label: '助手Agent搜索回答',
        scope: 'chat',
        resourceId: params.chatId,
      },
    },
  );
  return parseAssistantVisionReply(raw, params.userMessage, promptImageState.projectedImageAttachments);
}

function isNetworkDownloadDiscoveryRequest(input: string) {
  return /(?:帮我|请|给我|替我)?\s*(?:下载|获取).+(?:到|至|进|保存|文件夹|目录)|\b(?:download|fetch)\b.+\b(?:to|into|folder|downloads?)\b/i.test(input);
}

function searchDownloadDestination(input: string): 'device' | undefined {
  return /下载文件夹|下载目录|\bdownloads?\b|(?:下载|保存|导出)(?:到|至|进)?(?:我的|本机|本地|电脑|手机|设备|系统)|(?:电脑|手机|设备|本机)(?:上|中|里)?/i.test(input)
    ? 'device'
    : undefined;
}

async function selectDownloadFromSearch(params: {
  api: APIConfig;
  chatId: string;
  userRequest: string;
  results: AiSearchResultItem[];
  signal?: AbortSignal;
}) {
  const allowedUrls = new Set(params.results.map((result) => result.url));
  const raw = await generateResponse(
    params.api,
    [
      '你是网络下载候选选择器，只输出严格 JSON。',
      '从搜索结果中选择一个与用户要求一致、可信且可直接下载的文件 URL。URL 必须与搜索结果中的 URL 完全一致，禁止猜测或拼接新 URL。',
      '应用商店页、产品介绍页、搜索页、登录页和普通网页不是直接文件，不可选择。来源、版本、格式或版权状态不明确时不要擅自下载。',
      '可安全选择时输出 {"url":"...","fileName":"可选"}；否则输出 {"url":"","clarificationQuestion":"需要用户补充的最小信息"}。',
    ].join('\n'),
    [{
      role: 'user',
      content: JSON.stringify({
        userRequest: params.userRequest,
        searchResults: params.results.slice(0, 12).map((result) => ({
          title: result.title,
          url: result.url,
          siteName: result.siteName,
          summary: result.summary || result.snippet,
        })),
      }),
    }],
    undefined,
    {
      responseFormat: 'json',
      maxTokens: 500,
      signal: params.signal,
      aiUsage: { type: 'assistant_chat', label: '助手Agent下载来源选择', scope: 'chat', resourceId: params.chatId },
    },
  );
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()) as { url?: unknown; fileName?: unknown; clarificationQuestion?: unknown };
    const url = typeof parsed.url === 'string' && allowedUrls.has(parsed.url) ? parsed.url : '';
    return {
      url,
      fileName: typeof parsed.fileName === 'string' ? parsed.fileName.trim().slice(0, 180) : undefined,
      clarificationQuestion: typeof parsed.clarificationQuestion === 'string' ? parsed.clarificationQuestion.trim().slice(0, 300) : '',
    };
  } catch {
    return { url: '', fileName: undefined, clarificationQuestion: '' };
  }
}

async function generateAssistantGeneralAnswer(params: {
  api: APIConfig;
  inputCapabilities: AIModelInputCapabilities;
  chat: GroupChat;
  chatId: string;
  userMessage: Message;
  messages: Message[];
  signal?: AbortSignal;
}) {
  const promptImageState = getAssistantPromptImageState(withLatestUserMessage(params.messages, params.userMessage), params.inputCapabilities);
  const raw = await generateResponse(
    params.api,
    [
      buildAssistantSystemPrompt(),
      buildAssistantImageInputPromptBlock(promptImageState),
      'Answer the latest user request directly. If images are provided as multimodal inputs, use their visual content when relevant.',
    ].filter(Boolean).join('\n\n'),
    promptImageState.messages,
    undefined,
    {
      responseFormat: 'text',
      signal: params.signal,
      aiUsage: {
        type: 'assistant_chat',
        label: '助手Agent普通回答',
        scope: 'chat',
        resourceId: params.chatId,
      },
    },
  );
  return parseAssistantVisionReply(raw, params.userMessage, promptImageState.projectedImageAttachments);
}

function createAssistantMediaAttachments(patchSet: AssistantAgentPatchSet, timestamp: number): MessageAttachment[] {
  return (patchSet.mediaTasks || []).map((task, index) => ({
    id: `assistant-image-${timestamp}-${index + 1}`,
    kind: 'image',
    status: 'queued',
    slotId: task.slotId || `image-${index + 1}`,
    promptText: task.prompt,
    altText: task.altText || 'AI 图片',
    caption: task.userCaption || task.altText,
    aspectRatio: task.aspectRatio,
    imageSize: task.imageSize,
    targetArtifactId: task.targetArtifactId,
    targetImageIds: task.targetImageIds,
    referenceImageIds: task.referenceImageIds,
    styleImageIds: task.styleImageIds,
    referenceImages: task.referenceImages,
    createdAt: timestamp + index,
    updatedAt: timestamp + index,
  }));
}

async function processAssistantMediaAttachments(params: {
  message: Message;
  aiProfiles: AIModelProfile[];
  upsertMessage: (message: Message) => void;
}) {
  if (!params.message.metadata?.attachments?.some((attachment) => attachment.status === 'queued')) return;
  const { processRichMessageMedia } = await import('./richMessageMedia');
  try {
    await processRichMessageMedia({
      message: params.message,
      character: null,
      characters: [],
      aiProfiles: params.aiProfiles,
      upsertMessage: params.upsertMessage,
    });
  } catch (error) {
    params.upsertMessage(markAssistantMediaAttachmentsFailed(params.message, error));
  }
}

async function persistAssistantArtifactsFromReply(params: {
  chat: GroupChat;
  chatId: string;
  userMessage: Message;
  messages: Message[];
  selectedArtifactId?: string | null;
  timestamp?: number;
  upsertMessage: (message: Message) => void;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  api: APIConfig;
  inputCapabilities: AIModelInputCapabilities;
  aiProfiles: AIModelProfile[];
  signal?: AbortSignal;
  replySender?: { id: string; name: string };
  forceArtifact?: boolean;
}) {
  if (!isAssistantAgentArtifactEnabled(params.chat)) return null;
  const [
    { planAssistantAgentChange, writeAssistantAgentPatchSet },
    { ensureAssistantArtifactStoreHydrated, useAssistantArtifactStore },
    { useLocalWorkspaceStore },
  ] = await Promise.all([
    import('./assistantAgentOrchestrator'),
    import('../stores/useAssistantArtifactStore'),
    import('../stores/useLocalWorkspaceStore'),
  ]);
  await ensureAssistantArtifactStoreHydrated();
  const existingArtifacts = useAssistantArtifactStore.getState().getArtifactsForChat(params.chatId);
  const localWorkspaceState = useLocalWorkspaceStore.getState();
  const defaultLocalWorkspaceDirectory = localWorkspaceState.getDefaultDirectory();
  const selectedLocalWorkspaceFilePaths = localWorkspaceState.getSelectedFilePaths(params.chatId);
  const resolvedCapabilities = resolveChatAgentCapabilities(params.chat);
  const workspaceDirectories = resolvedCapabilities.workspaceRead
    ? localWorkspaceState.directories
    : [];
  // 仅在用户明确要求扫描/查找/列出文件时枚举工作区，避免每轮对话都扫描本地目录。
  const shouldScanWorkspace = /扫描|列出|枚举|查找|搜索|筛选|统计|大于\s*\d+\s*(?:M|MB|G|GB)|所有文件|文件列表|目录内容|scan|list files|search files|find files/i.test(params.userMessage.content);
  const scanSizeMatch = params.userMessage.content.match(/大于\s*(\d+(?:\.\d+)?)\s*(MB|M|GB|G)/i);
  const extensionMatch = params.userMessage.content.match(/(?:扩展名|后缀|extension)\s*[为是:]?\s*\.?([a-z0-9]{1,12})/i);
  const nameMatch = params.userMessage.content.match(/(?:文件名|名称).*?(?:包含|带有|含有|contains?)\s*[“”"']?([^“”"'，。,\s]{1,80})/i);
  const pathMatch = params.userMessage.content.match(/(?:目录|路径|path)\s*[为是:]?\s*[“”"']?([^“”"'，。,\s]{1,160})/i);
  const scanOptions = {
    ...(scanSizeMatch ? { minSizeBytes: Number(scanSizeMatch[1]) * (scanSizeMatch[2]!.toUpperCase().startsWith('G') ? 1024 ** 3 : 1024 ** 2) } : {}),
    ...(extensionMatch ? { extension: extensionMatch[1] } : {}),
    ...(nameMatch ? { nameContains: nameMatch[1] } : {}),
    ...(pathMatch ? { pathPrefix: pathMatch[1]!.replace(/^\/+|\/+$/g, '') } : {}),
  };
  const directoryListings = shouldScanWorkspace
    ? await Promise.all(workspaceDirectories.map(async (directory) => ({
      directoryId: directory.id,
      files: await localWorkspaceState.listDirectoryFiles(directory.id, scanOptions).catch(() => []),
    })))
    : [];
  let localWorkspaceFileRegistry = directoryListings.flatMap((entry) => entry.files);
  const uploadedFileContexts = buildUploadedFileContexts(params.userMessage);
  const sessionResourceRegistry = resolvedCapabilities.fileDownload
    ? await import('./sessionNetworkResourceStore').then(({ listSessionNetworkResourceRegistry }) => listSessionNetworkResourceRegistry(params.chatId, params.userMessage.content)).catch((error) => {
      console.error('[assistant-agent:session-resource-registry]', error);
      return [];
    })
    : [];
  const plannerFileRegistry = [...localWorkspaceFileRegistry, ...uploadedFileContexts.map((file) => ({ directoryId: file.directoryId, path: file.path, name: file.name, kind: 'file' as const, depth: 1, sizeBytes: file.sizeBytes, mimeType: file.mimeType }))];
  let plan = await planAssistantAgentChange({
    api: params.api,
    chatId: params.chatId,
    messages: params.messages,
    userMessage: params.userMessage,
    existingArtifacts,
    toolCapabilities: {
      webSearch: isAssistantAgentSearchEnabled(params.chat),
      networkAccess: resolvedCapabilities.webSearch || resolvedCapabilities.fileDownload,
      localWorkspace: Boolean(workspaceDirectories.length || uploadedFileContexts.length),
      localWorkspaceDirectories: workspaceDirectories.map((directory) => ({
        id: directory.id,
        name: directory.name,
        isDefault: directory.id === defaultLocalWorkspaceDirectory?.id,
      })),
    },
    localWorkspaceFileRegistry: plannerFileRegistry,
    sessionResourceRegistry,
    interactionFocus: {
      ...(params.selectedArtifactId ? { selectedArtifactId: params.selectedArtifactId } : {}),
      ...(selectedLocalWorkspaceFilePaths.length ? {
        selectedLocalWorkspaceFiles: selectedLocalWorkspaceFilePaths.map((path) => ({
          directoryId: defaultLocalWorkspaceDirectory?.id || '',
          path,
        })),
      } : {}),
    },
    signal: params.signal,
    forceArtifact: params.forceArtifact,
  });
  const runtimeRepair = params.userMessage.metadata?.assistantHtmlRuntimeError;
  const repairTarget = runtimeRepair
    ? existingArtifacts.find((artifact) => artifact.id === (params.selectedArtifactId || runtimeRepair.artifactId) && artifact.kind === 'html' && artifact.deletedAt == null)
    : null;
  if (runtimeRepair && repairTarget) {
    plan = {
      ...plan,
      intent: 'update',
      responseExperience: 'interactive_workspace',
      scope: { targetMode: 'single', artifactIds: [repairTarget.id] },
      operations: [{ kind: 'structure_edit', instruction: `修复 HTML 运行错误：${runtimeRepair.message}` }],
      requiresConfirmation: false,
      clarificationQuestion: '',
      confidence: 1,
      rationale: 'runtime_error_repair',
    } satisfies AssistantAgentChangePlan;
  }
  // Planner may provide a more precise structured scan than the initial intent heuristic.
  const plannedScan = plan.workspaceScan;
  const plannedDirectoryIds = plannedScan?.directoryIds?.length ? new Set(plannedScan.directoryIds) : null;
  if (plannedScan && resolvedCapabilities.workspaceRead) {
    const refinedListings = await Promise.all(workspaceDirectories
      .filter((directory) => !plannedDirectoryIds || plannedDirectoryIds.has(directory.id))
      .map(async (directory) => ({
        directoryId: directory.id,
        files: await localWorkspaceState.listDirectoryFiles(directory.id, {
          ...scanOptions,
          ...plannedScan,
        }).catch(() => []),
      })));
    if (refinedListings.length) {
      directoryListings.splice(0, directoryListings.length, ...refinedListings);
      localWorkspaceFileRegistry = directoryListings.flatMap((entry) => entry.files);
    }
  }
  const selectedLocalFiles = selectedLocalWorkspaceFilePaths.length
    ? selectedLocalWorkspaceFilePaths.map((path) => ({ directoryId: defaultLocalWorkspaceDirectory?.id || '', path }))
    : (plan.localFilePaths || []);
  const networkFiles: AssistantAgentLocalFileContext[] = [];
  if (plan.networkRequests?.length && (resolvedCapabilities.webSearch || resolvedCapabilities.fileDownload)) {
    const { executeNetworkTransferTask } = await import('./networkTransferService');
    for (const [index, request] of plan.networkRequests.slice(0, 4).entries()) {
      try {
        networkFiles.push(...await executeNetworkTransferTask(params.chatId, request));
      } catch (error) {
        const content = `网络资源任务失败。\nURL: ${request.url}\n模式: ${request.mode}\n错误: ${error instanceof Error ? error.message : String(error)}`;
        networkFiles.push({ directoryId: 'network', path: request.url, name: `network-error-${index + 1}`, mimeType: 'text/plain', sizeBytes: content.length, content, truncated: false, originalLength: content.length });
      }
    }
  }
  const sessionNetworkFiles = resolvedCapabilities.fileDownload && plan.sessionResourceIds?.length
    ? await import('./sessionNetworkResourceStore').then(({ getSessionNetworkResourceContexts }) => getSessionNetworkResourceContexts(params.chatId, plan.sessionResourceIds || [], params.userMessage.content, 200_000)).catch((error) => {
      console.error('[assistant-agent:session-resource-context]', error);
      return [];
    })
    : [];
  const workspaceFileContexts = (await Promise.all(Object.entries(selectedLocalFiles.reduce<Record<string, string[]>>((acc, file) => {
    if (!file.directoryId || !workspaceDirectories.some((directory) => directory.id === file.directoryId)) return acc;
    (acc[file.directoryId] ||= []).push(file.path);
    return acc;
  }, {})).map(async ([directoryId, paths]) => localWorkspaceState.readDirectoryTextFiles(directoryId, paths).catch(() => [])))).flat();
  const localFiles = [...uploadedFileContexts, ...networkFiles, ...sessionNetworkFiles, ...workspaceFileContexts];
  if (selectedLocalFiles.length && !workspaceFileContexts.length) {
    const assistantMessage = await persistAssistantFinalMessage({
      chat: params.chat,
      chatId: params.chatId,
      currentMessages: params.messages,
      content: '我找到了你要处理的本地文件引用，但这些文件当前不可读、不是文本类型，或超过了安全读取限制。请换成文本文件，或缩小文件范围后再试。',
      timestamp: params.timestamp,
      upsertMessage: params.upsertMessage,
      replySender: params.replySender,
    });
    await params.updateChat(params.chatId, {
      lastMessageAt: assistantMessage.timestamp,
      latestMessage: assistantMessage,
    });
    return { message: assistantMessage, patchesCommitted: 0 };
  }
  if (plan.intent === 'search') {
    const query = plan.searchQuery?.trim() || params.userMessage.content.trim();
    const recentUserRequestContext = withLatestUserMessage(params.messages, params.userMessage)
      .filter((message) => message.type === 'user' || message.type === 'god')
      .slice(-4)
      .map((message) => message.content.trim())
      .join('\n');
    if (resolvedCapabilities.fileDownload && isNetworkDownloadDiscoveryRequest(recentUserRequestContext)) {
      try {
        const searchResponse = await api.searchWeb(query, {
          source: 'assistant_agent',
          resourceId: params.chatId,
        });
        const selected = await selectDownloadFromSearch({
          api: params.api,
          chatId: params.chatId,
          userRequest: recentUserRequestContext,
          results: searchResponse.results,
          signal: params.signal,
        });
        if (selected.url) {
          const { executeNetworkTransferTask } = await import('./networkTransferService');
          const transferContexts = await executeNetworkTransferTask(params.chatId, {
            url: selected.url,
            mode: 'binary',
            action: searchDownloadDestination(recentUserRequestContext) ? 'export' : 'store',
            destination: searchDownloadDestination(recentUserRequestContext),
            fileName: selected.fileName,
            conflictPolicy: 'rename',
          });
          const transferSummary = transferContexts.find((item) => item.directoryId === 'network-task')?.content
            || '网络文件已下载完成。';
          const assistantMessage = await persistAssistantFinalMessage({
            chat: params.chat,
            chatId: params.chatId,
            currentMessages: params.messages,
            content: transferSummary,
            timestamp: params.timestamp,
            upsertMessage: params.upsertMessage,
            replySender: params.replySender,
          });
          await params.updateChat(params.chatId, { lastMessageAt: assistantMessage.timestamp, latestMessage: assistantMessage });
          return { message: assistantMessage, patchesCommitted: 0 };
        }
        const content = selected.clarificationQuestion
          || '我已搜索可用来源，但没有找到能确认格式、来源和授权状态的直接文件下载地址。请指定需要的文件格式或可信来源，我会继续下载。';
        const assistantMessage = await persistAssistantFinalMessage({
          chat: params.chat,
          chatId: params.chatId,
          currentMessages: params.messages,
          content,
          timestamp: params.timestamp,
          upsertMessage: params.upsertMessage,
          replySender: params.replySender,
        });
        await params.updateChat(params.chatId, { lastMessageAt: assistantMessage.timestamp, latestMessage: assistantMessage });
        return { message: assistantMessage, patchesCommitted: 0 };
      } catch (error) {
        const content = `搜索或下载失败：${error instanceof Error ? error.message : String(error)}`;
        const assistantMessage = await persistAssistantFinalMessage({
          chat: params.chat,
          chatId: params.chatId,
          currentMessages: params.messages,
          content,
          timestamp: params.timestamp,
          upsertMessage: params.upsertMessage,
          replySender: params.replySender,
        });
        await params.updateChat(params.chatId, { lastMessageAt: assistantMessage.timestamp, latestMessage: assistantMessage });
        return { message: assistantMessage, patchesCommitted: 0 };
      }
    }
    const answer = await generateAssistantSearchAnswer({
      api: params.api,
      inputCapabilities: params.inputCapabilities,
      chatId: params.chatId,
      userMessage: params.userMessage,
      messages: params.messages,
      searchQuery: query,
      signal: params.signal,
    });
    const content = answer.content.trim() || '搜索已完成，但没有生成有效回答。';
    const assistantMessage = await persistAssistantFinalMessage({
      chat: params.chat,
      chatId: params.chatId,
      currentMessages: params.messages,
      content,
      timestamp: params.timestamp,
      upsertMessage: params.upsertMessage,
      replySender: params.replySender,
    });
    await params.updateChat(params.chatId, {
      lastMessageAt: assistantMessage.timestamp,
      latestMessage: assistantMessage,
    });
    await persistUserImageSemanticSummary({
      userMessage: params.userMessage,
      imageSummaries: answer.imageSummaries,
      upsertMessage: params.upsertMessage,
    });
    return { message: assistantMessage, patchesCommitted: 0 };
  }
  const latestUserHasImages = hasReadyImageAttachments(params.userMessage);
  if (plan.intent === 'chat' && (plan.assistantMessage?.trim() || localFiles.length || latestUserHasImages || plan.responseExperience === 'source_code')) {
    const answer = localFiles.length
      ? await generateAssistantLocalFileAnswer({
        api: params.api,
        inputCapabilities: params.inputCapabilities,
        chat: params.chat,
        chatId: params.chatId,
        userMessage: params.userMessage,
        messages: params.messages,
        localFiles,
        signal: params.signal,
      })
      : latestUserHasImages || plan.responseExperience === 'source_code'
        ? await generateAssistantGeneralAnswer({
          api: params.api,
          inputCapabilities: params.inputCapabilities,
          chat: params.chat,
          chatId: params.chatId,
          userMessage: params.userMessage,
          messages: params.messages,
          signal: params.signal,
        })
        : { content: (plan.assistantMessage || '').trim(), imageSummaries: [] };
    const content = answer.content.trim() || (plan.assistantMessage || '').trim();
    const assistantMessage = await persistAssistantFinalMessage({
      chat: params.chat,
      chatId: params.chatId,
      currentMessages: params.messages,
      content,
      timestamp: params.timestamp,
      upsertMessage: params.upsertMessage,
      replySender: params.replySender,
    });
    await params.updateChat(params.chatId, {
      lastMessageAt: assistantMessage.timestamp,
      latestMessage: assistantMessage,
    });
    await persistUserImageSemanticSummary({
      userMessage: params.userMessage,
      imageSummaries: answer.imageSummaries,
      upsertMessage: params.upsertMessage,
    });
    return { message: assistantMessage, patchesCommitted: 0 };
  }
  if (plan.intent === 'chat') return null;

  let content = plan.clarificationQuestion || '我需要先确认要处理哪个产物。';
  let patchesCommitted = 0;
  if (plan.intent === 'create' || plan.intent === 'update') {
    let patchSet = await writeAssistantAgentPatchSet({
      api: params.api,
      chatId: params.chatId,
      messages: params.messages,
      userMessage: params.userMessage,
      plan,
      existingArtifacts,
      localFiles,
      workspaceDirectories: workspaceDirectories.map((directory) => ({
        id: directory.id,
        name: directory.name,
        isDefault: directory.id === defaultLocalWorkspaceDirectory?.id,
      })),
      signal: params.signal,
    });
    if (runtimeRepair && repairTarget && !patchSet.patches.some((patch) => patch.action === 'update' && patch.kind === 'html' && patch.artifactId === repairTarget.id)) {
      patchSet = {
        ...patchSet,
        assistantMessage: '页面修复没有生成可应用的新版本，原页面未改变。请重试。',
      };
    }
    let dataResults: AssistantArtifactDataResult[] = [];
    let dataArtifacts = [] as Awaited<ReturnType<typeof useAssistantArtifactStore.getState>>['items'];
    if (patchSet.dataOperations?.length) {
      const applied = useAssistantArtifactStore.getState().applyDataOperations({
        chatId: params.chatId,
        operations: patchSet.dataOperations,
        timestamp: params.timestamp || Date.now(),
      });
      dataResults = applied.results;
      dataArtifacts = applied.artifacts;
      if (!dataArtifacts.length) {
        const dataArtifactIds = new Set(patchSet.dataOperations.map((operation) => operation.artifactId));
        dataArtifacts = useAssistantArtifactStore.getState().items.filter((artifact) => dataArtifactIds.has(artifact.id));
      }
      if (dataArtifacts.length) {
        patchesCommitted += applied.artifacts.length;
      }
    }
    if (patchSet.versionOperations?.length) {
      const appliedVersions = useAssistantArtifactStore.getState().applyVersionOperations({ chatId: params.chatId, operations: patchSet.versionOperations, timestamp: params.timestamp || Date.now() });
      content = [content, ...appliedVersions.results.map((result) => result.error ? `版本操作失败：${result.error}` : result.kind === 'restore' ? '已恢复到指定版本，并移除其后的变更。' : '已按要求清理旧版本。')].filter(Boolean).join('\n\n');
      patchesCommitted += appliedVersions.artifacts.length;
    }
    content = [buildAgentArtifactReplyContent(patchSet), dataResults.length ? formatAssistantDataResults(dataResults) : '']
      .filter(Boolean).join('\n\n');
    let mediaAuthorizationError = '';
    const requestedImageCount = patchSet.mediaTasks?.length || 0;
    if (requestedImageCount > 0 && useAuthStore.getState().authMode === 'cloud') {
      try {
        await api.authorizeImageGenerationBatch(requestedImageCount);
      } catch (error) {
        const fallback = `本次请求包含 ${requestedImageCount} 张图片，当前会员单次批量生成上限不足。请减少图片数量或升级会员后重试。`;
        mediaAuthorizationError = error instanceof Error && error.message ? error.message : fallback;
      }
    }
    const attachments = mediaAuthorizationError ? [] : createAssistantMediaAttachments(patchSet, params.timestamp || Date.now());
    if (mediaAuthorizationError) content = [content, mediaAuthorizationError].filter(Boolean).join('\n\n');
    const workspaceOperations = patchSet.workspaceOperations || [];
    const workspaceDirectoryIds = new Set(workspaceOperations.map((operation) => operation.directoryId));
    const workspacePlan = workspaceOperations.length && resolvedCapabilities.workspaceWrite && workspaceDirectoryIds.size === 1
      ? createLocalWorkspaceMutationPlan(workspaceOperations[0]!.directoryId, workspaceOperations.map((operation) => ({
        kind: operation.kind,
        path: operation.path,
        destinationPath: operation.destinationPath,
        content: operation.content,
        conflictPolicy: operation.conflictPolicy,
        recursive: operation.recursive,
      })))
      : null;
    if (workspaceOperations.length && (!resolvedCapabilities.workspaceWrite || workspaceDirectoryIds.size !== 1)) {
      content = [content, '检测到工作区文件变更请求，但当前聊天未开启工作区写入权限；已停止执行。'].filter(Boolean).join('\n\n');
    } else if (workspacePlan) {
      content = [content, `已生成工作区变更计划（${workspacePlan.mutations.length} 项），请确认后执行。`].filter(Boolean).join('\n\n');
    }
    if (patchSet.patches.length) {
      patchesCommitted = patchSet.patches.length;
    }
    if (!patchSet.patches.length && !attachments.length && !content.trim()) {
      content = '我没有得到可安全提交的产物变更。';
    }
    const assistantMessage = await persistAssistantFinalMessage({
      chat: params.chat,
      chatId: params.chatId,
      currentMessages: params.messages,
      content,
      metadata: attachments.length || workspacePlan ? {
        ...(workspacePlan ? { workspaceMutationPlan: { ...workspacePlan, status: 'pending' as const } } : {}),
        ...(attachments.length ? {
        attachments,
        generation: {
          status: 'queued',
          updatedAt: Date.now(),
        },
        } : {}),
      } : undefined,
      timestamp: params.timestamp,
      upsertMessage: params.upsertMessage,
      replySender: params.replySender,
    });
    if (attachments.length) {
      void processAssistantMediaAttachments({
        message: assistantMessage,
        aiProfiles: params.aiProfiles,
        upsertMessage: params.upsertMessage,
      }).catch(() => undefined);
    }
    if (patchSet.patches.length || dataArtifacts.length) {
      const changedArtifacts = patchSet.patches.length
        ? useAssistantArtifactStore.getState().commitPatchSet({
          chatId: params.chatId,
          messageId: assistantMessage.id,
          patches: patchSet.patches,
          timestamp: assistantMessage.timestamp,
        })
        : [];
      const artifactsById = new Map([...dataArtifacts, ...changedArtifacts].map((artifact) => [artifact.id, artifact]));
      const linkedArtifacts = Array.from(artifactsById.values());
      if (linkedArtifacts.length) {
        const messageWithArtifacts = await persistLocalFirstMessage({
          message: {
            ...assistantMessage,
            metadata: {
              ...(assistantMessage.metadata || {}),
              assistant: {
                ...(assistantMessage.metadata?.assistant || {}),
                artifacts: linkedArtifacts.map((artifact) => {
                  const version = artifact.versions.find((item) => item.id === artifact.currentVersionId)
                    || artifact.versions.at(-1);
                  const htmlRuntime = artifact.kind === 'html' ? version?.htmlRuntime : undefined;
                  return {
                    id: artifact.id,
                    kind: artifact.kind,
                    title: artifact.title,
                    versionId: version?.id,
                    presentation: htmlRuntime
                      ? (htmlRuntime.presentation === 'inline' || htmlRuntime.presentation === 'both' ? 'inline_html' as const : 'fullscreen_html' as const)
                      : 'link' as const,
                    interactionId: htmlRuntime?.submission?.interactionId,
                  };
                }),
              },
            },
          },
          existingLocalMessage: assistantMessage,
          upsertMessage: params.upsertMessage,
        });
        await params.updateChat(params.chatId, {
          lastMessageAt: messageWithArtifacts.timestamp,
          latestMessage: messageWithArtifacts,
        });
        return { message: messageWithArtifacts, patchesCommitted };
      }
    }
    await params.updateChat(params.chatId, {
      lastMessageAt: assistantMessage.timestamp,
      latestMessage: assistantMessage,
    });
    return { message: assistantMessage, patchesCommitted };
  }

  const assistantMessage = await persistAssistantFinalMessage({
    chat: params.chat,
    chatId: params.chatId,
    currentMessages: params.messages,
    content,
    timestamp: params.timestamp,
    upsertMessage: params.upsertMessage,
    replySender: params.replySender,
  });
  await params.updateChat(params.chatId, {
    lastMessageAt: assistantMessage.timestamp,
    latestMessage: assistantMessage,
  });
  return { message: assistantMessage, patchesCommitted };
}

function artifactFenceLanguage(patch: AssistantAgentPatchSet['patches'][number]) {
  if (patch.language) return patch.language;
  if (patch.kind === 'diagram') return 'mermaid';
  if (patch.kind === 'html') return 'html';
  if (patch.kind === 'json') return 'json';
  if (patch.kind === 'table') return 'csv';
  return 'text';
}

function formatPatchForBubble(patch: AssistantAgentPatchSet['patches'][number]) {
  if (patch.kind === 'html') {
    return `\n\n已生成可交互学习页面「${patch.title}」，可直接打开作答。`;
  }
  if (patch.kind === 'table' || patch.kind === 'json') {
    const fileCount = patch.files?.length || 0;
    const contentSize = patch.content.length + (patch.files || []).reduce((total, file) => total + file.content.length, 0);
    return `\n\n已${patch.action === 'create' ? '创建' : '更新'}数据产物「${patch.title}」${fileCount ? `，包含 ${fileCount} 个文件` : ''}（约 ${contentSize.toLocaleString('zh-CN')} 个字符）。完整内容请在产物中查看或下载。`;
  }
  if (patch.kind === 'document') return `\n\n## ${patch.title}\n\n${patch.content}`;
  if (patch.files?.length) {
    return patch.files.map((file) => [
      `\n\n### ${file.path}`,
      `\`\`\`${file.language || artifactFenceLanguage(patch)}`,
      file.content,
      '```',
    ].join('\n')).join('');
  }
  return [
    `\n\n## ${patch.title}`,
    `\`\`\`${artifactFenceLanguage(patch)}`,
    patch.content,
    '```',
  ].join('\n');
}

function normalizeArtifactContentForCompare(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function hasInlineArtifactContent(intro: string, patch: AssistantAgentPatchSet['patches'][number]) {
  const normalizedIntro = normalizeArtifactContentForCompare(intro);
  const candidates = [
    patch.content,
    ...(patch.files || []).map((file) => file.content),
  ]
    .map(normalizeArtifactContentForCompare)
    .filter((content) => content.length >= 80);
  return candidates.some((content) => normalizedIntro.includes(content));
}

export function buildAgentArtifactReplyContent(patchSet: AssistantAgentPatchSet) {
  const intro = patchSet.assistantMessage.trim() || '已完成产物变更。';
  const visiblePatches = patchSet.patches
    .filter((patch) => (patch.content || patch.files?.length) && !hasInlineArtifactContent(intro, patch))
    .slice(0, 3);
  const hasImageTasks = Boolean(patchSet.mediaTasks?.length);
  const imageTaskNotice = hasImageTasks ? '对方正在发送图片，稍等一下。' : '';
  if (!visiblePatches.length && hasImageTasks) return intro || imageTaskNotice;
  if (!visiblePatches.length) return intro;
  return `${intro}${visiblePatches.map(formatPatchForBubble).join('')}${imageTaskNotice ? `\n\n${imageTaskNotice}` : ''}`;
}

export function markAssistantMediaAttachmentsFailed(message: Message, error: unknown): Message {
  const attachments = message.metadata?.attachments || [];
  if (!attachments.some((attachment) => attachment.status === 'queued' || attachment.status === 'generating')) return message;
  const errorText = error instanceof Error ? error.message : String(error || '图片生成失败');
  const nextAttachments = attachments.map((attachment) => (
    attachment.status === 'queued' || attachment.status === 'generating'
      ? { ...attachment, status: 'failed' as const, error: errorText, updatedAt: Date.now() }
      : attachment
  ));
  const generationStatus = nextAttachments.some((attachment) => attachment.status === 'queued' || attachment.status === 'generating')
    ? 'generating'
    : nextAttachments.some((attachment) => attachment.status === 'failed')
      ? 'failed'
      : 'ready';
  return {
    ...message,
    metadata: {
      ...(message.metadata || {}),
      attachments: nextAttachments,
      generation: {
        ...(message.metadata?.generation || {}),
        status: generationStatus,
        updatedAt: Date.now(),
      },
    },
  };
}

async function persistAssistantFinalMessage(params: {
  chat: GroupChat;
  chatId: string;
  currentMessages: Message[];
  content: string;
  metadata?: Partial<MessageMetadata>;
  timestamp?: number;
  upsertMessage: (message: Message) => void;
  replySender?: { id: string; name: string };
}) {
  const assistantDraft: Omit<Message, 'id' | 'timestamp' | 'isDeleted'> = {
    chatId: params.chatId,
    type: 'ai',
    senderId: params.replySender?.id || 'assistant',
    senderName: params.replySender?.name || '助手',
    content: params.content,
    emotion: 0,
    metadata: {
      format: 'markdown',
      assistant: {
        mode: 'general',
      },
      ...(params.metadata || {}),
    },
  };
  const localMessage = createStreamingLocalMessage(
    attachMessageToActiveBranch(params.chat, params.currentMessages, assistantDraft) as Omit<Message, 'id' | 'timestamp' | 'isDeleted'>,
    { timestamp: params.timestamp },
  );
  params.upsertMessage(localMessage);
  return persistLocalFirstMessage({
    message: localMessage,
    existingLocalMessage: localMessage,
    upsertMessage: params.upsertMessage,
  });
}

function toAssistantPromptMessages(messages: Message[], inputCapabilities?: AIModelInputCapabilities) {
  const visible = messages
    .filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event')
    .slice(-MAX_ASSISTANT_HISTORY);
  const latestUserImageMessage = inputCapabilities?.imageInput
    ? [...visible]
      .reverse()
      .find((message) => (
        (message.type === 'user' || message.type === 'god')
        && message.metadata?.attachments?.some((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url))
      ))
    : null;
  return visible
    .map((message) => {
      const imageText = buildAssistantImageAttachmentText(message);
      const content = [message.content, imageText].filter(Boolean).join('\n');
      const attachments = inputCapabilities && latestUserImageMessage?.id === message.id
        ? buildAssistantProjectedImageAttachments(message, inputCapabilities)
        : undefined;
      return {
        role: message.type === 'ai' ? 'assistant' as const : 'user' as const,
        content,
        attachments,
      };
    })
    .filter((message) => message.content.trim() || message.attachments?.length);
}

function getAssistantPromptImageState(messages: Message[], inputCapabilities?: AIModelInputCapabilities) {
  const promptMessages = toAssistantPromptMessages(messages, inputCapabilities);
  return {
    messages: promptMessages,
    hasImageAttachments: messages.some((message) => (
      !message.isDeleted
      && message.type !== 'system'
      && message.type !== 'event'
      && message.metadata?.attachments?.some((attachment) => attachment.kind === 'image' && attachment.status !== 'deleted' && attachment.status !== 'failed')
    )),
    projectedImageAttachments: promptMessages.some((message) => Boolean(message.attachments?.length)),
  };
}

function withLatestUserMessage(messages: Message[], userMessage: Message) {
  if (messages.some((message) => message.id === userMessage.id)) return messages;
  return [...messages, userMessage];
}

function latestUserMessage(messages: Message[]) {
  return [...messages]
    .reverse()
    .find((message) => (
      !message.isDeleted
      && (message.type === 'user' || message.type === 'god')
      && (
        message.content.trim()
        || message.metadata?.attachments?.some((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url))
      )
    )) || null;
}

function hasReadyImageAttachments(message: Message | null | undefined) {
  return Boolean(message?.metadata?.attachments?.some((attachment) => (
    attachment.kind === 'image'
    && attachment.status === 'ready'
    && Boolean(attachment.url)
  )));
}

async function persistUserImageSemanticSummary(params: {
  userMessage: Message;
  imageSummaries: AssistantVisionReply['imageSummaries'];
  upsertMessage: (message: Message) => void;
}) {
  const summaries = new Map(params.imageSummaries.map((item) => [item.attachmentId, item.summary]));
  if (!summaries.size) return;
  const attachments = params.userMessage.metadata?.attachments || [];
  let changed = false;
  const nextAttachments = attachments.map((attachment) => {
    if (attachment.kind !== 'image' || attachment.status !== 'ready' || !attachment.url) return attachment;
    const summary = summaries.get(attachment.id);
    if (!summary) return attachment;
    if (attachment.semanticSummary === summary) return attachment;
    changed = true;
    return {
      ...attachment,
      semanticSummary: summary,
      updatedAt: Date.now(),
    };
  });
  if (!changed) return;
  const metadata: MessageMetadata = {
    ...(params.userMessage.metadata || {}),
    attachments: nextAttachments,
  };
  const nextMessage = {
    ...params.userMessage,
    metadata,
  };
  params.upsertMessage(nextMessage);
  await persistLocalFirstMessage({
    message: nextMessage,
    existingLocalMessage: params.userMessage,
    upsertMessage: params.upsertMessage,
  });
}

function getTitleSource(chat: GroupChat) {
  return chat.modeState?.assistantTitle?.source;
}

function getAssistantTitleContext(messages: Message[]) {
  return messages
    .filter((message) => (
      !message.isDeleted
      && message.type !== 'system'
      && message.type !== 'event'
      && message.content.trim()
    ))
    .slice(-MAX_ASSISTANT_TITLE_CONTEXT);
}

function hasUserMessage(messages: Message[]) {
  const userMessages = messages.filter((message) => (
    !message.isDeleted
    && (message.type === 'user' || message.type === 'god')
    && message.content.trim()
  ));
  return userMessages.length > 0;
}

function formatTitleContext(messages: Message[]) {
  return messages
    .filter((message) => message.type === 'user' || message.type === 'god')
    .map((message) => {
      return `用户：${message.content.trim()}`;
    })
    .join('\n\n');
}

function isDefaultAssistantChatName(name?: string) {
  const normalized = (name || '').trim();
  return !normalized || normalized === DEFAULT_ASSISTANT_CHAT_NAME;
}

function sanitizeGeneratedTitle(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)[0]
    .replace(/^#+\s*/, '')
    .replace(/^["'“”‘’「」《》【】\s]+|["'“”‘’「」《》【】\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_GENERATED_TITLE_LENGTH);
}

function isAssistantReplyStyleTitle(value: string) {
  return /^(?:我(?:已经|已|会|可以|来|将)|我们(?:已经|已|会|可以|来|将)|已(?:经)?|成功|好的|当然|可以|没问题|为你|帮你)/.test(value)
    || /(?:已经|已)(?:成功)?(?:帮|为).*(?:完成|下载|保存|生成|创建|修改)/.test(value);
}

function deriveTitleFromUserRequest(messages: Message[]) {
  const latestUserContent = [...messages]
    .reverse()
    .find((message) => message.type === 'user' || message.type === 'god')
    ?.content.trim() || '';
  return sanitizeGeneratedTitle(latestUserContent)
    .replace(/^(?:请|麻烦|劳驾)?(?:你)?(?:帮我|替我|给我|帮忙)\s*/u, '')
    .replace(/^(?:能不能|可不可以|可以|能否)\s*/u, '')
    .replace(/^(下载|获取|保存)一个(?=\S)/u, '$1')
    .replace(/[。！？!?，,；;：:]+$/u, '')
    .trim()
    .slice(0, MAX_GENERATED_TITLE_LENGTH);
}

export async function maybeGenerateAssistantChatTitle(params: {
  api: APIConfig;
  chat: GroupChat;
  chatId: string;
  currentMessages: Message[];
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
}) {
  if (params.chat.type !== 'assistant') return;
  const currentTitleSource = getTitleSource(params.chat);
  const currentTitle = sanitizeGeneratedTitle(params.chat.name || '');
  if (currentTitleSource === 'user') return;
  if (currentTitleSource === 'ai' && !isAssistantReplyStyleTitle(currentTitle)) return;
  if (!currentTitleSource && !isDefaultAssistantChatName(params.chat.name)) return;
  if (!hasUserMessage(params.currentMessages)) return;
  if (pendingAssistantTitleChatIds.has(params.chatId)) return;
  const titleContext = getAssistantTitleContext(params.currentMessages);
  if (!titleContext.length) return;

  pendingAssistantTitleChatIds.add(params.chatId);
  try {
    const generated = await generateResponse(
      params.api,
      [
        '你是会话标题生成器。',
        '根据下面的用户请求生成一个简短、客观的中文会话标题。',
        '标题是用于会话列表导航的主题标签，不是对用户的回复，也不是任务执行结果。',
        '使用主题短语或动宾短语，优先 4～16 个字。不要使用“我”“我们”“已完成”“成功帮你”等回复式或完成状态文案。',
        '示例：用户请求“帮我下载一个新华字典到下载文件夹”，标题应为“下载新华字典”，不能写“我已经成功帮你下载了新华字典”。',
        '只输出标题本身，不要解释，不要使用 Markdown，不要加引号。',
        `标题最多 ${MAX_GENERATED_TITLE_LENGTH} 个字符。`,
      ].join('\n'),
      [{ role: 'user', content: formatTitleContext(titleContext) }],
      undefined,
      {
        responseFormat: 'text',
        maxTokens: 48,
        aiUsage: {
          type: 'assistant_chat',
          label: '助手会话命名',
          scope: 'chat',
          resourceId: params.chatId,
        },
      },
    );
    const generatedTitle = sanitizeGeneratedTitle(generated);
    const title = generatedTitle && !isAssistantReplyStyleTitle(generatedTitle)
      ? generatedTitle
      : deriveTitleFromUserRequest(titleContext);
    if (!title) return;
    const latestChat = useChatStore.getState().chats.find((item) => item.id === params.chatId);
    if (!latestChat || latestChat.type !== 'assistant') return;
    const latestTitleSource = getTitleSource(latestChat);
    const latestTitle = sanitizeGeneratedTitle(latestChat.name || '');
    if (latestTitleSource === 'user') return;
    if (latestTitleSource === 'ai' && !isAssistantReplyStyleTitle(latestTitle)) return;
    if (!latestTitleSource && !isDefaultAssistantChatName(latestChat.name)) return;
    await params.updateChat(params.chatId, {
      name: title,
      modeState: {
        ...latestChat.modeState,
        assistantTitle: {
          source: 'ai',
          updatedAt: Date.now(),
          basisMessageCount: titleContext.length,
        },
      },
    });
  } catch (error) {
    console.warn('[assistant-title:auto-generate-failed]', error);
  } finally {
    pendingAssistantTitleChatIds.delete(params.chatId);
  }
}

export async function runAssistantChatReplyFlow(params: {
  api: APIConfig;
  aiProfiles: AIModelProfile[];
  chat: GroupChat;
  chatId: string;
  currentMessages: Message[];
  selectedArtifactId?: string | null;
  timestamp?: number;
  upsertMessage: (message: Message) => void;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
  replySender?: { id: string; name: string };
  revisionOfNodeId?: string;
  forceArtifact?: boolean;
}) {
  ensureAssistantReplyStillCurrent(params);
  params = { ...params, chat: useChatStore.getState().chats.find((chat) => chat.id === params.chatId) || params.chat };
  const { api: resolvedApi, inputCapabilities } = resolveTextProfile(params.api, params.aiProfiles);
  if ((params.chat.modeState.agentCapabilities?.enabled || params.chat.modeState.assistantCapabilities?.agent) && !isLearningProgressChat(params.chat)) {
    const userMessage = latestUserMessage(params.currentMessages);
    if (userMessage && !hasReadyImageAttachments(userMessage)) {
      try {
        const { tryRunAssistantAppCommand } = await import('../features/assistantAppTools/assistantAppToolBridge');
        const appCommandResult = await tryRunAssistantAppCommand({
          chatId: params.chatId,
          input: userMessage.content,
          recentMessages: buildAppCommandRecentMessages(params.currentMessages),
          apiConfig: resolvedApi,
          aiProfiles: params.aiProfiles,
        });
        if (appCommandResult) {
          const persisted = await persistAssistantFinalMessage({
            chat: params.chat,
            chatId: params.chatId,
            currentMessages: params.currentMessages,
            content: appCommandResult.content,
            metadata: {
              assistant: {
                mode: 'general',
              },
            },
            timestamp: params.timestamp,
            upsertMessage: params.upsertMessage,
          });
          await params.updateChat(params.chatId, {
            lastMessageAt: persisted.timestamp,
            latestMessage: persisted,
            ...(isMessageBranchingEnabled(params.chat) ? {
              messageBranchState: buildBranchStateWithHead(
                (useChatStore.getState().chats.find((chat) => chat.id === params.chatId) || params.chat).messageBranchState,
                persisted.metadata?.branching?.nodeId || persisted.clientKey || persisted.id,
              ),
            } : {}),
          });
          void maybeGenerateAssistantChatTitle({
            api: resolvedApi,
            chat: params.chat,
            chatId: params.chatId,
            currentMessages: [...params.currentMessages, persisted],
            updateChat: params.updateChat,
          });
          return persisted;
        }
      } catch (error) {
        console.warn('[assistant-app-command:skip]', error);
      }
    }
  }
  if (isAssistantAgentArtifactEnabled(params.chat)) {
    const userMessage = latestUserMessage(params.currentMessages);
    if (userMessage) {
      const agentResult = await persistAssistantArtifactsFromReply({
        chat: params.chat,
        chatId: params.chatId,
        userMessage,
        messages: params.currentMessages,
        selectedArtifactId: params.selectedArtifactId,
        timestamp: params.timestamp,
        upsertMessage: params.upsertMessage,
        updateChat: params.updateChat,
        api: resolvedApi,
        inputCapabilities,
        aiProfiles: params.aiProfiles,
        signal: params.signal,
        replySender: params.replySender,
        forceArtifact: params.forceArtifact,
      });
      if (agentResult?.message) {
        // Artifact replies are committed outside the normal session runner.
        // Advance the branch cursor explicitly, otherwise the next message is
        // attached to the pre-artifact user node and the projection can prune
        // the entire continuation as an inactive subtree.
        const branching = agentResult.message.metadata?.branching;
        const nodeId = branching?.nodeId || agentResult.message.clientKey || agentResult.message.id;
        const latestChat = useChatStore.getState().chats.find((item) => item.id === params.chatId) || params.chat;
        await params.updateChat(params.chatId, {
          messageBranchState: buildBranchStateWithHead(latestChat.messageBranchState, nodeId),
        });
        void maybeGenerateAssistantChatTitle({
          api: resolvedApi,
          chat: params.chat,
          chatId: params.chatId,
          currentMessages: [...params.currentMessages, agentResult.message],
          updateChat: params.updateChat,
        });
        return agentResult.message;
      }
    }
  }
  const assistantDraft: Omit<Message, 'id' | 'timestamp' | 'isDeleted'> = {
    chatId: params.chatId,
    type: 'ai',
    senderId: params.replySender?.id || 'assistant',
    senderName: params.replySender?.name || '助手',
    content: '',
    emotion: 0,
    metadata: {
      format: 'markdown',
      assistant: {
        mode: 'general',
      },
      ...(params.revisionOfNodeId ? { branching: { revisionOfNodeId: params.revisionOfNodeId } } : {}),
    },
  };
  const placeholder = createStreamingLocalMessage(
    attachMessageToActiveBranch(params.chat, params.currentMessages, assistantDraft) as Omit<Message, 'id' | 'timestamp' | 'isDeleted'>,
    { timestamp: params.timestamp },
  );
  let streamingMessage = { ...placeholder, isStreaming: true };
  const display = createStreamingMessageDisplay({
    upsertMessage: (message) => {
      if (params.signal?.aborted || params.shouldContinue?.() === false) {
        display.freeze();
        return;
      }
      params.upsertMessage(message);
    },
    isAnimationEnabled: () => useSettingsStore.getState().enableStreamingDisplayAnimation,
  });
  display.update(streamingMessage, { immediate: true });
  const promptImageState = getAssistantPromptImageState(params.currentMessages, inputCapabilities);
  const shouldStreamVisibleReply = !promptImageState.projectedImageAttachments;
  let replyPersisted = false;
  try {
    const generated = await generateResponse(
      resolvedApi,
      [
        buildAssistantSystemPrompt(),
        buildChatReplyPreferencesPrompt(params.chat, useSettingsStore.getState().chatReplyPreferences),
        buildAssistantImageInputPromptBlock(promptImageState),
      ].filter(Boolean).join('\n\n'),
      promptImageState.messages,
      shouldStreamVisibleReply
        ? (content) => {
          ensureAssistantReplyStillCurrent(params);
          streamingMessage = { ...streamingMessage, content, isStreaming: true };
          display.update(streamingMessage);
        }
        : undefined,
      {
        responseFormat: 'text',
        signal: params.signal,
        aiUsage: {
          type: 'assistant_chat',
          label: '助手回复',
          scope: 'chat',
          resourceId: params.chatId,
        },
      },
    );
    ensureAssistantReplyStillCurrent(params);
    const visionReply = parseAssistantVisionReply(
      generated,
      latestUserMessage(params.currentMessages) || params.currentMessages.at(-1) || streamingMessage,
      promptImageState.projectedImageAttachments,
    );
    const content = visionReply.content.trim();
    if (!content) throw new Error('助手没有生成有效内容');
    display.freeze();
    const persisted = await persistLocalFirstMessage({
      message: {
        ...streamingMessage,
        content,
        isStreaming: false,
      },
      existingLocalMessage: display.getDisplayed() || streamingMessage,
      upsertMessage: params.upsertMessage,
      localReveal: useSettingsStore.getState().enableStreamingDisplayAnimation,
      shouldContinue: () => !params.signal?.aborted && (params.shouldContinue?.() ?? true),
    });
    replyPersisted = true;
    ensureAssistantReplyStillCurrent(params);
    const latestChat = useChatStore.getState().chats.find((item) => item.id === params.chatId) || params.chat;
    const persistedNodeId = persisted.metadata?.branching?.nodeId || persisted.clientKey || persisted.id;
    await params.updateChat(params.chatId, {
      messageBranchState: buildBranchStateWithHead(latestChat.messageBranchState, persistedNodeId),
      lastMessageAt: persisted.timestamp,
      latestMessage: persisted,
    });
    await persistUserImageSemanticSummary({
      userMessage: latestUserMessage(params.currentMessages) || params.currentMessages.at(-1) || streamingMessage,
      imageSummaries: visionReply.imageSummaries,
      upsertMessage: params.upsertMessage,
    });
    void maybeGenerateAssistantChatTitle({
      api: resolvedApi,
      chat: params.chat,
      chatId: params.chatId,
      currentMessages: [...params.currentMessages, persisted],
      updateChat: params.updateChat,
    });
    return persisted;
  } catch (error) {
    if (!replyPersisted) {
      params.upsertMessage({ ...streamingMessage, content: '', isStreaming: true, isDeleted: true });
    }
    throw error;
  } finally {
    display.clear();
  }
}
