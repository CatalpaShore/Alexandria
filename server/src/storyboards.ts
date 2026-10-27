import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, type MediaRow } from "./db.js";
import { trackFfmpegProcess } from "./ffmpegProcesses.js";
import { withMediaWorkerFfmpegLimits } from "./ffmpegResources.js";
import { enqueueMediaJob, registerMediaJobHandler, wasMediaJobRecentlyFailed } from "./mediaJobs.js";
import { probeMediaFile } from "./mediaProbe.js";

export type StoryboardStatus = "pending" | "ready" | "failed";

export type StoryboardInfo = {
  mediaId: string;
  status: StoryboardStatus;
  imageUrl: string;
  frameCount: number;
  intervalSeconds: number;
  columns: number;
  tileWidth: number;
  tileHeight: number;
  error: string | null;
  updatedAt: string;
};

const storyboardDir = path.join(config.derivativeDir, "storyboards");

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = trackFfmpegProcess(spawn(
      "ffmpeg",
      withMediaWorkerFfmpegLimits(args),
      { stdio: ["ignore", "ignore", "pipe"] }
    ));
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Storyboard generation timed out"));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 64 * 1024) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim().slice(-2000) || `ffmpeg exited with ${code}`));
    });
  });
}

function markStoryboard(media: MediaRow, values: {
  status: StoryboardStatus;
  imagePath?: string;
  cuesPath?: string;
  frameCount?: number;
  intervalSeconds?: number;
  columns?: number;
  tileWidth?: number;
  tileHeight?: number;
  bytes?: number;
  error?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO media_storyboards (
      media_id, image_path, cues_path, status, frame_count, interval_seconds,
      columns_count, tile_width, tile_height, bytes, source_mtime_ms, error,
      created_at, updated_at, last_accessed_at
    ) VALUES (
      @mediaId, @imagePath, @cuesPath, @status, @frameCount, @intervalSeconds,
      @columns, @tileWidth, @tileHeight, @bytes, @sourceMtimeMs, @error,
      @now, @now, @lastAccessedAt
    )
    ON CONFLICT(media_id) DO UPDATE SET
      image_path = excluded.image_path,
      cues_path = excluded.cues_path,
      status = excluded.status,
      frame_count = excluded.frame_count,
      interval_seconds = excluded.interval_seconds,
      columns_count = excluded.columns_count,
      tile_width = excluded.tile_width,
      tile_height = excluded.tile_height,
      bytes = excluded.bytes,
      source_mtime_ms = excluded.source_mtime_ms,
      error = excluded.error,
      updated_at = excluded.updated_at,
      last_accessed_at = excluded.last_accessed_at
  `
  ).run({
    mediaId: media.id,
    imagePath: values.imagePath ?? "",
    cuesPath: values.cuesPath ?? "",
    status: values.status,
    frameCount: values.frameCount ?? 0,
    intervalSeconds: values.intervalSeconds ?? 0,
    columns: values.columns ?? 5,
    tileWidth: values.tileWidth ?? 240,
    tileHeight: values.tileHeight ?? 136,
    bytes: values.bytes ?? 0,
    sourceMtimeMs: media.mtime_ms,
    error: values.error ?? null,
    now,
    lastAccessedAt: values.status === "ready" ? now : null
  });
}

async function generateStoryboard(media: MediaRow): Promise<void> {
  const probe = media.duration_seconds && media.duration_seconds > 0
    ? null
    : await probeMediaFile(media);
  const duration = media.duration_seconds ?? probe?.durationSeconds ?? 0;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Video duration is unavailable");

  const frameCount = Math.max(12, Math.min(60, Math.ceil(duration / 180)));
  const intervalSeconds = duration / frameCount;
  const columns = 5;
  const rows = Math.ceil(frameCount / columns);
  const tileWidth = 240;
  const tileHeight = 136;
  fs.mkdirSync(storyboardDir, { recursive: true });
  const imagePath = path.join(storyboardDir, `${media.id}.jpg`);
  const cuesPath = path.join(storyboardDir, `${media.id}.json`);
  const tempImage = `${imagePath}.${process.pid}.${Date.now()}.tmp.jpg`;
  const tempCues = `${cuesPath}.${process.pid}.${Date.now()}.tmp.json`;

  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        media.absolute_path,
        "-vf",
        `fps=1/${intervalSeconds.toFixed(3)},scale=w=${tileWidth}:h=${tileHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2,tile=${columns}x${rows}`,
        "-frames:v",
        "1",
        "-q:v",
        "4",
        "-threads",
        String(config.mediaWorkerFfmpegThreads),
        tempImage
      ],
      45 * 60 * 1000
    );
    const cues = Array.from({ length: frameCount }, (_, index) => ({
      start: index * intervalSeconds,
      end: Math.min(duration, (index + 1) * intervalSeconds),
      x: (index % columns) * tileWidth,
      y: Math.floor(index / columns) * tileHeight
    }));
    fs.writeFileSync(tempCues, `${JSON.stringify({ duration, cues })}\n`, "utf8");
    fs.renameSync(tempImage, imagePath);
    fs.renameSync(tempCues, cuesPath);
    const bytes = fs.statSync(imagePath).size + fs.statSync(cuesPath).size;
    markStoryboard(media, {
      status: "ready",
      imagePath,
      cuesPath,
      frameCount,
      intervalSeconds,
      columns,
      tileWidth,
      tileHeight,
      bytes
    });
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO asset_cache_index (
        cache_key, asset_type, path, bytes, source_signature, created_at, last_accessed_at
      ) VALUES (?, 'derivative:storyboard', ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        path = excluded.path,
        bytes = excluded.bytes,
        source_signature = excluded.source_signature,
        last_accessed_at = excluded.last_accessed_at
    `
    ).run(`storyboard:${media.id}`, imagePath, bytes, `${media.size}:${media.mtime_ms}`, now, now);
  } finally {
    fs.rmSync(tempImage, { force: true });
    fs.rmSync(tempCues, { force: true });
  }
}

