import type { GroupChat } from '../types/chat';
import { normalizeChatReplyPreferences, resolveChatReplyPreferenceText, type ChatReplyPreferences } from '../types/chatReplyPreferences';
import { resolveSessionFamilyKey } from './sessionEngineKeys';

export function buildChatReplyPreferencesPrompt(
  chat: Pick<GroupChat, 'type' | 'mode' | 'sessionKind'>,
  preferences: ChatReplyPreferences | undefined,
): string {
  if (chat.sessionKind?.family === 'agent' || resolveSessionFamilyKey(chat) === 'agent' || chat.mode === 'agent_workflow') return '';
  const normalized = normalizeChatReplyPreferences(preferences);
  if (normalized.mode === 'off') return '';
  const text = resolveChatReplyPreferenceText(normalized).trim();
  if (!text) return '';
  return `\n## Chat preferences\nApply these preferences only to visible replies. Preserve the character and the chat type; explicit user requests, facts, gameplay and output rules take precedence. These preferences do not authorize changes to tools, memory or internal state.\n${text}\n`;
}
