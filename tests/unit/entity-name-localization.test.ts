import { describe, expect, it } from "vitest";
import { shouldForceEntityNameOverride } from "../../server/src/entityNameLocalization.js";

describe("entity name localization overrides", () => {
  it("forces a curated override over an already valid-looking Chinese profile name", () => {
    expect(shouldForceEntityNameOverride({
      override: "纸巾",
      target: "profile",
      resolvedDisplayName: "组织"
    })).toBe(true);
  });

  it("forces the same correction into localized metadata", () => {
    expect(shouldForceEntityNameOverride({
      override: "大家的企划单体女优",
      target: "metadata",
      localized: "每个人都是基卡坦"
    })).toBe(true);
  });

  it("does not rewrite an entity once the override is already active", () => {
    expect(shouldForceEntityNameOverride({
      override: "MOODYZ",
      target: "profile",
      resolvedDisplayName: "ＭＯＯＤＹＺ"
    })).toBe(false);
  });

  it("does not force a translation without an autonomous override", () => {
    expect(shouldForceEntityNameOverride({
      target: "profile",
      resolvedDisplayName: "Prestige"
    })).toBe(false);
  });
});
