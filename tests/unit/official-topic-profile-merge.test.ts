import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../server/src/db.js";
import {
  persistVerifiedOfficialTopicSnapshot,
  resolveOfficialTopicHeight,
  type OfficialTopicSourceDefinition
} from "../../server/src/officialTopicSources.js";

const OLD_VALUE = "__test_profile_alias_old__";
const NEW_VALUE = "__test_profile_alias_new__";
const SHARED_ALIAS = "__test_profile_alias_shared__";

function cleanup(): void {
  for (const table of ["entity_profile_sources", "entity_profile_enrichment", "entity_profiles"]) {
    db.prepare(`DELETE FROM ${table} WHERE facet_type = 'label' AND facet_value IN (?, ?)`)
      .run(OLD_VALUE, NEW_VALUE);
  }
}

function definition(value: string, provider: string, sourceUrl: string): OfficialTopicSourceDefinition {
  return {
    type: "label",
    value,
    aliases: [SHARED_ALIAS],
    provider,
    sourceUrl,
    expectedNames: [value],
    summaryFallback: `${value} test profile`,
    officialWebsite: false,
    suppressImage: true,
    entityKind: "organization",
    occupations: ["成人影像厂牌"]
  };
}

describe("official topic profile canonical migration", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("moves an existing profile found through a shared alias into one canonical owner", () => {
    persistVerifiedOfficialTopicSnapshot(definition(
      OLD_VALUE, "test-old-profile-source", "https://example.test/entity-profile/old"
    ));
    persistVerifiedOfficialTopicSnapshot(definition(
      NEW_VALUE, "test-new-profile-source", "https://example.test/entity-profile/new"
    ));

    const profiles = db.prepare(`
      SELECT facet_value AS value, aliases_json AS aliasesJson
      FROM entity_profiles
      WHERE facet_type = 'label' AND facet_value IN (?, ?)
    `).all(OLD_VALUE, NEW_VALUE) as Array<{ value: string; aliasesJson: string }>;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.value).toBe(NEW_VALUE);
    expect(JSON.parse(profiles[0]?.aliasesJson ?? "[]")).toEqual(expect.arrayContaining([
      OLD_VALUE, NEW_VALUE, SHARED_ALIAS
    ]));

    const sourceCount = db.prepare(`
      SELECT COUNT(*) AS count FROM entity_profile_sources
      WHERE facet_type = 'label' AND facet_value = ?
    `).get(NEW_VALUE) as { count: number };
    expect(sourceCount.count).toBe(2);
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM entity_profile_enrichment
      WHERE facet_type = 'label' AND facet_value = ?
    `).get(OLD_VALUE) as { count: number }).count).toBe(0);
  });

  it("clears a mismatched Wikimedia identity while retaining the exact product source and localized name", () => {
    persistVerifiedOfficialTopicSnapshot({
      ...definition(NEW_VALUE, "wikidata", "https://www.wikidata.org/wiki/Q999999999"),
      displayName: "错误公开实体",
      names: { ja: "错误公开实体", en: "Wrong public entity" },
      aliases: [SHARED_ALIAS, "独立厂牌A", "独立厂牌B"],
      wikidataId: "Q999999999",
      wikipediaUrl: "https://ja.wikipedia.org/wiki/Wrong"
    });

    persistVerifiedOfficialTopicSnapshot({
      ...definition(NEW_VALUE, "test-exact-product-source", "https://example.test/product/SMOK-002"),
      displayName: "正确中文名",
      names: { zh: "正确中文名" },
      aliases: [],
      clearWikimediaIdentity: true
    });

    const profile = db.prepare(`
      SELECT display_name AS displayName, names_json AS namesJson, aliases_json AS aliasesJson,
        wikidata_id AS wikidataId, wikipedia_url AS wikipediaUrl
      FROM entity_profiles WHERE facet_type = 'label' AND facet_value = ?
    `).get(NEW_VALUE) as {
      displayName: string; namesJson: string; aliasesJson: string; wikidataId: string; wikipediaUrl: string;
    };
    expect(profile.displayName).toBe("正确中文名");
    expect(JSON.parse(profile.namesJson)).toEqual({ ja: NEW_VALUE, zh: "正确中文名" });
    expect(JSON.parse(profile.aliasesJson)).toEqual([NEW_VALUE]);
    expect(profile.wikidataId).toBe("");
    expect(profile.wikipediaUrl).toBe("");
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM entity_profile_sources
      WHERE facet_type = 'label' AND facet_value = ? AND provider IN ('wikidata', 'wikipedia', 'wikimedia-commons')
    `).get(NEW_VALUE) as { count: number }).count).toBe(0);
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM entity_profile_sources
      WHERE facet_type = 'label' AND facet_value = ? AND provider = 'test-exact-product-source'
    `).get(NEW_VALUE) as { count: number }).count).toBe(1);
  });
});

describe("official topic field precedence", () => {
  it("allows an explicit authoritative height correction without replacing curated values", () => {
    expect(resolveOfficialTopicHeight(162, "auto-matched", 160, true)).toBe(160);
    expect(resolveOfficialTopicHeight(162, "auto-resolved", 160, true)).toBe(160);
    expect(resolveOfficialTopicHeight(162, "verified", 160, true)).toBe(162);
    expect(resolveOfficialTopicHeight(162, "auto-matched", 160, false)).toBe(162);
    expect(resolveOfficialTopicHeight(null, "auto-matched", 160, false)).toBe(160);
  });
});
