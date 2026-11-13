import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_SNAPSHOT_KEY } from './authSnapshot';
import { api } from './api';
import { useSettingsStore } from '../stores/useSettingsStore';
import { resolveTeamVideoProfile } from './teamVideoProfile';

vi.mock('./api', () => ({ api: { getOfficialAiProviders: vi.fn() } }));

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

beforeEach(() => {
  const local = memoryStorage();
  local.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({ version: 1, generation: 'test', token: 'token', refreshToken: null, user: { id: 'user' }, mode: 'cloud' }));
  vi.stubGlobal('localStorage', local);
  useSettingsStore.setState({ aiProfiles: [] });
  vi.mocked(api.getOfficialAiProviders).mockResolvedValue({ items: [{ code: 'official-acedata', name: 'ACE', officialProvider: 'official-acedata', label: 'ACE', family: '官方模型', defaultModel: 'gpt-6-sol', videoDefaultModel: 'doubao-seedance-2-0-fast-260128', accessAllowed: true }] });
});

afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('resolveTeamVideoProfile', () => {
  it('uses the configured profile before the ACE default', async () => {
    const selected = { id: 'chosen', name: 'Chosen', type: 'video' as const, provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true };
    useSettingsStore.setState({ aiProfiles: [selected] });
    await expect(resolveTeamVideoProfile()).resolves.toMatchObject(selected);
    expect(api.getOfficialAiProviders).not.toHaveBeenCalled();
  });

  it('resolves the account-available ACE default when no video profile is configured', async () => {
    await expect(resolveTeamVideoProfile()).resolves.toMatchObject({
      provider: 'official-acedata', type: 'video', model: 'doubao-seedance-2-0-fast-260128',
    });
  });

  it('does not expose the default when ACE is not allowed for the account', async () => {
    vi.mocked(api.getOfficialAiProviders).mockResolvedValue({ items: [{ code: 'official-acedata', name: 'ACE', officialProvider: 'official-acedata', label: 'ACE', family: '官方模型', defaultModel: 'gpt-6-sol', videoDefaultModel: 'doubao-seedance-2-0-fast-260128', accessAllowed: false }] });
    await expect(resolveTeamVideoProfile()).resolves.toBeNull();
  });
});
