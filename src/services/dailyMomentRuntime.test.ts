import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConversation, type GroupChat } from '../types/chat';
import type { AICharacter } from '../types/character';
import { DEFAULT_AI_PROFILE, DEFAULT_IMAGE_AI_PROFILE, type AIModelProfile } from '../types/settings';
import type { MemoryItem } from './memoryTypes';
import { setAIGenerationRuntimeConfig } from './aiGenerationRuntimeConfig';
import { generateImageWithAdapter, generateTextWithAdapter } from './aiGenerationAdapter';
import { persistGeneratedMomentMedia } from './momentMediaStorage';
import { getDailyMomentMemories, runDailyMomentFlow } from './dailyMomentRuntime';
import { projectWorldMoments } from './worldRuntimeProjection';
import { hasPendingAutoSocialEventCandidate } from '../hooks/useChatAutoSocialFlow';
import { retainRuntimeEvents } from './runtimeEventRetention';

vi.mock('./aiGenerationAdapter', () => ({ generateTextWithAdapter: vi.fn(), generateImageWithAdapter: vi.fn() }));
vi.mock('./momentMediaStorage', () => ({ persistGeneratedMomentMedia: vi.fn() }));

describe('daily moments from character memories', () => {
  let chats: GroupChat[];
  let actor: AICharacter;
  let profiles: AIModelProfile[];
  const onImageError = vi.fn();
  const memory = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
    id: 'memory-1', ownerId: 'a', scope: 'conversation', layer: 'episodic', kind: 'bond',
    text: '今天在群里和朋友讨论了茶，记住了茉莉花香。', subjectIds: ['a'],
    visibility: 'public_safe', validity: 'active', privacyRisk: 0.1,
    salience: 0.8, confidence: 0.9, recency: 1, reinforcementCount: 1, sourceEventIds: [],
    createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000, ...overrides,
  });
  const ops = () => ({
    isCurrentSource: () => true,
    getChats: () => chats, getCharacters: () => [actor], getProfiles: () => profiles,
    loadCharacter: vi.fn(async () => actor), onImageError,
    applyChatRuntimePatch: vi.fn(async (id: string, build: (chat: GroupChat) => Partial<GroupChat> | null) => {
      const index = chats.findIndex((chat) => chat.id === id);
      const patch = build(chats[index]);
      if (!patch) return false;
      chats[index] = { ...chats[index], ...patch };
      return true;
    }),
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 14, 14));
    vi.clearAllMocks();
    setAIGenerationRuntimeConfig({ enableMoments: true, enableDiaries: true });
    actor = { id: 'a', name: '甲', layeredMemories: [memory()] } as AICharacter;
    chats = [normalizeConversation({ id: 'room-a', type: 'group', mode: 'open_chat', name: '茶友',
      memberIds: ['a'], isActive: true, runtimeEventsV2: [], createdAt: 1, updatedAt: 1, lastMessageAt: 1,
    } as GroupChat)];
    profiles = [{ ...DEFAULT_AI_PROFILE, model: 'test-model', apiKey: 'test-key' }];
    vi.mocked(generateTextWithAdapter).mockResolvedValue('今天这缕茉莉花香，先记下来。');
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{ dataUrl: 'data:image/png;base64,AQID', mimeType: 'image/png' }]);
    vi.mocked(persistGeneratedMomentMedia).mockResolvedValue({ url: 'local-image', storage: 'local_indexeddb' });
  });
  afterEach(() => vi.useRealTimers());

  it('publishes actual generated text without user attention and does not replay its candidate', async () => {
    await runDailyMomentFlow('room-a', ops());
    expect(generateTextWithAdapter).toHaveBeenCalledOnce();
    expect(vi.mocked(generateTextWithAdapter).mock.calls[0][0].messages[0].content).toContain(actor.layeredMemories![0].text);
    expect(projectWorldMoments(chats, [actor])).toMatchObject([{ text: '今天这缕茉莉花香，先记下来。' }]);
    expect(hasPendingAutoSocialEventCandidate(chats[0])).toBe(false);
    await runDailyMomentFlow('room-a', ops());
    expect(generateTextWithAdapter).toHaveBeenCalledOnce();
    expect(chats[0].lastMessageAt).toBe(1);
  });

  it('uses the configured output budget so reasoning does not consume a body-sized limit', async () => {
    profiles[0].maxOutputTokens = 4096;
    await runDailyMomentFlow('room-a', ops());
    expect(vi.mocked(generateTextWithAdapter).mock.calls[0][0]).toMatchObject({ maxTokens: 4096 });
  });

  it('filters private, user, uncertain, archived, old and unrelated memories before the prompt', () => {
    actor.layeredMemories = [memory(), memory({ visibility: 'private', text: '秘密' }),
      memory({ subjectIds: ['user'], text: '用户私事' }), memory({ subjectOwner: 'user', text: '用户资料' }),
      memory({ validity: 'uncertain', text: '不确定' }), memory({ archivedAt: 1, text: '归档' }),
      memory({ updatedAt: Date.now() - 86400000, text: '昨天' }),
      memory({ ownerId: 'b', subjectIds: ['b'], text: '旁人' })];
    expect(getDailyMomentMemories(actor, chats[0])).toEqual([actor.layeredMemories[0].text]);
  });

  it('allows only one room to generate for a shared character', async () => {
    chats.push({ ...chats[0], id: 'room-b' });
    await Promise.all([runDailyMomentFlow('room-b', ops()), runDailyMomentFlow('room-a', ops()), runDailyMomentFlow('room-a', ops())]);
    expect(generateTextWithAdapter).toHaveBeenCalledOnce();
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });

  it('stores real image media on image days', async () => {
    vi.setSystemTime(new Date(2026, 9, 15, 14));
    actor.layeredMemories = [memory()];
    profiles.push({ ...DEFAULT_IMAGE_AI_PROFILE, model: 'test-image', apiKey: 'test-key' });
    await runDailyMomentFlow('room-a', ops());
    expect(generateImageWithAdapter).toHaveBeenCalledOnce();
    expect(persistGeneratedMomentMedia).toHaveBeenCalledOnce();
    expect(projectWorldMoments(chats, [actor])[0].media).toMatchObject([{ url: 'local-image' }]);
  });

  it('publishes text and reports image failure', async () => {
    vi.setSystemTime(new Date(2026, 9, 15, 14));
    actor.layeredMemories = [memory()];
    profiles.push({ ...DEFAULT_IMAGE_AI_PROFILE, model: 'test-image', apiKey: 'test-key' });
    vi.mocked(generateImageWithAdapter).mockRejectedValue(new Error('image unavailable'));
    await runDailyMomentFlow('room-a', ops());
    expect(onImageError).toHaveBeenCalledOnce();
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
    expect(projectWorldMoments(chats, [actor])[0].media).toEqual([]);
  });

  it('keeps model failures retryable and never publishes template text', async () => {
    vi.mocked(generateTextWithAdapter).mockRejectedValueOnce(new Error('text unavailable'));
    await expect(runDailyMomentFlow('room-a', ops())).rejects.toThrow('每日朋友圈生成失败');
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
    await runDailyMomentFlow('room-a', ops());
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });

  it('rechecks feature settings when the model finishes', async () => {
    vi.mocked(generateTextWithAdapter).mockImplementationOnce(async () => {
      actor = { ...actor, generationPreferences: { moments: 'off' } };
      return '不应发布';
    });
    await runDailyMomentFlow('room-a', ops());
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
  });

  it('does not publish into a switched account after generation', async () => {
    let current = true;
    vi.mocked(generateTextWithAdapter).mockImplementationOnce(async () => {
      current = false;
      return '旧账号动态';
    });
    await runDailyMomentFlow('room-a', { ...ops(), isCurrentSource: () => current });
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
    expect(generateImageWithAdapter).not.toHaveBeenCalled();
  });

  it('does not publish twice when ordinary runtime history is trimmed', async () => {
    await runDailyMomentFlow('room-a', ops());
    chats[0] = { ...chats[0], runtimeEventsV2: retainRuntimeEvents(chats[0].runtimeEventsV2 || [], 0) };
    expect(hasPendingAutoSocialEventCandidate(chats[0])).toBe(false);
    await runDailyMomentFlow('room-a', ops());
    expect(generateTextWithAdapter).toHaveBeenCalledOnce();
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });

  it('waits through quiet hours and resumes at the next check', async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 6));
    actor.layeredMemories = [memory()];
    await runDailyMomentFlow('room-a', ops());
    expect(generateTextWithAdapter).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 9, 14, 8));
    await runDailyMomentFlow('room-a', ops());
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });
});
