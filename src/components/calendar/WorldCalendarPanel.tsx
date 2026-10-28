import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Chip, FormControl, MenuItem, Select, Stack, Typography } from '@mui/material';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import PlaceIcon from '@mui/icons-material/Place';
import ScheduleIcon from '@mui/icons-material/Schedule';
import GroupsIcon from '@mui/icons-material/Groups';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import type { GroupChat } from '../../types/chat';
import type { AICharacter } from '../../types/character';
import type { WorldCalendarItem } from '../../services/worldRuntimeProjection';
import EmptyState from '../common/EmptyState';
import AppSnackbar from '../common/AppSnackbar';
import SurfaceCard from '../common/SurfaceCard';
import { projectWorldCalendar } from '../../services/worldRuntimeProjection';
import { buildWorldCalendarPatchApplyPlan } from '../../services/worldCalendarPatchPlanner';
import { applyWorldCalendarPatchDraftQueue } from '../../services/worldCalendarPatchApply';
import { summarizeParticipantStateCounts } from '../../services/worldCalendarPresentation';
import { useSettingsStore } from '../../stores/useSettingsStore';
import {
  filterAndSortCalendarItems,
  groupCalendarItemsByDay,
  startOfDay,
  type CalendarKindFilter,
  type CalendarStatusFilter,
} from '../../services/worldCalendarViewModel';
import { buildInteractiveSurfaceSx, compactPillChipSx } from '../../styles/interaction';
import BaseCalendar from './BaseCalendar';
import ManualCalendarEventDialog from './ManualCalendarEventDialog';
import type { RuntimeEventV2 } from '../../types/runtimeEvent';
import { generateId } from '../../utils/id';

const calendarFilterChipSx = {
  ...compactPillChipSx,
  height: 30,
  fontSize: 12,
  '& .MuiChip-label': { px: 1.2, lineHeight: '30px' },
};

