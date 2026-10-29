import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ForumIcon from '@mui/icons-material/Forum';
import PersonIcon from '@mui/icons-material/Person';
import LockIcon from '@mui/icons-material/Lock';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import type { GroupChat } from '../../types/chat';
import type { AICharacter } from '../../types/character';
import type { RuntimeEventV2 } from '../../types/runtimeEvent';
import type { WorldCalendarItem } from '../../services/worldRuntimeProjection';
import { generateId } from '../../utils/id';
import MemberSelectionDialog from '../createChat/MemberSelectionDialog';
import FloatingSegmentedTabs from '../common/FloatingSegmentedTabs';
import { isImageAvatar } from '../../utils/avatar';
import { buildInteractiveSurfaceSx } from '../../styles/interaction';

interface ManualCalendarEventDialogProps {
  open: boolean;
  chats: GroupChat[];
  characters: AICharacter[];
  fixedConversationId?: string | null;
  initialActorId?: string | null;
  editingItem?: WorldCalendarItem | null;
  isZh: boolean;
  onClose: () => void;
  onCreate: (chatId: string, event: RuntimeEventV2) => Promise<void>;
  onDelete?: (item: WorldCalendarItem) => Promise<void>;
}

interface FormState {
  title: string;
  allDay: boolean;
  startDateTime: string;
  endDateTime: string;
  startDate: string;
  endDate: string;
  participantIds: string[];
  conversationId: string;
  location: string;
  note: string;
}

const FIVE_MINUTES_SECONDS = 300;
const FIVE_MINUTES_MS = FIVE_MINUTES_SECONDS * 1000;
const CHAT_TYPE_TABS = [
  { value: 0, type: 'group' as const, zh: '群聊', en: 'Groups' },
  { value: 1, type: 'direct' as const, zh: '单聊', en: 'Direct' },
  { value: 2, type: 'ai_direct' as const, zh: '角色私聊', en: 'Character private chat' },
];

function pad2(value: number) {
  return `${value}`.padStart(2, '0');
}

