import { describe, expect, it } from 'vitest';
import { createTestChat, createTestCharacter } from '../test/fixtures';
import type { Message } from '../types/message';
import type { ConversationUpdate } from '../types/conversationContinuity';
import { createInitialRoomState } from './roomStateSynthesizer';
import { applyConversationUpdate, buildConversationContinuityContext, normalizeConversationUpdate } from './conversationContinuity';
import { projectNarrativeLines } from './narrativeProjection';
import { buildInlineInteractionContract } from './inlineInteractionHint';
import { resolveDirectorIntent } from './directorIntent';

const chat = () => createTestChat({ id: 'room', memberIds: ['a', 'b'] });
const item = { key: 'role', kind: 'decision' as const, status: 'established' as const,
  summary: '只定了前锋分工，尚未下令开战', participantIds: ['a', 'b'], evidenceText: '先定分工' };
const message = (update: ConversationUpdate, patch: Partial<Message> = {}): Message => ({
  id: 'sent', chatId: 'room', type: 'ai', senderId: 'a', senderName: '甲', content: '先定分工，暂不出兵。',
  timestamp: 10, emotion: 0, isDeleted: false, metadata: { conversationUpdate: update }, ...patch,
});

describe('conversation continuity commit boundary', () => {
  it.each(['resolved', 'retracted'] as const)('keeps an accepted commitment active until its %s result is committed', (status) => {
    const initial = chat();
    const promise = { ...item, key: 'scout-report', kind: 'commitment' as const,
      summary: '甲答应把关口记录交给乙', evidenceText: '我把关口记录交给你' };
    const accepted = message({ items: [promise] }, { content: '我把关口记录交给你。' });
    const first = applyConversationUpdate(initial, accepted, null);
    const current = { ...initial, worldState: { ...initial.worldState, conversationContinuity: first.continuity } };
    const lines = projectNarrativeLines({ chat: current, messages: [accepted] });
    expect(lines.find((line) => line.id === 'continuity:scout-report')).toMatchObject({
      contextKind: 'background', status: 'active', tension: 0,
      openQuestions: [], possibleNextBeats: [],
    });
    expect(resolveDirectorIntent({ chat: current, characters: [], messages: [accepted], narrativeLines: lines })?.targetLineId)
      .not.toBe('continuity:scout-report');
    const evidence = status === 'resolved' ? '关口记录给你了' : '这回记录我交不了了';
    const result = message({ items: [{ ...promise, status, evidenceText: evidence }] },
      { id: 'result', content: evidence, timestamp: 20 });
    const applied = applyConversationUpdate(current, result, null);
    const ended = { ...current, worldState: { ...current.worldState, conversationContinuity: applied.continuity } };
    expect(projectNarrativeLines({ chat: ended, messages: [result] }).some((line) => line.id === 'continuity:scout-report')).toBe(false);
    expect(buildConversationContinuityContext(ended, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]))
      .toContain(`[scout-report] commitment/${status}`);
    expect(applied.continuity?.items[0].sourceMessageIds).toEqual(['sent', 'result']);
  });

  it('preserves an older accepted commitment beyond both history windows and keeps it in the output contract', () => {
    const initial = chat();
    initial.worldState.conversationContinuity = { items: [
      { ...item, key: 'old-promise', kind: 'commitment', updatedAt: 1, sourceMessageIds: ['old-source'] },
      ...Array.from({ length: 70 }, (_, index) => ({ ...item, key: `decision-${index}`,
        updatedAt: index + 2, sourceMessageIds: [] })),
    ] };
    const next = applyConversationUpdate(initial, message({ items: [item] }, { timestamp: 100 }), null);
    const current = { ...initial, worldState: { ...initial.worldState, conversationContinuity: next.continuity } };
    expect(next.continuity?.items).toHaveLength(65);
    expect(next.continuity?.items.find((entry) => entry.key === 'old-promise'))
      .toMatchObject({ status: 'established', updatedAt: 1, sourceMessageIds: ['old-source'] });
    const speaker = createTestCharacter({ id: 'a', name: '甲' });
    const characters = [speaker, createTestCharacter({ id: 'b', name: '乙' })];
    const contract = buildInlineInteractionContract({ chat: current, speaker, characters, recentMessages: [] });
    expect(contract).toContain('[old-promise] commitment/established');
    expect(contract).not.toContain('[decision-0]');
    expect(projectNarrativeLines({ chat: current, messages: [] }).map((line) => line.id))
      .toContain('continuity:old-promise');
    expect(projectNarrativeLines({ chat: current, messages: [] }).some((line) => line.id === 'continuity:role')).toBe(false);
  });

  it('lets an untouched open item recede behind newer room turns without deleting it', () => {
    const initial = chat();
    const opened = applyConversationUpdate(initial, message({ items: [{ ...item, kind: 'issue', status: 'open' }] }), null);
    const current = { ...initial, worldState: { ...initial.worldState, conversationContinuity: opened.continuity } };
    const lines = projectNarrativeLines({
      chat: current,
      messages: [
        message({ items: [{ ...item, kind: 'issue', status: 'open' }] }),
        message({ items: [] }, { id: 'later-1', senderId: 'b', timestamp: 20, content: '我先说另一件事。' }),
        message({ items: [] }, { id: 'later-2', senderId: 'a', timestamp: 30, content: '这件事先放一放。' }),
      ],
      now: 30,
    });
    const line = lines.find((entry) => entry.id === 'continuity:role');
    expect(line).toMatchObject({ contextKind: 'background', salience: 0.24, possibleNextBeats: [] });
    expect(current.worldState.conversationContinuity?.items[0].status).toBe('open');
  });

  it('bounds ended history separately from open matters', () => {
    const initial = chat();
    initial.worldState.conversationContinuity = { items: [
      { ...item, key: 'pending', status: 'open', participantIds: [], updatedAt: 1, sourceMessageIds: [] },
      ...Array.from({ length: 20 }, (_, index) => ({ ...item, key: `ended-${index}`, updatedAt: index + 2, sourceMessageIds: [] })),
    ] };
    const context = buildConversationContinuityContext(initial, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]);
    expect(context).toContain('[pending] decision/open');
    expect(context).toContain('participants: roomwide');
    expect(context).toContain('[ended-19]');
    expect(context).not.toContain('[ended-0]');
    expect(context.match(/decision\/established/g)).toHaveLength(16);
  });

  it('keeps old open keys and participants available for acceptance beyond the recent context window', () => {
    const initial = chat();
    initial.worldState.conversationContinuity = { items: Array.from({ length: 20 }, (_, index) => ({
      ...item, key: `proposal-${index}`, kind: 'issue', status: 'open',
      updatedAt: index + 1, sourceMessageIds: [`proposal-message-${index}`],
    })) };
    const context = buildConversationContinuityContext(initial, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]);
    expect(context).toContain('[proposal-0] issue/open');
    expect(context).toContain('participants: 甲, 乙');
    expect(context.match(/issue\/open/g)).toHaveLength(20);
    const contract = buildInlineInteractionContract({ chat: initial,
      speaker: createTestCharacter({ id: 'a', name: '甲' }),
      characters: [createTestCharacter({ id: 'a', name: '甲' }), createTestCharacter({ id: 'b', name: '乙' })],
      recentMessages: [],
    });
    expect(contract).toContain('[proposal-0] issue/open');
    expect(contract).toContain('participants: 甲, 乙');
    const next = applyConversationUpdate(initial, message({ items: [{ ...item, key: 'proposal-0' }] }), null);
    const updated = { ...initial, worldState: { ...initial.worldState, conversationContinuity: next.continuity } };
    expect(next.continuity?.items).toHaveLength(20);
    expect(projectNarrativeLines({ chat: updated, messages: [] }).some((line) => line.id === 'continuity:proposal-0')).toBe(false);
    expect(buildConversationContinuityContext(updated, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]))
      .toContain('[proposal-0] decision/established');
  });

  it('validates model updates without guessing semantics from words', () => {
    expect(normalizeConversationUpdate({ items: [{ ...item, kind: 'battle' }] })).toBeNull();
    expect(applyConversationUpdate(chat(), message({ items: [] }), null).changedItems).toEqual([]);
  });

  it('accepts exact committed evidence and rejects unsent quotes or unknown participants', () => {
    const result = applyConversationUpdate(chat(), message({ items: [item,
      { ...item, key: 'unsent', evidenceText: '明天攻城' },
      { ...item, key: 'stranger', participantIds: ['outsider'] },
    ] }), null);
    expect(result.continuity?.items).toEqual([{ ...item, updatedAt: 10, sourceMessageIds: ['sent'] }]);
    expect(projectNarrativeLines({ chat: { ...chat(), worldState: { ...chat().worldState, conversationContinuity: result.continuity } }, messages: [] })
      .some((line) => line.id === 'continuity:role')).toBe(false);
  });

  it('preserves omitted open matters and resolves only an existing stable key', () => {
    const initial = chat();
    const opened = applyConversationUpdate(initial, message({ items: [{ ...item, kind: 'issue', status: 'open' }] }), null);
    const existing = { ...initial, worldState: { ...initial.worldState, conversationContinuity: opened.continuity } };
    expect(applyConversationUpdate(existing, message({ items: [] }), null).continuity?.items[0].status).toBe('open');
    const resolved = applyConversationUpdate(existing, message({ items: [
      { ...item, kind: 'issue', status: 'resolved' }, { ...item, key: 'unknown', status: 'resolved' },
    ] }), null);
    expect(resolved.continuity?.items).toHaveLength(1);
    expect(resolved.continuity?.items[0].status).toBe('resolved');
  });

  it('lets an explicitly accepted proposal become a decision under the same key', () => {
    const initial = chat();
    const first = applyConversationUpdate(initial, message({ items: [{ ...item, kind: 'issue', status: 'open' }] }), null);
    const existing = { ...initial, worldState: { ...initial.worldState, conversationContinuity: first.continuity } };
    const next = applyConversationUpdate(existing, message({ items: [item] }, { id: 'accepted', timestamp: 11 }), null);
    expect(next.continuity?.items[0]).toMatchObject({ kind: 'decision', status: 'established', sourceMessageIds: ['sent', 'accepted'] });
    expect(projectNarrativeLines({ chat: { ...existing, worldState: { ...existing.worldState, conversationContinuity: next.continuity } }, messages: [] })
      .some((line) => line.id === 'continuity:role')).toBe(false);
  });

  it('carries a fulfilled commitment into the next context without resolving a separate issue', () => {
    const initial = chat();
    const first = applyConversationUpdate(initial, message({ items: [
      { ...item, kind: 'commitment' },
      { ...item, key: 'separate', kind: 'issue', status: 'open' },
    ] }), null);
    const existing = { ...initial, worldState: { ...initial.worldState, conversationContinuity: first.continuity } };
    const next = applyConversationUpdate(existing, message({ items: [{ ...item, kind: 'commitment', status: 'resolved',
      summary: '关口记录已交回', evidenceText: '关口记录收到了' }] }, {
      id: 'result', senderId: 'b', content: '关口记录收到了。', timestamp: 20,
    }), null);
    const updated = { ...existing, worldState: { ...existing.worldState, conversationContinuity: next.continuity } };
    expect(next.continuity?.items.find((entry) => entry.key === 'role')).toMatchObject({
      status: 'resolved', sourceMessageIds: ['sent', 'result'],
    });
    expect(next.continuity?.items.find((entry) => entry.key === 'separate')?.status).toBe('open');
    expect(buildConversationContinuityContext(updated, [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]))
      .toContain('[role] commitment/resolved: 关口记录已交回');
    expect(projectNarrativeLines({ chat: updated, messages: [] }).filter((line) => line.contextKind === 'unresolved')
      .map((line) => line.id)).toContain('continuity:separate');
    expect(projectNarrativeLines({ chat: updated, messages: [] }).some((line) => line.id === 'continuity:role')).toBe(false);
  });

  it('rejects withdrawn, private and nonmember evidence', () => {
    for (const patch of [
      { senderId: 'outsider' },
      { metadata: { conversationUpdate: { items: [item] }, visibility: 'pair_private' as const } },
      { metadata: { conversationUpdate: { items: [item] }, withdrawal: { withdrawn: true } } },
    ]) expect(applyConversationUpdate(chat(), message({ items: [item] }, patch), null).changedItems).toEqual([]);
  });

  it('writes structural room changes explicitly and preserves them on an omitted update', () => {
    const first = applyConversationUpdate(chat(), message({ items: [], room: {
      addAlliances: [['a', 'b']], addConflictPairs: [['a', 'outsider']], pileOnTarget: 'b', evidenceText: '先定分工',
    } }), createInitialRoomState());
    expect(first.room?.alliances).toEqual([['a', 'b']]);
    expect(first.room?.conflictPairs).toEqual([]);
    expect(applyConversationUpdate(chat(), message({ items: [] }), first.room).room?.pileOnTarget).toBe('b');
    const removed = applyConversationUpdate(chat(), message({ items: [], room: {
      removeAlliances: [['b', 'a']], pileOnTarget: null, evidenceText: '先定分工',
    } }), first.room);
    expect(removed.room?.alliances).toEqual([]);
    expect(removed.room?.pileOnTarget).toBeNull();
  });

  it('initializes room structure only from a supported public update', () => {
    const roomUpdate = { items: [], room: { addAlliances: [['a', 'b'] as [string, string]], evidenceText: '先定分工' } };
    expect(applyConversationUpdate(chat(), message(roomUpdate), null).room?.alliances).toEqual([['a', 'b']]);
    expect(applyConversationUpdate(chat(), message({ ...roomUpdate, room: { ...roomUpdate.room, evidenceText: '没有发送的结盟' } }), null).room).toBeNull();
    expect(applyConversationUpdate(chat(), message(roomUpdate, { metadata: { conversationUpdate: roomUpdate, visibility: 'pair_private' } }), null).room).toBeNull();
  });

  it('clears a pause signal on new human input while retaining facts', () => {
    const initial = chat();
    const first = applyConversationUpdate(initial, message({ items: [item], settled: { scope: 'room', evidenceText: '暂不出兵' } }), null);
    const existing = { ...initial, worldState: { ...initial.worldState, conversationContinuity: first.continuity } };
    const next = applyConversationUpdate(existing, message({ items: [] }, { type: 'user', senderId: 'user' }), null);
    expect(first.continuity?.settledAt).toBe(10);
    expect(first.continuity?.settledScope).toBe('room');
    expect(first.continuity?.settledEvidenceText).toBe('暂不出兵');
    expect(next.continuity?.settledAt).toBeUndefined();
    expect(next.continuity?.items).toEqual(first.continuity?.items);
  });

  it('preserves an earlier bubble pause signal when another bubble writes an item', () => {
    const initial = chat();
    const first = applyConversationUpdate(initial, message({ items: [], settled: { scope: 'room', evidenceText: '暂不出兵' } }), null);
    const existing = { ...initial, worldState: { ...initial.worldState, conversationContinuity: first.continuity } };
    const next = applyConversationUpdate(existing, message({ items: [item] }, { id: 'second-bubble', timestamp: 11 }), null);
    expect(next.continuity?.settledAt).toBe(10);
    expect(next.continuity?.settledScope).toBe('room');
    expect(next.continuity?.settledEvidenceText).toBe('暂不出兵');
    expect(next.continuity?.items[0].sourceMessageIds).toEqual(['second-bubble']);
  });

  it('reopens a settled exchange only for a supported open item unless explicitly deferred again', () => {
    const initial = chat();
    const first = applyConversationUpdate(initial, message({ items: [], settled: { evidenceText: '暂不出兵' } }), null);
    const existing = { ...initial, worldState: { ...initial.worldState, conversationContinuity: first.continuity } };
    const openItem = { ...item, kind: 'issue' as const, status: 'open' as const };
    expect(applyConversationUpdate(existing, message({ items: [openItem] }), null).continuity?.settledAt).toBeUndefined();
    expect(applyConversationUpdate(existing, message({ items: [{ ...openItem, evidenceText: '未发送' }] }), null).continuity?.settledAt).toBe(10);
    expect(applyConversationUpdate(existing, message({ items: [openItem], settled: { evidenceText: '暂不出兵' } },
      { timestamp: 11 }), null).continuity?.settledAt).toBe(11);
  });
});
