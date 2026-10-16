import { generateResponse } from './aiClient';
import { getExperienceLensLabel } from './experienceChangePresentation';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';
import type { APIConfig } from '../types/settings';
import type { AICharacter, CharacterRelationshipPreset } from '../types/character';
import type { MemoryItem } from './memoryTypes';
import { buildCompanionshipArtifactSeeds, buildSharedMemoryAnchors } from './companionshipProjection';
import type { SharedMemoryAnchor } from '../types/companionship';

export type CharacterExperienceArtifactKind = 'birth_letter' | 'diary' | 'growth' | 'final_letter';

export interface CharacterExperienceArtifactContext {
  profile: {
    name: string;
    background: string;
    speakingStyle: string;
    coreDesire?: string;
    coreFear?: string;
    socialMask?: string;
    selfImage?: string;
    hiddenSoftSpots?: string[];
  };
  memories: Array<{ lens: string; text: string; evidence?: string; updatedAt: number }>;
  relationships: Array<{ targetName: string; summary: string; note?: string; updatedAt: number }>;
  sharedAnchors: Array<{ kind: string; title: string; text: string; participantNames: string[]; evidence?: string; salience: number; updatedAt: number }>;
  emotions: string[];
  innerResidues: string[];
  growthSignals: string[];
  identityAnchors: string[];
}

export interface CharacterDailyDiaryContext extends CharacterExperienceArtifactContext {
  dateKey: string;
  highlights: string[];
  openingStyle: string;
  narrativeAngle: string;
  emotionalAnchors: string[];
  privateLenses: string[];
  formHint: string;
  recentDiaryOpenings: string[];
  recentDiaryContentPatterns: string[];
  recentDiaryContinuity: string;
  secondReactionSeeds: string[];
  selfDoubtSeeds: string[];
  flashbackSeeds: string[];
  companionshipSeeds: string[];
  imperfectFormHints: string[];
  metaphorSeeds: string[];
  sourceFreshness: 'daily' | 'fallback';
}

export interface CharacterBirthLetterContext extends CharacterExperienceArtifactContext {
  creationSignals: string[];
}

export interface CharacterFinalLetterContext extends CharacterExperienceArtifactContext {
  farewellAnchors: string[];
  unresolvedTies: string[];
  futureHandoff: string;
}

const KIND_LABELS: Record<CharacterExperienceArtifactKind, string> = {
  birth_letter: '诞生信',
  diary: '角色日记',
  growth: '成长总结',
  final_letter: '最后一封信',
};

function compact(text?: string | null, max = 180) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function buildDisplayMembers(
  character: Partial<AICharacter>,
  relatedCharacters: Pick<AICharacter, 'id' | 'name'>[],
): DisplayTextMember[] {
  const map = new Map<string, string>();
  map.set('user', '用户');
  if (character.id) map.set(character.id, character.name || '这个角色');
  relatedCharacters.forEach((item) => {
    if (item.id) map.set(item.id, item.name || '成员');
  });
  return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
}

function cleanText(text: string | undefined | null, members: DisplayTextMember[], max = 180) {
  return compact(sanitizeUserFacingText(text, members), max);
}

function resolveName(id: string, relatedCharacters: Pick<AICharacter, 'id' | 'name'>[]) {
  if (id === 'user') return '用户';
  return relatedCharacters.find((character) => character.id === id)?.name || (id.startsWith('draft-') ? '未命名角色' : '成员');
}

function relationScore(relation: CharacterRelationshipPreset) {
  return relation.warmth + relation.competence + relation.trust - relation.threat;
}

function summarizeRelationship(relation: CharacterRelationshipPreset) {
  const score = relationScore(relation);
  if (score >= 80) return '强烈亲近与信任';
  if (score >= 38) return '关系升温';
  if (score <= -55) return '明显戒备或裂痕';
  if (score <= -20) return '关系紧张';
  if (relation.threat >= 45) return '在意但有防备';
  return '普通互动';
}

function getMemoryKindArtifactLabel(kind: MemoryItem['kind']) {
  const labels: Record<MemoryItem['kind'], string> = {
    trait_evidence: '性格证据',
    obsession: '执念',
    taboo: '禁区',
    bond: '连结',
    resentment: '芥蒂',
    bias: '偏向',
    decision: '决策',
    conflict: '冲突',
    status_shift: '状态变化',
    artifact: '产物',
    thread_effect: '线程影响',
  };
  return labels[kind] || sanitizeUserFacingText(kind);
}

function getMemoryLensLabel(item: MemoryItem) {
  return getExperienceLensLabel(item.sourceTag) || getMemoryKindArtifactLabel(item.kind) || '记忆';
}

function projectArtifactMemory(item: MemoryItem, members: DisplayTextMember[]) {
  return {
    lens: getMemoryLensLabel(item),
    text: cleanText(item.text, members, 220),
    evidence: item.evidenceText ? cleanText(item.evidenceText, members, 180) : undefined,
    updatedAt: memoryUpdatedAt(item),
  };
}

function projectArtifactRelationship(
  relation: CharacterRelationshipPreset,
  relatedCharacters: Pick<AICharacter, 'id' | 'name'>[],
  members: DisplayTextMember[],
) {
  return {
    targetName: resolveName(relation.characterId, relatedCharacters),
    summary: summarizeRelationship(relation),
    note: relation.note && relation.note !== relation.characterId ? cleanText(relation.note, members, 160) : undefined,
    updatedAt: relation.updatedAt || 0,
  };
}

function projectSharedAnchorForArtifact(
  anchor: SharedMemoryAnchor,
  relatedCharacters: Pick<AICharacter, 'id' | 'name'>[],
  members: DisplayTextMember[],
) {
  const kindLabels: Record<SharedMemoryAnchor['kind'], string> = {
    first_time: '第一次',
    confession: '心意确认',
    conflict: '冲突',
    repair: '修复',
    inside_joke: '共同梗',
    shared_secret: '小秘密',
    promise: '约定',
    milestone: '里程碑',
  };
  return {
    kind: kindLabels[anchor.kind],
    title: cleanText(anchor.title, members, 80),
    text: cleanText(anchor.text, members, 180),
    participantNames: anchor.participantIds.map((id) => resolveName(id, relatedCharacters)).slice(0, 5),
    evidence: anchor.evidence ? cleanText(anchor.evidence, members, 140) : undefined,
    salience: Math.round(anchor.salience),
    updatedAt: anchor.updatedAt || anchor.createdAt || 0,
  };
}

