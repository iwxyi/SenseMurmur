import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { isReplyWorthyInteractionKind } from '../types/runtimeEvent';
import { extractKeywords, calculateTopicRelevance } from './topicExtractor';
import { getRelationshipWeight } from './relationshipEngine';
import { applyDriftToBehavior } from './personalityDrift';
import type { DirectorIntent } from './directorIntent';
import { buildSpeakerScoreBreakdown, getDirectorIntentSpeakerBias, type SpeakerScoreBreakdown } from './speakerScoring';
import { getInnerLifeSpeakerBias, projectInnerLife } from './innerLifeEngine';
import { projectWorldAttentionStates } from './worldRuntimeProjection';
import { canUseMute } from './conversationCapabilities';
import { getEffectiveCharacterPresence, isCharacterAvailableForScheduling } from './characterPresence';
import { deriveCharacterTurnDrive, getCharacterTurnDriveSpeakerBias } from './characterTurnDrive';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getEmotionalMomentum(character: AICharacter) {
  const emotional = character.emotionalState;
  if (!emotional) return 0;

  const positiveDrive = emotional.excitement * 0.008 + emotional.affection * 0.004;
  const tensionDrive = emotional.irritation * 0.006 + emotional.insecurity * 0.004;
  const inhibition = emotional.embarrassment * 0.007;
  return clamp(positiveDrive + tensionDrive - inhibition, -0.18, 0.26);
}

function getEmotionalSpeakerReason(character: AICharacter) {
  const emotional = character.emotionalState;
  if (!emotional) return '';
  const tension = emotional.irritation + emotional.insecurity * 0.7;
  const warmth = emotional.affection + emotional.excitement * 0.45;
  if (tension >= 18) return 'emotion:tension';
  if (warmth >= 18) return 'emotion:warmth';
  if (emotional.excitement >= 14) return 'emotion:energy';
  return '';
}

function getEmotionalReplyBias(character: AICharacter, lastSpeakerId?: string) {
  if (!lastSpeakerId) return 0;
  const relationWeight = getRelationshipWeight(character, lastSpeakerId);
  const safeRelationWeight = Number.isFinite(relationWeight) ? relationWeight : 0;
  const emotional = character.emotionalState;
  if (!emotional) return safeRelationWeight > 0 ? safeRelationWeight * 0.08 : Math.abs(safeRelationWeight) * 0.1;

  const irritationBias = emotional.irritation >= 8 ? Math.max(0, -safeRelationWeight) * 0.16 : 0;
  const affectionBias = emotional.affection >= 8 ? Math.max(0, safeRelationWeight) * 0.14 : 0;
  const insecurityPenalty = emotional.insecurity > 65 && safeRelationWeight < 0 ? -0.08 : 0;

  return (safeRelationWeight > 0 ? safeRelationWeight * 0.08 : Math.abs(safeRelationWeight) * 0.1) + irritationBias + affectionBias + insecurityPenalty;
}

function hasRecentSpeakerStreak(messages: Message[], charId: string) {
  const recentAi = messages.filter((message) => message.type === 'ai' && !message.isDeleted).slice(-3);
  return recentAi.length >= 2 && recentAi.every((message) => message.senderId === charId);
}

function hasRecentSameTargetLoop(messages: Message[], charId: string, targetId?: string) {
  if (!targetId) return false;
  const recentAi = messages.filter((message) => message.type === 'ai' && !message.isDeleted).slice(-5);
  const sameSpeakerTurns = recentAi.filter((message) => message.senderId === charId);
  const lastTwoAi = recentAi.slice(-2);
  return sameSpeakerTurns.length >= 2
    && recentAi.at(-1)?.senderId === charId
    && lastTwoAi.length === 2
    && lastTwoAi[0].senderId === targetId
    && lastTwoAi[1].senderId === charId;
}

function hasTwoActorExchangeLoop(recentAiMessages: Message[], sourceSpeakerId?: string | null, targetId?: string | null) {
  if (!sourceSpeakerId || !targetId || sourceSpeakerId === targetId) return false;
  const recent = recentAiMessages.slice(-4);
  if (recent.length < 3) return false;
  const pair = new Set([sourceSpeakerId, targetId]);
  return recent.every((message) => pair.has(message.senderId))
    && recent.some((message) => message.senderId === sourceSpeakerId)
    && recent.some((message) => message.senderId === targetId);
}

function hasTwoActorDominance(recentAiMessages: Message[]) {
  const recent = recentAiMessages.slice(-3);
  if (recent.length < 3) return false;
  const speakers = new Set(recent.map((message) => message.senderId));
  return speakers.size === 2;
}

