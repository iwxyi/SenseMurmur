import { describe, expect, it } from 'vitest';
import { collapseMergedFacts, parseDetailedFacts, type FactMergeCandidate } from './factualMemoryTypes';

describe('parseDetailedFacts', () => {
  it.each([
    [{ text: '', status: 'agreed', sourceIds: ['m1'] }, 'facts[0].text'],
    [{ text: '事实', status: 'established', sourceIds: ['m1'] }, 'facts[0].status'],
    [{ text: '事实', status: 'agreed', sourceIds: [] }, 'facts[0].sourceIds'],
    [{ text: '事实', status: 'agreed', sourceIds: ['missing'] }, 'facts[0].sourceIds[0]'],
  ])('identifies the invalid field without exposing private fact text', (fact, field) => {
    expect(() => parseDetailedFacts(JSON.stringify({ facts: [fact] }), new Set(['m1']), 'm1')).toThrow(String(field));
  });

  it('preserves the exact code with every cited source and the confirming message', () => {
    const parsed = parseDetailedFacts(JSON.stringify({ facts: [{
      text: '三人约定暗号为“青梅煮酒”', status: 'agreed', sourceIds: ['m1', 'm2', 'm3'],
    }] }), new Set(['m1', 'm2', 'm3']), 'm3');
    expect(parsed[0]).toEqual({ text: '三人约定暗号为“青梅煮酒”', status: 'agreed', sourceIds: ['m1', 'm2', 'm3'] });
  });

  it('rejects facts that cite an unknown source or omit the new message', () => {
    expect(() => parseDetailedFacts(JSON.stringify({ facts: [{ text: '事实', status: 'asserted', sourceIds: ['missing'] }] }), new Set(['m1']), 'm1'))
      .toThrow('MEMORY_FACT_INVALID');
    expect(() => parseDetailedFacts(JSON.stringify({ facts: [{ text: '事实', status: 'asserted', sourceIds: ['m1'] }] }), new Set(['m1']), 'm2'))
      .toThrow('MEMORY_FACT_INVALID');
  });

  it('merges only supplied records while retaining their complete evidence and status', () => {
    const candidates = new Map<string, FactMergeCandidate>([['f0', { messageId: 'm1', factIndex: 0,
      fact: { text: '明日对账', status: 'agreed', sourceIds: ['m1'] } }]]);
    const fact = { text: '明日对账，由关羽核对', status: 'agreed', sourceIds: ['m1', 'm2'], mergeWith: ['f0'] };
    const parse = (value: unknown) => parseDetailedFacts(JSON.stringify({ facts: [value] }), new Set(['m1', 'm2']), 'm2', undefined, candidates);
    expect(parse(fact)[0]).toEqual({ text: fact.text, status: fact.status, sourceIds: fact.sourceIds,
      mergedFrom: [{ messageId: 'm1', factIndex: 0 }] });
    expect(() => parse({ ...fact, mergeWith: ['invented'] })).toThrow('mergeWith');
    expect(() => parse({ ...fact, sourceIds: ['m2'] })).toThrow('mergeWith');
    expect(() => parse({ ...fact, status: 'disputed' })).toThrow('mergeWith');
  });

  it('collapses successive merges without hiding records in a different chat', () => {
    const items = [
      { id: 'm1:0', chatId: 'a' }, { id: 'm1:0', chatId: 'b' },
      { id: 'm2:0', chatId: 'a', mergedFrom: [{ messageId: 'm1', factIndex: 0 }] },
      { id: 'm3:0', chatId: 'a', mergedFrom: [{ messageId: 'm2', factIndex: 0 }] },
    ];
    expect(collapseMergedFacts(items).map((item) => [item.chatId, item.id])).toEqual([['b', 'm1:0'], ['a', 'm3:0']]);
  });

  it('requires a real target and evidence for retractions and suppresses their replaced records', () => {
    const candidates = new Map<string, FactMergeCandidate>([['f0', { messageId: 'm1', factIndex: 0,
      fact: { text: '误记的约定', status: 'agreed', sourceIds: ['m1'] } }]]);
    const fact = { text: '原话只是演练台词，原记录作废', status: 'agreed', sourceIds: ['m1', 'm2'], mergeWith: ['f0'], retracted: true };
    const parse = (value: unknown) => parseDetailedFacts(JSON.stringify({ facts: [value] }), new Set(['m1', 'm2']), 'm2', undefined, candidates);
    expect(parse(fact)[0].retracted).toBe(true);
    expect(() => parse({ ...fact, mergeWith: [] })).toThrow('mergeWith');
    expect(() => parse({ ...fact, sourceIds: ['m2'] })).toThrow('mergeWith');
    expect(() => parse({ ...fact, retracted: 'yes' })).toThrow('retracted');
    expect(collapseMergedFacts([{ id: 'm1:0', chatId: 'a' },
      { id: 'm2:0', chatId: 'a', retracted: true, mergedFrom: [{ messageId: 'm1', factIndex: 0 }] }])).toEqual([]);
  });
});
