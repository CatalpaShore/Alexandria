import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, type MediaRow } from "./db.js";
import { inspectExternalAiStorage } from "./externalAiStorage.js";
import { trackFfmpegProcess } from "./ffmpegProcesses.js";
import { withMediaWorkerFfmpegLimits } from "./ffmpegResources.js";
import {
  enqueueMediaJob,
  registerMediaJobHandler,
  registerMediaJobIdleRefillHandler
} from "./mediaJobs.js";
import { probeMediaFile } from "./mediaProbe.js";

export type ContentPreviewStatus = "unavailable" | "missing" | "pending" | "ready" | "failed" | "stale";

export type ContentPreviewAsset = {
  key: string;
  kind: "photo" | "gif";
  timeSeconds: number;
  startSeconds: number;
  durationSeconds: number;
  file: string;
  width: number;
  bytes: number;
  sha256: string;
};

export type ContentPreviewManifest = {
  version: number;
  mediaId: string;
  sourceSignature: string;
  generatedAt: string;
  durationSeconds: number;
  window: {
    start: number;
    end: number;
    fallbackShort: boolean;
  };
  photos: ContentPreviewAsset[];
  gifs: ContentPreviewAsset[];
  totalBytes: number;
};

export type ContentPreviewResponse = {
  mediaId: string;
  storageAvailable: boolean;
  status: ContentPreviewStatus;
  photos: Array<Omit<ContentPreviewAsset, "file" | "sha256"> & { url: string }>;
  gifs: Array<Omit<ContentPreviewAsset, "file" | "sha256"> & { url: string }>;
  totalBytes: number;
  generatedAt: string | null;
  fallbackShort: boolean;
  error: string | null;
};

type ContentPreviewRow = {
  status: string;
  manifestPath: string;
  bytes: number;
  version: number;
  sourceSignature: string;
  error: string | null;
  generatedAt: string | null;
};

const gifAnchorIndexes = new Set([3, 7, 11]);
const lastTouchByMedia = new Map<string, number>();
const manifestCache = new Map<string, { expiresAt: number; value: ContentPreviewManifest }>();
const MANIFEST_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_MANIFEST_CACHE_ENTRIES = 256;

function storageWaitError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "CONTENT_PREVIEW_STORAGE_WAIT" });
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function inspectContentPreviewStorage() {
  const storage = inspectExternalAiStorage({
    enabled: config.contentPreview.enabled,
    root: config.contentPreview.storageRoot,
    markerFile: config.contentPreview.markerFile,
    expectedStorageId: config.contentPreview.expectedStorageId
  });
  if (!storage.ready) return storage;
  if (!isInsideRoot(config.contentPreview.storageRoot, config.contentPreview.root)) {
    return {
      ...storage,
      state: "identity-mismatch" as const,
      ready: false,
      writable: false,
      errorCode: "CONTENT_PREVIEW_ROOT_OUTSIDE_STORAGE",
      message: "内容预览目录不在已验证的 辅助存储 存储范围内"
    };
  }
  return storage;
}

export function createContentPreviewSourceSignature(media: MediaRow, durationSeconds: number): string {
  return crypto
    .createHash("sha256")
    .update([
      media.id,
      media.size,
      media.mtime_ms,
      durationSeconds.toFixed(3),
      config.contentPreview.profileVersion,
      config.contentPreview.photoWidth,
      config.contentPreview.gifWidth,
      config.contentPreview.gifDurationSeconds,
      config.contentPreview.gifFps
    ].join(":"))
    .digest("hex")
    .slice(0, 24);
}

export function calculateContentPreviewAnchors(durationSeconds: number): {
  start: number;
  end: number;
  fallbackShort: boolean;
  anchors: number[];
} {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 1) {
    throw new Error("Video duration is unavailable");
  }
  const tail = Math.min(300, Math.max(10, durationSeconds * 0.03));
  let start = 300;
  let end = durationSeconds - tail;
  let fallbackShort = false;
  if (durationSeconds <= 300 || end - start < 60) {
    start = Math.max(1, durationSeconds * 0.1);
    end = Math.max(start + 1, durationSeconds * 0.9);
    fallbackShort = true;
  }
  const anchors = Array.from({ length: 12 }, (_, index) => (
    start + ((index + 1) * (end - start)) / 13
  ));
  return { start, end, fallbackShort, anchors };
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = trackFfmpegProcess(spawn(
      "ffmpeg",
      withMediaWorkerFfmpegLimits(args),
      { stdio: ["ignore", "ignore", "pipe"] }
    ));
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Content preview generation timed out")));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 64 * 1024) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim().slice(-2000) || `ffmpeg exited with ${code}`));
    }));
  });
}

function fileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function seekArgs(timeSeconds: number, fastSeek: boolean): string[] {
  return [
    ...(fastSeek ? ["-noaccurate_seek"] : []),
    "-ss", timeSeconds.toFixed(3)
  ];
}

function writePhoto(media: MediaRow, timeSeconds: number, outputPath: string, fastSeek: boolean): Promise<void> {
  return runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    ...seekArgs(timeSeconds, fastSeek),
    "-fflags", "+discardcorrupt",
    "-err_detect", "ignore_err",
    "-i", media.absolute_path,
    "-map", "0:V:0",
    "-frames:v", "1",
    "-vf", `scale=w=${config.contentPreview.photoWidth}:h=-2:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "-q:v", "4",
    "-threads", String(config.mediaWorkerFfmpegThreads),
    "-an", outputPath
  ], 5 * 60 * 1000);
}

function gifFilter(width: number, fps: number, colors: number): string {
  return `[0:v:0]fps=${fps},scale=w=${width}:h=-2:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2,split[gif_a][gif_b];[gif_a]palettegen=max_colors=${colors}:stats_mode=diff[palette];[gif_b][palette]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[gif_out]`;
}

async function writeGif(
  media: MediaRow,
  startSeconds: number,
  outputPath: string,
  options: { width: number; fps: number; colors: number },
  fastSeek: boolean
): Promise<void> {
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    ...seekArgs(startSeconds, fastSeek),
    "-t", String(config.contentPreview.gifDurationSeconds),
    "-fflags", "+discardcorrupt",
    "-err_detect", "ignore_err",
    "-i", media.absolute_path,
    "-filter_complex", gifFilter(options.width, options.fps, options.colors),
    "-map", "[gif_out]",
    "-loop", "0",
    "-threads", String(config.mediaWorkerFfmpegThreads),
    "-an", outputPath
  ], 10 * 60 * 1000);
}

async function renderWithDecodeFallback(
  targetSeconds: number,
  minSeconds: number,
  maxSeconds: number,
  outputPath: string,
  render: (timeSeconds: number, fastSeek: boolean) => Promise<void>,
  allowFastSeek: boolean
): Promise<number> {
  const offsets = [0, 2, -2, 10, -10, 30, -30];
  const attempted = new Set<string>();
  let lastError: unknown = null;
  for (const offset of offsets) {
    const candidate = Math.min(Math.max(targetSeconds + offset, minSeconds), maxSeconds);
    const key = candidate.toFixed(3);
    if (attempted.has(key)) continue;
    attempted.add(key);
    const seekModes = config.contentPreview.fastSeek && allowFastSeek ? [true, false] : [false];
    for (const fastSeek of seekModes) {
      fs.rmSync(outputPath, { force: true });
      try {
        await render(candidate, fastSeek);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return candidate;
        lastError = new Error("ffmpeg produced an empty content preview asset");
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to decode content preview asset");
}

function markContentPreview(media: MediaRow, values: {
  status: "missing" | "pending" | "ready" | "failed";
  manifestPath?: string;
  bytes?: number;
  sourceSignature?: string;
  error?: string | null;
  generatedAt?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO media_storyboards (
      media_id, content_status, content_manifest_path, content_bytes, content_version,
      content_source_signature, content_error, content_generated_at, content_last_accessed_at,
      created_at, updated_at
    ) VALUES (
      @mediaId, @status, @manifestPath, @bytes, @version,
      @sourceSignature, @error, @generatedAt, @lastAccessedAt,
      @now, @now
    )
    ON CONFLICT(media_id) DO UPDATE SET
      content_status = excluded.content_status,
      content_manifest_path = excluded.content_manifest_path,
      content_bytes = excluded.content_bytes,
      content_version = excluded.content_version,
      content_source_signature = excluded.content_source_signature,
      content_error = excluded.content_error,
      content_generated_at = excluded.content_generated_at,
      content_last_accessed_at = excluded.content_last_accessed_at,
      updated_at = excluded.updated_at
  `).run({
    mediaId: media.id,
    status: values.status,
    manifestPath: values.manifestPath ?? "",
    bytes: values.bytes ?? 0,
    version: config.contentPreview.profileVersion,
    sourceSignature: values.sourceSignature ?? "",
    error: values.error ?? null,
    generatedAt: values.generatedAt ?? null,
    lastAccessedAt: values.status === "ready" ? now : null,
    now
  });
}

