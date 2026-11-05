import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSchedulerStore } from '../stores/useSchedulerStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { buildPrivateSessionEvent } from './directSessionHelpers';
import { buildRuntimeEventMessageContent, normalizeRuntimeEvent } from './runtimeEventFactory';
import { persistLocalFirstMessage, persistLocalFirstMessages } from './chatCommitMessage';
import { projectCurrentChatMessages, projectMergedChatMessages } from './currentChatMessages';
import { getWorkspaceSignal } from './workspaceLifecycle';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { createWorkflowRunRuntime, currentWorkflowScope, indexedDbWorkflowRepository, summarizeWorkflowRun, workflowRunLockName, WorkflowPreflightError, type WorkflowSnapshot, type WorkflowTask } from './workflowRunRuntime';

interface DirectReplyInput { chatId: string; userMessageId: string }

function isDirectReplyInput(value: unknown): value is DirectReplyInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<DirectReplyInput>;
  return typeof input.chatId === 'string' && typeof input.userMessageId === 'string';
}

function messagesForDirectChat(chatId: string) {
  const state = useMessageStore.getState();
  const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
  if (!chat) throw new WorkflowPreflightError('单聊会话不存在');
  return projectCurrentChatMessages({
    chatId, chat,
    activeMessages: state.messages.filter((message) => message.chatId === chatId),
    cachedWindow: state.messageWindowsByChatId[chatId],
  });
}

function committedReply(chatId: string, userMessageId: string) {
  const state = useMessageStore.getState();
  return projectMergedChatMessages({
    chatId,
    activeMessages: state.messages.filter((message) => message.chatId === chatId),
    cachedWindow: state.messageWindowsByChatId[chatId]
      ? { ...state.messageWindowsByChatId[chatId], preserveBranchContext: true }
      : undefined,
  }).find((item) => item.type === 'ai' && !item.isDeleted && !item.isStreaming
    && item.metadata?.directReplyToUserMessageId === userMessageId);
}

async function executeDirectReply(task: WorkflowTask, signal: AbortSignal) {
  if (task.kind !== 'direct_reply' || !isDirectReplyInput(task.input)) throw new WorkflowPreflightError('单聊任务输入无效');
  const { chatId, userMessageId } = task.input;
  if (!navigator.locks?.request) throw new WorkflowPreflightError('此设备不支持安全的会话串行执行');
  return navigator.locks.request(`pneumata-direct-chat-${currentWorkflowScope()}-${chatId}`, async () => {
    await Promise.all([
      useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
      useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
      useCharacterStore.persist.hasHydrated() ? Promise.resolve() : useCharacterStore.persist.rehydrate(),
      useSettingsStore.persist.hasHydrated() ? Promise.resolve() : useSettingsStore.persist.rehydrate(),
    ]);
    const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
    if (!chat || chat.type !== 'direct' || chat.deletedAt != null) throw new WorkflowPreflightError('单聊会话不可用');
    const characterId = chat.memberIds[0];
    if (!characterId) throw new WorkflowPreflightError('单聊角色已不存在');
    if (!useCharacterStore.getState().characters.some((item) => item.id === characterId)) {
      const loaded = await useCharacterStore.getState().loadCharacter(characterId);
      if (!loaded) throw new WorkflowPreflightError('单聊角色已不存在');
    }
    const userMessage = messagesForDirectChat(chatId).find((item) => item.id === userMessageId && item.type === 'user' && !item.isDeleted);
    if (!userMessage) throw new WorkflowPreflightError('原始用户消息已不存在');
    const alreadyCommitted = committedReply(chatId, userMessageId);
    if (alreadyCommitted) return { output: alreadyCommitted.id };
    const { runDirectUserReplyFlow } = await import('./directUserReplyFlow');
    const settings = useSettingsStore.getState();
    await runDirectUserReplyFlow({
      api: settings.api, aiProfiles: settings.aiProfiles, chatId, chat, userMessage,
      content: userMessage.content, characters: useCharacterStore.getState().characters,
      historyCutoffTimestamp: userMessage.timestamp,
      updateCharacter: (id, patch) => useCharacterStore.getState().updateCharacter(id, patch),
      updateCharacters: (patches) => useCharacterStore.getState().updateCharacters(patches),
      upsertMessage: (message) => useMessageStore.getState().upsertMessage(message),
      appendEventMessage: async (id, payload) => {
        const target = useChatStore.getState().chats.find((item) => item.id === id);
        const event = normalizeRuntimeEvent(target ? buildPrivateSessionEvent(target, payload) : payload);
        await persistLocalFirstMessage({
          message: { chatId: id, type: 'event', senderId: 'system', senderName: 'System', content: buildRuntimeEventMessageContent(event), emotion: 0 },
          timestamp: event.createdAt,
          upsertMessage: (message) => useMessageStore.getState().upsertMessage(message),
        });
      },
      appendEventMessages: async (id, payloads) => {
        const target = useChatStore.getState().chats.find((item) => item.id === id);
        await persistLocalFirstMessages({
          messages: payloads.map((payload) => {
            const event = normalizeRuntimeEvent(target ? buildPrivateSessionEvent(target, payload) : payload);
            return { message: { chatId: id, type: 'event' as const, senderId: 'system', senderName: 'System', content: buildRuntimeEventMessageContent(event), emotion: 0 }, timestamp: event.createdAt };
          }),
          upsertMessages: (messages) => useMessageStore.getState().upsertMessages(messages),
        });
      },
      updateChat: (id, patch) => useChatStore.getState().updateChat(id, patch),
      applyChatRuntimeDelta: (id, delta, patch) => useChatStore.getState().applyChatRuntimeDelta(id, delta, patch),
      recordSpeak: (characterId) => useSchedulerStore.getState().recordSpeak(characterId),
      signal,
      shouldContinue: () => !signal.aborted && useChatStore.getState().chats.some((item) => item.id === chatId && item.type === 'direct' && item.deletedAt == null),
    });
    const reply = committedReply(chatId, userMessageId);
    if (!reply) throw new Error('单聊生成返回后未找到已提交回复，结果需要核对');
    flushBufferedPersistenceWrites();
    return { output: reply.id };
  });
}

