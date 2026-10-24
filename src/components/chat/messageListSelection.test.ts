import { describe, expect, it } from 'vitest';
import { extractMessageSelectionRange } from './messageListSelection';

describe('message selection virtualization', () => {
  const keys = Array.from({ length: 240 }, (_, index) => `message-${index}`);
  const range = { startIndex: 100, endIndex: 104, overscan: 2, count: keys.length };

  it('selecting a distant message retains only that row alongside the viewport', () => {
    const indexes = extractMessageSelectionRange(range, keys, new Set(['message-3']));
    expect(indexes).toEqual([3, 98, 99, 100, 101, 102, 103, 104, 105, 106]);
  });

  it('preserves multiple selected rows without duplicating visible rows', () => {
    expect(extractMessageSelectionRange(range, keys, new Set(['message-3', 'message-4', 'message-100'])))
      .toEqual([3, 4, 98, 99, 100, 101, 102, 103, 104, 105, 106]);
  });

  it('tracks stable row keys when paging changes their positions', () => {
    const reordered = ['message-100', 'message-3', 'message-4'];
    expect(extractMessageSelectionRange({ startIndex: 0, endIndex: 0, overscan: 0, count: 3 }, reordered, new Set(['message-4', 'removed'])))
      .toEqual([0, 2]);
  });

  it('releases retained rows when selection is cleared', () => {
    expect(extractMessageSelectionRange(range, keys, new Set()))
      .toEqual([98, 99, 100, 101, 102, 103, 104, 105, 106]);
  });
});
