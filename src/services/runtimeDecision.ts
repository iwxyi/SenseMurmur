import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { resolveDirectorIntent, type DirectorIntent, type PendingReplyLike } from './directorIntent';
import { resolveActiveDirectorIntervention, resolveLatestActiveUserGuidance } from './guidanceLifecycle';
import { projectNarrativeLines, selectPrimaryNarrativeLine, type NarrativeLineProjection } from './narrativeProjection';

export { resolveLatestActiveUserGuidance, type HumanGuidanceResolution } from './guidanceLifecycle';

export interface RuntimePressureProjection {
  narrativeLines: NarrativeLineProjection[];
  primaryLine: NarrativeLineProjection | null;
  directorIntent: DirectorIntent | null;
}

export function shouldUseFreeSpeechRuntimeDecision(chat: GroupChat) {
  if (chat.type !== 'group') return false;
  if (chat.scenarioState?.currentTurnActorId) return false;
  const freeSpeaking = chat.modeConfig?.freeSpeaking;
  return freeSpeaking !== false;
}

export function projectRuntimePressure(params: {
  chat: GroupChat;
  characters: AICharacter[];
  messages: Message[];
  pendingReplyContext?: PendingReplyLike | null;
  now?: number;
}): RuntimePressureProjection {
  const now = typeof params.now === 'number' && Number.isFinite(params.now) ? Math.round(params.now) : Date.now();
  const activeMessages = params.messages.filter((message) => !message.isDeleted);
  // Fixed-turn and non-group sessions still need to honor an explicitly
  // assessed user request. They do not get free-speech narrative pressure or
  // autonomous conflict projection, but dropping the guidance here means the
  // scheduler cannot select the requested character at all.
  if (!shouldUseFreeSpeechRuntimeDecision(params.chat)) {
    const latestHumanGuidance = resolveLatestActiveUserGuidance(params.characters, activeMessages, now);
    return {
      narrativeLines: [],
      primaryLine: null,
      directorIntent: latestHumanGuidance.intent,
    };
  }
  const narrativeLines = projectNarrativeLines({
    chat: params.chat,
    characters: params.characters,
    messages: activeMessages,
    now,
  });
  const latestHumanGuidance = resolveLatestActiveUserGuidance(params.characters, activeMessages, now);
  const directorIntervention = resolveActiveDirectorIntervention(params.chat, params.characters, activeMessages, now, latestHumanGuidance.timestamp)?.intent;
  if (directorIntervention) {
    return {
      narrativeLines,
      primaryLine: selectPrimaryNarrativeLine(narrativeLines),
      directorIntent: directorIntervention,
    };
  }
  if (latestHumanGuidance.intent) {
    return {
      narrativeLines,
      primaryLine: selectPrimaryNarrativeLine(narrativeLines),
      directorIntent: latestHumanGuidance.intent,
    };
  }
  const directorIntent = resolveDirectorIntent({
    chat: params.chat,
    characters: params.characters,
    messages: activeMessages,
    pendingReplyContext: params.pendingReplyContext,
    narrativeLines,
  });
  return {
    narrativeLines,
    primaryLine: selectPrimaryNarrativeLine(narrativeLines),
    directorIntent,
  };
}
