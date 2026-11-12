import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import { pendingWorkflowApproval } from '../../services/workflowApproval';
import type { WorkflowSnapshot, WorkflowTask } from '../../services/workflowRunRuntime';

export default function TeamApprovalPanel({ run, task, disabled, onDecide }: {
  run: WorkflowSnapshot;
  task: WorkflowTask;
  disabled: boolean;
  onDecide: (run: WorkflowSnapshot, task: WorkflowTask, outcome: 'approved' | 'rejected') => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approval = pendingWorkflowApproval(task);
  if (!approval) return null;
  const quote = approval.mediaExecution?.quote;
  function decide(outcome: 'approved' | 'rejected') {
    setSaving(true);
    setError(null);
    void onDecide(run, task, outcome).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : '保存审批失败');
    }).finally(() => setSaving(false));
  }
  return <Box sx={{ display: 'grid', gap: 1, overflowWrap: 'anywhere' }}>
    <Typography variant="subtitle2">{task.approvals?.at(-2)?.invalidatedAt !== undefined ? '模型、生成设置、预算或报价已更改，请重新确认' : '等待你的确认'}</Typography>
    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{approval.summary}</Typography>
    <Typography variant="body2" color="warning.main" sx={{ whiteSpace: 'pre-wrap' }}>{approval.consequences}</Typography>
    {quote && <Box sx={{ display: 'grid', gap: 0.5 }}>
      <Typography variant="body2">模型：{quote.model}</Typography>
      <Typography variant="body2">{quote.kind === 'usage_estimate' ? '预估费用' : '本次报价'}：{quote.amount} {quote.unit === 'point' ? '积分' : quote.unit}</Typography>
      <Typography variant="caption" color="text.secondary">
        报价有效至 {new Date(quote.expiresAt).toLocaleTimeString()}，过期后需要重新确认。
        {quote.kind === 'usage_estimate' ? '最终费用以实际用量结算。' : ''}
      </Typography>
    </Box>}
    {run.run.goalSpec?.platformBudget && <Typography variant="body2" color="text.secondary">
      平台任务总预算 {run.run.goalSpec.platformBudget.limitAmount} {run.run.goalSpec.platformBudget.billingUnit === 'point' ? '积分' : run.run.goalSpec.platformBudget.billingUnit}
    </Typography>}
    {task.dependsOn.map((id) => run.tasks.find((item) => item.id === id)).filter((item) => typeof item?.output === 'string').map((item) =>
      <Typography key={item!.id} variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>{String(item!.output).slice(0, 2000)}{String(item!.output).length > 2000 ? '…' : ''}</Typography>)}
    {error && <Typography role="alert" variant="caption" color="error.main">{error}</Typography>}
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button size="small" variant="outlined" disabled={disabled || saving} onClick={() => decide('approved')}>批准本次执行</Button>
      <Button size="small" color="error" disabled={disabled || saving} onClick={() => decide('rejected')}>拒绝并停止任务组</Button>
    </Stack>
  </Box>;
}
