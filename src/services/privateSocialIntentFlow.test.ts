import { describe, expect, it, vi } from 'vitest';
import { normalizeConversation, type GroupChat } from '../types/chat';
import { createTestChat } from '../test/fixtures';
import type { AICharacter } from '../types/character';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { buildPendingSocialIntentContext, buildSocialIntentArtifact, buildSocialIntentOutcomes, getUnsettledSocialIntents } from './socialIntentArtifact';
import { runPrivateSocialIntentFlow, type PrivateSocialIntentOps } from './privateSocialIntentFlow';
import { retainRuntimeEvents } from './runtimeEventRetention';

function fixture(target = 'user') {
  const artifact = buildSocialIntentArtifact({ eventKind: 'check_in', initiatorId: 'a', participantIds: ['a', target],
    targetIds: [target], reasonType: 'care', confidence: 0.9, urgency: 'soon', seedIntent: '问问昨晚睡得好吗',
    visibilityPlan: 'user_private' }, '甲', 'candidate');
  if (!artifact) throw new Error('Missing intent');
  const intent: RuntimeEventV2 = { id: 'intent', conversationId: 'group', kind: 'artifact', createdAt: 1,
    actorIds: ['a'], targetIds: [target], ...artifact };
  let chats = [createTestChat({ id: 'group', memberIds: ['a', 'b', 'user'], runtimeEventsV2: [intent] })];
  let current = true;
  const ops: PrivateSocialIntentOps = {
    getChats: () => chats,
    getCharacters: () => [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] as AICharacter[],
    isCurrent: () => current,
    addChat: vi.fn(async (draft) => {
      const chat = normalizeConversation({ ...draft, id: 'private' });
      chats.push(chat);
      return chat;
    }),
    applyPatch: async (id, build) => {
      const chat = chats.find((item) => item.id === id && item.deletedAt == null);
      if (!chat) return false;
      const patch = build(chat);
      if (!patch) return false;
      chats = chats.map((item) => item.id === id ? normalizeConversation({ ...item, ...patch }) : item);
      return true;
    },
  };
  return { ops, intent, chats: () => chats, setChats: (value: GroupChat[]) => { chats = value; },
    expire: () => { current = false; } };
}

