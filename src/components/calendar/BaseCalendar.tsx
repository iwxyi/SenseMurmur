import { useMemo, useState } from 'react';
import { Box, Button, IconButton, Menu, MenuItem, Stack, Typography } from '@mui/material';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import type { Theme } from '@mui/material/styles';
import { motion, reducedMotionSx, transition } from '../../styles/motion';

export type CalendarViewMode = 'month' | 'week';

export interface CalendarDayRenderMeta {
  disabled?: boolean;
  selected?: boolean;
  inMonth?: boolean;
  hasDot?: boolean;
  eventCount?: number;
  countLabel?: string;
  dotColors?: string[];
  warning?: boolean;
  titles?: string[];
}

interface BaseCalendarProps {
  isZh: boolean;
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
  mode: CalendarViewMode;
  monthFormat?: Intl.DateTimeFormatOptions;
  toggle?: {
    expanded: boolean;
    onToggle: () => void;
    expandedLabel: string;
    collapsedLabel: string;
    expandedAria: string;
    collapsedAria: string;
  };
  getDayMeta?: (date: Date, inMonth: boolean) => CalendarDayRenderMeta;
  detailsExpanded?: boolean;
  maxWidth?: number | string;
  dayCellMinHeight?: number;
  dayContentMinHeight?: number;
}

function toMonthKey(date: Date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function getWeekStart(date: Date) {
  const start = new Date(date);
  const weekday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - weekday);
  return start;
}

function getWeekDays(date: Date) {
  const start = getWeekStart(date);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function getCalendarDays(monthDate: Date) {
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const firstWeekday = (firstDay.getDay() + 6) % 7;
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - firstWeekday);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(startDate);
    day.setDate(startDate.getDate() + index);
    return day;
  });
}

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function isSameDate(left: Date, right: Date) {
  return toDateKey(left) === toDateKey(right);
}

const calendarControlBaseSx = {
  borderRadius: 999,
  border: '1px solid',
  borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
  bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.56)' : 'rgba(18,20,28,0.54)',
  color: 'text.secondary',
  fontSize: 13,
  fontWeight: 560,
  transition: transition(['background-color', 'border-color', 'color'], motion.durations.base, motion.softOut),
  '&:hover': {
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.86)' : 'rgba(28,31,42,0.76)',
    borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.24)' : 'rgba(120,156,220,0.26)',
    color: 'primary.main',
  },
  '&:active': {
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.10)' : 'rgba(120,156,220,0.14)',
    transform: 'none',
  },
  '&.Mui-focusVisible': {
    borderColor: 'primary.main',
  },
  ...reducedMotionSx,
};

const calendarNavButtonSx = {
  width: 32,
  height: 32,
  borderRadius: 999,
  border: '1px solid transparent',
  bgcolor: 'transparent',
  color: 'text.secondary',
  transition: transition(['background-color', 'border-color', 'color'], motion.durations.base, motion.softOut),
  '&:hover': {
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.055)' : 'rgba(226,232,240,0.08)',
    borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
    color: 'primary.main',
  },
  '&:active': {
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.10)' : 'rgba(120,156,220,0.14)',
    transform: 'none',
  },
  '&.Mui-focusVisible': {
    borderColor: 'primary.main',
  },
  ...reducedMotionSx,
};

