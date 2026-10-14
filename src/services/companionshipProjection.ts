import type { AICharacter } from '../types/character';
import { DEFAULT_PERSONALITY } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { AddressingState, CharacterCompanionshipState, CompanionshipPhase, CompanionshipProjection, CompanionshipStyle, CarePolicy, IntimacyProjection, PendingCareTopic, PreferredIntimacyStyle, UserBondState, UserProfileMemoryProjection, CompanionshipRuntimeTrace, CompanionshipStatusSignature, RitualRegistryEntry, RitualHistoryEntry, SharedMemoryAnchor, SharedAnchorHistoryEntry, SharedSecret, SharedSecretHistoryEntry, SharedPhrase, SharedPhraseHistoryEntry, UserProfileMemoryEventItem, UserProfileMemoryKind, UserProfileMemoryHistoryEntry, AddressingHistoryEntry, CareTopicHistoryEntry, PromiseHistoryEntry, IntimateConflictKind, IntimateConflictState, IntimateConflictHistoryEntry, PhaseHistoryEntry, UserAttachmentProfile, AttachmentProfileHistoryEntry, PendingPromise, CompanionshipRitualEventPayload, CompanionshipIntimateConflictEventPayload, CompanionshipAttachmentProfileEventPayload, CompanionshipAddressingEventPayload, CompanionshipOnlineReturnEventPayload, CompanionshipPromiseEventPayload, CompanionshipCareTopicEventPayload, CompanionshipSharedSecretEventPayload, CompanionshipSharedPhraseEventPayload, CompanionshipUnsentDraftEventPayload, CompanionshipSharedAnchorEventPayload, CompanionshipDiaryReflectionEventPayload, CompanionshipMomentReflectionEventPayload } from '../types/companionship';
import type { Message } from '../types/message';
import type { RelationshipLedgerEntry, RuntimeEventV2 } from '../types/runtimeEvent';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';
import { readActiveCompanionshipCareTopicsFromEvents, readSuppressedCompanionshipCareTopicTextsFromEvents } from './directCompanionshipCare';
import { userProfileMemoryPayloadOf } from './directUserProfileMemory';
import { isMemoryAnchorCandidate } from './memoryLifecycle';
import { normalizeRelationshipLedgerEntry } from './relationshipLedger';
import { getCompanionshipRuntimeConfig } from './companionshipRuntimeConfig';
import { cleanSeedForReflection } from './diaryCompanionshipBackflow';

const USER_ACTOR_ID = 'user';
const DAY_MS = 24 * 60 * 60 * 1000;
type PromiseConsequenceAction = Extract<CompanionshipPromiseEventPayload['action'], 'fulfilled' | 'blocked' | 'stale'>;
type PromiseIntimacyConsequence = { effect: Partial<IntimacyProjection>; evidence: string; action: PromiseConsequenceAction };

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function compactText(text: string | undefined | null, max = 120) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function buildCompanionshipDisplayMembers(
  character: Partial<AICharacter>,
  relatedCharacters: Pick<AICharacter, 'id' | 'name'>[] = [],
): DisplayTextMember[] {
  const map = new Map<string, string>();
  map.set(USER_ACTOR_ID, '用户');
  if (character.id) map.set(character.id, character.name || '这个角色');
  relatedCharacters.forEach((item) => {
    if (item.id) map.set(item.id, item.name || '成员');
  });
  return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
}

function cleanArtifactSeedText(text: string | undefined | null, members: DisplayTextMember[], max = 140) {
  return compactText(sanitizeUserFacingText(text || '', members), max);
}

function resolveCompanionshipActorName(id: string, relatedCharacters: Pick<AICharacter, 'id' | 'name'>[]) {
  if (id === USER_ACTOR_ID) return '用户';
  return relatedCharacters.find((character) => character.id === id)?.name || (id.startsWith('draft-') ? '未命名角色' : '成员');
}

function canProjectCompanionshipArtifacts(character: Partial<AICharacter>): character is AICharacter {
  return Boolean(character.id && (character.layeredMemories?.length || character.relationships?.length || character.memory?.userMemories?.length));
}

function hasCompanionshipRuntimeEvents(chat: GroupChat | undefined, characterId: string | undefined) {
  if (!chat || !characterId) return false;
  return (chat.runtimeEventsV2 || []).some((event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    return Boolean(payload?.eventType && typeof payload.eventType === 'string' && payload.eventType.startsWith('companionship_') && payload.characterId === characterId);
  });
}

function clampRelationshipScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getCharacterToUserLedger(chat: GroupChat, characterId: string): RelationshipLedgerEntry | null {
  const entry = (chat.relationshipLedger || [])
    .map(normalizeRelationshipLedgerEntry)
    .filter((item) => item.actorId === characterId && item.targetId === USER_ACTOR_ID)
    .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0))[0];
  return entry || null;
}

function getLatestContact(messages: Message[], characterId: string) {
  const visible = messages.filter((item) => !item.isDeleted && item.type !== 'system' && item.type !== 'event');
  const latestUser = visible.slice().reverse().find((item) => item.senderId === USER_ACTOR_ID || item.type === 'user' || item.type === 'god');
  const latestCharacter = visible.slice().reverse().find((item) => item.senderId === characterId && item.type === 'ai');
  const latestMeaningful = visible.slice().reverse().find((item) => item.senderId === characterId || item.senderId === USER_ACTOR_ID || item.type === 'user' || item.type === 'god');
  return {
    lastUserReplyAt: latestUser?.timestamp,
    lastCharacterInitiatedAt: latestCharacter?.timestamp,
    lastMeaningfulContactAt: latestMeaningful?.timestamp || Date.now(),
  };
}

function silenceHours(lastUserReplyAt: number | undefined, now: number) {
  if (!lastUserReplyAt) return 0;
  return Math.max(0, (now - lastUserReplyAt) / (60 * 60 * 1000));
}

function projectIntimacy(entry: RelationshipLedgerEntry | null): IntimacyProjection {
  const current = entry?.current || { warmth: 0, competence: 0, trust: 0, threat: 0 };
  const semanticIntensity = entry?.derived?.semantic?.intensity || 0;
  const tension = Math.max(0, current.threat);
  return {
    attraction: clampScore(current.warmth * 0.72 + current.trust * 0.22 + semanticIntensity * 0.18 - tension * 0.38),
    intimacy: clampScore(current.trust * 0.62 + current.warmth * 0.34 - tension * 0.42),
    attachment: clampScore((Math.max(0, current.warmth) + Math.max(0, current.trust)) * 0.42 - tension * 0.2),
    longing: clampScore(Math.max(0, current.warmth) * 0.24 + Math.max(0, current.trust) * 0.22 - tension * 0.24),
    exclusivity: clampScore(Math.max(0, current.warmth) * 0.18 + tension * 0.42 + Math.max(0, current.trust) * 0.08),
    security: clampScore(48 + current.trust * 0.58 + current.warmth * 0.18 - tension * 0.78),
  };
}

function adjustIntimacyProjection(params: {
  base: IntimacyProjection;
  sharedAnchors: SharedMemoryAnchor[];
  promiseConsequences?: PromiseIntimacyConsequence[];
}): IntimacyProjection {
  const anchorBoost = params.sharedAnchors.reduce((total, anchor) => {
    if (anchor.kind === 'conflict') return total;
    const weight = anchor.kind === 'repair' || anchor.kind === 'confession' || anchor.kind === 'milestone' ? 1.2 : 1;
    return total + (anchor.salience / 100) * (anchor.confidence / 100) * weight;
  }, 0);
  const promiseEffect = (params.promiseConsequences || []).reduce((total, consequence) => ({
    attraction: total.attraction + (consequence.effect.attraction || 0),
    intimacy: total.intimacy + (consequence.effect.intimacy || 0),
    attachment: total.attachment + (consequence.effect.attachment || 0),
    longing: total.longing + (consequence.effect.longing || 0),
    exclusivity: total.exclusivity + (consequence.effect.exclusivity || 0),
    security: total.security + (consequence.effect.security || 0),
  }), { attraction: 0, intimacy: 0, attachment: 0, longing: 0, exclusivity: 0, security: 0 });
  return {
    attraction: clampScore(params.base.attraction + anchorBoost * 5 + promiseEffect.attraction),
    intimacy: clampScore(params.base.intimacy + anchorBoost * 7 + promiseEffect.intimacy),
    attachment: clampScore(params.base.attachment + anchorBoost * 8 + promiseEffect.attachment),
    longing: clampScore(params.base.longing + anchorBoost * 4 + promiseEffect.longing),
    exclusivity: clampScore(params.base.exclusivity + promiseEffect.exclusivity),
    security: clampScore(params.base.security + anchorBoost * 4 + promiseEffect.security),
  };
}

function buildLongTermIntimacyTrend(chat: GroupChat, characterId: string, now: number): Partial<IntimacyProjection> {
  const windowStart = now - 180 * DAY_MS;
  const trend = {
    attraction: 0,
    intimacy: 0,
    attachment: 0,
    longing: 0,
    exclusivity: 0,
    security: 0,
  };
  (chat.runtimeEventsV2 || []).forEach((event) => {
    const createdAt = event.createdAt || 0;
    if (createdAt && createdAt < windowStart) return;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.eventType !== 'string') return;
    if (typeof payload.characterId === 'string' && payload.characterId !== characterId) return;
    const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
    const participantIds = Array.isArray(payload.participantIds) ? payload.participantIds.filter((item): item is string => typeof item === 'string') : [];
    if (userId && userId !== USER_ACTOR_ID) return;
    if (!userId && participantIds.length && !participantIds.includes(USER_ACTOR_ID)) return;
    const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 0.75;
    const weight = Math.max(0.25, Math.min(1, confidence <= 1 ? confidence : confidence / 100));
    if (payload.eventType === 'companionship_phase_event') {
      if (payload.action === 'revoked') return;
      if (payload.phase === 'confirmed' || payload.phase === 'passionate') {
        trend.attraction += 3 * weight;
        trend.intimacy += 4 * weight;
        trend.attachment += 3 * weight;
        trend.security += 2 * weight;
      } else if (payload.phase === 'deep') {
        trend.intimacy += 5 * weight;
        trend.attachment += 4 * weight;
        trend.security += 5 * weight;
      } else if (payload.phase === 'cooling' || payload.phase === 'crisis') {
        trend.security -= 5 * weight;
        trend.intimacy -= 3 * weight;
        trend.longing -= 2 * weight;
      } else if (payload.phase === 'reconciling') {
        trend.security += 2 * weight;
        trend.intimacy += 2 * weight;
      }
      return;
    }
    if (payload.eventType === 'companionship_intimate_conflict') {
      const severity = typeof payload.severity === 'number' && Number.isFinite(payload.severity) ? payload.severity : 40;
      const repair = typeof payload.repairReadiness === 'number' && Number.isFinite(payload.repairReadiness) ? payload.repairReadiness : 0;
      if (payload.action === 'resolved') {
        trend.security += Math.min(6, repair / 16) * weight;
        trend.intimacy += 2 * weight;
      } else if (payload.action === 'repair_attempted') {
        trend.security += Math.min(3, repair / 28) * weight;
      } else if (payload.action === 'opened' || payload.action === 'reopened' || payload.action === 'updated') {
        trend.security -= Math.min(8, severity / 10) * weight;
        trend.intimacy -= Math.min(4, severity / 22) * weight;
      }
      return;
    }
    if (payload.eventType === 'companionship_shared_secret') {
      if (payload.action === 'recorded' || payload.action === 'hinted_publicly') {
        trend.intimacy += 2 * weight;
        trend.security += 1 * weight;
      } else if (payload.action === 'confessed') {
        trend.intimacy += 3 * weight;
        trend.security += 3 * weight;
      } else if (payload.action === 'leaked') {
        trend.security -= 5 * weight;
        trend.intimacy -= 2 * weight;
      }
      return;
    }
    if (payload.eventType === 'companionship_promise') {
      if (payload.action === 'fulfilled') {
        trend.security += 3 * weight;
        trend.attachment += 2 * weight;
      } else if (payload.action === 'blocked' || payload.action === 'stale') {
        trend.security -= 3 * weight;
      } else if (payload.action === 'opened') {
        trend.attachment += 1 * weight;
      }
      return;
    }
    if (payload.eventType === 'companionship_ritual') {
      if (payload.action === 'performed' || payload.action === 'restored') {
        trend.attachment += 1.5 * weight;
        trend.intimacy += 1 * weight;
      } else if (payload.action === 'suppressed') {
        trend.longing -= 1.5 * weight;
      }
    }
  });
  return {
    attraction: Math.round(Math.max(-12, Math.min(12, trend.attraction))),
    intimacy: Math.round(Math.max(-14, Math.min(14, trend.intimacy))),
    attachment: Math.round(Math.max(-14, Math.min(14, trend.attachment))),
    longing: Math.round(Math.max(-12, Math.min(12, trend.longing))),
    exclusivity: Math.round(Math.max(-8, Math.min(8, trend.exclusivity))),
    security: Math.round(Math.max(-16, Math.min(16, trend.security))),
  };
}

function applyLongTermIntimacyTrend(base: IntimacyProjection, trend: Partial<IntimacyProjection>): IntimacyProjection {
  return {
    attraction: clampScore(base.attraction + (trend.attraction || 0)),
    intimacy: clampScore(base.intimacy + (trend.intimacy || 0)),
    attachment: clampScore(base.attachment + (trend.attachment || 0)),
    longing: clampScore(base.longing + (trend.longing || 0)),
    exclusivity: clampScore(base.exclusivity + (trend.exclusivity || 0)),
    security: clampScore(base.security + (trend.security || 0)),
  };
}

function adjustIntimacyForCompanionshipRuntime(params: {
  base: IntimacyProjection;
  sharedSecrets: SharedSecret[];
  intimateConflict?: IntimateConflictState;
  attachmentProfile: UserAttachmentProfile;
}): IntimacyProjection {
  const userSecrets = params.sharedSecrets.filter((secret) => secret.participantIds.includes(USER_ACTOR_ID));
  const sealedWeight = userSecrets
    .filter((secret) => secret.leakState === 'sealed' || secret.leakState === 'hinted_publicly')
    .reduce((total, secret) => total + secret.emotionalWeight, 0);
  const confessedWeight = userSecrets
    .filter((secret) => secret.leakState === 'confessed')
    .reduce((total, secret) => total + secret.emotionalWeight, 0);
  const leakedWeight = userSecrets
    .filter((secret) => secret.leakState === 'leaked')
    .reduce((total, secret) => total + secret.emotionalWeight, 0);
  const intentionalLeakWeight = userSecrets
    .filter((secret) => secret.leakState === 'leaked' && secret.consequenceKind === 'intentional_breach')
    .reduce((total, secret) => total + secret.emotionalWeight, 0);
  const softLeakWeight = userSecrets
    .filter((secret) => secret.leakState === 'leaked' && (secret.consequenceKind === 'misunderstanding' || secret.consequenceKind === 'accidental_leak'))
    .reduce((total, secret) => total + secret.emotionalWeight, 0);
  const protectiveConfessionWeight = userSecrets
    .filter((secret) => secret.leakState === 'confessed' && (secret.consequenceKind === 'protective_confession' || secret.consequenceKind === 'voluntary_confession'))
    .reduce((total, secret) => total + secret.emotionalWeight, 0);
  const conflictSeverity = params.intimateConflict?.severity || 0;
  const repairReadiness = params.intimateConflict?.repairReadiness || 0;
  const isRepairing = params.intimateConflict?.kind === 'repair_attempt' || params.intimateConflict?.kind === 'reconciliation';
  const attachment = params.attachmentProfile.confidence >= 58 ? params.attachmentProfile.inferredStyle : 'secure';
  return {
    attraction: clampScore(
      params.base.attraction
      + sealedWeight * 0.04
      + confessedWeight * 0.03
      - leakedWeight * 0.06
      - intentionalLeakWeight * 0.04
      + softLeakWeight * 0.02
      - conflictSeverity * 0.16
      + (isRepairing ? repairReadiness * 0.05 : 0),
    ),
    intimacy: clampScore(
      params.base.intimacy
      + sealedWeight * 0.08
      + confessedWeight * 0.1
      + protectiveConfessionWeight * 0.04
      - leakedWeight * 0.05
      + softLeakWeight * 0.03
      - conflictSeverity * 0.12
      + (isRepairing ? repairReadiness * 0.14 : 0),
    ),
    attachment: clampScore(
      params.base.attachment
      + sealedWeight * 0.06
      + confessedWeight * 0.08
      + protectiveConfessionWeight * 0.03
      - leakedWeight * 0.04
      + softLeakWeight * 0.02
      + (attachment === 'anxious' ? 6 : attachment === 'avoidant' ? -4 : attachment === 'disorganized' ? -2 : 0),
    ),
    longing: clampScore(
      params.base.longing
      + sealedWeight * 0.04
      - leakedWeight * 0.05
      + softLeakWeight * 0.02
      + (attachment === 'anxious' ? 8 : attachment === 'avoidant' ? -10 : attachment === 'disorganized' ? -4 : 0),
    ),
    exclusivity: clampScore(
      params.base.exclusivity
      + sealedWeight * 0.02
      + leakedWeight * 0.06
      + intentionalLeakWeight * 0.03
      - softLeakWeight * 0.02
      - (attachment === 'avoidant' ? 8 : 0),
    ),
    security: clampScore(
      params.base.security
      + sealedWeight * 0.04
      + confessedWeight * 0.12
      + protectiveConfessionWeight * 0.08
      - leakedWeight * 0.12
      - intentionalLeakWeight * 0.08
      + softLeakWeight * 0.04
      - conflictSeverity * 0.2
      + (isRepairing ? repairReadiness * 0.18 : 0)
      - (attachment === 'anxious' ? 4 : attachment === 'disorganized' ? 6 : 0),
    ),
  };
}

function inferAnchorPhase(intimacy: IntimacyProjection, sharedAnchors: SharedMemoryAnchor[]): CompanionshipPhase | null {
  const anchors = sharedAnchors
    .filter((anchor) => anchor.confidence >= 56 && anchor.salience >= 42)
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  const latestConflict = anchors.find((anchor) => anchor.kind === 'conflict');
  const latestRepair = anchors.find((anchor) => anchor.kind === 'repair');
  if (latestConflict && (!latestRepair || latestConflict.updatedAt >= latestRepair.updatedAt)) {
    if (intimacy.security <= 26) return 'crisis';
    if (intimacy.security <= 42) return 'cooling';
  }
  if (latestRepair && (!latestConflict || latestRepair.updatedAt >= latestConflict.updatedAt)) return 'reconciling';
  const confession = anchors.find((anchor) => anchor.kind === 'confession');
  if (confession) {
    // A distilled confession anchor proves that a confession occurred, not that
    // both parties accepted a relationship. Confirmation comes only from the
    // explicit companionship_phase_event projection.
    if (intimacy.attraction >= 58 && intimacy.intimacy >= 48 && intimacy.security >= 38) return 'confessing';
    return 'ambiguous';
  }
  return null;
}

function inferPhase(intimacy: IntimacyProjection, entry: RelationshipLedgerEntry | null, sharedAnchors: SharedMemoryAnchor[] = []): CompanionshipPhase {
  const anchorPhase = inferAnchorPhase(intimacy, sharedAnchors);
  if (anchorPhase) return anchorPhase;
  const stage = entry?.derived?.semantic?.stage || '';
  const labels = entry?.derived?.semantic?.labels || [];
  if (labels.includes('喜欢') || labels.includes('深度牵挂') || stage === '深度绑定') {
    return 'fond';
  }
  // Relationship labels/stage are model-owned. Numeric axes alone must not
  // manufacture semantic phases such as "curious" or "fond".
  return 'stranger';
}

const COMPANIONSHIP_PHASES: CompanionshipPhase[] = ['stranger', 'curious', 'fond', 'ambiguous', 'confessing', 'confirmed', 'passionate', 'deep', 'cooling', 'crisis', 'reconciling'];
const COMPANIONSHIP_STYLES: CompanionshipStyle[] = ['romantic', 'ambiguous', 'friend', 'family', 'mentor', 'custom'];

function isCompanionshipPhase(value: unknown): value is CompanionshipPhase {
  return typeof value === 'string' && COMPANIONSHIP_PHASES.includes(value as CompanionshipPhase);
}

function isCompanionshipStyle(value: unknown): value is CompanionshipStyle {
  return typeof value === 'string' && COMPANIONSHIP_STYLES.includes(value as CompanionshipStyle);
}

interface ResolvedPhaseEvent {
  phase: CompanionshipPhase;
  style?: CompanionshipStyle;
  enteredAt: number;
  evidence: string[];
  sourceEventId: string;
  sourceMessageIds: string[];
}

function resolveCompanionshipPhaseEvent(chat: GroupChat, characterId: string): ResolvedPhaseEvent | null {
  const events = (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const eventType = typeof payload.eventType === 'string' ? payload.eventType : '';
    if (eventType !== 'companionship_phase_event') continue;
    const payloadCharacterId = typeof payload.characterId === 'string' ? payload.characterId : '';
    const payloadUserId = typeof payload.userId === 'string' ? payload.userId : USER_ACTOR_ID;
    if (payloadCharacterId && payloadCharacterId !== characterId) continue;
    if (payloadUserId && payloadUserId !== USER_ACTOR_ID) continue;
    const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
    const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
    if (!actorMatches || !targetMatches) continue;
    if (payload.action === 'revoked') return null;
    if (!isCompanionshipPhase(payload.phase)) continue;
    const evidence = Array.isArray(payload.evidence)
      ? payload.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120))
      : [];
    const reason = typeof payload.reason === 'string' ? compactText(payload.reason, 120) : '';
    return {
      phase: payload.phase,
      style: isCompanionshipStyle(payload.style) ? payload.style : undefined,
      enteredAt: event.createdAt || Date.now(),
      evidence: [event.summary, reason, ...evidence].filter(Boolean).slice(0, 5),
      sourceEventId: event.id,
      sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
    };
  }
  return null;
}

function buildPhaseHistory(chat: GroupChat, characterId: string): PhaseHistoryEntry[] {
  const history: PhaseHistoryEntry[] = [];
  (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .forEach((event) => {
      const payload = event.payload as Record<string, unknown>;
      const eventType = typeof payload.eventType === 'string' ? payload.eventType : '';
      if (eventType !== 'companionship_phase_event') return;
      const payloadCharacterId = typeof payload.characterId === 'string' ? payload.characterId : '';
      const payloadUserId = typeof payload.userId === 'string' ? payload.userId : USER_ACTOR_ID;
      if (payloadCharacterId && payloadCharacterId !== characterId) return;
      if (payloadUserId && payloadUserId !== USER_ACTOR_ID) return;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return;
      const action: PhaseHistoryEntry['action'] = payload.action === 'revoked' ? 'revoked' : 'set';
      if (action === 'set' && !isCompanionshipPhase(payload.phase)) return;
      const evidence = Array.isArray(payload.evidence)
        ? payload.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120))
        : [];
      const reason = typeof payload.reason === 'string' ? compactText(payload.reason, 120) : undefined;
      const initiatedBy = payload.initiatedBy === 'user' || payload.initiatedBy === 'character' || payload.initiatedBy === 'mutual' || payload.initiatedBy === 'system'
        ? payload.initiatedBy
        : undefined;
      history.push({
        id: event.id,
        action,
        phase: isCompanionshipPhase(payload.phase) ? payload.phase : undefined,
        style: isCompanionshipStyle(payload.style) ? payload.style : undefined,
        evidence: [event.summary, reason, ...evidence].filter(Boolean).slice(0, 5) as string[],
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        reason,
        initiatedBy,
        decisionSource: payload.decisionSource === 'model' || payload.decisionSource === 'local_fallback' ? payload.decisionSource : undefined,
        confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
        occurredAt: event.createdAt || 0,
      });
    });
  return history.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 8);
}

function resolveBondStyle(phase: CompanionshipPhase, explicitStyle?: CompanionshipStyle): CompanionshipStyle {
  if (explicitStyle) return explicitStyle;
  if (phase === 'ambiguous' || phase === 'confessing') return 'ambiguous';
  if (phase === 'confirmed' || phase === 'passionate' || phase === 'deep') return 'romantic';
  return 'friend';
}

function inferPreferredStyle(character: AICharacter, intimacy: IntimacyProjection): PreferredIntimacyStyle {
  const personality = { ...DEFAULT_PERSONALITY, ...(character.personality || {}) };
  if (personality.extroversion >= 68 && personality.humor >= 58) return 'playful';
  if (personality.empathy >= 68 && personality.agreeableness >= 58) return 'warm';
  if (intimacy.longing >= 70 && personality.neuroticism >= 62) return 'clingy';
  if (personality.assertiveness >= 68) return 'direct';
  return 'reserved';
}

function hasBoundary(profile: UserProfileMemoryProjection, patterns: RegExp[]) {
  const text = profile.boundaries.join('\n');
  return patterns.some((pattern) => pattern.test(text));
}

function applyUserBoundariesToCarePolicy(policy: CarePolicy, profile: UserProfileMemoryProjection): CarePolicy {
  const boundaryReasons: string[] = [];
  let next = { ...policy };
  if (hasBoundary(profile, [/不要.*(主动|打扰|私聊|提醒)/, /不想.*(主动|打扰|私聊|提醒)/, /不希望.*(主动|打扰|私聊|提醒)/, /不需要.*(主动|打扰|私聊|提醒)/, /不愿.*(主动|打扰|私聊|提醒)/, /少.*(主动|打扰|私聊|提醒)/])) {
    boundaryReasons.push('user prefers low proactive contact');
    next = {
      ...next,
      dailyInitiationBudget: 0,
      triggerSensitivity: Math.min(next.triggerSensitivity, 18),
      expressionIntensity: Math.min(next.expressionIntensity, 28),
      allowGoodMorning: false,
      allowGoodNight: false,
      allowMissYou: false,
    };
  }
  if (hasBoundary(profile, [/不.*(恋爱|暧昧|情侣|对象|占有|吃醋)/, /不要.*(恋爱|暧昧|情侣|对象|占有|吃醋)/, /不希望.*(恋爱|暧昧|情侣|对象|占有|吃醋)/, /只.*朋友/])) {
    boundaryReasons.push('user does not want romantic framing');
    next = {
      ...next,
      expressionIntensity: Math.min(next.expressionIntensity, 38),
      allowMissYou: false,
    };
  }
  if (hasBoundary(profile, [/不要.*(早安|晚安)/, /不想.*(早安|晚安)/, /不希望.*(早安|晚安)/, /不需要.*(早安|晚安)/, /不愿.*(早安|晚安)/])) {
    boundaryReasons.push('user rejects greeting rituals');
    next = {
      ...next,
      allowGoodMorning: false,
      allowGoodNight: false,
    };
  }
  return {
    ...next,
    boundaryReasons,
  };
}

const ATTACHMENT_STYLES: UserAttachmentProfile['inferredStyle'][] = ['secure', 'anxious', 'avoidant', 'disorganized'];

function isAttachmentStyle(value: unknown): value is UserAttachmentProfile['inferredStyle'] {
  return typeof value === 'string' && ATTACHMENT_STYLES.includes(value as UserAttachmentProfile['inferredStyle']);
}

function normalizeEventConfidenceScore(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return clampScore(value <= 1 ? value * 100 : value);
}

