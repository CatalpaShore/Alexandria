import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../client/src/lib/api";
import { updateMediaItemsInQueryData } from "../../client/src/lib/queryCacheUpdates";

const mediaItem = {
  id: "media-1",
  relativePath: "JAV/source/A/TEST-001.mp4",
  isFavorite: false
} as MediaItem;

describe("query cache media updates", () => {
  it("updates media in a regular recommendation list", () => {
    const result = updateMediaItemsInQueryData(
      { items: [mediaItem], total: 1 },
      (item) => ({ ...item, isFavorite: true })
    ) as { items: MediaItem[]; total: number };

    expect(result.items[0]?.isFavorite).toBe(true);
    expect(result.total).toBe(1);
  });

  it("updates media in an infinite home dashboard cache", () => {
    const result = updateMediaItemsInQueryData(
      { pages: [{ items: [mediaItem], page: 1 }], pageParams: [1] },
      (item) => ({ ...item, isFavorite: true })
    ) as { pages: Array<{ items: MediaItem[]; page: number }>; pageParams: number[] };

    expect(result.pages[0]?.items[0]?.isFavorite).toBe(true);
    expect(result.pageParams).toEqual([1]);
  });

  it("leaves unrelated dashboard data unchanged", () => {
    const dashboard = { stats: { played: 10 } };
    expect(updateMediaItemsInQueryData(dashboard, (item) => item)).toBe(dashboard);
  });
});
