import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConversation } from '../types/chat';
import { DEFAULT_PERSONALITY, normalizeCharacter } from '../types/character';

const mocks = vi.hoisted(() => ({
  updateCharacter: vi.fn(), updateChat: vi.fn(), listAssets: vi.fn(), deleteAsset: vi.fn(),
  characterTask: vi.fn(), chatTask: vi.fn(), imageTask: vi.fn(), authMode: 'local',
}));
vi.mock('../stores/useCharacterStore', () => ({ useCharacterStore: { getState: () => ({ updateCharacter: mocks.updateCharacter }) } }));
vi.mock('../stores/useChatStore', () => ({ useChatStore: { getState: () => ({ updateChat: mocks.updateChat, chats: [chat] }) } }));
vi.mock('../stores/useAuthStore', () => ({ useAuthStore: { getState: () => ({ authMode: mocks.authMode }) } }));
vi.mock('./api', () => ({ api: { listCharacterVisualAssets: mocks.listAssets, deleteCharacterVisualAsset: mocks.deleteAsset } }));
vi.mock('./characterCompletionQueue', () => ({ getCharacterCompletionTaskStatus: mocks.characterTask }));
vi.mock('./chatCompletionQueue', () => ({ getChatCompletionTaskStatus: mocks.chatTask }));
vi.mock('./avatarGenerationQueue', () => ({ avatarGenerationQueue: { getLatestTaskForTarget: mocks.imageTask } }));

import { buildCharacterClearPatch, buildGroupClearPatch, clearCharacterData, clearGroupData } from './batchDataClear';

const character = normalizeCharacter({ id: 'c', name: '角色', avatar: 'avatar.png', personality: DEFAULT_PERSONALITY, expertise: [], speakingStyle: '', background: '', isPreset: false, createdAt: 1, updatedAt: 1 });
const chat = normalizeConversation({ id: 'g', type: 'group', name: '群聊', topic: '主题', groupVisual: { avatarUrl: 'avatar.png', backgroundUrl: 'background.png', backgroundOpacity: 0.2 } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authMode = 'local';
});

describe('batch data clearing', () => {
  it('clears only selected character fields, including bubble references and visual projections', () => {
    expect(buildCharacterClearPatch(['avatar', 'bubble', 'visual'])).toEqual({ avatar: '', bubbleStyle: null, bubbleStyleId: null, visualIdentity: null, visualReferenceImages: [] });
    expect(buildCharacterClearPatch(['base'])).toMatchObject({ background: '', speakingStyle: '', expertise: [], speechProfile: { catchphrases: [] } });
  });

  it('uses serializable empty values for voice, personality and profile', () => {
    const patch = JSON.parse(JSON.stringify(buildCharacterClearPatch(['voice', 'personality', 'profile'])));
    expect(patch.voiceConfig).toEqual({ enabled: false, voiceName: '' });
    expect(Object.values(patch.personality).every((value) => value === 0)).toBe(true);
    expect(Object.values(patch.behavior).every((value) => value === 50)).toBe(true);
    expect(patch.coreProfile.coreDesire).toBe('');
  });

  it('preserves the group avatar when clearing only the background', () => {
    const patch = buildGroupClearPatch(chat, { basics: false, avatar: false, background: true });
    expect(JSON.parse(JSON.stringify(patch))).toEqual({ groupVisual: { avatarUrl: 'avatar.png', backgroundUrl: null } });
  });

  it('writes local character data without calling cloud assets', async () => {
    await clearCharacterData([character], ['visual']);
    expect(mocks.listAssets).not.toHaveBeenCalled();
    expect(mocks.updateCharacter).toHaveBeenCalledWith('c', { visualIdentity: null, visualReferenceImages: [] });
  });

  it('deletes cloud visual assets before updating the synchronized character store', async () => {
    mocks.authMode = 'cloud';
    mocks.listAssets.mockResolvedValue([{ id: 'asset-1' }, { id: 'asset-2' }]);
    await clearCharacterData([character], ['visual']);
    expect(mocks.deleteAsset.mock.calls).toEqual([['c', 'asset-1'], ['c', 'asset-2']]);
    expect(mocks.updateCharacter).toHaveBeenCalledOnce();
    expect(mocks.deleteAsset.mock.invocationCallOrder[1]).toBeLessThan(mocks.updateCharacter.mock.invocationCallOrder[0]);
  });

  it('exposes a cloud deletion failure instead of reporting success', async () => {
    mocks.authMode = 'cloud';
    mocks.listAssets.mockRejectedValue(new Error('offline'));
    await expect(clearCharacterData([character], ['visual'])).rejects.toThrow('offline');
    expect(mocks.updateCharacter).not.toHaveBeenCalled();
  });

  it('blocks clearing when an existing generation could write data back', async () => {
    mocks.characterTask.mockReturnValue('running');
    await expect(clearCharacterData([character], ['avatar'])).rejects.toThrow('生成任务');
    expect(mocks.updateCharacter).not.toHaveBeenCalled();
    mocks.imageTask.mockReturnValue({ status: 'queued' });
    await expect(clearGroupData([chat], { basics: false, avatar: false, background: true })).rejects.toThrow('生成任务');
    expect(mocks.updateChat).not.toHaveBeenCalled();
  });

  it('uses the chat store update path for both local and cloud changes', async () => {
    mocks.authMode = 'cloud';
    await clearGroupData([chat], { basics: true, avatar: false, background: false });
    expect(mocks.updateChat).toHaveBeenCalledWith('g', { name: '', topic: '' });
  });
});
