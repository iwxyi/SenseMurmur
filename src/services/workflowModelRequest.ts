import type { generateResponse, GenerateResponseOptions } from './aiClient';
import { workflowJsonDigest } from './workflowToolRequest';

export interface WorkflowModelRequest {
  schemaVersion: 1;
  sha256: string;
}

export function describeWorkflowModelRequest(
  config: Parameters<typeof generateResponse>[0],
  systemPrompt: Parameters<typeof generateResponse>[1],
  messages: Parameters<typeof generateResponse>[2],
  options?: GenerateResponseOptions,
): WorkflowModelRequest {
  return { schemaVersion: 1, sha256: workflowJsonDigest({ schemaVersion: 1,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl,
      maxOutputTokens: config.maxOutputTokens, advancedOptions: config.advancedOptions },
    systemPrompt, messages,
    options: { responseFormat: options?.responseFormat, maxTokens: options?.maxTokens, maxInputChars: options?.maxInputChars },
  }) };
}

export function parseWorkflowModelRequest(raw: unknown): WorkflowModelRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型请求摘要无效');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('模型请求摘要版本或内容无效');
  }
  return { schemaVersion: 1, sha256: value.sha256 };
}
