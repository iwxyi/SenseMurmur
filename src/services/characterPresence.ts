import type { AICharacter, CharacterPresenceState } from '../types/character';
import type { DriverMessageCommitTransition, GroupChat } from '../types/chat';
import type { Message, MessageActivityUpdate, MessagePresenceUpdate } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { projectWorldCalendar } from './worldRuntimeProjection';

const MIN_AWAY_MINUTES = 3;
const MAX_AWAY_MINUTES = 30 * 24 * 60;

type PresenceMessage = Pick<Message, 'id' | 'senderId' | 'metadata'> & Partial<Pick<Message, 'content' | 'type' | 'isDeleted'>>;

function canCommitActivity(message: PresenceMessage) {
  return message.senderId !== 'user' && (!message.type || message.type === 'ai')
    && !message.isDeleted && !message.metadata?.withdrawal?.withdrawn
    && (!message.metadata?.visibility || message.metadata.visibility === 'public');
}

function normalizeDurationMinutes(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 30;
  return Math.max(MIN_AWAY_MINUTES, Math.min(MAX_AWAY_MINUTES, Math.round(value)));
}

function cleanPresenceText(value: string | undefined, max = 80) {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return normalized ? normalized.slice(0, max) : undefined;
}

export function buildPresencePatchFromMessage(params: {
  message: PresenceMessage;
  now?: number;
}): Partial<AICharacter> | null {
  const update = normalizePresenceUpdate(params.message.metadata?.presenceUpdate);
  if (!update || !canCommitActivity(params.message)
    || (update.evidenceText && !params.message.content?.includes(update.evidenceText))) return null;
  const now = typeof params.now === 'number' && Number.isFinite(params.now) ? Math.round(params.now) : Date.now();
  const status = update.status === 'away' ? 'away' : 'online';
  const presence: CharacterPresenceState = {
    status,
    activity: cleanPresenceText(update.activity, 60),
    reason: cleanPresenceText(update.reason, 100),
    unavailableUntil: status === 'away'
      ? now + normalizeDurationMinutes(update.durationMinutes) * 60_000
      : undefined,
    updatedAt: now,
    lastAwayAt: status === 'away' ? now : undefined,
    sourceMessageId: params.message.id,
  };
  return { presence };
}

export function canUpdateSpeakerActivity(chat: GroupChat, speaker: Pick<AICharacter, 'id' | 'presence'>, calendarItemId: string): boolean {
  return speaker.presence?.calendarItemId === calendarItemId || Boolean(chat.runtimeEventsV2?.some((event) => (
    event.kind === 'calendar_item_patch'
    && (!event.visibility || event.visibility === 'public')
    && (event.payload as Record<string, unknown>).calendarItemId === calendarItemId
    && event.actorIds?.includes(speaker.id)
  )));
}

