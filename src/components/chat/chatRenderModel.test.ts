import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/message';
import { buildChatRenderItems } from './chatRenderModel';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'message-1',
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'character-1',
    senderName: 'Character',
    content: 'hello',
    emotion: 0,
    timestamp: 1,
    isDeleted: false,
    ...overrides,
  };
}

describe('buildChatRenderItems', () => {
  it('keeps a single in-list streaming message pending', () => {
    const items = buildChatRenderItems([
      message({ id: 'stream-1', content: '正在说', isStreaming: true }),
      message({ id: 'event-1', type: 'event', senderId: 'system', senderName: 'System', content: '{"eventType":"relationship_shift","summary":"关系变化"}', timestamp: 2 }),
    ]);

    expect(items.map((item) => item.key)).toEqual(['chat-1:stream-1', 'chat-1:event-1']);
    expect(items.map((item) => item.pending)).toEqual([true, false]);
  });

  it('classifies notices, system messages, events, narrative and both bubble sides', () => {
    const items = buildChatRenderItems([
      message({ id: 'notice-1', type: 'system', senderId: 'system', senderName: '提示', content: '正在执行',
        metadata: { chatNotice: { tone: 'working', details: ['步骤一'] } } }),
      message({ id: 'system-1', type: 'system', senderId: 'system', senderName: 'System', content: '系统提示' }),
      message({ id: 'event-1', type: 'event', senderId: 'system', senderName: 'System', content: '{"eventType":"relationship_shift","summary":"关系变化"}', timestamp: 2 }),
      message({ id: 'narrator-1', senderId: 'narrator', senderName: '旁白', content: '雨声落下。', timestamp: 3 }),
      message({ id: 'ai-1', senderId: 'character-1', senderName: 'Character', content: '你好', timestamp: 4 }),
      message({ id: 'user-1', type: 'user', senderId: 'user', senderName: 'User', content: '你好', timestamp: 5 }),
    ]);

    expect(items.map((item) => item.renderKind)).toEqual(['notice', 'system', 'event', 'narrative', 'bubble', 'bubble']);
    expect(items.map((item) => item.presentation.placement)).toEqual(['center', 'center', 'center', 'center', 'left', 'right']);
  });

  it('renders narrative turn paragraph messages as narrative items', () => {
    const items = buildChatRenderItems([
      message({
        id: 'character-action-1',
        senderId: 'char-1',
        senderName: '角色',
        content: '角色推开门。',
        metadata: {
          narrativeTurn: {
            turnId: 'turn-1',
            turnKind: 'character_reaction',
            povActorId: 'char-1',
            blocks: [{ id: 'b1', actorId: 'char-1', actorKind: 'character', kind: 'action', displayMode: 'paragraph', text: '角色推开门。' }],
          },
        },
      }),
    ]);

    expect(items[0]?.renderKind).toBe('narrative');
  });

  it('renders story choice selection messages as narrative items', () => {
    const items = buildChatRenderItems([
      message({
        id: 'story-choice-1',
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '我选择：进入旧楼',
        metadata: {
          storyChoiceSelection: {
            branchId: 'branch-1',
            label: '进入旧楼',
            prompt: '进入旧楼',
          },
        },
      }),
    ]);

    expect(items[0]?.renderKind).toBe('narrative');
  });

  it('keeps a story choice selection anchored before the generated consequence', () => {
    const items = buildChatRenderItems([
      message({
        id: 'choice-source',
        senderId: 'narrator',
        senderName: '旁白',
        content: '门后传来脚步声。',
        timestamp: 10,
        metadata: {
          storyChoices: [{ label: '推门进去', prompt: '推门进去' }, { label: '退到楼梯间', prompt: '退到楼梯间' }],
        },
      }),
      message({
        id: 'consequence-1',
        senderId: 'narrator',
        senderName: '旁白',
        content: '门轴发出尖响。',
        timestamp: 20,
      }),
      message({
        id: 'choice-selection',
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '我选择：推门进去',
        timestamp: 30,
        metadata: {
          storyChoiceSelection: {
            branchId: 'enter',
            sourceMessageId: 'choice-source',
            label: '推门进去',
            prompt: '推门进去',
          },
        },
      }),
    ]);

    expect(items.map((item) => item.message.id)).toEqual(['choice-source', 'choice-selection', 'consequence-1']);
  });

  it('keeps the full story choice reading order stable after selection, events, and follow-up beats', () => {
    const items = buildChatRenderItems([
      message({
        id: 'intro',
        senderId: 'narrator',
        senderName: '旁白',
        content: '喜帐垂在床沿，烛泪堆在铜台上。',
        timestamp: 10,
      }),
      message({
        id: 'choice-source',
        senderId: 'narrator',
        senderName: '旁白',
        content: '月奴转身要走，沈清婉看见她袖口一紧。',
        timestamp: 20,
        metadata: {
          storyChoices: [
            { label: '叫住月奴，问她昨晚铺床时有没有发现枕下异物', prompt: '沈清婉旁敲侧击试探月奴' },
            { label: '暂时放月奴离开，自己检查枕下长剑的来历', prompt: '沈清婉独自检查长剑' },
          ],
        },
      }),
      message({
        id: 'branch-event',
        type: 'event',
        senderId: 'system',
        senderName: 'System',
        content: JSON.stringify({
          eventType: 'story_branch',
          summary: '剧情分支：沈清婉旁敲侧击试探月奴',
          sourceMessageId: 'choice-selection',
          visibilityScope: 'public',
        }),
        timestamp: 21,
      }),
      message({
        id: 'choice-selection',
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '我选择：叫住月奴，问她昨晚铺床时有没有发现枕下异物',
        timestamp: 30,
        metadata: {
          storyChoiceSelection: {
            branchId: 'ask-yuenu',
            sourceMessageId: 'choice-source',
            label: '叫住月奴，问她昨晚铺床时有没有发现枕下异物',
            prompt: '沈清婉旁敲侧击试探月奴',
            choiceEpoch: 2,
          },
        },
      }),
      message({
        id: 'duplicate-selection',
        type: 'user',
        senderId: 'user',
        senderName: '我',
        content: '我选择：叫住月奴，问她昨晚铺床时有没有发现枕下异物',
        timestamp: 31,
        metadata: {
          storyChoiceSelection: {
            branchId: 'ask-yuenu',
            sourceMessageId: 'choice-source',
            label: '叫住月奴，问她昨晚铺床时有没有发现枕下异物',
            prompt: '沈清婉旁敲侧击试探月奴',
            choiceEpoch: 2,
          },
        },
      }),
      message({
        id: 'consequence',
        senderId: 'narrator',
        senderName: '旁白',
        content: '月奴的脊背僵了一瞬，回答得太稳，反而露出了破绽。',
        timestamp: 40,
      }),
      message({
        id: 'follow-up',
        senderId: 'narrator',
        senderName: '旁白',
        content: '门外扫院子的声音一下一下，把这场试探拖得更长。',
        timestamp: 50,
      }),
    ]);

    expect(items.map((item) => item.message.id)).toEqual([
      'intro',
      'choice-source',
      'choice-selection',
      'branch-event',
      'consequence',
      'follow-up',
    ]);
  });

  it('renders public story events as narrative items', () => {
    for (const visibilityScope of ['public', 'derived_public']) {
      const items = buildChatRenderItems([
        message({
          id: `story-event-${visibilityScope}`,
          type: 'event',
          senderId: 'system',
          senderName: 'System',
          content: JSON.stringify({
            eventType: 'story_action',
            title: '动作',
            summary: '门外传来急促脚步声。',
            channelId: 'story:scene',
            visibilityScope,
          }),
        }),
      ]);

      expect(items[0]?.renderKind).toBe('narrative');
    }
  });

  it('does not render a committed streamed message twice after server confirmation', () => {
    const items = buildChatRenderItems([
      message({
        id: 'local-stream-1',
        clientKey: 'local-stream-1',
        serverId: 'server-message-1',
        content: '完整内容',
        isStreaming: false,
      }),
      message({
        id: 'server-message-1',
        serverId: 'server-message-1',
        content: '完整内容',
        isStreaming: false,
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.message.id).toBe('local-stream-1');
  });

  it('does not let a stale streaming draft replace the committed bubble', () => {
    const items = buildChatRenderItems([
      message({
        id: 'local-stream-1',
        clientKey: 'local-stream-1',
        serverId: 'server-message-1',
        content: '完整内容，已经提交。',
        isStreaming: false,
      }),
      message({
        id: 'local-stream-1',
        clientKey: 'local-stream-1',
        content: '完整',
        isStreaming: true,
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.message.content).toBe('完整内容，已经提交。');
    expect(items[0]?.pending).toBe(false);
  });

  it('keeps event messages after normal messages when timestamps tie', () => {
    const items = buildChatRenderItems([
      message({ id: 'ai-1', timestamp: 10 }),
      message({ id: 'event-1', type: 'event', senderId: 'system', senderName: 'System', content: '{"eventType":"relationship_shift","summary":"关系变化"}', timestamp: 10 }),
    ]);

    expect(items.map((item) => item.message.type)).toEqual(['ai', 'event']);
  });

  it('preserves incoming order for multiple event messages with the same timestamp', () => {
    const items = buildChatRenderItems([
      message({ id: 'event-2', clientKey: 'event-2', type: 'event', senderId: 'system', senderName: 'System', content: '{"eventType":"conflict_focus_shift","summary":"矛盾"}', timestamp: 10 }),
      message({ id: 'event-1', clientKey: 'event-1', type: 'event', senderId: 'system', senderName: 'System', content: '{"eventType":"relationship_shift","summary":"关系"}', timestamp: 10 }),
    ]);

    expect(items.map((item) => item.message.id)).toEqual(['event-2', 'event-1']);
  });

  it('preserves incoming order for normal messages with the same timestamp', () => {
    const items = buildChatRenderItems([
      message({ id: 'user-1', type: 'user', senderId: 'user', senderName: 'User', timestamp: 10 }),
      message({ id: 'ai-1', type: 'ai', senderId: 'character-1', senderName: 'Character', timestamp: 10 }),
    ]);

    expect(items.map((item) => item.message.id)).toEqual(['user-1', 'ai-1']);
  });

  it('keeps repeated developer event hints visible when they are anchored to their source message', () => {
    const repeatedEvent = (sourceMessageId: string) => JSON.stringify({
      eventType: 'speaker_drift_shift',
      title: 'Linux之父Linus 出现人格偏移',
      summary: 'Linux之父Linus：敏感度+6，外向性-3',
      sourceMessageId,
    });
    const items = buildChatRenderItems([
      message({ id: 'ai-1', timestamp: 10, content: '不客气，去写代码吧。' }),
      message({ id: 'event-1', type: 'event', senderId: 'system', senderName: 'System', timestamp: 11, content: repeatedEvent('ai-1') }),
      message({ id: 'ai-2', timestamp: 12, content: '继续说。' }),
      message({ id: 'event-2', type: 'event', senderId: 'system', senderName: 'System', timestamp: 13, content: repeatedEvent('ai-2') }),
    ]);

    expect(items.map((item) => item.message.id)).toEqual(['ai-1', 'event-1', 'ai-2', 'event-2']);
  });

  it('places delayed developer event hints after the message that caused them', () => {
    const anchoredEvent = JSON.stringify({
      eventType: 'speaker_drift_shift',
      title: 'Linux之父Linus 出现人格偏移',
      summary: 'Linux之父Linus：敏感度+6，外向性-3',
      sourceMessageId: 'ai-1',
    });
    const items = buildChatRenderItems([
      message({ id: 'ai-1', timestamp: 10 }),
      message({ id: 'user-1', type: 'user', senderId: 'user', senderName: 'User', timestamp: 20 }),
      message({ id: 'event-1', type: 'event', senderId: 'system', senderName: 'System', timestamp: 30, content: anchoredEvent }),
    ]);

    expect(items.map((item) => item.message.id)).toEqual(['ai-1', 'event-1', 'user-1']);
  });
});
