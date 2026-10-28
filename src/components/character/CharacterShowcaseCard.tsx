import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar, Box, Button, Card, CardActionArea, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, Menu, MenuItem, Typography } from '@mui/material';
import MoreIcon from '@mui/icons-material/MoreVert';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import type { AICharacter } from '../../types/character';
import { formatExpertiseList } from '../../utils/expertise';
import { isImageAvatar } from '../../utils/avatar';
import { rememberFailedAvatarUrl, resolveSafeAvatarSrc } from '../../utils/avatarFallback';
import { buildInteractiveSurfaceSx, buildSelectionRailSx } from '../../styles/interaction';
import { motion, reducedMotionSx, transition } from '../../styles/motion';
import { useTranslation } from 'react-i18next';
import { avatarGenerationQueue, type AvatarGenerationStatus } from '../../services/avatarGenerationQueue';
import { getCharacterCompletionTaskStatus, subscribeCharacterCompletionQueue, type CharacterCompletionStatus } from '../../services/characterCompletionQueue';
import { buildCardAvatarHoverMotionSx, buildCardAvatarReducedMotionSx } from '../../styles/avatarHoverMotion';

const SHOWCASE_HEADER_HEIGHT = 48;

const visualGlassSurfaceSx = {
  // Neutral veil first, blur second: the image should support the surface,
  // never tint the text area into a muddy colour.
  backdropFilter: 'blur(14px) saturate(1.02)',
  WebkitBackdropFilter: 'blur(14px) saturate(1.02)',
  bgcolor: (theme: { palette: { mode: string } }) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.93)' : 'rgba(12,16,24,0.92)',
};

