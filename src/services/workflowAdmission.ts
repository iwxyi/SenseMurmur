import type { WorkflowUsageReference } from '../types/workflowUsage';

const BUDGET_REJECTIONS: Record<string, { status: number; message: string }> = {
  WORKFLOW_BUDGET_CHANNEL_UNSUPPORTED: { status: 409, message: '本任务已配置平台预算，第三方直连费用无法纳入预算。请切换到平台渠道后继续。' },
  WORKFLOW_BUDGET_EXHAUSTED: { status: 402, message: '任务金额预算不足，请调整预算后继续。' },
  WORKFLOW_BUDGET_UNRESOLVED: { status: 409, message: '任务有待核对的费用，请完成核对后继续。' },
  WORKFLOW_BUDGET_QUOTE_REQUIRED: { status: 409, message: '当前调用没有可靠报价，请调整模型或配置后继续。' },
  WORKFLOW_BUDGET_UNIT_MISMATCH: { status: 409, message: '调用计费单位与任务预算不一致，请检查配置后继续。' },
  WORKFLOW_BUDGET_REVISION_CONFLICT: { status: 409, message: '任务预算已更改，请刷新并确认预算后继续。' },
};

export function assertWorkflowBudgetChannel(workflow: WorkflowUsageReference | undefined, platformAccounted: boolean) {
  if (workflow?.budgetRevision === undefined || platformAccounted) return;
  const code = 'WORKFLOW_BUDGET_CHANNEL_UNSUPPORTED';
  throw Object.assign(new Error(BUDGET_REJECTIONS[code].message), { code, status: 409 });
}

export function workflowAdmissionBlockReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = error as Error & { status?: unknown; code?: unknown; diagnostic?: { status?: unknown; code?: unknown } };
  const code = value.code ?? value.diagnostic?.code;
  const status = value.status ?? value.diagnostic?.status;
  const rejection = typeof code === 'string' ? BUDGET_REJECTIONS[code] : undefined;
  return rejection && status === rejection.status ? rejection.message : undefined;
}

export function workflowAdmissionRejection(error: unknown): { code: string; status: number } | undefined {
  if (!workflowAdmissionBlockReason(error)) return undefined;
  const value = error as Error & { status?: number; code?: string; diagnostic?: { status?: number; code?: string } };
  return { code: (value.code ?? value.diagnostic?.code)!, status: (value.status ?? value.diagnostic?.status)! };
}
