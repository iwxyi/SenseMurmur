import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import { retrieveRelevantMemories } from './memoryRetrieval';
import { formatMemoryPerspectiveText, resolveMemoryDisclosureMetadata } from './memoryDisclosure';
import type { MemoryItem } from './memoryTypes';

function memoryCanBeUsedByCharacter(memory: MemoryItem, characterId: string, sourceChat?: GroupChat) {
  const disclosure = resolveMemoryDisclosureMetadata(memory);
  if (disclosure.visibility === 'never_surface' || disclosure.validity === 'contradicted') return false;
  if (memory.scope === 'character_self') return memory.ownerId === characterId;
  if (memory.scope === 'relationship' || memory.scope === 'thread') {
    return Boolean(sourceChat) && memory.subjectIds?.includes(characterId)
      && (disclosure.visibility === 'pair_private' || disclosure.visibility === 'public_safe');
  }
  if (memory.scope === 'conversation') return Boolean(sourceChat)
    && (disclosure.visibility === 'public_safe' || (disclosure.visibility === 'private' && ['direct', 'ai_direct'].includes(sourceChat!.type)));
  return false;
}

export function buildAgentCharacterContext(params: {
  character: AICharacter;
  chats: GroupChat[];
  taskGoal: string;
  acceptance: string;
  userInstruction?: string;
  maxMemories?: number;
}) {
  const { character } = params;
  const eligibleChats = params.chats.filter((chat) => chat.deletedAt == null && (chat.memberIds || []).includes(character.id));
  const sourceChats = new Map(eligibleChats.map((chat) => [chat.id, chat]));
  const memories = new Map<string, { item: MemoryItem; source: string }>();
  for (const item of character.layeredMemories || []) {
    const sourceChat = item.relatedConversationId ? sourceChats.get(item.relatedConversationId) : undefined;
    if (item.relatedConversationId && !sourceChat) continue;
    if (memoryCanBeUsedByCharacter(item, character.id, sourceChat)) {
      memories.set(item.id, { item, source: sourceChat?.name || '角色长期记忆' });
    }
  }
  for (const chat of eligibleChats) {
    for (const item of chat.layeredMemories || []) {
      const sourceChat = item.relatedConversationId ? sourceChats.get(item.relatedConversationId) : chat;
      if (!sourceChat || !memoryCanBeUsedByCharacter(item, character.id, sourceChat)) continue;
      const current = memories.get(item.id);
      if (!current || (current.source === '角色长期记忆' && item.relatedConversationId)) {
        memories.set(item.id, { item, source: sourceChat.name || '历史会话' });
      }
    }
  }
  const candidates = [...memories.values()];
  const recalled = retrieveRelevantMemories(candidates.map(({ item }) => item), {
    speakerId: character.id,
    conversationId: 'agent-task',
    cueText: [params.taskGoal, params.acceptance, params.userInstruction, character.expertise.join(' ')].filter(Boolean).join('\n'),
    maxItems: params.maxMemories ?? 8,
    maxArchivedItems: 2,
    includeArchivedRecall: true,
    selfMemoryBoost: true,
    relationshipBoost: true,
    now: Date.now(),
  });
  const sourceById = new Map(candidates.map((entry) => [entry.item.id, entry.source]));
  const recalledLines = recalled.map((item) => `- [${sourceById.get(item.id) || '相关记忆'}] ${formatMemoryPerspectiveText(item)}`);
  return [
    `协作者角色：${character.name}`,
    `角色背景：${character.background || '未设置'}`,
    `专长：${character.expertise.join('、') || '未设置'}`,
    `表达风格：${character.speakingStyle || '未设置'}`,
    `创作偏好：${character.coreProfile?.coreDesire || '遵循用户配置的人设与偏好'}`,
    recalledLines.length ? `与当前任务相关的既有记忆（括号内为来源会话）：\n${recalledLines.join('\n')}` : '没有找到可用于本任务的相关历史记忆。',
    '以上记忆仅提供角色自己的经历和观点；区分事实、角色主观理解与未确认内容。不要把私聊记忆转述给其他岗位或写入公开交付，除非用户明确要求且该内容属于可公开分享的信息。用户本次明确要求优先于角色偏好。',
  ].join('\n');
}

export function describeAgentCharacterOptions(characters: AICharacter[], goal = '') {
  const available = characters.filter((character) => character.deletedAt == null);
  const prioritized = available.filter((character) => character.name && goal.includes(character.name));
  return [...prioritized, ...available.filter((character) => !prioritized.includes(character))].slice(0, 60).map((character) => ({
    id: character.id,
    name: character.name,
    expertise: character.expertise.slice(0, 8),
    background: character.background.slice(0, 180),
  }));
}
