import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { CompanionshipAddressingEventPayload, CompanionshipAttachmentProfileEventPayload, CompanionshipIntimateConflictEventPayload, CompanionshipPromiseEventPayload, CompanionshipRelationshipAssessmentEventPayload, CompanionshipSharedAnchorEventPayload, CompanionshipSharedPhraseEventPayload, CompanionshipSharedSecretEventPayload, CompanionshipStyle, IntimateConflictKind, PendingPromise, SharedMemoryAnchor, SharedPhrase, SharedSecret, UserAttachmentProfile, UserProfileMemoryEventItem, UserProfileMemoryKind } from '../types/companionship';
import type { Message } from '../types/message';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import type { APIConfig } from '../types/settings';
import { generateJsonResponse } from './aiClient';
import {
  buildCompanionshipCareTopicEventsFromDecision,
  readActiveCompanionshipCareTopicsFromEvents,
  type CompanionshipCareTopicDecision,
} from './directCompanionshipCare';
import {
  buildCompanionshipPhaseEventFromDecision,
  type CompanionshipPhaseDecision,
} from './directCompanionshipPhase';
import {
  createUserProfileMemoryEvent,
} from './directUserProfileMemory';
import { reportRecoverableWarning } from './diagnostics';

const USER_ACTOR_ID = 'user';
const MEMORY_KINDS: UserProfileMemoryKind[] = [
  'display_name',
  'address_preference',
  'schedule_hint',
  'pressure_source',
  'preference',
  'dislike',
  'boundary',
  'important_date',
  'recent_plan',
  'emotional_pattern',
];
const PHASES: CompanionshipPhaseDecision['phase'][] = ['stranger', 'curious', 'fond', 'ambiguous', 'confessing', 'confirmed', 'passionate', 'deep', 'cooling', 'crisis', 'reconciling'];
const STYLES: CompanionshipStyle[] = ['romantic', 'ambiguous', 'friend', 'family', 'mentor', 'custom'];
const SHARED_PHRASE_KINDS: SharedPhrase['kind'][] = ['pet_name', 'inside_joke', 'promise_line', 'comfort_line', 'confession_line', 'secret_code', 'other'];
const SHARED_PHRASE_VISIBILITIES: SharedPhrase['visibility'][] = ['private', 'between_actors', 'public_hint'];
const SHARED_ANCHOR_KINDS: SharedMemoryAnchor['kind'][] = ['first_time', 'confession', 'conflict', 'repair', 'inside_joke', 'shared_secret', 'promise', 'milestone'];
const SHARED_SECRET_CONSEQUENCES: NonNullable<SharedSecret['consequenceKind']>[] = ['none', 'misunderstanding', 'accidental_leak', 'intentional_breach', 'protective_confession', 'voluntary_confession'];
const INTIMATE_CONFLICT_KINDS: IntimateConflictKind[] = ['cold_war', 'silent_treatment', 'testing', 'accusation', 'withdrawal', 'vulnerability_burst', 'repair_attempt', 'reconciliation'];
const ATTACHMENT_STYLES: UserAttachmentProfile['inferredStyle'][] = ['secure', 'anxious', 'avoidant', 'disorganized'];
const PROMISE_KINDS: PendingPromise['kind'][] = ['shared_activity', 'user_followup', 'emotional_commitment', 'boundary_agreement', 'repair_agreement', 'ritual', 'other'];

function compactText(text: string | undefined | null, max = 140) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function stableEventSeed(parts: Array<string | number | undefined>) {
  const joined = parts.filter((item) => item !== undefined && item !== null && String(item).length > 0).join('|');
  let hash = 0;
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 31 + joined.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function cleanJsonCandidate(raw: string) {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const object = text.match(/\{[\s\S]*\}/);
  return object?.[0] || text;
}

function normalizeConfidence(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function isDirectUserMessage(chat: GroupChat, message: Message) {
  return chat.type === 'direct' && !message.isDeleted && (message.senderId === USER_ACTOR_ID || message.type === 'user' || message.type === 'god');
}

function isPhase(value: unknown): value is CompanionshipPhaseDecision['phase'] {
  return typeof value === 'string' && PHASES.includes(value as CompanionshipPhaseDecision['phase']);
}

function isStyle(value: unknown): value is CompanionshipStyle {
  return typeof value === 'string' && STYLES.includes(value as CompanionshipStyle);
}

function isCareAction(value: unknown): value is CompanionshipCareTopicDecision['action'] {
  return value === 'opened' || value === 'closed' || value === 'blocked';
}

function isUrgency(value: unknown): value is CompanionshipCareTopicDecision['urgency'] {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isMemoryKind(value: unknown): value is UserProfileMemoryKind {
  return typeof value === 'string' && MEMORY_KINDS.includes(value as UserProfileMemoryKind);
}

function isSharedPhraseKind(value: unknown): value is SharedPhrase['kind'] {
  return typeof value === 'string' && SHARED_PHRASE_KINDS.includes(value as SharedPhrase['kind']);
}

function isSharedPhraseVisibility(value: unknown): value is SharedPhrase['visibility'] {
  return typeof value === 'string' && SHARED_PHRASE_VISIBILITIES.includes(value as SharedPhrase['visibility']);
}

function isSharedAnchorKind(value: unknown): value is SharedMemoryAnchor['kind'] {
  return typeof value === 'string' && SHARED_ANCHOR_KINDS.includes(value as SharedMemoryAnchor['kind']);
}

function isSharedSecretConsequence(value: unknown): value is NonNullable<SharedSecret['consequenceKind']> {
  return typeof value === 'string' && SHARED_SECRET_CONSEQUENCES.includes(value as NonNullable<SharedSecret['consequenceKind']>);
}

function isIntimateConflictKind(value: unknown): value is IntimateConflictKind {
  return typeof value === 'string' && INTIMATE_CONFLICT_KINDS.includes(value as IntimateConflictKind);
}

function isAttachmentStyle(value: unknown): value is UserAttachmentProfile['inferredStyle'] {
  return typeof value === 'string' && ATTACHMENT_STYLES.includes(value as UserAttachmentProfile['inferredStyle']);
}

function isPromiseKind(value: unknown): value is PendingPromise['kind'] {
  return typeof value === 'string' && PROMISE_KINDS.includes(value as PendingPromise['kind']);
}

function buildRecentTranscript(messages: Message[]) {
  return messages
    .filter((item) => !item.isDeleted && item.type !== 'system' && item.type !== 'event')
    .slice(-8)
    .map((item) => `${item.senderName || item.senderId}: ${compactText(item.content, 160)}`)
    .join('\n');
}

function normalizePhase(raw: unknown, userContent: string): CompanionshipPhaseDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.shouldCreate !== true || !isPhase(value.phase)) return null;
  const confidence = normalizeConfidence(value.confidence);
  if (confidence < 0.7) return null;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120)).slice(0, 3)
    : [];
  return {
    phase: value.phase,
    style: isStyle(value.style) ? value.style : undefined,
    reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断用户明确表达了关系阶段变化。', 160),
    confidence,
    evidence: evidence.length ? evidence : [compactText(userContent, 120)],
    decisionSource: 'model',
  };
}

