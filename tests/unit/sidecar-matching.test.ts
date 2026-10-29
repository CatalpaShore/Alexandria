import { describe, expect, it } from "vitest";
import { getSidecarLanguage, selectSidecarMedia } from "../../server/src/sidecarMatching.js";

describe("subtitle association", () => {
  const candidates = [
    { id: "one", basename: "Film", normalized_code: "FILM" },
    { id: "two", basename: "Film 2", normalized_code: "FILM-002" }
  ];
  it("recognizes language variants without confusing similarly named titles", () => {
    expect(selectSidecarMedia("Film 2.zh-Hant", candidates)?.id).toBe("two");
    expect(selectSidecarMedia("Film.en.forced", candidates)?.id).toBe("one");
    expect(selectSidecarMedia("Film 3.en", candidates)).toBeUndefined();
    expect(getSidecarLanguage("Film.zh-TW").language).toBe("zh-TW");
    expect(getSidecarLanguage("Film.zh-Hant").language).toBe("zh-TW");
    expect(getSidecarLanguage("Film.zh-CN").language).toBe("zh-CN");
  });
  it("leaves ambiguous versions unmatched", () => {
    const versions = [{ id: "a", basename: "Film", normalized_code: "FILM" }, { id: "b", basename: "Film", normalized_code: "FILM" }];
    expect(selectSidecarMedia("Film.en", versions)).toBeUndefined();
  });
});
