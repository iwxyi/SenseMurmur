import { Box, Chip, Typography } from '@mui/material';
import type { Message } from '../../types/message';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { DisplayTextMember } from '../../services/displayTextSanitizer';
import { buildConflictEventMeta, buildEventDisplayText, buildMemoryDistillationMeta, buildMemoryReactivationMeta } from './messageBubbleEventHelpers';
import { getRuntimeEventPayload, isConflictDeveloperEvent, shouldRenderEventMessage } from './eventMessagePresentation';

function getMetricsKind(metrics: unknown) {
  return metrics && typeof metrics === 'object' && 'kind' in metrics && typeof (metrics as { kind?: unknown }).kind === 'string'
    ? (metrics as { kind: string }).kind
    : '';
}

function buildEventTypeChip(payload: { eventType?: string; metrics?: unknown }) {
  if (payload.eventType === 'memory_distillation') return null;
  const eventType = payload.eventType || 'event';
  const metricsKind = getMetricsKind(payload.metrics);
  if (eventType === 'local_interception' && (
    metricsKind === 'analysis_artifacts_missing'
    || metricsKind === 'presence_metadata_missing'
    || metricsKind === 'surface_echo_warning'
    || metricsKind === 'surface_contract_warning'
    || metricsKind === 'streamed_draft_committed'
  )) {
    return <Chip size="small" label="提示" color="info" variant="outlined" />;
  }
  const config: Record<string, { label: string; color: 'primary' | 'secondary' | 'warning' | 'success' | 'info' | 'error' | 'default' }> = {
    group_relationship_shift: { label: '关系', color: 'secondary' },
    relationship_shift: { label: '关系', color: 'secondary' },
    speaker_drift_shift: { label: '行为', color: 'warning' },
    speaker_emotion_shift: { label: '情绪', color: 'success' },
    target_emotion_shift: { label: '情绪', color: 'success' },
    conflict_focus_shift: { label: '矛盾', color: 'error' },
    conflict_axis_shift: { label: '矛盾', color: 'error' },
    world_state_shift: { label: '态势', color: 'primary' },
    room_state_snapshot_v2: { label: '态势', color: 'primary' },
    analysis_run_policy: { label: '审议', color: 'info' },
    memory_distillation: { label: '蒸馏', color: 'info' },
    detailed_fact_recorded: { label: '事实', color: 'info' },
    memory_reactivation: { label: '回温', color: 'warning' },
    calendar_item_patch: { label: '日历', color: 'info' },
    calendar_patch_apply_result: { label: '日历', color: 'info' },
    calendar_activity: { label: '日历', color: 'info' },
    calendar_activity_started: { label: '日历', color: 'info' },
    calendar_activity_candidate: { label: '日历', color: 'info' },
    calendar_activity_updated: { label: '日历', color: 'info' },
    local_interception: { label: '拦截', color: 'warning' },
  };
  const item = config[eventType] || { label: '提示', color: 'default' as const };
  return <Chip size="small" label={item.label} color={item.color} variant="outlined" />;
}

function renderConflictEventMeta(payload: { metrics?: unknown }) {
  const metrics = buildConflictEventMeta(payload);
  if (!metrics) return null;
  const items = [
    metrics.type ? `类型：${metrics.type}` : '',
    metrics.stage ? `阶段：${metrics.stage}` : '',
    metrics.severity ? `强度：${metrics.severity}` : '',
    metrics.nextPressure ? `走向：${metrics.nextPressure}` : '',
  ].filter(Boolean);
  if (!items.length && !metrics.hooks.length) return null;
  return (
    <Box sx={{ mt: 0.75, display: 'grid', gap: 0.5 }}>
      {items.length ? <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{items.join(' · ')}</Typography> : null}
      {metrics.hooks.length ? <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{`建议：${metrics.hooks.join(' / ')}`}</Typography> : null}
    </Box>
  );
}

