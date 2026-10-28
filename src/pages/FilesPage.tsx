import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Card, CardContent, Checkbox, Chip, CircularProgress, Dialog, DialogContent, Divider, FormControl, IconButton, InputLabel, Menu, MenuItem, Select, Slider, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import CloseIcon from '@mui/icons-material/Close';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import AudioFileOutlinedIcon from '@mui/icons-material/AudioFileOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import { api } from '../services/api';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/useAuthStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { deleteFileItems } from '../services/fileDeletion';

type Category = 'all' | 'document' | 'image' | 'sticker' | 'avatar' | 'character' | 'background' | 'chat-avatar' | 'chat-background' | 'audio' | 'table' | 'web' | 'other';
type FileItem = { id: string; name: string; url: string; mimeType: string; sizeBytes: number; kind: string; category: string; createdAt: number; deletedAt: number | null; chatId?: string; messageId?: string; attachmentId?: string; checksum?: string; characterId?: string; characterName?: string; sourceType?: string; description?: string; promptText?: string; syncStatus?: string };
const categories: Array<[Category, string]> = [['all','全部'],['document','文档'],['image','图片'],['character','形象'],['sticker','表情'],['audio','语音'],['table','表格'],['web','网页'],['other','其他']];
const ranges = [['all','不限'],['today','今天'],['week','一周内'],['month','一月内'],['halfYear','半年内'],['divider-other','其他状态'],['cloud-only','其余设备'],['unreferenced','即将删除']] as const;
const specialCategories = new Set<string>();
const hiddenFromAll = new Set(['avatar', 'background', 'chat-avatar', 'chat-background']);

function icon(category: string, name = '') {
  const marker = `${category} ${name}`.toLowerCase();
  if (/(audio|voice|语音|音频|\.mp3$|\.wav$|\.ogg$|\.m4a$)/i.test(marker)) return <AudioFileOutlinedIcon />;
  if (/(image|photo|picture|图片|照片|头像|形象|背景|表情|\.png$|\.jpe?g$|\.gif$|\.webp$|\.svg$)/i.test(marker)) return <ImageOutlinedIcon />;
  return <InsertDriveFileOutlinedIcon />;
}
function rangeStart(value: string) { const now = Date.now(); if (value === 'today') return new Date(new Date().setHours(0,0,0,0)).getTime(); if (value === 'week') return now - 7*864e5; if (value === 'month') return now - 30*864e5; if (value === 'halfYear') return now - 182*864e5; return undefined; }
function formatSize(size: number) { if (!Number.isFinite(size) || size <= 0) return '0'; return size < 1024*1024 ? `${Math.max(1, Math.round(size/1024))} KB` : `${(size/1024/1024).toFixed(1)} MB`; }
function isImageItem(item: { category: string; mimeType?: string; url?: string }) { return Boolean(item.url) && (item.mimeType?.startsWith('image/') || ['image', 'sticker', 'avatar', 'character', 'background'].includes(item.category)); }
function visualCategory(item: { category: string; sourceType?: string; kind?: string; name?: string }) {
  if (item.category === 'avatar') return /chat|group|聊天|群/.test(`${item.sourceType || ''} ${item.kind || ''} ${item.name || ''}`) ? 'chat-avatar' : 'avatar';
  if (item.category === 'background') return /chat|group|聊天|群/.test(`${item.sourceType || ''} ${item.kind || ''} ${item.name || ''}`) ? 'chat-background' : 'background';
  return item.category;
}
function formatAudioTime(value: number) { if (!Number.isFinite(value) || value < 0) return '0:00'; const minutes = Math.floor(value / 60); const seconds = Math.floor(value % 60).toString().padStart(2, '0'); return `${minutes}:${seconds}`; }

