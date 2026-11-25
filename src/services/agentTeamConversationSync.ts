import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { getChatExecutionFence } from './chatExecutionFence';
import { currentWorkflowScope, indexedDbWorkflowRepository } from './workflowRunRuntime';
import { waitForMessageCloudConfirmation } from './messageCloudConfirmation';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function teamMessageMatches(message: { id?: string; metadata?: unknown }, runIds: Set<string>, userMessageIds: Set<string>) {
  const metadata = record(message.metadata);
  const media = metadata.agentTeamMedia;
  if (media && typeof media === 'object' && 'runId' in media && typeof media.runId === 'string' && runIds.has(media.runId)) return true;
  const replyTo = metadata.assistantReplyToUserMessageId;
  return typeof replyTo === 'string' && userMessageIds.has(replyTo)
    && (typeof metadata.assistantReplyRunId === 'string' || metadata.assistantTeamFinal === true);
}

function operationOwnedByTeam(operation: { chatId?: string; entityId?: string; payload?: { id?: string; metadata?: unknown }; patch?: unknown }, chatId: string, runIds: Set<string>, userMessageIds: Set<string>) {
  if (operation.chatId === chatId && operation.payload && teamMessageMatches(operation.payload, runIds, userMessageIds)) return true;
  if (operation.entityId !== chatId || !operation.patch) return false;
  const patch = record(operation.patch);
  const latest = patch.latestMessage;
  if (latest && typeof latest === 'object' && !Array.isArray(latest)
    && teamMessageMatches(latest as { metadata?: unknown }, runIds, userMessageIds)) return true;
  const state = patch.messageBranchState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const text = JSON.stringify(state);
  return [...runIds].some((id) => text.includes(id)) || [...userMessageIds].some((id) => text.includes(`assistant-team-result-${id}`));
}

export async function synchronizePendingAgentTeamConversationWrites(chatId: string, signal?: AbortSignal) {
  const fence = getChatExecutionFence(chatId);
  if (!fence) return;
  const scope = currentWorkflowScope();
  const runs = await indexedDbWorkflowRepository.list(scope);
  const teamRuns = runs.filter((run) => run.run.chatId === chatId && run.tasks[0]?.kind === 'team_plan');
  const runIds = new Set(teamRuns.map((run) => run.run.id));
  const userMessageIds = new Set(teamRuns.map((run) => run.run.id.startsWith('team-') ? run.run.id.slice(5) : '').filter(Boolean));
  if (!runIds.size) return;

  const messages = useMessageStore.getState();
  const selectedMessages = [...messages.messages, ...Object.values(messages.messageWindowsByChatId).flatMap((window) => window.messages)]
    .filter((message) => message.chatId === chatId && teamMessageMatches(message, runIds, userMessageIds))
    .sort((left, right) => (left.metadata?.branching?.sequence ?? 0) - (right.metadata?.branching?.sequence ?? 0)
      || left.timestamp - right.timestamp);
  const selectedIds = new Set(selectedMessages.map((message) => message.id));
  useMessageStore.setState((state) => ({
    pendingOperations: state.pendingOperations.map((operation) => {
      if (!operationOwnedByTeam(operation, chatId, runIds, userMessageIds)
        || operation.executionFence?.ownerId === fence.ownerId && operation.executionFence.generation === fence.generation) return operation;
      if (operation.status === 'failed' && !operation.lastError?.startsWith('ownership_conflict:')) return operation;
      return { ...operation, executionFence: fence, status: 'pending' as const, lastError: undefined, retryAt: 0, lockedAt: 0 };
    }),
  }));
  useChatStore.setState((state) => ({
    pendingOperations: state.pendingOperations.map((operation) => {
      if (!operationOwnedByTeam(operation, chatId, runIds, userMessageIds)
        || operation.executionFence?.ownerId === fence.ownerId && operation.executionFence.generation === fence.generation) return operation;
      if (operation.status === 'failed' && !operation.lastError?.startsWith('ownership_conflict:')) return operation;
      return { ...operation, executionFence: fence, status: 'pending' as const, lastError: undefined, retryAt: 0, lockedAt: 0 };
    }),
  }));
  flushBufferedPersistenceWrites();

  for (const message of selectedMessages) {
    if (signal?.aborted) throw signal.reason || new Error('团队消息同步已中断');
    for (let attempt = 0; attempt < 20; attempt++) {
      let state = useMessageStore.getState();
      let latest = [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]
        .find((item) => item.id === message.id || (message.clientKey && item.clientKey === message.clientKey));
      if (latest?.serverId) break;
      const operation = state.pendingOperations.find((item) => item.chatId === chatId && selectedIds.has(item.localMessageId || item.messageId || '')
        && (item.localMessageId === message.id || item.messageId === message.id || item.payload?.clientKey === message.clientKey));
      if (operation?.status === 'failed') throw new Error(`团队聊天同步失败：${operation.lastError || '服务器未接受分支消息'}`);
      await useChatStore.getState().flushPendingOperations();
      await useMessageStore.getState().flushPendingOperations();
      state = useMessageStore.getState();
      latest = [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]
        .find((item) => item.id === message.id || (message.clientKey && item.clientKey === message.clientKey));
      if (latest?.serverId) break;
      await waitForMessageCloudConfirmation({ chatId, messageId: message.id, signal, timeoutMs: 300 }).catch(() => undefined);
    }
    const state = useMessageStore.getState();
    const latest = [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]
      .find((item) => item.id === message.id || (message.clientKey && item.clientKey === message.clientKey));
    if (!latest?.serverId) {
      const operation = state.pendingOperations.find((item) => item.chatId === chatId
        && (item.localMessageId === message.id || item.messageId === message.id || item.payload?.clientKey === message.clientKey));
      throw new Error(`团队聊天同步未完成：${operation?.lastError || '分支父消息仍未获云端确认'}`);
    }
  }
}
