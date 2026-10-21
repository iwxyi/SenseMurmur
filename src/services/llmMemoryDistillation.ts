import type { AICharacter, CharacterCoreProfile } from '../types/character';
import { DEFAULT_CORE_PROFILE } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { APIConfig } from '../types/settings';
import { generateJsonResponse } from './aiClient';
import type { MemoryCandidate, MemoryItem } from './memoryTypes';
import {
  buildCharacterMemoryAnalysisPrompt,
  buildChatMemoryAnalysisPrompt,
  buildMemoryAnalysisEvidenceBlock,
  collectMemoryAnalysisEvidenceText,
  collectTrackedMemoryAnalysisSourceEventIds,
  LLM_MEMORY_ANALYSIS_ALLOWED_KINDS,
  LLM_MEMORY_ANALYSIS_ALLOWED_LAYERS,
  LLM_MEMORY_ANALYSIS_ALLOWED_SCOPES,
  LLM_MEMORY_ANALYSIS_ALLOWED_SOURCE_TAGS,
  LLM_MEMORY_ANALYSIS_LIMITS,
  LLM_MEMORY_ANALYSIS_MAX_SOURCE_ITEMS,
  LLM_MEMORY_ANALYSIS_MAX_OUTPUT_ITEMS,
  LLM_MEMORY_ANALYSIS_VERSION,
  parseLlmMemoryAnalysisResult,
  type LlmAnalyzedMemoryItem,
} from './memoryAnalysisStrategy';
import { isRuntimeEvidenceMemory } from './memoryPresentation';
import { getCurrentRetentionLimits } from './retentionLimits';

const SHARED_PHRASE_ANALYSIS_RULE = '\n\n如果证据形成了一句可复用的共同称呼、梗、约定、安慰语、表白语或暗号，请在对应 item 增加 sharedPhrase：{"text":"可复用原话","kind":"pet_name|inside_joke|promise_line|comfort_line|confession_line|secret_code|other","visibility":"private|between_actors|public_hint"}；否则省略。这个分类由模型完成，运行时不会根据正文关键词猜测。';

const LLM_CHARACTER_SELF_SOURCE_TAGS = new Set([
  'self_expression',
  'inner_life_repair',
  'inner_life_attention',
  'inner_life_face',
  'inner_life_repression',
  'core_profile',
  'background',
  'speaking_style',
  'expertise',
]);

function isEligibleItem(item: MemoryItem, ownerType: 'chat' | 'character') {
  const scopeAllowed = ownerType === 'character'
    ? LLM_MEMORY_ANALYSIS_ALLOWED_SCOPES.has(item.scope)
      || item.scope === 'character_self'
    : LLM_MEMORY_ANALYSIS_ALLOWED_SCOPES.has(item.scope);
  const kindAllowed = ownerType === 'character'
    ? LLM_MEMORY_ANALYSIS_ALLOWED_KINDS.has(item.kind)
      || item.kind === 'bias'
      || item.kind === 'status_shift'
      || item.kind === 'trait_evidence'
    : LLM_MEMORY_ANALYSIS_ALLOWED_KINDS.has(item.kind);
  const sourceTagAllowed = LLM_MEMORY_ANALYSIS_ALLOWED_SOURCE_TAGS.has(item.sourceTag || '')
    || (ownerType === 'character' && item.scope === 'character_self' && LLM_CHARACTER_SELF_SOURCE_TAGS.has(item.sourceTag || ''));
  return !item.archivedAt
    && !isRuntimeEvidenceMemory(item)
    && LLM_MEMORY_ANALYSIS_ALLOWED_LAYERS.has(item.layer)
    && scopeAllowed
    && kindAllowed
    && sourceTagAllowed;
}

function eligibleItems(items: MemoryItem[], ownerType: 'chat' | 'character') {
  return items.filter((item) => isEligibleItem(item, ownerType));
}

function latestLlmDistilledItem(items: MemoryItem[]) {
  return items
    .filter((item) => item.origin === 'distilled' && item.distillationVersion === LLM_MEMORY_ANALYSIS_VERSION)
    .sort((left, right) => (right.distilledAt || 0) - (left.distilledAt || 0))[0] || null;
}

function latestLlmDistilledAt(items: MemoryItem[]) {
  return latestLlmDistilledItem(items)?.distilledAt || 0;
}

function latestLlmDistilledEventIds(items: MemoryItem[]) {
  return new Set(latestLlmDistilledItem(items)?.sourceEventIds || []);
}

function buildSubjectKey(item: MemoryItem) {
  return (item.subjectIds || []).filter(Boolean).sort().join('::');
}

