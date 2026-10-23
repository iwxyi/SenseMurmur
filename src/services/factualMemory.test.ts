import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { APIConfig } from '../types/settings';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), flush: vi.fn(), report: vi.fn(), warn: vi.fn(), request: vi.fn(), cloud: false,
  messages: [] as Message[], chats: [] as GroupChat[] }));
vi.mock('./aiClient', () => ({ generateJsonResponse: mocks.generate }));
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(), api: { request: mocks.request },
}));
vi.mock('./diagnostics', () => ({ reportRecoverableError: mocks.report, reportRecoverableWarning: mocks.warn }));
vi.mock('./cloudSyncPreference', () => ({ isCloudSyncEnabled: () => mocks.cloud }));
vi.mock('../stores/useAuthStore', () => ({ useAuthStore: { getState: () => ({ authMode: 'cloud' }) } }));
vi.mock('../stores/useChatStore', () => ({ useChatStore: { getState: () => ({ chats: mocks.chats }) } }));
vi.mock('../stores/useMessageStore', () => ({ useMessageStore: { getState: () => ({ messages: mocks.messages, messageWindowsByChatId: {} }) } }));
vi.mock('../stores/storePersistenceScope', async (importOriginal) => ({
  ...await importOriginal<typeof import('../stores/storePersistenceScope')>(),
  flushBufferedPersistenceWrites: mocks.flush,
}));

import { scheduleFactRecording, flushFactRecording, listDetailedFacts, listConversationDetailedFacts, recallLocalFacts, setDetailedFactDeleted } from './factualMemory';
import { useFactArchiveStore } from '../stores/useFactArchiveStore';
import { ApiError } from './api';

