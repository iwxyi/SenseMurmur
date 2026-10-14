import { describe, expect, it } from 'vitest';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { retainRuntimeEvents } from './runtimeEventRetention';
import { hasPendingAutoSocialEventCandidate } from '../hooks/useChatAutoSocialFlow';
import { normalizeConversation } from '../types/chat';

describe('calendar event retention', () => {
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
    expect(hasPendingAutoSocialEventCandidate(normalizeConversation({ id: 'chat', runtimeEventsV2: retained }))).toBe(false);
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
