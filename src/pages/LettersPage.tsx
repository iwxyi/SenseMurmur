import { useEffect, useMemo, useState } from 'react';
import { Badge, Box, FormControl, InputLabel, MenuItem, Select, Stack } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import { useCharacterStore } from '../stores/useCharacterStore';
import { ensureCharacterArtifactStoreHydrated, useCharacterArtifactStore, type CharacterArtifactEntry } from '../stores/useCharacterArtifactStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import FloatingSegmentedTabs from '../components/common/FloatingSegmentedTabs';
import { buildFloatingTabContainerSx } from '../components/common/FloatingSegmentedTabs.styles';
import AnimatedTabContent from '../components/common/AnimatedTabContent';
import { resolveTabTransitionDirection } from '../components/common/tabTransition';
import ArtifactCalendarReader from '../components/artifacts/ArtifactCalendarReader';
import AppSnackbar from '../components/common/AppSnackbar';
import { readPersistentUiValue, writePersistentUiValue } from '../utils/persistentUiState';
import { reportUnresolvedDisplayEntity } from '../services/diagnostics';

type LettersTab = 'letters' | 'diary';
const LETTERS_TAB_KEY = 'letters-tab';
const LETTERS_TAB_ORDER = ['letters', 'diary'] as const;
const isLettersTab = (value: unknown): value is LettersTab => value === 'letters' || value === 'diary';
const isLikelyUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function buildCharacterOptions(items: CharacterArtifactEntry[], nameMap: Map<string, string>, language: string) {
  const counts = new Map<string, number>();
  items.forEach((item) => counts.set(item.characterId, (counts.get(item.characterId) || 0) + 1));
  return [
    { id: 'all', label: language.startsWith('zh') ? `全部(${items.length})` : `All (${items.length})`, count: items.length },
    ...Array.from(counts.entries())
      .map(([id, count]) => {
        const fallbackName = isLikelyUuid(id) ? (language.startsWith('zh') ? '未知角色' : 'Unknown role') : id;
        const resolvedName = nameMap.get(id) || items.find((item) => item.characterId === id)?.characterName;
        if (!resolvedName) {
          reportUnresolvedDisplayEntity({ id, kind: 'character', location: 'LettersPage.characterOptions', fallback: fallbackName });
        }
        return { id, label: `${resolvedName || fallbackName}(${count})`, count };
      })
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, language.startsWith('zh') ? 'zh-Hans-CN' : 'en-US')),
  ];
}

