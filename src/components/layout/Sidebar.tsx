import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  IconButton,
  Divider,
  Tooltip,
  Avatar,
} from '@mui/material';
import { Fragment } from 'react';
import CollapseIcon from '@mui/icons-material/ChevronLeft';
import ExpandIcon from '@mui/icons-material/ChevronRight';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useResponsive } from '../../hooks/useResponsive';
import { useUIStore } from '../../stores/useUIStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { motion, transition } from '../../styles/motion';
import { isImageAvatar } from '../../utils/avatar';
import AnimatedNavIcon, { type AnimatedNavIconKind } from './AnimatedNavIcon';
import { buildSettingsPath } from '../../routes/settingsRoute';
import { DefaultUserAvatarIcon } from '../common/IdentityIcons';

interface SidebarProps {
  collapsed: boolean;
}

type NavItem = { path: string; iconKind: AnimatedNavIconKind; labelKey: string };

const navSections: NavItem[][] = [
  [
    { path: '/', iconKind: 'home', labelKey: 'nav.home' },
    { path: '/chats', iconKind: 'chats', labelKey: 'nav.chats' },
    { path: '/characters', iconKind: 'characters', labelKey: 'nav.characters' },
    { path: '/files', iconKind: 'files', labelKey: 'nav.files' },
  ],
  [
    { path: '/moments', iconKind: 'moments', labelKey: 'nav.moments' },
    { path: '/calendar', iconKind: 'calendar', labelKey: 'nav.calendar' },
    { path: '/letters', iconKind: 'letters', labelKey: 'nav.letters' },
  ],
  [
    { path: buildSettingsPath({ tab: 'models' }), iconKind: 'models', labelKey: 'nav.models' },
    { path: '/ai-proxy', iconKind: 'proxy', labelKey: 'nav.aiProxy' },
    { path: '/market', iconKind: 'market', labelKey: 'nav.market' },
    { path: '/membership', iconKind: 'membership', labelKey: 'nav.membership' },
  ],
];

const introNavItem: NavItem = { path: '/intro', iconKind: 'intro', labelKey: 'nav.intro' };
const settingsNavItem: NavItem = { path: '/settings', iconKind: 'settings', labelKey: 'nav.settings' };

