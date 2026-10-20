import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupChat } from '../types/chat';
import { createTestChat } from '../test/fixtures';
import type { AICharacter } from '../types/character';
import { DEFAULT_AI_PROFILE, DEFAULT_IMAGE_AI_PROFILE, type AIModelProfile } from '../types/settings';
import type { MemoryItem } from './memoryTypes';
import { setAIGenerationRuntimeConfig } from './aiGenerationRuntimeConfig';
import { generateImageWithAdapter, generateJsonWithAdapter } from './aiGenerationAdapter';
import { persistGeneratedMomentMedia } from './momentMediaStorage';
import { DailyMomentFlowError, getDailyMomentMemories, runDailyMomentFlow } from './dailyMomentRuntime';
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

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

  it('lets the model share ordinary daily life without requiring novelty', async () => {
    await runDailyMomentFlow('room-a', ops());
    const request = vi.mocked(generateJsonWithAdapter).mock.calls[0][0];
    expect(request.systemPrompt).toContain('朋友圈不需要重大事件、独特见解或新鲜感');
    expect(request.systemPrompt).toContain('闲着想找人聊两句');
    expect(request.messages[0].content).not.toContain('拿不准就不发');
    expect(projectWorldMoments(chats, [actor])).toHaveLength(1);
  });

  it('reconsiders a legacy strict skip once and respects the new decline', async () => {
    vi.mocked(generateJsonWithAdapter).mockResolvedValue('{"publish":false,"text":""}');
    await runDailyMomentFlow('room-a', ops());
    chats[0] = { ...chats[0], runtimeEventsV2: chats[0].runtimeEventsV2!.map((event) => {
      if ((event.payload as { artifactType?: string }).artifactType !== 'daily_moment_skip') return event;
      return { ...event, payload: { ...event.payload, decisionPolicyVersion: undefined } };
    }) };
    await runDailyMomentFlow('room-a', ops());
    expect(generateJsonWithAdapter).toHaveBeenCalledTimes(2);
    await runDailyMomentFlow('room-a', ops());
    expect(generateJsonWithAdapter).toHaveBeenCalledTimes(2);
    expect(projectWorldMoments(chats, [actor])).toEqual([]);
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
    await expect(runDailyMomentFlow('room-a', ops())).rejects.toMatchObject({
      message: '每日朋友圈生成失败（a / 校验发布判断与正文）',
      failures: [{ actorId: 'a', stage: '校验发布判断与正文', error: expect.objectContaining({ message: '朋友圈模型未返回有效正文' }) }],
    });
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

  it('saves appointments when randomUUID is unavailable in an insecure browser context', async () => {
    let byteSeed = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = byteSeed++;
      return bytes;
    });
    vi.stubGlobal('crypto', { randomUUID: undefined, getRandomValues });
    const other = { ...actor, id: 'b', name: '乙', layeredMemories: [memory({
      id: 'memory-b', ownerId: 'b', subjectIds: ['b'],
    })] } as AICharacter;
    chats[0].memberIds = ['a', 'b'];
    const sharedOps = { ...ops(), getCharacters: () => [actor, other],
      loadCharacter: vi.fn(async (id: string) => id === 'a' ? actor : other) };

    await expect(runDailyMomentFlow('room-a', sharedOps)).resolves.toMatchObject({ nextCheckAt: expect.any(Number) });
    const schedules = chats[0].runtimeEventsV2!.filter((event) => (event.payload as Record<string, unknown>).artifactType === 'daily_moment_schedule');
    expect(schedules).toHaveLength(2);
    expect(new Set(schedules.map((event) => event.id)).size).toBe(2);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
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
    const cause = Object.assign(new Error('text unavailable'), { diagnostic: { status: 429, code: 'rate_limit' } });
    vi.mocked(generateJsonWithAdapter).mockRejectedValueOnce(cause);
    const error = await runDailyMomentFlow('room-a', ops()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DailyMomentFlowError);
    expect(error).toMatchObject({
      message: '每日朋友圈生成失败（a / 请求发布判断与正文：HTTP 429）',
      errors: [cause],
      failures: [{ actorId: 'a', stage: '请求发布判断与正文', error: cause, provider: profiles[0].provider, model: 'test-model' }],
    });
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

  it.each([true, false])('lets the model decide at night for a daytime worker: publish=%s', async (publish) => {
    vi.setSystemTime(new Date(2026, 9, 14, 6));
    actor.background = '白天上班的普通职员';
    actor.layeredMemories = [memory()];
    vi.mocked(generateJsonWithAdapter).mockResolvedValue(JSON.stringify({ publish, text: publish ? '今天的小惊喜。' : '' }));
    await runDailyMomentFlow('room-a', ops());
    expect(generateJsonWithAdapter).toHaveBeenCalledOnce();
    expect(vi.mocked(generateJsonWithAdapter).mock.calls[0][0].messages[0].content).toContain('Current device-local time:');
    expect(projectWorldMoments(chats, [actor])).toHaveLength(publish ? 1 : 0);
  });
});