export default function LettersPage() {
  const { i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const { setHeaderTitle, setHeaderBackAction, setHideMobileBottomNav } = useLayoutHeaderActions();
  const characters = useCharacterStore((state) => state.characters);
  const items = useCharacterArtifactStore((state) => state.items);
  const unreadLetterCount = useCharacterArtifactStore((state) => state.unreadLetterCount);
  const markLetterRead = useCharacterArtifactStore((state) => state.markLetterRead);
  const regenerateArtifact = useCharacterArtifactStore((state) => state.regenerateArtifact);
  const ensureArtifactDetail = useCharacterArtifactStore((state) => state.ensureArtifactDetail);
  const syncArtifactsFromCharacters = useCharacterArtifactStore((state) => state.syncCharacters);
  const syncArtifactCloud = useCharacterArtifactStore((state) => state.syncCloud);
  const resumeArtifactProcessing = useCharacterArtifactStore((state) => state.resumeProcessing);
  const paperVariant = useSettingsStore((state) => state.artifactAppearance.paperVariant);
  const developerMode = useSettingsStore((state) => state.developerMode);
  const [tab, setTab] = useState<LettersTab>(() => isLettersTab(requestedTab) ? requestedTab : readPersistentUiValue(LETTERS_TAB_KEY, 'letters', isLettersTab));
  const [tabTransitionDirection, setTabTransitionDirection] = useState<-1 | 1>(1);
  const [characterFilter, setCharacterFilter] = useState('all');
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });
  const readerHeight = 'clamp(420px, calc(100dvh - 180px), 1040px)';

  useEffect(() => {
    setHeaderTitle(i18n.language.startsWith('zh') ? '信件' : 'Letters');
    setHeaderBackAction(null);
    setHideMobileBottomNav(false);
    return () => {
      setHeaderTitle(null);
      setHeaderBackAction(null);
      setHideMobileBottomNav(false);
    };
  }, [i18n.language, setHeaderBackAction, setHeaderTitle, setHideMobileBottomNav]);

  useEffect(() => {
    let cancelled = false;
    void ensureCharacterArtifactStoreHydrated().then(() => {
      if (cancelled) return;
      syncArtifactsFromCharacters(useCharacterStore.getState().characters);
      void resumeArtifactProcessing();
      void syncArtifactCloud();
    });
    return () => {
      cancelled = true;
    };
  }, [resumeArtifactProcessing, syncArtifactCloud, syncArtifactsFromCharacters, tab]);

  const letters = useMemo(() => items.filter((item) => item.deletedAt == null && (item.kind === 'birth_letter' || item.kind === 'final_letter')).slice().sort((a, b) => b.createdAt - a.createdAt), [items]);
  const diaries = useMemo(() => items.filter((item) => item.deletedAt == null && item.kind === 'diary').slice().sort((a, b) => (a.dateKey || '').localeCompare(b.dateKey || '') || a.createdAt - b.createdAt), [items]);
  const deletedLetters = useMemo(() => items.filter((item) => item.deletedAt != null && (item.kind === 'birth_letter' || item.kind === 'final_letter')), [items]);
  const deletedDiaries = useMemo(() => items.filter((item) => item.deletedAt != null && item.kind === 'diary'), [items]);
  const activeItems = tab === 'letters' ? letters : diaries;
  const deletedActiveItems = tab === 'letters' ? deletedLetters : deletedDiaries;
  const characterNameMap = useMemo(() => new Map(characters.map((character) => [character.id, character.name])), [characters]);
  const characterOptions = useMemo(() => buildCharacterOptions(activeItems, characterNameMap, i18n.language), [activeItems, characterNameMap, i18n.language]);
  const visibleItems = useMemo(() => characterFilter === 'all' ? activeItems : activeItems.filter((item) => item.characterId === characterFilter), [activeItems, characterFilter]);
  const visibleDeletedItems = useMemo(() => characterFilter === 'all' ? deletedActiveItems : deletedActiveItems.filter((item) => item.characterId === characterFilter), [deletedActiveItems, characterFilter]);
  const characterById = useMemo(() => new Map(characters.map((character) => [character.id, character])), [characters]);

  const handleRegenerateDebug = async (item: CharacterArtifactEntry) => {
    try {
      const character = characterById.get(item.characterId) || null;
      const relatedCharacters = character
        ? (character.relationships || [])
            .map((relation) => characterById.get(relation.characterId))
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
            .map((entry) => ({ id: entry.id, name: entry.name }))
        : [];
      await regenerateArtifact({ itemId: item.id, character, relatedCharacters });
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '已重新生成' : 'Regenerated', severity: 'success' });
    } catch (error) {
      console.error('Failed to regenerate character artifact:', { item, error });
      setSnackbar({ open: true, message: error instanceof Error ? error.message : (i18n.language.startsWith('zh') ? '重新生成失败' : 'Regeneration failed'), severity: 'error' });
    }
  };

  useEffect(() => {
    setCharacterFilter('all');
    writePersistentUiValue(LETTERS_TAB_KEY, tab);
  }, [tab]);

  useEffect(() => {
    if (isLettersTab(requestedTab)) setTab(requestedTab);
  }, [requestedTab]);

  useEffect(() => {
    if (characterFilter !== 'all' && !characterOptions.some((option) => option.id === characterFilter)) {
      setCharacterFilter('all');
    }
  }, [characterFilter, characterOptions]);

  return (
    <Box
      sx={{
        p: 3,
        pt: { xs: 1, sm: 1, md: 3 },
        pb: { xs: 'calc(82px + env(safe-area-inset-bottom, 0px))', sm: 3 },
        width: '100%',
        maxWidth: 1240,
        mx: 'auto',
      }}
    >
      <Stack spacing={2}>
        <Box
          sx={{ ...buildFloatingTabContainerSx(), alignItems: 'stretch' }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: { xs: 1.25, sm: 2 },
              minWidth: 0,
              width: '100%',
            }}
          >
            <FloatingSegmentedTabs
              value={tab}
              scrollContentToTopOnChange
              onChange={(nextTab) => {
                setTabTransitionDirection(resolveTabTransitionDirection(LETTERS_TAB_ORDER, tab, nextTab));
                setTab(nextTab);
              }}
              items={[
                {
                  value: 'letters',
                  label: (
                    <Badge badgeContent={unreadLetterCount} color="error" max={99}>
                      <span>{i18n.language.startsWith('zh') ? '信件' : 'Letters'}</span>
                    </Badge>
                  ),
                },
                { value: 'diary', label: i18n.language.startsWith('zh') ? '日记' : 'Diary' },
              ]}
            />
            <FormControl
              size="small"
              sx={{
                ml: 'auto',
                flex: '0 1 auto',
                width: { xs: 'clamp(112px, 34vw, 152px)', sm: 'clamp(150px, 24vw, 220px)' },
                minWidth: { xs: 112, sm: 150 },
                maxWidth: { xs: 152, sm: 220 },
                '& .MuiOutlinedInput-root': {
                  borderRadius: '14px',
                  bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.64)' : 'rgba(16,18,26,0.58)',
                  backdropFilter: 'blur(18px) saturate(1.05)',
                  WebkitBackdropFilter: 'blur(18px) saturate(1.05)',
                  boxShadow: (theme: Theme) => theme.palette.mode === 'light'
                    ? '0 10px 24px rgba(15,23,42,0.06), 0 1px 0 rgba(255,255,255,0.7) inset'
                    : '0 12px 28px rgba(0,0,0,0.22), 0 1px 0 rgba(255,255,255,0.05) inset',
                },
                '& .MuiOutlinedInput-notchedOutline': {
                  borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.11)' : 'rgba(226,232,240,0.12)',
                },
                '& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline': {
                  borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.34)' : 'rgba(120,156,220,0.28)',
                },
              }}
            >
              <InputLabel>{i18n.language.startsWith('zh') ? '角色' : 'Character'}</InputLabel>
              <Select
                label={i18n.language.startsWith('zh') ? '角色' : 'Character'}
                value={characterFilter}
                onChange={(event) => setCharacterFilter(event.target.value)}
                sx={{
                  minWidth: 0,
                  '& .MuiSelect-select': {
                    minWidth: 0,
                    px: { xs: 1, sm: 1.75 },
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                }}
              >
                {characterOptions.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
              </Select>
            </FormControl>
          </Box>
        </Box>

        <AnimatedTabContent value={tab} direction={tabTransitionDirection}>
          <ArtifactCalendarReader
            items={visibleItems}
            deletedItems={visibleDeletedItems}
            language={i18n.language}
            paperVariant={paperVariant}
            readerHeight={readerHeight}
            countUnit={i18n.language.startsWith('zh') ? (tab === 'letters' ? '封' : '篇') : ''}
            showDayCharacters={characterFilter === 'all'}
            emptyTitle={tab === 'letters'
              ? (i18n.language.startsWith('zh') ? '还没有寄出的信' : 'No letters have arrived yet')
              : (i18n.language.startsWith('zh') ? '还没有写下的日记' : 'No diary pages yet')}
            emptyDescription={tab === 'letters'
              ? (i18n.language.startsWith('zh') ? '等角色真正经历过相遇、告别、牵挂和改变，这里会留下它们想认真说完的话。' : 'When a character has lived through enough meetings, partings, attachments, and change, the words they need to finish will rest here.')
              : (i18n.language.startsWith('zh') ? '日记不会急着出现。它会等某一天的关系余波、没说出口的话，或一点明天还想继续的理由。' : 'Diaries are not rushed. They wait for relationship residue, unsent words, or one small reason to keep going tomorrow.')}
            getTitle={(item) => item.kind === 'diary' ? characterNameMap.get(item.characterId) || item.characterName : item.title}
            getMeta={(item) => item.dateKey || new Date(item.createdAt).toLocaleDateString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US')}
            onRegenerateDebug={developerMode ? handleRegenerateDebug : undefined}
            onEnsureDetail={ensureArtifactDetail}
            onRead={tab === 'letters' ? markLetterRead : undefined}
          />
        </AnimatedTabContent>
      </Stack>
      <AppSnackbar
        open={snackbar.open}
        message={snackbar.message}
        severity={snackbar.severity}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
      />
    </Box>
  );
}
