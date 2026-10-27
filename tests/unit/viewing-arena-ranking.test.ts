import { describe, expect, it } from "vitest";
import {
  buildArenaSignalProfile,
  pickAdaptiveArenaPair,
  rankArenaCandidates,
  type ArenaRankCandidate,
  type ViewingFacet
} from "../../server/src/viewingArenaRanking.js";

describe("viewing arena ranking", () => {
  it("turns a choice into winner, shared, and contrast signals immediately", () => {
    const facetsByMediaId = new Map<string, ViewingFacet[]>([
      ["left", [{ type: "actor", value: "演员 A" }, { type: "genre", value: "剧情" }]],
      ["right", [{ type: "actor", value: "演员 B" }, { type: "genre", value: "剧情" }]]
    ]);

    const profile = buildArenaSignalProfile({
      rounds: [{
        roundIndex: 0,
        decision: "choose",
        leftMediaId: "left",
        rightMediaId: "right",
        winnerMediaId: "left"
      }],
      facetsByMediaId
    });

    expect(profile.positiveSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "actor", value: "演员 A", score: 1 }),
      expect.objectContaining({ type: "genre", value: "剧情" })
    ]));
    expect(profile.negativeSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "actor", value: "演员 B", score: 0.3 })
    ]));
    expect(profile.lastImpact?.action).toBe("choose");
    expect(profile.decidedRounds).toBe(1);
  });

  it("folds result-stage likes and replacements into the same signal profile", () => {
    const profile = buildArenaSignalProfile({
      branchSignals: [
        { type: "actor", value: "想继续的演员", score: 0.9 },
        { type: "genre", value: "想避开的题材", score: -0.68 }
      ],
      rounds: [],
      facetsByMediaId: new Map()
    });

    expect(profile.positiveSignals).toContainEqual({
      type: "actor",
      value: "想继续的演员",
      score: 0.9
    });
    expect(profile.negativeSignals).toContainEqual({
      type: "genre",
      value: "想避开的题材",
      score: 0.68
    });
  });

  it("builds balanced lanes while capping a repeated actor", () => {
    const candidates: ArenaRankCandidate<string>[] = [];
    for (let index = 0; index < 6; index += 1) {
      candidates.push({
        id: `core-${index}`,
        normalizedCode: `CORE-${index}`,
        baseScore: 100 - index,
        routeMatchCount: 2,
        favorite: false,
        unwatched: true,
        facets: [{ type: "actor", value: "同一演员" }, { type: "genre", value: `核心题材 ${index}` }],
        payload: `core-${index}`
      });
      candidates.push({
        id: `adjacent-${index}`,
        normalizedCode: `ADJ-${index}`,
        baseScore: 80 - index,
        routeMatchCount: 1,
        favorite: false,
        unwatched: true,
        facets: [{ type: "actor", value: `邻近演员 ${index}` }, { type: "genre", value: `邻近题材 ${index}` }],
        payload: `adjacent-${index}`
      });
      candidates.push({
        id: `wildcard-${index}`,
        normalizedCode: `WILD-${index}`,
        baseScore: 60 - index,
        routeMatchCount: 0,
        favorite: false,
        unwatched: true,
        facets: [{ type: "actor", value: `惊喜演员 ${index}` }, { type: "label", value: `厂牌 ${index}` }],
        payload: `wildcard-${index}`
      });
    }

    const ranked = rankArenaCandidates({
      candidates,
      profile: buildArenaSignalProfile({ rounds: [], facetsByMediaId: new Map() }),
      limit: 12
    });

    expect(ranked.filter((item) => item.lane === "core")).toHaveLength(4);
    expect(ranked.filter((item) => item.lane === "adjacent")).toHaveLength(4);
    expect(ranked.filter((item) => item.lane === "wildcard")).toHaveLength(4);
    expect(ranked.filter((item) => item.facets.some((facet) => facet.value === "同一演员"))).toHaveLength(4);
  });

  it("still reserves three distinct lanes when every high-scoring candidate begins in core", () => {
    const candidates: ArenaRankCandidate<string>[] = Array.from({ length: 12 }, (_, index) => ({
      id: `favorite-${index}`,
      normalizedCode: `FAV-${index}`,
      baseScore: 120 - index,
      routeMatchCount: 2,
      favorite: true,
      unwatched: true,
      facets: [
        { type: "actor", value: `演员 ${index}` },
        { type: "genre", value: `题材 ${index}` }
      ],
      payload: `favorite-${index}`
    }));

    const ranked = rankArenaCandidates({
      candidates,
      profile: buildArenaSignalProfile({ rounds: [], facetsByMediaId: new Map() }),
      limit: 12
    });

    expect(ranked.filter((item) => item.lane === "core")).toHaveLength(4);
    expect(ranked.filter((item) => item.lane === "adjacent")).toHaveLength(4);
    expect(ranked.filter((item) => item.lane === "wildcard")).toHaveLength(4);
    expect(new Set(ranked.map((item) => item.id)).size).toBe(12);
  });

  it("uses the current strategy and avoids media already shown when choosing the next pair", () => {
    const pair = pickAdaptiveArenaPair({
      candidates: [
        { id: "core-used", lane: "core", score: 90, facets: [{ type: "actor", value: "A" }] },
        { id: "core-new", lane: "core", score: 88, facets: [{ type: "actor", value: "B" }] },
        { id: "adjacent-new", lane: "adjacent", score: 75, facets: [{ type: "genre", value: "剧情" }] },
        { id: "wild-new", lane: "wildcard", score: 65, facets: [{ type: "label", value: "新厂牌" }] }
      ],
      usedMediaIds: new Set(["core-used"]),
      strategyIndex: 1,
      seed: 42
    });

    expect(pair?.strategy.id).toBe("bridge");
    expect(pair?.left.id).toBe("core-new");
    expect(pair?.right.id).toBe("adjacent-new");
  });
});
