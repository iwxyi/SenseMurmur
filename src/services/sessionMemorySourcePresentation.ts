import type { AICharacter } from '../types/character';
import type { ChatStyle, GroupChat, RuntimeEvolutionIntensity } from '../types/chat';
import type { ConflictFocusState } from '../types/runtimeEvent';
import {
  formatConflictHookLabels,
  formatConflictPressureLabel,
  formatConflictStageLabel,
  formatConflictTypeLabel,
} from './runtimeEventFactory';
import { classifyRuntimeArtifactSeedLine } from './runtimeSeed';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';

const STYLE_LABELS: Partial<Record<ChatStyle, string>> = {
  free: '自由聊天',
  debate: '辩论',
  brainstorm: '头脑风暴',
  roleplay: '角色扮演',
};

export type SessionMemoryConflictFilter = 'all' | 'active' | 'axis' | 'history';

export interface SessionMemoryConflictItem {
  id: string;
  category: Exclude<SessionMemoryConflictFilter, 'all'>;
  summary: string;
  meta: string;
  tooltip: string;
}

export interface SessionMemoryRelationshipItem {
  key: string;
  title: string;
  body: string;
  detail: string;
  evidence: string;
}

export interface SessionMemorySourcePresentation {
  layeredMemoryItems: NonNullable<GroupChat['layeredMemories']>;
  sourceSummary: string;
  sourceTooltip: string;
  conflict: {
    items: SessionMemoryConflictItem[];
    counts: {
      active: number;
      axes: number;
      history: number;
    };
    summary: string;
    chips: Array<{ value: SessionMemoryConflictFilter; label: string; count: number }>;
  };
  relationships: {
    items: SessionMemoryRelationshipItem[];
    summary: string;
  };
  artifacts: {
    valid: string[];
    suspicious: string[];
  };
}

export interface BuildSessionMemorySourcePresentationParams {
  chat: Pick<GroupChat, 'runtimeEventsV2' | 'relationshipLedger' | 'layeredMemories'> & {
    conflictAxes?: GroupChat['worldState']['conflictAxes'];
    conflictState?: GroupChat['worldState']['conflictState'];
  };
  members: AICharacter[];
  name: string;
  topic: string;
  style: ChatStyle;
  runtimeEvolutionIntensity: RuntimeEvolutionIntensity;
  memberCount: number;
  seedArtifactText: string;
  runtimeLabels?: {
    phase?: string;
    mood?: string;
    focus?: string;
    recentEvent?: string;
    createdAt?: number;
    updatedAt?: number;
    lastMessageAt?: number;
  };
  includeDebug: boolean;
}

