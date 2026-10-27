import crypto from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { getAgentRuntimeStatus } from "./agentCapabilities.js";
import { listBackupJobs } from "./backupManager.js";
import { db, rebuildMediaSearchIndex } from "./db.js";
import { enqueueMediaJob } from "./mediaJobs.js";
import { enqueueMetadataEnrichmentAfterCurrentRun } from "./metadata.js";
import { refreshMetadataQualityIssues } from "./metadataQuality.js";
import { getActiveUserProfile } from "./userProfiles.js";

type CandidateRow = {
  targetId: string;
  code: string;
  mediaId: string | null;
  title: string;
  releaseDate: string | null;
  detail: string;
  total: number;
};

const supportedIssueKeys = ["metadata", "artwork", "issues", "stale", "probeFailed", "playbackRisk"] as const;
const issueKeySchema = z.enum(supportedIssueKeys);
const previewSchema = z.object({
  issueKey: issueKeySchema,
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
const createSchema = previewSchema;
const executeSchema = z.object({ confirm: z.literal(true) });

const issueDefinitions: Record<(typeof supportedIssueKeys)[number], {
  label: string;
  actionType: "metadata-refresh" | "probe-refresh";
  actionLabel: string;
  grain: "works" | "files";
  condition: string;
}> = {
  metadata: { label: "元数据未就绪", actionType: "metadata-refresh", actionLabel: "重新抓取元数据", grain: "works", condition: "metadata.status IS NULL OR metadata.status != 'ready'" },
  artwork: { label: "封面待补齐", actionType: "metadata-refresh", actionLabel: "重新抓取封面与元数据", grain: "works", condition: "NULLIF(metadata.cover_url, '') IS NULL AND NULLIF(metadata.thumb_url, '') IS NULL" },
  issues: { label: "结构化质量问题", actionType: "metadata-refresh", actionLabel: "重新抓取问题作品元数据", grain: "works", condition: "EXISTS (SELECT 1 FROM metadata_quality_issues issues WHERE issues.normalized_code = files.normalized_code)" },
  stale: { label: "90 天未刷新", actionType: "metadata-refresh", actionLabel: "刷新陈旧元数据", grain: "works", condition: "metadata.updated_at IS NULL OR julianday('now') - julianday(metadata.updated_at) >= 90" },
  probeFailed: { label: "技术探测失败", actionType: "probe-refresh", actionLabel: "重新执行技术探测", grain: "files", condition: "files.probe_status = 'failed'" },
  playbackRisk: { label: "播放兼容风险", actionType: "probe-refresh", actionLabel: "重新探测播放兼容性", grain: "files", condition: "files.compatibility_status IN ('transcode', 'unsupported')" }
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function actionTaskRow(row: Record<string, unknown>) {
  return {
    id: String(row.id ?? ""),
    issueKey: String(row.issueKey ?? ""),
    issueLabel: String(row.issueLabel ?? ""),
    actionType: String(row.actionType ?? ""),
    grain: String(row.grain ?? ""),
    status: String(row.status ?? "draft"),
    targetCount: Number(row.targetCount ?? 0),
    targetIds: parseJson(String(row.targetIdsJson ?? "[]"), [] as string[]),
    preview: parseJson(String(row.previewJson ?? "[]"), [] as CandidateRow[]),
    result: parseJson(String(row.resultJson ?? "{}"), {} as Record<string, unknown>),
    error: String(row.error ?? ""),
    createdAt: String(row.createdAt ?? ""),
    confirmedAt: row.confirmedAt ? String(row.confirmedAt) : null,
    startedAt: row.startedAt ? String(row.startedAt) : null,
    completedAt: row.completedAt ? String(row.completedAt) : null,
    updatedAt: String(row.updatedAt ?? "")
  };
}

function listGovernanceActions(userId: string, limit = 50) {
  return (db.prepare(`
    SELECT id, issue_key AS issueKey, issue_label AS issueLabel, action_type AS actionType,
      grain, status, target_count AS targetCount, target_ids_json AS targetIdsJson,
      preview_json AS previewJson, result_json AS resultJson, error,
      created_at AS createdAt, confirmed_at AS confirmedAt, started_at AS startedAt,
      completed_at AS completedAt, updated_at AS updatedAt
    FROM governance_action_tasks
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(userId, limit) as Array<Record<string, unknown>>).map(actionTaskRow);
}

function previewGovernanceAction(issueKey: z.infer<typeof issueKeySchema>, limit: number) {
  const definition = issueDefinitions[issueKey];
  const baseSelect = definition.grain === "works"
    ? `
      SELECT files.normalized_code AS targetId,
        files.normalized_code AS code,
        MIN(files.id) AS mediaId,
        COALESCE(NULLIF(metadata.title_zh, ''), NULLIF(metadata.title, ''), files.normalized_code) AS title,
        metadata.release_date AS releaseDate,
        CASE WHEN metadata.status IS NULL THEN 'missing' ELSE metadata.status END AS detail
      FROM media_files files
      LEFT JOIN media_metadata metadata ON metadata.normalized_code = files.normalized_code
      WHERE files.media_type = 'video' AND files.normalized_code != '' AND (${definition.condition})
      GROUP BY files.normalized_code
    `
    : `
      SELECT files.id AS targetId,
        COALESCE(NULLIF(files.normalized_code, ''), files.basename) AS code,
        files.id AS mediaId,
        files.basename AS title,
        metadata.release_date AS releaseDate,
        CASE WHEN files.probe_status = 'failed' THEN COALESCE(NULLIF(files.probe_error, ''), files.compatibility_status) ELSE files.compatibility_status END AS detail
      FROM media_files files
      LEFT JOIN media_metadata metadata ON metadata.normalized_code = files.normalized_code
      WHERE files.media_type = 'video' AND (${definition.condition})
    `;
  const rows = db.prepare(`
    WITH candidates AS (${baseSelect})
    SELECT candidates.*, COUNT(*) OVER() AS total
    FROM candidates
    ORDER BY CASE WHEN date(releaseDate) IS NULL THEN 1 ELSE 0 END, releaseDate DESC, code
    LIMIT ?
  `).all(limit) as CandidateRow[];
  const total = Number(rows[0]?.total ?? 0);
  const samples = rows.map((row) => ({
    targetId: String(row.targetId),
    code: String(row.code),
    mediaId: row.mediaId ? String(row.mediaId) : null,
    title: String(row.title),
    releaseDate: row.releaseDate ? String(row.releaseDate) : null,
    detail: String(row.detail ?? "")
  }));
  return {
    issueKey,
    issueLabel: definition.label,
    actionType: definition.actionType,
    actionLabel: definition.actionLabel,
    grain: definition.grain,
    total,
    selectedCount: samples.length,
    truncated: total > samples.length,
    samples
  };
}

function updateTask(id: string, values: { status: string; result?: unknown; error?: string; confirmedAt?: string; startedAt?: string; completedAt?: string }) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE governance_action_tasks
    SET status = @status,
      result_json = COALESCE(@resultJson, result_json),
      error = COALESCE(@error, error),
      confirmed_at = COALESCE(@confirmedAt, confirmed_at),
      started_at = COALESCE(@startedAt, started_at),
      completed_at = COALESCE(@completedAt, completed_at),
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    status: values.status,
    resultJson: values.result === undefined ? null : JSON.stringify(values.result),
    error: values.error ?? null,
    confirmedAt: values.confirmedAt ?? null,
    startedAt: values.startedAt ?? null,
    completedAt: values.completedAt ?? null,
    updatedAt: now
  });
}

function reconcileQueuedGovernanceActions(userId: string): void {
  const queued = listGovernanceActions(userId, 100).filter((task) => task.status === "queued" && task.actionType === "probe-refresh");
  for (const task of queued) {
    const jobIds = Array.isArray(task.result.jobIds)
      ? task.result.jobIds.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    if (jobIds.length === 0) continue;
    const placeholders = jobIds.map(() => "?").join(",");
    const statuses = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM media_jobs
      WHERE id IN (${placeholders})
      GROUP BY status
    `).all(...jobIds) as Array<{ status: string; count: number }>;
    const counts = Object.fromEntries(statuses.map((item) => [item.status, Number(item.count)]));
    const ready = counts.ready ?? 0;
    const failed = counts.failed ?? 0;
    const active = (counts.pending ?? 0) + (counts.running ?? 0);
    const result = { ...task.result, jobIds, ready, failed, active };
    if (active > 0) {
      updateTask(task.id, { status: "queued", result });
    } else if (ready === jobIds.length) {
      updateTask(task.id, { status: "completed", completedAt: new Date().toISOString(), result });
    } else {
      updateTask(task.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        result,
        error: `${failed} 个技术探测任务失败，请在任务中心查看失败原因。`
      });
    }
  }
}

async function buildTaskCenter(userId: string) {
  reconcileQueuedGovernanceActions(userId);
  const agent = await getAgentRuntimeStatus().catch(() => null);
  const mediaJobs = db.prepare(`
    SELECT job_type AS key, status, COUNT(*) AS count, MAX(updated_at) AS updatedAt,
      MAX(NULLIF(error, '')) AS error
    FROM media_jobs
    WHERE status IN ('pending', 'running', 'failed')
      AND (status != 'failed' OR datetime(updated_at) >= datetime('now', '-7 days'))
    GROUP BY job_type, status
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, count DESC
  `).all() as Array<{ key: string; status: string; count: number; updatedAt: string; error: string | null }>;
  const ingestionRuns = db.prepare(`
    SELECT id, status, phase, trigger_type AS triggerType, error, updated_at AS updatedAt
    FROM ingestion_runs
    WHERE status NOT IN ('completed') OR datetime(updated_at) >= datetime('now', '-7 days')
    ORDER BY updated_at DESC LIMIT 12
  `).all() as Array<Record<string, unknown>>;
  const notificationRow = db.prepare("SELECT COUNT(*) AS count FROM ingestion_notifications WHERE read_at IS NULL").get() as { count: number };
  const completedMediaRow = db.prepare(`
    SELECT COUNT(*) AS count FROM media_jobs
    WHERE status = 'ready' AND date(COALESCE(finished_at, updated_at), 'localtime') = date('now', 'localtime')
  `).get() as { count: number };
  const governance = listGovernanceActions(userId, 24);
  const backups = listBackupJobs().slice(0, 8);
  const mediaAttention = mediaJobs.filter((item) => item.status === "failed").reduce((sum, item) => sum + Number(item.count), 0);
  const governanceAttention = governance.filter((item) => ["draft", "failed"].includes(item.status)).length;
  const activeGovernance = governance.filter((item) => ["running", "queued"].includes(item.status)).length;
  const failedIngestion = ingestionRuns.filter((item) => item.status === "failed" || item.status === "partial").length;
  const activeIngestion = ingestionRuns.filter((item) => ["queued", "running", "processing", "awaiting_scan"].includes(String(item.status))).length;
  const backupAttention = backups.filter((item) => item.status === "failed" || item.status === "paused").length;
  const activeBackups = backups.filter((item) => ["queued", "scanning", "running"].includes(item.status)).length;
  const shanghaiDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const today = shanghaiDay.format(new Date());
  const completedGovernanceToday = governance.filter((item) => item.status === "completed" && item.completedAt && shanghaiDay.format(new Date(item.completedAt)) === today).length;
  const completedIngestionToday = ingestionRuns.filter((item) => item.status === "completed" && item.updatedAt && shanghaiDay.format(new Date(String(item.updatedAt))) === today).length;
  const completedBackupsToday = backups.filter((item) => item.status === "completed" && item.completedAt && shanghaiDay.format(new Date(item.completedAt)) === today).length;
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      attention: mediaAttention + governanceAttention + failedIngestion + backupAttention,
      active: mediaJobs.filter((item) => item.status === "pending" || item.status === "running").reduce((sum, item) => sum + Number(item.count), 0) + activeGovernance + activeIngestion + activeBackups,
      unread: Number(notificationRow.count ?? 0),
      completedToday: Number(completedMediaRow.count ?? 0) + completedGovernanceToday + completedIngestionToday + completedBackupsToday
    },
    governance,
    mediaJobs,
    ingestionRuns,
    backups,
    runtimes: {
      agent: agent ? { available: agent.agentAvailable, storageReady: agent.storage.ready, loadedModels: agent.loadedModels, reason: agent.unavailableReason } : null,
    }
  };
}

