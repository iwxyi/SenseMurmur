import { parseMediaExecutionQuote, type MediaExecutionQuote } from '../types/mediaExecutionQuote';
import { workflowJsonDigest } from './workflowToolRequest';

export interface PreparedMediaExecution {
  schemaVersion: 1;
  request: { model: string; provider?: string; [parameter: string]: unknown };
  submittedRequestSha256: string;
  quote: MediaExecutionQuote;
}

export function captureMediaExecutionRequest(value: unknown): PreparedMediaExecution['request'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('媒体执行请求无效');
  const request = value as Record<string, unknown>;
  if (typeof request.model !== 'string' || !request.model.trim()
    || (request.provider !== undefined && (typeof request.provider !== 'string' || !request.provider.trim()))
    || request.async !== true || typeof request.prompt !== 'string' || !request.prompt.trim()
    || ['execution_quote', 'executionFence', 'apiKey', 'api_key', 'token', 'authorization'].some((key) => key in request)) {
    throw new Error('媒体执行请求包含非法字段');
  }
  // Validate before serializing: dates, cycles and other non-JSON inputs must not silently change.
  workflowJsonDigest(request);
  return JSON.parse(JSON.stringify(request)) as PreparedMediaExecution['request'];
}

export function parsePreparedMediaExecution(value: unknown): PreparedMediaExecution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('媒体执行方案无效');
  const item = value as Record<string, unknown>;
  const request = captureMediaExecutionRequest(item.request);
  const quote = parseMediaExecutionQuote(item.quote);
  if (item.schemaVersion !== 1 || item.submittedRequestSha256 !== workflowJsonDigest(request)
    || quote.model !== request.model) throw new Error('媒体执行方案与报价不一致');
  return { schemaVersion: 1, request, submittedRequestSha256: String(item.submittedRequestSha256), quote };
}
