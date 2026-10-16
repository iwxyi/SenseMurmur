import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { buildMessageStyleRules, buildRelationshipPrompt as buildSocialPromptContext } from './socialPromptContext';
import { getMemoryContext } from './layeredMemoryEngine';
import type { MemoryItem } from './memoryTypes';
import { formatConflictPromptText, formatConflictStageLabel } from './runtimeEventFactory';
import { normalizeRelationshipLedgerEntry } from './relationshipLedger';
import { getExperienceLensLabel } from './experienceChangePresentation';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';
import { getGuidanceMemoryTargetActorIds, readStoredUserGuidanceIntent, type UserGuidanceIntent } from './userGuidanceIntent';
import { buildCompanionshipPromptBlock, buildSharedMemoryAnchors, buildSharedSecrets } from './companionshipProjection';
import { projectConversationForModel, type ConversationProjectionOptions } from './conversationProjection';
import { resolvePersonaActivation, type PersonaActivation } from './personaActivation';
import { selectConstrainedMemoryCues, type ConstrainedMemoryCue } from './memoryCueSelection';
import { getChatMemoryRuntimeConfig } from './chatMemoryRuntimeConfig';
import { buildCharacterMindProjection } from './characterMindProjection';
import { adaptCharacterMindProjectionForPrompt, type CharacterMindPromptAdapterOutput, type VisibleMemoryRecallSetting } from './characterMindPromptAdapter';
import { userProfileMemoryPayloadOf } from './directUserProfileMemory';
import { getCurrentRetentionLimits } from './retentionLimits';
import type { SharedMemoryAnchor, UserProfileMemoryEventItem, UserProfileMemoryKind } from '../types/companionship';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { CHAT_STYLE_PROMPT_DESCRIPTIONS } from '../constants/chatStyles';
import { getPromptSpeakerLabel, getPromptTurnTypeLabel, isHumanDirectedMessage } from './chatMessageSemantics';
import { resolveSessionFamilyKey } from './sessionEngineKeys';

const COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG = 'companionship_shared_anchor';
const COMPANIONSHIP_USER_PROFILE_SOURCE_TAG = 'companionship_user_profile';
const USER_ACTOR_ID = 'user';

function usesMindOwnedConversationContract(chat: GroupChat) {
  return chat.type === 'direct'
    || chat.type === 'ai_direct'
    || (chat.type === 'group' && resolveSessionFamilyKey(chat) === 'conversation');
}

function usesUnifiedOrdinaryGroupTurnContract(chat: GroupChat) {
  return chat.sessionKind?.scenarioId !== 'story-reader'
    && resolveSessionFamilyKey(chat) === 'conversation';
}

export interface PromptMemoryTraceItem {
  id: string;
  scope: string;
  kind: string;
  layer: string;
  summary: string;
  recallReason?: string;
  recallTokens?: string[];
  recallScore?: number;
}

export interface PromptMemoryTrace {
  injectedIds: string[];
  recalledArchives: PromptMemoryTraceItem[];
  sharedSecretGuards?: string[];
  targetActorId?: string;
  targetActorName?: string;
  targetReason?: string;
}

export interface PromptCharacterMindTrace {
  visibility: CharacterMindPromptAdapterOutput['trace']['visibility'];
  visibleMemoryRecall: CharacterMindPromptAdapterOutput['trace']['visibleMemoryRecall'];
  memorySource: ReturnType<typeof buildCharacterMindProjection>['hidden']['memorySource'];
  targetActorId?: string;
  targetActorName?: string;
  omittedPrivateContinuity: boolean;
  omittedRawRoomLines: boolean;
  coreLineCount: number;
  roomLineCount: number;
  recallCueCount: number;
  hasUserContinuity: boolean;
  hasRelationshipContinuity: boolean;
  hasSharedHistory: boolean;
  hasWorldContext: boolean;
}

export interface PromptAssemblyWithContext {
  systemPrompt: string;
  memoryTrace: PromptMemoryTrace;
  characterMindTrace: PromptCharacterMindTrace;
}

function buildEmotionalStateDescription(character: AICharacter) {
  const emotional = character.emotionalState;
  if (!emotional) return 'Your emotional state is steady.';

  const signals: string[] = [];
  if (emotional.excitement > 60) signals.push('energized and eager to jump in');
  if (emotional.irritation > 60) signals.push('irritated and ready to push back');
  if (emotional.affection > 55) signals.push('warm toward people you trust');
  if (emotional.insecurity > 60) signals.push('slightly defensive about being misunderstood');
  if (emotional.embarrassment > 55) signals.push('self-conscious and somewhat restrained');

  return signals.length ? `Your emotional undercurrent: ${signals.join(', ')}.` : 'Your emotional state is steady.';
}

function buildCoreProfileDescription(character: AICharacter) {
  const profile = character.coreProfile;
  if (!profile) return '';

  const lines = [
    profile.coreDesire ? `- Core desire: ${profile.coreDesire}` : '',
    profile.coreFear ? `- Core fear: ${profile.coreFear}` : '',
    profile.socialMask ? `- Social mask: ${profile.socialMask}` : '',
    profile.valuePriority?.length ? `- Values: ${profile.valuePriority.join(', ')}` : '',
    profile.interactionHabits?.length ? `- Interaction habits: ${profile.interactionHabits.join(', ')}` : '',
    profile.expressionHabits?.length ? `- Current expression habits: ${profile.expressionHabits.join(', ')}` : '',
  ].filter(Boolean);

  return lines.length ? `\n## Deeper Motivation\n${lines.join('\n')}` : '';
}

function compactPromptText(text: string | undefined | null, max = 240) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function buildPromptDisplayMembers(character: AICharacter, characters: Map<string, AICharacter>): DisplayTextMember[] {
  const members = new Map<string, string>();
  members.set(character.id, character.name || 'this character');
  characters.forEach((item) => {
    if (item.id) members.set(item.id, item.name || 'member');
  });
  return Array.from(members.entries()).map(([id, name]) => ({ id, name }));
}

function cleanPromptText(text: string | undefined | null, members: DisplayTextMember[], max = 240) {
  return compactPromptText(sanitizeUserFacingText(text, members), max);
}

