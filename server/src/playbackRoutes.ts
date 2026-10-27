import fs from "node:fs";
import { config } from "./config.js";
import { registerEmbeddedSubtitleRoutes } from "./embeddedSubtitleTracks.js";
import { decodeText, subtitleToVtt, ENCODINGS } from "./services/subtitleService.js";
import path from "node:path";
import type { Express, Response } from "express";
import { z } from "zod";
import { db, type MediaRow } from "./db.js";
import { getMediaDerivative, requestPlaybackDerivative, type DerivativeKind } from "./mediaDerivatives.js";
import {
  enqueueMediaJob,
  getMediaJobStatus,
  isMediaProbeAvailable,
  isMediaTranscodeAvailable,
  markPlaybackActivity
} from "./mediaJobs.js";
import { ensureInsideMediaRoot, pipeFileStream, streamFile, streamMedia } from "./services/fileStreaming.js";
import { getStoryboardFiles, getStoryboardManifest, requestStoryboard } from "./storyboards.js";
import { getCachedSubtitle, requestSubtitleCache } from "./subtitleDerivatives.js";
import { getReadyTranslationSidecar } from "./subtitleTranslation.js";

const readinessRequestSchema = z.object({
  playback: z.boolean().default(true),
  storyboard: z.boolean().default(false)
});

const compatibilityActionSchema = z.object({
  action: z.enum(["probe", "remux", "hls"])
});

const compatibilityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(12).max(100).default(48),
  status: z.enum(["ALL", "unknown", "native", "remux", "transcode", "unsupported"]).default("ALL")
});

const playbackProgressSchema = z.object({
  positionSeconds: z.coerce.number().min(0).default(0),
  durationSeconds: z.coerce.number().min(0).nullable().optional(),
  completed: z.boolean().optional(),
  started: z.boolean().optional()
});

type PlaybackProgressRow = {
  position_seconds: number;
  duration_seconds: number | null;
  completed: number;
  play_count: number;
  last_played_at: string;
};

function getMedia(id: string): MediaRow | undefined {
  return db.prepare("SELECT * FROM media_files WHERE id = ?").get(id) as MediaRow | undefined;
}

type PlaybackDerivativeStatus = "missing" | "pending" | "ready" | "failed";
type PlaybackFailureReason = "source_unavailable" | "ffmpeg_unavailable" | "preparation_failed" | null;

function sourceIsAvailable(media: MediaRow): boolean {
  try {
    return fs.statSync(media.absolute_path).isFile();
  } catch {
    return false;
  }
}

function rejectUnavailableMediaSource(res: Response): void {
  res.status(409).json({
    code: "MEDIA_SOURCE_UNAVAILABLE",
    error: "视频源暂未连接，当前仅可浏览固态硬盘中的馆藏数据"
  });
}

function classifyPlaybackFailure(error: string | null): PlaybackFailureReason {
  if (!error) return null;
  if (/no such file|source.*unavailable|media file no longer exists/i.test(error)) return "source_unavailable";
  if (/ffmpeg.*unavailable|spawn ffmpeg.*enoent/i.test(error)) return "ffmpeg_unavailable";
  return "preparation_failed";
}

function getPlaybackDerivativeState(
  mediaId: string,
  kind: "remux" | "hls",
  ready: boolean
): { status: PlaybackDerivativeStatus; failureReason: PlaybackFailureReason } {
  const row = db.prepare(`
    SELECT status, error
    FROM media_derivatives
    WHERE media_id = ? AND kind = ? AND variant = 'default'
  `).get(mediaId, kind) as { status: PlaybackDerivativeStatus; error: string | null } | undefined;
  if (ready) return { status: "ready", failureReason: null };
  if (!row) return { status: "missing", failureReason: null };
  return {
    status: row.status,
    failureReason: row.status === "failed" ? classifyPlaybackFailure(row.error) : null
  };
}

