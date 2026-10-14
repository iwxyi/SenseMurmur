import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/message';
import { getAttachmentErrorText, getAttachmentStatusDetail, getAttachmentStatusLabel } from '../../services/messageAttachmentDisplay';
import { getNarrativeDisplayBlocks, getNarrativeParagraphBlocks, hasNarrativeReaderBlocks, isNarrativeParagraphMessage, shouldUseCompactMediaBubble, shouldUseCompactMessageBubble } from './messageBubblePresentation';
import { buildEventDisplayText, buildMemoryDistillationMeta, shouldHideEmptyConflictEvent } from './messageBubbleEventHelpers';

describe('MessageBubble event rendering', () => {
  it('formats memory distillation titles with readable source and owner labels', () => {
    const text = buildEventDisplayText({
      eventType: 'memory_distillation',
      title: '',
      summary: '',
      metrics: {
        sourceLabel: 'LLM 蒸馏',
        ownerLabel: '角色：甲',
        reasonLabel: '已完成 LLM 蒸馏',
      },
    });

    expect(text).toBe('LLM角色蒸馏 · 甲');
  });

  it('formats memory distillation owner ids with member names when available', () => {
    const text = buildEventDisplayText({
      eventType: 'memory_distillation',
      title: '',
      summary: '',
      metrics: {
        sourceLabel: 'LLM 蒸馏',
        ownerType: 'character',
        ownerName: '3c78729f-e52d-4dde-b27f-01a949960bb8b',
        reasonLabel: '已完成 LLM 蒸馏',
      },
    }, [{ id: '3c78729f-e52d-4dde-b27f-01a949960bb8b', name: '喜羊羊' }]);

    expect(text).toBe('LLM角色蒸馏 · 喜羊羊');
  });

  it('formats local memory distillation titles distinctly from LLM distillation', () => {
    const text = buildEventDisplayText({
      eventType: 'memory_distillation',
      title: '',
      summary: '',
      metrics: {
        ownerType: 'chat',
        sourceLabel: '本地蒸馏',
        ownerLabel: '群聊：羊村大家庭闲聊',
        reasonLabel: '已完成本地蒸馏',
      },
    });

    expect(text).toBe('本地群聊蒸馏');
  });

  it('cleans distillation candidate texts before rendering them', () => {
    const meta = buildMemoryDistillationMeta({
      metrics: {
        ownerType: 'chat',
        ownerLabel: '群聊：羊村大家庭闲聊',
        sourceLabel: '本地蒸馏',
        reasonLabel: '已完成本地蒸馏',
        mergeModeLabel: '同 bucket 强化合并',
        newEvidenceCount: 11,
        candidateTexts: [
          '群聊稳定关系趋势：灰太狼→沸羊羊 支持：灰太狼 → 沸羊羊 · 哟，沸羊羊你今天站我这边了？ / 3c78729f-e52d-4dde-b27f-01a949960b',
          '群聊稳定关系趋势：灰太狼→沸羊羊 支持：灰太狼 → 沸羊羊 · 哟，沸羊羊你今天站我这边了？ / 3c78729f-e52d-4dde-b27f-01a949960b',
        ],
      },
    });

    expect(meta?.candidateTexts).toEqual([
      '群聊稳定关系趋势：灰太狼→沸羊羊 支持：灰太狼 → 沸羊羊 · 哟，沸羊羊你今天站我这边了？',
    ]);
  });

  it('removes raw relationship ids from distillation candidate text', () => {
    const meta = buildMemoryDistillationMeta({
      metrics: {
        ownerType: 'character',
        ownerLabel: '角色：灰太狼',
        sourceLabel: '本地蒸馏',
        reasonLabel: '已完成本地蒸馏',
        mergeModeLabel: '同 bucket 强化合并',
        newEvidenceCount: 4,
        candidateTexts: [
          '对人长期判断：对 257eb99a-9f5f-48b2-be44-7e98395aa8ba 的关系倾向：表现出挑衅；证据是近期发言“你好” / 19b22fbd-9d0c-45',
        ],
      },
    });

    expect(meta?.candidateTexts).toEqual([
      '表现出挑衅；证据是近期发言“你好”',
    ]);
  });

  it('keeps empty conflict events out of display when nothing meaningful exists', () => {
    const shouldHide = shouldHideEmptyConflictEvent({
      eventType: 'conflict_focus_shift',
      summary: '',
      metrics: {},
    });

    expect(shouldHide).toBe(true);
  });

  it('uses the concrete attachment error for failed media placeholders', () => {
    expect(getAttachmentErrorText({ error: '图片模型未配置' })).toBe('图片模型未配置');
  });

  it('falls back to a useful failed media message when no concrete error exists', () => {
    expect(getAttachmentErrorText({ error: '   ' })).toBe('生成任务失败，请检查模型配置或稍后重试。');
  });

  it('formats attachment status labels and details for queued and failed media', () => {
    expect(getAttachmentStatusLabel({ kind: 'image', status: 'queued' })).toBe('对方正在发送图片…');
    expect(getAttachmentStatusDetail({ kind: 'image', status: 'queued' })).toBe('对方正在发送图片，稍等一下。');
    expect(getAttachmentStatusLabel({ kind: 'audio', status: 'generating' })).toBe('对方正在讲话…');
    expect(getAttachmentStatusDetail({ kind: 'audio', status: 'failed', error: '语音模型未配置' })).toBe('语音模型未配置');
  });

  it('uses compact bubble layout for generated image status messages', () => {
    const message: Message = {
      id: 'm-image',
      chatId: 'c1',
      senderId: 'assistant',
      senderName: '助手',
      type: 'ai',
      content: '正在生成红烧肉的照片，请稍候。\n\n图片已生成\n红烧肉照片',
      timestamp: 1,
      emotion: 0,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'att-1',
          kind: 'image',
          status: 'ready',
          altText: '红烧肉照片',
          url: 'data:image/png;base64,AAA',
          width: 512,
          height: 512,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    };

    expect(shouldUseCompactMediaBubble(message)).toBe(true);
  });

  it('uses the compact media layout for sticker-only messages', () => {
    const message: Message = {
      id: 'm-sticker',
      emotion: 0,
      isDeleted: false,
      chatId: 'c1',
      senderId: 'assistant',
      senderName: '助手',
      type: 'ai',
      content: '',
      timestamp: 1,
      metadata: {
        attachments: [{
          id: 'sticker-1',
          kind: 'sticker',
          status: 'ready',
          altText: '表情包',
          url: 'data:image/png;base64,AAA',
          width: 1024,
          height: 1024,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    };

    expect(shouldUseCompactMediaBubble(message)).toBe(true);
  });

  it('keeps rich markdown media messages on the normal text layout', () => {
    const message: Message = {
      id: 'm-markdown-image',
      chatId: 'c1',
      senderId: 'assistant',
      senderName: '助手',
      type: 'ai',
      content: '## 分析报告\n\n这张图片包含以下重点，需要按正文宽度阅读。',
      timestamp: 1,
      emotion: 0,
      isDeleted: false,
      metadata: {
        attachments: [{
          id: 'att-1',
          kind: 'image',
          status: 'ready',
          altText: '分析图',
          url: 'data:image/png;base64,AAA',
          width: 512,
          height: 512,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    };

    expect(shouldUseCompactMediaBubble(message)).toBe(false);
  });

  it('applies compact private bubble mode to direct chats without a self member id', () => {
    expect(shouldUseCompactMessageBubble({
      compactBubbleMode: false,
      compactPrivateBubbleMode: true,
      privateConversation: true,
      selfMemberId: null,
      isUser: false,
      isGuidanceBubble: false,
    })).toBe(true);
  });

  it('does not compact user or guidance bubbles in compact private bubble mode', () => {
    const base = {
      compactBubbleMode: false,
      compactPrivateBubbleMode: true,
      privateConversation: true,
      selfMemberId: null,
    };

    expect(shouldUseCompactMessageBubble({
      ...base,
      isUser: true,
      isGuidanceBubble: false,
    })).toBe(false);
    expect(shouldUseCompactMessageBubble({
      ...base,
      isUser: false,
      isGuidanceBubble: true,
    })).toBe(false);
  });

  it('renders narrative metadata as ordered paragraphs and character bubbles', () => {
    const characterMessage: Message = {
      id: 'm1',
      chatId: 'c1',
      senderId: 'narrator',
      senderName: '旁白',
      type: 'ai' as const,
      content: '',
      timestamp: 1,
      emotion: 0,
      isDeleted: false,
      metadata: {
        narrativeTurn: {
          turnId: 'turn-1',
          turnKind: 'narrative_beat' as const,
          povActorId: 'narrator',
          blocks: [
            { id: 'b1', actorId: 'narrator', actorKind: 'narrator' as const, kind: 'prose' as const, displayMode: 'paragraph' as const, text: '角色推开门。' },
            { id: 'b2', actorId: 'char-1', actorName: '角色', actorKind: 'character' as const, kind: 'dialogue' as const, displayMode: 'bubble' as const, text: '我听见里面有人。' },
          ],
        },
      },
    };

    expect(isNarrativeParagraphMessage(characterMessage)).toBe(true);
    expect(getNarrativeParagraphBlocks(characterMessage)).toEqual([
      expect.objectContaining({ actorKind: 'narrator', displayMode: 'paragraph', text: '角色推开门。' }),
      expect.objectContaining({ actorKind: 'character', displayMode: 'bubble', actorName: '角色', text: '我听见里面有人。' }),
    ]);
  });

  it('keeps mixed story narration and speech as display blocks for the narrator turn', () => {
    const message: Message = {
      id: 'm-story',
      chatId: 'c1',
      senderId: 'narrator',
      senderName: '旁白',
      type: 'ai',
      content: '雨声压低了整条走廊。',
      timestamp: 1,
      emotion: 0,
      isDeleted: false,
      metadata: {
        narrativeTurn: {
          turnId: 'turn-story',
          turnKind: 'narrative_beat',
          povActorId: 'narrator',
          blocks: [
            { id: 'b1', actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: '雨声压低了整条走廊。' },
            { id: 'b2', actorId: 'lin', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', characterId: 'lin', text: '不要开那扇门。' },
            { id: 'b3', actorId: 'narrator', actorKind: 'system', kind: 'system_note', displayMode: 'system_panel', text: '新的抉择点\n前情：走廊尽头还有灯光。' },
          ],
        },
      },
    };

    expect(getNarrativeParagraphBlocks(message)).toHaveLength(2);
    expect(getNarrativeParagraphBlocks(message)).toEqual([
      expect.objectContaining({ actorKind: 'narrator', displayMode: 'paragraph' }),
      expect.objectContaining({ actorKind: 'system', displayMode: 'system_panel', text: expect.stringContaining('新的抉择点') }),
    ]);
    expect(getNarrativeDisplayBlocks(message)).toEqual([
      expect.objectContaining({ actorKind: 'narrator', displayMode: 'paragraph' }),
      expect.objectContaining({ actorKind: 'character', displayMode: 'bubble', characterId: 'lin' }),
      expect.objectContaining({ actorKind: 'system', displayMode: 'system_panel' }),
    ]);
    expect(hasNarrativeReaderBlocks(getNarrativeDisplayBlocks(message))).toBe(true);
  });

  it('does not route story character-only bubble blocks through the paragraph reader', () => {
    const message: Message = {
      id: 'm-story-bubbles',
      chatId: 'c1',
      senderId: 'narrator',
      senderName: '旁白',
      type: 'ai',
      content: '',
      timestamp: 1,
      emotion: 0,
      isDeleted: false,
      metadata: {
        narrativeTurn: {
          turnId: 'turn-bubbles',
          turnKind: 'narrative_beat',
          povActorId: 'narrator',
          blocks: [
            { id: 'b1', actorId: 'lin', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', characterId: 'lin', text: '别出声。' },
            { id: 'b2', actorId: 'chen', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', characterId: 'chen', text: '灯又灭了。' },
          ],
        },
      },
    };

    expect(isNarrativeParagraphMessage(message)).toBe(true);
    expect(getNarrativeDisplayBlocks(message)).toEqual([
      expect.objectContaining({ displayMode: 'bubble', text: '别出声。' }),
      expect.objectContaining({ displayMode: 'bubble', text: '灯又灭了。' }),
    ]);
    expect(hasNarrativeReaderBlocks(getNarrativeDisplayBlocks(message))).toBe(false);
  });

  it('falls back to message content when compacted narrative metadata omits blocks', () => {
    const message: Message = {
      id: 'm-compacted-story',
      chatId: 'c1',
      senderId: 'narrator',
      senderName: '旁白',
      type: 'ai',
      content: '井口的青石重新合上，雨声压低了整条走廊。',
      timestamp: 1,
      emotion: 0,
      isDeleted: false,
      metadata: {
        narrativeTurn: {
          turnId: 'turn-compacted',
          turnKind: 'narrative_beat',
          povActorId: 'narrator',
          blocks: [],
        },
      },
    };

    expect(isNarrativeParagraphMessage(message)).toBe(true);
    expect(getNarrativeDisplayBlocks(message)).toEqual([
      expect.objectContaining({
        actorKind: 'narrator',
        displayMode: 'paragraph',
        text: '井口的青石重新合上，雨声压低了整条走廊。',
      }),
    ]);
  });

  it('treats streaming narrator messages as narrative paragraphs before metadata is committed', () => {
    const message: Message = {
      id: 'm-stream',
      chatId: 'c1',
      senderId: 'narrator',
      senderName: '旁白',
      type: 'ai',
      content: '雨声沿着屋檐落下。',
      timestamp: 1,
      emotion: 0,
      isDeleted: false,
      isStreaming: true,
    };

    expect(isNarrativeParagraphMessage(message)).toBe(true);
    expect(getNarrativeParagraphBlocks(message)).toEqual([expect.objectContaining({ actorKind: 'narrator', text: '雨声沿着屋檐落下。' })]);
  });

  it('renders story choice selections as narrative choice cards', () => {
    const message: Message = {
      id: 'm-choice',
      chatId: 'c1',
      senderId: 'user',
      senderName: '我',
      type: 'user',
      content: '我选择：追问护士停电记录',
      timestamp: 1,
      emotion: 0,
      isDeleted: false,
      metadata: {
        storyChoiceSelection: {
          branchId: 'branch-1',
          label: '追问护士停电记录',
          prompt: '护士说出停电时有人进入档案室',
          intent: '逼问',
          risk: '激怒护士',
          reward: '得到停电线索',
          choiceEpoch: 2,
        },
      },
    };

    expect(isNarrativeParagraphMessage(message)).toBe(true);
    expect(getNarrativeParagraphBlocks(message)).toEqual([
      expect.objectContaining({
        actorKind: 'director',
        displayMode: 'choice_card',
        kind: 'choice',
        text: '追问护士停电记录',
        choices: [expect.objectContaining({
          id: 'branch-1',
          intent: '逼问',
          risk: '激怒护士',
          reward: '得到停电线索',
        })],
      }),
    ]);
  });
});
