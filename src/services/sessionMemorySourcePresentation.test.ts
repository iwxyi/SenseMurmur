import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { RelationshipLedgerEntry, RuntimeEventV2 } from '../types/runtimeEvent';
import type { MemoryItem } from './memoryTypes';
import { buildSessionMemorySourcePresentation } from './sessionMemorySourcePresentation';

function member(id: string, name: string): AICharacter {
  return { id, name } as AICharacter;
}

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem-1',
    scope: 'conversation',
    layer: 'long_term',
    kind: 'conflict',
    ownerId: 'chat-1',
    text: '群里记住了这次争执。',
    salience: 0.8,
    confidence: 0.9,
    recency: 1,
    reinforcementCount: 1,
    sourceEventIds: ['evt-1'],
    sourceTag: 'llm_memory_objective_event',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function relationship(overrides: Partial<RelationshipLedgerEntry> = {}): RelationshipLedgerEntry {
  return {
    pairKey: 'a->b',
    actorId: 'a',
    targetId: 'b',
    current: { warmth: 35, competence: 4, trust: 28, threat: 0 },
    derived: {
      salience: 0.8,
      semantic: {
        stage: '关系升温',
        labels: ['好感', '亲近'],
        summary: 'a 和 b 的信任正在升温。',
        intensity: 50,
      },
    },
    axisReasons: {
      trust: [{ axis: 'trust', value: 4, reason: 'support', evidence: 'a 支持 b：我站你这边', createdAt: 200 }],
    },
    trend: 'up',
    recentEvents: [{ id: 'evt-rel', kind: 'relationship_delta', createdAt: 200, summary: 'a 支持 b', actorIds: ['a'], targetIds: ['b'] }],
    lastUpdatedAt: 200,
    ...overrides,
  };
}

function runtimeConflictEvent(summary: string): RuntimeEventV2 {
  return {
    id: 'evt-conflict-history',
    conversationId: 'chat-1',
    kind: 'event_candidate',
    createdAt: 300,
    summary,
    payload: { eventType: 'conflict_focus_shift', summary },
  } as RuntimeEventV2;
}

function buildPresentation(overrides: Partial<Parameters<typeof buildSessionMemorySourcePresentation>[0]> = {}) {
  return buildSessionMemorySourcePresentation({
    chat: {
      layeredMemories: [memory({ id: 'older', updatedAt: 1 }), memory({ id: 'newer', updatedAt: 2 })],
      relationshipLedger: [relationship()],
      runtimeEventsV2: [],
      conflictAxes: [],
      conflictState: null,
    },
    members: [member('a', '喜羊羊'), member('b', '沸羊羊')],
    name: '羊村大家庭闲聊',
    topic: '最近有什么好玩的事？',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberCount: 2,
    seedArtifactText: '',
    includeDebug: false,
    ...overrides,
  });
}

