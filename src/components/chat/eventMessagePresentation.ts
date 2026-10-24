import type { Message } from '../../types/message';
import { parseRuntimeEvent } from '../../services/runtimeEventFactory';
import { shouldHideEmptyConflictEvent } from './messageBubbleEventHelpers';

export interface EventRenderFlags {
  developerMode: boolean;
  showRelationshipEvents: boolean;
  showAffectEvents: boolean;
  showConflictEvents: boolean;
  showStateEvents: boolean;
  showMemoryDistillationEvents: boolean;
  showDetailedFactHints: boolean;
  showCalendarEvents: boolean;
  showMemoryDebug: boolean;
  showLocalInterceptionHints: boolean;
}

export interface EventDisplayPayload {
  eventType?: string;
  title?: string;
  summary?: string;
  pair?: string[];
  metrics?: unknown;
}

export function isConflictDeveloperEvent(eventType: string | undefined) {
  return ['conflict_focus_shift', 'conflict_axis_shift'].includes(String(eventType || ''));
}

export function isStateDeveloperEvent(eventType: string | undefined) {
  return ['world_state_shift', 'room_state_snapshot_v2', 'analysis_run_policy'].includes(String(eventType || ''));
}

export function isCalendarDeveloperEvent(eventType: unknown) {
  const value = String(eventType || '');
  return value === 'calendar_item_patch'
    || value === 'calendar_patch_apply_result'
    || value === 'calendar_activity'
    || value.startsWith('calendar_activity_');
}

export function shouldRenderDeveloperEvent(payload: { eventType?: string }, flags: Omit<EventRenderFlags, 'developerMode'>) {
  if (!payload?.eventType) return false;
  if (['group_relationship_shift', 'relationship_shift'].includes(String(payload.eventType))) return flags.showRelationshipEvents;
  if (['speaker_drift_shift', 'speaker_emotion_shift', 'target_emotion_shift'].includes(String(payload.eventType))) return flags.showAffectEvents;
  if (isConflictDeveloperEvent(payload.eventType)) return flags.showConflictEvents;
  if (isStateDeveloperEvent(payload.eventType)) return flags.showStateEvents;
  if (payload.eventType === 'detailed_fact_recorded') return flags.showDetailedFactHints;
  if (payload.eventType === 'memory_distillation') return flags.showMemoryDistillationEvents || flags.showMemoryDebug;
  if (isCalendarDeveloperEvent(payload.eventType)) return flags.showCalendarEvents;
  if (payload.eventType === 'memory_reactivation') return flags.showMemoryDebug;
  if (payload.eventType === 'local_interception') return flags.showLocalInterceptionHints;
  return false;
}

export function getRuntimeEventPayload(message: Message): EventDisplayPayload {
  const parsed = parseRuntimeEvent(message.content);
  return parsed || { title: '事件', summary: message.content };
}

export function shouldRenderEventMessage(message: Message, flags: EventRenderFlags) {
  if (message.type !== 'event') return false;
  const payload = getRuntimeEventPayload(message);
  if (payload.eventType === 'conversation_paused') return true;
  if (!flags.developerMode) return false;
  if (!shouldRenderDeveloperEvent(payload, flags)) return false;
  return !shouldHideEmptyConflictEvent(payload);
}