function AudioTile({ url, onOpen }: { url: string; onOpen?: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const sync = () => { setCurrentTime(audio.currentTime || 0); setDuration(Number.isFinite(audio.duration) ? audio.duration : 0); };
    const ended = () => { setPlaying(false); sync(); };
    audio.addEventListener('loadedmetadata', sync); audio.addEventListener('timeupdate', sync); audio.addEventListener('ended', ended);
    return () => { audio.removeEventListener('loadedmetadata', sync); audio.removeEventListener('timeupdate', sync); audio.removeEventListener('ended', ended); };
  }, []);
  const togglePlayback = async () => { const audio = audioRef.current; if (!audio) return; if (audio.paused) { await audio.play(); setPlaying(true); } else { audio.pause(); setPlaying(false); } };
  return <Box onClick={(event) => event.stopPropagation()} onDoubleClick={() => onOpen?.()} sx={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 0, px: 1, pt: 1, pb: .5 }}>
    <audio ref={audioRef} src={url} preload="metadata" style={{ display: 'none' }} />
    <IconButton aria-label={playing ? '暂停语音' : '播放语音'} size="small" onClick={() => void togglePlayback()} sx={{ p: .25, alignSelf: 'center', mt: .25 }}>{playing ? <PauseIcon /> : <PlayArrowIcon />}</IconButton>
    <Box sx={{ width: '78%', display: 'flex', justifyContent: 'flex-end', minHeight: 17 }}>{playing && <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{formatAudioTime(currentTime)} / {formatAudioTime(duration)}</Typography>}{!playing && duration > 0 && <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{formatAudioTime(duration)}</Typography>}</Box>
    <Slider aria-label="语音进度" size="small" value={duration ? currentTime : 0} max={duration || 1} onChange={(_, value) => { const next = Array.isArray(value) ? value[0] : value; if (audioRef.current) audioRef.current.currentTime = next; setCurrentTime(next); }} sx={{ width: '78%', py: .25, mt: -.25 }} />
  </Box>;
}

