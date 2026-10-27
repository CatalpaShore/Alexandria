import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";

const cwd = process.cwd();
const databasePath = path.resolve(process.env.METADATA_DB_PATH ?? ".local/data/media-wall.sqlite");
const metadataSeedPath = path.resolve(process.env.METADATA_SEED_PATH ?? "seed/metadata-seed.json.gz");
const coverCacheDir = path.resolve(process.env.COVER_CACHE_DIR ?? ".local/data/covers");
const reportPath = path.resolve(process.env.COVER_PREFETCH_REPORT ?? ".local/data/reports/cover-prefetch-failures.json");
const mode = (process.env.COVER_PREFETCH_MODE ?? "cover-first").trim();
const onlyMissing = (process.env.COVER_PREFETCH_ONLY_MISSING ?? "false") === "true";
const concurrency = parsePositiveInteger(process.env.COVER_PREFETCH_CONCURRENCY, 6);
const timeoutMs = parsePositiveInteger(process.env.COVER_PREFETCH_TIMEOUT_MS, 15000);
const limit = Number.parseInt(process.env.COVER_PREFETCH_LIMIT ?? "", 10);
const maxBytes = parsePositiveInteger(process.env.COVER_PREFETCH_MAX_BYTES, 8 * 1024 * 1024);
const userAgent =
  process.env.COVER_PREFETCH_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const coverExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const cacheIndex = new Map();

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function getCoverHash(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

function getMimeExtension(mimeType) {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();

  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/avif") return "avif";

  return "jpg";
}

function inferMimeTypeFromBytes(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (bytes.subarray(4, 12).toString("ascii") === "ftypavif") return "image/avif";

  return null;
}

function loadCacheIndex() {
  cacheIndex.clear();
  if (!fs.existsSync(coverCacheDir)) return;

  for (const entry of fs.readdirSync(coverCacheDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!coverExtensions.has(path.extname(entry.name).toLowerCase())) continue;

    const hash = entry.name.split(".")[0];
    cacheIndex.set(hash, path.join(coverCacheDir, entry.name));
  }
}

function hasCachedCover(url) {
  return cacheIndex.has(getCoverHash(url));
}

function readRowsFromDatabase() {
  if (!fs.existsSync(databasePath)) return null;

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `
        SELECT normalized_code AS normalizedCode, cover_url AS coverUrl, thumb_url AS thumbUrl
        FROM media_metadata
        WHERE status = 'ready'
          AND (cover_url != '' OR thumb_url != '')
        ORDER BY normalized_code
      `
      )
      .all();
  } finally {
    db.close();
  }
}

function readRowsFromSeed() {
  if (!fs.existsSync(metadataSeedPath)) return [];

  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(metadataSeedPath)).toString("utf8"));
  return (Array.isArray(payload.rows) ? payload.rows : [])
    .filter((row) => row.status === "ready" && (row.cover_url || row.thumb_url))
    .map((row) => ({
      normalizedCode: row.normalized_code,
      coverUrl: row.cover_url,
      thumbUrl: row.thumb_url
    }));
}

function getCandidatesForRow(row) {
  const coverUrl = normalizeUrl(row.coverUrl);
  const thumbUrl = normalizeUrl(row.thumbUrl);
  const ordered =
    mode === "thumb-first"
      ? [
          { kind: "thumb", url: thumbUrl },
          { kind: "cover", url: coverUrl }
        ]
      : [
          { kind: "cover", url: coverUrl },
          { kind: "thumb", url: thumbUrl }
        ];

  return ordered
    .filter((candidate) => candidate.url)
    .filter((candidate, index, list) => list.findIndex((item) => item.url === candidate.url) === index);
}

function getRequestHeaders(url) {
  const parsedUrl = new URL(url);

  return {
    "User-Agent": userAgent,
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: `${parsedUrl.protocol}//${parsedUrl.hostname}/`
  };
}

