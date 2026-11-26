import { describe, expect, it } from 'vitest';
import { buildMomentImagePrompt } from './momentImagePrompt';

describe('moment image prompt', () => {
  it('uses only the published post and character name', () => {
    const prompt = buildMomentImagePrompt('红太狼', '今天这锅炖得真不错。');
    expect(prompt).toContain('红太狼');
    expect(prompt).toContain('今天这锅炖得真不错。');
    expect(prompt).not.toContain('聊天记录');
  });

  it('requires a resolved public post', () => {
    expect(() => buildMomentImagePrompt('红太狼', '')).toThrow('已确定的动态正文');
  });
});
