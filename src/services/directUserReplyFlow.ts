import type { APIConfig, AIModelProfile } from '../types/settings';
import type { AICharacter } from '../types/character';
import type { DriverMessageCommitResult, GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { decayEmotionalState, getEmotionalBaseline } from './personalityDrift';
import { resolveRuntimeEvolutionConfig } from './runtimeEvolutionConfig';
import { retainRuntimeEvents } from './runtimeEventRetention';
import { updateCharacterLayeredMemories } from './characterLayeredMemory';
import { accumulateCharacterRuntime } from './characterRuntime';
import { getCharacterGroupLabel } from '../types/character';
import { projectCurrentChatMessages } from './currentChatMessages';
import { useMessageStore } from '../stores/useMessageStore';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import type { LocalInterceptionEvent } from './chatEngine';
import { resolveDirectCompanionshipAssessmentEvents } from './directCompanionshipAssessment';
import { resolveCompanionshipRitualEventsFromDirectUserMessage } from './directCompanionshipRitual';
import { buildSharedPhraseEventsFromCompanionshipEvents } from './companionshipSharedPhraseBackflow';
import { reportRecoverableError } from './diagnostics';
import { GenerationCancelledError } from './generationCancellation';
import { logDeveloperDiagnostic } from './developerDiagnostics';
import { reduceRelationshipLedgerWithCompanionshipEvent } from './companionshipLedgerBackflow';

function ensureDirectReplyStillCurrent(params: { signal?: AbortSignal; shouldContinue?: () => boolean }) {
  if (params.signal?.aborted) throw new GenerationCancelledError();
  if (params.shouldContinue && !params.shouldContinue()) throw new GenerationCancelledError('单聊回复所属分支已切换');
}

export async function runDirectUserReplyFlow(params: {
  api: APIConfig | APIConfig[];
  aiProfiles: AIModelProfile[];
  chatId: string;
  chat: GroupChat;
  userMessage: Message;
  content: string;
  characters: AICharacter[];
  updateCharacter: (id: string, patch: Partial<AICharacter>) => Promise<void>;
  updateCharacters: (patches: Array<{ id: string; updates: Partial<AICharacter> }>) => Promise<void>;
  upsertMessage: (message: Message) => void;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number]) => Promise<void>;
  appendEventMessages?: (chatId: string, payloads: DriverMessageCommitResult['runtimeEvents'], sourceMessageId?: string) => Promise<void>;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  applyChatRuntimeDelta?: (id: string, delta: NonNullable<DriverMessageCommitResult['chatRuntimeDelta']>, patch?: Partial<GroupChat>) => Promise<void>;
  recordSpeak: (characterId: string) => void;
  onLocalInterception?: (event: LocalInterceptionEvent) => void | Promise<void>;
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
  deferRuntimePersistenceUntilCommit?: boolean;
}) {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = () => Number(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt).toFixed(2));
  logDeveloperDiagnostic('direct-reply:start', {
    chatId: params.chatId,
    userMessageId: params.userMessage.id,
    branchNodeId: params.userMessage.metadata?.branching?.nodeId || null,
  }, 'info', 'chat-run');
  ensureDirectReplyStillCurrent(params);
  const directCharacterId = params.chat.memberIds[0];
  const cachedDirectCharacter = params.characters.find((item) => item.id === directCharacterId);
  const characterLoadStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const directCharacter = (cachedDirectCharacter?.characterDetailLoaded === false
    ? await useCharacterStore.getState().loadCharacter(directCharacterId)
    : cachedDirectCharacter) || cachedDirectCharacter;
  logDeveloperDiagnostic('direct-reply:character-ready', {
    chatId: params.chatId,
    characterId: directCharacterId,
    loadedDetail: cachedDirectCharacter?.characterDetailLoaded === false,
    elapsedMs: Number(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - characterLoadStartedAt).toFixed(2)),
    totalElapsedMs: elapsed(),
  }, 'info', 'chat-run');
  if (!directCharacter) return;
  ensureDirectReplyStillCurrent(params);
  const generationCharacters = useCharacterStore.getState().characters.length
    ? useCharacterStore.getState().characters
    : params.characters;
  const getProjectedMessages = () => projectCurrentChatMessages({
    chatId: params.chatId,
    chat: useChatStore.getState().chats.find((item) => item.id === params.chat.id) || params.chat,
    activeMessages: useMessageStore.getState().messages,
    cachedWindow: useMessageStore.getState().messageWindowsByChatId[params.chatId],
  });
  const textApiConfig = Array.isArray(params.api) ? params.api[0] : params.api;
  const chatForGeneration = params.chat;
  const scheduleDirectRuntimeAssessment = () => {
    void (async () => {
      if (params.signal?.aborted || (params.shouldContinue && !params.shouldContinue())) return;
      const latestChat = useChatStore.getState().chats.find((item) => item.id === params.chat.id) || params.chat;
      const latestCharacter = useCharacterStore.getState().characters.find((item) => item.id === directCharacter.id) || directCharacter;
      const recentMessages = getProjectedMessages();
      const assessmentEvents = await resolveDirectCompanionshipAssessmentEvents({
        chat: latestChat,
        character: latestCharacter,
        message: params.userMessage,
        textApiConfig,
        recentMessages,
      });
      const ritualEvents = await resolveCompanionshipRitualEventsFromDirectUserMessage({
        chat: latestChat,
        character: latestCharacter,
        message: params.userMessage,
        textApiConfig,
        recentMessages,
      });
      const baseCompanionshipEvents = [...assessmentEvents, ...ritualEvents].filter((event): event is RuntimeEventV2 => Boolean(event));
      const sharedPhraseEvents = buildSharedPhraseEventsFromCompanionshipEvents({
        chat: latestChat,
        character: latestCharacter,
        events: baseCompanionshipEvents,
      });
      const companionshipEvents = [...baseCompanionshipEvents, ...sharedPhraseEvents];
      if (!companionshipEvents.length) return;
      if (params.signal?.aborted || (params.shouldContinue && !params.shouldContinue())) return;
      const currentChat = useChatStore.getState().chats.find((item) => item.id === params.chat.id) || latestChat;
      const runtimeEventsV2 = retainRuntimeEvents([
        ...(currentChat.runtimeEventsV2 || []).filter((event) => !event.evidenceMessageIds?.includes(params.userMessage.id)),
        ...companionshipEvents,
      ], 160);
      const relationshipLedger = companionshipEvents.reduce(
        (entries, event) => reduceRelationshipLedgerWithCompanionshipEvent(entries, event),
        currentChat.relationshipLedger || [],
      );
      await params.updateChat(params.chat.id, { runtimeEventsV2, relationshipLedger });
    })();
  };

  const evolution = resolveRuntimeEvolutionConfig(params.chat.runtimeEvolutionIntensity);
  const drift = directCharacter.personalityDrift || {};
  // The user's words are already visible to the generation model. Do not run a
  // second, local keyword interpretation before the reply; model-authored
  // interaction assessment persists the semantic after-effect asynchronously.
  const emotion = decayEmotionalState(directCharacter.emotionalState || getEmotionalBaseline(), 'target');
  const directRuntimePatch: Partial<AICharacter> = {
    personalityDrift: drift,
    emotionalState: emotion,
    layeredMemories: updateCharacterLayeredMemories({
      character: { ...directCharacter, emotionalState: emotion },
      content: params.content,
      personalityDrift: drift,
      sourceEventTag: 'direct_user_message',
    }),
    runtimeTimeline: accumulateCharacterRuntime(directCharacter, {
      type: 'memory',
      text: `${getCharacterGroupLabel(directCharacter.group) || '单聊'}中与用户互动：${params.content.slice(0, 48)}`,
    }).concat(
      Object.keys(drift).length ? [{ type: 'drift' as const, text: '与用户互动后产生性格漂移', createdAt: Date.now() }] : []
    ).slice(-24),
  };
  const directCharacterForGeneration = { ...directCharacter, ...directRuntimePatch };
  const generationCharactersForTurn = generationCharacters.map((character) =>
    character.id === directCharacter.id ? { ...character, ...directRuntimePatch } : character
  );
  const persistDirectRuntimePatch = () => {
    void params.updateCharacter(directCharacter.id, directRuntimePatch).catch((error) => {
      reportRecoverableError({
        location: 'direct-user-reply.runtime-persist',
        error,
        userMessage: '单聊运行态保存失败，当前回复不受影响。',
        extra: { chatId: params.chatId, characterId: directCharacter.id },
      });
    });
  };
  if (!params.deferRuntimePersistenceUntilCommit) persistDirectRuntimePatch();

  const [{ generateAndCommitAiMessage }, { resolveSessionEngine }] = await Promise.all([
    import('./aiMessageOrchestrator'),
    import('./sessionEngineRegistry'),
  ]);
  logDeveloperDiagnostic('direct-reply:modules-ready', {
    chatId: params.chatId,
    totalElapsedMs: elapsed(),
  }, 'debug', 'chat-run');
  ensureDirectReplyStillCurrent(params);
  const sessionEngine = resolveSessionEngine(params.chat);
  const projectedMessagesForGeneration = getProjectedMessages();
  logDeveloperDiagnostic('direct-reply:generation-start', {
    chatId: params.chatId,
    characterId: directCharacter.id,
    projectedMessages: projectedMessagesForGeneration.length,
    totalElapsedMs: elapsed(),
  }, 'info', 'chat-run');

  await generateAndCommitAiMessage({
    api: textApiConfig,
    aiProfiles: params.aiProfiles,
    chatId: params.chatId,
    chat: chatForGeneration,
    speaker: directCharacterForGeneration,
    characters: generationCharactersForTurn,
    timestamp: params.userMessage.timestamp + 1,
    currentMessages: projectedMessagesForGeneration,
    onLocalInterception: params.onLocalInterception,
    signal: params.signal,
    shouldContinue: params.shouldContinue,
    generationContext: {
      buildPromptContext: (speaker) => sessionEngine.buildGenerationPromptContext?.({
        conversation: chatForGeneration,
        characters: generationCharactersForTurn,
        messages: projectedMessagesForGeneration,
        speaker,
      }) || null,
    },
    onCommit: async (args) => await (sessionEngine.onMessageCommitted as (commitArgs: {
      conversation: GroupChat;
      characters: AICharacter[];
      message: Pick<Message, 'content' | 'type' | 'senderId'>;
      previousAiMessage: Pick<Message, 'senderId'> | null;
      recentMessages?: Message[];
      apiConfig?: APIConfig;
    }) => DriverMessageCommitResult | Promise<DriverMessageCommitResult>)(args),
    upsertMessage: params.upsertMessage,
    updateCharacter: params.updateCharacter,
    updateCharacters: async (patches) => params.updateCharacters(patches.map((patch) => ({ id: patch.id, updates: patch.patch }))),
    appendEventMessage: params.appendEventMessage,
    appendEventMessages: params.appendEventMessages,
    updateChat: params.updateChat,
    applyChatRuntimeDelta: params.applyChatRuntimeDelta,
    recordSpeak: params.recordSpeak,
    getCurrentChat: (chatId) => useChatStore.getState().chats.find((item) => item.id === chatId),
    getCurrentCharacters: () => {
      const currentCharacters = useCharacterStore.getState().characters;
      const source = currentCharacters.length ? currentCharacters : generationCharactersForTurn;
      return source.map((character) =>
        character.id === directCharacter.id ? { ...character, ...directRuntimePatch } : character
      );
    },
  });
  ensureDirectReplyStillCurrent(params);
  if (params.deferRuntimePersistenceUntilCommit) persistDirectRuntimePatch();
  logDeveloperDiagnostic('direct-reply:finished', {
    chatId: params.chatId,
    characterId: directCharacter.id,
    totalElapsedMs: elapsed(),
  }, 'info', 'chat-run');
  scheduleDirectRuntimeAssessment();
}