function countDistinctSubjects(items: MemoryItem[]) {
  return new Set(items.map(buildSubjectKey).filter(Boolean)).size;
}

function countDistinctEventEvidence(items: MemoryItem[]) {
  return new Set(items.flatMap((item) => item.sourceEventIds || []).filter(Boolean)).size;
}

function countNewItemsSince(items: MemoryItem[], latest: number) {
  if (!latest) return items.length;
  return items.filter((item) => item.updatedAt > latest).length;
}

function newItemsSince(items: MemoryItem[], latest: number) {
  if (!latest) return items;
  return items.filter((item) => item.updatedAt > latest);
}

function hasNovelEventEvidence(item: MemoryItem, seenEventIds: Set<string>) {
  return (item.sourceEventIds || []).some((id) => id && !seenEventIds.has(id));
}

function countNewEventEvidenceSince(items: MemoryItem[], seenEventIds: Set<string>) {
  return new Set(
    items
      .flatMap((item) => item.sourceEventIds || [])
      .filter((id): id is string => Boolean(id) && !seenEventIds.has(id))
  ).size;
}

function buildRecentSource(items: MemoryItem[], latest: number, seenEventIds: Set<string>, ownerType: 'chat' | 'character') {
  const source = newItemsSince(eligibleItems(items, ownerType), latest)
    .filter((item) => !seenEventIds.size || hasNovelEventEvidence(item, seenEventIds));
  return source.slice(-LLM_MEMORY_ANALYSIS_MAX_SOURCE_ITEMS);
}

function hasEnoughSourceDiversity(items: MemoryItem[], ownerType: 'chat' | 'character') {
  const minimum = LLM_MEMORY_ANALYSIS_LIMITS[ownerType].minNewSubjects;
  if (countDistinctSubjects(items) >= minimum) return true;
  // Self memories describe one character by design. Their diversity is the
  // number of independently evidenced experiences, not the number of people
  // mentioned in those experiences.
  return ownerType === 'character'
    && items.some((item) => item.scope === 'character_self')
    && countDistinctEventEvidence(items) >= minimum;
}

function hasEnoughSourceEvidence(items: MemoryItem[], ownerType: 'chat' | 'character') {
  return countDistinctEventEvidence(items) >= LLM_MEMORY_ANALYSIS_LIMITS[ownerType].minEventEvidence;
}

function hasEnoughSourceItems(items: MemoryItem[], ownerType: 'chat' | 'character') {
  return items.length >= LLM_MEMORY_ANALYSIS_LIMITS[ownerType].minItems;
}

function hasEnoughNewItems(items: MemoryItem[], latest: number, ownerType: 'chat' | 'character') {
  return countNewItemsSince(items, latest) >= LLM_MEMORY_ANALYSIS_LIMITS[ownerType].minNewItems;
}

function hasEnoughNewEventEvidence(items: MemoryItem[], seenEventIds: Set<string>, ownerType: 'chat' | 'character') {
  return countNewEventEvidenceSince(items, seenEventIds) >= LLM_MEMORY_ANALYSIS_LIMITS[ownerType].minNewEventEvidence;
}

function buildSourceTag(item: LlmAnalyzedMemoryItem) {
  return item.lens ? `llm_memory_${item.lens}` : 'llm_memory_distillation';
}

