import type {
  AssistantAgentChangePlan,
  AssistantAgentLocalFileContext,
  AssistantAgentMediaTask,
  AssistantAgentPatch,
  AssistantAgentPatchSet,
  AssistantArtifactDataOperation,
  AssistantArtifactVersionOperation,
  AssistantArtifactFile,
  AssistantArtifactItem,
  AssistantArtifactKind,
  AssistantDataFilter,
  AssistantDataFilterOperator,
} from '../types/assistantArtifact';
import type { Message, MessageAttachment } from '../types/message';
import type { APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';
import { enhanceImagePrompt } from './imagePromptComposer';
import { logRecoverableError } from './diagnostics';
import { normalizeAssistantHtmlRuntime } from '../features/assistantHtml/assistantHtmlValidation';
import { summarizeAssistantArtifactData } from './assistantArtifactData';
import { parseAssistantAgentWriterOutput } from './assistantAgentWriterProtocol';

const VALID_ARTIFACT_KINDS = new Set<AssistantArtifactKind>(['document', 'code', 'diagram', 'html', 'table', 'json', 'text', 'image']);
const MAX_RECENT_MESSAGES = 12;
const MAX_IMAGE_REFERENCES = 48;
const MAX_ARTIFACTS_IN_REGISTRY = 120;
const MAX_PATCHES = 20;
const SUPPORTED_IMAGE_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
const SUPPORTED_IMAGE_SIZES = new Set(['1K', '2K', '4K']);
const MAX_CONTENT_CHARS = 120_000;
const MAX_FILE_CONTENT_CHARS = 120_000;
const MAX_ASSISTANT_VISIBLE_MESSAGE_CHARS = 12_000;
const MAX_AGENT_REQUEST_CHARS = 420_000;
const MAX_TOTAL_TARGET_CONTEXT_CHARS = 180_000;
const MAX_SINGLE_TARGET_CONTEXT_CHARS = 80_000;
const MAX_LOCAL_WORKSPACE_FILES_IN_REGISTRY = 160;
const MAX_LOCAL_FILE_CONTEXT_CHARS = 120_000;
const INLINE_IMAGE_ATTACHMENT_PATTERN = /!\[([^\]\n]*)\]\(attachment:(?:\/\/)?([^)\s]+)\)/g;
// This is an output safety ceiling, not a context-window limit. 64K tokens
// covers long HTML/document artifacts while keeping accidental runaway output
// bounded across providers with different maximum-output policies.
const MAX_WRITER_OUTPUT_TOKENS = 65_536;

export interface CompactImageAttachmentRef {
  id: string;
  messageId: string;
  refId: string;
  artifactId?: string;
  mimeType?: string;
  altText: string;
  caption?: string;
  promptText?: string;
  semanticSummary?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  urlKind: 'data' | 'remote' | 'local' | 'unknown';
}

interface ImageAttachmentRef extends CompactImageAttachmentRef {
  url: string;
}

function imageArtifactIdForAttachment(message: Message, attachment: MessageAttachment) {
  if (attachment.targetArtifactId) return attachment.targetArtifactId;
  return message.type === 'ai' ? `assistant-image-artifact-${message.id}-${attachment.id}` : undefined;
}

export class AssistantAgentFormatError extends Error {
  constructor() {
    super('Agent 返回内容格式错误，无法解析为有效 JSON');
    this.name = 'AssistantAgentFormatError';
  }
}

