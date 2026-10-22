import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/message';
import { buildChatRenderItems } from './chatRenderModel';
import { buildMessageListRenderItems } from './messageListRenderItems';
import { getContinuousAiMessageKeys } from './messageListPresentation';
import { shouldMaintainTailAfterMutation } from './messageListTailOwnership';
import { getVisibleNarrativeDisplayBlocks, isNarrativeRevealAllowed } from './messageListPresentation';

function buildMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'narrator',
    senderName: '旁白',
    content: '',
    emotion: 0,
    timestamp: 1,
    isDeleted: false,
    ...overrides,
  };
}

function buildNarrativeMessage(id: string, overrides: Partial<Message> = {}): Message {
  return buildMessage(id, {
    metadata: {
      narrativeTurn: {
        turnId: id,
        turnKind: 'narrative_beat',
        povActorId: 'narrator',
        blocks: [{
          id: `${id}-narration`,
          actorId: 'narrator',
          actorKind: 'narrator',
          kind: 'prose',
          displayMode: 'paragraph',
          text: '雨还在下，走廊尽头的灯忽明忽暗。',
        }],
      },
    },
    ...overrides,
  });
}

describe('MessageList narrative reveal eligibility', () => {
  it('groups adjacent AI bubbles from the same character, but not separated or stale messages', () => {
    const items = buildMessageListRenderItems({
      messages: [
        buildMessage('one', { senderId: 'char-1', timestamp: 1_000 }),
        buildMessage('two', { senderId: 'char-1', timestamp: 2_000 }),
        buildMessage('three', { senderId: 'char-2', timestamp: 3_000 }),
        buildMessage('four', { senderId: 'char-2', timestamp: 100_000 }),
      ],
      eventRenderFlags: { developerMode: false, showStateEvents: false, showRelationshipEvents: false, showAffectEvents: false, showMemoryDebug: false, showMemoryDistillationEvents: false, showDetailedFactHints: false, showCalendarEvents: false, showLocalInterceptionHints: false, showConflictEvents: false },
      showDeveloperDetails: false,
    });

    expect(getContinuousAiMessageKeys(items)).toEqual(new Set([items[1].key]));
  });

  it('requires an explicit live story node key for node animation', () => {
    const [item] = buildChatRenderItems([
      buildNarrativeMessage('story-live', { clientKey: 'client-story-live', serverId: 'server-story-live', timestamp: 2 }),
    ]);

    expect(item).toBeTruthy();
    expect(isNarrativeRevealAllowed({ item, revealMessageKeys: new Set() })).toBe(false);
    expect(isNarrativeRevealAllowed({ item, revealMessageKeys: new Set(['other-message']) })).toBe(false);
    expect(isNarrativeRevealAllowed({ item, revealMessageKeys: new Set(['client-story-live']) })).toBe(true);
    expect(isNarrativeRevealAllowed({ item, revealMessageKeys: new Set(['server-story-live']) })).toBe(true);
  });

  it('flattens story narrative blocks into separate virtual rows', () => {
    const items = buildMessageListRenderItems({
      messages: [
        buildNarrativeMessage('story-node', {
          metadata: {
            narrativeTurn: {
              turnId: 'story-node',
              turnKind: 'narrative_beat',
              povActorId: 'narrator',
              blocks: [
                {
                  id: 'story-node-prose',
                  actorId: 'narrator',
                  actorKind: 'narrator',
                  kind: 'prose',
                  displayMode: 'paragraph',
                  text: '雨还在下。',
                },
                {
                  id: 'story-node-line',
                  actorId: 'char-1',
                  actorKind: 'character',
                  kind: 'dialogue',
                  displayMode: 'bubble',
                  text: '别回头。',
                },
              ],
            },
          },
        }),
      ],
      eventRenderFlags: {
        developerMode: false,
        showStateEvents: false,
        showRelationshipEvents: false,
        showAffectEvents: false,
        showMemoryDebug: false,
        showMemoryDistillationEvents: false,
        showDetailedFactHints: false,
        showCalendarEvents: false,
        showLocalInterceptionHints: false,
        showConflictEvents: false,
      },
      showDeveloperDetails: false,
    });

    expect(items.map((item) => item.renderKind)).toEqual([
      'narrative-block',
      'narrative-block',
    ]);
    expect(items[0]).toMatchObject({ key: expect.stringContaining(':block:story-node-prose') });
    expect(items[1]).toMatchObject({ key: expect.stringContaining(':block:story-node-line') });
  });

  it('hides developer-only story panels from the normal narrative stream', () => {
    const systemPanelOnly = buildMessage('choice-diagnostic', {
      metadata: {
        narrativeTurn: {
          turnId: 'choice-diagnostic',
          turnKind: 'choice_prompt',
          povActorId: 'narrator',
          blocks: [{
            id: 'choice-diagnostic-panel',
            actorId: 'narrator',
            actorKind: 'system',
            kind: 'system_note',
            displayMode: 'system_panel',
            text: '新的抉择点\n前情：走廊尽头还有脚步声。',
          }],
        },
        storyChoices: [
          { label: '让林医生推门查看脚步声来源', prompt: '林医生推门查看脚步声来源' },
          { label: '让护士守在楼梯口观察退路', prompt: '护士守住楼梯口' },
        ],
      },
    });

    expect(getVisibleNarrativeDisplayBlocks(systemPanelOnly, false)).toEqual([]);
    expect(getVisibleNarrativeDisplayBlocks(systemPanelOnly, true)).toEqual([
      expect.objectContaining({ displayMode: 'system_panel', text: expect.stringContaining('新的抉择点') }),
    ]);
  });
});

describe('MessageList tail ownership', () => {
  it('keeps a viewport at the tail across streaming growth', () => {
    expect(shouldMaintainTailAfterMutation({
      autoStickToBottom: true,
      wasPinnedBeforeMutation: true,
      isUserPointerHeld: false,
    })).toBe(true);
  });

  it('does not move a reader who is above the tail, even without a new input event', () => {
    expect(shouldMaintainTailAfterMutation({
      autoStickToBottom: true,
      wasPinnedBeforeMutation: false,
      isUserPointerHeld: false,
    })).toBe(false);
  });

  it('does not follow tail changes when automatic tail following is disabled', () => {
    expect(shouldMaintainTailAfterMutation({
      autoStickToBottom: false,
      wasPinnedBeforeMutation: true,
      isUserPointerHeld: false,
    })).toBe(false);
  });

  it('does not move the viewport while a user is holding the chat surface', () => {
    expect(shouldMaintainTailAfterMutation({
      autoStickToBottom: true,
      wasPinnedBeforeMutation: true,
      isUserPointerHeld: true,
    })).toBe(false);
  });
});
