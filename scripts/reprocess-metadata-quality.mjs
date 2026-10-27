import path from "node:path";
import Database from "better-sqlite3";

const databasePath = path.resolve(process.env.METADATA_DB_PATH ?? ".local/data/media-wall.sqlite");
const apiBaseUrl = (process.env.METADATA_REPROCESS_API_URL ?? "http://127.0.0.1:4310/api").replace(/\/+$/, "");
const dryRun = process.env.METADATA_REPROCESS_DRY_RUN === "true";
const batchSize = Math.max(1, Math.min(80, Number.parseInt(process.env.METADATA_REPROCESS_BATCH_SIZE ?? "20", 10) || 20));
const pollMs = Math.max(1_000, Number.parseInt(process.env.METADATA_REPROCESS_POLL_MS ?? "5000", 10) || 5_000);
const maxRequestAttempts = Math.max(1, Number.parseInt(process.env.METADATA_REPROCESS_REQUEST_ATTEMPTS ?? "3", 10) || 3);
const statusFilters = (process.env.METADATA_REPROCESS_STATUSES ?? "failed")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const qualityFilters = (process.env.METADATA_REPROCESS_ISSUES ?? "missing_cover,low_completeness")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function readCandidates() {
  const db = new Database(databasePath, { readonly: true });
  try {
    const conditions = [];
    const params = [];
    if (statusFilters.length > 0) {
      conditions.push(`metadata.status IN (${placeholders(statusFilters)})`);
      params.push(...statusFilters);
    }
    if (qualityFilters.length > 0) {
      conditions.push(`EXISTS (
        SELECT 1 FROM metadata_quality_issues quality
        WHERE quality.normalized_code = metadata.normalized_code
          AND quality.issue_type IN (${placeholders(qualityFilters)})
      )`);
      params.push(...qualityFilters);
    }
    if (conditions.length === 0) return [];
    return db.prepare(`
      SELECT DISTINCT metadata.normalized_code AS normalizedCode,
        metadata.status,
        metadata.attempts
      FROM media_metadata metadata
      WHERE (${conditions.join(" OR ")})
        AND EXISTS (
          SELECT 1 FROM media_files files
          WHERE files.normalized_code = metadata.normalized_code
        )
      ORDER BY metadata.status, metadata.normalized_code
    `).all(...params);
  } finally {
    db.close();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(pathname, init) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function waitUntilIdle() {
  for (;;) {
    const status = await requestJson("/metadata/status");
    if (!status.running) return;
    await wait(pollMs);
  }
}

const candidates = readCandidates();
console.log(JSON.stringify({
  dryRun,
  database: path.relative(process.cwd(), databasePath),
  statuses: statusFilters,
  qualityIssues: qualityFilters,
  candidates: candidates.length,
  sample: candidates.slice(0, 20)
}, null, 2));

if (!dryRun) {
  const totals = { requested: 0, processed: 0, ready: 0, notFound: 0, failed: 0, skipped: 0 };
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    let response;
    for (let attempt = 1; attempt <= maxRequestAttempts; attempt += 1) {
      try {
        await waitUntilIdle();
        response = await requestJson("/metadata/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            codes: batch.map((row) => row.normalizedCode),
            force: true,
            limit: batch.length,
            async: false
          })
        });
        break;
      } catch (error) {
        if (attempt >= maxRequestAttempts) throw error;
        console.warn(`Metadata quality retry request interrupted (${attempt}/${maxRequestAttempts}); waiting for API recovery.`);
        await wait(pollMs);
      }
    }
    if (!response) throw new Error("Metadata quality retry did not return a response");
    for (const key of Object.keys(totals)) totals[key] += response.summary?.[key] ?? 0;
    console.log(`Metadata quality retry ${Math.min(offset + batch.length, candidates.length)}/${candidates.length}: ${JSON.stringify(response.summary)}`);
  }
  console.log(`Metadata quality retry finished: ${JSON.stringify(totals)}`);
}
