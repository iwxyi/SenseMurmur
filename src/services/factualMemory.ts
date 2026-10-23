import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { RuntimeEventPayload } from './runtimeEventFactory';
import type { APIConfig } from '../types/settings';
import { generateJsonResponse } from './aiClient';
import { api, ApiError } from './api';
import { useFactArchiveStore } from '../stores/useFactArchiveStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { isCloudSyncEnabled } from './cloudSyncPreference';
import { flushBufferedPersistenceWrites } from '../stores/storePersistenceScope';
import { reportRecoverableError, reportRecoverableWarning } from './diagnostics';
import { assertWorkspaceActive, getWorkspaceSignal } from './workspaceLifecycle';
import { sanitizeUserFacingText } from './displayTextSanitizer';
import { collapseMergedFacts, FactExtractionValidationError, parseDetailedFacts, type FactEvidence, type FactArchiveEntry, type FactMergeCandidate, type RecalledFact } from './factualMemoryTypes';

export const FACT_EXTRACTION_PROMPT = `你为角色保存少量以后值得想起的具体事实。先判断新信息的记忆价值，再决定提取什么；默认返回 {"facts":[]}。
值得保存的信息应有上下文支持的后续用途：过后能据此更了解某个人、记住对他有意义的经历、履行在意的约定、跟进有实际后果的牵挂，或找回需要准确记住的内容。判断时在心中回答“谁以后会因为什么需要想起它，忘记会有什么具体损失”；用途应来自对话表达的在意、约束或后果，不替每句话编造一个将来可能用上的理由。
例如：某人解释自己为何在意一件旧衣、一次失约使谁再也不肯托付、明确约好的接头暗号、尚待归还的借款及期限、以后相处需尊重的个人边界。类别只是例子，由你结合语境判断；一次表达也能值得记住，轻微但个人在意的生活细节同样可以有价值。
具体、已确认、有日期或有分工只说明信息清楚，保存还需要上述记忆价值。将来仍有实际用途的短期约定也可以保存，不以时间远近代替价值判断。详细事实服务于以后回忆；当前场景如何继续由聊天上下文承载，原话改写成完整陈述本身不增加记忆价值。
例如在普通对账闲聊中，“念错就重念，念到对上，刘备准了”“明早对完账就动身，今晚核路费”只交代眼前流程，未体现值得以后查回的在意或后果，返回 facts=[]。若说“上次失约让我在雨里等了一夜，这次请一定来”，可保存具体经历及此次约定；“下次接头用青梅煮酒”应保存准确暗号。依据实际上下文判断，不能将例子当作关键词规则。
通过价值判断后才处理增量：已有信息首次达成约定，或时间、数字、分工、条件发生对后续用途有影响的变化时，记录必要变化；确认或换一种说法不增加信息。
existingFacts 是当前分支上已保存、且本条消息受众均已知晓的有效记录，来源可以早于最近的上下文，不是新证据。已有事实的同义改写、无信息增量的确认不得再保存，返回 facts=[]。同一事项新增有效条件时，输出一条简洁完整的合并事实，并用 mergeWith 引用被合并记录的 ref，sourceIds 必须保留这些记录的全部来源及新消息。仅在状态一致且不存在矛盾时合并；不同说法和更正须明确保留，不得以合并删除。不同事项不要强行合并，不按说话人或句子拆条。
若新消息明确指出已保存记录是误提取、误归属或误解，可用 retracted=true、mergeWith 引用错误记录，text 简述作废对象与依据，status 保持原记录状态，sourceIds 保留原来源及本条纠错消息。仅重复提及不作废；事情后来改变、提议被拒绝或有人持不同说法，均是新的经历，应记录变化或分歧，不能抹去曾发生的事。不要为猜测、模糊指代或缺少信息而删除记录。普通新增或合并省略 retracted。
连续理解上下文：甲说“定个暗号吧”，乙说“青梅煮酒”，甲说“好，下次就用这个”，应记完整的暗号约定及逐字内容，引用三条来源。
只提取 newMessage 对应的新消息的增量。contextMessages 仅用于理解指代和完整约定，不要提取其中的旧事实。新消息无值得保留的增量时返回 facts=[]。不要为了通过校验给旧事实补上新消息引用。提议尚未同意用 proposed；明确约定用 agreed；个人陈述用 asserted 并说明是谁说的，不能当作全知事实；冲突用 disputed 保留不同说法。
更正写清旧内容、新内容和更正人。记录只作为角色所知，不替别人确认事实，不推测未公开的动机。不要把玩笑、假设、转述或角色扮演内事实升级为现实共识。
重要原话逐字保留，不改写暗号、名字、数字。text 必须独立可读、非空且不超过1200个字符。每条事实的 sourceIds 为1至12个字符串，只能逐字复制 newMessage.id、contextMessages[].id 或被维护的 existingFacts[].sourceIds，不能使用人名或自行编造标识，且每条事实必须含 newMessageId。
例如已有“下次接头暗号为青梅煮酒”，新话“好，我记下了”返回 facts=[]；“暗号改成白马渡江”保留更正；“只在渡口接头时使用”可合并补充适用条件。文本只写承载记忆价值的必要内容，来源引用保留完整证据。
返回 {"facts":[{"text":"完整事实及知情局限","status":"asserted|agreed|proposed|disputed","sourceIds":["消息标识"],"mergeWith":["已有记录ref"]}]}，最多六条，通常零至一条。没有合并时 mergeWith=[]。`;