const calendarMetaChipSx = {
  ...compactPillChipSx,
  height: 24,
  maxWidth: '100%',
  '& .MuiChip-label': {
    px: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

function toLocalDayKey(date: Date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function isLocalMidnight(date: Date) {
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
}

function formatClock(date: Date, isZh: boolean) {
  return date.toLocaleTimeString(isZh ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: !isZh,
  });
}

function formatCompactDate(date: Date, isZh: boolean) {
  if (isZh) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatMonthDay(date: Date, isZh: boolean) {
  if (isZh) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCompactDateTime(date: Date, isZh: boolean, includeYear = true) {
  return `${includeYear ? formatCompactDate(date, isZh) : formatMonthDay(date, isZh)} ${formatClock(date, isZh)}`;
}

function formatAllDayRange(start: Date, end: Date, isZh: boolean) {
  const inclusiveEnd = new Date(end.getTime() - 1);
  if (toLocalDayKey(start) === toLocalDayKey(inclusiveEnd)) return isZh ? `${formatCompactDate(start, isZh)} 全天` : `${formatCompactDate(start, isZh)} · All day`;
  const sameYear = start.getFullYear() === inclusiveEnd.getFullYear();
  return isZh
    ? `${formatCompactDate(start, isZh)} - ${sameYear ? formatMonthDay(inclusiveEnd, isZh) : formatCompactDate(inclusiveEnd, isZh)} 全天`
    : `${formatCompactDate(start, isZh)} - ${sameYear ? formatMonthDay(inclusiveEnd, isZh) : formatCompactDate(inclusiveEnd, isZh)} · All day`;
}

function formatDayTitle(timestamp: number, isZh: boolean) {
  const day = new Date(startOfDay(timestamp));
  const today = startOfDay(Date.now());
  const diffDays = Math.round((startOfDay(timestamp) - today) / 86400000);
  if (isZh) {
    if (diffDays === 0) return `今天 · ${day.toLocaleDateString()}`;
    if (diffDays === 1) return `明天 · ${day.toLocaleDateString()}`;
    if (diffDays === -1) return `昨天 · ${day.toLocaleDateString()}`;
    return day.toLocaleDateString();
  }
  if (diffDays === 0) return `Today · ${day.toLocaleDateString()}`;
  if (diffDays === 1) return `Tomorrow · ${day.toLocaleDateString()}`;
  if (diffDays === -1) return `Yesterday · ${day.toLocaleDateString()}`;
  return day.toLocaleDateString();
}

function formatScheduleHint(item: { startAt?: number | null; endAt?: number | null; durationMinutes?: number | null; timeHint?: string | null }, isZh: boolean) {
  const hasStart = typeof item.startAt === 'number';
  const resolvedEndAt = typeof item.endAt === 'number'
    ? item.endAt
    : hasStart && typeof item.durationMinutes === 'number' && item.durationMinutes > 0
      ? (item.startAt as number) + item.durationMinutes * 60_000
      : null;
  const hasEnd = typeof resolvedEndAt === 'number';
  const hasDuration = typeof item.durationMinutes === 'number' && item.durationMinutes > 0;
  if (hasStart && hasEnd) {
    const start = new Date(item.startAt as number);
    const end = new Date(resolvedEndAt as number);
    const sameDay = toLocalDayKey(start) === toLocalDayKey(end);
    const allDay = isLocalMidnight(start) && isLocalMidnight(end) && end.getTime() > start.getTime() && (end.getTime() - start.getTime()) % 86400000 === 0;
    if (allDay) return formatAllDayRange(start, end, isZh);
    if (sameDay) return `${formatCompactDateTime(start, isZh)} - ${formatClock(end, isZh)}`;
    return `${formatCompactDateTime(start, isZh)} - ${formatCompactDateTime(end, isZh, start.getFullYear() !== end.getFullYear())}`;
  }
  if (hasStart && hasDuration) return isZh ? `${formatCompactDateTime(new Date(item.startAt as number), isZh)}（约${item.durationMinutes}分钟）` : `${formatCompactDateTime(new Date(item.startAt as number), isZh)} (~${item.durationMinutes} min)`;
  if (hasStart) return formatCompactDateTime(new Date(item.startAt as number), isZh);
  return item.timeHint || null;
}

function normalizeDisplayText(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isLikelyStructuredScheduleText(value: string, isZh: boolean) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isZh) {
    return /(\d{4}年)?\d{1,2}月\d{1,2}日/.test(trimmed)
      || /\d{1,2}:\d{2}/.test(trimmed)
      || trimmed === '全天';
  }
  return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(trimmed)
    || /\b\d{1,2}:\d{2}\b/.test(trimmed)
    || /\b(?:am|pm)\b/i.test(trimmed)
    || /^all day$/i.test(trimmed);
}

function buildListSummary(item: WorldCalendarItem, scheduleHint: string | null, isZh: boolean) {
  const summary = item.summary.trim();
  if (!summary) return null;
  const titleKey = normalizeDisplayText(item.title);
  const scheduleKey = scheduleHint ? normalizeDisplayText(scheduleHint) : '';
  const locationKey = item.locationHint ? normalizeDisplayText(item.locationHint) : '';
  const participantKey = item.participantNames.length ? normalizeDisplayText(item.participantNames.join(isZh ? '、' : ', ')) : '';
  const filteredParts = summary
    .split(/\s*[·•]\s*/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const key = normalizeDisplayText(part);
      if (!key || key === titleKey || key === scheduleKey || key === locationKey || key === participantKey) return false;
      if (scheduleHint && isLikelyStructuredScheduleText(part, isZh)) return false;
      if (isZh && (/^角色[:：]/.test(part) || /^地点[:：]/.test(part) || part === '全天')) return false;
      if (!isZh && (/^characters?:/i.test(part) || /^location:/i.test(part) || /^all day$/i.test(part))) return false;
      return true;
    });
  const cleaned = filteredParts.join(' · ').trim();
  if (!cleaned || normalizeDisplayText(cleaned) === titleKey) return null;
  return cleaned;
}

function getCalendarStatusMeta(status: WorldCalendarItem['status'], isZh: boolean) {
  const zh: Record<WorldCalendarItem['status'], string> = {
    tentative: '待确认',
    planned: '已计划',
    confirmed: '已确认',
    in_progress: '进行中',
    completed: '已完成',
    cancelled: '已取消',
  };
  const en: Record<WorldCalendarItem['status'], string> = {
    tentative: 'Tentative',
    planned: 'Planned',
    confirmed: 'Confirmed',
    in_progress: 'In progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  const color: 'default' | 'primary' | 'success' | 'warning' = status === 'confirmed'
    ? 'primary'
    : status === 'completed'
      ? 'success'
      : status === 'cancelled'
        ? 'warning'
        : 'default';
  return { label: isZh ? zh[status] : en[status], color };
}

function getCalendarKindDotColor(kind: WorldCalendarItem['kind']) {
  if (kind === 'travel') return 'info.main';
  if (kind === 'reminder') return 'warning.main';
  if (kind === 'blocked_time') return 'error.main';
  if (kind === 'rest') return 'success.main';
  if (kind === 'preparation') return 'secondary.main';
  return 'primary.main';
}

function formatRelativeLifecycleTime(timestamp: number, now: number, isZh: boolean) {
  const diffMs = now - timestamp;
  const absMinutes = Math.max(1, Math.round(Math.abs(diffMs) / 60_000));
  if (absMinutes < 60) {
    return diffMs >= 0
      ? (isZh ? `${absMinutes} 分钟前` : `${absMinutes} min ago`)
      : (isZh ? `${absMinutes} 分钟后` : `in ${absMinutes} min`);
  }
  const absHours = Math.round(absMinutes / 60);
  if (absHours < 48) {
    return diffMs >= 0
      ? (isZh ? `${absHours} 小时前` : `${absHours} hr ago`)
      : (isZh ? `${absHours} 小时后` : `in ${absHours} hr`);
  }
  return formatCompactDateTime(new Date(timestamp), isZh);
}

function buildCalendarLifecycleDebugRows(items: WorldCalendarItem[], now: number, isZh: boolean) {
  return items
    .flatMap((item) => {
      const rows: Array<{ key: string; tone: 'primary' | 'success'; label: string; text: string; at: number }> = [];
      if (item.status === 'in_progress' && typeof item.startAt === 'number') {
        rows.push({
          key: `${item.id}:started`,
          tone: 'primary',
          label: isZh ? '开始' : 'Started',
          text: `${item.title} · ${formatRelativeLifecycleTime(item.startAt, now, isZh)}`,
          at: item.startAt,
        });
      }
      if (item.status === 'completed' && typeof item.endAt === 'number' && now - item.endAt <= 72 * 60 * 60_000) {
        rows.push({
          key: `${item.id}:ended`,
          tone: 'success',
          label: isZh ? '结束' : 'Ended',
          text: `${item.title} · ${formatRelativeLifecycleTime(item.endAt, now, isZh)}`,
          at: item.endAt,
        });
      }
      return rows;
    })
    .sort((left, right) => right.at - left.at)
    .slice(0, 5);
}

interface WorldCalendarPanelProps {
  chats: GroupChat[];
  characters: AICharacter[];
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  isZh: boolean;
  conversationId?: string | null;
  actorId?: string | null;
  compact?: boolean;
  title?: string;
  subtitle?: string;
  showHeader?: boolean;
}

export default function WorldCalendarPanel({
  chats,
  characters,
  updateChat,
  isZh,
  conversationId,
  actorId,
  compact = false,
  title,
  subtitle,
  showHeader = true,
}: WorldCalendarPanelProps) {
  const isGlobalCalendarPage = !compact && !conversationId && !actorId;
  const [kindFilter, setKindFilter] = useState<CalendarKindFilter>('all');
  const [statusFilter, setStatusFilter] = useState<CalendarStatusFilter>('all');
  const [isCalendarExpanded, setIsCalendarExpanded] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const userAdjustedCalendarRef = useRef(false);
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [isApplyingPatchQueue, setIsApplyingPatchQueue] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });
  const developerMode = useSettingsStore((state) => state.developerMode);
  const showCalendarEvents = useSettingsStore((state) => state.developerUI.showCalendarEvents);
  const [temporalNow, setTemporalNow] = useState(() => Date.now());
  const projection = useMemo(() => projectWorldCalendar(chats, characters, { conversationId: conversationId || undefined, now: temporalNow }), [chats, characters, conversationId, temporalNow]);
  const calendarItems = projection.items;
  const patchPlan = useMemo(() => buildWorldCalendarPatchApplyPlan(projection), [projection]);
  const patchDraftQueue = patchPlan.queue;
  const automaticPatchQueue = useMemo(() => patchDraftQueue.filter((item) => item.risk === 'automatic'), [patchDraftQueue]);
  const manualPatchQueue = useMemo(() => patchDraftQueue.filter((item) => item.risk === 'manual'), [patchDraftQueue]);
  const automaticPatchKey = automaticPatchQueue.map((item) => item.idempotencyKey).join('|');
  const lastAutomaticPatchKeyRef = useRef('');
  const chainDraftGroupCount = useMemo(
    () => new Set(manualPatchQueue.map((item) => item.chainGroupId).filter((item): item is string => Boolean(item))).size,
    [manualPatchQueue],
  );
  const currentConversation = useMemo(() => (conversationId ? chats.find((chat) => chat.id === conversationId) : null), [chats, conversationId]);
  const actorNameMap = useMemo(() => new Map(characters.map((character) => [character.id, character.name])), [characters]);
  const selectedDayStart = startOfDay(selectedDate.getTime());
  const baseFilteredItems = useMemo(() => filterAndSortCalendarItems({
    items: calendarItems,
    actorId,
    kindFilter,
    statusFilter,
    selectedDayStart: null,
  }), [actorId, calendarItems, kindFilter, statusFilter]);

  useEffect(() => {
    if (!compact || userAdjustedCalendarRef.current) return;
    const firstItem = baseFilteredItems[0];
    if (firstItem) setSelectedDate(new Date(startOfDay(firstItem.startAt ?? firstItem.updatedAt)));
  }, [baseFilteredItems, compact]);

  const filteredItems = useMemo(
    () => baseFilteredItems.filter((item) => startOfDay(item.startAt ?? item.updatedAt) === selectedDayStart),
    [baseFilteredItems, selectedDayStart],
  );

  const groupedItems = useMemo(() => groupCalendarItemsByDay(filteredItems), [filteredItems]);
  const hideCompactScheduleList = compact && !baseFilteredItems.length && !manualPatchQueue.length;
  const dayTitlesByStart = useMemo(() => {
    const map = new Map<number, string[]>();
    baseFilteredItems.forEach((item) => {
      const key = startOfDay(item.startAt ?? item.updatedAt);
      const titles = map.get(key);
      if (titles) {
        titles.push(item.title);
      } else {
        map.set(key, [item.title]);
      }
    });
    return map;
  }, [baseFilteredItems]);
  const dayItemsByStart = useMemo(() => {
    const map = new Map<number, WorldCalendarItem[]>();
    baseFilteredItems.forEach((item) => {
      const key = startOfDay(item.startAt ?? item.updatedAt);
      const items = map.get(key);
      if (items) items.push(item);
      else map.set(key, [item]);
    });
    return map;
  }, [baseFilteredItems]);
  const detailItem = useMemo(() => calendarItems.find((item) => item.id === detailItemId) || null, [calendarItems, detailItemId]);
  const lifecycleDebugRows = useMemo(
    () => buildCalendarLifecycleDebugRows(baseFilteredItems, temporalNow, isZh),
    [baseFilteredItems, isZh, temporalNow],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setTemporalNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!automaticPatchQueue.length || isApplyingPatchQueue) return;
    if (automaticPatchKey && lastAutomaticPatchKeyRef.current === automaticPatchKey) return;
    lastAutomaticPatchKeyRef.current = automaticPatchKey;
    void applyWorldCalendarPatchDraftQueue({
      chats,
      characters,
      updateChat,
      conversationId,
      trigger: compact ? 'sidebar_projection' : 'manual',
      riskMode: 'automatic',
      continueOnPersistError: true,
    }).catch((error) => {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : (isZh ? '自动调整日历失败' : 'Failed to auto-adjust calendar'),
        severity: 'error',
      });
    });
  }, [automaticPatchKey, automaticPatchQueue.length, characters, chats, compact, conversationId, isApplyingPatchQueue, isZh, updateChat]);

  const handleApplyPatchQueue = async () => {
    if (!manualPatchQueue.length || isApplyingPatchQueue) return;
    setIsApplyingPatchQueue(true);
    try {
      const execution = await applyWorldCalendarPatchDraftQueue({
        chats,
        characters,
        updateChat,
        conversationId,
        trigger: compact ? 'sidebar_projection' : 'manual',
        riskMode: 'manual',
        continueOnPersistError: true,
      });
      setSnackbar({
        open: true,
        message: isZh
          ? `已处理 ${execution.appliedCount} 条冲突调整${execution.skippedCount ? `，跳过 ${execution.skippedCount} 条` : ''}${execution.failedCount ? `，失败 ${execution.failedCount} 条` : ''}`
          : `Applied ${execution.appliedCount} draft(s)${execution.skippedCount ? `, skipped ${execution.skippedCount}` : ''}${execution.failedCount ? `, failed ${execution.failedCount}` : ''}`,
        severity: 'success',
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : (isZh ? '处理日历冲突失败' : 'Failed to resolve calendar conflicts'),
        severity: 'error',
      });
    } finally {
      setIsApplyingPatchQueue(false);
    }
  };

  const handleSaveCalendarEdit = async (chatId: string, event: RuntimeEventV2) => {
    const targetChat = chats.find((chat) => chat.id === chatId && !chat.deletedAt);
    if (!targetChat) {
      throw new Error(isZh ? '关联会话不存在或已删除' : 'The selected chat no longer exists.');
    }
    const existingEvents = targetChat.runtimeEventsV2 || [];
    if (existingEvents.some((item) => item.id === event.id)) return;
    const mergedIds = detailItem?.mergedItemIds;
    const events = mergedIds?.length && mergedIds.includes(String((event.payload as { calendarItemId?: string }).calendarItemId))
      ? mergedIds.map((id, index): RuntimeEventV2 => ({
        ...event,
        id: index === 0 ? event.id : `manual-calendar-event-${generateId()}`,
        payload: { ...event.payload, calendarItemId: id },
      }))
      : [event];
    await updateChat(chatId, {
      runtimeEventsV2: [...existingEvents, ...events],
    });
    setSnackbar({
      open: true,
      message: isZh ? '日程已更新' : 'Event updated',
      severity: 'success',
    });
  };

  const handleDeleteCalendarItem = async (item: WorldCalendarItem) => {
    const targetChat = item.sourceRefs
      .map((source) => chats.find((chat) => chat.id === source.conversationId && !chat.deletedAt))
      .find((chat): chat is GroupChat => Boolean(chat)) || chats.find((chat) => !chat.deletedAt);
    if (!targetChat) throw new Error(isZh ? '关联会话不存在，无法删除日程' : 'The source chat is unavailable.');
    const now = Date.now();
    const tombstones: RuntimeEventV2[] = (item.mergedItemIds || [item.id]).map((id) => ({
      id: `calendar-delete-${generateId()}`,
      conversationId: targetChat.id,
      kind: 'calendar_item_patch',
      createdAt: now,
      actorIds: [],
      targetIds: [],
      summary: isZh ? `从日历移除：${item.title}` : `Removed from calendar: ${item.title}`,
      visibility: 'derived_public',
      payload: { calendarItemId: id, deleted: true, source: 'manual_calendar_entry' },
    }));
    await updateChat(targetChat.id, {
      runtimeEventsV2: [...(targetChat.runtimeEventsV2 || []), ...tombstones],
    });
    setSnackbar({ open: true, message: isZh ? '日程已删除' : 'Event deleted', severity: 'success' });
  };

  return (
    <Box sx={{ px: compact ? 0 : { xs: 1.25, sm: 1.75, md: 2 }, py: compact ? 0 : { xs: 1.25, sm: 1.75, md: 2 }, maxWidth: 'none', mx: 'auto' }}>
      {showHeader ? (
        <Stack direction="row" spacing={1.25} sx={{ mb: 2, alignItems: 'center' }}>
          <CalendarMonthIcon color="primary" />
          <Box>
            <Typography variant={compact ? 'h6' : 'h5'} sx={{ fontWeight: 820, letterSpacing: 0 }}>
              {title || (isZh ? '日历' : 'Calendar')}
            </Typography>
            {subtitle ? <Typography variant="body2" color="text.secondary">{subtitle}</Typography> : null}
          </Box>
        </Stack>
      ) : null}

      {conversationId && !compact ? (
        <Chip
          size="small"
          variant="outlined"
          sx={{ ...calendarMetaChipSx, mb: 2 }}
          label={isZh ? `当前会话：${currentConversation?.name || '已删除会话'}` : `Conversation: ${currentConversation?.name || 'Deleted conversation'}`}
        />
      ) : null}
      {actorId ? (
        <Chip
          size="small"
          variant="outlined"
          sx={{ ...calendarMetaChipSx, mb: 2, ml: conversationId ? 1 : 0 }}
          label={isZh ? `参与者：${actorId === 'user' ? '用户' : (actorNameMap.get(actorId) || actorId)}` : `Participant: ${actorId === 'user' ? 'User' : (actorNameMap.get(actorId) || actorId)}`}
        />
      ) : null}

      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <SurfaceCard
          sx={{
            width: '100%',
            flex: {
              xs: '1 1 auto',
              lg: isGlobalCalendarPage
                ? '0 1 clamp(420px, 44vw, 560px)'
                : '0 0 clamp(360px, 34vw, 450px)',
            },
            alignSelf: 'flex-start',
          }}
          contentSx={{ p: { xs: 1, sm: 1.25 }, '&:last-child': { pb: { xs: 1, sm: 1.25 } } }}
        >
          <BaseCalendar
            isZh={isZh}
            selectedDate={selectedDate}
            onSelectDate={(date) => {
              userAdjustedCalendarRef.current = true;
              setSelectedDate(date);
            }}
            mode={compact && !isCalendarExpanded ? 'week' : 'month'}
            detailsExpanded={isCalendarExpanded}
            dayCellMinHeight={compact ? 38 : isCalendarExpanded ? 72 : 38}
            dayContentMinHeight={compact ? 30 : isCalendarExpanded ? 62 : 30}
            toggle={{
              expanded: isCalendarExpanded,
              onToggle: () => {
                userAdjustedCalendarRef.current = true;
                setIsCalendarExpanded((prev) => !prev);
              },
              expandedLabel: isZh ? '收起' : 'Collapse',
              collapsedLabel: isZh ? '展开' : 'Expand',
              expandedAria: isZh ? '收起日期详情' : 'Collapse date details',
              collapsedAria: isZh ? '展开日期详情' : 'Expand date details',
            }}
            monthFormat={{ month: 'long' }}
            getDayMeta={(day, inMonth) => {
              const key = startOfDay(day.getTime());
              const titles = dayTitlesByStart.get(key) || [];
              const dayItems = dayItemsByStart.get(key) || [];
              const hasConflict = dayItems.some((item) => item.conflict?.hasConflict);
              return {
                inMonth,
                hasDot: titles.length > 0,
                eventCount: titles.length,
                warning: hasConflict,
                dotColors: dayItems.slice(0, 3).map((item) => item.conflict?.hasConflict ? 'warning.main' : getCalendarKindDotColor(item.kind)),
                titles: isCalendarExpanded ? titles.slice(0, 2) : [],
              };
            }}
          />
        </SurfaceCard>
        {!hideCompactScheduleList ? <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ mb: 1.35, display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
              <Chip size="small" clickable sx={calendarFilterChipSx} color={kindFilter === 'all' ? 'primary' : 'default'} variant={kindFilter === 'all' ? 'filled' : 'outlined'} label={isZh ? '全部' : 'All'} onClick={() => setKindFilter('all')} />
              <Chip size="small" clickable sx={calendarFilterChipSx} color={kindFilter === 'activity' ? 'primary' : 'default'} variant={kindFilter === 'activity' ? 'filled' : 'outlined'} label={isZh ? '活动' : 'Activities'} onClick={() => setKindFilter('activity')} />
              <Chip size="small" clickable sx={calendarFilterChipSx} color={kindFilter === 'travel' ? 'primary' : 'default'} variant={kindFilter === 'travel' ? 'filled' : 'outlined'} label={isZh ? '行程' : 'Travel'} onClick={() => setKindFilter('travel')} />
              <Chip size="small" clickable sx={calendarFilterChipSx} color={kindFilter === 'reminder' ? 'primary' : 'default'} variant={kindFilter === 'reminder' ? 'filled' : 'outlined'} label={isZh ? '提醒' : 'Reminders'} onClick={() => setKindFilter('reminder')} />
            </Box>
            <FormControl
              size="small"
              sx={{
                flexShrink: 0,
                flex: '0 1 auto',
                width: { xs: 'clamp(120px, 34vw, 166px)', sm: 'clamp(150px, 24vw, 220px)' },
                minWidth: { xs: 120, sm: 150 },
                maxWidth: { xs: 166, sm: 220 },
                '& .MuiOutlinedInput-root': {
                  height: 30,
                  borderRadius: '14px',
                  bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.64)' : 'rgba(16,18,26,0.58)',
                  backdropFilter: 'blur(18px) saturate(1.05)',
                  WebkitBackdropFilter: 'blur(18px) saturate(1.05)',
                  boxShadow: (theme) => theme.palette.mode === 'light'
                    ? '0 10px 24px rgba(15,23,42,0.06), 0 1px 0 rgba(255,255,255,0.7) inset'
                    : '0 12px 28px rgba(0,0,0,0.22), 0 1px 0 rgba(255,255,255,0.05) inset',
                },
                '& .MuiOutlinedInput-notchedOutline': {
                  borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.11)' : 'rgba(226,232,240,0.12)',
                },
                '& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline': {
                  borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.34)' : 'rgba(120,156,220,0.28)',
                },
              }}
            >
              <Select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as CalendarStatusFilter)}
                sx={{
                  minWidth: 0,
                  '& .MuiSelect-select': {
                    py: 0.25,
                    px: { xs: 1, sm: 1.75 },
                    fontSize: 13,
                    lineHeight: 1.25,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                }}
              >
                <MenuItem value="all">{isZh ? '全部状态' : 'All status'}</MenuItem>
                <MenuItem value="upcoming">{isZh ? '待进行' : 'Upcoming'}</MenuItem>
                <MenuItem value="in_progress">{isZh ? '进行中' : 'In progress'}</MenuItem>
                <MenuItem value="completed">{isZh ? '已完成' : 'Completed'}</MenuItem>
                <MenuItem value="cancelled">{isZh ? '已取消' : 'Cancelled'}</MenuItem>
              </Select>
            </FormControl>
          </Box>
          <Typography variant="subtitle2" sx={{ mb: 1.25, fontWeight: 760, color: 'text.secondary' }}>
            {formatDayTitle(selectedDayStart || Date.now(), isZh)}
          </Typography>

      {developerMode && showCalendarEvents && lifecycleDebugRows.length ? (
        <SurfaceCard contentSx={{ p: compact ? 1 : 1.2, mb: 1.25, '&:last-child': { pb: compact ? 1 : 1.2 } }}>
          <Stack spacing={0.8}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Chip size="small" color="warning" variant="outlined" sx={calendarMetaChipSx} label={isZh ? '日历生命周期调试' : 'Calendar lifecycle debug'} />
              <Typography variant="caption" color="text.secondary">
                {isZh ? '开始/结束来自当前时间窗口投影，不会写入事件流。' : 'Start/end are projected from the current time window and are not persisted as runtime events.'}
              </Typography>
            </Stack>
            <Stack spacing={0.55}>
              {lifecycleDebugRows.map((row) => (
                <Stack key={row.key} direction="row" spacing={0.8} sx={{ alignItems: 'center', minWidth: 0 }}>
                  <Chip size="small" color={row.tone} variant="outlined" sx={calendarMetaChipSx} label={row.label} />
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.text}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Stack>
        </SurfaceCard>
      ) : null}

      {manualPatchQueue.length ? (
        <Stack spacing={1} sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" variant="outlined" color="warning" sx={calendarMetaChipSx} label={isZh ? `需要确认的日历冲突 ${manualPatchQueue.length} 条` : `Calendar conflicts need review ${manualPatchQueue.length}`} />
          {chainDraftGroupCount > 0 ? (
            <Chip
              size="small"
              variant="outlined"
              color="info"
              sx={calendarMetaChipSx}
              label={isZh ? `涉及关联日程 ${chainDraftGroupCount} 组` : `Linked schedules ${chainDraftGroupCount} group(s)`}
            />
          ) : null}
          </Stack>
          <Stack spacing={0.8}>
            {manualPatchQueue.slice(0, 4).map((item) => (
              <SurfaceCard key={item.idempotencyKey} contentSx={{ p: compact ? 1 : 1.2, '&:last-child': { pb: compact ? 1 : 1.2 } }}>
                <Stack spacing={0.55}>
                  <Typography variant="caption" sx={{ fontWeight: 760, color: 'warning.main' }}>
                    {isZh ? `${item.display.calendarItemTitle} 与 ${item.display.basedOnItemTitle} 时间冲突` : `${item.display.calendarItemTitle} conflicts with ${item.display.basedOnItemTitle}`}
                  </Typography>
                  {item.display.participantNames.length ? (
                    <Typography variant="caption" color="text.secondary">
                      {isZh ? `冲突成员：${item.display.participantNames.join('、')}` : `Participants: ${item.display.participantNames.join(', ')}`}
                    </Typography>
                  ) : null}
                  <Typography variant="caption" color="text.secondary">
                    {isZh ? `原时间：${item.display.currentStartAt ? formatTime(item.display.currentStartAt) : '未知'}` : `Current: ${item.display.currentStartAt ? formatTime(item.display.currentStartAt) : 'Unknown'}`}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {isZh ? `建议调整到：${formatTime(item.display.suggestedStartAt)}` : `Suggested: ${formatTime(item.display.suggestedStartAt)}`}
                  </Typography>
                  {item.riskReasons.length ? (
                    <Typography variant="caption" color="text.secondary">
                      {isZh ? `需要确认：${item.riskReasons.join('；')}` : `Needs review: ${item.riskReasons.join('; ')}`}
                    </Typography>
                  ) : null}
                </Stack>
              </SurfaceCard>
            ))}
            {manualPatchQueue.length > 4 ? (
              <Typography variant="caption" color="text.secondary">
                {isZh ? `还有 ${manualPatchQueue.length - 4} 条冲突调整未显示。` : `${manualPatchQueue.length - 4} more conflict adjustment(s).`}
              </Typography>
            ) : null}
          </Stack>
          <Button
            size="small"
            variant="contained"
            color="warning"
            startIcon={<DoneAllIcon />}
            disabled={isApplyingPatchQueue}
            onClick={() => { void handleApplyPatchQueue(); }}
          >
            {isApplyingPatchQueue ? (isZh ? '处理中...' : 'Applying...') : (isZh ? '确认并调整这些冲突' : 'Confirm these adjustments')}
          </Button>
        </Stack>
      ) : null}

          {!groupedItems.length ? (
        <EmptyState
          icon="📅"
          message={isZh ? '当前筛选下还没有日程。可以切换类型或状态筛选查看其他活动。' : 'No schedule under current filters. Try switching type or status filters.'}
        />
      ) : (
            <Stack spacing={1.1}>
              {groupedItems.flatMap((group) => group.items).map((item) => {
                const scheduleHint = formatScheduleHint(item, isZh);
                const listSummary = buildListSummary(item, scheduleHint, isZh);
                const statusMeta = getCalendarStatusMeta(item.status, isZh);
                return (
                  <SurfaceCard
                    key={item.id}
                    sx={{ cursor: 'pointer', ...buildInteractiveSurfaceSx() }}
                    contentSx={{ p: compact ? 1.2 : 1.45, '&:last-child': { pb: compact ? 1.2 : 1.45 } }}
                    onClick={() => setDetailItemId(item.id)}
                  >
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between' }}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="subtitle1" sx={{ fontWeight: 760, letterSpacing: 0 }}>{item.title}</Typography>
                          {listSummary ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.2 }}>{listSummary}</Typography> : null}
                        </Box>
                        <Chip size="small" color={statusMeta.color} variant="outlined" sx={calendarMetaChipSx} label={statusMeta.label} />
                      </Stack>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
                        {scheduleHint ? <Chip size="small" icon={<ScheduleIcon />} sx={calendarMetaChipSx} label={scheduleHint} /> : null}
                        {item.locationHint ? <Chip size="small" icon={<PlaceIcon />} sx={calendarMetaChipSx} label={item.locationHint} /> : null}
                        {item.participantNames.length ? <Chip size="small" icon={<GroupsIcon />} sx={calendarMetaChipSx} label={item.participantNames.join('、')} /> : null}
                        {Object.entries(item.availabilityByActor || {}).map(([actorId, availability]) => (
                          <Chip key={actorId} size="small" sx={calendarMetaChipSx} label={`${item.participantNames[item.participantIds.indexOf(actorId)] || (isZh ? '成员' : 'Member')} · ${availability === 'away' ? (isZh ? '活动期间暂离' : 'Away during activity') : (isZh ? '活动期间可聊天' : 'Available during activity')}`} />
                        ))}
                        {Object.keys(item.participantStates).length ? (
                          <Chip
                            size="small"
                            variant="outlined"
                            sx={calendarMetaChipSx}
                            label={(isZh ? '参与状态' : 'Participant states') + ' · ' + summarizeParticipantStateCounts(item.participantStates, isZh).slice(0, 2).join(' / ')}
                          />
                        ) : null}
                      </Stack>
                  </SurfaceCard>
                );
              })}
            </Stack>
          )}
        </Box> : null}
      </Stack>
      <AppSnackbar
        open={snackbar.open}
        severity={snackbar.severity}
        message={snackbar.message}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
      />
      <ManualCalendarEventDialog
        open={Boolean(detailItem)}
        chats={chats}
        characters={characters}
        fixedConversationId={conversationId}
        initialActorId={actorId}
        editingItem={detailItem}
        isZh={isZh}
        onClose={() => setDetailItemId(null)}
        onCreate={handleSaveCalendarEdit}
        onDelete={handleDeleteCalendarItem}
      />
    </Box>
  );
}
