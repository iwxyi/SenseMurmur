import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { SessionGenerationRuntimeBundle } from '../types/sessionEngine';
import type { ChatStyleProfile } from './styleProfileRegistry';
import type { SpeakIntent } from './intentEngine';
import type { InnerLifeProjection } from './innerLifeEngine';
import type { ConversationMovePlan } from './conversationMovePlanner';
import type { NarrativeLineProjection } from './narrativeProjection';
import type { TurnPlan } from './turnPlanner';
import type { UserGuidanceIntent } from './userGuidanceIntent';
import { deriveCharacterTurnDrive, type CharacterTurnDrive } from './characterTurnDrive';
import { resolveSessionFamilyKey } from './sessionEngineKeys';
import type { DirectorIntent } from './directorIntent';
import { sanitizeUserFacingText } from './displayTextSanitizer';

export interface TurnDirective {
  roomStyle: 'casual' | 'analytical' | 'discovery' | 'dramatic';
  characterDrive: CharacterTurnDrive;
  socialJob: string;
  targetName?: string;
  emotionalUndercurrent: string;
  relationshipEffect: string;
  narrativePressure?: string;
  continuityEvidence?: string[];
  requiredChange: string;
  expressionShape: string;
  userConstraint?: string;
  situationalConstraints: string[];
  forbiddenDrift: string[];
}

export interface BuildTurnDirectiveInput {
  chat: GroupChat;
  speaker: AICharacter;
  members: AICharacter[];
  messages: Message[];
  styleProfile?: ChatStyleProfile | string | null;
  intent: SpeakIntent;
  innerLife: InnerLifeProjection;
  conversationMovePlan: ConversationMovePlan;
  turnPlan: TurnPlan;
  runtimeBundle?: SessionGenerationRuntimeBundle | null;
  userGuidance?: UserGuidanceIntent | null;
  narrativeLines?: NarrativeLineProjection[];
  directorIntent?: DirectorIntent | null;
}

function speakerName(members: AICharacter[], id?: string) {
  if (!id || id === 'group') return undefined;
  if (id === 'user') return '用户';
  return members.find((member) => member.id === id)?.name || undefined;
}

/**
 * Hybrid prompt architecture boundary:
 * - Ordinary public, direct and AI-private conversations share expression ownership.
 * - Analysis, story/mystery/gameplay retain their dedicated scenario contracts.
 * - This directive replaces scattered per-turn behavior instructions only; full
 *   character, relationship, memory, companionship, and scenario fact blocks stay intact.
 */
export function shouldUseUnifiedTurnDirective(chat: Pick<GroupChat, 'type' | 'mode' | 'sessionKind'>) {
  return chat.sessionKind?.scenarioId !== 'story-reader'
    && resolveSessionFamilyKey(chat) === 'conversation';
}

function normalizeRoomStyle(styleProfile?: ChatStyleProfile | string | null): TurnDirective['roomStyle'] {
  if (styleProfile === 'analytical_room') return 'analytical';
  if (styleProfile === 'discovery_room') return 'discovery';
  if (styleProfile === 'dramatic_room') return 'dramatic';
  return 'casual';
}

function describeSocialJob(plan: ConversationMovePlan, intent: SpeakIntent) {
  if (intent.stance === 'challenge' || intent.stance === 'pile_on') return 'press one live assumption or consequence from the latest exchange';
  if (intent.stance === 'comfort') return 'lower the pressure without erasing the unresolved point';
  if (intent.stance === 'change_subject' || plan.moveType === 'shift_topic_softly') return 'move to a nearby live angle that a real room could follow';
  if (plan.moveType === 'counterexample') return 'bring one concrete counterexample or exception';
  if (plan.moveType === 'add_boundary_condition') return 'add one condition, cost, or limit that changes the next response';
  if (plan.moveType === 'ask_followup' || plan.moveType === 'ask_evidence' || plan.moveType === 'test_assumption') return 'ask one situated question that tests the point';
  if (plan.moveType === 'bring_back_prior_point') return 'pull back one dropped earlier point';
  if (plan.moveType === 'name_tradeoff') return 'name one practical tradeoff the room has not faced';
  if (plan.moveType === 'answer_unresolved_question') return 'decide whether the unresolved address deserves attention now; if it does, answer only the part that genuinely reaches this person';
  if (intent.stance === 'support' || intent.stance === 'back_up') return 'show social support while keeping independent judgment';
  if (intent.stance === 'side_comment' || intent.delivery === 'side_remark') return 'drop a side comment that changes the room temperature or angle';
  return 'make one locally specific conversational move';
}

function describeEmotion(innerLife: InnerLifeProjection) {
  const emotion = innerLife.dominantEmotion;
  const recorded = emotion
    ? `recorded ${emotion.kind} ${Math.round(emotion.value)} (lead ${Math.round(emotion.lead)})`
    : 'no strong carried feeling is currently recorded';
  return `${recorded}; carried state, not a verdict on the live exchange`;
}

