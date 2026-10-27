import { useEffect, useMemo, useRef, useState } from 'react';
import type { TouchEvent } from 'react';
import { Box, Button, Card, CardContent, Chip, CircularProgress, IconButton, Popper, Typography } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DeleteIcon from '@mui/icons-material/Delete';
import type { CharacterArtifactEntry } from '../../stores/useCharacterArtifactStore';
import type { PaperSurfaceVariant } from '../../types/artifactAppearance';
import MarkdownText from '../common/MarkdownText';
import PaperSurface from '../common/PaperSurface';
import { motion, transition } from '../../styles/motion';
import { compactPillChipSx } from '../../styles/interaction';
import BaseCalendar from '../calendar/BaseCalendar';

type ReaderSwipeState = {
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  startedOnInteractive: boolean;
};

interface ArtifactCalendarReaderProps {
  items: CharacterArtifactEntry[];
  deletedItems?: CharacterArtifactEntry[];
  language: string;
  paperVariant: PaperSurfaceVariant;
  readerHeight: string;
  countUnit?: string;
  showDayCharacters?: boolean;
  emptyTitle: string;
  emptyDescription: string;
  getTitle?: (item: CharacterArtifactEntry) => string;
  getMeta?: (item: CharacterArtifactEntry) => string;
  onRegenerateDebug?: (item: CharacterArtifactEntry) => Promise<void> | void;
  onEnsureDetail?: (itemId: string) => Promise<void> | void;
  onRead?: (itemId: string) => void;
}

function getEntryDateKey(item: CharacterArtifactEntry) {
  if (item.dateKey) return item.dateKey;
  const date = new Date(item.createdAt);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function parseDateKey(dateKey: string) {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function getReaderHorizontalBounds(anchor: HTMLElement) {
  let left = 0;
  let right = anchor.ownerDocument.documentElement.clientWidth;
  // Portals escape clipping, but must still avoid the original scroll containers' gutters.
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/(auto|scroll|overlay)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
    const rect = parent.getBoundingClientRect();
    left = Math.max(left, rect.left + parent.clientLeft);
    right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
  }
  return { left, right };
}

function buildFloatingNavButtonSx() {
  return {
    width: { xs: 34, sm: 40 },
    height: { xs: 34, sm: 40 },
    color: 'text.primary',
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.82)' : 'rgba(30,33,40,0.82)',
    border: '1px solid',
    borderColor: 'divider',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    boxShadow: '0 2px 4px rgba(0,0,0,0.12)',
    opacity: 0.88,
    transition: transition(['opacity', 'background-color', 'box-shadow', 'border-color', 'transform', 'backdrop-filter'], motion.durations.base, motion.gentleSpring),
    '&:hover, &:active, &:focus-visible': {
      opacity: 1,
      bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(15,18,26,0.64)',
      borderColor: 'primary.main',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      boxShadow: (theme: Theme) => theme.palette.mode === 'light' ? '0 3px 6px rgba(15,23,42,0.16)' : '0 3px 6px rgba(0,0,0,0.34)',
      transform: 'scale(1.03)',
    },
    '&:active': {
      transform: 'scale(0.94)',
      transitionTimingFunction: motion.press,
      transitionDuration: `${motion.durations.instant}ms`,
    },
    '&.Mui-disabled': {
      opacity: 0.14,
      bgcolor: 'transparent',
      borderColor: 'transparent',
    },
  } as const;
}

function startedOnInteractiveElement(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]'));
}

