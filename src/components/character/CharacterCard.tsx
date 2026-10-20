import { Card, CardContent, CardActionArea, Box, Typography, Avatar, Chip, IconButton, Menu, MenuItem } from '@mui/material';
import { isImageAvatar } from '../../utils/avatar';
import { rememberFailedAvatarUrl, resolveSafeAvatarSrc } from '../../utils/avatarFallback';
import MoreIcon from '@mui/icons-material/MoreVert';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useRef, useState } from 'react';
import type { AICharacter } from '../../types/character';
import { useTranslation } from 'react-i18next';
import { formatExpertiseList } from '../../utils/expertise';
import { motion, transition } from '../../styles/motion';
import { buildInteractiveSurfaceSx, buildSelectionRailSx } from '../../styles/interaction';
import { buildCardAvatarHoverMotionSx } from '../../styles/avatarHoverMotion';

interface CharacterCardProps {
  character: AICharacter;
  onEdit?: () => void;
  onDelete?: () => void;
  onStartDirectChat?: () => void;
  onClick?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  selectable?: boolean;
  selectionMode?: boolean;
}

export default function CharacterCard({ character, onEdit, onDelete, onStartDirectChat, onClick, onLongPress, selected, selectable, selectionMode }: CharacterCardProps) {
  const pressTimerRef = useRef<number | null>(null);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { t, i18n } = useTranslation();

  const longPressTriggeredRef = useRef(false);

  const clearPressTimer = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const startLongPress = () => {
    if (!onLongPress) return;
    longPressTriggeredRef.current = false;
    clearPressTimer();
    pressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      onLongPress();
      clearPressTimer();
    }, 450);
  };

  const handleClick = () => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    onClick?.();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!onLongPress) return;
    e.preventDefault();
    longPressTriggeredRef.current = true;
    onLongPress();
  };

  const handlePointerEnd = () => {
    clearPressTimer();
  };

  const handlePointerLeave = () => {
    clearPressTimer();
    longPressTriggeredRef.current = false;
  };

  const handlePointerCancel = () => {
    clearPressTimer();
    longPressTriggeredRef.current = false;
  };

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    longPressTriggeredRef.current = false;
    setAnchorEl(e.currentTarget);
  };

  const handleMenuClose = () => {
    longPressTriggeredRef.current = false;
    setAnchorEl(null);
  };

  const handleMenuAction = (action?: () => void) => {
    longPressTriggeredRef.current = false;
    setAnchorEl(null);
    action?.();
  };

  return (
    <Card
      variant="outlined"
      sx={{
        ...buildInteractiveSurfaceSx({ selected: Boolean(selected) }),
        height: '100%',
        containerType: 'inline-size',
        contentVisibility: 'auto',
        containIntrinsicSize: '132px',
        overflow: 'hidden',
        ...buildCardAvatarHoverMotionSx('.character-card-avatar'),
        '&::before': {
          ...buildSelectionRailSx(Boolean(selected)),
        },
        ...(selected ? {
          boxShadow: (theme) => theme.palette.mode === 'light'
            ? '0 0 0 2px rgba(49,90,156,0.30) inset, 0 14px 34px rgba(49,90,156,0.12)'
            : '0 0 0 2px rgba(120,156,220,0.34) inset, 0 18px 42px rgba(0,0,0,0.34)',
        } : {}),
      }}
    >
      <Box sx={{ position: 'relative', height: '100%' }}>
        {selectionMode && selectable ? (
          <Box
            role="checkbox"
            aria-checked={Boolean(selected)}
            tabIndex={0}
            onClick={(event) => { event.stopPropagation(); handleClick(); }}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); handleClick(); } }}
            sx={{ position: 'absolute', top: 6, left: 6, zIndex: 2, p: 0.35, borderRadius: 1, cursor: 'pointer', color: selected ? 'primary.main' : 'action.disabled', bgcolor: selected ? 'background.paper' : 'transparent', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 } }}
          >
            <CheckCircleIcon fontSize="small" />
          </Box>
        ) : null}
        {(onEdit || onDelete) && (
          <IconButton
            size="small"
            onClick={handleMenuOpen}
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 1,
              borderRadius: 1,
              bgcolor: 'transparent',
              transition: transition(['background-color', 'transform'], motion.durations.fast, motion.softOut),
              '&:hover': {
                bgcolor: 'action.hover',
                transform: 'scale(1.04)',
              },
              '&:active': {
                transform: 'scale(0.94)',
              },
              '@container (max-width: 175px)': {
                top: 4,
                right: 4,
              },
            }}
          >
            <MoreIcon fontSize="small" />
          </IconButton>
        )}
        <CardActionArea
          onClick={handleClick}
          onPointerDown={startLongPress}
          onPointerUp={handlePointerEnd}
          onPointerLeave={handlePointerLeave}
          onPointerCancel={handlePointerCancel}
          onContextMenu={handleContextMenu}
          disabled={!onClick && !selectable}
          sx={{
            height: '100%',
          }}
        >
          <CardContent sx={{
            p: 2,
            height: '100%',
            '&:last-child': { pb: 2 },
            '@container (max-width: 175px)': {
              p: 1.25,
              '&:last-child': { pb: 1.25 },
            },
          }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gridTemplateRows: 'auto auto', columnGap: 1, rowGap: 0.35, minWidth: 0, alignItems: 'center', '@container (max-width: 175px)': { columnGap: 0.75, rowGap: 0.25 } }}>
              <Avatar
                className="character-card-avatar"
                src={isImageAvatar(character.avatar) ? resolveSafeAvatarSrc(character.avatar) : undefined}
                slotProps={{ img: { onError: () => rememberFailedAvatarUrl(character.avatar), loading: 'lazy', decoding: 'async' } }}
                sx={{ gridRow: '1 / span 2', width: 36, height: 36, fontSize: '1rem', bgcolor: 'primary.light', flexShrink: 0, '@container (max-width: 175px)': { width: 32, height: 32, fontSize: '0.9rem' } }}>
                {isImageAvatar(character.avatar) ? undefined : character.avatar}
              </Avatar>
              <Typography variant="subtitle1" noWrap sx={{ minWidth: 0, pr: (onEdit || onDelete) ? 4 : 0, fontWeight: 400, '@container (max-width: 175px)': { fontSize: '0.9rem', lineHeight: 1.25 } }}>
                {character.name}
              </Typography>
              {character.group || character.isPreset || character.expertise.length > 0 ? (
                <Box sx={{ gridColumn: 2, display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, '@container (max-width: 175px)': { gap: 0.4 } }}>
                  {character.group || character.isPreset ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4, flexShrink: 0, minWidth: 0, maxWidth: '55%', overflow: 'hidden' }}>
                      {character.group ? (
                        <Chip label={character.group} size="small" color="primary" variant="outlined" sx={{ height: 22, minWidth: 0, maxWidth: '100%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, '@container (max-width: 175px)': { height: 20, fontSize: '0.68rem', '& .MuiChip-label': { px: 0.65 } } }} />
                      ) : null}
                      {character.isPreset ? (
                        <Chip label="Preset" size="small" color="secondary" variant="filled" sx={{ height: 22, '@container (max-width: 175px)': { height: 20, fontSize: '0.68rem' } }} />
                      ) : null}
                    </Box>
                  ) : null}
                  {character.expertise.length > 0 ? (
                    <Typography variant="caption" color="text.secondary" sx={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatExpertiseList(character.expertise, i18n.language).join(' / ')}
                    </Typography>
                  ) : null}
                </Box>
              ) : <Box sx={{ gridColumn: 2 }} />}
            </Box>
            {character.background?.trim() ? (
              <Typography
                variant="body2"
                sx={{ mt: 0.75, lineHeight: 1.4, color: 'text.secondary', opacity: 0.88, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', '@container (max-width: 175px)': { mt: 0.5, fontSize: '0.75rem' } }}
              >
                {character.background.trim()}
              </Typography>
            ) : null}
          </CardContent>
        </CardActionArea>
      </Box>

      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleMenuClose}>
        {onStartDirectChat && !selectionMode ? (
          <MenuItem onClick={() => handleMenuAction(onStartDirectChat)}>
            {i18n.language.startsWith('zh') ? '发起单聊' : 'Start direct chat'}
          </MenuItem>
        ) : null}
        {onEdit && (
          <MenuItem
            onClick={() => handleMenuAction(onEdit)}
          >
            {t('common.edit')}
          </MenuItem>
        )}
        {onDelete && (
          <MenuItem
            onClick={() => handleMenuAction(onDelete)}
            sx={{ color: 'error.main' }}
          >
            {t('common.delete')}
          </MenuItem>
        )}
      </Menu>
    </Card>
  );
}
