import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amw-platform-v2-api-"));
const dataDir = path.join(testRoot, "data");
const mediaRoot = path.join(testRoot, "media");
const thumbnailDir = path.join(dataDir, "thumbnails");
const coverCacheDir = path.join(dataDir, "covers");
const derivativeDir = path.join(dataDir, "derivatives");
const emptyCoverSeedDir = path.join(testRoot, "empty-cover-seed");
const fakeBinDir = path.join(testRoot, "bin");
const fixturePath = path.join(mediaRoot, "A", "API-001.mp4");
const timeoutMs = Number(process.env.PLATFORM_V2_API_TIMEOUT_MS ?? 20_000);

for (const directory of [
  path.dirname(fixturePath),
  thumbnailDir,
  coverCacheDir,
  derivativeDir,
  emptyCoverSeedDir,
  fakeBinDir
]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(fixturePath, "platform-v2 isolated media fixture\n");

// Capability checks only inspect PATH. The worker stays external, so these fixtures
// allow queue endpoints to be exercised without invoking real media binaries.
for (const executable of ["ffmpeg", "ffprobe"]) {
  const executablePath = path.join(fakeBinDir, executable);
  fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    })
  ]);
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverLogs = [];
const child = spawn(
  process.execPath,
  [path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), "server/src/index.ts"],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      THUMBNAIL_DIR: thumbnailDir,
      COVER_CACHE_DIR: coverCacheDir,
      DERIVATIVE_DIR: derivativeDir,
      COVER_SEED_DIR: emptyCoverSeedDir,
      METADATA_SEED_PATH: path.join(testRoot, "missing-metadata-seed.json.gz"),
      METADATA_EXCEL_PATH: path.join(dataDir, "exports", "metadata.xlsx"),
      MEDIA_SOURCES: `JAV:Fixture=${mediaRoot}`,
      MEDIA_LIBRARY_ROOTS: "",
      SCAN_ON_START: "false",
      AMW_TRUST_PROXY: process.env.PLATFORM_TEST_TRUST_PROXY ?? "true",
      METADATA_AUTO_ENRICH: "false",
      MEDIA_WORKER_MODE: "external",
      MEDIA_PROBE_STARTUP_BATCH: "1",
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      NODE_ENV: "test"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    serverLogs.push(chunk);
    if (serverLogs.length > 200) serverLogs.shift();
  });
}

async function request(requestPath, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {})
      },
      signal: controller.signal
    });
    const text = response.status === 204 ? "" : await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`${options.method ?? "GET"} ${requestPath} returned ${response.status}: ${text}`);
    }
    return { status: response.status, body, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`API process exited before startup\n${serverLogs.join("")}`);
    }
    try {
      const response = await request("/api/health");
      if (response.body?.ok === true) return;
    } catch {
      // The listener or database migrations may still be starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for API startup\n${serverLogs.join("")}`);
}

function assertScanSummary(summary, expectedMode) {
  assert.equal(summary.scanMode, expectedMode);
  assert.equal(typeof summary.fullScanReason, "string");
  assert.equal(typeof summary.indexed, "number");
  assert.equal(typeof summary.sidecars, "number");
  assert.equal(typeof summary.unchanged, "number");
  assert.equal(typeof summary.changed, "number");
  assert.equal(typeof summary.removed, "number");
  assert.equal(typeof summary.directoriesRead, "number");
  assert.equal(typeof summary.directoriesSkipped, "number");
  assert.equal(typeof summary.snapshotSaved, "boolean");
  assert.ok(Number.isFinite(Date.parse(summary.startedAt)));
  assert.ok(Number.isFinite(Date.parse(summary.finishedAt)));
  assert.ok(Array.isArray(summary.roots) && summary.roots.length === 1);
  assert.equal(summary.roots[0].root, mediaRoot);
}

