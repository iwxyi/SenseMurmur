import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { NarrativeLineProjection } from './narrativeProjection';
import { selectPrimaryNarrativeLine } from './narrativeProjection';
import { getGuidanceTargetActorIds, readStoredUserGuidanceIntent, type UserGuidanceIntent } from './userGuidanceIntent';
import { resolveSessionFamilyKey } from './sessionEngineKeys';

export type DirectorIntentSource =
  | 'user_message'
  | 'conversation_reply'
  | 'narrative_line'
  | 'conflict'
  | 'relationship'
  | 'faction'
  | 'growth'
  | 'emotion'
  | 'topic'
  | 'room_state';

export type DirectorBeatType =
  | 'answer'
  | 'challenge'
  | 'defend'
  | 'escalate'
  | 'cool_down'
  | 'reveal'
  | 'deflect'
  | 'summarize'
  | 'invite';

export interface DirectorIntent {
  source: DirectorIntentSource;
  targetLineId?: string;
  beatType: DirectorBeatType;
  targetActorIds: string[];
  pressure: number;
  reason: string;
  userGuidance?: UserGuidanceIntent | null;
}

export interface PendingReplyLike {
  targetIds: string[];
  primaryTargetId: string | null;
  sourceSpeakerId: string | null;
  unmetTurns: number;
  strength: 'soft' | 'strong';
}

function clampPressure(value: number) {
  return Math.max(0, Math.min(1, value));
}

function normalizePercent(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value / 100)) : 0;
}

function uniqueActorIds(ids: Array<string | null | undefined>, characters: AICharacter[]) {
  const knownIds = new Set(characters.map((character) => character.id));
  const resolved = ids.filter((id): id is string => typeof id === 'string' && knownIds.has(id));
  return resolved.filter((id, index, array) => array.indexOf(id) === index);
}

function getLatestVisibleMessage(messages: Message[]) {
  return messages.filter((message) => !message.isDeleted).at(-1) || null;
}

function isHumanGuidanceMessage(message: Message | null | undefined): message is Message {
  if (!message) return false;
  if (message.type === 'god') return true;
  // "speak as" user messages are character participation, not topic guidance.
  if (message.type === 'user' && message.metadata?.manualSpeaker) return false;
  return message.type === 'user';
}

function getLatestAiMessage(messages: Message[]) {
  return messages.filter((message) => message.type === 'ai' && !message.isDeleted).at(-1) || null;
}

function resolveUserMessageDirectorIntent(message: Message, characters: AICharacter[]): DirectorIntent {
  const guidance = readStoredUserGuidanceIntent(message, characters);
  if (guidance) {
    const targetActorIds = uniqueActorIds(getGuidanceTargetActorIds(guidance), characters);
    return {
      source: 'user_message',
      beatType: guidance.beatType,
      targetActorIds,
      pressure: guidance.pressure,
      reason: guidance.reason,
      userGuidance: guidance,
    };
  }
  return {
    source: 'user_message',
    beatType: 'invite',
    targetActorIds: [],
    pressure: 0.5,
    reason: '用户刚刚发言，下一轮应自然接住其真实意图。',
  };
}

function resolveConflictBeat(nextPressure?: string): DirectorBeatType {
  if (nextPressure === 'cool') return 'cool_down';
  if (nextPressure === 'divert') return 'deflect';
  if (nextPressure === 'stabilize') return 'defend';
  if (nextPressure === 'spread') return 'invite';
  return 'escalate';
}

function resolveLineIntent(line: NarrativeLineProjection): DirectorIntent {
  const beat = line.possibleNextBeats[0] || {
    beatType: line.type === 'conflict' ? 'escalate' : line.type === 'relationship' ? 'invite' : 'summarize',
    targetActorIds: line.participantIds,
    pressure: line.salience,
    reason: line.summary,
  };
  return {
    source: line.type === 'conflict'
      ? 'conflict'
      : line.type === 'relationship'
        ? 'relationship'
        : line.type === 'faction'
          ? 'faction'
          : line.type === 'growth'
            ? 'growth'
          : 'narrative_line',
    targetLineId: line.id,
    beatType: beat.beatType,
    targetActorIds: beat.targetActorIds,
    pressure: clampPressure(Math.max(beat.pressure, line.salience)),
    reason: beat.reason || line.summary,
  };
}

function isAnalysisRoom(chat: GroupChat) {
  return resolveSessionFamilyKey(chat) === 'analysis';
}

function adaptIntentForAnalysisRoom(intent: DirectorIntent): DirectorIntent {
  if (intent.source === 'user_message') return intent;
  if (intent.beatType !== 'defend' && intent.source !== 'faction') return intent;
  return {
    ...intent,
    source: intent.source === 'faction' ? 'topic' : intent.source,
    beatType: 'summarize',
    targetActorIds: [],
    pressure: clampPressure(Math.max(0.42, intent.pressure * 0.82)),
    reason: intent.source === 'faction'
      ? '审议房不使用阵营防守压力；转为梳理论点差异和待检验前提。'
      : '审议房不把稳定压力翻译为保护某个角色；转为梳理争点。',
  };
}

