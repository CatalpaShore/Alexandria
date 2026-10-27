import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Express } from "express";
import { z } from "zod";
import { config, getLibraryRoots } from "./config.js";
import { db, rebuildMediaSearchIndex, rebuildMetadataFacetIndex } from "./db.js";
import { readFavoriteKeys } from "./favorites.js";
import { isIngestionWorkerRunning } from "./ingestion-worker.js";
import {
  getCompletionForCodes,
  getIngestionRunAudit,
  rollbackIngestionItem,
  rollbackIngestionRun,
  type IngestionCompletion
} from "./ingestionAudit.js";
import { exportMetadataWorkbook } from "./metadataExport.js";
import { enqueueMetadataEnrichmentAfterCurrentRun } from "./metadata.js";
import {
  drainPendingEntityEnrichments,
  recoverPendingEntityEnrichments,
  scheduleFirstTimeEntityProfilesForCodes,
  scheduleIngestionContentPreviews
} from "./ingestionPostProcessing.js";
import {
  MEDIA_LIST_JOINS,
  MEDIA_LIST_SELECT,
  hydrateMediaRows,
  type MediaListRow
} from "./queries/mediaListQueries.js";
import { getRuntimeCapabilities, type RuntimeCapabilities } from "./runtimeCapabilities.js";
import type { ScanOptions, ScanSummary } from "./scanner.js";

type IngestionSettingsRow = {
  enabled: number;
  scheduleTime: string;
  timezone: string;
  stableMinutes: number;
  updatedAt: string;
};

type PipelineDependencies = {
  startScan: (options?: ScanOptions) => Promise<ScanSummary>;
  onDataChanged?: () => void;
  onWarmCache?: () => void;
};

type NotificationRow = {
  id: string;
  readAt: string | null;
  createdAt: string;
  ingestionDay: string;
  mediaId: string | null;
  normalizedCode: string;
  category: string;
  sourceId: string;
  metadataStatus: string;
  translationStatus: string;
  itemStatus: string | null;
  itemReason: string | null;
  runId: string | null;
  triggerType: string | null;
  runStatus: string;
  title: string;
  actorsJson: string;
  runStatsJson: string | null;
};

type NotificationRunStats = {
  eligible: number;
  moved: number;
  unstable: number;
  conflicts: number;
  failed: number;
};

function parseNotificationRunStats(value: string | null): NotificationRunStats | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<NotificationRunStats>;
    const read = (key: keyof NotificationRunStats) =>
      typeof parsed[key] === "number" ? parsed[key] : 0;
    return {
      eligible: read("eligible"),
      moved: read("moved"),
      unstable: read("unstable"),
      conflicts: read("conflicts"),
      failed: read("failed")
    };
  } catch {
    return null;
  }
}

function applyItemStatusToCompletion(
  completion: IngestionCompletion | undefined,
  itemStatus: string | null,
  itemReason: string | null
): IngestionCompletion | undefined {
  if (!completion || !["failed", "conflict"].includes(itemStatus ?? "")) return completion;
  const detail = itemReason || (itemStatus === "conflict" ? "目标位置存在同名文件" : "文件移动失败");
  return {
    ...completion,
    overallStatus: "attention",
    reason: detail,
    stages: {
      ...completion.stages,
      file: { status: "attention", label: "文件", detail }
    }
  };
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sources: z.array(z.object({
    id: z.enum(["primary", "secondary"]),
    downloadRoot: z.string().trim().min(1).refine(path.isAbsolute, "下载目录必须是绝对路径"),
    enabled: z.boolean()
  })).length(2)
});

const runSchema = z.object({
  limit: z.number().int().min(1).max(1_000).optional()
});

const itemRollbackSchema = z.object({ confirm: z.literal(true) });
const runRollbackSchema = z.object({ confirm: z.string().min(1) });

let activePipelineDependencies: PipelineDependencies | null = null;

