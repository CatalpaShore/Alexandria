import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, requestJson } from "../../client/src/lib/http";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("shared HTTP client", () => {
  it("returns JSON responses", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;

    await expect(requestJson<{ ok: boolean }>("/api/test")).resolves.toEqual({ ok: true });
  });

  it("preserves API error messages", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "具体错误" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;

    await expect(requestJson("/api/test")).rejects.toThrow("具体错误");
  });

  it("supports domain-specific fallback messages", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as typeof fetch;

    await expect(requestJson("/api/test", undefined, (status) => `请求失败：${status}`))
      .rejects.toThrow("请求失败：503");
  });

  it("handles empty successful responses", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;

    await expect(requestJson<void>("/api/test")).resolves.toBeUndefined();
  });

  it("builds JSON request options consistently", () => {
    expect(jsonRequest("POST", { enabled: true })).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
  });
});