export function isChatMemberMuted(chat: Pick<GroupChat, 'governance' | 'scenarioState'> | null | undefined, memberId: string) {
  if (!chat || !canUseMute(chat)) return false;
  const seat = chat.scenarioState?.seats?.find((item) => item.actorId === memberId);
  return seat?.muted === true || seat?.canSpeak === false;
}

export interface WeightedCandidate {
  characterId: string;
  weight: number;
  prefersSilence?: boolean;
  scoreBreakdown?: SpeakerScoreBreakdown;
}

export interface PendingReplyContext {
  targetIds: string[];
  primaryTargetId: string | null;
  sourceSpeakerId: string | null;
  sourceMessageId: string | null;
  unmetTurns: number;
  strength: 'soft' | 'strong';
}

export interface ConflictSpeakerContext {
  participantIds: string[];
  targetIds: string[];
  nextPressure: NonNullable<NonNullable<GroupChat['worldState']['conflictState']>['primaryConflict']>['nextPressure'];
  developmentHooks: NonNullable<GroupChat['worldState']['conflictState']>['developmentHooks'];
  severity: number;
  stage: string;
}

function resolveConflictSpeakerContext(chat?: GroupChat | null): ConflictSpeakerContext | null {
  const primary = chat?.worldState.conflictState?.primaryConflict || null;
  if (!primary) return null;
  return {
    participantIds: primary.participantIds || [],
    targetIds: primary.targetIds || [],
    nextPressure: primary.nextPressure,
    developmentHooks: primary.developmentHooks || [],
    severity: primary.severity,
    stage: primary.stage,
  };
}

function getConflictSpeakerBias(character: AICharacter, conflict: ConflictSpeakerContext | null, lastSpeakerId?: string) {
  if (!conflict) return 0;
  const isParticipant = conflict.participantIds.includes(character.id);
  const isTarget = conflict.targetIds.includes(character.id);
  const isCentral = isParticipant || isTarget;
  const towardLastSpeaker = lastSpeakerId ? getRelationshipWeight(character, lastSpeakerId) : 0;
  const safeTowardLastSpeaker = Number.isFinite(towardLastSpeaker) ? towardLastSpeaker : 0;
  let bias = isCentral ? 0.24 + conflict.severity * 0.34 : conflict.severity * 0.08;

  if (conflict.nextPressure === 'escalate') bias += isCentral ? 0.18 : 0.04;
  if (conflict.nextPressure === 'spread') bias += isParticipant ? 0.14 : 0.1;
  if (conflict.nextPressure === 'stabilize') bias += isTarget ? 0.12 : 0.02;
  if (conflict.nextPressure === 'divert') bias += isCentral ? 0.05 : 0.12;
  if (conflict.nextPressure === 'cool') bias -= isCentral ? 0.06 : 0.01;

  if (conflict.developmentHooks.includes('invite_target_response') && isTarget) bias += 0.26;
  if (conflict.developmentHooks.includes('force_side_taking') && !isCentral) bias += 0.2;
  if (conflict.developmentHooks.includes('expose_contradiction') && isParticipant) bias += 0.18;
  if (conflict.developmentHooks.includes('raise_stakes') && isCentral) bias += 0.16;
  if (conflict.developmentHooks.includes('shift_public_private') && isCentral) bias += 0.08;
  if (conflict.developmentHooks.includes('cool_down_with_residue') && isCentral) bias -= 0.04;
  if (conflict.developmentHooks.includes('redirect_topic') && !isCentral) bias += 0.12;
  if (conflict.developmentHooks.includes('trigger_memory_recall') && Math.abs(safeTowardLastSpeaker) > 0.15) bias += 0.08;

  if (conflict.stage === 'escalating') bias += isCentral ? 0.1 : 0.03;
  if (conflict.stage === 'open') bias += isCentral ? 0.06 : 0.02;
  if (conflict.stage === 'cooling') bias -= isCentral ? 0.03 : 0;

  return bias;
}

function getConflictDirectReplyBonus(character: AICharacter, conflict: ConflictSpeakerContext | null, lastSpeakerId?: string) {
  if (!conflict || !lastSpeakerId) return 0;
  const lastSpeakerInConflict = conflict.participantIds.includes(lastSpeakerId) || conflict.targetIds.includes(lastSpeakerId);
  if (!lastSpeakerInConflict) return 0;
  const relationWeight = getRelationshipWeight(character, lastSpeakerId);
  const safeRelationWeight = Number.isFinite(relationWeight) ? relationWeight : 0;
  const isCentral = conflict.participantIds.includes(character.id) || conflict.targetIds.includes(character.id);
  if (isCentral && safeRelationWeight < 0) return 0.16 + conflict.severity * 0.1;
  if (conflict.developmentHooks.includes('force_side_taking') && !isCentral) return 0.12;
  return 0;
}

