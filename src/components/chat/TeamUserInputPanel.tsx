import { useState } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import type { WorkflowSnapshot, WorkflowTask } from '../../services/workflowRunRuntime';

export default function TeamUserInputPanel({ run, task, disabled, onAnswer }: {
  run: WorkflowSnapshot;
  task: WorkflowTask;
  disabled: boolean;
  onAnswer: (run: WorkflowSnapshot, task: WorkflowTask, answer: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = task.input;
  const question = input && typeof input === 'object' && 'task' in input && input.task && typeof input.task === 'object'
    && 'goal' in input.task && typeof input.task.goal === 'string' ? input.task.goal : '请补充完成任务所需的信息';
  return <Box sx={{ display: 'grid', gap: 1, overflowWrap: 'anywhere' }}>
    <Typography variant="subtitle2">等待你的答复</Typography>
    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{question}</Typography>
    <TextField multiline minRows={2} fullWidth size="small" label="你的答复" value={answer}
      disabled={disabled || saving} onChange={(event) => { setAnswer(event.target.value); setError(null); }}
      slotProps={{ htmlInput: { maxLength: 4000 } }} />
    {error && <Typography role="alert" variant="caption" color="error.main">{error}</Typography>}
    <Box><Button size="small" variant="outlined" disabled={disabled || saving || !answer.trim()} onClick={() => {
      setSaving(true);
      setError(null);
      void onAnswer(run, task, answer).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '保存答复失败');
      }).finally(() => setSaving(false));
    }}>{saving ? '正在保存' : '答复并继续'}</Button></Box>
  </Box>;
}
