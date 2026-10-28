import type { Message } from '../types/message';
import { api } from './api';
import { useAuthStore } from '../stores/useAuthStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useCharacterStore } from '../stores/useCharacterStore';

export interface DeletableFile {
  id: string;
  syncStatus?: string;
  messageId?: string;
  attachmentId?: string;
  characterId?: string;
}

export async function deleteFileItems(items: DeletableFile[]) {
  const messageState = useMessageStore.getState();
  const messages = new Map<string, Message>([
    ...Object.values(messageState.messageWindowsByChatId).flatMap(window => window.messages),
    ...messageState.messages,
  ].map(message => [message.id, message]));
  const cloudIds: string[] = [];
  const messageRemovals = new Map<string, Set<string>>();
  const characterRemovals = new Map<string, Set<string>>();
  for (const item of items) {
    const message = item.messageId ? messages.get(item.messageId) : undefined;
    const attachment = message?.metadata?.attachments?.find(value => value.id === item.attachmentId);
    if (attachment && !attachment.assetId && item.id === `local-${message!.id}-${attachment.id}`) {
      const ids = messageRemovals.get(message!.id) || new Set<string>();
      ids.add(attachment.id);
      messageRemovals.set(message!.id, ids);
    } else if (item.syncStatus === 'local-only' && item.characterId) {
      const character = useCharacterStore.getState().characters.find(value => value.id === item.characterId);
      const reference = character?.visualIdentity?.referenceImages?.find(value => value.id === item.id && !value.assetId);
      if (!reference) throw new Error('素材已变化，请刷新后重试');
      const ids = characterRemovals.get(item.characterId) || new Set<string>();
      ids.add(reference.id);
      characterRemovals.set(item.characterId, ids);
    } else {
      cloudIds.push(item.id);
    }
  }
  // A local projection identifier must never be sent as a cloud storage ID.
  for (let start = 0; start < cloudIds.length; start += 100) {
    const batch = cloudIds.slice(start, start + 100);
    const result = await api.deleteFiles(batch);
    if (!result.success || result.deleted !== new Set(batch).size) throw new Error('部分文件未删除，请刷新后重试');
  }
  for (const [messageId, ids] of messageRemovals) {
    const current = messages.get(messageId)!;
    const attachments = current.metadata?.attachments?.filter(attachment => !ids.has(attachment.id)) || [];
    if (useAuthStore.getState().authMode === 'cloud') {
      if (current.serverId) {
        await api.updateMessageMetadata(current.serverId, { attachments });
      } else if (!messageState.pendingOperations.some(operation => operation.kind === 'create' && (
        operation.localMessageId === current.id || operation.payload?.clientKey === (current.clientKey || current.id)
      ))) {
        throw new Error('消息尚未完成同步，请同步后重试删除');
      }
    }
    messageState.upsertMessage({ ...current, metadata: { ...current.metadata, attachments } }, { replaceAttachments: true });
  }
  for (const [characterId, ids] of characterRemovals) {
    const state = useCharacterStore.getState();
    const character = state.characters.find(value => value.id === characterId)!;
    const visualIdentity = character.visualIdentity!;
    await state.updateCharacter(characterId, { visualIdentity: {
      ...visualIdentity,
      referenceImages: visualIdentity.referenceImages?.filter(reference => !ids.has(reference.id)),
      primaryReferenceImageId: visualIdentity.primaryReferenceImageId && ids.has(visualIdentity.primaryReferenceImageId)
        ? null : visualIdentity.primaryReferenceImageId,
    } });
  }
}