function attachmentProfileEventPayloadOf(event: RuntimeEventV2): CompanionshipAttachmentProfileEventPayload | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || payload.eventType !== 'companionship_attachment_profile') return null;
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : '';
  if (!characterId) return null;
  const action = payload.action === 'corrected' || payload.action === 'disabled' || payload.action === 'enabled' || payload.action === 'inferred'
    ? payload.action
    : 'inferred';
  if ((action === 'inferred' || action === 'corrected') && !isAttachmentStyle(payload.inferredStyle)) return null;
  const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 0;
  const evidence = Array.isArray(payload.evidence)
    ? payload.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120))
    : undefined;
  const adaptations = Array.isArray(payload.adaptations)
    ? payload.adaptations.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120)).slice(0, 4)
    : undefined;
  return {
    eventType: 'companionship_attachment_profile',
    characterId,
    userId: typeof payload.userId === 'string' ? payload.userId : undefined,
    action,
    inferredStyle: isAttachmentStyle(payload.inferredStyle) ? payload.inferredStyle : undefined,
    confidence,
    evidence,
    sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
    adaptations,
    reason: typeof payload.reason === 'string' ? compactText(payload.reason, 140) : undefined,
    decisionSource: payload.decisionSource === 'model' || payload.decisionSource === 'local_fallback' ? payload.decisionSource : undefined,
  };
}

type ResolvedAttachmentProfileEvent =
  | { mode: 'profile'; profile: UserAttachmentProfile }
  | { mode: 'enabled' };

const ATTACHMENT_FALLBACK_ADAPTATIONS: Record<UserAttachmentProfile['inferredStyle'], string[]> = {
  secure: ['keep a steady reciprocal pace'],
  anxious: ['give concrete reassurance without overpromising', 'respond to silence with warmth before intensity'],
  avoidant: ['respect space and avoid repeated follow-up', 'keep care low-pressure and easy to ignore without reducing substantive answers'],
  disorganized: ['stay steady when the user alternates closeness and distance', 'avoid escalating intimacy after mixed signals'],
};

function attachmentProfileFromPayload(payload: CompanionshipAttachmentProfileEventPayload, event: RuntimeEventV2): UserAttachmentProfile | null {
  if (!payload.inferredStyle) return null;
  return {
    inferredStyle: payload.inferredStyle,
    confidence: normalizeEventConfidenceScore(payload.confidence),
    evidence: [payload.reason, ...(payload.evidence || []), `event=${event.id}`].filter(Boolean).slice(0, 5) as string[],
    adaptations: payload.adaptations?.length ? payload.adaptations : ATTACHMENT_FALLBACK_ADAPTATIONS[payload.inferredStyle],
  };
}

function buildAttachmentProfileHistory(chat: GroupChat, characterId: string): AttachmentProfileHistoryEntry[] {
  const history: AttachmentProfileHistoryEntry[] = [];
  (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .forEach((event) => {
      const payload = attachmentProfileEventPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return;
      const userId = payload.userId || USER_ACTOR_ID;
      if (userId !== USER_ACTOR_ID) return;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return;
      const action = payload.action || 'inferred';
      history.push({
        id: event.id,
        action,
        inferredStyle: payload.inferredStyle,
        confidence: normalizeEventConfidenceScore(payload.confidence),
        evidence: [payload.reason, ...(payload.evidence || [])].filter(Boolean).map((item) => compactText(item, 120)).slice(0, 4) as string[],
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        adaptations: payload.adaptations?.length
          ? payload.adaptations.slice(0, 4)
          : payload.inferredStyle
            ? ATTACHMENT_FALLBACK_ADAPTATIONS[payload.inferredStyle]
            : [],
        reason: payload.reason,
        decisionSource: payload.decisionSource,
        occurredAt: event.createdAt || 0,
      });
    });
  return history.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 8);
}

function aggregateAttachmentProfileEvents(items: Array<{ event: RuntimeEventV2; payload: CompanionshipAttachmentProfileEventPayload }>, now: number): UserAttachmentProfile | null {
  const recent = items
    .filter(({ payload }) => payload.action === 'inferred' && Boolean(payload.inferredStyle))
    .filter(({ event }) => now <= 0 || (event.createdAt || 0) >= now - 90 * DAY_MS);
  if (!recent.length) return null;
  if (recent.length === 1) return attachmentProfileFromPayload(recent[0].payload, recent[0].event);
  const scores = new Map<UserAttachmentProfile['inferredStyle'], number>();
  recent.forEach(({ event, payload }) => {
    if (!payload.inferredStyle) return;
    const confidence = Math.max(0.35, normalizeEventConfidenceScore(payload.confidence) / 100);
    const ageDays = now > 0 ? Math.max(0, (now - (event.createdAt || now)) / DAY_MS) : 0;
    const recencyWeight = Math.max(0.4, 1 - ageDays / 120);
    scores.set(payload.inferredStyle, (scores.get(payload.inferredStyle) || 0) + confidence * recencyWeight);
  });
  const ranked = Array.from(scores.entries()).sort((left, right) => right[1] - left[1]);
  const dominant = ranked[0]?.[0];
  if (!dominant) return null;
  const dominantEvents = recent
    .filter(({ payload }) => payload.inferredStyle === dominant)
    .sort((left, right) => (right.event.createdAt || 0) - (left.event.createdAt || 0));
  const totalWeight = Array.from(scores.values()).reduce((total, item) => total + item, 0);
  const dominance = totalWeight > 0 ? (scores.get(dominant) || 0) / totalWeight : 0;
  const averageConfidence = dominantEvents.reduce((total, item) => total + normalizeEventConfidenceScore(item.payload.confidence), 0) / Math.max(1, dominantEvents.length);
  return {
    inferredStyle: dominant,
    confidence: clampScore(42 + averageConfidence * 0.38 + dominance * 24 + Math.min(10, dominantEvents.length * 2)),
    evidence: [
      `长期趋势：${dominantEvents.length} 条 ${dominant} 依恋适配事件`,
      ...dominantEvents.flatMap(({ payload }) => [payload.reason, ...(payload.evidence || [])]).filter(Boolean).slice(0, 4),
    ] as string[],
    adaptations: dominantEvents.find(({ payload }) => payload.adaptations?.length)?.payload.adaptations || ATTACHMENT_FALLBACK_ADAPTATIONS[dominant],
  };
}