describe('private social intention handoff', () => {
  it.each(['user', 'b'])('routes to an authorized %s conversation and returns only committed result state', async (target) => {
    const f = fixture(target);
    await runPrivateSocialIntentFlow(f.ops);
    const [source, destination] = f.chats();
    expect(destination.type).toBe(target === 'user' ? 'direct' : 'ai_direct');
    expect(destination.isActive).toBe(false);
    expect(buildPendingSocialIntentContext(source, 'a')).toBe('');
    expect(buildPendingSocialIntentContext(destination, 'a')).toContain('intent');
    expect(buildPendingSocialIntentContext(destination, target)).toBe('');
    expect(getUnsettledSocialIntents(source)).toHaveLength(1);
    const outcomes = buildSocialIntentOutcomes(destination, { id: 'private-message', senderId: 'a', content: '昨晚睡得好吗？',
      socialEventHints: [{ eventKind: 'check_in', intentId: 'intent', outcome: 'completed', evidenceText: '昨晚睡得好吗？' }] });
    expect(outcomes).toHaveLength(1);
    await f.ops.applyPatch(destination.id, (chat) => ({ runtimeEventsV2: [...(chat.runtimeEventsV2 || []), ...outcomes] }));
    await runPrivateSocialIntentFlow(f.ops);
    expect(getUnsettledSocialIntents(f.chats()[0])).toEqual([]);
    const result = f.chats()[0].runtimeEventsV2?.find((event) => event.id === 'intent:private-result');
    expect(result?.payload).toMatchObject({ status: 'completed', intentId: 'intent' });
    expect(JSON.stringify(result)).not.toContain('昨晚睡得好吗');
    expect(JSON.stringify(result)).not.toContain('private-message');
    await runPrivateSocialIntentFlow(f.ops);
    expect(f.ops.addChat).toHaveBeenCalledTimes(1);
    expect(f.chats()[0].runtimeEventsV2?.filter((event) => event.id === 'intent:private-result')).toHaveLength(1);
  });

  it('recovers after the destination succeeded and the source marker failed without duplicating the intent', async () => {
    const f = fixture();
    const apply = f.ops.applyPatch;
    f.ops.applyPatch = vi.fn(async (id, build) => {
      if (id === 'group') throw new Error('source write failed');
      return apply(id, build);
    });
    await expect(runPrivateSocialIntentFlow(f.ops)).rejects.toThrow('source write failed');
    expect(f.chats()[1].runtimeEventsV2?.filter((event) => event.id === 'intent')).toHaveLength(1);
    f.ops.applyPatch = apply;
    await runPrivateSocialIntentFlow(f.ops);
    expect(f.ops.addChat).toHaveBeenCalledTimes(1);
    expect(f.chats()[1].runtimeEventsV2?.filter((event) => event.id === 'intent')).toHaveLength(1);
    expect(f.chats()[0].runtimeEventsV2?.filter((event) => event.id === 'intent:handoff')).toHaveLength(1);
    expect(retainRuntimeEvents(f.chats()[0].runtimeEventsV2 || [], 0).map((event) => event.id))
      .toEqual(['intent', 'intent:handoff']);
  });

  it('keeps failed generation pending and propagates an explicit cancellation', async () => {
    const f = fixture();
    await runPrivateSocialIntentFlow(f.ops);
    const destination = f.chats()[1];
    expect(buildSocialIntentOutcomes(destination, { id: 'empty', senderId: 'a', content: '' })).toEqual([]);
    const outcomes = buildSocialIntentOutcomes(destination, { id: 'cancel', senderId: 'a', content: '这次先不问了。',
      socialEventHints: [{ eventKind: 'check_in', intentId: 'intent', outcome: 'cancelled', evidenceText: '这次先不问了' }] });
    await f.ops.applyPatch(destination.id, (chat) => ({ runtimeEventsV2: [...(chat.runtimeEventsV2 || []), ...outcomes] }));
    await runPrivateSocialIntentFlow(f.ops);
    expect(f.chats()[0].runtimeEventsV2?.find((event) => event.id === 'intent:private-result')?.payload)
      .toMatchObject({ status: 'cancelled' });
  });

  it('does not recreate deleted destinations or route an audience with additional participants', async () => {
    const f = fixture();
    await runPrivateSocialIntentFlow(f.ops);
    f.setChats(f.chats().map((chat) => chat.type === 'direct' ? { ...chat, deletedAt: 1 } : chat));
    await runPrivateSocialIntentFlow(f.ops);
    expect(f.ops.addChat).toHaveBeenCalledTimes(1);
    const other = fixture();
    other.intent.visibleToIds = ['a'];
    await runPrivateSocialIntentFlow(other.ops);
    expect(other.ops.addChat).not.toHaveBeenCalled();
  });

  it.each(['account', 'source'])('stops after %s expires during destination creation', async (reason) => {
    const f = fixture();
    const add = f.ops.addChat;
    f.ops.addChat = async (draft) => {
      const chat = await add(draft);
      if (reason === 'account') f.expire();
      else f.setChats(f.chats().filter((item) => item.id !== 'group'));
      return chat;
    };
    await runPrivateSocialIntentFlow(f.ops);
    expect(f.chats().find((chat) => chat.id === 'private')?.runtimeEventsV2 || []).toEqual([]);
  });

  it('does not transfer an intention after its target leaves the source during creation', async () => {
    const f = fixture();
    const add = f.ops.addChat;
    f.ops.addChat = async (draft) => {
      const chat = await add(draft);
      f.setChats(f.chats().map((item) => item.id === 'group'
        ? { ...item, memberIds: ['a', 'b'] } : item));
      return chat;
    };
    await runPrivateSocialIntentFlow(f.ops);
    expect(f.chats()[1].runtimeEventsV2 || []).toEqual([]);
  });

  it.each(['eventKind', 'targetIds', 'originConversationId'])('rejects a result with mismatched %s', async (field) => {
    const f = fixture();
    await runPrivateSocialIntentFlow(f.ops);
    const destination = f.chats()[1];
    const [outcome] = buildSocialIntentOutcomes(destination, { id: 'message', senderId: 'a', content: '睡得好吗？',
      socialEventHints: [{ eventKind: 'check_in', intentId: 'intent', outcome: 'completed', evidenceText: '睡得好吗' }] });
    if (field === 'targetIds') outcome.targetIds = ['b'];
    else outcome.payload = { ...outcome.payload, [field]: field === 'eventKind' ? 'gift_exchange' : 'other-group' };
    await f.ops.applyPatch(destination.id, (chat) => ({ runtimeEventsV2: [...(chat.runtimeEventsV2 || []), outcome] }));
    await runPrivateSocialIntentFlow(f.ops);
    expect(getUnsettledSocialIntents(f.chats()[0])).toHaveLength(1);
    expect(f.chats()[0].runtimeEventsV2?.some((event) => event.id === 'intent:private-result')).toBe(false);
  });
});
