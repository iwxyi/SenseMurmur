import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton, MenuItem, Select, Stack, Tooltip, Typography } from '@mui/material';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import KeyboardArrowDownOutlinedIcon from '@mui/icons-material/KeyboardArrowDownOutlined';
import KeyboardArrowUpOutlinedIcon from '@mui/icons-material/KeyboardArrowUpOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import NavigateBeforeOutlinedIcon from '@mui/icons-material/NavigateBeforeOutlined';
import NavigateNextOutlinedIcon from '@mui/icons-material/NavigateNextOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import ViewAgendaOutlinedIcon from '@mui/icons-material/ViewAgendaOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import FloatingSegmentedTabs from '../common/FloatingSegmentedTabs';
import MarkdownText from '../common/MarkdownText';
import MermaidDiagram from '../common/MermaidDiagram';
import { buildScrollableRegionSx } from '../../styles/interaction';
import type { GroupChat } from '../../types/chat';
import type { AssistantArtifactItem, AssistantArtifactKind, AssistantArtifactVersion } from '../../types/assistantArtifact';
import { copyTextToClipboard } from '../../utils/clipboard';
import { ensureAssistantArtifactStoreHydrated, getAssistantArtifactCurrentContent, useAssistantArtifactStore } from '../../stores/useAssistantArtifactStore';
import { useLocalWorkspaceStore } from '../../stores/useLocalWorkspaceStore';
import type { LocalWorkspaceFileEntry } from '../../services/localWorkspaceService';
import AssistantHtmlFrame, { type AssistantHtmlInteractionPayload, type AssistantHtmlRuntimeError } from '../../features/assistantHtml/AssistantHtmlFrame';
import AssistantHtmlStaticFrame from '../../features/assistantHtml/AssistantHtmlStaticFrame';
import { getAssistantArtifactDataPreview } from '../../services/assistantArtifactData';
import { CopyTextDialog } from '../common/CopyTextDialog';

interface AssistantAgentPanelProps {
  chat: GroupChat;
  selectedArtifactId?: string | null;
  onSelectedArtifactChange?: (artifactId: string | null) => void;
  onHtmlAutosave?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onHtmlSubmit?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onHtmlRepair?: (error: AssistantHtmlRuntimeError) => void | Promise<void>;
}

const artifactKindLabels: Record<AssistantArtifactKind, string> = {
  document: '文档',
  code: '代码',
  diagram: '图表',
  html: '网页',
  table: '表格',
  json: 'JSON',
  text: '文本',
  image: '图片',
};

function ArtifactKindIcon({ kind }: { kind: AssistantArtifactKind }) {
  if (kind === 'image') return <ImageOutlinedIcon fontSize="small" />;
  if (kind === 'diagram') return <AccountTreeOutlinedIcon fontSize="small" />;
  if (kind === 'code') return <CodeOutlinedIcon fontSize="small" />;
  if (kind === 'json') return <DataObjectOutlinedIcon fontSize="small" />;
  if (kind === 'html') return <LanguageOutlinedIcon fontSize="small" />;
  if (kind === 'table') return <TableChartOutlinedIcon fontSize="small" />;
  if (kind === 'document') return <DescriptionOutlinedIcon fontSize="small" />;
  return <ArticleOutlinedIcon fontSize="small" />;
}

function formatArtifactTime(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'assistant-artifact';
}

function artifactFileExtension(item: AssistantArtifactItem) {
  const language = (item.language || '').toLowerCase();
  if (item.kind === 'html') return 'html';
  if (item.kind === 'json') return 'json';
  if (item.kind === 'table') return language === 'tsv' ? 'tsv' : 'csv';
  if (item.kind === 'diagram') {
    if (language === 'plantuml') return 'puml';
    if (language === 'dot' || language === 'graphviz') return 'dot';
    return 'mmd';
  }
  if (item.kind === 'document') return 'md';
  if (language === 'typescript' || language === 'ts') return 'ts';
  if (language === 'javascript' || language === 'js') return 'js';
  if (language === 'python' || language === 'py') return 'py';
  return language || 'txt';
}

function LearningProgressSummary({ chat }: { chat: GroupChat }) {
  const learning = chat.scenarioState?.learning;
  if (!learning) return null;
  const suggestion = learning.nextStepSuggestion;
  const items = learning.knowledgeItems || [];
  const attempts = learning.attempts || [];
  const evidence = learning.evidence || [];
  const statusLabel: Record<string, string> = { unknown: '未知', exposed: '已整理', learning: '学习中', practicing: '练习中', usable: '可使用', verified: '已核验', stale: '待复习' };
  return (
    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'primary.main', borderRadius: 1, bgcolor: 'action.selected' }}>
      <Typography variant="body2" sx={{ fontWeight: 800 }}>学习进度</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.35, lineHeight: 1.55 }}>
        目标：{learning.goal || chat.topic || '未设置'}
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
        {items.slice(0, 12).map((item) => <Chip key={item.id} size="small" label={`${item.title} · ${statusLabel[item.status] || item.status}`} variant="outlined" />)}
      {!items.length ? <Typography variant="caption" color="text.secondary">还没有知识点记录，可以先发送“整理知识点”。</Typography> : null}
      </Stack>
      {(attempts.length || evidence.length) ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          已记录 {attempts.length} 次练习提交、{evidence.length} 条学习证据
        </Typography>
      ) : null}
      {suggestion ? (
        <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" sx={{ fontWeight: 750, display: 'block' }}>建议下一步：{suggestion.title}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{suggestion.reason}</Typography>
        </Box>
      ) : null}
    </Box>
  );
}

function artifactMimeType(item: AssistantArtifactItem) {
  if (item.kind === 'html') return 'text/html;charset=utf-8';
  if (item.kind === 'json') return 'application/json;charset=utf-8';
  if (item.kind === 'table') return 'text/csv;charset=utf-8';
  if (item.kind === 'document') return 'text/markdown;charset=utf-8';
  return 'text/plain;charset=utf-8';
}

