import type { Message, MessageMetadata } from '../types/message';

export function createChatNoticeMessage(params: {
  id: string;
  chatId: string;
  content: string;
  timestamp: number;
  notice: NonNullable<MessageMetadata['chatNotice']>;
}): Message {
  return {
    id: params.id,
    clientKey: params.id,
    chatId: params.chatId,
    type: 'system',
    senderId: 'system',
    senderName: '提示',
    content: params.content,
    emotion: 0,
    timestamp: params.timestamp,
    isDeleted: false,
    metadata: { chatNotice: params.notice },
  };
}
