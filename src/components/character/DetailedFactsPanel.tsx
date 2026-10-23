import { useState } from 'react';
import { Alert, Avatar, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, List, ListItem, ListItemAvatar, ListItemButton, ListItemText, Stack, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import AppSnackbar from '../common/AppSnackbar';
import type { useDetailedFacts } from '../../hooks/useDetailedFacts';
import type { RecalledFact } from '../../services/factualMemoryTypes';
import { sanitizeUserFacingText } from '../../services/displayTextSanitizer';
import StatChipRow from '../common/StatChipRow';
import { useChatStore } from '../../stores/useChatStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { compactPillChipSx } from '../../styles/interaction';
import { isImageAvatar } from '../../utils/avatar';
import { resolveSafeAvatarSrc } from '../../utils/avatarFallback';
import { getWorkspaceSignal } from '../../services/workspaceLifecycle';

const statusLabels: Record<RecalledFact['status'], string> = {
  asserted: '个人陈述', agreed: '已确认约定', proposed: '待确认提议', disputed: '存在不同说法',
};

export function DetailedFactsPanel({ archive }: { archive: ReturnType<typeof useDetailedFacts> }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedFactId, setSelectedFactId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; fact?: RecalledFact; error?: boolean; signal: AbortSignal } | null>(null);
  const { items, loading, error, refresh } = archive;
  const changeDeletion = async (fact: RecalledFact, deleted: boolean) => {
    if (!deleted && notice?.signal.aborted) { setNotice(null); return; }
    const signal = getWorkspaceSignal();
    setBusy(true);
    try {
      await archive.setDeleted(fact, deleted);
      if (!signal.aborted) setNotice({ message: deleted ? '已删除详细事实' : '已恢复详细事实', fact: deleted ? fact : undefined, signal });
    } catch {
      if (!signal.aborted) setNotice({ message: deleted ? '删除失败，原记录已保留' : '撤销失败，请重试', error: true, fact: deleted ? undefined : fact, signal });
    } finally { setBusy(false); }
  };
  const chats = useChatStore((state) => state.chats);
  const characters = useCharacterStore((state) => state.characters);
  const selectedFact = items.find((fact) => fact.id === selectedFactId);
  const knowerIds = (fact: RecalledFact) => [...new Set(fact.knownByIds?.filter((id) => id !== 'user') || [])];
  return <Box component="section" sx={{ minWidth: 0 }}>
    {loading ? <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><CircularProgress size={18} /><Typography variant="body2" color="text.secondary">读取中</Typography></Stack>
      : error ? <Alert severity="error" action={<Button onClick={refresh} color="inherit">重试</Button>}>{error}</Alert>
      : items.length ? <Stack spacing={1} sx={{ minWidth: 0 }}>
        {(expanded ? items : items.slice(0, 3)).map((fact) => <Box key={fact.id} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
          <Stack spacing={0.6} sx={{ minWidth: 0 }}>
            {fact.title ? <Typography variant="subtitle2" sx={{ minWidth: 0, fontWeight: 700, overflowWrap: 'anywhere' }}>{sanitizeUserFacingText(fact.title, characters)}</Typography> : null}
            <Typography variant="body2" sx={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{sanitizeUserFacingText(fact.text, characters, { preserveLineBreaks: true })}</Typography>
            <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.6 }}>
              <StatChipRow items={[
                statusLabels[fact.status],
                sanitizeUserFacingText(chats.find((chat) => chat.id === fact.chatId)?.name || '原会话', characters),
              ]} />
              <Chip size="small" variant="outlined" sx={compactPillChipSx}
                label={fact.knownByIds ? `${knowerIds(fact).length}人` : '知情人数未知'}
                disabled={!fact.knownByIds}
                aria-label={fact.knownByIds ? `查看知情角色，共${knowerIds(fact).length}人` : '知情人数未知'}
                onClick={() => setSelectedFactId(fact.id)} />
              <Stack direction="row" spacing={0.5} sx={{ ml: 'auto', alignItems: 'center' }}>
                <Typography variant="caption" color="text.secondary">{new Date(fact.timestamp).toLocaleString()}</Typography>
                <Tooltip title="删除详细事实"><span><IconButton size="small" aria-label="删除详细事实" disabled={busy}
                  onClick={() => void changeDeletion(fact, true)}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
              </Stack>
            </Stack>
          </Stack>
        </Box>)}
      </Stack> : <Typography variant="caption" color="text.secondary">暂无详细事实</Typography>}
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1 }}>
      {!loading && !error && items.length > 3 ? <Button size="small" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        {expanded ? '收起' : `查看更多 ${items.length}`}
      </Button> : null}
      <Button size="small" startIcon={<RefreshIcon />} disabled={loading || busy} onClick={refresh}>刷新</Button>
    </Stack>
    <Dialog open={Boolean(selectedFact)} onClose={() => setSelectedFactId(null)} maxWidth="xs" fullWidth aria-labelledby="fact-knowers-title">
      <DialogTitle id="fact-knowers-title">知情角色（{selectedFact ? knowerIds(selectedFact).length : 0}人）</DialogTitle>
      <DialogContent dividers>
        {selectedFact && knowerIds(selectedFact).length ? <List disablePadding>
          {knowerIds(selectedFact).map((id) => {
            const character = characters.find((item) => item.id === id);
            const available = character && !character.deletedAt;
            const content = <>
              <ListItemAvatar><Avatar src={character && isImageAvatar(character.avatar) ? resolveSafeAvatarSrc(character.avatar) : undefined}>
                {character && !isImageAvatar(character.avatar) ? character.avatar : undefined}
              </Avatar></ListItemAvatar>
              <ListItemText primary={character ? sanitizeUserFacingText(character.name, characters) : '角色已不可用'}
                secondary={available ? undefined : '角色已删除或不可用'} slotProps={{ primary: { sx: { overflowWrap: 'anywhere' } } }} />
            </>;
            return <ListItem key={id} disablePadding>
              {available ? <ListItemButton component={RouterLink} to={`/characters/${encodeURIComponent(id)}/edit`} target="_blank" rel="noopener noreferrer">{content}</ListItemButton>
                : <ListItemButton disabled>{content}</ListItemButton>}
            </ListItem>;
          })}
        </List> : <Typography variant="body2" color="text.secondary">暂无知情角色</Typography>}
      </DialogContent>
      <DialogActions><Button onClick={() => setSelectedFactId(null)}>关闭</Button></DialogActions>
    </Dialog>
    <AppSnackbar open={Boolean(notice)} message={notice?.message} severity={notice?.error ? 'error' : 'success'}
      autoHideDuration={6000} onClose={() => setNotice(null)}
      action={notice?.fact ? <Button color="inherit" size="small" disabled={busy}
        onClick={() => void changeDeletion(notice.fact!, false)}>撤销</Button> : undefined} />
  </Box>;
}
