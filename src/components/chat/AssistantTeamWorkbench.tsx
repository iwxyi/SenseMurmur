import { useState } from 'react';
import { Alert, Accordion, AccordionDetails, AccordionSummary, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { WorkflowSnapshot, WorkflowTask } from '../../services/workflowRunRuntime';
import { countWorkflowModelCalls, isRetryableTeamTask, summarizeWorkflowRun } from '../../services/workflowRunRuntime';
import { validateAgentTeamPlan } from '../../services/agentTeamPlan';
import { buildAgentTeamTaskRevisionRequest, isRecoverableAgentTeamRun, updateAgentTeamPlatformBudget } from '../../services/agentTeamWorkflow';
import TeamTaskExecutionHistory from './TeamTaskExecutionHistory';
import { workflowDeliveryIssueLabel } from '../../services/workflowDelivery';
import TeamDeliveryConflictPanel from './TeamDeliveryConflictPanel';
import { analyzeWorkflowRevisionImpact } from '../../services/workflowRevisionImpact';
import { isPartialTeamReview } from '../../services/agentTeamReviewEvidence';
import TeamUserInputPanel from './TeamUserInputPanel';
import TeamApprovalPanel from './TeamApprovalPanel';
import TeamUsagePanel from './TeamUsagePanel';
import TeamBudgetPanel from './TeamBudgetPanel';
import { pendingWorkflowApproval } from '../../services/workflowApproval';
import { WORKFLOW_CAPABILITY_RECOVERY } from '../../services/workflowCapability';

interface Props {
  open: boolean;
  onClose: () => void;
  runs: WorkflowSnapshot[];
  canRun: boolean;
  isRunActive: (runId: string) => boolean;
  onResume: (run: WorkflowSnapshot) => void;
  onResumeAll: (runs: WorkflowSnapshot[]) => Promise<void>;
  onInstruct: (run: WorkflowSnapshot, task: WorkflowTask, instruction: string) => Promise<void>;
  onAnswer: (run: WorkflowSnapshot, task: WorkflowTask, answer: string) => Promise<void>;
  onApproval: (run: WorkflowSnapshot, task: WorkflowTask, outcome: 'approved' | 'rejected') => Promise<void>;
  onPause: (run: WorkflowSnapshot) => Promise<void>;
  onUpdateModelCallLimit: (run: WorkflowSnapshot, limit?: number) => Promise<void>;
  onUpdateDeadline: (run: WorkflowSnapshot, deadlineAt?: number) => Promise<void>;
  onSaveDeliveryCopy: (run: WorkflowSnapshot) => Promise<void>;
  onDelegate: (run: WorkflowSnapshot, request: string, targetTaskId?: string) => Promise<void>;
  onAbandonReview: (run: WorkflowSnapshot, task: WorkflowTask) => Promise<void>;
  onResumeAfterReviewRetry: (run: WorkflowSnapshot, task: WorkflowTask) => Promise<void>;
  onResumeAfterTaskRetry: (run: WorkflowSnapshot, task: WorkflowTask) => Promise<void>;
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
  const value = input as { task?: { goal?: unknown; acceptance?: unknown; tool?: unknown }; role?: { name?: unknown; responsibility?: unknown; method?: unknown } };
  if (typeof value.task?.goal !== 'string') return null;
  return {
    goal: value.task.goal,
    tool: typeof value.task.tool === 'string' ? value.task.tool : 'text_generation',
    acceptance: typeof value.task.acceptance === 'string' ? value.task.acceptance : '',
    role: typeof value.role?.name === 'string' ? value.role.name : '子 Agent',
    responsibility: typeof value.role?.responsibility === 'string' ? value.role.responsibility : '',
    method: typeof value.role?.method === 'string' ? value.role.method : '',
  };
}

export default function AssistantTeamWorkbench({ open, onClose, runs, canRun, isRunActive, onResume, onResumeAll, onInstruct, onAnswer, onApproval, onPause, onUpdateModelCallLimit, onUpdateDeadline, onSaveDeliveryCopy, onDelegate, onAbandonReview, onResumeAfterReviewRetry, onResumeAfterTaskRetry }: Props) {
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
  const [deadline, setDeadline] = useState('');
  const [savingDeadline, setSavingDeadline] = useState(false);
  const [deadlineError, setDeadlineError] = useState<string | null>(null);
  if (!runs.length) return null;
  const run = runs.find((item) => item.run.id === selectedRunId) || runs[0];
  const task = run.tasks.find((item) => item.id === selectedTaskId) || null;
  const details = task ? taskDetails(task) : null;
  const plan = teamPlan(run);
  const summary = summarizeWorkflowRun(run);
  const latestReview = run.tasks.filter((item) => item.kind === 'team_review' && item.status === 'completed' && !isPartialTeamReview(item)).at(-1);
  const reviewResult = latestReview?.output && typeof latestReview.output === 'object' && !Array.isArray(latestReview.output)
    ? latestReview.output as { complete?: unknown; reason?: unknown } : null;
  const childTasks = run.tasks.filter((item) => item.kind === 'agent_user_input' || item.kind === 'agent_delegation' || item.kind === 'agent_text' || item.kind === 'agent_web_search' || item.kind === 'agent_image' || item.kind === 'agent_image_inspection' || item.kind === 'agent_video_inspection' || item.kind === 'agent_audio' || item.kind === 'agent_video' || item.kind === 'agent_media_composition');
  const deliveryTasks = run.tasks.filter((item) => item.kind !== 'team_recovery' && item.status !== 'abandoned');
  const currentStage = run.tasks.filter((item) => item.kind === 'team_plan_revision' && item.status === 'completed').at(-1);
  const currentStageSummary = currentStage?.output && typeof currentStage.output === 'object' && !Array.isArray(currentStage.output)
    && 'summary' in currentStage.output && typeof currentStage.output.summary === 'string' ? currentStage.output.summary : plan?.summary;
  const blocked = summary.blocked.length > 0;
  const deliveryPending = run.run.status === 'completed' && run.run.deliveryStatus !== 'published';
  const deliveryNeedsAttention = deliveryPending && Boolean(run.run.deliveryIssue);
  const running = isRunActive(run.run.id);
  const modelCallLimitReached = run.run.maxModelCalls !== undefined && countWorkflowModelCalls(run) >= run.run.maxModelCalls;
  const editable = Boolean(canRun && task && !task.approvals?.length && run.run.status === 'paused' && childTasks.includes(task) && task.kind !== 'agent_media_composition' && details?.tool !== 'speech_generation' && task.attempt === 0
    && (task.status === 'queued' || task.status === 'waiting_dependency'));
  const unknownReview = run.tasks.find((item) => item.kind === 'team_review' && item.status === 'result_unknown');
  const failedReview = run.tasks.find((item) => item.kind === 'team_review' && item.status === 'failed');
  const failedPlan = run.tasks.find((item) => (item.kind === 'team_plan' || item.kind === 'team_plan_revision' || item.kind === 'agent_delegation') && item.status === 'failed');
  const failedTask = task && isRetryableTeamTask(task) ? task : null;
  const canAddRevision = canRun && (run.run.status === 'paused' || run.run.status === 'completed')
    && !run.tasks.some((item) => item.status === 'running' || item.status === 'result_unknown' || item.status === 'failed'
      || (item.kind === 'team_plan_revision' && item.status !== 'completed'));
  const canReviseSelectedTask = Boolean(canAddRevision && task && details && childTasks.includes(task)
    && task.status === 'completed' && task.attempt > 0);
  const canInstructSelectedTask = editable || canReviseSelectedTask;
  const revisionImpact = canReviseSelectedTask && task ? analyzeWorkflowRevisionImpact(run, task.id) : null;
  const resumableRuns = runs.filter(isRecoverableAgentTeamRun);
  const failedPlanReason = failedPlan?.error || '规划失败，未能生成可执行的团队计划。';

  return <>
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" aria-labelledby="team-workbench-title">
      <DialogTitle id="team-workbench-title">团队工作台</DialogTitle>
      <DialogContent dividers sx={{ display: 'grid', alignContent: 'start', gap: 1.25, minHeight: 260 }}>
        {runs.length > 1 && <Stack direction="row" spacing={0.75} sx={{ overflowX: 'auto', pb: 0.5 }}>
          {runs.map((item, index) => <Chip key={item.run.id} size="small" clickable color={item.run.id === run.run.id ? 'primary' : 'default'} label={teamPlan(item)?.summary || `任务 ${index + 1}`} onClick={() => { setSelectedRunId(item.run.id); setSelectedTaskId(null); setReviewActionError(null); }} />)}
        </Stack>}
        <Box sx={{ display: 'grid', gap: 0.6 }}>
          <Stack direction="row" spacing={0.8} sx={{ alignItems: 'center' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{run.run.pauseRequested ? '即将暂停' : running ? '正在执行' : deliveryNeedsAttention ? '交付需要处理' : deliveryPending ? '等待交付' : run.run.status === 'completed' ? '已完成' : run.run.status === 'cancelled' ? '已取消' : run.run.status === 'paused' ? '已暂停' : run.run.status === 'failed' ? '执行失败' : '等待执行'}</Typography>
            <Chip size="small" variant="outlined" label={`${deliveryTasks.filter((item) => item.status === 'completed').length}/${deliveryTasks.length} 步`} />
            {run.run.maxModelCalls ? <Chip size="small" variant="outlined" label={`模型调用 ${countWorkflowModelCalls(run)}/${run.run.maxModelCalls}`} /> : null}
          </Stack>
          {run.run.pauseReason && run.run.status === 'paused' && <Typography variant="body2" color="warning.main">{run.run.pauseReason}</Typography>}
          {run.run.goalSpec?.deadlineAt && <Typography variant="caption" color="text.secondary">截止时间：{new Date(run.run.goalSpec.deadlineAt).toLocaleString()}</Typography>}
          {run.run.deliveryIssue && run.run.status === 'completed' && <Typography role="alert" variant="body2" color="error.main">{workflowDeliveryIssueLabel(run.run.deliveryIssue)}</Typography>}
          {deliveryNeedsAttention && <TeamDeliveryConflictPanel key={`${run.run.id}:${run.run.planVersion}`} snapshot={run} canSave={canRun && !running} onSaveCopy={onSaveDeliveryCopy} />}
          {modelCallLimitReached && run.run.status === 'paused' && <Typography variant="body2" color="warning.main">已达到模型调用上限。调整上限后可继续，已有结果会保留。</Typography>}
        </Box>
        {!task && <Box sx={{ display: 'grid', gap: 0.35, overflowWrap: 'anywhere' }}>
          <Typography variant="body2"><strong>目标</strong> {run.run.goal}</Typography>
          {currentStageSummary && <Typography variant="body2" color="text.secondary"><strong>当前计划</strong> {currentStageSummary}</Typography>}
        </Box>}
        {failedPlan && <Alert severity="error" action={canRun && !running ? <Button color="inherit" size="small" disabled={savingReviewAction} onClick={() => {
          setSavingReviewAction(true);
          setReviewActionRunId(run.run.id);
          void onResumeAfterTaskRetry(run, failedPlan).then(() => setReviewActionError(null)).catch((error: unknown) => {
            setReviewActionRunId(run.run.id);
            setReviewActionError(error instanceof Error ? error.message : '重试规划失败');
          }).finally(() => setSavingReviewAction(false));
        }}>{failedPlan.kind === 'agent_delegation' ? '重试' : '重新规划'}</Button> : undefined} sx={{ py: 0.1, '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' }, '& .MuiAlert-action': { alignItems: 'center', pt: 0.25, pr: 0.5 } }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{failedPlanReason}</Typography>
          {failedPlan.capabilityIssue && <Typography variant="caption" sx={{ display: 'block', mt: 0.35 }}>{WORKFLOW_CAPABILITY_RECOVERY[failedPlan.capabilityIssue.code]}</Typography>}
        </Alert>}
        {reviewActionError && reviewActionRunId === run.run.id && <Typography role="alert" variant="caption" color="error.main">{reviewActionError}</Typography>}
        {canRun && !running && run.run.status === 'paused' && run.run.goalSpec && <Accordion disableGutters elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '4px !important', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 40, '& .MuiAccordionSummary-content': { my: 0.75 } }}><Typography variant="body2">运行设置与费用</Typography></AccordionSummary>
          <AccordionDetails sx={{ display: 'grid', gap: 1, pt: 0 }}>
            <TeamUsagePanel key={run.run.id} runId={run.run.id} />
            <TeamBudgetPanel key={`budget:${run.run.id}`} runId={run.run.id} canEdit={canRun && !running && run.run.status === 'paused' && Boolean(run.run.goalSpec)}
              onSave={(input) => updateAgentTeamPlatformBudget({ ...input, runId: run.run.id, expectedPlanVersion: run.run.planVersion })} />
          </AccordionDetails>
        </Accordion>}
        {run.tasks.filter((item) => item.kind === 'agent_user_input' && item.status === 'waiting_user' && !pendingWorkflowApproval(item)).map((item) =>
          <TeamUserInputPanel key={`${run.run.id}:${item.id}:${run.run.planVersion}`} run={run} task={item}
            disabled={!canRun || running || !['active', 'paused'].includes(run.run.status)} onAnswer={onAnswer} />)}
        {['active', 'paused'].includes(run.run.status) && run.tasks.filter((item) => pendingWorkflowApproval(item)).map((item) =>
          <TeamApprovalPanel key={`${run.run.id}:${item.id}:${run.run.planVersion}`} run={run} task={item}
            disabled={!canRun || running} onDecide={onApproval} />)}
        {canRun && !running && run.run.status === 'paused' && run.run.goalSpec && <Accordion disableGutters elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '4px !important', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 40, '& .MuiAccordionSummary-content': { my: 0.75 } }}><Typography variant="body2">调整执行限制</Typography></AccordionSummary>
          <AccordionDetails sx={{ display: 'grid', gap: 1, pt: 0 }}>
          <Box sx={{ display: 'grid', gap: 1 }}>
          <TextField size="small" type="datetime-local" label="新的截止时间" value={deadline} onChange={(event) => { setDeadline(event.target.value); setDeadlineError(null); }} disabled={savingDeadline} slotProps={{ inputLabel: { shrink: true } }} helperText="留空并保存可取消截止时间。" />
          {deadlineError && <Typography role="alert" variant="caption" color="error.main">{deadlineError}</Typography>}
          <Button size="small" disabled={savingDeadline || Boolean(deadline && !Number.isFinite(new Date(deadline).getTime()))} onClick={() => {
            setSavingDeadline(true);
            setDeadlineError(null);
            void onUpdateDeadline(run, deadline ? new Date(deadline).getTime() : undefined)
              .catch((error: unknown) => setDeadlineError(error instanceof Error ? error.message : '保存截止时间失败'))
              .finally(() => setSavingDeadline(false));
          }}>保存截止时间</Button>
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
          </AccordionDetails>
        </Accordion>}
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
          {task.status === 'failed' && task.capabilityIssue && <Typography role="status" variant="body2" color="warning.main"><strong>继续条件</strong> {WORKFLOW_CAPABILITY_RECOVERY[task.capabilityIssue.code]}</Typography>}
          {failedTask && canRun && !running && run.run.status === 'failed' && <Box>
            {reviewActionError && reviewActionRunId === run.run.id && <Typography role="alert" variant="caption" color="error.main">{reviewActionError}</Typography>}
            <Button size="small" variant="outlined" disabled={savingReviewAction} onClick={() => {
              setSavingReviewAction(true);
              setReviewActionRunId(run.run.id);
              void onResumeAfterTaskRetry(run, failedTask).then(() => setReviewActionError(null)).catch((error: unknown) => {
                setReviewActionRunId(run.run.id);
                setReviewActionError(error instanceof Error ? error.message : '重试任务失败');
              }).finally(() => setSavingReviewAction(false));
            }}>重试该任务并继续</Button>
          </Box>}
          <TeamTaskExecutionHistory key={`${run.run.id}:${task.id}`} runId={run.run.id} taskId={task.id} updatedAt={task.updatedAt} statusLabels={taskStatus} />
          {typeof (task.input as { userInstruction?: unknown })?.userInstruction === 'string' && <Typography variant="body2"><strong>用户指示</strong> {String((task.input as { userInstruction: string }).userInstruction)}</Typography>}
          {canInstructSelectedTask && <Box sx={{ display: 'grid', gap: 1 }}>
            <TextField multiline minRows={2} fullWidth size="small" label={editable ? '补充该子任务的指示' : '与该子 Agent 继续协作'} value={instruction} onChange={(event) => { setInstruction(event.target.value); setInstructionError(null); }} slotProps={{ htmlInput: { maxLength: 4000 } }} disabled={savingInstruction} />
            {revisionImpact && <Box sx={{ display: 'grid', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">可能影响 {revisionImpact.affectedTaskIds.length} 个步骤：{run.tasks.filter((item) => revisionImpact.affectedTaskIds.includes(item.id)).map((item) => taskDetails(item)?.goal || (item.kind === 'team_review' ? '交付验收' : '主 Agent 规划')).join('、')}</Typography>
              {revisionImpact.generatedMediaTaskIds.length > 0 && <Typography variant="caption" color="warning.main">其中 {revisionImpact.generatedMediaTaskIds.length} 个媒体步骤已执行。若新要求需要重新生成，可能产生新的费用。</Typography>}
            </Box>}
            {instructionError && <Typography variant="caption" color="error.main">{instructionError}</Typography>}
            <Button size="small" variant="outlined" disabled={!instruction.trim() || savingInstruction} onClick={() => {
              setSavingInstruction(true);
              const operation = editable
                ? onInstruct(run, task, instruction)
                : onDelegate(run, buildAgentTeamTaskRevisionRequest(task, instruction), task.id);
              void operation.then(() => { setInstruction(''); setInstructionError(null); }).catch((error: unknown) => {
                setInstructionError(error instanceof Error ? error.message : '保存指示失败');
              }).finally(() => setSavingInstruction(false));
            }}>{editable ? '保存指示' : '发送给主 Agent'}</Button>
          </Box>}
          {typeof task.output === 'string' && <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: 'action.hover', maxHeight: 300, overflowY: 'auto' }}><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.output}</Typography></Box>}
        </Box> : <Box sx={{ display: 'grid', gap: 1.25, overflowWrap: 'anywhere' }}>
          {plan?.finalAcceptance && <Typography variant="body2"><strong>最终验收</strong> {plan.finalAcceptance}</Typography>}
          {reviewResult && typeof reviewResult.reason === 'string' && <Typography variant="body2" color={reviewResult.complete === true ? 'text.secondary' : 'warning.main'}><strong>主 Agent 验收</strong> {reviewResult.reason}</Typography>}
          {summary.blocked.length > 0 && <Typography variant="body2" color="warning.main"><strong>需要处理</strong> {summary.blocked.map((item) => item.reason).join('；')}</Typography>}
          {unknownReview && canRun && run.run.status === 'paused' && <Box sx={{ display: 'grid', gap: 0.75 }}>
            <Typography variant="body2" color="text.secondary">上次验收请求的结果无法核对。放弃本轮未完成审核后，仍需追加明确任务才能继续；已完成审核会保留，原未知结果不会自动重试。</Typography>
            {reviewActionError && reviewActionRunId === run.run.id && <Typography variant="caption" color="error.main">{reviewActionError}</Typography>}
            <Button size="small" variant="outlined" disabled={savingReviewAction} onClick={() => {
              setSavingReviewAction(true);
              setReviewActionRunId(run.run.id);
              void onAbandonReview(run, unknownReview).then(() => setReviewActionError(null)).catch((error: unknown) => {
                setReviewActionRunId(run.run.id);
                setReviewActionError(error instanceof Error ? error.message : '处理验收失败');
              }).finally(() => setSavingReviewAction(false));
            }}>放弃本轮验收，改由我指定下一步</Button>
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
          {pauseError && <Typography variant="body2" color="error.main">{pauseError}</Typography>}
          {canAddRevision && <Box sx={{ display: 'grid', gap: 1 }}>
            <TextField multiline minRows={2} fullWidth size="small" label="交给主 Agent 追加任务" value={delegateRequest} onChange={(event) => { setDelegateRequest(event.target.value); setDelegateError(null); }} slotProps={{ htmlInput: { maxLength: 4000 } }} disabled={savingDelegate} />
            {delegateError && <Typography variant="caption" color="error.main">{delegateError}</Typography>}
            <Button size="small" variant="outlined" disabled={!delegateRequest.trim() || savingDelegate} onClick={() => {
              setSavingDelegate(true);
              void onDelegate(run, delegateRequest).then(() => { setDelegateRequest(''); setDelegateError(null); }).catch((error: unknown) => setDelegateError(error instanceof Error ? error.message : '追加任务失败')).finally(() => setSavingDelegate(false));
            }}>保存追加任务</Button>
          </Box>}
          {run.tasks.map((item, index) => <Box key={item.id}>
            <Typography variant="body2" color="text.secondary">{index + 1}. {item.kind === 'team_plan' ? '规划团队' : item.kind === 'team_plan_revision' ? '规划追加任务' : item.kind === 'team_review' ? isPartialTeamReview(item) ? '分批审核交付' : '主 Agent 验收交付' : item.kind === 'team_review_block' ? '等待用户决定' : taskDetails(item)?.goal || '执行任务'} · {taskStatus[item.status]}</Typography>
            {['team_plan', 'team_plan_revision', 'team_review'].includes(item.kind) && <TeamTaskExecutionHistory runId={run.run.id} taskId={item.id} updatedAt={item.updatedAt} statusLabels={taskStatus} />}
          </Box>)}
        </Box>}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5, justifyContent: 'flex-end' }}>
        {canRun && resumableRuns.length > 1 && <Button disabled={resumingAll} onClick={() => {
          setResumingAll(true);
          setResumeAllError(null);
          void onResumeAll(resumableRuns).catch((error: unknown) => setResumeAllError(error instanceof Error ? error.message : '恢复团队任务失败'))
            .finally(() => setResumingAll(false));
        }}>{resumingAll ? '正在恢复…' : `恢复所有可恢复任务 (${resumableRuns.length})`}</Button>}
        {canRun && running && !run.run.pauseRequested && <Button onClick={() => { void onPause(run).then(() => setPauseError(null)).catch((error: unknown) => setPauseError(error instanceof Error ? error.message : '暂停任务失败')); }}>当前步骤完成后暂停</Button>}
        {canRun && !running && ((!blocked && run.run.status !== 'failed' && (!modelCallLimitReached || run.run.status === 'completed' || run.tasks.some((item) => item.status === 'waiting_external'))) || run.tasks.some((item) => (item.kind === 'agent_video' || item.kind === 'agent_image' || item.kind === 'agent_audio' || item.kind === 'agent_media_composition') && (item.status === 'failed' || item.status === 'result_unknown'))) && <Button onClick={() => onResume(run)}>{run.run.status === 'completed' ? '检查交付' : run.tasks.some((item) => item.kind === 'agent_media_composition' && (item.status === 'failed' || item.status === 'result_unknown')) ? '重试本地合成并继续' : blocked || modelCallLimitReached ? '核对媒体结果' : '继续整个任务'}</Button>}
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
      {resumeAllError && <Typography role="alert" variant="caption" color="error.main" sx={{ px: 3, pb: 1 }}>{resumeAllError}</Typography>}
    </Dialog>
  </>;
}
