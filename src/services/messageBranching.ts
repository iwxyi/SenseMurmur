import type { GroupChat, MessageBranchState } from '../types/chat';
import type { Message, MessageMetadata } from '../types/message';

export interface ResolvedBranchingNode {
  message: Message;
  nodeId: string;
  parentNodeId: string | null;
  parentNodeExplicit: boolean;
  rootNodeId: string;
  sequence: number;
  revisionRootId: string;
  revisionOfMessageId: string | null;
}

export interface MessageBranchVersionInfo {
  rootId: string;
  index: number;
  total: number;
  isActive: boolean;
  activeNodeId: string;
  nodeIds: string[];
}

const DISABLED_SCENARIO_IDS = new Set(['story-reader', 'werewolf-classic', 'murder-mystery', 'board-game']);
const DISABLED_MODES = new Set(['scripted_play', 'werewolf', 'murder_mystery', 'board_game']);
const missingParentLogKeys = new Set<string>();

type BranchableChat = Pick<GroupChat, 'sessionKind' | 'messageBranchState'> & Partial<Pick<GroupChat, 'mode' | 'id'>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getBranchingMetadata(message: Message): NonNullable<MessageMetadata['branching']> | null {
  const branching = message.metadata?.branching;
  return isRecord(branching) ? branching as NonNullable<MessageMetadata['branching']> : null;
}

function stableMessageId(message: Message) {
  return message.clientKey || message.id;
}

function createProvisionalNodeId() {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  const randomId = typeof cryptoApi?.randomUUID === 'function' ? cryptoApi.randomUUID() : Math.random().toString(36).slice(2);
  return `node-${Date.now()}-${randomId}`;
}

function compareNodeOrder(left: ResolvedBranchingNode, right: ResolvedBranchingNode) {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  if (left.message.timestamp !== right.message.timestamp) return left.message.timestamp - right.message.timestamp;
  return left.nodeId.localeCompare(right.nodeId);
}