let playlistId = "";
try {
  await waitForServer();

  const firstScan = (await request("/api/scan", { method: "POST" })).body;
  assertScanSummary(firstScan, "full");
  assert.equal(firstScan.indexed, 1);
  assert.equal(firstScan.changed, 1);
  assert.equal(firstScan.snapshotSaved, true);

  const incrementalScan = (await request("/api/scan", { method: "POST" })).body;
  assertScanSummary(incrementalScan, "incremental");
  assert.equal(incrementalScan.indexed, 1);
  assert.equal(incrementalScan.unchanged, 1);
  assert.ok(incrementalScan.directoriesSkipped >= 1);

  const catalog = (await request("/api/media?page=1&pageSize=12&groupVersions=false")).body;
  assert.equal(catalog.items.length, 1);
  const media = catalog.items[0];
  assert.ok(media.id);
  assert.equal(media.normalizedCode, "API-001");

  const created = await request("/api/playlists", {
    method: "POST",
    body: JSON.stringify({
      name: "Platform V2 manual playlist",
      description: "isolated API regression fixture",
      kind: "manual",
      query: {}
    })
  });
  assert.equal(created.status, 201);
  playlistId = created.body.id;
  assert.ok(playlistId);
  assert.equal(created.body.kind, "manual");
  assert.equal(created.body.itemCount, 0);

  const listed = (await request("/api/playlists")).body;
  assert.ok(listed.items.some((playlist) => playlist.id === playlistId));

  const added = (await request(`/api/playlists/${encodeURIComponent(playlistId)}/items`, {
    method: "POST",
    body: JSON.stringify({ mediaId: media.id, favorite: true })
  })).body;
  assert.equal(added.itemCount, 1);

  const playlistItems = (await request(`/api/playlists/${encodeURIComponent(playlistId)}/items`)).body;
  assert.equal(playlistItems.playlist.id, playlistId);
  assert.equal(playlistItems.items.length, 1);
  assert.equal(playlistItems.items[0].id, media.id);

  const updated = (await request(`/api/playlists/${encodeURIComponent(playlistId)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "Platform V2 playlist updated",
      description: "updated through the public API",
      kind: "manual",
      query: {}
    })
  })).body;
  assert.equal(updated.name, "Platform V2 playlist updated");
  assert.equal(updated.itemCount, 1);

  const removed = (await request(`/api/playlists/${encodeURIComponent(playlistId)}/items`, {
    method: "POST",
    body: JSON.stringify({ mediaId: media.id, favorite: false })
  })).body;
  assert.equal(removed.itemCount, 0);

  const readinessMissing = (await request(`/api/media/${media.id}/readiness`)).body;
  assert.equal(readinessMissing.mediaId, media.id);
  assert.ok(["pending", "queued"].includes(readinessMissing.probeStatus));
  assert.equal(readinessMissing.recommendedAction, "probe");
  assert.equal(readinessMissing.playbackReady, false);
  assert.equal(readinessMissing.storyboard, null);

  const storyboardMissing = (await request(`/api/media/${media.id}/storyboard`)).body;
  assert.equal(storyboardMissing.mediaId, media.id);
  assert.equal(storyboardMissing.status, "missing");
  assert.deepEqual(storyboardMissing.cues, []);

  const readinessPrepared = await request(`/api/media/${media.id}/readiness`, {
    method: "POST",
    body: JSON.stringify({ playback: true, storyboard: false })
  });
  assert.equal(readinessPrepared.status, 202);
  assert.ok(readinessPrepared.body.jobs.length >= 1);
  assert.equal(readinessPrepared.body.readiness.probeStatus, "queued");

  const storyboardPrepared = await request(`/api/media/${media.id}/storyboard`, { method: "POST" });
  assert.equal(storyboardPrepared.status, 202);
  assert.ok(storyboardPrepared.body.jobId);
  assert.equal(storyboardPrepared.body.storyboard.status, "pending");

  const externalPlayer = (await request(`/api/media/${media.id}/external-player`)).body;
  const expectedStreamUrl = `${baseUrl}/api/media/${media.id}/stream`;
  assert.equal(externalPlayer.mediaId, media.id);
  assert.equal(externalPlayer.streamUrl, expectedStreamUrl);
  assert.equal(externalPlayer.links.vlc, `vlc://${expectedStreamUrl}`);
  assert.equal(
    externalPlayer.links.infuse,
    `infuse://x-callback-url/play?url=${encodeURIComponent(expectedStreamUrl)}`
  );

  const proxiedExternalPlayer = (await request(`/api/media/${media.id}/external-player`, {
    headers: {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "nas.example.test"
    }
  })).body;
  assert.equal(proxiedExternalPlayer.streamUrl, process.env.PLATFORM_TEST_TRUST_PROXY === "false"
    ? expectedStreamUrl : `https://nas.example.test/api/media/${media.id}/stream`);

  const integrityStarted = await request("/api/maintenance/integrity", { method: "POST" });
  assert.equal(integrityStarted.status, 202);
  assert.equal(integrityStarted.body.running, true);
  let integrity = null;
  const integrityDeadline = Date.now() + timeoutMs;
  while (Date.now() < integrityDeadline) {
    const current = (await request("/api/maintenance/integrity")).body;
    if (!current.running && current.report) {
      integrity = current.report;
      break;
    }
    await delay(50);
  }
  assert.ok(integrity, "integrity scan should complete within the test timeout");
  assert.equal(integrity.readOnly, true);
  assert.ok(Number.isFinite(Date.parse(integrity.generatedAt)));
  assert.equal(typeof integrity.durationMs, "number");
  assert.ok(integrity.assets?.thumbnail && integrity.assets?.cover && integrity.assets?.derivative);
  assert.ok(Array.isArray(integrity.issues));

  const backupId = `platform-v2-${Date.now()}`;
  const backup = await request("/api/maintenance/backups", {
    method: "POST",
    body: JSON.stringify({ id: backupId })
  });
  assert.equal(backup.status, 201);
  assert.equal(backup.body.id, backupId);
  assert.equal(backup.body.manifest.format, "adult-media-wall-backup");
  assert.equal(backup.body.manifest.checksumAlgorithm, "sha256");
  assert.ok(backup.body.manifest.artifacts.some((artifact) => artifact.role === "database"));

  const backups = (await request("/api/maintenance/backups")).body;
  assert.ok(backups.items.some((candidate) => candidate.id === backupId));
  assert.equal(backups.backupRoot, path.join(dataDir, "backups"));

  const validation = (await request(`/api/maintenance/backups/${backupId}/validate`)).body;
  assert.equal(validation.valid, true, validation.errors?.join("; "));
  assert.deepEqual(validation.errors, []);
  assert.match(validation.manifestSha256, /^[a-f0-9]{64}$/);

  const restorePlan = (await request(`/api/maintenance/backups/${backupId}/restore-plan`, {
    method: "POST"
  })).body;
  assert.equal(restorePlan.backupDir, path.join(dataDir, "backups", backupId));
  assert.match(restorePlan.confirmationToken, /^RESTORE-[A-F0-9]{12}$/);
  assert.equal(restorePlan.targetDatabasePath, path.join(dataDir, "media-wall.sqlite"));
  assert.ok(restorePlan.replacements.some((replacement) => replacement.role === "database"));

  // A restore plan is intentionally the final restore operation in this test. Confirm
  // the server remains alive and no exit-triggering restore endpoint was called.
  const healthAfterRestorePlan = (await request("/api/health")).body;
  assert.equal(healthAfterRestorePlan.ok, true);

  const deleted = await request(`/api/playlists/${encodeURIComponent(playlistId)}`, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  playlistId = "";
  const afterDelete = (await request("/api/playlists")).body;
  assert.equal(afterDelete.items.some((playlist) => playlist.id === created.body.id), false);

  console.log(JSON.stringify({
    ok: true,
    isolation: {
      temporaryDataDir: true,
      temporaryMediaRoot: true,
      externalWorker: true,
      restoreExecutionSkipped: true
    },
    coverage: {
      playlists: ["create", "list", "update", "manual-item-add", "manual-item-remove", "delete"],
      playbackReadiness: ["missing", "prepare-probe"],
      storyboard: ["missing", "prepare"],
      externalPlayer: ["stream-url", "vlc", "infuse"],
      maintenance: ["integrity-async-start", "integrity-poll"],
      backup: ["create", "list", "validate", "restore-plan"],
      scanning: ["full-summary", "incremental-summary"]
    },
    incrementalScan: {
      mode: incrementalScan.scanMode,
      directoriesRead: incrementalScan.directoriesRead,
      directoriesSkipped: incrementalScan.directoriesSkipped,
      unchanged: incrementalScan.unchanged
    }
  }, null, 2));
} catch (error) {
  const logs = serverLogs.join("").trim();
  if (logs) console.error(`\n--- isolated API server log ---\n${logs}\n--- end server log ---`);
  throw error;
} finally {
  if (playlistId && child.exitCode === null && child.signalCode === null) {
    try {
      await request(`/api/playlists/${encodeURIComponent(playlistId)}`, { method: "DELETE" });
    } catch {
      // The temporary database is removed below even if cleanup cannot reach the server.
    }
  }
  await stopChild(child);
  fs.rmSync(testRoot, { recursive: true, force: true });
}
