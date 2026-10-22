import { describe, expect, it } from 'vitest';
import type { MemoryItem } from './memoryTypes';
import {
  buildLayeredMemoryFilters,
  buildLayeredMemoryGroups,
  filterVisibleLayeredMemories,
  getMemoryStrengthLabel,
  projectLayeredMemoryItem,
  selectLayeredMemoryItems,
} from './layeredMemoryPresentation';

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: overrides.id || 'mem-1',
    scope: overrides.scope || 'conversation',
    layer: overrides.layer || 'episodic',
    kind: overrides.kind || 'conflict',
    ownerId: overrides.ownerId || 'chat-1',
    text: overrides.text || '喜羊羊和沸羊羊的争执开始稳定影响群聊气氛。',
    salience: overrides.salience ?? 0.72,
    confidence: overrides.confidence ?? 0.75,
    recency: overrides.recency ?? 0.8,
    reinforcementCount: overrides.reinforcementCount ?? 1,
    sourceEventIds: overrides.sourceEventIds || ['evt-1'],
    createdAt: overrides.createdAt ?? 100,
    updatedAt: overrides.updatedAt ?? 100,
    ...overrides,
  };
}

describe('layeredMemoryPresentation', () => {
  it('combines layer, scope and anchor filters over the same records without creating copies', () => {
    const anchor = memory({ id: 'anchor-self', scope: 'character_self', layer: 'long_term', salience: 0.9, confidence: 0.9 });
    const relationship = memory({ id: 'episode-relationship', scope: 'relationship', layer: 'episodic' });
    const thread = memory({ id: 'thread', scope: 'thread', layer: 'episodic' });
    const archived = memory({ id: 'archived-self', scope: 'character_self', layer: 'long_term', archivedAt: 500 });
    const items = [anchor, relationship, thread, archived];
    const groups = buildLayeredMemoryGroups(items);

    expect(selectLayeredMemoryItems(groups, 'longTerm', 'self', true)).toEqual([anchor]);
    expect(selectLayeredMemoryItems(groups, 'longTerm', 'relationship')).toEqual([]);
    expect(selectLayeredMemoryItems(groups, 'episodic', 'relationship')).toEqual([relationship]);
    expect(selectLayeredMemoryItems(groups, 'episodic', 'conversation')).toEqual([thread]);
    expect(selectLayeredMemoryItems(groups, 'archived', 'self')).toEqual([archived]);
    expect(selectLayeredMemoryItems(groups, 'all')).toHaveLength(3);
    expect(selectLayeredMemoryItems(groups, 'all', 'self')[0]).toBe(anchor);
    expect(items).toHaveLength(4);
  });

  it('filters runtime evidence out of normal memory projection but keeps it in debug mode', () => {
    const stableMemory = memory({ id: 'stable', sourceTag: 'memory_distillation', origin: 'distilled' });
    const roomShift = memory({ id: 'runtime', scope: 'system_runtime', layer: 'working', sourceTag: 'room_shift' });

    expect(filterVisibleLayeredMemories([stableMemory, roomShift], false).map((item) => item.id)).toEqual(['stable']);
    expect(filterVisibleLayeredMemories([stableMemory, roomShift], true).map((item) => item.id)).toEqual(['stable', 'runtime']);
  });

  it('builds layer tabs from the same grouped memory projection', () => {
    const longTerm = memory({ id: 'anchor', layer: 'long_term', origin: 'distilled', salience: 0.86 });
    const relationship = memory({ id: 'relationship', scope: 'relationship', kind: 'bond' });
    const archived = memory({ id: 'archive', archivedAt: 300, updatedAt: 300 });
    const groups = buildLayeredMemoryGroups([relationship, archived, longTerm]);
    const filters = buildLayeredMemoryFilters(groups, false, 'zh-CN');

    expect(groups.all.map((item) => item.id)).toEqual(['relationship', 'anchor']);
    expect(filters.map((item) => item.key)).toEqual(expect.arrayContaining(['all', 'anchors', 'longTerm', 'relationship', 'archived']));
    expect(filters.find((item) => item.key === 'anchors')?.items.map((item) => item.id)).toEqual(['anchor']);
    expect(filters.find((item) => item.key === 'archived')?.items.map((item) => item.id)).toEqual(['archive']);
  });

  it('keeps raw runtime evidence out of settled memory layer groups', () => {
    const stableMemory = memory({ id: 'stable', layer: 'episodic', scope: 'conversation', sourceTag: 'llm_memory_objective_event', origin: 'distilled' });
    const relationshipEvidence = memory({ id: 'relationship-runtime', layer: 'episodic', scope: 'relationship', sourceTag: 'relationship_delta', origin: 'runtime' });
    const groups = buildLayeredMemoryGroups([stableMemory, relationshipEvidence]);
    const filters = buildLayeredMemoryFilters(groups, true, 'zh-CN');

    expect(groups.all.map((item) => item.id)).toEqual(['stable']);
    expect(groups.episodic.map((item) => item.id)).toEqual(['stable']);
    expect(groups.relationship.map((item) => item.id)).toEqual([]);
    expect(groups.working.map((item) => item.id)).toEqual(['relationship-runtime']);
    expect(filters.find((item) => item.key === 'working')?.label).toBe('运行证据');
  });

  it('projects display text, evidence, semantic labels, and debug metrics without leaking raw ids', () => {
    const speakerId = '3c78729f-e52d-4dde-b27f-01a949960bb8';
    const targetId = '8b3d7266-c0c7-4ceb-8dc2-45126f3f2321';
    const projected = projectLayeredMemoryItem({
      item: memory({
        id: 'clean',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'resentment',
        sourceTag: 'llm_memory_relationship_imprint',
        text: `${speakerId} 对 ${targetId} 留下了 relationship_delta 旧账。`,
        evidenceText: `${speakerId} 当时提到了 ${targetId} 的追问。`,
        salience: 0.8,
        confidence: 0.9,
        reinforcementCount: 3,
      }),
      includeDebugDetails: true,
      language: 'zh-CN',
      members: [
        { id: speakerId, name: '喜羊羊' },
        { id: targetId, name: '沸羊羊' },
      ],
    });

    expect(projected.displayText).toContain('喜羊羊');
    expect(projected.displayText).toContain('沸羊羊');
    expect(projected.displayText).toContain('关系变化');
    expect(projected.displayText).not.toContain(speakerId);
    expect(projected.evidenceTitle).toContain('追问');
    expect(projected.metaItems).toEqual(expect.arrayContaining(['锚点候选', '关系印记', '芥蒂', '长期记忆', '关系']));
    expect(projected.debugText).toBe('强化 3 · 置信 90% · 显著性 80%');
  });

  it('projects evidence trail as separated evidence rows and filters duplicate display text', () => {
    const projected = projectLayeredMemoryItem({
      item: memory({
        text: '甲对乙形成了稳定戒备。',
        evidenceText: '1. 旧证据：乙公开反驳甲。\n2. 新证据：甲绕开乙做决定。',
        evidenceTrail: [
          { text: '1. 旧证据：乙公开反驳甲。\n2. 新证据：甲绕开乙做决定。', weight: 0.92, createdAt: 200 },
          { text: '甲对乙形成了稳定戒备。', weight: 0.99, createdAt: 300 },
        ],
      }),
      includeDebugDetails: false,
      language: 'zh-CN',
    });

    expect(projected.evidenceItems.map((item) => item.text)).toEqual([
      '旧证据：乙公开反驳甲。',
      '新证据：甲绕开乙做决定。',
    ]);
    expect(projected.evidenceTitle).toContain('\n');
  });

  it('splits compact numbered evidence into separate rows for old persisted data', () => {
    const projected = projectLayeredMemoryItem({
      item: memory({
        text: '甲对乙形成了稳定戒备。',
        evidenceText: '1. 旧证据：乙公开反驳甲。 2. 新证据：甲绕开乙做决定。',
      }),
      includeDebugDetails: false,
      language: 'zh-CN',
    });

    expect(projected.evidenceItems.map((item) => item.text)).toEqual([
      '旧证据：乙公开反驳甲。',
      '新证据：甲绕开乙做决定。',
    ]);
  });

  it('redacts high-risk private memory content and evidence', () => {
    const projected = projectLayeredMemoryItem({
      item: memory({
        text: '秘密暗号是雨夜便利店，不能公开说',
        evidenceText: '1. 用户说手机号 13800000000 不要公开。 2. 明天面试有点紧张。',
      }),
      includeDebugDetails: false,
      language: 'zh-CN',
    });

    expect(projected.displayText).toBe('有一条私域记忆内容已隐藏原文');
    expect(projected.evidenceItems.map((item) => item.text)).toEqual([
      '有一条私域记忆证据已隐藏原文',
      '明天面试有点紧张。',
    ]);
    expect(projected.evidenceTitle).not.toContain('雨夜便利店');
    expect(projected.evidenceTitle).not.toContain('13800000000');
  });

  it('marks recently reactivated memories before generic strength labels', () => {
    const now = 1_000_000;
    const reactivated = memory({
      layer: 'long_term',
      lastActivatedAt: now - 60_000,
      salience: 0.4,
      confidence: 0.4,
    });

    expect(getMemoryStrengthLabel(reactivated, 'zh-CN', now)).toBe('最近回温');
  });
});
