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

export const FACT_EXTRACTION_PROMPT = `你负责从已发生的聊天记录保存少量值得再想起的具体事实，不负责概括每轮聊天。
仅保留以后离开当前话题仍值得查回的新增信息：明确且有具体内容的约定、暗号、实际行动承诺、稳定偏好、个人生活细节、需要后续处理的具体事项。默认 facts=[]，不要为了每条消息都有记录而提取。
保存前判断：以后忘记这条信息，会不会影响履行约定、理解某人、继续处理事情或回答一个具体问题？若不会，或只有“某人说了一句话”而无可用信息，返回 facts=[]。不为保存而逐字摘录，不记录无实际约束的口头保证和无后续用途的琐碎动作。宁可少记；但明确、可复用的暗号、日期、金额、限制、分工不能遗漏。
不保留：附和、复述、催促、调侃、逞强、自我夸耀、泛泛道理、只用于接话的表态，以及同一事项的重复保证。“我记下了，先查账再论人”“不许改口”“我上阵都不怕，还怕念账？”都返回 facts=[]。确认已有约定不自动成为新事实；只有从未达成的提议首次明确被接受，或新增时间、数字、分工、条件、更正，才记录变化。
existingFacts 是已存档且有当前上下文来源支持的记录，不是新证据。已有事实的同义改写、无信息增量的确认不得再保存，返回 facts=[]。同一事项新增有效条件时，输出一条简洁完整的合并事实，并用 mergeWith 引用被合并记录的 ref，sourceIds 必须保留这些记录的全部来源及新消息。仅在状态一致且不存在矛盾时合并；不同说法和更正须明确保留，不得以合并删除。不同事项不要强行合并，不按说话人或句子拆条。
连续理解上下文：甲说“定个暗号吧”，乙说“青梅煮酒”，甲说“好，下次就用这个”，应记完整的暗号约定及逐字内容，引用三条来源。
只提取 newMessage 对应的新消息的增量。contextMessages 仅用于理解指代和完整约定，不要提取其中的旧事实。新消息无值得保留的增量时返回 facts=[]。不要为了通过校验给旧事实补上新消息引用。提议尚未同意用 proposed；明确约定用 agreed；个人陈述用 asserted 并说明是谁说的，不能当作全知事实；冲突用 disputed 保留不同说法。
更正写清旧内容、新内容和更正人。记录只作为角色所知，不替别人确认事实，不推测未公开的动机。不要把玩笑、假设、转述或角色扮演内事实升级为现实共识。
重要原话逐字保留，不改写暗号、名字、数字。text 必须独立可读、非空且不超过1200个字符。每条事实的 sourceIds 为1至12个字符串，只能逐字复制 newMessage.id 或 contextMessages[].id，不能使用人名或自行编造标识，且每条事实必须含 newMessageId。
例如已有“明日对账，礼数单列，口粮不动”，新话“好，我记下了”不保存；“改在上午九点对账”应保留更正；“账由关羽核、张飞报”可以合并为含原约定及新分工的一条，不把催促和玩笑一起抄入。
返回 {"facts":[{"text":"完整事实及知情局限","status":"asserted|agreed|proposed|disputed","sourceIds":["消息标识"],"mergeWith":["已有记录ref"]}]}，最多六条，通常零至一条。没有合并时 mergeWith=[]。`;

function cloudMode() { return useAuthStore.getState().authMode !== 'local' && isCloudSyncEnabled(); }
function idOf(message: Message) { return message.serverId || message.id; }

