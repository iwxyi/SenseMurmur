import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPEN_CHAT_MODE_CONFIG, DEFAULT_OPEN_CHAT_MODE_STATE, normalizeConversation, type GroupChat } from '../types/chat';
import { DEFAULT_PERSONALITY, normalizeCharacter } from '../types/character';
import { DEFAULT_API_CONFIG } from '../types/settings';
import type { Message } from '../types/message';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useMessageStore } from '../stores/useMessageStore';
import { generateAndCommitAiMessage } from './aiMessageOrchestrator';
import { commitGeneratedMessageTurn } from './generatedMessageTurnCommit';
import { projectActiveBranchMessages } from './messageBranching';
import type { GeneratedRoundMessage } from './chatEngine';

const generate = vi.hoisted(() => vi.fn());
vi.mock('./chatEngine', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chatEngine')>(),
  generateSpeakerMessage: generate,
}));

async function drain<T>(task: Promise<T>): Promise<T> {
  let settled = false;
  const outcome = task.then(
    (value) => { settled = true; return { ok: true as const, value }; },
    (error: unknown) => { settled = true; return { ok: false as const, error }; },
  );
  // Session engines are lazy imports: advance the display clock until the
  // whole task settles, not just until the currently scheduled timers drain.
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 10000, interval: 50 });
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

function fixture(type: GroupChat['type']) {
  let chat = normalizeConversation({
    id: 'bubble-lifecycle-test', type, mode: 'open_chat', name: '测试',
    memberIds: ['speaker'], style: 'free',
    modeConfig: DEFAULT_OPEN_CHAT_MODE_CONFIG, modeState: DEFAULT_OPEN_CHAT_MODE_STATE,
    topic: '', topicSeed: '', speed: 1, isActive: true, allowIntervention: true,
    createdAt: 1, updatedAt: 1, lastMessageAt: 1,
    messageBranchState: { enabled: true, activeLeafNodeId: null },
  });
  const speaker = normalizeCharacter({
    id: 'speaker', name: '测试角色', avatar: '', personality: DEFAULT_PERSONALITY,
    expertise: [], speakingStyle: '', background: '', isPreset: false, createdAt: 1, updatedAt: 1,
  });
  const writes: Message[] = [];
  const synced: Message[] = [];
  vi.spyOn(useMessageStore.getState(), 'queueMessageSync').mockImplementation((message) => { synced.push(message); });
  const params: Parameters<typeof generateAndCommitAiMessage>[0] = {
    api: DEFAULT_API_CONFIG, aiProfiles: [], chatId: chat.id, chat, speaker, characters: [speaker],
    currentMessages: [],
    upsertMessage: (message) => {
      writes.push(message);
      useMessageStore.getState().upsertMessage(message);
    },
    onCommit: async () => ({ chatPatch: {}, characterPatches: [], runtimeEvents: [] }),
    updateCharacter: async () => undefined,
    appendEventMessage: async () => undefined,
    updateChat: async (_id, patch) => { chat = { ...chat, ...patch }; },
    recordSpeak: vi.fn(), getCurrentChat: () => chat, getCurrentCharacters: () => [speaker],
  };
  const message: GeneratedRoundMessage = {
    chatId: chat.id, type: 'ai', senderId: speaker.id, senderName: speaker.name, emotion: 0,
    content: '先等等，我还没有说完。',
    messageParts: [
      { content: '先等等，我还没有说完。' },
      { content: '刚才那句话，其实让我有点难过。' },
      { content: '但是我还是想听你说。' },
    ],
  };
  return { params, message, writes, synced, getChat: () => chat };
}

