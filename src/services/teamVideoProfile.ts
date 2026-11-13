import { getUsablePreferredAIProfile, type AIModelProfile } from '../types/settings';
import { useSettingsStore } from '../stores/useSettingsStore';
import { api } from './api';
import { readAuthSnapshot } from './authSnapshot';

export async function resolveTeamVideoProfile(): Promise<AIModelProfile | null> {
  const selected = getUsablePreferredAIProfile(useSettingsStore.getState().aiProfiles, 'video');
  if (selected) return selected;
  if (readAuthSnapshot().mode !== 'cloud') return null;
  const { items } = await api.getOfficialAiProviders();
  const ace = items.find((item) => item.code === 'official-acedata' && item.accessAllowed !== false);
  const model = ace?.defaultModels?.video || ace?.videoDefaultModel;
  if (!model) return null;
  return { id: 'team-default-video', name: 'ACE 默认视频模型', type: 'video', provider: ace.code, apiKey: '', baseUrl: '/api/ai', model, isDefault: true };
}
