import { workflowJsonDigest } from './workflowToolRequest';
import type { WorkflowSnapshot } from './workflowRunRuntime';

export interface WorkflowReviewVerdict {
  complete: boolean;
  reason: string;
  nextRequest?: string;
}

export interface WorkflowReviewRecord extends WorkflowReviewVerdict {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  attempt: number;
  planVersion: number;
  reviewedAt: number;
  criteriaSha256: string;
  evidenceSha256: string;
  sources: Array<{ taskId: string; kind: string; attempt: number; outputSha256: string }>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('主 Agent 验收结果无效');
  return value as Record<string, unknown>;
}

export function parseWorkflowReviewVerdict(value: unknown): WorkflowReviewVerdict {
  const result = record(value);
  if (typeof result.complete !== 'boolean' || typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 1000) throw new Error('主 Agent 验收结果无效');
  if (!result.complete && (typeof result.nextRequest !== 'string' || !result.nextRequest.trim() || result.nextRequest.length > 2000)) throw new Error('主 Agent 缺少后续任务说明');
  return { complete: result.complete, reason: result.reason.trim(), ...(!result.complete ? { nextRequest: (result.nextRequest as string).trim() } : {}) };
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

export function parseWorkflowReviewRecord(value: unknown): WorkflowReviewRecord {
  const entry = record(value);
  const verdict = parseWorkflowReviewVerdict(entry);
  if (entry.schemaVersion !== 1 || !nonempty(entry.runId) || !nonempty(entry.taskId)
    || !positive(entry.attempt) || !positive(entry.planVersion)
    || typeof entry.reviewedAt !== 'number' || !Number.isFinite(entry.reviewedAt) || entry.reviewedAt < 0
    || !digest(entry.criteriaSha256) || !digest(entry.evidenceSha256) || !Array.isArray(entry.sources)) throw new Error('验收记录版本或依据无效');
  const seen = new Set<string>();
  const sources = entry.sources.map((raw) => {
    const source = record(raw);
    if (!nonempty(source.taskId) || !nonempty(source.kind) || typeof source.attempt !== 'number'
      || !Number.isSafeInteger(source.attempt) || source.attempt < 0
      || !digest(source.outputSha256) || seen.has(source.taskId)) throw new Error('验收来源记录无效');
    seen.add(source.taskId);
    return { taskId: source.taskId, kind: source.kind, attempt: source.attempt, outputSha256: source.outputSha256 };
  });
  return { ...verdict, schemaVersion: 1, runId: entry.runId, taskId: entry.taskId, attempt: entry.attempt,
    planVersion: entry.planVersion, reviewedAt: entry.reviewedAt, criteriaSha256: entry.criteriaSha256,
    evidenceSha256: entry.evidenceSha256, sources };
}

// Bind the actual summarized evidence, while retaining hashes of the full source outputs.
export function prepareWorkflowReviewRecord(snapshot: WorkflowSnapshot, taskId: string, finalAcceptance: string,
  evidence: Array<{ task: string; output: string }>) {
  const task = snapshot.tasks.find((item) => item.id === taskId);
  if (!task || task.kind !== 'team_review' || task.status !== 'running' || task.attempt < 1) throw new Error('验收任务尚未领取');
  const sources = evidence.map((entry) => {
    const source = snapshot.tasks.find((item) => item.id === entry.task);
    if (!source || source.runId !== snapshot.run.id || source.status !== 'completed') throw new Error('验收证据尚未就绪');
    if (typeof source.output !== 'string') {
      if (source.kind !== 'team_review') throw new Error('验收证据尚未就绪');
      const review = parseWorkflowReviewRecord(source.output);
      if (review.runId !== snapshot.run.id || review.taskId !== source.id || review.attempt !== source.attempt) throw new Error('审核来源归属无效');
    }
    return { taskId: source.id, kind: source.kind, attempt: source.attempt, outputSha256: workflowJsonDigest(source.output) };
  });
  const basis = { schemaVersion: 1, runId: snapshot.run.id, taskId, attempt: task.attempt, planVersion: snapshot.run.planVersion,
    criteriaSha256: workflowJsonDigest({ goal: snapshot.run.goal, goalSpec: snapshot.run.goalSpec, finalAcceptance }),
    evidenceSha256: workflowJsonDigest(evidence), sources };
  parseWorkflowReviewRecord({ ...basis, complete: true, reason: '验收依据校验', reviewedAt: Date.now() });
  return (verdict: WorkflowReviewVerdict): WorkflowReviewRecord => parseWorkflowReviewRecord({ ...verdict, ...basis, reviewedAt: Date.now() });
}
