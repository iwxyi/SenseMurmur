import type { AICharacter } from '../types/character';
import type { Message } from '../types/message';
import type { InnerLifeProjection } from './innerLifeEngine';
import { getExplicitReplyTargetIds } from './chatMessageSemantics';

export type CharacterRelationalAction = 'situated';
export type SpeakingNecessity = 'strong' | 'optional' | 'let_silence_stand';

export interface CharacterTurnDrive {
  stake: string;
  relationalAction: CharacterRelationalAction;
  feltReaction: string;
  observableMove: string;
  attentionLens: string;
  speakingNecessity: SpeakingNecessity;
  evidence: string[];
}

function relationshipEvidence(relationship: AICharacter['relationships'][number]) {
  return `relationship axes (-100 to 100): warmth ${relationship.warmth}, competence ${relationship.competence}, trust ${relationship.trust}, threat ${relationship.threat}, attachment ${relationship.attachment ?? 0}, deference ${relationship.deference ?? 0}`;
}

/** Organizes character evidence; present motives and reactions belong to the model. */
export function deriveCharacterTurnDrive(input: {
  speaker: AICharacter;
  counterpart?: AICharacter;
  messages: Message[];
  innerLife: InnerLifeProjection;
  targetActorId?: string;
  targetMessageId?: string;
  targetName?: string;
  sharedRelationshipFacts?: string[];
  includeRelationshipNote?: boolean;
  useImplicitCounterpart?: boolean;
}): CharacterTurnDrive {
  const { speaker, innerLife } = input;
  const core = speaker.coreProfile;
  const selectedMessage = input.targetMessageId
    ? input.messages.find((message) => message.id === input.targetMessageId)
    : undefined;
  const latest = selectedMessage || (input.useImplicitCounterpart === false
    ? undefined
    : input.messages.filter((message) => !message.isDeleted
      && message.type !== 'system' && message.type !== 'event' && message.senderId !== speaker.id).at(-1));
  const resolvedTargetId = input.targetActorId || innerLife.activeAffect?.counterpartId || latest?.senderId;
  const relationship = speaker.relationships.find((item) => item.characterId === resolvedTargetId);
  const reciprocal = input.counterpart && input.counterpart.id === resolvedTargetId
    ? input.counterpart.relationships.find((item) => item.characterId === speaker.id)
    : undefined;
  const targetName = input.targetName
    || (latest && resolvedTargetId === latest.senderId ? latest.senderName : input.counterpart?.name)
    || 'the current person';
  const sharedFacts = (input.sharedRelationshipFacts || []).filter(Boolean).slice(0, 2);
  const addressedMessage = latest as (Message & {
    primaryAddressedTargetId?: string | null;
    addressedTargetIds?: string[] | null;
  }) | undefined;
  const directAddress = Boolean(addressedMessage && (addressedMessage.primaryAddressedTargetId === speaker.id
    || addressedMessage.addressedTargetIds?.includes(speaker.id)));
  const lastOwnIndex = input.messages.findLastIndex((message) => !message.isDeleted
    && message.type === 'ai' && message.senderId === speaker.id);
  const answerRequested = Boolean(latest && input.messages.indexOf(latest) > lastOwnIndex
    && getExplicitReplyTargetIds(latest).includes(speaker.id));
  const evidence: string[] = [];
  if (directAddress) evidence.push('direct_address');
  if (relationship) evidence.push('relationship_to_current_target');
  if (input.includeRelationshipNote !== false && relationship?.note?.trim()) evidence.push('directional_relationship_note');
  if (sharedFacts.length) evidence.push('shared_relationship_structure');
  if (core?.coreDesire) evidence.push('core_desire');
  if (core?.coreFear) evidence.push('core_fear');
  if (core?.valuePriority?.length || core?.values?.length) evidence.push('core_values');
  if (core?.interactionHabits?.length || core?.biases?.length || core?.perceptionBiases?.length || core?.sensitivities?.length) evidence.push('character_attention_pattern');

  const stake = [
    relationship ? `Toward ${targetName}, ${relationshipEvidence(relationship)}` : '',
    reciprocal ? `From ${targetName}'s perspective, ${relationshipEvidence(reciprocal)}` : '',
    input.includeRelationshipNote !== false && relationship?.note?.trim() ? `This person's view of ${targetName}: ${relationship.note.trim()}` : '',
    sharedFacts.length ? `Shared facts: ${sharedFacts.join(' / ')}` : '',
    core?.coreDesire ? `Standing desire: ${core.coreDesire}` : '',
    core?.coreFear ? `Standing fear: ${core.coreFear}` : '',
  ].filter(Boolean).join('; ') || 'no invented private stake; ordinary speech does not require a personal stake';
  const emotion = innerLife.dominantEmotion;
  const affect = innerLife.activeAffect;
  const feltReaction = [
    emotion ? `Recorded feeling: ${emotion.kind} ${emotion.value}` : 'No strong carried feeling is recorded',
    affect && affect.counterpartId === resolvedTargetId ? `Recorded interaction with ${targetName}: ${affect.kind}, ${affect.role}, ${affect.tone}` : '',
    'the present interpretation is not predetermined',
  ].filter(Boolean).join('; ');

  // These estimates affect candidate ordering only, never the expression prompt.
  const speakingNecessity: SpeakingNecessity = answerRequested || innerLife.pressure >= 0.66
    || innerLife.impulse === 'repair' || innerLife.impulse === 'mock' || innerLife.impulse === 'defend_face'
    ? 'strong'
    : innerLife.impulse === 'stay_silent' || innerLife.impulse === 'avoid' || innerLife.impulse === 'withdraw'
      ? 'let_silence_stand'
      : 'optional';
  return {
    stake,
    relationalAction: 'situated',
    feltReaction,
    observableMove: 'infer a response from this person and the exchange, not an axis threshold or scheduler impulse',
    attentionLens: [
      `Personality tendencies (0-100): ${Object.entries(speaker.personality).map(([axis, value]) => `${axis} ${value}`).join(', ')}`,
      speaker.personalityDrift && Object.keys(speaker.personalityDrift).length
        ? `Recorded personality drift: ${Object.entries(speaker.personalityDrift).map(([axis, value]) => `${axis} ${value}`).join(', ')}` : '',
      core?.interactionHabits?.length ? `Interaction habits: ${core.interactionHabits.join(' / ')}` : '',
      core?.biases?.length ? `Subjective biases: ${core.biases.join(' / ')}` : '',
      core?.perceptionBiases?.length ? `Perception biases: ${core.perceptionBiases.join(' / ')}` : '',
      core?.sensitivities?.length ? `Sensitivities: ${core.sensitivities.join(' / ')}` : '',
      (core?.valuePriority?.length || core?.values?.length) ? `Values: ${(core.valuePriority?.length ? core.valuePriority : core.values)?.join(' / ')}` : '',
    ].filter(Boolean).join('; '),
    speakingNecessity,
    evidence,
  };
}

export function getCharacterTurnDriveSpeakerBias(drive: CharacterTurnDrive) {
  if (drive.speakingNecessity === 'strong') return 0.24;
  if (drive.speakingNecessity === 'let_silence_stand') return -0.3;
  return 0;
}
