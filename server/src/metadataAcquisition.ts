import crypto from "node:crypto";
import { config } from "./config.js";
import { db, rebuildMediaSearchIndex, type MediaRow } from "./db.js";
import {
  enqueueMetadataEnrichmentAfterCurrentRun,
  type MetadataRunSummary
} from "./metadata.js";
import {
  createContentPreviewSourceSignature,
  getContentPreview,
  inspectContentPreviewStorage,
  scheduleContentPreview
} from "./contentPreviews.js";

export type AcquisitionPackage = "work-facts" | "local-gallery";
export type AcquisitionMode = "missing-or-stale" | "all";

export type AcquisitionPlanInput = {
  category?: string;
  codes?: string[];
  packages?: AcquisitionPackage[];
  limit?: number;
  mode?: AcquisitionMode;
};

type Candidate = {
  code: string;
  category: string;
  metadataStatus: string;
  fetchedAt: string | null;
  localFiles: number;
  readyPreviews: number;
};

type PlanRow = {
  planId: string;
  planHash: string;
  mode: AcquisitionMode;
  scopeJson: string;
  packagesJson: string;
  candidatesJson: string;
  candidateCount: number;
  createdAt: string;
  expiresAt: string;
};

type TaskRow = {
  taskId: string;
  runId: string;
  kind: AcquisitionPackage;
  subjectKey: string;
  category: string;
  attempts: number;
  maxAttempts: number;
};

const FINAL_TASK_STATES = new Set(["succeeded", "not_found", "failed", "cancelled"]);
const DEFAULT_PACKAGES: AcquisitionPackage[] = ["work-facts", "local-gallery"];
const workerIntervalMs = 3_000;
let workerTimer: NodeJS.Timeout | null = null;
let workerBusy = false;
let workerStopping = false;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildAcquisitionPlanHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeCodes(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean))].slice(0, 500);
}

function normalizePackages(values: AcquisitionPackage[] | undefined): AcquisitionPackage[] {
  const selected = [...new Set(values?.length ? values : DEFAULT_PACKAGES)];
  return DEFAULT_PACKAGES.filter((item) => selected.includes(item));
}

function readCandidates(input: Required<Pick<AcquisitionPlanInput, "category" | "limit" | "mode">> & {
  codes: string[];
  packages: AcquisitionPackage[];
}): Candidate[] {
  const codeParams = Object.fromEntries(input.codes.map((code, index) => [`code${index}`, code]));
  const codeClause = input.codes.length > 0
    ? `AND media.normalized_code IN (${input.codes.map((_code, index) => `@code${index}`).join(", ")})`
    : "";
  const scanLimit = Math.min(2_500, Math.max(input.limit * 8, input.limit));
  const rows = db.prepare(`
    SELECT
      media.normalized_code AS code,
      MAX(media.library_category) AS category,
      COALESCE(metadata.status, 'missing') AS metadataStatus,
      metadata.fetched_at AS fetchedAt,
      metadata.title,
      metadata.summary,
      metadata.actors_json AS actorsJson,
      metadata.genres_json AS genresJson,
      metadata.maker,
      metadata.release_date AS releaseDate,
      COUNT(DISTINCT media.id) AS localFiles,
      SUM(CASE WHEN story.content_status = 'ready' THEN 1 ELSE 0 END) AS readyPreviews,
      MAX(media.mtime_ms) AS latestMtime
    FROM media_files media
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = media.normalized_code
    LEFT JOIN media_storyboards story ON story.media_id = media.id
    WHERE media.media_type = 'video'
      AND media.normalized_code != ''
      AND media.code_prefix != ''
      AND (@category = '' OR media.library_category = @category)
      ${codeClause}
    GROUP BY media.normalized_code
    ORDER BY latestMtime DESC, media.normalized_code
    LIMIT @scanLimit
  `).all({ category: input.category, scanLimit, ...codeParams }) as Array<Candidate & {
    title: string | null;
    summary: string | null;
    actorsJson: string | null;
    genresJson: string | null;
    maker: string | null;
    releaseDate: string | null;
  }>;

  const staleBefore = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  return rows.filter((row) => {
    if (input.mode === "all" || input.codes.length > 0) return true;
    const actors = parseJson<unknown[]>(row.actorsJson ?? "[]", []);
    const genres = parseJson<unknown[]>(row.genresJson ?? "[]", []);
    const fetchedAt = Date.parse(row.fetchedAt ?? "");
    const workNeedsRefresh = input.packages.includes("work-facts") && (
      row.metadataStatus !== "ready" || !row.title?.trim() || !row.summary?.trim() ||
      actors.length === 0 || genres.length < 3 || !row.maker?.trim() || !row.releaseDate ||
      !Number.isFinite(fetchedAt) || fetchedAt < staleBefore
    );
    const galleryNeedsWork = input.packages.includes("local-gallery") && row.readyPreviews < row.localFiles;
    return workNeedsRefresh || galleryNeedsWork;
  }).slice(0, input.limit).map((row) => ({
    code: row.code,
    category: row.category,
    metadataStatus: row.metadataStatus,
    fetchedAt: row.fetchedAt,
    localFiles: row.localFiles,
    readyPreviews: row.readyPreviews
  }));
}

