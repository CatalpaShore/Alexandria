import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-storyboard-worker-"));
const dataDir = path.join(root, "data");
const mediaRoot = path.join(root, "media");
const mediaDir = path.join(mediaRoot, "S");
const mediaPath = path.join(mediaDir, "STORY-001.mp4");
fs.mkdirSync(mediaDir, { recursive: true });

const generated = spawnSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc=size=640x360:rate=2",
  "-t", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", mediaPath
], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr || "ffmpeg fixture generation failed");

process.env.DATA_DIR = dataDir;
process.env.THUMBNAIL_DIR = path.join(dataDir, "thumbnails");
process.env.DERIVATIVE_DIR = path.join(dataDir, "derivatives");
process.env.MEDIA_SOURCES = `JAV:Fixture=${mediaRoot}`;
process.env.MEDIA_LIBRARY_ROOTS = "";
process.env.SCAN_ON_START = "false";
process.env.METADATA_AUTO_ENRICH = "false";

const defaultModuleRoot = path.resolve(import.meta.dirname, "..", "server", "src");
const moduleRoot = process.env.STORYBOARD_MODULE_ROOT ?? defaultModuleRoot;
const moduleExtension = moduleRoot.includes(`${path.sep}dist${path.sep}`) ? ".js" : ".ts";
const importServerModule = (name) => import(pathToFileURL(path.join(moduleRoot, `${name}${moduleExtension}`)).href);

let database;
let stopMediaJobWorker;
try {
  const [{ db }, scanner, storyboards, mediaJobs] = await Promise.all([
    importServerModule("db"),
    importServerModule("scanner"),
    importServerModule("storyboards"),
    importServerModule("mediaJobs")
  ]);
  database = db;
  stopMediaJobWorker = mediaJobs.stopMediaJobWorker;

  const summary = await scanner.scanMediaLibrary({ forceFull: true });
  assert.equal(summary.indexed, 1);
  const media = db.prepare("SELECT * FROM media_files WHERE normalized_code = 'STORY-001'").get();
  assert.ok(media?.id);
  const jobId = storyboards.requestStoryboard(media);
  assert.ok(jobId);

  mediaJobs.startMediaJobWorker({ concurrency: 1, idleDelayMs: 50 });
  const deadline = Date.now() + 60_000;
  let manifest;
  while (Date.now() < deadline) {
    manifest = storyboards.getStoryboardManifest(media.id);
    if (manifest?.status === "ready") break;
    if (manifest?.status === "failed") throw new Error(manifest.error || "Storyboard generation failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(manifest?.status, "ready");
  assert.equal(manifest.cues.length, 12);
  assert.equal(manifest.columns, 5);
  assert.equal(manifest.tileWidth, 240);
  assert.equal(manifest.tileHeight, 136);
  const files = storyboards.getStoryboardFiles(media.id);
  assert.ok(files && fs.statSync(files.imagePath).size > 0);
  assert.ok(files && fs.statSync(files.cuesPath).size > 0);
  assert.equal(db.prepare("SELECT status FROM media_jobs WHERE id = ?").get(jobId).status, "ready");

  console.log("Storyboard worker self-test passed");
  console.log(JSON.stringify({
    frames: manifest.frameCount,
    cues: manifest.cues.length,
    imageBytes: fs.statSync(files.imagePath).size
  }, null, 2));
} finally {
  stopMediaJobWorker?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (database?.open) database.close();
  fs.rmSync(root, { recursive: true, force: true });
}
