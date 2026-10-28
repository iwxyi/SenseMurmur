import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../../types/message';
import { buildImageAttachmentHoverInfo } from '../../services/messageAttachmentHoverInfo';
import { MessageContent } from './ChatMessageContent';
import { getAttachmentDisplayWidth, parseInlineAttachmentPlaceholders, shouldHideGeneratedMediaPlaceholderText } from './chatMessageContentUtils';

describe('ChatMessageContent media layout', () => {
  it('uses a fixed intrinsic media width so fit-content bubbles can shrink', () => {
    expect(getAttachmentDisplayWidth({
      displaySize: { width: 420, height: 420 },
      ratioValue: 1,
      maxWidth: 520,
      maxHeight: 520,
    })).toBe(420);
  });

  it('caps large generated images without relying on percentage width', () => {
    expect(getAttachmentDisplayWidth({
      displaySize: { width: 1600, height: 900 },
      ratioValue: 16 / 9,
      maxWidth: 520,
      maxHeight: 520,
    })).toBe(520);
  });

  it('can cap oversized sticker media to the compact sticker boundary', () => {
    expect(getAttachmentDisplayWidth({
      displaySize: { width: 1024, height: 1024 },
      ratioValue: 1,
      maxWidth: 240,
      maxHeight: 240,
    })).toBe(240);
  });

  it('keeps stickers at their intrinsic size even when metadata dimensions are present', () => {
    const message = {
      id: 'sticker-message', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲',
      content: '', timestamp: 1, emotion: 0, isDeleted: false,
      metadata: { attachments: [{ id: 'sticker-1', kind: 'sticker', status: 'ready', altText: '表情包',
        width: 320, height: 160, url: 'data:image/png;base64,AAA', createdAt: 1, updatedAt: 1 }] },
    } as Message;
    const html = renderToStaticMarkup(createElement(MessageContent, { message }));
    expect(html).not.toContain('aspect-ratio:2/1');
    expect(html).toContain('height:auto');
    expect(html).toContain('aria-label="正在加载表情包"');
  });

  it('does not force a square ratio when sticker dimensions are not available', () => {
    const message = {
      id: 'sticker-message', chatId: 'chat-1', type: 'ai', senderId: 'a', senderName: '甲',
      content: '', timestamp: 1, emotion: 0, isDeleted: false,
      metadata: { attachments: [{ id: 'sticker-1', kind: 'sticker', status: 'ready', altText: '表情包',
        url: 'data:image/png;base64,AAA', createdAt: 1, updatedAt: 1 }] },
    } as Message;
    const html = renderToStaticMarkup(createElement(MessageContent, { message }));
    expect(html).not.toContain('aspect-ratio:1/1');
    expect(html).toContain('height:auto');
  });

  it('hides generated image queue placeholder text when media attachments exist', () => {
    expect(shouldHideGeneratedMediaPlaceholderText({
      content: '正在生成图片，完成后会自动显示。',
      metadata: {
        attachments: [{
          id: 'att-1',
          kind: 'image',
          status: 'ready',
          altText: '红烧肉照片',
          url: 'data:image/png;base64,AAA',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    })).toBe(true);
  });

  it('hides generated media placeholder text for sticker attachments', () => {
    expect(shouldHideGeneratedMediaPlaceholderText({
      content: '正在生成图片，完成后会自动显示。',
      metadata: {
        attachments: [{
          id: 'sticker-1',
          kind: 'sticker',
          status: 'ready',
          altText: '表情包',
          url: 'data:image/png;base64,AAA',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    })).toBe(true);
  });

  it('keeps final generated image captions visible', () => {
    expect(shouldHideGeneratedMediaPlaceholderText({
      content: '图片已生成。',
      metadata: {
        attachments: [{
          id: 'att-1',
          kind: 'image',
          status: 'ready',
          altText: '红烧肉照片',
          url: 'data:image/png;base64,AAA',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    })).toBe(false);
  });

  it('keeps the same text when there is no media attachment', () => {
    expect(shouldHideGeneratedMediaPlaceholderText({
      content: '正在生成图片，完成后会自动显示。',
      metadata: undefined,
    })).toBe(false);
  });

  it('builds hover info from uploaded image summaries and generated prompts', () => {
    expect(buildImageAttachmentHoverInfo({
      id: 'att-1',
      kind: 'image',
      status: 'ready',
      altText: '用户上传图片',
      semanticSummary: '截图里有一段控制台报错。',
      promptText: '不应出现在上传图测试里',
      createdAt: 1,
      updatedAt: 1,
    })).toContain('图片摘要：截图里有一段控制台报错。');

    expect(buildImageAttachmentHoverInfo({
      id: 'att-2',
      kind: 'image',
      status: 'ready',
      altText: '红烧肉照片',
      promptText: '真实红烧肉摄影，酱汁红亮。',
      createdAt: 1,
      updatedAt: 1,
    })).toContain('生成提示词：真实红烧肉摄影，酱汁红亮。');
  });

  it('parses inline markdown attachment placeholders in article content', () => {
    expect(parseInlineAttachmentPlaceholders('开头\n\n![红烧肉成品图](attachment:image-1)\n\n结尾')).toEqual([
      { kind: 'text', text: '开头\n\n' },
      { kind: 'attachment', slotId: 'image-1', altText: '红烧肉成品图' },
      { kind: 'text', text: '\n\n结尾' },
    ]);
  });

  it('sanitizes malformed inline attachment slot ids without throwing', () => {
    expect(parseInlineAttachmentPlaceholders('![图](attachment:%E0%A4%A../bad id)')).toEqual([
      { kind: 'attachment', slotId: 'E0A4A..badid', altText: '图' },
    ]);
  });

});
