import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';

export const TOPIC_GUIDANCE_SENDER_NAME = '话题引导';
export const TOPIC_GUIDANCE_PROMPT_SPEAKER_NAME = 'Topic guidance';

export function isTopicGuidanceMessage(message: Pick<Message, 'type'>) {
  return message.type === 'god';
}

export function isHumanDirectedMessage(message: Pick<Message, 'type'>) {
  return message.type === 'user' || isTopicGuidanceMessage(message);
}

export function isVisibleDialogueTurn(message: Pick<Message, 'type' | 'isDeleted'>) {
  return !message.isDeleted && (message.type === 'ai' || message.type === 'user');
}

/** Explicit null means no answer is requested; older messages used addressees. */
export function getExplicitReplyTargetIds(message: Message): string[] {
  const targets = 'replyDebtTargetIds' in message
    ? [message.primaryReplyDebtTargetId, ...(message.replyDebtTargetIds || [])]
    : [message.primaryAddressedTargetId, ...(message.addressedTargetIds || [])];
  return Array.from(new Set(targets.filter((id): id is string => Boolean(id))));
}

export function getUserFacingMessageSenderLabel(
  message: Pick<Message, 'type' | 'senderId' | 'senderName'>,
  characters?: Map<string, AICharacter> | AICharacter[],
  fallbackAiLabel = '未知',
) {
  if (message.type === 'user') return '你';
  if (isTopicGuidanceMessage(message)) return TOPIC_GUIDANCE_SENDER_NAME;
  if (message.type === 'system') return '系统';
  if (message.type === 'event') return '事件';
  const characterName = Array.isArray(characters)
    ? characters.find((character) => character.id === message.senderId)?.name
    : characters?.get(message.senderId)?.name;
  return characterName || message.senderName || fallbackAiLabel;
}

export function getTranscriptSpeakerLabel(
  message: Pick<Message, 'type' | 'senderId' | 'senderName'>,
  characters: Map<string, AICharacter>,
  currentSpeakerId?: string,
) {
  if (message.type === 'user') return '用户';
  if (isTopicGuidanceMessage(message)) return TOPIC_GUIDANCE_SENDER_NAME;
  if (message.type === 'system') return 'System';
  if (message.type === 'event') return 'Event';
  if (message.senderId === currentSpeakerId) return '自己';
  return message.senderName || characters.get(message.senderId)?.name || 'Unknown';
}

export function getPromptSpeakerLabel(
  message: Pick<Message, 'type' | 'senderId' | 'senderName'>,
  characters?: Map<string, AICharacter>,
) {
  if (message.type === 'user') return 'User';
  if (isTopicGuidanceMessage(message)) return TOPIC_GUIDANCE_PROMPT_SPEAKER_NAME;
  if (message.type === 'system') return 'System';
  if (message.type === 'event') return 'Event';
  return message.senderName || characters?.get(message.senderId)?.name || 'Unknown';
}

export function getPromptTurnTypeLabel(message: Pick<Message, 'type'>) {
  if (message.type === 'user') return 'human';
  if (isTopicGuidanceMessage(message)) return 'human guidance';
  if (message.type === 'ai') return 'AI';
  return message.type;
}