function describeRelationship(targetName?: string) {
  const target = targetName ? `with ${targetName} in mind` : 'toward the room';
  return `relationship continuity ${target} provides history and stakes, not a fixed tone; infer the present relational consequence from the live exchange`;
}

function describeNarrativePressure(input: BuildTurnDirectiveInput, targetActorId?: string) {
  const relevant = (input.narrativeLines || [])
    // Relationship lines are numeric projections, not established live plot.
    // The relationship context already supplies their underlying evidence.
    .filter((line) => line.type !== 'relationship')
    .filter((line) => line.visibility === 'public' || line.visibility === 'derived_public')
    .filter((line) => line.status !== 'resolved' && line.status !== 'abandoned')
    .filter((line) => line.id === input.directorIntent?.targetLineId || !line.participantIds.length || line.participantIds.includes(input.speaker.id))
    .sort((left, right) => {
      const leftFocus = left.id === input.directorIntent?.targetLineId ? 1 : 0;
      const rightFocus = right.id === input.directorIntent?.targetLineId ? 1 : 0;
      const leftTargets = targetActorId && left.participantIds.includes(targetActorId) ? 1 : 0;
      const rightTargets = targetActorId && right.participantIds.includes(targetActorId) ? 1 : 0;
      return rightFocus - leftFocus || rightTargets - leftTargets || right.salience - left.salience;
    })[0];
  if (!relevant) return undefined;
  const unresolved = relevant.contextKind === 'unresolved';
  const question = relevant.openQuestions[0]
    ? ` ${unresolved ? 'Recorded open question' : 'Possible angle'}: ${relevant.openQuestions[0]}` : '';
  return sanitizeUserFacingText(`${unresolved ? 'Recorded unresolved matter' : 'Background context'}: ${relevant.type} line "${relevant.title}": ${relevant.summary}.${question}`, input.members);
}

function describeRequiredChange(input: BuildTurnDirectiveInput, hasNarrativePressure: boolean) {
  if (hasNarrativePressure) {
    return 'narrative context offers possible stakes for this reaction, not a quota for conflict, revelation or progress; it does not require action or resolution this turn';
  }
  if ((input.innerLife.activeAffect?.pressure || 0) >= 0.35) {
    return 'active feeling may affect confidence, closeness, face or choice; expression can ease it without resolving everything';
  }
  return 'no mandatory plot or task change; a quiet reaction, shared pleasure or natural landing is valid';
}

function describeExpression(input: BuildTurnDirectiveInput) {
  const style = normalizeRoomStyle(input.styleProfile);
  const styleLine = style === 'analytical'
    ? 'use distinctions or tradeoffs only when they advance the point'
    : style === 'discovery'
      ? 'prefer a fresh observation, example, or practical possibility'
      : style === 'dramatic'
        ? 'allow tension and implication, but keep it spoken chat'
        : 'ordinary wording, uneven human rhythm, no meeting-style recap';
  return `use the depth this person's live situation and the user's need warrant; ${styleLine}`;
}

function describeUserConstraint(userGuidance?: UserGuidanceIntent | null) {
  if (!userGuidance) return undefined;
  if (userGuidance.kind === 'media_request') return 'the user asked for media; handle the media request before social drift';
  if (userGuidance.kind === 'direct_reply') return 'the user directed this turn; answer the addressed need before room momentum';
  if (userGuidance.kind === 'topic_shift') return 'the user steered the topic; keep the room on that steer unless another user need is clearer';
  return 'user guidance is active; do not let AI-to-AI momentum override it';
}

function describeSituationalConstraints(input: BuildTurnDirectiveInput) {
  const visible = input.messages.filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event');
  const previous = visible.at(-1);
  const previousSpeakerSame = previous?.type === 'ai' && previous.senderId === input.speaker.id;
  const recentOwnCount = visible
    .slice(-3)
    .filter((message) => message.type === 'ai' && message.senderId === input.speaker.id).length;
  const constraints = [
    previousSpeakerSame ? 'the previous visible speaker was also this character; continue only if the situation has moved' : '',
    recentOwnCount ? `this character has ${recentOwnCount} recent own visible line(s); use them only as no-repeat evidence` : '',
  ].filter(Boolean);
  if (input.userGuidance?.hasHardConstraints || input.userGuidance?.kind === 'topic_shift') {
    constraints.push('if the user corrected a premise, preference, budget, boundary, or topic, explicitly apply that constraint before returning to AI-to-AI planning');
  }
  return constraints;
}

