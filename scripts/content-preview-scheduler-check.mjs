import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-content-preview-scheduler-"));
const dataDir = path.join(root, "data");
const sourceA = path.join(root, "source-a");
const sourceB = path.join(root, "source-b");
fs.mkdirSync(sourceA, { recursive: true });
fs.mkdirSync(sourceB, { recursive: true });
for (let index = 1; index <= 4; index += 1) {
  fs.writeFileSync(path.join(sourceA, `SOURCE-A-${index}.mp4`), "fixture");
  fs.writeFileSync(path.join(sourceB, `SOURCE-B-${index}.mp4`), "fixture");
}

process.env.DATA_DIR = dataDir;
process.env.THUMBNAIL_DIR = path.join(dataDir, "thumbnails");
process.env.DERIVATIVE_DIR = path.join(dataDir, "derivatives");
process.env.MEDIA_SOURCES = `JAV:Source-A=${sourceA};JAV:Source-B=${sourceB}`;
process.env.MEDIA_LIBRARY_ROOTS = "";
process.env.MEDIA_WORKER_MODE = "external";
process.env.SCAN_ON_START = "false";
process.env.METADATA_AUTO_ENRICH = "false";
process.env.AMW_CONTENT_PREVIEW_SOURCE_CONCURRENCY = "2";

const moduleRoot = path.resolve(import.meta.dirname, "..", "server", "src");
const importServerModule = (name) => import(pathToFileURL(path.join(moduleRoot, `${name}.ts`)).href);

let database;
let mediaJobs;
try {
  const [{ db }, scanner, jobs] = await Promise.all([
    importServerModule("db"),
    importServerModule("scanner"),
    importServerModule("mediaJobs")
  ]);
  database = db;
  mediaJobs = jobs;
  const scan = await scanner.scanMediaLibrary({ forceFull: true });
  assert.equal(scan.indexed, 8);

  const media = db.prepare(`
    SELECT id, source_name AS sourceName
    FROM media_files
    ORDER BY source_name, relative_path
  `).all();
  assert.equal(media.length, 8);

  const firstWave = [];
  let releaseFirstWave;
  const firstWaveReady = new Promise((resolve) => {
    releaseFirstWave = resolve;
  });
  jobs.registerMediaJobHandler("content-preview", async (_job, row) => {
    if (firstWave.length < 4) {
      firstWave.push(row.source_name);
      if (firstWave.length === 4) releaseFirstWave();
      await firstWaveReady;
    }
  });
  for (const row of media) jobs.enqueueMediaJob(row.id, "content-preview", { priority: 100 });

  jobs.startMediaJobWorker({ concurrency: 4, idleDelayMs: 25 });
  const deadline = Date.now() + 10_000;
  while (firstWave.length < 4 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(firstWave.length, 4, "four workers should claim the first wave");
  assert.deepEqual(
    Object.fromEntries([...new Set(firstWave)].sort().map((source) => [source, firstWave.filter((item) => item === source).length])),
    { "Source-A": 2, "Source-B": 2 }
  );

  const completionDeadline = Date.now() + 10_000;
  while (Date.now() < completionDeadline) {
    const remaining = db.prepare(`
      SELECT COUNT(*) AS count
      FROM media_jobs
      WHERE job_type = 'content-preview' AND status != 'ready'
    `).get().count;
    if (remaining === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM media_jobs
    WHERE job_type = 'content-preview' AND status = 'ready'
  `).get().count, 8);
  console.log("Content preview source-aware scheduler self-test passed");
  console.log(JSON.stringify({ firstWave }, null, 2));
} finally {
  mediaJobs?.stopMediaJobWorker();
  await mediaJobs?.waitForMediaJobWorkerStop();
  if (database?.open) database.close();
  fs.rmSync(root, { recursive: true, force: true });
}