function readContentPreviewRow(mediaId: string): ContentPreviewRow | null {
  return (db.prepare(`
    SELECT content_status AS status, content_manifest_path AS manifestPath,
      content_bytes AS bytes, content_version AS version,
      content_source_signature AS sourceSignature, content_error AS error,
      content_generated_at AS generatedAt
    FROM media_storyboards
    WHERE media_id = ?
  `).get(mediaId) as ContentPreviewRow | undefined) ?? null;
}

function rememberManifest(manifestPath: string, manifest: ContentPreviewManifest): ContentPreviewManifest {
  manifestCache.delete(manifestPath);
  manifestCache.set(manifestPath, { expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS, value: manifest });
  while (manifestCache.size > MAX_MANIFEST_CACHE_ENTRIES) {
    const oldestKey = manifestCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    manifestCache.delete(oldestKey);
  }
  return manifest;
}

function readManifest(manifestPath: string): ContentPreviewManifest | null {
  if (!manifestPath || !isInsideRoot(config.contentPreview.root, manifestPath)) return null;
  const cached = manifestCache.get(manifestPath);
  if (cached && cached.expiresAt > Date.now()) {
    manifestCache.delete(manifestPath);
    manifestCache.set(manifestPath, cached);
    return cached.value;
  }
  if (cached) manifestCache.delete(manifestPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ContentPreviewManifest;
    if (parsed.version !== config.contentPreview.profileVersion || !Array.isArray(parsed.photos) || !Array.isArray(parsed.gifs)) return null;
    if (parsed.photos.length !== 9 || parsed.gifs.length !== 3) return null;
    const bundleRoot = path.dirname(manifestPath);
    const assets = [...parsed.photos, ...parsed.gifs];
    if (assets.some((asset) => path.basename(asset.file) !== asset.file || !fs.existsSync(path.join(bundleRoot, asset.file)))) return null;
    return rememberManifest(manifestPath, parsed);
  } catch {
    return null;
  }
}

