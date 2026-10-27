import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

type MetadataEnrichmentSummary = {
  requested?: number;
  processed?: number;
  ready?: number;
  notFound?: number;
  failed?: number;
  skipped?: number;
};

type MetadataStatusResponse = {
  running: boolean;
  latestRun?: MetadataEnrichmentSummary | null;
};

type CandidateRow = {
  normalizedCode: string;
  category: string;
  status: string | null;
};

const categoryFilter = (process.env.METADATA_BACKFILL_CATEGORY ?? "ALL").trim().toUpperCase();
const apiBaseUrl = (process.env.METADATA_BACKFILL_API_URL ?? `http://127.0.0.1:${config.port}/api`).replace(/\/+$/, "");
const batchLimit = parsePositiveInteger(process.env.METADATA_BACKFILL_LIMIT, 25);
const modifiedSinceDays = parseNonNegativeInteger(process.env.METADATA_BACKFILL_MODIFIED_DAYS, 30);
const includeComplete = process.env.METADATA_BACKFILL_INCLUDE_COMPLETE === "true";
const dryRun = process.env.METADATA_BACKFILL_DRY_RUN === "true";
const registerIngestionHistory = process.env.METADATA_BACKFILL_REGISTER_INGESTION !== "false";
const retryCooldownHours = parseNonNegativeInteger(process.env.METADATA_BACKFILL_RETRY_COOLDOWN_HOURS, 168);
const runningPollMs = parsePositiveInteger(process.env.METADATA_BACKFILL_RUNNING_POLL_MS, 10000);
const requestTimeoutMs = parsePositiveInteger(process.env.METADATA_BACKFILL_REQUEST_TIMEOUT_MS, 180000);
const databasePath = path.resolve(process.env.METADATA_DB_PATH ?? config.databasePath);
const logPath = path.resolve(
  process.env.METADATA_BACKFILL_LOG ??
    path.join(config.dataDir, `metadata-${categoryFilter.toLowerCase()}-backfill.log`)
);

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line}\n`);
  console.log(line);
}

async function fetchJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`${apiBaseUrl}${pathname}`, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${pathname} ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function readCandidates(): CandidateRow[] {
  const db = new Database(databasePath, { readonly: true });
  const cutoffMs = modifiedSinceDays > 0 ? Date.now() - modifiedSinceDays * 24 * 60 * 60 * 1000 : 0;
  const retryBeforeMs = retryCooldownHours > 0 ? Date.now() - retryCooldownHours * 60 * 60 * 1000 : 0;

  try {
    return db.prepare(`
      WITH recent_codes AS (
        SELECT
          normalized_code,
          MAX(library_category) AS category,
          MAX(mtime_ms) AS latest_mtime_ms
        FROM media_files
        WHERE normalized_code != ''
          AND code_prefix != ''
          AND (@category = 'ALL' OR library_category = @category)
          AND (@cutoffMs = 0 OR mtime_ms >= @cutoffMs)
        GROUP BY normalized_code
      )
      SELECT
        recent_codes.normalized_code AS normalizedCode,
        recent_codes.category,
        media_metadata.status
      FROM recent_codes
      LEFT JOIN media_metadata
        ON media_metadata.normalized_code = recent_codes.normalized_code
      WHERE @includeComplete = 1
        OR media_metadata.normalized_code IS NULL
        OR (
          (@retryBeforeMs = 0 OR unixepoch(media_metadata.updated_at) * 1000 <= @retryBeforeMs)
          AND (
            media_metadata.status != 'ready'
            OR trim(COALESCE(media_metadata.summary, '')) = ''
            OR COALESCE(json_array_length(media_metadata.actors_json), 0) = 0
            OR COALESCE(json_array_length(media_metadata.genres_json), 0) < 3
            OR trim(COALESCE(media_metadata.maker, '')) = ''
            OR trim(COALESCE(media_metadata.cover_url, '')) = ''
            OR (
              trim(COALESCE(media_metadata.preview_video_url, '')) = ''
              AND trim(COALESCE(media_metadata.preview_video_hls_url, '')) = ''
            )
          )
        )
      ORDER BY recent_codes.category, recent_codes.latest_mtime_ms DESC, recent_codes.normalized_code
    `).all({
      category: categoryFilter,
      cutoffMs,
      retryBeforeMs,
      includeComplete: includeComplete ? 1 : 0
    }) as CandidateRow[];
  } finally {
    db.close();
  }
}

function recordIngestionHistory(rows: CandidateRow[], ingestedAt: string): number {
  if (!registerIngestionHistory || rows.length === 0) return 0;
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_history (
        normalized_code TEXT PRIMARY KEY,
        ingested_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'automatic',
        read_at TEXT
      )
    `);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO ingestion_history (normalized_code, ingested_at, source)
      VALUES (?, ?, 'metadata-backfill')
    `);
    return db.transaction((candidates: CandidateRow[]) => candidates.reduce(
      (count, row) => count + insert.run(row.normalizedCode, ingestedAt).changes,
      0
    ))(rows);
  } finally {
    db.close();
  }
}

async function waitUntilIdle(): Promise<void> {
  for (;;) {
    const status = await fetchJson<MetadataStatusResponse>("/metadata/status");
    if (!status.running) return;
    log("waiting for active metadata job");
    await wait(runningPollMs);
  }
}

async function processBatch(category: string, rows: CandidateRow[]): Promise<MetadataEnrichmentSummary> {
  await waitUntilIdle();
  await fetchJson<{ accepted: boolean }>("/metadata/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category,
      codes: rows.map((row) => row.normalizedCode),
      limit: rows.length,
      async: true
    })
  });

  for (;;) {
    await wait(runningPollMs);
    const status = await fetchJson<MetadataStatusResponse>("/metadata/status");
    if (!status.running) return status.latestRun ?? {};
    log(`waiting batch category=${category} size=${rows.length}`);
  }
}

async function run(): Promise<void> {
  const controllerStartedAt = new Date().toISOString();
  const candidates = readCandidates();
  const categoryCounts = candidates.reduce<Record<string, number>>((counts, row) => {
    counts[row.category] = (counts[row.category] ?? 0) + 1;
    return counts;
  }, {});
  log(
    `controller started category=${categoryFilter} modifiedSinceDays=${modifiedSinceDays} retryCooldownHours=${retryCooldownHours} includeComplete=${includeComplete} dryRun=${dryRun} candidates=${candidates.length} breakdown=${JSON.stringify(categoryCounts)} batchLimit=${batchLimit}`
  );

  if (dryRun) {
    log(`dry run candidates=${candidates.map((row) => `${row.category}:${row.normalizedCode}`).join(",")}`);
    return;
  }

  const totals = { requested: 0, processed: 0, ready: 0, notFound: 0, failed: 0, skipped: 0 };
  for (const category of Object.keys(categoryCounts).sort()) {
    const rows = candidates.filter((row) => row.category === category);
    for (let offset = 0; offset < rows.length; offset += batchLimit) {
      const batch = rows.slice(offset, offset + batchLimit);
      log(`request batch category=${category} offset=${offset} size=${batch.length}`);
      const summary = await processBatch(category, batch);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        totals[key] += summary[key] ?? 0;
      }
      log(`batch complete category=${category} offset=${offset} summary=${JSON.stringify(summary)}`);
    }
  }

  const registered = recordIngestionHistory(candidates, controllerStartedAt);
  log(`finished candidates=${candidates.length} registeredIngestion=${registered} totals=${JSON.stringify(totals)}`);
}

run().catch((error) => {
  log(`fatal ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
