import { useState } from 'react';
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, TextField, Typography } from '@mui/material';
import type { WorkflowSnapshot, WorkflowTask } from '../../services/workflowRunRuntime';
import { countWorkflowModelCalls, summarizeWorkflowRun } from '../../services/workflowRunRuntime';
import { validateAgentTeamPlan } from '../../services/agentTeamPlan';
import { buildAgentTeamTaskRevisionRequest, isRecoverableAgentTeamRun } from '../../services/agentTeamWorkflow';

interface Props {
  runs: WorkflowSnapshot[];
  canRun: boolean;
  isRunActive: (runId: string) => boolean;
  onResume: (run: WorkflowSnapshot) => void;
  onResumeAll: (runs: WorkflowSnapshot[]) => Promise<void>;
  onCreate: () => void;
  onInstruct: (run: WorkflowSnapshot, task: WorkflowTask, instruction: string) => Promise<void>;
  onPause: (run: WorkflowSnapshot) => Promise<void>;
  onUpdateModelCallLimit: (run: WorkflowSnapshot, limit?: number) => Promise<void>;
  onDelegate: (run: WorkflowSnapshot, request: string) => Promise<void>;
  onAbandonReview: (run: WorkflowSnapshot, task: WorkflowTask) => Promise<void>;
  onResumeAfterReviewRetry: (run: WorkflowSnapshot, task: WorkflowTask) => Promise<void>;
  onResumeAfterPlanRetry: (run: WorkflowSnapshot, task: WorkflowTask) => Promise<void>;
}

const taskStatus: Record<WorkflowTask['status'], string> = {
  queued: '排队', running: '执行中', waiting_dependency: '等待前置步骤', waiting_external: '等待生成',
  waiting_user: '等待用户', result_unknown: '待核对', completed: '已完成', failed: '失败', cancelled: '已取消', abandoned: '已放弃',
};

function teamPlan(run: WorkflowSnapshot) {
  const raw = run.tasks.find((task) => task.kind === 'team_plan')?.output;
  if (!raw) return null;
  try { return validateAgentTeamPlan(raw); } catch { return null; }
}

function taskDetails(task: WorkflowTask) {
  const input = task.input;
  if (!input || typeof input !== 'object' || !('task' in input)) return null;
  const value = input as { task?: { goal?: unknown; acceptance?: unknown }; role?: { name?: unknown; responsibility?: unknown; method?: unknown } };
  if (typeof value.task?.goal !== 'string') return null;
  return {
    goal: value.task.goal,
    acceptance: typeof value.task.acceptance === 'string' ? value.task.acceptance : '',
    role: typeof value.role?.name === 'string' ? value.role.name : '子 Agent',
    responsibility: typeof value.role?.responsibility === 'string' ? value.role.responsibility : '',
    method: typeof value.role?.method === 'string' ? value.role.method : '',
  };
}

