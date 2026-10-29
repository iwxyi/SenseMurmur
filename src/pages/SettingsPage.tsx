import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Checkbox,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
  Button,
  Chip,
  IconButton,
  TextField,
  ToggleButtonGroup,
  ToggleButton,
  FormControlLabel,
  Switch,
  Tooltip,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import BackupIcon from '@mui/icons-material/Download';
import RestoreIcon from '@mui/icons-material/Upload';
import ClearIcon from '@mui/icons-material/Delete';
import LogoutIcon from '@mui/icons-material/Logout';
import SyncIcon from '@mui/icons-material/Sync';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSettingsStore } from '../stores/useSettingsStore';
import { ApiError, api } from '../services/api';
import { useAuthStore } from '../stores/useAuthStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useLocalWorkspaceStore } from '../stores/useLocalWorkspaceStore';
import ConfirmDialog from '../components/common/ConfirmDialog';
import SurfaceCard from '../components/common/SurfaceCard';
import PageSection from '../components/common/PageSection';
import SectionHeader from '../components/common/SectionHeader';
import StatChipRow from '../components/common/StatChipRow';
import AppSnackbar from '../components/common/AppSnackbar';
import FloatingSegmentedTabs from '../components/common/FloatingSegmentedTabs';
import { buildFloatingTabContainerSx } from '../components/common/FloatingSegmentedTabs.styles';
import AnimatedTabContent from '../components/common/AnimatedTabContent';
import { resolveTabTransitionDirection } from '../components/common/tabTransition';
import { PAPER_SURFACE_VARIANTS, type PaperSurfaceVariant } from '../types/artifactAppearance';
import type { AppSettingsWithMemory, ChatAppearanceSettings, CompanionshipRitualKind } from '../types/settings';
import { migrateLegacyBrandStorageKeys } from '../constants/brand';
import BubbleStylePickerDialog from '../components/bubble/BubbleStylePickerDialog';
import { DefaultUserAvatarIcon } from '../components/common/IdentityIcons';
import { DEFAULT_AI_BUBBLE_STYLE_ID } from '../constants/bubbleStyles';
import { buildBubblePreview, resolveCharacterBubbleStyle } from '../utils/bubbleStyle';
import { isImageAvatar } from '../utils/avatar';
import { APP_THEME_PRESETS, POPULAR_THEME_PRESET_COUNT, resolveThemePreset, type AppThemePreset } from '../theme';
import { getWebDirectoryPickerSupport } from '../services/localWorkspaceService';
import { AIModelsPanel } from './AIModelsPage';
import { SETTINGS_TAB_KEYS, buildSettingsPath, getSettingsTabForCard, resolveSettingsTab, type SettingsTabKey } from '../routes/settingsRoute';
import { clearAllCachedSpeechPlayback } from '../services/speechPlaybackCache';
import ChatReplyPreferencesSection from '../components/settings/ChatReplyPreferencesSection';
import { normalizeChatReplyPreferences } from '../types/chatReplyPreferences';

function buildPageSx(activeTab: SettingsTabKey) {
  return {
    p: { xs: 2.5, sm: 3, md: 3.5 },
    pt: { xs: 1, sm: 1, md: 3 },
    pb: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 82px)', sm: 3, md: 3.5 },
    width: '100%',
    maxWidth: activeTab === 'models' ? 1320 : 960,
    mx: 'auto',
  };
}

function buildToggleGroupSx() {
  return { alignItems: 'center', justifyContent: 'flex-start', overflow: 'visible', flexWrap: 'wrap' as const, gap: 0.5 };
}

const RITUAL_KIND_OPTIONS: Array<{ kind: CompanionshipRitualKind; zh: string; en: string }> = [
  { kind: 'daily_greeting', zh: '日常问候', en: 'Greetings' },
  { kind: 'pet_name', zh: '专属称呼', en: 'Pet names' },
  { kind: 'anniversary', zh: '纪念日', en: 'Anniversaries' },
  { kind: 'inside_joke', zh: '共同梗', en: 'Inside jokes' },
  { kind: 'reconciliation', zh: '和好', en: 'Reconciliation' },
  { kind: 'milestone', zh: '里程碑', en: 'Milestones' },
];

function buildThemePresetGridSx() {
  return {
    display: 'grid',
    gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' },
    gap: 1,
  };
}

function buildThemePresetButtonSx(preset: AppThemePreset, selected: boolean) {
  const [primary, secondary, accent] = preset.preview;
  return {
    alignItems: 'stretch',
    justifyContent: 'stretch',
    minHeight: { xs: 138, sm: 154 },
    px: { xs: 0.8, sm: 1.05 },
    py: { xs: 0.8, sm: 1.05 },
    borderRadius: 2,
    textTransform: 'none',
    whiteSpace: 'normal',
    overflow: 'hidden',
    position: 'relative',
    borderColor: selected ? primary : 'divider',
    bgcolor: selected ? `${primary}10` : 'background.paper',
    color: 'text.primary',
    boxShadow: selected ? `0 0 0 1px ${primary}44, 0 16px 34px ${primary}1F` : '0 1px 0 rgba(15,23,42,0.02)',
    transition: 'transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease, background-color 180ms ease',
    '@keyframes themeDotBob': {
      '0%, 100%': { transform: 'translateY(0) scale(1)' },
      '34%': { transform: 'translateY(-4px) scale(1.04)' },
      '68%': { transform: 'translateY(2px) scale(0.98)' },
    },
    '@keyframes themeLineRhythmA': {
      '0%, 100%': { transform: 'scaleX(0.72)', opacity: 0.68 },
      '45%': { transform: 'scaleX(1)', opacity: 0.96 },
    },
    '@keyframes themeLineRhythmB': {
      '0%, 100%': { transform: 'scaleX(1)', opacity: 0.88 },
      '52%': { transform: 'scaleX(0.58)', opacity: 0.62 },
    },
    '@keyframes themeLineRhythmC': {
      '0%, 100%': { transform: 'scaleX(0.52)', opacity: 0.58 },
      '60%': { transform: 'scaleX(0.86)', opacity: 0.86 },
    },
    '@keyframes themePreviewDrift': {
      '0%, 100%': { transform: 'translate3d(0, 0, 0)' },
      '50%': { transform: 'translate3d(0, -2px, 0)' },
    },
    '@keyframes themeBubbleRise': {
      '0%, 26%': { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      '54%': { transform: 'translate3d(0, -14px, 0)', opacity: 0 },
      '55%': { transform: 'translate3d(0, 10px, 0)', opacity: 0 },
      '78%, 100%': { transform: 'translate3d(0, 0, 0)', opacity: 1 },
    },
    '&::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      background: `linear-gradient(135deg, ${primary}10 0%, transparent 38%, ${accent}0F 100%)`,
      opacity: selected ? 1 : 0,
      transition: 'opacity 180ms ease',
    },
    '&:hover': {
      transform: 'translateY(-2px)',
      borderColor: primary,
      bgcolor: `${secondary}0F`,
      boxShadow: `0 0 0 1px ${primary}30, 0 18px 38px ${primary}1A`,
    },
    '&:hover::before': {
      opacity: 1,
    },
    '&:hover .theme-wave-dot': {
      animationPlayState: 'running',
    },
    '&:hover .theme-rhythm-line': {
      animationPlayState: 'running',
    },
    '&:hover .theme-ui-preview': {
      animationPlayState: 'running',
    },
    '&:hover .theme-floating-bubble': {
      animationPlayState: 'running',
    },
    ...(selected ? {
      '& .theme-wave-dot': {
        animationPlayState: 'running',
      },
      '& .theme-rhythm-line, & .theme-ui-preview, & .theme-floating-bubble': {
        animationPlayState: 'running',
      },
    } : {}),
    '@media (prefers-reduced-motion: reduce)': {
      transition: 'none',
      '&:hover': {
        transform: 'none',
      },
      '& .theme-wave-dot, & .theme-rhythm-line, & .theme-ui-preview, & .theme-floating-bubble': {
        animation: 'none',
      },
    },
  };
}

function buildThemeMiniPreviewSx(preset: AppThemePreset) {
  const [primary, secondary, accent] = preset.preview;
  return {
    display: 'grid',
    gridTemplateRows: 'auto 1fr',
    gap: { xs: 0.75, sm: 1 },
    minHeight: { xs: 78, sm: 92 },
    p: { xs: 0.75, sm: 1 },
    borderRadius: 1.5,
    border: '1px solid',
    borderColor: 'divider',
    position: 'relative',
    overflow: 'hidden',
    background: `radial-gradient(circle at 16% 12%, ${primary}24 0, transparent 30%), radial-gradient(circle at 88% 18%, ${secondary}20 0, transparent 28%), linear-gradient(135deg, ${primary}13 0%, ${secondary}0F 52%, ${accent}15 100%)`,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28)',
    '&::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      background: 'linear-gradient(135deg, rgba(255,255,255,0.34) 0%, transparent 36%, rgba(255,255,255,0.12) 100%)',
    },
    '& > *': {
      position: 'relative',
      zIndex: 1,
    },
  };
}

function buildPaperPickerSx() {
  return {
    display: 'grid',
    gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
    gap: 0.6,
    alignItems: 'stretch',
  };
}

function buildPaperToggleSx() {
  return {
    display: 'grid',
    gap: 0.45,
    justifyItems: 'stretch',
    alignContent: 'start',
    minHeight: 94,
    px: 0.7,
    py: 0.65,
    borderRadius: '10px !important',
    textTransform: 'none',
    whiteSpace: 'normal',
    '&:first-of-type, &:last-of-type': {
      borderRadius: '10px !important',
    },
    '&.Mui-selected': {
      boxShadow: '0 0 0 1px rgba(103, 80, 164, 0.45)',
    },
  };
}

type VoiceWaveformStyle = ChatAppearanceSettings['voiceWaveformStyle'];

const VOICE_STYLE_OPTIONS: Array<{ value: VoiceWaveformStyle; zh: string; en: string }> = [
  { value: 'wave', zh: '流畅波形', en: 'Wave' },
  { value: 'blocks', zh: '方块节拍', en: 'Blocks' },
  { value: 'neon', zh: '主题霓虹', en: 'Neon' },
  { value: 'spectrum', zh: '渐变频谱', en: 'Spectrum' },
  { value: 'pulse', zh: '呼吸脉冲', en: 'Pulse' },
  { value: 'orbit', zh: '轨道粒子', en: 'Orbit' },
  { value: 'ribbon', zh: '丝带曲线', en: 'Ribbon' },
  { value: 'echo', zh: '回声涟漪', en: 'Echo' },
  { value: 'constellation', zh: '星图节点', en: 'Constellation' },
  { value: 'helix', zh: '双螺旋', en: 'Helix' },
  { value: 'comet', zh: '彗星轨迹', en: 'Comet' },
];

const POPULAR_VOICE_STYLE_COUNT = 4;

function VoiceStylePreview({ style, selected }: { style: VoiceWaveformStyle; selected: boolean }) {
  const bars = [8, 13, 18, 11, 16, 20, 14, 9, 17, 12, 7];
  const playState = selected ? 'running' : 'paused';
  const svgMotionStyle = { animationPlayState: playState } as const;
  return (
    <Box className="voice-style-preview" aria-hidden="true" sx={(theme) => ({
      '--voice-preview-primary': theme.palette.primary.main,
      '--voice-preview-secondary': theme.palette.secondary.main,
      height: 20,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 0.3,
      overflow: 'hidden',
      '@keyframes voicePreviewWaveDrift': { from: { strokeDashoffset: 0 }, to: { strokeDashoffset: -36 } },
      '@keyframes voicePreviewWaveBreathe': { '0%, 100%': { transform: 'scaleY(.82)' }, '50%': { transform: 'scaleY(1.08)' } },
      '@keyframes voicePreviewBlockBeat': { '0%, 18%, 100%': { transform: 'scaleY(.5)', opacity: 0.48 }, '38%': { transform: 'scaleY(1.12)', opacity: 1 }, '58%': { transform: 'scaleY(.72)', opacity: 0.72 } },
      '@keyframes voicePreviewNeonRun': { from: { strokeDashoffset: 42 }, to: { strokeDashoffset: -42 } },
      '@keyframes voicePreviewNeonGlow': { '0%, 100%': { opacity: 0.55 }, '50%': { opacity: 1 } },
      '@keyframes voicePreviewSpectrumRise': { '0%, 100%': { transform: 'scaleY(.35)', filter: 'saturate(.8)' }, '45%': { transform: 'scaleY(1.08)', filter: 'saturate(1.35)' }, '68%': { transform: 'scaleY(.62)' } },
      '@keyframes voicePreviewPulseBreath': { '0%, 100%': { transform: 'scaleY(.48)', opacity: 0.42 }, '50%': { transform: 'scaleY(1)', opacity: 1 } },
      '@keyframes voicePreviewOrbit': { from: { transform: 'rotate(0deg) translateX(25px) rotate(0deg)' }, to: { transform: 'rotate(360deg) translateX(25px) rotate(-360deg)' } },
      '@keyframes voicePreviewOrbitReverse': { from: { transform: 'rotate(360deg) translateX(15px) rotate(-360deg)' }, to: { transform: 'rotate(0deg) translateX(15px) rotate(0deg)' } },
      '@keyframes voicePreviewRibbonFlow': { '0%, 100%': { transform: 'translateX(-2px) skewX(-2deg)' }, '50%': { transform: 'translateX(2px) skewX(2deg)' } },
      '@keyframes voicePreviewRibbonShimmer': { from: { strokeDashoffset: 28 }, to: { strokeDashoffset: -28 } },
      '@keyframes voicePreviewEcho': { '0%': { transform: 'scale(.55)', opacity: 0 }, '35%': { opacity: 0.8 }, '100%': { transform: 'scale(1.15)', opacity: 0 } },
      '@keyframes voicePreviewStars': { '0%, 100%': { transform: 'scale(.72)', opacity: 0.5 }, '50%': { transform: 'scale(1.35)', opacity: 1 } },
      '@keyframes voicePreviewHelix': { '0%, 100%': { transform: 'translateY(-4px)' }, '50%': { transform: 'translateY(4px)' } },
      '@keyframes voicePreviewComet': { from: { strokeDashoffset: 62 }, to: { strokeDashoffset: -20 } },
      '@media (prefers-reduced-motion: reduce)': { '& .voice-preview-motion': { animation: 'none !important' } },
    })}>
      {style === 'wave' ? (
        <svg viewBox="0 0 76 20" style={{ width: 76, height: 20, overflow: 'visible' }}>
          <path d="M1 10 C7 10 8 4 14 4 S22 16 28 16 S36 5 42 5 S50 14 56 14 S64 7 75 7" fill="none" stroke="var(--voice-preview-primary)" strokeWidth="1.8" strokeLinecap="round" opacity=".22" />
          <path className="voice-preview-motion" d="M1 10 C7 10 8 4 14 4 S22 16 28 16 S36 5 42 5 S50 14 56 14 S64 7 75 7" fill="none" stroke="var(--voice-preview-primary)" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="9 5" style={{ ...svgMotionStyle, animation: 'voicePreviewWaveDrift 1.45s linear infinite, voicePreviewWaveBreathe 2.2s ease-in-out infinite', animationPlayState: playState, transformOrigin: 'center' }} />
        </svg>
      ) : style === 'blocks' ? bars.map((height, index) => (
        <Box key={index} className="voice-preview-motion" sx={{ width: 4, height, borderRadius: 0.75, bgcolor: 'var(--voice-preview-primary)', transformOrigin: 'center', animation: `voicePreviewBlockBeat 1.35s cubic-bezier(.2,.8,.25,1) ${-(index % 6) * 0.11}s infinite`, animationPlayState: playState }} />
      )) : style === 'neon' ? (
        <svg viewBox="0 0 76 20" style={{ width: 76, height: 20, overflow: 'visible' }}>
          <path d="M1 12 C9 12 10 4 18 5 S28 16 36 9 S47 3 54 8 S65 14 75 6" fill="none" stroke="var(--voice-preview-secondary)" strokeWidth="5" strokeLinecap="round" opacity=".16" style={{ filter: 'blur(2px)' }} />
          <path className="voice-preview-motion" d="M1 12 C9 12 10 4 18 5 S28 16 36 9 S47 3 54 8 S65 14 75 6" fill="none" stroke="var(--voice-preview-secondary)" strokeWidth="2" strokeLinecap="round" strokeDasharray="7 4 2 4" style={{ animation: 'voicePreviewNeonRun 1.15s linear infinite, voicePreviewNeonGlow 1.8s ease-in-out infinite', animationPlayState: playState, filter: 'drop-shadow(0 0 3px var(--voice-preview-secondary))' }} />
        </svg>
      ) : style === 'spectrum' ? bars.map((height, index) => (
        <Box key={index} className="voice-preview-motion" sx={{ width: 3.5, height, borderRadius: 99, background: 'linear-gradient(180deg, var(--voice-preview-secondary), var(--voice-preview-primary))', transformOrigin: 'bottom', animation: `voicePreviewSpectrumRise ${0.92 + (index % 5) * 0.1}s cubic-bezier(.4,0,.2,1) ${-index * 0.085}s infinite`, animationPlayState: playState }} />
      )) : style === 'pulse' ? bars.map((height, index) => {
        const distance = Math.abs(index - (bars.length - 1) / 2);
        return <Box key={index} className="voice-preview-motion" sx={{ width: distance < 1 ? 4.5 : 3, height: Math.max(7, 20 - distance * 2.1), borderRadius: 99, bgcolor: distance < 2 ? 'var(--voice-preview-secondary)' : 'var(--voice-preview-primary)', transformOrigin: 'center', animation: `voicePreviewPulseBreath 1.5s ease-in-out ${distance * 0.08}s infinite`, animationPlayState: playState }} />;
      }) : style === 'echo' ? (
        <Box sx={{ width: 72, height: 20, position: 'relative', display: 'grid', placeItems: 'center' }}>
          {[0, 1, 2].map((index) => <Box key={index} className="voice-preview-motion" sx={{ position: 'absolute', width: 58, height: 16, border: '1.5px solid', borderColor: index === 1 ? 'var(--voice-preview-secondary)' : 'var(--voice-preview-primary)', borderRadius: '50%', animation: `voicePreviewEcho 2s ease-out ${index * 0.55}s infinite`, animationPlayState: playState }} />)}
          <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'var(--voice-preview-primary)' }} />
        </Box>
      ) : style === 'constellation' ? (
        <Box sx={{ width: 72, height: 20, position: 'relative' }}>
          <svg viewBox="0 0 72 20" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}><path d="M4 14 L17 6 L31 13 L45 4 L57 12 L68 7" fill="none" stroke="var(--voice-preview-primary)" strokeWidth=".8" opacity=".4" /></svg>
          {[[4, 14], [17, 6], [31, 13], [45, 4], [57, 12], [68, 7]].map(([left, top], index) => <Box key={left} className="voice-preview-motion" sx={{ position: 'absolute', left: left - 2, top: top - 2, width: index % 3 === 0 ? 5 : 4, height: index % 3 === 0 ? 5 : 4, borderRadius: '50%', bgcolor: index % 2 ? 'var(--voice-preview-secondary)' : 'var(--voice-preview-primary)', animation: `voicePreviewStars 1.65s ease-in-out ${index * 0.16}s infinite`, animationPlayState: playState }} />)}
        </Box>
      ) : style === 'helix' ? (
        <Box sx={{ width: 72, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {Array.from({ length: 9 }, (_, index) => <Box key={index} sx={{ width: 2, height: 12, position: 'relative', bgcolor: 'divider' }}><Box className="voice-preview-motion" sx={{ position: 'absolute', left: -1.5, top: -1.5, width: 5, height: 5, borderRadius: '50%', bgcolor: 'var(--voice-preview-primary)', animation: `voicePreviewHelix 1.45s ease-in-out ${index * 0.11}s infinite`, animationPlayState: playState }} /><Box className="voice-preview-motion" sx={{ position: 'absolute', left: -1.5, bottom: -1.5, width: 5, height: 5, borderRadius: '50%', bgcolor: 'var(--voice-preview-secondary)', animation: `voicePreviewHelix 1.45s ease-in-out ${index * 0.11 + 0.72}s infinite reverse`, animationPlayState: playState }} /></Box>)}
        </Box>
      ) : style === 'comet' ? (
        <svg viewBox="0 0 76 20" style={{ width: 76, height: 20, overflow: 'visible' }}>
          <path d="M1 13 C13 13 14 5 25 7 S39 16 49 9 S63 4 75 8" fill="none" stroke="var(--voice-preview-primary)" strokeWidth="1.4" opacity=".2" />
          <path className="voice-preview-motion" d="M1 13 C13 13 14 5 25 7 S39 16 49 9 S63 4 75 8" fill="none" stroke="var(--voice-preview-secondary)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="2 60" style={{ animation: 'voicePreviewComet 1.75s linear infinite', animationPlayState: playState, filter: 'drop-shadow(0 0 4px var(--voice-preview-secondary))' }} />
        </svg>
      ) : style === 'orbit' ? (
        <Box sx={{ width: 72, height: 20, position: 'relative', display: 'grid', placeItems: 'center' }}>
          <Box sx={{ position: 'absolute', width: 54, height: 15, border: '1px solid', borderColor: 'divider', borderRadius: '50%' }} />
          <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'var(--voice-preview-primary)', boxShadow: '0 0 7px color-mix(in srgb, var(--voice-preview-primary) 60%, transparent)' }} />
          <Box className="voice-preview-motion" sx={{ position: 'absolute', width: 4.5, height: 4.5, borderRadius: '50%', bgcolor: 'var(--voice-preview-secondary)', animation: 'voicePreviewOrbit 2.2s linear infinite', animationPlayState: playState }} />
          <Box className="voice-preview-motion" sx={{ position: 'absolute', width: 3, height: 3, borderRadius: '50%', bgcolor: 'var(--voice-preview-primary)', animation: 'voicePreviewOrbitReverse 1.55s linear infinite', animationPlayState: playState }} />
        </Box>
      ) : (
        <svg viewBox="0 0 76 20" style={{ width: 76, height: 20, overflow: 'visible' }}>
          <defs><linearGradient id="preview-ribbon" x1="0" y1="0" x2="1" y2="0"><stop stopColor="var(--voice-preview-primary)" /><stop offset=".52" stopColor="var(--voice-preview-secondary)" /><stop offset="1" stopColor="var(--voice-preview-primary)" /></linearGradient></defs>
          <g className="voice-preview-motion" style={{ animation: 'voicePreviewRibbonFlow 2.4s ease-in-out infinite', animationPlayState: playState, transformOrigin: 'center' }}>
            <path d="M1 7 C12 1 18 17 29 12 S45 2 54 8 S66 17 75 10" fill="none" stroke="url(#preview-ribbon)" strokeWidth="3.5" strokeLinecap="round" opacity=".38" />
            <path className="voice-preview-motion" d="M1 7 C12 1 18 17 29 12 S45 2 54 8 S66 17 75 10" fill="none" stroke="url(#preview-ribbon)" strokeWidth="1.7" strokeLinecap="round" strokeDasharray="12 5" style={{ animation: 'voicePreviewRibbonShimmer 1.8s linear infinite', animationPlayState: playState }} />
          </g>
        </svg>
      )}
    </Box>
  );
}