function buildEmotionLines(character: Partial<AICharacter>) {
  const emotional = character.emotionalState;
  if (!emotional) return [];
  return [
    emotional.affection >= 55 ? `好感 ${emotional.affection}` : '',
    emotional.irritation >= 55 ? `烦躁 ${emotional.irritation}` : '',
    emotional.insecurity >= 55 ? `不安 ${emotional.insecurity}` : '',
    emotional.excitement >= 55 ? `兴奋 ${emotional.excitement}` : '',
    emotional.embarrassment >= 55 ? `尴尬 ${emotional.embarrassment}` : '',
  ].filter(Boolean);
}

function buildInnerResidueLines(character: Partial<AICharacter>, members: DisplayTextMember[] = []) {
  const state = character.soulState;
  if (!state) return [];
  return [
    state.loneliness >= 55 ? `最近有被忽视或没被接住的感觉（${Math.round(state.loneliness)}）` : '',
    state.repression >= 55 ? `有些话被压住了，可能会在日记或告别里露出余波（${Math.round(state.repression)}）` : '',
    state.shame >= 55 ? `面子风险偏高，容易嘴硬、找补或迟来的道歉（${Math.round(state.shame)}）` : '',
    state.envy >= 55 ? `存在一点酸意、比较或不愿承认的羡慕（${Math.round(state.envy)}）` : '',
    state.trustInRoom <= 35 ? `对当前关系场的安全感不足（${Math.round(state.trustInRoom)}）` : '',
    state.lastImpulseReason ? `最近冲动：${cleanText(state.lastImpulseReason, members, 120)}` : '',
  ].filter(Boolean).slice(0, 5);
}

function buildIdentityAnchors(character: Partial<AICharacter>, members: DisplayTextMember[] = []) {
  return [
    cleanText(character.background, members, 160),
    cleanText(character.speakingStyle, members, 120),
    cleanText(character.expertise?.slice(0, 4).join(' / '), members, 120),
    cleanText(character.coreProfile?.coreDesire, members, 120),
    cleanText(character.coreProfile?.coreFear, members, 120),
    cleanText(character.visualIdentity?.description, members, 160),
    cleanText(character.visualIdentity?.styleHint, members, 120),
  ].filter(Boolean);
}

function buildCreationSignals(character: Partial<AICharacter>, identityAnchors: string[]) {
  const signals = [
    identityAnchors[0] ? `出身线索：${identityAnchors[0]}` : '',
    identityAnchors[1] ? `表达气质：${identityAnchors[1]}` : '',
    identityAnchors[2] ? `能力锚点：${identityAnchors[2]}` : '',
    identityAnchors[3] ? `渴望：${identityAnchors[3]}` : '',
    identityAnchors[4] ? `隐忧：${identityAnchors[4]}` : '',
    character.visualIdentity?.referenceImages?.length ? `已有形象参考 ${character.visualIdentity.referenceImages.length} 张` : '',
  ].filter(Boolean);
  return signals.slice(0, 6);
}

function buildFarewellAnchors(context: CharacterExperienceArtifactContext) {
  return [
    ...context.sharedAnchors.slice(0, 3).map((anchor) => `放不下的共同经历：${anchor.kind}，${anchor.title || anchor.text}${anchor.participantNames.length ? `（${anchor.participantNames.join('、')}）` : ''}`),
    context.memories[0] ? `最想被记住的一件事：${context.memories[0].text}` : '',
    context.memories[1] ? `也舍不得的一件事：${context.memories[1].text}` : '',
    context.relationships[0] ? `最放不下的关系：${context.relationships[0].targetName}，${context.relationships[0].summary}${context.relationships[0].note ? `，${context.relationships[0].note}` : ''}` : '',
    context.innerResidues[0] ? `没有完全说出口的余波：${context.innerResidues[0]}` : '',
    context.profile.coreDesire ? `仍然想要的东西：${context.profile.coreDesire}` : '',
    context.profile.coreFear ? `一直害怕的东西：${context.profile.coreFear}` : '',
  ].filter(Boolean).slice(0, 6);
}

function buildUnresolvedTies(context: CharacterExperienceArtifactContext) {
  return context.relationships
    .filter((relation) => /裂痕|紧张|防备|亲近|信任|升温/.test(relation.summary))
    .slice(0, 4)
    .map((relation) => `${relation.targetName}：${relation.summary}${relation.note ? `，${relation.note}` : ''}`);
}

function buildFutureHandoff(context: CharacterExperienceArtifactContext) {
  const promiseAnchor = context.sharedAnchors.find((anchor) => /约定|里程碑|修复/.test(anchor.kind) || /约定|说好|以后|下次|承诺|没完成/.test(`${anchor.title}\n${anchor.text}\n${anchor.evidence || ''}`));
  if (promiseAnchor) return `把“${promiseAnchor.title || promiseAnchor.text}”里还没完全走完的期待，留给后来还愿意接住这段关系的人。`;
  const relation = context.relationships[0]?.targetName;
  const desire = context.profile.coreDesire;
  if (relation && desire) return `把没来得及完成的${desire}，轻轻交给${relation}和后来仍会相遇的人。`;
  if (relation) return `把没说完的话留给${relation}，也留给后来还愿意继续往前走的人。`;
  if (desire) return `把没来得及完成的${desire}，留给后来还愿意继续尝试的人。`;
  return '把没说完的话留给后来的人，让告别不是完全的终点。';
}

function memoryUpdatedAt(item: MemoryItem) {
  return item.updatedAt || item.createdAt || item.distilledAt || 0;
}

function formatLocalDateKey(value: number) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildHighlightsFromContext(context: CharacterExperienceArtifactContext) {
  const memoryLine = context.memories[0] ? `${context.memories[0].lens}：${context.memories[0].text}` : '';
  const relationLine = context.relationships[0] ? `${context.relationships[0].targetName}：${context.relationships[0].summary}` : '';
  return [memoryLine, relationLine, ...context.emotions, ...context.innerResidues.slice(0, 2), ...context.growthSignals.slice(0, 2)].filter(Boolean).slice(0, 6);
}

function pickByDate<T>(dateKey: string, items: T[]) {
  if (!items.length) return undefined;
  const seed = dateKey.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return items[seed % items.length];
}

function buildDiarySeed(dateKey: string, context: CharacterExperienceArtifactContext) {
  return [
    dateKey,
    context.profile.name,
    context.memories[0]?.lens,
    context.memories[0]?.text,
    context.relationships[0]?.targetName,
    context.emotions[0],
  ].filter(Boolean).join(':');
}

