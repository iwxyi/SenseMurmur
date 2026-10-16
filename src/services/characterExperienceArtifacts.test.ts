import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCharacterBirthLetterContext, buildCharacterDailyDiaryContext, buildCharacterExperienceArtifactContext, buildCharacterFinalLetterContext, buildLocalCharacterExperienceArtifact, decideCharacterDailyDiaryArtifact, generateCharacterDailyDiaryArtifact, generateCharacterExperienceArtifact, looksLikeRawArtifactContext } from './characterExperienceArtifacts';
import type { AICharacter } from '../types/character';
import { generateResponse } from './aiClient';

vi.mock('./aiClient', () => ({
  generateResponse: vi.fn(async () => '今天我把那件事记在了心里。'),
}));

const generateResponseMock = vi.mocked(generateResponse);

describe('automatic diary worthiness decision', () => {
  it('allows silence and does not fall back to a local diary', async () => {
    generateResponseMock.mockResolvedValueOnce('{"write":false,"text":""}');
    expect(await decideCharacterDailyDiaryArtifact({ config: {} as Parameters<typeof decideCharacterDailyDiaryArtifact>[0]['config'], character: buildCharacter(), dateKey: '2026-10-15' })).toBeNull();
  });
  it('rejects invalid decisions instead of storing a fabricated entry', async () => {
    generateResponseMock.mockResolvedValueOnce('{"write":true,"text":""}');
    await expect(decideCharacterDailyDiaryArtifact({ config: {} as Parameters<typeof decideCharacterDailyDiaryArtifact>[0]['config'], character: buildCharacter(), dateKey: '2026-10-15' })).rejects.toThrow('没有返回有效正文');
  });
});

function buildCharacter(): Partial<AICharacter> {
  return {
    id: 'c1',
    name: '苏苏',
    background: '时尚穿搭博主。',
    speakingStyle: '活泼亲切。',
    coreProfile: {
      coreDesire: '想让更多人相信自己也可以变好看。',
      coreFear: '害怕别人觉得她只是跟风。',
      socialMask: '总是把在意包装成轻松玩笑。',
      selfImage: '希望自己看起来可靠又有趣。',
      hiddenSoftSpots: ['别人认真保存她的建议'],
      unmetNeeds: ['被认真看见'],
      conflictStyle: '先开玩笑再试探对方态度',
    },
    soulState: {
      mood: { pleasure: 10, arousal: 30, dominance: 0 },
      energy: 42,
      attention: 60,
      loneliness: 62,
      repression: 61,
      shame: 48,
      envy: 10,
      trustInRoom: 50,
      ignoredStreak: 1,
      lastImpulseReason: '想问小雨是不是认真喜欢那套搭配，但又怕显得太在意。',
    },
    emotionalState: { affection: 62, irritation: 12, insecurity: 20, excitement: 70, embarrassment: 5 },
    relationships: [{
      characterId: 'c2',
      warmth: 34,
      competence: 6,
      trust: 22,
      threat: 4,
      note: '对小雨的审美越来越认可。',
      updatedAt: 200,
    }],
    layeredMemories: [{
      id: 'm1',
      scope: 'character_self',
      layer: 'long_term',
      kind: 'trait_evidence',
      ownerId: 'c1',
      text: '苏苏开始意识到自己不只是分享穿搭，也在影响粉丝的自信。',
      salience: 0.9,
      confidence: 0.88,
      recency: 0.8,
      reinforcementCount: 2,
      sourceEventIds: ['e1'],
      sourceTag: 'llm_memory_growth_signal',
      createdAt: 100,
      updatedAt: 100,
    }],
  };
}

const leakyActorId = '3c78729f-e52d-4dde-b27f-01a9-49960bb8b123';
const leakyTargetId = '8b3d7266-c0c7-4ceb-8dc2-4512-6f3f2321abcd';