export function captureFactEvidence(chat: GroupChat, messages: Message[], newMessage: Message) {
  const publicAudience = [...new Set(['user', ...chat.memberIds])];
  const sources: FactEvidence[] = [...messages.filter((message) => idOf(message) !== idOf(newMessage)), newMessage]
    .filter((message) => !message.isDeleted && !message.isStreaming && !message.isOptimistic
      && !message.metadata?.withdrawal?.withdrawn && ['user', 'ai'].includes(message.type) && message.content.trim())
    .slice(-12).map((message) => ({
      id: idOf(message), nodeId: message.metadata?.branching?.nodeId || message.clientKey || message.id,
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
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const existingFacts = collapseMergedFacts(Object.values(useFactArchiveStore.getState().chats[params.chat.id].entries)
        .flatMap((entry) => entry.facts.flatMap((fact, factIndex) => fact.sourceIds.every((id) => {
          const source = sourceById.get(id);
          return source && !source.invalid && entry.sources.some((recorded) => recorded.id === id && recorded.content === source.content);
        }) ? [{ id: `${entry.messageId}:${factIndex}`, chatId: params.chat.id,
          messageId: entry.messageId, factIndex, fact, mergedFrom: fact.mergedFrom }] : [])));
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
      const allowedIds = new Set(sources.map((source) => source.id));
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
      facts = facts.filter((fact, index, all) => !existingFacts.some(({ fact: existing }) => existing.text === fact.text && existing.status === fact.status)
        && !all.slice(0, index).some((other) => other.text === fact.text && other.status === fact.status));
      const entry: FactArchiveEntry = { messageId: anchorId, facts, sources };
      useFactArchiveStore.getState().save(params.chat.id, entry);
      await flushBufferedPersistenceWrites();
      assertWorkspaceActive(signal);
      if (facts.length) {
        try {
          await params.appendEventMessage(params.chat.id, {
            eventType: 'detailed_fact_recorded', title: '详细事实已保存',
            summary: `${facts.some((fact) => fact.mergedFrom?.length) ? '保存（含合并更新）' : '新增'} ${facts.length} 条详细事实：\n${facts.map((fact, index) => `${index + 1}. ${sanitizeUserFacingText(fact.text, [], { preserveLineBreaks: true })}`).join('\n')}`,
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
  const messages = [
    ...useMessageStore.getState().messages,
    ...Object.values(useMessageStore.getState().messageWindowsByChatId).flatMap((window) => window.messages),
  ];
  const resolveServerId = (id: string) => messages.find((message) => message.id === id || message.clientKey === id || message.serverId === id)?.serverId || id;
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
    reportRecoverableWarning({ location: 'memory.fact-sync-pending', error,
      message: '云端分支来源或被合并事实尚不完整，保留本机事实等待后续同步；未跳过证据校验。' });
    return;
  }
  useFactArchiveStore.getState().save(chatId, { ...entry, synced: true });
}

export async function flushFactRecording() { await Promise.all([...tasks.values()]); }

export function recallLocalFacts(actorId: string, destination?: GroupChat, includeMerged = false): RecalledFact[] {
  const chats = useChatStore.getState().chats;
  const archives = useFactArchiveStore.getState().chats;
  const audience = destination ? ['user', ...destination.memberIds] : [actorId];
  return chats.filter((chat) => !chat.deletedAt).flatMap((chat) => {
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
        || !source.audience.includes(actorId) || audience.some((id) => !source.audience.includes(id))
        || recordedSources.get(source.id) !== source.content)) return [];
      return [{ id: `${entry.messageId}:${index}`, text: fact.text, status: fact.status, timestamp: entry.sources.at(-1)?.timestamp || 0, chatId: chat.id,
        ...(fact.mergedFrom ? { mergedFrom: fact.mergedFrom } : {}) }];
    }));
    return includeMerged ? eligible : collapseMergedFacts(eligible);
  });
}

async function ensureArchiveHydrated() {
  if (!useFactArchiveStore.persist.hasHydrated()) await useFactArchiveStore.persist.rehydrate();
}

export async function listDetailedFacts(actorId: string, destination?: GroupChat): Promise<RecalledFact[]> {
  const signal = getWorkspaceSignal();
  await ensureArchiveHydrated();
  await flushFactRecording();
  assertWorkspaceActive(signal);
  if (!cloudMode()) return recallLocalFacts(actorId, destination);
  // A failed save stays retryable. Never mark a checkpoint before durable storage.
  for (const [chatId, archive] of Object.entries(useFactArchiveStore.getState().chats)) {
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
  }
  let response: { items: RecalledFact[] };
  try {
    response = destination
      ? await api.request<{ items: RecalledFact[] }>('POST', `/chats/${encodeURIComponent(destination.id)}/fact-recall`, { actorId })
      : await api.request<{ items: RecalledFact[] }>('POST', `/characters/${encodeURIComponent(actorId)}/fact-archive`, {});
  } catch (error) {
    assertWorkspaceActive(signal);
    if (!(error instanceof ApiError) || error.code !== 'MEMORY_BRANCH_SOURCE_MISSING') throw error;
    reportRecoverableWarning({ location: 'memory.fact-recall-pending', error,
      message: '云端分支来源尚不完整，本轮使用已校验的本机事实，后续读取时重新查询。' });
    return recallLocalFacts(actorId, destination);
  }
  assertWorkspaceActive(signal);
  const localItems = recallLocalFacts(actorId, destination, true);
  const loadedMessages = [...useMessageStore.getState().messages,
    ...Object.values(useMessageStore.getState().messageWindowsByChatId).flatMap((window) => window.messages)];
  const serverId = (id: string) => loadedMessages.find((message) => message.id === id || message.clientKey === id || message.serverId === id)?.serverId || id;
  const canonical = (item: RecalledFact): RecalledFact => {
    const separator = item.id.lastIndexOf(':');
    return { ...item, id: separator < 0 ? item.id : `${serverId(item.id.slice(0, separator))}${item.id.slice(separator)}`,
      ...(item.mergedFrom ? { mergedFrom: item.mergedFrom.map((ref) => ({ ...ref, messageId: serverId(ref.messageId) })) } : {}) };
  };
  return [...new Map(collapseMergedFacts([...response.items, ...localItems].map(canonical)).map((item) => [item.text, item])).values()];
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