function renderMemoryDistillationMeta(payload: { metrics?: unknown }, members: DisplayTextMember[] = []) {
  const meta = buildMemoryDistillationMeta(payload, members);
  if (!meta) return null;
  return (
    <Box sx={{ mt: 0.75, display: 'grid', gap: 0.5 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{`证据事件 ${meta.evidenceCount} · 合并方式 ${meta.mergeModeLabel}`}</Typography>
      {meta.candidateTexts.length ? <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{meta.candidateTexts.join(' / ')}</Typography> : null}
    </Box>
  );
}

function renderMemoryReactivationMeta(payload: { metrics?: unknown }, members: DisplayTextMember[] = []) {
  const meta = buildMemoryReactivationMeta(payload, members);
  if (!meta) return null;
  return (
    <Box sx={{ mt: 0.75, display: 'grid', gap: 0.5 }}>
      {meta.matchedTokens.length ? <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{`命中词：${meta.matchedTokens.join(' / ')}`}</Typography> : null}
      {meta.recalledMemories.map((item, index) => (
        <Typography key={`${item.summary}-${index}`} variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {item.matchedTokens.length ? `${item.summary} · ${item.matchedTokens.join(' / ')}` : item.summary}
        </Typography>
      ))}
    </Box>
  );
}

export default function EventMessageItem({ message, members = [] }: { message: Message; members?: DisplayTextMember[] }) {
  const developerMode = useSettingsStore((state) => state.developerMode);
  const showMemoryDebug = useSettingsStore((state) => state.developerUI.showMemoryDebug);
  const showRelationshipEvents = useSettingsStore((state) => state.developerUI.showRelationshipEvents);
  const showAffectEvents = useSettingsStore((state) => state.developerUI.showAffectEvents);
  const showConflictEvents = useSettingsStore((state) => state.developerUI.showConflictEvents);
  const showStateEvents = useSettingsStore((state) => state.developerUI.showStateEvents);
  const showDetailedFactHints = useSettingsStore((state) => state.developerUI.showDetailedFactHints);
  const showMemoryDistillationEvents = useSettingsStore((state) => state.developerUI.showMemoryDistillationEvents);
  const showCalendarEvents = useSettingsStore((state) => state.developerUI.showCalendarEvents);
  const showLocalInterceptionHints = useSettingsStore((state) => state.developerUI.showLocalInterceptionHints);

  const flags = { developerMode, showRelationshipEvents, showAffectEvents, showConflictEvents, showStateEvents, showMemoryDistillationEvents, showDetailedFactHints, showCalendarEvents, showMemoryDebug, showLocalInterceptionHints };
  if (!shouldRenderEventMessage(message, flags)) return null;
  const payload: { eventType?: string; title?: string; summary?: string; pair?: string[]; metrics?: unknown } = getRuntimeEventPayload(message);

  return (
    <Box data-message-id={message.id} data-message-type="event" sx={{ display: 'flex', justifyContent: 'center', py: 0.5, px: { xs: 1, sm: 2 }, width: '100%', minWidth: 0, pointerEvents: 'none' }}>
      <Box sx={{
        maxWidth: 620,
        width: { xs: '100%', sm: 'fit-content' },
        minWidth: 0,
        px: { xs: 1.25, sm: 1.75 },
        py: 1,
        bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.70)' : 'rgba(20,22,30,0.72)',
        borderRadius: 2.25,
        border: '1px solid',
        borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
        boxShadow: (theme) => theme.palette.mode === 'light' ? '0 12px 28px rgba(15,23,42,0.055)' : '0 14px 32px rgba(0,0,0,0.24)',
        backdropFilter: 'blur(14px)',
        pointerEvents: 'none',
        overflow: 'hidden',
      }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1, mb: 0.25, minWidth: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
              {buildEventDisplayText(payload, members)}
            </Typography>
          </Box>
          {buildEventTypeChip(payload)}
        </Box>
        {isConflictDeveloperEvent(payload.eventType) ? renderConflictEventMeta(payload) : null}
        {payload.eventType === 'memory_distillation' ? renderMemoryDistillationMeta(payload, members) : null}
        {payload.eventType === 'memory_reactivation' ? renderMemoryReactivationMeta(payload, members) : null}
      </Box>
    </Box>
  );
}
