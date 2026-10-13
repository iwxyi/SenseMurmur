import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../types/chat';
import { buildMemoryCandidates } from './layeredMemoryEngine';

function buildChat() {
  return normalizeConversation({
    id: 'chat-1',
    type: 'group',
    mode: 'open_chat',
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: true, allowDirectorInterventions: true, showRoleActions: true },
    modeState: { phase: 'free' },
    name: '群聊',
    topic: '',
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    memberIds: ['char-a', 'char-b', 'user'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: true },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    worldState: { phase: 'idle', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    runtimeEventsV2: [{
      id: 'evt-1',
      conversationId: 'chat-1',
      kind: 'interaction',
      createdAt: 1,
      actorIds: ['char-a'],
      targetIds: ['char-b'],
      summary: 'char-a 对 char-b 说：3c78729f-e52d-4dde-b27f-01a949960bb8 你别装了',
      payload: { kind: 'challenge', actorId: 'char-a', targetId: 'char-b' },
    }],
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  });
}

describe('layeredMemoryEngine', () => {
  it('does not turn axis configuration and its shift event into conflict memories', () => {
    const chat = buildChat();
    chat.runtimeEventsV2 = [];
    chat.worldState.conflictAxes = [{ title: '群体关系', poles: ['结盟', '拆台'], currentTilt: 40 }];
    const message = { type: 'ai' as const, senderId: 'char-a', content: '继续。' };
    expect(buildMemoryCandidates(chat, message)).toEqual([]);
    expect(buildMemoryCandidates(chat, message, [{
      eventType: 'conflict_axis_shift', title: '会话冲突轴发生偏移', summary: '群体关系 结盟', createdAt: 123,
    }])).toEqual([]);
  });

  it('sanitizes memory candidate text before writing layered memories', () => {
    const chat = buildChat();
    const candidates = buildMemoryCandidates(chat, {
      type: 'ai',
      senderId: 'char-a',
      content: '继续推进',
    });
    expect(candidates.length).toBeGreaterThan(0);
    const text = candidates[0]?.text || '';
    expect(text).toContain('挑战');
    expect(text).not.toContain('char-a');
    expect(text).not.toContain('char-b');
    expect(text).not.toContain('3c78729f');
  });
});