function countUnmetTurns(recentAiMessages: Message[], primaryTargetId: string, sourceMessageId?: string | null) {
  const sourceIndex = recentAiMessages.findIndex((message) => message.id === sourceMessageId);
  const tail = sourceIndex >= 0 ? recentAiMessages.slice(sourceIndex + 1) : recentAiMessages.slice(-3);
  let turns = 0;
  for (const message of tail) {
    if (message.senderId === primaryTargetId) break;
    turns += 1;
  }
  return turns;
}

function getReplyWorthyInteractionTargetIds(message: Message, characters: AICharacter[]) {
  const hints = [
    ...(message.interactionHint ? [message.interactionHint] : []),
    ...(message.interactionHints || []),
  ];
  return hints
    .filter((hint) => isReplyWorthyInteractionKind(hint.kind))
    .map((hint) => hint.targetId)
    .filter((targetId, index, array): targetId is string => Boolean(targetId) && array.indexOf(targetId) === index)
    .filter((targetId) => targetId !== message.senderId && characters.some((character) => character.id === targetId));
}

function buildSchedulerTopicText(recentMessages: Message[], directorIntent?: DirectorIntent | null) {
  const guidanceFocus = directorIntent?.source === 'user_message' ? directorIntent.userGuidance?.focusText?.trim() : '';
  if (guidanceFocus) {
    if (directorIntent?.userGuidance?.kind === 'topic_shift') return guidanceFocus;
    const recentTail = recentMessages.slice(-2).map((message) => message.content).join(' ');
    return [guidanceFocus, guidanceFocus, recentTail].filter(Boolean).join(' ');
  }
  return recentMessages.slice(-5).map((message) => message.content).join(' ');
}

function getForcedUserGuidanceActorIds(directorIntent?: DirectorIntent | null) {
  if (directorIntent?.source !== 'user_message') return [];
  const guidance = directorIntent.userGuidance;
  if (guidance) {
    if (guidance.kind === 'direct_reply') return directorIntent.targetActorIds;
    if (guidance.kind === 'media_request') return directorIntent.targetActorIds;
    return [];
  }
  return directorIntent.beatType === 'answer' ? directorIntent.targetActorIds : [];
}

