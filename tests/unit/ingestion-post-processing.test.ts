import { describe, expect, it } from "vitest";
import {
  planFirstTimeActorEnrichment,
  planFirstTimePublicEntityEnrichment
} from "../../server/src/ingestionPostProcessing";

describe("ingestion post-processing", () => {
  it("only schedules actors whose identity has never been fetched", () => {
    const result = planFirstTimeActorEnrichment([
      { source: "河北彩花", translated: "河北彩花" },
      { source: "松本いちか", translated: "松本一香" },
      { source: "松本 いちか", translated: "松本一香" }
    ], ["河北彩花"]);

    expect(result.skipped).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      value: "松本いちか",
      displayName: "松本一香"
    });
    expect(result.candidates[0]?.searchNames).toEqual(expect.arrayContaining(["松本いちか", "松本一香"]));
  });

  it("treats a previously attempted translated name as already fetched", () => {
    const result = planFirstTimeActorEnrichment([
      { source: "Suzu Honjo", translated: "本庄铃" }
    ], ["本庄铃"]);

    expect(result.candidates).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("schedules a first-time director with original and localized search names", () => {
    const result = planFirstTimePublicEntityEnrichment("director", [
      { source: "二宮大輔", translated: "二宫大辅" }
    ], []);

    expect(result.skipped).toBe(0);
    expect(result.candidates).toEqual([{
      value: "二宮大輔",
      displayName: "二宫大辅",
      searchNames: ["二宮大輔", "二宫大辅"]
    }]);
  });

  it("does not reschedule maker or label aliases that were fetched before", () => {
    const maker = planFirstTimePublicEntityEnrichment("maker", [
      { source: "S1 NO.1 STYLE", translated: "S1" }
    ], ["s1-no.1 style"]);
    const label = planFirstTimePublicEntityEnrichment("label", [
      { source: "MOODYZ", translated: "MOODYZ" },
      { source: "Moodyz", translated: "MOODYZ" }
    ], []);

    expect(maker.candidates).toEqual([]);
    expect(maker.skipped).toBe(1);
    expect(label.candidates).toHaveLength(1);
    expect(label.skipped).toBe(1);
  });
});
