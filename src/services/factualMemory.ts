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

export const FACT_EXTRACTION_PROMPT = `你维护角色以后需要查回的少量知识，不是为每条聊天做摘要，也不是更新当前场景进度。一次调用完全不写入是正常结果。
先在心中比较“保存之前”和“保存之后”：日后离开当前话题，有什么已经由对话体现的实际需要，只有记住这条信息才能满足？只有确实带来这种差别的信息才值得保存。能接着聊、还原刚才说了什么、概括人物这次的态度，都不足以构成保存理由。不要为普通话语设想一个原文没有的将来用途。
保存须有正面依据：对话明确需要以后准确查回的知识，或已经体现会持续影响当事人的经历、边界、牵挂、责任。普通场景进度即使明确了明天几点、谁做什么，也不因此成为知识；只有它承担了超出场景衔接的需要（如不可遗忘的精确资料、重要履约后果、个人持续在意）才保存。不要把任何计划都解释成承诺、把礼貌关心都解释成牵挂。小事可以重要，但需有当事人赋予的分量；短期也可重要，但不能仅以时间将至作为理由。例如“明天下午两点陪我签租约，我一个人拿不定主意，过时房东就租给别人，这次一定别忘”有明确求助和失约代价，应保存；“明早城门送行，送完回来汇报练兵”只是当前剧情安排，不保存。
角色扮演中的当前剧情执行细节要更严格：临时带几个人出行、明早送行、谁留守/练兵、回来汇报、谁先到请酒、路上有事捎信，以及对这些话的逐轮回应，通常只是正在演出的场景，不是角色以后需要检索的知识。即使数字明确、多人应承、说“我记下了”，也默认不保存；场景历史已承载这些内容。只有对话明确显示它会跨出当前场景持续影响关系或行为、忘记会造成具体重要后果，或有人明确要求以后准确查回，才越过这道门槛。不要把同一场景里每个角色的复述、确认、打趣各记一遍；没有实质增量就返回空数组。
然后与 existingFacts 比较同一事项。先用已有记录回答上述实际需要，只有仍回答不了的新问题才是有价值的增量。再次同意、换个说法、提醒遵守、表示记住、对同一要求的保证，均不改变原来的知识；即使新消息说得更完整或多了说话人，也应返回 {"facts":[]}。不要把每次复述都当成一次新约定。
只有新事项本身值得保存，或已有事项出现会改变后续使用的实质变化时才输出。实质变化可合并更新；已存事项的泛泛附带细节不为更新而更新。没有独立记忆价值的当场安排由聊天历史承载。输出前再次检查：若不写这条，已有知识是否已经足够？足够就不写。
以以后能独立查用的完整事项为保存单位。若一组清单、分类账目、步骤或条件共同服务于同一个后续用途，先判断整组是否值得记；决定保存后，保留该用途所需的各类明细、数字、单位、对应关系及适用条件，不因追求少量或简短只摘其中一项，也不把明细压成无法还原的总数。可以用一条事实完整记录相关分类；相互独立的用途可分条，不要求每次只记一条。与该用途无关的闲话不必收入。
例如关羽交代路上要照着核账：“路上支用为盘缠十五贯、驿马草料九贯、两处关隘打点四贯，合二十八贯；拜帖礼为绢四匹、茶两担，折十二贯，礼数与盘缠分列”，若决定保存这份路上账目，应保留支用和礼数两类及其明细、分类小计和分列要求；不能只记十二贯礼数或只记总共四十贯。例子说明保存范围，不代表所有报数都值得记。已有事实只记录礼数，之后新消息补充或明确确认整份账目的支用与总额时，应结合所提供的原始上下文保留完整增量；不要因礼数已存就忽略同组其余新增信息，也不要虚构缺失项目。
existingFacts 是当前分支上已保存、且本条消息受众均已知晓的有效记录，来源可以早于最近的上下文，不是新证据。已有事实的同义改写、无信息增量的确认不得再保存，返回 facts=[]。同一事项新增有效条件时，输出一条简洁完整的合并事实，并用 mergeWith 逐字引用被合并记录的 ref（例如 f0），sourceIds 引用新消息及本次新增依据；程序会从合法引用自动继承旧记录的全部来源，无需重复抄写。仅在状态一致且不存在矛盾时合并；不同说法和更正须明确保留，不得以合并删除。合并后新旧来源去重合计不得超过12条，超过时单独记录有价值的新信息，不合并、不删减旧证据。不同事项不要强行合并，不按说话人或句子拆条。
若新消息明确指出已保存记录是误提取、误归属或误解，可用 retracted=true、mergeWith 引用错误记录，text 简述作废对象与依据，status 保持原记录状态，sourceIds 引用本条纠错消息及新增依据，旧来源由程序继承。仅重复提及不作废；事情后来改变、提议被拒绝或有人持不同说法，通过上述记忆价值判断后记录变化或分歧，不能抹去曾发生的事。不要为猜测、模糊指代或缺少信息而删除记录。普通新增或合并省略 retracted。
连续理解上下文：甲说“定个暗号吧”，乙说“青梅煮酒”，甲说“好，下次就用这个”，应记完整的暗号约定及逐字内容，引用三条来源。
以 newMessage 带来的有价值增量为触发点。contextMessages 可用于补全同一事项必需的关联内容，包括前文的分类明细、约定背景、对象和条件；新消息使该事项形成完整约定、获得后续查用价值或新增有效信息时，应将这些相关内容一起保存，并引用实际提供信息的各条消息。不要把“只提取增量”理解为正文只能写新消息中的半句话。与新消息无关的旧事实不另行提取；没有有价值增量的纯重复确认返回 facts=[]，不能仅给旧事实补上新消息引用来重复保存。提议尚未同意用 proposed；明确约定用 agreed；个人陈述用 asserted 并说明是谁说的，不能当作全知事实；冲突用 disputed 保留不同说法。
更正写清旧内容、新内容和更正人。记录只作为角色所知，不替别人确认事实，不推测未公开的动机。个人新增要求用 asserted，不能因关联旧 agreed 就宣称所有人已同意，也不能用 asserted 合并 agreed；仅记录这个有价值的新要求，mergeWith=[]。确有共同确认的新约定才用 agreed，合并时与被引用记录保持同一状态。不要把玩笑、假设、转述或角色扮演内事实升级为现实共识。
重要原话逐字保留，不改写暗号、名字、数字。text 必须独立可读、非空且不超过1200个字符。每条事实的 sourceIds 为1至12个字符串，只能逐字复制 newMessage.id、contextMessages[].id 或被维护的 existingFacts[].sourceIds，不能使用人名或自行编造标识，且每条事实必须含 newMessageId。
例如已有“下次接头暗号为青梅煮酒”，新话“好，我记下了”返回 facts=[]；“暗号改成白马渡江”保留更正；“只在渡口接头时使用”可合并补充适用条件。文本只写承载记忆价值的必要内容，来源引用保留完整证据。
每条事实包含 title、text 和 lifecycle。lifecycle=ongoing 表示离开本场景后仍可能反复查用的知识、关系边界或持续影响；temporary 只用于有明确时效的事项，30天后自动归档且不再自动检索，但用户仍可查看和恢复。没有明确时效性时选 ongoing；不要为了给普通聊天安排续命而标 temporary，是否值得记录的门槛仍然优先。合并更新继承旧生命周期，只有对话明确改变了有效期限时才调整。title 用简短具体的标题概括是谁的什么事项，最多80个字符，例如“关羽赴荆州的支用与拜帖礼账目”；避免“重要事实”“聊天记录”等空泛标题，不添加原文没有的结论。text 是可独立查用的完整正文，标题不能代替正文中的对象、数字、条件或知情局限。合并更新时标题随完整事项调整。
只返回一个合法 JSON 对象：{"facts":[{"title":"具体事项标题","text":"完整事实及知情局限","lifecycle":"ongoing|temporary","status":"asserted|agreed|proposed|disputed","sourceIds":["消息标识"],"mergeWith":["已有记录ref"]}]}，无值得保存的信息时返回空数组；有则按完整事项组织，最多六条，不以减少条数为由漏记有价值的信息。没有合并时 mergeWith=[]。`;

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

