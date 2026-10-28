import type { GroupChat } from '../types/chat';
import type { AICharacter } from '../types/character';
import type { ActorRef, RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';
import { buildAiIdSet, toActorRef } from './actorRefPresentation';
import { buildMomentCandidatePreview } from './momentTextBuilder';
import { isCompletedSocialArtifact } from './socialIntentArtifact';

export interface WorldCalendarSourceRef {
  conversationId: string;
  conversationName?: string;
  sourceDeleted?: boolean;
  eventIds: string[];
  weight: number;
  lastEvidenceAt: number;
}

export interface WorldCalendarItem {
  id: string;
  mergedItemIds?: string[];
  derivedFromItemId?: string;
  kind: 'activity' | 'travel' | 'reminder' | 'blocked_time' | 'rest' | 'preparation';
  status: 'tentative' | 'planned' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  title: string;
  activityType?: string;
  participantIds: string[];
  participantStates: Record<string, ParticipantScheduleState>;
  participantNames: string[];
  startAt?: number | null;
  endAt?: number | null;
  durationMinutes?: number | null;
  /** True when duration was inferred from a generic activity label. */
  durationEstimated?: boolean;
  timeHint?: string | null;
  locationHint?: string | null;
  availabilityByActor?: Record<string, 'online' | 'away'>;
  summary: string;
  sourceRefs: WorldCalendarSourceRef[];
  conflict?: {
    hasConflict: boolean;
    conflictWithItemIds: string[];
    participantIds: string[];
    participantNames: string[];
    overlapStartAt?: number | null;
    overlapEndAt?: number | null;
    suggestedDelayMinutes?: number | null;
    resolutionSuggestions?: Array<{
      itemId: string;
      strategy: 'delay_after_conflict';
      suggestedStartAt: number;
      suggestedEndAt?: number | null;
      delayMinutes: number;
      reason: string;
      basedOnItemId: string;
    }>;
    patchDrafts?: WorldCalendarPatchDraft[];
  } | null;
  updatedAt: number;
}

export type ParticipantScheduleState =
  | 'mentioned'
  | 'invited'
  | 'interested'
  | 'maybe'
  | 'going'
  | 'late'
  | 'left_early'
  | 'declined'
  | 'withdrawn'
  | 'no_show'
  | 'cancelled_by_dependency';

export interface WorldCalendarPatchDraft {
  eventType: 'calendar_item_patch';
  calendarItemId: string;
  patch: {
    startAt: number;
    endAt?: number | null;
    durationMinutes?: number | null;
  };
  reason: string;
  basedOnItemId: string;
}

export interface WorldCalendarProjectionResult {
  items: WorldCalendarItem[];
  patchDraftQueue: WorldCalendarPatchDraft[];
}

export interface WorldMomentItem {
  id: string;
  kind: 'post_moment' | 'status_update' | 'check_in' | 'react_to_moment';
  debugState?: 'candidate' | 'published';
  actorId?: string;
  actorName: string;
  title: string;
  text: string;
  media: Array<{
    assetId?: string;
    thumbnailAssetId?: string;
    url: string;
    thumbnailUrl?: string;
    fullUrl?: string;
    mimeType?: string;
    sizeBytes?: number;
    alt?: string;
    storage?: 'cloud_asset' | 'local_indexeddb' | 'inline';
  }>;
  debugEvidence: string[];
  activityType?: string;
  expectedArtifacts: string[];
  conversationId: string;
  conversationName: string;
  sourceRefs: Array<{
    conversationId: string;
    conversationName: string;
    eventIds: string[];
    weight: number;
    lastEvidenceAt: number;
  }>;
  visibility: RuntimeEventV2['visibility'];
  createdAt: number;
}

export interface WorldAttentionCandidateItem {
  id: string;
  actorId?: string;
  actorRef?: ActorRef;
  actorName: string;
  targetIds: string[];
  targetRefs?: ActorRef[];
  targetNames: string[];
  reason: string;
  confidence: number;
  conversationId: string;
  conversationName: string;
  createdAt: number;
}

export interface WorldAttentionStateItem {
  actorId: string;
  actorRef: ActorRef;
  actorName: string;
  targetId: string;
  targetRef: ActorRef;
  targetName: string;
  attentionScore: number;
  restraint: number;
  suggestedActions: Array<'check_in' | 'ask_followup' | 'private_message' | 'react_to_moment' | 'invite_activity' | 'calendar_reminder' | 'comfort' | 'share_moment'>;
  reasons: string[];
  latestEvidenceAt: number;
}

function getPayload(event: RuntimeEventV2) {
  return event.payload as Record<string, unknown>;
}

function getString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function getStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function getNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getStringRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0));
}

function isPrivateMomentVisibility(visibility: RuntimeEventV2['visibility']) {
  return visibility === 'pair_private' || visibility === 'role_private' || visibility === 'moderator_only';
}

function resolveMomentPublicText(event: RuntimeEventV2, payload: Record<string, unknown>) {
  if (isPrivateMomentVisibility(event.visibility)) {
    const explicitPublicText = getString(payload.publicText) || getString(payload.publicSummary) || getString(payload.publicExcerpt);
    return explicitPublicText || getString(payload.title) || event.summary || '来自私域互动的动态更新';
  }
  return getString(payload.text) || getString(payload.publicText) || getString(payload.summary) || event.summary;
}

function isLegacyMomentRecordText(value: string) {
  return /发了一条动态[：:]/.test(value)
    || /发了一条动态，(记录了|写下了|表达了|配了一张)/.test(value);
}

function getMomentMedia(payload: Record<string, unknown>) {
  const media: WorldMomentItem['media'] = [];
  const addMedia = (item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    const thumbnailUrl = getString(record.thumbnailUrl) || getString(record.thumbnail) || getString(record.url) || getString(record.imageUrl) || getString(record.dataUrl);
    const fullUrl = getString(record.fullUrl) || getString(record.full) || getString(record.url) || getString(record.imageUrl) || getString(record.dataUrl);
    const url = thumbnailUrl || fullUrl;
    if (!url) return;
    media.push({
      assetId: getString(record.assetId) || undefined,
      thumbnailAssetId: getString(record.thumbnailAssetId) || undefined,
      url,
      thumbnailUrl,
      fullUrl,
      mimeType: getString(record.mimeType) || undefined,
      sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : undefined,
      alt: getString(record.alt) || getString(record.prompt) || undefined,
      storage: getString(record.storage) as WorldMomentItem['media'][number]['storage'],
    });
  };
  addMedia(payload);
  if (Array.isArray(payload.media)) payload.media.forEach(addMedia);
  if (Array.isArray(payload.images)) payload.images.forEach(addMedia);
  return media;
}

function getMomentDebugEvidence(event: RuntimeEventV2, payload: Record<string, unknown>, debugState: WorldMomentItem['debugState']) {
  const rows: string[] = [];
  const seenValues = new Set<string>();
  const pushRow = (label: string, value: string) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || seenValues.has(normalized)) return;
    seenValues.add(normalized);
    rows.push(`${label}：${normalized}`);
  };
  pushRow('状态', debugState === 'candidate' ? '候选' : '已发布');
  pushRow('原因', getString(payload.reasonType));
  if (getNumber(payload.confidence) !== null) pushRow('置信度', `${((getNumber(payload.confidence) as number) * 100).toFixed(0)}%`);
  pushRow('意图', getString(payload.seedIntent));
  pushRow('来源', getString(payload.sourceText));
  pushRow('公开摘要', getString(payload.publicSummary));
  pushRow('题材', getString(payload.activityType));
  if (getStringArray(payload.companionshipSeeds).length) pushRow('陪伴余波', getStringArray(payload.companionshipSeeds).join(' / '));
  if (getStringArray(payload.expectedArtifacts).length) pushRow('产物', getStringArray(payload.expectedArtifacts).join(' / '));
  pushRow('去重键', getString(payload.dedupeKey));
  pushRow('事件摘要', event.summary || '');
  return rows;
}

