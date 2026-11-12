import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const WORKFLOW_TOOL_REQUEST_TYPES = ['web_search', 'image_generation', 'audio_generation', 'speech_generation', 'video_generation', 'media_composition'] as const;

export interface WorkflowToolRequest {
  schemaVersion: 1;
  tool: typeof WORKFLOW_TOOL_REQUEST_TYPES[number];
  sha256: string;
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('工具请求必须为无循环的 JSON 数据');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('工具请求不能包含非 JSON 对象');
  if (Object.getOwnPropertySymbols(value).length) throw new Error('工具请求不能包含 Symbol 字段');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) entries.push(canonicalJson(value[index], ancestors));
      return `[${entries.join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function workflowJsonDigest(input: unknown): string {
  if (input === undefined) throw new Error('工具请求输入缺失');
  const serialized = canonicalJson(input, new Set());
  return bytesToHex(sha256(utf8ToBytes(serialized)));
}

// Only the digest is persisted; tool arguments and file addresses stay in their existing stores.
export function describeWorkflowToolRequest(tool: WorkflowToolRequest['tool'], input: unknown): WorkflowToolRequest {
  if (!WORKFLOW_TOOL_REQUEST_TYPES.includes(tool)) throw new Error('工具请求类型无效');
  if (input === undefined) throw new Error('工具请求输入缺失');
  return { schemaVersion: 1, tool, sha256: workflowJsonDigest({ schemaVersion: 1, tool, input }) };
}

export function parseWorkflowToolRequest(raw: unknown): WorkflowToolRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工具请求摘要无效');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !WORKFLOW_TOOL_REQUEST_TYPES.some((tool) => tool === value.tool)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('工具请求摘要版本或内容无效');
  return { schemaVersion: 1, tool: value.tool as WorkflowToolRequest['tool'], sha256: value.sha256 };
}

export function workflowToolRequestKind(request: WorkflowToolRequest): string {
  return { web_search: 'agent_web_search', image_generation: 'agent_image', audio_generation: 'agent_audio',
    speech_generation: 'agent_audio', video_generation: 'agent_video', media_composition: 'agent_media_composition' }[request.tool];
}
