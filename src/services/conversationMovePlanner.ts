import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { getRelationshipWeight } from './relationshipEngine';
import { resolveSessionFamilyKey } from './sessionEngineKeys';
import type { SpeakerScoreBreakdown } from './speakerScoring';
import type { PendingReplyContext } from './scheduler';

export type ConversationMoveType =
  | 'react_lightly'
  | 'add_personal_angle'
  | 'ask_followup'
  | 'challenge_playfully'
  | 'add_boundary_condition'
  | 'bring_back_prior_point'
  | 'answer_unresolved_question'
  | 'synthesize'
  | 'shift_topic_softly'
  | 'test_assumption'
  | 'counterexample'
  | 'separate_claims'
  | 'ask_evidence'
  | 'name_tradeoff';

export interface ConversationMovePlan {
  speakerId: string;
  targetMessageId?: string;
  targetActorId?: string;
  targetClaimText?: string;
  moveType: ConversationMoveType;
  socialPosture: {
    warmth: 'warm' | 'neutral' | 'cold';
    directness: 'soft' | 'plain' | 'sharp';
  };
  reason: string;
  confidence: number;
}

function visibleMessages(messages: Message[]) {
  return messages.filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event');
}

function recentAiMessages(messages: Message[]) {
  return visibleMessages(messages).filter((message) => message.type === 'ai');
}

function isAnalysisRoom(chat: GroupChat) {
  return resolveSessionFamilyKey(chat) === 'analysis';
}

