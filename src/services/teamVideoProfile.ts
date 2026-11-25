import { getUsablePreferredAIProfile, type AIModelProfile } from '../types/settings';
import { useSettingsStore } from '../stores/useSettingsStore';
import { api } from './api';
import { readAuthSnapshot } from './authSnapshot';

export async function resolveTeamVideoProfile(): Promise<AIModelProfile | null> {
  await useSettingsStore.getState().loadSettings();
  const selected = getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'video');
  if (selected) return selected;
  if (readAuthSnapshot().mode !== 'cloud') return null;
  const { items } = await api.getOfficialAiProviders();
  // The public provider endpoint uses `official-ace`; older persisted profiles
  // and some test fixtures use the backend adapter name `official-acedata`.
  // Accept both so an account-level default video model is not lost merely
  // because the provider naming layer differs.
  const ace = items.find((item) => ['official-ace', 'official-acedata'].includes(item.code) && item.accessAllowed !== false);
  const model = ace?.defaultModels?.video || ace?.videoDefaultModel;
  if (!model) return null;
  return { id: 'team-default-video', name: 'ACE 默认视频模型', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model, isDefault: true };
}
