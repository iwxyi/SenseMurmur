import { memo } from 'react';
import RichMarkdownText from './RichMarkdownText';
import type { AICharacter } from '../../types/character';
import type { CharacterMention } from '../../types/message';
import type { MentionCharacter } from '../../services/markdownCharacterMentions';

function normalizeStreamingMarkdown(text: string) {
  const fenceCount = (text.match(/^```/gm) || []).length;
  return fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text;
}

// eslint-disable-next-line react-refresh/only-export-components
export function shouldUseRichMarkdown(text: string) {
  if (!text) return false;
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s+\S|\d+\.\s+\S|>\s|\|.*\|)|```|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|!\[[^\]]*]\(|\[[^\]]+]\(|<\/?[a-z][\s\S]*>/i.test(text);
}

function MarkdownText({
  text,
  softLineBreaks = true,
  forceRich: _forceRich = false,
  deferDiagrams = false,
  onOpenDiagram,
  mentionCharacters,
  mentions,
  onCharacterMentionClick,
}: {
  text: string;
  softLineBreaks?: boolean;
  forceRich?: boolean;
  deferDiagrams?: boolean;
  onOpenDiagram?: (payload: { source: string; svg: string; dataUrl: string }) => void;
  mentionCharacters?: AICharacter[];
  mentions?: CharacterMention[];
  onCharacterMentionClick?: (character: MentionCharacter, anchorEl: HTMLElement) => void;
}) {
  void _forceRich;
  const normalized = normalizeStreamingMarkdown(text);
  // Keep one DOM shape throughout streaming and final commit. Switching from
  // a plain paragraph to the lazy rich renderer changes paragraph margins and
  // makes the bubble jump when the final text arrives.
  return <RichMarkdownText text={normalized} softLineBreaks={softLineBreaks} deferDiagrams={deferDiagrams} onOpenDiagram={onOpenDiagram} mentionCharacters={mentionCharacters} mentions={mentions} onCharacterMentionClick={onCharacterMentionClick} />;
}

export default memo(MarkdownText);
