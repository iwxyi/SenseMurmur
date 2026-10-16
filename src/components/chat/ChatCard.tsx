import { memo, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardActionArea, Box, Typography, Avatar, Chip, Checkbox, CircularProgress, Tooltip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { isImageAvatar } from '../../utils/avatar';
import DirectIcon from '@mui/icons-material/ChatBubbleOutlined';
import GroupIcon from '@mui/icons-material/Groups';
import AssistantIcon from '@mui/icons-material/SmartToyOutlined';
import CheckIcon from '@mui/icons-material/Check';
import type { GroupChat } from '../../types/chat';
import type { AICharacter } from '../../types/character';
import { formatRelativeTime } from '../../utils/format';
import { buildInteractiveSurfaceSx } from '../../styles/interaction';
import { buildChatSubtitle } from './chatCardSubtitle';
import { getChatGameplayShortLabel } from '../../services/chatGameplayPresentation';
import { sanitizeChatLatestMessage } from '../../services/chatLatestMessage';
import { avatarGenerationQueue, type AvatarGenerationTaskState } from '../../services/avatarGenerationQueue';
import { getChatCompletionTaskStatus, subscribeChatCompletionQueue } from '../../services/chatCompletionQueue';
import { useImageResourceAvailability } from '../../hooks/useImageResourceAvailability';
import { buildAvatarDirectHoverSx, buildCardAvatarHoverMotionSx } from '../../styles/avatarHoverMotion';

interface ChatCardProps {
  chat: GroupChat;
  characters: AICharacter[];
  onClick: () => void;
  onPrefetch?: () => void;
  selected?: boolean;
  selectable?: boolean;
  multiSelected?: boolean;
  onToggleSelection?: () => void;
  onMemberClick?: (member: AICharacter) => void;
  onAvatarClick?: (memberId?: string) => void;
  onLongPress?: () => void;
  displayMode?: 'list' | 'card';
  compactCard?: boolean;
  cardThemeRendering?: boolean;
  cardBackgroundRendering?: boolean;
  showListDivider?: boolean;
}

const CHAT_CARD_AVATAR_IMG_PROPS = {
  loading: 'lazy',
  decoding: 'async',
} as const;

function ExpandableMemberAvatars({ members, onMemberClick }: { members: AICharacter[]; onMemberClick?: (member: AICharacter) => void }) {
  const visibleMembers = members.slice(0, 5);
  const extraCount = Math.max(0, members.length - visibleMembers.length);
  return (
    <Box
      sx={{
        display: 'flex', alignItems: 'center', width: 42, maxWidth: '100%',
        overflow: 'visible', transition: 'width 420ms cubic-bezier(0.22, 1, 0.36, 1)',
        '&:hover': { width: 'min(125px, 100%)' },
        '& .chat-member-avatar': { ml: '-7px', transition: 'margin-left 420ms cubic-bezier(0.22, 1, 0.36, 1)' },
        '& .chat-member-avatar:first-of-type': { ml: 0 },
        '&:hover .chat-member-avatar': { ml: '0px' },
        '&:hover .chat-member-avatar:first-of-type': { ml: 0 },
      }}
    >
      {visibleMembers.map((member) => (
        <Tooltip key={member.id} title={member.name || '未命名角色'} arrow>
          <Box
            className="chat-member-avatar"
            component="span"
            onClick={(event) => { event.stopPropagation(); onMemberClick?.(member); }}
            sx={{ display: 'inline-flex', flexShrink: 0, cursor: onMemberClick ? 'pointer' : 'default', borderRadius: '50%', '&:hover .MuiAvatar-root': { transform: 'translateY(-1px) scale(1.08) rotate(1deg)' } }}
          >
            <Avatar
              src={isImageAvatar(member.avatar) ? member.avatar : undefined}
              slotProps={{ img: CHAT_CARD_AVATAR_IMG_PROPS }}
              sx={{ width: 26, height: 26, fontSize: '0.78rem', bgcolor: 'primary.light', border: '2px solid', borderColor: 'background.paper', transition: 'transform 360ms cubic-bezier(0.16, 1, 0.3, 1)' }}
            >
              {isImageAvatar(member.avatar) ? undefined : member.avatar}
            </Avatar>
          </Box>
        </Tooltip>
      ))}
      {extraCount ? (
        <Typography component="span" sx={{ ml: 0.5, flexShrink: 0, fontSize: '0.72rem', color: 'text.secondary' }}>+{extraCount}</Typography>
      ) : null}
    </Box>
  );
}

function ChatCard({ chat, characters, onClick, onPrefetch, selected = false, selectable = false, multiSelected = false, onToggleSelection, onMemberClick, onAvatarClick, onLongPress, displayMode = 'card', compactCard = false, cardThemeRendering = false, cardBackgroundRendering = false, showListDivider = false }: ChatCardProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startLongPress = () => {
    if (!onLongPress) return;
    longPressTriggeredRef.current = false;
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      onLongPress();
      clearLongPress();
    }, 520);
  };
  const clearLongPress = () => {
    if (longPressTimerRef.current != null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };
  const handleLongPressEnd = () => {
    clearLongPress();
    longPressTriggeredRef.current = false;
  };
  const handleContextMenu = (event: React.MouseEvent) => {
    if (!onLongPress) return;
    event.preventDefault();
    longPressTriggeredRef.current = true;
    onLongPress();
  };
  const [avatarTask, setAvatarTask] = useState<AvatarGenerationTaskState | null>(() => avatarGenerationQueue.getLatestTaskForTarget(`chat-avatar:${chat.id}`));
  const [chatAvatarTaskStatus, setChatAvatarTaskStatus] = useState(() => getChatCompletionTaskStatus(chat.id, 'group-avatar'));
  useEffect(() => { const unsubscribe = avatarGenerationQueue.subscribeTarget(`chat-avatar:${chat.id}`, setAvatarTask); return () => { unsubscribe?.(); }; }, [chat.id]);
  useEffect(() => { const unsubscribe = subscribeChatCompletionQueue(() => setChatAvatarTaskStatus(getChatCompletionTaskStatus(chat.id, 'group-avatar'))); return () => { unsubscribe?.(); }; }, [chat.id]);
  const resolvedLatestMessage = sanitizeChatLatestMessage(chat.latestMessage);
  const members = characters.filter((c) => chat.memberIds.includes(c.id));
  const deletedMembers = members.filter((member) => member.deletedAt != null);
  const deletedCount = deletedMembers.length;
  const deletedStatusLabel = deletedCount > 0
    ? (deletedCount >= members.length ? '已删除' : `已删除${deletedCount}`)
    : null;
  const deletedMemberNames = deletedMembers.map((member) => member.name).filter(Boolean);
  const missingDeletedCount = Math.max(0, deletedCount - deletedMemberNames.length);
  const deletedMembersTooltip = deletedStatusLabel ? (
    <Box sx={{ whiteSpace: 'pre-line' }}>
      {deletedMemberNames.length ? `已删除：${deletedMemberNames.join('、')}` : `已删除：${deletedCount} 人`}
      {'\n'}
      {members.length - deletedMembers.length > 0 ? `剩余：${members.filter((member) => member.deletedAt == null).map((member) => member.name).filter(Boolean).join('、') || `${members.length - deletedMembers.length} 人`}` : '剩余：无'}
      {missingDeletedCount > 0 ? `\n另有 ${missingDeletedCount} 人的详情暂未加载` : ''}
    </Box>
  ) : null;
  const isAssistant = chat.type === 'assistant';
  const isUserDirect = chat.type === 'direct';
  const isAiDirect = chat.type === 'ai_direct';
  const isDirect = isUserDirect || isAiDirect;
  const directMembers = isAiDirect ? members.slice(0, 2) : members.slice(0, 1);
  const directMember = directMembers[0] || null;
  const directDisplayName = directMember?.name || chat.name;
  const aiDirectDisplayName = directMembers.map((member) => member.name).join(' × ') || chat.name;
  const subtitle = buildChatSubtitle(chat, members, resolvedLatestMessage);
  const gameplayLabel = getChatGameplayShortLabel(chat);
  const directAvatarContent = directMember ? (
    <Avatar
      src={isImageAvatar(directMember.avatar) ? directMember.avatar : undefined}
      slotProps={{ img: CHAT_CARD_AVATAR_IMG_PROPS }}
      sx={{ width: 46, height: 46, fontSize: '1.05rem', bgcolor: 'primary.light', flexShrink: 0 }}
    >
      {isImageAvatar(directMember.avatar) ? undefined : directMember.avatar}
    </Avatar>
  ) : (
    <Avatar sx={{ width: 46, height: 46, fontSize: '1.05rem', bgcolor: 'primary.light', flexShrink: 0 }}>
      <DirectIcon sx={{ fontSize: 18 }} />
    </Avatar>
  );
  const directAvatarNode = isAiDirect && directMembers.length > 1 ? (
    <Box sx={{ display: 'flex', alignItems: 'center', width: { xs: 76, sm: 82 }, maxWidth: '100%', flexShrink: 0, overflow: 'visible' }}>
      {directMembers.map((member) => (
        <Box
          key={member.id}
          className="chat-card-avatar-hit"
          role={onAvatarClick ? 'button' : undefined}
          tabIndex={onAvatarClick ? 0 : undefined}
          aria-label={onAvatarClick ? `编辑${member.name || '角色'}` : undefined}
          onKeyDown={(event) => {
            if (onAvatarClick && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              event.stopPropagation();
              onAvatarClick(member.id);
            }
          }}
          onClick={(event) => { event.stopPropagation(); onAvatarClick?.(member.id); }}
          sx={{
            width: 46,
            height: 46,
            flex: '0 0 46px',
            ml: member.id === directMembers[0]?.id ? 0 : { xs: '-16px', sm: '-10px' },
            position: 'relative',
            zIndex: member.id === directMembers[0]?.id ? 1 : 2,
            cursor: onAvatarClick ? 'pointer' : 'default',
            borderRadius: '50%',
            ...(onAvatarClick ? buildAvatarDirectHoverSx() : undefined),
          }}
        >
          <Avatar src={isImageAvatar(member.avatar) ? member.avatar : undefined} slotProps={{ img: CHAT_CARD_AVATAR_IMG_PROPS }} sx={{ width: 46, height: 46, fontSize: '1.05rem', bgcolor: 'primary.light' }}>
            {isImageAvatar(member.avatar) ? undefined : member.avatar}
          </Avatar>
        </Box>
      ))}
    </Box>
  ) : (
    <Box
      className="chat-card-avatar-hit"
      role={onAvatarClick ? 'button' : undefined}
      tabIndex={onAvatarClick ? 0 : undefined}
      aria-label={onAvatarClick ? `编辑${directDisplayName}` : undefined}
      onKeyDown={(event) => {
        if (onAvatarClick && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.stopPropagation();
          onAvatarClick();
        }
      }}
      onClick={(event) => { event.stopPropagation(); onAvatarClick?.(); }}
      sx={{
        position: 'relative',
        width: 46,
        height: 46,
        flexShrink: 0,
        cursor: onAvatarClick ? 'pointer' : 'default',
        borderRadius: '50%',
        ...(onAvatarClick ? buildAvatarDirectHoverSx() : undefined),
      }}
    >
      {directAvatarContent}
    </Box>
  );
  // Local-only chats can retain an upload-shaped URL from a previous sync
  // attempt. It is not fetchable from the server and would otherwise produce
  // a noisy 404 on every home-page render.
  const isUnresolvableLocalMediaUrl = (url: string) => chat.id.startsWith('local-chat-') && /\/uploads\/media\//.test(url);
  const groupAvatarUrl = chat.type === 'group' && !isUnresolvableLocalMediaUrl(chat.groupVisual?.avatarUrl?.trim() || '') ? chat.groupVisual?.avatarUrl?.trim() : '';
  const requestedCardBackgroundUrl = cardBackgroundRendering ? chat.groupVisual?.backgroundUrl?.trim() : '';
  const requestedCardAccentImageUrl = cardThemeRendering
    ? (groupAvatarUrl || (isImageAvatar(directMember?.avatar) && !isUnresolvableLocalMediaUrl(directMember.avatar) ? directMember.avatar : ''))
    : '';
  const backgroundAvailability = useImageResourceAvailability(requestedCardBackgroundUrl);
  const accentAvailability = useImageResourceAvailability(requestedCardAccentImageUrl);
  const cardBackgroundUrl = backgroundAvailability === 'ready' ? requestedCardBackgroundUrl : '';
  const cardAccentImageUrl = accentAvailability === 'ready' ? requestedCardAccentImageUrl : '';
  const isList = displayMode === 'list';
  const isCompactCard = compactCard && !isList;
  const [groupAvatarUnavailableUrl, setGroupAvatarUnavailableUrl] = useState('');
  const groupAvatarGenerating = avatarTask?.status === 'queued' || avatarTask?.status === 'running' || chatAvatarTaskStatus === 'queued' || chatAvatarTaskStatus === 'running';
  const groupAvatarNode = (
    <Box className="chat-card-avatar-hit" role={onAvatarClick ? 'button' : undefined} tabIndex={onAvatarClick ? 0 : undefined} aria-label={onAvatarClick ? `编辑${chat.name}` : undefined} onKeyDown={(event) => { if (onAvatarClick && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onAvatarClick(); } }} onClick={(event) => { event.stopPropagation(); onAvatarClick?.(); }} sx={{ position: 'relative', width: 46, height: 46, flexShrink: 0, cursor: onAvatarClick ? 'pointer' : 'default', borderRadius: '50%', ...(onAvatarClick ? buildAvatarDirectHoverSx() : undefined) }}>
      <Avatar
        src={groupAvatarUrl && groupAvatarUnavailableUrl !== groupAvatarUrl ? groupAvatarUrl : undefined}
        slotProps={{ img: { ...CHAT_CARD_AVATAR_IMG_PROPS, onError: () => setGroupAvatarUnavailableUrl(groupAvatarUrl || '') } }}
        sx={{ width: 46, height: 46, bgcolor: 'primary.light', fontSize: '1.05rem' }}
      >
        <GroupIcon fontSize="small" />
      </Avatar>
      {groupAvatarGenerating ? (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', borderRadius: '50%', bgcolor: 'rgba(15,23,42,0.38)' }}>
          <CircularProgress size={19} sx={{ color: 'common.white' }} />
        </Box>
      ) : null}
    </Box>
  );

  return (
    <Card
      variant="outlined"
      sx={{
        ...buildInteractiveSurfaceSx({ selected: selected || multiSelected }),
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        height: isList ? 'auto' : '100%',
        overflow: 'visible',
        ...buildCardAvatarHoverMotionSx('.chat-card-primary-avatar'),
        '&::after': { borderRadius: 'inherit' },
        ...(isList ? {
          borderRadius: 1.25,
          borderWidth: 0,
          bgcolor: selected || multiSelected
            ? (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.075)' : 'rgba(120,156,220,0.12)'
            : 'transparent',
          boxShadow: 'none',
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
          '&:hover': {
            borderRadius: 1.25,
            bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.042)' : 'rgba(226,232,240,0.055)',
            boxShadow: 'none',
          },
        } : {}),
        '&::after': (cardBackgroundUrl || cardAccentImageUrl) ? {
          content: '""', position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: (theme) => { const veil = isList ? (theme.palette.mode === 'light' ? 'rgba(255,255,255,0.91)' : 'rgba(18,20,28,0.92)') : (theme.palette.mode === 'light' ? 'rgba(255,255,255,0.84)' : 'rgba(18,20,28,0.86)'); return `linear-gradient(${veil}, ${veil}), url("${(cardBackgroundUrl || cardAccentImageUrl).replace(/"/g, '%22')}")`; },
          backgroundSize: 'cover', backgroundPosition: 'center', opacity: isList ? (cardBackgroundUrl ? 0.5 : 0.34) : (cardBackgroundUrl ? 0.82 : 0.52),
          filter: cardBackgroundUrl ? 'saturate(0.68)' : 'blur(16px) saturate(1.15)', transform: cardAccentImageUrl ? 'scale(1.12)' : undefined,
        } : undefined,
      } as SxProps<Theme>}
    >
      <CardActionArea
        component="div"
        role="button"
        tabIndex={0}
        aria-label={chat.name}
        aria-pressed={selectable ? multiSelected : selected}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (selectable && onToggleSelection) onToggleSelection();
          else onClick();
        }}
        onClick={(event) => {
          if (longPressTriggeredRef.current) {
            event.preventDefault();
            longPressTriggeredRef.current = false;
            return;
          }
          onClick();
        }}
        onPointerDown={startLongPress}
        onPointerUp={clearLongPress}
        onPointerLeave={handleLongPressEnd}
        onPointerCancel={handleLongPressEnd}
        onMouseDown={startLongPress}
        onMouseUp={clearLongPress}
        onMouseLeave={handleLongPressEnd}
        onTouchStart={startLongPress}
        onTouchEnd={clearLongPress}
        onContextMenu={handleContextMenu}
        onPointerEnter={onPrefetch}
        onFocus={onPrefetch}
        sx={{
          height: '100%',
          width: '100%',
          minWidth: 0,
        }}
      >
        <CardContent sx={{
          p: isList ? { xs: 1.35, sm: 1.5 } : { xs: 1.75, sm: 2 },
          pr: isList ? { xs: 1.75, sm: 2 } : undefined,
          position: 'relative', zIndex: 1,
          width: '100%',
          boxSizing: 'border-box',
          '&:last-child': { pb: isList ? { xs: 1.35, sm: 1.5 } : { xs: 1.75, sm: 2 } },
          ...(isList && showListDivider ? {
            '&::after': {
              content: '""', position: 'absolute', left: selectable ? { xs: 102, sm: 110 } : { xs: 68, sm: 72 }, right: { xs: 14, sm: 16 }, bottom: 0, height: '0.5px',
              bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.11)' : 'rgba(226,232,240,0.12)',
              pointerEvents: 'none',
            },
          } : {}),
        }}>
          <Box sx={{ display: 'flex', alignItems: 'stretch', minWidth: 0 }}>
          {selectable ? (
            <Box sx={{ width: { xs: 34, sm: 38 }, flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', pt: 1.5, pr: 0.5 }}>
              <Checkbox
                checked={multiSelected}
                onClick={(event) => { event.stopPropagation(); onToggleSelection?.(); }}
                slotProps={{ input: { 'aria-label': `选择${chat.name}` } }}
                icon={<Box sx={{ width: 22, height: 22, borderRadius: '50%', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(255,255,255,0.78)' }} />}
                checkedIcon={<Box sx={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: 'primary.main', color: 'primary.contrastText' }}><CheckIcon sx={{ fontSize: 16 }} /></Box>}
                sx={{ p: 0.4, borderRadius: '50%', '&:hover': { bgcolor: 'action.hover' } }}
              />
            </Box>
          ) : null}
          <Box sx={{ flex: 1, minWidth: 0, width: 0 }}>
          {isDirect ? (
              <Box sx={{ minWidth: 0, width: '100%', position: 'relative', display: 'flex', alignItems: 'stretch', gap: 1.5 }}>
              {deletedStatusLabel && !isList ? (
                <Chip
                  size="small"
                  color="error"
                  variant="outlined"
                  label={deletedStatusLabel}
                  sx={{ position: 'absolute', top: -2, right: 0, height: 21, zIndex: 2, '& .MuiChip-label': { px: 0.7 } }}
                />
              ) : null}
              <Box className="chat-card-primary-avatar" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {directAvatarNode}
              </Box>
              <Box sx={{ minWidth: 0, width: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, width: '100%', mb: isList ? 0.35 : 0.65, pr: !isList && deletedStatusLabel ? 7 : 0 }}>
                  <Typography variant="subtitle1" noWrap sx={{ fontWeight: 400, fontSize: '0.95rem', lineHeight: 1.35, letterSpacing: 0, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {isAiDirect ? aiDirectDisplayName : directDisplayName}
                  </Typography>
                  {isList || (isCompactCard && !isAssistant) ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, ml: 'auto', flexShrink: 0 }}>
                    {!isAssistant ? <Typography variant="caption" sx={{ color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.48)' : 'rgba(226,232,240,0.52)' }}>{formatRelativeTime(chat.lastMessageAt)}</Typography> : null}
                    {isList && deletedStatusLabel ? <Tooltip title={deletedMembersTooltip} arrow><Chip size="small" color="error" variant="outlined" label={deletedStatusLabel} sx={{ height: 20, borderRadius: 0.75, '& .MuiChip-label': { px: 0.6, fontSize: '0.68rem' } }} /></Tooltip> : null}
                  </Box> : null}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.25, minWidth: 0, width: '100%' }}>
                  <Typography variant="caption" noWrap sx={{ display: 'block', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.56)' : 'rgba(226,232,240,0.62)' }}>
                    {subtitle || chat.name}
                  </Typography>
                  {!isList ? <Typography variant="caption" sx={{ flexShrink: 0, color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.48)' : 'rgba(226,232,240,0.52)' }}>
                    {formatRelativeTime(chat.lastMessageAt)}
                  </Typography> : null}
                </Box>
              </Box>
            </Box>
          ) : (
            <>
              {!isList && (gameplayLabel || deletedStatusLabel || isAssistant) ? (
                <Box sx={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 0.5, zIndex: 2 }}>
                  {isAssistant ? <Chip label="助手" size="small" variant="filled" sx={{ height: 22, borderRadius: 1, fontSize: '0.72rem', fontWeight: 500, color: 'primary.dark', bgcolor: 'rgba(25, 118, 210, 0.10)', border: '1px solid rgba(25, 118, 210, 0.18)', '& .MuiChip-label': { px: 0.8 } }} /> : null}
                  {gameplayLabel ? (
                    <Chip label={gameplayLabel} size="small" variant="filled" sx={{ height: 22, borderRadius: 1, fontSize: '0.72rem', fontWeight: 760, color: 'primary.dark', bgcolor: 'rgba(25, 118, 210, 0.10)', border: '1px solid rgba(25, 118, 210, 0.18)', '& .MuiChip-label': { px: 0.8 } }} />
                  ) : null}
                  {deletedStatusLabel ? <Chip size="small" color="error" variant="outlined" label={deletedStatusLabel} sx={{ height: 22, borderRadius: 1, '& .MuiChip-label': { px: 0.8 } }} /> : null}
                </Box>
              ) : null}
              <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1.5, minWidth: 0, width: '100%' }}>
                <Box className="chat-card-primary-avatar" sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', flexShrink: 0 }}>
                  {isAssistant ? <Avatar sx={{ width: 46, height: 46, bgcolor: 'primary.light', flexShrink: 0 }}><AssistantIcon fontSize="small" /></Avatar> : groupAvatarNode}
                </Box>
                <Box sx={{ minWidth: 0, width: 0, flex: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, width: '100%', pr: !isList && (gameplayLabel || deletedStatusLabel || isAssistant) ? 5 : 0 }}>
                    <Typography variant="subtitle1" noWrap sx={{ fontWeight: 400, fontSize: '0.95rem', lineHeight: 1.35, letterSpacing: 0, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chat.type === 'group' ? `${chat.name} (${chat.memberIds.length})` : chat.name}
                    </Typography>
                    {isList || (isCompactCard && !isAssistant) ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, ml: 'auto', flexShrink: 0 }}>
                      {!isAssistant ? <Typography variant="caption" sx={{ color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.48)' : 'rgba(226,232,240,0.52)' }}>{formatRelativeTime(chat.lastMessageAt)}</Typography> : null}
                      {isList && deletedStatusLabel ? <Tooltip title={deletedMembersTooltip} arrow><Chip size="small" color="error" variant="outlined" label={deletedStatusLabel} sx={{ height: 20, borderRadius: 0.75, '& .MuiChip-label': { px: 0.6, fontSize: '0.68rem' } }} /></Tooltip> : null}
                    </Box> : null}
                  </Box>
                  {subtitle ? <Typography variant="caption" noWrap sx={{ display: 'block', mt: isList ? 0.35 : 0.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.56)' : 'rgba(226,232,240,0.62)' }}>{subtitle}</Typography> : null}
                  {!isList && !isCompactCard ? <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0, mt: 0.75 }}>
                    {isAssistant ? (
                      <Box sx={{ flex: 1 }} />
                    ) : (
                      <ExpandableMemberAvatars members={members} onMemberClick={onMemberClick} />
                    )}
                    {!isAssistant ? <Typography variant="caption" sx={{ flexShrink: 0, color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.48)' : 'rgba(226,232,240,0.52)' }}>{formatRelativeTime(chat.lastMessageAt)}</Typography> : null}
                  </Box> : null}
                </Box>
              </Box>
            </>
          )}
          </Box>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default memo(ChatCard, (prev, next) => (
  prev.chat === next.chat
  && prev.characters === next.characters
  && prev.selected === next.selected
  && prev.selectable === next.selectable
  && prev.multiSelected === next.multiSelected
  && prev.onPrefetch === next.onPrefetch
  && prev.onToggleSelection === next.onToggleSelection
  && prev.onMemberClick === next.onMemberClick
  && prev.onAvatarClick === next.onAvatarClick
  && prev.onLongPress === next.onLongPress
  && prev.displayMode === next.displayMode
  && prev.compactCard === next.compactCard
  && prev.cardThemeRendering === next.cardThemeRendering
  && prev.cardBackgroundRendering === next.cardBackgroundRendering
  && prev.showListDivider === next.showListDivider
));
