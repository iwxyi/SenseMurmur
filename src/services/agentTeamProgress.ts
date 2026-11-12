import type { WorkflowSnapshot, WorkflowTask } from './workflowRunRuntime';
import { isPartialTeamReview, teamReviewLeafSources } from './agentTeamReviewEvidence';
import { workflowJsonDigest } from './workflowToolRequest';
import { parseWorkflowReviewRecord, type WorkflowReviewProgress } from './workflowReviewRecord';

const OBSERVATION_KINDS = new Set(['agent_text', 'agent_web_search', 'agent_image_inspection', 'agent_video_inspection']);
const MEDIA_INSPECTION_KINDS: Record<string, string> = {
  agent_image: 'agent_image_inspection', agent_video: 'agent_video_inspection', agent_media_composition: 'agent_video_inspection',
};

/** Media comparisons require observations of each file; completion messages are not quality evidence. */
export function teamReviewProgressComparison(snapshot: WorkflowSnapshot, reviewId: string, criteriaSha256: string) {
  const index = snapshot.tasks.findIndex((task) => task.id === reviewId);
  const current = snapshot.tasks[index];
  if (!current || current.kind !== 'team_review' || isPartialTeamReview(current)) return null;
  const previous = snapshot.tasks.slice(0, index).filter((task) => task.kind === 'team_review'
    && task.status === 'completed' && !isPartialTeamReview(task)).at(-1);
  if (!previous || !nextRequest(previous)) return null;
  if (!previous.output || typeof previous.output !== 'object' || !('schemaVersion' in previous.output)) return null;
  const previousRecord = parseWorkflowReviewRecord(previous.output);
  if (previousRecord.runId !== snapshot.run.id || previousRecord.taskId !== previous.id || previousRecord.attempt !== previous.attempt
    || previousRecord.criteriaSha256 !== criteriaSha256) return null;
  const beforeIds = teamReviewLeafSources(snapshot, previous);
  const afterIds = teamReviewLeafSources(snapshot, current);
  if (!beforeIds?.length || !afterIds?.length || !afterIds.some((id) => !beforeIds.includes(id))
    || beforeIds.some((id) => !afterIds.includes(id))) return null;
  const evidence = (ids: string[]) => ids.map((id) => snapshot.tasks.find((task) => task.id === id));
  const before = evidence(beforeIds);
  const after = evidence(afterIds);
  const comparable = (tasks: typeof before) => tasks.every((task) => {
    if (!task || task.runId !== snapshot.run.id || task.status !== 'completed' || typeof task.output !== 'string') return false;
    if (OBSERVATION_KINDS.has(task.kind)) return true;
    const inspectionKind = MEDIA_INSPECTION_KINDS[task.kind];
    return Boolean(inspectionKind && tasks.some((inspection) => inspection?.kind === inspectionKind
      && inspection.status === 'completed' && typeof inspection.output === 'string' && inspection.output.trim()
      && inspection.dependsOn.includes(task.id)));
  });
  if (!comparable(before) || !comparable(after)) return null;
  const hasMedia = [...before, ...after].some((task) => task && MEDIA_INSPECTION_KINDS[task.kind]);
  const hasInspections = [...before, ...after].some((task) => task && ['agent_image_inspection', 'agent_video_inspection'].includes(task.kind));
  const entries = (tasks: typeof before) => tasks.map((task) => {
    const input = task!.input;
    const details = input && typeof input === 'object' && 'task' in input && input.task && typeof input.task === 'object' ? input.task : undefined;
    const media = MEDIA_INSPECTION_KINDS[task!.kind];
    return { taskId: task!.id, attempt: task!.attempt,
      inputSha256: workflowJsonDigest(input ?? null),
      ...(hasMedia || hasInspections ? { kind: task!.kind, dependenciesSha256: workflowJsonDigest(task!.dependsOn) } : {}),
      ...(media ? { outputSha256: workflowJsonDigest(task!.output),
        observationTaskIds: tasks.filter((inspection) => inspection?.kind === media && inspection.dependsOn.includes(task!.id)).map((inspection) => inspection!.id) }
        : { output: task!.output }),
      goal: details && 'goal' in details && typeof details.goal === 'string' ? details.goal : undefined,
      acceptance: details && 'acceptance' in details && typeof details.acceptance === 'string' ? details.acceptance : undefined };
  });
  const comparison = { goal: snapshot.run.goal, goalSpec: snapshot.run.goalSpec, criteriaSha256, previousReviewTaskId: previous.id,
    ...(hasMedia || hasInspections ? { observationScope: '仅比较检查任务的完整观察报告。图片检查只覆盖所提供图片；视频抽帧只覆盖报告中的采样时刻，不证明音轨、逐帧连续性或全部镜头质量。媒体摘要及文件摘要不证明质量；报告缺失或观察不足时必须判为 uncertain。' } : {}),
    previousVerdict: previous.output, before: entries(before), after: entries(after) };
  // Avoid turning bounded evidence into a claim about unseen text.
  if (JSON.stringify(comparison).length > 12_000) return null;
  return { comparison, comparisonSha256: workflowJsonDigest(comparison) };
}