async function downloadArtifact(item: AssistantArtifactItem, content: string, version = getArtifactCurrentVersion(item)) {
  const media = version?.media?.filter((entry) => entry.url) || [];
  if (item.kind === 'image' && !media.length) throw new Error('当前版本没有可下载的图片。');
  const files = item.kind === 'image'
    ? await Promise.all(media.map(async (entry, index) => {
      const response = await fetch(entry.url!);
      if (!response.ok) throw new Error('图片下载失败，请稍后重试。');
      const blob = await response.blob();
      const mimeType = (entry.mimeType || blob.type).split(';')[0];
      const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/svg+xml' ? 'svg' : mimeType.split('/')[1] || 'png';
      return { blob, extension, suffix: media.length > 1 ? `-${index + 1}` : '' };
    }))
    : [{ blob: new Blob([content], { type: artifactMimeType(item) }), extension: artifactFileExtension(item), suffix: '' }];
  for (const { blob, extension, suffix } of files) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeFileName(item.title)}${suffix}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function getArtifactVersionContent(version: AssistantArtifactVersion | null | undefined) {
  if (!version) return '';
  if (version.files?.length) {
    return version.files
      .map((file) => `// ${file.path}\n${file.content}`)
      .join('\n\n');
  }
  return version.content || '';
}

function getArtifactCurrentVersion(item: AssistantArtifactItem) {
  const fallbackVersion = item.versions.length ? item.versions[item.versions.length - 1] : null;
  return item.versions.find((entry) => entry.id === item.currentVersionId) || fallbackVersion;
}

function getArtifactVersionLabel(item: AssistantArtifactItem, version: AssistantArtifactVersion | null) {
  if (!version) return '';
  const index = item.versions.findIndex((entry) => entry.id === version.id);
  return index >= 0 ? `${index + 1} / ${item.versions.length}` : '';
}

type ArtifactViewMode = 'list' | 'icons' | 'gallery';
type ArtifactSortMode = 'manual' | 'updated' | 'created' | 'title' | 'kind';

const artifactViewItems: Array<{ value: ArtifactViewMode; title: string; icon: ReactNode }> = [
  { value: 'list', title: '列表', icon: <ViewListOutlinedIcon fontSize="small" /> },
  { value: 'icons', title: '图标', icon: <GridViewOutlinedIcon fontSize="small" /> },
  { value: 'gallery', title: '画廊', icon: <ViewAgendaOutlinedIcon fontSize="small" /> },
];

function artifactSortValue(item: AssistantArtifactItem) {
  return typeof item.sortOrder === 'number' ? item.sortOrder : Number.MAX_SAFE_INTEGER;
}

function sortArtifacts(items: AssistantArtifactItem[], mode: ArtifactSortMode) {
  return [...items].sort((a, b) => {
    if (mode === 'manual') {
      const order = artifactSortValue(a) - artifactSortValue(b);
      if (order !== 0) return order;
      return b.updatedAt - a.updatedAt;
    }
    if (mode === 'created') return b.createdAt - a.createdAt;
    if (mode === 'title') return a.title.localeCompare(b.title, 'zh-CN');
    if (mode === 'kind') {
      const kindOrder = artifactKindLabels[a.kind].localeCompare(artifactKindLabels[b.kind], 'zh-CN');
      return kindOrder || b.updatedAt - a.updatedAt;
    }
    return b.updatedAt - a.updatedAt;
  });
}

function isRenderableMermaid(item: AssistantArtifactItem, content: string) {
  if (item.kind !== 'diagram') return false;
  const language = (item.language || '').toLowerCase();
  if (language && language !== 'mermaid') return false;
  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\b/i.test(content.trim());
}

function artifactPreviewText(item: AssistantArtifactItem) {
  const content = getAssistantArtifactCurrentContent(item).trim();
  if (!content) return '当前版本为空。';
  return content.replace(/\s+/g, ' ').slice(0, 420);
}

function AssistantDataPreview({ item, version, maxRows = 8, edgeRows = 0, showRowNumbers = false }: { item: AssistantArtifactItem; version?: AssistantArtifactVersion | null; maxRows?: number; edgeRows?: number; showRowNumbers?: boolean }) {
  const preview = getAssistantArtifactDataPreview(item, maxRows, version, edgeRows);
  if (!preview) return <Typography variant="caption" color="text.secondary">数据预览不可用。</Typography>;
  const cell = (value: unknown) => String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value)
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  if (preview.format === 'csv') {
    return (
      <Box sx={{ overflow: 'hidden', width: '100%' }}>
        <Box component="table" sx={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%', fontSize: 11, color: 'text.primary' }}>
          <Box component="thead">
          <Box component="tr">{showRowNumbers ? <Box component="th" sx={{ height: 28, pl: 1.25, pr: 1.75, py: 0, borderBottom: '1px solid', borderColor: 'divider', textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 700, lineHeight: '28px', color: 'text.secondary', minWidth: 42 }}>#</Box> : null}{preview.columns.map((column) => <Box component="th" key={column} sx={{ height: 28, px: 0.75, py: 0, borderBottom: '1px solid', borderColor: 'divider', textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 700, lineHeight: '28px' }}>{column}</Box>)}</Box>
          </Box>
          <Box component="tbody">
            {preview.rows.map((row, index) => (
              <Fragment key={index}>
                {preview.omittedRows > 0 && edgeRows > 0 && index === Math.min(edgeRows, preview.rows.length) ? (
                  <Box component="tr"><Box component="td" colSpan={preview.columns.length + (showRowNumbers ? 1 : 0)} sx={{ height: 24, px: 0.75, borderBottom: '1px solid', borderColor: 'divider', color: 'text.secondary', textAlign: 'center', fontStyle: 'italic' }}>省略中间 {preview.omittedRows} 行</Box></Box>
                ) : null}
                <Box component="tr">{showRowNumbers ? <Box component="td" sx={{ height: 26, pl: 1.25, pr: 1.75, py: 0, borderBottom: '1px solid', borderColor: 'divider', textAlign: 'left', color: 'text.secondary', fontVariantNumeric: 'tabular-nums', lineHeight: '26px', minWidth: 42 }}>{index + 1}</Box> : null}{preview.columns.map((column) => <Box component="td" key={column} title={cell(row[column])} sx={{ height: 26, px: 0.75, py: 0, borderBottom: '1px solid', borderColor: 'divider', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '26px' }}>{cell(row[column])}</Box>)}</Box>
              </Fragment>
            ))}
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', height: 24, mt: 0.5, lineHeight: '24px' }}>{preview.truncated ? `预览 ${preview.rows.length} 行，共 ${preview.totalRows} 行` : `共 ${preview.totalRows} 行`}</Typography>
      </Box>
    );
  }
  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
      {preview.rows.map((row, index) => (
        <Fragment key={index}>
          {preview.omittedRows > 0 && edgeRows > 0 && index === Math.min(edgeRows, preview.rows.length) ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 0.25, fontStyle: 'italic' }}>省略中间 {preview.omittedRows} 条</Typography> : null}
          <Box sx={{ p: 0.75, border: '1px solid', borderColor: 'divider', borderRadius: 0.75, bgcolor: 'action.hover' }}>
          <Typography variant="caption" sx={{ display: 'block', fontWeight: 700, mb: 0.25 }}>记录 {index + 1}</Typography>
          <Stack spacing={0.15}>
            {preview.columns.slice(0, 8).map((column) => <Typography key={column} variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>{column}：</Box>{cell(row[column])}</Typography>)}
          </Stack>
          </Box>
        </Fragment>
      ))}
      <Typography variant="caption" color="text.secondary">{preview.truncated ? `预览 ${preview.rows.length} 条，共 ${preview.totalRows} 条` : `共 ${preview.totalRows} 条`}</Typography>
    </Stack>
  );
}