function formatDateTime(value?: number) {
  if (!value) return '无';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function runtimeIntensityLabel(value: RuntimeEvolutionIntensity) {
  return value === 'slow' ? '慢' : value === 'fast' ? '快' : '平衡';
}

function isLikelyInternalId(value: string) {
  return /^[0-9a-f-]{18,}$/i.test(value) || /^draft-\d+$/i.test(value);
}

function buildDisplayMembers(characters: AICharacter[]): DisplayTextMember[] {
  return characters.map((character) => ({ id: character.id, name: character.name }));
}

function cleanRuntimeText(text: string | undefined, members: DisplayTextMember[]) {
  return sanitizeUserFacingText(String(text || '').trim(), members);
}

function resolveName(id: string | undefined, characters: AICharacter[]) {
  if (!id) return '未设置';
  if (id === 'user') return '我';
  const matched = characters.find((character) => character.id === id)?.name;
  if (matched) return matched;
  return isLikelyInternalId(id) ? '未知成员' : id;
}

function clampDisplayMetric(value: number | undefined) {
  const safe = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.round(Math.max(-100, Math.min(100, safe)));
}

function formatAxisBias(value: number | undefined) {
  const score = clampDisplayMetric(value);
  return Math.abs(score) >= 60 ? '强' : Math.abs(score) >= 32 ? '中' : '弱';
}

function formatRelationshipDimension(label: string, value: number | undefined, threshold = 8) {
  const score = clampDisplayMetric(value);
  if (Math.abs(score) < threshold) return null;
  if (score < 0) {
    const negativeLevel = Math.abs(score) >= 60 ? '很低' : Math.abs(score) >= 32 ? '偏低' : '略低';
    return `${label}${negativeLevel}（${score}）`;
  }
  const level = Math.abs(score) >= 60 ? '很高' : Math.abs(score) >= 32 ? '偏高' : '略高';
  return `${label}${level}（${score}）`;
}

function summarizeLifecycleTitle(labels: NonNullable<BuildSessionMemorySourcePresentationParams['runtimeLabels']>) {
  return [
    `创建 ${formatDateTime(labels.createdAt)}`,
    `更新 ${formatDateTime(labels.updatedAt)}`,
    `最后消息 ${formatDateTime(labels.lastMessageAt)}`,
  ].join(' / ');
}

function buildAxisEvidence(axis: NonNullable<GroupChat['worldState']['conflictAxes']>[number], members: DisplayTextMember[]) {
  const left = cleanRuntimeText(axis.poles[0], members);
  const right = cleanRuntimeText(axis.poles[1], members);
  return [
    `轴配置：${left} vs ${right}。保存值不证明实际立场、联盟或冲突进展。`,
    '当前冲突以有来源的冲突记录和可见发言为准。',
  ].join('\n');
}

function buildConflictEvidence(conflict: ConflictFocusState, characters: AICharacter[]) {
  const participants = conflict.participantIds.map((id) => resolveName(id, characters)).join('、');
  const hooks = conflict.developmentHooks.length ? `建议：${formatConflictHookLabels(conflict.developmentHooks).join(' / ')}` : '';
  return [participants ? `参与者：${participants}` : '', hooks, conflict.sourceEventIds.length ? `已参考 ${conflict.sourceEventIds.length} 条近期变化` : ''].filter(Boolean).join('\n');
}

function buildConflictItems(params: BuildSessionMemorySourcePresentationParams, members: DisplayTextMember[]) {
  const directConflicts = [
    params.chat.conflictState?.primaryConflict,
    ...(params.chat.conflictState?.activeConflicts || []),
  ].filter((item): item is ConflictFocusState => Boolean(item));
  const unique = new Map<string, ConflictFocusState>();
  directConflicts.forEach((item) => unique.set(item.id, item));

  const eventConflicts: SessionMemoryConflictItem[] = (params.chat.runtimeEventsV2 || [])
    .filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload?.eventType === 'conflict_focus_shift' || event.summary.includes('矛盾') || event.summary.includes('冲突');
    })
    .slice(-4)
    .reverse()
    .map((event) => ({
      id: event.id,
      category: 'history',
      summary: cleanRuntimeText(event.summary, members),
      meta: '历史冲突事件',
      tooltip: cleanRuntimeText(event.summary, members),
    }));

  const axisConflicts: SessionMemoryConflictItem[] = (params.chat.conflictAxes || [])
    .filter((axis) => Math.abs(axis.currentTilt || 0) >= 12)
    .slice(0, 4)
    .map((axis, index) => {
      const favoredPole = (axis.currentTilt || 0) > 0 ? axis.poles[0] : axis.poles[1];
      const meta = params.includeDebug
        ? `轴配置 / 保存偏向：${cleanRuntimeText(favoredPole, members)} / 幅度 ${formatAxisBias(axis.currentTilt)}`
        : '轴配置';
      return {
        id: `axis-${index}`,
        category: 'axis',
        summary: cleanRuntimeText(axis.title, members),
        meta,
        tooltip: buildAxisEvidence(axis, members),
      };
    });

  const activeItems: SessionMemoryConflictItem[] = Array.from(unique.values()).map((conflict) => ({
    id: conflict.id,
    category: 'active',
    summary: cleanRuntimeText(conflict.summary, members),
    meta: params.includeDebug
      ? `活跃矛盾 / ${formatConflictTypeLabel(conflict.type)} / ${formatConflictStageLabel(conflict.stage)} / ${formatConflictPressureLabel(conflict.nextPressure)} / 强度 ${Math.round(conflict.severity * 100)}%`
      : `活跃矛盾 / ${formatConflictStageLabel(conflict.stage)} / ${formatConflictPressureLabel(conflict.nextPressure)}`,
    tooltip: buildConflictEvidence(conflict, params.members),
  }));

  return {
    items: [...activeItems, ...axisConflicts, ...eventConflicts],
    counts: {
      active: unique.size,
      axes: axisConflicts.length,
      history: eventConflicts.length,
    },
  };
}