export default function AssistantTeamWorkbench({ runs, canRun, isRunActive, onResume, onResumeAll, onCreate, onInstruct, onPause, onUpdateModelCallLimit, onDelegate, onAbandonReview, onResumeAfterReviewRetry, onResumeAfterPlanRetry }: Props) {
  const [open, setOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [savingInstruction, setSavingInstruction] = useState(false);
  const [instructionError, setInstructionError] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [delegateRequest, setDelegateRequest] = useState('');
  const [delegateError, setDelegateError] = useState<string | null>(null);
  const [savingDelegate, setSavingDelegate] = useState(false);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [savingReviewAction, setSavingReviewAction] = useState(false);
  const [reviewActionRunId, setReviewActionRunId] = useState<string | null>(null);
  const [resumingAll, setResumingAll] = useState(false);
  const [resumeAllError, setResumeAllError] = useState<string | null>(null);
  const [modelCallLimit, setModelCallLimit] = useState('');
  const [savingLimit, setSavingLimit] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);
  if (!runs.length) return null;
  const run = runs.find((item) => item.run.id === selectedRunId) || runs[0];
  const task = run.tasks.find((item) => item.id === selectedTaskId) || null;
  const details = task ? taskDetails(task) : null;
  const plan = teamPlan(run);
  const summary = summarizeWorkflowRun(run);
  const latestReview = run.tasks.filter((item) => item.kind === 'team_review' && item.status === 'completed').at(-1);
  const reviewResult = latestReview?.output && typeof latestReview.output === 'object' && !Array.isArray(latestReview.output)
    ? latestReview.output as { complete?: unknown; reason?: unknown } : null;
  const childTasks = run.tasks.filter((item) => item.kind === 'agent_text' || item.kind === 'agent_web_search' || item.kind === 'agent_image' || item.kind === 'agent_image_inspection' || item.kind === 'agent_audio' || item.kind === 'agent_video');
  const blocked = summary.blocked.length > 0;
  const running = isRunActive(run.run.id);
  const modelCallLimitReached = run.run.maxModelCalls !== undefined && countWorkflowModelCalls(run) >= run.run.maxModelCalls;
  const editable = Boolean(canRun && task && run.run.status === 'paused' && (task.kind === 'agent_text' || task.kind === 'agent_web_search' || task.kind === 'agent_image' || task.kind === 'agent_image_inspection' || task.kind === 'agent_audio' || task.kind === 'agent_video') && task.attempt === 0
    && (task.status === 'queued' || task.status === 'waiting_dependency'));
  const unknownReview = run.tasks.find((item) => item.kind === 'team_review' && item.status === 'result_unknown');
  const failedReview = run.tasks.find((item) => item.kind === 'team_review' && item.status === 'failed');
  const failedPlan = run.tasks.find((item) => (item.kind === 'team_plan' || item.kind === 'team_plan_revision') && item.status === 'failed');
  const canAddRevision = canRun && (run.run.status === 'paused' || run.run.status === 'completed')
    && !run.tasks.some((item) => item.status === 'running' || item.status === 'result_unknown' || item.status === 'failed'
      || (item.kind === 'team_plan_revision' && item.status !== 'completed'));
  const canReviseSelectedTask = Boolean(canAddRevision && task && details && childTasks.includes(task)
    && task.status === 'completed' && task.attempt > 0);
  const canInstructSelectedTask = editable || canReviseSelectedTask;
  const resumableRuns = runs.filter(isRecoverableAgentTeamRun);

  return <>
    <Box role="status" sx={{ position: 'absolute', top: { xs: 'calc(66px + env(safe-area-inset-top, 0px))', sm: 58 }, left: 12, right: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.5, borderRadius: 1.5, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', boxShadow: 1, minWidth: 0 }}>
      <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>{run.run.goal}</Typography>
      <Chip size="small" color={blocked ? 'warning' : running ? 'primary' : 'default'} label={blocked ? '需处理' : running ? '运行中' : `${summary.completed.length}/${run.tasks.length} 步`} />
      <Button size="small" onClick={() => setOpen(true)}>工作台</Button>
    </Box>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md" aria-labelledby="team-workbench-title">
      <DialogTitle id="team-workbench-title">团队工作台</DialogTitle>
      <DialogContent dividers sx={{ display: 'grid', gap: 2, minHeight: 260 }}>
        {runs.length > 1 && <Stack direction="row" spacing={0.75} sx={{ overflowX: 'auto', pb: 0.5 }}>
          {runs.map((item, index) => <Chip key={item.run.id} size="small" clickable color={item.run.id === run.run.id ? 'primary' : 'default'} label={teamPlan(item)?.summary || `任务 ${index + 1}`} onClick={() => { setSelectedRunId(item.run.id); setSelectedTaskId(null); setReviewActionError(null); }} />)}
        </Stack>}
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{plan?.summary || run.run.goal}</Typography>
          <Typography variant="body2" color="text.secondary">{run.run.pauseRequested ? '当前步骤完成后暂停' : running ? '运行中' : run.run.status === 'completed' ? '已完成' : run.run.status === 'paused' ? '已暂停' : run.run.status === 'failed' ? '失败' : '等待执行'} · 已完成 {summary.completed.length}/{run.tasks.length} 步{run.run.maxModelCalls ? ` · 模型调用 ${countWorkflowModelCalls(run)}/${run.run.maxModelCalls}` : ''}</Typography>
          {modelCallLimitReached && run.run.status === 'paused' && <Typography variant="body2" color="warning.main">已达到模型调用上限。调整上限后可继续，已有结果会保留。</Typography>}
        </Box>
        {canRun && !running && run.run.status === 'paused' && <Box sx={{ display: 'grid', gap: 1 }}>
          <TextField size="small" type="number" label="新的模型调用总上限" value={modelCallLimit} onChange={(event) => { setModelCallLimit(event.target.value); setLimitError(null); }} disabled={savingLimit} helperText="留空表示不限制，保存后点击继续整个任务。" slotProps={{ htmlInput: { min: countWorkflowModelCalls(run) + 1, max: 1000, step: 1 } }} />
          {limitError && <Typography variant="caption" color="error.main">{limitError}</Typography>}
          <Button size="small" disabled={savingLimit || Boolean(modelCallLimit.trim() && (!Number.isSafeInteger(Number(modelCallLimit)) || Number(modelCallLimit) <= countWorkflowModelCalls(run) || Number(modelCallLimit) > 1000))} onClick={() => {
            setSavingLimit(true);
            void onUpdateModelCallLimit(run, modelCallLimit.trim() ? Number(modelCallLimit) : undefined)
              .then(() => { setLimitError(null); setModelCallLimit(''); })
              .catch((error: unknown) => setLimitError(error instanceof Error ? error.message : '调整模型调用上限失败'))
              .finally(() => setSavingLimit(false));
          }}>保存调用上限</Button>
        </Box>}
        <Stack direction="row" spacing={0.75} sx={{ overflowX: 'auto', pb: 0.5 }}>
          <Chip size="small" clickable color={!task ? 'primary' : 'default'} label="总览与主 Agent" onClick={() => setSelectedTaskId(null)} />
          {childTasks.map((item, index) => <Chip key={item.id} size="small" clickable color={task?.id === item.id ? 'primary' : 'default'} label={`${taskDetails(item)?.role || `子 Agent ${index + 1}`} · ${taskStatus[item.status]}`} onClick={() => setSelectedTaskId(item.id)} />)}
        </Stack>
        <Divider />
        {task && details ? <Box sx={{ display: 'grid', gap: 1.5, overflowWrap: 'anywhere' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{details.role} · {taskStatus[task.status]}</Typography>
          <Typography variant="body2"><strong>任务</strong> {details.goal}</Typography>
          {details.responsibility && <Typography variant="body2"><strong>职责</strong> {details.responsibility}</Typography>}
          {details.method && <Typography variant="body2"><strong>方法</strong> {details.method}</Typography>}
          {details.acceptance && <Typography variant="body2"><strong>验收</strong> {details.acceptance}</Typography>}
          {task.error && <Typography variant="body2" color="error.main"><strong>问题</strong> {task.error}</Typography>}
          {typeof (task.input as { userInstruction?: unknown })?.userInstruction === 'string' && <Typography variant="body2"><strong>用户指示</strong> {String((task.input as { userInstruction: string }).userInstruction)}</Typography>}
          {canInstructSelectedTask && <Box sx={{ display: 'grid', gap: 1 }}>
            <TextField multiline minRows={2} fullWidth size="small" label={editable ? '补充该子任务的指示' : '与该子 Agent 继续协作'} value={instruction} onChange={(event) => { setInstruction(event.target.value); setInstructionError(null); }} slotProps={{ htmlInput: { maxLength: 4000 } }} disabled={savingInstruction} />
            {canReviseSelectedTask && <Typography variant="caption" color="text.secondary">主 Agent 会根据已有交付为该角色规划后续工作。</Typography>}
            {instructionError && <Typography variant="caption" color="error.main">{instructionError}</Typography>}
            <Button size="small" variant="outlined" disabled={!instruction.trim() || savingInstruction} onClick={() => {
              setSavingInstruction(true);
              const operation = editable
                ? onInstruct(run, task, instruction)
                : onDelegate(run, buildAgentTeamTaskRevisionRequest(task, instruction));
              void operation.then(() => { setInstruction(''); setInstructionError(null); }).catch((error: unknown) => {
                setInstructionError(error instanceof Error ? error.message : '保存指示失败');
              }).finally(() => setSavingInstruction(false));
            }}>{editable ? '保存指示' : '发送给主 Agent'}</Button>
          </Box>}
          {typeof task.output === 'string' && <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: 'action.hover', maxHeight: 300, overflowY: 'auto' }}><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.output}</Typography></Box>}
        </Box> : <Box sx={{ display: 'grid', gap: 1.25, overflowWrap: 'anywhere' }}>
          <Typography variant="body2"><strong>目标</strong> {run.run.goal}</Typography>
          {plan?.finalAcceptance && <Typography variant="body2"><strong>最终验收</strong> {plan.finalAcceptance}</Typography>}
          {reviewResult && typeof reviewResult.reason === 'string' && <Typography variant="body2" color={reviewResult.complete === true ? 'text.secondary' : 'warning.main'}><strong>主 Agent 验收</strong> {reviewResult.reason}</Typography>}
          {summary.blocked.length > 0 && <Typography variant="body2" color="warning.main"><strong>需要处理</strong> {summary.blocked.map((item) => item.reason).join('；')}</Typography>}
          {unknownReview && canRun && run.run.status === 'paused' && <Box sx={{ display: 'grid', gap: 0.75 }}>
            <Typography variant="body2" color="text.secondary">上次验收请求的结果无法核对。放弃本次验收后，仍需追加明确任务才能继续；原结果会保留为未知记录。</Typography>
            {reviewActionError && reviewActionRunId === run.run.id && <Typography variant="caption" color="error.main">{reviewActionError}</Typography>}
            <Button size="small" variant="outlined" disabled={savingReviewAction} onClick={() => {
              setSavingReviewAction(true);
              setReviewActionRunId(run.run.id);
              void onAbandonReview(run, unknownReview).then(() => setReviewActionError(null)).catch((error: unknown) => {
                setReviewActionRunId(run.run.id);
                setReviewActionError(error instanceof Error ? error.message : '处理验收失败');
              }).finally(() => setSavingReviewAction(false));
            }}>放弃本次验收，改由我指定下一步</Button>
          </Box>}
          {failedReview && canRun && run.run.status === 'failed' && <Box sx={{ display: 'grid', gap: 0.75 }}>
            <Typography variant="body2" color="text.secondary">本次验收已明确失败。修正模型或要求后，可以只重试主 Agent 验收；之前完成的任务会保留。</Typography>
            {reviewActionError && reviewActionRunId === run.run.id && <Typography variant="caption" color="error.main">{reviewActionError}</Typography>}
            <Button size="small" variant="outlined" disabled={savingReviewAction} onClick={() => {
              setSavingReviewAction(true);
              setReviewActionRunId(run.run.id);
              void onResumeAfterReviewRetry(run, failedReview).then(() => setReviewActionError(null)).catch((error: unknown) => {
                setReviewActionRunId(run.run.id);
                setReviewActionError(error instanceof Error ? error.message : '重试验收失败');
              }).finally(() => setSavingReviewAction(false));
            }}>重试主 Agent 验收</Button>
          </Box>}
          {failedPlan && canRun && run.run.status === 'failed' && <Box sx={{ display: 'grid', gap: 0.75 }}>
            <Typography variant="body2" color="text.secondary">规划结果已明确失败。修正模型或目标后，可以只重试这轮规划；之前完成的步骤会保留。</Typography>
            {reviewActionError && reviewActionRunId === run.run.id && <Typography variant="caption" color="error.main">{reviewActionError}</Typography>}
            <Button size="small" variant="outlined" disabled={savingReviewAction} onClick={() => {
              setSavingReviewAction(true);
              setReviewActionRunId(run.run.id);
              void onResumeAfterPlanRetry(run, failedPlan).then(() => setReviewActionError(null)).catch((error: unknown) => {
                setReviewActionRunId(run.run.id);
                setReviewActionError(error instanceof Error ? error.message : '重试规划失败');
              }).finally(() => setSavingReviewAction(false));
            }}>重试主 Agent 规划</Button>
          </Box>}
          {pauseError && <Typography variant="body2" color="error.main">{pauseError}</Typography>}
          {canAddRevision && <Box sx={{ display: 'grid', gap: 1 }}>
            <TextField multiline minRows={2} fullWidth size="small" label="交给主 Agent 追加任务" value={delegateRequest} onChange={(event) => { setDelegateRequest(event.target.value); setDelegateError(null); }} slotProps={{ htmlInput: { maxLength: 4000 } }} disabled={savingDelegate} />
            {delegateError && <Typography variant="caption" color="error.main">{delegateError}</Typography>}
            <Button size="small" variant="outlined" disabled={!delegateRequest.trim() || savingDelegate} onClick={() => {
              setSavingDelegate(true);
              void onDelegate(run, delegateRequest).then(() => { setDelegateRequest(''); setDelegateError(null); }).catch((error: unknown) => setDelegateError(error instanceof Error ? error.message : '追加任务失败')).finally(() => setSavingDelegate(false));
            }}>保存追加任务</Button>
          </Box>}
          {run.tasks.map((item, index) => <Typography key={item.id} variant="body2" color="text.secondary">{index + 1}. {item.kind === 'team_plan' ? '规划团队' : item.kind === 'team_plan_revision' ? '规划追加任务' : item.kind === 'team_review' ? '主 Agent 验收交付' : item.kind === 'team_review_block' ? '等待用户决定' : taskDetails(item)?.goal || '执行任务'} · {taskStatus[item.status]}</Typography>)}
        </Box>}
      </DialogContent>
      <DialogActions>
        {canRun && resumableRuns.length > 1 && <Button disabled={resumingAll} onClick={() => {
          setResumingAll(true);
          setResumeAllError(null);
          void onResumeAll(resumableRuns).catch((error: unknown) => setResumeAllError(error instanceof Error ? error.message : '恢复团队任务失败'))
            .finally(() => setResumingAll(false));
        }}>{resumingAll ? '正在恢复…' : `恢复所有可恢复任务 (${resumableRuns.length})`}</Button>}
        {canRun && <Button onClick={() => { setOpen(false); onCreate(); }}>新建团队任务</Button>}
        {canRun && running && !run.run.pauseRequested && <Button onClick={() => { void onPause(run).then(() => setPauseError(null)).catch((error: unknown) => setPauseError(error instanceof Error ? error.message : '暂停任务失败')); }}>当前步骤完成后暂停</Button>}
        {canRun && !running && ((!blocked && run.run.status !== 'failed' && (!modelCallLimitReached || run.run.status === 'completed' || run.tasks.some((item) => item.status === 'waiting_external'))) || run.tasks.some((item) => (item.kind === 'agent_video' || item.kind === 'agent_image' || item.kind === 'agent_audio') && (item.status === 'failed' || item.status === 'result_unknown'))) && <Button onClick={() => onResume(run)}>{run.run.status === 'completed' ? '检查交付' : blocked || modelCallLimitReached ? '核对媒体结果' : '继续整个任务'}</Button>}
        <Button onClick={() => setOpen(false)}>关闭</Button>
      </DialogActions>
      {resumeAllError && <Typography role="alert" variant="caption" color="error.main" sx={{ px: 3, pb: 1 }}>{resumeAllError}</Typography>}
    </Dialog>
  </>;
}
