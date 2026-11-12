import { describe, expect, it } from 'vitest';
import { assertWorkflowToolAuthorized, defaultWorkflowGoalSpec, parseWorkflowGoalSpec, workflowDeadlineBlockReason, workflowGoalBlockReason, workflowGoalContext } from './workflowGoalSpec';

describe('workflow goal contract', () => {
  it('requires a persisted platform budget before dispatch only when explicitly requested', () => {
    const base = defaultWorkflowGoalSpec('目标');
    expect(workflowGoalBlockReason(base)).toBeUndefined();
    const required = parseWorkflowGoalSpec({ ...base, requirePlatformBudget: true });
    expect(required.requirePlatformBudget).toBe(true);
    expect(workflowGoalBlockReason(required)).toContain('先保存平台任务预算');
    expect(workflowGoalBlockReason({ ...required, platformBudget: { revision: 1, billingUnit: 'point', limitAmount: '0.000000' } })).toBeUndefined();
    for (const invalid of [false, null, 1, 'true']) expect(() => parseWorkflowGoalSpec({ ...base, requirePlatformBudget: invalid })).toThrow('平台预算要求');
  });
  it('binds exact platform budget values without altering older contracts', () => {
    const base = defaultWorkflowGoalSpec('目标');
    expect(base).not.toHaveProperty('platformBudget');
    const platformBudget = { revision: 2, billingUnit: 'point', limitAmount: '999999999999999999.123456' };
    expect(parseWorkflowGoalSpec({ ...base, platformBudget }).platformBudget).toEqual(platformBudget);
    for (const invalid of [null, [], {}, { ...platformBudget, revision: 0 }, { ...platformBudget, revision: 1.5 },
      { ...platformBudget, billingUnit: '' }, { ...platformBudget, limitAmount: '1.2' }, { ...platformBudget, limitAmount: 1 }]) {
      expect(() => parseWorkflowGoalSpec({ ...base, platformBudget: invalid })).toThrow('平台预算');
    }
  });
  it('only allows approval policies for authorized tools', () => {
    const base = { ...defaultWorkflowGoalSpec('制作图片'), allowedTools: ['image_generation'] };
    expect(parseWorkflowGoalSpec({ ...base, approvalTools: ['image_generation'] }).approvalTools).toEqual(['image_generation']);
    expect(() => parseWorkflowGoalSpec({ ...base, approvalTools: ['video_generation'] })).toThrow();
    expect(() => parseWorkflowGoalSpec({ ...base, approvalTools: ['shell'] })).toThrow();
  });
  it('preserves optional preferences and deadline without changing legacy contracts', () => {
    const legacy = defaultWorkflowGoalSpec('目标');
    expect(parseWorkflowGoalSpec(legacy)).not.toHaveProperty('preferences');
    const spec = parseWorkflowGoalSpec({ ...legacy, preferences: ['优先复用已有素材'], deadlineAt: 2000 });
    expect(workflowGoalContext(spec)).toContain('优先复用已有素材');
    expect(workflowGoalContext(spec)).toContain(new Date(2000).toISOString());
    expect(workflowDeadlineBlockReason(spec, 1999)).toBeUndefined();
    expect(workflowDeadlineBlockReason(spec, 2000)).toContain('截止时间');
    expect(() => parseWorkflowGoalSpec({ ...legacy, deadlineAt: NaN })).toThrow('截止时间');
    expect(() => parseWorkflowGoalSpec({ ...legacy, preferences: ['重复', '重复'] })).toThrow('偏好');
  });
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
