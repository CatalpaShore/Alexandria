import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, type MediaRow } from "./db.js";
import { enqueueMediaJob, registerMediaJobHandler, wasMediaJobRecentlyFailed } from "./mediaJobs.js";
import { subtitleToVtt, decodeText } from "./services/subtitleService.js";

type SubtitleSidecar = {
  id: string;
  mediaId: string;
  absolutePath: string;
  format: string;
  mtimeMs: number;
};

const subtitleCacheDir = path.join(config.derivativeDir, "subtitles");

function getMediaSubtitles(mediaId: string): SubtitleSidecar[] {
  return db.prepare(`
    SELECT id, media_id AS mediaId, absolute_path AS absolutePath,
      format, mtime_ms AS mtimeMs
    FROM media_sidecars
    WHERE media_id = ? AND kind = 'subtitle'
    ORDER BY id
  `).all(mediaId) as SubtitleSidecar[];
}

function markSubtitle(sidecar: SubtitleSidecar, values: {
  status: "pending" | "ready" | "failed";
  path?: string;
  bytes?: number;
  error?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO media_subtitle_cache (
      sidecar_id, media_id, path, status, bytes, source_mtime_ms,
      error, created_at, updated_at, last_accessed_at
    ) VALUES (
      @sidecarId, @mediaId, @path, @status, @bytes, @sourceMtimeMs,
      @error, @now, @now, @lastAccessedAt
    )
    ON CONFLICT(sidecar_id) DO UPDATE SET
      media_id = excluded.media_id,
      path = excluded.path,
      status = excluded.status,
      bytes = excluded.bytes,
      source_mtime_ms = excluded.source_mtime_ms,
      error = excluded.error,
      updated_at = excluded.updated_at,
      last_accessed_at = excluded.last_accessed_at
  `).run({
    sidecarId: sidecar.id,
    mediaId: sidecar.mediaId,
    path: values.path ?? "",
    status: values.status,
    bytes: values.bytes ?? 0,
    sourceMtimeMs: sidecar.mtimeMs,
    error: values.error ?? null,
    now,
    lastAccessedAt: values.status === "ready" ? now : null
  });
}

async function buildSubtitleCache(media: MediaRow): Promise<void> {
  fs.mkdirSync(subtitleCacheDir, { recursive: true });
  const failures: string[] = [];
  for (const sidecar of getMediaSubtitles(media.id)) {
    const outputPath = path.join(subtitleCacheDir, `${sidecar.id}.vtt`);
    const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const content = decodeText(await fs.promises.readFile(sidecar.absolutePath));
      await fs.promises.writeFile(tempPath, subtitleToVtt(content, sidecar.format), "utf8");
      await fs.promises.rename(tempPath, outputPath);
      markSubtitle(sidecar, {
        status: "ready",
        path: outputPath,
        bytes: (await fs.promises.stat(outputPath)).size
      });
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      markSubtitle(sidecar, {
        status: "failed",
        error: message
      });
      failures.push(`${sidecar.id}: ${message}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; ").slice(0, 1000));
}

registerMediaJobHandler("subtitle", async (_job, media) => {
  if (!media) throw new Error("Media file no longer exists");
  await buildSubtitleCache(media);
});

export function requestSubtitleCache(mediaId: string, priority = 110): string {
  if (wasMediaJobRecentlyFailed(mediaId, "subtitle", 60 * 60 * 1000)) return "";
  for (const sidecar of getMediaSubtitles(mediaId)) markSubtitle(sidecar, { status: "pending" });
  return enqueueMediaJob(mediaId, "subtitle", { priority });
}

export function enqueuePendingSubtitleJobs(limit = 240): number {
  const rows = db.prepare(`
    SELECT DISTINCT sidecars.media_id AS mediaId
    FROM media_sidecars sidecars
    LEFT JOIN media_subtitle_cache cache ON cache.sidecar_id = sidecars.id
    WHERE sidecars.kind = 'subtitle'
      AND (
        cache.sidecar_id IS NULL
        OR cache.status != 'ready'
        OR cache.source_mtime_ms != sidecars.mtime_ms
        OR cache.path = ''
      )
    ORDER BY sidecars.updated_at DESC
    LIMIT ?
  `).all(limit) as Array<{ mediaId: string }>;
  for (const row of rows) requestSubtitleCache(row.mediaId, -5);
  return rows.length;
}

export function getCachedSubtitle(sidecarId: string): { path: string; mediaId: string } | null {
  const row = db.prepare(`
    SELECT cache.path, cache.media_id AS mediaId,
      cache.source_mtime_ms AS sourceMtimeMs, sidecars.mtime_ms AS sidecarMtimeMs
    FROM media_subtitle_cache cache
    JOIN media_sidecars sidecars ON sidecars.id = cache.sidecar_id
    WHERE cache.sidecar_id = ? AND cache.status = 'ready'
  `).get(sidecarId) as {
    path: string;
    mediaId: string;
    sourceMtimeMs: number;
    sidecarMtimeMs: number;
  } | undefined;
  if (!row || row.sourceMtimeMs !== row.sidecarMtimeMs || !fs.existsSync(row.path)) return null;
  db.prepare("UPDATE media_subtitle_cache SET last_accessed_at = ? WHERE sidecar_id = ?")
    .run(new Date().toISOString(), sidecarId);
  return { path: row.path, mediaId: row.mediaId };
}
