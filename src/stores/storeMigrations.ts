import type { AICharacter, CharacterRelationshipPreset } from '../types/character';
import { normalizeCharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import { toRelationshipLedgerRecentEvent } from '../types/runtimeEvent';
import { DEFAULT_ARTIFACT_APPEARANCE_SETTINGS, PAPER_SURFACE_VARIANTS } from '../types/artifactAppearance';
import { DEFAULT_CHAT_APPEARANCE_SETTINGS, DEFAULT_DEVELOPER_UI_PREFS, DEFAULT_SETTINGS, normalizeChatMemorySettings } from '../types/settings';

type VersionedPersistedState<T> = T | undefined;

export const CLIENT_STORE_SCHEMA_VERSION = 6;
export const MESSAGE_BRANCH_SCHEMA_VERSION = 2;

function clampRelationshipMetric(value: unknown, min: number, max: number) {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(min, Math.min(max, safeValue));
}

function migrateRelationshipPreset(input: CharacterRelationshipPreset): CharacterRelationshipPreset {
  return {
    ...input,
    warmth: clampRelationshipMetric(input.warmth, -100, 100),
    competence: clampRelationshipMetric(input.competence, -100, 100),
    trust: clampRelationshipMetric(input.trust, -100, 100),
    threat: clampRelationshipMetric(input.threat, 0, 100),
  };
}

function hasText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasArrayItems(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function hasRecordDetail(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).some((item) => (
    hasText(item)
    || hasArrayItems(item)
    || (item && typeof item === 'object' && !Array.isArray(item) && hasRecordDetail(item))
  ));
}

function inferLegacyCharacterDetailLoaded(input: AICharacter) {
  if (typeof input.characterDetailLoaded === 'boolean') return input.characterDetailLoaded;
  return Boolean(
    hasText(input.background)
    || hasText(input.speakingStyle)
    || hasArrayItems(input.relationships)
    || hasArrayItems(input.layeredMemories)
    || hasArrayItems(input.runtimeTimeline)
    || hasRecordDetail(input.memory)
    || hasRecordDetail(input.coreProfile)
    || hasRecordDetail(input.soulState)
    || hasRecordDetail(input.emotionalState)
    || hasRecordDetail(input.behavior)
    || hasRecordDetail(input.intervention)
  );
}

function migrateCharacter(input: AICharacter): AICharacter {
  return normalizeCharacter({
    ...input,
    relationships: (input.relationships || []).map(migrateRelationshipPreset),
    characterDetailLoaded: inferLegacyCharacterDetailLoaded(input),
  });
}

function migrateRoomCohesion(input: unknown) {
  const value = typeof input === 'number' && Number.isFinite(input) ? input : 0;
  return Math.max(-100, Math.min(100, value - 50));
}

function inferLegacyChatRuntimeDetailLoaded(input: GroupChat) {
  if (input.runtimeDetailLoaded === false) return false;
  return Boolean(
    hasText(input.topicSeed)
    || hasArrayItems(input.layeredMemories)
    || hasArrayItems(input.runtimeTimeline)
    || hasArrayItems(input.runtimeEventsV2)
    || hasArrayItems(input.relationshipLedger)
    || hasArrayItems(input.growthSnapshots)
    || hasRecordDetail(input.runtimeSeed)
  );
}

function migrateChat(input: GroupChat): GroupChat {
  const structuredRoomState = input.worldState?.structuredRoomState
    ? {
        ...input.worldState.structuredRoomState,
        cohesion: migrateRoomCohesion(input.worldState.structuredRoomState.cohesion),
      }
    : input.worldState?.structuredRoomState;
  const legacyBranchState = input.messageBranchState;
  const branchState = legacyBranchState && !legacyBranchState.refs?.main
    ? {
        ...legacyBranchState,
        activeBranchName: 'main',
        refs: {
          main: {
            name: 'main',
            headNodeId: legacyBranchState.activeLeafNodeId || null,
            createdAt: input.createdAt || Date.now(),
            updatedAt: legacyBranchState.updatedAt || input.updatedAt || Date.now(),
            version: 1,
          },
        },
        stateVersion: 1,
      }
    : legacyBranchState;
  return {
    ...input,
    memberIds: Array.isArray(input.memberIds) ? input.memberIds : [],
    governance: {
      ownerCharacterId: input.governance?.ownerCharacterId || null,
      adminCharacterIds: Array.isArray(input.governance?.adminCharacterIds) ? input.governance.adminCharacterIds : [],
      autoModeration: Boolean(input.governance?.autoModeration),
      allowMute: input.governance?.allowMute ?? true,
      allowPrivateThreads: input.governance?.allowPrivateThreads ?? true,
    },
    dramaRules: {
      allowCliques: Boolean(input.dramaRules?.allowCliques),
      allowMockery: Boolean(input.dramaRules?.allowMockery),
      allowAlliances: input.dramaRules?.allowAlliances ?? true,
      allowContempt: input.dramaRules?.allowContempt ?? false,
    },
    relationshipLedger: (input.relationshipLedger || []).map((entry) => ({
      ...entry,
      recentEvents: (entry.recentEvents || []).map((event) => toRelationshipLedgerRecentEvent({
        id: typeof event?.id === 'string' ? event.id : '',
        kind: event?.kind,
        createdAt: typeof event?.createdAt === 'number' ? event.createdAt : 0,
        summary: typeof event?.summary === 'string' ? event.summary : '',
        actorIds: Array.isArray(event?.actorIds) ? event.actorIds.filter((id): id is string => typeof id === 'string') : undefined,
        targetIds: Array.isArray(event?.targetIds) ? event.targetIds.filter((id): id is string => typeof id === 'string') : undefined,
      })),
    })),
    worldState: {
      ...input.worldState,
      structuredRoomState,
    },
    runtimeDetailLoaded: inferLegacyChatRuntimeDetailLoaded(input),
    messageBranchState: branchState,
  };
}

export function migrateCharacterStoreState<T extends { characters?: AICharacter[] }>(persisted: VersionedPersistedState<T>): VersionedPersistedState<T> {
  if (!persisted) return persisted;
  return {
    ...persisted,
    characters: (persisted.characters || []).map(migrateCharacter),
  };
}

export function migrateChatStoreState<T extends { chats?: GroupChat[] }>(persisted: VersionedPersistedState<T>): VersionedPersistedState<T> {
  if (!persisted) return persisted;
  return {
    ...persisted,
    chats: (persisted.chats || []).map(migrateChat),
  };
}

export function migrateMessageStoreState<T extends { messages?: Array<Record<string, unknown>>; messageWindowsByChatId?: Record<string, { messages?: Array<Record<string, unknown>> }> }>(persisted: VersionedPersistedState<T>): VersionedPersistedState<T> {
  if (!persisted) return persisted;
  const migrateCollection = (messages: Array<Record<string, unknown>>, inferMissingParents = true) => {
    const ordered = messages.slice().sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
    const aliases = new Map<string, string>();
    for (const message of ordered) {
      const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? message.metadata as Record<string, unknown>
        : {};
      const branching = metadata.branching && typeof metadata.branching === 'object' && !Array.isArray(metadata.branching)
        ? metadata.branching as Record<string, unknown>
        : {};
      const nodeId = typeof branching.nodeId === 'string' && branching.nodeId.trim()
        ? branching.nodeId.trim()
        : (typeof message.clientKey === 'string' && message.clientKey.trim()
          ? message.clientKey.trim()
          : (typeof message.id === 'string' ? message.id : `migrated-${String(message.timestamp || Date.now())}`));
      aliases.set(nodeId, nodeId);
      if (typeof message.id === 'string') aliases.set(message.id, nodeId);
      if (typeof message.clientKey === 'string') aliases.set(message.clientKey, nodeId);
      if (typeof message.serverId === 'string') aliases.set(message.serverId, nodeId);
    }
    let previousNodeId: string | null = null;
    const migrated = ordered.map((message, index) => {
      const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? message.metadata as Record<string, unknown>
        : {};
      const oldBranching = metadata.branching && typeof metadata.branching === 'object' && !Array.isArray(metadata.branching)
        ? metadata.branching as Record<string, unknown>
        : {};
      const nodeId = aliases.get(String(oldBranching.nodeId || message.clientKey || message.id))
        || String(oldBranching.nodeId || message.clientKey || message.id || `migrated-${index}`);
      const explicitParent = typeof oldBranching.parentNodeId === 'string' && oldBranching.parentNodeId.trim()
        ? aliases.get(oldBranching.parentNodeId) || oldBranching.parentNodeId
        : null;
      const parentNodeId = Object.prototype.hasOwnProperty.call(oldBranching, 'parentNodeId')
        ? explicitParent
        : (inferMissingParents ? previousNodeId : null);
      previousNodeId = nodeId;
      return {
        ...message,
        metadata: {
          ...metadata,
          branching: {
            ...oldBranching,
            nodeId,
            parentNodeId,
            rootNodeId: nodeId,
            sequence: typeof oldBranching.sequence === 'number' ? oldBranching.sequence : index + 1,
            migrationConfidence: Object.prototype.hasOwnProperty.call(oldBranching, 'parentNodeId') ? 'explicit' : (inferMissingParents ? 'inferred' : 'unknown'),
          },
        },
        emotion: typeof message.emotion === 'number' && Number.isFinite(message.emotion) ? message.emotion : 0,
        isDeleted: Boolean(message.isDeleted),
      };
    });
    const parentByNodeId = new Map<string, string | null>();
    for (const message of migrated) {
      const branching = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>).branching
        : null;
      const branch = branching && typeof branching === 'object' && !Array.isArray(branching) ? branching as Record<string, unknown> : {};
      parentByNodeId.set(String(branch.nodeId), typeof branch.parentNodeId === 'string' ? branch.parentNodeId : null);
    }
    return migrated.map((message) => {
      const metadata = message.metadata as Record<string, unknown>;
      const branching = metadata.branching as Record<string, unknown>;
      const seen = new Set<string>();
      let root = String(branching.nodeId);
      let parent = typeof branching.parentNodeId === 'string' ? branching.parentNodeId : null;
      while (parent && parentByNodeId.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        root = parent;
        parent = parentByNodeId.get(parent) || null;
      }
      return { ...message, metadata: { ...metadata, branching: { ...branching, rootNodeId: root } } };
    });
  };
  return {
    ...persisted,
    messages: migrateCollection(persisted.messages || []),
    messageWindowsByChatId: Object.fromEntries(
      Object.entries(persisted.messageWindowsByChatId || {}).map(([chatId, window]) => [chatId, {
        ...window,
        messages: migrateCollection(window?.messages || [], false),
      }])
    ),
  };
}