function normalizeCare(raw: unknown, userContent: string, createdAt: number): CompanionshipCareTopicDecision[] {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return source
    .map((item): CompanionshipCareTopicDecision | null => {
      if (!item || typeof item !== 'object') return null;
      const value = item as Record<string, unknown>;
      if (value.shouldCreate !== true || !isCareAction(value.action)) return null;
      const confidence = normalizeConfidence(value.confidence);
      if (confidence < 0.68) return null;
      const topicText = compactText(typeof value.topicText === 'string' ? value.topicText : userContent, 140);
      if (!topicText) return null;
      const dueInHours = typeof value.dueInHours === 'number' && Number.isFinite(value.dueInHours)
        ? Math.max(1, Math.min(24 * 30, value.dueInHours))
        : null;
      return {
        action: value.action,
        topicText,
        topicId: typeof value.existingTopicId === 'string' && value.existingTopicId.trim() ? value.existingTopicId.trim() : undefined,
        urgency: isUrgency(value.urgency) ? value.urgency : 'low',
        reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断用户消息形成了关心事项事件。', 160),
        evidence: compactText(typeof value.evidence === 'string' ? value.evidence : userContent, 160),
        confidence,
        dueAt: value.action === 'opened' && dueInHours ? createdAt + dueInHours * 60 * 60_000 : undefined,
        decisionSource: 'model',
      };
    })
    .filter((item): item is CompanionshipCareTopicDecision => Boolean(item))
    .slice(0, 3);
}

function normalizeProfileItems(raw: unknown, userContent: string): UserProfileMemoryEventItem[] {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!value || value.shouldCreate !== true || !Array.isArray(value.items)) return [];
  return value.items
    .map((item): UserProfileMemoryEventItem | null => {
      if (!item || typeof item !== 'object') return null;
      const entry = item as Record<string, unknown>;
      if (!isMemoryKind(entry.kind)) return null;
      const confidence = normalizeConfidence(entry.confidence);
      if (confidence < 0.7) return null;
      const text = compactText(typeof entry.text === 'string' ? entry.text : '', 140);
      if (!text) return null;
      return {
        kind: entry.kind,
        text,
        evidence: compactText(typeof entry.evidence === 'string' ? entry.evidence : userContent, 140),
        confidence,
        sensitive: entry.sensitive === true,
      };
    })
    .filter((item): item is UserProfileMemoryEventItem => Boolean(item))
    .slice(0, 4);
}

type SharedPhraseDecision = {
  action: 'upsert' | 'reused' | 'suppressed';
  text: string;
  kind: SharedPhrase['kind'];
  visibility: SharedPhrase['visibility'];
  firstSaidBy?: string;
  reason: string;
  evidence: string;
  emotionalWeight: number;
  reuseCount: number;
  confidence: number;
  decisionSource: 'model' | 'local_fallback';
};

type SharedAnchorDecision = {
  kind: SharedMemoryAnchor['kind'];
  title: string;
  text: string;
  salience: number;
  reason: string;
  evidence: string;
  confidence: number;
  decisionSource: 'model';
};

type SharedSecretDecision = {
  privateText: string;
  publicMask: string;
  consequenceKind: NonNullable<SharedSecret['consequenceKind']>;
  emotionalWeight: number;
  reason: string;
  evidence: string;
  confidence: number;
  decisionSource: 'model';
};

type IntimateConflictDecision = {
  action: CompanionshipIntimateConflictEventPayload['action'];
  kind: IntimateConflictKind;
  severity: number;
  repairReadiness: number;
  summary: string;
  evidence: string[];
  confidence: number;
  decisionSource: 'model' | 'local_fallback';
};

type AttachmentProfileDecision = {
  inferredStyle: UserAttachmentProfile['inferredStyle'];
  confidence: number;
  evidence: string[];
  adaptations: string[];
  reason: string;
  decisionSource: 'model';
};

type AddressingDecision = {
  action: Extract<CompanionshipAddressingEventPayload['action'], 'set_current' | 'set_private' | 'set_public' | 'forbid' | 'unforbid' | 'revoke'>;
  currentAddress?: string;
  privateAddress?: string;
  publicAddress?: string;
  forbiddenAddresses?: string[];
  reason: string;
  evidence: string;
  confidence: number;
  decisionSource: 'model';
};

type PromiseDecision = {
  action: CompanionshipPromiseEventPayload['action'];
  promiseText: string;
  promiseKind: PendingPromise['kind'];
  relationshipEffects?: CompanionshipPromiseEventPayload['relationshipEffects'];
  dueAt?: number;
  reason: string;
  evidence: string;
  confidence: number;
  decisionSource: 'model';
};

type RelationshipAssessmentDecision = {
  delta: CompanionshipRelationshipAssessmentEventPayload['delta'];
  labels: string[];
  stance: string;
  reason: string;
  evidence: string[];
  confidence: number;
};

function cleanAddressValue(value: unknown) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[“”"']/g, '').replace(/\s+/g, '').trim();
  if (!normalized || normalized.length > 12) return '';
  if (/(用户|我|自己|你自己|随便|不知道|都行)/.test(normalized)) return '';
  return normalized;
}

function cleanAddressList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(cleanAddressValue).filter(Boolean))).slice(0, 8);
}

