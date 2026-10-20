import { Box, Typography } from '@mui/material';
import { memo, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MermaidDiagram from './MermaidDiagram';
import AppSnackbar from './AppSnackbar';
import { parseAppLink, isLikelyExternalLink } from '../../services/appLink';
import { useAppLinkHandler } from '../../hooks/useAppLinkHandler';
import type { AICharacter } from '../../types/character';
import { characterMentionHref, remarkCharacterMentions } from '../../services/markdownCharacterMentions';

type MarkdownAstNode = {
  type?: string;
  value?: string;
  children?: MarkdownAstNode[];
};

function splitSoftBreakText(value: string): MarkdownAstNode[] {
  const parts = value.split('\n');
  return parts.flatMap((part, index) => {
    const nodes: MarkdownAstNode[] = [];
    if (index > 0) nodes.push({ type: 'break' });
    if (part) nodes.push({ type: 'text', value: part });
    return nodes;
  });
}

function remarkSingleLineBreaks() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (!node.children) return;
      if (node.type === 'paragraph') {
        node.children = node.children.flatMap((child) => (
          child.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')
            ? splitSoftBreakText(child.value)
            : [child]
        ));
        return;
      }
      node.children.forEach(visit);
    };
    visit(tree);
  };
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return '';
}

function extractCodeBlock(children: ReactNode) {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const language = children.props.className?.match(/language-([a-zA-Z0-9_-]+)/)?.[1]?.toLowerCase() || '';
  return {
    language,
    source: textFromNode(children.props.children).replace(/\n$/, ''),
    className: children.props.className,
    children: children.props.children,
  };
}

