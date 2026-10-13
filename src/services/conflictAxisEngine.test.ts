import { describe, expect, it } from 'vitest';
import { createDefaultConflictAxes, summarizeConflictAxes } from './conflictAxisEngine';

describe('conflictAxisEngine', () => {
  it('does not summarize neutral conflict axes as the negative pole', () => {
    const axes = createDefaultConflictAxes({
      topic: '',
      style: 'free',
      dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    });

    expect(summarizeConflictAxes(axes)).toBe('');
  });

  it('does not infer expression or method from permissions and room style', () => {
    const axes = createDefaultConflictAxes({
      topic: '',
      style: 'brainstorm',
      dramaRules: { allowCliques: true, allowMockery: true, allowAlliances: true, allowContempt: true },
    });
    expect(axes.every((axis) => axis.currentTilt === 0)).toBe(true);
    expect(summarizeConflictAxes(axes)).toBe('');
  });
});
