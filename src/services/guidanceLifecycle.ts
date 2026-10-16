import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { DirectorBeatType, DirectorIntent } from './directorIntent';
import { collectGuidanceProgressAfterTimestamp } from './guidanceExecution';
import { getGuidanceTargetActorIds, readStoredUserGuidanceIntent, type UserGuidanceIntent } from './userGuidanceIntent';

function uniqueActorIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id, index, array): id is string => typeof id === 'string' && id.trim().length > 0 && array.indexOf(id) === index);
}

function countAiResponsesAfter(messages: Message[], timestamp: number) {
  return messages.filter((message) => message.type === 'ai' && !message.isDeleted && message.timestamp > timestamp).length;
}

export function getPendingTargetActorIdsAfter(messages: Message[], timestamp: number, guidance: UserGuidanceIntent, characters: AICharacter[]) {
  const progress = collectGuidanceProgressAfterTimestamp(messages, timestamp, guidance, characters);
  const minTargetTurns = Math.max(1, Math.round(guidance.minTargetTurns || 1));
  return uniqueActorIds(guidance.actorIds.filter((actorId) => minTargetTurns <= 1
    ? !progress.completedActorIds.has(actorId)
    : progress.matchedMessages.filter((message) => message.senderId === actorId).length < minTargetTurns));
}

export function isRestraintWindowActive(messages: Message[], timestamp: number, guidance: UserGuidanceIntent, characters: AICharacter[]) {
  if (!(guidance.suppressedActorIds?.length || guidance.deferredActorIds?.length)) return false;
  const minTargetTurns = Math.max(1, Math.round(guidance.minTargetTurns || 1));
  const remainingWindowTurns = Math.max(0, Math.round(guidance.maxTurns || minTargetTurns) - minTargetTurns);
  const progress = collectGuidanceProgressAfterTimestamp(messages, timestamp, guidance, characters);
  const targetMessages = progress.matchedMessages
    .filter((message) => guidance.actorIds.includes(message.senderId))
    .sort((left, right) => left.timestamp - right.timestamp);
  const floorSatisfiedAt = targetMessages[minTargetTurns - 1]?.timestamp;
  const consumed = typeof floorSatisfiedAt === 'number' ? countAiResponsesAfter(messages, floorSatisfiedAt) : 0;
  return consumed < remainingWindowTurns;
}

function resolveDirectorBeatType(intent: unknown): DirectorBeatType {
  if (intent === 'force_reply') return 'answer';
  if (intent === 'cool_down') return 'cool_down';
  if (intent === 'reveal') return 'reveal';
  if (intent === 'redirect') return 'deflect';
  if (intent === 'summarize') return 'summarize';
  if (intent === 'escalate') return 'escalate';
  return 'invite';
}

// Scheduling and prompt projection must consume the same remaining guidance.
export function resolveActiveDirectorIntervention(chat: GroupChat, characters: AICharacter[], messages: Message[], now: number, ignoreBefore?: number | null) {
  const events = (chat.runtimeEventsV2 || []).slice().reverse().filter((event) => event.kind === 'director_intervention');
  for (const event of events) {
    if (typeof ignoreBefore === 'number' && event.createdAt < ignoreBefore) continue;
    const payload = event.payload as Record<string, unknown>;
    const expiresAt = typeof payload.expiresAt === 'number' ? payload.expiresAt : event.createdAt + 10 * 60_000;
    if (now > expiresAt) continue;
    const guidance = typeof payload.userGuidance === 'object' && payload.userGuidance
      ? payload.userGuidance as UserGuidanceIntent
      : null;
    const targeted = Boolean(guidance?.actorIds.length);
    const pendingActorIds = targeted && guidance ? getPendingTargetActorIdsAfter(messages, event.createdAt, guidance, characters) : [];
    const restraintActive = Boolean(targeted && !pendingActorIds.length && guidance && isRestraintWindowActive(messages, event.createdAt, guidance, characters));
    if (targeted) {
      if (!pendingActorIds.length && !restraintActive) continue;
    } else {
      const maxTurns = typeof payload.maxTurns === 'number' ? Math.max(1, Math.round(payload.maxTurns)) : 1;
      if (countAiResponsesAfter(messages, event.createdAt) >= maxTurns) continue;
    }
    const targetActorIds = uniqueActorIds(payload.targetActorIds);
    const intent: DirectorIntent = {
      source: 'user_message',
      targetLineId: typeof payload.targetLineId === 'string' ? payload.targetLineId : undefined,
      beatType: resolveDirectorBeatType(payload.intent),
      targetActorIds: pendingActorIds.length ? pendingActorIds : restraintActive ? [] : targetActorIds.length ? targetActorIds : uniqueActorIds(getGuidanceTargetActorIds(guidance)),
      pressure: Math.max(0, Math.min(1, typeof payload.pressure === 'number' && Number.isFinite(payload.pressure) ? payload.pressure : 0.86)),
      reason: (typeof payload.text === 'string' ? payload.text : event.summary) || 'A director intervention is steering the next room beat.',
      userGuidance: guidance,
    };
    return { event, intent };
  }
  return null;
}

