import { describe, expect, it } from "vitest";
import { hasEmbeddedChineseVariant } from "../../server/src/subtitleTranslation.js";

describe("automatic subtitle translation embedded Chinese detection", () => {
  it.each([
    "CAWD-741-C",
    "CAWD-741CH",
    "CAWD-741-CH"
  ])("recognizes %s as an embedded Chinese variant", (basename) => {
    expect(hasEmbeddedChineseVariant({ basename, variant_tags: "[]" })).toBe(true);
  });

  it("recognizes CH variant tags from an older database row", () => {
    expect(hasEmbeddedChineseVariant({ basename: "CAWD-741", variant_tags: '["CH"]' })).toBe(true);
  });

  it("does not classify an ordinary basename as embedded Chinese", () => {
    expect(hasEmbeddedChineseVariant({ basename: "CAWD-741", variant_tags: "[]" })).toBe(false);
  });
});
