import type { Message } from '../../types/message';
import { isNarrativeParagraphMessage } from './messageBubblePresentation';

export type ChatMessageTimelinePresentation =
  | { family: 'bubble'; variant: 'message'; placement: 'left' | 'right' }
  | { family: 'center'; variant: 'system' | 'notice' | 'event' | 'narrative'; placement: 'center' };

export type ChatTimelinePresentation = ChatMessageTimelinePresentation
  | { family: 'center'; variant: 'story-choice' | 'story-progress'; placement: 'center' };

/** Message meaning stays in Message.type; this only selects its timeline layout. */
export function resolveChatTimelinePresentation(message: Message, options?: { selfMemberId?: string | null }): ChatMessageTimelinePresentation {
  if (message.metadata?.chatNotice) return { family: 'center', placement: 'center', variant: 'notice' };
  if (message.type === 'system') return { family: 'center', placement: 'center', variant: 'system' };
  if (isNarrativeParagraphMessage(message)) return { family: 'center', placement: 'center', variant: 'narrative' };
  if (message.type === 'event') return { family: 'center', placement: 'center', variant: 'event' };
  const isOwnMessage = message.type === 'user' || message.type === 'god'
    || Boolean(options?.selfMemberId && message.type === 'ai' && message.senderId === options.selfMemberId);
  return { family: 'bubble', placement: isOwnMessage ? 'right' : 'left', variant: 'message' };
}