function safeJsonParse(value: string): unknown {
  const trimmed = value.trim();
  let parseError = '';
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    if (fenced) {
      try { return JSON.parse(fenced); } catch (fencedError) {
        parseError = fencedError instanceof Error ? fencedError.message : String(fencedError);
      }
    }
    const objectMatch = trimmed.match(/\{[\s\S]*}/);
    if (objectMatch) {
      try { return JSON.parse(objectMatch[0]); } catch (objectError) {
        parseError = objectError instanceof Error ? objectError.message : String(objectError);
      }
    }
    const positionMatch = parseError.match(/position\s+(\d+)/i);
    const lineMatch = parseError.match(/line\s+(\d+)/i);
    const columnMatch = parseError.match(/column\s+(\d+)/i);
    console.error('[assistant-agent:invalid-json]', {
      responseLength: value.length,
      position: positionMatch ? Number(positionMatch[1]) : undefined,
      line: lineMatch ? Number(lineMatch[1]) : undefined,
      column: columnMatch ? Number(columnMatch[1]) : undefined,
    });
    throw new AssistantAgentFormatError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function compactContextText(value: string, max: number) {
  if (value.length <= max) {
    return { content: value, truncated: false, originalLength: value.length };
  }
  if (max <= 1200) {
    return {
      content: value.slice(0, max),
      truncated: true,
      originalLength: value.length,
    };
  }
  const headLength = Math.floor(max * 0.65);
  const tailLength = max - headLength - 220;
  return {
    content: [
      value.slice(0, headLength),
      `\n\n[上下文已裁剪：原始长度 ${value.length} 字符，中间内容未发送给模型。若修改需要完整正文，必须拒绝生成 patch 并要求用户缩小范围。]\n\n`,
      value.slice(Math.max(headLength, value.length - Math.max(0, tailLength))),
    ].join(''),
    truncated: true,
    originalLength: value.length,
  };
}

function stringifyAgentPayload(payload: Record<string, unknown>, label: string) {
  const content = JSON.stringify(payload);
  if (content.length > MAX_AGENT_REQUEST_CHARS) {
    throw new Error(`${label} payload is too large (${content.length} chars, limit ${MAX_AGENT_REQUEST_CHARS}). Reduce artifact context before calling the model.`);
  }
  return content;
}

function numberInRange(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function artifactCurrentVersion(item: AssistantArtifactItem) {
  return item.versions.find((version) => version.id === item.currentVersionId) || item.versions[item.versions.length - 1] || null;
}

function artifactRegistry(artifacts: AssistantArtifactItem[]) {
  return artifacts
    .filter((artifact) => artifact.deletedAt == null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_ARTIFACTS_IN_REGISTRY)
    .map((artifact) => {
      const currentVersion = artifactCurrentVersion(artifact);
      return {
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        summary: artifact.summary || '',
        language: artifact.language || null,
        versionCount: artifact.versions.length,
        currentVersionId: artifact.currentVersionId,
        currentVersionSummary: currentVersion?.changeSummary || artifact.summary || '',
        files: currentVersion?.files?.map((file) => ({
          id: file.id,
          path: file.path,
          language: file.language || null,
          size: file.content.length,
        })) || [],
        data: artifact.kind === 'table' || artifact.kind === 'json' ? summarizeAssistantArtifactData(artifact) : undefined,
        dataDescriptor: artifact.dataDescriptor,
        updatedAt: artifact.updatedAt,
      };
    });
}

function recentConversation(messages: Message[]) {
  return messages
    .filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event' && message.content.trim())
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => ({
      id: message.id,
      role: message.type === 'ai' ? 'assistant' : 'user',
      content: message.content.slice(0, 6000),
      imageAttachments: buildCompactImageAttachmentRefs(message),
    }));
}

function withLatestUserMessage(messages: Message[], userMessage: Message) {
  return messages.some((message) => message.id === userMessage.id)
    ? messages
    : [...messages, userMessage];
}

function getImageUrlKind(url: string): CompactImageAttachmentRef['urlKind'] {
  if (url.startsWith('data:image/')) return 'data';
  if (/^https?:\/\//i.test(url)) return 'remote';
  if (url.startsWith('blob:') || url.startsWith('filesystem:')) return 'local';
  return 'unknown';
}

function compactImageAttachmentRef(ref: ImageAttachmentRef, includePromptText = false): CompactImageAttachmentRef {
  return {
    id: ref.id,
    messageId: ref.messageId,
    refId: ref.refId,
    artifactId: ref.artifactId,
    mimeType: ref.mimeType,
    altText: ref.altText,
    caption: ref.caption,
    ...(includePromptText && ref.promptText ? { promptText: ref.promptText } : {}),
    ...(ref.semanticSummary ? { semanticSummary: ref.semanticSummary } : {}),
    width: ref.width,
    height: ref.height,
    sizeBytes: ref.sizeBytes,
    urlKind: ref.urlKind,
  };
}

function imageAttachmentRefsWithUrls(message: Message): ImageAttachmentRef[] {
  return (message.metadata?.attachments || [])
    .filter((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && attachment.url)
    .slice(0, 6)
    .map((attachment) => ({
      id: attachment.id,
      messageId: message.id,
      refId: `${message.id}:${attachment.id}`,
      artifactId: imageArtifactIdForAttachment(message, attachment),
      url: attachment.url as string,
      mimeType: attachment.mimeType,
      altText: attachment.altText,
      caption: attachment.caption,
      promptText: attachment.promptText?.trim().slice(0, 800),
      semanticSummary: attachment.semanticSummary?.trim().slice(0, 800),
      width: attachment.width,
      height: attachment.height,
      sizeBytes: attachment.sizeBytes,
      urlKind: getImageUrlKind(attachment.url as string),
    }));
}

export function buildCompactImageAttachmentRefs(message: Message, options: { includePromptText?: boolean } = {}) {
  return imageAttachmentRefsWithUrls(message).map((ref) => compactImageAttachmentRef(ref, options.includePromptText));
}

function buildImageReferenceRegistry(messages: Message[]) {
  const registry = new Map<string, ImageAttachmentRef>();
  for (const message of messages) {
    for (const ref of imageAttachmentRefsWithUrls(message)) {
      registry.set(ref.refId, ref);
      registry.set(ref.id, ref);
    }
  }
  return registry;
}

export function buildCompactImageReferenceRegistry(messages: Message[]) {
  const latestImageMessageId = messages
    .filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event')
    .filter((message) => message.metadata?.attachments?.some((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url)))
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.id;
  return messages
    .filter((message) => !message.isDeleted)
    .sort((left, right) => right.timestamp - left.timestamp)
    .flatMap((message) => buildCompactImageAttachmentRefs(message, { includePromptText: message.id === latestImageMessageId }).map((ref) => ({
      ...ref,
      messageRole: message.type === 'ai' ? 'assistant' : message.type === 'user' || message.type === 'god' ? 'user' : 'other',
      messageContentPreview: message.content.trim().slice(0, 240),
      messageTimestamp: message.timestamp,
    })))
    .slice(0, MAX_IMAGE_REFERENCES);
}

function buildPlannerPrompt(options: { includeImages: boolean; includeLocalFiles: boolean; includeSessionResources: boolean; includeSearch: boolean; includeNetwork: boolean; includeData: boolean }) {
  const sections = [
    '你是 Agent Intent Planner。只负责决策，不生成产物正文；只输出严格 JSON。',
    '结合用户输入、最近对话、产物注册表和交互焦点判断，不要要求用户使用“HTML/产物”等技术词。',
    '普通问答=chat；创建结果=create；修改现有产物=update；目标不明确=clarify。不要猜多个候选目标。',
    '需要创建图片或图片变体=create。',
    'structured_input 用于少量字段的小表单、单题投票/选择、简短反馈，以及汇率换算、单位换算等可在原地完成的轻量计算工具；是否提交给助手是独立选择，本地计算无需提交。interactive_workspace 用于多题试卷/问卷、多步骤配置、连续练习、审批及代码量较大的复杂工具；不能仅因为是计算器就选择完整页面。visual_explanation 用于复杂图表、对比表和公式。HTML 只是实现方式。',
    'source_code 只在用户明确要源码时使用，并输出 intent=chat；每轮必须选择 responseExperience。',
    'selectedArtifactId 存在且用户说“这个/当前产物/改一下”等相对指代时优先作为 update 目标；没有唯一目标则 clarify。',
  ];
  if (options.includeSearch) sections.push('搜索：需要实时消息、网页资料或外部核验且 webSearch=true 时输出 search 并填写 searchQuery；未开启时说明能力未开启。用户要求下载一个可通过名称识别但没有提供 URL 的网络资源时，应先 search 自动寻找可信下载来源，不要先要求用户提供网址。');
  if (options.includeNetwork) sections.push('网络资源：每轮最多 4 个网络任务，一个目录递归下载算一个任务。支持 http/https/ftp/ftps；网页阅读 mode=readable、明确读取源码 mode=source、文件 mode=binary。action=read 仅作为上下文；用户只说“下载/保存/稍后使用”但没指定位置时用 action=store 且不填 destination，由客户端静默选择会话内部存储或已配置的默认工作区；只有用户明确说保存到电脑、手机、设备或系统下载目录时才用 action=export、destination=device。用户明确指定工作区时用 destination=workspace，并从 localWorkspaceRegistry 选择唯一匹配的 workspaceId；无法唯一匹配且没有默认工作区时必须 intent=clarify 先询问，不能猜测。目录批量任务设置 recursive=true；目录会自动合并目录树。conflictPolicy 默认 rename，为同名文件增加 (1)、(2) 后缀；只有用户明确要求覆盖时才用 overwrite，明确要求跳过同名文件时用 skip。“合并文件夹”不等于合并同名文件内容；用户要求合并 JSON/CSV/文本内容时必须先读取目标文件并生成工作区变更计划。用户要求解压时设置 extractArchives=true。不要虚构 URL，不要把密码写入 URL，不要访问本应用、localhost 或内网。');
  if (options.includeSessionResources) sections.push('会话网络资源：sessionResourceRegistry 是此前保存到本会话内部存储的文件清单。只有用户本轮明确引用、处理或询问其中的文件时，才把对应 ID 放入 sessionResourceIds；普通对话不要选择。最多选择 32 个，正文会在后续阶段按动态预算加载。');
  if (options.includeLocalFiles) sections.push('本地文件：只使用 registry 中的文件；用户未明确目标时 clarify，未授权时不要假装读取；输出 localFilePaths 时必须使用 registry 中的 directoryId/path。需要扫描时可输出 workspaceScan（directoryIds、pathPrefix、nameContains、extension、minSizeBytes、maxSizeBytes、maxEntries、maxDepth），扫描结果不等于文件正文。');
  if (options.includeImages) sections.push('图片：结合图片注册表判断目标/参考图，不要虚构图片 ID；图片生成仍由后续 writer/media task 处理。');
  if (options.includeData) sections.push('数据产物：已有 table/json 产物的筛选、统计、插入、更新或删除使用结构化数据操作；优先使用注册表中的字段、描述和统计摘要，不加载完整文件。');
  sections.push(
    '输出：',
    '{"intent":"chat|create|update|clarify|search","assistantMessage":"chat/clarify 可见回复","responseExperience":"direct_answer|source_code|structured_input|interactive_workspace|visual_explanation","searchQuery":"","networkRequests":[{"url":"https://... 或 ftp://...","mode":"readable|source|binary","action":"read|store|export","recursive":false,"extractArchives":false,"destination":"session|workspace|device","workspaceId":"可选","destinationPath":"可选","fileName":"可选","conflictPolicy":"rename|skip|overwrite"}],"localFilePaths":[],"sessionResourceIds":[],"workspaceScan":{"directoryIds":[],"pathPrefix":"","nameContains":"","extension":"","minSizeBytes":0,"maxSizeBytes":0,"maxEntries":160,"maxDepth":4},"scope":{"targetMode":"single|multi|workspace|selection|unknown","artifactIds":[]},"operations":[{"kind":"style_change|content_edit|structure_edit|create|export|review|search|other","instruction":"..."}],"requiresConfirmation":false,"clarificationQuestion":"","confidence":0,"rationale":"..."}',
  );
  return sections.join('\n');
}

function normalizePlan(
  raw: unknown,
  existingArtifacts: AssistantArtifactItem[],
  localWorkspaceFileRegistry: Array<{ directoryId: string; path: string; kind: string }> = [],
  validSessionResourceIds = new Set<string>(),
  validWorkspaceIds = new Set<string>(),
  defaultWorkspaceId?: string,
): AssistantAgentChangePlan {
  const existingIds = new Set(existingArtifacts.filter((item) => item.deletedAt == null).map((item) => item.id));
  const validLocalFileKeys = new Set(localWorkspaceFileRegistry.filter((item) => item.kind === 'file').map((item) => `${item.directoryId}:${item.path}`));
  if (!isRecord(raw)) {
    return {
      intent: 'chat',
      assistantMessage: '',
      scope: { targetMode: 'unknown', artifactIds: [] },
      operations: [],
      requiresConfirmation: false,
      confidence: 0,
    };
  }
  const intent = raw.intent === 'create' || raw.intent === 'update' || raw.intent === 'clarify' || raw.intent === 'search' ? raw.intent : 'chat';
  const rawScope = isRecord(raw.scope) ? raw.scope : {};
  const targetMode = ['single', 'multi', 'workspace', 'selection', 'unknown'].includes(String(rawScope.targetMode))
    ? rawScope.targetMode as AssistantAgentChangePlan['scope']['targetMode']
    : 'unknown';
  const artifactIds = Array.isArray(rawScope.artifactIds)
    ? rawScope.artifactIds.filter((id): id is string => typeof id === 'string' && existingIds.has(id))
    : [];
  const operations = Array.isArray(raw.operations) ? raw.operations.flatMap((item): AssistantAgentChangePlan['operations'] => {
    if (!isRecord(item)) return [];
    const kind = ['style_change', 'content_edit', 'structure_edit', 'create', 'export', 'review', 'search', 'other'].includes(String(item.kind))
      ? item.kind as AssistantAgentChangePlan['operations'][number]['kind']
      : 'other';
    const instruction = text(item.instruction, 500);
    return instruction ? [{ kind, instruction }] : [];
  }) : [];
  const localFilePaths = Array.isArray(raw.localFilePaths)
    ? raw.localFilePaths.flatMap((item): NonNullable<AssistantAgentChangePlan['localFilePaths']> => {
        if (!isRecord(item)) return [];
        const directoryId = text(item.directoryId, 160);
        const path = text(item.path, 480).replace(/^\/+/, '');
        if (!directoryId || !path || !validLocalFileKeys.has(`${directoryId}:${path}`)) return [];
        return [{ directoryId, path }];
      }).slice(0, 12)
    : [];
  const sessionResourceIds = Array.isArray(raw.sessionResourceIds)
    ? raw.sessionResourceIds.filter((id): id is string => typeof id === 'string' && validSessionResourceIds.has(id)).slice(0, 32)
    : [];
  const rawScan = isRecord(raw.workspaceScan) ? raw.workspaceScan : null;
  const workspaceScan = rawScan ? {
    directoryIds: Array.isArray(rawScan.directoryIds) ? rawScan.directoryIds.filter((id): id is string => typeof id === 'string' && id.length <= 160).slice(0, 12) : undefined,
    pathPrefix: text(rawScan.pathPrefix, 480) || undefined,
    nameContains: text(rawScan.nameContains, 160) || undefined,
    extension: text(rawScan.extension, 32).replace(/^\./, '').toLowerCase() || undefined,
    minSizeBytes: numberInRange(rawScan.minSizeBytes, 0),
    maxSizeBytes: numberInRange(rawScan.maxSizeBytes, 0),
    maxEntries: Math.max(1, Math.min(500, Math.floor(numberInRange(rawScan.maxEntries, 160) || 160))),
    maxDepth: Math.max(1, Math.min(8, Math.floor(numberInRange(rawScan.maxDepth, 4) || 4))),
  } : undefined;
  const networkRequests = Array.isArray(raw.networkRequests) ? raw.networkRequests.flatMap((item): NonNullable<AssistantAgentChangePlan['networkRequests']> => {
    if (!isRecord(item)) return [];
    const url = text(item.url, 2000);
    const mode = item.mode === 'source' || item.mode === 'binary' || item.mode === 'download' ? (item.mode === 'download' ? 'binary' : item.mode) : 'readable';
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(parsed.protocol) || parsed.username || parsed.password) return [];
    } catch { return []; }
    const action = item.action === 'store' || item.action === 'export' ? item.action : 'read';
    const requestedDestination = item.destination === 'workspace' || item.destination === 'device' ? item.destination : item.destination === 'session' ? 'session' : undefined;
    const destination = action === 'export' ? 'device' : requestedDestination === 'device' ? undefined : requestedDestination;
    const requestedWorkspaceId = text(item.workspaceId, 160);
    const workspaceId = destination === 'workspace'
      ? requestedWorkspaceId ? (validWorkspaceIds.has(requestedWorkspaceId) ? requestedWorkspaceId : undefined) : defaultWorkspaceId
      : undefined;
    const conflictPolicy: 'rename' | 'skip' | 'overwrite' = item.conflictPolicy === 'skip' || item.conflictPolicy === 'overwrite' ? item.conflictPolicy : 'rename';
    return [{ url, mode, action, recursive: Boolean(item.recursive), extractArchives: Boolean(item.extractArchives), destination, workspaceId, destinationPath: text(item.destinationPath, 480) || undefined, fileName: text(item.fileName, 180) || undefined, conflictPolicy }];
  }).slice(0, 4) : [];
  const normalizedIntent = intent === 'update' && artifactIds.length === 0 ? 'clarify' : intent;
  const responseExperience = ['direct_answer', 'source_code', 'structured_input', 'interactive_workspace', 'visual_explanation'].includes(String(raw.responseExperience))
    ? raw.responseExperience as NonNullable<AssistantAgentChangePlan['responseExperience']>
    : undefined;
  return {
    intent: normalizedIntent,
    assistantMessage: text(raw.assistantMessage, 8000),
    scope: { targetMode, artifactIds },
    operations,
    requiresConfirmation: Boolean(raw.requiresConfirmation) || normalizedIntent === 'clarify',
    clarificationQuestion: text(raw.clarificationQuestion, 300),
    searchQuery: text(raw.searchQuery, 300),
    localFilePaths,
    sessionResourceIds,
    workspaceScan,
    networkRequests,
    responseExperience,
    confidence: numberInRange(raw.confidence, 0),
    rationale: text(raw.rationale, 500),
  };
}

function buildWriterPrompt(options: { includeImages: boolean; includeLocalFiles: boolean; includeHtml: boolean; includeData: boolean; requiresHtmlRuntimeRepair?: boolean }) {
  const sections = [
    '你是企业级 Artifact Patch Writer。',
    '输出由 JSON 元数据和独立正文块组成，不要在协议之外输出解释。JSON 内只放元数据，不要把完整源码转义后嵌入 JSON 字符串。',
    '根据 changePlan、用户输入、最近对话、图片引用注册表、产物注册表和必要的当前版本正文，生成可提交的 patch set。',
    '如果 localFiles 非空，可以把它们作为用户授权的文件内容使用；localFiles 之外的本地文件都没有读取权限，不能假装知道。',
    '',
    '规则：',
    '1. 只对 changePlan.scope.artifactIds 中的现有产物执行 update。',
    '2. create 可以创建新产物。',
    '3. update 必须带 artifactId 和 baseVersionId。',
    '4. content 必须是完整新版本，不能是说明、占位、省略或“参考上文”。',
    '5. 多文件产物可以输出 files；单文件/文档可以只输出 content。',
    '6. 不确定时 assistantMessage 说明无法安全修改，patches 为空。',
    '6.1 如果 targetArtifacts 中 currentVersionContentTruncated 或 currentVersionFiles[].contentTruncated 为 true，说明完整正文未发送给你；任何 update patch 仍然必须输出完整新版本。若无法基于已发送内容安全重建完整版本，必须返回 patches=[] 并要求用户缩小修改范围或打开具体文件后重试，禁止编造缺失正文。',
    '6.2 assistantMessage 不要重复输出 patches[].content 或 files[].content 的完整正文/源码。产物正文只放在 patch content/files 中；assistantMessage 只写简短说明、必要的前言或图片槽位。',
  ];
  if (options.includeImages) sections.push(
    '图片：如需生成图片必须输出 mediaTasks，不要把图片写成代码或 Markdown 正文；图片引用 ID 必须来自 registry，区分 target/reference/style；仅在需要图片时生成 prompt。单次数量由当前会员权益校验，超限时系统会拒绝整批任务。',
  );
  if (options.includeLocalFiles) sections.push(
    '本地文件：localFiles 是唯一授权内容；不得假装读取未提供的文件。',
    '工作区写操作：仅当用户明确要求修改、删除、复制或移动时输出 workspaceOperations；每项必须含 directoryId、相对 path 和 kind=write|delete|copy|move。删除目录时用户明确要求“连同内容/递归删除”才设置 recursive=true。write/copy/move 的 conflictPolicy 默认 rename；只有用户明确要求时使用 overwrite 或 skip。高风险操作会先生成待确认计划，不要假设已经写入磁盘。',
  );
  if (options.includeData) sections.push(
    'CSV/JSON：已有数据产物优先使用 dataOperations 做本地增量 query/insert/update/delete/add_column，不要把完整大文件放入上下文；query 最多返回 100 行。创建新的 CSV/JSON 仍使用 patches，更新已有数据产物时只返回 dataOperations，不要伪造完整文件内容。增加 CSV 列使用 add_column（column/defaultValue）；JSON 没有固定列，要求增加字段时使用 update values 并配合 filter。筛选条件支持 field 的点路径（如 profile.name）、比较 eq/contains/startsWith/endsWith/gt/gte/lt/lte，以及 exists/notExists/isNull/isNotNull；顶层 filter 数组是 AND，可用 all/any/not 组合 AND/OR/NOT。',
    '版本管理：如用户要求恢复到指定版本，输出 versionOperations kind=restore；如要求仅保留最近 N 个版本，输出 kind=limit keepCount=N。restore 会以指定版本为当前版本并丢弃其后版本，limit 不得删除当前版本。',
  );
  if (options.includeHtml) sections.push(
    'HTML：structured_input 生成小型交互控件，interactive_workspace 生成完整页面，visual_explanation 按规模选择。HTML 可使用外部 https/http 资源、脚本和网络请求；运行环境会阻止本应用、localhost、回环和内网地址。禁止 iframe/object/embed，以及 parent/top、Cookie 和应用存储访问。submission.fields 必须与 name 一致；提交回流必须 update 原产物并使用完整新版本。页面中的 catch 绝不能只更新“失败，请重试”或“查看详情”等 UI 文案：必须先保留原始异常，再调用 console.error(error) 或 window.pneumataReportError?.(error, “具体阶段”)，其中 error 必须包含真实 message/stack（未知值先用 new Error(String(reason)) 包装）；异步请求、初始化、关卡/游戏逻辑、提交和事件回调都必须遵守。若 UI 提供“查看详情”，详情内容必须来自同一个原始异常，并在捕获时主动上报，不能等运行时从页面文案猜测。颜色使用 --pneumata-* 变量，并提供 light/dark 属性主题和 prefers-color-scheme dark；HTML 只是交互手段，不在 assistantMessage 输出源码。',
  );
  if (options.requiresHtmlRuntimeRepair) sections.push(
    'HTML 运行诊断修复：这是针对指定 HTML 产物的强制修复任务。必须输出恰好一个 action=update、kind=html 的 patch，并使用 targetArtifacts 中该产物的 id 与 currentVersionId。patch.content 必须是修复后的完整页面源码，而不是修复说明、伪代码或片段。若无法生成完整源码，返回 patches=[] 并在 assistantMessage 明确说明“原页面未改变”；绝不能声称已经修复。',
  );
  sections.push('assistantMessage 是用户可见的简短自然回复，不重复完整产物正文。');
  if (options.includeImages) sections.push(
    '7.2 mediaTasks.prompt 是给图片模型的完整提示词；aspectRatio、imageSize、referenceImageIds 等图片要求只能放在 mediaTasks 中，不要混入聊天正文。',
    '7.3 每个图片任务必须有稳定 slotId，例如 image-1、cover、step-2；assistantMessage 中用 Markdown 图片占位符引用：![给用户看的图片说明](attachment:slotId)。slotId 必须和 mediaTasks[].slotId 完全一致。',
    '7.4 mediaTasks.userCaption 是该图片在正文中的用户可见说明，应和 Markdown 图片占位符的 alt 文本一致或高度接近；不得写图片模型提示词。',
    '7.5 复合指令应拆成多张独立图片任务，例如封面、步骤图、风格 A/B/C，而不是把多张图塞进一个 prompt。',
    '7.6 mediaTasks.prompt 必须是完整、专业、可直接给图片模型执行的最终提示词，不是对图片模型说“请你再写提示词”。',
    '7.7 生成 mediaTasks.prompt 前，必须先在内部梳理：用户本轮真正要生成/修改什么、最近对话中已经确定的主题/角色/风格/禁忌/数量/用途、用户偏好的审美词、哪些历史图片或产物被明确指代、哪些上下文只是聊天噪音不能继承。只把结论写进最终 prompt，不要把分析过程输出给用户。',
    '7.8 用户只给出很短的主题时，要结合 recentConversation、userMessage、imageReferenceRegistry、artifactRegistry 和 changePlan 自动扩写为具体视觉方案；但必须按内容智能选择、增删和组合属性，这些只是可选层级，不是固定清单：主体身份、场景动作、构图/版式、镜头或渲染风格、光线、色彩、材质细节、情绪、质量层级与禁用项。文本图、UI图、OCR/读图、清晰化、锐化、修复、保真编辑应优先准确性、可读性和保留原貌，不要硬塞电影光影、情绪、镜头、奢华风格等无关词；保留用户指定的风格词和具体物件，但不能擅自换成另一个主体或目标。',
    '7.9 如果用户已经给出高密度、完整、风格明确的生图提示词，mediaTasks.prompt 应尽量保留原文和结构，只做必要的上下文补全、冲突消解和安全约束；不要为了“优化”而改写成另一套审美。',
    '8. imageReferenceRegistry 是最近聊天图片的轻量注册表；不要默认把所有历史图片当参考图。只有当用户当前指令、最近上下文、图片说明、消息顺序或显式选择能明确定位时，才选择其中的图片。',
    '8.1 用户本轮手动上传或通过“放到参考图”加入的 userMessage.imageAttachments 优先级最高，通常作为 referenceImageIds 或 targetImageIds 使用。',
    '8.2 用户说“上一张/刚才那张/这张/把它/标题大一点/杯子改成这个样式”等相对指代时，必须先从 imageReferenceRegistry 结合 messageRole、messageContentPreview、altText、caption、artifactId 判断目标图。能唯一判断则使用；多候选或无法一一对应时 assistantMessage 提出澄清，mediaTasks 为空。',
    '8.2a 用户说“把图片里的 A 改成 B / 图里的文字改为 B / 照片里的人名替换成 B”这类明确编辑图片内容的请求，即使没有说“上一张”，也默认 target 是 imageReferenceRegistry 中最新的一张可用图片；只有当用户同时指向多张图、或修改会影响多张候选且无法判断时才澄清。',
    '8.3 图片编辑或变体任务必须区分 targetImageIds、referenceImageIds、styleImageIds：target 是要被修改的图；reference 是要借鉴内容/局部元素的图；style 是要借鉴风格的图。输出 ID 必须来自 imageReferenceRegistry[].refId，不要输出 URL，不要虚构 ID。',
    '8.4 如果 target 图对应 imageReferenceRegistry[].artifactId，且用户是在修改同一张图或同一组图，必须把 mediaTasks[].targetArtifactId 设置为该 artifactId；这样图片完成后会追加为同一产物的新版本。批量修改多张图时，每个 mediaTask 对应一个 targetArtifactId。',
    '9. 当前没有可靠蒙版/区域标注能力时，局部修改只能作为“参考原图重新生成整体变体”。必须在 assistantMessage 中说明是整体变体；如果用户明确要求精确局部编辑且缺少区域信息，先澄清。',
    '10. 图片任务可按用户自然语言要求输出 aspectRatio 和 imageSize。aspectRatio 仅可为 1:1、2:3、3:2、3:4、4:3、4:5、5:4、9:16、16:9、21:9；imageSize 仅可为 1K、2K、4K。用户没有要求时省略。',
  );
  sections.push(
    '11. 如果 assistantMessage、patch content 或 files 中需要写应用内链接，必须使用跨平台 AppLink：ssmm://character/{id}?action=edit、ssmm://chat/{id}?action=open、ssmm://settings?action=open&tab=models&card=models。禁止输出 /characters/...、/chats/...、#/...、http://localhost/... 或任何平台私有路由。',
    '11.1 只有当 ID 来自用户输入、recentConversation、artifactRegistry、targetArtifacts、localFiles 或其他明确上下文时，才能写入 AppLink；禁止编造角色、会话、产物或文件 ID。外部网页来源继续使用 https:// 链接。',
    '12. 遵循 changePlan.responseExperience。structured_input 生成简洁 HTML 表单或轻量计算工具片段（style、form/section 和必要脚本，不加 doctype/html/head/body 外壳），适配窄屏，不使用固定大宽度或 min-height:100vh；interactive_workspace 生成 <!doctype html>/<html> 完整交互文档；visual_explanation 根据内容规模生成 HTML 片段或完整文档，并优先可读、可比较的视觉表达。这三类使用 kind=html；需要提交时输出 htmlRuntime。不要在用户可见文案中谈论 HTML、网页、全屏、气泡、presentation 或 viewport。source_code 不应进入 Writer；若意外收到，必须返回 patches=[]。',
    '12.1 HTML 可以包含脚本、事件属性与外部 HTTP(S) src/href、请求或表单 action；禁止 iframe/object/embed、javascript: URL，以及访问 parent/top、Cookie 和应用存储。交互表单仍应使用标准 input/select/textarea/form 和 data-pneumata-action。任何被 catch 的初始化、网络、生成、游戏逻辑、提交或事件回调错误，必须先保留原始 error（必要时用 new Error(String(reason)) 包装），再执行 console.error(error) 或 window.pneumataReportError?.(error, “具体阶段”），最后才更新用户提示；不得只显示“失败，请重试”，不得把真实原因只藏在未上报的“查看详情”面板中。',
    '12.1a 当用户报告 HTML 工具“没有异常但行为不符合预期”时，必须直接检查目标产物的完整源码、状态流转、事件绑定、边界条件和数据处理逻辑，基于用户描述修复实际行为；不能要求先出现运行时异常，也不能只修改错误提示文案或凭空声称已修复。',
    '12.2 联网或脚本驱动页面的 htmlRuntime.executionMode 设为 sandboxed_web；普通静态/表单页面使用 declarative。submission.fields 必须完整列出允许提交的字段名、类型、必填、长度和选项，并与 HTML 中 name 属性一致。',
    '12.2a 本地计算按钮用 type="button"，自行更新结果，不需要 submission；汇率必须注明来源/时间或允许用户填写汇率，不能伪造实时数据。需要把填写结果交给助手时，提供明确的“提交”按钮（data-pneumata-action="submit"）及 htmlRuntime.submission={interactionId,label,resultType:"form",fields:[{name,type,label,required}]}。每个字段的 label 必须是面向用户的名称；程序按这些标签把校验后的输入整理为聊天消息并发给助手。使用标准 input/select/textarea 的 name 收集值；计算结果需要随提交发送时放入声明过的具名控件，不自行访问 parent 或调用应用接口。',
    '12.2b 片段和完整页面使用相同提交协议。默认提交写入聊天后关闭已打开页面；只有需要留在页面继续操作时，在提交按钮或 form 上设置 data-pneumata-after-submit="keep_open"。按用途选一种提交方式，不必同时放两个按钮；不要假设提交会同步返回 AI 结果。',
    '12.3 如果 userMessage.htmlSubmission 存在，本轮必须 update 其目标 HTML 产物，baseVersionId 使用提交版本，生成包含审批、批改、分析、结果或下一步交互的完整新版本；不得创建无关的新产物。',
    '12.4 HTML 正文只能放在 patches[].content，严禁放进 assistantMessage 的 Markdown 代码块或直接正文。assistantMessage 只保留一句简短说明；程序会提供产物打开入口。',
    '',
    '输出格式：',
    'dataOperations.filter 顶层数组表示 AND；复杂条件可使用 {"all":[...]}, {"any":[...]}, {"not":{...}}。',
    '{"assistantMessage":"面向用户的自然回复文案","patches":[{"action":"create|update","artifactId":"...","kind":"document|code|diagram|html|table|json|text","title":"...","summary":"...","language":"...","content":"完整内容","files":[],"baseVersionId":"...","changeSummary":"...","dataDescriptor":{"description":"...","primaryKey":"...","fields":[{"name":"...","type":"string|number|boolean|date|datetime|array|object","description":"..."}]},"htmlRuntime":{}}],"dataOperations":[{"kind":"query|insert|update|delete|add_column","artifactId":"...","baseVersionId":"...","filePath":"...","column":"newColumn","defaultValue":"","filter":[{"field":"...","operator":"eq|contains|startsWith|endsWith|gt|gte|lt|lte|exists|notExists|isNull|isNotNull","value":"..."}],"values":{},"limit":100,"offset":0,"sort":{"field":"...","direction":"asc|desc"}}],"workspaceOperations":[{"directoryId":"...","kind":"write|delete|copy|move","path":"relative/file.txt","destinationPath":"relative/new-file.txt","content":"write 时的完整文本","conflictPolicy":"rename|skip|overwrite"}],"mediaTasks":[{"kind":"image","slotId":"image-1","prompt":"仅对应此槽位的一张图片的最终完整提示词","altText":"用户可见的简短说明","userCaption":"用户可见的简短说明","aspectRatio":"3:4","imageSize":"1K","targetArtifactId":"","targetImageIds":[],"referenceImageIds":[],"styleImageIds":[]}]}',
    '传输规则：上面的结构描述的是解析后的对象。实际输出先写一个 ```json 围栏块；patches[].content、patches[].files[].content、workspaceOperations[].content 均改为 contentRef，例如 "contentRef":"source-1"，不要同时输出 content。files 中保留 path、language 等元数据。',
    '在 JSON 围栏之后，每个 contentRef 对应一个独立原文围栏块，起始行写 ~~~~artifact-content source-1，接完整正文，结束行写 ~~~~。正文里的引号、反斜杠、换行均按源码原样输出，不做 JSON 转义。标识符只能含英文字母、数字、下划线、连字符，且不得重复或缺失。围栏长度必须大于正文中任何单独成行的同类波浪线围栏，以免提前结束。',
    '最后必须单独一行输出 <!-- assistant-patch-set:end -->，表示所有内容完整结束。没有正文时也输出 JSON 围栏和结束标记。不要省略代码，不要把结束标记放进正文围栏。',
    '最小示例：\n```json\n{"assistantMessage":"已创建程序。","patches":[{"action":"create","kind":"code","title":"示例","language":"javascript","contentRef":"source-1"}]}\n```\n~~~~artifact-content source-1\nconsole.log("Hello");\n~~~~\n<!-- assistant-patch-set:end -->',
  );
  return sections.join('\n');
}

function looksLikeImplicitLatestImageEdit(textValue: string) {
  const normalized = textValue.replace(/\s+/g, '');
  if (!normalized) return false;
  const imageScope = /(图片|照片|相片|截图|图像|图里|图中|画面|海报|头像)/i.test(normalized);
  const editAction = /(改成|改为|修改为|替换成|换成|变成|P成|p成|去掉|删掉|删除|擦除|加上|添加|放大|缩小|调大|调小|变大|变小)/i.test(normalized);
  return imageScope && editAction;
}

function createImplicitLatestImageEditTask(params: {
  userMessage: Message;
  imageReferenceRegistry: Map<string, ImageAttachmentRef>;
}): AssistantAgentMediaTask | null {
  if (!looksLikeImplicitLatestImageEdit(params.userMessage.content)) return null;
  const latestImage = latestUniqueImageReference(params.imageReferenceRegistry);
  if (!latestImage) return null;
  const caption = latestImage.caption || latestImage.altText || '上一张图片';
  return {
    kind: 'image',
    slotId: 'image-1',
    prompt: enhanceImagePrompt(params.userMessage.content, {
      caption,
      subject: `基于${caption}进行图片编辑：${params.userMessage.content}`,
    }),
    altText: '图片编辑结果',
    userCaption: '图片编辑结果',
    targetArtifactId: latestImage.artifactId,
    targetImageIds: [latestImage.refId],
    referenceImages: [{
      url: latestImage.url,
      mimeType: latestImage.mimeType,
      label: caption,
    }],
  };
}

function latestUniqueImageReference(imageReferenceRegistry: Map<string, ImageAttachmentRef>) {
  const seen = new Set<string>();
  for (const ref of Array.from(imageReferenceRegistry.values()).reverse()) {
    if (seen.has(ref.refId)) continue;
    seen.add(ref.refId);
    return ref;
  }
  return null;
}

function withImplicitLatestImageTarget(
  mediaTasks: AssistantAgentMediaTask[],
  userMessage: Message | undefined,
  imageReferenceRegistry: Map<string, ImageAttachmentRef>,
) {
  if (!userMessage || !mediaTasks.length || !looksLikeImplicitLatestImageEdit(userMessage.content)) return mediaTasks;
  const latestImage = latestUniqueImageReference(imageReferenceRegistry);
  if (!latestImage) return mediaTasks;
  return mediaTasks.map((task) => {
    if (task.targetImageIds?.length || task.referenceImageIds?.length || task.styleImageIds?.length || task.referenceImages?.length) return task;
    const caption = latestImage.caption || latestImage.altText || '上一张图片';
    return {
      ...task,
      targetArtifactId: task.targetArtifactId || latestImage.artifactId,
      targetImageIds: [latestImage.refId],
      referenceImages: [{
        url: latestImage.url,
        mimeType: latestImage.mimeType,
        label: caption,
      }],
    };
  });
}

function normalizeKind(value: unknown): AssistantArtifactKind | null {
  if (typeof value !== 'string') return null;
  return VALID_ARTIFACT_KINDS.has(value as AssistantArtifactKind) ? value as AssistantArtifactKind : null;
}

function normalizeFiles(value: unknown): AssistantArtifactFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((item, index): AssistantArtifactFile[] => {
    if (!isRecord(item)) return [];
    const path = text(item.path, 240);
    const content = text(item.content, MAX_FILE_CONTENT_CHARS);
    if (!path || !content) return [];
    return [{
      id: text(item.id, 120) || `file-${index + 1}`,
      path,
      content,
      language: text(item.language, 32) || null,
    }];
  });
  return files.length ? files : undefined;
}

