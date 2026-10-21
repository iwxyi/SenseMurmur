export type RetentionLimitKey =
  | 'characterLayeredMemories'
  | 'characterRuntimeTimeline'
  | 'chatLayeredMemories'
  | 'runtimeEventsV2'
  | 'runtimeTimeline'
  | 'relationshipLedger'
  | 'roleMemorySummaries'
  | 'growthSnapshots'
  | 'runtimeSeedNotes'
  | 'runtimeSeedArtifacts';

export type RetentionLimitPair = {
  storage: number;
  recall: number;
};

export type RetentionLimits = Record<RetentionLimitKey, RetentionLimitPair>;

export const DEFAULT_BASIC_RETENTION_LIMITS: RetentionLimits = {
  characterLayeredMemories: { storage: 80, recall: 6 },
  characterRuntimeTimeline: { storage: 80, recall: 6 },
  chatLayeredMemories: { storage: 80, recall: 8 },
  runtimeEventsV2: { storage: 120, recall: 16 },
  runtimeTimeline: { storage: 80, recall: 10 },
  relationshipLedger: { storage: 120, recall: 12 },
  roleMemorySummaries: { storage: 32, recall: 8 },
  growthSnapshots: { storage: 40, recall: 8 },
  runtimeSeedNotes: { storage: 40, recall: 8 },
  runtimeSeedArtifacts: { storage: 40, recall: 8 },
};

const RETENTION_KEYS = Object.keys(DEFAULT_BASIC_RETENTION_LIMITS) as RetentionLimitKey[];

function toLimit(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

export function normalizeRetentionLimits(value: unknown, fallback: RetentionLimits = DEFAULT_BASIC_RETENTION_LIMITS): RetentionLimits {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(RETENTION_KEYS.map((key) => {
    const rawPair = raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])
      ? raw[key] as Record<string, unknown>
      : {};
    return [key, {
      storage: toLimit(rawPair.storage, fallback[key].storage),
      recall: toLimit(rawPair.recall, fallback[key].recall),
    }];
  })) as RetentionLimits;
}

export function takeRecentByLimit<T>(items: T[] | undefined, limit: number): T[] {
  if (!Array.isArray(items)) return [];
  return items.length > limit ? items.slice(-limit) : items;
}

export function getCurrentRetentionLimits() {
  if (typeof localStorage === 'undefined') return DEFAULT_BASIC_RETENTION_LIMITS;
  return normalizeRetentionLimits(readAuthSnapshot().user?.retentionLimits);
}
import { readAuthSnapshot } from './authSnapshot';