export function registerGovernanceActionRoutes(app: Express, options: { onDataChanged?: () => void } = {}): void {
  app.get("/api/governance/actions", (req, res, next) => {
    try {
      const limit = z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit);
      reconcileQueuedGovernanceActions(getActiveUserProfile().id);
      res.json({ items: listGovernanceActions(getActiveUserProfile().id, limit) });
    } catch (error) { next(error); }
  });

  app.post("/api/governance/actions/preview", (req, res, next) => {
    try {
      const input = previewSchema.parse(req.body ?? {});
      res.setHeader("Cache-Control", "private, no-store");
      res.json(previewGovernanceAction(input.issueKey, input.limit));
    } catch (error) { next(error); }
  });

  app.post("/api/governance/actions", (req, res, next) => {
    try {
      const input = createSchema.parse(req.body ?? {});
      const preview = previewGovernanceAction(input.issueKey, input.limit);
      if (preview.selectedCount === 0) {
        res.status(409).json({ error: "当前没有需要处理的对象，请刷新分析后重试。" });
        return;
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO governance_action_tasks
          (id, user_id, issue_key, issue_label, action_type, grain, status, target_count,
           target_ids_json, preview_json, result_json, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, '{}', '', ?, ?)
      `).run(
        id,
        getActiveUserProfile().id,
        preview.issueKey,
        preview.issueLabel,
        preview.actionType,
        preview.grain,
        preview.selectedCount,
        JSON.stringify(preview.samples.map((item) => item.targetId)),
        JSON.stringify(preview.samples),
        now,
        now
      );
      res.status(201).json(listGovernanceActions(getActiveUserProfile().id, 100).find((item) => item.id === id));
    } catch (error) { next(error); }
  });

  app.post("/api/governance/actions/:id/execute", (req, res, next) => {
    try {
      executeSchema.parse(req.body ?? {});
      const userId = getActiveUserProfile().id;
      const task = listGovernanceActions(userId, 100).find((item) => item.id === req.params.id);
      if (!task) {
        res.status(404).json({ error: "治理任务不存在。" });
        return;
      }
      if (task.status !== "draft") {
        res.status(409).json({ error: "只有待确认任务可以执行。" });
        return;
      }
      const now = new Date().toISOString();
      updateTask(task.id, { status: "running", confirmedAt: now, startedAt: now, error: "" });
      if (task.actionType === "probe-refresh") {
        try {
          const jobIds = task.targetIds.map((mediaId) => enqueueMediaJob(mediaId, "probe", { priority: 100 }));
          updateTask(task.id, { status: "queued", result: { dispatched: jobIds.length, jobIds, ready: 0, failed: 0, active: jobIds.length } });
        } catch (error) {
          updateTask(task.id, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : "技术探测任务派发失败"
          });
        }
        res.status(202).json(listGovernanceActions(userId, 100).find((item) => item.id === task.id));
        return;
      }

      const job = enqueueMetadataEnrichmentAfterCurrentRun({
        codes: task.targetIds,
        force: true,
        limit: task.targetIds.length,
        reason: "manual"
      });
      job.then((summary) => {
        rebuildMediaSearchIndex();
        refreshMetadataQualityIssues();
        options.onDataChanged?.();
        updateTask(task.id, { status: "completed", completedAt: new Date().toISOString(), result: summary });
      }).catch((error) => {
        updateTask(task.id, { status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "治理任务执行失败" });
      });
      res.status(202).json(listGovernanceActions(userId, 100).find((item) => item.id === task.id));
    } catch (error) { next(error); }
  });

  app.post("/api/governance/actions/:id/cancel", (req, res, next) => {
    try {
      const userId = getActiveUserProfile().id;
      const task = listGovernanceActions(userId, 100).find((item) => item.id === req.params.id);
      if (!task) return void res.status(404).json({ error: "治理任务不存在。" });
      if (task.status !== "draft") return void res.status(409).json({ error: "任务已开始，不能直接取消。" });
      updateTask(task.id, { status: "cancelled", completedAt: new Date().toISOString() });
      res.json(listGovernanceActions(userId, 100).find((item) => item.id === task.id));
    } catch (error) { next(error); }
  });

  app.get("/api/task-center", async (_req, res, next) => {
    try {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await buildTaskCenter(getActiveUserProfile().id));
    } catch (error) { next(error); }
  });
}

export { buildTaskCenter, issueDefinitions, listGovernanceActions, previewGovernanceAction, reconcileQueuedGovernanceActions };
