import { describe, expect, it } from 'vitest';
import { isSafelyResumableConversation, isSafelyResumableWorkflow, projectBackgroundExecutionOverview } from './backgroundExecutionOverview';
import { normalizeConversation } from '../types/chat';
import type { WorkflowSnapshot, WorkflowTaskStatus } from './workflowRunRuntime';

function sample(id: string, status: WorkflowSnapshot['run']['status'], taskStatus: WorkflowTaskStatus): WorkflowSnapshot {
  return {
    run: { id, chatId: id, goal: '回复', status, generation: 0, planVersion: 1, updatedAt: 1 },
    tasks: [{ id: `${id}-task`, runId: id, kind: 'assistant_reply', input: {}, dependsOn: [], status: taskStatus, attempt: 0, updatedAt: 1 }],
  };
}

describe('background execution overview', () => {
  it('projects persisted runs and live ownership without counting completed work', () => {
    const overview = projectBackgroundExecutionOverview([
      sample('active', 'active', 'running'),
      sample('queued', 'active', 'queued'),
      sample('paused', 'paused', 'queued'),
      sample('blocked', 'paused', 'result_unknown'),
      sample('done', 'completed', 'completed'),
      sample('awaiting-close', 'active', 'completed'),
      sample('abandoned-review', 'paused', 'abandoned'),
    ], ['active']);
    expect(overview).toEqual({ running: 1, queued: 1, interrupted: 1, blocked: 1, resumable: 0, chatId: 'active' });
  });

  it('only resumes interrupted work that is safe to continue automatically', () => {
    expect(isSafelyResumableWorkflow(sample('queued-after-interrupt', 'paused', 'queued'))).toBe(true);
    expect(isSafelyResumableWorkflow(sample('waiting-external', 'paused', 'waiting_external'))).toBe(true);
    expect(isSafelyResumableWorkflow(sample('unknown-result', 'paused', 'result_unknown'))).toBe(false);
    expect(isSafelyResumableWorkflow(sample('needs-user', 'paused', 'waiting_user'))).toBe(false);
    expect(isSafelyResumableWorkflow(sample('failed', 'paused', 'failed'))).toBe(false);
    expect(isSafelyResumableWorkflow(sample('cancelled', 'paused', 'cancelled'))).toBe(false);
    expect(isSafelyResumableWorkflow(sample('active', 'active', 'queued'))).toBe(false);
  });

  it('resumes committed conversation checkpoints but respects story and study stop gates', () => {
    const checkpoint = sample('committed', 'paused', 'completed');
    checkpoint.tasks[0].output = { outcome: 'committed', messageId: 'saved-reply' };
    const conversation = normalizeConversation({ id: 'conversation', type: 'group', mode: 'group_discussion',
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } });
    const story = normalizeConversation({ id: 'story', type: 'group', mode: 'group_discussion',
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' } });
    const study = normalizeConversation({ id: 'study', type: 'group', mode: 'classroom',
      sessionKind: { topology: 'group', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' } });
    expect(isSafelyResumableConversation(checkpoint, conversation)).toBe(true);
    expect(isSafelyResumableConversation(checkpoint, story)).toBe(false);
    expect(isSafelyResumableConversation(checkpoint, study)).toBe(false);
    expect(isSafelyResumableConversation(sample('no-commit', 'paused', 'completed'), conversation)).toBe(false);
  });
});
