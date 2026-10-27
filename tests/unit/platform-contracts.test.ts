import { describe, expect, it } from "vitest";
import {
  ingestionCompletionSchema,
  metadataQualityIssueSchema,
  recommendationFeedbackResponseSchema
} from "../../server/src/contracts/platform.js";

describe("shared platform contracts", () => {
  it("accepts recommendation feedback responses", () => {
    expect(recommendationFeedbackResponseSchema.parse({
      anchorMediaId: "anchor",
      mediaId: "candidate",
      feedbackType: "not_interested",
      createdAt: "2026-07-14T01:02:03.000Z"
    }).mediaId).toBe("candidate");
  });

  it("rejects incomplete ingestion stages", () => {
    expect(() => ingestionCompletionSchema.parse({
      overallStatus: "ready",
      reason: "ok",
      stages: {
        file: { status: "ready", label: "文件", detail: "已索引" },
        metadata: { status: "ready", label: "元数据", detail: "已抓取" },
        translation: { status: "ready", label: "翻译", detail: "已翻译" }
      }
    })).toThrow();
  });

  it("accepts the ingestion completion shape returned by the API", () => {
    const stage = { status: "ready" as const, label: "文件", detail: "已完成" };
    expect(ingestionCompletionSchema.parse({
      overallStatus: "ready",
      reason: "全部完成",
      stages: { file: stage, metadata: stage, translation: stage, cover: stage }
    }).overallStatus).toBe("ready");
  });

  it("keeps metadata issue names bounded", () => {
    expect(() => metadataQualityIssueSchema.parse({
      type: "arbitrary_issue",
      severity: "warning",
      details: {},
      detectedAt: "2026-07-14T01:02:03.000Z"
    })).toThrow();
  });
});
