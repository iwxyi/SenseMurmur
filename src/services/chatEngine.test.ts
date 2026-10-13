import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import { DEFAULT_CONVERSATION_DIRECTOR_CONTROLS, DEFAULT_CONVERSATION_DRAMA_RULES, DEFAULT_CONVERSATION_GOVERNANCE, DEFAULT_CONVERSATION_WORLD_STATE } from '../types/chat';
import type { Message } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import type { AIModelProfile } from '../types/settings';
import { __chatEngineTestUtils, generateSpeakerMessage, runOneRound } from './chatEngine';
import { evaluateDuplicateGuard } from './duplicateGuard';
import { applyPresenceUpdateToTransition } from './characterPresence';
import { buildInlineInteractionContract, parseInlineInteractionEnvelope } from './inlineInteractionHint';
import type { DirectorIntent } from './directorIntent';
import { useSettingsStore } from '../stores/useSettingsStore';

const generateResponseMock = vi.hoisted(() => vi.fn());

vi.mock('./aiClient', () => ({
  generateResponse: (...args: unknown[]) => generateResponseMock(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T14:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
  useSettingsStore.setState({ developerMode: false });
  delete (globalThis as { __AICHATGROUP_DEBUG_SCHEDULER__?: boolean }).__AICHATGROUP_DEBUG_SCHEDULER__;
});

const speaker = { name: '喜羊羊' } as AICharacter;

function buildCharacter(id: string, name: string, patch: Partial<AICharacter> = {}): AICharacter {
  return {
    id,
    name,
    avatar: '',
    personality: { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
    behavior: { proactivity: 50, aggressiveness: 50, humorIntensity: 50, empathyLevel: 50, summarizing: 50, offTopic: 50 },
    expertise: [],
    speakingStyle: '',
    background: '',
    relationships: [],
    memory: { longTerm: [], shortTermSummary: '', secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
    intervention: { allowSpeakAs: true, allowDirectorPrompt: true, allowPrivateThread: true },
    isPreset: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function buildChat(patch: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free' },
    name: '羊村大家庭闲聊',
    topic: '最近有什么好玩的事？',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['mei', 'hui'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    showRoleActions: true,
    topicSeed: '',
    sourceChatId: null,
    sourceMemberIds: [],
    runtimeTimeline: [],
    runtimeEventsV2: [],
    relationshipLedger: [],
    governance: DEFAULT_CONVERSATION_GOVERNANCE,
    dramaRules: DEFAULT_CONVERSATION_DRAMA_RULES,
    worldState: DEFAULT_CONVERSATION_WORLD_STATE,
    directorControls: DEFAULT_CONVERSATION_DIRECTOR_CONTROLS,
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
    ...patch,
  };
}

function buildProfiles(): AIModelProfile[] {
  return [
    {
      id: 'text-default',
      name: '默认文本',
      type: 'text',
      provider: 'openai',
      apiKey: 'text-key',
      baseUrl: 'https://example.test',
      model: 'text-model',
      isDefault: true,
    },
    {
      id: 'image-default',
      name: '默认图片',
      type: 'image',
      provider: 'openai',
      apiKey: 'image-key',
      baseUrl: 'https://example.test',
      model: 'image-model',
      isDefault: true,
    },
    {
      id: 'tts-default',
      name: '默认语音',
      type: 'tts',
      provider: 'official',
      apiKey: '',
      baseUrl: '/api',
      model: 'speech-tts',
      isDefault: true,
    },
  ];
}

function longStorySection(opening: string) {
  return `${opening}雨声贴着檐角往下落，旧宅门前的青苔被踩出一道深色的痕。阿梅没有立刻往前，她先把灯笼举高，让光从门缝里探进去；那点光没有照见人，只照见地上拖过的水印，像有人刚从后院井边回来。风从廊下穿过，带出一股潮湿的药味，和她袖口残留的艾草味搅在一起。她想起方才窗纸上那道影子退开时的停顿，忽然明白对方不是逃走，而是在等她做出判断。门内又响了一声，很轻，像指甲碰到木盒边缘。她的手指压住门环，没有推开，只让铁环在掌心里冷下去。这个停顿让院子里的每一处声音都变得清楚：远处巡夜人的梆子、墙根积水里落下的瓦灰、还有屋里某个人刻意压低的呼吸。等到那呼吸终于乱了一拍，阿梅才知道自己已经逼近了答案。她往后退了半步，故意让鞋底擦过碎瓦，给门里的人一个可以误判的声音。屋内果然有布料掠过桌角的窸窣，随后是一件硬物被仓促放回盒中的轻响。她没有急着拆穿，只把灯笼移向门轴，照见那里新蹭掉的一点漆皮；漆皮下面的木色很浅，说明这扇门刚被人从里面用力抵过。她伸手摸了摸门框，指腹沾到一点细粉，凉而干，不像墙灰，更像药柜里磨碎后没来得及收净的石灰。院外的梆子敲到第三下时，她终于把这些零散的线索拼在一起：屋里那个人不是被困住的受害者，而是在销毁某件能指向后院井口的东西。她抬眼看向门缝，声音压得很低，却足够让里面的人听见。门里没有立刻回应，只有木盒扣锁被慢慢压住的闷声。阿梅知道自己已经没有回头路，于是把灯笼挂到门侧铁钩上，空出右手去摸袖中的短刀。刀柄上的缠线被雨气浸得发冷，她握住它时，才发现自己的掌心也全是冷汗。她没有马上拔刀，只把呼吸放慢，等屋里的人先露出下一次破绽。`;
}

function buildAiMessage(senderId: string, senderName: string, content: string, timestamp = 1): Message {
  return {
    id: `msg-${senderId}-${timestamp}`,
    chatId: 'chat-1',
    type: 'ai',
    senderId,
    senderName,
    content,
    emotion: 0,
    timestamp,
    isDeleted: false,
  };
}

function buildUserMessage(content: string, timestamp = 1): Message {
  return {
    id: `user-${timestamp}`,
    chatId: 'chat-1',
    type: 'user',
    senderId: 'user',
    senderName: '用户',
    content,
    emotion: 0,
    timestamp,
    isDeleted: false,
  };
}

function buildMediaDirectorIntent(): DirectorIntent {
  return {
    source: 'user_message',
    beatType: 'answer',
    targetActorIds: ['mei'],
    pressure: 0.98,
    reason: '用户指定角色发送或创作图片。',
    userGuidance: {
      kind: 'media_request',
      rawText: '美羊羊发个灰太狼证件照的图片',
      actorIds: ['mei'],
      mentionedActorIds: ['mei', 'hui'],
      focusText: '美羊羊发个灰太狼证件照的图片',
      beatType: 'answer',
      pressure: 0.98,
      maxTurns: 1,
      reason: '用户指定角色发送或创作图片。',
      mediaRequest: {
        kind: 'image',
        subjectActorIds: ['hui'],
        subjectText: '灰太狼',
        actionText: '发个灰太狼证件照的图片',
      },
    },
  };
}

function buildGuidanceIntervention(
  guidance: NonNullable<DirectorIntent['userGuidance']>,
  createdAt: number,
): RuntimeEventV2 {
  return {
    id: `guidance-${createdAt}`,
    conversationId: 'chat-1',
    kind: 'director_intervention',
    createdAt,
    actorIds: ['user'],
    targetIds: guidance.actorIds,
    summary: guidance.reason,
    visibility: 'moderator_only',
    payload: {
      intent: guidance.beatType === 'invite' ? 'inject_event' : guidance.beatType === 'challenge' ? 'escalate' : 'force_reply',
      targetActorIds: guidance.actorIds,
      pressure: guidance.pressure,
      text: guidance.rawText,
      maxTurns: guidance.maxTurns,
      expiresAt: createdAt + 10 * 60_000,
      userGuidance: guidance as unknown as Record<string, unknown>,
    },
  };
}

describe('chatEngine streaming preview', () => {
  const knownContinuity = { items: [{ key: 'report', kind: 'commitment' as const, status: 'established' as const,
    summary: '美羊羊交回记录', participantIds: ['mei'], evidenceText: '我回来交记录',
    sourceMessageIds: ['seed'], updatedAt: 1 }] };

  it.each([null, { items: [{ key: 'report', kind: 'commitment', status: 'resolved',
    summary: '记录已交回', participantIds: ['mei'], evidenceText: '记录交回来了' }] }])(
    'requires an explicit judgement for known group items and retries the same speaker: %j', async (conversationUpdate) => {
      generateResponseMock.mockReset();
      generateResponseMock.mockResolvedValueOnce(JSON.stringify({ messages: [{ content: '记录交回来了。' }] }))
        .mockResolvedValueOnce(JSON.stringify({ messages: [{ content: '记录交回来了。' }], conversationUpdate }));
      const onChunk = vi.fn();
      const message = await generateSpeakerMessage({
        chat: buildChat({ worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE, conversationContinuity: knownContinuity } }),
        speaker: buildCharacter('mei', '美羊羊'), characters: [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')],
        messages: [], apiConfig: buildProfiles(), onChunk,
      });
      expect(generateResponseMock).toHaveBeenCalledTimes(2);
      expect(generateResponseMock.mock.calls[1]?.[2]).toEqual(generateResponseMock.mock.calls[0]?.[2]);
      expect(generateResponseMock.mock.calls[1]?.[1]).toContain('explicitly include top-level conversationUpdate');
      expect(onChunk).toHaveBeenCalledWith('');
      expect(message.content).toBe('记录交回来了。');
      if (conversationUpdate) expect(message.metadata?.conversationUpdate?.items[0]).toMatchObject({ key: 'report', status: 'resolved' });
      else expect(message.metadata?.conversationUpdate).toBeUndefined();
    });

  it('does not submit a turn that repeatedly skips the known-item judgement', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({ content: '记录交回来了。' }));
    const callbacks = { onSpeakerSelected: vi.fn(), onMessageChunk: vi.fn(), onMessageComplete: vi.fn(), onError: vi.fn() };
    await runOneRound(buildChat({ worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE, conversationContinuity: knownContinuity } }),
      [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')], [], buildProfiles(), callbacks);
    expect(generateResponseMock).toHaveBeenCalledTimes(3);
    expect(callbacks.onSpeakerSelected).toHaveBeenCalledTimes(1);
    expect(callbacks.onMessageComplete).not.toHaveBeenCalled();
    expect(callbacks.onError.mock.calls[0]?.[0]).toMatchObject({ reason: 'output_protocol_invalid' });
  });

  it.each(['direct', 'ai_direct'] as const)('keeps %s compatible when continuity state is present', async (type) => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({ content: '记录交回来了。' }));
    const message = await generateSpeakerMessage({
      chat: buildChat({ type, worldState: { ...DEFAULT_CONVERSATION_WORLD_STATE, conversationContinuity: knownContinuity } }),
      speaker: buildCharacter('mei', '美羊羊'), characters: [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')],
      messages: [], apiConfig: buildProfiles(),
    });
    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(message.content).toBe('记录交回来了。');
  });

  it('withholds reserved tool protocol prefixes, including decoded JSON escapes', () => {
    for (const opener of ['<||DSML||', '<\uFF5C\uFF5CDSML\uFF5C\uFF5C', '</||DSML||']) {
      for (let length = 1; length <= opener.length; length += 1) {
        const partial = opener.slice(0, length);
        expect(__chatEngineTestUtils.buildStreamingDisplayContent(partial, speaker)).toBeNull();
        expect(__chatEngineTestUtils.buildStreamingDisplayContent(JSON.stringify({ content: partial }), speaker)).toBeNull();
      }
    }
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{"content":"\\u003c\\u007c\\u007cDSML|| calls>"}', speaker)).toBeNull();
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{"content":"\\u003', speaker)).toBeNull();
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('讨论 DSML 和 get_bot_profile', speaker)).toBe('讨论 DSML 和 get_bot_profile');
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('<普通文字>', speaker)).toBe('<普通文字>');
  });

  it.each([
    '<||DSML|| invoke name="get_bot_profile">',
    '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="get_bot_profile">',
    JSON.stringify({ content: '<||DSML|| calls>' }),
    JSON.stringify({ messages: [{ content: '先去看看。' }, { content: '<||DSML|| calls>' }] }),
    JSON.stringify({ content: '先去看看。', extraMessages: ['<||DSML|| calls>'] }),
    '{"content":"\\u003c\\u007c\\u007cDSML|| calls>"}',
  ])('rejects an entire invalid generation and retries the same speaker: %s', async (invalid) => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValueOnce(invalid).mockResolvedValueOnce(JSON.stringify({ content: '门口那辆车怎么又来了？' }));
    const mei = buildCharacter('mei', '美羊羊');
    const onChunk = vi.fn();
    const message = await generateSpeakerMessage({
      chat: buildChat(), speaker: mei, characters: [mei, buildCharacter('hui', '灰太狼')],
      messages: [], apiConfig: buildProfiles(), onChunk,
    });
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(message.content).toBe('门口那辆车怎么又来了？');
    expect(onChunk).toHaveBeenCalledWith('');
    expect(String(generateResponseMock.mock.calls[1]?.[1])).toContain('Output protocol retry');
  });

  it('reports persistent protocol failure without completing a message or rotating speakers', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue('<||DSML|| calls>');
    const callbacks = {
      onSpeakerSelected: vi.fn(), onMessageChunk: vi.fn(), onMessageComplete: vi.fn(), onError: vi.fn(),
    };
    await runOneRound(buildChat(), [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')],
      [buildUserMessage('你们继续聊。')], buildProfiles(), callbacks);
    expect(generateResponseMock).toHaveBeenCalledTimes(3);
    expect(callbacks.onSpeakerSelected).toHaveBeenCalledTimes(1);
    expect(callbacks.onMessageComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError.mock.calls[0]?.[0]).toMatchObject({ reason: 'output_protocol_invalid' });
  });

  it.each([
    '二哥，我先去城头看看。', '{"messages":', '{"unrecognized":"台词"}',
    '{"messages":[{"content":"明早点卯，我接。"},{"content":"二哥，粮册你自己看。"}],"interactionHints":{"secondary":[{"targetId":"hui"}}]},"conversationUpdate":{"items":[]}}',
    '{"content":"明早点卯，我接。","conversationUpdate":',
  ])('retries incomplete ordinary group output without committing it: %s', async (invalid) => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValueOnce(invalid).mockResolvedValueOnce(JSON.stringify({
      messages: [{ content: '二哥，刀先借俺使使。' }, { content: '大哥那边俺自己去说。' }],
      conversationUpdate: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const onChunk = vi.fn();
    const profiles = buildProfiles().map((profile) => profile.type === 'text' ? { ...profile, provider: 'deepseek' as const } : profile);
    const message = await generateSpeakerMessage({
      chat: buildChat(), speaker: mei, characters: [mei, buildCharacter('hui', '灰太狼')],
      messages: [], apiConfig: profiles, onChunk,
    });
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(message.content).toBe('二哥，刀先借俺使使。');
    expect(message.metadata?.conversationUpdate).toBeUndefined();
    expect(onChunk).toHaveBeenCalledWith('');
    expect(String(generateResponseMock.mock.calls[1]?.[1])).toContain('no valid JSON envelope');
    expect(generateResponseMock.mock.calls[1]?.[2]).toEqual(generateResponseMock.mock.calls[0]?.[2]);
  });

  it('retries wrong state evidence and keeps the valid result on the same speaker', async () => {
    generateResponseMock.mockReset();
    const update = (evidenceText: string) => ({ items: [{ key: 'report', kind: 'commitment', status: 'resolved',
      summary: '收到记录', participantIds: ['mei'], evidenceText }] });
    generateResponseMock.mockResolvedValueOnce(JSON.stringify({ content: '记录看过了。', conversationUpdate: update('记录给你') }))
      .mockResolvedValueOnce(JSON.stringify({ content: '记录看过了。', conversationUpdate: update('记录看过了') }));
    const mei = buildCharacter('mei', '美羊羊');
    const onChunk = vi.fn();
    const message = await generateSpeakerMessage({ chat: buildChat(), speaker: mei,
      characters: [mei, buildCharacter('hui', '灰太狼')], messages: [], apiConfig: buildProfiles(), onChunk });
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(message.metadata?.conversationUpdate?.items[0]).toMatchObject({ key: 'report', status: 'resolved', evidenceText: '记录看过了' });
    expect(onChunk).toHaveBeenCalledWith('');
    expect(String(generateResponseMock.mock.calls[1]?.[1])).toContain('never from the earlier transcript');
    expect(generateResponseMock.mock.calls[1]?.[2]).toEqual(generateResponseMock.mock.calls[0]?.[2]);
  });

  it('fails repeated wrong evidence without submitting or rotating speakers', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({ content: '看过了。', conversationUpdate: {
      items: [{ key: 'report', kind: 'commitment', status: 'resolved', summary: '收到记录', participantIds: ['mei'], evidenceText: '记录给你' }],
    } }));
    const callbacks = { onSpeakerSelected: vi.fn(), onMessageChunk: vi.fn(), onMessageComplete: vi.fn(), onError: vi.fn() };
    await runOneRound(buildChat(), [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')],
      [buildUserMessage('你们继续聊。')], buildProfiles(), callbacks);
    expect(generateResponseMock).toHaveBeenCalledTimes(3);
    expect(callbacks.onSpeakerSelected).toHaveBeenCalledTimes(1);
    expect(callbacks.onMessageComplete).not.toHaveBeenCalled();
    expect(callbacks.onError.mock.calls[0]?.[0]).toMatchObject({ reason: 'output_protocol_invalid' });
  });

  it('reports repeated plain text as protocol failure without sending or rotating speakers', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue('俺真走了，你们别送。');
    const callbacks = { onSpeakerSelected: vi.fn(), onMessageChunk: vi.fn(), onMessageComplete: vi.fn(), onError: vi.fn() };
    await runOneRound(buildChat(), [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')],
      [buildUserMessage('你们继续聊。')], buildProfiles(), callbacks);
    expect(generateResponseMock).toHaveBeenCalledTimes(3);
    expect(callbacks.onSpeakerSelected).toHaveBeenCalledTimes(1);
    expect(callbacks.onMessageComplete).not.toHaveBeenCalled();
    expect(callbacks.onError.mock.calls[0]?.[0]).toMatchObject({ reason: 'output_protocol_invalid' });
  });

  it('does not commit a plain streamed draft when the final group response is blank', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockImplementationOnce(async (_api, _prompt, _messages, onRawChunk?: (chunk: string) => void) => {
      onRawChunk?.('俺这就走。');
      return '';
    }).mockResolvedValueOnce(JSON.stringify({ content: '门口那辆车还没走？' }));
    const mei = buildCharacter('mei', '美羊羊');
    const profiles = buildProfiles().map((profile) => profile.type === 'text' ? { ...profile, provider: 'deepseek' as const } : profile);
    const message = await generateSpeakerMessage({ chat: buildChat(), speaker: mei,
      characters: [mei, buildCharacter('hui', '灰太狼')], messages: [], apiConfig: profiles, onChunk: vi.fn() });
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(message.content).toBe('门口那辆车还没走？');
  });

  it('discards the streamed draft when invalid protocol is followed by a blank final response', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockImplementationOnce(async (_api, _prompt, _messages, onRawChunk?: (chunk: string) => void) => {
      onRawChunk?.('先去看看。');
      onRawChunk?.('先去看看。<||DSML|| calls>');
      return '';
    }).mockResolvedValueOnce(JSON.stringify({ content: '你听见外头的动静了吗？' }));
    const mei = buildCharacter('mei', '美羊羊');
    const onChunk = vi.fn();
    const profiles = buildProfiles().map((profile) => profile.type === 'text' ? { ...profile, provider: 'deepseek' as const } : profile);
    const message = await generateSpeakerMessage({
      chat: buildChat(), speaker: mei, characters: [mei, buildCharacter('hui', '灰太狼')],
      messages: [], apiConfig: profiles, onChunk,
    });
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(message.content).toBe('你听见外头的动静了吗？');
    expect(onChunk).toHaveBeenCalledWith('');
    expect(onChunk.mock.calls.some(([content]) => String(content).includes('DSML'))).toBe(false);
  });

  it.each(['provider unavailable', 'AbortError'])('propagates %s without protocol retries', async (reason) => {
    generateResponseMock.mockReset();
    const error = reason === 'AbortError' ? new DOMException('Cancelled', 'AbortError') : new Error(reason);
    generateResponseMock.mockRejectedValue(error);
    const mei = buildCharacter('mei', '美羊羊');
    await expect(generateSpeakerMessage({
      chat: buildChat(), speaker: mei, characters: [mei, buildCharacter('hui', '灰太狼')],
      messages: [], apiConfig: buildProfiles(),
    })).rejects.toBe(error);
    expect(generateResponseMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses incomplete JSON envelope chunks before content is available', () => {
    expect(__chatEngineTestUtils.isPendingJsonEnvelopeChunk('{')).toBe(true);
    expect(__chatEngineTestUtils.isPendingJsonEnvelopeChunk('  {"content"')).toBe(true);
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{', speaker)).toBeNull();
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('```json\n{', speaker)).toBeNull();
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{"content":"', speaker)).toBe('');
  });

  it('extracts visible content from partial JSON once content starts streaming', () => {
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{"content":"喜羊羊：先别急', speaker)).toBe('先别急');
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{"content":"那也不至于', speaker)).toBe('那也不至于');
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('直接纯文本', speaker)).toBe('直接纯文本');
  });

  it('previews only the first send from a list-only streaming envelope', () => {
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{"messages":[', speaker)).toBeNull();
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{"messages":[{"content":"先别急', speaker)).toBe('先别急');
    expect(__chatEngineTestUtils.buildStreamingDisplayContent('{"messages":[{"content":"先别急"},{"content":"还没说完"}]}', speaker)).toBe('先别急');
  });

  it('keeps a natural multi-clause reply intact when finalizing the committed message', () => {
    const content = '谁站你这边了？我只是看喜羊羊不顺眼。';
    expect(__chatEngineTestUtils.finalizeResponse(content, speaker)).toBe(content);
  });

  it('builds world event context prompt from attention, calendar, and moments', () => {
    const now = Date.now();
    const chat = buildChat({
      memberIds: ['mei', 'hui', 'user'],
      runtimeEventsV2: [
        {
          id: 'evt-attn',
          conversationId: 'chat-1',
          kind: 'attention_candidate',
          actorIds: ['mei'],
          targetIds: ['user'],
          summary: '用户状态低落，想关心',
          visibility: 'derived_public',
          createdAt: now - 5 * 60_000,
          payload: { targetIds: ['user'], confidence: 0.9, reason: '用户状态低落，想关心' },
        } as never,
        {
          id: 'evt-cal',
          conversationId: 'chat-1',
          kind: 'event_candidate',
          actorIds: ['mei'],
          targetIds: ['mei', 'user'],
          summary: '准备一起吃饭',
          visibility: 'derived_public',
          createdAt: now - 3 * 60_000,
          payload: {
            eventKind: 'social_outing',
            title: '晚餐',
            activityType: '聚餐',
            participantIds: ['mei', 'user'],
            startAt: now + 60 * 60_000,
            timeHint: '今晚 19:00',
            locationHint: '徐汇',
          },
        } as never,
        {
          id: 'evt-moment',
          conversationId: 'chat-1',
          kind: 'artifact',
          actorIds: ['hui'],
          targetIds: ['mei'],
          summary: '灰太狼发了动态',
          visibility: 'derived_public',
          createdAt: now - 20 * 60_000,
          payload: { eventKind: 'post_moment', artifactType: 'moment_text', title: '今天不错', text: '工作收工了' },
        } as never,
      ],
    });
    const prompt = __chatEngineTestUtils.buildWorldEventContextPrompt({
      chat,
      speaker: buildCharacter('mei', '美羊羊'),
      members: [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')],
      now,
    });
    expect(prompt).toContain('World event context:');
    expect(prompt).toContain('Attention context:');
    expect(prompt).toContain('Upcoming schedule:');
    expect(prompt).toContain('Recent social signal:');
    expect(prompt).not.toContain('score');
    expect(prompt).not.toContain('restraint');
    expect(prompt).not.toContain('suggested actions');
  });

  it('reads current and untimed activities without treating them as imminent reminders', () => {
    const now = Date.now();
    const chat = buildChat({ runtimeEventsV2: [
      { id: 'current', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now - 60_000,
        actorIds: ['mei'], visibility: 'public', summary: '修器械',
        payload: { calendarItemId: 'current-item', title: '修器械', kind: 'activity', status: 'in_progress',
          participantIds: ['mei'], startAt: now - 60_000, endAt: now + 60_000, locationHint: '营里' } },
      { id: 'untimed', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now - 60_000,
        actorIds: ['mei'], visibility: 'public', summary: '等探路信',
        payload: { calendarItemId: 'untimed-item', title: '等探路信', kind: 'activity', status: 'planned',
          participantIds: ['mei'], timeHint: '三日之后' } },
      { id: 'completed', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now - 60_000,
        actorIds: ['mei'], visibility: 'public', summary: '旧活动',
        payload: { calendarItemId: 'done-item', title: '旧活动', kind: 'activity', status: 'completed', participantIds: ['mei'] } },
    ] });
    const input = { chat, speaker: buildCharacter('mei', '美羊羊'), members: [buildCharacter('mei', '美羊羊')], now };
    const prompt = __chatEngineTestUtils.buildWorldEventContextPrompt(input);
    expect(prompt).toContain('Current activity: 修器械 at 营里');
    expect(prompt).toContain('Schedule with unconfirmed time: 等探路信 @ 三日之后');
    expect(prompt).not.toContain('旧活动');
    expect(__chatEngineTestUtils.buildWorldEventInfluenceRulesPrompt(input)).not.toContain('within 6 hours');
  });

  it('keeps an elapsed activity in generation context until completion is recorded', () => {
    const now = Date.now();
    const chat = buildChat({ runtimeEventsV2: [
      { id: 'patrol-start', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now - 120_000,
        actorIds: ['mei'], visibility: 'public', summary: '巡城',
        payload: { calendarItemId: 'patrol', title: '巡城', kind: 'activity', status: 'in_progress',
          participantIds: ['mei'], startAt: now - 120_000, endAt: now - 60_000, locationHint: '南门' } },
    ] });
    const input = { chat, speaker: buildCharacter('mei', '美羊羊'), members: [buildCharacter('mei', '美羊羊')], now };
    expect(__chatEngineTestUtils.buildWorldEventContextPrompt(input)).toContain('Current activity: 巡城 at 南门');
    expect(__chatEngineTestUtils.buildWorldEventInfluenceRulesPrompt(input)).not.toContain('within 6 hours');
    chat.runtimeEventsV2 = [...(chat.runtimeEventsV2 || []),
      { id: 'patrol-done', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now,
        actorIds: ['mei'], visibility: 'public', summary: '巡城完成',
        payload: { calendarItemId: 'patrol', status: 'completed' } },
    ];
    expect(__chatEngineTestUtils.buildWorldEventContextPrompt(input)).not.toContain('巡城');
  });

  it('reads another member activity after production writeback without granting activity ownership', () => {
    const now = Date.now();
    const members = [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')];
    const chat = buildChat({ memberIds: members.map((member) => member.id), runtimeEventsV2: [
      { id: 'patrol-start', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now - 120_000,
        actorIds: ['hui'], visibility: 'public', summary: '巡城',
        payload: { calendarItemId: 'patrol', title: '巡城', kind: 'activity', status: 'in_progress',
          participantIds: ['hui'], participantStates: { hui: 'going' }, startAt: now - 120_000,
          endAt: now - 60_000, locationHint: '北门' } },
    ] });
    const message: Message = { id: 'patrol-report', chatId: chat.id, type: 'ai', senderId: 'hui',
      senderName: '灰太狼', content: '刚到南门，还在巡城。', emotion: 0, timestamp: now, isDeleted: false,
      metadata: { activityUpdate: { calendarItemId: 'patrol', title: '巡城', kind: 'activity', status: 'in_progress',
        locationHint: '南门', evidenceText: '刚到南门，还在巡城' } } };
    const transition = applyPresenceUpdateToTransition({ chat, characters: members, message, now,
      transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] } });
    const updatedChat = { ...chat, ...transition.chatPatch };
    const input = { chat: updatedChat, speaker: members[0], members, now };
    const prompt = __chatEngineTestUtils.buildWorldEventContextPrompt(input);
    expect(prompt).toContain('Known public activity: 巡城; 灰太狼 (participating); recorded status: in_progress at 南门');
    expect(prompt).not.toContain('北门');
    expect(prompt).not.toContain('patrol-report');
    expect(prompt).not.toContain('patrol-start');
    const contract = buildInlineInteractionContract({ chat: updatedChat, speaker: members[0], characters: members,
      recentMessages: [message] });
    expect(contract).toContain('Known speaker activity records: []');
    expect(__chatEngineTestUtils.buildWorldEventInfluenceRulesPrompt(input)).not.toContain('within 6 hours');
    const completed = applyPresenceUpdateToTransition({ chat: updatedChat, characters: members, now: now + 1000,
      message: { ...message, id: 'patrol-result', content: '巡城走完了。', timestamp: now + 1000,
        metadata: { activityUpdate: { calendarItemId: 'patrol', title: '巡城', kind: 'activity', status: 'completed',
          evidenceText: '巡城走完了' } } },
      transition: { chatPatch: {}, characterPatches: [], runtimeEvents: [] } });
    expect(__chatEngineTestUtils.buildWorldEventContextPrompt({ ...input, chat: { ...updatedChat, ...completed.chatPatch }, now: now + 1000 }))
      .toContain('recorded status: completed');
    expect(__chatEngineTestUtils.buildWorldEventContextPrompt({ ...input, chat: { ...updatedChat, ...completed.chatPatch }, now: now + 25 * 60 * 60_000 }))
      .not.toContain('巡城');
  });

  it('keeps public activity facts separate from invitations and private changes', () => {
    const now = Date.now();
    const members = [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼'), buildCharacter('lan', '懒羊羊')];
    const chat = buildChat({ memberIds: members.map((member) => member.id), runtimeEventsV2: [
      { id: 'outing', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now - 3000,
        actorIds: ['hui'], visibility: 'public', summary: '去河边',
        payload: { calendarItemId: 'outing-item', title: '河边散步', kind: 'activity', status: 'in_progress',
          participantIds: ['hui', 'lan'], participantStates: { hui: 'going', lan: 'invited' }, locationHint: '河边' } },
      { id: 'hidden-update', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now - 2000,
        actorIds: ['hui'], visibility: 'pair_private', summary: '秘密变更',
        payload: { calendarItemId: 'outing-item', locationHint: '秘密住所', status: 'cancelled' } },
      { id: 'hidden-source', conversationId: 'chat-1', kind: 'calendar_item_patch', createdAt: now - 1000,
        actorIds: ['hui'], visibility: 'role_private', summary: '私人探访',
        payload: { calendarItemId: 'hidden-item', title: '私人探访', kind: 'activity', status: 'in_progress',
          participantIds: ['hui'], locationHint: '秘密地点' } },
    ] });
    const prompt = __chatEngineTestUtils.buildWorldEventContextPrompt({ chat, speaker: members[0], members, now });
    expect(prompt).toContain('灰太狼 (participating), 懒羊羊 (invited)');
    expect(prompt).toContain('recorded status: in_progress at 河边');
    expect(prompt).not.toContain('秘密');
    expect(prompt).not.toContain('私人探访');
    expect(prompt).not.toContain('cancelled');
    expect(__chatEngineTestUtils.buildWorldEventContextPrompt({ chat: { ...chat, type: 'direct' }, speaker: members[0], members, now }))
      .not.toContain('Known public activity:');
  });

  it('builds world influence rules prompt for comfort-first and restraint', () => {
    const now = Date.now();
    const chat = buildChat({
      memberIds: ['mei', 'hui', 'user'],
      relationshipLedger: [{
        pairKey: 'mei->user',
        actorId: 'mei',
        targetId: 'user',
        current: { warmth: 16, competence: 4, trust: 12, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: now - 30 * 60_000,
      }] as never,
      runtimeEventsV2: [{
        id: 'evt-attn',
        conversationId: 'chat-1',
        kind: 'attention_candidate',
        actorIds: ['mei'],
        targetIds: ['user'],
        summary: '用户有点低落',
        visibility: 'derived_public',
        createdAt: now - 5 * 60_000,
        payload: { targetIds: ['user'], confidence: 0.96, reason: '用户有点低落' },
      } as never],
    });
    const prompt = __chatEngineTestUtils.buildWorldEventInfluenceRulesPrompt({
      chat,
      speaker: buildCharacter('mei', '美羊羊'),
      members: [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')],
      now,
    });
    expect(prompt).toContain('World influence rules:');
    expect(prompt).toContain('caring move toward the user');
  });

  it('builds world influence rules for urgent calendar and conflicts', () => {
    const now = Date.now();
    const chat = buildChat({
      memberIds: ['mei', 'hui', 'user'],
      runtimeEventsV2: [
        {
          id: 'evt-1',
          conversationId: 'chat-1',
          kind: 'event_candidate',
          actorIds: ['mei'],
          targetIds: ['mei', 'hui'],
          summary: '约了晚餐',
          visibility: 'derived_public',
          createdAt: now - 60_000,
          payload: {
            eventKind: 'social_outing',
            dedupeKey: 'dinner-1',
            title: '晚餐',
            participantIds: ['mei', 'hui'],
            startAt: now + 2 * 60 * 60_000,
            durationMinutes: 120,
          },
        } as never,
        {
          id: 'evt-2',
          conversationId: 'chat-1',
          kind: 'event_candidate',
          actorIds: ['mei'],
          targetIds: ['mei', 'hui'],
          summary: '又约了电影',
          visibility: 'derived_public',
          createdAt: now - 30_000,
          payload: {
            eventKind: 'social_outing',
            dedupeKey: 'movie-1',
            title: '电影',
            participantIds: ['mei', 'hui'],
            startAt: now + 2.5 * 60 * 60_000,
            durationMinutes: 120,
          },
        } as never,
      ],
    });
    const prompt = __chatEngineTestUtils.buildWorldEventInfluenceRulesPrompt({
      chat,
      speaker: buildCharacter('mei', '美羊羊'),
      members: [buildCharacter('mei', '美羊羊'), buildCharacter('hui', '灰太狼')],
      now,
    });
    expect(prompt).toContain('upcoming schedule');
    expect(prompt).toContain('schedule conflict');
  });

  it('exposes image capability from the default image model when the character is not explicitly bound', () => {
    expect(__chatEngineTestUtils.buildMediaCapabilities({ id: 'char-1', modelProfileIds: {} } as AICharacter, [{
      id: 'image-default',
      name: '默认图片',
      type: 'image',
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://example.test',
      model: 'image-model',
      isDefault: true,
    }])).toMatchObject({ image: true, audio: false });
  });

  it('uses the model profile array as media profiles when generation receives profile-based api config', () => {
    const profiles: AIModelProfile[] = [{
      id: 'image-default',
      name: '默认图片',
      type: 'image',
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://example.test',
      model: 'image-model',
      isDefault: true,
    }];
    const resolved = __chatEngineTestUtils.resolveMediaProfiles(profiles, undefined);
    expect(resolved).toBe(profiles);
    expect(__chatEngineTestUtils.buildMediaCapabilities({ id: 'char-1', modelProfileIds: {} } as AICharacter, resolved)).toMatchObject({ image: true, audio: false });
  });

  it('requires a media decision in the prompt contract when image generation is available', () => {
    const contract = buildInlineInteractionContract({
      chat: { id: 'chat-1', memberIds: ['char-1'], runtimeEventsV2: [] } as never,
      speaker: { id: 'char-1', name: '美羊羊' } as AICharacter,
      characters: [{ id: 'char-1', name: '美羊羊' } as AICharacter],
      recentMessages: [
        buildUserMessage('美羊羊发个灰太狼证件照的图片', 1),
        buildAiMessage('char-1', '美羊羊', '来啦，我先构思一下。', 2),
      ],
      mediaCapabilities: { image: true, audio: false },
      mediaRequested: true,
    });

    expect(contract).toContain('"mediaDecision"');
    expect(contract).toContain('Media is optional');
    expect(contract).toContain('images is an array of 1-9 distinct image tasks');
    expect(contract).toContain('Text, audio, and images may be combined in one turn');
    expect(contract).toContain('including a single send');
    expect(contract).toContain('repeating wording, cadence, or a marker is the deliberate social move');
    expect(contract).toContain('do not use it to excuse template drift');
    expect(contract).toContain('socialEventHints: null unless the visible turn itself proposes');
    expect(contract).toContain('Recent transcript scope');
    expect(contract).toContain('does not repeat raw dialogue');
    expect(contract).not.toContain('美羊羊发个灰太狼证件照的图片');
    expect(contract).not.toContain('来啦，我先构思一下');
    expect(contract).not.toContain('一句自然的群聊回复');
  });

  it('makes the story output contract follow the current beat choice policy', () => {
    const contract = buildInlineInteractionContract({
      chat: buildChat({
        memberIds: ['narrator'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        runtimeEventsV2: [],
      }),
      speaker: { id: 'narrator', name: '旁白' } as AICharacter,
      characters: [{ id: 'narrator', name: '旁白' } as AICharacter],
      recentMessages: [],
    });

    expect(contract).toContain('This is the required shape for story-reader turns');
    expect(contract).toContain('"storyEvents": [');
    expect(contract).toContain('Do not copy the JSON shape with storyEvents=null');
    expect(contract).toContain('must include at least one visible narration or speech event');
    expect(contract).toContain('Story-reader turns must use storyEvents as the authoritative visible story body');
    expect(contract).toContain('choicePolicy=forbid');
    expect(contract).toContain('This beat forbids choice_point');
    expect(contract).not.toContain('"type":"choice_point"');
    expect(contract).toContain('Speech text must be chat-like');
    expect(contract).toContain('A common speech event is 1-3 sentences');
    expect(contract).toContain('suggested event counts are guidance, not enforcement');
    expect(contract).toContain("Do not let one character inherit another character's private object");
    expect(contract).toContain('Do not output alternate rewrites of the same moment');
    expect(contract).toContain('keep only the final version; do not include both drafts in storyEvents');
    expect(contract).toContain('Write visible scene execution, not author notes');
    expect(contract).toContain('If the user just chose a branch, first show what immediately changes on screen');
    expect(contract).toContain('storyEvents.choice_point is the source of truth');
    expect(contract).toContain('Do not output top-level storyChoices for the primary path');
    expect(contract).not.toContain('"content": ""');
    expect(contract).not.toContain('"extraMessages": null');
    expect(contract).not.toContain('"narrativeText": null');
    expect(contract).not.toContain('"narrativeBlocks": null');
    expect(contract).not.toContain('narrativeBlocks');
    expect(contract).not.toContain('narrativeText');
    expect(contract).not.toContain('按当前请求自然作答');
    expect(contract).not.toContain('content is the first visible chat bubble');
    expect(contract).not.toContain('extraMessages is optional. Use null for one bubble');
    expect(contract).not.toContain('"storyChoices": null');
    expect(contract).not.toContain('storyChoices drives the UI');
  });

  it('asks the model to judge counterpart interaction hints in AI private chats', () => {
    const contract = buildInlineInteractionContract({
      chat: { id: 'chat-1', type: 'ai_direct', memberIds: ['char-1', 'char-2'], runtimeEventsV2: [] } as never,
      speaker: { id: 'char-1', name: '甲' } as AICharacter,
      characters: [{ id: 'char-1', name: '甲' } as AICharacter, { id: 'char-2', name: '乙' } as AICharacter],
      recentMessages: [
        buildAiMessage('char-2', '乙', '我刚才那句话可能有点重。', 1),
      ],
    });

    expect(contract).toContain('In AI direct chats, target the other participant');
    expect(contract).toContain('do not target the speaker or the user unless the user is an actual participant');
    expect(contract).toContain('id=char-2; name=乙');
  });

  it('lists user as a valid structured event participant when user is a member', () => {
    const contract = buildInlineInteractionContract({
      chat: buildChat({ memberIds: ['char-1', 'user'] }),
      speaker: { id: 'char-1', name: '甲' } as AICharacter,
      characters: [{ id: 'char-1', name: '甲' } as AICharacter],
      recentMessages: [],
    });

    expect(contract).toContain('- id=user; name=用户/我; aliases=用户,我');
    expect(contract).toContain('Include "user" when invited or participating');
  });

  it('does not list non-members as valid structured event participants', () => {
    const contract = buildInlineInteractionContract({
      chat: buildChat({ memberIds: ['char-1', 'char-2'] }),
      speaker: { id: 'char-1', name: '甲' } as AICharacter,
      characters: [
        { id: 'char-1', name: '甲' } as AICharacter,
        { id: 'char-2', name: '乙' } as AICharacter,
        { id: 'char-outside', name: '场外角色' } as AICharacter,
      ],
      recentMessages: [],
    });

    expect(contract).toContain('- id=char-2; name=乙');
    expect(contract).not.toContain('char-outside');
  });

  it('records structured output protocol diagnostics for invite guidance without social outing hints', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '今晚九点半，后巷蓝布门帘那家旧茶馆，大家来不来随意。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const luxun = buildCharacter('luxun', '鲁迅');
    const chat = buildChat({ memberIds: ['luxun', 'user'] });
    const directorIntent: DirectorIntent = {
      source: 'user_message',
      beatType: 'invite',
      targetActorIds: ['luxun'],
      pressure: 0.9,
      reason: '用户要求安排活动',
      userGuidance: {
        kind: 'direct_reply',
        rawText: '鲁迅，主动安排一个今晚大家可以一起参加的具体活动。',
        actorIds: ['luxun'],
        mentionedActorIds: ['luxun'],
        focusText: '主动安排一个今晚大家可以一起参加的具体活动',
        beatType: 'invite',
        pressure: 0.9,
        maxTurns: 1,
        reason: '用户要求角色安排活动',
      },
    };

    const message = await generateSpeakerMessage({
      chat,
      speaker: luxun,
      characters: [luxun],
      messages: [
        buildUserMessage('鲁迅，主动安排一个今晚大家可以一起参加的具体活动。', 1),
      ],
      apiConfig: buildProfiles(),
      directorIntent,
    });
    const trace = message.metadata?.runtimeDecision?.generationRuntime?.trace as { policyHits?: string[]; guidanceValidation?: string } | undefined;

    expect(trace?.policyHits).toContain('structured_output:json_envelope_parsed');
    expect(trace?.policyHits).toContain('structured_output:invite_guidance_without_social_outing');
    expect(trace?.guidanceValidation).toContain('inviteGuidanceSocialOuting=missing');
  });

  it('does not locally force detailed chat requests into a professional longform surface', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我会这么拆：每个实例单独分支，提交前只 stage 自己改的文件，再 rebase 或 merge 回主线。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const linus = buildCharacter('linus', 'Linus', { expertise: ['Git', '代码管理'] });

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['linus'] }),
      speaker: linus,
      characters: [linus],
      messages: [
        buildUserMessage('详细讲讲你会怎么做？', 1),
      ],
      apiConfig: buildProfiles(),
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(prompt).toContain('## Turn Directive');
    expect(prompt).toContain('Stay compact enough for ordinary group flow');
    expect(prompt).not.toContain('Use the depth the moment needs');
    expect(prompt).not.toContain('Current speaking intent');
    expect(prompt).not.toContain('Professional form is available');
    expect(message.content).toContain('每个实例单独分支');
  });

  it('carries current emotion and asymmetric authority into the final ordinary-group prompt', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '属下记得。只是这回若还按旧例查，恐怕又要漏掉门里那个人。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const subordinate = buildCharacter('niu-tou', '牛头', {
      background: '幽都夜巡差役，重实证，也在意自己是否只被当成跑腿。',
      speakingStyle: '粗直具体，被反复差遣时会抱怨。',
      emotionalState: { irritation: 46, affection: 18, insecurity: 34, excitement: 20, embarrassment: 16 },
      relationships: [{ characterId: 'yan-jun', warmth: 8, competence: 72, trust: 48, threat: 28, attachment: 12, deference: 76, note: '敬畏阎君的裁决权，也怕当众答错后被追问。' }],
      coreProfile: {
        coreDesire: '让人看见跑腿不是没脑子的活。',
        coreFear: '出了力还要独自背锅。',
        valuePriority: ['实证', '担当', '体面'],
        interactionHabits: ['对阎君服从，但在意是否由对方承担后果'],
        sensitivities: ['被当成只有腿没有脑子'],
      },
    });
    const superior = buildCharacter('yan-jun', '阎君', {
      relationships: [{ characterId: 'niu-tou', warmth: 12, competence: 58, trust: 50, threat: 4, attachment: 10, deference: -62, note: '把牛头视为可用但需要约束的下属。' }],
    });
    const chat = buildChat({
      memberIds: ['niu-tou', 'yan-jun'],
      relationshipStructure: {
        updatedAt: 1,
        sharedFacts: [{ id: 'authority', memberIds: ['niu-tou', 'yan-jun'], kind: 'authority', statement: '阎君统辖幽都，牛头受其差遣并负责夜巡。', confidence: 0.98, evidence: '角色设定', updatedAt: 1 }],
      },
    });

    await generateSpeakerMessage({
      chat,
      speaker: subordinate,
      characters: [subordinate, superior],
      messages: [buildAiMessage('yan-jun', '阎君', '西巷又出了纰漏。牛头，你怎么交代？', 1)],
      apiConfig: buildProfiles(),
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(prompt).toContain('irritation 46');
    expect(prompt).toContain('insecurity 34');
    expect(prompt).not.toContain('Expression guidance:');
    expect(prompt).toContain('## Inner Life');
    expect(prompt).toContain('Recorded emotional lead:');
    expect(prompt).not.toContain('Current impulse:');
    expect(prompt).not.toContain('## Natural Chat Rhythm');
    expect(prompt).not.toContain('## Style Quarantine');
    expect(prompt).not.toContain('## Turn Plan');
    expect(prompt).toContain('Speak as this person among people who share this exchange');
    expect(prompt).not.toContain('## Expression Surface Choice');
    expect(prompt).toContain('阎君统辖幽都，牛头受其差遣并负责夜巡');
    expect(prompt).toContain('not an assigned recipient');
    expect(prompt).toContain('Emotional and dramatic context:');
    expect(prompt).not.toContain('## Current speaking intent');
    expect(prompt.match(/## Turn Directive/g)).toHaveLength(1);
  });

  it('keeps scheduler reply debt as an optional attention cue in the model prompt', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '嗯，先放这儿。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const source = buildCharacter('source', '甲');
    const target = buildCharacter('target', '乙');
    await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['source', 'target'] }),
      speaker: target,
      characters: [source, target],
      messages: [buildAiMessage('source', '甲', '你这件事还没说完。', 1)],
      pendingReplyContext: {
        targetIds: ['target'],
        primaryTargetId: 'target',
        sourceSpeakerId: 'source',
        sourceMessageId: 'source-message',
        unmetTurns: 1,
        strength: 'strong',
      },
      apiConfig: buildProfiles(),
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(prompt).toContain('Recent social cue');
    expect(prompt).toContain('not a command');
    expect(prompt).toContain('let it pass');
    expect(prompt).not.toContain('Pending reply expectation');
    expect(prompt).not.toContain('live social obligation');
    expect(prompt).not.toContain('Reply obligation');
  });

  it('removes leaked runtime field names from generated visible content', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: 'eventType先按“未翻案、有人先试锋”落着，你别替任何人往下续。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const empress = buildCharacter('empress', '太后');

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['empress'] }),
      speaker: empress,
      characters: [empress],
      messages: [
        buildUserMessage('继续说。', 1),
      ],
      apiConfig: buildProfiles(),
    });

    expect(message.content).toBe('先按“未翻案、有人先试锋”落着，你别替任何人往下续。');
    expect(message.content).not.toContain('eventType');
  });

  it('commits storyEvents as visible narrator content, narrative blocks, and choices when content is empty', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '',
      storyEvents: [
        { type: 'narration', text: longStorySection('雨水顺着医院旧楼的铁门往下流，门缝里传出断续的敲击声。') },
        { type: 'speech', characterId: 'lin', speakerName: '林医生', text: '不要开那扇门。' },
        {
          type: 'choice_point',
          choices: [
            { label: '让林医生去地下档案室查被撕掉的病历', prompt: '林医生进入地下档案室查病历', risk: '可能惊动门后的人', reward: '找到被撕病历' },
            { label: '让护士追问昨晚停电记录', prompt: '护士追问停电记录', risk: '暴露调查方向', reward: '确认敲门时间' },
          ],
        },
      ],
      storyAssets: {
        currentScene: { location: '医院旧楼铁门', summary: '雨夜里门后传来敲击声，林医生阻止众人开门。' },
        openQuestions: ['门后是谁在敲击？'],
        clues: ['门缝里的断续敲击声'],
        stakes: ['贸然开门会惊动未知的人'],
      },
      storyChoices: null,
      extraMessages: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const narrator = buildCharacter('narrator', '旁白');
    const lin = buildCharacter('lin', '林医生');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        memberIds: ['lin'],
        scenarioState: { phase: 'scene', sceneBeatCount: 3, choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [lin],
      messages: [
        buildAiMessage('narrator', '旁白', '旧楼尽头的灯忽明忽暗。', 1),
        buildUserMessage('开始故事', 2),
      ],
      apiConfig: buildProfiles(),
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(prompt).toContain('You are the story-reader narrative engine');
    expect(prompt).toContain('## Prompt Play Mode');
    expect(prompt).toContain('Mode: story_reader');
    expect(prompt).toContain('Story reader prioritizes committed scene continuation');
    expect(prompt).toContain('Return exactly one valid JSON object');
    expect(prompt).toContain('"storyEvents": [');
    expect(prompt).not.toContain('Reply as a chat message');
    expect(prompt).not.toContain('Current speaking intent');
    expect(prompt).not.toContain('Hard constraints for this reply');
    expect(prompt).not.toContain('Response surface:');
    expect(prompt).not.toContain('mediaDecision');
    expect(generateResponseMock.mock.calls[0]?.[4]).toEqual(expect.objectContaining({ responseFormat: 'json' }));
    const chatMessages = (generateResponseMock.mock.calls[0]?.[2] || []) as Array<{ role: string; content: string }>;
    expect(chatMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('旁白: 旧楼尽头的灯忽明忽暗。') }),
    ]));
    expect(chatMessages.some((item) => item.role === 'assistant')).toBe(false);

    expect(message.senderId).toBe('narrator');
    expect(message.content).toContain('雨水顺着医院旧楼的铁门往下流');
    expect(message.content).toContain('林医生：“不要开那扇门。”');
    expect(message.metadata?.storyEvents).toHaveLength(3);
    expect(message.metadata?.storyQuality).toEqual(expect.objectContaining({
      score: expect.any(Number),
      labels: expect.arrayContaining(['has_narration', 'has_speech', 'has_choice_point', 'concrete_scene', 'has_story_hook']),
    }));
    expect(message.metadata?.storyQuality?.gaps).not.toContain('missing_story_hook');
    expect(message.metadata?.storyChoices).toEqual([
      { label: '让林医生去地下档案室查被撕掉的病历', prompt: '林医生进入地下档案室查病历', risk: '可能惊动门后的人', reward: '找到被撕病历' },
      { label: '让护士追问昨晚停电记录', prompt: '护士追问停电记录', risk: '暴露调查方向', reward: '确认敲门时间' },
    ]);
    expect(message.metadata?.narrativeTurn?.povActorId).toBe('narrator');
    expect(message.metadata?.narrativeTurn?.blocks).toEqual([
      expect.objectContaining({ actorKind: 'narrator', displayMode: 'paragraph' }),
      expect.objectContaining({ actorKind: 'character', displayMode: 'bubble', characterId: 'lin' }),
      expect.objectContaining({ actorKind: 'system', displayMode: 'system_panel', text: expect.stringContaining('新的抉择点') }),
    ]);
  });

  it('retries story-reader generations that restart the scene instead of continuing the latest beat', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        content: '',
        storyEvents: [
          { type: 'narration', text: '前情：沈清婉发现枕下长剑，月奴站在门边等待她的命令。' },
          { type: 'narration', text: '她重新抬起眼，望向那扇半掩的门。' },
        ],
        storyChoices: null,
        extraMessages: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: '',
        storyEvents: [
          { type: 'narration', text: longStorySection('影子退开后，门槛外反而传来一声极轻的衣料摩擦。沈清婉把剑柄压回袖中。') },
          { type: 'speech', characterId: 'nurse', speakerName: '月奴', text: '小姐，外头的人还没走远。' },
        ],
        storyChoices: null,
        extraMessages: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const narrator = buildCharacter('narrator', '旁白');
    const nurse = buildCharacter('nurse', '月奴');
    const previousBeat: Message = {
      id: 'prev-story',
      chatId: 'chat-1',
      type: 'ai',
      senderId: 'narrator',
      senderName: '旁白',
      content: '',
      emotion: 0,
      timestamp: 2,
      isDeleted: false,
      metadata: {
        narrativeTurn: {
          turnId: 'turn-prev',
          turnKind: 'narrative_beat',
          sceneId: 'main',
          phase: 'scene',
          povActorId: 'narrator',
          blocks: [
            {
              id: 'p1',
              actorId: 'narrator',
              actorKind: 'narrator',
              kind: 'prose',
              displayMode: 'paragraph',
              text: '烛火又跳了一下，门外那道影子终于从窗纸上退开。',
            },
            {
              id: 's1',
              actorId: 'nurse',
              actorKind: 'character',
              kind: 'dialogue',
              displayMode: 'bubble',
              characterId: 'nurse',
              text: '小姐，奴婢不是不肯说，是不能在这里说。',
            },
          ],
        },
      },
    };

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        memberIds: ['nurse'],
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [nurse],
      messages: [buildUserMessage('继续故事', 1), previousBeat],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    const firstPrompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(firstPrompt).toContain('A short charged exchange can stand on its own');
    expect(firstPrompt).toContain('Use as many narration and speech events as the current story beat needs');
    expect(firstPrompt).not.toContain('900-1600 Chinese characters');
    expect(firstPrompt).not.toContain('1200-2200 Chinese characters');
    expect(firstPrompt).toContain('Suggested ranges are guidance, not enforcement');
    const retryPrompt = String(generateResponseMock.mock.calls[1]?.[1] || '');
    expect(retryPrompt).toContain('故事房下一节没有按小说连续阅读接续');
    expect(retryPrompt).toContain('Story continuity retry');
    expect(retryPrompt).toContain('Start after the final visible moment');
    expect(retryPrompt).not.toContain('Previous visible beat ended at');
    expect(retryPrompt).not.toContain('门外那道影子终于从窗纸上退开');
    expect(retryPrompt).not.toContain('Rejected draft:');
    expect(message.content).toContain('影子退开后');
    expect(message.content).not.toContain('前情');
  });

  it('blocks semantic near-duplicates even when wording shifts', () => {
    const result = evaluateDuplicateGuard({
      content: '先单开一个分支，提交前只暂存你自己的文件。',
      messages: [
        buildAiMessage('mei', '美羊羊', '先开独立分支，提交前只 stage 自己改动的文件。', 1),
      ],
      speakerId: 'mei',
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("exactly repeats the speaker's recent line");
  });

  it('folds recent-airtime pressure into the ordinary group turn directive', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '先把最关键的一点说清楚。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('linus', 'Linus', { expertise: ['架构设计'] });

    await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['linus', 'mei'] }),
      speaker: analyst,
      characters: [analyst, buildCharacter('mei', '美羊羊')],
      messages: [
        buildAiMessage('linus', 'Linus', '上一轮我先说。', 1),
        buildAiMessage('linus', 'Linus', '我再补一条。', 2),
        buildAiMessage('mei', '美羊羊', '我插一句。', 3),
        buildAiMessage('linus', 'Linus', '还有一个点。', 4),
        buildAiMessage('linus', 'Linus', '最后再补一句。', 5),
        buildUserMessage('详细分析一下这个取舍。', 6),
      ],
      apiConfig: buildProfiles(),
      generationContext: {
        promptContext: {
          styleProfile: 'analytical_room',
        },
      },
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(prompt).toContain('## Turn Directive');
    expect(prompt).toContain('## Character Grounding');
    expect(prompt).toContain('Speak as this person among people who share this exchange');
    expect(prompt).toContain('do not sprawl to keep airtime');
    expect(prompt).not.toContain('## Persona Activation');
    expect(prompt).not.toContain('## Live Presence');
    expect(prompt).not.toContain('## Character Background Reference');
    expect(prompt).not.toContain('Current speaking intent');
    expect(prompt).not.toContain('Focused Situational Job Contract');
    expect(prompt).not.toContain('Natural Chat Surface Contract');
    expect(prompt).not.toContain('Runtime Role Constraint');
  });

  it('preserves deliverable-like generated text without requiring local surface classification', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '如果让我认真写，我会先说：AI不会简单地替代人类。\n\n它更像一面放大镜，把人的能力差异、制度漏洞和创造力一起放大。\n\n所以我不想只问它会不会抢走工作，而要问人类准备怎样重新安排自己的价值。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const susu = buildCharacter('susu', '穿搭博主苏苏');
    const luxun = buildCharacter('luxun', '鲁智深');

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['susu', 'luxun'] }),
      speaker: susu,
      characters: [susu, luxun],
      messages: [
        buildUserMessage('你怎么看待AI在未来对人类的影响？每个人写一篇800字作文', Date.now()),
      ],
      apiConfig: buildProfiles(),
      speakerSelection: {
        speakerId: 'susu',
        policy: { source: 'user_guidance_lock', lockedActorIds: ['susu', 'luxun'] },
      },
      directorIntent: {
        source: 'user_message',
        beatType: 'answer',
        targetActorIds: ['susu', 'luxun'],
        pressure: 0.92,
        reason: '用户要求每个角色分别完成写作任务。',
        userGuidance: {
          kind: 'direct_reply', rawText: '你怎么看待AI在未来对人类的影响？每个人写一篇800字作文',
          actorIds: ['susu', 'luxun'], mentionedActorIds: [], focusText: '每个人分别写一篇800字作文',
          beatType: 'answer', pressure: 0.92, maxTurns: 2, minTargetTurns: 1,
          reason: '用户要求每个角色分别完成写作任务。',
        },
      },
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(prompt).toContain('## User Guidance Override');
    expect(prompt).toContain('Requested actor(s): 穿搭博主苏苏、鲁智深');
    expect(prompt).toContain('Honor explicit output form, quantity, and length requirements');
    expect(prompt).toContain('produce that deliverable');
    expect(prompt).toContain('escaped newline sequences');
    expect(prompt).toContain('Do not put a heading marker, separator, and the whole article on one line');
    expect(prompt).toContain('If the user explicitly asks each actor for a deliverable, each must complete their own');
    expect(prompt).not.toContain('their own substantive response for the same task');
    expect(message.content).toContain('\n\n它更像一面放大镜');
    expect(message.metadata?.runtimeDecision?.directorIntent?.targetActorIds).toEqual(['susu', 'luxun']);
    expect(message.metadata?.runtimeDecision?.speakerSelection).toMatchObject({
      speakerId: 'susu',
      policy: { source: 'user_guidance_lock', lockedActorIds: ['susu', 'luxun'] },
    });
    expect(message.metadata?.runtimeDecision?.responseSurface?.kind).toBe('chat');
    expect(message.metadata?.runtimeDecision?.responseSurface?.basis || []).not.toContain('topic:longform-writing-task');
  });

  it('prompts corrective speaker suppression and persists guidance trace fields', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我明白，我自己来说。除了入口和客服，访谈里还有一个细节：老用户觉得改版前没人提前告诉他们。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const anan = buildCharacter('anan', '安安');
    const zhou = buildCharacter('zhou', '周策');
    const mei = buildCharacter('mei', '梅青');
    const directorIntent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: ['anan'],
      pressure: 0.92,
      reason: '用户点名角色回应。',
      userGuidance: {
        kind: 'direct_reply',
        rawText: '我刚才是想听安安说，不是让周策替她做决定。',
        actorIds: ['anan'],
        mentionedActorIds: ['anan', 'zhou'],
        suppressedActorIds: ['zhou'],
        focusText: '我刚才是想听安安说，不是让周策替她做决定。',
        beatType: 'answer',
        pressure: 0.92,
        maxTurns: 5,
        reason: '用户点名角色回应。',
      },
    };

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['anan', 'zhou', 'mei'] }),
      speaker: anan,
      characters: [anan, zhou, mei],
      messages: [
        buildAiMessage('zhou', '周策', '我先补一句，流失不能简单归因到一个点。', 1),
        buildUserMessage('我刚才是想听安安说，不是让周策替她做决定。', 2),
      ],
      apiConfig: buildProfiles(),
      directorIntent,
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(prompt).toContain('Speaker suppression');
    expect(prompt).toContain('Correction handling');
    expect(prompt).toContain('answer in your own voice');
    expect(prompt).toContain('Being addressed gives you the floor');
    expect(prompt).not.toContain('answer the user-requested point first, then optionally react socially');
    expect(prompt).not.toContain('treat this as a direct task');
    expect(message.metadata?.runtimeDecision?.directorIntent?.userGuidance).toMatchObject({
      suppressedActorIds: ['zhou'],
    });
    expect(message.metadata?.runtimeDecision?.generationRuntime?.turnPlan?.targetIds).toEqual([]);
    expect(message.metadata?.runtimeDecision?.generationRuntime?.trace?.policyHits).toContain('conversation_move_reason:explicit_user_guidance');
  });

  it('models targeted guidance as floor control without forcing every continuation to add a new thesis', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我先把这点收住，别把我的意思又转成别人的口径。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const anan = buildCharacter('anan', '安安');
    const zhou = buildCharacter('zhou', '周策');
    const now = Date.now();
    const userTurn = buildUserMessage('安安，你直接说吧，用户到底为什么不再用了？不用先照顾周策的汇报口径。', now - 2000);
    const priorAnswer = buildAiMessage('anan', '安安', '我自己说，访谈里最刺耳的是他们觉得被忽然丢下了。', now - 1000);
    priorAnswer.metadata = {
      runtimeDecision: {
        directorIntent: {
          source: 'user_message',
          beatType: 'answer',
          targetActorIds: ['anan'],
          pressure: 0.9,
          reason: '用户点名角色回应。',
          userGuidance: {
            kind: 'direct_reply',
            rawText: userTurn.content,
            actorIds: ['anan'],
            mentionedActorIds: ['anan', 'zhou'],
            suppressedActorIds: [],
            focusText: userTurn.content,
            beatType: 'answer',
            pressure: 0.9,
            maxTurns: 2,
            minTargetTurns: 2,
            reason: '用户点名角色回应。',
          },
        },
      },
    } as Message['metadata'];

    await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['anan', 'zhou'] }),
      speaker: anan,
      characters: [anan, zhou],
      messages: [userTurn, priorAnswer],
      apiConfig: buildProfiles(),
      directorIntent: priorAnswer.metadata?.runtimeDecision?.directorIntent as DirectorIntent,
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(prompt).toContain('## Room Floor State');
    expect(prompt).toContain('Phase: continue the same floor');
    expect(prompt).toContain('Some real chat turns mainly change social temperature');
    expect(prompt).toContain('## Turn Directive');
    expect(prompt).toContain('do not manufacture a new thesis');
    expect(prompt).not.toContain('可是');
    expect(prompt).not.toContain('唉');
  });

  it('reconciles stay-silent inner life when the scheduler finally selects the speaker', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '那我只补一句：先让安安把访谈原话说完，其他结论晚点再收。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '梅青', {
      behavior: { proactivity: 20, aggressiveness: 8, humorIntensity: 10, empathyLevel: 70, summarizing: 30, offTopic: 8 },
    });
    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['anan', 'zhou', 'mei'] }),
      speaker: mei,
      characters: [buildCharacter('anan', '安安'), buildCharacter('zhou', '周策'), mei],
      messages: [
        buildAiMessage('anan', '安安', '我先说一个访谈细节。', 1),
      ],
      apiConfig: buildProfiles(),
      speakerScore: {
        actorId: 'mei',
        finalScore: 0.05,
        addressed: 0,
        topicRelevance: 0,
        lineInvolvement: 0,
        emotionalPressure: 0,
        innerLifePressure: -0.18,
        relationshipPressure: 0,
        factionPressure: 0,
        personalityDrive: 0.3,
        knowledgeAccess: 0,
        novelty: 0,
        silencePressure: 0,
        cooldownPenalty: 0,
        repetitionPenalty: 0,
        reasons: ['inner:stay_silent'],
      },
    });

    expect(message.metadata?.runtimeDecision?.innerLife?.impulse).toBe('answer');
    expect(message.metadata?.runtimeDecision?.innerLife?.reason).toContain('调度最终选择');
    expect(message.metadata?.runtimeDecision?.speakerScore?.reasons).not.toContain('inner:stay_silent');
    expect(message.metadata?.runtimeDecision?.speakerScore?.reasons).toContain('inner:answer_after_scheduler_selection');
  });

  it('does not invent addressed targets from visible names when the model omits addressedTargets', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '御厨，今晚先把料备全，明日谁误了午市，朕拿你是问。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const qin = buildCharacter('qin', '秦始皇');
    const chef = buildCharacter('chef', '御厨阿衡');
    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['qin', 'chef'] }),
      speaker: qin,
      characters: [qin, chef],
      messages: [
        { ...buildAiMessage('chef', '御厨阿衡', '菜单我来定。', 1), chatId: 'chat-1' },
      ],
      apiConfig: buildProfiles(),
    });

    expect(message.addressedTargetIds).toBeNull();
    expect(message.primaryAddressedTargetId).toBeNull();
  });

  it('records the sole direct-chat partner without reading the reply wording', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '嗯，我在。',
      addressedTargets: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const message = await generateSpeakerMessage({
      chat: buildChat({ type: 'direct', memberIds: ['mei'] }),
      speaker: mei,
      characters: [mei],
      messages: [buildUserMessage('还在吗？', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.addressedTargetIds).toEqual(['user']);
    expect(message.primaryAddressedTargetId).toBe('user');
  });

  it('records the sole AI-private partner without reading the reply wording', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '嗯，我听见了。',
      addressedTargets: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const a = buildCharacter('a', '甲');
    const b = buildCharacter('b', '乙');
    const message = await generateSpeakerMessage({
      chat: buildChat({ type: 'ai_direct', memberIds: ['a', 'b'] }),
      speaker: a,
      characters: [a, b],
      messages: [buildAiMessage('b', '乙', '我先说。', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.addressedTargetIds).toEqual(['b']);
    expect(message.primaryAddressedTargetId).toBe('b');
  });

  it('keeps model-addressed targets authoritative when other members are only mentioned', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我先问的是程野。许棠，刚才我没问你。现在问，晚了吗？',
      addressedTargets: {
        targetIds: ['xutang'],
        primaryTargetId: 'xutang',
        confidence: 0.96,
        reason: '最后的问题明确交给许棠回答',
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const wenxi = buildCharacter('wenxi', '闻溪');
    const chengye = buildCharacter('chengye', '程野');
    const xutang = buildCharacter('xutang', '许棠');
    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['wenxi', 'chengye', 'xutang'] }),
      speaker: wenxi,
      characters: [wenxi, chengye, xutang],
      messages: [
        { ...buildAiMessage('xutang', '许棠', '你先问了他。', 1), chatId: 'chat-1' },
      ],
      apiConfig: buildProfiles(),
    });

    expect(message.addressedTargetIds).toEqual(['xutang']);
    expect(message.primaryAddressedTargetId).toBe('xutang');
  });

  it('uses an explicit reply-worthy interaction target when addressedTargets is omitted', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '博远，别把这件事一笑带过。你先说清楚。',
      addressedTargets: null,
      interactionHints: {
        primary: {
          targetId: 'boyuan',
          kind: 'challenge',
          tone: 'annoyed',
          intensity: 3,
          confidence: 0.9,
          evidenceText: '别把这件事一笑带过',
          reason: '明确要求博远回应',
        },
        secondary: [],
      },
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mira = buildCharacter('mira', '米拉');
    const boyuan = buildCharacter('boyuan', '博远');
    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['mira', 'boyuan'] }),
      speaker: mira,
      characters: [mira, boyuan],
      messages: [],
      apiConfig: buildProfiles(),
    });

    expect(message.addressedTargetIds).toEqual(['boyuan']);
    expect(message.primaryAddressedTargetId).toBe('boyuan');
  });

  it('uses one validated addressed-target result for message metadata and turn parameters', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '程野，这件事你先说。',
      addressedTargets: {
        targetIds: ['chengye', 'not-a-member', 'chengye'],
        primaryTargetId: 'not-a-member',
        confidence: 0.9,
        reason: '把话交给程野',
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const wenxi = buildCharacter('wenxi', '闻溪', {
      memory: { longTerm: [], shortTermSummary: '', secrets: [], obsessions: [], tabooTopics: [], userMemories: [] },
    });
    const chengye = buildCharacter('chengye', '程野');
    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['wenxi', 'chengye'] }),
      speaker: wenxi,
      characters: [wenxi, chengye],
      messages: [],
      apiConfig: buildProfiles(),
    });

    expect(message.addressedTargetIds).toEqual(['chengye']);
    expect(message.primaryAddressedTargetId).toBe('chengye');
  });

  it('allows a third-party floor guardian without pretending local text checks can judge its semantics', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '安安，你继续说完，我先不替你收口。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const anan = buildCharacter('anan', '安安');
    const zhou = buildCharacter('zhou', '周策');
    const mei = buildCharacter('mei', '梅青');
    const directorIntent: DirectorIntent = {
      source: 'user_message',
      beatType: 'answer',
      targetActorIds: [],
      pressure: 0.92,
      reason: '用户点名角色回应。',
      userGuidance: {
        kind: 'direct_reply',
        rawText: '我刚才是想听安安说，不是让周策替她做决定。',
        actorIds: ['anan'],
        mentionedActorIds: ['anan', 'zhou'],
        suppressedActorIds: ['zhou'],
        focusText: '我刚才是想听安安说，不是让周策替她做决定。',
        beatType: 'answer',
        pressure: 0.92,
        maxTurns: 5,
        reason: '用户点名角色回应。',
      },
    };

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['anan', 'zhou', 'mei'] }),
      speaker: mei,
      characters: [anan, zhou, mei],
      messages: [
        buildUserMessage('我刚才是想听安安说，不是让周策替她做决定。', 1),
        buildAiMessage('anan', '安安', '我先把真实想法说完。', 2),
      ],
      apiConfig: buildProfiles(),
      directorIntent,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(message.content).toBe('安安，你继续说完，我先不替你收口。');
    expect(message.metadata?.runtimeDecision?.guidanceExecution).toMatchObject({
      status: 'accepted',
      rejectedReasons: [],
      finalReason: 'matched',
    });
  });

  it('honors disabled role actions from mode config and strips visible action asides', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '（轻轻挠头）这个我先记下来，等会儿接着说。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const xiao = buildCharacter('xiao', '潇潇');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['xiao'],
        showRoleActions: undefined,
        modeConfig: {
          freeSpeaking: true,
          allowInterruptions: true,
          allowPrivateThreads: true,
          allowDirectorInterventions: true,
          showRoleActions: false,
        },
      }),
      speaker: xiao,
      characters: [xiao],
      messages: [buildUserMessage('等下', 1)],
      apiConfig: buildProfiles(),
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(prompt).toContain('Role actions:');
    expect(prompt).toContain('No standalone stage directions, gesture beats, or parenthesized action asides');
    expect(message.content).toBe('这个我先记下来，等会儿接着说。');
  });

  it('retries long stage-direction narration in analysis rooms instead of committing it as chat', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        content: '（听完房东大姐那句“门不锁”，我把手边那张画到一半的草稿翻过来，沉默了几秒才抬头。）我觉得今晚这里像一盏灯。',
        deliberationArtifacts: { claims: [{ text: '今晚这里像一盏灯。', reason: '回应审议主题', confidence: 0.7 }] },
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const illustrator = buildCharacter('illustrator', '自由职业插画师');
    const landlord = buildCharacter('landlord', '房东大姐');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['illustrator', 'landlord'],
      }),
      speaker: illustrator,
      characters: [illustrator, landlord],
      messages: [
        buildAiMessage('landlord', '房东大姐', '我这儿门不锁，最后走的那个帮我带一下。', 1),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'surface_contract_warning',
      reason: expect.stringContaining('stage directions'),
      attempt: 1,
    }));
    expect(message.content).toContain('（听完房东大姐');
    expect(message.metadata?.deliberationArtifacts?.claims?.[0]?.text).toContain('今晚这里像一盏灯');
  });

  it('keeps and reports non-story drafts that include another character speaking inside one content field', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValueOnce(JSON.stringify({
      content: '这个结论我先放这儿：弱连接比合租更可行。资深北漂程序员: 我补一句，这个版本能跑就行。',
      deliberationArtifacts: { claims: [{ text: '弱连接比合租更可行', reason: '提出判断', confidence: 0.7 }] },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const illustrator = buildCharacter('illustrator', '自由职业插画师');
    const programmer = buildCharacter('programmer', '资深北漂程序员');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['illustrator', 'programmer'],
      }),
      speaker: illustrator,
      characters: [illustrator, programmer],
      messages: [buildAiMessage('programmer', '资深北漂程序员', '这一版能跑通就行。', 1)],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'surface_contract_warning',
      reason: expect.stringContaining('资深北漂程序员'),
      attempt: 1,
    }));
    expect(message.content).toContain('资深北漂程序员:');
  });

  it('preserves parsed image decisions and converts them into queued attachments', () => {
    const parsed = parseInlineInteractionEnvelope(JSON.stringify({
      content: '来啦，你看这杯杨枝甘露。',
      mediaDecision: {
        image: {
          shouldGenerate: true,
          reason: '用户明确想看图片',
          prompt: 'A cute WeChat-style photo of mango pomelo sago dessert on a table',
          altText: '一杯杨枝甘露甜品',
        },
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const metadata = __chatEngineTestUtils.buildMessageMetadata({
      decision: parsed?.mediaDecision,
      capabilities: { image: true, audio: false },
      content: parsed?.content || '',
    });

    expect(metadata?.attachments).toHaveLength(1);
    expect(metadata?.attachments?.[0]).toMatchObject({
      kind: 'image',
      status: 'queued',
      promptText: 'A cute WeChat-style photo of mango pomelo sago dessert on a table',
      altText: '一杯杨枝甘露甜品',
    });
  });

  it('keeps per-segment image and audio decisions from the structured messages protocol', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      messages: [
        { content: '第一条', mediaDecision: null },
        { content: '第二条图片', mediaDecision: { images: [{ shouldGenerate: true, prompt: '一朵小花', altText: '小花' }] } },
        { content: '第三条语音', mediaDecision: { audio: { shouldGenerate: true, text: '语音内容' } } },
      ],
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const speaker = buildCharacter('speaker', '潇潇', {
      voiceConfig: { voiceName: 'zh_female_cancan' },
    });
    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['speaker'] }),
      speaker,
      characters: [speaker],
      messages: [buildUserMessage('请分三条回复', 1)],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(message.messageParts).toHaveLength(3);
    expect(message.metadata?.runtimeDecision?.turnPlan?.actualBubbleCount).toBe(3);
    expect(message.metadata?.runtimeDecision?.turnPlan?.maxBubbleCount).toBe(1);
    expect(message.messageParts?.[1]?.metadata?.attachments?.[0]).toMatchObject({ kind: 'image', status: 'queued' });
    expect(message.messageParts?.[2]?.metadata?.attachments?.[0]).toMatchObject({ kind: 'audio', status: 'queued' });
  });

  it.each([1, 3, 6])('preserves %i model-selected sends even with a single-send plan', async (count) => {
    const contents = Array.from({ length: count }, (_, index) => `消息${index + 1}：内容独立`);
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: contents[0],
      messages: contents.map((content) => ({ content })),
    }));
    const speaker = buildCharacter('speaker', '潇潇');
    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['speaker'] }),
      speaker,
      characters: [speaker],
      messages: [buildUserMessage('嗯', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.messageParts?.map((part) => part.content)).toEqual(contents);
    expect(message.content).toBe(contents[0]);
    expect(message.metadata?.runtimeDecision?.turnPlan?.actualBubbleCount).toBe(count);
    expect(message.metadata?.runtimeDecision?.turnPlan?.maxBubbleCount).toBe(1);
  });

  it('preserves all legacy extra text when defensive overflow merges the tail', async () => {
    const extras = Array.from({ length: 10 }, (_, index) => `补充${index + 1}：独立内容`);
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({ content: '先说第一件', extraMessages: extras }));
    const speaker = buildCharacter('speaker', '潇潇');
    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['speaker'] }),
      speaker,
      characters: [speaker],
      messages: [buildUserMessage('嗯', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.extraMessages).toHaveLength(7);
    expect(message.extraMessages?.join('\n')).toBe(extras.join('\n'));
  });

  it('uses model-selected historical image refs for generated image attachments', () => {
    const parsed = parseInlineInteractionEnvelope(JSON.stringify({
      content: '我按上一张图重新做一个标题更大的版本。',
      mediaDecision: {
        image: {
          shouldGenerate: true,
          reason: '用户要求修改上一张图',
          prompt: 'Create a revised poster with a larger title while preserving the original layout',
          altText: '标题更大的海报版本',
          targetImageIds: ['message-image:image-1'],
          referenceImageIds: ['message-image:image-1'],
          styleImageIds: ['message-image:image-1'],
        },
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const metadata = __chatEngineTestUtils.buildMessageMetadata({
      decision: parsed?.mediaDecision,
      capabilities: { image: true, audio: false },
      content: parsed?.content || '',
      activeMessages: [{
        id: 'message-image',
        chatId: 'chat-1',
        type: 'ai',
        senderId: 'char-1',
        senderName: '美羊羊',
        content: '上一张海报',
        emotion: 0,
        timestamp: 1,
        isDeleted: false,
        metadata: {
          attachments: [{
            id: 'image-1',
            kind: 'image',
            status: 'ready',
            altText: '原始海报',
            promptText: 'Original pastel poster with small title',
            url: 'data:image/png;base64,POSTER',
            mimeType: 'image/png',
            createdAt: 1,
            updatedAt: 1,
          }],
        },
      }],
    });

    expect(metadata?.attachments?.[0]).toMatchObject({
      kind: 'image',
      targetImageIds: ['message-image:image-1'],
      referenceImageIds: ['message-image:image-1'],
      styleImageIds: ['message-image:image-1'],
      referenceImages: [{
        url: 'data:image/png;base64,POSTER',
        mimeType: 'image/png',
        label: '原始海报',
      }],
    });
  });

  it('normalizes singleton social event hints from model envelopes', () => {
    const parsed = parseInlineInteractionEnvelope(JSON.stringify({
      content: '这事别在这里说，回头我单独找你。',
      interactionHints: null,
      socialEventHints: {
        eventKind: 'pair_private_thread',
        participantIds: ['a', 'b'],
        targetIds: ['b'],
        confidence: 90,
        visibilityPlan: 'conversation_private',
      },
      conflictFocus: null,
    }));

    expect(parsed?.socialEventHints).toEqual([expect.objectContaining({
      eventKind: 'pair_private_thread',
      participantIds: ['a', 'b'],
      targetIds: ['b'],
      confidence: 0.9,
      visibilityPlan: 'conversation_private',
    })]);
  });

  it('rejects story narrativeBlocks as a legacy body and retries with storyEvents', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: '雨水从旧宅檐角连成一线。\n\n门缝里透出一截冷光。',
        narrativeBlocks: [
          { actorId: 'narrator', kind: 'prose', text: '雨水从旧宅檐角连成一线。' },
          { actorId: 'mei', actorName: '阿梅', kind: 'dialogue', text: '别靠太近。' },
          { actorId: 'narrator', kind: 'prose', text: '门缝里透出一截冷光。' },
        ],
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: [
          { type: 'narration', actorId: 'narrator', text: longStorySection('雨水从旧宅檐角连成一线。') },
          { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '别靠太近。' },
          { type: 'narration', actorId: 'narrator', text: '门缝里透出一截冷光。' },
        ],
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', sceneBeatCount: 0, choiceEpoch: 1, branches: [], chapterMemory: '阿梅在旧宅门口听见门内有脚步声。', stakes: ['暴露位置'] },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(generateResponseMock.mock.calls[1]?.[1]).toContain('old top-level body container');
    expect(generateResponseMock.mock.calls[1]?.[1]).not.toContain('legacy narrativeBlocks');
    expect(generateResponseMock.mock.calls[1]?.[1]).not.toContain('narrativeBlocks=null');
    expect(message.content).toBe('');
    expect(message.metadata?.narrativeTurn?.blocks).toEqual([
      expect.objectContaining({ actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: expect.stringContaining('雨水从旧宅檐角连成一线。') }),
      expect.objectContaining({ actorId: 'mei', actorName: '阿梅', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', text: '别靠太近。' }),
      expect.objectContaining({ actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: '门缝里透出一截冷光。' }),
    ]);
    expect(message.metadata?.contextText).toContain('别靠太近。');
  });

  it('commits storyEvents as blocks and choice metadata', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      narrativeText: null,
      storyEvents: [
        { type: 'narration', actorId: 'narrator', text: longStorySection('门锁轻轻弹开。') },
        { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '现在只能进去。' },
        { type: 'choice_point', choices: [
          { label: '让阿梅推门进入', prompt: '阿梅推门进入旧宅' },
          { label: '让阿梅先退回院子', prompt: '阿梅退回院子观察窗户' },
        ] },
      ],
      narrativeBlocks: null,
      content: '',
      extraMessages: null,
      storyChoices: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', sceneBeatCount: 3, choiceEpoch: 1, branches: [], chapterMemory: '阿梅在旧宅门口听见门内有脚步声。', stakes: ['暴露位置'] },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.content).toBe('');
    expect(message.metadata?.narrativeTurn?.blocks).toEqual([
      expect.objectContaining({ actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: expect.stringContaining('门锁轻轻弹开。') }),
      expect.objectContaining({ actorId: 'mei', actorName: '阿梅', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', text: '现在只能进去。' }),
      expect.objectContaining({ actorKind: 'system', kind: 'system_note', displayMode: 'system_panel', text: expect.stringContaining('新的抉择点') }),
    ]);
    expect(message.metadata?.narrativeTurn?.blocks.at(-1)?.text).toContain('当前压力已经形成，下一步会改变这一章的走向。');
    expect(message.metadata?.narrativeTurn?.blocks.at(-1)?.text).toContain('取舍：暴露位置');
    expect(message.metadata?.storyChoices).toEqual([
      { label: '让阿梅推门进入', prompt: '阿梅推门进入旧宅' },
      { label: '让阿梅先退回院子', prompt: '阿梅退回院子观察窗户' },
    ]);
  });

  it('retries a required decision beat when the model omits the choice point', async () => {
    generateResponseMock.mockReset();
    const section = longStorySection('门锁轻轻弹开。');
    const base = {
      narrativeText: null, narrativeBlocks: null, content: '', extraMessages: null,
      storyChoices: null, interactionHints: null, socialEventHints: null, conflictFocus: null,
    };
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({ ...base, storyEvents: [
        { type: 'narration', actorId: 'narrator', text: section },
      ] }))
      .mockResolvedValueOnce(JSON.stringify({ ...base, storyEvents: [
        { type: 'narration', actorId: 'narrator', text: section },
        { type: 'choice_point', choices: [
          { label: '阿梅推门进入', prompt: '阿梅推门进入旧宅' },
          { label: '阿梅退回院子', prompt: '阿梅退回院子观察窗户' },
        ] },
      ] }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');
    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'], mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', sceneBeatCount: 3, choiceEpoch: 1, branches: [], chapterMemory: '阿梅听见门内脚步声。', stakes: ['暴露位置'] },
      }),
      speaker: narrator, characters: [narrator, mei], messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(generateResponseMock.mock.calls[1]?.[1]).toContain('requires storyEvents.choice_point');
    expect(message.metadata?.storyChoices).toHaveLength(2);
  });

  it('matches story event speech actors by actorName', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      narrativeText: null,
      storyEvents: [
        { type: 'narration', actorId: 'narrator', text: longStorySection('门轴上的水珠落了下来。') },
        { type: 'speech', actorName: '阿梅', text: '别碰那盏灯。' },
      ],
      narrativeBlocks: null,
      content: '',
      extraMessages: null,
      storyChoices: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.metadata?.narrativeTurn?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'mei', actorName: '阿梅', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', text: '别碰那盏灯。' }),
    ]));
  });

  it('matches story dialogue actors by name without leaking unknown actor diagnostics in normal mode', async () => {
    generateResponseMock.mockReset();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateResponseMock.mockResolvedValue(JSON.stringify({
      narrativeText: null,
      storyEvents: [
        { type: 'narration', actorId: 'narrator', text: longStorySection('门轴上的水珠落了下来。') },
        { type: 'speech', actorId: '阿梅', text: '别碰那盏灯。' },
        { type: 'speech', actorId: 'ghost', actorName: '幽灵角色', text: '我也拿着她手里的当归。' },
      ],
      narrativeBlocks: null,
      content: '',
      extraMessages: null,
      storyChoices: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.metadata?.narrativeTurn?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'mei', actorName: '阿梅', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', text: '别碰那盏灯。' }),
      expect.objectContaining({ actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: '我也拿着她手里的当归。' }),
    ]));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs unknown story dialogue actors only in developer mode', async () => {
    generateResponseMock.mockReset();
    useSettingsStore.setState({ developerMode: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    generateResponseMock.mockResolvedValue(JSON.stringify({
      narrativeText: null,
      storyEvents: [
        { type: 'narration', actorId: 'narrator', text: longStorySection('门轴上的水珠落了下来。') },
        { type: 'speech', actorId: 'ghost', actorName: '幽灵角色', text: '我也拿着她手里的当归。' },
      ],
      narrativeBlocks: null,
      content: '',
      extraMessages: null,
      storyChoices: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');

    await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(warnSpy).toHaveBeenCalledWith('[story-reader] Unknown narrative dialogue actor; downgraded to narrator prose.', expect.objectContaining({ actorId: 'ghost', actorName: '幽灵角色' }));
    debugSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('projects storyEvent speech with actor names as character bubbles', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      narrativeText: null,
      storyEvents: [
        { type: 'narration', actorId: 'narrator', text: longStorySection('门轴上的水珠落了下来。') },
        { type: 'speech', actorName: '江采薇', text: '皇后娘娘说的是……奴婢在针线房学过几年绣活。' },
      ],
      narrativeBlocks: null,
      content: '',
      extraMessages: null,
      storyChoices: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const narrator = buildCharacter('narrator', '旁白');
    const caiwei = buildCharacter('caiwei', '江采薇', { group: '宫女' });

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'caiwei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator, caiwei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.metadata?.narrativeTurn?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'caiwei', actorName: '江采薇', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', text: '皇后娘娘说的是……奴婢在针线房学过几年绣活。' }),
    ]));
  });

  it('treats narrator dialogue blocks as prose without unknown actor warnings', async () => {
    generateResponseMock.mockReset();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateResponseMock.mockResolvedValue(JSON.stringify({
      narrativeText: null,
      storyEvents: [
        { type: 'speech', actorId: '旁白', text: longStorySection('门后的风忽然停了。') },
      ],
      narrativeBlocks: null,
      content: '',
      extraMessages: null,
      storyChoices: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(message.metadata?.narrativeTurn?.blocks).toEqual([
      expect.objectContaining({ actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: expect.stringContaining('门后的风忽然停了。') }),
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rejects story narrativeText instead of committing it as body text', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: '走廊尽头的灯忽明忽暗，潮湿墙面渗出旧照片一样的阴影。',
        storyEvents: null,
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: [
          { type: 'narration', actorId: 'narrator', text: longStorySection('走廊尽头的灯忽明忽暗，潮湿墙面渗出旧照片一样的阴影。') },
        ],
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const narrator = buildCharacter('narrator', '旁白');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(generateResponseMock.mock.calls[1]?.[1]).toContain('old top-level body container');
    expect(generateResponseMock.mock.calls[1]?.[1]).not.toContain('narrativeText');
    expect(generateResponseMock.mock.calls[1]?.[1]).not.toContain('legacy narrativeBlocks');
    expect(message.content).toBe('');
    expect(message.extraMessages).toBeNull();
    expect(message.metadata?.narrativeTurn?.blocks[0]?.text).toContain('走廊尽头的灯忽明忽暗，潮湿墙面渗出旧照片一样的阴影。');
    expect(message.metadata?.contextText).toContain('走廊尽头的灯忽明忽暗');
  });

  it('retries internally repetitive storyEvents without feeding the rejected draft back into the prompt', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: [
          {
            type: 'narration',
            actorId: 'narrator',
            text: '沈清婉没有立刻接话，只把铜钱推到烛火边缘。月奴的目光从铜钱上移开，落在自己裙摆上那道白色粉末痕迹上。月奴的目光从铜钱上移开，落在自己裙摆上那道白色粉末痕迹上，像是又把半截话咽了回去。',
          },
        ],
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: [
          { type: 'narration', actorId: 'narrator', text: longStorySection('沈清婉把梳子放回妆台，屋里安静得只剩烛芯轻响。') },
          { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '别靠太近。' },
        ],
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');
    const previousBeat: Message = {
      id: 'prev-story-repetition',
      chatId: 'chat-1',
      type: 'ai',
      senderId: 'narrator',
      senderName: '旁白',
      content: '',
      emotion: 0,
      timestamp: 2,
      isDeleted: false,
      metadata: {
        narrativeTurn: {
          turnId: 'turn-prev-repetition',
          turnKind: 'narrative_beat',
          sceneId: 'main',
          phase: 'scene',
          povActorId: 'narrator',
          blocks: [
            {
              id: 'p1',
              actorId: 'narrator',
              actorKind: 'narrator',
              kind: 'prose',
              displayMode: 'paragraph',
              text: '月奴说完这句话，终于抬起眼看向沈清婉。',
            },
            {
              id: 's1',
              actorId: 'mei',
              actorKind: 'character',
              kind: 'dialogue',
              displayMode: 'bubble',
              characterId: 'mei',
              text: '奴婢认得那道刻痕。',
            },
          ],
        },
      },
    };

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'branch', choiceEpoch: 2, branches: [], selectedChoice: { branchId: 'b1', label: '追问月奴', prompt: '追问月奴' }, selectedChoiceEpoch: 2 },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('我选择：追问月奴', 1), previousBeat],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    const retryPrompt = String(generateResponseMock.mock.calls[1]?.[1] || '');
    expect(retryPrompt).toContain('Story continuity retry');
    expect(retryPrompt).toContain('repeats_internal_story_beat');
    expect(retryPrompt).not.toContain('Rejected draft:');
    expect(retryPrompt).not.toContain('Previous visible beat ended at');
    expect(retryPrompt).not.toContain('月奴说完这句话');
    expect(retryPrompt).not.toContain('奴婢认得那道刻痕');
    expect(retryPrompt).not.toContain('白色粉末痕迹');
    expect(message.metadata?.narrativeTurn?.blocks).toEqual([
      expect.objectContaining({ actorKind: 'narrator', displayMode: 'paragraph', text: expect.stringContaining('沈清婉把梳子放回妆台，屋里安静得只剩烛芯轻响。') }),
      expect.objectContaining({ actorId: 'mei', actorName: '阿梅', displayMode: 'bubble', text: '别靠太近。' }),
    ]);
  });

  it('accepts a short story exchange without padding to a character quota', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: [
          { type: 'narration', actorId: 'narrator', text: '门锁响了一下。' },
          { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '有人在里面。' },
        ],
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: [
          { type: 'narration', actorId: 'narrator', text: longStorySection('门锁响了一下。') },
          { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '有人在里面。' },
        ],
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(message.metadata?.runtimeDecision?.innerLife).toBeUndefined();
    expect(message.metadata?.narrativeTurn?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorKind: 'narrator', displayMode: 'paragraph', text: expect.stringContaining('门锁响了一下。') }),
      expect.objectContaining({ actorId: 'mei', actorName: '阿梅', displayMode: 'bubble', text: '有人在里面。' }),
    ]));
  });

  it('accepts a longer story section when every event advances the same committed beat', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValueOnce(JSON.stringify({
      narrativeText: null,
      storyEvents: [
        { type: 'narration', actorId: 'narrator', text: longStorySection('侯府东侧偏门半掩着，湿冷灯影照出一把新换的铜锁；锁舌边缘没有旧划痕，说明有人刚刚改过出入口。') },
        { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '这把锁不是府里的旧物，钥匙孔还没磨出痕。' },
        { type: 'narration', actorId: 'narrator', text: '门槛下的泥点被雨水泡开，泥里混着细碎香灰，颜色却和祠堂后窗那一带的灰土完全不同。' },
        { type: 'narration', actorId: 'narrator', text: '巡夜声从远处压近，阿梅立刻收起灯笼，改用手背去试门缝里透出的温度。' },
        { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '里面刚点过火，屋里的人没走多久。' },
        { type: 'narration', actorId: 'narrator', text: '门后的木案被拖动过，地上留下两道浅痕，一道朝内，一道朝井边，像有人临时改了搬运方向。' },
        { type: 'narration', actorId: 'narrator', text: '窗纸内侧有一枚半干的指印，指腹纹路被药粉糊住，只剩掌根的压痕，斜斜按在窗棂边。' },
        { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '他不是从窗子逃的，是从窗子递了东西出去。' },
        { type: 'narration', actorId: 'narrator', text: '后院井绳轻轻晃动，水桶却停在井台外，绳尾沾着一截红线，和先前断在袖口的颜色相同。' },
        { type: 'narration', actorId: 'narrator', text: '阿梅把红线收进帕子，没有立刻追出去，因为墙外已经响起第二个人压低的咳声。' },
        { type: 'speech', actorId: 'mei', actorName: '阿梅', text: '有两个人，一个在屋里灭证，一个在墙外接应。' },
        { type: 'narration', actorId: 'narrator', text: '她退回门前，故意敲响铜环，让屋里的人以为自己还没发现井边红线。这个假动作给她争取到半息时间，也把门内门外两个人同时逼到必须回应的位置。屋内的人先沉不住气，木栓轻轻一跳；墙外那声咳嗽也戛然而止。阿梅没有立刻闯门，只把红线藏进袖中，等两边都以为她还在犹豫时，才把真正的退路锁死。' },
      ],
      narrativeBlocks: null,
      content: '',
      extraMessages: null,
      storyChoices: null,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const narrator = buildCharacter('narrator', '旁白');
    const mei = buildCharacter('mei', '阿梅');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator', 'mei'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator, mei],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(message.metadata?.narrativeTurn?.blocks).toHaveLength(12);
  });

  it('rejects story-reader JSON that puts visible story only in content', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: null,
        narrativeBlocks: null,
        content: '门里传来脚步声。',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: [
          { type: 'narration', actorId: 'narrator', text: longStorySection('门里传来脚步声。') },
        ],
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const narrator = buildCharacter('narrator', '旁白');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(message.content).toBe('');
    expect(message.metadata?.narrativeTurn?.blocks).toEqual([
      expect.objectContaining({ actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: expect.stringContaining('门里传来脚步声。') }),
    ]);
  });

  it('retries plain story text instead of committing it as a fallback bubble', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce('雨滴砸在青石阶上，门内传来一声很轻的咳嗽。')
      .mockResolvedValueOnce(JSON.stringify({
        narrativeText: null,
        storyEvents: [
          { type: 'narration', actorId: 'narrator', text: longStorySection('雨滴砸在青石阶上。') },
        ],
        narrativeBlocks: null,
        content: '',
        extraMessages: null,
        storyChoices: null,
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const narrator = buildCharacter('narrator', '旁白');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        memberIds: ['narrator'],
        mode: 'scripted_play',
        sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
        scenarioState: { phase: 'scene', choiceEpoch: 1, branches: [] },
      }),
      speaker: narrator,
      characters: [narrator],
      messages: [buildUserMessage('继续推进', 1)],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    const retryPrompt = String(generateResponseMock.mock.calls[1]?.[1] || '');
    expect(retryPrompt).toContain('Story protocol retry');
    expect(retryPrompt).toContain('old top-level body container');
    expect(retryPrompt).not.toContain('legacy narrativeBlocks');
    expect(message.content).toBe('');
    expect(message.metadata?.narrativeTurn?.blocks).toEqual([
      expect.objectContaining({ actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: expect.stringContaining('雨滴砸在青石阶上。') }),
    ]);
  });

  it('preserves narrative turn metadata without media decisions', () => {
    const metadata = __chatEngineTestUtils.buildMessageMetadata({
      decision: null,
      capabilities: { image: false, audio: false },
      content: '雨落在旧宅门前。',
      narrativeTurn: {
        turnId: 'turn-1',
        turnKind: 'narrative_beat',
        sceneId: 'main',
        povActorId: 'narrator',
        blocks: [{ id: 'block-1', actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: '雨落在旧宅门前。' }],
      },
    });

    expect(metadata?.narrativeTurn?.blocks[0]).toMatchObject({
      actorKind: 'narrator',
      kind: 'prose',
      displayMode: 'paragraph',
      text: '雨落在旧宅门前。',
    });
  });

  it('builds deterministic attachment ids when metadata now is fixed', () => {
    const decision = {
      image: {
        shouldGenerate: true,
        reason: '用户明确想看图片',
        prompt: 'A cute WeChat-style photo of mango pomelo sago dessert on a table',
        altText: '一杯杨枝甘露甜品',
      },
    };
    const first = __chatEngineTestUtils.buildMessageMetadata({
      decision,
      capabilities: { image: true, audio: false },
      content: '来啦，你看这杯杨枝甘露。',
      now: 1777000000000,
    });
    const second = __chatEngineTestUtils.buildMessageMetadata({
      decision,
      capabilities: { image: true, audio: false },
      content: '来啦，你看这杯杨枝甘露。',
      now: 1777000000000,
    });
    expect(first?.attachments?.[0]?.id).toBe(second?.attachments?.[0]?.id);
  });

  it('keeps all distinct images with an optional audio attachment for entitlement validation', () => {
    const images = Array.from({ length: 10 }, (_, index) => ({
      shouldGenerate: true,
      prompt: `food photo ${index + 1}`,
      altText: `第 ${index + 1} 张红烧肉照片`,
    }));
    const metadata = __chatEngineTestUtils.buildMessageMetadata({
      decision: {
        images,
        audio: { shouldGenerate: true, text: '今天的红烧肉外焦里嫩，酱汁也收得刚好。' },
      },
      capabilities: { image: true, audio: true },
      content: '我先用语音说，照片也给你发过来。',
      now: 1777000000000,
    });

    expect(metadata?.attachments?.filter((attachment) => attachment.kind === 'image')).toHaveLength(10);
    expect(metadata?.attachments?.find((attachment) => attachment.kind === 'audio')).toMatchObject({
      status: 'queued',
      promptText: '今天的红烧肉外焦里嫩，酱汁也收得刚好。',
    });
  });

  it.skip('legacy local media fallback is retired; the model must return mediaDecision', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '来啦，我把灰太狼先生的证件照画得超精神～',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊', {
      visualIdentity: { description: '粉白色小羊，温柔爱画画', styleHint: '柔和童话插画' },
    });
    const hui = buildCharacter('hui', '灰太狼', {
      background: '灰太狼，经典狼族角色，戴黄色补丁帽，脸部有胡须和自信表情。',
      visualIdentity: { description: '灰色狼，黄色补丁帽，两撇胡子，表情夸张' },
    });

    const message = await generateSpeakerMessage({
      chat: buildChat(),
      speaker: mei,
      characters: [mei, hui],
      messages: [{
        id: 'guide',
        chatId: 'chat-1',
        type: 'god',
        senderId: 'user',
        senderName: '开发者',
        content: '美羊羊发个灰太狼证件照的图片',
        emotion: 0,
        timestamp: 10,
        isDeleted: false,
      }],
      apiConfig: buildProfiles(),
      directorIntent: buildMediaDirectorIntent(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(message.content).toBe('来啦，我把灰太狼先生的证件照画得超精神～');
    expect(message.metadata?.generationDecision?.image).toMatchObject({
      shouldGenerate: true,
      reason: '用户明确要求这个角色发送或创作图片。',
      altText: '美羊羊发来的灰太狼图片',
      referenceCharacterIds: ['hui'],
    });
    expect(message.metadata?.attachments).toHaveLength(1);
    expect(message.metadata?.attachments?.[0]).toMatchObject({
      kind: 'image',
      status: 'queued',
      altText: '美羊羊发来的灰太狼图片',
      referenceCharacterIds: ['hui'],
    });
    expect(message.metadata?.attachments?.[0]?.promptText).toContain('美羊羊发个灰太狼证件照的图片');
    expect(message.metadata?.attachments?.[0]?.promptText).toContain('灰太狼');
    expect(message.metadata?.runtimeDecision?.guidanceExecution).toMatchObject({
      status: 'accepted',
      validated: true,
      retryCount: 0,
      rejectedDraftCount: 0,
      finalReason: 'matched',
      forcedMediaQueued: true,
    });
  });

  it('drops extra messages already included in the streamed content to avoid duplicate bubbles', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '等下\n你刚说谁来着？',
      extraMessages: ['你刚说谁来着？'],
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');

    const message = await generateSpeakerMessage({
      chat: buildChat(),
      speaker: mei,
      characters: [mei, hui],
      messages: [],
      apiConfig: buildProfiles(),
    });

    expect(message.content).toBe('等下\n你刚说谁来着？');
    expect(message.extraMessages ?? null).toBeNull();
  });

  it('keeps multiline chat available while ordinary group mode uses the unified directive', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '（轻叹一声，目光落向窗外竹影）\n\n热闹自有热闹的好，冷清也有冷清的趣。\n\n（转回视线，语气淡了几分）你且去别处热闹罢。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const dai = buildCharacter('dai', '林黛玉');
    const lu = buildCharacter('lu', '鲁智深');

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['dai', 'lu'] }),
      speaker: dai,
      characters: [dai, lu],
      messages: [
        buildAiMessage('dai', '林黛玉', '（轻轻摇头）\n\n你且去菜园子里施展你的威风罢。\n\n（转身欲走）', 1),
        buildAiMessage('lu', '鲁智深', '那俺去菜园子里吼两嗓子。', 2),
        buildAiMessage('dai', '林黛玉', '（转身欲走，又停住脚步）\n\n你且去罢。\n\n（回头淡淡一笑）', 3),
      ],
      apiConfig: buildProfiles(),
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(prompt).toContain('## Turn Directive');
    expect(prompt).toContain('the exchange decides the shape');
    expect(prompt).not.toContain('## Turn Format Variety');
    expect(message.content).toBe('（轻叹一声，目光落向窗外竹影）\n\n热闹自有热闹的好，冷清也有冷清的趣。\n\n（转回视线，语气淡了几分）你且去别处热闹罢。');
  });

  it('keeps ordinary user turns in transcript instead of elevating them into system-level guidance', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '那我直接说安排：八点到，锅底和蘸料分开带，谁迟到谁洗碗。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');

    const message = await generateSpeakerMessage({
      chat: buildChat(),
      speaker: mei,
      characters: [mei, hui],
      messages: [
        buildUserMessage('你们换一种接法，别再只换开头继续同一个套路。', 1),
        buildAiMessage('hui', '灰太狼', '那我也继续安排一下，八点羊肉火锅我来掌勺。', 2),
      ],
      apiConfig: buildProfiles(),
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    const chatMessages = generateResponseMock.mock.calls[0]?.[2] as Array<{ role: string; content: string }>;
    expect(prompt).not.toContain('## Latest Human Turn Context');
    expect(prompt).not.toContain('你们换一种接法，别再只换开头继续同一个套路。');
    expect(chatMessages.some((item) => item.content === '用户: 你们换一种接法，别再只换开头继续同一个套路。')).toBe(true);
    expect((message.metadata?.runtimeDecision as Record<string, unknown> | undefined)?.latestHumanTurn).toBeUndefined();
  });

  it('preserves natural extra bubbles even when the turn plan leans toward one bubble', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '一',
      extraMessages: ['二', '三'],
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');

    const message = await generateSpeakerMessage({
      chat: buildChat(),
      speaker: mei,
      characters: [mei, hui],
      messages: [],
      apiConfig: buildProfiles(),
    });

    expect(message.content).toBe('一');
    expect(message.extraMessages).toEqual(['二', '三']);
  });

  it.each(['group', 'direct', 'ai_direct'] as const)('keeps DeepSeek protocol outside the %s transcript and preserves separate sends', async (type) => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      messages: [{ content: '嗯？' }, { content: '刚才不是还说不去吗。' }],
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const a = buildCharacter('a', '甲');
    const b = buildCharacter('b', '乙');
    const profiles: AIModelProfile[] = [{
      id: 'deepseek-text', name: 'DeepSeek', type: 'text', provider: 'deepseek',
      apiKey: 'test-key', baseUrl: 'https://api.deepseek.test', model: 'deepseek-chat', isDefault: true,
    }];
    const message = await generateSpeakerMessage({
      chat: buildChat({ type, memberIds: type === 'direct' ? ['a'] : ['a', 'b'] }),
      speaker: a,
      characters: [a, b],
      messages: [type === 'direct'
        ? buildUserMessage('我改主意了，一起去吧。', 1)
        : buildAiMessage('b', '乙', '我改主意了，一起去吧。', 1)],
      apiConfig: profiles,
    });
    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(generateResponseMock.mock.calls[0]?.[1]).toContain('格式校验');
    expect(generateResponseMock.mock.calls[0]?.[2]?.at(-1)?.content).toContain('我改主意了，一起去吧。');
    expect(generateResponseMock.mock.calls[0]?.[2]?.some((item) => item.content.includes('格式校验'))).toBe(false);
    expect(message.content).toBe('嗯？');
    expect(message.messageParts?.map((part) => part.content)).toEqual(['嗯？', '刚才不是还说不去吗。']);
    expect(message.metadata?.runtimeDecision?.turnPlan?.actualBubbleCount).toBe(2);
  });

  it('retries a draft that exactly repeats a recent room line', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValueOnce(JSON.stringify({
      content: '行行行，你俩一唱一和的，我投降。那件夹克改好了记得喊我去捡漏，二手还能省一笔呢～',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    })).mockResolvedValueOnce(JSON.stringify({
      content: '那我换个说法：夹克改完先别急着下手，叫我过去看一眼，能省就省。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat(),
      speaker: mei,
      characters: [mei, hui],
      messages: [
        buildAiMessage('hui', '灰太狼', '行行行，你俩一唱一和的，我投降。那件夹克改好了记得喊我去捡漏，二手还能省一笔呢～'),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'surface_echo_retry',
      speakerId: 'mei',
      speakerName: '美羊羊',
      draft: expect.stringContaining('捡漏'),
      reason: expect.stringContaining('exactly repeats'),
      attempt: 1,
    }));
    expect(message.content).toContain('换个说法');
  });

  it('skips exact room-line repeats after retry budget is exhausted', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '财富伦理师，你这句话其实比我之前那个功能模块的拆解更狠。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('analyst', '心理学家', { expertise: ['心理学'] });
    const ethicist = buildCharacter('ethicist', '财富伦理师', { expertise: ['伦理'] });
    const onLocalInterception = vi.fn();

    await expect(generateSpeakerMessage({
      chat: buildChat({ mode: 'group_discussion', memberIds: ['analyst', 'ethicist'] }),
      speaker: analyst,
      characters: [analyst, ethicist],
      messages: [
        buildAiMessage('ethicist', '财富伦理师', '财富伦理师，你这句话其实比我之前那个功能模块的拆解更狠。', 1),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    })).rejects.toMatchObject({ name: 'EmptyGeneratedResponseError', reason: 'duplicate_content' });

    expect(generateResponseMock).toHaveBeenCalledTimes(3);
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'surface_echo_retry',
      reason: expect.stringContaining('exactly repeats'),
      attempt: 1,
    }));
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'surface_echo_skip',
      reason: expect.stringContaining('exactly repeats'),
      attempt: 3,
    }));
  });

  it('requests strict JSON for analysis rooms so deliberation artifacts are stable', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我先把边界说清楚：低成本合租只在公共资源冲突可预期时成立，反例是作息完全相反的人共用厨房。',
      deliberationArtifacts: {
        claims: [{ text: '低成本合租需要公共资源冲突可预期', stance: 'review', reason: '直接提出成立条件', confidence: 0.86 }],
        issues: [{ text: '作息相反且共用厨房会破坏低成本边界', targetActorId: null, reason: '给出需要回应的边界反例', confidence: 0.8 }],
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('analyst', '心理学家', { expertise: ['心理学'] });
    const ethicist = buildCharacter('ethicist', '财富伦理师', { expertise: ['伦理'] });

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'ethicist'],
      }),
      speaker: analyst,
      characters: [analyst, ethicist],
      messages: [
        buildAiMessage('ethicist', '财富伦理师', '按需热闹听起来不错，但边界怎么保证？', 1),
      ],
      apiConfig: buildProfiles(),
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(generateResponseMock.mock.calls[0]?.[4]).toEqual(expect.objectContaining({ responseFormat: 'json' }));
    expect(prompt).toContain('## Prompt Play Mode');
    expect(prompt).toContain('Mode: analysis_room');
    expect(prompt).toContain('Analysis rooms are not ordinary group chat');
    expect(prompt).toContain('## Analysis Room Contract');
    expect(prompt).toContain('Visible content must do exactly one deliberative job');
    expect(message.metadata?.deliberationArtifacts?.claims?.[0]?.text).toContain('低成本合租');
    expect(message.metadata?.deliberationArtifacts?.issues?.[0]?.text).toContain('作息');
  });

  it('uses compact analysis prompt instead of companionship-heavy group chat prompt', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我先拆一个前提：愿意费心不是常量，工作负荷会直接改变它能不能被执行。',
      deliberationArtifacts: {
        claims: [{ text: '工作负荷会改变愿意费心能否执行', stance: 'review', reason: '可见回复提出变量关系', confidence: 0.84 }],
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('analyst', '宠物猫舍主理人', {
      background: '在家养了五只猫的猫舍老板，擅长处理宠物与合租的矛盾。',
      speakingStyle: '温柔又带点行业老手的爽利。',
      expertise: ['猫行为学'],
      coreProfile: {
        coreDesire: '希望自己的身份和经历能在互动中被理解和承认。',
        socialMask: '习惯用玩笑和轻松语气遮住真实在意。',
      },
      memory: {
        shortTermSummary: '用户最近在调试审议房间。',
        longTerm: ['曾经和用户讨论过陪伴感。'],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户希望被持续关心。'],
      },
      layeredMemories: [{
        id: 'm1',
        scope: 'character_self',
        kind: 'bias',
        layer: 'long_term',
        ownerId: 'analyst',
        text: '倾向用轻松感维持关系张力',
        salience: 0.7,
        confidence: 0.8,
        recency: 0.5,
        reinforcementCount: 1,
        sourceEventIds: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const designer = buildCharacter('designer', '刚毕业的设计师');

    await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'designer'],
        runtimeEventsV2: [{
          id: 'event-1',
          conversationId: 'chat-1',
          kind: 'decision_trace',
          summary: 'companionship trace should not enter analysis prompt',
          actorIds: ['analyst'],
          payload: { eventType: 'companionship_check_in', characterId: 'analyst' },
          createdAt: 1,
        }],
      }),
      speaker: analyst,
      characters: [analyst, designer],
      messages: [
        buildAiMessage('designer', '刚毕业的设计师', '社会还生产多少愿意费心的人？', 1),
      ],
      apiConfig: buildProfiles(),
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(prompt).toContain('This is a structured analysis room');
    expect(prompt).toContain('## Analysis Speaker Rules');
    expect(prompt).toContain('You are a person with stakes in this decision');
    expect(prompt).toContain('Room topic:');
    expect(prompt).toContain('宠物与合租');
    expect(prompt).toContain('Character memory: 倾向用轻松感维持关系张力');
    expect(prompt).not.toContain('This is a public multi-party room');
    expect(prompt).not.toContain('## Deeper Motivation');
    expect(prompt).not.toContain('## Channel Bias');
    expect(prompt).not.toContain('## Reasoning Bias');
    expect(prompt).not.toContain('## Companionship Context');
    expect(prompt).toContain('## Inner Life');
  });

  it('retries deliberative analysis replies that omit deliberation artifacts', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        content: '我先给一个阶段判断：半公共空间比传统合租更现实，但它成立的关键不是装修，而是谁持续承担运营成本。',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: '我先给一个阶段判断：半公共空间比传统合租更现实，但它成立的关键不是装修，而是谁持续承担运营成本。',
        deliberationArtifacts: {
          verdicts: [{ text: '半公共空间比传统合租更现实', tendency: 'mixed', reason: '可见回复给出阶段判断', confidence: 0.82 }],
          issues: [{ text: '谁持续承担运营成本', targetActorId: null, reason: '可见回复指出成立条件仍待回答', confidence: 0.8 }],
        },
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const analyst = buildCharacter('analyst', '资深北漂程序员');
    const landlord = buildCharacter('landlord', '房东大姐');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'landlord'],
      }),
      speaker: analyst,
      characters: [analyst, landlord],
      messages: [
        buildAiMessage('landlord', '房东大姐', '这种半耦合热闹真有人愿意多掏钱吗？', 1),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(String(generateResponseMock.mock.calls[1]?.[1] || '')).toContain('Deliberation Artifact Retry');
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'analysis_artifacts_missing',
      reason: '本轮回复做了审议动作，但模型没有返回结构化审议产物。',
    }));
    expect(message.content).toContain('半公共空间');
    expect(message.metadata?.deliberationArtifacts?.verdicts?.[0]?.text).toContain('半公共空间');
  });

  it('keeps analysis replies even when deliberation artifacts are absent', async () => {
    generateResponseMock.mockReset();
    const onChunk = vi.fn();
    generateResponseMock.mockImplementation(async (_api, _prompt, _messages, onRawChunk?: (chunk: string) => void) => {
      onRawChunk?.('{"content":"第一稿缺少结构化产物，但现在应该保留。"');
      return JSON.stringify({
        content: '第一稿缺少结构化产物，但现在应该保留。',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      });
    });
    const analyst = buildCharacter('analyst', '资深北漂程序员');
    const designer = buildCharacter('designer', '刚毕业的设计师');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'designer'],
      }),
      speaker: analyst,
      characters: [analyst, designer],
      messages: [
        buildAiMessage('designer', '刚毕业的设计师', '社会还生产多少愿意费心的人？', 1),
      ],
      apiConfig: buildProfiles(),
      onChunk,
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(3);
    expect(generateResponseMock.mock.calls[0]?.[3]).toBeUndefined();
    expect(onChunk).toHaveBeenCalled();
    expect(message.content).toContain('第一稿缺少结构化产物');
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'analysis_artifacts_missing',
    }));
  });

  it('does not force json_object response format for DeepSeek analysis rooms', async () => {
    generateResponseMock.mockReset();
    const onChunk = vi.fn();
    generateResponseMock.mockImplementationOnce(async (_api, _prompt, _messages, onRawChunk?: (chunk: string) => void) => {
      onRawChunk?.('{"content":"这个反例要拆成资源压力和意愿压力两层。","deliberationArtifacts":{"claims":[{"text":"资源压力会削弱合租中的主动照顾","reason":"可见回复提出可审议判断","confidence":0.82}]}}');
      return JSON.stringify({
        content: '这个反例要拆成资源压力和意愿压力两层。',
        deliberationArtifacts: {
          claims: [{ text: '资源压力会削弱合租中的主动照顾', reason: '可见回复提出可审议判断', confidence: 0.82 }],
        },
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      });
    });
    const analyst = buildCharacter('analyst', '资深北漂程序员');
    const designer = buildCharacter('designer', '刚毕业的设计师');
    const onLocalInterception = vi.fn();
    const deepseekProfiles: AIModelProfile[] = [{
      id: 'deepseek-text',
      name: 'DeepSeek',
      type: 'text',
      provider: 'deepseek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-chat',
      isDefault: true,
    }];

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'designer'],
      }),
      speaker: analyst,
      characters: [analyst, designer],
      messages: [
        buildAiMessage('designer', '刚毕业的设计师', '经济压力会不会让愿意费心的人也没电？', 1),
      ],
      apiConfig: deepseekProfiles,
      onChunk,
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(generateResponseMock.mock.calls[0]?.[3]).toEqual(expect.any(Function));
    expect(generateResponseMock.mock.calls[0]?.[4]).toMatchObject({ responseFormat: 'text' });
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('格式校验');
    expect(generateResponseMock.mock.calls[0]?.[2]?.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('经济压力会不会让愿意费心的人也没电？'),
    });
    expect(generateResponseMock.mock.calls[0]?.[2]?.some((item) => item.content.includes('格式校验'))).toBe(false);
    expect(onChunk).toHaveBeenCalled();
    expect(message.metadata?.deliberationArtifacts?.claims?.[0]?.text).toBe('资源压力会削弱合租中的主动照顾');
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'analysis_artifacts_present',
      reason: expect.stringContaining('本轮回复返回了结构化审议产物：主张 1、证据 0、质询 0、裁决 0、总结 0'),
    }));
  });

  it('commits streamed visible draft when final provider response is blank', async () => {
    generateResponseMock.mockReset();
    const onChunk = vi.fn();
    const onLocalInterception = vi.fn();
    let blankAttempt = true;
    generateResponseMock.mockImplementation(async (_api, _prompt, _messages, onRawChunk?: (chunk: string) => void) => {
      if (blankAttempt) {
        blankAttempt = false;
        onRawChunk?.('{"content":"设计师这个区分可以继续拆：被动热闹依赖低警惕边界，主动连接依赖明确邀请。","deliberationArtifacts":{"claims":[{"text":"主动连接依赖明确邀请","reason":"拆分审议判断","confidence":0.7}]}}');
        return '          ';
      }
      return JSON.stringify({
        content: '设计师这个区分可以继续拆：被动热闹依赖低警惕边界，主动连接依赖明确邀请。',
        deliberationArtifacts: { claims: [{ text: '主动连接依赖明确邀请', reason: '拆分审议判断', confidence: 0.7 }] },
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      });
    });
    const analyst = buildCharacter('analyst', '资深北漂程序员');
    const designer = buildCharacter('designer', '刚毕业的设计师');
    const deepseekFlashProfiles: AIModelProfile[] = [{
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      type: 'text',
      provider: 'deepseek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-v4-flash',
      advancedOptions: { reasoningMode: 'disabled' },
      isDefault: true,
    }];

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'designer'],
      }),
      speaker: analyst,
      characters: [analyst, designer],
      messages: [
        buildAiMessage('designer', '刚毕业的设计师', '这两种热闹的价值不一样，我们是不是先把它们分开谈？', 1),
      ],
      apiConfig: deepseekFlashProfiles,
      onChunk,
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(generateResponseMock.mock.calls[0]?.[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      advancedOptions: { reasoningMode: 'disabled' },
    });
    expect(onChunk).toHaveBeenCalledWith(expect.stringContaining('被动热闹依赖低警惕边界'));
    expect(message.content).toContain('被动热闹依赖低警惕边界');
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'streamed_draft_committed',
      reason: '最终结构化正文为空，但流式阶段已经产生可见内容；已保留并提交这段流式草稿。',
    }));
    expect(onLocalInterception).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'empty_generation_skip',
    }));
  });

  it('keeps explicit leaving replies that omit presence metadata and reports the missing state marker', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValueOnce(JSON.stringify({
      content: '这个点我先放这儿：样本偏差需要单独看租客视角。我真走了，再不走赶不上二路汽车。',
      deliberationArtifacts: {
        issues: [{ text: '样本偏差需要单独看租客视角', reason: '可见回复提出待检验视角', confidence: 0.8 }],
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const landlord = buildCharacter('landlord', '房东大姐');
    const analyst = buildCharacter('analyst', '资深北漂程序员');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['landlord', 'analyst'],
      }),
      speaker: landlord,
      characters: [landlord, analyst],
      messages: [
        buildAiMessage('analyst', '资深北漂程序员', '房东样本里可能有幸存者偏差。', 1),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(onLocalInterception).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'presence_metadata_missing',
      reason: '可见回复表示离开、睡觉或忙碌，但模型没有返回下线状态标记；消息已保留，角色在线状态不变。',
    }));
    expect(message.content).toContain('我真走了');
    expect(message.metadata?.presenceUpdate).toBeFalsy();
  });

  it('does not treat ordinary topic words like shower schedule as leaving intent', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValueOnce(JSON.stringify({
      content: '长期住得舒服的合租，常常只是互相知道对方几点洗澡、冰箱哪一层归谁，这不是离开房间，而是边界默契。',
      deliberationArtifacts: {
        claims: [{ text: '长期合租依赖边界默契', reason: '可见回复提出稳定条件', confidence: 0.8 }],
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('analyst', '宠物猫舍主理人');
    const designer = buildCharacter('designer', '刚毕业的设计师');
    const onLocalInterception = vi.fn();

    await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'designer'],
      }),
      speaker: analyst,
      characters: [analyst, designer],
      messages: [
        buildAiMessage('designer', '刚毕业的设计师', '热闹和边界是不是冲突？', 1),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    expect(onLocalInterception).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'presence_metadata_missing',
    }));
  });

  it('keeps JSON prompt protocol but avoids native json_object mode for DeepSeek chat analysis rooms', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我补一个边界：如果私人工作区只能靠把东西塞回卧室维持，那这种热闹其实已经在消耗独处空间了。',
      deliberationArtifacts: {
        claims: [{ text: '需要靠卧室兜底的合租热闹会消耗独处空间', stance: 'review', reason: '提出合租边界判断', confidence: 0.84 }],
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('analyst', '宠物猫舍主理人', { expertise: ['猫行为学'] });
    const illustrator = buildCharacter('illustrator', '自由职业插画师');
    const deepseekProfiles: AIModelProfile[] = [{
      id: 'deepseek-text',
      name: 'DeepSeek',
      type: 'text',
      provider: 'deepseek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-chat',
      isDefault: true,
    }];

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'illustrator'],
      }),
      speaker: analyst,
      characters: [analyst, illustrator],
      messages: [
        buildAiMessage('illustrator', '自由职业插画师', '工作区全搬回房间以后，热闹和边界才算勉强平衡。', 1),
      ],
      apiConfig: deepseekProfiles,
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(generateResponseMock.mock.calls[0]?.[4]).toEqual(expect.objectContaining({ responseFormat: 'text' }));
    expect(prompt).toContain('Return exactly one JSON object');
    expect(prompt).toContain('deliberationArtifacts');
    expect(message.metadata?.deliberationArtifacts?.claims?.[0]?.text).toContain('独处空间');
  });

  it('does not request native JSON mode for DeepSeek flash models in analysis rooms', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我先拆开两层：可控在场解决陪伴感，持续运营成本决定它能不能活过三个月。',
      deliberationArtifacts: {
        claims: [{ text: '可控在场解决陪伴感，运营成本决定持续性', stance: 'review', reason: '拆分两个判断条件', confidence: 0.86 }],
      },
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('analyst', '资深北漂程序员');
    const landlord = buildCharacter('landlord', '房东大姐');
    const deepseekProfiles: AIModelProfile[] = [{
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      type: 'text',
      provider: 'deepseek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-v4-flash',
      isDefault: true,
    }];

    await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'landlord'],
      }),
      speaker: analyst,
      characters: [analyst, landlord],
      messages: [
        buildAiMessage('landlord', '房东大姐', '这种半耦合热闹到底谁付钱？', 1),
      ],
      apiConfig: deepseekProfiles,
    });

    expect(generateResponseMock.mock.calls[0]?.[4]).toEqual(expect.objectContaining({ responseFormat: 'text' }));
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('Return exactly one JSON object');
  });

  it('lets short task-like questions use natural depth instead of one-sentence bias', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '合同违约责任不能只看有没有违约，还要看合同约定、损失证明、因果关系和可预见性；如果是格式条款，还要额外看提示说明义务是否履行。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const lawyer = buildCharacter('lawyer', '冷淡律师', {
      expertise: ['合同法', '民事诉讼'],
      speakingStyle: '平时话少，但专业问题会把边界讲清楚。',
      speechProfile: { catchphrases: [], fillers: [], tabooPhrases: [], preferredOpeners: [], preferredClosers: [], sentenceLengthBias: 'short', questionBias: 30, sarcasmBias: 10 },
    });

    const message = await generateSpeakerMessage({
      chat: buildChat({ type: 'direct', memberIds: ['lawyer'] }),
      speaker: lawyer,
      characters: [lawyer],
      messages: [
        buildUserMessage('合同违约责任？', 1),
      ],
      apiConfig: buildProfiles(),
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(prompt).toContain('Mode: direct_private');
    expect(prompt).toContain('## Private Turn Priority');
    expect(prompt).toContain('This is a user direct chat');
    expect(prompt).toContain('## Turn Directive');
    expect(prompt).not.toContain('Response surface: live chat');
    expect(prompt).toContain('private conversation between this person and the user');
    expect(prompt).toContain('explicit request for help or a deliverable');
    expect(prompt).toContain('Established facts and explicit user requests still apply');
    expect(prompt).not.toContain('Usually write one sentence');
    expect(prompt).not.toContain('prefer concise, non-intrusive wording');
    expect(message.content).toContain('合同违约责任');
  });

  it('retries whitespace-only JSON output without feeding the blank draft back as repetitive content', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce('                                                                                                             ')
      .mockResolvedValueOnce(JSON.stringify({
        content: '我先把这个边界压实一点：合租能不能成立，可能不是看大家多想热闹，而是看公共资源冲突能不能被提前设计出来。',
        deliberationArtifacts: {
          claims: [{ text: '合租成立取决于公共资源冲突能否被提前设计', stance: 'review', reason: '直接提出判断标准', confidence: 0.84 }],
        },
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const analyst = buildCharacter('analyst', '刚毕业的设计师', { expertise: ['UI/UX'] });
    const landlord = buildCharacter('landlord', '房东大姐');

    const message = await generateSpeakerMessage({
      chat: buildChat({
        mode: 'group_discussion',
        sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' },
        memberIds: ['analyst', 'landlord'],
      }),
      speaker: analyst,
      characters: [analyst, landlord],
      messages: [
        buildAiMessage('landlord', '房东大姐', '合租能实现，但不能照着电视剧那么来，得照着生活来。', 1),
      ],
      apiConfig: buildProfiles(),
    });

    const retryPrompt = String(generateResponseMock.mock.calls[1]?.[1] || '');
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(retryPrompt).toContain('Empty-output retry');
    expect(retryPrompt).toContain('non-empty content string');
    expect(retryPrompt).not.toContain('Your previous draft was too close');
    expect(message.content).toContain('公共资源冲突');
  });

  it('prevents syntax contagion through prompt structure instead of local punctuation blacklists', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '这个问题的关键——不是她发了什么，而是谁替她决定了发什么。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('analyst', '心理学家', { expertise: ['心理学'] });
    const reporter = buildCharacter('reporter', '娱乐记者');
    const observer = buildCharacter('observer', '女权观察家');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['analyst', 'reporter', 'observer'] }),
      speaker: analyst,
      characters: [analyst, reporter, observer],
      messages: [
        buildAiMessage('reporter', '娱乐记者', '这话扎心——可它确实把问题摆上桌了。', 1),
        buildAiMessage('observer', '女权观察家', '我不同意——至少不该只看曝光量。', 2),
        buildAiMessage('reporter', '娱乐记者', '那就更微妙了——镜头到底对着谁？', 3),
        buildAiMessage('observer', '女权观察家', '问题就在这里——她的名字一直在后面。', 4),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    const chatMessages = generateResponseMock.mock.calls[0]?.[2] as Array<{ role: string; content: string }>;

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(onLocalInterception).not.toHaveBeenCalled();
    expect(prompt).not.toContain('## Style Quarantine');
    expect(prompt).toContain('Speak as this person among people who share this exchange');
    expect(prompt).not.toContain('Prefer sentence breaks, commas, or plain full stops over em dash');
    expect(prompt).toContain('The complete recent transcript is provided separately as chat messages');
    expect(prompt).not.toContain('这话扎心');
    expect(prompt).not.toContain('镜头到底对着谁');
    expect(chatMessages.every((item) => item.role === 'user')).toBe(true);
    expect(chatMessages.some((item) => item.content.includes('娱乐记者: 这话扎心'))).toBe(true);
    expect(message.content).toBe('这个问题的关键——不是她发了什么，而是谁替她决定了发什么。');
  });

  it('warns the model away from repeated self opening frames without local phrase blacklists', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '赔偿金额可以先从合同约定的定额违约金入手，再让法院按传播范围、过错程度和工资水平去调减。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const lawyer = buildCharacter('lawyer', '专业律师', { expertise: ['合同法', '劳动争议'] });
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['lawyer'] }),
      speaker: lawyer,
      characters: [lawyer],
      messages: [
        buildUserMessage('这种景区 NPC 保密违约金怎么写？', 1),
        buildAiMessage('lawyer', '专业律师', '你这个问题问到了实务中的痛点。景区要证明实际损失，确实不能靠模糊数据。', 2),
        buildUserMessage('点赞少是不是就很轻微？', 3),
        buildAiMessage('lawyer', '专业律师', '你这个问题问到了实务中的另一个关键点。点赞数量低不等于行为轻微。', 4),
        buildUserMessage('那赔偿金额怎么确定？', 5),
        buildAiMessage('lawyer', '专业律师', '你这个问题问到了实务中的核心困境。没有明确实际损失时，违约金需要看约定是否合理。', 6),
        buildUserMessage('如果法院要调低，景区要准备什么材料？', 7),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(onLocalInterception).not.toHaveBeenCalled();
    expect(prompt).toContain('## Turn Directive');
    expect(prompt).toContain('Choose what catches their attention and what they actually want to say now');
    expect(prompt).not.toContain('## Turn Length Variety');
    expect(prompt).not.toContain('你这个问题问到了实务中的痛点');
    expect(prompt).not.toContain('你这个问题问到了实务中的另一个关键点');
    expect(prompt).not.toContain('你这个问题问到了实务中的核心困境');
    expect(message.content).toBe('赔偿金额可以先从合同约定的定额违约金入手，再让法院按传播范围、过错程度和工资水平去调减。');
  });

  it('builds a focused situational contract for same-speaker unresolved pressure', () => {
    const laoli = buildCharacter('laoli', '老李');
    const prompt = __chatEngineTestUtils.buildFocusedSituationalJobContract([
      buildUserMessage('等一下，瑟瑟刚说她可能加班，这件事别跳过去，先确认她到底还能不能去。', 1),
      buildAiMessage('laoli', '老李', '行，那就先定这个。瑟瑟，加班的事到底有没有定数？', 2),
    ], laoli, { kind: 'chat', allowMarkdown: false, preserveParagraphs: false, roleFit: 'ordinary', basis: [] });

    expect(prompt).toContain('## Focused Situational Job Contract');
    expect(prompt).toContain('The previous visible speaker was also this speaker');
    expect(prompt).toContain('Preserve the current unresolved need');
    expect(prompt).toContain('Do not switch to a fresh logistical action');
    expect(prompt).toContain('1 recent own visible line');
    expect(prompt).not.toContain('瑟瑟，加班的事到底有没有定数');
  });

  it('warns selected non-target speakers to hand off when the user names someone else', () => {
    const zhou = buildCharacter('zhou', '周策');
    const prompt = __chatEngineTestUtils.buildFocusedSituationalJobContract([
      buildAiMessage('zhou', '周策', '这个方案不用讨论太久，今天先定第一版。', 1),
      buildUserMessage('安安，你怎么看？我想听你的意见。', 2),
    ], zhou, { kind: 'chat', allowMarkdown: false, preserveParagraphs: false, roleFit: 'ordinary', basis: [] });

    expect(prompt).toContain('appears to name someone else');
    expect(prompt).toContain('use a short clean handoff');
    expect(prompt).toContain('do not hijack');
  });

  it('keeps intentional repeat contexts available for chants and fixed answers', () => {
    const awan = buildCharacter('awan', '阿晚');
    const prompt = __chatEngineTestUtils.buildFocusedSituationalJobContract([
      buildUserMessage('我数三二一，大家一起说“出发！”', 1),
      buildAiMessage('sese', '瑟瑟', '出发！', 2),
    ], awan, { kind: 'chat', allowMarkdown: false, preserveParagraphs: false, roleFit: 'ordinary', basis: [] });

    expect(prompt).toContain('deliberate repeat, quote, chant, fixed answer, or call-and-response');
    expect(prompt).toContain('a concise intentional repeat is valid');
  });

  it('builds a natural chat surface contract for long-form and action drift', () => {
    const prompt = __chatEngineTestUtils.buildNaturalChatSurfaceContract([
      buildAiMessage('kangxi', '康熙帝', longStorySection('朕若得闲，'), 1),
      buildAiMessage('peter', '彼得大帝', longStorySection('落灰的东西就是废物。'), 2),
      buildAiMessage('napoleon', '拿破仑', longStorySection('彼得，'), 3),
    ], { kind: 'chat', allowMarkdown: false, preserveParagraphs: false, roleFit: 'ordinary', basis: [] }, true);

    expect(prompt).toContain('## Natural Chat Surface Contract');
    expect(prompt).toContain('Never mention a turn, round, speaker order, selection, prompt');
    expect(prompt).toContain('not an essay, speech, report, script page, or narrator prose');
    expect(prompt).toContain('Recent room replies are getting long');
    expect(prompt).toContain('use at most one brief beat');
    expect(prompt).toContain('Never use an action + speech + action + speech wrapper');
  });

  it('warns only when recent group chat overuses visible name-address openers', () => {
    const surface = { kind: 'chat', allowMarkdown: false, preserveParagraphs: false, roleFit: 'ordinary', basis: [] } as const;
    const repeated = __chatEngineTestUtils.buildNaturalChatSurfaceContract([
      buildAiMessage('tea', '数据茶娘', '小铁，你今晚这单子接得也太顺了。', 1),
      buildAiMessage('bot', '机械跑堂小铁', '茶娘，别把账都算我头上。', 2),
      buildAiMessage('doc', '赛博茶博士', '小铁，杯底那点残汤可藏不住。', 3),
      buildAiMessage('tea', '数据茶娘', '博士，壶出几次汤你都数得这么清。', 4),
    ], surface, false);

    expect(repeated).toContain('overusing visible name-addressing at the start');
    expect(repeated).toContain('Do not open this turn with a participant name unless it is needed');

    const varied = __chatEngineTestUtils.buildNaturalChatSurfaceContract([
      buildAiMessage('tea', '数据茶娘', '这壶今晚倒成证物了是吧。', 1),
      buildAiMessage('bot', '机械跑堂小铁', '别把我账本也扯进去。', 2),
      buildAiMessage('doc', '赛博茶博士', '茶还喝不喝了？', 3),
    ], surface, false);

    expect(varied).not.toContain('overusing visible name-addressing');
  });

  it('keeps natural chat surface contract out of non-chat surfaces', () => {
    const prompt = __chatEngineTestUtils.buildNaturalChatSurfaceContract([
      buildUserMessage('写一篇完整说明', 1),
    ], { kind: 'longform', allowMarkdown: true, preserveParagraphs: true, roleFit: 'capable', basis: [] }, true);

    expect(prompt).toBe('');
  });

  it('allows intentional repeated tone or format when the model marks intentionalRepeat', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '你这个问题问到了“没法举证但又不能零处罚”的缝里，我就顺着这个缝说。',
      intentionalRepeat: true,
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const lawyer = buildCharacter('lawyer', '专业律师', { expertise: ['合同法'] });
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['lawyer'] }),
      speaker: lawyer,
      characters: [lawyer],
      messages: [
        buildAiMessage('lawyer', '专业律师', '你这个问题问到了实务中的痛点。景区要证明实际损失很难。', 1),
        buildUserMessage('那如果视频几乎没人看呢？', 2),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(onLocalInterception).not.toHaveBeenCalled();
    expect(message.metadata?.runtimeDecision?.intentionalRepeat).toBe(true);
    expect(message.metadata?.runtimeDecision?.responseSurface?.kind).toBe('chat');
  });

  it('does not locally blacklist borrowed emoji markers once style quarantine is in the prompt', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我也有点想排队了😂',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat(),
      speaker: mei,
      characters: [mei, hui],
      messages: [
        buildAiMessage('hui', '灰太狼', '期待你下手别太狠😂', 1),
        buildAiMessage('mei', '美羊羊', '随便改，改坏了也不心疼😂', 2),
        buildAiMessage('hui', '灰太狼', '那我也排队等内部价😂', 3),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(onLocalInterception).not.toHaveBeenCalled();
    expect(prompt).toContain('## Turn Directive');
    expect(prompt).toContain('the exchange decides the shape');
    expect(prompt).not.toContain('## Expression Surface Choice');
    expect(message.content).toBe('我也有点想排队了😂');
  });

  it('allows exact repeated answers when the user asks for a poem next line', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '春风又绿江南岸',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');
    const onLocalInterception = vi.fn();

    const message = await generateSpeakerMessage({
      chat: buildChat(),
      speaker: mei,
      characters: [mei, hui],
      messages: [
        buildAiMessage('hui', '灰太狼', '春风又绿江南岸', 1),
        buildUserMessage('“京口瓜洲一水间”的下一句是什么？', 2),
      ],
      apiConfig: buildProfiles(),
      onLocalInterception,
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(onLocalInterception).not.toHaveBeenCalled();
    expect(message.content).toBe('春风又绿江南岸');
  });

  it.skip('legacy local media retry is retired; one model reply is committed as returned', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        content: '蕉太狼你这一天天的，满脑子都是香蕉，连灰太狼先生的胡子都不放过啦～',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: '来啦，我把灰太狼先生的证件照画好了，帽子和胡子都认真画了哦～',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const mei = buildCharacter('mei', '美羊羊', {
      visualIdentity: { description: '粉白色小羊，温柔爱画画', styleHint: '柔和童话插画' },
    });
    const hui = buildCharacter('hui', '灰太狼', {
      background: '灰太狼，经典狼族角色，戴黄色补丁帽，脸部有胡须和自信表情。',
      visualIdentity: { description: '灰色狼，黄色补丁帽，两撇胡子，表情夸张' },
    });
    const jiao = buildCharacter('jiao', '蕉太狼');
    const chunks: string[] = [];

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['mei', 'hui', 'jiao'] }),
      speaker: mei,
      characters: [mei, hui, jiao],
      messages: [
        {
          id: 'old-banter',
          chatId: 'chat-1',
          type: 'ai',
          senderId: 'jiao',
          senderName: '蕉太狼',
          content: '暖羊羊姐姐这接梗能力，比我那根变异香蕉还顺滑～',
          emotion: 0,
          timestamp: 10,
          isDeleted: false,
        },
        {
          id: 'guide',
          chatId: 'chat-1',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '美羊羊发个灰太狼证件照的图片',
          emotion: 0,
          timestamp: 20,
          isDeleted: false,
        },
      ],
      apiConfig: buildProfiles(),
      directorIntent: buildMediaDirectorIntent(),
      onChunk: (content) => chunks.push(content),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(String(generateResponseMock.mock.calls[1]?.[1] || '')).toContain('Guidance retry');
    expect(chunks).toEqual(['来啦，我把灰太狼先生的证件照画好了，帽子和胡子都认真画了哦～']);
    expect(message.content).toContain('灰太狼');
    expect(message.content).toContain('证件照');
    expect(message.content).not.toContain('蕉太狼你这一天天的');
    expect(message.metadata?.attachments?.[0]).toMatchObject({
      kind: 'image',
      status: 'queued',
      referenceCharacterIds: ['hui'],
    });
    expect(message.metadata?.runtimeDecision?.guidanceExecution).toMatchObject({
      status: 'accepted_after_retry',
      validated: true,
      retryCount: 1,
      rejectedDraftCount: 1,
      rejectedReasons: ['missing_requested_image'],
      finalReason: 'matched',
      forcedMediaQueued: true,
    });
  });

  it.skip('legacy local media capability prompt is retired; the model receives capabilities in the output contract', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        content: '来啦，我把灰太狼先生的证件照画好了，帽子和胡子都认真画了哦～',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: '我现在没有图片模型，发不了真正的证件照图片，只能先把构图想法说给你听。',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');
    const textOnlyProfiles = buildProfiles().filter((profile) => profile.type !== 'image');

    const message = await generateSpeakerMessage({
      chat: buildChat(),
      speaker: mei,
      characters: [mei, hui],
      messages: [{
        id: 'guide',
        chatId: 'chat-1',
        type: 'god',
        senderId: 'user',
        senderName: '开发者',
        content: '美羊羊发个灰太狼证件照的图片',
        emotion: 0,
        timestamp: 10,
        isDeleted: false,
      }],
      apiConfig: textOnlyProfiles,
      directorIntent: buildMediaDirectorIntent(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(String(generateResponseMock.mock.calls[1]?.[1] || '')).toContain('Do not pretend an image was sent');
    expect(message.content).toContain('发不了');
    expect(message.metadata?.attachments).toEqual([]);
    expect(message.metadata?.generationDecision).toBeUndefined();
    expect(message.metadata?.runtimeDecision?.guidanceExecution).toMatchObject({
      status: 'accepted_after_retry',
      validated: true,
      retryCount: 1,
      rejectedDraftCount: 1,
      rejectedReasons: ['missing_requested_image'],
      finalReason: 'matched',
    });
  });

  it('treats direct user messages as companionship context instead of topic guidance', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我记得你明天面试会紧张。先别急，我们一点点把最难的部分拆开。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊', {
      memory: {
        shortTermSummary: '',
        longTerm: [],
        secrets: [],
        obsessions: [],
        tabooTopics: [],
        userMemories: ['用户说过明天面试会紧张。'],
      },
    });
    const directChat = buildChat({
      type: 'direct',
      memberIds: ['mei'],
      relationshipLedger: [{
        pairKey: 'mei->user',
        actorId: 'mei',
        targetId: 'user',
        current: { warmth: 18, trust: 12, competence: 4, threat: 0 },
        trend: 'up',
        recentEvents: [],
        lastUpdatedAt: 100,
      }],
    });

    const message = await generateSpeakerMessage({
      chat: directChat,
      speaker: mei,
      characters: [mei],
      messages: [buildUserMessage('明天面试有点紧张。', 200)],
      apiConfig: buildProfiles(),
    });

    expect(message.metadata?.runtimeDecision?.directorIntent?.userGuidance).toBeFalsy();
    expect(message.metadata?.runtimeDecision?.guidanceExecution).toBeUndefined();
    expect(message.metadata?.runtimeDecision?.companionshipContext).toMatchObject({
      currentAddress: '你',
    });
    expect(message.metadata?.runtimeDecision?.companionshipContext?.pendingCareTopics.join(' / ')).toContain('明天面试');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('## Companionship Context');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('Mode: direct_private');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('## Private Turn Priority');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('the exchange determines what it means');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).not.toContain('complete that job first');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).not.toContain('make a real relationship move');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('明天面试');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('Recorded emotional lead:');
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).not.toContain('Current impulse:');
  });

  it('uses private prompt arbitration for AI private threads', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '这事我不想在群里说。你刚才那句其实把我架住了，我需要先确认你是不是也这么看。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const a = buildCharacter('a', '甲');
    const b = buildCharacter('b', '乙');

    await generateSpeakerMessage({
      chat: buildChat({ type: 'ai_direct', memberIds: ['a', 'b'] }),
      speaker: a,
      characters: [a, b],
      messages: [
        buildAiMessage('b', '乙', '刚才群里那句话，你是不是故意没接？', 1),
      ],
      apiConfig: buildProfiles(),
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(prompt).toContain('Mode: direct_private');
    expect(prompt).toContain('## Private Turn Priority');
    expect(prompt).toContain('This is an AI private thread');
    expect(prompt).toContain('the exchange determines what it means');
    expect(prompt).toContain('When the user requests a deliverable');
    expect(prompt).not.toContain('complete that job first');
    expect(prompt).not.toContain('make a real relationship move');
    expect(prompt).not.toContain('Mode: general_group');
    expect(prompt).toContain('Recorded emotional lead:');
    expect(prompt).not.toContain('Current impulse:');
  });

  it('does not retry plain topic shifts as persistent guidance tasks', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        content: '蕉太狼你又把香蕉扯到胡子上了，这话题也太滑了吧～',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: '狼抓羊这事不能只说“应该”，至少得先分清生存本能和伤害别人是不是一回事吧？',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const man = buildCharacter('man', '慢羊羊', { expertise: ['伦理', '狼抓羊', '自然法则'] });
    const jiao = buildCharacter('jiao', '蕉太狼', { expertise: ['香蕉'] });
    const now = Date.now();

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['man', 'jiao'] }),
      speaker: man,
      characters: [man, jiao],
      messages: [
        {
          id: 'old',
          chatId: 'chat-1',
          type: 'ai',
          senderId: 'jiao',
          senderName: '蕉太狼',
          content: '香蕉证件照也不是不行。',
          emotion: 0,
          timestamp: now - 2000,
          isDeleted: false,
        },
        {
          id: 'guide',
          chatId: 'chat-1',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '新话题：狼抓羊有过错吗？狼应该抓羊吗？',
          emotion: 0,
          timestamp: now - 1000,
          isDeleted: false,
        },
      ],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(message.content).not.toContain('狼抓羊有没有过错得');
    expect(message.metadata?.runtimeDecision?.directorIntent?.userGuidance).toBeFalsy();
    expect(message.metadata?.runtimeDecision?.guidanceExecution).toBeUndefined();
  });

  it('does not retry plain question topic shifts through keyword validation', async () => {
    generateResponseMock.mockReset();
    generateResponseMock
      .mockResolvedValueOnce(JSON.stringify({
        content: '狼抓羊证件照也挺好玩，灰太狼肯定想把羊画进去吧～',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: '狼抓羊有没有过错得分开看：生存本能是一回事，故意伤害羊又是另一回事。',
        interactionHints: null,
        socialEventHints: null,
        conflictFocus: null,
      }));
    const man = buildCharacter('man', '慢羊羊', { expertise: ['伦理', '狼抓羊', '自然法则'] });
    const now = Date.now();

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['man'] }),
      speaker: man,
      characters: [man],
      messages: [
        {
          id: 'guide',
          chatId: 'chat-1',
          type: 'god',
          senderId: 'user',
          senderName: '开发者',
          content: '新话题：狼抓羊有过错吗？狼应该抓羊吗？',
          emotion: 0,
          timestamp: now - 1000,
          isDeleted: false,
        },
      ],
      apiConfig: buildProfiles(),
    });

    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    expect(message.content).toBe('狼抓羊证件照也挺好玩，灰太狼肯定想把羊画进去吧～');
    expect(message.metadata?.runtimeDecision?.directorIntent?.userGuidance).toBeFalsy();
    expect(message.metadata?.runtimeDecision?.guidanceExecution).toBeUndefined();
  });

  it.skip('legacy local media guidance recovery is retired', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '来啦来啦，灰太狼先生的证件照我画好了～',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼', {
      visualIdentity: { description: '灰色狼，黄色补丁帽，两撇胡子' },
    });
    const lan = buildCharacter('lan', '懒羊羊');
    const now = Date.now();

    const message = await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['mei', 'hui', 'lan'] }),
      speaker: mei,
      characters: [mei, hui, lan],
      messages: [
        {
          id: 'guide',
          chatId: 'chat-1',
          type: 'god',
          senderId: 'user',
          senderName: '开发者',
          content: '美羊羊发个灰太狼证件照的图片',
          emotion: 0,
          timestamp: now - 2000,
          isDeleted: false,
        },
        {
          id: 'slipped',
          chatId: 'chat-1',
          type: 'ai',
          senderId: 'hui',
          senderName: '灰太狼',
          content: '我看看你画得够不够帅，别把我胡子画歪了！',
          emotion: 0,
          timestamp: now - 1000,
          isDeleted: false,
        },
      ],
      apiConfig: buildProfiles(),
    });

    expect(message.senderId).toBe('mei');
    expect(message.metadata?.runtimeDecision?.directorIntent?.userGuidance).toMatchObject({
      kind: 'media_request',
      actorIds: ['mei'],
      mediaRequest: { subjectActorIds: ['hui'] },
    });
    expect(message.metadata?.attachments?.[0]).toMatchObject({
      kind: 'image',
      status: 'queued',
      referenceCharacterIds: ['hui'],
    });
  });

  it.skip('legacy local media speaker lock is retired', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '来啦，我把灰太狼先生画成最帅证件照～',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊', {
      visualIdentity: { description: '粉白色小羊，温柔爱画画', styleHint: '柔和童话插画' },
    });
    const hui = buildCharacter('hui', '灰太狼', {
      background: '灰太狼，戴黄色补丁帽，脸部有胡须。',
      visualIdentity: { description: '灰色狼，黄色补丁帽，两撇胡子' },
    });
    const lan = buildCharacter('lan', '懒羊羊');
    const completed: unknown[] = [];
    const selected: string[] = [];
    const now = Date.now();

    await runOneRound(
      buildChat({ memberIds: ['mei', 'hui', 'lan'] }),
      [mei, hui, lan],
      [
        {
          id: 'guide',
          chatId: 'chat-1',
          type: 'god',
          senderId: 'user',
          senderName: '开发者',
          content: '美羊羊发个灰太狼证件照的图片',
          emotion: 0,
          timestamp: now - 2000,
          isDeleted: false,
        },
        {
          id: 'non-target',
          chatId: 'chat-1',
          type: 'ai',
          senderId: 'hui',
          senderName: '灰太狼',
          content: '我看看你画得够不够帅，别把我胡子画歪了！',
          emotion: 0,
          timestamp: now - 1000,
          isDeleted: false,
        },
      ],
      buildProfiles(),
      {
        onSpeakerSelected: (characterId) => selected.push(characterId),
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message); },
        onError: (error) => { throw error; },
      },
      undefined,
      undefined,
      {},
    );

    expect(selected[0]).toBe('mei');
    expect(completed[0]).toMatchObject({ senderId: 'mei' });
    expect((completed[0] as { metadata?: { attachments?: unknown[] } }).metadata?.attachments).toHaveLength(1);
  });

  it('locks model-assessed direct writing guidance to the intended speaker without local name matching', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '如果让我写，我会先把AI当成一面镜子：它照出的不是人类会不会被替代，而是我们愿不愿意重新分配创造力。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const susu = buildCharacter('susu', '穿搭博主苏苏');
    const luxun = buildCharacter('luxun', '鲁智深');
    const xiao = buildCharacter('xiao', '潇潇');
    const completed: unknown[] = [];
    const selected: string[] = [];
    const now = Date.now();
    const guidance: NonNullable<DirectorIntent['userGuidance']> = {
      kind: 'direct_reply', rawText: '苏苏你写一篇这个话题的800字作文',
      actorIds: ['susu'], mentionedActorIds: ['susu'], focusText: '写一篇这个话题的800字作文',
      beatType: 'answer', pressure: 0.94, maxTurns: 1, minTargetTurns: 1,
      reason: '模型判断用户把写作任务明确交给苏苏。',
    };

    await runOneRound(
      buildChat({
        memberIds: ['susu', 'luxun', 'xiao'],
        runtimeEventsV2: [buildGuidanceIntervention(guidance, now - 1000)],
      }),
      [susu, luxun, xiao],
      [{
        id: 'guide',
        chatId: 'chat-1',
        type: 'god',
        senderId: 'user',
        senderName: '开发者',
        content: '苏苏你写一篇这个话题的800字作文',
        emotion: 0,
        timestamp: now - 1000,
        isDeleted: false,
      }],
      buildProfiles(),
      {
        onSpeakerSelected: (characterId) => selected.push(characterId),
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message); },
        onError: (error) => { throw error; },
      },
      undefined,
      undefined,
      {},
    );

    expect(selected[0]).toBe('susu');
    expect(completed[0]).toMatchObject({ senderId: 'susu' });
    expect((completed[0] as { metadata?: { runtimeDecision?: { directorIntent?: { userGuidance?: { actorIds?: string[] } } } } }).metadata?.runtimeDecision?.directorIntent?.userGuidance?.actorIds).toEqual(['susu']);
  });

  it('does not lock a speaker for a broad constraint that only mentions several members', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我没打算把这件事当成拍漏了。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const members = [buildCharacter('wen', '闻溪'), buildCharacter('tang', '许棠'), buildCharacter('cheng', '程野')];
    const now = Date.now();
    const completed: Message[] = [];
    const guidance: NonNullable<DirectorIntent['userGuidance']> = {
      kind: 'topic_shift', rawText: '合照里怎么只有闻溪和程野，许棠去哪了？这件事别当成拍漏了就算了。',
      actorIds: [], mentionedActorIds: ['wen', 'tang', 'cheng'], hardConstraintActorIds: ['tang'],
      suppressedActorIds: [], deferredActorIds: [], hasHardConstraints: true,
      focusText: '不能把许棠缺席简单当成拍漏', beatType: 'challenge', pressure: 0.86,
      maxTurns: 5, reason: '模型判断这是需要全群继续遵守的边界，但没有指定下一位发言者。',
    };
    await runOneRound(
      buildChat({
        memberIds: ['user', ...members.map((member) => member.id)],
        runtimeEventsV2: [buildGuidanceIntervention(guidance, now - 75_000)],
      }),
      members,
      [
        buildUserMessage('合照里怎么只有闻溪和程野，许棠去哪了？这件事别当成拍漏了就算了。', now - 75_000),
        buildAiMessage('cheng', '程野', '她去拿蛋糕了。', now - 60_000),
        buildAiMessage('tang', '许棠', '没事，你们那张挺好看的。', now - 45_000),
        buildAiMessage('wen', '闻溪', '许棠，你是不是生气了。', now - 30_000),
      ],
      buildProfiles(),
      {
        onSpeakerSelected: () => undefined,
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message as Message); },
        onError: (error) => { throw error; },
      },
    );
    expect(completed).toHaveLength(1);
    expect(completed[0].metadata?.runtimeDecision?.speakerSelection?.policy?.source).not.toBe('user_guidance_lock');
    expect(completed[0].metadata?.runtimeDecision?.directorIntent?.userGuidance?.hasHardConstraints).toBe(true);
  });

  it.skip('legacy local media speaker lock is retired', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');
    const lan = buildCharacter('lan', '懒羊羊');
    const completed: unknown[] = [];
    const selected: string[] = [];
    const errors: Error[] = [];
    const now = Date.now();

    await runOneRound(
      buildChat({ memberIds: ['mei', 'hui', 'lan'] }),
      [mei, hui, lan],
      [
        {
          id: 'guide',
          chatId: 'chat-1',
          type: 'god',
          senderId: 'user',
          senderName: '开发者',
          content: '美羊羊发个灰太狼证件照的图片',
          emotion: 0,
          timestamp: now - 2000,
          isDeleted: false,
        },
        {
          id: 'non-target',
          chatId: 'chat-1',
          type: 'ai',
          senderId: 'hui',
          senderName: '灰太狼',
          content: '我看看你画得够不够帅，别把我胡子画歪了！',
          emotion: 0,
          timestamp: now - 1000,
          isDeleted: false,
        },
      ],
      buildProfiles(),
      {
        onSpeakerSelected: (characterId) => selected.push(characterId),
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message); },
        onError: (error) => { errors.push(error); },
      },
      undefined,
      undefined,
      {},
    );

    expect(selected).toEqual(['mei']);
    expect(completed).toHaveLength(0);
    expect(errors[0]?.message).toContain('美羊羊');
    expect(generateResponseMock).toHaveBeenCalledTimes(3);
  });

  it('keeps corrective suppression after target floor has enough room without forcing a monologue', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我先帮安安把话留住，周策这轮别急着接管。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const anan = buildCharacter('anan', '安安');
    const zhou = buildCharacter('zhou', '周策', {
      personality: { openness: 50, extroversion: 95, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 95, empathy: 50 },
      behavior: { proactivity: 95, aggressiveness: 50, humorIntensity: 50, empathyLevel: 50, summarizing: 50, offTopic: 50 },
    });
    const mei = buildCharacter('mei', '梅青');
    const selected: string[] = [];
    const completed: unknown[] = [];
    const now = Date.now();
    const guidance: NonNullable<DirectorIntent['userGuidance']> = {
      kind: 'direct_reply', rawText: '我刚才是想听安安说，不是让周策替她做决定。',
      actorIds: ['anan'], mentionedActorIds: ['anan', 'zhou'], suppressedActorIds: ['zhou'], deferredActorIds: [],
      focusText: '让安安自己说完', beatType: 'answer', pressure: 0.92,
      maxTurns: 3, minTargetTurns: 2, reason: '模型判断用户正在纠正抢话并把发言权还给安安。',
    };

    await runOneRound(
      buildChat({
        memberIds: ['anan', 'zhou', 'mei'],
        runtimeEventsV2: [buildGuidanceIntervention(guidance, now - 3000)],
      }),
      [anan, zhou, mei],
      [
        {
          id: 'guide',
          chatId: 'chat-1',
          type: 'user',
          senderId: 'user',
          senderName: '我',
          content: '我刚才是想听安安说，不是让周策替她做决定。',
          emotion: 0,
          timestamp: now - 3000,
          isDeleted: false,
        },
        {
          id: 'answer-1',
          chatId: 'chat-1',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '我先说一部分，访谈里用户主要卡在承诺没有兑现。',
          emotion: 0,
          timestamp: now - 2000,
          isDeleted: false,
        },
        {
          id: 'answer-2',
          chatId: 'chat-1',
          type: 'ai',
          senderId: 'anan',
          senderName: '安安',
          content: '还有一点是客服跟进太慢，他们不是不需要产品，是不再信任我们。',
          emotion: 0,
          timestamp: now - 1000,
          isDeleted: false,
        },
      ],
      buildProfiles(),
      {
        onSpeakerSelected: (characterId) => selected.push(characterId),
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message); },
        onError: (error) => { throw error; },
      },
      undefined,
      undefined,
      {},
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]).not.toBe('zhou');
    expect(completed[0]).toMatchObject({ senderId: selected[0] });
  });

  it('generates a group round without recursive surface resolution for open chat', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我先接一句。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');
    const completed: unknown[] = [];
    const errors: Error[] = [];

    await runOneRound(
      buildChat({ memberIds: ['mei', 'hui'] }),
      [mei, hui],
      [buildUserMessage('你们继续聊。', 1)],
      buildProfiles(),
      {
        onSpeakerSelected: () => undefined,
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message); },
        onError: (error) => { errors.push(error); },
      },
      undefined,
      undefined,
      {},
    );

    expect(errors).toHaveLength(0);
    expect(completed).toHaveLength(1);
    expect((completed[0] as { content: string }).content).toBe('我先接一句。');
  });

  it('gives ordinary conversation one expression owner instead of stacked task menus', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我突然想起一件小事。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');

    await generateSpeakerMessage({
      chat: buildChat({ memberIds: ['mei', 'hui'] }),
      speaker: mei,
      characters: [mei, hui],
      messages: [buildAiMessage('hui', '灰太狼', '昨晚那件事我还没想明白。', 1)],
      apiConfig: buildProfiles(),
    });

    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(prompt).toContain('## Turn Directive');
    expect(prompt).not.toContain('## Conversation Move Guidance');
    expect(prompt).not.toContain('## Expression Surface Choice');
    expect(prompt).not.toContain('## Turn Length Variety');
    expect(prompt).not.toContain('## Turn Format Variety');
    expect(prompt).not.toContain('## Turn Plan');
    expect(prompt).not.toContain('## Runtime Role Constraint');
    expect(prompt).not.toContain('## Focused Situational Job Contract');
  });

  it('keeps conversation interaction rules on a creative roleplay surface', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({ messages: [{ content: '二哥，刀先借俺使使。' }, { content: '大哥那边俺自己去说。' }] }));
    const mei = buildCharacter('mei', '美羊羊');
    const hui = buildCharacter('hui', '灰太狼');
    const result = await generateSpeakerMessage({
      chat: buildChat({ style: 'roleplay', memberIds: ['mei', 'hui'] }),
      speaker: mei, characters: [mei, hui],
      messages: [buildAiMessage('hui', '灰太狼', '这事我来办。', 1)], apiConfig: buildProfiles(),
      generationContext: { promptContext: { responseStyle: 'creative', styleProfile: 'dramatic_room', allowMarkdown: true } },
    });
    const prompt = String(generateResponseMock.mock.calls[0]?.[1] || '');
    expect(prompt).toContain('## Turn Directive');
    expect(prompt).not.toContain('## Natural Chat Rhythm');
    expect(prompt).toContain('Acknowledgement is implicit by default');
    expect(prompt).not.toContain('Forbidden semantic overlap:');
    expect(prompt).not.toContain('## Conversation Move Guidance');
    expect(result.content).toBe('二哥，刀先借俺使使。');
    expect(result.messageParts?.map((part) => part.content)).toEqual(['二哥，刀先借俺使使。', '大哥那边俺自己去说。']);
  });

  it('idles group auto scheduling when fewer than two participants can speak', async () => {
    generateResponseMock.mockReset();
    const mei = buildCharacter('mei', '美羊羊');
    const completed: unknown[] = [];
    const idleReasons: string[] = [];

    await runOneRound(
      buildChat({ memberIds: ['mei'] }),
      [mei],
      [buildUserMessage('你们继续聊。', 1)],
      buildProfiles(),
      {
        onSpeakerSelected: () => undefined,
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message); },
        onIdle: (reason) => idleReasons.push(reason),
        onError: (error) => { throw error; },
      },
      undefined,
      undefined,
      {},
    );

    expect(generateResponseMock).not.toHaveBeenCalled();
    expect(completed).toHaveLength(0);
    expect(idleReasons[0]).toContain('群里已无多人在线');
  });

  it('allows one AI member to reply when the user is also a group participant', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我还在，先接你的问题。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const mei = buildCharacter('mei', '美羊羊');
    const completed: unknown[] = [];
    const selected: string[] = [];

    await runOneRound(
      buildChat({ memberIds: ['user', 'mei'] }),
      [mei],
      [buildUserMessage('你还在吗？', 1)],
      buildProfiles(),
      {
        onSpeakerSelected: (characterId) => selected.push(characterId),
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message); },
        onError: (error) => { throw error; },
      },
      undefined,
      undefined,
      {},
    );

    expect(selected).toEqual(['mei']);
    expect(completed[0]).toMatchObject({ senderId: 'mei', content: '我还在，先接你的问题。' });
  });

  it('allows a single tutor in the learning progress session', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '先从今天的目标开始。',
      studyUpdate: { phase: 'mapping', knowledgeObservations: [] },
    }));
    const tutor = buildCharacter('tutor', '导师');
    const completed: unknown[] = [];
    const idleReasons: string[] = [];
    await runOneRound(
      buildChat({ memberIds: ['tutor'], sessionKind: { topology: 'group', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' } }),
      [tutor],
      [buildUserMessage('我们开始学习。', 1)],
      buildProfiles(),
      { onSpeakerSelected: () => undefined, onMessageChunk: () => undefined, onMessageComplete: (message) => completed.push(message), onIdle: (reason) => idleReasons.push(reason), onError: (error) => { throw error; } },
      undefined,
      undefined,
      {},
    );
    expect(idleReasons).toHaveLength(0);
    expect(completed).toHaveLength(1);
  });

  it('passes known study knowledge IDs to the model even with an engine prompt context', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '你已经能区分这两种时态了，再试一句。',
      studyUpdate: { phase: 'learning', knowledgeObservations: [{
        knowledgeItemId: 'knowledge:past-present', title: '过去时与现在完成时',
        status: 'practicing', evidenceSummary: '学习者改正了昨天见面的句子。', confidence: 0.8,
      }] },
    }));
    const tutor = buildCharacter('tutor', '导师');
    await runOneRound(
      buildChat({
        memberIds: ['user', 'tutor'],
        sessionKind: { topology: 'group', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' },
        scenarioState: { phase: 'learning', learning: {
          goal: '英语时态', knowledgeItems: [{ id: 'knowledge:past-present', title: '过去时与现在完成时', status: 'practicing', evidenceCount: 1 }],
        } },
      }),
      [tutor],
      [buildUserMessage('I saw him yesterday，这次对吗？', 1)],
      buildProfiles(),
      { onSpeakerSelected: () => undefined, onMessageChunk: () => undefined, onMessageComplete: () => undefined, onError: (error) => { throw error; } },
      undefined,
      undefined,
      {},
    );
    expect(String(generateResponseMock.mock.calls[0]?.[1] || '')).toContain('knowledge:past-present | 过去时与现在完成时');
  });

  it('does not select away or deleted members for group scheduling', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '我来继续。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const now = Date.now();
    const mei = buildCharacter('mei', '美羊羊', {
      presence: { status: 'away', activity: '睡觉', updatedAt: now, unavailableUntil: now + 60_000 },
    });
    const hui = buildCharacter('hui', '灰太狼', { deletedAt: now });
    const lan = buildCharacter('lan', '懒羊羊');
    const selected: string[] = [];

    await runOneRound(
      buildChat({ memberIds: ['user', 'mei', 'hui', 'lan'] }),
      [mei, hui, lan],
      [buildUserMessage('谁还在？', 1)],
      buildProfiles(),
      {
        onSpeakerSelected: (characterId) => selected.push(characterId),
        onMessageChunk: () => undefined,
        onMessageComplete: () => undefined,
        onError: (error) => { throw error; },
      },
      undefined,
      undefined,
      {},
    );

    expect(selected).toEqual(['lan']);
  });

  it('maps hybrid surface sessions without recursive surface resolution', async () => {
    generateResponseMock.mockReset();
    generateResponseMock.mockResolvedValue(JSON.stringify({
      content: '先列一下关键疑点。',
      interactionHints: null,
      socialEventHints: null,
      conflictFocus: null,
    }));
    const analyst = buildCharacter('analyst', '心理学家', { expertise: ['心理学'] });
    const ethicist = buildCharacter('ethicist', '财富伦理师', { expertise: ['伦理'] });
    const completed: unknown[] = [];
    const errors: Error[] = [];

    await runOneRound(
      buildChat({ mode: 'werewolf', memberIds: ['analyst', 'ethicist'] }),
      [analyst, ethicist],
      [buildUserMessage('先说一下你们的判断。', 1)],
      buildProfiles(),
      {
        onSpeakerSelected: () => undefined,
        onMessageChunk: () => undefined,
        onMessageComplete: (message) => { completed.push(message); },
        onError: (error) => { errors.push(error); },
      },
      undefined,
      undefined,
      {},
    );

    expect(errors).toHaveLength(0);
    expect(completed).toHaveLength(1);
    expect((completed[0] as { content: string }).content).toBe('先列一下关键疑点。');
  });

  it('stores compact runtime decision metadata without requiring media generation', () => {
    const metadata = __chatEngineTestUtils.buildMessageMetadata({
      decision: null,
      capabilities: { image: false, audio: false },
      content: '我来接一下这个话题。',
      runtimeDecision: {
        directorIntent: {
          source: 'conflict',
          beatType: 'challenge',
          targetLineId: 'conflict-1',
          targetActorIds: ['a', 'b'],
          pressure: 0.8,
          reason: '冲突线正在升温',
        },
        narrativeLines: [{
          id: 'conflict-1',
          type: 'conflict',
          title: '当前矛盾',
          salience: 0.9,
          tension: 0.8,
          status: 'escalating',
          participantIds: ['a', 'b'],
        }],
        speakerScore: { actorId: 'a', finalScore: 1.2, reasons: ['conflict'] },
      },
    });

    expect(metadata?.attachments).toEqual([]);
    expect(metadata?.generationDecision).toBeUndefined();
    expect(metadata?.runtimeDecision?.directorIntent?.targetLineId).toBe('conflict-1');
    expect(metadata?.runtimeDecision?.speakerScore).toMatchObject({ actorId: 'a', finalScore: 1.2 });
  });

  it('stores explicit user guidance inside runtime decision metadata', () => {
    const runtimeDecision = __chatEngineTestUtils.buildRuntimeDecisionMetadata({
      directorIntent: {
        source: 'user_message',
        beatType: 'answer',
        targetActorIds: ['mei'],
        pressure: 0.98,
        reason: '用户指定角色发送或创作图片。',
        userGuidance: {
          kind: 'media_request',
          rawText: '美羊羊发个灰太狼证件照的图片',
          actorIds: ['mei'],
          mentionedActorIds: ['mei', 'hui'],
          focusText: '美羊羊发个灰太狼证件照的图片',
          beatType: 'answer',
          pressure: 0.98,
          maxTurns: 1,
          reason: '用户指定角色发送或创作图片。',
          mediaRequest: {
            kind: 'image',
            subjectActorIds: ['hui'],
            subjectText: '灰太狼',
            actionText: '发个灰太狼证件照的图片',
          },
        },
      },
      memoryTrace: {
        injectedIds: [],
        recalledArchives: [],
        targetActorId: 'hui',
        targetActorName: '灰太狼',
        targetReason: '来自人工发图请求的图片对象',
      },
    });

    expect(runtimeDecision?.directorIntent?.userGuidance).toMatchObject({
      kind: 'media_request',
      actorIds: ['mei'],
      mediaRequest: {
        kind: 'image',
        subjectActorIds: ['hui'],
      },
    });
    expect(runtimeDecision?.memoryContext).toMatchObject({
      targetActorId: 'hui',
      targetActorName: '灰太狼',
      targetReason: '来自人工发图请求的图片对象',
    });
  });

  it('stores world influence rule traces in runtime decision metadata', () => {
    const runtimeDecision = __chatEngineTestUtils.buildRuntimeDecisionMetadata({
      worldInfluence: {
        attentionScore: 0.82,
        attentionRestraint: 0.41,
        activeRuleIds: ['comfort_first', 'urgent_calendar_first'],
        activeRuleTexts: ['Before expanding into analysis...', 'You have an upcoming schedule within 6 hours...'],
      },
    });
    expect(runtimeDecision?.worldInfluence).toMatchObject({
      attentionScore: 0.82,
      attentionRestraint: 0.41,
      activeRuleIds: ['comfort_first', 'urgent_calendar_first'],
    });
    expect(runtimeDecision?.worldInfluence?.activeRuleTexts?.length).toBe(2);
  });

  it('stores compact character mind trace in runtime decision metadata', () => {
    const runtimeDecision = __chatEngineTestUtils.buildRuntimeDecisionMetadata({
      characterMindTrace: {
        visibility: 'public',
        visibleMemoryRecall: 'natural',
        memorySource: 'assembly_candidates',
        targetActorId: 'hui',
        targetActorName: '灰太狼',
        omittedPrivateContinuity: true,
        omittedRawRoomLines: true,
        coreLineCount: 6,
        roomLineCount: 4,
        recallCueCount: 2,
        hasUserContinuity: true,
        hasRelationshipContinuity: true,
        hasSharedHistory: false,
        hasWorldContext: true,
      },
    });

    expect(runtimeDecision?.characterMind).toMatchObject({
      visibility: 'public',
      memorySource: 'assembly_candidates',
      targetActorName: '灰太狼',
      coreLineCount: 6,
      omittedPrivateContinuity: true,
    });
    expect(JSON.stringify(runtimeDecision?.characterMind)).not.toContain('## Character Mind Projection');
  });

  it('adds a larger typing delay for repair and withdrawal pressure', () => {
    const slow = __chatEngineTestUtils.resolveInnerLifeTypingDelayMs({
      actorId: 'a',
      impulse: 'repair',
      tone: 'vulnerable',
      reason: '想找补',
      pressure: 0.75,
      evidence: [],
      state: {
        mood: { pleasure: -10, arousal: 50, dominance: 40 },
        energy: 42,
        attention: 50,
        loneliness: 10,
        repression: 72,
        shame: 70,
        envy: 0,
        trustInRoom: 52,
        ignoredStreak: 0,
      },
      expressionPlan: {
        tone: 'vulnerable',
        length: 'short',
        messageCount: 1,
        typoLevel: 0,
        delayMs: 1700,
        allowWithdraw: true,
      },
    }, { speed: 1 } as never);
    const fast = __chatEngineTestUtils.resolveInnerLifeTypingDelayMs({
      actorId: 'a',
      impulse: 'answer',
      tone: 'casual',
      reason: '被点名',
      pressure: 0.5,
      evidence: [],
      state: {
        mood: { pleasure: 0, arousal: 20, dominance: 50 },
        energy: 70,
        attention: 70,
        loneliness: 0,
        repression: 10,
        shame: 10,
        envy: 0,
        trustInRoom: 60,
        ignoredStreak: 0,
      },
      expressionPlan: {
        tone: 'casual',
        length: 'short',
        messageCount: 1,
        typoLevel: 0,
        delayMs: 800,
        allowWithdraw: false,
      },
    }, { speed: 2 } as never);

    expect(slow).toBeGreaterThan(fast);
    expect(slow).toBeLessThanOrEqual(2600);
  });

  it('skips ordinary inner-life typing delay for story-reader generation', () => {
    expect(__chatEngineTestUtils.shouldApplyInnerLifeTypingDelay({
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' },
    } as never)).toBe(false);

    expect(__chatEngineTestUtils.shouldApplyInnerLifeTypingDelay({
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' },
    } as never)).toBe(true);
  });
});