function isSelectableLocalWorkspaceFile(entry: LocalWorkspaceFileEntry) {
  if (entry.kind !== 'file') return false;
  const mimeType = (entry.mimeType || '').toLowerCase();
  if (mimeType.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/javascript', 'application/typescript'].includes(mimeType)) return true;
  return /\.(md|markdown|txt|json|jsonl|csv|tsv|xml|html|css|js|jsx|ts|tsx|mjs|cjs|py|java|go|rs|php|rb|sh|bash|zsh|sql|yaml|yml|toml|ini|env|mmd|mermaid)$/i.test(entry.path);
}

function formatFileSize(value?: number) {
  if (!Number.isFinite(value || NaN)) return '';
  const size = Number(value);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function ThumbnailFade() {
  return (
    <Box
      sx={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 34,
        pointerEvents: 'none',
        background: (theme) => theme.palette.mode === 'light'
          ? 'linear-gradient(to bottom, rgba(248,250,252,0), rgba(248,250,252,0.96))'
          : 'linear-gradient(to bottom, rgba(15,23,42,0), rgba(15,23,42,0.96))',
      }}
    />
  );
}

const EMPTY_SELECTED_LOCAL_WORKSPACE_FILE_PATHS: string[] = [];

function AssistantLocalWorkspaceFiles({ chatId, onHasFilesChange }: { chatId: string; onHasFilesChange: (hasFiles: boolean) => void }) {
  const directories = useLocalWorkspaceStore((state) => state.directories);
  const defaultDirectoryId = useLocalWorkspaceStore((state) => state.defaultDirectoryId);
  const selectedFilePaths = useLocalWorkspaceStore((state) => state.selectedFilePathsByChatId[chatId] || EMPTY_SELECTED_LOCAL_WORKSPACE_FILE_PATHS);
  const listDefaultDirectoryFiles = useLocalWorkspaceStore((state) => state.listDefaultDirectoryFiles);
  const toggleSelectedFilePath = useLocalWorkspaceStore((state) => state.toggleSelectedFilePath);
  const clearSelectedFilePaths = useLocalWorkspaceStore((state) => state.clearSelectedFilePaths);
  const [files, setFiles] = useState<LocalWorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const defaultDirectory = useMemo(() => {
    const id = defaultDirectoryId;
    return id ? directories.find((item) => item.id === id) || null : null;
  }, [defaultDirectoryId, directories]);
  const selectedSet = useMemo(() => new Set(selectedFilePaths), [selectedFilePaths]);
  const selectableFiles = useMemo(() => files.filter(isSelectableLocalWorkspaceFile)
    .sort((a, b) => a.path.localeCompare(b.path)).slice(0, 80), [files]);

  const refreshFiles = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (!defaultDirectoryId) {
      setFiles([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await listDefaultDirectoryFiles();
      if (refreshGeneration.current !== generation) return;
      setFiles(next);
      onHasFilesChange(next.some((entry) => entry.kind === 'file'));
    } catch (err) {
      if (refreshGeneration.current !== generation) return;
      setError(err instanceof Error ? err.message : '读取本地文件列表失败');
    } finally {
      if (refreshGeneration.current === generation) setLoading(false);
    }
  }, [defaultDirectoryId, listDefaultDirectoryFiles, onHasFilesChange]);

  useEffect(() => {
    setFiles([]);
    onHasFilesChange(false);
    void refreshFiles();
    return () => { refreshGeneration.current += 1; };
  }, [refreshFiles, onHasFilesChange]);

  if (!defaultDirectory) return null;

  return (
    <Box
      sx={{
        p: 1.25,
        border: '1px solid',
        borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.12)',
        borderRadius: 1,
        bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(15,23,42,0.36)',
      }}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 800 }}>本地文件</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap>
              {defaultDirectory.name} · 已选 {selectedFilePaths.length} 个
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            {selectedFilePaths.length ? (
              <Button size="small" variant="text" onClick={() => clearSelectedFilePaths(chatId)} sx={{ minWidth: 0, px: 0.75 }}>
                清空
              </Button>
            ) : null}
            <Tooltip title="刷新">
              <span>
                <IconButton size="small" disabled={loading} onClick={() => void refreshFiles()} sx={{ width: 30, height: 30 }}>
                  {loading ? <CircularProgress size={16} /> : <RefreshOutlinedIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
        {error ? <Typography variant="caption" color="error">{error}</Typography> : null}
        {!loading && !selectableFiles.length ? (
          <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.6 }}>
            当前目录没有可直接读取的文本文件。Office、PDF、图片等需要后续解析工具。
          </Typography>
        ) : (
          <Box sx={{ display: 'grid', gap: 0.5, maxHeight: 220, overflowY: 'auto', pr: 0.25, ...buildScrollableRegionSx() }}>
            {selectableFiles.map((file) => {
              const checked = selectedSet.has(file.path);
              return (
                <Box
                  key={file.path}
                  component="button"
                  type="button"
                  onClick={() => toggleSelectedFilePath(chatId, file.path)}
                  sx={{
                    width: '100%',
                    border: '1px solid',
                    borderColor: checked ? 'primary.main' : 'divider',
                    borderRadius: 1,
                    bgcolor: checked ? 'primary.main' : 'background.paper',
                    color: checked ? 'primary.contrastText' : 'text.primary',
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                    gap: 0.75,
                    alignItems: 'center',
                    p: 0.75,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <Checkbox size="small" checked={checked} tabIndex={-1} sx={{ p: 0, color: checked ? 'inherit' : undefined, '&.Mui-checked': { color: checked ? 'inherit' : undefined } }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" sx={{ fontWeight: 800, display: 'block' }} noWrap>
                      {file.name}
                    </Typography>
                    <Typography variant="caption" sx={{ display: 'block', opacity: 0.72 }} noWrap>
                      {file.path}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
                    <Typography variant="caption" sx={{ opacity: 0.72, whiteSpace: 'nowrap' }}>{formatFileSize(file.sizeBytes)}</Typography>
                    <InsertDriveFileOutlinedIcon fontSize="small" />
                  </Stack>
                </Box>
              );
            })}
          </Box>
        )}
      </Stack>
    </Box>
  );
}

