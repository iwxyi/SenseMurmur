import type { Message, NarrativeBlock } from '../../types/message';
import { parseRuntimeEvent } from '../../services/runtimeEventFactory';

export interface NarrativeStoryChoiceOption {
  label: string;
  value: string;
  prompt?: string | null;
  intent?: string | null;
  risk?: string | null;
  reward?: string | null;
}

function getStoryEventText(message: Message) {
  if (message.type !== 'event') return '';
  const event = parseRuntimeEvent(message.content);
  if (!event?.channelId?.startsWith('story:')) return '';
  if (event.visibilityScope !== 'public' && event.visibilityScope !== 'derived_public') return '';
  return (event.summary || event.title || '').trim();
}

function getNarrativeTurnVisibleBlocks(message: Message) {
  const turn = message.metadata?.narrativeTurn;
  return turn?.blocks?.filter((block) => (block.displayMode === 'paragraph' || block.displayMode === 'bubble' || block.displayMode === 'system_panel') && block.text.trim()) || [];
}

export function isNarrativeParagraphMessage(message: Message) {
  return Boolean(message.metadata?.storyChoiceSelection || getNarrativeTurnVisibleBlocks(message).length || (message.type === 'ai' && message.senderId === 'narrator') || getStoryEventText(message));
}

export function getNarrativeParagraphBlocks(message: Message): NarrativeBlock[] {
  const selection = message.metadata?.storyChoiceSelection;
  if (selection?.label) {
    return [{
      id: `${message.id}:story-choice-selection`,
      actorId: 'user',
      actorKind: 'director',
      kind: 'choice',
      displayMode: 'choice_card',
      text: selection.label,
      choices: [{
        id: selection.branchId || `${message.id}:choice`,
        label: selection.label,
        prompt: selection.prompt || undefined,
        intent: selection.intent || null,
        risk: selection.risk || null,
        reward: selection.reward || null,
      }],
    }];
  }
  const allNarrativeTurnBlocks = getNarrativeTurnVisibleBlocks(message);
  const hasStoryEventBubbleBlocks = allNarrativeTurnBlocks.some((block) => block.displayMode === 'bubble' && block.characterId && !block.actorName);
  const narrativeTurnBlocks = message.metadata?.narrativeTurn?.povActorId === 'narrator' && hasStoryEventBubbleBlocks
    ? allNarrativeTurnBlocks.filter((block) => block.displayMode === 'paragraph' || block.displayMode === 'system_panel')
    : allNarrativeTurnBlocks;
  if (narrativeTurnBlocks.length) return narrativeTurnBlocks;
  const storyEventText = getStoryEventText(message);
  if (storyEventText) {
    return [{
      id: `${message.id}:story-event`,
      actorId: 'narrator',
      actorKind: 'narrator',
      kind: 'action',
      displayMode: 'paragraph',
      text: storyEventText,
    }];
  }
  const text = message.content.trim();
  if (!isNarrativeParagraphMessage(message) || !text) return [];
  return [{
    id: `${message.id}:narrator`,
    actorId: 'narrator',
    actorKind: 'narrator',
    kind: 'prose',
    displayMode: 'paragraph',
    text,
  }];
}

export function getNarrativeDisplayBlocks(message: Message): NarrativeBlock[] {
  const turn = message.metadata?.narrativeTurn;
  if (turn?.povActorId === 'narrator' && turn.blocks?.length) {
    return turn.blocks.filter((block) => block.text.trim() && block.displayMode !== 'hidden');
  }
  return getNarrativeParagraphBlocks(message);
}

export function hasNarrativeReaderBlocks(blocks: NarrativeBlock[]) {
  return blocks.some((block) => block.displayMode !== 'bubble');
}

export function shouldUseCompactMessageBubble(options: {
  compactBubbleMode: boolean;
  compactPrivateBubbleMode: boolean;
  privateConversation: boolean;
  selfMemberId?: string | null;
  isUser: boolean;
  isGuidanceBubble: boolean;
}) {
  const isPrivateConversation = options.privateConversation || options.selfMemberId !== null;
  return (options.compactBubbleMode && !options.isUser && !options.isGuidanceBubble)
    || (options.compactPrivateBubbleMode && isPrivateConversation && !options.isUser && !options.isGuidanceBubble);
}

const SHORT_MEDIA_MESSAGE_LENGTH = 120;

export function shouldUseCompactMediaBubble(message: Message) {
  const attachments = message.metadata?.attachments || [];
  const hasRenderableMedia = attachments.some((attachment) => attachment.kind === 'image' || attachment.kind === 'sticker' || attachment.kind === 'audio' || attachment.kind === 'video');
  if (!hasRenderableMedia) return false;
  const rawContent = message.content.trim();
  const normalizedContent = rawContent.replace(/\s+/g, '').trim();
  if (!normalizedContent) return true;
  if (['图片已生成', '图片已生成。', '已生成', '已生成。'].includes(normalizedContent)) return true;
  if (/正在生成图片|图片已生成/.test(normalizedContent)) return true;
  if (/```|(^|\n)\s{0,3}#{1,6}\s|(^|\n)\s{0,3}\|.*\|/.test(rawContent)) return false;
  return normalizedContent.length <= SHORT_MEDIA_MESSAGE_LENGTH;
}
