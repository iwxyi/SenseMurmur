import { useState } from 'react';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import MenuIcon from '@mui/icons-material/Menu';
import { AppBar, Box, Button, Divider, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Toolbar, Typography } from '@mui/material';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ADMIN_DASHBOARD_PERMISSIONS, ADMIN_PERMISSION_CODES, adminHasAnyPermission } from '../../constants/adminPermissions';
import { useAdminAuthStore } from '../../stores/useAdminAuthStore';

const drawerWidth = 248;

const navItems = [
  { path: '/admin', label: '总览', permissions: ADMIN_DASHBOARD_PERMISSIONS },
  { path: '/admin/users', label: '用户列表', permissions: [ADMIN_PERMISSION_CODES.usersRead] },
  { path: '/admin/usage', label: '使用记录', permissions: [ADMIN_PERMISSION_CODES.usersRead] },
  { path: '/admin/admins', label: '管理员', permissions: [ADMIN_PERMISSION_CODES.adminAll] },
  { path: '/admin/global-config', label: '全局配置', permissions: [ADMIN_PERMISSION_CODES.platformRead] },
  { path: '/admin/platform', label: '平台配置', permissions: [ADMIN_PERMISSION_CODES.platformRead, ADMIN_PERMISSION_CODES.aiRead] },
  { path: '/admin/files', label: '存储管理', permissions: [ADMIN_PERMISSION_CODES.usersRead] },
  { path: '/admin/billing', label: '会员订单', permissions: [ADMIN_PERMISSION_CODES.billingRead] },
  { path: '/admin/moderation', label: '分享审核', permissions: [ADMIN_PERMISSION_CODES.sharesReview] },
  { path: '/admin/market', label: '市场管理', permissions: [ADMIN_PERMISSION_CODES.marketRead] },
  { path: '/admin/notifications', label: '通知中心', permissions: [ADMIN_PERMISSION_CODES.notificationsRead] },
  { path: '/admin/send-records', label: '发送记录', permissions: [ADMIN_PERMISSION_CODES.notificationsRead] },
  { path: '/admin/risk', label: '风控限制', permissions: [ADMIN_PERMISSION_CODES.riskRead] },
  { path: '/admin/audit', label: '审计日志', permissions: [ADMIN_PERMISSION_CODES.auditRead] },
];

const profileNavItem = { path: '/admin/me', label: '我的' };

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const admin = useAdminAuthStore((s) => s.admin);
  const logout = useAdminAuthStore((s) => s.logout);
  const [mobileOpen, setMobileOpen] = useState(false);
  const visibleNavItems = navItems.filter((item) => adminHasAnyPermission(admin, item.permissions));
  const currentTitle = [...navItems, profileNavItem].find((item) => (item.path === '/admin' ? location.pathname === '/admin' : location.pathname.startsWith(item.path)))?.label || '后台';

  const navList = (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Toolbar>
        <Typography sx={{ fontWeight: 900 }}>后台模块</Typography>
      </Toolbar>
      <List sx={{ px: 1.25, flex: 1 }}>
        {visibleNavItems.map((item) => {
          const selected = item.path === '/admin' ? location.pathname === '/admin' : location.pathname.startsWith(item.path);
          return (
            <ListItemButton
              key={item.path}
              selected={selected}
              onClick={() => {
                navigate(item.path);
                setMobileOpen(false);
              }}
              sx={{ borderRadius: 2, mb: 0.5 }}
            >
              <ListItemText primary={item.label} />
            </ListItemButton>
          );
        })}
      </List>
      <Divider />
      <List sx={{ px: 1.25, py: 1.25 }}>
        <ListItemButton
          selected={location.pathname.startsWith(profileNavItem.path)}
          onClick={() => {
            navigate(profileNavItem.path);
            setMobileOpen(false);
          }}
          sx={{ borderRadius: 2 }}
        >
          <ListItemIcon sx={{ minWidth: 36 }}>
            <AccountCircleIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={profileNavItem.label} secondary={admin?.displayName || admin?.email || undefined} />
        </ListItemButton>
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh', bgcolor: 'background.default' }}>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{
          width: { lg: `calc(100% - ${drawerWidth}px)` },
          ml: { lg: `${drawerWidth}px` },
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Toolbar sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, px: { xs: 2, sm: 3 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, flex: 1 }}>
            <IconButton sx={{ display: { lg: 'none' } }} onClick={() => setMobileOpen(true)}>
              <MenuIcon />
            </IconButton>
            <Typography variant="subtitle1" sx={{ fontWeight: 800 }} noWrap>{currentTitle}</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, flexShrink: 0 }}>
            <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: { xs: 120, sm: 220, md: 320 } }}>
              {admin?.displayName || admin?.email || 'Admin'}
            </Typography>
            <Button onClick={() => { logout(); navigate('/admin/login', { replace: true }); }}>退出</Button>
          </Box>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{ display: { xs: 'block', lg: 'none' }, '& .MuiDrawer-paper': { width: drawerWidth, boxSizing: 'border-box' } }}
      >
        {navList}
      </Drawer>

      <Drawer
        variant="permanent"
        sx={{ display: { xs: 'none', lg: 'block' }, width: drawerWidth, flexShrink: 0, '& .MuiDrawer-paper': { width: drawerWidth, boxSizing: 'border-box' } }}
      >
        {navList}
      </Drawer>

      <Box component="main" sx={{ flex: 1, minWidth: 0, p: { xs: 2, sm: 3 }, pt: { xs: 2, sm: 3 } }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