export function applyPresenceUpdateToTransition(params: {
  transition: DriverMessageCommitTransition;
  message: PresenceMessage;
  chat?: GroupChat;
  characters?: AICharacter[];
  now?: number;
}): DriverMessageCommitTransition {
  const now = params.now ?? Date.now();
  let patch = buildPresencePatchFromMessage({ message: params.message, now });
  if (!canCommitActivity(params.message) || (params.chat && !params.chat.memberIds.includes(params.message.senderId))) return params.transition;
  const speaker = params.characters?.find((character) => character.id === params.message.senderId);
  const lastAwayAt = speaker?.presence?.lastAwayAt
    ?? (speaker?.presence?.status === 'away' ? speaker.presence.updatedAt : undefined);
  const activity = normalizeActivityUpdate(params.message.metadata?.activityUpdate);
  const validActivity = activity && params.message.content?.includes(activity.evidenceText) ? activity : null;
  const calendarItemId = validActivity?.calendarItemId || `actor-activity-${params.message.id}`;
  const events: RuntimeEventV2[] = [];
  const addEvent = (id: string, payload: Record<string, unknown>, summary: string) => {
    if (!params.chat) return;
    events.push({ id, conversationId: params.chat.id, kind: 'calendar_item_patch', createdAt: now,
      actorIds: [params.message.senderId], evidenceMessageIds: [params.message.id],
      summary, visibility: 'public', payload: { ...payload, source: 'actor_activity' } });
  };
  if (validActivity && params.chat) {
    patch = null;
    // Only the speaker's own activity records can be updated through this channel.
    const currentEvents = new Map((params.transition.chatPatch.runtimeEventsV2 || params.chat.runtimeEventsV2 || []).map((event) => [event.id, event]));
    params.transition.chatRuntimeDelta?.runtimeEventsV2?.upserts.forEach((event) => currentEvents.set(event.id, event));
    const currentChat = { ...params.chat, runtimeEventsV2: [...currentEvents.values()] };
    if (validActivity.calendarItemId && !canUpdateSpeakerActivity(currentChat,
      speaker || { id: params.message.senderId }, validActivity.calendarItemId)) return params.transition;
    const existing = validActivity.calendarItemId
      ? projectWorldCalendar([currentChat], params.characters || [], { now }).items.find((item) => item.id === calendarItemId)
      : undefined;
    const linkedPresence = speaker?.presence?.calendarItemId === calendarItemId ? speaker.presence : undefined;
    const startAt = validActivity.startsNow ? now : validActivity.startAt
      ?? existing?.startAt ?? (validActivity.status === 'in_progress' ? linkedPresence?.updatedAt ?? now : undefined);
    const needsAwayWindow = validActivity.availability === 'away' && existing?.endAt == null
      && linkedPresence?.unavailableUntil == null && validActivity.durationMinutes === undefined;
    const durationMinutes = validActivity.durationMinutes
      ?? existing?.durationMinutes ?? (needsAwayWindow ? 30 : undefined);
    // An ongoing activity's explicit duration describes the time remaining from this update.
    const timingChanged = validActivity.startsNow || validActivity.startAt !== undefined || validActivity.durationMinutes !== undefined;
    const durationOrigin = validActivity.status === 'in_progress' && !validActivity.startsNow && validActivity.startAt === undefined
      && validActivity.durationMinutes !== undefined ? now : startAt;
    const endAt = timingChanged || !existing
      ? durationOrigin !== undefined && durationMinutes !== undefined ? durationOrigin + durationMinutes * 60_000 : undefined
      : existing.endAt ?? linkedPresence?.unavailableUntil
        ?? (needsAwayWindow && durationMinutes !== undefined ? now + durationMinutes * 60_000 : undefined);
    const isCurrent = validActivity.status === 'in_progress' && startAt !== undefined && startAt <= now
      && (endAt === undefined || endAt > now);
    const activityStatus = validActivity.status === 'in_progress' && startAt !== undefined && startAt > now
      ? 'planned' : validActivity.status;
    const participantIds = Array.from(new Set([params.message.senderId,
      ...(validActivity.participantIds || []).filter((id) => params.chat?.memberIds.includes(id))]));
    addEvent(`actor-activity-event-${params.message.id}`, {
      calendarItemId, title: validActivity.title, kind: validActivity.kind,
      status: activityStatus,
      ...(existing ? {
        addParticipantIds: participantIds,
        addParticipantStates: Object.fromEntries(participantIds.map((id) => [id,
          id === params.message.senderId ? 'going' : existing.participantStates[id] || 'invited'])),
      } : {
        participantIds, participantStates: Object.fromEntries(participantIds.map((id) => [id, id === params.message.senderId ? 'going' : 'invited'])),
      }),
      startAt, endAt: validActivity.status === 'completed' || validActivity.status === 'cancelled' ? now : endAt,
      durationMinutes, timeHint: validActivity.timeHint, locationHint: validActivity.locationHint,
      availabilityByActor: validActivity.availability ? { [params.message.senderId]: validActivity.availability } : undefined,
      evidenceText: validActivity.evidenceText,
    }, validActivity.title);
    const availability = validActivity.availability ?? (timingChanged ? linkedPresence?.status : undefined);
    if (isCurrent && availability) {
      patch = { presence: { status: availability, activity: validActivity.title,
        unavailableUntil: availability === 'away' ? endAt : undefined,
        updatedAt: now, sourceMessageId: params.message.id, calendarItemId,
        locationHint: validActivity.locationHint ?? existing?.locationHint ?? linkedPresence?.locationHint } };
    }
    if ((activityStatus === 'completed' || activityStatus === 'cancelled' || activityStatus === 'planned')
      && speaker?.presence?.calendarItemId === calendarItemId) {
      patch = { presence: { status: 'online', updatedAt: now, sourceMessageId: params.message.id } };
    }
  } else if (patch?.presence?.status === 'away') {
    patch.presence.calendarItemId = calendarItemId;
    addEvent(`actor-activity-event-${params.message.id}`, {
      calendarItemId, kind: 'activity', status: 'in_progress', title: patch.presence.activity || '暂时离开',
      participantIds: [params.message.senderId], participantStates: { [params.message.senderId]: 'going' },
      startAt: now, endAt: patch.presence.unavailableUntil,
      durationMinutes: (patch.presence.unavailableUntil! - now) / 60_000,
      availabilityByActor: { [params.message.senderId]: 'away' },
    }, patch.presence.activity || '暂时离开');
  }
  if (patch?.presence && speaker?.presence?.calendarItemId
    && patch.presence.calendarItemId !== speaker.presence.calendarItemId
    && validActivity?.calendarItemId !== speaker.presence.calendarItemId) {
    addEvent(`actor-return-event-${params.message.id}`, {
      calendarItemId: speaker.presence.calendarItemId, status: 'completed', endAt: now,
      durationMinutes: Math.max(1, (now - speaker.presence.updatedAt) / 60_000),
    }, '角色已结束此前活动');
  }
  if (patch?.presence) {
    patch.presence.lastAwayAt = patch.presence.status === 'away'
      ? speaker?.presence?.status === 'away' && speaker.presence.calendarItemId === patch.presence.calendarItemId ? lastAwayAt : now
      : lastAwayAt;
  }
  if (!patch && !events.length) return params.transition;
  const characterPatches = [...params.transition.characterPatches];
  const existingIndex = characterPatches.findIndex((item) => item.characterId === params.message.senderId);
  if (patch && existingIndex >= 0) {
    characterPatches[existingIndex] = {
      ...characterPatches[existingIndex],
      patch: {
        ...characterPatches[existingIndex].patch,
        ...patch,
      },
    };
  } else if (patch) {
    characterPatches.push({
      characterId: params.message.senderId,
      patch,
    });
  }
  const previousDelta = params.transition.chatRuntimeDelta?.runtimeEventsV2;
  const eventById = new Map((params.transition.chatPatch.runtimeEventsV2 || params.chat?.runtimeEventsV2 || []).map((event) => [event.id, event]));
  previousDelta?.upserts.forEach((event) => eventById.set(event.id, event));
  events.forEach((event) => eventById.set(event.id, event));
  const orderedIds = Array.from(new Set([
    ...(previousDelta?.orderedIds || Array.from(eventById.keys())), ...events.map((event) => event.id),
  ]));
  return {
    ...params.transition,
    characterPatches,
    chatPatch: events.length ? {
      ...params.transition.chatPatch,
      runtimeEventsV2: orderedIds.flatMap((id) => eventById.get(id) || []),
    } : params.transition.chatPatch,
    ...(events.length ? { chatRuntimeDelta: {
      ...params.transition.chatRuntimeDelta,
      runtimeEventsV2: {
        ...(previousDelta ? (previousDelta.baseIds ? { baseIds: previousDelta.baseIds } : {})
          : { baseIds: (params.chat?.runtimeEventsV2 || []).map((event) => event.id) }),
        orderedIds,
        upserts: [...(params.transition.chatRuntimeDelta?.runtimeEventsV2?.upserts || []), ...events],
      },
    } } : {}),
  };
}

