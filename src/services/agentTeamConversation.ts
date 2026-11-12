import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { buildBranchStateWithHead, isMessageBranchingEnabled, resolveMessageNodeId } from './messageBranching';
import type { WorkflowGoalSpec } from './workflowGoalSpec';

export function captureTeamSourceBranch(chat: GroupChat): NonNullable<WorkflowGoalSpec['sourceBranch']> {
  const state = chat.messageBranchState;
  const name = state?.activeBranchName || 'main';
  return { enabled: isMessageBranchingEnabled(chat), name,
    headNodeId: state?.refs?.[name]?.headNodeId ?? state?.activeLeafNodeId ?? null };
}

export function teamConversationBlockReason(chat: GroupChat | undefined, spec?: WorkflowGoalSpec): string | undefined {
  if (!chat || chat.deletedAt != null || chat.type !== 'assistant') return '助手会话已删除或不可用';
  if (!spec?.sourceBranch) return undefined;
  const current = captureTeamSourceBranch(chat);
  return current.enabled !== spec.sourceBranch.enabled || current.name !== spec.sourceBranch.name
    ? '聊天分支已切换。请回到启动任务的分支，再继续整个任务。' : undefined;
}

/** Already dispatched work keeps its original thread even if the user switches tabs mid-request. */
export function teamConversationContext(chat: GroupChat, spec?: Pick<WorkflowGoalSpec, 'sourceBranch'>): GroupChat {
  const source = spec?.sourceBranch;
  if (!source) return chat;
  if (!source.enabled) return { ...chat, messageBranchState: { ...chat.messageBranchState, enabled: false } };
  const ref = chat.messageBranchState?.refs?.[source.name];
  return { ...chat, messageBranchState: { ...chat.messageBranchState, enabled: true, activeBranchName: source.name,
    activeLeafNodeId: ref?.headNodeId ?? source.headNodeId,
    refs: { ...chat.messageBranchState?.refs, [source.name]: ref ?? {
      name: source.name, headNodeId: source.headNodeId, createdAt: chat.createdAt, updatedAt: chat.updatedAt, version: 0,
    } } } };
}

/** Advance the originating thread without changing the branch the user is viewing. */
export async function advanceTeamConversation(message: Message, sourceBranch?: WorkflowGoalSpec['sourceBranch']) {
  const store = useChatStore.getState();
  await store.applyChatRuntimePatch(message.chatId, (chat) => {
    const context = teamConversationContext(chat, { sourceBranch });
    if (!isMessageBranchingEnabled(context)) return null;
    const state = buildBranchStateWithHead(context.messageBranchState, resolveMessageNodeId(message));
    const current = chat.messageBranchState;
    if ((current?.activeBranchName || 'main') !== state.activeBranchName) {
      state.activeBranchName = current?.activeBranchName;
      state.activeLeafNodeId = current?.activeLeafNodeId;
      state.enabled = current?.enabled;
    }
    return { messageBranchState: state };
  });
}
