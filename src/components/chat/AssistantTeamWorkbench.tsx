import { useEffect, useRef, useState } from 'react';
import { Alert, Accordion, AccordionDetails, AccordionSummary, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControl, List, ListItemButton, MenuItem, Select, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
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
import { useCharacterStore } from '../../stores/useCharacterStore';

interface Props {
  open: boolean;
  onClose: () => void;
  runs: WorkflowSnapshot[];
  canRun: boolean;
  isRunActive: (runId: string) => boolean;
  onResume: (run: WorkflowSnapshot) => void;
  onResumeAll: (runs: WorkflowSnapshot[]) => Promise<void>;
  onInstruct: (run: WorkflowSnapshot, task: WorkflowTask, instruction: string, characterId: string | null) => Promise<void>;
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

const OVERVIEW_ID = '__overview__';
const taskStatus: Record<WorkflowTask['status'], string> = {
  queued: '排队', running: '执行中', waiting_dependency: '等待前置步骤', waiting_external: '等待生成',
  waiting_user: '等待用户', result_unknown: '待核对', completed: '已完成', failed: '失败', cancelled: '已取消', abandoned: '已放弃',
};

function teamPlan(run: WorkflowSnapshot) {
  const raw = run.tasks.find((task) => task.kind === 'team_plan')?.output;
  if (!raw) return null;
  try { return validateAgentTeamPlan(raw); } catch { return null; }
}

function taskDetails(task: WorkflowTask, characters: ReturnType<typeof useCharacterStore.getState>['characters']) {
  const input = task.input;
  if (!input || typeof input !== 'object' || !('task' in input)) return null;
  const value = input as { task?: { goal?: unknown; acceptance?: unknown; tool?: unknown }; role?: { name?: unknown; responsibility?: unknown; method?: unknown; characterId?: unknown }; characterOverride?: unknown };
  if (typeof value.task?.goal !== 'string') return null;
  const characterId = Object.hasOwn(value, 'characterOverride')
    ? (typeof value.characterOverride === 'string' ? value.characterOverride : '')
    : (typeof value.role?.characterId === 'string' ? value.role.characterId : '');
  return {
    goal: value.task.goal,
    tool: typeof value.task.tool === 'string' ? value.task.tool : 'text_generation',
    acceptance: typeof value.task.acceptance === 'string' ? value.task.acceptance : '',
    role: typeof value.role?.name === 'string' ? value.role.name : '子 Agent',
    characterId,
    character: characterId ? characters.find((item) => item.id === characterId)?.name || '已绑定角色不可用' : '空白 Agent',
    responsibility: typeof value.role?.responsibility === 'string' ? value.role.responsibility : '',
    method: typeof value.role?.method === 'string' ? value.role.method : '',
  };
}

function taskTitle(task: WorkflowTask) {
  if (task.kind === 'team_plan') return '规划任务';
  if (task.kind === 'team_plan_revision') return '追加规划';
  if (task.kind === 'team_review') return isPartialTeamReview(task) ? '阶段验收' : '最终验收';
  if (task.kind === 'team_review_block') return '等待决策';
  const input = task.input;
  if (input && typeof input === 'object' && 'task' in input) {
    const planned = input.task as { deliverable?: { title?: unknown } } | undefined;
    if (typeof planned?.deliverable?.title === 'string') return planned.deliverable.title;
  }
  return null;
}

function statusColor(status: WorkflowTask['status']): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'result_unknown') return 'error';
  if (status === 'waiting_user' || status === 'waiting_external') return 'warning';
  if (status === 'running') return 'primary';
  return 'default';
}

