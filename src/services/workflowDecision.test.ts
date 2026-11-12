import { describe, expect, it } from 'vitest';
import { copyWorkflowDelivery, type WorkflowDelivery } from './workflowDelivery';
import { assertWorkflowDecisions, assertWorkflowDecisionTransition, deliveryCopyDecision, parseWorkflowDecision } from './workflowDecision';
import { workflowJsonDigest } from './workflowToolRequest';

function candidate(): WorkflowDelivery {
  const artifact = { id: 'artifact', chatId: 'chat', kind: 'document' as const, title: '报告', sourceMessageId: 'source',
    currentVersionId: 'version', versions: [{ id: 'version', artifactId: 'artifact', content: '候选正文', createdAt: 1 }],
    createdAt: 1, updatedAt: 1, deletedAt: null };
  return { schemaVersion: 1, runId: 'run', chatId: 'chat', planVersion: 1, preparedAt: 1,
    artifacts: [{ before: null, after: artifact }], previousMessageIdentity: null,
    message: { id: 'team-delivery-run', clientKey: 'team-delivery-run', chatId: 'chat', type: 'ai', senderId: 'assistant',
      senderName: '助手', content: '候选正文', emotion: 0, timestamp: 1, isDeleted: false,
      metadata: { assistant: { mode: 'general', artifacts: [{ id: 'artifact', kind: 'document', title: '报告', versionId: 'version' }] } } } };
}

describe('workflow decision scope', () => {
  it('binds the decision to the exact candidate and deterministic copy without storing their bodies', () => {
    const original = candidate();
    const copy = copyWorkflowDelivery(original, 2);
    const record = deliveryCopyDecision(original, copy, 'message_conflict');
    expect(record.scope).toEqual({ conflict: 'message_conflict', candidateSha256: workflowJsonDigest(original), resultSha256: workflowJsonDigest(copy) });
    expect(JSON.stringify(record)).not.toContain('候选正文');
    expect(parseWorkflowDecision(record)).toEqual(record);
    expect(() => assertWorkflowDecisions({ id: 'run', planVersion: 1, delivery: original, deliveryCopy: copy, decisions: [record] })).not.toThrow();
    expect(() => deliveryCopyDecision(original, { ...copy, message: { ...copy.message, content: '替换正文' } }, 'message_conflict')).toThrow('候选不一致');
    expect(() => deliveryCopyDecision(original, { ...copy, runId: 'other' }, 'message_conflict')).toThrow();
  });

  it.each([{ schemaVersion: 2 }, { action: 'overwrite' }, { actor: 'model' }, { decidedAt: -1 },
    { decidedAt: Infinity }, { id: 'other' }, { planVersion: 0 }, { runId: '' },
    { scope: { conflict: 'save_failed', candidateSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64) } },
    { scope: { conflict: 'message_conflict', candidateSha256: 'wrong', resultSha256: 'b'.repeat(64) } }])('rejects malformed decisions %j', (change) => {
    const original = candidate();
    const record = deliveryCopyDecision(original, copyWorkflowDelivery(original, 2), 'message_conflict');
    expect(() => parseWorkflowDecision({ ...record, ...change })).toThrow();
  });

  it('keeps decisions immutable and requires an explicitly authorized append', () => {
    const original = candidate();
    const record = deliveryCopyDecision(original, copyWorkflowDelivery(original, 2), 'artifact_conflict');
    expect(() => assertWorkflowDecisionTransition(undefined, [record], record)).not.toThrow();
    expect(() => assertWorkflowDecisionTransition([record], [record])).not.toThrow();
    expect(() => assertWorkflowDecisionTransition([record], [])).toThrow();
    expect(() => assertWorkflowDecisionTransition([], [record])).toThrow();
    expect(() => assertWorkflowDecisionTransition([record], [{ ...record, decidedAt: 3 }])).toThrow();
    expect(() => assertWorkflowDecisions({ id: 'other', planVersion: 1, decisions: [record] })).toThrow();
    expect(() => assertWorkflowDecisions({ id: 'run', planVersion: 1, decisions: [record, record] })).toThrow();
    expect(() => assertWorkflowDecisions({ id: 'run', planVersion: 1, decisions: [{ ...record, planVersion: 2, id: 'delivery-copy:2' }] })).toThrow();
    expect(() => assertWorkflowDecisions({ id: 'run', planVersion: 2, decisions: [record] })).not.toThrow();
    expect(() => assertWorkflowDecisions({ id: 'run', planVersion: 1, delivery: original, deliveryCopy: copyWorkflowDelivery(original, 2) })).not.toThrow();
    expect(() => assertWorkflowDecisions({ id: 'run', planVersion: 1, delivery: original, decisions: [record] })).toThrow();
  });
});