export default function ArtifactCalendarReader({
  items,
  deletedItems = [],
  language,
  paperVariant,
  readerHeight,
  countUnit = '',
  showDayCharacters = false,
  emptyTitle,
  emptyDescription,
  getTitle,
  getMeta,
  onRegenerateDebug,
  onEnsureDetail,
  onRead,
}: ArtifactCalendarReaderProps) {
  const isZh = language.startsWith('zh');
  const today = useMemo(() => new Date(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const chronologicalItems = useMemo(() => [...items].sort((a, b) => (
    getEntryDateKey(a).localeCompare(getEntryDateKey(b)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )), [items]);
  const selectedDeletedItem = deletedItems.find((item) => item.id === selectedId) || null;
  const selectedItem = items.find((item) => item.id === selectedId) || selectedDeletedItem || chronologicalItems.at(-1) || null;
  const selectedItemDeleted = Boolean(selectedItem?.deletedAt);
  const selectedIndex = selectedItem ? chronologicalItems.findIndex((item) => item.id === selectedItem.id) : -1;
  const selectedDate = selectedItem ? parseDateKey(getEntryDateKey(selectedItem)) : today;
  const [calendarExpanded, setCalendarExpanded] = useState(true);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const swipeRef = useRef<ReaderSwipeState | null>(null);
  const [readerAnchor, setReaderAnchor] = useState<HTMLDivElement | null>(null);
  const navPoppers = useRef<Array<{ forceUpdate: () => void } | null>>([]);
  useEffect(() => {
    if (!readerAnchor) return;
    const observer = new ResizeObserver(() => {
      navPoppers.current.forEach((popper) => popper?.forceUpdate());
    });
    observer.observe(readerAnchor);
    return () => observer.disconnect();
  }, [readerAnchor]);
  const itemsByDate = useMemo(() => {
    const map = new Map<string, CharacterArtifactEntry[]>();
    chronologicalItems.forEach((item) => {
      const dateKey = getEntryDateKey(item);
      const entries = map.get(dateKey) || [];
      entries.push(item);
      map.set(dateKey, entries);
    });
    return map;
  }, [chronologicalItems]);
  const selectedDayItems = selectedItem ? itemsByDate.get(getEntryDateKey(selectedItem)) || [] : [];
  const unreadDateKeys = useMemo(() => {
    const keys = new Set<string>();
    items.forEach((item) => {
      if (item.unread && item.deletedAt == null) keys.add(getEntryDateKey(item));
    });
    return keys;
  }, [items]);

  const selectItem = (item: CharacterArtifactEntry) => {
    setSelectedId(item.id);
  };

  const goToItem = (offset: number) => {
    if (selectedIndex < 0) return;
    const next = chronologicalItems[selectedIndex + offset];
    if (next) selectItem(next);
  };

  const handleReaderTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) {
      swipeRef.current = null;
      return;
    }
    const touch = event.touches[0];
    swipeRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      latestX: touch.clientX,
      latestY: touch.clientY,
      startedOnInteractive: startedOnInteractiveElement(event.target),
    };
  };

  const handleReaderTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || event.touches.length !== 1) return;
    const touch = event.touches[0];
    swipe.latestX = touch.clientX;
    swipe.latestY = touch.clientY;
  };

  const handleReaderTouchEnd = () => {
    const swipe = swipeRef.current;
    swipeRef.current = null;
    if (!swipe || swipe.startedOnInteractive) return;
    const dx = swipe.latestX - swipe.startX;
    const dy = swipe.latestY - swipe.startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX < 48 || absX < absY * 1.35) return;
    goToItem(dx > 0 ? -1 : 1);
  };

  const handleRegenerateDebug = async () => {
    if (!selectedItem || !onRegenerateDebug || regeneratingId) return;
    setRegeneratingId(selectedItem.id);
    try {
      await onRegenerateDebug(selectedItem);
    } finally {
      setRegeneratingId(null);
    }
  };

  useEffect(() => {
    if (!selectedItem || selectedItem.deletedAt != null || selectedItem.text || !onEnsureDetail) return;
    let cancelled = false;
    setLoadingDetailId(selectedItem.id);
    void Promise.resolve(onEnsureDetail(selectedItem.id))
      .finally(() => {
        if (!cancelled) setLoadingDetailId((current) => current === selectedItem.id ? null : current);
      });
    return () => {
      cancelled = true;
    };
  }, [onEnsureDetail, selectedItem]);

  useEffect(() => {
    if (selectedItem?.unread && selectedItem.deletedAt == null && selectedItem.text.trim()) {
      onRead?.(selectedItem.id);
    }
  }, [onRead, selectedItem]);

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(300px, 360px) minmax(0, 1fr)' }, gap: { xs: 1.5, lg: 2.25 }, alignItems: 'start' }}>
      <Box sx={{ position: { lg: 'sticky' }, top: { lg: 'calc(var(--app-floating-tab-top, 10px) + 64px)' }, alignSelf: 'start', minWidth: 0 }}>
        <Card variant="outlined" sx={{ borderRadius: 3 }}>
          <CardContent sx={{ display: 'grid', gap: 1, p: 1.25, '&:last-child': { pb: 1.25 } }}>
            {selectedDate ? (
              <BaseCalendar
                isZh={isZh}
                selectedDate={selectedDate}
                onSelectDate={(day) => {
                  const item = itemsByDate.get(toDateKey(day))?.at(-1);
                  if (item) selectItem(item);
                }}
                mode={calendarExpanded ? 'month' : 'week'}
                toggle={{
                  expanded: calendarExpanded,
                  onToggle: () => setCalendarExpanded((value) => !value),
                  expandedLabel: isZh ? '收起' : 'Collapse',
                  collapsedLabel: isZh ? '展开' : 'Expand',
                  expandedAria: isZh ? '折叠日历' : 'Collapse calendar',
                  collapsedAria: isZh ? '展开日历' : 'Expand calendar',
                }}
                getDayMeta={(day, inMonth) => {
                  const dateKey = toDateKey(day);
                  const entries = itemsByDate.get(dateKey) || [];
                  const selected = selectedItem ? getEntryDateKey(selectedItem) === dateKey : false;
                  const hasUnreadItem = unreadDateKeys.has(dateKey);
                  return {
                    disabled: !entries.length,
                    selected,
                    inMonth,
                    eventCount: entries.length ? 1 : 0,
                    countLabel: showDayCharacters && entries.length ? String(entries.length) : undefined,
                    countUnread: hasUnreadItem,
                    dotColors: !showDayCharacters && hasUnreadItem ? ['error.main'] : ['primary.main'],
                  };
                }}
              />
            ) : null}
          </CardContent>
        </Card>
      </Box>

      <Box sx={{ minWidth: 0, display: 'grid', gap: 1 }}>
        {showDayCharacters && selectedDayItems.length ? (
          <Box role="group" aria-label={isZh ? '当天内容' : 'Entries on this day'} sx={{ display: 'flex', gap: 0.75, overflowX: 'auto', minWidth: 0, py: 0.5 }}>
            {selectedDayItems.map((item) => {
              const sameCharacterItems = selectedDayItems.filter((entry) => entry.characterId === item.characterId);
              const label = sameCharacterItems.length > 1
                ? `${item.characterName} · ${item.kind === 'birth_letter' ? (isZh ? '诞生信' : 'Birth letter') : item.kind === 'final_letter' ? (isZh ? '告别信' : 'Farewell letter') : (isZh ? '日记' : 'Diary')}`
                : item.characterName;
              return (
                <Chip
                  key={item.id}
                  label={label}
                  size="small"
                  clickable
                  onClick={() => selectItem(item)}
                  aria-pressed={selectedItem?.id === item.id}
                  color={selectedItem?.id === item.id ? 'primary' : 'default'}
                  variant={selectedItem?.id === item.id ? 'filled' : 'outlined'}
                  icon={item.unread ? <Box component="span" aria-label={isZh ? '未读' : 'Unread'} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'error.main' }} /> : undefined}
                  sx={{ ...compactPillChipSx, flexShrink: 0, maxWidth: '100%' }}
                />
              );
            })}
          </Box>
        ) : null}
      <Box
        ref={setReaderAnchor}
        onTouchStart={handleReaderTouchStart}
        onTouchMove={handleReaderTouchMove}
        onTouchEnd={handleReaderTouchEnd}
        onTouchCancel={() => { swipeRef.current = null; }}
        sx={{ position: 'relative', height: readerHeight, touchAction: 'pan-y pinch-zoom', minWidth: 0 }}
      >
        <PaperSurface
          variant={paperVariant}
          minHeight={260}
          contentInset={false}
          sx={[
            { height: readerHeight, minHeight: readerHeight, maxHeight: readerHeight, display: 'flex', flexDirection: 'column', overflow: 'hidden', px: { xs: 2, sm: 2.75 } },
          ]}
        >
          <Box className="paper-surface-content" sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'flex-start', mb: 0.5, flexShrink: 0 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                {selectedItem
                  ? getTitle?.(selectedItem) || (selectedItem.kind === 'diary' ? selectedItem.characterName : selectedItem.title)
                  : emptyTitle}
              </Typography>
              {selectedItem ? (
                <Typography className="paper-surface-muted" variant="caption">
                  {getMeta ? getMeta(selectedItem) : getEntryDateKey(selectedItem)}
                </Typography>
              ) : null}
            </Box>
            {selectedItem ? (
              selectedItemDeleted ? (
                <Chip size="small" color="error" variant="outlined" icon={<DeleteIcon />} label={isZh ? '已删除' : 'Deleted'} sx={{ bgcolor: 'rgba(255,255,255,0.55)' }} />
              ) : (
                <Chip size="small" variant="outlined" label={`${selectedIndex >= 0 ? selectedIndex + 1 : 1}/${items.length}${countUnit}`} sx={{ bgcolor: 'rgba(255,255,255,0.55)' }} />
              )
            ) : null}
          </Box>
          {!selectedItem ? (
            <Box className="paper-surface-content" sx={{ display: 'grid', gap: 1, flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.8 }}>
                {emptyDescription}
              </Typography>
            </Box>
          ) : selectedItemDeleted ? (
            <Box className="paper-surface-content" sx={{ mb: 1, flexShrink: 0 }}>
              <Typography variant="body2" color="error" sx={{ fontWeight: 800 }}>
                {isZh ? '这项内容已在其他设备删除，本地仅保留只读快照。' : 'This item was deleted on another device. This local copy is read-only.'}
              </Typography>
            </Box>
          ) : null}
          {selectedItem ? (
            <>
              <Box className="paper-surface-content" sx={{ mt: 1, typography: 'body2', userSelect: 'text', WebkitUserSelect: 'text', flex: 1, minHeight: 0, overflow: 'auto', pr: { xs: 0.5, sm: 1 } }}>
                {loadingDetailId === selectedItem.id && !selectedItem.text ? (
                  <Box sx={{ height: '100%', minHeight: 180, display: 'grid', placeItems: 'center' }}>
                    <CircularProgress size={24} />
                  </Box>
                ) : (
                  <MarkdownText text={selectedItem.text || ''} />
                )}
              </Box>
              {onRegenerateDebug && !selectedItemDeleted ? (
                <Box className="paper-surface-content" sx={{ pt: 1.25, display: 'flex', justifyContent: 'flex-start', flexShrink: 0 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    color="warning"
                    startIcon={<AutoAwesomeIcon fontSize="small" />}
                    disabled={Boolean(regeneratingId)}
                    onClick={handleRegenerateDebug}
                  >
                    {regeneratingId === selectedItem.id ? (isZh ? '重新生成中' : 'Regenerating') : (isZh ? '重新生成（调试）' : 'Regenerate (debug)')}
                  </Button>
                </Box>
              ) : null}
            </>
          ) : null}
        </PaperSurface>
        {selectedItem ? (
          <>
            {(['left', 'right'] as const).map((side) => (
              <Popper
                key={side}
                open={Boolean(readerAnchor)}
                anchorEl={readerAnchor}
                popperRef={(instance) => { navPoppers.current[side === 'left' ? 0 : 1] = instance; }}
                placement={side}
                popperOptions={{ strategy: 'fixed' }}
                modifiers={[
                  { name: 'flip', enabled: false },
                  { name: 'offset', options: { offset: [0, 4] } },
                  { name: 'preventOverflow', options: { rootBoundary: 'viewport', boundary: 'clippingParents', altAxis: true, tether: false, padding: 2 } },
                  {
                    name: 'symmetricReaderEdges',
                    enabled: true,
                    phase: 'main',
                    requires: ['preventOverflow'],
                    fn: ({ state }) => {
                      if (!readerAnchor || !state.modifiersData.popperOffsets) return;
                      const bounds = getReaderHorizontalBounds(readerAnchor);
                      const paper = readerAnchor.getBoundingClientRect();
                      const width = state.rects.popper.width;
                      const reach = Math.min(width + 4, paper.left - bounds.left - 2, bounds.right - paper.right - 2);
                      state.modifiersData.popperOffsets.x = side === 'left'
                        ? paper.left - reach
                        : paper.right + reach - width;
                    },
                  },
                ]}
                sx={{ zIndex: 1200, '&[data-popper-reference-hidden]': { visibility: 'hidden', pointerEvents: 'none' } }}
              >
                <IconButton
                  onClick={() => goToItem(side === 'left' ? -1 : 1)}
                  disabled={side === 'left' ? selectedIndex <= 0 : selectedIndex < 0 || selectedIndex >= chronologicalItems.length - 1}
                  aria-label={side === 'left' ? (isZh ? '更早一项' : 'Earlier entry') : (isZh ? '更新一项' : 'Later entry')}
                  sx={buildFloatingNavButtonSx()}
                >
                  {side === 'left' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                </IconButton>
              </Popper>
            ))}
          </>
        ) : null}
      </Box>
      </Box>
    </Box>
  );
}
