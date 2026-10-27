import { describe, expect, it } from "vitest";
import {
  isEntityImageDownloadUrlAllowed,
  resolveEntityProfileImageUrl
} from "../../server/src/entityProfileImageCache.js";
import type { EntityExtendedProfile } from "../../server/src/entityProfiles.js";

function profile(overrides: Partial<EntityExtendedProfile> = {}): EntityExtendedProfile {
  return {
    type: "actor",
    value: "月雲よる",
    displayName: "月雲よる",
    names: { ja: "月雲よる" },
    aliases: [],
    biography: "",
    birthDate: null,
    birthplace: "",
    nationality: "",
    heightCm: null,
    measurements: {},
    facts: {},
    occupations: [],
    imageUrl: "https://upload.wikimedia.org/example.jpg",
    imageAttribution: {
      fileName: "Example.jpg",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      creator: "Example creator",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      sha1: "0123456789abcdef0123456789abcdef01234567"
    },
    officialWebsite: "",
    socialLinks: {},
    externalIds: {},
    wikidataId: "Q126946676",
    wikipediaUrl: "",
    status: "auto-matched",
    confidence: 0.9,
    fetchedAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
    sources: [],
    ...overrides
  };
}

describe("entity profile image delivery", () => {
  it("rejects redirects that leave the source-specific trusted host", () => {
    expect(isEntityImageDownloadUrlAllowed({
      sourceKind: "official-agency",
      sourceUrl: "https://mines-pro.jp/model/123",
      responseUrl: "https://mines-pro.jp/talent_images/example.jpg"
    })).toBe(true);
    expect(isEntityImageDownloadUrlAllowed({
      sourceKind: "official-agency",
      sourceUrl: "https://mines-pro.jp/model/123",
      responseUrl: "https://images.example.com/example.jpg"
    })).toBe(false);
    expect(isEntityImageDownloadUrlAllowed({
      sourceKind: "official-agency",
      sourceUrl: "https://x.com/DANDY_xxx",
      responseUrl: "https://pbs.twimg.com/profile_images/3223892109/example_200x200.png"
    })).toBe(true);
    expect(isEntityImageDownloadUrlAllowed({
      sourceKind: "official-agency",
      sourceUrl: "https://x.com/DANDY_xxx",
      responseUrl: "https://pbs.twimg.com/media/example.jpg"
    })).toBe(false);
    expect(isEntityImageDownloadUrlAllowed({
      sourceKind: "wikimedia-commons",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      responseUrl: "https://upload.wikimedia.org/example.jpg"
    })).toBe(true);
    expect(isEntityImageDownloadUrlAllowed({
      sourceKind: "wikimedia-commons",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      responseUrl: "https://example.com/example.jpg"
    })).toBe(false);
    expect(isEntityImageDownloadUrlAllowed({
      sourceKind: "public-actor-directory",
      sourceUrl: "https://r18.dev/videos/vod/movies/list/?id=1035527&type=actress",
      responseUrl: "https://awsimgsrc.dmm.com/dig/mono/actjpgs/yurisaki_urumi.jpg"
    })).toBe(true);
    expect(isEntityImageDownloadUrlAllowed({
      sourceKind: "public-actor-directory",
      sourceUrl: "https://r18.dev/videos/vod/movies/list/?id=1035527&type=actress",
      responseUrl: "https://awsimgsrc.dmm.com/dig/mono/movie/ipz00836/ipz00836pl.jpg"
    })).toBe(false);
  });

  it("rewrites a licensed Commons image to the fixed entity route", () => {
    expect(resolveEntityProfileImageUrl(profile())?.imageUrl)
      .toBe("/api/entities/actor/%E6%9C%88%E9%9B%B2%E3%82%88%E3%82%8B/profile-image");
  });

  it("keeps the original URL when the attribution has no stable Commons SHA1", () => {
    const input = profile({
      imageAttribution: {
        ...profile().imageAttribution!,
        sha1: undefined
      }
    });
    expect(resolveEntityProfileImageUrl(input)).toBe(input);
    expect(resolveEntityProfileImageUrl(input)?.imageUrl).toBe("https://upload.wikimedia.org/example.jpg");
  });

  it("rewrites a same-domain official agency image without requiring a Commons SHA1", () => {
    const input = profile({
      imageUrl: "https://mines-pro.jp/talent_images/example.jpg",
      imageAttribution: {
        fileName: "example.jpg",
        sourceUrl: "https://mines-pro.jp/model/123",
        creator: "Mine’s",
        license: "unknown",
        licenseUrl: "",
        rightsStatus: "unknown"
      }
    });
    expect(resolveEntityProfileImageUrl(input)?.imageUrl)
      .toBe("/api/entities/actor/%E6%9C%88%E9%9B%B2%E3%82%88%E3%82%8B/profile-image");
  });

  it("rewrites an exact R18 performer headshot while rejecting product covers", () => {
    const input = profile({
      imageUrl: "https://awsimgsrc.dmm.com/dig/mono/actjpgs/yurisaki_urumi.jpg",
      imageAttribution: {
        fileName: "yurisaki_urumi.jpg",
        sourceUrl: "https://r18.dev/videos/vod/movies/list/?id=1035527&type=actress",
        creator: "public-r18dev-actor",
        license: "unknown",
        licenseUrl: "",
        rightsStatus: "unknown"
      }
    });
    expect(resolveEntityProfileImageUrl(input)?.imageUrl)
      .toBe("/api/entities/actor/%E6%9C%88%E9%9B%B2%E3%82%88%E3%82%8B/profile-image");
  });

  it("does not rewrite an official attribution whose image crosses to an untrusted domain", () => {
    const input = profile({
      imageUrl: "https://images.example.com/example.jpg",
      imageAttribution: {
        fileName: "example.jpg",
        sourceUrl: "https://mines-pro.jp/model/123",
        creator: "Mine’s",
        license: "unknown",
        licenseUrl: "",
        rightsStatus: "unknown"
      }
    });
    expect(resolveEntityProfileImageUrl(input)).toBe(input);
  });

  it("preserves profiles without an image and null profiles", () => {
    const input = profile({ imageUrl: "", imageAttribution: null });
    expect(resolveEntityProfileImageUrl(input)).toBe(input);
    expect(resolveEntityProfileImageUrl(null)).toBeNull();
  });
});