function toLocalDateInput(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toLocalDateTimeInput(date: Date) {
  return `${toLocalDateInput(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function roundUpToFiveMinutes(value: number) {
  return Math.ceil(value / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function parseLocalDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLocalDateTime(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function createInitialForm(chats: GroupChat[], characters: AICharacter[], fixedConversationId?: string | null, initialActorId?: string | null): FormState {
  const roundedStart = new Date(roundUpToFiveMinutes(Date.now() + 30 * 60_000));
  const roundedEnd = addMinutes(roundedStart, 60);
  const defaultConversationId = fixedConversationId || chats.find((chat) => !chat.deletedAt)?.id || '';
  const initialParticipantIds = initialActorId && initialActorId !== 'user' && characters.some((character) => character.id === initialActorId && !character.deletedAt)
    ? [initialActorId]
    : [];
  return {
    title: '',
    allDay: false,
    startDateTime: toLocalDateTimeInput(roundedStart),
    endDateTime: toLocalDateTimeInput(roundedEnd),
    startDate: toLocalDateInput(roundedStart),
    endDate: toLocalDateInput(roundedStart),
    participantIds: initialParticipantIds,
    conversationId: defaultConversationId,
    location: '',
    note: '',
  };
}

function isAllDayRange(startAt?: number | null, endAt?: number | null) {
  if (typeof startAt !== 'number' || typeof endAt !== 'number' || endAt <= startAt) return false;
  const start = new Date(startAt);
  const end = new Date(endAt);
  return start.getHours() === 0
    && start.getMinutes() === 0
    && start.getSeconds() === 0
    && start.getMilliseconds() === 0
    && end.getHours() === 0
    && end.getMinutes() === 0
    && end.getSeconds() === 0
    && end.getMilliseconds() === 0
    && (endAt - startAt) % 86_400_000 === 0;
}

function normalizeDisplayText(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function deriveEditableNote(item: WorldCalendarItem, isZh: boolean) {
  const summary = item.summary.trim();
  if (!summary) return '';
  const titleKey = normalizeDisplayText(item.title);
  const locationKey = item.locationHint ? normalizeDisplayText(item.locationHint) : '';
  const participantKey = item.participantNames.length ? normalizeDisplayText(item.participantNames.join(isZh ? '、' : ', ')) : '';
  const filteredParts = summary
    .split(/\s*[·•]\s*/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const key = normalizeDisplayText(part);
      if (!key || key === titleKey || key === locationKey || key === participantKey) return false;
      if (isZh && (/^角色[:：]/.test(part) || /^地点[:：]/.test(part) || part === '全天')) return false;
      if (!isZh && (/^characters?:/i.test(part) || /^location:/i.test(part) || /^all day$/i.test(part))) return false;
      if (/\d{1,2}:\d{2}/.test(part) || /(\d{4}年)?\d{1,2}月\d{1,2}日/.test(part)) return false;
      return true;
    });
  const note = filteredParts.join(' · ').trim();
  return normalizeDisplayText(note) === titleKey ? '' : note;
}

function createFormFromCalendarItem(
  item: WorldCalendarItem,
  chats: GroupChat[],
  fixedConversationId?: string | null,
  fallbackActorId?: string | null,
  isZh = true,
): FormState {
  const fallback = createInitialForm(chats, [], fixedConversationId, fallbackActorId);
  const start = typeof item.startAt === 'number' ? new Date(item.startAt) : parseLocalDateTime(fallback.startDateTime) || new Date();
  const resolvedEndAt = typeof item.endAt === 'number'
    ? item.endAt
    : typeof item.startAt === 'number' && typeof item.durationMinutes === 'number'
      ? item.startAt + item.durationMinutes * 60_000
      : null;
  const end = typeof resolvedEndAt === 'number' ? new Date(resolvedEndAt) : parseLocalDateTime(fallback.endDateTime) || addMinutes(start, 60);
  const allDay = isAllDayRange(item.startAt, resolvedEndAt);
  const inclusiveAllDayEnd = allDay ? new Date(end.getTime() - 1) : end;
  const sourceConversationId = item.sourceRefs[0]?.conversationId || '';
  const conversationId = fixedConversationId
    || (chats.some((chat) => chat.id === sourceConversationId && !chat.deletedAt) ? sourceConversationId : '')
    || fallback.conversationId;

  return {
    title: item.title,
    allDay,
    startDateTime: toLocalDateTimeInput(start),
    endDateTime: toLocalDateTimeInput(end),
    startDate: toLocalDateInput(start),
    endDate: toLocalDateInput(inclusiveAllDayEnd),
    participantIds: item.participantIds.length ? item.participantIds : fallback.participantIds,
    conversationId,
    location: item.locationHint || '',
    note: deriveEditableNote(item, isZh),
  };
}

function buildManualEventId(now: number, title: string) {
  const seed = `${title}-${now}-${generateId().slice(0, 8)}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48);
  return `manual-calendar-${seed}`;
}

function buildSummary(form: FormState, participantNames: string[], startAt: number, endAt: number, isZh: boolean) {
  const parts = [
    form.title.trim(),
    participantNames.length ? `${isZh ? '角色' : 'Characters'}：${participantNames.join('、')}` : '',
    form.location.trim() ? `${isZh ? '地点' : 'Location'}：${form.location.trim()}` : '',
    form.allDay ? (isZh ? '全天' : 'All day') : `${new Date(startAt).toLocaleString()} - ${new Date(endAt).toLocaleString()}`,
    form.note.trim(),
  ].filter(Boolean);
  return parts.join(' · ');
}

function getChatTypeLabel(chat: GroupChat, isZh: boolean) {
  if (chat.type === 'direct') return isZh ? '单聊' : 'Direct';
  if (chat.type === 'ai_direct') return isZh ? '角色私聊' : 'Character private chat';
  return isZh ? '群聊' : 'Group';
}