function compareMessageOrder(left: Message, right: Message) {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

function normalizeId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBranchState(state: MessageBranchState | null | undefined): MessageBranchState {
  return {
    enabled: state?.enabled,
    activeBranchName: state?.activeBranchName || 'main',
    refs: state?.refs || {},
    stateVersion: state?.stateVersion || 0,
    activeLeafNodeId: state?.activeLeafNodeId ?? null,
    activeChildByParentNodeId: state?.activeChildByParentNodeId || {},
    selectedRevisionByRootId: state?.selectedRevisionByRootId || {},
    updatedAt: state?.updatedAt,
  };
}

export function isMessageBranchingEnabled(chat: BranchableChat | null | undefined) {
  if (!chat) return false;
  if (chat.messageBranchState?.enabled === false) return false;
  // v2 state is an explicit opt-in. Do not require a scenario id here:
  // ordinary direct/group chats can also have editable AI/user branches.
  // The previous scenario-only gate caused the renderer to fall back to the
  // full message array, making every sibling revision appear simultaneously.
  if (chat.messageBranchState?.enabled === true) {
    const scenarioId = chat.sessionKind?.scenarioId;
    if (scenarioId && DISABLED_SCENARIO_IDS.has(scenarioId)) return false;
    if (chat.mode && DISABLED_MODES.has(chat.mode)) return false;
    return true;
  }
  const scenarioId = chat.sessionKind?.scenarioId;
  if (!scenarioId) return false;
  if (DISABLED_SCENARIO_IDS.has(scenarioId)) return false;
  if (chat.mode && DISABLED_MODES.has(chat.mode)) return false;
  return true;
}

function resolveNode(message: Message): ResolvedBranchingNode {
  const metadata = getBranchingMetadata(message);
  const nodeId = normalizeId(metadata?.nodeId) || stableMessageId(message);
  const parentNodeId = normalizeId(metadata?.parentNodeId);
  const rootNodeId = normalizeId(metadata?.rootNodeId) || nodeId;
  const sequence = typeof metadata?.sequence === 'number' && Number.isFinite(metadata.sequence)
    ? metadata.sequence
    : message.timestamp;
  const revisionOfMessageId = normalizeId(metadata?.revisionOfNodeId) || normalizeId(metadata?.revisionOfMessageId);
  return {
    message,
    nodeId,
    parentNodeId,
    parentNodeExplicit: Boolean(metadata && Object.prototype.hasOwnProperty.call(metadata, 'parentNodeId')),
    rootNodeId,
    sequence,
    revisionRootId: rootNodeId,
    revisionOfMessageId,
  };
}

export function resolveMessageBranchNodes(messages: Message[]) {
  const nodes = messages.filter((message) => !message.isDeleted).map(resolveNode);
  const aliases = new Map<string, string>();
  for (const node of nodes) {
    aliases.set(node.nodeId, node.nodeId);
    aliases.set(node.message.id, node.nodeId);
    if (node.message.clientKey) aliases.set(node.message.clientKey, node.nodeId);
    if (node.message.serverId) aliases.set(node.message.serverId, node.nodeId);
  }
  return nodes.map((node) => ({
    ...node,
    parentNodeId: node.parentNodeId ? aliases.get(node.parentNodeId) || node.parentNodeId : null,
    rootNodeId: aliases.get(node.rootNodeId) || node.rootNodeId,
    revisionRootId: aliases.get(node.revisionRootId) || node.revisionRootId,
    revisionOfMessageId: node.revisionOfMessageId ? aliases.get(node.revisionOfMessageId) || node.revisionOfMessageId : null,
  }));
}

function nodeLookup(nodes: ResolvedBranchingNode[]) {
  const map = new Map<string, ResolvedBranchingNode>();
  for (const node of nodes) {
    map.set(node.nodeId, node);
    map.set(node.message.id, node);
    if (node.message.clientKey) map.set(node.message.clientKey, node);
    if (node.message.serverId) map.set(node.message.serverId, node);
  }
  return map;
}

function defaultHead(nodes: ResolvedBranchingNode[]) {
  return nodes.slice().sort(compareNodeOrder).at(-1)?.nodeId || null;
}

function getActiveHeadNodeId(chat: BranchableChat | null | undefined, nodes: ResolvedBranchingNode[]) {
  const state = normalizeBranchState(chat?.messageBranchState);
  const activeRef = state.refs?.[state.activeBranchName || 'main'];
  return normalizeId(activeRef?.headNodeId) || normalizeId(state.activeLeafNodeId) || defaultHead(nodes);
}

export function buildBranchStateWithHead(
  state: MessageBranchState | null | undefined,
  headNodeId: string | null,
  branchName?: string,
): MessageBranchState {
  const current = normalizeBranchState(state);
  const name = branchName || current.activeBranchName || 'main';
  const now = Date.now();
  const existing = current.refs?.[name];
  return {
    ...current,
    enabled: true,
    activeBranchName: name,
    refs: {
      ...(current.refs || {}),
      [name]: {
        name,
        headNodeId,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        version: (existing?.version || 0) + 1,
      },
    },
    activeLeafNodeId: headNodeId,
    stateVersion: (current.stateVersion || 0) + 1,
    updatedAt: now,
  };
}

export function forkBranchState(
  state: MessageBranchState | null | undefined,
  headNodeId: string | null,
  branchName: string,
): MessageBranchState {
  const current = normalizeBranchState(state);
  const now = Date.now();
  return {
    ...current,
    refs: {
      ...(current.refs || {}),
      [branchName]: {
        name: branchName,
        headNodeId,
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
    },
    stateVersion: (current.stateVersion || 0) + 1,
    updatedAt: now,
  };
}

export function projectActiveBranchMessages(
  chat: BranchableChat | null | undefined,
  messages: Message[],
  options?: { fallbackMessages?: Message[] },
) {
  const visible = messages.filter((message) => !message.isDeleted);
  if (!isMessageBranchingEnabled(chat)) return visible.slice().sort(compareMessageOrder);
  // Some older/seeded chats may carry an enabled branch flag without any
  // branch metadata on their messages. Treat those as ordinary timelines;
  // otherwise the default head (the latest message) would make every other
  // historical message disappear from the conversation.
  const branchingMessageCount = visible.filter((message) => isRecord(message.metadata?.branching)).length;
  // A single branch-marked message is not enough evidence to hide an ordinary
  // timeline. This occurs when a sync window contains one newer message but
  // older messages/metadata have not arrived yet.
  if (branchingMessageCount <= 1 && visible.length > branchingMessageCount
    && !visible.some((message) => getBranchingMetadata(message)?.revisionOfNodeId || getBranchingMetadata(message)?.revisionOfMessageId)) {
    return visible.slice().sort(compareMessageOrder);
  }
  const nodes = resolveMessageBranchNodes(visible);
  if (!nodes.length) return [];
  const byId = nodeLookup(nodes);
  const headId = getActiveHeadNodeId(chat, nodes);
  if (!headId) return [];

  const path: ResolvedBranchingNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null = headId;
  let failure: string | null = null;
  while (cursor) {
    if (seen.has(cursor)) {
      failure = 'cycle';
      break;
    }
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) {
      failure = path.length ? 'parent-not-loaded' : 'head-not-loaded';
      break;
    }
    path.push(node);
    cursor = node.parentNodeId;
  }
  // Exclude known alternative paths, even when the retained window lacks a
  // common ancestor. Independent severed roots are not assumed to be revisions.
  const pathIds = new Set(path.map((node) => node.nodeId));
  const pathParents = new Set(path.map((node) => node.parentNodeId).filter((id): id is string => Boolean(id)));
  const replacedIds = new Set(path.map((node) => node.revisionOfMessageId).filter((id): id is string => Boolean(id)));
  const excluded = new Set<string>();
  for (const node of nodes) {
    if (pathIds.has(node.nodeId)) continue;
    if ((node.parentNodeId && (pathIds.has(node.parentNodeId) || pathParents.has(node.parentNodeId)))
      || (node.revisionOfMessageId && pathIds.has(node.revisionOfMessageId))
      || replacedIds.has(node.nodeId)) excluded.add(node.nodeId);
  }
  const state = normalizeBranchState(chat?.messageBranchState);
  for (const [name, ref] of Object.entries(state.refs || {})) {
    if (name === state.activeBranchName) continue;
    let other = ref.headNodeId ? byId.get(ref.headNodeId) : undefined;
    const visited = new Set<string>();
    while (other && !pathIds.has(other.nodeId) && !excluded.has(other.nodeId) && !visited.has(other.nodeId)) {
      visited.add(other.nodeId);
      other = other.parentNodeId ? byId.get(other.parentNodeId) : undefined;
    }
    // A missing active ancestor may also be the shared prefix of another ref.
    // Only discard its loaded path once the divergence can be established.
    if (!failure || (other && (pathIds.has(other.nodeId) || excluded.has(other.nodeId)))) {
      for (const nodeId of visited) excluded.add(nodeId);
    }
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of nodes) {
      if (!pathIds.has(node.nodeId) && !excluded.has(node.nodeId)
        && node.parentNodeId && excluded.has(node.parentNodeId)) {
        excluded.add(node.nodeId);
        expanded = true;
      }
    }
  }
  const oldestPathNode = path.at(-1);
  // Opening messages and runtime events can be written outside the reply
  // chain. They are timeline entries, not evidence of a severed branch.
  const timelineIds = new Set(nodes.filter((node) => !isRecord(node.message.metadata?.branching)
    && !excluded.has(node.nodeId)
    && (node.message.type === 'event'
      || (oldestPathNode && compareMessageOrder(node.message, oldestPathNode.message) < 0)))
    .map((node) => node.nodeId));
  if (!failure && oldestPathNode && isRecord(oldestPathNode.message.metadata?.branching)
    && nodes.some((node) => !pathIds.has(node.nodeId) && !excluded.has(node.nodeId) && !timelineIds.has(node.nodeId)
      && compareMessageOrder(node.message, oldestPathNode.message) < 0)) failure = 'disconnected-history';
  if (failure) {
    const liveIds = new Set(messages.flatMap((message) => [message.id, stableMessageId(message), resolveMessageNodeId(message)]));
    const fallback = [
      ...(options?.fallbackMessages || []).filter((message) => message.chatId === visible[0]?.chatId
        && !message.isDeleted && !liveIds.has(message.id) && !liveIds.has(resolveMessageNodeId(message))),
      ...visible,
    ].filter((message) => !excluded.has(resolveMessageNodeId(message))).sort(compareMessageOrder);
    const logKey = `${chat?.id || visible[0]?.chatId}:${headId}:${failure}:${cursor}:${nodes.length}:${fallback.length}`;
    if (!missingParentLogKeys.has(logKey)) {
      missingParentLogKeys.add(logKey);
      if (missingParentLogKeys.size > 200) missingParentLogKeys.delete(missingParentLogKeys.values().next().value as string);
      console.error('[message-branch:projection-fallback]', {
        reason: failure, loadedMessages: visible.length, ancestorMessages: path.length,
        fallbackMessages: fallback.length, excludedAlternatives: excluded.size,
        head: headId.slice(-12), missingNode: cursor?.slice(-12) || null,
        windowBoundaryPossible: failure === 'parent-not-loaded',
        activeBranch: state.activeBranchName,
        graph: nodes.slice(-40).map((node) => ({
          node: node.nodeId.slice(-12), parent: node.parentNodeId?.slice(-12) || null,
          type: node.message.type, streaming: Boolean(node.message.isStreaming),
          timestamp: node.message.timestamp, onActivePath: pathIds.has(node.nodeId),
          excluded: excluded.has(node.nodeId), revisionOf: node.revisionOfMessageId?.slice(-12) || null,
        })),
      });
    }
    return fallback;
  }
  path.reverse();
  if (!timelineIds.size) return path.map((node) => node.message);
  return nodes.filter((node) => pathIds.has(node.nodeId) || timelineIds.has(node.nodeId))
    .map((node) => node.message).sort(compareMessageOrder);
}

