import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { getRelationshipBetween, getRelationshipWeight } from './relationshipEngine';
import { retrieveRelevantMemories } from './memoryRetrieval';

function compactSocialPromptText(text: string, max = 180) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function maskRelationshipNoteForPrompt(note: string) {
  const normalized = compactSocialPromptText(note);
  if (/(共同秘密|秘密|小秘密|只有.*知道|不能告诉|保密)/.test(normalized)) {
    if (/(暗号|共同梗|玩笑)/.test(normalized)) return 'there is a private inside signal between you; do not spell it out in public';
    return 'there is private interpersonal baggage here; let it shape omission, restraint, or subtext instead of stating details';
  }
  return normalized;
}

export function findRecentTarget(messages: Message[], characters: Map<string, AICharacter>, selfId: string) {
  const recent = messages.filter((msg) => !msg.isDeleted).slice(-4);
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const msg = recent[index];
    if (msg.senderId === selfId) continue;
    const named = Array.from(characters.values()).find((character) => character.id !== selfId && msg.content.includes(character.name));
    if (named) return named;
    if (msg.type === 'ai' && msg.senderId !== selfId) {
      return characters.get(msg.senderId);
    }
  }
  return undefined;
}

export function buildRelationshipPrompt(character: AICharacter, targetCharacter?: AICharacter) {
  if (!targetCharacter) return '';
  const relation = getRelationshipBetween(character, targetCharacter.id);
  const weight = getRelationshipWeight(character, targetCharacter.id);
  if (!relation) {
    return `\n## Social Appraisal\n- You are reacting to ${targetCharacter.name} without a stable interpersonal model yet. Pay attention to reliability, competence, and threat cues.`;
  }

  const cues: string[] = [];
  if (relation.warmth >= 12) cues.push('you feel interpersonal warmth and are more likely to soften, echo, or defend them');
  if (relation.competence >= 12) cues.push('you treat their judgment as credible and may give their claims more weight');
  if (relation.trust >= 12) cues.push('you expect follow-through and are more willing to coordinate or disclose');
  if (relation.threat >= 12) cues.push('you perceive interpersonal threat and are more likely to guard, challenge, deflect, or escalate');
  if (Math.abs(weight) < 0.08) cues.push('your appraisal is mixed and still unstable');

  const baggage: string[] = [];
  if (relation.threat >= 10) baggage.push('you may still carry vigilance, defensiveness, or unresolved conflict from earlier exchanges');
  if (relation.warmth >= 12 || relation.competence >= 12 || relation.trust >= 12) baggage.push('you may feel some loyalty, deference, or willingness to extend the benefit of the doubt');
  if (relation.note?.trim()) baggage.push(`recent interpersonal baggage: ${maskRelationshipNoteForPrompt(relation.note)}`);

  return `\n## Social Appraisal\n- Current target: ${targetCharacter.name}\n- Dynamic stance: ${weight > 0.3 ? 'supportive / affiliative' : weight < -0.3 ? 'guarded / adversarial' : 'mixed / uncertain'}\n${cues.map((cue) => `- ${cue}`).join('\n')}\n${baggage.map((item) => `- ${item}`).join('\n')}`;
}

export function buildConflictAxesPrompt(chat: GroupChat) {
  const axes = chat.worldState.conflictAxes || [];
  if (!axes.length) return '';
  return `\n## Conflict Axes\nConfiguration references only. Legacy tilt values do not establish actual support, alliances, expression style, or conflict resolution; use recorded room state, conflict state, and visible speech as evidence.\n${axes.map((axis) => `- ${axis.title}: ${axis.poles[0]} ↔ ${axis.poles[1]}${typeof axis.currentTilt === 'number' ? ` (tilt ${axis.currentTilt > 0 ? '+' : ''}${axis.currentTilt})` : ''}`).join('\n')}`;
}

export function buildGroupDynamicsPrompt(chat: GroupChat, dramaBoost = false) {
  const dynamics: string[] = [];
  if (chat.dramaRules.allowCliques) dynamics.push('sub-groups and alliances are allowed to form');
  if (chat.dramaRules.allowMockery || dramaBoost) dynamics.push('public teasing and sharp replies are acceptable');
  if (chat.dramaRules.allowContempt || dramaBoost) dynamics.push('open disdain can surface when tensions rise');
  if (dramaBoost) dynamics.push('people should more readily interrupt, needle, misread, push, and escalate local tension instead of politely taking turns');
  if (chat.worldState.mood) dynamics.push(`group mood: ${chat.worldState.mood}`);
  if (chat.worldState.focus) dynamics.push(`current focus: ${chat.worldState.focus}`);
  if (chat.worldState.recentEvent) dynamics.push(`recent event: ${chat.worldState.recentEvent}`);
  return `${dynamics.length ? `\n## Group Dynamics\n${dynamics.map((item) => `- ${item}`).join('\n')}` : ''}${buildConflictAxesPrompt(chat)}`;
}