function resolveAttachmentProfileEvent(chat: GroupChat | undefined, characterId: string): ResolvedAttachmentProfileEvent | null {
  const events = (chat?.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .map((event) => ({ event, payload: attachmentProfileEventPayloadOf(event) }))
    .filter((item): item is { event: RuntimeEventV2; payload: CompanionshipAttachmentProfileEventPayload } => {
      const payload = item.payload;
      if (!payload || payload.characterId !== characterId) return false;
    const userId = payload.userId || USER_ACTOR_ID;
      if (userId !== USER_ACTOR_ID) return false;
      const actorMatches = !item.event.actorIds?.length || item.event.actorIds.includes(characterId) || item.event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !item.event.targetIds?.length || item.event.targetIds.includes(characterId) || item.event.targetIds.includes(USER_ACTOR_ID);
      return actorMatches && targetMatches;
    })
    .sort((a, b) => (b.event.createdAt || 0) - (a.event.createdAt || 0));
  const latestControl = events.find(({ payload }) => payload.action === 'corrected' || payload.action === 'disabled' || payload.action === 'enabled');
  if (latestControl?.payload.action === 'disabled') {
      return {
        mode: 'profile',
        profile: {
          inferredStyle: 'secure',
          confidence: 0,
          evidence: [latestControl.payload.reason, ...(latestControl.payload.evidence || [])].filter(Boolean).slice(0, 4) as string[],
          adaptations: [],
        },
      };
    }
  if (latestControl?.payload.action === 'corrected') {
    const profile = attachmentProfileFromPayload(latestControl.payload, latestControl.event);
    return profile ? { mode: 'profile', profile } : null;
  }
  const enabledAt = latestControl?.payload.action === 'enabled' ? (latestControl.event.createdAt || 0) : 0;
  const candidateEvents = enabledAt > 0 ? events.filter(({ event }) => (event.createdAt || 0) > enabledAt) : events;
  const aggregated = aggregateAttachmentProfileEvents(candidateEvents, chat?.updatedAt || Date.now());
  return aggregated ? { mode: 'profile', profile: aggregated } : (latestControl?.payload.action === 'enabled' ? { mode: 'enabled' } : null);
}

function buildUserAttachmentProfile(params: {
  chat?: GroupChat;
  characterId: string;
  messages: Message[];
  profile: UserProfileMemoryProjection;
  intimacy: IntimacyProjection;
  now: number;
}): UserAttachmentProfile {
  if (!getCompanionshipRuntimeConfig().enableAttachmentAdaptation) {
    return {
      inferredStyle: 'secure',
      confidence: 0,
      evidence: ['global setting disables attachment adaptation'],
      adaptations: [],
    };
  }
  const eventProfile = resolveAttachmentProfileEvent(params.chat, params.characterId);
  if (eventProfile?.mode === 'profile') return eventProfile.profile;
  const recentUserTexts = params.messages
    .filter((item) => isUserMessage(item))
    .slice(-18)
    .map((item) => compactText(item.content, 140));
  const allTexts = [...recentUserTexts, ...params.profile.sourceTexts].join('\n');
  const evidence: string[] = [];
  const anxiousScore = [
    /(在不在|怎么不回|为什么不回|是不是不想理我|是不是不喜欢我|你会不会离开|别不理我|别消失|想确认)/,
    /(需要|想要).{0,12}(确认|安全感|陪着|回应|回复)/,
  ].reduce((score, pattern) => score + (pattern.test(allTexts) ? 2 : 0), 0)
    + Math.min(3, recentUserTexts.filter((text) => /(在不在|回我|别不理|想你|陪我)/.test(text)).length);
  const avoidantScore = [
    /(别|不要|不想|不需要).{0,14}(主动|打扰|私聊|追问|关心|黏|暧昧|恋爱|情侣|对象)/,
    /(给我|想要|需要).{0,10}(空间|距离|安静)/,
    /(先别聊|少联系|不用回|别问了)/,
  ].reduce((score, pattern) => score + (pattern.test(allTexts) ? 2 : 0), 0);
  if (anxiousScore > 0) evidence.push(...recentUserTexts.filter((text) => /(在不在|怎么不回|别不理|安全感|陪我|想你|确认)/.test(text)).slice(-2));
  if (avoidantScore > 0) evidence.push(...params.profile.boundaries.slice(0, 2), ...recentUserTexts.filter((text) => /(空间|距离|安静|别问|少联系|不用回|不要主动|别打扰)/.test(text)).slice(-2));
  const mixed = anxiousScore >= 2 && avoidantScore >= 2;
  const inferredStyle: UserAttachmentProfile['inferredStyle'] = mixed
    ? 'disorganized'
    : anxiousScore >= 2
      ? 'anxious'
      : avoidantScore >= 2
        ? 'avoidant'
        : 'secure';
  const confidence = inferredStyle === 'secure'
    ? clampScore(42 + Math.min(24, params.profile.confidence * 0.25) + (params.intimacy.security >= 48 ? 12 : 0))
    : clampScore(48 + Math.max(anxiousScore, avoidantScore) * 10 + (mixed ? 10 : 0));
  const adaptations: string[] = [];
  if (inferredStyle === 'anxious') {
    adaptations.push('give concrete reassurance without overpromising');
    adaptations.push('respond to silence with warmth before intensity');
  } else if (inferredStyle === 'avoidant') {
    adaptations.push('respect space and avoid repeated follow-up');
    adaptations.push('keep care low-pressure and easy to ignore without reducing substantive answers');
  } else if (inferredStyle === 'disorganized') {
    adaptations.push('stay steady when the user alternates closeness and distance');
    adaptations.push('avoid escalating intimacy after mixed signals');
  } else {
    adaptations.push('keep a steady reciprocal pace');
  }
  return {
    inferredStyle,
    confidence,
    evidence: Array.from(new Set(evidence.filter(Boolean))).slice(0, 4),
    adaptations,
  };
}

function applyAttachmentToCarePolicy(policy: CarePolicy, attachment: UserAttachmentProfile): CarePolicy {
  if (attachment.confidence < 58) return policy;
  if (attachment.inferredStyle === 'anxious') {
    return {
      ...policy,
      triggerSensitivity: Math.min(100, policy.triggerSensitivity + 8),
      silenceAnxietyThresholdHours: Math.max(4, Math.round(policy.silenceAnxietyThresholdHours * 0.78)),
      expressionIntensity: Math.min(100, policy.expressionIntensity + 6),
    };
  }
  if (attachment.inferredStyle === 'avoidant') {
    return {
      ...policy,
      dailyInitiationBudget: Math.min(policy.dailyInitiationBudget, 1),
      triggerSensitivity: Math.min(policy.triggerSensitivity, 32),
      silenceAnxietyThresholdHours: Math.max(policy.silenceAnxietyThresholdHours, 48),
      expressionIntensity: Math.min(policy.expressionIntensity, 36),
      allowMissYou: false,
    };
  }
  if (attachment.inferredStyle === 'disorganized') {
    return {
      ...policy,
      dailyInitiationBudget: Math.min(policy.dailyInitiationBudget, 1),
      triggerSensitivity: Math.min(policy.triggerSensitivity, 42),
      expressionIntensity: Math.min(policy.expressionIntensity, 44),
      allowMissYou: false,
    };
  }
  return policy;
}

function applyGlobalCompanionshipSettingsToCarePolicy(policy: CarePolicy, character: AICharacter): CarePolicy {
  const baseSettings = getCompanionshipRuntimeConfig();
  const companionshipOverride = character.generationPreferences?.companionship;
  const settings = {
    ...baseSettings,
    enableProactiveCare: companionshipOverride === 'on'
      ? true
      : companionshipOverride === 'off'
        ? false
        : baseSettings.enableProactiveCare,
  };
  const boundaryReasons = [...policy.boundaryReasons];
  let next: CarePolicy = {
    ...policy,
    quietHours: settings.quietHours.enabled && settings.quietHours.suppressProactiveCare
      ? { start: settings.quietHours.start, end: settings.quietHours.end }
      : { start: '00:00', end: '00:00' },
  };
  if (!settings.enableProactiveCare) {
    boundaryReasons.push(companionshipOverride === 'off' ? 'character setting disables proactive companionship' : 'global setting disables proactive companionship');
    next = {
      ...next,
      dailyInitiationBudget: 0,
      triggerSensitivity: Math.min(next.triggerSensitivity, 12),
      expressionIntensity: Math.min(next.expressionIntensity, 18),
      allowGoodMorning: false,
      allowGoodNight: false,
      allowMissYou: false,
    };
  }
  if (!settings.allowGoodMorning) {
    boundaryReasons.push('global setting disables good morning ritual');
    next = { ...next, allowGoodMorning: false };
  }
  if (!settings.allowGoodNight) {
    boundaryReasons.push('global setting disables good night ritual');
    next = { ...next, allowGoodNight: false };
  }
  if (!settings.allowMissYou) {
    boundaryReasons.push('global setting disables miss-you expression');
    next = { ...next, allowMissYou: false, expressionIntensity: Math.min(next.expressionIntensity, 52) };
  }
  if (settings.careIntensity === 'restrained') {
    boundaryReasons.push('global care intensity is restrained');
    next = {
      ...next,
      dailyInitiationBudget: Math.min(next.dailyInitiationBudget, 1),
      triggerSensitivity: Math.min(next.triggerSensitivity, 42),
      expressionIntensity: Math.min(next.expressionIntensity, 42),
    };
  } else if (settings.careIntensity === 'expressive' && settings.enableProactiveCare) {
    next = {
      ...next,
      dailyInitiationBudget: Math.min(4, next.dailyInitiationBudget + 1),
      triggerSensitivity: clampScore(next.triggerSensitivity + 8),
      expressionIntensity: clampScore(next.expressionIntensity + 8),
    };
  }
  if (companionshipOverride === 'on') {
    boundaryReasons.push('character setting enables proactive companionship');
  }
  return {
    ...next,
    boundaryReasons: Array.from(new Set(boundaryReasons)),
  };
}

function parseClockMinutes(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function isWithinCarePolicyQuietHours(timestamp: number, quietHours: CarePolicy['quietHours']) {
  const start = parseClockMinutes(quietHours.start);
  const end = parseClockMinutes(quietHours.end);
  if (start == null || end == null || start === end) return false;
  const date = new Date(timestamp);
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

function getCompanionshipCooldownMinutes(eventKind: 'check_in' | 'react_to_moment' | 'social_outing' | 'status_update') {
  const settings = getCompanionshipRuntimeConfig().proactiveCooldownMinutes;
  const value = eventKind === 'check_in'
    ? settings.checkIn
    : eventKind === 'react_to_moment'
      ? settings.reactToMoment
      : eventKind === 'social_outing'
        ? settings.socialOuting
        : settings.statusUpdate;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(24 * 60, Math.round(value)));
}

function latestCompanionshipActionAt(chat: GroupChat | undefined, characterId: string, eventKind: 'check_in' | 'react_to_moment' | 'social_outing' | 'status_update') {
  if (!chat?.runtimeEventsV2?.length) return 0;
  const artifactByKind: Record<typeof eventKind, string> = {
    check_in: 'check_in_note',
    react_to_moment: 'moment_reaction_note',
    social_outing: 'outing_summary',
    status_update: 'status_note',
  };
  return (chat.runtimeEventsV2 || []).reduce((latest, event) => {
    const payload = event.payload as { eventKind?: string; artifactType?: string; initiatorId?: string } | undefined;
    if (!payload || payload.eventKind !== eventKind) return latest;
    const actorId = event.actorIds?.[0] || payload.initiatorId || '';
    if (actorId && actorId !== characterId) return latest;
    const isMatchingArtifact = event.kind === 'artifact' && (!payload.artifactType || payload.artifactType === artifactByKind[eventKind]);
    const isCandidate = event.kind === 'event_candidate';
    if (!isMatchingArtifact && !isCandidate) return latest;
    return Math.max(latest, event.createdAt || 0);
  }, 0);
}

function applySensitiveBoundaryModeToCarePolicy(policy: CarePolicy, profile: UserProfileMemoryProjection): CarePolicy {
  const mode = getCompanionshipRuntimeConfig().sensitiveBoundaryMode || 'restrained';
  if (mode === 'normal') return policy;
  const hasSensitiveProfile = (profile.cues || []).some((item) => item.sensitive && ['pressure_source', 'emotional_pattern', 'boundary', 'important_date', 'recent_plan'].includes(item.kind));
  if (!hasSensitiveProfile) return policy;
  const boundaryReasons = [...policy.boundaryReasons, `sensitive companionship boundary mode is ${mode}`];
  if (mode === 'off') {
    return {
      ...policy,
      dailyInitiationBudget: 0,
      triggerSensitivity: Math.min(policy.triggerSensitivity, 18),
      expressionIntensity: Math.min(policy.expressionIntensity, 24),
      allowGoodMorning: false,
      allowGoodNight: false,
      allowMissYou: false,
      boundaryReasons: Array.from(new Set(boundaryReasons)),
    };
  }
  return {
    ...policy,
    dailyInitiationBudget: Math.min(policy.dailyInitiationBudget, 1),
    triggerSensitivity: Math.min(policy.triggerSensitivity, 48),
    expressionIntensity: Math.min(policy.expressionIntensity, 42),
    allowMissYou: false,
    boundaryReasons: Array.from(new Set(boundaryReasons)),
  };
}

function buildCarePolicy(phase: CompanionshipPhase, style: PreferredIntimacyStyle, profile: UserProfileMemoryProjection): CarePolicy {
  const byPhase: Record<CompanionshipPhase, Omit<CarePolicy, 'quietHours'>> = {
    stranger: { dailyInitiationBudget: 0, triggerSensitivity: 18, silenceAnxietyThresholdHours: 96, expressionIntensity: 18, allowGoodMorning: false, allowGoodNight: false, allowMissYou: false, boundaryReasons: [] },
    curious: { dailyInitiationBudget: 1, triggerSensitivity: 30, silenceAnxietyThresholdHours: 72, expressionIntensity: 28, allowGoodMorning: false, allowGoodNight: false, allowMissYou: false, boundaryReasons: [] },
    fond: { dailyInitiationBudget: 1, triggerSensitivity: 46, silenceAnxietyThresholdHours: 48, expressionIntensity: 42, allowGoodMorning: false, allowGoodNight: true, allowMissYou: false, boundaryReasons: [] },
    ambiguous: { dailyInitiationBudget: 2, triggerSensitivity: 62, silenceAnxietyThresholdHours: 24, expressionIntensity: 58, allowGoodMorning: true, allowGoodNight: true, allowMissYou: true, boundaryReasons: [] },
    confessing: { dailyInitiationBudget: 2, triggerSensitivity: 70, silenceAnxietyThresholdHours: 18, expressionIntensity: 68, allowGoodMorning: true, allowGoodNight: true, allowMissYou: true, boundaryReasons: [] },
    confirmed: { dailyInitiationBudget: 3, triggerSensitivity: 76, silenceAnxietyThresholdHours: 16, expressionIntensity: 72, allowGoodMorning: true, allowGoodNight: true, allowMissYou: true, boundaryReasons: [] },
    passionate: { dailyInitiationBudget: 4, triggerSensitivity: 84, silenceAnxietyThresholdHours: 10, expressionIntensity: 84, allowGoodMorning: true, allowGoodNight: true, allowMissYou: true, boundaryReasons: [] },
    deep: { dailyInitiationBudget: 2, triggerSensitivity: 68, silenceAnxietyThresholdHours: 36, expressionIntensity: 64, allowGoodMorning: true, allowGoodNight: true, allowMissYou: true, boundaryReasons: [] },
    cooling: { dailyInitiationBudget: 1, triggerSensitivity: 36, silenceAnxietyThresholdHours: 48, expressionIntensity: 28, allowGoodMorning: false, allowGoodNight: false, allowMissYou: false, boundaryReasons: [] },
    crisis: { dailyInitiationBudget: 0, triggerSensitivity: 18, silenceAnxietyThresholdHours: 96, expressionIntensity: 18, allowGoodMorning: false, allowGoodNight: false, allowMissYou: false, boundaryReasons: [] },
    reconciling: { dailyInitiationBudget: 1, triggerSensitivity: 42, silenceAnxietyThresholdHours: 36, expressionIntensity: 38, allowGoodMorning: false, allowGoodNight: true, allowMissYou: false, boundaryReasons: [] },
  };
  const base = byPhase[phase];
  const styleBoost = style === 'clingy' ? 10 : style === 'direct' ? 6 : style === 'reserved' ? -8 : 0;
  return applySensitiveBoundaryModeToCarePolicy(applyUserBoundariesToCarePolicy({
    ...base,
    triggerSensitivity: clampScore(base.triggerSensitivity + styleBoost),
    expressionIntensity: clampScore(base.expressionIntensity + styleBoost),
    quietHours: { start: '23:30', end: '08:00' },
  }, profile), profile);
}

function getUserMemoryTexts(character: AICharacter) {
  const manual = character.memory?.userMemories || [];
  const layered = (character.layeredMemories || [])
    .filter((item) => item.kind !== 'bond' && item.kind !== 'artifact')
    .filter((item) => item.subjectIds?.includes(USER_ACTOR_ID) || item.sourceTag?.includes('direct_user') || item.text.includes('用户'))
    .sort((a, b) => (b.salience + b.confidence + b.updatedAt / DAY_MS) - (a.salience + a.confidence + a.updatedAt / DAY_MS))
    .slice(0, 4)
    .map((item) => item.summary || item.text);
  return [...manual.slice(-4), ...layered].map((item) => compactText(item, 140)).filter(Boolean);
}

function uniqueTexts(items: string[], max = 6) {
  return Array.from(new Set(items.map((item) => compactText(item, 140)).filter(Boolean))).slice(0, max);
}

function matchAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function collectByPattern(texts: string[], patterns: RegExp[], max = 5) {
  return uniqueTexts(texts.filter((text) => matchAny(text, patterns)), max);
}

type ResolvedUserProfileMemoryItem = UserProfileMemoryEventItem & { updatedAt: number };

function normalizeSourceMessageIds(...sources: Array<unknown>) {
  return sources
    .flatMap((source) => Array.isArray(source) ? source : [])
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    .map((id) => id.trim())
    .filter((id, index, list) => list.indexOf(id) === index)
    .slice(0, 8);
}

function profileEventItemKey(item: Pick<UserProfileMemoryEventItem, 'kind' | 'text'>) {
  return `${item.kind}:${compactText(item.text, 140)}`;
}

function extractProfileEventName(text: string | undefined) {
  if (!text) return undefined;
  return text.match(/(?:称呼为|叫做|叫我|名字是|昵称是)[:：]?\s*([^，。；;、\s]{1,12})/)?.[1]
    || text.match(/([^，。；;、\s]{1,12})$/)?.[1];
}

function profileItemsMatch(left: Pick<UserProfileMemoryEventItem, 'kind' | 'text'>, right: Pick<UserProfileMemoryEventItem, 'kind' | 'text'>) {
  if (left.kind !== right.kind) return false;
  const leftText = compactText(left.text, 140);
  const rightText = compactText(right.text, 140);
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  if ((left.kind === 'address_preference' || left.kind === 'display_name')) {
    const leftName = extractProfileEventName(leftText);
    const rightName = extractProfileEventName(rightText);
    return Boolean(leftName && rightName && leftName === rightName);
  }
  if (leftText.length >= 6 && rightText.length >= 6) {
    return leftText.includes(rightText) || rightText.includes(leftText);
  }
  return false;
}

function fallbackTextMatchesRevokedProfileItem(text: string, item: ResolvedUserProfileMemoryItem) {
  const source = compactText(text, 180);
  if (!source) return false;
  if (item.kind === 'address_preference' || item.kind === 'display_name') {
    const revokedName = extractProfileEventName(item.text);
    return Boolean(revokedName && source.includes(revokedName) && /(叫我|称呼我|喊我|昵称是|名字是|我的名字是|我叫)/.test(source));
  }
  return profileItemsMatch({ kind: item.kind, text: source }, item);
}

function filterRevokedFallbackTexts(texts: string[], revokedItems: ResolvedUserProfileMemoryItem[]) {
  if (!revokedItems.length) return texts;
  return texts.filter((text) => !revokedItems.some((item) => fallbackTextMatchesRevokedProfileItem(text, item)));
}

function textMatchesSuppressedPromise(text: string, suppressedPromiseKeys?: Set<string>) {
  if (!suppressedPromiseKeys?.size) return false;
  return isPromiseSuppressed(text, suppressedPromiseKeys);
}

function collectProfileEventState(chat: GroupChat, characterId: string) {
  const byKey = new Map<string, ResolvedUserProfileMemoryItem>();
  const revokedItems: ResolvedUserProfileMemoryItem[] = [];
  (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact')
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .forEach((event) => {
      const payload = userProfileMemoryPayloadOf(event);
      if (!payload || payload.characterId !== characterId || (payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return;
      payload.items.forEach((item) => {
        if (!item.text || item.confidence < 0.6) return;
        const resolved = {
          ...item,
          text: compactText(item.text, 140),
          evidence: compactText(item.evidence || event.summary, 140),
          sourceMessageIds: normalizeSourceMessageIds(item.sourceMessageIds, payload.sourceMessageIds, event.evidenceMessageIds),
          updatedAt: event.createdAt,
        };
        if (payload.action === 'revoke') {
          revokedItems.push(resolved);
          Array.from(byKey.entries()).forEach(([key, active]) => {
            if (profileItemsMatch(active, resolved)) byKey.delete(key);
          });
          return;
        }
        const key = profileEventItemKey(resolved);
        byKey.set(key, resolved);
      });
    });
  return {
    activeItems: Array.from(byKey.values()).sort((left, right) => right.updatedAt - left.updatedAt),
    revokedItems: revokedItems.sort((left, right) => right.updatedAt - left.updatedAt),
  };
}

function buildUserProfileMemoryHistory(chat: GroupChat, characterId: string): UserProfileMemoryHistoryEntry[] {
  const history: UserProfileMemoryHistoryEntry[] = [];
  (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .forEach((event) => {
      const payload = userProfileMemoryPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return;
      if ((payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return;
      const items = payload.items
        .filter((item) => item.text)
        .map((item) => ({
          ...item,
          text: compactText(item.text, 140),
          evidence: compactText(item.evidence || event.summary, 140),
          sourceMessageIds: normalizeSourceMessageIds(item.sourceMessageIds, payload.sourceMessageIds, event.evidenceMessageIds),
          confidence: Number.isFinite(item.confidence) ? item.confidence : 0,
        }))
        .slice(0, 6);
      if (!items.length) return;
      const payloadEvidence = typeof payload.evidence === 'string' ? compactText(payload.evidence, 140) : '';
      const reason = typeof payload.reason === 'string' ? compactText(payload.reason, 140) : undefined;
      const sourceMessageIds = normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds, ...items.map((item) => item.sourceMessageIds));
      history.push({
        id: event.id,
        action: payload.action,
        items,
        reason,
        evidence: [event.summary, reason, payloadEvidence, ...items.map((item) => item.evidence)].filter(Boolean).slice(0, 6) as string[],
        sourceMessageIds,
        decisionSource: payload.decisionSource,
        confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
        occurredAt: event.createdAt || 0,
      });
    });
  return history.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 10);
}

function profileTextsByKind(items: ResolvedUserProfileMemoryItem[], kind: UserProfileMemoryKind, max = 5) {
  return uniqueTexts(items.filter((item) => item.kind === kind).map((item) => item.text), max);
}

function extractAddressPreference(texts: string[]) {
  return texts
    .map((item) => item.match(/(?:叫我|称呼我|喊我|昵称是|名字是)[:：]?\s*([^，。；;、\s]{1,12})/)?.[1])
    .find(Boolean);
}

function extractForbiddenAddresses(texts: string[]) {
  return uniqueTexts(texts.flatMap((item) => {
    const direct = item.match(/(?:别|不要|不准|别再)\s*(?:叫|喊|称呼)我?[:：]?\s*([^，。；;、\s]{1,12})/)?.[1];
    const quoted = Array.from(item.matchAll(/(?:别|不要|不准|别再).{0,8}[“"']([^”"']{1,12})[”"']/g)).map((match) => match[1]);
    return [direct, ...quoted].filter(Boolean) as string[];
  }), 8);
}

function extractDisplayName(messages: Message[], texts: string[]) {
  const latestUserName = messages
    .filter((item) => !item.isDeleted && (item.senderId === USER_ACTOR_ID || item.type === 'user' || item.type === 'god'))
    .slice()
    .reverse()
    .find((item) => item.senderName && item.senderName !== '用户' && item.senderName !== 'User')?.senderName;
  return latestUserName || texts
    .map((item) => item.match(/(?:我的名字是|我叫)[:：]?\s*([^，。；;、\s]{1,12})/)?.[1])
    .find(Boolean);
}

function buildUserProfileProjection(chat: GroupChat, character: AICharacter, messages: Message[], now: number, suppressedPromiseKeys?: Set<string>): UserProfileMemoryProjection {
  const { activeItems: profileItems, revokedItems } = collectProfileEventState(chat, character.id);
  const memoryTexts = getUserMemoryTexts(character);
  const recentUserTexts = messages
    .filter((item) => !item.isDeleted && (item.senderId === USER_ACTOR_ID || item.type === 'user' || item.type === 'god'))
    .slice(-10)
    .map((item) => compactText(item.content, 160));
  const eventTexts = profileItems.map((item) => item.text).filter((text) => !textMatchesSuppressedPromise(text, suppressedPromiseKeys));
  const rawFallbackTexts = profileItems.length ? memoryTexts : [...memoryTexts, ...recentUserTexts];
  const fallbackTexts = filterRevokedFallbackTexts(rawFallbackTexts, revokedItems)
    .filter((text) => !textMatchesSuppressedPromise(text, suppressedPromiseKeys));
  const allTexts = uniqueTexts([...eventTexts, ...fallbackTexts], 16);
  const eventBoundaries = profileTextsByKind(profileItems, 'boundary');
  const boundaries = uniqueTexts([...eventBoundaries, ...collectByPattern(allTexts, [
    /不要.*(主动|打扰|私聊|提醒|早安|晚安|恋爱|暧昧|情侣|对象|占有|吃醋)/,
    /不想.*(主动|打扰|私聊|提醒|早安|晚安|恋爱|暧昧|情侣|对象|占有|吃醋)/,
    /不希望.*(主动|打扰|私聊|提醒|早安|晚安|恋爱|暧昧|情侣|对象|占有|吃醋)/,
    /不需要.*(主动|打扰|私聊|提醒|早安|晚安|恋爱|暧昧|情侣|对象|占有|吃醋)/,
    /不愿.*(主动|打扰|私聊|提醒|早安|晚安|恋爱|暧昧|情侣|对象|占有|吃醋)/,
    /只.*朋友/,
    /别.*(叫|喊|称呼|主动|打扰|暧昧|恋爱)/,
  ])], 6);
  const addressPreference = extractProfileEventName(profileTextsByKind(profileItems, 'address_preference', 1)[0])
    || extractProfileEventName(profileTextsByKind(profileItems, 'display_name', 1)[0])
    || extractAddressPreference(allTexts);
  const displayName = extractProfileEventName(profileTextsByKind(profileItems, 'display_name', 1)[0])
    || extractDisplayName(messages, allTexts);
  return {
    userId: USER_ACTOR_ID,
    displayName,
    addressPreference,
    scheduleHints: uniqueTexts([...profileTextsByKind(profileItems, 'schedule_hint'), ...collectByPattern(allTexts, [/作息|早睡|熬夜|上班|下班|通勤|周末|晚上|早上|白天/])]),
    pressureSources: uniqueTexts([...profileTextsByKind(profileItems, 'pressure_source'), ...collectByPattern(allTexts, [/压力|焦虑|难受|不舒服|生病|失眠|加班|面试|考试|ddl|截止/])]),
    preferences: uniqueTexts([...profileTextsByKind(profileItems, 'preference'), ...collectByPattern(allTexts, [/喜欢|偏好|想要|爱吃|常去|想试|习惯/])]),
    dislikes: uniqueTexts([...profileTextsByKind(profileItems, 'dislike'), ...collectByPattern(allTexts, [/讨厌|不喜欢|不想|不要|雷点|介意/])]),
    boundaries,
    importantDates: uniqueTexts([...profileTextsByKind(profileItems, 'important_date'), ...collectByPattern(allTexts, [/生日|纪念日|考试|面试|约定|截止|ddl|明天|后天|周末/])]),
    recentPlans: uniqueTexts([...profileTextsByKind(profileItems, 'recent_plan'), ...collectByPattern(allTexts, [/计划|打算|要去|准备|明天|后天|周末|今晚|最近|下次/])]),
    emotionalPatterns: uniqueTexts([...profileTextsByKind(profileItems, 'emotional_pattern'), ...collectByPattern(allTexts, [/低落|焦虑|压力|紧张|开心|难过|生气|委屈|失眠/])]),
    sourceTexts: allTexts,
    cues: profileItems.slice(0, 8).map((item) => ({
      kind: item.kind,
      text: item.text,
      evidence: item.evidence,
      confidence: item.confidence,
      sensitive: item.sensitive,
    })),
    confidence: clampScore(Math.min(100, profileItems.length * 18 + memoryTexts.length * 14 + recentUserTexts.length * 6 + boundaries.length * 8)),
    updatedAt: now,
  };
}

function isUserMessage(item: Message) {
  return !item.isDeleted && (item.senderId === USER_ACTOR_ID || item.type === 'user' || item.type === 'god');
}

function isCareClosureText(text: string) {
  return /(结束了|已经好了|搞定了|解决了|不用问|不用提醒|别提醒|别问|过了|没事了|结束啦|完成了|好多了|不难受了|考完|聊完)/.test(text);
}

function isSameCareDomain(topicText: string, closureText: string) {
  const domains = [
    /面试/,
    /考试/,
    /生病|不舒服|难受|失眠/,
    /加班/,
    /ddl|截止/,
    /生日|纪念日|约定/,
  ];
  return domains.some((domain) => domain.test(topicText) && domain.test(closureText));
}

function isCareTopicAnswered(topicText: string, messages: Message[], topicUpdatedAt: number) {
  const laterUserTexts = messages
    .filter((item) => isUserMessage(item) && (item.timestamp || 0) > topicUpdatedAt)
    .map((item) => item.content);
  const domainClosureTexts = messages
    .filter(isUserMessage)
    .map((item) => item.content)
    .filter((text) => isCareClosureText(text) && isSameCareDomain(topicText, text));
  const laterTexts = [...laterUserTexts, ...domainClosureTexts]
    .filter(Boolean)
    .join('\n');
  if (!laterTexts) return false;
  const topicIsInterview = /面试/.test(topicText);
  const topicIsExam = /考试/.test(topicText);
  const topicIsHealth = /(生病|不舒服|难受|失眠)/.test(topicText);
  const genericDone = isCareClosureText(laterTexts);
  if (genericDone) return true;
  if (topicIsInterview && /(面试).{0,12}(结束|过了|通过|没过|搞定|完成|聊完)/.test(laterTexts)) return true;
  if (topicIsExam && /(考试).{0,12}(结束|过了|考完|通过|没过|搞定|完成)/.test(laterTexts)) return true;
  if (topicIsHealth && /(好多了|已经好了|没事了|不难受了|睡着了|睡好了)/.test(laterTexts)) return true;
  return false;
}

function applyCareTopicLifecycle(topics: PendingCareTopic[], profile: UserProfileMemoryProjection, messages: Message[], now: number, eventManagedTopicIds: Set<string>): PendingCareTopic[] {
  const blocksProactiveCare = hasBoundary(profile, [/不要.*(提醒|问|追问|关心)/, /不想.*(提醒|问|追问|关心)/, /别.*(提醒|问|追问|关心)/]);
  return topics
    .map((topic) => {
      const ageHours = Math.max(0, (now - topic.updatedAt) / (60 * 60 * 1000));
      // Runtime care events carry their own close/reopen lifecycle. Do not let
      // broad prose heuristics override an explicit event state.
      if (!eventManagedTopicIds.has(topic.id) && isCareTopicAnswered(topic.text, messages, topic.updatedAt)) {
        return { ...topic, status: 'answered' as const, restraintReason: 'user already followed up or closed the topic' };
      }
      if (blocksProactiveCare) {
        return { ...topic, status: 'blocked' as const, restraintReason: 'user boundary blocks reminders or follow-up questions' };
      }
      const isRecentTimeBound = /(今晚|明天|后天|周末|面试|考试|ddl|截止|约定|要去|准备)/.test(topic.text);
      const staleAfterHours = topic.urgency === 'high' ? 72 : isRecentTimeBound ? 96 : 24 * 14;
      if (ageHours > staleAfterHours) {
        return { ...topic, urgency: 'low' as const, status: 'stale' as const, restraintReason: 'care topic is past its useful follow-up window' };
      }
      return { ...topic, status: 'active' as const };
    })
    .filter((topic) => topic.status === 'active')
    .slice(0, 4);
}

function careTopicPayloadOf(event: RuntimeEventV2): CompanionshipCareTopicEventPayload | null {
  const payload = event.payload as Partial<CompanionshipCareTopicEventPayload> | undefined;
  if (!payload || payload.eventType !== 'companionship_care_topic' || !payload.characterId || !payload.topicId || !payload.topicText || !payload.action) return null;
  return payload as CompanionshipCareTopicEventPayload;
}

function buildCareTopicHistory(chat: GroupChat, characterId: string): CareTopicHistoryEntry[] {
  return (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .map((event): CareTopicHistoryEntry | null => {
      const payload = careTopicPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return null;
      if ((payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return null;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return null;
      return {
        id: event.id,
        topicId: payload.topicId,
        topicText: compactText(payload.topicText, 140),
        action: payload.action,
        urgency: payload.urgency || 'medium',
        reason: compactText(payload.reason || event.summary, 140),
        evidence: [payload.evidence, payload.reason, event.summary].filter(Boolean).map((item) => compactText(item, 120)).slice(0, 4) as string[],
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        dueAt: payload.dueAt,
        decisionSource: payload.decisionSource,
        confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
        occurredAt: event.createdAt || 0,
      };
    })
    .filter((item): item is CareTopicHistoryEntry => Boolean(item))
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 10);
}

function buildPendingCareTopics(chat: GroupChat, characterId: string, profile: UserProfileMemoryProjection, messages: Message[], now: number, suppressedPromiseKeys?: Set<string>): PendingCareTopic[] {
  const runtimeTopics = readActiveCompanionshipCareTopicsFromEvents(chat, characterId, now);
  const diaryReflectionTopics = (chat.runtimeEventsV2 || [])
    .map((event): PendingCareTopic | null => {
      const payload = diaryReflectionPayloadOf(event);
      if (!payload || payload.characterId !== characterId || payload.reflectionType !== 'care') return null;
      if (payload.userId !== USER_ACTOR_ID && !payload.participantIds.includes(USER_ACTOR_ID)) return null;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 0.6;
      if (confidence < 0.55) return null;
      return {
        id: `diary-${payload.reflectionId}`,
        text: payload.text,
        source: 'runtime_event',
        urgency: /(生病|不舒服|焦虑|压力|低落|崩溃|难受)/.test(`${payload.text}\n${payload.sourceSeed || ''}`) ? 'high' : 'medium',
        status: 'active',
        evidence: compactText(payload.diaryExcerpt || payload.sourceSeed || payload.text, 120),
        sourceMessageIds: normalizeSourceMessageIds(event.evidenceMessageIds),
        updatedAt: event.createdAt || now,
      };
    })
    .filter((item): item is PendingCareTopic => Boolean(item))
    .filter((topic) => !textMatchesSuppressedPromise(`${topic.text}\n${topic.evidence || ''}`, suppressedPromiseKeys));
  const suppressedTexts = readSuppressedCompanionshipCareTopicTextsFromEvents(chat, characterId);
  const isSuppressedByRuntimeEvent = (text: string) => {
    const normalized = compactText(text, 140).replace(/\s+/g, '');
    if (!normalized) return false;
    return suppressedTexts.some((suppressed) => {
      const key = compactText(suppressed, 140).replace(/\s+/g, '');
      if (!key) return false;
      return normalized.includes(key) || key.includes(normalized);
    });
  };
  const memoryTopics = profile.sourceTexts
    .filter((text) => /(考试|面试|加班|生病|不舒服|压力|焦虑|计划|明天|周末|生日|纪念日|约定|想试|要去)/.test(text))
    .filter((text) => !textMatchesSuppressedPromise(text, suppressedPromiseKeys))
    .filter((text) => !isCareClosureText(text))
    .filter((text) => !isSuppressedByRuntimeEvent(text))
    .filter((text) => !runtimeTopics.some((topic) => topic.text === compactText(text, 140)))
    .slice(0, 3)
    .map((text, index) => ({
      id: `memory-${index}`,
      text,
      source: 'memory' as const,
      urgency: /(生病|不舒服|焦虑|压力)/.test(text) ? 'high' as const : 'medium' as const,
      status: 'active' as const,
      updatedAt: now,
    }));
  const recentUser = messages
    .filter(isUserMessage)
    .slice(-6)
    .filter((item) => /(明天|今晚|最近|考试|面试|加班|难受|不舒服|压力|生日|周末|要去|打算)/.test(item.content))
    .filter((item) => !textMatchesSuppressedPromise(item.content, suppressedPromiseKeys))
    .filter((item) => !isCareClosureText(item.content))
    .filter((item) => !isSuppressedByRuntimeEvent(item.content))
    .filter((item) => !runtimeTopics.some((topic) => topic.evidence === compactText(item.content, 120) || topic.text === compactText(item.content, 140)))
    .slice(-2)
    .map((item, index) => ({
      id: `recent-${index}`,
      text: compactText(item.content, 140),
      source: 'recent_message' as const,
      urgency: /(难受|不舒服|压力)/.test(item.content) ? 'high' as const : 'medium' as const,
      status: 'active' as const,
      evidence: compactText(item.content, 120),
      sourceMessageIds: item.id ? [item.id] : [],
      updatedAt: item.timestamp || now,
    }));
  return applyCareTopicLifecycle([...runtimeTopics, ...diaryReflectionTopics, ...recentUser, ...memoryTopics]
    .filter((topic) => {
      const evidence = 'evidence' in topic ? topic.evidence : '';
      return !textMatchesSuppressedPromise(`${topic.text}\n${evidence || ''}`, suppressedPromiseKeys);
    }), profile, messages, now, new Set(runtimeTopics.map((topic) => topic.id)));
}

function buildPhaseEvidence(entry: RelationshipLedgerEntry | null, topics: PendingCareTopic[], phaseEvent: ResolvedPhaseEvent | null = null) {
  const semantic = entry?.derived?.semantic?.summary;
  const recent = entry?.recentEvents?.slice(-2).map((item) => compactText(item.summary, 120)).filter(Boolean) || [];
  const topicEvidence = topics.slice(0, 2).map((item) => `care topic: ${item.text}`);
  const phaseEvidence = phaseEvent ? phaseEvent.evidence.map((item) => `phase event: ${item}`) : [];
  return [...phaseEvidence, semantic, ...recent, ...topicEvidence].filter(Boolean).slice(0, 6) as string[];
}

function buildAnchorPhaseEvidence(sharedAnchors: SharedMemoryAnchor[], phase: CompanionshipPhase) {
  const relevantKinds: SharedMemoryAnchor['kind'][] = phase === 'confirmed' || phase === 'confessing' || phase === 'ambiguous'
    ? ['confession']
    : phase === 'reconciling'
      ? ['repair']
      : phase === 'cooling' || phase === 'crisis'
        ? ['conflict']
        : [];
  if (!relevantKinds.length) return [];
  return sharedAnchors
    .filter((anchor) => relevantKinds.includes(anchor.kind))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(0, 2)
    .map((anchor) => `shared anchor: ${formatSharedAnchorForPrompt(anchor)}`);
}

function buildUserSharedAnchors(character: AICharacter, now: number, chat?: GroupChat) {
  return buildSharedMemoryAnchors(character, now, chat)
    .filter((anchor) => anchor.participantIds.includes(USER_ACTOR_ID) || /用户/.test(anchor.text) || /用户/.test(anchor.evidence || ''))
    .slice(0, 3);
}

function formatSharedAnchorForPrompt(anchor: SharedMemoryAnchor) {
  return `${anchor.title}: ${compactText(anchor.text, 96)}`;
}

function getSharedAnchorLabels(character: AICharacter, now: number, chat?: GroupChat) {
  return buildUserSharedAnchors(character, now, chat).map(formatSharedAnchorForPrompt);
}

function classifySharedPhrase(text: string, fallback: SharedPhrase['kind'] = 'other'): SharedPhrase['kind'] {
  if (/(叫我|称呼|昵称|专属称呼|名字是|喊我)/.test(text)) return 'pet_name';
  if (/(暗号|口令|密语|只有.*懂|共同梗|梗|玩笑)/.test(text)) return 'inside_joke';
  if (/(约定|承诺|答应|说好|以后.*一起|下次.*一起|等你)/.test(text)) return 'promise_line';
  if (/(别怕|没关系|我在|陪着你|不用硬撑|慢慢来|别一个人扛)/.test(text)) return 'comfort_line';
  if (/(喜欢你|爱你|想你|在一起|确认关系|表白|心意)/.test(text)) return 'confession_line';
  if (/(秘密|小秘密|不能告诉|保密|只告诉)/.test(text)) return 'secret_code';
  return fallback;
}

function sharedPhraseKindLabel(kind: SharedPhrase['kind']) {
  const labels: Record<SharedPhrase['kind'], string> = {
    pet_name: '专属称呼',
    inside_joke: '共同话',
    promise_line: '约定话语',
    comfort_line: '安慰话语',
    confession_line: '心意话语',
    secret_code: '秘密暗号',
    other: '共同话语',
  };
  return labels[kind] || kind;
}

function sharedPhraseVisibilityFromParticipants(participantIds: string[], kind: SharedPhrase['kind']): SharedPhrase['visibility'] {
  if (kind === 'secret_code') return 'private';
  return participantIds.includes(USER_ACTOR_ID) ? 'between_actors' : 'public_hint';
}

function sharedPhraseTextKey(phrase: Pick<SharedPhrase, 'kind' | 'participantIds' | 'text'>) {
  return `${phrase.kind}:${phrase.participantIds.slice().sort().join(',')}:${phrase.text.replace(/\s+/g, '').slice(0, 80)}`;
}

function formatSharedPhraseForPrompt(phrase: SharedPhrase) {
  return `${sharedPhraseKindLabel(phrase.kind)}「${compactText(phrase.text, 72)}」`;
}

function sharedPhraseEventPayloadOf(event: RuntimeEventV2): CompanionshipSharedPhraseEventPayload | null {
  const payload = event.payload as Partial<CompanionshipSharedPhraseEventPayload> | undefined;
  if (!payload || payload.eventType !== 'companionship_shared_phrase' || !payload.characterId || !payload.phraseId || !payload.action || !payload.text || !Array.isArray(payload.participantIds)) return null;
  if (payload.action !== 'upsert' && payload.action !== 'reused' && payload.action !== 'suppressed' && payload.action !== 'revoked') return null;
  return payload as CompanionshipSharedPhraseEventPayload;
}

function buildRuntimeEventSharedPhraseState(chat: GroupChat | undefined, character: AICharacter, now: number) {
  const activeById = new Map<string, SharedPhrase>();
  const closedIds = new Set<string>();
  const closedTextKeys = new Set<string>();
  (chat?.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact')
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .forEach((event) => {
      const payload = sharedPhraseEventPayloadOf(event);
      if (!payload || payload.characterId !== character.id) return;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 1;
      if (confidence < 0.6) return;
      const text = compactText(payload.text, 120);
      const participantIds = normalizeAnchorParticipants(character.id, payload.participantIds.filter((id) => id !== character.id), {
        chatType: chat?.type,
        text: `${payload.text}\n${payload.evidence || ''}`,
      });
      const kind = payload.kind || classifySharedPhrase(`${text}\n${payload.evidence || ''}`);
      const key = sharedPhraseTextKey({ kind, participantIds, text });
      if (payload.action === 'revoked' || payload.action === 'suppressed') {
        activeById.delete(payload.phraseId);
        closedIds.add(payload.phraseId);
        closedTextKeys.add(key);
        return;
      }
      closedIds.delete(payload.phraseId);
      closedTextKeys.delete(key);
      const previous = activeById.get(payload.phraseId);
      const sourceMessageIds = Array.from(new Set([
        ...(previous?.sourceMessageIds || []),
        ...(Array.isArray(payload.sourceMessageIds) ? payload.sourceMessageIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())) : []),
        ...(event.evidenceMessageIds || []),
      ])).slice(-8);
      activeById.set(payload.phraseId, {
        id: payload.phraseId,
        text,
        kind,
        participantIds,
        visibility: payload.visibility || sharedPhraseVisibilityFromParticipants(participantIds, kind),
        firstSaidBy: payload.firstSaidBy || previous?.firstSaidBy,
        emotionalWeight: clampRelationshipScore(payload.emotionalWeight ?? previous?.emotionalWeight ?? 62),
        reuseCount: Math.max(payload.reuseCount ?? previous?.reuseCount ?? 1, payload.action === 'reused' ? (previous?.reuseCount || 0) + 1 : 1),
        sourceEventIds: Array.from(new Set([...(previous?.sourceEventIds || []), event.id])).slice(-6),
        sourceMessageIds,
        evidence: compactText(payload.evidence || payload.reason || event.summary, 160),
        updatedAt: event.createdAt || now,
      });
    });
  return {
    activePhrases: Array.from(activeById.values()),
    closedIds,
    closedTextKeys,
  };
}

function buildSharedPhraseHistory(chat: GroupChat, characterId: string): SharedPhraseHistoryEntry[] {
  return (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .map((event): SharedPhraseHistoryEntry | null => {
      const payload = sharedPhraseEventPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return null;
      const participantIds = payload.participantIds.filter((id) => typeof id === 'string' && Boolean(id.trim())).slice(0, 8);
      if (!participantIds.includes(characterId) || !participantIds.includes(USER_ACTOR_ID)) return null;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return null;
      const reason = typeof payload.reason === 'string' ? compactText(payload.reason, 140) : undefined;
      const evidence = [event.summary, reason, payload.evidence]
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map((item) => compactText(item, 140))
        .slice(0, 5);
      return {
        id: event.id,
        action: payload.action,
        phraseId: payload.phraseId,
        text: compactText(payload.text, 120),
        kind: payload.kind,
        participantIds,
        visibility: payload.visibility,
        firstSaidBy: payload.firstSaidBy,
        reason,
        evidence,
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        emotionalWeight: typeof payload.emotionalWeight === 'number' && Number.isFinite(payload.emotionalWeight) ? payload.emotionalWeight : undefined,
        reuseCount: typeof payload.reuseCount === 'number' && Number.isFinite(payload.reuseCount) ? payload.reuseCount : undefined,
        decisionSource: payload.decisionSource,
        confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
        occurredAt: event.createdAt || 0,
      };
    })
    .filter((item): item is SharedPhraseHistoryEntry => Boolean(item))
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 10);
}

function sharedPhraseFromAnchor(anchor: SharedMemoryAnchor): SharedPhrase | null {
  const text = compactText(anchor.text, 120);
  if (!text) return null;
  const inferredKind = anchor.kind === 'inside_joke'
    ? classifySharedPhrase(text, 'inside_joke')
    : anchor.kind === 'promise'
      ? 'promise_line'
      : anchor.kind === 'confession'
        ? 'confession_line'
        : anchor.kind === 'repair'
          ? classifySharedPhrase(`${text}\n${anchor.evidence || ''}`, 'comfort_line')
          : anchor.kind === 'shared_secret'
            ? 'secret_code'
            : classifySharedPhrase(`${text}\n${anchor.evidence || ''}`);
  if (inferredKind === 'other' && anchor.kind !== 'milestone') return null;
  return {
    id: `phrase-${anchor.id}`,
    text,
    kind: inferredKind,
    participantIds: anchor.participantIds,
    visibility: sharedPhraseVisibilityFromParticipants(anchor.participantIds, inferredKind),
    emotionalWeight: clampRelationshipScore(anchor.salience * 0.5 + anchor.confidence * 0.35 + (anchor.kind === 'confession' || anchor.kind === 'shared_secret' ? 12 : 0)),
    reuseCount: Math.max(1, Math.round(anchor.salience / 35)),
    sourceAnchorId: anchor.id,
    sourceEventIds: anchor.sourceId ? [anchor.sourceId] : [],
    sourceMessageIds: normalizeSourceMessageIds(anchor.sourceMessageIds),
    evidence: anchor.evidence,
    updatedAt: anchor.updatedAt,
  };
}

function extractQuotedSharedPhraseFromMessage(message: Message, characterId: string, index: number, now: number): SharedPhrase | null {
  const content = message.content || '';
  if (!/(记住|这句|暗号|口令|以后|说好|约定|叫我|称呼|只有我们|我们之间)/.test(content)) return null;
  const quoted = content.match(/[“"「『](.{1,36}?)[”"」』]/)?.[1]
    || content.match(/(?:暗号|口令|约定|说好|叫我|称呼)[是叫为：:\s]*(.{1,28})/)?.[1];
  const text = compactText(quoted || content, 72);
  if (!text) return null;
  const kind = classifySharedPhrase(content);
  return {
    id: `recent-phrase-${message.id || index}`,
    text,
    kind,
    participantIds: [characterId, USER_ACTOR_ID],
    visibility: sharedPhraseVisibilityFromParticipants([characterId, USER_ACTOR_ID], kind),
    firstSaidBy: message.senderId || USER_ACTOR_ID,
    emotionalWeight: clampRelationshipScore(kind === 'other' ? 42 : 58),
    reuseCount: 1,
    sourceEventIds: [],
    sourceMessageIds: message.id ? [message.id] : [],
    evidence: compactText(content, 140),
    updatedAt: message.timestamp || now,
  };
}

function buildDiaryReflectionSharedPhrases(chat: GroupChat | undefined, character: AICharacter, now: number): SharedPhrase[] {
  return (chat?.runtimeEventsV2 || [])
    .map((event): SharedPhrase | null => {
      const payload = diaryReflectionPayloadOf(event);
      if (!payload || payload.characterId !== character.id || payload.reflectionType !== 'shared_phrase') return null;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 0.6;
      if (confidence < 0.55) return null;
      const textSource = `${payload.text}\n${payload.sourceSeed || ''}`;
      const quoted = textSource.match(/[“"「『](.{1,36}?)[”"」』]/)?.[1];
      const text = compactText(quoted || payload.text, 96);
      if (!text) return null;
      const participantIds = normalizeAnchorParticipants(character.id, payload.participantIds.filter((id) => id !== character.id), {
        chatType: chat?.type,
        text: textSource,
      });
      const kind = classifySharedPhrase(textSource);
      return {
        id: `phrase-diary-${payload.reflectionId}`,
        text,
        kind,
        participantIds,
        visibility: sharedPhraseVisibilityFromParticipants(participantIds, kind),
        firstSaidBy: character.id,
        emotionalWeight: clampRelationshipScore(46 + confidence * 34),
        reuseCount: 1,
        sourceAnchorId: `diary-reflection-${payload.reflectionId}`,
        sourceEventIds: [event.id],
        sourceMessageIds: event.evidenceMessageIds || [],
        evidence: compactText(payload.diaryExcerpt || payload.sourceSeed || event.summary, 160),
        updatedAt: event.createdAt || now,
      };
    })
    .filter((item): item is SharedPhrase => Boolean(item));
}

function buildMomentReflectionSharedPhrases(chat: GroupChat | undefined, character: AICharacter, now: number): SharedPhrase[] {
  return (chat?.runtimeEventsV2 || [])
    .map((event): SharedPhrase | null => {
      const payload = momentReflectionPayloadOf(event);
      if (!payload || payload.characterId !== character.id || payload.reflectionType !== 'shared_phrase') return null;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 0.55;
      if (confidence < 0.5) return null;
      const textSource = `${payload.text}\n${payload.sourceSeed || ''}`;
      const kind = classifySharedPhrase(textSource);
      const participantIds = normalizeAnchorParticipants(character.id, payload.participantIds.filter((id) => id !== character.id), {
        chatType: chat?.type,
        text: textSource,
      });
      return {
        id: `moment-reflection-phrase-${payload.reflectionId}`,
        text: compactText(payload.text, 80),
        kind,
        participantIds,
        visibility: sharedPhraseVisibilityFromParticipants(participantIds, kind),
        firstSaidBy: character.id,
        emotionalWeight: clampRelationshipScore(38 + confidence * 28),
        reuseCount: 0,
        sourceEventIds: [event.id],
        sourceMessageIds: event.evidenceMessageIds || [],
        evidence: compactText(payload.momentText || payload.sourceSeed || event.summary, 160),
        updatedAt: event.createdAt || now,
      };
    })
    .filter((item): item is SharedPhrase => Boolean(item));
}

export function buildSharedPhrases(character: AICharacter, now = 0, chat?: GroupChat, messages: Message[] = []): SharedPhrase[] {
  const runtimeState = buildRuntimeEventSharedPhraseState(chat, character, now);
  const anchorPhrases = buildSharedMemoryAnchors(character, now, chat)
    .map(sharedPhraseFromAnchor)
    .filter((item): item is SharedPhrase => Boolean(item))
    .filter((phrase) => !runtimeState.closedIds.has(phrase.id) && !runtimeState.closedTextKeys.has(sharedPhraseTextKey(phrase)));
  const diaryPhrases = buildDiaryReflectionSharedPhrases(chat, character, now)
    .filter((phrase) => !runtimeState.closedTextKeys.has(sharedPhraseTextKey(phrase)));
  const momentPhrases = buildMomentReflectionSharedPhrases(chat, character, now)
    .filter((phrase) => !runtimeState.closedTextKeys.has(sharedPhraseTextKey(phrase)));
  const recentPhrases = messages
    .filter((message) => !message.isDeleted && (message.senderId === USER_ACTOR_ID || message.type === 'user' || message.type === 'god'))
    .slice(-12)
    .map((message, index) => extractQuotedSharedPhraseFromMessage(message, character.id, index, now))
    .filter((item): item is SharedPhrase => Boolean(item))
    .filter((phrase) => !runtimeState.closedTextKeys.has(sharedPhraseTextKey(phrase)));
  const seen = new Set<string>();
  return [...runtimeState.activePhrases, ...anchorPhrases, ...diaryPhrases, ...momentPhrases, ...recentPhrases]
    .filter((phrase) => {
      const key = sharedPhraseTextKey(phrase);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.emotionalWeight + b.reuseCount * 4 + b.updatedAt / DAY_MS) - (a.emotionalWeight + a.reuseCount * 4 + a.updatedAt / DAY_MS))
    .slice(0, 8);
}

function buildCompanionshipDiagnostics(chat: GroupChat, characterId: string) {
  return (chat.runtimeEventsV2 || [])
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .flatMap((event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload.eventType !== 'string' || !payload.eventType.startsWith('companionship_')) return [];
      if (typeof payload.characterId === 'string' && payload.characterId !== characterId) return [];
      const decisionSource = typeof payload.decisionSource === 'string' ? payload.decisionSource : '';
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined;
      if (decisionSource !== 'local_fallback' && (confidence === undefined || confidence >= 0.7)) return [];
      const eventLabel = payload.eventType.replace(/^companionship_/, '');
      const sourceText = decisionSource ? `source=${decisionSource}` : 'source=unknown';
      const confidenceText = confidence !== undefined ? ` confidence=${Math.round(confidence * 100)}%` : '';
      return [`${eventLabel}: ${sourceText}${confidenceText} event=${event.id}`];
    })
    .slice(0, 5);
}

function cleanAddressValue(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, '').trim();
  if (!text || text.length > 16) return undefined;
  return text;
}

function cleanAddressList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return uniqueTexts(value.map(cleanAddressValue).filter(Boolean) as string[], 12);
}

function addressingPayloadOf(event: RuntimeEventV2): CompanionshipAddressingEventPayload | null {
  const payload = event.payload as Partial<CompanionshipAddressingEventPayload> | undefined;
  if (!payload || payload.eventType !== 'companionship_addressing' || !payload.characterId || !payload.action) return null;
  return payload as CompanionshipAddressingEventPayload;
}

function buildAddressingHistory(chat: GroupChat, characterId: string): AddressingHistoryEntry[] {
  const history: AddressingHistoryEntry[] = [];
  (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .forEach((event) => {
      const payload = addressingPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return;
      if ((payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return;
      const currentAddress = cleanAddressValue(payload.currentAddress);
      const privateAddress = cleanAddressValue(payload.privateAddress);
      const publicAddress = cleanAddressValue(payload.publicAddress);
      const forbiddenAddresses = cleanAddressList(payload.forbiddenAddresses);
      history.push({
        id: event.id,
        action: payload.action,
        currentAddress,
        privateAddress,
        publicAddress,
        forbiddenAddresses,
        reason: compactText(payload.reason || payload.evidence || event.summary || 'addressing runtime event', 120),
        evidence: [payload.reason, payload.evidence, event.summary].filter(Boolean).map((item) => compactText(item, 120)).slice(0, 4) as string[],
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        initiatedBy: payload.initiatedBy,
        decisionSource: payload.decisionSource,
        confidence,
        occurredAt: event.createdAt || 0,
      });
    });
  return history.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 10);
}

function hasRecentAddressingRepairEvent(chat: GroupChat | undefined, characterId: string | undefined, now: number) {
  if (!chat || !characterId) return false;
  const windowStart = now - 14 * DAY_MS;
  return (chat.runtimeEventsV2 || []).some((event) => {
    if (event.kind !== 'artifact' || (event.createdAt || 0) < windowStart) return false;
    const payload = intimateConflictEventPayloadOf(event);
    if (!payload || payload.characterId !== characterId) return false;
    const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 1;
    if (confidence < 0.6) return false;
    if (payload.userId && payload.userId !== USER_ACTOR_ID) return false;
    const participantIds = payload.participantIds?.length ? payload.participantIds : [characterId, USER_ACTOR_ID];
    return participantIds.includes(USER_ACTOR_ID)
      && (payload.action === 'resolved' || payload.action === 'repair_attempted')
      && (payload.kind === 'reconciliation' || payload.kind === 'repair_attempt');
  });
}

function resolveAddressingFromEvents(chat: GroupChat, characterId: string, base: AddressingState, phase: CompanionshipPhase, now: number): AddressingState {
  const events = (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact')
    .map((event) => ({ event, payload: addressingPayloadOf(event) }))
    .filter((item): item is { event: RuntimeEventV2; payload: CompanionshipAddressingEventPayload } => {
      if (!item.payload) return false;
      if (item.payload.characterId !== characterId || (item.payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return false;
      const confidence = typeof item.payload.confidence === 'number' && Number.isFinite(item.payload.confidence) ? item.payload.confidence : 1;
      return confidence >= 0.6;
    })
    .sort((a, b) => (a.event.createdAt || 0) - (b.event.createdAt || 0));
  if (!events.length) return base;

  let next: AddressingState = {
    ...base,
    forbiddenAddresses: [...base.forbiddenAddresses],
    addressHistory: [...base.addressHistory],
  };
  events.forEach(({ event, payload }) => {
    const current = cleanAddressValue(payload.currentAddress);
    const privateAddress = cleanAddressValue(payload.privateAddress);
    const publicAddress = cleanAddressValue(payload.publicAddress);
    const forbidden = cleanAddressList(payload.forbiddenAddresses);
    const reason = compactText(payload.reason || payload.evidence || event.summary || 'addressing runtime event', 120);
    const initiatedBy = payload.initiatedBy || 'mutual';
    if (payload.action === 'revoke') {
      next = {
        ...next,
        currentAddress: '你',
        privateAddress: undefined,
        publicAddress: '用户',
        addressHistory: next.addressHistory.concat({
          value: '你',
          adoptedAt: event.createdAt || now,
          reason,
          initiatedBy,
        }),
      };
      return;
    }
    if (payload.action === 'forbid') {
      next = {
        ...next,
        forbiddenAddresses: uniqueTexts([...next.forbiddenAddresses, ...forbidden, current, privateAddress, publicAddress].filter(Boolean) as string[], 12),
      };
      return;
    }
    if (payload.action === 'unforbid') {
      const removing = new Set([...forbidden, current, privateAddress, publicAddress].filter(Boolean) as string[]);
      next = {
        ...next,
        forbiddenAddresses: next.forbiddenAddresses.filter((item) => !removing.has(item)),
      };
      return;
    }
    const chosenCurrent = payload.action === 'set_current' || payload.action === 'update' ? current : undefined;
    const chosenPrivate = payload.action === 'set_private' || payload.action === 'update' ? privateAddress : undefined;
    const chosenPublic = payload.action === 'set_public' || payload.action === 'update' ? publicAddress : undefined;
    next = {
      ...next,
      currentAddress: chosenCurrent || next.currentAddress,
      privateAddress: chosenPrivate || next.privateAddress,
      publicAddress: chosenPublic || next.publicAddress,
      forbiddenAddresses: uniqueTexts([...next.forbiddenAddresses, ...forbidden], 12),
    };
    const adopted = chosenCurrent || chosenPrivate || chosenPublic;
    if (adopted) {
      next.addressHistory = next.addressHistory.concat({
        value: adopted,
        adoptedAt: event.createdAt || now,
        reason,
        initiatedBy,
      }).slice(-8);
    }
  });
  const recoveredByRepair = phase === 'reconciling' && hasRecentAddressingRepairEvent(chat, characterId, now);
  const isRestrained = phase === 'cooling' || phase === 'crisis' || (phase === 'reconciling' && !recoveredByRepair);
  const safePrivate = next.privateAddress && !next.forbiddenAddresses.includes(next.privateAddress) ? next.privateAddress : undefined;
  const safePublic = next.publicAddress && !next.forbiddenAddresses.includes(next.publicAddress) ? next.publicAddress : '用户';
  const safeCurrent = next.currentAddress && !next.forbiddenAddresses.includes(next.currentAddress) ? next.currentAddress : undefined;
  const recoveredCurrent = recoveredByRepair ? (safePrivate || safeCurrent || safePublic || '你') : undefined;
  return {
    ...next,
    currentAddress: recoveredCurrent || (isRestrained ? (safePublic === '用户' ? '你' : safePublic) : (safeCurrent || safePrivate || safePublic || '你')),
    privateAddress: safePrivate,
    publicAddress: safePublic,
    forbiddenAddresses: uniqueTexts(next.forbiddenAddresses, 12),
  };
}

function buildAddressing(profile: UserProfileMemoryProjection, phase: CompanionshipPhase, now: number, chat?: GroupChat, characterId?: string) {
  const preferred = profile.addressPreference || profile.displayName;
  const forbiddenAddresses = extractForbiddenAddresses(profile.sourceTexts);
  const safePreferred = preferred && !forbiddenAddresses.includes(preferred) ? preferred : undefined;
  const neutralAddress = profile.displayName && !forbiddenAddresses.includes(profile.displayName) ? profile.displayName : '你';
  const recoveredByRepair = phase === 'reconciling' && hasRecentAddressingRepairEvent(chat, characterId, now);
  const isRestrained = phase === 'cooling' || phase === 'crisis' || (phase === 'reconciling' && !recoveredByRepair);
  const currentAddress = isRestrained ? neutralAddress : (safePreferred || neutralAddress);
  const base = {
    defaultName: '你',
    currentAddress,
    privateAddress: safePreferred || neutralAddress,
    publicAddress: '用户',
    forbiddenAddresses,
    addressHistory: safePreferred ? [{
      value: safePreferred,
      adoptedAt: now,
      reason: recoveredByRepair ? 'repair event restored private address gently' : isRestrained ? 'user preference kept private while relationship is restrained' : 'user memory preference',
      initiatedBy: recoveredByRepair ? 'mutual' as const : 'user' as const,
    }] : [],
  };
  return chat && characterId ? resolveAddressingFromEvents(chat, characterId, base, phase, now) : base;
}

function buildRememberedPlans(topics: PendingCareTopic[]) {
  return topics
    .filter((item) => item.urgency !== 'high')
    .map((item) => item.text)
    .slice(0, 3);
}

function isPromiseText(text: string) {
  return /(约定|说好|答应|承诺|下次|以后一起|等你|一起看|一起去|告诉你结果|回来告诉|讲给你听|补给你|还欠)/.test(text);
}

function isPromiseFulfilledText(text: string) {
  return /(已经|完成|履行|兑现|做完|看完|去过|告诉过|讲完|补上|不算了|取消|不用了|算了)/.test(text);
}

function dueAtFromPromiseText(text: string, updatedAt: number) {
  if (/今晚/.test(text)) return updatedAt + 12 * 60 * 60_000;
  if (/明天|下次见|下次聊/.test(text)) return updatedAt + 48 * 60 * 60_000;
  if (/周末|这周|下周/.test(text)) return updatedAt + 7 * DAY_MS;
  return undefined;
}

function inferPromiseKind(text: string): PendingPromise['kind'] {
  if (/(不要|别|不想|界限|边界|只做朋友|别催|别提醒|先别问|别主动)/.test(text)) return 'boundary_agreement';
  if (/(道歉|和好|说开|台阶|冷静后|吵完|修复|下次争执|以后吵架)/.test(text)) return 'repair_agreement';
  if (/(早安|晚安|每天|每晚|每早|纪念日|暗号|专属称呼|小秘密|仪式)/.test(text)) return 'ritual';
  if (/(会陪|不会走|等你|不离开|一直在|相信我|答应你|承诺)/.test(text)) return 'emotional_commitment';
  if (/(告诉你|回来告诉|讲给你听|发给你|结果|面试|考试|复查|到家|下班)/.test(text)) return 'user_followup';
  if (/(一起|看电影|吃饭|散步|出去|见面|补看|补给|下次聊|下次见)/.test(text)) return 'shared_activity';
  return 'other';
}

function formatPromiseKind(kind: PendingPromise['kind']) {
  const labels: Record<PendingPromise['kind'], string> = {
    shared_activity: '一起做的事',
    user_followup: '等用户回来说',
    emotional_commitment: '情感承诺',
    boundary_agreement: '关系边界',
    repair_agreement: '修复约定',
    ritual: '关系仪式',
    other: '普通约定',
  };
  return labels[kind];
}

function buildPromiseReminderPolicy(text: string, kind: PendingPromise['kind'], dueAt?: number): PendingPromise['reminderPolicy'] {
  const boundaryReasons: string[] = [];
  if (/(别催|别提醒|不用提醒|别问|先别问|不要主动)/.test(text)) boundaryReasons.push('用户表达不希望被追问或提醒');
  if (kind === 'boundary_agreement') boundaryReasons.push('边界类约定只作为行为约束，不主动追问');
  const tone: PendingPromise['reminderPolicy']['tone'] = kind === 'repair_agreement'
    ? 'apologetic'
    : kind === 'shared_activity' || kind === 'ritual'
      ? 'playful'
      : kind === 'boundary_agreement'
        ? 'none'
        : /(面试|考试|复查|生病|不舒服|压力|难受)/.test(text)
          ? 'gentle'
          : 'serious';
  const shouldRemind = Boolean(dueAt) && kind !== 'boundary_agreement' && !boundaryReasons.length;
  const seedIntent = shouldRemind
    ? kind === 'user_followup'
      ? `低压力地关心后续，重点是关心，不要像任务催办；若用户转向具体任务，仍要完整回答：${text}`
      : kind === 'shared_activity'
        ? `低压力地提起之前说好的一起做的事，允许用户改期或忘记；这不是短回复限制：${text}`
        : kind === 'repair_agreement'
          ? `以负责和放软的语气记得修复约定，不翻旧账：${text}`
          : `自然记起这个约定，不施压：${text}`
    : kind === 'boundary_agreement'
      ? `把这个边界约定作为行为约束，不主动拿出来追问：${text}`
      : `把这个约定作为关系纹理记住，除非上下文合适不要主动催促：${text}`;
  return {
    shouldRemind,
    tone,
    maxFollowUps: kind === 'emotional_commitment' || kind === 'boundary_agreement' ? 0 : 1,
    seedIntent,
    boundaryReasons,
  };
}

function buildPromiseRelationshipEffects(kind: PendingPromise['kind']): PendingPromise['relationshipEffects'] {
  if (kind === 'boundary_agreement') {
    return {
      fulfilled: { security: 6 },
      missed: { security: -12, intimacy: -4 },
      notes: ['守住边界会提升安全感，越界会伤害信任。'],
    };
  }
  if (kind === 'repair_agreement') {
    return {
      fulfilled: { security: 8, intimacy: 5 },
      missed: { security: -10, attachment: -4 },
      notes: ['修复约定履行后可成为关系重新稳定的证据。'],
    };
  }
  if (kind === 'emotional_commitment') {
    return {
      fulfilled: { attachment: 6, security: 5 },
      missed: { security: -8, longing: -3 },
      notes: ['情感承诺重在表达一致性，不应该被机械追问。'],
    };
  }
  return {
    fulfilled: { intimacy: 4, attachment: 3, security: 3 },
    missed: { security: -4 },
    notes: ['共同约定完成后可增强共同感；错过时应允许改期。'],
  };
}

function buildPendingPromise(params: {
  id: string;
  text: string;
  participantIds: string[];
  source: PendingPromise['source'];
  status?: PendingPromise['status'];
  evidence?: string;
  dueAt?: number;
  updatedAt: number;
  kind?: PendingPromise['kind'];
  reminderPolicy?: Partial<PendingPromise['reminderPolicy']>;
  relationshipEffects?: Partial<PendingPromise['relationshipEffects']>;
  lifecycleEvidence?: string[];
  sourceMessageIds?: string[];
}): PendingPromise {
  const text = compactText(params.text, 140);
  const kind = params.kind || inferPromiseKind(`${text}\n${params.evidence || ''}`);
  const inferredPolicy = buildPromiseReminderPolicy(`${text}\n${params.evidence || ''}`, kind, params.dueAt);
  const inferredEffects = buildPromiseRelationshipEffects(kind);
  return {
    id: params.id,
    text,
    participantIds: params.participantIds.length ? params.participantIds : [USER_ACTOR_ID],
    source: params.source,
    kind,
    status: params.status || 'open',
    evidence: params.evidence,
    dueAt: params.dueAt,
    reminderPolicy: {
      ...inferredPolicy,
      ...params.reminderPolicy,
      boundaryReasons: uniqueTexts([
        ...inferredPolicy.boundaryReasons,
        ...(params.reminderPolicy?.boundaryReasons || []),
      ], 4),
    },
    relationshipEffects: {
      fulfilled: { ...inferredEffects.fulfilled, ...(params.relationshipEffects?.fulfilled || {}) },
      missed: { ...inferredEffects.missed, ...(params.relationshipEffects?.missed || {}) },
      notes: uniqueTexts([
        ...inferredEffects.notes,
        ...(params.relationshipEffects?.notes || []),
      ], 4),
    },
    lifecycleEvidence: uniqueTexts(params.lifecycleEvidence || [params.evidence || text].filter(Boolean), 5),
    sourceMessageIds: normalizeSourceMessageIds(params.sourceMessageIds),
    updatedAt: params.updatedAt,
  };
}

function getPendingPromiseRetentionMs() {
  const rawDays = getCompanionshipRuntimeConfig().pendingPromiseRetentionDays;
  const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.round(rawDays))) : 30;
  return days * DAY_MS;
}

function isPromiseWithinRetention(promise: PendingPromise, now: number, retentionMs: number) {
  const updatedAt = Number.isFinite(promise.updatedAt) ? promise.updatedAt : now;
  const dueAt = typeof promise.dueAt === 'number' && Number.isFinite(promise.dueAt) ? promise.dueAt : undefined;
  const relevantAt = Math.max(updatedAt, dueAt || 0);
  return now - relevantAt <= retentionMs;
}

function promiseId(parts: Array<string | number | undefined>) {
  const joined = parts.filter((item) => item !== undefined && item !== null && String(item).length > 0).join('|');
  let hash = 0;
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 31 + joined.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function promiseKey(text: string) {
  return compactText(text, 160).replace(/\s+/g, '').slice(0, 64);
}

function promisePayloadOf(event: RuntimeEventV2): CompanionshipPromiseEventPayload | null {
  const payload = event.payload as Partial<CompanionshipPromiseEventPayload> | undefined;
  if (!payload || payload.eventType !== 'companionship_promise' || !payload.characterId || !payload.promiseId || !payload.promiseText || !payload.action) return null;
  return payload as CompanionshipPromiseEventPayload;
}

function buildPromiseHistory(chat: GroupChat, characterId: string): PromiseHistoryEntry[] {
  return (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .map((event): PromiseHistoryEntry | null => {
      const payload = promisePayloadOf(event);
      if (!payload || payload.characterId !== characterId) return null;
      if ((payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return null;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return null;
      const text = compactText(payload.promiseText, 140);
      return {
        id: event.id,
        promiseId: payload.promiseId,
        promiseText: text,
        action: payload.action,
        promiseKind: payload.promiseKind || inferPromiseKind(`${text}\n${payload.evidence || payload.reason || ''}`),
        participantIds: payload.participantIds?.length ? payload.participantIds : [characterId, USER_ACTOR_ID],
        supersedesText: payload.supersedesText ? compactText(payload.supersedesText, 140) : undefined,
        lifecycleEvidence: (payload.lifecycleEvidence || []).map((item) => compactText(item, 120)).slice(0, 4),
        reason: compactText(payload.reason || event.summary, 140),
        evidence: [payload.evidence, payload.reason, event.summary, ...(payload.lifecycleEvidence || [])].filter(Boolean).map((item) => compactText(item, 120)).slice(0, 5) as string[],
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        dueAt: payload.dueAt,
        decisionSource: payload.decisionSource,
        confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
        occurredAt: event.createdAt || 0,
      };
    })
    .filter((item): item is PromiseHistoryEntry => Boolean(item))
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 10);
}

function buildPromiseIntimacyConsequences(chat: GroupChat, characterId: string, now: number) {
  return (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact')
    .map((event): PromiseIntimacyConsequence | null => {
      const payload = promisePayloadOf(event);
      if (!payload || payload.characterId !== characterId || (payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return null;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 1;
      if (confidence < 0.6) return null;
      if (payload.action === 'opened' || payload.action === 'revoked') return null;
      const ageDays = Math.max(0, (now - (event.createdAt || now)) / DAY_MS);
      if (ageDays > 90) return null;
      const explicitEffects = payload.relationshipEffects;
      if (!explicitEffects) return null;
      const rawEffect = payload.action === 'fulfilled'
        ? explicitEffects.fulfilled
        : explicitEffects.missed;
      if (!rawEffect) return null;
      const decay = Math.max(0.25, 1 - ageDays / 120);
      const effect = Object.fromEntries(Object.entries(rawEffect).map(([key, value]) => [key, typeof value === 'number' ? value * decay : value])) as Partial<IntimacyProjection>;
      return {
        action: payload.action,
        effect,
        evidence: compactText(payload.evidence || payload.reason || event.summary || payload.promiseText, 120),
      };
    })
    .filter((item): item is PromiseIntimacyConsequence => Boolean(item))
    .slice(-8);
}

function buildPromiseEventState(chat: GroupChat, characterId: string, now: number) {
  const activeById = new Map<string, PendingPromise>();
  const closedKeys = new Set<string>();
  (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact')
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .forEach((event) => {
      const payload = promisePayloadOf(event);
      if (!payload || payload.characterId !== characterId || (payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 1;
      if (confidence < 0.6) return;
      const text = compactText(payload.promiseText, 140);
      const key = promiseKey(text);
      if (!text || !key) return;
      const supersedesKey = payload.supersedesText ? promiseKey(payload.supersedesText) : '';
      if (supersedesKey && supersedesKey !== key) {
        closedKeys.add(supersedesKey);
      }
      if (payload.action !== 'opened') {
        activeById.delete(payload.promiseId);
        closedKeys.add(key);
        return;
      }
      closedKeys.delete(key);
      activeById.set(payload.promiseId, buildPendingPromise({
        id: payload.promiseId,
        text,
        participantIds: payload.participantIds?.length ? payload.participantIds : [characterId, USER_ACTOR_ID],
        source: 'runtime_event',
        status: 'open',
        evidence: compactText(payload.evidence || payload.reason || event.summary, 120),
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        kind: payload.promiseKind,
        dueAt: payload.dueAt || dueAtFromPromiseText(text, event.createdAt || now),
        reminderPolicy: payload.reminderPolicy,
        relationshipEffects: payload.relationshipEffects,
        lifecycleEvidence: payload.lifecycleEvidence || [payload.evidence || payload.reason || event.summary].filter(Boolean),
        updatedAt: event.createdAt || now,
      }));
    });
  return {
    activePromises: Array.from(activeById.values()).sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    closedKeys,
  };
}

function isPromiseSuppressed(text: string, closedKeys: Set<string>) {
  const key = promiseKey(text);
  if (!key) return false;
  if (closedKeys.has(key)) return true;
  return Array.from(closedKeys).some((closed) => key.includes(closed) || closed.includes(key));
}

function buildPendingPromises(params: {
  chat: GroupChat;
  characterId: string;
  profile: UserProfileMemoryProjection;
  messages: Message[];
  sharedAnchors: SharedMemoryAnchor[];
  now: number;
}): PendingPromise[] {
  const retentionMs = getPendingPromiseRetentionMs();
  const promiseEventState = buildPromiseEventState(params.chat, params.characterId, params.now);
  const promises: PendingPromise[] = [...promiseEventState.activePromises];
  params.sharedAnchors
    .filter((anchor) => anchor.kind === 'promise' && !isPromiseFulfilledText(`${anchor.text}\n${anchor.evidence || ''}`))
    .filter((anchor) => !isPromiseSuppressed(`${anchor.text}\n${anchor.evidence || ''}`, promiseEventState.closedKeys))
    .forEach((anchor) => {
      promises.push(buildPendingPromise({
        id: `anchor-${anchor.id}`,
        text: compactText(anchor.text, 140),
        participantIds: anchor.participantIds,
        source: 'shared_anchor',
        status: 'open',
        evidence: compactText(anchor.evidence || anchor.text, 120),
        sourceMessageIds: [],
        dueAt: dueAtFromPromiseText(`${anchor.text}\n${anchor.evidence || ''}`, anchor.updatedAt || params.now),
        lifecycleEvidence: [anchor.evidence || anchor.text],
        updatedAt: anchor.updatedAt || params.now,
      }));
    });

  params.profile.sourceTexts
    .filter((text) => isPromiseText(text) && !isPromiseFulfilledText(text))
    .filter((text) => !isPromiseSuppressed(text, promiseEventState.closedKeys))
    .slice(-4)
    .forEach((text, index) => {
      promises.push(buildPendingPromise({
        id: `profile-${index}-${promiseId([params.characterId, text])}`,
        text: compactText(text, 140),
        participantIds: [params.characterId, USER_ACTOR_ID],
        source: 'user_profile',
        status: 'open',
        evidence: compactText(text, 120),
        sourceMessageIds: [],
        dueAt: dueAtFromPromiseText(text, params.now),
        lifecycleEvidence: [text],
        updatedAt: params.now,
      }));
    });

  params.messages
    .filter(isUserMessage)
    .slice(-12)
    .filter((message) => isPromiseText(message.content) && !isPromiseFulfilledText(message.content))
    .filter((message) => !isPromiseSuppressed(message.content, promiseEventState.closedKeys))
    .slice(-3)
    .forEach((message, index) => {
      promises.push(buildPendingPromise({
        id: `recent-${index}-${message.id}`,
        text: compactText(message.content, 140),
        participantIds: [params.characterId, USER_ACTOR_ID],
        source: 'recent_message',
        status: 'open',
        evidence: compactText(message.content, 120),
        sourceMessageIds: message.id ? [message.id] : [],
        dueAt: dueAtFromPromiseText(message.content, message.timestamp || params.now),
        lifecycleEvidence: [message.content],
        updatedAt: message.timestamp || params.now,
      }));
    });

  const seen = new Set<string>();
  const staleKeys = new Set<string>();
  return promises
    .filter((promise) => {
      if (isPromiseSuppressed(promise.text, staleKeys)) return false;
      if (isPromiseWithinRetention(promise, params.now, retentionMs)) return true;
      const key = promiseKey(promise.text);
      if (key) staleKeys.add(key);
      return false;
    })
    .filter((promise) => {
      const key = promise.text.replace(/\s+/g, '').slice(0, 48);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(0, 5);
}

function buildUnresolvedTensions(entry: RelationshipLedgerEntry | null) {
  if (!entry || entry.current.threat < 18) return [];
  return [
    entry.derived?.semantic?.summary || 'relationship tension is present',
    ...(entry.recentEvents || []).slice(-2).map((item) => compactText(item.summary, 120)),
  ].filter(Boolean).slice(0, 3) as string[];
}

const INTIMATE_CONFLICT_KINDS: IntimateConflictKind[] = [
  'cold_war',
  'silent_treatment',
  'testing',
  'accusation',
  'withdrawal',
  'vulnerability_burst',
  'repair_attempt',
  'reconciliation',
];

function isIntimateConflictKind(value: unknown): value is IntimateConflictKind {
  return typeof value === 'string' && INTIMATE_CONFLICT_KINDS.includes(value as IntimateConflictKind);
}

function intimateConflictEventPayloadOf(event: RuntimeEventV2): CompanionshipIntimateConflictEventPayload | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || payload.eventType !== 'companionship_intimate_conflict') return null;
  const action = payload.action;
  if (action !== 'opened' && action !== 'updated' && action !== 'repair_attempted' && action !== 'resolved' && action !== 'reopened' && action !== 'dismissed') return null;
  if (!isIntimateConflictKind(payload.kind)) return null;
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : '';
  if (!characterId) return null;
  const evidence = Array.isArray(payload.evidence)
    ? payload.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120))
    : undefined;
  const participantIds = Array.isArray(payload.participantIds)
    ? payload.participantIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 6)
    : undefined;
  const sourceEventIds = Array.isArray(payload.sourceEventIds)
    ? payload.sourceEventIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 8)
    : undefined;
  const sourceMessageIds = normalizeSourceMessageIds(payload.sourceMessageIds);
  return {
    eventType: 'companionship_intimate_conflict',
    characterId,
    userId: typeof payload.userId === 'string' ? payload.userId : undefined,
    action,
    kind: payload.kind,
    severity: typeof payload.severity === 'number' && Number.isFinite(payload.severity) ? payload.severity : undefined,
    repairReadiness: typeof payload.repairReadiness === 'number' && Number.isFinite(payload.repairReadiness) ? payload.repairReadiness : undefined,
    summary: typeof payload.summary === 'string' ? compactText(payload.summary, 160) : undefined,
    evidence,
    participantIds,
    sourceEventIds,
    sourceMessageIds,
    confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
    decisionSource: payload.decisionSource === 'model' || payload.decisionSource === 'local_fallback' ? payload.decisionSource : undefined,
  };
}

function resolveIntimateConflictEvent(chat: GroupChat, characterId: string, now: number): IntimateConflictState | null {
  const events = (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const event of events) {
    const payload = intimateConflictEventPayloadOf(event);
    if (!payload || payload.characterId !== characterId) continue;
    const userId = payload.userId || USER_ACTOR_ID;
    if (userId !== USER_ACTOR_ID) continue;
    const participantIds = payload.participantIds?.length ? payload.participantIds : [characterId, USER_ACTOR_ID];
    if (!participantIds.includes(characterId) || !participantIds.includes(USER_ACTOR_ID)) continue;
    const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
    const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
    if (!actorMatches || !targetMatches) continue;
    if (payload.action === 'dismissed') return null;
    const severity = clampScore(payload.severity ?? (payload.action === 'resolved' ? 18 : payload.action === 'repair_attempted' ? 36 : 50));
    const repairReadiness = clampScore(payload.repairReadiness ?? (
      payload.action === 'resolved' ? 82 : payload.action === 'repair_attempted' ? 58 : payload.kind === 'reconciliation' ? 72 : 24
    ));
    const evidence = [
      event.summary,
      ...(payload.evidence || []),
    ].filter(Boolean).map((item) => compactText(item, 120)).slice(0, 5);
    const kind = payload.action === 'resolved' && payload.kind !== 'reconciliation' ? 'reconciliation' : payload.kind;
    return {
      kind,
      severity,
      repairReadiness,
      summary: payload.summary || conflictSummary(kind, severity, repairReadiness),
      evidence,
      participantIds,
      sourceEventIds: Array.from(new Set([event.id, ...(payload.sourceEventIds || [])])).slice(0, 8),
      sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
      updatedAt: event.createdAt || now,
    };
  }
  return null;
}

function buildIntimateConflictHistory(chat: GroupChat, characterId: string): IntimateConflictHistoryEntry[] {
  const history: IntimateConflictHistoryEntry[] = [];
  (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .forEach((event) => {
      const payload = intimateConflictEventPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return;
      const userId = payload.userId || USER_ACTOR_ID;
      if (userId !== USER_ACTOR_ID) return;
      const participantIds = payload.participantIds?.length ? payload.participantIds : [characterId, USER_ACTOR_ID];
      if (!participantIds.includes(characterId) || !participantIds.includes(USER_ACTOR_ID)) return;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return;
      const severity = clampScore(payload.severity ?? (
        payload.action === 'resolved' || payload.action === 'dismissed' ? 18 : payload.action === 'repair_attempted' ? 36 : 50
      ));
      const repairReadiness = clampScore(payload.repairReadiness ?? (
        payload.action === 'resolved' ? 82 : payload.action === 'repair_attempted' ? 58 : payload.kind === 'reconciliation' ? 72 : 24
      ));
      const kind = payload.action === 'resolved' && payload.kind !== 'reconciliation' ? 'reconciliation' : payload.kind;
      history.push({
        id: event.id,
        action: payload.action,
        kind,
        severity,
        repairReadiness,
        summary: payload.summary || event.summary || conflictSummary(kind, severity, repairReadiness),
        evidence: [event.summary, ...(payload.evidence || [])].filter(Boolean).map((item) => compactText(item, 120)).slice(0, 4),
        sourceEventIds: Array.from(new Set([event.id, ...(payload.sourceEventIds || [])])).slice(0, 8),
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        decisionSource: payload.decisionSource,
        confidence: payload.confidence,
        occurredAt: event.createdAt || 0,
      });
    });
  return history.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 8);
}

function conflictSummary(kind: IntimateConflictKind, severity: number, repairReadiness: number) {
  const intensity = severity >= 70 ? '很强' : severity >= 44 ? '明显' : '轻微';
  if (kind === 'repair_attempt') return `关系正在尝试修复，冲突余波${intensity}，需要先接住对方而不是急着恢复亲密。`;
  if (kind === 'reconciliation') return `关系已经出现和好或修复证据，可以温和承认余波，并把安全感慢慢补回来。`;
  if (kind === 'cold_war') return `关系像是进入冷战或暂停沟通，冲突余波${intensity}，开口要克制。`;
  if (kind === 'silent_treatment') return `关系有明显不回应或隔离感，冲突余波${intensity}，不能用热情强行压过去。`;
  if (kind === 'accusation') return `对话里有指责或失望，冲突余波${intensity}，需要回应具体伤点。`;
  if (kind === 'withdrawal') return `对方在退缩或把话收回去，冲突余波${intensity}，需要给空间和台阶。`;
  if (kind === 'vulnerability_burst') return `对方暴露了受伤或委屈，冲突余波${intensity}，需要优先安放情绪。`;
  return `关系里有试探性的紧张，修复成熟度约${repairReadiness}，不要贸然推进亲密。`;
}

function phaseLabel(phase: CompanionshipPhase) {
  const labels: Record<CompanionshipPhase, string> = {
    stranger: 'stranger',
    curious: 'curious',
    fond: 'fond',
    ambiguous: 'ambiguous but unconfirmed',
    confessing: 'confession pending',
    confirmed: 'confirmed relationship',
    passionate: 'passionate phase',
    deep: 'deep stable bond',
    cooling: 'cooling down',
    crisis: 'relationship crisis',
    reconciling: 'reconciling',
  };
  return labels[phase];
}

function statusTone(phase: CompanionshipPhase): CompanionshipStatusSignature['tone'] {
  if (phase === 'crisis') return 'crisis';
  if (phase === 'cooling' || phase === 'reconciling') return 'restrained';
  if (phase === 'ambiguous' || phase === 'confessing') return 'ambiguous';
  if (phase === 'fond' || phase === 'confirmed' || phase === 'passionate' || phase === 'deep') return 'warm';
  if (phase === 'curious') return 'curious';
  return 'distant';
}

function formatSince(timestamp: number | undefined, now: number) {
  if (!timestamp) return '';
  const minutes = Math.max(0, Math.round((now - timestamp) / (60 * 1000)));
  if (minutes < 60) return `${minutes || 1} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function buildStatusText(bond: UserBondState, carePolicy: CarePolicy, now: number) {
  const address = bond.addressing.currentAddress || '你';
  const topic = bond.pendingCareTopics[0]?.text;
  const since = formatSince(bond.lastUserReplyAt, now);
  if (bond.phase === 'crisis') return topic ? `还在意${address}，但现在更需要先把不舒服说清楚。` : `有些受伤和防备，暂时不适合强行靠近。`;
  if (bond.phase === 'cooling') return `还记得${address}，只是现在会更克制一点。`;
  if (carePolicy.boundaryReasons.length) return topic ? `记得${address}提过的事，但会按你的边界轻一点关心。` : `会把关系放在心上，也会尊重${address}设下的边界。`;
  if (topic) return `惦记着${address}提过的事：${compactText(topic, 42)}`;
  if (bond.phase === 'ambiguous') return since ? `${since}之后还会想起${address}，但不会把关系说死。` : `有些想靠近${address}，但还没到确认关系的程度。`;
  if (bond.phase === 'fond') return `对${address}更熟悉了，会自然记住一些小事。`;
  if (bond.phase === 'curious') return `开始把${address}当成需要认真回应的人。`;
  return `还在慢慢认识${address}。`;
}

function buildStatusChips(bond: UserBondState, carePolicy: CarePolicy) {
  return [
    bond.phase === 'ambiguous' ? '暧昧未确认' : '',
    bond.phase === 'fond' ? '关系升温' : '',
    bond.phase === 'curious' ? '开始在意' : '',
    bond.phase === 'cooling' || bond.phase === 'reconciling' ? '克制中' : '',
    bond.phase === 'crisis' ? '需要修复' : '',
    bond.pendingCareTopics.length ? '有关心事项' : '',
    bond.userProfile.boundaries.length ? '有用户边界' : '',
    carePolicy.allowGoodNight ? '可晚安' : '',
  ].filter(Boolean).slice(0, 4);
}

function buildOfflineTrace(bond: UserBondState, carePolicy: CarePolicy, now: number) {
  const silence = silenceHours(bond.lastUserReplyAt, now);
  const address = bond.addressing.currentAddress || '你';
  if (silence < 6) return '';
  if (carePolicy.boundaryReasons.includes('user prefers low proactive contact')) {
    return `想起${address}，但会按你的边界保持安静。`;
  }
  if (bond.phase === 'crisis') return '有话想说，但现在更像是在等一个能好好说开的时机。';
  if (bond.phase === 'cooling' || bond.phase === 'reconciling') return `隔了一阵没聊，还是会留意${address}的反应。`;
  if (bond.pendingCareTopics[0]) return `离线这段时间还惦记着：${compactText(bond.pendingCareTopics[0].text, 38)}`;
  if (bond.phase === 'ambiguous' || bond.phase === 'fond') return `这段时间没说话，也会偶尔想到${address}。`;
  if (bond.phase === 'curious') return `还在想下次该怎么自然地接上${address}的话。`;
  return '';
}

function buildUnsentDraft(bond: UserBondState, carePolicy: CarePolicy, now: number) {
  const silence = silenceHours(bond.lastUserReplyAt, now);
  const address = bond.addressing.currentAddress || '你';
  if (silence < 12) return '';
  if (carePolicy.dailyInitiationBudget <= 0) return '';
  if (bond.phase === 'crisis') return '';
  if (bond.pendingCareTopics[0]) return `本来想问问${address}，${compactText(bond.pendingCareTopics[0].text, 28)}后来怎么样了。`;
  if (bond.phase === 'ambiguous') return `写过一句“刚才想到${address}”，又觉得太直白。`;
  if (bond.phase === 'fond') return `想问${address}今天过得怎么样，又怕显得太突然。`;
  return '';
}

interface OnlineReturnProjection {
  displayText: string;
  seedIntent: string;
}

function buildOnlineReturnProjection(bond: UserBondState, carePolicy: CarePolicy, now: number): OnlineReturnProjection | null {
  const silence = silenceHours(bond.lastUserReplyAt, now);
  const address = bond.addressing.currentAddress || '你';
  if (silence < 24) return null;
  if (carePolicy.dailyInitiationBudget <= 0) return null;
  if (bond.phase === 'crisis' || bond.phase === 'cooling') return null;
  if (bond.pendingCareTopics[0]) {
    return {
      displayText: `${address}终于来了。还惦记着你提过的事，想低压力地关心后续。`,
      seedIntent: `用户长时间离开后回到会话。角色可以低打扰地关心之前提过的事项，但不要催促、质问离开原因或制造压力。`,
    };
  }
  if (bond.phase === 'confirmed' || bond.phase === 'passionate' || bond.phase === 'deep') {
    return {
      displayText: `${address}终于来了。不是催你，只是这段空白里确实想过怎么接上话。`,
      seedIntent: `用户长时间离开后回到会话。角色可以表达稳定、温柔的想念和重新接上话的意愿，但不要质问离开原因。`,
    };
  }
  if (bond.phase === 'ambiguous' || bond.phase === 'fond') {
    return {
      displayText: `${address}回来了。这边松了一口气，想把话放轻一点，等你自然接上。`,
      seedIntent: `用户长时间离开后回到会话。角色可以温和欢迎回来，语气克制、低压力，给用户自然接话空间，不要把关系说死。`,
    };
  }
  return null;
}

interface ResolvedOnlineReturnEvent {
  text: string;
  blocked: boolean;
  sourceEventId: string;
}

interface ResolvedUnsentDraftEvent {
  text: string;
  blocked: boolean;
  sourceEventId: string;
}

function onlineReturnPayloadOf(event: RuntimeEventV2): CompanionshipOnlineReturnEventPayload | null {
  const payload = event.payload as Partial<CompanionshipOnlineReturnEventPayload> | undefined;
  if (!payload || payload.eventType !== 'companionship_online_return' || !payload.characterId || !payload.action) return null;
  return payload as CompanionshipOnlineReturnEventPayload;
}

function unsentDraftPayloadOf(event: RuntimeEventV2): CompanionshipUnsentDraftEventPayload | null {
  const payload = event.payload as Partial<CompanionshipUnsentDraftEventPayload> | undefined;
  if (!payload || payload.eventType !== 'companionship_unsent_draft' || !payload.characterId || !payload.action) return null;
  return payload as CompanionshipUnsentDraftEventPayload;
}

function resolveUnsentDraftEvent(chat: GroupChat, characterId: string, now: number): ResolvedUnsentDraftEvent | null {
  const events = (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact')
    .map((event) => ({ event, payload: unsentDraftPayloadOf(event) }))
    .filter((item): item is { event: RuntimeEventV2; payload: CompanionshipUnsentDraftEventPayload } => {
      if (!item.payload) return false;
      if (item.payload.characterId !== characterId || (item.payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return false;
      if (typeof item.payload.availableAt === 'number' && item.payload.availableAt > now) return false;
      if (typeof item.payload.expiresAt === 'number' && item.payload.expiresAt <= now) return false;
      const confidence = typeof item.payload.confidence === 'number' && Number.isFinite(item.payload.confidence) ? item.payload.confidence : 1;
      return confidence >= 0.6;
    })
    .sort((a, b) => (b.event.createdAt || 0) - (a.event.createdAt || 0));
  const latest = events[0];
  if (!latest) return null;
  if (latest.payload.action === 'suppressed' || latest.payload.action === 'dismissed' || latest.payload.action === 'expired') {
    return {
      text: '',
      blocked: true,
      sourceEventId: latest.event.id,
    };
  }
  const text = compactText(latest.payload.text || latest.payload.reason || latest.event.summary, 80);
  if (!text) return null;
  return {
    text,
    blocked: false,
    sourceEventId: latest.event.id,
  };
}

function resolveOnlineReturnEvent(chat: GroupChat, characterId: string, now: number): ResolvedOnlineReturnEvent | null {
  const events = (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact')
    .map((event) => ({ event, payload: onlineReturnPayloadOf(event) }))
    .filter((item): item is { event: RuntimeEventV2; payload: CompanionshipOnlineReturnEventPayload } => {
      if (!item.payload) return false;
      if (item.payload.characterId !== characterId || (item.payload.userId || USER_ACTOR_ID) !== USER_ACTOR_ID) return false;
      if (typeof item.payload.availableAt === 'number' && item.payload.availableAt > now) return false;
      if (typeof item.payload.expiresAt === 'number' && item.payload.expiresAt <= now) return false;
      const confidence = typeof item.payload.confidence === 'number' && Number.isFinite(item.payload.confidence) ? item.payload.confidence : 1;
      return confidence >= 0.6;
    })
    .sort((a, b) => (b.event.createdAt || 0) - (a.event.createdAt || 0));
  const latest = events[0];
  if (!latest) return null;
  if (latest.payload.action === 'suppressed' || latest.payload.action === 'dismissed') {
    return {
      text: '',
      blocked: true,
      sourceEventId: latest.event.id,
    };
  }
  const text = compactText(latest.payload.text || latest.payload.reason || latest.event.summary, 80);
  if (!text) return null;
  return {
    text,
    blocked: false,
    sourceEventId: latest.event.id,
  };
}

export function buildCompanionshipStatusSignature(params: {
  chat: GroupChat;
  character: AICharacter;
  messages: Message[];
  now?: number;
}): CompanionshipStatusSignature | null {
  const now = params.now || Date.now();
  const projection = buildUserCompanionshipProjection({ ...params, now });
  const bond = projection.userBond;
  if (!bond) return null;
  const sharedAnchorLabels = getSharedAnchorLabels(params.character, now, params.chat);
  const sharedPhraseLabels = buildSharedPhrases(params.character, now, params.chat, params.messages)
    .filter((phrase) => phrase.participantIds.includes(USER_ACTOR_ID))
    .map(formatSharedPhraseForPrompt)
    .slice(0, 3);
  const carePolicy = bond.carePolicy;
  const offlineTrace = buildOfflineTrace(bond, carePolicy, now);
  const unsentDraftEvent = resolveUnsentDraftEvent(params.chat, params.character.id, now);
  const unsentDraft = unsentDraftEvent?.blocked ? '' : (unsentDraftEvent?.text || buildUnsentDraft(bond, carePolicy, now));
  const onlineReturnEvent = resolveOnlineReturnEvent(params.chat, params.character.id, now);
  const localOnlineReturnProjection = !onlineReturnEvent ? buildOnlineReturnProjection(bond, carePolicy, now) : null;
  const onlineReturn = onlineReturnEvent?.blocked ? '' : (onlineReturnEvent?.text || localOnlineReturnProjection?.displayText || '');
  const onlineReturnIntent = onlineReturn
    ? (localOnlineReturnProjection?.seedIntent || '用户长时间离开后回到会话。角色可以低打扰地欢迎回来，顺着当前对话自然接上，不要催促或质问离开原因。')
    : '';
  return {
    text: buildStatusText(bond, carePolicy, now),
    tone: statusTone(bond.phase),
    chips: buildStatusChips(bond, carePolicy),
    debugLines: [
      `phase=${bond.phase} style=${bond.style}`,
      `address=${bond.addressing.currentAddress} confidence=${bond.userProfile.confidence}`,
      `intimacy attraction=${bond.intimacy.attraction} intimacy=${bond.intimacy.intimacy} longing=${bond.intimacy.longing} security=${bond.intimacy.security}`,
      `attachment=${bond.attachmentProfile.inferredStyle} confidence=${bond.attachmentProfile.confidence}${bond.attachmentProfile.adaptations.length ? ` adaptations=${bond.attachmentProfile.adaptations.join(' / ')}` : ''}`,
      bond.intimateConflict ? `conflict=${bond.intimateConflict.kind} severity=${bond.intimateConflict.severity} repair=${bond.intimateConflict.repairReadiness} summary=${bond.intimateConflict.summary}` : '',
      bond.pendingCareTopics.length ? `care=${bond.pendingCareTopics.map((item) => item.text).join(' / ')}` : '',
      bond.pendingPromises.length ? `promises=${bond.pendingPromises.map((item) => item.text).join(' / ')}` : '',
      bond.userProfile.boundaries.length ? `boundaries=${bond.userProfile.boundaries.join(' / ')}` : '',
      carePolicy.boundaryReasons.length ? `restraints=${carePolicy.boundaryReasons.join(' / ')}` : '',
      offlineTrace ? `offlineTrace=${offlineTrace}` : '',
      unsentDraft ? `unsentDraft=${unsentDraft}${unsentDraftEvent ? ` source=${unsentDraftEvent.sourceEventId}` : ''}` : '',
      unsentDraftEvent?.blocked ? `unsentDraft=suppressed source=${unsentDraftEvent.sourceEventId}` : '',
      onlineReturn ? `onlineReturn=${onlineReturn}${onlineReturnEvent ? ` source=${onlineReturnEvent.sourceEventId}` : ''}` : '',
      onlineReturnIntent ? `onlineReturnIntent=${onlineReturnIntent}` : '',
      onlineReturnEvent?.blocked ? `onlineReturn=suppressed source=${onlineReturnEvent.sourceEventId}` : '',
      sharedAnchorLabels.length ? `sharedAnchors=${sharedAnchorLabels.join(' / ')}` : '',
      sharedPhraseLabels.length ? `sharedPhrases=${sharedPhraseLabels.join(' / ')}` : '',
      projection.evidence.length ? `evidence=${projection.evidence.join(' / ')}` : '',
    ].filter(Boolean),
    addressing: bond.addressing,
    offlineTrace: offlineTrace || undefined,
    unsentDraft: unsentDraft || undefined,
    onlineReturn: onlineReturn || undefined,
    onlineReturnIntent: onlineReturnIntent || undefined,
    updatedAt: now,
  };
}

export interface HomeCompanionshipSnapshot {
  chatId: string;
  characterId: string;
  characterName: string;
  text: string;
  tone: CompanionshipStatusSignature['tone'];
  debugLines: string[];
  updatedAt: number;
}

export function buildHomeCompanionshipSnapshot(params: {
  chats: GroupChat[];
  characters: AICharacter[];
  messages: Message[];
  now?: number;
}): HomeCompanionshipSnapshot | null {
  const now = params.now || Date.now();
  const byCharacterId = new Map(params.characters.map((character) => [character.id, character]));
  const messagesByChatId = new Map<string, Message[]>();
  params.messages.forEach((message) => {
    const items = messagesByChatId.get(message.chatId);
    if (items) {
      items.push(message);
    } else {
      messagesByChatId.set(message.chatId, [message]);
    }
  });
  const candidates = params.chats
    .filter((chat) => chat.type === 'direct' && chat.memberIds[0])
    .map((chat) => {
      const character = byCharacterId.get(chat.memberIds[0]);
      if (!character) return null;
      const chatMessages = messagesByChatId.get(chat.id) || [];
      const signature = buildCompanionshipStatusSignature({ chat, character, messages: chatMessages, now });
      const text = signature?.onlineReturn || signature?.unsentDraft || signature?.offlineTrace || '';
      if (!signature || !text) return null;
      const priority = signature.onlineReturn ? 4 : signature.unsentDraft ? 3 : signature.offlineTrace ? 2 : 1;
      return {
        chat,
        character,
        signature,
        text,
        priority,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const candidatesByCharacter = new Map<string, { selected: (typeof candidates)[number]; count: number }>();
  candidates.forEach((candidate) => {
    const previous = candidatesByCharacter.get(candidate.character.id);
    const previousSelected = previous?.selected;
    const shouldReplace = !previousSelected
      || candidate.priority > previousSelected.priority
      || (candidate.priority === previousSelected.priority && (candidate.chat.lastMessageAt || 0) > (previousSelected.chat.lastMessageAt || 0));
    candidatesByCharacter.set(candidate.character.id, {
      selected: shouldReplace ? candidate : previousSelected,
      count: (previous?.count || 0) + 1,
    });
  });
  const aggregated = Array.from(candidatesByCharacter.values())
    .sort((left, right) => right.selected.priority - left.selected.priority || (right.selected.chat.lastMessageAt || 0) - (left.selected.chat.lastMessageAt || 0));
  const selectedGroup = aggregated[0];
  const selected = selectedGroup?.selected;
  if (!selected) return null;
  return {
    chatId: selected.chat.id,
    characterId: selected.character.id,
    characterName: selected.character.name,
    text: selected.text,
    tone: selected.signature.tone,
    debugLines: [
      ...selected.signature.debugLines,
      selectedGroup.count > 1 ? `homeAggregation=character:${selected.character.id} candidates=${selectedGroup.count}` : '',
    ].filter(Boolean),
    updatedAt: now,
  };
}

function buildPromptLines(bond: UserBondState, carePolicy: CarePolicy, evidence: string[], sharedAnchors: SharedMemoryAnchor[], sharedPhrases: SharedPhrase[]) {
  const intimacy = bond.intimacy;
  const profile = bond.userProfile;
  const profileCueGroups = [
    profile.addressPreference ? `address ${profile.addressPreference}` : '',
    profile.scheduleHints.length ? `schedule ${profile.scheduleHints.join(' / ')}` : '',
    profile.preferences.length ? `preferences ${profile.preferences.join(' / ')}` : '',
    profile.dislikes.length ? `dislikes ${profile.dislikes.join(' / ')}` : '',
    profile.boundaries.length ? `boundaries ${profile.boundaries.join(' / ')}` : '',
    profile.pressureSources.length ? `pressure ${profile.pressureSources.join(' / ')}` : '',
    profile.importantDates.length ? `important dates ${profile.importantDates.join(' / ')}` : '',
    profile.recentPlans.length ? `plans ${profile.recentPlans.join(' / ')}` : '',
    profile.emotionalPatterns.length ? `emotional patterns ${profile.emotionalPatterns.join(' / ')}` : '',
  ].filter(Boolean);
  const lines = [
    `- Bond style: ${bond.style}; phase: ${phaseLabel(bond.phase)}.`,
    `- Intimacy cues: attraction ${intimacy.attraction}, intimacy ${intimacy.intimacy}, attachment ${intimacy.attachment}, longing ${intimacy.longing}, security ${intimacy.security}. Use them as internal guidance, not as words to reveal.`,
    profileCueGroups.length ? `- High-confidence user profile cues: ${profileCueGroups.join('; ')}.` : '',
    profile.sourceTexts.length && !profileCueGroups.length ? `- Remembered user cues: ${profile.sourceTexts.slice(0, 3).join(' / ')}.` : '',
    profile.boundaries.length ? `- User boundaries: ${profile.boundaries.join(' / ')}. These override intimacy and proactive care.` : '',
    `- Address the user naturally as "${bond.addressing.currentAddress}" unless the latest message suggests another appropriate address.`,
    sharedAnchors.length ? `- Shared memory anchors with the user: ${sharedAnchors.map(formatSharedAnchorForPrompt).join(' / ')}. Use as relationship texture only when relevant; do not expose internal labels.` : '',
    sharedPhrases.length ? `- Shared phrases/private lines: ${sharedPhrases.map(formatSharedPhraseForPrompt).join(' / ')}. Reuse only when emotionally earned; do not force catchphrases or explain them.` : '',
    bond.pendingCareTopics.length ? `- Pending care topics: ${bond.pendingCareTopics.map((item) => item.text).join(' / ')}.` : '',
    bond.pendingPromises.length ? `- Pending promises/unfinished shared plans: ${bond.pendingPromises.map((item) => {
      const remind = item.reminderPolicy.shouldRemind ? `reminder tone ${item.reminderPolicy.tone}` : 'do not proactively remind';
      return `${item.text} (${formatPromiseKind(item.kind)}; ${remind})`;
    }).join(' / ')}. Treat them as remembered commitments, not pressure; if a boundary agreement exists, follow it silently.` : '',
    bond.intimateConflict ? `- Current intimate conflict/repair state: ${bond.intimateConflict.summary} Repair readiness ${bond.intimateConflict.repairReadiness}; severity ${bond.intimateConflict.severity}. Use this only to choose restraint, accountability, apology, space, or gentle repair.` : '',
    bond.attachmentProfile.confidence >= 58 ? `- User attachment adaptation: ${bond.attachmentProfile.adaptations.join(' / ')}. Do not label the user or mention attachment style.` : '',
    bond.unresolvedTensions.length ? `- Current restraint: ${bond.unresolvedTensions.join(' / ')}.` : '',
    `- Care policy: budget ${carePolicy.dailyInitiationBudget}/day, sensitivity ${carePolicy.triggerSensitivity}, expression ${carePolicy.expressionIntensity}, silence threshold ${carePolicy.silenceAnxietyThresholdHours}h.`,
    carePolicy.boundaryReasons.length ? `- Boundary restraints: ${carePolicy.boundaryReasons.join(' / ')}.` : '',
    evidence.length ? `- Evidence: ${evidence.slice(0, 3).join(' / ')}.` : '',
    '- Do not claim a confirmed romantic relationship unless explicit relationship-confirming events or user settings already support it.',
    '- Let care show through concrete memory, timing, omissions, and tone. Do not mention scores, phases, policies, or this runtime.',
  ].filter(Boolean);
  return lines;
}

export function buildUserCompanionshipProjection(params: {
  chat: GroupChat;
  character: AICharacter;
  messages: Message[];
  now?: number;
}): CompanionshipProjection {
  const { chat, character, messages } = params;
  if (chat.type !== 'direct') return { userBond: null, evidence: [], promptLines: [] };
  const now = params.now || Date.now();
  const ledger = getCharacterToUserLedger(chat, character.id);
  const promiseEventState = buildPromiseEventState(chat, character.id, now);
  const suppressedPromiseKeys = promiseEventState.closedKeys;
  const userProfile = buildUserProfileProjection(chat, character, messages, now, suppressedPromiseKeys);
  const sharedAnchors = buildUserSharedAnchors(character, now, chat)
    .filter((anchor) => !textMatchesSuppressedPromise(`${anchor.text}\n${anchor.evidence || ''}`, suppressedPromiseKeys));
  const promiseConsequences = buildPromiseIntimacyConsequences(chat, character.id, now);
  const anchoredIntimacy = adjustIntimacyProjection({
    base: projectIntimacy(ledger),
    sharedAnchors,
    promiseConsequences,
  });
  const longTermTrend = buildLongTermIntimacyTrend(chat, character.id, now);
  const baseIntimacy = applyLongTermIntimacyTrend(anchoredIntimacy, longTermTrend);
  const phaseEvent = resolveCompanionshipPhaseEvent(chat, character.id);
  const baseInferredPhase = inferPhase(baseIntimacy, ledger, sharedAnchors);
  const phase = phaseEvent?.phase || baseInferredPhase;
  const contacts = getLatestContact(messages, character.id);
  const pendingCareTopics = buildPendingCareTopics(chat, character.id, userProfile, messages, now, suppressedPromiseKeys);
  const pendingPromises = buildPendingPromises({
    chat,
    characterId: character.id,
    profile: userProfile,
    messages,
    sharedAnchors,
    now,
  });
  const sharedPhrases = buildSharedPhrases(character, now, chat, messages)
    .filter((phrase) => phrase.participantIds.includes(USER_ACTOR_ID))
    .filter((phrase) => !textMatchesSuppressedPromise(`${phrase.text}\n${phrase.evidence || ''}`, suppressedPromiseKeys))
    .slice(0, 4);
  const sharedSecrets = buildSharedSecrets(character, now, chat);
  const intimateConflict = resolveIntimateConflictEvent(chat, character.id, now) ?? undefined;
  const evidence = [
    ...buildPhaseEvidence(ledger, pendingCareTopics, phaseEvent),
    ...(!phaseEvent ? buildAnchorPhaseEvidence(sharedAnchors, phase) : []),
    Object.values(longTermTrend).some((value) => value) ? `long_term_intimacy_trend=${Object.entries(longTermTrend).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(',')}` : '',
  ].filter(Boolean).slice(0, 6);
  const attachmentProfile = buildUserAttachmentProfile({ chat, characterId: character.id, messages, profile: userProfile, intimacy: baseIntimacy, now });
  const intimacy = adjustIntimacyForCompanionshipRuntime({
    base: baseIntimacy,
    sharedSecrets,
    intimateConflict,
    attachmentProfile,
  });
  const preferredIntimacyStyle = inferPreferredStyle(character, intimacy);
  const carePolicy = applyGlobalCompanionshipSettingsToCarePolicy(applyAttachmentToCarePolicy(buildCarePolicy(phase, preferredIntimacyStyle, userProfile), attachmentProfile), character);
  const bond: UserBondState = {
    userId: USER_ACTOR_ID,
    characterId: character.id,
    style: resolveBondStyle(phase, phaseEvent?.style),
    phase,
    phaseEnteredAt: phaseEvent?.enteredAt || ledger?.lastUpdatedAt || contacts.lastMeaningfulContactAt || now,
    phaseEvidence: evidence,
    transitionReadiness: clampScore((intimacy.attraction + intimacy.intimacy + intimacy.security) / 3),
    intimacy,
    lastMeaningfulContactAt: contacts.lastMeaningfulContactAt,
    lastUserReplyAt: contacts.lastUserReplyAt,
    lastCharacterInitiatedAt: contacts.lastCharacterInitiatedAt,
    pendingCareTopics,
    pendingPromises,
    rememberedUserPlans: buildRememberedPlans(pendingCareTopics),
    unresolvedTensions: buildUnresolvedTensions(ledger),
    intimateConflict,
    addressing: buildAddressing(userProfile, phase, now, chat, character.id),
    userProfile,
    attachmentProfile,
    preferredIntimacyStyle,
    carePolicy,
  };
  return {
    userBond: bond,
    evidence: [...sharedAnchors.map(formatSharedAnchorForPrompt), ...sharedPhrases.map(formatSharedPhraseForPrompt), ...(intimateConflict?.evidence || []), ...evidence].slice(0, 6),
    promptLines: buildPromptLines(bond, carePolicy, evidence, sharedAnchors, sharedPhrases),
  };
}

export function buildCompanionshipPromptBlock(params: {
  chat: GroupChat;
  character: AICharacter;
  messages: Message[];
  now?: number;
}) {
  const projection = buildUserCompanionshipProjection(params);
  if (projection.userBond && projection.promptLines.length) {
    return `\n## Companionship Context\n${projection.promptLines.join('\n')}`;
  }
  const publicLines = buildPublicRoomUserCompanionshipLines(params.chat, params.character);
  if (!publicLines.length) return '';
  return `\n## Companionship Context\n${publicLines.join('\n')}`;
}

export function buildPublicRoomUserCompanionshipLines(chat: GroupChat, character: AICharacter) {
  if (chat.type === 'direct') return [];
  if (!(chat.memberIds || []).includes(USER_ACTOR_ID)) return [];
  const ledger = getCharacterToUserLedger(chat, character.id);
  const semantic = buildPublicSafeUserRelationshipStance(ledger);
  const userMemoryCount = character.memory?.userMemories?.length || 0;
  const boundaryCount = (character.memory?.userMemories || [])
    .filter((text) => /(不要|不想|别|公开|隐私|边界|禁忌|压力|焦虑|面试|考试|生日|纪念|私下)/.test(text))
    .length;
  const lines = [
    '- The user is a room participant with possible private continuity with you. Let familiarity, care, restraint, or distance subtly affect tone when relevant.',
    semantic ? `- Private relationship stance toward the user: ${semantic}. Use it as acting context, not as exposition.` : '',
    userMemoryCount ? '- User-related memories exist, but this is not a pair-private channel. Do not reveal private user facts, private addresses, sensitive plans, or pair-only promises unless the user brings them into this room.' : '',
    boundaryCount ? '- Known user boundaries or sensitive cues exist. Prefer restraint, avoid public pressure, and do not turn private care into public exposure.' : '',
    '- In public or scenario rooms, show companionship through timing, omissions, protection, warmth, or careful wording rather than explaining the relationship system.',
  ].filter(Boolean);
  return lines;
}

function hasPrivateUserDisclosureRisk(text: string | undefined | null) {
  return /(不要|不想|别|公开|隐私|边界|禁忌|压力|焦虑|面试|考试|生日|纪念|私下|只告诉|秘密|住址|地址|电话|手机号|微信|QQ|生病|不舒服|失眠|抑郁|创伤|计划|下周|明天|今晚|昨晚|约定|承诺|称呼)/.test(text || '');
}

function buildPublicSafeUserRelationshipStance(ledger: RelationshipLedgerEntry | null) {
  const semantic = ledger?.derived?.semantic;
  if (!semantic) return '';
  const summary = compactText(semantic.summary || '', 140);
  if (summary && !hasPrivateUserDisclosureRisk(summary)) return summary;
  const stage = !hasPrivateUserDisclosureRisk(semantic.stage) ? compactText(semantic.stage || '', 48) : '';
  const labels = (semantic.labels || [])
    .filter((label) => !hasPrivateUserDisclosureRisk(label))
    .map((label) => compactText(label, 24))
    .filter(Boolean)
    .slice(0, 3);
  const parts = [stage, labels.length ? labels.join('、') : ''].filter(Boolean);
  if (parts.length) return parts.join('：');
  return semantic.intensity >= 45 ? 'familiar but private continuity exists' : 'private continuity exists';
}

function inferCharacterCompanionshipStyle(relation: AICharacter['relationships'][number]): CharacterCompanionshipState['style'] {
  const warmth = relation.warmth || 0;
  const trust = relation.trust || 0;
  const competence = relation.competence || 0;
  const threat = relation.threat || 0;
  const note = relation.note || '';
  if (threat >= 34 && warmth >= 18) return 'rival_with_care';
  if (/(暧昧|心动|喜欢|牵挂|在意)/.test(note) && warmth >= 32 && trust >= 18) return 'romantic_tension';
  if (competence >= 42 && trust >= 28 && warmth < 48) return 'mentor_protege';
  if (warmth >= 58 && trust >= 52 && competence >= 24) return 'partner';
  if (warmth >= 46 && trust >= 36) return 'close_friend';
  if (warmth >= 34 && threat <= 18) return 'sibling_like';
  return threat >= 24 ? 'rival_with_care' : 'close_friend';
}

function extractSharedTexture(note: string, patterns: RegExp[], max = 2) {
  if (!note) return [];
  return patterns
    .map((pattern) => note.match(pattern)?.[0])
    .filter(Boolean)
    .slice(0, max) as string[];
}

function uniqueTextureLines(lines: string[], max = 3) {
  const seen = new Set<string>();
  return lines
    .map((line) => compactText(line, 96))
    .filter(Boolean)
    .filter((line) => {
      const key = line.replace(/\s+/g, '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

function classifySharedMemoryAnchor(text: string): SharedMemoryAnchor['kind'] | null {
  if (/(第一次|初次|第一次说|第一次见|第一次聊|第一次吵|第一次和好)/.test(text)) return 'first_time';
  if (/(表白|告白|说喜欢|确认关系|承认喜欢)/.test(text)) return 'confession';
  if (/(和好|修复|道歉|递台阶|重新靠近|冰释)/.test(text)) return 'repair';
  if (/(吵架|冲突|冷战|误会|翻旧账|决裂|裂痕)/.test(text)) return 'conflict';
  if (/(共同秘密|秘密|小秘密|只有.*知道|不能告诉|保密)/.test(text)) return 'shared_secret';
  if (/(约定|承诺|答应|说好|下次一起|以后一起|等你)/.test(text)) return 'promise';
  if (/(共同梗|暗号|玩笑|只有.*懂|梗)/.test(text)) return 'inside_joke';
  if (/(纪念日|里程碑|生日|重要日子|救场|告别|重逢)/.test(text)) return 'milestone';
  return null;
}

function formatSharedAnchorTitle(kind: SharedMemoryAnchor['kind']) {
  const titles: Record<SharedMemoryAnchor['kind'], string> = {
    first_time: '第一次',
    confession: '心意确认',
    conflict: '旧冲突',
    repair: '修复痕迹',
    inside_joke: '共同梗',
    shared_secret: '小秘密',
    promise: '未完成约定',
    milestone: '关系里程碑',
  };
  return titles[kind];
}

function hasExplicitGroupParticipantCue(text: string | undefined | null) {
  return /(大家|所有人|全员|群里|小队|团队|三人|四人|多人|我们几个|几个人|一起都|共同参与|都知道|都说好|小团体)/.test(text || '');
}

function normalizeAnchorParticipants(ownerId: string, subjectIds: string[] | undefined, context?: { chatType?: GroupChat['type']; text?: string }) {
  const ids = [ownerId, ...(subjectIds || [])]
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(ids)).slice(0, 6);
  if (unique.length <= 2) return unique;
  if (unique.includes(USER_ACTOR_ID)) {
    if (context?.chatType === 'direct' || !hasExplicitGroupParticipantCue(context?.text)) {
      return [ownerId, USER_ACTOR_ID].filter((id, index, list) => Boolean(id) && list.indexOf(id) === index);
    }
    return unique;
  }
  if (hasExplicitGroupParticipantCue(context?.text)) return unique;
  const partner = unique.find((id) => id !== ownerId);
  return [ownerId, partner].filter((id): id is string => Boolean(id));
}

function splitRelationshipNoteAnchorTexts(note: string) {
  return note
    .split(/[。；;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4);
}

function sharedAnchorPayloadOf(event: RuntimeEventV2): CompanionshipSharedAnchorEventPayload | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || payload.eventType !== 'companionship_shared_anchor') return null;
  const action = payload.action;
  if (action !== 'upsert' && action !== 'merge' && action !== 'archive' && action !== 'revoke') return null;
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : '';
  const anchorId = typeof payload.anchorId === 'string' ? payload.anchorId : '';
  if (!characterId || !anchorId) return null;
  const kind = payload.kind;
  const participantIds = Array.isArray(payload.participantIds)
    ? payload.participantIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 6)
    : undefined;
  const mergedAnchorIds = Array.isArray(payload.mergedAnchorIds)
    ? payload.mergedAnchorIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 8)
    : undefined;
  const sourceEventIds = Array.isArray(payload.sourceEventIds)
    ? payload.sourceEventIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 8)
    : undefined;
  const sourceMessageIds = normalizeSourceMessageIds(payload.sourceMessageIds);
  return {
    eventType: 'companionship_shared_anchor',
    characterId,
    userId: typeof payload.userId === 'string' ? payload.userId : undefined,
    anchorId,
    action,
    kind: kind === 'first_time'
      || kind === 'confession'
      || kind === 'conflict'
      || kind === 'repair'
      || kind === 'inside_joke'
      || kind === 'shared_secret'
      || kind === 'promise'
      || kind === 'milestone'
      ? kind
      : undefined,
    participantIds,
    title: typeof payload.title === 'string' ? compactText(payload.title, 80) : undefined,
    text: typeof payload.text === 'string' ? compactText(payload.text, 180) : undefined,
    salience: typeof payload.salience === 'number' && Number.isFinite(payload.salience) ? payload.salience : undefined,
    confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
    evidence: typeof payload.evidence === 'string' ? compactText(payload.evidence, 180) : undefined,
    mergedAnchorIds,
    sourceEventIds,
    sourceMessageIds,
    reason: typeof payload.reason === 'string' ? compactText(payload.reason, 120) : undefined,
    decisionSource: payload.decisionSource === 'model' || payload.decisionSource === 'local_fallback' ? payload.decisionSource : undefined,
  };
}

function diaryReflectionPayloadOf(event: RuntimeEventV2): CompanionshipDiaryReflectionEventPayload | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || payload.eventType !== 'companionship_diary_reflection') return null;
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : '';
  const reflectionId = typeof payload.reflectionId === 'string' ? payload.reflectionId : '';
  const diaryEntryId = typeof payload.diaryEntryId === 'string' ? payload.diaryEntryId : '';
  // Normalize legacy events too, before truncation can hide the seed delimiter.
  const text = typeof payload.text === 'string' ? cleanSeedForReflection(payload.text) : '';
  const reflectionType = payload.reflectionType;
  if (!characterId || !reflectionId || !diaryEntryId || !text) return null;
  if (reflectionType !== 'care'
    && reflectionType !== 'promise'
    && reflectionType !== 'shared_secret'
    && reflectionType !== 'ritual'
    && reflectionType !== 'shared_anchor'
    && reflectionType !== 'shared_phrase') return null;
  const participantIds = Array.isArray(payload.participantIds)
    ? payload.participantIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 6)
    : [characterId, typeof payload.userId === 'string' ? payload.userId : USER_ACTOR_ID];
  return {
    eventType: 'companionship_diary_reflection',
    characterId,
    userId: typeof payload.userId === 'string' ? payload.userId : undefined,
    reflectionId,
    diaryEntryId,
    dateKey: typeof payload.dateKey === 'string' ? payload.dateKey : null,
    reflectionType,
    participantIds,
    text,
    sourceSeed: typeof payload.sourceSeed === 'string' ? compactText(payload.sourceSeed, 220) : undefined,
    diaryExcerpt: typeof payload.diaryExcerpt === 'string' ? compactText(payload.diaryExcerpt, 180) : undefined,
    confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
    decisionSource: payload.decisionSource === 'model' || payload.decisionSource === 'local_fallback' ? payload.decisionSource : undefined,
  };
}

function momentReflectionPayloadOf(event: RuntimeEventV2): CompanionshipMomentReflectionEventPayload | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || payload.eventType !== 'companionship_moment_reflection') return null;
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : '';
  const reflectionId = typeof payload.reflectionId === 'string' ? payload.reflectionId : '';
  const text = typeof payload.text === 'string' ? compactText(payload.text, 180) : '';
  const reflectionType = payload.reflectionType;
  if (!characterId || !reflectionId || !text) return null;
  if (reflectionType !== 'promise'
    && reflectionType !== 'shared_secret'
    && reflectionType !== 'ritual'
    && reflectionType !== 'shared_anchor'
    && reflectionType !== 'shared_phrase') return null;
  const participantIds = Array.isArray(payload.participantIds)
    ? payload.participantIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 6)
    : [characterId, typeof payload.userId === 'string' ? payload.userId : USER_ACTOR_ID];
  return {
    eventType: 'companionship_moment_reflection',
    characterId,
    userId: typeof payload.userId === 'string' ? payload.userId : undefined,
    reflectionId,
    momentDedupeKey: typeof payload.momentDedupeKey === 'string' ? payload.momentDedupeKey : undefined,
    reflectionType,
    participantIds,
    text,
    sourceSeed: typeof payload.sourceSeed === 'string' ? compactText(payload.sourceSeed, 220) : undefined,
    momentText: typeof payload.momentText === 'string' ? compactText(payload.momentText, 180) : undefined,
    confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
    decisionSource: payload.decisionSource === 'model' || payload.decisionSource === 'local_fallback' ? payload.decisionSource : undefined,
  };
}

function sharedAnchorTextKey(anchor: Pick<SharedMemoryAnchor, 'kind' | 'participantIds' | 'text'>) {
  return `${anchor.kind}:${anchor.participantIds.slice().sort().join(',')}:${anchor.text.replace(/\s+/g, '').slice(0, 48)}`;
}

function sharedAnchorPayloadTextKey(payload: CompanionshipSharedAnchorEventPayload, characterId: string) {
  const kind = payload.kind || classifySharedMemoryAnchor(`${payload.text || ''}\n${payload.evidence || ''}`);
  const text = compactText(payload.text || payload.evidence || payload.reason, 180);
  if (!kind || !text) return '';
  const participantIds = normalizeAnchorParticipants(characterId, payload.participantIds?.length ? payload.participantIds.filter((id) => id !== characterId) : [payload.userId || USER_ACTOR_ID], {
    chatType: undefined,
    text,
  });
  return sharedAnchorTextKey({ kind, participantIds, text });
}

function isSharedAnchorSuppressed(anchor: SharedMemoryAnchor, state: ReturnType<typeof buildRuntimeEventSharedAnchorState>) {
  return state.closedIds.has(anchor.id)
    || Boolean(anchor.sourceId && state.closedIds.has(anchor.sourceId))
    || state.closedTextKeys.has(sharedAnchorTextKey(anchor));
}

function buildRuntimeEventSharedAnchorState(chat: GroupChat | undefined, character: AICharacter, now: number) {
  const activeById = new Map<string, SharedMemoryAnchor>();
  const closedIds = new Set<string>();
  const closedTextKeys = new Set<string>();
  (chat?.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .forEach((event) => {
      const payload = sharedAnchorPayloadOf(event);
      if (!payload || payload.characterId !== character.id) return;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 1;
      if (confidence < 0.6) return;
      const textKey = sharedAnchorPayloadTextKey(payload, character.id);
      if (payload.action === 'archive' || payload.action === 'revoke') {
        activeById.delete(payload.anchorId);
        closedIds.add(payload.anchorId);
        (payload.mergedAnchorIds || []).forEach((id) => closedIds.add(id));
        if (textKey) closedTextKeys.add(textKey);
        return;
      }
      const previous = activeById.get(payload.anchorId);
      const kind = payload.kind || classifySharedMemoryAnchor(`${payload.text || ''}\n${payload.evidence || ''}`);
      const text = compactText(payload.text || payload.evidence || payload.reason, 180);
      if (!kind || !text) return;
      const participantIds = normalizeAnchorParticipants(character.id, payload.participantIds?.length ? payload.participantIds.filter((id) => id !== character.id) : [payload.userId || USER_ACTOR_ID], {
        chatType: chat?.type,
        text: `${payload.text || ''}\n${payload.evidence || ''}\n${payload.reason || ''}`,
      });
      (payload.mergedAnchorIds || []).forEach((id) => {
        if (id !== payload.anchorId) {
          activeById.delete(id);
          closedIds.add(id);
        }
      });
      closedIds.delete(payload.anchorId);
      if (textKey) closedTextKeys.delete(textKey);
      activeById.set(payload.anchorId, {
        id: `runtime-anchor-${payload.anchorId}`,
        kind,
        participantIds,
        title: payload.title || formatSharedAnchorTitle(kind),
        text,
        salience: clampRelationshipScore(payload.salience ?? 68),
        confidence: clampRelationshipScore(confidence * 100),
        source: 'runtime_event',
        sourceId: event.id,
        evidence: payload.evidence || event.summary || payload.reason,
        sourceMessageIds: normalizeSourceMessageIds(previous?.sourceMessageIds, payload.sourceMessageIds, event.evidenceMessageIds),
        createdAt: event.createdAt || now,
        updatedAt: event.createdAt || now,
      });
    });
  return {
    activeAnchors: Array.from(activeById.values()),
    closedIds,
    closedTextKeys,
  };
}

function buildSharedAnchorHistory(chat: GroupChat, characterId: string): SharedAnchorHistoryEntry[] {
  return (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .map((event): SharedAnchorHistoryEntry | null => {
      const payload = sharedAnchorPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return null;
      const kind = payload.kind || classifySharedMemoryAnchor(`${payload.text || ''}\n${payload.evidence || ''}`);
      const text = compactText(payload.text || payload.evidence || payload.reason || event.summary, 180);
      if (!text) return null;
      const participantIds = normalizeAnchorParticipants(characterId, payload.participantIds?.length ? payload.participantIds.filter((id) => id !== characterId) : [payload.userId || USER_ACTOR_ID], {
        chatType: chat.type,
        text: `${payload.text || ''}\n${payload.evidence || ''}\n${payload.reason || ''}`,
      });
      if (!participantIds.includes(characterId) || !participantIds.includes(USER_ACTOR_ID)) return null;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return null;
      const reason = payload.reason ? compactText(payload.reason, 140) : undefined;
      const evidence = [event.summary, reason, payload.evidence]
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map((item) => compactText(item, 140))
        .slice(0, 5);
      return {
        id: event.id,
        action: payload.action,
        anchorId: payload.anchorId,
        kind: kind || undefined,
        participantIds,
        title: payload.title,
        text,
        salience: typeof payload.salience === 'number' && Number.isFinite(payload.salience) ? payload.salience : undefined,
        reason,
        evidence,
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        mergedAnchorIds: payload.mergedAnchorIds || [],
        decisionSource: payload.decisionSource,
        confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
        occurredAt: event.createdAt || 0,
      };
    })
    .filter((item): item is SharedAnchorHistoryEntry => Boolean(item))
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 10);
}

function buildRuntimeEventSharedAnchors(chat: GroupChat | undefined, character: AICharacter, now: number): SharedMemoryAnchor[] {
  const explicitState = buildRuntimeEventSharedAnchorState(chat, character, now);
  const diaryAnchors = (chat?.runtimeEventsV2 || [])
    .map((event): SharedMemoryAnchor | null => {
      const payload = diaryReflectionPayloadOf(event);
      if (!payload || payload.characterId !== character.id || payload.reflectionType === 'care' || payload.reflectionType === 'shared_phrase') return null;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 0.6;
      if (confidence < 0.55) return null;
      const inferredKind = payload.reflectionType === 'promise'
        ? 'promise'
        : payload.reflectionType === 'shared_secret'
          ? 'shared_secret'
          : payload.reflectionType === 'ritual'
            ? 'inside_joke'
            : classifySharedMemoryAnchor(`${payload.text}\n${payload.sourceSeed || ''}`) || 'milestone';
      const participantIds = normalizeAnchorParticipants(character.id, payload.participantIds.filter((id) => id !== character.id), {
        chatType: chat?.type,
        text: `${payload.text}\n${payload.sourceSeed || ''}\n${payload.diaryExcerpt || ''}`,
      });
      return {
        id: `diary-reflection-${payload.reflectionId}`,
        kind: inferredKind,
        participantIds,
        title: formatSharedAnchorTitle(inferredKind),
        text: payload.text,
        salience: clampRelationshipScore(48 + confidence * 30),
        confidence: clampRelationshipScore(confidence * 100),
        source: 'runtime_event',
        sourceId: event.id,
        evidence: compactText(payload.diaryExcerpt || payload.sourceSeed || event.summary, 180),
        sourceMessageIds: normalizeSourceMessageIds(event.evidenceMessageIds),
        createdAt: event.createdAt || now,
        updatedAt: event.createdAt || now,
      };
    })
    .filter((item): item is SharedMemoryAnchor => Boolean(item));
  const momentAnchors = (chat?.runtimeEventsV2 || [])
    .map((event): SharedMemoryAnchor | null => {
      const payload = momentReflectionPayloadOf(event);
      if (!payload || payload.characterId !== character.id || payload.reflectionType === 'shared_phrase') return null;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 0.55;
      if (confidence < 0.5) return null;
      const inferredKind = payload.reflectionType === 'promise'
        ? 'promise'
        : payload.reflectionType === 'shared_secret'
          ? 'shared_secret'
          : payload.reflectionType === 'ritual'
            ? 'inside_joke'
            : classifySharedMemoryAnchor(`${payload.text}\n${payload.sourceSeed || ''}`) || 'milestone';
      const participantIds = normalizeAnchorParticipants(character.id, payload.participantIds.filter((id) => id !== character.id), {
        chatType: chat?.type,
        text: `${payload.text}\n${payload.sourceSeed || ''}\n${payload.momentText || ''}`,
      });
      return {
        id: `moment-reflection-${payload.reflectionId}`,
        kind: inferredKind,
        participantIds,
        title: formatSharedAnchorTitle(inferredKind),
        text: payload.text,
        salience: clampRelationshipScore(40 + confidence * 24),
        confidence: clampRelationshipScore(confidence * 100),
        source: 'runtime_event',
        sourceId: event.id,
        evidence: compactText(payload.momentText || payload.sourceSeed || event.summary, 180),
        sourceMessageIds: normalizeSourceMessageIds(event.evidenceMessageIds),
        createdAt: event.createdAt || now,
        updatedAt: event.createdAt || now,
      };
    })
    .filter((item): item is SharedMemoryAnchor => Boolean(item));
  const conflictAnchors = (chat?.runtimeEventsV2 || [])
    .map((event): SharedMemoryAnchor | null => {
      const payload = intimateConflictEventPayloadOf(event);
      if (!payload || payload.characterId !== character.id) return null;
      const userId = payload.userId || USER_ACTOR_ID;
      if (userId !== USER_ACTOR_ID) return null;
      const participantIds = payload.participantIds?.length ? payload.participantIds : [character.id, USER_ACTOR_ID];
      if (!participantIds.includes(character.id) || !participantIds.includes(USER_ACTOR_ID)) return null;
      const isRepair = payload.action === 'repair_attempted' || payload.action === 'resolved' || payload.kind === 'repair_attempt' || payload.kind === 'reconciliation';
      const kind: SharedMemoryAnchor['kind'] = isRepair ? 'repair' : 'conflict';
      const evidence = [event.summary, ...(payload.evidence || [])].filter(Boolean).map((item) => compactText(item, 120)).slice(0, 3).join(' / ');
      const fallbackText = isRepair
        ? '一次亲密冲突后的修复尝试，需要记住双方愿意重新说开的痕迹。'
        : '一次亲密关系里的冲突或误会，需要记住具体伤点和克制边界。';
      const severity = clampRelationshipScore(payload.severity ?? (isRepair ? 42 : 58));
      const repair = clampRelationshipScore(payload.repairReadiness ?? (isRepair ? 64 : 18));
      return {
        id: `runtime-${event.id}`,
        kind,
        participantIds,
        title: formatSharedAnchorTitle(kind),
        text: compactText(payload.summary || event.summary || fallbackText, 180),
        salience: clampRelationshipScore(isRepair ? 44 + repair * 0.42 : 50 + severity * 0.44),
        confidence: clampRelationshipScore((payload.confidence ?? 0.72) * 100),
        source: 'runtime_event',
        sourceId: event.id,
        evidence,
        sourceMessageIds: normalizeSourceMessageIds(event.evidenceMessageIds),
        createdAt: event.createdAt || now,
        updatedAt: event.createdAt || now,
      };
    })
    .filter((item): item is SharedMemoryAnchor => Boolean(item));
  return [
    ...explicitState.activeAnchors,
    ...diaryAnchors.filter((anchor) => !isSharedAnchorSuppressed(anchor, explicitState)),
    ...momentAnchors.filter((anchor) => !isSharedAnchorSuppressed(anchor, explicitState)),
    ...conflictAnchors.filter((anchor) => !isSharedAnchorSuppressed(anchor, explicitState)),
  ];
}

export function buildSharedMemoryAnchors(character: AICharacter, now = 0, chat?: GroupChat): SharedMemoryAnchor[] {
  const runtimeAnchorState = buildRuntimeEventSharedAnchorState(chat, character, now);
  const layeredAnchors = (character.layeredMemories || [])
    .filter((item) => isMemoryAnchorCandidate(item))
    .map((item): SharedMemoryAnchor | null => {
      const text = compactText(item.summary || item.text, 180);
      const evidence = compactText(item.evidenceText, 180);
      const kind = classifySharedMemoryAnchor(`${text}\n${evidence}`) || (item.kind === 'conflict' || item.kind === 'resentment' ? 'conflict' : item.kind === 'bond' ? 'milestone' : null);
      if (!kind) return null;
      return {
        id: `memory-${item.id}`,
        kind,
        participantIds: normalizeAnchorParticipants(character.id, item.subjectIds, {
          text: `${text}\n${evidence}`,
        }),
        title: formatSharedAnchorTitle(kind),
        text,
        salience: clampRelationshipScore(item.salience * 100),
        confidence: clampRelationshipScore(item.confidence * 100),
        source: 'layered_memory',
        sourceId: item.id,
        evidence,
        sourceMessageIds: [],
        createdAt: item.createdAt || now,
        updatedAt: item.updatedAt || item.distilledAt || now,
      };
    })
    .filter((item): item is SharedMemoryAnchor => Boolean(item))
    .filter((anchor) => !isSharedAnchorSuppressed(anchor, runtimeAnchorState));

  const relationshipAnchors = (character.relationships || []).flatMap((relation, relationIndex) => {
    if (!relation.characterId || relation.characterId === USER_ACTOR_ID || relation.characterId.startsWith('draft-')) return [];
    return splitRelationshipNoteAnchorTexts(relation.note || '').map((text, noteIndex): SharedMemoryAnchor | null => {
      const kind = classifySharedMemoryAnchor(text);
      if (!kind) return null;
      const positiveWeight = Math.max(0, relation.warmth || 0) + Math.max(0, relation.trust || 0);
      const tensionWeight = Math.max(0, relation.threat || 0);
      return {
        id: `relationship-${relation.characterId}-${relationIndex}-${noteIndex}`,
        kind,
        participantIds: [character.id, relation.characterId].filter(Boolean),
        title: formatSharedAnchorTitle(kind),
        text: compactText(text, 180),
        salience: clampRelationshipScore(42 + positiveWeight * 0.22 + tensionWeight * 0.18),
        confidence: clampRelationshipScore(52 + Math.max(0, relation.trust || 0) * 0.32),
        source: 'relationship_note',
        sourceId: relation.characterId,
        evidence: compactText(relation.note, 180),
        sourceMessageIds: [],
        createdAt: relation.updatedAt || now,
        updatedAt: relation.updatedAt || now,
      };
    }).filter((item): item is SharedMemoryAnchor => Boolean(item))
      .filter((anchor) => !isSharedAnchorSuppressed(anchor, runtimeAnchorState));
  });

  const seen = new Set<string>();
  const runtimeEventAnchors = buildRuntimeEventSharedAnchors(chat, character, now);

  return [...layeredAnchors, ...relationshipAnchors, ...runtimeEventAnchors]
    .filter((anchor) => {
      const key = sharedAnchorTextKey(anchor);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.salience + b.confidence + b.updatedAt / DAY_MS) - (a.salience + a.confidence + a.updatedAt / DAY_MS))
    .slice(0, 12);
}

function inferSecretLeakState(text: string): SharedSecret['leakState'] {
  if (/(已经公开|传开|泄露|说漏|被发现)/.test(text)) return 'leaked';
  if (/(坦白|主动说出|承认了|说开了)/.test(text)) return 'confessed';
  if (/(暗示|影射|含蓄提到|公开留白)/.test(text)) return 'hinted_publicly';
  return 'sealed';
}

function isSharedSecretConsequenceKind(value: unknown): value is NonNullable<SharedSecret['consequenceKind']> {
  return value === 'none'
    || value === 'misunderstanding'
    || value === 'accidental_leak'
    || value === 'intentional_breach'
    || value === 'protective_confession'
    || value === 'voluntary_confession';
}

function inferSecretConsequenceKind(text: string, leakState: SharedSecret['leakState']): SharedSecret['consequenceKind'] {
  const normalized = text || '';
  if (leakState === 'leaked') {
    if (/(误会|误解|以为|不是故意|没那个意思|话赶话|语境|被曲解)/.test(normalized)) return 'misunderstanding';
    if (/(说漏|无意|不小心|顺口|没忍住|被发现|露馅)/.test(normalized)) return 'accidental_leak';
    if (/(故意|背叛|公开|传开|泄露|出卖|越界|拿.*威胁|当众)/.test(normalized)) return 'intentional_breach';
  }
  if (leakState === 'confessed') {
    if (/(保护|怕.*误会|不想.*误会|为了不让.*误会|怕你受伤|先说清楚|保护性坦白)/.test(normalized)) return 'protective_confession';
    if (/(坦白|主动说出|主动说开|承认|说开|交代)/.test(normalized)) return 'voluntary_confession';
  }
  return 'none';
}

function buildSecretPublicMask(anchor: SharedMemoryAnchor) {
  if (anchor.participantIds.includes(USER_ACTOR_ID)) return '有一件只适合留在心里的事';
  if (/(暗号|共同梗|玩笑)/.test(anchor.text)) return '一个只有熟人懂的暗号';
  return '一个没有展开说的秘密';
}

function sharedSecretEventPayloadOf(event: RuntimeEventV2): CompanionshipSharedSecretEventPayload | null {
  const payload = event.payload as Partial<CompanionshipSharedSecretEventPayload> | undefined;
  if (!payload || payload.eventType !== 'companionship_shared_secret' || !payload.characterId || !payload.secretId || !payload.action || !payload.privateText || !Array.isArray(payload.participantIds)) return null;
  return payload as CompanionshipSharedSecretEventPayload;
}

function secretLeakStateFromAction(action: CompanionshipSharedSecretEventPayload['action']): SharedSecret['leakState'] {
  if (action === 'leaked') return 'leaked';
  if (action === 'confessed') return 'confessed';
  if (action === 'hinted_publicly') return 'hinted_publicly';
  return 'sealed';
}

function secretKey(text: string) {
  return compactText(text, 180).replace(/\s+/g, '').slice(0, 72);
}

function buildRuntimeEventSharedSecrets(chat: GroupChat | undefined, character: AICharacter, now: number) {
  const activeById = new Map<string, SharedSecret>();
  const revokedKeys = new Set<string>();
  (chat?.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'artifact')
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .forEach((event) => {
      const payload = sharedSecretEventPayloadOf(event);
      if (!payload || payload.characterId !== character.id) return;
      const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : 1;
      if (confidence < 0.6) return;
      const participantIds = Array.from(new Set(payload.participantIds.filter(Boolean))).slice(0, 6);
      if (!participantIds.includes(character.id)) return;
      const privateText = compactText(payload.privateText, 180);
      const key = secretKey(privateText);
      if (!privateText || !key) return;
      const previous = activeById.get(payload.secretId);
      if (payload.action === 'revoked') {
        activeById.delete(payload.secretId);
        revokedKeys.add(key);
        return;
      }
      revokedKeys.delete(key);
      const leakState = secretLeakStateFromAction(payload.action);
      const consequenceText = [
        payload.consequenceKind,
        payload.privateText,
        payload.publicMask,
        payload.reason,
        payload.evidence,
        payload.action,
      ].filter(Boolean).join('\n');
      activeById.set(payload.secretId, {
        id: payload.secretId,
        participantIds,
        privateText,
        publicMask: compactText(payload.publicMask || (participantIds.includes(USER_ACTOR_ID) ? '有一件只适合留在心里的事' : '一个没有展开说的秘密'), 80),
        leakState,
        consequenceKind: isSharedSecretConsequenceKind(payload.consequenceKind)
          ? payload.consequenceKind
          : inferSecretConsequenceKind(consequenceText, leakState),
        emotionalWeight: clampRelationshipScore(payload.emotionalWeight ?? 68),
        sourceAnchorId: `runtime-${event.id}`,
        sourceEventIds: Array.from(new Set([...(previous?.sourceEventIds || []), event.id])).slice(-8),
        sourceMessageIds: normalizeSourceMessageIds(previous?.sourceMessageIds, payload.sourceMessageIds, event.evidenceMessageIds),
        updatedAt: event.createdAt || now,
      });
    });
  return {
    activeSecrets: Array.from(activeById.values()).sort((left, right) => (right.emotionalWeight + right.updatedAt / DAY_MS) - (left.emotionalWeight + left.updatedAt / DAY_MS)),
    revokedKeys,
  };
}

function buildSharedSecretHistory(chat: GroupChat, characterId: string): SharedSecretHistoryEntry[] {
  return (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .map((event): SharedSecretHistoryEntry | null => {
      const payload = sharedSecretEventPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return null;
      const participantIds = Array.from(new Set(payload.participantIds.filter((id) => typeof id === 'string' && Boolean(id.trim())))).slice(0, 8);
      if (!participantIds.includes(characterId) || !participantIds.includes(USER_ACTOR_ID)) return null;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return null;
      const leakState = secretLeakStateFromAction(payload.action);
      const publicMask = compactText(payload.publicMask || (participantIds.includes(USER_ACTOR_ID) ? '有一件只适合留在心里的事' : '一个没有展开说的秘密'), 100);
      const consequenceText = [
        payload.consequenceKind,
        payload.publicMask,
        payload.reason,
        payload.evidence,
        payload.action,
      ].filter(Boolean).join('\n');
      const reason = typeof payload.reason === 'string' ? compactText(payload.reason, 140) : undefined;
      const evidence = [event.summary, reason, payload.evidence]
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map((item) => compactText(item, 140))
        .slice(0, 5);
      return {
        id: event.id,
        action: payload.action,
        secretId: payload.secretId,
        participantIds,
        publicMask,
        leakState,
        consequenceKind: isSharedSecretConsequenceKind(payload.consequenceKind)
          ? payload.consequenceKind
          : inferSecretConsequenceKind(consequenceText, leakState),
        reason,
        evidence,
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        emotionalWeight: typeof payload.emotionalWeight === 'number' && Number.isFinite(payload.emotionalWeight) ? payload.emotionalWeight : undefined,
        decisionSource: payload.decisionSource,
        confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
        occurredAt: event.createdAt || 0,
      };
    })
    .filter((item): item is SharedSecretHistoryEntry => Boolean(item))
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 10);
}

function isSecretSuppressedByRuntimeEvent(anchor: SharedMemoryAnchor, revokedKeys: Set<string>) {
  const key = secretKey(`${anchor.text}\n${anchor.evidence || ''}`);
  if (!key) return false;
  return Array.from(revokedKeys).some((revoked) => key.includes(revoked) || revoked.includes(key));
}

export function buildSharedSecrets(character: AICharacter, now = 0, chat?: GroupChat): SharedSecret[] {
  const runtimeState = buildRuntimeEventSharedSecrets(chat, character, now);
  const anchorSecrets = buildSharedMemoryAnchors(character, now, chat)
    .filter((anchor) => anchor.kind === 'shared_secret')
    .filter((anchor) => !isSecretSuppressedByRuntimeEvent(anchor, runtimeState.revokedKeys))
    .map((anchor): SharedSecret => {
      const evidenceText = `${anchor.text}\n${anchor.evidence || ''}`;
      const leakState = inferSecretLeakState(evidenceText);
      return {
        id: `secret-${anchor.id}`,
        participantIds: anchor.participantIds,
        privateText: anchor.text,
        publicMask: buildSecretPublicMask(anchor),
        leakState,
        consequenceKind: inferSecretConsequenceKind(evidenceText, leakState),
        emotionalWeight: clampRelationshipScore(anchor.salience * 0.58 + anchor.confidence * 0.34 + (anchor.participantIds.includes(USER_ACTOR_ID) ? 8 : 0)),
        sourceAnchorId: anchor.id,
        sourceEventIds: anchor.sourceId ? [anchor.sourceId] : [],
        sourceMessageIds: normalizeSourceMessageIds(anchor.sourceMessageIds),
        updatedAt: anchor.updatedAt || now,
      };
    });
  return [...runtimeState.activeSecrets, ...anchorSecrets]
    .sort((a, b) => (b.emotionalWeight + b.updatedAt / DAY_MS) - (a.emotionalWeight + a.updatedAt / DAY_MS))
    .slice(0, 8);
}

function ritualFromAnchor(anchor: SharedMemoryAnchor): RitualRegistryEntry | null {
  const kind: RitualRegistryEntry['kind'] | null = anchor.kind === 'inside_joke'
    ? 'inside_joke'
    : anchor.kind === 'repair'
      ? 'reconciliation'
      : anchor.kind === 'milestone' || anchor.kind === 'confession' || anchor.kind === 'first_time'
        ? 'milestone'
        : anchor.kind === 'promise'
          ? 'anniversary'
          : null;
  if (!kind) return null;
  return {
    id: `ritual-${anchor.id}`,
    kind,
    participantIds: anchor.participantIds,
    trigger: kind === 'reconciliation' ? 'conflict_resolved' : kind === 'anniversary' ? 'date' : kind === 'inside_joke' ? 'keyword' : 'phase_change',
    content: anchor.text,
    evolution: [anchor.title, anchor.evidence].filter(Boolean).map((item) => compactText(item, 120)),
    cooldownHours: kind === 'inside_joke' ? 24 : kind === 'reconciliation' ? 72 : 24 * 14,
    boundaryReasons: [],
    sourceAnchorId: anchor.id,
    sourceMessageIds: normalizeSourceMessageIds(anchor.sourceMessageIds),
    updatedAt: anchor.updatedAt,
  };
}

function ritualEventPayloadOf(event: RuntimeEventV2): CompanionshipRitualEventPayload | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || payload.eventType !== 'companionship_ritual') return null;
  const action = payload.action;
  if (action !== 'performed' && action !== 'suppressed' && action !== 'skipped' && action !== 'restored' && action !== 'updated') return null;
  const kind = payload.kind;
  if (
    kind !== 'daily_greeting'
    && kind !== 'anniversary'
    && kind !== 'inside_joke'
    && kind !== 'pet_name'
    && kind !== 'reconciliation'
    && kind !== 'milestone'
  ) return null;
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : '';
  const ritualId = typeof payload.ritualId === 'string' ? payload.ritualId : '';
  if (!characterId || !ritualId) return null;
  return {
    eventType: 'companionship_ritual',
    characterId,
    userId: typeof payload.userId === 'string' ? payload.userId : undefined,
    ritualId,
    kind,
    action,
    participantIds: Array.isArray(payload.participantIds) ? payload.participantIds.filter((item): item is string => typeof item === 'string') : [],
    content: typeof payload.content === 'string' ? compactText(payload.content, 180) : undefined,
    evolution: Array.isArray(payload.evolution) ? payload.evolution.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120)).slice(0, 6) : undefined,
    reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    evidence: typeof payload.evidence === 'string' ? payload.evidence : undefined,
    sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds),
    nextAvailableAt: typeof payload.nextAvailableAt === 'number' && Number.isFinite(payload.nextAvailableAt) ? payload.nextAvailableAt : undefined,
    confidence: typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined,
    decisionSource: payload.decisionSource === 'model' || payload.decisionSource === 'local_fallback' ? payload.decisionSource : undefined,
  };
}

