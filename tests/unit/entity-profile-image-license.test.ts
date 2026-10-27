import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityProfilePanel } from "../../client/src/components/EntityProfilePanel";
import type { EntityResponse } from "../../client/src/lib/api";
import { db } from "../../server/src/db";
import { getEntityExtendedProfile } from "../../server/src/entityProfiles";

type Profile = NonNullable<EntityResponse["profile"]>;

type ImageAttribution = {
  fileName: string;
  sourceUrl: string;
  creator: string;
  creatorUrl?: string;
  license: string;
  licenseUrl: string;
  credit?: string;
};

const TEST_VALUE = "__test_profile_image_license__";

function cleanFixture() {
  db.prepare("DELETE FROM entity_profile_sources WHERE facet_type IN ('actor', 'director') AND facet_value = ?").run(TEST_VALUE);
  db.prepare("DELETE FROM entity_profiles WHERE facet_type IN ('actor', 'director') AND facet_value = ?").run(TEST_VALUE);
}

beforeEach(cleanFixture);
afterEach(cleanFixture);

function profile(overrides: Partial<Profile> & { imageAttribution?: ImageAttribution | null } = {}) {
  return {
    type: "actor",
    value: "example",
    displayName: "示例演员",
    names: { ja: "サンプル" },
    aliases: ["example"],
    biography: "公开资料简介。",
    birthDate: null,
    birthplace: "",
    nationality: "日本",
    heightCm: null,
    measurements: {},
    facts: {},
    occupations: [],
    imageUrl: "",
    officialWebsite: "",
    socialLinks: {},
    externalIds: {},
    wikidataId: "Q1",
    wikipediaUrl: "",
    status: "auto-matched" as const,
    confidence: 0.9,
    fetchedAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    sources: [],
    ...overrides
  };
}

describe("entity profile image licensing", () => {
  it("renders non-actor aliases, biography, official website and public sources together", () => {
    const organization = profile({
      type: "maker",
      value: "Example Studio",
      displayName: "Example Studio",
      names: { ja: "エグザンプル", zh: "示例厂商", en: "Example Studio" },
      aliases: ["Example Studio", "エグザンプル", "示例厂商"],
      biography: "这是公开来源中的厂商简介。",
      officialWebsite: "https://example.com/about",
      sources: [{
        provider: "wikidata",
        title: "Example Studio · Wikidata",
        url: "https://www.wikidata.org/wiki/Q100",
        license: "CC0 1.0",
        language: "mul",
        fields: ["names", "biography", "officialWebsite"],
        confidence: 0.9,
        retrievedAt: "2026-07-29T00:00:00.000Z"
      }]
    });

    const markup = renderToStaticMarkup(createElement(EntityProfilePanel, { profile: organization }));
    expect(markup).toContain("厂商公开资料");
    expect(markup).toContain("别名");
    expect(markup).toContain("エグザンプル");
    expect(markup).toContain("示例厂商");
    expect(markup).toContain("这是公开来源中的厂商简介。");
    expect(markup).toContain("官方网站");
    expect(markup).toContain("https://example.com/about");
    expect(markup).toContain("Example Studio · Wikidata");
    expect(markup).toContain("https://www.wikidata.org/wiki/Q100");
  });

  it("keeps historical profiles renderable but hides images without per-file licensing", () => {
    const legacy = profile({
      imageUrl: "https://upload.wikimedia.org/legacy-unlicensed-image.jpg",
      sources: [{
        provider: "wikidata",
        title: "示例演员 · Wikidata",
        url: "https://www.wikidata.org/wiki/Q1",
        license: "CC0 1.0",
        language: "mul",
        fields: ["imageUrl"],
        confidence: 0.9,
        retrievedAt: "2026-07-29T00:00:00.000Z"
      }]
    });

    const markup = renderToStaticMarkup(createElement(EntityProfilePanel, { profile: legacy }));
    expect(markup).toContain("示例演员扩展资料");
    expect(markup).toContain("公开资料简介");
    expect(markup).not.toContain("legacy-unlicensed-image.jpg");
    expect(markup).not.toContain("<img");
  });

  it("renders a licensed Commons image with creator and license attribution links", () => {
    const licensed = profile({
      imageUrl: "https://upload.wikimedia.org/licensed-image.jpg",
      imageAttribution: {
        fileName: "File:Licensed image.jpg",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Licensed_image.jpg",
        creator: "Example Photographer",
        creatorUrl: "https://commons.wikimedia.org/wiki/User:Example",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        credit: "Example archive"
      },
      sources: [{
        provider: "wikimedia-commons",
        title: "Licensed image.jpg",
        url: "https://commons.wikimedia.org/wiki/File:Licensed_image.jpg",
        license: "CC BY-SA 4.0",
        language: "mul",
        fields: ["imageUrl"],
        confidence: 1,
        retrievedAt: "2026-07-29T00:00:00.000Z",
        facts: {
          imageUrl: "https://upload.wikimedia.org/licensed-image.jpg",
          image: { fileName: "Licensed image.jpg" }
        }
      }]
    });

    const markup = renderToStaticMarkup(createElement(EntityProfilePanel, { profile: licensed }));
    expect(markup).toContain("licensed-image.jpg");
    expect(markup).toContain("Example Photographer");
    expect(markup).toContain("CC BY-SA 4.0");
    expect(markup).toContain("Example archive");
    expect(markup).toContain("https://commons.wikimedia.org/wiki/User:Example");
    expect(markup).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(markup).toContain("Licensed image.jpg");
    expect(markup).toContain("Wikimedia Commons");
    expect(markup).not.toContain("官方人物页");
  });

  it("labels a non-Commons attribution as an official profile page", () => {
    const official = profile({
      imageUrl: "https://mines-pro.jp/talent_images/example.jpg",
      imageAttribution: {
        fileName: "example.jpg",
        sourceUrl: "https://mines-pro.jp/model/123",
        creator: "Mine’s",
        license: "unknown",
        licenseUrl: ""
      }
    });

    const markup = renderToStaticMarkup(createElement(EntityProfilePanel, { profile: official }));
    expect(markup).toContain("官方人物页");
    expect(markup).not.toContain("Wikimedia Commons");
    expect(markup).not.toContain("权利状态");
    expect(markup).not.toContain(">unknown<");
    expect(markup).toContain("https://mines-pro.jp/model/123");
  });
});

