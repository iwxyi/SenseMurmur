import { listAgentTeamRuns } from './agentTeamWorkflow';
import { listAssistantBackgroundReplies } from './assistantBackgroundReply';
import { getBackgroundExecutionSummary } from './backgroundExecutionScheduler';
import { listDirectBackgroundReplies } from './directBackgroundReply';
import { listAiDirectBackgroundReplies } from './aiDirectBackgroundReply';
import type { WorkflowSnapshot } from './workflowRunRuntime';

export interface BackgroundExecutionOverview {
  running: number;
  queued: number;
  interrupted: number;
  blocked: number;
  chatId: string | null;
}

export function projectBackgroundExecutionOverview(
  runs: WorkflowSnapshot[],
  activeRunIds: string[],
): BackgroundExecutionOverview {
  const activeRuns = new Set(activeRunIds);
  const overview: BackgroundExecutionOverview = { running: 0, queued: 0, interrupted: 0, blocked: 0, chatId: null };
  const relevant = runs.filter(({ run, tasks }) => run.status !== 'completed' && run.status !== 'cancelled'
    && tasks.some((task) => task.status !== 'completed' && task.status !== 'cancelled'));
  for (const { run, tasks } of relevant) {
    if (tasks.some((task) => task.status === 'failed' || task.status === 'result_unknown' || task.status === 'waiting_user')) {
      overview.blocked += 1;
    } else if (run.status === 'paused') {
      overview.interrupted += 1;
    } else if (activeRuns.has(run.id)) {
      overview.running += 1;
    } else {
      overview.queued += 1;
    }
  }
  const first = relevant.find(({ run }) => activeRuns.has(run.id)) || relevant[0];
  overview.chatId = first?.run.chatId || null;
  return overview;
}

export async function loadBackgroundExecutionOverview() {
  const [assistant, direct, aiDirect, team] = await Promise.all([
    listAssistantBackgroundReplies(),
    listDirectBackgroundReplies(),
    listAiDirectBackgroundReplies(),
    listAgentTeamRuns(),
  ]);
  return projectBackgroundExecutionOverview(
    [...assistant, ...direct, ...aiDirect, ...team],
    getBackgroundExecutionSummary().activeWorkIds,
  );
}