export async function generateContentPreview(media: MediaRow): Promise<ContentPreviewManifest> {
  if (media.media_type !== "video") throw new Error("Content preview only supports video files");
  const storage = inspectContentPreviewStorage();
  if (!storage.ready) throw storageWaitError(storage.message);
  if (!fs.existsSync(media.absolute_path)) throw new Error("Media source is unavailable");

  const probe = media.duration_seconds && media.duration_seconds > 0 ? null : await probeMediaFile(media);
  const durationSeconds = media.duration_seconds ?? probe?.durationSeconds ?? 0;
  const sourceSignature = createContentPreviewSourceSignature(media, durationSeconds);
  const current = readContentPreviewRow(media.id);
  if (current?.status === "ready" && current.sourceSignature === sourceSignature) {
    const readyManifest = readManifest(current.manifestPath);
    if (readyManifest) return readyManifest;
  }

  const sample = calculateContentPreviewAnchors(durationSeconds);
  const mediaRoot = path.join(config.contentPreview.root, media.id);
  const finalBundle = path.join(mediaRoot, sourceSignature);
  const finalManifest = path.join(finalBundle, "manifest.json");
  const existingManifest = readManifest(finalManifest);
  if (existingManifest?.sourceSignature === sourceSignature) {
    markContentPreview(media, {
      status: "ready",
      manifestPath: finalManifest,
      bytes: existingManifest.totalBytes,
      sourceSignature,
      generatedAt: existingManifest.generatedAt
    });
    return existingManifest;
  }

  fs.mkdirSync(mediaRoot, { recursive: true });
  const tempBundle = path.join(mediaRoot, `.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tempBundle, { recursive: true });
  const photos: ContentPreviewAsset[] = [];
  const gifs: ContentPreviewAsset[] = [];
  let photoIndex = 0;
  let gifIndex = 0;

  try {
    for (let index = 0; index < sample.anchors.length; index += 1) {
      const anchorNumber = index + 1;
      const timeSeconds = sample.anchors[index];
      const storageDuringRun = inspectContentPreviewStorage();
      if (!storageDuringRun.ready) throw storageWaitError(storageDuringRun.message);
      if (gifAnchorIndexes.has(anchorNumber)) {
        gifIndex += 1;
        const key = `motion-${String(gifIndex).padStart(2, "0")}`;
        const file = `${key}.gif`;
        const outputPath = path.join(tempBundle, file);
        const clipDuration = config.contentPreview.gifDurationSeconds;
        const preferredStartSeconds = Math.min(
          Math.max(sample.start, timeSeconds - clipDuration / 2),
          Math.max(sample.start, sample.end - clipDuration)
        );
        let width = config.contentPreview.gifWidth;
        const startSeconds = await renderWithDecodeFallback(
          preferredStartSeconds,
          sample.start,
          Math.max(sample.start, sample.end - clipDuration),
          outputPath,
          (candidate, fastSeek) => writeGif(media, candidate, outputPath, {
            width,
            fps: config.contentPreview.gifFps,
            colors: 128
          }, fastSeek),
          false
        );
        if (fs.statSync(outputPath).size > config.contentPreview.gifMaxBytes) {
          width = Math.min(width, 400);
          await writeGif(media, startSeconds, outputPath, {
            width,
            fps: Math.min(config.contentPreview.gifFps, 5),
            colors: 96
          }, false);
        }
        gifs.push({
          key,
          kind: "gif",
          timeSeconds: startSeconds + clipDuration / 2,
          startSeconds,
          durationSeconds: clipDuration,
          file,
          width,
          bytes: fs.statSync(outputPath).size,
          sha256: fileSha256(outputPath)
        });
      } else {
        photoIndex += 1;
        const key = `photo-${String(photoIndex).padStart(2, "0")}`;
        const file = `${key}.jpg`;
        const outputPath = path.join(tempBundle, file);
        const renderedAt = await renderWithDecodeFallback(
          timeSeconds,
          sample.start,
          sample.end,
          outputPath,
          (candidate, fastSeek) => writePhoto(media, candidate, outputPath, fastSeek),
          true
        );
        photos.push({
          key,
          kind: "photo",
          timeSeconds: renderedAt,
          startSeconds: renderedAt,
          durationSeconds: 0,
          file,
          width: config.contentPreview.photoWidth,
          bytes: fs.statSync(outputPath).size,
          sha256: fileSha256(outputPath)
        });
      }
    }

    const generatedAt = new Date().toISOString();
    const manifest: ContentPreviewManifest = {
      version: config.contentPreview.profileVersion,
      mediaId: media.id,
      sourceSignature,
      generatedAt,
      durationSeconds,
      window: sample,
      photos,
      gifs,
      totalBytes: [...photos, ...gifs].reduce((sum, asset) => sum + asset.bytes, 0)
    };
    fs.writeFileSync(path.join(tempBundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (fs.existsSync(finalBundle)) {
      fs.renameSync(finalBundle, `${finalBundle}.incomplete-${Date.now()}`);
    }
    fs.renameSync(tempBundle, finalBundle);
    rememberManifest(finalManifest, manifest);
    markContentPreview(media, {
      status: "ready",
      manifestPath: finalManifest,
      bytes: manifest.totalBytes,
      sourceSignature,
      generatedAt
    });
    return manifest;
  } finally {
    fs.rmSync(tempBundle, { recursive: true, force: true });
  }
}

registerMediaJobHandler("content-preview", async (_job, media) => {
  if (!media) throw new Error("Media file no longer exists");
  try {
    await generateContentPreview(media);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "CONTENT_PREVIEW_STORAGE_WAIT") {
      markContentPreview(media, { status: "pending" });
    } else {
      markContentPreview(media, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    throw error;
  }
});

export function requestContentPreview(media: MediaRow, priority = 70): string {
  if (media.media_type !== "video") throw new Error("Content preview only supports video files");
  const storage = inspectContentPreviewStorage();
  if (!storage.ready) throw storageWaitError(storage.message);
  return scheduleContentPreview(media, priority).jobId;
}

export type ContentPreviewScheduleResult = {
  status: "ready" | "queued" | "deferred";
  jobId: string;
  reason: string | null;
};

export function scheduleContentPreview(media: MediaRow, priority = 60): ContentPreviewScheduleResult {
  if (media.media_type !== "video") throw new Error("Content preview only supports video files");
  const storage = inspectContentPreviewStorage();
  if (storage.ready && getContentPreview(media.id).status === "ready") {
    return { status: "ready", jobId: "", reason: null };
  }
  const durationSeconds = media.duration_seconds ?? 0;
  const sourceSignature = durationSeconds > 0 ? createContentPreviewSourceSignature(media, durationSeconds) : "";
  markContentPreview(media, { status: "pending", sourceSignature });
  if (!storage.ready) {
    return { status: "deferred", jobId: "", reason: storage.message };
  }
  return {
    status: "queued",
    jobId: enqueueMediaJob(media.id, "content-preview", { priority }),
    reason: null
  };
}

registerMediaJobIdleRefillHandler("content-preview-pending", () => {
  if (!inspectContentPreviewStorage().ready) return 0;
  const rows = db.prepare(`
    SELECT media_files.*
    FROM media_files
    LEFT JOIN media_storyboards ON media_storyboards.media_id = media_files.id
    WHERE media_files.media_type = 'video'
      AND COALESCE(media_storyboards.content_status, 'missing') IN ('missing', 'pending')
      AND NOT EXISTS (
        SELECT 1 FROM media_jobs
        WHERE media_jobs.media_id = media_files.id
          AND media_jobs.job_type = 'content-preview'
          AND media_jobs.status IN ('pending', 'running')
      )
    ORDER BY media_files.mtime_ms DESC, media_files.id
    LIMIT 12
  `).all() as MediaRow[];
  for (const media of rows) scheduleContentPreview(media, 60);
  return rows.length;
});

function emptyResponse(mediaId: string, status: ContentPreviewStatus, storageAvailable: boolean, error: string | null = null): ContentPreviewResponse {
  return {
    mediaId,
    storageAvailable,
    status,
    photos: [],
    gifs: [],
    totalBytes: 0,
    generatedAt: null,
    fallbackShort: false,
    error
  };
}

export function getContentPreview(mediaId: string): ContentPreviewResponse {
  const storage = inspectContentPreviewStorage();
  if (!storage.ready) return emptyResponse(mediaId, "unavailable", false);
  const media = db.prepare("SELECT * FROM media_files WHERE id = ?").get(mediaId) as MediaRow | undefined;
  if (!media) return emptyResponse(mediaId, "missing", true, "Media not found");
  const row = readContentPreviewRow(mediaId);
  if (!row || row.status === "missing") return emptyResponse(mediaId, "missing", true);
  if (row.status === "pending") return emptyResponse(mediaId, "pending", true);
  if (row.status === "failed") return emptyResponse(mediaId, "failed", true, row.error);
  const durationSeconds = media.duration_seconds ?? 0;
  const signature = durationSeconds > 0 ? createContentPreviewSourceSignature(media, durationSeconds) : row.sourceSignature;
  if (!signature || row.sourceSignature !== signature || row.version !== config.contentPreview.profileVersion) {
    return emptyResponse(mediaId, "stale", true);
  }
  const manifest = readManifest(row.manifestPath);
  if (!manifest || manifest.sourceSignature !== signature) return emptyResponse(mediaId, "stale", true);
  const mapAsset = (asset: ContentPreviewAsset) => ({
    key: asset.key,
    kind: asset.kind,
    timeSeconds: asset.timeSeconds,
    startSeconds: asset.startSeconds,
    durationSeconds: asset.durationSeconds,
    width: asset.width,
    bytes: asset.bytes,
    url: `/api/media/${encodeURIComponent(mediaId)}/content-preview/assets/${encodeURIComponent(asset.key)}?v=${signature}`
  });
  return {
    mediaId,
    storageAvailable: true,
    status: "ready",
    photos: manifest.photos.map(mapAsset),
    gifs: manifest.gifs.map(mapAsset),
    totalBytes: manifest.totalBytes,
    generatedAt: manifest.generatedAt,
    fallbackShort: manifest.window.fallbackShort,
    error: null
  };
}

export function getContentPreviewAsset(mediaId: string, assetKey: string): { path: string; mimeType: string } | null {
  const storage = inspectContentPreviewStorage();
  if (!storage.ready || !/^(?:photo|motion)-\d{2}$/.test(assetKey)) return null;
  const row = readContentPreviewRow(mediaId);
  if (!row || row.status !== "ready") return null;
  const manifest = readManifest(row.manifestPath);
  if (!manifest) return null;
  const asset = [...manifest.photos, ...manifest.gifs].find((entry) => entry.key === assetKey);
  if (!asset) return null;
  const assetPath = path.join(path.dirname(row.manifestPath), asset.file);
  if (!isInsideRoot(config.contentPreview.root, assetPath) || !fs.existsSync(assetPath)) return null;
  const previousTouch = lastTouchByMedia.get(mediaId) ?? 0;
  if (Date.now() - previousTouch > 5 * 60 * 1000) {
    lastTouchByMedia.set(mediaId, Date.now());
    db.prepare("UPDATE media_storyboards SET content_last_accessed_at = ? WHERE media_id = ?")
      .run(new Date().toISOString(), mediaId);
  }
  return { path: assetPath, mimeType: asset.kind === "gif" ? "image/gif" : "image/jpeg" };
}
