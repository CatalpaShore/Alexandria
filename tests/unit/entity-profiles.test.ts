import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../server/src/db";
import {
  buildPublicEntitySearchNames,
  chooseEntityOriginalName,
  chooseLocalizedEntityDisplayName,
  expandActorIdentityNames,
  fetchCommonsCategoryPortrait,
  fetchCommonsImageAttribution,
  formatEntityProfileForAgent,
  getEntityProfileCoverage,
  isEntityImageCacheDecisionAccepted,
  isActorIdentityRoleCompatible,
  isPublicEntityRoleCompatible,
  judgeActorIdentityWithLocalAi,
  judgePublicEntityIdentityWithLocalAi,
  localizeEntityBiography,
  normalizeActorCup,
  parseWikipediaInfobox,
  scoreActorIdentityCandidate,
  scoreCommonsCategoryPortraitCandidate,
  selectUniqueCommonsPortraitCandidate,
  shouldUseAiForActorIdentity,
  type EntityExtendedProfile
} from "../../server/src/entityProfiles";

describe("entity name localization", () => {
  it("uses a persisted Chinese name for Japanese entity displays", () => {
    expect(chooseLocalizedEntityDisplayName({
      type: "director",
      storedDisplayName: "奥園カヲル",
      names: { ja: "奥園カヲル", zh: "奥园薰" }
    })).toBe("奥园薰");
    expect(chooseLocalizedEntityDisplayName({
      type: "actor",
      storedDisplayName: "楓カレン",
      names: { ja: "楓カレン", zh: "楓可憐" },
      localizedCandidates: ["枫花恋"]
    })).toBe("枫花恋");
  });

  it("requires Chinese output for Japanese sources while keeping English names unchanged", () => {
    expect(chooseLocalizedEntityDisplayName({
      type: "series",
      storedDisplayName: "最高の愛人と中出し。",
      localizedCandidates: ["与最好的情妇一起体内射精。"]
    })).toBe("与最好的情妇一起体内射精。");
    expect(chooseLocalizedEntityDisplayName({
      type: "label",
      storedDisplayName: "MOODYZ",
      names: { zh: "情绪品牌" },
      localizedCandidates: ["情绪品牌"]
    })).toBe("MOODYZ");
    expect(chooseLocalizedEntityDisplayName({
      type: "maker",
      storedDisplayName: "ワンズファクトリー",
      localizedCandidates: ["WANZ FACTORY"]
    })).toBe("ワンズファクトリー");
    expect(chooseLocalizedEntityDisplayName({
      type: "maker",
      storedDisplayName: "ワンズファクトリー",
      localizedCandidates: ["万字工厂", "WANZ FACTORY"]
    })).toBe("万字工厂");
    expect(chooseLocalizedEntityDisplayName({
      type: "maker",
      storedDisplayName: "ムーディーズ",
      names: { ja: "ムーディーズ", zh: "MOODYZ" }
    })).toBe("MOODYZ");
    expect(chooseLocalizedEntityDisplayName({
      type: "label",
      storedDisplayName: "ドリームチケット",
      names: { ja: "ドリームチケット", zh: "Dream Ticket" }
    })).toBe("Dream Ticket");
    expect(chooseLocalizedEntityDisplayName({
      type: "director",
      storedDisplayName: "BIRDMAN鉄平",
      names: { ja: "BIRDMAN鉄平", zh: "BIRDMAN铁平" }
    })).toBe("BIRDMAN铁平");
  });

  it("does not present another Japanese spelling as a Chinese translation", () => {
    expect(chooseLocalizedEntityDisplayName({
      type: "maker",
      storedDisplayName: "ムーディーズ",
      localizedCandidates: ["ムーディーズ別名"]
    })).toBe("ムーディーズ");
  });

  it("keeps the Japanese canonical when storage already contains the Chinese display name", () => {
    expect(chooseEntityOriginalName({
      facetValue: "スモークフィルムズ/妄想族",
      storedDisplayName: "烟雾电影/幻象族",
      displayName: "烟雾电影/幻象族",
      names: { ja: "スモークフィルムズ/妄想族", zh: "烟雾电影/幻象族" }
    })).toBe("スモークフィルムズ/妄想族");
    expect(chooseEntityOriginalName({
      facetValue: "MOODYZ",
      storedDisplayName: "MOODYZ",
      displayName: "MOODYZ"
    })).toBeUndefined();
  });
});