function asParticipantScheduleState(value: unknown): ParticipantScheduleState | null {
  if (value === 'mentioned'
    || value === 'invited'
    || value === 'interested'
    || value === 'maybe'
    || value === 'going'
    || value === 'late'
    || value === 'left_early'
    || value === 'declined'
    || value === 'withdrawn'
    || value === 'no_show'
    || value === 'cancelled_by_dependency') return value;
  return null;
}

function getParticipantStateRecord(value: unknown): Record<string, ParticipantScheduleState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .map(([id, state]) => [id, asParticipantScheduleState(state)] as const)
    .filter((entry): entry is [string, ParticipantScheduleState] => Boolean(entry[0]) && Boolean(entry[1]));
  return Object.fromEntries(entries);
}

function ensureParticipantStates(participantIds: string[], states: Record<string, ParticipantScheduleState>) {
  const next = { ...states };
  participantIds.forEach((id) => {
    if (!next[id]) next[id] = 'mentioned';
  });
  Object.keys(next).forEach((id) => {
    if (!participantIds.includes(id)) delete next[id];
  });
  return next;
}

function resolveParticipantIdsAndStates(input: {
  baseParticipantIds: string[];
  baseParticipantStates: Record<string, ParticipantScheduleState>;
  replaceParticipantIds?: string[];
  addParticipantIds?: string[];
  removeParticipantIds?: string[];
  replaceParticipantStates?: Record<string, ParticipantScheduleState>;
  addParticipantStates?: Record<string, ParticipantScheduleState>;
  removeParticipantStateIds?: string[];
}) {
  const replaceParticipantIds = input.replaceParticipantIds || [];
  const addParticipantIds = input.addParticipantIds || [];
  const removeParticipantIds = input.removeParticipantIds || [];
  const replaceParticipantStates = input.replaceParticipantStates || {};
  const addParticipantStates = input.addParticipantStates || {};
  const removeParticipantStateIds = input.removeParticipantStateIds || [];
  let participantIds = replaceParticipantIds.length ? replaceParticipantIds : input.baseParticipantIds;
  participantIds = Array.from(new Set([...participantIds, ...addParticipantIds]));
  let participantStates = replaceParticipantIds.length || Object.keys(replaceParticipantStates).length
    ? replaceParticipantStates
    : input.baseParticipantStates;
  participantStates = {
    ...participantStates,
    ...addParticipantStates,
  };
  const removedParticipants = new Set(removeParticipantIds);
  participantIds = participantIds.filter((id) => !removedParticipants.has(id));
  Object.keys(participantStates).forEach((id) => {
    if (removedParticipants.has(id) || removeParticipantStateIds.includes(id)) delete participantStates[id];
  });
  participantIds = Array.from(new Set([...participantIds, ...Object.keys(participantStates)]));
  participantStates = ensureParticipantStates(participantIds, participantStates);
  return { participantIds, participantStates };
}

function mergeParticipantScheduleStates(
  existing: Record<string, ParticipantScheduleState>,
  incoming: Record<string, ParticipantScheduleState>,
) {
  const merged = { ...existing };
  Object.entries(incoming).forEach(([id, state]) => {
    const previous = merged[id];
    if (state === 'mentioned' && previous && previous !== 'mentioned') return;
    merged[id] = state;
  });
  return merged;
}

function estimateActivityDurationMinutes(title: string, activityType: string) {
  const text = `${title} ${activityType}`.toLowerCase();
  if (!text.trim()) return null;
  if (/火锅|烧烤|聚餐|晚餐|午餐|吃饭|hotpot|bbq|dinner|lunch/.test(text)) return 120;
  if (/咖啡|奶茶|下午茶|coffee|tea/.test(text)) return 45;
  if (/快餐|麦当劳|肯德基|汉堡|fast\s?food/.test(text)) return 20;
  if (/k歌|唱歌|ktv|karaoke/.test(text)) return 180;
  if (/电影|影院|movie|cinema/.test(text)) return 130;
  if (/提醒|reminder/.test(text)) return 10;
  return 90;
}

function normalizeCityName(value: string | undefined | null) {
  if (!value) return '';
  return value.replace(/市|城区|主城区| downtown/gi, '').trim().toLowerCase();
}

function characterNameMap(characters: AICharacter[]) {
  return new Map(characters.map((character) => [character.id, character.name]));
}

function getActorName(id: string | undefined, names: Map<string, string>) {
  if (!id) return '成员';
  if (id === 'user') return '我';
  return names.get(id) || '成员';
}

function getConversationDisplayName(chat: GroupChat) {
  return chat.deletedAt ? `${chat.name}（来源已删除）` : chat.name;
}

function getSourceEvidenceWeight(event: RuntimeEventV2) {
  if (event.kind === 'artifact') return 1;
  if (event.kind === 'calendar_item_patch') return 0.9;
  return 0.7;
}

function mergeSourceEvidence(
  existingWeight: number,
  incomingWeight: number,
  previousEventCount: number,
  nextEventCount: number,
) {
  if (nextEventCount <= previousEventCount) return Math.max(existingWeight, incomingWeight);
  return Math.min(3, existingWeight + incomingWeight * 0.35);
}

function deriveTemporalCalendarStatus(
  status: WorldCalendarItem['status'],
  startAt: number | null | undefined,
  endAt: number | null | undefined,
  now: number,
): WorldCalendarItem['status'] {
  if (status === 'cancelled' || status === 'completed') return status;
  const hasStart = typeof startAt === 'number';
  const hasEnd = typeof endAt === 'number';
  if (!hasStart) return status;
  if (hasEnd && now >= (endAt as number)) return 'completed';
  if (now >= (startAt as number)) return 'in_progress';
  return status;
}

function buildCalendarKey(event: RuntimeEventV2) {
  const payload = getPayload(event);
  const dedupeKey = getString(payload.dedupeKey);
  if (dedupeKey) return dedupeKey;
  return [
    getString(payload.eventKind),
    getString(payload.title),
    getString(payload.activityType),
    getString(payload.timeHint),
    getString(payload.locationHint),
    getStringArray(payload.participantIds).sort().join(','),
  ].join('::');
}

function isSocialOutingEvent(event: RuntimeEventV2) {
  const payload = getPayload(event);
  return (payload.eventKind === 'social_outing' || payload.eventKind === 'travel_plan' || payload.eventKind === 'calendar_reminder')
    && (event.kind === 'event_candidate' || event.kind === 'artifact');
}

function isCalendarPatchEvent(event: RuntimeEventV2) {
  return event.kind === 'calendar_item_patch';
}

function asCalendarStatus(value: unknown): WorldCalendarItem['status'] | null {
  if (value === 'tentative' || value === 'planned' || value === 'confirmed' || value === 'in_progress' || value === 'completed' || value === 'cancelled') return value;
  return null;
}

function asCalendarKind(value: unknown): WorldCalendarItem['kind'] | null {
  if (value === 'activity' || value === 'travel' || value === 'reminder' || value === 'blocked_time' || value === 'rest' || value === 'preparation') return value;
  return null;
}

function resolvePatchCalendarId(event: RuntimeEventV2) {
  const payload = getPayload(event);
  return getString(payload.calendarItemId) || getString(payload.itemId) || getString(payload.dedupeKey) || '';
}

