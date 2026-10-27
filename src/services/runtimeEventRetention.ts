import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { getSocialIntentStateEventIds } from './socialIntentArtifact';

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
  const stateIds = getCalendarStateEventIds(events);
  getSocialIntentStateEventIds(events, stateIds).forEach((id) => stateIds.add(id));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Keep one cursor and one appointment per actor across ordinary history trimming.
  const latestMomentCursor = new Map<string, RuntimeEventV2>();
  const latestMomentSchedule = new Map<string, RuntimeEventV2>();
  for (const event of events) {
    const payload = event.payload as { artifactType?: string; processedThroughAt?: number };
    if (event.kind !== 'artifact' || !event.actorIds?.[0]) continue;
    if (payload.artifactType === 'daily_moment_processed') {
      const previous = latestMomentCursor.get(event.actorIds[0]);
      if (!previous || (payload.processedThroughAt || 0) > ((previous.payload as { processedThroughAt?: number }).processedThroughAt || 0)) {
        latestMomentCursor.set(event.actorIds[0], event);
      }
    } else if (payload.artifactType === 'daily_moment_schedule') {
      const previous = latestMomentSchedule.get(event.actorIds[0]);
      if (!previous || event.createdAt > previous.createdAt) latestMomentSchedule.set(event.actorIds[0], event);
    }
  }
  latestMomentCursor.forEach((event) => stateIds.add(event.id));
  latestMomentSchedule.forEach((event) => stateIds.add(event.id));
  // Today's processed posts remain evidence for the daily limit and publishing cooldown.
  for (const event of events) {
    const payload = event.payload as { artifactType?: string; eventKind?: string; candidateId?: string; processedAt?: number };
    if (event.kind === 'artifact' && (payload.artifactType === 'daily_moment_skip' || payload.artifactType === 'daily_moment_schedule')
      && event.createdAt >= today.getTime()) stateIds.add(event.id);
    if (event.kind === 'artifact' && payload.artifactType === 'moment_text'
      && payload.eventKind === 'post_moment' && (payload.processedAt || event.createdAt) >= today.getTime()) {
      stateIds.add(event.id);
      if (payload.candidateId) {
        stateIds.add(payload.candidateId);
        events.filter((item) => item.summary === `handled_social_event:${payload.candidateId}`)
          .forEach((item) => stateIds.add(item.id));
      }
    }
  }
  const history = events.filter((event) => !stateIds.has(event.id));
  const historyIds = new Set((historyLimit > 0 ? history.slice(-historyLimit) : [])
    .map((event) => event.id));
  return events.filter((event) => stateIds.has(event.id) || historyIds.has(event.id));
}