function normalizeSharedPhraseDecisions(raw: unknown, userContent: string): SharedPhraseDecision[] {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return source
    .map((item): SharedPhraseDecision | null => {
      if (!item || typeof item !== 'object') return null;
      const value = item as Record<string, unknown>;
      if (value.shouldCreate !== true) return null;
      const action = value.action;
      if (action !== 'upsert' && action !== 'reused' && action !== 'suppressed') return null;
      const confidence = normalizeConfidence(value.confidence);
      if (confidence < 0.72) return null;
      const text = compactText(typeof value.text === 'string' ? value.text : '', 80);
      if (!text) return null;
      return {
        action,
        text,
        kind: isSharedPhraseKind(value.kind) ? value.kind : 'other',
        visibility: isSharedPhraseVisibility(value.visibility) ? value.visibility : 'between_actors',
        firstSaidBy: typeof value.firstSaidBy === 'string' && value.firstSaidBy.trim() ? value.firstSaidBy.trim() : undefined,
        reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断用户消息形成了共同话语事件。', 160),
        evidence: compactText(typeof value.evidence === 'string' ? value.evidence : userContent, 160),
        emotionalWeight: Math.max(0, Math.min(100, Math.round(typeof value.emotionalWeight === 'number' && Number.isFinite(value.emotionalWeight) ? value.emotionalWeight : 64))),
        reuseCount: Math.max(1, Math.min(50, Math.round(typeof value.reuseCount === 'number' && Number.isFinite(value.reuseCount) ? value.reuseCount : 1))),
        confidence,
        decisionSource: 'model',
      };
    })
    .filter((item): item is SharedPhraseDecision => Boolean(item))
    .slice(0, 3);
}

function normalizeSharedAnchorDecisions(raw: unknown, userContent: string): SharedAnchorDecision[] {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return source
    .map((item): SharedAnchorDecision | null => {
      if (!item || typeof item !== 'object') return null;
      const value = item as Record<string, unknown>;
      if (value.shouldCreate !== true || !isSharedAnchorKind(value.kind)) return null;
      const confidence = normalizeConfidence(value.confidence);
      if (confidence < 0.76) return null;
      const title = compactText(typeof value.title === 'string' ? value.title : '', 60);
      const text = compactText(typeof value.text === 'string' ? value.text : '', 180);
      if (!title || !text) return null;
      const salience = typeof value.salience === 'number' && Number.isFinite(value.salience)
        ? Math.max(0, Math.min(100, Math.round(value.salience)))
        : value.kind === 'milestone' || value.kind === 'confession' || value.kind === 'shared_secret' ? 78 : 64;
      return {
        kind: value.kind,
        title,
        text,
        salience,
        reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断用户明确标记了两人共同记忆锚点。', 160),
        evidence: compactText(typeof value.evidence === 'string' ? value.evidence : userContent, 160),
        confidence,
        decisionSource: 'model',
      };
    })
    .filter((item): item is SharedAnchorDecision => Boolean(item))
    .slice(0, 3);
}

function normalizeSharedSecretDecisions(raw: unknown, userContent: string): SharedSecretDecision[] {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return source
    .map((item): SharedSecretDecision | null => {
      if (!item || typeof item !== 'object') return null;
      const value = item as Record<string, unknown>;
      if (value.shouldCreate !== true) return null;
      const confidence = normalizeConfidence(value.confidence);
      if (confidence < 0.78) return null;
      const privateText = compactText(typeof value.privateText === 'string' ? value.privateText : '', 180);
      const publicMask = compactText(typeof value.publicMask === 'string' ? value.publicMask : '', 100);
      if (!privateText || !publicMask) return null;
      return {
        privateText,
        publicMask,
        consequenceKind: isSharedSecretConsequence(value.consequenceKind) ? value.consequenceKind : 'none',
        emotionalWeight: Math.max(0, Math.min(100, Math.round(typeof value.emotionalWeight === 'number' && Number.isFinite(value.emotionalWeight) ? value.emotionalWeight : 72))),
        reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断用户明确把这件事设为两人小秘密。', 160),
        evidence: compactText(typeof value.evidence === 'string' ? value.evidence : userContent, 160),
        confidence,
        decisionSource: 'model',
      };
    })
    .filter((item): item is SharedSecretDecision => Boolean(item))
    .slice(0, 2);
}

function createSharedAnchorRuntimeEvent(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  decision: SharedAnchorDecision;
}): RuntimeEventV2 {
  const createdAt = params.message.timestamp || Date.now();
  const anchorSeed = stableEventSeed([params.character.id, params.decision.kind, params.decision.title.replace(/\s+/g, ''), params.decision.text.replace(/\s+/g, '')]);
  const anchorId = `anchor-${params.character.id}-${anchorSeed}`;
  const payload: CompanionshipSharedAnchorEventPayload = {
    eventType: 'companionship_shared_anchor',
    characterId: params.character.id,
    userId: USER_ACTOR_ID,
    anchorId,
    action: 'upsert',
    kind: params.decision.kind,
    participantIds: [params.character.id, USER_ACTOR_ID],
    title: params.decision.title,
    text: params.decision.text,
    salience: params.decision.salience,
    confidence: params.decision.confidence,
    evidence: params.decision.evidence,
    sourceMessageIds: [params.message.id],
    reason: params.decision.reason,
    decisionSource: params.decision.decisionSource,
  };
  return {
    id: `evt-companionship-anchor-${params.message.id}-${anchorSeed}`,
    conversationId: params.chat.id,
    kind: 'artifact',
    createdAt,
    actorIds: [USER_ACTOR_ID],
    targetIds: [params.character.id],
    evidenceMessageIds: [params.message.id],
    summary: `${params.character.name} 记录了一个共同记忆锚点`,
    channelId: 'pair-private',
    eventClass: 'artifact',
    visibility: 'pair_private',
    visibleToIds: [USER_ACTOR_ID, params.character.id],
    payload: payload as unknown as Record<string, unknown>,
  };
}

