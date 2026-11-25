import type { APIConfig } from '../types/settings';
import { generateWorkflowModelResponse as generateResponse, type WorkflowModelRequestHook } from './workflowModelResponse';
import { fetchMediaAssetContent } from './mediaAssetContent';
import { WorkflowPreflightError } from './workflowRunRuntime';
import { redactAiDiagnosticText } from './aiDiagnosticText';

// Keep the full request below the server's 14 MB JSON body limit, including base64 overhead.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,/i;

function describeFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return '网络请求未能建立，浏览器没有收到 HTTP 响应（可能是服务不可达、跨域拦截或连接中断）';
  }
  return redactAiDiagnosticText(detail, 500);
}

function referenceSource(url: string) {
  if (url.startsWith('/uploads/media/')) return '后端媒体文件';
  if (IMAGE_DATA_URL.test(url)) return '本地图片数据';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '未知图片来源';
  }
}

async function imageDataUrl(url: string, signal: AbortSignal): Promise<string> {
  if (IMAGE_DATA_URL.test(url)) {
    if (url.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) throw new WorkflowPreflightError('参考图片超过视觉检查大小上限');
    return url;
  }
  const local = url.startsWith('/uploads/media/');
  if (!local && !/^https:\/\//i.test(url)) throw new WorkflowPreflightError('参考图片地址不可用于视觉检查');
  let response: Response;
  try {
    response = await fetchMediaAssetContent(url, 'image', signal);
  } catch (error) {
    const reason = describeFailure(error);
    console.error(`[agent-team:image-inspection] 读取参考图请求失败；来源=${referenceSource(url)}；原因=${reason}`);
    throw new WorkflowPreflightError(`读取生成图片失败（${referenceSource(url)}）：${reason}`);
  }
  if (!response.ok) throw new WorkflowPreflightError(`无法读取参考图片（HTTP ${response.status}）`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_IMAGE_BYTES) throw new WorkflowPreflightError('参考图片超过视觉检查大小上限');
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new WorkflowPreflightError('参考图片超过视觉检查大小上限');
  if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(blob.type)) throw new WorkflowPreflightError('参考图片格式不支持视觉检查');
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('读取参考图片失败'));
    reader.readAsDataURL(blob);
  });
}

export async function inspectAgentTeamImages(params: {
  api: APIConfig;
  chatId?: string;
  goal: string;
  acceptance: string;
  sourceText?: string;
  references: Array<{ url: string; mimeType?: string; label?: string }>;
  maxAttachments?: number;
  signal: AbortSignal;
  beforeModelRequest?: WorkflowModelRequestHook;
}) {
  if (!params.references.length) throw new WorkflowPreflightError('图片检查缺少已生成的参考图片');
  const attachments = await Promise.all(params.references.map(async (reference) => ({
    url: await imageDataUrl(reference.url, params.signal),
    mimeType: reference.mimeType,
  })));
  if (attachments.reduce((size, attachment) => size + attachment.url.length, 0) > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) {
    throw new WorkflowPreflightError('参考图片总大小超过视觉检查上限，请减少图片数量');
  }
  const maxAttachments = Math.max(1, Math.floor(params.maxAttachments || attachments.length));
  const requestAttachments = attachments.length > maxAttachments
    ? [{ url: await createInspectionSheet(attachments, params.references), mimeType: 'image/jpeg' }]
    : attachments;
  params.signal.throwIfAborted();
  let result: string;
  try {
    result = await generateResponse(params.api,
      '你是图片检查员。只根据实际收到的图片判断画面内容和问题；上游剧本只作为预期，不得当作已验证事实。逐张比较角色外观、场景、时间、道具、光线和画风，并指出与剧本不符之处及跨图不连续之处。给出可核对的观察、与目标的差距及不确定性。没有看到的细节必须明确说明。若图片是带编号的联系表，按编号分别检查每格。',
      [{ role: 'user', content: `检查目标：${params.goal}\n验收要求：${params.acceptance}${params.sourceText ? `\n上游剧本与视觉设定（仅用于对照）：${params.sourceText}` : ''}${requestAttachments.length === 1 && attachments.length > 1
        ? `\n图片已按原比例合成为编号联系表，共 ${attachments.length} 格；请逐格检查后比较一致性。` : ''}`, attachments: requestAttachments }], undefined,
      { responseFormat: 'text', signal: params.signal, maxTokens: 1200, beforeModelRequest: params.beforeModelRequest,
        aiUsage: { type: 'assistant_chat', label: '团队图片检查', scope: 'chat', resourceId: params.chatId } });
  } catch (error) {
    const reason = describeFailure(error);
    console.error(`[agent-team:image-inspection] 视觉模型请求失败；provider=${params.api.provider}；model=${params.api.model}；原因=${reason}`);
    throw new Error(`图片已读取，但调用视觉检查模型失败（${params.api.provider}/${params.api.model}）：${reason}`);
  }
  if (!result.trim()) throw new WorkflowPreflightError('图片检查没有返回有效结果');
  return result.trim();
}

async function createInspectionSheet(
  attachments: Array<{ url: string; mimeType?: string }>,
  references: Array<{ label?: string }>,
) {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
    throw new WorkflowPreflightError('当前环境不支持多图检查合成');
  }
  const tileWidth = 640;
  const tileHeight = 640;
  const labelHeight = 36;
  const columns = 2;
  const rows = Math.ceil(attachments.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = columns * tileWidth;
  canvas.height = rows * (tileHeight + labelHeight);
  const context = canvas.getContext('2d');
  if (!context) throw new WorkflowPreflightError('无法创建图片检查联系表');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const bitmaps = await Promise.all(attachments.map(async (attachment) => {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new WorkflowPreflightError('无法准备图片检查联系表');
    return createImageBitmap(await response.blob());
  }));
  try {
    bitmaps.forEach((bitmap, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * tileWidth;
      const y = row * (tileHeight + labelHeight);
      context.fillStyle = '#f1f3f5';
      context.fillRect(x, y, tileWidth, labelHeight);
      context.fillStyle = '#17191c';
      context.font = '16px sans-serif';
      context.fillText(`${index + 1}. ${references[index]?.label || `关键帧 ${index + 1}`}`.slice(0, 72), x + 12, y + 24);
      const scale = Math.min(tileWidth / bitmap.width, tileHeight / bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      context.drawImage(bitmap, x + (tileWidth - width) / 2, y + labelHeight + (tileHeight - height) / 2, width, height);
    });
  } finally {
    bitmaps.forEach((bitmap) => bitmap.close());
  }
  const output = canvas.toDataURL('image/jpeg', 0.88);
  if (!IMAGE_DATA_URL.test(output)) throw new WorkflowPreflightError('图片检查联系表生成失败');
  return output;
}
