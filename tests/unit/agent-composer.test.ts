import { describe, expect, it } from "vitest";
import { applyComposerSuggestion, getComposerSuggestions, parseAgentComposer, removeComposerToken } from "../../client/src/components/agent/agentComposer";

describe("agent composer", () => {
  it("offers actions and applies the selected token", () => {
    expect(getComposerSuggestions("/").map((item) => item.token)).toContain("/推荐");
    expect(applyComposerSuggestion("帮我 /推", "/推荐")).toBe("帮我 /推荐 ");
  });

  it("parses include and exclude constraints without changing visible wording", () => {
    const parsed = parseAgentComposer("/推荐 @月野霞 #未观看 #4K -#多人作品");
    expect(parsed.context.intent).toEqual({ id: "recommend", label: "推荐" });
    expect(parsed.context.constraints).toEqual([
      { label: "未观看", excluded: false },
      { label: "4K", excluded: false },
      { label: "多人作品", excluded: true }
    ]);
  });

  it("keeps exclusion mode when selecting a suggested condition", () => {
    expect(getComposerSuggestions("-#已").map((item) => item.token)).toContain("-#已观看");
  });

  it("removes one structured token cleanly", () => {
    expect(removeComposerToken("/推荐 #未观看 月野霞", "#未观看")).toBe("/推荐 月野霞");
  });
});
