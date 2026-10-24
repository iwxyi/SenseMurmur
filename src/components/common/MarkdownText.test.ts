import { describe, expect, it } from 'vitest';
import { shouldUseRichMarkdown } from './MarkdownText';
import { transformMarkdownUrl } from './RichMarkdownText';

describe('MarkdownText markdown detection', () => {
  it('keeps common chat prose on the plain text path', () => {
    expect(shouldUseRichMarkdown('沈清婉的手指停在梳背上，那几根灰白发丝在烛光里几乎透明。')).toBe(false);
    expect(shouldUseRichMarkdown('第一行普通文本\n第二行普通文本')).toBe(false);
  });

  it('uses the rich renderer for markdown syntax', () => {
    expect(shouldUseRichMarkdown('## 标题')).toBe(true);
    expect(shouldUseRichMarkdown('- 列表项')).toBe(true);
    expect(shouldUseRichMarkdown('[链接](https://example.com)')).toBe(true);
    expect(shouldUseRichMarkdown('```ts\nconst x = 1;\n```')).toBe(true);
    expect(shouldUseRichMarkdown('| A | B |\n| - | - |')).toBe(true);
  });

  it('keeps app links available while blocking unsafe protocols', () => {
    expect(transformMarkdownUrl('ssmm://character/local-character-1?action=edit')).toBe('ssmm://character/local-character-1?action=edit');
    expect(transformMarkdownUrl('/characters/local-character-1/edit')).toBe('/characters/local-character-1/edit');
    expect(transformMarkdownUrl('https://example.com')).toBe('https://example.com');
    expect(transformMarkdownUrl('javascript:alert(1)')).toBe('');
    expect(transformMarkdownUrl('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('preserves inline formatting, automatic links and mention parsing', () => {
    for (const text of ['*强调*', '_强调_', 'https://example.com', 'www.example.com', 'a@example.com', '@角色', '&amp;', '\\*字面星号', '[引用][id]', '    const x = 1', '标题\n===', '---']) {
      expect(shouldUseRichMarkdown(text), text).toBe(true);
    }
  });
});