registerMediaJobHandler("storyboard", async (_job, media) => {
  if (!media) throw new Error("Media file no longer exists");
  try {
    await generateStoryboard(media);
  } catch (error) {
    markStoryboard(media, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
});

export function requestStoryboard(media: MediaRow): string {
  const current = getStoryboard(media.id);
  if (current?.status === "ready") return "";
  if (wasMediaJobRecentlyFailed(media.id, "storyboard", 60 * 60 * 1000)) return "";
  markStoryboard(media, { status: "pending" });
  return enqueueMediaJob(media.id, "storyboard", { priority: 85 });
}

export function getStoryboard(mediaId: string): StoryboardInfo | null {
  const row = db.prepare(
    `
    SELECT media_id AS mediaId, image_path AS imagePath, cues_path AS cuesPath,
      status, frame_count AS frameCount, interval_seconds AS intervalSeconds,
      columns_count AS columnsCount, tile_width AS tileWidth, tile_height AS tileHeight,
      source_mtime_ms AS sourceMtimeMs, error, updated_at AS updatedAt
    FROM media_storyboards
    WHERE media_id = ?
  `
  ).get(mediaId) as {
    mediaId: string;
    imagePath: string;
    cuesPath: string;
    status: StoryboardStatus;
    frameCount: number;
    intervalSeconds: number;
    columnsCount: number;
    tileWidth: number;
    tileHeight: number;
    sourceMtimeMs: number;
    error: string | null;
    updatedAt: string;
  } | undefined;
  if (!row) return null;
  const media = db.prepare("SELECT mtime_ms AS mtimeMs FROM media_files WHERE id = ?").get(mediaId) as { mtimeMs: number } | undefined;
  const valid = row.status === "ready"
    && row.sourceMtimeMs === media?.mtimeMs
    && fs.existsSync(row.imagePath)
    && fs.existsSync(row.cuesPath);
  return {
    mediaId: row.mediaId,
    status: valid ? "ready" : row.status === "ready" ? "pending" : row.status,
    imageUrl: valid ? `/api/media/${mediaId}/storyboard/image` : "",
    frameCount: row.frameCount,
    intervalSeconds: row.intervalSeconds,
    columns: row.columnsCount,
    tileWidth: row.tileWidth,
    tileHeight: row.tileHeight,
    error: row.error,
    updatedAt: row.updatedAt
  };
}

export function getStoryboardFiles(mediaId: string): { imagePath: string; cuesPath: string } | null {
  const row = db.prepare(
    "SELECT image_path AS imagePath, cues_path AS cuesPath FROM media_storyboards WHERE media_id = ? AND status = 'ready'"
  ).get(mediaId) as { imagePath: string; cuesPath: string } | undefined;
  if (!row || !fs.existsSync(row.imagePath) || !fs.existsSync(row.cuesPath)) return null;
  return row;
}

export function getStoryboardCue(mediaId: string, time: number) {
  const files = getStoryboardFiles(mediaId);
  if (!files) return null;
  const parsed = JSON.parse(fs.readFileSync(files.cuesPath, "utf8")) as {
    duration: number;
    cues: Array<{ start: number; end: number; x: number; y: number }>;
  };
  const safeTime = Math.max(0, Math.min(parsed.duration, time));
  const cue = parsed.cues.find((entry) => safeTime >= entry.start && safeTime < entry.end)
    ?? parsed.cues.at(-1);
  return cue ? { ...cue, duration: parsed.duration } : null;
}

export function getStoryboardManifest(mediaId: string) {
  const info = getStoryboard(mediaId);
  if (!info || info.status !== "ready") return info ? { ...info, cues: [] } : null;
  const files = getStoryboardFiles(mediaId);
  if (!files) return { ...info, status: "pending" as const, imageUrl: "", cues: [] };
  const parsed = JSON.parse(fs.readFileSync(files.cuesPath, "utf8")) as {
    duration: number;
    cues: Array<{ start: number; end: number; x: number; y: number }>;
  };
  return { ...info, duration: parsed.duration, cues: parsed.cues };
}

export function createStoryboardJobId(mediaId: string): string {
  return crypto.createHash("sha1").update(`storyboard:${mediaId}`).digest("hex");
}
