import { describe, expect, it } from 'vitest';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { retainRuntimeEvents } from './runtimeEventRetention';
import { hasPendingAutoSocialEventCandidate } from '../hooks/useChatAutoSocialFlow';
import { createTestChat } from '../test/fixtures';

describe('calendar event retention', () => {
  it('keeps only the newest daily moment cursor and a backdated post processed today', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const marker = (id: string, processedThroughAt: number): RuntimeEventV2 => ({
      id, conversationId: 'chat', kind: 'artifact', createdAt: today.getTime() - 86_400_000,
      actorIds: ['a'], visibility: 'role_private', summary: 'processed',
      payload: { artifactType: 'daily_moment_processed', processedThroughAt, decisionPolicyVersion: 2 },
    });
    const post: RuntimeEventV2 = { ...marker('post', 0), createdAt: today.getTime() - 5 * 86_400_000,
      visibility: 'derived_public', payload: { artifactType: 'moment_text', eventKind: 'post_moment',
        processedAt: today.getTime() + 1 } };
    expect(retainRuntimeEvents([marker('old', 1), marker('latest', 2), post], 0)
      .map((event) => event.id)).toEqual(['latest', 'post']);
  });

  it('keeps an overdue daily moment appointment after several days of unrelated events', () => {
    const appointment: RuntimeEventV2 = { id: 'appointment', conversationId: 'chat', kind: 'artifact',
      createdAt: Date.now() - 5 * 86_400_000, actorIds: ['a'], visibility: 'role_private',
      summary: 'scheduled', payload: { artifactType: 'daily_moment_schedule', memorySignature: 'pending', readyAt: Date.now() - 4 * 86_400_000 } };
    const history = Array.from({ length: 200 }, (_, index): RuntimeEventV2 => ({ ...appointment,
      id: `history-${index}`, kind: 'room_shift', createdAt: Date.now() - index, payload: {} }));
    expect(retainRuntimeEvents([appointment, ...history], 0)).toEqual([appointment]);
  });
  it('preserves unresolved social intents and prevents retained calendar intents resurrecting after completion', () => {
    const intent: RuntimeEventV2 = { id: 'intent', conversationId: 'chat', kind: 'artifact', createdAt: 1, visibility: 'derived_public', summary: 'pending',
      payload: { status: 'tentative', eventKind: 'check_in', initiatorId: 'a' } };
    expect(retainRuntimeEvents([intent], 0)).toEqual([intent]);
    const completed: RuntimeEventV2 = { ...intent, id: 'result', createdAt: 2, payload: { status: 'completed', intentId: 'intent' } };
    expect(retainRuntimeEvents([intent, completed], 0)).toEqual([]);
    const reminder = { ...intent, payload: { status: 'tentative', eventKind: 'status_update', initiatorId: 'a', reasonType: 'world_calendar_upcoming_reminder' } };
    expect(retainRuntimeEvents([reminder, completed], 0)).toEqual([reminder, completed]);
  });
  it.each([
    { eventKind: 'social_outing' },
    { eventKind: 'status_update', reasonType: 'world_calendar_upcoming_reminder' },
    { eventKind: 'status_update', reasonType: 'world_attention_calendar_reminder' },
  ])('keeps calendar sources and their handled marker beyond the history limit: %j', (payload) => {
    const candidate: RuntimeEventV2 = { id: 'outing', conversationId: 'chat', kind: 'event_candidate', createdAt: 1, visibility: 'public', summary: 'calendar source', payload };
    const marker: RuntimeEventV2 = { ...candidate, id: 'handled', kind: 'artifact', createdAt: 2, summary: 'handled_social_event:outing', payload: {} };
    const history: RuntimeEventV2[] = Array.from({ length: 200 }, (_, index) => ({ ...candidate, id: `history-${index}`, kind: 'room_shift', createdAt: index + 3, payload: {} }));
    const retained = retainRuntimeEvents([candidate, marker, ...history], 120);
    expect(retained).toHaveLength(122);
    expect(hasPendingAutoSocialEventCandidate(createTestChat({ id: 'chat', runtimeEventsV2: retained }))).toBe(false);
    expect(retainRuntimeEvents(retained, 0)).toEqual([candidate, marker]);
  });

  it('retains a reminder intent without retaining ordinary status updates', () => {
    const reminder: RuntimeEventV2 = { id: 'reminder', conversationId: 'chat', kind: 'artifact', createdAt: 1,
      visibility: 'pair_private', summary: 'pending reminder',
      payload: { eventKind: 'status_update', reasonType: 'world_calendar_upcoming_reminder', status: 'tentative' } };
    const ordinary = { ...reminder, id: 'ordinary', payload: { eventKind: 'status_update', reasonType: 'world_attention_status_update' } };
    expect(retainRuntimeEvents([reminder, ordinary], 0)).toEqual([reminder]);
  });
});
