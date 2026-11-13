import type { ReactNode } from 'react';
import { Box, type SxProps, type Theme } from '@mui/material';
import type { ChatTimelinePresentation } from './chatTimelinePresentation';

export default function ChatTimelineFrame({ presentation, children, sx, messageId, messageType, ariaLabel }: {
  presentation: ChatTimelinePresentation;
  children: ReactNode;
  sx?: SxProps<Theme>;
  messageId?: string;
  messageType?: string;
  ariaLabel?: string;
}) {
  const { placement } = presentation;
  return <Box data-timeline-family={presentation.family} data-timeline-variant={presentation.variant} data-timeline-placement={placement}
    data-message-id={messageId} data-message-type={messageType} aria-label={ariaLabel} sx={[
    { display: 'flex', width: '100%', minWidth: 0, maxWidth: '100%', justifyContent: placement === 'center' ? 'center' : placement === 'right' ? 'flex-end' : 'flex-start' },
    ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
  ]}>{children}</Box>;
}
