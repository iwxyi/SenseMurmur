import type { Message } from '../types/message';

export interface DuplicateGuardResult {
  blocked: boolean;
  reason: string | null;
}

export function evaluateDuplicateGuard(params: {
  content: string;
  messages: Message[];
  speakerId: string;
  intentionalRepeat?: boolean;
}): DuplicateGuardResult {
  if (params.intentionalRepeat) return { blocked: false, reason: null };
  const draft = params.content.trim();
  if (!draft) return { blocked: false, reason: null };
  const recentOwn = params.messages
    .filter((message) => message.type === 'ai' && !message.isDeleted && message.senderId === params.speakerId)
    .slice(-3);
  if (recentOwn.some((message) => message.content.trim() === draft)) {
    return { blocked: true, reason: "The draft exactly repeats the speaker's recent line." };
  }
  return { blocked: false, reason: null };
}
