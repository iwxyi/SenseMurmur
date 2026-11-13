import type { Message } from '../../types/message';
import { isNarrativeParagraphMessage } from './messageBubblePresentation';

export type ChatTimelinePresentation =
  | { family: 'bubble'; placement: 'left' | 'right'; kind: 'message' }
  | { family: 'center'; placement: 'center'; kind: 'system' | 'notice' | 'event' | 'narrative' };

/** Message meaning stays in Message.type; this only selects its timeline layout. */
export function resolveChatTimelinePresentation(message: Message, options?: { selfMemberId?: string | null }): ChatTimelinePresentation {
  if (message.metadata?.chatNotice) return { family: 'center', placement: 'center', kind: 'notice' };
  if (message.type === 'system') return { family: 'center', placement: 'center', kind: 'system' };
  if (isNarrativeParagraphMessage(message)) return { family: 'center', placement: 'center', kind: 'narrative' };
  if (message.type === 'event') return { family: 'center', placement: 'center', kind: 'event' };
  const isOwnMessage = message.type === 'user' || message.type === 'god'
    || Boolean(options?.selfMemberId && message.type === 'ai' && message.senderId === options.selfMemberId);
  return { family: 'bubble', placement: isOwnMessage ? 'right' : 'left', kind: 'message' };
}
