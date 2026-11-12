import { describe, expect, it } from 'vitest';
import { parseAssistantTable, stringifyAssistantTable } from './assistantArtifactTable';

describe('artifact table syntax', () => {
  it('parses quoted separators, escaped quotes and multiline cells without losing rows', () => {
    expect(parseAssistantTable('\uFEFFname,note\r\nA,"first, line\r\nsecond ""quoted"" line"\r\nB,\r\n')).toMatchObject({
      syntax: 'csv', columns: ['name', 'note'], rows: [{ name: 'A', note: 'first, line\r\nsecond "quoted" line' }, { name: 'B', note: '' }],
    });
  });
  it.each(['a,b\n1', 'a,b\n1,2,3', 'a,b\n"unterminated,2', 'a,a\n1,2', ',b\n1,2'])('rejects ambiguous or damaged data: %s', (content) => {
    expect(() => parseAssistantTable(content)).toThrow();
  });
  it('parses Markdown with formatting and escaped pipes as data, excluding its divider row', () => {
    const content = '| **项目** | 值 |\n| --- | --- |\n| A\\|B | [来源](https://example.org) |';
    expect(parseAssistantTable(content)).toMatchObject({ syntax: 'markdown', columns: ['项目', '值'], rows: [{ 项目: 'A|B', 值: '来源' }] });
    expect(() => parseAssistantTable(content, 'csv')).toThrow('不一致');
    expect(() => parseAssistantTable(`说明\n\n${content}`, 'markdown')).toThrow('完整的 Markdown');
  });
  it.each(['csv', 'tsv', 'markdown'] as const)('preserves %s syntax and cell values after edits', (syntax) => {
    const columns = ['名称', '值'];
    const rows = [{ 名称: 'A|B', 值: '带有,逗号和"引号"' }];
    const serialized = stringifyAssistantTable(columns, rows, syntax);
    expect(parseAssistantTable(serialized, syntax)).toEqual({ syntax, columns, rows });
  });
  it('round trips multiline CSV edits and refuses unrepresentable Markdown newlines', () => {
    const rows = [{ note: '一行\n另一行' }];
    expect(parseAssistantTable(stringifyAssistantTable(['note'], rows, 'csv')).rows).toEqual(rows);
    expect(() => stringifyAssistantTable(['note'], rows, 'markdown')).toThrow('暂不支持换行');
  });
});