export function migrateSettingsStoreState<T extends Record<string, unknown>>(persisted: VersionedPersistedState<T>): VersionedPersistedState<T> {
  if (!persisted) return persisted;
  const developerUI = (persisted.developerUI as { showMemoryDebug?: boolean; showRelationshipEvents?: boolean; showAffectEvents?: boolean; showConflictEvents?: boolean; showStateEvents?: boolean; showMemoryDistillationEvents?: boolean; showCalendarEvents?: boolean; showLocalInterceptionHints?: boolean; showSpeechStyle?: boolean; showAdvancedRuntimePanels?: boolean; showDeliberationDebug?: boolean; showPresenceDebug?: boolean; showCompanionshipDebug?: boolean; showMomentDebug?: boolean; showWithdrawnMessageContent?: boolean; enableHumanAppraisal?: boolean; dramaBoost?: boolean } | undefined) || {};
  const artifactAppearance = (persisted.artifactAppearance as { paperVariant?: string } | undefined) || {};
  const chatAppearance = (persisted.chatAppearance as { maxContentWidth?: number; voiceWaveformStyle?: string; storyReader?: { fontFamily?: string; fontSize?: number; lineHeight?: number } } | undefined) || {};
  return {
    ...persisted,
    themePreset: typeof persisted.themePreset === 'string' ? persisted.themePreset : DEFAULT_SETTINGS.themePreset,
    developerUI: {
      autoApplyCodeUpdates: Boolean((developerUI as { autoApplyCodeUpdates?: boolean }).autoApplyCodeUpdates),
      showMemoryDebug: Boolean(developerUI.showMemoryDebug),
      showRelationshipEvents: Boolean(developerUI.showRelationshipEvents),
      showAffectEvents: Boolean(developerUI.showAffectEvents),
      showConflictEvents: Boolean(developerUI.showConflictEvents),
      showStateEvents: Boolean(developerUI.showStateEvents),
      showMemoryDistillationEvents: Boolean(developerUI.showMemoryDistillationEvents),
      showCalendarEvents: Boolean(developerUI.showCalendarEvents),
      showLocalInterceptionHints: Boolean(developerUI.showLocalInterceptionHints),
      showSpeechStyle: Boolean(developerUI.showSpeechStyle),
      showAdvancedRuntimePanels: Boolean(developerUI.showAdvancedRuntimePanels),
      showDeliberationDebug: Boolean(developerUI.showDeliberationDebug),
      showPresenceDebug: Boolean(developerUI.showPresenceDebug),
      showCompanionshipDebug: Boolean(developerUI.showCompanionshipDebug),
      showMomentDebug: Boolean(developerUI.showMomentDebug),
      showWithdrawnMessageContent: Boolean(developerUI.showWithdrawnMessageContent),
      enableHumanAppraisal: developerUI.enableHumanAppraisal ?? DEFAULT_DEVELOPER_UI_PREFS.enableHumanAppraisal,
      dramaBoost: Boolean(developerUI.dramaBoost),
    },
    chatMemory: normalizeChatMemorySettings((persisted as { chatMemory?: Parameters<typeof normalizeChatMemorySettings>[0] }).chatMemory),
    artifactAppearance: {
      ...DEFAULT_ARTIFACT_APPEARANCE_SETTINGS,
      paperVariant: PAPER_SURFACE_VARIANTS.includes(artifactAppearance.paperVariant as never)
        ? artifactAppearance.paperVariant
        : DEFAULT_ARTIFACT_APPEARANCE_SETTINGS.paperVariant,
    },
    chatAppearance: {
      ...DEFAULT_CHAT_APPEARANCE_SETTINGS,
      ...chatAppearance,
      storyReader: {
        ...DEFAULT_CHAT_APPEARANCE_SETTINGS.storyReader,
        ...(chatAppearance.storyReader || {}),
      },
    },
    userBubbleStyleId: typeof persisted.userBubbleStyleId === 'string' ? persisted.userBubbleStyleId : null,
    userBubbleStyle: persisted.userBubbleStyle && typeof persisted.userBubbleStyle === 'object' ? persisted.userBubbleStyle : null,
  } as T;
}