export function getActiveBranchTail(chat: BranchableChat | null | undefined, messages: Message[]) {
  return projectActiveBranchMessages(chat, messages).at(-1) || null;
}

export function getActiveBranchTailNode(chat: BranchableChat | null | undefined, messages: Message[]) {
  const tail = getActiveBranchTail(chat, messages);
  if (!tail) return null;
  return resolveMessageBranchNodes(messages).find((node) => node.message.id === tail.id || node.nodeId === tail.id) || null;
}

export function attachMessageToActiveBranch<const T extends { metadata?: MessageMetadata } & Record<string, unknown>>(
  chat: Pick<GroupChat, 'messageBranchState' | 'sessionKind'> | null | undefined,
  activeMessages: Message[],
  message: T,
): Omit<T, 'metadata'> & { metadata?: MessageMetadata } {
  if (!isMessageBranchingEnabled(chat)) return message;
  if (
    message.metadata?.branching?.parentNodeId !== undefined
    && typeof message.metadata.branching.nodeId === 'string'
    && message.metadata.branching.nodeId.trim()
  ) return message;
  const nodes = resolveMessageBranchNodes(activeMessages);
  const headId = getActiveHeadNodeId(chat, nodes);
  const parent = headId ? nodeLookup(nodes).get(headId) : null;
  const existingBranching = message.metadata?.branching;
  const parentNodeId = typeof existingBranching?.parentNodeId === 'string' || existingBranching?.parentNodeId === null
    ? existingBranching.parentNodeId
    : (parent?.nodeId || headId || null);
  const rootNodeId = typeof existingBranching?.rootNodeId === 'string'
    ? existingBranching.rootNodeId
    : (parent?.rootNodeId || undefined);
  const maxSequence = nodes.reduce((max, node) => Math.max(max, node.sequence), 0);
  const nodeId = stableMessageId(message as unknown as Message) || createProvisionalNodeId();
  return {
    ...message,
    metadata: {
      ...(message.metadata || {}),
      branching: {
        ...(message.metadata?.branching || {}),
        nodeId,
        parentNodeId,
        rootNodeId: rootNodeId || nodeId,
        sequence: maxSequence + 1,
      },
    } as MessageMetadata,
  };
}

