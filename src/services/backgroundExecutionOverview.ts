import { isRecoverableAgentTeamRun, listAgentTeamRuns as listTeamRuns, runAgentTeam } from './agentTeamWorkflow';
import { listAssistantBackgroundReplies, resumeAssistantBackgroundReply } from './assistantBackgroundReply';
import { getBackgroundExecutionSummary } from './backgroundExecutionScheduler';
import { listDirectBackgroundReplies, resumeDirectBackgroundReply } from './directBackgroundReply';
import { listAiDirectBackgroundReplies, resumeAiDirectBackgroundReply } from './aiDirectBackgroundReply';
import { listGroupBackgroundConversations, startGroupBackgroundConversation } from './groupBackgroundConversation';
import { useChatStore } from '../stores/useChatStore';
import { resolveSessionFamilyKey } from './sessionEngineKeys';
import type { WorkflowSnapshot } from './workflowRunRuntime';

export function isSafelyResumableWorkflow(snapshot: WorkflowSnapshot) {
  return snapshot.run.status === 'paused'
    && snapshot.tasks.length > 0
    && snapshot.tasks.every((task) => task.status !== 'failed' && task.status !== 'result_unknown' && task.status !== 'waiting_user' && task.status !== 'cancelled')
    && snapshot.tasks.some((task) => task.status === 'queued' || task.status === 'waiting_dependency' || task.status === 'waiting_external');
}

export interface BackgroundExecutionOverview {
  running: number;
  queued: number;
  interrupted: number;
  blocked: number;
  resumable: number;
  chatId: string | null;
}

type RecoverableSnapshotLists = {
  assistant: WorkflowSnapshot[];
  direct: WorkflowSnapshot[];
  aiDirect: WorkflowSnapshot[];
  group: WorkflowSnapshot[];
  team: WorkflowSnapshot[];
};

function collectSafelyRecoverableRuns({ assistant, direct, aiDirect, group, team }: RecoverableSnapshotLists, chats: ReturnType<typeof useChatStore.getState>['chats']) {
  return [
    ...assistant.filter(isSafelyResumableWorkflow).map((snapshot) => ({ snapshot, start: () => resumeAssistantBackgroundReply(snapshot.run.id, `home-resume-${crypto.randomUUID()}`) })),
    ...direct.filter(isSafelyResumableWorkflow).map((snapshot) => ({ snapshot, start: () => resumeDirectBackgroundReply(snapshot.run.id) })),
    ...aiDirect.filter(isSafelyResumableWorkflow).map((snapshot) => ({ snapshot, start: () => resumeAiDirectBackgroundReply(snapshot.run.id) })),
    ...team.filter((snapshot) => isSafelyResumableWorkflow(snapshot) && isRecoverableAgentTeamRun(snapshot)).map((snapshot) => ({ snapshot, start: () => runAgentTeam({ chatId: snapshot.run.chatId, goal: snapshot.run.goal, runId: snapshot.run.id }) })),
    ...group.filter((snapshot) => {
      const chat = chats.find((item) => item.id === snapshot.run.chatId);
      return Boolean(chat && isSafelyResumableWorkflow(snapshot)
        && snapshot.tasks.every((task) => task.kind === 'group_conversation_turn')
        && ['conversation', 'study', 'analysis'].includes(resolveSessionFamilyKey(chat))
        && chat.sessionKind?.scenarioId !== 'story-reader');
    }).map((snapshot) => ({ snapshot, start: () => startGroupBackgroundConversation(snapshot.run.chatId) })),
  ];
}

export function projectBackgroundExecutionOverview(
  runs: WorkflowSnapshot[],
  activeRunIds: string[],
): BackgroundExecutionOverview {
  const activeRuns = new Set(activeRunIds);
  const overview: BackgroundExecutionOverview = { running: 0, queued: 0, interrupted: 0, blocked: 0, resumable: 0, chatId: null };
  const relevant = runs.filter(({ run, tasks }) => run.status !== 'completed' && run.status !== 'cancelled'
    && tasks.some((task) => task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'abandoned'));
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
  const [assistant, direct, aiDirect, group, team] = await Promise.all([
    listAssistantBackgroundReplies(),
    listDirectBackgroundReplies(),
    listAiDirectBackgroundReplies(),
    listGroupBackgroundConversations(),
    listTeamRuns(),
  ]);
  const runs = [...assistant, ...direct, ...aiDirect, ...group, ...team];
  const overview = projectBackgroundExecutionOverview(
    runs,
    getBackgroundExecutionSummary().activeWorkIds,
  );
  overview.resumable = collectSafelyRecoverableRuns({ assistant, direct, aiDirect, group, team }, useChatStore.getState().chats).length;
  return overview;
}

export async function resumeAllSafelyRecoverableBackgroundRuns() {
  const [assistant, direct, aiDirect, group, team] = await Promise.all([
    listAssistantBackgroundReplies(),
    listDirectBackgroundReplies(),
    listAiDirectBackgroundReplies(),
    listGroupBackgroundConversations(),
    listTeamRuns(),
  ]);
  const candidates = collectSafelyRecoverableRuns({ assistant, direct, aiDirect, group, team }, useChatStore.getState().chats);
  const tasks = candidates.map(({ snapshot, start }) => Promise.resolve().then(async () => { await start(); }).catch((error: unknown) => {
    console.error('[background-run:bulk-resume-failed]', { runId: snapshot.run.id, error });
  }));
  void Promise.all(tasks);
  return { submitted: tasks.length };
}
