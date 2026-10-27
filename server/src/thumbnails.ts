import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { trackFfmpegProcess } from "./ffmpegProcesses.js";
import { withMediaWorkerFfmpegLimits } from "./ffmpegResources.js";
import { statements, type MediaRow } from "./db.js";
import {
  enqueueMediaJob,
  isMediaTranscodeAvailable,
  registerMediaJobHandler,
  wasMediaJobRecentlyFailed
} from "./mediaJobs.js";
import { probeMediaFile } from "./mediaProbe.js";

type ThumbnailResult =
  | { kind: "file"; path: string; mimeType: string }
  | { kind: "placeholder"; svg: string };

function getThumbnailPath(row: MediaRow): string {
  return path.join(config.thumbnailDir, `${row.id}-m10.jpg`);
}

function updateThumbnail(
  row: MediaRow,
  thumbnailPath: string | null,
  status: MediaRow["thumbnail_status"]
) {
  statements.updateThumbnail.run({
    id: row.id,
    thumbnail_path: thumbnailPath,
    thumbnail_status: status
  });
}

function buildPlaceholder(row: MediaRow): ThumbnailResult {
  const title = row.normalized_code || row.basename;
  const prefix = row.code_prefix || row.first_letter || "MEDIA";
  const subtitle = parseTags(row.variant_tags).slice(0, 3).join(" / ");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
      <rect width="640" height="400" fill="#111111"/>
      <rect x="34" y="34" width="572" height="332" rx="8" fill="#181818" stroke="#3a3a3a" stroke-width="3" stroke-dasharray="10 10"/>
      <text x="50%" y="44%" text-anchor="middle" font-family="Arial, sans-serif" font-size="54" font-weight="800" fill="#ff9900">${escapeXml(prefix)}</text>
      <text x="50%" y="58%" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#f5f5f5">${escapeXml(title)}</text>
      <text x="50%" y="70%" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#9a9a9a">${escapeXml(subtitle)}</text>
    </svg>
  `;

  return { kind: "placeholder", svg };
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function generateVideoThumbnail(row: MediaRow): Promise<ThumbnailResult> {
  const thumbnailPath = getThumbnailPath(row);
  fs.mkdirSync(config.thumbnailDir, { recursive: true });

  let duration = row.duration_seconds;
  if (row.probe_status !== "ready" || !duration) {
    try {
      const probe = await probeMediaFile(row);
      duration = probe.durationSeconds;
      statements.updateMediaProbe.run({
        id: row.id,
        duration_seconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        container_format: probe.containerFormat,
        video_codec: probe.videoCodec,
        audio_codec: probe.audioCodec,
        compatibility_status: probe.compatibilityStatus,
        probe_status: "ready",
        probe_error: null,
        probed_at: new Date().toISOString()
      });
    } catch {
      // Thumbnail extraction can still succeed even if ffprobe cannot read every field.
    }
  }
  const preferredSeek = duration && duration < 600 ? Math.max(10, Math.floor(duration * 0.35)) : 600;
  let seekCandidates = [...new Set([preferredSeek, 600, 300, 120, 30, 10])].filter((seconds) => {
    if (!duration) return true;
    return seconds < duration - 2;
  });
  if (seekCandidates.length === 0) {
    seekCandidates = [Math.max(1, Math.floor((duration ?? 20) / 2))];
  }

  let lastError: unknown = null;
  for (const seconds of seekCandidates) {
    try {
      await captureFrame(row.absolute_path, thumbnailPath, seconds);
      updateThumbnail(row, thumbnailPath, "ready");
      return { kind: "file", path: thumbnailPath, mimeType: "image/jpeg" };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to generate thumbnail");
}

registerMediaJobHandler("thumbnail", async (_job, media) => {
  if (!media) throw new Error("Media file no longer exists");
  await generateVideoThumbnail(media);
});

async function captureFrame(filePath: string, thumbnailPath: string, seekSeconds: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = trackFfmpegProcess(spawn(
      "ffmpeg",
      withMediaWorkerFfmpegLimits([
        "-y",
        "-ss",
        String(seekSeconds),
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-vf",
        "scale=640:-2",
        "-q:v",
        "5",
        "-threads",
        String(config.mediaWorkerFfmpegThreads),
        thumbnailPath
      ]),
      { stdio: "ignore" }
    ));

    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      reject(new Error("Thumbnail generation timed out"));
    }, 20_000);

    ffmpeg.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ffmpeg.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && fs.existsSync(thumbnailPath)) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

export async function ensureThumbnail(row: MediaRow): Promise<ThumbnailResult> {
  if (row.media_type === "image") {
    return { kind: "file", path: row.absolute_path, mimeType: row.mime_type };
  }

  const generatedThumbnailPath = getThumbnailPath(row);
  const thumbnailCandidates = [row.thumbnail_path, generatedThumbnailPath]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  const existingThumbnailPath = thumbnailCandidates.find((candidate) => {
    try {
      return fs.statSync(candidate).size > 0;
    } catch {
      return false;
    }
  });
  if (existingThumbnailPath) {
    if (row.thumbnail_status !== "ready" || row.thumbnail_path !== existingThumbnailPath) {
      updateThumbnail(row, existingThumbnailPath, "ready");
    }
    return { kind: "file", path: existingThumbnailPath, mimeType: "image/jpeg" };
  }

  if (isMediaTranscodeAvailable() && !wasMediaJobRecentlyFailed(row.id, "thumbnail")) {
    enqueueMediaJob(row.id, "thumbnail", { priority: 30 });
  }
  return buildPlaceholder(row);
}