function cloudMode() { return useAuthStore.getState().authMode !== 'local' && isCloudSyncEnabled(); }
function idOf(message: Message) { return message.serverId || message.id; }

function resolveServerId(id: string) {
  const messages = [...useMessageStore.getState().messages,
    ...Object.values(useMessageStore.getState().messageWindowsByChatId).flatMap((window) => window.messages)];
  return messages.find((message) => message.id === id || message.clientKey === id || message.serverId === id)?.serverId
    || Object.values(useFactArchiveStore.getState().chats).flatMap((archive) => Object.values(archive.nodes))
      .find((source) => source.id === id || source.nodeId === id)?.serverId || id;
}

function localDeletion(chatId: string, factId: string) {
  const canonical = canonicalFactId(factId);
  return Object.entries(useFactArchiveStore.getState().chats[chatId]?.deletions || {})
    .find(([id]) => canonicalFactId(id) === canonical)?.[1];
}

function canonicalFactId(id: string) {
  const split = id.lastIndexOf(':');
  return `${resolveServerId(id.slice(0, split))}${id.slice(split)}`;
}

function saveDeletion(chatId: string, factId: string, deleted: boolean, synced: boolean) {
  const canonical = canonicalFactId(factId);
  const existingKey = Object.keys(useFactArchiveStore.getState().chats[chatId]?.deletions || {})
    .find((id) => canonicalFactId(id) === canonical);
  useFactArchiveStore.getState().setDeletion(chatId, existingKey || factId, deleted, synced);
}

async function syncFactDeletion(chatId: string, factId: string, deleted: boolean) {
  const split = factId.lastIndexOf(':');
  try {
    await api.request('POST', `/chats/${encodeURIComponent(chatId)}/fact-archive/deletion`, {
      messageId: resolveServerId(factId.slice(0, split)), factIndex: Number(factId.slice(split + 1)), deleted,
    });
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'MEMORY_BRANCH_SOURCE_MISSING') return false;
    throw error;
  }
}

export async function setDetailedFactDeleted(fact: RecalledFact, deleted: boolean) {
  const signal = getWorkspaceSignal();
  await ensureArchiveHydrated();
  assertWorkspaceActive(signal);
  const synced = cloudMode() ? await syncFactDeletion(fact.chatId, fact.id, deleted) : false;
  assertWorkspaceActive(signal);
  saveDeletion(fact.chatId, fact.id, deleted, synced);
  await flushBufferedPersistenceWrites();
}

interface MaintenanceCandidate extends FactMergeCandidate { sources: FactEvidence[] }

