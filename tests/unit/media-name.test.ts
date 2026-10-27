import { describe, expect, it } from "vitest";
import { parseMediaName } from "../../server/src/mediaName.js";

describe("parseMediaName", () => {
  it("normalizes separated and compact JAV codes", () => {
    expect(parseMediaName("abc-123-C", "A")).toMatchObject({
      normalizedCode: "ABC-123",
      variantTags: ["C"]
    });
    expect(parseMediaName("ABP537U", "A")).toMatchObject({
      normalizedCode: "ABP-537",
      variantTags: ["U"]
    });
    expect(parseMediaName("ABP537CH", "A")).toMatchObject({
      normalizedCode: "ABP-537",
      variantTags: ["C"]
    });
  });

  it("normalizes compact CH variants as embedded Chinese", () => {
    expect(parseMediaName("CAWD741CH", "A")).toMatchObject({
      normalizedCode: "CAWD-741",
      variantTags: ["C"]
    });
  });

  it("normalizes FC2 PPV filenames while preserving part tags", () => {
    expect(parseMediaName("FC2PPV-4916515-1", "FC2")).toMatchObject({
      codePrefix: "FC2",
      normalizedCode: "FC2-PPV-4916515",
      variantTags: ["PPV", "1"]
    });
  });

  it("does not invent a numeric code for sentence-like filenames", () => {
    const parsed = parseMediaName("this-is-a-regular-download-without-a-code", "Download");
    expect(parsed.codePrefix).toBe("");
    expect(parsed.codeNumber).toBe("");
  });
});
