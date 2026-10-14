import type { Message } from '../types/message';
import { resolveCommittedStreamContent } from './streamingMessageLifecycle';
import { useMessageStore } from '../stores/useMessageStore';
import { compactMessageMetadata } from './messageMetadataCompaction';
import { getNextStreamingDisplayContent, STREAMING_DISPLAY_TICK_MS } from './streamingDisplayBuffer';
import { GenerationCancelledError } from './generationCancellation';

interface PersistLocalFirstMessageParams {
  message: Omit<Message, 'id' | 'timestamp' | 'isDeleted'>;
  upsertMessage: (message: Message) => void;
  onPersisted?: (message: Message) => void;
  timestamp?: number;
  existingLocalMessage?: Message | null;
  deferLocalUpsert?: boolean;
  withdrawalRevealDelayMs?: number;
  localReveal?: boolean;
  localRevealTickMs?: number;
  localRevealStartDelayMs?: number;
  localMessageIdentitySalt?: string;
  delay?: (ms: number) => Promise<void>;
  shouldContinue?: () => boolean;
}

interface PersistLocalFirstMessagesParams {
  messages: Array<{
    message: Omit<Message, 'id' | 'timestamp' | 'isDeleted'>;
    timestamp?: number;
    onPersisted?: (message: Message) => void;
  }>;
  upsertMessages: (messages: Message[]) => void;
  deferLocalUpsert?: boolean;
}


function deferUiWrite(task: () => void) {
  const scheduler = (globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof scheduler === 'function') {
    scheduler(task, { timeout: 300 });
    return;
  }
  setTimeout(task, 0);
}

function writeMessage(upsertMessage: (message: Message) => void, message: Message, deferred?: boolean) {
  if (deferred) {
    deferUiWrite(() => upsertMessage(message));
    return;
  }
  upsertMessage(message);
}

function writeMessages(upsertMessages: (messages: Message[]) => void, messages: Message[], deferred?: boolean) {
  if (!messages.length) return;
  if (deferred) {
    deferUiWrite(() => upsertMessages(messages));
    return;
  }
  upsertMessages(messages);
}

function queueMessageSync(message: Message) {
  useMessageStore.getState().queueMessageSync(message);
}

function delayMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function revealLocalMessage(params: {
  message: Message;
  upsertMessage: (message: Message) => void;
  delay?: (ms: number) => Promise<void>;
  tickMs?: number;
  startDelayMs?: number;
  initialContent?: string;
  keepStreaming?: boolean;
  shouldContinue?: () => boolean;
}) {
  let displayed = params.initialContent || '';
  const wait = params.delay || delayMs;
  params.upsertMessage({ ...params.message, content: displayed, isStreaming: Boolean(params.keepStreaming || displayed !== params.message.content) });
  if (displayed !== params.message.content && params.startDelayMs) await wait(params.startDelayMs);
  while (displayed !== params.message.content) {
    if (params.shouldContinue?.() === false) throw new GenerationCancelledError();
    displayed = getNextStreamingDisplayContent(displayed, params.message.content);
    params.upsertMessage({ ...params.message, content: displayed, isStreaming: Boolean(params.keepStreaming || displayed !== params.message.content) });
    if (displayed !== params.message.content) {
      await wait(params.tickMs ?? STREAMING_DISPLAY_TICK_MS);
    }
  }
}

let streamingLocalMessageSequence = 0;