export default function FilesPage() {
  const { setHeaderTitle, setHeaderActions } = useLayoutHeaderActions();
  const navigate = useNavigate();
  const authMode = useAuthStore((state) => state.authMode);
  const cloudStorageBytes = useAuthStore((state) => state.user?.cloudStorageBytes || 0);
  const cloudStorageMembershipBytes = useAuthStore((state) => state.user?.cloudStorageMembershipBytes || 0);
  const cloudStorageAccountBytes = useAuthStore((state) => state.user?.cloudStorageAccountBytes || 0);
  const user = useAuthStore((state) => state.user);
  const cloudStorageGrants = user?.cloudStorageGrants || [];
  const [items, setItems] = useState<FileItem[]>([]);
  const [allItems, setAllItems] = useState<FileItem[]>([]);
  const [category, setCategory] = useState<Category>('all'); const [range, setRange] = useState('all'); const [selected, setSelected] = useState<string[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuItem, setMenuItem] = useState<(typeof items)[number] | null>(null);
  const [previewText, setPreviewText] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selectionAnchor = useRef<number | null>(null);
  const isUnreferenced = range === 'unreferenced';
  const isCloudOnly = range === 'cloud-only';
  const specialCategory = specialCategories.has(range) ? range : undefined;
  const load = useCallback(async () => { setLoading(true); setError(''); const messageState = useMessageStore.getState(); const localMessages = Array.from(new Map([...messageState.messages, ...Object.values(messageState.messageWindowsByChatId).flatMap((window) => window.messages)].map((message) => [message.id, message])).values()); const localMessageItems = localMessages.flatMap((message) => ((message as { metadata?: { attachments?: Array<{ id: string; assetId?: string; checksum?: string; kind: string; url?: string; mimeType?: string; sizeBytes?: number; createdAt?: number; altText?: string; caption?: string; promptText?: string }> } }).metadata?.attachments || []).filter((attachment) => attachment.url).map((attachment) => ({ id: attachment.assetId || `local-${message.id}-${attachment.id}`, attachmentId: attachment.id, checksum: attachment.checksum, name: attachment.kind === 'audio' ? '语音' : attachment.kind === 'sticker' ? '表情' : '图片', url: attachment.url || '', mimeType: attachment.mimeType || '', sizeBytes: attachment.sizeBytes || 0, kind: attachment.kind, category: attachment.kind === 'audio' ? 'audio' : attachment.kind === 'sticker' ? 'sticker' : 'image', createdAt: attachment.createdAt || message.timestamp, deletedAt: null, chatId: message.chatId, messageId: message.id, description: attachment.caption || attachment.altText, promptText: attachment.promptText, syncStatus: 'local-only' as const }))); const localVisualItems = useCharacterStore.getState().characters.flatMap((character) => (character.visualIdentity?.referenceImages || []).filter((asset) => asset.url).map((asset) => ({ id: asset.assetId || asset.id, name: character.name || '未命名角色', url: asset.url, mimeType: asset.mimeType || 'image/png', sizeBytes: asset.sizeBytes || 0, kind: 'character', category: 'character', createdAt: asset.createdAt || character.updatedAt || character.createdAt, deletedAt: null, characterId: character.id, characterName: character.name, sourceType: 'character-visual', description: asset.label || '形象图', syncStatus: 'local-only' as const }))); const localItems = [...localMessageItems, ...localVisualItems] as FileItem[]; const localReferences = localMessages.flatMap((message) => (((message as { metadata?: { attachments?: Array<{ id: string; assetId?: string; checksum?: string; url?: string; mimeType?: string; sizeBytes?: number; kind?: string }> } }).metadata?.attachments || []).map((attachment) => ({ id: attachment.assetId, attachmentId: attachment.id, checksum: attachment.checksum, url: attachment.url, chatId: message.chatId, messageId: message.id })))); const initialItems = isCloudOnly ? [] : localItems; setAllItems(initialItems); setItems(initialItems); setSelected([]); if (authMode !== 'cloud') { setLoading(false); return; } try { const serverCategory = specialCategory?.includes('avatar') ? 'avatar' : specialCategory?.includes('character') ? 'character' : specialCategory?.includes('background') ? 'background' : undefined; const result = await api.listFiles({ trash: isUnreferenced ? 'unreferenced' : false, category: serverCategory, from: isUnreferenced ? undefined : rangeStart(range), limit: 40, offset: 0 }); const findLocal = (item: (typeof result.items)[number]) => { const local = localItems.find((candidate) => candidate.id === item.id || (candidate.checksum && candidate.checksum === item.checksum) || (candidate.url && candidate.url === item.url) || (candidate.chatId === item.chatId && candidate.messageId === item.messageId && candidate.attachmentId === item.attachmentId)); if (local) return local; return localReferences.find((reference) => reference.id === item.id || (reference.checksum && reference.checksum === item.checksum) || (reference.chatId === item.chatId && reference.messageId === item.messageId && reference.attachmentId === item.attachmentId)); }; const cloudItems = result.items.map((item) => { const local = findLocal(item); return local ? { ...item, name: 'name' in local && local.name ? local.name : item.name, url: 'url' in local && local.url ? local.url : item.url, characterName: 'characterName' in local ? local.characterName || item.characterName : item.characterName, syncStatus: 'synced' as const } : isCloudOnly ? { ...item, url: '', description: undefined, promptText: undefined, syncStatus: 'cloud-only' as const } : item; }); const cloudIds = new Set(cloudItems.map((item) => item.id)); const localMatchedIds = new Set(cloudItems.filter((item) => item.syncStatus === 'synced').map((item) => findLocal(item)?.id).filter((id): id is string => Boolean(id))); const merged = isUnreferenced || isCloudOnly ? cloudItems : [...localItems.filter((item) => !localMatchedIds.has(item.id) && !cloudIds.has(item.id)), ...cloudItems]; if (specialCategory) { setAllItems((previous) => { const byId = new Map(previous.map((item) => [item.id, item])); cloudItems.forEach((item) => byId.set(item.id, item)); return Array.from(byId.values()); }); } else setAllItems(isCloudOnly ? cloudItems.filter((item) => item.syncStatus === 'cloud-only') : merged); } catch (e) { setError(e instanceof Error ? e.message : isCloudOnly ? '其余设备文件暂时无法加载' : '云端文件暂时无法加载，本地文件仍可用'); } finally { setLoading(false); } }, [authMode, isUnreferenced, isCloudOnly, specialCategory, range]);
  useEffect(() => { let cancelled = false; void (async () => { await Promise.allSettled([useMessageStore.persist.rehydrate(), useCharacterStore.persist.rehydrate()]); if (!cancelled) await load(); })(); return () => { cancelled = true; }; }, [load]);
  useEffect(() => { const activeCategory = specialCategory ? specialCategory.replace(/^visual-/, '') : category; const source = specialCategory ? allItems : allItems.filter((item) => !hiddenFromAll.has(visualCategory(item))); setItems(activeCategory === 'all' ? source : source.filter((item) => visualCategory(item) === activeCategory)); }, [allItems, category, specialCategory]);
  const activeItem = activeIndex == null ? null : items[activeIndex];
  useEffect(() => { let cancelled = false; setPreviewText(''); if (!activeItem || !activeItem.url || isImageItem(activeItem) || activeItem.category === 'audio' || activeItem.sizeBytes > 1024 * 1024 || activeItem.mimeType.includes('html')) return undefined; void fetch(activeItem.url).then((response) => response.text()).then((text) => { if (!cancelled) setPreviewText(text.slice(0, 200000)); }).catch(() => undefined); return () => { cancelled = true; }; }, [activeItem]);
  const toggle = (id: string) => setSelected((current) => { const index = items.findIndex((item) => item.id === id); if (index >= 0) selectionAnchor.current = index; return current.includes(id) ? current.filter((item) => item !== id) : [...current, id]; });
  const selectRange = (index: number) => { const anchor = selectionAnchor.current ?? index; const lo = Math.max(0, Math.min(anchor, index)); const hi = Math.min(items.length - 1, Math.max(anchor, index)); const ids = items.slice(lo, hi + 1).map((item) => item.id); setSelected((current) => { const allSelected = ids.every((id) => current.includes(id)); return allSelected ? current.filter((id) => !ids.includes(id)) : Array.from(new Set([...current, ...ids])); }); selectionAnchor.current = index; };
  useEffect(() => { const handleKeyDown = (event: KeyboardEvent) => { const target = event.target as HTMLElement | null; if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return; const modifier = event.ctrlKey || event.metaKey; if (modifier && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelectionMode(true); setSelected(items.map((item) => item.id)); return; } if (event.key === 'Escape' && selectionMode) { event.preventDefault(); setSelectionMode(false); setSelected([]); return; } if (activeIndex == null || !items.length) return; if (modifier && event.key === ' ') { event.preventDefault(); toggle(items[activeIndex].id); return; } if (event.shiftKey && (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp')) { event.preventDefault(); const next = Math.max(0, Math.min(items.length - 1, activeIndex + ((event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1 : -1))); setSelectionMode(true); selectRange(next); setActiveIndex(next); } }; window.addEventListener('keydown', handleKeyDown); return () => window.removeEventListener('keydown', handleKeyDown); }, [items, activeIndex, selectionMode]);
  const deletingRef = useRef(false);
  const doDelete = useCallback(async () => {
    if (!selected.length || deletingRef.current) return;
    deletingRef.current = true;
    let deletionError = '';
    try {
      await deleteFileItems(items.filter(item => selected.includes(item.id)));
    } catch (error) {
      deletionError = error instanceof Error ? error.message : '文件删除失败';
    } finally {
      await load();
      if (deletionError) setError(deletionError);
      deletingRef.current = false;
    }
  }, [selected, items, load]);
  const downloadItem = () => { if (!menuItem?.url) return; const link = document.createElement('a'); link.href = menuItem.url; link.download = menuItem.name || '文件'; link.target = '_blank'; link.rel = 'noreferrer'; link.click(); setMenuAnchor(null); setMenuItem(null); };
  const openCharacter = () => { if (!menuItem?.characterId) return; window.open(`/characters/${encodeURIComponent(menuItem.characterId)}/edit`, '_blank', 'noopener,noreferrer'); setMenuAnchor(null); setMenuItem(null); };
  const openChat = () => {
    if (!menuItem?.chatId) return;
    const params = new URLSearchParams();
    if (menuItem.messageId) params.set('messageId', menuItem.messageId);
    // Supplying the asset timestamp lets ChatDetailPage fetch the window
    // around older messages before resolving the explicit scroll request.
    if (menuItem.createdAt && menuItem.messageId) params.set('aroundTimestamp', String(menuItem.createdAt));
    const query = params.toString();
    const target = `/chats/${encodeURIComponent(menuItem.chatId)}${query ? `?${query}` : ''}`;
    window.open(target, '_blank', 'noopener,noreferrer');
    setMenuAnchor(null);
    setMenuItem(null);
  };
  const multiSelect = selected.length > 0 || selectionMode;
  const categoryCounts = allItems.filter((item) => !hiddenFromAll.has(visualCategory(item))).reduce<Record<string, number>>((counts, item) => { counts[item.category] = (counts[item.category] || 0) + 1; return counts; }, {});
  const visibleCategories = categories.filter(([value]) => value === 'all' || (categoryCounts[value] || 0) > 0);
  const usedBytes = allItems.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  useEffect(() => { setHeaderTitle('文件'); setHeaderActions(multiSelect ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><Typography variant="body2" color="text.secondary">{selected.length} 项 · {formatSize(items.filter((item) => selected.includes(item.id)).reduce((sum, item) => sum + item.sizeBytes, 0))}</Typography><IconButton size="small" onClick={() => { setSelectionMode(false); setSelected([]); }}><CloseIcon /></IconButton><IconButton color="error" disabled={!selected.length} onClick={() => void doDelete()}><DeleteOutlineIcon /></IconButton></Box> : null); return () => { setHeaderTitle(null); setHeaderActions(null); }; }, [setHeaderActions, setHeaderTitle, multiSelect, selected, items, doDelete]);
  const pressTimer = useRef<number | null>(null);
  const beginPress = (id: string) => { pressTimer.current = window.setTimeout(() => { if (!selectionMode) { setSelectionMode(true); toggle(id); } else selectRange(items.findIndex((item) => item.id === id)); }, 520); };
  const endPress = () => { if (pressTimer.current !== null) { window.clearTimeout(pressTimer.current); pressTimer.current = null; } };
  return <Box sx={{ maxWidth: 1160, mx: 'auto', p: { xs: 2, md: 4 }, pb: 8, '& .MuiCard-root': { opacity: 1, backgroundColor: 'background.paper' }, '& .MuiCard-root:hover': { opacity: 1, backgroundColor: 'background.paper' }, '& .MuiCard-root .MuiCheckbox-root': { width: 30, height: 30, backgroundColor: 'background.paper', borderRadius: 1, zIndex: 3 } }}>
    <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => { setMenuAnchor(null); setMenuItem(null); }}>{menuItem?.characterId && <MenuItem onClick={openCharacter}>查看角色</MenuItem>}{menuItem?.chatId && <MenuItem onClick={openChat}>查看聊天位置</MenuItem>}<MenuItem onClick={downloadItem}>下载文件</MenuItem></Menu>
    <Box sx={{ display: 'flex', gap: .7, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}><Box sx={{ display: 'flex', gap: .7, flexWrap: 'wrap', flex: 1 }}>{visibleCategories.map(([value, label]) => { const count = categoryCounts[value] || 0; return <Chip key={value} label={`${label}${value === 'all' ? '' : ` ${count}`}`} onClick={() => { setCategory(value); if (value === 'all') setRange('all'); }} color={category === value && !specialCategory ? 'primary' : 'default'} variant={category === value && !specialCategory ? 'filled' : 'outlined'} />; })}</Box><FormControl size="small" sx={{ minWidth: 120, ml: 'auto' }}><InputLabel>筛选</InputLabel><Select value={range} label="筛选" onChange={(e) => setRange(e.target.value)}>{ranges.map(([value, label]) => value.startsWith('divider-') ? <Divider key={value} /> : <MenuItem key={value} value={value}>{label}</MenuItem>)}</Select></FormControl></Box>
    {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
    {loading ? <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 240 }}><CircularProgress /></Box> : items.length === 0 ? <Card sx={{ borderRadius: 3, p: 5, textAlign: 'center' }}><Typography variant="h6">这里还没有文件</Typography><Typography color="text.secondary" sx={{ mt: 1 }}>{isUnreferenced ? '没有即将删除的悬空文件。' : '当 AI 生成图片或语音后，它们会出现在这里。'}</Typography></Card> : <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 1.5 }}>{items.map((item, index) => <Card key={item.id} onClick={() => { if (!selectionMode && item.url) setActiveIndex(index); }} onContextMenu={(e) => { e.preventDefault(); if (selectionMode) selectRange(index); else { setSelectionMode(true); toggle(item.id); } }} onPointerDown={() => beginPress(item.id)} onPointerUp={endPress} onPointerLeave={endPress} sx={{ position: 'relative', borderRadius: 2.5, cursor: item.url ? 'pointer' : 'default', transition: 'transform .2s, box-shadow .2s', '&:hover': { transform: 'translateY(-3px)', boxShadow: 6 } }}><CardContent sx={{ p: 1.5 }}>{selectionMode && <Checkbox size="small" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} onClick={(e) => e.stopPropagation()} sx={{ position: 'absolute', top: 10, left: 10, zIndex: 2, p: .2, bgcolor: 'background.paper', borderRadius: 1 }} />}<Box sx={{ display: 'flex', alignItems: 'center', gap: .6, minWidth: 0, mb: .8, pr: 1 }}><Box sx={{ display: 'grid', placeItems: 'center', color: 'primary.main' }}>{icon(item.category, item.name)}</Box><Typography noWrap sx={{ fontWeight: 600, fontSize: '0.9rem', lineHeight: 1.35, minWidth: 0 }}>{item.name}</Typography>{!isCloudOnly && (item.url || item.category === 'audio' || item.characterId) && <IconButton aria-label="文件菜单" size="small" onClick={(e) => { e.stopPropagation(); setMenuAnchor(e.currentTarget); setMenuItem(item); }} sx={{ ml: 'auto', p: .25 }}><MoreVertIcon fontSize="small" /></IconButton>}</Box><Box sx={{ width: '100%', aspectRatio: '1 / 1', height: 'auto', display: 'grid', placeItems: 'center', overflow: 'hidden', borderRadius: 1.5, bgcolor: 'action.hover', color: 'primary.main' }}>{isImageItem(item) ? <Box component="img" src={item.url} alt={item.name} sx={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }} /> : item.category === 'audio' && item.url ? <AudioTile url={item.url} onOpen={() => setActiveIndex(index)} /> : !item.url ? <HelpOutlineIcon sx={{ fontSize: 42, color: 'text.disabled' }} /> : icon(item.category, item.name)}</Box>{item.description && !isCloudOnly && <Typography variant="caption" color="text.secondary" sx={{ display: "-webkit-box", mt: .8, minHeight: '2.6em', lineHeight: 1.3, overflow: 'hidden', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{item.description}</Typography>}<Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: item.description ? .35 : .8 }}>{formatSize(item.sizeBytes)} · {new Date(item.createdAt).toLocaleDateString()}</Typography></CardContent></Card>)}</Box>}
    <Box title={`基础容量：${formatSize(Math.max(0, cloudStorageBytes - cloudStorageMembershipBytes - cloudStorageAccountBytes))}\n会员赠送容量：${formatSize(cloudStorageMembershipBytes)}\n用户额外容量：${formatSize(cloudStorageAccountBytes)}\n容量包：${cloudStorageGrants.length ? cloudStorageGrants.map((grant) => `${formatSize(grant.bytes)}${grant.expiresAt ? `（至 ${new Date(grant.expiresAt).toLocaleDateString()}）` : '（永久）'}`).join('\n') : '暂无'}`} sx={{ position: 'fixed', right: { xs: 16, md: 28 }, bottom: { xs: 16, md: 24 }, zIndex: 10, px: 1.5, py: 1, borderRadius: 2, bgcolor: (theme) => theme.palette.mode === 'dark' ? 'rgba(24, 28, 36, .68)' : 'rgba(255,255,255,.68)', backdropFilter: 'blur(18px) saturate(1.15)', WebkitBackdropFilter: 'blur(18px) saturate(1.15)', boxShadow: '0 10px 30px rgba(15,23,42,.14)', border: '1px solid', borderColor: (theme) => theme.palette.mode === 'dark' ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.72)' }}><Typography variant="caption" color="text.secondary">容量：{formatSize(usedBytes)} / {formatSize(cloudStorageBytes)} <Typography component="span" color="primary.main" sx={{ ml: .75, cursor: 'pointer', fontWeight: 600, fontSize: 'inherit' }} onClick={() => navigate('/membership')}>扩容</Typography></Typography></Box>
    <Dialog open={activeItem !== null && !isCloudOnly} onClose={() => setActiveIndex(null)} maxWidth="md" fullWidth><DialogContent sx={{ p: 1.5, minHeight: 320, position: 'relative' }}>{activeItem && !isCloudOnly && <><IconButton onClick={() => setActiveIndex((index) => index == null ? null : (index - 1 + items.length) % items.length)} sx={{ position: 'absolute', left: 8, top: '50%', zIndex: 2 }}><ChevronLeftIcon /></IconButton><IconButton onClick={() => setActiveIndex((index) => index == null ? null : (index + 1) % items.length)} sx={{ position: 'absolute', right: 8, top: '50%', zIndex: 2 }}><ChevronRightIcon /></IconButton><Box sx={{ px: 5, py: 2 }}>{activeItem.characterName && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, cursor: "pointer" }} onClick={() => navigate(`/characters/${activeItem.characterId}/edit`)}>角色：{activeItem.characterName}</Typography>}{activeItem.promptText && <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>提示词：{activeItem.promptText}</Typography>}{activeItem.description && <Typography variant="body2" sx={{ mb: 1 }}>{activeItem.description}</Typography>}{isImageItem(activeItem) ? <Box component="img" src={activeItem.url} alt={activeItem.name} sx={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', mx: 'auto', objectFit: 'contain' }} /> : activeItem.category === 'audio' ? <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 220 }}><audio ref={audioRef} src={activeItem.url} controls autoPlay style={{ width: '100%' }} /></Box> : activeItem.mimeType.includes('html') ? <Box component="iframe" src={activeItem.url} title={activeItem.name} sandbox="allow-scripts" sx={{ width: '100%', height: '65vh', border: 0 }} /> : <Box component="pre" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '65vh', overflow: 'auto', m: 0, fontFamily: 'inherit' }}>{previewText || '正在加载预览…'}</Box>}</Box></>}</DialogContent></Dialog>
  </Box>;
}
