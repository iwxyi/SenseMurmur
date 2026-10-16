export type ChatReplyPreferenceMode = 'default' | 'custom' | 'off';

export interface ChatReplyPreferences {
  mode: ChatReplyPreferenceMode;
  text: string;
}

export const MAX_CHAT_REPLY_PREFERENCE_LENGTH = 6000;

// Previous default retained while the shorter conversational guidance is evaluated:
// export const DEFAULT_CHAT_REPLY_PREFERENCE_TEXT = '按角色自己的说话习惯接话，直接说这次在意的内容。普通闲聊可以只回应一个点，一句反应够了就停；需要解释或完成具体请求时，保留必要细节。少用没有信息的铺垫、重复认可、抽象升华和固定收尾，不为了继续聊而硬加问题、条件或任务。中文表达尽量直接、具体，避免空泛套话和生硬翻译腔。不要靠硬加语气词、错别字、动作或虚构经历显得自然。角色可以克制、正式或健谈，不必人人俏皮，也不必刻意缩短。';
export const DEFAULT_CHAT_REPLY_PREFERENCE_TEXT = '按角色自己的说话习惯聊天，中文表达直接、自然。闲聊不必写成专业讲解；用户明确要求详细内容时充分回答。';

export const DEFAULT_CHAT_REPLY_PREFERENCES: ChatReplyPreferences = { mode: 'default', text: '' };

export function normalizeChatReplyPreferenceText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_CHAT_REPLY_PREFERENCE_LENGTH) : '';
}

export function normalizeChatReplyPreferences(value?: Partial<ChatReplyPreferences> | null): ChatReplyPreferences {
  return {
    mode: value?.mode === 'custom' || value?.mode === 'off' ? value.mode : 'default',
    text: normalizeChatReplyPreferenceText(value?.text),
  };
}

export function resolveChatReplyPreferenceText(value: ChatReplyPreferences): string {
  if (value.mode === 'off') return '';
  return value.mode === 'default' ? DEFAULT_CHAT_REPLY_PREFERENCE_TEXT : value.text;
}