export function migrateUiStoreState<T extends Record<string, unknown>>(persisted: VersionedPersistedState<T>): VersionedPersistedState<T> {
  if (!persisted) return persisted;
  const rawReadingPositions = persisted.chatReadingPositions && typeof persisted.chatReadingPositions === 'object'
    ? persisted.chatReadingPositions as Record<string, Record<string, unknown>>
    : {};
  const chatReadingPositions = Object.fromEntries(Object.entries(rawReadingPositions)
    .filter(([chatId, position]) => (
      typeof chatId === 'string'
      && typeof position?.messageId === 'string'
      && typeof position?.offsetTop === 'number'
    ))
    .map(([chatId, position]) => [chatId, {
      messageId: position.messageId as string,
      offsetTop: position.offsetTop as number,
      pinned: Boolean(position.pinned),
      updatedAt: typeof position.updatedAt === 'number' ? position.updatedAt : 0,
      ...(typeof position.sourceTimestamp === 'number' ? { sourceTimestamp: position.sourceTimestamp } : {}),
    }]));
  return {
    ...persisted,
    sidebarOpen: Boolean(persisted.sidebarOpen),
    rightPanelOpen: Boolean(persisted.rightPanelOpen),
    godModeActive: Boolean(persisted.godModeActive),
    topicGuideOpen: Boolean(persisted.topicGuideOpen),
    speakAsCharacterId: typeof persisted.speakAsCharacterId === 'string' ? persisted.speakAsCharacterId : null,
    rightPanelTab: persisted.rightPanelTab === 'world'
      || persisted.rightPanelTab === 'developer'
      || persisted.rightPanelTab === 'actions'
      || persisted.rightPanelTab === 'activities'
      || persisted.rightPanelTab === 'session'
      || persisted.rightPanelTab === 'narrative'
      || persisted.rightPanelTab === 'chapters'
      || persisted.rightPanelTab === 'clues'
      || persisted.rightPanelTab === 'roles'
      ? persisted.rightPanelTab
      : 'members',
    chatReadingPositions,
  } as T;
}

export const CLIENT_STORE_MIGRATION_NOTES = {
  1: 'Normalize persisted relationships, governance, developer UI, and message payload shapes.',
  2: 'Slim relationship ledger recent events down to lightweight snapshots.',
  3: 'Shift room cohesion to a signed zero-centered scale.',
  4: 'Preserve whether persisted character and chat records contain full detail or only summaries.',
  5: 'Recompute chat detail flags using only fields that are not present in chat summaries.',
  6: 'Migrate legacy message branch metadata to immutable v2 nodes and convert active leaf state to a main branch ref.',
} as const;