function buildCharacterAnalysisContext(character: AICharacter) {
  const personality = character.personality
    ? Object.entries(character.personality).map(([key, value]) => `${key}:${value}`).join(', ')
    : '未设置';
  const emotion = character.emotionalState
    ? Object.entries(character.emotionalState).map(([key, value]) => `${key}:${value}`).join(', ')
    : '未设置';
  const core = character.coreProfile
    ? [
        character.coreProfile.coreDesire ? `核心欲望：${character.coreProfile.coreDesire}` : '',
        character.coreProfile.coreFear ? `核心恐惧：${character.coreProfile.coreFear}` : '',
        character.coreProfile.valuePriority?.length ? `价值优先：${character.coreProfile.valuePriority.join('、')}` : '',
        character.coreProfile.values?.length ? `价值：${character.coreProfile.values.join('、')}` : '',
        character.coreProfile.socialMask ? `社交面具：${character.coreProfile.socialMask}` : '',
        character.coreProfile.biases?.length ? `偏见：${character.coreProfile.biases.join('、')}` : '',
        character.coreProfile.sensitivities?.length ? `敏感点：${character.coreProfile.sensitivities.join('、')}` : '',
        character.coreProfile.perceptionBiases?.length ? `认知滤镜：${character.coreProfile.perceptionBiases.join('、')}` : '',
        character.coreProfile.interactionHabits?.length ? `互动习惯：${character.coreProfile.interactionHabits.join('、')}` : '',
        character.coreProfile.expressionHabits?.length ? `表达习惯：${character.coreProfile.expressionHabits.join('、')}` : '',
        character.coreProfile.attachmentStyle ? `依恋/关系倾向：${character.coreProfile.attachmentStyle}` : '',
        character.coreProfile.conflictStyle ? `冲突方式：${character.coreProfile.conflictStyle}` : '',
        character.coreProfile.unmetNeeds?.length ? `未满足需求：${character.coreProfile.unmetNeeds.join('、')}` : '',
        character.coreProfile.selfImage ? `自我形象：${character.coreProfile.selfImage}` : '',
        character.coreProfile.hiddenSoftSpots?.length ? `隐秘柔软点：${character.coreProfile.hiddenSoftSpots.join('、')}` : '',
      ].filter(Boolean).join('\n')
    : '';
  const relationships = (character.relationships || [])
    .slice(0, 8)
    .map((item) => `${item.characterId}: 亲和${item.warmth} 能力${item.competence} 信任${item.trust} 威胁${item.threat}${item.note ? `；备注：${item.note}` : ''}`)
    .join('\n');
  return [
    `角色：${character.name}`,
    character.group ? `身份/分组：${character.group}` : '',
    character.background ? `背景：${character.background}` : '',
    character.speakingStyle ? `说话风格：${character.speakingStyle}` : '',
    character.expertise?.length ? `专长/兴趣：${character.expertise.join('、')}` : '',
    `人格参数：${personality}`,
    `当前情绪：${emotion}`,
    core,
    relationships ? `既有关系：\n${relationships}` : '',
  ].filter(Boolean).join('\n');
}

function buildDistillationSource(owner: { layeredMemories?: MemoryItem[] }, ownerType: 'chat' | 'character') {
  const items = owner.layeredMemories || [];
  const latest = latestLlmDistilledAt(items);
  const seenEventIds = latestLlmDistilledEventIds(items);
  const source = buildRecentSource(items, latest, seenEventIds, ownerType);
  if (!hasEnoughSourceItems(source, ownerType)) return [];
  if (!hasEnoughSourceEvidence(source, ownerType)) return [];
  if (!hasEnoughSourceDiversity(source, ownerType)) return [];
  if (!hasEnoughNewItems(eligibleItems(items, ownerType), latest, ownerType)) return [];
  if (!hasEnoughNewEventEvidence(source, seenEventIds, ownerType)) return [];
  return source;
}

function toCandidate(ownerId: string, source: MemoryItem[], item: LlmAnalyzedMemoryItem, now?: number): MemoryCandidate {
  const distilledAt = typeof now === 'number' && Number.isFinite(now) ? Math.round(now) : Date.now();
  return {
    scope: item.scope,
    layerHint: 'long_term',
    kind: item.kind,
    ownerId,
    subjectIds: item.subjectIds,
    text: item.text,
    evidenceText: collectMemoryAnalysisEvidenceText(source),
    sourceEventIds: collectTrackedMemoryAnalysisSourceEventIds(source),
    sourceTag: buildSourceTag(item),
    origin: 'distilled',
    decision: item.decision,
    distilledFromIds: source.map((entry) => entry.id),
    distilledAt,
    distillationVersion: LLM_MEMORY_ANALYSIS_VERSION,
    subjectOwner: item.subjectOwner,
    sourceType: item.sourceType || 'distilled',
    privacyRisk: item.privacyRisk,
    visibility: item.visibility,
    validity: item.validity || 'active',
    semanticTags: item.semanticTags,
    associations: item.associations,
    sharedPhrase: item.sharedPhrase,
    scoreBreakdown: {
      stability: 0.9,
      recurrence: 0.78,
      impact: 0.82,
      specificity: 0.84,
      durability: 0.94,
    },
  };
}

export function buildLlmDistillationSource(owner: { layeredMemories?: MemoryItem[] }, ownerType: 'chat' | 'character' = 'chat') {
  const recallLimit = Math.max(getCurrentRetentionLimits().chatLayeredMemories.recall, getCurrentRetentionLimits().characterLayeredMemories.recall);
  return eligibleItems(owner.layeredMemories || [], ownerType).slice(-Math.max(LLM_MEMORY_ANALYSIS_MAX_SOURCE_ITEMS, recallLimit));
}

