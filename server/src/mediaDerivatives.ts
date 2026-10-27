import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { ensureCachedCover } from "./covers.js";
import { db, type MediaRow } from "./db.js";
import { trackFfmpegProcess } from "./ffmpegProcesses.js";
import { withMediaWorkerFfmpegLimits } from "./ffmpegResources.js";
import {
  enqueueMediaJob,
  isMediaTranscodeAvailable,
  registerMediaJobHandler,
  wasMediaJobRecentlyFailed,
  type MediaJobType
} from "./mediaJobs.js";

export type DerivativeKind = "poster" | "remux" | "hls";
export type PosterVariant = "card" | "detail";

export type MediaDerivative = {
  id: string;
  mediaId: string;
  kind: DerivativeKind;
  variant: string;
  path: string;
  mimeType: string;
  status: "pending" | "ready" | "failed";
  bytes: number;
  error: string | null;
  updatedAt: string;
};

const lastDerivativeTouch = new Map<string, number>();
const posterProfileVersion = "hd-v1";
const posterWidths: Record<PosterVariant, number> = {
  card: 720,
  detail: 1_600
};
let webpEncoderAvailable: boolean | null = null;

function canEncodeWebp(): boolean {
  if (webpEncoderAvailable != null) return webpEncoderAvailable;
  const result = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    encoding: "utf8",
    timeout: 5_000
  });
  webpEncoderAvailable = result.status === 0 && /\blibwebp\b/.test(`${result.stdout}\n${result.stderr}`);
  return webpEncoderAvailable;
}

