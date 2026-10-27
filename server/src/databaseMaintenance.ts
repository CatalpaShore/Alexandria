import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

type PlaybackProgressRow = {
  relative_path: unknown;
  media_id: unknown;
  position_seconds: unknown;
  duration_seconds: unknown;
  completed: unknown;
  play_count: unknown;
  last_played_at: unknown;
  updated_at: unknown;
};

export type DatabaseMaintenanceReport = {
  checkpoint: { busy: number; log: number; checkpointed: number } | null;
  freelistBytes: number;
  integrityQuarantined: number;
  jobsRemoved: number;
  missingCacheRowsRemoved: number;
  optimizedAt: string;
};

export type DatabaseReclaimReport = {
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  autoVacuum: number;
  finishedAt: string;
};

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function playbackIssue(row: PlaybackProgressRow, validMedia: boolean): string | null {
  if (!validMedia) return "播放记录无法关联到当前媒体文件";
  if (typeof row.position_seconds !== "number" || !Number.isFinite(row.position_seconds) || row.position_seconds < 0) {
    return "播放位置不是有效数值";
  }
  if (row.duration_seconds != null && (
    typeof row.duration_seconds !== "number" || !Number.isFinite(row.duration_seconds) || row.duration_seconds < 0
  )) return "播放时长不是有效数值";
  if (row.completed !== 0 && row.completed !== 1) return "完成状态无效";
  if (typeof row.play_count !== "number" || !Number.isInteger(row.play_count) || row.play_count < 0) {
    return "播放次数无效";
  }
  if (!isIsoDate(row.last_played_at) || !isIsoDate(row.updated_at)) return "播放时间无效";
  return null;
}

export function quarantineInvalidPlaybackProgress(database: Database.Database): number {
  const rows = database.prepare(`
    SELECT playback_progress.*,
      CASE WHEN media_files.id IS NULL THEN 0 ELSE 1 END AS valid_media
    FROM playback_progress
    LEFT JOIN media_files
      ON media_files.id = playback_progress.media_id
      AND media_files.relative_path = playback_progress.relative_path
  `).all() as Array<PlaybackProgressRow & { valid_media: number }>;
  const invalid = rows
    .map((row) => ({ row, reason: playbackIssue(row, Boolean(row.valid_media)) }))
    .filter((item): item is { row: PlaybackProgressRow & { valid_media: number }; reason: string } => Boolean(item.reason));
  if (invalid.length === 0) return 0;

  const insert = database.prepare(`
    INSERT INTO playback_progress_quarantine (
      relative_path, media_id, raw_json, reason, quarantined_at
    ) VALUES (@relativePath, @mediaId, @rawJson, @reason, @now)
  `);
  const remove = database.prepare("DELETE FROM playback_progress WHERE relative_path = ?");
  const now = new Date().toISOString();
  database.transaction(() => {
    for (const item of invalid) {
      const { valid_media: _validMedia, ...raw } = item.row;
      insert.run({
        relativePath: String(item.row.relative_path ?? ""),
        mediaId: String(item.row.media_id ?? ""),
        rawJson: JSON.stringify(raw),
        reason: item.reason,
        now
      });
      remove.run(item.row.relative_path);
    }
  })();
  return invalid.length;
}