function ArtifactImage({ src, fallbackSrc, alt, thumbnail = false }: { src: string; fallbackSrc?: string; alt: string; thumbnail?: boolean }) {
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const resolvedSrc = failedSources.includes(src) ? fallbackSrc : src;
  if (!resolvedSrc || failedSources.includes(resolvedSrc)) {
    return <Typography variant="body2" color="text.secondary" role="status">图片加载失败，请稍后重试。</Typography>;
  }
  return <Box component="img" src={resolvedSrc} alt={alt} loading="lazy" decoding="async" onError={() => setFailedSources((previous) => [...previous, resolvedSrc])} sx={{ display: 'block', width: thumbnail ? '100%' : 'auto', maxWidth: '100%', height: 'auto', maxHeight: thumbnail ? 'none' : '80vh', objectFit: 'contain', borderRadius: '8px', boxShadow: thumbnail ? '0 1px 4px rgba(0,0,0,0.1)' : 'none' }} />;
}

function ArtifactImages({ item, version, thumbnail = false }: { item: AssistantArtifactItem; version?: AssistantArtifactVersion | null; thumbnail?: boolean }) {
  const media = (version || getArtifactCurrentVersion(item))?.media || [];
  const images = thumbnail ? media.slice(0, 1) : media;
  if (!images.length) return <Typography variant="body2" color="text.secondary">当前版本没有可显示的图片。</Typography>;
  return <Stack spacing={thumbnail ? 0 : 1} sx={{ width: '100%', alignItems: 'center', justifyContent: 'center' }}>
    {images.map((image, index) => {
      const src = thumbnail ? image.thumbnailUrl || image.url : image.url || image.thumbnailUrl;
      return src ? <ArtifactImage key={`${index}-${src}`} src={src} fallbackSrc={thumbnail ? image.url : undefined} alt={image.alt || item.title} thumbnail={thumbnail} /> : <Typography key={index} variant="body2" color="text.secondary">图片不可用。</Typography>;
    })}
  </Stack>;
}

function ArtifactThumbnail({ item, mode, expanded = false }: { item: AssistantArtifactItem; mode: ArtifactViewMode; expanded?: boolean }) {
  if (item.kind === 'image') return <ArtifactImages item={item} thumbnail />;
  const content = getAssistantArtifactCurrentContent(item);
  const renderMermaid = isRenderableMermaid(item, content);
  const isDataPreview = item.kind === 'table' || item.kind === 'json';
  const autoHeightDataPreview = isDataPreview && mode === 'list';
  const previewHeight = autoHeightDataPreview
    ? 'auto'
    : item.kind === 'html'
    ? mode === 'list' ? 180 : mode === 'gallery' ? 150 : 112
    : mode === 'list' ? 'clamp(240px, 46vh, 380px)' : mode === 'gallery' ? 220 : 128;
  const contentScale = mode === 'icons' ? 0.52 : 1;
  const scaledCanvasSx = {
    width: `${100 / contentScale}%`,
    height: `${100 / contentScale}%`,
    transform: `scale(${contentScale})`,
    transformOrigin: 'top left',
  } as const;

  return (
    <Box
      sx={{
        position: 'relative',
        height: previewHeight,
        overflow: autoHeightDataPreview ? 'visible' : 'hidden',
        borderRadius: 1,
        border: '1px solid',
        borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.12)',
        bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(248,250,252,0.86)' : 'rgba(15,23,42,0.46)',
      }}
    >
      {renderMermaid ? (
        <Box sx={{ p: 0.5, ...scaledCanvasSx }}>
          <MermaidDiagram source={content} />
        </Box>
      ) : item.kind === 'html' ? (
        <AssistantHtmlStaticFrame artifactId={item.id} versionId={item.currentVersionId} title={item.title} html={content} sx={{ width: '100%', height: '100%', border: 0, pointerEvents: 'none' }} />
      ) : isDataPreview ? (
        <Box sx={{ p: mode === 'icons' ? 0.5 : 0.75, overflow: 'hidden', height: autoHeightDataPreview ? 'auto' : '100%' }}><AssistantDataPreview item={item} maxRows={mode === 'list' ? (expanded ? 16 : 4) : 10} edgeRows={mode === 'list' && expanded ? 8 : 0} /></Box>
      ) : item.kind === 'document' ? (
        <Box sx={{ p: 1, overflow: 'hidden', bgcolor: (theme) => theme.palette.mode === 'light' ? '#fff' : 'rgba(2,6,23,0.52)', ...scaledCanvasSx }}>
          <MarkdownText text={content} forceRich />
        </Box>
      ) : (
        <Box sx={{ p: mode === 'icons' ? 0.75 : 1, height: '100%', display: 'grid', alignContent: 'start', gap: mode === 'icons' ? 0.35 : 0.6 }}>
          <Box sx={{ color: 'text.secondary' }}>
            <ArtifactKindIcon kind={item.kind} />
          </Box>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              display: '-webkit-box',
              WebkitLineClamp: mode === 'list' ? 13 : 5,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.55,
              fontSize: mode === 'list' ? 11.5 : mode === 'gallery' ? 10.5 : 9.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {artifactPreviewText(item)}
          </Typography>
        </Box>
      )}
      {!autoHeightDataPreview ? <ThumbnailFade /> : null}
    </Box>
  );
}