describe("entity profile coverage", () => {
  it("counts a terminal no-match once and leaves other candidates pending", () => {
    const noMatch = "__coverage no match__";
    const noMatchVariant = "__coverage_no_match__";
    const pending = "__coverage_pending__";
    db.prepare(`
      INSERT INTO entity_profile_enrichment (
        facet_type, facet_value, display_name, status, attempt_count, updated_at
      ) VALUES ('series', @value, @value, 'not-found', 1, @updatedAt)
      ON CONFLICT(facet_type, facet_value) DO UPDATE SET
        status = 'not-found', updated_at = excluded.updated_at
    `).run({ value: noMatch, updatedAt: new Date().toISOString() });
    try {
      expect(getEntityProfileCoverage("series", [
        { value: noMatchVariant, aliases: [] },
        { value: pending, aliases: [] }
      ])).toMatchObject({ total: 2, enriched: 0, noMatch: 1, failed: 0, pending: 1 });
    } finally {
      db.prepare("DELETE FROM entity_profile_enrichment WHERE facet_type = 'series' AND facet_value = ?")
        .run(noMatch);
    }
  });
});

describe("entity biography localization", () => {
  it("localizes generic English actor descriptions without rewriting sourced biographies", () => {
    expect(localizeEntityBiography("Japanese AV idol")).toBe("日本AV女优。");
    expect(localizeEntityBiography("Japanese pornographic actress")).toBe("日本AV女优。");
    expect(localizeEntityBiography("  独自の出典付き紹介  ")).toBe("独自の出典付き紹介");
  });
});

describe("public entity multilingual search names", () => {
  it("keeps original, localized, romanized, and persisted aliases before lookup", () => {
    expect(buildPublicEntitySearchNames(
      "director",
      ["豆沢豆太郎"],
      [
        { sourceName: "豆沢豆太郎", localizedName: "豆泽真太郎" },
        { sourceName: "豆泽真太郎", localizedName: "Mametaro Mamezawa" }
      ],
      ["豆沢監督"]
    )).toEqual([
      "豆沢豆太郎",
      "Mametaro Mamezawa",
      "豆沢監督",
      "豆泽真太郎"
    ]);
  });

  it("does not collapse unrelated names that are absent from the metadata bridge", () => {
    expect(buildPublicEntitySearchNames(
      "director",
      ["沢庵", "卓安"],
      [{ sourceName: "別監督", localizedName: "Other Director" }]
    )).toEqual(["沢庵", "卓安"]);
  });

  it("does not split slash-delimited organization names into unrelated entities", () => {
    expect(buildPublicEntitySearchNames(
      "label",
      ["スモークフィルムズ/妄想族"],
      [{ sourceName: "妄想族", localizedName: "妄想族" }]
    )).toEqual(["スモークフィルムズ/妄想族"]);

    expect(buildPublicEntitySearchNames(
      "maker",
      ["独立スタジオ/制作グループ"],
      [{ sourceName: "制作グループ", localizedName: "制作集团" }]
    )).toEqual(["独立スタジオ/制作グループ"]);
  });
});

describe("actor identity name expansion", () => {
  it("splits a current name and parenthetical former name", () => {
    expect(expandActorIdentityNames(["森沢かな（飯岡かなこ）"])).toEqual([
      "森沢かな(飯岡かなこ)", "森沢かな", "飯岡かなこ"
    ]);
  });

  it("keeps slash-separated aliases available independently", () => {
    expect(expandActorIdentityNames(["新名 / 旧名"])).toEqual(["新名 / 旧名", "新名", "旧名"]);
  });
});

