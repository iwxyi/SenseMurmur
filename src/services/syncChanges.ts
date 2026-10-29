/** Change logs arrive in sequence order; only the final state of each entity applies. */
export function latestEntityChanges<T extends Record<string, unknown>>(changes: T[]): T[] {
  const latest = new Map<string | symbol, T>();
  for (const change of changes) {
    // Leave malformed entries visible to the caller's validation.
    const key = typeof change.entity === 'string' && typeof change.id === 'string'
      ? JSON.stringify([change.entity, change.id])
      : Symbol();
    latest.set(key, change);
  }
  return Array.from(latest.values());
}