function ArtifactPreview({ item, version, expanded = false, fullscreen = false, hideMermaidLoading = false, onMermaidRenderSettled, onHtmlAutosave, onHtmlSubmit, onHtmlRepair }: {
  item: AssistantArtifactItem;
  version?: AssistantArtifactVersion | null;
  expanded?: boolean;
  fullscreen?: boolean;
  hideMermaidLoading?: boolean;
  onMermaidRenderSettled?: () => void;
  onHtmlAutosave?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onHtmlSubmit?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onHtmlRepair?: (error: AssistantHtmlRuntimeError) => void | Promise<void>;
}) {
  const content = version ? getArtifactVersionContent(version) : getAssistantArtifactCurrentContent(item);
  if (item.kind === 'image') return <ArtifactImages item={item} version={version} />;
  if (!content) {
    return <Typography variant="body2" color="text.secondary">当前版本为空。</Typography>;
  }
  if (isRenderableMermaid(item, content)) {
    return <MermaidDiagram source={content} displayMode={fullscreen ? 'fullscreen' : 'inline'} hideLoading={hideMermaidLoading} onRenderSettled={onMermaidRenderSettled} />;
  }
  if (item.kind === 'document') {
    return <MarkdownText text={content} forceRich />;
  }
  if (item.kind === 'html') {
    if (version?.htmlRuntime) {
      const readOnly = version.id !== item.currentVersionId;
      return <AssistantHtmlFrame artifactId={item.id} version={version} manifest={version.htmlRuntime} readOnly={readOnly} onAutosave={onHtmlAutosave} onSubmit={onHtmlSubmit} onRequestRepair={onHtmlRepair} />;
    }
    return (
      <AssistantHtmlStaticFrame artifactId={item.id} versionId={version?.id || item.currentVersionId} title={item.title} html={content} sx={{ width: '100%', minHeight: expanded ? '72vh' : 360, border: 0, borderRadius: 1 }} />
    );
  }
  if (item.kind === 'table' || item.kind === 'json') {
        return <AssistantDataPreview item={item} version={version} maxRows={fullscreen ? Number.POSITIVE_INFINITY : expanded ? 30 : 8} showRowNumbers={fullscreen} />;
  }
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        maxHeight: expanded ? 'none' : 320,
        overflow: 'auto',
        p: 1,
        borderRadius: 1,
        bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.92)' : 'rgba(2,6,23,0.82)',
        color: '#e5e7eb',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 12.5,
        lineHeight: 1.7,
        whiteSpace: 'pre',
      }}
    >
      {content}
    </Box>
  );
}