function buildPlaybackSource(media: MediaRow) {
  const sourceAvailable = sourceIsAvailable(media);
  const remux = getMediaDerivative(media.id, "remux");
  const hls = getMediaDerivative(media.id, "hls");
  const preferred = !sourceAvailable
    ? "source"
    : media.compatibility_status === "native"
      ? "source"
      : remux
        ? "remux"
        : hls
          ? "hls"
          : "source";
  return {
    compatibilityStatus: media.compatibility_status,
    probeStatus: media.probe_status,
    sourceAvailable,
    preferred,
    url: preferred === "hls"
      ? `/api/media/${media.id}/hls/master.m3u8`
      : preferred === "remux"
        ? `/api/media/${media.id}/derivatives/remux`
        : `/api/media/${media.id}/stream`,
    remuxReady: Boolean(remux),
    hlsReady: Boolean(hls),
    derivatives: {
      remux: getPlaybackDerivativeState(media.id, "remux", Boolean(remux)),
      hls: getPlaybackDerivativeState(media.id, "hls", Boolean(hls))
    }
  } as const;
}

function buildReadiness(media: MediaRow) {
  const playbackSource = buildPlaybackSource(media);
  const remux = playbackSource.remuxReady;
  const hls = playbackSource.hlsReady;
  const storyboard = getStoryboardManifest(media.id);
  const recommendedAction = !playbackSource.sourceAvailable
    ? null
    : media.probe_status !== "ready"
    ? "probe"
    : media.compatibility_status === "remux" && !remux
      ? "remux"
      : ["transcode", "unsupported"].includes(media.compatibility_status) && !hls
        ? "hls"
        : null;
  return {
    mediaId: media.id,
    probeStatus: media.probe_status,
    compatibilityStatus: media.compatibility_status,
    recommendedAction,
    sourceAvailable: playbackSource.sourceAvailable,
    playbackReady: playbackSource.sourceAvailable
      && (media.compatibility_status === "native" || remux || hls),
    preferred: playbackSource.preferred,
    remuxReady: remux,
    hlsReady: hls,
    derivatives: playbackSource.derivatives,
    storyboard,
    jobs: getMediaJobStatus()
  };
}

function buildPlaybackPayload(row: PlaybackProgressRow) {
  return {
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    completed: Boolean(row.completed),
    playCount: row.play_count,
    lastPlayedAt: row.last_played_at
  };
}

function getPlaybackProgress(media: MediaRow): PlaybackProgressRow | undefined {
  return db.prepare("SELECT * FROM playback_progress WHERE relative_path = ?").get(media.relative_path) as
    | PlaybackProgressRow
    | undefined;
}

function upsertPlaybackProgress(media: MediaRow, body: z.infer<typeof playbackProgressSchema>) {
  const now = new Date().toISOString();
  const durationSeconds = body.durationSeconds ?? media.duration_seconds ?? null;
  const completed = body.completed ?? Boolean(
    durationSeconds && durationSeconds > 0 && durationSeconds - body.positionSeconds <= 30
  );

  db.prepare(`
    INSERT INTO playback_progress (
      relative_path, media_id, position_seconds, duration_seconds,
      completed, play_count, last_played_at, updated_at
    )
    VALUES (
      @relativePath, @mediaId, @positionSeconds, @durationSeconds,
      @completed, CASE WHEN @started = 1 THEN 1 ELSE 0 END, @now, @now
    )
    ON CONFLICT(relative_path) DO UPDATE SET
      media_id = excluded.media_id,
      position_seconds = excluded.position_seconds,
      duration_seconds = COALESCE(excluded.duration_seconds, playback_progress.duration_seconds),
      completed = excluded.completed,
      play_count = playback_progress.play_count + CASE WHEN @started = 1 THEN 1 ELSE 0 END,
      last_played_at = excluded.last_played_at,
      updated_at = excluded.updated_at
  `).run({
    relativePath: media.relative_path,
    mediaId: media.id,
    positionSeconds: body.positionSeconds,
    durationSeconds,
    completed: completed ? 1 : 0,
    started: body.started ? 1 : 0,
    now
  });

  return getPlaybackProgress(media);
}

