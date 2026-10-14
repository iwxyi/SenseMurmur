import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../types/chat';
import type { RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';
import { buildPendingSocialIntentContext, buildSocialIntentArtifact, buildSocialIntentOutcomes, getPendingSocialIntents, isCompletedSocialArtifact } from './socialIntentArtifact';
import { splitGeneratedRoundMessage } from './generatedMessageSegmenter';

function intent(eventKind: SocialEventCandidatePayload['eventKind'] = 'check_in'): RuntimeEventV2 {
  const artifact = buildSocialIntentArtifact({ eventKind, initiatorId: 'a', participantIds: ['a', 'b'],
    targetIds: ['b'], reasonType: 'care', confidence: 0.9, urgency: 'soon', seedIntent: '问问乙是否休息好了', visibilityPlan: 'public' }, '甲', 'candidate');
  if (!artifact) throw new Error('unsupported test intent');
  return { id: 'intent', conversationId: 'chat', kind: 'artifact', actorIds: ['a'], targetIds: ['b'], createdAt: 1, ...artifact };
}

const chat = (events: RuntimeEventV2[]) => normalizeConversation({ id: 'chat', memberIds: ['a', 'b', 'user'], runtimeEventsV2: events });
const outcomeHint = { eventKind: 'check_in' as const, intentId: 'intent', outcome: 'completed' as const, evidenceText: '昨晚睡得好吗？' };
const reply = { id: 'reply', senderId: 'a', content: '昨晚睡得好吗？', socialEventHints: [outcomeHint] };

describe('social intention lifecycle', () => {
  it.each(['status_update', 'check_in', 'react_to_moment', 'gift_exchange', 'conflict_expression'] as const)('settles %s only with committed evidence and removes it from next context', (kind) => {
    const source = intent(kind);
    const before = chat([source]);
    expect(buildPendingSocialIntentContext(before, 'a')).toContain('intent');
    expect(buildPendingSocialIntentContext(before, 'b')).toBe('');
    const results = buildSocialIntentOutcomes(before, { ...reply, socialEventHints: [{ ...outcomeHint, eventKind: kind }] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ evidenceMessageIds: ['reply'], payload: { status: 'completed', intentId: source.id, text: reply.content } });
    expect(isCompletedSocialArtifact(results[0])).toBe(true);
    const after = chat([source, ...results]);
    expect(getPendingSocialIntents(after, 'a')).toEqual([]);
    expect(buildSocialIntentOutcomes(after, reply)).toEqual([]);
  });

  it('records explicit cancellation without projecting a completed action', () => {
    const results = buildSocialIntentOutcomes(chat([intent()]), { ...reply, socialEventHints: [{ ...outcomeHint, outcome: 'cancelled' }] });
    expect(isCompletedSocialArtifact(results[0])).toBe(false);
    expect(getPendingSocialIntents(chat([intent(), ...results]), 'a')).toEqual([]);
  });

  it('rejects another actor, unknown intents, wrong kind, absent evidence, empty response and uncommitted messages', () => {
    for (const message of [
      { ...reply, senderId: 'b' }, { ...reply, id: undefined }, { ...reply, content: '' },
      { ...reply, socialEventHints: [{ ...outcomeHint, intentId: 'unknown' }] },
      { ...reply, socialEventHints: [{ ...outcomeHint, eventKind: 'gift_exchange' as const }] },
      { ...reply, socialEventHints: [{ ...outcomeHint, evidenceText: undefined }] },
    ]) expect(buildSocialIntentOutcomes(chat([intent()]), message)).toEqual([]);
  });

  it('keeps private intentions out of a room with unrelated viewers', () => {
    const source = { ...intent(), visibility: 'pair_private' as const };
    expect(buildPendingSocialIntentContext(chat([source]), 'a')).toBe('');
    expect(buildSocialIntentOutcomes(chat([source]), reply)).toEqual([]);
    const privateChat = normalizeConversation({ ...chat([source]), type: 'direct', memberIds: ['a', 'b'] });
    expect(buildPendingSocialIntentContext(privateChat, 'a')).toContain('intent');
    expect(buildPendingSocialIntentContext({ ...privateChat, type: 'ai_direct' }, 'a')).toContain('intent');
  });

  it('does not complete an intention when its later evidence bubble has not been delivered', () => {
    const parts = splitGeneratedRoundMessage({ chatId: 'chat', type: 'ai', senderId: 'a', senderName: '甲', emotion: 0,
      content: '早。', messageParts: [{ content: '早。' }, { content: reply.content }], socialEventHints: [outcomeHint] });
    expect(buildSocialIntentOutcomes(chat([intent()]), { ...parts[0], id: 'first' })).toEqual([]);
    expect(buildSocialIntentOutcomes(chat([intent()]), { ...parts[1], id: 'second' })).toHaveLength(1);
  });

  it('honors explicit audience restrictions even for a public intention', () => {
    const source = { ...intent(), visibleToIds: ['a', 'b'] };
    expect(buildPendingSocialIntentContext(chat([source]), 'a')).toBe('');
    expect(buildSocialIntentOutcomes(chat([source]), reply)).toEqual([]);
    const allowed = normalizeConversation({ ...chat([source]), memberIds: ['a', 'b'] });
    expect(buildPendingSocialIntentContext(allowed, 'a')).toContain('intent');
  });
});