describe('sessionMemorySourcePresentation', () => {
  it('builds session memory source summaries without runtime debug details by default', () => {
    const presentation = buildPresentation({
      runtimeLabels: {
        phase: 'idle',
        mood: '未设置',
        focus: '未设置',
        recentEvent: 'Relationship ledger has become salient for a',
        createdAt: 1,
      },
    });

    expect(presentation.sourceSummary).toBe('自由聊天 · 2 名成员 · 变化平衡');
    expect(presentation.sourceTooltip).toContain('会话：羊村大家庭闲聊 / 自由聊天');
    expect(presentation.sourceTooltip).not.toContain('阶段：');
    expect(presentation.sourceTooltip).not.toContain('Relationship ledger');
    expect(presentation.layeredMemoryItems.map((item) => item.id)).toEqual(['newer', 'older']);
  });

  it('adds runtime details only for debug projection', () => {
    const presentation = buildPresentation({
      includeDebug: true,
      runtimeLabels: {
        phase: 'idle',
        mood: '未设置',
        focus: '未设置',
        recentEvent: 'Relationship ledger has become salient for a',
        createdAt: 1,
        updatedAt: 2,
        lastMessageAt: 3,
      },
    });

    expect(presentation.sourceTooltip).toContain('阶段：idle');
    expect(presentation.sourceTooltip).toContain('关系账本中的变化已经足够显著');
    expect(presentation.sourceTooltip).toContain('创建');
  });

  it('sanitizes debug mood and focus fields in source tooltip', () => {
    const uuid = 'e055aa1d-88d4-4e96-abd2-1b35a3d56f67';
    const presentation = buildPresentation({
      includeDebug: true,
      runtimeLabels: {
        phase: 'idle',
        mood: `{"eventType":"room_state_snapshot_v2","owner":"${uuid}"}`,
        focus: `${uuid} 正在主导话题`,
        recentEvent: `${uuid} 和 a 争论升级`,
      },
    });

    expect(presentation.sourceTooltip).toContain('阶段：idle');
    expect(presentation.sourceTooltip).toContain('成员');
    expect(presentation.sourceTooltip).toContain('喜羊羊');
    expect(presentation.sourceTooltip).not.toContain(uuid);
    expect(presentation.sourceTooltip).not.toContain('eventType');
    expect(presentation.sourceTooltip).not.toContain('room_state_snapshot_v2');
  });

  it('projects active, axis, and historical conflicts with sanitized text', () => {
    const uuid = 'e055aa1d-88d4-4e96-abd2-1b35a3d56f67';
    const presentation = buildPresentation({
      chat: {
        layeredMemories: [],
        relationshipLedger: [],
        runtimeEventsV2: [runtimeConflictEvent(`${uuid} 与 a 的矛盾继续升级`)],
        conflictAxes: [{ title: `${uuid} 与 a 的归属张力`, poles: [uuid, 'a'], currentTilt: -40 }],
        conflictState: {
          primaryConflict: {
            id: 'conflict-1',
            scope: 'group',
            type: 'identity_ownership',
            severity: 0.74,
            stage: 'open',
            summary: `${uuid} 和 b 正在争夺话语权`,
            participantIds: [uuid, 'b'],
            nextPressure: 'escalate',
            developmentHooks: ['force_side_taking'],
            sourceEventIds: ['evt-1', 'evt-2'],
            updatedAt: 400,
          },
          activeConflicts: [],
          developmentHooks: [],
          volatility: 0,
          cooling: 0,
          updatedAt: 400,
        },
      },
    });

    expect(presentation.conflict.counts).toEqual({ active: 1, axes: 1, history: 1 });
    const axis = presentation.conflict.items.find((item) => item.category === 'axis');
    expect(axis?.meta).toBe('轴配置');
    expect(axis?.tooltip).not.toContain('累积影响');
    expect(axis?.tooltip).toContain('不证明实际立场');
    const visibleText = presentation.conflict.items.map((item) => `${item.summary} ${item.meta} ${item.tooltip}`).join('\n');
    expect(visibleText).toContain('成员');
    expect(visibleText).toContain('喜羊羊');
    expect(visibleText).toContain('沸羊羊');
    expect(visibleText).not.toContain(uuid);
    expect(visibleText).not.toContain('eventType');
  });

  it('keeps conflict metrics out of ordinary projection but includes them in debug projection', () => {
    const ordinary = buildPresentation({
      chat: {
        layeredMemories: [],
        relationshipLedger: [],
        runtimeEventsV2: [],
        conflictAxes: [],
        conflictState: {
          primaryConflict: {
            id: 'conflict-1',
            scope: 'group',
            type: 'authority_challenge',
            severity: 0.74,
            stage: 'open',
            summary: 'a 公开挑战 b',
            participantIds: ['a', 'b'],
            nextPressure: 'escalate',
            developmentHooks: [],
            sourceEventIds: [],
            updatedAt: 400,
          },
          activeConflicts: [],
          developmentHooks: [],
          volatility: 0,
          cooling: 0,
          updatedAt: 400,
        },
      },
      includeDebug: false,
    });
    const debug = buildPresentation({
      chat: ordinary.conflict.items.length ? {
        layeredMemories: [],
        relationshipLedger: [],
        runtimeEventsV2: [],
        conflictAxes: [],
        conflictState: {
          primaryConflict: {
            id: 'conflict-1',
            scope: 'group',
            type: 'authority_challenge',
            severity: 0.74,
            stage: 'open',
            summary: 'a 公开挑战 b',
            participantIds: ['a', 'b'],
            nextPressure: 'escalate',
            developmentHooks: [],
            sourceEventIds: [],
            updatedAt: 400,
          },
          activeConflicts: [],
          developmentHooks: [],
          volatility: 0,
          cooling: 0,
          updatedAt: 400,
        },
      } : undefined as never,
      includeDebug: true,
    });

    expect(ordinary.conflict.items[0]?.meta).toBe('活跃矛盾 / 公开化 / 继续升级');
    expect(debug.conflict.items[0]?.meta).toContain('权威挑战');
    expect(debug.conflict.items[0]?.meta).toContain('强度 74%');
  });

  it('projects relationship memory with names, evidence, and debug-only axis details', () => {
    const presentation = buildPresentation();
    const item = presentation.relationships.items[0];

    expect(item?.title).toBe('喜羊羊 -> 沸羊羊');
    expect(item?.body).toContain('喜羊羊 和 沸羊羊');
    expect(item?.evidence).toContain('喜羊羊 支持 沸羊羊');
    expect(item?.detail).toContain('信任略高（28）');
    expect(item?.detail).toContain('亲和偏高（35）');
    expect(item?.detail).not.toContain('威胁感');
  });

  it('renders user participant id as 我 in conflict tooltip', () => {
    const presentation = buildPresentation({
      chat: {
        layeredMemories: [],
        relationshipLedger: [],
        runtimeEventsV2: [],
        conflictAxes: [],
        conflictState: {
          primaryConflict: {
            id: 'conflict-user',
            scope: 'group',
            type: 'care_jealousy',
            severity: 0.55,
            stage: 'open',
            summary: 'a 对 user 的关注竞争升温',
            participantIds: ['a', 'user'],
            nextPressure: 'stabilize',
            developmentHooks: [],
            sourceEventIds: [],
            updatedAt: 500,
          },
          activeConflicts: [],
          developmentHooks: [],
          volatility: 0,
          cooling: 0,
          updatedAt: 500,
        },
      },
    });

    const tooltip = presentation.conflict.items[0]?.tooltip || '';
    expect(tooltip).toContain('参与者：喜羊羊、我');
    expect(tooltip).not.toContain('user');
  });

  it('classifies artifact seeds without preserving dialogue-like junk', () => {
    const presentation = buildPresentation({
      seedArtifactText: '计划：第一步先核实时间线\n计划：哪里不靠谱了\n嘻嘻，懒羊羊哥哥最好了',
    });

    expect(presentation.artifacts.valid).toEqual(['计划：第一步先核实时间线']);
    expect(presentation.artifacts.suspicious).toContain('计划：哪里不靠谱了');
    expect(presentation.artifacts.suspicious).toContain('嘻嘻，懒羊羊哥哥最好了');
  });
});
