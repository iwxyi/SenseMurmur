import { describe, expect, it } from 'vitest';
import { getConversationLoopStartBlockReason, resolveConversationLoopStartDelayMs, shouldCreateSpeakerStreamingPlaceholder, shouldSkipConversationLoopStart, shouldStartConversationLoop, shouldTreatActiveLoopAsSuccessfulStart, usesBackgroundGroupExecution } from './useChatRunLoop';

describe('useChatRunLoop start guard', () => {
  it('reports the root reason that blocks loop start', () => {
    expect(getConversationLoopStartBlockReason({
      conversationType: 'direct',
      isRunning: false,
      isPaused: false,
      isStoryChoiceBlocked: false,
      hasActiveLoop: false,
    })).toBe('direct_chat');

    expect(getConversationLoopStartBlockReason({
      conversationType: 'group',
      isRunning: false,
      isPaused: false,
      isStoryChoiceBlocked: true,
      hasActiveLoop: false,
    })).toBe('waiting_story_choice');

    expect(getConversationLoopStartBlockReason({
      conversationType: 'group',
      isRunning: true,
      isPaused: false,
      isStoryChoiceBlocked: false,
      hasActiveLoop: true,
    })).toBe('already_active');

    expect(getConversationLoopStartBlockReason({
      conversationType: 'group',
      isRunning: true,
      isPaused: false,
      isStoryChoiceBlocked: false,
      hasActiveLoop: false,
    })).toBeNull();
  });

  it('only skips starting when a real active loop is already running', () => {
    expect(shouldSkipConversationLoopStart({
      isRunning: true,
      isPaused: false,
      isStoryChoiceBlocked: false,
      hasActiveLoop: true,
    })).toBe(true);

    expect(shouldSkipConversationLoopStart({
      isRunning: true,
      isPaused: false,
      isStoryChoiceBlocked: false,
      hasActiveLoop: false,
    })).toBe(false);

    expect(shouldSkipConversationLoopStart({
      isRunning: true,
      isPaused: true,
      isStoryChoiceBlocked: false,
      hasActiveLoop: true,
    })).toBe(false);

    expect(shouldSkipConversationLoopStart({
      isRunning: true,
      isPaused: false,
      isStoryChoiceBlocked: true,
      hasActiveLoop: true,
    })).toBe(false);
  });

  it('does not start while a story choice is waiting, but recovers false running state without an active loop', () => {
    expect(shouldStartConversationLoop({
      conversationType: 'group',
      isRunning: false,
      isPaused: false,
      isStoryChoiceBlocked: true,
      hasActiveLoop: false,
    })).toBe(false);

    expect(shouldStartConversationLoop({
      conversationType: 'group',
      isRunning: true,
      isPaused: false,
      isStoryChoiceBlocked: true,
      hasActiveLoop: false,
    })).toBe(false);

    expect(shouldStartConversationLoop({
      conversationType: 'group',
      isRunning: true,
      isPaused: false,
      isStoryChoiceBlocked: false,
      hasActiveLoop: false,
    })).toBe(true);
  });

  it('does not use ordinary speaker typing placeholders for story-reader generation', () => {
    expect(shouldCreateSpeakerStreamingPlaceholder({
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' },
    })).toBe(false);

    expect(shouldCreateSpeakerStreamingPlaceholder({
      sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' },
    })).toBe(true);

    expect(shouldCreateSpeakerStreamingPlaceholder(null)).toBe(true);
  });

  it('routes conversation story rooms through the persistent group runner', () => {
    expect(usesBackgroundGroupExecution({ type: 'group', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' } } as never)).toBe(true);
    expect(usesBackgroundGroupExecution({ type: 'group', sessionKind: { topology: 'group', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' } } as never)).toBe(true);
    expect(usesBackgroundGroupExecution({ type: 'group', sessionKind: { topology: 'group', family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text' } } as never)).toBe(true);
    expect(usesBackgroundGroupExecution({ type: 'direct', sessionKind: { topology: 'direct', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } } as never)).toBe(false);
  });

  it('can bypass the loop start timer for explicit user-triggered generation', () => {
    expect(resolveConversationLoopStartDelayMs()).toBe(100);
    expect(resolveConversationLoopStartDelayMs({ immediate: false })).toBe(100);
    expect(resolveConversationLoopStartDelayMs({ immediate: true })).toBe(0);
    expect(resolveConversationLoopStartDelayMs({ immediate: true, ignoreReaderPositionOnce: true })).toBe(0);
  });

  it('treats an existing active loop as a successful explicit start', () => {
    expect(shouldTreatActiveLoopAsSuccessfulStart({
      blockReason: 'already_active',
      hasActiveLoop: true,
    })).toBe(true);

    expect(shouldTreatActiveLoopAsSuccessfulStart({
      blockReason: 'already_active',
      hasActiveLoop: false,
    })).toBe(false);

    expect(shouldTreatActiveLoopAsSuccessfulStart({
      blockReason: 'waiting_story_choice',
      hasActiveLoop: true,
    })).toBe(false);
  });
});
