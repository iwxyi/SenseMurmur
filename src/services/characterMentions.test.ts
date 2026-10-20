import { describe, expect, it } from 'vitest';
import { bindCompletedMentions, explicitUserMentionIds, mentionQuery, reconcileMentionEdit, replaceMentionText, trimMentionDraft, validMentions } from './characterMentions';

const roles = [{ id: 'cao', name: '曹操' }, { id: 'liu', name: '刘备' }];
const token = { characterId: 'cao', name: '曹操', start: 0, end: 3 };

describe('mention editing and identity', () => {
  it('confirms a complete unique name on whitespace, leaving incomplete/unknown/ambiguous names as text', () => {
    expect(bindCompletedMentions('@曹操', [], roles)).toEqual([]);
    expect(bindCompletedMentions('@曹操 ', [], roles)).toEqual([token]);
    expect(bindCompletedMentions('@曹 @未知 ', [], roles)).toEqual([]);
    expect(bindCompletedMentions('@曹操 ', [], [...roles, { id: 'other', name: '曹操' }])).toEqual([]);
    expect(bindCompletedMentions('email@曹操 ', [], roles)).toEqual([]);
    expect(bindCompletedMentions('@曹操\n', [], roles)).toEqual([token]);
    expect(bindCompletedMentions('@John Smith ', [], [{ id: 'short', name: 'John' }, { id: 'full', name: 'John Smith' }])).toEqual([{ characterId: 'full', name: 'John Smith', start: 0, end: 11 }]);
  });
  it('keeps separate identities for explicitly selected characters with the same name', () => {
    const first = replaceMentionText('', [], 0, 0, '@曹操 ', roles[0]);
    const next = replaceMentionText(first.text, first.mentions, first.caret, first.caret, '@曹操 ', { id: 'other', name: '曹操' });
    expect(next.mentions.map((mention) => mention.characterId)).toEqual(['cao', 'other']);
  });
  it('deletes a whole token for a partial native/mobile deletion and backspace after its separator', () => {
    expect(reconcileMentionEdit('@曹操 后面', [token], '@曹 后面')).toMatchObject({ text: ' 后面', mentions: [] });
    expect(reconcileMentionEdit('@曹操 后面', [token], '@曹操后面')).toMatchObject({ text: '后面', mentions: [] });
    expect(reconcileMentionEdit('@曹操 后面', [token], '后面')).toMatchObject({ text: '后面', mentions: [] });
  });
  it('expands cross-token selection and shifts subsequent bindings after insertion', () => {
    const text = '@曹操 与 @刘备 好';
    const mentions = [token, { characterId: 'liu', name: '刘备', start: 6, end: 9 }];
    expect(replaceMentionText(text, mentions, 2, 7, '换成')).toMatchObject({ text: '换成 好', mentions: [] });
    expect(replaceMentionText(text, mentions, 0, 0, '请')).toMatchObject({ mentions: [{ ...token, start: 1, end: 4 }, { ...mentions[1], start: 7, end: 10 }] });
  });
  it('retains bindings after trimming and rejects stale ranges', () => {
    expect(trimMentionDraft('  @曹操  ', [{ ...token, start: 2, end: 5 }])).toEqual({ content: '@曹操', mentions: [token] });
    expect(validMentions('@刘备', [token])).toEqual([]);
    expect(mentionQuery('请 @曹', 4, [])).toEqual({ start: 2, end: 4, query: '曹' });
    expect(mentionQuery('@曹操 ', 2, [token])).toBeNull();
    expect(mentionQuery('@曹操 ', 0, [token])).toBeNull();
  });
});

describe('explicit user mention attention', () => {
  const message = (content: string, type = 'user', senderId = 'user') => ({ type, senderId, content, metadata: { mentions: [{ ...token, start: content.indexOf('@'), end: content.indexOf('@') + 3 }] } });
  it('only considers real user mentions outside quotes, code and links', () => {
    expect(explicitUserMentionIds(message('请 @曹操 看看'))).toEqual(['cao']);
    for (const content of ['> @曹操', '`@曹操`', '```\n@曹操\n```', '[@曹操](https://example.com)']) expect(explicitUserMentionIds(message(content))).toEqual([]);
    expect(explicitUserMentionIds(message('@曹操', 'ai', 'liu'))).toEqual([]);
    expect(explicitUserMentionIds(message('@曹操', 'user', 'liu'))).toEqual([]);
    expect(explicitUserMentionIds({ ...message('@曹操'), metadata: { mentions: [] } })).toEqual([]);
    expect(explicitUserMentionIds({ ...message('@曹操'), metadata: { mentions: [token], withdrawal: { withdrawn: true } } })).toEqual([]);
  });
});
