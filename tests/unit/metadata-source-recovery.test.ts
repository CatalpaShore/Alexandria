import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFromMetaTube } from "../../server/src/metadata";

afterEach(() => vi.unstubAllGlobals());
const endpoint = { name: "primary" as const, source: "metatube", serverUrl: "http://metadata.test", token: "" };
const payload = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe("metadata source recovery", () => {
  it("tries a second exact provider when the preferred detail is unavailable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(payload([
        { number: "ABP-123", provider: "FANZA", id: "abp00123", title: "Title" },
        { number: "ABP-123", provider: "JavBus", id: "ABP-123", title: "Title" }
      ]))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(payload({ number: "ABP-123", provider: "JavBus", id: "ABP-123",
        title: "Title", summary: "Recovered summary", maker: "Maker", runtime: 120,
        release_date: "2025-01-01", preview_images: ["https://example.test/remote.jpg"] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchFromMetaTube("ABP-123", endpoint);
    expect(result?.summary).toBe("Recovered summary");
    expect(result?.previewImages).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the stable FC2 ID and falls back after a primary 404", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(payload({ number: "FC2-1234567", provider: "FC2PPVDB", id: "1234567", title: "Title" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchFromMetaTube("FC2-PPV-1234567", endpoint);
    expect(result?.provider).toBe("FC2PPVDB");
    expect(fetchMock.mock.calls[0][0]).toContain("/FC2/1234567?lazy=true");
  });

  it("reports blocked sources instead of incorrectly returning not found", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 403 })));
    await expect(fetchFromMetaTube("FC2-PPV-1234567", { ...endpoint, serverUrl: "http://blocked.test" }))
      .rejects.toThrow("HTTP 403");
  });
});
