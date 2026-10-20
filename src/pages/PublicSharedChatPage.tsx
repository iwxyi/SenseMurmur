import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, IconButton, Snackbar, Stack, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { useNavigate, useParams } from 'react-router-dom';
import MessageList from '../components/chat/MessageList';
import LoadingState from '../components/common/LoadingState';
import GlassHeader from '../components/layout/GlassHeader';
import ProfilePreviewOverlay from '../components/chat/ProfilePreviewOverlay';
import { api } from '../services/api';
import type { Message } from '../types/message';
import type { AICharacter } from '../types/character';

const PUBLIC_CHAT_PAGE_SIZE = 40;

type PublicShareMember = NonNullable<Awaited<ReturnType<typeof api.getPublicChatShare>>['members']>[number];

type PublicProfilePreviewState =
  | { kind: 'character'; anchorRect: DOMRect; anchorElement: HTMLElement; character: AICharacter }
  | { kind: 'chat'; anchorRect: DOMRect; anchorElement: HTMLElement };

const publicHeaderButtonSx: SxProps<Theme> = {
  width: 40,
  height: 40,
  borderRadius: 3,
  flex: '0 0 auto',
  color: 'text.secondary',
  bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.44)' : 'rgba(255,255,255,0.055)',
  border: '1px solid',
  borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.055)' : 'rgba(226,232,240,0.08)',
  boxShadow: (theme) => theme.palette.mode === 'light'
    ? '0 10px 24px rgba(15,23,42,0.035), 0 1px 0 rgba(255,255,255,0.62) inset'
    : '0 12px 28px rgba(0,0,0,0.18), 0 1px 0 rgba(255,255,255,0.06) inset',
  backdropFilter: 'blur(18px) saturate(1.08)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.08)',
  '&:hover': {
    color: 'text.primary',
    bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.09)',
  },
};

function mergeMessages(current: Message[], incoming: Message[]) {
  const byId = new Map<string, Message>();
  [...current, ...incoming].forEach((message) => {
    if (!message.isDeleted) byId.set(message.id, message);
  });
  return Array.from(byId.values()).sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
}

function toRenderablePublicMember(member: PublicShareMember): AICharacter {
  const now = Date.now();
  return {
    id: member.id,
    name: member.name,
    avatar: member.avatar || '',
    personality: {
      openness: Number(member.personality?.openness || 0.5),
      extroversion: Number(member.personality?.extroversion || 0.5),
      agreeableness: Number(member.personality?.agreeableness || 0.5),
      neuroticism: Number(member.personality?.neuroticism || 0.5),
      humor: Number(member.personality?.humor || 0.5),
      creativity: Number(member.personality?.creativity || 0.5),
      assertiveness: Number(member.personality?.assertiveness || 0.5),
      empathy: Number(member.personality?.empathy || 0.5),
    },
    behavior: {
      proactivity: 0.5,
      aggressiveness: 0.5,
      humorIntensity: 0.5,
      empathyLevel: 0.5,
      summarizing: 0.5,
      offTopic: 0.5,
    },
    expertise: Array.isArray(member.expertise) ? member.expertise : [],
    speakingStyle: member.speakingStyle || '',
    background: member.background || '',
    speechProfile: member.speechProfile as AICharacter['speechProfile'],
    relationships: [],
    memory: {
      longTerm: [],
      shortTermSummary: '',
      secrets: [],
      obsessions: [],
      tabooTopics: [],
      userMemories: [],
    },
    intervention: {
      allowSpeakAs: false,
      allowDirectorPrompt: false,
      allowPrivateThread: false,
    },
    bubbleStyle: member.bubbleStyle || null,
    bubbleStyleId: member.bubbleStyleId || null,
    isPreset: Boolean(member.isPreset),
    createdAt: now,
    updatedAt: now,
  };
}

function mergePublicMembers(current: AICharacter[], incoming: PublicShareMember[]) {
  const byId = new Map(current.map((member) => [member.id, member]));
  incoming.forEach((member) => {
    if (member?.id) byId.set(member.id, toRenderablePublicMember(member));
  });
  return Array.from(byId.values());
}

