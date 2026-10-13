import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { MemoryCandidate, MemoryItem } from './memoryTypes';
import { consolidateMemoryCandidates } from './memoryConsolidation';
import { retrieveRelevantMemories } from './memoryRetrieval';
import type { MemoryCandidatePayload, RuntimeEventV2 } from '../types/runtimeEvent';
import type { RuntimeEventPayload } from './runtimeEventFactory';
import { normalizeRuntimeEvent } from './runtimeEventFactory';
import { retainRuntimeEvents } from './runtimeEventRetention';
import { sanitizeMemoryText } from './distillationText';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';

type RuntimeEventLike = RuntimeEventPayload;

function normalizeSubjectIds(ids: string[] = []) {
  return Array.from(new Set(ids.filter(Boolean)));
}

function summarizeInteractionKind(kind: string) {
  const labels: Record<string, string> = {
    support: '支持',
    defend: '维护',
    challenge: '挑战',
    mock: '嘲讽',
    dismiss: '轻视',
    pile_on: '围攻',
    probe: '追问',
    side_comment: '侧评',
    evade: '回避',
    redirect: '转移',
  };
  return labels[kind] || kind;
}

function buildDisplayMembers(chat: GroupChat): DisplayTextMember[] {
  return chat.memberIds.map((id) => ({
    id,
    name: id === 'user' ? '用户' : '成员',
  }));
}

function sanitizeMemoryCandidateText(chat: GroupChat, text: string, maxLength = 128) {
  const members = buildDisplayMembers(chat);
  const sanitized = sanitizeUserFacingText(text, members);
  return sanitizeMemoryText(sanitized).slice(0, maxLength);
}

function buildRelationshipMemoryText(chat: GroupChat, reason: string, summary: string) {
  return sanitizeMemoryCandidateText(chat, `${summarizeInteractionKind(reason)}：${summary}`, 128);
}

function buildRoomStateMemoryText(chat: GroupChat, summary: string) {
  return sanitizeMemoryCandidateText(chat, summary, 128);
}