function stableMessageSeed(parts: Array<string | number | undefined>) {
  const joined = parts.filter((item) => item !== undefined && item !== null && String(item).length > 0).join('|');
  let hash = 0;
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 33 + joined.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function buildPreWithdrawalRevealMessage(message: Message): Message | null {
  const withdrawal = message.metadata?.withdrawal;
  if (!withdrawal?.withdrawn || !withdrawal.originalContent) return null;
  return {
    ...message,
    content: withdrawal.originalContent,
    metadata: {
      ...(message.metadata || {}),
      withdrawal: {
        ...withdrawal,
        visiblePending: true,
      },
    },
  };
}

export function createCommittedLocalMessage(
  message: Omit<Message, 'id' | 'timestamp' | 'isDeleted'>,
  options?: { timestamp?: number; identitySalt?: string },
): Message {
  const timestamp = options?.timestamp ?? Date.now();
  const metadata = compactMessageMetadata(message.metadata, { dropContextText: true });
  const id = `local-message-${timestamp}-${stableMessageSeed([
    message.chatId,
    message.type,
    message.senderId,
    message.senderName,
    message.content,
    message.emotion,
    metadata ? JSON.stringify(metadata) : '',
    options?.identitySalt,
  ])}`;
  return {
    ...message,
    metadata,
    id,
    clientKey: id,
    timestamp,
    isDeleted: false,
    isOptimistic: false,
  };
}

export function createStreamingLocalMessage(
  message: Omit<Message, 'id' | 'timestamp' | 'isDeleted'>,
  options?: { timestamp?: number; identitySalt?: string },
): Message {
  streamingLocalMessageSequence += 1;
  const identitySalt = options?.identitySalt
    || `stream:${streamingLocalMessageSequence}:${Math.random().toString(36).slice(2)}`;
  return createCommittedLocalMessage(message, { ...options, identitySalt });
}

export async function persistLocalFirstMessage(params: PersistLocalFirstMessageParams) {
  const ensureCurrent = () => {
    if (params.shouldContinue?.() === false) throw new GenerationCancelledError();
  };
  ensureCurrent();
  const messageContent = params.existingLocalMessage
    ? resolveCommittedStreamContent(params.message.content, params.existingLocalMessage.content)
    : params.message.content;
  const messagePayload = {
    ...params.message,
    content: messageContent,
    metadata: compactMessageMetadata(params.message.metadata, { dropContextText: true }),
  };
  const localMessage = params.existingLocalMessage
    ? {
        ...params.existingLocalMessage,
        ...messagePayload,
        content: messagePayload.content,
        metadata: messagePayload.metadata,
        emotion: messagePayload.emotion,
        timestamp: params.existingLocalMessage.timestamp,
        isDeleted: false,
        isOptimistic: false,
        isStreaming: false,
      }
    : createCommittedLocalMessage(messagePayload, { timestamp: params.timestamp, identitySalt: params.localMessageIdentitySalt });
  const revealMessage = buildPreWithdrawalRevealMessage(localMessage);
  if (revealMessage) {
    ensureCurrent();
    writeMessage(params.upsertMessage, revealMessage, params.deferLocalUpsert);
    await (params.delay || delayMs)(params.withdrawalRevealDelayMs ?? 1200);
    ensureCurrent();
  }
  if (params.localReveal && !params.deferLocalUpsert && localMessage.content) {
    await revealLocalMessage({
      message: localMessage,
      upsertMessage: params.upsertMessage,
      delay: params.delay,
      tickMs: params.localRevealTickMs,
      startDelayMs: params.localRevealStartDelayMs,
      initialContent: params.existingLocalMessage?.content,
      shouldContinue: params.shouldContinue,
    });
  } else {
    ensureCurrent();
    writeMessage(params.upsertMessage, localMessage, params.deferLocalUpsert);
  }
  ensureCurrent();
  queueMessageSync(localMessage);
  ensureCurrent();
  params.onPersisted?.(localMessage);

  return localMessage;
}

export async function persistLocalFirstMessages(params: PersistLocalFirstMessagesParams) {
  if (!params.messages.length) return [];
  const localMessages = params.messages.map((entry) => createCommittedLocalMessage(entry.message, { timestamp: entry.timestamp }));
  writeMessages(params.upsertMessages, localMessages, params.deferLocalUpsert);
  localMessages.forEach((message, index) => {
    queueMessageSync(message);
    params.messages[index]?.onPersisted?.(message);
  });

  return localMessages;
}


export async function persistStreamingMessage(params: PersistLocalFirstMessageParams) {
  return persistLocalFirstMessage(params);
}

export async function revealMessageInPlace(params: {
  message: Message;
  content: string;
  upsertMessage: (message: Message) => void;
  delay?: (ms: number) => Promise<void>;
  tickMs?: number;
  shouldContinue?: () => boolean;
  initialContent?: string;
  keepStreaming?: boolean;
}) {
  const next = { ...params.message, content: params.content, isStreaming: false };
  await revealLocalMessage({
    message: next,
    upsertMessage: params.upsertMessage,
    delay: params.delay,
    tickMs: params.tickMs,
    shouldContinue: params.shouldContinue,
    initialContent: params.initialContent,
    keepStreaming: params.keepStreaming,
  });
  return next;
}
