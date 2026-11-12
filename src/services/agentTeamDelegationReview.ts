import { workflowJsonDigest } from './workflowToolRequest';

export interface DelegationGoal {
  goal: string;
  acceptance: string;
}

export interface TeamDelegationReview {
  schemaVersion: 1;
  basisSha256: string;
  checks: Array<{ taskId: string; status: 'narrower'; reason: string }>;
}

type Candidate = DelegationGoal & { id: string; tool?: string };

export function parseTeamDelegationReview(value: unknown, tasks: Candidate[]): TeamDelegationReview {
  if (!value || typeof value !== 'object') throw new Error('委派范围检查记录无效');
  const record = value as Record<string, unknown>;
  const delegates = tasks.filter((task) => task.tool === 'delegate_task');
  if (record.schemaVersion !== 1 || typeof record.basisSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.basisSha256)
    || !Array.isArray(record.checks) || record.checks.length !== delegates.length || !delegates.length) throw new Error('委派范围检查记录无效');
  const checks = record.checks.map((value): TeamDelegationReview['checks'][number] => {
    if (!value || typeof value !== 'object') throw new Error('委派范围检查条目无效');
    const check = value as Record<string, unknown>;
    if (typeof check.taskId !== 'string' || !delegates.some((task) => task.id === check.taskId)
      || check.status !== 'narrower' || typeof check.reason !== 'string' || !check.reason.trim() || check.reason.length > 1000) throw new Error('委派范围检查条目无效');
    return { taskId: check.taskId, status: 'narrower', reason: check.reason.trim() };
  });
  if (new Set(checks.map((check) => check.taskId)).size !== delegates.length) throw new Error('委派范围检查条目重复');
  return { schemaVersion: 1, basisSha256: record.basisSha256, checks };
}

export function reviewTeamDelegation(tasks: Candidate[], ancestors: DelegationGoal[], rawChecks: unknown): TeamDelegationReview | undefined {
  const delegates = tasks.filter((task) => task.tool === 'delegate_task');
  if (!delegates.length) return undefined;
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (delegates.some((task) => ancestors.some((ancestor) => normalize(ancestor.goal) === normalize(task.goal)))) {
    throw new Error('下级委派重复祖先目标，已阻止循环拆分');
  }
  if (Array.isArray(rawChecks) && rawChecks.some((value) => value && typeof value === 'object'
    && ((value as Record<string, unknown>).status === 'repeated' || (value as Record<string, unknown>).status === 'uncertain'))) {
    throw new Error('下级委派目标重复或范围无法确认，请缩小子目标或直接安排具体工作');
  }
  return parseTeamDelegationReview({ schemaVersion: 1,
    basisSha256: workflowJsonDigest({ ancestors, tasks: delegates.map(({ id, goal, acceptance }) => ({ id, goal, acceptance })) }),
    checks: rawChecks,
  }, tasks);
}