function getChatTypeIcon(chat: GroupChat) {
  if (chat.type === 'direct') return <PersonIcon fontSize="small" />;
  if (chat.type === 'ai_direct') return <LockIcon fontSize="small" />;
  return <ForumIcon fontSize="small" />;
}

function ConversationSelectionDialog({
  open,
  chats,
  selectedChatId,
  isZh,
  onClose,
  onSelect,
}: {
  open: boolean;
  chats: GroupChat[];
  selectedChatId: string;
  isZh: boolean;
  onClose: () => void;
  onSelect: (chatId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState(0);
  useEffect(() => {
    if (!open) return;
    setSearch('');
    const selectedChat = chats.find((chat) => chat.id === selectedChatId);
    const selectedTab = CHAT_TYPE_TABS.find((item) => item.type === selectedChat?.type)?.value;
    setTab(selectedTab ?? 0);
  }, [chats, open, selectedChatId]);
  const query = search.trim().toLowerCase();
  const filteredChats = useMemo(() => chats.filter((chat) => {
    if (chat.type !== CHAT_TYPE_TABS[tab]?.type) return false;
    if (!query) return true;
    return [chat.name, chat.topic, chat.worldState?.recentEvent || ''].some((value) => value.toLowerCase().includes(query));
  }), [chats, query, tab]);
  const counts = useMemo(() => CHAT_TYPE_TABS.map((item) => chats.filter((chat) => chat.type === item.type).length), [chats]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isZh ? '选择关联会话' : 'Choose source chat'}</DialogTitle>
      <DialogContent sx={{ pt: '12px !important' }}>
        <Stack spacing={1.5}>
          <TextField
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={isZh ? '搜索名称、主题或最近事件' : 'Search name, topic, or recent event'}
            size="small"
            fullWidth
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
          <FloatingSegmentedTabs
            value={tab}
            onChange={setTab}
            items={CHAT_TYPE_TABS.map((item, index) => ({
              value: item.value,
              label: `${isZh ? item.zh : item.en} ${counts[index]}`,
            }))}
          />
          {filteredChats.length ? (
            <Box sx={{ display: 'grid', gap: 1 }}>
              {filteredChats.map((chat) => {
                const selected = chat.id === selectedChatId;
                return (
                  <Box
                    key={chat.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      onSelect(chat.id);
                      onClose();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect(chat.id);
                        onClose();
                      }
                    }}
                    sx={{
                      ...buildInteractiveSurfaceSx({ selected }),
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.25,
                      p: 1.25,
                      cursor: 'pointer',
                    }}
                  >
                    <Avatar sx={{ width: 36, height: 36, bgcolor: 'primary.light' }}>{getChatTypeIcon(chat)}</Avatar>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>{chat.name}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>{chat.topic || getChatTypeLabel(chat, isZh)}</Typography>
                    </Box>
                    <Chip size="small" variant="outlined" label={getChatTypeLabel(chat, isZh)} />
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Box sx={{ py: 5, textAlign: 'center', color: 'text.secondary' }}>
              <Typography variant="body2">{isZh ? '没有匹配的会话' : 'No matching chats'}</Typography>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{isZh ? '取消' : 'Cancel'}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ManualCalendarEventDialog({
  open,
  chats,
  characters,
  fixedConversationId,
  initialActorId,
  editingItem,
  isZh,
  onClose,
  onCreate,
  onDelete,
}: ManualCalendarEventDialogProps) {
  const activeChats = useMemo(() => chats.filter((chat) => !chat.deletedAt), [chats]);
  const activeCharacters = useMemo(() => characters.filter((character) => !character.deletedAt), [characters]);
  const resolvedFixedConversationId = useMemo(
    () => activeChats.some((chat) => chat.id === fixedConversationId) ? fixedConversationId : null,
    [activeChats, fixedConversationId],
  );
  const [form, setForm] = useState<FormState>(() => createInitialForm(activeChats, activeCharacters, resolvedFixedConversationId, initialActorId));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [conversationDialogOpen, setConversationDialogOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(editingItem
      ? createFormFromCalendarItem(editingItem, activeChats, resolvedFixedConversationId, initialActorId, isZh)
      : createInitialForm(activeChats, activeCharacters, resolvedFixedConversationId, initialActorId));
    setSubmitting(false);
    setError('');
    setConfirmDelete(false);
  }, [activeCharacters, activeChats, editingItem, initialActorId, isZh, open, resolvedFixedConversationId]);

  const selectedCharacterNames = useMemo(() => {
    const nameById = new Map(activeCharacters.map((character) => [character.id, character.name]));
    return form.participantIds.map((id) => nameById.get(id)).filter(Boolean) as string[];
  }, [activeCharacters, form.participantIds]);
  const selectedCharacters = useMemo(
    () => form.participantIds.map((id) => activeCharacters.find((character) => character.id === id)).filter(Boolean) as AICharacter[],
    [activeCharacters, form.participantIds],
  );
  const customCharacters = useMemo(() => activeCharacters.filter((character) => !character.isPreset), [activeCharacters]);
  const selectedChat = useMemo(() => activeChats.find((chat) => chat.id === form.conversationId) || null, [activeChats, form.conversationId]);

  const validation = useMemo(() => {
    const title = form.title.trim();
    if (!title) return isZh ? '请填写标题' : 'Enter a title';
    if (!form.conversationId) return isZh ? '请选择关联会话' : 'Choose a source chat';
    if (!form.participantIds.length) return isZh ? '请选择至少一个角色' : 'Choose at least one character';
    if (form.allDay) {
      const startDate = parseLocalDate(form.startDate);
      const endDate = parseLocalDate(form.endDate);
      if (!startDate || !endDate) return isZh ? '请选择日期' : 'Choose dates';
      if (endDate.getTime() < startDate.getTime()) return isZh ? '结束日期不能早于开始日期' : 'End date cannot be before start date';
      return '';
    }
    const start = parseLocalDateTime(form.startDateTime);
    const end = parseLocalDateTime(form.endDateTime);
    if (!start || !end) return isZh ? '请选择开始和结束时间' : 'Choose start and end time';
    if (end.getTime() <= start.getTime()) return isZh ? '结束时间必须晚于开始时间' : 'End time must be after start time';
    return '';
  }, [form, isZh]);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleToggleParticipant = (memberId: string) => {
    setForm((prev) => ({
      ...prev,
      participantIds: prev.participantIds.includes(memberId)
        ? prev.participantIds.filter((id) => id !== memberId)
        : [...prev.participantIds, memberId],
    }));
  };

  const handleSubmit = async () => {
    if (validation || submitting) {
      setError(validation);
      return;
    }
    const now = Date.now();
    const title = form.title.trim();
    const startDate = form.allDay ? parseLocalDate(form.startDate) : parseLocalDateTime(form.startDateTime);
    const rawEndDate = form.allDay ? parseLocalDate(form.endDate) : parseLocalDateTime(form.endDateTime);
    if (!startDate || !rawEndDate) {
      setError(isZh ? '时间无效' : 'Invalid time');
      return;
    }
    const startAt = startDate.getTime();
    const endAt = form.allDay ? addMinutes(rawEndDate, 24 * 60).getTime() : rawEndDate.getTime();
    const durationMinutes = Math.max(5, Math.round((endAt - startAt) / 60_000));
    const calendarItemId = editingItem?.id || buildManualEventId(now, title);
    const summary = buildSummary(form, selectedCharacterNames, startAt, endAt, isZh);
    const participantStates = Object.fromEntries(form.participantIds.map((id) => [id, 'going']));
    const event: RuntimeEventV2 = {
      id: `manual-calendar-event-${generateId()}`,
      conversationId: form.conversationId,
      kind: 'calendar_item_patch',
      createdAt: now,
      actorIds: [],
      targetIds: form.participantIds,
      summary,
      visibility: 'derived_public',
      payload: {
        calendarItemId,
        kind: editingItem?.kind || 'activity',
        status: editingItem?.status || 'confirmed',
        title,
        activityType: title,
        participantIds: form.participantIds,
        participantStates,
        startAt,
        endAt,
        durationMinutes,
        timeHint: form.allDay ? (isZh ? '全天' : 'All day') : null,
        clearTimeHint: !form.allDay,
        locationHint: form.location.trim() || null,
        clearLocationHint: !form.location.trim(),
        summary,
        note: form.note.trim() || null,
        allDay: form.allDay,
        source: 'manual_calendar_entry',
        idempotencyKey: editingItem ? `manual-calendar-edit:${calendarItemId}:${now}` : `manual-calendar:${calendarItemId}`,
      },
    };
    setSubmitting(true);
    setError('');
    try {
      await onCreate(form.conversationId, event);
      onClose();
    } catch {
      setError(isZh ? '保存失败，请稍后重试' : 'Failed to save. Try again later.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!editingItem || !onDelete || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onDelete(editingItem);
      setConfirmDelete(false);
      onClose();
    } catch (cause) {
      setConfirmDelete(false);
      setError(cause instanceof Error ? cause.message : (isZh ? '删除失败，请稍后重试' : 'Failed to delete. Try again later.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editingItem ? (isZh ? '编辑日程' : 'Edit event') : (isZh ? '新增日程' : 'New event')}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '20px !important' }}>
        {error ? <Alert severity="error">{error}</Alert> : null}
        <TextField
          label={isZh ? '标题' : 'Title'}
          value={form.title}
          onChange={(event) => updateField('title', event.target.value)}
          required
          fullWidth
          autoFocus
        />
        <FormControlLabel
          control={<Checkbox checked={form.allDay} onChange={(event) => updateField('allDay', event.target.checked)} />}
          label={isZh ? '全天' : 'All day'}
        />
        {form.allDay ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <TextField
              label={isZh ? '开始日期' : 'Start date'}
              type="date"
              value={form.startDate}
              onChange={(event) => updateField('startDate', event.target.value)}
              required
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label={isZh ? '结束日期' : 'End date'}
              type="date"
              value={form.endDate}
              onChange={(event) => updateField('endDate', event.target.value)}
              required
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Box>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <TextField
              label={isZh ? '开始时间' : 'Start'}
              type="datetime-local"
              value={form.startDateTime}
              onChange={(event) => updateField('startDateTime', event.target.value)}
              required
              slotProps={{ htmlInput: { step: FIVE_MINUTES_SECONDS }, inputLabel: { shrink: true } }}
            />
            <TextField
              label={isZh ? '结束时间' : 'End'}
              type="datetime-local"
              value={form.endDateTime}
              onChange={(event) => updateField('endDateTime', event.target.value)}
              required
              slotProps={{ htmlInput: { step: FIVE_MINUTES_SECONDS }, inputLabel: { shrink: true } }}
            />
          </Box>
        )}
        <Stack spacing={0.75}>
          <Typography variant="caption" color="text.secondary">{isZh ? '角色' : 'Characters'} *</Typography>
          <Button
            variant="outlined"
            onClick={() => setMemberDialogOpen(true)}
            sx={{ justifyContent: 'flex-start', minHeight: 52, textTransform: 'none' }}
          >
            {selectedCharacters.length ? (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {selectedCharacters.map((character) => (
                  <Chip
                    key={character.id}
                    size="small"
                    avatar={isImageAvatar(character.avatar) ? <Avatar src={character.avatar} /> : undefined}
                    label={character.name}
                  />
                ))}
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">{isZh ? '选择参与角色' : 'Choose characters'}</Typography>
            )}
          </Button>
        </Stack>
        <Stack spacing={0.75}>
          <Typography variant="caption" color="text.secondary">{isZh ? '关联会话' : 'Source chat'} *</Typography>
          <Button
            variant="outlined"
            disabled={Boolean(resolvedFixedConversationId)}
            onClick={() => setConversationDialogOpen(true)}
            sx={{ justifyContent: 'flex-start', minHeight: 52, textTransform: 'none' }}
          >
            {selectedChat ? (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
                <Chip size="small" variant="outlined" label={getChatTypeLabel(selectedChat, isZh)} />
                <Typography variant="body2" noWrap>{selectedChat.name}</Typography>
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">{isZh ? '选择关联会话' : 'Choose source chat'}</Typography>
            )}
          </Button>
        </Stack>
        <TextField
          label={isZh ? '地点' : 'Location'}
          value={form.location}
          onChange={(event) => updateField('location', event.target.value)}
          fullWidth
        />
        <TextField
          label={isZh ? '备注' : 'Notes'}
          value={form.note}
          onChange={(event) => updateField('note', event.target.value)}
          fullWidth
          multiline
          minRows={3}
        />
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            {isZh ? '时间精度为 5 分钟；事件会写入关联群聊的运行日历记录。' : 'Time is saved in 5-minute precision; the event is stored in the selected chat runtime calendar.'}
          </Typography>
          {!activeChats.length ? (
            <Alert severity="warning">{isZh ? '当前没有可写入的会话。' : 'No writable chat is available.'}</Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        {editingItem && onDelete ? (
          <Button color="error" startIcon={<DeleteOutlinedIcon />} onClick={() => setConfirmDelete(true)} disabled={submitting} sx={{ mr: 'auto' }}>
            {isZh ? '删除' : 'Delete'}
          </Button>
        ) : null}
        <Button onClick={onClose} disabled={submitting}>{isZh ? '取消' : 'Cancel'}</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={submitting || !activeChats.length}>
          {submitting ? (isZh ? '保存中...' : 'Saving...') : (editingItem ? (isZh ? '保存修改' : 'Save changes') : (isZh ? '保存' : 'Save'))}
        </Button>
      </DialogActions>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{isZh ? '删除日程？' : 'Delete event?'}</DialogTitle>
        <DialogContent>
          <DialogContentText>{isZh ? '这项日程将从日历中移除，聊天记录不受影响。' : 'This event will be removed from the calendar. Chat history is unchanged.'}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)} disabled={submitting}>{isZh ? '取消' : 'Cancel'}</Button>
          <Button color="error" variant="contained" onClick={() => { void handleDelete(); }} disabled={submitting}>{isZh ? '删除' : 'Delete'}</Button>
        </DialogActions>
      </Dialog>
      <MemberSelectionDialog
        open={memberDialogOpen}
        onClose={() => setMemberDialogOpen(false)}
        customCharacters={customCharacters}
        presetCharacters={[]}
        selectedMembers={form.participantIds}
        hasCustomCharacters={customCharacters.length > 0}
        hasPresetCharacters={false}
        title={isZh ? '选择角色' : 'Choose characters'}
        presetLabel={isZh ? '预设' : 'Preset'}
        confirmLabel={isZh ? '完成' : 'Done'}
        cancelLabel={isZh ? '取消' : 'Cancel'}
        searchPlaceholder={isZh ? '搜索角色、分组或设定' : 'Search roles, groups, or profile'}
        allGroupsLabel={isZh ? '全部分组' : 'All groups'}
        customSectionLabel={isZh ? '自定义角色' : 'Custom roles'}
        presetSectionLabel={isZh ? '预设角色' : 'Preset roles'}
        selectedCountLabel={(count) => isZh ? `已选 ${count}` : `${count} selected`}
        emptyLabel={isZh ? '没有匹配的角色' : 'No matching roles'}
        onConfirm={() => setMemberDialogOpen(false)}
        onToggleMember={handleToggleParticipant}
      />
      <ConversationSelectionDialog
        open={conversationDialogOpen}
        chats={activeChats}
        selectedChatId={form.conversationId}
        isZh={isZh}
        onClose={() => setConversationDialogOpen(false)}
        onSelect={(chatId) => updateField('conversationId', chatId)}
      />
    </Dialog>
  );
}
