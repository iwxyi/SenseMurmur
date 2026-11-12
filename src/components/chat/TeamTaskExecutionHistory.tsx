import { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { currentWorkflowScope, indexedDbWorkflowRepository, type WorkflowTaskStatus } from '../../services/workflowRunRuntime';
import type { WorkflowTaskAttempt } from '../../services/workflowTaskAttempt';
import type { WorkflowModelInvocation } from '../../services/workflowModelInvocation';

const invocationLabels: Record<WorkflowModelInvocation['state'], string> = {
  reserved: '等待调用模型', started: '模型请求已开始', succeeded: '模型请求已完成',
  failed: '模型调用后处理失败', result_unknown: '模型结果待核对', not_started: '未调用模型',
};

interface Props { runId: string; taskId: string; updatedAt: number; statusLabels: Record<WorkflowTaskStatus, string> }

export default function TeamTaskExecutionHistory({ runId, taskId, updatedAt, statusLabels }: Props) {
  const [open, setOpen] = useState(false);
  const scope = currentWorkflowScope();
  const requestKey = JSON.stringify([scope, runId, taskId, updatedAt]);
  const [result, setResult] = useState<{ key: string; attempts: WorkflowTaskAttempt[]; error?: string } | null>(null);
  const loading = result?.key !== requestKey;
  const attempts = loading ? [] : result.attempts;
  const error = loading ? undefined : result.error;
  useEffect(() => {
    if (!open) return;
    let active = true;
    void indexedDbWorkflowRepository.listTaskAttempts(scope, runId, taskId).then((result) => {
      if (active && currentWorkflowScope() === scope) setResult({ key: requestKey, attempts: result });
    }).catch((failure: unknown) => {
      if (active && currentWorkflowScope() === scope) setResult({ key: requestKey, attempts: [], error: failure instanceof Error ? failure.message : '读取执行记录失败' });
    });
    return () => { active = false; };
  }, [open, scope, runId, taskId, requestKey]);
  return <Box sx={{ display: 'grid', gap: 0.5 }}>
    <Button size="small" aria-expanded={open} onClick={() => setOpen((value) => !value)} sx={{ justifySelf: 'start' }}>{open ? '收起执行记录' : '查看执行记录'}</Button>
    {open && <Box role="region" aria-label="任务执行记录" sx={{ display: 'grid', gap: 0.75 }}>
      {loading && <CircularProgress size={16} aria-label="读取执行记录" />}
      {error && <Typography variant="caption" color="error.main">{error}</Typography>}
      {!loading && !error && !attempts.length && <Typography variant="caption" color="text.secondary">暂无执行记录</Typography>}
      {attempts.map((attempt) => <Box key={attempt.attempt}>
        <Typography variant="body2">第 {attempt.attempt} 次执行 · {statusLabels[attempt.status]} · 计划 {attempt.planVersion}</Typography>
        {attempt.modelInvocation && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{invocationLabels[attempt.modelInvocation.state]}</Typography>}
        <Typography variant="caption" color="text.secondary">{new Date(attempt.startedAt).toLocaleString()}{attempt.finishedAt ? ` 至 ${new Date(attempt.finishedAt).toLocaleString()}` : ''}</Typography>
      </Box>)}
    </Box>}
  </Box>;
}
