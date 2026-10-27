import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const cwd = process.cwd();
const databasePath = path.resolve(process.env.METADATA_DB_PATH ?? ".local/data/media-wall.sqlite");
const reportPath = path.resolve(process.env.COVER_PREFETCH_REPORT ?? ".local/data/reports/cover-prefetch-failures.json");
const outputPath = path.resolve(process.env.COVER_REPAIR_REPORT ?? ".local/data/reports/cover-repair-report.json");
const coverCacheDir = path.resolve(process.env.COVER_CACHE_DIR ?? ".local/data/covers");
const concurrency = parsePositiveInteger(process.env.COVER_REPAIR_CONCURRENCY, 4);
const timeoutMs = parsePositiveInteger(process.env.COVER_REPAIR_TIMEOUT_MS, 20000);
const maxBytes = parsePositiveInteger(process.env.COVER_REPAIR_MAX_BYTES, 12 * 1024 * 1024);
const enableJavdb = process.env.COVER_REPAIR_ENABLE_JAVDB === "true";
const userAgent =
  process.env.COVER_REPAIR_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const coverExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const cacheIndex = new Map();

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeUrl(value, baseUrl) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("javascript:")) return null;

  try {
    const url = new URL(trimmed.replace(/&amp;/g, "&"), baseUrl);
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
    cacheIndex.set(entry.name.split(".")[0], path.join(coverCacheDir, entry.name));
  }
}

function getHeaders(url, referer) {
  const parsedUrl = new URL(url);
  return {
    "User-Agent": userAgent,
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: referer || `${parsedUrl.protocol}//${parsedUrl.hostname}/`
  };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      },
      signal: controller.signal
    });
    if (!response.ok) return fetchTextWithCurl(url);
    return await response.text();
  } catch {
    return fetchTextWithCurl(url);
  } finally {
    clearTimeout(timeout);
  }
}

function fetchTextWithCurl(url) {
  try {
    return execFileSync(
      "curl",
      [
        "-L",
        "-sS",
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        "-A",
        userAgent,
        "-H",
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H",
        "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
        url
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024
      }
    );
  } catch {
    return null;
  }
}

function isLikelyImageUrl(url) {
  const lower = url.toLowerCase();
  return (
    /\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#].*)?$/.test(lower) ||
    lower.includes("/file/") ||
    lower.includes("/images/") ||
    lower.includes("contents-thumbnail")
  );
}

function isNoiseImageUrl(url) {
  const lower = url.toLowerCase();
  return (
    lower.includes("juicyads") ||
    lower.includes("adserver") ||
    lower.includes("adxadserv") ||
    lower.includes("live-storage.fc2.com/thumb") ||
    lower.includes("no-thumbnail") ||
    lower.includes("no_image") ||
    lower.includes("no-image") ||
    lower.includes("profile") ||
    lower.includes("avatar") ||
    lower.includes("banner") ||
    lower.endsWith("/ico.png")
  );
}

function getFc2Id(row) {
  const source = [row.normalizedCode, row.homepage, row.coverUrl, row.thumbUrl, row.reportedCoverUrl, row.reportedThumbUrl]
    .filter(Boolean)
    .join(" ");
  const match = source.match(/(?:fc2[-_\s]*(?:ppv)?[-_\s]*|id)(\d{5,})/i);
  return match?.[1] ?? null;
}

function isFc2Row(row) {
  return row.provider?.toLowerCase().includes("fc2") || Boolean(getFc2Id(row));
}

function getStorageFileDirectory(url) {
  if (!url) return null;

  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const match = pathname.match(/\/file\/([^/]+\/[^/]+)\//i);
    return match ? `/file/${match[1]}/`.toLowerCase() : null;
  } catch {
    return null;
  }
}

function getStorageFileDirectories(row) {
  return [row.coverUrl, row.thumbUrl, row.reportedCoverUrl, row.reportedThumbUrl]
    .map(getStorageFileDirectory)
    .filter(Boolean);
}

function compactToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getHomepageSlug(row) {
  if (!row.homepage) return "";

  try {
    const segments = new URL(row.homepage).pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? "";
  } catch {
    return "";
  }
}

