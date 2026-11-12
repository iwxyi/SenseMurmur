import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/useAuthStore';
import type { WorkflowUsageSummary } from '../../types/workflowUsage';

function unitLabel(unit: string | null) {
  if (unit === 'point' || unit === 'p') return '积分';
  if (unit === 'cny' || unit === 'rmb') return '元';
  if (unit === 'usd') return '美元';
  return unit || '单位未知';
}

export default function TeamUsagePanel({ runId }: { runId: string }) {
  const authenticated = useAuthStore((state) => Boolean(state.token && state.isLoggedIn));
  const [summary, setSummary] = useState<WorkflowUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!authenticated) return null;
  return <Box sx={{ display: 'grid', gap: 0.5, minWidth: 0 }}>
    <Button size="small" sx={{ justifySelf: 'start' }} disabled={loading} onClick={() => {
      setLoading(true);
      setError(null);
      void api.getWorkflowUsage(runId).then(setSummary).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '查询费用失败');
      }).finally(() => setLoading(false));
    }}>{loading ? '查询费用中…' : summary ? '刷新任务费用' : '查询任务费用'}</Button>
    {error && <Typography role="alert" variant="caption" color="error.main">{error}</Typography>}
    {summary && <>
      {summary.units.length ? summary.units.map((unit) => <Box key={unit.billingUnit ?? 'unknown'} sx={{ overflowWrap: 'anywhere' }}>
        <Typography variant="body2">已结算 {unit.settledAmount} {unitLabel(unit.billingUnit)} · 预留 {unit.reservedAmount} {unitLabel(unit.billingUnit)}</Typography>
        <Typography variant="caption" color="text.secondary">已结束 {unit.settledRequests} 次 · 待结算 {unit.pendingRequests} 次{unit.unpricedRequests ? ` · 费用未知 ${unit.unpricedRequests} 次` : ''}</Typography>
      </Box>) : <Typography variant="body2" color="text.secondary">暂无关联账单</Typography>}
      <Typography variant="caption" color="text.secondary">截至 {new Date(summary.asOf).toLocaleString()} 的可查平台记录；不含未关联的历史调用、直连第三方及部分语音费用。预留金额并非最终费用。</Typography>
    </>}
  </Box>;
}