function mapPlan(row: PlanRow) {
  return {
    planId: row.planId,
    planHash: row.planHash,
    mode: row.mode,
    scope: parseJson<Record<string, unknown>>(row.scopeJson, {}),
    packages: parseJson<AcquisitionPackage[]>(row.packagesJson, []),
    candidates: parseJson<Candidate[]>(row.candidatesJson, []),
    candidateCount: row.candidateCount,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt
  };
}

export function createAcquisitionPlan(input: AcquisitionPlanInput = {}) {
  const category = (input.category ?? "").trim().toUpperCase();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const mode = input.mode ?? "missing-or-stale";
  const codes = normalizeCodes(input.codes);
  const packages = normalizePackages(input.packages);
  const candidates = readCandidates({ category, limit, mode, codes, packages });
  const scope = { category: category || null, codes, limit };
  const hashInput = { version: 1, mode, scope, packages, candidates };
  const planHash = buildAcquisitionPlanHash(hashInput);
  const planId = crypto.randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  db.prepare(`
    INSERT INTO metadata_acquisition_plans (
      plan_id, plan_hash, mode, scope_json, packages_json, candidates_json,
      candidate_count, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    planId, planHash, mode, JSON.stringify(scope), JSON.stringify(packages),
    JSON.stringify(candidates), candidates.length, createdAt, expiresAt
  );
  return { planId, planHash, mode, scope, packages, candidates, candidateCount: candidates.length, createdAt, expiresAt };
}

function readPlan(planId: string): ReturnType<typeof mapPlan> | null {
  const row = db.prepare(`
    SELECT plan_id AS planId, plan_hash AS planHash, mode, scope_json AS scopeJson,
      packages_json AS packagesJson, candidates_json AS candidatesJson,
      candidate_count AS candidateCount, created_at AS createdAt, expires_at AS expiresAt
    FROM metadata_acquisition_plans WHERE plan_id = ?
  `).get(planId) as PlanRow | undefined;
  return row ? mapPlan(row) : null;
}

function updateRunCounts(runId: string): void {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM metadata_acquisition_tasks WHERE run_id = ? GROUP BY status
  `).all(runId) as Array<{ status: string; count: number }>;
  const counts = Object.fromEntries(rows.map((row) => [row.status, row.count]));
  const active = rows.some((row) => !FINAL_TASK_STATES.has(row.status) && row.count > 0);
  const failed = (counts.failed ?? 0) > 0;
  const pendingRun = db.prepare("SELECT status FROM metadata_acquisition_runs WHERE run_id = ?").get(runId) as { status: string } | undefined;
  if (!pendingRun || pendingRun.status === "paused" || pendingRun.status === "cancelled") {
    db.prepare("UPDATE metadata_acquisition_runs SET counts_json = ?, updated_at = ? WHERE run_id = ?")
      .run(JSON.stringify(counts), nowIso(), runId);
    return;
  }
  const status = active ? "running" : failed ? "partial" : "succeeded";
  const finishedAt = active ? null : nowIso();
  db.prepare(`
    UPDATE metadata_acquisition_runs
    SET status = ?, counts_json = ?, finished_at = ?, updated_at = ?
    WHERE run_id = ?
  `).run(status, JSON.stringify(counts), finishedAt, nowIso(), runId);
  if (!active && pendingRun.status === "running") {
    const documents = rebuildMediaSearchIndex();
    console.log(`[metadata-acquisition] Rebuilt search index with ${documents} documents after run ${runId}`);
  }
}

