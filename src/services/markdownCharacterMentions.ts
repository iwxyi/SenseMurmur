import type { CharacterMention } from '../types/message';
import { validMentions } from './characterMentions';

export interface MentionCharacter {
  id: string;
  name: string;
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
}

export function characterMentionHref(id: string) {
  return `#character-mention-${encodeURIComponent(id)}`;
}

export function remarkCharacterMentions(options: { characters: readonly MentionCharacter[]; mentions?: readonly CharacterMention[]; source?: string }) {
  const bindings = validMentions(options.source || '', options.mentions);
  const names = new Map<string, MentionCharacter[]>();
  for (const character of options.characters) {
    if (!character.name) continue;
    const matches = names.get(character.name) || [];
    if (!matches.some((item) => item.id === character.id)) matches.push(character);
    names.set(character.name, matches);
  }
  const candidates = [...names.values()].filter((items) => items.length === 1)
    .map(([character]) => character).sort((a, b) => b.name.length - a.name.length);

  return (tree: MarkdownNode) => {
    const split = (value: string, offset: number): MarkdownNode[] => {
      const nodes: MarkdownNode[] = [];
      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== '@' || (index > 0 && /[A-Za-z0-9_@]/.test(value[index - 1]))) continue;
        const bound = bindings.find((mention) => offset >= 0 && mention.start === offset + index
          && value.slice(index, index + mention.end - mention.start) === `@${mention.name}`);
        const character = bound ? { id: bound.characterId, name: bound.name } : candidates.find((item) => value.startsWith(item.name, index + 1)
          && !/[A-Za-z0-9_]/.test(value[index + item.name.length + 1] || ''));
        if (!character) continue;
        if (index > start) nodes.push({ type: 'text', value: value.slice(start, index) });
        const end = index + character.name.length + 1;
        nodes.push({ type: 'link', url: characterMentionHref(character.id), children: [{ type: 'text', value: value.slice(index, end) }] });
        start = end;
        index = end - 1;
      }
      if (start < value.length) nodes.push({ type: 'text', value: value.slice(start) });
      return nodes;
    };
    const visit = (node: MarkdownNode) => {
      if (!node.children || ['link', 'linkReference', 'code', 'inlineCode', 'html', 'image', 'imageReference'].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value) {
          const offset = child.position?.start.offset ?? -1;
          return split(child.value, options.source?.slice(offset, offset + child.value.length) === child.value ? offset : -1);
        }
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}
