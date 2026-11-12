export const WORKFLOW_TOOLS = ['text_generation', 'web_search', 'image_generation', 'audio_generation', 'speech_generation',
  'video_generation', 'image_inspection', 'video_inspection', 'media_composition', 'delegate_task', 'user_input'] as const;
export type WorkflowTool = typeof WORKFLOW_TOOLS[number];

export interface WorkflowGoalSpec {
  schemaVersion: 1;
  objective: string;
  constraints: string[];
  acceptance: string[];
  preferences?: string[];
  deadlineAt?: number;
  allowedTools: WorkflowTool[];
  approvalTools?: WorkflowTool[];
  sourceBranch?: { enabled: boolean; name: string; headNodeId: string | null };
  execution: {
    location: 'client';
    recovery: 'safe_steps_only';
    maxConcurrentTasks: number;
    maxAutomaticReviewRounds: number;
  };
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 24 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2000)
    || new Set(value).size !== value.length) throw new Error(`目标契约${name}无效`);
  return [...value] as string[];
}

export function parseWorkflowGoalSpec(raw: unknown): WorkflowGoalSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('目标契约结构无效');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('目标契约版本不受支持');
  if (typeof value.objective !== 'string' || !value.objective.trim() || value.objective.length > 20_000) throw new Error('目标契约目标无效');
  const constraints = stringList(value.constraints, '约束');
  const acceptance = stringList(value.acceptance, '验收条件');
  const preferences = value.preferences === undefined ? undefined : stringList(value.preferences, '偏好');
  if (value.deadlineAt !== undefined && (!Number.isSafeInteger(value.deadlineAt) || Number(value.deadlineAt) <= 0
    || Number(value.deadlineAt) > 8_640_000_000_000_000)) throw new Error('目标契约截止时间无效');
  const allowedTools = stringList(value.allowedTools, '工具授权');
  if (allowedTools.some((tool) => !WORKFLOW_TOOLS.some((known) => known === tool))) throw new Error('目标契约包含未知工具');
  const approvalTools = value.approvalTools === undefined ? undefined : stringList(value.approvalTools, '审批工具');
  if (approvalTools?.some((tool) => !allowedTools.includes(tool))) throw new Error('审批工具必须在目标授权范围内');
  let sourceBranch: WorkflowGoalSpec['sourceBranch'];
  if (value.sourceBranch !== undefined) {
    const branch = value.sourceBranch;
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)
      || !('enabled' in branch) || typeof branch.enabled !== 'boolean'
      || !('name' in branch) || typeof branch.name !== 'string' || !branch.name.trim() || branch.name.length > 200
      || !('headNodeId' in branch) || (branch.headNodeId !== null && (typeof branch.headNodeId !== 'string' || !branch.headNodeId || branch.headNodeId.length > 1000))) {
      throw new Error('目标契约来源分支无效');
    }
    sourceBranch = { enabled: branch.enabled, name: branch.name, headNodeId: branch.headNodeId };
  }
  if (!value.execution || typeof value.execution !== 'object' || Array.isArray(value.execution)) throw new Error('目标契约执行策略无效');
  const execution = value.execution as Record<string, unknown>;
  if (execution.location !== 'client' || execution.recovery !== 'safe_steps_only') throw new Error('目标契约仅支持客户端执行与安全步骤恢复');
  if (!Number.isSafeInteger(execution.maxConcurrentTasks) || Number(execution.maxConcurrentTasks) < 1 || Number(execution.maxConcurrentTasks) > 3
    || !Number.isSafeInteger(execution.maxAutomaticReviewRounds) || Number(execution.maxAutomaticReviewRounds) < 0
    || Number(execution.maxAutomaticReviewRounds) > 3) throw new Error('目标契约执行上限无效');
  return { schemaVersion: 1, objective: value.objective, constraints, acceptance, allowedTools: allowedTools as WorkflowTool[],
    ...(approvalTools === undefined ? {} : { approvalTools: approvalTools as WorkflowTool[] }),
    ...(preferences === undefined ? {} : { preferences }),
    ...(value.deadlineAt === undefined ? {} : { deadlineAt: Number(value.deadlineAt) }),
    ...(sourceBranch ? { sourceBranch } : {}),
    execution: { location: 'client', recovery: 'safe_steps_only', maxConcurrentTasks: execution.maxConcurrentTasks as number,
      maxAutomaticReviewRounds: execution.maxAutomaticReviewRounds as number } };
}

export function defaultWorkflowGoalSpec(objective: string): WorkflowGoalSpec {
  return parseWorkflowGoalSpec({ schemaVersion: 1, objective, constraints: [], acceptance: [], allowedTools: [...WORKFLOW_TOOLS],
    execution: { location: 'client', recovery: 'safe_steps_only', maxConcurrentTasks: 3, maxAutomaticReviewRounds: 3 } });
}

export function workflowGoalContext(spec?: WorkflowGoalSpec): string {
  if (!spec) return '';
  return `\n用户明确约束：${spec.constraints.length ? spec.constraints.join('；') : '未另行指定'}\n用户验收条件：${spec.acceptance.length ? spec.acceptance.join('；') : '按原始目标交付'}\n用户偏好（须服从明确约束）：${spec.preferences?.join('；') || '未另行指定'}${spec.deadlineAt ? `\n截止时间：${new Date(spec.deadlineAt).toISOString()}` : ''}\n本次任务授权工具：${spec.allowedTools.join('、') || '无'}。岗位授权及当前模型能力仍须分别满足；不得自行扩权。${spec.approvalTools?.length ? `\n以下工具每次执行前须等待用户确认：${spec.approvalTools.join('、')}。程序保存确认决定后才会执行，不得自行声称已获批准。` : ''}`;
}

export function workflowDeadlineBlockReason(spec: WorkflowGoalSpec | undefined, now = Date.now()) {
  return spec?.deadlineAt !== undefined && now >= spec.deadlineAt ? '已到截止时间，未开始的步骤已暂停。调整截止时间后可继续。' : undefined;
}

export function assertWorkflowToolAuthorized(spec: WorkflowGoalSpec | undefined, tool: WorkflowTool) {
  if (spec && !spec.allowedTools.includes(tool)) throw new Error('该工具未获得本次任务的目标授权');
}
