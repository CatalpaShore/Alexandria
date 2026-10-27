import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeLibrary, inspectSource, planSetup } from "../../scripts/lib/setupLibrary.mjs";
let root: string, media: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "alexandria-connect-"));
  media = path.join(root, "media with spaces 日本語");
  await fs.mkdir(media);
  await fs.writeFile(path.join(media, "Sample.mp4"), "fixture unchanged");
  await fs.writeFile(path.join(media, "Sample.zh.srt"), "subtitle fixture");
  await fs.writeFile(path.join(media, "Sample.nfo"), "<movie/>");
  await fs.writeFile(path.join(root, ".env.example"), "DATA_DIR=.local/data\nSCAN_ON_START=true\n");
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));
describe("first-run library setup", () => {
  it("previews media read-only without creating runtime settings", async () => {
    const before = await fs.readFile(path.join(media, "Sample.mp4"), "utf8");
    const plan = await planSetup(root, [media], {});
    expect(plan.sources[0]).toMatchObject({ video: 1, subtitles: 1, metadata: 1, limited: false });
    expect(await fs.readdir(root)).not.toContain(".local");
    expect(await fs.readFile(path.join(media, "Sample.mp4"), "utf8")).toBe(before);
  });
  it("creates private JSON once, preserving media and an existing env file", async () => {
    const env = "DATA_DIR=.local/data\nPORT=4320\n";
    await fs.writeFile(path.join(root, ".env"), env);
    const plan = await planSetup(root, [media], {});
    await initializeLibrary(plan);
    expect(JSON.parse(await fs.readFile(plan.target, "utf8")).sources).toEqual([{ category: "LOCAL", name: "Library-1", root: media }]);
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe(env);
    expect(await fs.readFile(path.join(media, "Sample.mp4"), "utf8")).toBe("fixture unchanged");
    await expect(initializeLibrary(plan)).rejects.toThrow("EXISTING_LIBRARY");
    if (process.platform !== "win32") expect((await fs.stat(plan.target)).mode & 0o777).toBe(0o600);
  });
  it("refuses existing databases and explicit source settings instead of overwriting", async () => {
    const plan = await planSetup(root, [media], {});
    await fs.mkdir(plan.dataDir, { recursive: true });
    const database = path.join(plan.dataDir, "media-wall.sqlite");
    await fs.writeFile(database, "do not modify");
    await expect(initializeLibrary(plan)).rejects.toThrow("EXISTING_LIBRARY");
    expect(await fs.readFile(database, "utf8")).toBe("do not modify");
    await fs.unlink(database);
    const configured = await planSetup(root, [media], { MEDIA_SOURCES: "LOCAL:Existing=/media/existing" });
    await expect(initializeLibrary(configured)).rejects.toThrow("EXISTING_LIBRARY");
    for (const inherited of [{ MEDIA_ROOT: media }, { MEDIA_LIBRARY_ROOTS: "/media/one;/media/two" }]) {
      await expect(initializeLibrary(await planSetup(root, [media], inherited))).rejects.toThrow("EXISTING_LIBRARY");
    }
  });
  it("rejects relative paths, duplicate real folders, and sources containing application state", async () => {
    await expect(inspectSource("relative/media")).rejects.toThrow("ABSOLUTE_PATH_REQUIRED");
    await expect(planSetup(root, [media, media], {})).rejects.toThrow("DUPLICATE_SOURCE");
    await expect(planSetup(root, [root], {})).rejects.toThrow("DATA_INSIDE_SOURCE");
  });
});
