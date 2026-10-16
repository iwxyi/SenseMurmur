import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSettingsWithMemory, ThemeMode, ThemePresetId, Language, APIConfig, AIModelProfile, ChatDraftDefaults, DeveloperUIPrefs, AvatarGenerationSettings, AIGenerationSettings, CompanionshipSettings, ChatMemorySettings, UsageStats, ChatAppearanceSettings } from '../types/settings';
import type { ArtifactAppearanceSettings } from '../types/artifactAppearance';

type AppSettings = AppSettingsWithMemory;
import type { BubbleStyleDefinition } from '../types/bubbleStyle';
import { DEFAULT_SETTINGS, DEFAULT_AI_PROFILE, DEFAULT_AVATAR_GENERATION_SETTINGS, DEFAULT_AI_GENERATION_SETTINGS, DEFAULT_COMPANIONSHIP_SETTINGS, DEFAULT_CHAT_MEMORY_SETTINGS, DEFAULT_CHAT_DRAFT_DEFAULTS, DEFAULT_DEVELOPER_UI_PREFS, DEFAULT_USAGE_STATS, DEFAULT_CHAT_APPEARANCE_SETTINGS, getPreferredAIProfile, normalizeAIProfiles, normalizeChatMemorySettings } from '../types/settings';
import { DEFAULT_ARTIFACT_APPEARANCE_SETTINGS, PAPER_SURFACE_VARIANTS } from '../types/artifactAppearance';
import { api, type SyncChangeScope } from '../services/api';
import { buildApiErrorUserMessage } from '../services/apiErrorMessage';
import { reportRecoverableError } from '../services/diagnostics';
import { useAuthStore } from './useAuthStore';
import { CLIENT_STORE_SCHEMA_VERSION, migrateSettingsStoreState } from './storeMigrations';
import { scopedStorageKey } from '../constants/brand';
import { getLocalDataUserId } from '../services/authStorageScope';
import { setAIGenerationRuntimeConfig } from '../services/aiGenerationRuntimeConfig';
import { setCompanionshipRuntimeConfig } from '../services/companionshipRuntimeConfig';
import { setChatMemoryRuntimeConfig } from '../services/chatMemoryRuntimeConfig';
import { setHumanAppraisalRuntimeConfig } from '../services/humanAppraisalRuntimeConfig';
import { isCloudSyncEnabled } from '../services/cloudSyncPreference';
import { createSyncScopeMetadata, type SyncScopeSnapshot } from './syncScopeMetadata';
import { createSyncScheduler } from './storeSyncScheduler';
import { normalizeChatReplyPreferences, type ChatReplyPreferences } from '../types/chatReplyPreferences';

interface SettingsStore extends AppSettings {
  _loaded: boolean;
  developerModeEntitled: boolean;
  lastSyncedAt: number;
  syncStatus: 'idle' | 'saving' | 'saved' | 'error';
  syncError: string | null;
  settingsDirty: boolean;
  memoryUI: { showDeveloperMemory?: boolean };
  setDeveloperMode: (enabled: boolean) => void;
  setAvatarGeneration: (prefs: Partial<AvatarGenerationSettings>) => void;
  setAIGeneration: (prefs: Partial<AIGenerationSettings>) => void;
  setCompanionship: (prefs: Partial<CompanionshipSettings>) => void;
  setChatMemory: (prefs: Partial<ChatMemorySettings>) => void;
  setChatReplyPreferences: (prefs: Partial<ChatReplyPreferences>) => void;
  setChatAppearance: (prefs: Partial<ChatAppearanceSettings>) => void;
  setAutoGenerateCharacterAvatar: (enabled: boolean) => void;
  setDeveloperUI: (prefs: Partial<DeveloperUIPrefs>) => void;
  setMemoryDeveloperView: (enabled: boolean) => void;
  loadSettings: () => Promise<void>;
  refreshDeveloperEntitlement: () => Promise<void>;
  updateApi: (config: Partial<APIConfig>) => void;
  updateAIProfile: (id: string, config: Partial<AIModelProfile>) => void;
  addAIProfile: () => void;
  removeAIProfile: (id: string) => void;
  setTheme: (mode: ThemeMode) => void;
  setThemePreset: (preset: ThemePresetId, primaryColor: string) => void;
  setThemeColor: (color: string) => void;
  setLanguage: (lang: Language) => void;
  setDefaultSpeed: (speed: number) => void;
  setCompactBubbleMode: (enabled: boolean) => void;
  setCompactPrivateBubbleMode: (enabled: boolean) => void;
  setHidePrivateChatIdentity: (enabled: boolean) => void;
  setEnableStreamingDisplayAnimation: (enabled: boolean) => void;
  setShowVoiceTranscript: (enabled: boolean) => void;
  setEnableChatStickers: (enabled: boolean) => void;
  setChatDraftDefaults: (defaults: Partial<ChatDraftDefaults>) => void;
  setCustomBubbleStyles: (styles: BubbleStyleDefinition[]) => void;
  setUserBubbleStyle: (styleId: string | null, style?: BubbleStyleDefinition | null) => void;
  setArtifactAppearance: (appearance: Partial<ArtifactAppearanceSettings>) => void;
  recordAiMessageReceived: (count?: number) => void;
  syncCurrentSettingsToServer: () => Promise<void>;
  refreshSettingsFromCloud: () => Promise<void>;
  getSyncScopeStates: () => SyncScopeSnapshot[];
  resetSettings: () => void;
}