function buildActionGridSx() {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 1,
    '& .MuiButton-root': {
      minWidth: 0,
      px: { xs: 1, sm: 1.5 },
      whiteSpace: 'nowrap',
    },
  };
}

function buildCardBodySx() {
  return { p: { xs: 2, sm: 2.25, md: 2.5 }, '&:last-child': { pb: { xs: 2, sm: 2.25, md: 2.5 } } };
}

function buildSectionBodySx() {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: { xs: 1.25, sm: 1.45 },
    '& > .MuiBox-root:first-of-type': {
      mb: 0,
    },
    '& > .MuiBox-root:first-of-type .MuiTypography-caption': {
      mt: 0.25,
      lineHeight: 1.45,
    },
  };
}

function buildSettingsTabContentSx() {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: { xs: 2, sm: 2.25, md: 2.5 },
    minWidth: 0,
  };
}

function buildDeveloperBodySx() {
  return { display: 'flex', flexDirection: 'column', gap: 1.35 };
}

function buildAccountBubblePreviewSx() {
  return {
    mt: 1.5,
    display: 'flex',
    alignItems: 'center',
    gap: 1.25,
    minWidth: 0,
    cursor: 'pointer',
    border: '1px solid',
    borderColor: (theme: { palette: { mode: string } }) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
    borderRadius: 1.5,
    px: 1.25,
    py: 1,
    bgcolor: (theme: { palette: { mode: string } }) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.50)' : 'rgba(255,255,255,0.04)',
    WebkitTapHighlightColor: 'transparent',
    '&:active': { boxShadow: 'none' },
    backdropFilter: 'blur(16px) saturate(1.08)',
    WebkitBackdropFilter: 'blur(16px) saturate(1.08)',
    transition: 'border-color 160ms ease, background-color 160ms ease',
    '&:hover': {
      borderColor: 'primary.main',
      bgcolor: (theme: { palette: { mode: string } }) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.075)',
    },
  };
}

function buildDeveloperChips(language: string) {
  return [language.startsWith('zh') ? '调试' : 'Debug', language.startsWith('zh') ? '运行态证据' : 'Runtime evidence'];
}

function buildDeveloperSwitchGroupsSx() {
  return {
    display: 'grid',
    gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
    gap: 1,
    alignItems: 'start',
  };
}

function buildDeveloperSwitchGroupSx() {
  return {
    display: 'grid',
    alignContent: 'start',
    gap: 0.4,
    p: 1.25,
    borderRadius: 2,
    border: '1px solid',
    borderColor: 'divider',
    bgcolor: 'background.default',
    minWidth: 0,
  };
}

function buildDeveloperSwitchListSx() {
  return {
    display: 'grid',
    gap: 0.1,
    '& .MuiFormControlLabel-root': {
      m: 0,
      minHeight: 34,
      alignItems: 'center',
    },
    '& .MuiFormControlLabel-label': {
      fontSize: '0.875rem',
      lineHeight: 1.35,
    },
  };
}

type BackupSelection = Record<BackupSectionKey, boolean>;

type BackupTreeNode = {
  key: BackupSectionKey;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  children?: BackupTreeNode[];
};

type BackupNodeStats = Partial<Record<BackupSectionKey, number>>;

function collectNodeStats(data: BackupFileShape): BackupNodeStats {
  const stats: BackupNodeStats = {};
  const characters = Array.isArray(data.characters) ? data.characters.map((item) => item as Record<string, unknown>) : [];
  const chats = Array.isArray(data.chats) ? data.chats : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const settings = data.settings;

  stats.characters = characters.length;
  stats['characters.core'] = characters.length;
  stats['characters.relationships'] = characters.filter((item) => Boolean(item.relationships)).length;
  stats['characters.memory'] = characters.filter((item) => Boolean(item.memory || item.layeredMemories)).length;
  stats['characters.visual'] = characters.filter((item) => Boolean(item.visualIdentity || item.visualReferenceImages || item.bubbleStyle || item.bubbleStyleId)).length;
  stats['characters.runtime'] = characters.filter((item) => Boolean(item.runtimeTimeline || item.emotionalState || item.behavior)).length;
  stats['characters.modelBindings'] = characters.filter((item) => Boolean(item.modelProfileId || item.modelProfileIds)).length;

  stats.chats = chats.length;
  stats['chats.core'] = chats.length;
  stats['chats.runtime'] = chats.filter((item) => Boolean(item.runtimeSeed || item.runtimeTimeline || item.runtimeEventsV2 || item.modeConfig || item.modeState || item.directorControls)).length;
  stats['chats.relationships'] = chats.filter((item) => Boolean(item.relationshipLedger || item.governance || item.dramaRules)).length;
  stats['chats.world'] = chats.filter((item) => Boolean(item.worldState)).length;

  stats.messages = messages.length;
  stats['messages.content'] = messages.filter((item) => Boolean(item.type || item.content || item.senderId || item.senderName)).length;
  stats['messages.metadata'] = messages.filter((item) => Boolean(item.metadata)).length;

  stats.settings = settings ? 1 : 0;
  stats['settings.api'] = settings?.api ? 1 : 0;
  stats['settings.api.credentials'] = settings?.api?.apiKey ? 1 : 0;
  stats['settings.aiProfiles'] = Array.isArray(settings?.aiProfiles) ? settings.aiProfiles.length : 0;
  stats['settings.aiProfiles.credentials'] = Array.isArray(settings?.aiProfiles) ? settings.aiProfiles.filter((profile) => profile.apiKey).length : 0;
  stats['settings.appearance'] = settings && ('theme' in settings || 'themePreset' in settings || 'themeColor' in settings || 'language' in settings || 'customBubbleStyles' in settings || 'userBubbleStyleId' in settings || 'userBubbleStyle' in settings || 'artifactAppearance' in settings) ? 1 : 0;
  stats['settings.generation'] = settings && ('avatarGeneration' in settings || 'aiGeneration' in settings || 'companionship' in settings || 'chatMemory' in settings || 'chatReplyPreferences' in settings) ? 1 : 0;
  stats['settings.chatDraftDefaults'] = settings && ('defaultSpeed' in settings || 'chatDraftDefaults' in settings) ? 1 : 0;
  stats['settings.developer'] = settings && ('developerMode' in settings || 'developerUI' in settings || 'memoryUI' in settings) ? 1 : 0;
  stats['settings.usageStats'] = settings && 'usageStats' in settings ? 1 : 0;

  return stats;
}

function formatNodeLabel(node: BackupTreeNode, language: string) {
  return language.startsWith('zh') ? node.labelZh : node.labelEn;
}

function formatNodeCount(node: BackupTreeNode, stats?: BackupNodeStats) {
  if (!node.children?.length) return null;
  const count = stats?.[node.key];
  return typeof count === 'number' && count > 0 ? count : null;
}


function shouldShowNodeCount(node: BackupTreeNode, level: number, stats?: BackupNodeStats) {
  return level === 0 ? formatNodeCount(node, stats) : null;
}

function hasStructuredEntries(items: unknown[] | undefined) {
  return Array.isArray(items) && items.some((item) => Boolean(item && typeof item === 'object' && Object.keys(item as Record<string, unknown>).length > 0));
}

function hasSettingsData(settings: BackupFileShape['settings']) {
  return Boolean(settings && Object.keys(settings).length > 0);
}

function hasExportedCharacterCore(item: Record<string, unknown>) {
  return [
    'id',
    'name',
    'avatar',
    'personality',
    'expertise',
    'speakingStyle',
    'background',
    'group',
    'isPreset',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'fieldVersions',
  ].some((key) => key in item);
}

function hasExportedChatCore(item: Record<string, unknown>) {
  return [
    'id',
    'type',
    'mode',
    'name',
    'topic',
    'style',
    'runtimeEvolutionIntensity',
    'memberIds',
    'speed',
    'isActive',
    'allowIntervention',
    'showRoleActions',
    'topicSeed',
    'sourceChatId',
    'sourceMemberIds',
    'createdAt',
    'updatedAt',
    'lastMessageAt',
    'deletedAt',
    'fieldVersions',
  ].some((key) => key in item);
}

function hasExportedMessageContent(item: Record<string, unknown>) {
  return ['type', 'senderId', 'senderName', 'content', 'emotion', 'timestamp', 'isDeleted'].some((key) => key in item);
}

function hasLeafData(items: unknown[] | undefined, matcher: (item: Record<string, unknown>) => boolean) {
  return Array.isArray(items) && items.some((item) => Boolean(item && typeof item === 'object' && matcher(item as Record<string, unknown>)));
}


type BackupFileShape = {
  characters?: unknown[];
  chats?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  settings?: Partial<AppSettingsWithMemory> & {
    api?: AppSettingsWithMemory['api'];
    aiProfiles?: AppSettingsWithMemory['aiProfiles'];
  };
};

function findTreeNodeByKey(nodes: BackupTreeNode[], key: BackupSectionKey): BackupTreeNode | null {
  for (const node of nodes) {
    if (node.key === key) return node;
    if (node.children?.length) {
      const match = findTreeNodeByKey(node.children, key);
      if (match) return match;
    }
  }
  return null;
}

function getAvailableChildNodes(node: BackupTreeNode, availability?: BackupSelection) {
  return (node.children || []).filter((child) => isNodeAvailable(child, availability));
}

function isNodeAvailable(node: BackupTreeNode, availability?: BackupSelection): boolean {
  if (!availability) return true;
  if (!node.children?.length) return Boolean(availability[node.key]);
  return getAvailableChildNodes(node, availability).length > 0;
}

function normalizeSelection(selection: BackupSelection, availability?: BackupSelection): BackupSelection {
  const next = { ...EMPTY_BACKUP_SELECTION, ...selection };

  const walk = (node: BackupTreeNode): boolean => {
    if (!node.children?.length) {
      const checked = isNodeAvailable(node, availability) ? Boolean(next[node.key]) : false;
      next[node.key] = checked;
      return checked;
    }

    const availableChildren = getAvailableChildNodes(node, availability);
    if (availableChildren.length === 0) {
      next[node.key] = false;
      return false;
    }

    const checkedChildren = availableChildren.map(walk);
    next[node.key] = checkedChildren.every(Boolean);
    return checkedChildren.some(Boolean);
  };

  BACKUP_TREE.forEach(walk);
  return next;
}

function getNodeCheckState(
  node: BackupTreeNode,
  selection: BackupSelection,
  availability?: BackupSelection,
): { checked: boolean; indeterminate: boolean } {
  if (!node.children?.length) {
    return { checked: isNodeAvailable(node, availability) ? Boolean(selection[node.key]) : false, indeterminate: false };
  }

  const availableChildren = getAvailableChildNodes(node, availability);
  if (availableChildren.length === 0) {
    return { checked: false, indeterminate: false };
  }

  const childStates = availableChildren.map((child) => getNodeCheckState(child, selection, availability));
  const checkedCount = childStates.filter((state) => state.checked).length;
  const hasIndeterminate = childStates.some((state) => state.indeterminate);
  return {
    checked: checkedCount === availableChildren.length,
    indeterminate: hasIndeterminate || (checkedCount > 0 && checkedCount < availableChildren.length),
  };
}

function hasSelectionInNode(
  node: BackupTreeNode,
  selection: BackupSelection,
  availability?: BackupSelection,
): boolean {
  if (!isNodeAvailable(node, availability)) return false;
  if (!node.children?.length) return Boolean(selection[node.key]);
  return getAvailableChildNodes(node, availability).some((child) => hasSelectionInNode(child, selection, availability));
}

function hasNodeSelection(
  key: BackupSectionKey,
  selection: BackupSelection,
  availability?: BackupSelection,
): boolean {
  const node = findTreeNodeByKey(BACKUP_TREE, key);
  return node ? hasSelectionInNode(node, selection, availability) : false;
}

function setSubtreeSelection(
  selection: BackupSelection,
  key: BackupSectionKey,
  checked: boolean,
  availability?: BackupSelection,
): BackupSelection {
  const next = { ...selection };
  const node = findTreeNodeByKey(BACKUP_TREE, key);
  if (!node) return next;

  const apply = (target: BackupTreeNode) => {
    if (!isNodeAvailable(target, availability)) {
      next[target.key] = false;
      return;
    }
    if (!target.children?.length) {
      next[target.key] = checked;
      return;
    }
    getAvailableChildNodes(target, availability).forEach(apply);
  };

  apply(node);
  return normalizeSelection(next, availability);
}

function hasAnySelected(selection: BackupSelection, availability?: BackupSelection) {
  return BACKUP_ROOT_KEYS.some((key) => hasNodeSelection(key, selection, availability));
}