describe("historical profile image compatibility", () => {
  function insertHistoricalProfile(imageUrl: string) {
    db.prepare(`
      INSERT INTO entity_profiles (facet_type, facet_value, display_name, aliases_json, image_url, updated_at)
      VALUES ('actor', @value, '历史演员', '[]', @imageUrl, @updatedAt)
    `).run({ value: TEST_VALUE, imageUrl, updatedAt: "2026-07-29T00:00:00.000Z" });
  }

  it("does not expose a legacy image URL that has no Commons file evidence", () => {
    insertHistoricalProfile("https://upload.wikimedia.org/legacy.jpg");

    expect(getEntityExtendedProfile("actor", TEST_VALUE)).toMatchObject({
      imageUrl: "",
      imageAttribution: null
    });
  });

  it("uses the image URL stored with its Commons evidence instead of a stale profile URL", () => {
    insertHistoricalProfile("https://upload.wikimedia.org/stale-profile-image.jpg");
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        'test-commons-source', 'actor', @value, 'wikimedia-commons', 'Licensed image.jpg',
        'https://commons.wikimedia.org/wiki/File:Licensed_image.jpg', 'CC BY-SA 4.0',
        'mul', '["imageUrl"]', @payloadJson, 1, '2026-07-29T00:00:00.000Z'
      )
    `).run({
      value: TEST_VALUE,
      payloadJson: JSON.stringify({
        imageUrl: "https://upload.wikimedia.org/licensed-source-image.jpg",
        licenseDecision: "allowed-v1",
        image: {
          fileName: "Licensed image.jpg",
          sourceUrl: "https://commons.wikimedia.org/wiki/File:Licensed_image.jpg",
          creator: "Example Photographer",
          license: "CC BY-SA 4.0",
          licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/"
        }
      })
    });
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        'test-lower-priority-official', 'actor', @value, 'official-agency-mines', 'Official image',
        'https://mines-pro.jp/model/123', 'unknown', 'ja', '["facts"]', @payloadJson, 0.98,
        '2026-07-29T00:00:00.000Z'
      )
    `).run({
      value: TEST_VALUE,
      payloadJson: JSON.stringify({ profileImageCandidateUrl: "https://mines-pro.jp/talent_images/fallback.jpg" })
    });

    expect(getEntityExtendedProfile("actor", TEST_VALUE)).toMatchObject({
      imageUrl: "https://upload.wikimedia.org/licensed-source-image.jpg",
      imageAttribution: {
        creator: "Example Photographer",
        license: "CC BY-SA 4.0"
      }
    });
  });

  it("rejects a persisted Commons source when its license is not reusable", () => {
    insertHistoricalProfile("https://upload.wikimedia.org/raw-profile-image.jpg");
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        'test-restricted-source', 'actor', @value, 'wikimedia-commons', 'Restricted image.jpg',
        'https://commons.wikimedia.org/wiki/File:Restricted_image.jpg', 'All rights reserved',
        'mul', '["imageUrl"]', @payloadJson, 1, '2026-07-29T00:00:00.000Z'
      )
    `).run({
      value: TEST_VALUE,
      payloadJson: JSON.stringify({
        imageUrl: "https://upload.wikimedia.org/restricted-image.jpg",
        licenseDecision: "allowed-v1",
        image: {
          fileName: "Restricted image.jpg",
          sourceUrl: "https://commons.wikimedia.org/wiki/File:Restricted_image.jpg",
          creator: "Unknown photographer",
          license: "All rights reserved",
          licenseUrl: "https://example.com/restricted"
        }
      })
    });

    expect(getEntityExtendedProfile("actor", TEST_VALUE)).toMatchObject({
      imageUrl: "",
      imageAttribution: null
    });
  });

  it("withholds a historical research-cache image under the public strict policy", () => {
    insertHistoricalProfile("https://upload.wikimedia.org/stale.jpg");
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        'test-research-source', 'actor', @value, 'wikimedia-commons', 'Research image.webp',
        'https://commons.wikimedia.org/wiki/File:Research_image.webp', 'unknown',
        'mul', '["imageUrl"]', @payloadJson, 1, '2026-07-29T00:00:00.000Z'
      )
    `).run({
      value: TEST_VALUE,
      payloadJson: JSON.stringify({
        imageUrl: "https://upload.wikimedia.org/research-image.webp",
        licenseDecision: "research-cache-v1",
        image: {
          fileName: "Research image.webp",
          sourceUrl: "https://commons.wikimedia.org/wiki/File:Research_image.webp",
          creator: "unknown",
          license: "unknown",
          licenseUrl: "",
          rightsStatus: "unknown"
        }
      })
    });

    expect(getEntityExtendedProfile("actor", TEST_VALUE)).toMatchObject({
      imageUrl: "",
      imageAttribution: null
    });
  });

  it("falls back to a traceable same-domain official agency image when Commons is absent", () => {
    insertHistoricalProfile("");
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        'test-official-image-source', 'actor', @value, 'official-agency-mines', '历史演员 · Mine’s',
        'https://mines-pro.jp/model/123', 'unknown', 'ja', '["facts"]', @payloadJson, 0.98,
        '2026-07-29T00:00:00.000Z'
      )
    `).run({
      value: TEST_VALUE,
      payloadJson: JSON.stringify({
        agency: "Mine’s",
        profileImageCandidateUrl: "https://mines-pro.jp/talent_images/example.jpg"
      })
    });

    expect(getEntityExtendedProfile("actor", TEST_VALUE)).toMatchObject({
      imageUrl: "https://mines-pro.jp/talent_images/example.jpg",
      imageAttribution: {
        fileName: "example.jpg",
        sourceUrl: "https://mines-pro.jp/model/123",
        creator: "Mine’s",
        license: "unknown",
        licenseUrl: "",
        rightsStatus: "unknown",
        originalUrl: "https://mines-pro.jp/talent_images/example.jpg"
      }
    });
  });

  it("rejects a cross-domain official image candidate", () => {
    insertHistoricalProfile("");
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        'test-cross-domain-source', 'actor', @value, 'official-agency-mines', '历史演员 · Mine’s',
        'https://mines-pro.jp/model/123', 'unknown', 'ja', '["facts"]', @payloadJson, 0.98,
        '2026-07-29T00:00:00.000Z'
      )
    `).run({
      value: TEST_VALUE,
      payloadJson: JSON.stringify({ profileImageCandidateUrl: "https://images.example.com/example.jpg" })
    });

    expect(getEntityExtendedProfile("actor", TEST_VALUE)).toMatchObject({ imageUrl: "", imageAttribution: null });
  });

  it("does not expose a studio logo from a director product-credit source", () => {
    db.prepare(`
      INSERT INTO entity_profiles (facet_type, facet_value, display_name, aliases_json, image_url, updated_at)
      VALUES ('director', @value, '示例导演', '[]', '', @updatedAt)
    `).run({ value: TEST_VALUE, updatedAt: "2026-07-29T00:00:00.000Z" });
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        'test-director-product-logo', 'director', @value, 'official-product-bridge-moodyz',
        '官方作品导演字段', 'https://moodyz.com/works/detail/TEST001', 'unknown', 'ja',
        '["facts","image"]', @payloadJson, 0.99, '2026-07-29T00:00:00.000Z'
      )
    `).run({
      value: TEST_VALUE,
      payloadJson: JSON.stringify({
        profileImageCandidateUrl: "https://cdn.up-timely.com/image/30/site_design/base/logo_image/logo.png"
      })
    });

    expect(getEntityExtendedProfile("director", TEST_VALUE)).toMatchObject({
      imageUrl: "",
      imageAttribution: null
    });
  });
});
