import { afterEach, describe, expect, it, vi } from "vitest";
import { actorProviderWorkIdentity, isActorNameCandidate } from "../../server/src/actorAliases";
import { db } from "../../server/src/db";
import { enrichActorFromWikimedia, getEntityProfileCoverage } from "../../server/src/entityProfiles";
import {
  getCanonicalTopicProfileCandidates,
  isTopicVisible
} from "../../server/src/productRoutes";

afterEach(() => vi.restoreAllMocks());

describe("actor topic candidate quality", () => {
  it("deduplicates alternate normalized codes that share one provider work ID", () => {
    expect(actorProviderWorkIdentity("r18dev", "1chie003", "SDDH-011"))
      .toBe(actorProviderWorkIdentity("R18DEV", "1chie003", "SDDH01-1"));
    expect(actorProviderWorkIdentity("JavBus", "PAKX-004", "PAKX-004"))
      .toBe(actorProviderWorkIdentity("javbus", "PAKX-004", "PAKX-04"));
    expect(actorProviderWorkIdentity("FANZA", "", "BDA-150"))
      .not.toBe(actorProviderWorkIdentity("FANZA", "", "GVH-351"));
  });
  it("keeps polluted values out of topic visibility and profile coverage", () => {
    for (const value of ["<img", "<i", "<图片", "<我", "画像を拡大する", "放大图像"]) {
      expect(isTopicVisible("actor", value, value)).toBe(false);
    }
    expect(isTopicVisible("actor", "一ノ瀬アメリ", "一之濑亚美莉")).toBe(true);

    expect(getEntityProfileCoverage("actor", [
      { value: "<img", aliases: ["<图片"] },
      { value: "画像を拡大する", aliases: ["放大图像"] }
    ])).toMatchObject({ total: 0, enriched: 0, pending: 0 });
  });

  it("filters existing polluted facets without deleting their source metadata", () => {
    const pollutedRowsBefore = db.prepare(`
      SELECT facet_value AS value, COUNT(*) AS count
      FROM media_metadata_facets
      WHERE facet_type = 'actor'
        AND facet_value IN ('<img', '<i', '画像を拡大する')
      GROUP BY facet_value ORDER BY facet_value
    `).all() as Array<{ value: string; count: number }>;
    const candidates = getCanonicalTopicProfileCandidates("actor");

    expect(new Set(candidates.map((candidate) => candidate.value)).size).toBe(candidates.length);
    expect(candidates.flatMap((candidate) => [candidate.value, ...candidate.aliases])
      .every(isActorNameCandidate)).toBe(true);
    const pollutedRowsAfter = db.prepare(`
      SELECT facet_value AS value, COUNT(*) AS count
      FROM media_metadata_facets
      WHERE facet_type = 'actor'
        AND facet_value IN ('<img', '<i', '画像を拡大する')
      GROUP BY facet_value ORDER BY facet_value
    `).all() as Array<{ value: string; count: number }>;
    expect(pollutedRowsAfter).toEqual(pollutedRowsBefore);
  });

  it("does not call Wikimedia or add retry attempts for a rejected actor value", async () => {
    const value = "<img";
    const before = db.prepare(`
      SELECT attempt_count AS attemptCount FROM entity_profile_enrichment
      WHERE facet_type = 'actor' AND facet_value = ?
    `).get(value) as { attemptCount: number } | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(enrichActorFromWikimedia(value, ["<图片", "放大图像"], true)).resolves.toMatchObject({
      actorValue: value,
      matched: false
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = db.prepare(`
      SELECT attempt_count AS attemptCount FROM entity_profile_enrichment
      WHERE facet_type = 'actor' AND facet_value = ?
    `).get(value) as { attemptCount: number } | undefined;
    expect(after).toEqual(before);
  });
});
