import { describe, expect, it } from 'vitest';
import { getNextStreamingDisplayContent } from './streamingDisplayBuffer';

describe('getNextStreamingDisplayContent', () => {
  it('reveals incoming streaming text progressively', () => {
    expect(getNextStreamingDisplayContent('', 'abcdef')).toBe('a');
    expect(getNextStreamingDisplayContent('a', 'abcdef')).toBe('ab');
  });

  it('uses larger steps for long incoming text without jumping to the end', () => {
    const target = 'x'.repeat(160);

    expect(getNextStreamingDisplayContent('', target)).toBe('x'.repeat(6));
    expect(getNextStreamingDisplayContent('x'.repeat(6), target)).toBe('x'.repeat(12));
  });

  it('keeps short replies moving at the faster display interval', () => {
    expect(getNextStreamingDisplayContent('', '你好')).toBe('你');
    expect(getNextStreamingDisplayContent('你', '你好')).toBe('你好');
  });

  it('jumps to target when stream content is rewritten', () => {
    expect(getNextStreamingDisplayContent('旧内容', '新内容')).toBe('新内容');
  });
});