function createSharedSecretRuntimeEvent(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  decision: SharedSecretDecision;
}): RuntimeEventV2 {
  const createdAt = params.message.timestamp || Date.now();
  const secretSeed = stableEventSeed([params.character.id, params.decision.privateText.replace(/\s+/g, '')]);
  const secretId = `secret-${params.character.id}-${secretSeed}`;
  const payload: CompanionshipSharedSecretEventPayload = {
    eventType: 'companionship_shared_secret',
    characterId: params.character.id,
    userId: USER_ACTOR_ID,
    secretId,
    action: 'recorded',
    consequenceKind: params.decision.consequenceKind,
    participantIds: [params.character.id, USER_ACTOR_ID],
    privateText: params.decision.privateText,
    publicMask: params.decision.publicMask,
    reason: params.decision.reason,
    evidence: params.decision.evidence,
    sourceMessageIds: [params.message.id],
    emotionalWeight: params.decision.emotionalWeight,
    confidence: params.decision.confidence,
    decisionSource: params.decision.decisionSource,
  };
  return {
    id: `evt-companionship-secret-${params.message.id}-${secretSeed}`,
    conversationId: params.chat.id,
    kind: 'artifact',
    createdAt,
    actorIds: [USER_ACTOR_ID],
    targetIds: [params.character.id],
    evidenceMessageIds: [params.message.id],
    summary: `${params.character.name} 记录了一个小秘密`,
    channelId: 'pair-private',
    eventClass: 'artifact',
    visibility: 'pair_private',
    visibleToIds: [USER_ACTOR_ID, params.character.id],
    payload: payload as unknown as Record<string, unknown>,
  };
}

function normalizeIntimateConflict(raw: unknown, userContent: string): IntimateConflictDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.shouldCreate !== true) return null;
  const action = value.action;
  if (action !== 'opened' && action !== 'updated' && action !== 'repair_attempted' && action !== 'resolved' && action !== 'reopened' && action !== 'dismissed') return null;
  if (!isIntimateConflictKind(value.kind)) return null;
  const confidence = normalizeConfidence(value.confidence);
  if (confidence < 0.72) return null;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120)).slice(0, 4)
    : [];
  const severity = typeof value.severity === 'number' && Number.isFinite(value.severity)
    ? Math.max(0, Math.min(100, Math.round(value.severity)))
    : action === 'resolved' ? 18 : action === 'repair_attempted' ? 36 : 56;
  const repairReadiness = typeof value.repairReadiness === 'number' && Number.isFinite(value.repairReadiness)
    ? Math.max(0, Math.min(100, Math.round(value.repairReadiness)))
    : action === 'resolved' ? 82 : action === 'repair_attempted' ? 58 : value.kind === 'reconciliation' ? 72 : 24;
  return {
    action,
    kind: value.kind,
    severity,
    repairReadiness,
    summary: compactText(typeof value.summary === 'string' ? value.summary : '模型判断用户消息形成了亲密冲突或修复事件。', 160),
    evidence: evidence.length ? evidence : [compactText(userContent, 120)],
    confidence,
    decisionSource: 'model',
  };
}

function normalizeAttachmentProfile(raw: unknown, userContent: string): AttachmentProfileDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.shouldCreate !== true || !isAttachmentStyle(value.inferredStyle)) return null;
  const confidence = normalizeConfidence(value.confidence);
  if (confidence < 0.74) return null;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120)).slice(0, 4)
    : [];
  const adaptations = Array.isArray(value.adaptations)
    ? value.adaptations.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120)).slice(0, 4)
    : [];
  return {
    inferredStyle: value.inferredStyle,
    confidence,
    evidence: evidence.length ? evidence : [compactText(userContent, 120)],
    adaptations,
    reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断这条消息提供了互动节奏适配线索。', 160),
    decisionSource: 'model',
  };
}

function normalizeAddressing(raw: unknown, userContent: string): AddressingDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.shouldCreate !== true) return null;
  const action = value.action;
  if (action !== 'set_current' && action !== 'set_private' && action !== 'set_public' && action !== 'forbid' && action !== 'unforbid' && action !== 'revoke') return null;
  const confidence = normalizeConfidence(value.confidence);
  if (confidence < 0.76) return null;
  const currentAddress = cleanAddressValue(value.currentAddress);
  const privateAddress = cleanAddressValue(value.privateAddress);
  const publicAddress = cleanAddressValue(value.publicAddress);
  const forbiddenAddresses = cleanAddressList(value.forbiddenAddresses);
  const hasAddressPayload = Boolean(currentAddress || privateAddress || publicAddress || forbiddenAddresses.length);
  if (action !== 'revoke' && !hasAddressPayload) return null;
  return {
    action,
    currentAddress: currentAddress || undefined,
    privateAddress: privateAddress || undefined,
    publicAddress: publicAddress || undefined,
    forbiddenAddresses: forbiddenAddresses.length ? forbiddenAddresses : undefined,
    reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断用户明确表达了称呼偏好。', 160),
    evidence: compactText(typeof value.evidence === 'string' ? value.evidence : userContent, 160),
    confidence,
    decisionSource: 'model',
  };
}

function normalizePromiseEffects(raw: unknown): CompanionshipPromiseEventPayload['relationshipEffects'] {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid promise relationshipEffects: expected an object');
  const value = raw as Record<string, unknown>;
  const effects: NonNullable<CompanionshipPromiseEventPayload['relationshipEffects']> = {};
  for (const outcome of ['fulfilled', 'missed'] as const) {
    const input = value[outcome];
    if (input == null) continue;
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error(`Invalid promise relationshipEffects.${outcome}: expected an object`);
    const effect: NonNullable<typeof effects.fulfilled> = {};
    for (const [axis, delta] of Object.entries(input)) {
      if (axis !== 'attraction' && axis !== 'intimacy' && axis !== 'attachment' && axis !== 'longing' && axis !== 'exclusivity' && axis !== 'security') {
        throw new Error(`Invalid promise relationshipEffects.${outcome} axis: ${axis}`);
      }
      if (typeof delta !== 'number' || !Number.isFinite(delta) || Math.abs(delta) > 100) {
        throw new Error(`Invalid promise relationshipEffects.${outcome}.${axis}: expected a finite delta between -100 and 100`);
      }
      effect[axis] = delta;
    }
    effects[outcome] = effect;
  }
  return effects;
}