function getRestoreHasPayload(data: BackupFileShape) {
  return BACKUP_ROOT_KEYS.some((key) => (collectNodeStats(data)[key] || 0) > 0);
}

function toggleExpandedKey(current: BackupSectionKey[], key: BackupSectionKey) {
  return current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
}

function buildDefaultRestoreSelection(availability: BackupSelection): BackupSelection {
  return normalizeSelection(buildRestoreSelectionFromAvailability(availability), availability);
}

function buildRestoreFileNameSx() {
  return { display: 'block', mb: 1, wordBreak: 'break-all' as const };
}

function buildDialogContentSx() {
  return { display: 'grid', gap: 1.25, overflow: 'hidden' };
}

function buildDialogPaperSx() {
  return { '& .MuiDialog-paper': { maxHeight: 'min(88vh, 960px)' } };
}

function buildDialogActionsSx() {
  return { px: 3, pb: 2, pt: 1 };
}

function buildWarningAlertSx() {
  return { mt: 0.25 };
}

function buildTreeRowButtonSx(disabled: boolean) {
  return {
    ...buildTreeContentButtonSx(disabled),
    alignSelf: 'stretch',
    minHeight: 0,
  };
}

function buildTreeExpandPlaceholderSx() {
  return { width: 28, height: 28 };
}

function hasSelectedSecrets(selection: BackupSelection) {
  return selection['settings.api.credentials'] || selection['settings.aiProfiles.credentials'];
}

function getRestoreEmptyHint(data: BackupFileShape, language: string) {
  return getRestoreHasPayload(data)
    ? ''
    : language.startsWith('zh')
      ? '这个备份文件里没有可恢复的数据。'
      : 'This backup file does not contain restorable data.';
}

function buildInitialRestoreState(data: BackupFileShape, language: string) {
  const stats = collectNodeStats(data);
  const availability = buildRestoreAvailabilityFromData(data);
  const selection = buildDefaultRestoreSelection(availability);
  return {
    stats,
    availability,
    selection,
    emptyHint: getRestoreEmptyHint(data, language),
  };
}

function buildDialogScrollableContentSx() {
  return { overflow: 'hidden', pb: 1 };
}

function createDialogSelectionHandler(
  selection: BackupSelection,
  key: BackupSectionKey,
  checked: boolean,
  availability?: BackupSelection,
) {
  return setSubtreeSelection(selection, key, checked, availability);
}

function updateExpandedKeys(current: BackupSectionKey[], key: BackupSectionKey) {
  return toggleExpandedKey(current, key);
}

function getSelectionAfterToggle(
  selection: BackupSelection,
  key: BackupSectionKey,
  checked: boolean,
  availability?: BackupSelection,
) {
  return createDialogSelectionHandler(selection, key, checked, availability);
}

function buildBackupPayload(selection: BackupSelection, source: {
  characters: unknown[];
  chats: unknown[];
  messages: unknown[];
  settings: AppSettingsWithMemory;
}): BackupFileShape {
  const payload: BackupFileShape = {};
  if (selection.characters) payload.characters = source.characters;
  if (selection.chats) payload.chats = source.chats as Array<Record<string, unknown>>;
  if (selection.messages) payload.messages = source.messages as Array<Record<string, unknown>>;
  if (selection.settings) {
    const settingsPayload: NonNullable<BackupFileShape['settings']> = {};
    if (selection['settings.api']) {
      settingsPayload.api = selection['settings.api.credentials']
        ? source.settings.api
        : { ...source.settings.api, apiKey: '' };
    }
    if (selection['settings.aiProfiles']) {
      settingsPayload.aiProfiles = selection['settings.aiProfiles.credentials']
        ? source.settings.aiProfiles
        : source.settings.aiProfiles.map((profile) => ({ ...profile, apiKey: '' }));
    }
    if (selection['settings.appearance']) {
      settingsPayload.theme = source.settings.theme;
      settingsPayload.themePreset = source.settings.themePreset;
      settingsPayload.themeColor = source.settings.themeColor;
      settingsPayload.language = source.settings.language;
      settingsPayload.customBubbleStyles = source.settings.customBubbleStyles;
      settingsPayload.userBubbleStyleId = source.settings.userBubbleStyleId;
      settingsPayload.userBubbleStyle = source.settings.userBubbleStyle;
      settingsPayload.artifactAppearance = source.settings.artifactAppearance;
    }
    if (selection['settings.generation']) {
      settingsPayload.avatarGeneration = source.settings.avatarGeneration;
      settingsPayload.aiGeneration = source.settings.aiGeneration;
      settingsPayload.companionship = source.settings.companionship;
      settingsPayload.chatMemory = source.settings.chatMemory;
      settingsPayload.chatReplyPreferences = source.settings.chatReplyPreferences;
    }
    if (selection['settings.chatDraftDefaults']) {
      settingsPayload.defaultSpeed = source.settings.defaultSpeed;
      settingsPayload.chatDraftDefaults = source.settings.chatDraftDefaults;
    }
    if (selection['settings.developer']) {
      settingsPayload.developerMode = source.settings.developerMode;
      settingsPayload.developerUI = source.settings.developerUI;
      settingsPayload.memoryUI = source.settings.memoryUI;
    }
    if (selection['settings.usageStats']) {
      settingsPayload.usageStats = source.settings.usageStats;
    }
    if (Object.keys(settingsPayload).length) payload.settings = settingsPayload;
  }
  return payload;
}

type BackupSectionKey =
  | 'characters'
  | 'characters.core'
  | 'characters.relationships'
  | 'characters.memory'
  | 'characters.visual'
  | 'characters.runtime'
  | 'characters.modelBindings'
  | 'chats'
  | 'chats.core'
  | 'chats.runtime'
  | 'chats.relationships'
  | 'chats.world'
  | 'messages'
  | 'messages.content'
  | 'messages.metadata'
  | 'settings'
  | 'settings.api'
  | 'settings.api.credentials'
  | 'settings.aiProfiles'
  | 'settings.aiProfiles.credentials'
  | 'settings.appearance'
  | 'settings.generation'
  | 'settings.chatDraftDefaults'
  | 'settings.developer'
  | 'settings.usageStats';

const BACKUP_KEY_ORDER: BackupSectionKey[] = [
  'characters',
  'characters.core',
  'characters.relationships',
  'characters.memory',
  'characters.visual',
  'characters.runtime',
  'characters.modelBindings',
  'chats',
  'chats.core',
  'chats.runtime',
  'chats.relationships',
  'chats.world',
  'messages',
  'messages.content',
  'messages.metadata',
  'settings',
  'settings.api',
  'settings.api.credentials',
  'settings.aiProfiles',
  'settings.aiProfiles.credentials',
  'settings.appearance',
  'settings.generation',
  'settings.chatDraftDefaults',
  'settings.developer',
  'settings.usageStats',
];

const EMPTY_BACKUP_SELECTION: BackupSelection = BACKUP_KEY_ORDER.reduce((acc, key) => {
  acc[key] = false;
  return acc;
}, {} as BackupSelection);

const DEFAULT_BACKUP_SELECTION: BackupSelection = {
  ...EMPTY_BACKUP_SELECTION,
  characters: true,
  'characters.core': true,
  'characters.relationships': true,
  'characters.memory': true,
  'characters.visual': true,
  'characters.runtime': true,
  'characters.modelBindings': true,
  chats: true,
  'chats.core': true,
  'chats.runtime': true,
  'chats.relationships': true,
  'chats.world': true,
  messages: true,
  'messages.content': true,
  'messages.metadata': true,
  settings: true,
  'settings.api': true,
  'settings.api.credentials': false,
  'settings.aiProfiles': true,
  'settings.aiProfiles.credentials': false,
  'settings.appearance': true,
  'settings.generation': true,
  'settings.chatDraftDefaults': true,
  'settings.developer': true,
  'settings.usageStats': true,
};

const DISABLED_BACKUP_SELECTION = EMPTY_BACKUP_SELECTION;

function createSelection(overrides: Partial<BackupSelection> = {}): BackupSelection {
  return { ...EMPTY_BACKUP_SELECTION, ...overrides };
}

function createCharacterBackupEntry(character: Record<string, unknown>, selection: BackupSelection) {
  const next: Record<string, unknown> = {};
  if (selection['characters.core']) {
    Object.assign(next, {
      id: character.id,
      name: character.name,
      avatar: character.avatar,
      personality: character.personality,
      expertise: character.expertise,
      speakingStyle: character.speakingStyle,
      background: character.background,
      group: character.group,
      isPreset: character.isPreset,
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
      deletedAt: character.deletedAt,
      fieldVersions: character.fieldVersions,
    });
  }
  if (selection['characters.relationships']) next.relationships = character.relationships;
  if (selection['characters.memory']) {
    next.memory = character.memory;
    next.layeredMemories = character.layeredMemories;
  }
  if (selection['characters.visual']) {
    next.visualIdentity = character.visualIdentity;
    next.visualReferenceImages = character.visualReferenceImages;
    next.bubbleStyleId = character.bubbleStyleId;
    next.bubbleStyle = character.bubbleStyle;
    next.speechProfile = character.speechProfile;
    next.voiceConfig = character.voiceConfig;
  }
  if (selection['characters.runtime']) {
    next.personalityDrift = character.personalityDrift;
    next.emotionalState = character.emotionalState;
    next.soulState = character.soulState;
    next.coreProfile = character.coreProfile;
    next.behavior = character.behavior;
    next.runtimeTimeline = character.runtimeTimeline;
    next.intervention = character.intervention;
    next.generationPreferences = character.generationPreferences;
    next.characterDetailLoaded = character.characterDetailLoaded;
  }
  if (selection['characters.modelBindings']) {
    next.modelProfileId = character.modelProfileId;
    next.modelProfileIds = character.modelProfileIds;
  }
  return next;
}

function createChatBackupEntry(chat: Record<string, unknown>, selection: BackupSelection) {
  const next: Record<string, unknown> = {};
  if (selection['chats.core']) {
    Object.assign(next, {
      id: chat.id,
      type: chat.type,
      mode: chat.mode,
      name: chat.name,
      topic: chat.topic,
      style: chat.style,
      runtimeEvolutionIntensity: chat.runtimeEvolutionIntensity,
      memberIds: chat.memberIds,
      speed: chat.speed,
      isActive: chat.isActive,
      allowIntervention: chat.allowIntervention,
      showRoleActions: chat.showRoleActions,
      topicSeed: chat.topicSeed,
      sourceChatId: chat.sourceChatId,
      sourceMemberIds: chat.sourceMemberIds,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      lastMessageAt: chat.lastMessageAt,
      deletedAt: chat.deletedAt,
      fieldVersions: chat.fieldVersions,
    });
  }
  if (selection['chats.runtime']) {
    next.modeConfig = chat.modeConfig;
    next.modeState = chat.modeState;
    next.runtimeSeed = chat.runtimeSeed;
    next.layeredMemories = chat.layeredMemories;
    next.runtimeTimeline = chat.runtimeTimeline;
    next.runtimeEventsV2 = chat.runtimeEventsV2;
    next.directorControls = chat.directorControls;
  }
  if (selection['chats.relationships']) {
    next.relationshipLedger = chat.relationshipLedger;
    next.governance = chat.governance;
    next.dramaRules = chat.dramaRules;
  }
  if (selection['chats.world']) next.worldState = chat.worldState;
  return next;
}

function createMessageBackupEntry(message: Record<string, unknown>, selection: BackupSelection) {
  const next: Record<string, unknown> = { chatId: message.chatId };
  if (selection['messages.content']) {
    Object.assign(next, {
      type: message.type,
      senderId: message.senderId,
      senderName: message.senderName,
      content: message.content,
      emotion: message.emotion,
      timestamp: message.timestamp,
      isDeleted: message.isDeleted,
    });
  }
  if (selection['messages.metadata']) next.metadata = message.metadata;
  return next;
}

function buildFullAvailabilitySelection(): BackupSelection {
  return BACKUP_KEY_ORDER.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, { ...EMPTY_BACKUP_SELECTION } as BackupSelection);
}

function buildLiveBackupStats(source: {
  characters: unknown[];
  chats: unknown[];
  messages: unknown[];
  settings: AppSettingsWithMemory;
}): BackupNodeStats {
  return collectNodeStats({
    characters: source.characters,
    chats: source.chats as Array<Record<string, unknown>>,
    messages: source.messages as Array<Record<string, unknown>>,
    settings: source.settings,
  });
}

function hasAnyOwnValue(record: Record<string, unknown>) {
  return Object.values(record).some((value) => value !== undefined);
}

function deriveAvailabilityFromTree(tree: BackupTreeNode[], selection: BackupSelection): BackupSelection {
  const next = { ...selection };
  const walk = (node: BackupTreeNode): boolean => {
    const self = Boolean(next[node.key]);
    const childAvailable = node.children?.map(walk) || [];
    const available = self || childAvailable.some(Boolean);
    if (node.children?.length) {
      next[node.key] = available;
    }
    return available;
  };
  tree.forEach(walk);
  return next;
}

function buildRestoreAvailabilityFromData(data: BackupFileShape): BackupSelection {
  const stats = collectNodeStats(data);
  const hasCount = (key: BackupSectionKey) => (stats[key] || 0) > 0;
  const settingsAvailability = createSelection({
    settings: hasCount('settings') || hasSettingsData(data.settings),
    'settings.api': hasCount('settings.api') || Boolean(data.settings?.api),
    'settings.api.credentials': hasCount('settings.api.credentials') || Boolean(data.settings?.api?.apiKey),
    'settings.aiProfiles': hasCount('settings.aiProfiles') || (Array.isArray(data.settings?.aiProfiles) && data.settings.aiProfiles.length > 0),
    'settings.aiProfiles.credentials': hasCount('settings.aiProfiles.credentials') || Boolean(data.settings?.aiProfiles?.some((profile) => profile.apiKey)),
    'settings.appearance': hasCount('settings.appearance') || Boolean(data.settings && ('theme' in data.settings || 'themePreset' in data.settings || 'themeColor' in data.settings || 'language' in data.settings || 'customBubbleStyles' in data.settings || 'userBubbleStyleId' in data.settings || 'userBubbleStyle' in data.settings || 'artifactAppearance' in data.settings)),
    'settings.generation': hasCount('settings.generation') || Boolean(data.settings && ('avatarGeneration' in data.settings || 'aiGeneration' in data.settings || 'companionship' in data.settings || 'chatMemory' in data.settings || 'chatReplyPreferences' in data.settings)),
    'settings.chatDraftDefaults': hasCount('settings.chatDraftDefaults') || Boolean(data.settings && ('defaultSpeed' in data.settings || 'chatDraftDefaults' in data.settings)),
    'settings.developer': hasCount('settings.developer') || Boolean(data.settings && ('developerMode' in data.settings || 'developerUI' in data.settings || 'memoryUI' in data.settings)),
    'settings.usageStats': hasCount('settings.usageStats') || Boolean(data.settings && 'usageStats' in data.settings),
  });
  const characters = hasCount('characters') || hasStructuredEntries(data.characters);
  const chats = hasCount('chats') || hasStructuredEntries(data.chats);
  const messages = hasCount('messages') || hasStructuredEntries(data.messages);
  const availability = createSelection();
  availability.characters = characters;
  availability['characters.core'] = hasCount('characters.core') || hasLeafData(data.characters, hasExportedCharacterCore);
  availability['characters.relationships'] = hasCount('characters.relationships') || hasLeafData(data.characters, (item) => 'relationships' in item);
  availability['characters.memory'] = hasCount('characters.memory') || hasLeafData(data.characters, (item) => 'memory' in item || 'layeredMemories' in item);
  availability['characters.visual'] = hasCount('characters.visual') || hasLeafData(data.characters, (item) => 'visualIdentity' in item || 'visualReferenceImages' in item || 'bubbleStyle' in item || 'bubbleStyleId' in item || 'speechProfile' in item || 'voiceConfig' in item);
  availability['characters.runtime'] = hasCount('characters.runtime') || hasLeafData(data.characters, (item) => 'runtimeTimeline' in item || 'emotionalState' in item || 'behavior' in item || 'personalityDrift' in item || 'coreProfile' in item || 'intervention' in item || 'generationPreferences' in item || 'characterDetailLoaded' in item || 'soulState' in item);
  availability['characters.modelBindings'] = hasCount('characters.modelBindings') || hasLeafData(data.characters, (item) => 'modelProfileId' in item || 'modelProfileIds' in item);
  availability.chats = chats;
  availability['chats.core'] = hasCount('chats.core') || hasLeafData(data.chats, hasExportedChatCore);
  availability['chats.runtime'] = hasCount('chats.runtime') || hasLeafData(data.chats, (item) => 'runtimeSeed' in item || 'runtimeTimeline' in item || 'runtimeEventsV2' in item || 'modeConfig' in item || 'modeState' in item || 'directorControls' in item || 'layeredMemories' in item);
  availability['chats.relationships'] = hasCount('chats.relationships') || hasLeafData(data.chats, (item) => 'relationshipLedger' in item || 'governance' in item || 'dramaRules' in item);
  availability['chats.world'] = hasCount('chats.world') || hasLeafData(data.chats, (item) => 'worldState' in item);
  availability.messages = messages;
  availability['messages.content'] = hasCount('messages.content') || hasLeafData(data.messages, hasExportedMessageContent);
  availability['messages.metadata'] = hasCount('messages.metadata') || hasLeafData(data.messages, (item) => 'metadata' in item);
  Object.assign(availability, settingsAvailability);
  return deriveAvailabilityFromTree(BACKUP_TREE, availability);
}

function buildRestoreSelectionFromAvailability(availability: BackupSelection): BackupSelection {
  return BACKUP_KEY_ORDER.reduce((acc, key) => {
    acc[key] = Boolean(availability[key]);
    return acc;
  }, { ...EMPTY_BACKUP_SELECTION } as BackupSelection);
}