describe("actor identity candidate scoring", () => {
  it("rejects exact-name public entities outside the adult performer role", () => {
    expect(isActorIdentityRoleCompatible(["Q1079215"])).toBe(true);
    expect(isActorIdentityRoleCompatible(["Q2066131", "Q937857"])).toBe(false);
  });

  it("prefers an adult performer over a non-adult homonym with otherwise equal evidence", () => {
    const performer = scoreActorIdentityCandidate({
      hasWikipedia: true, hasBirthDate: true, exactPrimaryName: true, isAdultPerformer: true
    });
    const homonym = scoreActorIdentityCandidate({
      hasWikipedia: true, hasBirthDate: true, exactPrimaryName: true, isAdultPerformer: false
    });
    expect(performer).toBeGreaterThan(homonym);
  });

  it("routes close candidates to AI while keeping a clear winner deterministic", () => {
    expect(shouldUseAiForActorIdentity([0.95, 0.91])).toBe(true);
    expect(shouldUseAiForActorIdentity([0.95, 0.84])).toBe(false);
    expect(shouldUseAiForActorIdentity([0.95])).toBe(false);
  });
});

afterEach(() => vi.restoreAllMocks());

function profile(overrides: Partial<EntityExtendedProfile> = {}): EntityExtendedProfile {
  return {
    type: "actor",
    value: "三上悠亜",
    displayName: "三上悠亚",
    names: { ja: "三上悠亜", zh: "三上悠亞" },
    aliases: ["三上悠亜", "三上悠亚"],
    biography: "公开资料简介。",
    birthDate: "1993-08-16",
    birthplace: "名古屋市",
    nationality: "日本",
    heightCm: 159,
    measurements: { bustCm: 84, waistCm: 58, hipsCm: 88, cup: "G" },
    facts: {},
    occupations: ["日本偶像", "AV女优"],
    imageUrl: "",
    imageAttribution: null,
    officialWebsite: "",
    socialLinks: {},
    externalIds: {},
    wikidataId: "Q22128111",
    wikipediaUrl: "https://zh.wikipedia.org/wiki/example",
    status: "auto-resolved",
    confidence: 0.8,
    fetchedAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    sources: [{
      provider: "wikidata",
      title: "三上悠亚 · Wikidata",
      url: "https://www.wikidata.org/wiki/Q22128111",
      license: "CC0 1.0",
      language: "mul",
      fields: ["heightCm"],
      confidence: 0.8,
      retrievedAt: "2026-07-29T00:00:00.000Z"
    }],
    ...overrides
  };
}

describe("Wikipedia actor profile parsing", () => {
  it("normalizes cup labels without mixing regional band-size notation into the cup", () => {
    expect(normalizeActorCup("K (36G UK)")).toBe("K");
    expect(normalizeActorCup("36G UK")).toBe("G");
    expect(normalizeActorCup("Gカップ")).toBe("G");
    expect(normalizeActorCup("K36GUK")).toBe("K");
  });

  it("extracts Japanese and Chinese infobox body measurements", () => {
    const result = parseWikipediaInfobox(`
      {{Infobox person
      | 身長 = 159 cm
      | バスト = 84
      | ウエスト = 58
      | ヒップ = 88
      | カップ = Gカップ
      }}`);

    expect(result).toEqual({
      heightCm: 159,
      measurements: { bustCm: 84, waistCm: 58, hipsCm: 88, cup: "G" }
    });
  });

  it("supports combined measurements while keeping missing values absent", () => {
    expect(parseWikipediaInfobox("| 三围 = 88 - 60 - 90 cm")).toEqual({
      heightCm: null,
      measurements: { bustCm: 88, waistCm: 60, hipsCm: 90 }
    });
    expect(parseWikipediaInfobox("| 身高 = 1.63 m")).toEqual({
      heightCm: 163,
      measurements: {}
    });
  });
});

