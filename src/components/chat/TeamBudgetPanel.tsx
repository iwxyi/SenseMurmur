import { useState } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/useAuthStore';
import type { WorkflowBudget } from '../../types/workflowUsage';

export default function TeamBudgetPanel({ runId, canEdit, onSave }: { runId: string; canEdit: boolean;
  onSave: (input: { limitAmount: string; billingUnit: string; expectedRevision: number }) => Promise<WorkflowBudget> }) {
  const authenticated = useAuthStore((state) => Boolean(state.token && state.isLoggedIn));
  const [budget, setBudget] = useState<WorkflowBudget | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!authenticated) return null;
  const unit = budget?.billingUnit ?? 'point';
  const unitName = unit === 'point' ? '积分' : unit;
  const validAmount = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(amount.trim());
  const update = (value: WorkflowBudget | null) => {
    setBudget(value);
    setAmount(value?.limitAmount ?? '');
    setLoaded(true);
  };
  return <Box sx={{ display: 'grid', gap: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
    <Button size="small" sx={{ justifySelf: 'start' }} disabled={busy} onClick={() => {
      setBusy(true);
      setError(null);
      void api.getWorkflowBudget(runId).then(update).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '查询预算失败');
      }).finally(() => setBusy(false));
    }}>{busy ? '处理中…' : loaded ? '刷新任务预算' : '任务预算'}</Button>
    {error && <Typography role="alert" variant="caption" color="error.main">{error}</Typography>}
    {loaded && <>
      {budget ? <>
        <Typography variant="body2">平台预算 {budget.limitAmount} {unitName} · 已占用 {budget.committedAmount} {unitName}</Typography>
        <Typography variant="body2">剩余 {budget.remainingAmount} {unitName} · 其中预留 {budget.reservedAmount} {unitName}</Typography>
        {budget.exceeded && <Typography role="alert" variant="body2" color="error.main">实际费用已超过预算，后续平台调用已阻止。</Typography>}
        {budget.unresolvedRequests > 0 && <Typography role="alert" variant="body2" color="warning.main">{budget.unresolvedRequests} 次调用的费用待核对，核对完成前不能继续平台调用。</Typography>}
      </> : <Typography variant="body2" color="text.secondary">尚未设置平台金额预算</Typography>}
      {canEdit && <Box sx={{ display: 'flex', gap: 1, alignItems: 'start', flexWrap: 'wrap' }}>
        <TextField size="small" label={`平台总预算（${unitName}）`} value={amount} disabled={busy}
          sx={{ width: 240, maxWidth: '100%' }}
          onChange={(event) => { setAmount(event.target.value); setError(null); }}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
        <Button size="small" disabled={busy || !validAmount} onClick={() => {
          setBusy(true);
          setError(null);
          void onSave({ limitAmount: amount.trim(), billingUnit: unit,
            expectedRevision: budget?.revision ?? 0 }).then(update).catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : '保存预算失败');
          }).finally(() => setBusy(false));
        }}>保存预算</Button>
      </Box>}
      <Typography variant="caption" color="text.secondary">仅约束本任务关联的平台调用，直连第三方费用不在其中；无可靠报价的调用会被阻止，供应商实际费用可能高于报价。</Typography>
    </>}
  </Box>;
}