export function resolveDirectorIntent(params: {
  chat: GroupChat;
  characters: AICharacter[];
  messages: Message[];
  pendingReplyContext?: PendingReplyLike | null;
  narrativeLines?: NarrativeLineProjection[];
}): DirectorIntent {
  const analysisRoom = isAnalysisRoom(params.chat);
  const finalize = (intent: DirectorIntent) => analysisRoom ? adaptIntentForAnalysisRoom(intent) : intent;
  const latestMessage = getLatestVisibleMessage(params.messages);
  const latestAiMessage = getLatestAiMessage(params.messages);
  const pending = params.pendingReplyContext;
  if (isHumanGuidanceMessage(latestMessage)) {
    return resolveUserMessageDirectorIntent(latestMessage, params.characters);
  }

  // Background without a proposed beat supplies context, not a task to
  // synthesize through resolveLineIntent's legacy fallback.
  const actionableLines = (params.narrativeLines || []).filter((line) =>
    (line.visibility === 'public' || line.visibility === 'derived_public')
    && (line.contextKind !== 'background' || line.possibleNextBeats.length > 0));
  const primaryLine = selectPrimaryNarrativeLine(actionableLines);
  const factualLine = selectPrimaryNarrativeLine(actionableLines.filter((line) => line.type !== 'relationship'));

  if (pending?.targetIds.length) {
    return finalize({
      // AI-to-AI reply debt must not acquire user guidance locks.
      source: 'conversation_reply',
      targetLineId: factualLine?.id,
      beatType: 'answer',
      targetActorIds: pending.targetIds,
      pressure: clampPressure((pending.strength === 'strong' ? 0.82 : 0.58) + Math.min(0.16, pending.unmetTurns * 0.04)),
      reason: pending.sourceSpeakerId
        ? '被点名角色还有未回应的期待。'
        : '有角色被点名，需要在房间漂移前接住回应。',
    });
  }

  if (primaryLine) {
    return finalize(resolveLineIntent(factualLine || primaryLine));
  }

  const primaryConflict = params.chat.worldState.conflictState?.primaryConflict || null;
  if (primaryConflict && primaryConflict.stage !== 'resolved') {
    const targetActorIds = uniqueActorIds([
      ...(primaryConflict.targetIds || []),
      ...(primaryConflict.participantIds || []),
    ], params.characters);
    return finalize({
      source: 'conflict',
      targetLineId: primaryConflict.id,
      beatType: primaryConflict.severity === 0 ? 'answer' : resolveConflictBeat(primaryConflict.nextPressure),
      targetActorIds,
      pressure: clampPressure(primaryConflict.severity === 0 ? 0.18 : 0.46 + primaryConflict.severity * 0.42),
      reason: primaryConflict.summary || '主要矛盾仍在生效。',
    });
  }

  const room = params.chat.worldState.structuredRoomState;
  if (room?.pileOnTarget) {
    const roomHeat = normalizePercent(room.heat);
    return finalize({
      source: 'room_state',
      beatType: roomHeat > 0.68 ? 'cool_down' : 'defend',
      targetActorIds: uniqueActorIds([room.pileOnTarget], params.characters),
      pressure: clampPressure(0.48 + roomHeat * 0.34),
      reason: '房间里出现了持续指向同一角色的压力，需要回应或降温。',
    });
  }

  const topicDrift = normalizePercent(room?.topicDrift);
  if (room && topicDrift > 0.62 && resolveSessionFamilyKey(params.chat) !== 'conversation') {
    return finalize({
      source: 'room_state',
      beatType: 'summarize',
      targetActorIds: [],
      pressure: clampPressure(0.44 + topicDrift * 0.28),
      reason: '房间话题已经明显漂移，适合转向或收束。',
    });
  }

  const ambientConversation = Boolean(latestAiMessage) && resolveSessionFamilyKey(params.chat) === 'conversation';
  return finalize({
    source: latestAiMessage ? 'topic' : 'room_state',
    beatType: latestAiMessage ? 'invite' : 'summarize',
    targetActorIds: latestAiMessage && !ambientConversation ? uniqueActorIds([latestAiMessage.senderId], params.characters) : [],
    pressure: ambientConversation ? 0 : latestAiMessage ? 0.34 : 0.22,
    reason: ambientConversation ? '最近发言仅提供话题背景，未产生新的受话对象或接话任务。'
      : latestAiMessage ? '延续当前正在进行的话题，不强行推进新剧情。' : '目前还没有明显的叙事压力。',
  });
}

export function describeDirectorIntent(intent: DirectorIntent) {
  const targets = intent.targetActorIds.length ? intent.targetActorIds.join(',') : 'group';
  const guidance = intent.userGuidance ? `; guidance=${intent.userGuidance.kind}; userText=${intent.userGuidance.rawText}` : '';
  return `source=${intent.source}; beat=${intent.beatType}; targets=${targets}; pressure=${intent.pressure.toFixed(2)}; reason=${intent.reason}${guidance}`;
}
