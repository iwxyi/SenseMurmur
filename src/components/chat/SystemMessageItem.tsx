import { Typography } from '@mui/material';
import type { Message } from '../../types/message';
import ChatTimelineFrame from './ChatTimelineFrame';

export default function SystemMessageItem({ message }: { message: Message }) {
  return (
    <ChatTimelineFrame placement="center" messageId={message.id} messageType="system" sx={{ py: 1 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic', px: 2, py: 0.5, bgcolor: 'action.hover', borderRadius: 2 }}>
        {message.content}
      </Typography>
    </ChatTimelineFrame>
  );
}
