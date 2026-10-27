import { describe, expect, it } from "vitest";

import { improveMetadataTranslation, improveTranslatedText } from "../../scripts/lib/jav-translation-quality.mjs";

describe("metadata translation quality", () => {
  it("keeps the localized series name when the source metadata uses its English alias", () => {
    expect(improveTranslatedText("Coercion Suite", "胁迫套房", "series")).toBe("胁迫套房");
  });

  it("normalizes Japanese and English aliases to the same Chinese series name", () => {
    expect(improveTranslatedText("脅迫スイートルーム", "", "series")).toBe("胁迫套房");
    expect(improveTranslatedText("Coercion Suite", "", "series")).toBe("胁迫套房");
  });

  it.each([
    ["美波こづえ", "美波梢"],
    ["大橋未久", "大桥未久"],
    ["蒼乃美月", "苍乃美月"],
    ["岬あずさ", "岬梓"],
    ["胡桃さくら", "胡桃樱"],
    ["塩見彩", "盐见彩"],
    ["佐々木あき", "佐佐木明希"]
  ])("normalizes the actor display name %s", (source, expected) => {
    expect(improveTranslatedText(source, source, "actor")).toBe(expected);
  });

  it("replaces a superseded actor translation in narrative fields instead of appending a duplicate", () => {
    const result = improveMetadataTranslation({
      title: "顔射の美学 蒼乃美月",
      summary: "蒼乃美月の作品",
      director: "",
      actors: ["蒼乃美月"],
      genres: [],
      maker: "",
      label: "",
      series: ""
    }, {
      titleZh: "颜射的美学 青野瑞希",
      summaryZh: "青野瑞希的作品",
      directorZh: "",
      actorsZh: ["青野瑞希"],
      genresZh: [],
      makerZh: "",
      labelZh: "",
      seriesZh: ""
    });

    expect(result.titleZh).toBe("颜射的美学 苍乃美月");
    expect(result.summaryZh).toBe("苍乃美月的作品");
  });
});