type SettingsSet = (partial: SettingsStore | Partial<SettingsStore> | ((state: SettingsStore) => SettingsStore | Partial<SettingsStore>), replace?: false) => unknown;
type RemoteSettingsPayload = Partial<AppSettings> & {
  autoGenerateCharacterAvatar?: boolean;
  developerModeEntitled?: boolean;
  api?: APIConfig;
  aiProfiles?: AIModelProfile[];
  memoryUI?: { showDeveloperMemory?: boolean };
  usageStats?: UsageStats;
};

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSettingsSyncData: Record<string, unknown> | null = null;
let savedStateTimer: ReturnType<typeof setTimeout> | null = null;
let usageStatsSyncTimer: ReturnType<typeof setTimeout> | null = null;
const SETTINGS_ACCOUNT_SCOPE: SyncChangeScope = 'settings.account';
const settingsSyncScopes = createSyncScopeMetadata(30_000, {
  getStorageKey: () => scopedStorageKey(`settings-sync-scopes-${getLocalDataUserId()}`),
});
const settingsScopeSyncScheduler = createSyncScheduler('settings.scope-refresh', { priority: 10 });
let settingsScopeRequested = false;
let settingsScopeLifecycleRegistered = false;
const DISABLED_DEVELOPER_UI_PREFS: DeveloperUIPrefs = {
  ...DEFAULT_DEVELOPER_UI_PREFS,
  showMemoryDebug: false,
  showRelationshipEvents: false,
  showAffectEvents: false,
  showConflictEvents: false,
  showStateEvents: false,
  showMemoryDistillationEvents: false,
  showCalendarEvents: false,
  showLocalInterceptionHints: false,
  showSpeechStyle: false,
  showAdvancedRuntimePanels: false,
  showDeliberationDebug: false,
  showPresenceDebug: false,
  showCompanionshipDebug: false,
  showMomentDebug: false,
  showWithdrawnMessageContent: false,
  enableHumanAppraisal: false,
  dramaBoost: false,
};

function ensureSettingsScopeLifecycle() {
  if (settingsScopeLifecycleRegistered) return;
  settingsScopeSyncScheduler.registerLifecycle(async () => {
    if (settingsScopeRequested) await useSettingsStore.getState().loadSettings();
  }, 650);
  settingsScopeLifecycleRegistered = true;
}

function clearSavedStateTimer() {
  if (savedStateTimer) {
    clearTimeout(savedStateTimer);
    savedStateTimer = null;
  }
}

function syncToServer(data: Record<string, unknown>, set: SettingsSet) {
  if (syncTimer) clearTimeout(syncTimer);
  pendingSettingsSyncData = data;
  clearSavedStateTimer();
  set((state) => ({ ...state, settingsDirty: true }));
  if (useAuthStore.getState().authMode === 'local' || !isCloudSyncEnabled()) {
    pendingSettingsSyncData = null;
    set((state) => ({ ...state, syncStatus: 'idle', syncError: null }));
    return;
  }
  set((state) => ({ ...state, syncStatus: 'saving', syncError: null }));
  syncTimer = setTimeout(() => {
    const payload = pendingSettingsSyncData || data;
    pendingSettingsSyncData = null;
    api.updateSettings(payload)
      .then(() => {
        set((state) => ({ ...state, settingsDirty: false, syncStatus: 'saved', syncError: null, lastSyncedAt: Date.now() }));
        savedStateTimer = setTimeout(() => {
          set((state) => state.syncStatus === 'saved' ? { ...state, syncStatus: 'idle' } : state);
          savedStateTimer = null;
        }, 1800);
      })
      .catch((err) => {
        reportRecoverableError({
          location: 'cloud-sync:settings-save',
          error: err,
          userMessage: buildApiErrorUserMessage(err, '设置同步'),
        });
        set((state) => ({ ...state, syncStatus: 'error', syncError: err instanceof Error ? err.message : String(err) }));
      });
  }, 500);
}

function syncToServerNow(data: Record<string, unknown>, set: SettingsSet) {
  const pendingData = pendingSettingsSyncData ? { ...pendingSettingsSyncData } : null;
  if ('developerMode' in data || 'developerUI' in data || 'memoryUI' in data) {
    delete pendingData?.developerMode;
    delete pendingData?.developerUI;
    delete pendingData?.memoryUI;
  }
  const payload = pendingData ? { ...pendingData, ...data } : data;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  pendingSettingsSyncData = null;
  clearSavedStateTimer();
  if (useAuthStore.getState().authMode === 'local' || !isCloudSyncEnabled()) {
    set((state) => ({ ...state, syncStatus: 'idle', syncError: null }));
    return;
  }
  set((state) => ({ ...state, syncStatus: 'saving', syncError: null }));
  api.updateSettings(payload)
    .then(() => {
      set((state) => ({ ...state, settingsDirty: false, syncStatus: 'saved', syncError: null, lastSyncedAt: Date.now() }));
      savedStateTimer = setTimeout(() => {
        set((state) => state.syncStatus === 'saved' ? { ...state, syncStatus: 'idle' } : state);
        savedStateTimer = null;
      }, 1800);
    })
    .catch((err) => {
      reportRecoverableError({
        location: 'cloud-sync:settings-save-now',
        error: err,
        userMessage: buildApiErrorUserMessage(err, '设置同步'),
      });
      set((state) => ({ ...state, syncStatus: 'error', syncError: err instanceof Error ? err.message : String(err) }));
    });
}