export function getEffectiveCharacterPresence(character: Pick<AICharacter, 'presence'>, now = Date.now()): CharacterPresenceState {
  const presence = character.presence;
  if (!presence || presence.status !== 'away') return { status: 'online', updatedAt: presence?.updatedAt || 0 };
  if (presence.unavailableUntil && presence.unavailableUntil <= now) {
    return {
      ...presence,
      status: 'online',
    };
  }
  return presence;
}

export function isCharacterAvailableForScheduling(character: Pick<AICharacter, 'presence'>, now = Date.now()) {
  return getEffectiveCharacterPresence(character, now).status !== 'away';
}

export function normalizePresenceUpdate(value: MessagePresenceUpdate | null | undefined): MessagePresenceUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const status = value.status === 'away' ? 'away' : value.status === 'online' ? 'online' : null;
  if (!status) return null;
  return {
    status,
    activity: cleanPresenceText(value.activity, 60),
    reason: cleanPresenceText(value.reason, 100),
    durationMinutes: status === 'away' ? normalizeDurationMinutes(value.durationMinutes) : undefined,
    evidenceText: typeof value.evidenceText === 'string' ? value.evidenceText.trim().slice(0, 240) : undefined,
  };
}

export function normalizeActivityUpdate(value: MessageActivityUpdate | null | undefined): MessageActivityUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const title = cleanPresenceText(value.title, 80);
  const evidenceText = typeof value.evidenceText === 'string' ? value.evidenceText.trim().slice(0, 240) : '';
  if (!title || !evidenceText || !['activity', 'travel', 'rest', 'preparation', 'blocked_time', 'reminder'].includes(value.kind)
    || !['planned', 'in_progress', 'completed', 'cancelled'].includes(value.status)) return null;
  return {
    title, evidenceText, kind: value.kind, status: value.status,
    calendarItemId: cleanPresenceText(value.calendarItemId, 160),
    participantIds: Array.isArray(value.participantIds) ? value.participantIds.filter((id) => typeof id === 'string') : undefined,
    startsNow: value.startsNow === true,
    startAt: typeof value.startAt === 'number' && Number.isFinite(value.startAt) && value.startAt >= 0 ? value.startAt : undefined,
    durationMinutes: typeof value.durationMinutes === 'number' && Number.isFinite(value.durationMinutes) && value.durationMinutes > 0
      ? normalizeDurationMinutes(value.durationMinutes) : undefined,
    timeHint: cleanPresenceText(value.timeHint, 100), locationHint: cleanPresenceText(value.locationHint, 100),
    availability: value.availability === 'away' || value.availability === 'online' ? value.availability : undefined,
  };
}