interface CharacterShowcaseCardProps {
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

function getPrimaryVisualImage(character: AICharacter) {
  const images = Array.isArray(character.visualIdentity?.referenceImages) && character.visualIdentity.referenceImages.length
    ? character.visualIdentity.referenceImages
    : Array.isArray(character.visualReferenceImages) ? character.visualReferenceImages : [];
  return images.find((image) => image.id === character.visualIdentity?.primaryReferenceImageId || image.isPrimary) || images[0] || null;
}

function VisualPlaceholder({ name }: { name: string }) {
  return (
    <Box
      aria-label={`${name} 暂无形象图`}
      role="img"
      sx={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        color: 'primary.main',
        bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.045)' : 'rgba(120,156,220,0.08)',
        overflow: 'hidden',
        '& svg': {
          width: '100%',
          height: '100%',
          display: 'block',
          opacity: 0.72,
        },
        '@media (hover: hover)': {
          '& .placeholder-orbit': {
            animation: 'character-showcase-placeholder-orbit 5.8s linear infinite',
            animationPlayState: 'paused',
          },
          '& .placeholder-scan': {
            animation: 'character-showcase-placeholder-scan 3.2s linear infinite',
            animationPlayState: 'paused',
          },
          '& .placeholder-latitude': {
            animation: 'character-showcase-placeholder-latitude 4.2s ease-in-out infinite',
            animationPlayState: 'paused',
          },
          '& .placeholder-core': {
            animation: 'character-showcase-placeholder-core 2.6s ease-in-out infinite',
            animationPlayState: 'paused',
          },
          '& .placeholder-trace-a': {
            animation: 'character-showcase-placeholder-trace-a 3.6s ease-in-out infinite',
            animationPlayState: 'paused',
          },
          '& .placeholder-trace-b': {
            animation: 'character-showcase-placeholder-trace-b 2.9s ease-in-out infinite',
            animationPlayState: 'paused',
          },
          '&:hover .placeholder-orbit, &:hover .placeholder-scan, &:hover .placeholder-latitude, &:hover .placeholder-core, &:hover .placeholder-trace-a, &:hover .placeholder-trace-b': {
            animationPlayState: 'running',
          },
        },
        '@keyframes character-showcase-placeholder-orbit': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        '@keyframes character-showcase-placeholder-scan': {
          from: { strokeDashoffset: 24, opacity: 0.3 },
          '45%': { opacity: 0.72 },
          to: { strokeDashoffset: 0, opacity: 0.3 },
        },
        '@keyframes character-showcase-placeholder-latitude': {
          '0%, 100%': { opacity: 0.54, transform: 'scaleX(0.9)' },
          '50%': { opacity: 0.9, transform: 'scaleX(1.04)' },
        },
        '@keyframes character-showcase-placeholder-core': {
          '0%, 100%': { opacity: 0.56, transform: 'scale(0.86)' },
          '50%': { opacity: 1, transform: 'scale(1.12)' },
        },
        '@keyframes character-showcase-placeholder-trace-a': {
          '0%, 100%': { opacity: 0.42, transform: 'scaleX(0.62)' },
          '46%': { opacity: 0.72, transform: 'scaleX(1)' },
          '72%': { opacity: 0.52, transform: 'scaleX(0.82)' },
        },
        '@keyframes character-showcase-placeholder-trace-b': {
          '0%, 100%': { opacity: 0.34, transform: 'scaleX(0.74)' },
          '38%': { opacity: 0.58, transform: 'scaleX(1)' },
          '68%': { opacity: 0.42, transform: 'scaleX(0.54)' },
        },
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
          animation: 'none',
          transform: 'none',
          ...buildCardAvatarReducedMotionSx('.character-showcase-avatar'),
          '& .character-showcase-visual, & .character-showcase-focus': {
            transition: 'none !important',
            transform: 'none !important',
          },
        },
      }}
    >
      <svg viewBox="0 0 180 220" fill="none" aria-hidden="true">
        <rect x="30" y="22" width="120" height="174" rx="22" stroke="currentColor" strokeWidth="1.5" opacity="0.38" />
        <path d="M30 58V44c0-12 10-22 22-22h14M150 58V44c0-12-10-22-22-22h-14M30 160v14c0 12 10 22 22 22h14M150 160v14c0 12-10 22-22 22h-14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.72" />
        <g className="placeholder-orbit" style={{ transformOrigin: '90px 104px' }}>
          <circle cx="90" cy="104" r="42" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 8" opacity="0.62" />
          <circle cx="90" cy="62" r="3" fill="currentColor" opacity="0.72" />
          <circle cx="132" cy="104" r="3" fill="currentColor" opacity="0.72" />
        </g>
        <ellipse className="placeholder-latitude" cx="90" cy="104" rx="21" ry="42" stroke="currentColor" strokeWidth="2" opacity="0.82" style={{ transformOrigin: '90px 104px' }} />
        <path className="placeholder-scan" d="M48 104h84M90 62v84" stroke="currentColor" strokeWidth="1" strokeDasharray="4 8" strokeDashoffset="24" opacity="0.38" />
        <circle className="placeholder-core" cx="90" cy="104" r="5" fill="currentColor" style={{ transformOrigin: '90px 104px' }} />
        <path className="placeholder-trace-a" d="M57 169h66" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.58" style={{ transformOrigin: '90px 169px' }} />
        <path className="placeholder-trace-b" d="M69 181h42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.48" style={{ transformOrigin: '90px 181px' }} />
      </svg>
    </Box>
  );
}

