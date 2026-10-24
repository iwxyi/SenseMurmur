import { describe, expect, it } from 'vitest';
import {
  buildConflictEventMeta,
  buildEventDisplayText,
  buildMemoryDistillationMeta,
  buildMemoryReactivationMeta,
  shouldHideEmptyConflictEvent,
} from './messageBubbleEventHelpers';
import { buildRuntimeEvent } from '../../services/runtimeEventFactory';
import { shouldRenderEventMessage, type EventRenderFlags } from './eventMessagePresentation';
import type { Message } from '../../types/message';

const baseEventFlags: EventRenderFlags = {
  developerMode: false,
  showRelationshipEvents: false,
  showAffectEvents: false,
  showConflictEvents: false,
  showStateEvents: false,
  showMemoryDistillationEvents: false,
  showDetailedFactHints: false,
  showCalendarEvents: false,
  showMemoryDebug: false,
  showLocalInterceptionHints: false,
};

function eventMessage(content: string): Message {
  return {
    id: 'event-1',
    chatId: 'chat-1',
    type: 'event',
    senderId: 'system',
    senderName: 'System',
    content,
    timestamp: 1,
    emotion: 0,
    isDeleted: false,
  };
}

describe('messageBubbleEventHelpers', () => {
  it('shows a brief automatic room pause notice with developer mode disabled', () => {
    const message = eventMessage(buildRuntimeEvent({
      eventType: 'conversation_paused', title: '群聊自动暂停',
      summary: '群聊已自动暂停',
      visibilityScope: 'public', channelId: 'public',
    }));
    expect(shouldRenderEventMessage(message, baseEventFlags)).toBe(true);
    expect(shouldRenderEventMessage(message, { ...baseEventFlags, developerMode: true })).toBe(true);
  });

  it('lists all saved facts with line breaks', () => {
    const summary = '新增 3 条详细事实：\n1. 刘备约定明日出发\n2. 关羽负责粮草\n3. 张飞负责练兵';
    expect(buildEventDisplayText({ eventType: 'detailed_fact_recorded', summary })).toBe(summary);
  });

  it('preserves codewords in developer fact hints instead of classifying privacy by vocabulary', () => {
    const summary = '新增 2 条详细事实：\n1. 刘备约定明日出发\n2. 暗号“风紧扯呼”表示有人查账时赶紧藏起账单';
    expect(buildEventDisplayText({
      eventType: 'detailed_fact_recorded',
      summary,
    })).toBe(summary);
  });

  it('still replaces internal member IDs in fact hints', () => {
    expect(buildEventDisplayText({
      eventType: 'detailed_fact_recorded', summary: '新增 1 条详细事实：\n1. actor-1 确认暗号是风紧扯呼',
    }, [{ id: 'actor-1', name: '张飞' }])).toBe('新增 1 条详细事实：\n1. 张飞 确认暗号是风紧扯呼');
  });

  it('builds localized memory distillation display text', () => {
    const text = buildEventDisplayText({
      eventType: 'memory_distillation',
      summary: 'ignored',
      metrics: {
        ownerType: 'character',
        ownerLabel: '角色：喜羊羊',
        ownerName: '喜羊羊',
        candidateTexts: ['test'],
        sourceLabel: 'LLM蒸馏',
      },
    });
    expect(text).toBe('LLM角色蒸馏 · 喜羊羊');
  });

  it('builds memory distillation meta from metrics', () => {
    const meta = buildMemoryDistillationMeta({
      metrics: {
        ownerType: 'character',
        candidateTexts: ['A', 'B'],
        mergeMode: 'append_new',
        newEvidenceCount: 3,
      },
    });
    expect(meta).toEqual({
      mergeModeLabel: '新增记忆',
      evidenceCount: 3,
      candidateTexts: ['A'],
    });
  });

  it('redacts high-risk private memory distillation candidates', () => {
    const meta = buildMemoryDistillationMeta({
      metrics: {
        ownerType: 'character',
        candidateTexts: ['秘密暗号是雨夜便利店，不能公开说'],
        mergeMode: 'append_new',
        newEvidenceCount: 1,
      },
    });
    expect(meta?.candidateTexts).toEqual(['有一条私域蒸馏候选已隐藏原文']);
  });

  it('builds memory reactivation meta and sanitizes fields', () => {
    const meta = buildMemoryReactivationMeta({
      metrics: {
        matchedTokens: ['喜羊羊', '灰太狼'],
        recalledMemories: [
          { summary: '喜羊羊 记得灰太狼说过的话', matchedTokens: ['灰太狼'] },
        ],
      },
    });
    expect(meta?.matchedTokens).toEqual(['喜羊羊', '灰太狼']);
    expect(meta?.recalledMemories[0]?.summary).toContain('喜羊羊');
  });

  it('redacts high-risk private event and memory reactivation text', () => {
    expect(buildEventDisplayText({
      eventType: 'memory_reactivation',
      summary: '秘密暗号是雨夜便利店，不能公开说',
    })).toBe('有一条私域记忆回温已隐藏原文');

    const meta = buildMemoryReactivationMeta({
      metrics: {
        matchedTokens: ['雨夜便利店暗号'],
        recalledMemories: [
          { summary: '手机号 13800000000 不要公开', matchedTokens: ['13800000000'] },
        ],
      },
    });
    expect(meta?.matchedTokens).toEqual(['有一条私域命中词已隐藏原文']);
    expect(meta?.recalledMemories[0]?.summary).toBe('有一条私域回温记忆已隐藏原文');
    expect(meta?.recalledMemories[0]?.matchedTokens).toEqual(['有一条私域命中词已隐藏原文']);
  });

  it('hides empty conflict events only when both summary and metrics are empty', () => {
    expect(shouldHideEmptyConflictEvent({
      eventType: 'conflict_focus_shift',
      summary: '',
      metrics: {},
    })).toBe(true);
    expect(shouldHideEmptyConflictEvent({
      eventType: 'conflict_focus_shift',
      summary: '有冲突摘要',
      metrics: {},
    })).toBe(false);
    expect(shouldHideEmptyConflictEvent({
      eventType: 'conflict_focus_shift',
      summary: '',
      metrics: { type: 'resource' },
    })).toBe(false);
  });

  it('delegates conflict metrics formatting', () => {
    const meta = buildConflictEventMeta({
      metrics: {
        type: 'status',
        stage: 'escalating',
        severity: 0.6,
      },
    });
    expect(meta).toBeTruthy();
  });

  it('keeps story progress runtime events out of the visible message list by default', () => {
    const message = eventMessage(buildRuntimeEvent({
      eventType: 'story_scene_progress',
      title: '剧情推进',
      summary: '沈清婉站在马房门口。',
      visibilityScope: 'public',
      channelId: 'public',
    }));

    expect(shouldRenderEventMessage(message, baseEventFlags)).toBe(false);
    expect(shouldRenderEventMessage(message, { ...baseEventFlags, developerMode: true })).toBe(false);
  });
});
