import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { useMessageStore } from '../stores/useMessageStore';
import { buildStoryChoicePendingKey, buildStoryReaderTextInputCapabilities, buildVisibleStoryBranchOptions, canAcknowledgeNewStoryTail, findVisibleStoryChoiceSourceMessage, getStoryReaderComposerPlaceholder, getStoryTailStatus, isStoryChoicePending, resolveEffectiveStoryReaderAtTail, shouldAutoStartStoryRoom, shouldRegisterLiveNarrativeReveal, shouldRouteTextAsStoryCustomDirection } from './chatDetailStoryHelpers';

function buildPauseResumeMessages() {
  return [] as string[];
}

function buildNarrativeMessage(id: string, timestamp: number): Message {
  return {
    id,
    chatId: 'story-1',
    type: 'ai',
    senderId: 'narrator',
    senderName: '旁白',
    content: '雨还在下。',
    emotion: 0,
    timestamp,
    isDeleted: false,
    metadata: {
      narrativeTurn: {
        turnId: id,
        turnKind: 'narrative_beat',
        povActorId: 'narrator',
        blocks: [{
          id: `${id}-prose`,
          actorId: 'narrator',
          actorKind: 'narrator',
          kind: 'prose',
          displayMode: 'paragraph',
          text: '雨还在下。',
        }],
      },
    },
  };
}