export default function Sidebar({ collapsed }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { isDesktop } = useResponsive();
  const { toggleSidebar, setSidebarOpen } = useUIStore(useShallow((state) => ({
    toggleSidebar: state.toggleSidebar,
    setSidebarOpen: state.setSidebarOpen,
  })));
  const user = useAuthStore((state) => state.user);
  const authMode = useAuthStore((state) => state.authMode);
  const isAccountActive = location.pathname.startsWith('/account');
  const accountTitle = user?.nickname || (authMode === 'cloud' ? t('nav.account') : t('nav.localMode'));
  const accountSubtitle = user?.phone || (authMode === 'cloud' ? t('nav.account') : t('nav.signInSync'));
  const accountAvatar = user?.avatar?.trim() === '🍵' ? '' : user?.avatar;
  const visibleNavSections = navSections
    .map((section) => section.filter((item) => {
      if (item.path === '/ai-proxy') return user?.aiProxyEntitled === true;
      if (item.path === '/market') return user?.marketAccessEntitled === true;
      return true;
    }))
    .filter((section) => section.length > 0);

  const handleNav = (path: string) => {
    navigate(path);
    if (!isDesktop) {
      setSidebarOpen(false);
    }
  };

  const renderNavItem = (item: NavItem) => {
    const isActive =
      item.path === '/'
        ? location.pathname === '/'
        : item.path.startsWith('/settings?tab=models')
          ? location.pathname === '/settings' && new URLSearchParams(location.search).get('tab') === 'models'
          : location.pathname.startsWith(item.path);

    const button = (
      <ListItemButton
        className="PneumataNavButton"
        key={item.path}
        onClick={() => handleNav(item.path)}
        selected={isActive}
        sx={{
          position: 'relative',
          borderRadius: 1,
          mb: 0.65,
          justifyContent: collapsed ? 'center' : 'flex-start',
          px: collapsed ? 1 : 1.35,
          minHeight: 46,
          overflow: 'hidden',
          color: isActive ? 'text.primary' : 'text.secondary',
          border: '1px solid',
          borderColor: isActive ? 'primary.main' : 'transparent',
          bgcolor: isActive ? (theme) => `${theme.palette.primary.main}1A` : 'transparent',
          transition: transition(['background-color', 'border-color', 'color'], 220, motion.softOut),
          '&::before': collapsed ? undefined : {
            content: '""',
            position: 'absolute',
            left: 0,
            top: 10,
            bottom: 10,
            width: 3,
            borderRadius: 999,
            bgcolor: isActive ? 'primary.main' : 'transparent',
            transition: transition(['background-color'], 220, motion.softOut),
          },
          '&:hover': {
            bgcolor: isActive ? (theme) => `${theme.palette.primary.main}1F` : 'rgba(148,163,184,0.08)',
            borderColor: isActive ? 'primary.main' : 'rgba(148,163,184,0.10)',
          },
          '&.Mui-selected': {
            bgcolor: (theme) => `${theme.palette.primary.main}1A`,
          },
          '&.Mui-selected:hover': {
            bgcolor: (theme) => `${theme.palette.primary.main}1F`,
          },
        }}
      >
        <ListItemIcon
          sx={{
            minWidth: collapsed ? 0 : 42,
            color: isActive ? 'primary.main' : 'text.secondary',
            transition: transition(['color', 'transform'], 220, motion.spring),
            transform: isActive ? 'scale(1.04)' : 'none',
          }}
        >
          <AnimatedNavIcon kind={item.iconKind} active={isActive} />
        </ListItemIcon>
        {!collapsed && (
          <ListItemText
            primary={
              <Typography sx={{ fontSize: 14, fontWeight: isActive ? 760 : 560, letterSpacing: 0 }}>
                {t(item.labelKey)}
              </Typography>
            }
          />
        )}
      </ListItemButton>
    );

    return collapsed ? (
      <Tooltip key={item.path} title={t(item.labelKey)} placement="right">
        {button}
      </Tooltip>
    ) : (
      button
    );
  };

  const renderUtilityItem = (item: NavItem) => {
    const isActive = item.path === '/settings'
      ? location.pathname === '/settings' && new URLSearchParams(location.search).get('tab') !== 'models'
      : location.pathname.startsWith(item.path);
    const button = (
      <ListItemButton
        className="PneumataNavButton"
        key={item.path}
        onClick={() => handleNav(item.path)}
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: collapsed ? 42 : 50,
          borderRadius: 1,
          px: collapsed ? 0.5 : 0.75,
          py: 0.6,
          display: 'flex',
          flexDirection: collapsed ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: collapsed ? 0 : 0.35,
          color: isActive ? 'primary.main' : 'text.secondary',
          border: '1px solid',
          borderColor: isActive ? 'primary.main' : 'transparent',
          bgcolor: isActive ? (theme) => `${theme.palette.primary.main}1A` : 'transparent',
          transition: transition(['background-color', 'border-color', 'color', 'transform'], 220, motion.softOut),
          '&:hover': {
            transform: 'translateY(-1px)',
            bgcolor: isActive ? (theme) => `${theme.palette.primary.main}1F` : 'rgba(148,163,184,0.08)',
            borderColor: isActive ? 'primary.main' : 'rgba(148,163,184,0.14)',
          },
        }}
      >
        <AnimatedNavIcon kind={item.iconKind} active={isActive} />
        {!collapsed ? (
          <Typography variant="caption" noWrap sx={{ fontSize: 11, fontWeight: isActive ? 760 : 650, lineHeight: 1.1, letterSpacing: 0 }}>
            {t(item.labelKey)}
          </Typography>
        ) : null}
      </ListItemButton>
    );
    return (
      <Tooltip key={item.path} title={t(item.labelKey)} placement={collapsed ? 'right' : 'top'}>
        {button}
      </Tooltip>
    );
  };

  const accountButton = (
    <ListItemButton
      onClick={() => handleNav('/account')}
      selected={isAccountActive}
      sx={{
        borderRadius: 1,
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: collapsed ? 0 : 1.15,
        px: collapsed ? 0.75 : 1,
        py: collapsed ? 0.75 : 0.95,
        minHeight: collapsed ? 42 : 50,
        minWidth: 0,
        border: '1px solid',
        borderColor: isAccountActive ? 'primary.main' : 'transparent',
        bgcolor: isAccountActive ? (theme) => `${theme.palette.primary.main}1A` : 'transparent',
        transition: transition(['background-color', 'border-color', 'transform'], 220, motion.softOut),
        '&:hover': {
          transform: collapsed ? 'none' : 'translateX(2px)',
          bgcolor: isAccountActive ? (theme) => `${theme.palette.primary.main}1F` : 'rgba(148,163,184,0.08)',
          borderColor: isAccountActive ? 'primary.main' : 'rgba(148,163,184,0.12)',
        },
        '&.Mui-selected': {
          bgcolor: (theme) => `${theme.palette.primary.main}1A`,
        },
        '&.Mui-selected:hover': {
          bgcolor: (theme) => `${theme.palette.primary.main}1F`,
        },
      }}
    >
      <Avatar
        src={isImageAvatar(accountAvatar) ? accountAvatar : undefined}
        sx={{
          width: 36,
          height: 36,
          borderRadius: 1,
          bgcolor: isImageAvatar(accountAvatar) || !accountAvatar?.trim() ? 'transparent' : isAccountActive ? 'primary.main' : 'action.hover',
          color: isAccountActive ? 'primary.contrastText' : 'text.secondary',
          fontWeight: 820,
          fontSize: 16,
          flex: '0 0 auto',
        }}
      >
        {isImageAvatar(accountAvatar) ? undefined : (accountAvatar?.trim().slice(0, 2) || <DefaultUserAvatarIcon title={accountTitle || 'User'} />)}
      </Avatar>
      {!collapsed ? (
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 820, lineHeight: 1.12, letterSpacing: 0 }}>
            {accountTitle}
          </Typography>
          <Typography variant="caption" noWrap sx={{ display: 'block', color: 'text.secondary', opacity: 0.78, mt: 0.25 }}>
            {accountSubtitle}
          </Typography>
        </Box>
      ) : null}
    </ListItemButton>
  );

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(10,10,15,0.78)',
        backdropFilter: 'blur(24px) saturate(1.12)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.12)',
        borderRight: 1,
        borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.09)',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          flexDirection: collapsed ? 'column' : 'row',
          px: collapsed ? 1 : 1.4,
          py: collapsed ? 1 : 1.2,
          minHeight: collapsed ? 94 : 72,
          gap: collapsed ? 0.7 : 1,
        }}
      >
        {collapsed ? (
          <Tooltip title={`${accountTitle}${accountSubtitle ? ` · ${accountSubtitle}` : ''}`} placement="right">
            {accountButton}
          </Tooltip>
        ) : accountButton}
        {!collapsed && (
          <IconButton size="small" onClick={toggleSidebar} sx={{ borderRadius: 2, color: 'text.secondary' }}>
            <CollapseIcon />
          </IconButton>
        )}
        {collapsed && (
          <IconButton size="small" onClick={toggleSidebar} sx={{ borderRadius: 2, color: 'text.secondary' }}>
            <ExpandIcon />
          </IconButton>
        )}
      </Box>

      <Divider sx={{ mx: collapsed ? 1.2 : 1.5, borderColor: 'rgba(148,163,184,0.14)' }} />

      <List sx={{ flex: 1, px: collapsed ? 0.65 : 1.1, pt: 1.15 }}>
        {visibleNavSections.map((section, sectionIndex) => (
          <Fragment key={section.map((item) => item.path).join('|')}>
            {sectionIndex > 0 ? (
              <Divider
                sx={{
                  mx: collapsed ? 0.65 : 0.35,
                  my: 0.75,
                  borderColor: 'rgba(148,163,184,0.14)',
                }}
              />
            ) : null}
            {section.map(renderNavItem)}
          </Fragment>
        ))}
      </List>
      <Box sx={{ px: collapsed ? 0.65 : 1.1, pb: 1.4 }}>
        <Divider sx={{ mb: 1, borderColor: 'rgba(148,163,184,0.14)' }} />
        {collapsed ? (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            {renderUtilityItem(settingsNavItem)}
          </Box>
        ) : (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'stretch',
              justifyContent: 'center',
              gap: 0.75,
              position: 'relative',
              '&::before': {
                content: '""',
                position: 'absolute',
                top: 7,
                bottom: 7,
                left: '50%',
                width: '1px',
                bgcolor: 'rgba(148,163,184,0.16)',
                transform: 'translateX(-0.5px)',
              },
            }}
          >
            {renderUtilityItem(settingsNavItem)}
            {renderUtilityItem(introNavItem)}
          </Box>
        )}
      </Box>
    </Box>
  );
}
