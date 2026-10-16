export type SettingsTabKey = 'general' | 'models' | 'chat' | 'plugins';

export type SettingsCardKey =
  | 'account'
  | 'local-workspace'
  | 'advanced'
  | 'models'
  | 'appearance'
  | 'ai-generation'
  | 'companionship'
  | 'chat-memory'
  | 'chat-reply-preferences'
  | 'chat-defaults'
  | 'data'
  | 'about'
  | 'plugins';

export const SETTINGS_TAB_KEYS: SettingsTabKey[] = ['general', 'models', 'chat', 'plugins'];

const SETTINGS_CARD_TAB_MAP: Partial<Record<SettingsCardKey, SettingsTabKey>> = {
  account: 'general',
  'local-workspace': 'general',
  advanced: 'general',
  appearance: 'general',
  data: 'general',
  about: 'general',
  models: 'models',
  'ai-generation': 'chat',
  companionship: 'chat',
  'chat-memory': 'chat',
  'chat-reply-preferences': 'chat',
  'chat-defaults': 'chat',
  plugins: 'plugins',
};

export function resolveSettingsTab(value: string | null): SettingsTabKey {
  return SETTINGS_TAB_KEYS.includes(value as SettingsTabKey) ? value as SettingsTabKey : 'general';
}

export function buildSettingsPath(options: { tab?: SettingsTabKey; card?: SettingsCardKey | string } = {}) {
  const params = new URLSearchParams();
  if (options.tab) params.set('tab', options.tab);
  if (options.card) params.set('card', options.card);
  const search = params.toString();
  return `/settings${search ? `?${search}` : ''}`;
}

export function getSettingsTabForCard(card: string | null | undefined): SettingsTabKey | null {
  if (!card) return null;
  return SETTINGS_CARD_TAB_MAP[card as SettingsCardKey] ?? null;
}