describe("Wikimedia Commons per-file licensing", () => {
  it("keeps allowed-v1 compatible while strict mode excludes research-cache-v1", () => {
    expect(isEntityImageCacheDecisionAccepted("allowed-v1", "research")).toBe(true);
    expect(isEntityImageCacheDecisionAccepted("allowed-v1", "strict")).toBe(true);
    expect(isEntityImageCacheDecisionAccepted("research-cache-v1", "research")).toBe(true);
    expect(isEntityImageCacheDecisionAccepted("research-cache-v1", "strict")).toBe(false);
  });

  it("retains allowed-v1 for strictly reusable images discovered under research mode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [{
        title: "File:Open portrait.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/open.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Open_portrait.jpg",
          mime: "image/jpeg",
          extmetadata: {
            Artist: { value: "Open photographer" },
            LicenseShortName: { value: "CC BY 4.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" }
          }
        }]
      }] }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsImageAttribution("Open portrait.jpg", "research")).resolves.toMatchObject({
      cacheDecision: "allowed-v1",
      attribution: { rightsStatus: "open-license" }
    });
  });

  it("extracts a sanitized creator, file source and reusable license", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:Licensed portrait.jpg",
          imageinfo: [{
            url: "https://upload.wikimedia.org/original.jpg",
            thumburl: "https://upload.wikimedia.org/thumb-720.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Licensed_portrait.jpg",
            mime: "image/jpeg",
            extmetadata: {
              Artist: { value: '<a href="https://commons.wikimedia.org/wiki/User:Example">Example Photographer</a>' },
              LicenseShortName: { value: "CC BY-SA 4.0" },
              LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
              Credit: { value: "Example archive &amp; photographer" }
            }
          }]
        }]
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsImageAttribution("Licensed portrait.jpg", "strict")).resolves.toEqual({
      imageUrl: "https://upload.wikimedia.org/thumb-720.jpg",
      cacheDecision: "allowed-v1",
      attribution: {
        fileName: "Licensed portrait.jpg",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Licensed_portrait.jpg",
        creator: "Example Photographer",
        creatorUrl: "https://commons.wikimedia.org/wiki/User:Example",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        rightsStatus: "open-license",
        credit: "Example archive & photographer",
        originalUrl: "https://upload.wikimedia.org/original.jpg",
        contentType: "image/jpeg",
        requestedThumbWidth: 720
      }
    });
  });

  it("rejects an image when per-file license evidence is incomplete or unsupported", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:Unknown.jpg",
          imageinfo: [{
            url: "https://upload.wikimedia.org/unknown.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Unknown.jpg",
            mime: "image/jpeg",
            extmetadata: {
              Artist: { value: "Unknown photographer" },
              LicenseShortName: { value: "All rights reserved" },
              LicenseUrl: { value: "https://example.com/restricted" }
            }
          }]
        }]
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsImageAttribution("File:Unknown.jpg", "strict")).resolves.toBeNull();
  });

  it("keeps a public Commons image in research cache with explicit restricted rights metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [{
        title: "File:Research portrait.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/research.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Research_portrait.jpg",
          mime: "image/jpeg",
          sha1: "0123456789abcdef0123456789abcdef01234567",
          extmetadata: {
            Artist: { value: "Archive photographer" },
            LicenseShortName: { value: "All rights reserved" },
            LicenseUrl: { value: "https://example.com/original-rights" },
            Restrictions: { value: "non-commercial" }
          }
        }]
      }] }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsImageAttribution("Research portrait.jpg", "research")).resolves.toMatchObject({
      imageUrl: "https://upload.wikimedia.org/research.jpg",
      cacheDecision: "research-cache-v1",
      attribution: {
        creator: "Archive photographer",
        license: "All rights reserved",
        licenseUrl: "https://example.com/original-rights",
        rightsStatus: "restricted"
      }
    });
  });

  it("records unknown rights metadata instead of dropping a public Commons image in research mode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [{
        title: "File:Unlabelled portrait.webp",
        imageinfo: [{
          url: "https://upload.wikimedia.org/unlabelled.webp",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Unlabelled_portrait.webp",
          mime: "image/webp",
          extmetadata: {}
        }]
      }] }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsImageAttribution("Unlabelled portrait.webp", "research")).resolves.toMatchObject({
      cacheDecision: "research-cache-v1",
      attribution: { creator: "unknown", license: "unknown", licenseUrl: "", rightsStatus: "unknown" }
    });
  });

  it("still rejects non-image Commons content in research mode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [{
        title: "File:Not an image.svg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/not-an-image.svg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Not_an_image.svg",
          mime: "image/svg+xml",
          extmetadata: {}
        }]
      }] }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsImageAttribution("Not an image.svg", "research")).resolves.toBeNull();
  });

  it("normalizes the CC0 deed URL variant returned by Commons", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [{
        title: "File:CC0 portrait.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/cc0.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:CC0_portrait.jpg",
          mime: "image/jpeg",
          extmetadata: {
            Artist: { value: "Example Photographer" },
            LicenseShortName: { value: "CC0" },
            LicenseUrl: { value: "http://creativecommons.org/publicdomain/zero/1.0/deed.en" },
            Copyrighted: { value: "True" }
          }
        }]
      }] }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsImageAttribution("CC0 portrait.jpg", "strict")).resolves.toMatchObject({
      cacheDecision: "allowed-v1",
      attribution: {
        license: "CC0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        rightsStatus: "public-domain"
      }
    });
  });

  it("accepts a standard Commons Flickr license review without ignoring arbitrary permission text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [{
        title: "File:Reviewed portrait.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/reviewed.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Reviewed_portrait.jpg",
          mime: "image/jpeg",
          extmetadata: {
            Artist: { value: "Example Photographer" },
            LicenseShortName: { value: "CC BY 2.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by/2.0" },
            Permission: { value: '<div class="licensetpl">https://creativecommons.org/licenses/by/2.0</div><table id="FlickrReview"><tr><td>reviewed</td></tr></table>' }
          }
        }]
      }] }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsImageAttribution("Reviewed portrait.jpg", "strict")).resolves.toMatchObject({
      attribution: { permissionSummary: "Commons 已核验原始平台许可" }
    });
  });
});