export function parseTeamProgressAssessment(comparison: ReturnType<typeof teamReviewProgressComparison>, raw: unknown): WorkflowReviewProgress | undefined {
  if (!comparison || !raw || typeof raw !== 'object' || !('progress' in raw) || raw.progress === undefined) return undefined;
  const value = raw.progress;
  if (!value || typeof value !== 'object' || !('status' in value) || !('reason' in value)
    || typeof value.status !== 'string' || !['advanced', 'stalled', 'uncertain'].includes(value.status)
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000) throw new Error('验收进展比较无效');
  return { previousReviewTaskId: comparison.comparison.previousReviewTaskId, comparisonSha256: comparison.comparisonSha256,
    status: value.status as WorkflowReviewProgress['status'], reason: value.reason.trim() };
}

export function hasSemanticallyStalledTeamReview(snapshot: WorkflowSnapshot, reviewId: string): boolean {
  const task = snapshot.tasks.find((item) => item.id === reviewId);
  if (!task || task.status !== 'completed' || !nextRequest(task) || !task.output || typeof task.output !== 'object'
    || !('progress' in task.output) || task.output.progress === undefined) return false;
  const record = parseWorkflowReviewRecord(task.output);
  const comparison = teamReviewProgressComparison(snapshot, reviewId, record.criteriaSha256);
  return Boolean(comparison && record.runId === snapshot.run.id && record.taskId === task.id && record.attempt === task.attempt
    && record.progress?.status === 'stalled' && record.progress.previousReviewTaskId === comparison.comparison.previousReviewTaskId
    && record.progress.comparisonSha256 === comparison.comparisonSha256);
}

function normalized(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function nextRequest(task: WorkflowTask): string | null {
  if (!task.output || typeof task.output !== 'object' || !('complete' in task.output)
    || task.output.complete !== false || !('nextRequest' in task.output) || typeof task.output.nextRequest !== 'string') return null;
  return normalized(task.output.nextRequest);
}

/** Only identical text evidence is conclusive; media completion summaries cannot establish progress. */
export function hasRepeatedTeamReviewWithoutProgress(snapshot: WorkflowSnapshot, reviewId: string): boolean {
  const index = snapshot.tasks.findIndex((task) => task.id === reviewId);
  const current = snapshot.tasks[index];
  if (!current || current.kind !== 'team_review' || current.status !== 'completed' || isPartialTeamReview(current)) return false;
  const previous = snapshot.tasks.slice(0, index).filter((task) => task.kind === 'team_review' && task.status === 'completed' && !isPartialTeamReview(task)).at(-1);
  if (!previous || !nextRequest(current) || nextRequest(current) !== nextRequest(previous)) return false;
  const beforeIds = teamReviewLeafSources(snapshot, previous);
  const afterIds = teamReviewLeafSources(snapshot, current);
  if (!beforeIds?.length || !afterIds?.length) return false;
  const beforeSet = new Set(beforeIds);
  const newTasks = afterIds.filter((id) => !beforeSet.has(id)).map((id) => snapshot.tasks.find((task) => task.id === id));
  if (!newTasks.length || newTasks.some((task) => !task || !['agent_text', 'agent_web_search'].includes(task.kind))) return false;
  const outputs = (ids: string[]) => ids.map((id) => snapshot.tasks.find((task) => task.id === id))
    .map((task) => task?.status === 'completed' && typeof task.output === 'string' ? normalized(task.output) : null);
  const before = outputs(beforeIds);
  const after = outputs(afterIds);
  if (before.some((output) => !output) || after.some((output) => !output)) return false;
  const beforeOutputs = new Set(before);
  const afterOutputs = new Set(after);
  return beforeOutputs.size === afterOutputs.size && [...beforeOutputs].every((output) => afterOutputs.has(output));
}
