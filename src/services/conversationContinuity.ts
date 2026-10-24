import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { ConversationUpdate, ConversationItemUpdate } from '../types/conversationContinuity';
import type { RoomStateSnapshotV2 } from '../types/runtimeEvent';
import { resolveSessionFamilyKey } from './sessionEngineKeys';
import { sanitizeUserFacingText } from './displayTextSanitizer';
import { createInitialRoomState } from './roomStateSynthesizer';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, limit: number) {
  return typeof value === 'string' && value.trim().length <= limit ? value.trim() : '';
}

function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0)
    ? Array.from(new Set(value)) : null;
}

function pairs(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((pair): Array<[string, string]> => Array.isArray(pair) && pair.length === 2
    && pair.every((id) => typeof id === 'string' && id.length > 0) && pair[0] !== pair[1]
    ? [[pair[0], pair[1]]] : []);
}

export function normalizeConversationUpdate(value: unknown): ConversationUpdate | null {
  const raw = record(value);
  if (!raw) return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 12).flatMap((value): ConversationItemUpdate[] => {
    const item = record(value);
    if (!item) return [];
    const key = text(item.key, 64);
    const summary = text(item.summary, 240);
    const evidenceText = text(item.evidenceText, 240);
    const participantIds = ids(item.participantIds);
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || !summary || !evidenceText || !participantIds
      || !['issue', 'commitment', 'decision', 'condition'].includes(String(item.kind))
      || !['open', 'established', 'resolved', 'retracted'].includes(String(item.status))) return [];
    return [{ key, summary, evidenceText, participantIds,
      kind: item.kind as ConversationItemUpdate['kind'], status: item.status as ConversationItemUpdate['status'] }];
  });
  const rawRoom = record(raw.room);
  const roomEvidence = text(rawRoom?.evidenceText, 240);
  const room = rawRoom && roomEvidence ? {
    evidenceText: roomEvidence,
    addAlliances: pairs(rawRoom.addAlliances), removeAlliances: pairs(rawRoom.removeAlliances),
    addConflictPairs: pairs(rawRoom.addConflictPairs), removeConflictPairs: pairs(rawRoom.removeConflictPairs),
    ...(rawRoom.pileOnTarget === null || typeof rawRoom.pileOnTarget === 'string' ? { pileOnTarget: rawRoom.pileOnTarget } : {}),
    ...(ids(rawRoom.silencedActors) ? { silencedActors: ids(rawRoom.silencedActors) as string[] } : {}),
  } : undefined;
  const settledEvidence = text(record(raw.settled)?.evidenceText, 240);
  return items.length || room || settledEvidence
    ? { items, ...(room ? { room } : {}), ...(settledEvidence ? { settled: { evidenceText: settledEvidence,
      ...(record(raw.settled)?.scope === 'room' ? { scope: 'room' as const } : {}) } } : {}) } : null;
}

export function usesConversationContinuity(chat: GroupChat) {
  return chat.type === 'group' && resolveSessionFamilyKey(chat) === 'conversation';
}

export function isPendingConversationItem(item: Pick<ConversationItemUpdate, 'kind' | 'status'>) {
  return item.status === 'open' || (item.kind === 'commitment' && item.status === 'established');
}