beforeEach(() => {
  vi.useFakeTimers();
  generate.mockReset();
  useSettingsStore.setState({ enableStreamingDisplayAnimation: true });
  useMessageStore.setState({ activeChatId: 'bubble-lifecycle-test', messages: [], messageWindowsByChatId: {}, pendingOperations: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('shared generated bubble lifecycle', () => {
  it.each(['direct', 'ai_direct', 'group'] as const)('%s reveals and persists three bubbles on one visible branch', async (type) => {
    const context = fixture(type);
    generate.mockResolvedValue(context.message);
    const result = type === 'direct'
      ? generateAndCommitAiMessage(context.params)
      : commitGeneratedMessageTurn({ ...context.params, message: context.message });
    await drain(result);

    const persisted = useMessageStore.getState().messages.filter((message) => !message.isStreaming && !message.isDeleted);
    expect(persisted.map((message) => message.content)).toEqual(context.message.messageParts?.map((part) => part.content));
    expect(new Set(persisted.map((message) => message.id)).size).toBe(3);
    expect(projectActiveBranchMessages(context.getChat(), persisted).map((message) => message.id)).toEqual(persisted.map((message) => message.id));
    expect(context.synced.map((message) => message.id)).toEqual(persisted.map((message) => message.id));
    for (const message of persisted) {
      const previews = context.writes.filter((write) => write.id === message.id && write.isStreaming);
      expect(previews.length).toBeGreaterThan(2);
      expect(previews[0].content).toBe('');
      expect(previews.some((write) => write.content.length > 0 && write.content.length < message.content.length)).toBe(true);
    }
  });

  it('finishes the first streamed bubble from its current display without rewinding', async () => {
    const context = fixture('direct');
    generate.mockImplementation(async (args: { onChunk?: (content: string) => void }) => {
      args.onChunk?.(context.message.content);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return context.message;
    });
    const result = generateAndCommitAiMessage(context.params);
    await drain(result);
    const firstId = context.writes[0].id;
    const lengths = context.writes.filter((write) => write.id === firstId).map((write) => write.content.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(context.synced).toHaveLength(3);
  });

  it.each(['signal', 'branch'] as const)('cancels via %s during a follow-up without deleting an earlier committed bubble', async (reason) => {
    const context = fixture('direct');
    const controller = new AbortController();
    let current = true;
    generate.mockResolvedValue(context.message);
    const result = generateAndCommitAiMessage({
      ...context.params, signal: controller.signal, shouldContinue: () => current,
      upsertMessage: (message) => {
        context.params.upsertMessage(message);
        if (message.isStreaming && message.content && context.message.messageParts?.[1].content.startsWith(message.content)) {
          if (reason === 'signal') controller.abort();
          else current = false;
        }
      },
    });
    await expect(drain(result)).rejects.toThrow();
    expect(context.synced.map((message) => message.content)).toEqual([context.message.content]);
    const visible = useMessageStore.getState().messages.filter((message) => !message.isDeleted);
    expect(visible.map((message) => message.content)).toEqual([context.message.content]);
  });

  it('preserves separate bubbles with animation disabled', async () => {
    useSettingsStore.setState({ enableStreamingDisplayAnimation: false });
    const context = fixture('direct');
    generate.mockResolvedValue(context.message);
    await generateAndCommitAiMessage(context.params);
    expect(context.synced).toHaveLength(3);
    expect(context.writes.filter((message) => message.isStreaming && message.content)).toHaveLength(0);
  });

  it('does not commit an interaction whose evidence bubble is cancelled', async () => {
    const context = fixture('group');
    const controller = new AbortController();
    const interactionHint = { actorId: 'speaker', targetId: 'other', kind: 'support' as const,
      intensity: 2, confidence: 0.9, evidenceText: context.message.messageParts![1].content };
    const committed: string[] = [];
    const result = commitGeneratedMessageTurn({
      ...context.params,
      shouldContinue: () => !controller.signal.aborted,
      message: { ...context.message, interactionHint, interactionHints: [interactionHint] },
      onCommit: async (params) => {
        committed.push(params.message.content);
        return { chatPatch: {}, characterPatches: [], runtimeEvents: [] };
      },
      upsertMessage: (message) => {
        context.params.upsertMessage(message);
        if (message.isStreaming && message.content && interactionHint.evidenceText.startsWith(message.content)) {
          controller.abort();
        }
      },
    });
    await expect(drain(result)).rejects.toThrow();
    expect(committed).toHaveLength(1);
    expect(committed[0]).toBe(context.message.content);
    expect(context.synced[0].interactionHint).toBeNull();
    expect(context.synced[0].interactionHints).toBeNull();
    expect(context.synced.map((message) => message.content)).toEqual([context.message.content]);
  });

  it('keeps intentionally repeated sends independent using the existing message identity', async () => {
    useSettingsStore.setState({ enableStreamingDisplayAnimation: false });
    const context = fixture('direct');
    generate.mockResolvedValue({ ...context.message, content: '快回来', messageParts: [{ content: '快回来' }, { content: '快回来' }] });
    await generateAndCommitAiMessage(context.params);
    expect(context.synced.map((message) => message.content)).toEqual(['快回来', '快回来']);
    expect(context.synced[0].clientKey).not.toBe(context.synced[1].clientKey);
    expect(projectActiveBranchMessages(context.getChat(), useMessageStore.getState().messages)).toHaveLength(2);
  });
});
