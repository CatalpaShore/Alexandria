import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, statements, type MediaRow } from "./db.js";
import { stopActiveFfmpegProcesses } from "./ffmpegProcesses.js";
import { probeMediaFile } from "./mediaProbe.js";
import { config } from "./config.js";
import { inspectExternalAiRuntime } from "./externalAiRuntime.js";
import { getMediaWorkerScheduleState, selectMediaWorkerJobTypes } from "./mediaWorkerPolicy.js";

export type MediaJobType = "probe" | "thumbnail" | "poster-card" | "poster-detail" | "remux" | "hls" | "storyboard" | "content-preview" | "highlight" | "subtitle" | "subtitle-translate";

type MediaJobRow = {
  id: string;
  media_id: string;
  job_type: MediaJobType;
  priority: number;
  status: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
};

type MediaJobIdleRefillHandler = () => number | void;

const handlers = new Map<MediaJobType, (job: MediaJobRow, media: MediaRow | null) => Promise<void>>();
const idleRefillHandlers = new Map<string, MediaJobIdleRefillHandler>();
const ffmpegJobTypes = new Set<MediaJobType>(["thumbnail", "poster-card", "poster-detail", "remux", "hls", "storyboard", "content-preview", "highlight"]);
const playbackActivityKey = "media-worker:playback-active";
const workerHeartbeatKey = "media-worker:heartbeat";
const playbackActiveWindowMs = 45_000;
const workerHeartbeatWindowMs = 90_000;
const playbackActivityWriteIntervalMs = 5_000;
const jobLeaseMs = 2 * 60 * 1000;
const jobHeartbeatMs = 30_000;
const staleLegacyJobMs = 15 * 60 * 1000;
const workerInstanceId = `${process.pid}-${crypto.randomUUID()}`;
const defaultMaxAttempts: Record<MediaJobType, number> = {
  probe: 3,
  thumbnail: 2,
  "poster-card": 2,
  "poster-detail": 2,
  remux: 2,
  hls: 2,
  storyboard: 2,
  "content-preview": 3,
  highlight: 2,
  subtitle: 3,
  "subtitle-translate": 1
};

export const mediaSourceWaitMessage = "媒体源卷不可用，等待自动重连";

export function mediaSourceWaitError(): Error & { code: "MEDIA_SOURCE_WAIT" } {
  return Object.assign(new Error(mediaSourceWaitMessage), { code: "MEDIA_SOURCE_WAIT" as const });
}

export function isMediaSourceWaitError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "MEDIA_SOURCE_WAIT";
}