function MermaidDiagramPlaceholder() {
  return (
    <Box
      aria-hidden
      sx={(theme) => ({
        my: 1,
        height: { xs: 180, sm: 220 },
        width: 'min(100%, 520px)',
        borderRadius: 1.25,
        border: '1px solid',
        borderColor: theme.palette.mode === 'light' ? 'rgba(15,23,42,0.10)' : 'rgba(226,232,240,0.14)',
        bgcolor: theme.palette.mode === 'light' ? 'rgba(255,255,255,0.58)' : 'rgba(15,23,42,0.38)',
      })}
    />
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function transformMarkdownUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (parseAppLink(trimmed) || /^https?:\/\//i.test(trimmed) || /^(mailto:|tel:|blob:)/i.test(trimmed) || trimmed.startsWith('#')) return trimmed;
  return '';
}

function RichMarkdownText({
  text,
  softLineBreaks = true,
  deferDiagrams = false,
  onOpenDiagram,
  mentionCharacters,
  mentions,
  onCharacterMentionClick,
}: {
  text: string;
  softLineBreaks?: boolean;
  deferDiagrams?: boolean;
  onOpenDiagram?: (payload: { source: string; svg: string; dataUrl: string }) => void;
  mentionCharacters?: AICharacter[];
  mentions?: import('../../types/message').CharacterMention[];
  onCharacterMentionClick?: (character: import('../../services/markdownCharacterMentions').MentionCharacter, anchorEl: HTMLElement) => void;
}) {
  const appLink = useAppLinkHandler();
  return (
    <>
      <Box
        sx={{
          fontSize: 'inherit',
          lineHeight: 1.95,
          minWidth: 0,
          maxWidth: '100%',
          '& > :first-of-type': { mt: 0 },
          '& > :last-child': { mb: 0 },
          '& p': { mt: 0, mb: 0.95, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
          '& h1, & h2, & h3, & h4': { mt: 1.15, mb: 0.55, fontWeight: 850, lineHeight: 1.35 },
          '& h1': { fontSize: '1.28em' },
          '& h2': { fontSize: '1.16em' },
          '& h3': { fontSize: '1.06em' },
          '& h4': { fontSize: '1em' },
          '& ul, & ol': { mt: 0.35, mb: 0.75, pl: 2.4 },
          '& li': { mb: 0.35, overflowWrap: 'anywhere' },
          '& blockquote': {
            m: 0,
            my: 0.75,
            pl: 1,
            borderLeft: '3px solid',
            borderColor: 'divider',
            color: 'text.secondary',
          },
          '& pre': {
            m: 0,
            my: 0.75,
            p: 1,
            display: 'block',
            width: '100%',
            minWidth: 0,
            maxWidth: '100%',
            boxSizing: 'border-box',
            borderRadius: 1,
            overflowX: 'auto',
            overflowY: 'hidden',
            WebkitOverflowScrolling: 'touch',
            bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.92)' : 'rgba(2,6,23,0.82)',
            color: '#e5e7eb',
            fontSize: '0.92em',
            lineHeight: 1.65,
          },
          '& pre code': {
            display: 'block',
            width: 'max-content',
            minWidth: '100%',
            p: 0,
            bgcolor: 'transparent',
            color: 'inherit',
            whiteSpace: 'pre',
            overflowWrap: 'normal',
            wordBreak: 'normal',
          },
          '& code': {
            px: 0.5,
            py: 0.1,
            borderRadius: 0.75,
            bgcolor: 'action.hover',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: '0.94em',
            overflowWrap: 'anywhere',
          },
          '& table': {
            width: '100%',
            borderCollapse: 'collapse',
            my: 0.85,
            fontSize: '0.96em',
          },
          '& th, & td': {
            border: '1px solid',
            borderColor: 'divider',
            px: 0.75,
            py: 0.45,
            textAlign: 'left',
            verticalAlign: 'top',
          },
          '& th': { fontWeight: 800, bgcolor: 'action.hover' },
          '& a': { color: (theme) => `var(--message-link-color, ${theme.palette.primary.main})`, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
          '& a[data-character-mention]': {
            color: (theme) => `var(--message-mention-color, ${theme.palette.mode === 'dark' ? '#a8c4ed' : '#576b95'})`,
            textDecoration: 'none',
            '&:hover': { textDecoration: 'none' },
          },
          '& img': {
            display: 'block',
            width: 'auto',
            height: 'auto',
            maxWidth: '100%',
            maxHeight: 'min(56vh, 520px)',
            objectFit: 'contain',
          },
          '& input[type="checkbox"]': { transform: 'translateY(1px)' },
        }}
      >
        <ReactMarkdown
          remarkPlugins={[
            remarkGfm,
            ...(softLineBreaks ? [remarkSingleLineBreaks] : []),
            ...(mentionCharacters && onCharacterMentionClick ? [[remarkCharacterMentions, { characters: mentionCharacters, mentions, source: text }] as [typeof remarkCharacterMentions, Parameters<typeof remarkCharacterMentions>[0]]] : []),
          ]}
          urlTransform={transformMarkdownUrl}
          components={{
            a: ({ href, children }) => {
              const bound = mentions?.find((mention) => characterMentionHref(mention.characterId) === href);
              const mentioned = bound ? { id: bound.characterId, name: bound.name } : mentionCharacters?.find((character) => characterMentionHref(character.id) === href);
              const internal = Boolean(parseAppLink(href));
              return (
                <Box
                  component="a"
                  href={href}
                  data-character-mention={mentioned ? true : undefined}
                  target={!internal && isLikelyExternalLink(href) ? '_blank' : undefined}
                  rel={!internal && isLikelyExternalLink(href) ? 'noreferrer' : undefined}
                  onClick={(event) => {
                    if (mentioned && onCharacterMentionClick) {
                      event.preventDefault();
                      event.stopPropagation();
                      if (window.getSelection()?.toString()) return;
                      onCharacterMentionClick(mentioned, event.currentTarget);
                      return;
                    }
                    appLink.handleAnchorClick(event, href);
                  }}
                  onDoubleClick={mentioned ? (event) => event.stopPropagation() : undefined}
                >
                  {children}
                </Box>
              );
            },
            p: ({ children }) => <Typography component="p" variant="body2">{children}</Typography>,
            table: ({ children }) => (
              <Box sx={{ width: '100%', minWidth: 0, maxWidth: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table>{children}</table>
              </Box>
            ),
            pre: ({ children }) => {
              const block = extractCodeBlock(children);
              if (block?.language === 'mermaid' && deferDiagrams) return <MermaidDiagramPlaceholder />;
              if (block?.language === 'mermaid' && !deferDiagrams) return <MermaidDiagram source={block.source} onOpenFullscreen={onOpenDiagram} />;
              return <pre>{children}</pre>;
            },
            code: ({ children, className, ...props }) => (
              <code className={className} {...props}>
                {children}
              </code>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </Box>
      <AppSnackbar
        open={appLink.feedback.open}
        message={appLink.feedback.message}
        severity="warning"
        action={appLink.feedback.action}
        onClose={appLink.closeFeedback}
      />
    </>
  );
}

export default memo(RichMarkdownText);