function mergeCalendarItem(existing: WorldCalendarItem, incoming: WorldCalendarItem): WorldCalendarItem {
  // Missing timing in a later mention must not replace an explicit interval
  // with an activity-label estimate.
  const timing = incoming.durationEstimated && !existing.durationEstimated
    && (typeof existing.durationMinutes === 'number' || typeof existing.endAt === 'number')
    ? existing : incoming;
  const startAt = incoming.startAt ?? existing.startAt ?? null;
  const durationMinutes = timing.durationMinutes
    ?? (typeof timing.endAt === 'number' && typeof startAt === 'number'
      ? (timing.endAt - startAt) / 60_000 : existing.durationMinutes ?? null);
  const endAt = typeof durationMinutes === 'number' && typeof startAt === 'number'
    && ((timing === existing && startAt !== existing.startAt) || timing.endAt == null)
    ? startAt + durationMinutes * 60_000
    : timing.endAt ?? existing.endAt ?? null;
  const participantIds = Array.from(new Set([
    ...existing.participantIds,
    ...incoming.participantIds,
    ...Object.keys(existing.participantStates),
    ...Object.keys(incoming.participantStates),
  ]));
  const participantStates = ensureParticipantStates(participantIds, mergeParticipantScheduleStates(existing.participantStates, incoming.participantStates));
  const existingNameById = new Map(existing.participantIds.map((id, index) => [id, existing.participantNames[index] || '成员']));
  const incomingNameById = new Map(incoming.participantIds.map((id, index) => [id, incoming.participantNames[index] || '成员']));
  const sourceRefs = [...existing.sourceRefs];
  incoming.sourceRefs.forEach((ref) => {
    const matched = sourceRefs.find((item) => item.conversationId === ref.conversationId);
    if (!matched) {
      sourceRefs.push(ref);
      return;
    }
    const previousEventCount = matched.eventIds.length;
    const mergedEventIds = Array.from(new Set([...matched.eventIds, ...ref.eventIds]));
    if (!matched.conversationName && ref.conversationName) matched.conversationName = ref.conversationName;
    if (ref.sourceDeleted) matched.sourceDeleted = true;
    matched.eventIds = mergedEventIds;
    matched.weight = mergeSourceEvidence(matched.weight, ref.weight, previousEventCount, mergedEventIds.length);
    matched.lastEvidenceAt = Math.max(matched.lastEvidenceAt, ref.lastEvidenceAt);
  });
  return {
    ...existing,
    mergedItemIds: Array.from(new Set([...(existing.mergedItemIds || [existing.id]), ...(incoming.mergedItemIds || [incoming.id])])),
    status: existing.status === 'confirmed' || incoming.status === 'confirmed' ? 'confirmed' : incoming.status,
    title: incoming.title || existing.title,
    activityType: incoming.activityType || existing.activityType,
    participantIds,
    participantStates,
    participantNames: participantIds.map((id) => incomingNameById.get(id) || existingNameById.get(id) || '成员'),
    startAt,
    endAt,
    durationMinutes,
    durationEstimated: timing.durationEstimated,
    timeHint: incoming.timeHint || existing.timeHint,
    locationHint: incoming.locationHint || existing.locationHint,
    summary: incoming.summary || existing.summary,
    sourceRefs,
    conflict: existing.conflict || incoming.conflict || null,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

function mergeMatchingCalendarActivities(items: WorldCalendarItem[]) {
  const bySchedule = new Map<string, WorldCalendarItem>();
  for (const item of items) {
    if (item.kind !== 'activity' || item.status === 'cancelled') {
      bySchedule.set(item.id, item);
      continue;
    }
    const time = typeof item.startAt === 'number'
      ? `at:${item.startAt}`
      : item.timeHint?.trim().toLowerCase()
        ? `hint:${new Date(item.updatedAt).toDateString()}:${item.timeHint.trim().toLowerCase()}`
        : null;
    if (!time) {
      bySchedule.set(item.id, item);
      continue;
    }
    const key = `activity:${item.title.trim().toLowerCase()}:${time}`;
    const existing = bySchedule.get(key);
    bySchedule.set(key, existing ? mergeCalendarItem(existing, item) : item);
  }
  return [...bySchedule.values()];
}

function mergeSourceRef(existing: WorldCalendarItem['sourceRefs'], incoming: WorldCalendarSourceRef) {
  const sourceRefs = [...existing];
  const matched = sourceRefs.find((item) => item.conversationId === incoming.conversationId);
  if (!matched) return [...sourceRefs, incoming];
  if (!matched.conversationName && incoming.conversationName) matched.conversationName = incoming.conversationName;
  if (incoming.sourceDeleted) matched.sourceDeleted = true;
  matched.eventIds = Array.from(new Set([...matched.eventIds, ...incoming.eventIds]));
  matched.weight = Math.max(matched.weight, incoming.weight);
  matched.lastEvidenceAt = Math.max(matched.lastEvidenceAt, incoming.lastEvidenceAt);
  return sourceRefs;
}

function applyCalendarPatch(
  existing: WorldCalendarItem | undefined,
  event: RuntimeEventV2,
  names: Map<string, string>,
  sourceMeta?: { conversationName?: string; sourceDeleted?: boolean },
) {
  const payload = getPayload(event);
  const addParticipantIds = getStringArray(payload.addParticipantIds);
  const removeParticipantIds = getStringArray(payload.removeParticipantIds);
  const replaceParticipantIds = getStringArray(payload.participantIds);
  const replaceParticipantStates = getParticipantStateRecord(payload.participantStates);
  const addParticipantStates = getParticipantStateRecord(payload.addParticipantStates);
  const removeParticipantStateIds = getStringArray(payload.removeParticipantStateIds);
  const sourceRef: WorldCalendarSourceRef = {
    conversationId: event.conversationId,
    conversationName: sourceMeta?.conversationName,
    sourceDeleted: sourceMeta?.sourceDeleted,
    eventIds: [event.id],
    weight: 1,
    lastEvidenceAt: event.createdAt,
  };
  const base: WorldCalendarItem = existing || {
    id: resolvePatchCalendarId(event) || event.id,
    kind: asCalendarKind(payload.kind) || 'activity',
    status: 'tentative',
    title: getString(payload.title) || '活动安排',
    activityType: getString(payload.activityType) || undefined,
    participantIds: [],
    participantStates: {},
    participantNames: [],
    startAt: null,
    endAt: null,
    durationMinutes: null,
    timeHint: null,
    locationHint: null,
    summary: event.summary || '活动更新',
    sourceRefs: [],
    conflict: null,
    updatedAt: event.createdAt,
  };

  const { participantIds, participantStates } = resolveParticipantIdsAndStates({
    baseParticipantIds: base.participantIds,
    baseParticipantStates: base.participantStates,
    replaceParticipantIds,
    addParticipantIds,
    removeParticipantIds,
    replaceParticipantStates,
    addParticipantStates,
    removeParticipantStateIds,
  });
  const status = payload.cancelled === true ? 'cancelled' : asCalendarStatus(payload.status) || base.status;
  const startAt = payload.clearStartAt === true ? null : (getNumber(payload.startAt) ?? base.startAt ?? null);
  const explicitEndAt = getNumber(payload.endAt);
  const explicitDurationMinutes = getNumber(payload.durationMinutes);
  const hasExplicitEnd = explicitEndAt !== null && typeof startAt === 'number' && explicitEndAt >= startAt;
  const hasExplicitDuration = explicitDurationMinutes !== null && explicitDurationMinutes > 0;
  const durationEstimated = hasExplicitEnd || hasExplicitDuration ? false : base.durationEstimated;
  const rawDurationMinutes = payload.clearDurationMinutes === true ? null
    : hasExplicitEnd && explicitDurationMinutes === null && typeof startAt === 'number' ? (explicitEndAt - startAt) / 60_000
      : explicitDurationMinutes ?? base.durationMinutes ?? null;
  const rawEndAt = payload.clearEndAt === true ? null : explicitEndAt
    ?? (typeof startAt === 'number' && typeof rawDurationMinutes === 'number'
      && (hasExplicitDuration || getNumber(payload.startAt) !== null)
      ? startAt + rawDurationMinutes * 60_000 : base.endAt ?? null);
  // Minimal temporal validation: reject impossible ranges, keep the rest of the patch.
  const endAt = (typeof startAt === 'number' && typeof rawEndAt === 'number' && rawEndAt < startAt) ? null : rawEndAt;
  const durationMinutes = (typeof rawDurationMinutes === 'number' && rawDurationMinutes <= 0) ? null : rawDurationMinutes;
  const timeHint = payload.clearTimeHint === true ? null : (getString(payload.timeHint) || base.timeHint || null);
  const locationHint = payload.clearLocationHint === true ? null : (getString(payload.locationHint) || base.locationHint || null);
  const availabilityByActor = { ...base.availabilityByActor };
  if (payload.availabilityByActor && typeof payload.availabilityByActor === 'object') {
    Object.entries(payload.availabilityByActor).forEach(([id, status]) => {
      if (participantIds.includes(id) && (status === 'online' || status === 'away')) availabilityByActor[id] = status;
    });
  }

  return {
    ...base,
    kind: asCalendarKind(payload.kind) || base.kind,
    status,
    title: getString(payload.title) || base.title,
    activityType: getString(payload.activityType) || base.activityType,
    participantIds,
    participantStates,
    participantNames: participantIds.map((id) => getActorName(id, names)),
    startAt,
    endAt,
    durationMinutes,
    durationEstimated,
    timeHint,
    locationHint,
    availabilityByActor,
    summary: getString(payload.summary) || event.summary || base.summary,
    sourceRefs: mergeSourceRef(base.sourceRefs, sourceRef),
    conflict: base.conflict || null,
    updatedAt: Math.max(base.updatedAt, event.createdAt),
  };
}

function detectConflicts(items: WorldCalendarItem[]) {
  const next = items.map((item) => ({ ...item, conflict: null as WorldCalendarItem['conflict'] }));
  const byId = new Map(next.map((item) => [item.id, item]));
  const activeIndexes = next
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.status !== 'cancelled'
      && !entry.item.durationEstimated
      && typeof entry.item.startAt === 'number'
      && (typeof entry.item.endAt === 'number' || typeof entry.item.durationMinutes === 'number'));

  function resolveEnd(item: WorldCalendarItem) {
    if (typeof item.endAt === 'number') return item.endAt;
    if (typeof item.startAt === 'number' && typeof item.durationMinutes === 'number') return item.startAt + item.durationMinutes * 60_000;
    return null;
  }

  function isConflictActiveState(state: ParticipantScheduleState | undefined) {
    if (!state) return true;
    return !['declined', 'withdrawn', 'no_show', 'cancelled_by_dependency', 'left_early'].includes(state);
  }

  function resolveRootId(id: string) {
    const marker = id.indexOf('::');
    return marker >= 0 ? id.slice(0, marker) : id;
  }

  function resolveDuration(item: WorldCalendarItem, resolvedEnd: number | null) {
    if (typeof item.durationMinutes === 'number' && Number.isFinite(item.durationMinutes)) return item.durationMinutes;
    if (typeof item.startAt === 'number' && typeof resolvedEnd === 'number') return Math.ceil((resolvedEnd - item.startAt) / 60_000);
    return null;
  }

  function buildLinkedPatchDrafts(lateItem: WorldCalendarItem, delayMinutes: number, earlyItemId: string) {
    const rootId = resolveRootId(lateItem.id);
    const linkedIds = Array.from(byId.keys())
      .filter((id) => id === rootId || id.startsWith(`${rootId}::`));
    const drafts: WorldCalendarPatchDraft[] = [];
    linkedIds.forEach((id) => {
      const linked = byId.get(id);
      if (!linked || typeof linked.startAt !== 'number') return;
      const linkedEnd = resolveEnd(linked);
      const linkedDuration = resolveDuration(linked, linkedEnd);
      const nextStartAt = linked.startAt + delayMinutes * 60_000;
      const nextEndAt = typeof linkedEnd === 'number' ? linkedEnd + delayMinutes * 60_000 : null;
      drafts.push({
        eventType: 'calendar_item_patch',
        calendarItemId: id,
        patch: {
          startAt: nextStartAt,
          endAt: nextEndAt,
          durationMinutes: linkedDuration ?? undefined,
        },
        reason: `与「${earlyItemId}」冲突，链式顺延 ${delayMinutes} 分钟`,
        basedOnItemId: earlyItemId,
      });
    });
    return drafts;
  }

  for (let i = 0; i < activeIndexes.length; i += 1) {
    const left = activeIndexes[i];
    const leftStart = left.item.startAt as number;
    const leftEnd = resolveEnd(left.item);
    if (!leftEnd) continue;
    for (let j = i + 1; j < activeIndexes.length; j += 1) {
      const right = activeIndexes[j];
      const rightStart = right.item.startAt as number;
      const rightEnd = resolveEnd(right.item);
      if (!rightEnd) continue;
      const overlapStart = Math.max(leftStart, rightStart);
      const overlapEnd = Math.min(leftEnd, rightEnd);
      if (overlapStart >= overlapEnd) continue;
      const sharedParticipantIds = left.item.participantIds.filter((id) => {
        if (!right.item.participantIds.includes(id)) return false;
        return isConflictActiveState(left.item.participantStates[id]) && isConflictActiveState(right.item.participantStates[id]);
      });
      if (!sharedParticipantIds.length) continue;
      const overlapMinutes = Math.ceil((overlapEnd - overlapStart) / 60_000);

      const leftNames = left.item.participantNames.filter((name, idx) => sharedParticipantIds.includes(left.item.participantIds[idx]));
      const rightNames = right.item.participantNames.filter((name, idx) => sharedParticipantIds.includes(right.item.participantIds[idx]));
      const sharedNames = Array.from(new Set([...leftNames, ...rightNames]));
      const leftExistingIds = new Set(left.item.conflict?.conflictWithItemIds || []);
      const rightExistingIds = new Set(right.item.conflict?.conflictWithItemIds || []);
      const leftExistingSuggestions = left.item.conflict?.resolutionSuggestions || [];
      const rightExistingSuggestions = right.item.conflict?.resolutionSuggestions || [];
      const leftDuration = typeof left.item.durationMinutes === 'number' ? left.item.durationMinutes : Math.ceil((leftEnd - leftStart) / 60_000);
      const rightDuration = typeof right.item.durationMinutes === 'number' ? right.item.durationMinutes : Math.ceil((rightEnd - rightStart) / 60_000);

      const lateItem = leftStart <= rightStart ? right.item : left.item;
      const earlyItem = leftStart <= rightStart ? left.item : right.item;
      const earlyEnd = leftStart <= rightStart ? leftEnd : rightEnd;
      const lateStart = leftStart <= rightStart ? rightStart : leftStart;
      const lateDuration = leftStart <= rightStart ? rightDuration : leftDuration;
      const delayMinutes = Math.max(15, Math.ceil((earlyEnd - lateStart) / 60_000) + 15);
      const lateSuggestedStartAt = lateStart + delayMinutes * 60_000;
      const lateSuggestedEndAt = lateSuggestedStartAt + lateDuration * 60_000;
      const lateSuggestion = {
        itemId: lateItem.id,
        strategy: 'delay_after_conflict' as const,
        suggestedStartAt: lateSuggestedStartAt,
        suggestedEndAt: lateSuggestedEndAt,
        delayMinutes,
        reason: `${sharedNames.join('、')} 在该时段冲突，建议把「${lateItem.title}」顺延到「${earlyItem.title}」结束后`,
        basedOnItemId: earlyItem.id,
      };
      const latePatchDrafts = buildLinkedPatchDrafts(lateItem, delayMinutes, earlyItem.id);
      if (!latePatchDrafts.length) {
        latePatchDrafts.push({
          eventType: 'calendar_item_patch' as const,
          calendarItemId: lateItem.id,
          patch: {
            startAt: lateSuggestedStartAt,
            endAt: lateSuggestedEndAt,
            durationMinutes: lateDuration,
          },
          reason: lateSuggestion.reason,
          basedOnItemId: earlyItem.id,
        });
      }

      next[left.index].conflict = {
        hasConflict: true,
        conflictWithItemIds: Array.from(new Set([...leftExistingIds, right.item.id])),
        participantIds: sharedParticipantIds,
        participantNames: sharedNames,
        overlapStartAt: overlapStart,
        overlapEndAt: overlapEnd,
        suggestedDelayMinutes: overlapMinutes + 15,
        resolutionSuggestions: [...leftExistingSuggestions, lateSuggestion].filter((suggestion, index, array) => array.findIndex((item) => item.itemId === suggestion.itemId && item.basedOnItemId === suggestion.basedOnItemId) === index),
        patchDrafts: [...(left.item.conflict?.patchDrafts || []), ...latePatchDrafts].filter((draft, index, array) => array.findIndex((item) => item.calendarItemId === draft.calendarItemId && item.basedOnItemId === draft.basedOnItemId) === index),
      };
      next[right.index].conflict = {
        hasConflict: true,
        conflictWithItemIds: Array.from(new Set([...rightExistingIds, left.item.id])),
        participantIds: sharedParticipantIds,
        participantNames: sharedNames,
        overlapStartAt: overlapStart,
        overlapEndAt: overlapEnd,
        suggestedDelayMinutes: overlapMinutes + 15,
        resolutionSuggestions: [...rightExistingSuggestions, lateSuggestion].filter((suggestion, index, array) => array.findIndex((item) => item.itemId === suggestion.itemId && item.basedOnItemId === suggestion.basedOnItemId) === index),
        patchDrafts: [...(right.item.conflict?.patchDrafts || []), ...latePatchDrafts].filter((draft, index, array) => array.findIndex((item) => item.calendarItemId === draft.calendarItemId && item.basedOnItemId === draft.basedOnItemId) === index),
      };
    }
  }
  return next;
}

function buildPatchDraftQueue(items: WorldCalendarItem[]) {
  const drafts = items.flatMap((item) => item.conflict?.patchDrafts || []);
  const deduped = drafts.filter((draft, index, array) => array.findIndex((item) => item.calendarItemId === draft.calendarItemId && item.basedOnItemId === draft.basedOnItemId) === index);
  const byItemId = new Map(items.map((item) => [item.id, item]));
  return deduped.sort((left, right) => {
    const leftAnchor = byItemId.get(left.basedOnItemId)?.startAt ?? 0;
    const rightAnchor = byItemId.get(right.basedOnItemId)?.startAt ?? 0;
    if (leftAnchor !== rightAnchor) return leftAnchor - rightAnchor;
    if (left.patch.startAt !== right.patch.startAt) return left.patch.startAt - right.patch.startAt;
    return left.calendarItemId.localeCompare(right.calendarItemId);
  });
}

export function projectWorldCalendar(chats: GroupChat[], characters: AICharacter[], options: { conversationId?: string | null; now?: number; inferTemporalStatus?: boolean; publicOnly?: boolean } = {}): WorldCalendarProjectionResult {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const names = characterNameMap(characters);
  const items = new Map<string, WorldCalendarItem>();
  const deletedItemIds = new Set<string>();
  chats.forEach((chat) => (chat.runtimeEventsV2 || []).forEach((event) => {
    if (!isCalendarPatchEvent(event)) return;
    if (options.publicOnly && ((event.visibility && event.visibility !== 'public' && event.visibility !== 'derived_public')
      || event.visibleToIds?.length || event.visibleToRoles?.length)) return;
    if (getPayload(event).deleted === true) {
      const id = resolvePatchCalendarId(event);
      if (id) deletedItemIds.add(id);
    }
  }));
  chats.forEach((chat) => {
    const events = (chat.runtimeEventsV2 || [])
      .filter((event) => !options.publicOnly || ((!event.visibility || event.visibility === 'public' || event.visibility === 'derived_public')
        && !event.visibleToIds?.length && !event.visibleToRoles?.length))
      .slice().sort((left, right) => left.createdAt - right.createdAt);
    events.forEach((event) => {
      if (isSocialOutingEvent(event)) {
      const payload = getPayload(event) as Partial<SocialEventCandidatePayload> & Record<string, unknown>;
      const baseParticipantIds = getStringArray(payload.participantIds).length
        ? getStringArray(payload.participantIds)
        : (event.targetIds || event.actorIds || []);
      const targetIds = getStringArray(payload.targetIds).length
        ? getStringArray(payload.targetIds)
        : (event.targetIds || []);
      const participantIds = Array.from(new Set([
        ...baseParticipantIds,
        ...targetIds,
      ]));
      const participantStates = ensureParticipantStates(participantIds, getParticipantStateRecord(payload.participantStates));
      const title = getString(payload.title) || getString(payload.activityType) || '线下活动';
      const activityType = getString(payload.activityType) || title;
      const eventKind = getString(payload.eventKind);
      const kind: WorldCalendarItem['kind'] = eventKind === 'travel_plan' ? 'travel' : eventKind === 'calendar_reminder' ? 'reminder' : 'activity';
      const startAt = getNumber(payload.startAt);
      const explicitEndAt = getNumber(payload.endAt);
      const explicitDurationMinutes = getNumber(payload.durationMinutes);
      const durationMinutes = explicitDurationMinutes
        ?? (typeof explicitEndAt === 'number'
          ? (typeof startAt === 'number' ? (explicitEndAt - startAt) / 60_000 : null)
          : estimateActivityDurationMinutes(title, activityType));
      const durationEstimated = explicitDurationMinutes === null
        && explicitEndAt === null
        && durationMinutes !== null;
      const endAt = getNumber(payload.endAt) ?? (startAt && durationMinutes ? startAt + durationMinutes * 60_000 : null);
      const item: WorldCalendarItem = {
        id: buildCalendarKey(event) || event.id,
        kind,
        status: asCalendarStatus(payload.status) || (event.kind === 'artifact' ? 'confirmed' : 'tentative'),
        title,
        activityType,
        participantIds,
        participantStates,
        participantNames: participantIds.map((id) => getActorName(id, names)),
        startAt,
        endAt,
        durationMinutes,
        durationEstimated,
        timeHint: getString(payload.timeHint) || null,
        locationHint: getString(payload.locationHint) || null,
        summary: event.summary,
        sourceRefs: [{
          conversationId: chat.id,
          conversationName: getConversationDisplayName(chat),
          sourceDeleted: Boolean(chat.deletedAt),
          eventIds: [event.id],
          weight: getSourceEvidenceWeight(event),
          lastEvidenceAt: event.createdAt,
        }],
        conflict: null,
        updatedAt: event.createdAt,
      };
      const existing = items.get(item.id);
      items.set(item.id, existing ? mergeCalendarItem(existing, item) : item);
      const canAutoOccupancy = kind === 'activity' && startAt && endAt && !durationEstimated && payload.autoPreparationRest === true;
      if (canAutoOccupancy) {
        const inferredPreparationDuration = Math.max(20, Math.min(60, Math.round((durationMinutes || 120) * 0.25)));
        const inferredRestDuration = Math.max(20, Math.min(60, Math.round((durationMinutes || 120) * 0.2)));
        const preparationDuration = getNumber(payload.preparationDurationMinutes) ?? inferredPreparationDuration;
        const restDuration = getNumber(payload.restDurationMinutes) ?? inferredRestDuration;
        const prepId = `${item.id}::prep`;
        const restId = `${item.id}::rest`;
        const prepItem: WorldCalendarItem = {
          id: prepId,
          derivedFromItemId: item.id,
          kind: 'preparation',
          status: item.status,
          title: getString(payload.preparationTitle) || '活动准备',
          activityType: '准备',
          participantIds,
          participantStates: ensureParticipantStates(participantIds, {}),
          participantNames: participantIds.map((id) => getActorName(id, names)),
          startAt: startAt - preparationDuration * 60_000,
          endAt: startAt,
          durationMinutes: preparationDuration,
          timeHint: null,
          locationHint: getString(payload.locationHint) || null,
          summary: getString(payload.preparationSummary) || `${participantIds.map((id) => getActorName(id, names)).join('、')} 正在准备 ${title}`,
          sourceRefs: [{
            conversationId: chat.id,
            conversationName: getConversationDisplayName(chat),
            sourceDeleted: Boolean(chat.deletedAt),
            eventIds: [event.id],
            weight: getSourceEvidenceWeight(event),
            lastEvidenceAt: event.createdAt,
          }],
          conflict: null,
          updatedAt: event.createdAt,
        };
        const restItem: WorldCalendarItem = {
          id: restId,
          derivedFromItemId: item.id,
          kind: 'rest',
          status: item.status,
          title: getString(payload.restTitle) || '活动后休整',
          activityType: '休整',
          participantIds,
          participantStates: ensureParticipantStates(participantIds, {}),
          participantNames: participantIds.map((id) => getActorName(id, names)),
          startAt: endAt,
          endAt: endAt + restDuration * 60_000,
          durationMinutes: restDuration,
          timeHint: null,
          locationHint: getString(payload.locationHint) || null,
          summary: getString(payload.restSummary) || `${participantIds.map((id) => getActorName(id, names)).join('、')} 在活动后休整`,
          sourceRefs: [{
            conversationId: chat.id,
            conversationName: getConversationDisplayName(chat),
            sourceDeleted: Boolean(chat.deletedAt),
            eventIds: [event.id],
            weight: getSourceEvidenceWeight(event),
            lastEvidenceAt: event.createdAt,
          }],
          conflict: null,
          updatedAt: event.createdAt,
        };
        const existingPrep = items.get(prepId);
        const existingRest = items.get(restId);
        items.set(prepId, existingPrep ? mergeCalendarItem(existingPrep, prepItem) : prepItem);
        items.set(restId, existingRest ? mergeCalendarItem(existingRest, restItem) : restItem);
      }
      const canCreateAutoTravel = kind === 'activity' && startAt && payload.autoTravel !== false;
      if (canCreateAutoTravel) {
        const travelDurationMinutes = getNumber(payload.travelDurationMinutes) ?? null;
        const destinationCity = normalizeCityName(getString(payload.destinationCity) || getString(payload.locationHint));
        const participantOrigins = getStringRecord(payload.participantOrigins);
        const travelParticipantIds = participantIds.filter((id) => {
          const originCity = normalizeCityName(participantOrigins[id]);
          return Boolean(destinationCity && originCity && originCity !== destinationCity);
        });
        const shouldAutoTravel = travelParticipantIds.length > 0 && (travelDurationMinutes || 120);
        if (shouldAutoTravel) {
          const duration = travelDurationMinutes || 120;
          const travelId = `${item.id}::travel`;
          const travelItem: WorldCalendarItem = {
            id: travelId,
            derivedFromItemId: item.id,
            kind: 'travel',
            status: item.status,
            title: getString(payload.travelTitle) || '前往活动地点',
            activityType: '出行',
            participantIds: travelParticipantIds,
            participantStates: ensureParticipantStates(travelParticipantIds, {}),
            participantNames: travelParticipantIds.map((id) => getActorName(id, names)),
            startAt: startAt - duration * 60_000,
            endAt: startAt,
            durationMinutes: duration,
            timeHint: null,
            locationHint: destinationCity || getString(payload.locationHint) || null,
            summary: getString(payload.travelSummary) || `${travelParticipantIds.map((id) => getActorName(id, names)).join('、')} 正在前往 ${getString(payload.locationHint) || getString(payload.destinationCity) || '活动地点'}`,
            sourceRefs: [{
              conversationId: chat.id,
              conversationName: getConversationDisplayName(chat),
              sourceDeleted: Boolean(chat.deletedAt),
              eventIds: [event.id],
              weight: getSourceEvidenceWeight(event),
              lastEvidenceAt: event.createdAt,
            }],
            conflict: null,
            updatedAt: event.createdAt,
          };
          const existingTravel = items.get(travelId);
          items.set(travelId, existingTravel ? mergeCalendarItem(existingTravel, travelItem) : travelItem);
          const canChainPrepRestWithTravel = !durationEstimated && payload.autoPreparationRest === true && payload.autoPreparationRestAfterTravel === true;
          if (canChainPrepRestWithTravel) {
            const inferredPreparationDuration = Math.max(20, Math.min(60, Math.round((durationMinutes || 120) * 0.25)));
            const inferredRestDuration = Math.max(20, Math.min(60, Math.round((durationMinutes || 120) * 0.2)));
            const preparationDuration = getNumber(payload.preparationDurationMinutes) ?? inferredPreparationDuration;
            const restDuration = getNumber(payload.restDurationMinutes) ?? inferredRestDuration;
            const prepId = `${item.id}::prep`;
            const restId = `${item.id}::rest`;
            const prepItem: WorldCalendarItem = {
              id: prepId,
              derivedFromItemId: item.id,
              kind: 'preparation',
              status: item.status,
              title: getString(payload.preparationTitle) || '到场准备',
              activityType: '准备',
              participantIds: travelParticipantIds,
              participantStates: ensureParticipantStates(travelParticipantIds, {}),
              participantNames: travelParticipantIds.map((id) => getActorName(id, names)),
              startAt,
              endAt: startAt + preparationDuration * 60_000,
              durationMinutes: preparationDuration,
              timeHint: null,
              locationHint: destinationCity || getString(payload.locationHint) || null,
              summary: getString(payload.preparationSummary) || `${travelParticipantIds.map((id) => getActorName(id, names)).join('、')} 到场后准备 ${title}`,
              sourceRefs: [{
                conversationId: chat.id,
                conversationName: getConversationDisplayName(chat),
                sourceDeleted: Boolean(chat.deletedAt),
                eventIds: [event.id],
                weight: getSourceEvidenceWeight(event),
                lastEvidenceAt: event.createdAt,
              }],
              conflict: null,
              updatedAt: event.createdAt,
            };
            const restItem: WorldCalendarItem = {
              id: restId,
              derivedFromItemId: item.id,
              kind: 'rest',
              status: item.status,
              title: getString(payload.restTitle) || '活动后休整',
              activityType: '休整',
              participantIds: travelParticipantIds,
              participantStates: ensureParticipantStates(travelParticipantIds, {}),
              participantNames: travelParticipantIds.map((id) => getActorName(id, names)),
              startAt: (endAt || startAt) + preparationDuration * 60_000,
              endAt: (endAt || startAt) + (preparationDuration + restDuration) * 60_000,
              durationMinutes: restDuration,
              timeHint: null,
              locationHint: destinationCity || getString(payload.locationHint) || null,
              summary: getString(payload.restSummary) || `${travelParticipantIds.map((id) => getActorName(id, names)).join('、')} 在活动后休整`,
              sourceRefs: [{
                conversationId: chat.id,
                conversationName: getConversationDisplayName(chat),
                sourceDeleted: Boolean(chat.deletedAt),
                eventIds: [event.id],
                weight: getSourceEvidenceWeight(event),
                lastEvidenceAt: event.createdAt,
              }],
              conflict: null,
              updatedAt: event.createdAt,
            };
            const existingPrep = items.get(prepId);
            const existingRest = items.get(restId);
            items.set(prepId, existingPrep ? mergeCalendarItem(existingPrep, prepItem) : prepItem);
            items.set(restId, existingRest ? mergeCalendarItem(existingRest, restItem) : restItem);
          }
        }
      }
        return;
      }
      if (!isCalendarPatchEvent(event)) return;
      const id = resolvePatchCalendarId(event);
      if (!id) return;
      items.set(id, applyCalendarPatch(items.get(id), event, names, {
        conversationName: getConversationDisplayName(chat),
        sourceDeleted: Boolean(chat.deletedAt),
      }));
    });
  });
  const projectedItems = detectConflicts(mergeMatchingCalendarActivities(
    Array.from(items.values()).filter((item) => !deletedItemIds.has(item.id) && !deletedItemIds.has(item.derivedFromItemId || '')),
  ))
    .map((item) => ({
      ...item,
      status: options.inferTemporalStatus === false ? item.status : deriveTemporalCalendarStatus(item.status, item.startAt, item.endAt, now),
    }))
    .filter((item) => !options.conversationId || item.sourceRefs.some((ref) => ref.conversationId === options.conversationId))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    items: projectedItems,
    patchDraftQueue: buildPatchDraftQueue(projectedItems),
  };
}

