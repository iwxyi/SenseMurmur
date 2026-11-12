import { describe, expect, it } from 'vitest';
import type { AssistantArtifactItem } from '../types/assistantArtifact';
import { applyAssistantArtifactDataOperation, getAssistantArtifactDataPreview, summarizeAssistantArtifactData } from './assistantArtifactData';

function table(content: string): AssistantArtifactItem {
  return {
    id: 'words',
    chatId: 'chat-a',
    kind: 'table',
    title: '英语单词背诵记录',
    currentVersionId: 'v1',
    sourceMessageId: 'm1',
    createdAt: 1,
    updatedAt: 1,
    versions: [{ id: 'v1', artifactId: 'words', content, sourceMessageId: 'm1', createdAt: 1 }],
  };
}

describe('assistant artifact data operations', () => {
  it('previews and edits Markdown tables while retaining their syntax and previous version', () => {
    const original = table('| 名称 | 值 |\n| --- | --- |\n| A | 1 |');
    const item = { ...original, language: 'markdown' };
    expect(getAssistantArtifactDataPreview(item)).toMatchObject({ columns: ['名称', '值'], totalRows: 1, rows: [{ 名称: 'A', 值: '1' }] });
    const updated = applyAssistantArtifactDataOperation(item, { kind: 'update', artifactId: item.id, values: { 值: '2|3' } }, 2);
    expect(updated.result.error).toBeUndefined();
    expect(updated.item.versions[0].content).toBe(original.versions[0].content);
    expect(getAssistantArtifactDataPreview(updated.item)).toMatchObject({ rows: [{ 名称: 'A', 值: '2|3' }] });
  });
  it('keeps tab separators when updating a TSV artifact', () => {
    const item = { ...table('name\tvalue\nA\t1'), language: 'tsv' };
    const updated = applyAssistantArtifactDataOperation(item, { kind: 'update', artifactId: item.id, values: { value: 2 } }, 2);
    expect(updated.item.versions.at(-1)?.content).toBe('name\tvalue\nA\t2');
    expect(getAssistantArtifactDataPreview(updated.item)).toMatchObject({ columns: ['name', 'value'], rows: [{ name: 'A', value: '2' }] });
  });
  it('reports invalid CSV without silently discarding excess values', () => {
    const item = table('name,value\nA,1,hidden');
    expect(summarizeAssistantArtifactData(item)).toMatchObject({ parseError: true });
    expect(getAssistantArtifactDataPreview(item)).toBeNull();
    const result = applyAssistantArtifactDataOperation(item, { kind: 'update', artifactId: item.id, values: { value: 2 } }, 2);
    expect(result.result.error).toContain('表格格式无效');
    expect(result.item).toBe(item);
  });
  it('summarizes CSV schema without returning the full file', () => {
    const summary = summarizeAssistantArtifactData(table('word,lastReviewed,reviewCount\nserendipity,2026-07-01,3\n'));
    expect(summary).toMatchObject({ format: 'csv', rowCount: 1, columns: ['word', 'lastReviewed', 'reviewCount'] });
    expect(summary?.sampleRows).toEqual([{ word: 'serendipity', lastReviewed: '2026-07-01', reviewCount: '3' }]);
  });

  it('supports numeric and date conditions with a capped query result', () => {
    const rows = Array.from({ length: 105 }, (_, index) => `word-${index},2026-06-01,${index}`).join('\n');
    const applied = applyAssistantArtifactDataOperation(table(`word,lastReviewed,reviewCount\n${rows}`), {
      kind: 'query', artifactId: 'words', filter: [
        { field: 'lastReviewed', operator: 'lt', value: '2026-07-01' },
        { field: 'reviewCount', operator: 'lt', value: 10 },
      ], limit: 300,
    }, 2);
    expect(applied.result.totalRows).toBe(10);
    expect(applied.result.rows).toHaveLength(10);
    expect(applied.result.truncated).toBe(false);
  });

  it('creates a new version for update and preserves CSV columns', () => {
    const applied = applyAssistantArtifactDataOperation(table('word,reviewCount\nhello,1\n'), {
      kind: 'update', artifactId: 'words', baseVersionId: 'v1',
      filter: [{ field: 'word', value: 'hello' }], values: { reviewCount: 2 },
    }, 2);
    expect(applied.result.affectedRows).toBe(1);
    expect(applied.item.versions).toHaveLength(2);
    expect(applied.item.currentVersionId).not.toBe('v1');
    expect(applied.item.versions.at(-1)?.content).toContain('hello,2');
  });

  it('marks JSON query results as JSON for the chat renderer', () => {
    const item = { ...table('[{"id":1,"value":"a"}]'), kind: 'json' as const };
    const applied = applyAssistantArtifactDataOperation(item, { kind: 'query', artifactId: 'words' }, 2);
    expect(applied.result.format).toBe('json');
    expect(applied.result.columns).toEqual(['id', 'value']);
  });

  it('supports nested JSON paths and grouped AND/OR/NOT filters', () => {
    const item = { ...table(JSON.stringify([
      { id: 1, profile: { name: '张三' }, score: 75 },
      { id: 2, profile: { name: '李四' }, score: 65 },
      { id: 3, score: 55 },
    ])), kind: 'json' as const };
    const applied = applyAssistantArtifactDataOperation(item, {
      kind: 'query',
      artifactId: 'words',
      filter: [{ all: [
        { any: [
          { field: 'profile.name', operator: 'eq', value: '张三' },
          { field: 'score', operator: 'gte', value: 70 },
        ] },
        { not: { field: 'profile.name', operator: 'eq', value: '李四' } },
      ] }],
    }, 2);
    expect(applied.result.totalRows).toBe(1);
    expect(applied.result.rows?.[0]).toMatchObject({ id: 1, score: 75 });
  });

  it('supports exists and null checks', () => {
    const item = { ...table(JSON.stringify([
      { id: 1, note: null },
      { id: 2, note: 'ok' },
      { id: 3 },
    ])), kind: 'json' as const };
    const applied = applyAssistantArtifactDataOperation(item, {
      kind: 'query', artifactId: 'words', filter: [
        { field: 'note', operator: 'isNull' },
      ],
    }, 2);
    expect(applied.result.rows?.map((row) => row.id)).toEqual([1]);
    const missing = applyAssistantArtifactDataOperation(item, {
      kind: 'query', artifactId: 'words', filter: [
        { field: 'note', operator: 'notExists' },
      ],
    }, 2);
    expect(missing.result.rows?.map((row) => row.id)).toEqual([3]);
  });

  it('returns the complete data preview when requested by fullscreen', () => {
    const content = ['id,name', ...Array.from({ length: 25 }, (_, index) => `${index},row-${index}`)].join('\n');
    const preview = getAssistantArtifactDataPreview(table(content), Number.POSITIVE_INFINITY);
    expect(preview?.rows).toHaveLength(25);
    expect(preview?.truncated).toBe(false);
  });
});
