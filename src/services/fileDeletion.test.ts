import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';

const mocks = vi.hoisted(() => ({
  cloud: false,
  messages: [] as Message[],
  upsertMessage: vi.fn(), deleteFiles: vi.fn(), updateMessageMetadata: vi.fn(),
}));
vi.mock('./api', () => ({ api: mocks }));
vi.mock('../stores/useAuthStore', () => ({ useAuthStore: { getState: () => ({ authMode: mocks.cloud ? 'cloud' : 'guest' }) } }));
vi.mock('../stores/useMessageStore', () => ({ useMessageStore: { getState: () => ({ messages: [], pendingOperations: [], messageWindowsByChatId: { chat: { messages: mocks.messages } }, upsertMessage: mocks.upsertMessage }) } }));
vi.mock('../stores/useCharacterStore', () => ({ useCharacterStore: { getState: () => ({ characters: [] }) } }));
import { deleteFileItems } from './fileDeletion';

describe('file deletion source handling', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.cloud = false;
    mocks.messages = [{ id: 'message', chatId: 'chat', serverId: 'server-message', metadata: { attachments: [
      { id: 'sticker', kind: 'sticker', status: 'ready', url: 'https://example.test/sticker.gif' },
      { id: 'keep', kind: 'image', status: 'ready', url: 'https://example.test/keep.png' },
    ] } } as Message];
  });
  const item = { id: 'local-message-sticker', messageId: 'message', attachmentId: 'sticker', syncStatus: 'local-only' };
  it('removes local attachments from cached message windows without calling the cloud file API', async () => {
    await deleteFileItems([item]);
    expect(mocks.deleteFiles).not.toHaveBeenCalled();
    expect(mocks.updateMessageMetadata).not.toHaveBeenCalled();
    expect(mocks.upsertMessage.mock.calls[0][0].metadata.attachments.map((a: { id: string }) => a.id)).toEqual(['keep']);
  });
  it('persists remote message metadata before updating the local projection', async () => {
    mocks.cloud = true;
    await deleteFileItems([item]);
    expect(mocks.updateMessageMetadata).toHaveBeenCalledWith('server-message', { attachments: [mocks.messages[0].metadata!.attachments![1]] });
    expect(mocks.upsertMessage).toHaveBeenCalledOnce();
  });
  it('keeps the local attachment when remote persistence fails', async () => {
    mocks.cloud = true; mocks.updateMessageMetadata.mockRejectedValueOnce(new Error('网络错误'));
    await expect(deleteFileItems([item])).rejects.toThrow('网络错误');
    expect(mocks.upsertMessage).not.toHaveBeenCalled();
  });
  it('does not silently delete only the local copy of a cloud message without a sync target', async () => {
    mocks.cloud = true; mocks.messages[0].serverId = undefined;
    await expect(deleteFileItems([item])).rejects.toThrow('消息尚未完成同步');
    expect(mocks.upsertMessage).not.toHaveBeenCalled();
  });
  it('rejects a cloud API response that did not delete the requested file', async () => {
    mocks.deleteFiles.mockResolvedValueOnce({ success: true, deleted: 0 });
    await expect(deleteFileItems([{ id: 'cloud-file' }])).rejects.toThrow('部分文件未删除');
  });
});
