import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import { normalizeConversation } from '../types/chat';
import { createTestChat } from '../test/fixtures';
import { projectGroupRelationshipGraphs } from './groupRelationshipGraph';

function member(id: string, relationships: AICharacter['relationships'] = []): AICharacter {
  return { id, name: id, avatar: '', relationships, deletedAt: null } as AICharacter;
}

function chat() {
  return createTestChat({
    id: 'group', name: '群', memberIds: ['a', 'b', 'c', 'd'],
  });
}

describe('group relationship graph projection', () => {
  it('keeps unrelated members outside relationship graph components', () => {
    const projection = projectGroupRelationshipGraphs(chat(), [
      member('a', [{ characterId: 'b', warmth: 22, competence: 0, trust: 8, threat: 0 }]),
      member('b'),
      member('c', [{ characterId: 'd', warmth: -8, competence: 0, trust: -14, threat: 20 }]),
      member('d'),
    ]);
    expect(projection.graphs).toHaveLength(2);
    expect(projection.graphs.map((graph) => graph.nodes.map((node) => node.id).sort())).toEqual([['a', 'b'], ['c', 'd']]);
    expect(projection.unconnectedMembers).toEqual([]);
  });

  it('uses the global character relationship over a stale room ledger entry', () => {
    const room = normalizeConversation({
      ...chat(),
      relationshipLedger: [{ pairKey: 'a->b', actorId: 'a', targetId: 'b', current: { warmth: -18, competence: 0, trust: -12, threat: 24, attachment: 0, deference: 0 }, trend: 'down', recentEvents: [], lastUpdatedAt: 2 }],
    });
    const projection = projectGroupRelationshipGraphs(room, [
      member('a', [{ characterId: 'b', warmth: 30, competence: 0, trust: 30, threat: 0 }]),
      member('b'), member('c'), member('d'),
    ]);
    expect(projection.graphs[0]?.edges[0]).toMatchObject({ source: 'default', fromId: 'a', toId: 'b', axes: { warmth: 30, threat: 0 } });
    expect(projection.unconnectedMembers.map((node) => node.id)).toEqual(['c', 'd']);
  });

  it('does not project deprecated directional structure as a public fact', () => {
    const room = normalizeConversation({
      ...chat(),
      relationshipStructure: {
        version: 1,
        updatedAt: 3,
        edges: [{ id: 'authority-a-b', fromId: 'a', toId: 'b', kind: 'authority', statement: '甲是乙的直属上司', confidence: 0.92, evidence: '角色身份明确', updatedAt: 3 }],
      },
    });
    const projection = projectGroupRelationshipGraphs(room, [member('a'), member('b'), member('c'), member('d')]);
    expect(projection.sharedFacts).toEqual([]);
    expect(projection.graphs).toEqual([]);
    expect(projection.unconnectedMembers.map((node) => node.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps directional attitudes separate from public relationship facts', () => {
    const room = normalizeConversation({
      ...chat(),
      relationshipStructure: {
        version: 1,
        updatedAt: 3,
        edges: [{ id: 'authority-a-b', fromId: 'a', toId: 'b', kind: 'authority', statement: '甲是乙的直属上司', confidence: 0.92, evidence: '角色身份明确', updatedAt: 3 }],
      },
    });
    const projection = projectGroupRelationshipGraphs(room, [
      member('a', [{ characterId: 'b', warmth: 10, competence: 0, trust: 0, threat: 0 }]),
      member('b', [{ characterId: 'a', warmth: 0, competence: 15, trust: 0, threat: 0 }]), member('c'), member('d'),
    ]);
    expect(projection.graphs[0]?.edges.find((edge) => edge.key === 'a->b')?.note).toBeUndefined();
    expect(projection.graphs[0]?.edges.find((edge) => edge.key === 'b->a')?.note).toBeUndefined();
    expect(projection.sharedFacts).toEqual([]);
  });

  it('projects shared structure facts without turning them into a directional attitude', () => {
    const room = normalizeConversation({
      ...chat(),
      relationshipStructure: {
        version: 1,
        updatedAt: 3,
        edges: [],
        sharedFacts: [{ id: 'siblings-a-b', memberIds: ['a', 'b'], kind: 'kinship', kinds: ['kinship', 'affiliation', 'duty'], statement: '甲乙搭档多年，情同手足，共同负责夜巡。', confidence: 0.92, evidence: '设定明确', updatedAt: 3 }],
      },
    });
    const projection = projectGroupRelationshipGraphs(room, [member('a'), member('b'), member('c'), member('d')]);
    expect(projection.sharedFacts).toMatchObject([{ kind: 'kinship', kinds: ['kinship', 'affiliation', 'duty'], statement: '甲乙搭档多年，情同手足，共同负责夜巡。' }]);
    expect(projection.graphs[0]?.edges[0]).toMatchObject({ axes: { warmth: 0, trust: 0 } });
    expect(projection.unconnectedMembers.map((node) => node.id)).toEqual(['c', 'd']);
  });

  it('keeps each directional attitude on its own edge', () => {
    const projection = projectGroupRelationshipGraphs(chat(), [
      member('a', [{ characterId: 'b', warmth: 18, competence: 0, trust: 4, threat: 0, note: '甲认可乙的能力，但不愿让步' }]),
      member('b', [{ characterId: 'a', warmth: -4, competence: 0, trust: -12, threat: 16, note: '乙防着甲翻旧账' }]),
      member('c'), member('d'),
    ]);
    expect(projection.graphs[0]?.edges.find((edge) => edge.key === 'a->b')?.note).toBe('甲认可乙的能力，但不愿让步');
    expect(projection.graphs[0]?.edges.find((edge) => edge.key === 'b->a')?.note).toBe('乙防着甲翻旧账');
    expect(projection.sharedFacts).toEqual([]);
  });

});