async function downloadCover(candidate) {
  const hash = getCoverHash(candidate.url);
  if (cacheIndex.has(hash)) {
    return { status: "cached", candidate };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(candidate.url, {
      headers: getRequestHeaders(candidate.url),
      signal: controller.signal
    });

    if (!response.ok) {
      return { status: "failed", candidate, reason: `http_${response.status}` };
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { status: "failed", candidate, reason: "content_too_large" };
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      return { status: "failed", candidate, reason: "empty_body" };
    }
    if (bytes.length > maxBytes) {
      return { status: "failed", candidate, reason: "body_too_large" };
    }

    const responseMimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const mimeType = responseMimeType.startsWith("image/")
      ? responseMimeType
      : inferMimeTypeFromBytes(bytes);
    if (!mimeType) {
      return { status: "failed", candidate, reason: `invalid_content_type:${responseMimeType || "empty"}` };
    }

    fs.mkdirSync(coverCacheDir, { recursive: true });

    const filePath = path.join(coverCacheDir, `${hash}.${getMimeExtension(mimeType)}`);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, bytes);
    fs.renameSync(tempPath, filePath);
    cacheIndex.set(hash, filePath);

    return { status: "downloaded", candidate, bytes: bytes.length };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error";
    return { status: "failed", candidate, reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function prefetchRow(row) {
  const candidates = getCandidatesForRow(row);
  const attempts = [];
  let rowDownloaded = 0;
  let rowBytes = 0;

  if (candidates.length === 0) {
    return {
      status: "failed",
      row,
      attempts,
      downloaded: rowDownloaded,
      bytes: rowBytes,
      reason: "no_url"
    };
  }

  if (onlyMissing && candidates.some((candidate) => hasCachedCover(candidate.url))) {
    return {
      status: "cached",
      row,
      attempts,
      downloaded: rowDownloaded,
      bytes: rowBytes
    };
  }

  for (const candidate of candidates) {
    const result = await downloadCover(candidate);
    attempts.push({
      kind: candidate.kind,
      url: candidate.url,
      status: result.status,
      reason: result.reason
    });

    if (result.status === "downloaded") {
      rowDownloaded += 1;
      rowBytes += result.bytes ?? 0;
    }

    if (mode !== "all" && (result.status === "cached" || result.status === "downloaded")) {
      return {
        status: result.status,
        row,
        attempts,
        downloaded: rowDownloaded,
        bytes: rowBytes
      };
    }
  }

  const hasSuccess = attempts.some((attempt) => attempt.status === "cached" || attempt.status === "downloaded");
  return {
    status: hasSuccess ? "downloaded" : "failed",
    row,
    attempts,
    downloaded: rowDownloaded,
    bytes: rowBytes,
    reason: hasSuccess ? undefined : attempts.at(-1)?.reason ?? "failed"
  };
}

async function runPool(rows) {
  let index = 0;
  let cached = 0;
  let downloaded = 0;
  let failed = 0;
  let downloadedFiles = 0;
  let bytes = 0;
  const failures = [];

  async function worker() {
    while (index < rows.length) {
      const current = rows[index];
      index += 1;

      const result = await prefetchRow(current);
      if (result.status === "cached") cached += 1;
      if (result.status === "downloaded") downloaded += 1;
      if (result.status === "failed") {
        failed += 1;
        failures.push({
          normalizedCode: result.row.normalizedCode,
          coverUrl: normalizeUrl(result.row.coverUrl),
          thumbUrl: normalizeUrl(result.row.thumbUrl),
          reason: result.reason,
          attempts: result.attempts
        });
      }

      downloadedFiles += result.downloaded;
      bytes += result.bytes;

      const finished = cached + downloaded + failed;
      if (finished % 100 === 0 || finished === rows.length) {
        console.log(
          `Cover prefetch: ${finished}/${rows.length} rows, ${downloaded} rows downloaded, ${cached} cached, ${failed} failed, ${downloadedFiles} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
  return { cached, downloaded, failed, downloadedFiles, bytes, failures };
}

function writeReport(result, rows) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode,
        onlyMissing,
        totalRows: rows.length,
        cachedRows: result.cached,
        downloadedRows: result.downloaded,
        failedRows: result.failed,
        downloadedFiles: result.downloadedFiles,
        downloadedBytes: result.bytes,
        failures: result.failures
      },
      null,
      2
    )}\n`
  );
}

loadCacheIndex();

const rows = (readRowsFromDatabase() ?? readRowsFromSeed())
  .filter((row) => getCandidatesForRow(row).length > 0)
  .slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);

if (rows.length === 0) {
  console.log("Cover prefetch skipped: no cover URLs found");
  process.exit(0);
}

fs.mkdirSync(coverCacheDir, { recursive: true });
console.log(
  `Cover prefetch starting: ${rows.length} rows, mode=${mode}, onlyMissing=${onlyMissing}, concurrency=${concurrency}, cache=${path.relative(cwd, coverCacheDir)}`
);
const result = await runPool(rows);
writeReport(result, rows);
console.log(
  `Cover prefetch finished: ${result.downloaded} rows downloaded, ${result.cached} cached, ${result.failed} failed, ${result.downloadedFiles} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`
);
console.log(`Cover prefetch report: ${path.relative(cwd, reportPath)}`);