function buildCalendarDayButtonSx({
  inMonth,
  selected,
  warning,
  today,
  minHeight,
}: {
  inMonth: boolean;
  selected: boolean;
  warning: boolean;
  today: boolean;
  minHeight: number;
}) {
  return {
    minWidth: 0,
    minHeight,
    p: 0.4,
    borderRadius: 1,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    color: inMonth ? (selected ? 'primary.main' : 'text.primary') : 'text.disabled',
    bgcolor: selected ? (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(59,130,246,0.08)' : 'rgba(96,165,250,0.14)' : 'transparent',
    border: '1px solid',
    borderColor: selected ? 'primary.main' : warning ? 'warning.main' : today ? 'primary.main' : 'transparent',
    opacity: inMonth ? 1 : 0.42,
    transition: transition(['background-color', 'border-color', 'color', 'min-height', 'opacity'], motion.durations.base, motion.softOut),
    '&:hover': {
      bgcolor: selected ? (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(59,130,246,0.12)' : 'rgba(96,165,250,0.18)' : (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.045)' : 'rgba(226,232,240,0.08)',
      borderColor: selected ? 'primary.main' : warning ? 'warning.main' : today ? 'primary.main' : (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.10)' : 'rgba(226,232,240,0.12)',
    },
    '&:active': {
      bgcolor: selected ? (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(59,130,246,0.14)' : 'rgba(96,165,250,0.20)' : (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.065)' : 'rgba(226,232,240,0.10)',
      transform: 'none',
    },
    '&.Mui-focusVisible': {
      borderColor: 'primary.main',
    },
    '&.Mui-disabled': { opacity: inMonth ? 0.58 : 0.22 },
    ...reducedMotionSx,
  };
}

export default function BaseCalendar({
  isZh,
  selectedDate,
  onSelectDate,
  mode,
  monthFormat,
  toggle,
  getDayMeta,
  detailsExpanded: detailsExpandedProp,
  maxWidth = 430,
  dayCellMinHeight,
  dayContentMinHeight,
}: BaseCalendarProps) {
  const selectedDateKey = toDateKey(selectedDate);
  const selectedMonth = useMemo(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1), [selectedDate]);
  const [visibleMonthState, setVisibleMonthState] = useState(() => ({
    selectedDateKey,
    month: selectedMonth,
  }));
  const [yearMenuAnchor, setYearMenuAnchor] = useState<null | HTMLElement>(null);
  const [monthMenuAnchor, setMonthMenuAnchor] = useState<null | HTMLElement>(null);
  const visibleMonth = visibleMonthState.selectedDateKey === selectedDateKey ? visibleMonthState.month : selectedMonth;
  const setVisibleMonth = (updater: Date | ((previous: Date) => Date)) => {
    setVisibleMonthState((previous) => ({
      selectedDateKey,
      month: typeof updater === 'function' ? updater(previous.selectedDateKey === selectedDateKey ? previous.month : selectedMonth) : updater,
    }));
  };
  const monthKey = toMonthKey(visibleMonth);
  const yearLabel = `${visibleMonth.getFullYear()}${isZh ? '年' : ''}`;
  const monthLabel = visibleMonth.toLocaleDateString(isZh ? 'zh-CN' : 'en-US', monthFormat || { month: 'long' });
  const weekdays = isZh ? ['一', '二', '三', '四', '五', '六', '日'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const today = useMemo(() => new Date(), []);
  const yearOptions = useMemo(
    () => Array.from({ length: 121 }, (_, i) => visibleMonth.getFullYear() - 60 + i),
    [visibleMonth],
  );
  const monthOptions = useMemo(
    () => Array.from({ length: 12 }, (_, month) => ({
      month,
      label: new Date(2026, month, 1).toLocaleDateString(isZh ? 'zh-CN' : 'en-US', monthFormat || { month: 'long' }),
    })),
    [isZh, monthFormat],
  );

  const anchor = toMonthKey(selectedDate) === monthKey ? selectedDate : visibleMonth;
  const calendarDays = useMemo(() => mode === 'month' ? getCalendarDays(visibleMonth) : getWeekDays(anchor), [mode, visibleMonth, anchor]);
  const showTodayAction = mode === 'month'
    ? toMonthKey(visibleMonth) !== toMonthKey(today)
    : !calendarDays.some((day) => isSameDate(day, today));
  const detailsExpanded = Boolean(detailsExpandedProp);

  return (
    <Box sx={{ display: 'grid', gap: 1, width: '100%', maxWidth, mx: 'auto' }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          px: 0.5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, justifySelf: 'start' }}>
          <CalendarMonthIcon fontSize="small" color="primary" />
          {showTodayAction ? (
            <Button
              size="small"
              disableRipple
              onClick={() => {
                setVisibleMonth(new Date(today.getFullYear(), today.getMonth(), 1));
                onSelectDate(today);
              }}
              sx={{
                ...calendarControlBaseSx,
                minHeight: 30,
                px: 1.15,
                whiteSpace: 'nowrap',
                color: 'text.secondary',
              }}
            >
              {isZh ? '今天' : 'Today'}
            </Button>
          ) : null}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, justifySelf: 'center' }}>
          <IconButton
            size="small"
            onClick={() => setVisibleMonth((prev) => addMonths(prev, -1))}
            aria-label={isZh ? '上个月' : 'Previous month'}
            sx={calendarNavButtonSx}
          >
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
          <Button
            size="small"
            disableRipple
            onClick={(event) => setYearMenuAnchor(event.currentTarget)}
            sx={{ ...calendarControlBaseSx, minWidth: 0, minHeight: 31, px: 0.95, fontSize: 14, fontWeight: 680, textTransform: 'none', color: 'text.primary' }}
          >
            {yearLabel}
          </Button>
          <Button
            size="small"
            disableRipple
            onClick={(event) => setMonthMenuAnchor(event.currentTarget)}
            sx={{ ...calendarControlBaseSx, minWidth: 0, minHeight: 31, px: 0.95, fontSize: 14, fontWeight: 680, textTransform: 'none', color: 'text.primary' }}
          >
            {monthLabel}
          </Button>
          <IconButton
            size="small"
            onClick={() => setVisibleMonth((prev) => addMonths(prev, 1))}
            aria-label={isZh ? '下个月' : 'Next month'}
            sx={calendarNavButtonSx}
          >
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0 }}>
          {toggle ? (
            <Button
              size="small"
              disableRipple
              onClick={toggle.onToggle}
              aria-label={toggle.expanded ? toggle.expandedAria : toggle.collapsedAria}
              endIcon={toggle.expanded ? <UnfoldLessIcon fontSize="small" /> : <UnfoldMoreIcon fontSize="small" />}
              sx={{ ...calendarControlBaseSx, minHeight: 30, px: 1.2, whiteSpace: 'nowrap' }}
            >
              {toggle.expanded ? toggle.expandedLabel : toggle.collapsedLabel}
            </Button>
          ) : null}
        </Box>
      </Box>
      <Menu
        anchorEl={yearMenuAnchor}
        open={Boolean(yearMenuAnchor)}
        onClose={() => setYearMenuAnchor(null)}
        slotProps={{
          paper: {
            sx: { maxHeight: 300, width: 120 },
          },
        }}
      >
        {yearOptions.map((year) => (
          <MenuItem
            key={year}
            selected={year === visibleMonth.getFullYear()}
            onClick={() => {
              setVisibleMonth((prev) => new Date(year, prev.getMonth(), 1));
              setYearMenuAnchor(null);
            }}
          >
            {isZh ? `${year}年` : year}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        anchorEl={monthMenuAnchor}
        open={Boolean(monthMenuAnchor)}
        onClose={() => setMonthMenuAnchor(null)}
        slotProps={{
          paper: {
            sx: { maxHeight: 320, width: 132 },
          },
        }}
      >
        {monthOptions.map((option) => (
          <MenuItem
            key={option.month}
            selected={option.month === visibleMonth.getMonth()}
            onClick={() => {
              setVisibleMonth((prev) => new Date(prev.getFullYear(), option.month, 1));
              setMonthMenuAnchor(null);
            }}
          >
            {option.label}
          </MenuItem>
        ))}
      </Menu>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0.5 }}>
        {weekdays.map((weekday, index) => (
          <Typography
            key={`${weekday}-${index}`}
            variant="caption"
            color="text.secondary"
            sx={{
              textAlign: 'center',
              fontSize: 12,
              lineHeight: 1.4,
              fontWeight: 520,
            }}
          >
            {weekday}
          </Typography>
        ))}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 0.5,
          transition: transition(['grid-template-rows'], motion.durations.slow, motion.softInOut),
          ...reducedMotionSx,
        }}
      >
        {calendarDays.map((day) => {
          const inMonth = toMonthKey(day) === monthKey;
          const meta = getDayMeta?.(day, inMonth) || {};
          const selected = meta.selected ?? (toDateKey(day) === toDateKey(selectedDate));
          const disabled = meta.disabled ?? false;
          const visibleTitles = meta.titles?.slice(0, 2) || [];
          const eventCount = Math.max(0, Math.min(3, Math.floor(meta.eventCount ?? meta.titles?.length ?? (meta.hasDot ? 1 : 0))));
          const hiddenTitleCount = Math.max(0, (meta.eventCount ?? meta.titles?.length ?? 0) - visibleTitles.length);
          const dayIsToday = isSameDate(day, today);
          const dotColors = meta.dotColors?.length ? meta.dotColors : ['primary.main'];
          return (
            <Button
              key={toDateKey(day)}
              size="small"
              disableRipple
              disabled={disabled}
              onClick={() => onSelectDate(day)}
              sx={buildCalendarDayButtonSx({
                inMonth,
                selected,
                warning: Boolean(meta.warning),
                today: dayIsToday,
                minHeight: dayCellMinHeight ?? (mode === 'month' ? 38 : 34),
              })}
            >
              <Stack
                spacing={0.15}
                sx={{
                  alignItems: 'center',
                  justifyContent: detailsExpanded ? 'flex-start' : 'center',
                  position: 'relative',
                  width: '100%',
                  height: '100%',
                  minHeight: dayContentMinHeight ?? (mode === 'month' ? 30 : 22),
                  pt: detailsExpanded ? 0.35 : 0,
                  transition: transition(['min-height', 'padding-top'], motion.durations.base, motion.softOut),
                  ...reducedMotionSx,
                }}
              >
                <Typography
                  sx={{
                    fontSize: detailsExpanded ? 13 : 14,
                    lineHeight: 1.08,
                    fontWeight: selected ? 720 : 520,
                    color: selected ? 'primary.main' : 'inherit',
                  }}
                >
                  {day.getDate()}
                </Typography>
                {visibleTitles.map((title, idx) => (
                  <Typography
                    key={`${title}-${idx}`}
                    sx={{
                      fontSize: 10,
                      lineHeight: 1.18,
                      fontWeight: 500,
                      maxWidth: '100%',
                      px: 0.3,
                      color: selected ? 'primary.main' : 'text.secondary',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {title}
                  </Typography>
                ))}
                {visibleTitles.length && hiddenTitleCount > 0 ? (
                  <Typography sx={{ fontSize: 10, lineHeight: 1, color: meta.warning ? 'warning.main' : 'text.secondary', fontWeight: 560 }}>
                    {`+${hiddenTitleCount}`}
                  </Typography>
                ) : null}
                {meta.countLabel ? (
                  <Typography sx={{ fontSize: 12, lineHeight: 1.2, color: dotColors[0], fontWeight: 400, fontVariantNumeric: 'tabular-nums', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {meta.countLabel}
                  </Typography>
                ) : null}
                {!meta.countLabel && !visibleTitles.length && eventCount > 0 ? (
                  <Box
                    aria-hidden
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: eventCount === 1 ? '1fr' : eventCount === 2 ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)',
                      gap: 0.3,
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: eventCount === 1 ? 5 : eventCount === 2 ? 12 : 19,
                      mt: detailsExpanded ? 0.25 : 0,
                      position: detailsExpanded ? 'static' : 'absolute',
                      left: detailsExpanded ? 'auto' : '50%',
                      bottom: detailsExpanded ? 'auto' : 2,
                      transform: detailsExpanded ? 'none' : 'translateX(-50%)',
                    }}
                  >
                    {Array.from({ length: eventCount }, (_, index) => (
                      <Box
                        key={index}
                        sx={{
                          width: 4.5,
                          height: 4.5,
                          borderRadius: '999px',
                          bgcolor: dotColors[index] || dotColors[dotColors.length - 1] || 'primary.main',
                          opacity: selected ? 0.9 : inMonth ? 0.78 : 0.42,
                        }}
                      />
                    ))}
                  </Box>
                ) : null}
              </Stack>
            </Button>
          );
        })}
      </Box>
    </Box>
  );
}
