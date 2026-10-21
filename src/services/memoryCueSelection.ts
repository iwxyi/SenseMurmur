import type { MemoryItem } from './memoryTypes';
import type { MemoryVisibleRecallMode } from '../types/settings';
import { formatMemoryPerspectiveText, resolveMemoryDisclosureMetadata } from './memoryDisclosure';

export type MemoryCueMode = 'implicit_only' | 'light_reference' | 'explicit_reference' | 'corrective';

export interface ConstrainedMemoryCue {
  id: string;
  mode: MemoryCueMode;
  text: string;
  rule: string;
  score: number;
  source: MemoryItem;
}

export interface MemoryCueSelectionContext {
  cueText?: string;
  isPublicChannel?: boolean;
  maxCues?: number;
  recentMemoryUseIds?: string[];
  visibleRecallMode?: MemoryVisibleRecallMode;
  targetActorIds?: string[];
  explicitRecallRequested?: boolean;
}

const SINGLE_CJK_SIGNAL_CHARS = new Set(['甜', '腻', '糖', '猫', '辣', '雨', '热', '冷', '茶', '困']);

function normalize(text: string | undefined | null) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string | undefined) {
  const value = normalize(text).toLowerCase();
  const tokens = new Set<string>();
  for (const word of value.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2,4}/g) || []) tokens.add(word);
  const cjk = value.replace(/[^\u4e00-\u9fff]/g, '');
  for (const char of cjk) {
    if (SINGLE_CJK_SIGNAL_CHARS.has(char)) tokens.add(char);
  }
  for (let index = 0; index < Math.min(cjk.length - 1, 24); index += 1) tokens.add(cjk.slice(index, index + 2));
  return [...tokens].filter((item) => item.length >= 2 || SINGLE_CJK_SIGNAL_CHARS.has(item));
}

function memoryText(item: MemoryItem) {
  return normalize([
    item.summary,
    item.text,
    item.evidenceText,
    item.kind,
    item.scope,
    item.sourceTag,
    ...(item.semanticTags || []),
    ...(item.associations || []),
  ].filter(Boolean).join('\n'));
}

function lexicalRelevance(item: MemoryItem, cueText?: string) {
  const tokens = tokenize(cueText);
  if (!tokens.length) return 0;
  const haystack = memoryText(item).toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 4 ? 0.22 : 0.12;
  }
  return Math.min(1, score);
}

function hasDirectSubjectMatch(item: MemoryItem, cueText?: string) {
  const text = normalize(cueText);
  if (!text) return false;
  return (item.subjectIds || []).some((id) => id && text.includes(id));
}

function hasTargetSubjectMatch(item: MemoryItem, targetActorIds?: string[]) {
  if (!targetActorIds?.length) return false;
  const targets = new Set(targetActorIds.filter(Boolean));
  return (item.subjectIds || []).some((id) => targets.has(id));
}

function inferPrivacyRisk(item: MemoryItem) {
  return resolveMemoryDisclosureMetadata(item).privacyRisk;
}

export function isContradictedOrEphemeral(item: MemoryItem) {
  const { validity } = resolveMemoryDisclosureMetadata(item);
  if (validity === 'contradicted' || validity === 'stale') return true;
  if (item.sourceType === 'joke' || item.sourceType === 'test' || item.sourceType === 'temporary') return true;
  return false;
}

function shouldNeverSurface(item: MemoryItem) {
  return resolveMemoryDisclosureMetadata(item).visibility === 'never_surface';
}

function isThirdPartyOwnership(item: MemoryItem) {
  return resolveMemoryDisclosureMetadata(item).subjectOwner === 'third_party';
}