function normalizeDataOperations(value: unknown): AssistantArtifactDataOperation[] {
  if (!Array.isArray(value)) return [];
  const normalizeFilter = (entry: unknown, depth = 0): AssistantDataFilter | null => {
    if (depth > 5 || !isRecord(entry)) return null;
    if (Array.isArray(entry.all)) return { all: entry.all.flatMap((child) => { const normalized = normalizeFilter(child, depth + 1); return normalized ? [normalized] : []; }) };
    if (Array.isArray(entry.any)) return { any: entry.any.flatMap((child) => { const normalized = normalizeFilter(child, depth + 1); return normalized ? [normalized] : []; }) };
    if (entry.not !== undefined) {
      const normalized = normalizeFilter(entry.not, depth + 1);
      return normalized ? { not: normalized } : null;
    }
    const field = text(entry.field, 160);
    if (!field) return null;
    const operator = ['eq', 'contains', 'startsWith', 'endsWith', 'gt', 'gte', 'lt', 'lte', 'exists', 'notExists', 'isNull', 'isNotNull'].includes(String(entry.operator))
      ? entry.operator as AssistantDataFilterOperator
      : 'eq';
    return { field, operator, value: entry.value };
  };
  return value.slice(0, 20).flatMap((item): AssistantArtifactDataOperation[] => {
    if (!isRecord(item)) return [];
    const kind = ['query', 'insert', 'update', 'delete', 'add_column'].includes(String(item.kind))
      ? item.kind as AssistantArtifactDataOperation['kind']
      : null;
    const artifactId = text(item.artifactId, 160);
    if (!kind || !artifactId) return [];
    const filter = Array.isArray(item.filter) ? item.filter.flatMap((entry) => {
      const normalized = normalizeFilter(entry);
      return normalized ? [normalized] : [];
    }) : undefined;
    return [{
      kind,
      artifactId,
      baseVersionId: text(item.baseVersionId, 200) || null,
      filePath: text(item.filePath, 240) || null,
      filter,
      values: isRecord(item.values) ? item.values : undefined,
      column: text(item.column, 120) || undefined,
      defaultValue: item.defaultValue,
      limit: Number.isFinite(Number(item.limit)) ? Math.min(100, Math.max(1, Math.floor(Number(item.limit)))) : undefined,
      offset: Number.isFinite(Number(item.offset)) ? Math.max(0, Math.floor(Number(item.offset))) : undefined,
      sort: isRecord(item.sort) && text(item.sort.field, 160) ? {
        field: text(item.sort.field, 160),
        direction: item.sort.direction === 'desc' ? 'desc' : 'asc',
      } : undefined,
    }];
  });
}