function normalizePromiseDecisions(raw: unknown, userContent: string, createdAt: number): PromiseDecision[] {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return source
    .map((item): PromiseDecision | null => {
      if (!item || typeof item !== 'object') return null;
      const value = item as Record<string, unknown>;
      if (value.shouldCreate !== true) return null;
      const action = value.action;
      if (action !== 'opened' && action !== 'fulfilled' && action !== 'blocked' && action !== 'stale' && action !== 'revoked') return null;
      const confidence = normalizeConfidence(value.confidence);
      if (confidence < 0.72) return null;
      const promiseText = compactText(typeof value.promiseText === 'string' ? value.promiseText : '', 140);
      if (!promiseText) return null;
      const dueInHours = typeof value.dueInHours === 'number' && Number.isFinite(value.dueInHours)
        ? Math.max(1, Math.min(24 * 365, value.dueInHours))
        : null;
      return {
        action,
        promiseText,
        promiseKind: isPromiseKind(value.promiseKind) ? value.promiseKind : 'other',
        relationshipEffects: normalizePromiseEffects(value.relationshipEffects),
        dueAt: action === 'opened' && dueInHours ? createdAt + dueInHours * 60 * 60_000 : undefined,
        reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断用户消息形成了未完成约定事件。', 160),
        evidence: compactText(typeof value.evidence === 'string' ? value.evidence : userContent, 160),
        confidence,
        decisionSource: 'model',
      };
    })
    .filter((item): item is PromiseDecision => Boolean(item))
    .slice(0, 3);
}

function normalizeRelationshipAssessment(raw: unknown, userContent: string): RelationshipAssessmentDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.shouldCreate !== true) return null;
  const confidence = normalizeConfidence(value.confidence);
  if (confidence < 0.72) return null;
  const rawDelta = value.delta && typeof value.delta === 'object' ? value.delta as Record<string, unknown> : {};
  const delta = {
    warmth: Math.max(-8, Math.min(8, Number(rawDelta.warmth || 0))),
    competence: Math.max(-8, Math.min(8, Number(rawDelta.competence || 0))),
    trust: Math.max(-8, Math.min(8, Number(rawDelta.trust || 0))),
    threat: Math.max(-8, Math.min(8, Number(rawDelta.threat || 0))),
  };
  if (!Object.values(delta).some((item) => item !== 0)) return null;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, 120)).slice(0, 4)
    : [];
  return {
    delta,
    labels: Array.isArray(value.labels) ? value.labels.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 5) : [],
    stance: compactText(typeof value.stance === 'string' ? value.stance : '模型未提供额外关系立场。', 120),
    reason: compactText(typeof value.reason === 'string' ? value.reason : '模型判断这条消息改变了关系状态。', 160),
    evidence: evidence.length ? evidence : [compactText(userContent, 120)],
    confidence,
  };
}

function createRelationshipAssessmentRuntimeEvent(params: { chat: GroupChat; character: AICharacter; message: Message; decision: RelationshipAssessmentDecision }): RuntimeEventV2 {
  const payload: CompanionshipRelationshipAssessmentEventPayload = {
    eventType: 'companionship_relationship_assessment',
    characterId: params.character.id,
    userId: USER_ACTOR_ID,
    participantIds: [params.character.id, USER_ACTOR_ID],
    delta: params.decision.delta,
    labels: params.decision.labels,
    stance: params.decision.stance,
    evidence: params.decision.evidence,
    reason: params.decision.reason,
    confidence: params.decision.confidence,
    sourceMessageIds: [params.message.id],
    decisionSource: 'model',
  };
  return {
    id: `evt-companionship-relationship-${params.message.id}`,
    conversationId: params.chat.id,
    kind: 'relationship_delta',
    createdAt: params.message.timestamp || Date.now(),
    actorIds: [params.character.id],
    targetIds: [USER_ACTOR_ID],
    evidenceMessageIds: [params.message.id],
    summary: params.decision.reason,
    channelId: 'pair-private',
    eventClass: 'action',
    visibility: 'pair_private',
    visibleToIds: [USER_ACTOR_ID, params.character.id],
    payload: payload as unknown as Record<string, unknown>,
  };
}

function createSharedPhraseRuntimeEvent(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  decision: SharedPhraseDecision;
}): RuntimeEventV2 {
  const createdAt = params.message.timestamp || Date.now();
  const phraseSeed = stableEventSeed([params.character.id, params.decision.kind, params.decision.text.replace(/\s+/g, '')]);
  const phraseId = `phrase-${params.character.id}-${phraseSeed}`;
  const payload: CompanionshipSharedPhraseEventPayload = {
    eventType: 'companionship_shared_phrase',
    characterId: params.character.id,
    userId: USER_ACTOR_ID,
    phraseId,
    action: params.decision.action,
    text: params.decision.text,
    kind: params.decision.kind,
    participantIds: [params.character.id, USER_ACTOR_ID],
    visibility: params.decision.visibility,
    firstSaidBy: params.decision.firstSaidBy,
    reason: params.decision.reason,
    evidence: params.decision.evidence,
    sourceMessageIds: [params.message.id],
    emotionalWeight: params.decision.emotionalWeight,
    reuseCount: params.decision.reuseCount,
    confidence: params.decision.confidence,
    decisionSource: params.decision.decisionSource,
  };
  return {
    id: `evt_${createdAt}_${stableEventSeed([params.chat.id, payload.eventType, phraseId, payload.action, params.message.id])}`,
    conversationId: params.chat.id,
    kind: 'artifact',
    createdAt,
    actorIds: [USER_ACTOR_ID],
    targetIds: [params.character.id],
    evidenceMessageIds: [params.message.id],
    summary: params.decision.action === 'suppressed'
      ? `${params.character.name} 记录用户不想继续使用一句共同话语`
      : `${params.character.name} 记录了一句共同话语`,
    channelId: 'pair-private',
    eventClass: 'artifact',
    visibility: 'pair_private',
    visibleToIds: [USER_ACTOR_ID, params.character.id],
    payload: payload as unknown as Record<string, unknown>,
  };
}

function buildSharedPhraseEventsFromDecisions(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  decisions: SharedPhraseDecision[];
}) {
  return params.decisions.map((decision) => createSharedPhraseRuntimeEvent({ ...params, decision }));
}

