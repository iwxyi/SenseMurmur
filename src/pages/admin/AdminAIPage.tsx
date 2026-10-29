import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Chip, Dialog, DialogContent, DialogTitle, FormControlLabel, Paper, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import AdminRequestState, { getAdminErrorMessage } from '../../components/admin/AdminRequestState';
import { AdminMetricGrid, AdminSection, AdminTableFrame, type AdminMetricItem } from '../../components/admin/AdminSurface';
import { adminApi } from '../../services/adminApi';

type BalanceState = {
  loading: boolean;
  value: string;
  error: string | null;
};

function providerSortWeight(item: Record<string, unknown>) {
  const code = String(item.code || '');
  if (code === 'api2d') return 100;
  if (String(item.status || '') === 'active') return 0;
  return 50;
}

function sortProviders(items: Array<Record<string, unknown>>) {
  return items.slice().sort((left, right) => {
    const leftWeight = providerSortWeight(left);
    const rightWeight = providerSortWeight(right);
    if (leftWeight !== rightWeight) return leftWeight - rightWeight;
    return String(left.code || '').localeCompare(String(right.code || ''), 'zh-CN');
  });
}

function formatBalanceNumber(value: number, maximumFractionDigits: number) {
  const rounded = Number(value.toFixed(maximumFractionDigits));
  const displayValue = Object.is(rounded, -0) ? 0 : rounded;
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits,
    minimumFractionDigits: 0,
    useGrouping: false,
  }).format(displayValue);
}

function formatBalance(result: Record<string, unknown>, providerCode: string) {
  const value = Number(result.availableBalance ?? result.available_balance ?? result.balance);
  if (!Number.isFinite(value)) return '未知';
  const normalizedProviderCode = providerCode.trim().toLowerCase();
  const unit = String(result.currencyUnit ?? result.currency_unit ?? '').trim().toLowerCase();
  if (normalizedProviderCode === 'moacode' || normalizedProviderCode === 'moacode-team' || unit === 'moacode_balance' || unit === 'usd') return `$${formatBalanceNumber(value, 2)}`;
  if (normalizedProviderCode === 'api2d') return `${formatBalanceNumber(value, 0)}P`;
  if (normalizedProviderCode === 'deepseek' || unit === 'cny' || unit === 'rmb') return `￥${formatBalanceNumber(value, 2)}`;
  const text = formatBalanceNumber(value, 4);
  return unit ? `${text} ${unit}` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>> : [];
}

function formatOpsNumber(value: unknown, digits = 2) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return '0';
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(parsed);
}

function formatOpsPoints(value: unknown) {
  return `${formatOpsNumber(value, 2)}P`;
}

function formatConfigPoints(value: string) {
  if (value.trim() === '') return '0P';
  return `${formatOpsNumber(Number(value), 2)}P`;
}

function formatOpsPercent(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return '0%';
  return `${formatOpsNumber(parsed * 100, 1)}%`;
}

function buildOpsMetricItem({
  label,
  value,
  subValue,
  tone = 'primary',
}: {
  label: string;
  value: string;
  subValue?: string;
  tone?: AdminMetricItem['tone'];
}): AdminMetricItem {
  return {
    key: label,
    label,
    value,
    helper: subValue,
    tone,
  };
}

