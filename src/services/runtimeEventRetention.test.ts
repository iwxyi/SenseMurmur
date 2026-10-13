import { describe, expect, it } from 'vitest';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { retainRuntimeEvents } from './runtimeEventRetention';
import { hasPendingAutoSocialEventCandidate } from '../hooks/useChatAutoSocialFlow';
import { normalizeConversation } from '../types/chat';

describe('calendar event retention', () => {
  it('keeps the handled marker so an old retained outing is not executed again', () => {
    const candidate: RuntimeEventV2 = { id: 'outing', conversationId: 'chat', kind: 'event_candidate', createdAt: 1, visibility: 'public', summary: 'outing', payload: { eventKind: 'social_outing' } };
    const marker: RuntimeEventV2 = { ...candidate, id: 'handled', kind: 'artifact', createdAt: 2, summary: 'handled_social_event:outing', payload: {} };
    const history: RuntimeEventV2[] = Array.from({ length: 200 }, (_, index) => ({ ...candidate, id: `history-${index}`, kind: 'room_shift', createdAt: index + 3, payload: {} }));
    const retained = retainRuntimeEvents([candidate, marker, ...history], 120);
    expect(retained).toHaveLength(122);
    expect(hasPendingAutoSocialEventCandidate(normalizeConversation({ id: 'chat', runtimeEventsV2: retained }))).toBe(false);
    expect(retainRuntimeEvents(retained, 0)).toEqual([candidate, marker]);
  });
});