function normalizeMediaTasks(value: unknown, imageReferenceRegistry = new Map<string, ImageAttachmentRef>()): AssistantAgentMediaTask[] {
  if (!Array.isArray(value)) return [];
  const usedSlotIds = new Set<string>();
  const uniqueSlotId = (rawSlotId: string, index: number) => {
    const fallback = `image-${index + 1}`;
    const base = (rawSlotId.replace(/[^\w.-]/g, '') || fallback).slice(0, 80);
    if (!usedSlotIds.has(base)) {
      usedSlotIds.add(base);
      return base;
    }
    for (let suffix = 2; suffix <= value.length + 1; suffix += 1) {
      const candidate = `${base}-${suffix}`.slice(0, 80);
      if (!usedSlotIds.has(candidate)) {
        usedSlotIds.add(candidate);
        return candidate;
      }
    }
    const candidate = `${fallback}-${usedSlotIds.size + 1}`.slice(0, 80);
    usedSlotIds.add(candidate);
    return candidate;
  };
  return value.flatMap((item, index): AssistantAgentMediaTask[] => {
    if (!isRecord(item) || item.kind !== 'image') return [];
    const prompt = text(item.prompt, 4000);
    const slotId = uniqueSlotId(text(item.slotId, 80), index);
    const altText = text(item.altText, 160) || text(item.title, 160) || 'AI 图片';
    const userCaption = text(item.userCaption, 240) || text(item.caption, 240) || altText;
    const aspectRatio = text(item.aspectRatio, 16);
    const imageSize = text(item.imageSize, 8).toUpperCase();
    if (!prompt) return [];
    const imageIdsFrom = (input: unknown) => Array.isArray(input)
      ? input.flatMap((entry): string[] => {
          const refId = text(entry, 240);
          return refId && imageReferenceRegistry.has(refId) ? [refId] : [];
        }).slice(0, 8)
      : [];
    const targetImageIds = imageIdsFrom(item.targetImageIds);
    const referenceImageIds = imageIdsFrom(item.referenceImageIds);
    const styleImageIds = imageIdsFrom(item.styleImageIds);
    const selectedImageIds = Array.from(new Set([...targetImageIds, ...referenceImageIds, ...styleImageIds])).slice(0, 8);
    const targetArtifactId = text(item.targetArtifactId, 180);
    const inferredTargetArtifactId = targetArtifactId || targetImageIds
      .map((refId) => imageReferenceRegistry.get(refId)?.artifactId)
      .find((artifactId): artifactId is string => Boolean(artifactId));
    const referenceImagesFromIds = selectedImageIds.flatMap((refId): NonNullable<AssistantAgentMediaTask['referenceImages']> => {
      const ref = imageReferenceRegistry.get(refId);
      if (!ref) return [];
      return [{
        url: ref.url,
        mimeType: ref.mimeType,
        label: ref.caption || ref.altText || (targetImageIds.includes(refId) ? '待修改图片' : '参考图'),
      }];
    });
    const resolvedReferenceImages = referenceImagesFromIds.slice(0, 8);
    return [{
      kind: 'image',
      slotId,
      prompt: enhanceImagePrompt(prompt, { caption: userCaption, subject: altText }),
      altText,
      userCaption,
      aspectRatio: SUPPORTED_IMAGE_ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : undefined,
      imageSize: SUPPORTED_IMAGE_SIZES.has(imageSize) ? imageSize : undefined,
      targetArtifactId: inferredTargetArtifactId,
      targetImageIds: targetImageIds.length ? targetImageIds : undefined,
      referenceImageIds: referenceImageIds.length ? referenceImageIds : undefined,
      styleImageIds: styleImageIds.length ? styleImageIds : undefined,
      referenceImages: resolvedReferenceImages.length ? resolvedReferenceImages : undefined,
    }];
  });
}

