import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-subtitle-worker-"));
const dataDir = path.join(root, "data");
const mediaRoot = path.join(root, "media");
const mediaDir = path.join(mediaRoot, "A");
fs.mkdirSync(mediaDir, { recursive: true });
fs.writeFileSync(path.join(mediaDir, "SUB-001.mp4"), "fixture\n");
fs.writeFileSync(
  path.join(mediaDir, "SUB-001.zh-CN.srt"),
  "1\n00:00:01,000 --> 00:00:03,250\n字幕缓存测试\n",
  "utf8"
);

process.env.DATA_DIR = dataDir;
process.env.THUMBNAIL_DIR = path.join(dataDir, "thumbnails");
process.env.DERIVATIVE_DIR = path.join(dataDir, "derivatives");
process.env.MEDIA_SOURCES = `JAV:Fixture=${mediaRoot}`;
process.env.MEDIA_LIBRARY_ROOTS = "";
process.env.SCAN_ON_START = "false";
process.env.METADATA_AUTO_ENRICH = "false";

let database;
let stopMediaJobWorker;
try {
  const [{ db }, scanner, mediaJobs, subtitleTranslation] = await Promise.all([
    import("../server/src/db.ts"),
    import("../server/src/scanner.ts"),
    import("../server/src/mediaJobs.ts"),
    import("../server/src/subtitleTranslation.ts")
  ]);
  database = db;
  stopMediaJobWorker = mediaJobs.stopMediaJobWorker;

  const summary = await scanner.scanMediaLibrary({ forceFull: true });
  assert.equal(summary.indexed, 1);
  assert.equal(summary.sidecars, 1);

  const media = db.prepare("SELECT id FROM media_files WHERE normalized_code = 'SUB-001'").get();
  assert.ok(media?.id);
  const queuedTranslation = subtitleTranslation.requestSubtitleTranslation(media.id);
  assert.equal(queuedTranslation.status, "pending");

  mediaJobs.startMediaJobWorker({ concurrency: 3, idleDelayMs: 50 });
  const deadline = Date.now() + 5_000;
  let cached;
  while (Date.now() < deadline) {
    cached = db.prepare(`
      SELECT cache.path, cache.status, cache.bytes
      FROM media_subtitle_cache cache
      JOIN media_sidecars sidecars ON sidecars.id = cache.sidecar_id
      WHERE sidecars.kind = 'subtitle'
    `).get();
    if (cached?.status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(cached?.status, "ready");
  assert.ok(cached.bytes > 0);
  const vtt = fs.readFileSync(cached.path, "utf8");
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.250/);
  assert.match(vtt, /字幕缓存测试/);
  assert.equal(
    db.prepare("SELECT status FROM media_jobs WHERE job_type = 'subtitle'").get().status,
    "ready"
  );

  const translationDeadline = Date.now() + 5_000;
  let translation;
  while (Date.now() < translationDeadline) {
    translation = subtitleTranslation.getSubtitleTranslation(media.id);
    if (translation?.status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(translation?.status, "ready");
  assert.equal(translation?.sourceKind, "existing-chinese");
  assert.equal(translation?.cueCount, 1);
  assert.equal(translation?.translatedCueCount, 1);
  assert.match(fs.readFileSync(translation.outputPath, "utf8"), /字幕缓存测试/);
  const translatedSidecar = subtitleTranslation.getReadyTranslationSidecar(media.id);
  assert.equal(translatedSidecar?.isTranslated, true);
  assert.equal(translatedSidecar?.trackUrl, `/api/media/${media.id}/subtitle-translation.vtt`);
  assert.equal(
    db.prepare("SELECT status FROM media_jobs WHERE job_type = 'subtitle-translate'").get().status,
    "ready"
  );
  const removal = subtitleTranslation.removeSubtitleTranslation(media.id);
  assert.equal(removal.action, "removed");
  assert.equal(fs.existsSync(translation.outputPath), false);
  assert.equal(subtitleTranslation.getSubtitleTranslation(media.id), null);

  console.log("Subtitle and translation worker self-test passed");
  console.log(JSON.stringify({ cachePath: cached.path, bytes: cached.bytes, translationPath: translation.outputPath }, null, 2));
} finally {
  stopMediaJobWorker?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (database?.open) database.close();
  fs.rmSync(root, { recursive: true, force: true });
}