// Only a public, committed speaker turn can establish public continuity.
export function applyConversationUpdate(chat: GroupChat, message: Pick<Message, 'content' | 'type' | 'senderId' | 'metadata'> & Partial<Pick<Message, 'id' | 'timestamp' | 'isDeleted'>>,
  room: RoomStateSnapshotV2 | null | undefined) {
  const previous = chat.worldState.conversationContinuity;
  if (!usesConversationContinuity(chat)) return { continuity: previous, room, changedItems: [] };
  if (message.type === 'user' || message.type === 'god') {
    return { continuity: previous ? { items: previous.items } : undefined, room, changedItems: [] };
  }
  const update = normalizeConversationUpdate(message.metadata?.conversationUpdate);
  if (message.type !== 'ai' || message.isDeleted || !chat.memberIds.includes(message.senderId) || message.metadata?.withdrawal?.withdrawn
    || (message.metadata?.visibility && message.metadata.visibility !== 'public') || !update) {
    return { continuity: previous, room, changedItems: [] };
  }
  const now = message.timestamp || Date.now();
  const members = new Set([...chat.memberIds, 'user']);
  const supports = (evidence: string) => message.content.includes(evidence);
  const items = new Map((previous?.items || []).map((item) => [item.key, item]));
  const changedItems = update.items.filter((item) => supports(item.evidenceText)
    && item.participantIds.every((id) => members.has(id))
    && (items.has(item.key) || (item.status !== 'resolved' && item.status !== 'retracted')));
  for (const item of changedItems) {
    const existing = items.get(item.key);
    items.set(item.key, { ...item, updatedAt: now,
      sourceMessageIds: Array.from(new Set([...(existing?.sourceMessageIds || []), ...(message.id ? [message.id] : [])])).slice(-8) });
  }
  let nextRoom = room;
  if (update.room && supports(update.room.evidenceText)) {
    const delta = update.room;
    const currentRoom = room || createInitialRoomState();
    const pairKey = (pair: [string, string]) => [...pair].sort().join('\u0000');
    const merge = (current: Array<[string, string]>, add: Array<[string, string]> = [], remove: Array<[string, string]> = []) => {
      const result = new Map(current.map((pair) => [pairKey(pair), pair]));
      for (const pair of remove) if (pair.every((id) => members.has(id))) result.delete(pairKey(pair));
      for (const pair of add) if (pair.every((id) => members.has(id))) result.set(pairKey(pair), pair);
      return [...result.values()];
    };
    nextRoom = { ...currentRoom,
      alliances: merge(currentRoom.alliances, delta.addAlliances, delta.removeAlliances),
      conflictPairs: merge(currentRoom.conflictPairs, delta.addConflictPairs, delta.removeConflictPairs),
      ...(delta.pileOnTarget === null || (delta.pileOnTarget && members.has(delta.pileOnTarget)) ? { pileOnTarget: delta.pileOnTarget } : {}),
      ...(delta.silencedActors?.every((id) => members.has(id)) ? { silencedActors: delta.silencedActors } : {}),
    };
  }
  const settled = update.settled && supports(update.settled.evidenceText);
  const reopened = changedItems.some((item) => item.status === 'open');
  const allItems = [...items.values()];
  const continuity = { items: [
    ...allItems.filter(isPendingConversationItem),
    ...allItems.filter((item) => !isPendingConversationItem(item)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 64),
  ], ...(settled ? { settledAt: now, settledScope: update.settled?.scope,
    settledEvidenceText: update.settled?.evidenceText, settledSourceMessageId: message.id }
    : !reopened && previous?.settledAt ? { settledAt: previous.settledAt,
      settledScope: previous.settledScope, settledEvidenceText: previous.settledEvidenceText,
      settledSourceMessageId: previous.settledSourceMessageId } : {}) };
  return { continuity, room: nextRoom, changedItems };
}

export function buildConversationContinuityContext(chat: GroupChat, members: Array<{ id: string; name: string }>) {
  if (!usesConversationContinuity(chat)) return '';
  const items = chat.worldState?.conversationContinuity?.items || [];
  const current = items.filter(isPendingConversationItem).sort((a, b) => b.updatedAt - a.updatedAt);
  const history = items.filter((item) => !isPendingConversationItem(item)).sort((a, b) => b.updatedAt - a.updatedAt);
  const participantLabel = (participantIds: string[]) => participantIds.length
    ? participantIds.map((id) => members.find((member) => member.id === id)?.name || (id === 'user' ? 'User' : 'Unknown member')).join(', ')
    : 'roomwide';
  return [...current, ...history.slice(0, 16)].map((item) =>
    `[${item.key}] ${item.kind}/${item.status}: ${sanitizeUserFacingText(item.summary, members)}; participants: ${participantLabel(item.participantIds)}; evidence: ${sanitizeUserFacingText(item.evidenceText, members)}`).join('\n');
}
