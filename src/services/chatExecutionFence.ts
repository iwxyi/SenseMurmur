export interface ChatExecutionFence {
  ownerId: string;
  generation: number;
}

const activeFences = new Map<string, ChatExecutionFence>();

export function setChatExecutionFence(chatId: string, fence: ChatExecutionFence) {
  activeFences.set(chatId, fence);
}

export function clearChatExecutionFence(chatId: string, fence: ChatExecutionFence) {
  const current = activeFences.get(chatId);
  if (current?.ownerId === fence.ownerId && current.generation === fence.generation) activeFences.delete(chatId);
}

export function getChatExecutionFence(chatId: string) {
  const fence = activeFences.get(chatId);
  return fence ? { ...fence } : undefined;
}
