import { describe, expect, it } from "vitest";
import {
  getMediaCardTagLimit,
  MEDIA_WALL_ROW_OVERSCAN,
  selectVisibleCardTagIndexes
} from "../../client/src/lib/mediaWallLayout";

describe("media wall layout", () => {
  it("keeps row overscan bounded for scroll performance", () => {
    expect(MEDIA_WALL_ROW_OVERSCAN).toBe(2);
  });

  it("derives a stable tag budget from card width", () => {
    expect(getMediaCardTagLimit(180)).toBe(1);
    expect(getMediaCardTagLimit(240)).toBe(2);
    expect(getMediaCardTagLimit(320)).toBe(3);
  });

  it("prioritizes compact suffix flags without changing display order", () => {
    const items = [
      { key: "metadata:剧情" },
      { key: "metadata:单体作品" },
      { key: "suffix:U" },
      { key: "suffix:C" }
    ];

    expect(selectVisibleCardTagIndexes(items, 2)).toEqual([2, 3]);
    expect(selectVisibleCardTagIndexes(items, 3)).toEqual([0, 2, 3]);
  });

  it("returns all tags when they already fit the budget", () => {
    expect(selectVisibleCardTagIndexes([{ key: "metadata:剧情" }], 2)).toEqual([0]);
  });
});
