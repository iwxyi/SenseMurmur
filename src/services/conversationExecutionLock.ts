export function conversationExecutionLockName(scope: string, chatId: string) {
  return `pneumata-conversation-${scope}\n${chatId}`;
}

/** Keep the lock across generation, commit and continuation writes. */
export async function runWithConversationExecutionLock<T>(
  scope: string,
  chatId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks?.request) throw new Error('此浏览器不支持安全的多标签页会话运行');
  return navigator.locks.request(conversationExecutionLockName(scope, chatId), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('此会话已在另一个标签页运行');
    return work();
  });
}