export interface HumanGuidanceResolution {
  intent: DirectorIntent | null;
  timestamp: number | null;
}

function countConsumedGuidanceTurnsAfter(messages: Message[], timestamp: number, guidance: UserGuidanceIntent, characters: AICharacter[]) {
  return collectGuidanceProgressAfterTimestamp(messages, timestamp, guidance, characters).consumedTurns;
}

function isExplicitPersistentGuidance(guidance: UserGuidanceIntent) {
  if (guidance.actorIds.length) return true;
  if (guidance.kind === 'media_request') return true;
  if (guidance.hasHardConstraints) return true;
  return guidance.kind === 'direct_reply' && Boolean(guidance.focusText?.trim());
}

function guidanceIntentToDirectorIntent(guidance: UserGuidanceIntent, targetActorIds: string[]): DirectorIntent {
  return {
    source: 'user_message',
    beatType: guidance.beatType,
    targetActorIds,
    pressure: guidance.pressure,
    reason: guidance.reason,
    userGuidance: guidance,
  };
}

export function resolveLatestActiveUserGuidance(characters: AICharacter[], messages: Message[], now = Date.now()): HumanGuidanceResolution {
  const humanMessages = messages
    .filter((message) => !message.isDeleted && (message.type === 'user' || message.type === 'god'))
    // "speak as" belongs to character participation, not topic/director guidance.
    .filter((message) => !(message.type === 'user' && Boolean(message.metadata?.manualSpeaker)))
    .slice()
    .reverse();

  for (const message of humanMessages) {
    const guidance = readStoredUserGuidanceIntent(message, characters);
    if (!guidance || !isExplicitPersistentGuidance(guidance)) continue;
    if (now > message.timestamp + 10 * 60_000) return { intent: null, timestamp: message.timestamp };

    if (guidance.actorIds.length) {
      const pendingActorIds = getPendingTargetActorIdsAfter(messages, message.timestamp, guidance, characters);
      if (pendingActorIds.length) {
        return {
          intent: guidanceIntentToDirectorIntent(guidance, pendingActorIds),
          timestamp: message.timestamp,
        };
      }
      if (isRestraintWindowActive(messages, message.timestamp, guidance, characters)) {
        return {
          intent: guidanceIntentToDirectorIntent(guidance, []),
          timestamp: message.timestamp,
        };
      }
      return { intent: null, timestamp: message.timestamp };
    }

    if (countConsumedGuidanceTurnsAfter(messages, message.timestamp, guidance, characters) >= guidance.maxTurns) {
      return { intent: null, timestamp: message.timestamp };
    }
    return {
      intent: guidanceIntentToDirectorIntent(guidance, uniqueActorIds(getGuidanceTargetActorIds(guidance))),
      timestamp: message.timestamp,
    };
  }

  return { intent: null, timestamp: null };
}