const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: executeDirectReply });
const listeners = new Set<() => void>();
const active = new Set<string>();
let revision = 0;
function publish() { revision += 1; listeners.forEach((listener) => listener()); }

export function subscribeDirectBackgroundReplies(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getDirectBackgroundRevision() { return revision; }
export function directReplyRunId(chatId: string, userMessageId: string) { return `direct-reply-${chatId}\n${userMessageId}`; }
export function isDirectBackgroundActive(chatId: string) { return [...active].some((runId) => runId.startsWith(`direct-reply-${chatId}\n`)); }

export async function listDirectBackgroundReplies(chatId?: string) {
  const runs = await runtime.list();
  return runs.filter((item) => item.tasks[0]?.kind === 'direct_reply' && (!chatId || item.run.chatId === chatId));
}

export async function startDirectBackgroundReply(chatId: string, userMessageId: string) {
  const runId = directReplyRunId(chatId, userMessageId);
  const now = Date.now();
  if (!await runtime.read(runId)) {
    const snapshot: WorkflowSnapshot = {
      run: { id: runId, chatId, goal: '回复用户消息', status: 'active', generation: 0, planVersion: 1, updatedAt: now },
      tasks: [{ id: userMessageId, runId, kind: 'direct_reply', input: { chatId, userMessageId }, dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }],
    };
    await runtime.create(snapshot);
    publish();
  }
  return resumeDirectBackgroundReply(runId);
}

export async function resumeDirectBackgroundReply(runId: string) {
  const run = await runtime.read(runId);
  if (!run) throw new Error('单聊任务不存在');
  if (run.run.status === 'completed' || run.tasks.some((task) => task.status === 'result_unknown')) return { snapshot: run, summary: summarizeWorkflowRun(run) };
  active.add(runId); publish();
  try {
    const snapshot = await runtime.resume(runId, getWorkspaceSignal());
    return { snapshot, summary: summarizeWorkflowRun(snapshot) };
  } finally { active.delete(runId); publish(); }
}

export async function recoverDirectBackgroundReplies() {
  if (!navigator.locks?.request) throw new Error('此设备不支持安全的单聊任务恢复');
  const scope = currentWorkflowScope();
  const runs = await listDirectBackgroundReplies();
  await Promise.all([
    useChatStore.persist.hasHydrated() ? Promise.resolve() : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? Promise.resolve() : useMessageStore.persist.rehydrate(),
  ]);
  let changed = false;
  for (const item of runs) {
    if (item.run.status !== 'active' || active.has(item.run.id)) continue;
    const recovered = await navigator.locks.request(workflowRunLockName(scope, item.run.id), { ifAvailable: true }, async (lock) => {
      if (!lock || currentWorkflowScope() !== scope) return false;
      const chat = useChatStore.getState().chats.find((entry) => entry.id === item.run.chatId && entry.type === 'direct' && entry.deletedAt == null);
      const reply = chat && item.tasks[0] ? committedReply(chat.id, item.tasks[0].id) : null;
      return indexedDbWorkflowRepository.transact(scope, item.run.id, (current) => {
        if (!current || current.run.status !== 'active') return { snapshot: current || item, value: false };
        if (reply && current.tasks.length === 1) {
          const snapshot: WorkflowSnapshot = {
            ...current,
            run: { ...current.run, status: 'completed', generation: current.run.generation + 1, updatedAt: Date.now() },
            tasks: [{ ...current.tasks[0], status: 'completed', output: reply.id, error: undefined, updatedAt: Date.now() }],
          };
          return { snapshot, value: true };
        }
        const snapshot: WorkflowSnapshot = {
          ...current,
          run: { ...current.run, status: 'paused', generation: current.run.generation + 1, updatedAt: Date.now() },
          tasks: current.tasks.map((task) => task.status === 'running'
            ? { ...task, status: 'result_unknown', error: '程序关闭前的回复结果无法确认', updatedAt: Date.now() }
            : task),
        };
        return { snapshot, value: true };
      });
    });
    changed ||= recovered;
  }
  if (changed) publish();
  return changed;
}