function localLifecycle(chatId: string, factId: string) {
  const entries = Object.entries(useFactArchiveStore.getState().chats[chatId]?.lifecycle || {});
  return entries.find(([id]) => canonicalFactId(id) === canonicalFactId(factId))?.[1];
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

async function syncFactLifecycle(chatId: string, factId: string, archived: boolean, archivedAt?: number) {
  const split = factId.lastIndexOf(':');
  try {
    await api.request('POST', `/chats/${encodeURIComponent(chatId)}/fact-archive/lifecycle`, {
      messageId: resolveServerId(factId.slice(0, split)), factIndex: Number(factId.slice(split + 1)), archived, archivedAt,
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

export async function setDetailedFactArchived(fact: RecalledFact, archived: boolean) {
  const signal = getWorkspaceSignal();
  await ensureArchiveHydrated();
  assertWorkspaceActive(signal);
  const archive = useFactArchiveStore.getState().chats[fact.chatId];
  const current = archive?.lifecycle?.[fact.id];
  const archivedAt = archived ? Date.now() : undefined;
  useFactArchiveStore.getState().setLifecycle(fact.chatId, fact.id, archived, archivedAt, false);
  await flushBufferedPersistenceWrites();
  if (cloudMode()) {
    try {
      const synced = await syncFactLifecycle(fact.chatId, fact.id, archived, archivedAt);
      assertWorkspaceActive(signal);
      if (synced) useFactArchiveStore.getState().setLifecycle(fact.chatId, fact.id, archived, archivedAt, true);
    } catch (error) {
      if (current) useFactArchiveStore.getState().setLifecycle(fact.chatId, fact.id, current.archived, current.archivedAt, current.synced);
      else useFactArchiveStore.getState().setLifecycle(fact.chatId, fact.id, !archived, undefined, true);
      await flushBufferedPersistenceWrites();
      throw error;
    }
  }
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
    const factId = `${entry.messageId}:${factIndex}`;
    const lifecycle = localLifecycle(chat.id, factId);
    const expired = fact.lifecycle === 'temporary'
      && Date.now() >= (entry.sources.at(-1)?.timestamp || 0) + 30 * 24 * 60 * 60 * 1000;
    if (lifecycle ? lifecycle.archived : expired) return [];
    const sources = fact.sourceIds.map((id) => nodes.get(id));
    if (sources.some((source) => !source || source.invalid || source.timestamp > anchor.timestamp
      || (anchor.parentNodeId !== undefined ? !active.has(source.nodeId) : Boolean(source.parentNodeId))
      || anchor.audience.some((id) => !source.audience.includes(id))
      || !entry.sources.some((recorded) => recorded.id === source.id && recorded.content === source.content))) return [];
    return [{ id: factId, chatId: chat.id, messageId: entry.messageId, factIndex, fact,
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
      const mergeCandidates = new Map<string, FactMergeCandidate>(existingFacts.map((candidate, index) => [`f${index}`, {
        ...candidate, fact: { ...candidate.fact, lifecycle: candidate.fact.lifecycle || 'ongoing' },
      }]));
      const toInput = ({ id, senderName, content }: FactEvidence) => ({ id, speaker: senderName, content });
      const input = [{ role: 'user' as const, content: JSON.stringify({
        newMessageId: anchorId, newMessage: toInput(sources.find((source) => source.id === anchorId)!),
        contextMessages: sources.filter((source) => source.id !== anchorId).map(toInput),
        existingFacts: [...mergeCandidates].map(([ref, { fact }]) => ({ ref, title: fact.title, text: fact.text, status: fact.status, lifecycle: fact.lifecycle, sourceIds: fact.sourceIds })),
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
            summary: `${changes}详细事实：\n${facts.map((fact, index) => `${index + 1}. ${fact.retracted ? '【作废】' : fact.mergedFrom?.length ? '【合并更新】' : ''}${fact.title ? `${sanitizeUserFacingText(fact.title)}\n` : ''}${sanitizeUserFacingText(fact.text, [], { preserveLineBreaks: true })}`).join('\n')}`,
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

export function recallLocalFacts(actorId?: string, destination?: GroupChat, includeMerged = false, sourceChatId?: string, includeArchived = false): RecalledFact[] {
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
      const lifecycleState = archive.lifecycle?.[`${entry.messageId}:${index}`];
      const archived = lifecycleState ? lifecycleState.archived
        : fact.lifecycle === 'temporary' && Date.now() >= (entry.sources.at(-1)?.timestamp || 0) + 30 * 24 * 60 * 60 * 1000;
      return [{ id: `${entry.messageId}:${index}`, ...(fact.title ? { title: fact.title } : {}), text: fact.text, status: fact.status, timestamp: entry.sources.at(-1)?.timestamp || 0, chatId: chat.id,
        ...(fact.lifecycle ? { lifecycle: fact.lifecycle } : {}),
        ...(lifecycleState?.archivedAt ? { archivedAt: lifecycleState.archivedAt } : {}), archived,
        userDeleted: localDeletion(chat.id, `${entry.messageId}:${index}`)?.deleted,
        knownByIds: sources.reduce<string[]>((ids, source) => ids.filter((id) => source!.audience.includes(id)), sources[0]!.audience),
        ...(fact.retracted ? { retracted: true } : {}),
        ...(fact.mergedFrom ? { mergedFrom: fact.mergedFrom } : {}) }];
    }));
    const visible = includeArchived ? eligible : eligible.filter((fact) => !fact.archived);
    return includeMerged ? visible : collapseMergedFacts(visible);
  });
}

async function ensureArchiveHydrated() {
  if (!useFactArchiveStore.persist.hasHydrated()) await useFactArchiveStore.persist.rehydrate();
}

export async function listDetailedFacts(actorId: string, destination?: GroupChat, includeArchived = false): Promise<RecalledFact[]> {
  return readDetailedFacts({ actorId, destination, includeArchived });
}

export async function listConversationDetailedFacts(chatId: string): Promise<RecalledFact[]> {
  return readDetailedFacts({ sourceChatId: chatId });
}

async function readDetailedFacts({ actorId, destination, sourceChatId, includeArchived = false }: { actorId: string; destination?: GroupChat; sourceChatId?: never; includeArchived?: boolean } | { actorId?: never; destination?: never; sourceChatId: string; includeArchived?: boolean }): Promise<RecalledFact[]> {
  const signal = getWorkspaceSignal();
  await ensureArchiveHydrated();
  await flushFactRecording();
  assertWorkspaceActive(signal);
  const showArchived = Boolean(sourceChatId || includeArchived);
  const localFacts = (includeMerged = false, withArchived = false) => recallLocalFacts(actorId, destination, includeMerged, sourceChatId, withArchived);
  if (!cloudMode()) return localFacts(false, showArchived);
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
    for (const [id, lifecycle] of Object.entries(archive.lifecycle || {})) {
      if (lifecycle.synced) continue;
      try {
        const synced = await syncFactLifecycle(chatId, id, lifecycle.archived, lifecycle.archivedAt);
        if (synced) useFactArchiveStore.getState().setLifecycle(chatId, id, lifecycle.archived, lifecycle.archivedAt, true);
      } catch (error) {
        assertWorkspaceActive(signal);
        reportRecoverableError({ location: 'memory.fact-lifecycle-sync', error,
          userMessage: '部分详细事实归档状态尚未同步，将在下次读取时重试。' });
      }
    }
  }
  let response: { items: RecalledFact[] };
  try {
    response = sourceChatId
      ? await api.request<{ items: RecalledFact[] }>('POST', `/chats/${encodeURIComponent(sourceChatId)}/fact-archive/list`, {})
      : destination
      ? await api.request<{ items: RecalledFact[] }>('POST', `/chats/${encodeURIComponent(destination.id)}/fact-recall`, { actorId })
      : await api.request<{ items: RecalledFact[] }>('POST', `/characters/${encodeURIComponent(actorId!)}/fact-archive`, { includeArchived: showArchived });
  } catch (error) {
    assertWorkspaceActive(signal);
    if (!(error instanceof ApiError) || error.code !== 'MEMORY_BRANCH_SOURCE_MISSING') throw error;
    // Normal outbox ordering can temporarily leave cloud ancestry incomplete.
    return localFacts(false, showArchived);
  }
  assertWorkspaceActive(signal);
  const localItems = localFacts(true, showArchived);
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
    const lifecycle = localLifecycle(item.chatId, item.id);
    const cloud = cloudItems.get(JSON.stringify([item.chatId, item.id]));
    return { ...item,
      userDeleted: deletion && !deletion.synced ? deletion.deleted : cloud?.userDeleted ?? item.userDeleted,
      archived: lifecycle && !lifecycle.synced ? lifecycle.archived : cloud?.archived ?? item.archived,
      ...(lifecycle && !lifecycle.synced && lifecycle.archivedAt ? { archivedAt: lifecycle.archivedAt } : {}),
    };
  });
  return [...new Map(collapseMergedFacts(combined).filter((item) => showArchived || !item.archived).map((item) => [item.text, item])).values()];
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
    + selected.map((fact) => `- ${new Date(fact.timestamp).toISOString()} [${fact.status}] ${fact.title ? `${sanitizeUserFacingText(fact.title)}：` : ''}${sanitizeUserFacingText(fact.text)}`).join('\n');
}