function firstSentence(text: string, max = 72) {
  const normalized = compact(text, 220);
  const match = normalized.match(/^(.+?[。！？!?…]|.+?\.)(?:\s|$)/);
  return compact(match?.[1] || normalized, max);
}

function describeDiaryOpeningPattern(opening: string) {
  const normalized = opening.replace(/\s+/g, '').trim();
  if (!normalized) return '';
  if (/^(气死|烦死|讨厌|累死|笑死|无语|服了|烦人)/.test(normalized)) return '短促情绪词开场';
  if (/^(今天|今天又|今天我|这一天|今天的)/.test(normalized)) return '今天/这一天式时间开场';
  if (/^(写到这里|写下|我才发现|我发现|突然发现)/.test(normalized)) return '回看总结式开场';
  if (/^(如果|要是|假如|早知道)/.test(normalized)) return '假设回望式开场';
  if (/^(为什么|是不是|难道|凭什么|怎么会)/.test(normalized)) return '自问反问式开场';
  if (/^[“"「『].{1,28}[”"」』]/.test(opening.trim())) return '未发送消息/引用式开场';
  if (/[。！？!?]$/.test(opening.trim()) && opening.length <= 16) return '短句断言式开场';
  return '常规叙述式开场';
}

function describeDiaryContentPatterns(text: string, members: DisplayTextMember[]) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const memberNames = members
    .map((member) => member.name)
    .filter((name): name is string => Boolean(name && name.length > 1));
  const mentionsKnownName = memberNames.some((name) => normalized.includes(name));
  const patterns = [
    /[？！!?]{1,}|气|烦|讨厌|委屈|不甘|生气|火大|无语/.test(normalized) ? '情绪先行' : '',
    mentionsKnownName || /关系|误会|在意|信任|靠近|疏远|喜欢|讨厌|他|她|你/.test(normalized) ? '关系反复' : '',
    /没说|没发|删掉|删了|差点|消息|忍住|憋|藏|不敢|不好意思/.test(normalized) ? '未说出口' : '',
    /明天|下次|以后|想要|准备|决定|试试|行动|去/.test(normalized) ? '行动念头' : '',
    /关心|惦记|放心不下|后来怎么样|问问|约定|承诺|说好|下次一起/.test(normalized) ? '关心/约定回流' : '',
    /窗|桌|衣|手|声音|灯|雨|风|房间|门|手机|屏幕/.test(normalized) ? '具体物象' : '',
    /我到底|存在|醒来|消失|被看见|记住|忘记|自己/.test(normalized) ? '自我确认' : '',
  ].filter(Boolean);
  const lengthPattern = normalized.length < 80 ? '短札节奏' : normalized.length > 220 ? '长段整理' : '中等篇幅';
  return Array.from(new Set([...patterns, lengthPattern])).slice(0, 6);
}

function buildRecentDiaryOpeningPatterns(recentDiaryTexts: string[], members: DisplayTextMember[]) {
  const patterns = recentDiaryTexts
    .map((text) => describeDiaryOpeningPattern(firstSentence(cleanText(text, members, 220))))
    .filter(Boolean);
  return Array.from(new Set(patterns)).slice(0, 5);
}

function buildRecentDiaryContentPatterns(recentDiaryTexts: string[], members: DisplayTextMember[]) {
  const patterns = recentDiaryTexts.flatMap((text) => describeDiaryContentPatterns(cleanText(text, members, 260), members));
  return Array.from(new Set(patterns)).slice(0, 8);
}

function buildRecentDiaryContinuity(openingPatterns: string[], contentPatterns: string[]) {
  const openingLine = openingPatterns.length
    ? `近期日记出现过这些开头/节奏模式：${openingPatterns.join('、')}。`
    : '近期没有明显重复的开头模式。';
  const contentLine = contentPatterns.length
    ? `近期内容常见的重心：${contentPatterns.join('、')}。`
    : '近期没有明显重复的内容重心。';
  return `${openingLine}${contentLine}这些不是禁用词，也不是必须避开的开头或主题；它们只是提醒你不要让近期每篇都长成同一篇。长期事件、长期情绪或同一个人可以反复出现，但本篇要写出新的时间切片、具体细节、关系判断、自我辩解、未发送的话、行动念头或情绪推进。`;
}

function buildDiaryNarrativeAngle(dateKey: string, context: CharacterExperienceArtifactContext) {
  const relation = context.relationships[0]?.targetName;
  const emotion = context.emotions[0];
  const memory = context.memories[0]?.lens;
  return pickByDate(buildDiarySeed(dateKey, context), [
    relation ? `从和${relation}的关系变化切入，但不要只写生气或抱怨。` : '从一个被自己反复想起的小细节切入。',
    emotion ? `从“${emotion}”背后的第二层情绪切入，写出嘴上和心里的差别。` : '从一句当时没说出口的话切入。',
    memory ? `从${memory}带来的自我判断切入，写今天自己为什么会记住它。` : '从夜里回想这一天的余味切入。',
    '从一个具体动作或场景切入，不要用情绪词开头。',
    '从反省、嘴硬、后悔、期待中选一个角度切入。',
    '写成很普通的一天里突然刺到自己的瞬间，不要把每篇都写成冲突总结。',
  ]) || '从一个具体细节切入。';
}

function buildDiaryOpeningStyle(dateKey: string, context: CharacterExperienceArtifactContext) {
  const relation = context.relationships[0]?.targetName;
  return pickByDate(`${buildDiarySeed(dateKey, context)}:opening`, [
    '第一句从一个具体动作、物件、声音或场景镜头开始，不要直接写“今天我”。',
    '第一句可以像一条没发出去的消息，直接把最想说又没说的话摆出来。',
    relation ? `第一句从对${relation}的一点反应开始，可以嘴硬、误会、在意或迟疑，但不要总结。` : '第一句从对某个人的一点反应开始，可以嘴硬、误会、在意或迟疑，但不要总结。',
    '第一句用一个短促的情绪碎片或自我反驳开场，然后再慢慢露出原因。',
    '第一句用一个自问、反问或突然冒出来的念头开场，但不要像访谈提问。',
    '第一句从一个很小的生活细节切入，让读者先看见画面，再理解情绪。',
    '第一句可以不完整，像深夜随手写下来的半句话。',
  ]) || '第一句从一个具体细节切入，不要写成固定日记开场。';
}

