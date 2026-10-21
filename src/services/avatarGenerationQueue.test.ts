import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarGenerationQueue } from './avatarGenerationQueue';
import { generateImageWithAdapter } from './aiGenerationAdapter';
import { api } from './api';
import { initializeWorkspaceLifecycle, stopWorkspace } from './workspaceLifecycle';
import { DEFAULT_AI_PROFILE } from '../types/settings';

vi.mock('./aiGenerationAdapter', () => ({ generateImageWithAdapter: vi.fn() }));
vi.mock('../stores/useCharacterStore', () => ({ useCharacterStore: { getState: () => ({ characters: [{ id: 'character-a' }] }) } }));
vi.mock('../stores/useAuthStore', () => ({ useAuthStore: { getState: vi.fn() } }));
vi.mock('./api', () => ({ api: { updateCharacter: vi.fn() } }));
vi.mock('../utils/avatarUpload', () => ({ prepareAvatarUploadDataUrl: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('avatar queue account cancellation', () => {
  it('settles waiters immediately, drops pending work and ignores a late supplier result', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    const dispose = initializeWorkspaceLifecycle(vi.fn());
    let finish!: (value: Awaited<ReturnType<typeof generateImageWithAdapter>>) => void;
    const image = new Promise<Awaited<ReturnType<typeof generateImageWithAdapter>>>((resolve) => { finish = resolve; });
    vi.mocked(generateImageWithAdapter).mockReturnValue(image);
    try {
      const id = avatarGenerationQueue.enqueue(DEFAULT_AI_PROFILE, 'portrait', { targetKey: 'a', characterId: 'character-a' });
      const queued = avatarGenerationQueue.enqueue(DEFAULT_AI_PROFILE, 'next', { targetKey: 'next' });
      const pending = expect(avatarGenerationQueue.waitForTask(id)).rejects.toThrow();
      const waiting = expect(avatarGenerationQueue.waitForTask(queued)).rejects.toThrow();
      stopWorkspace();
      await Promise.all([pending, waiting]);
      expect(vi.mocked(generateImageWithAdapter).mock.calls[0][0].signal?.aborted).toBe(true);
      expect(avatarGenerationQueue.getSummary().active).toBe(0);
      finish([{ dataUrl: 'data:image/png;base64,AQID', mimeType: 'image/png' }]);
      await image;
      await Promise.resolve();
      expect(generateImageWithAdapter).toHaveBeenCalledTimes(1);
      expect(api.updateCharacter).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
