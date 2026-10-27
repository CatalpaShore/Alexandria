import { describe, expect, it } from "vitest";
import { canonicalCode, pickBestSearchResult } from "../../server/src/metadata";

describe("metadata code normalization", () => {
  it("matches local FC2-PPV identifiers to MetaTube FC2 numbers", () => {
    expect(canonicalCode("FC2-PPV-4719116")).toBe(canonicalCode("FC2-4719116"));
  });

  it("keeps ordinary JAV code families distinct", () => {
    expect(canonicalCode("ABF-381")).not.toBe(canonicalCode("ABP-381"));
  });

  it("does not adopt an empty or substring number as a different work", () => {
    expect(pickBestSearchResult("ABP-123", [
      { number: "", title: "Unknown" },
      { number: "ABP-12", title: "Shorter number" },
      { number: "ABP-1234", title: "Longer number" }
    ])).toBeNull();
  });

  it("accepts padding aliases while keeping the complete numeric identifier", () => {
    const match = { number: "ABP00123", provider: "FANZA", title: "Exact" };
    expect(pickBestSearchResult("ABP-123", [match])).toBe(match);
    expect(pickBestSearchResult("FC2-PPV-4719116", [{ number: "FC2-471911" }])).toBeNull();
    expect(pickBestSearchResult("FC2-PPV-4719116", [{ number: "FC2-4719116" }])).not.toBeNull();
  });
});