function buildDialogTreeBodySx() {
  return {
    mt: 1.25,
    maxHeight: 'min(62vh, 720px)',
    overflowY: 'auto' as const,
    pr: 0.5,
    borderRadius: 2,
    border: '1px solid',
    borderColor: 'divider',
    bgcolor: 'background.default',
    p: 1,
  };
}

function buildTreeExpandButtonSx() {
  return { minWidth: 28, width: 28, height: 28, p: 0, borderRadius: 1, color: 'text.secondary' };
}

function buildTreeCheckboxSx() {
  return { p: 0.25, alignSelf: 'start', mt: 0.1 };
}

function buildTreeContentButtonSx(disabled: boolean) {
  return {
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    textAlign: 'left' as const,
    textTransform: 'none',
    minWidth: 0,
    width: '100%',
    p: 0,
    color: disabled ? 'text.disabled' : 'text.primary',
    '&:hover': {
      bgcolor: 'transparent',
    },
  };
}

function buildTreeTitleRowSx() {
  return { display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 };
}

function buildTreeCountSx(disabled: boolean) {
  return { color: disabled ? 'text.disabled' : 'text.secondary', flexShrink: 0 };
}

function buildTreeNodeRowSx(level: number, disabled: boolean) {
  return {
    position: 'relative' as const,
    display: 'grid',
    gridTemplateColumns: '28px 28px minmax(0, 1fr)',
    alignItems: 'start',
    columnGap: 0.5,
    py: 0.6,
    pl: level * 1.25,
    borderRadius: 1.5,
    opacity: disabled ? 0.45 : 1,
    '&:hover': {
      bgcolor: disabled ? 'transparent' : 'action.hover',
    },
  };
}

function buildTreeLabelSx(disabled: boolean) {
  return { fontWeight: 700, lineHeight: 1.35, color: disabled ? 'text.disabled' : 'text.primary' };
}

function buildTreeDescriptionSx(_level: number, disabled: boolean) {
  return { mt: 0.2, lineHeight: 1.45, color: disabled ? 'text.disabled' : 'text.secondary' };
}

function buildTreeBranchSx(level: number) {
  return {
    ml: `calc(${level * 1.25}rem + 1.25rem)`,
    pl: 1.25,
    borderLeft: '1px dashed',
    borderColor: 'divider',
  };
}

function filterSettingsForRestore(data: NonNullable<BackupFileShape['settings']>, selection: BackupSelection): Partial<AppSettingsWithMemory> {
  const nextSettings: Partial<AppSettingsWithMemory> = {};
  if (selection['settings.api'] && data.api) {
    nextSettings.api = selection['settings.api.credentials'] ? data.api : { ...data.api, apiKey: '' };
  }
  if (selection['settings.aiProfiles'] && Array.isArray(data.aiProfiles)) {
    nextSettings.aiProfiles = selection['settings.aiProfiles.credentials'] ? data.aiProfiles : data.aiProfiles.map((profile) => ({ ...profile, apiKey: '' }));
  }
  if (selection['settings.appearance']) {
    if (data.theme !== undefined) nextSettings.theme = data.theme;
    if (data.themePreset !== undefined) nextSettings.themePreset = data.themePreset;
    if (data.themeColor !== undefined) nextSettings.themeColor = data.themeColor;
    if (data.language !== undefined) nextSettings.language = data.language;
    if (data.customBubbleStyles !== undefined) nextSettings.customBubbleStyles = data.customBubbleStyles;
    if (data.userBubbleStyleId !== undefined) nextSettings.userBubbleStyleId = data.userBubbleStyleId;
    if (data.userBubbleStyle !== undefined) nextSettings.userBubbleStyle = data.userBubbleStyle;
    if (data.artifactAppearance !== undefined) nextSettings.artifactAppearance = data.artifactAppearance;
  }
  if (selection['settings.generation']) {
    if (data.avatarGeneration !== undefined) nextSettings.avatarGeneration = data.avatarGeneration;
    if (data.aiGeneration !== undefined) nextSettings.aiGeneration = data.aiGeneration;
    if (data.companionship !== undefined) nextSettings.companionship = data.companionship;
    if (data.chatMemory !== undefined) nextSettings.chatMemory = data.chatMemory;
    if (data.chatReplyPreferences !== undefined) nextSettings.chatReplyPreferences = normalizeChatReplyPreferences(data.chatReplyPreferences);
  }
  if (selection['settings.chatDraftDefaults']) {
    if (data.defaultSpeed !== undefined) nextSettings.defaultSpeed = data.defaultSpeed;
    if (data.chatDraftDefaults !== undefined) nextSettings.chatDraftDefaults = data.chatDraftDefaults;
  }
  if (selection['settings.developer']) {
    if (data.developerMode !== undefined) nextSettings.developerMode = data.developerMode;
    if (data.developerUI !== undefined) nextSettings.developerUI = data.developerUI;
    if (data.memoryUI !== undefined) nextSettings.memoryUI = data.memoryUI;
  }
  if (selection['settings.usageStats'] && data.usageStats !== undefined) nextSettings.usageStats = data.usageStats;
  return nextSettings;
}

const BACKUP_TREE: BackupTreeNode[] = [
  {
    key: 'characters',
    labelZh: '角色',
    labelEn: 'Characters',
    descriptionZh: '角色相关数据',
    descriptionEn: 'Character-related data',
    children: [
      { key: 'characters.core', labelZh: '基础资料', labelEn: 'Core profile', descriptionZh: '名称、头像、人格、专长、背景、创建时间等', descriptionEn: 'Name, avatar, personality, expertise, background, timestamps' },
      { key: 'characters.relationships', labelZh: '关系数据', labelEn: 'Relationships', descriptionZh: '角色关系账本与关系条目', descriptionEn: 'Relationship ledgers and entries' },
      { key: 'characters.memory', labelZh: '记忆数据', labelEn: 'Memories', descriptionZh: '长期记忆、分层记忆、记忆摘要等', descriptionEn: 'Long-term memories, layered memories, summaries' },
      { key: 'characters.visual', labelZh: '视觉与表达', labelEn: 'Visual & expression', descriptionZh: '视觉设定、参考图、气泡、语音与说话档案', descriptionEn: 'Visual identity, references, bubbles, voice, speech profile' },
      { key: 'characters.runtime', labelZh: '运行态与偏好', labelEn: 'Runtime & preferences', descriptionZh: '情绪、行为、运行时间线、干预与生成偏好', descriptionEn: 'Emotion, behavior, runtime timeline, interventions, generation prefs' },
      { key: 'characters.modelBindings', labelZh: '模型绑定', labelEn: 'Model bindings', descriptionZh: '角色绑定的模型档案', descriptionEn: 'Model profile bindings for characters' },
    ],
  },
  {
    key: 'chats',
    labelZh: '聊天',
    labelEn: 'Chats',
    descriptionZh: '聊天与会话数据',
    descriptionEn: 'Chat and session data',
    children: [
      { key: 'chats.core', labelZh: '基础信息', labelEn: 'Core info', descriptionZh: '名称、类型、成员、主题、速度、删除状态等', descriptionEn: 'Name, type, members, topic, speed, deletion state' },
      { key: 'chats.runtime', labelZh: '运行态', labelEn: 'Runtime state', descriptionZh: '模式配置、运行种子、时间线、事件、导演控制等', descriptionEn: 'Mode config, runtime seeds, timeline, events, director controls' },
      { key: 'chats.relationships', labelZh: '治理与关系', labelEn: 'Governance & relationships', descriptionZh: '关系账本、治理规则、戏剧规则等', descriptionEn: 'Relationship ledgers, governance, drama rules' },
      { key: 'chats.world', labelZh: '世界状态', labelEn: 'World state', descriptionZh: '世界状态与公共运行态摘要', descriptionEn: 'World state and public runtime summaries' },
    ],
  },
  {
    key: 'messages',
    labelZh: '消息',
    labelEn: 'Messages',
    descriptionZh: '消息历史',
    descriptionEn: 'Message history',
    children: [
      { key: 'messages.content', labelZh: '消息正文', labelEn: 'Content', descriptionZh: '消息内容、发送者、时间、情绪', descriptionEn: 'Content, sender, timestamp, emotion' },
      { key: 'messages.metadata', labelZh: '消息元数据', labelEn: 'Metadata', descriptionZh: '富媒体、结构化元数据等', descriptionEn: 'Rich media and structured metadata' },
    ],
  },
  {
    key: 'settings',
    labelZh: '设置',
    labelEn: 'Settings',
    descriptionZh: '应用与模型设置',
    descriptionEn: 'App and model settings',
    children: [
      {
        key: 'settings.api', labelZh: '默认模型配置', labelEn: 'Default model config', descriptionZh: '默认提供商、模型、接口地址', descriptionEn: 'Default provider, model, and endpoint', children: [
          { key: 'settings.api.credentials', labelZh: '默认模型密钥', labelEn: 'Default model key', descriptionZh: '默认模型 API 密钥明文', descriptionEn: 'Plaintext API key for the default model' },
        ],
      },
      {
        key: 'settings.aiProfiles', labelZh: '模型档案', labelEn: 'Model profiles', descriptionZh: '文本/图片/语音/文档模型档案', descriptionEn: 'Text/image/audio/document model profiles', children: [
          { key: 'settings.aiProfiles.credentials', labelZh: '档案密钥', labelEn: 'Profile keys', descriptionZh: '各模型档案的 API 密钥明文', descriptionEn: 'Plaintext API keys for model profiles' },
        ],
      },
      { key: 'settings.appearance', labelZh: '外观与界面', labelEn: 'Appearance & UI', descriptionZh: '主题、颜色、语言、用户气泡、信纸样式、自定义气泡', descriptionEn: 'Theme, color, language, user bubble, letter background, custom bubbles' },
      { key: 'settings.generation', labelZh: '生成、聊天偏好、陪伴与记忆', labelEn: 'Generation, chat preferences, companionship & memory', descriptionZh: '头像生成、聊天偏好、朋友圈、日记、主动陪伴、聊天记忆等', descriptionEn: 'Avatar generation, chat preferences, moments, diaries, proactive companionship, chat memory' },
      { key: 'settings.chatDraftDefaults', labelZh: '聊天默认行为', labelEn: 'Chat defaults', descriptionZh: '默认聊天草稿与群聊变化强度', descriptionEn: 'Default chat draft behavior and evolution intensity' },
      { key: 'settings.developer', labelZh: '开发者与调试', labelEn: 'Developer & debug', descriptionZh: '开发者模式、调试面板、记忆调试开关', descriptionEn: 'Developer mode, debug panels, memory debug toggles' },
      { key: 'settings.usageStats', labelZh: '使用统计', labelEn: 'Usage stats', descriptionZh: '本地使用统计与计数', descriptionEn: 'Local usage stats and counters' },
    ],
  },
];

const BACKUP_ROOT_KEYS: BackupSectionKey[] = ['characters', 'chats', 'messages', 'settings'];

const DEFAULT_EXPANDED_KEYS: BackupSectionKey[] = ['characters', 'chats', 'messages', 'settings', 'settings.api', 'settings.aiProfiles'];
const RAW_FULL_BACKUP_AVAILABILITY = buildFullAvailabilitySelection();
const FULL_BACKUP_AVAILABILITY = deriveAvailabilityFromTree(BACKUP_TREE, RAW_FULL_BACKUP_AVAILABILITY);

function getPaperVariantLabel(variant: PaperSurfaceVariant, language: string) {
  const zh: Record<PaperSurfaceVariant, string> = {
    lined: '横线纸',
    plain: '素纸',
    letter: '信纸',
    night: '夜色',
  };
  const en: Record<PaperSurfaceVariant, string> = {
    lined: 'Lined',
    plain: 'Plain',
    letter: 'Letter',
    night: 'Night',
  };
  return language.startsWith('zh') ? zh[variant] : en[variant];
}

function buildPaperPreviewSx(variant: PaperSurfaceVariant) {
  const shared = {
    width: '100%',
    aspectRatio: '0.72 / 1',
    minHeight: 82,
    maxHeight: 118,
    borderRadius: 1,
    overflow: 'hidden',
    position: 'relative',
    border: '1px solid',
  };
  const variants: Record<PaperSurfaceVariant, object> = {
    lined: {
      ...shared,
      borderColor: 'rgba(180, 150, 90, 0.34)',
      bgcolor: '#fffdf4',
      backgroundImage: 'linear-gradient(rgba(90, 120, 170, 0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(180, 80, 70, 0.24) 1px, transparent 1px)',
      backgroundSize: '100% 12px, 20px 100%',
      backgroundPosition: '0 12px, 18px 0',
    },
    plain: {
      ...shared,
      borderColor: 'rgba(190, 176, 138, 0.42)',
      bgcolor: '#fffaf0',
      backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.75), rgba(245,232,198,0.42))',
    },
    letter: {
      ...shared,
      borderColor: 'rgba(128, 96, 54, 0.34)',
      bgcolor: '#fbf3df',
      backgroundImage: 'linear-gradient(rgba(94, 70, 38, 0.08) 1px, transparent 1px), radial-gradient(circle at 18% 14%, rgba(255,255,255,0.62), transparent 36%), linear-gradient(135deg, rgba(130, 88, 36, 0.14), transparent 46%)',
      backgroundSize: '100% 13px, 100% 100%, 100% 100%',
      backgroundPosition: '0 14px, 0 0, 0 0',
    },
    night: {
      ...shared,
      borderColor: 'rgba(139, 164, 203, 0.42)',
      bgcolor: '#202632',
      backgroundImage: 'linear-gradient(rgba(174, 196, 230, 0.15) 1px, transparent 1px), linear-gradient(135deg, rgba(71, 88, 121, 0.52), rgba(32, 38, 50, 0.95))',
      backgroundSize: '100% 12px, 100% 100%',
      backgroundPosition: '0 12px, 0 0',
    },
  };
  return variants[variant];
}

