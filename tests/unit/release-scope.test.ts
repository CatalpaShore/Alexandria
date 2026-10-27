import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import type {Express} from "express";
import type {Server} from "node:http";

vi.mock("../../server/src/config.js", () => ({config: {network: {lanMode: false, requireAuthentication: false, trustProxy: false}}}));
vi.mock("../../server/src/accessControl.js", () => ({createAccessControl: () => ({register: () => undefined})}));
vi.mock("../../server/src/diagnostics.js", () => ({diagnosticsMiddleware: (_req: unknown, _res: unknown, next: () => void) => next()}));
vi.mock("../../server/src/demoSeed.js", () => ({demoFilmExperience: () => ({films: []})}));
vi.mock("../../server/src/routes.js", () => ({registerRoutes: (app: Express) => {
  app.get("/api/health/ping", (_req, res) => {res.json({ok: true});});
}}));

let server: Server, address: string;
beforeAll(async () => {
  const {createApp} = await import("../../server/src/app/createApp.js");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Expected TCP listener");
  address = `http://127.0.0.1:${bound.port}`;
});
afterAll(async () => {await new Promise<void>(resolve => server.close(() => resolve()));});

describe("main product release scope", () => {
  it("rejects legacy product pages and API writes instead of serving the SPA or starting a gateway", async () => {
    for (const route of ["/web-library", "/web-library/", "/web-library/index.html", "/web-library/player/old", "/api/web-library", "/api/web-library/status"]) {
      const response = await fetch(`${address}${route}`);
      expect(response.status, route).toBe(404);
      expect(await response.text()).not.toContain('<div id="root">');
    }
    expect((await fetch(`${address}/api/web-library/scan`, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"})).status).toBe(404);
  });
  it("keeps the main product's health route available", async () => {
    const response = await fetch(`${address}/api/health/ping`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ok: true});
  });
});