export function projectWorldCalendarItems(chats: GroupChat[], characters: AICharacter[], options: { conversationId?: string | null; now?: number } = {}) {
  return projectWorldCalendar(chats, characters, options).items;
}

export function projectWorldMoments(chats: GroupChat[], characters: AICharacter[], options: { includeCandidates?: boolean } = {}) {
  const names = characterNameMap(characters);
  const moments: WorldMomentItem[] = [];
  const byDedupeKey = new Map<string, number>();
  const candidateRefsByDedupeKey = new Map<string, WorldMomentItem['sourceRefs']>();
  const mergeMomentSourceRef = (sourceRefs: WorldMomentItem['sourceRefs'], chat: GroupChat, event: RuntimeEventV2) => {
    const matchedSource = sourceRefs.find((item) => item.conversationId === chat.id);
    if (!matchedSource) {
      sourceRefs.push({
        conversationId: chat.id,
        conversationName: getConversationDisplayName(chat),
        eventIds: [event.id],
        weight: getSourceEvidenceWeight(event),
        lastEvidenceAt: event.createdAt,
      });
      return;
    }
    const previousEventCount = matchedSource.eventIds.length;
    const mergedEventIds = Array.from(new Set([...matchedSource.eventIds, event.id]));
    matchedSource.eventIds = mergedEventIds;
    matchedSource.weight = mergeSourceEvidence(
      matchedSource.weight,
      getSourceEvidenceWeight(event),
      previousEventCount,
      mergedEventIds.length,
    );
    matchedSource.lastEvidenceAt = Math.max(matchedSource.lastEvidenceAt, event.createdAt);
  };
  chats.forEach((chat) => {
    const events = chat.runtimeEventsV2 || [];
    const settledIntents = new Set(events.filter((event) => event.kind === 'artifact'
      && ['completed', 'cancelled'].includes(getString(getPayload(event).status)))
      .map((event) => getString(getPayload(event).intentId)).filter(Boolean));
    const settledCandidates = new Set(events.filter((event) => settledIntents.has(event.id))
      .map((event) => getString(getPayload(event).candidateId)).filter(Boolean));
    events.forEach((event) => {
      const payload = getPayload(event);
      const eventKind = getString(payload.eventKind);
      const artifactType = getString(payload.artifactType);
      const isMomentArtifact = event.kind === 'artifact' && eventKind === 'post_moment' && artifactType === 'moment_text';
      const isStatusArtifact = event.kind === 'artifact' && eventKind === 'status_update' && artifactType === 'status_note';
      const isCheckInArtifact = event.kind === 'artifact' && eventKind === 'check_in' && artifactType === 'check_in_note';
      const isReactMomentArtifact = event.kind === 'artifact' && eventKind === 'react_to_moment' && artifactType === 'moment_reaction_note';
      const isMomentCandidate = event.kind === 'event_candidate' && eventKind === 'post_moment';
      const isStatusCandidate = event.kind === 'event_candidate' && eventKind === 'status_update';
      const isCheckInCandidate = event.kind === 'event_candidate' && eventKind === 'check_in';
      const isReactMomentCandidate = event.kind === 'event_candidate' && eventKind === 'react_to_moment';
      const isMoment = isMomentArtifact || isMomentCandidate;
      const isStatus = isStatusArtifact || isStatusCandidate;
      const isCheckIn = isCheckInArtifact || isCheckInCandidate;
      const isReactMoment = isReactMomentArtifact || isReactMomentCandidate;
      if (!isMoment && !isStatus && !isCheckIn && !isReactMoment) return;
      const isTentativeArtifact = event.kind === 'artifact' && payload.status === 'tentative';
      if ((isTentativeArtifact && settledIntents.has(event.id))
        || (event.kind === 'event_candidate' && settledCandidates.has(event.id))) return;
      if (event.kind === 'artifact' && !isTentativeArtifact && !isCompletedSocialArtifact(event)) return;
      if (isTentativeArtifact && !options.includeCandidates) return;
      if (isMomentArtifact && isLegacyMomentRecordText(getString(payload.text)) && !options.includeCandidates) return;
      const actorId = event.actorIds?.[0];
      const dedupeKey = getString(payload.dedupeKey);
      if (event.kind === 'event_candidate' || isTentativeArtifact) {
        if (dedupeKey) {
          const candidateRefs = candidateRefsByDedupeKey.get(dedupeKey) || [];
          mergeMomentSourceRef(candidateRefs, chat, event);
          candidateRefsByDedupeKey.set(dedupeKey, candidateRefs);
          const existingIndex = byDedupeKey.get(dedupeKey);
          if (typeof existingIndex === 'number' && moments[existingIndex]) {
            const existing = moments[existingIndex];
            const sourceRefs = [...existing.sourceRefs];
            mergeMomentSourceRef(sourceRefs, chat, event);
            moments[existingIndex] = { ...existing, sourceRefs };
          }
        }
        if (options.includeCandidates) {
          const sourceRefs = [{
            conversationId: chat.id,
            conversationName: getConversationDisplayName(chat),
            eventIds: [event.id],
            weight: getSourceEvidenceWeight(event),
            lastEvidenceAt: event.createdAt,
          }];
          moments.push({
            id: event.id,
            kind: isStatus ? 'status_update' : isCheckIn ? 'check_in' : isReactMoment ? 'react_to_moment' : 'post_moment',
            debugState: 'candidate',
            actorId,
            actorName: getActorName(actorId, names),
            title: getString(payload.title) || '候选动态',
            text: buildMomentCandidatePreview(getActorName(actorId, names), payload as unknown as SocialEventCandidatePayload),
            media: getMomentMedia(payload),
            debugEvidence: getMomentDebugEvidence(event, payload, 'candidate'),
            activityType: getString(payload.activityType) || getString(payload.reasonType) || undefined,
            expectedArtifacts: getStringArray(payload.expectedArtifacts),
            conversationId: chat.id,
            conversationName: getConversationDisplayName(chat),
            sourceRefs,
            visibility: event.visibility,
            createdAt: event.createdAt,
          });
        }
        return;
      }
      if (dedupeKey && byDedupeKey.has(dedupeKey)) {
        const existingIndex = byDedupeKey.get(dedupeKey) as number;
        const existing = moments[existingIndex];
        if (existing) {
          const sourceRefs = [...existing.sourceRefs];
          mergeMomentSourceRef(sourceRefs, chat, event);
          const upgraded = event.kind === 'artifact' && existing.id !== event.id;
          moments[existingIndex] = {
            ...existing,
            sourceRefs,
            ...(upgraded
              ? {
                id: event.id,
                text: resolveMomentPublicText(event, payload) || existing.text,
                media: getMomentMedia(payload).length ? getMomentMedia(payload) : existing.media,
                expectedArtifacts: getStringArray(payload.expectedArtifacts).length ? getStringArray(payload.expectedArtifacts) : existing.expectedArtifacts,
                visibility: event.visibility || existing.visibility,
                createdAt: event.createdAt,
                conversationId: chat.id,
                conversationName: getConversationDisplayName(chat),
              }
              : {}),
          };
        }
        return;
      }
      const sourceRefs = dedupeKey ? [...(candidateRefsByDedupeKey.get(dedupeKey) || [])] : [];
      mergeMomentSourceRef(sourceRefs, chat, event);
      moments.push({
        id: event.id,
        kind: isStatus ? 'status_update' : isCheckIn ? 'check_in' : isReactMoment ? 'react_to_moment' : 'post_moment',
        debugState: 'published',
        actorId,
        actorName: getActorName(actorId, names),
        title: getString(payload.title) || (
          isStatus
            ? '状态更新'
            : isCheckIn
              ? '问候跟进'
              : isReactMoment
                ? '动态回应'
                : '朋友圈'
        ),
        text: resolveMomentPublicText(event, payload),
        media: getMomentMedia(payload),
        debugEvidence: getMomentDebugEvidence(event, payload, 'published'),
        activityType: getString(payload.activityType) || undefined,
        expectedArtifacts: getStringArray(payload.expectedArtifacts),
        conversationId: chat.id,
        conversationName: getConversationDisplayName(chat),
        sourceRefs,
        visibility: event.visibility,
        createdAt: event.createdAt,
      });
      if (dedupeKey) byDedupeKey.set(dedupeKey, moments.length - 1);
    });
  });
  return moments.sort((left, right) => right.createdAt - left.createdAt);
}

