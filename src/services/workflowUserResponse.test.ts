import { describe, expect, it } from 'vitest';
import { assertWorkflowUserResponse, createWorkflowUserResponse } from './workflowUserResponse';

const answered = () => {
  const task = { id: 'question', runId: 'run', input: { question: '目标市场？' },
    kind: 'agent_user_input', status: 'completed', output: '日本市场' };
  return { ...task, userResponse: createWorkflowUserResponse(task, 2, task.output, 123) };
};

describe('versioned user responses', () => {
  it('binds the answer to its question and the preceding plan version', () => {
    const task = answered();
    expect(() => assertWorkflowUserResponse(task, 3)).not.toThrow();
    expect(() => assertWorkflowUserResponse(task, 8)).not.toThrow();
    expect(JSON.stringify(task.userResponse)).not.toContain('日本市场');
    for (const change of [{ input: 'different' }, { output: '美国市场' }, { id: 'other' }, { runId: 'other' },
      { kind: 'agent_text' }, { status: 'waiting_user' }, { output: '' }, { output: 'a'.repeat(4001) }]) {
      expect(() => assertWorkflowUserResponse({ ...task, ...change }, 3)).toThrow();
    }
    expect(() => assertWorkflowUserResponse(task, 2)).toThrow();
    expect(() => assertWorkflowUserResponse({ ...task, userResponse: undefined }, 3)).toThrow('缺少版本依据');
    expect(() => assertWorkflowUserResponse({ ...task, status: 'waiting_user', userResponse: undefined }, 3)).not.toThrow();
  });

  it.each([{ schemaVersion: 2 }, { actor: 'model' }, { planVersion: 0 }, { planVersion: 1.5 },
    { respondedAt: -1 }, { respondedAt: Infinity }, { inputSha256: 'wrong' }, { outputSha256: 'wrong' }])
  ('rejects malformed response evidence %j', (change) => {
    const task = answered();
    expect(() => assertWorkflowUserResponse({ ...task, userResponse: { ...task.userResponse, ...change } as typeof task.userResponse }, 3)).toThrow();
  });
});