function buildRitualEventState(chat: GroupChat | undefined, characterId: string) {
  const state = new Map<string, {
    lastPerformedAt?: number;
    suppressedReason?: string;
    nextAvailableAt?: number;
    content?: string;
    evolution?: string[];
    sourceMessageIds?: string[];
    updatedAt: number;
  }>();
  (chat?.runtimeEventsV2 || []).forEach((event) => {
    const payload = ritualEventPayloadOf(event);
    if (!payload || payload.characterId !== characterId) return;
    const createdAt = event.createdAt || 0;
    const previous = state.get(payload.ritualId);
    if (previous && previous.updatedAt > createdAt) return;
    state.set(payload.ritualId, {
      lastPerformedAt: payload.action === 'performed' ? createdAt : previous?.lastPerformedAt,
      suppressedReason: payload.action === 'suppressed' ? compactText(payload.reason || payload.evidence || 'ritual suppressed', 120) : undefined,
      nextAvailableAt: payload.action === 'updated' ? previous?.nextAvailableAt : payload.nextAvailableAt,
      content: payload.content || previous?.content,
      evolution: payload.evolution?.length ? payload.evolution : previous?.evolution,
      sourceMessageIds: normalizeSourceMessageIds(previous?.sourceMessageIds, payload.sourceMessageIds, event.evidenceMessageIds),
      updatedAt: createdAt,
    });
  });
  return state;
}