function isExecutableAvailable(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        fs.accessSync(path.join(directory, command), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

let workerRunning = false;
let stopRequested = false;
let workerCompletion: Promise<void> | null = null;
let lastPlaybackActivityWriteAt = 0;
let lastProbeRefillAt = Date.now();
let lastPosterRecoveryAt = 0;
let lastStaleRecoveryAt = Date.now();
let lastIdleRefillAt = 0;
let lastSqliteBusyLogAt = 0;
let lastDaytimeBackgroundStartedAt = Date.now();
let probeToolUnavailable = !isExecutableAvailable("ffprobe");
let ffmpegToolUnavailable = !isExecutableAvailable("ffmpeg");

function isTransientSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return String(error.code).startsWith("SQLITE_BUSY");
}

export function registerMediaJobHandler(
  jobType: MediaJobType,
  handler: (job: MediaJobRow, media: MediaRow | null) => Promise<void>
): void {
  handlers.set(jobType, handler);
}

export function registerMediaJobIdleRefillHandler(name: string, handler: MediaJobIdleRefillHandler): void {
  idleRefillHandlers.set(name, handler);
}

function refillIdleMediaJobQueues(now = Date.now()): void {
  if (now - lastIdleRefillAt < 5_000) return;
  lastIdleRefillAt = now;
  for (const [name, handler] of idleRefillHandlers) {
    try {
      handler();
    } catch (error) {
      console.error(`Media job idle refiller ${name} failed:`, error);
    }
  }
}

export function enqueueMediaJob(
  mediaId: string,
  jobType: MediaJobType,
  options: { priority?: number; payload?: unknown } = {}
): string {
  if (jobType === "probe" && probeToolUnavailable) {
    throw new Error("ffprobe is unavailable in this runtime");
  }
  if (ffmpegJobTypes.has(jobType) && ffmpegToolUnavailable) {
    throw new Error("ffmpeg is unavailable in this runtime");
  }

  const existing = db
    .prepare(
      `
      SELECT id, status, attempts, max_attempts AS maxAttempts, updated_at AS updatedAt
      FROM media_jobs
      WHERE media_id = ? AND job_type = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `
    )
    .get(mediaId, jobType) as {
      id: string;
      status: string;
      attempts: number;
      maxAttempts: number;
      updatedAt: string;
    } | undefined;
  if (existing?.status === "pending" || existing?.status === "running") return existing.id;

  const now = new Date().toISOString();
  const maxAttempts = defaultMaxAttempts[jobType];
  if (existing && existing.attempts < Math.max(existing.maxAttempts, maxAttempts)) {
    const updated = db.prepare(`
      UPDATE media_jobs
      SET status = 'pending', priority = @priority, payload_json = @payloadJson,
        error = NULL, finished_at = NULL, retry_after = NULL,
        lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL,
        max_attempts = @maxAttempts, updated_at = @now
      WHERE id = @id AND status IN ('failed', 'ready')
    `).run({
      id: existing.id,
      priority: options.priority ?? 0,
      payloadJson: JSON.stringify(options.payload ?? {}),
      maxAttempts,
      now
    });
    if (updated.changes > 0) return existing.id;
  }

  const id = crypto.randomUUID();
  db.prepare(
    `
      INSERT INTO media_jobs (
        id, media_id, job_type, priority, status, payload_json,
        attempts, max_attempts, created_at, updated_at
      ) VALUES (
        @id, @mediaId, @jobType, @priority, 'pending', @payloadJson,
        0, @maxAttempts, @now, @now
      )
  `
  ).run({
    id,
    mediaId,
    jobType,
    priority: options.priority ?? 0,
    payloadJson: JSON.stringify(options.payload ?? {}),
    maxAttempts,
    now
  });

  if (jobType === "probe" && mediaId) {
    db.prepare("UPDATE media_files SET probe_status = 'queued' WHERE id = ? AND probe_status != 'ready'").run(mediaId);
  }
  return id;
}

export function enqueuePendingProbeJobs(limit = 200, priority = -10): number {
  if (probeToolUnavailable) return 0;
  const rows = db
    .prepare(
      `
      SELECT id
      FROM media_files
      WHERE media_type = 'video' AND probe_status IN ('pending', 'failed')
        AND (
          SELECT COUNT(*)
          FROM media_jobs failed_jobs
          WHERE failed_jobs.media_id = media_files.id
            AND failed_jobs.job_type = 'probe'
            AND failed_jobs.status = 'failed'
        ) < 3
      ORDER BY
        CASE WHEN duration_seconds IS NULL THEN 0 ELSE 1 END,
        mtime_ms DESC
      LIMIT ?
    `
    )
    .all(limit) as Array<{ id: string }>;

  for (const row of rows) {
    enqueueMediaJob(row.id, "probe", { priority });
  }
  return rows.length;
}

export function requeueRecoverablePosterJobs(limit = 24): number {
  if (ffmpegToolUnavailable) return 0;
  const rows = db.prepare(`
    SELECT jobs.id, jobs.media_id AS mediaId, jobs.job_type AS jobType
    FROM media_jobs jobs
    JOIN media_files ON media_files.id = jobs.media_id
    JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    WHERE jobs.status = 'failed'
      AND jobs.job_type IN ('poster-card', 'poster-detail')
      AND (media_metadata.cover_url != '' OR media_metadata.thumb_url != '')
      AND (
        jobs.error LIKE 'ffmpeg version%' OR
        jobs.error LIKE '%Unknown encoder%libwebp%' OR
        jobs.error LIKE '%Encoder not found%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM media_jobs active
        WHERE active.media_id = jobs.media_id
          AND active.job_type = jobs.job_type
          AND active.status IN ('pending', 'running')
      )
    ORDER BY jobs.updated_at ASC
    LIMIT ?
  `).all(limit) as Array<{ id: string; mediaId: string; jobType: "poster-card" | "poster-detail" }>;
  if (rows.length === 0) return 0;

  const now = new Date().toISOString();
  const revive = db.prepare(`
    UPDATE media_jobs
    SET status = 'pending', attempts = 0, max_attempts = 2, priority = -20,
      error = NULL, retry_after = NULL, started_at = NULL, finished_at = NULL,
      lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL, updated_at = @now
    WHERE id = @id AND status = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM media_jobs active
        WHERE active.media_id = @mediaId
          AND active.job_type = @jobType
          AND active.id != @id
          AND active.status IN ('pending', 'running')
      )
  `);
  const resetDerivative = db.prepare(`
    UPDATE media_derivatives
    SET status = 'pending', error = NULL, updated_at = @now
    WHERE media_id = @mediaId AND kind = 'poster' AND variant = @variant
  `);
  let requeued = 0;
  db.transaction(() => {
    for (const row of rows) {
      const changed = revive.run({
        id: row.id,
        mediaId: row.mediaId,
        jobType: row.jobType,
        now
      }).changes;
      if (!changed) continue;
      requeued += changed;
      resetDerivative.run({
        mediaId: row.mediaId,
        variant: row.jobType === "poster-card" ? "card" : "detail",
        now
      });
    }
  })();
  return requeued;
}

export function markPlaybackActivity(now = Date.now()): void {
  if (now - lastPlaybackActivityWriteAt < playbackActivityWriteIntervalMs) return;
  lastPlaybackActivityWriteAt = now;
  const updatedAt = new Date(now).toISOString();
  db.prepare(
    `
    INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
    VALUES (@key, @timestamp, @updatedAt)
    ON CONFLICT(cache_key) DO UPDATE SET
      source_signature = excluded.source_signature,
      updated_at = excluded.updated_at
  `
  ).run({ key: playbackActivityKey, timestamp: String(now), updatedAt });
}

export function isPlaybackActive(now = Date.now()): boolean {
  const row = db
    .prepare("SELECT source_signature AS timestamp FROM app_cache_state WHERE cache_key = ?")
    .get(playbackActivityKey) as { timestamp: string } | undefined;
  const lastActivity = Number(row?.timestamp ?? 0);
  return Number.isFinite(lastActivity) && now - lastActivity <= playbackActiveWindowMs;
}

export function markMediaWorkerHeartbeat(now = Date.now()): void {
  const updatedAt = new Date(now).toISOString();
  try {
    db.prepare(`
      INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
      VALUES (@key, @timestamp, @updatedAt)
      ON CONFLICT(cache_key) DO UPDATE SET
        source_signature = excluded.source_signature,
        updated_at = excluded.updated_at
    `).run({ key: workerHeartbeatKey, timestamp: String(now), updatedAt });
  } catch (error) {
    if (!isTransientSqliteBusy(error)) throw error;
    // The process-level status timer retries on its next tick.
    const time = Date.now();
    if (time - lastSqliteBusyLogAt >= 30_000) {
      console.warn("Media worker status heartbeat delayed by transient SQLite contention");
      lastSqliteBusyLogAt = time;
    }
  }
}

function hasRecentMediaWorkerHeartbeat(now = Date.now()): boolean {
  const row = db.prepare("SELECT source_signature AS timestamp FROM app_cache_state WHERE cache_key = ?")
    .get(workerHeartbeatKey) as { timestamp: string } | undefined;
  const heartbeat = Number(row?.timestamp ?? 0);
  return Number.isFinite(heartbeat) && now - heartbeat <= workerHeartbeatWindowMs;
}

export function recoverStaleMediaJobs(nowMs = Date.now()): { recovered: number; failed: number } {
  const now = new Date(nowMs).toISOString();
  const legacyCutoff = new Date(nowMs - staleLegacyJobMs).toISOString();
  const staleRows = db.prepare(`
    SELECT id, media_id AS mediaId, job_type AS jobType, attempts, max_attempts AS maxAttempts
    FROM media_jobs
    WHERE status = 'running'
      AND (
        (lease_expires_at IS NOT NULL AND lease_expires_at < @now) OR
        (lease_expires_at IS NULL AND COALESCE(heartbeat_at, started_at, updated_at) < @legacyCutoff)
      )
  `).all({ now, legacyCutoff }) as Array<{
    id: string;
    mediaId: string;
    jobType: MediaJobType;
    attempts: number;
    maxAttempts: number;
  }>;
  if (staleRows.length === 0) return { recovered: 0, failed: 0 };

  const recover = db.prepare(`
    UPDATE media_jobs
    SET status = 'pending', error = '任务执行进程中断，已自动恢复',
      lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL,
      retry_after = @now, started_at = NULL, updated_at = @now
    WHERE id = @id AND status = 'running'
  `);
  const fail = db.prepare(`
    UPDATE media_jobs
    SET status = 'failed', error = '任务执行进程中断且已达到最大重试次数',
      lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL,
      finished_at = @now, updated_at = @now
    WHERE id = @id AND status = 'running'
  `);
  const interruptPlaybackDerivative = db.prepare(`
    UPDATE media_jobs
    SET status = 'failed', error = '播放衍生任务因服务中断，可在下次播放时重新生成',
      lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL,
      finished_at = @now, updated_at = @now
    WHERE id = @id AND status = 'running'
  `);
  const resetPlaybackDerivative = db.prepare(`
    UPDATE media_derivatives
    SET status = 'pending', error = '播放衍生任务因服务中断', updated_at = @now
    WHERE media_id = @mediaId AND kind = @kind AND variant = 'default'
  `);
  let recovered = 0;
  let failed = 0;
  db.transaction(() => {
    for (const row of staleRows) {
      if (row.jobType === "hls" || row.jobType === "remux") {
        failed += interruptPlaybackDerivative.run({ id: row.id, now }).changes;
        resetPlaybackDerivative.run({ mediaId: row.mediaId, kind: row.jobType, now });
        continue;
      }
      if (row.attempts < row.maxAttempts) recovered += recover.run({ id: row.id, now }).changes;
      else failed += fail.run({ id: row.id, now }).changes;
    }
  })();
  return { recovered, failed };
}

function renewJobLease(jobId: string, nowMs = Date.now()): void {
  db.prepare(`
    UPDATE media_jobs
    SET heartbeat_at = @now, lease_expires_at = @expiresAt, updated_at = @now
    WHERE id = @id AND status = 'running' AND lease_owner = @leaseOwner
  `).run({
    id: jobId,
    leaseOwner: workerInstanceId,
    now: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + jobLeaseMs).toISOString()
  });
}