function latestRelationshipEvidence(item: NonNullable<GroupChat['relationshipLedger']>[number], members: DisplayTextMember[]) {
  const axisEvidence = Object.values(item.axisReasons || {}).flat().slice(-1)[0];
  const recentEvent = item.recentEvents?.at(-1);
  return cleanRuntimeText(axisEvidence?.evidence || recentEvent?.summary || '', members);
}

function buildRelationshipLine(item: NonNullable<GroupChat['relationshipLedger']>[number], characters: AICharacter[], members: DisplayTextMember[]): SessionMemoryRelationshipItem {
  const semantic = cleanRuntimeText(item.derived?.semantic?.summary || '', members);
  const dimensions = [
    formatRelationshipDimension('信任', item.current.trust),
    formatRelationshipDimension('威胁感', item.current.threat, 12),
    formatRelationshipDimension('亲和', item.current.warmth),
    formatRelationshipDimension('能力判断', item.current.competence),
  ].filter(Boolean);
  return {
    key: item.pairKey,
    title: `${resolveName(item.actorId, characters)} -> ${resolveName(item.targetId, characters)}`,
    body: semantic,
    detail: dimensions.join(' / '),
    evidence: latestRelationshipEvidence(item, members),
  };
}

function buildArtifactProjection(seedArtifactText: string, members: DisplayTextMember[]) {
  const artifacts = seedArtifactText.split('\n').map((item) => cleanRuntimeText(item.trim(), members)).filter(Boolean);
  const classified = artifacts.map((item) => classifyRuntimeArtifactSeedLine(item));
  return {
    valid: classified.filter((item) => item.valid).map((item) => item.text),
    suspicious: classified.filter((item) => !item.valid).map((item) => item.text),
  };
}

function buildSourceTooltip(params: BuildSessionMemorySourcePresentationParams, styleLabel: string, members: DisplayTextMember[]) {
  const labels = params.runtimeLabels || {};
  const cleanMood = cleanRuntimeText(labels.mood, members) || '未设置';
  const cleanFocus = cleanRuntimeText(labels.focus, members) || '未设置';
  return [
    `会话：${params.name || '未命名'} / ${styleLabel}`,
    `主题：${params.topic || '未设置'}`,
    `成员：${params.memberCount} 人`,
    `变化强度：${runtimeIntensityLabel(params.runtimeEvolutionIntensity)}`,
    params.includeDebug ? `阶段：${labels.phase || '未设置'} / 气氛：${cleanMood} / 焦点：${cleanFocus}` : '',
    params.includeDebug ? `最近事件：${cleanRuntimeText(labels.recentEvent, members)}` : '',
    params.includeDebug ? summarizeLifecycleTitle(labels) : '',
  ].filter(Boolean).join('\n');
}

export function buildSessionMemorySourcePresentation(params: BuildSessionMemorySourcePresentationParams): SessionMemorySourcePresentation {
  const members = buildDisplayMembers(params.members);
  const styleLabel = STYLE_LABELS[params.style] || '自定义风格';
  const conflict = buildConflictItems(params, members);
  const relationshipItems = (params.chat.relationshipLedger || [])
    .slice()
    .sort((left, right) => (right.derived?.salience || 0) - (left.derived?.salience || 0))
    .slice(0, 4)
    .map((item) => buildRelationshipLine(item, params.members, members));
  const chips: SessionMemorySourcePresentation['conflict']['chips'] = [
    { value: 'all', label: '全部', count: conflict.items.length },
    { value: 'active', label: '活跃矛盾', count: conflict.counts.active },
    { value: 'axis', label: '长期张力', count: conflict.counts.axes },
    { value: 'history', label: '历史冲突', count: conflict.counts.history },
  ];

  return {
    layeredMemoryItems: (params.chat.layeredMemories || []).slice().reverse(),
    sourceSummary: `${styleLabel} · ${params.memberCount} 名成员 · 变化${runtimeIntensityLabel(params.runtimeEvolutionIntensity)}`,
    sourceTooltip: buildSourceTooltip(params, styleLabel, members),
    conflict: {
      ...conflict,
      summary: `活跃 ${conflict.counts.active} / 张力 ${conflict.counts.axes} / 历史 ${conflict.counts.history}`,
      chips,
    },
    relationships: {
      items: relationshipItems,
      summary: `关系 ${relationshipItems.length} 条`,
    },
    artifacts: buildArtifactProjection(params.seedArtifactText, members),
  };
}
