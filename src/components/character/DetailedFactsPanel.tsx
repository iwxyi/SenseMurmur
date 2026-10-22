import { useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { useDetailedFacts } from '../../hooks/useDetailedFacts';
import type { RecalledFact } from '../../services/factualMemoryTypes';
import { sanitizeUserFacingText } from '../../services/displayTextSanitizer';
import StatChipRow from '../common/StatChipRow';
import { useChatStore } from '../../stores/useChatStore';
import { useCharacterStore } from '../../stores/useCharacterStore';

const statusLabels: Record<RecalledFact['status'], string> = {
  asserted: '个人陈述', agreed: '已确认约定', proposed: '待确认提议', disputed: '存在不同说法',
};

export function DetailedFactsPanel({ archive }: { archive: ReturnType<typeof useDetailedFacts> }) {
  const [expanded, setExpanded] = useState(false);
  const { items, loading, error, refresh } = archive;
  const chats = useChatStore((state) => state.chats);
  const characters = useCharacterStore((state) => state.characters);
  return <Box component="section" sx={{ minWidth: 0 }}>
    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'flex-end', mb: 1 }}>
      <Button size="small" startIcon={<RefreshIcon />} disabled={loading} onClick={refresh}>刷新</Button>
    </Stack>
    {loading ? <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><CircularProgress size={18} /><Typography variant="body2" color="text.secondary">读取中</Typography></Stack>
      : error ? <Alert severity="error" action={<Button onClick={refresh} color="inherit">重试</Button>}>{error}</Alert>
      : items.length ? <Stack spacing={1} sx={{ minWidth: 0 }}>
        {(expanded ? items : items.slice(0, 3)).map((fact) => <Box key={fact.id} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
          <Stack spacing={0.6} sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ minWidth: 0, fontWeight: 700, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{sanitizeUserFacingText(fact.text, characters)}</Typography>
            <StatChipRow items={[
              statusLabels[fact.status],
              sanitizeUserFacingText(chats.find((chat) => chat.id === fact.chatId)?.name || '原会话', characters),
              new Date(fact.timestamp).toLocaleString(),
            ]} />
          </Stack>
        </Box>)}
      </Stack> : <Typography variant="caption" color="text.secondary">暂无详细事实</Typography>}
    {!loading && !error && items.length > 3 ? <Button size="small" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      {expanded ? '收起' : `查看更多 ${items.length}`}
    </Button> : null}
  </Box>;
}
