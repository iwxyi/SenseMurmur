import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useMessageStore } from '../stores/useMessageStore';
import { createChatAutoSocialScheduler } from './useChatAutoSocialFlow';
import { runAutoSocialEventFlowImpl, type AutoSocialEventFlowContext } from '../services/chatSurfaceActions';
import { buildPrivateSessionEvent } from '../services/directSessionHelpers';
import { buildRuntimeEventMessageContent, normalizeRuntimeEvent } from '../services/runtimeEventFactory';
import { persistLocalFirstMessage } from '../services/chatCommitMessage';
import { reportRecoverableError } from '../services/diagnostics';
import { runDailyMomentFlow } from '../services/dailyMomentRuntime';
import { getLocalDataUserId } from '../services/authStorageScope';
import type { GroupChat } from '../types/chat';
import { getUsablePreferredAIProfile } from '../types/settings';

export function getDailyMomentImageErrorMessage(error: unknown) {
  const diagnostic = error && typeof error === 'object' && 'diagnostic' in error
    ? error.diagnostic as { status?: number; code?: string } | undefined : undefined;
  const code = diagnostic?.code?.toLowerCase() || '';
  if (diagnostic?.status === 429) return '朋友圈配图服务请求受限，本次发布文字动态。';
  if (diagnostic?.status === 402 || /quota|insufficient|balance|points/.test(code)) {
    return '朋友圈配图额度不足，本次发布文字动态。';
  }
  if (diagnostic?.status === 401 || diagnostic?.status === 403) {
    return '朋友圈配图服务无权访问，本次发布文字动态。';
  }
  return '朋友圈配图生成失败，本次发布文字动态。';
}

export function createApplicationSocialScheduler() {
  const schedulers = new Map<string, ReturnType<typeof createChatAutoSocialScheduler>>();
  return {
    update(chats: GroupChat[], run: (chat: GroupChat) => Promise<unknown>, onError: (error: unknown) => void) {
      const available = chats.filter((chat) => chat.type === 'group' && chat.deletedAt == null);
      const ids = new Set(available.map((chat) => chat.id));
      for (const [id, scheduler] of schedulers) {
        if (!ids.has(id)) {
          scheduler.dispose();
          schedulers.delete(id);
        }
      }
      for (const chat of available) {
        let scheduler = schedulers.get(chat.id);
        if (!scheduler) {
          scheduler = createChatAutoSocialScheduler();
          schedulers.set(chat.id, scheduler);
        }
        scheduler.update({ chat, runAutoSocialEventFlow: run, onError });
      }
    },
    dispose() {
      schedulers.forEach((scheduler) => scheduler.dispose());
      schedulers.clear();
    },
  };
}

const appendEventMessage: AutoSocialEventFlowContext['appendEventMessage'] = async (chatId, payload) => {
  const chat = useChatStore.getState().getChat(chatId);
  if (!chat || chat.deletedAt != null) return;
  const event = normalizeRuntimeEvent(buildPrivateSessionEvent(chat, payload));
  await persistLocalFirstMessage({
    message: { chatId, type: 'event', senderId: 'system', senderName: 'System',
      content: buildRuntimeEventMessageContent(event), emotion: 0 },
    timestamp: event.createdAt,
    upsertMessage: useMessageStore.getState().upsertMessage,
  });
};

export function useApplicationSocialFlow() {
  const chats = useChatStore((state) => state.chats);
  const characters = useCharacterStore((state) => state.characters);
  const aiProfiles = useSettingsStore((state) => state.aiProfiles);
  const schedulerRef = useRef<ReturnType<typeof createApplicationSocialScheduler> | null>(null);
  useEffect(() => {
    const scheduler = createApplicationSocialScheduler();
    schedulerRef.current = scheduler;
    return () => { scheduler.dispose(); schedulerRef.current = null; };
  }, []);
  useEffect(() => {
    schedulerRef.current?.update(chats, async (chat) => {
      const dataUserId = getLocalDataUserId();
      const isCurrentSource = () => {
        const source = useChatStore.getState().getChat(chat.id);
        return getLocalDataUserId() === dataUserId && source != null && source.deletedAt == null;
      };
      const loaded = await useChatStore.getState().loadChat(chat.id);
      if (!loaded || loaded.deletedAt != null || !isCurrentSource()) return;
      let dailyFailure: { error: unknown } | undefined;
      let nextCheckAt: number | undefined;
      try {
        const dailyResult = await runDailyMomentFlow(chat.id, {
          isCurrentSource,
          getChats: () => useChatStore.getState().chats,
          getCharacters: () => useCharacterStore.getState().characters,
          getProfiles: () => useSettingsStore.getState().aiProfiles,
          loadCharacter: (id) => useCharacterStore.getState().loadCharacter(id),
          applyChatRuntimePatch: useChatStore.getState().applyChatRuntimePatch,
          onImageError: (error) => {
            const profile = getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'image');
            reportRecoverableError({ location: 'daily-moment-image', error,
              extra: { provider: profile?.provider, model: profile?.model },
              userMessage: getDailyMomentImageErrorMessage(error) });
          },
        });
        nextCheckAt = dailyResult?.nextCheckAt;
      } catch (error) {
        dailyFailure = { error };
      }
      if (!isCurrentSource()) return;
      const result = await runAutoSocialEventFlowImpl(loaded, {
        chats: useChatStore.getState().chats,
        characters: useCharacterStore.getState().characters,
        aiProfiles: useSettingsStore.getState().aiProfiles,
        updateChat: useChatStore.getState().updateChat,
        addMessage: useMessageStore.getState().addMessage,
        appendEventMessage,
      });
      if (dailyFailure) throw dailyFailure.error;
      return nextCheckAt ? { nextCheckAt } : result;
    }, (error) => reportRecoverableError({ location: 'application-social-flow', error,
      userMessage: '自动社交活动未完成，将按重试策略处理。' }));
  }, [chats, characters, aiProfiles]);
}