const claimNextJob = db.transaction((
  foregroundOnly: boolean,
  translationRuntimeAvailable: boolean,
  foregroundPriority: number
): MediaJobRow | null => {
  const job = db
    .prepare(
      `
      WITH active_preview_sources AS (
        SELECT
          CASE
            WHEN active_media.source_root LIKE '/Volumes/%/%'
              THEN substr(active_media.source_root, 1, 8 + instr(substr(active_media.source_root, 10), '/'))
            ELSE active_media.source_root
          END AS source_key,
          COUNT(*) AS active_count
        FROM media_jobs active_preview
        JOIN media_files active_media ON active_media.id = active_preview.media_id
        WHERE active_preview.job_type = 'content-preview'
          AND active_preview.status = 'running'
        GROUP BY source_key
      ), pending_preview_sources AS (
        SELECT DISTINCT
          CASE
            WHEN pending_media.source_root LIKE '/Volumes/%/%'
              THEN substr(pending_media.source_root, 1, 8 + instr(substr(pending_media.source_root, 10), '/'))
            ELSE pending_media.source_root
          END AS source_key
        FROM media_jobs pending_preview
        JOIN media_files pending_media ON pending_media.id = pending_preview.media_id
        WHERE pending_preview.job_type = 'content-preview'
          AND pending_preview.status = 'pending'
          AND (pending_preview.retry_after IS NULL OR pending_preview.retry_after <= @now)
      )
      SELECT candidate.id, candidate.media_id, candidate.job_type, candidate.priority,
        candidate.status, candidate.payload_json, candidate.attempts, candidate.max_attempts
      FROM media_jobs candidate
      LEFT JOIN media_files candidate_media ON candidate_media.id = candidate.media_id
      LEFT JOIN active_preview_sources candidate_source
        ON candidate_source.source_key = CASE
          WHEN candidate_media.source_root LIKE '/Volumes/%/%'
            THEN substr(candidate_media.source_root, 1, 8 + instr(substr(candidate_media.source_root, 10), '/'))
          ELSE candidate_media.source_root
        END
      WHERE candidate.status = 'pending'
        AND candidate.job_type IN (SELECT value FROM json_each(@jobTypes))
        AND (candidate.retry_after IS NULL OR candidate.retry_after <= @now)
        AND (@probeToolAvailable = 1 OR candidate.job_type != 'probe')
        AND (@ffmpegToolAvailable = 1 OR candidate.job_type NOT IN ('thumbnail', 'poster-card', 'poster-detail', 'remux', 'hls', 'storyboard', 'content-preview', 'highlight'))
        AND (@foregroundOnly = 0 OR candidate.priority >= @foregroundPriority)
        AND (@foregroundOnly = 0 OR candidate.job_type != 'content-preview')
        AND (@translationRuntimeAvailable = 1 OR candidate.job_type != 'subtitle-translate')
        AND (
          candidate.job_type != 'subtitle-translate'
          OR NOT EXISTS (
            SELECT 1 FROM media_jobs active_translation
            WHERE active_translation.job_type = 'subtitle-translate'
              AND active_translation.status = 'running'
          )
        )
        AND (
          candidate.job_type != 'content-preview'
          OR @contentPreviewSourceConcurrency <= 0
          OR COALESCE(candidate_media.source_root, '') = ''
          OR COALESCE(candidate_source.active_count, 0) < @contentPreviewSourceConcurrency
          OR (SELECT COUNT(*) FROM pending_preview_sources) <= 1
        )
      ORDER BY candidate.priority DESC, candidate.created_at ASC
      LIMIT 1
    `
    )
    .get({
      jobTypes: JSON.stringify(selectMediaWorkerJobTypes([...handlers.keys()], process.env.MEDIA_WORKER_JOB_TYPES, process.env.MEDIA_WORKER_EXCLUDE_JOB_TYPES)),
      probeToolAvailable: probeToolUnavailable ? 0 : 1,
      ffmpegToolAvailable: ffmpegToolUnavailable ? 0 : 1,
      foregroundOnly: foregroundOnly ? 1 : 0,
      foregroundPriority,
      translationRuntimeAvailable: translationRuntimeAvailable ? 1 : 0,
      contentPreviewSourceConcurrency: config.contentPreview.sourceConcurrency,
      now: new Date().toISOString()
    }) as MediaJobRow | undefined;
  if (!job) return null;

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const claimed = db
    .prepare(
      `
      UPDATE media_jobs
      SET status = 'running', attempts = attempts + 1, started_at = @now,
        updated_at = @now, heartbeat_at = @now,
        lease_owner = @leaseOwner, lease_expires_at = @leaseExpiresAt,
        retry_after = NULL, error = NULL
      WHERE id = @id AND status = 'pending'
    `
    )
    .run({
      id: job.id,
      now,
      leaseOwner: workerInstanceId,
      leaseExpiresAt: new Date(nowMs + jobLeaseMs).toISOString()
    });
  return claimed.changes > 0 ? { ...job, attempts: job.attempts + 1 } : null;
});

