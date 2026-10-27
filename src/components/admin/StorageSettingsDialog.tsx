import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, LinearProgress, Menu, MenuItem, Stack, Tab, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import CloseIcon from '@mui/icons-material/Close';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import RestoreIcon from '@mui/icons-material/Restore';
import { adminApi, type StorageBucketConfig, type StorageDestination, type StorageMigration, type StorageMigrationIssue } from '../../services/adminApi';

const emptyConfig: StorageBucketConfig = { bucket: '', region: '', endpoint: '', prefix: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false };
const newStorage = (provider: StorageDestination['provider'] = 'tencent-cos'): StorageDestination => ({ id: 'new', name: '', provider, config: { ...emptyConfig }, isDefault: false, hasCredentials: false });
const statusLabel = { pending: '等待中', running: '迁移中', completed: '已完成', failed: '部分失败' };

export default function StorageSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<StorageDestination[]>([]);
  const [draft, setDraft] = useState<StorageDestination | null>(null);
  const [jobs, setJobs] = useState<StorageMigration[]>([]);
  const [jobsHasMore, setJobsHasMore] = useState(false);
  const [issuesJob, setIssuesJob] = useState<string | null>(null);
  const [issues, setIssues] = useState<StorageMigrationIssue[]>([]);
  const [issuesHasMore, setIssuesHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [actionsMenu, setActionsMenu] = useState<HTMLElement | null>(null);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationTab, setMigrationTab] = useState<'new' | 'history'>('new');
  const [sourceId, setSourceId] = useState('local');
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<'copy' | 'move'>('move');
  const [switchReferences, setSwitchReferences] = useState(true);
  const [conflict, setConflict] = useState<'overwrite' | 'skip' | 'coexist'>('overwrite');
  const [confirm, setConfirm] = useState<'delete' | 'migrate' | 'discard' | null>(null);
  const [nextTab, setNextTab] = useState('local');
  const [nextProvider, setNextProvider] = useState<StorageDestination['provider']>('tencent-cos');
  const reload = useCallback(async (selected?: string) => {
    const [stores, migrations] = await Promise.all([adminApi.getStorageDestinations(), adminApi.getStorageMigrations()]);
    const visible = stores.items.filter((item) => !item.archivedAt);
    setItems(visible); setJobs(migrations.items); setJobsHasMore(migrations.hasMore);
    if (selected) setDraft(visible.find((item) => item.id === selected) || visible[0] || null);
  }, []);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError(''); setSuccess(''); setDraft(null); setConfirm(null); setMigrationOpen(false); setMigrationTab('new'); setActionsMenu(null); setMenu(null); setIssuesJob(null); setIssues([]);
    Promise.all([adminApi.getStorageDestinations(), adminApi.getStorageMigrations()]).then(([stores, migrations]) => {
      if (!active) return;
      const visible = stores.items.filter((item) => !item.archivedAt);
      const initial = visible.find((item) => item.isDefault) || visible.find((item) => item.id === 'local') || visible[0] || null;
      setItems(visible); setJobs(migrations.items); setJobsHasMore(migrations.hasMore); setDraft(initial); setSourceId('local'); setTargetId(visible.find((item) => item.id !== 'local')?.id || '');
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : '加载存储配置失败'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open]);
  const running = jobs.some((job) => job.status === 'pending' || job.status === 'running');
  useEffect(() => {
    if (!open || !running) return;
    let active = true;
    const timer = window.setInterval(() => {
      void adminApi.getStorageMigrations().then((result) => { if (active) setJobs((current) => [...result.items, ...current.filter((job) => !result.items.some((newJob) => newJob.id === job.id))]); }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : '迁移进度加载失败'); });
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [open, running]);
  async function act(operation: () => Promise<void>, message: string) {
    setBusy(true); setError(''); setSuccess('');
    try { await operation(); setSuccess(message); } catch (e) { setConfirm(null); setError(e instanceof Error ? e.message : '存储操作失败'); } finally { setBusy(false); }
  }
  async function toggleIssues(id: string) {
    if (issuesJob === id) { setIssuesJob(null); return; }
    setBusy(true); setError('');
    try { const result = await adminApi.getStorageMigrationIssues(id); setIssues(result.items); setIssuesHasMore(result.hasMore); setIssuesJob(id); }
    catch (e) { setError(e instanceof Error ? e.message : '加载迁移明细失败'); }
    finally { setBusy(false); }
  }
  function config(key: keyof StorageBucketConfig, value: string | boolean) { setDraft((current) => current ? { ...current, config: { ...current.config, [key]: value } } : null); }
  const saved = Boolean(draft && draft.id !== 'new');
  const selected = items.find((item) => item.id === draft?.id);
  const dirty = draft?.id === 'new' || Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));
  const changeBlocked = busy || loading;
  function switchTab(id: string, provider: StorageDestination['provider'] = 'tencent-cos') {
    if (dirty) { setNextTab(id); setNextProvider(provider); setConfirm('discard'); return; }
    setDraft(id === 'new' ? newStorage(provider) : items.find((item) => item.id === id) || null); setError(''); setSuccess('');
  }
  function close() { if (dirty) { setNextTab('close'); setConfirm('discard'); } else onClose(); }
  const canMigrate = !changeBlocked && !running && items.some((item) => item.id === sourceId) && items.some((item) => item.id === targetId) && sourceId !== targetId;

  return <Dialog open={open} onClose={busy ? undefined : close} maxWidth="md" fullWidth scroll="paper">
    <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1 }}>存储设置<Box sx={{ display: 'flex' }}><Tooltip title="更多操作"><span><IconButton aria-label="存储设置菜单" disabled={changeBlocked} onClick={(event) => setActionsMenu(event.currentTarget)}><MoreVertIcon /></IconButton></span></Tooltip><IconButton aria-label="关闭存储设置" onClick={close} disabled={busy}><CloseIcon /></IconButton></Box></DialogTitle>
    <Menu anchorEl={actionsMenu} open={Boolean(actionsMenu)} onClose={() => setActionsMenu(null)}><MenuItem onClick={() => { setActionsMenu(null); setError(''); setSuccess(''); setMigrationTab('new'); setMode('move'); setSwitchReferences(true); setConflict('overwrite'); setMigrationOpen(true); }}>数据迁移</MenuItem></Menu>
    <DialogContent dividers sx={{ px: 2, pt: 0, pb: 2 }}>
      <Stack spacing={2} useFlexGap>
        {!migrationOpen && error && <Alert severity="error" sx={{ overflowWrap: 'anywhere' }} onClose={() => setError('')}>{error}</Alert>}
        {!migrationOpen && success && <Alert severity="success" onClose={() => setSuccess('')}>{success}</Alert>}
        {loading ? <Box sx={{ py: 5, textAlign: 'center' }}><CircularProgress size={28} aria-label="加载存储配置" /></Box> : <>
          <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0, borderBottom: 1, borderColor: 'divider' }}>
            <Tabs value={draft?.id || false} onChange={(_, value: string) => switchTab(value)} variant="scrollable" scrollButtons="auto" sx={{ flex: 1, minWidth: 0, minHeight: 40, '& .MuiTab-root': { minHeight: 40, py: 1 } }} aria-label="存储位置">
              {items.map((item) => <Tab key={item.id} value={item.id} disabled={changeBlocked} label={item.name + (item.isDefault ? ' · 默认' : '')} sx={{ maxWidth: 200 }} />)}
              {draft?.id === 'new' && <Tab value="new" label="新增存储" disabled={changeBlocked} />}
            </Tabs>
            <Tooltip title="添加存储"><span><IconButton aria-label="添加存储" disabled={changeBlocked} onClick={(event) => setMenu(event.currentTarget)}><AddIcon /></IconButton></span></Tooltip>
          </Box>
          <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
            <MenuItem onClick={() => { switchTab('new'); setMenu(null); }}>对象存储（COS / S3）</MenuItem>
            <MenuItem onClick={() => { switchTab('new', 'webdav'); setMenu(null); }}>WebDAV</MenuItem>
            <MenuItem onClick={() => { switchTab('new', 'ftps'); setMenu(null); }}>FTPS</MenuItem>
          </Menu>
          {draft && <Stack spacing={2} component="section" aria-label={(draft.name || '新增存储') + '配置'}>
            {draft.provider === 'local' ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TextField label="本地存储路径" value={draft.config.rootPath || ''} onChange={(e) => config('rootPath', e.target.value)} placeholder={draft.defaultLocalPath} disabled={changeBlocked} fullWidth />
              <Tooltip title="重置为默认路径"><span><IconButton aria-label="重置为默认路径" disabled={changeBlocked || !draft.defaultLocalPath || draft.config.rootPath === draft.defaultLocalPath} onClick={() => config('rootPath', draft.defaultLocalPath || '')}><RestoreIcon /></IconButton></span></Tooltip>
            </Box> : <>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
                <TextField label="存储名称" value={draft.name} disabled={changeBlocked} onChange={(e) => setDraft({ ...draft, name: e.target.value })} fullWidth />
                <TextField select label="服务商 / 协议" value={draft.provider} disabled={changeBlocked} onChange={(e) => setDraft({ ...draft, provider: e.target.value as StorageDestination['provider'], config: { ...emptyConfig, region: e.target.value === 's3' ? 'auto' : '' } })}>
                  <MenuItem value="tencent-cos">腾讯云 COS</MenuItem><MenuItem value="s3">其他服务商（S3 兼容）</MenuItem><MenuItem value="webdav">WebDAV</MenuItem><MenuItem value="ftps">FTPS（显式 TLS）</MenuItem>
                </TextField>
                {(draft.provider === 'tencent-cos' || draft.provider === 's3') && <><TextField label={draft.provider === 'tencent-cos' ? 'Bucket（包含 APPID）' : 'Bucket'} value={draft.config.bucket || ''} onChange={(e) => config('bucket', e.target.value)} disabled={changeBlocked} fullWidth />
                <TextField label="地域 / Region" value={draft.config.region || ''} helperText={draft.provider === 'tencent-cos' ? '填写存储桶的实际所属地域，如 ap-shanghai' : undefined} onChange={(e) => config('region', e.target.value)} disabled={changeBlocked} fullWidth /></>}
                {draft.provider !== 'tencent-cos' && <TextField label={draft.provider === 's3' ? 'Endpoint（HTTPS）' : draft.provider === 'webdav' ? 'WebDAV 地址（HTTPS）' : 'FTPS 地址'} placeholder={draft.provider === 'webdav' ? 'https://example.com/dav' : draft.provider === 'ftps' ? 'ftps://example.com:21' : undefined} value={draft.config.endpoint || ''} onChange={(e) => config('endpoint', e.target.value)} disabled={changeBlocked} fullWidth sx={{ gridColumn: '1 / -1' }} />}
                <TextField label={draft.provider === 'tencent-cos' ? 'SecretID' : draft.provider === 's3' ? 'Access Key ID' : '用户名'} value={draft.config.accessKeyId} autoComplete="off" onChange={(e) => config('accessKeyId', e.target.value)} disabled={changeBlocked} fullWidth />
                <TextField label={draft.provider === 'tencent-cos' ? 'SecretKey' : draft.provider === 's3' ? 'Secret Access Key' : '密码'} value={draft.config.secretAccessKey} type="password" autoComplete="new-password" helperText={draft.hasCredentials ? '已保存，留空不修改；填写新值则替换' : '尚未配置，请填写'} onChange={(e) => config('secretAccessKey', e.target.value)} disabled={changeBlocked} fullWidth />
                <TextField label="目录前缀（可选）" value={draft.config.prefix || ''} onChange={(e) => config('prefix', e.target.value)} disabled={changeBlocked} fullWidth sx={{ gridColumn: '1 / -1' }} />
              </Box>
              {draft.provider === 's3' && <FormControlLabel control={<Checkbox checked={draft.config.forcePathStyle} onChange={(e) => config('forcePathStyle', e.target.checked)} disabled={changeBlocked} />} label="使用 Path-style 访问" />}
              <Typography variant="caption" color="text.secondary">凭据加密保存；连接测试会上传、读取并删除一个测试文件。</Typography>
            </>}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Button variant="contained" disabled={changeBlocked || !dirty} onClick={() => void act(async () => { const item = await adminApi.saveStorageDestination(draft, saved ? draft.id : undefined); await reload(item.id); }, '存储配置已保存')}>保存配置</Button>
                <Button disabled={changeBlocked || !saved || dirty} onClick={() => void act(async () => { await adminApi.testStorage(draft.id); }, '读写及删除测试通过')}>测试连接</Button>
                {draft.id !== 'local' && <Button color="error" startIcon={<DeleteOutlineIcon />} disabled={changeBlocked || (saved && (dirty || draft.isDefault || running))} onClick={() => { if (!saved) switchTab('local'); else setConfirm('delete'); }}>删除存储</Button>}
              </Stack>
              <Button sx={{ ml: 'auto' }} disabled={changeBlocked || !saved || dirty || draft.isDefault} onClick={() => void act(async () => { await adminApi.setDefaultStorage(draft.id); await reload(draft.id); }, '新上传文件将使用此存储')}>{draft.isDefault ? '当前默认存储' : '设为默认存储'}</Button>
            </Box>
          </Stack>}
        </>}
      </Stack>
    </DialogContent>
    <Dialog open={migrationOpen} onClose={busy ? undefined : () => setMigrationOpen(false)} maxWidth="sm" fullWidth scroll="paper">
      <DialogTitle>数据迁移</DialogTitle>
      <DialogContent dividers><Stack spacing={2}>
          {error && <Alert severity="error" sx={{ overflowWrap: 'anywhere' }} onClose={() => setError('')}>{error}</Alert>}
          {success && <Alert severity="success" onClose={() => setSuccess('')}>{success}</Alert>}
          <Tabs value={migrationTab} onChange={(_, value: 'new' | 'history') => setMigrationTab(value)} aria-label="数据迁移视图" sx={{ borderBottom: 1, borderColor: 'divider' }}>
            <Tab value="new" label="新建迁移" />
            <Tab value="history" label="迁移记录" />
          </Tabs>
          {migrationTab === 'new' && <>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
            <TextField select label="源存储" value={sourceId} onChange={(e) => { setSourceId(e.target.value); if (e.target.value === targetId) setTargetId(''); }} disabled={changeBlocked || running}>{items.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</TextField>
            <TextField select label="目标存储" value={items.some((item) => item.id === targetId) ? targetId : ''} onChange={(e) => setTargetId(e.target.value)} disabled={changeBlocked || running}><MenuItem value="" disabled>请选择</MenuItem>{items.filter((item) => item.id !== sourceId).map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</TextField>
            <TextField select label="迁移方式" value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setSwitchReferences(e.target.value === 'move'); }} disabled={changeBlocked || running}><MenuItem value="copy">复制（保留源文件）</MenuItem><MenuItem value="move">移动（校验后删除源文件）</MenuItem></TextField>
            <TextField select label="同名文件处理" value={conflict} onChange={(e) => setConflict(e.target.value as typeof conflict)} disabled={changeBlocked || running}><MenuItem value="coexist">共存：相同内容跳过，不同内容改名</MenuItem><MenuItem value="skip">不覆盖：跳过目标已有文件</MenuItem><MenuItem value="overwrite">覆盖：替换目标同名文件</MenuItem></TextField>
          </Box>
          <FormControlLabel control={<Checkbox checked={mode === 'move' || switchReferences} onChange={(e) => setSwitchReferences(e.target.checked)} disabled={changeBlocked || running || mode === 'move'} />} label="迁移后切换文件读取位置" />
          <Typography variant="caption" color="text.secondary">迁移系统管理的图片、音频、参考图和头像。移动时仅删除已验证的源文件；不覆盖时发生冲突的源文件保留。</Typography>
          <Box><Button variant="outlined" disabled={!canMigrate} onClick={() => setConfirm('migrate')}>开始迁移</Button></Box>
          </>}
          {migrationTab === 'history' && <>
          {!jobs.length && <Typography variant="body2" color="text.secondary">暂无迁移记录</Typography>}
          {jobs.map((job) => { const processed = Number(job.completed) + Number(job.skipped) + Number(job.failed); const conflicts = Number(job.conflicts || 0); return <Box key={job.id} sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}><Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{items.find((item) => item.id === job.source_id)?.name || '已移除存储'} → {items.find((item) => item.id === job.target_id)?.name || '已移除存储'} · {job.mode === 'copy' ? '复制' : '移动'}</Typography><Chip size="small" label={job.status === 'completed' && conflicts ? '完成，有冲突' : statusLabel[job.status]} color={job.status === 'failed' || conflicts ? 'warning' : job.status === 'completed' ? 'success' : 'default'} />{job.status === 'failed' && <Button size="small" disabled={busy || running} onClick={() => void act(async () => { await adminApi.retryStorageMigration(job.id); await reload(); }, '已重新加入迁移队列')}>重试失败项</Button>}</Stack>
            <LinearProgress variant="determinate" value={Number(job.total) ? processed / Number(job.total) * 100 : job.status === 'completed' ? 100 : 0} sx={{ my: 1 }} />
            <Stack spacing={0.75} sx={{ mt: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {new Date(Number(job.created_at)).toLocaleString()} · 已处理 {processed} / {job.total}
                {job.status === 'completed' || job.status === 'failed' ? ` · 结束于 ${new Date(Number(job.updated_at)).toLocaleString()}` : ''}
              </Typography>
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }} aria-label="迁移结果统计">
                <Chip size="small" variant="outlined" color="success" label={`成功 ${job.completed}`} />
                <Chip size="small" variant="outlined" label={`复用 ${Number(job.skipped) - conflicts}`} />
                {conflicts > 0 && <Chip size="small" variant="outlined" color="warning" label={`冲突跳过 ${conflicts}`} />}
                {Number(job.failed) > 0 && <Chip size="small" variant="outlined" color="error" label={`失败 ${job.failed}`} />}
                {conflicts === 0 && Number(job.failed) === 0 && <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>无冲突或失败</Typography>}
              </Stack>
            </Stack>
            {job.error && <Typography variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{job.error}</Typography>}
            {(conflicts > 0 || Number(job.failed) > 0) && <Box><Button size="small" disabled={busy} onClick={() => void toggleIssues(job.id)}>{issuesJob === job.id ? '收起明细' : '查看失败与冲突项'}</Button></Box>}
            {issuesJob === job.id && <Box sx={{ pl: 1, borderLeft: 2, borderColor: 'divider' }}>{issues.map((issue, index) => <Typography key={`${index}-${issue.name}`} variant="body2" sx={{ overflowWrap: 'anywhere', py: 0.5 }}>{issue.status === 'failed' ? '失败' : '冲突跳过'} · {issue.name}{issue.error ? `：${issue.error}` : ''}</Typography>)}{issuesHasMore && <Button size="small" disabled={busy} onClick={() => void act(async () => { const result = await adminApi.getStorageMigrationIssues(job.id, issues.length); setIssues((current) => [...current, ...result.items]); setIssuesHasMore(result.hasMore); }, '已加载更多明细')}>加载更多明细</Button>}</Box>}
          </Box>; })}
          {jobsHasMore && <Box><Button disabled={busy} onClick={() => void act(async () => { const result = await adminApi.getStorageMigrations(jobs.at(-1)?.id); setJobs((current) => [...current, ...result.items]); setJobsHasMore(result.hasMore); }, '已加载更多迁移记录')}>加载更多迁移记录</Button></Box>}
          </>}
      </Stack></DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setMigrationOpen(false)}>关闭</Button></DialogActions>
    </Dialog>
    <DialogActions><Button onClick={close} disabled={busy}>关闭</Button></DialogActions>
    <Dialog open={confirm !== null} onClose={busy ? undefined : () => setConfirm(null)} maxWidth="xs" fullWidth>
      <DialogTitle>{confirm === 'discard' ? '放弃未保存的配置？' : confirm === 'delete' ? '删除存储配置' : '确认数据迁移'}</DialogTitle>
      <DialogContent><Typography>{confirm === 'discard' ? '当前配置尚未保存，继续会丢弃修改。' : confirm === 'delete' ? '复制或移动迁移完整成功，且迁移开始后未再设为默认，才允许删除。相同内容复用也算成功。删除前会校验目标副本并切换读取位置，复制保留的源文件不会被删除；重新添加相同存储位置会恢复原有身份。' : (mode === 'move' ? '移动' : '复制') + '源存储中的文件到目标存储。' + (conflict === 'overwrite' ? '目标同名但内容不同的文件将被覆盖。' : conflict === 'skip' ? '目标已有文件会跳过。' : '相同内容复用，不同内容改名共存。') + (mode === 'move' ? '目标校验成功后会删除源文件。' : '')}</Typography></DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button><Button color={confirm === 'delete' || (confirm === 'migrate' && (mode === 'move' || conflict === 'overwrite')) ? 'error' : 'primary'} disabled={busy} onClick={() => {
        if (confirm === 'discard') { setConfirm(null); if (nextTab === 'close') onClose(); else setDraft(nextTab === 'new' ? newStorage(nextProvider) : items.find((item) => item.id === nextTab) || null); return; }
        void act(async () => { if (confirm === 'delete' && draft) { await adminApi.deleteStorageDestination(draft.id); await reload('local'); } else { await adminApi.createStorageMigration({ sourceId, targetId, mode, switchReferences: mode === 'move' || switchReferences, conflict }); await reload(); setMigrationTab('history'); } setConfirm(null); }, confirm === 'delete' ? '存储配置已删除' : '迁移已开始，关闭弹窗后会继续处理');
      }}>{busy ? '处理中…' : '确认'}</Button></DialogActions>
    </Dialog>
  </Dialog>;
}