export function debugLlmChatDistillation(chat: GroupChat) {
  const source = buildDistillationSource(chat, 'chat');
  return source.length
    ? { triggered: true, reason: 'ready', eligibleCount: source.length, evidenceCount: countDistinctEventEvidence(source) }
    : { triggered: false, reason: 'below_threshold', eligibleCount: 0, evidenceCount: 0 };
}

export function debugLlmCharacterDistillation(character: AICharacter) {
  const source = buildDistillationSource(character, 'character');
  return source.length
    ? { triggered: true, reason: 'ready', eligibleCount: source.length, evidenceCount: countDistinctEventEvidence(source) }
    : { triggered: false, reason: 'below_threshold', eligibleCount: 0, evidenceCount: 0 };
}

export function formatLlmDistillationReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    llm_distilled: '已完成 LLM 蒸馏',
    below_threshold: 'LLM 蒸馏证据不足',
  };
  return labels[reason] || reason;
}

export function shouldRunLlmChatDistillation(chat: GroupChat, turnCount: number) {
  void turnCount;
  return buildDistillationSource(chat, 'chat').length > 0;
}

export function shouldRunLlmCharacterDistillation(character: AICharacter, turnCount: number) {
  void turnCount;
  return buildDistillationSource(character, 'character').length > 0;
}

export async function distillChatMemoriesWithLlm(api: APIConfig, chat: GroupChat, options?: { now?: number }): Promise<MemoryCandidate[]> {
  const source = buildDistillationSource(chat, 'chat');
  if (!source.length) return [];
  const systemPrompt = `${buildChatMemoryAnalysisPrompt()}${SHARED_PHRASE_ANALYSIS_RULE}`;
  const raw = await generateJsonResponse(api, systemPrompt, [
    { role: 'user', content: `群聊：${chat.name}\n主题：${chat.topic || '未设置'}\n最近高门槛证据：\n${buildMemoryAnalysisEvidenceBlock(source)}` },
  ], { aiUsage: { type: 'memory_distillation', label: '蒸馏群聊记忆', scope: 'chat', resourceId: chat.id } });
  const result = parseLlmMemoryAnalysisResult(raw);
  return result.items.slice(0, LLM_MEMORY_ANALYSIS_MAX_OUTPUT_ITEMS).map((item) => toCandidate(chat.id, source, item, options?.now));
}

export async function distillCharacterMemoriesWithLlm(api: APIConfig, character: AICharacter, options?: { now?: number }): Promise<MemoryCandidate[]> {
  const source = buildDistillationSource(character, 'character');
  if (!source.length) return [];
  const systemPrompt = `${buildCharacterMemoryAnalysisPrompt()}${SHARED_PHRASE_ANALYSIS_RULE}`;
  const raw = await generateJsonResponse(api, systemPrompt, [
    { role: 'user', content: `${buildCharacterAnalysisContext(character)}\n\n最近高门槛证据：\n${buildMemoryAnalysisEvidenceBlock(source)}` },
  ], { aiUsage: { type: 'memory_distillation', label: '蒸馏角色记忆', scope: 'character', resourceId: character.id } });
  const result = parseLlmMemoryAnalysisResult(raw);
  return result.items.slice(0, LLM_MEMORY_ANALYSIS_MAX_OUTPUT_ITEMS).map((item) => toCandidate(character.id, source, item, options?.now));
}

type CoreProfilePatch = Partial<CharacterCoreProfile>;

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 220) : '';
}

function normalizeStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 8)
    : [];
}

function normalizeCoreProfilePatch(raw: unknown): CoreProfilePatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const patch: CoreProfilePatch = {
    coreDesire: normalizeString(record.coreDesire),
    coreFear: normalizeString(record.coreFear),
    socialMask: normalizeString(record.socialMask),
    values: normalizeStringList(record.values),
    valuePriority: normalizeStringList(record.values),
    sensitivities: normalizeStringList(record.sensitivities),
    perceptionBiases: normalizeStringList(record.perceptionBiases),
    biases: normalizeStringList(record.perceptionBiases),
    interactionHabits: normalizeStringList(record.interactionHabits),
    expressionHabits: normalizeStringList(record.expressionHabits),
    attachmentStyle: normalizeString(record.attachmentStyle),
    conflictStyle: normalizeString(record.conflictStyle),
    unmetNeeds: normalizeStringList(record.unmetNeeds),
    selfImage: normalizeString(record.selfImage),
    hiddenSoftSpots: normalizeStringList(record.hiddenSoftSpots),
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => Array.isArray(value) ? value.length > 0 : Boolean(value))) as CoreProfilePatch;
}

