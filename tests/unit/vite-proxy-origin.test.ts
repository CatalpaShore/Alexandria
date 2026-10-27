import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config";

describe("Vite API proxy origin handling", () => {
  it("preserves the browser-facing host for API write origin validation", () => {
    if (typeof viteConfig === "function") throw new Error("Expected a static Vite configuration");
    const proxy = viteConfig.server?.proxy?.["/api"];

    expect(proxy).toMatchObject({
      changeOrigin: false,
      xfwd: true
    });
  });
});
