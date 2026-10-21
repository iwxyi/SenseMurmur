import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { assertWorkspaceActive, getWorkspaceSignal, workspaceFetch as fetch } from './workspaceLifecycle';
import { api, type NetworkResourceResponse } from './api';

export type NetworkResourceMode = 'readable' | 'source' | 'download';

export interface NetworkResourceResult extends NetworkResourceResponse {
  mode: NetworkResourceMode;
  transport: 'browser' | 'electron' | 'capacitor' | 'server-fallback';
  title?: string;
  text?: string;
  truncated?: boolean;
  originalLength?: number;
}

const MAX_DIRECT_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_CHARS = 180_000;
const MAX_READABLE_CHARS = 80_000;
const MAX_REDIRECTS = 4;

type DesktopNetworkBridge = {
  fetchNetworkResource?: (request: { url: string; mode: NetworkResourceMode; timeoutMs: number }) => Promise<NetworkResourceResponse>;
};

function desktopBridge() {
  if (typeof window === 'undefined') return null;
  return (window as Window & { electronAPI?: DesktopNetworkBridge }).electronAPI || null;
}

function assertPublicUrl(value: string, protocols = ['http:', 'https:']) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error('仅支持不包含认证信息的公开网络地址');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)) {
    throw new Error('不允许访问本地或内网地址');
  }
  return url.toString();
}

async function readBrowserResponse(response: Response, mode: NetworkResourceMode): Promise<NetworkResourceResponse> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DIRECT_BYTES) throw new Error('网络资源超过 20 MB 限制');
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_DIRECT_BYTES) throw new Error('网络资源超过 20 MB 限制');
  const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
  const binary = mode === 'download' || !(contentType.startsWith('text/') || ['application/json', 'application/xml', 'application/xhtml+xml', 'image/svg+xml'].includes(contentType));
  let content = '';
  if (binary) {
    const chunkSize = 0x8000;
    const chunks: string[] = [];
    for (let offset = 0; offset < buffer.length; offset += chunkSize) chunks.push(String.fromCharCode(...buffer.subarray(offset, offset + chunkSize)));
    content = btoa(chunks.join(''));
  } else {
    content = new TextDecoder().decode(buffer);
  }
  const finalUrl = response.url || '';
  return {
    requestedUrl: finalUrl,
    finalUrl,
    status: response.status,
    contentType,
    sizeBytes: buffer.byteLength,
    fileName: new URL(finalUrl).pathname.split('/').filter(Boolean).at(-1) || 'download',
    encoding: binary ? 'base64' : 'utf8',
    content,
  };
}

async function fetchInBrowser(url: string, mode: NetworkResourceMode, timeoutMs: number) {
  const workspaceSignal = getWorkspaceSignal();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error', credentials: 'omit' });
    const result = await readBrowserResponse(response, mode);
    assertWorkspaceActive(workspaceSignal);
    return { ...result, requestedUrl: url, finalUrl: response.url || url };
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchInCapacitor(url: string, mode: NetworkResourceMode, timeoutMs: number): Promise<NetworkResourceResponse> {
  const signal = getWorkspaceSignal();
  assertWorkspaceActive(signal);
  let currentUrl = url;
  let response: Awaited<ReturnType<typeof CapacitorHttp.get>> | null = null;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    response = await CapacitorHttp.get({ url: currentUrl, connectTimeout: timeoutMs, readTimeout: timeoutMs, responseType: 'arraybuffer', disableRedirects: true });
    assertWorkspaceActive(signal);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const location = headers.location;
    if (!location || redirect === MAX_REDIRECTS) throw new Error('网络资源重定向次数过多');
    currentUrl = assertPublicUrl(new URL(location, currentUrl).toString());
  }
  if (!response) throw new Error('网络资源没有返回响应');
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const contentType = (headers['content-type'] || 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
  const binary = mode === 'download' || !(contentType.startsWith('text/') || ['application/json', 'application/xml', 'application/xhtml+xml', 'image/svg+xml'].includes(contentType));
  const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  const content = binary ? raw : new TextDecoder().decode(Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)));
  const sizeBytes = binary ? Math.floor(raw.length * 0.75) : new TextEncoder().encode(content).byteLength;
  if (sizeBytes > MAX_DIRECT_BYTES) throw new Error('网络资源超过 20 MB 限制');
  return { requestedUrl: url, finalUrl: response.url || currentUrl, status: response.status, contentType, sizeBytes, fileName: new URL(response.url || currentUrl).pathname.split('/').filter(Boolean).at(-1) || 'download', encoding: binary ? 'base64' : 'utf8', content };
}

function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/\s+/g, ' ').trim();
}

