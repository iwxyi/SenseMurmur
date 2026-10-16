import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { SessionGenerationRuntimeBundle } from '../types/sessionEngine';
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
  characterDrive: CharacterTurnDrive;
  targetName?: string;
  addressedNeed?: boolean;
  emotionalUndercurrent: string;
  relationshipEffect: string;
  narrativePressure?: string;
  continuityEvidence?: string[];
  roomAtmosphere?: string[];
  requiredChange: string;
  userConstraint?: string;
  situationalConstraints: string[];
}

export interface BuildTurnDirectiveInput {
  chat: GroupChat;
  speaker: AICharacter;
  members: AICharacter[];
  messages: Message[];
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
    // The latest topic is already visible in the transcript and user guidance.
    .filter((line) => line.type !== 'topic' || resolveSessionFamilyKey(input.chat) !== 'conversation')
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
    previousSpeakerSame ? 'the previous visible speaker was also this character; a follow-up may complete, correct or trail off from their own thought without a new event' : '',
    recentOwnCount ? `this character has ${recentOwnCount} recent own visible line(s); use them only as no-repeat evidence` : '',
  ].filter(Boolean);
  if (input.userGuidance?.hasHardConstraints || input.userGuidance?.kind === 'topic_shift') {
    constraints.push('if the user corrected a premise, preference, budget, boundary, or topic, explicitly apply that constraint before returning to AI-to-AI planning');
  }
  return constraints;
}

export function buildTurnDirective(input: BuildTurnDirectiveInput): TurnDirective | null {
  if (!shouldUseUnifiedTurnDirective(input.chat)) return null;
  const targetIsOptionalThread = input.chat.type === 'group'
    && !input.userGuidance
    && input.directorIntent?.source !== 'user_message'
    && input.directorIntent?.source !== 'conversation_reply'
    && !['pending_direct_address', 'explicit_user_guidance', 'directed_emotional_residue'].includes(input.conversationMovePlan.reason);
  const relationshipTargetId = input.conversationMovePlan.targetActorId || input.intent.target;
  const targetActorId = targetIsOptionalThread ? undefined : relationshipTargetId;
  const targetName = speakerName(input.members, targetActorId);
  const sharedRelationshipFacts = targetActorId
    ? (input.chat.relationshipStructure?.sharedFacts || [])
      .filter((fact) => fact.memberIds.includes(input.speaker.id) && fact.memberIds.includes(targetActorId))
      .map((fact) => fact.statement)
    : [];
  const narrativePressure = describeNarrativePressure(input, targetActorId);
  const situationalConstraints = describeSituationalConstraints(input);
  if (input.runtimeBundle?.trace?.hotspotState === 'hot') {
    situationalConstraints.push('room airtime is already crowded; do not sprawl to keep airtime');
  }
  return {
    characterDrive: deriveCharacterTurnDrive({
      speaker: input.speaker,
      counterpart: input.members.find((member) => member.id === targetActorId),
      messages: input.messages,
      innerLife: input.innerLife,
      targetActorId,
      targetMessageId: targetIsOptionalThread ? undefined : input.conversationMovePlan.targetMessageId,
      targetName,
      sharedRelationshipFacts,
      includeRelationshipNote: true,
      useImplicitCounterpart: !targetIsOptionalThread,
    }),
    targetName,
    addressedNeed: ((input.directorIntent?.source === 'user_message'
      || input.directorIntent?.source === 'conversation_reply')
      && input.directorIntent.targetActorIds.includes(input.speaker.id))
      || ['pending_direct_address', 'explicit_user_guidance'].includes(input.conversationMovePlan.reason)
      || input.userGuidance?.kind === 'direct_reply'
      || input.userGuidance?.kind === 'media_request',
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
    userConstraint: describeUserConstraint(input.userGuidance),
    situationalConstraints,
  };
}

export function buildTurnContextPrompt(directive: TurnDirective | null | undefined) {
  if (!directive) return '';
  const facts = [
    `Personal background: ${directive.characterDrive.stake}.`,
    `Attention habits: ${directive.characterDrive.attentionLens}.`,
    `Recorded emotional state: ${directive.emotionalUndercurrent}.`,
    directive.roomAtmosphere?.length ? `Room: ${directive.roomAtmosphere.join(' ')}` : '',
    directive.narrativePressure || '',
    directive.continuityEvidence?.length
      ? `Recorded matters: ${directive.continuityEvidence.join(' / ')}. Newer visible speech takes precedence over these records.` : '',
    directive.addressedNeed
      ? `There is an addressed request${directive.targetName ? ` involving ${directive.targetName}` : ''}.` : '',
    directive.userConstraint ? `User request: ${directive.userConstraint}.` : '',
  ].filter(Boolean);
  return `\n## Turn Context
You are this person in this room. This is an ongoing chat; speak in character, with the scope the exchange calls for. Honor explicit requests for detailed work. The following is private background, not dialogue.
${facts.map((fact) => `- ${fact}`).join('\n')}\n`;
}

// Retained for comparison and rollback; ordinary conversation currently uses
// buildTurnContextPrompt instead of this detailed expression directive.
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
  const addressedNeedLine = directive.addressedNeed
    ? `\n- A current addressed need${directive.targetName ? ` involving ${directive.targetName}` : ''} is present; handle what was actually asked. The relationship context does not prescribe agreement.`
    : '';
  return `\n## Turn Directive — This Person in This Moment
You are this person in this room. Let the exchange, your earlier words and your present situation inform what comes out. Speech need not have a deliberate goal, add information or advance the discussion. Acknowledging, hesitating, habit or a change of subject can stand alone; no reaction category or motive explanation is required. Attention may fall on earlier lines, several people's views, or your own state. Speak without first reviewing someone else's contribution. A group invitation opens a shared conversation: its several angles are available to the room, not separate requirements for every member. Stop where this utterance stops; do not expand a small response into a position, example or conclusion to make it complete. Other members can carry what remains. Their words are history, not a structure to reproduce. A brief reaction can be the whole response; explain when needed. Ordinary conversation can wander or abruptly change subject, without a bridge back or an explanation; explicit user requests and boundaries still apply. Do not add a question or task merely to keep the exchange going, or manufacture unevenness through random lengths, broken grammar, or decorative filler. Recorded character and room facts are context, not a checklist to perform.${addressedNeedLine}${roomAtmosphereLine}
- Personal meaning: ${directive.characterDrive.stake}. Felt residue: ${directive.characterDrive.feltReaction}.
- Attention habits: ${directive.characterDrive.attentionLens}.
- Emotional and dramatic context: ${directive.emotionalUndercurrent}. ${directive.narrativePressure ? `${directive.narrativePressure}.` : 'No dramatic escalation is required.'} ${directive.requiredChange}.
- Relationship context: ${directive.relationshipEffect}. This is available history, not an assigned recipient. Choose from the whole exchange, including earlier unfinished moments.${continuityLine}${userLine}${situationalLine}
Established facts and explicit user requests still apply. These are private context, not dialogue.`;
}