describe("Wikimedia Commons category portrait fallback", () => {
  const names = ["斎藤あみり", "Amiri Saitō", "Amiri Saito"];

  it("rejects signatures, group shots, landscape banners, and event-only files", () => {
    expect(scoreCommonsCategoryPortraitCandidate({
      fileName: "Amiri Saito signature.png", mime: "image/png",
      width: 1200, height: 800, description: "signature"
    }, names)).toBeNull();
    expect(scoreCommonsCategoryPortraitCandidate({
      fileName: "Amiri Saito and cast.jpg", mime: "image/jpeg",
      width: 1600, height: 2200, description: "group photo"
    }, names)).toBeNull();
    expect(scoreCommonsCategoryPortraitCandidate({
      fileName: "Festival stage 2025.jpg", mime: "image/jpeg",
      width: 1600, height: 2200, description: "Annual event"
    }, names)).toBeNull();
    expect(scoreCommonsCategoryPortraitCandidate({
      fileName: "Festival stage 2025.jpg", mime: "image/jpeg",
      width: 1600, height: 2200, description: "Annual event",
      depictsWikidataIds: ["Q84461660"]
    }, names, "Q84461660")).toBeGreaterThan(7.25);
    expect(scoreCommonsCategoryPortraitCandidate({
      fileName: "Amiri Saito banner.jpg", mime: "image/jpeg",
      width: 2400, height: 600, description: ""
    }, names)).toBeNull();
  });

  it("selects only a uniquely strongest, multilingual-name-bearing portrait", () => {
    expect(selectUniqueCommonsPortraitCandidate([{
      fileName: "Amiri Saito portrait 2025.jpg", mime: "image/jpeg",
      width: 1600, height: 2200, description: "斎藤あみり portrait"
    }, {
      fileName: "Amiri Saito 02.jpg", mime: "image/jpeg",
      width: 900, height: 1400, description: ""
    }], names)).toMatchObject({ fileName: "Amiri Saito portrait 2025.jpg" });

    expect(selectUniqueCommonsPortraitCandidate([{
      fileName: "Amiri Saito 01.jpg", mime: "image/jpeg",
      width: 1600, height: 2200, description: "斎藤あみり"
    }, {
      fileName: "Amiri Saito 02.jpg", mime: "image/jpeg",
      width: 1600, height: 2200, description: "斎藤あみり"
    }], names)).toBeNull();
  });

  it("preserves P373 discovery provenance while reusing per-file attribution", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: { pages: [{
          pageid: 4242,
          title: "File:Amiri Saito portrait.jpg",
          imageinfo: [{
            mime: "image/jpeg", width: 1600, height: 2200,
            extmetadata: { ImageDescription: { value: "斎藤あみり portrait" } }
          }]
        }] }
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        entities: { M4242: { claims: { P180: [{ mainsnak: { datavalue: { value: { id: "Q84461660" } } } }] } } }
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: { pages: [{
          title: "File:Amiri Saito portrait.jpg",
          imageinfo: [{
            url: "https://upload.wikimedia.org/amiri-original.jpg",
            thumburl: "https://upload.wikimedia.org/amiri-720.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Amiri_Saito_portrait.jpg",
            mime: "image/jpeg", width: 1600, height: 2200,
            extmetadata: {
              Artist: { value: "Commons photographer" },
              LicenseShortName: { value: "CC BY 4.0" },
              LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" }
            }
          }]
        }] }
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCommonsCategoryPortrait("Category:Amiri Saitō", names, "research", "Q84461660")).resolves.toMatchObject({
      cacheDecision: "allowed-v1",
      attribution: { fileName: "Amiri Saito portrait.jpg" },
      discovery: { method: "wikidata-p373", commonsCategory: "Amiri Saitō" }
    });
  });
});

