import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { buildDirectChatDraft } from './chatDraftBuilder';
import { getLocalDataUserId } from './authStorageScope';

const pending = new Map<string, Promise<string>>();

export function ensureCharacterDirectChat(characterId: string): Promise<string> {
  const scope = getLocalDataUserId();
  const key = `${scope}:${characterId}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const operation = (async () => {
    const character = useCharacterStore.getState().characters.find((item) => item.id === characterId && !item.deletedAt);
    if (!character) throw new Error('角色已不存在，无法发消息');
    const existing = useChatStore.getState().chats.find((item) => !item.deletedAt && item.type === 'direct' && item.memberIds.length === 1 && item.memberIds[0] === characterId);
    if (existing) return existing.id;
    const chat = await useChatStore.getState().addChat(buildDirectChatDraft(character.id, character.name));
    if (scope !== getLocalDataUserId()) throw new Error('账号已切换，请重新打开私聊');
    return chat.id;
  })();
  pending.set(key, operation);
  const release = () => { if (pending.get(key) === operation) pending.delete(key); };
  void operation.then(release, release);
  return operation;
}