export function getBranchRevisionGroup(messages: Message[], messageId: string) {
  const nodes = resolveMessageBranchNodes(messages);
  const target = nodeLookup(nodes).get(messageId);
  if (!target) return [];
  const siblings = nodes
    .filter((node) => node.parentNodeId === target.parentNodeId)
    .sort(compareNodeOrder);
  // A shared parent alone does not make revisions. Root-level messages (and
  // ordinary sequential messages after a legacy/imported node) naturally
  // share a null parent. Only an explicit revision link can turn siblings
  // into a switchable revision group.
  const hasRevisionLink = siblings.some((node) => (
    Boolean(node.revisionOfMessageId)
    && siblings.some((candidate) => candidate.nodeId === node.revisionOfMessageId)
  ));
  return hasRevisionLink ? siblings.map((node) => node.message) : [];
}

export function buildMessageBranchVersionInfoByMessageId(
  chat: BranchableChat | null | undefined,
  messages: Message[],
  messageIds?: string[],
) {
  const nodes = resolveMessageBranchNodes(messages);
  const byId = nodeLookup(nodes);
  const activeIds = new Set(projectActiveBranchMessages(chat, messages).flatMap((message) => [message.id, message.clientKey, message.serverId].filter((value): value is string => Boolean(value))));
  const requested = messageIds?.length ? messageIds : messages.map((message) => message.id);
  const result: Record<string, MessageBranchVersionInfo> = {};
  for (const requestedId of requested) {
    const target = byId.get(requestedId);
    if (!target) continue;
    const siblings = getBranchRevisionGroup(messages, target.nodeId)
      .map((message) => byId.get(resolveMessageNodeId(message)))
      .filter((node): node is ResolvedBranchingNode => Boolean(node));
    if (siblings.length < 2) continue;
    const index = siblings.findIndex((node) => node.nodeId === target.nodeId);
    const activeHead = getActiveHeadNodeId(chat, nodes) || '';
    result[requestedId] = {
      rootId: target.parentNodeId || target.rootNodeId,
      index: index + 1,
      total: siblings.length,
      isActive: activeIds.has(target.message.id) || Boolean(target.message.clientKey && activeIds.has(target.message.clientKey)),
      activeNodeId: activeHead,
      nodeIds: siblings.map((node) => node.nodeId),
    };
  }
  return result;
}