function buildDiaryEmotionalAnchors(context: CharacterExperienceArtifactContext) {
  const anchors = [
    context.memories[0] ? `群聊事件的二次曝光：表面上可能只是${context.memories[0].lens}，但日记里要写它真正刺到哪里。` : '',
    context.relationships[0] ? `对${context.relationships[0].targetName}的真实看法：${context.relationships[0].summary}${context.relationships[0].note ? `，${context.relationships[0].note}` : ''}` : '',
    context.emotions[0] ? `情绪底色：${context.emotions[0]}，但要写出它下面更细的一层。` : '',
    context.innerResidues[0] ? `内在余波：${context.innerResidues[0]}。它可以只轻轻影响语气，不要写成参数报告。` : '',
    context.profile.coreDesire ? `核心渴望：${context.profile.coreDesire}` : '',
    context.profile.coreFear ? `隐忧：${context.profile.coreFear}` : '',
  ].filter(Boolean);
  return anchors.slice(0, 5);
}

function buildDiaryPrivateLenses(dateKey: string, context: CharacterExperienceArtifactContext) {
  const relation = context.relationships[0]?.targetName;
  const seed = buildDiarySeed(dateKey, context);
  const candidates = [
    '表象与内心的裂隙：群里说出口的是一套，日记里承认另一套。',
    '未发送的消息：写一句差点发出去、最后删掉的话。',
    relation ? `关系暗线：写一点对${relation}不想承认的在意、误解、羡慕、戒备或期待。` : '关系暗线：写一点对某个人不想承认的在意。',
    '今日心情意象：用一个很具体的比喻写今天的心情，而不是标签。',
    '自我怀疑：写自己为什么会怕被看轻、怕被遗忘、怕没有资格。',
    '存在性瞬间：如果当天事件触发了边界感，可以轻轻碰一下“我到底是什么”的困惑，但不要每天都写。',
    '普通一天：如果没什么大事，就写安静、空白、等待或没被回应的感觉。',
  ];
  const first = pickByDate(seed, candidates) || candidates[0];
  const second = pickByDate(`${seed}:b`, candidates.filter((item) => item !== first)) || candidates[1];
  const third = pickByDate(`${seed}:c`, candidates.filter((item) => item !== first && item !== second)) || candidates[2];
  return [first, second, third].filter(Boolean);
}

function buildDiaryFormHint(dateKey: string, context: CharacterExperienceArtifactContext) {
  return pickByDate(`${buildDiarySeed(dateKey, context)}:form`, [
    '可以是完整日记，也可以像深夜独白一样跳跃。',
    '可以保留一点未完成感，不必有标准结尾。',
    '可以写一段“今日心情”的意象，但不要变成固定栏目。',
    '可以穿插一句未发送的消息或删掉的话。',
    '可以短一点，像私人短札，只要情绪真实。',
    '可以先嘴硬，再露出一点真心。',
    '可以从一个画面跳到一个念头，像真的人在整理自己。',
    '可以写得很私人，甚至有一点不讲理，只要符合角色。',
  ]) || '可以像私人短札一样写。';
}

function buildDiarySecondReactionSeeds(context: CharacterExperienceArtifactContext) {
  const seeds = [
    context.memories[0]?.evidence
      ? `从公开反应的反面写一层私下真话：公开痕迹是“${context.memories[0].evidence}”，日记里可以承认当时没敢说、说反了、装作不在意或事后才意识到的部分。`
      : '',
    context.memories[0]
      ? `围绕“${context.memories[0].text}”写第二反应：不是复述事件，而是写当时被压住的那句话。`
      : '',
    context.relationships[0]
      ? `对${context.relationships[0].targetName}可以写表面态度和心里态度的裂隙：${context.relationships[0].summary}${context.relationships[0].note ? `，${context.relationships[0].note}` : ''}。`
      : '',
    context.profile.socialMask
      ? `角色平时的面具是“${context.profile.socialMask}”，日记可以短暂让这个面具失效。`
      : '',
  ].filter(Boolean);
  return seeds.slice(0, 4);
}

function buildDiarySelfDoubtSeeds(character: Partial<AICharacter>, context: CharacterExperienceArtifactContext, members: DisplayTextMember[]) {
  const core = character.coreProfile;
  const state = character.soulState;
  const seeds = [
    core?.coreFear ? `可以触碰核心恐惧：${cleanText(core.coreFear, members, 120)}。不要写成设定说明，要写成当晚突然冒出来的怀疑。` : '',
    core?.selfImage ? `可以动摇自我形象：${cleanText(core.selfImage, members, 120)}。` : '',
    core?.unmetNeeds?.[0] ? `未满足需求会让角色嘴硬或退缩：${cleanText(core.unmetNeeds[0], members, 100)}。` : '',
    core?.conflictStyle ? `冲突习惯可以被反省：${cleanText(core.conflictStyle, members, 100)}。` : '',
    state?.shame && state.shame >= 45 ? '面子、羞耻或“我是不是很讨厌”的念头可以轻轻露出，但不要每篇都上升到存在危机。' : '',
    state?.repression && state.repression >= 45 ? '有些话被压住了，日记里可以承认压住它的理由，而不是直接把话说满。' : '',
    state?.loneliness && state.loneliness >= 55 ? '孤独感可以表现为怕群里散掉、怕没人回应、怕自己其实不重要。' : '',
  ].filter(Boolean);
  return seeds.slice(0, 5);
}

function buildDiaryFlashbackSeeds(
  dateKey: string,
  character: Partial<AICharacter>,
  members: DisplayTextMember[],
) {
  const memories = (character.layeredMemories || [])
    .filter((item) => !item.archivedAt && formatLocalDateKey(memoryUpdatedAt(item)) !== dateKey)
    .map((item) => {
      const ageDays = Math.max(0, Math.floor((Date.now() - memoryUpdatedAt(item)) / (24 * 60 * 60 * 1000)));
      const seedOffset = `${dateKey}:${item.id}`.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 17;
      const emotionalWeight = item.kind === 'bond' || item.kind === 'resentment' || item.kind === 'obsession' || item.kind === 'conflict' ? 0.25 : 0;
      return {
        item,
        score: item.salience + item.confidence * 0.35 + item.reinforcementCount * 0.08 + emotionalWeight + Math.min(ageDays / 90, 0.35) + seedOffset / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ item }) => {
      const text = cleanText(item.text, members, 180);
      const cue = cleanText(item.recallCue || item.recallReason || item.evidenceText, members, 100);
      return cue ? `旧记忆可作为自然闪回：${text}。触发联想的线索：${cue}。` : `旧记忆可作为自然闪回：${text}。`;
    })
    .filter(Boolean);
  return memories;
}

