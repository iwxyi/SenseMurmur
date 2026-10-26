import { useEffect, useMemo, useRef, useState } from 'react';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import { Box, TextField, Button, InputAdornment, Stack, IconButton, Tooltip, Collapse, useMediaQuery, Menu, MenuItem, Divider, Dialog, DialogTitle, DialogContent, DialogActions, Checkbox, FormControlLabel, Radio, RadioGroup, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import VerticalSplitIcon from '@mui/icons-material/VerticalSplit';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import CheckIcon from '@mui/icons-material/Check';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useMessageStore } from '../stores/useMessageStore';
import ChatCard from '../components/chat/ChatCard';
import EmptyState from '../components/common/EmptyState';
import NoCharactersDialog from '../components/common/NoCharactersDialog';
import ListSkeletonGrid from '../components/common/ListSkeletonGrid';
import ConfirmDialog from '../components/common/ConfirmDialog';
import AppSnackbar from '../components/common/AppSnackbar';
import HoverSubmenuMenu from '../components/common/HoverSubmenuMenu';
import FloatingSegmentedTabs from '../components/common/FloatingSegmentedTabs';
import { buildFloatingTabContainerSx } from '../components/common/FloatingSegmentedTabs.styles';
import AnimatedTabContent from '../components/common/AnimatedTabContent';
import { resolveTabTransitionDirection } from '../components/common/tabTransition';
import ExpandableFab from '../components/common/ExpandableFab';
import { usePaneLayout } from '../components/layout/PaneLayoutContext';
import { DETAIL_COLLAPSED_CHANGE_EVENT, DETAIL_COLLAPSED_STORAGE_KEY, readDetailCollapsedState, writeDetailCollapsedState } from '../components/layout/masterDetailState';
import { readPersistentUiValue, writePersistentUiValue } from '../utils/persistentUiState';
import { motion, transition } from '../styles/motion';
import { buildListGridSx } from '../styles/interaction';
import { buildAssistantChatDraft } from '../services/chatDraftBuilder';
import { getLatestChatPreviewMessage, sanitizeChatLatestMessage } from '../services/chatLatestMessage';
import { MIN_MEMBERS } from '../constants/defaults';
import type { AICharacter } from '../types/character';
import { useSettingsStore } from '../stores/useSettingsStore';
import { enqueueGroupBasicCompletion, enqueueGroupVisualGeneration } from '../services/groupVisualGeneration';
import { clearGroupData } from '../services/batchDataClear';

const CHAT_LIST_TAB_KEY = 'chat-list-tab';
const CHAT_LIST_STYLE_KEY = 'chat-list-style';
const ASSISTANT_TAB = 3;
const CHAT_LIST_TAB_ORDER = [ASSISTANT_TAB, 0, 1, 2] as const;
const isChatListTab = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= ASSISTANT_TAB;
type ChatListDisplayMode = 'list' | 'card';
type ChatListSortField = 'time' | 'name' | 'members';
type ChatListStylePreferences = {
  displayMode: ChatListDisplayMode;
  autoColumns: boolean;
  showGroupBackground?: boolean;
  sortField: ChatListSortField;
  sortDirection: 'asc' | 'desc';
};
const DEFAULT_CHAT_LIST_STYLE: ChatListStylePreferences = { displayMode: 'card', autoColumns: true, showGroupBackground: true, sortField: 'time', sortDirection: 'desc' };
function isChatListStylePreferences(value: unknown): value is ChatListStylePreferences {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (item.displayMode === 'list' || item.displayMode === 'card')
    && typeof item.autoColumns === 'boolean'
    && (item.showGroupBackground === undefined || typeof item.showGroupBackground === 'boolean')
    && (item.sortField === 'time' || item.sortField === 'name' || item.sortField === 'members')
    && (item.sortDirection === 'asc' || item.sortDirection === 'desc');
}

type ChatListLocationState = {
  deletedAssistantChat?: {
    id?: string;
    name?: string;
  };
} | null;

function getActiveChatId(pathname: string) {
  return pathname.match(/^\/chats\/([^/]+)(?:\/edit)?$/)?.[1] || null;
}

