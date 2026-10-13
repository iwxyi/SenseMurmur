import { describe, expect, it } from 'vitest';
import { buildRuntimeEventMessageContent, buildRuntimeMemoryEntryFromEvent, buildTimelineEntryFromRuntimeEvent, normalizeRuntimeEvent, parseRuntimeEvent } from './runtimeEventFactory';

describe('runtime event message content', () => {
  it('keeps axis changes visible without promoting them to runtime memory', () => {
    const event = { eventType: 'conflict_axis_shift', title: '轴配置变化', summary: '群体关系 结盟', createdAt: 123 };
    expect(buildTimelineEntryFromRuntimeEvent(event).text).toContain('群体关系');
    expect(buildRuntimeMemoryEntryFromEvent(event)).toBeNull();
  });

  it('compacts memory distillation metrics for chat message storage', () => {
    const content = buildRuntimeEventMessageContent({
      eventType: 'memory_distillation',
      title: '记忆蒸馏',
      summary: '完成记忆合并',
      metrics: {
        ownerType: 'character',
        ownerLabel: '角色：小灰灰',
        ownerName: '小灰灰',
        reasonLabel: '已完成 LLM 蒸馏',
        sourceLabel: 'LLM 蒸馏',
        mergeModeLabel: '强化合并',
        newEvidenceCount: 3,
        candidateTexts: [
          '群聊稳定关系趋势：灰太狼→沸羊羊 支持：灰太狼 → 沸羊羊 · 哟，沸羊羊你今天站我这边了？ / 3c78729f-e52d-4dde-b27f-01a949960b',
          '群聊稳定关系趋势：灰太狼→沸羊羊 支持：灰太狼 → 沸羊羊 · 哟，沸羊羊你今天站我这边了？ / 3c78729f-e52d-4dde-b27f-01a949960b',
          '群聊长期拉扯主轴：喜羊羊→沸羊羊 挑战：喜羊羊 → 沸羊羊 · 怎么，你也想要一个能给你做蛋糕的老婆？ / 19b22fbd-9d0c-45f7-97b8-8224d',
        ],
      },
    });

    expect(content).not.toContain('3c78729f-e52d-4dde-b27f-01a949960b');
    const parsed = parseRuntimeEvent(content);
    expect(parsed?.metrics).toMatchObject({
      ownerType: 'character',
      ownerLabel: '角色：小灰灰',
      ownerName: '小灰灰',
      reasonLabel: '已完成 LLM 蒸馏',
      sourceLabel: 'LLM 蒸馏',
      mergeModeLabel: '强化合并',
      newEvidenceCount: 3,
      candidateTexts: [
        '群聊稳定关系趋势：灰太狼→沸羊羊 支持：灰太狼 → 沸羊羊 · 哟，沸羊羊你今天站我这边了？',
        '群聊长期拉扯主轴：喜羊羊→沸羊羊 挑战：喜羊羊 → 沸羊羊 · 怎么，你也想要一个能给你做蛋糕的老婆？',
      ],
    });
  });

  it('keeps conflict display metrics without retaining full metrics payloads', () => {
    const content = buildRuntimeEventMessageContent({
      eventType: 'conflict_focus_shift',
      title: '矛盾焦点变化',
      summary: '矛盾升级',
      metrics: {
        type: 'goal_conflict',
        stage: 'open',
        severity: 0.8,
        nextPressure: 'escalate',
        developmentHooks: ['force_side_taking'],
        rawCandidates: Array.from({ length: 20 }, (_, index) => ({ index, text: 'large payload' })),
      },
    });

    expect(content).not.toContain('rawCandidates');
    const parsed = parseRuntimeEvent(content);
    expect(parsed?.metrics).toMatchObject({
      type: 'goal_conflict',
      stage: 'open',
      severity: 0.8,
      nextPressure: 'escalate',
      developmentHooks: ['force_side_taking'],
    });
  });

  it('keeps compact memory reactivation evidence for debug display', () => {
    const content = buildRuntimeEventMessageContent({
      eventType: 'memory_reactivation',
      title: '旧记忆回温',
      summary: '甲 的旧记忆被当前发言重新唤醒：雨夜失约和蓝色石头',
      metrics: {
        characterId: 'char-a',
        characterName: '甲',
        matchedTokens: ['雨夜', '失约', '蓝色', '石头', '额外1', '额外2', '额外3', '额外4', '额外5'],
        recalledMemories: [
          {
            id: 'archive-1',
            summary: '雨夜失约和蓝色石头',
            scope: 'relationship',
            kind: 'resentment',
            layer: 'long_term',
            recallReason: '当前发言重新提到了雨夜旧事',
            recallScore: 0.92,
            matchedTokens: ['雨夜', '失约', '蓝色', '石头', '多余1', '多余2', '多余3'],
            sourceEventIds: Array.from({ length: 20 }, (_, index) => `evt-${index}`),
          },
        ],
      },
    });

    expect(content).not.toContain('sourceEventIds');
    const parsed = parseRuntimeEvent(content);
    const metrics = parsed?.metrics as { matchedTokens?: string[]; recalledMemories?: Array<{ matchedTokens?: string[] }> } | undefined;
    expect(metrics?.matchedTokens).toHaveLength(8);
    expect(metrics?.matchedTokens).toEqual(expect.arrayContaining(['雨夜', '失约', '蓝色', '石头']));
    expect(metrics?.recalledMemories?.[0]).toMatchObject({
      id: 'archive-1',
      summary: '雨夜失约和蓝色石头',
      recallReason: '当前发言重新提到了雨夜旧事',
      recallScore: 0.92,
    });
    expect(metrics?.recalledMemories?.[0]?.matchedTokens).toHaveLength(6);
  });

  it('keeps explicit createdAt=0 without replacing it', () => {
    const event = normalizeRuntimeEvent({
      eventType: 'test_event',
      title: '测试',
      summary: '保留零时间戳',
      createdAt: 0,
    });
    expect(event.createdAt).toBe(0);
  });

  it('uses provided now for deterministic timeline fallback when createdAt is missing', () => {
    const entry = buildTimelineEntryFromRuntimeEvent({
      eventType: 'test_event',
      title: '测试',
      summary: '确定性时间',
    }, { now: 1777000000000 });
    expect(entry.createdAt).toBe(1777000000000);
  });
});
