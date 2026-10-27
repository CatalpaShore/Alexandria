import fs from "node:fs";

const command = process.argv[2] ?? "status";
const dryRun = process.argv.includes("--dry-run");
const priorityArg = process.argv.find((value) => value.startsWith("--priority="));
const limitArg = process.argv.find((value) => value.startsWith("--limit="));
const priority = Number.parseInt(priorityArg?.split("=")[1] ?? "-30", 10);
const limit = limitArg ? Math.max(1, Number.parseInt(limitArg.split("=")[1], 10)) : null;

if (!new Set(["start", "status"]).has(command)) {
  throw new Error("Usage: pnpm backfill:content-preview [start|status] [--dry-run] [--limit=N] [--priority=N]");
}

const [{ db }, { config }, previews] = await Promise.all([
  import("../server/src/db.ts"),
  import("../server/src/config.ts"),
  import("../server/src/contentPreviews.ts")
]);

function readStatus() {
  const recentWindowMinutes = 30;
  const recentCutoff = new Date(Date.now() - recentWindowMinutes * 60 * 1000).toISOString();
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN story.content_status = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN story.content_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN story.content_status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN story.content_status IS NULL OR story.content_status = 'missing' THEN 1 ELSE 0 END) AS missing,
      COALESCE(SUM(CASE WHEN story.content_status = 'ready' THEN story.content_bytes ELSE 0 END), 0) AS totalBytes,
      MIN(CASE WHEN story.content_status = 'ready' THEN story.content_generated_at END) AS firstGeneratedAt,
      MAX(CASE WHEN story.content_status = 'ready' THEN story.content_generated_at END) AS lastGeneratedAt
    FROM media_files media
    LEFT JOIN media_storyboards story ON story.media_id = media.id
    WHERE media.media_type = 'video'
  `).get();
  const jobs = db.prepare(`
    WITH latest AS (
      SELECT status,
        ROW_NUMBER() OVER (PARTITION BY media_id ORDER BY updated_at DESC, created_at DESC, id DESC) AS rank
      FROM media_jobs
      WHERE job_type = 'content-preview'
    )
    SELECT status, COUNT(*) AS count
    FROM latest
    WHERE rank = 1
    GROUP BY status
  `).all();
  const jobProgress = db.prepare(`
    WITH latest AS (
      SELECT status, created_at, finished_at,
        ROW_NUMBER() OVER (PARTITION BY media_id ORDER BY updated_at DESC, created_at DESC, id DESC) AS rank
      FROM media_jobs
      WHERE job_type = 'content-preview'
    )
    SELECT MIN(created_at) AS startedAt,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'ready' AND finished_at >= @recentCutoff THEN 1 ELSE 0 END) AS recentCompleted
    FROM latest
    WHERE rank = 1
  `).get({ recentCutoff });
  const bySource = db.prepare(`
    SELECT
      media.source_name AS source,
      COUNT(*) AS total,
      SUM(CASE WHEN story.content_status = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN story.content_status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM media_files media
    LEFT JOIN media_storyboards story ON story.media_id = media.id
    WHERE media.media_type = 'video'
    GROUP BY media.source_name
    ORDER BY media.source_name
  `).all();
  const started = Date.parse(jobProgress.startedAt ?? "");
  const elapsedSeconds = Number.isFinite(started) && Date.now() > started
    ? (Date.now() - started) / 1000
    : 0;
  const historicalRatePerHour = elapsedSeconds > 0 && jobProgress.completed > 0
    ? (jobProgress.completed / elapsedSeconds) * 3600
    : null;
  const recentRatePerHour = jobProgress.recentCompleted > 0
    ? (jobProgress.recentCompleted / recentWindowMinutes) * 60
    : null;
  const remaining = Math.max(0, summary.total - summary.ready);
  return {
    ...summary,
    completionPercent: summary.total > 0 ? Math.round((summary.ready / summary.total) * 10_000) / 100 : 0,
    backfillStartedAt: jobProgress.startedAt,
    completedSinceStart: jobProgress.completed,
    recentWindowMinutes,
    recentCompleted: jobProgress.recentCompleted,
    ratePerHour: recentRatePerHour ? Math.round(recentRatePerHour * 10) / 10 : null,
    historicalRatePerHour: historicalRatePerHour ? Math.round(historicalRatePerHour * 10) / 10 : null,
    estimatedHoursRemaining: recentRatePerHour ? Math.round((remaining / recentRatePerHour) * 10) / 10 : null,
    jobs: Object.fromEntries(jobs.map((row) => [row.status, row.count])),
    bySource
  };
}

function printStatus(label, extra = {}) {
  console.log(label);
  console.log(JSON.stringify({ ...readStatus(), ...extra }, null, 2));
}

try {
  const storage = previews.inspectContentPreviewStorage();
  if (command === "status") {
    printStatus("CONTENT_PREVIEW_BACKFILL_STATUS", {
      storage: { ready: storage.ready, state: storage.state, message: storage.message }
    });
  } else {
    if (!storage.ready) throw new Error(storage.message);
    for (const source of config.mediaSources) {
      fs.accessSync(source.root, fs.constants.R_OK);
    }

    const current = readStatus();
    const averageBytes = current.ready > 0 ? current.totalBytes / current.ready : 5 * 1024 * 1024;
    const remaining = Math.max(0, current.total - current.ready);
    const estimatedBytes = Math.ceil(averageBytes * remaining * 1.2);
    const disk = fs.statfsSync(config.contentPreview.root);
    const freeBytes = disk.bavail * disk.bsize;
    const reserveBytes = 20 * 1024 ** 3;
    if (estimatedBytes + reserveBytes > freeBytes) {
      throw new Error(
        `辅助存储 free space is insufficient: need about ${(estimatedBytes / 1024 ** 3).toFixed(1)} GiB plus 20 GiB reserve, `
        + `available ${(freeBytes / 1024 ** 3).toFixed(1)} GiB`
      );
    }

    const rows = db.prepare(`
      SELECT media.*
      FROM media_files media
      LEFT JOIN media_storyboards story ON story.media_id = media.id
      WHERE media.media_type = 'video'
        AND COALESCE(story.content_status, 'missing') != 'ready'
        AND NOT EXISTS (
          SELECT 1
          FROM media_jobs job
          WHERE job.media_id = media.id
            AND job.job_type = 'content-preview'
            AND job.status IN ('pending', 'running')
        )
      ORDER BY media.source_name, media.relative_path, media.id
    `).all();
    const selected = limit ? rows.slice(0, limit) : rows;
    if (dryRun) {
      printStatus("CONTENT_PREVIEW_BACKFILL_DRY_RUN", {
        eligible: rows.length,
        selected: selected.length,
        estimatedBytes,
        freeBytes,
        priority
      });
    } else {
      let queued = 0;
      let failedToQueue = 0;
      const queueErrors = [];
      for (const media of selected) {
        try {
          previews.requestContentPreview(media, priority);
          queued += 1;
        } catch (error) {
          failedToQueue += 1;
          if (queueErrors.length < 20) {
            queueErrors.push({
              id: media.id,
              code: media.normalized_code || media.basename,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        if ((queued + failedToQueue) % 500 === 0) {
          console.log(`Queued ${queued}/${selected.length}; queue errors=${failedToQueue}`);
        }
      }
      printStatus("CONTENT_PREVIEW_BACKFILL_STARTED", {
        eligible: rows.length,
        selected: selected.length,
        queued,
        failedToQueue,
        queueErrors,
        estimatedBytes,
        freeBytes,
        priority
      });
      if (failedToQueue > 0) process.exitCode = 1;
    }
  }
} finally {
  if (db.open) db.close();
}