describe('detailed fact recording notifications', () => {
  const chat = { id: 'chat-1', mode: 'open_chat', memberIds: ['actor-1'] } as GroupChat;
  const message = {
    id: 'message-1', chatId: chat.id, senderId: 'actor-1', senderName: '角色', type: 'ai',
    content: '暗号定为青梅煮酒', timestamp: 100, isDeleted: false,
  } as Message;
  const facts = [{ text: '暗号定为青梅煮酒', status: 'agreed', sourceIds: [message.id] }];
  beforeEach(async () => {
    await flushFactRecording();
    await useFactArchiveStore.persist.rehydrate();
    useFactArchiveStore.setState({ chats: {} });
    vi.clearAllMocks();
    mocks.cloud = false;
    mocks.messages = [];
    mocks.chats = [];
    mocks.flush.mockResolvedValue(undefined);
    mocks.generate.mockResolvedValue(JSON.stringify({ facts }));
  });

  it('lists saved facts in a moderator-only source-linked hint after durable save', async () => {
    const appendEventMessage = vi.fn(async () => {
      expect(mocks.flush).toHaveBeenCalledOnce();
      expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].facts).toEqual(facts);
    });
    const params = { api: {} as APIConfig, chat, message, messages: [], appendEventMessage };
    scheduleFactRecording(params);
    scheduleFactRecording(params);
    await flushFactRecording();
    expect(appendEventMessage).toHaveBeenCalledExactlyOnceWith(chat.id, {
      eventType: 'detailed_fact_recorded', title: '详细事实已保存',
      summary: '新增 1 条详细事实：\n1. 暗号定为青梅煮酒',
      visibilityScope: 'moderator_only',
    }, message.id);
    scheduleFactRecording(params);
    await flushFactRecording();
    expect(appendEventMessage).toHaveBeenCalledOnce();
  });

  it('does not notify when no facts were extracted', async () => {
    mocks.generate.mockResolvedValue(JSON.stringify({ facts: [] }));
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(appendEventMessage).not.toHaveBeenCalled();
  });

  it('persists deletion and undo without removing the shared fact or changing its index', async () => {
    mocks.chats = [chat];
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    const [fact] = await listConversationDetailedFacts(chat.id);
    await setDetailedFactDeleted(fact, true);
    expect(await listConversationDetailedFacts(chat.id)).toEqual([]);
    expect(recallLocalFacts('actor-1')).toEqual([]);
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].facts).toEqual(facts);
    expect(mocks.flush).toHaveBeenCalled();
    await setDetailedFactDeleted(fact, false);
    expect(await listConversationDetailedFacts(chat.id)).toMatchObject([{ id: fact.id, text: fact.text }]);
  });

  it('cloud deletion tombstones suppress stale local copies and cloud undo restores them', async () => {
    mocks.chats = [chat];
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    const [fact] = await listConversationDetailedFacts(chat.id);
    useFactArchiveStore.getState().save(chat.id, { ...useFactArchiveStore.getState().chats[chat.id].entries[message.id], synced: true });
    mocks.cloud = true;
    mocks.request.mockResolvedValue({ items: [{ ...fact, userDeleted: true }] });
    expect(await listConversationDetailedFacts(chat.id)).toEqual([]);
    expect(recallLocalFacts('actor-1')).toEqual([]);
    mocks.request.mockResolvedValue({ items: [{ ...fact, userDeleted: false }] });
    expect(await listConversationDetailedFacts(chat.id)).toMatchObject([{ id: fact.id }]);
    mocks.request.mockRejectedValue(new Error('offline'));
    await expect(setDetailedFactDeleted(fact, true)).rejects.toThrow('offline');
    expect(useFactArchiveStore.getState().chats[chat.id].deletions?.[fact.id]).toEqual({ deleted: false, synced: true });
  });

  it('lists only the source conversation facts even when its messages are outside the UI window', async () => {
    const otherChat = { ...chat, id: 'other-chat', memberIds: ['other-actor'] };
    mocks.chats = [chat, otherChat];
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    const otherMessage = { ...message, id: 'other-message', chatId: otherChat.id, senderId: 'other-actor' };
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts }))
      .mockResolvedValueOnce(JSON.stringify({ facts: [{ ...facts[0], text: '另一会话的约定', sourceIds: [otherMessage.id] }] }));
    scheduleFactRecording({ api: {} as APIConfig, chat: otherChat, message: otherMessage, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    mocks.messages = [];
    expect((await listConversationDetailedFacts(chat.id)).map((fact) => fact.text)).toEqual([facts[0].text]);
    expect((await listConversationDetailedFacts(otherChat.id)).map((fact) => fact.text)).toEqual(['另一会话的约定']);
    useFactArchiveStore.getState().invalidate([message.id]);
    expect(await listConversationDetailedFacts(chat.id)).toEqual([]);
  });

  it('reads a source archive from the cloud without impersonating a character', async () => {
    mocks.cloud = true;
    const items = [{ id: 'cloud-old:0', chatId: chat.id, text: facts[0].text, status: 'agreed', timestamp: 1 }];
    mocks.request.mockResolvedValueOnce({ items });
    expect(await listConversationDetailedFacts(chat.id)).toEqual(items);
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith('POST', '/chats/chat-1/fact-archive/list', {});
  });

  it('keeps the pending cloud fallback scoped to the requested source conversation', async () => {
    mocks.chats = [chat];
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    mocks.cloud = true;
    mocks.request.mockResolvedValueOnce({ saved: 1 })
      .mockRejectedValueOnce(new ApiError('尚未同步', { status: 409, code: 'MEMORY_BRANCH_SOURCE_MISSING' }));
    expect((await listConversationDetailedFacts(chat.id)).map((fact) => fact.text)).toEqual([facts[0].text]);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('serializes bubbles and supplies already saved facts separately from new evidence', async () => {
    const next = { ...message, id: 'message-2', content: '好，我记下了', timestamp: 101 };
    const appendEventMessage = vi.fn();
    // Even an exact duplicate with a fresh source must not produce a second archive fact.
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts }))
      .mockResolvedValueOnce(JSON.stringify({ facts: [{ ...facts[0], sourceIds: [next.id] }] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    scheduleFactRecording({ api: {} as APIConfig, chat, message: next, messages: [message], appendEventMessage });
    await flushFactRecording();
    const input = JSON.parse(mocks.generate.mock.calls[1][2][0].content);
    expect(input.newMessage).toEqual({ id: next.id, speaker: next.senderName, content: next.content });
    expect(input.contextMessages).toEqual([{ id: message.id, speaker: message.senderName, content: message.content }]);
    expect(input.existingFacts).toEqual([{ ref: 'f0', text: facts[0].text, status: facts[0].status, sourceIds: facts[0].sourceIds }]);
    expect(useFactArchiveStore.getState().chats[chat.id].entries[next.id].facts).toEqual([]);
    expect(appendEventMessage).toHaveBeenCalledOnce();
  });

  it('does not upload empty extraction checkpoints or unrelated context evidence', async () => {
    mocks.cloud = true;
    mocks.request.mockResolvedValueOnce({ items: [] }).mockResolvedValue({ saved: 1 });
    const previous = { ...message, id: 'previous', content: '普通接话', timestamp: 99 };
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [previous], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(mocks.request).toHaveBeenNthCalledWith(2, 'POST', '/chats/chat-1/fact-archive', {
      messageId: message.id, facts, sources: [{ id: message.id, content: message.content }],
    });
    mocks.request.mockClear();
    mocks.request.mockResolvedValueOnce({ items: [] });
    mocks.generate.mockResolvedValue(JSON.stringify({ facts: [] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message: { ...message, id: 'empty' }, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith('POST', '/chats/chat-1/fact-maintenance-context', { messageId: 'empty' });
    expect(useFactArchiveStore.getState().chats[chat.id].entries.empty.synced).toBe(true);
  });

  it('presents one merged fact, syncs its references and restores the prior fact if new evidence is withdrawn', async () => {
    mocks.chats = [chat];
    const next = { ...message, id: 'message-2', content: '暗号用于明早接头', timestamp: 101 };
    const merged = { text: '明早接头暗号为青梅煮酒', status: 'agreed', sourceIds: [message.id, next.id], mergeWith: ['f0'] };
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts }))
      .mockResolvedValueOnce(JSON.stringify({ facts: [merged] }));
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    scheduleFactRecording({ api: {} as APIConfig, chat, message: next, messages: [message], appendEventMessage });
    await flushFactRecording();
    expect(recallLocalFacts('actor-1', chat).map((fact) => fact.text)).toEqual([merged.text]);
    expect(appendEventMessage.mock.calls[1][1].summary).toBe(`合并更新 1 条详细事实：\n1. 【合并更新】${merged.text}`);
    mocks.cloud = true;
    mocks.messages = [{ ...message, serverId: 'server-1' }, { ...next, serverId: 'server-2' }];
    mocks.request.mockResolvedValueOnce({ saved: 1 }).mockResolvedValueOnce({ saved: 1 })
      .mockResolvedValueOnce({ items: [{ id: 'server-1:0', chatId: chat.id, text: facts[0].text, status: 'agreed', timestamp: 100 }] });
    const result = await listDetailedFacts('actor-1', chat);
    expect(result.map((fact) => fact.text)).toEqual([merged.text]);
    expect(mocks.request.mock.calls[1][2].facts[0]).toEqual({ text: merged.text, status: 'agreed', sourceIds: ['server-1', 'server-2'],
      mergedFrom: [{ messageId: 'server-1', factIndex: 0 }] });
    useFactArchiveStore.getState().invalidate([next.id]);
    expect(recallLocalFacts('actor-1', chat).map((fact) => fact.text)).toEqual([facts[0].text]);
  });

  it('labels additions and merged updates separately when a message produces both', async () => {
    const next = { ...message, id: 'message-mixed', content: '明早接头用青梅煮酒，我还欠张飞三两银子', timestamp: 101 };
    const merged = { text: '明早接头暗号为青梅煮酒', status: 'agreed', sourceIds: [message.id, next.id], mergeWith: ['f0'] };
    const added = { text: '说话人欠张飞三两银子', status: 'asserted', sourceIds: [next.id] };
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts }))
      .mockResolvedValueOnce(JSON.stringify({ facts: [merged, added] }));
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    scheduleFactRecording({ api: {} as APIConfig, chat, message: next, messages: [message], appendEventMessage });
    await flushFactRecording();
    expect(appendEventMessage.mock.calls[1][1].summary).toBe(
      `新增 1 条，合并更新 1 条详细事实：\n1. 【合并更新】${merged.text}\n2. ${added.text}`,
    );
  });

  it('maintains facts whose original messages are outside the recent context window', async () => {
    mocks.chats = [chat];
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    const next = { ...message, id: 'later', timestamp: 200, content: '这个暗号只在渡口使用' };
    const merged = { text: '渡口接头暗号为青梅煮酒', status: 'agreed', sourceIds: [message.id, next.id], mergeWith: ['f0'] };
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts: [merged] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message: next, messages: [], appendEventMessage });
    await flushFactRecording();
    const input = JSON.parse(mocks.generate.mock.calls[1][2][0].content);
    expect(input.contextMessages).toEqual([]);
    expect(input.existingFacts[0].text).toBe(facts[0].text);
    expect(recallLocalFacts('actor-1').map((item) => item.text)).toEqual([merged.text]);
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('stores one fact for multiple knowers without granting it to a later member', async () => {
    const group = { ...chat, memberIds: ['actor-1', 'actor-2'] };
    mocks.chats = [group];
    scheduleFactRecording({ api: {} as APIConfig, chat: group, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(recallLocalFacts('actor-1')[0].id).toBe(recallLocalFacts('actor-2')[0].id);
    expect(recallLocalFacts('actor-2')[0].knownByIds).toEqual(['user', 'actor-1', 'actor-2']);
    mocks.chats = [{ ...group, memberIds: [...group.memberIds, 'actor-3'] }];
    expect(recallLocalFacts('actor-3')).toEqual([]);
    expect(Object.values(useFactArchiveStore.getState().chats[chat.id].entries)).toHaveLength(1);
  });

  it('retracts a mistaken record for those who heard the correction and restores it if that evidence is withdrawn', async () => {
    mocks.chats = [chat];
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    const next = { ...message, id: 'correction', timestamp: 200, content: '你记错了，刚才是演练台词，不是接头约定' };
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts: [{ text: '刚才暗号约定被误记，实际是演练台词',
      status: 'agreed', sourceIds: [message.id, next.id], mergeWith: ['f0'], retracted: true }] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message: next, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(recallLocalFacts('actor-1')).toEqual([]);
    expect(appendEventMessage.mock.calls[1][1].summary).toContain('作废 1 条详细事实');
    mocks.cloud = true;
    mocks.request.mockResolvedValueOnce({ saved: 1 }).mockResolvedValueOnce({ saved: 1 })
      .mockResolvedValueOnce({ items: [{ id: `${message.id}:0`, chatId: chat.id, ...facts[0], timestamp: 100 }] });
    expect(await listDetailedFacts('actor-1')).toEqual([]);
    useFactArchiveStore.getState().invalidate([next.id]);
    expect(recallLocalFacts('actor-1').map((item) => item.text)).toEqual([facts[0].text]);
  });

  it('uses cloud-only archived facts for maintenance without requiring original messages in the UI window', async () => {
    mocks.cloud = true;
    mocks.chats = [chat];
    const oldSource = { id: 'old', nodeId: 'old', content: '约定暗号青梅煮酒', senderId: 'actor-1', senderName: '角色',
      timestamp: 1, audience: ['user', 'actor-1'] };
    mocks.request.mockResolvedValueOnce({ items: [{ messageId: 'old', factIndex: 0,
      fact: { ...facts[0], sourceIds: ['old'] }, sources: [oldSource] }] }).mockResolvedValueOnce({ saved: 1 });
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts: [{ text: '渡口暗号为青梅煮酒', status: 'agreed',
      sourceIds: ['old', message.id], mergeWith: ['f0'] }] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(JSON.parse(mocks.generate.mock.calls[0][2][0].content).existingFacts[0].text).toBe(facts[0].text);
    expect(mocks.request.mock.calls[1][2].sources).toContainEqual({ id: oldSource.id, content: oldSource.content });
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('reports maintenance read failure and does not extract against a silently empty archive', async () => {
    mocks.cloud = true;
    mocks.request.mockRejectedValueOnce(new Error('archive read failed'));
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ location: 'memory.fact-record' }));
  });

  it('retains server aliases from archived evidence so an unloaded local source cannot resurrect after retraction', async () => {
    mocks.chats = [chat];
    const local = { ...message, id: 'local-message-old' };
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts: [{ ...facts[0], sourceIds: [local.id] }] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message: local, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    const next = { ...message, id: 'server-next', content: '那是演练台词，记成真实约定是错的', timestamp: 200 };
    mocks.cloud = true;
    mocks.request.mockResolvedValueOnce({ items: [{ messageId: 'server-old', factIndex: 0,
      fact: { ...facts[0], sourceIds: ['server-old'] }, sources: [{ id: 'server-old', nodeId: local.id,
        senderId: local.senderId, senderName: local.senderName, content: local.content, timestamp: 100, audience: ['user', 'actor-1'] }] }] })
      .mockResolvedValueOnce({ saved: 1 });
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts: [{ text: '原记录误提取演练台词，作废', status: 'agreed',
      sourceIds: [local.id, next.id], mergeWith: ['f0'], retracted: true }] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message: next, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(JSON.parse(mocks.generate.mock.calls[1][2][0].content).existingFacts).toHaveLength(1);
    expect(mocks.request.mock.calls[1][2].facts[0].mergedFrom).toEqual([{ messageId: 'server-old', factIndex: 0 }]);
    mocks.request.mockResolvedValueOnce({ saved: 1 }).mockResolvedValueOnce({ items: [
      { id: 'server-old:0', chatId: chat.id, text: facts[0].text, status: 'agreed', timestamp: 100 },
    ] });
    expect(await listDetailedFacts('actor-1')).toEqual([]);
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('uses validated local facts without warnings while cloud evidence is pending', async () => {
    mocks.chats = [chat];
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    mocks.cloud = true;
    mocks.request.mockResolvedValueOnce({ saved: 1 })
      .mockRejectedValueOnce(new ApiError('来源未齐', { code: 'MEMORY_BRANCH_SOURCE_MISSING', status: 409 }));
    expect((await listDetailedFacts('actor-1', chat)).map((fact) => fact.text)).toEqual([facts[0].text]);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('keeps maintenance and save pending without warnings and retries without duplicate extraction', async () => {
    mocks.cloud = true;
    mocks.request.mockRejectedValueOnce(new ApiError('新消息未同步', { code: 'MEMORY_BRANCH_SOURCE_MISSING', status: 409 }))
      .mockRejectedValueOnce(new ApiError('来源未齐', { code: 'MEMORY_BRANCH_SOURCE_MISSING', status: 409 }));
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].synced).toBeUndefined();
    mocks.request.mockResolvedValueOnce({ saved: 1 }).mockResolvedValueOnce({ items: [] });
    await listDetailedFacts('actor-1', chat);
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].synced).toBe(true);
    expect(appendEventMessage).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it('retries an invalid source using the precise field diagnostic and saves only the validated result', async () => {
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts: [{ ...facts[0], sourceIds: ['角色'] }] }))
      .mockResolvedValueOnce(JSON.stringify({ facts }));
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[1][1]).toContain('facts[0].sourceIds[0]');
    expect(mocks.generate.mock.calls[1][2]).toEqual(mocks.generate.mock.calls[0][2]);
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ location: 'memory.fact-record-validation' }));
    expect(mocks.report).not.toHaveBeenCalled();
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].facts).toEqual(facts);
    expect(appendEventMessage).toHaveBeenCalledOnce();
  });

  it('reports persistent contract failure without saving invalid facts or emitting success', async () => {
    mocks.generate.mockResolvedValue(JSON.stringify({ facts: [{ ...facts[0], status: 'established' }] }));
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id]).toBeUndefined();
    expect(appendEventMessage).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenLastCalledWith(expect.objectContaining({
      location: 'memory.fact-record', error: expect.objectContaining({ field: 'facts[0].status' }),
    }));
  });

  it('excludes context-only facts with a field diagnostic while saving new facts without retry or invented evidence', async () => {
    const previous = { ...message, id: 'previous', content: '之前的约定', timestamp: 99 };
    mocks.generate.mockResolvedValueOnce(JSON.stringify({ facts: [
      ...facts, { text: '之前的约定', status: 'agreed', sourceIds: [previous.id] },
    ] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [previous], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].facts).toEqual(facts);
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({
      location: 'memory.fact-record-context-only', error: expect.objectContaining({ field: 'facts[1].sourceIds' }),
    }));
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('maps fact references and evidence snapshots to the same server ids when retrying a local archive', async () => {
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    mocks.cloud = true;
    mocks.messages = [{ ...message, serverId: 'server-message-1' }];
    mocks.request.mockResolvedValueOnce({ saved: 1 }).mockResolvedValueOnce({ items: [] });
    await listDetailedFacts('actor-1', chat);
    expect(mocks.request).toHaveBeenNthCalledWith(1, 'POST', '/chats/chat-1/fact-archive', {
      messageId: 'server-message-1', facts: [{ ...facts[0], sourceIds: ['server-message-1'] }],
      sources: [{ id: 'server-message-1', content: message.content }],
    });
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].synced).toBe(true);
  });

  it('continues cloud recall when an unsynced archive fails to upload and keeps it retryable', async () => {
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    mocks.cloud = true;
    const items = [{ id: 'cloud-fact', text: '已同步事实', status: 'agreed', timestamp: 1, chatId: chat.id }];
    mocks.request.mockRejectedValueOnce(new Error('save failed')).mockResolvedValueOnce({ items });
    expect(await listDetailedFacts('actor-1', chat)).toEqual(items);
    expect(mocks.request).toHaveBeenLastCalledWith('POST', '/chats/chat-1/fact-recall', { actorId: 'actor-1' });
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].synced).toBeUndefined();
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ location: 'memory.fact-sync' }));
  });

  it('reports failed persistence without emitting a success hint', async () => {
    mocks.flush.mockRejectedValueOnce(new Error('storage failure'));
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(appendEventMessage).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ location: 'memory.fact-record' }));
  });

  it('distinguishes hint delivery failure from fact extraction failure', async () => {
    const appendEventMessage = vi.fn().mockRejectedValue(new Error('event failure'));
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].facts).toEqual(facts);
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ location: 'memory.fact-record-hint' }));
  });

  it('still notifies local save success if cloud synchronization fails', async () => {
    mocks.cloud = true;
    mocks.request.mockResolvedValueOnce({ items: [] }).mockRejectedValueOnce(new Error('network failure'));
    const appendEventMessage = vi.fn().mockResolvedValue(undefined);
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(appendEventMessage).toHaveBeenCalledOnce();
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].synced).toBeUndefined();
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ location: 'memory.fact-sync' }));
  });
});
