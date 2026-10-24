import { describe, expect, it } from 'vitest';
import { collapseMergedFacts, parseDetailedFacts, type FactMergeCandidate } from './factualMemoryTypes';

describe('parseDetailedFacts', () => {
  it('preserves a title and complete grouped details with their earlier evidence', () => {
    const fact = { title: '关羽的支用与拜帖礼账目', text: '支用：盘缠十五贯、草料九贯、关隘打点四贯，共二十八贯；礼数：绢四匹、茶两担，折十二贯。分列核账。',
      status: 'asserted', sourceIds: ['m1', 'm2'] };
    expect(parseDetailedFacts(JSON.stringify({ facts: [fact] }), new Set(['m1', 'm2']), 'm2')).toEqual([fact]);
    expect(() => parseDetailedFacts(JSON.stringify({ facts: [{ ...fact, title: '' }] }), new Set(['m1', 'm2']), 'm2')).toThrow('title');
  });
  it('deleting a merged fact hides stale copies without resurrecting replaced versions', () => {
    expect(collapseMergedFacts([
      { id: 'm1:0', chatId: 'a' },
      { id: 'm2:0', chatId: 'a', mergedFrom: [{ messageId: 'm1', factIndex: 0 }] },
      { id: 'm2:0', chatId: 'a', userDeleted: true, mergedFrom: [{ messageId: 'm1', factIndex: 0 }] },
    ])).toEqual([]);
  });
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
    expect(() => parse({ ...fact, mergeWith: ['invented'] })).toThrow('available refs: f0');
    expect(parse({ ...fact, sourceIds: ['m2'] })[0].sourceIds).toEqual(['m2', 'm1']);
    expect(() => parse({ ...fact, status: 'disputed' })).toThrow('has status agreed, received disputed');
  });

  it('inherits deduplicated evidence from multiple references without dropping evidence to fit the limit', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `m${index}`);
    const candidates = new Map<string, FactMergeCandidate>([
      ['f0', { messageId: 'm0', factIndex: 0, fact: { text: '旧事实', status: 'agreed', sourceIds: ids.slice(0, 6) } }],
      ['f1', { messageId: 'm5', factIndex: 0, fact: { text: '相关事实', status: 'agreed', sourceIds: ids.slice(5) } }],
    ]);
    const fact = { text: '完整事项', status: 'agreed', sourceIds: ['new'], mergeWith: ['f0', 'f0'] };
    const parse = (value: unknown) => parseDetailedFacts(JSON.stringify({ facts: [value] }), new Set([...ids, 'new']), 'new', undefined, candidates);
    expect(parse(fact)[0].sourceIds).toEqual(['new', ...ids.slice(0, 6)]);
    expect(parse(fact)[0].mergedFrom).toHaveLength(1);
    expect(() => parse({ ...fact, mergeWith: ['f0', 'f1'] })).toThrow('merged evidence contains 13 messages');
    expect(() => parseDetailedFacts(JSON.stringify({ facts: [fact] }), new Set(['new']), 'new', undefined, candidates))
      .toThrow('evidence outside the supplied messages');
    candidates.get('f0')!.fact.retracted = true;
    expect(() => parse(fact)).toThrow('is retracted');
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
    expect(parse({ ...fact, sourceIds: ['m2'] })[0].sourceIds).toEqual(['m2', 'm1']);
    expect(() => parse({ ...fact, sourceIds: ['m1'] })).toThrow('must include newMessageId');
    expect(() => parse({ ...fact, retracted: 'yes' })).toThrow('retracted');
    expect(collapseMergedFacts([{ id: 'm1:0', chatId: 'a' },
      { id: 'm2:0', chatId: 'a', retracted: true, mergedFrom: [{ messageId: 'm1', factIndex: 0 }] }])).toEqual([]);
  });
});
