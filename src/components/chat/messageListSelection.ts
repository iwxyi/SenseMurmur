import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual';

// Preserve only rows that actually contain selected text. Selecting one word
// must not mount the entire message window or change the list's layout mode.
export function extractMessageSelectionRange(
  range: Range,
  itemKeys: readonly string[],
  selectedKeys: ReadonlySet<string>,
) {
  const indexes = new Set(defaultRangeExtractor(range));
  if (selectedKeys.size) {
    itemKeys.forEach((key, index) => {
      if (index < range.count && selectedKeys.has(key)) indexes.add(index);
    });
  }
  return [...indexes].sort((left, right) => left - right);
}
