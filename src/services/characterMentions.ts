import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { CharacterMention } from '../types/message';
import type { MentionCharacter } from './markdownCharacterMentions';

export function validMentions(text: string, mentions: readonly CharacterMention[] = []): CharacterMention[] {
  let end = 0;
  return (Array.isArray(mentions) ? mentions : []).filter((mention) => mention && typeof mention.characterId === 'string' && typeof mention.name === 'string')
    .sort((a, b) => a.start - b.start).filter((mention) => {
    if (!mention.characterId || !mention.name || !Number.isInteger(mention.start) || mention.start < end
      || mention.end !== mention.start + mention.name.length + 1 || text.slice(mention.start, mention.end) !== `@${mention.name}`) return false;
    end = mention.end;
    return true;
  });
}

export function replaceMentionText(text: string, mentions: readonly CharacterMention[], start: number, end: number, insertion: string, character?: MentionCharacter) {
  const current = validMentions(text, mentions);
  // A replacement touching a token replaces that entire token, including mobile/native edits.
  for (const mention of current) {
    if ((start > mention.start && start < mention.end) || (end > mention.start && end < mention.end)) {
      start = Math.min(start, mention.start);
      end = Math.max(end, mention.end);
    }
  }
  const delta = insertion.length - (end - start);
  const next = current.filter((mention) => mention.end <= start || mention.start >= end).map((mention) => mention.start >= end
    ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention);
  if (character) next.push({ characterId: character.id, name: character.name, start, end: start + character.name.length + 1 });
  return { text: text.slice(0, start) + insertion + text.slice(end), mentions: next.sort((a, b) => a.start - b.start), caret: start + insertion.length };
}

export function reconcileMentionEdit(text: string, mentions: readonly CharacterMention[], nextText: string) {
  let start = 0;
  while (start < text.length && start < nextText.length && text[start] === nextText[start]) start += 1;
  let end = text.length;
  let nextEnd = nextText.length;
  while (end > start && nextEnd > start && text[end - 1] === nextText[nextEnd - 1]) { end -= 1; nextEnd -= 1; }
  const insertion = nextText.slice(start, nextEnd);
  const precedingToken = nextEnd === start && end === start + 1 && text[start] === ' ' ? mentions.find((mention) => mention.end === start) : undefined;
  if (precedingToken) start = precedingToken.start;
  return replaceMentionText(text, mentions, start, end, insertion);
}

export function bindCompletedMentions(text: string, mentions: readonly CharacterMention[], characters: readonly MentionCharacter[]) {
  const next = validMentions(text, mentions);
  for (let start = text.indexOf('@'); start >= 0; start = text.indexOf('@', start + 1)) {
    if (next.some((mention) => start >= mention.start && start < mention.end) || (start > 0 && /[\w@]/.test(text[start - 1]))) continue;
    const candidates = characters.filter((character) => character.name && text.startsWith(character.name, start + 1)
      && /\s/.test(text[start + character.name.length + 1] || ''));
    const longestName = Math.max(0, ...candidates.map((character) => character.name.length));
    const matches = candidates.filter((character) => character.name.length === longestName);
    if (matches.length !== 1) continue;
    const character = matches[0];
    const end = start + character.name.length + 1;
    if (!next.some((mention) => mention.start < end && mention.end > start)) next.push({ characterId: character.id, name: character.name, start, end });
  }
  return next.sort((a, b) => a.start - b.start);
}

export function trimMentionDraft(text: string, mentions: readonly CharacterMention[]) {
  const content = text.trim();
  const offset = text.length - text.trimStart().length;
  return { content, mentions: validMentions(text, mentions).filter((mention) => mention.start >= offset && mention.end <= offset + content.length)
    .map((mention) => ({ ...mention, start: mention.start - offset, end: mention.end - offset })) };
}

export function mentionQuery(text: string, caret: number, mentions: readonly CharacterMention[]) {
  if (caret <= 0) return null;
  if (mentions.some((mention) => caret > mention.start && caret <= mention.end)) return null;
  const start = text.lastIndexOf('@', caret - 1);
  if (start < 0 || (start > 0 && /[\w@]/.test(text[start - 1]))) return null;
  const query = text.slice(start + 1, caret);
  return /\s|@/.test(query) ? null : { start, end: caret, query };
}

export function explicitUserMentionIds(message: { type: string; senderId: string; content: string; metadata?: { mentions?: CharacterMention[]; manualSpeaker?: unknown; withdrawal?: { withdrawn?: boolean } } }) {
  if (!['user', 'god'].includes(message.type) || message.senderId !== 'user' || message.metadata?.manualSpeaker || message.metadata?.withdrawal?.withdrawn) return [];
  const mentions = validMentions(message.content, message.metadata?.mentions);
  if (!mentions.length) return [];
  const tree = unified().use(remarkParse).parse(message.content);
  const ids = new Set<string>();
  const visit = (node: typeof tree | typeof tree.children[number]) => {
    if (['blockquote', 'code', 'inlineCode', 'link', 'linkReference', 'html', 'image', 'imageReference'].includes(node.type)) return;
    if (node.type === 'text' && node.position) {
      const start = node.position.start.offset ?? 0;
      const end = node.position.end.offset ?? 0;
      for (const mention of mentions) if (mention.start >= start && mention.end <= end) ids.add(mention.characterId);
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return [...ids];
}
