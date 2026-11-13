import type { Message } from '../types/message';
import type { WorkflowSnapshot, WorkflowTask } from './workflowRunRuntime';
import { summarizeWorkflowRun } from './workflowRunRuntime';
import { sanitizeUserFacingText } from './displayTextSanitizer';
import { createChatNoticeMessage } from './chatNotice';

function taskName(task: WorkflowTask) {
  if (task.kind === 'team_plan') return '规划协作步骤';
  if (task.kind === 'team_plan_revision') return '安排补充工作';
  if (task.kind === 'team_review') return '检查交付结果';
  if (task.kind === 'agent_delegation') return '协调子 Agent';
  if (task.kind === 'agent_video') return '生成视频';
  if (task.kind === 'agent_image') return '生成图片素材';
  if (task.kind === 'agent_audio') return '生成音频';
  if (task.kind === 'agent_media_composition') return '合并媒体素材';
  if (task.kind === 'agent_web_search') return '查找资料';
  if (task.kind === 'agent_image_inspection' || task.kind === 'agent_video_inspection') return '检查媒体素材';
  if (task.kind === 'agent_user_input') return '等待补充信息';
  if (task.kind === 'agent_text') return '撰写内容';
  return '执行任务';
}

function taskState(task: WorkflowTask) {
  if (task.status === 'completed') return '已完成';
  if (task.status === 'failed') return '失败';
  if (task.status === 'waiting_external') return task.kind === 'agent_video' ? '等待视频生成' : '等待生成';
  if (task.status === 'waiting_user') return '等待你决定';
  if (task.status === 'waiting_dependency') return '等待前置步骤';
  if (task.status === 'running') return '进行中';
  if (task.status === 'result_unknown') return '结果待确认';
  if (task.status === 'cancelled' || task.status === 'abandoned') return '已停止';
  return '排队中';
}

function entryForRun(snapshot: WorkflowSnapshot) {
  const failed = snapshot.tasks.find((task) => task.status === 'failed' || task.status === 'result_unknown');
  const current = failed || snapshot.tasks.find((task) => task.status === 'running' || task.status === 'waiting_external' || task.status === 'waiting_user')
    || snapshot.tasks.find((task) => task.status === 'queued' || task.status === 'waiting_dependency');
  const summary = summarizeWorkflowRun(snapshot);
  const status = failed ? 'failed' as const : snapshot.run.status === 'paused' ? 'paused' as const : 'active' as const;
  const details = snapshot.tasks.slice(-8).map((task) => {
    const goal = task.input && typeof task.input === 'object' && 'task' in task.input
      ? (task.input as { task?: { goal?: unknown } }).task?.goal : undefined;
    const label = typeof goal === 'string' && goal.trim() ? sanitizeUserFacingText(goal).slice(0, 160) : taskName(task);
    return `${label} · ${taskState(task)}`;
  });
  const error = failed?.error ? sanitizeUserFacingText(failed.error).slice(0, 500) : undefined;
  return {
    runId: snapshot.run.id,
    status,
    completed: summary.completed.length,
    total: snapshot.tasks.filter((task) => task.status !== 'abandoned').length,
    current: current ? `${taskName(current)} · ${taskState(current)}` : undefined,
    error,
    details,
  };
}

export function assistantTeamProgressMessage(chatId: string, snapshots: WorkflowSnapshot[], visibleSourceMessageIds?: ReadonlySet<string>): Message | null {
  const relevant = snapshots
    .filter((snapshot) => snapshot.run.status === 'active' || snapshot.run.status === 'paused' || snapshot.run.status === 'failed')
    .filter((snapshot) => !visibleSourceMessageIds || !snapshot.run.goalSpec?.sourceBranch?.enabled
      || Boolean(snapshot.run.goalSpec.sourceBranch.headNodeId && visibleSourceMessageIds.has(snapshot.run.goalSpec.sourceBranch.headNodeId))
      || (snapshot.run.id.startsWith('team-') && visibleSourceMessageIds.has(snapshot.run.id.slice('team-'.length))))
    .sort((left, right) => right.run.updatedAt - left.run.updatedAt)
    .slice(0, 3);
  if (!relevant.length) return null;
  const entries = relevant.map(entryForRun);
  const failed = entries.find((entry) => entry.status === 'failed');
  const working = entries.find((entry) => entry.status === 'active');
  const content = failed?.error
    ? `任务遇到问题：${failed.error}`
    : working?.current ? working.current : entries[0].status === 'paused' ? '任务已暂停' : '正在整理执行步骤';
  const details = entries.flatMap((entry) => [...entry.details, ...(entry.error ? [`问题：${entry.error}`] : [])]);
  const timestamp = Math.max(...relevant.map((snapshot) => snapshot.run.updatedAt));
  return createChatNoticeMessage({ id: `assistant-team-progress-${chatId}`, chatId, content, timestamp,
    notice: { tone: failed ? 'error' : working ? 'working' : 'warning', details,
      progress: entries[0] ? { completed: entries[0].completed, total: entries[0].total } : undefined } });
}

export function assistantTeamFailureReply(error: string) {
  const readable = sanitizeUserFacingText(error).slice(0, 500) || '团队任务暂时无法继续';
  const remedy = readable.includes('未配置视频模型')
    ? '请先在模型设置中配置可用的视频模型，再到工作台重试规划。'
    : readable.includes('未配置图片模型')
      ? '请先在模型设置中配置可用的图片模型，再到工作台重试规划。'
      : '你可以根据工作台显示的问题修正设置，再重试失败步骤。';
  return `团队任务暂时无法继续：${readable}\n\n${remedy}已完成的步骤会保留。`;
}
