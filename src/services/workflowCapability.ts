import { WORKFLOW_TOOLS, type WorkflowTool } from './workflowGoalSpec';

export const WORKFLOW_CAPABILITY_RECOVERY = {
  model_missing: '配置对应类型的模型后，重试该任务。',
  model_unsupported: '选择支持此能力的模型后，重试该任务。',
  device_unsupported: '使用支持此能力的客户端，或调整任务方案。',
  service_unavailable: '确认服务连接和模型可用后，重试该任务。',
  input_unsupported: '调整素材数量或输入要求，或更换支持这些输入的模型。',
  tool_disabled: '启用对应工具，或调整任务方案。',
} as const;

export interface WorkflowCapabilityRequirement {
  tool: WorkflowTool;
  code: keyof typeof WORKFLOW_CAPABILITY_RECOVERY;
}

export interface WorkflowCapabilityIssue extends WorkflowCapabilityRequirement {
  schemaVersion: 1;
  attempt: number;
  planVersion: number;
}

export function parseWorkflowCapabilityIssue(raw: unknown): WorkflowCapabilityIssue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('能力不足记录结构无效');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('能力不足记录版本不受支持');
  if (!WORKFLOW_TOOLS.some((tool) => tool === value.tool)
    || typeof value.code !== 'string' || !Object.hasOwn(WORKFLOW_CAPABILITY_RECOVERY, value.code)) throw new Error('能力不足记录类型无效');
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1
    || !Number.isSafeInteger(value.planVersion) || Number(value.planVersion) < 1) throw new Error('能力不足记录归属无效');
  return { schemaVersion: 1, tool: value.tool as WorkflowTool, code: value.code as WorkflowCapabilityIssue['code'],
    attempt: Number(value.attempt), planVersion: Number(value.planVersion) };
}
