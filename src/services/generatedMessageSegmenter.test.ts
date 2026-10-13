import { describe, expect, it } from 'vitest';
import type { GeneratedRoundMessage } from './chatEngine';
import { buildGeneratedTurnContent, splitGeneratedMessageText, splitGeneratedRoundMessage } from './generatedMessageSegmenter';

function buildMessage(content: string, messageCount = 1): GeneratedRoundMessage {
  return {
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'char-1',
    senderName: '甲',
    content,
    emotion: 0,
    metadata: {
      runtimeDecision: {
        innerLife: {
          impulse: 'show_off',
          tone: 'casual',
          reason: '想多说两句',
          pressure: 0.5,
          expressionPlan: {
            messageCount,
          },
        },
      },
    },
  };
}

describe('generatedMessageSegmenter', () => {
  it.each(['modern', 'legacy'])('commits outgoing interactions with their exact evidence send (%s)', (format) => {
    const primary = { actorId: 'char-1', targetId: 'char-2', kind: 'support' as const,
      intensity: 2, confidence: 0.9, evidenceText: '你先歇会',
      immediateImpact: { roomDelta: { heat: -2 } } };
    const secondary = { actorId: 'char-1', targetId: 'char-3', kind: 'challenge' as const,
      intensity: 3, confidence: 0.9, evidenceText: '这次你来',
      immediateImpact: { targetEmotionDelta: { irritation: 3 } } };
    const invalid = { ...primary, evidenceText: '没有发送的话' };
    const contents = ['先把门关上。', '你先歇会。', '这次你来。', '你先歇会。'];
    const message = { ...buildMessage(contents[0]),
      ...(format === 'modern' ? { messageParts: contents.map((content) => ({ content })) } : { extraMessages: contents.slice(1) }),
      interactionHint: primary, interactionHints: [primary, secondary, invalid],
    };
    const segments = splitGeneratedRoundMessage(message);
    expect(segments.map((segment) => segment.interactionHints)).toEqual([null, [primary], [secondary], null]);
    expect(segments.map((segment) => segment.interactionHint)).toEqual([null, primary, secondary, null]);
    expect(segments[1].interactionHint?.immediateImpact).toEqual(primary.immediateImpact);
    expect(segments[2].interactionHint?.immediateImpact).toEqual(secondary.immediateImpact);
  });

  it('routes a legacy single interaction without crossing bubble boundaries', () => {
    const interactionHint = { actorId: 'char-1', targetId: 'char-2', kind: 'support' as const,
      intensity: 2, confidence: 0.9, evidenceText: '你先歇会' };
    const message = { ...buildMessage('先等一下。'), extraMessages: ['你先歇会。'], interactionHint };
    expect(splitGeneratedRoundMessage(message).map((segment) => segment.interactionHint)).toEqual([null, interactionHint]);
    expect(splitGeneratedRoundMessage({ ...message, interactionHint: { ...interactionHint, evidenceText: '一下。\n你先' } })
      .every((segment) => segment.interactionHint === null)).toBe(true);
  });

  it.each(['modern', 'legacy'])('commits conflict changes only with their evidence send (%s)', (format) => {
    const message = { ...buildMessage('先说别的。'),
      ...(format === 'modern' ? { messageParts: [{ content: '先说别的。' }, { content: '这事说清楚了。' }, { content: '这事说清楚了。' }] } : { extraMessages: ['这事说清楚了。', '这事说清楚了。'] }),
      conflictFocus: { present: true, type: 'authority_challenge' as const, stage: 'resolved' as const, conflictId: 'conflict-1', evidenceText: '这事说清楚了' },
    };
    const segments = splitGeneratedRoundMessage(message);
    expect(segments.map((item) => Boolean(item.conflictFocus))).toEqual([false, true, false]);
    expect(segments.slice(0, 1).every((item) => !item.conflictFocus)).toBe(true);
    expect(splitGeneratedRoundMessage({ ...message, conflictFocus: { ...message.conflictFocus, evidenceText: '没有说过的话' } })
      .every((item) => !item.conflictFocus)).toBe(true);
  });
  it('commits departure only once with its evidence bubble for modern messages', () => {
    const base = buildMessage('先说一件事。');
    const segments = splitGeneratedRoundMessage({ ...base,
      messageParts: [{ content: '先说一件事。' }, { content: '我去襄阳了。' }, { content: '我去襄阳了。' }],
      metadata: { activityUpdate: { title: '探路', kind: 'travel', status: 'in_progress', startsNow: true,
        availability: 'away', evidenceText: '我去襄阳了' } },
    });
    expect(segments.map((item) => Boolean(item.metadata?.activityUpdate))).toEqual([false, true, false]);
  });
  it('writes continuity only with the bubble containing its evidence, once', () => {
    const base = buildMessage('先说到这。');
    const segments = splitGeneratedRoundMessage({ ...base, extraMessages: ['我答应明天回来。', '我答应明天回来。'],
      metadata: { ...base.metadata, conversationUpdate: { items: [{ key: 'return', kind: 'commitment', status: 'established',
        participantIds: ['char-1'], summary: '明天回来', evidenceText: '我答应明天回来' }],
        settled: { evidenceText: '先说到这' } } },
    });
    expect(segments[0].metadata?.conversationUpdate?.items).toEqual([]);
    expect(segments[0].metadata?.conversationUpdate?.settled).toBeTruthy();
    expect(segments[1].metadata?.conversationUpdate?.items).toHaveLength(1);
    expect(segments[2].metadata?.conversationUpdate).toBeUndefined();
  });
  it('keeps long speech as one committed bubble when only legacy beat count is requested', () => {
    const content = '不是我说，这个办法能用。但是你得先把前面的坑补上，不然后面全是连环炸。还有，别再把锅扣给别人了。';
    const segments = splitGeneratedMessageText(content, 2);
    expect(segments).toEqual([content]);
  });

  it('splits only when the model provides explicit extra messages', () => {
    const message = {
      ...buildMessage('等下', 3),
      extraMessages: ['你刚说谁来着？', '我没听错吧。'],
    };
    const segments = splitGeneratedRoundMessage(message);

    expect(segments.map((item) => item.content)).toEqual(['等下', '你刚说谁来着？', '我没听错吧。']);
    expect(segments.every((item) => item.extraMessages == null)).toBe(true);
    expect(buildGeneratedTurnContent(message)).toBe('等下\n你刚说谁来着？\n我没听错吧。');
    expect(segments[0]?.metadata?.runtimeDecision).toBeTruthy();
    expect(segments[1]?.metadata?.runtimeDecision).toBeUndefined();
    expect(segments[1]?.metadata?.turnSegment).toEqual({ index: 1, count: 3 });
  });

  it('applies a model-judged incoming impact only to the first committed send', () => {
    const incomingInteractionHint = {
      kind: 'challenge' as const, actorId: 'user', targetId: 'char-1', intensity: 4,
      tone: 'annoyed' as const, evidenceText: '你到底在想什么？', confidence: 0.92,
    };
    const segments = splitGeneratedRoundMessage({ ...buildMessage('等一下'), extraMessages: ['你先听我说'], incomingInteractionHint });
    expect(segments[0].incomingInteractionHint).toEqual(incomingInteractionHint);
    expect(segments[1].incomingInteractionHint).toBeNull();
  });

  it('uses content as the first bubble and extra messages as later bubbles', () => {
    const message = {
      ...buildMessage('原本应该说这句。', 2),
      extraMessages: ['后面补一句。'],
    };

    const segments = splitGeneratedRoundMessage(message);
    expect(segments.map((item) => item.content)).toEqual(['原本应该说这句。', '后面补一句。']);
    expect(segments[0]?.extraMessages).toBeUndefined();
  });

  it('commits messages protocol parts independently and preserves per-part media metadata', () => {
    const message: GeneratedRoundMessage = {
      ...buildMessage('第一句'),
      messageParts: [
        { content: '第一句', metadata: { format: 'plain' } },
        {
          content: '（语音）第二句',
          metadata: {
            generationDecision: { audio: { shouldGenerate: true, text: '第二句' } },
            attachments: [{ id: 'audio-1', kind: 'audio', status: 'queued', altText: '语音：第二句', promptText: '第二句', createdAt: 1, updatedAt: 1 }],
          },
        },
        {
          content: '第三句',
          metadata: { generationDecision: { images: [{ shouldGenerate: true, prompt: '一张图', altText: '一张图' }] } },
        },
      ],
    };
    const segments = splitGeneratedRoundMessage(message);
    expect(segments.map((item) => item.content)).toEqual(['第一句', '（语音）第二句', '第三句']);
    expect(segments[1]?.metadata?.generationDecision?.audio?.shouldGenerate).toBe(true);
    expect(segments[2]?.metadata?.generationDecision?.images?.[0]?.shouldGenerate).toBe(true);
    expect(segments[1]?.metadata?.turnSegment).toEqual({ index: 1, count: 3 });
    expect(buildGeneratedTurnContent(message)).toBe('第一句\n（语音）第二句\n第三句');
  });

  it('limits legacy extra messages to seven later bubbles without dropping generated text', () => {
    const message = {
      ...buildMessage('一', 6),
      extraMessages: ['二', '三', '四', '五', '六'],
    };

    const segments = splitGeneratedRoundMessage(message);
    expect(segments.map((item) => item.content)).toEqual(['一', '二', '三', '四', '五', '六']);
    expect(buildGeneratedTurnContent(message)).toBe('一\n二\n三\n四\n五\n六');
    expect(segments[0]?.extraMessages).toBeUndefined();
  });

  it('keeps short speech as one bubble', () => {
    expect(splitGeneratedMessageText('行吧，那我先看着。', 2)).toEqual(['行吧，那我先看着。']);
  });

  it('preserves comma-boundary text without local splitting or leading text loss', () => {
    const content = '我先说结论，这个点不是不能聊，只是你们现在全在绕开真正的问题，要不先把谁负责讲清楚？';
    expect(splitGeneratedMessageText(content, 3)).toEqual([content]);
  });

  it('keeps turn-level metadata because legacy messageCount creates no secondary segment', () => {
    const message = buildMessage('我先说结论，这个点不是不能聊。只是你们现在全在绕开真正的问题。要不先把谁负责讲清楚？', 2);
    const segments = splitGeneratedRoundMessage(message);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toBe(message);
    expect(segments[0]?.metadata?.runtimeDecision?.innerLife?.impulse).toBe('show_off');
  });

  it('does not split withdrawn or media messages', () => {
    const withdrawn = buildMessage('刚才话重了点。', 2);
    withdrawn.extraMessages = ['我换个说法。'];
    withdrawn.metadata = {
      withdrawal: {
        withdrawn: true,
        originalContent: withdrawn.content,
      },
    };
    expect(splitGeneratedRoundMessage(withdrawn).map((item) => item.content)).toEqual(['刚才话重了点。']);

    const media = buildMessage('看这个图。这个更直观。', 2);
    media.extraMessages = ['你注意这个角度。'];
    media.metadata = {
      generationDecision: {
        image: {
          shouldGenerate: true,
        },
      },
    };
    expect(splitGeneratedRoundMessage(media).map((item) => item.content)).toEqual(['看这个图。这个更直观。\n你注意这个角度。']);
  });

  it('does not split markdown longform messages', () => {
    const message = buildMessage('我把第三幕那场雨先写成这样：\n\n她站在旧站台下面，没有马上回头。广播念到最后一班车时，伞沿的水正好落在鞋尖上。\n\n“你看，”她说，“连天气都比你会道歉。”', 3);
    message.extraMessages = ['这个先别拆。'];
    message.metadata = {
      ...message.metadata,
      format: 'markdown',
    };
    expect(splitGeneratedRoundMessage(message).map((item) => item.content)).toEqual([`${message.content}\n这个先别拆。`]);
  });
});
