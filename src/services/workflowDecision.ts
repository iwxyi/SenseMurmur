import { workflowJsonDigest } from './workflowToolRequest';
import { copyWorkflowDelivery, type WorkflowDelivery } from './workflowDelivery';

export interface WorkflowDecisionRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  planVersion: number;
  action: 'preserve_and_copy_delivery';
  actor: 'local_user';
  decidedAt: number;
  scope: {
    conflict: 'artifact_conflict' | 'message_conflict';
    candidateSha256: string;
    resultSha256: string;
  };
}

export function parseWorkflowDecision(raw: unknown): WorkflowDecisionRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工作流决策记录无效');
  const value = raw as Record<string, unknown>;
  const scope = value.scope;
  if (value.schemaVersion !== 1 || typeof value.runId !== 'string' || !value.runId.trim()
    || !Number.isSafeInteger(value.planVersion) || Number(value.planVersion) < 1
    || value.id !== `delivery-copy:${value.planVersion}` || value.action !== 'preserve_and_copy_delivery'
    || value.actor !== 'local_user' || typeof value.decidedAt !== 'number' || !Number.isFinite(value.decidedAt) || value.decidedAt < 0
    || !scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('工作流决策版本或范围无效');
  const basis = scope as Record<string, unknown>;
  if (!['artifact_conflict', 'message_conflict'].includes(String(basis.conflict))
    || typeof basis.candidateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(basis.candidateSha256)
    || typeof basis.resultSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(basis.resultSha256)) throw new Error('工作流决策依据无效');
  return { schemaVersion: 1, id: value.id as string, runId: value.runId, planVersion: Number(value.planVersion),
    action: 'preserve_and_copy_delivery', actor: 'local_user', decidedAt: value.decidedAt,
    scope: { conflict: basis.conflict as WorkflowDecisionRecord['scope']['conflict'],
      candidateSha256: basis.candidateSha256, resultSha256: basis.resultSha256 } };
}

export function deliveryCopyDecision(candidate: WorkflowDelivery, result: WorkflowDelivery,
  conflict: WorkflowDecisionRecord['scope']['conflict']): WorkflowDecisionRecord {
  if (result.runId !== candidate.runId || result.planVersion !== candidate.planVersion
    || result.preparedAt < candidate.preparedAt
    || workflowJsonDigest(result) !== workflowJsonDigest(copyWorkflowDelivery(candidate, result.preparedAt, result.message.metadata?.branching))) {
    throw new Error('决策另存结果与候选不一致');
  }
  return parseWorkflowDecision({ schemaVersion: 1, id: `delivery-copy:${candidate.planVersion}`,
    runId: candidate.runId, planVersion: candidate.planVersion, action: 'preserve_and_copy_delivery', actor: 'local_user',
    decidedAt: result.preparedAt, scope: { conflict, candidateSha256: workflowJsonDigest(candidate), resultSha256: workflowJsonDigest(result) } });
}

export function assertWorkflowDecisions(run: { id: string; planVersion: number; decisions?: WorkflowDecisionRecord[];
  delivery?: WorkflowDelivery; deliveryCopy?: WorkflowDelivery }) {
  if (run.decisions === undefined) return;
  if (!Array.isArray(run.decisions)) throw new Error('工作流决策列表无效');
  const ids = new Set<string>();
  for (const raw of run.decisions) {
    const decision = parseWorkflowDecision(raw);
    if (decision.runId !== run.id || decision.planVersion > run.planVersion || ids.has(decision.id)) throw new Error('工作流决策归属或版本无效');
    ids.add(decision.id);
    if (decision.planVersion === run.delivery?.planVersion) {
      if (!run.deliveryCopy || workflowJsonDigest(decision) !== workflowJsonDigest(deliveryCopyDecision(run.delivery, run.deliveryCopy, decision.scope.conflict))) {
        throw new Error('工作流决策与交付范围不一致');
      }
    }
  }
}

export function assertWorkflowDecisionTransition(previous: WorkflowDecisionRecord[] | undefined, next: WorkflowDecisionRecord[] | undefined,
  added?: WorkflowDecisionRecord) {
  const before = previous || [];
  const after = next || [];
  if (after.length !== before.length + (added ? 1 : 0)
    || before.some((entry, index) => workflowJsonDigest(entry) !== workflowJsonDigest(after[index]))
    || (added && workflowJsonDigest(after[after.length - 1]) !== workflowJsonDigest(added))) throw new Error('已保存的决策不可删除、改写或用于其他范围');
}
