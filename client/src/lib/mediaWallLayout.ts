export const MEDIA_WALL_ROW_OVERSCAN = 2;

export function getMediaCardTagLimit(cardWidth: number): number {
  if (cardWidth < 210) return 1;
  if (cardWidth < 280) return 2;
  return 3;
}

export function selectVisibleCardTagIndexes(
  items: ReadonlyArray<{ key: string }>,
  limit: number
): number[] {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (items.length <= normalizedLimit) return items.map((_, index) => index);

  return items
    .map((item, index) => ({
      index,
      priority: item.key.startsWith("suffix:") ? 0 : 1
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, normalizedLimit)
    .map(({ index }) => index)
    .sort((left, right) => left - right);
}
