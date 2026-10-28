import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AICharacter } from '../types/character';
import type { APIConfig } from '../types/settings';
import type { GroupChat } from '../types/chat';
import type { HomeCompanionshipSnapshot } from './companionshipProjection';
import { generateResponse } from './aiClient';
import { companionshipGenerationKey, generateHomeCompanionship, readGeneratedHomeCompanionship, readLatestHomeCompanionshipSnapshot } from './homeCompanionshipGeneration';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));
const model = vi.mocked(generateResponse);
const character = { id: 'char-a', name: '苏苏', speakingStyle: '轻快', background: '穿搭博主' } as AICharacter;
const snapshot: HomeCompanionshipSnapshot = {
  chatId: 'chat-a', characterId: character.id, characterName: character.name,
  text: '离线这段时间还惦记着：明天面试有点紧张。', tone: 'warm', debugLines: ['internal-id'], updatedAt: 100,
};
const config: APIConfig = { provider: 'openai', apiKey: '', baseUrl: '', model: 'test' };
const params = { snapshot, character, config, scope: 'test-user' };

beforeEach(() => model.mockReset());

describe('homeCompanionshipGeneration', () => {
  it('uses companionship material as model input and caches only generated prose', async () => {
    model.mockResolvedValue('还记着你的面试，等你愿意的时候，跟我说说吧。');
    const event = await generateHomeCompanionship(params);
    expect(model).toHaveBeenCalledOnce();
    expect(model.mock.calls[0]?.[2]?.[0]?.content).toContain('明天面试');
    expect(model.mock.calls[0]?.[2]?.[0]?.content).not.toContain('internal-id');
    expect(event.payload).toMatchObject({ decisionSource: 'model', text: '还记着你的面试，等你愿意的时候，跟我说说吧。' });
    const chat = { runtimeEventsV2: [event] };
    const key = companionshipGenerationKey(snapshot, character);
    expect(readGeneratedHomeCompanionship(chat, key, event.createdAt + 1)).toBe('还记着你的面试，等你愿意的时候，跟我说说吧。');
    expect(readGeneratedHomeCompanionship(chat, key, event.createdAt + 7 * 60 * 60 * 1000)).toBeNull();
    expect(readGeneratedHomeCompanionship(chat, `${key}-changed`, event.createdAt + 1)).toBeNull();
  });

  it('shares concurrent generation for the same conversation and account', async () => {
    model.mockResolvedValue('刚才又想起你了。');
    const results = await Promise.all([generateHomeCompanionship(params), generateHomeCompanionship(params)]);
    expect(model).toHaveBeenCalledOnce();
    expect(results[0].id).toBe(results[1].id);
  });

  it('generates an event when crypto.randomUUID is unavailable', async () => {
    const cryptoApi = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: cryptoApi.getRandomValues.bind(cryptoApi) });
    try {
      model.mockResolvedValue('等你回来再聊。');
      const event = await generateHomeCompanionship(params);
      expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects raw prompts and propagates model failures without a local replacement', async () => {
    model.mockResolvedValue('对刘备的关系纹理可以私下写成余波，不要写成系统记录：放心不下。');
    await expect(generateHomeCompanionship(params)).rejects.toThrow('正文格式');
    model.mockRejectedValue(new Error('model unavailable'));
    await expect(generateHomeCompanionship(params)).rejects.toThrow('model unavailable');
    model.mockResolvedValue('有点想你，等你慢慢接上话。');
    await expect(generateHomeCompanionship(params)).resolves.toMatchObject({ payload: { text: '有点想你，等你慢慢接上话。' } });
  });

  it('does not share pending generation between accounts', async () => {
    model.mockResolvedValue('刚才又想起你了。');
    await Promise.all([generateHomeCompanionship(params), generateHomeCompanionship({ ...params, scope: 'another-user' })]);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it('reads the latest saved prose without requiring offline material or a matching input key', async () => {
    model.mockResolvedValue('还惦记着你。');
    const event = await generateHomeCompanionship(params);
    const chat = { id: snapshot.chatId, type: 'direct', memberIds: [character.id, 'user'], runtimeEventsV2: [
      { ...event, id: 'older', createdAt: event.createdAt - 1, payload: { ...event.payload, text: '之前的牵挂。' } },
      event,
    ] } as GroupChat;
    expect(readLatestHomeCompanionshipSnapshot({ chats: [chat], characters: [character], now: event.createdAt + 1 }))
      .toMatchObject({ chatId: chat.id, characterId: character.id, text: '还惦记着你。', tone: 'warm' });
    expect(readLatestHomeCompanionshipSnapshot({ chats: [chat], characters: [character], now: event.createdAt + 7 * 60 * 60 * 1000 })).toBeNull();
  });

  it('does not restore notes from deleted chats, groups, unknown characters or non-model events', async () => {
    model.mockResolvedValue('还惦记着你。');
    const event = await generateHomeCompanionship(params);
    const chat = { id: snapshot.chatId, type: 'direct', memberIds: [character.id, 'user'], runtimeEventsV2: [event] } as GroupChat;
    const read = (candidate: GroupChat, characters = [character]) => readLatestHomeCompanionshipSnapshot({
      chats: [candidate], characters, now: event.createdAt + 1,
    });
    expect(read({ ...chat, deletedAt: event.createdAt })).toBeNull();
    expect(read({ ...chat, type: 'group' })).toBeNull();
    expect(read(chat, [])).toBeNull();
    expect(read({ ...chat, memberIds: ['user'] })).toBeNull();
    expect(read({ ...chat, runtimeEventsV2: [{ ...event, payload: { ...event.payload, decisionSource: 'local' } }] })).toBeNull();
    expect(read({ ...chat, runtimeEventsV2: [{ ...event, payload: { ...event.payload, text: ' ' } }] })).toBeNull();
  });
});
