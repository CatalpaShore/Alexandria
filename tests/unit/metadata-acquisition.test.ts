import { describe, expect, it, vi } from "vitest";
import { buildAcquisitionPlanHash, getAcquisitionSources } from "../../server/src/metadataAcquisition";
import { config } from "../../server/src/config";

describe("metadata acquisition plans", () => {
  it("authenticates source health checks using the configured metadata token", async () => {
    const original = { serverUrl: config.metadata.serverUrl, token: config.metadata.token };
    config.metadata.serverUrl = "http://metadata.example.test";
    config.metadata.token = "fixture-token";
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
      new Response("[]", { status: new Headers(init?.headers).get("Authorization") === "Bearer fixture-token" ? 200 : 401 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sources = await getAcquisitionSources();
      expect(sources.find(source => source.source === "metatube")?.health).toMatchObject({ online: true, status: 200 });
    } finally {
      Object.assign(config.metadata, original);
      vi.unstubAllGlobals();
    }
  });
  it("produces a stable hash when object key order changes", () => {
    const left = buildAcquisitionPlanHash({
      packages: ["work-facts", "local-gallery"],
      scope: { limit: 100, category: "JAV" }
    });
    const right = buildAcquisitionPlanHash({
      scope: { category: "JAV", limit: 100 },
      packages: ["work-facts", "local-gallery"]
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps candidate order and package selection in the signed plan", () => {
    const baseline = buildAcquisitionPlanHash({
      packages: ["work-facts", "local-gallery"],
      candidates: [{ code: "ABP-001" }, { code: "ABP-002" }]
    });
    expect(buildAcquisitionPlanHash({
      packages: ["local-gallery", "work-facts"],
      candidates: [{ code: "ABP-001" }, { code: "ABP-002" }]
    })).not.toBe(baseline);
    expect(buildAcquisitionPlanHash({
      packages: ["work-facts", "local-gallery"],
      candidates: [{ code: "ABP-002" }, { code: "ABP-001" }]
    })).not.toBe(baseline);
  });
});
