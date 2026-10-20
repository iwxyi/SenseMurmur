import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { CharacterMention, Message, MessageAttachment } from '../types/message';
import type { SessionActionSchema, SessionNormalizedIntentResult } from '../types/sessionEngine';
import type { AIModelProfile } from '../types/settings';
import { runAutoSocialEventFlowImpl, runSessionActionImpl, runSurfaceIntentImpl, type ChatSurfaceActionContext } from '../services/chatSurfaceActions';
import { useChatStore } from '../stores/useChatStore';

interface UseChatSurfaceActionsParams {
  chat: GroupChat | undefined;
  chats: GroupChat[];
  characters: AICharacter[];
  updateChat: (id: string, updates: Partial<GroupChat>) => Promise<void>;
  addMessage: (input: Omit<Message, 'id' | 'timestamp' | 'isDeleted'> & { timestamp?: number }) => Promise<unknown>;
  appendEventMessage: (
    chatId: string,
    payload: {
      eventType: string;
      title: string;
      summary: string;
      pair?: [string, string];
      metrics?: unknown;
      visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';
      visibleToIds?: string[];
      visibleToRoles?: string[];
      createdAt?: number;
      sourceMessageId?: string;
    },
  ) => Promise<void>;
  actionSchema: SessionActionSchema | null;
  aiProfiles?: AIModelProfile[];
  speakAsChar: AICharacter | null;
  handleGuideSend: (content: string, attachments?: MessageAttachment[], mentions?: CharacterMention[]) => Promise<void>;
  handleMemberSpeakSend: (content: string, attachments?: MessageAttachment[], mentions?: CharacterMention[]) => Promise<void>;
  handleSpeakAs: (content: string, attachments?: MessageAttachment[], mentions?: CharacterMention[]) => Promise<void>;
  setSnackbar: (value: { open: boolean; message: string; severity: 'error' | 'success' }) => void;
}

export function useChatSurfaceActions(params: UseChatSurfaceActionsParams) {
  const navigate = useNavigate();
  const context: ChatSurfaceActionContext = {
    chat: params.chat,
    chats: params.chats,
    characters: params.characters,
    actionSchema: params.actionSchema,
    speakAsChar: params.speakAsChar,
    updateChat: params.updateChat,
    addMessage: params.addMessage,
    appendEventMessage: params.appendEventMessage,
    setSnackbar: params.setSnackbar,
  };

  const triggerPairPrivateThread = useCallback(async (sourceChat: GroupChat, actorId: string, targetId: string, navigateAfterCreate = false) => {
    if (!actorId || !targetId || actorId === targetId) return null;
    const { createAiPrivateThread } = await import('../services/directSessionRuntime');
    const privateChat = await createAiPrivateThread({
      sourceChat,
      chats: params.chats,
      characters: params.characters,
      starterId: actorId,
      targetId,
      addChat: async (input) => useChatStore.getState().addChat(input),
      addMessage: params.addMessage,
      appendEventMessage: params.appendEventMessage,
    });
    if (privateChat && navigateAfterCreate) navigate(`/chats/${privateChat.id}`);
    return privateChat;
  }, [navigate, params.addMessage, params.appendEventMessage, params.characters, params.chats]);

  const runSessionAction = useCallback(async (action: { type: string; actorId?: string }, payload: Record<string, unknown>) => {
    return runSessionActionImpl(context, action, payload, triggerPairPrivateThread);
  }, [context, triggerPairPrivateThread]);

  const runSurfaceIntent = useCallback(async (surfaceResult: SessionNormalizedIntentResult) => {
    await runSurfaceIntentImpl(context, surfaceResult, {
      runSessionAction,
      handleGuideSend: params.handleGuideSend,
      handleMemberSpeakSend: params.handleMemberSpeakSend,
      handleSpeakAs: params.handleSpeakAs,
    });
  }, [context, params.handleGuideSend, params.handleMemberSpeakSend, params.handleSpeakAs, runSessionAction]);

  const normalizeAndRunSurfaceIntent = useCallback(async (...args: Parameters<typeof import('../types/sessionEngine')['buildNormalizedIntentResult']>) => {
    const { buildNormalizedIntentResult } = await import('../types/sessionEngine');
    await runSurfaceIntent(buildNormalizedIntentResult(...args));
  }, [runSurfaceIntent]);

  const runAutoSocialEventFlow = useCallback(async (sourceChat: GroupChat) => {
    return runAutoSocialEventFlowImpl(sourceChat, {
      chats: params.chats,
      characters: params.characters,
      aiProfiles: params.aiProfiles,
      updateChat: params.updateChat,
      addMessage: params.addMessage,
      appendEventMessage: params.appendEventMessage,
    });
  }, [params.addMessage, params.aiProfiles, params.appendEventMessage, params.characters, params.chats, params.updateChat]);

  return {
    runSessionAction,
    triggerPairPrivateThread,
    runSurfaceIntent,
    normalizeAndRunSurfaceIntent,
    runAutoSocialEventFlow,
  };
}
