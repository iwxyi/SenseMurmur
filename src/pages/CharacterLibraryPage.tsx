import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import { Box, Button, Alert, IconButton, Menu, MenuItem, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Typography, Divider, Tooltip, Checkbox, FormControlLabel, Radio, RadioGroup, FormControl, FormLabel, useMediaQuery } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import MoreIcon from '@mui/icons-material/MoreVert';
import SortIcon from '@mui/icons-material/Sort';
import CloseIcon from '@mui/icons-material/Close';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useAuthStore } from '../stores/useAuthStore';
import CharacterCard from '../components/character/CharacterCard';
import CharacterShowcaseCard from '../components/character/CharacterShowcaseCard';
import CharacterGroupFilterBar from '../components/character/CharacterGroupFilterBar';
import ConfirmDialog from '../components/common/ConfirmDialog';
import EmptyState from '../components/common/EmptyState';
import ListSkeletonGrid from '../components/common/ListSkeletonGrid';
import { buildFloatingTabContainerSx } from '../components/common/FloatingSegmentedTabs.styles';
import AppSnackbar from '../components/common/AppSnackbar';
import ExpandableFab from '../components/common/ExpandableFab';
import VipLimitDialog from '../components/common/VipLimitDialog';
import { usePaneLayout } from '../components/layout/PaneLayoutContext';
import { canDeleteCharacterGroup, getCharacterGroupList, getCharactersInGroup, normalizeCharacter, normalizeCharacterGroup, normalizeCharacterName, getDuplicateCharacterBannerText, getDuplicateCharacterCount, getDuplicateCharacters } from '../types/character';
import { enqueueAvatarGenerationForCharacter } from '../services/avatarGeneration';
import { avatarGenerationQueue } from '../services/avatarGenerationQueue';
import { buildFallbackCharacterVisualGenerationPlan, generateCharacterProfileDraft, generateCharacterVisualGenerationPlan, generateCharacterVisualIdentityDraft, generateCharacterVoiceProfileDraft } from '../services/characterGenerator';
import { assignGeneratedVoiceProfile } from '../services/speechVoiceAssignment';
import { enqueueCharacterCompletionTask, type CharacterCompletionKind } from '../services/characterCompletionQueue';
import { isImageAvatar } from '../utils/avatar';
import { createCharacterBubbleStyleId } from '../utils/bubbleStyle';
import { getPreferredAIProfile, isAIProfileUsable } from '../types/settings';
import { useChatStore } from '../stores/useChatStore';
import { buildDirectChatDraft } from '../services/chatDraftBuilder';
import { api, type BillingMembershipResponse, type VipEntitlementInfo } from '../services/api';
import { notifyDiagnosticToast } from '../services/diagnostics';
import type { AICharacter } from '../types/character';
import { readPersistentUiValue, writePersistentUiValue } from '../utils/persistentUiState';
import { buildListGridSx } from '../styles/interaction';
import { clearCharacterData, type CharacterCompletionField } from '../services/batchDataClear';

type CharacterSortField = 'name' | 'createdAt';
type CharacterSortDirection = 'asc' | 'desc';
type CharacterLibraryView = 'list' | 'card';
const CHARACTER_LIBRARY_GROUP_KEY = 'character-library-group';
const CHARACTER_LIBRARY_SORT_FIELD_KEY = 'character-library-sort-field';
const CHARACTER_LIBRARY_SORT_DIRECTION_KEY = 'character-library-sort-direction';
const CHARACTER_LIBRARY_SORT_GROUP_FIRST_KEY = 'character-library-sort-group-first';
const CHARACTER_LIBRARY_VIEW_KEY = 'character-library-view';
const CHARACTER_LIBRARY_INITIAL_RENDER_COUNT = 24;
const CHARACTER_LIBRARY_RENDER_BATCH_SIZE = 24;
const CHARACTER_LIBRARY_PAGE_SIZE = 24;
const CHARACTER_COMPLETION_FIELDS_KEY = 'character-library-completion-fields';
const CHARACTER_COMPLETION_MODE_KEY = 'character-library-completion-mode';
type CharacterCompletionMode = 'empty' | 'complete' | 'regenerate' | 'clear';
const completionFieldLabels: Record<CharacterCompletionField, string> = { base: '基础设定', avatar: '头像图', visual: '形象图', bubble: '消息气泡', voice: '语音音色', profile: '角色画像', personality: '人物性格' };
const completionFields: CharacterCompletionField[] = ['base', 'avatar', 'visual', 'bubble', 'voice', 'profile', 'personality'];
const isCompletionMode = (value: unknown): value is CharacterCompletionMode => value === 'empty' || value === 'complete' || value === 'regenerate' || value === 'clear';
const isCompletionField = (value: unknown): value is CharacterCompletionField => completionFields.includes(value as CharacterCompletionField);
const isCompletionFieldList = (value: unknown): value is CharacterCompletionField[] => Array.isArray(value) && value.every(isCompletionField);
const isCharacterLibraryGroup = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isCharacterSortField = (value: unknown): value is CharacterSortField => value === 'name' || value === 'createdAt';
const isCharacterSortDirection = (value: unknown): value is CharacterSortDirection => value === 'asc' || value === 'desc';
const isCharacterLibraryView = (value: unknown): value is CharacterLibraryView => value === 'list' || value === 'card';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

function getActiveCharacterId(pathname: string) {
  return pathname.match(/^\/characters\/([^/]+)\/edit$/)?.[1] || null;
}

