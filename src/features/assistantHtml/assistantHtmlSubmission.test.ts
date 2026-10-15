import { describe, expect, it } from 'vitest';
import { normalizeAssistantHtmlRuntime } from './assistantHtmlValidation';
import { formatAssistantHtmlSubmission } from './assistantHtmlSubmission';

const manifest = normalizeAssistantHtmlRuntime({ submission: {
  interactionId: 'conversion',
  fields: [
    { name: 'amount', label: '金额', type: 'number', required: true },
    { name: 'currency', label: '目标币种', type: 'single_choice', options: ['日元', '美元'] },
    { name: 'confirm', label: '确认', type: 'boolean' },
    { name: 'internal_field', type: 'text' },
  ],
} })!;

describe('HTML submission message', () => {
  it('formats validated fields using user labels without exposing protocol keys', () => {
    const text = formatAssistantHtmlSubmission('汇率换算', manifest, { amount: '100', currency: '日元', confirm: false });
    expect(text).toBe('已提交「汇率换算」：\n金额：100\n目标币种：日元\n确认：否\n第 4 项：未填写');
    expect(text).not.toContain('internal_field');
    expect(text).not.toContain('conversion');
  });

  it('rejects undeclared fields and invalid values before formatting', () => {
    expect(() => formatAssistantHtmlSubmission('换算', manifest, { amount: 100, injected: 'x' })).toThrow('未知字段');
    expect(() => formatAssistantHtmlSubmission('换算', manifest, { amount: 'abc' })).toThrow('必须是数字');
  });
});
