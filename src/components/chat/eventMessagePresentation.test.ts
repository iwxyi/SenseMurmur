import { describe, expect, it } from 'vitest';
import { shouldRenderDeveloperEvent, shouldRenderEventMessage } from './eventMessagePresentation';
import type { Message } from '../../types/message';

const baseFlags = {
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

describe('eventMessagePresentation', () => {
  it('shows detailed fact hints only when both developer mode and their own switch are on', () => {
    const message = { type: 'event', content: JSON.stringify({ eventType: 'detailed_fact_recorded', summary: '新增 1 条详细事实' }) } as Message;
    expect(shouldRenderEventMessage(message, { ...baseFlags, developerMode: true })).toBe(false);
    expect(shouldRenderEventMessage(message, { ...baseFlags, developerMode: false, showDetailedFactHints: true })).toBe(false);
    expect(shouldRenderEventMessage(message, { ...baseFlags, developerMode: true, showMemoryDebug: true })).toBe(false);
    expect(shouldRenderEventMessage(message, { ...baseFlags, developerMode: true, showDetailedFactHints: true })).toBe(true);
  });
  it('renders analysis run policy events through the state-event switch', () => {
    expect(shouldRenderDeveloperEvent({ eventType: 'analysis_run_policy' }, baseFlags)).toBe(false);
    expect(shouldRenderDeveloperEvent({ eventType: 'analysis_run_policy' }, { ...baseFlags, showStateEvents: true })).toBe(true);
  });
});
