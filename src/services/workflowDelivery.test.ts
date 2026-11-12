import { describe, expect, it } from 'vitest';
import type { AssistantArtifactItem } from '../types/assistantArtifact';
import { parseWorkflowDelivery, projectWorkflowArtifacts, type WorkflowDelivery } from './workflowDelivery';

function item(id = 'artifact', content = '报告正文'): AssistantArtifactItem {
  return { id, chatId: 'chat', kind: 'document', title: '报告', sourceMessageId: 'source',
    currentVersionId: `${id}:1`, versions: [{ id: `${id}:1`, artifactId: id, content, createdAt: 1 }],
    createdAt: 1, updatedAt: 1, deletedAt: null };
}

function delivery(): WorkflowDelivery {
  const after = item();
  return { schemaVersion: 1, runId: 'run', chatId: 'chat', planVersion: 1, preparedAt: 1,
    artifacts: [{ before: null, after }], previousMessageIdentity: null,
    message: { id: 'team-delivery-run', clientKey: 'team-delivery-run', chatId: 'chat', type: 'ai',
      senderId: 'assistant', senderName: '助手', content: '完成', emotion: 0, timestamp: 1, isDeleted: false,
      metadata: { assistant: { mode: 'general', artifacts: [{ id: after.id, kind: after.kind, title: after.title, versionId: after.currentVersionId }] } } },
  };
}

describe('workflow delivery contract', () => {
  it('validates the versioned manifest and exact artifact/message association', () => {
    expect(parseWorkflowDelivery(delivery())).toEqual(delivery());
    const invalid = delivery();
    invalid.message.metadata!.assistant!.artifacts![0].versionId = 'different-version';
    expect(() => parseWorkflowDelivery(invalid)).toThrow('消息与产物不一致');
    expect(() => parseWorkflowDelivery({ ...delivery(), schemaVersion: 2 })).toThrow('版本不受支持');
    expect(() => parseWorkflowDelivery({ ...delivery(), chatId: 'different-chat' })).toThrow('交付产物无效');
  });

  it('rejects duplicate artifacts and incomplete base snapshots', () => {
    const invalid = delivery();
    invalid.artifacts.push(invalid.artifacts[0]);
    expect(() => parseWorkflowDelivery(invalid)).toThrow('交付产物无效');
    const invalidBase = delivery();
    invalidBase.artifacts[0].before = { ...item(), currentVersionId: 'missing' };
    expect(() => parseWorkflowDelivery(invalidBase)).toThrow('交付产物无效');
  });

  it('replays identical snapshots without creating versions or changing user sort order', () => {
    const after = item();
    const projections = [{ before: null, after }];
    const first = projectWorkflowArtifacts([], projections);
    first[0] = { ...first[0], sortOrder: 123 };
    const second = projectWorkflowArtifacts(first, projections);
    expect(second).toEqual(first);
    expect(second[0].versions).toHaveLength(1);
    const before = item();
    const next = { ...before, title: '更新的报告' };
    expect(projectWorkflowArtifacts([{ ...before, sortOrder: 42 }], [{ before, after: next }])[0]).toMatchObject({ title: '更新的报告', sortOrder: 42 });
  });

  it.each(['edited', 'deleted', 'missing', 'occupied'])('rejects %s artifacts before applying any projection', (mode) => {
    const before = item();
    const after = { ...before, title: '更新的报告' };
    const existing = mode === 'missing' ? [] : mode === 'occupied' ? [item('other')]
      : [mode === 'deleted' ? { ...before, deletedAt: 2 } : item('artifact', '用户修改')];
    const original = structuredClone(existing);
    expect(() => projectWorkflowArtifacts(existing, [{ before: mode === 'occupied' ? null : before, after }])).toThrow('版本冲突');
    expect(existing).toEqual(original);
  });
});
