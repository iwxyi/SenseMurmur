import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Alert, Box, Button, Card, CardContent, Checkbox, Dialog, DialogContent, IconButton, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import AudioFileOutlinedIcon from '@mui/icons-material/AudioFileOutlined';
import { adminApi } from '../../services/adminApi';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import StorageSettingsDialog from '../../components/admin/StorageSettingsDialog';
import { ADMIN_PERMISSION_CODES, adminHasPermission } from '../../constants/adminPermissions';
import { useAdminAuthStore } from '../../stores/useAdminAuthStore';

const size = (n: number) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const isImage = (file: Record<string, unknown>) => String(file.mimeType || '').startsWith('image/');
const isAudio = (file: Record<string, unknown>) => String(file.mimeType || '').startsWith('audio/');
function fileIcon(file: Record<string, unknown>) { return isImage(file) ? <ImageOutlinedIcon /> : isAudio(file) ? <AudioFileOutlinedIcon /> : <InsertDriveFileOutlinedIcon />; }

export default function AdminCloudStoragePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canManageStorage = adminHasPermission(useAdminAuthStore((state) => state.admin), ADMIN_PERMISSION_CODES.platformManage);
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [files, setFiles] = useState<Array<Record<string, unknown>>>([]);
  const [user, setUser] = useState<Record<string, unknown> | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => { try { setLoading(true); const result = await adminApi.getCloudStorageOverview(); setUsers(result.items); } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  const open = async (item: Record<string, unknown>) => { setUser(item); setPreviewIndex(null); setSelected([]); setAnchor(null); try { const result = await adminApi.getCloudStorageUserFiles(String(item.id)); setFiles(result.items); } catch (e) { setError(e instanceof Error ? e.message : '文件加载失败'); } };
  const remove = async (ids: string[]) => { if (!ids.length) return; try { await Promise.all(ids.map((id) => adminApi.deleteCloudStorageFile(id))); setSelected([]); if (user) await open(user); await load(); } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); } };
  const toggle = (index: number, event: MouseEvent) => { const id = String(files[index].id); setAnchor(index); if (event.shiftKey && anchor !== null) { const lo = Math.min(anchor, index); const hi = Math.max(anchor, index); setSelected(files.slice(lo, hi + 1).map((file) => String(file.id))); return; } if (event.ctrlKey || event.metaKey) { setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); return; } setSelected([id]); };
  const toggleCheckbox = (index: number, event: MouseEvent) => { const id = String(files[index].id); setAnchor(index); if (event.shiftKey && anchor !== null) { const lo = Math.min(anchor, index); const hi = Math.max(anchor, index); setSelected(files.slice(lo, hi + 1).map((file) => String(file.id))); return; } setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); };
  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!files.length) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(files.map((file) => String(file.id))); setAnchor(0); return; }
    if (event.key === 'Escape') { event.preventDefault(); setSelected([]); setAnchor(null); return; }
    if (focusedIndex === null || !event.shiftKey || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); const next = Math.max(0, Math.min(files.length - 1, focusedIndex + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1))); const base = anchor ?? focusedIndex; const lo = Math.min(base, next); const hi = Math.max(base, next); const ids = files.slice(lo, hi + 1).map((file) => String(file.id)); setSelected((current) => ids.every((id) => current.includes(id)) ? current.filter((id) => !ids.includes(id)) : Array.from(new Set([...current, ...ids]))); setFocusedIndex(next);
  };
  const preview = previewIndex === null ? null : files[previewIndex];
  const selectedSize = useMemo(() => files.filter((file) => selected.includes(String(file.id))).reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0), [files, selected]);
  return <Box sx={{ mt: -1 }}>
    {canManageStorage && <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}><Button size="small" variant="outlined" startIcon={<SettingsOutlinedIcon />} onClick={() => setSettingsOpen(true)}>存储设置</Button></Box>}
    <StorageSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
    <Card><CardContent sx={{ p: 0 }}><Table><TableHead><TableRow><TableCell>用户</TableCell><TableCell>账号</TableCell><TableCell>空间占用</TableCell></TableRow></TableHead><TableBody>{users.map((item) => <TableRow hover key={String(item.id)} onClick={() => void open(item)} sx={{ cursor: 'pointer' }}><TableCell>{String(item.nickname || '未命名')}</TableCell><TableCell>{String(item.phone || '')}</TableCell><TableCell>{size(Number(item.usedBytes || 0))} / {size(Number(item.totalBytes || 0))}</TableCell></TableRow>)}</TableBody></Table>{loading && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 2 }}>加载中…</Typography>}</CardContent></Card>
    <Dialog open={Boolean(user)} onClose={() => setUser(null)} maxWidth="lg" fullWidth><DialogContent sx={{ p: 2 }}>
      <Box sx={{ position: 'sticky', top: -16, zIndex: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, py: 1, bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider' }}><Typography variant="h6">{String(user?.nickname || user?.id || '用户')} · 文件</Typography>{<Box sx={{ display: 'flex', alignItems: 'center', gap: .75 }}>{selected.length > 0 && <Typography variant="body2" color="text.secondary">已选 {selected.length} 项 · {size(selectedSize)}</Typography>}<Button size="small" onClick={() => { setSelected(files.map((file) => String(file.id))); setAnchor(files.length ? 0 : null); }} disabled={!files.length}>全选</Button><Button size="small" onClick={() => { const ids = new Set(selected); setSelected(files.filter((file) => !ids.has(String(file.id))).map((file) => String(file.id))); }} disabled={!files.length}>反选</Button><IconButton color="error" disabled={!selected.length} onClick={() => void remove(selected)}><DeleteOutlineIcon /></IconButton></Box>}</Box>
      {files.length === 0 ? <Typography color="text.secondary">暂无文件</Typography> : <Box tabIndex={0} onKeyDown={handleGridKeyDown} sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 1.5, outline: 'none' }}>{files.map((file, index) => <Card key={String(file.id)} tabIndex={0} onFocus={() => setFocusedIndex(index)} onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey) toggle(index, event); else setPreviewIndex(index); }} sx={{ position: 'relative', cursor: 'pointer', borderRadius: 2, outline: selected.includes(String(file.id)) ? '2px solid' : 'none', outlineColor: 'primary.main' }}><Checkbox checked={selected.includes(String(file.id))} onClick={(event) => { event.stopPropagation(); toggleCheckbox(index, event); }} sx={{ position: 'absolute', top: 4, left: 4, zIndex: 2, bgcolor: 'background.paper', borderRadius: 1 }} /><CardContent sx={{ p: 1.25 }}><Box sx={{ height: 130, display: 'grid', placeItems: 'center', overflow: 'hidden', borderRadius: 1.5, bgcolor: 'action.hover' }}>{isImage(file) ? <Box component="img" src={String(file.url)} alt={String(file.kind || '图片')} sx={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : isAudio(file) ? <AudioFileOutlinedIcon sx={{ fontSize: 52, color: 'primary.main' }} /> : fileIcon(file)}</Box><Typography noWrap sx={{ mt: 1, fontWeight: 600 }}>{String(file.kind || '文件')}</Typography><Typography variant="caption" color="text.secondary">{size(Number(file.sizeBytes || 0))}</Typography></CardContent></Card>)}</Box>}
    </DialogContent></Dialog>
    <Dialog open={preview !== null} onClose={() => setPreviewIndex(null)} maxWidth="lg" fullWidth><DialogContent sx={{ position: 'relative', minHeight: 360, display: 'grid', placeItems: 'center' }}>{preview && <><IconButton onClick={() => setPreviewIndex((index) => index === null ? null : (index - 1 + files.length) % files.length)} sx={{ position: 'absolute', left: 8, top: '50%' }}><ChevronLeftIcon /></IconButton><IconButton onClick={() => setPreviewIndex((index) => index === null ? null : (index + 1) % files.length)} sx={{ position: 'absolute', right: 8, top: '50%' }}><ChevronRightIcon /></IconButton>{isImage(preview) ? <Box component="img" src={String(preview.url)} alt={String(preview.kind || '图片')} sx={{ maxWidth: '90%', maxHeight: '75vh', objectFit: 'contain' }} /> : isAudio(preview) ? <Box component="audio" src={String(preview.url)} controls autoPlay sx={{ width: '80%' }} /> : <Box component="iframe" src={String(preview.url)} title="文件预览" sx={{ width: '90%', height: '70vh', border: 0 }} />}</>}</DialogContent></Dialog>
  </Box>;
}
