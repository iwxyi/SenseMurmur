import { describe, expect, it } from 'vitest';
import { assertWorkflowToolAuthorized, defaultWorkflowGoalSpec, parseWorkflowGoalSpec, workflowGoalContext } from './workflowGoalSpec';

describe('workflow goal contract', () => {
  it('keeps the user objective and applies the approved client execution defaults', () => {
    const spec = defaultWorkflowGoalSpec('制作森林短片');
    expect(spec).toMatchObject({ schemaVersion: 1, objective: '制作森林短片', constraints: [], acceptance: [],
      execution: { location: 'client', recovery: 'safe_steps_only', maxConcurrentTasks: 3, maxAutomaticReviewRounds: 3 } });
    expect(spec.allowedTools).toContain('video_inspection');
    const parsed = parseWorkflowGoalSpec(spec);
    parsed.allowedTools.length = 0;
    expect(spec.allowedTools.length).toBeGreaterThan(0);
  });

  it('preserves explicit constraints and limits tool authorization', () => {
    const spec = parseWorkflowGoalSpec({ ...defaultWorkflowGoalSpec('调研报告'), allowedTools: ['text_generation'], constraints: ['不生成付费媒体'], acceptance: ['列出不确定性'] });
    expect(workflowGoalContext(spec)).toContain('不生成付费媒体');
    expect(workflowGoalContext(spec)).toContain('列出不确定性');
    expect(() => assertWorkflowToolAuthorized(spec, 'text_generation')).not.toThrow();
    expect(() => assertWorkflowToolAuthorized(spec, 'video_generation')).toThrow('目标授权');
    expect(() => assertWorkflowToolAuthorized(undefined, 'video_generation')).not.toThrow();
  });

  it('rejects unknown versions, capabilities, and unsupported execution modes', () => {
    const spec = defaultWorkflowGoalSpec('目标');
    expect(() => parseWorkflowGoalSpec({ ...spec, schemaVersion: 2 })).toThrow('版本');
    expect(() => parseWorkflowGoalSpec({ ...spec, allowedTools: ['shell'] })).toThrow('未知工具');
    expect(() => parseWorkflowGoalSpec({ ...spec, execution: { ...spec.execution, location: 'cloud' } })).toThrow('客户端');
    expect(() => parseWorkflowGoalSpec({ ...spec, execution: { ...spec.execution, maxConcurrentTasks: 4 } })).toThrow('上限');
    expect(() => parseWorkflowGoalSpec({ ...spec, execution: { ...spec.execution, maxAutomaticReviewRounds: -1 } })).toThrow('上限');
    expect(() => parseWorkflowGoalSpec({ ...spec, acceptance: ['重复', '重复'] })).toThrow('验收条件');
  });
});