async function factMaintenanceContext(chat: GroupChat, anchor: FactEvidence, signal: AbortSignal): Promise<MaintenanceCandidate[]> {
  const archive = useFactArchiveStore.getState().chats[chat.id];
  const active = new Set<string>();
  let node: string | null = anchor.nodeId;
  while (node) {
    if (active.has(node)) throw new Error('MEMORY_BRANCH_CYCLE');
    active.add(node);
    node = archive.nodes[node]?.parentNodeId || null;
  }
  const nodes = new Map(Object.values(archive.nodes).map((source) => [source.id, source]));
  const local = Object.values(archive.entries).flatMap((entry) => entry.facts.flatMap((fact, factIndex) => {
    const sources = fact.sourceIds.map((id) => nodes.get(id));
    if (sources.some((source) => !source || source.invalid || source.timestamp > anchor.timestamp
      || (anchor.parentNodeId !== undefined ? !active.has(source.nodeId) : Boolean(source.parentNodeId))
      || anchor.audience.some((id) => !source.audience.includes(id))
      || !entry.sources.some((recorded) => recorded.id === source.id && recorded.content === source.content))) return [];
    return [{ id: `${entry.messageId}:${factIndex}`, chatId: chat.id, messageId: entry.messageId, factIndex, fact,
      mergedFrom: fact.mergedFrom, retracted: fact.retracted,
      userDeleted: localDeletion(chat.id, `${entry.messageId}:${factIndex}`)?.deleted, sources: sources as FactEvidence[] }];
  }));
  if (!cloudMode()) return collapseMergedFacts(local);
  let cloud: { items: MaintenanceCandidate[] };
  try {
    cloud = await api.request('POST', `/chats/${encodeURIComponent(chat.id)}/fact-maintenance-context`, { messageId: resolveServerId(anchor.id) });
  } catch (error) {
    assertWorkspaceActive(signal);
    if (!(error instanceof ApiError) || error.code !== 'MEMORY_BRANCH_SOURCE_MISSING') throw error;
    // Local-first source delivery is expected to lag; keep validated local context.
    return collapseMergedFacts(local);
  }
  assertWorkspaceActive(signal);
  // Keep local identities stable when an uploaded source has acquired a server id.
  const aliases = new Map(Object.values(archive.nodes).map((source) => [resolveServerId(source.id), source.id]));
  for (const source of cloud.items.flatMap((item) => item.sources)) {
    const captured = archive.nodes[source.nodeId];
    if (captured) aliases.set(source.id, captured.id);
  }
  const localId = (id: string) => aliases.get(id) || id;
  useFactArchiveStore.getState().capture(chat.id, cloud.items.flatMap((item) => item.sources)
    .map((source) => ({ ...source, id: localId(source.id), serverId: source.id })));
  const candidates = [...local, ...cloud.items.filter((item) => !item.sources.some((source) => {
    const captured = archive.nodes[source.nodeId] || nodes.get(localId(source.id));
    return captured?.invalid || (captured?.content && captured.content !== source.content);
  })).map((item) => ({ ...item, messageId: localId(item.messageId),
    fact: { ...item.fact, sourceIds: item.fact.sourceIds.map(localId),
      mergedFrom: item.fact.mergedFrom?.map((ref) => ({ ...ref, messageId: localId(ref.messageId) })) },
    sources: item.sources.map((source) => ({ ...source, id: localId(source.id), serverId: source.id })) }))];
  return collapseMergedFacts([...new Map(candidates.map((item) => {
    const id = `${item.messageId}:${item.factIndex}`;
    const deletion = localDeletion(chat.id, id);
    if (item.fact.userDeleted !== undefined && (!deletion || deletion.synced) && (item.fact.userDeleted || deletion)) {
      saveDeletion(chat.id, id, item.fact.userDeleted, true);
    }
    return [id, { ...item, id, chatId: chat.id, mergedFrom: item.fact.mergedFrom, retracted: item.fact.retracted,
      userDeleted: deletion && !deletion.synced ? deletion.deleted : item.fact.userDeleted ?? ('userDeleted' in item ? item.userDeleted : false) }] as const;
  })).values()]);
}

export function captureFactEvidence(chat: GroupChat, messages: Message[], newMessage: Message) {
  const publicAudience = [...new Set(['user', ...chat.memberIds])];
  const sources: FactEvidence[] = [...messages.filter((message) => idOf(message) !== idOf(newMessage)), newMessage]
    .filter((message) => !message.isDeleted && !message.isStreaming && !message.isOptimistic
      && !message.metadata?.withdrawal?.withdrawn && ['user', 'ai'].includes(message.type) && message.content.trim())
    .slice(-12).map((message) => ({
      id: idOf(message), serverId: message.serverId, nodeId: message.metadata?.branching?.nodeId || message.clientKey || message.id,
      parentNodeId: message.metadata?.branching?.parentNodeId,
      content: message.content, senderId: message.senderId, senderName: message.senderName, timestamp: message.timestamp,
      // Legacy context does not prove who heard it. Only new commits capture delivery.
      audience: message.metadata?.memoryAudience || (idOf(message) === idOf(newMessage)
        ? message.metadata?.visibility && message.metadata.visibility !== 'public' ? [message.senderId] : publicAudience
        : [message.senderId]),
    }));
  useFactArchiveStore.getState().capture(chat.id, sources);
  const nodes = useFactArchiveStore.getState().chats[chat.id].nodes;
  return sources.map((source) => ({ ...source, audience: nodes[source.nodeId].audience, invalid: nodes[source.nodeId].invalid }));
}

