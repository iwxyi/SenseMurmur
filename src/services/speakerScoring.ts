import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { DirectorIntent } from './directorIntent';
import { getRelationshipWeight } from './relationshipEngine';

export interface SpeakerScoreBreakdown {
  actorId: string;
  addressed: number;
  topicRelevance: number;
  lineInvolvement: number;
  emotionalPressure: number;
  innerLifePressure: number;
  relationshipPressure: number;
  factionPressure: number;
  personalityDrive: number;
  knowledgeAccess: number;
  novelty: number;
  silencePressure: number;
  cooldownPenalty: number;
  repetitionPenalty: number;
  finalScore: number;
  reasons: string[];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hasSharedScenarioFaction(chat: GroupChat | null | undefined, actorId: string, targetIds: string[]) {
  const assignments = chat?.scenarioState?.roleAssignments || [];
  const actorFaction = assignments.find((assignment) => assignment.actorId === actorId)?.factionId;
  if (!actorFaction) return false;
  return targetIds.some((targetId) => assignments.find((assignment) => assignment.actorId === targetId)?.factionId === actorFaction);
}

export function getDirectorIntentSpeakerBias(params: {
  character: AICharacter;
  directorIntent?: DirectorIntent | null;
  chat?: GroupChat | null;
  lastSpeakerId?: string;
}) {
  const intent = params.directorIntent;
  if (!intent) return { bias: 0, reasons: [] as string[] };
  const reasons: string[] = [];
  let bias = 0;
  const isTarget = intent.targetActorIds.includes(params.character.id);
  if (isTarget) {
    const targetBias = intent.beatType === 'answer' ? 0.55 : intent.beatType === 'defend' ? 0.32 : 0.24;
    bias += targetBias * intent.pressure;
    reasons.push(`director:${intent.beatType}:target`);
    if (intent.userGuidance?.actorIds.includes(params.character.id)) {
      bias += (intent.userGuidance.kind === 'media_request' ? 1.15 : 0.58) * intent.pressure;
      reasons.push(intent.userGuidance.kind === 'media_request' ? 'director:media_request:target' : 'director:user_guidance:target');
    }
  }
  if (params.lastSpeakerId && intent.targetActorIds.includes(params.lastSpeakerId)) {
    const relationWeight = getRelationshipWeight(params.character, params.lastSpeakerId);
    const safeRelationWeight = Number.isFinite(relationWeight) ? relationWeight : 0;
    if (intent.beatType === 'defend' && safeRelationWeight > 0) {
      bias += clamp(safeRelationWeight * 0.18, 0, 0.18);
      reasons.push('director:defend:relationship');
    }
    if ((intent.beatType === 'challenge' || intent.beatType === 'escalate') && safeRelationWeight < 0) {
      bias += clamp(Math.abs(safeRelationWeight) * 0.2, 0, 0.22);
      reasons.push(`director:${intent.beatType}:opposition`);
    }
  }

  if (intent.beatType === 'summarize' && params.character.behavior.summarizing >= 65) {
    bias += 0.18 * intent.pressure;
    reasons.push('director:summarizer');
  }
  if (intent.beatType === 'invite' && params.character.behavior.proactivity >= 65) {
    bias += 0.12 * intent.pressure;
    reasons.push('director:proactive');
  }
  if (intent.beatType === 'cool_down' && params.character.behavior.empathyLevel >= 65) {
    bias += 0.16 * intent.pressure;
    reasons.push('director:cool_down:empathy');
  }
  if (intent.source === 'faction' && hasSharedScenarioFaction(params.chat, params.character.id, intent.targetActorIds)) {
    bias += 0.18 * intent.pressure;
    reasons.push('director:faction:shared');
  }
  return { bias, reasons };
}

export function buildSpeakerScoreBreakdown(params: {
  actorId: string;
  addressed: number;
  topicRelevance: number;
  lineInvolvement: number;
  emotionalPressure: number;
  innerLifePressure?: number;
  relationshipPressure: number;
  factionPressure?: number;
  personalityDrive: number;
  knowledgeAccess?: number;
  novelty?: number;
  silencePressure?: number;
  cooldownPenalty?: number;
  repetitionPenalty?: number;
  finalScore: number;
  reasons?: string[];
}): SpeakerScoreBreakdown {
  return {
    actorId: params.actorId,
    addressed: params.addressed,
    topicRelevance: params.topicRelevance,
    lineInvolvement: params.lineInvolvement,
    emotionalPressure: params.emotionalPressure,
    innerLifePressure: params.innerLifePressure || 0,
    relationshipPressure: params.relationshipPressure,
    factionPressure: params.factionPressure || 0,
    personalityDrive: params.personalityDrive,
    knowledgeAccess: params.knowledgeAccess || 0,
    novelty: params.novelty || 0,
    silencePressure: params.silencePressure || 0,
    cooldownPenalty: params.cooldownPenalty || 0,
    repetitionPenalty: params.repetitionPenalty || 0,
    finalScore: params.finalScore,
    reasons: params.reasons || [],
  };
}
