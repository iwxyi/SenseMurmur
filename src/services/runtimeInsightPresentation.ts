import type { AICharacter } from '../types/character';
import type { DirectorIntent } from './directorIntent';
import type { NarrativeBeat, NarrativeLineProjection } from './narrativeProjection';
import type { RuntimePressureProjection } from './runtimeDecision';
import { sanitizeUserFacingText } from './displayTextSanitizer';

export interface PresentedRuntimeDirectorIntent {
  title: string;
  reason: string | null;
  targetNames: string[];
  debugChips: string[];
}

export interface PresentedRuntimeLine {
  id: string;
  kindLabel: string;
  statusLabel: string;
  title: string;
  summary: string;
  participantNames: string[];
  tone: 'conflict' | 'faction' | 'default';
  debugChips: string[];
  debugRows: string[];
  hiddenParticipantCount?: number;
}

export interface RuntimeInsightPresentation {
  directorIntent: PresentedRuntimeDirectorIntent | null;
  lines: PresentedRuntimeLine[];
}

function isChinese(language?: string) {
  return !language || language.startsWith('zh');
}

function percent(value: number | undefined) {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${Math.round(safeValue * 100)}%`;
}

function clip(text: string, max = 72) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function cleanPresentationText(text: string, members: AICharacter[]) {
  return sanitizeUserFacingText(text, members);
}

function sanitizeDebugId(id: string, members: AICharacter[]) {
  const normalized = id.replace(/\bdraft-[a-z0-9_-]+\b/gi, '线索');
  return cleanPresentationText(normalized, members);
}

export function formatNarrativeLineType(type: NarrativeLineProjection['type']) {
  const labels: Record<NarrativeLineProjection['type'], string> = {
    conflict: '矛盾线',
    relationship: '关系线',
    topic: '话题线',
    goal: '目标线',
    mystery: '暗线',
    faction: '阵营线',
    growth: '成长线',
    scenario: '场景线',
  };
  return labels[type] || type;
}

export function formatNarrativeLineStatus(status: NarrativeLineProjection['status']) {
  const labels: Record<NarrativeLineProjection['status'], string> = {
    latent: '潜伏',
    active: '活跃',
    escalating: '升温',
    cooling: '降温',
    resolved: '已解决',
    abandoned: '已搁置',
  };
  return labels[status] || status;
}

export function formatBeatType(type: NarrativeBeat['beatType']) {
  const labels: Record<NarrativeBeat['beatType'], string> = {
    answer: '回应',
    challenge: '挑战',
    defend: '维护',
    escalate: '升级',
    cool_down: '降温',
    reveal: '揭示',
    deflect: '转移',
    summarize: '收束',
    invite: '邀请',
  };
  return labels[type] || type;
}

export function formatDirectorSource(source: DirectorIntent['source']) {
  const labels: Record<DirectorIntent['source'], string> = {
    user_message: '用户干预',
    conversation_reply: '对话回应',
    narrative_line: '叙事线',
    conflict: '矛盾',
    relationship: '关系',
    faction: '阵营',
    growth: '成长',
    emotion: '情绪',
    topic: '话题',
    room_state: '房间态势',
  };
  return labels[source] || source;
}

export function formatKnownReason(reason: string) {
  const normalized = reason.trim();
  const known: Array<[RegExp, string]> = [
    [/director intervention/i, '用户导演干预正在影响下一轮走向。'],
    [/user explicitly mentioned/i, '用户明确提到了相关角色。'],
    [/user message should steer/i, '用户消息改变了当前讨论焦点。'],
    [/active conflict needs a response/i, '当前矛盾需要有人接话。'],
    [/relationship ledger has become salient/i, '关系账本中的变化已经足够显著。'],
    [/room state shows a pile-on target/i, '房间里出现了集中压力目标。'],
    [/topic drift is high/i, '当前话题漂移较高，需要有人收束。'],
    [/has become a salient faction pressure/i, '阵营靠拢已经形成可感知的压力。'],
    [/has a recent growth signal/i, '角色成长信号正在影响下一轮走向。'],
    [/hidden or private chat is creating mystery pressure/i, '未公开线索正在形成悬念压力。'],
    [/scenario structure is shaping/i, '当前场景结构正在影响下一步互动。'],
    [/continue the current live thread/i, '延续当前正在进行的话题。'],
    [/director goal is steering/i, '导演目标正在影响下一轮走向。'],
    [/addressed character has an unresolved reply expectation/i, '被点名的角色仍有待回应。'],
    [/character was addressed and should answer/i, '被点名的角色应先回应。'],
  ];
  const found = known.find(([pattern]) => pattern.test(normalized));
  if (found) return found[1];
  if (/^[\x00-\x7F]+$/.test(normalized) && /[a-z]/i.test(normalized)) return '已有运行证据支持这个走向。';
  return normalized;
}

function formatDebugMetric(label: 'pressure' | 'salience' | 'tension' | 'momentum', value: number | undefined, isZh: boolean) {
  const labels = {
    pressure: isZh ? '压力' : 'pressure',
    salience: isZh ? '显著性' : 'salience',
    tension: isZh ? '张力' : 'tension',
    momentum: isZh ? '动量' : 'momentum',
  };
  return `${labels[label]} ${percent(value)}`;
}

function formatLineId(id: string) {
  return id.replace(/->/g, '→');
}

function formatActorNames(ids: string[] | undefined, members: AICharacter[]) {
  if (!ids?.length) return [];
  return ids.map((id) => members.find((member) => member.id === id)?.name || '成员');
}

function buildDirectorPresentation(intent: DirectorIntent | null, members: AICharacter[], isZh: boolean): PresentedRuntimeDirectorIntent | null {
  if (!intent) return null;
  const targetNames = formatActorNames(intent.targetActorIds, members);
  return {
    title: `${formatDirectorSource(intent.source)} · ${formatBeatType(intent.beatType)}`,
    reason: intent.reason ? cleanPresentationText(formatKnownReason(intent.reason), members) : null,
    targetNames,
    debugChips: [
      formatDebugMetric('pressure', intent.pressure, isZh),
      intent.targetLineId
        ? `${isZh ? '线索' : 'line'} ${sanitizeDebugId(formatLineId(intent.targetLineId), members)}`
        : (isZh ? '线索 无' : 'line none'),
    ],
  };
}

function buildLinePresentation(line: NarrativeLineProjection, members: AICharacter[], summaryMax: number, isZh: boolean): PresentedRuntimeLine {
  const nextBeat = line.possibleNextBeats[0];
  const debugRows = [
    nextBeat ? `${isZh ? '可能走向' : 'likely direction'}: ${formatBeatType(nextBeat.beatType)} · ${percent(nextBeat.pressure)} · ${cleanPresentationText(formatKnownReason(nextBeat.reason), members)}` : '',
    line.openQuestions.length ? `${isZh ? '开放问题' : 'open question'}: ${line.openQuestions.slice(0, 2).map((item) => cleanPresentationText(item, members)).join(' / ')}` : '',
    isZh
      ? `调试ID: ${sanitizeDebugId(formatLineId(line.id), members)} · 来源事件 ${line.sourceEventIds.length}`
      : `id: ${sanitizeDebugId(formatLineId(line.id), members)} · source events ${line.sourceEventIds.length}`,
  ].filter(Boolean);
  if (line.type === 'mystery') {
    debugRows.push(isZh
      ? `隐藏参与者 ${line.hiddenParticipantIds?.length || 0}`
      : `hidden participants ${line.hiddenParticipantIds?.length || 0}`);
  }
  return {
    id: line.id,
    kindLabel: formatNarrativeLineType(line.type),
    statusLabel: formatNarrativeLineStatus(line.status),
    title: cleanPresentationText(line.title, members),
    summary: clip(cleanPresentationText(line.summary, members), summaryMax),
    participantNames: formatActorNames(line.participantIds, members),
    tone: line.type === 'conflict' ? 'conflict' : line.type === 'faction' ? 'faction' : 'default',
    debugChips: [
      formatDebugMetric('salience', line.salience, isZh),
      formatDebugMetric('tension', line.tension, isZh),
      formatDebugMetric('momentum', line.momentum, isZh),
    ],
    debugRows,
    hiddenParticipantCount: line.hiddenParticipantIds?.length || 0,
  };
}

export function buildRuntimeInsightPresentation(params: {
  projection: RuntimePressureProjection;
  members: AICharacter[];
  includeDebug: boolean;
  language?: string;
}): RuntimeInsightPresentation {
  const lineLimit = params.includeDebug ? 5 : 3;
  const isZh = isChinese(params.language);
  return {
    directorIntent: buildDirectorPresentation(params.projection.directorIntent, params.members, isZh),
    lines: params.projection.narrativeLines
      .slice(0, lineLimit)
      .map((line) => buildLinePresentation(line, params.members, params.includeDebug ? 120 : 72, isZh)),
  };
}
