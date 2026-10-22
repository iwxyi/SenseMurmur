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

import { scheduleFactRecording, flushFactRecording, listDetailedFacts, recallLocalFacts } from './factualMemory';
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
    mocks.request.mockResolvedValue({ saved: 1 });
    const previous = { ...message, id: 'previous', content: '普通接话', timestamp: 99 };
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [previous], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith('POST', '/chats/chat-1/fact-archive', {
      messageId: message.id, facts, sources: [{ id: message.id, content: message.content }],
    });
    mocks.request.mockClear();
    mocks.generate.mockResolvedValue(JSON.stringify({ facts: [] }));
    scheduleFactRecording({ api: {} as APIConfig, chat, message: { ...message, id: 'empty' }, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    expect(mocks.request).not.toHaveBeenCalled();
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
    expect(appendEventMessage.mock.calls[1][1].summary).toContain('合并更新');
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

  it('uses validated local facts when cloud branch evidence is pending, while retaining the diagnostic', async () => {
    mocks.chats = [chat];
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage: vi.fn() });
    await flushFactRecording();
    mocks.cloud = true;
    mocks.request.mockResolvedValueOnce({ saved: 1 })
      .mockRejectedValueOnce(new ApiError('来源未齐', { code: 'MEMORY_BRANCH_SOURCE_MISSING', status: 409 }));
    expect((await listDetailedFacts('actor-1', chat)).map((fact) => fact.text)).toEqual([facts[0].text]);
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ location: 'memory.fact-recall-pending' }));
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('keeps incomplete cloud branch evidence pending and retries without a failure toast or duplicate fact', async () => {
    mocks.cloud = true;
    mocks.request.mockRejectedValueOnce(new ApiError('来源未齐', { code: 'MEMORY_BRANCH_SOURCE_MISSING', status: 409 }));
    const appendEventMessage = vi.fn();
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ location: 'memory.fact-sync-pending' }));
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
    mocks.request.mockRejectedValueOnce(new Error('network failure'));
    const appendEventMessage = vi.fn().mockResolvedValue(undefined);
    scheduleFactRecording({ api: {} as APIConfig, chat, message, messages: [], appendEventMessage });
    await flushFactRecording();
    expect(appendEventMessage).toHaveBeenCalledOnce();
    expect(useFactArchiveStore.getState().chats[chat.id].entries[message.id].synced).toBeUndefined();
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ location: 'memory.fact-sync' }));
  });
});