export function getMessageBranchVersionInfo(chat: BranchableChat | null | undefined, messages: Message[], messageId: string) {
  return buildMessageBranchVersionInfoByMessageId(chat, messages, [messageId])[messageId] || null;
}

export function createMessageRevisionDraft(params: {
  sourceMessage: Message;
  parentNodeId: string | null;
  content: string;
  timestamp?: number;
  senderId?: string;
  senderName?: string;
  emotion?: number;
  metadata?: MessageMetadata;
  nodeId?: string;
  revisionRootId?: string | null;
}) {
  const source = getBranchingMetadata(params.sourceMessage);
  const nodeId = params.nodeId || `${stableMessageId(params.sourceMessage)}-revision-${Date.now()}`;
  const rootNodeId = params.revisionRootId || normalizeId(source?.rootNodeId) || normalizeId(source?.nodeId) || stableMessageId(params.sourceMessage);
  const branching = {
    ...(params.metadata?.branching || {}),
    nodeId,
    parentNodeId: params.parentNodeId,
    rootNodeId,
    sequence: Date.now(),
    revisionOfNodeId: normalizeId(source?.nodeId) || stableMessageId(params.sourceMessage),
  };
  return {
    chatId: params.sourceMessage.chatId,
    type: params.sourceMessage.type,
    senderId: params.senderId || params.sourceMessage.senderId,
    senderName: params.senderName || params.sourceMessage.senderName,
    content: params.content,
    metadata: { ...(params.metadata || {}), branching } as MessageMetadata,
    emotion: typeof params.emotion === 'number' ? params.emotion : params.sourceMessage.emotion,
    timestamp: typeof params.timestamp === 'number' ? params.timestamp : Date.now(),
  };
}

export function getRevisionSiblingIndex(chat: BranchableChat | null | undefined, messages: Message[], messageId: string) {
  const info = getMessageBranchVersionInfo(chat, messages, messageId);
  return info ? `${info.index}/${info.total}` : null;
}

export function resolveMessageNodeId(message: Message) {
  return normalizeId(getBranchingMetadata(message)?.nodeId) || stableMessageId(message);
}