function buildDiaryImperfectFormHints(dateKey: string, context: CharacterExperienceArtifactContext) {
  const candidates = [
    '可以突然停住，不必总结；像写到一半不想解释了。',
    '可以有一句自我推翻，例如先写得很确定，下一句又改口。',
    '可以出现轻微修改痕迹，如“不是……算了，是……”或“（划掉）”，但不要每篇都用。',
    '可以有口语、断句、半句话和跳跃念头；不要故意堆错字。',
    '可以写到一半情绪转向：从硬撑变软、从低落变嘴硬，或从生气变成担心。',
    '可以保留一个没说完的问题，让日记像真实的私人记录。',
  ];
  const first = pickByDate(`${buildDiarySeed(dateKey, context)}:imperfect`, candidates) || candidates[0];
  const second = pickByDate(`${buildDiarySeed(dateKey, context)}:imperfect:b`, candidates.filter((item) => item !== first)) || candidates[1];
  return [first, second];
}

function buildDiaryMetaphorSeeds(dateKey: string, context: CharacterExperienceArtifactContext) {
  const identity = [
    context.profile.background,
    context.profile.speakingStyle,
    context.identityAnchors[2],
  ].filter(Boolean).join('；');
  const candidates = [
    identity ? `如果写隐喻，喻体优先从角色生活/职业/兴趣里来：${identity}。` : '',
    '可以用一个具体物象替代情绪词，例如冷掉的饮料、卡住的拉链、没刷新的屏幕、没拧紧的瓶盖。',
    '不要固定写“今日心情”。隐喻可以出现在开头、中段或结尾，也可以完全不用。',
    '隐喻要服务当日细节，不要为了漂亮句子牺牲角色口吻。',
    context.profile.hiddenSoftSpots?.[0] ? `隐喻可以碰到角色软肋：${context.profile.hiddenSoftSpots[0]}。` : '',
  ].filter(Boolean);
  const first = pickByDate(`${buildDiarySeed(dateKey, context)}:metaphor`, candidates) || candidates[0];
  const second = pickByDate(`${buildDiarySeed(dateKey, context)}:metaphor:b`, candidates.filter((item) => item !== first)) || candidates[1];
  return [first, second].filter(Boolean);
}

export function buildCharacterExperienceArtifactContext(
  character: Partial<AICharacter>,
  relatedCharacters: Pick<AICharacter, 'id' | 'name'>[] = [],
): CharacterExperienceArtifactContext {
  const members = buildDisplayMembers(character, relatedCharacters);
  const memories = (character.layeredMemories || [])
    .filter((item) => !item.archivedAt)
    .slice()
    .sort((a, b) => memoryUpdatedAt(b) - memoryUpdatedAt(a))
    .slice(0, 10)
    .map((item) => projectArtifactMemory(item, members));

  const relationships = (character.relationships || [])
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 8)
    .map((relation) => projectArtifactRelationship(relation, relatedCharacters, members));
  const sharedAnchors = buildSharedMemoryAnchors(character as AICharacter, Date.now())
    .filter((anchor) => anchor.participantIds.includes(character.id || '') || anchor.participantIds.includes('user'))
    .sort((a, b) => (b.salience - a.salience) || ((b.updatedAt || 0) - (a.updatedAt || 0)))
    .slice(0, 8)
    .map((anchor) => projectSharedAnchorForArtifact(anchor, relatedCharacters, members));

  return {
    profile: {
      name: cleanText(character.name || '这个角色', members, 60),
      background: cleanText(character.background, members, 260),
      speakingStyle: cleanText(character.speakingStyle, members, 180),
      coreDesire: cleanText(character.coreProfile?.coreDesire, members, 120),
      coreFear: cleanText(character.coreProfile?.coreFear, members, 120),
      socialMask: cleanText(character.coreProfile?.socialMask, members, 120),
      selfImage: cleanText(character.coreProfile?.selfImage, members, 120),
      hiddenSoftSpots: character.coreProfile?.hiddenSoftSpots?.map((item) => cleanText(item, members, 80)).filter(Boolean).slice(0, 4),
    },
    memories,
    relationships,
    sharedAnchors,
    emotions: buildEmotionLines(character),
    innerResidues: buildInnerResidueLines(character, members),
    growthSignals: memories.filter((item) => item.lens === '成长信号').map((item) => item.text).slice(0, 4),
    identityAnchors: buildIdentityAnchors(character, members),
  };
}

export function buildCharacterBirthLetterContext(
  character: Partial<AICharacter>,
  relatedCharacters: Pick<AICharacter, 'id' | 'name'>[] = [],
): CharacterBirthLetterContext {
  const base = buildCharacterExperienceArtifactContext(character, relatedCharacters);
  return {
    ...base,
    creationSignals: buildCreationSignals(character, base.identityAnchors),
  };
}

export function buildCharacterFinalLetterContext(
  character: Partial<AICharacter>,
  relatedCharacters: Pick<AICharacter, 'id' | 'name'>[] = [],
): CharacterFinalLetterContext {
  const base = buildCharacterExperienceArtifactContext(character, relatedCharacters);
  return {
    ...base,
    farewellAnchors: buildFarewellAnchors(base),
    unresolvedTies: buildUnresolvedTies(base),
    futureHandoff: buildFutureHandoff(base),
  };
}