export function readAcquisitionRun(runId: string) {
  const row = db.prepare(`
    SELECT run_id AS runId, request_key AS requestKey, plan_id AS planId,
      plan_hash AS planHash, mode, scope_json AS scopeJson, packages_json AS packagesJson,
      status, counts_json AS countsJson, error, created_at AS createdAt,
      started_at AS startedAt, finished_at AS finishedAt, updated_at AS updatedAt
    FROM metadata_acquisition_runs WHERE run_id = ?
  `).get(runId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const tasks = db.prepare(`
    SELECT task_id AS taskId, kind, subject_type AS subjectType, subject_key AS subjectKey,
      category, status, attempts, max_attempts AS maxAttempts,
      result_json AS resultJson, error, started_at AS startedAt,
      finished_at AS finishedAt, updated_at AS updatedAt
    FROM metadata_acquisition_tasks WHERE run_id = ?
    ORDER BY created_at, kind, subject_key
  `).all(runId) as Array<Record<string, unknown> & { resultJson: string }>;
  return {
    ...row,
    scope: parseJson(String(row.scopeJson ?? "{}"), {}),
    packages: parseJson(String(row.packagesJson ?? "[]"), []),
    counts: parseJson(String(row.countsJson ?? "{}"), {}),
    scopeJson: undefined,
    packagesJson: undefined,
    countsJson: undefined,
    tasks: tasks.map((task) => ({
      ...task,
      result: parseJson(task.resultJson, {}),
      resultJson: undefined
    }))
  };
}

export function createAcquisitionRun(input: { planId: string; planHash: string; requestKey: string }) {
  const existing = db.prepare("SELECT run_id AS runId FROM metadata_acquisition_runs WHERE request_key = ?")
    .get(input.requestKey) as { runId: string } | undefined;
  if (existing) return readAcquisitionRun(existing.runId);
  const plan = readPlan(input.planId);
  if (!plan) throw Object.assign(new Error("Acquisition plan not found"), { statusCode: 404 });
  if (Date.parse(plan.expiresAt) <= Date.now()) throw Object.assign(new Error("Acquisition plan expired"), { statusCode: 409 });
  if (plan.planHash !== input.planHash) throw Object.assign(new Error("Acquisition plan hash changed"), { statusCode: 409 });
  if (plan.candidateCount === 0) throw Object.assign(new Error("Acquisition plan contains no candidates"), { statusCode: 409 });

  const runId = crypto.randomUUID();
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO metadata_acquisition_runs (
        run_id, request_key, plan_id, plan_hash, mode, scope_json, packages_json,
        status, counts_json, created_at, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '{}', ?, ?, ?)
    `).run(
      runId, input.requestKey, plan.planId, plan.planHash, plan.mode,
      JSON.stringify(plan.scope), JSON.stringify(plan.packages), timestamp, timestamp, timestamp
    );
    const insertTask = db.prepare(`
      INSERT INTO metadata_acquisition_tasks (
        task_id, run_id, kind, subject_type, subject_key, category,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 'work', ?, ?, 'queued', ?, ?)
    `);
    for (const candidate of plan.candidates) {
      for (const kind of plan.packages) {
        insertTask.run(crypto.randomUUID(), runId, kind, candidate.code, candidate.category, timestamp, timestamp);
      }
    }
  })();
  updateRunCounts(runId);
  kickAcquisitionWorker();
  return readAcquisitionRun(runId);
}

function recordMetadataEvidence(code: string): string | null {
  const row = db.prepare(`
    SELECT source, provider_id AS providerId, raw_json AS rawJson, title, summary,
      actors_json AS actorsJson, genres_json AS genresJson, maker, label, series,
      release_date AS releaseDate, runtime_minutes AS runtimeMinutes, fetched_at AS fetchedAt
    FROM media_metadata WHERE normalized_code = ? AND status = 'ready'
  `).get(code) as Record<string, unknown> | undefined;
  if (!row) return null;
  const rawJson = String(row.rawJson ?? "");
  const bodyHash = crypto.createHash("sha256").update(rawJson).digest("hex");
  const source = String(row.source ?? "legacy");
  const sourceItemKey = String(row.providerId || code);
  const existing = db.prepare(`
    SELECT record_id AS recordId FROM metadata_source_records
    WHERE source = ? AND source_item_key = ? AND body_hash = ? AND parser_version = 'legacy-adapter-v1'
  `).get(source, sourceItemKey, bodyHash) as { recordId: string } | undefined;
  if (existing) return existing.recordId;
  const recordId = crypto.randomUUID();
  const summary = {
    code,
    title: row.title,
    hasSummary: Boolean(String(row.summary ?? "").trim()),
    actorCount: parseJson<unknown[]>(String(row.actorsJson ?? "[]"), []).length,
    genreCount: parseJson<unknown[]>(String(row.genresJson ?? "[]"), []).length,
    maker: row.maker,
    label: row.label,
    series: row.series,
    releaseDate: row.releaseDate,
    runtimeMinutes: row.runtimeMinutes,
    fetchedAt: row.fetchedAt
  };
  db.prepare(`
    INSERT INTO metadata_source_records (
      record_id, source, source_item_key, body_hash, parser_version, summary_json, observed_at
    ) VALUES (?, ?, ?, ?, 'legacy-adapter-v1', ?, ?)
  `).run(recordId, source, sourceItemKey, bodyHash, JSON.stringify(summary), nowIso());
  return recordId;
}

async function processWorkFacts(task: TaskRow): Promise<{ status: string; result: unknown; error: string | null }> {
  const summary: MetadataRunSummary = await enqueueMetadataEnrichmentAfterCurrentRun({
    codes: [task.subjectKey],
    category: task.category,
    force: true,
    preserveReady: false,
    limit: 1,
    reason: "manual",
    exportWorkbook: false
  });
  const row = db.prepare(`
    SELECT status, source, error, fetched_at AS fetchedAt, updated_at AS updatedAt
    FROM media_metadata WHERE normalized_code = ?
  `).get(task.subjectKey) as { status: string; source: string; error: string | null; fetchedAt: string | null; updatedAt: string } | undefined;
  const result = { summary, metadata: row ?? null, sourceRecordId: row?.status === "ready" ? recordMetadataEvidence(task.subjectKey) : null };
  if (row?.status === "ready") return { status: "succeeded", result, error: null };
  if (row?.status === "not_found") return { status: "not_found", result, error: row.error };
  return { status: "failed", result, error: row?.error ?? "Metadata task did not produce a ready record" };
}

function upsertRunMediaJob(input: {
  runId: string;
  mediaId: string;
  sourceSignature: string;
  mediaJobId: string;
  status: string;
  result: unknown;
}): void {
  db.prepare(`
    INSERT INTO metadata_run_media_jobs (
      run_id, media_id, job_type, source_signature, media_job_id, status, result_json, updated_at
    ) VALUES (?, ?, 'content-preview', ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, media_id, job_type, source_signature) DO UPDATE SET
      media_job_id = excluded.media_job_id,
      status = excluded.status,
      result_json = excluded.result_json,
      updated_at = excluded.updated_at
  `).run(
    input.runId, input.mediaId, input.sourceSignature, input.mediaJobId,
    input.status, JSON.stringify(input.result), nowIso()
  );
}

function processLocalGallery(task: TaskRow): { status: string; result: unknown; error: string | null } {
  const mediaRows = db.prepare(`
    SELECT * FROM media_files
    WHERE normalized_code = ? AND media_type = 'video'
    ORDER BY mtime_ms DESC, id
  `).all(task.subjectKey) as MediaRow[];
  if (mediaRows.length === 0) return { status: "not_found", result: { media: [] }, error: "No local video file" };

  let reused = 0;
  let queued = 0;
  let waitingStorage = 0;
  let failed = 0;
  const media: Array<Record<string, unknown>> = [];
  for (const item of mediaRows) {
    const preview = getContentPreview(item.id);
    const sourceSignature = item.duration_seconds && item.duration_seconds > 0
      ? createContentPreviewSourceSignature(item, item.duration_seconds)
      : "";
    if (preview.status === "ready") {
      reused += 1;
      const result = { status: "reused", photos: preview.photos.length, gifs: preview.gifs.length, bytes: preview.totalBytes };
      upsertRunMediaJob({ runId: task.runId, mediaId: item.id, sourceSignature, mediaJobId: "", status: "reused", result });
      media.push({ mediaId: item.id, ...result });
      continue;
    }
    if (preview.status === "failed") {
      failed += 1;
      const result = { status: "failed", error: preview.error };
      upsertRunMediaJob({ runId: task.runId, mediaId: item.id, sourceSignature, mediaJobId: "", status: "failed", result });
      media.push({ mediaId: item.id, ...result });
      continue;
    }
    const scheduled = scheduleContentPreview(item, 60);
    if (scheduled.status === "deferred") waitingStorage += 1;
    else if (scheduled.status === "ready") reused += 1;
    else queued += 1;
    const status = scheduled.status === "deferred" ? "waiting_storage" : scheduled.status;
    const result = { status, reason: scheduled.reason };
    upsertRunMediaJob({
      runId: task.runId,
      mediaId: item.id,
      sourceSignature,
      mediaJobId: scheduled.jobId,
      status,
      result
    });
    media.push({ mediaId: item.id, mediaJobId: scheduled.jobId, ...result });
  }
  const result = { localFiles: mediaRows.length, reused, queued, waitingStorage, failed, media };
  if (queued > 0) return { status: "waiting_media", result, error: null };
  if (waitingStorage > 0) return { status: "waiting_storage", result, error: null };
  if (failed > 0) return { status: "failed", result, error: `${failed} local preview(s) failed` };
  return { status: "succeeded", result, error: null };
}

function claimTask(): TaskRow | null {
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT task.task_id AS taskId, task.run_id AS runId, task.kind,
        task.subject_key AS subjectKey, task.category, task.attempts,
        task.max_attempts AS maxAttempts
      FROM metadata_acquisition_tasks task
      JOIN metadata_acquisition_runs run ON run.run_id = task.run_id
      WHERE task.status = 'queued' AND run.status = 'running'
        AND (task.attempts = 0 OR
          julianday(task.updated_at) + (30.0 * task.attempts / 86400) <= julianday('now'))
      ORDER BY task.created_at, CASE task.kind WHEN 'work-facts' THEN 0 ELSE 1 END, task.subject_key
      LIMIT 1
    `).get() as TaskRow | undefined;
    if (!row) return null;
    const timestamp = nowIso();
    const updated = db.prepare(`
      UPDATE metadata_acquisition_tasks
      SET status = 'running', attempts = attempts + 1,
        started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE task_id = ? AND status = 'queued'
    `).run(timestamp, timestamp, row.taskId);
    return updated.changes > 0 ? row : null;
  })();
}

