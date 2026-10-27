import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-content-preview-worker-"));
const dataDir = path.join(root, "data");
const mediaRoot = path.join(root, "media");
const mediaDir = path.join(mediaRoot, "P");
const mediaPath = path.join(mediaDir, "PREVIEW-001.mp4");
const externalRoot = path.join(root, "external");
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(externalRoot, { recursive: true });
fs.writeFileSync(path.join(externalRoot, ".alexandria-ai-volume.json"), JSON.stringify({
  product: "alexandria-ai",
  storageId: "content-preview-test"
}));

const generated = spawnSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1",
  "-t", "720", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", mediaPath
], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr || "ffmpeg fixture generation failed");

process.env.DATA_DIR = dataDir;
process.env.THUMBNAIL_DIR = path.join(dataDir, "thumbnails");
process.env.DERIVATIVE_DIR = path.join(dataDir, "derivatives");
process.env.MEDIA_SOURCES = `JAV:Fixture=${mediaRoot}`;
process.env.MEDIA_LIBRARY_ROOTS = "";
process.env.SCAN_ON_START = "false";
process.env.METADATA_AUTO_ENRICH = "false";
process.env.AMW_EXTERNAL_AI_ROOT = externalRoot;
process.env.AMW_EXTERNAL_AI_STORAGE_ID = "content-preview-test";
process.env.AMW_CONTENT_PREVIEW_ROOT = path.join(externalRoot, "media-previews", "v1");
process.env.AMW_CONTENT_PREVIEW_GIF_WIDTH = "320";
process.env.AMW_CONTENT_PREVIEW_PHOTO_WIDTH = "640";
process.env.AMW_CONTENT_PREVIEW_GIF_MAX_MB = "2";

const defaultModuleRoot = path.resolve(import.meta.dirname, "..", "server", "src");
const moduleRoot = process.env.CONTENT_PREVIEW_MODULE_ROOT ?? defaultModuleRoot;
const moduleExtension = moduleRoot.includes(`${path.sep}dist${path.sep}`) ? ".js" : ".ts";
const importServerModule = (name) => import(pathToFileURL(path.join(moduleRoot, `${name}${moduleExtension}`)).href);

let database;
let stopMediaJobWorker;
try {
  const [{ db }, scanner, previews, mediaJobs] = await Promise.all([
    importServerModule("db"),
    importServerModule("scanner"),
    importServerModule("contentPreviews"),
    importServerModule("mediaJobs")
  ]);
  database = db;
  stopMediaJobWorker = mediaJobs.stopMediaJobWorker;

  const summary = await scanner.scanMediaLibrary({ forceFull: true });
  assert.equal(summary.indexed, 1);
  const media = db.prepare("SELECT * FROM media_files WHERE normalized_code = 'PREVIEW-001'").get();
  assert.ok(media?.id);

  const anchors = previews.calculateContentPreviewAnchors(720);
  assert.equal(anchors.fallbackShort, false);
  assert.equal(anchors.anchors.length, 12);
  assert.ok(anchors.anchors.every((time) => time > 300));

  const jobId = previews.requestContentPreview(media, 70);
  assert.ok(jobId);
  mediaJobs.startMediaJobWorker({ concurrency: 1, idleDelayMs: 50 });

  const deadline = Date.now() + 180_000;
  let response;
  while (Date.now() < deadline) {
    response = previews.getContentPreview(media.id);
    if (response.status === "ready") break;
    if (response.status === "failed") throw new Error(response.error || "Content preview generation failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(response?.status, "ready");
  assert.equal(response.photos.length, 9);
  assert.equal(response.gifs.length, 3);
  assert.ok(response.totalBytes > 0);
  for (const asset of [...response.photos, ...response.gifs]) {
    const file = previews.getContentPreviewAsset(media.id, asset.key);
    assert.ok(file && fs.statSync(file.path).size > 0);
    if (asset.kind === "gif") {
      const probe = spawnSync("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=nb_frames,duration",
        "-of", "json",
        file.path
      ], { encoding: "utf8" });
      assert.equal(probe.status, 0, probe.stderr || "GIF probe failed");
      const stream = JSON.parse(probe.stdout).streams?.[0];
      assert.equal(Number(stream?.nb_frames), 24);
      assert.ok(Math.abs(Number(stream?.duration) - 4) < 0.01);
    }
  }
  assert.equal(db.prepare("SELECT status FROM media_jobs WHERE id = ?").get(jobId).status, "ready");

  const disconnectedRoot = path.join(root, "external-disconnected");
  fs.renameSync(externalRoot, disconnectedRoot);
  assert.equal(previews.getContentPreview(media.id).storageAvailable, false);
  assert.equal(previews.getContentPreview(media.id).status, "unavailable");
  fs.renameSync(disconnectedRoot, externalRoot);
  assert.equal(previews.getContentPreview(media.id).status, "ready");

  console.log("Content preview worker self-test passed");
  console.log(JSON.stringify({
    photos: response.photos.length,
    gifs: response.gifs.length,
    bytes: response.totalBytes,
    firstTime: response.photos[0].timeSeconds,
    lastTime: response.photos.at(-1).timeSeconds
  }, null, 2));
} finally {
  stopMediaJobWorker?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (database?.open) database.close();
  fs.rmSync(root, { recursive: true, force: true });
}