export function resolvePendingReplyContext(characters: AICharacter[], recentMessages: Message[], chat?: GroupChat): PendingReplyContext | null {
  const recentAiMessages = recentMessages.filter((message) => message.type === 'ai' && !message.isDeleted);
  if (!recentAiMessages.length) return null;

  // Reply debt belongs to the addressed turn, not to whichever message happens
  // to be last. Scan backwards so an interruption does not erase an earlier
  // direct address; speaking once after the address settles that actor's debt.
  const recentWindow = recentAiMessages.slice(-12);
  const pending: Array<{
    sourceMessage: Message;
    targetIds: string[];
    explicitTargetIds: string[];
    unmetTurns: number;
  }> = [];
  for (let sourceIndex = recentWindow.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    const candidate = recentWindow[sourceIndex] as Message & { addressedTargetIds?: string[] | null; primaryAddressedTargetId?: string | null };
    const explicit = (candidate.primaryAddressedTargetId ? [candidate.primaryAddressedTargetId] : [])
      .concat(candidate.addressedTargetIds || []);
    const possibleTargets = explicit
      .concat(getReplyWorthyInteractionTargetIds(candidate, characters))
      .filter((targetId, index, array): targetId is string => Boolean(targetId) && array.indexOf(targetId) === index)
      .filter((targetId) => targetId !== candidate.senderId && characters.some((character) => (
        character.id === targetId && !character.deletedAt && (!chat || !isChatMemberMuted(chat, targetId))
        && isCharacterAvailableForScheduling(character)
        && !((character.presence?.lastAwayAt
          ?? (character.presence?.unavailableUntil ? character.presence.updatedAt : 0)) > candidate.timestamp)
      )));
    const unresolvedTargets = possibleTargets.filter((targetId) => (
      !recentWindow.slice(sourceIndex + 1).some((message) => message.senderId === targetId)
    ));
    if (!unresolvedTargets.length) continue;
    const segment = candidate.metadata?.turnSegment;
    const turnEnd = segment && segment.count > 1
      ? recentWindow.slice(sourceIndex, sourceIndex + segment.count)
        .find((message) => message.senderId === candidate.senderId
          && message.metadata?.turnSegment?.count === segment.count
          && message.metadata.turnSegment.index === segment.count - 1)
      : null;
    const sourceMessage = turnEnd || candidate;
    pending.push({
      sourceMessage,
      targetIds: unresolvedTargets,
      explicitTargetIds: explicit.filter((targetId) => unresolvedTargets.includes(targetId)),
      unmetTurns: countUnmetTurns(recentAiMessages, unresolvedTargets[0], sourceMessage.id),
    });
  }
  // A newer exchange may take one turn, but cannot indefinitely displace an
  // explicit request already waiting through two other speakers' turns.
  const selected = pending.filter((item) => item.explicitTargetIds.length && item.unmetTurns >= 2).at(-1)
    || pending[0];
  if (!selected) return null;
  const { sourceMessage, targetIds, explicitTargetIds } = selected;

  const primaryTargetId = explicitTargetIds.find((targetId) => targetIds.includes(targetId)) || targetIds[0] || null;
  if (!primaryTargetId) return null;

  const repeatedAddressingCount = recentAiMessages
    .slice(-3)
    .filter((message) => {
      const candidate = message as Message & { addressedTargetIds?: string[] | null; primaryAddressedTargetId?: string | null };
      const candidateTargets = (candidate.primaryAddressedTargetId ? [candidate.primaryAddressedTargetId] : [])
        .concat(candidate.addressedTargetIds || [])
        .concat(getReplyWorthyInteractionTargetIds(message, characters));
      return message.senderId === sourceMessage!.senderId && candidateTargets.includes(primaryTargetId);
    })
    .length;

  const unmetTurns = countUnmetTurns(recentAiMessages, primaryTargetId, sourceMessage.id);

  return {
    targetIds,
    primaryTargetId,
    sourceSpeakerId: sourceMessage.senderId,
    sourceMessageId: sourceMessage.id,
    unmetTurns,
    strength: explicitTargetIds.includes(primaryTargetId) || repeatedAddressingCount >= 2 || unmetTurns >= 2 ? 'strong' : 'soft',
  };
}

