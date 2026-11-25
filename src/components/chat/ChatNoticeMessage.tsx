import { useState } from 'react';
import { Box, Button, CircularProgress, Collapse, IconButton, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Message } from '../../types/message';
import ChatTimelineFrame from './ChatTimelineFrame';

export default function ChatNoticeMessage({ message, onAction, actionPending = false, actionFeedback }: { message: Message; onAction?: (message: Message) => void | Promise<void>; actionPending?: boolean; actionFeedback?: { message: string; tone: 'info' | 'error' } }) {
  const [expanded, setExpanded] = useState(false);
  const notice = message.metadata?.chatNotice;
  if (!notice) return null;
  const details = notice.details || [];
  const colors = { info: 'divider', working: 'primary.light', success: 'success.light', warning: 'warning.light', error: 'error.light' };
  return <ChatTimelineFrame presentation={{ family: 'center', variant: 'notice', placement: 'center' }} messageId={message.id} messageType={message.type} sx={{ px: { xs: 2, sm: 3 }, py: 0.25 }}>
    <Box component="aside" aria-label="聊天提示" sx={{ width: 'fit-content', maxWidth: 'min(100%, 520px)', minWidth: 0 }}>
    <Box sx={{ width: 'fit-content', maxWidth: '100%', minWidth: 0, border: '1px solid', borderColor: colors[notice.tone], borderRadius: 1.5,
      px: 1, py: 0.45, bgcolor: 'background.paper' }}>
      <Stack direction="row" spacing={0.6} sx={{ minWidth: 0, alignItems: 'center' }}>
        <Typography variant="caption" color={notice.tone === 'error' ? 'error.main' : 'text.secondary'}
          sx={{ minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.35 }}>{message.content}</Typography>
        {notice.progress ? <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
          {notice.progress.completed}/{notice.progress.total}
        </Typography> : null}
        {notice.tone === 'working' ? <CircularProgress size={13} thickness={5} aria-label="正在执行" sx={{ flexShrink: 0 }} /> : null}
        {notice.action && onAction ? <Button size="small" disabled={actionPending} onClick={() => void onAction(message)}
          sx={{ flexShrink: 0, minWidth: 0, px: 0.5, py: 0, fontSize: 11 }}>{actionPending ? '核对中…' : notice.action.label}</Button> : null}
        {details.length ? <IconButton size="small" aria-label={expanded ? '收起提示详情' : '展开提示详情'} aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)} sx={{ width: 24, height: 24, transform: expanded ? 'rotate(180deg)' : undefined }}>
          <ExpandMoreIcon fontSize="small" />
        </IconButton> : null}
      </Stack>
      {details.length ? <Collapse in={expanded} unmountOnExit>
        <Box sx={{ display: 'grid', gap: 0.35, pt: 0.55, pr: 3 }}>
          {details.map((detail, index) => <Typography key={index} variant="caption" color="text.secondary"
            sx={{ lineHeight: 1.35, overflowWrap: 'anywhere' }}>{detail}</Typography>)}
        </Box>
      </Collapse> : null}
      {actionFeedback ? <Typography role={actionFeedback.tone === 'error' ? 'alert' : 'status'} variant="caption"
        color={actionFeedback.tone === 'error' ? 'error.main' : 'text.secondary'}
        sx={{ display: 'block', pt: 0.5, overflowWrap: 'anywhere' }}>{actionFeedback.message}</Typography> : null}
    </Box>
    </Box>
  </ChatTimelineFrame>;
}