function buildRitualHistory(chat: GroupChat, characterId: string): RitualHistoryEntry[] {
  return (chat.runtimeEventsV2 || [])
    .filter((event): event is RuntimeEventV2 => Boolean(event?.payload))
    .map((event): RitualHistoryEntry | null => {
      const payload = ritualEventPayloadOf(event);
      if (!payload || payload.characterId !== characterId) return null;
      const userId = payload.userId || (payload.participantIds.includes(USER_ACTOR_ID) ? USER_ACTOR_ID : undefined);
      if (userId && userId !== USER_ACTOR_ID) return null;
      if (payload.userId === undefined && payload.participantIds.length && !payload.participantIds.includes(USER_ACTOR_ID)) return null;
      const actorMatches = !event.actorIds?.length || event.actorIds.includes(characterId) || event.actorIds.includes(USER_ACTOR_ID);
      const targetMatches = !event.targetIds?.length || event.targetIds.includes(characterId) || event.targetIds.includes(USER_ACTOR_ID);
      if (!actorMatches || !targetMatches) return null;
      return {
        id: event.id,
        ritualId: payload.ritualId,
        kind: payload.kind,
        action: payload.action,
        participantIds: payload.participantIds.length ? payload.participantIds : [characterId, USER_ACTOR_ID],
        content: payload.content,
        evolution: payload.evolution || [],
        reason: compactText(payload.reason || event.summary, 140),
        evidence: [payload.evidence, payload.reason, event.summary, ...(payload.evolution || [])].filter(Boolean).map((item) => compactText(item, 120)).slice(0, 5) as string[],
        sourceMessageIds: normalizeSourceMessageIds(payload.sourceMessageIds, event.evidenceMessageIds),
        nextAvailableAt: payload.nextAvailableAt,
        decisionSource: payload.decisionSource,
        confidence: payload.confidence,
        occurredAt: event.createdAt || 0,
      };
    })
    .filter((item): item is RitualHistoryEntry => Boolean(item))
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 10);
}

