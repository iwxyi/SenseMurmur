import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import { usePaneLayout } from '../components/layout/PaneLayoutContext';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import WorldCalendarPanel from '../components/calendar/WorldCalendarPanel';
import ManualCalendarEventDialog from '../components/calendar/ManualCalendarEventDialog';
import SurfaceCard from '../components/common/SurfaceCard';
import ExpandableFab from '../components/common/ExpandableFab';
import AppSnackbar from '../components/common/AppSnackbar';
import type { RuntimeEventV2 } from '../types/runtimeEvent';

export default function CalendarPage() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const pane = usePaneLayout();
  const isMasterPane = pane.role === 'master';
  const { setHeaderTitle, setHeaderBackAction } = useLayoutHeaderActions();
  const [searchParams] = useSearchParams();
  const conversationId = searchParams.get('conversationId');
  const actorId = searchParams.get('actorId');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });
  const chats = useChatStore((state) => state.chats);
  const markChatsWarm = useChatStore((state) => state.markChatsWarm);
  const prefetchWorldRuntime = useChatStore((state) => state.prefetchWorldRuntime);
  const updateChat = useChatStore((state) => state.updateChat);
  const characters = useCharacterStore((state) => state.characters);
  const markCharactersWarm = useCharacterStore((state) => state.markCharactersWarm);
  const prefetchCharacters = useCharacterStore((state) => state.prefetchCharacters);
  const floatingActionPositionSx = isMasterPane ? {
    position: 'fixed' as const,
    right: pane.bounds ? `calc(100vw - ${pane.bounds.right}px + 28px)` : 28,
    bottom: pane.bounds ? `calc(100vh - ${pane.bounds.bottom}px + 32px)` : 32,
  } : {
    position: 'fixed' as const,
    right: { xs: 20, sm: 28, md: 36 },
    bottom: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 76px)', sm: 32, md: 36 },
  };

  const handleCreateManualEvent = async (chatId: string, event: RuntimeEventV2) => {
    const chat = chats.find((item) => item.id === chatId);
    if (!chat) {
      throw new Error('Target chat not found');
    }
    await updateChat(chatId, {
      runtimeEventsV2: [...(chat.runtimeEventsV2 || []), event],
      updatedAt: Date.now(),
    });
    setSnackbar({
      open: true,
      severity: 'success',
      message: isZh ? '日程已添加' : 'Event added',
    });
  };

  useEffect(() => {
    markChatsWarm();
    markCharactersWarm();
    void prefetchWorldRuntime();
    void prefetchCharacters();
  }, [markCharactersWarm, markChatsWarm, prefetchCharacters, prefetchWorldRuntime]);

  useEffect(() => {
    setHeaderTitle(isZh ? '日历' : 'Calendar');
    setHeaderBackAction(null);
    return () => {
      setHeaderTitle(null);
      setHeaderBackAction(null);
    };
  }, [isZh, setHeaderBackAction, setHeaderTitle]);

  return (
    <Box sx={{ position: 'relative', pb: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 82px)', sm: 10 } }}>
      <Box
        sx={{
          px: { xs: 1.5, sm: 2, md: 3 },
          py: { xs: 1, sm: 1.5, md: 2 },
          width: '100%',
          maxWidth: 1240,
          mx: 'auto',
        }}
      >
        <SurfaceCard sx={{ width: '100%', overflow: 'hidden' }} contentSx={{ p: 0, '&:last-child': { pb: 0 } }}>
          <WorldCalendarPanel
            chats={chats}
            characters={characters}
            updateChat={updateChat}
            isZh={isZh}
            conversationId={conversationId}
            actorId={actorId}
            compact={false}
            showHeader={false}
          />
        </SurfaceCard>
      </Box>
      <ExpandableFab
        icon={<AddIcon />}
        label={isZh ? '新增日程' : 'New event'}
        ariaLabel={isZh ? '新增日程' : 'New event'}
        onClick={() => setCreateDialogOpen(true)}
        expandedWidth={140}
        sx={floatingActionPositionSx}
      />
      <ManualCalendarEventDialog
        open={createDialogOpen}
        chats={chats}
        characters={characters}
        fixedConversationId={conversationId}
        initialActorId={actorId}
        isZh={isZh}
        onClose={() => setCreateDialogOpen(false)}
        onCreate={handleCreateManualEvent}
      />
      <AppSnackbar
        open={snackbar.open}
        message={snackbar.message}
        severity={snackbar.severity}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
      />
    </Box>
  );
}
