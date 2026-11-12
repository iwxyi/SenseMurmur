import { describe, expect, it } from 'vitest';
import { matchesTeamJsonSchema, parseTeamJsonSchema } from './agentTeamJsonSchema';

const schema = { type: 'object', properties: {
  title: { type: 'string', minLength: 1 },
  scores: { type: 'array', items: { type: 'number', minimum: 0, maximum: 10 }, minItems: 1 },
  status: { enum: ['ready', 'draft'] },
}, required: ['title', 'scores'], additionalProperties: false };

describe('team JSON field contracts', () => {
  it('validates nested types, required fields, bounds and extra properties without altering output', () => {
    const value = { title: '报告', scores: [8, 9], status: 'ready' };
    expect(matchesTeamJsonSchema(schema, value)).toBe(true);
    expect(value).toEqual({ title: '报告', scores: [8, 9], status: 'ready' });
    for (const bad of [{ scores: [8] }, { title: '', scores: [8] }, { title: '报告', scores: ['8'] },
      { title: '报告', scores: [11] }, { title: '报告', scores: [] }, { title: '报告', scores: [8], extra: 1 },
      { title: '报告', scores: [8], status: 'unknown' }]) expect(matchesTeamJsonSchema(schema, bad)).toBe(false);
  });
  it('supports boolean schemas, nullable types and alternatives', () => {
    expect(matchesTeamJsonSchema(false, null)).toBe(false);
    expect(matchesTeamJsonSchema(true, null)).toBe(true);
    const choice = { anyOf: [{ type: 'null' }, { type: 'string', minLength: 3 }] };
    expect(matchesTeamJsonSchema(choice, null)).toBe(true);
    expect(matchesTeamJsonSchema(choice, 'abc')).toBe(true);
    expect(matchesTeamJsonSchema(choice, 'a')).toBe(false);
  });
  it.each([{ $ref: 'https://example.invalid/schema' }, { type: 'string', pattern: '(a+)+' },
    { type: 'string', format: 'email' }, { type: 'unknown' }, { type: 'object', required: 'title' },
    { type: 'array', items: [{ type: 'string' }] }, { unknownKeyword: true }])('rejects unsupported or malformed contracts before execution: %j', (value) => {
    expect(() => parseTeamJsonSchema(value)).toThrow('契约');
  });
  it('bounds complexity and returns an independent JSON value', () => {
    expect(() => parseTeamJsonSchema({ description: 'x'.repeat(16_001) })).toThrow('过大');
    const nested = (depth: number): object => depth ? { type: 'array', items: nested(depth - 1) } : { type: 'string' };
    expect(() => parseTeamJsonSchema(nested(13))).toThrow('复杂');
    const copy = parseTeamJsonSchema(schema);
    expect(copy).toEqual(schema);
    expect(copy).not.toBe(schema);
  });
});
