import { describe, expect, it } from 'vitest';
import { parseTeamDelegationReview, reviewTeamDelegation } from './agentTeamDelegationReview';

const ancestors = [{ goal: '完成产品市场研究报告', acceptance: '覆盖市场与用户需求' }];
const tasks = [{ id: 'market', goal: '研究日本用户的离线使用需求', acceptance: '需求清单与证据', tool: 'delegate_task' }];
const checks = [{ taskId: 'market', status: 'narrower', reason: '仅研究日本用户离线需求，不承担完整报告' }];

describe('delegation scope review', () => {
  it('binds accepted checks to complete ancestor and candidate contracts', () => {
    const review = reviewTeamDelegation(tasks, ancestors, checks)!;
    expect(parseTeamDelegationReview(review, tasks)).toEqual(review);
    expect(reviewTeamDelegation(tasks, [{ ...ancestors[0], acceptance: '新增要求' }], checks)?.basisSha256).not.toBe(review.basisSha256);
    expect(reviewTeamDelegation([{ ...tasks[0], goal: '其他需求' }], ancestors, checks)?.basisSha256).not.toBe(review.basisSha256);
    expect(JSON.stringify(review)).not.toContain(ancestors[0].goal);
  });
  it.each(['repeated', 'uncertain'])('rejects paraphrased or uncertain goals: %s', (status) => {
    expect(() => reviewTeamDelegation(tasks, ancestors, [{ ...checks[0], status }])).toThrow('重复或范围无法确认');
  });
  it.each([undefined, [], [{ ...checks[0], reason: '' }], [{ ...checks[0], taskId: 'foreign' }],
    [checks[0], checks[0]], [{ ...checks[0], status: 'NARROWER' }]])('rejects missing or invalid assessments: %j', (value) => {
    expect(() => reviewTeamDelegation(tasks, ancestors, value)).toThrow('检查');
  });
  it('detects exact normalized repeats even if the model calls them narrower', () => {
    expect(() => reviewTeamDelegation([{ ...tasks[0], goal: ' 完成产品市场研究报告 ' }], ancestors, checks)).toThrow('重复祖先目标');
  });
  it('does not require a semantic assessment for concrete work', () => {
    expect(reviewTeamDelegation([{ ...tasks[0], tool: 'text_generation' }], ancestors, undefined)).toBeUndefined();
  });
});
