import { DEFAULT_CORE_PROFILE, type AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useChatStore } from '../stores/useChatStore';
import { useAuthStore } from '../stores/useAuthStore';
import { api } from './api';
import { getCharacterCompletionTaskStatus } from './characterCompletionQueue';
import { getChatCompletionTaskStatus } from './chatCompletionQueue';
import { avatarGenerationQueue } from './avatarGenerationQueue';

export type CharacterCompletionField = 'base' | 'avatar' | 'visual' | 'bubble' | 'voice' | 'profile' | 'personality';
export type GroupClearFields = { basics: boolean; avatar: boolean; background: boolean };
const characterFields: CharacterCompletionField[] = ['base', 'avatar', 'visual', 'bubble', 'voice', 'profile', 'personality'];

function hasImageTask(target: string) {
  const task = avatarGenerationQueue.getLatestTaskForTarget(target);
  return task?.status === 'queued' || task?.status === 'running';
}

export function buildCharacterClearPatch(fields: CharacterCompletionField[]): Partial<AICharacter> {
  return {
    ...(fields.includes('base') ? { background: '', speakingStyle: '', expertise: [] } : {}),
    ...(fields.includes('avatar') ? { avatar: '' } : {}),
    ...(fields.includes('visual') ? { visualIdentity: null, visualReferenceImages: [] } : {}),
    ...(fields.includes('bubble') ? { bubbleStyle: null, bubbleStyleId: null } : {}),
    ...(fields.includes('voice') ? { voiceConfig: { enabled: false, voiceName: '' } } : {}),
    ...(fields.includes('profile') ? { coreProfile: { ...DEFAULT_CORE_PROFILE } } : {}),
    ...(fields.includes('personality') ? { personality: { openness: 0, extroversion: 0, agreeableness: 0, neuroticism: 0, humor: 0, creativity: 0, assertiveness: 0, empathy: 0 }, personalityDrift: {} } : {}),
  };
}

export async function clearCharacterData(characters: AICharacter[], fields: CharacterCompletionField[]) {
  if (characters.some((character) => characterFields.some((field) => getCharacterCompletionTaskStatus(character.id, field))
    || hasImageTask(`character:${character.id}`) || hasImageTask(`character-visual:${character.id}`))) {
    throw new Error('所选角色仍有生成任务，请等待任务结束后再清空。');
  }
  for (const character of characters) {
    if (fields.includes('visual') && useAuthStore.getState().authMode === 'cloud') {
      const assets = await api.listCharacterVisualAssets(character.id);
      for (const asset of assets) await api.deleteCharacterVisualAsset(character.id, asset.id);
    }
    await useCharacterStore.getState().updateCharacter(character.id, buildCharacterClearPatch(fields));
  }
}

export function buildGroupClearPatch(chat: GroupChat, fields: GroupClearFields): Partial<GroupChat> {
  return {
    ...(fields.basics ? { name: '', topic: '' } : {}),
    ...(fields.avatar || fields.background ? {
      groupVisual: {
        ...chat.groupVisual,
        ...(fields.avatar ? { avatarUrl: null } : {}),
        ...(fields.background ? { backgroundUrl: null, backgroundOpacity: undefined } : {}),
      },
    } : {}),
  };
}

export async function clearGroupData(chats: GroupChat[], fields: GroupClearFields) {
  if (chats.some((chat) => ['group-basics', 'group-avatar', 'chat-background'].some((field) => getChatCompletionTaskStatus(chat.id, field))
    || hasImageTask(`chat-avatar:${chat.id}`) || hasImageTask(`chat-background:${chat.id}`))) {
    throw new Error('所选群聊仍有生成任务，请等待任务结束后再清空。');
  }
  for (const chat of chats) {
    const current = useChatStore.getState().chats.find((item) => item.id === chat.id);
    if (!current) throw new Error('所选群聊已不存在，请刷新后重试。');
    await useChatStore.getState().updateChat(chat.id, buildGroupClearPatch(current, fields));
  }
}
