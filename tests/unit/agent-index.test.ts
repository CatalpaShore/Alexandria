import { describe, expect, it } from "vitest";
import { buildAgentIndexDocument, type AgentIndexDocumentSource } from "../../server/src/agentRag";

function source(overrides: Partial<AgentIndexDocumentSource> = {}): AgentIndexDocumentSource {
  return {
    mediaId: "media-1",
    normalizedCode: "START-409",
    libraryCategory: "JAV",
    titleZh: "中文标题",
    titleOriginal: "日本語タイトル",
    summaryZh: "中文简介",
    summaryOriginal: "日本語の紹介",
    actorsZh: JSON.stringify(["宫岛芽衣"]),
    actorsOriginal: JSON.stringify(["宮島めい", "立花日向"]),
    genresZh: JSON.stringify(["羞耻", "中出"]),
    genresOriginal: JSON.stringify(["羞恥", "中出し"]),
    seriesZh: "洗脑美容按摩",
    seriesOriginal: "洗脳エステ",
    makerZh: "SOD Create",
    makerOriginal: "SOD Create",
    labelZh: "SODSTAR",
    labelOriginal: "SODSTAR",
    directorZh: "犬神凉",
    directorOriginal: "犬神涼",
    prefix: "START",
    releaseDate: "2025-09-22",
    durationSeconds: 7_997,
    width: 3840,
    height: 2160,
    qualityTag: "4K",
    variantTags: JSON.stringify(["字幕", "C"]),
    sourceUpdatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides
  };
}

describe("agent media-v2 index document", () => {
  it("preserves bilingual metadata and the latest stable media structure", () => {
    const document = buildAgentIndexDocument(source());

    expect(document).toContain("馆藏分类: JAV");
    expect(document).toContain("标题: 中文标题 / 日本語タイトル");
    expect(document).toContain("演员: 宫岛芽衣、宮島めい、立花日向");
    expect(document).toContain("题材: 羞耻、中出、羞恥、中出し");
    expect(document).toContain("片长: 133 分钟");
    expect(document).toContain("画质: 4K、3840x2160");
    expect(document).toContain("版本: 字幕、C");
  });

  it("does not include volatile favorites or playback state", () => {
    const document = buildAgentIndexDocument(source());

    expect(document).not.toMatch(/收藏|观看状态|已看完|未观看|lastPlayed/iu);
    expect(document).not.toContain("2026-08-21T00:00:00.000Z");
  });

  it("deduplicates identical translated and original values", () => {
    const document = buildAgentIndexDocument(source({
      titleZh: "同一标题",
      titleOriginal: "同一标题",
      actorsZh: JSON.stringify(["宫岛芽衣"]),
      actorsOriginal: JSON.stringify(["宫岛芽衣"])
    }));

    expect(document).toContain("标题: 同一标题");
    expect(document).not.toContain("同一标题 / 同一标题");
    expect(document).toContain("演员: 宫岛芽衣");
  });
});