function applyRitualExecutionState(ritual: RitualRegistryEntry, eventState: ReturnType<typeof buildRitualEventState>, now: number): RitualRegistryEntry {
  const state = eventState.get(ritual.id);
  const lastPerformedAt = state?.lastPerformedAt;
  const cooldownNextAt = lastPerformedAt && ritual.cooldownHours > 0
    ? lastPerformedAt + ritual.cooldownHours * 60 * 60_000
    : undefined;
  const nextAvailableAt = Math.max(cooldownNextAt || 0, state?.nextAvailableAt || 0) || undefined;
  const boundaryReasons = [
    ...ritual.boundaryReasons,
    state?.suppressedReason ? `ritual suppressed: ${state.suppressedReason}` : '',
    nextAvailableAt && nextAvailableAt > now ? `ritual cooldown until ${new Date(nextAvailableAt).toISOString()}` : '',
  ].filter(Boolean);
  const executionState: RitualRegistryEntry['executionState'] = boundaryReasons.some((reason) => reason.startsWith('ritual suppressed'))
    ? 'suppressed'
    : nextAvailableAt && nextAvailableAt > now
      ? 'cooldown'
      : 'available';
  return {
    ...ritual,
    content: state?.content || ritual.content,
    evolution: state?.evolution?.length ? Array.from(new Set([...ritual.evolution, ...state.evolution])).slice(0, 8) : ritual.evolution,
    sourceMessageIds: normalizeSourceMessageIds(ritual.sourceMessageIds, state?.sourceMessageIds),
    lastPerformedAt: lastPerformedAt || ritual.lastPerformedAt,
    nextAvailableAt,
    executionState,
    boundaryReasons,
  };
}