export default function CharacterShowcaseCard({ character, onEdit, onDelete, onStartDirectChat, onClick, onLongPress, selected, selectable, selectionMode }: CharacterShowcaseCardProps) {
  const { t, i18n } = useTranslation();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [visualGenerationStatus, setVisualGenerationStatus] = useState<AvatarGenerationStatus | null>(null);
  const [avatarGenerationStatus, setAvatarGenerationStatus] = useState<AvatarGenerationStatus | null>(null);
  const [visualCompletionStatus, setVisualCompletionStatus] = useState<CharacterCompletionStatus | null>(null);
  const [avatarCompletionStatus, setAvatarCompletionStatus] = useState<CharacterCompletionStatus | null>(null);
  const [generatedVisualUrl, setGeneratedVisualUrl] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const descriptionRef = useRef<HTMLDivElement | null>(null);
  const [descriptionClamped, setDescriptionClamped] = useState(false);
  const pressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const visualImage = getPrimaryVisualImage(character);
  const visualSrc = generatedVisualUrl || (visualImage && isImageAvatar(visualImage.url) ? resolveSafeAvatarSrc(visualImage.url) : null);
  const visualGenerating = visualGenerationStatus === 'queued' || visualGenerationStatus === 'running'
    || visualCompletionStatus === 'queued' || visualCompletionStatus === 'running';
  const avatarGenerating = avatarGenerationStatus === 'queued' || avatarGenerationStatus === 'running'
    || avatarCompletionStatus === 'queued' || avatarCompletionStatus === 'running';
  const expertise = formatExpertiseList(Array.isArray(character.expertise) ? character.expertise : [], i18n.language).slice(0, 3);
  const background = typeof character.background === 'string' ? character.background.trim() : '';
  const speakingStyle = typeof character.speakingStyle === 'string' ? character.speakingStyle.trim() : '';
  const description = background || speakingStyle;
  const personalityLabels: Record<string, string> = i18n.language.startsWith('zh') ? {
    openness: '开放性', extroversion: '外向性', agreeableness: '宜人性', neuroticism: '敏感度', humor: '幽默感', creativity: '创造力', assertiveness: '决断力', empathy: '共情力',
  } : {
    openness: '开放性', extroversion: '外向性', agreeableness: '亲和力', neuroticism: '敏感度', humor: '幽默感', creativity: '创造力', assertiveness: '决断力', empathy: '共情力',
  };
  const visualDescription = character.visualIdentity?.description?.trim() || '';
  const personalitySummary = Object.entries(character.personality || {})
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .sort(([, a], [, b]) => Number(b) - Number(a))
    .slice(0, 4)
    .map(([key, value]) => `${personalityLabels[key] || key} ${value}`)
    .join(' · ');
  const coreProfile = character.coreProfile || {};
  const coreProfileItems = [
    ['核心欲望', coreProfile.coreDesire], ['核心恐惧', coreProfile.coreFear], ['社交面具', coreProfile.socialMask], ['自我形象', coreProfile.selfImage], ['依恋倾向', coreProfile.attachmentStyle], ['冲突风格', coreProfile.conflictStyle],
  ].filter(([, value]) => typeof value === 'string' && Boolean(value.trim())) as Array<[string, string]>;
  const speechItems = [
    ['口头禅', character.speechProfile?.catchphrases?.join('、')], ['常用语气', character.speechProfile?.fillers?.join('、')], ['说话风格', speakingStyle],
  ].filter(([, value]) => Boolean(value)) as Array<[string, string]>;

  useLayoutEffect(() => {
    const element = descriptionRef.current;
    if (!element) return;
    setDescriptionClamped(element.scrollHeight > element.clientHeight + 1);
  }, [description]);

  useEffect(() => {
    const updateCompletionStatus = () => {
      setVisualCompletionStatus(getCharacterCompletionTaskStatus(character.id, 'visual'));
      setAvatarCompletionStatus(getCharacterCompletionTaskStatus(character.id, 'avatar'));
    };
    updateCompletionStatus();
    const unsubscribeCompletion = subscribeCharacterCompletionQueue(updateCompletionStatus);
    const unsubscribeImage = avatarGenerationQueue.subscribeTarget(`character-visual:${character.id}`, (state) => {
      setVisualGenerationStatus(state.status);
      setGeneratedVisualUrl(state.status === 'succeeded' ? state.imageDataUrl : null);
    });
    const unsubscribeAvatar = avatarGenerationQueue.subscribeTarget(`character:${character.id}`, (state) => setAvatarGenerationStatus(state.status));
    return () => {
      unsubscribeCompletion();
      unsubscribeImage();
      unsubscribeAvatar();
    };
  }, [character.id]);

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

  const handleMenuAction = (action?: () => void) => {
    longPressTriggeredRef.current = false;
    setAnchorEl(null);
    action?.();
  };

  return (
    <Card
      variant="outlined"
      sx={{
        ...buildInteractiveSurfaceSx({ selected: Boolean(selected), radius: 1.5 }),
        width: '100%',
        alignSelf: 'start',
        contentVisibility: 'auto',
        containIntrinsicSize: '360px',
        overflow: 'hidden',
        borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.14)' : 'rgba(160,180,220,0.16)',
        bgcolor: 'background.paper',
        transition: transition(['box-shadow', 'border-color'], motion.durations.fast, motion.softOut),
        ...buildCardAvatarHoverMotionSx('.character-showcase-avatar'),
        '@media (hover: hover)': {
          '&:hover': {
            borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.28)' : 'rgba(160,180,220,0.30)',
            boxShadow: (theme) => theme.palette.mode === 'light'
              ? '0 12px 28px rgba(36,54,88,0.10)'
              : '0 16px 34px rgba(0,0,0,0.24)',
          },
          '&:is(:hover, :focus-within) .character-showcase-visual': {
            transform: 'translate3d(0, 0, 0) scale(1.075)',
          },
          '&:is(:hover, :focus-within) .character-showcase-focus': {
            opacity: 1,
            transform: 'scale(1.01)',
          },
        },
        ...reducedMotionSx,
        '&::before': { ...buildSelectionRailSx(Boolean(selected)) },
        ...(selected ? {
          boxShadow: (theme) => theme.palette.mode === 'light'
            ? '0 0 0 2px rgba(49,90,156,0.30) inset, 0 18px 38px rgba(49,90,156,0.14)'
            : '0 0 0 2px rgba(120,156,220,0.34) inset, 0 20px 44px rgba(0,0,0,0.36)',
        } : {}),
      }}
    >
      <Box sx={{ position: 'relative' }}>
        {selectionMode && selectable ? (
          <Box
            role="checkbox"
            aria-checked={Boolean(selected)}
            tabIndex={0}
            onClick={(event) => { event.stopPropagation(); handleClick(); }}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); handleClick(); } }}
            sx={{ position: 'absolute', top: 6, left: 6, zIndex: 3, p: 0.35, borderRadius: 1, cursor: 'pointer', color: selected ? 'primary.main' : 'action.disabled', bgcolor: selected ? 'background.paper' : 'transparent', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 } }}
          >
            <CheckCircleIcon fontSize="small" />
          </Box>
        ) : null}
        {(onEdit || onDelete) ? (
          <IconButton
            size="small"
            aria-label={i18n.language.startsWith('zh') ? `${character.name} 的菜单` : `Menu for ${character.name}`}
            onClick={(event) => {
              event.stopPropagation();
              longPressTriggeredRef.current = false;
              setAnchorEl(event.currentTarget);
            }}
            sx={{
              position: 'absolute', top: 10, right: 10, zIndex: 5, borderRadius: 1,
              bgcolor: 'transparent',
              transition: transition(['background-color', 'transform'], motion.durations.fast, motion.softOut),
              '&:hover': { bgcolor: 'action.hover', transform: 'scale(1.04)' },
            }}
          >
            <MoreIcon fontSize="small" />
          </IconButton>
        ) : null}
          <CardActionArea
          component="div"
          role="button"
          tabIndex={!onClick && !selectable ? -1 : 0}
          onClick={handleClick}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleClick();
            }
          }}
          onPointerDown={startLongPress}
          onPointerUp={clearPressTimer}
          onPointerLeave={() => { clearPressTimer(); longPressTriggeredRef.current = false; }}
          onPointerCancel={() => { clearPressTimer(); longPressTriggeredRef.current = false; }}
          onContextMenu={(event) => {
            if (!onLongPress) return;
            event.preventDefault();
            longPressTriggeredRef.current = true;
            onLongPress();
          }}
          sx={{ display: 'block', alignItems: 'stretch', textAlign: 'left' }}
        >
          <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', overflow: 'hidden', bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.04)' : 'rgba(120,156,220,0.07)' }}>
            <Box sx={{ position: 'relative', flex: `0 0 ${SHOWCASE_HEADER_HEIGHT}px`, zIndex: 2, display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.5, pr: (onEdit || onDelete) ? 5 : 1.25, overflow: 'hidden', borderBottom: '1px solid', borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.12)' : 'rgba(160,180,220,0.14)', ...visualGlassSurfaceSx, boxShadow: 'none', textShadow: (theme) => theme.palette.mode === 'light' ? '0 1px 2px rgba(255,255,255,0.64)' : '0 1px 2px rgba(0,0,0,0.48)' }}>
              {visualSrc ? <Box component="img" src={visualSrc} aria-hidden="true" loading="lazy" decoding="async" sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', opacity: 0.11, filter: 'blur(8px) saturate(0.78)', transform: 'scaleY(-1) scale(1.06)' }} /> : null}
              <Box sx={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
              <Box sx={{ position: 'relative', width: 34, height: 34, flexShrink: 0 }}>
                <Avatar
                  className="character-showcase-avatar"
                  src={isImageAvatar(character.avatar) ? resolveSafeAvatarSrc(character.avatar) : undefined}
                  slotProps={{ img: { onError: () => rememberFailedAvatarUrl(character.avatar), loading: 'lazy', decoding: 'async' } }}
                  sx={{ width: 34, height: 34, fontSize: '1rem', bgcolor: 'primary.light', viewTransitionName: `character-avatar-${character.id}` }}
                >
                  {isImageAvatar(character.avatar) ? undefined : character.avatar}
                </Avatar>
                {avatarGenerating ? (
                  <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', borderRadius: '50%', bgcolor: 'rgba(10,15,25,0.52)', color: 'common.white' }}>
                    <CircularProgress size={18} thickness={4} color="inherit" />
                  </Box>
                ) : null}
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700, lineHeight: 1.2, letterSpacing: '-0.01em' }}>{character.name}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {character.group || (i18n.language.startsWith('zh') ? '未分组' : 'Ungrouped')}
                  </Typography>
                </Box>
              </Box>
              </Box>
            </Box>
            <Box className="character-showcase-visual-frame" sx={{ position: 'relative', flex: '0 0 auto', aspectRatio: '1 / 1', overflow: 'hidden', bgcolor: 'action.hover', contain: 'paint' }}>
              {visualSrc ? (
                <Box
                  component="img"
                  className="character-showcase-visual-backdrop"
                  src={visualSrc}
                  aria-hidden="true"
                  loading="lazy"
                  decoding="async"
                  sx={{ position: 'absolute', inset: '-10%', width: '120%', height: '120%', display: 'block', objectFit: 'cover', objectPosition: 'center', opacity: 0.32, filter: 'blur(18px) saturate(0.82)', transform: 'scale(1.035)' }}
                />
              ) : null}
              {visualSrc ? (
                <Box
                  component="img"
                  src={visualSrc}
                  alt={`${character.name} ${i18n.language.startsWith('zh') ? '形象图' : 'visual identity'}`}
                  onError={() => { if (visualImage?.url) rememberFailedAvatarUrl(visualImage.url); }}
                  loading="lazy"
                  decoding="async"
                  className="character-showcase-visual"
                  sx={{ position: 'relative', zIndex: 0, width: '100%', height: '100%', display: 'block', objectFit: 'contain', objectPosition: 'center', transform: 'translate3d(0, 0, 0) scale(1)', transformOrigin: 'center center', backfaceVisibility: 'hidden', transition: transition(['transform'], 520, motion.softInOut), willChange: 'transform' }}
                />
              ) : <VisualPlaceholder name={character.name} />}
              <Box
                className="character-showcase-focus"
                aria-hidden="true"
                sx={{
                  position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', opacity: 0,
                  transform: 'scale(1)',
                  transition: transition(['opacity', 'transform'], motion.durations.settle, motion.emphasized),
                  boxShadow: (theme) => theme.palette.mode === 'light'
                    ? 'inset 0 0 0 1px rgba(255,255,255,0.22), inset 0 -34px 42px rgba(20,35,64,0.07)'
                    : 'inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 -34px 42px rgba(0,0,0,0.14)',
                  background: (theme) => theme.palette.mode === 'light'
                    ? 'radial-gradient(circle at 50% 42%, rgba(255,255,255,0.07), transparent 48%)'
                    : 'radial-gradient(circle at 50% 42%, rgba(255,255,255,0.055), transparent 48%)',
                }}
              />
              {visualGenerating ? (
                <Box sx={{ position: 'absolute', inset: 0, zIndex: 1, display: 'grid', placeItems: 'center', alignContent: 'center', gap: 0.75, bgcolor: 'rgba(10,15,25,0.26)', color: 'common.white', textAlign: 'center', backdropFilter: 'blur(2px)', animation: 'character-showcase-generating 2.2s ease-in-out infinite', '@keyframes character-showcase-generating': { '0%, 100%': { opacity: 0.72 }, '50%': { opacity: 1 } }, ...reducedMotionSx }}>
                  <CircularProgress size={28} thickness={4} color="inherit" />
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>{i18n.language.startsWith('zh') ? '正在生成形象图' : 'Generating visual identity'}</Typography>
                </Box>
              ) : null}
            </Box>
            <Box sx={{ position: 'relative', zIndex: 2, flexShrink: 0, overflow: 'hidden', px: 1.25, pt: 1.1, pb: 1.1, color: (theme) => theme.palette.mode === 'light' ? 'text.primary' : 'common.white', ...visualGlassSurfaceSx, borderTop: '1px solid', borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.12)', boxShadow: 'none' }}>
              {visualSrc ? <Box component="img" src={visualSrc} aria-hidden="true" loading="lazy" decoding="async" sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center bottom', opacity: 0.11, filter: 'blur(8px) saturate(0.78)', transform: 'scaleY(-1) scale(1.06)' }} /> : null}
              <Box sx={{ position: 'relative', zIndex: 1 }}>
              <Box>
                <Typography ref={descriptionRef} variant="body2" color="text.secondary" sx={{ display: '-webkit-box', minHeight: '4.2em', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, lineHeight: 1.45, fontSize: '0.82rem' }}>
                {description || (i18n.language.startsWith('zh') ? '尚未填写角色介绍' : 'No character introduction yet')}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minHeight: 20, mt: 0.65 }}>
                {expertise.length ? (
                  <Box sx={{ minWidth: 0, flex: 1, overflow: 'hidden', color: 'text.secondary' }}>
                    <Typography variant="caption" noWrap sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', fontSize: '0.68rem' }}>
                      {expertise.join(' · ')}
                    </Typography>
                  </Box>
                ) : <Box />}
                <Button size="small" variant="text" onClick={(event) => { event.stopPropagation(); setDetailsOpen(true); }} sx={{ minWidth: 0, px: 0.25, py: 0, height: 20, fontSize: '0.72rem', color: 'text.secondary', '&:hover': { bgcolor: 'transparent', color: 'primary.main' } }}>{i18n.language.startsWith('zh') ? '详情' : 'More'}</Button>
              </Box>
              </Box>
            </Box>
          </Box>
        </CardActionArea>
      </Box>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        {onStartDirectChat && !selectionMode ? <MenuItem onClick={() => handleMenuAction(onStartDirectChat)}>{i18n.language.startsWith('zh') ? '发起单聊' : 'Start direct chat'}</MenuItem> : null}
        {onEdit ? <MenuItem onClick={() => handleMenuAction(onEdit)}>{t('common.edit')}</MenuItem> : null}
        {onDelete ? <MenuItem sx={{ color: 'error.main' }} onClick={() => handleMenuAction(onDelete)}>{t('common.delete')}</MenuItem> : null}
      </Menu>
      <Dialog open={detailsOpen} onClose={() => setDetailsOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>{character.name}</DialogTitle>
        <DialogContent dividers sx={{ display: 'grid', gap: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Avatar src={isImageAvatar(character.avatar) ? resolveSafeAvatarSrc(character.avatar) : undefined} sx={{ width: 44, height: 44, bgcolor: 'primary.light' }}>
              {isImageAvatar(character.avatar) ? undefined : character.avatar}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" color="text.secondary">{character.group || (i18n.language.startsWith('zh') ? '未分组' : 'Ungrouped')}</Typography>
              {expertise.length ? <Typography variant="caption" color="text.secondary">{expertise.join(' · ')}</Typography> : null}
            </Box>
          </Box>
          <Divider />
          <Box>
            <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '角色介绍' : 'Introduction'}</Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.45 }}>{background || '—'}</Typography>
          </Box>
          {speechItems.map(([label, value]) => <Box key={label}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.35 }}>{value}</Typography></Box>)}
          {visualDescription ? <Box><Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '形象设定' : 'Visual identity'}</Typography><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.45 }}>{visualDescription}</Typography></Box> : null}
          {personalitySummary ? <Box><Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '人物性格' : 'Personality'}</Typography><Typography variant="body2" sx={{ mt: 0.45 }}>{personalitySummary}</Typography></Box> : null}
          {coreProfileItems.length ? <Box><Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '角色画像' : 'Character profile'}</Typography><Box sx={{ display: 'grid', gap: 0.7, mt: 0.45 }}>{coreProfileItems.map(([label, value]) => <Box key={label}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{value}</Typography></Box>)}</Box></Box> : null}
        </DialogContent>
        <DialogActions><Button onClick={() => setDetailsOpen(false)}>{i18n.language.startsWith('zh') ? '关闭' : 'Close'}</Button></DialogActions>
      </Dialog>
    </Card>
  );
}