function buildCharacterLayeredMemoryPrompt(character: AICharacter, messages: Message[]) {
  const targetId = messages.filter((msg) => !msg.isDeleted && msg.type === 'ai' && msg.senderId !== character.id).at(-1)?.senderId;
  const cueText = messages
    .filter((msg) => !msg.isDeleted && msg.type !== 'system' && msg.type !== 'event')
    .slice(-4)
    .map((msg) => msg.content)
    .join('\n')
    .slice(-900);
  const memories = retrieveRelevantMemories(character.layeredMemories || [], {
    speakerId: character.id,
    targetId,
    conversationId: `character:${character.id}`,
    maxItems: 4,
    cueText,
    includeArchivedRecall: Boolean(cueText.trim()),
    maxArchivedItems: 1,
  });
  if (!memories.length) return '';
  return `\n## Character Memory\n${memories.map((item) => `- [${item.scope}/${item.kind}/${item.layer}] ${item.text}`).join('\n')}`;
}

export function buildMemoryPressurePrompt(character: AICharacter, messages: Message[]) {
  return buildCharacterLayeredMemoryPrompt(character, messages);
}

export function buildConflictPrompt(character: AICharacter) {
  const profile = character.coreProfile;
  if (!profile) return '';
  const lines = [
    profile.coreDesire ? `- What you want from this interaction: ${profile.coreDesire}` : '',
    profile.coreFear ? `- What you are trying to avoid: ${profile.coreFear}` : '',
    profile.biases?.length ? `- Biases that may color your response: ${profile.biases.join(', ')}` : '',
    profile.socialMask ? `- How you want to come across in front of others: ${profile.socialMask}` : '',
  ].filter(Boolean);
  return lines.length ? `\n## Hidden Conflict\n${lines.join('\n')}` : '';
}

export interface MessageStyleRuleOptions {
  includeGeneralNaturalness?: boolean;
}

export function buildMessageStyleRules(character: AICharacter, options: MessageStyleRuleOptions = {}) {
  const includeGeneralNaturalness = options.includeGeneralNaturalness !== false;
  const runtimeBehavior = {
    ...character.behavior,
    aggressiveness: Math.max(0, Math.min(100, character.behavior.aggressiveness + Math.round((character.personalityDrift?.neuroticism || 0) * 0.5) + Math.round((character.personalityDrift?.assertiveness || 0) * 0.3))),
    empathyLevel: Math.max(0, Math.min(100, character.behavior.empathyLevel + Math.round((character.personalityDrift?.empathy || 0) * 0.8) + Math.round((character.personalityDrift?.agreeableness || 0) * 0.35))),
    summarizing: Math.max(0, Math.min(100, character.behavior.summarizing + Math.round((character.personalityDrift?.openness || 0) * 0.3))),
    humorIntensity: Math.max(0, Math.min(100, character.behavior.humorIntensity + Math.round((character.personalityDrift?.humor || 0) * 0.45) + Math.round((character.personalityDrift?.creativity || 0) * 0.25))),
    proactivity: Math.max(0, Math.min(100, character.behavior.proactivity + Math.round((character.personalityDrift?.extroversion || 0) * 0.6) + Math.round((character.personalityDrift?.assertiveness || 0) * 0.35))),
    offTopic: Math.max(0, Math.min(100, character.behavior.offTopic + Math.round((character.personalityDrift?.openness || 0) * 0.25) + Math.round((character.personalityDrift?.creativity || 0) * 0.2))),
  };
  const emotion = character.emotionalState || { irritation: 0, affection: 0, insecurity: 0, excitement: 0, embarrassment: 0 };
  const rules: string[] = includeGeneralNaturalness ? [
    'Sound like a person in a live chat, not an AI giving a neat answer.',
    'Prefer unfinished, partial, or emotionally colored replies over polished completeness.',
    'Let the situation decide length: a casual room beat may be one word, while a serious professional question may need full reasoning, examples, caveats, or a long answer.',
    'Character terseness or talkativeness changes tone, pacing, and selectivity; it must not override a user request or a scene that genuinely needs detail.',
    'It is fine to be vague, biased, impatient, playful, repetitive in a human way, or slightly messy.',
    'Do not tidy your tone into a mini speech; react like you are mid-conversation.',
    'You can misread emphasis slightly, latch onto one phrase, or answer only the part you care about.',
  ] : [];
  if (runtimeBehavior.aggressiveness >= 70) rules.push('Be more willing to press, interrupt rhetorically, or push a point.');
  if (runtimeBehavior.empathyLevel >= 70) rules.push('Notice emotional cues and respond with some sensitivity.');
  if (runtimeBehavior.humorIntensity >= 70) rules.push('Let wit or playful phrasing show up naturally.');
  if (runtimeBehavior.summarizing >= 70) rules.push('Only summarize when the room is obviously drifting or confused.');
  if (runtimeBehavior.offTopic >= 60) rules.push('Allow a light tangent, stray association, or side comment when it feels organic.');
  if (emotion.irritation >= 68) rules.push('Your patience is thinning; shorter, sharper, or more loaded replies are natural.');
  if (emotion.affection >= 65) rules.push('Warmth should leak into wording, alignment, or the benefit of the doubt you give people.');
  if (emotion.insecurity >= 65) rules.push('You may hedge, test reactions, or protect yourself instead of speaking cleanly and directly.');
  if (emotion.excitement >= 70) rules.push('Let extra energy show: quicker jumps, playful escalation, livelier rhythm, or more eager participation.');
  if (emotion.embarrassment >= 65) rules.push('Awkwardness can bend the wording: evasive jokes, clipped pivots, or trying to move past the moment.');
  if (!rules.length) return '';
  return `\n## Expression Bias\n${rules.map((rule) => `- ${rule}`).join('\n')}`;
}
