import { describe, expect, it, vi } from 'vitest';
import { validateAgentTeamPlan } from './agentTeamPlan';

const valid = () => ({
  summary: '先研究，再写报告',
  roles: [{ id: 'researcher', name: '研究员', responsibility: '收集问题线索', method: '逐项比较并注明假设', acceptance: '列出证据与不确定性', allowedTools: ['text_generation'] }],
  tasks: [
    { id: 'research', roleId: 'researcher', goal: '分析需求', dependsOn: [], acceptance: '需求清单完整' },
    { id: 'report', roleId: 'researcher', goal: '写报告', dependsOn: ['research'], acceptance: '报告覆盖清单' },
  ],
  finalAcceptance: '交付报告',
});

describe('agent team plan', () => {
  it('accepts a bounded task graph with explicit role contracts', () => {
    expect(validateAgentTeamPlan(valid()).tasks[1].dependsOn).toEqual(['research']);
  });

  it('rejects unknown tools and missing role references', () => {
    const unknownTool = valid();
    unknownTool.roles[0].allowedTools = ['shell'];
    expect(() => validateAgentTeamPlan(unknownTool)).toThrow('不可用工具');
    const missingRole = valid();
    missingRole.tasks[0].roleId = 'ghost';
    expect(() => validateAgentTeamPlan(missingRole)).toThrow('不存在的岗位');
  });

  it('rejects cycles, duplicate IDs and oversized teams', () => {
    const cycle = valid();
    cycle.tasks[0].dependsOn = ['report'];
    expect(() => validateAgentTeamPlan(cycle)).toThrow('形成环');
    const duplicate = valid();
    duplicate.tasks[1].id = 'research';
    expect(() => validateAgentTeamPlan(duplicate)).toThrow('任务 ID 重复');
    const reserved = valid();
    reserved.tasks[0].id = 'plan';
    expect(() => validateAgentTeamPlan(reserved)).toThrow('内部规划步骤冲突');
    const oversized = valid();
    oversized.roles = Array.from({ length: 7 }, (_, index) => ({ ...oversized.roles[0], id: `role_${index}` }));
    expect(() => validateAgentTeamPlan(oversized)).toThrow('规模超出限制');
  });
});