function getSettings(capabilities: RuntimeCapabilities = getRuntimeCapabilities()) {
  const settings = db.prepare(`
    SELECT enabled, schedule_time AS scheduleTime, timezone,
      stable_minutes AS stableMinutes, updated_at AS updatedAt
    FROM ingestion_settings WHERE id = 1
  `).get() as IngestionSettingsRow;
  const libraryRoots = getLibraryRoots().roots;
  const sources = db.prepare(`
    SELECT id, label, download_root AS downloadRoot,
      library_root_index AS libraryRootIndex, enabled, updated_at AS updatedAt
    FROM ingestion_sources ORDER BY library_root_index, id
  `).all() as Array<{
    id: string; label: string; downloadRoot: string; libraryRootIndex: number;
    enabled: number; updatedAt: string;
  }>;
  return {
    ...settings,
    enabled: capabilities.canManageIngestion && Boolean(settings.enabled),
    persistedEnabled: Boolean(settings.enabled),
    workerRunning: isIngestionWorkerRunning(),
    ...capabilities,
    sources: sources.map((source) => ({
      ...source,
      enabled: Boolean(source.enabled),
      libraryRoot: libraryRoots[source.libraryRootIndex] ?? ""
    }))
  };
}

export function createIngestionRun(triggerType: "manual" | "scheduled", limit?: number, scheduleKey?: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ingestion_runs (
      id, trigger_type, schedule_key, status, phase, limit_count, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?)
  `).run(id, triggerType, scheduleKey ?? null, limit ?? null, now, now);
  return id;
}

function localScheduleParts(timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    time: `${read("hour")}:${read("minute")}`
  };
}

function scheduleIfDue(): void {
  const settings = getSettings();
  if (!settings.enabled) return;
  const local = localScheduleParts(settings.timezone);
  if (local.time < settings.scheduleTime) return;
  db.prepare(`
    UPDATE ingestion_runs
    SET status = 'awaiting_scan', phase = 'indexing', error = NULL,
      finished_at = NULL, updated_at = @now
    WHERE status = 'partial'
      AND EXISTS (
        SELECT 1 FROM ingestion_items
        WHERE ingestion_items.run_id = ingestion_runs.id
          AND ingestion_items.status = 'moved'
          AND (
            ingestion_items.metadata_status != 'ready'
            OR ingestion_items.translation_status NOT IN ('ready', 'skipped')
          )
          AND datetime(ingestion_items.next_retry_at) <= datetime(@now)
          AND ingestion_items.attempts < CASE
            WHEN ingestion_items.metadata_status = 'not_found' THEN 3 ELSE 7 END
      )
  `).run({ now: new Date().toISOString() });
  const scheduleKey = `${local.date}@${settings.scheduleTime}`;
  try {
    createIngestionRun("scheduled", undefined, scheduleKey);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed")) throw error;
  }
}

async function runTranslation(codes: string[]): Promise<void> {
  if (codes.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/translate-metadata.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        METADATA_DB_PATH: process.env.METADATA_DB_PATH ?? config.databasePath,
        TRANSLATE_PROVIDER: process.env.TRANSLATE_PROVIDER ?? "google",
        TRANSLATE_CODES: codes.join(","),
        TRANSLATE_BATCH_LIMIT: String(Math.max(codes.length, 1))
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stdout.on("data", (chunk) => process.stdout.write(`[ingestion-translation] ${chunk}`));
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      process.stderr.write(`[ingestion-translation] ${chunk}`);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Translation process exited with code ${code}`));
    });
  });
}

function setRunPhase(runId: string, phase: string): void {
  db.prepare("UPDATE ingestion_runs SET phase = ?, updated_at = ? WHERE id = ?")
    .run(phase, new Date().toISOString(), runId);
}

function mergeRunStats(runId: string, patch: Record<string, unknown>): void {
  const row = db.prepare("SELECT stats_json AS statsJson FROM ingestion_runs WHERE id = ?")
    .get(runId) as { statsJson: string } | undefined;
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row?.statsJson || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    current = {};
  }
  db.prepare("UPDATE ingestion_runs SET stats_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify({ ...current, ...patch }), new Date().toISOString(), runId);
}

function triggerPostRollbackRefresh(): boolean {
  const dependencies = activePipelineDependencies;
  dependencies?.onDataChanged?.();
  if (!dependencies) return false;
  void dependencies.startScan()
    .then(() => {
      dependencies.onDataChanged?.();
      dependencies.onWarmCache?.();
    })
    .catch((error) => {
      console.error("Media scan after ingestion rollback failed:", error);
    });
  return true;
}

