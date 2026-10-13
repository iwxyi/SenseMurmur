import type { ConflictDevelopmentHook, ConflictNextPressure, ConflictType } from '../types/runtimeEvent';
import { sanitizeDistillationTexts } from './distillationText';

export interface RuntimeEventPayload {
  eventType: string;
  title: string;
  summary: string;
  pair?: [string, string];
  metrics?: unknown;
  timelineType?: 'note' | 'artifact' | 'relationship';
  visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public';
  visibleToIds?: string[];
  visibleToRoles?: string[];
  channelId?: string;
  causedByIntentId?: string;
  threadRef?: string;
  eventClass?: 'message' | 'action' | 'board' | 'phase' | 'score' | 'artifact';
  createdAt?: number;
  sourceMessageId?: string;
}

const conflictTypeLabels: Record<ConflictType, string> = {
  identity_ownership: '身份归属冲突',
  authority_challenge: '权威挑战',
  status_competition: '地位竞争',
  alliance_boundary: '联盟边界拉扯',
  care_jealousy: '关心 / 嫉妒张力',
  value_conflict: '价值观冲突',
  goal_conflict: '目标冲突',
  resource_conflict: '资源冲突',
  fairness_conflict: '公平性冲突',
  contradiction_exposure: '矛盾被戳穿',
  tone_escalation: '语气升级',
  misrecognition: '误解 / 误认',
};

const conflictPressureLabels: Record<ConflictNextPressure, string> = {
  escalate: '继续升级',
  spread: '扩散到更多人',
  stabilize: '稳住主线',
  divert: '转移走向',
  cool: '降温',
};

const conflictHookLabels: Record<ConflictDevelopmentHook, string> = {
  invite_target_response: '逼目标角色接话',
  force_side_taking: '逼旁观者站队',
  expose_contradiction: '继续戳穿矛盾',
  raise_stakes: '继续抬高代价',
  shift_public_private: '转向私下延伸',
  cool_down_with_residue: '表面降温但留下余波',
  redirect_topic: '借别人把话题带开',
  trigger_memory_recall: '勾起旧账/旧记忆',
};

function readConflictType(value: unknown) {
  return typeof value === 'string' && value in conflictTypeLabels ? conflictTypeLabels[value as ConflictType] : String(value || '');
}

function readConflictPressure(value: unknown) {
  return typeof value === 'string' && value in conflictPressureLabels ? conflictPressureLabels[value as ConflictNextPressure] : String(value || '');
}

function readConflictHooks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' && item in conflictHookLabels ? conflictHookLabels[item as ConflictDevelopmentHook] : String(item)).filter(Boolean);
}

function formatConflictMetrics(metrics: unknown) {
  if (!metrics || typeof metrics !== 'object') return '';
  const record = metrics as Record<string, unknown>;
  const lines = [
    record.type ? `类型：${readConflictType(record.type)}` : '',
    record.stage ? `阶段：${String(record.stage)}` : '',
    typeof record.severity === 'number' ? `强度：${record.severity.toFixed(2)}` : '',
    record.nextPressure ? `走向：${readConflictPressure(record.nextPressure)}` : '',
  ].filter(Boolean);
  const hooks = readConflictHooks(record.developmentHooks);
  if (hooks.length) lines.push(`建议：${hooks.join(' / ')}`);
  return lines.join('\n');
}

function formatRuntimeEventSummary(event: RuntimeEventPayload) {
  if (event.eventType !== 'conflict_focus_shift') return event.summary;
  return event.summary;
}

export function formatRuntimeEventForDisplay(payload: RuntimeEventPayload) {
  const event = normalizeRuntimeEvent(payload);
  return {
    ...event,
    title: event.eventType === 'conflict_focus_shift' ? '矛盾焦点变化' : event.title,
    summary: formatRuntimeEventSummary(event),
  };
}

export function formatRuntimeEventText(payload: RuntimeEventPayload) {
  const formatted = formatRuntimeEventForDisplay(payload);
  return formatted.summary || formatted.title;
}

