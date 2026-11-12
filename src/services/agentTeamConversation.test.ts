import { describe, expect, it } from 'vitest';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { attachMessageToActiveBranch } from './messageBranching';
import { advanceTeamConversation, captureTeamSourceBranch, teamConversationBlockReason, teamConversationContext } from './agentTeamConversation';
import { defaultWorkflowGoalSpec, parseWorkflowGoalSpec, workflowGoalContext } from './workflowGoalSpec';

describe('team conversation ownership', () => {
  const fixture = (): GroupChat => ({ id: 'branch-chat', type: 'assistant', name: '助手', memberIds: [], createdAt: 1, updatedAt: 1,
    messageBranchState: { enabled: true, activeBranchName: 'main', activeLeafNodeId: 'origin', refs: {
      main: { name: 'main', headNodeId: 'origin', createdAt: 1, updatedAt: 1, version: 1 },
      other: { name: 'other', headNodeId: 'alternate', createdAt: 1, updatedAt: 1, version: 1 },
    } },
  } as GroupChat);

  it('validates and preserves the binding without leaking branch metadata into model context', () => {
    const spec = { ...defaultWorkflowGoalSpec('目标'), sourceBranch: captureTeamSourceBranch(fixture()) };
    expect(parseWorkflowGoalSpec(spec).sourceBranch).toEqual(spec.sourceBranch);
    expect(workflowGoalContext(spec)).not.toContain('origin');
    expect(() => parseWorkflowGoalSpec({ ...spec, sourceBranch: { ...spec.sourceBranch, enabled: 'true' } })).toThrow('来源分支');
    expect(parseWorkflowGoalSpec(defaultWorkflowGoalSpec('旧任务')).sourceBranch).toBeUndefined();
    expect(teamConversationBlockReason(fixture(), spec)).toBeUndefined();
    expect(teamConversationBlockReason(undefined, spec)).toContain('不可用');
  });

  it('attaches in-flight output to its originating branch and advances only that branch', async () => {
    const chat = fixture();
    const spec = { ...defaultWorkflowGoalSpec('目标'), sourceBranch: captureTeamSourceBranch(chat) };
    const switched = { ...chat, messageBranchState: { ...chat.messageBranchState, activeBranchName: 'other', activeLeafNodeId: 'alternate' } };
    useChatStore.setState({ chats: [switched] });
    expect(teamConversationBlockReason(switched, spec)).toContain('分支已切换');
    const message = attachMessageToActiveBranch(teamConversationContext(switched, spec), [], {
      id: 'result', chatId: chat.id, type: 'ai', senderId: 'assistant', content: '完成', timestamp: 2, isDeleted: false,
    }) as Message;
    expect(message.metadata?.branching?.parentNodeId).toBe('origin');
    await advanceTeamConversation(message, spec.sourceBranch);
    const state = useChatStore.getState().chats.find((item) => item.id === chat.id)?.messageBranchState;
    expect(state?.activeBranchName).toBe('other');
    expect(state?.activeLeafNodeId).toBe('alternate');
    expect(state?.refs?.other.headNodeId).toBe('alternate');
    expect(state?.refs?.main.headNodeId).toBe('result');
  });
});