function nodeToMarkdown(node: Node, baseUrl: string): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdown(node.textContent || '');
  if (!(node instanceof HTMLElement)) return '';
  const tag = node.tagName.toLowerCase();
  const children = () => Array.from(node.childNodes).map((child) => nodeToMarkdown(child, baseUrl)).join(' ').replace(/[ \t]+/g, ' ').trim();
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${children()}\n\n`;
  if (tag === 'p' || tag === 'section' || tag === 'article') return `\n\n${children()}\n\n`;
  if (tag === 'br') return '\n';
  if (tag === 'li') return `\n- ${children()}`;
  if (tag === 'blockquote') return `\n\n> ${children().replace(/\n/g, '\n> ')}\n\n`;
  if (tag === 'pre') return `\n\n\`\`\`\n${(node.textContent || '').trim()}\n\`\`\`\n\n`;
  if (tag === 'code') return `\`${(node.textContent || '').trim()}\``;
  if (tag === 'a') {
    const label = children() || node.getAttribute('href') || '';
    try { return `[${label}](${new URL(node.getAttribute('href') || '', baseUrl).toString()})`; } catch { return label; }
  }
  if (tag === 'img') {
    const alt = escapeMarkdown(node.getAttribute('alt') || '图片');
    try { return `![${alt}](${new URL(node.getAttribute('src') || '', baseUrl).toString()})`; } catch { return alt; }
  }
  if (tag === 'table') {
    const rows = Array.from(node.querySelectorAll('tr')).map((row) => Array.from(row.querySelectorAll('th,td')).map((cell) => escapeMarkdown(cell.textContent || ''))).filter((row) => row.length);
    if (!rows.length) return '';
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
    return `\n\n${normalized.map((row) => `| ${row.join(' | ')} |`).flatMap((line, index) => index === 0 ? [line, `| ${Array(width).fill('---').join(' | ')} |`] : [line]).join('\n')}\n\n`;
  }
  return children();
}

export function htmlToReadableMarkdown(html: string, baseUrl: string) {
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  documentNode.querySelectorAll('script,style,noscript,template,svg,canvas,nav,footer,aside,form,dialog,[hidden],[aria-hidden="true"],.advertisement,.advert,.ads,.cookie,.modal').forEach((node) => node.remove());
  const root = documentNode.querySelector('article,main,[role="main"]') || documentNode.body;
  const title = (documentNode.querySelector('h1')?.textContent || documentNode.title || '').replace(/\s+/g, ' ').trim();
  const markdown = nodeToMarkdown(root, baseUrl).replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const content = [title ? `# ${escapeMarkdown(title)}` : '', markdown].filter(Boolean).join('\n\n');
  return { title, content };
}

function finalize(response: NetworkResourceResponse, mode: NetworkResourceMode, transport: NetworkResourceResult['transport']): NetworkResourceResult {
  if (response.encoding === 'base64') return { ...response, mode, transport };
  if (mode === 'source') {
    const originalLength = response.content.length;
    return { ...response, mode, transport, text: response.content.slice(0, MAX_SOURCE_CHARS), truncated: originalLength > MAX_SOURCE_CHARS, originalLength };
  }
  const readable = /html|xhtml/i.test(response.contentType) ? htmlToReadableMarkdown(response.content, response.finalUrl) : { title: '', content: response.content };
  const originalLength = readable.content.length;
  return { ...response, mode, transport, title: readable.title, text: readable.content.slice(0, MAX_READABLE_CHARS), truncated: originalLength > MAX_READABLE_CHARS, originalLength };
}

export async function fetchNetworkResource(urlValue: string, mode: NetworkResourceMode = 'readable', options: { timeoutMs?: number; allowServerFallback?: boolean; transferToken?: string } = {}) {
  const parsed = new URL(urlValue);
  const isFtp = parsed.protocol === 'ftp:' || parsed.protocol === 'ftps:';
  const url = assertPublicUrl(urlValue, isFtp ? ['ftp:', 'ftps:'] : ['http:', 'https:']);
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 20_000, 60_000));
  if (isFtp) return finalize(await api.fetchNetworkResource(url, mode, timeoutMs, options.transferToken), mode, 'server-fallback');
  const bridge = desktopBridge();
  if (bridge?.fetchNetworkResource) return finalize(await bridge.fetchNetworkResource({ url, mode, timeoutMs }), mode, 'electron');
  if (Capacitor.isNativePlatform()) return finalize(await fetchInCapacitor(url, mode, timeoutMs), mode, 'capacitor');
  try {
    return finalize(await fetchInBrowser(url, mode, timeoutMs), mode, 'browser');
  } catch (error) {
    if (options.allowServerFallback === false) throw error;
    return finalize(await api.fetchNetworkResource(url, mode, timeoutMs), mode, 'server-fallback');
  }
}

export async function downloadNetworkResource(url: string, suggestedName?: string) {
  const result = await fetchNetworkResource(url, 'download');
  const bytes = Uint8Array.from(atob(result.content), (char) => char.charCodeAt(0));
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = suggestedName || result.fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  return result;
}

export function exportNetworkResource(bytes: Uint8Array, fileName: string, contentType: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: contentType }));
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}