export function calculateWeights(
  characters: AICharacter[],
  recentMessages: Message[],
  cooldownMap: Record<string, number>,
  speed: number,
  baseCooldownMs: number,
  pendingReplyContext?: PendingReplyContext | null,
  chat?: GroupChat | null,
  directorIntent?: DirectorIntent | null
): WeightedCandidate[] {
  const now = Date.now();
  const speakableCharacters = characters.filter((char) => (
    !char.deletedAt
    && (!chat || !isChatMemberMuted(chat, char.id))
    && isCharacterAvailableForScheduling(char, now)
  ));
  const recentAiMessages = recentMessages.filter((m) => m.type === 'ai' && !m.isDeleted);
  const lastSpeakerId = recentAiMessages.at(-1)?.senderId;
  const conflictContext = resolveConflictSpeakerContext(chat);
  const recentSpeakerIds = recentAiMessages.slice(-6).map((m) => m.senderId);
  const recentSpeakCounts = recentSpeakerIds.reduce<Record<string, number>>((acc, speakerId) => {
    acc[speakerId] = (acc[speakerId] || 0) + 1;
    return acc;
  }, {});
  const latestHumanIndex = (() => {
    for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
      const message = recentMessages[index];
      if (!message.isDeleted && (message.type === 'user' || message.type === 'god') && message.content.trim()) return index;
    }
    return -1;
  })();
  const postUserAiMessages = latestHumanIndex >= 0
    ? recentMessages.slice(latestHumanIndex + 1).filter((message) => message.type === 'ai' && !message.isDeleted)
    : [];
  const postUserSpeakCounts = postUserAiMessages.slice(-6).reduce<Record<string, number>>((acc, message) => {
    acc[message.senderId] = (acc[message.senderId] || 0) + 1;
    return acc;
  }, {});
  const hasFreshPostUserCandidate = recentMessages.length > 0
    && recentMessages.some((message) => message.type === 'ai' && !message.isDeleted && (postUserSpeakCounts[message.senderId] || 0) === 0);
  const consecutiveByLastSpeaker = (() => {
    if (!lastSpeakerId) return 0;
    let count = 0;
    for (let i = recentAiMessages.length - 1; i >= 0; i -= 1) {
      if (recentAiMessages[i].senderId !== lastSpeakerId) break;
      count += 1;
    }
    return count;
  })();
  const pendingTwoActorLoop = hasTwoActorExchangeLoop(
    recentAiMessages,
    pendingReplyContext?.sourceSpeakerId,
    pendingReplyContext?.primaryTargetId,
  );
  const twoActorDominance = hasTwoActorDominance(recentAiMessages);

  const cooldownDuration = baseCooldownMs / speed;
  const recentText = buildSchedulerTopicText(recentMessages, directorIntent);
  const keywords = extractKeywords(recentText);
  const forcedUserGuidanceActorIds = getForcedUserGuidanceActorIds(directorIntent);
  const suppressedUserGuidanceActorIds = directorIntent?.source === 'user_message'
    ? (directorIntent.userGuidance?.suppressedActorIds || [])
    : [];
  const deferredUserGuidanceActorIds = directorIntent?.source === 'user_message'
    ? (directorIntent.userGuidance?.deferredActorIds || [])
    : [];
  const shouldKeepLastSpeaker = (characterId: string) => {
    if (characterId !== lastSpeakerId) return true;
    if (!lastSpeakerId) return true;
    if (forcedUserGuidanceActorIds.includes(characterId)) return true;
    if (directorIntent?.source === 'user_message' && directorIntent.targetActorIds.includes(characterId)) return true;
    if (pendingReplyContext?.targetIds.includes(characterId)) return true;
    return false;
  };
  const rotationCandidates = speakableCharacters.filter((character) => shouldKeepLastSpeaker(character.id));
  const baseCandidatePool = rotationCandidates.length ? rotationCandidates : speakableCharacters;
  const unsuppressedCandidatePool = !forcedUserGuidanceActorIds.length && suppressedUserGuidanceActorIds.length
    ? baseCandidatePool.filter((character) => !suppressedUserGuidanceActorIds.includes(character.id))
    : baseCandidatePool;
  const undeferredCandidatePool = !forcedUserGuidanceActorIds.length && deferredUserGuidanceActorIds.length
    ? unsuppressedCandidatePool.filter((character) => !deferredUserGuidanceActorIds.includes(character.id))
    : unsuppressedCandidatePool;
  const candidatePool = undeferredCandidatePool.length ? undeferredCandidatePool : unsuppressedCandidatePool.length ? unsuppressedCandidatePool : baseCandidatePool;
  const attentionStateBiasByActor = new Map<string, number>();
  if (chat) {
    projectWorldAttentionStates([chat], speakableCharacters, { now })
      .filter((state) => state.targetId === 'user')
      .forEach((state) => {
        const rawBias = (state.attentionScore - state.restraint) * 0.32;
        const bias = clamp(rawBias, 0, 0.26);
        if (bias <= 0) return;
        const existing = attentionStateBiasByActor.get(state.actorId) || 0;
        attentionStateBiasByActor.set(state.actorId, Math.max(existing, bias));
      });
  }

  const weightedCandidates = candidatePool
    .filter((char) => {
      if (forcedUserGuidanceActorIds.length && !forcedUserGuidanceActorIds.includes(char.id)) return false;
      if (forcedUserGuidanceActorIds.includes(char.id)) return true;
      const lastSpeak = cooldownMap[char.id];
      if (!lastSpeak) return true;
      return now - lastSpeak >= cooldownDuration;
    })
    .map((char) => {
      const runtimeBehavior = applyDriftToBehavior(char);
      const wasLastSpeaker = char.id === lastSpeakerId;
      const extroversionWeight = (char.personality.extroversion / 100) * 0.32;
      const proactivityWeight = (runtimeBehavior.proactivity / 100) * 0.22;
      const personalityDrive = extroversionWeight + proactivityWeight + 0.25;
      let weight = personalityDrive;
      const relevance = calculateTopicRelevance(keywords, char.expertise);
      const emotionalMomentum = getEmotionalMomentum(char);
      const emotionalReason = getEmotionalSpeakerReason(char);
      weight += relevance * 0.2;
      weight += emotionalMomentum;
      const recentCount = recentSpeakCounts[char.id] || 0;
      const pendingReplyBoost = pendingReplyContext?.targetIds.includes(char.id)
        ? (char.id === pendingReplyContext.primaryTargetId
            ? ((pendingReplyContext.strength === 'strong' ? 0.85 : 0.45) + Math.min(0.45, pendingReplyContext.unmetTurns * 0.12)) * (pendingTwoActorLoop ? 0.62 : 1)
            : 0.18)
	        : 0;
      const unspokenMemberBias = chat?.type === 'group'
        && speakableCharacters.length >= 3
        && recentCount === 0
        && recentAiMessages.length >= Math.min(2, speakableCharacters.length - 1)
        && !forcedUserGuidanceActorIds.length
        && (pendingTwoActorLoop || twoActorDominance)
        ? (pendingReplyContext?.primaryTargetId ? ((pendingTwoActorLoop || twoActorDominance) ? 0.38 : 0.08) : 0.22)
        : 0;
      const conflictBias = getConflictSpeakerBias(char, conflictContext, lastSpeakerId);
      const directorBias = getDirectorIntentSpeakerBias({ character: char, directorIntent, chat, lastSpeakerId });
      const directorAddressBoost = directorIntent?.source === 'user_message'
        && directorIntent.targetActorIds.includes(char.id)
        ? 0.86
        : 0;
      const guidanceFloorGuardianBias = directorIntent?.source === 'user_message'
        && !forcedUserGuidanceActorIds.length
        && Boolean(directorIntent.userGuidance?.actorIds.length)
        && Boolean(suppressedUserGuidanceActorIds.length || deferredUserGuidanceActorIds.length)
        && !directorIntent.userGuidance?.actorIds.includes(char.id)
        && !suppressedUserGuidanceActorIds.includes(char.id)
        && !deferredUserGuidanceActorIds.includes(char.id)
        ? 0.32
        : 0;
      const innerLife = projectInnerLife({
        chat,
        character: char,
        messages: recentMessages,
        now,
        explicitUserAddressed: directorIntent?.source === 'user_message'
          && directorIntent.targetActorIds.includes(char.id),
      });
      const innerLifeBias = getInnerLifeSpeakerBias(innerLife);
      const directedAffectBias = innerLife.activeAffect?.role === 'received'
        ? innerLife.activeAffect.pressure * 0.48 : 0;
      const directedAffectPressure = innerLife.activeAffect?.pressure || 0;
      const characterTurnDrive = deriveCharacterTurnDrive({ speaker: char, messages: recentMessages, innerLife });
      const characterDriveBias = getCharacterTurnDriveSpeakerBias(characterTurnDrive);
      const attentionStateBias = attentionStateBiasByActor.get(char.id) || 0;
      const debugBase = {
        characterId: char.id,
        characterName: char.name,
        personality: char.personality,
        behavior: char.behavior,
        runtimeBehavior,
        expertise: char.expertise,
        extroversionWeight,
        proactivityWeight,
        relevance,
        emotionalMomentum,
        recentCount,
      };
      if (Number.isNaN(weight)) {
        console.error('[group-loop:nan-weight:base]', debugBase);
      }

      weight -= recentCount * 0.5;
      if (recentCount === 0) weight += 0.06;
      weight += unspokenMemberBias;
      if (recentCount >= 2) weight -= 0.18;
      const postUserSpeakCount = postUserSpeakCounts[char.id] || 0;
      const userPresenceRotationPenalty = chat?.type === 'group'
        && directorIntent?.source === 'user_message'
        && postUserAiMessages.length >= 1
        && postUserSpeakCount > 0
        && !forcedUserGuidanceActorIds.includes(char.id)
        ? Math.min(0.42, 0.18 + postUserSpeakCount * 0.12 + (hasFreshPostUserCandidate ? 0.22 : 0))
        : 0;
      weight -= userPresenceRotationPenalty;
      weight += pendingReplyBoost;
      weight += conflictBias;
      weight += directorBias.bias;
      weight += guidanceFloorGuardianBias;
      weight += innerLifeBias.bias;
      weight += directedAffectBias;
      weight += characterDriveBias;
      if (!(directorIntent?.source === 'user_message' && directorIntent.targetActorIds.length)) {
        weight += attentionStateBias;
      }
      let relationshipPressure = 0;
      let directCueBoost = 0;
      let contentLengthAdjustment = 0;
      const lastAiMessage = recentAiMessages.at(-1);
      if (lastAiMessage && lastAiMessage.senderId !== char.id) {
        const relationWeight = getRelationshipWeight(char, lastAiMessage.senderId);
        const safeRelationWeight = Number.isFinite(relationWeight) ? relationWeight : 0;
        const emotionalReplyBias = getEmotionalReplyBias(char, lastAiMessage.senderId);
        weight += emotionalReplyBias;
        relationshipPressure += emotionalReplyBias;
        const repliedRecentlyToSameSpeaker = recentAiMessages.slice(-4, -1).some((message) => message.senderId === char.id) && recentAiMessages.slice(-4, -1).some((message) => message.senderId === lastAiMessage.senderId);
        if (repliedRecentlyToSameSpeaker) weight += 0.04;
        const dramaBoost = Boolean((globalThis as { __PNEUMATA_DRAMA_BOOST__?: boolean }).__PNEUMATA_DRAMA_BOOST__);
        if (Math.abs(safeRelationWeight) >= (dramaBoost ? 0.12 : 0.2)) {
          const relationDramaBoost = safeRelationWeight > 0 ? 0.12 : (dramaBoost ? 0.24 : 0.16);
          weight += relationDramaBoost;
          relationshipPressure += relationDramaBoost;
        }
        const addressedMessage = lastAiMessage as Message & { addressedTargetIds?: string[] | null; primaryAddressedTargetId?: string | null };
        const explicitTargets = [
          addressedMessage.primaryAddressedTargetId,
          ...(addressedMessage.addressedTargetIds || []),
          ...getReplyWorthyInteractionTargetIds(lastAiMessage, characters),
        ].filter((targetId, index, array): targetId is string => Boolean(targetId) && array.indexOf(targetId) === index);
        const directCue = explicitTargets.includes(char.id);
        if (directCue) {
          directCueBoost = 0.62;
          weight += directCueBoost;
        }
        const conflictReplyBonus = getConflictDirectReplyBonus(char, conflictContext, lastAiMessage.senderId);
        weight += conflictReplyBonus;
        if (lastAiMessage.content.length <= 18) {
          contentLengthAdjustment = 0.06;
          weight += contentLengthAdjustment;
        }
        if (lastAiMessage.content.length >= 90) {
          contentLengthAdjustment = -0.12;
          weight += contentLengthAdjustment;
        }
        if (Number.isNaN(weight)) {
          console.error('[group-loop:nan-weight:reply]', {
            ...debugBase,
            emotionalReplyBias,
            relationWeight: safeRelationWeight,
            lastAiMessage: {
              senderId: lastAiMessage.senderId,
              senderName: lastAiMessage.senderName,
              timestamp: lastAiMessage.timestamp,
              content: lastAiMessage.content,
            },
            repliedRecentlyToSameSpeaker,
            dramaBoost,
            directCue,
          });
        }
      }
      if (runtimeBehavior.proactivity >= 65 && recentAiMessages.length > 0) {
        const latestContentLength = recentAiMessages[recentAiMessages.length - 1]?.content.length || 0;
        if (latestContentLength > 60) weight += 0.05;
      }
      let repetitionMultiplier = 1;
      if (wasLastSpeaker) {
        repetitionMultiplier *= consecutiveByLastSpeaker >= 3 ? 0.005 : consecutiveByLastSpeaker >= 2 ? 0.025 : 0.1;
      }
      if (hasRecentSpeakerStreak(recentMessages, char.id)) {
        repetitionMultiplier *= 0.08;
      }
      if (hasRecentSameTargetLoop(recentMessages, char.id, lastSpeakerId || undefined)) {
        repetitionMultiplier *= 0.35;
      }
      weight *= repetitionMultiplier;
      weight += Math.random() * 0.03;

      const hasExternalPressure = Boolean(
        forcedUserGuidanceActorIds.includes(char.id)
        || pendingReplyBoost
        || conflictBias
        || directorBias.bias
        || guidanceFloorGuardianBias
        || attentionStateBias
        || relationshipPressure
        || directCueBoost
        || characterDriveBias > 0
      );
      const idleStaySilent = innerLife.impulse === 'stay_silent' && innerLife.pressure < 0.32 && !hasExternalPressure;

      if (Number.isNaN(weight)) {
        console.error('[group-loop:nan-weight:final]', {
          ...debugBase,
          finalWeight: weight,
          pendingReplyContext,
          lastSpeakerId,
          consecutiveByLastSpeaker,
          cooldownLastSpeak: cooldownMap[char.id] || null,
        });
      }
      const finalScore = Math.max(0.05, weight);
      return [{
        characterId: char.id,
        weight: finalScore,
        idleStaySilent,
        scoreBreakdown: buildSpeakerScoreBreakdown({
          actorId: char.id,
          addressed: Math.max(pendingReplyBoost, directCueBoost, directorAddressBoost),
          topicRelevance: relevance * 0.2 + contentLengthAdjustment + (directorAddressBoost ? 0.24 : 0),
          lineInvolvement: conflictBias + directorBias.bias,
          emotionalPressure: clamp(emotionalMomentum + directedAffectPressure, -0.18, 1),
          innerLifePressure: innerLifeBias.bias,
          relationshipPressure,
          factionPressure: directorIntent?.source === 'faction' ? directorBias.bias : 0,
          personalityDrive,
          novelty: recentCount === 0 ? 0.06 : 0,
          silencePressure: (recentCount === 0 ? 0.06 : 0) + unspokenMemberBias,
          repetitionPenalty: repetitionMultiplier < 1 ? weight * (1 - repetitionMultiplier) : 0,
          cooldownPenalty: userPresenceRotationPenalty,
          finalScore,
          reasons: [
            pendingReplyBoost ? 'pending_reply' : '',
            directorAddressBoost ? 'direct_user_address' : '',
            directCueBoost ? 'direct_message_address' : '',
            unspokenMemberBias ? 'unspoken_member' : '',
            emotionalReason,
            directedAffectPressure >= 0.28 ? 'emotion:directed_affect' : '',
            conflictBias ? 'conflict' : '',
            ...directorBias.reasons,
            guidanceFloorGuardianBias ? 'guidance_floor_guardian' : '',
            innerLifeBias.bias ? innerLifeBias.reason : '',
            characterDriveBias ? `character_drive:${characterTurnDrive.speakingNecessity}` : '',
            attentionStateBias ? 'attention_state' : '',
            relationshipPressure ? 'relationship' : '',
            userPresenceRotationPenalty ? 'user_presence_rotation' : '',
            repetitionMultiplier < 1 ? 'repetition_penalty' : '',
          ].filter(Boolean),
        }),
      }];
    });
  const flattenedCandidates = weightedCandidates.flat();
  const activeCandidates = flattenedCandidates.filter((candidate) => !candidate.idleStaySilent);
  const baseSelectedCandidates = activeCandidates.length ? activeCandidates : flattenedCandidates;
  return baseSelectedCandidates.map((candidate) => ({
    characterId: candidate.characterId,
    weight: candidate.weight,
    prefersSilence: candidate.idleStaySilent,
    scoreBreakdown: candidate.scoreBreakdown,
  }));
}

