import type { APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';
import { api } from './api';
import { backendUrl } from './backendUrl';
import { workspaceFetch } from './workspaceLifecycle';
import { WorkflowPreflightError } from './workflowRunRuntime';

// Keep the full request below the server's 14 MB JSON body limit, including base64 overhead.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,/i;

async function imageDataUrl(url: string, signal: AbortSignal): Promise<string> {
  if (IMAGE_DATA_URL.test(url)) {
    if (url.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) throw new WorkflowPreflightError('参考图片超过视觉检查大小上限');
    return url;
  }
  const local = url.startsWith('/uploads/media/');
  if (!local && !/^https:\/\//i.test(url)) throw new WorkflowPreflightError('参考图片地址不可用于视觉检查');
  const response = local
    ? await api.fetchWithAuth(backendUrl(url), { signal })
    : await workspaceFetch(url, { signal });
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
  references: Array<{ url: string; mimeType?: string; label?: string }>;
  signal: AbortSignal;
  beforeModelRequest?: () => Promise<void>;
}) {
  if (!params.references.length) throw new WorkflowPreflightError('图片检查缺少已生成的参考图片');
  const attachments = await Promise.all(params.references.map(async (reference) => ({
    url: await imageDataUrl(reference.url, params.signal),
    mimeType: reference.mimeType,
  })));
  if (attachments.reduce((size, attachment) => size + attachment.url.length, 0) > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) {
    throw new WorkflowPreflightError('参考图片总大小超过视觉检查上限，请减少图片数量');
  }
  params.signal.throwIfAborted();
  await params.beforeModelRequest?.();
  const result = await generateResponse(params.api,
    '你是图片检查员。只根据实际收到的图片判断画面内容和问题；不要把生成提示词当作已验证事实。给出可核对的观察、与目标的差距及不确定性。没有看到的细节必须明确说明。',
    [{ role: 'user', content: `检查目标：${params.goal}\n验收要求：${params.acceptance}`, attachments }], undefined,
    { responseFormat: 'text', signal: params.signal, maxTokens: 1200,
      aiUsage: { type: 'assistant_chat', label: '团队图片检查', scope: 'chat', resourceId: params.chatId } });
  if (!result.trim()) throw new WorkflowPreflightError('图片检查没有返回有效结果');
  return result.trim();
}