const tasks = new Map<string, Promise<void>>();
const chatTasks = new Map<string, Promise<void>>();

export function scheduleFactRecording(params: { api: APIConfig; chat: GroupChat; messages: Message[]; message: Message;
  appendEventMessage: (chatId: string, payload: RuntimeEventPayload, sourceMessageId?: string) => Promise<void>;
}) {
  if (params.chat.sessionKind?.family !== 'conversation' && params.chat.mode !== 'open_chat') return;
  if (!['ai', 'user'].includes(params.message.type) || !params.message.content.trim() || params.message.isDeleted
    || params.message.isStreaming || params.message.metadata?.withdrawal?.withdrawn) return;
  const anchorId = idOf(params.message);
  const key = `${params.chat.id}:${anchorId}`;
  if (tasks.has(key) || useFactArchiveStore.getState().chats[params.chat.id]?.entries[anchorId]) return;
  const signal = getWorkspaceSignal();
  const previousTask = chatTasks.get(params.chat.id);
  const task = (async () => {
    try {
      // Separate bubbles can commit together. Extract in order so later bubbles
      // see the facts saved by earlier ones instead of all creating duplicates.
      await previousTask;
      assertWorkspaceActive(signal);
      await ensureArchiveHydrated();
      const sources = captureFactEvidence(params.chat, params.messages, params.message);
      if (!sources.some((source) => source.id === anchorId)) return;
      const existingFacts = await factMaintenanceContext(params.chat, sources.find((source) => source.id === anchorId)!, signal);
      const evidence = [...new Map([...existingFacts.flatMap((candidate) => candidate.sources), ...sources].map((source) => [source.id, source])).values()];
      const mergeCandidates = new Map<string, FactMergeCandidate>(existingFacts.map((candidate, index) => [`f${index}`, candidate]));
      const toInput = ({ id, senderName, content }: FactEvidence) => ({ id, speaker: senderName, content });
      const input = [{ role: 'user' as const, content: JSON.stringify({
        newMessageId: anchorId, newMessage: toInput(sources.find((source) => source.id === anchorId)!),
        contextMessages: sources.filter((source) => source.id !== anchorId).map(toInput),
        existingFacts: [...mergeCandidates].map(([ref, { fact }]) => ({ ref, text: fact.text, status: fact.status, sourceIds: fact.sourceIds })),
      }) }];
      const generate = (prompt: string) => generateJsonResponse(params.api, prompt, input,
        { signal, maxTokens: 2000, aiUsage: { type: 'memory_refinement', label: '具体事实记录' } });
      let raw = await generate(FACT_EXTRACTION_PROMPT);
      assertWorkspaceActive(signal);
      const allowedIds = new Set(evidence.map((source) => source.id));
      const parse = (response: string) => parseDetailedFacts(response, allowedIds, anchorId, (error) => {
        reportRecoverableWarning({ location: 'memory.fact-record-context-only', error,
          message: '已排除未引用新消息的旧事实，其余合法事实继续保存；未自动补充来源。' });
      }, mergeCandidates);
      let facts: ReturnType<typeof parseDetailedFacts>;
      try {
        facts = parse(raw);
      } catch (error) {
        if (!(error instanceof FactExtractionValidationError)) throw error;
        reportRecoverableWarning({ location: 'memory.fact-record-validation', error,
          message: '详细事实输出未通过校验，正在重试一次。' });
        raw = await generate(`${FACT_EXTRACTION_PROMPT}\n上次输出校验失败：${error.message}。请依照同一份消息来源重新提取，修正该字段。不要虚构来源或擅自补充事实；无新事实时返回 {"facts":[]}。只返回合法 JSON。`);
        assertWorkspaceActive(signal);
        facts = parse(raw);
      }
      facts = facts.filter((fact, index, all) => (fact.retracted || !existingFacts.some(({ fact: existing }) => existing.text === fact.text && existing.status === fact.status))
        && !all.slice(0, index).some((other) => other.text === fact.text && other.status === fact.status && other.retracted === fact.retracted));
      // Cloud maintenance can supply evidence outside the loaded message window.
      useFactArchiveStore.getState().capture(params.chat.id, evidence);
      const entry: FactArchiveEntry = { messageId: anchorId, facts, sources: evidence };
      useFactArchiveStore.getState().save(params.chat.id, entry);
      await flushBufferedPersistenceWrites();
      assertWorkspaceActive(signal);
      if (facts.length) {
        const retractedCount = facts.filter((fact) => fact.retracted).length;
        const updatedCount = facts.filter((fact) => !fact.retracted && fact.mergedFrom?.length).length;
        const addedCount = facts.length - updatedCount - retractedCount;
        const changes = [addedCount ? `新增 ${addedCount} 条` : '', updatedCount ? `合并更新 ${updatedCount} 条` : '',
          retractedCount ? `作废 ${retractedCount} 条` : ''].filter(Boolean).join('，');
        try {
          await params.appendEventMessage(params.chat.id, {
            eventType: 'detailed_fact_recorded', title: '详细事实已保存',
            summary: `${changes}详细事实：\n${facts.map((fact, index) => `${index + 1}. ${fact.retracted ? '【作废】' : fact.mergedFrom?.length ? '【合并更新】' : ''}${sanitizeUserFacingText(fact.text, [], { preserveLineBreaks: true })}`).join('\n')}`,
            visibilityScope: 'moderator_only',
          }, params.message.id);
        } catch (error) {
          if (signal.aborted) return;
          reportRecoverableError({ location: 'memory.fact-record-hint', error, userMessage: '详细事实已保存，但生成提示未能显示。' });
        }
      }
      if (cloudMode()) {
        try {
          await syncEntry(params.chat.id, entry);
        } catch (error) {
          if (signal.aborted) return;
          reportRecoverableError({ location: 'memory.fact-sync', error, userMessage: '详细事实已保存在本机，云端同步失败，将在下次读取时重试。' });
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      reportRecoverableError({ location: 'memory.fact-record', error, userMessage: '详细事实提取失败，聊天消息仍已保存。' });
    }
  })().finally(() => {
    tasks.delete(key);
    if (chatTasks.get(params.chat.id) === task) chatTasks.delete(params.chat.id);
  });
  tasks.set(key, task);
  chatTasks.set(params.chat.id, task);
}

async function syncEntry(chatId: string, entry: FactArchiveEntry) {
  if (!entry.facts.length) {
    useFactArchiveStore.getState().save(chatId, { ...entry, synced: true });
    return;
  }
  const serverAnchorId = resolveServerId(entry.messageId);
  // The local-first outbox may not have created the server source row yet.
  if (entry.messageId.startsWith('local-message-') && serverAnchorId === entry.messageId) return;
  const usedIds = new Set(entry.facts.flatMap((fact) => fact.sourceIds));
  try {
    await api.request('POST', `/chats/${encodeURIComponent(chatId)}/fact-archive`, {
    messageId: serverAnchorId,
    facts: entry.facts.map((fact) => ({ ...fact, sourceIds: fact.sourceIds.map(resolveServerId),
      ...(fact.mergedFrom ? { mergedFrom: fact.mergedFrom.map((ref) => ({ ...ref, messageId: resolveServerId(ref.messageId) })) } : {}) })),
    sources: entry.sources.filter((source) => usedIds.has(source.id)).map(({ id, content }) => ({ id: resolveServerId(id), content })),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || !['MEMORY_BRANCH_SOURCE_MISSING', 'MEMORY_MERGE_SOURCE_PENDING'].includes(error.code || '')) throw error;
    // Leave the entry unsynced until its evidence and merge targets arrive.
    return;
  }
  useFactArchiveStore.getState().save(chatId, { ...entry, synced: true });
}

export async function flushFactRecording() { await Promise.all([...tasks.values()]); }

export function recallLocalFacts(actorId?: string, destination?: GroupChat, includeMerged = false, sourceChatId?: string): RecalledFact[] {
  const chats = useChatStore.getState().chats;
  const archives = useFactArchiveStore.getState().chats;
  const audience = destination ? ['user', ...destination.memberIds] : actorId ? [actorId] : [];
  return chats.filter((chat) => !chat.deletedAt && (!sourceChatId || chat.id === sourceChatId)).flatMap((chat) => {
    const archive = archives[chat.id];
    if (!archive) return [];
    const state = chat.messageBranchState;
    const head = state?.refs?.[state.activeBranchName || 'main']?.headNodeId || state?.activeLeafNodeId;
    const active = new Set<string>();
    let node = head || null;
    while (node) {
      if (active.has(node)) throw new Error('MEMORY_BRANCH_CYCLE');
      active.add(node);
      const source = archive.nodes[node];
      if (!source) break; // Unknown older ancestry is not treated as known.
      node = source.parentNodeId || null;
    }
    const eligible = Object.values(archive.entries).flatMap((entry) => entry.facts.flatMap((fact, index) => {
      const sources = fact.sourceIds.map((id) => Object.values(archive.nodes).find((source) => source.id === id));
      const recordedSources = new Map(entry.sources.map((source) => [source.id, source.content]));
      if (sources.some((source) => !source || source.invalid || (head ? !active.has(source.nodeId) : Boolean(source.parentNodeId))
        || (actorId !== undefined && !source.audience.includes(actorId)) || audience.some((id) => !source.audience.includes(id))
        || recordedSources.get(source.id) !== source.content)) return [];
      return [{ id: `${entry.messageId}:${index}`, text: fact.text, status: fact.status, timestamp: entry.sources.at(-1)?.timestamp || 0, chatId: chat.id,
        userDeleted: localDeletion(chat.id, `${entry.messageId}:${index}`)?.deleted,
        knownByIds: sources.reduce<string[]>((ids, source) => ids.filter((id) => source!.audience.includes(id)), sources[0]!.audience),
        ...(fact.retracted ? { retracted: true } : {}),
        ...(fact.mergedFrom ? { mergedFrom: fact.mergedFrom } : {}) }];
    }));
    return includeMerged ? eligible : collapseMergedFacts(eligible);
  });
}

async function ensureArchiveHydrated() {
  if (!useFactArchiveStore.persist.hasHydrated()) await useFactArchiveStore.persist.rehydrate();
}

export async function listDetailedFacts(actorId: string, destination?: GroupChat): Promise<RecalledFact[]> {
  return readDetailedFacts({ actorId, destination });
}

export async function listConversationDetailedFacts(chatId: string): Promise<RecalledFact[]> {
  return readDetailedFacts({ sourceChatId: chatId });
}

async function readDetailedFacts({ actorId, destination, sourceChatId }: { actorId: string; destination?: GroupChat; sourceChatId?: never } | { actorId?: never; destination?: never; sourceChatId: string }): Promise<RecalledFact[]> {
  const signal = getWorkspaceSignal();
  await ensureArchiveHydrated();
  await flushFactRecording();
  assertWorkspaceActive(signal);
  const localFacts = (includeMerged = false) => recallLocalFacts(actorId, destination, includeMerged, sourceChatId);
  if (!cloudMode()) return localFacts();
  // A failed save stays retryable. Never mark a checkpoint before durable storage.
  for (const [chatId, archive] of Object.entries(useFactArchiveStore.getState().chats)) {
    if (sourceChatId && sourceChatId !== chatId) continue;
    for (const entry of Object.values(archive.entries)) {
      if (entry.synced) continue;
      try {
        await syncEntry(chatId, entry);
      } catch (error) {
        assertWorkspaceActive(signal);
        reportRecoverableError({ location: 'memory.fact-sync', error,
          userMessage: '部分详细事实尚未同步，继续查询已保存的事实；未同步记录保留以便重试。' });
      }
    }
    for (const [id, deletion] of Object.entries(archive.deletions || {})) {
      if (deletion.synced) continue;
      const synced = await syncFactDeletion(chatId, id, deletion.deleted);
      assertWorkspaceActive(signal);
      if (synced) useFactArchiveStore.getState().setDeletion(chatId, id, deletion.deleted, true);
    }
  }
  let response: { items: RecalledFact[] };
  try {
    response = sourceChatId
      ? await api.request<{ items: RecalledFact[] }>('POST', `/chats/${encodeURIComponent(sourceChatId)}/fact-archive/list`, {})
      : destination
      ? await api.request<{ items: RecalledFact[] }>('POST', `/chats/${encodeURIComponent(destination.id)}/fact-recall`, { actorId })
      : await api.request<{ items: RecalledFact[] }>('POST', `/characters/${encodeURIComponent(actorId!)}/fact-archive`, {});
  } catch (error) {
    assertWorkspaceActive(signal);
    if (!(error instanceof ApiError) || error.code !== 'MEMORY_BRANCH_SOURCE_MISSING') throw error;
    // Normal outbox ordering can temporarily leave cloud ancestry incomplete.
    return localFacts();
  }
  assertWorkspaceActive(signal);
  const localItems = localFacts(true);
  const canonical = (item: RecalledFact): RecalledFact => {
    const separator = item.id.lastIndexOf(':');
    return { ...item, id: separator < 0 ? item.id : `${resolveServerId(item.id.slice(0, separator))}${item.id.slice(separator)}`,
      ...(item.mergedFrom ? { mergedFrom: item.mergedFrom.map((ref) => ({ ...ref, messageId: resolveServerId(ref.messageId) })) } : {}) };
  };
  const cloudItems = new Map(response.items.map(canonical).map((item) => [JSON.stringify([item.chatId, item.id]), item]));
  for (const item of cloudItems.values()) {
    const deletion = localDeletion(item.chatId, item.id);
    if (item.userDeleted !== undefined && (!deletion || deletion.synced) && (item.userDeleted || deletion)) {
      saveDeletion(item.chatId, item.id, item.userDeleted, true);
    }
  }
  const combined = [...localItems.map(canonical), ...cloudItems.values()].map((item) => {
    const deletion = localDeletion(item.chatId, item.id);
    const cloud = cloudItems.get(JSON.stringify([item.chatId, item.id]));
    return { ...item, userDeleted: deletion && !deletion.synced ? deletion.deleted : cloud?.userDeleted ?? item.userDeleted };
  });
  return [...new Map(collapseMergedFacts(combined).map((item) => [item.text, item])).values()];
}

export async function buildDetailedFactPrompt(apiConfig: APIConfig, chat: GroupChat, actorId: string, messages: Message[]) {
  const candidates = await listDetailedFacts(actorId, chat);
  if (!candidates.length) return '';
  // Small archives fit directly. Ask for semantic ranking only once there is a real choice.
  let selected = candidates.length <= 6 ? candidates : [];
  const recent = messages.filter((message) => !message.isDeleted && !message.metadata?.withdrawal?.withdrawn).slice(-6)
    .map((message) => ({ speaker: message.senderName, text: message.content }));
  if (candidates.length > 6) {
    // Semantic selection includes corrections and linked context; no keyword gate.
    for (let offset = 0; offset < candidates.length; offset += 34) {
      const batch = [...selected, ...candidates.slice(offset, offset + 34)];
      const raw = await generateJsonResponse(apiConfig,
        '从角色确实知情的事实档案中选择与当前聊天有关的记录。可不选，最多六条。保留理解更正、不同说法所需的旧记录，不能凭新旧时间认定已替代。不要选择仅有泛泛话题相似的细节。只返回 {"ids":["候选标识"]}。',
        [{ role: 'user', content: JSON.stringify({ recent, candidates: batch }) }], { maxTokens: 400, aiUsage: { type: 'memory_refinement', label: '具体事实召回' } });
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !('ids' in parsed) || !Array.isArray(parsed.ids)
        || parsed.ids.length > 6 || !parsed.ids.every((id) => typeof id === 'string' && batch.some((fact) => fact.id === id))) {
        throw new Error('MEMORY_RECALL_SELECTION_INVALID');
      }
      selected = batch.filter((fact) => (parsed.ids as unknown[]).includes(fact.id));
    }
  }
  if (!selected.length) return '';
  return '\n你亲历或听说过的具体记忆（个人陈述不等于真相，提议不等于已约定；留意更正与时间，不必逐条回应）：\n'
    + selected.map((fact) => `- ${new Date(fact.timestamp).toISOString()} [${fact.status}] ${sanitizeUserFacingText(fact.text)}`).join('\n');
}
