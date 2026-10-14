import { describe, expect, it } from 'vitest';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import {
  buildBranchStateWithHead,
  buildMessageBranchVersionInfoByMessageId,
  createMessageRevisionDraft,
  attachMessageToActiveBranch,
  forkBranchState,
  getRevisionSiblingIndex,
  isMessageBranchingEnabled,
  projectActiveBranchMessages,
  resolveMessageBranchNodes,
} from './messageBranching';

function chat(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'chat-1', type: 'group', mode: 'open_chat',
    sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' },
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free' }, name: 'test', topic: 'test', style: 'free', runtimeEvolutionIntensity: 'balanced',
    memberIds: ['user'], speed: 1, isActive: true, allowIntervention: true, showRoleActions: true, topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: 1, updatedAt: 1, lastMessageAt: 1, ...overrides,
  };
}

function message(id: string, type: Message['type'], parentNodeId: string | null, sequence: number, content = id, revisionOfNodeId?: string): Message {
  return {
    id, clientKey: id, chatId: 'chat-1', type, senderId: type === 'user' ? 'user' : 'char', senderName: type === 'user' ? '我' : '角色', content, emotion: 0, timestamp: sequence,
    isDeleted: false,
    metadata: { branching: { nodeId: id, parentNodeId, rootNodeId: parentNodeId ? 'root' : id, sequence, ...(revisionOfNodeId ? { revisionOfNodeId } : {}) } },
  };
}

