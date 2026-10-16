import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupChat } from '../types/chat';
import { createTestChat } from '../test/fixtures';
import type { AICharacter } from '../types/character';
import { DEFAULT_AI_PROFILE, DEFAULT_IMAGE_AI_PROFILE, type AIModelProfile } from '../types/settings';
import type { MemoryItem } from './memoryTypes';
import { setAIGenerationRuntimeConfig } from './aiGenerationRuntimeConfig';
import { generateImageWithAdapter, generateJsonWithAdapter } from './aiGenerationAdapter';
import { persistGeneratedMomentMedia } from './momentMediaStorage';
import { getDailyMomentMemories, runDailyMomentFlow } from './dailyMomentRuntime';
import { projectWorldMoments } from './worldRuntimeProjection';
import { hasPendingAutoSocialEventCandidate } from '../hooks/useChatAutoSocialFlow';
import { retainRuntimeEvents } from './runtimeEventRetention';

vi.mock('./aiGenerationAdapter', () => ({ generateJsonWithAdapter: vi.fn(), generateImageWithAdapter: vi.fn() }));
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
    createdAt: Date.now() - 3 * 60 * 60_000, updatedAt: Date.now() - 3 * 60 * 60_000, ...overrides,
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
    chats = [createTestChat({ id: 'room-a', type: 'group', mode: 'open_chat', name: '茶友',
      memberIds: ['a'], isActive: true, runtimeEventsV2: [], createdAt: 1, updatedAt: 1, lastMessageAt: 1,
    })];
    profiles = [{ ...DEFAULT_AI_PROFILE, model: 'test-model', apiKey: 'test-key' }];
    vi.mocked(generateJsonWithAdapter).mockResolvedValue('{"publish":true,"text":"今天这缕茉莉花香，先记下来。"}');
    vi.mocked(generateImageWithAdapter).mockResolvedValue([{ dataUrl: 'data:image/png;base64,AQID', mimeType: 'image/png' }]);
    vi.mocked(persistGeneratedMomentMedia).mockResolvedValue({ assetId: 'local-image', thumbnailAssetId: 'local-image', url: 'local-image', thumbnailUrl: 'local-thumb', fullUrl: 'local-image', mimeType: 'image/png', sizeBytes: 3, alt: undefined, storage: 'local_indexeddb' });
  });
  afterEach(() => vi.useRealTimers());

  it('publishes actual generated text without user attention and does not replay its candidate', async () => {
    await runDailyMomentFlow('room-a', ops());
    expect(generateJsonWithAdapter).toHaveBeenCalledOnce();
    expect(vi.mocked(generateJsonWithAdapter).mock.calls[0][0].messages[0].content).toContain(actor.layeredMemories![0].text);
    expect(projectWorldMoments(chats, [actor])).toMatchObject([{ text: '今天这缕茉莉花香，先记下来。' }]);
    expect(hasPendingAutoSocialEventCandidate(chats[0])).toBe(false);
    await runDailyMomentFlow('room-a', ops());
    expect(generateJsonWithAdapter).toHaveBeenCalledOnce();
    expect(chats[0].lastMessageAt).toBe(1);
  });

  it('asks the model to decide whether a memory deserves a post', async () => {
    await runDailyMomentFlow('room-a', ops());
    expect(vi.mocked(generateJsonWithAdapter).mock.calls[0][0].systemPrompt).toContain('不要为了每日任务凑动态');
  });

  it('does not publish or reconsider unchanged memories when the model declines', async () => {
    vi.mocked(generateJsonWithAdapter).mockResolvedValue('{"publish":false,"text":""}');
    await runDailyMomentFlow('room-a', ops());
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
    chats[0] = { ...chats[0], runtimeEventsV2: retainRuntimeEvents(chats[0].runtimeEventsV2 || [], 0) };
    await runDailyMomentFlow('room-a', ops());
    expect(generateJsonWithAdapter).toHaveBeenCalledOnce();
    actor.layeredMemories = [...actor.layeredMemories!, memory({ id: 'new-memory', text: '今天完成一件值得纪念的事情。' })];
    await runDailyMomentFlow('room-a', ops());
    expect(generateJsonWithAdapter).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed model decisions without publishing', async () => {
    vi.mocked(generateJsonWithAdapter).mockResolvedValue('{"publish":true,"text":""}');
    await expect(runDailyMomentFlow('room-a', ops())).rejects.toThrow('每日朋友圈生成失败');
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
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
    expect(generateJsonWithAdapter).toHaveBeenCalledOnce();
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });

  it('waits 18 minutes after the latest group message and then publishes', async () => {
    chats[0].lastMessageAt = Date.now();
    const first = await runDailyMomentFlow('room-a', ops());
    expect(first?.nextCheckAt).toBe(Date.now() + 18 * 60_000);
    expect(generateJsonWithAdapter).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(18 * 60_000);
    await runDailyMomentFlow('room-a', ops());
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });

  it('keeps independent appointments across checks and retention without a serial character cooldown', async () => {
    const other = { ...actor, id: 'b', name: '乙', layeredMemories: [memory({
      id: 'memory-b', ownerId: 'b', subjectIds: ['b'],
    })] } as AICharacter;
    chats[0].memberIds = ['a', 'b'];
    const sharedOps = { ...ops(), getCharacters: () => [actor, other],
      loadCharacter: vi.fn(async (id: string) => id === 'a' ? actor : other) };
    const first = await runDailyMomentFlow('room-a', sharedOps);
    expect(projectWorldMoments(chats, [actor, other])).toHaveLength(0);
    const schedules = chats[0].runtimeEventsV2!.filter((event) => (event.payload as Record<string, unknown>).artifactType === 'daily_moment_schedule');
    expect(schedules).toHaveLength(2);
    expect(first?.nextCheckAt).toBeGreaterThan(Date.now());
    expect(first?.nextCheckAt).toBeLessThanOrEqual(Date.now() + 2 * 60 * 60_000);
    chats[0].runtimeEventsV2 = retainRuntimeEvents(chats[0].runtimeEventsV2!, 0);
    expect((await runDailyMomentFlow('room-a', sharedOps))?.nextCheckAt).toBe(first?.nextCheckAt);
    await vi.advanceTimersByTimeAsync(first!.nextCheckAt! - Date.now());
    const second = await runDailyMomentFlow('room-a', sharedOps);
    expect(projectWorldMoments(chats, [actor, other])).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(second!.nextCheckAt! - Date.now());
    await runDailyMomentFlow('room-a', sharedOps);
    expect(projectWorldMoments(chats, [actor, other])).toHaveLength(2);
  });

  it('rechecks chat activity when the model returns', async () => {
    vi.mocked(generateJsonWithAdapter).mockImplementationOnce(async () => {
      chats[0].lastMessageAt = Date.now();
      return '{"publish":true,"text":"暂缓发布"}';
    });
    const result = await runDailyMomentFlow('room-a', ops());
    expect(result?.nextCheckAt).toBe(Date.now() + 18 * 60_000);
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
  });

  it('stores real image media on image days', async () => {
    vi.setSystemTime(new Date(2026, 9, 15, 14));
    actor.layeredMemories = [memory()];
    profiles.push({ ...DEFAULT_IMAGE_AI_PROFILE, model: 'test-image', apiKey: 'test-key' });
    await runDailyMomentFlow('room-a', ops());
    expect(generateImageWithAdapter).toHaveBeenCalledOnce();
    expect(persistGeneratedMomentMedia).toHaveBeenCalledOnce();
    expect(projectWorldMoments(chats, [actor])[0].media).toMatchObject([{ url: 'local-thumb', fullUrl: 'local-image', assetId: 'local-image' }]);
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
    vi.mocked(generateJsonWithAdapter).mockRejectedValueOnce(new Error('text unavailable'));
    await expect(runDailyMomentFlow('room-a', ops())).rejects.toThrow('每日朋友圈生成失败');
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
    await runDailyMomentFlow('room-a', ops());
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });

  it('rechecks feature settings when the model finishes', async () => {
    vi.mocked(generateJsonWithAdapter).mockImplementationOnce(async () => {
      actor = { ...actor, generationPreferences: { moments: 'off' } };
      return '{"publish":true,"text":"不应发布"}';
    });
    await runDailyMomentFlow('room-a', ops());
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
  });

  it('does not publish into a switched account after generation', async () => {
    let current = true;
    vi.mocked(generateJsonWithAdapter).mockImplementationOnce(async () => {
      current = false;
      return '{"publish":true,"text":"旧账号动态"}';
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
    expect(generateJsonWithAdapter).toHaveBeenCalledOnce();
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });

  it('waits through quiet hours and resumes at the next check', async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 6));
    actor.layeredMemories = [memory()];
    await runDailyMomentFlow('room-a', ops());
    expect(generateJsonWithAdapter).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 9, 14, 8));
    await runDailyMomentFlow('room-a', ops());
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });
});