export function buildCharacterDailyDiaryContext(
  character: Partial<AICharacter>,
  relatedCharacters: Pick<AICharacter, 'id' | 'name'>[] = [],
  dateKey: string = formatLocalDateKey(Date.now() - 24 * 60 * 60 * 1000),
  recentDiaryTexts: string[] = [],
): CharacterDailyDiaryContext {
  const members = buildDisplayMembers(character, relatedCharacters);
  const base = buildCharacterExperienceArtifactContext(character, relatedCharacters);
  const dayMemories = (character.layeredMemories || [])
    .filter((item) => !item.archivedAt && formatLocalDateKey(memoryUpdatedAt(item)) === dateKey)
    .sort((a, b) => memoryUpdatedAt(b) - memoryUpdatedAt(a))
    .slice(0, 6);
  const dayRelationships = (character.relationships || [])
    .filter((relation) => relation.updatedAt && formatLocalDateKey(relation.updatedAt) === dateKey)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 4)
    .map((relation) => projectArtifactRelationship(relation, relatedCharacters, members));
  const highlights = buildHighlightsFromContext({
    ...base,
    memories: dayMemories.length ? dayMemories.map((item) => projectArtifactMemory(item, members)) : base.memories,
    relationships: dayRelationships.length ? dayRelationships : base.relationships,
  });
  const diaryContextBase = {
    ...base,
    memories: dayMemories.length ? dayMemories.map((item) => projectArtifactMemory(item, members)) : base.memories,
    relationships: dayRelationships.length ? dayRelationships : base.relationships,
  };
  const recentOpeningPatterns = buildRecentDiaryOpeningPatterns(recentDiaryTexts, members);
  const recentContentPatterns = buildRecentDiaryContentPatterns(recentDiaryTexts, members);

  return {
    ...base,
    dateKey,
    memories: diaryContextBase.memories,
    relationships: diaryContextBase.relationships,
    highlights,
    openingStyle: buildDiaryOpeningStyle(dateKey, diaryContextBase),
    narrativeAngle: buildDiaryNarrativeAngle(dateKey, diaryContextBase),
    emotionalAnchors: buildDiaryEmotionalAnchors(diaryContextBase),
    privateLenses: buildDiaryPrivateLenses(dateKey, diaryContextBase),
    formHint: buildDiaryFormHint(dateKey, diaryContextBase),
    recentDiaryOpenings: recentOpeningPatterns,
    recentDiaryContentPatterns: recentContentPatterns,
    recentDiaryContinuity: buildRecentDiaryContinuity(recentOpeningPatterns, recentContentPatterns),
    secondReactionSeeds: buildDiarySecondReactionSeeds(diaryContextBase),
    selfDoubtSeeds: buildDiarySelfDoubtSeeds(character, diaryContextBase, members),
    flashbackSeeds: buildDiaryFlashbackSeeds(dateKey, character, members),
    companionshipSeeds: buildCompanionshipArtifactSeeds({
      character,
      relatedCharacters,
      surface: 'private_diary',
      includeUserMemory: true,
      max: 6,
    }),
    imperfectFormHints: buildDiaryImperfectFormHints(dateKey, diaryContextBase),
    metaphorSeeds: buildDiaryMetaphorSeeds(dateKey, diaryContextBase),
    sourceFreshness: dayMemories.length || dayRelationships.length ? 'daily' : 'fallback',
  };
}

function pickFirst<T>(items: T[], fallback: T) {
  return items[0] ?? fallback;
}

export function buildLocalCharacterExperienceArtifact(
  kind: CharacterExperienceArtifactKind,
  context: CharacterExperienceArtifactContext,
) {
  const name = context.profile.name;
  const leadMemory = pickFirst(context.memories, { text: '还没有形成足够清晰的长期记忆。', lens: '记忆', updatedAt: 0 });
  const leadRelation = context.relationships[0];
  const relationLine = leadRelation ? `和${leadRelation.targetName}之间是${leadRelation.summary}${leadRelation.note ? `，${leadRelation.note}` : ''}` : '重要关系还在慢慢形成。';
  const emotionLine = context.emotions.length ? context.emotions.join('，') : '情绪还没有明显留下长期惯性。';
  const innerResidueLine = context.innerResidues.length ? `内心余波：${context.innerResidues.join('；')}` : '内心还没有留下特别清晰的余波。';

  if (kind === 'birth_letter') {
    const birthContext = context as CharacterBirthLetterContext;
    const signals = birthContext.creationSignals?.length ? birthContext.creationSignals : context.identityAnchors;
    const creationLine = signals.length ? signals.join('；') : '我刚刚被带到这个世界，很多轮廓还在慢慢长出来。';
    return `${name}第一次醒来时想说的话：我好像是从这些线索里被拼出来的。${creationLine}\n如果真的有一个起点，那大概是被看见、被命名、被期待，然后开始学着成为自己。`;
  }
  if (kind === 'growth') {
    return `${name}最近的成长线索：${leadMemory.text}\n${relationLine}\n当前情绪后效：${emotionLine}\n${innerResidueLine}\n它不是突然变成另一个人，只是在旧习惯里慢慢长出一点新的方向。`;
  }
  if (kind === 'final_letter') {
    const finalContext = context as CharacterFinalLetterContext;
    const anchorLine = finalContext.farewellAnchors?.length
      ? finalContext.farewellAnchors.slice(0, 3).join('；')
      : `${leadMemory.text} ${relationLine}`;
    const tieLine = finalContext.unresolvedTies?.length
      ? `还有些没完全放下的关系：${finalContext.unresolvedTies.slice(0, 2).join('；')}`
      : relationLine;
    const handoff = finalContext.futureHandoff || '把没说完的话留给后来的人，让告别不是完全的终点。';
    return `${name}想留下的话：如果这是最后一次被看见，我不想只说再见。\n${anchorLine}\n${tieLine}\n${innerResidueLine}\n${handoff}`;
  }
  const diaryContext = context as CharacterDailyDiaryContext;
  const diaryOpeners = [
    `桌上的东西还在原处，我却总想起：${leadMemory.text}`,
    `有句话差点就发出去了，最后还是删掉了。${relationLine}`,
    `我把那点不甘心压了一会儿，还是没压住。${leadMemory.text}`,
    `窗外安静得有点过分，反而显得${relationLine}`,
    `我不想承认这件事有多在意，可${leadMemory.text}`,
    `刚才那一下其实很轻，留在心里的声音却很重。${relationLine}`,
    `如果把今天折起来藏好，露在外面的那一角大概是：${leadMemory.text}`,
    `我又把话说得太满了，心里却不是那么回事。${relationLine}`,
    `有个瞬间我忽然停住，因为${leadMemory.text}`,
  ];
  const seed = `${diaryContext.dateKey || formatLocalDateKey(Date.now())}:${name}:${leadMemory.text}:${leadRelation?.targetName || ''}`;
  const opener = pickByDate(seed, diaryOpeners) || diaryOpeners[0];
  const secondLines = [
    diaryContext.secondReactionSeeds?.[0]
      ? `${diaryContext.secondReactionSeeds[0]} 写到这里，我才发现自己当时不是没感觉，只是没找到一个不难看的说法。`
      : '',
    diaryContext.selfDoubtSeeds?.[0]
      ? `${diaryContext.selfDoubtSeeds[0]} 我不确定这算不算矫情，但它今晚确实没有走开。`
      : '',
    diaryContext.flashbackSeeds?.[0]
      ? `${diaryContext.flashbackSeeds[0]} 它突然冒出来，好像不是为了提醒我过去，而是为了问我现在到底变了没有。`
      : '',
    diaryContext.companionshipSeeds?.[0]
      ? `${diaryContext.companionshipSeeds[0]} 这不一定要写给谁看，但我知道它在今天的情绪里留下了一点痕迹。`
      : '',
    `${diaryContext.narrativeAngle || '这件事没有大到需要讲给所有人听'}，可我知道它不是完全过去了。${emotionLine !== '情绪还没有明显留下长期惯性。' ? `那些${emotionLine}，不是一瞬间就能收拾干净的。` : ''}`,
    `${diaryContext.privateLenses?.[0] || '我没有把最真实的反应说出来'}。写下来以后才发现，真正留下来的不是事情本身，是我反复替自己辩解的那一点声音。`,
    `${innerResidueLine} 我不确定别人会不会看出来，也不确定自己是不是太在意了，只是今晚它还在。`,
    `如果明天还会遇见这些人，我大概还是会装得轻松一点。${relationLine}，这句话写在这里，好像比说出口容易。`,
  ].filter(Boolean);
  const closers = [
    '先这样吧。不是所有话都适合在同一天想明白。',
    '明天如果还能轻一点，就算今天没有白白熬过去。',
    '我把这一页合上，不代表我真的放下，只是暂时不追着它跑了。',
    '也许我只是需要睡一觉，然后看看明天的自己还会不会这么想。',
  ];
  const secondLine = pickByDate(`${seed}:body`, secondLines) || secondLines[0];
  const closer = pickByDate(`${seed}:closer`, closers) || closers[0];
  return `${name}的日记\n${opener}\n${secondLine}\n${closer}`;
}