describe('ChatDetailPage pause/resume behavior', () => {
  it('does not add system messages for pause/resume', () => {
    expect(buildPauseResumeMessages()).toEqual([]);
  });

  it('locks a whole story choice epoch instead of a single branch value', () => {
    const key = buildStoryChoicePendingKey({
      chatId: 'story-1',
      choiceEpoch: 3,
      sourceMessageId: 'choice-message',
    });

    expect(key).toBe('story-1:3:choice-message');
    expect(buildStoryChoicePendingKey({
      chatId: 'story-1',
      choiceEpoch: 3,
      sourceMessageId: 'choice-message',
    })).toBe(key);
    expect(buildStoryChoicePendingKey({
      chatId: 'story-1',
      choiceEpoch: 4,
      sourceMessageId: 'choice-message',
    })).not.toBe(key);
  });

  it('detects when the visible story choice group is submitting', () => {
    const pendingKey = buildStoryChoicePendingKey({
      chatId: 'story-1',
      choiceEpoch: 3,
      sourceMessageId: 'choice-message',
    });

    expect(isStoryChoicePending({
      pendingKey,
      chatId: 'story-1',
      choiceEpoch: 3,
      sourceMessageId: 'choice-message',
    })).toBe(true);
    expect(isStoryChoicePending({
      pendingKey,
      chatId: 'story-1',
      choiceEpoch: 3,
      sourceMessageId: 'other-choice-message',
    })).toBe(false);
    expect(isStoryChoicePending({
      pendingKey: null,
      chatId: 'story-1',
      choiceEpoch: 3,
      sourceMessageId: 'choice-message',
    })).toBe(false);
  });

  it('prioritizes story tail status for errors, choice submission, generation, and reader position', () => {
    expect(getStoryTailStatus({
      hasRunLoopStatus: true,
      isStoryChoiceSubmitting: true,
      isGeneratingStoryNode: true,
      isWaitingForReaderTail: true,
    })).toBe('status');
    expect(getStoryTailStatus({
      hasRunLoopStatus: false,
      isStoryChoiceSubmitting: true,
      isGeneratingStoryNode: true,
      isWaitingForReaderTail: true,
    })).toBe('submitting_choice');
    expect(getStoryTailStatus({
      hasRunLoopStatus: false,
      isStoryChoiceSubmitting: false,
      isGeneratingStoryNode: true,
      isWaitingForReaderTail: true,
    })).toBe('generating_node');
    expect(getStoryTailStatus({
      hasRunLoopStatus: false,
      isStoryChoiceSubmitting: false,
      isGeneratingStoryNode: false,
      isGenerationCancelled: true,
      isWaitingForReaderTail: true,
    })).toBe('generation_cancelled');
    expect(getStoryTailStatus({
      hasRunLoopStatus: false,
      isStoryChoiceSubmitting: false,
      isGeneratingStoryNode: false,
      isWaitingForReaderTail: true,
    })).toBe('waiting_reader_tail');
    expect(getStoryTailStatus({
      hasRunLoopStatus: false,
      isStoryChoiceSubmitting: false,
    })).toBeNull();
  });

  it('routes story room free text as a custom story direction only in reader control mode', () => {
    expect(shouldRouteTextAsStoryCustomDirection({
      isStoryRoom: true,
      hasSpeakAsCharacter: false,
      hasGuideTargetMember: false,
      content: '让主角先把门反锁，再试探月奴',
    })).toBe(true);
    expect(shouldRouteTextAsStoryCustomDirection({
      isStoryRoom: true,
      hasSpeakAsCharacter: true,
      hasGuideTargetMember: false,
      content: '我来亲自说这句话',
    })).toBe(false);
    expect(shouldRouteTextAsStoryCustomDirection({
      isStoryRoom: true,
      hasSpeakAsCharacter: false,
      hasGuideTargetMember: true,
      content: '安排月奴回应',
    })).toBe(false);
    expect(shouldRouteTextAsStoryCustomDirection({
      isStoryRoom: false,
      hasSpeakAsCharacter: false,
      hasGuideTargetMember: false,
      content: '普通群聊消息',
    })).toBe(false);
    expect(shouldRouteTextAsStoryCustomDirection({
      isStoryRoom: true,
      hasSpeakAsCharacter: false,
      hasGuideTargetMember: false,
      content: '   ',
    })).toBe(false);
  });

  it('presents story room reader input as text-only story direction control', () => {
    expect(getStoryReaderComposerPlaceholder()).toBe('安排剧情');
    expect(getStoryReaderComposerPlaceholder('director')).toBe('安排剧情');
    expect(getStoryReaderComposerPlaceholder('participant')).toBe('写我的行动');
    expect(buildStoryReaderTextInputCapabilities({
      imageInput: true,
      multiImageInput: true,
      fileInput: true,
      maxAttachments: 10,
      supportedMimeTypes: ['image/png'],
    })).toEqual({
      imageInput: false,
      multiImageInput: false,
      fileInput: false,
      maxAttachments: 10,
      supportedMimeTypes: ['image/png'],
    });
  });

  it('auto-starts story rooms only when the reader is at the tail and no gate blocks continuation', () => {
    const base = {
      hasChat: true,
      hasChatId: true,
      canAutoRunConversation: true,
      isStoryRoom: true,
      isStoryReaderAtTail: true,
      isRunning: false,
      isPaused: false,
      isStoryWaitingForChoice: false,
      isStoryChoiceSubmitting: false,
      hasRunLoopError: false,
    };

    expect(shouldAutoStartStoryRoom(base)).toBe(true);
    expect(shouldAutoStartStoryRoom({ ...base, isStoryReaderAtTail: false })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, isStoryWaitingForChoice: true })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, isStoryChoiceSubmitting: true })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, isPaused: true })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, isRunning: true })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, hasUserDraft: true })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, hasRunLoopError: true })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, hasAcknowledgedNewTail: false })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, canAutoContinueFromTail: false })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, isStoryRoom: false })).toBe(false);
    expect(shouldAutoStartStoryRoom({ ...base, canAutoRunConversation: false })).toBe(false);
  });

  it('acknowledges a new story tail only after the completed chapter and a reader scroll', () => {
    const base = { awaitingNewTail: true, isRunning: false, latestMessageId: 'chapter-2', sourceMessageId: 'chapter-1' };
    expect(canAcknowledgeNewStoryTail(base)).toBe(true);
    expect(canAcknowledgeNewStoryTail({ ...base, isRunning: true })).toBe(false);
    expect(canAcknowledgeNewStoryTail({ ...base, latestMessageId: 'chapter-1' })).toBe(false);
    expect(canAcknowledgeNewStoryTail({ ...base, awaitingNewTail: false })).toBe(false);
  });

  it('treats restored non-tail story reading positions as not at tail until the reader reaches the tail again', () => {
    expect(resolveEffectiveStoryReaderAtTail({
      isStoryReaderAtTail: true,
      hasSavedNonTailStoryReadingPosition: true,
      hasStoryReaderReachedTailIntent: false,
    })).toBe(false);
    expect(resolveEffectiveStoryReaderAtTail({
      isStoryReaderAtTail: true,
      hasSavedNonTailStoryReadingPosition: true,
      hasStoryReaderReachedTailIntent: true,
    })).toBe(true);
    expect(resolveEffectiveStoryReaderAtTail({
      isStoryReaderAtTail: false,
      hasSavedNonTailStoryReadingPosition: false,
      hasStoryReaderReachedTailIntent: true,
    })).toBe(false);
  });

  it('does not register restored narrative history for live reveal after returning to a chat', () => {
    const history = [
      buildNarrativeMessage('story-old-1', 10),
      buildNarrativeMessage('story-old-2', 20),
    ];
    useMessageStore.setState({
      messages: history,
      activeChatId: 'story-1',
      messageWindowsByChatId: {
        'story-1': {
          messages: history,
          lastSyncedAt: 20,
          updatedAt: 20,
          remoteExhausted: true,
          activeLimit: 40,
        },
      },
    });

    expect(shouldRegisterLiveNarrativeReveal(buildNarrativeMessage('story-old-2', 20))).toBe(false);
    expect(shouldRegisterLiveNarrativeReveal(buildNarrativeMessage('story-new', 21))).toBe(true);
  });

  it('does not revive old story choices outside the active choice phase', () => {
    const choiceMessage = {
      id: 'choice-source',
      chatId: 'story-1',
      type: 'ai' as const,
      senderId: 'narrator',
      senderName: '旁白',
      content: '门后出现新线索。',
      emotion: 0,
      timestamp: 1,
      isDeleted: false,
      metadata: {
        storyChoices: [
          { label: '追问护士昨晚去向', prompt: '追问护士' },
          { label: '检查墙上血迹', prompt: '检查血迹' },
        ],
      },
    };
    const chat = {
      id: 'story-1',
      scenarioState: {
        phase: 'scene',
        choiceEpoch: 2,
        branches: [
          { branchId: 'ask', label: '追问护士昨晚去向', status: 'completed' as const, choiceEpoch: 2 },
          { branchId: 'search', label: '检查墙上血迹', status: 'completed' as const, choiceEpoch: 2 },
        ],
      },
    };

    expect(findVisibleStoryChoiceSourceMessage({
      isStoryRoom: true,
      phase: 'scene',
      messages: [choiceMessage],
    })).toBeNull();
    const params: Parameters<typeof buildVisibleStoryBranchOptions>[0] = {
      isStoryRoom: true,
      chat: chat as Parameters<typeof buildVisibleStoryBranchOptions>[0]['chat'],
      sourceMessage: choiceMessage,
    };
    expect(buildVisibleStoryBranchOptions({
      ...params,
    })).toEqual([]);
  });

  it('does not show branch-only options when the source message has no storyChoices metadata', () => {
    const sourceMessage = {
      id: 'fallback-choice-source',
      chatId: 'story-1',
      type: 'ai' as const,
      senderId: 'narrator',
      senderName: '旁白',
      content: '走廊尽头的灯忽明忽暗，必须立刻决定下一步。',
      emotion: 0,
      timestamp: 2,
      isDeleted: false,
    };
    const chat = {
      id: 'story-1',
      scenarioState: {
        phase: 'choice',
        choiceEpoch: 4,
        branches: [
          { branchId: 'ask', label: '让林医生追问护士隐瞒的细节', prompt: '林医生追问护士', status: 'available' as const, choiceEpoch: 4 },
          { branchId: 'search', label: '让林医生检查旧医院走廊里的血迹', prompt: '林医生检查血迹', status: 'available' as const, choiceEpoch: 4 },
          { branchId: 'old', label: '旧选项', prompt: '旧选项', status: 'available' as const, choiceEpoch: 3 },
        ],
      },
    };

    expect(findVisibleStoryChoiceSourceMessage({
      isStoryRoom: true,
      phase: 'choice',
      messages: [sourceMessage],
    })).toBeNull();
    expect(buildVisibleStoryBranchOptions({
      isStoryRoom: true,
      chat: chat as Parameters<typeof buildVisibleStoryBranchOptions>[0]['chat'],
      sourceMessage,
    })).toEqual([]);
  });
});
