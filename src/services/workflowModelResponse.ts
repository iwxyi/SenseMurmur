import { generateResponse, type GenerateResponseOptions } from './aiClient';
import { describeWorkflowModelRequest, type WorkflowModelRequest } from './workflowModelRequest';

export type WorkflowModelRequestHook = (request: WorkflowModelRequest) => Promise<void>;

export async function generateWorkflowModelResponse(
  config: Parameters<typeof generateResponse>[0],
  systemPrompt: Parameters<typeof generateResponse>[1],
  messages: Parameters<typeof generateResponse>[2],
  onChunk: Parameters<typeof generateResponse>[3],
  options: GenerateResponseOptions & { beforeModelRequest?: WorkflowModelRequestHook },
) {
  const { beforeModelRequest, ...requestOptions } = options;
  requestOptions.signal?.throwIfAborted();
  const { signal, ...serializableOptions } = requestOptions;
  const request = structuredClone({ config, systemPrompt, messages, options: serializableOptions });
  const frozenOptions = { ...request.options, signal };
  await beforeModelRequest?.(describeWorkflowModelRequest(request.config, request.systemPrompt, request.messages, frozenOptions));
  requestOptions.signal?.throwIfAborted();
  return generateResponse(request.config, request.systemPrompt, request.messages, onChunk, frozenOptions);
}
