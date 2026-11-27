import { describe, expect, it } from 'vitest';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { MemoryItem } from './memoryTypes';
import { buildAgentCharacterContext, describeAgentCharacterOptions } from './agentCharacterContext';
import { normalizeCharacter } from '../types/character';

const character = { id: 'lu', name: '鲁迅', background: '作家角色', expertise: ['写作', '文学'], speakingStyle: '冷峻简洁', coreProfile: { coreDesire: '揭示麻木' }, layeredMemories: [] } as unknown as AICharacter;
const memory = (id: string, patch: Partial<MemoryItem> = {}): MemoryItem => ({ id, scope: 'conversation', layer: 'episodic', kind: 'artifact', ownerId: 'lu', subjectIds: ['lu'], relatedConversationId: 'room-a', text: `记忆 ${id}`, salience: 0.8, confidence: 0.9, recency: 1, reinforcementCount: 1, sourceEventIds: [], createdAt: 1, updatedAt: 1, visibility: 'public_safe', validity: 'active', ...patch });
const room = (patch: Partial<GroupChat> = {}) => ({ id: 'room-a', name: '文学群', type: 'group', memberIds: ['lu', 'writer'], deletedAt: null, layeredMemories: [], ...patch }) as unknown as GroupChat;

describe('agent character context', () => {
  it('recalls relevant public memories across rooms with source labels', () => {
    const context = buildAgentCharacterContext({ character, chats: [room({ layeredMemories: [memory('m1', { text: '鲁迅谈写作需要克制，反对空洞修辞' })] }), room({ id: 'room-b', name: '读书会', layeredMemories: [memory('m2', { relatedConversationId: 'room-b', text: '写作要观察真实生活，不要粉饰' })] })], taskGoal: '写作一篇现实主义故事', acceptance: '克制且真实' });
    expect(context).toContain('文学群');
    expect(context).toContain('读书会');
    expect(context).toContain('克制');
  });

  it('uses pair and character-private conversation memories only for the bound character', () => {
    const context = buildAgentCharacterContext({ character, chats: [room({ layeredMemories: [
      memory('pair', { scope: 'relationship', visibility: 'pair_private', subjectIds: ['lu', 'friend'], text: '私下谈过创作挫折' }),
      memory('secret', { scope: 'conversation', visibility: 'private', text: '不应作为群聊回忆' }),
      memory('hidden', { visibility: 'never_surface', text: '绝不呈现' }),
    ] }), room({ id: 'private-room', name: '角色私聊', type: 'ai_direct', memberIds: ['lu', 'friend'], layeredMemories: [
      memory('private-chat', { scope: 'conversation', visibility: 'private', relatedConversationId: 'private-room', text: '鲁迅在私聊里谈过自己修改作品时的犹豫' }),
    ] }), room({ id: 'other-room', memberIds: ['someone-else'], layeredMemories: [memory('outsider', { text: '无权读取的房间内容' })] })], taskGoal: '采访鲁迅角色关于创作经历', acceptance: '说明他的看法' });
    expect(context).toContain('私下谈过创作挫折');
    expect(context).toContain('鲁迅在私聊里谈过自己修改作品时的犹豫');
    expect(context).toContain('角色私聊');
    expect(context).not.toContain('不应作为群聊回忆');
    expect(context).not.toContain('绝不呈现');
    expect(context).not.toContain('无权读取的房间内容');
  });

  it('provides a bounded roster for planner-based role selection', () => {
    expect(describeAgentCharacterOptions([character])[0]).toMatchObject({ id: 'lu', name: '鲁迅', expertise: ['写作', '文学'] });
  });

  it('accepts a cloud character summary without optional profile fields', () => {
    const summary = normalizeCharacter({ id: 'cao', name: '曹操', avatar: '', personality: {}, isPreset: false,
      createdAt: 1, updatedAt: 1, characterDetailLoaded: false } as unknown as AICharacter);
    expect(describeAgentCharacterOptions([summary], '让曹操写诗')).toEqual([{
      id: 'cao', name: '曹操', expertise: [], background: '',
    }]);
  });

  it('keeps a specifically named character available beyond the roster limit', () => {
    const roster = Array.from({ length: 75 }, (_, index) => ({ ...character, id: `c-${index}`, name: `角色${index}` } as AICharacter));
    roster.push(character);
    const options = describeAgentCharacterOptions(roster, '请让鲁迅写一段故事');
    expect(options).toHaveLength(60);
    expect(options[0]).toMatchObject({ id: 'lu', name: '鲁迅' });
  });

  it('resolves long-term memories against their original conversation privacy', () => {
    const characterWithMemory = { ...character, layeredMemories: [
      memory('long-public', { relatedConversationId: 'room-a', text: '长期记忆中的公开写作观点' }),
      memory('long-private', { relatedConversationId: 'private-room', visibility: 'private', text: '不能外传的私聊内容' }),
      memory('orphan', { relatedConversationId: 'deleted-room', text: '来源已不可访问' }),
    ] } as unknown as AICharacter;
    const context = buildAgentCharacterContext({ character: characterWithMemory, chats: [
      room({ layeredMemories: [] }),
      room({ id: 'private-room', name: '私聊', type: 'ai_direct', memberIds: ['lu', 'friend'], layeredMemories: [] }),
    ], taskGoal: '写作', acceptance: '遵从角色记忆' });
    expect(context).toContain('公开写作观点');
    expect(context).toContain('不能外传的私聊内容');
    expect(context).not.toContain('来源已不可访问');
  });
});
