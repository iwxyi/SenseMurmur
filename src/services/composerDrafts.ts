import type { CharacterMention, MessageAttachment } from '../types/message';
import { getLocalDataUserId } from './authStorageScope';

export interface ComposerDraft { text: string; mentions: CharacterMention[]; attachments: MessageAttachment[] }
const drafts = new Map<string, ComposerDraft>();
export function composerDraftKey(chatId: string, mode: string) { return `${getLocalDataUserId()}:${chatId}:${mode}`; }
export function readComposerDraft(key?: string): ComposerDraft { return (key && drafts.get(key)) || { text: '', mentions: [], attachments: [] }; }
export function saveComposerDraft(key: string | undefined, draft: ComposerDraft) {
  if (!key) return;
  drafts.delete(key);
  if (draft.text || draft.attachments.length) drafts.set(key, draft);
  if (drafts.size > 32) drafts.delete(drafts.keys().next().value!);
}