async function handleProbe(_job: MediaJobRow, media: MediaRow | null): Promise<void> {
  if (!media) throw new Error("Media file no longer exists");
  const probe = await probeMediaFile(media);
  statements.updateMediaProbe.run({
    id: media.id,
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
}

handlers.set("probe", handleProbe);

async function processJob(job: MediaJobRow): Promise<void> {
  const media = job.media_id
    ? (db.prepare("SELECT * FROM media_files WHERE id = ?").get(job.media_id) as MediaRow | undefined) ?? null
    : null;
  const handler = handlers.get(job.job_type);
  if (!handler) throw new Error(`No handler registered for ${job.job_type}`);
  await handler(job, media);
}

function isPermanentJobError(message: string): boolean {
  return /Media file no longer exists|Media source is unavailable|No cached metadata cover is available|outside configured media|unsupported|invalid playback|moov atom not found/i.test(message);
}

function finishJob(job: MediaJobRow, error?: unknown): "ready" | "pending" | "failed" {
  const now = new Date().toISOString();
  const rawMessage = error instanceof Error ? error.message : error ? String(error) : "";
  const message = rawMessage ? rawMessage.trim().slice(-1800) : null;
  const waitCode = error instanceof Error && "code" in error ? String(error.code) : "";
  const waitingMediaSource = waitCode === "MEDIA_SOURCE_WAIT";
  const waitingExternalStorage = waitingMediaSource
    || waitCode === "EXTERNAL_AI_WAIT"
    || waitCode === "CONTENT_PREVIEW_STORAGE_WAIT";
  const retrying = waitingExternalStorage || (Boolean(message) && !isPermanentJobError(message ?? "") && job.attempts < job.max_attempts);
  const status = message ? (retrying ? "pending" : "failed") : "ready";
  const retryDelayMs = waitingMediaSource
    ? config.storageRecovery.mountRetryMs
    : retrying
      ? Math.min(30 * 60 * 1000, 30_000 * 2 ** Math.max(0, job.attempts - 1))
      : 0;
  db.prepare(
    `
      UPDATE media_jobs
      SET status = @status, error = @error,
        attempts = CASE WHEN @waitingExternalStorage = 1 THEN MAX(0, attempts - 1) ELSE attempts END,
        finished_at = CASE WHEN @status = 'pending' THEN NULL ELSE @now END,
        retry_after = CASE WHEN @status = 'pending' THEN @retryAfter ELSE NULL END,
        lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL,
        updated_at = @now
      WHERE id = @id AND lease_owner = @leaseOwner
  `
  ).run({
    id: job.id,
    status,
    error: message,
    now,
    retryAfter: retrying ? new Date(Date.now() + retryDelayMs).toISOString() : null,
    waitingExternalStorage: waitingExternalStorage ? 1 : 0,
    leaseOwner: workerInstanceId
  });

  if (message && job.job_type === "probe" && job.media_id) {
    db.prepare(
      `
      UPDATE media_files
      SET probe_status = ?, probe_error = ?, probed_at = ?
      WHERE id = ?
      `
    ).run(retrying ? "queued" : "failed", message, now, job.media_id);
  }
  if (message && job.job_type === "thumbnail" && job.media_id) {
    db.prepare(
      "UPDATE media_files SET thumbnail_status = ?, thumbnail_path = NULL WHERE id = ?"
    ).run(retrying ? "pending" : "failed", job.media_id);
  }
  if (message && job.job_type === "content-preview" && job.media_id) {
    db.prepare(`
      UPDATE media_storyboards
      SET content_status = @status, content_error = @error, updated_at = @now
      WHERE media_id = @mediaId
    `).run({
      mediaId: job.media_id,
      status: retrying ? "pending" : "failed",
      error: message,
      now
    });
  }
  if (message && ["poster-card", "poster-detail", "remux", "hls"].includes(job.job_type) && job.media_id) {
    const derivativeKind = job.job_type.startsWith("poster") ? "poster" : job.job_type;
    const variant = job.job_type === "poster-card" ? "card" : job.job_type === "poster-detail" ? "detail" : "default";
    db.prepare(
      `
      UPDATE media_derivatives
      SET status = @status, error = @error, updated_at = @now
      WHERE media_id = @mediaId AND kind = @kind AND variant = @variant
      `
    ).run({
      mediaId: job.media_id,
      kind: derivativeKind,
      variant,
      status: retrying ? "pending" : "failed",
      error: message,
      now
    });
  }
  return status;
}

export function wakeMediaSourceWaitingJobs(): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE media_jobs
    SET retry_after = @now, error = NULL, updated_at = @now
    WHERE status = 'pending' AND error = @error
  `).run({ now, error: mediaSourceWaitMessage });
  return result.changes;
}

async function finishJobWithRetry(job: MediaJobRow, error?: unknown): Promise<void> {
  for (;;) {
    try {
      finishJob(job, error);
      return;
    } catch (writeError) {
      if (!isTransientSqliteBusy(writeError)) throw writeError;
      const now = Date.now();
      if (now - lastSqliteBusyLogAt >= 30_000) {
        console.warn("Media worker completion delayed by transient SQLite contention");
        lastSqliteBusyLogAt = now;
      }
      // Retry only persistence: do not rerun the completed media operation or
      // convert a temporary database lock into a processing failure.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function workerLoop(idleDelayMs: number): Promise<void> {
  while (!stopRequested) {
    const nowMs = Date.now();
    const playbackActive = isPlaybackActive();
    const schedule = getMediaWorkerScheduleState(
      nowMs,
      lastDaytimeBackgroundStartedAt,
      config.mediaWorkerSchedule
    );
    const foregroundOnly = playbackActive || !schedule.backgroundAllowed;
    if (!playbackActive && schedule.backgroundAllowed) refillIdleMediaJobQueues(nowMs);
    const translationRuntimeAvailable = !config.externalAi.translationExternalized
      || (await inspectExternalAiRuntime([
        config.subtitleTranslation.contextualTranslationModel,
        config.subtitleTranslation.dedicatedTranslationModel
      ])).ready;
    let job: MediaJobRow | null;
    try {
      // Acquire the SQLite write reservation before selecting a pending job.
      // A deferred transaction can otherwise read a snapshot that another
      // worker invalidates before this worker updates it (SQLITE_BUSY_SNAPSHOT).
      job = claimNextJob.immediate(
        foregroundOnly,
        translationRuntimeAvailable,
        config.mediaWorkerForegroundPriority
      );
    } catch (error) {
      if (!isTransientSqliteBusy(error)) throw error;
      const now = Date.now();
      if (now - lastSqliteBusyLogAt >= 30_000) {
        console.warn("Media worker claim delayed by transient SQLite contention");
        lastSqliteBusyLogAt = now;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(idleDelayMs, 1_000)));
      continue;
    }
    if (!job) {
      if (Date.now() - lastStaleRecoveryAt >= 30_000) {
        recoverStaleMediaJobs();
        lastStaleRecoveryAt = Date.now();
      }
      if (!playbackActive && schedule.backgroundAllowed && Date.now() - lastProbeRefillAt >= 30_000) {
        enqueuePendingProbeJobs(120, -10);
        lastProbeRefillAt = Date.now();
      }
      if (!playbackActive && schedule.backgroundAllowed && Date.now() - lastPosterRecoveryAt >= 30_000) {
        requeueRecoverablePosterJobs(24);
        lastPosterRecoveryAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
      continue;
    }

    if (!schedule.nightWindowActive && job.priority < config.mediaWorkerForegroundPriority) {
      lastDaytimeBackgroundStartedAt = Date.now();
    }

    const heartbeat = setInterval(() => {
      try {
        renewJobLease(job.id);
      } catch (error) {
        if (!isTransientSqliteBusy(error)) throw error;
        // A busy writer is temporary. Keep the running job and retry at
        // the next heartbeat rather than terminating the worker process.
        const now = Date.now();
        if (now - lastSqliteBusyLogAt >= 30_000) {
          console.warn("Media worker heartbeat delayed by transient SQLite contention");
          lastSqliteBusyLogAt = now;
        }
      }
    }, jobHeartbeatMs);
    heartbeat.unref();
    try {
      await processJob(job);
      await finishJobWithRetry(job);
    } catch (error) {
      await finishJobWithRetry(job, error);
      const message = error instanceof Error ? error.message : String(error);
      if (job.job_type === "probe" && /ffprobe.*ENOENT|spawn ffprobe/i.test(message)) {
        probeToolUnavailable = true;
        const now = new Date().toISOString();
        db.prepare(
          `
          UPDATE media_jobs
          SET status = 'failed', error = 'ffprobe unavailable in this runtime', finished_at = @now, updated_at = @now
          WHERE job_type = 'probe' AND status = 'pending'
        `
        ).run({ now });
        db.prepare(
          `
          UPDATE media_files
          SET probe_status = 'pending', probe_error = NULL
          WHERE probe_status IN ('queued', 'failed')
            AND (probe_error IS NULL OR probe_error LIKE '%ffprobe%ENOENT%')
        `
        ).run();
      }
      if (ffmpegJobTypes.has(job.job_type) && /ffmpeg.*ENOENT|spawn ffmpeg/i.test(message)) {
        ffmpegToolUnavailable = true;
        const now = new Date().toISOString();
        db.prepare(
          `
          UPDATE media_jobs
          SET status = 'failed', error = 'ffmpeg unavailable in this runtime', finished_at = @now, updated_at = @now
          WHERE job_type IN ('thumbnail', 'poster-card', 'poster-detail', 'remux', 'hls', 'storyboard', 'content-preview', 'highlight') AND status = 'pending'
        `
        ).run({ now });
        db.prepare(
          `
          UPDATE media_derivatives
          SET status = 'failed', error = 'ffmpeg unavailable in this runtime', updated_at = @now
          WHERE status = 'pending'
        `
        ).run({ now });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

export function startMediaJobWorker(options: { concurrency?: number; idleDelayMs?: number } = {}): void {
  if (workerRunning) return;
  recoverStaleMediaJobs();
  workerRunning = true;
  stopRequested = false;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, 9));
  const idleDelayMs = Math.max(250, options.idleDelayMs ?? 1200);
  const runLoop = async () => {
    while (!stopRequested) {
      try {
        await workerLoop(idleDelayMs);
        return;
      } catch (error) {
        if (!isTransientSqliteBusy(error)) throw error;
        console.warn("Media worker maintenance delayed by transient SQLite contention");
        await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
      }
    }
  };
  workerCompletion = Promise.all(Array.from({ length: concurrency }, runLoop)).then(() => undefined).finally(() => {
    workerRunning = false;
    workerCompletion = null;
  });
}

export function stopMediaJobWorker(): void {
  stopRequested = true;
  const now = new Date().toISOString();
  const runningJobs = db.prepare(`
    SELECT id, media_id AS mediaId, job_type AS jobType, attempts, max_attempts AS maxAttempts
    FROM media_jobs
    WHERE status = 'running' AND lease_owner = ?
  `).all(workerInstanceId) as Array<{
    id: string;
    mediaId: string;
    jobType: MediaJobType;
    attempts: number;
    maxAttempts: number;
  }>;
  const requeue = db.prepare(`
    UPDATE media_jobs
    SET status = 'pending', error = '任务因服务停止中断，已等待下次执行',
      retry_after = @now, started_at = NULL,
      lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL, updated_at = @now
    WHERE id = @id AND status = 'running' AND lease_owner = @leaseOwner
  `);
  const fail = db.prepare(`
    UPDATE media_jobs
    SET status = 'failed', error = @error, finished_at = @now,
      lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL, updated_at = @now
    WHERE id = @id AND status = 'running' AND lease_owner = @leaseOwner
  `);
  const resetDerivative = db.prepare(`
    UPDATE media_derivatives
    SET status = 'pending', error = '播放衍生任务因服务停止中断', updated_at = @now
    WHERE media_id = @mediaId AND kind = @kind AND variant = 'default'
  `);
  db.transaction(() => {
    for (const job of runningJobs) {
      if (job.jobType === "hls" || job.jobType === "remux") {
        fail.run({
          id: job.id,
          error: "播放衍生任务因服务停止中断，可在下次播放时重新生成",
          now,
          leaseOwner: workerInstanceId
        });
        resetDerivative.run({ mediaId: job.mediaId, kind: job.jobType, now });
      } else if (job.attempts < job.maxAttempts) {
        requeue.run({ id: job.id, now, leaseOwner: workerInstanceId });
      } else {
        fail.run({
          id: job.id,
          error: "任务因服务停止中断且已达到最大重试次数",
          now,
          leaseOwner: workerInstanceId
        });
      }
    }
  })();
  stopActiveFfmpegProcesses();
}

export async function waitForMediaJobWorkerStop(timeoutMs = 15_000): Promise<void> {
  const completion = workerCompletion;
  if (!completion) return;
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Media worker did not stop before the restore deadline")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getMediaJobStatus() {
  const rows = db
    .prepare("SELECT job_type AS jobType, status, COUNT(*) AS count FROM media_jobs GROUP BY job_type, status")
    .all() as Array<{ jobType: string; status: string; count: number }>;
  return {
    running: workerRunning || hasRecentMediaWorkerHeartbeat(),
    playbackActive: isPlaybackActive(),
    probeToolAvailable: !probeToolUnavailable,
    ffmpegToolAvailable: !ffmpegToolUnavailable,
    schedule: {
      ...getMediaWorkerScheduleState(
        Date.now(),
        lastDaytimeBackgroundStartedAt,
        config.mediaWorkerSchedule
      ),
      ...config.mediaWorkerSchedule,
      foregroundPriority: config.mediaWorkerForegroundPriority,
      processNiceness: config.mediaWorkerProcessNiceness,
      ffmpegThreads: config.mediaWorkerFfmpegThreads
    },
    counts: rows
  };
}

export function isMediaProbeAvailable(): boolean {
  return !probeToolUnavailable;
}

export function isMediaTranscodeAvailable(): boolean {
  return !ffmpegToolUnavailable;
}

export function wasMediaJobRecentlyFailed(
  mediaId: string,
  jobType: MediaJobType,
  cooldownMs = 10 * 60 * 1000
): boolean {
  const row = db
    .prepare(
      `
      SELECT COALESCE(finished_at, updated_at) AS failedAt
      FROM media_jobs
      WHERE media_id = ? AND job_type = ? AND status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 1
    `
    )
    .get(mediaId, jobType) as { failedAt: string } | undefined;
  if (!row) return false;
  const failedAt = Date.parse(row.failedAt);
  return Number.isFinite(failedAt) && Date.now() - failedAt < cooldownMs;
}
