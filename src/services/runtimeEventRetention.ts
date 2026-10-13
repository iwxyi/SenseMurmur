import type { RuntimeEventV2 } from '../types/runtimeEvent';

export function isCalendarStateEvent(event: RuntimeEventV2) {
  if (event.kind === 'calendar_item_patch') return true;
  if (event.kind !== 'event_candidate' && event.kind !== 'artifact') return false;
  const payload = event.payload as Record<string, unknown> | undefined;
  const kind = payload?.eventKind;
  if (kind === 'status_update' && (payload?.reasonType === 'world_calendar_upcoming_reminder'
    || payload?.reasonType === 'world_attention_calendar_reminder')) return true;
  return kind === 'social_outing' || kind === 'travel_plan' || kind === 'calendar_reminder';
}

export function getCalendarStateEventIds(events: RuntimeEventV2[]) {
  const stateIds = new Set(events.filter(isCalendarStateEvent).map((event) => event.id));
  const handledSummaries = new Set([...stateIds].map((id) => `handled_social_event:${id}`));
  for (const event of events) {
    if (event.kind === 'artifact' && handledSummaries.has(event.summary)) stateIds.add(event.id);
  }
  return stateIds;
}

// Calendar patches are incremental state, so retaining only the latest loses fields.
export function retainRuntimeEvents(events: RuntimeEventV2[], historyLimit: number) {
  const calendarIds = getCalendarStateEventIds(events);
  const history = events.filter((event) => !calendarIds.has(event.id));
  const historyIds = new Set((historyLimit > 0 ? history.slice(-historyLimit) : [])
    .map((event) => event.id));
  return events.filter((event) => calendarIds.has(event.id) || historyIds.has(event.id));
}
