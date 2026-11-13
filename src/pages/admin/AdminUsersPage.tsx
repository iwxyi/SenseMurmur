import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Dialog, DialogContent, DialogTitle, Divider, FormControlLabel, Grid, MenuItem, Paper, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography, useMediaQuery, useTheme } from '@mui/material';
import AdminAiUserUsageDialog from '../../components/admin/AdminAiUserUsageDialog';
import AdminRequestState, { getAdminErrorMessage } from '../../components/admin/AdminRequestState';
import { AdminMetricGrid, AdminSection, AdminTableFrame, type AdminMetricItem } from '../../components/admin/AdminSurface';
import { adminApi, type AdminUserLoginRecord } from '../../services/adminApi';
import { DEFAULT_BASIC_RETENTION_LIMITS } from '../../services/retentionLimits';
import { formatAiAmount, formatAiBalanceAmount } from '../../utils/aiPoints';

type KeyDraft = {
  apiKey: string;
  externalKeyId: string;
  transferAmount: string;
  transferReason: string;
  dailyQuota: string;
  monthlyQuota: string;
  minuteTimes: string;
  requestLimit: string;
  note: string;
};

type AdminUserListItem = {
  id: string;
  phone: string;
  nickname: string;
  created_at: number;
  aiBalanceAmount?: unknown;
  aiUsedAmount?: unknown;
  aiRequestCount?: unknown;
};

type OfficialProviderOption = {
  value: string;
  label: string;
};

type UserDetailTab = 'overview' | 'ai' | 'entitlements' | 'logins';

type UserUsageSessionItem = {
  id: string;
  startedAt: number;
  lastHeartbeatAt: number;
  endedAt: number | null;
  durationMs: number;
  heartbeatCount: number;
  status: string;
  entryPath: string;
  lastPath: string;
};

type AccountEntitlementDraft = {
  developerModeEnabled: boolean;
  cloudSyncEnabled: boolean;
  assistantArtifactCloudSync: boolean;
  aiProxyEnabled: boolean;
  agentEnabled: boolean;
  aiSearchEnabled: boolean;
  multimediaGenerationEnabled: boolean;
  marketAccessEnabled: boolean;
  marketUploadEnabled: boolean;
  chatShareEnabled: boolean;
  maxCharacters: string;
  maxChats: string;
  maxGroupMembers: string;
  maxBackgroundConversations: string;
  dailyAiGenerationLimit: string;
  batchGenerationLimit: string;
  officialProviderAccess: string[];
  aiBillingDiscount: string;
  dailyPointGrant: string;
  monthlyPointGrant: string;
  cloudStorageBytes: string;
  retentionLimitsText: string;
  note: string;
};

const EMPTY_ACCOUNT_ENTITLEMENT_DRAFT: AccountEntitlementDraft = {
  developerModeEnabled: false,
  cloudSyncEnabled: false,
  assistantArtifactCloudSync: false,
  aiProxyEnabled: false,
  agentEnabled: false,
  aiSearchEnabled: false,
  multimediaGenerationEnabled: false,
  marketAccessEnabled: false,
  marketUploadEnabled: false,
  chatShareEnabled: false,
  maxCharacters: '',
  maxChats: '',
  maxGroupMembers: '',
  maxBackgroundConversations: '',
  dailyAiGenerationLimit: '',
  batchGenerationLimit: '',
  officialProviderAccess: [],
  aiBillingDiscount: '',
  dailyPointGrant: '',
  monthlyPointGrant: '',
  cloudStorageBytes: '',
  retentionLimitsText: '',
  note: '',
};
const LEGACY_OFFICIAL_PROVIDER_PUBLIC_IDS: Record<string, string> = {
  deepseek: 'official-1',
  moacode: 'official-2',
  'moacode-team': 'official-team',
  api2d: 'official-4',
};

const RETENTION_LIMIT_ROWS: Array<{ key: string; label: string; description: string }> = [
  { key: 'characterLayeredMemories', label: '角色长期记忆', description: '角色自身长期记忆条数' },
  { key: 'characterRuntimeTimeline', label: '角色时间线', description: '角色运行时间线条数' },
  { key: 'chatLayeredMemories', label: '会话长期记忆', description: '房间/会话长期记忆条数' },
  { key: 'runtimeEventsV2', label: '运行事件', description: '结构化运行事件条数' },
  { key: 'runtimeTimeline', label: '会话时间线', description: '轻量时间线条数' },
  { key: 'relationshipLedger', label: '关系账本', description: '关系状态与变化账本条数' },
  { key: 'roleMemorySummaries', label: '角色摘要', description: '会话内角色摘要条数' },
  { key: 'growthSnapshots', label: '成长快照', description: '成长/状态快照条数' },
  { key: 'runtimeSeedNotes', label: '种子笔记', description: 'runtimeSeed notes 条数' },
  { key: 'runtimeSeedArtifacts', label: '种子产物', description: 'runtimeSeed artifacts 条数' },
];

function parseRetentionLimitsText(value: string): Record<string, { storage?: unknown; recall?: unknown }> {
  if (!value.trim()) return DEFAULT_BASIC_RETENTION_LIMITS as Record<string, { storage?: unknown; recall?: unknown }>;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, { storage?: unknown; recall?: unknown }>
      : DEFAULT_BASIC_RETENTION_LIMITS as Record<string, { storage?: unknown; recall?: unknown }>;
  } catch {
    return DEFAULT_BASIC_RETENTION_LIMITS as Record<string, { storage?: unknown; recall?: unknown }>;
  }
}

function retentionLimitsText(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : DEFAULT_BASIC_RETENTION_LIMITS;
  return JSON.stringify(record, null, 2);
}

function updateRetentionLimitText(currentText: string, key: string, field: 'storage' | 'recall', value: string) {
  const current = parseRetentionLimitsText(currentText);
  const parsed = Number(value);
  const nextValue = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
  return retentionLimitsText({
    ...current,
    [key]: {
      ...(current[key] || {}),
      [field]: nextValue,
    },
  });
}

function formatTime(value: unknown) {
  const parsed = Number(value || 0);
  return parsed > 0 ? new Date(parsed).toLocaleString() : '-';
}