function createIntimateConflictRuntimeEvent(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  decision: IntimateConflictDecision;
}): RuntimeEventV2 {
  const createdAt = params.message.timestamp || Date.now();
  const payload: CompanionshipIntimateConflictEventPayload = {
    eventType: 'companionship_intimate_conflict',
    characterId: params.character.id,
    userId: USER_ACTOR_ID,
    action: params.decision.action,
    kind: params.decision.kind,
    severity: params.decision.severity,
    repairReadiness: params.decision.repairReadiness,
    summary: params.decision.summary,
    evidence: params.decision.evidence,
    participantIds: [params.character.id, USER_ACTOR_ID],
    sourceMessageIds: [params.message.id],
    confidence: params.decision.confidence,
    decisionSource: params.decision.decisionSource,
  };
  return {
    id: `evt-companionship-conflict-${params.message.id}`,
    conversationId: params.chat.id,
    kind: 'artifact',
    createdAt,
    actorIds: [USER_ACTOR_ID],
    targetIds: [params.character.id],
    evidenceMessageIds: [params.message.id],
    summary: params.decision.summary,
    channelId: 'pair-private',
    eventClass: 'artifact',
    visibility: 'pair_private',
    visibleToIds: [USER_ACTOR_ID, params.character.id],
    payload: payload as unknown as Record<string, unknown>,
  };
}

function createAttachmentProfileRuntimeEvent(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  decision: AttachmentProfileDecision;
}): RuntimeEventV2 {
  const createdAt = params.message.timestamp || Date.now();
  const payload: CompanionshipAttachmentProfileEventPayload = {
    eventType: 'companionship_attachment_profile',
    characterId: params.character.id,
    userId: USER_ACTOR_ID,
    action: 'inferred',
    inferredStyle: params.decision.inferredStyle,
    confidence: params.decision.confidence,
    evidence: params.decision.evidence,
    sourceMessageIds: [params.message.id],
    adaptations: params.decision.adaptations,
    reason: params.decision.reason,
    decisionSource: params.decision.decisionSource,
  };
  return {
    id: `evt-companionship-attachment-${params.message.id}`,
    conversationId: params.chat.id,
    kind: 'artifact',
    createdAt,
    actorIds: [USER_ACTOR_ID],
    targetIds: [params.character.id],
    evidenceMessageIds: [params.message.id],
    summary: `${params.character.name} 更新了互动节奏适配线索`,
    channelId: 'pair-private',
    eventClass: 'artifact',
    visibility: 'pair_private',
    visibleToIds: [USER_ACTOR_ID, params.character.id],
    payload: payload as unknown as Record<string, unknown>,
  };
}

function createAddressingRuntimeEvent(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  decision: AddressingDecision;
}): RuntimeEventV2 {
  const createdAt = params.message.timestamp || Date.now();
  const payload: CompanionshipAddressingEventPayload = {
    eventType: 'companionship_addressing',
    characterId: params.character.id,
    userId: USER_ACTOR_ID,
    action: params.decision.action,
    currentAddress: params.decision.currentAddress,
    privateAddress: params.decision.privateAddress,
    publicAddress: params.decision.publicAddress,
    forbiddenAddresses: params.decision.forbiddenAddresses,
    reason: params.decision.reason,
    evidence: params.decision.evidence,
    sourceMessageIds: [params.message.id],
    initiatedBy: 'user',
    confidence: params.decision.confidence,
    decisionSource: params.decision.decisionSource,
  };
  return {
    id: `evt-companionship-addressing-${params.message.id}`,
    conversationId: params.chat.id,
    kind: 'artifact',
    createdAt,
    actorIds: [USER_ACTOR_ID],
    targetIds: [params.character.id],
    evidenceMessageIds: [params.message.id],
    summary: `${params.character.name} 更新了用户称呼偏好`,
    channelId: 'pair-private',
    eventClass: 'artifact',
    visibility: 'pair_private',
    visibleToIds: [USER_ACTOR_ID, params.character.id],
    payload: payload as unknown as Record<string, unknown>,
  };
}

function createPromiseRuntimeEvent(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  decision: PromiseDecision;
}): RuntimeEventV2 {
  const createdAt = params.message.timestamp || Date.now();
  const promiseSeed = stableEventSeed([params.character.id, params.decision.promiseKind, params.decision.promiseText.replace(/\s+/g, '')]);
  const promiseId = `promise-${params.character.id}-${promiseSeed}`;
  const payload: CompanionshipPromiseEventPayload = {
    eventType: 'companionship_promise',
    characterId: params.character.id,
    userId: USER_ACTOR_ID,
    promiseId,
    promiseText: params.decision.promiseText,
    action: params.decision.action,
    participantIds: [params.character.id, USER_ACTOR_ID],
    promiseKind: params.decision.promiseKind,
    relationshipEffects: params.decision.relationshipEffects,
    lifecycleEvidence: [params.decision.evidence, params.decision.reason].filter(Boolean),
    reason: params.decision.reason,
    evidence: params.decision.evidence,
    sourceMessageIds: [params.message.id],
    dueAt: params.decision.dueAt,
    confidence: params.decision.confidence,
    decisionSource: params.decision.decisionSource,
  };
  return {
    id: `evt-companionship-promise-${params.message.id}-${promiseSeed}`,
    conversationId: params.chat.id,
    kind: 'artifact',
    createdAt,
    actorIds: [USER_ACTOR_ID],
    targetIds: [params.character.id],
    evidenceMessageIds: [params.message.id],
    summary: params.decision.action === 'opened'
      ? `${params.character.name} 记录了一个未完成约定`
      : `${params.character.name} 更新了一个约定状态`,
    channelId: 'pair-private',
    eventClass: 'artifact',
    visibility: 'pair_private',
    visibleToIds: [USER_ACTOR_ID, params.character.id],
    payload: payload as unknown as Record<string, unknown>,
  };
}