export function formatConflictPromptText(type: unknown, nextPressure: unknown, hooks: unknown) {
  const parts = [
    type ? `- Type: ${readConflictType(type)}` : '',
    nextPressure ? `- Suggested pressure: ${readConflictPressure(nextPressure)}` : '',
  ].filter(Boolean);
  const hookLines = readConflictHooks(hooks);
  return `${parts.join('\n')}${hookLines.length ? `${parts.length ? '\n' : ''}- Development hooks:\n${hookLines.map((item) => `  - ${item}`).join('\n')}` : ''}`;
}

export function formatConflictPressureLabel(value: unknown) {
  return readConflictPressure(value);
}

export function formatConflictTypeLabel(value: unknown) {
  return readConflictType(value);
}

export function formatConflictHookLabels(value: unknown) {
  return readConflictHooks(value);
}

export function formatConflictStageLabel(value: unknown) {
  const map: Record<string, string> = {
    latent: '潜伏',
    emerging: '浮现',
    open: '公开化',
    escalating: '升级中',
    fragmented: '分裂扩散',
    cooling: '降温中',
    resolved: '已收束',
  };
  return typeof value === 'string' ? (map[value] || value) : String(value || '');
}

export function formatConflictMetricsForDisplay(metrics: unknown) {
  if (!metrics || typeof metrics !== 'object') return null;
  const record = metrics as Record<string, unknown>;
  return {
    type: formatConflictTypeLabel(record.type),
    stage: formatConflictStageLabel(record.stage),
    severity: typeof record.severity === 'number' ? record.severity.toFixed(2) : '',
    nextPressure: formatConflictPressureLabel(record.nextPressure),
    hooks: formatConflictHookLabels(record.developmentHooks),
  };
}

export { readConflictHooks, readConflictPressure, readConflictType };

function resolveCreatedAt(value: unknown, now?: number) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof now === 'number' && Number.isFinite(now)) return Math.round(now);
  return Date.now();
}

export function normalizeRuntimeEvent(payload: RuntimeEventPayload, options?: { now?: number }): RuntimeEventPayload {
  return {
    ...payload,
    timelineType: payload.timelineType || (payload.eventType === 'group_relationship_shift' || payload.eventType === 'relationship_shift' ? 'relationship' : 'note'),
    visibilityScope: payload.visibilityScope || 'public',
    visibleToIds: payload.visibleToIds || [],
    visibleToRoles: payload.visibleToRoles || [],
    createdAt: resolveCreatedAt(payload.createdAt, options?.now),
  };
}

export function buildRuntimeEvent(payload: RuntimeEventPayload) {
  return JSON.stringify(normalizeRuntimeEvent(payload));
}

