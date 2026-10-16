// Independent appointments stay within one window, regardless of population size.
export function characterPublicationOffset(key: string, windowMs: number) {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % windowMs;
}

export const MOMENT_SPREAD_WINDOW_MS = 2 * 60 * 60_000;
export const DIARY_SPREAD_WINDOW_MS = 45 * 60_000;
