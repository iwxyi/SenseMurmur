import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { getLocalDataUserId } from '../services/authStorageScope';
import { reportRecoverableError } from '../services/diagnostics';
import { runPrivateSocialIntentFlow } from '../services/privateSocialIntentFlow';

export function usePrivateSocialIntentFlow() {
  const chats = useChatStore((state) => state.chats);
  const characters = useCharacterStore((state) => state.characters);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    const dataUserId = getLocalDataUserId();
    let cancelled = false;
    const isCurrent = () => !cancelled && getLocalDataUserId() === dataUserId;
    queue.current = queue.current.then(async () => {
      if (!isCurrent()) return;
      try {
        await runPrivateSocialIntentFlow({
          isCurrent,
          getChats: () => useChatStore.getState().chats,
          getCharacters: () => useCharacterStore.getState().characters,
          addChat: async (draft) => {
            if (!isCurrent()) throw new Error('私域意图交接已失效');
            return useChatStore.getState().addChat(draft);
          },
          applyPatch: (id, build) => isCurrent()
            ? useChatStore.getState().applyChatRuntimePatch(id, (chat) => isCurrent() ? build(chat) : null)
            : Promise.resolve(false),
        });
      } catch (error) {
        reportRecoverableError({ location: 'private-social-intent-flow', error,
          userMessage: '私聊意图交接未完成，后续更新时将重试。' });
      }
    });
    return () => { cancelled = true; };
  }, [chats, characters]);
}
