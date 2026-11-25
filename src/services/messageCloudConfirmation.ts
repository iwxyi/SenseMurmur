import type { Message } from '../types/message';
import { useMessageStore } from '../stores/useMessageStore';

type PendingOperation = ReturnType<typeof useMessageStore.getState>['pendingOperations'][number];

function messageMatchesOperation(message: Message, operation: PendingOperation) {
  return operation.kind === 'create' && operation.chatId === message.chatId
    && (operation.localMessageId === message.id || operation.messageId === message.id
      || Boolean(message.clientKey && operation.payload?.clientKey === message.clientKey));
}

function branchParentFailure(message: Message, operations: PendingOperation[]) {
  const parentNodeId = message.metadata?.branching?.parentNodeId;
  if (!parentNodeId) return undefined;
  const parent = operations.find((operation) => operation.kind === 'create' && operation.chatId === message.chatId
    && (operation.payload?.metadata?.branching?.nodeId === parentNodeId || operation.payload?.id === parentNodeId
      || operation.payload?.clientKey === parentNodeId));
  return parent?.status === 'failed' ? parent.lastError || '分支父消息同步失败' : undefined;
}

export function messageCloudConfirmationFailure(message: Message, operations = useMessageStore.getState().pendingOperations) {
  const own = operations.find((operation) => messageMatchesOperation(message, operation));
  if (own?.status === 'failed') return own.lastError || '消息同步失败';
  return branchParentFailure(message, operations);
}

export function waitForMessageCloudConfirmation(params: { chatId: string; messageId: string; signal?: AbortSignal; timeoutMs?: number }) {
  const locate = () => {
    const state = useMessageStore.getState();
    return [...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)]
      .find((message) => message.chatId === params.chatId && (message.id === params.messageId || message.clientKey === params.messageId)) || null;
  };
  return new Promise<Message>((resolve, reject) => {
    let settled = false;
    const finish = (message?: Message, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      params.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (message) resolve(message);
    };
    const inspect = () => {
      const message = locate();
      if (!message) return;
      if (message.serverId) {
        finish(message);
        return;
      }
      const reason = messageCloudConfirmationFailure(message);
      if (reason) finish(undefined, new Error(`聊天消息云端同步失败：${reason}`));
    };
    const onAbort = () => finish(undefined, new Error('聊天消息云端同步等待已中断'));
    const unsubscribe = useMessageStore.subscribe(inspect);
    const timer = setTimeout(() => {
      const message = locate();
      const reason = message ? messageCloudConfirmationFailure(message) : undefined;
      finish(undefined, new Error(reason
        ? `聊天消息云端同步失败：${reason}`
        : '聊天消息云端确认超时；请检查此消息及其分支父消息的同步状态'));
    }, params.timeoutMs ?? 60_000);
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
    else inspect();
  });
}