function formatDuration(value: unknown) {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟${seconds}秒`;
  return `${seconds}秒`;
}

function usageStatusChip(status: string) {
  if (status === 'online') return <Chip size="small" color="success" label="在线" />;
  if (status === 'timeout') return <Chip size="small" color="warning" label="无心跳" />;
  if (status === 'ended') return <Chip size="small" label="已关闭" />;
  return <Chip size="small" label={status || '未知'} />;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numberOrNull(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function draftText(value: unknown) {
  return value == null ? '' : String(value);
}

function normalizeOfficialProviderAccess(values: unknown[]) {
  return Array.from(new Set(values
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => LEGACY_OFFICIAL_PROVIDER_PUBLIC_IDS[item] || item)
    .filter(Boolean)));
}

function accountEntitlementToDraft(value: unknown): AccountEntitlementDraft {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const entitlement = row.entitlement && typeof row.entitlement === 'object' && !Array.isArray(row.entitlement)
    ? row.entitlement as Record<string, unknown>
    : {};
  return {
    developerModeEnabled: entitlement.developerModeEnabled === true,
    cloudSyncEnabled: entitlement.cloudSyncEnabled === true,
    assistantArtifactCloudSync: entitlement.assistantArtifactCloudSync === true,
    aiProxyEnabled: entitlement.aiProxyEnabled === true,
    agentEnabled: entitlement.agentEnabled === true,
    aiSearchEnabled: entitlement.aiSearchEnabled === true,
    multimediaGenerationEnabled: entitlement.multimediaGenerationEnabled === true,
    marketAccessEnabled: entitlement.marketAccessEnabled === true,
    marketUploadEnabled: entitlement.marketUploadEnabled === true,
    chatShareEnabled: entitlement.chatShareEnabled === true,
    maxCharacters: draftText(entitlement.maxCharacters),
    maxChats: draftText(entitlement.maxChats),
    maxGroupMembers: draftText(entitlement.maxGroupMembers),
    maxBackgroundConversations: draftText(entitlement.maxBackgroundConversations),
    dailyAiGenerationLimit: draftText(entitlement.dailyAiGenerationLimit),
    batchGenerationLimit: draftText(entitlement.batchGenerationLimit),
    officialProviderAccess: Array.isArray(entitlement.officialProviderAccess)
      ? normalizeOfficialProviderAccess(entitlement.officialProviderAccess)
      : [],
    aiBillingDiscount: draftText(entitlement.aiBillingDiscount),
    dailyPointGrant: draftText(entitlement.dailyPointGrant),
    monthlyPointGrant: draftText(entitlement.monthlyPointGrant),
    cloudStorageBytes: entitlement.cloudStorageBytes == null ? '' : String(Math.round(Number(entitlement.cloudStorageBytes) / (1024 * 1024))),
    retentionLimitsText: entitlement.retentionLimits ? retentionLimitsText(entitlement.retentionLimits) : '',
    note: String(row.note || ''),
  };
}

function parseOptionalNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mbToBytes(value: string) {
  const mb = Number(value);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : undefined;
}

function filterAllowedProviderAccess(values: string[], allowedProviderIds?: Set<string>) {
  if (!allowedProviderIds?.size) return values;
  return values.filter((value) => allowedProviderIds.has(value));
}

function buildAccountEntitlementPayload(draft: AccountEntitlementDraft, allowedProviderIds?: Set<string>) {
  const entitlement: Record<string, unknown> = {};
  const numberFields: Array<keyof AccountEntitlementDraft> = [
    'maxCharacters',
    'maxChats',
    'maxGroupMembers',
    'maxBackgroundConversations',
    'dailyAiGenerationLimit',
    'batchGenerationLimit',
    'aiBillingDiscount',
    'dailyPointGrant',
    'monthlyPointGrant',
    'cloudStorageBytes',
  ];
  numberFields.forEach((field) => {
    const parsed = parseOptionalNumber(String(draft[field] || ''));
    if (parsed !== undefined) entitlement[field] = field === 'cloudStorageBytes' ? mbToBytes(String(parsed)) : parsed;
  });
  if (draft.cloudSyncEnabled) entitlement.cloudSyncEnabled = true;
  if (draft.assistantArtifactCloudSync) entitlement.assistantArtifactCloudSync = true;
  if (draft.aiProxyEnabled) entitlement.aiProxyEnabled = true;
  if (draft.agentEnabled) entitlement.agentEnabled = true;
  if (draft.aiSearchEnabled) entitlement.aiSearchEnabled = true;
  if (draft.multimediaGenerationEnabled) entitlement.multimediaGenerationEnabled = true;
  if (draft.marketAccessEnabled) entitlement.marketAccessEnabled = true;
  if (draft.marketUploadEnabled) entitlement.marketUploadEnabled = true;
  if (draft.chatShareEnabled) entitlement.chatShareEnabled = true;
  if (draft.developerModeEnabled) entitlement.developerModeEnabled = true;
  const officialProviderAccess = filterAllowedProviderAccess(normalizeOfficialProviderAccess(draft.officialProviderAccess), allowedProviderIds);
  if (officialProviderAccess.length) entitlement.officialProviderAccess = officialProviderAccess;
  if (draft.retentionLimitsText.trim()) entitlement.retentionLimits = parseRetentionLimitsText(draft.retentionLimitsText);
  return { entitlement, note: draft.note.trim() };
}

function formatUserAiQuota(item: AdminUserListItem) {
  return {
    balance: formatAiAmount(item.aiBalanceAmount ?? 0, 'deepseek'),
    used: formatAiAmount(item.aiUsedAmount ?? 0, 'deepseek'),
  };
}

function mergeAiKeyIntoUser(user: Record<string, unknown> | null, key: Record<string, unknown>) {
  if (!user || !key.id) return user;
  const existingKeys = Array.isArray(user.aiKeys) ? user.aiKeys as Array<Record<string, unknown>> : [];
  const normalizedKey = {
    ...key,
    provider_code: key.provider_code || 'api2d',
    api_key: key.api_key || key.apiKey || '',
    status: key.status || 'active',
    source: key.source || 'admin_manual',
    is_primary: key.is_primary ?? true,
  };
  return {
    ...user,
    aiKeys: [normalizedKey, ...existingKeys.filter((item) => String(item.id || '') !== String(key.id))],
  };
}

function extractTransferredCustomKey(result: Record<string, unknown>) {
  const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : null;
  const customKey = data?.custom_key;
  return customKey && typeof customKey === 'object' && !Array.isArray(customKey)
    ? customKey as Record<string, unknown>
    : null;
}

function WorkspaceTable({ title, rows, columns }: { title: string; rows: Array<Record<string, unknown>>; columns: Array<{ key: string; label: string }> }) {
  return (
    <AdminSection title={title} bodySx={{ p: rows.length ? 0 : undefined }}>
      {!rows.length ? <Alert severity="info">暂无数据</Alert> : null}
      {rows.length ? (
        <AdminTableFrame minWidth={520}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {columns.map((column) => <TableCell key={column.key}>{column.label}</TableCell>)}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={String(row.id)}>
                  {columns.map((column) => (
                    <TableCell key={column.key}>{column.key.endsWith('_at') ? formatTime(row[column.key]) : String(row[column.key] || '-')}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AdminTableFrame>
      ) : null}
    </AdminSection>
  );
}

function UserUsageSessionTable({ rows }: { rows: UserUsageSessionItem[] }) {
  return (
    <AdminSection title="最近使用记录" bodySx={{ p: rows.length ? 0 : undefined }}>
      {!rows.length ? <Alert severity="info">暂无使用记录</Alert> : null}
      {rows.length ? (
        <AdminTableFrame minWidth={820}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>状态</TableCell>
                <TableCell>启动时间</TableCell>
                <TableCell>最后心跳</TableCell>
                <TableCell>关闭时间</TableCell>
                <TableCell align="right">使用时长</TableCell>
                <TableCell align="right">心跳</TableCell>
                <TableCell>入口</TableCell>
                <TableCell>最后页面</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell>{usageStatusChip(row.status)}</TableCell>
                  <TableCell>{formatTime(row.startedAt)}</TableCell>
                  <TableCell>{formatTime(row.lastHeartbeatAt)}</TableCell>
                  <TableCell>{formatTime(row.endedAt)}</TableCell>
                  <TableCell align="right">{formatDuration(row.durationMs)}</TableCell>
                  <TableCell align="right">{Math.round(Number(row.heartbeatCount || 0))}</TableCell>
                  <TableCell>{row.entryPath || '-'}</TableCell>
                  <TableCell>{row.lastPath || '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AdminTableFrame>
      ) : null}
    </AdminSection>
  );
}

function AccountRetentionLimitsTable({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const limits = parseRetentionLimitsText(value);
  return (
    <AdminTableFrame minWidth={720}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>项目</TableCell>
            <TableCell>说明</TableCell>
            <TableCell width={130}>存储/同步上限</TableCell>
            <TableCell width={130}>提示词召回</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {RETENTION_LIMIT_ROWS.map((row) => {
            const pair = limits[row.key] || DEFAULT_BASIC_RETENTION_LIMITS[row.key as keyof typeof DEFAULT_BASIC_RETENTION_LIMITS];
            return (
              <TableRow key={row.key}>
                <TableCell sx={{ fontWeight: 800 }}>{row.label}</TableCell>
                <TableCell>
                  <Typography variant="caption" color="text.secondary">{row.description}</Typography>
                </TableCell>
                <TableCell>
                  <TextField
                    size="small"
                    type="number"
                    value={String(pair.storage || 1)}
                    onChange={(event) => onChange(updateRetentionLimitText(value, row.key, 'storage', event.target.value))}
                    slotProps={{ htmlInput: { min: 1 } }}
                    fullWidth
                  />
                </TableCell>
                <TableCell>
                  <TextField
                    size="small"
                    type="number"
                    value={String(pair.recall || 1)}
                    onChange={(event) => onChange(updateRetentionLimitText(value, row.key, 'recall', event.target.value))}
                    slotProps={{ htmlInput: { min: 1 } }}
                    fullWidth
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </AdminTableFrame>
  );
}

export default function AdminUsersPage() {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<AdminUserListItem[]>([]);
  const [officialProviderOptions, setOfficialProviderOptions] = useState<OfficialProviderOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<Record<string, unknown> | null>(null);
  const [userDetailTab, setUserDetailTab] = useState<UserDetailTab>('overview');
  const [usageDialogOpen, setUsageDialogOpen] = useState(false);
  const [aiPointDraft, setAiPointDraft] = useState('');
  const [aiPointReasonDraft, setAiPointReasonDraft] = useState('');
  const [accountEntitlementDraft, setAccountEntitlementDraft] = useState<AccountEntitlementDraft>(EMPTY_ACCOUNT_ENTITLEMENT_DRAFT);
  const [selectedRestrictions, setSelectedRestrictions] = useState<Array<Record<string, unknown>>>([]);
  const [loginRecords, setLoginRecords] = useState<AdminUserLoginRecord[]>([]);
  const [loginResultFilter, setLoginResultFilter] = useState('all');
  const [loginMethodFilter, setLoginMethodFilter] = useState('all');
  const [restrictionReason, setRestrictionReason] = useState('');
  const [keyDrafts, setKeyDrafts] = useState<Record<string, KeyDraft>>({});
  const [expandedLimits, setExpandedLimits] = useState<Record<string, boolean>>({});
  const [expandedUsage, setExpandedUsage] = useState<Record<string, boolean>>({});
  const [keyUsage, setKeyUsage] = useState<Record<string, { invocations: Array<Record<string, unknown>>; quotaLedger: Array<Record<string, unknown>> }>>({});
  const [keyBalance, setKeyBalance] = useState<Record<string, unknown> | null>(null);
  const [keyBalanceLoading, setKeyBalanceLoading] = useState(false);
  const [manualKeyDraft, setManualKeyDraft] = useState({ visible: false, apiKey: '', externalKeyId: '' });
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const statCards = useMemo<AdminMetricItem[]>(() => [
    { key: 'chats', label: '聊天数', value: String(selectedUser?.chatCount || 0), tone: 'primary' },
    { key: 'characters', label: '角色数', value: String(selectedUser?.characterCount || 0), tone: 'info' },
    { key: 'orders', label: '订单数', value: String(selectedUser?.orderCount || 0), tone: 'success' },
    { key: 'restrictions', label: '生效限制', value: String(selectedUser?.activeRestrictionCount || 0), tone: Number(selectedUser?.activeRestrictionCount || 0) > 0 ? 'warning' : 'default' },
  ], [selectedUser]);

  const accountProviderOptions = useMemo(() => {
    return officialProviderOptions;
  }, [officialProviderOptions]);
  const allowedOfficialProviderIds = useMemo(
    () => new Set(officialProviderOptions.map((option) => option.value)),
    [officialProviderOptions],
  );

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminApi.getUsers(search);
      setItems(result.items as AdminUserListItem[]);
    } catch (loadError) {
      setError(getAdminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [search]);

  const loadOfficialProviderOptions = async () => {
    try {
      const result = await adminApi.getAiProviders();
      const runtimeCodes = new Set(
        (Array.isArray(result.runtime) ? result.runtime : [])
          .map((provider) => String(provider.code || '').trim().toLowerCase())
          .filter(Boolean),
      );
      const options = Array.from(new Map((Array.isArray(result.items) ? result.items : [])
        .map((provider) => {
          const code = String(provider.code || '').trim().toLowerCase();
          const publicId = String(provider.publicId || provider.public_id || '').trim().toLowerCase();
          if (!code || !runtimeCodes.has(code)) return null;
          if (!publicId) return null;
          const name = String(provider.publicName || provider.public_name || provider.name || publicId);
          return {
            value: publicId,
            label: `${name}（${publicId}）`,
          };
        })
        .filter((option): option is OfficialProviderOption => Boolean(option))
        .map((option) => [option.value, option])).values());
      setOfficialProviderOptions(options);
    } catch (loadError) {
      console.error('Failed to load AI provider options', loadError);
      setOfficialProviderOptions([]);
    }
  };

  const loadSelectedUser = async (userId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [user, restrictions] = await Promise.all([
        adminApi.getUser(userId),
        adminApi.getUserRestrictions(userId),
      ]);
      setSelectedUser(user);
      setAccountEntitlementDraft(accountEntitlementToDraft(user.accountEntitlement));
      setSelectedRestrictions(restrictions.items);
    } catch (loadError) {
      setDetailError(getAdminErrorMessage(loadError));
    } finally {
      setDetailLoading(false);
    }
  };

  const loadKeyBalance = async (userId: string) => {
    setKeyBalanceLoading(true);
    try {
      const balance = await adminApi.getAiBalance(userId);
      setKeyBalance(balance);
    } catch (loadError) {
      console.error('Failed to load AI key balance', loadError);
      setKeyBalance(null);
    } finally {
      setKeyBalanceLoading(false);
    }
  };

  const loadLoginRecords = async (userId: string, result = loginResultFilter, method = loginMethodFilter) => {
    try {
      const response = await adminApi.getUserLoginRecords(userId, {
        result: result === 'all' ? undefined : result as 'success' | 'failure',
        method: method === 'all' ? undefined : method,
      });
      setLoginRecords(response.items || []);
    } catch (loadError) {
      setDetailError(getAdminErrorMessage(loadError));
    }
  };

  const resetLoginFailures = async () => {
    if (!selectedUserId) return;
    setActionLoading(true);
    setDetailError(null);
    try {
      await adminApi.resetUserLoginFailures(selectedUserId);
      await loadLoginRecords(selectedUserId);
    } catch (resetError) {
      setDetailError(getAdminErrorMessage(resetError));
    } finally {
      setActionLoading(false);
    }
  };

  const saveRestriction = async (restrictionType: string, status = 'active') => {
    if (!selectedUserId) return;
    setActionLoading(true);
    setDetailError(null);
    try {
      await adminApi.upsertUserRestriction(selectedUserId, restrictionType, { status, reasonText: restrictionReason });
      await loadSelectedUser(selectedUserId);
    } catch (saveError) {
      setDetailError(getAdminErrorMessage(saveError));
    } finally {
      setActionLoading(false);
    }
  };

  const updateAccountEntitlementDraft = (patch: Partial<AccountEntitlementDraft>) => {
    setAccountEntitlementDraft((prev) => ({ ...prev, ...patch }));
  };

  const saveAccountEntitlement = async () => {
    if (!selectedUserId) return;
    setActionLoading(true);
    setDetailError(null);
    try {
      const accountEntitlement = await adminApi.updateUserAccountEntitlement(selectedUserId, buildAccountEntitlementPayload(accountEntitlementDraft, allowedOfficialProviderIds));
      setSelectedUser((prev) => prev ? { ...prev, accountEntitlement } : prev);
      setAccountEntitlementDraft(accountEntitlementToDraft(accountEntitlement));
    } catch (saveError) {
      setDetailError(getAdminErrorMessage(saveError));
    } finally {
      setActionLoading(false);
    }
  };

  const saveManualKey = async () => {
    if (!selectedUserId || !manualKeyDraft.apiKey.trim()) return;
    setActionLoading(true);
    setDetailError(null);
    try {
      const key = await adminApi.setAiUserKey(selectedUserId, {
        providerCode: 'api2d',
        apiKey: manualKeyDraft.apiKey.trim(),
        externalKeyId: manualKeyDraft.externalKeyId.trim() || undefined,
        isPrimary: true,
      });
      setSelectedUser((prev) => mergeAiKeyIntoUser(prev, key));
      setManualKeyDraft({ visible: false, apiKey: '', externalKeyId: '' });
      await loadSelectedUser(selectedUserId);
    } catch (saveError) {
      setDetailError(getAdminErrorMessage(saveError));
    } finally {
      setActionLoading(false);
    }
  };

  const getKeyDraft = (key: Record<string, unknown>): KeyDraft => {
    const keyId = String(key.id || '');
    const metadata = parseMetadata(key.metadata);
    const providerLimits = parseMetadata(metadata.providerLimits);
    return keyDrafts[keyId] || {
      apiKey: String(key.api_key || ''),
      externalKeyId: String(key.external_key_id || ''),
      transferAmount: '',
      transferReason: '',
      dailyQuota: providerLimits.dailyQuota == null ? '' : String(providerLimits.dailyQuota),
      monthlyQuota: providerLimits.monthlyQuota == null ? '' : String(providerLimits.monthlyQuota),
      minuteTimes: providerLimits.minuteTimes == null ? '' : String(providerLimits.minuteTimes),
      requestLimit: providerLimits.requestLimit == null ? '' : String(providerLimits.requestLimit),
      note: providerLimits.note == null ? '' : String(providerLimits.note),
    };
  };

  const buildKeyDraft = (key: Record<string, unknown>): KeyDraft => {
    const metadata = parseMetadata(key.metadata);
    const providerLimits = parseMetadata(metadata.providerLimits);
    return {
      apiKey: String(key.api_key || ''),
      externalKeyId: String(key.external_key_id || ''),
      transferAmount: '',
      transferReason: '',
      dailyQuota: providerLimits.dailyQuota == null ? '' : String(providerLimits.dailyQuota),
      monthlyQuota: providerLimits.monthlyQuota == null ? '' : String(providerLimits.monthlyQuota),
      minuteTimes: providerLimits.minuteTimes == null ? '' : String(providerLimits.minuteTimes),
      requestLimit: providerLimits.requestLimit == null ? '' : String(providerLimits.requestLimit),
      note: providerLimits.note == null ? '' : String(providerLimits.note),
    };
  };

  const updateKeyDraft = (key: Record<string, unknown>, patch: Partial<KeyDraft>) => {
    const keyId = String(key.id || '');
    setKeyDrafts((prev) => ({
      ...prev,
      [keyId]: { ...(prev[keyId] || buildKeyDraft(key)), ...patch },
    }));
  };

  const saveKeySecret = async (key: Record<string, unknown>) => {
    if (!selectedUserId) return;
    const keyId = String(key.id || '');
    const draft = getKeyDraft(key);
    if (!draft.apiKey.trim()) return;
    setActionLoading(true);
    setDetailError(null);
    try {
      await adminApi.updateAiUserKeySecret(selectedUserId, keyId, { apiKey: draft.apiKey.trim(), externalKeyId: draft.externalKeyId.trim() || undefined });
      await loadSelectedUser(selectedUserId);
    } catch (saveError) {
      setDetailError(getAdminErrorMessage(saveError));
    } finally {
      setActionLoading(false);
    }
  };

  const toggleKeyStatus = async (key: Record<string, unknown>) => {
    if (!selectedUserId) return;
    const keyId = String(key.id || '');
    const enabled = String(key.status || '') !== 'active';
    setActionLoading(true);
    setDetailError(null);
    try {
      await adminApi.updateAiUserKeyStatus(selectedUserId, keyId, { enabled });
      await loadSelectedUser(selectedUserId);
    } catch (saveError) {
      setDetailError(getAdminErrorMessage(saveError));
    } finally {
      setActionLoading(false);
    }
  };

  const transferKeyPoints = async (key: Record<string, unknown>) => {
    if (!selectedUserId) return;
    const keyId = String(key.id || '');
    const draft = getKeyDraft(key);
    const amount = Number(draft.transferAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      setDetailError('请输入非 0 的转入额度，负数表示扣除');
      return;
    }
    const reason = draft.transferReason.trim();
    if (!reason) {
      setDetailError('请输入转入/扣除原因');
      return;
    }
    setActionLoading(true);
    setDetailError(null);
    try {
      const result = await adminApi.transferAiUserKeyPoints(selectedUserId, keyId, { amount, reason });
      const customKey = extractTransferredCustomKey(result);
      if (customKey) {
        setKeyBalance((prev) => ({
          ...(prev || {}),
          provider: String(key.provider_code || 'api2d'),
          keyStatus: String(customKey.enabled ?? '') === '0' ? 'inactive' : 'active',
          availableBalance: customKey.point,
          available_balance: customKey.point,
          raw: result,
          fetchedAt: Date.now(),
        }));
      }
      updateKeyDraft(key, { transferAmount: '', transferReason: '' });
      await Promise.all([
        loadSelectedUser(selectedUserId),
        loadKeyBalance(selectedUserId),
      ]);
    } catch (saveError) {
      setDetailError(getAdminErrorMessage(saveError));
    } finally {
      setActionLoading(false);
    }
  };

  const transferSelectedUserAiPoints = async (userId: string, amount: number, reason: string) => {
    if (!userId) throw new Error('用户不存在');
    if (!Number.isFinite(amount) || amount === 0) {
      throw new Error('请输入非 0 的额度，负数表示扣除');
    }
    if (!reason.trim()) throw new Error('请输入增减点数原因');
    setActionLoading(true);
    setDetailError(null);
    try {
      const result = await adminApi.transferAiUserPoints(userId, { amount, reason: reason.trim() });
      const balanceAfter = Number(result.balanceAfter);
      if (Number.isFinite(balanceAfter)) {
        setSelectedUser((prev) => prev && String(prev.id || '') === userId ? { ...prev, aiBalanceAmount: balanceAfter } : prev);
        setItems((prev) => prev.map((item) => item.id === userId ? { ...item, aiBalanceAmount: balanceAfter } : item));
      }
      await Promise.all([
        loadSelectedUser(userId),
        loadUsers(),
      ]);
      return result;
    } catch (saveError) {
      setDetailError(getAdminErrorMessage(saveError));
      throw saveError;
    } finally {
      setActionLoading(false);
    }
  };

  const transferSelectedUserAiPointsFromCard = async () => {
    if (!selectedUserId) return;
    const amount = Number(aiPointDraft);
    if (!Number.isFinite(amount) || amount === 0) {
      setDetailError('请输入非 0 的额度，负数表示扣除');
      return;
    }
    const reason = aiPointReasonDraft.trim();
    if (!reason) {
      setDetailError('请输入增减点数原因');
      return;
    }
    try {
      await transferSelectedUserAiPoints(selectedUserId, amount, reason);
      setAiPointDraft('');
      setAiPointReasonDraft('');
    } catch (transferError) {
      setDetailError(getAdminErrorMessage(transferError));
    }
  };

  const updateKeyLimits = async (key: Record<string, unknown>) => {
    if (!selectedUserId) return;
    const keyId = String(key.id || '');
    const draft = getKeyDraft(key);
    setActionLoading(true);
    setDetailError(null);
    try {
      await adminApi.updateAiUserKeyLimits(selectedUserId, keyId, {
        note: draft.note || undefined,
        dailyQuota: numberOrNull(draft.dailyQuota),
        monthlyQuota: numberOrNull(draft.monthlyQuota),
        minuteTimes: numberOrNull(draft.minuteTimes),
        requestLimit: numberOrNull(draft.requestLimit),
      });
      setExpandedLimits((prev) => ({ ...prev, [keyId]: false }));
      await loadSelectedUser(selectedUserId);
    } catch (saveError) {
      setDetailError(getAdminErrorMessage(saveError));
    } finally {
      setActionLoading(false);
    }
  };

  const loadKeyUsage = async (key: Record<string, unknown>) => {
    if (!selectedUserId) return;
    const keyId = String(key.id || '');
    const nextExpanded = !expandedUsage[keyId];
    setExpandedUsage((prev) => ({ ...prev, [keyId]: nextExpanded }));
    if (!nextExpanded || keyUsage[keyId]) return;
    setActionLoading(true);
    setDetailError(null);
    try {
      const usage = await adminApi.getAiUserKeyUsage(selectedUserId, keyId);
      setKeyUsage((prev) => ({ ...prev, [keyId]: usage }));
    } catch (loadError) {
      setDetailError(getAdminErrorMessage(loadError));
    } finally {
      setActionLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    void loadOfficialProviderOptions();
  }, []);

  useEffect(() => {
    if (!selectedUserId) return;
    setSelectedUser(null);
    setSelectedRestrictions([]);
    setLoginRecords([]);
    setLoginResultFilter('all');
    setLoginMethodFilter('all');
    setKeyDrafts({});
    setExpandedLimits({});
    setExpandedUsage({});
    setKeyUsage({});
    setKeyBalance(null);
    setAiPointDraft('');
    setAccountEntitlementDraft(EMPTY_ACCOUNT_ENTITLEMENT_DRAFT);
    setManualKeyDraft({ visible: false, apiKey: '', externalKeyId: '' });
    setUserDetailTab('overview');
    void loadSelectedUser(selectedUserId);
  }, [selectedUserId]);

  useEffect(() => {
    if (userDetailTab !== 'logins' || !selectedUserId) return;
    void loadLoginRecords(selectedUserId);
  }, [userDetailTab, selectedUserId]);

  const workspace = selectedUser?.workspace as { recentOrders?: Array<Record<string, unknown>>; recentChats?: Array<Record<string, unknown>>; recentCharacters?: Array<Record<string, unknown>> } | undefined;
  const recentUsageSessions = Array.isArray(selectedUser?.recentUsageSessions) ? selectedUser.recentUsageSessions as UserUsageSessionItem[] : [];
  const aiKeys = (selectedUser?.aiKeys || []) as Array<Record<string, unknown>>;
  const aiKey = aiKeys.find((key) => String(key.provider_code || '') === 'api2d') || null;
  const selectedListItem = selectedUserId ? items.find((item) => item.id === selectedUserId) : null;
  const selectedUserWithAiQuota = selectedUser ? {
    ...selectedUser,
    aiBalanceAmount: selectedUser.aiBalanceAmount ?? selectedListItem?.aiBalanceAmount ?? 0,
    aiUsedAmount: selectedUser.aiUsedAmount ?? selectedListItem?.aiUsedAmount ?? 0,
  } : null;

  useEffect(() => {
    if (!selectedUserId || !aiKey?.id) {
      setKeyBalance(null);
      return;
    }
    void loadKeyBalance(selectedUserId);
  }, [selectedUserId, aiKey?.id]);

  return (
    <Stack spacing={2}>
      <AdminSection title="用户管理" subtitle="查询用户、查看工作区数据、AI 点数和限制项。">
        <TextField value={search} onChange={(e) => setSearch(e.target.value)} label="搜索手机号或昵称" fullWidth />
      </AdminSection>
      <AdminRequestState loading={loading} error={error} onRetry={() => void loadUsers()} />
      <AdminSection title="用户列表" subtitle="点击用户行打开详情。" bodySx={{ p: 0 }}>
        <AdminTableFrame minWidth={760}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>昵称</TableCell>
                <TableCell>手机号</TableCell>
                <TableCell>用户额度</TableCell>
                <TableCell>创建时间</TableCell>
                <TableCell align="right">详情</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!items.length && !loading ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Alert severity="info">暂无用户</Alert>
                  </TableCell>
                </TableRow>
              ) : null}
              {items.map((item) => {
                const aiQuota = formatUserAiQuota(item);
                return (
                  <TableRow key={item.id} hover onClick={() => setSelectedUserId(item.id)} sx={{ cursor: 'pointer' }}>
                    <TableCell>{item.nickname}</TableCell>
                    <TableCell>{item.phone}</TableCell>
                    <TableCell>
                      <Stack spacing={0.25}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>剩余 {aiQuota.balance}</Typography>
                        <Typography variant="caption" color="text.secondary">已用 {aiQuota.used}</Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>{new Date(item.created_at).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Typography variant="body2" color="primary">查看</Typography>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </AdminTableFrame>
      </AdminSection>

      <Dialog open={Boolean(selectedUserId)} onClose={() => setSelectedUserId(null)} fullWidth maxWidth="lg" fullScreen={fullScreen}>
        <DialogTitle>用户详情</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <AdminRequestState loading={detailLoading || actionLoading} error={detailError} onRetry={selectedUserId ? () => void loadSelectedUser(selectedUserId) : undefined} />
            {selectedUser ? (
              <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
                <Tabs
                  value={userDetailTab}
                  onChange={(_event, value: UserDetailTab) => setUserDetailTab(value)}
                  variant="scrollable"
                  scrollButtons="auto"
                  allowScrollButtonsMobile
                >
                  <Tab value="overview" label="概览" />
                  <Tab value="ai" label="AI" />
                  <Tab value="entitlements" label="权益与限制" />
                  <Tab value="logins" label="登录记录" />
                </Tabs>
              </Box>
            ) : null}
            {selectedUser ? (
              <Stack spacing={2}>
                {userDetailTab === 'overview' ? (
                  <>
                <AdminSection title="基础信息">
                  <Stack spacing={1}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>{String(selectedUser.nickname || '')}</Typography>
                    <Typography variant="body2" color="text.secondary">{String(selectedUser.phone || '')}</Typography>
                    {selectedUser.latestSubscription ? (
                      <Typography variant="body2" color="text.secondary">当前订阅：{String((selectedUser.latestSubscription as Record<string, unknown>).plan_name || (selectedUser.latestSubscription as Record<string, unknown>).plan_code || '')} · {String((selectedUser.latestSubscription as Record<string, unknown>).status || '')}</Typography>
                    ) : null}
                  </Stack>
                </AdminSection>

                <AdminMetricGrid items={statCards} compact minWidth={132} />

                <UserUsageSessionTable rows={recentUsageSessions} />

                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, xl: 4 }}>
                    <WorkspaceTable title="最近订单" rows={workspace?.recentOrders || []} columns={[{ key: 'order_no', label: '订单号' }, { key: 'status', label: '状态' }, { key: 'amount', label: '金额' }, { key: 'created_at', label: '创建时间' }]} />
                  </Grid>
                  <Grid size={{ xs: 12, xl: 4 }}>
                    <WorkspaceTable title="最近聊天" rows={workspace?.recentChats || []} columns={[{ key: 'name', label: '名称' }, { key: 'type', label: '类型' }, { key: 'share_enabled', label: '分享' }, { key: 'updated_at', label: '更新时间' }]} />
                  </Grid>
                  <Grid size={{ xs: 12, xl: 4 }}>
                    <WorkspaceTable title="最近角色" rows={workspace?.recentCharacters || []} columns={[{ key: 'name', label: '名称' }, { key: 'group_name', label: '分组' }, { key: 'is_preset', label: '预设' }, { key: 'updated_at', label: '更新时间' }]} />
                  </Grid>
                </Grid>
                  </>
                ) : null}

                {userDetailTab === 'entitlements' ? (
                  <>
                <AdminSection title="账号权益" subtitle="只配置该用户的独立权益；留空表示不影响会员权益。相同权益会与会员权益合并，开关取开启，数值取更高。">
                  <Stack spacing={1.25}>
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.developerModeEnabled} onChange={(event) => updateAccountEntitlementDraft({ developerModeEnabled: event.target.checked })} />}
                        label="开发者模式"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.cloudSyncEnabled} onChange={(event) => updateAccountEntitlementDraft({ cloudSyncEnabled: event.target.checked })} />}
                        label="云同步"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.assistantArtifactCloudSync} onChange={(event) => updateAccountEntitlementDraft({ assistantArtifactCloudSync: event.target.checked })} />}
                        label="AI 产物云同步"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.aiProxyEnabled} onChange={(event) => updateAccountEntitlementDraft({ aiProxyEnabled: event.target.checked })} />}
                        label="中转站"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.agentEnabled} onChange={(event) => updateAccountEntitlementDraft({ agentEnabled: event.target.checked })} />}
                        label="Agent"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.aiSearchEnabled} onChange={(event) => updateAccountEntitlementDraft({ aiSearchEnabled: event.target.checked })} />}
                        label="AI 搜索"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.multimediaGenerationEnabled} onChange={(event) => updateAccountEntitlementDraft({ multimediaGenerationEnabled: event.target.checked })} />}
                        label="多媒体生成"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.marketAccessEnabled} onChange={(event) => updateAccountEntitlementDraft({ marketAccessEnabled: event.target.checked })} />}
                        label="市场浏览/下载"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.marketUploadEnabled} onChange={(event) => updateAccountEntitlementDraft({ marketUploadEnabled: event.target.checked })} />}
                        label="上传市场"
                      />
                      <FormControlLabel
                        control={<Switch checked={accountEntitlementDraft.chatShareEnabled} onChange={(event) => updateAccountEntitlementDraft({ chatShareEnabled: event.target.checked })} />}
                        label="分享聊天"
                      />
                    </Stack>
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
                      <TextField size="small" label="角色数量上限" value={accountEntitlementDraft.maxCharacters} onChange={(event) => updateAccountEntitlementDraft({ maxCharacters: event.target.value })} placeholder="留空不覆盖" />
                      <TextField size="small" label="聊天数量上限" value={accountEntitlementDraft.maxChats} onChange={(event) => updateAccountEntitlementDraft({ maxChats: event.target.value })} placeholder="留空不覆盖" />
                      <TextField size="small" label="群成员上限" value={accountEntitlementDraft.maxGroupMembers} onChange={(event) => updateAccountEntitlementDraft({ maxGroupMembers: event.target.value })} placeholder="留空不覆盖" />
                      <TextField size="small" label="后台会话上限" type="number" slotProps={{ htmlInput: { min: 1, step: 1 } }} value={accountEntitlementDraft.maxBackgroundConversations} onChange={(event) => updateAccountEntitlementDraft({ maxBackgroundConversations: event.target.value })} placeholder="留空不覆盖" />
                      <TextField size="small" label="每日生成上限" value={accountEntitlementDraft.dailyAiGenerationLimit} onChange={(event) => updateAccountEntitlementDraft({ dailyAiGenerationLimit: event.target.value })} placeholder="留空不覆盖" />
                      <TextField size="small" label="批量生成上限" value={accountEntitlementDraft.batchGenerationLimit} onChange={(event) => updateAccountEntitlementDraft({ batchGenerationLimit: event.target.value })} placeholder="留空不覆盖" />
                      <TextField size="small" label="AI 折扣率" value={accountEntitlementDraft.aiBillingDiscount} onChange={(event) => updateAccountEntitlementDraft({ aiBillingDiscount: event.target.value })} placeholder="例如 0.9" />
                      <TextField size="small" label="每日领取点数" value={accountEntitlementDraft.dailyPointGrant} onChange={(event) => updateAccountEntitlementDraft({ dailyPointGrant: event.target.value })} placeholder="留空不覆盖" />
                      <TextField size="small" label="每月领取点数" value={accountEntitlementDraft.monthlyPointGrant} onChange={(event) => updateAccountEntitlementDraft({ monthlyPointGrant: event.target.value })} placeholder="留空不覆盖" />
                      <TextField size="small" label="额外容量（MB）" value={accountEntitlementDraft.cloudStorageBytes} onChange={(event) => updateAccountEntitlementDraft({ cloudStorageBytes: event.target.value })} placeholder="留空不增加" />
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">官方模型访问</Typography>
                      <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap', gap: 0.75 }}>
                        {accountProviderOptions.map((option) => {
                          const selected = accountEntitlementDraft.officialProviderAccess.includes(option.value);
                          return (
                            <Chip
                              key={option.value}
                              label={option.label}
                              color={selected ? 'primary' : 'default'}
                              variant={selected ? 'filled' : 'outlined'}
                              onClick={() => updateAccountEntitlementDraft({
                                officialProviderAccess: selected
                                  ? accountEntitlementDraft.officialProviderAccess.filter((item) => item !== option.value)
                                  : [...accountEntitlementDraft.officialProviderAccess, option.value],
                              })}
                            />
                          );
                        })}
                      </Stack>
                    </Box>
                    <Box>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', mb: 1 }}>
                        <Box>
                          <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>记忆/运行态上限覆盖</Typography>
                          <Typography variant="caption" color="text.secondary">
                            留空表示不单独覆盖该用户；编辑表格后保存，会与会员权益合并，取更高值。
                          </Typography>
                        </Box>
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={!accountEntitlementDraft.retentionLimitsText.trim()}
                          onClick={() => updateAccountEntitlementDraft({ retentionLimitsText: '' })}
                        >
                          清空记忆上限覆盖
                        </Button>
                      </Stack>
                      {!accountEntitlementDraft.retentionLimitsText.trim() ? (
                        <Alert severity="info" sx={{ mb: 1 }}>
                          当前显示基础会员默认值作为编辑起点；未编辑并保存前不会写入账号独立覆盖。
                        </Alert>
                      ) : null}
                      <AccountRetentionLimitsTable
                        value={accountEntitlementDraft.retentionLimitsText}
                        onChange={(value) => updateAccountEntitlementDraft({ retentionLimitsText: value })}
                      />
                    </Box>
                    <TextField
                      size="small"
                      label="备注"
                      value={accountEntitlementDraft.note}
                      onChange={(event) => updateAccountEntitlementDraft({ note: event.target.value })}
                      fullWidth
                      multiline
                      minRows={2}
                      placeholder="例如：给指定用户开放开发者模式"
                    />
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Button variant="contained" disabled={actionLoading} onClick={() => void saveAccountEntitlement()}>保存账号权益</Button>
                      <Button variant="outlined" disabled={actionLoading} onClick={() => setAccountEntitlementDraft(EMPTY_ACCOUNT_ENTITLEMENT_DRAFT)}>清空表单</Button>
                      <Typography variant="caption" color="text.secondary">清空并保存后，该用户不再拥有独立账号权益。</Typography>
                    </Stack>
                  </Stack>
                </AdminSection>
                  </>
                ) : null}

                {userDetailTab === 'logins' ? (
                  <AdminSection title="登录记录" subtitle="记录当前已接入及后续登录方式的成功与失败。管理员重置只清除失败锁定，不删除审计记录。">
                    <Stack spacing={1.25}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                        <TextField select size="small" label="结果" value={loginResultFilter} onChange={(event) => {
                          const next = event.target.value;
                          setLoginResultFilter(next);
                          if (selectedUserId) void loadLoginRecords(selectedUserId, next, loginMethodFilter);
                        }} sx={{ minWidth: 130 }}>
                          <MenuItem value="all">全部</MenuItem>
                          <MenuItem value="success">成功</MenuItem>
                          <MenuItem value="failure">失败</MenuItem>
                        </TextField>
                        <TextField select size="small" label="登录类型" value={loginMethodFilter} onChange={(event) => {
                          const next = event.target.value;
                          setLoginMethodFilter(next);
                          if (selectedUserId) void loadLoginRecords(selectedUserId, loginResultFilter, next);
                        }} sx={{ minWidth: 160 }}>
                          <MenuItem value="all">全部</MenuItem>
                          <MenuItem value="sms_code">手机号验证码</MenuItem>
                          <MenuItem value="password">密码</MenuItem>
                          <MenuItem value="email">邮箱</MenuItem>
                          <MenuItem value="qq">QQ</MenuItem>
                          <MenuItem value="wechat">微信</MenuItem>
                          <MenuItem value="other">其他</MenuItem>
                        </TextField>
                        <Button variant="outlined" disabled={actionLoading} onClick={() => void resetLoginFailures()}>重置失败等待</Button>
                        <Button variant="text" onClick={() => selectedUserId && void loadLoginRecords(selectedUserId)}>刷新</Button>
                      </Stack>
                      <AdminTableFrame minWidth={640}>
                        <Table size="small">
                          <TableHead><TableRow><TableCell>时间</TableCell><TableCell>方式</TableCell><TableCell>结果</TableCell><TableCell>IP</TableCell><TableCell>状态</TableCell></TableRow></TableHead>
                          <TableBody>
                            {!loginRecords.length ? <TableRow><TableCell colSpan={5}><Alert severity="info">暂无符合筛选条件的登录记录</Alert></TableCell></TableRow> : null}
                            {loginRecords.map((record) => <TableRow key={record.id}>
                              <TableCell>{new Date(record.createdAt).toLocaleString()}</TableCell>
                              <TableCell>{({ sms_code: '手机号验证码', password: '密码', email: '邮箱', qq: 'QQ', wechat: '微信' } as Record<string, string>)[record.method] || record.method}</TableCell>
                              <TableCell><Chip size="small" color={record.result === 'success' ? 'success' : 'error'} label={record.result === 'success' ? '成功' : '失败'} /></TableCell>
                              <TableCell>{record.requestIp || '-'}</TableCell>
                              <TableCell>{record.resetAt ? '已由管理员重置' : '有效'}</TableCell>
                            </TableRow>)}
                          </TableBody>
                        </Table>
                      </AdminTableFrame>
                    </Stack>
                  </AdminSection>
                ) : null}

                {userDetailTab === 'ai' ? (
                  <>
                <AdminSection
                  title={(
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <span>AI点数</span>
                      <Button size="small" variant="outlined" onClick={() => setUsageDialogOpen(true)}>点数详情</Button>
                    </Stack>
                  )}
                >
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between' }}>
                    <Box>
                      <Typography variant="caption" color="text.secondary">剩余点数</Typography>
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>{formatAiAmount(selectedUserWithAiQuota?.aiBalanceAmount ?? 0, 'deepseek')}</Typography>
                    </Box>
                    <Box sx={{ textAlign: { xs: 'left', sm: 'right' } }}>
                      <Typography variant="caption" color="text.secondary">已使用点数</Typography>
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>{formatAiAmount(selectedUserWithAiQuota?.aiUsedAmount ?? 0, 'deepseek')}</Typography>
                    </Box>
                  </Stack>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5, alignItems: { xs: 'stretch', sm: 'center' } }}>
                    <TextField
                      size="small"
                      label="增减点数"
                      value={aiPointDraft}
                      onChange={(event) => setAiPointDraft(event.target.value)}
                      placeholder="负数扣除"
                      sx={{ width: { xs: '100%', sm: 180 } }}
                    />
                    <TextField
                      size="small"
                      label="原因"
                      value={aiPointReasonDraft}
                      onChange={(event) => setAiPointReasonDraft(event.target.value)}
                      placeholder="例如补偿、退款扣回"
                      sx={{ flex: '1 1 220px', minWidth: 180 }}
                    />
                    <Button
                      variant="contained"
                      disabled={actionLoading || !aiPointDraft.trim() || !aiPointReasonDraft.trim()}
                      onClick={() => void transferSelectedUserAiPointsFromCard()}
                      sx={{ height: 40, alignSelf: { xs: 'stretch', sm: 'center' } }}
                    >
                      增减点数
                    </Button>
                    <Typography variant="caption" color="text.secondary">正数转入，负数扣除</Typography>
                  </Stack>
                </AdminSection>

                  {aiKey ? (
                  <AdminSection title="绑定 Key" subtitle="兼容旧 API2D 用户 Key 管理。">
                    {manualKeyDraft.visible ? (
                      <Stack direction="row" spacing={0.75} sx={{ mb: 1.25, alignItems: 'center', flexWrap: 'wrap' }}>
                      <TextField
                        size="small"
                        label="API2D Key"
                        value={manualKeyDraft.apiKey}
                        onChange={(event) => setManualKeyDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
                        sx={{ flex: '1 1 320px', minWidth: 180 }}
                      />
                      <TextField
                        size="small"
                        label="外部 ID"
                        value={manualKeyDraft.externalKeyId}
                        onChange={(event) => setManualKeyDraft((prev) => ({ ...prev, externalKeyId: event.target.value }))}
                        sx={{ flex: '0 1 180px', minWidth: 120 }}
                      />
                      <Button variant="contained" size="small" disabled={actionLoading || !manualKeyDraft.apiKey.trim()} onClick={() => void saveManualKey()} sx={{ minHeight: 32 }}>保存</Button>
                      <Button size="small" disabled={actionLoading} onClick={() => setManualKeyDraft({ visible: false, apiKey: '', externalKeyId: '' })} sx={{ minHeight: 32 }}>取消</Button>
                    </Stack>
                    ) : null}
                    <Stack spacing={1.25}>
                      {[aiKey].map((key) => {
                      const keyId = String(key.id || '');
                      const draft = getKeyDraft(key);
                      const usage = keyUsage[keyId];
                      const keyChanged = draft.apiKey.trim() !== String(key.api_key || '') || draft.externalKeyId.trim() !== String(key.external_key_id || '');
                      return (
                        <Paper key={keyId} variant="outlined" sx={{ p: 1, borderRadius: 1.5 }}>
                          <Stack spacing={1}>
                            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'nowrap', overflowX: 'auto', pb: 0.25 }}>
                              <TextField
                                size="small"
                                label={`${String(key.provider_code || 'api2d').toUpperCase()} Key`}
                                value={draft.apiKey}
                                placeholder={String(key.key_mask || '')}
                                onChange={(event) => updateKeyDraft(key, { apiKey: event.target.value })}
                                sx={{ flex: '1 1 auto', minWidth: 260 }}
                              />
                              <TextField
                                size="small"
                                label="外部 ID"
                                value={draft.externalKeyId}
                                onChange={(event) => updateKeyDraft(key, { externalKeyId: event.target.value })}
                                sx={{ flex: '0 0 160px' }}
                              />
                              {keyChanged && draft.apiKey.trim() ? (
                                <Button size="small" variant="contained" disabled={actionLoading} onClick={() => void saveKeySecret(key)} sx={{ minHeight: 32, flexShrink: 0 }}>保存</Button>
                              ) : null}
                            </Stack>
                            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75, alignItems: 'center' }}>
                              <Chip
                                size="small"
                                label={keyBalanceLoading ? '余额查询中' : `余额：${formatAiBalanceAmount(keyBalance, String(key.provider_code || 'api2d'))}`}
                                variant="outlined"
                                sx={{ height: 28 }}
                              />
                              <TextField
                                size="small"
                                label="转入额度"
                                value={draft.transferAmount}
                                onChange={(event) => updateKeyDraft(key, { transferAmount: event.target.value })}
                                placeholder="负数扣除"
                                sx={{ width: 120 }}
                              />
                              <TextField
                                size="small"
                                label="原因"
                                value={draft.transferReason}
                                onChange={(event) => updateKeyDraft(key, { transferReason: event.target.value })}
                                placeholder="例如补偿、退款扣回"
                                sx={{ width: 180 }}
                              />
                              <Button size="small" variant="outlined" disabled={actionLoading || !draft.transferReason.trim()} onClick={() => void transferKeyPoints(key)} sx={{ minHeight: 30 }}>转入/扣除</Button>
                              <Button size="small" variant="outlined" onClick={() => setExpandedLimits((prev) => ({ ...prev, [keyId]: !prev[keyId] }))} sx={{ minHeight: 30 }}>更新 Key</Button>
                              <Button size="small" variant="outlined" disabled={actionLoading} onClick={() => void loadKeyUsage(key)} sx={{ minHeight: 30 }}>
                                {expandedUsage[keyId] ? '收起消耗' : '查询消耗'}
                              </Button>
                              <Box sx={{ flex: '1 1 auto' }} />
                              <Button size="small" variant="outlined" disabled={actionLoading} onClick={() => void toggleKeyStatus(key)} sx={{ minHeight: 30 }}>
                                {String(key.status || '') === 'active' ? '禁用' : '启用'}
                              </Button>
                            </Stack>
                            {expandedLimits[keyId] ? (
                              <Stack spacing={1}>
                                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                                  <TextField size="small" label="备注" value={draft.note} onChange={(event) => updateKeyDraft(key, { note: event.target.value })} />
                                  <TextField size="small" label="每日额度" value={draft.dailyQuota} onChange={(event) => updateKeyDraft(key, { dailyQuota: event.target.value })} />
                                  <TextField size="small" label="每月额度" value={draft.monthlyQuota} onChange={(event) => updateKeyDraft(key, { monthlyQuota: event.target.value })} />
                                  <TextField size="small" label="每分钟次数" value={draft.minuteTimes} onChange={(event) => updateKeyDraft(key, { minuteTimes: event.target.value })} />
                                  <TextField size="small" label="请求上限" value={draft.requestLimit} onChange={(event) => updateKeyDraft(key, { requestLimit: event.target.value })} />
                                </Stack>
                                <Button size="small" variant="contained" disabled={actionLoading} onClick={() => void updateKeyLimits(key)} sx={{ alignSelf: 'flex-start' }}>保存上限</Button>
                              </Stack>
                            ) : null}
                            {expandedUsage[keyId] ? (
                              <Stack spacing={1}>
                                <Typography variant="subtitle2">额度流水</Typography>
                                {!usage?.quotaLedger?.length ? <Alert severity="info">暂无额度流水</Alert> : null}
                                {usage?.quotaLedger?.length ? (
                                  <AdminTableFrame minWidth={640}>
                                    <Table size="small">
                                      <TableHead>
                                        <TableRow>
                                          <TableCell>类型</TableCell>
                                          <TableCell>来源</TableCell>
                                          <TableCell>额度</TableCell>
                                          <TableCell>状态</TableCell>
                                          <TableCell>时间</TableCell>
                                        </TableRow>
                                      </TableHead>
                                      <TableBody>
                                        {usage.quotaLedger.map((row) => (
                                          <TableRow key={String(row.id)}>
                                            <TableCell>{String(row.entry_type || '-')}</TableCell>
                                            <TableCell>{String(parseMetadata(row.metadata).reason || row.source_type || '-')}</TableCell>
                                            <TableCell>{String(row.amount ?? '-')}</TableCell>
                                            <TableCell>{String(row.status || '-')}</TableCell>
                                            <TableCell>{formatTime(row.created_at)}</TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  </AdminTableFrame>
                                ) : null}
                                <Typography variant="subtitle2">调用消耗</Typography>
                                {!usage?.invocations?.length ? <Alert severity="info">暂无调用记录</Alert> : null}
                                {usage?.invocations?.length ? (
                                  <AdminTableFrame minWidth={760}>
                                    <Table size="small">
                                      <TableHead>
                                        <TableRow>
                                          <TableCell>模型</TableCell>
                                          <TableCell>状态</TableCell>
                                          <TableCell>输入</TableCell>
                                          <TableCell>输出</TableCell>
                                          <TableCell>总量</TableCell>
                                          <TableCell>耗时</TableCell>
                                          <TableCell>时间</TableCell>
                                        </TableRow>
                                      </TableHead>
                                      <TableBody>
                                        {usage.invocations.map((row) => (
                                          <TableRow key={String(row.id)}>
                                            <TableCell>{String(row.model || '-')}</TableCell>
                                            <TableCell>{String(row.status || '-')}</TableCell>
                                            <TableCell>{String(row.input_tokens ?? '-')}</TableCell>
                                            <TableCell>{String(row.output_tokens ?? '-')}</TableCell>
                                            <TableCell>{String(row.total_tokens ?? '-')}</TableCell>
                                            <TableCell>{String(row.latency_ms ?? '-')}</TableCell>
                                            <TableCell>{formatTime(row.created_at)}</TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  </AdminTableFrame>
                                ) : null}
                              </Stack>
                            ) : null}
                          </Stack>
                        </Paper>
                      );
                      })}
                    </Stack>
                  </AdminSection>
                  ) : (
                    <Alert severity="info">该用户当前没有兼容旧 API2D 的绑定 Key。</Alert>
                  )}
                  </>
                ) : null}

                {userDetailTab === 'entitlements' ? (
                  <>
                <AdminSection title="限制项">
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {selectedRestrictions.map((item) => (
                  <Chip
                    key={String(item.id)}
                    label={`${String(item.restriction_type)} · ${String(item.status)}`}
                    color={String(item.status) === 'active' ? 'warning' : 'default'}
                    onDelete={String(item.status) === 'active' ? () => void saveRestriction(String(item.restriction_type || ''), 'inactive') : undefined}
                  />
                ))}
              </Box>
              {!selectedRestrictions.length ? <Alert severity="info">暂无限制项</Alert> : null}
              <Divider />
              <TextField label="限制原因" value={restrictionReason} onChange={(e) => setRestrictionReason(e.target.value)} />
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" disabled={actionLoading} onClick={() => void saveRestriction('share_disabled')}>禁分享</Button>
                <Button variant="outlined" disabled={actionLoading} onClick={() => void saveRestriction('ai_disabled')}>禁AI</Button>
                <Button variant="outlined" disabled={actionLoading} onClick={() => void saveRestriction('sync_disabled')}>禁同步</Button>
              </Stack>
            </AdminSection>
                  </>
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        </DialogContent>
      </Dialog>
      <AdminAiUserUsageDialog
        open={usageDialogOpen}
        user={selectedUserWithAiQuota}
        providerCode="all"
        onClose={() => setUsageDialogOpen(false)}
        onTransferPoints={(userId, amount, reason) => transferSelectedUserAiPoints(userId, amount, reason)}
      />
    </Stack>
  );
}