async function runModelAssessment(params: {
  config: APIConfig;
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  recentMessages?: Message[];
}) {
  const activeTopics = readActiveCompanionshipCareTopicsFromEvents(params.chat, params.character.id, params.message.timestamp || Date.now());
  const systemPrompt = [
    '你是亲密陪伴 direct runtime 的合并评估器。',
    '任务：只评估用户这一条新消息对十个运行时模块的结构化影响：关系阶段、关心事项、用户画像记忆、正式称呼、未完成约定、共同记忆锚点、小秘密、共同话语、亲密冲突/修复、互动节奏适配。',
    '必须保守：玩笑、比喻、角色扮演台词、影视/游戏/别人经历、含糊猜测、临时口嗨，不要创建长期事件。',
    'phase 只在用户明确把自己和当前角色的关系推进、降级、修复或确认时创建。',
    '关系方向必须根据角色设定、最近对话、用户行为和角色回应共同判断，不要用单个词或单个动作代替关系判断。角色拒绝、角色自己设边界、用户尊重边界、用户在被拒后继续推进，分别是不同事件：不要把角色能清楚表达边界误判成对用户好感上升；也不要把任何成人亲密话题自动判成负面，只有结合上下文和回应才能判断。',
    '若用户只是提出亲密或性话题，而上下文没有明确的双方意愿、角色回应或关系变化证据，phase、sharedAnchors、intimateConflict、attachmentProfile 都应 shouldCreate=false；不要猜测“开始在意”“邀请”“确认关系”等阶段。若角色明确拒绝且用户继续推进，应依据互动历史判断是否形成 cooling/crisis 或边界记忆；若用户停止、道歉并尊重边界，才可在有充分证据时记录 repair 或 trust 恢复。',
    'careTopics 只在用户明确提到自己的计划、重要日期、健康/情绪压力、未完成约定，或明确关闭/拒绝已有关心事项时创建。',
    'userProfile 只记录适合未来自然照顾用户的事实、偏好、边界、日期、计划或稳定压力来源。',
    'addressing 只在用户明确要求当前角色如何称呼用户、私下怎么叫、公开怎么叫、不要再叫某个称呼、解除禁用或撤回称呼偏好时创建；不要从普通自我介绍或第三人称描述里猜。',
    'promises 只在用户和当前角色之间形成、完成、取消、落空或关闭一个明确约定时创建，例如一起做某事、等用户回来说结果、情感承诺、关系边界、修复约定、关系仪式。不要把普通计划或单方面待办都当成两人约定。',
    'promises 可选 relationshipEffects={fulfilled:{亲密轴:变化量},missed:{亲密轴:变化量}}，仅在有具体关系影响证据时提供；亲密轴为 attraction/intimacy/attachment/longing/exclusivity/security，变化量 -100 到 100，通常应很小。无依据时省略，不按 promiseKind 自动加减分。',
    'sharedAnchors 只在用户明确把某件事标记为当前角色和用户之间的重要共同经历时创建，例如第一次、确认心意、冲突/修复节点、共同梗、小秘密、约定、里程碑。不要把普通聊天摘要、普通计划或角色扮演剧情当共同锚点。',
    'sharedSecrets 只在用户明确说这是只属于用户和当前角色的小秘密、要求保密、只告诉当前角色，或明确更新/坦白/泄露这个小秘密时创建。必须同时给出私密原文 privateText 和可公开遮罩 publicMask；不要把普通隐私倾诉自动变成“小秘密”。',
    'sharedPhrases 只在用户明确创造、复用或拒绝一条“我们之间的话”时创建，例如专属称呼、暗号、约定原话、安慰语、心意话语、秘密暗号；不要把普通聊天句子当口头禅。',
    'intimateConflict 只在用户明确表达和当前角色之间的关系受伤、冷战、指责、退缩、修复尝试、和好或误判撤回时创建；不要把工作、剧情、游戏、别人经历或普通心情不好当成两人冲突。',
    'attachmentProfile 只在用户明确表达互动节奏偏好或稳定关系模式时创建，例如需要更多确认、需要空间、不希望追问、忽近忽远但希望对方稳住、或明确喜欢稳定互相回应。不要根据单句普通情绪猜测敏感标签。',
    'relationship 只在这一轮确实改变了角色对用户的关系判断时创建。delta 由模型直接给出四轴变化（warmth=亲和、trust=信任、competence=能力判断、threat=威胁/防备），每轴范围 -8 到 8；没有足够证据就 shouldCreate=false。不要因为消息存在、回复礼貌、角色完成任务或角色自己守住边界就自动增加亲和/信任。labels、stance 必须描述这轮关系语义，而不是把固定阈值翻译成标签。',
    '不要写可见回复内容。只输出 JSON，不要 markdown。',
    '输出结构：{"relationship":{"shouldCreate":boolean,"delta":{"warmth":number,"trust":number,"competence":number,"threat":number},"labels":["关系语义"],"stance":"这一轮的关系立场","confidence":number,"reason":"...","evidence":["..."]},"phase":{"shouldCreate":boolean,"phase":"confessing|confirmed|passionate|deep|cooling|crisis|reconciling|none","style":"romantic|ambiguous|friend|family|mentor|custom|null","confidence":number,"reason":"...","evidence":["..."]},"careTopics":[{"shouldCreate":boolean,"action":"opened|closed|blocked|none","existingTopicId":"可选","topicText":"...","urgency":"low|medium|high","dueInHours":number|null,"confidence":number,"reason":"...","evidence":"..."}],"userProfile":{"shouldCreate":boolean,"items":[{"kind":"display_name|address_preference|schedule_hint|pressure_source|preference|dislike|boundary|important_date|recent_plan|emotional_pattern","text":"第三人称可记忆事实","evidence":"原文证据","confidence":number,"sensitive":boolean}],"reason":"..."},"addressing":{"shouldCreate":boolean,"action":"set_current|set_private|set_public|forbid|unforbid|revoke|none","currentAddress":"可选","privateAddress":"可选","publicAddress":"可选","forbiddenAddresses":["可选"],"confidence":number,"reason":"...","evidence":"..."},"promises":[{"shouldCreate":boolean,"action":"opened|fulfilled|blocked|stale|revoked|none","promiseText":"约定内容","promiseKind":"shared_activity|user_followup|emotional_commitment|boundary_agreement|repair_agreement|ritual|other","dueInHours":number|null,"confidence":number,"reason":"...","evidence":"..."}],"sharedAnchors":[{"shouldCreate":boolean,"kind":"first_time|confession|conflict|repair|inside_joke|shared_secret|promise|milestone","title":"短标题","text":"共同经历内容","salience":number,"confidence":number,"reason":"...","evidence":"..."}],"sharedSecrets":[{"shouldCreate":boolean,"privateText":"只允许私域使用的秘密原文","publicMask":"公开场景可用的含糊遮罩","consequenceKind":"none|misunderstanding|accidental_leak|intentional_breach|protective_confession|voluntary_confession","emotionalWeight":number,"confidence":number,"reason":"...","evidence":"..."}],"sharedPhrases":[{"shouldCreate":boolean,"action":"upsert|reused|suppressed|none","text":"共同话语原文","kind":"pet_name|inside_joke|promise_line|comfort_line|confession_line|secret_code|other","visibility":"private|between_actors|public_hint","firstSaidBy":"user|character|mutual|null","emotionalWeight":number,"reuseCount":number,"confidence":number,"reason":"...","evidence":"..."}],"intimateConflict":{"shouldCreate":boolean,"action":"opened|updated|repair_attempted|resolved|reopened|dismissed|none","kind":"cold_war|silent_treatment|testing|accusation|withdrawal|vulnerability_burst|repair_attempt|reconciliation","severity":number,"repairReadiness":number,"summary":"...","confidence":number,"evidence":["..."]},"attachmentProfile":{"shouldCreate":boolean,"inferredStyle":"secure|anxious|avoidant|disorganized|none","confidence":number,"reason":"...","evidence":["..."],"adaptations":["..."]}}',
    'confidence 取 0-1；拿不准必须 shouldCreate=false 或 confidence 低于对应阈值。',
  ].join('\n');
  const payload = {
    chatName: params.chat.name,
    character: {
      id: params.character.id,
      name: params.character.name,
      background: params.character.background || '',
      speakingStyle: params.character.speakingStyle || '',
    },
    activeCareTopics: activeTopics.map((topic) => ({
      id: topic.id,
      text: topic.text,
      urgency: topic.urgency,
      evidence: topic.evidence || '',
    })),
    recentTranscript: buildRecentTranscript(params.recentMessages || []),
    userMessage: params.message.content,
  };
  const raw = await generateJsonResponse(params.config, systemPrompt, [{ role: 'user', content: JSON.stringify(payload) }], {
    aiUsage: { type: 'companionship_assessment', label: '陪伴关系评估', scope: 'chat', resourceId: params.chat.id },
  });
  const parsed = JSON.parse(cleanJsonCandidate(raw)) as Record<string, unknown>;
  return {
    relationship: normalizeRelationshipAssessment(parsed.relationship, params.message.content),
    phase: normalizePhase(parsed.phase, params.message.content),
    care: normalizeCare(parsed.careTopics, params.message.content, params.message.timestamp || Date.now()),
    profileItems: normalizeProfileItems(parsed.userProfile, params.message.content),
    addressing: normalizeAddressing(parsed.addressing, params.message.content),
    promises: normalizePromiseDecisions(parsed.promises, params.message.content, params.message.timestamp || Date.now()),
    sharedAnchors: normalizeSharedAnchorDecisions(parsed.sharedAnchors, params.message.content),
    sharedSecrets: normalizeSharedSecretDecisions(parsed.sharedSecrets, params.message.content),
    sharedPhrases: normalizeSharedPhraseDecisions(parsed.sharedPhrases, params.message.content),
    intimateConflict: normalizeIntimateConflict(parsed.intimateConflict, params.message.content),
    attachmentProfile: normalizeAttachmentProfile(parsed.attachmentProfile, params.message.content),
    activeTopics,
  };
}