export function installPlaybackIntegrityGuards(database: Database.Database): void {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS playback_progress_validate_insert
    BEFORE INSERT ON playback_progress
    WHEN
      NEW.relative_path = '' OR NEW.media_id = '' OR
      typeof(NEW.position_seconds) NOT IN ('integer', 'real') OR NEW.position_seconds < 0 OR
      (NEW.duration_seconds IS NOT NULL AND (
        typeof(NEW.duration_seconds) NOT IN ('integer', 'real') OR NEW.duration_seconds < 0
      )) OR
      NEW.completed NOT IN (0, 1) OR
      typeof(NEW.play_count) != 'integer' OR NEW.play_count < 0 OR
      datetime(NEW.last_played_at) IS NULL OR datetime(NEW.updated_at) IS NULL OR
      NOT EXISTS (
        SELECT 1 FROM media_files
        WHERE id = NEW.media_id AND relative_path = NEW.relative_path
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid playback progress');
    END;

    CREATE TRIGGER IF NOT EXISTS playback_progress_validate_update
    BEFORE UPDATE ON playback_progress
    WHEN
      NEW.relative_path = '' OR NEW.media_id = '' OR
      typeof(NEW.position_seconds) NOT IN ('integer', 'real') OR NEW.position_seconds < 0 OR
      (NEW.duration_seconds IS NOT NULL AND (
        typeof(NEW.duration_seconds) NOT IN ('integer', 'real') OR NEW.duration_seconds < 0
      )) OR
      NEW.completed NOT IN (0, 1) OR
      typeof(NEW.play_count) != 'integer' OR NEW.play_count < 0 OR
      datetime(NEW.last_played_at) IS NULL OR datetime(NEW.updated_at) IS NULL OR
      NOT EXISTS (
        SELECT 1 FROM media_files
        WHERE id = NEW.media_id AND relative_path = NEW.relative_path
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid playback progress');
    END;
  `);
}

export function initializeDataIntegrity(database: Database.Database): { quarantinedPlayback: number } {
  const quarantinedPlayback = quarantineInvalidPlaybackProgress(database);
  installPlaybackIntegrityGuards(database);
  return { quarantinedPlayback };
}

function removeMissingCacheRows(database: Database.Database): number {
  const rows = database.prepare("SELECT cache_key AS cacheKey, path FROM asset_cache_index").all() as Array<{
    cacheKey: string;
    path: string;
  }>;
  const missing = rows.filter((row) => !row.path || !fs.existsSync(row.path));
  if (missing.length === 0) return 0;
  const remove = database.prepare("DELETE FROM asset_cache_index WHERE cache_key = ?");
  database.transaction(() => missing.forEach((row) => remove.run(row.cacheKey)))();
  return missing.length;
}

export function runDatabaseMaintenance(database: Database.Database): DatabaseMaintenanceReport {
  const integrityQuarantined = quarantineInvalidPlaybackProgress(database);
  const missingCacheRowsRemoved = removeMissingCacheRows(database);
  const jobsRemoved = database.prepare(`
    DELETE FROM media_jobs
    WHERE status IN ('ready', 'failed')
      AND datetime(COALESCE(finished_at, updated_at)) < datetime('now', '-45 days')
  `).run().changes;

  database.pragma("optimize");
  const autoVacuum = Number(database.pragma("auto_vacuum", { simple: true }));
  if (autoVacuum === 2) database.pragma("incremental_vacuum(512)");

  const pageSize = Number(database.pragma("page_size", { simple: true }));
  const freelist = Number(database.pragma("freelist_count", { simple: true }));
  const checkpointRows = database.pragma("wal_checkpoint(PASSIVE)") as Array<{
    busy?: number;
    log?: number;
    checkpointed?: number;
  }>;
  const checkpointRow = checkpointRows[0] as
    | { busy?: number; log?: number; checkpointed?: number }
    | undefined;
  const checkpoint = checkpointRow ? {
    busy: Number(checkpointRow.busy ?? 0),
    log: Number(checkpointRow.log ?? 0),
    checkpointed: Number(checkpointRow.checkpointed ?? 0)
  } : null;

  return {
    checkpoint,
    freelistBytes: pageSize * freelist,
    integrityQuarantined,
    jobsRemoved,
    missingCacheRowsRemoved,
    optimizedAt: new Date().toISOString()
  };
}

export function cleanupUnknownDatabaseSidecars(databasePath: string): number {
  const parent = path.dirname(databasePath);
  const basename = path.basename(databasePath);
  let removed = 0;
  for (const name of fs.readdirSync(parent)) {
    if (!name.startsWith(`${basename}.maintenance-`) || !name.endsWith(".tmp")) continue;
    try {
      fs.rmSync(path.join(parent, name), { force: true });
      removed += 1;
    } catch {
      // A later maintenance pass can retry files still held by the OS.
    }
  }
  return removed;
}

export function reclaimDatabaseSpace(
  database: Database.Database,
  databasePath: string
): DatabaseReclaimReport {
  const beforeBytes = fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0;
  database.pragma("wal_checkpoint(TRUNCATE)");
  database.pragma("auto_vacuum = INCREMENTAL");
  database.exec("VACUUM");
  database.pragma("optimize");
  const afterBytes = fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0;
  return {
    beforeBytes,
    afterBytes,
    reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
    autoVacuum: Number(database.pragma("auto_vacuum", { simple: true })),
    finishedAt: new Date().toISOString()
  };
}
