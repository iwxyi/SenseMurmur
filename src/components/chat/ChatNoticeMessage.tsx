import { useState } from 'react';
import { Box, Collapse, IconButton, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Message } from '../../types/message';

export default function ChatNoticeMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const notice = message.metadata?.chatNotice;
  if (!notice) return null;
  const details = notice.details || [];
  const colors = { info: 'divider', working: 'primary.light', success: 'success.light', warning: 'warning.light', error: 'error.light' };
  return <Box component="aside" data-message-id={message.id} data-message-type={message.type} aria-label="聊天提示"
    sx={{ width: '100%', display: 'flex', justifyContent: 'center', px: { xs: 2, sm: 3 }, py: 0.25 }}>
    <Box sx={{ width: '100%', maxWidth: 640, minWidth: 0, borderLeft: '2px solid', borderColor: colors[notice.tone], pl: 1, py: 0.2 }}>
      <Stack direction="row" spacing={0.6} sx={{ minWidth: 0, alignItems: 'center' }}>
        <Typography variant="caption" color={notice.tone === 'error' ? 'error.main' : 'text.secondary'}
          sx={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere', lineHeight: 1.35 }}>{message.content}</Typography>
        {notice.progress ? <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
          {notice.progress.completed}/{notice.progress.total}
        </Typography> : null}
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
    </Box>
  </Box>;
}
