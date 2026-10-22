import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Divider, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { listDetailedFacts } from '../../services/factualMemory';
import type { RecalledFact } from '../../services/factualMemoryTypes';
import { sanitizeUserFacingText } from '../../services/displayTextSanitizer';
import { reportRecoverableError } from '../../services/diagnostics';
import { useChatStore } from '../../stores/useChatStore';
import { useCharacterStore } from '../../stores/useCharacterStore';

const statusLabels: Record<RecalledFact['status'], string> = {
  asserted: '个人陈述', agreed: '已确认约定', proposed: '待确认提议', disputed: '存在不同说法',
};

export function DetailedFactsPanel({ characterId }: { characterId: string }) {
  return <DetailedFactsContent key={characterId} characterId={characterId} />;
}

function DetailedFactsContent({ characterId }: { characterId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<RecalledFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const chats = useChatStore((state) => state.chats);
  const characters = useCharacterStore((state) => state.characters);
  const refresh = () => {
    setLoading(true);
    setError('');
    setRevision((value) => value + 1);
  };
  useEffect(() => {
    let current = true;
    void listDetailedFacts(characterId).then((facts) => {
      if (current) setItems(facts.sort((a, b) => b.timestamp - a.timestamp));
    }).catch((cause: unknown) => {
      if (current) setError('详细事实读取失败，请重试。');
      reportRecoverableError({ location: 'character.fact-archive', error: cause, userMessage: '详细事实读取失败，请重试。' });
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [characterId, revision]);
  return <Box component="section" sx={{ minWidth: 0 }}>
    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
      <Typography variant="subtitle2">详细事实{!loading && !error ? ` · ${items.length}` : ''}</Typography>
      <Button size="small" startIcon={<RefreshIcon />} disabled={loading} onClick={refresh}>刷新</Button>
    </Stack>
    {loading ? <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><CircularProgress size={18} /><Typography variant="body2" color="text.secondary">读取中</Typography></Stack>
      : error ? <Alert severity="error" action={<Button onClick={refresh} color="inherit">重试</Button>}>{error}</Alert>
      : items.length ? <Stack divider={<Divider />} sx={{ maxHeight: 480, overflowY: 'auto' }}>
        {(expanded ? items : items.slice(0, 3)).map((fact) => <Box key={fact.id} sx={{ py: 1.25, minWidth: 0 }}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{sanitizeUserFacingText(fact.text, characters)}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere' }}>
            {statusLabels[fact.status]} · {chats.find((chat) => chat.id === fact.chatId)?.name || '原会话'} · {new Date(fact.timestamp).toLocaleString()}
          </Typography>
        </Box>)}
      </Stack> : <Typography variant="body2" color="text.secondary">暂无详细事实</Typography>}
    {!loading && !error && items.length > 3 ? <Button size="small" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      {expanded ? '收起' : `展开全部（${items.length} 条）`}
    </Button> : null}
  </Box>;
}