describe("Agent entity profile evidence", () => {
  it("formats sourced measurements and cup without citation placeholders", () => {
    const evidence = formatEntityProfileForAgent(profile());
    expect(evidence).toContain("身高: 159 cm");
    expect(evidence).toContain("三围: 84/58/88 cm");
    expect(evidence).toContain("罩杯: G");
    expect(evidence).toContain("资料状态: 来源存在差异，系统已自动择优");
    expect(evidence).not.toMatch(/\[\d+\]/u);
  });

  it("does not invent absent measurements", () => {
    const evidence = formatEntityProfileForAgent(profile({ measurements: {}, heightCm: null }));
    expect(evidence).not.toContain("身高:");
    expect(evidence).not.toContain("三围:");
    expect(evidence).not.toContain("罩杯:");
  });

  it("lists one readable citation when multiple source records share the same URL", () => {
    const sourceUrl = "https://www.wikidata.org/wiki/Q100";
    const evidence = formatEntityProfileForAgent(profile({
      sources: [
        { provider: "custom-bridge", title: "人物稳定身份", url: sourceUrl, license: "CC0 1.0",
          language: "ja", fields: ["names"], confidence: 0.99, retrievedAt: "2026-07-30T00:00:00.000Z" },
        { provider: "wikidata", title: "人物 · Wikidata", url: sourceUrl, license: "CC0 1.0",
          language: "mul", fields: ["facts"], confidence: 0.99, retrievedAt: "2026-07-30T00:00:00.000Z" }
      ]
    }));
    expect(evidence.match(/https:\/\/www\.wikidata\.org\/wiki\/Q100/gu)).toHaveLength(1);
    expect(evidence).toContain("人物稳定身份");
  });
});

describe("local AI actor identity disambiguation", () => {
  const candidates = [
    {
      id: "Q1",
      names: ["新井リマ", "Rima Arai", "新井莉玛"],
      descriptions: { ja: "日本のAV女優" },
      birthDate: "2000-10-03",
      hasJapaneseWikipedia: true,
      hasChineseWikipedia: false,
      isAdultPerformer: true
    },
    {
      id: "Q2",
      names: ["新井理馬"],
      descriptions: { ja: "日本の男性俳優" },
      birthDate: "1980-01-01",
      hasJapaneseWikipedia: false,
      hasChineseWikipedia: false,
      isAdultPerformer: false
    }
  ];

  it("accepts a high-confidence candidate selected from the supplied evidence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      message: { content: JSON.stringify({ selectedId: "Q1", confidence: 0.94, reason: "日文名和罗马字别名一致" }) }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(judgeActorIdentityWithLocalAi(["新井リマ", "Rima Arai"], candidates)).resolves.toEqual({
      selectedId: "Q1",
      confidence: 0.9,
      reason: "日文名和罗马字别名一致"
    });
  });

  it("refuses low-confidence or out-of-set merge decisions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      message: { content: JSON.stringify({ selectedId: "Q1", confidence: 0.61, reason: "证据不足" }) }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(judgeActorIdentityWithLocalAi(["新井"], candidates)).resolves.toBeNull();
  });
});

