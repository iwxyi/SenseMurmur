import { formatConflictMetricsForDisplay, formatRuntimeEventText } from '../../services/runtimeEventFactory';
import { sanitizeDistillationTexts } from '../../services/distillationText';
import { sanitizeUserFacingText, type DisplayTextMember } from '../../services/displayTextSanitizer';
import { safeRuntimePrivateText } from '../../services/runtimePrivateTextPrivacy';

function cleanEventText(text: string | undefined | null, members: DisplayTextMember[] = [], fallback = '有一条私域事件内容已隐藏原文') {
  return sanitizeUserFacingText(safeRuntimePrivateText(text, fallback), members);
}

function dedupeDisplayText(text: string, members: DisplayTextMember[] = [], fallback = '有一条私域事件内容已隐藏原文') {
  return cleanEventText(text.replace(/^房间态势更新：/g, '').trim(), members, fallback);
}

function readMetrics(metrics: unknown) {
  return metrics && typeof metrics === 'object' ? metrics as Record<string, unknown> : null;
}

function isMemoryDistillationEvent(metrics: unknown) {
  return typeof metrics === 'object' && metrics !== null && 'ownerType' in metrics && 'candidateTexts' in metrics;
}

function buildMemoryDistillationSourcePrefix(metrics: Record<string, unknown> | null) {
  const sourceLabel = typeof metrics?.sourceLabel === 'string' ? metrics.sourceLabel : '';
  const reasonLabel = typeof metrics?.reasonLabel === 'string' ? metrics.reasonLabel : '';
  const sourceText = `${sourceLabel} ${reasonLabel}`;
  if (/llm/i.test(sourceText)) return 'LLM';
  return '本地';
}

function buildMemoryDistillationOwnerSuffix(metrics: Record<string, unknown> | null, members: DisplayTextMember[] = []) {
  if (!metrics) return '';
  const ownerLabel = typeof metrics.ownerLabel === 'string' ? metrics.ownerLabel : '';
  const isCharacterOwner = metrics?.ownerType === 'character' || ownerLabel.startsWith('角色：');
  if (!isCharacterOwner) return '';
  const ownerName = typeof metrics.ownerName === 'string' ? metrics.ownerName : '';
  const value = ownerName || ownerLabel.replace(/^角色：/, '').trim();
  const label = sanitizeUserFacingText(value, members);
  return label ? ` · ${label}` : '';
}

function formatMemoryDistillationMergeLabel(value: unknown, members: DisplayTextMember[] = []) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const labels: Record<string, string> = {
    reinforce_same_bucket: '同类证据强化',
    bucket_reinforce: '同类证据强化',
    revise_existing: '修订已有记忆',
    merge_related: '合并相关记忆',
    append_new: '新增记忆',
    '同 bucket 强化合并': '同类证据强化合并',
    '同 bucket 强化': '同类证据强化',
  };
  if (!raw) return '同类证据强化合并';
  return labels[raw] || sanitizeUserFacingText(raw, members).replace(/bucket/gi, '同类证据');
}

export function buildEventDisplayText(payload: { eventType?: string; title?: string; summary?: string; pair?: string[]; metrics?: unknown }, members: DisplayTextMember[] = []) {
  if (payload.eventType === 'detailed_fact_recorded') {
    const lines = (payload.summary || payload.title || '').split('\n').map((line) => safeRuntimePrivateText(line));
    return sanitizeUserFacingText(lines.join('\n'), members, { preserveLineBreaks: true });
  }
  if (payload.eventType === 'room_state_snapshot_v2') return dedupeDisplayText(payload.summary || '', members);
  if (payload.eventType === 'conflict_axis_shift') return dedupeDisplayText(payload.summary || '', members);
  if (payload.eventType === 'memory_reactivation') return dedupeDisplayText(payload.summary || payload.title || '旧记忆回温', members, '有一条私域记忆回温已隐藏原文');
  if (payload.eventType === 'memory_distillation') {
    const metrics = readMetrics(payload.metrics);
    const ownerLabel = typeof metrics?.ownerLabel === 'string' ? metrics.ownerLabel : '';
    const ownerType = metrics?.ownerType === 'chat' || ownerLabel.startsWith('群聊：') ? '群聊' : '角色';
    return `${buildMemoryDistillationSourcePrefix(metrics)}${ownerType}蒸馏${buildMemoryDistillationOwnerSuffix(metrics, members)}`;
  }
  return dedupeDisplayText(formatRuntimeEventText({
    eventType: payload.eventType || 'event',
    title: payload.title || '事件',
    summary: payload.summary || '',
    pair: payload.pair as [string, string] | undefined,
    metrics: payload.metrics,
  }), members);
}

export function buildMemoryDistillationMeta(payload: { metrics?: unknown }, members: DisplayTextMember[] = []) {
  if (!isMemoryDistillationEvent(payload.metrics)) return null;
  const metrics = readMetrics(payload.metrics);
  if (!metrics) return null;
  const mergeModeLabel = formatMemoryDistillationMergeLabel(metrics.mergeModeLabel || metrics.mergeMode, members);
  const evidenceCount = typeof metrics.newEvidenceCount === 'number' ? metrics.newEvidenceCount : 0;
  const candidateTexts = Array.isArray(metrics.candidateTexts)
    ? sanitizeDistillationTexts(metrics.candidateTexts
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .map((text) => cleanEventText(text, members, '有一条私域蒸馏候选已隐藏原文'))).slice(0, 2)
      .filter(Boolean)
    : [];
  return {
    mergeModeLabel,
    evidenceCount,
    candidateTexts: candidateTexts.slice(0, 1),
  };
}

export function buildMemoryReactivationMeta(payload: { metrics?: unknown }, members: DisplayTextMember[] = []) {
  const metrics = readMetrics(payload.metrics);
  if (!metrics) return null;
  const matchedTokens = Array.isArray(metrics.matchedTokens)
    ? metrics.matchedTokens
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .map((value) => cleanEventText(value, members, '有一条私域命中词已隐藏原文'))
      .filter(Boolean)
      .slice(0, 8)
    : [];
  const recalledMemories = Array.isArray(metrics.recalledMemories)
    ? metrics.recalledMemories
      .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
      .map((item) => ({
        summary: cleanEventText(String(item.summary || ''), members, '有一条私域回温记忆已隐藏原文'),
        matchedTokens: Array.isArray(item.matchedTokens)
          ? item.matchedTokens
            .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
            .map((value) => cleanEventText(value, members, '有一条私域命中词已隐藏原文'))
            .filter(Boolean)
            .slice(0, 4)
          : [],
      }))
      .filter((item) => item.summary)
      .slice(0, 2)
    : [];
  if (!matchedTokens.length && !recalledMemories.length) return null;
  return { matchedTokens, recalledMemories };
}

export function shouldHideEmptyConflictEvent(payload: { eventType?: string; summary?: string; metrics?: unknown }) {
  if (payload.eventType !== 'conflict_focus_shift' && payload.eventType !== 'conflict_axis_shift') return false;
  const metrics = readMetrics(payload.metrics);
  const hasSummary = Boolean(payload.summary?.trim());
  const hasMeaningfulMetrics = Boolean(
    metrics?.type
      || metrics?.stage
      || metrics?.nextPressure
      || (Array.isArray(metrics?.developmentHooks) && (metrics.developmentHooks as unknown[]).some((item) => typeof item === 'string' && item.trim()))
  );
  return !hasSummary && !hasMeaningfulMetrics;
}

export function buildConflictEventMeta(payload: { metrics?: unknown }) {
  return formatConflictMetricsForDisplay(payload.metrics);
}
