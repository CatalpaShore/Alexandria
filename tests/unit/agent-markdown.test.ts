import { describe, expect, it } from "vitest";
import {
  normalizeAgentMarkdown,
  resolveAgentCitationReferences
} from "../../client/src/components/agent/agentMarkdownUtils";

describe("Agent Markdown normalization", () => {
  it("converts br tags into Markdown line breaks", () => {
    expect(normalizeAgentMarkdown("第一行<br>第二行<BR />第三行"))
      .toBe("第一行  \n第二行  \n第三行");
  });

  it("keeps GFM table rows intact while removing br tags", () => {
    expect(normalizeAgentMarkdown("| 影片 | 特点 |\n| --- | --- |\n| A | 第一项<br>第二项 |"))
      .toContain("| A | 第一项 · 第二项 |");
  });

  it("does not rewrite br examples inside fenced code", () => {
    expect(normalizeAgentMarkdown("```html\n<br>\n```"))
      .toBe("```html\n<br>\n```");
  });

  it("replaces vague and bare citation references with the real media code", () => {
    const citations = [
      { code: "AARM-199" },
      { code: "OFJE-201" },
      { code: "JUQ-777" },
      { code: "DLDSS-360" }
    ];
    expect(resolveAgentCitationReferences(
      "## 推荐影片\n- **番号 [4]** — 推荐理由\n- 也可以看 [2]\n- **JUQ-777 [3]** — 已经明确\n- 忽略 [99]",
      citations
    )).toBe(
      "## 推荐影片\n- **DLDSS-360 [4]** — 推荐理由\n- 也可以看 OFJE-201 [2]\n- **JUQ-777 [3]** — 已经明确\n- 忽略 [99]"
    );
  });

  it("does not rewrite citation examples inside fenced code", () => {
    expect(resolveAgentCitationReferences(
      "正文是作品 [1]\n```\n番号 [1]\n```",
      [{ code: "AARM-199" }]
    )).toBe("正文是 AARM-199 [1]\n```\n番号 [1]\n```");
  });
});