describe("generic public entity enrichment", () => {
  it("requires an explicit director role signal for ambiguous public people", () => {
    expect(isPublicEntityRoleCompatible("director", ["日本の映画監督"])).toBe(true);
    expect(isPublicEntityRoleCompatible("director", ["Japanese filmmaker and director"])).toBe(true);
    expect(isPublicEntityRoleCompatible("director", ["演员", "歌手", "舞者"])).toBe(false);
    expect(isPublicEntityRoleCompatible("maker", ["Japanese adult video manufacturer"])).toBe(true);
    expect(isPublicEntityRoleCompatible("label", ["日本のアダルトビデオレーベル"])).toBe(true);
    expect(isPublicEntityRoleCompatible("maker", [])).toBe(false);
    expect(isPublicEntityRoleCompatible("maker", ["independent record label"])).toBe(false);
    expect(isPublicEntityRoleCompatible("label", ["Russian fashion brand and clothing retailer"])).toBe(false);
  });

  it("formats organization facts for deterministic Agent answers", () => {
    const evidence = formatEntityProfileForAgent(profile({
      type: "maker",
      value: "Example Studio",
      displayName: "Example Studio",
      names: { ja: "エグザンプル", zh: "示例厂商", en: "Example Studio" },
      aliases: ["Example Studio", "エグザンプル", "示例厂商"],
      biography: "Example Studio 是已入库的公开厂商资料。",
      birthDate: null,
      birthplace: "",
      nationality: "日本",
      heightCm: null,
      measurements: {},
      occupations: [],
      officialWebsite: "https://example.com/about",
      sources: [{
        provider: "wikidata",
        title: "Example Studio · Wikidata",
        url: "https://www.wikidata.org/wiki/Q100",
        license: "CC0 1.0",
        language: "mul",
        fields: ["names", "facts"],
        confidence: 0.9,
        retrievedAt: "2026-07-29T00:00:00.000Z"
      }],
      facts: {
        inceptionDate: "2001-04-01",
        headquarters: "东京都",
        country: "日本",
        industry: ["成人视频产业", "电影制作"],
        relatedMaker: "Example Group",
        matchedLibraryWorkCount: "12",
        identityCodes: ["EX-001", "EX-002", "EX-003", "EX-004", "EX-005", "EX-006", "EX-007", "EX-008", "EX-009"]
      }
    }));
    expect(evidence).toContain("成立时间: 2001-04-01");
    expect(evidence).toContain("总部: 东京都");
    expect(evidence).toContain("行业: 成人视频产业、电影制作");
    expect(evidence).toContain("所属厂商: Example Group");
    expect(evidence).toContain("馆藏身份验证作品数: 12");
    expect(evidence).toContain("身份桥番号: EX-001、EX-002、EX-003、EX-004、EX-005、EX-006、EX-007、EX-008 等 9 项");
    expect(evidence).toContain("别名: エグザンプル、示例厂商");
    expect(evidence).toContain("简介: Example Studio 是已入库的公开厂商资料。");
    expect(evidence).toContain("官方网站: https://example.com/about");
    expect(evidence).toContain("Example Studio · Wikidata（https://www.wikidata.org/wiki/Q100）");
    expect(evidence).not.toContain("三围:");
  });

  it("lets local AI accept a supported organization and rejects low confidence", async () => {
    const candidates = [{
      id: "Q100",
      names: ["Example Studio", "エグザンプル"],
      descriptions: { ja: "日本の映像制作会社" },
      entityKind: "organization" as const,
      hasWikipedia: true,
      hasOfficialWebsite: true,
      roleSignals: ["日本の映像制作会社"]
    }];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      message: { content: JSON.stringify({ selectedId: "Q100", confidence: 0.91, reason: "原名、业务和官网一致" }) }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(judgePublicEntityIdentityWithLocalAi("maker", ["Example Studio"], candidates)).resolves.toEqual({
      selectedId: "Q100", confidence: 0.9, reason: "原名、业务和官网一致"
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      message: { content: JSON.stringify({ selectedId: "Q100", confidence: 0.6, reason: "同名但证据不足" }) }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(judgePublicEntityIdentityWithLocalAi("maker", ["Example"], candidates)).resolves.toBeNull();
  });

  it("rejects an AI-selected director homonym without director role evidence", async () => {
    const candidates = [{
      id: "Q851515",
      names: ["AKIRA"],
      descriptions: { zh: "日本演员、歌手及舞者" },
      entityKind: "human" as const,
      hasWikipedia: true,
      hasOfficialWebsite: true,
      roleSignals: []
    }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      message: { content: JSON.stringify({ selectedId: "Q851515", confidence: 0.96, reason: "同名" }) }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(judgePublicEntityIdentityWithLocalAi("director", ["AKIRA"], candidates)).resolves.toBeNull();
  });
});