export default function ChatListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { setHeaderActions, setHeaderBackAction } = useLayoutHeaderActions();
  const isThreeColumn = useMediaQuery('(min-width:1280px)');
  const pane = usePaneLayout();
  const isMasterPane = pane.role === 'master';
  const { chats, addChat, deleteChat, restoreChats, prefetchChats, restoreLocalChats, markChatsWarm, isLoading } = useChatStore(useShallow((state) => ({
    chats: state.chats,
    addChat: state.addChat,
    deleteChat: state.deleteChat,
    restoreChats: state.restoreChats,
    prefetchChats: state.prefetchChats,
    restoreLocalChats: state.restoreLocalChats,
    markChatsWarm: state.markChatsWarm,
    isLoading: state.isLoading,
  })));
  const { characters, prefetchCharacters, markCharactersWarm, loadDeletedCharacters } = useCharacterStore(useShallow((state) => ({
    characters: state.characters,
    prefetchCharacters: state.prefetchCharacters,
    markCharactersWarm: state.markCharactersWarm,
    loadDeletedCharacters: state.loadDeletedCharacters,
  })));
  const [deletedCharacters, setDeletedCharacters] = useState<AICharacter[]>([]);
  const authMode = useAuthStore((state) => state.authMode);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const messageWindowsByChatId = useMessageStore((state) => state.messageWindowsByChatId);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(readDetailCollapsedState);
  const [creatingAssistant, setCreatingAssistant] = useState(false);
  const initialTab = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const tabParam = params.get('tab');
    const parsed = Number(tabParam);
    return tabParam != null && isChatListTab(parsed) ? parsed : readPersistentUiValue(CHAT_LIST_TAB_KEY, 0, isChatListTab);
  }, [location.search]);
  const [tab, setTab] = useState(initialTab);
  const [tabTransitionDirection, setTabTransitionDirection] = useState<-1 | 1>(1);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deletedAssistantNotice, setDeletedAssistantNotice] = useState<{ id: string; name: string } | null>(null);
  const [assistantDeleteError, setAssistantDeleteError] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const previousSelectionModeRef = useRef(selectionMode);
  const [menuModeTransitionKey, setMenuModeTransitionKey] = useState(0);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [batchMenuAnchor, setBatchMenuAnchor] = useState<HTMLElement | null>(null);
  const [styleMenuAnchor, setStyleMenuAnchor] = useState<HTMLElement | null>(null);
  const [chatListStyle, setChatListStyle] = useState<ChatListStylePreferences>(() => readPersistentUiValue(CHAT_LIST_STYLE_KEY, DEFAULT_CHAT_LIST_STYLE, isChatListStylePreferences));
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
  const [batchFields, setBatchFields] = useState({ basics: true, avatar: true, background: false });
  const [batchMode, setBatchMode] = useState<'empty' | 'complete' | 'regenerate' | 'clear'>('empty');
  const [clearingData, setClearingData] = useState(false);
  const [avatarRequirement, setAvatarRequirement] = useState('');
  const [backgroundRequirement, setBackgroundRequirement] = useState('');
  const aiProfiles = useSettingsStore((state) => state.aiProfiles);
  const avatarGeneration = useSettingsStore((state) => state.avatarGeneration);
  const activeChatId = isMasterPane ? getActiveChatId(location.pathname) : null;
  const menuModeAnimationSx = {
    '@keyframes chatListMenuModeSpin': {
      from: { transform: 'rotate(0deg)' },
      to: { transform: 'rotate(360deg)' },
    },
    '& .chat-list-menu-mode-icon': {
      animation: menuModeTransitionKey > 0 ? 'chatListMenuModeSpin 380ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
    },
  };
  const menuHeaderButtonSx = {
    ...menuModeAnimationSx,
    width: 40,
    height: 40,
    borderRadius: 1,
    border: '1px solid',
    borderColor: 'transparent',
    bgcolor: 'transparent',
    '&:hover': {
      borderColor: (theme: { palette: { mode: string } }) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
      bgcolor: (theme: { palette: { mode: string } }) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.035)' : 'rgba(226,232,240,0.06)',
    },
  };

  useEffect(() => {
    if (previousSelectionModeRef.current !== selectionMode) {
      previousSelectionModeRef.current = selectionMode;
      setMenuModeTransitionKey((value) => value + 1);
    }
  }, [selectionMode]);

  const updateChatListStyle = (patch: Partial<ChatListStylePreferences>) => {
    setChatListStyle((current) => {
      const next = { ...current, ...patch };
      writePersistentUiValue(CHAT_LIST_STYLE_KEY, next);
      return next;
    });
  };


  useEffect(() => {
    const syncDetailCollapsed = () => setDetailCollapsed(readDetailCollapsedState());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === DETAIL_COLLAPSED_STORAGE_KEY) syncDetailCollapsed();
    };
    window.addEventListener(DETAIL_COLLAPSED_CHANGE_EVENT, syncDetailCollapsed);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(DETAIL_COLLAPSED_CHANGE_EVENT, syncDetailCollapsed);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    setHeaderBackAction(null);
    setHeaderActions(
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        {selectionMode ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5, whiteSpace: 'nowrap', fontWeight: 650 }}>已选 {selectedChatIds.length}</Typography>
            <Tooltip title="退出多选"><IconButton aria-label="退出多选" onClick={() => { setSelectionMode(false); setSelectedChatIds([]); setBatchMenuAnchor(null); }} sx={{ width: 40, height: 40, borderRadius: 1 }}><CloseIcon fontSize="small" /></IconButton></Tooltip>
            <Tooltip title="批量操作"><IconButton key={`batch-menu-${menuModeTransitionKey}`} aria-label="批量操作" onClick={(event) => setBatchMenuAnchor(event.currentTarget)} sx={menuHeaderButtonSx}><MoreVertIcon className="chat-list-menu-mode-icon" fontSize="small" /></IconButton></Tooltip>
          </>
        ) : null}
        {!selectionMode ? <Tooltip title={searchOpen ? '收起搜索' : t('chat.search')}>
          <IconButton
            aria-label={searchOpen ? '收起搜索' : t('chat.search')}
            color={searchOpen ? 'primary' : 'default'}
            onClick={() => {
              setSearchOpen((open) => {
                if (open) setSearch('');
                return !open;
              });
            }}
            sx={{
              width: 40,
              height: 40,
              borderRadius: 1,
              border: '1px solid',
              borderColor: (theme) => searchOpen
                ? theme.palette.primary.main
                : 'transparent',
              bgcolor: (theme) => searchOpen
                ? theme.palette.mode === 'light' ? 'rgba(49,90,156,0.10)' : 'rgba(120,156,220,0.14)'
                : 'transparent',
              transition: transition(['background-color', 'border-color', 'color', 'transform'], motion.durations.base, motion.softOut),
              '&:hover': {
                transform: 'scale(1.03)',
                borderColor: (theme) => searchOpen
                  ? theme.palette.primary.main
                  : theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
                bgcolor: (theme) => searchOpen
                  ? theme.palette.mode === 'light' ? 'rgba(49,90,156,0.12)' : 'rgba(120,156,220,0.16)'
                  : theme.palette.mode === 'light' ? 'rgba(15,23,42,0.035)' : 'rgba(226,232,240,0.06)',
              },
              '&:active': {
                transform: 'scale(0.94)',
                transitionTimingFunction: motion.press,
                transitionDuration: `${motion.durations.instant}ms`,
              },
            }}
          >
            {searchOpen ? <CloseIcon fontSize="small" /> : <SearchIcon fontSize="small" />}
          </IconButton>
        </Tooltip> : null}
        {!selectionMode ? (
          <Tooltip title="更多">
            <IconButton key={`default-menu-${menuModeTransitionKey}`} aria-label="更多" onClick={(event) => setStyleMenuAnchor(event.currentTarget)} sx={menuHeaderButtonSx}><MoreVertIcon className="chat-list-menu-mode-icon" fontSize="small" /></IconButton>
          </Tooltip>
        ) : null}
        {isThreeColumn ? (
          <Tooltip title={detailCollapsed ? '显示分栏' : '隐藏分栏'}>
            <IconButton
              aria-label={detailCollapsed ? '显示分栏' : '隐藏分栏'}
              color={detailCollapsed ? 'default' : 'primary'}
              onClick={() => writeDetailCollapsedState(!detailCollapsed)}
              sx={{
                width: 40,
                height: 40,
                borderRadius: 1,
                border: '1px solid',
                borderColor: (theme) => detailCollapsed
                  ? 'transparent'
                  : theme.palette.primary.main,
                bgcolor: (theme) => detailCollapsed
                  ? 'transparent'
                  : theme.palette.mode === 'light' ? 'rgba(49,90,156,0.10)' : 'rgba(120,156,220,0.14)',
                transition: transition(['background-color', 'border-color', 'color', 'transform'], motion.durations.base, motion.softOut),
                '&:hover': {
                  transform: 'scale(1.03)',
                  borderColor: (theme) => detailCollapsed
                    ? theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)'
                    : theme.palette.primary.main,
                  bgcolor: (theme) => detailCollapsed
                    ? theme.palette.mode === 'light' ? 'rgba(15,23,42,0.035)' : 'rgba(226,232,240,0.06)'
                    : theme.palette.mode === 'light' ? 'rgba(49,90,156,0.12)' : 'rgba(120,156,220,0.16)',
                },
                '&:active': {
                  transform: 'scale(0.94)',
                  transitionTimingFunction: motion.press,
                  transitionDuration: `${motion.durations.instant}ms`,
                },
              }}
            >
              <VerticalSplitIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>
    );

    return () => {
      setHeaderActions(null);
      setHeaderBackAction(null);
    };
  }, [detailCollapsed, isThreeColumn, searchOpen, selectionMode, menuModeTransitionKey, setHeaderActions, setHeaderBackAction, t, tab, chatListStyle]);

  useEffect(() => {
    markChatsWarm();
    markCharactersWarm();
    void restoreLocalChats();
    void prefetchChats();
    void prefetchCharacters();
    void loadDeletedCharacters().then(setDeletedCharacters).catch(() => setDeletedCharacters([]));
  }, [authMode, isLoggedIn, loadDeletedCharacters, markCharactersWarm, markChatsWarm, prefetchCharacters, prefetchChats, restoreLocalChats]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    const state = location.state as ChatListLocationState;
    const deleted = state?.deletedAssistantChat;
    if (!deleted?.id) return;
    setDeletedAssistantNotice({
      id: deleted.id,
      name: deleted.name?.trim() || '助手会话',
    });
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    writePersistentUiValue(CHAT_LIST_TAB_KEY, tab);
    if (String(tab) === params.get('tab')) return;
    params.set('tab', String(tab));
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [location.pathname, location.search, navigate, tab]);
  const filteredChats = useMemo(() => chats.filter((c) => {
    const summary = (c.layeredMemories || []).slice(-3).map((item) => item.text).join(' ').toLowerCase();
    const recentEvent = (c.worldState?.recentEvent || '').toLowerCase();
    const query = search.toLowerCase();
    return c.name.toLowerCase().includes(query) || c.topic.toLowerCase().includes(query) || recentEvent.includes(query) || summary.includes(query);
  }), [chats, search]);
  const groupedChats = useMemo(() => filteredChats.filter((chat) => chat.type === 'group'), [filteredChats]);
  const userDirectChats = useMemo(() => filteredChats.filter((chat) => chat.type === 'direct'), [filteredChats]);
  const privateChats = useMemo(() => filteredChats.filter((chat) => chat.type === 'ai_direct'), [filteredChats]);
  const assistantChats = useMemo(() => filteredChats.filter((chat) => chat.type === 'assistant'), [filteredChats]);
  const visibleChats = tab === ASSISTANT_TAB ? assistantChats : tab === 0 ? groupedChats : tab === 1 ? userDirectChats : privateChats;
  const visibleChatsWithLatestPreview = useMemo(() => visibleChats.map((chat) => {
    const cachedLatest = getLatestChatPreviewMessage(messageWindowsByChatId[chat.id]?.messages || []);
    const resolvedLatest = cachedLatest || sanitizeChatLatestMessage(chat.latestMessage);
    return resolvedLatest === chat.latestMessage ? chat : { ...chat, latestMessage: resolvedLatest };
  }), [messageWindowsByChatId, visibleChats]);
  const sortedVisibleChats = useMemo(() => [...visibleChatsWithLatestPreview].sort((left, right) => {
    const value = chatListStyle.sortField === 'name'
      ? left.name.localeCompare(right.name, 'zh-Hans-CN')
      : chatListStyle.sortField === 'members'
        ? left.memberIds.length - right.memberIds.length
        : left.lastMessageAt - right.lastMessageAt;
    return chatListStyle.sortDirection === 'asc' ? value : -value;
  }), [chatListStyle.sortDirection, chatListStyle.sortField, visibleChatsWithLatestPreview]);
  const charactersForChatCards = useMemo(() => {
    const activeIds = new Set(characters.map((character) => character.id));
    return [...characters, ...deletedCharacters.filter((character) => !activeIds.has(character.id))];
  }, [characters, deletedCharacters]);
  const toggleChatSelection = (chatId: string) => setSelectedChatIds((ids) => ids.includes(chatId) ? ids.filter((id) => id !== chatId) : [...ids, chatId]);
  const toggleSelectVisibleChats = () => setSelectedChatIds((ids) => ids.length === sortedVisibleChats.length ? [] : sortedVisibleChats.map((chat) => chat.id));
  const batchCounts = useMemo(() => {
    const selected = chats.filter((chat) => chat.type === 'group' && !chat.deletedAt && selectedChatIds.includes(chat.id));
    return { selected, basics: selected.filter((chat) => !chat.name.trim() || !chat.topic.trim()).length, avatar: selected.filter((chat) => !chat.groupVisual?.avatarUrl).length, background: selected.filter((chat) => !chat.groupVisual?.backgroundUrl).length };
  }, [chats, selectedChatIds]);
  const batchIncludesExisting = batchMode === 'regenerate' || batchMode === 'clear';
  const startBatchCompletion = async () => {
    if (batchMode === 'clear') {
      setClearingData(true);
      try {
        await clearGroupData(batchCounts.selected, batchFields);
        setBatchDialogOpen(false);
        setBatchMenuAnchor(null);
        setSelectedChatIds([]);
        setSelectionMode(false);
      } catch (error) {
        setAssistantDeleteError(`清空未全部完成：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setClearingData(false);
      }
      return;
    }
    batchCounts.selected.forEach((chat) => {
      const members = charactersForChatCards.filter((character) => chat.memberIds.includes(character.id));
      if (batchFields.basics && (batchMode === 'regenerate' || !chat.name.trim() || !chat.topic.trim())) enqueueGroupBasicCompletion({ chat, members, profiles: aiProfiles, language: 'zh', mode: batchMode });
      if (batchFields.avatar && (batchMode === 'regenerate' || !chat.groupVisual?.avatarUrl)) enqueueGroupVisualGeneration({ chat, members, profiles: aiProfiles, settings: avatarGeneration, language: 'zh', kind: 'avatar', requirement: avatarRequirement });
      if (batchFields.background && (batchMode === 'regenerate' || !chat.groupVisual?.backgroundUrl)) enqueueGroupVisualGeneration({ chat, members, profiles: aiProfiles, settings: avatarGeneration, language: 'zh', kind: 'background', requirement: backgroundRequirement });
    });
    setBatchDialogOpen(false);
    setBatchMenuAnchor(null);
    setSelectedChatIds([]);
    setSelectionMode(false);
  };
  const confirmBatchDelete = async () => {
    const ids = [...selectedChatIds];
    setBatchDeleteConfirmOpen(false);
    try {
      await Promise.all(ids.map((id) => deleteChat(id)));
      setSelectedChatIds([]);
      setSelectionMode(false);
      setBatchMenuAnchor(null);
    } catch (error) {
      setAssistantDeleteError(error instanceof Error ? error.message : '批量删除群聊失败');
    }
  };
  const customCharacterCount = useMemo(() => characters.filter((character) => !character.isPreset && !character.deletedAt).length, [characters]);
  const [noCharactersDialogOpen, setNoCharactersDialogOpen] = useState(false);
  const [noCharactersReturnTo, setNoCharactersReturnTo] = useState('/chats/create');
  const [noCharactersRequiredCount, setNoCharactersRequiredCount] = useState(MIN_MEMBERS);
  const emptyMessage = tab === ASSISTANT_TAB ? '还没有助手会话' : tab === 0 ? t('chat.noGroups') : tab === 1 ? '还没有单聊' : '还没有 AI私聊';
  const createPath = tab === 0 ? '/chats/create' : '/direct/create';
  const createLabel = tab === ASSISTANT_TAB ? '创建助手' : tab === 0 ? t('chat.create') : '创建单聊';
  const showCreateFab = tab !== 2;
  const openCreateWithCharacterGuard = (path: string) => {
    const requiredCount = path.startsWith('/chats/create') ? MIN_MEMBERS : 1;
    if (customCharacterCount < requiredCount) {
      setNoCharactersReturnTo(path);
      setNoCharactersRequiredCount(requiredCount);
      setNoCharactersDialogOpen(true);
      return;
    }
    navigate(path);
  };
  const noCharactersDialogTitle = customCharacterCount === 0 ? '还没有AI角色' : 'AI角色不足';
  const noCharactersDialogMessage = noCharactersRequiredCount > 1
    ? customCharacterCount === 0
      ? `创建群聊至少需要 ${noCharactersRequiredCount} 个AI角色。可以先去角色库创建角色，或根据主题批量生成。`
      : `当前只有 ${customCharacterCount} 个AI角色，群聊至少需要 ${noCharactersRequiredCount} 个AI角色。请再创建 ${noCharactersRequiredCount - customCharacterCount} 个角色，或根据主题批量生成。`
    : '创建单聊前，需要先在角色库中创建至少一个AI角色。也可以根据主题或故事批量生成角色。';
  const createAssistantChat = async () => {
    if (creatingAssistant) return;
    setCreatingAssistant(true);
    try {
      const auth = useAuthStore.getState();
      const agentAvailable = auth.authMode === 'cloud' && auth.user?.agentEntitled === true;
      const chat = await addChat(buildAssistantChatDraft({
        agentAvailable,
        aiSearchAvailable: agentAvailable && auth.user?.aiSearchEntitled === true,
      }));
      navigate(`/chats/${chat.id}?fromTab=${ASSISTANT_TAB}`);
    } finally {
      setCreatingAssistant(false);
    }
  };
  const handleUndoAssistantDelete = async () => {
    if (!deletedAssistantNotice?.id) return;
    const targetId = deletedAssistantNotice.id;
    setDeletedAssistantNotice(null);
    try {
      await restoreChats([targetId]);
      await prefetchChats();
    } catch (error) {
      setAssistantDeleteError(error instanceof Error ? error.message : '撤销删除失败');
    }
  };
  const floatingActionPositionSx = isMasterPane ? {
    position: 'fixed' as const,
    right: pane.bounds ? `calc(100vw - ${pane.bounds.right}px + 28px)` : 28,
    bottom: pane.bounds ? `calc(100vh - ${pane.bounds.bottom}px + 32px)` : 32,
    visibility: pane.bounds ? 'visible' as const : 'hidden' as const,
  } : {
    position: 'fixed' as const,
    right: { xs: 20, sm: 28, md: 36 },
    bottom: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 76px)', sm: 32, md: 36 },
  };

  return (
    <Box sx={{ position: 'relative', containerType: 'inline-size', p: 3, pt: { xs: 1, sm: 1, md: 3 }, pb: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 82px)', sm: 12 } }}>
      <Stack
        spacing={1.25}
        sx={buildFloatingTabContainerSx()}
      >
        <Collapse in={searchOpen} timeout={220} unmountOnExit sx={{ width: { xs: '100%', sm: 420 }, maxWidth: '100%' }}>
          <TextField
            fullWidth
            size="small"
            placeholder={t('chat.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
              }
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: 1,
                bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.07)',
                backdropFilter: 'blur(18px) saturate(1.12)',
                WebkitBackdropFilter: 'blur(18px) saturate(1.12)',
                boxShadow: (theme) => theme.palette.mode === 'light'
                  ? '0 10px 26px rgba(15,23,42,0.055)'
                  : '0 14px 30px rgba(0,0,0,0.22)',
              },
            }}
          />
        </Collapse>

        <FloatingSegmentedTabs
          value={tab}
          scrollContentToTopOnChange
          onChange={(nextTab) => {
            setTabTransitionDirection(resolveTabTransitionDirection(CHAT_LIST_TAB_ORDER, tab, nextTab));
            setTab(nextTab);
          }}
          items={[
            { value: ASSISTANT_TAB, label: `助手 ${assistantChats.length}` },
            { value: 0, label: `群聊 ${groupedChats.length}` },
            { value: 1, label: `单聊 ${userDirectChats.length}` },
            { value: 2, label: `AI私聊 ${privateChats.length}` },
          ]}
        />
      </Stack>

      <AnimatedTabContent value={tab} direction={tabTransitionDirection}>
        {isLoading && chats.length === 0 ? (
          <ListSkeletonGrid />
        ) : sortedVisibleChats.length === 0 ? (
          <EmptyState
            variant="plain"
            message={emptyMessage}
            action={
              tab === ASSISTANT_TAB ? (
                <Button variant="outlined" onClick={() => void createAssistantChat()} disabled={creatingAssistant}>
                  创建助手
                </Button>
              ) : showCreateFab ? (
                <Stack direction="row" spacing={1}>
                  <Button variant="outlined" onClick={() => openCreateWithCharacterGuard('/chats/create')}>
                    {t('chat.create')}
                  </Button>
                  <Button variant="outlined" onClick={() => openCreateWithCharacterGuard('/direct/create')}>
                    创建单聊
                  </Button>
                </Stack>
              ) : undefined
            }
          />
        ) : (
          <Box
            sx={{
              // Leave room for the card's hover lift inside the tab animation clip.
              pt: chatListStyle.displayMode === 'card' ? 0.5 : 0,
              ...(chatListStyle.displayMode === 'list'
                ? { display: 'grid', gridTemplateColumns: '1fr', gap: 0, alignItems: 'stretch' }
                : chatListStyle.autoColumns
                  ? buildListGridSx()
                  : { display: 'grid', gridTemplateColumns: '1fr', gap: 1.5, alignItems: 'stretch' }),
            }}
          >
            {sortedVisibleChats.map((chat, index) => (
              <ChatCard
                key={chat.id}
                chat={chat}
                characters={charactersForChatCards}
                selected={activeChatId === chat.id}
                selectable={selectionMode}
                multiSelected={selectedChatIds.includes(chat.id)}
                displayMode={chatListStyle.displayMode}
                showGroupBackground={chatListStyle.showGroupBackground ?? true}
                showListDivider={chatListStyle.displayMode === 'list' && index < sortedVisibleChats.length - 1}
                onToggleSelection={() => toggleChatSelection(chat.id)}
                onMemberClick={(member) => navigate(`/characters/${member.id}/edit?returnTo=${encodeURIComponent(location.pathname + location.search)}`)}
                onAvatarClick={chat.type === 'group'
                  ? () => navigate(`/chats/${chat.id}/edit`)
                  : chat.memberIds[0]
                    ? (memberId) => navigate(`/characters/${memberId || chat.memberIds[0]}/edit?returnTo=${encodeURIComponent(location.pathname + location.search)}`)
                    : undefined}
                onLongPress={() => {
                  setSelectionMode(true);
                  setSelectedChatIds((ids) => ids.includes(chat.id) ? ids : [...ids, chat.id]);
                }}
                onClick={() => selectionMode ? toggleChatSelection(chat.id) : navigate(`/chats/${chat.id}?fromTab=${tab}`)}
              />
            ))}
          </Box>
        )}
      </AnimatedTabContent>


      {/* Delete Confirmation */}
      <Menu anchorEl={batchMenuAnchor} open={Boolean(batchMenuAnchor)} onClose={() => setBatchMenuAnchor(null)}>
        <MenuItem onClick={toggleSelectVisibleChats}>全选</MenuItem>
        <MenuItem disabled={!selectedChatIds.length} onClick={() => setBatchDeleteConfirmOpen(true)}>删除</MenuItem>
        <Divider />
        <MenuItem disabled={!batchCounts.selected.length} onClick={() => { setBatchMenuAnchor(null); setBatchDialogOpen(true); }}>批量补全</MenuItem>
      </Menu>
      <HoverSubmenuMenu
        anchorEl={styleMenuAnchor}
        open={Boolean(styleMenuAnchor)}
        onClose={() => setStyleMenuAnchor(null)}
        items={[{
          id: 'style', label: '样式', submenu: <>
        <MenuItem selected={chatListStyle.displayMode === 'list'} onClick={() => { updateChatListStyle({ displayMode: 'list' }); setStyleMenuAnchor(null); }}>
          <Box component="span" sx={{ width: 24, display: 'inline-flex', justifyContent: 'center' }}>{chatListStyle.displayMode === 'list' ? <CheckIcon fontSize="small" /> : null}</Box>列表
        </MenuItem>
        <MenuItem selected={chatListStyle.displayMode === 'card'} onClick={() => { updateChatListStyle({ displayMode: 'card' }); setStyleMenuAnchor(null); }}>
          <Box component="span" sx={{ width: 24, display: 'inline-flex', justifyContent: 'center' }}>{chatListStyle.displayMode === 'card' ? <CheckIcon fontSize="small" /> : null}</Box>卡片
        </MenuItem>
        <Divider />
        <MenuItem disabled={chatListStyle.displayMode !== 'card'} onClick={() => updateChatListStyle({ autoColumns: !chatListStyle.autoColumns })}>
          <Checkbox checked={chatListStyle.autoColumns} disabled={chatListStyle.displayMode !== 'card'} size="small" sx={{ p: 0, mr: 1 }} />自适应列数
        </MenuItem>
        <MenuItem disabled={chatListStyle.displayMode !== 'card'} onClick={() => updateChatListStyle({ showGroupBackground: !(chatListStyle.showGroupBackground ?? true) })}>
          <Checkbox checked={chatListStyle.showGroupBackground ?? true} disabled={chatListStyle.displayMode !== 'card'} size="small" sx={{ p: 0, mr: 1 }} />显示群聊背景
        </MenuItem>
          </>,
        }, {
          id: 'sort', label: '排序', submenu: <>
        <MenuItem selected={chatListStyle.sortField === 'time'} onClick={() => { updateChatListStyle({ sortField: 'time' }); setStyleMenuAnchor(null); }}><Box component="span" sx={{ width: 24, display: 'inline-flex', justifyContent: 'center' }}>{chatListStyle.sortField === 'time' ? <CheckIcon fontSize="small" /> : null}</Box>按时间</MenuItem>
        <MenuItem selected={chatListStyle.sortField === 'name'} onClick={() => { updateChatListStyle({ sortField: 'name' }); setStyleMenuAnchor(null); }}><Box component="span" sx={{ width: 24, display: 'inline-flex', justifyContent: 'center' }}>{chatListStyle.sortField === 'name' ? <CheckIcon fontSize="small" /> : null}</Box>按名称</MenuItem>
        <MenuItem selected={chatListStyle.sortField === 'members'} onClick={() => { updateChatListStyle({ sortField: 'members' }); setStyleMenuAnchor(null); }}><Box component="span" sx={{ width: 24, display: 'inline-flex', justifyContent: 'center' }}>{chatListStyle.sortField === 'members' ? <CheckIcon fontSize="small" /> : null}</Box>按成员数</MenuItem>
        <Divider />
        <MenuItem selected={chatListStyle.sortDirection === 'asc'} onClick={() => { updateChatListStyle({ sortDirection: 'asc' }); setStyleMenuAnchor(null); }}><Box component="span" sx={{ width: 24, display: 'inline-flex', justifyContent: 'center' }}>{chatListStyle.sortDirection === 'asc' ? <CheckIcon fontSize="small" /> : null}</Box>正序</MenuItem>
        <MenuItem selected={chatListStyle.sortDirection === 'desc'} onClick={() => { updateChatListStyle({ sortDirection: 'desc' }); setStyleMenuAnchor(null); }}><Box component="span" sx={{ width: 24, display: 'inline-flex', justifyContent: 'center' }}>{chatListStyle.sortDirection === 'desc' ? <CheckIcon fontSize="small" /> : null}</Box>逆序</MenuItem>
          </>,
        }]}
      />
      <Dialog open={batchDialogOpen} onClose={() => { if (!clearingData) setBatchDialogOpen(false); }} fullWidth maxWidth="sm">
        <DialogTitle>批量补全群聊</DialogTitle>
        <DialogContent dividers>
          <Stack component="fieldset" disabled={clearingData} spacing={1.25} sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
            <Typography variant="body2" color="text.secondary">已选择 {batchCounts.selected.length} 个当前可见群聊</Typography>
            <FormControlLabel control={<Checkbox checked={batchFields.basics} disabled={!batchIncludesExisting && batchCounts.basics === 0} onChange={(event) => setBatchFields((fields) => ({ ...fields, basics: event.target.checked }))} />} label={`基础信息${batchIncludesExisting ? '' : `（${batchCounts.basics}/${batchCounts.selected.length}）`}`} />
            <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}><FormControlLabel sx={{ m: 0, flexShrink: 0 }} control={<Checkbox checked={batchFields.avatar} disabled={!batchIncludesExisting && batchCounts.avatar === 0} onChange={(event) => setBatchFields((fields) => ({ ...fields, avatar: event.target.checked }))} />} label={`群头像${batchIncludesExisting ? '' : `（${batchCounts.avatar}/${batchCounts.selected.length}）`}`} />{batchMode !== 'clear' && <TextField size="small" fullWidth value={avatarRequirement} onChange={(event) => setAvatarRequirement(event.target.value)} placeholder="统一要求（可选）" />}</Stack>
            <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}><FormControlLabel sx={{ m: 0, flexShrink: 0 }} control={<Checkbox checked={batchFields.background} disabled={!batchIncludesExisting && batchCounts.background === 0} onChange={(event) => setBatchFields((fields) => ({ ...fields, background: event.target.checked }))} />} label={`群背景${batchIncludesExisting ? '' : `（${batchCounts.background}/${batchCounts.selected.length}）`}`} />{batchMode !== 'clear' && <TextField size="small" fullWidth value={backgroundRequirement} onChange={(event) => setBackgroundRequirement(event.target.value)} placeholder="统一要求（可选）" />}</Stack>
            <RadioGroup row value={batchMode} onChange={(event) => setBatchMode(event.target.value as typeof batchMode)}>
              <Tooltip title="只处理完全为空的字段，不覆盖已有内容"><FormControlLabel value="empty" control={<Radio />} label="仅空数据" /></Tooltip>
              <Tooltip title="补足缺失内容，保留用户已填写的信息"><FormControlLabel value="complete" control={<Radio />} label="补全信息" /></Tooltip>
              <Tooltip title="基于现有设定重新生成所选内容"><FormControlLabel value="regenerate" control={<Radio />} label="重新生成" /></Tooltip>
              <Tooltip title="删除勾选项目的数据，不重新生成"><FormControlLabel value="clear" control={<Radio />} label="清空" /></Tooltip>
            </RadioGroup>
          </Stack>
        </DialogContent>
        <DialogActions><Button disabled={clearingData} onClick={() => setBatchDialogOpen(false)}>取消</Button><Button variant="contained" color={batchMode === 'clear' ? 'error' : 'primary'} disabled={clearingData || !batchCounts.selected.length || !Object.values(batchFields).some(Boolean)} onClick={startBatchCompletion}>{clearingData ? '清空中' : batchMode === 'clear' ? '清空所选数据' : '加入队列'}</Button></DialogActions>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleteId)}
        title={t('chat.delete')}
        message={t('chat.deleteConfirm')}
        onConfirm={() => {
          if (deleteId) deleteChat(deleteId);
          setDeleteId(null);
        }}
        onCancel={() => setDeleteId(null)}
        destructive
      />
      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        title="删除群聊"
        message={`确定删除选中的 ${selectedChatIds.length} 个聊天吗？`}
        onConfirm={() => void confirmBatchDelete()}
        onCancel={() => setBatchDeleteConfirmOpen(false)}
        destructive
        loadingLabel="删除中"
      />

      {showCreateFab ? (
        <ExpandableFab
          icon={<AddIcon />}
          label={createLabel}
          ariaLabel={createLabel}
          onClick={() => {
            if (tab === ASSISTANT_TAB) {
              void createAssistantChat();
              return;
            }
            openCreateWithCharacterGuard(createPath);
          }}
          disabled={creatingAssistant}
          sx={floatingActionPositionSx}
        />
      ) : null}
      <NoCharactersDialog
        open={noCharactersDialogOpen}
        onClose={() => setNoCharactersDialogOpen(false)}
        returnTo={noCharactersReturnTo}
        title={noCharactersDialogTitle}
        message={noCharactersDialogMessage}
      />
      <AppSnackbar
        open={Boolean(deletedAssistantNotice)}
        message={deletedAssistantNotice ? `已删除「${deletedAssistantNotice.name}」` : ''}
        severity="success"
        onClose={() => setDeletedAssistantNotice(null)}
        offset="navigation"
        action={(
          <Button
            color="inherit"
            size="small"
            onClick={() => void handleUndoAssistantDelete()}
          >
            撤销
          </Button>
        )}
      />
      <AppSnackbar
        open={Boolean(assistantDeleteError)}
        message={assistantDeleteError}
        severity="error"
        onClose={() => setAssistantDeleteError('')}
        offset="navigation"
      />
    </Box>
  );
}
