import { normalizeConversation, DEFAULT_OPEN_CHAT_MODE_CONFIG, DEFAULT_OPEN_CHAT_MODE_STATE, type GroupChat } from '../types/chat';
import { normalizeCharacter, DEFAULT_PERSONALITY, type AICharacter } from '../types/character';

export function createTestChat(patch: Partial<GroupChat> = {}): GroupChat {
  return normalizeConversation({
    id: 'chat', type: 'group', mode: 'open_chat',
    modeConfig: { ...DEFAULT_OPEN_CHAT_MODE_CONFIG }, modeState: { ...DEFAULT_OPEN_CHAT_MODE_STATE },
    name: 'Test room', topic: '', style: 'free', memberIds: [], speed: 1,
    isActive: false, allowIntervention: true, topicSeed: '',
    createdAt: 1, updatedAt: 1, lastMessageAt: 1, ...patch,
  });
}

export function createTestCharacter(patch: Partial<AICharacter> = {}): AICharacter {
  return normalizeCharacter({
    id: 'actor', name: 'Actor', avatar: '', personality: { ...DEFAULT_PERSONALITY },
    expertise: [], speakingStyle: '', background: '', isPreset: false,
    createdAt: 1, updatedAt: 1, ...patch,
  });
}