function getDerivativeId(mediaId: string, kind: DerivativeKind, variant: string): string {
  return crypto.createHash("sha1").update(`${mediaId}:${kind}:${variant}`).digest("hex").slice(0, 24);
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const commandArgs = command === "ffmpeg" ? withMediaWorkerFfmpegLimits(args) : args;
    const child = trackFfmpegProcess(spawn(command, commandArgs, { stdio: ["ignore", "ignore", "pipe"] }));
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${command} timed out`)));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 64 * 1024) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", (code) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      finish(() => reject(new Error(
        Buffer.concat(stderr).toString("utf8").trim().slice(-2000) || `${command} exited with ${code}`
      )));
    });
  });
}

function getPathBytes(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return fs.readdirSync(filePath).reduce((sum, name) => sum + getPathBytes(path.join(filePath, name)), 0);
  } catch {
    return 0;
  }
}

function saveDerivative(
  media: MediaRow,
  kind: DerivativeKind,
  variant: string,
  filePath: string,
  mimeType: string
): void {
  const now = new Date().toISOString();
  const bytes = getPathBytes(mimeType === "application/vnd.apple.mpegurl" ? path.dirname(filePath) : filePath);
  const id = getDerivativeId(media.id, kind, variant);
  db.prepare(
    `
    INSERT INTO media_derivatives (
      id, media_id, kind, variant, path, mime_type, status, bytes,
      source_mtime_ms, error, created_at, updated_at, last_accessed_at
    ) VALUES (
      @id, @mediaId, @kind, @variant, @path, @mimeType, 'ready', @bytes,
      @sourceMtimeMs, NULL, @now, @now, @now
    )
    ON CONFLICT(media_id, kind, variant) DO UPDATE SET
      path = excluded.path,
      mime_type = excluded.mime_type,
      status = 'ready',
      bytes = excluded.bytes,
      source_mtime_ms = excluded.source_mtime_ms,
      error = NULL,
      updated_at = excluded.updated_at,
      last_accessed_at = excluded.last_accessed_at
  `
  ).run({
    id,
    mediaId: media.id,
    kind,
    variant,
    path: filePath,
    mimeType,
    bytes,
    sourceMtimeMs: media.mtime_ms,
    now
  });

  db.prepare(
    `
    INSERT INTO asset_cache_index (
      cache_key, asset_type, path, bytes, source_signature, created_at, last_accessed_at
    ) VALUES (
      @cacheKey, @assetType, @path, @bytes, @sourceSignature, @now, @now
    )
    ON CONFLICT(cache_key) DO UPDATE SET
      path = excluded.path,
      bytes = excluded.bytes,
      source_signature = excluded.source_signature,
      last_accessed_at = excluded.last_accessed_at
  `
  ).run({
    cacheKey: id,
    assetType: `derivative:${kind}`,
    path: filePath,
    bytes,
    sourceSignature: `${media.size}:${media.mtime_ms}`,
    now
  });
}

function markDerivativePending(media: MediaRow, kind: DerivativeKind, variant: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO media_derivatives (
      id, media_id, kind, variant, status, source_mtime_ms, created_at, updated_at
    ) VALUES (
      @id, @mediaId, @kind, @variant, 'pending', @sourceMtimeMs, @now, @now
    )
    ON CONFLICT(media_id, kind, variant) DO UPDATE SET
      status = CASE WHEN media_derivatives.status = 'ready' THEN media_derivatives.status ELSE 'pending' END,
      source_mtime_ms = excluded.source_mtime_ms,
      updated_at = excluded.updated_at
  `
  ).run({
    id: getDerivativeId(media.id, kind, variant),
    mediaId: media.id,
    kind,
    variant,
    sourceMtimeMs: media.mtime_ms,
    now
  });
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function generatePoster(media: MediaRow, payloadJson: string, variant: PosterVariant): Promise<void> {
  const payload = parsePayload(payloadJson);
  const coverUrl = typeof payload.coverUrl === "string" ? payload.coverUrl : "";
  const thumbUrl = typeof payload.thumbUrl === "string" ? payload.thumbUrl : "";
  const urls = [...new Set([coverUrl, thumbUrl].filter(Boolean))];
  let source = null;
  for (const url of urls) {
    source = await ensureCachedCover(url);
    if (source) break;
  }
  if (!source) throw new Error("No cached metadata cover is available");

  fs.mkdirSync(config.posterVariantDir, { recursive: true });
  const width = posterWidths[variant];
  const useWebp = canEncodeWebp();
  const extension = useWebp ? "webp" : "jpg";
  const mimeType = useWebp ? "image/webp" : "image/jpeg";
  const outputPath = path.join(
    config.posterVariantDir,
    `${media.id}-${variant}-${posterProfileVersion}.${extension}`
  );
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.${extension}`;
  const previous = db.prepare(`
    SELECT path
    FROM media_derivatives
    WHERE media_id = ? AND kind = 'poster' AND variant = ?
  `).get(media.id, variant) as { path: string } | undefined;
  try {
    const codecArgs = useWebp
      ? ["-c:v", "libwebp", "-quality", variant === "card" ? "84" : "88"]
      : ["-c:v", "mjpeg", "-q:v", "2"];
    await runCommand(
      "ffmpeg",
      [
        "-y",
        "-i",
        source.path,
        "-frames:v",
        "1",
        "-vf",
        `scale=w='min(${width},iw)':h=-2`,
        "-threads",
        String(config.mediaWorkerFfmpegThreads),
        ...codecArgs,
        tempPath
      ],
      45_000
    );
    fs.renameSync(tempPath, outputPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  saveDerivative(media, "poster", variant, outputPath, mimeType);
  if (previous?.path && previous.path !== outputPath) {
    const previousPath = path.resolve(previous.path);
    const posterRoot = `${path.resolve(config.posterVariantDir)}${path.sep}`;
    if (previousPath.startsWith(posterRoot)) fs.rmSync(previousPath, { force: true });
  }
}

async function generateRemux(media: MediaRow): Promise<void> {
  fs.mkdirSync(config.streamCacheDir, { recursive: true });
  const outputPath = path.join(config.streamCacheDir, `${media.id}.mp4`);
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.mp4`;
  try {
    await runCommand(
      "ffmpeg",
      [
        "-y",
        "-i",
        media.absolute_path,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        tempPath
      ],
      6 * 60 * 60 * 1000
    );
    fs.renameSync(tempPath, outputPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  saveDerivative(media, "remux", "default", outputPath, "video/mp4");
}

async function generateHls(media: MediaRow): Promise<void> {
  const outputDir = path.join(config.streamCacheDir, `${media.id}-hls`);
  const tempDir = `${outputDir}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(tempDir, { recursive: true });
  const manifestPath = path.join(tempDir, "master.m3u8");
  try {
    await runCommand(
      "ffmpeg",
      [
        "-y",
        "-i",
        media.absolute_path,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-threads",
        String(config.mediaWorkerFfmpegThreads),
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_filename",
        path.join(tempDir, "segment-%05d.ts"),
        manifestPath
      ],
      12 * 60 * 60 * 1000
    );
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
    fs.renameSync(tempDir, outputDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  saveDerivative(media, "hls", "default", path.join(outputDir, "master.m3u8"), "application/vnd.apple.mpegurl");
}

registerMediaJobHandler("poster-card", async (job, media) => {
  if (!media) throw new Error("Media file no longer exists");
  await generatePoster(media, job.payload_json, "card");
});
registerMediaJobHandler("poster-detail", async (job, media) => {
  if (!media) throw new Error("Media file no longer exists");
  await generatePoster(media, job.payload_json, "detail");
});
registerMediaJobHandler("remux", async (_job, media) => {
  if (!media) throw new Error("Media file no longer exists");
  await generateRemux(media);
  enforceDerivativeCacheLimit();
});
registerMediaJobHandler("hls", async (_job, media) => {
  if (!media) throw new Error("Media file no longer exists");
  await generateHls(media);
  enforceDerivativeCacheLimit();
});

export function getMediaDerivative(
  mediaId: string,
  kind: DerivativeKind,
  variant = "default"
): MediaDerivative | null {
  const row = db
    .prepare(
      `
      SELECT
        media_derivatives.id,
        media_derivatives.media_id AS mediaId,
        media_derivatives.kind,
        media_derivatives.variant,
        media_derivatives.path,
        media_derivatives.mime_type AS mimeType,
        media_derivatives.status,
        media_derivatives.bytes,
        media_derivatives.error,
        media_derivatives.updated_at AS updatedAt,
        media_derivatives.source_mtime_ms AS sourceMtimeMs,
        media_files.mtime_ms AS mediaMtimeMs
      FROM media_derivatives
      JOIN media_files ON media_files.id = media_derivatives.media_id
      WHERE media_derivatives.media_id = ?
        AND media_derivatives.kind = ?
        AND media_derivatives.variant = ?
    `
    )
    .get(mediaId, kind, variant) as (MediaDerivative & { sourceMtimeMs: number; mediaMtimeMs: number }) | undefined;

  if (!row || row.status !== "ready" || row.sourceMtimeMs !== row.mediaMtimeMs || !fs.existsSync(row.path)) {
    return null;
  }
  if (
    kind === "poster" &&
    !path.basename(row.path).startsWith(`${mediaId}-${variant}-${posterProfileVersion}.`)
  ) {
    return null;
  }

  const previousTouch = lastDerivativeTouch.get(row.id) ?? 0;
  if (Date.now() - previousTouch >= 5 * 60 * 1000) {
    lastDerivativeTouch.set(row.id, Date.now());
    const now = new Date().toISOString();
    db.prepare("UPDATE media_derivatives SET last_accessed_at = ? WHERE id = ?").run(now, row.id);
    db.prepare("UPDATE asset_cache_index SET last_accessed_at = ? WHERE cache_key = ?").run(now, row.id);
  }
  const { sourceMtimeMs: _sourceMtimeMs, mediaMtimeMs: _mediaMtimeMs, ...result } = row;
  return result;
}

export function requestPosterVariant(
  media: MediaRow,
  variant: PosterVariant,
  coverUrl: string,
  thumbUrl: string
): string {
  const jobType: MediaJobType = variant === "card" ? "poster-card" : "poster-detail";
  if (!isMediaTranscodeAvailable()) return "";
  if (wasMediaJobRecentlyFailed(media.id, jobType)) return "";
  markDerivativePending(media, "poster", variant);
  return enqueueMediaJob(media.id, jobType, {
    priority: variant === "card" ? 20 : 10,
    payload: { coverUrl, thumbUrl }
  });
}

export function requestPlaybackDerivative(media: MediaRow, kind: "remux" | "hls"): string {
  if (!isMediaTranscodeAvailable()) throw new Error("ffmpeg is unavailable in this runtime");
  if (!fs.existsSync(media.absolute_path)) throw new Error("Media source is unavailable");
  markDerivativePending(media, kind, "default");
  return enqueueMediaJob(media.id, kind, { priority: 100 });
}

export function cleanupDerivativeTemps(
  olderThanMs = 15 * 60 * 1000,
  nowMs = Date.now()
): { removed: number; bytes: number } {
  const activeMediaIds = new Set(
    (db.prepare(`
      SELECT media_id AS mediaId
      FROM media_jobs
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at >= @now
    `).all({ now: new Date(nowMs).toISOString() }) as Array<{ mediaId: string }>).map((row) => row.mediaId)
  );
  let removed = 0;
  let bytes = 0;

  for (const root of [config.posterVariantDir, config.streamCacheDir]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.name.includes(".tmp")) continue;
      const mediaId = entry.name.split("-")[0]?.split(".")[0] ?? "";
      if (activeMediaIds.has(mediaId)) continue;
      const target = path.join(root, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch {
        continue;
      }
      if (nowMs - stat.mtimeMs < olderThanMs) continue;
      const targetBytes = getPathBytes(target);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed += 1;
        bytes += targetBytes;
      } catch {
        // The next maintenance pass can retry a file still held by ffmpeg.
      }
    }
  }
  return { removed, bytes };
}

export function reconcileDerivativeCacheIndex(): { updated: number; missing: number } {
  const rows = db.prepare(`
    SELECT id, path, mime_type AS mimeType
    FROM media_derivatives
    WHERE status = 'ready'
  `).all() as Array<{ id: string; path: string; mimeType: string }>;
  const updateDerivative = db.prepare("UPDATE media_derivatives SET bytes = ? WHERE id = ?");
  const updateCache = db.prepare("UPDATE asset_cache_index SET bytes = ? WHERE cache_key = ?");
  const markMissing = db.prepare(`
    UPDATE media_derivatives
    SET status = 'pending', path = '', bytes = 0, error = 'Cached derivative is missing', updated_at = ?
    WHERE id = ?
  `);
  let updated = 0;
  let missing = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const row of rows) {
      if (!row.path || !fs.existsSync(row.path)) {
        markMissing.run(now, row.id);
        db.prepare("DELETE FROM asset_cache_index WHERE cache_key = ?").run(row.id);
        missing += 1;
        continue;
      }
      const bytes = getPathBytes(
        row.mimeType === "application/vnd.apple.mpegurl" ? path.dirname(row.path) : row.path
      );
      updateDerivative.run(bytes, row.id);
      updateCache.run(bytes, row.id);
      updated += 1;
    }
  })();
  return { updated, missing };
}

export function enforceDerivativeCacheLimit(maxBytes = config.derivativeCacheMaxBytes): { removed: number; bytes: number } {
  reconcileDerivativeCacheIndex();
  const total = db
    .prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM asset_cache_index WHERE asset_type LIKE 'derivative:%'")
    .get() as { bytes: number };
  let bytes = total.bytes;
  let removed = 0;
  if (bytes <= maxBytes) return { removed, bytes };

  const rows = db
    .prepare(
      `
      SELECT cache_key AS cacheKey, path, bytes
      FROM asset_cache_index
      WHERE asset_type LIKE 'derivative:%'
      ORDER BY last_accessed_at ASC
    `
    )
    .all() as Array<{ cacheKey: string; path: string; bytes: number }>;

  const removeAsset = db.transaction((cacheKey: string) => {
    db.prepare("DELETE FROM asset_cache_index WHERE cache_key = ?").run(cacheKey);
    db.prepare("UPDATE media_derivatives SET status = 'pending', path = '', bytes = 0 WHERE id = ?").run(cacheKey);
  });

  for (const row of rows) {
    if (bytes <= maxBytes) break;
    try {
      const target = row.path.endsWith(".m3u8") ? path.dirname(row.path) : row.path;
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      continue;
    }
    removeAsset(row.cacheKey);
    bytes -= row.bytes;
    removed += 1;
  }

  return { removed, bytes: Math.max(0, bytes) };
}