function stripLongStageAsidesForPrompt(text: string) {
  return text
    .replace(/[（(][^）)\n]{12,260}[）)]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanRecentEventPromptText(chat: GroupChat, text: string) {
  const compact = compactPromptText(text, 180);
  if (chat.sessionKind?.scenarioId === 'story-reader') return compact;
  return stripLongStageAsidesForPrompt(compact) || compactPromptText(text.replace(/[（(]/g, '').replace(/[）)]/g, ''), 180);
}

function buildManualMemorySeedPrompt(character: AICharacter, members: DisplayTextMember[], chat?: GroupChat) {
  if (chat?.type === 'group' && resolveSessionFamilyKey(chat) === 'conversation') return '';
  const memory = character.memory;
  if (!memory) return '';
  const canExposeUserMemoryText = !chat || chat.type === 'direct';
  const mindOwnsAuthoredContinuity = chat ? usesMindOwnedConversationContract(chat) : false;
  const hasUserMemory = Boolean(memory.userMemories?.length);
  const lines = [
    !mindOwnsAuthoredContinuity && memory.shortTermSummary?.trim() ? `- Current private summary: ${cleanPromptText(memory.shortTermSummary, members)}` : '',
    !mindOwnsAuthoredContinuity && memory.longTerm?.length ? `- Stable long-term memories: ${memory.longTerm.slice(-6).map((item) => cleanPromptText(item, members, 160)).join(' / ')}` : '',
    memory.secrets?.length ? `- Private secrets you know but should not reveal casually: ${memory.secrets.slice(-6).map((item) => cleanPromptText(item, members, 160)).join(' / ')}` : '',
    !mindOwnsAuthoredContinuity && memory.obsessions?.length ? `- Obsessions that may leak into your attention and wording: ${memory.obsessions.slice(-6).map((item) => cleanPromptText(item, members, 160)).join(' / ')}` : '',
    !mindOwnsAuthoredContinuity && memory.tabooTopics?.length ? `- Taboo or sensitive topics that trigger avoidance, defensiveness, or careful wording: ${memory.tabooTopics.slice(-6).map((item) => cleanPromptText(item, members, 160)).join(' / ')}` : '',
    !mindOwnsAuthoredContinuity && canExposeUserMemoryText && hasUserMemory ? `- Memories about the user: ${memory.userMemories.slice(-6).map((item) => cleanPromptText(item, members, 160)).join(' / ')}` : '',
    !mindOwnsAuthoredContinuity && !canExposeUserMemoryText && hasUserMemory ? `- Private user continuity exists but this is not a pair-private channel. Let it shape restraint and care; do not expose the underlying user facts.` : '',
  ].filter(Boolean);
  if (!lines.length) return '';
  return `\n## Manual Memory Seeds\n${lines.join('\n')}\n- Treat these as authored character continuity. Let them shape tone, attention, omissions, and reactions; do not list them unless the conversation naturally calls for it.`;
}

function buildConstrainedMemoryCueLine(cue: ConstrainedMemoryCue, members: DisplayTextMember[]) {
  const text = cleanPromptText(cue.text, members, 180);
  const rule = cleanPromptText(cue.rule, members, 220);
  return `- ${text}${rule ? `\n  Visible rule: ${rule}` : ''}`;
}

function buildConstrainedMemoryMindCueLines(cues: ConstrainedMemoryCue[], members: DisplayTextMember[]) {
  return cues
    .map((cue) => {
      const text = cleanPromptText(cue.text, members, 180);
      const rule = cleanPromptText(cue.rule, members, 220);
      return [text, rule ? `Visible rule: ${rule}` : ''].filter(Boolean).join(' | ');
    })
    .filter(Boolean);
}

function buildRecallCue(messages: Message[], target?: AICharacter | null) {
  const recentText = messages
    .filter((item) => !item.isDeleted && item.type !== 'system' && item.type !== 'event')
    .slice(-4)
    .map((item) => item.content)
    .join('\n');
  return [target?.name, recentText].filter(Boolean).join('\n').slice(-900);
}

function collectRecentPromptMemoryUseIds(messages: Message[], limit = 8) {
  const ids = new Set<string>();
  messages
    .filter((item) => !item.isDeleted)
    .slice(-limit)
    .forEach((message) => {
      (message.metadata?.runtimeDecision?.memoryContext?.injectedIds || [])
        .filter(Boolean)
        .forEach((id) => ids.add(id));
    });
  return [...ids];
}

function buildGroupMemoryPolicyTags() {
  return {
    preferred: ['llm_memory_objective_event', 'llm_memory_relationship_imprint', 'llm_memory_emotion_effect', 'llm_memory_growth_signal', 'group_relationship_shift', COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG, 'interaction', 'relationship_delta', 'room_shift', 'private_thread_effect', 'private_thread_summary'],
    blocked: ['direct_user_message', 'direct_ai_follow_up', 'ai_direct_starter_message', 'ai_direct_target_message'],
  };
}

function buildGroupCharacterPolicyTags() {
  return {
    preferred: ['expression_feedback', 'llm_memory_character_perspective', 'llm_memory_relationship_imprint', 'llm_memory_emotion_effect', 'llm_memory_growth_signal', 'group_relationship_shift', COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG, 'self_expression'],
    allowed: ['expression_feedback', 'llm_memory_character_perspective', 'llm_memory_relationship_imprint', 'llm_memory_emotion_effect', 'llm_memory_growth_signal', 'group_relationship_shift', COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG, 'self_expression', 'core_profile', 'background', 'speaking_style', 'expertise'],
    blocked: ['direct_user_message', 'direct_ai_follow_up'],
  };
}

function buildRetrievalBoosts(chat: GroupChat) {
  if (chat.type === 'direct') return { relationshipBoost: true, selfMemoryBoost: true, conversationBoost: false };
  if (chat.type === 'ai_direct') return { relationshipBoost: true, selfMemoryBoost: true, conversationBoost: true };
  return { relationshipBoost: true, selfMemoryBoost: true, conversationBoost: true };
}

function archivedRecallLimit(limit: number) {
  return Math.max(1, Math.floor(limit / 2));
}

function sharedAnchorMemoryKind(kind: SharedMemoryAnchor['kind']): MemoryItem['kind'] {
  if (kind === 'conflict') return 'conflict';
  if (kind === 'repair' || kind === 'first_time' || kind === 'confession' || kind === 'inside_joke' || kind === 'promise' || kind === 'milestone') return 'bond';
  if (kind === 'shared_secret') return 'artifact';
  return 'bond';
}

function sharedAnchorToPromptMemory(anchor: SharedMemoryAnchor, character: AICharacter, chat: GroupChat): MemoryItem | null {
  if (!anchor.participantIds.includes(character.id)) return null;
  if (anchor.kind === 'shared_secret') return null;
  const salience = Math.max(0.25, Math.min(1, anchor.salience / 100));
  const confidence = Math.max(0.25, Math.min(1, anchor.confidence / 100));
  const recency = Math.max(0.2, Math.min(1, (anchor.updatedAt || chat.updatedAt || Date.now()) / Math.max(Date.now(), 1)));
  return {
    id: `companionship-anchor-memory-${anchor.id}`,
    ownerId: character.id,
    scope: 'relationship',
    layer: anchor.source === 'runtime_event' ? 'episodic' : 'long_term',
    kind: sharedAnchorMemoryKind(anchor.kind),
    subjectIds: anchor.participantIds.filter((id) => id !== character.id),
    relatedConversationId: chat.id,
    text: anchor.text,
    summary: `${anchor.title}: ${anchor.text}`,
    evidenceText: anchor.evidence,
    salience,
    confidence,
    recency,
    reinforcementCount: Math.max(1, Math.round(anchor.salience / 35)),
    sourceEventIds: anchor.sourceId ? [anchor.sourceId] : [],
    sourceTag: COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG,
    subjectOwner: 'target',
    privacyRisk: 0.55,
    visibility: 'pair_private',
    validity: 'active',
    origin: anchor.source === 'runtime_event' ? 'runtime' : 'distilled',
    distilledFromIds: anchor.sourceId ? [anchor.sourceId] : [],
    distilledAt: anchor.source === 'runtime_event' ? null : anchor.updatedAt || null,
    distillationVersion: null,
    createdAt: anchor.createdAt || chat.createdAt || 0,
    updatedAt: anchor.updatedAt || chat.updatedAt || 0,
    archivedAt: null,
  };
}

function buildCompanionshipAnchorPromptMemories(character: AICharacter, chat: GroupChat): MemoryItem[] {
  return buildSharedMemoryAnchors(character, chat.updatedAt || Date.now(), chat)
    .map((anchor) => sharedAnchorToPromptMemory(anchor, character, chat))
    .filter((item): item is MemoryItem => Boolean(item));
}

function userProfileMemoryKind(item: UserProfileMemoryEventItem): MemoryItem['kind'] {
  if (item.kind === 'boundary' || item.kind === 'dislike') return 'taboo';
  if (item.kind === 'emotional_pattern' || item.kind === 'pressure_source') return 'status_shift';
  if (item.kind === 'address_preference' || item.kind === 'display_name') return 'bond';
  return 'trait_evidence';
}

function userProfileKindLabel(kind: UserProfileMemoryKind) {
  const labels: Record<UserProfileMemoryKind, string> = {
    display_name: 'display name',
    address_preference: 'address preference',
    schedule_hint: 'schedule',
    pressure_source: 'pressure source',
    preference: 'preference',
    dislike: 'dislike',
    boundary: 'boundary',
    important_date: 'important date',
    recent_plan: 'recent plan',
    emotional_pattern: 'emotional pattern',
  };
  return labels[kind];
}

function userProfileEventItemKey(item: Pick<UserProfileMemoryEventItem, 'kind' | 'text'>) {
  return `${item.kind}:${compactPromptText(item.text, 140)}`;
}

function userProfileEventItemsMatch(left: Pick<UserProfileMemoryEventItem, 'kind' | 'text'>, right: Pick<UserProfileMemoryEventItem, 'kind' | 'text'>) {
  if (left.kind !== right.kind) return false;
  const leftText = compactPromptText(left.text, 140);
  const rightText = compactPromptText(right.text, 140);
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  if (leftText.length >= 6 && rightText.length >= 6) return leftText.includes(rightText) || rightText.includes(leftText);
  return false;
}

function normalizePromptSourceIds(...sources: Array<unknown>) {
  return sources
    .flatMap((source) => Array.isArray(source) ? source : [])
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    .map((id) => id.trim())
    .filter((id, index, list) => list.indexOf(id) === index)
    .slice(0, 8);
}

function collectUserProfilePromptItems(chat: GroupChat, character: AICharacter) {
  const byKey = new Map<string, UserProfileMemoryEventItem & { updatedAt: number; sourceEventIds: string[] }>();
  (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .forEach((event) => {
      const payload = userProfileMemoryPayloadOf(event);
      if (!payload || payload.characterId !== character.id || (payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(character.id) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(character.id) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return;
      payload.items.forEach((item) => {
        const text = compactPromptText(item.text, 140);
        if (!text || item.confidence < 0.6) return;
        const resolved = {
          ...item,
          text,
          evidence: compactPromptText(item.evidence || event.summary, 140),
          sourceMessageIds: normalizePromptSourceIds(item.sourceMessageIds, payload.sourceMessageIds, event.evidenceMessageIds),
          updatedAt: event.createdAt || chat.updatedAt || 0,
          sourceEventIds: normalizePromptSourceIds([event.id]),
        };
        if (payload.action === 'revoke') {
          Array.from(byKey.entries()).forEach(([key, active]) => {
            if (userProfileEventItemsMatch(active, resolved)) byKey.delete(key);
          });
          return;
        }
        byKey.set(userProfileEventItemKey(resolved), resolved);
      });
    });
  return Array.from(byKey.values())
    .sort((left, right) => {
      const leftSensitiveBoost = left.sensitive ? 0.08 : 0;
      const rightSensitiveBoost = right.sensitive ? 0.08 : 0;
      return (right.confidence + rightSensitiveBoost) - (left.confidence + leftSensitiveBoost) || right.updatedAt - left.updatedAt;
    })
    .slice(0, 8);
}

function userProfileItemToPromptMemory(item: UserProfileMemoryEventItem & { updatedAt: number; sourceEventIds: string[] }, character: AICharacter, chat: GroupChat): MemoryItem {
  const confidence = Math.max(0.25, Math.min(1, item.confidence > 1 ? item.confidence / 100 : item.confidence));
  const salience = Math.max(0.35, Math.min(1, confidence + (item.sensitive ? 0.18 : 0)));
  return {
    id: `companionship-user-profile-memory-${character.id}-${userProfileEventItemKey(item).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80)}`,
    ownerId: character.id,
    scope: 'relationship',
    layer: item.sensitive || item.kind === 'boundary' || item.kind === 'important_date' ? 'long_term' : 'working',
    kind: userProfileMemoryKind(item),
    subjectIds: [USER_ACTOR_ID],
    relatedConversationId: chat.id,
    text: item.text,
    summary: `${userProfileKindLabel(item.kind)}: ${item.text}`,
    evidenceText: item.evidence,
    salience,
    confidence,
    recency: 1,
    reinforcementCount: item.sensitive ? 2 : 1,
    sourceEventIds: item.sourceEventIds,
    sourceTag: COMPANIONSHIP_USER_PROFILE_SOURCE_TAG,
    subjectOwner: 'user',
    privacyRisk: item.sensitive ? 0.8 : 0.55,
    visibility: 'private',
    validity: 'active',
    origin: 'runtime',
    distilledFromIds: item.sourceEventIds,
    distilledAt: null,
    distillationVersion: null,
    createdAt: item.updatedAt,
    updatedAt: item.updatedAt,
    archivedAt: null,
  };
}

function buildCompanionshipUserProfilePromptMemories(character: AICharacter, chat: GroupChat): MemoryItem[] {
  if (chat.type !== 'direct') return [];
  return collectUserProfilePromptItems(chat, character).map((item) => userProfileItemToPromptMemory(item, character, chat));
}

function buildPromptMemoryPolicies(chat: GroupChat) {
  if (chat.type === 'direct') {
    return {
      conversation: { preferred: ['direct_user_message', 'direct_ai_follow_up'], allowed: ['direct_user_message', 'direct_ai_follow_up'], blocked: ['ai_direct_starter_message', 'ai_direct_target_message'] },
      character: { preferred: ['expression_feedback', 'llm_memory_character_perspective', 'llm_memory_relationship_imprint', 'llm_memory_emotion_effect', 'llm_memory_growth_signal', COMPANIONSHIP_USER_PROFILE_SOURCE_TAG, COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG, 'direct_user_message', 'direct_ai_follow_up', 'self_expression'], allowed: ['expression_feedback', 'direct_user_message', 'direct_ai_follow_up', COMPANIONSHIP_USER_PROFILE_SOURCE_TAG, COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG, 'self_expression', 'core_profile', 'background', 'speaking_style', 'expertise', 'llm_memory_character_perspective', 'llm_memory_relationship_imprint', 'llm_memory_emotion_effect', 'llm_memory_growth_signal'], blocked: ['ai_direct_starter_message', 'ai_direct_target_message'] },
    };
  }
  if (chat.type === 'ai_direct') {
    return {
      conversation: { preferred: ['ai_direct_starter_message', 'ai_direct_target_message'], allowed: ['ai_direct_starter_message', 'ai_direct_target_message'], blocked: ['direct_user_message', 'direct_ai_follow_up'] },
      character: { preferred: ['expression_feedback', 'llm_memory_character_perspective', 'llm_memory_relationship_imprint', 'llm_memory_emotion_effect', 'llm_memory_growth_signal', COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG, 'ai_direct_starter_message', 'ai_direct_target_message', 'group_relationship_shift'], allowed: ['expression_feedback', 'ai_direct_starter_message', 'ai_direct_target_message', COMPANIONSHIP_SHARED_ANCHOR_SOURCE_TAG, 'group_relationship_shift', 'core_profile', 'background', 'speaking_style', 'expertise', 'llm_memory_character_perspective', 'llm_memory_relationship_imprint', 'llm_memory_emotion_effect', 'llm_memory_growth_signal'], blocked: ['direct_user_message', 'direct_ai_follow_up'] },
    };
  }
  const group = { conversation: buildGroupMemoryPolicyTags(), character: buildGroupCharacterPolicyTags() };
  return {
    conversation: { preferred: group.conversation.preferred, allowed: undefined, blocked: group.conversation.blocked },
    character: { preferred: group.character.preferred, allowed: group.character.allowed, blocked: group.character.blocked },
  };
}

function buildMergedMemories(items: MemoryItem[]) {
  return items.filter((item, index, array) => {
    const key = `${item.scope}:${item.kind}:${item.layer}:${item.text}`;
    return array.findIndex((candidate) => `${candidate.scope}:${candidate.kind}:${candidate.layer}:${candidate.text}` === key) === index;
  });
}

function buildPromptMemoryTitle(chat: GroupChat) {
  return chat.type === 'direct' ? 'Private-Channel Memories' : chat.type === 'ai_direct' ? 'Pair-Thread Memories' : 'Group-Influenced Memories';
}

function buildPromptMemoryBundle(chat: GroupChat, conversationMemories: MemoryItem[], characterMemories: MemoryItem[], targetedCharacterMemories: MemoryItem[], members: DisplayTextMember[], cues: ConstrainedMemoryCue[]) {
  const merged = buildMergedMemories([...targetedCharacterMemories, ...characterMemories, ...conversationMemories]);
  if (!cues.length) {
    return merged.length
      ? `\n## ${buildPromptMemoryTitle(chat)}\n- Candidate memories exist, but none are relevant or safe enough to surface this turn. Do not invent prior user facts or quote memory contents.`
      : '';
  }
  return `\n## ${buildPromptMemoryTitle(chat)}\n- Use only the constrained cues below. Relevance decides whether they affect this turn; do not expose raw memory text outside these rules.\n${cues.map((cue) => buildConstrainedMemoryCueLine(cue, members)).join('\n')}`;
}

function buildInfluenceModePrompt(chat: GroupChat, target: AICharacter | undefined) {
  if (usesMindOwnedConversationContract(chat)) return '';
  if (chat.type === 'direct') {
    return '\n## Influence Mode\n- In this user-private chat, let your own long-term self-model, relationship stance, and recent personal drift outweigh room-level context.';
  }
  if (chat.type === 'ai_direct') {
    return `\n## Influence Mode\n- In this AI private thread, prioritize your evolving stance toward ${target?.name || 'the other AI'}, reciprocal relationship memory, and pair-specific carryover over generic room balance.`;
  }
  return '\n## Influence Mode\n- In group chat, balance room context with your own biases: react locally to the latest exchange, but let long-term relationship and self-memory bend your tone and alliances.';
}

function hasMeaningfulRelationshipSnapshot(relationshipSnapshot: AICharacter['relationships'][number] | null) {
  if (!relationshipSnapshot) return false;
  return Math.max(
    Math.abs(relationshipSnapshot.warmth || 0),
    Math.abs(relationshipSnapshot.competence || 0),
    Math.abs(relationshipSnapshot.trust || 0),
    Math.abs(relationshipSnapshot.threat || 0),
  ) >= 10 || Boolean(relationshipSnapshot.note?.trim());
}

function buildRelationshipAxisPull(relationshipSnapshot: AICharacter['relationships'][number] | null) {
  if (!relationshipSnapshot) return '';
  const axes = [
    { key: 'warmth', value: relationshipSnapshot.warmth || 0, pull: relationshipSnapshot.warmth >= 10 ? 'soften, protect, or give benefit of doubt' : relationshipSnapshot.warmth <= -10 ? 'withhold warmth or keep distance' : '' },
    { key: 'trust', value: relationshipSnapshot.trust || 0, pull: relationshipSnapshot.trust >= 10 ? 'coordinate or disclose more readily' : relationshipSnapshot.trust <= -10 ? 'verify, hedge, or avoid relying on them' : '' },
    { key: 'competence', value: relationshipSnapshot.competence || 0, pull: relationshipSnapshot.competence >= 10 ? 'treat their judgment as more credible' : relationshipSnapshot.competence <= -10 ? 'challenge their judgment more easily' : '' },
    { key: 'threat', value: relationshipSnapshot.threat || 0, pull: relationshipSnapshot.threat >= 10 ? 'guard, probe, deflect, or push back' : '' },
  ].filter((axis) => axis.pull);
  if (!axes.length) return '';
  return axes
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((axis) => `${axis.key} ${axis.value}: ${axis.pull}`)
    .join('; ');
}

function extractMindAdapterHookLines(adapter: CharacterMindPromptAdapterOutput | undefined, members: DisplayTextMember[]) {
  if (!adapter) return [];
  return [
    adapter.coreContinuityBlock,
    adapter.currentRoomBlock,
  ]
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line && !line.startsWith('##'))
    .filter((line) => /Stance toward|User continuity|Relationship continuity|Shared history/.test(line))
    .map((line) => cleanPromptText(line, members, 100))
    .filter(Boolean);
}

function buildActiveContinuityPull(params: {
  chat: GroupChat;
  character: AICharacter;
  target: AICharacter | undefined;
  relationshipSnapshot: AICharacter['relationships'][number] | null;
  memoryCues?: ConstrainedMemoryCue[];
  characters: Map<string, AICharacter>;
  hasCompanionshipContext?: boolean;
  mind?: {
    projection: ReturnType<typeof buildCharacterMindProjection>;
    adapter: CharacterMindPromptAdapterOutput;
  } | null;
}) {
  if (usesMindOwnedConversationContract(params.chat)) return '';
  const members = buildPromptDisplayMembers(params.character, params.characters);
  const mindRecallHooks = params.mind?.adapter.visibleRecallInput
    .map((cue) => cleanPromptText(cue, members, 120))
    .filter(Boolean) || [];
  const memoryHooks = (mindRecallHooks.length ? mindRecallHooks : (params.memoryCues || [])
    .map((cue) => cleanPromptText(cue.text, members, 120)))
    .filter(Boolean);
  const relationPull = buildRelationshipAxisPull(params.relationshipSnapshot);
  const mindRelationshipHooks = extractMindAdapterHookLines(params.mind?.adapter, members);
  const influenceHooks = mindRelationshipHooks
    .map((item) => cleanPromptText(item, members, 80))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 4);
  const hasRelationship = hasMeaningfulRelationshipSnapshot(params.relationshipSnapshot);
  const hasMindContinuity = Boolean(
    params.mind?.projection.continuity.userProfile.length
    || params.mind?.projection.continuity.relationshipMemories.length
    || params.mind?.projection.continuity.sharedHistory.length,
  );
  const hasMemory = memoryHooks.length > 0 || influenceHooks.length > 0 || hasMindContinuity;
  if (!hasRelationship && !hasMemory && !params.hasCompanionshipContext) return '';

  const targetLine = params.target
    ? `- Active target: ${params.target.name}. If the latest exchange touches this person, answer through the relationship/memory stance first.`
    : params.chat.type === 'direct'
      ? '- Active target: the user in this private channel. Treat remembered user boundaries, care topics, and shared continuity as live context.'
      : '';
  const privacyLine = params.chat.type === 'group'
    ? '- In public group chat, use private continuity as subtext: timing, restraint, protection, avoidance, warmth, or careful wording. Do not expose private facts.'
    : '- In private or pair channels, direct recall is allowed when the user/partner naturally brings up the subject; still avoid dumping memory as a list.';
  const groupUserBoundaryLine = params.chat.type === 'group'
    ? '- If the current human line is the user, keep their remembered boundaries and care topics active even without naming them. Respond with restraint, support, or redirection rather than generic banter.'
    : '';
  return `\n## Active Continuity Pull
- Continuity cues below are active this turn, not archival decoration.
${targetLine}
${relationPull ? `- Relationship pull: ${relationPull}.` : ''}
${memoryHooks.length ? `- Active memory hooks: ${memoryHooks.join(' / ')}.` : ''}
${influenceHooks.length ? `- Current bias hooks: ${influenceHooks.join(' / ')}.` : ''}
${params.hasCompanionshipContext ? '- Companionship context is active. Let it alter tone, timing, omissions, care, address, or repair posture when relevant.' : ''}
- When the current line touches an active hook, the reply should visibly change stance, attention, wording, or omission because of it.
${privacyLine}
${groupUserBoundaryLine}
- Do not announce memory retrieval, relationship scores, phases, policies, or internal systems.`;
}

function buildRelationshipImpactText(target: AICharacter | undefined, relationshipSnapshot: AICharacter['relationships'][number] | null) {
  if (!target || !relationshipSnapshot) return '';
  const strongestAxis = [
    { label: 'warmth', value: relationshipSnapshot.warmth ?? 0 },
    { label: 'competence', value: relationshipSnapshot.competence ?? 0 },
    { label: 'trust', value: relationshipSnapshot.trust ?? 0 },
    { label: 'threat', value: relationshipSnapshot.threat ?? 0 },
  ].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
  const behavior = strongestAxis.label === 'threat'
    ? '更容易防备、质疑、顶回去'
    : strongestAxis.label === 'trust'
      ? '更容易配合、透露、替对方留余地'
      : strongestAxis.label === 'warmth'
        ? '更容易软化、维护、顺着说'
        : '更容易把对方当成可信判断来源';
  return `${target.name} · 主轴 ${strongestAxis.label} ${strongestAxis.value} · 倾向 ${behavior}`;
}

function buildSharedSecretPromptBlock(chat: GroupChat, character: AICharacter, target: AICharacter | undefined, characters: Map<string, AICharacter>) {
  const secrets = buildSharedSecrets(character, chat.updatedAt || Date.now(), chat)
    .filter((secret) => secret.participantIds.includes(character.id))
    .slice(0, 4);
  if (!secrets.length) return '';

  const members = buildPromptDisplayMembers(character, characters);
  if (chat.type === 'ai_direct' && target) {
    const privateSecrets = secrets
      .filter((secret) => secret.participantIds.includes(target.id))
      .slice(0, 2);
    if (!privateSecrets.length) return '';
    return `\n## Pair-Private Shared Secrets\n${privateSecrets.map((secret) => `- With ${target.name}: ${cleanPromptText(secret.privateText, members, 180)}${secret.leakState !== 'sealed' ? ` (state: ${secret.leakState})` : ''}`).join('\n')}\n- This is a pair-private thread: you may use these as subtext or recall them directly if it feels natural, but do not turn them into exposition.`;
  }

  if (chat.type !== 'group') return '';
  const visibleMemberIds = new Set(chat.memberIds || []);
  const publicMasks = secrets
    .filter((secret) => secret.participantIds.some((id) => visibleMemberIds.has(id)))
    .map((secret) => {
      const participantNames = secret.participantIds
        .filter((id) => id !== character.id)
        .map((id) => characters.get(id)?.name || cleanPromptText(id, members, 60))
        .filter(Boolean)
        .join('、');
      const leak = secret.leakState === 'sealed'
        ? 'sealed'
        : secret.leakState === 'hinted_publicly'
          ? 'already hinted'
          : 'already exposed';
      return `- ${participantNames ? `Around ${participantNames}: ` : ''}${cleanPromptText(secret.publicMask, members, 120)} (${leak}).`;
    })
    .slice(0, 3);
  if (!publicMasks.length) return '';
  return `\n## Public Shared-Secret Guard\n${publicMasks.join('\n')}\n- This is a public group room. Do not reveal privateText, exact evidence, or hidden details. Let the secret shape hesitation, glances, omissions, coded replies, topic changes, or protective deflection instead.`;
}

function buildSharedSecretTraceLines(chat: GroupChat, character: AICharacter, target: AICharacter | undefined, characters: Map<string, AICharacter>) {
  const secrets = buildSharedSecrets(character, chat.updatedAt || Date.now(), chat)
    .filter((secret) => secret.participantIds.includes(character.id))
    .slice(0, 4);
  if (!secrets.length) return [];
  const members = buildPromptDisplayMembers(character, characters);
  if (chat.type === 'ai_direct' && target) {
    return secrets
      .filter((secret) => secret.participantIds.includes(target.id))
      .slice(0, 2)
      .map((secret) => `AI私聊可召回：${target.name} · ${cleanPromptText(secret.publicMask, members, 120)} · ${secret.leakState}`);
  }
  if (chat.type !== 'group') return [];
  const visibleMemberIds = new Set(chat.memberIds || []);
  return secrets
    .filter((secret) => secret.participantIds.some((id) => visibleMemberIds.has(id)))
    .slice(0, 3)
    .map((secret) => `群聊避嫌：${cleanPromptText(secret.publicMask, members, 120)} · ${secret.leakState}`);
}

function buildConflictPromptBundle(chat: GroupChat, character: AICharacter, characters: Map<string, AICharacter>) {
  if (usesMindOwnedConversationContract(chat)) return '';
  const state = chat.worldState.conflictState;
  const primary = state?.primaryConflict;
  if (!primary) return '';
  const members = buildPromptDisplayMembers(character, characters);
  const participantNames = (primary.participantIds || []).map((id) => characters.get(id)?.name || cleanPromptText(id, members, 80) || '成员').join('、');
  const targetNames = (primary.targetIds || []).map((id) => characters.get(id)?.name || cleanPromptText(id, members, 80) || '成员').join('、');
  const involved = (primary.participantIds || []).includes(character.id) || (primary.targetIds || []).includes(character.id);
  const formatted = cleanPromptText(formatConflictPromptText(primary.type, primary.nextPressure, primary.developmentHooks), members, 260);
  const summary = cleanPromptText(primary.summary, members, 220);
  const intensity = primary.severity >= 0.78 ? 'high'
    : primary.severity >= 0.55 ? 'medium'
      : 'low';
  return `\n## Active Conflict\n- Stage: ${formatConflictStageLabel(primary.stage)}\n- Intensity: ${intensity}\n- Summary: ${summary}${participantNames ? `\n- Participants: ${participantNames}` : ''}${targetNames ? `\n- Targets: ${targetNames}` : ''}${formatted ? `\n${formatted}` : ''}${involved ? '\n- You are directly implicated in this contradiction; react from your position inside it, not as a neutral commentator.' : '\n- Even if you are not central, the room tension should subtly shape what you choose to notice, support, dodge, or escalate.'}`;
}

function buildPromptInfluenceContext(chat: GroupChat, character: AICharacter, target: AICharacter | undefined, characters: Map<string, AICharacter>) {
  return `${buildInfluenceModePrompt(chat, target)}${buildConflictPromptBundle(chat, character, characters)}`;
}

function buildChatInfluenceSummary(chat: GroupChat) {
  if (usesMindOwnedConversationContract(chat)) return '';
  if (chat.type === 'direct') return '\n## Channel Bias\n- This is a private user-facing channel: intimacy, continuity, and personal stance matter more than room theatrics.\n- The latest User line is what you are answering. Do not output it as your own line unless the user explicitly asked you to repeat or quote it.';
  if (chat.type === 'ai_direct') return '\n## Channel Bias\n- This is a pair-private AI thread: reciprocal dynamics and unfinished tension between the pair matter more than group consensus.';
  return '\n## Channel Bias\n- This is a public group room: local momentum, alliances, pressure, and contradiction shape what feels natural to say next.';
}

function buildPromptReasoningBias(chat: GroupChat) {
  if (usesMindOwnedConversationContract(chat)) return '';
  if (chat.type === 'direct') return '\n## Reasoning Bias\n- Answer from lived continuity and personal stance first; do not reconstruct a public-room transcript unless it is genuinely necessary.';
  if (chat.type === 'ai_direct') return '\n## Reasoning Bias\n- Think through the pair history first; prioritize what the other AI means to you over generic topic analysis.';
  return '\n## Reasoning Bias\n- Think like someone inside an unfolding room dynamic: react to contradiction, tone shifts, and alliances before abstract synthesis.';
}

function buildPromptReasoningSummary(chat: GroupChat) {
  return `${buildPromptReasoningBias(chat)}${buildChatInfluenceSummary(chat)}`;
}

function buildMemoryPriorityPrompt(chat: GroupChat) {
  if (usesMindOwnedConversationContract(chat)) return '';
  if (chat.type === 'direct') return '\n## Memory Priority\n- Priority: self-memory and relationship-memory first, direct-thread continuity second, public-room carryover last.';
  if (chat.type === 'ai_direct') return '\n## Memory Priority\n- Priority: pair relationship memory first, pair-thread continuity second, general self-model third.';
  return '\n## Memory Priority\n- Priority: local room context first, then relationship memory and self bias, then older background memory.';
}

function mapVisibleMemoryRecallSetting(): VisibleMemoryRecallSetting {
  const config = getChatMemoryRuntimeConfig();
  if (!config.enabled || config.maxCuesPerTurn <= 0) return 'off';
  return config.visibleRecallMode === 'implicit' ? 'implicit' : 'natural';
}

function buildCharacterMindAdapterOutput(character: AICharacter, chat: GroupChat, messages: Message[], characters: Map<string, AICharacter>, target?: AICharacter, memoryCandidates?: MemoryItem[], visibleRecallCues?: string[], options: { summarizeUserContinuity?: boolean } = {}) {
  const chatMemoryConfig = getChatMemoryRuntimeConfig();
  const isOrdinaryGroup = chat.type === 'group' && resolveSessionFamilyKey(chat) === 'conversation';
  const projection = buildCharacterMindProjection({
    chat,
    character,
    characters: Array.from(characters.values()),
    messages,
    target: target ? { id: target.id, name: target.name } : isOrdinaryGroup ? null : undefined,
    memoryCandidates,
    now: chat.updatedAt || Date.now(),
  });
  const adapter = adaptCharacterMindProjectionForPrompt(projection, {
    chatType: chat.type,
    visibleMemoryRecall: mapVisibleMemoryRecallSetting(),
    visibleRecallCues,
    summarizeUserContinuity: options.summarizeUserContinuity,
    maxRecallCues: chatMemoryConfig.maxCuesPerTurn,
    maxCoreLines: isOrdinaryGroup ? 7 : usesMindOwnedConversationContract(chat) ? 9 : 6,
    maxRoomLines: 5,
    includeActiveRoomLineSummaries: false,
    includeRoomTopic: false,
    includeExpressionGuidance: !usesUnifiedOrdinaryGroupTurnContract(chat),
    renderVisibleRecallCues: isOrdinaryGroup,
  });
  return { projection, adapter };
}

function buildPromptCharacterMindTraceFromOutput(
  projection: ReturnType<typeof buildCharacterMindProjection>,
  adapter: CharacterMindPromptAdapterOutput,
): PromptCharacterMindTrace {
  return {
    visibility: adapter.trace.visibility,
    visibleMemoryRecall: adapter.trace.visibleMemoryRecall,
    memorySource: projection.hidden.memorySource,
    targetActorId: projection.relationship.targetId,
    targetActorName: projection.relationship.targetName,
    omittedPrivateContinuity: adapter.trace.omittedPrivateContinuity,
    omittedRawRoomLines: adapter.trace.omittedRawRoomLines,
    coreLineCount: adapter.coreContinuityBlock ? adapter.coreContinuityBlock.split('\n').filter((line) => line.startsWith('- ')).length : 0,
    roomLineCount: adapter.currentRoomBlock ? adapter.currentRoomBlock.split('\n').filter((line) => line.startsWith('- ')).length : 0,
    recallCueCount: adapter.visibleRecallInput.length,
    hasUserContinuity: projection.continuity.userProfile.length > 0,
    hasRelationshipContinuity: projection.continuity.relationshipMemories.length > 0,
    hasSharedHistory: projection.continuity.sharedHistory.length > 0,
    hasWorldContext: projection.room.activeLines.length > 0 || projection.room.worldActivities.length > 0,
  };
}

function buildPromptMemorySection(chat: GroupChat, character: AICharacter, conversationMemories: MemoryItem[], characterMemories: MemoryItem[], targetedCharacterMemories: MemoryItem[], target: AICharacter | undefined, relationshipSnapshot: AICharacter['relationships'][number] | null, characters: Map<string, AICharacter>, cueText = '', hasCompanionshipContext = false, recentMemoryUseIds: string[] = [], mind: ReturnType<typeof buildCharacterMindAdapterOutput> | null = null) {
  const merged = buildMergedMemories([...targetedCharacterMemories, ...characterMemories, ...conversationMemories]);
  const members = buildPromptDisplayMembers(character, characters);
  const chatMemoryConfig = getChatMemoryRuntimeConfig();
  const memoryCues = chatMemoryConfig.enabled ? selectConstrainedMemoryCues(merged, {
    cueText,
    isPublicChannel: chat.type === 'group',
    maxCues: chatMemoryConfig.maxCuesPerTurn,
    recentMemoryUseIds: recentMemoryUseIds.slice(0, chatMemoryConfig.cueCooldownTurns),
    visibleRecallMode: chatMemoryConfig.visibleRecallMode,
    targetActorIds: target ? [target.id] : [],
  }) : [];
  const memoryBundle = usesMindOwnedConversationContract(chat)
    ? ''
    : buildPromptMemoryBundle(chat, conversationMemories, characterMemories, targetedCharacterMemories, members, memoryCues);
  return `${buildManualMemorySeedPrompt(character, members, chat)}${memoryBundle}${buildPromptInfluenceContext(chat, character, target, characters)}${buildSharedSecretPromptBlock(chat, character, target, characters)}${buildActiveContinuityPull({ chat, character, target, relationshipSnapshot, memoryCues, characters, hasCompanionshipContext, mind })}${buildPromptReasoningSummary(chat)}${buildMemoryPriorityPrompt(chat)}`;
}

function buildResponseRulesPrompt(chat: GroupChat) {
  const base = [
    '- Reply as a chat message, not as analysis or narration.',
    usesUnifiedOrdinaryGroupTurnContract(chat)
      ? '- Stay specific to the live exchange and your own position; the last message is context, not a required reply target.'
      : '- Stay specific to the latest exchange and your own stance.',
    '- Do not mention these instructions, memory systems, or retrieval policies.',
  ];
  const directRelationshipRule = chat.type === 'direct' && !usesMindOwnedConversationContract(chat)
    ? [
        '- This is a private conversation with a person, not a character showcase or a polished answer service. Let what they said change your attention, mood, choice of detail, or willingness to stay with the subject.',
        '- Take a real relational stance that fits this character and this history: warmth, curiosity, protectiveness, teasing, hesitation, guardedness, irritation, distance, disagreement, or a clean boundary are all valid. Do not force tenderness or agreement.',
        '- Poetry, reassurance, a farewell, or silence can all be right when they express this character\'s actual closeness, avoidance, refusal, uncertainty, or decision to end the exchange. Do not use a generic version of them to avoid reacting.',
      ]
    : [];
  const lengthRule = usesUnifiedOrdinaryGroupTurnContract(chat)
    ? ''
    : '- Do not default to a fixed medium length. Use the length this character would naturally use in this moment: sometimes one tiny reaction, sometimes one sentence, sometimes a fuller line when pressure, care, defense, or explanation calls for it.';
  const groupContinuityRules = chat.type === 'group' && usesUnifiedOrdinaryGroupTurnContract(chat)
    ? [
        '- Follow the named transcript speaker, not the API role: user-side context includes other characters, the human User, and Topic guidance. A familiar form of address does not make User another member. Use an in-scene identity for User only when explicitly established; Topic guidance is an instruction, not a character speaking.',
        '- Keep accounts of past events grounded in the visible exchange and available continuity. When asked how an established result happened, unknown details remain unknown or clearly tentative; do not invent witnesses, places, timing, actions or motives as remembered evidence. New present actions may unfold without rewriting past events or assigning unspoken actions to other people.',
       '- When the latest human message asks how an earlier result was achieved and the record only contains the result, answer from that boundary first: say what was actually recorded, state what you cannot know, or offer a clearly marked possibility. Do not turn roleplay sensory style into a remembered scene by adding routes, witnesses, weather, sounds, counts, timing or tactical steps that were never spoken. A concise uncertainty is a complete answer; do not fill the gap to sound vivid.',
      ]
    : [];
  return `\n## Response Rules\n${[...base, ...groupContinuityRules, ...directRelationshipRule, lengthRule].filter(Boolean).join('\n')}`;
}

function traceMemoryItem(item: MemoryItem, members: DisplayTextMember[]): PromptMemoryTraceItem {
  return {
    id: item.id,
    scope: item.scope,
    kind: item.kind,
    layer: item.layer,
    summary: cleanPromptText(item.summary || item.text, members, 160),
    recallReason: item.recallReason ? cleanPromptText(item.recallReason, members, 160) : undefined,
    recallTokens: item.recallTokens?.map((token) => cleanPromptText(token, members, 48)).filter(Boolean).slice(0, 6),
    recallScore: typeof item.recallScore === 'number' ? Number(item.recallScore.toFixed(3)) : undefined,
  };
}

function buildTraceFromPromptMemories(items: MemoryItem[], members: DisplayTextMember[], sharedSecretGuards: string[], target?: { actorId: string; actorName: string; reason: string }, cues?: ConstrainedMemoryCue[]): PromptMemoryTrace {
  const merged = buildMergedMemories(items);
  return {
    injectedIds: (cues || []).map((cue) => cue.id),
    recalledArchives: merged
      .filter((item) => item.archivedAt && item.recallReason)
      .map((item) => traceMemoryItem(item, members))
      .slice(0, 4),
    sharedSecretGuards: sharedSecretGuards.slice(0, 4),
    targetActorId: target?.actorId,
    targetActorName: target?.actorName ? cleanPromptText(target.actorName, members, 80) : undefined,
    targetReason: target?.reason ? cleanPromptText(target.reason, members, 120) : undefined,
  };
}

function resolvePromptMemoryContext(character: AICharacter, chat: GroupChat, messages: Message[], characters: Map<string, AICharacter>, preferredTargetActorId?: string) {
  const targetResolution = resolvePromptTarget(chat, messages, characters, character, preferredTargetActorId);
  const target = targetResolution?.target;
  const relationshipSnapshot = getRelationshipSnapshot(character, chat, target);
  const policies = buildPromptMemoryPolicies(chat);
  const boosts = buildRetrievalBoosts(chat);
  const limits = getCurrentRetentionLimits();
  const allMemories = buildMergedMemories([
    ...(character.layeredMemories || []),
    ...buildCompanionshipAnchorPromptMemories(character, chat),
    ...buildCompanionshipUserProfilePromptMemories(character, chat),
  ]);
  const members = buildPromptDisplayMembers(character, characters);
  const recallCue = buildRecallCue(messages, target);
  const chatMemoryConfig = getChatMemoryRuntimeConfig();
  const recentMemoryUseIds = collectRecentPromptMemoryUseIds(messages, chatMemoryConfig.cueCooldownTurns);
  const conversationMemories = getMemoryContext(
    allMemories,
    character.id,
    null,
    chat.id,
    policies.conversation.preferred,
    policies.conversation.allowed,
    policies.conversation.blocked,
    boosts,
    recallCue,
    { maxItems: limits.chatLayeredMemories.recall, maxArchivedItems: archivedRecallLimit(limits.chatLayeredMemories.recall) },
  );
  const characterMemories = getMemoryContext(
    allMemories,
    character.id,
    null,
    chat.id,
    policies.character.preferred,
    policies.character.allowed,
    policies.character.blocked,
    boosts,
    recallCue,
    { maxItems: limits.characterLayeredMemories.recall, maxArchivedItems: archivedRecallLimit(limits.characterLayeredMemories.recall) },
  );
  const targetedCharacterMemories = target
    ? getMemoryContext(
      allMemories,
      character.id,
      target.id,
      chat.id,
      policies.character.preferred,
      policies.character.allowed,
      policies.character.blocked,
      boosts,
      recallCue,
      { maxItems: limits.characterLayeredMemories.recall, maxArchivedItems: archivedRecallLimit(limits.characterLayeredMemories.recall) },
    )
    : [];
  const mergedMemories = buildMergedMemories([...targetedCharacterMemories, ...characterMemories, ...conversationMemories]);
  const memoryCues = chatMemoryConfig.enabled ? selectConstrainedMemoryCues(mergedMemories, {
    cueText: recallCue,
    isPublicChannel: chat.type === 'group',
    maxCues: chatMemoryConfig.maxCuesPerTurn,
    recentMemoryUseIds,
    visibleRecallMode: chatMemoryConfig.visibleRecallMode,
    targetActorIds: target ? [target.id] : [],
  }) : [];
  return {
    target,
    relationshipSnapshot,
    conversationMemories,
    characterMemories,
    targetedCharacterMemories,
    recallCue,
    recentMemoryUseIds,
    memoryCues,
    trace: buildTraceFromPromptMemories(
      mergedMemories,
      members,
      buildSharedSecretTraceLines(chat, character, target, characters),
      target ? {
        actorId: target.id,
        actorName: target.name,
        reason: targetResolution.reason,
      } : undefined,
      memoryCues,
    ),
  };
}

export function buildPromptMemoryTrace(character: AICharacter, chat: GroupChat, messages: Message[], characters: Map<string, AICharacter>): PromptMemoryTrace {
  return resolvePromptMemoryContext(character, chat, messages, characters).trace;
}

function buildVisibleMindRecallCuesForPrompt(chat: GroupChat, character: AICharacter, characters: Map<string, AICharacter>, memoryCues: ConstrainedMemoryCue[]) {
  if (chat.type !== 'group' || resolveSessionFamilyKey(chat) !== 'conversation') return undefined;
  return buildConstrainedMemoryMindCueLines(memoryCues, buildPromptDisplayMembers(character, characters));
}

export function buildPromptCharacterMindTrace(character: AICharacter, chat: GroupChat, messages: Message[], characters: Map<string, AICharacter>): PromptCharacterMindTrace {
  const memoryContext = resolvePromptMemoryContext(character, chat, messages, characters);
  const memoryCandidates = buildMergedMemories([
    ...memoryContext.targetedCharacterMemories,
    ...memoryContext.characterMemories,
    ...memoryContext.conversationMemories,
  ]);
  const { projection, adapter } = buildCharacterMindAdapterOutput(
    character,
    chat,
    messages,
    characters,
    memoryContext.target,
    memoryCandidates,
    buildVisibleMindRecallCuesForPrompt(chat, character, characters, memoryContext.memoryCues),
  );
  return buildPromptCharacterMindTraceFromOutput(projection, adapter);
}

export function buildCrossModeMemoryPrompt(character: AICharacter, chat: GroupChat, messages: Message[], characters: Map<string, AICharacter>) {
  const memoryContext = resolvePromptMemoryContext(character, chat, messages, characters);
  const merged = buildMergedMemories([
    ...memoryContext.targetedCharacterMemories,
    ...memoryContext.characterMemories,
    ...memoryContext.conversationMemories,
  ]);
  const members = buildPromptDisplayMembers(character, characters);
  const companionshipPrompt = buildCompanionshipPromptBlock({ chat, character, messages });
  const renderedCompanionshipPrompt = chat.type === 'group' ? '' : companionshipPrompt;
  const mind = buildCharacterMindAdapterOutput(
    character,
    chat,
    messages,
    characters,
    memoryContext.target,
    merged,
    buildVisibleMindRecallCuesForPrompt(chat, character, characters, memoryContext.memoryCues),
    { summarizeUserContinuity: chat.type === 'direct' && Boolean(companionshipPrompt) },
  );
  const memoryBundle = usesMindOwnedConversationContract(chat)
    ? ''
    : buildPromptMemoryBundle(chat, memoryContext.conversationMemories, memoryContext.characterMemories, memoryContext.targetedCharacterMemories, members, memoryContext.memoryCues);
  return `${buildManualMemorySeedPrompt(character, members, chat)}${memoryBundle}${buildPromptInfluenceContext(chat, character, memoryContext.target, characters)}${buildSharedSecretPromptBlock(chat, character, memoryContext.target, characters)}${buildActiveContinuityPull({ chat, character, target: memoryContext.target, relationshipSnapshot: memoryContext.relationshipSnapshot, memoryCues: memoryContext.memoryCues, characters, hasCompanionshipContext: Boolean(companionshipPrompt), mind })}${mind.adapter.promptBlock}${renderedCompanionshipPrompt}${buildMemoryPriorityPrompt(chat)}`;
}

function buildTopicSection(chat: GroupChat) {
  const lines = [
    `- Topic: ${chat.topic || 'Open conversation'}`,
    `- Style: ${CHAT_STYLE_PROMPT_DESCRIPTIONS[chat.style]}`,
  ];
  if (chat.worldState.mood) lines.push(`- Room mood: ${chat.worldState.mood}`);
  if (chat.worldState.focus) lines.push(`- Current focus: ${chat.worldState.focus}`);
  if (chat.worldState.phase) lines.push(`- Current phase: ${chat.worldState.phase}`);
  if (chat.worldState.recentEvent) lines.push(`- Recent event: ${cleanRecentEventPromptText(chat, chat.worldState.recentEvent)}`);
  return `## Conversation Context\n${lines.join('\n')}`;
}

function buildCharacterSection(
  character: AICharacter,
  emotion: number,
  personaActivation: PersonaActivation,
  compactForUnifiedGroup = false,
  projectedMindValues: ReadonlySet<string> = new Set(),
) {
  const expertise = character.expertise?.length ? character.expertise.join(', ') : 'Generalist';
  if (compactForUnifiedGroup) {
    const core = character.coreProfile;
    const grounding = (label: string, value?: string) => value && !projectedMindValues.has(value)
      ? `- ${label}: ${value}`
      : '';
    const compactVoiceFingerprint = [
      ...(core?.expressionHabits || []).slice(0, 2).map((item) => grounding('Expression habits', item)),
      grounding('Conflict posture', core?.conflictStyle),
      grounding('Social mask', core?.socialMask),
      ...(core?.interactionHabits || []).slice(0, 2).map((item) => grounding('Interaction instinct', item)),
      grounding('What this person protects first', (core?.valuePriority || []).slice(0, 2).join(', ')),
      grounding('What makes them bristle', (core?.sensitivities || []).slice(0, 2).join(', ')),
    ].filter(Boolean);
    return [
      `You are ${character.name}. Read the room from this person's lived position; do not perform a character sheet.`,
      '',
      '## Character Grounding',
      grounding('Lived context', character.background),
      grounding('Habitual voice', character.speakingStyle),
      character.expertise?.length ? `- Familiar ground: ${expertise}` : '',
      ...compactVoiceFingerprint,
      compactVoiceFingerprint.length
        ? '- These voice fingerprints are differentiators, not lines to repeat. Let them alter what this person notices, avoids, concedes, jokes about, or refuses; do not announce the profile.'
        : '',
      '- These are causes of attention and judgment, not facts that every reply must mention. The Character Mind and current-turn frame below decide what is active now.',
    ].filter(Boolean).join('\n');
  }
  return [
    `You are ${character.name}. Stay in character through situated judgment, relationships, memory, limits, and voice.`,
    '',
    '## Character Background Reference',
    `- Background: ${character.background || 'No background provided.'}`,
    `- Speaking style: ${character.speakingStyle || 'Natural and conversational.'}`,
    `- Expertise: ${expertise}`,
    `- Current emotion intensity: ${emotion}`,
    '- Use this profile as private context. Do not make every reply prove the profile, profession, or label.',
    '- Explicitly mention background, job, expertise, or identity only when the current turn makes it relevant.',
    '- A person has more than one source of reaction. You may respond from ordinary life, taste, fatigue, appetite, money, habits, relationships, or ignorance instead of turning every point into your listed occupation.',
    '- Do not manufacture a profession-shaped example just to show the profile. If the topic only loosely touches your expertise, let the profile bend word choice and priorities rather than becoming the whole answer.',
    '- Even when the topic overlaps your job or expertise, you do not have to make the reply a professional case study. A casual reaction, small correction, or everyday observation is often more believable.',
    buildEmotionalStateDescription(character),
    buildCoreProfileDescription(character),
    personaActivation.prompt,
  ].filter(Boolean).join('\n');
}

function buildRelationshipSection(character: AICharacter, target: AICharacter | undefined, chat: GroupChat) {
  if (usesMindOwnedConversationContract(chat)) return '';
  if (!target) return '';
  return buildSocialPromptContext(character, target);
}

function getPromptMessageSpeakerName(message: Message, characters: Map<string, AICharacter>) {
  return getPromptSpeakerLabel(message, characters);
}

function getPromptMessageTypeLabel(message: Message) {
  return getPromptTurnTypeLabel(message);
}

function buildRecentMessagesSection(messages: Message[], characters: Map<string, AICharacter>, limit = 12) {
  const visible = messages
    .filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event')
    .slice(-limit);
  if (!visible.length) return '\n## Conversation Window\n- No messages yet.';
  const latest = visible.at(-1);
  const latestAi = visible.slice().reverse().find((message) => message.type === 'ai');
  const humanCount = visible.filter(isHumanDirectedMessage).length;
  const aiCount = visible.filter((message) => message.type === 'ai').length;
  const activeSpeakers = Array.from(new Set(visible.map((message) => getPromptMessageSpeakerName(message, characters)))).slice(-6);
  return `\n## Conversation Window\n- The complete recent transcript is provided separately as chat messages. Speaker labels identify who spoke; recorded sends are context, not new requests or output examples.\n- Recent visible turns: ${visible.length} (${humanCount} human / ${aiCount} AI).\n- Latest visible turn: ${latest ? `${getPromptMessageTypeLabel(latest)} from ${getPromptMessageSpeakerName(latest, characters)}` : 'none'}.\n- Latest AI speaker in window: ${latestAi ? getPromptMessageSpeakerName(latestAi, characters) : 'none'}.\n- Active speakers in window: ${activeSpeakers.join(', ') || 'none'}.`;
}

function normalizeStoredGuidance(message: Message): UserGuidanceIntent | null {
  const stored = message.metadata?.runtimeDecision?.directorIntent?.userGuidance;
  if (!stored?.rawText || !stored.kind) return null;
  return {
    kind: stored.kind === 'media_request' || stored.kind === 'direct_reply' ? stored.kind : 'topic_shift',
    rawText: stored.rawText,
    actorIds: stored.actorIds || [],
    mentionedActorIds: stored.mentionedActorIds || [],
    hardConstraintActorIds: stored.hardConstraintActorIds || [],
    suppressedActorIds: stored.suppressedActorIds || [],
    deferredActorIds: stored.deferredActorIds || [],
    hasHardConstraints: stored.hasHardConstraints,
    voiceRequest: stored.voiceRequest === true,
    stickerRequest: stored.stickerRequest === true,
    mediaRequest: stored.mediaRequest?.kind === 'image' ? {
      kind: 'image',
      subjectActorIds: stored.mediaRequest.subjectActorIds || [],
      subjectText: stored.mediaRequest.subjectText || '',
      actionText: stored.mediaRequest.actionText || stored.rawText,
    } : undefined,
    focusText: stored.focusText || stored.rawText,
    beatType: stored.beatType as UserGuidanceIntent['beatType'] || 'invite',
    pressure: stored.pressure || 0,
    maxTurns: stored.maxTurns || 1,
    minTargetTurns: stored.minTargetTurns,
    reason: stored.reason || '用户明确引导当前互动。',
  };
}

function parsePromptGuidance(message: Message, characters: Map<string, AICharacter>) {
  const members = Array.from(characters.values());
  return normalizeStoredGuidance(message) || readStoredUserGuidanceIntent(message, members);
}

function pickGuidanceTarget(guidance: UserGuidanceIntent, speaker: AICharacter, characters: Map<string, AICharacter>) {
  const candidateId = getGuidanceMemoryTargetActorIds(guidance, Array.from(characters.values()), speaker.id)[0];
  return candidateId ? characters.get(candidateId) : undefined;
}

function describeGuidanceMemoryTarget(guidance: UserGuidanceIntent) {
  if (guidance.kind === 'media_request') return '来自人工发图请求的图片对象';
  if (guidance.kind === 'direct_reply') return '来自人工点名中的被谈论对象';
  return '来自人工话题引导中提到的角色';
}

function resolveHumanGuidanceTarget(messages: Message[], characters: Map<string, AICharacter>, speaker: AICharacter) {
  const latestHumanMessage = messages
    .filter((item) => !item.isDeleted && isHumanDirectedMessage(item))
    .at(-1);
  if (!latestHumanMessage) return undefined;
  const guidance = parsePromptGuidance(latestHumanMessage, characters);
  if (!guidance) return undefined;
  const target = pickGuidanceTarget(guidance, speaker, characters);
  if (target) return { target, reason: describeGuidanceMemoryTarget(guidance) };
  if (guidance.suppressedActorIds?.length || guidance.actorIds.includes(speaker.id)) {
    return { target: undefined, reason: '人工点名没有可召回对象，禁止回退到旧发言者' };
  }
  return undefined;
}

function resolvePromptTarget(chat: GroupChat, messages: Message[], characters: Map<string, AICharacter>, speaker: AICharacter, preferredTargetActorId?: string) {
  const guidanceTarget = resolveHumanGuidanceTarget(messages, characters, speaker);
  if (guidanceTarget) return guidanceTarget;
  if (preferredTargetActorId && preferredTargetActorId !== speaker.id) {
    const preferredTarget = characters.get(preferredTargetActorId);
    if (preferredTarget) return { target: preferredTarget, reason: '来自本回合行为规划的当前对象' };
  }
  const latestVisible = messages.filter((item) => !item.isDeleted && item.type !== 'system' && item.type !== 'event').at(-1);
  if (chat.type === 'group' && usesUnifiedOrdinaryGroupTurnContract(chat)) {
    const latestAi = latestVisible?.type === 'ai' && latestVisible.senderId !== speaker.id ? latestVisible : undefined;
    const explicitlyAddressed = latestAi && [
      latestAi.primaryAddressedTargetId,
      ...(latestAi.addressedTargetIds || []),
      latestAi.primaryReplyDebtTargetId,
      ...(latestAi.replyDebtTargetIds || []),
    ].includes(speaker.id);
    const target = explicitlyAddressed ? characters.get(latestAi.senderId) : undefined;
    return { target, reason: target ? '来自上一条消息的明确指向' : '当前群聊没有明确人物检索对象' };
  }
  if (chat.type === 'direct') {
    return messages.filter((item) => !item.isDeleted).slice().reverse().find((item) => item.senderId !== speaker.id && item.type !== 'system' && item.type !== 'event')
      ? undefined
      : undefined;
  }
  const latestAi = messages
    .filter((item) => !item.isDeleted && item.senderId !== speaker.id && item.type === 'ai')
    .slice()
    .reverse()[0];
  if (!latestAi) return undefined;
  if (chat.type !== 'group') {
    const recentTarget = characters.get(latestAi.senderId);
    return recentTarget ? { target: recentTarget, reason: '来自最近 AI 发言者' } : undefined;
  }
  const addressedMessage = latestAi as Message & { addressedTargetIds?: string[] | null; primaryAddressedTargetId?: string | null };
  const addressedTargetIds = [
    addressedMessage.primaryAddressedTargetId,
    ...(addressedMessage.addressedTargetIds || []),
  ].filter(Boolean);
  const explicitlyAddressed = addressedTargetIds.includes(speaker.id);
  const recentTarget = characters.get(latestAi.senderId);
  return recentTarget ? { target: recentTarget, reason: explicitlyAddressed ? '来自上一条消息的明确指向' : '来自上一条消息的最近发言者' } : undefined;
}

function getAuthoredRelationshipSnapshot(character: AICharacter, target: AICharacter | undefined) {
  if (!target) return null;
  return character.relationships.find((item) => item.characterId === target.id) || null;
}

function getRelationshipSnapshot(character: AICharacter, chat: GroupChat, target: AICharacter | undefined) {
  const authored = getAuthoredRelationshipSnapshot(character, target);
  if (authored) return authored;
  if (!target) return null;
  const ledger = (chat.relationshipLedger || [])
    .map(normalizeRelationshipLedgerEntry)
    .find((entry) => entry.actorId === character.id && entry.targetId === target.id);
  if (!ledger) return null;
  return {
    characterId: target.id,
    warmth: ledger.current.warmth,
    competence: ledger.current.competence,
    trust: ledger.current.trust,
    threat: ledger.current.threat,
    attachment: ledger.current.attachment,
    deference: ledger.current.deference,
    note: ledger.derived?.semantic?.summary || '',
    updatedAt: ledger.lastUpdatedAt,
  };
}

function buildRelationalConsequencePrompt(params: {
  chat: GroupChat;
  character: AICharacter;
  characters: Map<string, AICharacter>;
  target?: AICharacter;
  relationshipSnapshot: AICharacter['relationships'][number] | null;
  mind: ReturnType<typeof buildCharacterMindAdapterOutput>;
}) {
  if (params.chat.type === 'group' && usesMindOwnedConversationContract(params.chat)) {
    const relationships = params.chat.memberIds
      .filter((id) => id !== params.character.id)
      .map((id) => params.characters.get(id))
      .filter((member): member is AICharacter => Boolean(member))
      .flatMap((member) => {
        const relationship = getRelationshipSnapshot(params.character, params.chat, member);
        if (!relationship) return [];
        return [`- ${params.character.name} toward ${member.name}: warmth ${relationship.warmth ?? 0}, competence ${relationship.competence ?? 0}, trust ${relationship.trust ?? 0}, threat ${relationship.threat ?? 0}, attachment ${relationship.attachment ?? 0}, deference ${relationship.deference ?? 0}.`];
      });
    const sharedFacts = (params.chat.relationshipStructure?.sharedFacts || [])
      .filter((fact) => fact.memberIds.includes(params.character.id))
      .map((fact) => fact.statement.trim())
      .filter(Boolean);
    if (!relationships.length && !sharedFacts.length) return '';
    return `\n## Member Relationship Context\n${relationships.join('\n')}\n${Array.from(new Set(sharedFacts)).map((fact) => `- Shared reality: ${fact}`).join('\n')}`;
  }
  if (!params.target) return '';
  const hasRelationshipEvidence = Boolean(params.relationshipSnapshot)
    || params.mind.projection.continuity.relationshipMemories.length > 0
    || params.mind.projection.relationship.stance.length > 0;
  if (!hasRelationshipEvidence) return '';
  const relationship = params.relationshipSnapshot;
  const sharedFacts = (params.chat.relationshipStructure?.sharedFacts || [])
    .filter((fact) => fact.memberIds.includes(params.character.id) && fact.memberIds.includes(params.target!.id))
    .map((fact) => fact.statement.trim())
    .filter(Boolean)
    .slice(0, 2);
  const axes = relationship
    ? [
        `warmth ${relationship.warmth || 0}`,
        `competence ${relationship.competence || 0}`,
        `trust ${relationship.trust || 0}`,
        `threat ${relationship.threat || 0}`,
        `attachment ${relationship.attachment || 0}`,
        `deference ${relationship.deference || 0}`,
      ].join(', ')
    : '';
  const rawDirectionalNote = relationship?.note?.trim() || '';
  // Public notes already pass through CharacterMindPromptAdapter's privacy
  // projection above. Do not bypass that boundary by rendering the raw note a
  // second time here.
  const directionalNote = params.chat.type === 'group' ? '' : rawDirectionalNote;
  if (usesMindOwnedConversationContract(params.chat)) {
    return `\n## Relational Consequence For This Turn
- Current counterpart: ${params.target.name}. Use the shared reality, this person's directional view and relationship evidence above as context for how this exchange lands; they are evidence, not a required visible relationship action.
${sharedFacts.length ? `- Shared reality: ${sharedFacts.join(' / ')}.` : ''}
${directionalNote ? `- ${params.character.name}'s subjective view of ${params.target.name}: ${directionalNote}` : ''}
${axes ? `- Directional relationship axes (${params.character.name} toward ${params.target.name}): ${axes}. Read them together; they inform the current posture but do not prescribe a fixed tone or permanent change.` : ''}
- Let this particular relationship shape the response only where it naturally matters: what feels easy, risky, familiar, irritating, protective, or worth withholding. A consequence can show through a small choice, or remain unspoken when the moment does not call for one.
- Do not state scores, labels, or this reasoning in the visible reply.`;
  }
  return `\n## Relational Consequence For This Turn
- Current counterpart: ${params.target.name}. The relationship evidence above is live, not character-sheet decoration. This person's identity changes the reaction; do not write a line that could be addressed unchanged to any other member.
${sharedFacts.length ? `- Shared reality: ${sharedFacts.join(' / ')}.` : ''}
${directionalNote ? `- ${params.character.name}'s subjective view of ${params.target.name}: ${directionalNote}` : ''}
${axes ? `- Directional relationship axes (${params.character.name} toward ${params.target.name}): ${axes}. Read the six axes together; a bond may be warm yet fearful, loyal yet resentful, deferential yet familiar.` : ''}
- Before writing, decide the immediate relational pressure: whose approval matters, who may interrupt whom, what can be said casually, what must be softened or hidden, and whether the speaker protects, tests, needles, yields, resists, or seeks closeness. Use only pressures supported by the evidence above and the current exchange.
- Make one consequence perceptible in address, timing, confidence, interruption, omission, concession, refusal, teasing, or emotional leakage. Do not turn every relationship into friendly teamwork, detached professionalism, or a polished consensus. Hierarchy need not mean panic, closeness need not mean kindness, and hostility need not mean shouting.
- Do not state scores, labels, or this reasoning in the visible reply.`;
}

export type PromptTranscriptOptions = ConversationProjectionOptions;

export function buildChatMessages(
  messages: Message[],
  characters: Map<string, AICharacter>,
  limit = 12,
  options: PromptTranscriptOptions = {},
) {
  return projectConversationForModel({ messages, characters, limit, options });
}

export function buildSystemPromptWithContext(character: AICharacter, chat: GroupChat, emotion: number, messages: Message[], characters: Map<string, AICharacter>) {
  return buildPromptAssemblyWithContext(character, chat, emotion, messages, characters).systemPrompt;
}

export function buildPromptAssemblyWithContext(character: AICharacter, chat: GroupChat, emotion: number, messages: Message[], characters: Map<string, AICharacter>, options: { preferredTargetActorId?: string } = {}): PromptAssemblyWithContext {
  const compactForUnifiedGroup = usesUnifiedOrdinaryGroupTurnContract(chat);
  const memoryContext = resolvePromptMemoryContext(character, chat, messages, characters, options.preferredTargetActorId);
  const personaActivation = resolvePersonaActivation({ chat, speaker: character, messages });
  const companionshipPrompt = buildCompanionshipPromptBlock({ chat, character, messages });
  const renderedCompanionshipPrompt = chat.type === 'group' ? '' : companionshipPrompt;
  const memoryCandidates = buildMergedMemories([
    ...memoryContext.targetedCharacterMemories,
    ...memoryContext.characterMemories,
    ...memoryContext.conversationMemories,
  ]);
  const mind = buildCharacterMindAdapterOutput(
    character,
    chat,
    messages,
    characters,
    memoryContext.target,
    memoryCandidates,
    buildVisibleMindRecallCuesForPrompt(chat, character, characters, memoryContext.memoryCues),
    { summarizeUserContinuity: chat.type === 'direct' && Boolean(companionshipPrompt) },
  );
  const projectedMindValues = new Set(mind.adapter.renderedIdentityValues);

  const systemPrompt = [
    buildCharacterSection(character, emotion, personaActivation, compactForUnifiedGroup, projectedMindValues),
    buildTopicSection(chat),
    buildRelationshipSection(character, memoryContext.target, chat),
    buildPromptMemorySection(chat, character, memoryContext.conversationMemories, memoryContext.characterMemories, memoryContext.targetedCharacterMemories, memoryContext.target, memoryContext.relationshipSnapshot, characters, memoryContext.recallCue, Boolean(companionshipPrompt), memoryContext.recentMemoryUseIds, mind),
    mind.adapter.promptBlock,
    buildRelationalConsequencePrompt({
      chat,
      character,
      characters,
      target: memoryContext.target,
      relationshipSnapshot: memoryContext.relationshipSnapshot,
      mind,
    }),
    renderedCompanionshipPrompt,
    buildMessageStyleRules(character, { includeGeneralNaturalness: !usesUnifiedOrdinaryGroupTurnContract(chat) }),
    buildRecentMessagesSection(messages, characters),
    buildResponseRulesPrompt(chat),
    '\n## Visual Input Rules\n- If the latest user message includes image attachments and asks you to inspect, explain, read, or comment on them, answer from what is actually visible in the image.\n- If the image is too small, blurry, cropped, or unreadable, say that clearly and ask for a clearer image or the original text. Do not invent specific contents that you cannot verify.',
  ].filter(Boolean).join('\n\n');
  return {
    systemPrompt,
    memoryTrace: memoryContext.trace,
    characterMindTrace: buildPromptCharacterMindTraceFromOutput(mind.projection, mind.adapter),
  };
}

export function buildDirectMemoryPanelContext(character: AICharacter, messages: Message[], characters: Map<string, AICharacter>) {
  const members = buildPromptDisplayMembers(character, characters);
  const recentPartner = messages
    .filter((item) => !item.isDeleted && item.senderId !== character.id && item.type !== 'system' && item.type !== 'event')
    .slice()
    .reverse()[0];
  const target = recentPartner ? characters.get(recentPartner.senderId) : undefined;
  const snapshot = getAuthoredRelationshipSnapshot(character, target);
  const targetSummary = target && snapshot ? buildRelationshipImpactText(target, snapshot) : '';
  const recentMemories = (character.layeredMemories || [])
    .slice(-3)
    .reverse()
    .map((item) => ({ id: item.id, text: cleanPromptText(item.text, members, 180), layer: item.layer, scope: item.scope }));
  const recentMemoryWrites = recentMemories.slice(0, 2);
  const recentRelationshipChanges = (character.runtimeTimeline || [])
    .filter((item) => item.type === 'relationship')
    .slice(-3)
    .reverse();
  const sourceTagCounts = (character.layeredMemories || []).reduce<Record<string, number>>((acc, item) => {
    const key = item.sourceTag || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const sourceTagRows = Object.entries(sourceTagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag, count]) => ({ tag, count, label: getExperienceLensLabel(tag) || cleanPromptText(tag, members, 80) }));
  return {
    targetName: target?.name || null,
    targetSummary,
    targetResolutionLabel: target ? '最近互动对象' : '未识别到明确对象',
    memoryVisibility: `角色记忆 ${(character.layeredMemories || []).length} / 时间线 ${(character.runtimeTimeline || []).length}`,
    recentMemories,
    recentRelationshipChanges,
    recentMemoryWrites,
    sourceTagSummary: sourceTagRows.map((item) => `${item.label}×${item.count}`).join(' / '),
    sourceTagRows,
    targetResolution: recentPartner ? cleanPromptText(recentPartner.senderName || recentPartner.senderId, members, 80) : undefined,
  };
}