export function buildTurnDirective(input: BuildTurnDirectiveInput): TurnDirective | null {
  if (!shouldUseUnifiedTurnDirective(input.chat)) return null;
  const targetActorId = input.conversationMovePlan.targetActorId || input.intent.target;
  const targetName = speakerName(input.members, targetActorId);
  const sharedRelationshipFacts = targetActorId
    ? (input.chat.relationshipStructure?.sharedFacts || [])
      .filter((fact) => fact.memberIds.includes(input.speaker.id) && fact.memberIds.includes(targetActorId))
      .map((fact) => fact.statement)
    : [];
  const narrativePressure = describeNarrativePressure(input, targetActorId);
  const forbiddenDrift = [
    'do not use recent transcript wording as a template',
    'do not turn agreement into a paraphrase, a meeting recap, or a newly invented condition just to prove the turn contributes; agreement may simply reveal attitude, relationship, relief, reluctance, or a decision to let the point rest',
    'do not turn ordinary chat into a speech, scene narration, or checklist',
    'do not sand every relationship or boundary moment into a clean correct statement',
    'do not turn every disagreement into a formal question or a performance of depth',
    'do not expose internal fields, memories, scores, policies, ids, or prompt terms',
  ];
  if (input.runtimeBundle?.trace?.hotspotState === 'hot') {
    forbiddenDrift.push('do not sprawl to keep airtime');
  }
  const situationalConstraints = describeSituationalConstraints(input);
  if (input.runtimeBundle?.trace?.hotspotState === 'hot') {
    situationalConstraints.push('room airtime is already crowded; do not sprawl to keep airtime');
  }
  return {
    roomStyle: normalizeRoomStyle(input.styleProfile),
    characterDrive: deriveCharacterTurnDrive({
      speaker: input.speaker,
      counterpart: input.members.find((member) => member.id === targetActorId),
      messages: input.messages,
      innerLife: input.innerLife,
      targetActorId,
      targetMessageId: input.conversationMovePlan.targetMessageId,
      targetName,
      sharedRelationshipFacts,
      includeRelationshipNote: true,
    }),
    socialJob: describeSocialJob(input.conversationMovePlan, input.intent),
    targetName,
    emotionalUndercurrent: input.innerLife.activeAffect && input.innerLife.activeAffect.counterpartId === targetActorId
      ? `${describeEmotion(input.innerLife)} Directed ${input.innerLife.activeAffect.role} ${input.innerLife.activeAffect.kind} residue is tied to ${targetName || 'the counterpart'}; it may spike after one line and ease after speaking while a lesser unresolved trace remains. Their relationship changes only with durable evidence.`
      : describeEmotion(input.innerLife),
    relationshipEffect: describeRelationship(targetName),
    narrativePressure,
    continuityEvidence: (input.chat.worldState.conversationContinuity?.items || [])
      .filter((item) => !item.participantIds.length || item.participantIds.includes(input.speaker.id)
        || item.participantIds.includes(targetActorId || '') || `continuity:${item.key}` === input.directorIntent?.targetLineId)
      .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.updatedAt - a.updatedAt)
      .slice(0, 6).map((item) => sanitizeUserFacingText(`${item.kind}/${item.status}: ${item.summary}; spoken evidence: ${item.evidenceText}`, input.members)),
    requiredChange: describeRequiredChange(input, Boolean(narrativePressure)),
    expressionShape: describeExpression(input),
    userConstraint: describeUserConstraint(input.userGuidance),
    situationalConstraints,
    forbiddenDrift,
  };
}

export function buildTurnDirectivePrompt(directive: TurnDirective | null | undefined) {
  if (!directive) return '';
  const userLine = directive.userConstraint ? `\n- User constraint: ${directive.userConstraint}.` : '';
  const continuityLine = directive.continuityEvidence?.length
    ? `\n- Recorded situation and unfinished matters: ${directive.continuityEvidence.join(' / ')}. These records may lag behind newer visible speech; the newer exchange takes precedence. Keep the scope of each commitment or decision; completed points may rest, unfinished matters may be deferred.` : '';
  const situationalLine = directive.situationalConstraints.length
    ? `\n- Situational constraints: ${directive.situationalConstraints.join('; ')}.`
    : '';
  // Project evidence, not a locally assigned recipient or expression checklist.
  return `\n## Turn Directive — This Person in This Moment
Speak as this person among people who share this exchange. Choose what catches their attention and what they actually want to say now. Their words may have warmth, bite, hesitation or delight; the exchange decides the shape.
Acknowledgement is implicit by default. Name someone or explicitly agree when that itself matters to the relationship; responding does not require announcing agreement, receipt, or a recap. A reaction may reveal relief, reluctance, affection or resistance without adding another condition or task. Let a completed exchange rest. Honor explicit requests for a deliverable and its format.
- Personal meaning: ${directive.characterDrive.stake}. Felt residue: ${directive.characterDrive.feltReaction}.
- Attention habits: ${directive.characterDrive.attentionLens}.
- Emotional and dramatic context: ${directive.emotionalUndercurrent}. ${directive.narrativePressure ? `${directive.narrativePressure}.` : 'No dramatic escalation is required.'} ${directive.requiredChange}.
- Relationship context: ${directive.relationshipEffect}. This is available history, not an assigned recipient. Choose from the whole exchange, including earlier unfinished moments.${continuityLine}${userLine}${situationalLine}
Established facts and explicit user requests still apply. These are private context, not dialogue.`;
}