export function selectSpeaker(candidates: WeightedCandidate[]): string | null {
  if (candidates.length === 0) return null;

  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let random = Math.random() * totalWeight;

  for (const candidate of candidates) {
    random -= candidate.weight;
    if (random <= 0) {
      return candidate.characterId;
    }
  }

  return candidates[candidates.length - 1].characterId;
}

export function getSpeakerSelectionResult(
  characters: AICharacter[],
  cooldownMap: Record<string, number>,
  speed: number,
  baseCooldownMs: number,
  candidates: WeightedCandidate[]
) {
  const picked = selectSpeaker(candidates);
  if (picked) {
    const selected = candidates.find((candidate) => candidate.characterId === picked);
    const reasons = selected?.scoreBreakdown?.reasons || [];
    return { speakerId: picked, reason: reasons.length ? reasons.join(', ') : 'weighted_scheduler', bypassNotice: null };
  }

  const now = Date.now();
  const unavailable = characters
    .map((char) => ({ character: char, presence: getEffectiveCharacterPresence(char, now) }))
    .filter((item) => item.presence.status === 'away');
  if (unavailable.length === characters.length && unavailable.length > 0) {
    const detail = unavailable.slice(0, 3).map((item) => {
      const remainingMs = Math.max(0, (item.presence.unavailableUntil || now) - now);
      const remainingText = remainingMs > 0 ? `${Math.max(1, Math.ceil(remainingMs / 60000))}分钟` : '暂离';
      return `${item.character.name}：${item.presence.activity || '暂离'} ${remainingText}`.trim();
    }).join(' / ');
    return { speakerId: null, reason: `当前所有角色暂时不在线：${detail}`, bypassNotice: null };
  }
  const cooldownDuration = baseCooldownMs / speed;
  const blocked = characters
    .map((char) => ({
      name: char.name,
      remainingMs: Math.max(0, cooldownDuration - (now - (cooldownMap[char.id] || 0))),
    }))
    .filter((item) => item.remainingMs > 0)
    .sort((a, b) => a.remainingMs - b.remainingMs);

  if (!blocked.length) return { speakerId: null, reason: '当前没有可发言角色', bypassNotice: null };
  const detail = blocked.slice(0, 3).map((item) => `${item.name}：${Math.max(1, Math.ceil(item.remainingMs / 1000))}秒`).join(' / ');
  return { speakerId: null, reason: `当前所有角色都在冷却：${detail}`, bypassNotice: null };
}
