import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';
import { collectGuidanceProgressAfterTimestamp, evaluateGuidanceGeneratedContent, evaluateGuidanceMessage, isGuidanceSatisfiedByMessage } from './guidanceExecution';
import { parseUserGuidanceIntent } from './userGuidanceIntent';

function character(id: string, name: string): AICharacter {
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
  };
}

function message(patch: Partial<Message>): Message {
  return {
    id: patch.id || 'm1',
    chatId: 'chat-1',
    type: patch.type || 'ai',
    senderId: patch.senderId || 'mei',
    senderName: patch.senderName || '美羊羊',
    content: patch.content || '',
    emotion: 0,
    timestamp: patch.timestamp || 1,
    isDeleted: false,
    metadata: patch.metadata,
  };
}

describe('guidanceExecution', () => {
  const members = [
    character('mei', '美羊羊'),
    character('hui', '灰太狼'),
    character('jiao', '蕉太狼'),
  ];

  it('does not use local keyword scoring for plain question topic guidance', () => {
    const guidance = parseUserGuidanceIntent('新话题：狼抓羊有过错吗？狼应该抓羊吗？', members);

    expect(evaluateGuidanceGeneratedContent('狼抓羊证件照也挺好玩，灰太狼肯定想把羊画进去吧～', guidance, 'mei', members)).toEqual({
      matched: true,
      reason: 'matched',
    });
  });

  it.skip('legacy text-based image validation is retired', () => {
    const guidance = parseUserGuidanceIntent('美羊羊发个灰太狼证件照的图片', members);

    expect(evaluateGuidanceMessage(message({
      senderId: 'mei',
      senderName: '美羊羊',
      content: '蕉太狼你这一天天的，满脑子都是香蕉，连灰太狼先生的胡子都不放过啦。',
    }), guidance!, members)).toEqual({
      matched: false,
      reason: 'missing_requested_image',
    });
  });

  it.skip('legacy text-based image validation is retired', () => {
    const guidance = parseUserGuidanceIntent('美羊羊发个灰太狼证件照的图片', members);

    expect(evaluateGuidanceMessage(message({
      senderId: 'mei',
      senderName: '美羊羊',
      content: '来啦，我把灰太狼先生的证件照画好了，帽子和胡子都认真画了哦～',
    }), guidance!, members)).toEqual({
      matched: false,
      reason: 'missing_requested_image',
    });
  });

  it('accepts an image task carried by a structured message segment without relying on its prose wording', () => {
    const guidance = parseUserGuidanceIntent('美羊羊发个灰太狼证件照的图片', members);

    expect(evaluateGuidanceGeneratedContent('第二条，给你画一张。', guidance, 'mei', members, {
      mediaCapabilities: { image: true },
      mediaDecisions: [{ images: [{ shouldGenerate: true }] }],
    })).toEqual({
      matched: true,
      reason: 'matched',
    });
  });

  it('allows a requested actor to explicitly report missing image capability', () => {
    const guidance = parseUserGuidanceIntent('美羊羊发个灰太狼证件照的图片', members);

    expect(evaluateGuidanceMessage(message({
      senderId: 'mei',
      senderName: '美羊羊',
      content: '我现在没有图片模型，发不了真正的证件照图片。',
    }), guidance!, members)).toEqual({
      matched: true,
      reason: 'matched',
    });
  });

  it.skip('legacy text-based image validation is retired', () => {
    const guidance = parseUserGuidanceIntent('美羊羊发个灰太狼证件照的图片', members);

    expect(evaluateGuidanceGeneratedContent('来啦，我把蕉太狼的证件照画好了～', guidance, 'mei', members)).toEqual({
      matched: false,
      reason: 'missing_requested_subject',
    });
  });

  it('keeps model-assessed suppression structural without locally guessing guardian semantics', () => {
    const roomMembers = [
      character('anan', '安安'),
      character('zhou', '周策'),
      character('mei', '梅青'),
    ];
    const guidance = {
      kind: 'direct_reply' as const,
      rawText: '我刚才是想听安安说，不是让周策替她做决定。',
      actorIds: ['anan'], mentionedActorIds: ['anan', 'zhou'], suppressedActorIds: ['zhou'],
      focusText: '让安安继续说完', beatType: 'answer' as const, pressure: 0.9, maxTurns: 2,
      reason: '模型识别到用户正在纠正发言对象。',
    };

    expect(evaluateGuidanceGeneratedContent('安安，你继续说完，我先不替你收口。', guidance, 'mei', roomMembers)).toEqual({ matched: true, reason: 'matched' });
    expect(evaluateGuidanceGeneratedContent('我去跟周策说，这段我来安排进附录，后面我负责推进。', guidance, 'mei', roomMembers)).toEqual({
      matched: true,
      reason: 'matched',
    });
    expect(evaluateGuidanceGeneratedContent('这段还是我来定。', guidance, 'zhou', roomMembers)).toEqual({
      matched: false,
      reason: 'suppression_handoff_required',
    });
  });

  it('accepts a matching requested image attachment for runtime guidance consumption', () => {
    const guidance = parseUserGuidanceIntent('美羊羊发个灰太狼证件照的图片', members);

    expect(evaluateGuidanceMessage(message({
      senderId: 'mei',
      senderName: '美羊羊',
      content: '来啦，灰太狼先生的证件照画好了。',
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'queued',
          altText: '灰太狼证件照',
          promptText: '灰太狼证件照',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    }), guidance!, members).matched).toBe(true);
  });

  it('reuses accepted guidanceExecution metadata as completion evidence', () => {
    const guidance = parseUserGuidanceIntent('美羊羊发个灰太狼证件照的图片', members);
    const guidedMessage = message({
      senderId: 'mei',
      senderName: '美羊羊',
      content: '先给你一版草图。',
      metadata: {
        runtimeDecision: {
          directorIntent: {
            source: 'user_message',
            beatType: 'answer',
            targetActorIds: ['mei'],
            pressure: 0.98,
            reason: '用户指定角色发送或创作图片。',
            userGuidance: guidance || undefined,
          },
          guidanceExecution: {
            status: 'accepted',
            validated: true,
            retryCount: 1,
            rejectedDraftCount: 1,
            rejectedReasons: ['missing_requested_image'],
            finalReason: 'matched',
            forcedMediaQueued: true,
          },
        },
      },
    });
    expect(isGuidanceSatisfiedByMessage(guidedMessage, guidance!, members)).toBe(true);
  });

  it('shares completion snapshot for runtime-layer turn consumption', () => {
    const guidance = {
      kind: 'media_request' as const,
      rawText: '让美羊羊和灰太狼都发一张图',
      actorIds: ['mei', 'hui'],
      mentionedActorIds: ['mei', 'hui'],
      focusText: '让美羊羊和灰太狼都发一张图',
      beatType: 'answer' as const,
      pressure: 0.98,
      maxTurns: 2,
      reason: '用户指定角色发送或创作图片。',
      mediaRequest: {
        kind: 'image' as const,
        subjectActorIds: [],
        subjectText: '当前话题',
        actionText: '发一张图',
      },
    };
    const messages: Message[] = [
      message({
        id: 'm-human',
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '让美羊羊和灰太狼都发一张图',
        timestamp: 10,
      }),
      message({
        id: 'm-mei',
        type: 'ai',
        senderId: 'mei',
        senderName: '美羊羊',
        content: '我先来',
        timestamp: 20,
        metadata: {
          attachments: [{
            id: 'img-1',
            kind: 'image',
            status: 'queued',
            altText: '美羊羊自拍',
            promptText: '美羊羊自拍',
            createdAt: 20,
            updatedAt: 20,
          }],
        },
      }),
      message({
        id: 'm-hui',
        type: 'ai',
        senderId: 'hui',
        senderName: '灰太狼',
        content: '我没有图片模型，暂时发不了',
        timestamp: 30,
        metadata: {
          runtimeDecision: {
            directorIntent: { source: 'user_guidance', beatType: 'answer', userGuidance: guidance },
            guidanceExecution: {
              status: 'accepted',
              validated: true,
              retryCount: 0,
              rejectedDraftCount: 0,
              rejectedReasons: [],
              finalReason: 'matched',
              forcedMediaQueued: false,
            },
          },
        },
      }),
    ];
    const progress = collectGuidanceProgressAfterTimestamp(messages, 10, guidance, members);
    expect(progress.consumedTurns).toBe(2);
    expect(Array.from(progress.completedActorIds)).toEqual(['mei', 'hui']);
  });
});