async function processAwaitingRun(runId: string, dependencies: PipelineDependencies): Promise<void> {
  try {
    setRunPhase(runId, "indexing");
    await dependencies.startScan();
    const items = db.prepare(`
      SELECT id, target_path AS targetPath, normalized_code AS normalizedCode
      FROM ingestion_items WHERE run_id = ? AND status = 'moved'
    `).all(runId) as Array<{ id: string; targetPath: string; normalizedCode: string }>;
    const findMedia = db.prepare("SELECT id, normalized_code AS normalizedCode FROM media_files WHERE absolute_path = ?");
    const updateMedia = db.prepare("UPDATE ingestion_items SET media_id = ?, normalized_code = ?, updated_at = ? WHERE id = ?");
    const codes = new Set<string>();
    const mediaIds = new Set<string>();
    const missingItems: typeof items = [];
    for (const item of items) {
      const media = findMedia.get(item.targetPath) as { id: string; normalizedCode: string } | undefined;
      if (!media) {
        missingItems.push(item);
        continue;
      }
      updateMedia.run(media.id, media.normalizedCode || item.normalizedCode, new Date().toISOString(), item.id);
      mediaIds.add(media.id);
      if (media.normalizedCode) codes.add(media.normalizedCode);
    }
    if (missingItems.length > 0) {
      setRunPhase(runId, "indexing_full_recovery");
      await dependencies.startScan({ forceFull: true });
      for (const item of missingItems) {
        const media = findMedia.get(item.targetPath) as { id: string; normalizedCode: string } | undefined;
        if (!media) continue;
        updateMedia.run(media.id, media.normalizedCode || item.normalizedCode, new Date().toISOString(), item.id);
        mediaIds.add(media.id);
        if (media.normalizedCode) codes.add(media.normalizedCode);
      }
    }

    setRunPhase(runId, "fetching_metadata");
    const codeList = [...codes];
    for (let index = 0; index < codeList.length; index += 500) {
      await enqueueMetadataEnrichmentAfterCurrentRun({
        codes: codeList.slice(index, index + 500), reason: "scan-complete", limit: 500,
        preserveReady: true
      });
    }
    db.prepare(`
      UPDATE ingestion_items
      SET metadata_status = COALESCE((
        SELECT status FROM media_metadata WHERE normalized_code = ingestion_items.normalized_code
      ), 'pending'), updated_at = ?
      WHERE run_id = ? AND status = 'moved'
    `).run(new Date().toISOString(), runId);

    setRunPhase(runId, "translating");
    const readyCodes = (db.prepare(`
      SELECT DISTINCT ingestion_items.normalized_code AS code
      FROM ingestion_items
      JOIN media_metadata ON media_metadata.normalized_code = ingestion_items.normalized_code
      WHERE ingestion_items.run_id = ? AND ingestion_items.status = 'moved'
        AND media_metadata.status = 'ready'
    `).all(runId) as Array<{ code: string }>).map((row) => row.code);
    let pipelineError = "";
    try {
      await runTranslation(readyCodes);
    } catch (error) {
      pipelineError = error instanceof Error ? error.message : "翻译失败";
    }
    db.prepare(`
      UPDATE ingestion_items
      SET translation_status = COALESCE((
        SELECT translation_status FROM media_metadata WHERE normalized_code = ingestion_items.normalized_code
      ), 'pending'), updated_at = ?
      WHERE run_id = ? AND status = 'moved'
    `).run(new Date().toISOString(), runId);

    setRunPhase(runId, "scheduling_content_previews");
    const contentPreviews = scheduleIngestionContentPreviews([...mediaIds]);
    mergeRunStats(runId, { contentPreviews });

    setRunPhase(runId, "scheduling_entity_profiles");
    const entityProfiles = scheduleFirstTimeEntityProfilesForCodes(readyCodes);
    mergeRunStats(runId, {
      entityProfiles,
      actorProfiles: entityProfiles.actor,
      directorProfiles: entityProfiles.director,
      makerProfiles: entityProfiles.maker,
      labelProfiles: entityProfiles.label
    });
    void drainPendingEntityEnrichments();

    setRunPhase(runId, "exporting");
    await exportMetadataWorkbook();
    rebuildMetadataFacetIndex();
    rebuildMediaSearchIndex();
    dependencies.onDataChanged?.();
    setRunPhase(runId, "warming_cache");
    dependencies.onWarmCache?.();

    const incomplete = db.prepare(`
      SELECT COUNT(*) AS count FROM ingestion_items
      WHERE run_id = ? AND status = 'moved'
        AND (metadata_status != 'ready' OR translation_status NOT IN ('ready', 'skipped'))
    `).get(runId) as { count: number };
    const now = new Date().toISOString();
    const status = incomplete.count > 0 || pipelineError ? "partial" : "completed";
    if (status === "partial") {
      db.prepare(`
        UPDATE ingestion_items
        SET attempts = attempts + 1,
          next_retry_at = datetime('now', '+1 day'),
          updated_at = ?
        WHERE run_id = ? AND status = 'moved'
          AND (metadata_status != 'ready' OR translation_status NOT IN ('ready', 'skipped'))
      `).run(now, runId);
    }
    db.prepare(`
      UPDATE ingestion_runs
      SET status = ?, phase = 'completed', error = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, pipelineError || null, now, now, runId);
  } catch (error) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE ingestion_runs
      SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(error instanceof Error ? error.message : "入库后处理失败", now, now, runId);
  }
}

let coordinatorBusy = false;
async function coordinate(dependencies: PipelineDependencies): Promise<void> {
  if (coordinatorBusy) return;
  const run = db.prepare(`
    SELECT id FROM ingestion_runs WHERE status = 'awaiting_scan' ORDER BY created_at LIMIT 1
  `).get() as { id: string } | undefined;
  if (!run) return;
  coordinatorBusy = true;
  db.prepare("UPDATE ingestion_runs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'awaiting_scan'")
    .run(new Date().toISOString(), run.id);
  try {
    await processAwaitingRun(run.id, dependencies);
  } finally {
    coordinatorBusy = false;
  }
}

export function startIngestionAutomation(dependencies: PipelineDependencies): void {
  activePipelineDependencies = dependencies;
  db.prepare(`
    UPDATE ingestion_runs SET status = 'awaiting_scan', updated_at = ?
    WHERE status = 'processing'
  `).run(new Date().toISOString());
  const recoveredEntityProfiles = recoverPendingEntityEnrichments();
  if (recoveredEntityProfiles > 0) {
    console.log(`Recovered ${recoveredEntityProfiles} pending entity profile enrichments`);
  }
  scheduleIfDue();
  void coordinate(dependencies);
  void drainPendingEntityEnrichments();
  setInterval(scheduleIfDue, 60_000).unref();
  setInterval(() => void coordinate(dependencies), 3_000).unref();
  setInterval(() => void drainPendingEntityEnrichments(), 15_000).unref();
}

export function registerIngestionRoutes(app: Express): void {
  app.get("/api/ingestion/settings", (req, res) => {
    res.json(getSettings(getRuntimeCapabilities(req.get("user-agent") ?? "")));
  });
  app.put("/api/ingestion/settings", (req, res, next) => {
    try {
      const capabilities = getRuntimeCapabilities(req.get("user-agent") ?? "");
      if (!capabilities.canManageIngestion) {
        res.status(403).json({ code: "LOCAL_PC_ONLY", error: capabilities.disabledReason, capabilities });
        return;
      }
      const body = settingsSchema.parse(req.body);
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(`
          UPDATE ingestion_settings SET enabled = ?, schedule_time = ?, updated_at = ? WHERE id = 1
        `).run(Number(body.enabled), body.scheduleTime, now);
        const update = db.prepare(`
          UPDATE ingestion_sources SET download_root = ?, enabled = ?, updated_at = ? WHERE id = ?
        `);
        for (const source of body.sources) {
          update.run(source.downloadRoot, Number(source.enabled), now, source.id);
        }
      })();
      res.json(getSettings(capabilities));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/ingestion/runs", (req, res, next) => {
    try {
      const capabilities = getRuntimeCapabilities(req.get("user-agent") ?? "");
      if (!capabilities.canManageIngestion) {
        res.status(403).json({ code: "LOCAL_PC_ONLY", error: capabilities.disabledReason, capabilities });
        return;
      }
      const body = runSchema.parse(req.body ?? {});
      const active = db.prepare(`
        SELECT id FROM ingestion_runs WHERE status IN ('queued', 'running', 'awaiting_scan', 'processing') LIMIT 1
      `).get() as { id: string } | undefined;
      if (active) {
        res.status(409).json({ error: "已有自动入库任务正在执行", runId: active.id });
        return;
      }
      const id = createIngestionRun("manual", body.limit);
      res.status(202).json({ id, status: "queued", limit: body.limit ?? null });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/ingestion/runs", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "30"), 10) || 30));
    res.json({ items: db.prepare(`
      SELECT id, trigger_type AS triggerType, status, phase, limit_count AS limitCount,
        stats_json AS statsJson, error, created_at AS createdAt, started_at AS startedAt,
        finished_at AS finishedAt, updated_at AS updatedAt
      FROM ingestion_runs ORDER BY created_at DESC LIMIT ?
    `).all(limit) });
  });
  app.get("/api/ingestion/runs/:id/items", (req, res) => {
    res.json(getIngestionRunAudit(req.params.id));
  });
  app.post("/api/ingestion/items/:id/rollback", async (req, res, next) => {
    try {
      const capabilities = getRuntimeCapabilities(req.get("user-agent") ?? "");
      if (!capabilities.canManageIngestion) {
        res.status(403).json({ code: "LOCAL_PC_ONLY", error: capabilities.disabledReason, capabilities });
        return;
      }
      itemRollbackSchema.parse(req.body ?? {});
      const result = await rollbackIngestionItem(req.params.id);
      if (result.status === "refused") {
        res.status(409).json({ ...result, scanTriggered: false });
        return;
      }
      if (result.status === "failed") {
        res.status(500).json({ ...result, scanTriggered: false });
        return;
      }
      const scanTriggered = result.status === "succeeded" ? triggerPostRollbackRefresh() : false;
      res.json({ ...result, scanTriggered });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/ingestion/runs/:id/rollback", async (req, res, next) => {
    try {
      const capabilities = getRuntimeCapabilities(req.get("user-agent") ?? "");
      if (!capabilities.canManageIngestion) {
        res.status(403).json({ code: "LOCAL_PC_ONLY", error: capabilities.disabledReason, capabilities });
        return;
      }
      const body = runRollbackSchema.parse(req.body ?? {});
      if (body.confirm !== req.params.id) {
        res.status(400).json({ error: "批次确认标识不匹配" });
        return;
      }
      const result = await rollbackIngestionRun(req.params.id);
      if (result.results.length === 0) {
        res.status(409).json({ ...result, error: "该批次没有可回滚的已移动文件", scanTriggered: false });
        return;
      }
      const scanTriggered = (result.summary.succeeded ?? 0) > 0 ? triggerPostRollbackRefresh() : false;
      res.json({ ...result, scanTriggered });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/ingestion/runs/:id/retry", (req, res) => {
    const capabilities = getRuntimeCapabilities(req.get("user-agent") ?? "");
    if (!capabilities.canManageIngestion) {
      res.status(403).json({ code: "LOCAL_PC_ONLY", error: capabilities.disabledReason, capabilities });
      return;
    }
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE ingestion_runs
      SET status = 'awaiting_scan', phase = 'indexing', error = NULL,
        finished_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('partial', 'failed')
        AND EXISTS (
          SELECT 1 FROM ingestion_items
          WHERE ingestion_items.run_id = ingestion_runs.id AND status = 'moved'
        )
    `).run(now, req.params.id);
    if (result.changes === 0) {
      res.status(409).json({ error: "该任务当前不能重试" });
      return;
    }
    res.status(202).json({ id: req.params.id, status: "awaiting_scan" });
  });
  app.get("/api/notifications/unread-count", (_req, res) => {
    const history = db.prepare(`
      SELECT history_started_at AS startedAt
      FROM ingestion_settings WHERE id = 1
    `).get() as { startedAt: string };
    const row = db.prepare(`
      SELECT
        SUM(unread) AS count,
        MAX(createdAt) AS latestCreatedAt
      FROM (
        SELECT CASE WHEN read_at IS NULL THEN 1 ELSE 0 END AS unread,
          ingested_at AS createdAt
        FROM ingestion_history history
        WHERE date(ingested_at, '+8 hours') >= date(?, '+8 hours')
          AND NOT EXISTS (
            SELECT 1
            FROM ingestion_notifications current_notification
            JOIN ingestion_items current_item ON current_item.id = current_notification.item_id
            WHERE current_item.normalized_code = history.normalized_code
              AND current_item.status = 'moved'
              AND date(current_notification.created_at, '+8 hours') >= date(?, '+8 hours')
          )
          AND (
            EXISTS (SELECT 1 FROM media_files WHERE media_files.normalized_code = history.normalized_code)
            OR EXISTS (
              SELECT 1 FROM ingestion_items
              WHERE ingestion_items.normalized_code = history.normalized_code
                AND ingestion_items.status = 'moved'
            )
          )
        UNION ALL
        SELECT CASE WHEN notifications.read_at IS NULL THEN 1 ELSE 0 END AS unread,
          notifications.created_at AS createdAt
        FROM ingestion_notifications notifications
        JOIN ingestion_items items ON items.id = notifications.item_id
        WHERE items.status IN ('moved', 'failed', 'conflict')
          AND date(notifications.created_at, '+8 hours') >= date(?, '+8 hours')
          AND NOT (
            items.status = 'failed' AND EXISTS (
              SELECT 1 FROM ingestion_items resolved_item
              WHERE resolved_item.status = 'moved'
                AND resolved_item.created_at > items.created_at
                AND (
                  resolved_item.original_path = items.original_path
                  OR resolved_item.target_path = items.target_path
                )
            )
          )
      ) feed
    `).get(history.startedAt, history.startedAt, history.startedAt) as { count: number | null; latestCreatedAt: string | null };
    res.json({ count: row.count ?? 0, latestCreatedAt: row.latestCreatedAt });
  });
  app.get("/api/ingestion/recent-media", (req, res) => {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12));
    const offset = (page - 1) * limit;
    const history = db.prepare(`
      SELECT history_started_at AS startedAt
      FROM ingestion_settings WHERE id = 1
    `).get() as { startedAt: string };
    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ingestion_history history
      WHERE date(history.ingested_at, '+8 hours') >= date(?, '+8 hours')
        AND EXISTS (
          SELECT 1 FROM media_files
          WHERE media_files.normalized_code = history.normalized_code
        )
    `).get(history.startedAt) as { count: number };
    const rows = db.prepare(`
      SELECT ${MEDIA_LIST_SELECT}, 1 AS versionCount,
        recent_ingestion.ingestedAt,
        recent_ingestion.ingestionDay,
        recent_ingestion.ingestionDayCount
      FROM (
        SELECT history.normalized_code AS normalizedCode,
          history.ingested_at AS ingestedAt,
          date(history.ingested_at, '+8 hours') AS ingestionDay,
          COUNT(*) OVER (PARTITION BY date(history.ingested_at, '+8 hours')) AS ingestionDayCount,
          (
            SELECT media_files.id
            FROM media_files
            WHERE media_files.normalized_code = history.normalized_code
            ORDER BY media_files.mtime_ms DESC, media_files.id
            LIMIT 1
          ) AS mediaId
        FROM ingestion_history history
        WHERE date(history.ingested_at, '+8 hours') >= date(?, '+8 hours')
          AND EXISTS (
            SELECT 1 FROM media_files
            WHERE media_files.normalized_code = history.normalized_code
          )
        ORDER BY history.ingested_at DESC, history.normalized_code
        LIMIT ? OFFSET ?
      ) recent_ingestion
      JOIN media_files ON media_files.id = recent_ingestion.mediaId
      ${MEDIA_LIST_JOINS}
      ORDER BY recent_ingestion.ingestedAt DESC, media_files.id
    `).all(history.startedAt, limit, offset) as MediaListRow[];
    const mediaItems = hydrateMediaRows(rows, readFavoriteKeys(), { compact: true }) as unknown as Array<
      Record<string, unknown> & { normalizedCode: string }
    >;
    const completionByCode = getCompletionForCodes(mediaItems.map((item) => item.normalizedCode));
    res.json({
      items: mediaItems.map((item) => ({
        ...item,
        ingestionCompletion: completionByCode.get(item.normalizedCode)
      })),
      total: total.count,
      page,
      pageSize: limit,
      totalPages: Math.ceil(total.count / limit),
      startedAt: history.startedAt
    });
  });
  app.get("/api/notifications", (req, res) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(String(req.query.limit ?? "200"), 10) || 200));
    const queryLimit = Math.min(501, limit + 1);
    const historyStart = db.prepare(`
      SELECT history_started_at AS startedAt
      FROM ingestion_settings WHERE id = 1
    `).get() as { startedAt: string };
    const rows = db.prepare(`
      SELECT 'history:' || history.normalized_code AS id,
        history.read_at AS readAt, history.ingested_at AS createdAt,
        date(history.ingested_at, '+8 hours') AS ingestionDay,
        media_files.id AS mediaId, history.normalized_code AS normalizedCode,
        media_files.library_category AS category,
        COALESCE(items.source_id, history.source) AS sourceId,
        COALESCE(metadata.status, 'pending') AS metadataStatus,
        COALESCE(metadata.translation_status, 'pending') AS translationStatus,
        items.status AS itemStatus, items.reason AS itemReason,
        items.run_id AS runId, runs.trigger_type AS triggerType,
        COALESCE(runs.status, 'completed') AS runStatus,
        runs.stats_json AS runStatsJson,
        COALESCE(NULLIF(metadata.title_zh, ''), metadata.title, '') AS title,
        COALESCE(NULLIF(metadata.actors_zh_json, '[]'), metadata.actors_json, '[]') AS actorsJson
      FROM ingestion_history history
      LEFT JOIN media_files ON media_files.id = (
        SELECT candidate.id
        FROM media_files candidate
        WHERE candidate.normalized_code = history.normalized_code
        ORDER BY candidate.mtime_ms DESC, candidate.id
        LIMIT 1
      )
      LEFT JOIN media_metadata metadata ON metadata.normalized_code = history.normalized_code
      LEFT JOIN ingestion_items items ON items.id = (
        SELECT candidate.id FROM ingestion_items candidate
        WHERE candidate.normalized_code = history.normalized_code
        ORDER BY CASE candidate.status WHEN 'moved' THEN 0 WHEN 'rolled_back' THEN 2 ELSE 1 END,
          candidate.created_at DESC, candidate.id DESC LIMIT 1
      )
      LEFT JOIN ingestion_runs runs ON runs.id = items.run_id
      WHERE date(history.ingested_at, '+8 hours') >= date(?, '+8 hours')
        AND NOT EXISTS (
          SELECT 1
          FROM ingestion_notifications current_notification
          JOIN ingestion_items current_item ON current_item.id = current_notification.item_id
          WHERE current_item.normalized_code = history.normalized_code
            AND current_item.status = 'moved'
            AND date(current_notification.created_at, '+8 hours') >= date(?, '+8 hours')
        )
        AND (
          media_files.id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM ingestion_items current_item
            WHERE current_item.normalized_code = history.normalized_code
              AND current_item.status = 'moved'
          )
        )
      ORDER BY history.ingested_at DESC, history.normalized_code
      LIMIT ?
    `).all(historyStart.startedAt, historyStart.startedAt, queryLimit) as NotificationRow[];
    const eventRows = db.prepare(`
      SELECT 'event:' || notifications.id AS id,
        notifications.read_at AS readAt, notifications.created_at AS createdAt,
        date(notifications.created_at, '+8 hours') AS ingestionDay,
        media_files.id AS mediaId, items.normalized_code AS normalizedCode,
        items.category, items.source_id AS sourceId,
        COALESCE(metadata.status, items.metadata_status, 'pending') AS metadataStatus,
        COALESCE(metadata.translation_status, items.translation_status, 'pending') AS translationStatus,
        items.status AS itemStatus, items.reason AS itemReason,
        items.run_id AS runId, runs.trigger_type AS triggerType,
        runs.status AS runStatus,
        runs.stats_json AS runStatsJson,
        COALESCE(NULLIF(metadata.title_zh, ''), metadata.title, '') AS title,
        COALESCE(NULLIF(metadata.actors_zh_json, '[]'), metadata.actors_json, '[]') AS actorsJson
      FROM ingestion_notifications notifications
      JOIN ingestion_items items ON items.id = notifications.item_id
      JOIN ingestion_runs runs ON runs.id = items.run_id
      LEFT JOIN media_files ON media_files.id = COALESCE(
        items.media_id,
        (SELECT candidate.id FROM media_files candidate WHERE candidate.absolute_path = items.target_path LIMIT 1)
      )
      LEFT JOIN media_metadata metadata ON metadata.normalized_code = items.normalized_code
      WHERE items.status IN ('moved', 'failed', 'conflict')
        AND date(notifications.created_at, '+8 hours') >= date(?, '+8 hours')
        AND NOT (
          items.status = 'failed' AND EXISTS (
            SELECT 1 FROM ingestion_items resolved_item
            WHERE resolved_item.status = 'moved'
              AND resolved_item.created_at > items.created_at
              AND (
                resolved_item.original_path = items.original_path
                OR resolved_item.target_path = items.target_path
              )
          )
        )
      ORDER BY notifications.created_at DESC, notifications.id
      LIMIT ?
    `).all(historyStart.startedAt, queryLimit) as NotificationRow[];
    const feedCandidates = [...rows, ...eventRows]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const hasMore = feedCandidates.length > limit;
    const feedRows = feedCandidates.slice(0, limit);
    const runStatsByRunId = new Map<string, NotificationRunStats>();
    for (const row of feedRows) {
      if (!row.runId || runStatsByRunId.has(row.runId)) continue;
      const runStats = parseNotificationRunStats(row.runStatsJson);
      if (runStats) runStatsByRunId.set(row.runId, runStats);
    }
    const completionByCode = getCompletionForCodes(feedRows.map((row) => row.normalizedCode));
    const items = feedRows.map(({ actorsJson, runStatsJson: _runStatsJson, ...row }) => {
      let actors: string[] = [];
      try {
        const parsed = JSON.parse(actorsJson || "[]") as unknown;
        if (Array.isArray(parsed)) actors = parsed.filter((value): value is string => typeof value === "string");
      } catch {
        actors = [];
      }
      const completion = applyItemStatusToCompletion(
        completionByCode.get(row.normalizedCode),
        row.itemStatus,
        row.itemReason
      );
      return { ...row, actors, completion };
    });
    type NotificationItem = typeof items[number];
    type NotificationGroup = {
      key: string;
      ingestionDay: string;
      runId: string | null;
      triggerType: string | null;
      runStatus: string;
      createdAt: string;
      runStats: NotificationRunStats | null;
      counts: Record<"ready" | "processing" | "attention" | "unread", number>;
      items: NotificationItem[];
    };
    const groups = new Map<string, NotificationGroup>();
    for (const item of items) {
      const runId = typeof item.runId === "string" && item.runId ? item.runId : null;
      const ingestionDay = String(item.ingestionDay ?? "");
      const key = `${ingestionDay}:${runId ?? "history"}`;
      const completion = item.completion as IngestionCompletion | undefined;
      const status = completion?.overallStatus ?? "processing";
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          ingestionDay,
          runId,
          triggerType: typeof item.triggerType === "string" ? item.triggerType : null,
          runStatus: String(item.runStatus ?? "completed"),
          createdAt: String(item.createdAt ?? ""),
          runStats: runId ? runStatsByRunId.get(runId) ?? null : null,
          counts: { ready: 0, processing: 0, attention: 0, unread: 0 },
          items: []
        };
        groups.set(key, group);
      }
      group.items.push(item);
      group.counts[status] += 1;
      if (!item.readAt) group.counts.unread += 1;
    }
    res.json({ items, groups: [...groups.values()], hasMore });
  });
  app.patch("/api/notifications/:id/read", (req, res) => {
    if (req.params.id.startsWith("event:")) {
      db.prepare("UPDATE ingestion_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?")
        .run(new Date().toISOString(), req.params.id.slice("event:".length));
      res.json({ ok: true });
      return;
    }
    const normalizedCode = req.params.id.startsWith("history:")
      ? req.params.id.slice("history:".length)
      : req.params.id;
    db.prepare("UPDATE ingestion_history SET read_at = COALESCE(read_at, ?) WHERE normalized_code = ?")
      .run(new Date().toISOString(), normalizedCode);
    res.json({ ok: true });
  });
  app.post("/api/notifications/read-all", (_req, res) => {
    const now = new Date().toISOString();
    const updated = db.transaction(() => {
      const history = db.prepare("UPDATE ingestion_history SET read_at = ? WHERE read_at IS NULL").run(now);
      const events = db.prepare(`
        UPDATE ingestion_notifications SET read_at = ? WHERE read_at IS NULL
      `).run(now);
      return history.changes + events.changes;
    })();
    res.json({ updated });
  });
}