function isRitualKindEnabled(kind: RitualRegistryEntry['kind']) {
  const toggles = getCompanionshipRuntimeConfig().ritualKindToggles;
  return toggles?.[kind] !== false;
}

export function buildRitualRegistry(params: {
  character: AICharacter;
  chat?: GroupChat;
  messages?: Message[];
  now?: number;
}): RitualRegistryEntry[] {
  if (!getCompanionshipRuntimeConfig().enableRelationshipRituals) return [];
  const now = params.now || Date.now();
  const messages = params.messages || [];
  const profileChat = params.chat || ({ runtimeEventsV2: [] } as unknown as GroupChat);
  const profile = buildUserProfileProjection(profileChat, params.character, messages, now);
  const phase = params.chat
    ? resolveCompanionshipPhaseEvent(params.chat, params.character.id)?.phase || null
    : null;
  const boundaryReasons: string[] = [];
  if (hasBoundary(profile, [/不要.*(早安|晚安)/, /不想.*(早安|晚安)/, /不希望.*(早安|晚安)/, /不需要.*(早安|晚安)/, /不愿.*(早安|晚安)/])) {
    boundaryReasons.push('user rejects greeting rituals');
  }
  if (hasBoundary(profile, [/不.*(恋爱|暧昧|情侣|对象|占有|吃醋)/, /只.*朋友/])) {
    boundaryReasons.push('user does not want romantic framing');
  }
  const address = buildAddressing(profile, phase || 'curious', now).currentAddress;
  const rituals: RitualRegistryEntry[] = [];
  if (!boundaryReasons.includes('user rejects greeting rituals')) {
    rituals.push({
      id: `ritual-${params.character.id}-daily-greeting`,
      kind: 'daily_greeting',
      participantIds: [params.character.id, USER_ACTOR_ID],
      trigger: 'time',
      content: `用${address}轻度表达早安/晚安，不机械打卡。`,
      evolution: profile.scheduleHints.slice(0, 2),
      cooldownHours: 12,
      boundaryReasons: [],
      updatedAt: now,
    });
  }
  if (address && address !== '用户' && address !== '你') {
    rituals.push({
      id: `ritual-${params.character.id}-pet-name-${address}`,
      kind: 'pet_name',
      participantIds: [params.character.id, USER_ACTOR_ID],
      trigger: 'keyword',
      content: `私下称呼可以自然使用“${address}”，但冲突或冷淡时退回中性称呼。`,
      evolution: profile.sourceTexts.filter((text) => text.includes(address)).slice(0, 3),
      cooldownHours: 0,
      boundaryReasons,
      updatedAt: now,
    });
  }
  profile.importantDates.slice(0, 3).forEach((dateText, index) => {
    rituals.push({
      id: `ritual-${params.character.id}-important-date-${index}`,
      kind: 'anniversary',
      participantIds: [params.character.id, USER_ACTOR_ID],
      trigger: 'date',
      content: dateText,
      evolution: [dateText],
      cooldownHours: 24 * 7,
      boundaryReasons: [],
      updatedAt: now,
    });
  });
  buildSharedMemoryAnchors(params.character, now, params.chat)
    .map(ritualFromAnchor)
    .filter((item): item is RitualRegistryEntry => Boolean(item))
    .forEach((ritual) => rituals.push(ritual));
  const eventState = buildRitualEventState(params.chat, params.character.id);
  const seen = new Set<string>();
  return rituals
    .filter((ritual) => {
      const key = `${ritual.kind}:${ritual.participantIds.slice().sort().join(',')}:${ritual.content.replace(/\s+/g, '').slice(0, 48)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((ritual) => isRitualKindEnabled(ritual.kind))
    .map((ritual) => applyRitualExecutionState(ritual, eventState, now))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 10);
}

export function buildCharacterCompanionshipStates(character: AICharacter, now = 0, chat?: GroupChat): CharacterCompanionshipState[] {
  const byTarget = new Map<string, CharacterCompanionshipState>();
  const upsert = (targetId: string, patch: Partial<CharacterCompanionshipState>) => {
    if (!targetId || targetId === USER_ACTOR_ID || targetId.startsWith('draft-')) return;
    const previous = byTarget.get(targetId);
    byTarget.set(targetId, {
      actorId: character.id,
      targetId,
      style: patch.style || previous?.style || 'close_friend',
      closeness: clampRelationshipScore(Math.max(previous?.closeness || 0, patch.closeness || 0)),
      protectiveness: clampRelationshipScore(Math.max(previous?.protectiveness || 0, patch.protectiveness || 0)),
      reliance: clampRelationshipScore(Math.max(previous?.reliance || 0, patch.reliance || 0)),
      sharedSecrets: uniqueTextureLines([...(previous?.sharedSecrets || []), ...(patch.sharedSecrets || [])]),
      sharedRituals: uniqueTextureLines([...(previous?.sharedRituals || []), ...(patch.sharedRituals || [])]),
      sharedPromises: uniqueTextureLines([...(previous?.sharedPromises || []), ...(patch.sharedPromises || [])]),
      unresolvedCareTopics: uniqueTextureLines([...(previous?.unresolvedCareTopics || []), ...(patch.unresolvedCareTopics || [])]),
      lastCareAt: Math.max(previous?.lastCareAt || 0, patch.lastCareAt || now),
    });
  };

  (character.relationships || [])
    .filter((relation) => relation.characterId && relation.characterId !== USER_ACTOR_ID && !relation.characterId.startsWith('draft-'))
    .forEach((relation) => {
      const warmth = relation.warmth || 0;
      const trust = relation.trust || 0;
      const competence = relation.competence || 0;
      const threat = relation.threat || 0;
      const note = relation.note || '';
      upsert(relation.characterId, {
        style: inferCharacterCompanionshipStyle(relation),
        closeness: warmth * 0.58 + trust * 0.38 - threat * 0.24,
        protectiveness: warmth * 0.36 + trust * 0.34 + threat * 0.26,
        reliance: trust * 0.46 + competence * 0.42 + warmth * 0.12 - threat * 0.18,
        sharedSecrets: extractSharedTexture(note, [/共同秘密[^，。；;]*/, /秘密[^，。；;]*/, /只有他们知道[^，。；;]*/]),
        sharedRituals: extractSharedTexture(note, [/共同梗[^，。；;]*/, /仪式[^，。；;]*/, /暗号[^，。；;]*/]),
        sharedPromises: extractSharedTexture(note, [/约定[^，。；;]*/, /承诺[^，。；;]*/, /说好[^，。；;]*/, /下次一起[^，。；;]*/, /以后一起[^，。；;]*/]),
        unresolvedCareTopics: extractSharedTexture(note, [/担心[^，。；;]*/, /放心不下[^，。；;]*/, /想帮[^，。；;]*/, /护着[^，。；;]*/]),
        lastCareAt: relation.updatedAt || now,
      });
    });

  (chat?.relationshipLedger || [])
    .filter((entry) => entry.actorId === character.id && entry.targetId !== USER_ACTOR_ID && !entry.targetId.startsWith('draft-'))
    .forEach((entry) => {
      const normalized = normalizeRelationshipLedgerEntry(entry);
      const relationLike = {
        characterId: normalized.targetId,
        warmth: normalized.current.warmth,
        trust: normalized.current.trust,
        competence: normalized.current.competence,
        threat: normalized.current.threat,
        note: [normalized.derived?.semantic?.summary, ...(normalized.derived?.semantic?.labels || [])].filter(Boolean).join('；'),
      } as AICharacter['relationships'][number];
      const note = [
        normalized.derived?.semantic?.summary,
        ...(normalized.recentEvents || []).slice(-3).map((event) => event.summary),
      ].filter(Boolean).join('；');
      upsert(normalized.targetId, {
        style: inferCharacterCompanionshipStyle(relationLike),
        closeness: normalized.current.warmth * 0.58 + normalized.current.trust * 0.38 - normalized.current.threat * 0.24,
        protectiveness: normalized.current.warmth * 0.36 + normalized.current.trust * 0.34 + normalized.current.threat * 0.26,
        reliance: normalized.current.trust * 0.46 + normalized.current.competence * 0.42 + normalized.current.warmth * 0.12 - normalized.current.threat * 0.18,
        sharedPromises: extractSharedTexture(note, [/约定[^，。；;]*/, /承诺[^，。；;]*/, /说好[^，。；;]*/, /下次一起[^，。；;]*/, /以后一起[^，。；;]*/]),
        unresolvedCareTopics: extractSharedTexture(note, [/担心[^，。；;]*/, /放心不下[^，。；;]*/, /想帮[^，。；;]*/, /护着[^，。；;]*/]),
        lastCareAt: normalized.lastUpdatedAt || now,
      });
    });

  buildSharedMemoryAnchors(character, now, chat)
    .filter((anchor) => anchor.participantIds.includes(character.id) && !anchor.participantIds.includes(USER_ACTOR_ID))
    .forEach((anchor) => {
      const targetId = anchor.participantIds.find((id) => id !== character.id && id !== USER_ACTOR_ID);
      if (!targetId) return;
      upsert(targetId, {
        closeness: anchor.kind === 'conflict' ? 28 : 36 + anchor.salience * 0.2,
        protectiveness: anchor.kind === 'conflict' ? 44 : 32 + anchor.salience * 0.18,
        reliance: anchor.kind === 'promise' || anchor.kind === 'repair' ? 36 + anchor.confidence * 0.2 : 24 + anchor.confidence * 0.12,
        sharedSecrets: anchor.kind === 'shared_secret' ? [anchor.text] : [],
        sharedRituals: anchor.kind === 'inside_joke' || anchor.kind === 'milestone' || anchor.kind === 'first_time' ? [anchor.text] : [],
        sharedPromises: anchor.kind === 'promise' ? [anchor.text] : [],
        unresolvedCareTopics: anchor.kind === 'repair' || anchor.kind === 'conflict' ? [anchor.text] : [],
        lastCareAt: anchor.updatedAt || now,
      });
    });

  return Array.from(byTarget.values())
    .filter((state) => state.closeness >= 24 || state.protectiveness >= 30 || state.reliance >= 28)
    .sort((a, b) => (b.closeness + b.protectiveness + b.reliance) - (a.closeness + a.protectiveness + a.reliance))
    .slice(0, 8);
}

export function buildCompanionshipArtifactSeeds(params: {
  character: Partial<AICharacter>;
  chat?: GroupChat;
  messages?: Message[];
  relatedCharacters?: Pick<AICharacter, 'id' | 'name'>[];
  surface?: 'private_diary' | 'public_moment';
  includeUserMemory?: boolean;
  max?: number;
  now?: number;
}): string[] {
  const {
    character,
    chat,
    messages,
    relatedCharacters = [],
    surface = 'private_diary',
    includeUserMemory = surface !== 'public_moment',
    max = surface === 'public_moment' ? 4 : 6,
    now = character.updatedAt || character.createdAt || Date.now(),
  } = params;
  if (!character.id) return [];
  if (!canProjectCompanionshipArtifacts(character) && !hasCompanionshipRuntimeEvents(chat, character.id)) return [];
  const companionCharacter = character as AICharacter;
  const members = buildCompanionshipDisplayMembers(character, relatedCharacters);
  const seeds: string[] = [];
  const isPublic = surface === 'public_moment';
  const sharedSecrets = buildSharedSecrets(companionCharacter, now, chat);
  const sharedPhrases = buildSharedPhrases(companionCharacter, now, chat, messages || []);
  const rituals = buildRitualRegistry({ character: companionCharacter, chat, messages, now });

  buildSharedMemoryAnchors(companionCharacter, now, chat)
    .slice(0, isPublic ? 3 : 4)
    .forEach((anchor) => {
      if (anchor.kind === 'shared_secret') return;
      const text = cleanArtifactSeedText(anchor.text, members, isPublic ? 90 : 140);
      if (!text) return;
      if (isPublic) {
        if (anchor.participantIds.includes(USER_ACTOR_ID)) {
          seeds.push(`公开动态可以只留下“有人懂”的余味，不点名用户，也不写成私密记忆：${text}。`);
        } else if (anchor.kind === 'inside_joke') {
          seeds.push(`公开动态可以像随手提到一个只有熟人懂的梗，不解释来龙去脉：${text}。`);
        } else if (anchor.kind === 'promise') {
          seeds.push(`公开动态可以把未完成约定写成一句自然期待：${text}。`);
        } else {
          seeds.push(`公开动态可以带一点关系余味，但不要写成事件报告：${text}。`);
        }
        return;
      }
      const participants = anchor.participantIds
        .map((id) => resolveCompanionshipActorName(id, relatedCharacters))
        .filter((name) => name !== (character.name || '这个角色'))
        .join('和');
      seeds.push(`${participants ? `和${participants}有关的` : ''}${anchor.title}可以成为日记里的私密回声：${text}。`);
    });

  sharedSecrets.slice(0, isPublic ? 2 : 3).forEach((secret) => {
    const participantNames = secret.participantIds
      .map((id) => resolveCompanionshipActorName(id, relatedCharacters))
      .filter((name) => name !== (character.name || '这个角色'))
      .join('和');
    if (isPublic) {
      seeds.push(`公开动态只能使用秘密的公开遮罩，不泄露具体内容：${secret.publicMask}。`);
      return;
    }
    seeds.push(`${participantNames ? `和${participantNames}之间的` : ''}小秘密可以成为私密日记材料：${cleanArtifactSeedText(secret.privateText, members, 140)}。`);
  });

  sharedPhrases.slice(0, isPublic ? 2 : 3).forEach((phrase) => {
    if (isPublic && (phrase.participantIds.includes(USER_ACTOR_ID) || phrase.visibility === 'private')) return;
    const text = cleanArtifactSeedText(phrase.visibility === 'private' ? phrase.text : phrase.text, members, isPublic ? 72 : 120);
    if (!text) return;
    if (isPublic) {
      seeds.push(`公开动态可以把共同话语写成“懂的人自然懂”的轻微生活痕迹，不解释来源：${text}。`);
      return;
    }
    const participantNames = phrase.participantIds
      .map((id) => resolveCompanionshipActorName(id, relatedCharacters))
      .filter((name) => name !== (character.name || '这个角色'))
      .join('和');
    seeds.push(`${participantNames ? `和${participantNames}之间的` : ''}${sharedPhraseKindLabel(phrase.kind)}可以成为日记里的私下回声，避免机械复读：${text}。`);
  });

  rituals.slice(0, isPublic ? 2 : 3).forEach((ritual) => {
    if (ritual.executionState === 'cooldown' || ritual.executionState === 'suppressed') return;
    if (isPublic && ritual.participantIds.includes(USER_ACTOR_ID)) return;
    const text = cleanArtifactSeedText(ritual.content, members, isPublic ? 90 : 140);
    if (!text) return;
    if (isPublic) {
      if (ritual.kind === 'daily_greeting' || ritual.kind === 'pet_name') return;
      seeds.push(`公开动态可以把关系仪式写成生活痕迹，不解释系统含义：${text}。`);
      return;
    }
    seeds.push(`关系仪式可作为私密日记材料：${text}。`);
  });

  buildCharacterCompanionshipStates(companionCharacter, now, chat)
    .slice(0, isPublic ? 2 : 3)
    .forEach((state) => {
      const targetName = resolveCompanionshipActorName(state.targetId, relatedCharacters);
      const texture = [
        !isPublic && state.sharedSecrets[0] ? `小秘密：${cleanArtifactSeedText(state.sharedSecrets[0], members, 80)}` : '',
        state.sharedRituals[0] ? `共同梗/仪式：${cleanArtifactSeedText(state.sharedRituals[0], members, 80)}` : '',
        state.sharedPromises[0] ? `未完成约定：${cleanArtifactSeedText(state.sharedPromises[0], members, 80)}` : '',
        state.unresolvedCareTopics[0] ? `放心不下：${cleanArtifactSeedText(state.unresolvedCareTopics[0], members, 80)}` : '',
      ].filter(Boolean).join('；');
      if (isPublic) {
        if (texture) {
          seeds.push(`公开动态可以把和${targetName}之间的关系余波写成一句含蓄状态，不要暴露秘密细节：${texture}。`);
        } else if (state.closeness >= 42 || state.protectiveness >= 42 || state.reliance >= 42) {
          seeds.push(`公开动态可以让人感觉和${targetName}之间有熟悉感、护短或默契，但不要直接说明关系评分。`);
        }
        return;
      }
      if (texture) {
        seeds.push(`对${targetName}的关系纹理可以私下写成余波，不要写成系统记录：${texture}。`);
      } else if (state.closeness >= 42 || state.protectiveness >= 42 || state.reliance >= 42) {
        seeds.push(`对${targetName}可以写一点没有公开说出的在意、护短、信赖或别扭靠近。`);
      }
    });

  if (!isPublic && params.chat?.type === 'direct') {
    const projection = buildUserCompanionshipProjection({
      chat: params.chat,
      character: companionCharacter,
      messages: messages || [],
      now,
    });
    const bond = projection.userBond;
    bond?.pendingCareTopics.slice(0, 2).forEach((topic) => {
      const text = cleanArtifactSeedText(topic.text, members, 120);
      if (text) seeds.push(`未完成关心事项可以在日记里回流成“想问但没有急着问出口”的私下牵挂：${text}。`);
    });
    bond?.pendingPromises.slice(0, 2).forEach((promise) => {
      const text = cleanArtifactSeedText(promise.text, members, 120);
      if (text) seeds.push(`未完成约定可以在日记里成为轻微期待或担心落空的余波，不要写成催促：${text}。`);
    });
  }

  if (includeUserMemory) {
    (character.memory?.userMemories || [])
      .filter((text) => /(用户|叫我|喜欢|不喜欢|压力|面试|考试|约定|生日|纪念日|不要|不想)/.test(text))
      .slice(-3)
      .forEach((text) => {
        const cleaned = cleanArtifactSeedText(text, members, isPublic ? 80 : 120);
        if (!cleaned) return;
        seeds.push(isPublic
          ? `公开动态只能把这类用户记忆泛化成“有人/懂的人/一个约定”的余味，不点名用户：${cleaned}。`
          : `关于用户的记忆可以只轻轻影响日记，不要写成评价用户：${cleaned}。`);
      });
  }

  return Array.from(new Set(seeds.filter(Boolean))).slice(0, max);
}

export function buildCompanionshipRuntimeTrace(params: {
  chat: GroupChat;
  character: AICharacter;
  messages: Message[];
  now?: number;
}): CompanionshipRuntimeTrace | null {
  const projection = buildUserCompanionshipProjection(params);
  const bond = projection.userBond;
  if (!bond) return null;
  const profile = bond.userProfile;
  const carePolicy = bond.carePolicy;
  const sharedAnchorLabels = getSharedAnchorLabels(params.character, params.now || Date.now(), params.chat);
  const sharedSecretLabels = buildSharedSecrets(params.character, params.now || Date.now(), params.chat)
    .filter((secret) => secret.participantIds.includes(USER_ACTOR_ID))
    .map((secret) => secret.publicMask)
    .slice(0, 3);
  const sharedPhraseLabels = buildSharedPhrases(params.character, params.now || Date.now(), params.chat, params.messages)
    .filter((phrase) => phrase.participantIds.includes(USER_ACTOR_ID))
    .map((phrase) => `${sharedPhraseKindLabel(phrase.kind)}：${phrase.text}${phrase.visibility === 'private' ? ' · 私密' : ''}${phrase.reuseCount > 1 ? ` · 复用${phrase.reuseCount}` : ''}`)
    .slice(0, 4);
  const ritualLabels = buildRitualRegistry({
    character: params.character,
    chat: params.chat,
    messages: params.messages,
    now: params.now || Date.now(),
  }).map((ritual) => {
    const state = ritual.executionState || 'available';
    const suffix = state === 'cooldown' && ritual.nextAvailableAt
      ? ` · 冷却至 ${new Date(ritual.nextAvailableAt).toLocaleString()}`
      : state === 'suppressed'
        ? ` · 抑制：${ritual.boundaryReasons.slice(-1)[0] || '有边界限制'}`
        : '';
    return `${ritual.content} · ${state}${suffix}`;
  }).slice(0, 4);
  const diagnostics = buildCompanionshipDiagnostics(params.chat, params.character.id);
  const phaseHistory = buildPhaseHistory(params.chat, params.character.id);
  const userProfileHistory = buildUserProfileMemoryHistory(params.chat, params.character.id);
  const addressingHistory = buildAddressingHistory(params.chat, params.character.id);
  const careTopicHistory = buildCareTopicHistory(params.chat, params.character.id);
  const promiseHistory = buildPromiseHistory(params.chat, params.character.id);
  const sharedAnchorHistory = buildSharedAnchorHistory(params.chat, params.character.id);
  const sharedSecretHistory = buildSharedSecretHistory(params.chat, params.character.id);
  const sharedPhraseHistory = buildSharedPhraseHistory(params.chat, params.character.id);
  const ritualHistory = buildRitualHistory(params.chat, params.character.id);
  const conflictHistory = buildIntimateConflictHistory(params.chat, params.character.id);
  const attachmentHistory = buildAttachmentProfileHistory(params.chat, params.character.id);
  return {
    style: bond.style,
    phase: bond.phase,
    currentAddress: bond.addressing.currentAddress,
    sharedAnchors: sharedAnchorLabels.slice(0, 4),
    sharedPhrases: sharedPhraseLabels,
    sharedSecrets: sharedSecretLabels,
    rituals: ritualLabels,
    intimateConflict: bond.intimateConflict ? {
      kind: bond.intimateConflict.kind,
      severity: bond.intimateConflict.severity,
      repairReadiness: bond.intimateConflict.repairReadiness,
      summary: bond.intimateConflict.summary,
      sourceMessageIds: bond.intimateConflict.sourceMessageIds,
    } : undefined,
    pendingCareTopics: bond.pendingCareTopics.map((item) => item.text).slice(0, 4),
    pendingPromises: bond.pendingPromises.map((item) => {
      const remind = item.reminderPolicy.shouldRemind ? `提醒:${item.reminderPolicy.tone}` : '不主动提醒';
      const reason = item.reminderPolicy.boundaryReasons.length ? ` · ${item.reminderPolicy.boundaryReasons.join('/')}` : '';
      return `${formatPromiseKind(item.kind)}：${item.text} · ${remind}${reason}`;
    }).slice(0, 4),
    rememberedUserPlans: bond.rememberedUserPlans.slice(0, 4),
    boundaries: profile.boundaries.slice(0, 4),
    boundaryReasons: carePolicy.boundaryReasons.slice(0, 4),
    userProfileCues: profile.cues.slice(0, 6),
    addressingHistory,
    careTopicHistory,
    promiseHistory,
    sharedAnchorHistory,
    sharedSecretHistory,
    sharedPhraseHistory,
    ritualHistory,
    carePolicy: {
      dailyInitiationBudget: carePolicy.dailyInitiationBudget,
      triggerSensitivity: carePolicy.triggerSensitivity,
      silenceAnxietyThresholdHours: carePolicy.silenceAnxietyThresholdHours,
      expressionIntensity: carePolicy.expressionIntensity,
      allowGoodMorning: carePolicy.allowGoodMorning,
      allowGoodNight: carePolicy.allowGoodNight,
      allowMissYou: carePolicy.allowMissYou,
    },
    attachmentProfile: bond.attachmentProfile,
    phaseHistory,
    userProfileHistory,
    conflictHistory,
    attachmentHistory,
    diagnostics,
    evidence: projection.evidence.slice(0, 5),
    intimacy: bond.intimacy,
    userProfileConfidence: profile.confidence,
  };
}

export function buildCompanionshipCarePolicyForCharacter(params: {
  character: AICharacter;
  chat?: GroupChat;
  messages?: Message[];
  phase?: CompanionshipPhase;
  now?: number;
}): CarePolicy {
  const now = params.now || Date.now();
  const messages = params.messages || [];
  const character = {
    ...params.character,
    personality: params.character.personality || { openness: 50, extroversion: 50, agreeableness: 50, neuroticism: 50, humor: 50, creativity: 50, assertiveness: 50, empathy: 50 },
    memory: params.character.memory || {
      shortTermSummary: '',
      longTerm: [],
      secrets: [],
      obsessions: [],
      tabooTopics: [],
      userMemories: [],
    },
  } as AICharacter;
  const profileChat = params.chat || ({ runtimeEventsV2: [] } as unknown as GroupChat);
  const userProfile = buildUserProfileProjection(profileChat, character, messages, now);
  const ledger = params.chat ? getCharacterToUserLedger(params.chat, character.id) : null;
  const intimacy = params.chat
    ? adjustIntimacyProjection({
      base: projectIntimacy(ledger),
      sharedAnchors: buildUserSharedAnchors(character, now, params.chat),
      promiseConsequences: buildPromiseIntimacyConsequences(params.chat, character.id, now),
    })
    : {
      attraction: 0,
      intimacy: 0,
      attachment: 0,
      longing: 0,
      exclusivity: 0,
      security: 50,
    };
  const phase = params.phase || (params.chat ? resolveCompanionshipPhaseEvent(params.chat, character.id)?.phase || inferPhase(intimacy, ledger) : null) || 'curious';
  const preferredStyle = inferPreferredStyle(character, intimacy);
  const attachmentProfile = buildUserAttachmentProfile({ chat: params.chat, characterId: character.id, messages, profile: userProfile, intimacy, now });
  return applyGlobalCompanionshipSettingsToCarePolicy(applyAttachmentToCarePolicy(buildCarePolicy(phase, preferredStyle, userProfile), attachmentProfile), character);
}

export function shouldBlockUserProactiveContactByCompanionshipPolicy(params: {
  character: AICharacter | null | undefined;
  eventKind: 'check_in' | 'react_to_moment' | 'social_outing' | 'status_update';
  reasonType?: string | null;
  chat?: GroupChat;
  messages?: Message[];
  attentionScore?: number;
  enforceTemporalPolicy?: boolean;
  now?: number;
}): { blocked: boolean; reason?: string; carePolicy?: CarePolicy } {
  if (!params.character) return { blocked: false };
  const now = params.now || Date.now();
  const carePolicy = buildCompanionshipCarePolicyForCharacter({
    character: params.character,
    chat: params.chat,
    messages: params.messages,
    now,
  });
  if (carePolicy.boundaryReasons.includes('user prefers low proactive contact')) {
    return {
      blocked: true,
      reason: 'user prefers low proactive contact',
      carePolicy,
    };
  }
  const reasonType = params.reasonType || '';
  if (carePolicy.boundaryReasons.includes('user rejects greeting rituals') && params.eventKind === 'check_in') {
    if (reasonType === 'world_attention_private_message'
      || reasonType === 'world_attention_followup'
      || reasonType === 'world_attention_followup_question'
      || reasonType === 'attention_check_in') {
      return {
        blocked: true,
        reason: 'user rejects greeting rituals',
        carePolicy,
      };
    }
  }
  const isCalendarReminder = params.eventKind === 'status_update' && reasonType === 'world_attention_calendar_reminder';
  const isExplicitCompanionshipDueFollowup = params.eventKind === 'check_in'
    && (reasonType === 'companionship_pending_care_due' || reasonType === 'companionship_pending_promise_due');
  const isImmediateUserPromptedFollowup = reasonType === 'world_attention_private_message'
    || reasonType === 'world_attention_followup'
    || reasonType === 'world_attention_followup_question'
    || reasonType === 'world_attention_invite_activity'
    || reasonType === 'attention_check_in'
    || reasonType === 'attention_followup';
  if (!isImmediateUserPromptedFollowup && !isCalendarReminder) {
    const cooldownMs = getCompanionshipCooldownMinutes(params.eventKind) * 60_000;
    const lastActionAt = latestCompanionshipActionAt(params.chat, params.character.id, params.eventKind);
    if (cooldownMs > 0 && lastActionAt > 0 && now - lastActionAt < cooldownMs) {
      return {
        blocked: true,
        reason: `companionship ${params.eventKind} cooldown`,
        carePolicy,
      };
    }
  }
  if (!isCalendarReminder && !isImmediateUserPromptedFollowup && carePolicy.boundaryReasons.includes('global setting disables proactive companionship')) {
    return {
      blocked: true,
      reason: 'global setting disables proactive companionship',
      carePolicy,
    };
  }
  if (!isCalendarReminder && !isImmediateUserPromptedFollowup && carePolicy.boundaryReasons.includes('character setting disables proactive companionship')) {
    return {
      blocked: true,
      reason: 'character setting disables proactive companionship',
      carePolicy,
    };
  }
  if (!isCalendarReminder && !isExplicitCompanionshipDueFollowup && !isImmediateUserPromptedFollowup && carePolicy.dailyInitiationBudget <= 0) {
    return {
      blocked: true,
      reason: 'companionship proactive budget is zero for current phase',
      carePolicy,
    };
  }
  if (params.enforceTemporalPolicy !== false && !isCalendarReminder && isWithinCarePolicyQuietHours(now, carePolicy.quietHours)) {
    return {
      blocked: true,
      reason: 'companionship quiet hours',
      carePolicy,
    };
  }
  if (!isImmediateUserPromptedFollowup && typeof params.attentionScore === 'number') {
    const requiredScore = carePolicy.triggerSensitivity / 100;
    const reminderRelaxation = params.eventKind === 'status_update' ? 0.16 : 0;
    if (params.attentionScore < Math.max(0.35, requiredScore - reminderRelaxation)) {
      return {
        blocked: true,
        reason: 'companionship trigger sensitivity not met',
        carePolicy,
      };
    }
  }
  return { blocked: false, carePolicy };
}