function BackupTreeSection({
  nodes,
  selection,
  availability,
  stats,
  expandedKeys,
  onToggleExpand,
  onToggleCheck,
  language,
  level = 0,
}: {
  nodes: BackupTreeNode[];
  selection: BackupSelection;
  availability: BackupSelection;
  stats?: BackupNodeStats;
  expandedKeys: BackupSectionKey[];
  onToggleExpand: (key: BackupSectionKey) => void;
  onToggleCheck: (key: BackupSectionKey, checked: boolean) => void;
  language: string;
  level?: number;
}) {
  return (
    <Box sx={{ display: 'grid', gap: 0.15 }}>
      {nodes.map((node) => {
        const state = getNodeCheckState(node, selection, availability);
        const expanded = expandedKeys.includes(node.key);
        const disabled = !isNodeAvailable(node, availability);
        const toggleChecked = !state.checked || state.indeterminate;
        const showExpandButton = Boolean(node.children?.length);
        return (
          <Box key={node.key}>
            <Box
              sx={buildTreeNodeRowSx(level, disabled)}
              onClick={() => {
                if (!disabled) onToggleCheck(node.key, toggleChecked);
              }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'center', pt: 0.15 }}>
                {showExpandButton ? (
                  <Button
                    size="small"
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleExpand(node.key);
                    }}
                    sx={buildTreeExpandButtonSx()}
                  >
                    {expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                  </Button>
                ) : <Box sx={buildTreeExpandPlaceholderSx()} />}
              </Box>
              <Checkbox
                checked={state.checked}
                indeterminate={state.indeterminate}
                disabled={disabled}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onToggleCheck(node.key, event.target.checked)}
                sx={buildTreeCheckboxSx()}
              />
              <Button
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleCheck(node.key, toggleChecked);
                }}
                sx={buildTreeRowButtonSx(disabled)}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Box sx={buildTreeTitleRowSx()}>
                    <Typography variant="body2" sx={buildTreeLabelSx(disabled)}>
                      {formatNodeLabel(node, language)}
                    </Typography>
                    {shouldShowNodeCount(node, level, stats) ? (
                      <Typography variant="caption" sx={buildTreeCountSx(disabled)}>
                        ({shouldShowNodeCount(node, level, stats)})
                      </Typography>
                    ) : null}
                  </Box>
                  <Typography variant="caption" sx={buildTreeDescriptionSx(level, disabled)}>
                    {language.startsWith('zh') ? node.descriptionZh : node.descriptionEn}
                  </Typography>
                </Box>
              </Button>
            </Box>
            {node.children?.length ? (
              <Collapse in={expanded} timeout="auto" unmountOnExit>
                <Box sx={buildTreeBranchSx(level)}>
                  <BackupTreeSection
                    nodes={node.children}
                    selection={selection}
                    availability={availability}
                    stats={stats}
                    expandedKeys={expandedKeys}
                    onToggleExpand={onToggleExpand}
                    onToggleCheck={onToggleCheck}
                    language={language}
                    level={level + 1}
                  />
                </Box>
              </Collapse>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const settings = useSettingsStore();
  const compactBubbleMode = settings.compactBubbleMode;
  const compactPrivateBubbleMode = settings.compactPrivateBubbleMode;
  const localWorkspaceDirectories = useLocalWorkspaceStore((state) => state.directories);
  const persistedStorageTarget = useLocalWorkspaceStore((state) => state.defaultStorageTarget);
  const defaultStorageTarget = persistedStorageTarget || { kind: 'session' as const };
  const defaultLocalWorkspaceDirectoryId = defaultStorageTarget.kind === 'workspace' ? defaultStorageTarget.workspaceId : null;
  const addLocalWorkspaceDirectory = useLocalWorkspaceStore((state) => state.addDirectory);
  const removeLocalWorkspaceDirectory = useLocalWorkspaceStore((state) => state.removeDirectory);
  const setDefaultLocalWorkspaceDirectory = useLocalWorkspaceStore((state) => state.setDefaultDirectory);
  const setDefaultStorageTarget = useLocalWorkspaceStore((state) => state.setDefaultStorageTarget);
  const user = useAuthStore((s) => s.user);
  const authMode = useAuthStore((s) => s.authMode);
  const developerModeDenied = authMode === 'cloud' && user?.developerModeEntitled === false;
  const developerModeAvailable = !developerModeDenied && (settings.developerMode || settings.developerModeEntitled || user?.developerModeEntitled === true);
  const refreshDeveloperEntitlement = settings.refreshDeveloperEntitlement;
  const [userBubblePickerOpen, setUserBubblePickerOpen] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearMessagesConfirm, setClearMessagesConfirm] = useState(false);
  const [clearAllBusy, setClearAllBusy] = useState(false);
  const [clearMessagesBusy, setClearMessagesBusy] = useState(false);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [backupSelection, setBackupSelection] = useState<BackupSelection>(DEFAULT_BACKUP_SELECTION);
  const [restoreSelection, setRestoreSelection] = useState<BackupSelection>(DEFAULT_BACKUP_SELECTION);
  const [restoreAvailability, setRestoreAvailability] = useState<BackupSelection>(DISABLED_BACKUP_SELECTION);
  const [restoreStats, setRestoreStats] = useState<BackupNodeStats>({});
  const [restoreData, setRestoreData] = useState<BackupFileShape | null>(null);
  const [restoreFileName, setRestoreFileName] = useState('');
  const [restoreEmptyHint, setRestoreEmptyHint] = useState('');
  const [expandedBackupKeys, setExpandedBackupKeys] = useState<BackupSectionKey[]>(DEFAULT_EXPANDED_KEYS);
  const [expandedRestoreKeys, setExpandedRestoreKeys] = useState<BackupSectionKey[]>(DEFAULT_EXPANDED_KEYS);
  const [showAllThemePresets, setShowAllThemePresets] = useState(false);
  const [showAllVoiceStyles, setShowAllVoiceStyles] = useState(false);
  const [localWorkspaceBusy, setLocalWorkspaceBusy] = useState(false);
  const [localWorkspaceExpanded, setLocalWorkspaceExpanded] = useState(() => localWorkspaceDirectories.length > 0);
  const [developerEntitlementRefreshRequested, setDeveloperEntitlementRefreshRequested] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTabKey>(() => resolveSettingsTab(new URLSearchParams(window.location.search).get('tab')));
  const [tabTransitionDirection, setTabTransitionDirection] = useState<-1 | 1>(1);
  const userBubbleStyle = useMemo(
    () => resolveCharacterBubbleStyle({
      bubbleStyle: settings.userBubbleStyle,
      bubbleStyleId: settings.userBubbleStyleId || DEFAULT_AI_BUBBLE_STYLE_ID,
      customStyles: settings.customBubbleStyles || [],
    }),
    [settings.customBubbleStyles, settings.userBubbleStyle, settings.userBubbleStyleId]
  );
  const userBubblePreview = useMemo(() => buildBubblePreview(userBubbleStyle, true), [userBubbleStyle]);
  const normalizedSelfAvatar = user?.avatar?.trim() === '🍵' ? '' : user?.avatar?.trim() || '';
  const selfAvatarValue = normalizedSelfAvatar || (user?.nickname?.trim() || '我').slice(0, 1);
  const selfAvatarIsImage = isImageAvatar(selfAvatarValue);
  const selfBubblePreviewText = i18n.language.startsWith('zh') ? '这是我发送消息时的气泡' : 'This is my chat bubble';
  const selectedThemePreset = resolveThemePreset(settings.themePreset, settings.themeColor);
  const popularThemePresets = APP_THEME_PRESETS.slice(0, POPULAR_THEME_PRESET_COUNT);
  const selectedThemeIsPopular = popularThemePresets.some((preset) => preset.id === selectedThemePreset.id);
  const visibleThemePresets = showAllThemePresets
    ? APP_THEME_PRESETS
    : (selectedThemeIsPopular ? popularThemePresets : [...popularThemePresets, selectedThemePreset]);
  const hiddenThemePresetCount = Math.max(0, APP_THEME_PRESETS.length - POPULAR_THEME_PRESET_COUNT);
  const popularVoiceStyles = VOICE_STYLE_OPTIONS.slice(0, POPULAR_VOICE_STYLE_COUNT);
  const selectedVoiceStyle = VOICE_STYLE_OPTIONS.find((option) => option.value === settings.chatAppearance.voiceWaveformStyle);
  const selectedVoiceStyleIsPopular = popularVoiceStyles.some((option) => option.value === selectedVoiceStyle?.value);
  const visibleVoiceStyles = showAllVoiceStyles
    ? VOICE_STYLE_OPTIONS
    : (selectedVoiceStyle && !selectedVoiceStyleIsPopular ? [...popularVoiceStyles, selectedVoiceStyle] : popularVoiceStyles);
  const hiddenVoiceStyleCount = Math.max(0, VOICE_STYLE_OPTIONS.length - POPULAR_VOICE_STYLE_COUNT);
  const backupStats = useMemo(() => buildLiveBackupStats({
    characters: useCharacterStore.getState().characters,
    chats: useChatStore.getState().chats,
    messages: Object.values(useMessageStore.getState().messageWindowsByChatId).flatMap((window) => window.messages),
    settings,
  }), [settings]);
  const localWorkspaceSupport = getWebDirectoryPickerSupport();
  const localWorkspaceSupported = localWorkspaceSupport.supported;
  const selectedLocalWorkspaceDirectoryId = defaultLocalWorkspaceDirectoryId;

  const handleToggleDefaultLocalWorkspaceDirectory = (id: string) => {
    setDefaultLocalWorkspaceDirectory(selectedLocalWorkspaceDirectoryId === id ? null : id);
  };

  const updateSettingsLocation = (tab: SettingsTabKey, card?: string | null) => {
    navigate(buildSettingsPath({ tab, card: card || undefined }), { replace: true });
  };

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const card = params.get('card') || location.hash.replace(/^#/, '');
    const nextTab = getSettingsTabForCard(card) ?? resolveSettingsTab(params.get('tab'));
    if (card && params.get('tab') !== nextTab) {
      navigate(buildSettingsPath({ tab: nextTab, card }), { replace: true });
      return;
    }
    setActiveSettingsTab(nextTab);
  }, [location.hash, location.search, navigate]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const card = params.get('card') || location.hash.replace(/^#/, '');
    if (!card) return;
    const timeout = window.setTimeout(() => {
      document.getElementById(`settings-card-${card}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [activeSettingsTab, location.hash, location.search]);

  useEffect(() => {
    if (!localWorkspaceDirectories.length) return;
    void useLocalWorkspaceStore.getState().refreshDirectoryStatuses().catch(() => undefined);
  }, [localWorkspaceDirectories.length]);

  useEffect(() => {
    setLocalWorkspaceExpanded(localWorkspaceDirectories.length > 0);
  }, [localWorkspaceDirectories.length]);

  useEffect(() => {
    setDeveloperEntitlementRefreshRequested(false);
  }, [user?.id]);

  useEffect(() => {
    if (authMode !== 'cloud' || developerEntitlementRefreshRequested) return;
    setDeveloperEntitlementRefreshRequested(true);
    void refreshDeveloperEntitlement();
  }, [authMode, developerEntitlementRefreshRequested, refreshDeveloperEntitlement]);

  const handleAddLocalWorkspaceDirectory = async () => {
    setLocalWorkspaceBusy(true);
    try {
      const directory = await addLocalWorkspaceDirectory();
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? `已授权文件夹：${directory.name}` : `Folder authorized: ${directory.name}`,
        severity: 'success',
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : t('common.error'),
        severity: 'error',
      });
    } finally {
      setLocalWorkspaceBusy(false);
    }
  };

  const handleRemoveLocalWorkspaceDirectory = async (id: string) => {
    setLocalWorkspaceBusy(true);
    try {
      await removeLocalWorkspaceDirectory(id);
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '已移除本地文件夹授权' : 'Local folder authorization removed',
        severity: 'success',
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : t('common.error'),
        severity: 'error',
      });
    } finally {
      setLocalWorkspaceBusy(false);
    }
  };

  const handleBackup = () => {
    setBackupSelection(DEFAULT_BACKUP_SELECTION);
    setExpandedBackupKeys(DEFAULT_EXPANDED_KEYS);
    setBackupDialogOpen(true);
  };

  const handleConfirmBackup = async () => {
    try {
      const characterStore = useCharacterStore.getState();
      const chatStore = useChatStore.getState();
      const messageStore = useMessageStore.getState();

      await Promise.all([
        characterStore.loadCharacters(),
        chatStore.loadChats({ waitForCloud: true }),
      ]);

      const refreshedChatStore = useChatStore.getState();
      const messageWindows = useMessageStore.getState().messageWindowsByChatId;
      const allMessages = Object.values(messageWindows).flatMap((window) => window.messages);

      if (allMessages.length === 0) {
        await Promise.all(
          refreshedChatStore.chats.map((chat) => messageStore.loadMessages(chat.id).catch(() => undefined))
        );
      }

      const finalCharacterStore = useCharacterStore.getState();
      const finalChatStore = useChatStore.getState();
      const finalMessages = Object.values(useMessageStore.getState().messageWindowsByChatId)
        .flatMap((window) => window.messages);

      const data = buildBackupPayload(backupSelection, {
        characters: finalCharacterStore.characters.map((character) => createCharacterBackupEntry(character as unknown as Record<string, unknown>, backupSelection)).filter((item) => hasAnyOwnValue(item)),
        chats: finalChatStore.chats.map((chat) => createChatBackupEntry(chat as unknown as Record<string, unknown>, backupSelection)).filter((item) => hasAnyOwnValue(item)),
        messages: finalMessages.map((message) => createMessageBackupEntry(message as unknown as Record<string, unknown>, backupSelection)).filter((item) => hasAnyOwnValue(item)),
        settings,
      });

      const stats = collectNodeStats(data);
      const hasPayload = Boolean((stats.characters || 0) + (stats.chats || 0) + (stats.messages || 0) + (stats.settings || 0));
      if (!hasPayload) {
        setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '当前没有可导出的数据，请先等待数据加载完成。' : 'No exportable data is currently loaded. Please wait for data to finish loading.' , severity: 'error' });
        return;
      }

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pneumata-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupDialogOpen(false);
      setSnackbar({ open: true, message: t('settings.backupSuccess'), severity: 'success' });
    } catch {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' });
    }
  };

  const handleRestore = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text) as BackupFileShape;
        const nextRestoreState = buildInitialRestoreState(data, i18n.language);
        setRestoreData(data);
        setRestoreFileName(file.name);
        setRestoreEmptyHint(nextRestoreState.emptyHint);
        setRestoreAvailability(nextRestoreState.availability);
        setRestoreStats(nextRestoreState.stats);
        setRestoreSelection(nextRestoreState.selection);
        setExpandedRestoreKeys(DEFAULT_EXPANDED_KEYS);
        setRestoreDialogOpen(true);
      } catch {
        setSnackbar({ open: true, message: t('common.error'), severity: 'error' });
      }
    };
    input.click();
  };

  const handleConfirmRestore = async () => {
    if (!restoreData) return;
    try {
      const existingCharacters = await api.getCharacters();
      const existingCharacterNames = new Set(
        existingCharacters
          .filter((character) => !character.isPreset)
          .map((character) => character.name.trim().toLowerCase())
          .filter(Boolean),
      );
      if (restoreSelection.characters && Array.isArray(restoreData.characters)) {
        for (const c of restoreData.characters) {
          if (!c || typeof c !== 'object' || (c as { isPreset?: boolean }).isPreset || typeof (c as { name?: unknown }).name !== 'string') continue;
          const normalizedName = (c as { name: string }).name.trim().toLowerCase();
          if (!normalizedName || existingCharacterNames.has(normalizedName)) continue;
          try {
            await api.createCharacter(c as Record<string, unknown> as Parameters<typeof api.createCharacter>[0]);
            existingCharacterNames.add(normalizedName);
          } catch (error) {
            if (error instanceof ApiError && error.code === 'DUPLICATE_CHARACTER_NAME') {
              existingCharacterNames.add(normalizedName);
              continue;
            }
            throw error;
          }
        }
      }
      if (restoreSelection.chats && Array.isArray(restoreData.chats)) {
        for (const chat of restoreData.chats) {
          if (typeof chat.name !== 'string' || !Array.isArray(chat.memberIds)) continue;
          const created = await api.createChat(chat as Parameters<typeof api.createChat>[0]);
          const createdChatId = (created as { id: string }).id;
          if (restoreSelection.messages && Array.isArray(restoreData.messages)) {
            const originalChatId = typeof chat?.id === 'string' ? chat.id : null;
            const chatMessages = originalChatId ? restoreData.messages.filter((m) => m.chatId === originalChatId) : [];
            for (const msg of chatMessages) {
              if (typeof msg.type !== 'string' || typeof msg.senderId !== 'string' || typeof msg.senderName !== 'string' || typeof msg.content !== 'string') continue;
              await api.createMessage(createdChatId, {
                type: msg.type,
                senderId: msg.senderId,
                senderName: msg.senderName,
                content: msg.content,
                emotion: typeof msg.emotion === 'number' ? msg.emotion : undefined,
                metadata: msg.metadata,
                timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
              });
            }
          }
        }
      }
      if (restoreSelection.settings && restoreData.settings && typeof restoreData.settings === 'object') {
        const nextSettings = filterSettingsForRestore(restoreData.settings, restoreSelection);
        if (Object.keys(nextSettings).length) {
          useSettingsStore.setState((state) => ({
            ...state,
            ...nextSettings,
            _loaded: true,
            syncStatus: 'idle',
            syncError: null,
          }));
        }
      }
      const characterStore = useCharacterStore.getState();
      const chatStore = useChatStore.getState();
      characterStore.markCharactersWarm();
      chatStore.markChatsWarm();
      void characterStore.prefetchCharacters();
      void chatStore.prefetchChats();
      setRestoreDialogOpen(false);
      setRestoreData(null);
      setSnackbar({ open: true, message: t('settings.restoreSuccess'), severity: 'success' });
    } catch {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' });
    }
  };

  const handleClearAll = async () => {
    if (clearAllBusy) return;
    setClearAllBusy(true);
    try {
      const chatStore = useChatStore.getState();
      const characterStore = useCharacterStore.getState();
      const chats = chatStore.chats;
      for (const chat of chats) {
        await chatStore.deleteChat(chat.id);
      }
      const customCharacterIds = characterStore.characters
        .filter((char) => !char.isPreset)
        .map((char) => char.id);
      if (customCharacterIds.length) {
        await characterStore.deleteCharacters(customCharacterIds);
      }
      settings.resetSettings();
      characterStore.markCharactersWarm();
      chatStore.markChatsWarm();
      void characterStore.prefetchCharacters();
      void chatStore.prefetchChats();
      setClearConfirm(false);
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' });
    } catch {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' });
    } finally {
      setClearAllBusy(false);
    }
  };

  const handleClearMessages = async () => {
    if (clearMessagesBusy) return;
    setClearMessagesBusy(true);
    try {
      const chatStore = useChatStore.getState();
      const messageStore = useMessageStore.getState();
      const chats = chatStore.chats;
      for (const chat of chats) {
        messageStore.clearChatMessagesLocal(chat.id);
        chatStore.clearPendingOperationsForChat(chat.id);
        await api.clearChatMessages(chat.id);
        await chatStore.updateChat(chat.id, {
          latestMessage: null,
          lastMessageAt: chat.createdAt,
        });
      }
      chatStore.markChatsWarm();
      void chatStore.prefetchChats();
      setClearMessagesConfirm(false);
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '已清空所有聊天记录，群组已保留' : 'All chat messages cleared; groups were kept', severity: 'success' });
    } catch {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' });
    } finally {
      setClearMessagesBusy(false);
    }
  };

  const handleLanguageChange = (lang: 'zh' | 'en') => {
    settings.setLanguage(lang);
    i18n.changeLanguage(lang);
  };

  const handleBrandStorageMigration = () => {
    const result = migrateLegacyBrandStorageKeys();
    const message = i18n.language.startsWith('zh')
      ? `迁移完成：搬迁 ${result.moved} 项，删除旧 key ${result.removed} 项，跳过 ${result.skipped} 项。页面即将刷新。`
      : `Migration complete: moved ${result.moved}, removed ${result.removed} old key(s), skipped ${result.skipped}. Reloading.`;
    setSnackbar({ open: true, message, severity: 'success' });
    window.setTimeout(() => window.location.reload(), 800);
  };

  const developerToolsSection = (
    <SurfaceCard id="settings-card-advanced" contentSx={buildCardBodySx()}>
      <Box sx={buildDeveloperBodySx()}>
        <SectionHeader
          title={i18n.language.startsWith('zh') ? '开发者模式' : 'Developer mode'}
        />
        <FormControlLabel
          sx={{ m: 0 }}
          control={<Switch checked={!developerModeDenied && settings.developerMode} disabled={!developerModeAvailable} onChange={(e) => settings.setDeveloperMode(e.target.checked)} />}
          label={i18n.language.startsWith('zh') ? '开发者模式' : 'Developer mode'}
        />
        {!developerModeAvailable ? (
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
            {i18n.language.startsWith('zh') ? '当前尚未确认开发者权限，因此无法开启。' : 'Developer access has not been confirmed for the current account.'}
          </Typography>
        ) : null}
        {developerModeAvailable && settings.developerMode ? (
          <>
        <StatChipRow items={buildDeveloperChips(i18n.language)} />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'auto minmax(0, 1fr)' }, gap: 1.25, alignItems: 'center', p: 1.25, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'background.default' }}>
          <Button startIcon={<SyncIcon />} size="small" variant="outlined" onClick={handleBrandStorageMigration} sx={{ justifySelf: 'start', width: 'fit-content', px: 1.25, whiteSpace: 'nowrap' }}>
            {i18n.language.startsWith('zh') ? '迁移旧本地数据' : 'Migrate old local data'}
          </Button>
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
            {i18n.language.startsWith('zh')
              ? '把旧品牌前缀的本地存储和临时草稿一次性搬到当前应用前缀，完成后刷新页面重新加载。'
              : 'Move old brand-prefixed local storage and session drafts to the current app prefix, then reload.'}
          </Typography>
        </Box>
        <Box sx={buildDeveloperSwitchGroupsSx()}>
          <Box sx={buildDeveloperSwitchGroupSx()}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
              {i18n.language.startsWith('zh') ? '事件提示' : 'Event hints'}
            </Typography>
            <Box sx={buildDeveloperSwitchListSx()}>
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showRelationshipEvents} onChange={(e) => settings.setDeveloperUI({ showRelationshipEvents: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '角色关系事件' : 'Character relationship events'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showAffectEvents} onChange={(e) => settings.setDeveloperUI({ showAffectEvents: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '情绪与人格漂移事件' : 'Emotion and drift events'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showStateEvents} onChange={(e) => settings.setDeveloperUI({ showStateEvents: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '房间态势事件' : 'Room state events'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showMemoryDistillationEvents} onChange={(e) => settings.setDeveloperUI({ showMemoryDistillationEvents: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '记忆蒸馏事件' : 'Memory distillation events'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showDetailedFactHints} onChange={(e) => settings.setDeveloperUI({ showDetailedFactHints: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '详细事实' : 'Detailed facts'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showCalendarEvents} onChange={(e) => settings.setDeveloperUI({ showCalendarEvents: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '日历活动事件' : 'Calendar activity events'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showLocalInterceptionHints} onChange={(e) => settings.setDeveloperUI({ showLocalInterceptionHints: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '显示拦截提示' : 'Show interception hints'} />
            </Box>
          </Box>
          <Box sx={buildDeveloperSwitchGroupSx()}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
              {i18n.language.startsWith('zh') ? '面板与证据' : 'Panels and evidence'}
            </Typography>
            <Box sx={buildDeveloperSwitchListSx()}>
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showSpeechStyle} onChange={(e) => settings.setDeveloperUI({ showSpeechStyle: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '发言风格面板' : 'Speech style panel'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showAdvancedRuntimePanels} onChange={(e) => settings.setDeveloperUI({ showAdvancedRuntimePanels: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '高级运行面板' : 'Advanced runtime panels'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showDeliberationDebug} onChange={(e) => settings.setDeveloperUI({ showDeliberationDebug: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '审议信号调试' : 'Deliberation signal debug'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showPresenceDebug} onChange={(e) => settings.setDeveloperUI({ showPresenceDebug: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '成员状态调试' : 'Presence debug'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showMemoryDebug} onChange={(e) => settings.setDeveloperUI({ showMemoryDebug: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '记忆证据与参数' : 'Memory evidence and metrics'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showCompanionshipDebug} onChange={(e) => settings.setDeveloperUI({ showCompanionshipDebug: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '陪伴运行诊断' : 'Companionship diagnostics'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showConflictEvents} onChange={(e) => settings.setDeveloperUI({ showConflictEvents: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '矛盾焦点与发展钩子' : 'Conflict focus and development hooks'} />
            </Box>
          </Box>
          <Box sx={buildDeveloperSwitchGroupSx()}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
              {i18n.language.startsWith('zh') ? '交互与实验' : 'Interaction and experiments'}
            </Typography>
            <Box sx={buildDeveloperSwitchListSx()}>
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.autoApplyCodeUpdates} onChange={(e) => settings.setDeveloperUI({ autoApplyCodeUpdates: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '自动应用代码更新' : 'Apply code updates automatically'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showWithdrawnMessageContent} onChange={(e) => settings.setDeveloperUI({ showWithdrawnMessageContent: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '悬浮查看撤回原文' : 'Reveal withdrawn content on hover'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.showMomentDebug} onChange={(e) => settings.setDeveloperUI({ showMomentDebug: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '朋友圈调试' : 'Moments debug'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.enableHumanAppraisal} onChange={(e) => settings.setDeveloperUI({ enableHumanAppraisal: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '启用人性化行为评估' : 'Enable human appraisal'} />
              <FormControlLabel control={<Switch size="small" checked={settings.developerUI.dramaBoost} onChange={(e) => settings.setDeveloperUI({ dramaBoost: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '增强戏剧冲突' : 'Boost dramatic conflict'} />
            </Box>
          </Box>
        </Box>
          </>
        ) : null}
      </Box>
    </SurfaceCard>
  );

  const settingsTabLabels: Record<SettingsTabKey, string> = {
    general: i18n.language.startsWith('zh') ? '通用' : 'General',
    models: i18n.language.startsWith('zh') ? '模型' : 'Models',
    chat: i18n.language.startsWith('zh') ? '聊天' : 'Chat',
    plugins: i18n.language.startsWith('zh') ? '插件' : 'Plugins',
  };
  const settingsTabItems = SETTINGS_TAB_KEYS.map((value) => ({ value, label: settingsTabLabels[value] }));

  const settingsTabRenderers = {
    general: (): ReactNode => (
          <>
        <SurfaceCard id="settings-card-account" sx={{ order: -30 }} contentSx={buildCardBodySx()}>
          <SectionHeader
            sx={{ mb: 0 }}
            title={i18n.language.startsWith('zh') ? '账号' : 'Account'}
            subtitle={authMode === 'local' ? (i18n.language.startsWith('zh') ? '离线本地模式 · 未登录' : 'Local-only mode · Not signed in') : `${user?.nickname || '-'} · ${user?.phone || '-'}`}
            action={<Button variant="outlined" size="small" onClick={() => navigate('/account')} sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{authMode === 'local' ? (i18n.language.startsWith('zh') ? '登录并同步' : 'Sign in & sync') : (i18n.language.startsWith('zh') ? '查看' : 'Open')}</Button>}
          />
        </SurfaceCard>

        <SurfaceCard id="settings-card-local-workspace" sx={{ order: -10 }} contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader
              title={i18n.language.startsWith('zh') ? '本地工作区' : 'Local workspace'}
              subtitle={localWorkspaceExpanded
                ? (i18n.language.startsWith('zh')
                  ? '授权本机文件夹后，助手产物会直接保存到默认文件夹的 chat/聊天名/产物名 中；未授权时继续使用应用内本地存储。'
                  : 'Authorize local folders to save assistant artifacts under chat/chat name/artifact name. Without authorization, artifacts stay in app storage.')
                : (localWorkspaceDirectories.length
                  ? (i18n.language.startsWith('zh') ? `已授权 ${localWorkspaceDirectories.length} 个文件夹` : `${localWorkspaceDirectories.length} folder(s) authorized`)
                  : (i18n.language.startsWith('zh') ? '尚未授权文件夹' : 'No folder authorized'))}
              action={
                <Tooltip title={localWorkspaceExpanded ? (i18n.language.startsWith('zh') ? '收起' : 'Collapse') : (i18n.language.startsWith('zh') ? '展开' : 'Expand')}>
                  <IconButton
                    size="small"
                    onClick={() => setLocalWorkspaceExpanded((value) => !value)}
                    aria-label={localWorkspaceExpanded ? (i18n.language.startsWith('zh') ? '收起本地工作区' : 'Collapse local workspace') : (i18n.language.startsWith('zh') ? '展开本地工作区' : 'Expand local workspace')}
                  >
                    <ExpandMoreIcon sx={{ transform: localWorkspaceExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 180ms cubic-bezier(0.4, 0, 0.2, 1)' }} />
                  </IconButton>
                </Tooltip>
              }
            />
            <Collapse in={localWorkspaceExpanded} timeout={180} unmountOnExit>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
                {!localWorkspaceSupported ? (
                  <Alert severity="info">
                    {i18n.language.startsWith('zh')
                      ? localWorkspaceSupport.message
                      : localWorkspaceSupport.reason === 'insecure_context'
                        ? 'Local folder authorization requires a secure context. Open the app from https://, http://localhost, or http://127.0.0.1 instead of a LAN IP or plain HTTP domain.'
                        : 'This browser environment cannot authorize local folders. Desktop Chrome/Edge usually supports this; Safari, Firefox, iOS, and embedded browsers usually do not.'}
                  </Alert>
                ) : null}
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button
                    variant="outlined"
                    startIcon={<FolderOpenOutlinedIcon />}
                    onClick={handleAddLocalWorkspaceDirectory}
                    disabled={!localWorkspaceSupported || localWorkspaceBusy}
                  >
                    {i18n.language.startsWith('zh') ? '授权文件夹' : 'Authorize folder'}
                  </Button>
                  <Typography variant="caption" color="text.secondary">
                    {localWorkspaceDirectories.length
                      ? (i18n.language.startsWith('zh') ? `已授权 ${localWorkspaceDirectories.length} 个文件夹` : `${localWorkspaceDirectories.length} folder(s) authorized`)
                      : (i18n.language.startsWith('zh') ? '尚未授权文件夹' : 'No folder authorized')}
                  </Typography>
                </Box>
                {localWorkspaceDirectories.length ? (
                  <Box sx={{ display: 'grid', gap: 1 }}>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) auto',
                        gap: 1,
                        alignItems: 'center',
                        p: 1.25,
                        borderRadius: 2,
                        border: '1px solid',
                        borderColor: defaultStorageTarget.kind === 'session' ? 'primary.main' : 'divider',
                        bgcolor: defaultStorageTarget.kind === 'session' ? 'primary.main' : 'background.default',
                        color: defaultStorageTarget.kind === 'session' ? 'primary.contrastText' : 'text.primary',
                      }}
                    >
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 800 }}>{i18n.language.startsWith('zh') ? '会话内存储' : 'Session storage'}</Typography>
                        <Typography variant="caption" sx={{ display: 'block', opacity: 0.75 }}>{i18n.language.startsWith('zh') ? '保留产物版本并显示在文件面板' : 'Versioned artifacts shown in the file panel'}</Typography>
                      </Box>
                      <Button size="small" variant={defaultStorageTarget.kind === 'session' ? 'contained' : 'outlined'} color={defaultStorageTarget.kind === 'session' ? 'inherit' : 'primary'} onClick={() => setDefaultStorageTarget({ kind: 'session' })}>
                        {defaultStorageTarget.kind === 'session' ? (i18n.language.startsWith('zh') ? '当前默认' : 'Current') : (i18n.language.startsWith('zh') ? '设为默认' : 'Set default')}
                      </Button>
                    </Box>
                    {!selectedLocalWorkspaceDirectoryId ? (
                      <Alert severity="info" icon={false} sx={{ py: 0.75 }}>
                        {i18n.language.startsWith('zh')
                          ? '当前未选择本地默认产物目录，助手产物会继续保存在应用内本地存储。'
                          : 'No local default artifact folder is selected. Assistant artifacts will stay in app storage.'}
                      </Alert>
                    ) : null}
                    {localWorkspaceDirectories.map((directory, index) => {
                      const isDefault = directory.id === selectedLocalWorkspaceDirectoryId;
                      return (
                        <Box
                          key={directory.id}
                          sx={{
                            display: 'grid',
                            gridTemplateColumns: { xs: '1fr auto', sm: 'minmax(0, 1fr) auto auto' },
                            gap: 1,
                            alignItems: 'center',
                            p: 1.25,
                            borderRadius: 2,
                            border: '1px solid',
                            borderColor: isDefault ? 'primary.main' : 'divider',
                            bgcolor: isDefault ? 'primary.main' : 'background.default',
                            color: isDefault ? 'primary.contrastText' : 'text.primary',
                          }}
                        >
                          <Box sx={{ minWidth: 0 }}>
                            <Typography variant="body2" sx={{ fontWeight: 800 }} noWrap>
                              {directory.name}
                            </Typography>
                            <Typography variant="caption" sx={{ display: 'block', opacity: 0.75 }} noWrap>
                              {isDefault
                                ? (i18n.language.startsWith('zh') ? '默认产物目录' : 'Default artifact folder')
                                : (i18n.language.startsWith('zh') ? `候选目录 ${index + 1} · 点击星标启用本地保存` : `Folder ${index + 1} · Click the star to enable local saving`)}
                            </Typography>
                            {directory.lastError ? (
                              <Typography variant="caption" sx={{ display: 'block', mt: 0.35, color: isDefault ? 'inherit' : 'error.main', opacity: isDefault ? 0.92 : 1 }} noWrap>
                                {directory.lastError}
                              </Typography>
                            ) : null}
                          </Box>
                          <Tooltip title={isDefault ? (i18n.language.startsWith('zh') ? '取消默认，改用应用内存储' : 'Unset default and use app storage') : (i18n.language.startsWith('zh') ? '设为默认产物目录' : 'Set as default artifact folder')}>
                            <span>
                              <IconButton
                                size="small"
                                color={isDefault ? 'inherit' : 'default'}
                                disabled={localWorkspaceBusy}
                                onClick={() => handleToggleDefaultLocalWorkspaceDirectory(directory.id)}
                              >
                                {isDefault ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title={i18n.language.startsWith('zh') ? '移除授权' : 'Remove authorization'}>
                            <span>
                              <IconButton
                                size="small"
                                color={isDefault ? 'inherit' : 'error'}
                                disabled={localWorkspaceBusy}
                                onClick={() => void handleRemoveLocalWorkspaceDirectory(directory.id)}
                              >
                                <DeleteOutlineOutlinedIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Box>
                      );
                    })}
                  </Box>
                ) : null}
              </Box>
            </Collapse>
          </Box>
        </SurfaceCard>

        <SurfaceCard id="settings-card-appearance" sx={{ order: -20 }} contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader title={t('settings.appearance')} />
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{t('settings.theme')}</Typography>
              <ToggleButtonGroup value={settings.theme} exclusive onChange={(_, v) => v && settings.setTheme(v)} size="small" sx={buildToggleGroupSx()}>
                <ToggleButton value="light">{t('settings.themeLight')}</ToggleButton>
                <ToggleButton value="dark">{t('settings.themeDark')}</ToggleButton>
                <ToggleButton value="system">{t('settings.themeSystem')}</ToggleButton>
              </ToggleButtonGroup>
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '主题方案' : 'Theme preset'}</Typography>
              <Box sx={buildThemePresetGridSx()}>
                {visibleThemePresets.map((preset) => {
                  const selected = selectedThemePreset.id === preset.id;
                  const [primary, secondary, accent] = preset.preview;
                  return (
                    <Button
                      key={preset.id}
                      variant="outlined"
                      onClick={() => settings.setThemePreset(preset.id, preset.schemes.light.primary)}
                      sx={buildThemePresetButtonSx(preset, selected)}
                    >
                      <Box sx={{ width: '100%', display: 'grid', gap: 1 }}>
                        <Box sx={buildThemeMiniPreviewSx(preset)}>
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: { xs: 0.6, sm: 1 } }}>
                            <Box sx={{ display: 'flex', gap: { xs: 0.4, sm: 0.55 } }}>
                              {[primary, secondary, accent].map((color, index) => (
                                <Box
                                  key={color}
                                  className="theme-wave-dot"
                                  sx={{
                                    width: { xs: 11, sm: 14 },
                                    height: { xs: 11, sm: 14 },
                                    borderRadius: '50%',
                                    bgcolor: color,
                                    position: 'relative',
                                    boxShadow: `0 0 0 1px rgba(255,255,255,0.42), 0 5px 13px ${color}38`,
                                    animation: 'themeDotBob 1150ms ease-in-out infinite',
                                    animationDelay: `${index * 135}ms`,
                                    animationPlayState: 'paused',
                                  }}
                                />
                              ))}
                            </Box>
                            <Box sx={{ width: { xs: 20, sm: 24 }, height: { xs: 20, sm: 24 }, borderRadius: '50%', bgcolor: selected ? primary : 'rgba(255,255,255,0.56)', color: '#fff', display: 'grid', placeItems: 'center', border: '1px solid', borderColor: selected ? `${primary}88` : 'rgba(255,255,255,0.46)', boxShadow: selected ? `0 8px 18px ${primary}35` : 'inset 0 1px 0 rgba(255,255,255,0.4)' }}>
                              {selected ? <CheckIcon sx={{ fontSize: { xs: 14, sm: 16 } }} /> : null}
                            </Box>
                          </Box>
                          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr) 50px', sm: 'minmax(0, 1fr) 72px' }, gap: { xs: 0.6, sm: 1 }, alignItems: 'end' }}>
                            <Box sx={{ display: 'grid', gap: { xs: 0.55, sm: 0.8 }, alignSelf: 'center', pb: 0.3, transform: 'translateY(-2px)' }}>
                              {[
                                { color: primary, width: '96%', opacity: 0.9, animation: 'themeLineRhythmA 1200ms ease-in-out infinite' },
                                { color: secondary, width: '74%', opacity: 0.68, animation: 'themeLineRhythmB 1480ms ease-in-out infinite' },
                                { color: accent, width: '48%', opacity: 0.5, animation: 'themeLineRhythmC 1760ms ease-in-out infinite' },
                              ].map((line, index) => (
                                <Box
                                  key={`${line.color}-${index}`}
                                  className="theme-rhythm-line"
                                  sx={{
                                    height: { xs: index === 0 ? 6 : 5, sm: index === 0 ? 7 : 6 },
                                    width: line.width,
                                    borderRadius: 999,
                                    bgcolor: line.color,
                                    opacity: line.opacity,
                                    transformOrigin: 'left center',
                                    animation: line.animation,
                                    animationPlayState: 'paused',
                                    boxShadow: `0 4px 12px ${line.color}24`,
                                  }}
                                />
                              ))}
                            </Box>
                            <Box
                              className="theme-ui-preview"
                              sx={{
                                justifySelf: 'end',
                                alignSelf: 'end',
                                width: { xs: 48, sm: 68 },
                                height: { xs: 36, sm: 48 },
                                position: 'relative',
                                animation: 'themePreviewDrift 2200ms ease-in-out infinite',
                                animationPlayState: 'paused',
                                borderRadius: 1.35,
                                border: '1px solid rgba(255,255,255,0.38)',
                                background: 'rgba(255,255,255,0.34)',
                                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45), 0 10px 22px rgba(15,23,42,0.08)',
                                overflow: 'hidden',
                              }}
                            >
                              <Box
                                className="theme-floating-bubble"
                                sx={{
                                  position: 'absolute',
                                  left: { xs: 6, sm: 8 },
                                  top: { xs: 8, sm: 10 },
                                  width: { xs: 24, sm: 34 },
                                  height: { xs: 11, sm: 14 },
                                  borderRadius: '7px 7px 7px 2px',
                                  bgcolor: 'rgba(255,255,255,0.76)',
                                  border: '1px solid rgba(255,255,255,0.44)',
                                  animation: 'themeBubbleRise 3200ms cubic-bezier(0.4, 0, 0.2, 1) infinite',
                                  animationDelay: '-400ms',
                                  animationFillMode: 'both',
                                  animationPlayState: 'paused',
                                  boxShadow: '0 6px 13px rgba(15,23,42,0.08)',
                                }}
                              >
                                <Box sx={{ position: 'absolute', left: { xs: 5, sm: 7 }, top: { xs: 4, sm: 5 }, width: { xs: 11, sm: 15 }, height: 3, borderRadius: 999, bgcolor: 'rgba(15,23,42,0.16)' }} />
                              </Box>
                              <Box
                                className="theme-floating-bubble"
                                sx={{
                                  position: 'absolute',
                                  right: { xs: 5, sm: 7 },
                                  bottom: { xs: 6, sm: 8 },
                                  width: { xs: 28, sm: 38 },
                                  height: { xs: 12, sm: 16 },
                                  borderRadius: '8px 8px 2px 8px',
                                  bgcolor: primary,
                                  animation: 'themeBubbleRise 3200ms cubic-bezier(0.4, 0, 0.2, 1) infinite',
                                  animationDelay: '-1900ms',
                                  animationFillMode: 'both',
                                  animationPlayState: 'paused',
                                  boxShadow: `0 7px 16px ${primary}28`,
                                }}
                              >
                                <Box sx={{ position: 'absolute', right: { xs: 6, sm: 8 }, top: { xs: 4, sm: 6 }, width: { xs: 13, sm: 18 }, height: { xs: 3, sm: 4 }, borderRadius: 999, bgcolor: 'rgba(255,255,255,0.72)' }} />
                              </Box>
                            </Box>
                          </Box>
                        </Box>
                        <Box sx={{ minWidth: 0, textAlign: 'left' }}>
                          <Typography variant="body2" sx={{ fontWeight: selected ? 800 : 700, lineHeight: 1.25 }}>
                            {i18n.language.startsWith('zh') ? preset.nameZh : preset.nameEn}
                          </Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.4, lineHeight: 1.35 }}>
                            {i18n.language.startsWith('zh') ? preset.descriptionZh : preset.descriptionEn}
                          </Typography>
                        </Box>
                      </Box>
                    </Button>
                  );
                })}
              </Box>
              {hiddenThemePresetCount > 0 ? (
                <Button
                  size="small"
                  variant="text"
                  endIcon={<ExpandMoreIcon sx={{ transform: showAllThemePresets ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 160ms ease' }} />}
                  onClick={() => setShowAllThemePresets((value) => !value)}
                  sx={{ mt: 1, px: 0.5, fontWeight: 650 }}
                >
                  {showAllThemePresets
                    ? (i18n.language.startsWith('zh') ? '收起主题' : 'Show fewer themes')
                    : (i18n.language.startsWith('zh') ? `展开更多主题（${hiddenThemePresetCount}）` : `More themes (${hiddenThemePresetCount})`)}
                </Button>
              ) : null}
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '我的气泡' : 'My bubble'}</Typography>
              <Box sx={buildAccountBubblePreviewSx()} onClick={() => setUserBubblePickerOpen(true)}>
                <Box sx={{ flexShrink: 0, width: 34, height: 34, borderRadius: '50%', bgcolor: 'action.hover', display: 'grid', placeItems: 'center', overflow: 'hidden', boxShadow: 'none' }}>
                  {selfAvatarIsImage ? <Box component="img" src={selfAvatarValue} alt={user?.nickname || 'me'} sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : normalizedSelfAvatar ? selfAvatarValue : <DefaultUserAvatarIcon title={user?.nickname || 'User'} />}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ width: 'fit-content', maxWidth: '100%', px: 1.35, py: 0.85, border: userBubblePreview.border, borderRadius: userBubblePreview.borderRadius, boxShadow: userBubblePreview.boxShadow, color: userBubblePreview.color, background: userBubblePreview.background }}>
                    <Typography variant="body2" noWrap>{selfBubblePreviewText}</Typography>
                  </Box>
                </Box>
                <Button size="small" variant="text" startIcon={<EditIcon fontSize="small" />} sx={{ flexShrink: 0 }}>
                  {i18n.language.startsWith('zh') ? '设置' : 'Set'}
                </Button>
              </Box>
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '语音条样式' : 'Voice bar style'}</Typography>
              <ToggleButtonGroup value={settings.chatAppearance.voiceWaveformStyle} exclusive onChange={(_, value) => value && settings.setChatAppearance({ voiceWaveformStyle: value as VoiceWaveformStyle })} size="small" sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 0.55, width: '100%' }}>
                {visibleVoiceStyles.map((option) => (
                  <ToggleButton key={option.value} value={option.value} sx={{ display: 'grid', gap: 0.25, px: 0.65, py: 0.5, minWidth: 0, minHeight: 50, borderRadius: 1.5, textTransform: 'none', whiteSpace: 'normal', '&.Mui-selected': { boxShadow: '0 0 0 1px color-mix(in srgb, var(--mui-palette-primary-main) 45%, transparent)' } }}>
                    <VoiceStylePreview style={option.value} selected={settings.chatAppearance.voiceWaveformStyle === option.value} />
                    <Typography variant="caption" sx={{ fontWeight: 650, lineHeight: 1.1 }}>{i18n.language.startsWith('zh') ? option.zh : option.en}</Typography>
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <Button
                size="small"
                variant="text"
                endIcon={<ExpandMoreIcon sx={{ transform: showAllVoiceStyles ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 160ms ease' }} />}
                onClick={() => setShowAllVoiceStyles((value) => !value)}
                sx={{ mt: 0.75, px: 0.5, fontWeight: 650 }}
              >
                {showAllVoiceStyles
                  ? (i18n.language.startsWith('zh') ? '收起语音样式' : 'Show fewer voice styles')
                  : (i18n.language.startsWith('zh') ? `展开更多样式（${hiddenVoiceStyleCount}）` : `More voice styles (${hiddenVoiceStyleCount})`)}
              </Button>
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '信件背景' : 'Letter background'}</Typography>
              <ToggleButtonGroup value={settings.artifactAppearance.paperVariant} exclusive onChange={(_, v) => v && settings.setArtifactAppearance({ paperVariant: v })} size="small" sx={buildPaperPickerSx()}>
                {PAPER_SURFACE_VARIANTS.map((variant) => (
                  <ToggleButton key={variant} value={variant} sx={buildPaperToggleSx()}>
                    <Box sx={buildPaperPreviewSx(variant)} />
                    <Typography variant="caption" sx={{ fontWeight: 650 }}>{getPaperVariantLabel(variant, i18n.language)}</Typography>
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{t('settings.language')}</Typography>
              <ToggleButtonGroup value={settings.language} exclusive onChange={(_, v) => v && handleLanguageChange(v)} size="small" sx={buildToggleGroupSx()}>
                <ToggleButton value="zh">中文</ToggleButton>
                <ToggleButton value="en">English</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          </Box>
        </SurfaceCard>


        <SurfaceCard id="settings-card-data" contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader title={t('settings.dataManagement')} />
            <Box sx={buildActionGridSx()}>
              <Button startIcon={<BackupIcon />} variant="outlined" onClick={handleBackup}>{t('settings.backup')}</Button>
              <Button startIcon={<RestoreIcon />} variant="outlined" onClick={handleRestore}>{t('settings.restore')}</Button>
              <Button variant="outlined" onClick={() => navigate('/settings/recycle-bin')}>{i18n.language.startsWith('zh') ? '回收站' : 'Recycle Bin'}</Button>
              <Button variant="outlined" startIcon={<DeleteOutlineOutlinedIcon />} onClick={clearAllCachedSpeechPlayback}>
                {i18n.language.startsWith('zh') ? '清除语音缓存' : 'Clear speech cache'}
              </Button>
              <Button startIcon={<ClearIcon />} variant="outlined" color="warning" onClick={() => setClearMessagesConfirm(true)}>
                {i18n.language.startsWith('zh') ? '清空聊天记录' : 'Clear chat messages'}
              </Button>
              <Button startIcon={<ClearIcon />} variant="outlined" color="error" onClick={() => setClearConfirm(true)}>{t('settings.clearAll')}</Button>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {i18n.language.startsWith('zh') ? '语音缓存仅是手动播放生成的临时文件，最长保留 7 天、最多占用 160MB；不会影响聊天中的正式语音和图片附件。' : 'Speech playback cache is temporary, kept for up to 7 days and 160 MB; formal chat audio and image attachments are not affected.'}
            </Typography>
          </Box>
        </SurfaceCard>

        {developerToolsSection}

        <SurfaceCard id="settings-card-about" contentSx={buildCardBodySx()}>
          <SectionHeader title={t('settings.about')} dense />
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>Sense Murmur</Typography>
          <Chip size="small" label="v1.0.0" variant="outlined" onClick={() => navigate('/intro')} sx={{ cursor: 'pointer' }} />
        </SurfaceCard>

        <Button
          fullWidth
          variant="outlined"
          color="error"
          startIcon={<LogoutIcon />}
          onClick={() => {
            void useAuthStore.getState().logout();
          }}
          sx={{ mb: 1 }}
        >
          {i18n.language.startsWith('zh') ? '退出登录' : 'Log out'}
        </Button>
          </>
    ),
    models: (): ReactNode => (
          <Box id="settings-card-models">
            <AIModelsPanel embedded />
          </Box>
    ),
    chat: (): ReactNode => (
          <>

        <SurfaceCard id="settings-card-compact-chat" contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader title={i18n.language.startsWith('zh') ? '简洁模式' : 'Compact mode'} />
            <Box sx={{ display: 'grid', gap: 1 }}>
              <FormControlLabel control={<Switch checked={compactBubbleMode} onChange={(e) => settings.setCompactBubbleMode(e.target.checked)} />} label={i18n.language.startsWith('zh') ? '简洁模式' : 'Compact bubble mode'} />
              <FormControlLabel control={<Switch checked={compactPrivateBubbleMode} onChange={(e) => settings.setCompactPrivateBubbleMode(e.target.checked)} />} label={i18n.language.startsWith('zh') ? '私聊简洁模式' : 'Compact private bubbles'} />
              <FormControlLabel control={<Switch checked={settings.hidePrivateChatIdentity} onChange={(e) => settings.setHidePrivateChatIdentity(e.target.checked)} />} label={i18n.language.startsWith('zh') ? '私聊隐藏头像和昵称' : 'Hide avatars and names in private chats'} />
            </Box>
          </Box>
        </SurfaceCard>

        <SurfaceCard id="settings-card-chat-display" contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader title={i18n.language.startsWith('zh') ? '聊天显示' : 'Chat display'} />
            <Box sx={{ display: 'grid', gap: 1 }}>
              <FormControlLabel
                control={<Switch checked={settings.enableChatStickers} onChange={(e) => settings.setEnableChatStickers(e.target.checked)} />}
                label={i18n.language.startsWith('zh') ? '启用表情包（轻松聊天）' : 'Enable stickers (light chat)'}
              />
              <FormControlLabel
                control={<Switch checked={settings.enableStreamingDisplayAnimation} onChange={(e) => settings.setEnableStreamingDisplayAnimation(e.target.checked)} />}
                label={i18n.language.startsWith('zh') ? '消息流式输出' : 'Streaming message output'}
              />
              <FormControlLabel
                control={<Switch checked={settings.showVoiceTranscript} onChange={(e) => settings.setShowVoiceTranscript(e.target.checked)} />}
                label={i18n.language.startsWith('zh') ? '默认显示语音文字' : 'Show voice transcript by default'}
              />
            </Box>
          </Box>
          <Box id="settings-card-chat-reply-preferences" sx={{ mt: 1.5, scrollMarginTop: { xs: 128, sm: 96 } }}>
            <ChatReplyPreferencesSection />
          </Box>
        </SurfaceCard>

        <SurfaceCard id="settings-card-ai-generation" contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader title={i18n.language.startsWith('zh') ? 'AI生成' : 'AI Generation'} />
            <Box sx={{ display: 'grid', gap: 1 }}>
              <FormControlLabel control={<Switch checked={settings.avatarGeneration.autoGenerateCharacterAvatar} onChange={(e) => settings.setAutoGenerateCharacterAvatar(e.target.checked)} />} label={i18n.language.startsWith('zh') ? '自动生成头像' : 'Auto-generate avatars'} />
              <FormControlLabel control={<Switch checked={settings.avatarGeneration.preferNonPhotorealAvatar} onChange={(e) => settings.setAvatarGeneration({ preferNonPhotorealAvatar: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '非写实头像' : 'Non-photoreal avatars'} />
              <FormControlLabel control={<Switch checked={settings.aiGeneration.enableMoments} onChange={(e) => settings.setAIGeneration({ enableMoments: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '启用朋友圈自动生成' : 'Enable moments auto-generation'} />
              <FormControlLabel control={<Switch checked={settings.aiGeneration.enableDiaries} onChange={(e) => settings.setAIGeneration({ enableDiaries: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '启用日记自动生成' : 'Enable diary auto-generation'} />
            </Box>
          </Box>
        </SurfaceCard>

        <SurfaceCard id="settings-card-companionship" contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader title={i18n.language.startsWith('zh') ? '陪伴' : 'Companionship'} />
            <Box sx={{ display: 'grid', gap: 1 }}>
              <FormControlLabel control={<Switch checked={settings.companionship.enableProactiveCare} onChange={(e) => settings.setCompanionship({ enableProactiveCare: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '启用主动陪伴' : 'Enable proactive companionship'} />
              <FormControlLabel control={<Switch checked={settings.companionship.showStatusHints} onChange={(e) => settings.setCompanionship({ showStatusHints: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '显示陪伴状态提示' : 'Show companionship status hints'} />
              <FormControlLabel control={<Switch checked={settings.companionship.enableAttachmentAdaptation} onChange={(e) => settings.setCompanionship({ enableAttachmentAdaptation: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '启用互动模式适配' : 'Enable interaction-pattern adaptation'} />
              <FormControlLabel control={<Switch checked={settings.companionship.enableRelationshipRituals} onChange={(e) => settings.setCompanionship({ enableRelationshipRituals: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '启用关系仪式' : 'Enable relationship rituals'} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', opacity: settings.companionship.enableRelationshipRituals ? 1 : 0.55 }}>
                <Typography variant="body2" sx={{ fontWeight: 500, mr: 0.25 }}>{i18n.language.startsWith('zh') ? '仪式类型' : 'Ritual types'}</Typography>
                {RITUAL_KIND_OPTIONS.map((option) => {
                  const enabled = settings.companionship.ritualKindToggles[option.kind] !== false;
                  return (
                    <Chip
                      key={option.kind}
                      size="small"
                      label={i18n.language.startsWith('zh') ? option.zh : option.en}
                      color={enabled ? 'primary' : 'default'}
                      variant={enabled ? 'filled' : 'outlined'}
                      disabled={!settings.companionship.enableRelationshipRituals}
                      onClick={() => settings.setCompanionship({
                        ritualKindToggles: {
                          ...settings.companionship.ritualKindToggles,
                          [option.kind]: !enabled,
                        },
                      })}
                      sx={{ height: 26, borderRadius: 999 }}
                    />
                  );
                })}
              </Box>
              <FormControlLabel control={<Switch checked={settings.companionship.enableCharacterPrivateThreads} onChange={(e) => settings.setCompanionship({ enableCharacterPrivateThreads: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '启用角色陪伴私聊' : 'Enable character companionship private chats'} />
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '陪伴敏感边界' : 'Companionship sensitivity boundary'}</Typography>
                  <ToggleButtonGroup value={settings.companionship.sensitiveBoundaryMode} exclusive onChange={(_, v) => v && settings.setCompanionship({ sensitiveBoundaryMode: v })} size="small" sx={buildToggleGroupSx()}>
                    <ToggleButton value="normal">{i18n.language.startsWith('zh') ? '正常' : 'Normal'}</ToggleButton>
                    <ToggleButton value="restrained">{i18n.language.startsWith('zh') ? '克制' : 'Restrained'}</ToggleButton>
                    <ToggleButton value="off">{i18n.language.startsWith('zh') ? '关闭' : 'Off'}</ToggleButton>
                  </ToggleButtonGroup>
                </Box>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '主动冷却（分钟）' : 'Proactive cooldown (min)'}</Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 0.75 }}>
                    <TextField type="number" size="small" label={i18n.language.startsWith('zh') ? '私聊' : 'Check-in'} value={settings.companionship.proactiveCooldownMinutes.checkIn} onChange={(e) => settings.setCompanionship({ proactiveCooldownMinutes: { ...settings.companionship.proactiveCooldownMinutes, checkIn: Math.max(0, Math.round(Number(e.target.value) || 0)) } })} slotProps={{ htmlInput: { min: 0, max: 1440, step: 1 } }} />
                    <TextField type="number" size="small" label={i18n.language.startsWith('zh') ? '动态' : 'React'} value={settings.companionship.proactiveCooldownMinutes.reactToMoment} onChange={(e) => settings.setCompanionship({ proactiveCooldownMinutes: { ...settings.companionship.proactiveCooldownMinutes, reactToMoment: Math.max(0, Math.round(Number(e.target.value) || 0)) } })} slotProps={{ htmlInput: { min: 0, max: 1440, step: 1 } }} />
                    <TextField type="number" size="small" label={i18n.language.startsWith('zh') ? '邀约' : 'Outing'} value={settings.companionship.proactiveCooldownMinutes.socialOuting} onChange={(e) => settings.setCompanionship({ proactiveCooldownMinutes: { ...settings.companionship.proactiveCooldownMinutes, socialOuting: Math.max(0, Math.round(Number(e.target.value) || 0)) } })} slotProps={{ htmlInput: { min: 0, max: 1440, step: 1 } }} />
                    <TextField type="number" size="small" label={i18n.language.startsWith('zh') ? '状态' : 'Status'} value={settings.companionship.proactiveCooldownMinutes.statusUpdate} onChange={(e) => settings.setCompanionship({ proactiveCooldownMinutes: { ...settings.companionship.proactiveCooldownMinutes, statusUpdate: Math.max(0, Math.round(Number(e.target.value) || 0)) } })} slotProps={{ htmlInput: { min: 0, max: 1440, step: 1 } }} />
                  </Box>
                </Box>
              </Box>
              <TextField
                type="number"
                size="small"
                label={i18n.language.startsWith('zh') ? '未完成约定保留天数' : 'Pending promise retention days'}
                value={settings.companionship.pendingPromiseRetentionDays}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  settings.setCompanionship({ pendingPromiseRetentionDays: Number.isFinite(value) ? Math.min(365, Math.max(1, Math.round(value))) : 30 });
                }}
                slotProps={{ htmlInput: { min: 1, max: 365, step: 1 } }}
                sx={{ maxWidth: 260 }}
              />
              <TextField
                type="number"
                size="small"
                label={i18n.language.startsWith('zh') ? '角色私聊冷却（小时）' : 'Character private chat cooldown (h)'}
                value={settings.companionship.privateThreadCooldownHours}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  settings.setCompanionship({ privateThreadCooldownHours: Number.isFinite(value) ? Math.min(168, Math.max(0, Math.round(value * 100) / 100)) : 6 });
                }}
                slotProps={{ htmlInput: { min: 0, max: 168, step: 0.5 } }}
                sx={{ maxWidth: 260 }}
              />
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '陪伴表达强度' : 'Companionship intensity'}</Typography>
                <ToggleButtonGroup value={settings.companionship.careIntensity} exclusive onChange={(_, v) => v && settings.setCompanionship({ careIntensity: v })} size="small" sx={buildToggleGroupSx()}>
                  <ToggleButton value="restrained">{i18n.language.startsWith('zh') ? '克制' : 'Restrained'}</ToggleButton>
                  <ToggleButton value="balanced">{i18n.language.startsWith('zh') ? '平衡' : 'Balanced'}</ToggleButton>
                  <ToggleButton value="expressive">{i18n.language.startsWith('zh') ? '主动' : 'Expressive'}</ToggleButton>
                </ToggleButtonGroup>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1, alignItems: 'center' }}>
                <FormControlLabel control={<Switch checked={settings.companionship.allowGoodMorning} onChange={(e) => settings.setCompanionship({ allowGoodMorning: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '允许早安' : 'Good morning'} />
                <FormControlLabel control={<Switch checked={settings.companionship.allowGoodNight} onChange={(e) => settings.setCompanionship({ allowGoodNight: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '允许晚安' : 'Good night'} />
                <FormControlLabel control={<Switch checked={settings.companionship.allowMissYou} onChange={(e) => settings.setCompanionship({ allowMissYou: e.target.checked })} />} label={i18n.language.startsWith('zh') ? '允许想念表达' : 'Miss-you expression'} />
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1.1fr) repeat(2, minmax(0, 0.8fr))' }, gap: 1, alignItems: 'center' }}>
                <FormControlLabel control={<Switch checked={settings.companionship.quietHours.enabled} onChange={(e) => settings.setCompanionship({ quietHours: { ...settings.companionship.quietHours, enabled: e.target.checked } })} />} label={i18n.language.startsWith('zh') ? '陪伴免打扰' : 'Companionship quiet hours'} />
                <TextField type="time" size="small" label={i18n.language.startsWith('zh') ? '开始' : 'Start'} value={settings.companionship.quietHours.start} onChange={(e) => settings.setCompanionship({ quietHours: { ...settings.companionship.quietHours, start: e.target.value } })} disabled={!settings.companionship.quietHours.enabled} slotProps={{ inputLabel: { shrink: true } }} />
                <TextField type="time" size="small" label={i18n.language.startsWith('zh') ? '结束' : 'End'} value={settings.companionship.quietHours.end} onChange={(e) => settings.setCompanionship({ quietHours: { ...settings.companionship.quietHours, end: e.target.value } })} disabled={!settings.companionship.quietHours.enabled} slotProps={{ inputLabel: { shrink: true } }} />
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
                <FormControlLabel control={<Switch checked={settings.companionship.quietHours.suppressStatusHints} onChange={(e) => settings.setCompanionship({ quietHours: { ...settings.companionship.quietHours, suppressStatusHints: e.target.checked } })} disabled={!settings.companionship.quietHours.enabled} />} label={i18n.language.startsWith('zh') ? '免打扰时隐藏陪伴状态提示' : 'Hide status hints during quiet hours'} />
                <FormControlLabel control={<Switch checked={settings.companionship.quietHours.suppressProactiveCare} onChange={(e) => settings.setCompanionship({ quietHours: { ...settings.companionship.quietHours, suppressProactiveCare: e.target.checked } })} disabled={!settings.companionship.quietHours.enabled} />} label={i18n.language.startsWith('zh') ? '免打扰时阻止主动陪伴' : 'Block proactive care during quiet hours'} />
              </Box>
            </Box>
          </Box>
        </SurfaceCard>

        <SurfaceCard id="settings-card-chat-memory" contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader
              title={i18n.language.startsWith('zh') ? '记忆' : 'Memory'}
              action={(
                <Tooltip title={i18n.language.startsWith('zh') ? '隐私过滤、第三方归属和矛盾记忆保护始终生效。这里控制的是长期记忆在聊天生成中的召回方式，不影响主动陪伴。' : 'Privacy filtering, third-party ownership checks, and contradicted-memory guards always stay on. These settings control chat recall, not proactive companionship.'}>
                  <IconButton size="small" aria-label={i18n.language.startsWith('zh') ? '记忆说明' : 'Memory help'}>
                    <HelpOutlineIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              )}
            />
            <Box sx={{ display: 'grid', gap: 1 }}>
              <FormControlLabel
                control={<Switch checked={settings.chatMemory.enabled} onChange={(e) => settings.setChatMemory({ enabled: e.target.checked })} />}
                label={(
                  <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    <span>{i18n.language.startsWith('zh') ? '允许自然提起旧事' : 'Allow natural old-memory callbacks'}</span>
                    <Tooltip title={i18n.language.startsWith('zh')
                      ? '控制角色是否可以在当前回复里自然提起已经保存的偏好、旧事和关系细节。关闭后，核心用户画像、关系边界和角色连续性仍会作为潜台词影响语气与选择。'
                      : 'Controls whether the character may naturally mention saved preferences, past moments, and relationship details in the current reply. When off, core user profile, relationship boundaries, and character continuity can still shape tone and choices as subtext.'}>
                      <HelpOutlineIcon sx={{ fontSize: 17, color: 'text.secondary' }} />
                    </Tooltip>
                  </Box>
                )}
              />
              <Box sx={{ opacity: settings.chatMemory.enabled ? 1 : 0.55 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '可见回忆强度' : 'Visible recall style'}</Typography>
                <ToggleButtonGroup
                  value={settings.chatMemory.visibleRecallMode}
                  exclusive
                  onChange={(_, v) => v && settings.setChatMemory({ visibleRecallMode: v })}
                  size="small"
                  sx={buildToggleGroupSx()}
                  disabled={!settings.chatMemory.enabled}
                >
                  <ToggleButton value="implicit">{i18n.language.startsWith('zh') ? '只作潜台词' : 'Implicit'}</ToggleButton>
                  <ToggleButton value="balanced">{i18n.language.startsWith('zh') ? '自然提及' : 'Balanced'}</ToggleButton>
                  <ToggleButton value="direct">{i18n.language.startsWith('zh') ? '更愿意明说' : 'Direct'}</ToggleButton>
                </ToggleButtonGroup>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1, opacity: settings.chatMemory.enabled ? 1 : 0.55 }}>
                <TextField
                  type="number"
                  size="small"
                  label={i18n.language.startsWith('zh') ? '每轮最多召回条数' : 'Max cues per turn'}
                  value={settings.chatMemory.maxCuesPerTurn}
                  onChange={(e) => settings.setChatMemory({ maxCuesPerTurn: Math.max(0, Math.min(3, Math.round(Number(e.target.value) || 0))) })}
                  disabled={!settings.chatMemory.enabled}
                  slotProps={{ htmlInput: { min: 0, max: 3, step: 1 } }}
                />
                <TextField
                  type="number"
                  size="small"
                  label={i18n.language.startsWith('zh') ? '重复召回冷却轮数' : 'Cue cooldown turns'}
                  value={settings.chatMemory.cueCooldownTurns}
                  onChange={(e) => settings.setChatMemory({ cueCooldownTurns: Math.max(0, Math.min(24, Math.round(Number(e.target.value) || 0))) })}
                  disabled={!settings.chatMemory.enabled}
                  slotProps={{ htmlInput: { min: 0, max: 24, step: 1 } }}
                />
              </Box>
            </Box>
          </Box>
        </SurfaceCard>

        <SurfaceCard id="settings-card-chat-defaults" contentSx={buildCardBodySx()}>
          <Box sx={buildSectionBodySx()}>
            <SectionHeader title={i18n.language.startsWith('zh') ? '群聊默认行为' : 'Chat defaults'} />
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500 }} gutterBottom>{i18n.language.startsWith('zh') ? '群聊默认变化强度' : 'Default evolution intensity for group chats'}</Typography>
              <ToggleButtonGroup value={settings.chatDraftDefaults.runtimeEvolutionIntensity} exclusive onChange={(_, v) => v && settings.setChatDraftDefaults({ runtimeEvolutionIntensity: v })} size="small" sx={buildToggleGroupSx()}>
                <ToggleButton value="slow">{i18n.language.startsWith('zh') ? '慢' : 'Slow'}</ToggleButton>
                <ToggleButton value="balanced">{i18n.language.startsWith('zh') ? '平衡' : 'Balanced'}</ToggleButton>
                <ToggleButton value="fast">{i18n.language.startsWith('zh') ? '快' : 'Fast'}</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          </Box>
        </SurfaceCard>
          </>
    ),
    plugins: (): ReactNode => (
          <SurfaceCard id="settings-card-plugins" contentSx={buildCardBodySx()}>
            <Box sx={buildSectionBodySx()}>
              <SectionHeader
                title={i18n.language.startsWith('zh') ? '实验' : 'Experiments'}
              />
              <Box sx={{ display: 'grid', gap: 0.25 }}>
                    {[
                      i18n.language.startsWith('zh') ? 'LLM 记忆闸门' : 'LLM memory gate',
                      i18n.language.startsWith('zh') ? '向量召回' : 'Vector recall',
                    ].map((label) => (
                      <Box key={label} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                        <FormControlLabel sx={{ m: 0 }} control={<Switch size="small" disabled />} label={label} />
                        <Chip size="small" variant="outlined" label={i18n.language.startsWith('zh') ? '评估中' : 'Evaluating'} />
                      </Box>
                    ))}
              </Box>
            </Box>
          </SurfaceCard>
    ),
  } satisfies Record<SettingsTabKey, () => ReactNode>;

  const settingsTabContent = (
    <Box sx={buildSettingsTabContentSx()}>
      {settingsTabRenderers[activeSettingsTab]()}
    </Box>
  );

  return (
    <Box sx={buildPageSx(activeSettingsTab)}>
      <PageSection spacing={2.25}>
        <Box sx={{ ...buildFloatingTabContainerSx(), order: -100, mb: 0.5, animation: 'none !important', transform: 'none !important' }}>
          <FloatingSegmentedTabs
            value={activeSettingsTab}
            scrollContentToTopOnChange
            onChange={(value) => {
              if (SETTINGS_TAB_KEYS.includes(value)) {
                setTabTransitionDirection(resolveTabTransitionDirection(SETTINGS_TAB_KEYS, activeSettingsTab, value));
                setActiveSettingsTab(value);
                updateSettingsLocation(value);
              }
            }}
            items={settingsTabItems}
          />
        </Box>

        <AnimatedTabContent value={activeSettingsTab} direction={tabTransitionDirection}>
          {settingsTabContent}
        </AnimatedTabContent>
      </PageSection>

      <ConfirmDialog
        open={clearConfirm}
        title={t('settings.clearAll')}
        message={t('settings.clearAllConfirm')}
        onConfirm={handleClearAll}
        onCancel={() => setClearConfirm(false)}
        loading={clearAllBusy}
        destructive
      />
      <ConfirmDialog
        open={clearMessagesConfirm}
        title={i18n.language.startsWith('zh') ? '清空聊天记录' : 'Clear chat messages'}
        message={i18n.language.startsWith('zh') ? '将清空云端和本设备的所有聊天记录，但不会删除群组、角色或设置。此操作不可恢复。' : 'This clears all cloud and local chat messages but keeps groups, characters, and settings. This cannot be undone.'}
        onConfirm={handleClearMessages}
        onCancel={() => setClearMessagesConfirm(false)}
        loading={clearMessagesBusy}
        destructive
      />

      <Dialog open={backupDialogOpen} onClose={() => setBackupDialogOpen(false)} fullWidth maxWidth="sm" sx={buildDialogPaperSx()}>
        <DialogTitle>{i18n.language.startsWith('zh') ? '选择要备份的内容' : 'Choose what to back up'}</DialogTitle>
        <DialogContent sx={buildDialogScrollableContentSx()}>
          <Box sx={buildDialogContentSx()}>
            <Box sx={buildDialogTreeBodySx()}>
              <BackupTreeSection
                nodes={BACKUP_TREE}
                selection={backupSelection}
                availability={FULL_BACKUP_AVAILABILITY}
                stats={backupStats}
                expandedKeys={expandedBackupKeys}
                onToggleExpand={(key) => setExpandedBackupKeys((prev) => updateExpandedKeys(prev, key))}
                onToggleCheck={(key, checked) => setBackupSelection((prev) => getSelectionAfterToggle(prev, key, checked))}
                language={i18n.language}
              />
            </Box>
            {hasSelectedSecrets(backupSelection) ? (
              <Alert severity="error" sx={buildWarningAlertSx()}>
                {i18n.language.startsWith('zh') ? '当前勾选包含密钥明文，导出的 JSON 将写入 API 密钥。务必避免泄露、误传、截图或上传到不受控存储。' : 'The current selection includes plaintext keys. Exported JSON will contain API keys. Avoid leaks, accidental sharing, screenshots, or uploading to uncontrolled storage.'}
              </Alert>
            ) : null}
          </Box>
        </DialogContent>
        <DialogActions sx={buildDialogActionsSx()}>
          <Button onClick={() => setBackupDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleConfirmBackup} variant="contained" disabled={!hasAnySelected(backupSelection)}>{t('common.confirm')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={restoreDialogOpen} onClose={() => setRestoreDialogOpen(false)} fullWidth maxWidth="sm" sx={buildDialogPaperSx()}>
        <DialogTitle>{i18n.language.startsWith('zh') ? '选择要恢复的内容' : 'Choose what to restore'}</DialogTitle>
        <DialogContent sx={buildDialogScrollableContentSx()}>
          <Box sx={buildDialogContentSx()}>
            <Typography variant="caption" color="text.secondary" sx={buildRestoreFileNameSx()}>
              {restoreFileName}
            </Typography>
            {restoreEmptyHint ? (
              <Alert severity="warning">{restoreEmptyHint}</Alert>
            ) : null}
            <Box sx={buildDialogTreeBodySx()}>
              <BackupTreeSection
                nodes={BACKUP_TREE}
                selection={restoreSelection}
                availability={restoreAvailability}
                stats={restoreStats}
                expandedKeys={expandedRestoreKeys}
                onToggleExpand={(key) => setExpandedRestoreKeys((prev) => updateExpandedKeys(prev, key))}
                onToggleCheck={(key, checked) => setRestoreSelection((prev) => getSelectionAfterToggle(prev, key, checked, restoreAvailability))}
                language={i18n.language}
              />
            </Box>
            {hasSelectedSecrets(restoreSelection) ? (
              <Alert severity="error" sx={buildWarningAlertSx()}>
                {i18n.language.startsWith('zh') ? '当前恢复包含密钥明文，导入后本地设置会写入 API 密钥。请确认备份来源可信，并避免泄露该 JSON。' : 'The current restore includes plaintext keys. Importing will write API keys into local settings. Ensure the backup source is trusted and avoid leaking the JSON.'}
              </Alert>
            ) : null}
          </Box>
        </DialogContent>
        <DialogActions sx={buildDialogActionsSx()}>
          <Button onClick={() => setRestoreDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleConfirmRestore} variant="contained" disabled={!hasAnySelected(restoreSelection, restoreAvailability)}>{t('common.confirm')}</Button>
        </DialogActions>
      </Dialog>

      <AppSnackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        severity={snackbar.severity}
        message={snackbar.message}
      />
      <BubbleStylePickerDialog
        open={userBubblePickerOpen}
        title={i18n.language.startsWith('zh') ? '我的气泡' : 'My bubble'}
        valueStyleId={settings.userBubbleStyleId || DEFAULT_AI_BUBBLE_STYLE_ID}
        valueStyle={settings.userBubbleStyle}
        customStyles={settings.customBubbleStyles || []}
        avatar={selfAvatarValue}
        isImageAvatar={selfAvatarIsImage}
        previewText={selfBubblePreviewText}
        onClose={() => setUserBubblePickerOpen(false)}
        onConfirm={(styleId, style) => {
          settings.setUserBubbleStyle(styleId, { ...style, id: styleId });
          setUserBubblePickerOpen(false);
        }}
        onCustomStylesChange={settings.setCustomBubbleStyles}
      />
    </Box>
  );
}
