import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import path from "node:path";
import { demoAccess, demoStaticAccess, redactDemoPaths } from "../../server/src/demoAccess.js";
import { applyDemoEnvironment } from "../../server/src/demoEnvironment.js";

let server: Server, origin: string;
let mutationCount = 0;
beforeAll(async () => {
  const app = express();
  app.use("/api", demoAccess);
  app.use(demoStaticAccess);
  app.get("/tour/*", (_req, res) => res.send("recorded tour"));
  app.get("/showcase/topics.png", (_req, res) => res.send("non-adult screenshot"));
  app.get("/api/media", (_req, res) => res.json({ title: "海岸线的清晨", path: path.join(process.cwd(), ".local/public-demo/media/sample.mp4") }));
  app.post("/api/media/:id/progress", (_req, res) => { mutationCount++; res.sendStatus(204); });
  app.put("/api/settings/library-paths", (_req, res) => { mutationCount++; res.sendStatus(204); });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP listener missing");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe("public demo boundary", () => {
  it("blocks writes before handlers, including progress and source configuration", async () => {
    for (const [method, route] of [["POST", "/api/media/example/progress"], ["PUT", "/api/settings/library-paths"], ["POST", "/api/access/pair"], ["DELETE", "/api/users/user-1"]]) {
      const response = await fetch(origin + route, { method });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "DEMO_READ_ONLY" });
    }
    expect(mutationCount).toBe(0);
  });
  it("allows browsing while replacing operator paths", async () => {
    const response = await fetch(origin + "/api/media");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "海岸线的清晨", path: "/demo/.local/public-demo/media/sample.mp4" });
    expect(redactDemoPaths({ nested: [path.join(process.cwd(), "example"), 4, null] })).toEqual({ nested: ["/demo/example", 4, null] });
  });
  it("rejects settings, diagnostics, exports and model requests even for reads", async () => {
    for (const route of ["settings/library-paths", "diagnostics", "backup", "favorites/export", "personal-data/export", "agent/models", "agent/threads", "metadata/sources"]) {
      expect((await fetch(origin + "/api/" + route)).status, route).toBe(403);
    }
  });
  it("blocks recorded-tour assets, including encoded and mixed-case paths, while allowing non-adult screenshots", async () => {
    for (const route of ["/tour/product-tour.mp4", "/tour/product-tour-en.mp4", "/tour/product-tour-ja.mp4", "/tour/subtitles-zh.vtt", "/tour/subtitles-en.vtt", "/tour/subtitles-ja.vtt", "/%74our/product-tour.mp4", "/TOUR/product-tour.mp4", "/tour%2Fproduct-tour.mp4", "/showcase/%2e%2e/tour/product-tour.mp4"]) {
      for (const method of ["GET", "HEAD"]) expect((await fetch(origin + route, { method })).status, route).toBe(404);
    }
    expect((await fetch(origin + "/showcase/topics.png")).status).toBe(200);
  });
  it("ignores inherited private library, cache, database, mounting and model settings", () => {
    const env: NodeJS.ProcessEnv = { MEDIA_SOURCES: "LOCAL:Private=/private/example", AMW_DATABASE_PATH: "/private/old.sqlite", DATA_DIR: "/private/data", AMW_EXTERNAL_AI_ROOT: "/private/models", AMW_REMOTE_MOUNTS: "smb://example.invalid/private", METADATA_SERVER_URL: "https://example.invalid", THUMBNAIL_DIR: "/private/cache", COVER_SEED_DIR: "/private/covers", SUBTITLE_CONTEXTUAL_TRANSLATION_URL: "https://example.invalid", PORT: "9999" };
    applyDemoEnvironment(env, "/tmp/example-app");
    expect(env.DATA_DIR).toBe("/tmp/example-app/.local/public-demo/data");
    expect(env.MEDIA_SOURCES).toBe("LOCAL:Demo=/tmp/example-app/.local/public-demo/movies");
    expect(env.AMW_AGENT_ENABLED).toBe("false");
    expect(env.PORT).toBe("9999");
    expect(env.AMW_REMOTE_MOUNTS).toBeUndefined();
    expect(env.METADATA_SERVER_URL).toBeUndefined();
    expect(env.THUMBNAIL_DIR).toBeUndefined();
    expect(env.COVER_SEED_DIR).toBeUndefined();
    expect(env.SUBTITLE_CONTEXTUAL_TRANSLATION_URL).toBeUndefined();
  });
});
