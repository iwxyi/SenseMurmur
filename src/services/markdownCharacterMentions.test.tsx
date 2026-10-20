import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { characterMentionHref, remarkCharacterMentions, type MentionCharacter } from './markdownCharacterMentions';

const characters = [
  { id: 'short', name: '张飞' },
  { id: 'long', name: '张飞将军' },
  { id: 'editor', name: 'Lily' },
  { id: 'special', name: '小A(设计)' },
];

function render(text: string, roles: MentionCharacter[] = characters) {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[[remarkCharacterMentions, { characters: roles }]]}>{text}</ReactMarkdown>,
  );
}

describe('character mentions', () => {
  it('uses per-occurrence identities after rename, for deleted roles and for duplicate names', () => {
    const source = '@旧名字 @旧名字';
    const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[[remarkCharacterMentions, {
      characters: [{ id: 'first', name: '新名字' }], source,
      mentions: [{ characterId: 'first', name: '旧名字', start: 0, end: 4 }, { characterId: 'deleted', name: '旧名字', start: 5, end: 9 }],
    }]]}>{source}</ReactMarkdown>);
    expect(html).toContain('href="#character-mention-first">@旧名字');
    expect(html).toContain('href="#character-mention-deleted">@旧名字');
  });
  it('links full names in Chinese sentences, repeated mentions and formatted text', () => {
    const html = render('请@张飞 看看，@张飞将军 **@Lily** @张飞');
    expect(html.match(/href=/g)).toHaveLength(4);
    expect(html).toContain(`href="${characterMentionHref('long')}">@张飞将军</a>`);
    expect(html).toContain('<strong><a href="#character-mention-editor">@Lily</a></strong>');
  });

  it('leaves incomplete names, email addresses and English name extensions alone', () => {
    expect(render('@张 @LilyX test@Lily.com @@张飞')).not.toContain('<a ');
    expect(render('@小A(设计)')).toContain('href="#character-mention-special"');
  });

  it('links historical explicit mentions without requiring spaces, leaving ordinary forms of address as text', () => {
    const html = render('张飞，三弟，你来看看。@张飞，轮到你了');
    expect(html.match(/href=/g)).toHaveLength(1);
    expect(html).toContain('张飞，三弟，你来看看。<a href="#character-mention-short">@张飞</a>，轮到你了');
  });

  it('does not rewrite code or existing links', () => {
    const html = render('`@张飞` [@Lily](https://example.com)\n\n```text\n@张飞\n```');
    expect(html).not.toContain('#character-mention-');
    expect(html).toContain('href="https://example.com"');
  });

  it('leaves ambiguous names as text and accepts repeated records of the same character', () => {
    expect(render('@张飞', [{ id: 'one', name: '张飞' }, { id: 'two', name: '张飞' }])).not.toContain('<a ');
    expect(render('@张飞', [characters[0], characters[0]])).toContain('href="#character-mention-short"');
  });
});
