import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { getTranscriptSpeakerLabel, isHumanDirectedMessage } from './chatMessageSemantics';

export type ProjectedChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<{
    url: string;
    mimeType?: string;
  }>;
};

export interface ConversationProjectionOptions {
  currentSpeakerId?: string;
  chatType?: GroupChat['type'];
  imageAttachmentMode?: 'none' | 'latest-user' | 'all';
  historyFormat?: 'room-record';
}

export interface ConversationProjectionInput {
  messages: Message[];
  characters: Map<string, AICharacter>;
  limit?: number;
  options?: ConversationProjectionOptions;
}

function stripEmbeddedTranscriptJson(content: string) {
  const normalized = content || '';
  const roleMarker = normalized.search(/["“]?role["”]?\s*:\s*["“](assistant|user|system)["”]/i);
  if (roleMarker >= 0) return normalized.slice(0, roleMarker).trim();
  return normalized;
}

function compactTranscriptContent(content: string, max = 1400) {
  const trimmed = stripEmbeddedTranscriptJson(content).trim();
  if (Array.from(trimmed).length <= max) return trimmed;
  return `${Array.from(trimmed).slice(0, max).join('')}...`;
}

function buildTranscriptHeader(message: Message, characters: Map<string, AICharacter>, currentSpeakerId?: string) {
  return getTranscriptSpeakerLabel(message, characters, currentSpeakerId);
}

function buildImageAttachmentText(message: Message) {
  const attachments = (message.metadata?.attachments || [])
    .filter((attachment) => attachment.kind === 'image' && attachment.status !== 'deleted' && attachment.status !== 'failed');
  if (!attachments.length) return '';
  return attachments
    .slice(0, 4)
    .map((attachment, index) => `[图片] ${attachment.caption || attachment.altText || `图片 ${index + 1}`}`)
    .join('\n');
}

function buildAudioAttachmentText(message: Message) {
  const attachments = (message.metadata?.attachments || [])
    .filter((attachment) => attachment.kind === 'audio' && attachment.status !== 'deleted' && attachment.status !== 'failed');
  if (!attachments.length) return '';
  return attachments
    .slice(0, 4)
    .map((attachment) => `[语音] ${attachment.promptText || attachment.caption || attachment.altText || '语音内容'}`)
    .join('\n');
}

function buildOtherAttachmentText(message: Message) {
  const attachments = (message.metadata?.attachments || [])
    .filter((attachment) => attachment.kind === 'sticker' && attachment.status !== 'deleted' && attachment.status !== 'failed');
  return attachments
    .slice(0, 4)
    .map((attachment) => `[表情] ${attachment.caption || attachment.altText || '表情'}`)
    .join('\n');
}

function buildTranscriptLine(message: Message, characters: Map<string, AICharacter>, currentSpeakerId?: string) {
  return `${buildTranscriptHeader(message, characters, currentSpeakerId)}: ${[compactTranscriptContent(message.content), buildImageAttachmentText(message), buildAudioAttachmentText(message), buildOtherAttachmentText(message)].filter(Boolean).join('\n')}`;
}

function buildAssistantHistoryPrompt(history: string) {
  return history;
}

function isVisibleMessage(message: Message) {
  if (message.isDeleted) return false;
  if (message.type === 'system' || message.type === 'event') return false;
  return true;
}

function buildProjectedImageAttachments(message: Message) {
  const attachments = (message.metadata?.attachments || [])
    .filter((attachment) => attachment.kind === 'image' && attachment.url && attachment.status !== 'deleted' && attachment.status !== 'failed')
    .map((attachment) => ({ url: attachment.url as string, mimeType: attachment.mimeType }))
    .slice(0, 8);
  return attachments.length ? attachments : undefined;
}

function shouldProjectImageAttachments(message: Message, visible: Message[], mode: ConversationProjectionOptions['imageAttachmentMode']) {
  if (mode === 'all') return true;
  if (mode !== 'latest-user') return false;
  const latestUserImageMessage = [...visible]
    .reverse()
    .find((item) => (
      isHumanDirectedMessage(item)
      && item.metadata?.attachments?.some((attachment) => attachment.kind === 'image' && attachment.url && attachment.status !== 'deleted' && attachment.status !== 'failed')
    ));
  return Boolean(latestUserImageMessage && latestUserImageMessage.id === message.id);
}

export function projectConversationForModel(input: ConversationProjectionInput): ProjectedChatMessage[] {
  const visible = input.messages
    .filter(isVisibleMessage)
    .slice(-(input.limit ?? 12));
  const options = input.options || {};
  const currentSpeakerId = options.currentSpeakerId;
  if (options.historyFormat === 'room-record') {
    if (!visible.length) return [];
    // Separate the latest speaker's consecutive sends from earlier context.
    // This is a chronological boundary, not a restriction on reply targets.
    const latest = visible[visible.length - 1];
    let recentStart = visible.length - 1;
    while (recentStart > 0 && visible[recentStart - 1].senderId === latest.senderId
      && visible[recentStart - 1].type === latest.type) recentStart -= 1;
    const sections = [
      { messages: visible.slice(0, recentStart), label: 'earlier sends, already said' },
      { messages: visible.slice(recentStart), label: 'most recent sends' },
    ];
    return sections.filter(section => section.messages.length).map((section): ProjectedChatMessage => {
      const attachments: NonNullable<ProjectedChatMessage['attachments']> = [];
      const sends = section.messages.map((message) => {
        const images = shouldProjectImageAttachments(message, visible, options.imageAttachmentMode)
          ? buildProjectedImageAttachments(message) : undefined;
        const imageStart = attachments.length;
        if (images) attachments.push(...images);
        return {
          speaker: buildTranscriptHeader(message, input.characters, currentSpeakerId),
          content: [compactTranscriptContent(message.content), buildImageAttachmentText(message),
            buildAudioAttachmentText(message), buildOtherAttachmentText(message)].filter(Boolean).join('\n'),
          ...(images ? { imageNumbers: images.map((_, index) => imageStart + index + 1) } : {}),
        };
      });
      return {
        role: 'user',
        content: `Room transcript (${section.label}; oldest first; each entry is one recorded send):\n${JSON.stringify(sends)}`,
        ...(attachments.length ? { attachments } : {}),
      };
    });
  }
  const projected: ProjectedChatMessage[] = [];
  // Channel instructions belong to the system prompt. Every projected item
  // corresponds to a visible send, including consecutive sends by one person.
  for (const message of visible) {
    const attachments = shouldProjectImageAttachments(message, visible, options.imageAttachmentMode)
      ? buildProjectedImageAttachments(message)
      : undefined;
    if (message.type === 'ai' && currentSpeakerId && message.senderId === currentSpeakerId) {
      projected.push({
        role: 'assistant',
        content: buildAssistantHistoryPrompt([compactTranscriptContent(message.content), buildImageAttachmentText(message), buildAudioAttachmentText(message), buildOtherAttachmentText(message)].filter(Boolean).join('\n')),
        ...(attachments ? { attachments } : {}),
      });
      continue;
    }
    projected.push({
      role: 'user',
      content: buildTranscriptLine(message, input.characters, currentSpeakerId),
      ...(attachments ? { attachments } : {}),
    });
  }
  return projected;
}
