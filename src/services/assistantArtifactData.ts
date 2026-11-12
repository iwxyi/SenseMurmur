import type { AssistantArtifactDataOperation, AssistantArtifactDataResult, AssistantArtifactItem, AssistantArtifactVersion, AssistantDataFilter } from '../types/assistantArtifact';
import { parseAssistantTable, stringifyAssistantTable } from './assistantArtifactTable';
export type AssistantDataFormat = 'csv' | 'json';

const MAX_RESULT_ROWS = 100;

export interface AssistantArtifactDataPreview {
  format: AssistantDataFormat;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  totalRows: number;
  truncated: boolean;
  omittedRows: number;
}

function parseJsonRecords(content: string) {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) {
    return { container: 'array' as const, rows: parsed.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row))) };
  }
  if (parsed && typeof parsed === 'object') return { container: 'object' as const, rows: [parsed as Record<string, unknown>] };
  throw new Error('JSON 必须是对象或对象数组');
}

function getFieldValue(row: Record<string, unknown>, field: string) {
  if (field in row) return { exists: true, value: row[field] };
  const parts = field.split('.').filter(Boolean);
  if (!parts.length) return { exists: false, value: undefined };
  let current: unknown = row;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) return { exists: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

function matchesFilter(row: Record<string, unknown>, filter: AssistantDataFilter): boolean {
  if ('all' in filter) return filter.all.every((entry) => matchesFilter(row, entry));
  if ('any' in filter) return filter.any.some((entry) => matchesFilter(row, entry));
  if ('not' in filter) return !matchesFilter(row, filter.not);
  const field = getFieldValue(row, filter.field);
  const actual = field.value;
  const expected = filter.value;
  const operator = filter.operator || 'eq';
  if (operator === 'exists') return field.exists;
  if (operator === 'notExists') return !field.exists;
  if (operator === 'isNull') return field.exists && (actual === null || actual === undefined);
  if (operator === 'isNotNull') return field.exists && actual !== null && actual !== undefined;
  if (operator === 'contains') return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
  if (operator === 'startsWith') return String(actual ?? '').toLowerCase().startsWith(String(expected ?? '').toLowerCase());
  if (operator === 'endsWith') return String(actual ?? '').toLowerCase().endsWith(String(expected ?? '').toLowerCase());
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  const actualDate = Date.parse(String(actual ?? ''));
  const expectedDate = Date.parse(String(expected ?? ''));
  const left = Number.isFinite(actualNumber) && Number.isFinite(expectedNumber) ? actualNumber : actualDate;
  const right = Number.isFinite(actualNumber) && Number.isFinite(expectedNumber) ? expectedNumber : expectedDate;
  if (operator === 'gt') return Number.isFinite(left) && Number.isFinite(right) && left > right;
  if (operator === 'gte') return Number.isFinite(left) && Number.isFinite(right) && left >= right;
  if (operator === 'lt') return Number.isFinite(left) && Number.isFinite(right) && left < right;
  if (operator === 'lte') return Number.isFinite(left) && Number.isFinite(right) && left <= right;
  return String(actual ?? '') === String(expected ?? '');
}

function matches(row: Record<string, unknown>, filters: AssistantDataFilter[] = []) {
  return filters.every((filter) => matchesFilter(row, filter));
}

function resolveContent(version: AssistantArtifactVersion, filePath?: string | null) {
  if (filePath) {
    const file = version.files?.find((entry) => entry.path === filePath);
    if (!file) throw new Error(`找不到文件: ${filePath}`);
    return { content: file.content, filePath };
  }
  if (version.files?.length === 1) return { content: version.files[0].content, filePath: version.files[0].path };
  if (version.files?.length) throw new Error('多文件产物必须指定 filePath');
  return { content: version.content, filePath: null };
}

export function summarizeAssistantArtifactData(item: AssistantArtifactItem) {
  const version = item.versions.find((entry) => entry.id === item.currentVersionId) || item.versions.at(-1);
  if (!version) return null;
  try {
    const format: AssistantDataFormat = item.kind === 'json' || /\.json$/i.test(version.files?.[0]?.path || '') ? 'json' : 'csv';
    const source = resolveContent(version, version.files?.length === 1 ? version.files[0].path : null).content;
    const parsed = format === 'csv' ? parseAssistantTable(source, version.language ?? item.language) : parseJsonRecords(source);
    const rows = parsed.rows;
    const columns = format === 'csv' && 'columns' in parsed ? parsed.columns : Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    return { format, rowCount: rows.length, columns: columns.slice(0, 80), sampleRows: rows.slice(0, 5), sizeBytes: source.length };
  } catch {
    return { format: item.kind === 'json' ? 'json' : 'csv' as AssistantDataFormat, rowCount: 0, columns: [], sampleRows: [], sizeBytes: version.content.length, parseError: true };
  }
}

export function getAssistantArtifactDataPreview(item: AssistantArtifactItem, maxRows = 8, selectedVersion?: AssistantArtifactVersion | null, edgeRows = 0): AssistantArtifactDataPreview | null {
  const version = selectedVersion || item.versions.find((entry) => entry.id === item.currentVersionId) || item.versions.at(-1);
  if (!version) return null;
  try {
    const resolved = resolveContent(version, version.files?.length === 1 ? version.files[0].path : null);
    const format: AssistantDataFormat = item.kind === 'json' || /\.json$/i.test(resolved.filePath || '') ? 'json' : 'csv';
    const parsed = format === 'csv' ? parseAssistantTable(resolved.content, version.language ?? item.language) : parseJsonRecords(resolved.content);
    const rows = parsed.rows;
    const columns = format === 'csv' && 'columns' in parsed
      ? parsed.columns
      : Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    const showAll = !Number.isFinite(maxRows);
    const limit = showAll ? rows.length : Math.min(MAX_RESULT_ROWS, Math.max(1, Math.floor(maxRows)));
    const useEdgeRows = !showAll && edgeRows > 0 && rows.length > limit
      ? Math.min(edgeRows, Math.floor(limit / 2))
      : 0;
    const previewRows = useEdgeRows
      ? [...rows.slice(0, useEdgeRows), ...rows.slice(-useEdgeRows)]
      : rows.slice(0, limit);
    return {
      format,
      columns: showAll ? columns : columns.slice(0, 40),
      rows: previewRows,
      totalRows: rows.length,
      truncated: !showAll && rows.length > limit,
      omittedRows: Math.max(0, rows.length - previewRows.length),
    };
  } catch {
    return null;
  }
}

export function applyAssistantArtifactDataOperation(item: AssistantArtifactItem, operation: AssistantArtifactDataOperation, timestamp: number) {
  const version = item.versions.find((entry) => entry.id === item.currentVersionId) || item.versions.at(-1);
  if (!version) return { item, result: { operation: operation.kind, affectedRows: 0, error: '产物没有可用版本' } satisfies AssistantArtifactDataResult };
  try {
    const resolved = resolveContent(version, operation.filePath);
    const format: AssistantDataFormat = item.kind === 'json' || /\.json$/i.test(resolved.filePath || '') ? 'json' : 'csv';
    const parsed = format === 'csv' ? parseAssistantTable(resolved.content, version.language ?? item.language) : parseJsonRecords(resolved.content);
    let rows = [...parsed.rows];
    const matched = rows.filter((row) => matches(row, operation.filter));
    let affectedRows = 0;
    if (operation.kind === 'query') {
      const sorted = operation.sort ? [...matched].sort((left, right) => {
        const a = getFieldValue(left, operation.sort!.field).value;
        const b = getFieldValue(right, operation.sort!.field).value;
        const aNumber = Number(a);
        const bNumber = Number(b);
        const comparison = Number.isFinite(aNumber) && Number.isFinite(bNumber)
          ? aNumber - bNumber
          : String(a ?? '').localeCompare(String(b ?? ''), 'zh-CN', { numeric: true });
        return (operation.sort!.direction === 'desc' ? -1 : 1) * comparison;
      }) : matched;
      const offset = Math.max(0, Math.floor(operation.offset || 0));
      const limit = Math.min(MAX_RESULT_ROWS, Math.max(1, Math.floor(operation.limit || MAX_RESULT_ROWS)));
      const columns = format === 'csv' && 'columns' in parsed
        ? parsed.columns
        : Array.from(new Set(sorted.flatMap((row) => Object.keys(row))));
      return { item, result: { operation: 'query', affectedRows: 0, totalRows: sorted.length, rows: sorted.slice(offset, offset + limit), format, columns, truncated: sorted.length > offset + limit } satisfies AssistantArtifactDataResult };
    }
    if (operation.kind === 'add_column') {
      const column = operation.column?.trim();
      if (!column) throw new Error('add_column 缺少 column');
      if (format === 'json') throw new Error('JSON 不存在固定列；请使用 update 为记录增加字段');
      if ('columns' in parsed && parsed.columns.includes(column)) throw new Error(`列已存在: ${column}`);
      rows = rows.map((row) => ({ ...row, [column]: operation.defaultValue ?? '' }));
      affectedRows = rows.length;
    } else if (operation.kind === 'insert') {
      if (!operation.values) throw new Error('insert 缺少 values');
      rows.push({ ...operation.values });
      affectedRows = 1;
    } else if (operation.kind === 'update') {
      if (!operation.values) throw new Error('update 缺少 values');
      rows = rows.map((row) => matches(row, operation.filter) ? (affectedRows += 1, { ...row, ...operation.values }) : row);
    } else if (operation.kind === 'delete') {
      rows = rows.filter((row) => {
        const matchedRow = matches(row, operation.filter);
        if (matchedRow) affectedRows += 1;
        return !matchedRow;
      });
    }
    const columns = format === 'csv' && 'columns' in parsed ? Array.from(new Set([...parsed.columns, ...rows.flatMap((row) => Object.keys(row)), ...(operation.column ? [operation.column] : [])])) : [];
    const content = format === 'csv'
      ? stringifyAssistantTable(columns, rows, 'syntax' in parsed ? parsed.syntax : 'csv')
      : JSON.stringify('container' in parsed && parsed.container === 'array' ? rows : rows[0] || {}, null, 2);
    const nextVersion = { ...version, id: `${item.id}:data:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, baseVersionId: version.id, content: resolved.filePath ? version.content : content, files: resolved.filePath ? version.files?.map((file) => file.path === resolved.filePath ? { ...file, content } : file) : version.files, changeSummary: `${operation.kind} ${affectedRows} 行`, updatedAt: timestamp, createdAt: timestamp, revision: 1 } satisfies AssistantArtifactVersion;
    const nextItem = { ...item, currentVersionId: nextVersion.id, versions: [...item.versions, nextVersion].slice(-12), updatedAt: timestamp };
    return { item: nextItem, result: { operation: operation.kind, affectedRows } satisfies AssistantArtifactDataResult };
  } catch (error) {
    return { item, result: { operation: operation.kind, affectedRows: 0, error: error instanceof Error ? error.message : '数据操作失败' } satisfies AssistantArtifactDataResult };
  }
}