function isRelevantImageUrl(url, row) {
  const lower = decodeURIComponent(url).toLowerCase();

  if (isFc2Row(row)) {
    const isFc2Storage = lower.includes("contents.fc2.com/file/");
    const isFc2Thumbnail = lower.includes("contents-thumbnail");
    const isJavdbCover = lower.includes("jdbstatic.com/covers/");
    if (!isFc2Storage && !isFc2Thumbnail && !isJavdbCover) return false;
    if (isJavdbCover) return true;

    const directories = getStorageFileDirectories(row);
    if (directories.length === 0) return true;

    return directories.some((directory) => lower.includes(directory));
  }

  if (row.homepage?.includes("jav321.com")) {
    const compactUrl = compactToken(url);
    const compactSlug = compactToken(getHomepageSlug(row));
    const compactCode = compactToken(row.normalizedCode);

    return Boolean(
      (compactSlug && compactUrl.includes(compactSlug)) ||
        (compactCode && compactUrl.includes(compactCode)) ||
        (row.reportedCoverUrl && url === row.reportedCoverUrl) ||
        (row.reportedThumbUrl && url === row.reportedThumbUrl)
    );
  }

  return true;
}

function extractImageUrls(html, baseUrl) {
  const urls = [];
  const pattern = /(?:src|data-src|href|poster|content)=["']([^"']+)["']/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const url = normalizeUrl(match[1], baseUrl);
    if (!url || !isLikelyImageUrl(url) || isNoiseImageUrl(url)) continue;
    urls.push(url);
  }

  return urls;
}

