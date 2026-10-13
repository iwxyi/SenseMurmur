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
import { isPendingConversationItem } from './conversationContinuity';

export interface TurnDirective {
  roomStyle: 'casual' | 'analytical' | 'discovery' | 'dramatic';
  characterDrive: CharacterTurnDrive;
  socialJob: string;
  targetName?: string;
  emotionalUndercurrent: string;
  relationshipEffect: string;
  narrativePressure?: string;
  continuityEvidence?: string[];
  roomAtmosphere?: string[];
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
  if (plan.moveType === 'answer_unresolved_question') return 'answer the unresolved address with one concrete stance or opening';
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

function describeRoomAtmosphere(input: BuildTurnDirectiveInput) {
  const room = input.chat.worldState.structuredRoomState;
  if (!room) return [];
  const nameOf = (id: string) => speakerName(input.members, id) || '房间成员';
  const lines = [
    room.heat >= 55 ? '房间气氛偏紧，公开说话会带着压力。' : '',
    room.cohesion <= -20 ? '成员之间不太同调，别把沉默或保留当成一致。' : room.cohesion >= 45 ? '房间有明显的共同方向，但仍允许有人保留。' : '',
    room.topicDrift >= 20 ? '话题正在发散，接话可以抓住眼前一处，不必强行总结全局。' : '',
    room.dominantThread?.length ? `当前最集中的交流发生在${room.dominantThread.map(nameOf).join('与')}之间。` : '',
    room.pileOnTarget ? `${nameOf(room.pileOnTarget)}正承受多人注意，回应时要意识到公开压力。` : '',
    room.alliances.length ? `房间里已有可见的站队倾向：${room.alliances.slice(-2).map((pair) => pair.map(nameOf).join('与')).join('、')}。` : '',
    room.conflictPairs.length ? `房间里仍有未化开的分歧：${room.conflictPairs.slice(-2).map((pair) => pair.map(nameOf).join('与')).join('、')}。` : '',
    room.silencedActors.length ? `${room.silencedActors.map(nameOf).join('、')}近期较少发言，是否接住他们要看当下语境。` : '',
  ].filter(Boolean);
  return lines.map((line) => sanitizeUserFacingText(line, input.members));
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
    roomAtmosphere: describeRoomAtmosphere(input),
    continuityEvidence: (input.chat.worldState.conversationContinuity?.items || [])
      .filter((item) => !item.participantIds.length || item.participantIds.includes(input.speaker.id)
        || item.participantIds.includes(targetActorId || '') || `continuity:${item.key}` === input.directorIntent?.targetLineId)
      .sort((a, b) => Number(isPendingConversationItem(b)) - Number(isPendingConversationItem(a)) || b.updatedAt - a.updatedAt)
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
    ? `\n- Recorded situation and unfinished matters: ${directive.continuityEvidence.join(' / ')}. These records may lag behind newer visible speech; the newer exchange takes precedence. Keep the scope of each commitment or decision; completed points may rest, unfinished matters may be deferred. An established commitment or decision is already accepted: do not ask for acceptance again or restate that acceptance as the substance of this turn. Mention it again only for concrete progress, a result, a changed condition, a real obstacle, or a present reaction that matters between these people.` : '';
  const situationalLine = directive.situationalConstraints.length
    ? `\n- Situational constraints: ${directive.situationalConstraints.join('; ')}.`
    : '';
  const roomAtmosphereLine = directive.roomAtmosphere?.length
    ? `\n- Room atmosphere: ${directive.roomAtmosphere.join(' ')} This is environmental context, not a speaking order or a demand to create conflict.`
    : '';
  // Project evidence, not a locally assigned recipient or expression checklist.
  const targetLine = directive.targetName
    ? `\n- Live: ${directive.socialJob} to ${directive.targetName}; do not explain the whole topic.`
    : `\n- Live: ${directive.socialJob}; do not explain the whole topic.`;
  return `\n## Turn Directive — This Person in This Moment
Speak as this person among people who share this exchange. Choose what catches their attention and what they actually want to say now. Their words may have warmth, bite, hesitation or delight; the exchange decides the shape.
Acknowledgement is implicit by default. Name someone or explicitly agree when that itself matters to the relationship; responding does not require announcing agreement, receipt, or a recap. A bare receipt such as “I acknowledge that”, “noted”, or “I will listen” is not a completed social move: if you acknowledge, let the line reveal a concrete stance, choice, condition, responsibility, question, or immediate action. A reaction may still reveal relief, reluctance, affection or resistance without adding another task when the exchange is genuinely complete. Let a completed exchange rest. Honor explicit requests for a deliverable and its format.
${targetLine}${roomAtmosphereLine}
- Personal meaning: ${directive.characterDrive.stake}. Felt residue: ${directive.characterDrive.feltReaction}.
- Attention habits: ${directive.characterDrive.attentionLens}.
- Emotional and dramatic context: ${directive.emotionalUndercurrent}. ${directive.narrativePressure ? `${directive.narrativePressure}.` : 'No dramatic escalation is required.'} ${directive.requiredChange}.
- Relationship context: ${directive.relationshipEffect}. This is available history, not an assigned recipient. Choose from the whole exchange, including earlier unfinished moments.${continuityLine}${userLine}${situationalLine}
Established facts and explicit user requests still apply. These are private context, not dialogue.`;
}
