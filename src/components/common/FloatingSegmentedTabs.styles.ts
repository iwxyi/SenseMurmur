import type { Theme } from '@mui/material/styles';
import { motion, reducedMotionSx } from '../../styles/motion';

export function buildFloatingTabContainerSx() {
  return {
    position: 'sticky',
    top: 'var(--app-floating-tab-top, 12px)',
    zIndex: 8,
    mb: 2,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 1,
    // Keep the state change perceptible without making the control chase every
    // small scroll delta. Header hysteresis controls when this transition starts.
    transition: `top ${motion.durations.base}ms ${motion.standard}`,
  } as const;
}

export function buildFloatingTabGroupSx() {
  return {
    display: 'inline-flex',
    maxWidth: '100%',
    borderRadius: { xs: '14px', sm: '15px' },
    p: { xs: 0.45, sm: 0.5 },
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.68)' : 'rgba(16,18,26,0.62)',
    border: '1px solid',
    borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.075)' : 'rgba(226,232,240,0.095)',
    backdropFilter: 'blur(22px) saturate(1.05)',
    WebkitBackdropFilter: 'blur(22px) saturate(1.05)',
    boxShadow: (theme: Theme) => theme.palette.mode === 'light'
      ? '0 14px 34px rgba(15,23,42,0.075), 0 1px 0 rgba(255,255,255,0.86) inset'
      : '0 18px 38px rgba(0,0,0,0.30), 0 1px 0 rgba(255,255,255,0.055) inset',
    overflowX: 'auto',
    overscrollBehavior: 'contain',
    scrollbarWidth: 'none',
    '&::-webkit-scrollbar': { display: 'none' },
    ...reducedMotionSx,
  } as const;
}