export default function AssistantTeamWorkbench({ open, onClose, runs, canRun, isRunActive, onResume, onResumeAll, onInstruct, onAnswer, onApproval, onPause, onUpdateModelCallLimit, onUpdateDeadline, onSaveDeliveryCopy, onDelegate, onAbandonReview, onResumeAfterReviewRetry, onResumeAfterTaskRetry }: Props) {
  const characters = useCharacterStore((state) => state.characters);
  const stepListRef = useRef<HTMLUListElement | null>(null);
  const selectedStepRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [characterOverrides, setCharacterOverrides] = useState<Record<string, string>>({});
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
  const scrollToStep = (element: HTMLElement, alignStart = false) => {
    const list = stepListRef.current;
    if (!list) return;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    const listBounds = list.getBoundingClientRect();
    const stepBounds = element.getBoundingClientRect();
    const start = list.scrollLeft;
    const centered = start + stepBounds.left - listBounds.left - (list.clientWidth - stepBounds.width) / 2;
    const target = Math.max(0, Math.min(alignStart ? 0 : centered, list.scrollWidth - list.clientWidth));
    const distance = target - start;
    if (Math.abs(distance) < 1) return;
    const duration = Math.min(480, Math.max(280, Math.abs(distance) * 0.45));
    let startedAt: number | null = null;
    const animate = (time: number) => {
      if (startedAt === null) startedAt = time;
      const progress = Math.min((time - startedAt) / duration, 1);
      list.scrollLeft = start + distance * (1 - (1 - progress) ** 3);
      scrollFrameRef.current = progress < 1 ? requestAnimationFrame(animate) : null;
    };
    scrollFrameRef.current = requestAnimationFrame(animate);
  };
  useEffect(() => {
    if (open && selectedStepRef.current) scrollToStep(selectedStepRef.current, !selectedTaskId || selectedTaskId === OVERVIEW_ID);
    return () => { if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current); };
  }, [open, selectedRunId, selectedTaskId]);
  if (!runs.length) return null;

  const run = runs.find((item) => item.run.id === selectedRunId) || runs[0];
  const plan = teamPlan(run);
  const runTitle = plan?.title || run.run.goal;
  const summary = summarizeWorkflowRun(run);
  const navigationTasks = run.tasks.filter((item) => item.kind !== 'team_recovery' && item.status !== 'abandoned');
  const deliveryTasks = navigationTasks;
  const task = selectedTaskId === OVERVIEW_ID || !selectedTaskId ? null
    : navigationTasks.find((item) => item.id === selectedTaskId) || null;
  const details = task ? taskDetails(task, characters) : null;
  const reviewReason = task?.kind === 'team_review' && task.output && typeof task.output === 'object'
    && !Array.isArray(task.output) && 'reason' in task.output ? String(task.output.reason) : null;
  const latestReview = run.tasks.filter((item) => item.kind === 'team_review' && item.status === 'completed' && !isPartialTeamReview(item)).at(-1);
  const reviewResult = latestReview?.output && typeof latestReview.output === 'object' && !Array.isArray(latestReview.output)
    ? latestReview.output as { complete?: unknown; reason?: unknown } : null;
  const agentTasks = run.tasks.filter((item) => ['agent_user_input', 'agent_delegation', 'agent_text', 'agent_web_search', 'agent_image', 'agent_image_inspection', 'agent_video_inspection', 'agent_audio', 'agent_video', 'agent_media_composition'].includes(item.kind));
  const currentStage = run.tasks.filter((item) => item.kind === 'team_plan_revision' && item.status === 'completed').at(-1);
  const currentStageSummary = currentStage?.output && typeof currentStage.output === 'object' && !Array.isArray(currentStage.output)
    && 'summary' in currentStage.output && typeof currentStage.output.summary === 'string' ? currentStage.output.summary : plan?.summary;
  const blocked = summary.blocked.length > 0;
  const deliveryPending = run.run.status === 'completed' && run.run.deliveryStatus !== 'published';
  const deliveryNeedsAttention = deliveryPending && Boolean(run.run.deliveryIssue);
  const running = isRunActive(run.run.id);
  const modelCallLimitReached = run.run.maxModelCalls !== undefined && countWorkflowModelCalls(run) >= run.run.maxModelCalls;
  const editable = Boolean(canRun && task && !task.approvals?.length && run.run.status === 'paused' && agentTasks.includes(task)
    && task.kind !== 'agent_media_composition' && details?.tool !== 'speech_generation' && task.attempt === 0
    && (task.status === 'queued' || task.status === 'waiting_dependency'));
  const unknownReview = run.tasks.find((item) => item.kind === 'team_review' && item.status === 'result_unknown');
  const failedReview = run.tasks.find((item) => item.kind === 'team_review' && item.status === 'failed');
  const failedPlan = run.tasks.find((item) => (item.kind === 'team_plan' || item.kind === 'team_plan_revision' || item.kind === 'agent_delegation') && item.status === 'failed');
  const failedTask = task && isRetryableTeamTask(task) ? task : null;
  const canAddRevision = canRun && (run.run.status === 'paused' || run.run.status === 'completed')
    && !run.tasks.some((item) => item.status === 'running' || item.status === 'result_unknown' || item.status === 'failed'
      || (item.kind === 'team_plan_revision' && item.status !== 'completed'));
  const canReviseSelectedTask = Boolean(canAddRevision && task && details && agentTasks.includes(task) && task.status === 'completed' && task.attempt > 0);
  const canInstructSelectedTask = editable || canReviseSelectedTask;
  const revisionImpact = canReviseSelectedTask && task ? analyzeWorkflowRevisionImpact(run, task.id) : null;
  const resumableRuns = runs.filter(isRecoverableAgentTeamRun);
  const completedCount = deliveryTasks.filter((item) => item.status === 'completed').length;
  const statusLabel = run.run.pauseRequested ? '即将暂停' : running ? '执行中' : deliveryNeedsAttention ? '交付需处理'
    : deliveryPending ? '等待交付' : run.run.status === 'completed' ? '已完成' : run.run.status === 'cancelled' ? '已取消'
      : run.run.status === 'paused' ? '已暂停' : run.run.status === 'failed' ? '执行失败' : '等待执行';
  const canResume = canRun && !running && ((!blocked && run.run.status !== 'failed'
    && (!modelCallLimitReached || run.run.status === 'completed' || run.tasks.some((item) => item.status === 'waiting_external')))
    || run.tasks.some((item) => ['agent_video', 'agent_image', 'agent_audio', 'agent_media_composition'].includes(item.kind)
      && (item.status === 'failed' || item.status === 'result_unknown')));
  const primaryActionLabel = run.run.status === 'completed' ? '检查交付'
    : run.tasks.some((item) => item.kind === 'agent_media_composition' && (item.status === 'failed' || item.status === 'result_unknown')) ? '重试合成并继续'
      : blocked || modelCallLimitReached ? '核对媒体结果' : '继续任务';

  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="xl" aria-labelledby="team-workbench-title"
    sx={{ '& .MuiDialog-paper': { height: { xs: 'calc(100dvh - 16px)', md: 'min(90dvh, 920px)' }, maxHeight: 'none' } }}>
    <DialogTitle sx={{ px: { xs: 2, md: 3 }, pt: 2.5, pb: 1.5 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography id="team-workbench-title" variant="h6" sx={{ fontWeight: 750 }}>团队工作台</Typography>
        </Box>
        {runs.length > 1 && <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 300 }, maxWidth: 480 }}>
          <Select value={run.run.id} aria-label="选择团队任务" onChange={(event) => {
            setSelectedRunId(event.target.value);
            setSelectedTaskId(null);
            setReviewActionError(null);
          }}>
            {runs.map((item) => <MenuItem key={item.run.id} value={item.run.id}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap>{teamPlan(item)?.title || item.run.goal}</Typography>
                <Typography variant="caption" color="text.secondary">{item.run.status === 'active' ? '执行中' : item.run.status === 'paused' ? '已暂停' : item.run.status === 'completed' ? '已完成' : item.run.status === 'failed' ? '执行失败' : '已取消'}</Typography>
              </Box>
            </MenuItem>)}
          </Select>
        </FormControl>}
        {resumableRuns.length > 1 && canRun && <Button size="small" disabled={resumingAll} sx={{ flexShrink: 0 }} onClick={() => {
          setResumingAll(true);
          setResumeAllError(null);
          void onResumeAll(resumableRuns).catch((error: unknown) => setResumeAllError(error instanceof Error ? error.message : '恢复团队任务失败'))
            .finally(() => setResumingAll(false));
        }}>{resumingAll ? '正在恢复…' : `恢复其他任务 (${resumableRuns.length})`}</Button>}
      </Stack>
    </DialogTitle>
    <DialogContent dividers sx={{ p: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {(run.run.pauseReason && run.run.status === 'paused' || run.run.deliveryIssue && run.run.status === 'completed' || modelCallLimitReached && run.run.status === 'paused') && <Alert severity={run.run.deliveryIssue ? 'error' : 'warning'} sx={{ mx: { xs: 2, md: 3 }, mt: 1.5 }}>
        {run.run.pauseReason && run.run.status === 'paused' && <Typography variant="body2">{run.run.pauseReason}</Typography>}
        {run.run.deliveryIssue && run.run.status === 'completed' && <Typography role="alert" variant="body2">{workflowDeliveryIssueLabel(run.run.deliveryIssue)}</Typography>}
        {modelCallLimitReached && run.run.status === 'paused' && <Typography variant="body2">已达到模型调用上限。调整上限后可继续，已有结果会保留。</Typography>}
        {deliveryNeedsAttention && <TeamDeliveryConflictPanel key={`${run.run.id}:${run.run.planVersion}`} snapshot={run} canSave={canRun && !running} onSaveCopy={onSaveDeliveryCopy} />}
      </Alert>}
      {failedPlan && <Alert severity="error" sx={{ mx: { xs: 2, md: 3 }, mt: 1.5, '& .MuiAlert-message': { minWidth: 0, width: '100%' } }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0 }}><Typography variant="body2" sx={{ fontWeight: 650 }}>{failedPlan.error || '计划步骤失败，尚未形成可执行方案。'}</Typography>
            {failedPlan.capabilityIssue && <Typography variant="caption">{WORKFLOW_CAPABILITY_RECOVERY[failedPlan.capabilityIssue.code]}</Typography>}</Box>
          {canRun && !running && <Button color="inherit" size="small" disabled={savingReviewAction} onClick={() => {
            setSavingReviewAction(true);
            setReviewActionRunId(run.run.id);
            void onResumeAfterTaskRetry(run, failedPlan).then(() => setReviewActionError(null)).catch((error: unknown) => {
              setReviewActionRunId(run.run.id);
              setReviewActionError(error instanceof Error ? error.message : '重新规划失败');
            }).finally(() => setSavingReviewAction(false));
          }}>{failedPlan.kind === 'agent_delegation' ? '重试' : '重新规划'}</Button>}
        </Stack>
      </Alert>}
      {reviewActionError && reviewActionRunId === run.run.id && <Typography role="alert" variant="body2" color="error.main" sx={{ mx: 3, mt: 1 }}>{reviewActionError}</Typography>}

      <Box component="nav" aria-label="任务步骤" sx={{ minWidth: 0, borderBottom: '1px solid', borderColor: 'divider', px: { xs: 2, md: 3 }, py: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography variant="overline" color="text.secondary">步骤目录</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{completedCount}/{deliveryTasks.length}</Typography>
          {run.run.status !== 'completed' && <Chip size="small" variant="outlined" color={run.run.status === 'failed' || deliveryNeedsAttention ? 'error' : running ? 'primary' : 'default'} label={statusLabel} />}
        </Stack>
        <List ref={stepListRef} disablePadding sx={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto', overflowY: 'hidden', pb: 1,
          '&::after': { content: '""', flex: { xs: '0 0 calc(50% - 90px)', sm: '0 0 calc(50% - 100px)' } },
        }}>
            <ListItemButton ref={!task ? selectedStepRef : undefined} selected={!task} onClick={(event) => { if (task) setSelectedTaskId(OVERVIEW_ID); else scrollToStep(event.currentTarget, true); }} aria-label={`任务总览：${runTitle}`} sx={{ border: '1px solid', borderColor: !task ? 'primary.main' : 'divider', borderRadius: 1, px: 1.25, py: 1, width: { xs: 180, sm: 200 }, minHeight: 72, flex: '0 0 auto', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>0 · 任务总览</Typography>
              <Typography variant="body2" title={runTitle} sx={{ fontWeight: !task ? 700 : 600, overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflowWrap: 'anywhere' }}>{runTitle}</Typography>
            </ListItemButton>
            {navigationTasks.map((item, index) => {
              const title = taskTitle(item) || '未命名步骤';
              const selected = task?.id === item.id;
              return <Box key={item.id} sx={{ display: 'flex', alignItems: 'center', flex: '0 0 auto' }}>
                <ChevronRightIcon aria-hidden="true" fontSize="small" sx={{ mx: 0.75, color: 'text.disabled', flexShrink: 0 }} />
                <ListItemButton ref={selected ? selectedStepRef : undefined} selected={selected} onClick={(event) => { if (selected) scrollToStep(event.currentTarget); else setSelectedTaskId(item.id); }} aria-label={`步骤 ${index + 1}：${title}，${taskStatus[item.status]}`} sx={{ border: '1px solid', borderColor: selected ? 'primary.main' : 'divider', borderRadius: 1, px: 1.25, py: 1, width: { xs: 180, sm: 200 }, minHeight: 72, flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 0.5 }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{index + 1}</Typography>
                    <Typography variant="caption" color={`${statusColor(item.status)}.main`}>{taskStatus[item.status]}</Typography>
                  </Stack>
                  <Typography variant="body2" title={title} sx={{ fontWeight: selected ? 700 : 600, minWidth: 0, overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflowWrap: 'anywhere' }}>{title}</Typography>
                </ListItemButton>
              </Box>;
            })}
        </List>
      </Box>

        <Box component="main" sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', p: { xs: 2, md: 3 } }}>
          {task && <Box sx={{ display: 'grid', gap: 2, maxWidth: 960, mx: 'auto', overflowWrap: 'anywhere' }}>
            {(taskTitle(task) || details) && <Box>
              {taskTitle(task) && <Typography variant="h6" sx={{ fontWeight: 750, overflowWrap: 'anywhere' }}>{taskTitle(task)}</Typography>}
              {details && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{details.role} · {details.character}</Typography>}
            </Box>}
            {details && <Box sx={{ display: 'grid', gap: 1.25 }}>
              <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>{details.goal}</Typography>
              {details.responsibility && <Typography variant="body2" color="text.secondary"><strong>职责：</strong> {details.responsibility}</Typography>}
              {details.method && <Typography variant="body2" color="text.secondary"><strong>工作方式：</strong> {details.method}</Typography>}
              {details.acceptance && <Typography variant="body2" color="text.secondary"><strong>验收标准：</strong> {details.acceptance}</Typography>}
              {typeof (task.input as { userInstruction?: unknown })?.userInstruction === 'string' && <Typography variant="body2" color="text.secondary"><strong>补充要求：</strong> {String((task.input as { userInstruction: string }).userInstruction)}</Typography>}
            </Box>}
            {task.error && <Alert severity="error"><Typography variant="body2"><strong>执行失败：</strong> {task.error}</Typography>
              {task.capabilityIssue && <Typography variant="caption">{WORKFLOW_CAPABILITY_RECOVERY[task.capabilityIssue.code]}</Typography>}</Alert>}
            {task.kind === 'agent_user_input' && task.status === 'waiting_user' && !pendingWorkflowApproval(task) && <TeamUserInputPanel run={run} task={task}
              disabled={!canRun || running || !['active', 'paused'].includes(run.run.status)} onAnswer={onAnswer} />}
            {pendingWorkflowApproval(task) && ['active', 'paused'].includes(run.run.status) && <TeamApprovalPanel run={run} task={task}
              disabled={!canRun || running} onDecide={onApproval} />}
            {failedTask && canRun && !running && run.run.status === 'failed' && <Button variant="outlined" sx={{ justifySelf: 'start' }} disabled={savingReviewAction} onClick={() => {
              setSavingReviewAction(true);
              setReviewActionRunId(run.run.id);
              void onResumeAfterTaskRetry(run, failedTask).then(() => setReviewActionError(null)).catch((error: unknown) => {
                setReviewActionRunId(run.run.id);
                setReviewActionError(error instanceof Error ? error.message : '重试任务失败');
              }).finally(() => setSavingReviewAction(false));
            }}>重试此步骤并继续</Button>}
            {task.kind === 'team_review' && task.status === 'result_unknown' && unknownReview === task && canRun && run.run.status === 'paused' && <Box sx={{ display: 'grid', gap: 1 }}>
              <Typography variant="body2" color="text.secondary">审核请求的结果无法确认。放弃本轮未完成审核后，可以由你指定下一步；已完成的审核记录会保留。</Typography>
              <Button variant="outlined" sx={{ justifySelf: 'start' }} disabled={savingReviewAction} onClick={() => {
                setSavingReviewAction(true);
                setReviewActionRunId(run.run.id);
                void onAbandonReview(run, task).then(() => setReviewActionError(null)).catch((error: unknown) => {
                  setReviewActionRunId(run.run.id);
                  setReviewActionError(error instanceof Error ? error.message : '处理验收失败');
                }).finally(() => setSavingReviewAction(false));
              }}>放弃本轮验收</Button>
            </Box>}
            {task.kind === 'team_review' && task.status === 'failed' && failedReview === task && canRun && run.run.status === 'failed' && <Button variant="outlined" sx={{ justifySelf: 'start' }} disabled={savingReviewAction} onClick={() => {
              setSavingReviewAction(true);
              setReviewActionRunId(run.run.id);
              void onResumeAfterReviewRetry(run, task).then(() => setReviewActionError(null)).catch((error: unknown) => {
                setReviewActionRunId(run.run.id);
                setReviewActionError(error instanceof Error ? error.message : '重试验收失败');
              }).finally(() => setSavingReviewAction(false));
            }}>重试验收</Button>}
            {typeof task.output === 'string' && <Box>
              <Typography variant="overline" color="text.secondary">步骤产出</Typography>
              <Typography variant="body2" sx={{ mt: 0.5, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{task.output}</Typography>
            </Box>}
            {task.kind === 'team_plan' && plan && <Box sx={{ display: 'grid', gap: 1 }}>
              <Typography variant="subtitle2">执行计划</Typography>
              <Typography variant="body2" color="text.secondary">{plan.summary}</Typography>
              {plan.finalAcceptance && <Typography variant="body2"><strong>最终验收：</strong> {plan.finalAcceptance}</Typography>}
            </Box>}
            {reviewReason !== null && <Typography variant="body2" color="text.secondary"><strong>验收意见：</strong> {reviewReason}</Typography>}
            {canInstructSelectedTask && details && <Box sx={{ display: 'grid', gap: 1, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
              <Typography variant="subtitle2">调整此任务</Typography>
              {editable && <TextField select size="small" label="执行角色" value={characterOverrides[task.id] ?? details.characterId}
                onChange={(event) => setCharacterOverrides((current) => ({ ...current, [task.id]: event.target.value }))} disabled={savingInstruction}>
                <MenuItem value="">空白 Agent</MenuItem>
                {characters.filter((item) => item.deletedAt == null).map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
              </TextField>}
              <TextField multiline minRows={2} fullWidth size="small" label={editable ? '修改前补充执行要求' : '交给主 Agent 追加修订'} value={instruction}
                onChange={(event) => { setInstruction(event.target.value); setInstructionError(null); }} slotProps={{ htmlInput: { maxLength: 4000 } }} disabled={savingInstruction} />
              {revisionImpact && <Typography variant="caption" color="text.secondary">本次修改会影响 {revisionImpact.affectedTaskIds.length} 个步骤；其中 {revisionImpact.generatedMediaTaskIds.length} 个媒体步骤已经执行。</Typography>}
              {instructionError && <Typography role="alert" variant="caption" color="error.main">{instructionError}</Typography>}
              <Button variant="outlined" sx={{ justifySelf: 'start' }} disabled={(!instruction.trim() && (!editable || (characterOverrides[task.id] ?? details.characterId) === details.characterId)) || savingInstruction} onClick={() => {
                setSavingInstruction(true);
                const operation = editable
                  ? onInstruct(run, task, instruction, (characterOverrides[task.id] ?? details.characterId) || null)
                  : onDelegate(run, buildAgentTeamTaskRevisionRequest(task, instruction), task.id);
                void operation.then(() => { setInstruction(''); setInstructionError(null); }).catch((error: unknown) => {
                  setInstructionError(error instanceof Error ? error.message : '保存指示失败');
                }).finally(() => setSavingInstruction(false));
              }}>{editable ? '保存任务修改' : '提交修订给主 Agent'}</Button>
            </Box>}
            <TeamTaskExecutionHistory runId={run.run.id} taskId={task.id} updatedAt={task.updatedAt} statusLabels={taskStatus} />
          </Box>}

          {!task && <Box sx={{ display: 'grid', gap: 2, maxWidth: 960, mx: 'auto' }}>
            <Box><Typography variant="overline" color="text.secondary">任务目标</Typography>
              <Typography variant="h6" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{runTitle}</Typography>
              {run.run.goal.trim() !== runTitle.trim() && <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{run.run.goal}</Typography>}
              {currentStageSummary && <Typography variant="body2" color="text.secondary" sx={{ mt: 1, overflowWrap: 'anywhere' }}>{currentStageSummary}</Typography>}</Box>
            {(run.run.maxModelCalls !== undefined || run.run.goalSpec?.deadlineAt) && <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
              {run.run.maxModelCalls !== undefined && <Typography variant="caption" color="text.secondary">模型调用 {countWorkflowModelCalls(run)}/{run.run.maxModelCalls}</Typography>}
              {run.run.goalSpec?.deadlineAt && <Typography variant="caption" color="text.secondary">截止 {new Date(run.run.goalSpec.deadlineAt).toLocaleString()}</Typography>}
            </Stack>}
            {plan?.finalAcceptance && <Box><Typography variant="overline" color="text.secondary">完成条件</Typography><Typography variant="body2">{plan.finalAcceptance}</Typography></Box>}
            {reviewResult && typeof reviewResult.reason === 'string' && <Alert severity={reviewResult.complete === true ? 'success' : 'warning'}>
              <Typography variant="body2"><strong>主 Agent 验收：</strong> {reviewResult.reason}</Typography></Alert>}
            {summary.blocked.length > 0 && <Alert severity="warning"><Typography variant="body2"><strong>需要处理：</strong> {summary.blocked.map((item) => item.reason).join('；')}</Typography></Alert>}
            {pauseError && <Typography role="alert" variant="body2" color="error.main">{pauseError}</Typography>}
            {canAddRevision && <Box sx={{ display: 'grid', gap: 1, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
              <Typography variant="subtitle2">追加任务</Typography>
              <TextField multiline minRows={2} fullWidth size="small" label="告诉主 Agent 接下来要做什么" value={delegateRequest}
                onChange={(event) => { setDelegateRequest(event.target.value); setDelegateError(null); }} slotProps={{ htmlInput: { maxLength: 4000 } }} disabled={savingDelegate} />
              {delegateError && <Typography role="alert" variant="caption" color="error.main">{delegateError}</Typography>}
              <Button variant="outlined" sx={{ justifySelf: 'start' }} disabled={!delegateRequest.trim() || savingDelegate} onClick={() => {
                setSavingDelegate(true);
                void onDelegate(run, delegateRequest).then(() => { setDelegateRequest(''); setDelegateError(null); }).catch((error: unknown) => setDelegateError(error instanceof Error ? error.message : '追加任务失败')).finally(() => setSavingDelegate(false));
              }}>添加到计划</Button>
            </Box>}
            {canRun && !running && run.run.status === 'paused' && run.run.goalSpec && <Accordion disableGutters elevation={0} sx={{ borderTop: '1px solid', borderBottom: '1px solid', borderColor: 'divider', '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 44, '& .MuiAccordionSummary-content': { my: 1 } }}><Typography variant="body2" sx={{ fontWeight: 650 }}>运行设置与费用</Typography></AccordionSummary>
              <AccordionDetails sx={{ display: 'grid', gap: 1.5, pt: 0 }}>
                <TeamUsagePanel key={run.run.id} runId={run.run.id} />
                <TeamBudgetPanel key={`budget:${run.run.id}`} runId={run.run.id} canEdit={canRun && !running && run.run.status === 'paused'}
                  onSave={(input) => updateAgentTeamPlatformBudget({ ...input, runId: run.run.id, expectedPlanVersion: run.run.planVersion })} />
                <Divider />
                <TextField size="small" type="datetime-local" label="任务截止时间" value={deadline} onChange={(event) => { setDeadline(event.target.value); setDeadlineError(null); }} disabled={savingDeadline} slotProps={{ inputLabel: { shrink: true } }} helperText="留空并保存可取消截止时间。" />
                {deadlineError && <Typography role="alert" variant="caption" color="error.main">{deadlineError}</Typography>}
                <Button size="small" sx={{ justifySelf: 'start' }} disabled={savingDeadline || Boolean(deadline && !Number.isFinite(new Date(deadline).getTime()))} onClick={() => {
                  setSavingDeadline(true);
                  void onUpdateDeadline(run, deadline ? new Date(deadline).getTime() : undefined)
                    .then(() => setDeadlineError(null)).catch((error: unknown) => setDeadlineError(error instanceof Error ? error.message : '保存截止时间失败'))
                    .finally(() => setSavingDeadline(false));
                }}>保存截止时间</Button>
                <TextField size="small" type="number" label="模型调用总上限" value={modelCallLimit} onChange={(event) => { setModelCallLimit(event.target.value); setLimitError(null); }} disabled={savingLimit} helperText="留空表示不限制。" slotProps={{ htmlInput: { min: countWorkflowModelCalls(run) + 1, max: 1000, step: 1 } }} />
                {limitError && <Typography role="alert" variant="caption" color="error.main">{limitError}</Typography>}
                <Button size="small" sx={{ justifySelf: 'start' }} disabled={savingLimit || Boolean(modelCallLimit.trim() && (!Number.isSafeInteger(Number(modelCallLimit)) || Number(modelCallLimit) <= countWorkflowModelCalls(run) || Number(modelCallLimit) > 1000))} onClick={() => {
                  setSavingLimit(true);
                  void onUpdateModelCallLimit(run, modelCallLimit.trim() ? Number(modelCallLimit) : undefined)
                    .then(() => { setLimitError(null); setModelCallLimit(''); }).catch((error: unknown) => setLimitError(error instanceof Error ? error.message : '调整模型调用上限失败'))
                    .finally(() => setSavingLimit(false));
                }}>保存调用上限</Button>
              </AccordionDetails>
            </Accordion>}
          </Box>}
        </Box>
    </DialogContent>
    <DialogActions sx={{ px: { xs: 2, md: 3 }, py: 1.5, borderTop: '1px solid', borderColor: 'divider', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
      <Button onClick={onClose}>关闭</Button>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        {canRun && running && !run.run.pauseRequested && <Button onClick={() => { void onPause(run).then(() => setPauseError(null)).catch((error: unknown) => setPauseError(error instanceof Error ? error.message : '暂停任务失败')); }}>当前步骤完成后暂停</Button>}
        {canResume && <Button variant="contained" onClick={() => onResume(run)}>{primaryActionLabel}</Button>}
      </Stack>
      {resumeAllError && <Typography role="alert" variant="caption" color="error.main" sx={{ flexBasis: '100%', textAlign: 'right' }}>{resumeAllError}</Typography>}
    </DialogActions>
  </Dialog>;
}
