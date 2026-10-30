import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';
import type { DirectorBeatType } from './directorIntent';

export type UserGuidanceIntentKind = 'topic_shift' | 'direct_reply' | 'media_request';

export interface UserGuidanceMediaRequest {
  kind: 'image' | 'video';
  subjectActorIds: string[];
  subjectText: string;
  actionText: string;
}

export interface UserGuidanceIntent {
  kind: UserGuidanceIntentKind;
  rawText: string;
  actorIds: string[];
  mentionedActorIds: string[];
  hardConstraintActorIds?: string[];
  suppressedActorIds?: string[];
  deferredActorIds?: string[];
  hasHardConstraints?: boolean;
  mediaRequest?: UserGuidanceMediaRequest;
  voiceRequest?: boolean;
  stickerRequest?: boolean;
  focusText: string;
  beatType: DirectorBeatType;
  pressure: number;
  maxTurns: number;
  minTargetTurns?: number;
  reason: string;
}

const GUIDANCE_KINDS: UserGuidanceIntentKind[] = ['topic_shift', 'direct_reply', 'media_request'];
const BEAT_TYPES: DirectorBeatType[] = ['answer', 'challenge', 'defend', 'escalate', 'cool_down', 'reveal', 'deflect', 'summarize', 'invite'];

function compactText(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function knownUniqueIds(value: unknown, characters: AICharacter[]) {
  if (!Array.isArray(value)) return [];
  const known = new Set(characters.map((character) => character.id));
  return value.filter((id, index, array): id is string => (
    typeof id === 'string' && known.has(id) && array.indexOf(id) === index
  ));
}

export function createUndirectedUserGuidance(rawText: string): UserGuidanceIntent | null {
  const normalized = compactText(rawText, 2_000);
  if (!normalized) return null;
  return {
    kind: 'topic_shift', rawText: normalized, actorIds: [], mentionedActorIds: [],
    hardConstraintActorIds: [], suppressedActorIds: [], deferredActorIds: [],
    hasHardConstraints: false, voiceRequest: false, stickerRequest: false, focusText: normalized,
    beatType: 'invite', pressure: 0.5, maxTurns: 1,
    reason: '用户刚刚发言，下一轮应自然接住其真实意图。',
  };
}

/** Validate model output without inferring semantics from message prose. */
export function normalizeUserGuidanceIntent(value: unknown, rawText: string, characters: AICharacter[]): UserGuidanceIntent | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const fallback = createUndirectedUserGuidance(rawText);
  if (!fallback) return null;
  const kind = GUIDANCE_KINDS.includes(source.kind as UserGuidanceIntentKind) ? source.kind as UserGuidanceIntentKind : fallback.kind;
  const actorIds = knownUniqueIds(source.actorIds, characters);
  const mentionedActorIds = knownUniqueIds(source.mentionedActorIds, characters);
  const suppressedActorIds = knownUniqueIds(source.suppressedActorIds, characters).filter((id) => !actorIds.includes(id));
  const deferredActorIds = knownUniqueIds(source.deferredActorIds, characters)
    .filter((id) => !actorIds.includes(id) && !suppressedActorIds.includes(id));
  const hasHardConstraints = source.hasHardConstraints === true;
  const hardConstraintActorIds = hasHardConstraints ? knownUniqueIds(source.hardConstraintActorIds, characters) : [];
  const beatType = BEAT_TYPES.includes(source.beatType as DirectorBeatType)
    ? source.beatType as DirectorBeatType
    : kind === 'direct_reply' || kind === 'media_request' ? 'answer' : 'invite';
  const mediaSource = source.mediaRequest && typeof source.mediaRequest === 'object' ? source.mediaRequest as Record<string, unknown> : null;
  const mediaRequest = kind === 'media_request' && (mediaSource?.kind === 'image' || mediaSource?.kind === 'video')
    ? {
        kind: mediaSource.kind as 'image' | 'video',
        subjectActorIds: knownUniqueIds(mediaSource.subjectActorIds, characters),
        subjectText: compactText(mediaSource.subjectText, 160),
        actionText: compactText(mediaSource.actionText, 240) || fallback.rawText,
      }
    : undefined;
  return {
    kind, rawText: fallback.rawText, actorIds, mentionedActorIds, hardConstraintActorIds,
    suppressedActorIds, deferredActorIds, hasHardConstraints, mediaRequest,
    voiceRequest: source.voiceRequest === true,
    stickerRequest: source.stickerRequest === true,
    focusText: compactText(source.focusText, 320) || fallback.focusText,
    beatType,
    pressure: clamp(source.pressure, 0, 1, fallback.pressure),
    maxTurns: Math.round(clamp(source.maxTurns, 1, 8, fallback.maxTurns)),
    minTargetTurns: actorIds.length ? Math.round(clamp(source.minTargetTurns, 1, 5, 1)) : undefined,
    reason: compactText(source.reason, 240) || fallback.reason,
  };
}

/** Read only guidance assessed at message ingress and persisted with the message. */
export function readStoredUserGuidanceIntent(message: Pick<Message, 'metadata'>, characters: AICharacter[]): UserGuidanceIntent | null {
  const stored = message.metadata?.runtimeDecision?.directorIntent?.userGuidance;
  if (!stored || typeof stored !== 'object') return null;
  return normalizeUserGuidanceIntent(stored, typeof stored.rawText === 'string' ? stored.rawText : '', characters);
}

/** Compatibility fallback for old messages and synchronous callers. */
export function parseUserGuidanceIntent(text: string, _characters: AICharacter[]): UserGuidanceIntent | null {
  void _characters;
  return createUndirectedUserGuidance(text);
}

export function getGuidanceTargetActorIds(guidance: UserGuidanceIntent | null | undefined) {
  if (!guidance) return [];
  if (guidance.actorIds.length) return guidance.actorIds;
  if (guidance.hasHardConstraints) return [];
  if (guidance.kind === 'media_request') return guidance.mentionedActorIds;
  return guidance.mentionedActorIds;
}

export function getGuidanceMemoryTargetActorIds(guidance: UserGuidanceIntent | null | undefined, characters: AICharacter[], speakerId?: string | null) {
  if (!guidance) return [];
  const actorIds = knownUniqueIds(guidance.actorIds || [], characters);
  const subjectActorIds = knownUniqueIds(guidance.mediaRequest?.subjectActorIds || [], characters);
  const suppressedActorIds = knownUniqueIds(guidance.suppressedActorIds || [], characters);
  const mentionedActorIds = knownUniqueIds(guidance.mentionedActorIds || [], characters).filter((id) => !suppressedActorIds.includes(id));
  const withoutSpeaker = (ids: string[]) => speakerId ? ids.filter((id) => id !== speakerId) : ids;
  const groups = [withoutSpeaker(subjectActorIds), withoutSpeaker(mentionedActorIds.filter((id) => !actorIds.includes(id))), withoutSpeaker(mentionedActorIds), withoutSpeaker(actorIds)];
  return groups.find((group) => group.length) || [];
}
