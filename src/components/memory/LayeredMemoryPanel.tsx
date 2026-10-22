import { useMemo, useState, type ReactNode } from 'react';
import { Box, Button, Checkbox, Chip, Dialog, DialogContent, DialogTitle, FormControlLabel, IconButton, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useTranslation } from 'react-i18next';
import SurfaceCard from '../common/SurfaceCard';
import SectionHeader from '../common/SectionHeader';
import StatChipRow from '../common/StatChipRow';
import DebugChip from '../common/DebugChip';
import type { MemoryItem } from '../../services/memoryTypes';
import type { DisplayTextMember } from '../../services/displayTextSanitizer';
import {
  buildLayeredMemoryFilters,
  buildLayeredMemoryGroups,
  filterVisibleLayeredMemories,
  localizeLayeredMemoryPanelText,
  projectLayeredMemoryItem,
  selectLayeredMemoryItems,
  type LayeredMemoryCategoryKey,
  type LayeredMemoryScopeFilterKey,
} from '../../services/layeredMemoryPresentation';

function MemoryCard({
  item,
  includeDebugDetails,
  language,
  formatMemoryText,
  members = [],
  hideEvidenceTooltip = false,
}: {
  item: MemoryItem;
  includeDebugDetails: boolean;
  language: string;
  formatMemoryText?: (text: string, item: MemoryItem) => string;
  members?: DisplayTextMember[];
  hideEvidenceTooltip?: boolean;
}) {
  const presented = projectLayeredMemoryItem({ item, includeDebugDetails, language, formatMemoryText, members });
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const previewEvidenceItems = presented.evidenceItems.filter((entry) => entry.weight >= 0.55).slice(0, 3);
  const tooltipEvidenceItems = previewEvidenceItems.length ? previewEvidenceItems : presented.evidenceItems.slice(0, 2);
  const showEvidenceIcon = !hideEvidenceTooltip && presented.evidenceItems.length > 0;
  const evidenceTooltip = tooltipEvidenceItems.length ? (
    <Stack component="span" spacing={0.75} sx={{ maxWidth: 360 }}>
      {tooltipEvidenceItems.map((entry, index) => (
        <Box
          component="span"
          key={`${entry.text}-${index}`}
          sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 0.75, whiteSpace: 'pre-wrap' }}
        >
          <Box component="span" sx={{ opacity: 0.68, fontVariantNumeric: 'tabular-nums' }}>{index + 1}.</Box>
          <Box component="span">{entry.text}</Box>
        </Box>
      ))}
      {presented.evidenceItems.length > tooltipEvidenceItems.length ? (
        <Box component="span" sx={{ display: 'block', color: 'rgba(255,255,255,0.72)' }}>
          {language.startsWith('zh') ? `还有 ${presented.evidenceItems.length - tooltipEvidenceItems.length} 条，点击图标查看全部` : `${presented.evidenceItems.length - tooltipEvidenceItems.length} more, click the icon to view all`}
        </Box>
      ) : null}
    </Stack>
  ) : '';
  return (
    <>
      <Box sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2, bgcolor: item.archivedAt ? 'transparent' : 'action.hover', border: '1px solid', borderColor: item.archivedAt ? 'divider' : 'rgba(148, 163, 184, 0.12)', opacity: item.archivedAt ? 0.72 : 1, minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
        <Stack spacing={0.6} sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, minWidth: 0 }}>
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontWeight: 700, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{presented.displayText}</Typography>
            {showEvidenceIcon ? (
              <Tooltip title={evidenceTooltip} arrow placement="top-start">
                <IconButton
                  size="small"
                  aria-label={language.startsWith('zh') ? '查看证据' : 'View evidence'}
                  onClick={() => setEvidenceOpen(true)}
                  sx={{
                    mt: -0.25,
                    mr: -0.35,
                    width: 24,
                    height: 24,
                    color: 'text.secondary',
                    opacity: 0.72,
                    '&:hover': { opacity: 1, color: 'primary.main', bgcolor: 'action.hover' },
                  }}
                >
                  <InfoOutlinedIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            ) : null}
          </Box>
          <StatChipRow items={presented.metaItems} />
          {includeDebugDetails ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', opacity: 0.85, overflowWrap: 'anywhere' }}>{presented.debugText}</Typography> : null}
        </Stack>
      </Box>
      <Dialog
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        fullWidth
        maxWidth="sm"
        slotProps={{
          paper: {
            sx: {
              borderRadius: 2,
              overflow: 'hidden',
              border: '1px solid',
              borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15, 23, 42, 0.10)' : 'rgba(226, 232, 240, 0.12)',
              bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.82)' : 'rgba(18,20,28,0.84)',
              backdropFilter: 'blur(24px) saturate(1.12)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.12)',
              boxShadow: (theme) => theme.palette.mode === 'light'
                ? '0 24px 80px rgba(15, 23, 42, 0.16)'
                : '0 24px 80px rgba(0,0,0,0.42)',
            },
          },
          backdrop: {
            sx: {
              bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(15, 23, 42, 0.16)' : 'rgba(0,0,0,0.34)',
              backdropFilter: 'blur(4px)',
              WebkitBackdropFilter: 'blur(4px)',
            },
          },
        }}
      >
        <DialogTitle
          sx={{
            pr: 6,
            pb: 1,
            borderBottom: '1px solid',
            borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15, 23, 42, 0.08)' : 'rgba(226, 232, 240, 0.10)',
          }}
        >
          <Stack spacing={0.25}>
            <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>{language.startsWith('zh') ? '记忆证据' : 'Memory Evidence'}</Typography>
            <Typography variant="caption" color="text.secondary">
              {language.startsWith('zh') ? `${presented.evidenceItems.length} 条来源线索` : `${presented.evidenceItems.length} evidence sources`}
            </Typography>
          </Stack>
          <IconButton
            aria-label={language.startsWith('zh') ? '关闭' : 'Close'}
            onClick={() => setEvidenceOpen(false)}
            sx={{
              position: 'absolute',
              right: 12,
              top: 12,
              width: 32,
              height: 32,
              color: 'text.secondary',
              '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
            }}
          >
            <CloseRoundedIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ px: { xs: 2, sm: 2.5 }, py: { xs: 1.25, sm: 1.5 } }}>
          <Stack
            spacing={0}
            sx={{
              border: '1px solid',
              borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15, 23, 42, 0.08)' : 'rgba(226, 232, 240, 0.10)',
              borderRadius: 1.5,
              overflow: 'hidden',
              bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.035)',
            }}
          >
            {presented.evidenceItems.map((entry, index) => (
              <Box
                key={`${entry.text}-${index}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '28px minmax(0, 1fr)',
                  gap: 1.25,
                  alignItems: 'flex-start',
                  px: { xs: 1.15, sm: 1.35 },
                  py: { xs: 1.15, sm: 1.25 },
                  borderBottom: index === presented.evidenceItems.length - 1 ? 0 : '1px solid',
                  borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15, 23, 42, 0.07)' : 'rgba(226, 232, 240, 0.08)',
                }}
              >
                <Box
                  sx={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    mt: 0.1,
                    fontSize: 12,
                    fontWeight: 800,
                    fontVariantNumeric: 'tabular-nums',
                    color: 'primary.main',
                    border: '1px solid',
                    borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(43, 92, 255, 0.22)' : 'rgba(125, 166, 255, 0.28)',
                    bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(43, 92, 255, 0.06)' : 'rgba(125, 166, 255, 0.10)',
                  }}
                >
                  {index + 1}
                </Box>
                <Typography variant="body2" sx={{ color: 'text.primary', lineHeight: 1.75, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {entry.text}
                </Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface LayeredMemoryPanelProps {
  memories: MemoryItem[];
  title?: string;
  emptyText?: string;
  collapsedCount?: number;
  expandedCount?: number;
  showAll?: boolean;
  includeRuntimeEvidence?: boolean;
  showDebugChip?: boolean;
  hideEvidenceTooltip?: boolean;
  hideFilterHints?: boolean;
  formatMemoryText?: (text: string, item: MemoryItem) => string;
  members?: DisplayTextMember[];
  detailedFacts?: ReactNode;
  detailedFactsCount?: number;
}

export default function LayeredMemoryPanel({
  memories,
  title = '长期记忆',
  emptyText = '暂无结构化记忆',
  collapsedCount = 4,
  expandedCount = 12,
  showAll = false,
  includeRuntimeEvidence = false,
  showDebugChip = true,
  hideEvidenceTooltip = false,
  hideFilterHints = false,
  formatMemoryText,
  members = [],
  detailedFacts,
  detailedFactsCount,
}: LayeredMemoryPanelProps) {
  const { i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [activeFilter, setActiveFilter] = useState<LayeredMemoryCategoryKey | 'detailedFacts'>('all');
  const [scopeFilter, setScopeFilter] = useState<LayeredMemoryScopeFilterKey>('all');
  const [anchorsOnly, setAnchorsOnly] = useState(false);
  const language = i18n.language;
  const visibleSourceMemories = useMemo(
    () => filterVisibleLayeredMemories(memories, includeRuntimeEvidence),
    [includeRuntimeEvidence, memories],
  );
  const groups = useMemo(() => buildLayeredMemoryGroups(visibleSourceMemories), [visibleSourceMemories]);
  const filters = useMemo(() => buildLayeredMemoryFilters(groups, includeRuntimeEvidence, language), [groups, includeRuntimeEvidence, language]);
  const categoryFilters = filters.filter((filter) => !['anchors', 'relationship', 'self', 'conversation'].includes(filter.key));
  const scopeFilters = filters.filter((filter) => ['all', 'relationship', 'self', 'conversation'].includes(filter.key));
  const selectedFilter = activeFilter === 'detailedFacts' && detailedFacts ? 'detailedFacts'
    : categoryFilters.some((filter) => filter.key === activeFilter) ? activeFilter : 'all';
  const category: LayeredMemoryCategoryKey = selectedFilter === 'detailedFacts' ? 'all' : selectedFilter;
  const filteredMemories = useMemo(() => {
    return selectLayeredMemoryItems(groups, category, scopeFilter, anchorsOnly);
  }, [groups, category, scopeFilter, anchorsOnly]);
  const activeMeta = filters.find((item) => item.key === category);
  const visibleMemories = showAll ? filteredMemories : expanded ? filteredMemories.slice(0, expandedCount) : filteredMemories.slice(0, collapsedCount);
  const displayTitle = localizeLayeredMemoryPanelText(title, language);
  const displayEmptyText = localizeLayeredMemoryPanelText(emptyText, language);

  return (
    <SurfaceCard sx={{ width: '100%', maxWidth: '100%', minWidth: 0, overflow: 'hidden' }} contentSx={{ minWidth: 0, maxWidth: '100%' }}>
      <SectionHeader title={displayTitle} dense action={includeRuntimeEvidence && showDebugChip ? <DebugChip /> : undefined} />
      <Stack spacing={1.15} sx={{ minWidth: 0, maxWidth: '100%' }}>
        {visibleSourceMemories.length || detailedFacts ? (
          <Tabs
            value={selectedFilter}
            onChange={(_, value: LayeredMemoryCategoryKey | 'detailedFacts') => {
              setActiveFilter(value);
              setExpanded(false);
              if (value !== 'all' && value !== 'longTerm') setAnchorsOnly(false);
            }}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            sx={{
              minHeight: 34,
              maxWidth: '100%',
              minWidth: 0,
              borderBottom: '1px solid',
              borderColor: 'divider',
              '& .MuiTabs-scroller': {
                maxWidth: '100%',
                overflowX: 'auto !important',
                scrollbarWidth: 'none',
                '&::-webkit-scrollbar': { display: 'none' },
              },
              '& .MuiTabs-flexContainer': { minWidth: 0 },
              '& .MuiTabs-scrollButtons': {
                width: 28,
                flexShrink: 0,
                '&.Mui-disabled': { opacity: 0.18 },
              },
              '& .MuiTab-root': {
                minWidth: 0,
                minHeight: 34,
                maxWidth: { xs: 112, sm: 160 },
                px: { xs: 0.75, sm: 1.25 },
                py: 0.5,
                fontSize: { xs: 12, sm: 13 },
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }}
          >
            {categoryFilters.map((filter) => (
              <Tab key={filter.key} value={filter.key} label={`${filter.label} ${filter.items.length}`} />
            ))}
            {detailedFacts ? <Tab value="detailedFacts" label={`${language.startsWith('zh') ? '详细事实' : 'Detailed facts'} ${detailedFactsCount ?? '…'}`} /> : null}
          </Tabs>
        ) : null}
        {selectedFilter === 'detailedFacts' ? detailedFacts : <>
        {visibleSourceMemories.length ? <Stack spacing={0.75}>
          <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
            <Typography variant="caption" color="text.secondary">{language.startsWith('zh') ? '内容范围' : 'Scope'}</Typography>
            {scopeFilters.map((filter) => <Chip key={filter.key} size="small"
              label={filter.key === 'all' ? (language.startsWith('zh') ? '不限' : 'Any') : filter.label}
              color={scopeFilter === filter.key ? 'primary' : 'default'}
              variant={scopeFilter === filter.key ? 'filled' : 'outlined'}
              aria-pressed={scopeFilter === filter.key}
              onClick={() => { setScopeFilter(filter.key as LayeredMemoryScopeFilterKey); setExpanded(false); }} />)}
            {category === 'all' || category === 'longTerm' ? <FormControlLabel
              label={language.startsWith('zh') ? '仅锚点候选' : 'Anchor candidates only'}
              sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
              control={<Checkbox size="small" checked={anchorsOnly}
                onChange={(_, checked) => { setAnchorsOnly(checked); setExpanded(false); }} />} /> : null}
          </Box>
          {!hideFilterHints ? <Typography variant="caption" color="text.secondary">{language.startsWith('zh')
            ? '层级与内容范围可组合筛选；锚点候选是长期记忆中的重要条目，并非另一份记录。'
            : 'Layer and scope filters combine. Anchor candidates are important long-term items, not separate copies.'}</Typography> : null}
        </Stack> : null}
        {!hideFilterHints && activeMeta ? <Typography variant="caption" color="text.secondary">{activeMeta.hint}</Typography> : null}
        {visibleMemories.length ? (
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            {visibleMemories.map((item) => (
              <MemoryCard
                key={item.id}
                item={item}
                includeDebugDetails={includeRuntimeEvidence}
                language={language}
                formatMemoryText={formatMemoryText}
                members={members}
                hideEvidenceTooltip={hideEvidenceTooltip}
              />
            ))}
          </Stack>
        ) : <Typography variant="caption" color="text.secondary">{displayEmptyText}</Typography>}
        {!showAll && filteredMemories.length > collapsedCount ? <Button size="small" variant="text" onClick={() => setExpanded((prev) => !prev)}>{expanded ? (language.startsWith('zh') ? '收起' : 'Collapse') : `${language.startsWith('zh') ? '查看更多' : 'Show more'} ${filteredMemories.length}`}</Button> : null}
        </>}
      </Stack>
    </SurfaceCard>
  );
}
