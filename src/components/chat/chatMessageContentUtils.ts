import type { Message } from '../../types/message';

const INLINE_ATTACHMENT_PATTERN = /!\[([^\]\n]*)\]\(attachment:(?:\/\/)?([^)]+)\)/g;

export type InlineAttachmentPart =
  | { kind: 'text'; text: string; sourceStart?: number }
  | { kind: 'attachment'; slotId: string; altText: string };

function safeDecodeInlineSlotId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseInlineAttachmentPlaceholders(text: string, includeOffsets = false): InlineAttachmentPart[] {
  const parts: InlineAttachmentPart[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_ATTACHMENT_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({ kind: 'text', text: text.slice(lastIndex, start), ...(includeOffsets ? { sourceStart: lastIndex } : {}) });
    }
    const rawSlotId = (match[2] || '').trim();
    const slotId = rawSlotId ? safeDecodeInlineSlotId(rawSlotId).replace(/[^\w.-]/g, '') : '';
    if (slotId) {
      parts.push({ kind: 'attachment', slotId, altText: (match[1] || '').trim() });
    }
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ kind: 'text', text: text.slice(lastIndex), ...(includeOffsets ? { sourceStart: lastIndex } : {}) });
  }
  return parts.length ? parts : [{ kind: 'text', text, ...(includeOffsets ? { sourceStart: 0 } : {}) }];
}

export function getAttachmentDisplayWidth(params: {
  displaySize?: { width: number; height: number } | null;
  ratioValue: number;
  maxWidth: number;
  maxHeight: number;
}) {
  const widthLimitByHeight = Math.max(1, params.maxHeight * params.ratioValue);
  return Math.ceil(Math.min(params.displaySize?.width || params.maxWidth, params.maxWidth, widthLimitByHeight));
}

export function shouldHideGeneratedMediaPlaceholderText(message: Pick<Message, 'content' | 'metadata'>) {
  const attachments = message.metadata?.attachments || [];
  const hasMediaAttachments = attachments.some((attachment) => attachment.kind === 'image' || attachment.kind === 'sticker' || attachment.kind === 'audio');
  if (!hasMediaAttachments) return false;
  return [
    '正在生成图片，完成后会自动显示。',
    '正在生成图片，完成后会自动显示',
    '对方正在发送图片，稍等一下。',
  ].includes(message.content.trim());
}