function finishTask(task: TaskRow, outcome: { status: string; result: unknown; error: string | null }): void {
  const finishedAt = FINAL_TASK_STATES.has(outcome.status) ? nowIso() : null;
  db.prepare(`
    UPDATE metadata_acquisition_tasks
    SET status = ?, result_json = ?, error = ?, finished_at = ?, updated_at = ?
    WHERE task_id = ?
  `).run(outcome.status, JSON.stringify(outcome.result), outcome.error, finishedAt, nowIso(), task.taskId);
  updateRunCounts(task.runId);
}

function reconcileWaitingTasks(): void {
  const tasks = db.prepare(`
    SELECT task.task_id AS taskId, task.run_id AS runId, task.kind,
      task.subject_key AS subjectKey, task.category, task.attempts,
      task.max_attempts AS maxAttempts
    FROM metadata_acquisition_tasks task
    JOIN metadata_acquisition_runs run ON run.run_id = task.run_id
    WHERE task.kind = 'local-gallery'
      AND task.status IN ('waiting_media', 'waiting_storage')
      AND run.status = 'running'
    ORDER BY task.updated_at
    LIMIT 25
  `).all() as TaskRow[];
  for (const task of tasks) finishTask(task, processLocalGallery(task));
}

async function runWorkerPass(): Promise<void> {
  if (workerBusy || workerStopping) return;
  workerBusy = true;
  try {
    reconcileWaitingTasks();
    for (;;) {
      const task = claimTask();
      if (!task) break;
      try {
        const outcome = task.kind === "work-facts"
          ? await processWorkFacts(task)
          : processLocalGallery(task);
        const retry = outcome.status === "failed" && task.attempts + 1 < task.maxAttempts;
        finishTask(task, retry ? { ...outcome, status: "queued" } : outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retry = task.attempts + 1 < task.maxAttempts;
        finishTask(task, {
          status: retry ? "queued" : "failed",
          result: {},
          error: message
        });
        if (retry) break;
      }
    }
  } finally {
    workerBusy = false;
  }
}

function kickAcquisitionWorker(): void {
  if (workerStopping) return;
  setImmediate(() => void runWorkerPass());
}

export function startMetadataAcquisitionWorker(): void {
  if (workerTimer) return;
  workerStopping = false;
  const timestamp = nowIso();
  db.prepare(`
    UPDATE metadata_acquisition_tasks
    SET status = 'queued', error = COALESCE(error, 'Recovered after service restart'), updated_at = ?
    WHERE status = 'running'
  `).run(timestamp);
  db.prepare(`
    UPDATE metadata_acquisition_runs SET status = 'running', finished_at = NULL, updated_at = ?
    WHERE status IN ('queued', 'running')
  `).run(timestamp);
  workerTimer = setInterval(() => void runWorkerPass(), workerIntervalMs);
  workerTimer.unref();
  kickAcquisitionWorker();
}

export function stopMetadataAcquisitionWorker(): void {
  workerStopping = true;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

export function actOnAcquisitionRun(runId: string, action: "pause" | "resume" | "cancel" | "retry-failed") {
  const current = db.prepare("SELECT status FROM metadata_acquisition_runs WHERE run_id = ?").get(runId) as { status: string } | undefined;
  if (!current) throw Object.assign(new Error("Acquisition run not found"), { statusCode: 404 });
  const timestamp = nowIso();
  if (action === "pause") {
    db.prepare("UPDATE metadata_acquisition_runs SET status = 'paused', updated_at = ? WHERE run_id = ?")
      .run(timestamp, runId);
  } else if (action === "resume") {
    db.prepare("UPDATE metadata_acquisition_runs SET status = 'running', finished_at = NULL, updated_at = ? WHERE run_id = ?")
      .run(timestamp, runId);
  } else if (action === "cancel") {
    db.transaction(() => {
      db.prepare("UPDATE metadata_acquisition_runs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE run_id = ?")
        .run(timestamp, timestamp, runId);
      db.prepare(`
        UPDATE metadata_acquisition_tasks
        SET status = 'cancelled', finished_at = ?, updated_at = ?
        WHERE run_id = ? AND status != 'running' AND status NOT IN ('succeeded', 'not_found', 'failed', 'cancelled')
      `).run(timestamp, timestamp, runId);
    })();
  } else {
    db.transaction(() => {
      db.prepare(`
        UPDATE metadata_acquisition_tasks
        SET status = 'queued', attempts = 0, error = NULL, finished_at = NULL, updated_at = ?
        WHERE run_id = ? AND status IN ('failed', 'not_found')
      `).run(timestamp, runId);
      db.prepare("UPDATE metadata_acquisition_runs SET status = 'running', error = NULL, finished_at = NULL, updated_at = ? WHERE run_id = ?")
        .run(timestamp, runId);
    })();
  }
  updateRunCounts(runId);
  kickAcquisitionWorker();
  return readAcquisitionRun(runId);
}

async function probeHttp(url: string, timeoutMs = 3_000, token = ""): Promise<{ online: boolean; status: number | null; latencyMs: number; error: string | null }> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs)
    });
    return {
      online: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      online: false,
      status: null,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function getAcquisitionSources() {
  const storage = inspectContentPreviewStorage();
  const metatubeHealth = config.metadata.serverUrl
    ? await probeHttp(`${config.metadata.serverUrl}/v1/providers`, 3_000, config.metadata.token)
    : {online:false,status:null,latencyMs:0,error:"Not configured"};
  return [
    {
      source: "metatube",
      kind: "remote-metadata",
      enabled: Boolean(config.metadata.serverUrl),
      configured: Boolean(config.metadata.serverUrl),
      health: metatubeHealth,
      endpoint: config.metadata.serverUrl || null,
      capabilities: ["work-facts", "cover", "trailer"],
      galleryPolicy: "ignored"
    },
    {
      source: "local-content-preview",
      kind: "local-derived",
      enabled: config.contentPreview.enabled,
      configured: config.contentPreview.enabled,
      health: { online: storage.ready, status: null, latencyMs: 0, error: storage.ready ? null : storage.message },
      storage: { ready: storage.ready, state: storage.state, message: storage.message },
      capabilities: ["local-gallery"],
      galleryPolicy: "exclusive"
    }
  ];
}