function getSidecars(mediaId: string) {
  const sidecars = db.prepare(`
    SELECT sidecars.id, sidecars.kind, sidecars.relative_path AS relativePath,
      sidecars.language, sidecars.label, sidecars.format, sidecars.size,
      sidecars.mtime_ms AS mtimeMs,
      CASE
        WHEN cache.status = 'ready' AND cache.source_mtime_ms = sidecars.mtime_ms THEN 'ready'
        WHEN cache.status = 'failed' THEN 'failed'
        ELSE 'pending'
      END AS cacheStatus
    FROM media_sidecars sidecars
    LEFT JOIN media_subtitle_cache cache ON cache.sidecar_id = sidecars.id
    WHERE sidecars.media_id = ?
    ORDER BY sidecars.kind, sidecars.language, sidecars.label
  `).all(mediaId);
  const translated = getReadyTranslationSidecar(mediaId);
  return translated ? [translated, ...sidecars] : sidecars;
}

export function registerPlaybackRoutes(
  app: Express,
  options: { onDataChanged?: () => void } = {}
): void {
  registerEmbeddedSubtitleRoutes(app);
  app.get("/api/media/:id/stream", (req, res, next) => {
    try {
      const media = getMedia(req.params.id);
      if (!media) return void res.status(404).json({ error: "Media not found" });
      if (!sourceIsAvailable(media)) {
        rejectUnavailableMediaSource(res);
        return;
      }
      markPlaybackActivity();
      streamMedia(media, req, res);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/progress", (req, res, next) => {
    try {
      const media = getMedia(req.params.id);
      if (!media) return void res.status(404).json({ error: "Media not found" });
      const progress = getPlaybackProgress(media);
      res.json({
        id: media.id,
        relativePath: media.relative_path,
        playback: progress ? buildPlaybackPayload(progress) : null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/media/:id/progress", (req, res, next) => {
    try {
      const media = getMedia(req.params.id);
      if (!media) return void res.status(404).json({ error: "Media not found" });
      const body = playbackProgressSchema.parse(req.body ?? {});
      markPlaybackActivity();
      const progress = upsertPlaybackProgress(media, body);
      options.onDataChanged?.();
      res.json({
        id: media.id,
        relativePath: media.relative_path,
        playback: progress ? buildPlaybackPayload(progress) : null
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/media/:id/progress", (req, res, next) => {
    try {
      const media = getMedia(req.params.id);
      if (!media) return void res.status(404).json({ error: "Media not found" });
      db.prepare("DELETE FROM playback_progress WHERE media_id = ? OR relative_path = ?")
        .run(media.id, media.relative_path);
      options.onDataChanged?.();
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/compatibility", (req, res, next) => {
    try {
      const query = compatibilityQuerySchema.parse(req.query);
      const where = query.status === "ALL"
        ? "media_type = 'video'"
        : "media_type = 'video' AND compatibility_status = @status";
      const params = query.status === "ALL" ? {} : { status: query.status };
      const total = db.prepare(`SELECT COUNT(*) AS count FROM media_files WHERE ${where}`).get(params) as {
        count: number;
      };
      const rows = db.prepare(`
        SELECT id, normalized_code AS normalizedCode, name, extension, size,
          duration_seconds AS durationSeconds, width, height, container_format AS containerFormat,
          video_codec AS videoCodec, audio_codec AS audioCodec,
          compatibility_status AS compatibilityStatus, probe_status AS probeStatus,
          probe_error AS probeError
        FROM media_files
        WHERE ${where}
        ORDER BY CASE compatibility_status
          WHEN 'unsupported' THEN 0 WHEN 'transcode' THEN 1 WHEN 'remux' THEN 2 ELSE 3 END,
          mtime_ms DESC
        LIMIT @limit OFFSET @offset
      `).all({ ...params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
      const counts = db.prepare(`
        SELECT compatibility_status AS status, COUNT(*) AS count
        FROM media_files
        WHERE media_type = 'video'
        GROUP BY compatibility_status
      `).all();
      res.json({
        items: rows,
        counts,
        jobs: getMediaJobStatus(),
        total: total.count,
        page: query.page,
        pageSize: query.pageSize
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/media/:id/compatibility", (req, res, next) => {
    try {
      const body = compatibilityActionSchema.parse(req.body);
      const media = getMedia(req.params.id);
      if (!media) return void res.status(404).json({ error: "Media not found" });
      if (!sourceIsAvailable(media)) {
        rejectUnavailableMediaSource(res);
        return;
      }
      if (body.action === "probe" && !isMediaProbeAvailable()) {
        return void res.status(503).json({ error: "ffprobe is unavailable in this runtime" });
      }
      if (body.action !== "probe" && !isMediaTranscodeAvailable()) {
        return void res.status(503).json({ error: "ffmpeg is unavailable in this runtime" });
      }
      const jobId = body.action === "probe"
        ? enqueueMediaJob(media.id, "probe", { priority: 120 })
        : requestPlaybackDerivative(media, body.action);
      res.status(202).json({ jobId, action: body.action });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/playback-source", (req, res) => {
    const media = getMedia(req.params.id);
    if (!media) return void res.status(404).json({ error: "Media not found" });
    res.json(buildPlaybackSource(media));
  });

  app.get("/api/media/:id/derivatives/:kind", (req, res) => {
    const kind = req.params.kind === "remux" ? "remux" : null;
    if (!kind) return void res.status(400).json({ error: "Unsupported derivative" });
    const media = getMedia(req.params.id);
    if (!media) return void res.status(404).json({ error: "Media not found" });
    if (!sourceIsAvailable(media)) return void rejectUnavailableMediaSource(res);
    const derivative = getMediaDerivative(req.params.id, kind as DerivativeKind);
    if (!derivative) return void res.status(404).json({ error: "Derivative not ready" });
    streamFile(derivative.path, derivative.mimeType, req, res);
  });

  app.get("/api/media/:id/hls/:file", (req, res) => {
    const media = getMedia(req.params.id);
    if (!media) return void res.status(404).json({ error: "Media not found" });
    if (!sourceIsAvailable(media)) return void rejectUnavailableMediaSource(res);
    const derivative = getMediaDerivative(req.params.id, "hls");
    if (!derivative) return void res.status(404).json({ error: "HLS derivative not ready" });
    const file = path.basename(req.params.file);
    const filePath = path.join(path.dirname(derivative.path), file);
    if (!fs.existsSync(filePath)) return void res.status(404).end();
    res.setHeader("Cache-Control", file.endsWith(".m3u8") ? "no-cache" : "private, max-age=86400");
    res.type(file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
    pipeFileStream(fs.createReadStream(filePath), res);
  });

  app.get("/api/media/:id/sidecars", (req, res) => {
    res.json({ items: getSidecars(req.params.id) });
  });

  app.get("/api/sidecars/:id/track.vtt", async (req, res, next) => {
    const row = db.prepare("SELECT media_id, absolute_path, format FROM media_sidecars WHERE id = ? AND kind = 'subtitle'").get(req.params.id) as
      | { media_id: string; absolute_path: string; format: string }
      | undefined;
    if (!row) return void res.status(404).end();
    try {
      ensureInsideMediaRoot(row.absolute_path);
      if (typeof req.query.encoding === "string" && req.query.encoding !== "auto") {
        if (!(ENCODINGS as readonly string[]).includes(req.query.encoding)) {
          return void res.status(400).json({ error: "Unsupported subtitle encoding" });
        }
        if ((await fs.promises.stat(row.absolute_path)).size > 16 * 1024 * 1024) {
          return void res.status(413).json({ error: "Subtitle exceeds 16 MiB" });
        }
        const content = decodeText(await fs.promises.readFile(row.absolute_path), req.query.encoding);
        res.setHeader("Cache-Control", "private, no-store");
        return void res.type("text/vtt").send(subtitleToVtt(content, row.format));
      }
      let cached = getCachedSubtitle(req.params.id);
      if (!cached) {
        requestSubtitleCache(row.media_id, 110);
        const deadline = Date.now() + 2_500;
        while (!cached && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          cached = getCachedSubtitle(req.params.id);
        }
      }
      if (!cached) {
        res.setHeader("Retry-After", "2");
        return void res.status(503).json({ error: "Subtitle cache is being prepared" });
      }
      streamFile(cached.path, "text/vtt; charset=utf-8", req, res);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sidecars/:id/raw", (req, res) => {
    const row = db.prepare("SELECT absolute_path, format FROM media_sidecars WHERE id = ?").get(req.params.id) as
      | { absolute_path: string; format: string }
      | undefined;
    if (!row) return void res.status(404).end();
    ensureInsideMediaRoot(row.absolute_path);
    streamFile(
      row.absolute_path,
      row.format === "nfo" ? "text/plain; charset=utf-8" : "application/octet-stream",
      req,
      res
    );
  });

  app.get("/api/media/:id/readiness", (req, res) => {
    const media = getMedia(req.params.id);
    if (!media) return void res.status(404).json({ error: "Media not found" });
    res.json(buildReadiness(media));
  });

  app.post("/api/media/:id/readiness", (req, res, next) => {
    try {
      const media = getMedia(req.params.id);
      if (!media) return void res.status(404).json({ error: "Media not found" });
      if (!sourceIsAvailable(media)) {
        return void res.status(409).json({
          code: "MEDIA_SOURCE_UNAVAILABLE",
          error: "视频源暂未连接，当前仅可浏览固态硬盘中的馆藏数据",
          readiness: buildReadiness(media)
        });
      }
      const input = readinessRequestSchema.parse(req.body ?? {});
      const jobs: string[] = [];
      if (media.probe_status !== "ready") {
        jobs.push(enqueueMediaJob(media.id, "probe", { priority: 130 }));
      } else if (input.playback && media.compatibility_status === "remux" && !getMediaDerivative(media.id, "remux")) {
        jobs.push(requestPlaybackDerivative(media, "remux"));
      } else if (
        input.playback
        && ["transcode", "unsupported"].includes(media.compatibility_status)
        && !getMediaDerivative(media.id, "hls")
      ) {
        jobs.push(requestPlaybackDerivative(media, "hls"));
      }
      if (input.storyboard) {
        const jobId = requestStoryboard(media);
        if (jobId) jobs.push(jobId);
      }
      res.status(jobs.length > 0 ? 202 : 200).json({
        jobs: jobs.filter(Boolean),
        readiness: buildReadiness(media)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/storyboard", (req, res) => {
    const media = getMedia(req.params.id);
    if (!media) return void res.status(404).json({ error: "Media not found" });
    res.json(getStoryboardManifest(media.id) ?? { mediaId: media.id, status: "missing", imageUrl: "", cues: [] });
  });

  app.post("/api/media/:id/storyboard", (req, res, next) => {
    try {
      const media = getMedia(req.params.id);
      if (!media) return void res.status(404).json({ error: "Media not found" });
      const jobId = requestStoryboard(media);
      res.status(jobId ? 202 : 200).json({ jobId, storyboard: getStoryboardManifest(media.id) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/storyboard/image", (req, res) => {
    const files = getStoryboardFiles(req.params.id);
    if (!files) return void res.status(404).end();
    const stat = fs.statSync(files.imagePath);
    res.setHeader("Content-Type", path.extname(files.imagePath).toLowerCase() === ".webp" ? "image/webp" : "image/jpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    fs.createReadStream(files.imagePath).pipe(res);
  });

  app.get("/api/media/:id/external-player", (req, res) => {
    const media = getMedia(req.params.id);
    if (!media) return void res.status(404).json({ error: "Media not found" });
    if (!sourceIsAvailable(media)) return void rejectUnavailableMediaSource(res);
    const forwardedHost = config.network.trustProxy ? req.get("x-forwarded-host")?.split(",")[0]?.trim() : undefined;
    const baseUrl = `${req.protocol}://${forwardedHost || req.get("host")}`;
    const streamUrl = `${baseUrl}/api/media/${media.id}/stream`;
    res.json({
      mediaId: media.id,
      streamUrl,
      links: {
        vlc: `vlc://${streamUrl}`,
        infuse: `infuse://x-callback-url/play?url=${encodeURIComponent(streamUrl)}`
      }
    });
  });
}

export const registerPlaybackCapabilityRoutes = registerPlaybackRoutes;