function buildLeakyCharacter(): Partial<AICharacter> {
  return {
    id: leakyActorId,
    name: '喜羊羊',
    background: `${leakyActorId} 曾经因为 status_shift 变得更谨慎。`,
    speakingStyle: `会提到 ${leakyTargetId}，但不该暴露内部编号。`,
    coreProfile: {
      coreDesire: `想让 ${leakyTargetId} 重新相信自己`,
      coreFear: '害怕 trait_evidence 被误读成真正的自己',
    },
    soulState: {
      mood: { pleasure: 0, arousal: 20, dominance: 0 },
      energy: 50,
      attention: 40,
      loneliness: 60,
      repression: 58,
      shame: 20,
      envy: 10,
      trustInRoom: 30,
      ignoredStreak: 2,
      lastImpulseReason: `${leakyActorId} 想追问 ${leakyTargetId} 的态度`,
    },
    relationships: [{
      characterId: leakyTargetId,
      warmth: 8,
      competence: 2,
      trust: -10,
      threat: 36,
      note: `${leakyActorId} 对 ${leakyTargetId} 的信任在 relationship_delta 后变低。`,
      updatedAt: 120,
    }],
    layeredMemories: [{
      id: 'leaky-memory',
      scope: 'character_self',
      layer: 'long_term',
      kind: 'status_shift',
      ownerId: leakyActorId,
      text: `${leakyActorId} 在 status_shift 后开始回避 ${leakyTargetId}`,
      evidenceText: `source events: ${leakyActorId} challenge ${leakyTargetId}`,
      salience: 0.75,
      confidence: 0.8,
      recency: 0.7,
      reinforcementCount: 2,
      sourceEventIds: ['evt-raw'],
      sourceTag: 'unknown_internal_source',
      createdAt: 100,
      updatedAt: 100,
    }],
  };
}

