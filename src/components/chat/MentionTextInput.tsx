import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Avatar, Box, List, ListItemAvatar, ListItemButton, ListItemText, Paper, TextareaAutosize } from '@mui/material';
import type { AICharacter } from '../../types/character';
import type { CharacterMention } from '../../types/message';
import { bindCompletedMentions, mentionQuery, reconcileMentionEdit, replaceMentionText } from '../../services/characterMentions';

interface Props {
  value: string;
  mentions: CharacterMention[];
  characters: AICharacter[];
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  disabled: boolean;
  placeholder: string;
  onChange: (text: string, mentions: CharacterMention[]) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

export default function MentionTextInput({ value, mentions, characters, inputRef, disabled, placeholder, onChange, onFocus, onBlur, onKeyDown }: Props) {
  const id = useId();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [scroll, setScroll] = useState(0);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const position = pendingCaret.current;
    if (position === null) return;
    pendingCaret.current = null;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.setSelectionRange(position, position);
  });
  const query = mentionQuery(value, caret, mentions);
  const queryKey = query ? `${query.start}:${query.query}` : null;
  const candidates = focused && query && queryKey !== dismissedQuery
    ? characters.filter((character) => !character.deletedAt && character.name.toLocaleLowerCase().includes(query.query.toLocaleLowerCase())) : [];
  const activeIndex = Math.min(active, Math.max(0, candidates.length - 1));
  const moveCaret = (position: number) => {
    pendingCaret.current = position;
    setCaret(position);
  };
  const choose = (character: AICharacter) => {
    if (!query) return;
    const result = replaceMentionText(value, mentions, query.start, query.end, `@${character.name} `, character);
    onChange(result.text, result.mentions);
    moveCaret(result.caret);
  };
  const segments = [];
  let offset = 0;
  for (const mention of mentions) {
    segments.push(value.slice(offset, mention.start));
    segments.push(<Box component="span" key={`${mention.start}:${mention.characterId}`} sx={{ color: (theme) => theme.palette.mode === 'dark' ? '#a8c4ed' : '#576b95' }}>{value.slice(mention.start, mention.end)}</Box>);
    offset = mention.end;
  }
  segments.push(value.slice(offset));

  return <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
    {candidates.length > 0 && <Paper sx={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0, maxHeight: 240, overflowY: 'auto', zIndex: 5 }} elevation={6}>
      <List id={id} role="listbox" aria-label="群成员" dense>
        {candidates.map((character, index) => <ListItemButton key={character.id} id={`${id}-${index}`} role="option" aria-selected={index === activeIndex} selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(character)}>
          <ListItemAvatar sx={{ minWidth: 36 }}><Avatar src={character.avatar} sx={{ width: 28, height: 28 }}>{character.name[0]}</Avatar></ListItemAvatar>
          <ListItemText primary={character.name} slotProps={{ primary: { sx: { overflowWrap: 'anywhere' } } }} />
        </ListItemButton>)}
      </List>
    </Paper>}
    <Box sx={{ position: 'relative', p: '8.5px 14px', border: '1px solid', borderColor: focused ? 'primary.main' : 'divider', borderRadius: 2.25,
      bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(248,250,252,0.74)' : 'rgba(255,255,255,0.065)',
      fontFamily: 'inherit', fontSize: '1rem', lineHeight: '1.4375em', opacity: disabled ? 0.6 : 1,
      '& textarea': { display: 'block', width: '100%', margin: 0, padding: 0, border: 0, outline: 0, resize: 'none', background: 'transparent', font: 'inherit', letterSpacing: 0,
        // Unlike color, caretColor does not resolve MUI palette tokens.
        color: 'transparent', WebkitTextFillColor: 'transparent', caretColor: (theme) => theme.palette.text.primary, overflowWrap: 'break-word', position: 'relative', zIndex: 1,
        '&::placeholder': { color: 'text.secondary', WebkitTextFillColor: 'currentColor', opacity: 1 } } }}>
      <Box aria-hidden sx={{ position: 'absolute', inset: '8.5px 14px', overflow: 'hidden', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', color: 'text.primary' }}>
        <Box sx={{ transform: `translateY(-${scroll}px)` }}>{segments}{'\u200b'}</Box>
      </Box>
      <TextareaAutosize ref={(node: HTMLTextAreaElement | null) => { inputRef.current = node; }} value={value} maxRows={4} disabled={disabled} placeholder={placeholder}
        role="combobox" aria-label={placeholder} aria-autocomplete="list" aria-expanded={candidates.length > 0} aria-controls={candidates.length ? id : undefined}
        aria-activedescendant={candidates.length ? `${id}-${activeIndex}` : undefined}
        onFocus={() => { setFocused(true); onFocus(); }} onBlur={() => { setFocused(false); onBlur(); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => { composing.current = false; const text = event.currentTarget.value; onChange(text, bindCompletedMentions(text, mentions, characters)); }}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
        onSelect={(event) => {
          const input = event.currentTarget;
          const start = input.selectionStart;
          if (!composing.current && start === input.selectionEnd) {
            const token = mentions.find((mention) => start > mention.start && start < mention.end);
            if (token) { const edge = start - token.start < token.end - start ? token.start : token.end; input.setSelectionRange(edge, edge); setCaret(edge); return; }
          }
          setCaret(start);
        }}
        onChange={(event) => {
          const result = reconcileMentionEdit(value, mentions, event.target.value);
          const bound = composing.current ? result.mentions : bindCompletedMentions(result.text, result.mentions, characters);
          onChange(result.text, bound);
          setCaret(event.target.selectionStart);
          setActive(0);
          setDismissedQuery(null);
          if (result.text !== event.target.value) moveCaret(result.caret);
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (candidates.length) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); return; }
            if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(candidates[activeIndex]); return; }
            if (event.key === 'Escape') { event.preventDefault(); setDismissedQuery(queryKey); return; }
          }
          const input = event.currentTarget;
          const start = input.selectionStart;
          const end = input.selectionEnd;
          if (!event.shiftKey && start === end && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            const token = mentions.find((mention) => event.key === 'ArrowLeft' ? mention.end === start : mention.start === start);
            if (token) { event.preventDefault(); moveCaret(event.key === 'ArrowLeft' ? token.start : token.end); return; }
          }
          if (event.key === 'Backspace' || event.key === 'Delete') {
            const token = start === end ? mentions.find((mention) => event.key === 'Backspace'
              ? mention.end === start || (mention.end + 1 === start && value[mention.end] === ' ')
              : mention.start === start) : undefined;
            if (token || start !== end) {
              event.preventDefault();
              const result = replaceMentionText(value, mentions, token?.start ?? start, token ? Math.max(token.end, end) : end, '');
              onChange(result.text, result.mentions); moveCaret(result.caret); return;
            }
          }
          onKeyDown(event);
        }} />
    </Box>
  </Box>;
}
