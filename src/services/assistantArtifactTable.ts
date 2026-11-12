import { parse } from 'csv-parse/browser/esm/sync';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { toString } from 'mdast-util-to-string';
import type { Root } from 'mdast';

export type AssistantTableSyntax = 'csv' | 'tsv' | 'markdown';

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);

export function parseAssistantTable(content: string, language?: string | null) {
  const declared = language?.trim().toLowerCase();
  const tree = markdown.parse(content);
  const table = tree.children.length === 1 && tree.children[0].type === 'table' ? tree.children[0] : null;
  const syntax: AssistantTableSyntax = declared === 'markdown' || declared === 'md' || (!declared && table) ? 'markdown'
    : declared === 'tsv' ? 'tsv' : 'csv';
  if (table && syntax !== 'markdown') throw new Error('返回了 Markdown 表格，与声明的分隔符格式不一致');
  let records: string[][];
  if (syntax === 'markdown') {
    if (!table) throw new Error('表格必须是完整的 Markdown 表格');
    records = table.children.map((row) => row.children.map((cell) => toString(cell)));
  } else {
    try {
      const parsed: unknown = parse(content, { bom: true, delimiter: syntax === 'tsv' ? '\t' : ',', skip_empty_lines: true });
      if (!Array.isArray(parsed) || !parsed.every((row: unknown) => Array.isArray(row) && row.every((cell: unknown) => typeof cell === 'string'))) {
        throw new Error('Invalid table records');
      }
      records = parsed as string[][];
    } catch {
      throw new Error('表格格式无效，请检查分隔符、引号及每行列数');
    }
  }
  if (!records.length) return { syntax, columns: [] as string[], rows: [] as Array<Record<string, unknown>> };
  const columns = records[0].map((column) => column.trim());
  if (columns.some((column) => !column) || new Set(columns).size !== columns.length) throw new Error('表格列名不能为空或重复');
  if (records.some((row) => row.length !== columns.length)) throw new Error('表格每行列数必须一致');
  const rows = records.slice(1).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  return { syntax, columns, rows };
}

export function stringifyAssistantTable(columns: string[], rows: Array<Record<string, unknown>>, syntax: AssistantTableSyntax) {
  const records = [columns, ...rows.map((row) => columns.map((column) => row[column] == null ? '' : String(row[column])))];
  if (syntax === 'markdown') {
    if (records.some((row) => row.some((value) => /[\r\n]/.test(value)))) throw new Error('Markdown 表格单元格暂不支持换行，请使用 CSV');
    const tree: Root = { type: 'root', children: [{ type: 'table', children: records.map((row) => ({
      type: 'tableRow', children: row.map((value) => ({ type: 'tableCell', children: [{ type: 'text', value }] })),
    })) }] };
    return markdown.stringify(tree);
  }
  const separator = syntax === 'tsv' ? '\t' : ',';
  return records.map((row) => row.map((text) => text.includes(separator) || /["\n\r]/.test(text)
    ? `"${text.replace(/"/g, '""')}"` : text).join(separator)).join('\n');
}