export default function PublicSharedChatPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [chatName, setChatName] = useState('');
  const [chatMeta, setChatMeta] = useState<{ updatedAt?: number; lastMessageAt?: number }>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<AICharacter[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [profilePreview, setProfilePreview] = useState<PublicProfilePreviewState | null>(null);

  const loadLatest = useCallback(async (mode: 'replace' | 'merge' = 'replace') => {
    if (!token) return;
    const result = await api.getPublicChatShare(token, { limit: PUBLIC_CHAT_PAGE_SIZE });
    setChatName(result.chat.name);
    setChatMeta({ updatedAt: result.chat.updatedAt, lastMessageAt: result.chat.lastMessageAt });
    setHasMore(result.hasMore);
    setMembers((current) => mergePublicMembers(current, result.members || []));
    setMessages((current) => mode === 'merge' ? mergeMessages(current, result.messages) : result.messages);
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void loadLatest('replace')
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadLatest]);

  useEffect(() => {
    if (!token || error) return undefined;
    const timer = window.setInterval(() => {
      void loadLatest('merge').catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [error, loadLatest, token]);

  const loadOlder = useCallback(async () => {
    if (!token || loadingOlder || !hasMore || !messages.length) return;
    setLoadingOlder(true);
    try {
      const before = messages[0]?.timestamp;
      const result = await api.getPublicChatShare(token, { limit: PUBLIC_CHAT_PAGE_SIZE, before });
      setChatName(result.chat.name);
      setChatMeta({ updatedAt: result.chat.updatedAt, lastMessageAt: result.chat.lastMessageAt });
      setHasMore(result.hasMore);
      setMembers((current) => mergePublicMembers(current, result.members || []));
      setMessages((current) => mergeMessages(result.messages, current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMore, loadingOlder, messages, token]);

  const title = useMemo(() => chatName || '聊天记录', [chatName]);
  const publicChat = useMemo(() => ({
    name: title,
    type: 'group' as const,
    memberIds: members.map((member) => member.id),
    updatedAt: chatMeta.updatedAt,
    lastMessageAt: chatMeta.lastMessageAt,
  }), [chatMeta.lastMessageAt, chatMeta.updatedAt, members, title]);

  const openCharacterPreview = useCallback((mention: { id: string; name: string }, anchorEl: HTMLElement) => {
    const character = members.find((member) => member.id === mention.id);
    if (!character) { setPreviewError('这个角色已不存在'); return; }
    setProfilePreview({ kind: 'character', anchorRect: anchorEl.getBoundingClientRect(), anchorElement: anchorEl, character });
  }, [members]);

  const openChatPreview = useCallback((anchorEl: HTMLElement) => {
    setProfilePreview({ kind: 'chat', anchorRect: anchorEl.getBoundingClientRect(), anchorElement: anchorEl });
  }, []);

  return (
    <Box
      sx={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <GlassHeader
        safeAreaTop
        title={(
          <Box
            component="button"
            type="button"
            onClick={(event) => openChatPreview(event.currentTarget)}
            sx={{
              minWidth: 0,
              maxWidth: '100%',
              p: 0,
              m: 0,
              border: 0,
              bgcolor: 'transparent',
              color: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
              font: 'inherit',
              display: 'flex',
              alignItems: 'center',
              minHeight: 40,
            }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.25 }} noWrap>{title}</Typography>
          </Box>
        )}
        leading={(
          <IconButton
            onClick={() => navigate('/')}
            sx={publicHeaderButtonSx}
            aria-label="回到首页"
          >
            <HomeOutlinedIcon />
          </IconButton>
        )}
        actions={(
          <IconButton
            onClick={() => void loadLatest('merge')}
            sx={publicHeaderButtonSx}
            aria-label="刷新"
          >
            <RefreshOutlinedIcon />
          </IconButton>
        )}
      />

      {loading ? (
        <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', px: 2, pt: 'calc(88px + env(safe-area-inset-top, 0px))' }}>
          <LoadingState title="正在打开聊天记录" />
        </Box>
      ) : error ? (
        <Stack sx={{ p: 2, pt: 'calc(88px + env(safe-area-inset-top, 0px))', maxWidth: 520, width: '100%', mx: 'auto' }} spacing={1.5}>
          <Alert severity="error">{error}</Alert>
          <Button variant="outlined" onClick={() => navigate('/')}>回到首页</Button>
        </Stack>
      ) : (
        <MessageList
          messages={messages}
          characters={members}
          onReachTop={loadOlder}
          isLoadingOlder={loadingOlder}
          hasMore={hasMore}
          topHint="没有更早的消息"
          loadingText="加载更多聊天记录…"
          onCharacterAvatarClick={openCharacterPreview}
          topInset={{ xs: 'calc(94px + env(safe-area-inset-top, 0px))', sm: '88px' }}
          bottomInset={2}
        />
      )}
      <ProfilePreviewOverlay
        open={Boolean(profilePreview)}
        kind={profilePreview?.kind || 'chat'}
        anchorRect={profilePreview?.anchorRect || null}
        anchorElement={profilePreview?.anchorElement || null}
        character={profilePreview?.kind === 'character' ? profilePreview.character : null}
        chat={publicChat}
        members={members}
        onClose={() => setProfilePreview(null)}
      />
      <Snackbar open={Boolean(previewError)} message={previewError} autoHideDuration={3500} onClose={() => setPreviewError('')} />
    </Box>
  );
}
