import type { WorkflowSnapshot, WorkflowTask } from './workflowRunRuntime';
import { parseWorkflowReviewRecord, type WorkflowReviewVerdict } from './workflowReviewRecord';

export const TEAM_REVIEW_EVIDENCE_LIMIT = 32_000;
const AGGREGATION_WIDTH = 4;

export interface TeamReviewInput {
  sourceTaskIds: string[];
  schemaVersion?: 2;
  mode?: 'batch' | 'aggregate';
  partial?: true;
}

export interface TeamReviewEvidence {
  task: string;
  kind: string;
  goal?: string;
  acceptance?: string;
  output: string;
  outputCharacters: number;
  truncated: boolean;
  complete?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseTeamReviewInput(value: unknown): TeamReviewInput {
  if (!record(value) || !Array.isArray(value.sourceTaskIds) || !value.sourceTaskIds.length
    || value.sourceTaskIds.some((id) => typeof id !== 'string' || !id)
    || new Set(value.sourceTaskIds).size !== value.sourceTaskIds.length
    || (value.schemaVersion !== undefined && value.schemaVersion !== 2)
    || (value.mode !== undefined && !['batch', 'aggregate'].includes(String(value.mode)))
    || (value.partial !== undefined && value.partial !== true)
    || (value.schemaVersion === undefined && (value.mode !== undefined || value.partial !== undefined))
    || (value.schemaVersion === 2 && value.mode === undefined)) throw new Error('主 Agent 验收输入版本或来源无效');
  return { sourceTaskIds: value.sourceTaskIds as string[],
    ...(value.schemaVersion === 2 ? { schemaVersion: 2, mode: value.mode as 'batch' | 'aggregate' } : {}),
    ...(value.partial ? { partial: true } : {}) };
}

export function isPartialTeamReview(task: WorkflowTask) {
  return task.kind === 'team_review' && record(task.input) && task.input.partial === true;
}

export function selectTeamReviewEvidence(snapshot: WorkflowSnapshot, taskIds: string[], excerptLimit = 1800) {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const maxPerTask = Math.min(excerptLimit, taskIds.length <= 12 ? 1800 : Math.max(240, Math.floor(24_000 / taskIds.length)));
  return { omitted: 0, evidence: taskIds.map((id): TeamReviewEvidence => {
    const source = byId.get(id);
    if (!source || source.runId !== snapshot.run.id || source.status !== 'completed' || typeof source.output !== 'string') throw new Error('验收证据尚未就绪');
    const task = record(source.input) && record(source.input.task) ? source.input.task : undefined;
    return { task: source.id, kind: source.kind,
      ...(task && typeof task.goal === 'string' && typeof task.acceptance === 'string' ? { goal: task.goal, acceptance: task.acceptance } : {}),
      output: source.output.slice(0, maxPerTask), outputCharacters: source.output.length, truncated: source.output.length > maxPerTask };
  }) };
}

export function selectTeamReviewSummaries(snapshot: WorkflowSnapshot, ids: string[]) {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const verdicts: WorkflowReviewVerdict[] = [];
  const evidence = ids.map((id): TeamReviewEvidence => {
    const source = byId.get(id);
    if (!source || source.kind !== 'team_review' || source.runId !== snapshot.run.id || source.status !== 'completed') throw new Error('分批审核尚未完成');
    const review = parseWorkflowReviewRecord(source.output);
    if (review.runId !== snapshot.run.id || review.taskId !== source.id || review.attempt !== source.attempt) throw new Error('分批审核来源不符');
    verdicts.push(review);
    const output = `${review.reason}\n后续工作：${review.nextRequest || '无'}`;
    return { task: source.id, kind: source.kind, output: output.slice(0, 1000), outputCharacters: output.length,
      truncated: output.length > 1000, complete: review.complete };
  });
  return { evidence, verdicts, omitted: 0 };
}

// A positive summary must never erase an explicit defect in a child review.
export function preserveTeamReviewDefects(verdict: WorkflowReviewVerdict, sources: WorkflowReviewVerdict[]): WorkflowReviewVerdict {
  const failed = sources.find((source) => !source.complete);
  return verdict.complete && failed ? { complete: false, reason: failed.reason, nextRequest: failed.nextRequest } : verdict;
}

export function buildTeamReviewTasks(snapshot: WorkflowSnapshot, reviewId: string, sourceTaskIds: string[], now: number): WorkflowTask[] {
  if (!sourceTaskIds.length || new Set(sourceTaskIds).size !== sourceTaskIds.length) throw new Error('验收来源缺失或重复');
  const allEvidence = selectTeamReviewEvidence(snapshot, sourceTaskIds).evidence;
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const make = (id: string, ids: string[], mode?: TeamReviewInput['mode'], partial?: true): WorkflowTask => ({
    id, runId: snapshot.run.id, kind: 'team_review', input: { sourceTaskIds: ids,
      ...(mode ? { schemaVersion: 2, mode } : {}), ...(partial ? { partial } : {}) } satisfies TeamReviewInput,
    dependsOn: ids, status: 'queued', attempt: 0, updatedAt: now,
  });
  if (JSON.stringify(allEvidence).length <= TEAM_REVIEW_EVIDENCE_LIMIT) return [make(reviewId, sourceTaskIds)];
  const tasks: WorkflowTask[] = [];
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 2;
  // Size against full per-item excerpts; execution may use shorter excerpts for larger batches.
  for (const entry of allEvidence) {
    const sourceId = entry.task;
    const source = byId.get(sourceId)!;
    const entrySize = JSON.stringify({ ...entry, output: (source.output as string).slice(0, 1800), truncated: (source.output as string).length > 1800 }).length + 1;
    if (entrySize + 2 > TEAM_REVIEW_EVIDENCE_LIMIT) throw new Error('单项审核证据超过上下文容量，请缩小任务描述');
    if (batch.length && size + entrySize > TEAM_REVIEW_EVIDENCE_LIMIT) { batches.push(batch); batch = []; size = 2; }
    batch.push(sourceId); size += entrySize;
  }
  if (batch.length) batches.push(batch);
  let layer = batches.map((ids, index) => {
    const id = `${reviewId}_batch_${index + 1}`;
    tasks.push(make(id, ids, 'batch', true));
    return id;
  });
  let depth = 1;
  while (layer.length > AGGREGATION_WIDTH) {
    const next: string[] = [];
    for (let index = 0; index < layer.length; index += AGGREGATION_WIDTH) {
      const id = `${reviewId}_merge_${depth}_${next.length + 1}`;
      tasks.push(make(id, layer.slice(index, index + AGGREGATION_WIDTH), 'aggregate', true));
      next.push(id);
    }
    layer = next; depth += 1;
  }
  tasks.push(make(reviewId, layer, 'aggregate'));
  return tasks;
}

export function teamReviewLeafSources(snapshot: WorkflowSnapshot, task: WorkflowTask): string[] {
  const result = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(snapshot.tasks.map((source) => [source.id, source]));
  const visit = (review: WorkflowTask) => {
    if (visiting.has(review.id)) throw new Error('审核依赖存在循环');
    visiting.add(review.id);
    const input = parseTeamReviewInput(review.input);
    for (const id of input.sourceTaskIds) {
      const source = byId.get(id);
      if (!source || source.runId !== snapshot.run.id) throw new Error('审核来源缺失');
      if (input.mode === 'aggregate') {
        if (source.kind !== 'team_review') throw new Error('审核汇总引用了非审核任务');
        visit(source);
      } else result.add(id);
    }
    visiting.delete(review.id);
  };
  visit(task);
  return [...result];
}