function AssistantArtifactList({
  chatId,
  hideEmptyState = false,
  selectedArtifactId,
  onSelectedArtifactChange,
  onHtmlAutosave,
  onHtmlSubmit,
  onHtmlRepair,
}: {
  chatId: string;
  hideEmptyState?: boolean;
  selectedArtifactId?: string | null;
  onSelectedArtifactChange?: (artifactId: string | null) => void;
  onHtmlAutosave?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onHtmlSubmit?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onHtmlRepair?: (error: AssistantHtmlRuntimeError) => void | Promise<void>;
}) {
  const artifactItems = useAssistantArtifactStore((state) => state.items);
  const [viewMode, setViewMode] = useState<ArtifactViewMode>('list');
  const [sortMode, setSortMode] = useState<ArtifactSortMode>('manual');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const handleDownload = async (item: AssistantArtifactItem, version = getArtifactCurrentVersion(item)) => {
    setDownloadError(null);
    try {
      await downloadArtifact(item, getArtifactVersionContent(version), version);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : '产物下载失败，请稍后重试。');
    }
  };
  const artifacts = useMemo(() => sortArtifacts(artifactItems
    .filter((item) => item.chatId === chatId && item.deletedAt == null), sortMode), [artifactItems, chatId, sortMode]);
  const deleteArtifact = useAssistantArtifactStore((state) => state.deleteArtifact);
  const moveArtifact = useAssistantArtifactStore((state) => state.moveArtifact);
  const refreshArtifactsFromCloud = useAssistantArtifactStore((state) => state.refreshArtifactsFromCloud);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [fullscreenVersionId, setFullscreenVersionId] = useState<string | null>(null);
  const [pendingFullscreenVersionId, setPendingFullscreenVersionId] = useState<string | null>(null);
  const [copyFallback, setCopyFallback] = useState<{ label: string; value: string } | null>(null);
  const fullscreenZoomRef = useRef<ReactZoomPanPinchRef | null>(null);

  useEffect(() => {
    void ensureAssistantArtifactStoreHydrated();
  }, []);

  useEffect(() => {
    void ensureAssistantArtifactStoreHydrated()
      .then(() => refreshArtifactsFromCloud(chatId))
      .catch(() => undefined);
  }, [chatId, refreshArtifactsFromCloud]);

  useEffect(() => {
    if (selectedArtifactId && artifacts.some((item) => item.id === selectedArtifactId)) {
      const timer = window.setTimeout(() => setSelectedId(selectedArtifactId), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [artifacts, selectedArtifactId]);

  const selected = useMemo(() => (
    artifacts.find((item) => item.id === selectedId) || artifacts[0] || null
  ), [artifacts, selectedId]);

  useEffect(() => {
    if (selectedId && !artifacts.some((item) => item.id === selectedId)) {
      const timer = window.setTimeout(() => setSelectedId(null), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [artifacts, selectedId]);
  useEffect(() => {
    onSelectedArtifactChange?.(selected?.id || null);
  }, [onSelectedArtifactChange, selected?.id]);

  const fullscreenItem = useMemo(() => (
    artifacts.find((item) => item.id === fullscreenId) || null
  ), [artifacts, fullscreenId]);
  const fullscreenVersion = useMemo(() => {
    if (!fullscreenItem) return null;
    return fullscreenItem.versions.find((version) => version.id === fullscreenVersionId) || getArtifactCurrentVersion(fullscreenItem);
  }, [fullscreenItem, fullscreenVersionId]);
  const pendingFullscreenVersion = useMemo(() => {
    if (!fullscreenItem || !pendingFullscreenVersionId) return null;
    return fullscreenItem.versions.find((version) => version.id === pendingFullscreenVersionId) || null;
  }, [fullscreenItem, pendingFullscreenVersionId]);
  const isFullscreenVersionRendering = Boolean(pendingFullscreenVersion);
  const fullscreenVersionIndex = fullscreenItem && fullscreenVersion
    ? fullscreenItem.versions.findIndex((version) => version.id === fullscreenVersion.id)
    : -1;
  const fullscreenContent = getArtifactVersionContent(fullscreenVersion);
  const fullscreenZoomable = Boolean(fullscreenItem && isRenderableMermaid(fullscreenItem, fullscreenContent));
  const openFullscreen = (item: AssistantArtifactItem) => {
    setFullscreenId(item.id);
    setFullscreenVersionId(getArtifactCurrentVersion(item)?.id || null);
    setPendingFullscreenVersionId(null);
  };
  const closeFullscreen = useCallback(() => {
    setFullscreenId(null);
    setPendingFullscreenVersionId(null);
  }, []);
  useEffect(() => {
    if (!fullscreenItem) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!fullscreenZoomable) return;
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        fullscreenZoomRef.current?.zoomIn(0.32, 180);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        fullscreenZoomRef.current?.zoomOut(0.32, 180);
      } else if (event.key === '0') {
        event.preventDefault();
        fullscreenZoomRef.current?.resetTransform(180);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullscreenItem, fullscreenZoomable]);
  useEffect(() => {
    fullscreenZoomRef.current?.resetTransform(0);
  }, [fullscreenId, fullscreenVersionId]);
  useEffect(() => {
    if (!fullscreenItem) {
      const timer = window.setTimeout(() => setPendingFullscreenVersionId(null), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [fullscreenItem]);
  const stepFullscreenVersion = (direction: -1 | 1) => {
    if (!fullscreenItem || fullscreenVersionIndex < 0 || isFullscreenVersionRendering) return;
    const next = fullscreenItem.versions[fullscreenVersionIndex + direction];
    if (!next) return;
    const nextContent = getArtifactVersionContent(next);
    if (isRenderableMermaid(fullscreenItem, nextContent)) {
      setPendingFullscreenVersionId(next.id);
      return;
    }
    setFullscreenVersionId(next.id);
  };
  const handlePendingFullscreenVersionReady = useCallback(() => {
    if (!pendingFullscreenVersionId) return;
    setFullscreenVersionId(pendingFullscreenVersionId);
    setPendingFullscreenVersionId(null);
  }, [pendingFullscreenVersionId]);

  const toggleExpanded = (artifactId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(artifactId)) next.delete(artifactId);
      else next.add(artifactId);
      return next;
    });
  };

  if (!artifacts.length) {
    if (hideEmptyState) return null;
    return (
      <Box sx={{
        minHeight: 180,
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
        px: 2,
        py: 3,
        color: 'text.secondary',
      }}>
        <Stack spacing={1} sx={{ alignItems: 'center', maxWidth: 280 }}>
          <ArticleOutlinedIcon color="disabled" sx={{ fontSize: 34 }} />
          <Typography variant="body2" sx={{ fontWeight: 650, color: 'text.primary' }}>
            暂无产物
          </Typography>
          <Typography variant="caption" sx={{ lineHeight: 1.6 }}>
            Agent 会把文档、代码、图表、网页、表格等可沉淀结果收纳在这里。
          </Typography>
        </Stack>
      </Box>
    );
  }

  const renderActions = (item: AssistantArtifactItem, index: number) => (
    <Stack direction="row" spacing={0.25} sx={{ justifyContent: 'flex-end' }}>
      {sortMode === 'manual' ? (
        <>
          <Tooltip title="上移">
            <span>
              <IconButton size="small" disabled={index === 0} onClick={(event) => { event.stopPropagation(); moveArtifact(chatId, item.id, 'up'); }}>
                <KeyboardArrowUpOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="下移">
            <span>
              <IconButton size="small" disabled={index === artifacts.length - 1} onClick={(event) => { event.stopPropagation(); moveArtifact(chatId, item.id, 'down'); }}>
                <KeyboardArrowDownOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </>
      ) : null}
      <Tooltip title="复制当前版本">
        <IconButton size="small" onClick={async (event) => { event.stopPropagation(); const value = getAssistantArtifactCurrentContent(item); if (!(await copyTextToClipboard(value))) setCopyFallback({ label: item.title, value }); }}>
          <ContentCopyOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="下载当前版本">
        <IconButton size="small" onClick={(event) => { event.stopPropagation(); void handleDownload(item); }}>
          <DownloadOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="删除产物">
        <IconButton size="small" color="error" onClick={(event) => { event.stopPropagation(); deleteArtifact(item.id); }}>
          <DeleteOutlineOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );

  const renderMeta = (item: AssistantArtifactItem) => (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
      <Chip size="small" label={artifactKindLabels[item.kind]} sx={{ height: 20 }} />
      {item.language && item.kind !== 'image' ? <Chip size="small" label={item.language} variant="outlined" sx={{ height: 20 }} /> : null}
      {item.versions.length > 1 ? <Chip size="small" label={`${item.versions.length} 版`} variant="outlined" sx={{ height: 20 }} /> : null}
      {getArtifactCurrentVersion(item)?.stage === 'autosave' ? <Chip size="small" color="warning" variant="outlined" label="自动保存" sx={{ height: 20 }} /> : null}
      <Typography variant="caption" color="text.secondary">{formatArtifactTime(item.updatedAt)}</Typography>
    </Stack>
  );

  const renderArtifactCard = (item: AssistantArtifactItem, index: number) => {
    const isImage = item.kind === 'image';
    const active = selected?.id === item.id;
    const expanded = expandedIds.has(item.id);
    const content = getAssistantArtifactCurrentContent(item);
    const canExpand = !isImage && (content.length > 360 || item.kind === 'document' || item.kind === 'diagram' || item.kind === 'html');
    return (
      <Box
        key={item.id}
        role="button"
        tabIndex={0}
        onClick={() => {
          setSelectedId(item.id);
          openFullscreen(item);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setSelectedId(item.id);
            openFullscreen(item);
          }
        }}
        sx={{
          width: '100%',
          p: isImage ? 0 : 1,
          border: isImage ? 0 : '1px solid',
          borderColor: active ? 'primary.main' : ((theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.12)'),
          bgcolor: isImage ? 'transparent' : active ? 'action.selected' : 'background.paper',
          color: 'text.primary',
          textAlign: 'left',
          cursor: 'pointer',
          borderRadius: 1,
          boxShadow: 'none',
          '&:hover': { bgcolor: isImage ? 'transparent' : 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
        }}
      >
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', minWidth: 0 }}>
            <Box sx={{ color: active ? 'primary.main' : 'text.secondary', pt: 0.15, flexShrink: 0 }}>
              <ArtifactKindIcon kind={item.kind} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.title}
              </Typography>
              <Box sx={{ mt: 0.5 }}>{renderMeta(item)}</Box>
            </Box>
          </Stack>
          {item.summary ? (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                display: '-webkit-box',
                WebkitLineClamp: viewMode === 'list' ? 2 : 1,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                lineHeight: 1.55,
              }}
            >
              {item.summary}
            </Typography>
          ) : null}
          <ArtifactThumbnail item={item} mode={viewMode} expanded={expanded} />
          {viewMode === 'list' ? (
            <Box>
              {expanded && item.kind !== 'image' && item.kind !== 'diagram' && item.kind !== 'html' && item.kind !== 'table' && item.kind !== 'json' ? <ArtifactPreview item={item} /> : null}
              {canExpand && item.kind !== 'diagram' && item.kind !== 'html' ? (
                <Button
                  size="small"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(item.id);
                  }}
                  sx={{ mt: expanded ? 1 : 0, px: 0 }}
                >
                  {expanded ? '收起' : '展开'}
                </Button>
              ) : null}
            </Box>
          ) : null}
          {renderActions(item, index)}
        </Stack>
      </Box>
    );
  };

  return (
    <Stack spacing={1.25}>
      <Dialog open={Boolean(downloadError)} onClose={() => setDownloadError(null)}>
        <DialogTitle>下载失败</DialogTitle>
        <DialogContent><Typography color="error">{downloadError}</Typography><Button onClick={() => setDownloadError(null)}>关闭</Button></DialogContent>
      </Dialog>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 1 }}>
        <FloatingSegmentedTabs
          value={viewMode}
          items={artifactViewItems.map((item) => ({
            value: item.value,
            label: (
              <Tooltip title={item.title}>
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18 }}>
                  {item.icon}
                </Box>
              </Tooltip>
            ),
          }))}
          onChange={(value) => setViewMode(value as ArtifactViewMode)}
          equalWidth={false}
          comfortable={false}
        />
        <Select
          size="small"
          value={sortMode}
          onChange={(event) => setSortMode(event.target.value as ArtifactSortMode)}
          sx={{ minWidth: 96, '& .MuiSelect-select': { py: 0.6, fontSize: 13 } }}
        >
          <MenuItem value="manual">自定义</MenuItem>
          <MenuItem value="updated">最近更新</MenuItem>
          <MenuItem value="created">创建时间</MenuItem>
          <MenuItem value="title">标题</MenuItem>
          <MenuItem value="kind">类型</MenuItem>
        </Select>
      </Stack>

      {viewMode === 'list' ? (
        <Stack spacing={1}>
          {artifacts.map(renderArtifactCard)}
        </Stack>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: viewMode === 'gallery'
              ? 'repeat(auto-fill, minmax(220px, 1fr))'
              : 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: 1,
          }}
        >
          {artifacts.map(renderArtifactCard)}
        </Box>
      )}

      <Dialog
        open={Boolean(fullscreenItem)}
        onClose={closeFullscreen}
        fullScreen
        slotProps={{
          paper: {
            sx: (theme) => ({
              bgcolor: theme.palette.mode === 'light' ? '#f8fafc' : '#020617',
            }),
          },
        }}
      >
        {fullscreenItem ? (
          <>
            <DialogTitle
              sx={(theme) => ({
                position: 'sticky',
                top: 0,
                zIndex: theme.zIndex.appBar,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                px: { xs: 1.25, sm: 2 },
                py: { xs: 0.75, sm: 1 },
                borderBottom: '1px solid',
                borderColor: theme.palette.mode === 'light' ? 'rgba(148, 163, 184, 0.20)' : 'rgba(148, 163, 184, 0.16)',
                bgcolor: theme.palette.mode === 'light' ? 'rgba(248, 250, 252, 0.74)' : 'rgba(2, 6, 23, 0.72)',
                backdropFilter: 'blur(16px) saturate(1.25)',
                WebkitBackdropFilter: 'blur(16px) saturate(1.25)',
              })}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fullscreenItem.title}
                </Typography>
                {renderMeta(fullscreenItem)}
              </Box>
              <Stack
                direction="row"
                spacing={0.25}
                sx={{
                  flexShrink: 0,
                  '& .MuiIconButton-root': {
                    bgcolor: 'transparent',
                    '&:hover': {
                      bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.06)' : 'rgba(148,163,184,0.14)',
                    },
                  },
                }}
              >
                <IconButton onClick={() => stepFullscreenVersion(-1)} disabled={fullscreenVersionIndex <= 0 || isFullscreenVersionRendering}>
                  <NavigateBeforeOutlinedIcon />
                </IconButton>
                <Box sx={{ minWidth: 54, display: 'grid', placeItems: 'center' }}>
                  <Typography variant="caption" color="text.secondary">
                    {getArtifactVersionLabel(fullscreenItem, fullscreenVersion)}
                  </Typography>
                </Box>
                {fullscreenVersion?.stage === 'autosave' ? <Chip size="small" color="warning" variant="outlined" label="自动保存" sx={{ height: 22 }} /> : null}
                <IconButton onClick={() => stepFullscreenVersion(1)} disabled={fullscreenVersionIndex < 0 || fullscreenVersionIndex >= fullscreenItem.versions.length - 1 || isFullscreenVersionRendering}>
                  <NavigateNextOutlinedIcon />
                </IconButton>
                {fullscreenZoomable ? (
                  <>
                    <IconButton onClick={() => fullscreenZoomRef.current?.zoomIn(0.32, 180)} aria-label="放大产物">
                      <ZoomInIcon />
                    </IconButton>
                    <IconButton onClick={() => fullscreenZoomRef.current?.zoomOut(0.32, 180)} aria-label="缩小产物">
                      <ZoomOutIcon />
                    </IconButton>
                    <IconButton onClick={() => fullscreenZoomRef.current?.resetTransform(180)} aria-label="还原产物缩放">
                      <RestartAltIcon />
                    </IconButton>
                  </>
                ) : null}
                <IconButton onClick={async () => { const value = getArtifactVersionContent(fullscreenVersion); if (!(await copyTextToClipboard(value))) setCopyFallback({ label: fullscreenItem?.title || '产物内容', value }); }}>
                  <ContentCopyOutlinedIcon />
                </IconButton>
                <IconButton onClick={() => void handleDownload(fullscreenItem, fullscreenVersion)}>
                  <DownloadOutlinedIcon />
                </IconButton>
                <IconButton onClick={closeFullscreen} aria-label="关闭产物详情">
                  <CloseOutlinedIcon />
                </IconButton>
              </Stack>
            </DialogTitle>
            <DialogContent
              sx={{
                borderTop: 0,
                pt: { xs: 1, sm: 1.25 },
                bgcolor: 'transparent',
              }}
            >
              <Box sx={{ position: 'relative' }}>
                <Box
                  aria-hidden={!isFullscreenVersionRendering}
                  sx={(theme) => ({
                    position: 'sticky',
                    top: { xs: 8, sm: 10 },
                    zIndex: 2,
                    width: 'fit-content',
                    mx: 'auto',
                    mb: isFullscreenVersionRendering ? 1 : 0,
                    display: 'grid',
                    placeItems: 'center',
                    p: 1,
                    borderRadius: 999,
                    border: '1px solid',
                    borderColor: theme.palette.mode === 'light' ? 'rgba(148,163,184,0.28)' : 'rgba(148,163,184,0.18)',
                    bgcolor: theme.palette.mode === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(15,23,42,0.68)',
                    backdropFilter: 'blur(14px) saturate(1.25)',
                    WebkitBackdropFilter: 'blur(14px) saturate(1.25)',
                    boxShadow: theme.palette.mode === 'light' ? '0 10px 28px rgba(15,23,42,0.12)' : '0 10px 28px rgba(0,0,0,0.28)',
                    opacity: isFullscreenVersionRendering ? 1 : 0,
                    transform: isFullscreenVersionRendering ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.94)',
                    transition: 'opacity 180ms ease, transform 180ms ease, margin-bottom 180ms ease',
                    pointerEvents: 'none',
                  })}
                >
                  <CircularProgress size={18} thickness={5} />
                </Box>
                {fullscreenZoomable ? (
                  <Box sx={{ height: 'calc(100dvh - 86px)', minHeight: 320 }}>
                    <TransformWrapper
                      key={`${fullscreenItem.id}:${fullscreenVersion?.id || 'current'}`}
                      ref={fullscreenZoomRef}
                      initialScale={1}
                      minScale={0.5}
                      maxScale={6}
                      centerOnInit
                      centerZoomedOut
                      limitToBounds
                      doubleClick={{ mode: 'toggle', step: 1.5, animationTime: 180 }}
                      wheel={{ step: 0.18 }}
                      pinch={{ step: 5 }}
                      panning={{ velocityDisabled: false, allowLeftClickPan: true }}
                      onInit={(ref) => {
                        fullscreenZoomRef.current = ref;
                      }}
                    >
                      <TransformComponent
                        wrapperStyle={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                        }}
                        contentStyle={{
                          width: '100%',
                          minHeight: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <ArtifactPreview item={fullscreenItem} version={fullscreenVersion} expanded fullscreen onHtmlAutosave={onHtmlAutosave} onHtmlSubmit={onHtmlSubmit} onHtmlRepair={onHtmlRepair} />
                        {pendingFullscreenVersion ? (
                          <Box
                            aria-hidden
                            sx={{
                              position: 'absolute',
                              inset: 0,
                              opacity: 0,
                              pointerEvents: 'none',
                            }}
                          >
                            <ArtifactPreview
                              item={fullscreenItem}
                              version={pendingFullscreenVersion}
                              expanded
                              fullscreen
                              hideMermaidLoading
                              onMermaidRenderSettled={handlePendingFullscreenVersionReady}
                            />
                          </Box>
                        ) : null}
                      </TransformComponent>
                    </TransformWrapper>
                  </Box>
                ) : (
                  <>
                    <ArtifactPreview item={fullscreenItem} version={fullscreenVersion} expanded fullscreen onHtmlAutosave={onHtmlAutosave} onHtmlSubmit={onHtmlSubmit} onHtmlRepair={onHtmlRepair} />
                    {pendingFullscreenVersion ? (
                      <Box
                        aria-hidden
                        sx={{
                          position: 'absolute',
                          inset: 0,
                          opacity: 0,
                          pointerEvents: 'none',
                        }}
                      >
                        <ArtifactPreview
                          item={fullscreenItem}
                          version={pendingFullscreenVersion}
                          expanded
                          fullscreen
                          hideMermaidLoading
                          onMermaidRenderSettled={handlePendingFullscreenVersionReady}
                        />
                      </Box>
                    ) : null}
                  </>
                )}
              </Box>
            </DialogContent>
          </>
        ) : null}
      </Dialog>
      <CopyTextDialog open={Boolean(copyFallback)} label={copyFallback?.label} value={copyFallback?.value || ''} onClose={() => setCopyFallback(null)} />
    </Stack>
  );
}

