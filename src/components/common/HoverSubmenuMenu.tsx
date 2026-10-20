import { useEffect, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Box, MenuItem, MenuList, Typography } from '@mui/material';

export interface HoverSubmenuItem {
  id: string;
  label: ReactNode;
  submenu: ReactNode;
  disabled?: boolean;
}

interface HoverSubmenuMenuProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  items: HoverSubmenuItem[];
}

const surfaceSx = {
  zIndex: 1400,
  minWidth: 150,
  p: 0.25,
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 1,
  bgcolor: 'background.paper',
  color: 'text.primary',
  boxShadow: (theme: { palette: { menuShadow?: string } }) => theme.palette.menuShadow || '0 12px 34px rgba(15,23,42,0.16)',
  backdropFilter: 'blur(22px) saturate(1.18)',
  WebkitBackdropFilter: 'blur(22px) saturate(1.18)',
  animation: 'menuSurfaceIn 100ms cubic-bezier(0.22, 1, 0.36, 1)',
  '@keyframes menuSurfaceIn': { from: { opacity: 0, transform: 'scale(0.98)' }, to: { opacity: 1, transform: 'scale(1)' } },
  '@media (min-width: 900px)': {
    minWidth: 140,
    p: 0.125,
  },
};

/** 基于 Radix 的项目级悬浮级联菜单，统一处理焦点、键盘、碰撞定位和关闭行为。 */
export default function HoverSubmenuMenu({ anchorEl, open, onClose, items }: HoverSubmenuMenuProps) {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!anchorEl) return;
    const update = () => setAnchorRect(anchorEl.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl]);

  return (
    <DropdownMenu.Root modal={false} open={open && Boolean(anchorRect)} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DropdownMenu.Trigger asChild>
        <Box component="span" tabIndex={-1} aria-hidden sx={{ position: 'fixed', left: anchorRect?.left ?? -9999, top: anchorRect?.bottom ?? -9999, width: 2, height: 2, opacity: 0.001, pointerEvents: 'auto' }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content asChild forceMount side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Box sx={surfaceSx}>
            <MenuList disablePadding>
            {items.map((item) => (
              <DropdownMenu.Sub key={item.id}>
                <DropdownMenu.SubTrigger asChild disabled={item.disabled}>
                  <MenuItem sx={{
                    minWidth: 150,
                    display: 'flex',
                    alignItems: 'center',
                    py: 0.75,
                    '@media (min-width: 900px)': { minWidth: 140, py: 0.5 },
                  }}>
                    <Typography component="span" sx={{ flex: 1 }}>{item.label}</Typography>
                    <Box component="span" sx={{ ml: 2, color: 'text.disabled', lineHeight: 1 }}>›</Box>
                  </MenuItem>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent asChild sideOffset={8} collisionPadding={8}>
                    <Box sx={{ ...surfaceSx, minWidth: 190 }}>
                      <MenuList disablePadding>{item.submenu}</MenuList>
                    </Box>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            ))}
            </MenuList>
          </Box>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
