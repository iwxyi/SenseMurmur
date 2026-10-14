import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { buildDirectChatDraft } from './chatDraftBuilder';
import { buildAiPrivateChatDraft } from './directSessionRuntime';
import { getUnsettledSocialIntents } from './socialIntentArtifact';
import { retainRuntimeEvents } from './runtimeEventRetention';

interface IntentPayload {
  initiatorId?: string;
  participantIds?: string[];
  intentId?: string;
  artifactType?: string;
  eventKind?: string;
  status?: string;
  candidateId?: string;
  dedupeKey?: string;
  originConversationId?: string;
  destinationConversationId?: string;
}

export interface PrivateSocialIntentOps {
  getChats: () => GroupChat[];
  getCharacters: () => AICharacter[];
  isCurrent: () => boolean;
  addChat: (draft: Omit<GroupChat, 'id' | 'createdAt' | 'updatedAt' | 'lastMessageAt'>) => Promise<GroupChat>;
  applyPatch: (id: string, build: (chat: GroupChat) => Partial<GroupChat> | null) => Promise<boolean>;
}

function intentPair(source: GroupChat, intent: RuntimeEventV2): [string, string] | null {
  const payload = intent.payload as IntentPayload;
  const actor = payload.initiatorId;
  const targets = [...new Set(intent.targetIds || [])];
  if (!actor || targets.length !== 1 || targets[0] === actor || !source.memberIds.includes(actor)
    || !source.memberIds.includes(targets[0]) || intent.visibility !== 'pair_private'
    || intent.visibleToRoles?.length) return null;
  const pair: [string, string] = [actor, targets[0]];
  if (payload.participantIds?.some((id) => !pair.includes(id))
    || (intent.visibleToIds?.length && pair.some((id) => !intent.visibleToIds?.includes(id)))) return null;
  return pair;
}

function matchesDestination(chat: GroupChat, sourceId: string, pair: [string, string]) {
  if (chat.deletedAt != null) return false;
  const members = new Set(chat.memberIds);
  if (chat.type === 'direct') members.add('user');
  return members.size === 2 && pair.every((id) => members.has(id))
    && (pair.includes('user') ? chat.type === 'direct' : chat.type === 'ai_direct' && chat.sourceChatId === sourceId);
}

function appendEvent(chat: GroupChat, event: RuntimeEventV2) {
  if (chat.runtimeEventsV2?.some((item) => item.id === event.id)) return null;
  return { runtimeEventsV2: retainRuntimeEvents([...(chat.runtimeEventsV2 || []), event], 160) };
}

// The target is written first. A retry can finish the source marker without sending a message twice.
export async function runPrivateSocialIntentFlow(ops: PrivateSocialIntentOps) {
  for (const sourceId of ops.getChats().filter((chat) => chat.type === 'group' && chat.deletedAt == null).map((chat) => chat.id)) {
    if (!ops.isCurrent()) return;
    const source = ops.getChats().find((chat) => chat.id === sourceId && chat.deletedAt == null);
    if (!source) continue;
    const isLiveSource = () => ops.isCurrent()
      && ops.getChats().some((chat) => chat.id === sourceId && chat.deletedAt == null);
    for (const intent of getUnsettledSocialIntents(source)) {
      if (!isLiveSource()) break;
      const pair = intentPair(source, intent);
      if (!pair) continue;
      const isLiveIntent = () => {
        if (!isLiveSource()) return false;
        const current = ops.getChats().find((chat) => chat.id === sourceId);
        const pending = current && getUnsettledSocialIntents(current).find((event) => event.id === intent.id);
        return !!(current && pending && intentPair(current, pending)?.every((id, index) => id === pair[index]));
      };
      const markerId = `${intent.id}:handoff`;
      const marker = source.runtimeEventsV2?.find((event) => event.id === markerId);
      const destinationId = (marker?.payload as IntentPayload | undefined)?.destinationConversationId;
      let destination = destinationId
        ? ops.getChats().find((chat) => chat.id === destinationId && matchesDestination(chat, sourceId, pair))
        : ops.getChats().find((chat) => matchesDestination(chat, sourceId, pair));
      // Deleting a routed conversation does not recreate it behind the user's back.
      if (destinationId && !destination) continue;
      if (!destination) {
        const actor = ops.getCharacters().find((character) => character.id === pair[0]);
        const target = ops.getCharacters().find((character) => character.id === pair[1]);
        if (!actor || (pair[1] !== 'user' && !target)) continue;
        const draft = pair[1] === 'user' ? buildDirectChatDraft(actor.id, actor.name)
          : target ? buildAiPrivateChatDraft(source, actor, target) : null;
        if (!draft) continue;
        destination = await ops.addChat(draft);
      }
      if (!isLiveIntent()) continue;
      const targetId = destination.id;
      const routed: RuntimeEventV2 = { ...intent, conversationId: targetId,
        threadRef: undefined, visibleToIds: pair,
        payload: { ...intent.payload, originConversationId: sourceId } };
      await ops.applyPatch(targetId, (current) => isLiveIntent() && matchesDestination(current, sourceId, pair)
        ? appendEvent(current, routed) : null);
      if (!isLiveIntent()) continue;
      destination = ops.getChats().find((chat) => chat.id === targetId && matchesDestination(chat, sourceId, pair));
      if (!destination?.runtimeEventsV2?.some((event) => event.id === intent.id
        && (event.payload as IntentPayload).originConversationId === sourceId)) continue;
      await ops.applyPatch(sourceId, (current) => {
        if (!isLiveIntent() || !getUnsettledSocialIntents(current).some((event) => event.id === intent.id)) return null;
        return appendEvent(current, { id: markerId, conversationId: sourceId, kind: 'artifact',
          createdAt: Date.now(), actorIds: [pair[0]], targetIds: [pair[1]], visibility: 'pair_private', visibleToIds: pair,
          summary: '私域意图已交接，等待实际表达',
          payload: { artifactType: 'social_intent_handoff', intentId: intent.id, destinationConversationId: targetId } });
      });
      for (const outcome of destination.runtimeEventsV2 || []) {
        const payload = outcome.payload as IntentPayload;
        const original = intent.payload as IntentPayload;
        if (outcome.kind !== 'artifact' || payload.intentId !== intent.id
          || payload.artifactType !== original.artifactType || payload.eventKind !== original.eventKind
          || outcome.conversationId !== targetId || outcome.targetIds?.length !== 1 || outcome.targetIds[0] !== pair[1]
          || !['completed', 'cancelled'].includes(payload.status || '')
          || payload.originConversationId !== sourceId || payload.initiatorId !== pair[0]
          || outcome.actorIds?.[0] !== pair[0] || outcome.visibility !== 'pair_private'
          || !outcome.evidenceMessageIds?.length) continue;
        await ops.applyPatch(sourceId, (current) => {
          if (!isLiveIntent() || !getUnsettledSocialIntents(current).some((event) => event.id === intent.id)) return null;
          return appendEvent(current, { id: `${intent.id}:private-result`, conversationId: sourceId,
            kind: 'artifact', createdAt: outcome.createdAt, actorIds: [pair[0]], targetIds: [pair[1]],
            visibility: 'pair_private', visibleToIds: pair, summary: '私域意图的结果已记录',
            payload: { artifactType: payload.artifactType, eventKind: payload.eventKind,
              initiatorId: pair[0], candidateId: payload.candidateId, dedupeKey: payload.dedupeKey,
              intentId: intent.id, status: payload.status, destinationConversationId: targetId } });
        });
      }
    }
  }
}