function toParticipantNames(chat: GroupChat, ids: string[] = []) {
  return ids.map((id) => chat.memberIds.includes(id) ? id : id).filter(Boolean);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readDelta(value: unknown) {
  if (!isStringRecord(value)) return null;
  return {
    affinity: typeof value.affinity === 'number' ? value.affinity : 0,
    respect: typeof value.respect === 'number' ? value.respect : 0,
    hostility: typeof value.hostility === 'number' ? value.hostility : 0,
    contempt: typeof value.contempt === 'number' ? value.contempt : 0,
  };
}

function hasRoomShiftFields(payload: unknown) {
  return isStringRecord(payload) && ('heat' in payload || 'cohesion' in payload || 'topicDrift' in payload);
}

function readInteractionPayload(payload: unknown) {
  if (!isStringRecord(payload)) return null;
  const kind = readString(payload.kind);
  const actorId = readString(payload.actorId);
  const targetId = readString(payload.targetId);
  if (!kind || !actorId) return null;
  return { kind, actorId, targetId };
}

function readRelationshipDeltaPayload(payload: unknown) {
  if (!isStringRecord(payload)) return null;
  const actorId = readString(payload.actorId);
  const targetId = readString(payload.targetId);
  const reason = readString(payload.reason);
  const delta = readDelta(payload.delta);
  if (!actorId || !targetId || !reason || !delta) return null;
  return { actorId, targetId, reason, delta };
}

function buildMemoryCandidatesFromStructuredEvents(chat: GroupChat, events: RuntimeEventV2[]): MemoryCandidate[] {
  return events.flatMap<MemoryCandidate>((event) => {
    if (event.kind === 'interaction') {
      const payload = readInteractionPayload(event.payload);
      if (!payload) return [];
      const isPositive = payload.kind === 'support' || payload.kind === 'defend';
      const isNegative = payload.kind === 'challenge' || payload.kind === 'mock' || payload.kind === 'dismiss' || payload.kind === 'pile_on';
      if (!payload.targetId || (!isPositive && !isNegative)) return [];
      return [{
        scope: 'relationship',
        layerHint: 'episodic',
        kind: isPositive ? 'bond' : 'resentment',
        ownerId: chat.id,
        subjectIds: normalizeSubjectIds([payload.actorId, payload.targetId]),
        text: buildRelationshipMemoryText(chat, payload.kind, event.summary),
        sourceEventIds: [event.id],
        sourceTag: event.kind,
        scoreBreakdown: { stability: 0.65, recurrence: 0.55, impact: 0.78, specificity: 0.75, durability: 0.65 },
      }];
    }

    if (event.kind === 'relationship_delta') {
      const payload = readRelationshipDeltaPayload(event.payload);
      if (!payload) return [];
      const positive = payload.delta.affinity + payload.delta.respect;
      const negative = payload.delta.hostility + payload.delta.contempt;
      if (!positive && !negative) return [];
      return [{
        scope: 'relationship',
        layerHint: 'episodic',
        kind: positive >= negative ? 'bond' : 'resentment',
        ownerId: chat.id,
        subjectIds: normalizeSubjectIds([payload.actorId, payload.targetId]),
        text: buildRelationshipMemoryText(chat, payload.reason, event.summary),
        sourceEventIds: [event.id],
        sourceTag: event.kind,
        scoreBreakdown: { stability: 0.72, recurrence: 0.58, impact: 0.82, specificity: 0.76, durability: 0.68 },
      }];
    }

    if (event.kind === 'room_shift') {
      if (!hasRoomShiftFields(event.payload)) return [];
      return [{
        scope: 'system_runtime',
        layerHint: 'working',
        kind: 'status_shift',
        ownerId: chat.id,
        subjectIds: normalizeSubjectIds(toParticipantNames(chat, event.actorIds)),
        text: buildRoomStateMemoryText(chat, event.summary),
        sourceEventIds: [event.id],
        sourceTag: event.kind,
        scoreBreakdown: { stability: 0.55, recurrence: 0.62, impact: 0.72, specificity: 0.74, durability: 0.52 },
      }];
    }

    return [];
  });
}

function filterNovelStructuredEvents(chat: GroupChat, events: RuntimeEventV2[]) {
  const seen = new Set((chat.layeredMemories || []).flatMap((item) => item.sourceEventIds || []));
  return events.filter((event) => !seen.has(event.id));
}

function buildMemoryCandidatesFromStructuredRuntime(chat: GroupChat) {
  return buildMemoryCandidatesFromStructuredEvents(chat, filterNovelStructuredEvents(chat, chat.runtimeEventsV2 || []));
}

function hasStructuredRuntime(chat: GroupChat) {
  return Boolean(chat.runtimeEventsV2?.length);
}

function shouldUseLegacyFallback(chat: GroupChat, events: RuntimeEventLike[]) {
  return !hasStructuredRuntime(chat) && events.length === 0;
}

function filterLegacyEventIds(ids: string[]) {
  return ids.filter(Boolean).slice(-8);
}

function compactStructuredSummary(text: string) {
  return sanitizeMemoryText(text).slice(0, 128);
}

function buildConflictCandidate(chat: GroupChat): MemoryCandidate | null {
  if (!chat.worldState.conflictAxes?.length) return null;
  return {
    scope: 'conversation',
    layerHint: 'episodic',
    kind: 'conflict',
    ownerId: chat.id,
    text: sanitizeMemoryCandidateText(chat, `${chat.worldState.conflictAxes.map((axis) => `${axis.title}:${axis.currentTilt || 0}`).join('；')}`),
    sourceEventIds: [],
    scoreBreakdown: { stability: 0.55, recurrence: 0.6, impact: 0.7, specificity: 0.65, durability: 0.6 },
  };
}

function buildWorldStateCandidate(chat: GroupChat): MemoryCandidate | null {
  if (!chat.worldState.focus && !chat.worldState.mood && !chat.worldState.recentEvent) return null;
  return {
    scope: 'system_runtime',
    layerHint: 'working',
    kind: 'status_shift',
    ownerId: chat.id,
    text: sanitizeMemoryCandidateText(chat, [chat.worldState.mood, chat.worldState.focus, chat.worldState.recentEvent].filter(Boolean).join(' / '), 120),
    sourceEventIds: [],
    scoreBreakdown: { stability: 0.45, recurrence: 0.55, impact: 0.6, specificity: 0.6, durability: 0.45 },
  };
}

function buildMemoryCandidatesFromRuntimeEvents(chat: GroupChat, events: RuntimeEventLike[]): MemoryCandidate[] {
  return events.map((event) => normalizeRuntimeEvent(event)).flatMap<MemoryCandidate>((event) => {
    if (event.eventType === 'group_relationship_shift' || event.eventType === 'relationship_shift') {
      const metrics = isStringRecord(event.metrics) ? event.metrics : null;
      const delta = metrics && isStringRecord(metrics.delta) ? metrics.delta : null;
      const positive = Number(delta?.warmth || 0) + Number(delta?.competence || 0) + Number(delta?.trust || 0);
      const negative = Number(delta?.threat || 0);
      return [{
        scope: 'relationship',
        layerHint: 'episodic',
        kind: positive >= negative ? 'bond' : 'resentment',
        ownerId: chat.id,
        subjectIds: event.pair || [],
        text: sanitizeMemoryCandidateText(chat, `${event.title}：${event.summary}`, 128),
        sourceEventIds: filterLegacyEventIds([event.eventType, String(event.createdAt || '')]),
        sourceTag: event.eventType,
        scoreBreakdown: { stability: 0.65, recurrence: 0.55, impact: 0.8, specificity: 0.7, durability: 0.65 },
      }];
    }

    if (event.eventType === 'private_chat_started') {
      return [{
        scope: 'thread',
        layerHint: 'episodic',
        kind: 'thread_effect',
        ownerId: chat.id,
        subjectIds: event.pair || [],
        text: sanitizeMemoryCandidateText(chat, `${event.title}：${event.summary}`, 128),
        sourceEventIds: filterLegacyEventIds([event.eventType, String(event.createdAt || '')]),
        sourceTag: event.eventType,
        scoreBreakdown: { stability: 0.6, recurrence: 0.45, impact: 0.75, specificity: 0.7, durability: 0.6 },
      }];
    }

    if (event.eventType === 'conflict_axis_shift') {
      return [{
        scope: 'conversation',
        layerHint: 'episodic',
        kind: 'conflict',
        ownerId: chat.id,
        text: compactStructuredSummary(event.summary),
        sourceEventIds: filterLegacyEventIds([event.eventType, String(event.createdAt || '')]),
        scoreBreakdown: { stability: 0.7, recurrence: 0.6, impact: 0.8, specificity: 0.7, durability: 0.65 },
      }];
    }

    if (event.eventType === 'world_state_shift') {
      return [{
        scope: 'system_runtime',
        layerHint: 'working',
        kind: 'status_shift',
        ownerId: chat.id,
        text: compactStructuredSummary(event.summary),
        sourceEventIds: filterLegacyEventIds([event.eventType, String(event.createdAt || '')]),
        scoreBreakdown: { stability: 0.5, recurrence: 0.55, impact: 0.7, specificity: 0.65, durability: 0.5 },
      }];
    }

    if (event.eventType === 'message_withdrawn') {
      return [{
        scope: 'conversation',
        layerHint: 'episodic',
        kind: 'status_shift',
        ownerId: chat.id,
        subjectIds: event.metrics && typeof event.metrics === 'object' && 'actorId' in event.metrics && typeof event.metrics.actorId === 'string' ? [event.metrics.actorId] : [],
        text: sanitizeMemoryCandidateText(chat, `${event.title}：撤回本身成为公开可见的余波，原文不进入公开记忆。`, 128),
        sourceEventIds: filterLegacyEventIds([event.eventType, String(event.createdAt || '')]),
        sourceTag: event.eventType,
        scoreBreakdown: { stability: 0.56, recurrence: 0.45, impact: 0.72, specificity: 0.7, durability: 0.52 },
      }];
    }

    return [];
  });
}

export function buildMemoryCandidates(chat: GroupChat, message: Pick<Message, 'content' | 'type' | 'senderId'>, events: RuntimeEventLike[] = []) {
  const normalizedEvents = events.map((event) => normalizeRuntimeEvent(event));
  const structuredCandidates = buildMemoryCandidatesFromStructuredRuntime(chat);
  const eventCandidates = buildMemoryCandidatesFromRuntimeEvents(chat, normalizedEvents);
  const fallbackCandidates = shouldUseLegacyFallback(chat, normalizedEvents) ? [
    buildConflictCandidate(chat),
    buildWorldStateCandidate(chat),
  ].filter(Boolean) as MemoryCandidate[] : [];
  return [...structuredCandidates, ...eventCandidates, ...fallbackCandidates];
}

export function classifyMemoryCandidateKind(item: MemoryItem): MemoryCandidatePayload['kind'] {
  if (item.scope === 'relationship') return 'relationship';
  if (item.kind === 'decision') return 'fact';
  if (item.kind === 'status_shift') return 'topic';
  return 'topic';
}

export function buildMemoryCandidateEvents(params: {
  chat: GroupChat;
  message: Pick<Message, 'content' | 'type' | 'senderId'>;
  existingMemories?: MemoryItem[];
  nextMemories?: MemoryItem[];
}) {
  const beforeIds = new Set((params.existingMemories || []).map((item) => item.id));
  return (params.nextMemories || [])
    .filter((item) => !beforeIds.has(item.id))
    .map<RuntimeEventV2>((item) => ({
      id: `mem_${item.id}`,
      conversationId: params.chat.id,
      kind: 'memory_candidate',
      createdAt: item.createdAt,
      actorIds: [params.message.senderId],
      targetIds: item.subjectIds,
      summary: item.text,
      payload: {
        kind: classifyMemoryCandidateKind(item),
        text: item.text,
        salience: item.salience,
        confidence: item.confidence,
        origin: item.origin,
        sharedPhrase: item.sharedPhrase,
      } as MemoryCandidatePayload,
    }));
}

export function appendMemoryCandidateEvents(existingEvents: RuntimeEventV2[], newEvents: RuntimeEventV2[]) {
  if (!newEvents.length) return existingEvents;
  const existingIds = new Set(existingEvents.map((event) => event.id));
  return retainRuntimeEvents([...existingEvents, ...newEvents.filter((event) => !existingIds.has(event.id))], 160);
}

export function updateLayeredMemories(existing: MemoryItem[], chat: GroupChat, message: Pick<Message, 'content' | 'type' | 'senderId'>) {
  return consolidateMemoryCandidates(existing, buildMemoryCandidates(chat, message));
}

export function updateLayeredMemoriesWithEvents(existing: MemoryItem[], chat: GroupChat, message: Pick<Message, 'content' | 'type' | 'senderId'>, events: RuntimeEventLike[] = []) {
  return consolidateMemoryCandidates(existing, buildMemoryCandidates(chat, message, events));
}

export function summarizeLayeredMemories(items: MemoryItem[]) {
  return items.slice(-3).map((item) => item.text).join(' / ');
}

export function getMemoryContext(
  items: MemoryItem[],
  speakerId: string,
  targetId: string | null | undefined,
  conversationId: string,
  preferredSourceTags?: string[],
  allowedSourceTags?: string[],
  blockedSourceTags?: string[],
  boosts?: { relationshipBoost?: boolean; selfMemoryBoost?: boolean; conversationBoost?: boolean },
  cueText?: string,
  limits?: { maxItems?: number; maxArchivedItems?: number },
) {
  return retrieveRelevantMemories(items, {
    speakerId,
    targetId,
    conversationId,
    maxItems: limits?.maxItems || 6,
    cueText,
    includeArchivedRecall: Boolean(cueText?.trim()),
    maxArchivedItems: limits?.maxArchivedItems || 2,
    preferredLayers: ['working', 'episodic', 'long_term'],
    preferredScopes: targetId ? ['relationship', 'conversation', 'thread', 'character_self', 'system_runtime'] : ['conversation', 'relationship', 'character_self', 'thread', 'system_runtime'],
    preferredSourceTags,
    allowedSourceTags,
    blockedSourceTags,
    relationshipBoost: boosts?.relationshipBoost,
    selfMemoryBoost: boosts?.selfMemoryBoost,
    conversationBoost: boosts?.conversationBoost,
  });
}
