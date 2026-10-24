import { Box, Typography } from '@mui/material';
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
  // Be conservative: ambiguous syntax still goes through the Markdown parser.
  // This also preserves GFM autolinks, entities, escapes and character mentions.
  return /[\\`*_~[\]<>|&@]|(^|\n)(?: {4}|\t|\s{0,3}(?:#{1,6}(?:\s|$)|[-+>](?:\s|$)|\d+[.)]\s|={2,}\s*$|-{2,}\s*$))|(?:https?:\/\/|www\.)/im.test(text);
}

function MarkdownText({
  text,
  softLineBreaks = true,
  forceRich = false,
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
  if (!forceRich && softLineBreaks && !shouldUseRichMarkdown(text)) {
    return (
      <Box sx={{ fontSize: 'inherit', lineHeight: 1.95, minWidth: 0, maxWidth: '100%' }}>
        <Typography component="p" variant="body2" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {text}
        </Typography>
      </Box>
    );
  }
  const normalized = normalizeStreamingMarkdown(text);
  return <RichMarkdownText text={normalized} softLineBreaks={softLineBreaks} deferDiagrams={deferDiagrams} onOpenDiagram={onOpenDiagram} mentionCharacters={mentionCharacters} mentions={mentions} onCharacterMentionClick={onCharacterMentionClick} />;
}

export default memo(MarkdownText);
