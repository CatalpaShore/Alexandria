import { describe, expect, it } from "vitest";
import { createSearchDomain } from "../../server/src/searchDomain";

describe("search cache invalidation", () => {
  it("keeps stable facets warm when only playback progress changes", () => {
    const domain = createSearchDomain({ isScanActive: () => false, getLatestScan: () => null });

    expect(domain.getFacets({}).cacheStatus).toBe("MISS");
    expect(domain.getFacets({ playbackState: "completed" }).cacheStatus).toBe("MISS");

    domain.clearPlaybackCaches();

    expect(domain.getFacets({}).cacheStatus).toBe("HIT");
    expect(domain.getFacets({ playbackState: "completed" }).cacheStatus).toBe("MISS");
  });
});