function compactRuntimeEventMetricsForMessage(payload: RuntimeEventPayload) {
  if (!payload.metrics || typeof payload.metrics !== 'object') return payload.metrics;
  const metrics = payload.metrics as Record<string, unknown>;
  if (payload.eventType === 'memory_distillation') {
    const candidateTexts = Array.isArray(metrics.candidateTexts)
      ? sanitizeDistillationTexts(metrics.candidateTexts.filter((item): item is string => typeof item === 'string')).slice(0, 2)
      : [];
    return {
      ownerType: metrics.ownerType,
      ownerLabel: metrics.ownerLabel,
      ownerName: metrics.ownerName,
      reasonLabel: metrics.reasonLabel,
      sourceLabel: metrics.sourceLabel,
      mergeModeLabel: metrics.mergeModeLabel,
      newEvidenceCount: metrics.newEvidenceCount,
      candidateTexts,
    };
  }
  if (payload.eventType === 'memory_reactivation') {
    const matchedTokens = Array.isArray(metrics.matchedTokens)
      ? metrics.matchedTokens.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 8)
      : [];
    const recalledMemories = Array.isArray(metrics.recalledMemories)
      ? metrics.recalledMemories
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          id: typeof item.id === 'string' ? item.id : undefined,
          summary: typeof item.summary === 'string' ? item.summary : '',
          scope: typeof item.scope === 'string' ? item.scope : undefined,
          kind: typeof item.kind === 'string' ? item.kind : undefined,
          layer: typeof item.layer === 'string' ? item.layer : undefined,
          recallReason: typeof item.recallReason === 'string' ? item.recallReason : undefined,
          recallScore: typeof item.recallScore === 'number' ? item.recallScore : undefined,
          matchedTokens: Array.isArray(item.matchedTokens)
            ? item.matchedTokens.filter((token): token is string => typeof token === 'string' && Boolean(token.trim())).slice(0, 6)
            : [],
        }))
        .filter((item) => item.summary)
        .slice(0, 4)
      : [];
    return {
      characterId: typeof metrics.characterId === 'string' ? metrics.characterId : undefined,
      characterName: typeof metrics.characterName === 'string' ? metrics.characterName : undefined,
      matchedTokens,
      recalledMemories,
    };
  }
  if (payload.eventType === 'conflict_focus_shift' || payload.eventType === 'conflict_axis_shift') {
    const developmentHooks = Array.isArray(metrics.developmentHooks)
      ? metrics.developmentHooks.filter((item): item is string => typeof item === 'string').slice(0, 3)
      : [];
    return {
      type: metrics.type,
      stage: metrics.stage,
      severity: metrics.severity,
      nextPressure: metrics.nextPressure,
      developmentHooks,
    };
  }
  if (payload.eventType === 'local_interception') {
    return {
      kind: typeof metrics.kind === 'string' ? metrics.kind : undefined,
      speakerId: typeof metrics.speakerId === 'string' ? metrics.speakerId : undefined,
      speakerName: typeof metrics.speakerName === 'string' ? metrics.speakerName : undefined,
      reason: typeof metrics.reason === 'string' ? metrics.reason : undefined,
      attempt: typeof metrics.attempt === 'number' ? metrics.attempt : undefined,
    };
  }
  return undefined;
}

export function buildRuntimeEventMessageContent(payload: RuntimeEventPayload) {
  const event = normalizeRuntimeEvent(payload);
  return buildRuntimeEvent({
    eventType: event.eventType,
    title: event.title,
    summary: event.summary,
    pair: event.pair,
    metrics: compactRuntimeEventMetricsForMessage(event),
    timelineType: event.timelineType,
    visibilityScope: event.visibilityScope,
    visibleToIds: event.visibleToIds,
    visibleToRoles: event.visibleToRoles,
    channelId: event.channelId,
    causedByIntentId: event.causedByIntentId,
    threadRef: event.threadRef,
    eventClass: event.eventClass,
    createdAt: event.createdAt,
    sourceMessageId: event.sourceMessageId,
  });
}

export function parseRuntimeEvent(content: string): RuntimeEventPayload | null {
  try {
    return normalizeRuntimeEvent(JSON.parse(content) as RuntimeEventPayload);
  } catch {
    return null;
  }
}

export function describeRuntimeEvent(payload: RuntimeEventPayload) {
  const event = formatRuntimeEventForDisplay(payload);
  return [event.title, event.summary].filter(Boolean).join('：').slice(0, 120);
}

export function buildTimelineEntryFromRuntimeEvent(payload: RuntimeEventPayload, options?: { now?: number }) {
  const event = normalizeRuntimeEvent(payload, options);
  return {
    type: event.timelineType || 'note',
    text: describeRuntimeEvent(event),
    createdAt: resolveCreatedAt(event.createdAt, options?.now),
  };
}

export function buildRuntimeMemoryEntryFromEvent(payload: RuntimeEventPayload): { kind: 'note' | 'artifact'; text: string } | null {
  const event = normalizeRuntimeEvent(payload);
  if (event.eventType === 'world_state_shift') {
    return { kind: 'note', text: describeRuntimeEvent(event) };
  }
  return null;
}
