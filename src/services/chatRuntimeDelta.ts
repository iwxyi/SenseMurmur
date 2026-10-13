import type { DriverMessageCommitTransition, GroupChat } from '../types/chat';

type ChatRuntimeDelta = NonNullable<DriverMessageCommitTransition['chatRuntimeDelta']>;

function applyOrderedDelta<T>(
  current: T[], upserts: T[], orderedKeys: string[], baseKeys: string[] | undefined,
  keyOf: (item: T) => string,
) {
  const byKey = new Map(current.map((item) => [keyOf(item), item]));
  upserts.forEach((item) => byKey.set(keyOf(item), item));
  const keys = new Set(orderedKeys);
  const base = baseKeys === undefined ? null : new Set(baseKeys);
  const concurrent = base ? current.filter((item) => !base.has(keyOf(item)) && !keys.has(keyOf(item))) : [];
  const ordered = [...keys].flatMap((key) => {
    const item = byKey.get(key);
    return item === undefined ? [] : [item];
  });
  return { ordered, concurrent };
}

export function applyRuntimeEventsDelta(
  current: NonNullable<GroupChat['runtimeEventsV2']>, delta: ChatRuntimeDelta['runtimeEventsV2'],
) {
  if (!delta) return current;
  const { ordered, concurrent } = applyOrderedDelta(current, delta.upserts, delta.orderedIds, delta.baseIds, (item) => item.id);
  // Preserve the producer's order unless another writer added events during finalization.
  return concurrent.length
    ? [...ordered, ...concurrent].sort((a, b) => a.createdAt - b.createdAt)
    : ordered;
}

export function applyRelationshipLedgerDelta(
  current: NonNullable<GroupChat['relationshipLedger']>, delta: ChatRuntimeDelta['relationshipLedger'],
) {
  if (!delta) return current;
  const { ordered, concurrent } = applyOrderedDelta(current, delta.upserts, delta.orderedPairKeys, delta.basePairKeys, (item) => item.pairKey);
  return [...ordered, ...concurrent];
}

export function buildChatRuntimeDeltaPatch(chat: GroupChat, delta: ChatRuntimeDelta): Partial<GroupChat> {
  return {
    ...(delta.runtimeEventsV2 ? { runtimeEventsV2: applyRuntimeEventsDelta(chat.runtimeEventsV2 || [], delta.runtimeEventsV2) } : {}),
    ...(delta.relationshipLedger ? { relationshipLedger: applyRelationshipLedgerDelta(chat.relationshipLedger || [], delta.relationshipLedger) } : {}),
  };
}