export async function resolveDirectCompanionshipAssessmentEvents(params: {
  chat: GroupChat;
  character: AICharacter;
  message: Message;
  textApiConfig?: APIConfig | null;
  recentMessages?: Message[];
  now?: number;
}): Promise<RuntimeEventV2[]> {
  if (!isDirectUserMessage(params.chat, params.message)) return [];
  if (!params.textApiConfig) return [];
  try {
    const assessment = await runModelAssessment({
      config: params.textApiConfig,
      chat: params.chat,
      character: params.character,
      message: params.message,
      recentMessages: params.recentMessages,
    });
    return [
      assessment.relationship ? createRelationshipAssessmentRuntimeEvent({ ...params, decision: assessment.relationship }) : null,
      assessment.phase ? buildCompanionshipPhaseEventFromDecision({ ...params, decision: assessment.phase }) : null,
      ...assessment.care.flatMap((decision) => buildCompanionshipCareTopicEventsFromDecision({
        chat: params.chat,
        character: params.character,
        message: params.message,
        decision,
        activeTopics: assessment.activeTopics,
      })),
      assessment.profileItems.length ? createUserProfileMemoryEvent({
        chat: params.chat,
        character: params.character,
        message: params.message,
        items: assessment.profileItems,
        decisionSource: 'model',
        reason: 'combined direct runtime assessment extracted explicit user profile cues',
      }) : null,
      assessment.addressing ? createAddressingRuntimeEvent({
        chat: params.chat,
        character: params.character,
        message: params.message,
        decision: assessment.addressing,
      }) : null,
      ...assessment.promises.map((decision) => createPromiseRuntimeEvent({
        chat: params.chat,
        character: params.character,
        message: params.message,
        decision,
      })),
      ...assessment.sharedAnchors.map((decision) => createSharedAnchorRuntimeEvent({
        chat: params.chat,
        character: params.character,
        message: params.message,
        decision,
      })),
      ...assessment.sharedSecrets.map((decision) => createSharedSecretRuntimeEvent({
        chat: params.chat,
        character: params.character,
        message: params.message,
        decision,
      })),
      ...buildSharedPhraseEventsFromDecisions({
        chat: params.chat,
        character: params.character,
        message: params.message,
        decisions: assessment.sharedPhrases,
      }),
      assessment.intimateConflict ? createIntimateConflictRuntimeEvent({
        chat: params.chat,
        character: params.character,
        message: params.message,
        decision: assessment.intimateConflict,
      }) : null,
      assessment.attachmentProfile ? createAttachmentProfileRuntimeEvent({
        chat: params.chat,
        character: params.character,
        message: params.message,
        decision: assessment.attachmentProfile,
      }) : null,
    ].filter((event): event is RuntimeEventV2 => Boolean(event));
  } catch (error) {
    reportRecoverableWarning({
      location: 'companionship:direct-assessment-model',
      error,
      message: '亲密陪伴合并评估失败，已跳过本轮亲密陪伴运行态写入。',
      extra: {
        chatId: params.chat.id,
        characterId: params.character.id,
        messageId: params.message.id,
        messagePreview: compactText(params.message.content, 80),
      },
    });
    return [];
  }
}