function baseScore(item: MemoryItem, context: MemoryCueSelectionContext) {
  const relevance = lexicalRelevance(item, context.cueText);
  const recency = Math.max(0, Math.min(1, item.recency || 0));
  const confidence = Math.max(0, Math.min(1, item.confidence || 0));
  const salience = Math.max(0, Math.min(1, item.salience || 0));
  const privacyRisk = inferPrivacyRisk(item);
  const cooldown = context.recentMemoryUseIds?.includes(item.id) ? 0.12 : 0;
  const contradiction = isContradictedOrEphemeral(item) ? 0.25 : 0;
  const directSubject = (hasDirectSubjectMatch(item, context.cueText) || hasTargetSubjectMatch(item, context.targetActorIds)) ? 0.18 : 0;
  return Number((
    relevance * 0.48
    + salience * 0.2
    + confidence * 0.16
    + recency * 0.1
    + directSubject
    - privacyRisk * 0.22
    - cooldown
    - contradiction
  ).toFixed(3));
}

function cueMode(item: MemoryItem, context: MemoryCueSelectionContext, score: number): MemoryCueMode | null {
  const privacyRisk = inferPrivacyRisk(item);
  const explicitAsk = context.explicitRecallRequested === true;
  const recentUse = context.recentMemoryUseIds?.includes(item.id);
  const relevance = lexicalRelevance(item, context.cueText);
  const directSubject = hasDirectSubjectMatch(item, context.cueText) || hasTargetSubjectMatch(item, context.targetActorIds);
  const visibleRecallMode = context.visibleRecallMode || 'balanced';
  if (shouldNeverSurface(item)) return null;
  if (score < 0.22) return null;
  if (relevance < 0.08 && !directSubject && !explicitAsk) return null;
  if (isThirdPartyOwnership(item) || isContradictedOrEphemeral(item)) {
    return explicitAsk ? 'corrective' : null;
  }
  if (context.isPublicChannel && privacyRisk >= 0.3) return 'implicit_only';
  if (visibleRecallMode === 'implicit') return 'implicit_only';
  if (recentUse || privacyRisk >= 0.35) return 'implicit_only';
  if (visibleRecallMode === 'direct') {
    if (score >= 0.5) return 'explicit_reference';
    if (score >= 0.34) return 'light_reference';
  }
  if (explicitAsk && score >= 0.48) return 'explicit_reference';
  if (score >= 0.42) return 'light_reference';
  return 'implicit_only';
}

function cueRule(mode: MemoryCueMode) {
  if (mode === 'implicit_only') return 'Private influence only: use this to shape tone, options, or restraint. Do not say "you previously said", "last time", or "I remember".';
  if (mode === 'light_reference') return 'A light visible callback is allowed at most once. Keep it casual and do not overrule the current user intent.';
  if (mode === 'explicit_reference') return 'Explicit reference is allowed because the user directly asked or the task needs it. Keep it short and factual.';
  return 'Use only to correct uncertainty or ownership. Do not turn third-party, joke, test, or contradicted facts into stable user traits.';
}

function cueText(item: MemoryItem, mode: MemoryCueMode, context: MemoryCueSelectionContext) {
  if (context.isPublicChannel && mode === 'implicit_only' && inferPrivacyRisk(item) >= 0.3) {
    const target = item.scope === 'relationship' ? 'the current relationship' : 'the current person';
    return `Private continuity about ${target} exists; use only as unspoken caution, familiarity, or bias.`;
  }
  const source = normalize(formatMemoryPerspectiveText(item))
    .replace(/\bstatus_shift\b/g, 'state shift');
  if (mode === 'implicit_only') return source.slice(0, 120);
  if (mode === 'corrective') return source.slice(0, 140);
  return source.slice(0, 160);
}

export function selectConstrainedMemoryCues(items: MemoryItem[], context: MemoryCueSelectionContext = {}): ConstrainedMemoryCue[] {
  const maxCues = Math.max(0, Math.min(3, context.maxCues ?? 3));
  if (!maxCues) return [];
  return items
    .map((item) => {
      const score = baseScore(item, context);
      const mode = cueMode(item, context, score);
      if (!mode) return null;
      return {
        id: item.id,
        mode,
        text: cueText(item, mode, context),
        rule: cueRule(mode),
        score,
        source: item,
      } satisfies ConstrainedMemoryCue;
    })
    .filter((item): item is ConstrainedMemoryCue => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxCues);
}