function normalizeTopicPhrase(text: string) {
  const quoted = text.match(/[“"]([^”"]{2,16})[”"]/);
  if (quoted?.[1]) return quoted[1];
  const compact = text
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ')
    .split(/\s+/)
    .filter((item) => item.length >= 2 && item.length <= 12)
    .slice(-8);
  return compact.at(-1) || '';
}

function findPriorDroppedPoint(messages: Message[], latestId?: string) {
  const recent = visibleMessages(messages).slice(-10, -2);
  const candidates = recent
    .filter((message) => message.id !== latestId && message.content.length >= 36)
    .filter((message) => Boolean(
      message.metadata?.turnParameters?.plan?.target
      || message.metadata?.deliberationArtifacts?.issues?.length,
    ));
  return candidates.at(-1) || null;
}

function repeatedPhraseCount(messages: Message[]) {
  const phrases = recentAiMessages(messages).slice(-5).map((message) => normalizeTopicPhrase(message.content)).filter(Boolean);
  const counts = phrases.reduce((map, phrase) => {
    map.set(phrase, (map.get(phrase) || 0) + 1);
    return map;
  }, new Map<string, number>());
  return Math.max(0, ...Array.from(counts.values()));
}

function countItems<T>(items: T[] | undefined) {
  return Array.isArray(items) ? items.length : 0;
}

function summarizeRecentDeliberationArtifacts(messages: Message[]) {
  const recent = recentAiMessages(messages).slice(-5);
  let claims = 0;
  let evidence = 0;
  let issues = 0;
  let verdicts = 0;
  let summaries = 0;
  let artifactTurns = 0;
  let latestClaimWithoutScrutiny: Message | null = null;

  recent.forEach((message) => {
    const artifacts = message.metadata?.deliberationArtifacts;
    if (!artifacts) return;
    const messageClaims = countItems(artifacts.claims);
    const messageEvidence = countItems(artifacts.evidence);
    const messageIssues = countItems(artifacts.issues);
    const messageVerdicts = countItems(artifacts.verdicts);
    const hasSummary = artifacts.summary?.text ? 1 : 0;
    const total = messageClaims + messageEvidence + messageIssues + messageVerdicts + hasSummary;
    if (!total) return;
    artifactTurns += 1;
    claims += messageClaims;
    evidence += messageEvidence;
    issues += messageIssues;
    verdicts += messageVerdicts;
    summaries += hasSummary;
    if (messageClaims + messageVerdicts + hasSummary > 0 && messageEvidence + messageIssues === 0) {
      latestClaimWithoutScrutiny = message;
    }
  });

  return {
    recentAiTurns: recent.length,
    artifactTurns,
    claims,
    evidence,
    issues,
    verdicts,
    summaries,
    durableCount: claims + verdicts + summaries,
    scrutinyCount: evidence + issues,
    latestClaimWithoutScrutiny,
  };
}

function chooseSocialPosture(speaker: AICharacter, targetActorId?: string) {
  const relationWeight = targetActorId ? getRelationshipWeight(speaker, targetActorId) : 0;
  const warmth = relationWeight > 0.25 || (speaker.emotionalState?.affection || 0) >= 35
    ? 'warm'
    : relationWeight < -0.25 || (speaker.emotionalState?.irritation || 0) >= 45
      ? 'cold'
      : 'neutral';
  const directness = relationWeight < -0.28 || (speaker.behavior?.aggressiveness || 0) >= 70
    ? 'sharp'
    : warmth === 'warm' || (speaker.behavior?.empathyLevel || 0) >= 65
      ? 'soft'
      : 'plain';
  return { warmth, directness } as const;
}

function chooseDefaultMove(chat: GroupChat, speaker: AICharacter, latest: Message | null): ConversationMoveType {
  if (isAnalysisRoom(chat)) {
    if ((speaker.behavior?.summarizing || 0) >= 72) return 'separate_claims';
    if ((speaker.behavior?.aggressiveness || 0) >= 62) return 'test_assumption';
    if ((speaker.behavior?.proactivity || 0) >= 62) return 'name_tradeoff';
    return latest?.type === 'user' ? 'ask_followup' : 'add_boundary_condition';
  }
  if ((speaker.behavior?.humorIntensity || 0) >= 68) return 'challenge_playfully';
  if ((speaker.behavior?.proactivity || 0) >= 68 && latest?.type === 'user') return 'ask_followup';
  return latest?.type === 'user' ? 'add_personal_angle' : 'react_lightly';
}

function stableBucket(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % 100;
}

/**
 * A casual group turn is not automatically a reply to the immediately
 * preceding speaker. Pick an older live thread on some turns so the room can
 * braid voices instead of producing a chain of acknowledgement echoes.
 * Explicit/pending turns are resolved before this helper is consulted.
 */
function chooseAmbientThread(messages: Message[], speaker: AICharacter) {
  const visible = visibleMessages(messages);
  const recentAi = visible.filter((message) => message.type === 'ai');
  if (recentAi.length < 5) return null;
  const latest = visible.at(-1);
  if (!latest || latest.type !== 'ai') return null;
  const candidates = recentAi
    .slice(0, -1)
    .filter((message) => message.senderId !== speaker.id)
    .slice(-5);
  if (!candidates.length) return null;
  // Keep the choice irregular but reproducible for the same transcript.
  if (stableBucket(`${speaker.id}|${latest.id}|${recentAi.length}`) >= 38) return null;
  const index = stableBucket(`${latest.id}|${speaker.id}|thread`) % candidates.length;
  return candidates[index] || null;
}

export function planConversationMove(params: {
  chat: GroupChat;
  speaker: AICharacter;
  messages: Message[];
  speakerScore?: SpeakerScoreBreakdown | null;
  pendingReplyContext?: PendingReplyContext | null;
}): ConversationMovePlan {
  const messages = visibleMessages(params.messages);
  const latest = messages.at(-1) || null;
  const analysis = isAnalysisRoom(params.chat);
  const repeatedCount = analysis ? 0 : repeatedPhraseCount(messages);
  const priorDroppedPoint = analysis ? null : findPriorDroppedPoint(messages, latest?.id);
  const deliberationArtifacts = analysis ? summarizeRecentDeliberationArtifacts(messages) : null;

  const pendingReply = params.pendingReplyContext?.targetIds.includes(params.speaker.id)
    ? messages.find((message) => message.id === params.pendingReplyContext?.sourceMessageId)
    : null;
  if (pendingReply) {
    return {
      speakerId: params.speaker.id,
      targetMessageId: pendingReply.id,
      targetActorId: pendingReply.senderId,
      targetClaimText: pendingReply.content.slice(0, 120),
      moveType: 'answer_unresolved_question',
      socialPosture: chooseSocialPosture(params.speaker, pendingReply.senderId),
      reason: 'pending_direct_address',
      confidence: params.pendingReplyContext?.strength === 'strong' ? 0.96 : 0.82,
    };
  }

  if (analysis && deliberationArtifacts && deliberationArtifacts.artifactTurns === 0) {
    const target = latest || undefined;
    if (deliberationArtifacts.recentAiTurns >= 3 && target) {
      return {
        speakerId: params.speaker.id,
        targetMessageId: target.id,
        targetActorId: target.senderId,
        targetClaimText: target.content.slice(0, 120),
        moveType: 'ask_evidence',
        socialPosture: chooseSocialPosture(params.speaker, target.senderId),
        reason: 'bootstrap_missing_artifacts_needs_scrutiny',
        confidence: 0.78,
      };
    }
    return {
      speakerId: params.speaker.id,
      targetMessageId: target?.id,
      targetActorId: target?.senderId,
      targetClaimText: target?.content.slice(0, 120),
      moveType: target ? 'separate_claims' : 'name_tradeoff',
      socialPosture: chooseSocialPosture(params.speaker, target?.senderId),
      reason: target ? 'bootstrap_without_artifacts' : 'bootstrap_empty_deliberation',
      confidence: 0.76,
    };
  }

  if (analysis && deliberationArtifacts && deliberationArtifacts.artifactTurns >= 2) {
    const target = deliberationArtifacts.latestClaimWithoutScrutiny || latest || priorDroppedPoint || undefined;
    if (deliberationArtifacts.durableCount >= 3 && deliberationArtifacts.evidence === 0) {
      return {
        speakerId: params.speaker.id,
        targetMessageId: target?.id,
        targetActorId: target?.senderId,
        targetClaimText: target?.content.slice(0, 120),
        moveType: 'ask_evidence',
        socialPosture: chooseSocialPosture(params.speaker, target?.senderId),
        reason: 'claims_without_evidence',
        confidence: 0.8,
      };
    }
    if (deliberationArtifacts.durableCount >= 4 && deliberationArtifacts.issues === 0) {
      return {
        speakerId: params.speaker.id,
        targetMessageId: target?.id,
        targetActorId: target?.senderId,
        targetClaimText: target?.content.slice(0, 120),
        moveType: deliberationArtifacts.verdicts >= 2 ? 'test_assumption' : 'counterexample',
        socialPosture: chooseSocialPosture(params.speaker, target?.senderId),
        reason: 'consensus_without_questioning',
        confidence: 0.78,
      };
    }
    if (deliberationArtifacts.durableCount >= 4 && deliberationArtifacts.scrutinyCount <= 1) {
      return {
        speakerId: params.speaker.id,
        targetMessageId: target?.id,
        targetActorId: target?.senderId,
        targetClaimText: target?.content.slice(0, 120),
        moveType: 'separate_claims',
        socialPosture: chooseSocialPosture(params.speaker, target?.senderId),
        reason: 'thin_scrutiny_after_consensus',
        confidence: 0.72,
      };
    }
  }

  if (analysis && repeatedCount >= 3) {
    const target = latest || priorDroppedPoint || undefined;
    return {
      speakerId: params.speaker.id,
      targetMessageId: target?.id,
      targetActorId: target?.senderId,
      targetClaimText: target?.content.slice(0, 120),
      moveType: 'add_boundary_condition',
      socialPosture: chooseSocialPosture(params.speaker, target?.senderId),
      reason: 'repeated_topic_phrase',
      confidence: 0.74,
    };
  }

  if (!analysis && repeatedCount >= 3) {
    const target = priorDroppedPoint || latest || undefined;
    return {
      speakerId: params.speaker.id,
      targetMessageId: target?.id,
      targetActorId: target?.senderId,
      targetClaimText: target?.content.slice(0, 120),
      moveType: 'shift_topic_softly',
      socialPosture: chooseSocialPosture(params.speaker, target?.senderId),
      reason: 'repeated_topic_phrase',
      confidence: 0.78,
    };
  }

  if (!analysis && params.chat.type === 'group' && repeatedCount < 2) {
    const ambientThread = chooseAmbientThread(messages, params.speaker);
    if (ambientThread) {
      return {
        speakerId: params.speaker.id,
        targetMessageId: ambientThread.id,
        targetActorId: ambientThread.senderId,
        targetClaimText: ambientThread.content.slice(0, 120),
        moveType: (params.speaker.behavior?.proactivity || 0) >= 58
          ? 'add_personal_angle'
          : 'bring_back_prior_point',
        socialPosture: chooseSocialPosture(params.speaker, ambientThread.senderId),
        reason: 'ambient_thread_braid',
        confidence: 0.61,
      };
    }
  }

  if (priorDroppedPoint && analysis) {
    return {
      speakerId: params.speaker.id,
      targetMessageId: priorDroppedPoint.id,
      targetActorId: priorDroppedPoint.senderId,
      targetClaimText: priorDroppedPoint.content.slice(0, 120),
      moveType: 'bring_back_prior_point',
      socialPosture: chooseSocialPosture(params.speaker, priorDroppedPoint.senderId),
      reason: 'prior_unresolved_thread',
      confidence: 0.64,
    };
  }

  return {
    speakerId: params.speaker.id,
    targetMessageId: latest?.id,
    targetActorId: latest?.senderId,
    targetClaimText: latest?.content.slice(0, 120),
    moveType: chooseDefaultMove(params.chat, params.speaker, latest),
    socialPosture: chooseSocialPosture(params.speaker, latest?.senderId),
    reason: 'default_room_move',
    confidence: 0.55,
  };
}

export function buildConversationMovePrompt(
  plan: ConversationMovePlan | null | undefined,
  chat: GroupChat,
  targetName?: string | null,
) {
  if (!plan) return '';
  const analysis = isAnalysisRoom(chat);
  const moveLabels: Record<ConversationMoveType, string> = {
    react_lightly: 'make a light situated reaction without copying the previous wording',
    add_personal_angle: 'add a situated angle from this person; it may be ordinary life, taste, mood, practical habit, or expertise only if truly relevant',
    ask_followup: 'ask a useful follow-up that opens the next branch',
    challenge_playfully: 'push back lightly or playfully without turning hostile',
    add_boundary_condition: 'add a boundary condition, cost, risk, or limitation to the current claim instead of merely backing it',
    bring_back_prior_point: 'bring back a relevant earlier point instead of only following the latest line',
    answer_unresolved_question: 'consider whether the unresolved question deserves attention now',
    synthesize: 'synthesize without flattening disagreements',
    shift_topic_softly: 'softly shift to a nearby topic',
    test_assumption: 'test an assumption behind the current claim',
    counterexample: 'offer a concrete counterexample',
    separate_claims: 'separate two claims that have been merged together',
    ask_evidence: 'ask what evidence or condition would make the claim hold',
    name_tradeoff: 'name a tradeoff the room has not made explicit',
  };
  const hasHardReplyNeed = plan.reason === 'user_guidance_lock';
  const targetLine = plan.targetClaimText
    ? hasHardReplyNeed
      ? `\n- Reply obligation: address the selected unresolved thread from the transcript. This is a real direct question, handoff, or explicit request; answer it in the character's own way, and do not pad the answer with a second generic acknowledgement.${targetName ? ` The thread is associated with ${targetName}.` : ''}`
      : `\n- Attention cue only: the selected prior thread is available as context, not a required reply. You may pick up one detail, react indirectly, return to an older thread, introduce your own nearby thought, or leave it untouched if the character's attention is elsewhere.${targetName ? ` It is associated with ${targetName}; do not address them by name unless that is a natural social act.` : ''}`
    : '';
  const analysisLine = analysis
    ? '\n- In analysis rooms, warmth is interpersonal tone only. It does not mean viewpoint agreement.'
    : '\n- In casual rooms, keep the move natural and conversational rather than meeting-like. You may ignore part of the previous line, react to the gist, admit a term is outside your lane, or switch to a nearby everyday angle.';
  const echoLoopLine = plan.reason === 'chat_echo_loop'
    ? '\n- The room has already worried the same point enough. Do not manufacture a new condition, risk, counterexample, task, or handoff merely to keep it moving. Let the point land with a brief personal reaction, a change in social temperature, a pause, or a genuinely nearby topic.'
    : '';
  const scrutinyLine = analysis && ['ask_evidence', 'counterexample', 'test_assumption', 'separate_claims'].includes(plan.moveType)
    ? '\n- Do not add another supporting analogy. Give the requested scrutiny: evidence condition, counterexample, assumption test, or claim split.\n- This turn is expected to create deliberationArtifacts from your visible reply; do not use a no-new-point response for this move.'
    : '';
  const priorityLine = analysis
    ? 'This is the primary semantic job for the analysis-room turn.'
    : 'This is a secondary realization option. Follow it only where it serves the character drive, personal stake, and relationship action; do not turn it into generic facilitation.';
  return `\n## Conversation Move Guidance
- ${priorityLine}
- Current semantic job: ${moveLabels[plan.moveType] || plan.moveType}.
- Interpersonal posture: ${plan.socialPosture.warmth} warmth, ${plan.socialPosture.directness} directness.${targetLine}${analysisLine}
- Use this as a local choice of what this turn should do. Do not mention the guidance itself.${echoLoopLine}${scrutinyLine}`;
}