function syncUsageStatsToServer(usageStats: UsageStats, set: SettingsSet) {
  if (usageStatsSyncTimer) clearTimeout(usageStatsSyncTimer);
  if (useAuthStore.getState().authMode === 'local' || !isCloudSyncEnabled()) return;
  usageStatsSyncTimer = setTimeout(() => {
    api.updateSettings({ usageStats })
      .then(() => {
        set((state) => ({ ...state, syncError: null, lastSyncedAt: Date.now() }));
      })
      .catch((err) => {
        reportRecoverableError({
          location: 'cloud-sync:usage-stats-save',
          error: err,
          userMessage: buildApiErrorUserMessage(err, '使用统计同步'),
        });
        set((state) => ({ ...state, syncError: err instanceof Error ? err.message : String(err) }));
      });
  }, 30_000);
}

function markSettingsLoadedIdle(state: SettingsStore) {
  if (state._loaded && state.syncStatus === 'idle' && state.syncError == null) return state;
  return { ...state, _loaded: true, syncStatus: 'idle' as const, syncError: null };
}

async function probeSettingsChanges() {
  const scopeState = settingsSyncScopes.getState(SETTINGS_ACCOUNT_SCOPE);
  const since = scopeState.cursor ?? scopeState.revision ?? null;
  try {
    return await api.getSyncChanges({ scope: SETTINGS_ACCOUNT_SCOPE, since });
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function settingsFromChanges(changes: Array<Record<string, unknown>> | undefined) {
  if (!changes?.length) return null;
  const change = changes.find((item) => item.entity === 'settings_account' && item.op === 'upsert');
  if (!change || !isRecord(change.patch)) return null;
  return change.patch;
}

function buildApiFromProfiles(aiProfiles: AIModelProfile[]): APIConfig {
  const defaultProfile = getPreferredAIProfile(aiProfiles, 'text') || aiProfiles[0] || DEFAULT_AI_PROFILE;
  return {
    provider: defaultProfile.provider,
    apiKey: defaultProfile.apiKey,
    baseUrl: defaultProfile.baseUrl,
    model: defaultProfile.model,
    maxOutputTokens: defaultProfile.maxOutputTokens,
    advancedOptions: defaultProfile.advancedOptions,
  };
}

export function buildSettingsPayload(state: AppSettings) {
  return {
    api: state.api,
    aiProfiles: state.aiProfiles,
    theme: state.theme,
    themePreset: state.themePreset,
    themeColor: state.themeColor,
    language: state.language,
    defaultSpeed: state.defaultSpeed,
    compactBubbleMode: state.compactBubbleMode,
    compactPrivateBubbleMode: state.compactPrivateBubbleMode,
    hidePrivateChatIdentity: state.hidePrivateChatIdentity,
    enableStreamingDisplayAnimation: state.enableStreamingDisplayAnimation,
    showVoiceTranscript: state.showVoiceTranscript,
    enableChatStickers: state.enableChatStickers,
    chatDraftDefaults: state.chatDraftDefaults,
    customBubbleStyles: state.customBubbleStyles,
    userBubbleStyleId: state.userBubbleStyleId,
    userBubbleStyle: state.userBubbleStyle,
    developerMode: state.developerMode,
    autoGenerateCharacterAvatar: state.avatarGeneration.autoGenerateCharacterAvatar,
    avatarGeneration: state.avatarGeneration,
    aiGeneration: state.aiGeneration,
    companionship: state.companionship,
    chatMemory: state.chatMemory,
    chatReplyPreferences: state.chatReplyPreferences,
    developerUI: state.developerUI,
    memoryUI: state.memoryUI,
    artifactAppearance: state.artifactAppearance,
    chatAppearance: state.chatAppearance,
    usageStats: state.usageStats,
  };
}

function syncState(state: Partial<AppSettings> & { api?: APIConfig; aiProfiles?: AIModelProfile[]; memoryUI?: { showDeveloperMemory?: boolean }; developerModeEntitled?: boolean }): Partial<AppSettings> & { developerModeEntitled: boolean } {
  const aiProfiles = normalizeAIProfiles(state.aiProfiles, state.api);
  const legacyShowMemoryDebug = Boolean(state.memoryUI?.showDeveloperMemory);
  const hasDeveloperModeEntitlementSignal = state.developerModeEntitled !== undefined;
  const developerModeEntitled = state.developerModeEntitled === true;
  const developerModeAllowed = !hasDeveloperModeEntitlementSignal || developerModeEntitled;
  const developerUI = developerModeAllowed
    ? {
        ...DEFAULT_DEVELOPER_UI_PREFS,
        ...(state.developerUI || {}),
        showMemoryDebug: state.developerUI?.showMemoryDebug ?? legacyShowMemoryDebug,
      }
    : DISABLED_DEVELOPER_UI_PREFS;
  const normalized = {
    ...state,
    developerModeEntitled,
    themePreset: normalizeThemePreset(state.themePreset),
    aiProfiles,
    api: buildApiFromProfiles(aiProfiles),
    developerMode: developerModeAllowed && Boolean(state.developerMode),
    enableStreamingDisplayAnimation: state.enableStreamingDisplayAnimation !== false,
    enableChatStickers: state.enableChatStickers !== false,
    avatarGeneration: {
      ...DEFAULT_AVATAR_GENERATION_SETTINGS,
      ...(state.avatarGeneration || {}),
      autoGenerateCharacterAvatar: state.avatarGeneration?.autoGenerateCharacterAvatar ?? Boolean((state as { autoGenerateCharacterAvatar?: boolean }).autoGenerateCharacterAvatar),
      preferNonPhotorealAvatar: state.avatarGeneration?.preferNonPhotorealAvatar ?? false,
    },
    aiGeneration: {
      ...DEFAULT_AI_GENERATION_SETTINGS,
      ...(state.aiGeneration || {}),
      enableMoments: state.aiGeneration?.enableMoments ?? DEFAULT_AI_GENERATION_SETTINGS.enableMoments,
      enableDiaries: state.aiGeneration?.enableDiaries ?? DEFAULT_AI_GENERATION_SETTINGS.enableDiaries,
    },
    companionship: {
      ...DEFAULT_COMPANIONSHIP_SETTINGS,
      ...(state.companionship || {}),
      proactiveCooldownMinutes: {
        ...DEFAULT_COMPANIONSHIP_SETTINGS.proactiveCooldownMinutes,
        ...(state.companionship?.proactiveCooldownMinutes || {}),
      },
      ritualKindToggles: {
        ...DEFAULT_COMPANIONSHIP_SETTINGS.ritualKindToggles,
        ...(state.companionship?.ritualKindToggles || {}),
      },
      quietHours: {
        ...DEFAULT_COMPANIONSHIP_SETTINGS.quietHours,
        ...(state.companionship?.quietHours || {}),
      },
    },
    chatMemory: normalizeChatMemorySettings(state.chatMemory || DEFAULT_CHAT_MEMORY_SETTINGS),
    chatReplyPreferences: normalizeChatReplyPreferences(state.chatReplyPreferences),
    developerUI,
    memoryUI: {
      showDeveloperMemory: developerModeAllowed && (state.developerUI?.showMemoryDebug ?? legacyShowMemoryDebug),
    },
    chatDraftDefaults: {
      ...DEFAULT_CHAT_DRAFT_DEFAULTS,
      ...(state.chatDraftDefaults || {}),
      runtimeEvolutionIntensity: state.chatDraftDefaults?.runtimeEvolutionIntensity || DEFAULT_CHAT_DRAFT_DEFAULTS.runtimeEvolutionIntensity,
    },
    customBubbleStyles: Array.isArray(state.customBubbleStyles) ? state.customBubbleStyles : [],
    userBubbleStyleId: typeof state.userBubbleStyleId === 'string' ? state.userBubbleStyleId : null,
    userBubbleStyle: state.userBubbleStyle || null,
    artifactAppearance: {
      ...DEFAULT_ARTIFACT_APPEARANCE_SETTINGS,
      ...(state.artifactAppearance || {}),
      paperVariant: PAPER_SURFACE_VARIANTS.includes(state.artifactAppearance?.paperVariant || 'lined')
        ? state.artifactAppearance?.paperVariant || DEFAULT_ARTIFACT_APPEARANCE_SETTINGS.paperVariant
        : DEFAULT_ARTIFACT_APPEARANCE_SETTINGS.paperVariant,
    },
    chatAppearance: {
      ...DEFAULT_CHAT_APPEARANCE_SETTINGS,
      ...(state.chatAppearance || {}),
      maxContentWidth: Math.max(560, Math.min(1080, Math.round(Number(state.chatAppearance?.maxContentWidth || DEFAULT_CHAT_APPEARANCE_SETTINGS.maxContentWidth)))),
      maxContentWidthUnlimited: Boolean(state.chatAppearance?.maxContentWidthUnlimited),
      voiceWaveformStyle: ['wave', 'blocks', 'neon', 'spectrum', 'pulse', 'orbit', 'ribbon', 'echo', 'constellation', 'helix', 'comet'].includes(state.chatAppearance?.voiceWaveformStyle || '')
        ? state.chatAppearance?.voiceWaveformStyle as ChatAppearanceSettings['voiceWaveformStyle']
        : DEFAULT_CHAT_APPEARANCE_SETTINGS.voiceWaveformStyle,
      storyReader: {
        ...DEFAULT_CHAT_APPEARANCE_SETTINGS.storyReader,
        ...(state.chatAppearance?.storyReader || {}),
        fontSize: Math.max(14, Math.min(22, Number(state.chatAppearance?.storyReader?.fontSize || DEFAULT_CHAT_APPEARANCE_SETTINGS.storyReader.fontSize))),
        lineHeight: Math.max(1.55, Math.min(2.45, Number(state.chatAppearance?.storyReader?.lineHeight || DEFAULT_CHAT_APPEARANCE_SETTINGS.storyReader.lineHeight))),
        revealMode: state.chatAppearance?.storyReader?.revealMode === 'instant' ? 'instant' as const : 'fade' as const,
      },
    },
    usageStats: {
      ...DEFAULT_USAGE_STATS,
      ...(state.usageStats || {}),
      aiMessageCount: Math.max(0, Math.floor(Number(state.usageStats?.aiMessageCount || 0))),
      updatedAt: Math.max(0, Number(state.usageStats?.updatedAt || 0)),
    },
  };
  setAIGenerationRuntimeConfig(normalized.aiGeneration);
  setCompanionshipRuntimeConfig(normalized.companionship);
  setChatMemoryRuntimeConfig(normalized.chatMemory);
  setHumanAppraisalRuntimeConfig({ enabled: normalized.developerUI.enableHumanAppraisal });
  return normalized;
}

function normalizeThemePreset(preset: unknown): ThemePresetId {
  return preset === 'rednote'
    || preset === 'jade'
    || preset === 'reader'
    || preset === 'imperial'
    || preset === 'night'
    || preset === 'mirage'
    || preset === 'aurora'
    || preset === 'paper'
    || preset === 'sakura'
    || preset === 'ember'
    || preset === 'graphite'
    || preset === 'dopamine'
    || preset === 'morandi'
    ? preset
    : DEFAULT_SETTINGS.themePreset;
}

function createProfile(index: number): AIModelProfile {
  return {
    ...DEFAULT_AI_PROFILE,
    id: `profile-${Date.now()}-${index}`,
    name: `Model ${index + 1}`,
    isDefault: false,
    audioCapability: undefined,
  };
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      _loaded: false,
      developerModeEntitled: false,
      lastSyncedAt: 0,
      syncStatus: 'idle',
      syncError: null,
      settingsDirty: false,

      loadSettings: async () => {
        settingsScopeRequested = true;
        ensureSettingsScopeLifecycle();
        // 本地持久化状态先行：调用方无需等待云端请求即可渲染。
        set(markSettingsLoadedIdle);
        if (useAuthStore.getState().authMode === 'local' || !isCloudSyncEnabled()) {
          return;
        }
        try {
          const hasLocalSettings = get()._loaded || get().lastSyncedAt > 0;
          if (hasLocalSettings && settingsSyncScopes.isFresh(SETTINGS_ACCOUNT_SCOPE)) {
            set(markSettingsLoadedIdle);
            return;
          }
          const changeProbe = hasLocalSettings ? await probeSettingsChanges() : null;
          if (changeProbe?.status === 'not_modified') {
            settingsSyncScopes.markChecked(SETTINGS_ACCOUNT_SCOPE, {
              cursor: changeProbe.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
              applied: false,
            });
            set(markSettingsLoadedIdle);
            return;
          }
          const settings = (settingsFromChanges(changeProbe?.changes) || await api.getSettings()) as RemoteSettingsPayload;
          settingsSyncScopes.markChecked(SETTINGS_ACCOUNT_SCOPE, {
            cursor: changeProbe?.cursor,
                  revision: changeProbe?.revision,
                  fresh: !changeProbe?.hasMore,
            applied: true,
          });
          if (get().settingsDirty) {
            void get().syncCurrentSettingsToServer();
            return;
          }
          set({
            ...syncState({
              api: settings.api as APIConfig,
              aiProfiles: settings.aiProfiles as AIModelProfile[] | undefined,
              theme: settings.theme as ThemeMode,
              themePreset: settings.themePreset as ThemePresetId | undefined,
              themeColor: settings.themeColor,
              language: settings.language as Language,
              defaultSpeed: settings.defaultSpeed,
              developerModeEntitled: settings.developerModeEntitled === true,
              developerMode: settings.developerMode,
              avatarGeneration: {
                ...DEFAULT_AVATAR_GENERATION_SETTINGS,
                ...((settings as { avatarGeneration?: AvatarGenerationSettings }).avatarGeneration || {}),
                autoGenerateCharacterAvatar: ((settings as { avatarGeneration?: AvatarGenerationSettings }).avatarGeneration?.autoGenerateCharacterAvatar)
                  ?? Boolean((settings as { autoGenerateCharacterAvatar?: boolean }).autoGenerateCharacterAvatar),
              },
              aiGeneration: {
                ...DEFAULT_AI_GENERATION_SETTINGS,
                ...((settings as { aiGeneration?: AIGenerationSettings }).aiGeneration || {}),
              },
              companionship: {
                ...DEFAULT_COMPANIONSHIP_SETTINGS,
                ...((settings as { companionship?: CompanionshipSettings }).companionship || {}),
                proactiveCooldownMinutes: {
                  ...DEFAULT_COMPANIONSHIP_SETTINGS.proactiveCooldownMinutes,
                  ...((settings as { companionship?: CompanionshipSettings }).companionship?.proactiveCooldownMinutes || {}),
                },
                quietHours: {
                  ...DEFAULT_COMPANIONSHIP_SETTINGS.quietHours,
                  ...((settings as { companionship?: CompanionshipSettings }).companionship?.quietHours || {}),
                },
              },
              chatMemory: normalizeChatMemorySettings((settings as { chatMemory?: ChatMemorySettings }).chatMemory),
              chatReplyPreferences: normalizeChatReplyPreferences(settings.chatReplyPreferences),
              developerUI: settings.developerUI as DeveloperUIPrefs | undefined,
              memoryUI: settings.memoryUI as { showDeveloperMemory?: boolean } | undefined,
              chatDraftDefaults: {
                ...DEFAULT_CHAT_DRAFT_DEFAULTS,
                ...((settings.chatDraftDefaults || DEFAULT_CHAT_DRAFT_DEFAULTS) as ChatDraftDefaults),
              },
              customBubbleStyles: settings.customBubbleStyles as BubbleStyleDefinition[] | undefined,
              userBubbleStyleId: typeof settings.userBubbleStyleId === 'string' ? settings.userBubbleStyleId : null,
              userBubbleStyle: (settings.userBubbleStyle as BubbleStyleDefinition | null | undefined) || null,
              artifactAppearance: (settings as { artifactAppearance?: ArtifactAppearanceSettings }).artifactAppearance,
              chatAppearance: (settings as { chatAppearance?: ChatAppearanceSettings }).chatAppearance,
              usageStats: (settings as { usageStats?: UsageStats }).usageStats,
            }),
            settingsDirty: false,
            _loaded: true,
            lastSyncedAt: Date.now(),
            syncStatus: 'idle',
            syncError: null,
          });
        } catch (error) {
          settingsSyncScopes.markError(SETTINGS_ACCOUNT_SCOPE, error);
          reportRecoverableError({
            location: 'cloud-sync:settings-load',
            error,
            userMessage: buildApiErrorUserMessage(error, '设置加载'),
          });
          set({ _loaded: true, syncStatus: 'error', syncError: error instanceof Error ? error.message : String(error) });
        }
      },

      refreshDeveloperEntitlement: async () => {
        if (useAuthStore.getState().authMode === 'local') return;
        try {
          const remote = await api.getSettings();
          if (remote.developerModeEntitled === undefined) {
            set((state) => ({ ...state, syncError: null }));
            return;
          }
          set((state) => {
            const developerModeEntitled = remote.developerModeEntitled === true;
            if (state.syncStatus === 'saving') {
              return developerModeEntitled
                ? { ...state, developerModeEntitled: true, syncError: null }
                : {
                    ...state,
                    developerModeEntitled: false,
                    developerMode: false,
                    memoryUI: { showDeveloperMemory: false },
                    syncError: null,
                  };
            }
            return {
              ...state,
              developerModeEntitled,
              developerMode: developerModeEntitled && Boolean(state.developerMode),
              memoryUI: { showDeveloperMemory: developerModeEntitled && Boolean(state.developerUI.showMemoryDebug) },
              syncError: null,
            };
          });
        } catch (error) {
          reportRecoverableError({
            location: 'settings:developer-entitlement-refresh',
            error,
            userMessage: buildApiErrorUserMessage(error, '开发者权限刷新'),
          });
        }
      },

      updateApi: (config) => {
        set((state) => {
          const nextApi = { ...state.api, ...config };
          const nextProfiles = [...state.aiProfiles];
          nextProfiles[0] = { ...nextProfiles[0], ...nextApi, id: nextProfiles[0].id || 'default' };
          const next = { ...(syncState({ ...state, api: nextApi, aiProfiles: nextProfiles }) as SettingsStore), lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      updateAIProfile: (id, config) => {
        set((state) => {
          const targetProfile = state.aiProfiles.find((profile) => profile.id === id);
          const nextType = config.type || targetProfile?.type || 'text';
          const shouldBecomeDefault = config.isDefault === true
            || (!!config.type && !state.aiProfiles.some((profile) => profile.id !== id && (profile.type || 'text') === nextType));

          const nextProfiles = state.aiProfiles.map((profile) => {
            if (profile.id === id) {
              return {
                ...profile,
                ...config,
                id: profile.id,
                type: nextType,
                isDefault: shouldBecomeDefault ? true : (config.isDefault === false ? false : profile.isDefault),
              };
            }

            if (shouldBecomeDefault && (profile.type || 'text') === nextType) {
              return {
                ...profile,
                isDefault: false,
              };
            }

            return profile;
          });
          const next = { ...(syncState({ ...state, aiProfiles: nextProfiles }) as SettingsStore), lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      addAIProfile: () => {
        set((state) => {
          const nextProfile = createProfile(state.aiProfiles.length);
          const typeCount = state.aiProfiles.filter((profile) => (profile.type || 'text') === nextProfile.type).length;
          if (typeCount === 0) {
            nextProfile.isDefault = true;
          }
          const nextProfiles = [...state.aiProfiles, nextProfile];
          const next = { ...(syncState({ ...state, aiProfiles: nextProfiles }) as SettingsStore), lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      removeAIProfile: (id) => {
        set((state) => {
          const filtered = state.aiProfiles.filter((profile) => profile.id !== id);
          const nextProfiles = filtered.length > 0 ? filtered : [DEFAULT_AI_PROFILE];
          const next = { ...(syncState({ ...state, aiProfiles: nextProfiles }) as SettingsStore), lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setDeveloperMode: (developerMode) => {
        set((state) => {
          const authState = useAuthStore.getState();
          const developerModeDenied = authState.authMode === 'cloud' && authState.user?.developerModeEntitled === false;
          const developerModeAvailable = !developerModeDenied && (state.developerMode || state.developerModeEntitled || authState.user?.developerModeEntitled === true);
          const nextDeveloperMode = developerModeAvailable && developerMode;
          const next = {
            ...state,
            developerModeEntitled: state.developerModeEntitled || authState.user?.developerModeEntitled === true,
            developerMode: nextDeveloperMode,
            memoryUI: { showDeveloperMemory: nextDeveloperMode && Boolean(state.developerUI.showMemoryDebug) },
            lastSyncedAt: Date.now(),
          };
          syncToServerNow({ developerMode: nextDeveloperMode }, set);
          return next;
        });
      },

      setAvatarGeneration: (prefs) => {
        set((state) => {
          const next = {
            ...state,
            avatarGeneration: {
              ...state.avatarGeneration,
              ...prefs,
            },
            lastSyncedAt: Date.now(),
          };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setAIGeneration: (prefs) => {
        set((state) => {
          const next = {
            ...state,
            aiGeneration: {
              ...state.aiGeneration,
              ...prefs,
            },
            lastSyncedAt: Date.now(),
          };
          setAIGenerationRuntimeConfig(next.aiGeneration);
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setCompanionship: (prefs) => {
        set((state) => {
          const nextCompanionship = {
            ...state.companionship,
            ...prefs,
            proactiveCooldownMinutes: {
              ...state.companionship.proactiveCooldownMinutes,
              ...(prefs.proactiveCooldownMinutes || {}),
            },
            ritualKindToggles: {
              ...state.companionship.ritualKindToggles,
              ...(prefs.ritualKindToggles || {}),
            },
            quietHours: {
              ...state.companionship.quietHours,
              ...(prefs.quietHours || {}),
            },
          };
          const next = {
            ...state,
            companionship: nextCompanionship,
            lastSyncedAt: Date.now(),
          };
          setCompanionshipRuntimeConfig(nextCompanionship);
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setChatMemory: (prefs) => {
        set((state) => {
          const chatMemory = normalizeChatMemorySettings({
            ...state.chatMemory,
            ...prefs,
          });
          const next = {
            ...state,
            chatMemory,
            lastSyncedAt: Date.now(),
          };
          setChatMemoryRuntimeConfig(chatMemory);
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setChatReplyPreferences: (prefs) => {
        set((state) => {
          const next = {
            ...state,
            chatReplyPreferences: normalizeChatReplyPreferences({ ...state.chatReplyPreferences, ...prefs }),
            lastSyncedAt: Date.now(),
          };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setChatAppearance: (prefs) => {
        set((state) => {
          const next = {
            ...state,
            chatAppearance: {
              ...state.chatAppearance,
              ...prefs,
              storyReader: {
                ...state.chatAppearance.storyReader,
                ...(prefs.storyReader || {}),
              },
            },
            lastSyncedAt: Date.now(),
          };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setAutoGenerateCharacterAvatar: (autoGenerateCharacterAvatar) => {
        set((state) => {
          const next = {
            ...state,
            avatarGeneration: {
              ...state.avatarGeneration,
              autoGenerateCharacterAvatar,
            },
            lastSyncedAt: Date.now(),
          };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setDeveloperUI: (prefs) => {
        set((state) => {
          const authState = useAuthStore.getState();
          const developerModeDenied = authState.authMode === 'cloud' && authState.user?.developerModeEntitled === false;
          const developerModeAvailable = !developerModeDenied && (state.developerMode || state.developerModeEntitled || authState.user?.developerModeEntitled === true);
          const developerModeEntitled = state.developerModeEntitled || authState.user?.developerModeEntitled === true;
          const developerUI = developerModeAvailable ? { ...DEFAULT_DEVELOPER_UI_PREFS, ...state.developerUI, ...prefs } : DISABLED_DEVELOPER_UI_PREFS;
          setHumanAppraisalRuntimeConfig({ enabled: developerUI.enableHumanAppraisal });
          const next = {
            ...state,
            developerModeEntitled,
            developerUI,
            memoryUI: { showDeveloperMemory: developerUI.showMemoryDebug },
            lastSyncedAt: Date.now(),
          };
          syncToServerNow({ developerUI: next.developerUI, memoryUI: next.memoryUI }, set);
          return next;
        });
      },

      setMemoryDeveloperView: (enabled) => {
        set((state) => {
          const authState = useAuthStore.getState();
          const developerModeDenied = authState.authMode === 'cloud' && authState.user?.developerModeEntitled === false;
          const developerModeAvailable = !developerModeDenied && (state.developerMode || state.developerModeEntitled || authState.user?.developerModeEntitled === true);
          const developerModeEntitled = state.developerModeEntitled || authState.user?.developerModeEntitled === true;
          const developerUI = developerModeAvailable ? { ...DEFAULT_DEVELOPER_UI_PREFS, ...state.developerUI, showMemoryDebug: enabled } : DISABLED_DEVELOPER_UI_PREFS;
          const next = {
            ...state,
            developerModeEntitled,
            developerUI,
            memoryUI: { showDeveloperMemory: developerModeAvailable && enabled },
            lastSyncedAt: Date.now(),
          };
          syncToServerNow({ developerUI: next.developerUI, memoryUI: next.memoryUI }, set);
          return next;
        });
      },

      setTheme: (theme) => {
        set((state) => {
          const next = { ...state, theme, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setThemePreset: (themePreset, primaryColor) => {
        set((state) => {
          const next = { ...state, themePreset: normalizeThemePreset(themePreset), themeColor: primaryColor, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setThemeColor: (themeColor) => {
        set((state) => {
          const next = { ...state, themeColor, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setLanguage: (language) => {
        localStorage.setItem(scopedStorageKey('language'), language);
        set((state) => {
          const next = { ...state, language, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setDefaultSpeed: (defaultSpeed) => {
        set((state) => {
          const next = { ...state, defaultSpeed, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setCompactBubbleMode: (compactBubbleMode) => {
        set((state) => {
          const next = { ...state, compactBubbleMode, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setCompactPrivateBubbleMode: (compactPrivateBubbleMode) => {
        set((state) => {
          const next = { ...state, compactPrivateBubbleMode, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setHidePrivateChatIdentity: (hidePrivateChatIdentity) => {
        set((state) => {
          const next = { ...state, hidePrivateChatIdentity, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setEnableStreamingDisplayAnimation: (enableStreamingDisplayAnimation) => {
        set((state) => {
          const next = { ...state, enableStreamingDisplayAnimation, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setShowVoiceTranscript: (showVoiceTranscript) => {
        set((state) => {
          const next = { ...state, showVoiceTranscript, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setEnableChatStickers: (enableChatStickers) => {
        set((state) => {
          const next = { ...state, enableChatStickers, lastSyncedAt: Date.now() };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setChatDraftDefaults: (defaults) => {
        set((state) => {
          const next = {
            ...state,
            lastSyncedAt: Date.now(),
            chatDraftDefaults: {
              ...state.chatDraftDefaults,
              ...defaults,
            },
          };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setCustomBubbleStyles: (customBubbleStyles) => {
        set((state) => {
          const next = {
            ...state,
            customBubbleStyles,
            lastSyncedAt: Date.now(),
          };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setUserBubbleStyle: (userBubbleStyleId, userBubbleStyle = null) => {
        set((state) => {
          const next = {
            ...state,
            userBubbleStyleId,
            userBubbleStyle,
            lastSyncedAt: Date.now(),
          };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      setArtifactAppearance: (artifactAppearance) => {
        set((state) => {
          const next = {
            ...state,
            artifactAppearance: {
              ...state.artifactAppearance,
              ...artifactAppearance,
            },
            lastSyncedAt: Date.now(),
          };
          syncToServer(buildSettingsPayload(next), set);
          return next;
        });
      },

      recordAiMessageReceived: (count = 1) => {
        if (!Number.isFinite(count) || count <= 0) return;
        set((state) => {
          const usageStats = {
            ...DEFAULT_USAGE_STATS,
            ...state.usageStats,
            aiMessageCount: Math.max(0, Math.floor(Number(state.usageStats?.aiMessageCount || 0))) + Math.floor(count),
            updatedAt: Date.now(),
          };
          const next = {
            ...state,
            usageStats,
            lastSyncedAt: Date.now(),
          };
          syncUsageStatsToServer(usageStats, set);
          return next;
        });
      },

      syncCurrentSettingsToServer: async () => {
        if (useAuthStore.getState().authMode === 'local' || !isCloudSyncEnabled()) {
          set((state) => ({ ...state, syncStatus: 'idle', syncError: null }));
          return;
        }
        const current = useSettingsStore.getState();
        await api.updateSettings(buildSettingsPayload(current));
        set((state) => ({ ...state, settingsDirty: false, syncStatus: 'saved', syncError: null, lastSyncedAt: Date.now() }));
      },
      refreshSettingsFromCloud: async () => {
        settingsSyncScopes.clear(SETTINGS_ACCOUNT_SCOPE);
        await get().loadSettings();
      },
      getSyncScopeStates: () => settingsSyncScopes.listStates(),

      resetSettings: () => {
        const next = { ...(syncState(DEFAULT_SETTINGS) as SettingsStore), lastSyncedAt: Date.now() };
        set(next);
        syncToServer(buildSettingsPayload(next), set);
      },
    }),
    {
      name: scopedStorageKey('settings'),
      version: CLIENT_STORE_SCHEMA_VERSION,
      migrate: (persistedState) => migrateSettingsStoreState(persistedState as Partial<SettingsStore>) as SettingsStore,
      partialize: (state) => ({
        api: state.api,
        aiProfiles: state.aiProfiles,
        theme: state.theme,
        themePreset: state.themePreset,
        themeColor: state.themeColor,
        language: state.language,
        defaultSpeed: state.defaultSpeed,
        compactBubbleMode: state.compactBubbleMode,
        compactPrivateBubbleMode: state.compactPrivateBubbleMode,
        hidePrivateChatIdentity: state.hidePrivateChatIdentity,
        enableStreamingDisplayAnimation: state.enableStreamingDisplayAnimation,
        showVoiceTranscript: state.showVoiceTranscript,
        enableChatStickers: state.enableChatStickers,
        developerMode: state.developerMode,
        avatarGeneration: state.avatarGeneration,
        aiGeneration: state.aiGeneration,
        companionship: state.companionship,
        chatMemory: state.chatMemory,
        chatReplyPreferences: state.chatReplyPreferences,
        developerUI: state.developerUI,
        memoryUI: state.memoryUI,
        chatDraftDefaults: state.chatDraftDefaults,
        customBubbleStyles: state.customBubbleStyles,
        userBubbleStyleId: state.userBubbleStyleId,
        userBubbleStyle: state.userBubbleStyle,
        artifactAppearance: state.artifactAppearance,
        chatAppearance: state.chatAppearance,
        settingsDirty: state.settingsDirty,
        usageStats: state.usageStats,
      }),
      merge: (persistedState, currentState) => {
        const currentSettings: Partial<SettingsStore> = { ...currentState };
        const persistedSettings = { ...((persistedState || {}) as Partial<SettingsStore>) };
        delete currentSettings.developerModeEntitled;
        delete persistedSettings.developerModeEntitled;
        return {
          ...currentState,
          ...syncState({ ...(currentSettings as AppSettings), ...(persistedSettings as Partial<AppSettings>) }),
        };
      },
    }
  )
);

ensureSettingsScopeLifecycle();
