import { describe, expect, it } from 'vitest';
import { characterPublicationOffset, DIARY_SPREAD_WINDOW_MS, MOMENT_SPREAD_WINDOW_MS } from './characterPublicationSchedule';

describe('independent character publication appointments', () => {
  it.each([DIARY_SPREAD_WINDOW_MS, MOMENT_SPREAD_WINDOW_MS])('spreads 100 characters within one %i ms window', (windowMs) => {
    const offsets = Array.from({ length: 100 }, (_, index) => characterPublicationOffset(`character-${index}:2026-10-16`, windowMs));
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...offsets)).toBeLessThan(windowMs);
    expect(new Set(offsets).size).toBe(100);
    expect(offsets[3]).toBe(characterPublicationOffset('character-3:2026-10-16', windowMs));
    expect(offsets[3]).not.toBe(characterPublicationOffset('character-3:2026-10-17', windowMs));
  });
});