function markdownAltText(value: string) {
  return value
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .replace(/[\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'AI 图片';
}

function ensureMediaTaskPlaceholders(assistantMessage: string, mediaTasks: AssistantAgentMediaTask[]) {
  let content = assistantMessage.trim();
  const missingPlaceholders = mediaTasks.flatMap((task): string[] => {
    const slotId = task.slotId?.trim();
    if (!slotId) return [];
    if (content.includes(`attachment:${slotId}`)) return [];
    return [`![${markdownAltText(task.userCaption || task.altText || 'AI 图片')}](attachment:${slotId})`];
  });
  if (!missingPlaceholders.length) return content;
  content = [content, missingPlaceholders.join('\n\n')].filter(Boolean).join('\n\n');
  return text(content, MAX_ASSISTANT_VISIBLE_MESSAGE_CHARS);
}

function inlineImageAttachmentSlots(assistantMessage: string) {
  const slots = new Set<string>();
  for (const match of assistantMessage.matchAll(INLINE_IMAGE_ATTACHMENT_PATTERN)) {
    const slotId = (match[2] || '').trim().replace(/[^\w.-]/g, '').slice(0, 80);
    if (slotId) slots.add(slotId);
  }
  return slots;
}

function compactLocalFilesForPrompt(localFiles: AssistantAgentLocalFileContext[] | undefined) {
  let remaining = MAX_LOCAL_FILE_CONTEXT_CHARS;
  return (localFiles || []).flatMap((file) => {
    if (remaining <= 0) return [];
    const content = file.content.slice(0, remaining);
    remaining -= content.length;
    return [{
      directoryId: file.directoryId,
      path: file.path,
      name: file.name,
      mimeType: file.mimeType || '',
      sizeBytes: file.sizeBytes,
      content,
      truncated: file.truncated || content.length < file.content.length,
      originalLength: file.originalLength,
    }];
  });
}

function stripHtmlArtifactSourceFromAssistantMessage(message: string, patches: AssistantAgentPatch[]) {
  const htmlPatches = patches.filter((patch) => patch.kind === 'html');
  if (!htmlPatches.length) return message.trim();
  const cleaned = message
    .replace(/```(?:html|htm)\s*[\s\S]*?```/gi, '')
    .replace(/```\s*(?=(?:<!doctype\s+html\b|<html\b))[\s\S]*?```/gi, '')
    .replace(/<!doctype\s+html\b[\s\S]*$/gi, '')
    .replace(/<html\b[\s\S]*?<\/html\s*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned) return cleaned;
  const primary = htmlPatches[0];
  return `${primary.action === 'update' ? '已更新' : '已创建'}「${primary.title}」。`;
}

function normalizePatchSet(raw: unknown, imageReferenceRegistry = new Map<string, ImageAttachmentRef>(), userMessage?: Message, plan?: AssistantAgentChangePlan, workspaceDirectoryIds: string[] = []): AssistantAgentPatchSet {
  if (!isRecord(raw)) return { assistantMessage: '没有可提交的产物变更。', patches: [], mediaTasks: [] };
  const patches = Array.isArray(raw.patches) ? raw.patches.slice(0, MAX_PATCHES).flatMap((item): AssistantAgentPatch[] => {
    if (!isRecord(item)) return [];
    const action = item.action === 'update' ? 'update' : item.action === 'create' ? 'create' : null;
    const kind = normalizeKind(item.kind);
    const content = text(item.content, MAX_CONTENT_CHARS);
    const files = normalizeFiles(item.files);
    if (!action || !kind || (!content && !files?.length)) return [];
    if (kind === 'html' && plan?.responseExperience === 'source_code') return [];
    const preferredMode = plan?.responseExperience === 'structured_input'
      ? 'inline_interaction'
      : plan?.responseExperience === 'interactive_workspace'
        ? 'artifact_page'
        : undefined;
    const htmlRuntime = kind === 'html' ? normalizeAssistantHtmlRuntime(isRecord(item.htmlRuntime) ? item.htmlRuntime : {}, content, preferredMode) : undefined;
    return [{
      action,
      artifactId: text(item.artifactId, 160) || null,
      kind,
      title: text(item.title, 120) || '未命名产物',
      summary: text(item.summary, 240),
      language: text(item.language, 32) || null,
      content,
      files,
      baseVersionId: text(item.baseVersionId, 200) || null,
      changeSummary: text(item.changeSummary, 240),
      htmlRuntime,
      versionStage: kind === 'html' && action === 'update' ? 'ai_result' : kind === 'html' ? 'generated' : undefined,
      dataDescriptor: isRecord(item.dataDescriptor) && Array.isArray(item.dataDescriptor.fields) ? {
        description: text(item.dataDescriptor.description, 500),
        primaryKey: text(item.dataDescriptor.primaryKey, 160) || undefined,
        fields: item.dataDescriptor.fields.flatMap((field): Array<{ name: string; type?: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'array' | 'object'; description?: string }> => {
          if (!isRecord(field) || !text(field.name, 160)) return [];
          const fieldType = ['string', 'number', 'boolean', 'date', 'datetime', 'array', 'object'].includes(String(field.type))
            ? field.type as 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'array' | 'object'
            : undefined;
          return [{ name: text(field.name, 160), type: fieldType, description: text(field.description, 300) || undefined }];
        }),
      } : undefined,
    }];
  }) : [];
  const dataOperations = normalizeDataOperations(raw.dataOperations);
  const versionOperations = Array.isArray(raw.versionOperations) ? raw.versionOperations.slice(0, 20).flatMap((item) => {
    if (!isRecord(item)) return [];
    const artifactId = text(item.artifactId, 160);
    const kind: AssistantArtifactVersionOperation['kind'] = item.kind === 'restore' || item.kind === 'limit' ? item.kind : 'restore';
    if (item.kind !== 'restore' && item.kind !== 'limit') return [];
    if (!artifactId || !kind) return [];
    return [{ artifactId, kind, versionId: text(item.versionId, 240) || undefined, keepCount: Number.isFinite(Number(item.keepCount)) ? Math.max(1, Math.min(50, Math.floor(Number(item.keepCount)))) : undefined }];
  }) : [];
  const allowedDirectories = new Set(workspaceDirectoryIds);
  const workspaceOperations = Array.isArray(raw.workspaceOperations) ? raw.workspaceOperations.slice(0, 100).flatMap((item) => {
    if (!isRecord(item)) return [];
    const directoryId = text(item.directoryId, 160);
    const path = text(item.path, 480).replace(/^\/+/, '');
    const kind = ['write', 'delete', 'move', 'copy'].includes(String(item.kind)) ? item.kind as 'write' | 'delete' | 'move' | 'copy' : null;
    if (!directoryId || !path || !kind || !allowedDirectories.has(directoryId) || path.split('/').some((part) => part === '..' || part === '.')) return [];
    const destinationPath = text(item.destinationPath, 480).replace(/^\/+/, '') || undefined;
    if ((kind === 'move' || kind === 'copy') && (!destinationPath || destinationPath.split('/').some((part) => part === '..' || part === '.'))) return [];
    const conflictPolicy: 'rename' | 'skip' | 'overwrite' = item.conflictPolicy === 'skip' || item.conflictPolicy === 'overwrite' ? item.conflictPolicy : 'rename';
    return [{ directoryId, kind, path, destinationPath, content: kind === 'write' ? text(item.content, MAX_CONTENT_CHARS) : undefined, conflictPolicy, recursive: kind === 'delete' && Boolean(item.recursive) }];
  }) : [];
  const visibleAssistantMessage = stripHtmlArtifactSourceFromAssistantMessage(
    text(raw.assistantMessage, MAX_ASSISTANT_VISIBLE_MESSAGE_CHARS),
    patches,
  );
  const normalizedMediaTasks = normalizeMediaTasks(raw.mediaTasks, imageReferenceRegistry);
  const inlineSlots = inlineImageAttachmentSlots(visibleAssistantMessage);
  const normalizedSlots = new Set(normalizedMediaTasks.map((task) => task.slotId?.trim()).filter(Boolean));
  const missingTaskSlots = [...inlineSlots].filter((slotId) => !normalizedSlots.has(slotId));
  if (missingTaskSlots.length) {
    logRecoverableError({
      location: 'assistant-agent.normalize-media-tasks',
      error: new Error('Agent response contains image attachment placeholders without valid media tasks.'),
      extra: {
        rawMediaTaskCount: Array.isArray(raw.mediaTasks) ? raw.mediaTasks.length : 0,
        normalizedMediaTaskCount: normalizedMediaTasks.length,
        missingTaskSlots,
        explicitImageRequest: Boolean(userMessage && /图片|照片|插画|海报|头像|生图|生成.*图|画一张|参考图/i.test(userMessage.content)),
      },
    });
  }
  const mediaTaskContractError = missingTaskSlots.length
    ? `图片任务输出不完整：缺少 ${missingTaskSlots.join('、')} 的 mediaTasks。未创建任何图片生成任务，请重试。`
    : '';
  let mediaTasks = mediaTaskContractError ? [] : normalizedMediaTasks;
  mediaTasks = withImplicitLatestImageTarget(mediaTasks, userMessage, imageReferenceRegistry);
  if (!mediaTaskContractError && !patches.length && !mediaTasks.length && userMessage) {
    const implicitTask = createImplicitLatestImageEditTask({ userMessage, imageReferenceRegistry });
    if (implicitTask) mediaTasks = [implicitTask];
  }
  return {
    assistantMessage: mediaTaskContractError
      ? [visibleAssistantMessage, mediaTaskContractError].filter(Boolean).join('\n\n')
      : ensureMediaTaskPlaceholders(visibleAssistantMessage, mediaTasks)
      || (mediaTasks.length && !patches.length ? '我已根据你的要求准备生成图片。' : patches.length || dataOperations.length ? '已完成产物变更。' : '没有可提交的产物变更。'),
    patches,
    dataOperations,
    versionOperations,
    workspaceOperations,
    mediaTasks,
  };
}

export function validateAssistantAgentPatchSet(params: {
  patchSet: AssistantAgentPatchSet;
  plan: AssistantAgentChangePlan;
  existingArtifacts: AssistantArtifactItem[];
  blockedUpdateArtifactIds?: Set<string>;
}) {
  const existingById = new Map(params.existingArtifacts.filter((item) => item.deletedAt == null).map((item) => [item.id, item]));
  const allowedUpdateIds = new Set(params.plan.scope.artifactIds);
  const blockedUpdateArtifactIds = params.blockedUpdateArtifactIds || new Set<string>();
  const validPatches = params.patchSet.patches.filter((patch) => {
    if (!VALID_ARTIFACT_KINDS.has(patch.kind)) return false;
    if (!patch.content && !patch.files?.length) return false;
    if (patch.action === 'create') return params.plan.intent === 'create';
    if (patch.action !== 'update' || !patch.artifactId) return false;
    if (blockedUpdateArtifactIds.has(patch.artifactId)) return false;
    const target = existingById.get(patch.artifactId);
    if (!target || !allowedUpdateIds.has(patch.artifactId)) return false;
    if (patch.baseVersionId && patch.baseVersionId !== target.currentVersionId) return false;
    return true;
  });
  const validDataOperations = (params.patchSet.dataOperations || []).filter((operation) => {
    if (!allowedUpdateIds.has(operation.artifactId)) return false;
    const target = existingById.get(operation.artifactId);
    if (!target || !['table', 'json'].includes(target.kind)) return false;
    return !operation.baseVersionId || operation.baseVersionId === target.currentVersionId;
  });
  const validVersionOperations = (params.patchSet.versionOperations || []).filter((operation) => {
    const target = existingById.get(operation.artifactId);
    if (!target) return false;
    if (operation.kind === 'restore') return Boolean(operation.versionId && target.versions.some((version) => version.id === operation.versionId));
    return Number.isFinite(operation.keepCount) && (operation.keepCount || 0) >= 1;
  });
  const rejectedForTruncatedContext = params.patchSet.patches.some((patch) => (
    patch.action === 'update'
    && patch.artifactId
    && blockedUpdateArtifactIds.has(patch.artifactId)
  ));
  return {
    assistantMessage: rejectedForTruncatedContext
      ? '这个产物内容较长，当前上下文不足以安全生成完整新版本。请缩小修改范围或打开具体文件后再试。'
      : params.patchSet.assistantMessage,
    patches: validPatches,
    dataOperations: validDataOperations,
    versionOperations: validVersionOperations,
    workspaceOperations: params.patchSet.workspaceOperations || [],
    mediaTasks: params.patchSet.mediaTasks || [],
  } satisfies AssistantAgentPatchSet;
}

export async function planAssistantAgentChange(params: {
  api: APIConfig;
  chatId: string;
  messages: Message[];
  userMessage: Message;
  existingArtifacts: AssistantArtifactItem[];
  interactionFocus?: Record<string, unknown>;
  toolCapabilities?: {
    webSearch?: boolean;
    networkAccess?: boolean;
    localWorkspace?: boolean;
    localWorkspaceDirectories?: Array<{ id: string; name: string; isDefault: boolean }>;
  };
  localWorkspaceFileRegistry?: Array<{
    directoryId: string;
    path: string;
    name: string;
    kind: 'file' | 'directory';
    depth: number;
    sizeBytes?: number;
    mimeType?: string;
    updatedAt?: number;
  }>;
  sessionResourceRegistry?: Array<{
    id: string;
    name: string;
    path: string;
    sourceUrl: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: number;
  }>;
  signal?: AbortSignal;
  /** Force an artifact response for a caller (for example a learning room HTML request). */
  forceArtifact?: boolean;
}) {
  const htmlSubmission = params.userMessage.metadata?.assistantHtmlSubmission;
  const submittedArtifact = htmlSubmission
    ? params.existingArtifacts.find((artifact) => artifact.id === htmlSubmission.artifactId && artifact.chatId === params.chatId && artifact.kind === 'html' && artifact.deletedAt == null)
    : null;
  if (htmlSubmission && submittedArtifact) {
    const submittedVersion = submittedArtifact.versions.find((version) => version.id === htmlSubmission.baseVersionId)
      || submittedArtifact.versions.find((version) => version.id === submittedArtifact.currentVersionId)
      || submittedArtifact.versions.at(-1);
    const responseExperience = submittedVersion?.htmlRuntime?.presentation === 'inline'
      ? 'structured_input'
      : 'interactive_workspace';
    return {
      intent: 'update',
      assistantMessage: '',
      scope: { targetMode: 'single', artifactIds: [submittedArtifact.id] },
      operations: [{ kind: 'content_edit', instruction: `处理用户提交的 ${htmlSubmission.resultType} 交互结果，并生成同一 HTML 产物的新版本。` }],
      responseExperience,
      requiresConfirmation: false,
      confidence: 1,
      rationale: '用户通过 HTML 交互提交了结构化数据，目标产物和基准版本已明确。',
    } satisfies AssistantAgentChangePlan;
  }
  const payload = {
    chatId: params.chatId,
    userMessage: {
      id: params.userMessage.id,
      content: params.userMessage.content,
      imageAttachments: buildCompactImageAttachmentRefs(params.userMessage),
      htmlSubmission: params.userMessage.metadata?.assistantHtmlSubmission,
    },
    recentConversation: recentConversation(params.messages),
    imageReferenceRegistry: buildCompactImageReferenceRegistry(withLatestUserMessage(params.messages, params.userMessage)),
    artifactRegistry: artifactRegistry(params.existingArtifacts),
    toolCapabilities: {
      webSearch: Boolean(params.toolCapabilities?.webSearch),
      networkAccess: Boolean(params.toolCapabilities?.networkAccess),
      localWorkspace: Boolean(params.toolCapabilities?.localWorkspace),
    },
    localWorkspaceRegistry: (params.toolCapabilities?.localWorkspaceDirectories || []).slice(0, 12),
    localWorkspaceFileRegistry: (params.localWorkspaceFileRegistry || []).slice(0, MAX_LOCAL_WORKSPACE_FILES_IN_REGISTRY),
    sessionResourceRegistry: (params.sessionResourceRegistry || []).slice(0, 160),
    interactionFocus: params.interactionFocus || {},
  };
  const raw = await generateResponse(
    params.api,
    buildPlannerPrompt({
      includeImages: Boolean(payload.imageReferenceRegistry.length || payload.userMessage.imageAttachments.length),
      includeLocalFiles: Boolean(params.toolCapabilities?.localWorkspace || payload.localWorkspaceFileRegistry.length),
      includeSessionResources: Boolean(payload.sessionResourceRegistry.length),
      includeSearch: Boolean(params.toolCapabilities?.webSearch),
      includeNetwork: Boolean(params.toolCapabilities?.networkAccess),
      includeData: params.existingArtifacts.some((artifact) => artifact.kind === 'table' || artifact.kind === 'json')
        || /\b(csv|json)\b|表格|数据集|数据文件|记录|字段|行|列/i.test(params.userMessage.content),
    }),
    [{ role: 'user', content: stringifyAgentPayload(payload, 'Assistant Agent planner') }],
    undefined,
    {
      responseFormat: 'json',
      maxTokens: 1600,
      signal: params.signal,
      aiUsage: {
        type: 'assistant_chat',
        label: '助手Agent意图规划',
        scope: 'chat',
        resourceId: params.chatId,
      },
    },
  );
  const workspaceDirectories = params.toolCapabilities?.localWorkspaceDirectories || [];
  const implicitWorkspaceId = workspaceDirectories.find((directory) => directory.isDefault)?.id
    || (workspaceDirectories.length === 1 ? workspaceDirectories[0]?.id : undefined);
  const plan = normalizePlan(
    safeJsonParse(raw),
    params.existingArtifacts,
    params.localWorkspaceFileRegistry,
    new Set((params.sessionResourceRegistry || []).map((resource) => resource.id)),
    new Set(workspaceDirectories.map((directory) => directory.id)),
    implicitWorkspaceId,
  );
  const namedDownloadNeedsDiscovery = /(?:帮我|请|给我|替我)?\s*(?:下载|获取).+(?:到|至|进|保存|文件夹|目录)|\b(?:download|fetch)\b.+\b(?:to|into|folder|downloads?)\b/i.test(params.userMessage.content);
  if (
    namedDownloadNeedsDiscovery
    && params.toolCapabilities?.webSearch
    && !plan.networkRequests?.length
    && (plan.intent === 'chat' || plan.intent === 'clarify')
  ) {
    return {
      ...plan,
      intent: 'search',
      assistantMessage: '',
      searchQuery: plan.searchQuery?.trim() || params.userMessage.content.trim(),
      operations: plan.operations.length ? plan.operations : [{ kind: 'export', instruction: params.userMessage.content.trim() }],
      requiresConfirmation: false,
      clarificationQuestion: '',
      confidence: Math.max(plan.confidence || 0, 0.9),
      rationale: `${plan.rationale || ''} named_download_requires_source_discovery`.trim(),
    } satisfies AssistantAgentChangePlan;
  }
  if (plan.networkRequests?.some((request) => request.destination === 'workspace' && !request.workspaceId)) {
    const clarificationQuestion = workspaceDirectories.length
      ? '你希望把文件保存到哪个已授权工作区？'
      : '当前还没有已授权工作区。你希望先授权一个工作区，还是保存到本会话内部？';
    return {
      ...plan,
      intent: 'clarify' as const,
      assistantMessage: clarificationQuestion,
      clarificationQuestion,
      networkRequests: [],
      requiresConfirmation: true,
      confidence: 1,
      rationale: 'network_workspace_destination_unresolved',
    } satisfies AssistantAgentChangePlan;
  }
  if (params.forceArtifact && (plan.intent === 'chat' || plan.intent === 'clarify')) {
    return {
      ...plan,
      intent: 'create' as const,
      responseExperience: 'structured_input' as const,
      operations: plan.operations.length ? plan.operations : [{ kind: 'create' as const, instruction: '根据用户请求创建可交互的 HTML 学习产物。' }],
      confidence: Math.max(plan.confidence || 0, 0.8),
      rationale: `${plan.rationale || ''} caller_forced_artifact`.trim(),
    } satisfies AssistantAgentChangePlan;
  }
  return plan;
}

export async function writeAssistantAgentPatchSet(params: {
  api: APIConfig;
  chatId: string;
  messages: Message[];
  userMessage: Message;
  plan: AssistantAgentChangePlan;
  existingArtifacts: AssistantArtifactItem[];
  localFiles?: AssistantAgentLocalFileContext[];
  workspaceDirectories?: Array<{ id: string; name: string; isDefault: boolean }>;
  signal?: AbortSignal;
}) {
  const registryMessages = withLatestUserMessage(params.messages, params.userMessage);
  const imageReferenceRegistry = buildImageReferenceRegistry(registryMessages);
  const userImageAttachments = buildCompactImageAttachmentRefs(params.userMessage);
  const blockedUpdateArtifactIds = new Set<string>();
  const activeTargetArtifacts = params.existingArtifacts
    .filter((artifact) => params.plan.scope.artifactIds.includes(artifact.id));
  const perTargetBudget = Math.max(
    12_000,
    Math.min(MAX_SINGLE_TARGET_CONTEXT_CHARS, Math.floor(MAX_TOTAL_TARGET_CONTEXT_CHARS / Math.max(1, activeTargetArtifacts.length))),
  );
  const targetArtifacts = params.existingArtifacts
    .filter((artifact) => params.plan.scope.artifactIds.includes(artifact.id))
    .map((artifact) => {
      const currentVersion = artifactCurrentVersion(artifact);
      const files = currentVersion?.files || [];
      const contentBudget = files.length ? Math.floor(perTargetBudget * 0.25) : perTargetBudget;
      const fileBudget = files.length ? Math.max(2000, Math.floor((perTargetBudget - contentBudget) / files.length)) : 0;
      const compactedContent = compactContextText(currentVersion?.content || '', contentBudget);
      let hasTruncatedContext = compactedContent.truncated;
      const currentVersionFiles = files.map((file) => {
        const compactedFile = compactContextText(file.content, fileBudget);
        if (compactedFile.truncated) hasTruncatedContext = true;
        return {
          ...file,
          content: compactedFile.content,
          contentTruncated: compactedFile.truncated,
          contentOriginalLength: compactedFile.originalLength,
        };
      });
      if (hasTruncatedContext) blockedUpdateArtifactIds.add(artifact.id);
      return {
        ...artifactRegistry([artifact])[0],
        currentVersionContent: compactedContent.content,
        currentVersionContentTruncated: compactedContent.truncated,
        currentVersionContentOriginalLength: compactedContent.originalLength,
        currentVersionFiles,
      };
    });
  const payload = {
    chatId: params.chatId,
    userMessage: {
      id: params.userMessage.id,
      content: params.userMessage.content,
      imageAttachments: userImageAttachments,
      htmlSubmission: params.userMessage.metadata?.assistantHtmlSubmission,
    },
    recentConversation: recentConversation(params.messages),
    imageReferenceRegistry: buildCompactImageReferenceRegistry(registryMessages),
    changePlan: params.plan,
    artifactRegistry: artifactRegistry(params.existingArtifacts),
    targetArtifacts,
    localFiles: compactLocalFilesForPrompt(params.localFiles),
    workspaceRegistry: params.workspaceDirectories || [],
  };
  const writerPromptOptions = {
      includeImages: Boolean(
        imageReferenceRegistry.size
        || userImageAttachments.length
        || /图片|照片|插画|海报|头像|生图|生成.*图|画一张|参考图/i.test(params.userMessage.content)
        || params.plan.operations.some((operation) => /图片|照片|插画|海报|生图|图像/i.test(operation.instruction)),
      ),
      includeLocalFiles: Boolean(params.localFiles?.length),
      includeData: activeTargetArtifacts.some((artifact) => artifact.kind === 'table' || artifact.kind === 'json')
        || /\b(csv|json)\b|表格|数据集|数据文件|记录|字段|行|列/i.test(params.userMessage.content)
        || params.plan.operations.some((operation) => /\b(csv|json)\b|表格|数据|记录|字段|行|列/i.test(operation.instruction)),
      includeHtml: Boolean(params.plan.responseExperience === 'structured_input' || params.plan.responseExperience === 'interactive_workspace' || params.plan.responseExperience === 'visual_explanation' || params.userMessage.metadata?.assistantHtmlSubmission || activeTargetArtifacts.some((artifact) => artifact.kind === 'html')),
      requiresHtmlRuntimeRepair: Boolean(params.userMessage.metadata?.assistantHtmlRuntimeError),
  };
  const raw = await generateResponse(
    params.api,
    buildWriterPrompt(writerPromptOptions),
    [{ role: 'user', content: stringifyAgentPayload(payload, 'Assistant Agent writer') }],
    undefined,
    {
      responseFormat: 'text',
      // Source blocks are emitted verbatim outside the JSON manifest.
      maxTokens: MAX_WRITER_OUTPUT_TOKENS,
      signal: params.signal,
      aiUsage: {
        type: 'assistant_chat',
        label: '助手Agent补丁生成',
        scope: 'chat',
        resourceId: params.chatId,
      },
    },
  );
  let parsed: unknown;
  try {
    parsed = parseAssistantAgentWriterOutput(raw, safeJsonParse);
  } catch (error) {
    if (error instanceof AssistantAgentFormatError) throw error;
    console.error('[assistant-agent:invalid-writer-output]', { responseLength: raw.length });
    throw new AssistantAgentFormatError();
  }
  return validateAssistantAgentPatchSet({
    patchSet: normalizePatchSet(parsed, imageReferenceRegistry, params.userMessage, params.plan, (params.workspaceDirectories || []).map((directory) => directory.id)),
    plan: params.plan,
    existingArtifacts: params.existingArtifacts,
    blockedUpdateArtifactIds,
  });
}
