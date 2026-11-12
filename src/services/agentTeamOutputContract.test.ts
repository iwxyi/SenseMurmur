import { describe, expect, it } from 'vitest';
import type { AgentTeamTask } from './agentTeamPlan';
import { teamOutputInstruction, validateTeamOutput } from './agentTeamOutputContract';

const task: AgentTeamTask = { id: 'data', roleId: 'writer', goal: '结果', acceptance: '可解析', dependsOn: [],
  deliverable: { schemaVersion: 1, kind: 'json', title: '结果' } };

describe('team output contract', () => {
  it('validates the same table syntax used by artifact previews', () => {
    const tableTask: AgentTeamTask = { ...task, deliverable: { kind: 'table', title: '数据', language: 'csv' } };
    expect(validateTeamOutput(tableTask, '```csv\na,b\n1,"two\nlines"\n```')).toBe('a,b\n1,"two\nlines"');
    expect(() => validateTeamOutput(tableTask, 'a,b\n1,2,3')).toThrow('表格无法解析');
    expect(() => validateTeamOutput(tableTask, 'a,a\n1,2')).toThrow('表格无法解析');
    const markdown = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(validateTeamOutput({ ...tableTask, deliverable: { kind: 'table', title: '数据' } }, markdown)).toBe(markdown);
    expect(() => validateTeamOutput(tableTask, markdown)).toThrow('表格无法解析');
  });
  it.each(['{"items":[1,2]}', '[true,null]', '0', 'false', 'null', '"文本"'])('accepts JSON without changing its value: %s', (value) => {
    expect(validateTeamOutput(task, ` ${value} `)).toBe(value);
  });
  it('unwraps a single JSON code block without extracting JSON from narrative', () => {
    expect(validateTeamOutput(task, '```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(validateTeamOutput(task, '```\n[1]\n```')).toBe('[1]');
  });
  it.each(['说明\n{"ok":true}', '{"ok":true}\n说明', '{} {}', '{"private":"sensitive",}',
    '```json\n{}\n```\n\n备注', '```javascript\n{}\n```', '```json extra\n{}\n```'])('rejects an invalid complete delivery: %s', (value) => {
    expect(() => validateTeamOutput(task, value)).toThrow('要求合法 JSON');
    try { validateTeamOutput(task, value); } catch (error) { expect(String(error)).not.toContain('sensitive'); }
  });
  it('does not claim syntax or semantic validation for other artifact types', () => {
    const plain = { ...task, deliverable: undefined };
    expect(teamOutputInstruction(plain)).toBe('');
    expect(validateTeamOutput(plain, '  正文  ')).toBe('正文');
    expect(() => validateTeamOutput(plain, ' ')).toThrow('未提交内容');
    expect(teamOutputInstruction(task)).toContain('合法 JSON');
  });
});
