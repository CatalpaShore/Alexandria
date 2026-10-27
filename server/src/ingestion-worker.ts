import { db } from "./db.js";
import { getLibraryRoots } from "./config.js";
import { moveIngestionFiles, type IngestionMoveStats, type IngestionSource } from "./ingestionFiles.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

type QueuedRun = {
  id: string;
  limitCount: number | null;
};

function claimRun(): QueuedRun | null {
  const claim = db.transaction(() => {
    const row = db.prepare(`
      SELECT id, limit_count AS limitCount
      FROM ingestion_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as QueuedRun | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    const changed = db.prepare(`
      UPDATE ingestion_runs
      SET status = 'running', phase = 'scanning_downloads', error = NULL,
        started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now, now, row.id).changes;
    return changed === 1 ? row : null;
  });
  return claim();
}

function getSources(): IngestionSource[] {
  const roots = getLibraryRoots().roots;
  return (db.prepare(`
    SELECT id, label, download_root AS downloadRoot, library_root_index AS libraryRootIndex
    FROM ingestion_sources
    WHERE enabled = 1
    ORDER BY library_root_index, id
  `).all() as Array<{ id: string; label: string; downloadRoot: string; libraryRootIndex: number }>)
    .filter((source) => source.libraryRootIndex >= 0 && source.libraryRootIndex < roots.length)
    .map((source) => ({
      id: source.id,
      label: source.label,
      downloadRoot: source.downloadRoot,
      libraryRoot: roots[source.libraryRootIndex]
    }));
}

async function processRun(run: QueuedRun): Promise<void> {
  const settings = db.prepare(`
    SELECT stable_minutes AS stableMinutes FROM ingestion_settings WHERE id = 1
  `).get() as { stableMinutes: number };
  try {
    const resumed = db.prepare(`
      SELECT COUNT(*) AS moved
      FROM ingestion_items
      WHERE run_id = ? AND status = 'moved'
    `).get(run.id) as { moved: number };
    db.prepare("UPDATE ingestion_runs SET phase = 'moving', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), run.id);
    const remainingLimit = run.limitCount === null
      ? null
      : Math.max(0, run.limitCount - resumed.moved);
    const emptyStats: IngestionMoveStats = {
      scanned: 0, eligible: 0, moved: 0, unstable: 0, unmatched: 0,
      rejected: 0, rejectionReasons: {}, conflicts: 0, failed: 0
    };
    let latestProgress: Readonly<IngestionMoveStats> = emptyStats;
    const persistProgress = () => {
      db.prepare(`
        UPDATE ingestion_runs
        SET stats_json = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify(latestProgress), new Date().toISOString(), run.id);
    };
    const heartbeat = setInterval(persistProgress, 5_000);
    let stats: IngestionMoveStats;
    try {
      stats = remainingLimit === 0
        ? emptyStats
        : await moveIngestionFiles({
          runId: run.id,
          sources: getSources(),
          stableMinutes: settings.stableMinutes,
          limit: remainingLimit,
          onProgress: (progress) => {
            latestProgress = progress;
            persistProgress();
          }
        });
    } finally {
      clearInterval(heartbeat);
    }
    stats.eligible += resumed.moved;
    stats.moved += resumed.moved;
    const now = new Date().toISOString();
    if (stats.moved > 0) {
      db.prepare(`
        UPDATE ingestion_runs
        SET status = 'awaiting_scan', phase = 'indexing', stats_json = ?, error = NULL, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(stats), now, run.id);
      return;
    }
    const hasIssues = stats.failed > 0 || stats.conflicts > 0;
    db.prepare(`
      UPDATE ingestion_runs
      SET status = ?, phase = 'completed', stats_json = ?, error = NULL, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(hasIssues ? "partial" : "completed", JSON.stringify(stats), now, now, run.id);
  } catch (error) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE ingestion_runs
      SET status = 'failed', phase = 'moving', error = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(error instanceof Error ? error.message : "自动入库失败", now, now, run.id);
  }
}

let workerStarted = false;
let stopping = false;

function isTransientSqliteBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && String(error.code).startsWith("SQLITE_BUSY"));
}

async function runWorkerLoop(): Promise<void> {
  while (!stopping) {
    let run: QueuedRun | null;
    try {
      run = claimRun();
    } catch (error) {
      if (!isTransientSqliteBusy(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!run) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    await processRun(run);
  }
}

export function startIngestionWorker(): boolean {
  if (workerStarted) return true;

  workerStarted = true;
  stopping = false;
  db.transaction(() => {
    db.prepare(`
      DELETE FROM ingestion_items
      WHERE status != 'moved' AND run_id IN (
        SELECT id FROM ingestion_runs WHERE status = 'running'
      )
    `).run();
    db.prepare(`
      UPDATE ingestion_runs
      SET status = 'queued', phase = 'queued', error = 'Recovered after ingestion worker restart', updated_at = ?
      WHERE status = 'running'
    `).run(new Date().toISOString());
  })();
  console.log("Ingestion worker started with local backend");
  void runWorkerLoop().catch((error) => {
    workerStarted = false;
    console.error("Ingestion worker stopped unexpectedly:", error);
  });
  return true;
}

export function stopIngestionWorker(): void {
  stopping = true;
  workerStarted = false;
}

export function isIngestionWorkerRunning(): boolean {
  return workerStarted && !stopping;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isStandaloneWorker = entryPath === fileURLToPath(import.meta.url);
if (isStandaloneWorker) {
  startIngestionWorker();
  for (const signal of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
    process.once(signal, () => {
      console.log(`Ingestion worker received ${signal}, stopping`);
      stopIngestionWorker();
    });
  }
}