function getMgstageSampleBase(html) {
  const match = html.match(/https?:\/\/sample\.mgstage\.com\/sample\/([^"']+?)\/[^/"']+\.(?:mp4|m3u8)/i);
  return match?.[1] ?? null;
}

function getJav321MgstageCandidates(imageUrls, html) {
  const sampleBase = getMgstageSampleBase(html);
  const candidates = [];

  for (const imageUrl of imageUrls) {
    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch {
      continue;
    }
    if (!parsed.hostname.endsWith("jav321.com")) continue;

    const imagePathMatch = decodeURIComponent(parsed.pathname).match(/\/images\/+(.+)$/i);
    if (!imagePathMatch) continue;

    const imagePath = imagePathMatch[1].replace(/^\/+/, "");
    candidates.push(`https://image.mgstage.com/images/${imagePath}`);

    if (sampleBase) {
      candidates.push(`https://image.mgstage.com/images/${sampleBase}/${path.posix.basename(imagePath)}`);
    }
  }

  return candidates;
}

function isMatchingFc2Code(value, row) {
  const fc2Id = getFc2Id(row);
  if (!fc2Id) return false;

  const normalized = compactToken(value);
  return normalized.startsWith("fc2") && normalized.endsWith(fc2Id);
}

function extractJavdbFc2Candidates(html, baseUrl, row) {
  const candidates = [];
  const itemPattern = /<div class="item">([\s\S]*?)(?=<div class="item">|<nav id="footer"|$)/gi;
  let match;

  while ((match = itemPattern.exec(html)) !== null) {
    const block = match[1];
    const strongCodes = [...block.matchAll(/<strong>\s*([^<]+)\s*<\/strong>/gi)].map((codeMatch) => codeMatch[1]);
    if (!strongCodes.some((code) => isMatchingFc2Code(code, row))) continue;

    for (const imageUrl of extractImageUrls(block, baseUrl)) {
      if (imageUrl.toLowerCase().includes("jdbstatic.com/covers/")) {
        candidates.push(imageUrl);
      }
    }
  }

  return candidates;
}

function scoreCandidate(url, row) {
  const lower = url.toLowerCase();
  let score = 0;

  if (isFc2Row(row)) {
    const directories = getStorageFileDirectories(row);
    if (directories.some((directory) => lower.includes(directory))) score += 300;
    if (lower.includes("jdbstatic.com/covers/")) score += 520;
    if (lower.includes("contents.fc2.com/file/")) score += 90;
    if (lower.includes(".jpg") || lower.includes(".jpeg") || lower.includes(".png") || lower.includes(".webp")) {
      score += 40;
    }
    if (url === row.coverUrl || url === row.thumbUrl || url === row.reportedCoverUrl || url === row.reportedThumbUrl) {
      score -= 220;
    }
    if (lower.includes("contents-thumbnail")) score -= 20;
    return score;
  }

  if (url === row.coverUrl || url === row.reportedCoverUrl) score += 120;
  if (lower.includes("image.mgstage.com")) score += 110;
  if (lower.includes("screenshot/large")) score += 95;
  if (lower.includes("pb_e_") || lower.includes("_b.")) score += 80;
  if (lower.includes("contents.fc2.com/file/")) score += 50;
  if (lower.includes("pf_o1") || lower.includes("thumb")) score += 25;
  if (lower.includes("contents-thumbnail")) score -= 20;
  if (url === row.thumbUrl || url === row.reportedThumbUrl) score -= 10;
  return score;
}

function dedupeCandidates(urls, row) {
  const seen = new Set();
  return urls
    .filter(Boolean)
    .map((url) => normalizeUrl(url, row.homepage || undefined))
    .filter(Boolean)
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .filter((url) => isLikelyImageUrl(url) && !isNoiseImageUrl(url) && isRelevantImageUrl(url, row))
    .sort((left, right) => scoreCandidate(right, row) - scoreCandidate(left, row));
}

async function downloadImage(url, referer) {
  const hash = getCoverHash(url);
  if (cacheIndex.has(hash)) {
    return { ok: true, status: "cached", url, path: cacheIndex.get(hash), bytes: 0 };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: getHeaders(url, referer),
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, url, reason: `http_${response.status}` };

    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, url, reason: "content_too_large" };
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return { ok: false, url, reason: "empty_body" };
    if (bytes.length > maxBytes) return { ok: false, url, reason: "body_too_large" };

    const responseMimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const mimeType = responseMimeType.startsWith("image/")
      ? responseMimeType
      : inferMimeTypeFromBytes(bytes);
    if (!mimeType) {
      return { ok: false, url, reason: `invalid_content_type:${responseMimeType || "empty"}` };
    }

    fs.mkdirSync(coverCacheDir, { recursive: true });

    const filePath = path.join(coverCacheDir, `${hash}.${getMimeExtension(mimeType)}`);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, bytes);
    fs.renameSync(tempPath, filePath);
    cacheIndex.set(hash, filePath);

    return { ok: true, status: "downloaded", url, path: filePath, bytes: bytes.length };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error";
    return { ok: false, url, reason };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonArray(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getRawPreviewImages(row) {
  if (!row.rawJson) return [];

  try {
    const raw = JSON.parse(row.rawJson);
    return Array.isArray(raw.preview_images) ? raw.preview_images.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function buildHtmlUrls(row) {
  const urls = [];
  const fc2Id = getFc2Id(row);

  if (fc2Id) {
    urls.push(`https://javten.com/search?kw=${encodeURIComponent(fc2Id)}`);
    if (enableJavdb) {
      urls.push(`https://javdb.com/search?q=${encodeURIComponent(`FC2-PPV-${fc2Id}`)}&f=all`);
    }
  }

  if (row.homepage) urls.push(row.homepage);

  return [...new Set(urls.filter(Boolean))];
}

function isRelevantHtml(html, row) {
  if (!html) return false;

  const fc2Id = getFc2Id(row);
  if (fc2Id) return html.includes(`id${fc2Id}`) || html.includes(fc2Id);

  const homepageSlug = getHomepageSlug(row);
  return !homepageSlug || html.toLowerCase().includes(homepageSlug.toLowerCase());
}

async function buildCandidates(row) {
  const urls = [
    row.coverUrl,
    row.thumbUrl,
    row.reportedCoverUrl,
    row.reportedThumbUrl,
    ...parseJsonArray(row.previewImagesJson),
    ...getRawPreviewImages(row)
  ];

  for (const htmlUrl of buildHtmlUrls(row)) {
    const html = await fetchText(htmlUrl);
    if (!isRelevantHtml(html, row)) continue;

    if (htmlUrl.includes("javdb.com")) {
      urls.push(...extractJavdbFc2Candidates(html, htmlUrl, row));
      continue;
    }

    const pageImages = extractImageUrls(html, htmlUrl);
    urls.push(...pageImages);

    if (row.homepage?.includes("jav321.com") || htmlUrl.includes("jav321.com")) {
      urls.push(...getJav321MgstageCandidates(pageImages, html));
    }
  }

  return dedupeCandidates(urls, row);
}

async function repairRow(row) {
  const candidates = await buildCandidates(row);
  const attempts = [];

  for (const candidate of candidates.slice(0, 80)) {
    const result = await downloadImage(candidate, row.homepage);
    attempts.push({
      url: candidate,
      status: result.ok ? result.status : "failed",
      reason: result.reason,
      bytes: result.bytes
    });

    if (!result.ok) continue;

    return {
      ok: true,
      row,
      coverUrl: candidate,
      thumbUrl: candidate,
      status: result.status,
      bytes: result.bytes,
      attempts
    };
  }

  return {
    ok: false,
    row,
    attempts,
    reason: attempts.at(-1)?.reason ?? "no_candidate"
  };
}

function readFailedRows(db) {
  const reportedByCode = new Map();

  if (fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    for (const failure of report.failures ?? []) {
      if (!failure.normalizedCode) continue;
      reportedByCode.set(failure.normalizedCode, {
        reportedCoverUrl: failure.coverUrl,
        reportedThumbUrl: failure.thumbUrl,
        reportedReason: failure.reason
      });
    }
  }

  const rows = db
    .prepare(
      `
      SELECT
        normalized_code AS normalizedCode,
        provider,
        homepage,
        cover_url AS coverUrl,
        thumb_url AS thumbUrl,
        preview_images_json AS previewImagesJson,
        raw_json AS rawJson
      FROM media_metadata
      WHERE status = 'ready'
        AND (cover_url != '' OR thumb_url != '')
      ORDER BY normalized_code
    `
    )
    .all();

  return rows
    .map((row) => ({
      ...row,
      ...(reportedByCode.get(row.normalizedCode) ?? {})
    }))
    .filter((row) => {
      if (reportedByCode.has(row.normalizedCode)) return true;

      const coverHash = row.coverUrl ? getCoverHash(row.coverUrl) : null;
      const thumbHash = row.thumbUrl ? getCoverHash(row.thumbUrl) : null;
      return !(coverHash && cacheIndex.has(coverHash)) && !(thumbHash && cacheIndex.has(thumbHash));
    });
}

function writeReport(result) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(`${outputPath}`, `${JSON.stringify(result, null, 2)}\n`);
}

loadCacheIndex();
const db = new Database(databasePath);
const failedRows = readFailedRows(db);
const updateCoverUrls = db.prepare(`
  UPDATE media_metadata
  SET cover_url = @coverUrl,
      thumb_url = @thumbUrl,
      updated_at = @updatedAt
  WHERE normalized_code = @normalizedCode
`);

let index = 0;
let repaired = 0;
let downloaded = 0;
let cached = 0;
let failed = 0;
let bytes = 0;
const repairedRows = [];
const failedRowsReport = [];

console.log(
  `Cover repair starting: ${failedRows.length} rows, concurrency=${concurrency}, report=${path.relative(cwd, reportPath)}`
);

async function worker() {
  for (;;) {
    const row = failedRows[index];
    index += 1;
    if (!row) return;

    const result = await repairRow(row);
    if (result.ok) {
      updateCoverUrls.run({
        normalizedCode: row.normalizedCode,
        coverUrl: result.coverUrl,
        thumbUrl: result.thumbUrl,
        updatedAt: new Date().toISOString()
      });
      repaired += 1;
      if (result.status === "downloaded") downloaded += 1;
      if (result.status === "cached") cached += 1;
      bytes += result.bytes;
      repairedRows.push({
        normalizedCode: row.normalizedCode,
        coverUrl: result.coverUrl,
        status: result.status,
        bytes: result.bytes,
        attempts: result.attempts
      });
    } else {
      failed += 1;
      failedRowsReport.push({
        normalizedCode: row.normalizedCode,
        homepage: row.homepage,
        coverUrl: row.coverUrl,
        thumbUrl: row.thumbUrl,
        reason: result.reason,
        attempts: result.attempts
      });
    }

    const finished = repaired + failed;
    if (finished % 10 === 0 || finished === failedRows.length) {
      console.log(
        `Cover repair: ${finished}/${failedRows.length} rows, ${repaired} repaired, ${failed} failed, ${downloaded} downloaded, ${cached} cached, ${(bytes / 1024 / 1024).toFixed(1)} MiB`
      );
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, failedRows.length) }, () => worker()));
db.close();

const summary = {
  generatedAt: new Date().toISOString(),
  inputReport: path.relative(cwd, reportPath),
  totalRows: failedRows.length,
  repaired,
  failed,
  downloaded,
  cached,
  downloadedBytes: bytes,
  repairedRows,
  failedRows: failedRowsReport
};
writeReport(summary);

console.log(
  `Cover repair finished: ${repaired} repaired, ${failed} failed, ${downloaded} downloaded, ${cached} cached, ${(bytes / 1024 / 1024).toFixed(1)} MiB`
);
console.log(`Cover repair report: ${path.relative(cwd, outputPath)}`);