function buildCoreProfileDistillationPrompt() {
  return `你是角色心理档案蒸馏器。根据角色资料、已有核心画像和最近高门槛证据，输出严格 JSON。
目标：更新角色的长期心理档案，而不是复述聊天内容。
要求：
- 支持任意语言输入，输出中文。
- 不要因为单句玩笑就过度改写长期人格。
- 如果已有字段合理，可以保留；只有证据足够时才修正。
- expressionHabits 只记录多次可见发言共同呈现、且会随关系或处境变化的聊天习惯。用自然语言描述观察，不要输出句号率、语气词频率、固定概率、字数阈值或强制格式；证据不足时省略该字段。
- expressionHabits 会替换过时观察，不得把一次性的口头禅、某个标点或某次情绪反应固化成永久人设。
- 不要输出解释、markdown 或多余字段。

JSON 结构：
{
  "coreProfile": {
    "coreDesire": "长期想得到什么",
    "coreFear": "长期回避或害怕什么",
    "socialMask": "在人前如何保护自己",
    "values": ["价值优先级"],
    "sensitivities": ["敏感点/痛点"],
    "perceptionBiases": ["容易如何误读他人或局面"],
    "interactionHabits": ["互动习惯"],
    "expressionHabits": ["基于多次可见发言的可变表达习惯"],
    "attachmentStyle": "关系/依恋倾向",
    "conflictStyle": "冲突处理方式",
    "unmetNeeds": ["未满足需求"],
    "selfImage": "他以为自己是什么样的人",
    "hiddenSoftSpots": ["不轻易承认的柔软点"]
  }
}`;
}

export function mergeCoreProfilePatch(current: CharacterCoreProfile | undefined, patch: CoreProfilePatch | null): CharacterCoreProfile {
  const base = {
    ...DEFAULT_CORE_PROFILE,
    ...(current || {}),
    valuePriority: current?.valuePriority || [],
    values: current?.values || current?.valuePriority || [],
    biases: current?.biases || [],
    sensitivities: current?.sensitivities || [],
    perceptionBiases: current?.perceptionBiases || current?.biases || [],
    interactionHabits: current?.interactionHabits || [],
    expressionHabits: current?.expressionHabits || [],
    unmetNeeds: current?.unmetNeeds || [],
    hiddenSoftSpots: current?.hiddenSoftSpots || [],
  };
  if (!patch) return base;
  const pickText = (key: keyof CharacterCoreProfile) => normalizeString(patch[key]) || normalizeString(base[key]) || '';
  const mergeList = (currentList: string[] | undefined, patchList: string[] | undefined) => {
    const seen = new Set<string>();
    return [...(currentList || []), ...(patchList || [])]
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      })
      .slice(-8);
  };
  const values = mergeList(base.values || base.valuePriority, patch.values || patch.valuePriority);
  const perceptionBiases = mergeList(base.perceptionBiases || base.biases, patch.perceptionBiases || patch.biases);
  return {
    ...base,
    coreDesire: pickText('coreDesire'),
    coreFear: pickText('coreFear'),
    socialMask: pickText('socialMask'),
    values,
    valuePriority: values,
    sensitivities: mergeList(base.sensitivities, patch.sensitivities),
    perceptionBiases,
    biases: perceptionBiases,
    interactionHabits: mergeList(base.interactionHabits, patch.interactionHabits),
    // Expression habits describe the current observed voice, not permanent rules.
    // A fresh LLM observation replaces stale ones rather than accumulating quirks forever.
    expressionHabits: patch.expressionHabits?.length ? patch.expressionHabits.slice(-5) : base.expressionHabits,
    attachmentStyle: pickText('attachmentStyle'),
    conflictStyle: pickText('conflictStyle'),
    unmetNeeds: mergeList(base.unmetNeeds, patch.unmetNeeds),
    selfImage: pickText('selfImage'),
    hiddenSoftSpots: mergeList(base.hiddenSoftSpots, patch.hiddenSoftSpots),
  };
}

export async function distillCharacterCoreProfileWithLlm(api: APIConfig, character: AICharacter): Promise<CharacterCoreProfile | null> {
  const source = buildDistillationSource(character, 'character');
  if (!source.length) return null;
  const raw = await generateJsonResponse(api, buildCoreProfileDistillationPrompt(), [
    { role: 'user', content: `${buildCharacterAnalysisContext(character)}\n\n最近高门槛证据：\n${buildMemoryAnalysisEvidenceBlock(source)}` },
  ], { aiUsage: { type: 'character_core_profile', label: '蒸馏角色核心画像', scope: 'character', resourceId: character.id } });
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const patch = normalizeCoreProfilePatch(record.coreProfile || raw);
  return patch ? mergeCoreProfilePatch(character.coreProfile, patch) : null;
}
