import { isRecoverableAgentTeamRun, listAgentTeamRuns as listTeamRuns, runAgentTeam } from './agentTeamWorkflow';
import { listAssistantBackgroundReplies, resumeAssistantBackgroundReply } from './assistantBackgroundReply';
import { getBackgroundExecutionSummary } from './backgroundExecutionScheduler';
import { listDirectBackgroundReplies, resumeDirectBackgroundReply } from './directBackgroundReply';
import { listAiDirectBackgroundReplies, resumeAiDirectBackgroundReply } from './aiDirectBackgroundReply';
import { listAiDirectBackgroundConversations, listGroupBackgroundConversations, startAiDirectBackgroundConversation, startGroupBackgroundConversation } from './groupBackgroundConversation';
import { useChatStore } from '../stores/useChatStore';
import { resolveSessionFamilyKey } from './sessionEngineKeys';
import type { WorkflowSnapshot } from './workflowRunRuntime';
import { canContinueConversationsInBackground } from './backgroundExecutionPreferences';

export function isSafelyResumableWorkflow(snapshot: WorkflowSnapshot) {
  return snapshot.run.status === 'paused'
    && snapshot.tasks.length > 0
    && snapshot.tasks.every((task) => task.status !== 'failed' && task.status !== 'result_unknown' && task.status !== 'waiting_user' && task.status !== 'cancelled')
    && snapshot.tasks.some((task) => task.status === 'queued' || task.status === 'waiting_dependency' || task.status === 'waiting_external');
}

export function isSafelyResumableConversation(snapshot: WorkflowSnapshot, chat: ReturnType<typeof useChatStore.getState>['chats'][number]) {
  if (chat.deletedAt != null) return false;
  if (chat.type === 'group' && (chat.sessionKind?.scenarioId === 'story-reader'
    || !['conversation', 'analysis'].includes(resolveSessionFamilyKey(chat)))) return false;
  if (chat.type !== 'group' && chat.type !== 'ai_direct') return false;
  if (isSafelyResumableWorkflow(snapshot)) return true;
  if (snapshot.run.status !== 'paused' || !snapshot.tasks.length
    || !snapshot.tasks.every((task) => task.status === 'completed')
    || snapshot.tasks.some((task) => task.status === 'failed' || task.status === 'result_unknown' || task.status === 'waiting_user' || task.status === 'cancelled')) return false;
  const latestOutcome = (snapshot.tasks.at(-1)?.output as { outcome?: string } | undefined)?.outcome;
  if (latestOutcome !== 'committed') return false;
  return true;
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
  aiDirectConversations: WorkflowSnapshot[];
  team: WorkflowSnapshot[];
};

function collectSafelyRecoverableRuns({ assistant, direct, aiDirect, group, aiDirectConversations, team }: RecoverableSnapshotLists, chats: ReturnType<typeof useChatStore.getState>['chats']) {
  return [
    ...assistant.filter((snapshot) => canContinueConversationsInBackground() && isSafelyResumableWorkflow(snapshot)
      && chats.some((chat) => chat.id === snapshot.run.chatId && chat.type === 'assistant' && chat.deletedAt == null))
      .map((snapshot) => ({ snapshot, start: () => resumeAssistantBackgroundReply(snapshot.run.id, `home-resume-${crypto.randomUUID()}`) })),
    ...direct.filter((snapshot) => canContinueConversationsInBackground() && isSafelyResumableWorkflow(snapshot)
      && chats.some((chat) => chat.id === snapshot.run.chatId && chat.type === 'direct' && chat.deletedAt == null))
      .map((snapshot) => ({ snapshot, start: () => resumeDirectBackgroundReply(snapshot.run.id) })),
    ...aiDirect.filter((snapshot) => canContinueConversationsInBackground() && isSafelyResumableWorkflow(snapshot)
      && chats.some((chat) => chat.id === snapshot.run.chatId && chat.type === 'ai_direct' && chat.deletedAt == null))
      .map((snapshot) => ({ snapshot, start: () => resumeAiDirectBackgroundReply(snapshot.run.id) })),
    ...team.filter((snapshot) => canContinueConversationsInBackground() && isSafelyResumableWorkflow(snapshot) && isRecoverableAgentTeamRun(snapshot)
      && chats.some((chat) => chat.id === snapshot.run.chatId && chat.type === 'assistant' && chat.deletedAt == null))
      .map((snapshot) => ({ snapshot, start: () => runAgentTeam({ chatId: snapshot.run.chatId, goal: snapshot.run.goal, runId: snapshot.run.id }) })),
    ...aiDirectConversations.filter((snapshot) => {
      const chat = chats.find((item) => item.id === snapshot.run.chatId);
      return Boolean(canContinueConversationsInBackground() && chat?.type === 'ai_direct' && chat.deletedAt == null
        && snapshot.tasks.every((task) => task.kind === 'ai_direct_conversation_turn')
        && isSafelyResumableConversation(snapshot, chat));
    })
      .map((snapshot) => ({ snapshot, start: () => startAiDirectBackgroundConversation(snapshot.run.chatId) })),
    ...group.filter((snapshot) => {
      const chat = chats.find((item) => item.id === snapshot.run.chatId);
      return Boolean(canContinueConversationsInBackground() && chat?.type === 'group' && isSafelyResumableConversation(snapshot, chat)
        && snapshot.tasks.every((task) => task.kind === 'group_conversation_turn'));
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
  const [assistant, direct, aiDirect, group, aiDirectConversations, team] = await Promise.all([
    listAssistantBackgroundReplies(),
    listDirectBackgroundReplies(),
    listAiDirectBackgroundReplies(),
    listGroupBackgroundConversations(),
    listAiDirectBackgroundConversations(),
    listTeamRuns(),
  ]);
  const runs = [...assistant, ...direct, ...aiDirect, ...group, ...aiDirectConversations, ...team];
  const overview = projectBackgroundExecutionOverview(
    runs,
    getBackgroundExecutionSummary().activeWorkIds,
  );
  overview.resumable = collectSafelyRecoverableRuns({ assistant, direct, aiDirect, group, aiDirectConversations, team }, useChatStore.getState().chats).length;
  return overview;
}

export async function resumeAllSafelyRecoverableBackgroundRuns() {
  const [assistant, direct, aiDirect, group, aiDirectConversations, team] = await Promise.all([
    listAssistantBackgroundReplies(),
    listDirectBackgroundReplies(),
    listAiDirectBackgroundReplies(),
    listGroupBackgroundConversations(),
    listAiDirectBackgroundConversations(),
    listTeamRuns(),
  ]);
  const candidates = collectSafelyRecoverableRuns({ assistant, direct, aiDirect, group, aiDirectConversations, team }, useChatStore.getState().chats);
  const tasks = candidates.map(({ snapshot, start }) => Promise.resolve().then(async () => { await start(); }).catch((error: unknown) => {
    console.error('[background-run:bulk-resume-failed]', { runId: snapshot.run.id, error });
  }));
  void Promise.all(tasks);
  return { submitted: tasks.length };
}