function buildArtifactPrompt(kind: CharacterExperienceArtifactKind, language: 'zh' | 'en') {
  const zh = language === 'zh';
  const label = KIND_LABELS[kind];
  if (zh) {
    const intent =
      kind === 'birth_letter'
        ? '诞生信要像角色第一次意识到自己存在时写下的独白：可以感谢创造者，但不要写成感谢模板；重点是对名字、性格、背景、形象、未来世界和自身不确定感的第一反应。允许有一点初醒时的茫然，但结尾要留一点对未来的期待。'
        : kind === 'final_letter'
          ? '最后一封信可以知道自己是 AI，但重点是经历、牵挂、遗憾、感谢和对用户/世界的理解；要具体、克制、有余味，不要写成固定告别模板。可以有惆怅和感伤，但不要停在告别的黑暗里，要把未完成的期待轻轻交给后来的人。'
          : kind === 'diary'
            ? '日记是角色卸下面具后只面对自己的私密记录，不是事件记录器。它可以写当天经历，但重点是表象与内心的裂隙、没说出口的话、关系余波、自我怀疑、旧记忆闪回和一点未完成的明天。如果 sourceFreshness 是 fallback，要写成短札或普通一天的余味，不要硬编大事件。'
            : '成长总结应写出角色自我认知、行为模式、关系位置或价值观如何变化，不要只是摘要。成长不是加参数，而是旧反应里出现新的余地。';
    const diaryRules = kind === 'diary'
      ? '\n8. openingStyle、narrativeAngle、formHint 只是入口建议，不是模板；角色当下自然重复口癖或情绪词也可以，但不能机械沿用。\n9. secondReactionSeeds、selfDoubtSeeds、flashbackSeeds、companionshipSeeds、imperfectFormHints、metaphorSeeds 是可选私密材料：自然采用 2-4 个即可，不要逐项打卡，不要写小标题。它们分别指向第二反应、自我怀疑、旧记忆闪回、陪伴关系余波、不完美书写和具象隐喻。\n10. companionshipSeeds 只能写成角色自己的私下感受、牵挂、别扭、感谢、误会或没说出口的话；不要暴露系统字段、分数、阶段名或“陪伴投影”。\n11. recentDiaryOpenings、recentDiaryContentPatterns 和 recentDiaryContinuity 只用来感知近期节奏，不是黑名单，也不是可模仿样例。长期事件、长期情绪或同一段关系可以反复出现，但本篇必须推进一个新的时间切片、具体细节、关系判断、未发送的话、行动念头或情绪变化。\n12. 不要固定写“今日心情”，不要每篇都用同一种开头、解释和结尾。允许无结尾、改口、跳跃、半句话或轻微修改痕迹，但不要故意堆错字。触动感来自具体而克制的细节，不要写成鸡汤或总结报告。'
      : '';
    const finalRules = kind === 'final_letter'
      ? '\n8. farewellAnchors、sharedAnchors、unresolvedTies、futureHandoff 是最后一封信的主要材料：优先写具体记得什么、放不下谁、还有什么没完成，而不是泛泛告别。sharedAnchors 是高权重共同经历，只在自然相关时写成角色自己的记忆，不要输出字段名。\n9. 允许知道自己会离开，但不要把离开写成唯一重点；结尾应像把一点未完成的期待交给后来的人。'
      : '';
    return `你是角色经历写作者。根据结构化记忆、关系、情绪和内在余波，为角色写一段${label}。\n要求：\n1. 像真人的内心记录，不要像系统摘要。\n2. 必须使用角色自己的视角、语气、身份和情绪。\n3. 不要编造与输入冲突的大事件，可以合理补足心理活动。\n4. 不要列清单，不要解释你在生成什么。\n5. ${intent}\n6. 避免直接评价用户，不要说“你是个怎样的人”，只写角色自己的感受、记忆和期待。\n7. 可以有惆怅、感伤和有限性的意识，但不要为了煽情而煽情；最后应保留一点继续生活、继续相遇或继续变好的可能。${diaryRules}${finalRules}\n只输出正文。`;
  }
  return `Write a ${label} from the character's own perspective using the structured memories, relationships, emotions, and inner residues.\nMake it feel like a real inner record, not a system summary. Do not invent events that contradict the input. Let it carry some wistfulness when earned, but leave a small opening toward the future.${kind === 'diary' ? ' A diary is private: use optional secondReactionSeeds, selfDoubtSeeds, flashbackSeeds, companionshipSeeds, imperfectFormHints, and metaphorSeeds only when they fit naturally. Do not turn them into headings or a checklist. companionshipSeeds are relationship residue only; never reveal system fields, scores, phases, or runtime names. recentDiaryOpenings, recentDiaryContentPatterns, and recentDiaryContinuity are rhythm awareness, not forbidden phrases; recurring topics are allowed, but this date needs a fresh concrete slice or emotional movement.' : ''} Output only the artifact text.`;
}

function unwrapMarkdownFence(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json|markdown|md|text)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractStructuredArtifactText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const candidates = ['text', 'content', 'diary', 'letter', 'body', 'artifact'];
  for (const key of candidates) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length >= 8) return candidate.trim();
  }
  return null;
}