describe('characterExperienceArtifacts', () => {
  beforeEach(() => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue('今天我把那件事记在了心里。');
  });

  it('builds a reusable context from existing memory and relationship state', () => {
    const context = buildCharacterExperienceArtifactContext(buildCharacter(), [{ id: 'c2', name: '小雨' } as AICharacter]);
    expect(context.profile.name).toBe('苏苏');
    expect(context.memories[0].lens).toBe('成长信号');
    expect(context.relationships[0].targetName).toBe('小雨');
    expect(context.emotions).toContain('好感 62');
  });

  it('creates local previews without calling a model', () => {
    const context = buildCharacterExperienceArtifactContext(buildCharacter(), [{ id: 'c2', name: '小雨' } as AICharacter]);
    expect(buildLocalCharacterExperienceArtifact('diary', context)).toContain('苏苏的日记');
    expect(buildLocalCharacterExperienceArtifact('final_letter', context)).toContain('最后一次被看见');
  });

  it('builds final letter context from existing memory, relationships, and future handoff', () => {
    const context = buildCharacterFinalLetterContext(buildCharacter(), [{ id: 'c2', name: '小雨' } as AICharacter]);
    expect(context.farewellAnchors.join(' / ')).toContain('最想被记住的一件事');
    expect(context.unresolvedTies.join(' / ')).toContain('小雨');
    expect(context.futureHandoff).toContain('后来');
    expect(buildLocalCharacterExperienceArtifact('final_letter', context)).toContain('我不想只说再见');
  });

  it('prioritizes shared anchors as final letter material', () => {
    const character = buildCharacter();
    character.layeredMemories = [
      ...(character.layeredMemories || []),
      {
        id: 'shared-anchor-promise',
        scope: 'relationship',
        layer: 'long_term',
        kind: 'bond',
        ownerId: 'c1',
        subjectIds: ['c1', 'user'],
        text: '第一次深夜聊到天亮后，苏苏和用户说好以后难过时先找对方说。',
        evidenceText: '用户说：以后难过时先找你说。',
        salience: 0.95,
        confidence: 0.92,
        recency: 0.9,
        reinforcementCount: 2,
        sourceEventIds: ['evt-shared-anchor-promise'],
        origin: 'distilled',
        createdAt: 300,
        updatedAt: 300,
      },
    ];
    const context = buildCharacterFinalLetterContext(character, [{ id: 'c2', name: '小雨' } as AICharacter]);

    expect(context.sharedAnchors[0]?.text).toContain('难过时先找对方说');
    expect(context.farewellAnchors.join('\n')).toContain('放不下的共同经历');
    expect(context.futureHandoff).toContain('还没完全走完的期待');
    expect(buildLocalCharacterExperienceArtifact('final_letter', context)).toContain('难过时先找对方说');
  });

  it('builds birth letter context and preview from identity anchors', () => {
    const context = buildCharacterBirthLetterContext(buildCharacter(), [{ id: 'c2', name: '小雨' } as AICharacter]);
    expect(context.creationSignals.length).toBeGreaterThan(0);
    expect(buildLocalCharacterExperienceArtifact('birth_letter', context)).toContain('第一次醒来');
  });

  it('generates artifacts through the text model adapter', async () => {
    generateResponseMock.mockResolvedValueOnce('今天我把那件事记在了心里。');
    const text = await generateCharacterExperienceArtifact({
      config: { provider: 'openai', apiKey: 'k', baseUrl: 'https://example.test', model: 'm' },
      kind: 'diary',
      character: buildCharacter(),
      relatedCharacters: [{ id: 'c2', name: '小雨' } as AICharacter],
      language: 'zh',
    });
    expect(text).toBe('今天我把那件事记在了心里。');
  });

  it('generates birth letters through the text model adapter', async () => {
    generateResponseMock.mockResolvedValueOnce('今天我把那件事记在了心里。');
    const text = await generateCharacterExperienceArtifact({
      config: { provider: 'openai', apiKey: 'k', baseUrl: 'https://example.test', model: 'm' },
      kind: 'birth_letter',
      character: buildCharacter(),
      relatedCharacters: [{ id: 'c2', name: '小雨' } as AICharacter],
      language: 'zh',
    });
    expect(text).toBe('今天我把那件事记在了心里。');
  });

  it('builds date-scoped diary context and generates diary without fixed token caps', async () => {
    const context = buildCharacterDailyDiaryContext(buildCharacter(), [{ id: 'c2', name: '小雨' } as AICharacter], '1970-01-01', ['气死我了，今天又被人误会。']);
    expect(context.dateKey).toBe('1970-01-01');
    expect(context.highlights.length).toBeGreaterThan(0);
    expect(context.narrativeAngle.length).toBeGreaterThan(0);
    expect(context.emotionalAnchors.length).toBeGreaterThan(0);
    expect(context.privateLenses.length).toBeGreaterThan(0);
    expect(context.formHint.length).toBeGreaterThan(0);
    expect(context.openingStyle.length).toBeGreaterThan(0);
    expect(context.recentDiaryOpenings[0]).toBe('短促情绪词开场');
    expect(context.recentDiaryContentPatterns).toContain('情绪先行');
    expect(context.recentDiaryContinuity).toContain('短促情绪词开场');
    expect(context.recentDiaryContinuity).toContain('近期内容常见的重心');
    expect(context.recentDiaryContinuity).toContain('不是禁用词');
    expect(context.secondReactionSeeds.length).toBeGreaterThan(0);
    expect(context.selfDoubtSeeds.length).toBeGreaterThan(0);
    expect(Array.isArray(context.flashbackSeeds)).toBe(true);
    expect(Array.isArray(context.companionshipSeeds)).toBe(true);
    expect(context.imperfectFormHints.length).toBeGreaterThan(0);
    expect(context.metaphorSeeds.length).toBeGreaterThan(0);
    expect(context.metaphorSeeds.join(' / ')).not.toContain('今日心情：');
    expect(JSON.stringify(context)).not.toContain('气死我了');

    generateResponseMock.mockResolvedValueOnce('今天我把那件事记在了心里。');
    const text = await generateCharacterDailyDiaryArtifact({
      config: { provider: 'openai', apiKey: 'k', baseUrl: 'https://example.test', model: 'm' },
      character: buildCharacter(),
      relatedCharacters: [{ id: 'c2', name: '小雨' } as AICharacter],
      dateKey: '1970-01-01',
      recentDiaryTexts: ['气死我了，今天又被人误会。'],
      language: 'zh',
    });
    expect(text).toBe('今天我把那件事记在了心里。');
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    const serializedContext = String((generateResponseMock.mock.calls[0]?.[2] as Array<{ content: string }> | undefined)?.[0]?.content || '');
    expect(prompt).toContain('日记是角色卸下面具后只面对自己的私密记录');
    expect(prompt).toContain('openingStyle、narrativeAngle、formHint 只是入口建议');
    expect(prompt).toContain('secondReactionSeeds、selfDoubtSeeds、flashbackSeeds、companionshipSeeds、imperfectFormHints、metaphorSeeds 是可选私密材料');
    expect(prompt).toContain('companionshipSeeds 只能写成角色自己的私下感受');
    expect(prompt).toContain('recentDiaryOpenings、recentDiaryContentPatterns 和 recentDiaryContinuity 只用来感知近期节奏');
    expect(prompt).toContain('长期事件、长期情绪或同一段关系可以反复出现');
    expect(serializedContext).not.toContain('openingAvoidance');
    expect(serializedContext).toContain('recentDiaryContinuity');
    expect(serializedContext).toContain('recentDiaryContentPatterns');
    expect(serializedContext).toContain('secondReactionSeeds');
    expect(serializedContext).toContain('selfDoubtSeeds');
    expect(serializedContext).toContain('flashbackSeeds');
    expect(serializedContext).toContain('companionshipSeeds');
    expect(serializedContext).toContain('imperfectFormHints');
    expect(serializedContext).toContain('metaphorSeeds');
    expect(serializedContext).toContain('短促情绪词开场');
    expect(serializedContext).toContain('情绪先行');
    expect(serializedContext).not.toContain('气死我了');
    expect(serializedContext).not.toContain('今天又被人误会');
  });

  it('adds companionship seeds to daily diary context without leaking runtime fields', () => {
    const character = buildCharacter();
    const context = buildCharacterDailyDiaryContext({
      ...character,
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说过最近面试压力很大。'],
      },
      layeredMemories: [
        ...(character.layeredMemories || []),
        {
          id: 'anchor-user',
          scope: 'relationship',
          layer: 'long_term',
          kind: 'bond',
          ownerId: 'c1',
          subjectIds: ['c1', 'user'],
          text: '第一次深夜聊天后，苏苏记住了用户没有退出对话。',
          evidenceText: '用户那晚陪苏苏聊到很晚。',
          salience: 0.9,
          confidence: 0.9,
          recency: 0.7,
          reinforcementCount: 2,
          sourceEventIds: ['evt-user-anchor'],
          origin: 'distilled',
          createdAt: 100,
          updatedAt: 200,
        },
      ],
      relationships: [
        ...(character.relationships || []),
        {
          characterId: 'c2',
          warmth: 72,
          competence: 18,
          trust: 66,
          threat: 2,
          note: '共同秘密是只有她们知道的暗号；约定下次把话说完。',
          updatedAt: 200,
        },
      ],
    }, [{ id: 'c2', name: '小雨' } as AICharacter], '1970-01-01');
    const serialized = JSON.stringify(context);

    expect(context.companionshipSeeds.join('\n')).toContain('第一次深夜聊天');
    expect(context.companionshipSeeds.join('\n')).toContain('用户');
    expect(context.companionshipSeeds.join('\n')).toContain('小雨');
    expect(context.companionshipSeeds.join('\n')).toContain('共同秘密');
    expect(serialized).not.toContain('companionshipContext');
    expect(serialized).not.toContain('phase');
    expect(serialized).not.toContain('score');
    expect(serialized).not.toContain('c1');
    expect(serialized).not.toContain('c2');
  });

  it('summarizes recurring diary topics without feeding previous diary prose back to the model', () => {
    const context = buildCharacterDailyDiaryContext(
      buildCharacter(),
      [{ id: 'c2', name: '小雨' } as AICharacter],
      '1970-01-02',
      [
        '烦死了。今天又因为小雨那句话没睡好，我差点把消息发出去又删了。',
        '气死我了！小雨明明只是随口一说，我却一直想着明天要不要装作不在意。',
        '还是放心不下。说好下次一起去看展，我想问问她后来怎么样，又怕像是在催。',
      ],
    );
    const serialized = JSON.stringify(context);

    expect(context.recentDiaryOpenings).toContain('短促情绪词开场');
    expect(context.recentDiaryContentPatterns).toEqual(expect.arrayContaining(['情绪先行', '关系反复', '未说出口', '行动念头', '关心/约定回流']));
    expect(context.recentDiaryContinuity).toContain('长期事件、长期情绪或同一个人可以反复出现');
    expect(context.recentDiaryContinuity).toContain('新的时间切片');
    expect(context.flashbackSeeds.length).toBeGreaterThan(0);
    expect(serialized).not.toContain('没睡好');
    expect(serialized).not.toContain('随口一说');
  });

  it('varies diary opening guidance across dates for the same character', () => {
    const dates = ['1970-01-01', '1970-01-02', '1970-01-03', '1970-01-04', '1970-01-05', '1970-01-06'];
    const contexts = dates.map((date) => buildCharacterDailyDiaryContext(
      buildCharacter(),
      [{ id: 'c2', name: '小雨' } as AICharacter],
      date,
      ['烦死了。今天又是这样。'],
    ));
    expect(new Set(contexts.map((context) => context.openingStyle)).size).toBeGreaterThan(1);
    expect(new Set(contexts.map((context) => context.formHint)).size).toBeGreaterThan(1);
    expect(contexts.every((context) => context.recentDiaryOpenings.includes('短促情绪词开场'))).toBe(true);
  });

  it('retries when the model echoes raw diary context', async () => {
    const rawContext = JSON.stringify(buildCharacterDailyDiaryContext(buildCharacter(), [{ id: 'c2', name: '小雨' } as AICharacter], '1970-01-01'));
    generateResponseMock
      .mockResolvedValueOnce(rawContext)
      .mockResolvedValueOnce('今天我没有把那句话说出口。');

    const text = await generateCharacterDailyDiaryArtifact({
      config: { provider: 'openai', apiKey: 'k', baseUrl: 'https://example.test', model: 'm' },
      character: buildCharacter(),
      relatedCharacters: [{ id: 'c2', name: '小雨' } as AICharacter],
      dateKey: '1970-01-01',
      language: 'zh',
    });

    expect(text).toBe('今天我没有把那句话说出口。');
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to local diary text instead of saving raw context', async () => {
    const rawContext = JSON.stringify(buildCharacterDailyDiaryContext(buildCharacter(), [{ id: 'c2', name: '小雨' } as AICharacter], '1970-01-01'));
    generateResponseMock
      .mockResolvedValueOnce(rawContext)
      .mockResolvedValueOnce(rawContext);

    const text = await generateCharacterDailyDiaryArtifact({
      config: { provider: 'openai', apiKey: 'k', baseUrl: 'https://example.test', model: 'm' },
      character: buildCharacter(),
      relatedCharacters: [{ id: 'c2', name: '小雨' } as AICharacter],
      dateKey: '1970-01-01',
      language: 'zh',
    });

    expect(text).toContain('苏苏的日记');
    expect(looksLikeRawArtifactContext(text)).toBe(false);
  });

  it('sanitizes artifact context before it is sent to narrative generators', () => {
    const context = buildCharacterExperienceArtifactContext(buildLeakyCharacter(), [{ id: leakyTargetId, name: '灰太狼' } as AICharacter]);
    const serialized = JSON.stringify(context);

    expect(context.memories[0].lens).toBe('状态变化');
    expect(context.memories[0].text).toContain('喜羊羊');
    expect(context.memories[0].text).toContain('灰太狼');
    expect(context.relationships[0].targetName).toBe('灰太狼');
    expect(context.relationships[0].note).toContain('喜羊羊');
    expect(context.relationships[0].note).toContain('灰太狼');
    expect(context.innerResidues.join(' / ')).toContain('喜羊羊');
    expect(context.identityAnchors.join(' / ')).toContain('灰太狼');

    expect(serialized).not.toContain(leakyActorId);
    expect(serialized).not.toContain(leakyTargetId);
    expect(serialized).not.toContain('status_shift');
    expect(serialized).not.toContain('trait_evidence');
    expect(serialized).not.toContain('relationship_delta');
    expect(serialized).not.toContain('source events');
    expect(serialized).not.toContain('unknown_internal_source');
  });

  it('sanitizes daily diary context and local previews without raw ids or enum labels', () => {
    const context = buildCharacterDailyDiaryContext(
      buildLeakyCharacter(),
      [{ id: leakyTargetId, name: '灰太狼' } as AICharacter],
      '1970-01-01',
      [`${leakyActorId} 今天又因为 episodic / status_shift 想起 ${leakyTargetId}。`],
    );
    const preview = buildLocalCharacterExperienceArtifact('diary', context);
    const serialized = JSON.stringify(context);

    expect(context.memories[0].lens).toBe('状态变化');
    expect(context.recentDiaryOpenings[0]).toBeTruthy();
    expect(context.recentDiaryContinuity).toContain(context.recentDiaryOpenings[0]);
    expect(context.recentDiaryContentPatterns.length).toBeGreaterThan(0);
    expect(preview).toContain('喜羊羊');
    expect(preview).toContain('灰太狼');

    expect(serialized + preview).not.toContain(leakyActorId);
    expect(serialized + preview).not.toContain(leakyTargetId);
    expect(serialized + preview).not.toContain('status_shift');
    expect(serialized + preview).not.toContain('episodic');
  });
});