function compareCharacterByField(a: AICharacter, b: AICharacter, field: CharacterSortField) {
  if (field === 'createdAt') {
    return (a.createdAt || 0) - (b.createdAt || 0);
  }
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function getSortableGroupName(character: AICharacter) {
  return normalizeCharacterGroup(character.group) || '\uffff';
}

function sortCharactersForLibrary(
  characters: AICharacter[],
  field: CharacterSortField,
  direction: CharacterSortDirection,
  groupFirst: boolean,
) {
  const directionMultiplier = direction === 'asc' ? 1 : -1;
  return [...characters].sort((a, b) => {
    if (groupFirst) {
      const groupDiff = getSortableGroupName(a).localeCompare(getSortableGroupName(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
      if (groupDiff !== 0) return groupDiff;
    }
    const fieldDiff = compareCharacterByField(a, b, field);
    if (fieldDiff !== 0) return fieldDiff * directionMultiplier;
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  });
}

function mergeCharacterLibraryPage(current: AICharacter[], next: AICharacter[], replace: boolean) {
  const merged = replace ? next : [...current, ...next];
  const seen = new Set<string>();
  return merged.filter((character) => {
    if (seen.has(character.id)) return false;
    seen.add(character.id);
    return true;
  });
}

function buildDuplicateCharacterGroups(characters: AICharacter[], language: string) {
  const groups = new Map<string, { name: string; items: AICharacter[] }>();
  getDuplicateCharacters(characters).forEach((character) => {
    const key = normalizeCharacterName(character.name);
    const current = groups.get(key) || { name: character.name, items: [] };
    current.items.push(character);
    groups.set(key, current);
  });
  return [...groups.values()].map((group) => ({
    ...group,
    description: group.items
      .map((character) => {
        const characterGroup = normalizeCharacterGroup(character.group) || (language.startsWith('zh') ? '未分组' : 'Ungrouped');
        const createdAt = character.createdAt ? new Date(character.createdAt).toLocaleDateString(language.startsWith('zh') ? 'zh-CN' : undefined) : '';
        return createdAt ? `${characterGroup} · ${createdAt}` : characterGroup;
      })
      .join('、'),
  }));
}

function MenuCheck({ selected }: { selected: boolean }) {
  return (
    <Box component="span" aria-hidden="true" sx={{ width: 24, flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>
      {selected ? '✓' : ''}
    </Box>
  );
}

function CharacterLibraryHeaderActions({
  customCount,
  sortField,
  sortDirection,
  sortGroupFirst,
  view,
  onSortFieldChange,
  onSortDirectionChange,
  onToggleSortGroupFirst,
  onViewChange,
  onImport,
  onExport,
  selectionMode,
  selectedCount,
  onExitSelection,
  onSelectAll,
  onDeleteSelected,
  onChangeGroup,
  onCompleteSelected,
}: {
  customCount: number;
  sortField: CharacterSortField;
  sortDirection: CharacterSortDirection;
  sortGroupFirst: boolean;
  view: CharacterLibraryView;
  onSortFieldChange: (value: CharacterSortField) => void;
  onSortDirectionChange: (value: CharacterSortDirection) => void;
  onToggleSortGroupFirst: () => void;
  onViewChange: (value: CharacterLibraryView) => void;
  onImport: () => void;
  onExport: () => void;
  selectionMode: boolean;
  selectedCount: number;
  onExitSelection: () => void;
  onSelectAll: () => void;
  onDeleteSelected: () => void;
  onChangeGroup: () => void;
  onCompleteSelected: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
  const [sortMenuAnchorEl, setSortMenuAnchorEl] = useState<null | HTMLElement>(null);
  const isZh = i18n.language.startsWith('zh');
  const sortFieldLabel = sortField === 'name'
    ? (isZh ? '名称' : 'Name')
    : (isZh ? '创建时间' : 'Created time');
  const sortDirectionLabel = sortDirection === 'asc'
    ? (isZh ? '正序' : 'Ascending')
    : (isZh ? '逆序' : 'Descending');

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
      {selectionMode ? (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mr: 0.25 }}>{selectedCount} {isZh ? '已选择' : 'selected'}</Typography>
          <Tooltip title={isZh ? '退出多选' : 'Exit selection'}><IconButton size="small" onClick={onExitSelection}><CloseIcon fontSize="small" /></IconButton></Tooltip>
        </>
      ) : null}
      {!selectionMode ? <Chip
        size="small"
        label={`${sortFieldLabel} · ${sortDirectionLabel}${sortGroupFirst ? ` · ${isZh ? '分组优先' : 'Group first'}` : ''}`}
        sx={{ display: { xs: 'none', md: 'inline-flex' } }}
      /> : null}
      {!selectionMode ? <Tooltip title={isZh ? '排序' : 'Sort'}>
        <IconButton
          onClick={(event) => {
            setSortMenuAnchorEl(event.currentTarget);
            setMenuAnchorEl(null);
          }}
          aria-label={isZh ? '排序' : 'Sort'}
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1,
            border: '1px solid',
            borderColor: sortMenuAnchorEl ? 'primary.main' : 'transparent',
            bgcolor: sortMenuAnchorEl
              ? (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.10)' : 'rgba(120,156,220,0.14)'
              : 'transparent',
            transition: 'background-color 180ms ease, border-color 180ms ease, color 180ms ease',
            '&:hover': {
              borderColor: sortMenuAnchorEl
                ? 'primary.main'
                : (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
              bgcolor: sortMenuAnchorEl
                ? (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.12)' : 'rgba(120,156,220,0.16)'
                : (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.035)' : 'rgba(226,232,240,0.06)',
            },
          }}
        >
          <SortIcon fontSize="small" />
        </IconButton>
      </Tooltip> : null}
      {!selectionMode ? <Menu
        anchorEl={sortMenuAnchorEl}
        open={Boolean(sortMenuAnchorEl)}
        onClose={() => setSortMenuAnchorEl(null)}
      >
        <MenuItem selected={sortField === 'name'} onClick={() => { onSortFieldChange('name'); setSortMenuAnchorEl(null); }}>
          <MenuCheck selected={sortField === 'name'} />{isZh ? '名称' : 'Name'}
        </MenuItem>
        <MenuItem selected={sortField === 'createdAt'} onClick={() => { onSortFieldChange('createdAt'); setSortMenuAnchorEl(null); }}>
          <MenuCheck selected={sortField === 'createdAt'} />{isZh ? '创建时间' : 'Created time'}
        </MenuItem>
        <Divider />
        <MenuItem selected={sortDirection === 'asc'} onClick={() => { onSortDirectionChange('asc'); setSortMenuAnchorEl(null); }}>
          <MenuCheck selected={sortDirection === 'asc'} />{isZh ? '正序' : 'Ascending'}
        </MenuItem>
        <MenuItem selected={sortDirection === 'desc'} onClick={() => { onSortDirectionChange('desc'); setSortMenuAnchorEl(null); }}>
          <MenuCheck selected={sortDirection === 'desc'} />{isZh ? '逆序' : 'Descending'}
        </MenuItem>
        <Divider />
        <MenuItem selected={sortGroupFirst} onClick={() => { onToggleSortGroupFirst(); setSortMenuAnchorEl(null); }}>
          <MenuCheck selected={sortGroupFirst} />{isZh ? '分组优先' : 'Group first'}
        </MenuItem>
        <Divider />
        <MenuItem selected={view === 'list'} onClick={() => { onViewChange('list'); setSortMenuAnchorEl(null); }}>
          <MenuCheck selected={view === 'list'} />{isZh ? '列表视图' : 'List view'}
        </MenuItem>
        <MenuItem selected={view === 'card'} onClick={() => { onViewChange('card'); setSortMenuAnchorEl(null); }}>
          <MenuCheck selected={view === 'card'} />{isZh ? '卡片视图' : 'Card view'}
        </MenuItem>
      </Menu> : null}
      <Tooltip title={isZh ? '更多' : 'More'}>
        <IconButton
          aria-label={isZh ? '更多' : 'More'}
          onClick={(event) => { setMenuAnchorEl(event.currentTarget); setSortMenuAnchorEl(null); }}
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1,
            border: '1px solid',
            borderColor: menuAnchorEl ? 'primary.main' : 'transparent',
            bgcolor: menuAnchorEl
              ? (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.10)' : 'rgba(120,156,220,0.14)'
              : 'transparent',
            transition: 'background-color 180ms ease, border-color 180ms ease, color 180ms ease',
            '&:hover': {
              borderColor: menuAnchorEl
                ? 'primary.main'
                : (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
              bgcolor: menuAnchorEl
                ? (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.12)' : 'rgba(120,156,220,0.16)'
                : (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.035)' : 'rgba(226,232,240,0.06)',
            },
          }}
        >
          <MoreIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={menuAnchorEl} open={Boolean(menuAnchorEl)} onClose={() => setMenuAnchorEl(null)}>
        {selectionMode ? <>
          <MenuItem onClick={() => { onSelectAll(); setMenuAnchorEl(null); }}>{isZh ? '全选' : 'Select all'}</MenuItem>
          <MenuItem disabled={selectedCount === 0} onClick={() => { onDeleteSelected(); setMenuAnchorEl(null); }}>{isZh ? '批量删除' : 'Delete selected'}</MenuItem>
          <Divider />
          <MenuItem disabled={selectedCount === 0} onClick={() => { onChangeGroup(); setMenuAnchorEl(null); }}>{isZh ? '更改分组' : 'Change group'}</MenuItem>
          <MenuItem disabled={selectedCount === 0} onClick={() => { onCompleteSelected(); setMenuAnchorEl(null); }}>{isZh ? '批量补全' : 'Complete selected'}</MenuItem>
        </> : <>
        <MenuItem onClick={() => {
          setMenuAnchorEl(null);
          navigate('/characters/batch-generate');
        }}>
          批量生成角色
        </MenuItem>
        <MenuItem onClick={() => {
          setMenuAnchorEl(null);
          onImport();
        }}>
          {t('character.import')}
        </MenuItem>
        <MenuItem onClick={() => {
          setMenuAnchorEl(null);
          onExport();
        }} disabled={customCount === 0}>
          {t('character.exportAll')}
        </MenuItem>
        </>}
      </Menu>
    </Box>
  );
}

export default function CharacterLibraryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { setHeaderActions, setHeaderTitle, setHeaderBackAction, setHideMobileBottomNav } = useLayoutHeaderActions();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const authMode = useAuthStore((state) => state.authMode);
  const { aiProfiles, avatarGeneration } = useSettingsStore(useShallow((state) => ({
    aiProfiles: state.aiProfiles,
    avatarGeneration: state.avatarGeneration,
  })));
  const pane = usePaneLayout();
  const isMasterPane = pane.role === 'master';
  const isThreeColumn = useMediaQuery('(min-width:1280px)');
  const { chats, addChat } = useChatStore(useShallow((state) => ({
    chats: state.chats,
    addChat: state.addChat,
  })));
  const { characters, loadCharacters, markCharactersWarm, prefetchCharacters, deleteCharacter, deleteCharacters, updateCharactersGroup, importCharacters, isLoading } = useCharacterStore(useShallow((state) => ({
    characters: state.characters,
    loadCharacters: state.loadCharacters,
    markCharactersWarm: state.markCharactersWarm,
    prefetchCharacters: state.prefetchCharacters,
    deleteCharacter: state.deleteCharacter,
    deleteCharacters: state.deleteCharacters,
    updateCharactersGroup: state.updateCharactersGroup,
    importCharacters: state.importCharacters,
    isLoading: state.isLoading,
  })));
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>(() => readPersistentUiValue(CHARACTER_LIBRARY_GROUP_KEY, 'all', isCharacterLibraryGroup));
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [completionFieldsSelected, setCompletionFieldsSelected] = useState<CharacterCompletionField[]>(() => readPersistentUiValue(CHARACTER_COMPLETION_FIELDS_KEY, completionFields, isCompletionFieldList));
  const [completionMode, setCompletionMode] = useState<CharacterCompletionMode>(() => readPersistentUiValue(CHARACTER_COMPLETION_MODE_KEY, 'empty', isCompletionMode));
  const [clearingData, setClearingData] = useState(false);
  const [bulkGroupDialogOpen, setBulkGroupDialogOpen] = useState(false);
  const [bulkGroupValue, setBulkGroupValue] = useState('');
  const [groupActionTarget, setGroupActionTarget] = useState<string | null>(null);
  const [groupActionDialogOpen, setGroupActionDialogOpen] = useState(false);
  const [sortField, setSortField] = useState<CharacterSortField>(() => readPersistentUiValue(CHARACTER_LIBRARY_SORT_FIELD_KEY, 'name', isCharacterSortField));
  const [sortDirection, setSortDirection] = useState<CharacterSortDirection>(() => readPersistentUiValue(CHARACTER_LIBRARY_SORT_DIRECTION_KEY, 'asc', isCharacterSortDirection));
  const [sortGroupFirst, setSortGroupFirst] = useState(() => readPersistentUiValue(CHARACTER_LIBRARY_SORT_GROUP_FIRST_KEY, false, isBoolean));
  const [view, setView] = useState<CharacterLibraryView>(() => readPersistentUiValue(CHARACTER_LIBRARY_VIEW_KEY, 'list', isCharacterLibraryView));
  const [visibleCharacterCount, setVisibleCharacterCount] = useState(CHARACTER_LIBRARY_INITIAL_RENDER_COUNT);
  const [libraryItems, setLibraryItems] = useState<AICharacter[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [libraryPage, setLibraryPage] = useState(1);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryRefreshToken, setLibraryRefreshToken] = useState(0);
  const libraryRequestIdRef = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const groupPressTimerRef = useRef<number | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });
  const [freeEntitlement, setFreeEntitlement] = useState<VipEntitlementInfo | null>(null);
  const [freeEntitlementLoaded, setFreeEntitlementLoaded] = useState(false);
  const [membership, setMembership] = useState<BillingMembershipResponse | null>(null);
  const [membershipLoaded, setMembershipLoaded] = useState(authMode !== 'cloud' || !isLoggedIn);
  const [vipLimitDialog, setVipLimitDialog] = useState<{ title: string; description: string; current?: number | null; limit?: number | null; helperText?: string } | null>(null);
  const activeCharacterId = isMasterPane && !selectionMode ? getActiveCharacterId(location.pathname) : null;
  const floatingActionPositionSx = isMasterPane && isThreeColumn ? {
    position: 'fixed' as const,
    right: pane.bounds ? `calc(100vw - ${pane.bounds.right}px + 28px)` : 28,
    bottom: pane.bounds ? `calc(100vh - ${pane.bounds.bottom}px + 32px)` : 32,
  } : {
    position: 'fixed' as const,
    right: { xs: 20, sm: 28, md: 36 },
    bottom: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 76px)', sm: 32, md: 36 },
  };

  useEffect(() => {
    markCharactersWarm();
    setLoadError(null);
    void prefetchCharacters();
  }, [markCharactersWarm, prefetchCharacters]);

  useEffect(() => {
    writePersistentUiValue(CHARACTER_LIBRARY_GROUP_KEY, selectedGroup);
  }, [selectedGroup]);

  useEffect(() => {
    writePersistentUiValue(CHARACTER_LIBRARY_SORT_FIELD_KEY, sortField);
  }, [sortField]);

  useEffect(() => {
    writePersistentUiValue(CHARACTER_LIBRARY_SORT_DIRECTION_KEY, sortDirection);
  }, [sortDirection]);

  useEffect(() => {
    writePersistentUiValue(CHARACTER_LIBRARY_SORT_GROUP_FIRST_KEY, sortGroupFirst);
  }, [sortGroupFirst]);

  useEffect(() => {
    writePersistentUiValue(CHARACTER_LIBRARY_VIEW_KEY, view);
  }, [view]);

  useEffect(() => { writePersistentUiValue(CHARACTER_COMPLETION_FIELDS_KEY, completionFieldsSelected); }, [completionFieldsSelected]);
  useEffect(() => { writePersistentUiValue(CHARACTER_COMPLETION_MODE_KEY, completionMode); }, [completionMode]);

  useEffect(() => {
    libraryLoadQueuedRef.current = false;
    setVisibleCharacterCount(CHARACTER_LIBRARY_INITIAL_RENDER_COUNT);
    setLibraryPage(1);
    setLibraryItems([]);
    setLibraryTotal(0);
  }, [selectedGroup, sortDirection, sortField, sortGroupFirst, view]);

  useEffect(() => {
    let active = true;
    setFreeEntitlementLoaded(false);
    api.getBillingMembershipConfig()
      .then((result) => {
        if (active) {
          setFreeEntitlement(result.entitlements?.free || null);
          setFreeEntitlementLoaded(true);
        }
      })
      .catch(() => {
        if (active) {
          setFreeEntitlement(null);
          setFreeEntitlementLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (authMode !== 'cloud' || !isLoggedIn) {
      setMembership(null);
      setMembershipLoaded(true);
      return () => {
        active = false;
      };
    }
    setMembershipLoaded(false);
    api.getBillingMembership()
      .then((result) => {
        if (active) {
          setMembership(result);
          setMembershipLoaded(true);
        }
      })
      .catch(() => {
        if (active) {
          setMembership(null);
          setMembershipLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [authMode, isLoggedIn]);

  const custom = useMemo(() => characters.filter((c) => !c.isPreset), [characters]);
  const entitlementReady = freeEntitlementLoaded && (authMode !== 'cloud' || !isLoggedIn || membershipLoaded);
  const maxCharacters = entitlementReady
    ? membership?.vipEntitlement?.entitlement.maxCharacters ?? freeEntitlement?.maxCharacters ?? null
    : null;
  const characterLimitReached = maxCharacters != null && maxCharacters >= 0 && custom.length >= maxCharacters;
  const customGroups = useMemo(() => getCharacterGroupList(custom), [custom]);
  const customGroupOptions = useMemo(() => customGroups.map((group) => ({
    value: group,
    label: group,
    count: custom.filter((character) => normalizeCharacterGroup(character.group) === group).length,
  })), [custom, customGroups]);
  const duplicateCharacterCount = useMemo(() => getDuplicateCharacterCount(custom), [custom]);
  const duplicateCharacterBannerText = useMemo(() => getDuplicateCharacterBannerText(custom, i18n.language), [custom, i18n.language]);
  const duplicateCharacterGroups = useMemo(() => buildDuplicateCharacterGroups(custom, i18n.language), [custom, i18n.language]);
  const filteredCustom = useMemo(() => (
    selectedGroup === 'all' ? custom : getCharactersInGroup(custom, selectedGroup)
  ), [custom, selectedGroup]);
  const displayChars = useMemo(() => view === 'card'
    ? libraryItems
    : sortCharactersForLibrary(filteredCustom, sortField, sortDirection, sortGroupFirst),
  [filteredCustom, libraryItems, sortDirection, sortField, sortGroupFirst, view]);
  const visibleDisplayChars = useMemo(
    () => view === 'card' ? displayChars : displayChars.slice(0, visibleCharacterCount),
    [displayChars, view, visibleCharacterCount],
  );
  const hasMoreCharacters = view === 'card' ? libraryItems.length < libraryTotal : visibleDisplayChars.length < displayChars.length;
  const characterLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const libraryLoadQueuedRef = useRef(false);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedCustomCharacters = useMemo(
    () => custom
      .filter((character) => selectedIdSet.has(character.id))
      .map((character) => libraryItems.find((item) => item.id === character.id) || character),
    [custom, libraryItems, selectedIdSet],
  );

  useEffect(() => {
    if (view !== 'card') {
      libraryLoadQueuedRef.current = false;
      setLibraryLoading(false);
      return;
    }
    if (authMode !== 'cloud' || !isLoggedIn) {
      const localItems = sortCharactersForLibrary(filteredCustom, sortField, sortDirection, sortGroupFirst);
      const start = (libraryPage - 1) * CHARACTER_LIBRARY_PAGE_SIZE;
      const pageItems = localItems.slice(start, start + CHARACTER_LIBRARY_PAGE_SIZE);
      setLibraryItems((current) => mergeCharacterLibraryPage(current, pageItems, libraryPage === 1));
      setLibraryTotal(localItems.length);
      libraryLoadQueuedRef.current = false;
      setLibraryLoading(false);
      return;
    }
    const requestId = libraryRequestIdRef.current + 1;
    libraryRequestIdRef.current = requestId;
    setLibraryLoading(true);
    void api.getCharacterLibraryPage({
      page: libraryPage,
      limit: CHARACTER_LIBRARY_PAGE_SIZE,
      sort: sortField,
      direction: sortDirection,
      groupFirst: sortGroupFirst,
      group: selectedGroup,
    }).then((result) => {
      if (libraryRequestIdRef.current !== requestId) return;
      const nextItems = result.items.map((item) => normalizeCharacter(item as unknown as AICharacter));
      setLibraryItems((current) => mergeCharacterLibraryPage(current, nextItems, libraryPage === 1));
      setLibraryTotal(result.total);
    }).catch(() => {
      if (libraryRequestIdRef.current === requestId) setLibraryItems((current) => libraryPage === 1 ? [] : current);
    }).finally(() => {
      if (libraryRequestIdRef.current === requestId) {
        libraryLoadQueuedRef.current = false;
        setLibraryLoading(false);
      }
    });
  }, [authMode, filteredCustom, isLoggedIn, libraryPage, libraryRefreshToken, selectedGroup, sortDirection, sortField, sortGroupFirst, view]);

  useEffect(() => {
    if (selectedGroup === 'all') return;
    const normalizedSelectedGroup = normalizeCharacterGroup(selectedGroup);
    if (!normalizedSelectedGroup || (custom.length > 0 && !customGroups.includes(normalizedSelectedGroup))) {
      setSelectedGroup('all');
    }
  }, [custom.length, customGroups, selectedGroup]);

  useEffect(() => {
    if (!hasMoreCharacters || !characterLoadMoreRef.current || typeof IntersectionObserver === 'undefined') return;
    const scrollRoot = characterLoadMoreRef.current.closest<HTMLElement>('[data-pneumata-scroll-region]');
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      if (view === 'card') {
        // IntersectionObserver may fire repeatedly before the async request
        // flips libraryLoading; gate it so one viewport crossing queues only
        // one page instead of rapidly loading the entire library into memory.
        if (!libraryLoading && !libraryLoadQueuedRef.current) {
          libraryLoadQueuedRef.current = true;
          setLibraryPage((current) => current + 1);
        }
      } else {
        setVisibleCharacterCount((current) => Math.min(current + CHARACTER_LIBRARY_RENDER_BATCH_SIZE, displayChars.length));
      }
    }, { root: scrollRoot, rootMargin: '640px 0px' });
    observer.observe(characterLoadMoreRef.current);
    return () => observer.disconnect();
  }, [displayChars.length, hasMoreCharacters, libraryLoading, view]);

  const resetSelection = () => {
    setSelectionMode(false);
    setSelectedIds([]);
  };

  const resetCardLibrary = () => {
    libraryRequestIdRef.current += 1;
    setLibraryPage(1);
    setLibraryItems([]);
    setLibraryTotal(0);
    setLibraryRefreshToken((current) => current + 1);
  };

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  };

  const enterSelectionMode = (id: string) => {
    setSelectionMode(true);
    setSelectedIds((prev) => prev.includes(id) ? prev : [...prev, id]);
  };

  const handleGroupAction = async (mode: 'clear' | 'delete') => {
    const normalizedTarget = normalizeCharacterGroup(groupActionTarget);
    if (!normalizedTarget) return;
    const targetCharacters = custom.filter((character) => normalizeCharacterGroup(character.group) === normalizedTarget);
    const ids = targetCharacters.map((character) => character.id);
    if (!ids.length) return;
    if (mode === 'clear') {
      await updateCharactersGroup(ids, null);
    } else {
      await deleteCharacters(ids);
      resetCardLibrary();
    }
    setGroupActionDialogOpen(false);
    setGroupActionTarget(null);
    if (selectedGroup === normalizedTarget) setSelectedGroup('all');
    resetSelection();
  };

  const applyBulkGroup = async () => {
    await updateCharactersGroup(selectedIds, normalizeCharacterGroup(bulkGroupValue));
    setBulkGroupDialogOpen(false);
    setBulkGroupValue('');
    resetSelection();
  };

  const applyBulkDelete = async () => {
    await deleteCharacters(selectedIds);
    resetCardLibrary();
    setBulkDeleteOpen(false);
    resetSelection();
  };

  const handleSelectAllCharacters = () => {
    // 全选只作用于当前筛选结果；卡片模式还受分页影响，只选择已加载的卡片。
    const selectableCharacters = view === 'card' ? displayChars : filteredCustom;
    setSelectedIds(selectableCharacters.map((character) => character.id));
    setSelectionMode(true);
  };

  const isCompletionMissing = (character: AICharacter, field: CharacterCompletionField) => {
    if (field === 'avatar') return !isImageAvatar(character.avatar);
    // 形象描述和形象图是两份独立数据：已有描述时，仍应为没有图片的角色生成形象图。
    if (field === 'visual') return !(character.visualIdentity?.referenceImages?.length);
    if (field === 'bubble') return !character.bubbleStyle && !character.bubbleStyleId;
    if (field === 'voice') return !character.voiceConfig?.voiceName;
    if (field === 'profile') return !character.coreProfile || !Object.values(character.coreProfile).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
    if (field === 'personality') return !character.personality || Object.values(character.personality).every((value) => !value);
    return !character.background?.trim() || !character.speakingStyle?.trim() || !character.expertise?.length;
  };

  const isCompletionFieldDisabled = (field: CharacterCompletionField) => (
    completionMode !== 'regenerate'
    && completionMode !== 'clear'
    && selectedCustomCharacters.length > 0
    && selectedCustomCharacters.every((character) => !isCompletionMissing(character, field))
  );

  const openCompletionDialog = () => {
    setCompletionOpen(true);
  };

  const enqueueCompletion = async () => {
    if (completionMode === 'clear') {
      setClearingData(true);
      try {
        await clearCharacterData(selectedCustomCharacters, completionFieldsSelected);
        setCompletionOpen(false);
        resetSelection();
        setSnackbar({ open: true, message: '已清空所选数据', severity: 'success' });
      } catch (error) {
        setSnackbar({ open: true, message: `清空未全部完成：${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
      } finally {
        setClearingData(false);
      }
      return;
    }
    const charactersToProcess = selectedCustomCharacters;
    charactersToProcess.forEach((character) => completionFieldsSelected.forEach((field) => {
      const missing = isCompletionMissing(character, field);
      if (completionMode !== 'regenerate' && !missing) return;
      const kind: CharacterCompletionKind = field === 'avatar' || field === 'visual' ? 'image' : 'text';
      enqueueCharacterCompletionTask({
        kind,
        characterId: character.id,
        characterName: character.name,
        field,
        label: completionFieldLabels[field],
        run: async () => {
          if (field === 'base' || field === 'personality' || field === 'profile') {
            const profile = getPreferredAIProfile(aiProfiles, 'text');
            if (!isAIProfileUsable(profile)) throw new Error('请先配置文本 AI 模型');
            const generated = await generateCharacterProfileDraft(profile, character.name, i18n.language.startsWith('zh') ? 'zh' : 'en', character.group || null);
            await useCharacterStore.getState().updateCharacter(character.id, {
              ...(field === 'base' ? { background: completionMode === 'complete' ? (character.background || generated.background) : generated.background, speakingStyle: completionMode === 'complete' ? (character.speakingStyle || generated.speakingStyle) : generated.speakingStyle, expertise: completionMode === 'complete' && character.expertise?.length ? character.expertise : generated.expertise } : {}),
              ...(field === 'personality' ? { personality: completionMode === 'complete' && character.personality ? character.personality : generated.personality } : {}),
              ...(field === 'profile' ? { coreProfile: completionMode === 'complete' && character.coreProfile ? character.coreProfile : generated.coreProfile } : {}),
            });
            return;
          }
          if (field === 'bubble') {
            const profile = getPreferredAIProfile(aiProfiles, 'text');
            if (!isAIProfileUsable(profile)) throw new Error('请先配置文本 AI 模型');
            const generated = await generateCharacterProfileDraft(profile, character.name, i18n.language.startsWith('zh') ? 'zh' : 'en', character.group || null);
            await useCharacterStore.getState().updateCharacter(character.id, { bubbleStyle: { ...generated.bubbleStyle, id: createCharacterBubbleStyleId() } });
            return;
          }
          if (field === 'voice') {
            const profile = getPreferredAIProfile(aiProfiles, 'text');
            if (!isAIProfileUsable(profile)) throw new Error('请先配置文本 AI 模型');
            const generated = await generateCharacterVoiceProfileDraft(profile, { name: character.name, background: character.background, speakingStyle: character.speakingStyle, expertise: character.expertise, group: character.group, coreProfile: character.coreProfile, speechProfile: character.speechProfile }, i18n.language.startsWith('zh') ? 'zh' : 'en');
            const assigned = await assignGeneratedVoiceProfile(generated, character.id, [], getPreferredAIProfile(aiProfiles, 'tts')?.provider);
            await useCharacterStore.getState().updateCharacter(character.id, { voiceConfig: { ...(character.voiceConfig || {}), ...assigned.voiceConfig, voiceProfile: generated } });
            return;
          }
          if (field === 'visual') {
            const current = useCharacterStore.getState().characters.find((item) => item.id === character.id) || character;
            let visualIdentity = current.visualIdentity || {};
            const language = i18n.language.startsWith('zh') ? 'zh' : 'en';
            const textProfile = getPreferredAIProfile(aiProfiles, 'text');
            let fallbackReason: string | null = null;
            if (!visualIdentity.description?.trim() || completionMode !== 'empty') {
              if (!isAIProfileUsable(textProfile)) {
                fallbackReason = '请先配置文本 AI 模型';
              } else {
                try {
                  const draft = await generateCharacterVisualIdentityDraft(textProfile, { name: current.name, background: current.background, speakingStyle: current.speakingStyle, expertise: current.expertise, group: current.group }, language);
                  visualIdentity = completionMode === 'regenerate'
                    ? { ...visualIdentity, ...draft }
                    : { ...visualIdentity, description: visualIdentity.description?.trim() || draft.description, styleHint: visualIdentity.styleHint?.trim() || draft.styleHint, negativePrompt: visualIdentity.negativePrompt?.trim() || draft.negativePrompt, seed: visualIdentity.seed ?? draft.seed };
                  await useCharacterStore.getState().updateCharacter(current.id, { visualIdentity });
                } catch (error) {
                  fallbackReason = error instanceof Error ? error.message : String(error);
                }
              }
            }
            const imageProfile = getPreferredAIProfile(aiProfiles, 'image');
            if (!isAIProfileUsable(imageProfile)) throw new Error('请先配置图片 AI 模型');
            const directorInput = { name: current.name, background: current.background, speakingStyle: current.speakingStyle, expertise: current.expertise, group: current.group, personality: current.personality, coreProfile: current.coreProfile, visualIdentity };
            let visualPlan = buildFallbackCharacterVisualGenerationPlan(directorInput, language);
            if (!fallbackReason && isAIProfileUsable(textProfile)) {
              try {
                visualPlan = await generateCharacterVisualGenerationPlan(textProfile, directorInput, language);
              } catch (error) {
                fallbackReason = error instanceof Error ? error.message : String(error);
              }
            } else if (!fallbackReason) {
              fallbackReason = '请先配置文本 AI 模型';
            }
            const fallbackWarning = visualPlan.fallbackUsed
              ? `视觉方案生成失败，已使用基础模板。原因：${fallbackReason || '未返回有效方案'}`
              : null;
            if (fallbackWarning) {
              notifyDiagnosticToast({ message: fallbackWarning, severity: 'warning', location: 'character-library:visual-plan' });
            }
            const taskId = avatarGenerationQueue.enqueue(imageProfile, visualPlan.prompt, { targetKey: `character-visual:${current.id}`, characterId: null, errorReporting: 'caller', description: `${current.name.trim() || '未命名角色'} · 形象图${visualPlan.fallbackUsed ? '（基础模板）' : ''}`, negativePrompt: visualPlan.negativePrompt, seed: visualIdentity.seed });
            const state = await avatarGenerationQueue.waitForTask(taskId);
            if (!state.imageDataUrl) throw new Error('图片生成未返回图像');
            await api.createCharacterVisualAsset(current.id, { dataUrl: state.imageDataUrl, label: '形象图', source: 'generated', isPrimary: true });
            // 视觉资产由独立接口持久化，重新加载详情，避免同一资产同时出现在
            // visual_identity 和 character_visual_assets 中而显示重复。
            await useCharacterStore.getState().loadCharacters();
            return fallbackWarning ? { warning: fallbackWarning } : undefined;
          }
          if (field === 'avatar') {
            const imageProfile = getPreferredAIProfile(aiProfiles, 'image');
            if (!isAIProfileUsable(imageProfile)) throw new Error('请先配置图片 AI 模型');
            const taskId = await enqueueAvatarGenerationForCharacter({ id: character.id, name: character.name, background: character.background, speakingStyle: character.speakingStyle, expertise: character.expertise, group: character.group, personality: character.personality, speechProfile: character.speechProfile, coreProfile: character.coreProfile, visualIdentity: character.visualIdentity }, aiProfiles, i18n.language.startsWith('zh') ? 'zh' : 'en', avatarGeneration, { targetKey: `character:${character.id}`, characterId: character.id, errorReporting: 'caller' });
            await avatarGenerationQueue.waitForTask(taskId);
          }
        },
      });
    }));
    setCompletionOpen(false);
    resetSelection();
    setSnackbar({ open: true, message: '已加入补全队列', severity: 'success' });
  };

  const handleStartDirectChat = async (characterId: string, characterName: string) => {
    const existing = chats.find((chat) => chat.type === 'direct' && chat.memberIds.length === 1 && chat.memberIds[0] === characterId);
    if (existing) {
      navigate(`/chats/${existing.id}?fromTab=1`);
      return;
    }
    const chat = await addChat(buildDirectChatDraft(characterId, characterName));
    navigate(`/chats/${chat.id}?fromTab=1`);
  };

  const clearGroupPressTimer = () => {
    if (groupPressTimerRef.current !== null) {
      window.clearTimeout(groupPressTimerRef.current);
      groupPressTimerRef.current = null;
    }
  };

  const startGroupLongPress = (group: string) => {
    clearGroupPressTimer();
    groupPressTimerRef.current = window.setTimeout(() => {
      setGroupActionTarget(group);
      setGroupActionDialogOpen(true);
      clearGroupPressTimer();
    }, 450);
  };

  const handleBulkDeleteConfirm = async () => {
    try {
      await applyBulkDelete();
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '已删除' : 'Deleted', severity: 'success' });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
    }
  };

  const handleSingleDeleteConfirm = async () => {
    if (!deleteId) return;
    try {
      await deleteCharacter(deleteId);
      resetCardLibrary();
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '已删除' : 'Deleted', severity: 'success' });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
    } finally {
      setDeleteId(null);
    }
  };

  const openCreateForm = () => {
    if (characterLimitReached) {
      setVipLimitDialog({
        title: '角色数量已达上限',
        description: '当前会员的角色数量已经达到上限。升级 VIP 后可以创建更多角色，也可以先删除不需要的角色。',
        current: custom.length,
        limit: maxCharacters,
      });
      return;
    }
    navigate('/characters/create');
  };

  const handleExport = useCallback(() => {
    const data = JSON.stringify(custom, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pneumata-characters.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [custom]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const chars = Array.isArray(data) ? data : [data];
        if (maxCharacters != null && maxCharacters >= 0 && custom.length + chars.length > maxCharacters) {
          setVipLimitDialog({
            title: '导入会超过角色上限',
            description: `本次准备导入 ${chars.length} 个角色，导入后会超过当前会员的角色数量上限。请减少导入数量，或升级 VIP 后继续导入。`,
            current: custom.length + chars.length,
            limit: maxCharacters,
            helperText: `当前已有 ${custom.length} 个角色。`,
          });
          return;
        }
        await importCharacters(chars);
        setSnackbar({ open: true, message: t('character.importSuccess'), severity: 'success' });
      } catch (error) {
        setSnackbar({ open: true, message: error instanceof Error ? error.message : t('character.importError'), severity: 'error' });
      }
    };
    input.click();
  }, [custom, importCharacters, maxCharacters, t]);

  useEffect(() => {
    setHideMobileBottomNav(false);
    setHeaderBackAction(null);
    setHeaderTitle(null);
    setHeaderActions(
      <CharacterLibraryHeaderActions
        customCount={custom.length}
        sortField={sortField}
        sortDirection={sortDirection}
        sortGroupFirst={sortGroupFirst}
        view={view}
        onSortFieldChange={setSortField}
        onSortDirectionChange={setSortDirection}
        onToggleSortGroupFirst={() => setSortGroupFirst((value) => !value)}
        onViewChange={setView}
        onImport={handleImport}
        onExport={handleExport}
        selectionMode={selectionMode}
        selectedCount={selectedIds.length}
        onExitSelection={resetSelection}
        onSelectAll={handleSelectAllCharacters}
        onDeleteSelected={() => setBulkDeleteOpen(true)}
        onChangeGroup={() => setBulkGroupDialogOpen(true)}
        onCompleteSelected={openCompletionDialog}
      />
    );

  }, [custom.length, i18n.language, selectedIds.length, selectionMode, sortDirection, sortField, sortGroupFirst, view]);

  useEffect(() => () => {
    setHeaderActions(null);
    setHeaderTitle(null);
    setHeaderBackAction(null);
    setHideMobileBottomNav(false);
  }, [setHeaderActions, setHeaderTitle, setHeaderBackAction, setHideMobileBottomNav]);

  return (
    <Box sx={{ position: 'relative', containerType: 'inline-size', px: { xs: 1.5, sm: 3 }, py: 3, pt: { xs: 1, sm: 1, md: 3 }, pb: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 82px)', sm: 12 } }}>
      {loadError || duplicateCharacterCount > 0 ? (
        <Box sx={buildFloatingTabContainerSx()}>
          {loadError ? (
            <Alert
              severity="error"
              sx={{ mb: 2 }}
              action={<Button color="inherit" size="small" onClick={() => {
                void loadCharacters()
                  .then(() => setLoadError(null))
                  .catch((error) => setLoadError(error instanceof Error ? error.message : (i18n.language.startsWith('zh') ? '角色加载失败' : 'Failed to load characters')));
              }}>{i18n.language.startsWith('zh') ? '重试' : 'Retry'}</Button>}
            >
              {loadError}
            </Alert>
          ) : null}
          {duplicateCharacterCount > 0 ? (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Typography variant="body2">{duplicateCharacterBannerText}</Typography>
              {duplicateCharacterGroups.length ? (
                <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 1 }}>
                  {duplicateCharacterGroups.map((group) => (
                    <Chip
                      key={normalizeCharacterName(group.name)}
                      size="small"
                      variant="outlined"
                      color="warning"
                      label={`${group.name}：${group.description}`}
                      sx={{ maxWidth: '100%', '& .MuiChip-label': { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }}
                    />
                  ))}
                </Box>
              ) : null}
            </Alert>
          ) : null}
        </Box>
      ) : null}

      <CharacterGroupFilterBar
        collapsible
        allLabel={i18n.language.startsWith('zh') ? '全部' : 'All'}
        allValue="all"
        allCount={custom.length}
        options={customGroupOptions}
        selectedValue={selectedGroup}
        onSelect={(value) => setSelectedGroup(value || 'all')}
        onGroupPointerDown={(group) => {
          if (canDeleteCharacterGroup(group)) {
            startGroupLongPress(group);
          }
        }}
        onGroupPointerUp={clearGroupPressTimer}
        onGroupPointerLeave={clearGroupPressTimer}
        onGroupPointerCancel={clearGroupPressTimer}
        sx={{ mb: 2 }}
      />
      <Box sx={{ pr: 0.5 }}>
      {characterLimitReached ? (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          {i18n.language.startsWith('zh') ? `角色数量已达当前会员上限（${custom.length}/${maxCharacters}），升级会员后可创建更多角色。` : `Character limit reached (${custom.length}/${maxCharacters}). Upgrade membership to create more characters.`}
        </Alert>
      ) : null}
      {(isLoading && characters.length === 0) || (view === 'card' && libraryLoading && libraryItems.length === 0) ? (
        <ListSkeletonGrid sx={{
          gridTemplateColumns: view === 'card' ? 'repeat(2, minmax(0, 1fr))' : { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          ...(view === 'card' ? { '@container (min-width: 640px)': { gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))' } } : {}),
          gap: { xs: 1, sm: 1.5 },
        }} />
      ) : displayChars.length === 0 ? (
        <EmptyState
          variant="plain"
          message={t('character.empty')}
          action={
            <Button variant="outlined" onClick={openCreateForm}>
              {t('character.create')}
            </Button>
          }
        />
      ) : (
        <Box
          sx={{
            ...(view === 'list' ? {
              ...buildListGridSx(),
            } : {
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              '@container (min-width: 640px)': {
                gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))',
              },
            }),
            gap: { xs: 1, sm: 1.5 },
            alignItems: 'stretch',
          }}
        >
          {visibleDisplayChars.map((char) => {
            const cardProps = {
              character: char,
              selected: selectedIdSet.has(char.id) || activeCharacterId === char.id,
              selectable: true,
              selectionMode,
              onLongPress: () => enterSelectionMode(char.id),
              onEdit: () => navigate(`/characters/${char.id}/edit`),
              onDelete: () => setDeleteId(char.id),
              onStartDirectChat: !selectionMode ? () => void handleStartDirectChat(char.id, char.name) : undefined,
              onClick: () => {
                if (selectionMode) {
                  toggleSelection(char.id);
                  return;
                }
                navigate(`/characters/${char.id}/edit`);
              },
            };
            return view === 'card'
              ? <CharacterShowcaseCard key={char.id} {...cardProps} />
              : <CharacterCard key={char.id} {...cardProps} />;
          })}
        </Box>
      )}
      {hasMoreCharacters ? <Box ref={characterLoadMoreRef} sx={{ height: 1 }} aria-label={i18n.language.startsWith('zh') ? '正在加载更多角色' : 'Loading more characters'} /> : null}

      </Box>

      <ConfirmDialog
        open={Boolean(deleteId)}
        title={t('character.delete')}
        message={t('character.deleteConfirm')}
        onConfirm={handleSingleDeleteConfirm}
        onCancel={() => setDeleteId(null)}
        destructive
        loadingLabel="删除中"
      />

      <Dialog open={completionOpen} onClose={() => { if (!clearingData) setCompletionOpen(false); }} maxWidth="sm" fullWidth>
        <DialogTitle>批量补全</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'grid', gap: 0.35 }}>
            {completionFields.map((field) => {
              const missingCount = selectedCustomCharacters.filter((character) => isCompletionMissing(character, field)).length;
              const checked = completionFieldsSelected.includes(field);
              const disabled = isCompletionFieldDisabled(field);
              return (
                <FormControlLabel
                  key={field}
                  disabled={disabled || clearingData}
                  control={<Checkbox checked={checked} onChange={() => setCompletionFieldsSelected((current) => checked ? current.filter((item) => item !== field) : [...current, field])} />}
                  label={`${completionFieldLabels[field]}（${missingCount}/${selectedCustomCharacters.length}）`}
                />
              );
            })}
          </Box>
          <FormControl disabled={clearingData} sx={{ mt: 2 }}>
            <FormLabel>处理方式</FormLabel>
            <RadioGroup row value={completionMode} onChange={(event) => setCompletionMode(event.target.value as CharacterCompletionMode)} sx={{ flexWrap: 'wrap', gap: 1 }}>
              <Tooltip title="只处理完全没有内容的项目，不改已有内容" placement="right">
                <FormControlLabel value="empty" control={<Radio />} label="仅空数据" sx={{ mr: 0, whiteSpace: 'nowrap' }} />
              </Tooltip>
              <Tooltip title="补齐缺失部分，保留你已经填写的内容" placement="right">
                <FormControlLabel value="complete" control={<Radio />} label="补全信息" sx={{ mr: 0, whiteSpace: 'nowrap' }} />
              </Tooltip>
              <Tooltip title="基于现有设定重新生成，可替换已有图片" placement="right">
                <FormControlLabel value="regenerate" control={<Radio />} label="重新生成" sx={{ mr: 0, whiteSpace: 'nowrap' }} />
              </Tooltip>
              <Tooltip title="删除勾选项目的数据，不重新生成" placement="right">
                <FormControlLabel value="clear" control={<Radio />} label="清空" sx={{ mr: 0, whiteSpace: 'nowrap' }} />
              </Tooltip>
            </RadioGroup>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button disabled={clearingData} onClick={() => setCompletionOpen(false)}>取消</Button>
          <Button variant="contained" color={completionMode === 'clear' ? 'error' : 'primary'} onClick={enqueueCompletion} disabled={clearingData || !completionFieldsSelected.some((field) => !isCompletionFieldDisabled(field)) || !selectedCustomCharacters.length}>{clearingData ? '清空中' : completionMode === 'clear' ? '清空所选数据' : '确认'}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={bulkGroupDialogOpen} onClose={() => setBulkGroupDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{i18n.language.startsWith('zh') ? '更改分组' : 'Change group'}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'grid', gap: 1.5, pt: 1 }}>
            <TextField label={i18n.language.startsWith('zh') ? '分组名' : 'Group'} value={bulkGroupValue} onChange={(e) => setBulkGroupValue(e.target.value)} fullWidth />
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
              {customGroups.map((group) => <Chip key={group} label={group} size="small" variant={normalizeCharacterGroup(bulkGroupValue) === group ? 'filled' : 'outlined'} color={normalizeCharacterGroup(bulkGroupValue) === group ? 'primary' : 'default'} onClick={() => setBulkGroupValue(group)} />)}
              <Chip label={i18n.language.startsWith('zh') ? '清空分组' : 'Clear group'} size="small" variant="outlined" onClick={() => setBulkGroupValue('')} />
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkGroupDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={applyBulkGroup} variant="contained">{t('common.confirm')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={groupActionDialogOpen} onClose={() => setGroupActionDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{groupActionTarget}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">{i18n.language.startsWith('zh') ? '请选择如何处理这个分组。' : 'Choose how to handle this group.'}</Typography>
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'space-between', px: 3, pb: 2 }}>
          <Button onClick={() => handleGroupAction('clear')}>{i18n.language.startsWith('zh') ? '清空分组' : 'Clear group'}</Button>
          <Button color="error" variant="contained" onClick={() => handleGroupAction('delete')}>{i18n.language.startsWith('zh') ? '删除该组角色' : 'Delete characters'}</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={bulkDeleteOpen}
        title={i18n.language.startsWith('zh') ? '批量删除角色' : 'Delete selected characters'}
        message={i18n.language.startsWith('zh') ? `确认删除 ${selectedCustomCharacters.length} 个角色吗？` : `Delete ${selectedCustomCharacters.length} selected characters?`}
        onConfirm={handleBulkDeleteConfirm}
        onCancel={() => setBulkDeleteOpen(false)}
        destructive
      />

      <AppSnackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        severity={snackbar.severity}
        message={snackbar.message}
      />
      <VipLimitDialog
        open={Boolean(vipLimitDialog)}
        title={vipLimitDialog?.title || ''}
        description={vipLimitDialog?.description || ''}
        current={vipLimitDialog?.current}
        limit={vipLimitDialog?.limit}
        helperText={vipLimitDialog?.helperText}
        onClose={() => setVipLimitDialog(null)}
      />

      <ExpandableFab
        icon={<AddIcon />}
        label={t('character.create')}
        ariaLabel={t('character.create')}
        onClick={openCreateForm}
        sx={floatingActionPositionSx}
      />
    </Box>
  );
}