describe('messageBranching v2', () => {
  it('projects only the active ref ancestor path', () => {
    const messages = [message('u1', 'user', null, 1), message('a1', 'ai', 'u1', 2), message('u2', 'user', 'a1', 3), message('a2', 'ai', 'u2', 4)];
    const state = buildBranchStateWithHead({ enabled: true }, 'a2');
    expect(projectActiveBranchMessages(chat({ messageBranchState: state }), messages).map((item) => item.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('switches refs without changing the node graph', () => {
    const messages = [message('u1', 'user', null, 1), message('a1', 'ai', 'u1', 2), message('a2', 'ai', 'u1', 3, '另一种回答', 'a1')];
    let state = buildBranchStateWithHead({ enabled: true }, 'a1');
    state = forkBranchState(state, 'a1', 'original');
    state = buildBranchStateWithHead(state, 'a2', 'main');
    expect(projectActiveBranchMessages(chat({ messageBranchState: state }), messages).map((item) => item.id)).toEqual(['u1', 'a2']);
    expect(projectActiveBranchMessages(chat({ messageBranchState: { ...state, activeBranchName: 'original' } }), messages).map((item) => item.id)).toEqual(['u1', 'a1']);
    expect(resolveMessageBranchNodes(messages)).toHaveLength(3);
  });

  it('treats siblings under one parent as revisions', () => {
    const messages = [message('u1', 'user', null, 1), message('a1', 'ai', 'u1', 2), message('a2', 'ai', 'u1', 3, '新回答', 'a1')];
    const state = buildBranchStateWithHead({ enabled: true }, 'a2');
    const info = buildMessageBranchVersionInfoByMessageId(chat({ messageBranchState: state }), messages, ['a1', 'a2']);
    expect(info.a1).toMatchObject({ index: 1, total: 2, isActive: false });
    expect(info.a2).toMatchObject({ index: 2, total: 2, isActive: true });
    expect(getRevisionSiblingIndex(chat({ messageBranchState: state }), messages, 'a2')).toBe('2/2');
  });

  it('creates a new immutable sibling revision draft', () => {
    const source = message('a1', 'ai', 'u1', 2, '旧回答');
    const draft = createMessageRevisionDraft({ sourceMessage: source, parentNodeId: 'u1', content: '新回答', nodeId: 'a2' });
    expect(draft.content).toBe('新回答');
    expect(draft.metadata?.branching).toMatchObject({ nodeId: 'a2', parentNodeId: 'u1', revisionOfNodeId: 'a1' });
    expect(source.content).toBe('旧回答');
  });

  it('does not infer parent links from array order', () => {
    const messages = [message('a2', 'ai', null, 2), message('a1', 'ai', null, 1)];
    expect(resolveMessageBranchNodes(messages).map((node) => node.parentNodeId)).toEqual([null, null]);
  });

  it('does not expose sibling timeline when an ancestor is outside the window', () => {
    const messages = [message('tail', 'ai', 'missing-parent', 3), message('other', 'user', null, 4)];
    const state = buildBranchStateWithHead({ enabled: true }, 'tail');
    expect(projectActiveBranchMessages(chat({ messageBranchState: state }), messages).map((item) => item.id)).toEqual(['tail', 'other']);
  });

  it('disables branching for explicit stateful scenarios', () => {
    expect(isMessageBranchingEnabled(chat())).toBe(true);
    expect(isMessageBranchingEnabled(chat({ messageBranchState: { enabled: false } }))).toBe(false);
    expect(isMessageBranchingEnabled(chat({ mode: 'scripted_play', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' } }))).toBe(false);
  });

  it('honors explicit v2 state for chats without a scenario id', () => {
    const plainChat = chat({
      // Simulate legacy persisted data written before scenarioId became required.
      sessionKind: { topology: 'group', family: 'conversation', surfaceProfile: 'text' } as GroupChat['sessionKind'],
      messageBranchState: { enabled: true },
    });
    const messages = [message('u1', 'user', null, 1), message('a1', 'ai', 'u1', 2), message('a2', 'ai', 'u1', 3)];
    const state = buildBranchStateWithHead(plainChat.messageBranchState, 'a2');
    expect(isMessageBranchingEnabled(plainChat)).toBe(true);
    expect(projectActiveBranchMessages({ ...plainChat, messageBranchState: state }, messages).map((item) => item.id)).toEqual(['u1', 'a2']);
  });

  it('keeps a legacy timeline when the branch flag has no message metadata', () => {
    const plainChat = chat({
      sessionKind: { topology: 'group', family: 'conversation', surfaceProfile: 'text' } as GroupChat['sessionKind'],
      messageBranchState: { enabled: true, activeLeafNodeId: 'latest' },
    });
    const messages = [
      { ...message('first', 'user', null, 1), metadata: undefined },
      { ...message('middle', 'ai', null, 2), metadata: undefined },
      { ...message('latest', 'ai', null, 3), metadata: undefined },
    ];
    expect(projectActiveBranchMessages(plainChat, messages).map((item) => item.id)).toEqual(['first', 'middle', 'latest']);
  });

  it('keeps the full timeline when only the latest message has branch metadata', () => {
    const plainChat = chat({ messageBranchState: { enabled: true, activeLeafNodeId: 'latest' } });
    const messages = [
      { ...message('first', 'user', null, 1), metadata: undefined },
      { ...message('middle', 'ai', null, 2), metadata: undefined },
      message('latest', 'ai', null, 3),
    ];
    expect(projectActiveBranchMessages(plainChat, messages).map((item) => item.id)).toEqual(['first', 'middle', 'latest']);
  });

  it('assigns a node id before persisting a new draft message', () => {
    const plainChat = chat({ messageBranchState: { enabled: true } });
    const draft = attachMessageToActiveBranch(plainChat, [], {
      chatId: plainChat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: 'hello',
      emotion: 0,
    });
    expect(draft.metadata?.branching?.nodeId).toEqual(expect.any(String));
  });

  it('repairs partially supplied branching metadata instead of returning it unchanged', () => {
    const plainChat = chat({ messageBranchState: { enabled: true } });
    const draft = attachMessageToActiveBranch(plainChat, [], {
      chatId: plainChat.id,
      type: 'user',
      senderId: 'user',
      senderName: '我',
      content: 'hello',
      emotion: 0,
      metadata: { branching: { parentNodeId: null } },
    });
    expect(draft.metadata?.branching?.nodeId).toEqual(expect.any(String));
  });

  it('keeps rich multi-part and media metadata isolated to the active revision', () => {
    const original = message('a1', 'ai', 'u1', 2, '原始回答');
    original.metadata = {
      branching: { nodeId: 'a1', parentNodeId: 'u1', rootNodeId: 'u1', sequence: 2 },
      narrativeTurn: { turnId: 'original', turnKind: 'character_reaction', blocks: [
        { id: 'original-1', actorId: 'ai', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', text: '原始回答' },
        { id: 'original-2', actorId: 'ai', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', text: '第二段' },
      ] },
      attachments: [{ id: 'original', kind: 'image', status: 'ready', altText: '原始图片', createdAt: 1, updatedAt: 1, assetId: 'asset-original', mimeType: 'image/png' }],
    };
    const revision = message('a2', 'ai', 'u1', 3, '替代回答', 'a1');
    revision.metadata = {
      branching: { nodeId: 'a2', parentNodeId: 'u1', rootNodeId: 'u1', sequence: 3, revisionOfNodeId: 'a1' },
      narrativeTurn: { turnId: 'revision', turnKind: 'character_reaction', blocks: [
        { id: 'revision-1', actorId: 'ai', actorKind: 'character', kind: 'dialogue', displayMode: 'bubble', text: '替代回答' },
        { id: 'revision-2', actorId: 'ai', actorKind: 'character', kind: 'prose', displayMode: 'paragraph', text: 'const ok = true;' },
      ] },
      attachments: [{ id: 'revision', kind: 'audio', status: 'ready', altText: '替代音频', createdAt: 1, updatedAt: 1, assetId: 'asset-revision', mimeType: 'audio/mpeg' }],
    };
    const state = buildBranchStateWithHead({ enabled: true }, 'a2');
    const projected = projectActiveBranchMessages(chat({ messageBranchState: state }), [
      message('u1', 'user', null, 1, '问题'), original, revision,
    ]);
    expect(projected.map((item) => item.id)).toEqual(['u1', 'a2']);
    expect(projected[1]?.metadata).toMatchObject({
      narrativeTurn: { turnId: 'revision', blocks: [{ text: '替代回答' }, { text: 'const ok = true;' }] },
      attachments: [{ assetId: 'asset-revision', mimeType: 'audio/mpeg' }],
    });
    expect(projected[1]?.metadata).not.toMatchObject({ attachments: [{ assetId: 'asset-original' }] });
  });

  it('keeps long branch paths deterministic when nodes arrive out of order', () => {
    const nodes = Array.from({ length: 80 }, (_, index) => message(
      `n-${index + 1}`,
      index % 2 ? 'ai' : 'user',
      index ? `n-${index}` : null,
      index + 1,
    ));
    const state = buildBranchStateWithHead({ enabled: true }, 'n-80');
    const shuffled = [...nodes].sort((left, right) => right.timestamp - left.timestamp);
    expect(projectActiveBranchMessages(chat({ messageBranchState: state }), shuffled).map((item) => item.id)).toEqual(nodes.map((item) => item.id));
  });
});