export function projectWorldAttentionCandidates(chats: GroupChat[], characters: AICharacter[]) {
  const names = characterNameMap(characters);
  const aiIds = buildAiIdSet(characters);
  const attention: WorldAttentionCandidateItem[] = [];
  chats.filter((chat) => !chat.deletedAt).forEach((chat) => {
    (chat.runtimeEventsV2 || []).forEach((event) => {
      if (event.kind !== 'attention_candidate') return;
      const payload = getPayload(event);
      const actorId = event.actorIds?.[0];
      const targetIds = getStringArray(payload.targetIds).length ? getStringArray(payload.targetIds) : (event.targetIds || []);
      attention.push({
        id: event.id,
        actorId,
        actorRef: toActorRef(actorId, { aiIds }),
        actorName: getActorName(actorId, names),
        targetIds,
        targetRefs: targetIds.map((id) => toActorRef(id, { aiIds })).filter((item): item is ActorRef => Boolean(item)),
        targetNames: targetIds.map((id) => getActorName(id, names)),
        reason: getString(payload.reason) || event.summary,
        confidence: Math.max(0, Math.min(1, getNumber(payload.confidence) ?? 0.5)),
        conversationId: chat.id,
        conversationName: chat.name,
        createdAt: event.createdAt,
      });
    });
  });
  return attention.sort((left, right) => right.createdAt - left.createdAt);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function isQuietHour(timestamp: number) {
  const hour = new Date(timestamp).getHours();
  return hour >= 23 || hour < 7;
}

export function projectWorldAttentionStates(chats: GroupChat[], characters: AICharacter[], options: { now?: number } = {}) {
  const names = characterNameMap(characters);
  const aiIds = buildAiIdSet(characters);
  const now = options.now ?? Date.now();
  const states = new Map<string, WorldAttentionStateItem>();
  const relationshipByPair = new Map<string, { warmth: number; trust: number; threat: number; updatedAt: number }>();

  chats.filter((chat) => !chat.deletedAt).forEach((chat) => {
    (chat.relationshipLedger || []).forEach((entry) => {
      const pairKey = `${entry.actorId}->${entry.targetId}`;
      const existing = relationshipByPair.get(pairKey);
      const snapshot = {
        warmth: entry.current?.warmth || 0,
        trust: entry.current?.trust || 0,
        threat: entry.current?.threat || 0,
        updatedAt: entry.lastUpdatedAt || 0,
      };
      if (!existing || snapshot.updatedAt >= existing.updatedAt) {
        relationshipByPair.set(pairKey, snapshot);
      }
    });
  });

  chats.filter((chat) => !chat.deletedAt).forEach((chat) => {
    (chat.runtimeEventsV2 || []).forEach((event) => {
      if (event.kind !== 'attention_candidate') return;
      const payload = getPayload(event);
      const rawActorId = event.actorIds?.[0];
      const targetIds = getStringArray(payload.targetIds).length ? getStringArray(payload.targetIds) : (event.targetIds || []);
      if (!rawActorId || !targetIds.length) return;
      const normalizedPairs = rawActorId === 'user'
        ? targetIds.map((targetId) => ({ actorId: targetId, targetId: 'user' }))
        : targetIds.map((targetId) => ({ actorId: rawActorId, targetId }));
      normalizedPairs.forEach(({ actorId, targetId }) => {
        if (!actorId) return;
        const key = `${actorId}->${targetId}`;
        const confidence = clamp01(getNumber(payload.confidence) ?? 0.5);
        const existing = states.get(key);
        const baseScore = 0.4 + confidence * 0.45;
        const next: WorldAttentionStateItem = existing || {
          actorId,
          actorRef: toActorRef(actorId, { aiIds }) || { kind: 'system_agent', id: actorId },
          actorName: getActorName(actorId, names),
          targetId,
          targetRef: toActorRef(targetId, { aiIds }) || { kind: 'system_agent', id: targetId },
          targetName: getActorName(targetId, names),
          attentionScore: baseScore,
          restraint: 0.42,
          suggestedActions: ['check_in'],
          reasons: [],
          latestEvidenceAt: event.createdAt,
        };
        next.attentionScore = Math.max(next.attentionScore, baseScore);
        next.latestEvidenceAt = Math.max(next.latestEvidenceAt, event.createdAt);
        const reason = getString(payload.reason) || event.summary;
        if (reason && !next.reasons.includes(reason)) next.reasons.push(reason);
        states.set(key, next);
      });
    });
  });

  const recentUserPrivateAction = new Map<string, number>();
  chats.filter((chat) => !chat.deletedAt).forEach((chat) => {
    (chat.runtimeEventsV2 || []).forEach((event) => {
      if (!isCompletedSocialArtifact(event)) return;
      const payload = getPayload(event);
      const eventKind = getString(payload.eventKind);
      if (eventKind !== 'check_in' && eventKind !== 'pair_private_thread' && eventKind !== 'react_to_moment') return;
      const actorId = event.actorIds?.[0];
      const targetId = (event.targetIds || [])[0] || '';
      if (!actorId || !targetId) return;
      const key = `${actorId}->${targetId}`;
      const existing = recentUserPrivateAction.get(key) || 0;
      recentUserPrivateAction.set(key, Math.max(existing, event.createdAt));
    });
  });

  return Array.from(states.values()).map((state) => {
    const relation = relationshipByPair.get(`${state.actorId}->${state.targetId}`);
    const warmth = relation?.warmth || 0;
    const trust = relation?.trust || 0;
    const threat = relation?.threat || 0;
    const relationBoost = clamp01((warmth + trust - threat) / 20);
    const recentActionAt = recentUserPrivateAction.get(`${state.actorId}->${state.targetId}`) || 0;
    const recentSuppression = recentActionAt && now - recentActionAt < 90 * 60_000 ? 0.25 : 0;
    const quietSuppression = isQuietHour(now) ? 0.2 : 0;
    const threatSuppression = threat >= 8 ? 0.35 : 0;
    const highThreat = threat >= 8;
    const restraint = clamp01(0.35 + recentSuppression + quietSuppression + threatSuppression - relationBoost * 0.15);
    const attentionScore = clamp01(state.attentionScore + relationBoost * 0.25 - threatSuppression * 0.3);
    const suggestedActions: WorldAttentionStateItem['suggestedActions'] = [];
    if (!highThreat && attentionScore >= 0.7 && restraint <= 0.55) suggestedActions.push('private_message');
    if (!highThreat && attentionScore >= 0.58 && restraint <= 0.7) suggestedActions.push('check_in');
    if (!highThreat && attentionScore >= 0.5 && restraint <= 0.75) suggestedActions.push('ask_followup');
    if (attentionScore >= 0.45 && restraint <= 0.8) suggestedActions.push('react_to_moment');
    if (!highThreat && attentionScore >= 0.72 && restraint <= 0.58 && warmth >= 6 && trust >= 5) suggestedActions.push('invite_activity');
    if (!highThreat && attentionScore >= 0.62 && restraint <= 0.72 && trust >= 4) suggestedActions.push('calendar_reminder');
    if (!highThreat && attentionScore >= 0.56 && restraint <= 0.72 && warmth >= 5) suggestedActions.push('comfort');
    if (attentionScore >= 0.52 && restraint <= 0.78 && warmth >= 4) suggestedActions.push('share_moment');
    const reasons = [...state.reasons];
    if (relation) reasons.push(`关系基线：亲和${warmth} / 信任${trust} / 威胁${threat}`);
    if (recentSuppression > 0) reasons.push('最近已有私域触达，暂缓重复主动');
    if (quietSuppression > 0) reasons.push('夜间时段，降低主动打扰');
    if (threatSuppression > 0) reasons.push('威胁感偏高，抑制主动行为');
    return {
      ...state,
      attentionScore,
      restraint,
      suggestedActions: suggestedActions.length ? suggestedActions : ['react_to_moment'],
      reasons: reasons.slice(0, 4),
    };
  }).sort((left, right) => {
    if (right.attentionScore !== left.attentionScore) return right.attentionScore - left.attentionScore;
    if (left.restraint !== right.restraint) return left.restraint - right.restraint;
    return right.latestEvidenceAt - left.latestEvidenceAt;
  });
}