export default function AssistantAgentPanel({
  chat,
  selectedArtifactId = null,
  onSelectedArtifactChange,
  onHtmlAutosave,
  onHtmlSubmit,
  onHtmlRepair,
}: AssistantAgentPanelProps) {
  const [hasWorkspaceFiles, setHasWorkspaceFiles] = useState(false);
  const capabilities = chat.modeState.assistantCapabilities || {};
  const genericCapabilities = chat.modeState.agentCapabilities || {};
  const isStudyRoom = Boolean(chat.scenarioState?.learning || chat.sessionKind?.family === 'study' || chat.sessionKind?.scenarioId === 'learning-progress' || chat.sessionKind?.scenarioId === 'ielts-coach');
  const agentEnabled = isStudyRoom || genericCapabilities.enabled === true || Boolean(capabilities.agent);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%', minHeight: 0 }}>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', pr: { xs: 0.25, md: 0.5 }, ...buildScrollableRegionSx() }}>
        <Stack spacing={2}>
          <LearningProgressSummary chat={chat} />
          {agentEnabled ? (
            <>
              <AssistantLocalWorkspaceFiles chatId={chat.id} onHasFilesChange={setHasWorkspaceFiles} />
              <AssistantArtifactList
                chatId={chat.id}
                hideEmptyState={hasWorkspaceFiles}
                selectedArtifactId={selectedArtifactId}
                onSelectedArtifactChange={onSelectedArtifactChange}
                onHtmlAutosave={onHtmlAutosave}
                onHtmlSubmit={onHtmlSubmit}
                onHtmlRepair={onHtmlRepair}
              />
            </>
          ) : (
            <Box sx={{ minHeight: 160, display: 'grid', placeItems: 'center', px: 2, textAlign: 'center', color: 'text.secondary' }}>
              <Typography variant="body2" sx={{ lineHeight: 1.7 }}>
                Agent 能力已关闭。开启后，助手会把需要沉淀的结果整理到产物面板。
              </Typography>
            </Box>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