function OpsRankingTable({
  title,
  rows,
  labelBuilder,
}: {
  title: string;
  rows: Array<Record<string, unknown>>;
  labelBuilder?: (row: Record<string, unknown>) => string;
}) {
  const displayRows = rows.slice(0, 5);
  return (
    <AdminSection title={title} sx={{ flex: { xs: '0 0 auto', lg: '1 1 360px' }, minWidth: 0 }} bodySx={{ p: 0 }}>
      <AdminTableFrame minWidth={520}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>对象</TableCell>
              <TableCell align="right">请求</TableCell>
              <TableCell align="right">收入</TableCell>
              <TableCell align="right">成本</TableCell>
              <TableCell align="right">毛利</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {displayRows.length ? displayRows.map((row) => (
              <TableRow key={`${String(row.key || '')}-${String(row.providerCode || '')}-${String(row.model || '')}`}>
                <TableCell>
                  <Typography variant="body2" sx={{ fontWeight: 800, lineHeight: 1.3 }}>{labelBuilder ? labelBuilder(row) : String(row.label || row.key || '-')}</Typography>
                </TableCell>
                <TableCell align="right">{formatOpsNumber(row.requestCount, 0)}</TableCell>
                <TableCell align="right">{formatOpsPoints(row.revenuePoints)}</TableCell>
                <TableCell align="right">{formatOpsPoints(row.estimatedCostPoints)}</TableCell>
                <TableCell align="right">
                  <Typography variant="body2" color={Number(row.grossProfitPoints || 0) >= 0 ? 'success.main' : 'error.main'} sx={{ fontWeight: 800 }}>
                    {formatOpsPoints(row.grossProfitPoints)}
                  </Typography>
                </TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>暂无数据</Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </AdminTableFrame>
    </AdminSection>
  );
}

function OpsSummaryPanel({
  summary,
  loading,
  error,
  onRetry,
}: {
  summary: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const today = asRecord(summary?.today);
  const month = asRecord(summary?.month);
  const metricItems = [
    buildOpsMetricItem({ label: '今日收入', value: formatOpsPoints(today.revenuePoints), subValue: `请求 ${formatOpsNumber(today.requestCount, 0)} 次`, tone: 'primary' }),
    buildOpsMetricItem({ label: '今日成本', value: formatOpsPoints(today.estimatedCostPoints), subValue: `毛利 ${formatOpsPoints(today.grossProfitPoints)}`, tone: 'warning' }),
    buildOpsMetricItem({ label: '本月收入', value: formatOpsPoints(month.revenuePoints), subValue: `用户 ${formatOpsNumber(month.activeUsers, 0)} 个`, tone: 'success' }),
    buildOpsMetricItem({ label: '本月毛利率', value: formatOpsPercent(month.grossMargin), subValue: `成本 ${formatOpsPoints(month.estimatedCostPoints)}`, tone: 'info' }),
  ];
  return (
    <AdminSection
      title="AI 成本利润"
      subtitle="按调用收入、估算成本和用途排行查看运营质量"
      action={<Button size="small" variant="outlined" onClick={onRetry} disabled={loading}>刷新看板</Button>}
    >
      <Stack spacing={1.25}>
        <AdminRequestState loading={loading} error={error} onRetry={onRetry} />
        <AdminMetricGrid items={metricItems} minWidth={140} compact />
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1} sx={{ alignItems: 'stretch' }}>
          <OpsRankingTable title="Provider 排行" rows={asArray(summary?.providers)} />
          <OpsRankingTable title="模型排行" rows={asArray(summary?.models)} labelBuilder={(row) => [row.providerCode, row.model || row.label].filter(Boolean).join(' / ')} />
        </Stack>
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1} sx={{ alignItems: 'stretch' }}>
          <OpsRankingTable title="用途排行" rows={asArray(summary?.usages)} />
          <OpsRankingTable title="高消耗用户" rows={asArray(summary?.users)} labelBuilder={(row) => String(row.userNickname || row.userPhone || row.userId || row.label || '-')} />
        </Stack>
      </Stack>
    </AdminSection>
  );
}

function GlobalPointConfigPanel({
  form,
  loading,
  error,
  onOpen,
  onRetry,
}: {
  form: {
    aiEnabled: boolean;
    defaultProvisionEnabled: boolean;
    defaultGrantAmount: string;
  };
  loading: boolean;
  error: string | null;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const metricItems: AdminMetricItem[] = [
    buildOpsMetricItem({ label: 'AI 平台', value: form.aiEnabled ? '开启' : '关闭', tone: form.aiEnabled ? 'success' : 'warning' }),
    buildOpsMetricItem({
      label: '注册默认点数',
      value: formatConfigPoints(form.defaultGrantAmount),
      subValue: form.defaultProvisionEnabled ? '自动发放' : '未启用',
      tone: form.defaultProvisionEnabled ? 'success' : 'warning',
    }),
    buildOpsMetricItem({
      label: '自动发放',
      value: form.defaultProvisionEnabled ? '开启' : '关闭',
      tone: 'default',
    }),
  ];
  return (
    <AdminSection
      title="AI 全局配置"
      action={<Button variant="outlined" size="small" onClick={onOpen}>编辑全局配置</Button>}
    >
      <Stack spacing={1.25}>
        <AdminRequestState loading={loading} error={error} onRetry={onRetry} />
        <AdminMetricGrid items={metricItems} minWidth={132} compact />
      </Stack>
    </AdminSection>
  );
}

function ProviderTable({
  items,
  balances,
  onOpen,
}: {
  items: Array<Record<string, unknown>>;
  balances: Record<string, BalanceState>;
  onOpen: (providerCode: string) => void;
}) {
  return (
    <AdminTableFrame minWidth={760}>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>Code</TableCell>
            <TableCell>Name</TableCell>
            <TableCell>AI 调用地址</TableCell>
            <TableCell>余额</TableCell>
            <TableCell>Status</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {items.map((item) => {
            const code = String(item.code || '');
            const balance = balances[code];
            return (
              <TableRow
                key={String(item.id)}
                hover
                onClick={() => onOpen(code)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell>{code}</TableCell>
                <TableCell>{String(item.name || '')}</TableCell>
                <TableCell>{String(item.base_url || '')}</TableCell>
                <TableCell>
                  {balance?.loading ? (
                    <Typography variant="body2" color="text.secondary">查询中</Typography>
                  ) : balance?.error ? (
                    <Tooltip title={balance.error} arrow placement="top">
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ display: 'inline-flex', fontWeight: 800, cursor: 'help' }}
                      >
                        —
                      </Typography>
                    </Tooltip>
                  ) : (
                    <Typography variant="body2" sx={{ fontWeight: 800 }}>{balance?.value || '-'}</Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={String(item.status || '') === 'active' ? '启用' : '停用'}
                    color={String(item.status || '') === 'active' ? 'success' : 'default'}
                    sx={{ height: 22 }}
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

export default function AdminAIPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [balances, setBalances] = useState<Record<string, BalanceState>>({});

  const [opsSummary, setOpsSummary] = useState<Record<string, unknown> | null>(null);
  const [globalDialogOpen, setGlobalDialogOpen] = useState(false);
  const [globalForm, setGlobalForm] = useState({
    aiEnabled: true,
    defaultProvisionEnabled: true,
    defaultGrantAmount: '',
    defaultDailyQuota: '',
    defaultMonthlyQuota: '',
    defaultPlanCode: 'default',
  });
  const [loading, setLoading] = useState(false);

  const [opsLoading, setOpsLoading] = useState(false);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalSaving, setGlobalSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [opsError, setOpsError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const providerStats = useMemo(() => ({
    total: items.length,
    active: items.filter((item) => String(item.status || '') === 'active').length,
    disabled: items.filter((item) => String(item.status || '') !== 'active').length,
  }), [items]);

  const loadProviders = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminApi.getAiProviders();
      const nextItems = sortProviders(result.items || []);
      setItems(nextItems);
      setBalances(Object.fromEntries(nextItems.map((item) => [String(item.code || ''), {
        loading: item.accountBalanceSupported !== false,
        value: item.accountBalanceSupported === false ? '不支持查询' : '',
        error: null,
      }])));
      void Promise.all(nextItems.map(async (item) => {
        const code = String(item.code || '');
        if (!code || item.accountBalanceSupported === false) return;
        try {
          const balance = await adminApi.getAiProviderAccountBalance(code);
          setBalances((prev) => ({ ...prev, [code]: { loading: false, value: formatBalance(balance, code), error: null } }));
        } catch (balanceError) {
          setBalances((prev) => ({ ...prev, [code]: { loading: false, value: '', error: getAdminErrorMessage(balanceError) } }));
        }
      }));
    } catch (loadError) {
      setError(getAdminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };



  const loadOpsSummary = async () => {
    setOpsLoading(true);
    setOpsError(null);
    try {
      const result = await adminApi.getAiOpsSummary();
      setOpsSummary(result);
    } catch (loadError) {
      setOpsError(getAdminErrorMessage(loadError));
    } finally {
      setOpsLoading(false);
    }
  };

  const loadGlobalConfig = async () => {
    setGlobalLoading(true);
    setGlobalError(null);
    try {
      const result = await adminApi.getPlatformGlobalConfig();
      const ai = result.ai || {};
      setGlobalForm({
        aiEnabled: ai.aiEnabled !== false,
        defaultProvisionEnabled: ai.defaultProvisionEnabled == null ? true : Boolean(ai.defaultProvisionEnabled),
        defaultGrantAmount: ai.defaultGrantAmount == null ? '' : String(ai.defaultGrantAmount),
        defaultDailyQuota: ai.defaultDailyQuota == null ? '' : String(ai.defaultDailyQuota),
        defaultMonthlyQuota: ai.defaultMonthlyQuota == null ? '' : String(ai.defaultMonthlyQuota),
        defaultPlanCode: ai.defaultPlanCode == null ? '' : String(ai.defaultPlanCode),
      });
    } catch (loadError) {
      setGlobalError(getAdminErrorMessage(loadError));
    } finally {
      setGlobalLoading(false);
    }
  };

  const openGlobalDialog = () => {
    setGlobalDialogOpen(true);
    void loadGlobalConfig();
  };

  const saveGlobalConfig = async () => {
    setGlobalSaving(true);
    setGlobalError(null);
    try {
      await adminApi.updatePlatformGlobalConfig({
        ai: {
          aiEnabled: globalForm.aiEnabled,
          defaultProvisionEnabled: globalForm.defaultProvisionEnabled,
          defaultGrantAmount: globalForm.defaultGrantAmount ? Number(globalForm.defaultGrantAmount) : 0,
          defaultDailyQuota: globalForm.defaultDailyQuota ? Number(globalForm.defaultDailyQuota) : 0,
          defaultMonthlyQuota: globalForm.defaultMonthlyQuota ? Number(globalForm.defaultMonthlyQuota) : 0,
          defaultPlanCode: globalForm.defaultPlanCode.trim() || null,
        },
      });
      setGlobalDialogOpen(false);
      await loadGlobalConfig();
    } catch (saveError) {
      setGlobalError(getAdminErrorMessage(saveError));
    } finally {
      setGlobalSaving(false);
    }
  };

  useEffect(() => {
    void loadProviders();
    void loadOpsSummary();
    void loadGlobalConfig();
  }, []);

  const providerMetricItems = [
    buildOpsMetricItem({ label: '全部供应商', value: formatOpsNumber(providerStats.total, 0), subValue: '当前配置', tone: 'info' }),
    buildOpsMetricItem({ label: '启用供应商', value: formatOpsNumber(providerStats.active, 0), subValue: '可供调用', tone: 'success' }),
    buildOpsMetricItem({ label: '停用供应商', value: formatOpsNumber(providerStats.disabled, 0), subValue: '保留兼容', tone: 'warning' }),
  ];

  return (
    <Stack spacing={1.5}>
      <AdminSection
        title="AI 供应商运营"
        subtitle="供应商、余额"
      >
        <AdminMetricGrid items={providerMetricItems} minWidth={132} compact />
      </AdminSection>

      <GlobalPointConfigPanel
        form={globalForm}
        loading={globalLoading}
        error={globalError}
        onOpen={openGlobalDialog}
        onRetry={() => void loadGlobalConfig()}
      />

      <OpsSummaryPanel summary={opsSummary} loading={opsLoading} error={opsError} onRetry={() => void loadOpsSummary()} />

      <AdminSection
        title="供应商列表"
        subtitle="点击行进入对应供应商配置与用量详情"
        action={<Button size="small" onClick={() => void loadProviders()} disabled={loading}>刷新</Button>}
        bodySx={{ p: 0 }}
      >
        <Box sx={{ px: 1.5, pt: 0.75, pb: error || loading ? 0.75 : 0 }}>
          <AdminRequestState loading={loading} error={error} onRetry={() => void loadProviders()} />
        </Box>
        <ProviderTable items={items} balances={balances} onOpen={(providerCode) => navigate(`/admin/platform/ai/providers/${encodeURIComponent(providerCode)}`)} />
      </AdminSection>

      <Dialog open={globalDialogOpen} onClose={() => setGlobalDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>AI 全局配置</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <AdminRequestState loading={globalLoading} error={globalError} onRetry={() => void loadGlobalConfig()} />
            <FormControlLabel
              control={<Switch checked={globalForm.aiEnabled} disabled={globalLoading || globalSaving} onChange={(event) => setGlobalForm((prev) => ({ ...prev, aiEnabled: event.target.checked }))} />}
              label="启用 AI 平台"
            />
            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
              <Stack spacing={1.25}>
                <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>新用户默认发放</Typography>
                <FormControlLabel
                  control={<Switch checked={globalForm.defaultProvisionEnabled} onChange={(event) => setGlobalForm((prev) => ({ ...prev, defaultProvisionEnabled: event.target.checked }))} />}
                  label="新用户注册后自动开通默认 AI 权益并分配额度"
                />
                <TextField label="默认点数" value={globalForm.defaultGrantAmount} onChange={(event) => setGlobalForm((prev) => ({ ...prev, defaultGrantAmount: event.target.value }))} fullWidth />
              </Stack>
            </Paper>
            <Button variant="contained" disabled={globalSaving || globalLoading} onClick={() => void saveGlobalConfig()}>保存全局配置</Button>
          </Stack>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