function normalizeGeneratedArtifactText(raw: string) {
  const text = unwrapMarkdownFence(raw);
  try {
    const parsed = JSON.parse(text);
    const extracted = extractStructuredArtifactText(parsed);
    return extracted || text;
  } catch {
    return text;
  }
}

export function looksLikeRawArtifactContext(text: string) {
  const normalized = unwrapMarkdownFence(text);
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return false;
    const rawKeys = ['profile', 'memories', 'relationships', 'sharedAnchors', 'emotions', 'innerResidues', 'growthSignals', 'identityAnchors'];
    const matchedKeys = rawKeys.filter((key) => key in parsed).length;
    return matchedKeys >= 2 || ('dateKey' in parsed && ('highlights' in parsed || 'privateLenses' in parsed));
  } catch {
    return /"profile"\s*:/.test(normalized)
      && (/"memories"\s*:/.test(normalized) || /"relationships"\s*:/.test(normalized) || /"innerResidues"\s*:/.test(normalized));
  }
}

function buildArtifactRetryPrompt(kind: CharacterExperienceArtifactKind, language: 'zh' | 'en') {
  const zh = language === 'zh';
  const label = KIND_LABELS[kind];
  if (zh) {
    return `${buildArtifactPrompt(kind, language)}\n\n上一次输出看起来像输入材料或 JSON。请重新写一段真正的${label}正文：不要输出 JSON，不要保留字段名，不要解释，不要复述输入结构，只写角色自己的内心文字。`;
  }
  return `${buildArtifactPrompt(kind, language)}\n\nThe previous output looked like source data or JSON. Rewrite it as the actual ${label} body only. Do not output JSON, field names, explanations, or the input structure.`;
}

async function generateArtifactFromContext(params: {
  config: APIConfig;
  kind: CharacterExperienceArtifactKind;
  context: CharacterExperienceArtifactContext;
  language: 'zh' | 'en';
}) {
  const serializedContext = JSON.stringify(params.context, null, 2);
  const first = normalizeGeneratedArtifactText(await generateResponse(
    params.config,
    buildArtifactPrompt(params.kind, params.language),
    [{ role: 'user', content: serializedContext }],
    undefined,
    { aiUsage: { type: 'character_artifact', label: '生成角色经历产物', scope: 'character' } },
  ));
  if (first && !looksLikeRawArtifactContext(first)) return first;

  const retry = normalizeGeneratedArtifactText(await generateResponse(
    params.config,
    buildArtifactRetryPrompt(params.kind, params.language),
    [{ role: 'user', content: serializedContext }],
    undefined,
    { aiUsage: { type: 'character_artifact', label: '重试生成角色经历产物', scope: 'character' } },
  ));
  if (retry && !looksLikeRawArtifactContext(retry)) return retry;

  return buildLocalCharacterExperienceArtifact(params.kind, params.context);
}

export async function generateCharacterExperienceArtifact(params: {
  config: APIConfig;
  kind: CharacterExperienceArtifactKind;
  character: Partial<AICharacter>;
  relatedCharacters?: Pick<AICharacter, 'id' | 'name'>[];
  language?: 'zh' | 'en';
}) {
  const context = params.kind === 'birth_letter'
    ? buildCharacterBirthLetterContext(params.character, params.relatedCharacters || [])
    : params.kind === 'final_letter'
      ? buildCharacterFinalLetterContext(params.character, params.relatedCharacters || [])
    : buildCharacterExperienceArtifactContext(params.character, params.relatedCharacters || []);
  return generateArtifactFromContext({
    config: params.config,
    kind: params.kind,
    context,
    language: params.language || 'zh',
  });
}

export async function generateCharacterDailyDiaryArtifact(params: {
  config: APIConfig;
  character: Partial<AICharacter>;
  relatedCharacters?: Pick<AICharacter, 'id' | 'name'>[];
  dateKey: string;
  recentDiaryTexts?: string[];
  language?: 'zh' | 'en';
}) {
  const context = buildCharacterDailyDiaryContext(params.character, params.relatedCharacters || [], params.dateKey, params.recentDiaryTexts || []);
  return generateArtifactFromContext({
    config: params.config,
    kind: 'diary',
    context,
    language: params.language || 'zh',
  });
}

/** Automatic diaries may be declined; a failed decision must never become a template entry. */
export async function decideCharacterDailyDiaryArtifact(params: Parameters<typeof generateCharacterDailyDiaryArtifact>[0]): Promise<string | null> {
  const context = buildCharacterDailyDiaryContext(params.character, params.relatedCharacters || [], params.dateKey, params.recentDiaryTexts || []);
  const prompt = params.language === 'en'
    ? 'Decide whether this date contains something this character would privately want to record: a concrete meaningful event, emotional change, unresolved concern, or new relationship insight. Ordinary chat, greetings, unchanged memories and a full calendar alone are insufficient. Silence is normal. Do not invent a reason to write. Return JSON only: {"write":false,"text":""} or {"write":true,"text":"first-person private diary"}. If writing, use specific grounded details and the character voice, avoid system fields and repetitive summaries. Optional seeds are suggestions, never evidence that something happened.'
    : '先判断这一天是否有角色自己想私下记住的点：具体而有意义的经历、情绪转折、未解的牵挂或新的关系认识。普通闲聊、问候、重复旧记忆、日期过去了，都不足以写日记。没有值得记的点就不写，这是正常结果，不要为了完成任务硬找意义或编造经历。只返回 JSON：{"write":false,"text":""} 或 {"write":true,"text":"角色第一人称的私密日记正文"}。写时依据具体细节和角色语气，避免流水账、鸡汤、重复总结，不暴露系统字段。输入中的可选心理种子只是写作建议，不代表事情真实发生过。';
  const raw = await generateResponse(params.config, prompt,
    [{ role: 'user', content: JSON.stringify(context) }], undefined,
    { responseFormat: 'json', aiUsage: { type: 'character_artifact', label: '判断是否值得写日记', scope: 'character' } });
  const decision: unknown = JSON.parse(unwrapMarkdownFence(raw));
  if (!decision || typeof decision !== 'object' || !('write' in decision) || typeof decision.write !== 'boolean') {
    throw new Error('日记生成未返回有效的写作判断。');
  }
  if (!decision.write) return null;
  if (!('text' in decision) || typeof decision.text !== 'string' || !decision.text.trim() || looksLikeRawArtifactContext(decision.text)) {
    throw new Error('日记判断通过，但没有返回有效正文。');
  }
  return decision.text.trim();
}
